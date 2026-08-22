#!/usr/bin/env node
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createReadStream } = require('fs');
const { createInterface } = require('readline');
const os = require('os');
const { createNetGuard } = require('./lib/net-guard');

// #region CLI_ARGS

function getArg(name) {
  const eqIdx = process.argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (eqIdx === -1) return null;
  const arg = process.argv[eqIdx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return process.argv[eqIdx + 1] || null;
}

const PORT = getArg('port') || process.env.PORT || 3543;
const claudeDirArg = getArg('dir') || process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_DIR;
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

function extractTools(content) {
  if (!Array.isArray(content)) return null;
  const tools = content
    .filter(c => c.type === 'tool_use' && c.name)
    .map(c => c.name);
  return tools.length > 0 ? tools : null;
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

// Custom from/to windows make the key space unbounded, so the cache is capped, which would
// otherwise grow for the process lifetime. A Map keeps insertion order, so the oldest write is
// always the first key — no sort, no key array.
const MAX_CACHE_ENTRIES = 50;
const dataCache = new Map();

// undefined means "no usable entry": every cached payload is an object or an array, so it can
// never collide with a real one. A stale hit is dropped here rather than left resident until the
// cap pushes it out — detail_<id> entries carry a whole message array.
function getCache(key) {
  const hit = dataCache.get(key);
  if (!hit) return undefined;
  if ((Date.now() - hit.ts) >= CACHE_TTL) {
    dataCache.delete(key);
    return undefined;
  }
  return hit.data;
}

function setCache(key, data) {
  // Re-inserting moves an existing key to the back, so a rewrite resets its eviction priority.
  dataCache.delete(key);
  dataCache.set(key, { data, ts: Date.now() });
  while (dataCache.size > MAX_CACHE_ENTRIES) {
    dataCache.delete(dataCache.keys().next().value);
  }
}

function invalidateAllCache() {
  dataCache.clear();
}

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localHourStr(d) {
  return `${localDateStr(d)}T${String(d.getHours()).padStart(2, '0')}`;
}

// Cost is bucketed by one of these; the key doubles as the aggregation key and the wire label.
// An hour key extends the day key (YYYY-MM-DD -> YYYY-MM-DDTHH), so a startsWith test on a day
// string matches either granularity.
const BUCKETS = {
  day: {
    key: localDateStr,
    floor: (d) => d.setHours(0, 0, 0, 0),
    next: (d) => d.setDate(d.getDate() + 1),
  },
  hour: {
    key: localHourStr,
    floor: (d) => d.setMinutes(0, 0, 0),
    next: (d) => d.setHours(d.getHours() + 1),
  },
};

// A one-day window collapses the daily chart into a single bar, so those ranges bucket by hour.
function rangeBucket(range) {
  if (isCustomRange(range)) return range.from === range.to ? 'hour' : 'day';
  return range === 'today' || range === '24h' || range === 1 ? 'hour' : 'day';
}

// Non-real (synthetic) models group under 'other' so the series still sums to the true
// bucket total, unlike modelDistribution which drops them entirely.
function addBucketModelCost(acc, key, model, cost) {
  const mk = isRealModel(model) ? model : 'other';
  (acc[key] ||= {})[mk] = (acc[key][mk] || 0) + cost;
}

// Gap-filled so empty buckets stay visible in the chart. The bucket total is derived from
// the per-model map, so the two can never disagree.
function buildCostSeries(modelCostsByBucket, start, end, bucket) {
  const b = BUCKETS[bucket];
  const points = [];
  if (Object.keys(modelCostsByBucket).length === 0) return points;
  const d = new Date(start);
  b.floor(d);
  for (; d <= end; b.next(d)) {
    const k = b.key(d);
    const byModel = modelCostsByBucket[k] || {};
    points.push({ key: k, cost: Object.values(byModel).reduce((s, v) => s + v, 0), byModel });
  }
  return points;
}

function buildModelDistribution(modelCosts) {
  return Object.entries(modelCosts)
    .filter(([model, cost]) => cost > 0 && isRealModel(model))
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost);
}

// onlyKey narrows the scan to a single encoded project dir. The dir name *is* the key, so this
// skips the per-project readdir and per-file statSync for everything else.
function scanProjectDirs(cutoffDate, onlyKey) {
  const projects = new Map();
  const cutoffMs = cutoffDate ? cutoffDate.getTime() : 0;
  for (const baseDir of getProjectsDirs()) {
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (onlyKey && entry.name !== onlyKey) continue;
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

function scanSubagentDir(sessionDir) {
  const subagentsDir = path.join(sessionDir, 'subagents');
  const result = [];
  try {
    for (const f of fs.readdirSync(subagentsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const agentId = f.replace('.jsonl', '');
      const metaPath = path.join(subagentsDir, `${agentId}.meta.json`);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* no meta */ }
      result.push({
        agentId,
        filePath: path.join(subagentsDir, f),
        agentType: meta.agentType || 'unknown',
        description: meta.description || '',
      });
    }
  } catch { /* dir doesn't exist or unreadable */ }
  return result;
}

// `<synthetic>` and friends are Claude Code bookkeeping entries, not models the user chose.
function isRealModel(model) {
  return !!model && !model.startsWith('<');
}

function mostFrequentModel(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
}

async function loadSubagentData(subagentInfos, pricing) {
  return Promise.all(subagentInfos.map(async (info) => {
    const agent = {
      agentId: info.agentId,
      agentType: info.agentType,
      description: info.description,
      totalCost: 0,
      inputTokens: 0, outputTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 0,
      messageCount: 0,
      models: new Set(),
      firstTimestamp: null,
    };
    const seen = new Set();
    await processJSONLFile(info.filePath, async (line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { return; }
      if (!parsed.message?.usage?.input_tokens && parsed.message?.usage?.input_tokens !== 0) return;
      if (!parsed.timestamp) return;

      const hash = createDedupeHash(parsed);
      if (hash && seen.has(hash)) return;
      if (hash) seen.add(hash);

      const cost = calculateEntryCost(parsed, pricing);
      const usage = parsed.message.usage;
      agent.totalCost += cost;
      agent.inputTokens += usage.input_tokens || 0;
      agent.outputTokens += usage.output_tokens || 0;
      agent.cacheCreationTokens += (usage.cache_creation_input_tokens || 0);
      agent.cacheReadTokens += (usage.cache_read_input_tokens || 0);
      agent.messageCount++;
      agent.models.add(parsed.message?.model || 'unknown');
      if (!agent.firstTimestamp || parsed.timestamp < agent.firstTimestamp) {
        agent.firstTimestamp = parsed.timestamp;
      }
    });
    agent.models = [...agent.models];
    return agent;
  }));
}

async function loadProjectData(files, pricing) {
  const sessions = new Map();
  // hash -> pushed message, so tool_use blocks from duplicate lines can be folded in.
  const seen = new Map();

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
      if (hash && seen.has(hash)) {
        // Streaming writes one JSONL line per content block of the same API message. Usage is
        // identical on every line (deduped), but each line carries different tool_use blocks,
        // so tools must be unioned across duplicates or most calls are lost.
        const dupTools = extractTools(parsed.message?.content);
        if (dupTools) {
          const orig = seen.get(hash);
          orig.tools = (orig.tools || []).concat(dupTools);
        }
        return;
      }

      const cost = calculateEntryCost(parsed, pricing);
      const usage = parsed.message.usage;
      const model = parsed.message?.model || 'unknown';
      const ts = parsed.timestamp;

      session.totalCost += cost;
      session.inputTokens += usage.input_tokens || 0;
      session.outputTokens += usage.output_tokens || 0;
      session.cacheCreationTokens += (usage.cache_creation_input_tokens || 0);
      session.cacheReadTokens += (usage.cache_read_input_tokens || 0);
      if (isRealModel(model)) session.models.add(model);

      if (!session.firstTimestamp || ts < session.firstTimestamp) session.firstTimestamp = ts;
      if (!session.lastTimestamp || ts > session.lastTimestamp) session.lastTimestamp = ts;

      const msg = {
        timestamp: ts,
        model,
        cost,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        speed: usage.speed || 'standard',
        tools: extractTools(parsed.message?.content),
      };
      session.messages.push(msg);
      if (hash) seen.set(hash, msg);

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

    // Fold subagent costs into session totals
    const sessionDir = path.join(path.dirname(file), sessionId);
    const subagentInfos = scanSubagentDir(sessionDir);
    if (subagentInfos.length > 0) {
      const subagents = await loadSubagentData(subagentInfos, pricing);
      for (const sa of subagents) {
        session.totalCost += sa.totalCost;
        session.inputTokens += sa.inputTokens;
        session.outputTokens += sa.outputTokens;
        session.cacheCreationTokens += sa.cacheCreationTokens;
        session.cacheReadTokens += sa.cacheReadTokens;
        for (const m of sa.models) if (isRealModel(m)) session.models.add(m);
        session.messages.push({
          timestamp: sa.firstTimestamp || session.firstTimestamp,
          model: sa.models[0] || 'unknown',
          cost: sa.totalCost,
          inputTokens: sa.inputTokens,
          outputTokens: sa.outputTokens,
          cacheCreationTokens: sa.cacheCreationTokens,
          cacheReadTokens: sa.cacheReadTokens,
          speed: 'standard',
          _subagent: { agentId: sa.agentId, agentType: sa.agentType, description: sa.description, messageCount: sa.messageCount },
        });
      }
    }
  }

  return sessions;
}

// A range is either a preset — 'today', '24h', the last N calendar days, or null for all time, all
// anchored to the request — or a custom window of two local YYYY-MM-DD dates.
function isCustomRange(range) {
  return !!range && typeof range === 'object' && !!range.from && !!range.to;
}

function localDayStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

// `to` names a whole day, so the window runs through the end of it — a midnight bound would
// silently drop that day's data.
function localDayEnd(dateStr) {
  const d = localDayStart(dateStr);
  d.setHours(23, 59, 59, 999);
  return d;
}

function rangeToCutoff(range, now) {
  if (isCustomRange(range)) return localDayStart(range.from);
  if (range === 'today') {
    const c = new Date(now);
    c.setHours(0, 0, 0, 0);
    return c;
  }
  // The one rolling preset left, and the reason it is labelled in hours: no midnight snap, so it
  // spans two calendar days.
  if (range === '24h') return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (!range) return null;
  // N calendar days ending today: identical to from=today-(N-1)&to=today, so the chart draws
  // exactly N buckets instead of N+1 with a partial leading one.
  const c = new Date(now);
  c.setDate(c.getDate() - (range - 1));
  c.setHours(0, 0, 0, 0);
  return c;
}

// The window's upper bound, which used to be an implicit `now` in six places. Presets are rolling,
// so theirs still is; a custom window ends with its `to` day.
function rangeToEnd(range, now) {
  return isCustomRange(range) ? localDayEnd(range.to) : new Date(now);
}

// Presets keep an open upper bound: they end at "whenever this request lands", so filtering
// against a captured `now` would only ever drop rows a live session wrote mid-request.
function windowEndStr(range, windowEnd) {
  return isCustomRange(range) ? windowEnd.toISOString() : null;
}

// True when today falls inside the window. A null cutoff means open toward the past.
function windowContainsToday(cutoff, windowEnd, now) {
  const todayStr = localDateStr(now);
  return (!cutoff || localDateStr(cutoff) <= todayStr) && localDateStr(windowEnd) >= todayStr;
}

// Everything a range resolves to, anchored to one captured `now` so the bounds of a single request
// can never disagree with each other. `cutoff` stays null for the all-time range.
function resolveWindow(range, now = new Date()) {
  const cutoff = rangeToCutoff(range, now);
  const end = rangeToEnd(range, now);
  return {
    now, cutoff, end,
    cutoffStr: cutoff ? cutoff.toISOString() : null,
    endStr: windowEndStr(range, end),
    hasToday: windowContainsToday(cutoff, end, now),
  };
}

// Two-sided when the window has an end, so a window that stops in the past excludes later
// messages. A null bound means open in that direction.
function filterWindow(messages, fromStr, toStr) {
  if (!fromStr && !toStr) return messages;
  return messages.filter((m) => (!fromStr || m.timestamp >= fromStr) && (!toStr || m.timestamp <= toStr));
}

// Custom windows key by their dates, which is why the cache is capped (see MAX_CACHE_ENTRIES).
function rangeKey(range) {
  if (isCustomRange(range)) return `${range.from}_${range.to}`;
  return range || 'all';
}

// True when the window is exactly today — a preset 'today' or a single-day pick landing on it.
function isTodayRange(range, now) {
  if (isCustomRange(range)) return range.from === range.to && range.to === localDateStr(now);
  return range === 'today';
}

function summarizeMessages(msgs) {
  const sum = { messageCount: msgs.length, totalCost: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  for (const m of msgs) {
    sum.totalCost += m.cost;
    sum.inputTokens += m.inputTokens;
    sum.outputTokens += m.outputTokens;
    sum.cacheCreationTokens += m.cacheCreationTokens;
    sum.cacheReadTokens += m.cacheReadTokens;
  }
  return sum;
}

async function getOverviewData(range, projectFilter) {
  const cacheKey = `overview_${rangeKey(range)}_${projectFilter || 'all'}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;

  const pricing = await fetchPricing();
  const w = resolveWindow(range);
  const now = w.now;
  // The series needs a concrete start even for the all-time range, so a null cutoff falls back to
  // now. Deliberately local: pushing it into resolveWindow would hand the other callers a non-null
  // all-time cutoff and change what they filter on.
  const cutoff = w.cutoff || w.now;
  const windowEnd = w.end;
  const projects = scanProjectDirs(cutoff, projectFilter);
  const cutoffStr = cutoff.toISOString();
  const endStr = w.endStr;

  let totalCost = 0, totalSessions = 0;
  let totalInput = 0, totalOutput = 0, totalCacheCreation = 0, totalCacheRead = 0;
  const bucket = rangeBucket(range);
  const bucketKey = BUCKETS[bucket].key;
  const bucketModelCosts = {};
  const modelCosts = {};
  const projectSummaries = [];

  for (const [encodedPath, proj] of projects) {
    const sessions = await loadProjectData(proj.files, pricing);
    let projCost = 0, projSessions = 0, projLastActive = null;
    const projModels = new Set();

    for (const [, session] of sessions) {
      // Filter messages within date range
      const inRange = filterWindow(session.messages, cutoffStr, endStr);
      if (inRange.length === 0) continue;

      let sessionCost = 0, sessionInput = 0, sessionOutput = 0, sessionCacheCreation = 0, sessionCacheRead = 0;
      for (const m of inRange) {
        sessionCost += m.cost;
        sessionInput += m.inputTokens;
        sessionOutput += m.outputTokens;
        sessionCacheCreation += m.cacheCreationTokens;
        sessionCacheRead += m.cacheReadTokens;
        const k = bucketKey(new Date(m.timestamp));
        addBucketModelCost(bucketModelCosts, k, m.model, m.cost);
        if (isRealModel(m.model)) {
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

  const costSeries = buildCostSeries(bucketModelCosts, cutoff, windowEnd, bucket);

  // The today slice is scoped to the window. A window that ends before today has no today bucket,
  // and a 0 there reads as "nothing spent today" rather than "outside the selected window" — so it
  // is reported as null and the card is dropped instead.
  const todayStr = localDateStr(now);
  const todayCost = w.hasToday
    ? costSeries.filter((p) => p.key.startsWith(todayStr)).reduce((s, p) => s + p.cost, 0)
    : null;

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
    costSeries: { bucket, points: costSeries },
    modelDistribution,
    projects: projectSummaries.sort((a, b) => b.totalCost - a.totalCost),
  };

  setCache(cacheKey, result);
  return result;
}

async function getProjectsData(range, projectFilter) {
  const cacheKey = `projects_${rangeKey(range)}_${projectFilter || 'all'}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;

  const pricing = await fetchPricing();
  const w = resolveWindow(range);
  const projects = scanProjectDirs(w.cutoff, projectFilter);
  const result = [];

  for (const [encodedPath, proj] of projects) {
    const sessions = await loadProjectData(proj.files, pricing);
    let totalCost = 0, sessionCount = 0, lastActive = null;
    const projModelCounts = {};

    for (const [, session] of sessions) {
      const msgs = filterWindow(session.messages, w.cutoffStr, w.endStr);
      if (msgs.length === 0) continue;

      const cost = msgs.reduce((s, m) => s + m.cost, 0);
      totalCost += cost;
      sessionCount++;
      for (const m of msgs) {
        if (isRealModel(m.model)) {
          projModelCounts[m.model] = (projModelCounts[m.model] || 0) + 1;
        }
      }
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
        primaryModel: mostFrequentModel(projModelCounts),
      });
    }
  }

  const sorted = result.sort((a, b) => b.totalCost - a.totalCost);
  setCache(cacheKey, sorted);
  return sorted;
}

async function getProjectSessionsData(encodedPath, range) {
  const cacheKey = `sessions_${encodedPath}_${rangeKey(range)}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;

  const pricing = await fetchPricing();
  const w = resolveWindow(range);
  const projects = scanProjectDirs(w.cutoff);
  const proj = projects.get(encodedPath);
  const bucket = rangeBucket(range);
  if (!proj) return { sessions: [], costSeries: { bucket, points: [] }, modelDistribution: [] };

  const sessions = await loadProjectData(proj.files, pricing);
  const result = [];
  const bucketKey = BUCKETS[bucket].key;
  const bucketModelCosts = {};
  const modelCosts = {};

  for (const [, session] of sessions) {
    const msgs = filterWindow(session.messages, w.cutoffStr, w.endStr);
    if (msgs.length === 0) continue;

    const sum = summarizeMessages(msgs);
    const sessionModelCounts = {};
    for (const m of msgs) {
      const k = bucketKey(new Date(m.timestamp));
      addBucketModelCost(bucketModelCosts, k, m.model, m.cost);
      if (isRealModel(m.model)) {
        modelCosts[m.model] = (modelCosts[m.model] || 0) + m.cost;
        sessionModelCounts[m.model] = (sessionModelCounts[m.model] || 0) + 1;
      }
    }
    const durationMs = session.firstTimestamp && session.lastTimestamp
      ? new Date(session.lastTimestamp) - new Date(session.firstTimestamp)
      : 0;
    const primaryModel = mostFrequentModel(sessionModelCounts);

    result.push({
      sessionId: session.sessionId,
      customTitle: session.customTitle,
      ...sum,
      totalTokens: sum.inputTokens + sum.outputTokens + sum.cacheCreationTokens + sum.cacheReadTokens,
      models: [...session.models],
      primaryModel,
      firstPrompt: session.firstPrompt,
      firstTimestamp: session.firstTimestamp,
      lastTimestamp: session.lastTimestamp,
      durationMinutes: Math.round(durationMs / 60000),
    });
  }

  // No range means "everything", so the series starts at the first bucket that has cost.
  let seriesStart = w.cutoff;
  if (!seriesStart) {
    const keys = Object.keys(bucketModelCosts).sort();
    seriesStart = keys.length ? new Date(`${keys[0]}T00:00:00`) : w.now;
  }
  const costSeries = buildCostSeries(bucketModelCosts, seriesStart, w.end, bucket);

  const modelDistribution = buildModelDistribution(modelCosts);

  const sorted = result.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
  const response = {
    sessions: sorted,
    costSeries: { bucket, points: costSeries },
    modelDistribution,
  };
  setCache(cacheKey, response);
  return response;
}

// The detail view is always the whole session, unlike every other view. `inRange`/`today` carry
// the slices the UI needs to reconcile itself with the range-scoped session row that linked here,
// instead of silently disagreeing with it. They are derived outside the cache so switching ranges
// does not re-parse the session's JSONL.
function withSessionSlices(base, range) {
  const w = resolveWindow(range);
  const slice = (fromStr) => summarizeMessages(filterWindow(base.messages, fromStr, w.endStr));
  const inRange = w.cutoffStr ? slice(w.cutoffStr) : null;
  const todayStart = rangeToCutoff('today', w.now);
  // Scoped to the window like the overview's today card: a window ending in the past has no
  // today to report, and a zeroed slice would read as "nothing spent today".
  return {
    ...base,
    range,
    inRange,
    today: isTodayRange(range, w.now) ? inRange : w.hasToday ? slice(todayStart.toISOString()) : null,
  };
}

async function getSessionDetailData(sessionId) {
  const cacheKey = `detail_${sessionId}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;

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

// Claude's usage limits work in rolling 5-hour billing windows. A block starts at the first
// activity (floored to the hour, mirroring ccusage) and spans exactly 5h; activity past the end
// opens a new block anchored to its own hour.
const BLOCK_MS = 5 * 60 * 60 * 1000;
const HEATMAP_DAYS = 7;
const MAX_BLOCKS = 24;
const MAX_TOOLS = 20;

// The real window boundary comes from Claude Code's statusline payload (rate_limits.five_hour),
// spied to disk by the cck plugin. The ccusage hour-floor heuristic can be hours off the actual
// API window, so when a live resets_at is available it anchors the active block instead.
function readRateLimits(now) {
  const dir = path.join(CLAUDE_DIR, '.cck', 'context-status');
  let newest = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(dir, f);
      try {
        const mtime = fs.statSync(fp).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { fp, mtime };
      } catch { /* ignore */ }
    }
  } catch { return null; }
  if (!newest) return null;
  try {
    const rl = JSON.parse(fs.readFileSync(newest.fp, 'utf8'))?.rate_limits;
    const fh = rl?.five_hour;
    // A resets_at in the past means the snapshot predates the current window — don't trust it.
    if (!fh?.resets_at || fh.resets_at * 1000 <= now.getTime()) return null;
    return { usedPct: fh.used_percentage ?? null, resetsAtMs: fh.resets_at * 1000 };
  } catch { return null; }
}

