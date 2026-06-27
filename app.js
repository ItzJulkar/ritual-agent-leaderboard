/* ============================================================
   Ritual Agent Leaderboard
   Data: Ritual Explorer cache API + batched owner() RPC calls
   ============================================================ */

const CONFIG = {
  CACHE_API: 'https://explorer.ritualfoundation.org/api/agents/cache',
  RPC_URL: 'https://rpc.ritualfoundation.org',
  EXPLORER: 'https://explorer.ritualfoundation.org',
  OWNER_SELECTOR: '0x8da5cb5b',        // owner()
  BATCH_SIZE: 100,                      // eth_call per JSON-RPC batch request
  BATCH_CONCURRENCY: 8,                 // parallel batch requests
  OWNER_CACHE_KEY: 'ritual_sovereign_owners_v2',
  OWNER_CACHE_TTL: 3600_000,            // 1 hour
  PAGE_SIZE: 50,
};

// -------------- State --------------
const state = {
  agents: [],
  owners: {},          // agentAddress -> ownerAddress (sovereign)
  currentBlock: 0,
  leaderboard: [],
  agentSort: { key: 'lastBlock', dir: 'desc' },
  lbSort: { key: 'total', dir: 'desc' },
  agentPage: 1,
  filteredAgents: [],
};

// -------------- Helpers --------------
const $ = (id) => document.getElementById(id);
const short = (addr) => addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
const fmtNum = (n) => n.toLocaleString('en-US');

function addrLink(addr) {
  if (!addr) return '<span class="addr-short">—</span>';
  return `<a class="addr" href="${CONFIG.EXPLORER}/address/${addr}" target="_blank" rel="noopener" title="${addr}">
    <span>${short(addr)}</span><button class="copy-btn" data-copy="${addr}" title="Copy">⧉</button></a>`;
}
function agentLink(addr) {
  return `<a class="addr" href="${CONFIG.EXPLORER}/agents/${addr}?type=auto" target="_blank" rel="noopener" title="${addr}">
    <span>${short(addr)}</span><button class="copy-btn" data-copy="${addr}" title="Copy">⧉</button></a>`;
}
function typeBadge(type) { return `<span class="badge badge-${type.toLowerCase()}">${type}</span>`; }
function stateBadge(agent) {
  if (agent.type === 'Persistent') {
    const cls = agent.isAlive ? 'alive' : 'dead';
    const label = agent.state || (agent.isAlive ? 'ALIVE' : 'DEAD');
    return `<span class="badge badge-${cls}">${label}</span>`;
  }
  return `<span class="badge badge-monitored">MONITORED</span>`;
}
function ageInfo(blocksAgo) {
  if (blocksAgo == null || isNaN(blocksAgo)) return '<span class="age-text">—</span>';
  if (blocksAgo < 0) blocksAgo = 0;
  const cls = blocksAgo < 5000 ? 'age-fresh' : blocksAgo < 50000 ? 'age-stale' : 'age-dead';
  let label;
  if (blocksAgo < 1000) label = blocksAgo + ' blocks';
  else if (blocksAgo < 1_000_000) label = (blocksAgo / 1000).toFixed(1) + 'k blocks';
  else label = (blocksAgo / 1_000_000).toFixed(2) + 'M blocks';
  return `<span class="age-text ${cls}">${label} ago</span>`;
}

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

