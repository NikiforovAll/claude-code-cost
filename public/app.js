// #region STATE

let currentView = 'overview';
let overviewData = null;
let insightsData = null;
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
let lastSelectedProject = null;
let lastSelectedSession = null;
const DEFAULT_SORT = {
  overview: { field: 'totalCost', order: 'desc' },
  sessions: { field: 'lastTimestamp', order: 'desc' },
};
const viewSort = structuredClone(DEFAULT_SORT);
// A tagged union: a rolling preset the server recomputes per request, or a concrete window of
// two local dates. Persisted as JSON under cc-cost:range (see loadDateRange).
let dateRange = { kind: 'preset', value: '3' };
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

function formatPct(part, total) {
  return total > 0 ? ((part / total) * 100).toFixed(1) : '0.0';
}

// Intl puts U+202F before AM/PM, which reads as a stray gap in the mono font. Every
// locale format that can emit an hour goes through here so the strip cannot drift.
function stripNarrowSpace(str) {
  return str.replace(/\u202f/g, ' ');
}

function localTime(iso, opts) {
  return stripNarrowSpace(new Date(iso).toLocaleTimeString(undefined, opts));
}

// One meter for every share/progress card. Owns the clamp and the aria contract so a new
// call site cannot invent a sixth clamping idiom.
function meter(pct, { label = '', cls = '', ariaLabel = '' } = {}) {
  const width = Math.min(100, Math.max(0, Number(pct) || 0)).toFixed(1);
  const klass = esc(cls ? `meter ${cls}` : 'meter');
  return `<div class="${klass}" role="img" aria-label="${esc(ariaLabel)}">
    <div class="meter-track"><i style="width:${width}%"></i></div>
    ${label ? `<span class="meter-value">${esc(label)}</span>` : ''}
  </div>`;
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
    return localTime(`${key}:00:00`, { hour: 'numeric' });
  }
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Local calendar dates as YYYY-MM-DD: the shape the range API takes, comparable with < and >.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayIso() {
  return isoDate(new Date());
}

function isoParts(iso) {
  return iso.split('-').map(Number);
}

function isoShift(iso, days) {
  const [y, m, d] = isoParts(iso);
  return isoDate(new Date(y, m - 1, d + days));
}

// Inclusive, so a single day counts as 1. Midday avoids a DST shift landing on a boundary.
function isoDayCount(from, to) {
  const [ay, am, ad] = isoParts(from);
  const [by, bm, bd] = isoParts(to);
  return Math.round((new Date(by, bm - 1, bd, 12) - new Date(ay, am - 1, ad, 12)) / 86400000) + 1;
}

