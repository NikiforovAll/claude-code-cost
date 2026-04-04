// #region STATE

let currentView = 'overview';
let overviewData = null;
let projectsData = null;
let sessionsData = null;
let sessionDetailData = null;
let currentProjectPath = null;
let currentProjectName = null;
let currentSessionId = null;
let sortField = 'totalCost';
let sortOrder = 'desc';
let dateRange = 7;
let charts = {};
let lastRenderHash = {};
let navCounter = 0;

// #endregion

// #region UTILS

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatCost(usd) {
  if (usd == null || usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd >= 100) return '$' + usd.toFixed(0);
  return '$' + usd.toFixed(2);
}

function formatTokens(count) {
  if (!count) return '0';
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M';
  if (count >= 1_000) return (count / 1_000).toFixed(1) + 'K';
  return count.toString();
}

function formatDuration(minutes) {
  if (!minutes || minutes < 1) return '<1m';
  if (minutes < 60) return minutes + 'm';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function shortDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function shortModel(model) {
  if (!model) return 'unknown';
  return model
    .replace('anthropic/', '')
    .replace(/-\d{8}$/, '')
    .replace('claude-', 'c-');
}

function hash(data) {
  return JSON.stringify(data);
}

// #endregion

// #region URL_STATE

function getUrlState() {
  const p = new URLSearchParams(window.location.search);
  return {
    view: p.get('view') || 'overview',
    project: p.get('project'),
    projectName: p.get('projectName'),
    session: p.get('session'),
    sort: p.get('sort'),
    order: p.get('order'),
  };
}

function loadDateRange() {
  const v = localStorage.getItem('cc-cost:range');
  return v ? parseInt(v) || 7 : 7;
}

function saveDateRange(val) {
  localStorage.setItem('cc-cost:range', String(val));
}

function updateUrl() {
  const p = new URLSearchParams();
  if (currentView !== 'overview') p.set('view', currentView);
  if (currentProjectPath) p.set('project', currentProjectPath);
  if (currentProjectName) p.set('projectName', currentProjectName);
  if (currentSessionId) p.set('session', currentSessionId);
  if (sortField !== 'totalCost') p.set('sort', sortField);
  if (sortOrder !== 'desc') p.set('order', sortOrder);
  const qs = p.toString();
  history.replaceState(null, '', qs ? '?' + qs : '/');
}

// #endregion

// #region FETCH

const BROWSER_CACHE_TTL = 5 * 60 * 1000; // 5 min
const CACHE_VERSION = 3;
let forceRefresh = false;

function getCached(key) {
  if (forceRefresh) return null;
  try {
    const raw = localStorage.getItem('cc-cost:' + key);
    if (!raw) return null;
    const { data, ts, v } = JSON.parse(raw);
    if (v !== CACHE_VERSION || Date.now() - ts > BROWSER_CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function setLocalCache(key, data) {
  try {
    pruneLocalCache();
    localStorage.setItem('cc-cost:' + key, JSON.stringify({ data, ts: Date.now(), v: CACHE_VERSION }));
  } catch { /* storage full — ignore */ }
}

function pruneLocalCache() {
  const MAX_ENTRIES = 20;
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k.startsWith('cc-cost:')) continue;
    try {
      const { ts } = JSON.parse(localStorage.getItem(k));
      entries.push({ k, ts });
    } catch { entries.push({ k, ts: 0 }); }
  }
  if (entries.length <= MAX_ENTRIES) return;
  entries.sort((a, b) => a.ts - b.ts);
  const toRemove = entries.length - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) localStorage.removeItem(entries[i].k);
}

function clearLocalCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('cc-cost:')) keys.push(k);
  }
  keys.forEach(k => localStorage.removeItem(k));
}

async function fetchJSON(url, skipCache) {
  if (!skipCache) {
    const cached = getCached(url);
    if (cached) return cached;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!skipCache) setLocalCache(url, data);
  return data;
}

async function fetchOverview() {
  overviewData = await fetchJSON(`/api/overview?range=${dateRange}`);
}

async function fetchProjects() {
  projectsData = await fetchJSON(`/api/projects?range=${dateRange}`);
}

async function fetchSessions(encodedPath) {
  sessionsData = await fetchJSON(`/api/projects/${encodeURIComponent(encodedPath)}/sessions?range=${dateRange}`, true);
}

