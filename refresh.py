#!/usr/bin/env python3
"""
Ritual Agent Rank — data refresh + Vercel deploy.
Fetches cache API, binary-searches deploy blocks for all agents, writes deploy-data.json,
uploads all files to Vercel, creates a production deployment.
Run via Sauna run_script with the Vercel connection passed.
"""
import json, time, hashlib, os, sys, concurrent.futures
import requests

RPC = "https://rpc.ritualfoundation.org"
CACHE = "https://explorer.ritualfoundation.org/api/agents/cache"
VERCEL = "https://api.vercel.com"
PROJECT = "ritual-agent-leaderboard"
BATCH = 300
CONC = 20
MARGIN = 600000
HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = "Bearer PLACEHOLDER_TOKEN"

def rpc_batch(calls):
    body = json.dumps([{"jsonrpc": "2.0", "method": c[0], "params": c[1], "id": i} for i, c in enumerate(calls)])
    r = requests.post(RPC, data=body, headers={"Content-Type": "application/json", "User-Agent": "RitualRank/1.0"}, timeout=45)
    return r.json()

def rpc_single(method, params):
    r = requests.post(RPC, json={"jsonrpc": "2.0", "method": method, "params": params, "id": 1}, headers={"User-Agent": "RitualRank/1.0"}, timeout=30)
    if not r.text.strip():
        raise Exception(f"RPC empty response (status {r.status_code})")
    return r.json().get("result")

def run_batched(calls):
    batches = [calls[i:i+BATCH] for i in range(0, len(calls), BATCH)]
    results = [None] * len(calls)
    def fetch(bi):
        res = rpc_batch(batches[bi])
        by_id = {r["id"]: r for r in res}
        return bi, [by_id.get(i, {}).get("result", "0x") for i in range(len(batches[bi]))]
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONC) as ex:
        for bi, vals in ex.map(fetch, range(len(batches))):
            start = bi * BATCH
            for i, v in enumerate(vals): results[start + i] = v
    return results

def main():
    print("Fetching cache...", flush=True)
    data = requests.get(CACHE, timeout=30).json()
    agents = {}
    for e in data.get("sovereign", []):
        agents[e["address"].lower()] = {"type": "Sovereign", "lastBlock": e.get("lastActivityBlock", 0)}
    for e in data.get("persistent", []):
        info = e.get("info", {})
        addr = (info.get("agentAddress") or e["address"]).lower()
        agents[addr] = {"type": "Persistent", "lastBlock": info.get("lastHeartbeatBlock", 0)}
    addrs = list(agents.keys())
    latest = int(rpc_single("eth_blockNumber", []), 16)
    lo0 = max(0, latest - MARGIN)
    print(f"{len(addrs)} agents, latest block {latest:,}", flush=True)

    # Binary search deploy blocks
    lo = {a: lo0 for a in addrs}
    hi = {a: latest for a in addrs}
    it = 0
    while True:
        it += 1
        pending = [a for a in addrs if lo[a] < hi[a]]
        if not pending: break
        calls = []
        mids = {}
        for a in pending:
            mid = (lo[a] + hi[a]) // 2
            mids[a] = mid
            calls.append(("eth_getCode", [a, hex(mid)]))
        results = run_batched(calls)
        for i, a in enumerate(pending):
            code = results[i]
            if code and len(code) > 2: hi[a] = mids[a]
            else: lo[a] = mids[a] + 1
    print(f"Binary search done: {it} iterations", flush=True)

    # Timestamps
    unique = list(set(lo[a] for a in addrs))
    ts_calls = [("eth_getBlockByNumber", [hex(b), False]) for b in unique]
    ts_results = run_batched(ts_calls)
    block_ts = {}
    for i, blk in enumerate(ts_results):
        if blk and isinstance(blk, dict) and "timestamp" in blk:
            ts = int(blk["timestamp"], 16)
            if ts > 1e12: ts //= 1000
            block_ts[unique[i]] = ts

    # Build ranked list
    deploys = []
    for a in addrs:
        blk = lo[a]
        deploys.append({"address": a, "type": agents[a]["type"], "deployBlock": blk, "deployTs": block_ts.get(blk, 0), "lastBlock": agents[a]["lastBlock"]})
    deploys.sort(key=lambda x: x["deployBlock"])
    for i, d in enumerate(deploys): d["rank"] = i + 1

    out = {"computedAt": int(time.time()), "totalAgents": len(deploys), "latestBlock": latest, "agents": deploys}
    with open(os.path.join(HERE, "deploy-data.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"deploy-data.json written: {len(deploys)} agents", flush=True)

    # Upload to Vercel
    files_to_upload = ["index.html", "style.css", "app.js", "deploy-data.json"]
    manifest = []
    for fn in files_to_upload:
        path = os.path.join(HERE, fn)
        if not os.path.exists(path):
            print(f"SKIP {fn} (not found)", flush=True)
            continue
        content = open(path, "rb").read()
        sha = hashlib.sha1(content).hexdigest()
        r = requests.post(f"{VERCEL}/v2/files", data=content,
            headers={"Authorization": TOKEN, "Content-Type": "application/octet-stream", "x-vercel-digest": sha}, timeout=60)
        if r.status_code not in (200, 200):
            print(f"Upload {fn}: {r.status_code}", flush=True)
        manifest.append({"file": fn, "sha": sha, "size": len(content)})
        print(f"Uploaded {fn} ({len(content)} bytes)", flush=True)

    # Deploy
    r = requests.post(f"{VERCEL}/v13/deployments", json={
        "name": PROJECT, "files": manifest, "target": "production",
        "projectSettings": {"framework": None, "buildCommand": None, "outputDirectory": ".", "installCommand": None, "devCommand": None},
    }, headers={"Authorization": TOKEN}, timeout=60)
    dep = r.json()
    print(f"Deploy: {dep.get('readyState', 'ERR')} — {dep.get('alias', ['?'])[0]}", flush=True)
    return dep

if __name__ == "__main__":
    main()