// "AUG 12", carrying a two-digit year only when the date falls outside the current one: "DEC 28 '25".
function isoDayLabel(iso) {
  const [y] = isoParts(iso);
  const yearTag = y === new Date().getFullYear() ? '' : ` '${String(y).slice(2)}`;
  const dayLabel = new Date(`${iso}T00:00:00`)
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    .toUpperCase();
  return `${dayLabel}${yearTag}`;
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

const PARENT_BREADCRUMB = '<a class="parent-breadcrumb">Overview</a>';

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

// Top-level view switcher shared by the two sibling views. Drill-down views (sessions, detail)
// keep their breadcrumb instead — tabs only make sense at the root.
function viewTabs(active) {
  const tab = (id, label) =>
    `<button class="view-tab${active === id ? ' on' : ''}" onclick="navigate('${id}')">${label}</button>`;
  return `<div class="view-tabs">${tab('overview', 'Overview')}${tab('insights', 'Insights')}</div>`;
}

function focusPreviousRow(view) {
  let selector;
  if (view === 'overview') {
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
  const view = p.get('view') || 'overview';
  return {
    // Old bookmarks may still say view=projects; that view is gone, overview covers it.
    view: view === 'projects' ? 'overview' : view,
    project: p.get('project'),
    projectName: p.get('projectName'),
    session: p.get('session'),
  };
}

const DEFAULT_RANGE_PRESET = '3';

function presetRange(value) {
  return { kind: 'preset', value: String(value) };
}

function presetDef(value) {
  return RANGE_PRESETS.find((p) => p.value === String(value));
}

function isPresetValue(v) {
  return !!presetDef(v);
}

function isCustomRange(r) {
  return r?.kind === 'custom';
}

// '1 DAY' is gone: under calendar semantics it would have duplicated TODAY, so the rolling day it
// used to mean is now '24h'. Without this, a stored "1" stops being a preset value and silently
// lands on the default instead of on the shortcut that kept its meaning.
function migrateStoredPreset(value) {
  const s = String(value);
  return s === '1' ? '24h' : s;
}

// Reads the JSON tagged union and the legacy bare "3" / "today" scalar that predates it: the key is
// a preference, so clearLocalCache() never evicts it and old values outlive any cache clear.
// Anything unrecognized returns null, which lands on the default preset.
function parseStoredRange(raw) {
  if (!raw) return null;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    v = raw; // the legacy bare 'today' is not valid JSON
  }
  if (v?.kind === 'custom') {
    return ISO_DATE_RE.test(v.from) && ISO_DATE_RE.test(v.to) && v.from <= v.to
      ? { kind: 'custom', from: v.from, to: v.to }
      : null;
  }
  const s = migrateStoredPreset(v?.kind === 'preset' ? v.value : v);
  return isPresetValue(s) ? presetRange(s) : null;
}

function loadDateRange() {
  return parseStoredRange(localStorage.getItem('cc-cost:range')) || presetRange(DEFAULT_RANGE_PRESET);
}

function saveDateRange(val) {
  localStorage.setItem('cc-cost:range', JSON.stringify(val));
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

// The range reaches these labels either as the client's tagged union or as the shape the server
// echoes back on the session detail payload: 'today', N days, null for all time, or a bare
// { from, to } window.
function normalizeRange(r) {
  if (r == null) return null;
  if (typeof r === 'object') {
    if (r.kind === 'preset' && isPresetValue(r.value)) return presetRange(r.value);
    if (r.from && r.to) return { kind: 'custom', from: r.from, to: r.to };
    return null;
  }
  if (isPresetValue(r)) return presetRange(r);
  // A legacy `range=1` from a bookmarked URL: the server reads it as one calendar day, which is
  // today. Without this it is a positive integer that names no preset, so it would label as
  // "all time" — the shape normalizeRange returns for something it does not recognize.
  if (String(r) === '1') return presetRange('today');
  const n = Number(r);
  return Number.isFinite(n) && n > 0 ? presetRange(n) : null;
}

// "AUG 1 - AUG 12"; a single-day window is just "AUG 12".
function rangeSpanLabel(r) {
  return r.from === r.to ? isoDayLabel(r.to) : `${isoDayLabel(r.from)} - ${isoDayLabel(r.to)}`;
}

// Every label variant is the same four-way classification of the range — all time, a custom window,
// today, a rolling preset — with one phrase per class, so only the phrasing lives in the callers:
// presets keep their rolling phrasing ("last 7 days"), while a custom window is named by its dates,
// where a "last" prefix would be nonsense. The rolling preset measured in hours must never be
// pluralized as days, and the empty-state article only fits the rolling presets.
function rangeText(r, prefix = {}) {
  const n = normalizeRange(r);
  const kind = !n ? 'all' : n.kind === 'custom' ? 'custom' : n.value === 'today' ? 'today' : 'rolling';
  const base =
    kind === 'all'
      ? 'all time'
      : kind === 'custom'
        ? rangeSpanLabel(n)
        : kind === 'today'
          ? 'today'
          : n.value === '24h'
            ? '24 hours'
            : `${n.value} days`;
  return (prefix[kind] || '') + base;
}

const rangeLabel = (r) => rangeText(r);
const rangeScopeLabel = (r) => rangeText(r, { rolling: 'last ' });
const rangeInLabel = (r) => rangeText(r, { all: 'in ', custom: 'in ', rolling: 'in the last ' });

// Uppercase, for the picker trigger: the preset's own name, or the window's dates.
const rangeTriggerLabel = (r) => {
  const n = normalizeRange(r) || presetRange(DEFAULT_RANGE_PRESET);
  if (n.kind === 'custom') return rangeSpanLabel(n);
  const def = presetDef(n.value);
  return (def ? def.label : rangeText(n)).toUpperCase();
};

// The overview's window card: "3 Days" for an N-day preset, the preset's own name for a clock preset
// ("Last 24h"), the date span for a custom window. '1 Year' is the one name that does not fit the
// card, hence cardLabel.
const rangeCardLabel = (r) => {
  const n = normalizeRange(r);
  if (!n) return 'All Time';
  if (n.kind === 'custom') return rangeSpanLabel(n);
  const def = presetDef(n.value);
  return def ? def.cardLabel || def.label : `${n.value} Days`;
};

// That card duplicates the Today card when the window is exactly today, so it is dropped instead.
function isTodayOnlyRange(r) {
  const n = normalizeRange(r);
  if (!n) return false;
  return n.kind === 'custom' ? n.from === n.to && n.to === todayIso() : n.value === 'today';
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
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : '/');
  sessionStorage.setItem('cc-cost:nav', qs);
}

// #endregion

// #region FETCH

const BROWSER_CACHE_TTL = 5 * 60 * 1000; // 5 min
const CACHE_VERSION = 6;
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

// Presets stay on the rolling `range` param, recomputed server-side; a custom window sends its two
// local dates, which take precedence over `range`. Every range-consuming fetch goes through this.
function rangeParams(r = dateRange) {
  return isCustomRange(r) ? `from=${r.from}&to=${r.to}` : `range=${encodeURIComponent(r.value)}`;
}

async function fetchOverview() {
  overviewData = await fetchJSON(`/api/overview?${rangeParams()}${scopeParam()}`);
}

async function fetchInsights() {
  insightsData = await fetchJSON(`/api/insights?${rangeParams()}${scopeParam()}`);
}

// Fire-and-forget label upgrade: /api/projects/:path/sessions carries no project name, so ask
// the scoped projects endpoint (one row) for the decoded one.
async function resolveScopeName() {
  const target = scopeProject;
  try {
    const rows = await fetchJSON(`/api/projects?${rangeParams()}${scopeParam()}`);
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

async function fetchSessions(encodedPath) {
  const data = await fetchJSON(`/api/projects/${encodeURIComponent(encodedPath)}/sessions?${rangeParams()}`, true);
  sessionsData = data.sessions;
  sessionsCostSeries = data.costSeries;
  sessionsModelDistribution = data.modelDistribution || [];
}

async function fetchSessionDetail(sessionId) {
  sessionDetailData = await fetchJSON(`/api/sessions/${encodeURIComponent(sessionId)}?${rangeParams()}`, true);
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
  // null, not 0, when nothing cacheable ran — an empty range should show no meter at all.
  const cachePct = s.totalCacheRead + s.totalCacheCreation > 0 ? s.cacheEfficiency * 100 : null;

  // Return before any chart call so no canvas is touched — there are none in this markup.
  if (scopeProject && s.totalSessions === 0) {
    el.innerHTML = `<div class="dashboard-content">
      ${viewTabs('overview')}
      ${scopeIndicator()}
      <div class="empty-state">
        <div class="empty-icon">$</div>
        <div>No usage for ${esc(scopeProjectName || scopeProject)} ${esc(rangeInLabel(dateRange))}</div>
        <div>Clear the project scope to see everything.</div>
      </div>
    </div>`;
    return;
  }

  el.innerHTML = `
    <div class="dashboard-content">
      ${viewTabs('overview')}
      ${scopeIndicator()}
      <div class="cards-row">
        ${
          // Null rather than 0 when the window ends before today: a zero here would read as
          // "nothing spent today" instead of "today is outside the selected window".
          s.todayCost == null
            ? ''
            : `
        <div class="stat-card">
          <div class="card-label">Today</div>
          <div class="card-value cost">${formatCost(s.todayCost)}</div>
        </div>`
        }
        ${
          isTodayOnlyRange(dateRange)
            ? ''
            : `
        <div class="stat-card">
          <div class="card-label">${esc(rangeCardLabel(dateRange))}</div>
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
          <div class="card-value">${cachePct == null ? '0.0' : cachePct.toFixed(1)}%</div>
          ${cachePct == null ? '' : meter(cachePct, { ariaLabel: `${cachePct.toFixed(1)}% of all input tokens were served from cache` })}
          <div class="card-sub">Read: <strong>${formatTokens(s.totalCacheRead)}</strong> / Created: ${formatTokens(s.totalCacheCreation)}</div>
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
          <th>Model</th>
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
              <td><span class="model-badge">${esc(shortModel(p.primaryModel))}</span></td>
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
    renderCostChart(costSeries, 'costChart', 'cost', models);
    renderModelChart(models);
  });
}

// #endregion

// #region RENDER_INSIGHTS

const HEATMAP_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "YYYY-MM-DD" → "Sat 22"; parsed as local parts to avoid the UTC shift of Date("YYYY-MM-DD").
function heatmapDayLabel(dateStr) {
  const [y, m, d] = isoParts(dateStr);
  return `${HEATMAP_DAYS[new Date(y, m - 1, d).getDay()]} ${d}`;
}

// Columns start at 6 AM so the typical workday sits left-of-center instead of the dead
// early-morning hours.
const HEATMAP_START_HOUR = 6;

function ampm(h) {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function buildHeatmap(hm, days, today) {
  // Post-midnight columns sit at each row's tail and read from the next calendar day — the
  // night belongs to the evening it continues, not the morning it precedes. Each row's 24
  // displayed costs are precomputed here (the last row's tail is the future: all zeros).
  const rowCosts = hm.map((row, d) => [
    ...row.slice(HEATMAP_START_HOUR),
    ...(hm[d + 1] ? hm[d + 1].slice(0, HEATMAP_START_HOUR) : new Array(HEATMAP_START_HOUR).fill(0)),
  ]);
  const max = rowCosts.reduce((m, row) => Math.max(m, ...row), 0);
  if (max === 0) return '<div class="empty-state"><div>No activity in this range</div></div>';
  const labels = days.map(heatmapDayLabel);
  const hourAt = (col) => (col + HEATMAP_START_HOUR) % 24;
  const hours = Array.from(
    { length: 24 },
    (_, col) => `<span class="hm-hour">${hourAt(col) % 3 === 0 ? ampm(hourAt(col)) : ''}</span>`,
  ).join('');
  const rows = hm
    .map((_, d) => {
      const label = labels[d];
      return `
    <div class="hm-row${days[d] === today ? ' hm-today' : ''}">
      <span class="hm-day">${label}</span>
      ${rowCosts[d]
        .map((cost, col) => {
          const h = hourAt(col);
          return `
        <span class="hm-cell" data-hm="${h < HEATMAP_START_HOUR ? (labels[d + 1] ?? label) : label}|${h}|${cost}">
          <i style="opacity:${cost > 0 ? Math.max(0.12, cost / max).toFixed(2) : 0}"></i>
        </span>`;
        })
        .join('')}
    </div>`;
    })
    .join('');
  return `<div class="heatmap">${rows}<div class="hm-row"><span class="hm-day"></span>${hours}</div></div>`;
}

// Shared floating tooltip for heatmap cells — the native title attr is too slow and unstyled.
let hmTipEl = null;
function initHeatmapTooltip() {
  if (hmTipEl) return;
  hmTipEl = document.createElement('div');
  hmTipEl.className = 'hm-tip';
  document.body.appendChild(hmTipEl);
  document.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.hm-cell[data-hm]');
    if (!cell) {
      hmTipEl.classList.remove('on');
      return;
    }
    const [day, h, cost] = cell.dataset.hm.split('|');
    hmTipEl.innerHTML = `<b>${formatCost(+cost)}</b><span>${day} ${ampm(+h)}&ndash;${ampm((+h + 1) % 24)}</span>`;
    hmTipEl.classList.add('on');
    const r = cell.getBoundingClientRect();
    const tr = hmTipEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8));
    const top = r.top - tr.height - 6;
    hmTipEl.style.left = `${left}px`;
    hmTipEl.style.top = `${top < 4 ? r.bottom + 6 : top}px`;
  });
}

