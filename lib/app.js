'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { createNetGuard } = require('./net-guard');
const {
  getArg,
  CLAUDE_DIR,
  fetchPricing,
  invalidateAllCache,
  getOverviewData,
  getInsightsData,
  getProjectsData,
  getProjectSessionsData,
  getSessionDetailData,
  getAgentDetailData,
  withSessionSlices,
  loadUsage,
  parseRange,
  parseCustomRange,
  parseProject,
} = require('./costs');

const PORT = getArg('port') || process.env.PORT || 3543;

// #region EXPRESS

const app = express();

// Mounted before express.json() so a rejected request never buffers a body.
const net = createNetGuard({ appName: 'Claude Code Cost Dashboard' });
app.use(net.hostGuard);
app.use(net.frameGuard);
app.use(net.originGuard);

app.use(express.json());
// Under a hub, the hub hands over its SDK. Alone, public/vendor/claude-hub-sdk.js is a stub.
if (process.env.HUB_SDK_SERVER) require(process.env.HUB_SDK_SERVER).mount(app);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Resolves a request's range onto req.range: a custom from/to window wins over `range`. A resolved
// range cannot signal malformed input with null (null *is* the all-time range), so the rejection
// happens here, ahead of the handler, instead of being threaded back to it as a sentinel value.
// Only the range — a route that also scopes by project keeps its own parseProject guard, because
// the routes that don't call parseProject must go on ignoring a malformed `project`.
const withRange = (fallback = null) => (req, res, next) => {
  const custom = parseCustomRange(req.query);
  if (custom === null) return res.status(400).json({ error: 'Invalid date range' });
  req.range = custom || parseRange(req.query.range, fallback);
  next();
};

app.get('/api/overview', withRange(30), async (req, res) => {
  try {
    const project = parseProject(req.query.project);
    if (project === null) return res.status(400).json({ error: 'Invalid project' });
    const data = await getOverviewData(req.range, project);
    res.json(data);
  } catch (err) {
    console.error('[API] overview error:', err);
    res.status(500).json({ error: 'Failed to load overview data' });
  }
});

app.get('/api/insights', withRange(30), async (req, res) => {
  try {
    const project = parseProject(req.query.project);
    if (project === null) return res.status(400).json({ error: 'Invalid project' });
    const data = await getInsightsData(req.range, project);
    res.json(data);
  } catch (err) {
    console.error('[API] insights error:', err);
    res.status(500).json({ error: 'Failed to load insights data' });
  }
});

app.get('/api/projects', withRange(), async (req, res) => {
  try {
    const project = parseProject(req.query.project);
    if (project === null) return res.status(400).json({ error: 'Invalid project' });
    const data = await getProjectsData(req.range, project);
    res.json(data);
  } catch (err) {
    console.error('[API] projects error:', err);
    res.status(500).json({ error: 'Failed to load projects data' });
  }
});

app.get('/api/projects/:path/sessions', withRange(), async (req, res) => {
  try {
    const data = await getProjectSessionsData(req.params.path, req.range);
    res.json(data);
  } catch (err) {
    console.error('[API] sessions error:', err);
    res.status(500).json({ error: 'Failed to load sessions data' });
  }
});

app.get('/api/sessions/:id', withRange(), async (req, res) => {
  try {
    const base = await getSessionDetailData(req.params.id);
    if (!base) return res.status(404).json({ error: 'Session not found' });
    res.json(withSessionSlices(base, req.range));
  } catch (err) {
    console.error('[API] session detail error:', err);
    res.status(500).json({ error: 'Failed to load session detail' });
  }
});

app.get('/api/sessions/:id/agents/:agentId', withRange(), async (req, res) => {
  try {
    const base = await getAgentDetailData(req.params.id, req.params.agentId);
    if (!base) return res.status(404).json({ error: 'Agent not found' });
    res.json(withSessionSlices(base, req.range));
  } catch (err) {
    console.error('[API] agent detail error:', err);
    res.status(500).json({ error: 'Failed to load agent detail' });
  }
});

app.get('/api/usage-limits', async (req, res) => {
  try {
    const data = await loadUsage(req.query.refresh === '1');
    if (!data) return res.status(503).json({ error: 'No usage data returned' });
    res.json(data);
  } catch (err) {
    console.error('[API] usage-limits error:', err.message);
    res.status(503).json({ error: err.message });
  }
});

app.get('/api/pricing', async (_req, res) => {
  try {
    const pricing = await fetchPricing();
    const models = {};
    for (const [name, info] of pricing) {
      if (name.startsWith('anthropic/') || name.startsWith('claude')) {
        models[name] = info;
      }
    }
    res.json(models);
  } catch (err) {
    console.error('[API] pricing error:', err);
    res.status(500).json({ error: 'Failed to load pricing data' });
  }
});

app.post('/api/refresh', (_req, res) => {
  invalidateAllCache();
  res.json({ ok: true });
});

// #endregion

// #region STARTUP

const SERVER_FILE = path.join(CLAUDE_DIR, '.cost', 'server.json');

// The CLI reads this to reach the server of its config dir, and cck reads `script` to name the CLI
// to Kanbot, since under the hub it is not on PATH. A killed server leaves it behind, so readers
// check the pid.
function writeServerFile(port) {
  try {
    fs.mkdirSync(path.dirname(SERVER_FILE), { recursive: true });
    fs.writeFileSync(SERVER_FILE, JSON.stringify({ pid: process.pid, port, script: path.join(__dirname, '..', 'server.js') }));
  } catch (err) {
    console.warn('[Startup] cannot write server.json:', err.message);
  }
}

process.on('exit', () => {
  try {
    if (JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(SERVER_FILE);
  } catch {}
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const onReady = (actualPort) => {
  console.log(`Claude Code Cost Dashboard running at http://localhost:${actualPort}`);
  writeServerFile(actualPort);
  const warning = net.exposureWarning();
  if (warning) console.log(warning);

  if (process.argv.includes('--open')) {
    import('open').then(mod => mod.default(`http://localhost:${actualPort}`));
  }
};

const server = net.listenLoopback(app, PORT, onReady);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use, trying random port...`);
    net.listenLoopback(app, 0, onReady);
  } else {
    throw err;
  }
});

// Pre-fetch pricing on startup
fetchPricing().catch(() => {});

// #endregion