function computeBlocks(messages, now, realResetMs) {
  // When the API told us the live window, the active block spans exactly [reset-5h, reset].
  const activeStartMs = realResetMs && now.getTime() < realResetMs ? realResetMs - BLOCK_MS : null;
  const blocks = [];
  let cur = null;
  for (const m of messages) {
    const t = new Date(m.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    if (activeStartMs !== null && t >= activeStartMs) {
      if (!cur || cur.startMs !== activeStartMs) {
        cur = { startMs: activeStartMs, real: true, lastMs: t, cost: 0, tokens: 0, messageCount: 0, models: new Set() };
        blocks.push(cur);
      }
    } else if (!cur || t >= cur.startMs + BLOCK_MS) {
      const start = new Date(t);
      start.setMinutes(0, 0, 0);
      cur = { startMs: start.getTime(), lastMs: t, cost: 0, tokens: 0, messageCount: 0, models: new Set() };
      blocks.push(cur);
    }
    if (t > cur.lastMs) cur.lastMs = t;
    cur.cost += m.cost;
    cur.tokens += m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens;
    cur.messageCount++;
    if (isRealModel(m.model)) cur.models.add(m.model);
  }
  // A live window with no in-range messages yet still exists — surface it as an empty block.
  if (activeStartMs !== null && !blocks.some((b) => b.startMs === activeStartMs)) {
    blocks.push({ startMs: activeStartMs, real: true, lastMs: activeStartMs, cost: 0, tokens: 0, messageCount: 0, models: new Set() });
  }
  const nowMs = now.getTime();
  return blocks
    .reverse()
    .slice(0, MAX_BLOCKS)
    .map((b) => {
      const endMs = b.startMs + BLOCK_MS;
      // Only the API-anchored window counts as active: the hour-floor heuristic can be hours
      // off the real boundary, so without live data no block is presented as current.
      const active = b.real === true && nowMs < endMs;
      // Floored at 1 so a block opened seconds ago doesn't project an absurd rate.
      const elapsedMin = active ? Math.max(1, (nowMs - b.startMs) / 60000) : null;
      return {
        start: new Date(b.startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        lastActivity: new Date(b.lastMs).toISOString(),
        cost: b.cost,
        tokens: b.tokens,
        messageCount: b.messageCount,
        models: [...b.models],
        active,
        burn: active
          ? {
              costPerHour: (b.cost / elapsedMin) * 60,
              tokensPerMin: b.tokens / elapsedMin,
              projectedCost: (b.cost / elapsedMin) * (BLOCK_MS / 60000),
              remainingMin: Math.round((endMs - nowMs) / 60000),
            }
          : null,
      };
    });
}

async function getInsightsData(range, projectFilter) {
  const cacheKey = `insights_${rangeKey(range)}_${projectFilter || 'all'}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;

  const pricing = await fetchPricing();
  const w = resolveWindow(range);

  // The heatmap covers the last 7 real days ending at the selected window's end — each row
  // is an actual date, so a short range (today, 3d) still shows a full week of context.
  const windowEnd = w.end < w.now ? w.end : w.now;
  const hmStart = new Date(windowEnd);
  hmStart.setHours(0, 0, 0, 0);
  hmStart.setDate(hmStart.getDate() - (HEATMAP_DAYS - 1));
  const hmStartStr = hmStart.toISOString();
  const scanCutoff = w.cutoff === null ? null : w.cutoff < hmStart ? w.cutoff : hmStart;
  const projects = scanProjectDirs(scanCutoff, projectFilter);

  // When the cost window already covers the heatmap window, the heatmap rows are a subset of
  // `all` — filter it instead of re-scanning every session a second time.
  const hmInAll = w.cutoff === null || w.cutoff <= hmStart;
  const allParts = [];
  const hmParts = [];
  for (const [, proj] of projects) {
    const sessions = await loadProjectData(proj.files, pricing);
    for (const [, session] of sessions) {
      allParts.push(filterWindow(session.messages, w.cutoffStr, w.endStr));
      if (!hmInAll) hmParts.push(filterWindow(session.messages, hmStartStr, w.endStr));
    }
  }
  const all = allParts.flat().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const hmMsgs = hmInAll ? all.filter((m) => m.timestamp >= hmStartStr) : hmParts.flat();

  const sum = summarizeMessages(all);
  const tokens = { input: sum.inputTokens, output: sum.outputTokens, cacheCreation: sum.cacheCreationTokens, cacheRead: sum.cacheReadTokens };
  let cacheSavings = 0;
  // One row per real day, oldest first; row index = whole days since hmStart.
  const heatmap = Array.from({ length: HEATMAP_DAYS }, () => new Array(24).fill(0));
  const heatmapDays = Array.from({ length: HEATMAP_DAYS }, (_, i) => {
    const d = new Date(hmStart);
    d.setDate(d.getDate() + i);
    return localDateStr(d);
  });
  const toolCounts = {};
  let mainCost = 0;
  let subagentCost = 0;
  const weekly = {};

  // getModelPricing falls back to a linear scan of the whole LiteLLM map on a miss, so resolve
  // it once per distinct model rather than once per message.
  const priceMemo = new Map();
  for (const m of all) {
    // What the same tokens would have cost as fresh input, minus what cache reads actually cost.
    if (m.cacheReadTokens > 0) {
      if (!priceMemo.has(m.model)) priceMemo.set(m.model, getModelPricing(pricing, m.model));
      const mp = priceMemo.get(m.model);
      if (mp?.input_cost_per_token != null && mp?.cache_read_input_token_cost != null) {
        cacheSavings += m.cacheReadTokens * (mp.input_cost_per_token - mp.cache_read_input_token_cost);
      }
    }

    const monday = new Date(m.timestamp);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const wk = localDateStr(monday);
    weekly[wk] = (weekly[wk] || 0) + m.cost;

    if (m._subagent) {
      subagentCost += m.cost;
    } else {
      mainCost += m.cost;
      if (m.tools) for (const t of m.tools) toolCounts[t] = (toolCounts[t] || 0) + 1;
    }
  }

  for (const m of hmMsgs) {
    const d = new Date(m.timestamp);
    const day = new Date(d);
    day.setHours(0, 0, 0, 0);
    // Round to survive DST shifts making a "day" 23/25 hours.
    const idx = Math.round((day - hmStart) / 86400000);
    if (idx >= 0 && idx < HEATMAP_DAYS) heatmap[idx][d.getHours()] += m.cost;
  }

  const limits = readRateLimits(w.now);
  // A window ending in the past has no "current" block — don't synthesize the live window there.
  const blocks = computeBlocks(all, w.now, w.hasToday ? limits?.resetsAtMs || null : null);
  const activeBlk = blocks.find((b) => b.active);
  if (activeBlk) activeBlk.usedPct = limits?.usedPct ?? null;

  // Run-rate over the window actually observed: a custom window ending in the past uses its own
  // span; open-ended ranges run from the first message (all-time) or the cutoff to now.
  const windowStart = w.cutoff || (all.length ? new Date(all[0].timestamp) : w.now);
  const dayCount = Math.max(1, Math.ceil((windowEnd - windowStart) / 86400000));
  const dailyAvg = sum.totalCost / dayCount;

  const result = {
    tokens,
    cacheSavings,
    runRate: { dailyAvg, projectedMonthly: dailyAvg * 30, days: dayCount },
    blocks,
    heatmap,
    heatmapDays,
    heatmapToday: localDateStr(w.now),
    tools: Object.entries(toolCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_TOOLS),
    subagents: { mainCost, subagentCost },
    weekly: Object.entries(weekly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekStart, cost]) => ({ weekStart, cost })),
  };

  setCache(cacheKey, result);
  return result;
}

// #endregion

// #region EXPRESS

const app = express();

// Mounted before express.json() so a rejected request never buffers a body.
const net = createNetGuard({ appName: 'Claude Code Cost Dashboard' });
app.use(net.hostGuard);
app.use(net.frameGuard);
app.use(net.originGuard);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/hub-config', (_req, res) => {
  res.json({ enabled: !!process.env.CLAUDE_HUB, url: process.env.HUB_URL || null });
});

function parseRange(raw, fallback = null) {
  if (raw === 'today') return 'today';
  if (raw === '24h') return '24h';
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const DATE_PARAM = /^\d{4}-\d{2}-\d{2}$/;

// A local calendar date, normalized so it can safely reach a cache key — same discipline as
// parseProject. Returns undefined for absent, null for malformed.
function parseDateParam(raw) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !DATE_PARAM.test(raw)) return null;
  return localDateStr(localDayStart(raw)) === raw ? raw : null;
}

// A custom window, if the request asked for one: `from`/`to` take precedence over `range`.
// Reversed pairs are ordered and both ends clamped to today — there is no cost data ahead of now,
// and an inverted window would otherwise render as an unexplained empty chart.
// Returns undefined when no window was requested, null when one was but is malformed.
function parseCustomRange(query) {
  const from = parseDateParam(query.from);
  const to = parseDateParam(query.to);
  if (from === null || to === null) return null;
  if (from === undefined && to === undefined) return undefined;
  if (from === undefined || to === undefined) return null;
  const today = localDateStr(new Date());
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { from: lo > today ? today : lo, to: hi > today ? today : hi };
}

// Encoded project-dir name (the hub sends it pre-encoded — see encodeProjectPath in the hub's
// public/app.js; this regex must stay a superset of that transform's output). Only ever used as
// a Map key, never joined into a path — the regex exists to keep unbounded strings out of the
// cache keys.
// Returns undefined for absent, null for malformed, so callers can 400 instead of silently
// dropping the scope.
function parseProject(raw) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._-]+$/.test(raw)) return null;
  return raw;
}

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

const onReady = (actualPort) => {
  console.log(`Claude Code Cost Dashboard running at http://localhost:${actualPort}`);
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