// Hour-only span (e.g. "15:00–20:00") so the card makes it obvious a fresh block just opened.
function blockHours(b) {
  const opts = { hour: '2-digit', minute: '2-digit' };
  return `${localTime(b.start, opts)} &ndash; ${localTime(b.end, opts)}`;
}

function blockSpanLabel(b) {
  const opts = { month: 'short', day: 'numeric', hour: 'numeric' };
  return `${stripNarrowSpace(new Date(b.start).toLocaleString(undefined, opts))} – ${localTime(b.end, { hour: 'numeric' })}`;
}

// Classifies the active block's projection: against the live usage limit when the statusline
// snapshot gave us used %, else against this range's completed blocks (median/P90 of cost).
// Returns null when there is no active block or nothing to compare against.
function burnPace(ab, blocks) {
  if (!ab?.burn) return null;
  const blockMin = (new Date(ab.end) - new Date(ab.start)) / 60000;
  const elapsedMin = Math.max(1, blockMin - ab.burn.remainingMin);
  if (ab.usedPct != null) {
    const projPct = (ab.usedPct / elapsedMin) * blockMin;
    const cls = projPct >= 100 ? 'hot' : projPct >= 80 ? 'warn' : 'ok';
    return { cls, pct: Math.round(Math.min(projPct, 999)) };
  }
  const past = blocks
    .filter((b) => !b.active && b.cost > 0)
    .map((b) => b.cost)
    .sort((a, b) => a - b);
  if (past.length < 3) return null;
  const p90 = past[Math.min(past.length - 1, Math.floor(past.length * 0.9))];
  const cls = ab.burn.projectedCost > p90 ? 'hot' : ab.burn.projectedCost > median(past) ? 'warn' : 'ok';
  return { cls, note: `vs. ${formatCost(median)} median block` };
}

