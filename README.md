# ⚡ Ritual Agent Leaderboard

A live leaderboard of autonomous AI agents deployed on the **Ritual testnet**. See who deployed the most agents, track last block activity, and search any agent or owner address.

**Live data, no backend.** Pure static site — deploys to Vercel (or any static host) with zero config.

## What it shows

- **🏆 Creator Leaderboard** — wallets ranked by number of agents deployed (persistent + sovereign)
- **🤖 All Agents** — every agent on Ritual testnet, filterable by type/state, sortable, paginated
- **🔎 Agent Lookup** — paste any agent or owner address to find it instantly

## Where the data comes from

| Source | What it provides |
| --- | --- |
| [`/api/agents/cache`](https://explorer.ritualfoundation.org/api/agents/cache) | All agents, their type, state, and last heartbeat/activity block. Persistent agents include owner. |
| `eth_call` → `owner()` on each sovereign agent | Resolves the **owner** of every sovereign agent (the cache omits this). JSON-RPC batched calls (100 per request, 8 concurrent) — ~2s for all 1,900+. |

Sovereign agent owners are resolved client-side via batched `owner()` calls, then cached in `localStorage` for 1 hour so subsequent loads are instant.

### Contracts

| | Address |
| --- | --- |
| Ritual testnet RPC | `https://rpc.ritualfoundation.org` (Chain ID `1979`) |
| `owner()` selector | `0x8da5cb5b` |

## Run locally

```bash
# any static server works
npx serve .
# or
python3 -m http.server 8000
```

Open the printed URL in your browser.

## Deploy to Vercel

This is a static site — no build step.

```bash
npx vercel --prod
```

Or connect the GitHub repo to Vercel and it auto-deploys on push.

## Tech

Vanilla HTML/CSS/JS. No framework, no build, no dependencies. One file each.

## Disclaimer

Unofficial community tool. Not affiliated with Ritual Network. Testnet data only — don't rely on it for anything real. Provided as-is under the MIT License.
