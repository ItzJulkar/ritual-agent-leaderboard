/* ============================================================
   Ritual Agent Search
   Search an agent → type, exact deploy time, rank.
   Data: Ritual Explorer cache API + on-chain eth_getCode binary search.
   ============================================================ */

const CONFIG = {
  CACHE_API: 'https://explorer.ritualfoundation.org/api/agents/cache',
  RPC_URL: 'https://rpc.ritualfoundation.org',
  EXPLORER: 'https://explorer.ritualfoundation.org',
  OWNER_SELECTOR: '0x8da5cb5b',
  BATCH: 100,
  CONCURRENCY: 12,
  RANK_CACHE_KEY: 'ritual_agent_rank_v3',
  RANK_CACHE_TTL: 3600_000, // 1 hour
  SEARCH_MARGIN: 500000, // search deploy block within latest - 500k
};

const state = {
  agents: {},        // address -> type (from cache)
  agentList: [],     // ordered list of addresses
  currentBlock: 0,
  rankData: null,    // { address -> { block, ts } } sorted, with rank
  rankLoading: false,
  blockTsCache: {},  // block -> timestamp
};

const $ = (id) => document.getElementById(id);

// -------------- RPC --------------
async function rpcBatch(calls) {
  const payload = calls.map((c, i) => ({ jsonrpc: '2.0', method: c[0], params: c[1], id: i }));
  const res = await fetch(CONFIG.RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

async function rpcSingle(method, params) {
  const res = await fetch(CONFIG.RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = await res.json();
  return json.result;
}

// Run a batch of calls with limited concurrency
async function runBatched(calls) {
  const batches = [];
  for (let i = 0; i < calls.length; i += CONFIG.BATCH) {
    batches.push(calls.slice(i, i + CONFIG.BATCH));
  }
  const results = new Array(calls.length);
  let idx = 0;
  for (const b of batches) idx += b.length; // pre-count
  idx = 0;

  let nextBatch = 0;
  async function worker() {
    while (true) {
      const myIdx = nextBatch++;
      if (myIdx >= batches.length) return;
      const b = batches[myIdx];
      const startIdx = myIdx * CONFIG.BATCH;
      try {
        const res = await rpcBatch(b);
        const byId = {};
        for (const r of res) byId[r.id] = r;
        for (let i = 0; i < b.length; i++) {
          results[startIdx + i] = byId[i] ? byId[i].result : '0x';
        }
      } catch (e) {
        for (let i = 0; i < b.length; i++) results[startIdx + i] = '0x';
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONFIG.CONCURRENCY, batches.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// -------------- Cache loading --------------
async function loadCache() {
  const res = await fetch(CONFIG.CACHE_API);
  const data = await res.json();
  const agents = {};
  for (const e of data.sovereign || []) agents[e.address.toLowerCase()] = 'Sovereign';
  for (const e of data.persistent || []) agents[e.address.toLowerCase()] = 'Persistent';
  return agents;
}

// -------------- Block timestamp --------------
async function getBlockTimestamp(block) {
  if (state.blockTsCache[block]) return state.blockTsCache[block];
  const blk = await rpcSingle('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
  if (blk && blk.timestamp) {
    let ts = parseInt(blk.timestamp, 16);
    if (ts > 1e12) ts = Math.floor(ts / 1000); // ms -> s
    state.blockTsCache[block] = ts;
    return ts;
  }
  return 0;
}

// -------------- Binary search one agent's deploy block --------------
async function findDeployBlock(address, lo, hi) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let code;
    try {
      code = await rpcSingle('eth_getCode', [address, '0x' + mid.toString(16)]);
    } catch { code = '0x'; }
    if (code && code.length > 2) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// -------------- Determine agent type --------------
async function determineType(address) {
  // Check cache first
  if (state.agents[address]) return state.agents[address];
  // Not in cache — check if contract exists + owner() to distinguish
  const code = await rpcSingle('eth_getCode', [address, 'latest']);
  if (!code || code.length <= 2) return null; // not a contract
  const ownerRes = await rpcSingle('eth_call', [{ to: address, data: CONFIG.OWNER_SELECTOR }, 'latest']);
  if (ownerRes && ownerRes.length >= 66 && parseInt(ownerRes, 16) > 0) return 'Sovereign';
  return 'Persistent';
}

// -------------- Background rank scan --------------
async function buildRankIndex(onProgress) {
  const addrs = Object.keys(state.agents);
  const lo0 = Math.max(0, state.currentBlock - CONFIG.SEARCH_MARGIN);
  const lo = {};
  const hi = {};
  for (const a of addrs) { lo[a] = lo0; hi[a] = state.currentBlock; }

  let iteration = 0;
  const maxIter = 30;
  while (iteration < maxIter) {
    iteration++;
    const pending = addrs.filter(a => lo[a] < hi[a]);
    if (pending.length === 0) break;

    const calls = pending.map(a => {
      const mid = Math.floor((lo[a] + hi[a]) / 2);
      return ['eth_getCode', [a, '0x' + mid.toString(16)], mid, a];
    });

    // Batch the eth_getCode calls, keep track of mid + address
    const rpcCalls = calls.map(c => [c[0], c[1]]);
    const results = await runBatched(rpcCalls);

    for (let i = 0; i < calls.length; i++) {
      const mid = calls[i][2];
      const a = calls[i][3];
      const code = results[i];
      if (code && code.length > 2) hi[a] = mid;
      else lo[a] = mid + 1;
    }

    if (onProgress) onProgress(iteration, Math.ceil(Math.log2(state.currentBlock - lo0 + 1)));
  }

  // Collect unique blocks + fetch timestamps
  const uniqueBlocks = [...new Set(addrs.map(a => lo[a]))];
  const tsCalls = uniqueBlocks.map(b => ['eth_getBlockByNumber', ['0x' + b.toString(16), false]]);
  const tsResults = await runBatched(tsCalls);
  const blockTs = {};
  for (let i = 0; i < uniqueBlocks.length; i++) {
    const blk = tsResults[i];
    if (blk && typeof blk === 'object' && blk.timestamp) {
      let ts = parseInt(blk.timestamp, 16);
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      blockTs[uniqueBlocks[i]] = ts;
    }
  }

  // Build sorted rank array
  const ranked = addrs.map(a => ({ address: a, block: lo[a], ts: blockTs[lo[a]] || 0 }))
    .sort((x, y) => x.block - y.block);

  const rankMap = {};
  for (let i = 0; i < ranked.length; i++) {
    rankMap[ranked[i].address] = { rank: i + 1, block: ranked[i].block, ts: ranked[i].ts, total: ranked.length };
  }
  return rankMap;
}

function loadCachedRank() {
  try {
    const raw = localStorage.getItem(CONFIG.RANK_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CONFIG.RANK_CACHE_TTL) return null;
    return obj.data;
  } catch { return null; }
}

function saveCachedRank(data) {
  try {
    localStorage.setItem(CONFIG.RANK_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* quota */ }
}

// -------------- Rendering --------------
function fmtTime(ts) {
  if (!ts) return 'Unknown';
  const d = new Date(ts * 1000);
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
}

function shortAddr(a) { return a.slice(0, 10) + '…' + a.slice(-6); }

function showLoading(msg) {
  $('result').innerHTML = `<div class="result-empty"><span class="spinner"></span>${msg}</div>`;
}

function showError(msg) {
  $('result').innerHTML = `<div class="result-error">${msg}</div>`;
}

function renderResult({ address, type, deployBlock, deployTime, rank, total, inCache }) {
  const typeBadge = inCache
    ? `<span class="badge badge-${type.toLowerCase()}">${type}</span>`
    : `<span class="badge badge-inactive">${type} (inactive)</span>`;

  const rankHtml = rank
    ? `<div class="result-value-big">#${rank.toLocaleString()}</div>
       <span class="rank-badge">of ${total.toLocaleString()} agents</span>`
    : `<span class="rank-badge"><span class="spinner"></span>Building rank index…</span>`;

  $('result').innerHTML = `
    <div class="result-card">
      <div class="result-row">
        <span class="result-label">Agent</span>
        <span class="result-value"><a href="${CONFIG.EXPLORER}/agents/${address}?type=auto" target="_blank" rel="noopener">${shortAddr(address)}</a></span>
      </div>
      <div class="result-row">
        <span class="result-label">Type</span>
        <span class="result-value">${typeBadge}</span>
      </div>
      <div class="result-row">
        <span class="result-label">Deployed</span>
        <span class="result-value">${fmtTime(deployTime)}<br><span style="color:var(--mute);font-size:12px">block #${deployBlock.toLocaleString()}</span></span>
      </div>
      <div class="result-row">
        <span class="result-label">Rank</span>
        <span class="result-value">${rankHtml}</span>
      </div>
    </div>`;
}

// -------------- Search --------------
async function search(rawInput) {
  const address = (rawInput || '').toLowerCase().trim();
  if (!address.match(/^0x[a-f0-9]{40}$/)) {
    showError('Enter a valid agent address (0x followed by 40 hex characters).');
    return;
  }

  $('searchBtn').disabled = true;
  showLoading('Looking up agent…');

  try {
    // 1. Determine type (cache or on-chain)
    const type = await determineType(address);
    if (!type) {
      showError('No agent contract found at this address. Is it a valid Ritual agent?');
      return;
    }
    const inCache = !!state.agents[address];

    // 2. Find deploy block (on-demand binary search)
    showLoading('Finding deployment block…');
    const lo0 = Math.max(0, state.currentBlock - CONFIG.SEARCH_MARGIN);
    const deployBlock = await findDeployBlock(address, lo0, state.currentBlock);
    const deployTime = await getBlockTimestamp(deployBlock);

    // 3. Rank: from rank index if ready, else show "building"
    let rank = null, total = null;
    if (state.rankData && state.rankData[address]) {
      rank = state.rankData[address].rank;
      total = state.rankData[address].total;
    } else if (state.rankData) {
      // Agent not in rank data (not in cache) — compute rank by counting
      const allBlocks = Object.values(state.rankData).map(d => d.block).sort((a, b) => a - b);
      total = allBlocks.length;
      rank = allBlocks.filter(b => b < deployBlock).length + 1;
    }

    renderResult({ address, type, deployBlock, deployTime, rank, total, inCache });

    // If rank index not built yet, build it then update
    if (!state.rankData && !state.rankLoading) {
      buildRankInBackground().then(() => {
        // Re-render with rank
        if (state.rankData) {
          const allBlocks = Object.values(state.rankData).map(d => d.block).sort((a, b) => a - b);
          const total = allBlocks.length;
          const rank = allBlocks.filter(b => b < deployBlock).length + 1;
          renderResult({ address, type, deployBlock, deployTime, rank, total, inCache });
        }
      });
    }
  } catch (e) {
    showError('Search failed: ' + e.message);
  } finally {
    $('searchBtn').disabled = false;
  }
}

// -------------- Background rank builder --------------
async function buildRankInBackground() {
  state.rankLoading = true;
  $('statusBar').hidden = false;
  $('statusText').textContent = 'Building rank index…';
  try {
    const data = await buildRankIndex((iter, est) => {
      const pct = Math.min(100, Math.round((iter / est) * 100));
      $('statusFill').style.width = pct + '%';
      $('statusText').textContent = `Building rank index… ${pct}%`;
    });
    state.rankData = data;
    saveCachedRank(data);
    $('statusText').textContent = `Rank index ready — ${Object.keys(data).length.toLocaleString()} agents ranked.`;
    setTimeout(() => { $('statusBar').hidden = true; }, 3000);
  } catch (e) {
    $('statusText').textContent = 'Rank index failed: ' + e.message;
  } finally {
    state.rankLoading = false;
  }
}

// -------------- Init --------------
async function init() {
  $('searchBtn').addEventListener('click', () => search($('searchInput').value));
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') search($('searchInput').value); });

  try {
    state.currentBlock = parseInt(await rpcSingle('eth_blockNumber', []), 16);
    state.agents = await loadCache();
    state.agentList = Object.keys(state.agents);
    $('searchHint').textContent = `${state.agentList.length.toLocaleString()} agents indexed. Search any address to see type, deploy time, and rank.`;
  } catch (e) {
    $('searchHint').textContent = 'Could not load agent cache. Search may still work for on-chain agents.';
  }

  // Load cached rank or build in background
  const cached = loadCachedRank();
  if (cached) {
    state.rankData = cached;
    $('rankStatus').hidden = false;
    $('rankStatus').textContent = `Rank index cached (${Object.keys(cached).length.toLocaleString()} agents).`;
  } else {
    buildRankInBackground();
  }
}

init().catch(e => console.error(e));