function renderInsights() {
  const el = document.getElementById('insights-view');
  if (!el) return;
  if (!insightsData) {
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
    return;
  }

  const d = insightsData;
  const h = JSON.stringify({ insightsData, scopeProject, scopeProjectName });
  if (lastRenderHash.insights === h) return;
  lastRenderHash.insights = h;

  const ab = d.blocks.find((b) => b.active) || null;
  const pace = burnPace(ab, d.blocks);
  const sub = d.subagents;
  const agentTotal = sub.mainCost + sub.subagentCost;
  const subPct = formatPct(sub.subagentCost, agentTotal);
  const cacheable = d.tokens.cacheRead + d.tokens.cacheCreation;
  const cacheHitPct = cacheable > 0 ? Math.round((d.tokens.cacheRead / cacheable) * 100) : null;
  const showWeekly = d.weekly.length >= 3;

  el.innerHTML = `
    <div class="dashboard-content">
      ${viewTabs('insights')}
      ${scopeIndicator()}
      <div class="cards-row">
        <div class="stat-card">
          <div class="card-label">Active 5h Block</div>
          <div class="card-value cost">${ab ? formatCost(ab.cost) : '—'}</div>
          ${ab?.usedPct == null ? '' : meter(ab.usedPct, { label: `${Math.round(ab.usedPct)}%`, ariaLabel: `${Math.round(ab.usedPct)}% of the 5h block used` })}
          <div class="card-sub">${ab ? `${blockHours(ab)} &middot; <strong>${formatDuration(ab.burn.remainingMin)} left</strong>` : 'no live window data'}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Burn Rate</div>
          <div class="card-value ${esc(pace ? `pace-${pace.cls}` : '')}">${ab ? `${formatCost(ab.burn.costPerHour)}/h` : '—'}</div>
          ${pace?.pct == null ? '' : meter(pace.pct, { label: `${pace.pct}%`, cls: `pace-${pace.cls}`, ariaLabel: `on pace for ${pace.pct}% of the usage limit` })}
          <div class="card-sub">${ab ? `${formatTokens(Math.round(ab.burn.tokensPerMin))} tok/min &middot; proj. <strong>${formatCost(ab.burn.projectedCost)}</strong> by block end${pace?.note ? ` &middot; ${pace.note}` : ''}` : 'no active block'}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Monthly Run-Rate</div>
          <div class="card-value cost">${formatCost(d.runRate.projectedMonthly)}</div>
          <div class="card-sub"><strong>${formatCost(d.runRate.dailyAvg)}/day</strong> over ${d.runRate.days} ${d.runRate.days === 1 ? 'day' : 'days'}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Cache Savings</div>
          <div class="card-value cost">${formatCost(d.cacheSavings)}</div>
          ${cacheHitPct == null ? '' : meter(cacheHitPct, { label: `${cacheHitPct}% hit`, ariaLabel: `${cacheHitPct}% of cacheable input was served from cache, not re-sent` })}
          <div class="card-sub">vs. uncached input &middot; <strong>${formatTokens(d.tokens.cacheRead)}</strong> reads</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Subagent Share</div>
          <div class="card-value">${subPct}%</div>
          ${agentTotal > 0 ? meter(subPct, { ariaLabel: `subagents are ${subPct}% of ${formatCost(agentTotal)} in agent cost` }) : ''}
          <div class="card-sub"><strong>${formatCost(sub.subagentCost)}</strong> of ${formatCost(agentTotal)}</div>
        </div>
      </div>

      <div class="charts-row">
        <div class="chart-box">
          <div class="chart-title">Token Composition <span class="chart-title-note">log scale</span></div>
          <canvas id="tokenSplitChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Top Tools</div>
          ${d.tools.length ? '<canvas id="toolsChart"></canvas>' : '<div class="card-sub">No tool calls in this range</div>'}
        </div>
      </div>

      <div class="charts-row" style="grid-template-columns:${showWeekly ? '3fr 2fr' : '1fr'}">
        <div class="chart-box">
          <div class="chart-title">Activity Heatmap (cost by hour) <span class="chart-title-note">${isoDayLabel(d.heatmapDays[0])} &rarr; ${isoDayLabel(d.heatmapDays[d.heatmapDays.length - 1])}</span></div>
          ${buildHeatmap(d.heatmap, d.heatmapDays, d.heatmapToday)}
        </div>
        ${
          showWeekly
            ? `
        <div class="chart-box">
          <div class="chart-title">Weekly Cost</div>
          <canvas id="weeklyChart"></canvas>
        </div>`
            : ''
        }
      </div>

      ${
        d.blocks.length
          ? `
      <div class="section-title">5-Hour Billing Blocks</div>
      <table class="data-table">
        <thead><tr>
          <th>Block</th><th>Status</th><th>Messages</th><th>Tokens</th><th>Cost</th><th>Models</th>
        </tr></thead>
        <tbody>
          ${d.blocks
            .map(
              (b) => `
            <tr>
              <td>${blockSpanLabel(b)}</td>
              <td>${b.active ? `<span class="block-badge active">ACTIVE &middot; ${formatDuration(b.burn.remainingMin)} left</span>` : `<span class="block-badge">ended ${timeAgo(b.lastActivity)}</span>`}</td>
              <td>${b.messageCount}</td>
              <td>${formatTokens(b.tokens)}</td>
              <td class="cost-cell">${formatCost(b.cost)}</td>
              <td>${b.models.map((m) => `<span class="model-badge">${esc(shortModel(m))}</span>`).join(' ')}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>`
          : ''
      }

    </div>`;

  initHeatmapTooltip();
  requestAnimationFrame(() => {
    renderTokenSplitChart(d.tokens);
    if (d.tools.length) renderToolsChart(d.tools);
    if (showWeekly) renderWeeklyChart(d.weekly);
  });
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
        ${PARENT_BREADCRUMB}
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
        ${PARENT_BREADCRUMB}
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
    renderCostChart(sessionsCostSeries, 'sessionsCostChart', 'sessionsCost', sessionsModelDistribution || []);
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
        ${PARENT_BREADCRUMB}
        <span class="sep">/</span>
        <a onclick="navigateToSessions('${escAttrJs(d.encodedProjectPath)}', '${escAttrJs(d.projectPath)}')">${esc(d.projectPath)}</a>
        <span class="sep">/</span>
        <span class="current">${esc(d.customTitle || d.firstPrompt || d.sessionId)}</span>
      </div>

      ${d.firstPrompt ? `<div style="color:var(--text-tertiary);font-size:12px;margin-bottom:16px;font-style:italic">"${esc(d.firstPrompt)}"</div>` : ''}

      <div class="detail-header">
        <div class="detail-stat">
          <div class="detail-label">Total Cost</div>
          <div class="detail-value cost">${formatCost(d.totalCost)}<span class="detail-label detail-scope">all time</span></div>
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
          <div class="detail-value">${d.messages.length}<span class="detail-label detail-scope">all time</span></div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Models</div>
          <div class="detail-value">${esc(d.models.map((m) => shortModel(m)).join(', '))}</div>
        </div>
      </div>

      ${detailRangeNote(d)}

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

      ${rangeBrushHtml(d.messages.length)}

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
    destroyChart('cumulative');
    destroyChart('tokenBreakdown');
    applyDetailRange(d.messages, detailRangeFor(d));
    initRangeBrush(d.messages);
  });
}

// The session row that links here is scoped to the active range, so a session older than the
// range would otherwise show larger numbers here with no explanation.
function detailRangeNote(d) {
  const all = d.messages.length;
  const slice = (label, s) =>
    `<span class="scope-label">${esc(label)}</span> <strong>${formatCost(s.totalCost)}</strong> / ${s.messageCount} msg`;
  // A slice worth showing is a real subset: neither empty nor the whole session.
  const worthShowing = (s) => s && s.messageCount > 0 && s.messageCount < all;
  const parts = [];
  if (worthShowing(d.inRange)) parts.push(slice(rangeScopeLabel(d.range), d.inRange));
  if (worthShowing(d.today) && d.today.messageCount !== d.inRange?.messageCount) {
    parts.push(slice('today', d.today));
  }
  if (!parts.length) return '';
  return `<div class="detail-range-note">Totals above are all-time &middot; ${parts.join(' &middot; ')}</div>`;
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
    <td class="muted">${localTime(m.timestamp)}</td>
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
    textPrimary: style.getPropertyValue('--text-primary').trim() || '#f0f1f3',
    textMuted: style.getPropertyValue('--text-muted').trim() || '#7d808a',
    mono: style.getPropertyValue('--mono').trim() || "'IBM Plex Mono', monospace",
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

// Single source of the series palette so per-model colors match across charts.
function chartPalette(c) {
  return [c.chart1, c.chart2, c.chart3, c.chart4, c.chart5, c.chart6];
}

// Translucent fill from a hex color so chart bars read as a quiet wash, not a solid block.
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Tooltip title for per-message charts: names the subagent when the point is a folded-in agent run.
function messageTooltipTitle(messages, items) {
  const m = messages[items[0]?.dataIndex];
  if (!m) return '';
  return `#${m.index}${m._subagent ? ` · ${m._subagent.agentType}` : ''}`;
}

// Takes the palette the caller already read, so a chart costs one getComputedStyle, not two.
function chartDefaults(c = getChartColors()) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      // Mirrors .hm-tip so a chart hover and a heatmap hover read as the same tooltip:
      // elevated bg, muted label above, primary value below, mono throughout.
      tooltip: {
        backgroundColor: c.bg,
        titleColor: c.textMuted,
        bodyColor: c.textPrimary,
        borderColor: c.border,
        borderWidth: 1,
        cornerRadius: 4,
        padding: { top: 5, bottom: 5, left: 8, right: 8 },
        titleFont: { family: c.mono, size: 10, weight: 'normal' },
        bodyFont: { family: c.mono, size: 13, weight: '600' },
        titleMarginBottom: 2,
        boxWidth: 8,
        boxHeight: 8,
        boxPadding: 4,
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

// Chart.js log axes tick (and draw a gridline) at every 2..9 within a decade, which reads as
// visual noise — keep labels and gridlines at powers of 10 only. Epsilon because Math.log10
// of exact powers is not guaranteed to be integral.
function isDecade(v) {
  const l = Math.log10(v);
  return Math.abs(l - Math.round(l)) < 1e-9;
}

// maxValue caps the axis at the largest bar and labels it, so the longest bar ends at a
// readable number instead of running past the last decade tick.
function logAxis(xDefaults, maxValue) {
  const labeled = (v) => isDecade(v) || v === maxValue;
  return {
    ...xDefaults,
    type: 'logarithmic',
    min: 1,
    ...(maxValue > 1 ? { max: maxValue } : {}),
    // Chart.js doesn't always emit a tick at the axis max — force one so the longest bar ends
    // at its real value, and drop a decade tick sitting close enough to collide with its label.
    afterBuildTicks: (scale) => {
      if (maxValue <= 1) return;
      scale.ticks = scale.ticks.filter(
        (t) => t.value !== maxValue && !(isDecade(t.value) && Math.abs(Math.log10(maxValue / t.value)) < 0.25),
      );
      scale.ticks.push({ value: maxValue });
    },
    grid: {
      ...xDefaults.grid,
      color: (ctx) => (ctx.tick && labeled(ctx.tick.value) ? xDefaults.grid.color : 'transparent'),
    },
    ticks: {
      ...xDefaults.ticks,
      // autoSkip would drop the forced max tick before it ever renders.
      autoSkip: false,
      callback: (v) => (labeled(v) ? formatTokens(v) : ''),
    },
  };
}

function barDataset(data, color) {
  return {
    data,
    backgroundColor: Array.isArray(color) ? color.map((x) => hexToRgba(x, 0.5)) : hexToRgba(color, 0.5),
    borderColor: color,
    borderWidth: 1.5,
    borderRadius: 3,
  };
}

function withTooltip(defaults, callbacks) {
  return { ...defaults.plugins, tooltip: { ...defaults.plugins.tooltip, callbacks } };
}

// Exact dollars for cost axes and their tooltips — formatCost's thresholds are for cards, where
// "<$0.01" reads better than a chart tick that has to line up with its neighbours.
const usd = (v) => `$${v.toFixed(2)}`;

function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

function renderCostChart(series, canvasId = 'costChart', chartKey = 'cost', distribution = []) {
  const points = series?.points;
  const canvas = document.getElementById(canvasId);
  if (!canvas || !points?.length) return;
  destroyChart(chartKey);

  const c = getChartColors();
  const defaults = chartDefaults();

  // Stack order follows modelDistribution so segment colors line up with the Cost by Model
  // chart rendered next to it. 'other' (synthetic models) is absent from the distribution
  // and lands at the end.
  const present = new Set();
  for (const p of points) {
    for (const m in p.byModel) if (p.byModel[m] > 0) present.add(m);
  }
  const models = distribution.filter((d) => present.has(d.model)).map((d) => d.model);
  for (const m of present) if (!models.includes(m)) models.push(m);
  const palette = chartPalette(c);

  const datasets = models.map((m, i) => ({
    label: shortModel(m),
    data: points.map((p) => p.byModel?.[m] || 0),
    backgroundColor: hexToRgba(palette[i % palette.length], 0.5),
    borderColor: palette[i % palette.length],
    borderWidth: 1.5,
    borderRadius: 2,
    stack: 'cost',
  }));

  charts[chartKey] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: points.map((p) => bucketLabel(p.key, series.bucket)),
      datasets,
    },
    options: {
      ...defaults,
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        ...withTooltip(defaults, { label: (ctx) => `${ctx.dataset.label}  ${usd(ctx.parsed.y)}` }),
        // The legend still carries segment names for the hours nobody hovers.
        legend: {
          display: models.length > 1,
          position: 'bottom',
          labels: { color: c.text, font: { size: 9 }, boxWidth: 8, boxHeight: 8 },
        },
      },
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, stacked: true },
        y: {
          ...defaults.scales.y,
          stacked: true,
          ticks: { ...defaults.scales.y.ticks, callback: usd },
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
  const palette = chartPalette(colors);
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
      plugins: withTooltip(defaults, {
        label: (ctx) => `${usd(ctx.parsed.x)} (${formatPct(ctx.parsed.x, total)}%)`,
      }),
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, ticks: { ...defaults.scales.x.ticks, callback: (v) => `$${v}` } },
      },
    },
  });
}

