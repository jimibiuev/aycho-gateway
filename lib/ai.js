/* AYCHO module: server/lib/ai | 后端 AI 能力端点（语音转写 / 润色 / 主动技能推荐）
 * 全部走 aipool 多模型集群，用户无需自己配。
 * 路由：
 *   POST /api/ai/transcribe   { audio: base64, mime?, textHint? } -> { ok, text, model }
 *   POST /api/ai/polish       { text, model? }                     -> { ok, text, model }
 *   POST /api/ai/skill-pick   { text, skills: [{id,name,desc}] }  -> { ok, picks:[{id,reason}] }
 *   GET  /api/ai/pool         模型池健康状态
 */
'use strict';

const { sendJson, readJson } = require('./http');
const aipool = require('./aipool');

function extractJson(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

/* ---------------- 语音转写 ---------------- */
async function transcribe(req, res) {
  const body = await readJson(req);
  const audio = String(body.audio || body.data || '');
  const mime = String(body.mime || body.format || 'webm');
  const hint = String(body.textHint || body.hint || '');
  if (!audio || audio.length < 100) {
    return sendJson(res, 200, { ok: false, message: '缺少音频（audio 字段需 base64，>100 字符）' });
  }
  const messages = [
    { role: 'system', content: '你是语音转写助手。把用户发来的音频逐字转写成文字（保持原语言，不解释、不翻译、不加引号）。只输出文字。' },
    { role: 'user', content: [
      { type: 'audio', input_audio: { data: audio, format: mime } },
      { type: 'text', text: '请转写这段语音。' + (hint ? '（输入框已有上文：' + hint + '）' : '') }
    ] }
  ];
  try {
    const r = await aipool.call({
      role: 'transcribe',
      messages: messages,
      temperature: 0,
      maxTokens: 1500,
      timeoutMs: 45000
    });
    return sendJson(res, 200, { ok: true, text: r.text.trim(), model: r.entry.id, name: r.entry.name });
  } catch (e) {
    /* 多模态失败 → 降级：只提示未转写，前端保留录音块 */
    return sendJson(res, 200, { ok: false, message: 'AI 转写失败：' + (e && e.message || e) + '（需模型支持音频输入；可换池内 openrouter/deepseek 档）', raw: String(e && e.message || e).slice(0, 200) });
  }
}

/* ---------------- 提示词润色 ---------------- */
async function polish(req, res) {
  const body = await readJson(req);
  const src = String(body.text || '');
  if (!src.trim()) return sendJson(res, 200, { ok: false, message: 'text 不能为空' });
  const messages = [
    { role: 'system', content: '你是提示词润色助手。把用户输入改写成表达清晰、结构完整、可直接发送给 AI 的指令；保留原意与原语言；只输出润色后的文本本身，不要解释、不要加引号、不要 Markdown 代码块。' },
    { role: 'user', content: src }
  ];
  try {
    const r = await aipool.call({ role: 'polish', messages: messages, temperature: 0.3, maxTokens: 2000 });
    return sendJson(res, 200, { ok: true, text: r.text.trim(), model: r.entry.id, name: r.entry.name });
  } catch (e) {
    return sendJson(res, 200, { ok: false, message: '润色失败：' + (e && e.message || e) });
  }
}

/* ---------------- 主动技能推荐（AI 觉得需要就调技能） ---------------- */
async function skillPick(req, res) {
  const body = await readJson(req);
  const text = String(body.text || '');
  const skills = Array.isArray(body.skills) ? body.skills : [];
  if (!text.trim() || !skills.length) {
    return sendJson(res, 200, { ok: true, picks: [] });
  }
  const list = skills.slice(0, 40).map((s, i) => i + '. ' + (s.id || '?') + ' — ' + (s.name || '') + '：' + (s.desc || '')).join('\n');
  const messages = [
    { role: 'system', content: '你是技能调度器。根据用户消息，从候选技能里挑出最该主动调用的 0–3 个。只输出 JSON：{"picks":[{"id":"…","reason":"10字内"}]}；都不合适就空数组。' },
    { role: 'user', content: '用户消息：' + text.slice(0, 1500) + '\n候选技能：\n' + list }
  ];
  try {
    const r = await aipool.call({ role: 'pick', messages: messages, temperature: 0, maxTokens: 300 });
    const j = extractJson(r.text);
    const picks = (j && Array.isArray(j.picks) ? j.picks : []).slice(0, 3).map((p) => ({ id: String(p.id || ''), reason: String(p.reason || '').slice(0, 40) }));
    return sendJson(res, 200, { ok: true, picks: picks, model: r.entry.id });
  } catch (e) {
    return sendJson(res, 200, { ok: false, picks: [], message: 'AI 推荐不可用：' + (e && e.message || e) });
  }
}

function poolStatus(req, res) {
  return sendJson(res, 200, { ok: true, pool: aipool.poolStatus() });
}

module.exports = { transcribe: transcribe, polish: polish, skillPick: skillPick, poolStatus: poolStatus };
