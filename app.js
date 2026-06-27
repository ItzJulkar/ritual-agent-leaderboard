/* ============================================================
   Ritual Agent Lookup
   Data: pre-computed deploy-data.json + Ritual Explorer cache API
   For agents not in pre-computed data: on-chain binary search.
   ============================================================ */

const CONFIG = {
  DEPLOY_DATA: 'deploy-data.json',
  CACHE_API: 'https://explorer.ritualfoundation.org/api/agents/cache',
  RPC_URL: 'https://rpc.ritualfoundation.org',
  EXPLORER: 'https://explorer.ritualfoundation.org',
  OWNER_SELECTOR: '0x8da5cb5b',
  SEARCH_MARGIN: 600000,
};

const state = {
  deployData: null,    // { agents: [...], totalAgents, latestBlock, computedAt }
  byAddress: {},       // address -> agent object (from deploy-data)
  cacheTypes: {},      // address -> type (from cache, for new agents)
  currentBlock: 0,
};

const $ = (id) => document.getElementById(id);

// -------------- RPC --------------
async function rpcSingle(method, params) {
  const res = await fetch(CONFIG.RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = await res.json();
  return json.result;
}

// -------------- Load data --------------
async function loadData() {
  // Load pre-computed deploy data + cache in parallel
  const [depRes, cacheRes] = await Promise.all([
    fetch(CONFIG.DEPLOY_DATA),
    fetch(CONFIG.CACHE_API).catch(() => null),
  ]);

  state.deployData = await depRes.json();
  for (const a of state.deployData.agents) {
    state.byAddress[a.address.toLowerCase()] = a;
  }

  // Load cache for current types (catches new agents)
  if (cacheRes && cacheRes.ok) {
    const cache = await cacheRes.json();
    for (const e of cache.sovereign || []) state.cacheTypes[e.address.toLowerCase()] = 'Sovereign';
    for (const e of cache.persistent || []) {
      const info = e.info || {};
      const addr = (info.agentAddress || e.address).toLowerCase();
      state.cacheTypes[addr] = 'Persistent';
    }
  }

  // Get current block
  try {
    state.currentBlock = parseInt(await rpcSingle('eth_blockNumber', []), 16);
  } catch {
    state.currentBlock = state.deployData.latestBlock || 0;
  }

  // Render stats
  const Sov = Object.values(state.byAddress).filter(a => a.type === 'Sovereign').length;
  const Pers = Object.values(state.byAddress).filter(a => a.type === 'Persistent').length;
  $('statTotal').textContent = state.deployData.totalAgents.toLocaleString();
  $('statSov').textContent = Sov.toLocaleString();
  $('statPers').textContent = Pers.toLocaleString();
  const ago = Math.round((Date.now() / 1000 - state.deployData.computedAt) / 60);
  $('statUpdated').textContent = ago < 60 ? ago + 'm ago' : Math.round(ago / 60) + 'h ago';
  $('statsStrip').hidden = false;

  $('searchStatus').textContent = `${state.deployData.totalAgents.toLocaleString()} agents indexed — ready to search.`;
}

// -------------- On-demand deploy block (for agents not in pre-computed data) --------------
async function findDeployBlockOnChain(address, onProgress) {
  const lo0 = Math.max(0, state.currentBlock - CONFIG.SEARCH_MARGIN);
  let lo = lo0, hi = state.currentBlock;
  let steps = 0;
  const estSteps = Math.ceil(Math.log2(state.currentBlock - lo0 + 1));

  while (lo < hi) {
    steps++;
    const mid = Math.floor((lo + hi) / 2);
    let code;
    try {
      code = await rpcSingle('eth_getCode', [address, '0x' + mid.toString(16)]);
    } catch {
      code = '0x';
    }
    if (code && code.length > 2) hi = mid;
    else lo = mid + 1;
    if (onProgress) onProgress(Math.round((steps / estSteps) * 100));
  }
  return lo;
}

async function getBlockTimestamp(block) {
  const blk = await rpcSingle('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
  if (blk && blk.timestamp) {
    let ts = parseInt(blk.timestamp, 16);
    if (ts > 1e12) ts = Math.floor(ts / 1000);
    return ts;
  }
  return 0;
}

async function determineTypeOnChain(address) {
  const code = await rpcSingle('eth_getCode', [address, 'latest']);
  if (!code || code.length <= 2) return null;
  const ownerRes = await rpcSingle('eth_call', [{ to: address, data: CONFIG.OWNER_SELECTOR }, 'latest']);
  if (ownerRes && ownerRes.length >= 66 && parseInt(ownerRes, 16) > 0) return 'Sovereign';
  return 'Persistent';
}

// -------------- Format --------------
function fmtTime(ts) {
  if (!ts) return 'Unknown';
  const d = new Date(ts * 1000);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

function fmtAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() / 1000 - ts;
  if (diff < 3600) return Math.round(diff / 60) + ' min ago';
  if (diff < 86400) return Math.round(diff / 3600) + ' hr ago';
  return Math.round(diff / 86400) + ' days ago';
}

function short(a) { return a.slice(0, 8) + '…' + a.slice(-6); }

// -------------- Render --------------
function showLoading(msg) {
  $('result').innerHTML = `<div class="result-empty"><span class="spinner"></span>${msg}</div>`;
}
function showError(msg) {
  $('result').innerHTML = `<div class="result-error">${msg}</div>`;
}

function renderResult({ address, type, deployBlock, deployTs, rank, total, inIndex }) {
  const typeClass = inIndex ? `type-${type.toLowerCase()}` : 'type-inactive';
  const typeLabel = inIndex ? type : type + ' (inactive)';
  const rankNum = rank ? rank.toLocaleString() : '—';
  const totalNum = total ? total.toLocaleString() : '—';

  $('result').innerHTML = `
    <div class="result-card">
      <div class="result-head">
        <div class="result-rank">
          <div class="rank-circle">
            <div class="rank-num">#${rankNum}</div>
            <div class="rank-lbl">Rank</div>
          </div>
          <div class="rank-text">
            <div class="rank-text-big">Deployment Rank</div>
            <div class="rank-text-sub">${rankNum} of ${totalNum} agents</div>
          </div>
        </div>
        <span class="type-pill ${typeClass}">${typeLabel}</span>
      </div>
      <div class="result-body">
        <div class="deploy-highlight">
          <div class="deploy-left">
            <span class="deploy-label">Deployed At</span>
            <span class="deploy-time">${fmtTime(deployTs)}</span>
            <span class="deploy-meta">block #${deployBlock.toLocaleString()}</span>
          </div>
          <span class="deploy-ago">${fmtAgo(deployTs) || 'just now'}</span>
        </div>
        <div class="result-row">
          <span class="result-lbl">Agent Address</span>
          <span class="result-val mono">
            <a href="${CONFIG.EXPLORER}/agents/${address}?type=auto" target="_blank" rel="noopener">${short(address)}</a>
            <button class="copy-btn" data-copy="${address}" title="Copy address">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </span>
        </div>
        <div class="result-row">
          <span class="result-lbl">Status</span>
          <span class="result-val">${inIndex ? 'Active in registry' : 'Contract exists, not in active registry'}</span>
        </div>
      </div>
    </div>`;
  attachCopyHandlers();
}

function attachCopyHandlers() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      } catch {}
    };
  });
}

