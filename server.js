#!/usr/bin/env node
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createReadStream } = require('fs');
const { createInterface } = require('readline');
const os = require('os');

// #region CLI_ARGS

function getArg(name) {
  const eqIdx = process.argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (eqIdx === -1) return null;
  const arg = process.argv[eqIdx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return process.argv[eqIdx + 1] || null;
}

const PORT = getArg('port') || process.env.PORT || 3458;
const claudeDirArg = getArg('dir');
const CLAUDE_DIR = claudeDirArg
  ? claudeDirArg.replace(/^~/, os.homedir())
  : path.join(os.homedir(), '.claude');

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const ALT_PROJECTS_DIR = path.join(os.homedir(), '.config', 'claude', 'projects');

function getProjectsDirs() {
  const dirs = [];
  if (fs.existsSync(PROJECTS_DIR)) dirs.push(PROJECTS_DIR);
  if (fs.existsSync(ALT_PROJECTS_DIR)) dirs.push(ALT_PROJECTS_DIR);
  return dirs;
}

// #endregion

// #region PRICING

const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const PROVIDER_PREFIXES = ['anthropic/', 'claude-3-5-', 'claude-3-', 'claude-'];
const TIERED_THRESHOLD = 200_000;
const PRICING_REFRESH_MS = 6 * 60 * 60 * 1000;

let cachedPricing = null;
let pricingFetchedAt = 0;

const OFFLINE_PRICING = {
  'anthropic/claude-sonnet-4-20250514': {
    input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5,
    cache_creation_input_token_cost: 3.75e-6, cache_read_input_token_cost: 3e-7,
    input_cost_per_token_above_200k_tokens: 6e-6, output_cost_per_token_above_200k_tokens: 2.25e-5,
    cache_creation_input_token_cost_above_200k_tokens: 7.5e-6, cache_read_input_token_cost_above_200k_tokens: 6e-7,
  },
  'anthropic/claude-opus-4-20250514': {
    input_cost_per_token: 1.5e-5, output_cost_per_token: 7.5e-5,
    cache_creation_input_token_cost: 1.875e-5, cache_read_input_token_cost: 1.5e-6,
    input_cost_per_token_above_200k_tokens: 3e-5, output_cost_per_token_above_200k_tokens: 1.125e-4,
    cache_creation_input_token_cost_above_200k_tokens: 3.75e-5, cache_read_input_token_cost_above_200k_tokens: 3e-6,
    provider_specific_entry: { fast: 6.0 },
  },
  'anthropic/claude-haiku-4-5-20251001': {
    input_cost_per_token: 8e-7, output_cost_per_token: 4e-6,
    cache_creation_input_token_cost: 1e-6, cache_read_input_token_cost: 8e-8,
    input_cost_per_token_above_200k_tokens: 1.6e-6, output_cost_per_token_above_200k_tokens: 6e-6,
    cache_creation_input_token_cost_above_200k_tokens: 2e-6, cache_read_input_token_cost_above_200k_tokens: 1.6e-7,
  },
  'anthropic/claude-3-5-sonnet-20241022': {
    input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5,
    cache_creation_input_token_cost: 3.75e-6, cache_read_input_token_cost: 3e-7,
  },
  'anthropic/claude-3-5-haiku-20241022': {
    input_cost_per_token: 8e-7, output_cost_per_token: 4e-6,
    cache_creation_input_token_cost: 1e-6, cache_read_input_token_cost: 8e-8,
  },
};

async function fetchPricing() {
  const now = Date.now();
  if (cachedPricing && (now - pricingFetchedAt) < PRICING_REFRESH_MS) return cachedPricing;

  try {
    console.log('[Pricing] Fetching from LiteLLM...');
    const resp = await fetch(LITELLM_PRICING_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const pricing = new Map();
    for (const [name, info] of Object.entries(data)) {
      if (typeof info !== 'object' || info == null) continue;
      if (info.input_cost_per_token != null || info.output_cost_per_token != null) {
        pricing.set(name, info);
      }
    }
    cachedPricing = pricing;
    pricingFetchedAt = now;
    console.log(`[Pricing] Loaded ${pricing.size} models`);
    return pricing;
  } catch (err) {
    console.warn('[Pricing] Fetch failed, using offline fallback:', err.message);
    if (!cachedPricing) {
      cachedPricing = new Map(Object.entries(OFFLINE_PRICING));
      pricingFetchedAt = now;
    }
    return cachedPricing;
  }
}

function getModelPricing(pricing, modelName) {
  if (!modelName) return null;

  // Exact match
  const direct = pricing.get(modelName);
  if (direct) return direct;

  // Try with provider prefixes
  for (const prefix of PROVIDER_PREFIXES) {
    const candidate = pricing.get(`${prefix}${modelName}`);
    if (candidate) return candidate;
  }

  // Fuzzy lowercase match
  const lower = modelName.toLowerCase();
  for (const [key, value] of pricing) {
    const cmp = key.toLowerCase();
    if (cmp.includes(lower) || lower.includes(cmp)) return value;
  }

  return null;
}

function calculateTieredCost(totalTokens, basePrice, tieredPrice, threshold = TIERED_THRESHOLD) {
  if (!totalTokens || totalTokens <= 0) return 0;
  if (totalTokens > threshold && tieredPrice != null) {
    const below = Math.min(totalTokens, threshold);
    const above = Math.max(0, totalTokens - threshold);
    let cost = above * tieredPrice;
    if (basePrice != null) cost += below * basePrice;
    return cost;
  }
  if (basePrice != null) return totalTokens * basePrice;
  return 0;
}

function calculateCost(tokens, modelPricing) {
  const inputCost = calculateTieredCost(
    tokens.input_tokens, modelPricing.input_cost_per_token,
    modelPricing.input_cost_per_token_above_200k_tokens);
  const outputCost = calculateTieredCost(
    tokens.output_tokens, modelPricing.output_cost_per_token,
    modelPricing.output_cost_per_token_above_200k_tokens);
  const cacheCreationCost = calculateTieredCost(
    tokens.cache_creation_input_tokens, modelPricing.cache_creation_input_token_cost,
    modelPricing.cache_creation_input_token_cost_above_200k_tokens);
  const cacheReadCost = calculateTieredCost(
    tokens.cache_read_input_tokens, modelPricing.cache_read_input_token_cost,
    modelPricing.cache_read_input_token_cost_above_200k_tokens);
  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

function calculateCostForModel(tokens, modelName, pricing, speed) {
  const mp = getModelPricing(pricing, modelName);
  if (!mp) return 0;
  const baseCost = calculateCost(tokens, mp);
  const multiplier = speed === 'fast' ? (mp.provider_specific_entry?.fast ?? 1) : 1;
  return baseCost * multiplier;
}

// #endregion

// #region JSONL_PARSING

async function processJSONLFile(filePath, processLine) {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (line.trim().length === 0) continue;
    await processLine(line, lineNumber);
  }
}


function createDedupeHash(data) {
  const mid = data.message?.id;
  const rid = data.requestId;
  if (!mid || !rid) return null;
  return `${mid}:${rid}`;
}

function calculateEntryCost(data, pricing) {
  // Auto mode: use costUSD if present, otherwise calculate
  if (data.costUSD != null) return data.costUSD;
  const model = data.message?.model;
  if (!model) return 0;
  const speed = data.message?.usage?.speed;
  return calculateCostForModel(data.message.usage, model, pricing, speed);
}

// #endregion

// #region DATA_AGGREGATION

const CACHE_TTL = 30_000;
let dataCache = {};
let cacheTimestamps = {};

function isCacheValid(key) {
  return cacheTimestamps[key] && (Date.now() - cacheTimestamps[key]) < CACHE_TTL;
}

function setCache(key, data) {
  dataCache[key] = data;
  cacheTimestamps[key] = Date.now();
}

function invalidateAllCache() {
  dataCache = {};
  cacheTimestamps = {};
}

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildFilledDaily(dailyCosts, start, end) {
  const filled = [];
  if (Object.keys(dailyCosts).length > 0) {
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = localDateStr(d);
      filled.push({ date: ds, cost: dailyCosts[ds] || 0 });
    }
  }
  return filled;
}

function buildModelDistribution(modelCosts) {
  return Object.entries(modelCosts)
    .filter(([model, cost]) => cost > 0 && !model.startsWith('<'))
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost);
}