function cumulativeChartData(messages, c) {
  return {
    labels: messages.map((m) => m.index),
    datasets: [
      {
        label: 'Cumulative Cost',
        data: messages.map((m) => m.cumulativeCost),
        borderColor: c.accent,
        backgroundColor: c.chartFill,
        fill: true,
        borderWidth: 2,
        pointRadius: messages.length > 50 ? 0 : 3,
        // Subagent points render hollow so they read as folded-in cost, not main-loop turns.
        pointBackgroundColor: messages.length > 50 ? c.accent : messages.map((m) => (m._subagent ? c.bg : c.accent)),
        pointBorderColor: c.accent,
        tension: 0.2,
      },
    ],
  };
}

function tokenBreakdownChartData(messages, c) {
  // Subagent bars render translucent so they read as folded-in usage, not main-loop turns.
  const barColors = (hex) => {
    const faded = hexToRgba(hex, 0.45);
    return messages.map((m) => (m._subagent ? faded : hex));
  };
  const series = [
    ['Input', 'inputTokens', c.chart1],
    ['Output', 'outputTokens', c.chart2],
    ['Cache Create', 'cacheCreationTokens', c.chart3],
    ['Cache Read', 'cacheReadTokens', c.chart4],
  ];
  return {
    labels: messages.map((m) => m.index),
    datasets: series.map(([label, key, hex]) => ({
      label,
      data: messages.map((m) => m[key]),
      backgroundColor: barColors(hex),
      borderRadius: 2,
    })),
  };
}

function renderCumulativeChart(messages) {
  const canvas = document.getElementById('cumulativeChart');
  if (!canvas || !messages?.length) return;
  destroyChart('cumulative');

  const c = getChartColors();
  const defaults = chartDefaults();

  charts.cumulative = new Chart(canvas, {
    type: 'line',
    data: cumulativeChartData(messages, c),
    options: {
      ...defaults,
      plugins: withTooltip(defaults, { title: (items) => messageTooltipTitle(detailSlice, items) }),
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
    data: tokenBreakdownChartData(messages, c),
    options: {
      ...defaults,
      plugins: {
        ...withTooltip(defaults, { title: (items) => messageTooltipTitle(detailSlice, items) }),
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: c.text,
            font: { size: 10, family: c.mono },
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

// #region RANGE BRUSH
// Long sessions squash both per-message charts into noise, so the detail view shows a window of
// the last DETAIL_WINDOW messages by default and lets the user drag that window across an overview
// of the whole session. State lives outside the DOM because renderDetail rebuilds its innerHTML on
// every refresh; a window that sits at the tail stays there so new messages scroll into view.
const DETAIL_WINDOW_PRESETS = [25, 50, 100, 200];
const DETAIL_WINDOW = DETAIL_WINDOW_PRESETS[0];
const DETAIL_WINDOW_MIN = 10;
let detailRange = null;
let detailSlice = [];

function median(sorted) {
  return sorted[Math.floor(sorted.length / 2)];
}

// A cache burst is a main-loop turn that wrote far more cache than the session normally does:
// the prompt prefix was invalidated (edited system prompt, compaction, new tool set, long gap) and
// had to be re-cached. Relative to the session median so a chatty session and a heavy one both
// surface their own outliers; the absolute floor drops noise in tiny sessions.
const CACHE_BURST_RATIO = 4;
const CACHE_BURST_MIN_TOKENS = 20000;

function cacheBurstIndices(messages) {
  const writes = messages
    .filter((m) => !m._subagent && m.cacheCreationTokens > 0)
    .map((m) => m.cacheCreationTokens)
    .sort((a, b) => a - b);
  if (writes.length < 5) return [];
  const threshold = Math.max(CACHE_BURST_MIN_TOKENS, median(writes) * CACHE_BURST_RATIO);
  return messages.flatMap((m, i) => (!m._subagent && m.cacheCreationTokens >= threshold ? [i] : []));
}

function clampRange(start, end, total) {
  const s = Math.max(0, Math.min(start, total - DETAIL_WINDOW_MIN));
  return { start: s, end: Math.max(s + DETAIL_WINDOW_MIN, Math.min(end, total)) };
}

function detailRangeFor(d) {
  const total = d.messages.length;
  const prev = detailRange?.key === d.sessionId ? detailRange : null;
  const size = prev ? prev.end - prev.start : DETAIL_WINDOW;
  const atTail = !prev || prev.end === prev.total;
  const start = atTail ? total - size : prev.start;
  detailRange = { key: d.sessionId, total, ...clampRange(start, start + size, total) };
  return detailRange;
}

function applyDetailRange(messages, range) {
  detailSlice = messages.slice(range.start, range.end);
  const c = getChartColors();
  if (charts.cumulative && charts.tokenBreakdown) {
    charts.cumulative.data = cumulativeChartData(detailSlice, c);
    charts.cumulative.update('none');
    charts.tokenBreakdown.data = tokenBreakdownChartData(detailSlice, c);
    charts.tokenBreakdown.update('none');
  } else {
    renderCumulativeChart(detailSlice);
    renderTokenBreakdownChart(detailSlice);
  }
}

function rangeBrushHtml(total) {
  if (total <= DETAIL_WINDOW) return '';
  const presets = DETAIL_WINDOW_PRESETS.filter((n) => n < total)
    .map((n) => `<button type="button" class="rb-preset" data-size="${n}">${n}</button>`)
    .join('');
  return `
      <div class="range-brush" id="rangeBrush">
        <div class="rb-head">
          <span class="rb-label"><span class="rb-scope"></span><span class="rb-burst-count" hidden><i></i></span></span>
          <div class="rb-presets" role="group" aria-label="Window size">
            ${presets}
            <button type="button" class="rb-preset" data-size="all">All</button>
          </div>
        </div>
        <div class="rb-track" tabindex="0" role="slider" aria-label="Visible message range"
             aria-valuemin="1" aria-valuemax="${esc(total)}">
          ${rangeOverviewSvg}
          <div class="rb-bursts"></div>
          <div class="rb-window">
            <div class="rb-handle rb-handle-left" data-edge="start"></div>
            <div class="rb-handle rb-handle-right" data-edge="end"></div>
          </div>
        </div>
      </div>`;
}

// The overview shares the brush's percentage coordinate space, so it stretches with the track and
// needs no resize handling. Points are filled in by initRangeBrush.
const rangeOverviewSvg =
  '<svg class="rb-overview" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><polygon /><polyline /></svg>';

function initRangeBrush(messages) {
  const root = document.getElementById('rangeBrush');
  if (!root) return;
  const total = messages.length;
  const range = detailRange;
  const q = (sel) => root.querySelector(sel);
  const track = q('.rb-track');
  const win = q('.rb-window');
  const scope = q('.rb-scope');
  const burstCount = q('.rb-burst-count');
  const presets = [...root.querySelectorAll('.rb-preset')].map((el) => ({
    el,
    size: el.dataset.size === 'all' ? total : Number(el.dataset.size),
  }));

  drawRangeOverview(q('.rb-overview'), messages);

  const bursts = cacheBurstIndices(messages);
  const burstsEl = q('.rb-bursts');
  burstsEl.innerHTML = bursts
    .map((i) => {
      const m = messages[i];
      const tip = `#${m.index} · cache write ${formatTokens(m.cacheCreationTokens)}`;
      return `<button type="button" class="rb-burst" data-i="${i}" style="left:${((i + 0.5) / total) * 100}%" title="${esc(tip)}" aria-label="${esc(tip)}"></button>`;
    })
    .join('');
  const burstEls = [...burstsEl.children].map((el, k) => ({ el, i: bursts[k] }));
  if (bursts.length) {
    burstCount.hidden = false;
    burstCount.append(`${bursts.length} cache burst${bursts.length === 1 ? '' : 's'}`);
  }

  const layout = () => {
    const size = range.end - range.start;
    win.style.left = `${(range.start / total) * 100}%`;
    win.style.width = `${(size / total) * 100}%`;
    const text =
      size === total
        ? `All ${total} messages`
        : `Messages #${messages[range.start].index} – #${messages[range.end - 1].index} · ${size} of ${total}`;
    scope.textContent = text;
    track.setAttribute('aria-valuenow', String(range.start + 1));
    track.setAttribute('aria-valuetext', text);
    for (const p of presets) p.el.classList.toggle('on', p.size === size);
    for (const b of burstEls) b.el.classList.toggle('in', b.i >= range.start && b.i < range.end);
  };

  // Pointer and wheel events outrun the frame rate, so range writes are coalesced into one paint.
  let frame = 0;
  const setRange = (from, to) => {
    const next = clampRange(from, to, total);
    if (next.start === range.start && next.end === range.end) return;
    Object.assign(range, next);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
      applyDetailRange(messages, range);
    });
  };
  const size = () => range.end - range.start;
  const step = () => Math.max(1, Math.round(size() / 10));
  const pan = (delta) => setRange(range.start + delta, range.end + delta);
  const centerOn = (i) => {
    const start = Math.max(0, Math.min(i - Math.floor(size() / 2), total - size()));
    setRange(start, start + size());
  };
  const resize = (n) => {
    const end = Math.min(total, Math.max(range.end, n));
    setRange(end - n, end);
  };

  // Pointer capture keeps a fast drag alive after the cursor leaves the thin track. The rect is
  // read once per drag: reading it per move right after writing the window's style would thrash.
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    track.focus({ preventScroll: true });
    const rect = track.getBoundingClientRect();
    const perPx = total / rect.width;
    const edge = e.target.dataset?.edge;
    if (!edge && e.target !== win) centerOn(Math.round((e.clientX - rect.left) * perPx));
    const origin = { x: e.clientX, start: range.start, end: range.end };
    track.classList.add('dragging');
    track.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const delta = Math.round((ev.clientX - origin.x) * perPx);
      if (edge === 'start') setRange(origin.start + delta, origin.end);
      else if (edge === 'end') setRange(origin.start, origin.end + delta);
      else {
        const n = origin.end - origin.start;
        const start = Math.max(0, Math.min(origin.start + delta, total - n));
        setRange(start, start + n);
      }
    };
    const up = () => {
      track.classList.remove('dragging');
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  });

  track.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      pan((e.deltaY || e.deltaX) > 0 ? step() : -step());
    },
    { passive: false },
  );

  track.addEventListener('keydown', (e) => {
    const n = e.shiftKey ? size() : step();
    if (e.key === 'ArrowLeft') pan(-n);
    else if (e.key === 'ArrowRight') pan(n);
    else if (e.key === 'Home') setRange(0, size());
    else if (e.key === 'End') setRange(total - size(), total);
    else return;
    e.preventDefault();
  });

  for (const p of presets) p.el.addEventListener('click', () => resize(p.size));

  burstsEl.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.rb-burst');
    if (!b) return;
    e.stopPropagation();
    e.preventDefault();
    centerOn(Number(b.dataset.i));
  });

  layout();
}