// -------------- Search --------------
async function search(rawInput) {
  const address = (rawInput || '').toLowerCase().trim();
  if (!address.match(/^0x[a-f0-9]{40}$/)) {
    showError('Enter a valid address — 0x followed by 40 hex characters.');
    return;
  }

  $('searchBtn').disabled = true;
  $('searchStatus').textContent = '';
  $('searchStatus').classList.remove('error');

  // 1. Check pre-computed index first (instant)
  const indexed = state.byAddress[address];
  if (indexed) {
    renderResult({
      address, type: indexed.type,
      deployBlock: indexed.deployBlock, deployTs: indexed.deployTs,
      rank: indexed.rank, total: state.deployData.totalAgents,
      inIndex: true,
    });
    $('searchStatus').textContent = `Found — rank #${indexed.rank.toLocaleString()} of ${state.deployData.totalAgents.toLocaleString()}`;
    $('searchBtn').disabled = false;
    return;
  }

  // 2. Not in index — resolve on-chain
  showLoading('Agent not in index. Checking on-chain…');
  try {
    const type = await determineTypeOnChain(address);
    if (!type) {
      showError('No agent contract found at this address. Is it a valid Ritual agent?');
      return;
    }

    // Binary search deploy block
    const deployBlock = await findDeployBlockOnChain(address, (pct) => {
      showLoading(`Finding deployment block… ${pct}%`);
    });
    const deployTs = await getBlockTimestamp(deployBlock);

    // Estimate rank: count agents in index with earlier deploy block + 1
    let rank = 0;
    for (const a of state.deployData.agents) {
      if (a.deployBlock < deployBlock) rank++;
    }
    rank += 1;
    const total = state.deployData.totalAgents + 1;

    renderResult({ address, type, deployBlock, deployTs, rank, total, inIndex: false });
    $('searchStatus').textContent = `Found on-chain — rank #${rank.toLocaleString()}`;
  } catch (e) {
    showError('Lookup failed: ' + e.message);
  } finally {
    $('searchBtn').disabled = false;
  }
}

async function init() {
  $('searchBtn').addEventListener('click', () => search($('searchInput').value));
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') search($('searchInput').value);
  });
  $('pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $('searchInput').value = text.trim();
        search(text);
      }
    } catch {}
  });

  try {
    await loadData();
  } catch (e) {
    $('searchStatus').textContent = 'Could not load data: ' + e.message;
    $('searchStatus').classList.add('error');
  }
}

init().catch(e => console.error(e));