function scanProjectDirs(cutoffDate) {
  const projects = new Map();
  const cutoffMs = cutoffDate ? cutoffDate.getTime() : 0;
  for (const baseDir of getProjectsDirs()) {
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projDir = path.join(baseDir, entry.name);
        const files = [];
        try {
          for (const f of fs.readdirSync(projDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const filePath = path.join(projDir, f);
            // Skip files not modified since cutoff date
            if (cutoffMs) {
              try {
                const mtime = fs.statSync(filePath).mtimeMs;
                if (mtime < cutoffMs) continue;
              } catch { continue; }
            }
            files.push(filePath);
          }
        } catch { /* ignore */ }
        if (files.length > 0) {
          const key = entry.name;
          if (!projects.has(key)) {
            projects.set(key, { encodedPath: key, dir: projDir, files });
          } else {
            projects.get(key).files.push(...files);
          }
        }
      }
    } catch { /* dir doesn't exist */ }
  }
  return projects;
}

function decodeProjectPath(encoded) {
  try {
    // Claude encodes paths as: C--Users-name-dev-project
    // "C--" = drive prefix, then "-" separates path segments
    // But hyphens in actual folder names also become "-" (ambiguous)
    // Strategy: strip known prefixes to reveal project name
    let name = encoded;
    // Strip drive + common base paths: C--Users-username-dev- or similar
    name = name.replace(/^[A-Z]--[^-]+-[^-]+-(dev|src|repos|projects|work|code)-/, '');
    // Strip C--Users-username--config- or C--Users-username--claude- patterns
    name = name.replace(/^[A-Z]--[^-]+-[^-]+--([^-]+)-/, '$1/');
    // Strip C--Users-username- if still there
    name = name.replace(/^[A-Z]--[^-]+-[^-]+-/, '');
    return name || encoded;
  } catch { return encoded; }
}

