/* AYCHO module: server/lib/chat | 真实大模型代理
 * 服务端持有密钥并转发 OpenAI 兼容的 /chat/completions，向浏览器输出规范化 SSE：
 *   data: {"type":"delta","text":"…"}      正文增量
 *   data: {"type":"reason","text":"…"}     思维链增量（推理模型）
 *   data: {"type":"usage","usage":{…}}     token 用量（若上游提供）
 *   data: {"type":"done"}                  结束
 *   data: {"type":"error","message":"…"}   错误
 * 密钥优先级：请求体自带的 baseUrl/apiKey（用户本机配置）> 服务端环境变量。
 *   AYCHO_MODEL_BASE_URL / AYCHO_MODEL_API_KEY / AYCHO_MODEL_NAME
 */
'use strict';

const { sendJson, readJson } = require('./http');

const ENV_BASE = String(process.env.AYCHO_MODEL_BASE_URL || '').trim().replace(/\/+$/, '');
const ENV_KEY = String(process.env.AYCHO_MODEL_API_KEY || '').trim();
const ENV_MODEL = String(process.env.AYCHO_MODEL_NAME || 'gpt-4o-mini').trim();

function pick(body) {
  const base = String((body && body.baseUrl) || ENV_BASE || '').trim().replace(/\/+$/, '');
  const key = String((body && body.apiKey) || ENV_KEY || '').trim();
  const model = String((body && body.model) || ENV_MODEL || '').trim();
  return { base: base, key: key, model: model };
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

  const payload = {
    model: cfg.model,
    messages: messages,
    stream: body.stream !== false
  };
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  if (body.reasoning === false) payload.thinking = { type: 'disabled' };

  let up;
  try {
    up = await fetch(completionsUrl(cfg.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key, 'Accept': 'text/event-stream' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return sendJson(res, 502, { ok: false, message: '无法连接模型服务：' + (e && e.message ? e.message : String(e)) });
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
    baseUrl: ENV_BASE || ''
  });
}

module.exports = { chat: chat, models: models, status: status };
