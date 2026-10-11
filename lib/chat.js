/* AYCHO module: server/lib/chat | 真实大模型代理（含真实推理等级）
 * 服务端持有密钥并转发 OpenAI 兼容的 /chat/completions，向浏览器输出规范化 SSE：
 *   data: {"type":"meta","model":"…","reasoning":{level,name,effort,thinking,budget,degraded}}
 *   data: {"type":"delta","text":"…"}      正文增量
 *   data: {"type":"reason","text":"…"}     思维链增量（推理模型）
 *   data: {"type":"usage","usage":{…}}     token 用量（含 reasoning_tokens）
 *   data: {"type":"done"}                  结束
 *   data: {"type":"error","message":"…"}   错误
 *
 * 推理等级（reasoningLevel 0–5，前端可拖动设定）真实映射到上游参数：
 *   Off / Minimal / Low / Medium / High / Max
 *   → reasoning_effort（OpenAI o 系列、gpt-5 等）
 *   → thinking.budget_tokens（Claude 系）
 *   → enable_thinking + thinking_budget（Qwen / GLM / DeepSeek 等）
 * 上游若不认这些扩展字段（400/422），自动去字段重试一次并标注 degraded，保证对话不中断。
 *
 * 环境变量：AYCHO_MODEL_BASE_URL / AYCHO_MODEL_API_KEY / AYCHO_MODEL_NAME
 *           AYCHO_REASONING_PARAM = auto(默认) | reasoning_effort | thinking | enable_thinking | none
 */
'use strict';

const { sendJson, readJson } = require('./http');

const ENV_BASE = String(process.env.AYCHO_MODEL_BASE_URL || '').trim().replace(/\/+$/, '');
const ENV_KEY = String(process.env.AYCHO_MODEL_API_KEY || '').trim();
const ENV_MODEL = String(process.env.AYCHO_MODEL_NAME || 'gpt-4o-mini').trim();
const ENV_REASON_PARAM = String(process.env.AYCHO_REASONING_PARAM || 'auto').trim().toLowerCase();

/* ---------------- 推理等级表（与前端滑块一一对应） ---------------- */
const LEVEL_NAME = ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Max'];
const EFFORT_BY_LEVEL = ['', 'minimal', 'low', 'medium', 'high', 'high'];
const BUDGET_BY_LEVEL = [0, 1024, 2048, 4096, 8192, 16384];

function pick(body) {
  const base = String((body && body.baseUrl) || ENV_BASE || '').trim().replace(/\/+$/, '');
  const key = String((body && body.apiKey) || ENV_KEY || '').trim();
  const model = String((body && body.model) || ENV_MODEL || '').trim();
  return { base: base, key: key, model: model };
}

/* 归一化等级：优先 reasoningLevel；兼容旧的布尔 reasoning（false=Off，true=Medium）
 * thinkingMode=false（思考模式关闭）时强制 Off：不下发任何推理参数，保证不产生思考 token */
function thinkingOn(body) {
  if (!body) return true;
  if (body.thinkingMode === false || body.thinking === false) return false;   // 新字段 thinkingMode / 旧字段 thinking
  return true;
}

function normLevel(body) {
  if (!thinkingOn(body)) return 0;
  const raw = body && body.reasoningLevel;
  if (raw === undefined || raw === null || raw === '') {
    return (body && body.reasoning === false) ? 0 : 3;
  }
  const n = Number(raw);
  if (!isFinite(n)) return 3;
  return Math.max(0, Math.min(5, Math.round(n)));
}

function paramFamily(model) {
  if (ENV_REASON_PARAM && ENV_REASON_PARAM !== 'auto' && ENV_REASON_PARAM !== '') return ENV_REASON_PARAM;
  const m = String(model || '').toLowerCase();
  if (/claude|anthropic/.test(m)) return 'thinking';
  if (/qwen|glm|chatglm|deepseek|kimi|moonshot|minimax|hunyuan|doubao|ernie|yi-/.test(m)) return 'enable_thinking';
  return 'reasoning_effort';
}