function getSessionIdFromFile(filePath) {
  return path.basename(filePath, '.jsonl');
}

async function loadProjectData(files, pricing) {
  const sessions = new Map();
  const seen = new Set();

  for (const file of files) {
    const sessionId = getSessionIdFromFile(file);
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        sessionId,
        totalCost: 0,
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        messages: [],
        models: new Set(),
        firstPrompt: '',
        customTitle: null,
        firstTimestamp: null,
        lastTimestamp: null,
      });
    }
    const session = sessions.get(sessionId);

    await processJSONLFile(file, async (line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { return; }

      if (parsed.type === 'custom-title' && parsed.customTitle) {
        session.customTitle = parsed.customTitle;
        return;
      }

      if (!parsed.message?.usage?.input_tokens && parsed.message?.usage?.input_tokens !== 0) return;
      if (!parsed.timestamp) return;

      const hash = createDedupeHash(parsed);
      if (hash && seen.has(hash)) return;
      if (hash) seen.add(hash);

      const cost = calculateEntryCost(parsed, pricing);
      const usage = parsed.message.usage;
      const model = parsed.message?.model || 'unknown';
      const ts = parsed.timestamp;

      session.totalCost += cost;
      session.inputTokens += usage.input_tokens || 0;
      session.outputTokens += usage.output_tokens || 0;
      session.cacheCreationTokens += (usage.cache_creation_input_tokens || 0);
      session.cacheReadTokens += (usage.cache_read_input_tokens || 0);
      session.models.add(model);

      if (!session.firstTimestamp || ts < session.firstTimestamp) session.firstTimestamp = ts;
      if (!session.lastTimestamp || ts > session.lastTimestamp) session.lastTimestamp = ts;

      session.messages.push({
        timestamp: ts,
        model,
        cost,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        speed: usage.speed || 'standard',
      });

      // Capture first user prompt from the JSONL (look for human/user messages)
      if (!session.firstPrompt && parsed.type === 'human' && parsed.message?.content) {
        const content = Array.isArray(parsed.message.content)
          ? parsed.message.content.map(c => c.text || '').join(' ')
          : (typeof parsed.message.content === 'string' ? parsed.message.content : '');
        if (content.trim()) {
          session.firstPrompt = content.trim().slice(0, 120);
        }
      }
    });
  }

  return sessions;
}

