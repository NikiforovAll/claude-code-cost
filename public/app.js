// #region STATE

let currentView = 'overview';
let overviewData = null;
let projectsData = null;
let sessionsData = null;
let sessionsCostSeries = null;
let sessionsModelDistribution = null;
let sessionDetailData = null;
let currentProjectPath = null;
let currentProjectName = null;
// Two distinct notions, deliberately not merged: scope is what the views aggregate over
// (hub-owned, persisted, never written to the URL by updateUrl); currentProjectPath is the
// drill-down cursor, and `?project=` in the URL means "I drilled in" to five readers.
let scopeProject = null;
let scopeProjectName = null;
let currentSessionId = null;
let parentView = 'projects';
let lastSelectedProject = null;
let lastSelectedSession = null;
const DEFAULT_SORT = {
  overview: { field: 'totalCost', order: 'desc' },
  projects: { field: 'lastActive', order: 'desc' },
  sessions: { field: 'lastTimestamp', order: 'desc' },
};
const viewSort = structuredClone(DEFAULT_SORT);
let dateRange = 3;
const charts = {};
let lastRenderHash = {};
let navCounter = 0;

// #endregion

// #region UTILS

// The div.textContent -> innerHTML trick escapes only & < > : innerHTML serializes
// for *text* context, where quotes are correctly left raw. That made every
// attribute interpolation breakable with a bare " . It cannot be patched, so the
// escaping is explicit here.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

// For a value landing inside a quoted JS string inside an HTML attribute —
// onclick="fn('${escAttrJs(x)}')". The browser HTML-decodes the attribute before
// the JS parser sees it, so the JS escape must happen first and be escaped in turn.
function escAttrJs(value) {
  const js = String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return esc(js);
}