function applyReasoning(payload, level, model) {
  const info = {
    level: level, name: LEVEL_NAME[level] || 'Medium', family: paramFamily(model),
    effort: '', thinking: false, budget: 0, degraded: false
  };
  if (level <= 0) {                    // Off：不请求推理，不下发任何推理扩展字段（最省 token 也最稳）
    info.family = 'none';
    return info;
  }
  const effort = EFFORT_BY_LEVEL[level];
  const budget = BUDGET_BY_LEVEL[level];
  if (info.family === 'none') return info;
  if (info.family === 'thinking') {
    payload.thinking = { type: 'enabled', budget_tokens: budget };
    info.thinking = true; info.budget = budget;
  } else if (info.family === 'enable_thinking') {
    payload.enable_thinking = true;
    payload.thinking_budget = budget;
    info.thinking = true; info.budget = budget;
  } else {                              // reasoning_effort（标准字段，兼容面最广）
    payload.reasoning_effort = effort;
    info.effort = effort;
  }
  /* 思考模式需要更大的输出预算：显式传了 max_tokens 时按 2 倍放大（不低于思考预算） */
  if (typeof payload.max_tokens === 'number' && info.thinking) {
    payload.max_tokens = Math.max(Math.round(payload.max_tokens * 2), budget * 2);
  }
  return info;
}

function completionsUrl(base) {
  if (!base) return '';
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

function modelsUrl(base) {
  if (!base) return '';
  if (/\/models$/.test(base)) return base;
  return base + '/models';
}

function statusHint(status) {
  if (status === 401) return '401：API Key 无效或未授权';
  if (status === 403) return '403：无权访问该模型（可能未开通或额度耗尽）';
  if (status === 404) return '404：接口不存在，请确认 Base URL 是否为 OpenAI 兼容地址（如 https://host/v1）';
  if (status === 429) return '429：请求过于频繁或额度用尽';
  if (status >= 500) return status + '：模型服务端错误，请稍后重试';
  return '请求失败 ' + status;
}

function sse(res, obj) {
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { /* 客户端可能已断开 */ }
}

async function chat(req, res) {
  const body = await readJson(req);
  const cfg = pick(body);
  if (!cfg.base) return sendJson(res, 400, { ok: false, message: '未配置模型服务地址（Base URL）' });
  if (!cfg.key) return sendJson(res, 400, { ok: false, message: '未配置模型 API Key' });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return sendJson(res, 400, { ok: false, message: 'messages 不能为空' });

  const level = normLevel(body);
  const payload = {
    model: cfg.model,
    messages: messages,
    stream: body.stream !== false
  };
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  const info = applyReasoning(payload, level, cfg.model);
  info.thinkingMode = thinkingOn(body);   // 思考模式开关（关闭时 level 已被强制为 Off）

  const url = completionsUrl(cfg.base);
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key, 'Accept': 'text/event-stream' };

  async function callUpstream() {
    try {
      return await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload) });
    } catch (e) {
      return { __netError: (e && e.message) ? e.message : String(e) };
    }
  }

  let up = await callUpstream();
  if (up && up.__netError) return sendJson(res, 502, { ok: false, message: '无法连接模型服务：' + up.__netError });

  /* 上游不认推理扩展字段 → 去掉后重试一次（真实可用优先，degraded 会在 meta 中标注） */
  if (!up.ok && (up.status === 400 || up.status === 422) && (info.effort || info.thinking)) {
    try { await up.text(); } catch (e) {}
    delete payload.reasoning_effort;
    delete payload.thinking;
    delete payload.enable_thinking;
    delete payload.thinking_budget;
    info.degraded = true; info.thinking = false; info.budget = 0; info.effort = '';
    up = await callUpstream();
    if (up && up.__netError) return sendJson(res, 502, { ok: false, message: '无法连接模型服务：' + up.__netError });
  }

  if (!up.ok) {
    let detail = '';
    try { detail = (await up.text()).slice(0, 400); } catch (e) {}
    return sendJson(res, up.status, { ok: false, message: statusHint(up.status) + (detail ? ' — ' + detail : '') });
  }

  /* ---------- 流式 ---------- */
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  /* 首帧回显真实生效的推理参数（前端据此证明等级确实作用于模型调用） */
  sse(res, {
    type: 'meta', model: cfg.model,
    reasoning: {
      level: info.level, name: info.name, family: info.family,
      thinkingMode: info.thinkingMode,
      effort: info.effort, thinking: info.thinking, budget: info.budget, degraded: info.degraded
    }
  });

  if (!up.body || typeof up.body.getReader !== 'function') {
    // 上游不支持流（或返回普通 JSON），一次性读出
    let txt = '';
    try { txt = await up.text(); } catch (e) {}
    try {
      const j = JSON.parse(txt);
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      if (msg.reasoning_content) sse(res, { type: 'reason', text: msg.reasoning_content });
      if (msg.content) sse(res, { type: 'delta', text: msg.content });
      if (j.usage) sse(res, { type: 'usage', usage: j.usage });
      sse(res, { type: 'done' });
    } catch (e) {
      sse(res, { type: 'error', message: '上游返回无法解析：' + txt.slice(0, 200) });
    }
    res.end();
    return;
  }

  const reader = up.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let finished = false;
  const abort = () => { try { reader.cancel(); } catch (e) {} };
  req.on('close', abort);

  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { finished = true; break; }
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        const ch = (j.choices && j.choices[0]) || {};
        const delta = ch.delta || ch.message || {};
        if (delta.reasoning_content) sse(res, { type: 'reason', text: String(delta.reasoning_content) });
        if (delta.content) sse(res, { type: 'delta', text: String(delta.content) });
        if (j.usage) sse(res, { type: 'usage', usage: j.usage });
      }
      if (finished) break;
    }
    sse(res, { type: 'done' });
  } catch (e) {
    sse(res, { type: 'error', message: '流式传输中断：' + (e && e.message ? e.message : String(e)) });
  }
  res.end();
}