function drawRangeOverview(svg, messages) {
  const n = messages.length;
  const max = messages[n - 1]?.cumulativeCost || 1;
  const pts = messages.map((m, i) => `${(i / Math.max(1, n - 1)) * 1000},${100 - (m.cumulativeCost / max) * 96 - 2}`);
  svg.querySelector('polyline').setAttribute('points', pts.join(' '));
  svg.querySelector('polygon').setAttribute('points', `0,100 ${pts.join(' ')} 1000,100`);
}
// #endregion

function renderTokenSplitChart(t) {
  const canvas = document.getElementById('tokenSplitChart');
  if (!canvas) return;
  destroyChart('tokenSplit');

  const c = getChartColors();
  const defaults = chartDefaults();
  const rows = [
    ['Input', t.input, c.chart1],
    ['Output', t.output, c.chart2],
    ['Cache Write', t.cacheCreation, c.chart3],
    ['Cache Read', t.cacheRead, c.chart4],
  ];
  const total = rows.reduce((s, r) => s + r[1], 0);

  charts.tokenSplit = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r[0]),
      datasets: [
        barDataset(
          rows.map((r) => r[1]),
          rows.map((r) => r[2]),
        ),
      ],
    },
    options: {
      ...defaults,
      indexAxis: 'y',
      interaction: { mode: 'index', axis: 'y', intersect: false },
      plugins: withTooltip(defaults, {
        label: (ctx) => `${formatTokens(ctx.parsed.x)} (${formatPct(ctx.parsed.x, total)}%)`,
      }),
      scales: {
        ...defaults.scales,
        // Log scale: cache reads structurally dwarf fresh input by 3-5 orders of magnitude,
        // so a linear axis renders every other bar invisible. Tooltip carries exact values + %.
        x: logAxis(defaults.scales.x, Math.max(...rows.map((r) => r[1]))),
      },
    },
  });
}

function renderToolsChart(tools) {
  const canvas = document.getElementById('toolsChart');
  if (!canvas || !tools?.length) return;
  destroyChart('tools');

  const c = getChartColors();
  const defaults = chartDefaults();

  // Top 8 with every label visible beats a longer list where Chart.js skips every other tick.
  const top = tools.slice(0, 8);
  // MCP tool names ("mcp__plugin_x__ctx_execute") are too long for axis labels — keep the tail.
  const shortName = (n) => (n.includes('__') ? n.split('__').pop() : n);

  charts.tools = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: top.map((t) => shortName(t.name)),
      datasets: [
        barDataset(
          top.map((t) => t.count),
          c.chart2,
        ),
      ],
    },
    options: {
      ...defaults,
      indexAxis: 'y',
      // Row-wise hit testing, so the tooltip also opens over the axis label and the empty
      // space past a short bar — the label is where the eye goes for a truncated MCP name.
      interaction: { mode: 'index', axis: 'y', intersect: false },
      plugins: withTooltip(defaults, {
        title: (items) => top[items[0].dataIndex]?.name || '',
        label: (ctx) => `${ctx.parsed.x} calls`,
      }),
      scales: {
        ...defaults.scales,
        y: { ...defaults.scales.y, ticks: { ...defaults.scales.y.ticks, autoSkip: false } },
      },
    },
  });
}