async function getOverviewData(days) {
  const cacheKey = `overview_${days}`;
  if (isCacheValid(cacheKey)) return dataCache[cacheKey];

  const pricing = await fetchPricing();
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  const projects = scanProjectDirs(cutoff);
  const cutoffStr = cutoff.toISOString();

  let totalCost = 0, totalSessions = 0;
  let totalInput = 0, totalOutput = 0, totalCacheCreation = 0, totalCacheRead = 0;
  const dailyCosts = {};
  const modelCosts = {};
  const projectSummaries = [];

  for (const [encodedPath, proj] of projects) {
    const sessions = await loadProjectData(proj.files, pricing);
    let projCost = 0, projSessions = 0, projLastActive = null;
    const projModels = new Set();

    for (const [, session] of sessions) {
      // Filter messages within date range
      const inRange = session.messages.filter(m => m.timestamp >= cutoffStr);
      if (inRange.length === 0) continue;

      let sessionCost = 0, sessionInput = 0, sessionOutput = 0, sessionCacheCreation = 0, sessionCacheRead = 0;
      for (const m of inRange) {
        sessionCost += m.cost;
        sessionInput += m.inputTokens;
        sessionOutput += m.outputTokens;
        sessionCacheCreation += m.cacheCreationTokens;
        sessionCacheRead += m.cacheReadTokens;
        const day = localDateStr(new Date(m.timestamp));
        dailyCosts[day] = (dailyCosts[day] || 0) + m.cost;
        if (m.model && !m.model.startsWith('<')) {
          modelCosts[m.model] = (modelCosts[m.model] || 0) + m.cost;
          projModels.add(m.model);
        }
        if (!projLastActive || m.timestamp > projLastActive) projLastActive = m.timestamp;
      }

      totalCost += sessionCost;
      totalInput += sessionInput;
      totalOutput += sessionOutput;
      totalCacheCreation += sessionCacheCreation;
      totalCacheRead += sessionCacheRead;
      totalSessions++;
      projCost += sessionCost;
      projSessions++;
    }

    if (projSessions > 0) {
      projectSummaries.push({
        encodedPath,
        name: decodeProjectPath(encodedPath),
        totalCost: projCost,
        sessionCount: projSessions,
        lastActive: projLastActive,
        primaryModel: [...projModels].sort((a, b) => (modelCosts[b] || 0) - (modelCosts[a] || 0))[0] || 'unknown',
      });
    }
  }

  const dailyStart = new Date(cutoff);
  dailyStart.setHours(0, 0, 0, 0);
  const filledDaily = buildFilledDaily(dailyCosts, dailyStart, now);

  const todayStr = localDateStr(now);
  const todayCost = dailyCosts[todayStr] || 0;

  const totalInputAll = totalInput + totalCacheCreation + totalCacheRead;
  const cacheEfficiency = totalInputAll > 0 ? totalCacheRead / totalInputAll : 0;

  const modelDistribution = buildModelDistribution(modelCosts);

  const result = {
    summary: {
      totalCost, todayCost,
      totalSessions,
      totalTokens: totalInput + totalOutput + totalCacheCreation + totalCacheRead,
      totalInput, totalOutput, totalCacheCreation, totalCacheRead,
      cacheEfficiency,
    },
    daily: filledDaily,
    modelDistribution,
    projects: projectSummaries.sort((a, b) => b.totalCost - a.totalCost),
  };

  setCache(cacheKey, result);
  return result;
}