/* ---------- 模型列表（服务端密钥可用时无需前端传 Key） ---------- */
async function models(req, res) {
  const base = ENV_BASE;
  const key = ENV_KEY;
  if (!base || !key) return sendJson(res, 400, { ok: false, message: '服务端未配置模型服务（AYCHO_MODEL_BASE_URL / AYCHO_MODEL_API_KEY）' });
  try {
    const r = await fetch(modelsUrl(base), { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } });
    const txt = await r.text();
    if (!r.ok) return sendJson(res, r.status, { ok: false, message: statusHint(r.status) + ' — ' + txt.slice(0, 200) });
    const j = JSON.parse(txt);
    const raw = Array.isArray(j) ? j : (j.data || j.models || []);
    const list = raw.map((m) => (typeof m === 'string' ? { id: m, label: m } : { id: String(m.id || m.name || ''), label: String(m.label || m.id || m.name || '') })).filter((x) => x.id);
    return sendJson(res, 200, { ok: true, models: list });
  } catch (e) {
    return sendJson(res, 502, { ok: false, message: '无法连接模型服务：' + (e && e.message ? e.message : String(e)) });
  }
}

/* ---------- 服务端模型元信息（前端用于判断是否已具备真对话能力） ---------- */
function status(req, res) {
  return sendJson(res, 200, {
    ok: true,
    modelConfigured: !!(ENV_BASE && ENV_KEY),
    defaultModel: ENV_MODEL || '',
    baseUrl: ENV_BASE || '',
    reasoning: {
      levels: LEVEL_NAME,
      efforts: EFFORT_BY_LEVEL,
      budgets: BUDGET_BY_LEVEL,
      param: ENV_REASON_PARAM || 'auto',
      family: paramFamily(ENV_MODEL)
    }
  });
}

module.exports = { chat: chat, models: models, status: status };