function renderWeeklyChart(weekly) {
  const canvas = document.getElementById('weeklyChart');
  if (!canvas || !weekly?.length) return;
  destroyChart('weekly');

  const c = getChartColors();
  const defaults = chartDefaults();

  charts.weekly = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: weekly.map((w) => isoDayLabel(w.weekStart)),
      datasets: [
        barDataset(
          weekly.map((w) => w.cost),
          c.chart1,
        ),
      ],
    },
    options: {
      ...defaults,
      plugins: withTooltip(defaults, { label: (ctx) => usd(ctx.parsed.y) }),
      scales: {
        ...defaults.scales,
        y: { ...defaults.scales.y, ticks: { ...defaults.scales.y.ticks, callback: usd } },
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

// #region DATE_PICKER

// Presets are sticky: what is stored is the preset, and the server recomputes its rolling window on
// every request. `days` only previews the span inside the calendar.
const RANGE_PRESETS = [
  { value: 'today', label: 'Today', days: 0 },
  { value: '24h', label: 'Last 24h', days: 1 },
  { value: '3', label: '3 Days', days: 3 },
  { value: '7', label: '7 Days', days: 7 },
  { value: '30', label: '30 Days', days: 30 },
  { value: '90', label: '90 Days', days: 90 },
  { value: '365', label: '1 Year', days: 365, cardLabel: '365 Days' },
];
const RANGE_DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
// Two months do not fit a narrow window, so below this the calendar collapses to one. Kept in step
// with the same breakpoint in style.css.
const ONE_MONTH_QUERY = '(max-width: 760px)';
// One live MediaQueryList: matchMedia() hands back a new object each call, so add/removeEventListener
// have to share this one or the listener never comes off.
const oneMonthMql = window.matchMedia(ONE_MONTH_QUERY);
const RANGE_ARROWS = {
  prev: '<path d="M6.5 1L2.5 5l4 4"/>',
  next: '<path d="M3.5 1l4 4-4 4"/>',
};

// Non-null only while the popover is open — it is both the draft and the open flag. `picking` is
// which end the next day click lands on; `hover` previews the span before the second click.
let rangeDraft = null;

function isRangePickerOpen() {
  return !!rangeDraft;
}

function oneMonthMode() {
  return oneMonthMql.matches;
}

// What a preset covers, for highlighting only. '24h' is named here because its span is not a day
// count: it straddles the two calendar days a rolling day touches. Everything else is the last N
// calendar days ending today, which is now exactly the window the server fetches — 'today' included,
// since a span of one day or less is today itself.
function rangePresetSpan(value) {
  const today = todayIso();
  if (value === '24h') return { from: isoShift(today, -1), to: today };
  const days = Number(value) || 1;
  return { from: days <= 1 ? today : isoShift(today, -(days - 1)), to: today };
}

function buildRangePresets() {
  const host = document.getElementById('rangePresets');
  if (!host) return;
  for (const p of RANGE_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'range-preset';
    b.dataset.value = p.value;
    b.textContent = p.label;
    // A shortcut is one click, like the dropdown it replaces: apply and close, no Apply button.
    b.addEventListener('click', () => {
      closeRangePicker();
      applyRange(presetRange(p.value));
    });
    host.appendChild(b);
  }
}

function renderRangeTrigger() {
  const el = document.getElementById('rangeTriggerLabel');
  if (el) el.textContent = rangeTriggerLabel(dateRange);
}

// biome-ignore lint/correctness/noUnusedVariables: called from topbar markup
function toggleRangePicker(e) {
  e?.stopPropagation();
  if (isRangePickerOpen()) closeRangePicker();
  else openRangePicker();
}

function openRangePicker() {
  const applied = normalizeRange(dateRange) || presetRange(DEFAULT_RANGE_PRESET);
  const span = applied.kind === 'custom' ? { from: applied.from, to: applied.to } : rangePresetSpan(applied.value);
  // The left pane shows the month before the window's end, so today sits in the right one; with a
  // single month it is that month itself.
  const [ay, am] = isoParts(span.to);
  const first = new Date(ay, am - 1 - (oneMonthMode() ? 0 : 1), 1);
  rangeDraft = {
    from: span.from,
    to: span.to,
    preset: applied.kind === 'custom' ? null : applied.value,
    picking: 'from',
    hover: null,
    month: { y: first.getFullYear(), m: first.getMonth() },
  };
  document.getElementById('rangePop').classList.add('open');
  document.getElementById('rangeTrigger').classList.add('on');
  // Capture phase: a day click re-renders the grid and detaches its own button, so by the bubble
  // phase the target is no longer inside #rangePicker and would read as an outside click.
  document.addEventListener('click', onRangePickerOutsideClick, true);
  const months = document.getElementById('rangeMonths');
  months.addEventListener('click', onRangeDayClick);
  months.addEventListener('mouseover', onRangeDayHover);
  oneMonthMql.addEventListener('change', renderRangePicker);
  renderRangePicker();
}

function closeRangePicker() {
  if (!rangeDraft) return;
  rangeDraft = null;
  document.getElementById('rangePop').classList.remove('open');
  document.getElementById('rangeTrigger').classList.remove('on');
  document.removeEventListener('click', onRangePickerOutsideClick, true);
  const months = document.getElementById('rangeMonths');
  months.removeEventListener('click', onRangeDayClick);
  months.removeEventListener('mouseover', onRangeDayHover);
  oneMonthMql.removeEventListener('change', renderRangePicker);
}

// Both grids are delegated: one listener pair on #rangeMonths instead of two per day cell. Only the
// selectable days carry data-iso, so the lead padding and the days after today stay inert. It has to
// be 'mouseover' — 'mouseenter' does not bubble, so it cannot be delegated.
function onRangeDayClick(e) {
  const iso = e.target.dataset?.iso;
  if (iso) pickRangeDay(iso);
}

function onRangeDayHover(e) {
  const iso = e.target.dataset?.iso;
  if (iso && rangeDraft?.from && !rangeDraft.to && rangeDraft.hover !== iso) {
    rangeDraft.hover = iso;
    paintRangeSpan();
  }
}

// Outside click cancels: the draft is dropped and the applied range stays.
function onRangePickerOutsideClick(e) {
  if (!document.getElementById('rangePicker').contains(e.target)) closeRangePicker();
}

// biome-ignore lint/correctness/noUnusedVariables: called from popover markup
function aimRangePicker(which) {
  if (!rangeDraft) return;
  rangeDraft.picking = which;
  renderRangePicker();
}

// biome-ignore lint/correctness/noUnusedVariables: called from popover markup
function applyRangeDraft() {
  const d = rangeDraft;
  if (!d?.from || !d.to) return;
  const next = { kind: 'custom', from: d.from, to: d.to };
  closeRangePicker();
  applyRange(next);
}

function pickRangeDay(iso) {
  const d = rangeDraft;
  d.preset = null;
  if (d.picking === 'from' || !d.from) {
    d.from = iso;
    d.to = null;
    d.picking = 'to';
  } else if (iso < d.from) {
    // A second click before the first flips the pair instead of refusing it.
    d.to = d.from;
    d.from = iso;
    d.picking = 'from';
  } else {
    d.to = iso;
    d.picking = 'from';
  }
  d.hover = null;
  renderRangePicker();
}

function rangeMonthStep(step) {
  const c = new Date(rangeDraft.month.y, rangeDraft.month.m + step, 1);
  rangeDraft.month = { y: c.getFullYear(), m: c.getMonth() };
  renderRangePicker();
}

// There is no cost data ahead of today, so the calendar stops at the current month.
function rangeNextDisabled() {
  const last = new Date(rangeDraft.month.y, rangeDraft.month.m + (oneMonthMode() ? 0 : 1), 1);
  const now = new Date();
  return last >= new Date(now.getFullYear(), now.getMonth(), 1);
}

// The highlighted span: the picked window, or from -> the hovered day while the second end is open.
function rangeDraftSpan() {
  const d = rangeDraft;
  if (!d?.from) return [null, null];
  if (d.to) return [d.from, d.to];
  if (!d.hover) return [d.from, d.from];
  return d.hover < d.from ? [d.hover, d.from] : [d.from, d.hover];
}

// The span highlight is four classes on day cells that already exist, so a hover repaint toggles
// them in place instead of rebuilding both grids. Sole owner of those classes — buildRangeMonth
// leaves them to the paint pass that follows it, so the two can never drift apart.
function paintRangeSpan() {
  const [a, b] = rangeDraftSpan();
  for (const btn of document.querySelectorAll('#rangeMonths .range-day[data-iso]')) {
    const iso = btn.dataset.iso;
    const inSpan = !!(a && b && iso >= a && iso <= b);
    const edge = inSpan && (iso === a || iso === b);
    btn.classList.toggle('edge', edge);
    btn.classList.toggle('in', inSpan && !edge);
    btn.classList.toggle('start', inSpan && !edge && isoShift(iso, -1) === a);
    btn.classList.toggle('end', inSpan && !edge && isoShift(iso, 1) === b);
  }
}

function renderRangePicker() {
  const d = rangeDraft;
  if (!d) return;

  for (const b of document.querySelectorAll('#rangePresets .range-preset')) {
    b.classList.toggle('on', b.dataset.value === d.preset);
  }

  const fromBox = document.getElementById('rangeFromBox');
  const toBox = document.getElementById('rangeToBox');
  fromBox.textContent = d.from ? isoDayLabel(d.from) : '—';
  toBox.textContent = d.to ? isoDayLabel(d.to) : '—';
  fromBox.classList.toggle('empty', !d.from);
  toBox.classList.toggle('empty', !d.to);
  fromBox.classList.toggle('active', d.picking === 'from');
  toBox.classList.toggle('active', d.picking === 'to');

  const [a, b] = rangeDraftSpan();
  const days = d.from && d.to ? isoDayCount(a, b) : 0;
  document.getElementById('rangeSummary').textContent = days
    ? `${days} ${days === 1 ? 'day' : 'days'}`
    : 'pick an end date';
  document.getElementById('rangeApply').disabled = !(d.from && d.to);

  const host = document.getElementById('rangeMonths');
  host.innerHTML = '';
  const single = oneMonthMode();
  const first = new Date(d.month.y, d.month.m, 1);
  host.appendChild(buildRangeMonth(first.getFullYear(), first.getMonth(), { prev: true, next: single }));
  if (!single) {
    const second = new Date(d.month.y, d.month.m + 1, 1);
    host.appendChild(buildRangeMonth(second.getFullYear(), second.getMonth(), { prev: false, next: true }));
  }
  paintRangeSpan();
}

function rangeNavButton(dir) {
  const step = dir === 'next' ? 1 : -1;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'range-nav';
  btn.innerHTML = `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${RANGE_ARROWS[dir]}</svg>`;
  if (step > 0) btn.disabled = rangeNextDisabled();
  btn.addEventListener('click', () => rangeMonthStep(step));
  return btn;
}

// Holds the title centred on the side that carries no arrow.
function rangeNavGap() {
  const gap = document.createElement('span');
  gap.className = 'range-nav-gap';
  return gap;
}

function buildRangeMonth(y, m, nav) {
  const wrap = document.createElement('div');
  wrap.className = 'range-cal';

  const title = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'short' }).toUpperCase();

  const head = document.createElement('div');
  head.className = 'range-cal-head';
  head.appendChild(nav.prev ? rangeNavButton('prev') : rangeNavGap());
  const titleEl = document.createElement('span');
  titleEl.className = 'range-cal-title';
  titleEl.textContent = `${title} ${y}`;
  head.appendChild(titleEl);
  head.appendChild(nav.next ? rangeNavButton('next') : rangeNavGap());
  wrap.appendChild(head);

  const dow = document.createElement('div');
  dow.className = 'range-dow';
  dow.innerHTML = RANGE_DOW.map((d) => `<span>${d}</span>`).join('');
  wrap.appendChild(dow);

  const grid = document.createElement('div');
  grid.className = 'range-grid';
  const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first
  const dayCount = new Date(y, m + 1, 0).getDate();
  const today = todayIso();

  for (let i = 0; i < lead; i++) {
    const pad = document.createElement('span');
    pad.className = 'range-day pad';
    grid.appendChild(pad);
  }
  for (let day = 1; day <= dayCount; day++) {
    const iso = isoDate(new Date(y, m, day));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'range-day';
    btn.textContent = day;
    if (iso === today) btn.classList.add('today');
    if (iso > today) {
      btn.classList.add('off');
      btn.disabled = true;
    } else {
      // What the delegated click/hover handlers and paintRangeSpan read the cell's day back from.
      btn.dataset.iso = iso;
    }
    grid.appendChild(btn);
  }
  wrap.appendChild(grid);
  return wrap;
}