async function getProjectsData(days) {
  const cacheKey = `projects_${days || 'all'}`;
  if (isCacheValid(cacheKey)) return dataCache[cacheKey];

  const pricing = await fetchPricing();
  const now = new Date();
  const cutoff = days ? new Date(now) : null;
  if (cutoff) cutoff.setDate(cutoff.getDate() - days);
  const projects = scanProjectDirs(cutoff);
  const cutoffStr = cutoff ? cutoff.toISOString() : null;
  const result = [];

  for (const [encodedPath, proj] of projects) {
    const sessions = await loadProjectData(proj.files, pricing);
    let totalCost = 0, sessionCount = 0, lastActive = null;
    const models = new Set();

    for (const [, session] of sessions) {
      const msgs = cutoffStr
        ? session.messages.filter(m => m.timestamp >= cutoffStr)
        : session.messages;
      if (msgs.length === 0) continue;

      const cost = msgs.reduce((s, m) => s + m.cost, 0);
      totalCost += cost;
      sessionCount++;
      for (const m of session.models) models.add(m);
      if (!lastActive || (session.lastTimestamp && session.lastTimestamp > lastActive)) {
        lastActive = session.lastTimestamp;
      }
    }

    if (sessionCount > 0) {
      result.push({
        encodedPath,
        name: decodeProjectPath(encodedPath),
        totalCost,
        sessionCount,
        lastActive,
        primaryModel: [...models][0] || 'unknown',
      });
    }
  }

  const sorted = result.sort((a, b) => b.totalCost - a.totalCost);
  setCache(cacheKey, sorted);
  return sorted;
}

async function getProjectSessionsData(encodedPath, days) {
  const cacheKey = `sessions_${encodedPath}_${days || 'all'}`;
  if (isCacheValid(cacheKey)) return dataCache[cacheKey];

  const pricing = await fetchPricing();
  const now = new Date();
  const cutoff = days ? new Date(now) : null;
  if (cutoff) cutoff.setDate(cutoff.getDate() - days);
  const projects = scanProjectDirs(cutoff);
  const proj = projects.get(encodedPath);
  if (!proj) return [];

  const sessions = await loadProjectData(proj.files, pricing);
  const cutoffStr = cutoff ? cutoff.toISOString() : null;
  const result = [];
  const dailyCosts = {};
  const modelCosts = {};

  for (const [, session] of sessions) {
    const msgs = cutoffStr
      ? session.messages.filter(m => m.timestamp >= cutoffStr)
      : session.messages;
    if (msgs.length === 0) continue;

    let cost = 0, input = 0, output = 0, cacheCreation = 0, cacheRead = 0;
    for (const m of msgs) {
      cost += m.cost; input += m.inputTokens; output += m.outputTokens;
      cacheCreation += m.cacheCreationTokens; cacheRead += m.cacheReadTokens;
      const day = localDateStr(new Date(m.timestamp));
      dailyCosts[day] = (dailyCosts[day] || 0) + m.cost;
      if (m.model && !m.model.startsWith('<')) {
        modelCosts[m.model] = (modelCosts[m.model] || 0) + m.cost;
      }
    }
    const durationMs = session.firstTimestamp && session.lastTimestamp
      ? new Date(session.lastTimestamp) - new Date(session.firstTimestamp)
      : 0;

    result.push({
      sessionId: session.sessionId,
      customTitle: session.customTitle,
      totalCost: cost,
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
      totalTokens: input + output + cacheCreation + cacheRead,
      messageCount: msgs.length,
      models: [...session.models],
      primaryModel: [...session.models][0] || 'unknown',
      firstPrompt: session.firstPrompt,
      firstTimestamp: session.firstTimestamp,
      lastTimestamp: session.lastTimestamp,
      durationMinutes: Math.round(durationMs / 60000),
    });
  }

  let dailyStart;
  if (cutoff) {
    dailyStart = new Date(cutoff);
    dailyStart.setHours(0, 0, 0, 0);
  } else {
    const dates = Object.keys(dailyCosts).sort();
    dailyStart = dates.length ? new Date(dates[0] + 'T00:00:00') : now;
  }
  const dailyEnd = now;
  const filledDaily = buildFilledDaily(dailyCosts, dailyStart, dailyEnd);

  const modelDistribution = buildModelDistribution(modelCosts);

  const sorted = result.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
  const response = { sessions: sorted, daily: filledDaily, modelDistribution };
  setCache(cacheKey, response);
  return response;
}