async function fetchSessionDetail(sessionId) {
  sessionDetailData = await fetchJSON(`/api/sessions/${encodeURIComponent(sessionId)}`, true);
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
  const h = hash({ overviewData, sortField, sortOrder });
  if (lastRenderHash.overview === h) return;
  lastRenderHash.overview = h;

  const daily = overviewData.daily || [];
  const models = overviewData.modelDistribution || [];

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="cards-row">
        <div class="stat-card">
          <div class="card-label">Today</div>
          <div class="card-value cost">${formatCost(s.todayCost)}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">${dateRange} Days</div>
          <div class="card-value cost">${formatCost(s.totalCost)}</div>
        </div>
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
          <div class="chart-title">Daily Cost</div>
          <canvas id="dailyChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Cost by Model</div>
          <canvas id="modelChart"></canvas>
        </div>
      </div>

      ${overviewData.projects?.length ? `
      <div class="section-title">Projects</div>
      <table class="data-table">
        <thead><tr>
          <th class="${sortField === 'name' ? 'sorted' : ''}" onclick="sortBy('name')">Project ${sortField === 'name' ? (sortOrder === 'asc' ? '\u25B2' : '\u25BC') : ''}</th>
          <th class="${sortField === 'totalCost' ? 'sorted' : ''}" onclick="sortBy('totalCost')">Cost ${sortField === 'totalCost' ? (sortOrder === 'asc' ? '\u25B2' : '\u25BC') : ''}</th>
          <th class="${sortField === 'sessionCount' ? 'sorted' : ''}" onclick="sortBy('sessionCount')">Sessions ${sortField === 'sessionCount' ? (sortOrder === 'asc' ? '\u25B2' : '\u25BC') : ''}</th>
          <th class="${sortField === 'lastActive' ? 'sorted' : ''}" onclick="sortBy('lastActive')">Last Active ${sortField === 'lastActive' ? (sortOrder === 'asc' ? '\u25B2' : '\u25BC') : ''}</th>
        </tr></thead>
        <tbody>
          ${[...overviewData.projects].sort((a, b) => {
            let va = a[sortField], vb = b[sortField];
            if (typeof va === 'string') va = va.toLowerCase();
            if (typeof vb === 'string') vb = vb.toLowerCase();
            if (va < vb) return sortOrder === 'asc' ? -1 : 1;
            if (va > vb) return sortOrder === 'asc' ? 1 : -1;
            return 0;
          }).map(p => `
            <tr onclick="navigateToSessions('${esc(p.encodedPath)}', '${esc(p.name)}')">
              <td>${esc(p.name)}</td>
              <td class="cost-cell">${formatCost(p.totalCost)}</td>
              <td>${p.sessionCount}</td>
              <td class="muted">${timeAgo(p.lastActive)}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}
    </div>`;

  // Render charts after DOM is ready
  requestAnimationFrame(() => {
    renderDailyChart(daily);
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

  const h = hash({ projectsData, sortField, sortOrder });
  if (lastRenderHash.projects === h) return;
  lastRenderHash.projects = h;

  const sorted = [...projectsData].sort((a, b) => {
    let va = a[sortField], vb = b[sortField];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return sortOrder === 'asc' ? -1 : 1;
    if (va > vb) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  function sortArrow(field) {
    if (sortField !== field) return '';
    return `<span class="sort-arrow">${sortOrder === 'asc' ? '\u25B2' : '\u25BC'}</span>`;
  }

  function thClass(field) {
    return sortField === field ? 'sorted' : '';
  }

  if (sorted.length === 0) {
    el.innerHTML = `<div class="dashboard-content"><div class="empty-state">
      <div class="empty-icon">$</div>
      <div>No project data found</div>
      <div>Make sure Claude Code session files exist in ~/.claude/projects/</div>
    </div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="section-title">All Projects</div>
      <table class="data-table">
        <thead><tr>
          <th class="${thClass('name')}" onclick="sortBy('name')">Project ${sortArrow('name')}</th>
          <th class="${thClass('totalCost')}" onclick="sortBy('totalCost')">Cost ${sortArrow('totalCost')}</th>
          <th class="${thClass('sessionCount')}" onclick="sortBy('sessionCount')">Sessions ${sortArrow('sessionCount')}</th>
          <th class="${thClass('lastActive')}" onclick="sortBy('lastActive')">Last Active ${sortArrow('lastActive')}</th>
          <th>Model</th>
        </tr></thead>
        <tbody>
          ${sorted.map(p => `
            <tr onclick="navigateToSessions('${esc(p.encodedPath)}', '${esc(p.name)}')">
              <td>${esc(p.name)}</td>
              <td class="cost-cell">${formatCost(p.totalCost)}</td>
              <td>${p.sessionCount}</td>
              <td class="muted">${timeAgo(p.lastActive)}</td>
              <td><span class="model-badge">${esc(shortModel(p.primaryModel))}</span></td>
            </tr>`).join('')}
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

  const h = hash(sessionsData);
  if (lastRenderHash.sessions === h) return;
  lastRenderHash.sessions = h;

  if (sessionsData.length === 0) {
    el.innerHTML = `<div class="dashboard-content">
      <div class="breadcrumb">
        <a onclick="navigate('overview')">Overview</a>
        <span class="sep">/</span>
        <a onclick="navigate('projects')">Projects</a>
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
        <a onclick="navigate('overview')">Overview</a>
        <span class="sep">/</span>
        <a onclick="navigate('projects')">Projects</a>
        <span class="sep">/</span>
        <span class="current">${esc(currentProjectName || 'Project')}</span>
      </div>
      <table class="data-table">
        <thead><tr>
          <th>Session</th>
          <th>Cost</th>
          <th>Tokens</th>
          <th>Messages</th>
          <th>Duration</th>
          <th>Model</th>
          <th>Last Active</th>
        </tr></thead>
        <tbody>
          ${sessionsData.map(s => `
            <tr onclick="navigateToDetail('${esc(s.sessionId)}')">
              <td class="truncate" title="${esc(s.firstPrompt || s.sessionId)}">${esc(s.firstPrompt || s.sessionId.slice(0, 8) + '...')}</td>
              <td class="cost-cell">${formatCost(s.totalCost)}</td>
              <td>${formatTokens(s.totalTokens)}</td>
              <td>${s.messageCount}</td>
              <td class="muted">${formatDuration(s.durationMinutes)}</td>
              <td><span class="model-badge">${esc(shortModel(s.primaryModel))}</span></td>
              <td class="muted">${timeAgo(s.lastTimestamp)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
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
  const h = hash(d);
  if (lastRenderHash.detail === h) return;
  lastRenderHash.detail = h;

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="breadcrumb">
        <a onclick="navigate('overview')">Overview</a>
        <span class="sep">/</span>
        <a onclick="navigate('projects')">Projects</a>
        <span class="sep">/</span>
        <a onclick="navigateToSessions('${esc(d.encodedProjectPath)}', '${esc(d.projectPath)}')">${esc(d.projectPath)}</a>
        <span class="sep">/</span>
        <span class="current">${esc(d.sessionId.slice(0, 12))}...</span>
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
          <div class="detail-value">${d.models.map(m => shortModel(m)).join(', ')}</div>
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
          ${[...d.messages].reverse().map((m) => `
            <tr>
              <td class="muted">${m.index}</td>
              <td class="muted">${new Date(m.timestamp).toLocaleTimeString()}</td>
              <td><span class="model-badge">${esc(shortModel(m.model))}</span></td>
              <td>${formatTokens(m.inputTokens)}</td>
              <td>${formatTokens(m.outputTokens)}</td>
              <td>${formatTokens(m.cacheCreationTokens)}</td>
              <td>${formatTokens(m.cacheReadTokens)}</td>
              <td class="cost-cell">${formatCost(m.cost)}</td>
              <td class="cumulative">${formatCost(m.cumulativeCost)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  requestAnimationFrame(() => {
    renderCumulativeChart(d.messages);
    renderTokenBreakdownChart(d.messages);
  });
}

// #endregion

// #region CHARTS

function getChartColors() {
  const style = getComputedStyle(document.body);
  return {
    accent: style.getPropertyValue('--accent').trim() || '#e86f33',
    accentDim: style.getPropertyValue('--accent-dim').trim() || 'rgba(232,111,51,0.22)',
    text: style.getPropertyValue('--text-muted').trim() || '#7d808a',
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

function renderDailyChart(daily) {
  const canvas = document.getElementById('dailyChart');
  if (!canvas || !daily?.length) return;
  destroyChart('daily');

  const c = getChartColors();
  const labels = daily.map(d => shortDate(d.date));
  const data = daily.map(d => d.cost);

  charts.daily = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Daily Cost',
        data,
        backgroundColor: c.accentDim,
        borderColor: c.accent,
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      ...chartDefaults(),
      interaction: { mode: 'nearest', intersect: true },
      events: [],
      plugins: {
        ...chartDefaults().plugins,
        tooltip: {
          ...chartDefaults().plugins.tooltip,
          callbacks: {
            label: (ctx) => `$${ctx.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        ...chartDefaults().scales,
        y: { ...chartDefaults().scales.y, ticks: { ...chartDefaults().scales.y.ticks, callback: v => '$' + v.toFixed(2) } },
      },
    },
  });
}

function renderModelChart(models) {
  const canvas = document.getElementById('modelChart');
  if (!canvas || !models?.length) return;
  destroyChart('model');

  const colors = getChartColors();
  const palette = [colors.chart1, colors.chart2, colors.chart3, colors.chart4, colors.chart5, colors.chart6];

  const total = models.reduce((s, m) => s + m.cost, 0);

  charts.model = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: models.map(m => shortModel(m.model)),
      datasets: [{
        data: models.map(m => m.cost),
        backgroundColor: models.map((_, i) => palette[i % palette.length]),
        borderWidth: 0,
        borderRadius: 3,
      }],
    },
    options: {
      ...chartDefaults(),
      indexAxis: 'y',
      interaction: { mode: 'nearest', intersect: true },
      events: [],
      plugins: {
        ...chartDefaults().plugins,
        tooltip: {
          ...chartDefaults().plugins.tooltip,
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
        ...chartDefaults().scales,
        x: { ...chartDefaults().scales.x, ticks: { ...chartDefaults().scales.x.ticks, callback: v => '$' + v } },
      },
    },
  });
}