function formatCost(usd) {
  if (usd == null || usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(count) {
  if (!count) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

function formatDuration(minutes) {
  if (!minutes || minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Bucket keys arrive as YYYY-MM-DD (day) or YYYY-MM-DDTHH (hour), both in the server's local
// time with no zone suffix.
function bucketLabel(key, bucket) {
  if (bucket === 'hour') {
    return new Date(`${key}:00:00`).toLocaleTimeString(undefined, { hour: 'numeric' });
  }
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function costSeriesTitle(series) {
  return series?.bucket === 'hour' ? 'Hourly Cost' : 'Daily Cost';
}

function shortModel(model) {
  if (!model) return 'unknown';
  return model
    .replace('anthropic/', '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

function sortCompare(a, b, field, order) {
  let va = a[field],
    vb = b[field];
  if (typeof va === 'string') va = va.toLowerCase();
  if (typeof vb === 'string') vb = vb.toLowerCase();
  if (va < vb) return order === 'asc' ? -1 : 1;
  if (va > vb) return order === 'asc' ? 1 : -1;
  return 0;
}

function currentSort() {
  return viewSort[currentView];
}

function sortArrow(field) {
  const s = currentSort();
  if (!s || s.field !== field) return '';
  return `<span class="sort-arrow">${s.order === 'asc' ? '\u25B2' : '\u25BC'}</span>`;
}

function thClass(field) {
  const s = currentSort();
  return s && s.field === field ? 'sorted' : '';
}

function parentBreadcrumb() {
  const label = parentView === 'overview' ? 'Overview' : 'Projects';
  return `<a class="parent-breadcrumb">${label}</a>`;
}

// In-view reminder that the numbers below cover one project, not everything. Reuses the
// breadcrumb styling — same role (where am I), no new CSS.
function scopeIndicator() {
  if (!scopeProject) return '';
  return `<div class="breadcrumb">
      <span class="current">${esc(scopeProjectName || scopeProject)}</span>
      <span class="sep">/</span>
      <a onclick="clearScope()">all projects</a>
    </div>`;
}

function focusPreviousRow(view) {
  let selector;
  if (view === 'overview' || view === 'projects') {
    if (!lastSelectedProject) return;
    selector = `tr[onclick*="'${lastSelectedProject}'"]`;
  } else if (view === 'sessions') {
    if (!lastSelectedSession) return;
    selector = `tr[onclick*="'${lastSelectedSession}'"]`;
  }
  if (!selector) return;
  requestAnimationFrame(() => {
    const rows = getVisibleRows();
    const idx = rows.findIndex((r) => r.matches(selector));
    selectRow(idx >= 0 ? idx : 0);
  });
}

// #endregion

// #region URL_STATE

function getUrlState() {
  let p = new URLSearchParams(window.location.search);
  if (!p.has('view') && !p.has('session') && !p.has('project')) {
    const saved = sessionStorage.getItem('cc-cost:nav');
    if (saved) p = new URLSearchParams(saved);
  }
  return {
    view: p.get('view') || 'overview',
    project: p.get('project'),
    projectName: p.get('projectName'),
    session: p.get('session'),
    parentView: p.get('parentView') || 'projects',
  };
}

function loadDateRange() {
  const v = localStorage.getItem('cc-cost:range');
  if (!v) return 3;
  if (v === 'today') return 'today';
  return parseInt(v, 10) || 3;
}

function saveDateRange(val) {
  localStorage.setItem('cc-cost:range', String(val));
}

function loadScope() {
  const raw = localStorage.getItem('cc-cost:scope');
  if (!raw) return;
  try {
    const { encoded, name } = JSON.parse(raw);
    if (encoded) {
      scopeProject = encoded;
      scopeProjectName = name || encoded;
    }
  } catch {
    /* ignore */
  }
}

function saveScope() {
  if (scopeProject) {
    localStorage.setItem('cc-cost:scope', JSON.stringify({ encoded: scopeProject, name: scopeProjectName }));
  } else {
    localStorage.removeItem('cc-cost:scope');
  }
}

function rangeLabel(r) {
  return r === 'today' ? 'today' : `${r} days`;
}

function loadSort() {
  for (const view of Object.keys(DEFAULT_SORT)) {
    const raw = localStorage.getItem(`cc-cost:sort:${view}`);
    if (raw) {
      try {
        const { field, order } = JSON.parse(raw);
        if (field) viewSort[view].field = field;
        if (order) viewSort[view].order = order;
      } catch {
        /* ignore */
      }
    }
  }
}

function saveSort() {
  const s = currentSort();
  localStorage.setItem(`cc-cost:sort:${currentView}`, JSON.stringify(s));
}

function updateUrl() {
  const p = new URLSearchParams();
  if (currentView !== 'overview') p.set('view', currentView);
  if (currentProjectPath) p.set('project', currentProjectPath);
  if (currentProjectName) p.set('projectName', currentProjectName);
  if (currentSessionId) p.set('session', currentSessionId);
  if (parentView !== 'projects') p.set('parentView', parentView);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : '/');
  sessionStorage.setItem('cc-cost:nav', qs);
}

// #endregion

// #region FETCH

const BROWSER_CACHE_TTL = 5 * 60 * 1000; // 5 min
const CACHE_VERSION = 4;
let forceRefresh = false;
// Age of the data on screen, for the auto-refresh staleness check. A cache hit carries its own
// timestamp forward, so a reload with a warm cache doesn't look freshly fetched.
let dataFetchedAt = 0;

function getCached(key) {
  if (forceRefresh) return null;
  try {
    const raw = localStorage.getItem(`cc-cost:${key}`);
    if (!raw) return null;
    const { data, ts, v } = JSON.parse(raw);
    if (v !== CACHE_VERSION || Date.now() - ts > BROWSER_CACHE_TTL) return null;
    dataFetchedAt = Math.max(dataFetchedAt, ts);
    return data;
  } catch {
    return null;
  }
}

function setLocalCache(key, data) {
  try {
    pruneLocalCache();
    localStorage.setItem(`cc-cost:${key}`, JSON.stringify({ data, ts: Date.now(), v: CACHE_VERSION }));
  } catch {
    /* storage full — ignore */
  }
}

function pruneLocalCache() {
  const MAX_ENTRIES = 20;
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k.startsWith('cc-cost:')) continue;
    // Prefs are not cache entries — they have no ts, so they'd sort oldest-first and be
    // evicted ahead of real data while also eating the entry budget.
    if (isPrefKey(k)) continue;
    try {
      const { ts } = JSON.parse(localStorage.getItem(k));
      entries.push({ k, ts });
    } catch {
      entries.push({ k, ts: 0 });
    }
  }
  if (entries.length <= MAX_ENTRIES) return;
  entries.sort((a, b) => a.ts - b.ts);
  const toRemove = entries.length - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) localStorage.removeItem(entries[i].k);
}

function isPrefKey(k) {
  return k.startsWith('cc-cost:sort:') || k === 'cc-cost:range' || k === 'cc-cost:scope';
}
function clearLocalCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('cc-cost:') && !isPrefKey(k)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
}

async function fetchJSON(url, skipCache) {
  if (!skipCache) {
    const cached = getCached(url);
    if (cached) return cached;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  dataFetchedAt = Date.now();
  if (!skipCache) setLocalCache(url, data);
  return data;
}

// fetchJSON caches by full URL, so the scoped and unscoped variants key apart for free.
function scopeParam() {
  return scopeProject ? `&project=${encodeURIComponent(scopeProject)}` : '';
}

async function fetchOverview() {
  overviewData = await fetchJSON(`/api/overview?range=${dateRange}${scopeParam()}`);
}

// Fire-and-forget label upgrade: /api/projects/:path/sessions carries no project name, so ask
// the scoped projects endpoint (one row) for the decoded one.
async function resolveScopeName() {
  const target = scopeProject;
  try {
    const rows = await fetchJSON(`/api/projects?range=${dateRange}${scopeParam()}`);
    const name = rows?.[0]?.encodedPath === target ? rows[0].name : null;
    if (!name || scopeProject !== target) return;
    scopeProjectName = name;
    if (currentProjectPath === target) currentProjectName = name;
    saveScope();
    renderScopeChip();
    lastRenderHash = {};
    // Repaint via loadAndRender rather than a renderer directly: fetchJSON serves the already
    // cached payloads, so this is a re-render, not a second round trip.
    await loadAndRender(currentView);
  } catch {
    /* label stays encoded — cosmetic only */
  }
}

async function fetchProjects() {
  projectsData = await fetchJSON(`/api/projects?range=${dateRange}${scopeParam()}`);
}

async function fetchSessions(encodedPath) {
  const data = await fetchJSON(`/api/projects/${encodeURIComponent(encodedPath)}/sessions?range=${dateRange}`, true);
  sessionsData = data.sessions;
  sessionsCostSeries = data.costSeries;
  sessionsModelDistribution = data.modelDistribution || [];
}

async function fetchSessionDetail(sessionId) {
  sessionDetailData = await fetchJSON(`/api/sessions/${encodeURIComponent(sessionId)}`, true);
  // Populate project context when opening via deep link (no project in URL)
  if (sessionDetailData && !currentProjectPath) {
    currentProjectPath = sessionDetailData.encodedProjectPath;
    currentProjectName = sessionDetailData.projectPath;
  }
}

// #endregion

// #region RENDER_OVERVIEW

function renderOverview() {
  const el = document.getElementById('overview-view');
  if (!el) return;
  if (!overviewData) {
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
    return;
  }

  const s = overviewData.summary;
  // Scope is in the hash because two different empty projects produce byte-identical payloads —
  // without it the indicator label would never repaint.
  const h = JSON.stringify({ overviewData, sort: viewSort.overview, scopeProject, scopeProjectName });
  if (lastRenderHash.overview === h) return;
  lastRenderHash.overview = h;

  const costSeries = overviewData.costSeries;
  const models = overviewData.modelDistribution || [];

  // Return before any chart call so no canvas is touched — there are none in this markup.
  if (scopeProject && s.totalSessions === 0) {
    el.innerHTML = `<div class="dashboard-content">
      ${scopeIndicator()}
      <div class="empty-state">
        <div class="empty-icon">$</div>
        <div>No usage for ${esc(scopeProjectName || scopeProject)} in the last ${rangeLabel(dateRange)}</div>
        <div>Clear the project scope to see everything.</div>
      </div>
    </div>`;
    return;
  }

  el.innerHTML = `
    <div class="dashboard-content">
      ${scopeIndicator()}
      <div class="cards-row">
        <div class="stat-card">
          <div class="card-label">Today</div>
          <div class="card-value cost">${formatCost(s.todayCost)}</div>
        </div>
        ${
          dateRange === 'today'
            ? ''
            : `
        <div class="stat-card">
          <div class="card-label">${dateRange} Days</div>
          <div class="card-value cost">${formatCost(s.totalCost)}</div>
        </div>`
        }
        <div class="stat-card">
          <div class="card-label">Sessions</div>
          <div class="card-value">${s.totalSessions}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Tokens</div>
          <div class="card-value">${formatTokens(s.totalInput + s.totalOutput)}</div>
          <div class="card-sub">In: ${formatTokens(s.totalInput)} / Out: ${formatTokens(s.totalOutput)}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Cache Efficiency</div>
          <div class="card-value">${(s.cacheEfficiency * 100).toFixed(1)}%</div>
          <div class="card-sub">Read: ${formatTokens(s.totalCacheRead)} / Created: ${formatTokens(s.totalCacheCreation)}</div>
        </div>
      </div>

      <div class="charts-row">
        <div class="chart-box">
          <div class="chart-title">${costSeriesTitle(costSeries)}</div>
          <canvas id="costChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Cost by Model</div>
          <canvas id="modelChart"></canvas>
        </div>
      </div>

      ${
        overviewData.projects?.length
          ? `
      <div class="section-title">Projects</div>
      <table class="data-table">
        <thead><tr>
          <th class="${thClass('name')}" onclick="sortBy('name')">Project ${sortArrow('name')}</th>
          <th class="${thClass('totalCost')}" onclick="sortBy('totalCost')">Cost ${sortArrow('totalCost')}</th>
          <th class="${thClass('sessionCount')}" onclick="sortBy('sessionCount')">Sessions ${sortArrow('sessionCount')}</th>
          <th class="${thClass('lastActive')}" onclick="sortBy('lastActive')">Last Active ${sortArrow('lastActive')}</th>
        </tr></thead>
        <tbody>
          ${[...overviewData.projects]
            .sort((a, b) => sortCompare(a, b, viewSort.overview.field, viewSort.overview.order))
            .map(
              (p) => `
            <tr data-clickable onclick="navigateToSessions('${escAttrJs(p.encodedPath)}', '${escAttrJs(p.name)}')">
              <td>${esc(p.name)}</td>
              <td class="cost-cell">${formatCost(p.totalCost)}</td>
              <td>${p.sessionCount}</td>
              <td class="muted">${timeAgo(p.lastActive)}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>`
          : ''
      }
    </div>`;

  // Render charts after DOM is ready
  requestAnimationFrame(() => {
    renderCostChart(costSeries);
    renderModelChart(models);
  });
}

// #endregion

// #region RENDER_PROJECTS

function renderProjects() {
  const el = document.getElementById('projects-view');
  if (!el) return;
  if (!projectsData) {
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
    return;
  }

  const h = JSON.stringify({ projectsData, sort: viewSort.projects, scopeProject, scopeProjectName });
  if (lastRenderHash.projects === h) return;
  lastRenderHash.projects = h;

  const sorted = [...projectsData].sort((a, b) => sortCompare(a, b, viewSort.projects.field, viewSort.projects.order));

  if (sorted.length === 0) {
    el.innerHTML = `<div class="dashboard-content">
      ${scopeIndicator()}
      <div class="empty-state">
      <div class="empty-icon">$</div>
      ${
        scopeProject
          ? `<div>No usage for ${esc(scopeProjectName || scopeProject)} in the last ${rangeLabel(dateRange)}</div>
             <div>Clear the project scope to see everything.</div>`
          : `<div>No project data found</div>
             <div>Make sure Claude Code session files exist in ~/.claude/projects/</div>`
      }
    </div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="dashboard-content">
      ${scopeProject ? scopeIndicator() : '<div class="section-title">All Projects</div>'}
      <table class="data-table">
        <thead><tr>
          <th class="${thClass('name')}" onclick="sortBy('name')">Project ${sortArrow('name')}</th>
          <th class="${thClass('totalCost')}" onclick="sortBy('totalCost')">Cost ${sortArrow('totalCost')}</th>
          <th class="${thClass('sessionCount')}" onclick="sortBy('sessionCount')">Sessions ${sortArrow('sessionCount')}</th>
          <th class="${thClass('lastActive')}" onclick="sortBy('lastActive')">Last Active ${sortArrow('lastActive')}</th>
          <th>Model</th>
        </tr></thead>
        <tbody>
          ${sorted
            .map(
              (p) => `
            <tr data-clickable onclick="navigateToSessions('${escAttrJs(p.encodedPath)}', '${escAttrJs(p.name)}')">
              <td>${esc(p.name)}</td>
              <td class="cost-cell">${formatCost(p.totalCost)}</td>
              <td>${p.sessionCount}</td>
              <td class="muted">${timeAgo(p.lastActive)}</td>
              <td><span class="model-badge">${esc(shortModel(p.primaryModel))}</span></td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

// #endregion

// #region RENDER_SESSIONS

function renderSessions() {
  const el = document.getElementById('sessions-view');
  if (!el) return;
  if (!sessionsData) {
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
    return;
  }

  const h = JSON.stringify({ sessionsData, sessionsCostSeries, sessionsModelDistribution, sort: viewSort.sessions });
  if (lastRenderHash.sessions === h) return;
  lastRenderHash.sessions = h;

  if (sessionsData.length === 0) {
    el.innerHTML = `<div class="dashboard-content">
      <div class="breadcrumb">
        ${parentBreadcrumb()}
        <span class="sep">/</span>
        <span class="current">${esc(currentProjectName || 'Project')}</span>
      </div>
      <div class="empty-state"><div>No sessions found for this project</div></div>
    </div>`;
    return;
  }

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="breadcrumb">
        ${parentBreadcrumb()}
        <span class="sep">/</span>
        <span class="current">${esc(currentProjectName || 'Project')}</span>
      </div>
      <div class="charts-row" style="grid-template-columns:3fr 2fr auto">
        <div class="chart-box">
          <div class="chart-title">${costSeriesTitle(sessionsCostSeries)}</div>
          <canvas id="sessionsCostChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Cost by Model</div>
          <canvas id="sessionsModelChart"></canvas>
        </div>
        <div class="chart-box" style="display:flex;flex-direction:column;justify-content:center;align-items:center;min-width:120px">
          <div class="chart-title">Total Cost</div>
          <div style="font-size:22px;font-weight:700;color:var(--accent)">${formatCost(sessionsData.reduce((s, x) => s + x.totalCost, 0))}</div>
          <div style="color:var(--text-tertiary);font-size:12px;margin-top:4px">${sessionsData.length} sessions</div>
        </div>
      </div>

      <table class="data-table">
        <thead><tr>
          <th class="${thClass('firstPrompt')}" onclick="sortBy('firstPrompt')">Session ${sortArrow('firstPrompt')}</th>
          <th class="${thClass('totalCost')}" onclick="sortBy('totalCost')">Cost ${sortArrow('totalCost')}</th>
          <th class="${thClass('totalTokens')}" onclick="sortBy('totalTokens')">Tokens ${sortArrow('totalTokens')}</th>
          <th class="${thClass('messageCount')}" onclick="sortBy('messageCount')">Messages ${sortArrow('messageCount')}</th>
          <th class="${thClass('durationMinutes')}" onclick="sortBy('durationMinutes')">Duration ${sortArrow('durationMinutes')}</th>
          <th>Model</th>
          <th class="${thClass('lastTimestamp')}" onclick="sortBy('lastTimestamp')">Last Active ${sortArrow('lastTimestamp')}</th>
        </tr></thead>
        <tbody>
          ${[...sessionsData]
            .sort((a, b) => sortCompare(a, b, viewSort.sessions.field, viewSort.sessions.order))
            .map(
              (s) => `
            <tr data-clickable onclick="navigateToDetail('${escAttrJs(s.sessionId)}')">
              <td class="truncate" title="${esc(s.customTitle || s.firstPrompt || s.sessionId)}">${esc(s.customTitle || s.firstPrompt || s.sessionId)}</td>
              <td class="cost-cell">${formatCost(s.totalCost)}</td>
              <td>${formatTokens(s.totalTokens)}</td>
              <td>${s.messageCount}</td>
              <td class="muted">${formatDuration(s.durationMinutes)}</td>
              <td><span class="model-badge">${esc(shortModel(s.primaryModel))}</span></td>
              <td class="muted">${timeAgo(s.lastTimestamp)}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;

  requestAnimationFrame(() => {
    renderCostChart(sessionsCostSeries, 'sessionsCostChart', 'sessionsCost');
    renderModelChart(sessionsModelDistribution || [], 'sessionsModelChart', 'sessionsModel');
  });
}

// #endregion

// #region RENDER_DETAIL

function renderDetail() {
  const el = document.getElementById('detail-view');
  if (!el) return;
  if (!sessionDetailData) {
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
    return;
  }

  const d = sessionDetailData;
  const h = JSON.stringify(d);
  if (lastRenderHash.detail === h) return;
  lastRenderHash.detail = h;

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="breadcrumb">
        ${parentBreadcrumb()}
        <span class="sep">/</span>
        <a onclick="navigateToSessions('${escAttrJs(d.encodedProjectPath)}', '${escAttrJs(d.projectPath)}')">${esc(d.projectPath)}</a>
        <span class="sep">/</span>
        <span class="current">${esc(d.customTitle || d.firstPrompt || d.sessionId)}</span>
      </div>

      ${d.firstPrompt ? `<div style="color:var(--text-tertiary);font-size:12px;margin-bottom:16px;font-style:italic">"${esc(d.firstPrompt)}"</div>` : ''}

      <div class="detail-header">
        <div class="detail-stat">
          <div class="detail-label">Total Cost</div>
          <div class="detail-value cost">${formatCost(d.totalCost)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Input</div>
          <div class="detail-value">${formatTokens(d.inputTokens)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Output</div>
          <div class="detail-value">${formatTokens(d.outputTokens)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Cache Created</div>
          <div class="detail-value">${formatTokens(d.cacheCreationTokens)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Cache Read</div>
          <div class="detail-value">${formatTokens(d.cacheReadTokens)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Messages</div>
          <div class="detail-value">${d.messages.length}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Models</div>
          <div class="detail-value">${d.models
            .map((m) => shortModel(m))
            .filter(Boolean)
            .join(', ')}</div>
        </div>
      </div>

      <div class="charts-row" style="margin-bottom:20px">
        <div class="chart-box">
          <div class="chart-title">Cumulative Cost</div>
          <canvas id="cumulativeChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Token Breakdown per Message</div>
          <canvas id="tokenBreakdownChart"></canvas>
        </div>
      </div>

      <div class="section-title">Messages (${d.messages.length})</div>
      <table class="messages-table">
        <thead><tr>
          <th>#</th>
          <th>Time</th>
          <th>Model</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache Cr.</th>
          <th>Cache Rd.</th>
          <th>Cost</th>
          <th>Cumulative</th>
        </tr></thead>
        <tbody>
          ${buildMessageRowsWithSubagents(d)}
        </tbody>
      </table>
    </div>`;

  requestAnimationFrame(() => {
    const parentMessages = d.messages.filter((m) => !m._subagent);
    renderCumulativeChart(parentMessages);
    renderTokenBreakdownChart(parentMessages);
  });
}

function buildMessageRowsWithSubagents(d) {
  return [...d.messages]
    .reverse()
    .map((m) => buildMessageRow(m))
    .join('');
}

function buildMessageRow(m) {
  const sa = m._subagent;
  const toolTags = !sa && m.tools ? m.tools.map((t) => `<span class="tool-tag">${esc(t)}</span>`).join(' ') : '';
  const modelCol = sa
    ? `<span class="model-badge">${esc(shortModel(m.model))}</span> <span class="subagent-tag">${esc(sa.agentType)}</span>`
    : `<span class="model-badge">${esc(shortModel(m.model))}</span>${toolTags ? ` ${toolTags}` : ''}`;
  return `<tr>
    <td class="muted">${m.index}</td>
    <td class="muted">${new Date(m.timestamp).toLocaleTimeString()}</td>
    <td>${modelCol}</td>
    <td>${formatTokens(m.inputTokens)}</td>
    <td>${formatTokens(m.outputTokens)}</td>
    <td>${formatTokens(m.cacheCreationTokens)}</td>
    <td>${formatTokens(m.cacheReadTokens)}</td>
    <td class="cost-cell">${formatCost(m.cost)}</td>
    <td class="cumulative">${formatCost(m.cumulativeCost)}</td>
  </tr>`;
}

// #endregion

// #region CHARTS

function getChartColors() {
  const style = getComputedStyle(document.body);
  return {
    accent: style.getPropertyValue('--accent').trim() || '#e86f33',
    chartFill: style.getPropertyValue('--chart-fill').trim() || 'rgba(232,111,51,0.6)',
    text: style.getPropertyValue('--text-secondary').trim() || '#c2c4c9',
    border: style.getPropertyValue('--border').trim() || '#363840',
    bg: style.getPropertyValue('--bg-elevated').trim() || '#1e2025',
    chart1: style.getPropertyValue('--chart-1').trim() || '#e86f33',
    chart2: style.getPropertyValue('--chart-2').trim() || '#60a5fa',
    chart3: style.getPropertyValue('--chart-3').trim() || '#3ecf8e',
    chart4: style.getPropertyValue('--chart-4').trim() || '#f0b429',
    chart5: style.getPropertyValue('--chart-5').trim() || '#c084fc',
    chart6: style.getPropertyValue('--chart-6').trim() || '#fb7185',
  };
}

// Translucent fill from a hex color so chart bars read as a quiet wash, not a solid block.
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function chartDefaults() {
  const c = getChartColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: c.bg,
        titleColor: c.text,
        bodyColor: c.text,
        borderColor: c.border,
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        ticks: { color: c.text, font: { size: 10 } },
        grid: { color: c.border, drawBorder: false },
      },
      y: {
        ticks: { color: c.text, font: { size: 10 } },
        grid: { color: c.border, drawBorder: false },
      },
    },
  };
}

function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

function renderCostChart(series, canvasId = 'costChart', chartKey = 'cost') {
  const points = series?.points;
  const canvas = document.getElementById(canvasId);
  if (!canvas || !points?.length) return;
  destroyChart(chartKey);

  const c = getChartColors();
  const defaults = chartDefaults();

  charts[chartKey] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: points.map((p) => bucketLabel(p.key, series.bucket)),
      datasets: [
        {
          label: costSeriesTitle(series),
          data: points.map((p) => p.cost),
          backgroundColor: c.chartFill,
          borderColor: c.accent,
          borderWidth: 1.5,
          borderRadius: 3,
        },
      ],
    },
    options: {
      ...defaults,
      interaction: { mode: 'nearest', intersect: true },
      events: [],
      plugins: {
        ...defaults.plugins,
        tooltip: {
          ...defaults.plugins.tooltip,
          callbacks: { label: (ctx) => `$${ctx.parsed.y.toFixed(2)}` },
        },
      },
      scales: {
        ...defaults.scales,
        y: {
          ...defaults.scales.y,
          ticks: { ...defaults.scales.y.ticks, callback: (v) => `$${v.toFixed(2)}` },
        },
      },
    },
  });
}

function renderModelChart(models, canvasId = 'modelChart', chartKey = 'model') {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !models?.length) return;
  destroyChart(chartKey);

  const colors = getChartColors();
  const palette = [colors.chart1, colors.chart2, colors.chart3, colors.chart4, colors.chart5, colors.chart6];
  const defaults = chartDefaults();
  const total = models.reduce((s, m) => s + m.cost, 0);

  charts[chartKey] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: models.map((m) => shortModel(m.model)),
      datasets: [
        {
          data: models.map((m) => m.cost),
          backgroundColor: models.map((_, i) => hexToRgba(palette[i % palette.length], 0.5)),
          borderColor: models.map((_, i) => palette[i % palette.length]),
          borderWidth: 1.5,
          borderRadius: 3,
        },
      ],
    },
    options: {
      ...defaults,
      indexAxis: 'y',
      interaction: { mode: 'nearest', intersect: true },
      events: [],
      plugins: {
        ...defaults.plugins,
        tooltip: {
          ...defaults.plugins.tooltip,
          callbacks: {
            label: (ctx) => {
              const val = ctx.parsed.x;
              const pct = ((val / total) * 100).toFixed(1);
              return `$${val.toFixed(2)} (${pct}%)`;
            },
          },
        },
      },
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, ticks: { ...defaults.scales.x.ticks, callback: (v) => `$${v}` } },
      },
    },
  });
}

function renderCumulativeChart(messages) {
  const canvas = document.getElementById('cumulativeChart');
  if (!canvas || !messages?.length) return;
  destroyChart('cumulative');

  const c = getChartColors();
  const defaults = chartDefaults();

  charts.cumulative = new Chart(canvas, {
    type: 'line',
    data: {
      labels: messages.map((_, i) => i + 1),
      datasets: [
        {
          label: 'Cumulative Cost',
          data: messages.map((m) => m.cumulativeCost),
          borderColor: c.accent,
          backgroundColor: c.chartFill,
          fill: true,
          borderWidth: 2,
          pointRadius: messages.length > 50 ? 0 : 3,
          pointBackgroundColor: c.accent,
          tension: 0.2,
        },
      ],
    },
    options: {
      ...defaults,
      scales: {
        ...defaults.scales,
        x: {
          ...defaults.scales.x,
          title: { display: true, text: 'Message #', color: c.text, font: { size: 10 } },
        },
        y: {
          ...defaults.scales.y,
          ticks: { ...defaults.scales.y.ticks, callback: (v) => `$${v.toFixed(2)}` },
        },
      },
    },
  });
}

function renderTokenBreakdownChart(messages) {
  const canvas = document.getElementById('tokenBreakdownChart');
  if (!canvas || !messages?.length) return;
  destroyChart('tokenBreakdown');

  const c = getChartColors();
  const defaults = chartDefaults();

  charts.tokenBreakdown = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: messages.map((_, i) => i + 1),
      datasets: [
        { label: 'Input', data: messages.map((m) => m.inputTokens), backgroundColor: c.chart1, borderRadius: 2 },
        { label: 'Output', data: messages.map((m) => m.outputTokens), backgroundColor: c.chart2, borderRadius: 2 },
        {
          label: 'Cache Create',
          data: messages.map((m) => m.cacheCreationTokens),
          backgroundColor: c.chart3,
          borderRadius: 2,
        },
        {
          label: 'Cache Read',
          data: messages.map((m) => m.cacheReadTokens),
          backgroundColor: c.chart4,
          borderRadius: 2,
        },
      ],
    },
    options: {
      ...defaults,
      plugins: {
        ...defaults.plugins,
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: c.text,
            font: { size: 10, family: "'IBM Plex Mono', monospace" },
            padding: 8,
            boxWidth: 12,
            boxHeight: 12,
          },
        },
      },
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, stacked: true },
        y: {
          ...defaults.scales.y,
          stacked: true,
          ticks: { ...defaults.scales.y.ticks, callback: (v) => formatTokens(v) },
        },
      },
    },
  });
}

// biome-ignore lint/correctness/noUnusedVariables: called from theme toggle
function destroyAllCharts() {
  for (const id of Object.keys(charts)) {
    destroyChart(id);
  }
}

// #endregion

// #region THEME

const COLOR_THEMES = [
  ['ember', 'Ember'],
  ['gruvbox', 'Gruvbox'],
  ['catppuccin', 'Catppuccin'],
  ['tokyo-night', 'Tokyo Night'],
  ['solarized', 'Solarized'],
  ['dracula', 'Dracula'],
  ['nord', 'Nord'],
  ['rose-pine', 'Rosé Pine'],
  ['everforest', 'Everforest'],
  ['kanagawa', 'Kanagawa'],
  ['one-dark', 'One Dark'],
  ['night-owl', 'Night Owl'],
  ['monokai', 'Monokai Pro'],
  ['github', 'GitHub'],
  ['ayu', 'Ayu'],
  ['vitesse', 'Vitesse'],
  ['synthwave', "Synthwave '84"],
];

function loadTheme() {
  if (localStorage.getItem('theme') === 'light') {
    document.body.classList.add('light');
  }
  buildThemeMenu();
  const colorTheme = localStorage.getItem('color-theme');
  if (colorTheme) document.body.dataset.colorTheme = colorTheme;
  syncColorThemeSelect(colorTheme || 'ember');
}

function buildThemeMenu() {
  const menu = document.getElementById('themeMenu');
  menu.innerHTML = COLOR_THEMES.map(
    ([id, label]) =>
      `<button type="button" class="theme-menu-item theme-swatch-${id}" data-theme-id="${id}"
         onclick="event.stopPropagation(); setColorTheme('${id}'); toggleThemeMenu()">
         <span class="theme-swatch theme-swatch-${id}"><i class="sw-bg"></i><i class="sw-accent"></i><i class="sw-ink"></i></span>${label}
       </button>`,
  ).join('');
}

// biome-ignore lint/correctness/noUnusedVariables: called from topbar markup
function toggleThemeMenu(e) {
  e?.stopPropagation();
  const menu = document.getElementById('themeMenu');
  const open = menu.classList.toggle('open');
  if (open) {
    document.addEventListener('click', () => menu.classList.remove('open'), { once: true });
  }
}

function syncColorThemeSelect(id) {
  document.querySelectorAll('.theme-menu-item').forEach((el) => {
    el.classList.toggle('on', el.dataset.themeId === (id || 'ember'));
  });
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  lastRenderHash = {};
  renderCurrentView();
}

// 'ember' (the :root default) has no override block — selecting it clears the attribute.
function setColorTheme(id) {
  if (!id || id === 'ember') {
    delete document.body.dataset.colorTheme;
    localStorage.removeItem('color-theme');
  } else {
    document.body.dataset.colorTheme = id;
    localStorage.setItem('color-theme', id);
  }
  syncColorThemeSelect(id);
  lastRenderHash = {};
  renderCurrentView();
}

// #endregion

// #region ROUTER

function setActiveNav(view) {
  document.querySelectorAll('.topbar-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById(viewId);
  if (el) el.classList.add('active');
}

async function navigate(view, params) {
  currentView = view;
  if (params?.project) currentProjectPath = params.project;
  if (params?.projectName) currentProjectName = params.projectName;
  if (params?.session) currentSessionId = params.session;

  // Clear downstream state
  if (view === 'overview' || view === 'projects') {
    currentProjectPath = null;
    currentProjectName = null;
    currentSessionId = null;
  }
  if (view === 'sessions') {
    currentSessionId = null;
  }

  const navView = view === 'sessions' || view === 'detail' ? parentView : view;
  setActiveNav(navView);
  updateUrl();
  await loadAndRender(view);
  if (view !== 'detail') selectRow(0);
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
async function navigateToSessions(encodedPath, name) {
  if (currentView === 'overview' || currentView === 'projects') {
    parentView = currentView;
  }
  lastSelectedProject = encodedPath;
  currentProjectPath = encodedPath;
  currentProjectName = name;
  await navigate('sessions', { project: encodedPath, projectName: name });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
async function navigateToDetail(sessionId) {
  lastSelectedSession = sessionId;
  currentSessionId = sessionId;
  await navigate('detail', { session: sessionId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function sortBy(field) {
  const s = currentSort();
  if (s.field === field) {
    s.order = s.order === 'desc' ? 'asc' : 'desc';
  } else {
    s.field = field;
    s.order = 'desc';
  }
  lastRenderHash[currentView] = null;
  saveSort();
  updateUrl();
  if (currentView === 'overview') renderOverview();
  else if (currentView === 'sessions') renderSessions();
  else renderProjects();
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onchange
async function onRangeChange(val) {
  dateRange = val === 'today' ? 'today' : parseInt(val, 10) || 7;
  saveDateRange(dateRange);
  lastRenderHash = {};
  updateUrl();
  const t = showToast(`Recalculating for ${rangeLabel(dateRange)}...`, true);
  await loadAndRender(currentView);
  dismissToast(t);
}

function renderScopeChip() {
  const chip = document.getElementById('scopeChip');
  if (!chip) return;
  chip.hidden = !scopeProject;
  if (scopeProject) {
    document.getElementById('scopeChipName').textContent = scopeProjectName || scopeProject;
  }
}

// Assigns before the first await (the lastTheme echo-suppression idiom), so the hub's
// per-iframe-load replay of the same project is absorbed for free.
async function applyScope(encoded, name) {
  if (encoded === scopeProject) return;
  scopeProject = encoded || null;
  scopeProjectName = encoded ? name || encoded : null;
  saveScope();
  lastRenderHash = {};
  renderScopeChip();

  if (!scopeProject) {
    // Clearing drops the cursor too — it was the scope, and there is nothing left to drill into.
    await navigate('overview');
    return;
  }
  // A scope means "show me this project", so land on its sessions rather than a one-row
  // overview. Null the stale payloads first so the loading state shows, not the old project's
  // rows.
  sessionsData = null;
  sessionDetailData = null;
  parentView = 'overview';
  await navigate('sessions', { project: scopeProject, projectName: scopeProjectName });
}

// Scope teardown without applyScope's landing rule, for callers that navigate themselves.
function dropScope() {
  if (!scopeProject) return;
  scopeProject = null;
  scopeProjectName = null;
  saveScope();
  lastRenderHash = {};
  renderScopeChip();
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
async function clearScope() {
  // No redirect when clearing: the cursor is still a valid drill-down.
  await applyScope(null, null);
}

async function refreshData() {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  const t = showToast(`Recalculating for ${rangeLabel(dateRange)}...`, true);
  const minWait = new Promise((r) => setTimeout(r, 250));
  try {
    await fetch('/api/refresh', { method: 'POST' });
    clearLocalCache();
    forceRefresh = true;
    lastRenderHash = {};
    await loadAndRender(currentView);
    forceRefresh = false;
    await minWait;
    showToast('Data refreshed', false, 'success');
  } finally {
    dismissToast(t);
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

async function loadAndRender(view) {
  const myNav = ++navCounter;
  const prevSelectedIdx = selectedRowIdx;
  ensureViewElements();
  showView(`${view}-view`);

  const viewEl = document.getElementById(`${view}-view`);
  if (viewEl) {
    const hasContent = viewEl.querySelector('.dashboard-content');
    if (!hasContent) {
      viewEl.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
    }
  }

  try {
    switch (view) {
      case 'overview':
        await fetchOverview();
        if (myNav !== navCounter) return;
        renderOverview();
        break;
      case 'projects':
        await fetchProjects();
        if (myNav !== navCounter) return;
        renderProjects();
        break;
      case 'sessions':
        if (currentProjectPath) {
          if (!sessionsData) {
            lastRenderHash.sessions = null;
            renderSessions();
          }
          await fetchSessions(currentProjectPath);
          if (myNav !== navCounter) return;
          renderSessions();
        }
        break;
      case 'detail':
        if (currentSessionId) {
          if (!sessionDetailData) {
            lastRenderHash.detail = null;
            renderDetail();
          }
          await fetchSessionDetail(currentSessionId);
          if (myNav !== navCounter) return;
          renderDetail();
        }
        break;
    }
    if (prevSelectedIdx >= 0) selectRow(prevSelectedIdx);
  } catch (err) {
    if (myNav !== navCounter) return;
    console.error(`Failed to load ${view}:`, err);
    showToast(`Error: ${err.message}`);
    const viewEl = document.getElementById(`${view}-view`);
    if (viewEl) viewEl.innerHTML = `<div class="loading-state"><span>Failed to load data: ${err.message}</span></div>`;
  }
}

function renderCurrentView() {
  loadAndRender(currentView);
}

function ensureViewElements() {
  const app = document.getElementById('app');
  if (!app) return;
  const views = ['overview', 'projects', 'sessions', 'detail'];
  for (const v of views) {
    if (!document.getElementById(`${v}-view`)) {
      const div = document.createElement('div');
      div.id = `${v}-view`;
      div.className = 'view';
      app.appendChild(div);
    }
  }
  // Remove initial loading state
  const ls = document.getElementById('loadingState');
  if (ls) ls.remove();
}

// #endregion

// #region MODAL

function toggleHelpModal() {
  document.getElementById('helpModal').classList.toggle('visible');
}

// #endregion

// #region KEYBOARD_SHORTCUTS

let selectedRowIdx = -1;

function getVisibleRows() {
  const viewEl = document.getElementById(`${currentView}-view`);
  if (!viewEl) return [];
  return Array.from(viewEl.querySelectorAll('tbody tr[data-clickable]'));
}

function selectRow(idx) {
  const rows = getVisibleRows();
  rows.forEach((r) => r.classList.remove('kb-selected'));
  if (idx >= 0 && idx < rows.length) {
    selectedRowIdx = idx;
    rows[idx].classList.add('kb-selected');
    rows[idx].scrollIntoView({ block: 'nearest' });
  } else {
    selectedRowIdx = -1;
  }
}

function activateSelectedRow() {
  const rows = getVisibleRows();
  if (selectedRowIdx >= 0 && selectedRowIdx < rows.length) {
    rows[selectedRowIdx].click();
  }
}

async function goBack() {
  let target;
  if (currentView === 'detail') {
    target = currentProjectPath ? 'sessions' : parentView;
  } else if (currentView === 'sessions') {
    target = parentView;
  } else if (currentView === 'projects') {
    target = 'overview';
  }
  if (!target) return;

  if (target === 'sessions') {
    await navigate('sessions', { project: currentProjectPath, projectName: currentProjectName });
  } else {
    // Backing out to a top-level view drops the scope with the cursor: a scoped overview
    // showing one project has no visible cause once you've left that project behind.
    dropScope();
    await navigate(target);
  }
  focusPreviousRow(target);
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  const anyModal = document.querySelector('.modal-overlay.visible');
  if (anyModal) {
    if (e.key === 'Escape') {
      anyModal.classList.remove('visible');
      e.preventDefault();
    }
    return;
  }

  if (e.ctrlKey || e.altKey || e.metaKey) return;

  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    toggleHelpModal();
    return;
  }

  if (e.key === '1') {
    e.preventDefault();
    navigate('overview');
    return;
  }
  if (e.key === '2') {
    e.preventDefault();
    navigate('projects');
    return;
  }

  if (e.key === 'r') {
    e.preventDefault();
    refreshData();
    return;
  }
  if (e.key === 't') {
    e.preventDefault();
    toggleTheme();
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    goBack();
    return;
  }
  if (e.key === 'Backspace') {
    e.preventDefault();
    goBack();
    return;
  }

  // Table navigation
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    const rows = getVisibleRows();
    if (rows.length) selectRow(Math.min(selectedRowIdx + 1, rows.length - 1));
    return;
  }
  if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = getVisibleRows();
    if (rows.length) selectRow(Math.max(selectedRowIdx - 1, 0));
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activateSelectedRow();
    return;
  }
});

// #endregion

// #region TOAST

function showToast(msg, persistent, type) {
  const container = document.getElementById('toast');
  if (!container) return;
  const el = document.createElement('div');
  el.className = type ? `toast toast-${type}` : 'toast';
  el.textContent = msg;
  container.appendChild(el);
  if (!persistent) setTimeout(() => el.remove(), 3000);
  return el;
}

function dismissToast(el) {
  if (el) el.remove();
}

// #endregion

// #region AUTO_REFRESH

// Whether cost is the app the user is looking at. document.hidden alone can't answer that inside
// the hub: the hub hides inactive apps with display:none, and a nested document's visibilityState
// mirrors the top-level tab regardless. So the hub tells us (hub:active); standalone stays true.
let hubActive = true;
const STALE_CHECK_MS = 30_000;
// Three triggers share refreshIfStale (interval, visibilitychange, hub:active), so they'd otherwise
// overlap and the first one's finally would clear forceRefresh out from under the others.
let refreshing = false;

function isAppActive() {
  return !document.hidden && hubActive;
}

async function refreshIfStale() {
  if (refreshing || !isAppActive()) return;
  if (Date.now() - dataFetchedAt < BROWSER_CACHE_TTL) return;
  // No clearLocalCache() unlike refreshData: forceRefresh already bypasses the cache read, and the
  // fresh payloads overwrite their own keys. Views the user isn't on keep their cache.
  refreshing = true;
  forceRefresh = true;
  try {
    await loadAndRender(currentView);
  } catch {
    /* transient — the next tick retries */
  } finally {
    forceRefresh = false;
    refreshing = false;
  }
}

(function initAutoRefresh() {
  // Polled rather than a 5-min timer: staleness also has to be re-evaluated the moment the app
  // becomes active again, and a single clock keeps the two paths from racing.
  setInterval(refreshIfStale, STALE_CHECK_MS);
  document.addEventListener('visibilitychange', refreshIfStale);
})();

// #endregion

// #region HUB_INTEGRATION

(async function initHub() {
  const cfg = await fetch('/hub-config')
    .then((r) => r.json())
    .catch(() => ({}));
  if (!cfg.enabled) return;

  window.__HUB__ = cfg;

  document.addEventListener('keydown', (e) => {
    const fwd = (key) => {
      e.preventDefault();
      hubPost({ type: 'hub:keydown', key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
    };
    if (e.ctrlKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      fwd(e.key);
    }
    // Its own branch: the Alt+digit case below requires !ctrlKey.
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'p') {
      fwd(e.key);
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      fwd(e.key);
    }
  });
})();

// Hoisted out of initHubTheme so initHubProject can share it.
const hubOrigin = () => (window.__HUB__?.url ? new URL(window.__HUB__.url).origin : null);

// Every send is addressed to the hub explicitly. With targetOrigin '*' any page that
// framed this app also received the forwarded keystrokes and navigation intents.
function hubPost(message) {
  const origin = hubOrigin();
  if (origin) window.parent?.postMessage(message, origin);
}

window.hubNavigate = function hubNavigate(app, url) {
  if (!window.__HUB__?.enabled) return;
  hubPost({ type: 'hub:navigate', app, url });
};

(function initHubTheme() {
  const getTheme = () => (document.body.classList.contains('light') ? 'light' : 'dark');
  const getColorTheme = () => document.body.dataset.colorTheme || 'ember';
  // lastTheme/lastColorTheme are updated synchronously when applying a hub
  // message, so the (async) observer sees no diff and doesn't echo it back.
  let lastTheme = getTheme();
  let lastColorTheme = getColorTheme();
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== hubOrigin()) return;
    if (e.data?.type !== 'hub:theme') return;
    if (typeof e.data.colorTheme === 'string' && e.data.colorTheme !== getColorTheme()) {
      setColorTheme(e.data.colorTheme);
      lastColorTheme = getColorTheme();
    }
    if (getTheme() !== e.data.theme) {
      window.toggleTheme();
      lastTheme = getTheme();
    }
  });
  new MutationObserver(() => {
    const t = getTheme();
    const ct = getColorTheme();
    if (t === lastTheme && ct === lastColorTheme) return;
    lastTheme = t;
    lastColorTheme = ct;
    hubPost({ type: 'hub:theme', theme: t, colorTheme: ct });
  }).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-color-theme'],
  });
})();

(function initHubActive() {
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== hubOrigin()) return;
    if (e.data?.type !== 'hub:active') return;
    hubActive = !!e.data.active;
    // Becoming active is the main refresh trigger — the interval only covers staying active.
    if (hubActive) refreshIfStale();
  });
})();

(function initHubProject() {
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== hubOrigin()) return;
    if (e.data?.type !== 'hub:project') return;
    // The hub owns the abs->encoded transform, so cost never converts anything itself.
    const encoded = e.data.encoded;
    if (typeof encoded !== 'string' || !encoded) return;
    applyScope(encoded, e.data.name);
  });
})();

// #endregion

// #region INIT

loadTheme();
loadSort();

document.addEventListener('click', async (e) => {
  if (e.target.matches('.parent-breadcrumb')) {
    const target = parentView;
    await navigate(target);
    focusPreviousRow(target);
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  const state = getUrlState();
  dateRange = loadDateRange();
  document.getElementById('rangeSelect').value = dateRange;

  // Resolve the scope before any navigate() so the first /api/overview already carries
  // &project=. Read window.location.search directly, not getUrlState() — that falls back to
  // sessionStorage['cc-cost:nav'] when the URL has no view/session/project, which would
  // discard a scope-only URL.
  loadScope();
  const urlScope = new URLSearchParams(window.location.search).get('scope');
  if (urlScope) {
    scopeProject = urlScope;
    scopeProjectName = urlScope;
    saveScope();
  }
  renderScopeChip();
  // A ?scope= deep link carries only the encoded dir name; the hub always sends a real one.
  if (scopeProject && scopeProjectName === scopeProject) resolveScopeName();

  if (state.session) {
    currentSessionId = state.session;
    parentView = state.parentView;
    currentProjectPath = state.project;
    currentProjectName = state.projectName;
    await navigate('detail', { session: state.session });
  } else if (state.project) {
    parentView = state.parentView;
    currentProjectPath = state.project;
    currentProjectName = state.projectName;
    await navigate('sessions', { project: state.project, projectName: state.projectName });
  } else if (state.view === 'projects') {
    await navigate('projects');
  } else if (scopeProject) {
    // Same landing rule as applyScope: a scope with no cursor of its own opens its sessions.
    parentView = 'overview';
    currentProjectName = scopeProjectName;
    await navigate('sessions', { project: scopeProject, projectName: scopeProjectName });
  } else {
    await navigate('overview');
  }
});

window.addEventListener('popstate', () => {
  const state = getUrlState();
  currentView = state.view || 'overview';
  parentView = state.parentView;
  currentProjectPath = state.project;
  currentProjectName = state.projectName;
  currentSessionId = state.session;
  lastRenderHash = {};
  loadAndRender(currentView);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// #endregion