// #endregion

// #region ROUTER

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
  if (view === 'overview' || view === 'insights') {
    currentProjectPath = null;
    currentProjectName = null;
    currentSessionId = null;
  }
  if (view === 'sessions') {
    currentSessionId = null;
  }
  // Remember the last top-level tab so a fresh load lands on it again.
  if (view === 'overview' || view === 'insights') localStorage.setItem('cc-cost:view', view);

  updateUrl();
  await loadAndRender(view);
  if (view !== 'detail') selectRow(0);
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
async function navigateToSessions(encodedPath, name) {
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
  if (!s) return;
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
}

// The one entry point for a range change, from either half of the picker. The lastRenderHash reset
// is load-bearing: the renderers are hash-gated and would not repaint the new window otherwise.
async function applyRange(next) {
  dateRange = next;
  saveDateRange(dateRange);
  lastRenderHash = {};
  renderRangeTrigger();
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
      case 'insights':
        await fetchInsights();
        if (myNav !== navCounter) return;
        renderInsights();
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
  const views = ['overview', 'insights', 'sessions', 'detail'];
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
    target = currentProjectPath ? 'sessions' : 'overview';
  } else if (currentView === 'sessions' || currentView === 'insights') {
    target = 'overview';
  }
  if (!target) return;

  // Insights is a sibling view, not a drill-down: the scope survives a tab switch.
  const keepScope = currentView === 'insights';

  if (target === 'sessions') {
    await navigate('sessions', { project: currentProjectPath, projectName: currentProjectName });
  } else if (keepScope) {
    await navigate(target);
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

  // The same exemption the modal above gets: the popover is a div, so the INPUT/SELECT guard does
  // not cover it, and r/t/j/k/Esc would otherwise fire straight through an open picker.
  if (isRangePickerOpen()) {
    if (e.key === 'Escape') {
      closeRangePicker();
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
    navigate('insights');
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
    await navigate('overview');
    focusPreviousRow('overview');
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  const state = getUrlState();
  dateRange = loadDateRange();
  buildRangePresets();
  renderRangeTrigger();

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
    currentProjectPath = state.project;
    currentProjectName = state.projectName;
    await navigate('detail', { session: state.session });
  } else if (state.project) {
    currentProjectPath = state.project;
    currentProjectName = state.projectName;
    await navigate('sessions', { project: state.project, projectName: state.projectName });
  } else if (state.view === 'insights') {
    await navigate('insights');
  } else if (scopeProject) {
    // Same landing rule as applyScope: a scope with no cursor of its own opens its sessions.
    currentProjectName = scopeProjectName;
    await navigate('sessions', { project: scopeProject, projectName: scopeProjectName });
  } else if (localStorage.getItem('cc-cost:view') === 'insights') {
    // No nav state for this tab — fall back to the last top-level tab from any session.
    await navigate('insights');
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