function renderCumulativeChart(messages) {
  const canvas = document.getElementById('cumulativeChart');
  if (!canvas || !messages?.length) return;
  destroyChart('cumulative');

  const c = getChartColors();

  charts.cumulative = new Chart(canvas, {
    type: 'line',
    data: {
      labels: messages.map((_, i) => i + 1),
      datasets: [{
        label: 'Cumulative Cost',
        data: messages.map(m => m.cumulativeCost),
        borderColor: c.accent,
        backgroundColor: c.accentDim,
        fill: true,
        borderWidth: 2,
        pointRadius: messages.length > 50 ? 0 : 3,
        pointBackgroundColor: c.accent,
        tension: 0.2,
      }],
    },
    options: {
      ...chartDefaults(),
      scales: {
        ...chartDefaults().scales,
        x: { ...chartDefaults().scales.x, title: { display: true, text: 'Message #', color: c.text, font: { size: 10 } } },
        y: { ...chartDefaults().scales.y, ticks: { ...chartDefaults().scales.y.ticks, callback: v => '$' + v.toFixed(2) } },
      },
    },
  });
}

function renderTokenBreakdownChart(messages) {
  const canvas = document.getElementById('tokenBreakdownChart');
  if (!canvas || !messages?.length) return;
  destroyChart('tokenBreakdown');

  const c = getChartColors();
  const labels = messages.map((_, i) => i + 1);

  charts.tokenBreakdown = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Input', data: messages.map(m => m.inputTokens), backgroundColor: c.chart1, borderRadius: 2 },
        { label: 'Output', data: messages.map(m => m.outputTokens), backgroundColor: c.chart2, borderRadius: 2 },
        { label: 'Cache Create', data: messages.map(m => m.cacheCreationTokens), backgroundColor: c.chart3, borderRadius: 2 },
        { label: 'Cache Read', data: messages.map(m => m.cacheReadTokens), backgroundColor: c.chart4, borderRadius: 2 },
      ],
    },
    options: {
      ...chartDefaults(),
      plugins: {
        ...chartDefaults().plugins,
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
        ...chartDefaults().scales,
        x: { ...chartDefaults().scales.x, stacked: true },
        y: { ...chartDefaults().scales.y, stacked: true, ticks: { ...chartDefaults().scales.y.ticks, callback: v => formatTokens(v) } },
      },
    },
  });
}