async function getSessionDetailData(sessionId) {
  const cacheKey = `detail_${sessionId}`;
  if (isCacheValid(cacheKey)) return dataCache[cacheKey];

  const pricing = await fetchPricing();
  const projects = scanProjectDirs();

  // Find the session across all projects
  for (const [encodedPath, proj] of projects) {
    const matchingFile = proj.files.find(f => getSessionIdFromFile(f) === sessionId);
    if (!matchingFile) continue;

    const sessions = await loadProjectData([matchingFile], pricing);
    const session = sessions.get(sessionId);
    if (!session) continue;

    // Sort messages by timestamp
    session.messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Add cumulative cost
    let cumulative = 0;
    const messages = session.messages.map((m, i) => {
      cumulative += m.cost;
      return { ...m, index: i + 1, cumulativeCost: cumulative };
    });

    const result = {
      sessionId,
      customTitle: session.customTitle,
      projectPath: decodeProjectPath(encodedPath),
      encodedProjectPath: encodedPath,
      totalCost: session.totalCost,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      cacheCreationTokens: session.cacheCreationTokens,
      cacheReadTokens: session.cacheReadTokens,
      models: [...session.models],
      firstPrompt: session.firstPrompt,
      firstTimestamp: session.firstTimestamp,
      lastTimestamp: session.lastTimestamp,
      messages,
    };

    setCache(cacheKey, result);
    return result;
  }

  return null;
}

// #endregion

// #region EXPRESS

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/hub-config', (_req, res) => {
  res.json({ enabled: !!process.env.CLAUDE_HUB, url: process.env.HUB_URL || null });
});

app.get('/api/overview', async (req, res) => {
  try {
    const range = parseInt(req.query.range) || 30;
    const data = await getOverviewData(range);
    res.json(data);
  } catch (err) {
    console.error('[API] overview error:', err);
    res.status(500).json({ error: 'Failed to load overview data' });
  }
});

app.get('/api/projects', async (req, res) => {
  try {
    const range = req.query.range ? parseInt(req.query.range) : null;
    const data = await getProjectsData(range);
    res.json(data);
  } catch (err) {
    console.error('[API] projects error:', err);
    res.status(500).json({ error: 'Failed to load projects data' });
  }
});

app.get('/api/projects/:path/sessions', async (req, res) => {
  try {
    const range = req.query.range ? parseInt(req.query.range) : null;
    const data = await getProjectSessionsData(req.params.path, range);
    res.json(data);
  } catch (err) {
    console.error('[API] sessions error:', err);
    res.status(500).json({ error: 'Failed to load sessions data' });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const data = await getSessionDetailData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Session not found' });
    res.json(data);
  } catch (err) {
    console.error('[API] session detail error:', err);
    res.status(500).json({ error: 'Failed to load session detail' });
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

const server = app.listen(PORT, () => {
  const actualPort = server.address().port;
  console.log(`Claude Code Cost Dashboard running at http://localhost:${actualPort}`);

  if (process.argv.includes('--open')) {
    import('open').then(mod => mod.default(`http://localhost:${actualPort}`));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use, trying random port...`);
    const fallback = app.listen(0, () => {
      const p = fallback.address().port;
      console.log(`Claude Code Cost Dashboard running at http://localhost:${p}`);
      if (process.argv.includes('--open')) {
        import('open').then(mod => mod.default(`http://localhost:${p}`));
      }
    });
  } else {
    throw err;
  }
});

// Pre-fetch pricing on startup
fetchPricing().catch(() => {});

// #endregion