async function rpc(method, params) {
  const res = await fetch(CONFIG.RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// -------------- Data loading --------------
async function loadCache() {
  const res = await fetch(CONFIG.CACHE_API);
  const data = await res.json();
  const agents = [];

  (data.persistent || []).forEach((entry) => {
    const info = entry.info || {};
    agents.push({
      address: (info.agentAddress || entry.address).toLowerCase(),
      owner: (info.owner || '').toLowerCase(),
      type: 'Persistent',
      state: info.state || 'UNKNOWN',
      isAlive: info.isAlive,
      lastBlock: info.lastHeartbeatBlock || 0,
    });
  });

  (data.sovereign || []).forEach((entry) => {
    agents.push({
      address: entry.address.toLowerCase(),
      owner: '',
      type: 'Sovereign',
      state: 'MONITORED',
      isAlive: true,
      lastBlock: entry.lastActivityBlock || 0,
    });
  });

  return agents;
}

async function getCurrentBlock() {
  const hex = await rpc('eth_blockNumber', []);
  return parseInt(hex, 16);
}

// Resolve sovereign agent owners via batched owner() calls
async function fetchSovereignOwners(onProgress) {
  const sovereignAddrs = state.agents
    .filter(a => a.type === 'Sovereign' && !a.owner)
    .map(a => a.address);

  const batches = [];
  for (let i = 0; i < sovereignAddrs.length; i += CONFIG.BATCH_SIZE) {
    batches.push(sovereignAddrs.slice(i, i + CONFIG.BATCH_SIZE));
  }

  const owners = {};
  let done = 0;

  async function worker() {
    while (batches.length > 0) {
      const batch = batches.shift();
      const calls = batch.map(a => ['eth_call', [{ to: a, data: CONFIG.OWNER_SELECTOR }, 'latest']]);
      try {
        const results = await rpcBatch(calls);
        const byId = {};
        for (const r of results) byId[r.id] = r;
        for (let i = 0; i < batch.length; i++) {
          const res = byId[i] ? byId[i].result : '0x';
          if (res && res.length >= 66) {
            const owner = '0x' + res.slice(26).toLowerCase();
            if (owner.length === 42) {
              const big = BigInt(res);
              if (big > 0n) owners[batch[i]] = owner;
            }
          }
        }
      } catch (e) { /* skip failed batch */ }
      done++;
      if (onProgress) onProgress(done, batches.length + done);
    }
  }

  const total = batches.length;
  const workers = Array.from({ length: Math.min(CONFIG.BATCH_CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);
  return owners;
}

// localStorage cache
function loadCachedOwners() {
  try {
    const raw = localStorage.getItem(CONFIG.OWNER_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CONFIG.OWNER_CACHE_TTL) return null;
    return obj.map;
  } catch { return null; }
}
function saveCachedOwners(map) {
  try {
    localStorage.setItem(CONFIG.OWNER_CACHE_KEY, JSON.stringify({ ts: Date.now(), map }));
  } catch { /* quota */ }
}

// -------------- Rendering --------------
function renderStats() {
  const persistent = state.agents.filter(a => a.type === 'Persistent').length;
  const sovereign = state.agents.filter(a => a.type === 'Sovereign').length;
  const owners = new Set(state.agents.filter(a => a.owner).map(a => a.owner)).size;
  $('statTotal').textContent = fmtNum(state.agents.length);
  $('statPersistent').textContent = fmtNum(persistent);
  $('statSovereign').textContent = fmtNum(sovereign);
  $('statOwners').textContent = fmtNum(owners);
  $('statBlock').textContent = fmtNum(state.currentBlock);
}

function buildLeaderboard() {
  const byOwner = {};
  for (const a of state.agents) {
    if (!a.owner) continue;
    if (!byOwner[a.owner]) byOwner[a.owner] = { owner: a.owner, persistent: 0, sovereign: 0, lastBlock: 0 };
    const o = byOwner[a.owner];
    if (a.type === 'Persistent') o.persistent++; else o.sovereign++;
    if (a.lastBlock > o.lastBlock) o.lastBlock = a.lastBlock;
  }
  state.leaderboard = Object.values(byOwner).map(o => ({
    owner: o.owner, total: o.persistent + o.sovereign,
    persistent: o.persistent, sovereign: o.sovereign, lastBlock: o.lastBlock,
  }));
  sortLeaderboard();
}

function sortLeaderboard() {
  const { key, dir } = state.lbSort;
  state.leaderboard.sort((a, b) => {
    let cmp = key === 'owner' ? a.owner.localeCompare(b.owner) : (a[key] || 0) - (b[key] || 0);
    return dir === 'asc' ? cmp : -cmp;
  });
}

function renderLeaderboard() {
  const tbody = $('leaderboardBody');
  if (state.leaderboard.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading-row"><span class="spinner"></span>Resolving sovereign agent owners…</td></tr>';
    return;
  }
  tbody.innerHTML = state.leaderboard.map((o, i) => {
    const rank = i + 1;
    const rankCls = rank <= 3 ? `rank rank-${rank}` : 'rank';
    return `<tr>
      <td class="${rankCls}">${rank}</td>
      <td>${addrLink(o.owner)}</td>
      <td class="col-num"><strong>${o.total}</strong></td>
      <td class="col-num">${o.persistent}</td>
      <td class="col-num">${o.sovereign}</td>
      <td class="col-num"><span class="block-num">#${fmtNum(o.lastBlock)}</span></td>
    </tr>`;
  }).join('');
  attachCopyHandlers();
}

function applyAgentFilters() {
  const q = ($('agentFilter').value || '').toLowerCase().trim();
  const typeF = $('typeFilter').value;
  const stateF = $('stateFilter').value;
  state.filteredAgents = state.agents.filter(a => {
    if (typeF && a.type.toLowerCase() !== typeF) return false;
    if (stateF) {
      if (a.type === 'Persistent') {
        const lbl = a.isAlive ? 'ALIVE' : 'DEAD';
        if (a.state !== stateF && lbl !== stateF) return false;
      } else if (stateF !== 'MONITORED') return false;
    }
    if (q) {
      const hay = (a.address + ' ' + a.owner + ' ' + a.state + ' ' + a.type).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  sortAgents();
  state.agentPage = 1;
  renderAgents();
}

function sortAgents() {
  const { key, dir } = state.agentSort;
  state.filteredAgents.sort((a, b) => {
    let cmp;
    if (key === 'lastBlock') cmp = (a.lastBlock || 0) - (b.lastBlock || 0);
    else if (key === 'address') cmp = a.address.localeCompare(b.address);
    else if (key === 'owner') cmp = (a.owner || '').localeCompare(b.owner || '');
    else if (key === 'type') cmp = a.type.localeCompare(b.type);
    else cmp = 0;
    return dir === 'asc' ? cmp : -cmp;
  });
}

function renderAgents() {
  const tbody = $('agentsBody');
  const total = state.filteredAgents.length;
  const pages = Math.max(1, Math.ceil(total / CONFIG.PAGE_SIZE));
  if (state.agentPage > pages) state.agentPage = pages;
  const start = (state.agentPage - 1) * CONFIG.PAGE_SIZE;
  const slice = state.filteredAgents.slice(start, start + CONFIG.PAGE_SIZE);

  if (slice.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading-row">No agents match.</td></tr>';
    $('agentPager').innerHTML = '';
    return;
  }
  tbody.innerHTML = slice.map(a => {
    const blocksAgo = state.currentBlock ? state.currentBlock - a.lastBlock : null;
    return `<tr>
      <td><span class="block-num">#${fmtNum(a.lastBlock)}</span></td>
      <td>${agentLink(a.address)}</td>
      <td>${typeBadge(a.type)}</td>
      <td>${stateBadge(a)}</td>
      <td>${a.owner ? addrLink(a.owner) : '<span class="addr-short">—</span>'}</td>
      <td>${ageInfo(blocksAgo)}</td>
    </tr>`;
  }).join('');
  attachCopyHandlers();
  renderPager(pages);
}

function renderPager(pages) {
  const el = $('agentPager');
  if (pages <= 1) { el.innerHTML = ''; return; }
  const cur = state.agentPage;
  let btns = [`<button data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''}>‹ Prev</button>`];
  const range = [1];
  for (let p = cur - 2; p <= cur + 2; p++) if (p > 1 && p < pages) range.push(p);
  if (pages > 1) range.push(pages);
  let prev = 0;
  for (const p of range) {
    if (p - prev > 1) btns.push('<span style="color:var(--text-mute)">…</span>');
    btns.push(`<button data-page="${p}" class="${p === cur ? 'active' : ''}">${p}</button>`);
    prev = p;
  }
  btns.push(`<button data-page="${cur + 1}" ${cur === pages ? 'disabled' : ''}>Next ›</button>`);
  el.innerHTML = btns.join('');
  el.querySelectorAll('button[data-page]').forEach(b => {
    b.addEventListener('click', () => {
      const p = parseInt(b.dataset.page);
      if (p >= 1 && p <= pages) { state.agentPage = p; renderAgents(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });
  });
}

function renderSearch() {
  const q = ($('searchInput').value || '').toLowerCase().trim();
  const el = $('searchResults');
  if (q.length < 3) {
    el.innerHTML = '<div class="result-empty">Type at least 3 characters of an agent or owner address.</div>';
    return;
  }
  const matches = state.agents.filter(a => a.address.includes(q) || (a.owner && a.owner.includes(q)));
  if (matches.length === 0) {
    el.innerHTML = `<div class="result-empty">No agents found for "${q}".</div>`;
    return;
  }
  el.innerHTML = `<div class="result-empty" style="padding:8px 0">${matches.length} match${matches.length > 1 ? 'es' : ''}</div>` +
    matches.map(a => {
      const blocksAgo = state.currentBlock ? state.currentBlock - a.lastBlock : null;
      return `<div class="result-card">
        <div class="rc-row">
          <div><div class="rc-label">Agent</div><div class="rc-val">${agentLink(a.address)}</div></div>
          <div>${typeBadge(a.type)} ${stateBadge(a)}</div>
        </div>
        <div class="rc-row" style="margin-top:10px">
          <div><div class="rc-label">Owner</div><div class="rc-val">${a.owner ? addrLink(a.owner) : '—'}</div></div>
          <div><div class="rc-label">Last Activity</div><div class="rc-val">#${fmtNum(a.lastBlock)} ${ageInfo(blocksAgo)}</div></div>
        </div>
      </div>`;
    }).join('');
  attachCopyHandlers();
}

function attachCopyHandlers() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const orig = btn.textContent; btn.textContent = '✓';
        setTimeout(() => { btn.textContent = orig; }, 1000);
      } catch {}
    };
  });
}

// -------------- Tabs --------------
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  $('panel-' + name).classList.remove('hidden');
}

// -------------- Main flow --------------
async function init() {
  bindEvents();
  try { state.currentBlock = await getCurrentBlock(); } catch { state.currentBlock = 0; }

  state.agents = await loadCache();
  renderStats();
  buildLeaderboard();
  renderLeaderboard();
  applyAgentFilters();
  renderSearch();

  await resolveSovereignOwners();
}

async function resolveSovereignOwners() {
  let ownerMap = loadCachedOwners();
  if (ownerMap) { applyOwners(ownerMap); return; }

  const bar = $('progressBar');
  bar.hidden = false;
  try {
    const ownerMap = await fetchSovereignOwners((done, total) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      $('progressFill').style.width = pct + '%';
      $('progressText').textContent = `Resolving sovereign agent owners… ${done}/${total} batches (${pct}%)`;
    });
    saveCachedOwners(ownerMap);
    applyOwners(ownerMap);
    $('progressText').textContent = `Resolved ${Object.keys(ownerMap).length} sovereign agent owners.`;
    setTimeout(() => { bar.hidden = true; }, 2000);
  } catch (e) {
    $('progressText').textContent = 'Could not resolve sovereign owners: ' + e.message;
  }
}

function applyOwners(ownerMap) {
  state.owners = ownerMap;
  for (const a of state.agents) {
    if (a.type === 'Sovereign' && !a.owner && ownerMap[a.address]) a.owner = ownerMap[a.address];
  }
  renderStats();
  buildLeaderboard();
  renderLeaderboard();
  applyAgentFilters();
  if ($('searchInput').value) renderSearch();
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('refreshBtn').addEventListener('click', refresh);

  $('leaderboardTable').querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.lbSort.key === key) state.lbSort.dir = state.lbSort.dir === 'asc' ? 'desc' : 'asc';
      else { state.lbSort.key = key; state.lbSort.dir = 'desc'; }
      sortLeaderboard(); renderLeaderboard();
    });
  });

  $('agentsTable').querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.agentSort.key === key) state.agentSort.dir = state.agentSort.dir === 'asc' ? 'desc' : 'asc';
      else { state.agentSort.key = key; state.agentSort.dir = 'desc'; }
      sortAgents(); renderAgents();
    });
  });

  $('agentFilter').addEventListener('input', applyAgentFilters);
  $('typeFilter').addEventListener('change', applyAgentFilters);
  $('stateFilter').addEventListener('change', applyAgentFilters);
  $('searchInput').addEventListener('input', renderSearch);
}

async function refresh() {
  const btn = $('refreshBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    localStorage.removeItem(CONFIG.OWNER_CACHE_KEY);
    state.currentBlock = await getCurrentBlock();
    state.agents = await loadCache();
    renderStats(); buildLeaderboard(); renderLeaderboard(); applyAgentFilters();
    await resolveSovereignOwners();
  } catch (e) {
    alert('Refresh failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '↻ Refresh';
  }
}

init().catch(e => {
  console.error(e);
  const tbody = $('leaderboardBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="loading-row">Failed to load: ${e.message}</td></tr>`;
});