function destroyAllCharts() {
  for (const id of Object.keys(charts)) {
    destroyChart(id);
  }
}

// #endregion

// #region THEME

function isLightTheme() {
  return document.body.classList.contains('light');
}

function loadTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.body.classList.add('light');
    document.body.classList.remove('dark-forced');
  } else if (saved === 'dark') {
    document.body.classList.remove('light');
    document.body.classList.add('dark-forced');
  }
}

function toggleTheme() {
  const wasLight = isLightTheme();
  if (wasLight) {
    document.body.classList.remove('light');
    document.body.classList.add('dark-forced');
    localStorage.setItem('theme', 'dark');
  } else {
    document.body.classList.add('light');
    document.body.classList.remove('dark-forced');
    localStorage.setItem('theme', 'light');
  }
  // Re-render charts with new theme colors
  lastRenderHash = {};
  renderCurrentView();
}

// #endregion

// #region ROUTER

function setActiveNav(view) {
  document.querySelectorAll('.topbar-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
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

  const navView = (view === 'sessions' || view === 'detail') ? 'projects' : view;
  setActiveNav(navView);
  updateUrl();
  await loadAndRender(view);
}

async function navigateToSessions(encodedPath, name) {
  currentProjectPath = encodedPath;
  currentProjectName = name;
  await navigate('sessions', { project: encodedPath, projectName: name });
}

async function navigateToDetail(sessionId) {
  currentSessionId = sessionId;
  await navigate('detail', { session: sessionId });
}

function sortBy(field) {
  if (sortField === field) {
    sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
  } else {
    sortField = field;
    sortOrder = 'desc';
  }
  lastRenderHash.projects = null;
  lastRenderHash.overview = null;
  updateUrl();
  if (currentView === 'overview') renderOverview();
  else renderProjects();
}

async function onRangeChange(val) {
  dateRange = parseInt(val) || 7;
  saveDateRange(dateRange);
  lastRenderHash = {};
  updateUrl();
  const t = showToast(`Recalculating for ${dateRange} days...`, true);
  await loadAndRender(currentView);
  dismissToast(t);
}

async function refreshData() {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  const t = showToast(`Recalculating for ${dateRange} days...`, true);
  try {
    await fetch('/api/refresh', { method: 'POST' });
    clearLocalCache();
    forceRefresh = true;
    lastRenderHash = {};
    await loadAndRender(currentView);
    forceRefresh = false;
  } finally {
    dismissToast(t);
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

async function loadAndRender(view) {
  const myNav = ++navCounter;
  ensureViewElements();
  showView(view + '-view');

  const viewEl = document.getElementById(view + '-view');
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
          sessionsData = null;
          renderSessions();
          await fetchSessions(currentProjectPath);
          if (myNav !== navCounter) return;
          renderSessions();
        }
        break;
      case 'detail':
        if (currentSessionId) {
          sessionDetailData = null;
          renderDetail();
          await fetchSessionDetail(currentSessionId);
          if (myNav !== navCounter) return;
          renderDetail();
        }
        break;
    }
  } catch (err) {
    if (myNav !== navCounter) return;
    console.error(`Failed to load ${view}:`, err);
    showToast(`Error: ${err.message}`);
    const viewEl = document.getElementById(view + '-view');
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
    if (!document.getElementById(v + '-view')) {
      const div = document.createElement('div');
      div.id = v + '-view';
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

function toggleInfoModal() {
  const modal = document.getElementById('infoModal');
  modal.classList.toggle('visible');
}

// #endregion

// #region TOAST

function showToast(msg, persistent) {
  const container = document.getElementById('toast');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  if (!persistent) setTimeout(() => el.remove(), 3000);
  return el;
}

function dismissToast(el) {
  if (el) el.remove();
}

// #endregion

// #region HUB_INTEGRATION

(async function initHub() {
  const cfg = await fetch('/hub-config').then(r => r.json()).catch(() => ({}));
  if (!cfg.enabled) return;

  window.__HUB__ = cfg;

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      window.parent?.postMessage({ type: 'hub:keydown', key: e.key }, '*');
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      window.parent?.postMessage({ type: 'hub:keydown', key: e.key }, '*');
    }
  });
})();

window.hubNavigate = function hubNavigate(app, url) {
  if (!window.__HUB__?.enabled) return;
  window.parent?.postMessage({ type: 'hub:navigate', app, url }, '*');
};

// #endregion

// #region INIT

loadTheme();

document.addEventListener('DOMContentLoaded', async () => {
  const state = getUrlState();
  dateRange = loadDateRange();
  document.getElementById('rangeSelect').value = dateRange;

  if (state.sort) sortField = state.sort;
  if (state.order) sortOrder = state.order;

  if (state.session) {
    currentSessionId = state.session;
    currentProjectPath = state.project;
    currentProjectName = state.projectName;
    await navigate('detail', { session: state.session });
  } else if (state.project) {
    currentProjectPath = state.project;
    currentProjectName = state.projectName;
    await navigate('sessions', { project: state.project, projectName: state.projectName });
  } else if (state.view === 'projects') {
    await navigate('projects');
  } else {
    await navigate('overview');
  }
});

window.addEventListener('popstate', () => {
  const state = getUrlState();
  currentView = state.view || 'overview';
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
