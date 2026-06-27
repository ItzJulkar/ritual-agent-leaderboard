/* Ritual Agent Rank — search, type, deploy time, rank.
   Data: deploy-data.json (auto-refreshed) + Ritual Explorer cache API + on-chain fallback. */

const CONFIG = {
  DEPLOY_DATA: 'deploy-data.json',
  CACHE_API: 'https://explorer.ritualfoundation.org/api/agents/cache',
  RPC_URL: 'https://rpc.ritualfoundation.org',
  EXPLORER: 'https://explorer.ritualfoundation.org',
  OWNER_SELECTOR: '0x8da5cb5b',
  SEARCH_MARGIN: 600000,
};

const state = {
  deployData: null,
  byAddress: {},
  currentBlock: 0,
};

const $ = (id) => document.getElementById(id);

async function rpcSingle(method, params) {
  const res = await fetch(CONFIG.RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  return (await res.json()).result;
}

async function loadData() {
  const [depRes, cacheRes] = await Promise.all([
    fetch(CONFIG.DEPLOY_DATA),
    fetch(CONFIG.CACHE_API).catch(() => null),
  ]);
  state.deployData = await depRes.json();
  for (const a of state.deployData.agents) state.byAddress[a.address.toLowerCase()] = a;

  if (cacheRes && cacheRes.ok) {
    const cache = await cacheRes.json();
    for (const e of cache.sovereign || []) {
      const a = e.address.toLowerCase();
      if (!state.byAddress[a]) state.byAddress[a] = { type: 'Sovereign', deployBlock: 0, deployTs: 0, rank: 0 };
    }
  }

  try { state.currentBlock = parseInt(await rpcSingle('eth_blockNumber', []), 16); }
  catch { state.currentBlock = state.deployData.latestBlock || 0; }

  const Sov = Object.values(state.byAddress).filter(a => a.type === 'Sovereign').length;
  const Pers = Object.values(state.byAddress).filter(a => a.type === 'Persistent').length;
  $('statTotal').textContent = state.deployData.totalAgents.toLocaleString();
  $('statSov').textContent = Sov.toLocaleString();
  $('statPers').textContent = Pers.toLocaleString();
  const ago = Math.round((Date.now() / 1000 - state.deployData.computedAt) / 60);
  $('statUpdated').textContent = ago < 60 ? ago + 'm' : Math.round(ago / 60) + 'h';
  $('statsGrid').hidden = false;
  $('searchNote').textContent = `${state.deployData.totalAgents.toLocaleString()} agents indexed · auto-refresh every 10 min`;
}

async function findDeployBlockOnChain(address, onProgress) {
  const lo0 = Math.max(0, state.currentBlock - CONFIG.SEARCH_MARGIN);
  let lo = lo0, hi = state.currentBlock, steps = 0;
  const est = Math.ceil(Math.log2(state.currentBlock - lo0 + 1));
  while (lo < hi) {
    steps++;
    const mid = Math.floor((lo + hi) / 2);
    let code;
    try { code = await rpcSingle('eth_getCode', [address, '0x' + mid.toString(16)]); }
    catch { code = '0x'; }
    if (code && code.length > 2) hi = mid; else lo = mid + 1;
    if (onProgress) onProgress(Math.round((steps / est) * 100));
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

function fmtTime(ts) {
  if (!ts) return 'Unknown';
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}
function fmtAgo(ts) {
  if (!ts) return '';
  const d = Date.now() / 1000 - ts;
  if (d < 3600) return Math.round(d / 60) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' hr ago';
  return Math.round(d / 86400) + ' days ago';
}
function short(a) { return a.slice(0, 8) + '…' + a.slice(-6); }

function showLoading(msg) {
  $('result').innerHTML = `<div class="bento"><div class="bento-empty"><span class="spinner"></span>${msg}</div></div>`;
}
function showError(msg) {
  $('result').innerHTML = `<div class="bento"><div class="bento-error">${msg}</div></div>`;
}

function renderResult({ address, type, deployBlock, deployTs, rank, total, inIndex }) {
  const chip = inIndex ? `chip-${type.toLowerCase()}` : 'chip-inactive';
  const typeLabel = inIndex ? type : type + ' (inactive)';
  const rankNum = rank ? rank.toLocaleString() : '—';
  const totalNum = total ? total.toLocaleString() : '—';

  $('result').innerHTML = `
    <div class="bento">
      <div class="bento-card bento-rank">
        <div class="rank-left">
          <div class="rank-label">Deployment Rank</div>
          <div class="rank-big">#${rankNum}</div>
          <div class="rank-sub">of ${totalNum} agents on Ritual</div>
        </div>
        <div class="rank-right">
          <span class="type-chip ${chip}">${typeLabel}</span>
          <div class="status-text">${inIndex ? 'Active in registry' : 'Contract exists, not in registry'}</div>
        </div>
      </div>
      <div class="bento-card bento-deploy">
        <div class="deploy-l">
          <span class="deploy-lbl">Deployed At</span>
          <span class="deploy-when">${fmtTime(deployTs)}</span>
          <span class="deploy-block">block #${deployBlock.toLocaleString()}</span>
        </div>
        <div class="deploy-r"><span class="deploy-ago">${fmtAgo(deployTs) || 'just now'}</span></div>
      </div>
      <div class="bento-card bento-addr">
        <span class="addr-lbl">Agent Address</span>
        <div class="addr-val">
          <a class="addr-link" href="${CONFIG.EXPLORER}/agents/${address}?type=auto" target="_blank" rel="noopener">${short(address)}</a>
          <button class="copy-btn" data-copy="${address}" title="Copy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </div>
    </div>`;
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

async function search(rawInput) {
  const address = (rawInput || '').toLowerCase().trim();
  if (!address.match(/^0x[a-f0-9]{40}$/)) {
    showError('Enter a valid address — 0x followed by 40 hex characters.');
    return;
  }
  $('searchBtn').disabled = true;
  $('searchNote').textContent = '';
  $('searchNote').classList.remove('error');
  $('meterBar').hidden = true;

  const indexed = state.byAddress[address];
  if (indexed && indexed.deployBlock) {
    renderResult({ address, type: indexed.type, deployBlock: indexed.deployBlock, deployTs: indexed.deployTs, rank: indexed.rank, total: state.deployData.totalAgents, inIndex: true });
    $('searchNote').textContent = `Found — rank #${indexed.rank.toLocaleString()} of ${state.deployData.totalAgents.toLocaleString()}`;
    $('searchBtn').disabled = false;
    return;
  }

  showLoading('Agent not in index. Checking on-chain…');
  try {
    const type = await determineTypeOnChain(address);
    if (!type) { showError('No agent contract found at this address.'); return; }

    $('meterBar').hidden = false;
    const deployBlock = await findDeployBlockOnChain(address, (pct) => {
      $('meterFill').style.width = pct + '%';
      $('meterText').textContent = `Scanning chain… ${pct}%`;
    });
    const deployTs = await getBlockTimestamp(deployBlock);
    $('meterBar').hidden = true;

    let rank = 0;
    for (const a of state.deployData.agents) if (a.deployBlock < deployBlock) rank++;
    rank += 1;
    const total = state.deployData.totalAgents + 1;
    renderResult({ address, type, deployBlock, deployTs, rank, total, inIndex: false });
    $('searchNote').textContent = `Found on-chain — rank #${rank.toLocaleString()}`;
  } catch (e) {
    showError('Lookup failed: ' + e.message);
  } finally {
    $('searchBtn').disabled = false;
    $('meterBar').hidden = true;
  }
}

async function init() {
  $('searchBtn').addEventListener('click', () => search($('searchInput').value));
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') search($('searchInput').value); });
  $('pasteBtn').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { $('searchInput').value = t.trim(); search(t); }
    } catch {}
  });
  try { await loadData(); }
  catch (e) { $('searchNote').textContent = 'Could not load data: ' + e.message; $('searchNote').classList.add('error'); }
}

init().catch(e => console.error(e));
