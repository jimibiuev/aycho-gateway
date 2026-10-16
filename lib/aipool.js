/* AYCHO module: server/lib/aipool | 多 AI 模型集群（全免费优先） */
'use strict';
const path = require('path');
const fs = require('fs');

const DEFAULT_POOL = [
  {
    id: 'agnes-3.0-flash',
    role: ['chat', 'polish', 'audit', 'pick'],
    name: 'Agnes 3.0 Flash',
    baseUrl: 'https://agnes-ai.com/v1',
    key: process.env.AGNESS_KEY || '',
    model: 'agnes-3.0-flash',
    free: true
  },
  {
    id: 'openrouter-free-mix',
    role: ['chat', 'polish', 'pick', 'transcribe'],
    name: 'OpenRouter Free Mix',
    baseUrl: 'https://openrouter.ai/api/v1',
    key: process.env.OPENROUTER_KEY || '',
    model: 'openrouter/auto',
    free: true
  },
  {
    id: 'hf-agnes',
    role: ['chat', 'polish', 'audit', 'pick'],
    name: 'HuggingFace Agnes',
    baseUrl: 'https://huggingface.co/api/models/agnes-ai/agnes-3.0-flash/endpoint',
    key: process.env.HF_TOKEN || '',
    model: 'agnes-3.0-flash',
    free: true
  },
  {
    id: 'groq-llama',
    role: ['chat', 'pick'],
    name: 'Groq Llama (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    key: process.env.GROQ_KEY || '',
    model: 'llama-3.3-70b-versatile',
    free: true
  },
  {
    id: 'deepseek-chat',
    role: ['chat', 'polish', 'audit'],
    name: 'DeepSeek (big free quota)',
    baseUrl: 'https://api.deepseek.com/v1',
    key: process.env.DEEPSEEK_KEY || '',
    model: 'deepseek-chat',
    free: true
  }
];

function loadPool() {
  const pool = DEFAULT_POOL.slice();
  try {
    const f = process.env.AYCHO_POOL_FILE || path.join(__dirname, 'aipool.json');
    if (fs.existsSync(f)) {
      const extra = JSON.parse(fs.readFileSync(f, 'utf8'));
      (Array.isArray(extra) ? extra : [extra]).forEach((e) => {
        if (e && e.id && e.baseUrl && e.model) pool.push(Object.assign({ free: false }, e));
      });
    }
  } catch (e) { /* keep default pool */ }
  const legacy = String(process.env.AYCHO_MODEL_BASE_URL || '').replace(/\/+$/, '');
  const legacyKey = String(process.env.AYCHO_MODEL_API_KEY || '');
  if (legacy && legacyKey) {
    pool.unshift({
      id: '_legacy-env',
      role: ['chat', 'polish', 'audit', 'pick', 'transcribe'],
      name: 'Env single model (AYCHO_MODEL_*)',
      baseUrl: legacy,
      key: legacyKey,
      model: String(process.env.AYCHO_MODEL_NAME || process.env.AYCHO_MODEL || 'gpt-4o-mini'),
      free: false
    });
  }
  return pool;
}

const POOL = loadPool();
const HEALTH = {};

function pick(role, preferredId) {
  const now = Date.now();
  const avail = POOL.filter((e) => {
    const h = HEALTH[e.id];
    if (h && h.cooldownUntil > now) return false;
    if (role && e.role && e.role.indexOf(role) < 0) return false;
    if (!e.key) return false;
    return true;
  });
  if (preferredId) {
    const p = avail.find((e) => e.id === preferredId);
    if (p) return p;
  }
  if (!avail.length) return null;
  avail.sort((a, b) => {
    const fa = (HEALTH[a.id] || { fails: 0 }).fails;
    const fb = (HEALTH[b.id] || { fails: 0 }).fails;
    return fa - fb;
  });
  return avail[0];
}

function fail(id) {
  const h = HEALTH[id] || (HEALTH[id] = { fails: 0, cooldownUntil: 0 });
  h.fails += 1;
  if (h.fails >= 3) { h.cooldownUntil = Date.now() + 60000; h.fails = 0; }
}
function ok(id) {
  const h = HEALTH[id] || (HEALTH[id] = { fails: 0, cooldownUntil: 0 });
  h.fails = 0;
  h.cooldownUntil = 0;
}

async function call(opts) {
  opts = opts || {};
  let entry = null, base = '', key = '', model = '';
  if (opts.model && opts.key && opts.base) {
    base = String(opts.base).replace(/\/+$/, '');
    key = opts.key; model = opts.model;
    entry = { id: '_override', name: 'request-provided model' };
  } else {
    const p = pick(opts.role || 'chat', opts.model || undefined);
    if (!p) throw new Error('No usable model: pool entries lack keys or are cooling down. Set AGNESS_KEY / OPENROUTER_KEY / HF_TOKEN / GROQ_KEY / DEEPSEEK_KEY in .env');
    entry = p; base = p.baseUrl.replace(/\/+$/, ''); key = p.key; model = p.model;
  }
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const payload = {
    model: model,
    messages: opts.messages || [],
    temperature: opts.temperature == null ? 0 : opts.temperature,
    max_tokens: opts.maxTokens || 512,
    stream: false
  };
  if (opts.extra) Object.assign(payload, opts.extra);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 30000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = (await res.text().catch(() => '')).slice(0, 200);
    fail(entry.id);
    throw Object.assign(new Error(entry.name + ' returned ' + res.status + (t ? ': ' + t : '')), { status: res.status });
  }
  const data = await res.json();
  ok(entry.id);
  const ch = data && data.choices && data.choices[0];
  return {
    text: ch && ch.message ? String(ch.message.content || '') : '',
    raw: data,
    usage: data && data.usage || null,
    entry: { id: entry.id, name: entry.name, model: model }
  };
}

async function vote(opts) {
  opts = opts || {};
  const voters = Math.max(1, Math.min(4, opts.voters || 2));
  const chosen = POOL.filter((e) => e.key && (!opts.role || (e.role || []).indexOf(opts.role) >= 0)).slice(0, voters);
  const use = chosen.length ? chosen : POOL.filter((e) => e.key).slice(0, voters);
  const jobs = use.map((e) => call({
    role: opts.role || 'audit',
    model: e.model, key: e.key, base: e.baseUrl,
    messages: opts.messages, maxTokens: opts.maxTokens || 300,
    temperature: opts.temperature == null ? 0 : opts.temperature,
    extra: opts.extra
  }).then((r) => ({ entry: r.entry, text: r.text })).catch((e2) => ({ entry: { id: e.id, name: e.name }, error: e2.message })));
  const results = await Promise.all(jobs);
  return { votes: results, allOk: results.every((r) => !r.error), anyOk: results.some((r) => !r.error) };
}

function poolStatus() {
  return POOL.map((e) => ({
    id: e.id, name: e.name, model: e.model, free: !!e.free,
    roles: e.role || [], base: e.baseUrl, hasKey: !!e.key,
    health: HEALTH[e.id] || { fails: 0, cooldownUntil: 0 }
  }));
}

module.exports = { POOL: POOL, call: call, vote: vote, pick: pick, poolStatus: poolStatus, fail: fail, ok: ok };
