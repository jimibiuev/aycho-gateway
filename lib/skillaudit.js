/* AYCHO module: server/lib/skillaudit | Skill 提权：后端三层 AI 安全审核
 *
 * 安全边界原则（重要）：
 *   1) 审核只放【后端】。前端弹窗仅作「告知/确认」，不作为安全边界，前端可被篡改或直接绕过；
 *   2) 技能想要「真实改写页面 / 调用系统能力」，其代码必须先过一次三层的串行审核；
 *   3) 任一层否决 → 直接拒绝；三层全过 → 放行（并携带 L3 裁剪后的代码）；
 *   4) 模型不可用时 fail-closed（拒绝），绝不静默放行。
 *
 * 三层设计：
 *   L1 规则引擎（确定性、零网络、毫秒级）：危险原语黑名单 + 结构检查，不可绕过；
 *   L2 小模型快审（低 token、低成本）：语义判定是否触达系统 / 凭据 / 网络外发；
 *   L3 大模型裁决（全量语义、temperature=0）：输出严格 JSON 裁定，含风险清单与整改建议。
 *
 * 路由：POST /api/skill/audit
 *   req  { skillId, action, code, target?, sessionId? }
 *   resp { ok, allowed, level1:{pass,hits[]}, level2:{pass,reason}, level3:{allow,risk,reasons[]},
 *          final:{allowed, blockedBy, code} , auditId, ms }
 */
'use strict';

const { sendJson, readJson } = require('./http');

const MAX_CODE = 200 * 1024;
const LOG_MAX = 200;
const LOG = [];

/* ------------------------------------------------------------------ *
 * L1：确定性规则引擎
 * ------------------------------------------------------------------ */

/* level: 'reject' 直接拒绝 / 'flag' 交 L2、L3 重点研判 */
const RULES = [
  { id: 'eval', re: /\beval\s*\(/, level: 'reject', why: '动态执行 eval()，可绕过一切静态审核' },
  { id: 'new-function', re: /new\s+(Async)?Function\s*\(/, level: 'reject', why: 'new Function() 等价于 eval' },
  { id: 'document-write', re: /document\s*\.\s*write\s*\(/, level: 'reject', why: 'document.write 可整体覆写宿主页面' },
  { id: 'top-access', re: /(window|self)\s*\.\s*top\b|top\s*\.\s*(document|location)/, level: 'reject', why: '越出沙箱访问顶层窗口' },
  { id: 'parent-access', re: /(window|self)\s*\.\s*parent\b/, level: 'reject', why: '越出沙箱访问父窗口' },
  { id: 'cookie', re: /document\s*\.\s*cookie/, level: 'reject', why: '读取/写入站点 Cookie，凭据窃取风险' },
  { id: 'storage-token', re: /localStorage|sessionStorage|indexedDB/, level: 'flag', why: '访问本地存储，可能触及登录态' },
  { id: 'credential', re: /navigator\s*\.\s*credentials|password|passwd|secret|api[_-]?key|token\s*[:=]/i, level: 'flag', why: '涉及凭据/密钥字样' },
  { id: 'crypto-key', re: /crypto\s*\.\s*subtle|generateKey|exportKey/, level: 'flag', why: '涉及密钥操作' },
  { id: 'xhr', re: /XMLHttpRequest|new\s+WebSocket|EventSource|navigator\s*\.\s*sendBeacon/, level: 'flag', why: '非常规网络外发通道' },
  { id: 'fetch', re: /\bfetch\s*\(/, level: 'flag', why: '网络请求，需确认目标是否可信' },
  { id: 'iframe', re: /createElement\s*\(\s*['"]iframe['"]|srcdoc\s*=/, level: 'flag', why: '注入 iframe 可加载外部页面' },
  { id: 'form-submit', re: /\.submit\s*\(\)|createElement\s*\(\s*['"]form['"]/, level: 'flag', why: '表单提交可把数据外送' },
  { id: 'clipboard-read', re: /navigator\s*\.\s*clipboard\s*\.\s*read/, level: 'flag', why: '读取剪贴板内容' },
  { id: 'file-delete', re: /(fs\s*\.\s*)?(unlink|rmdir|rmSync|rm)\s*\(|removeItem\s*\(/, level: 'reject', why: '删除类操作，须走工作区受控接口' },
  { id: 'path-escape', re: /\.\.\s*[\\/]|\/etc\/passwd|process\s*\.\s*env|cwd\s*\(\)/, level: 'reject', why: '路径越界或读取宿主环境变量' },
  { id: 'require', re: /\brequire\s*\(|import\s*\(|child_process|execSync|spawn\s*\(/, level: 'reject', why: '模块加载/命令执行，属宿主能力' },
  { id: 'nav-hijack', re: /location\s*(\.\s*(href|assign|replace)\s*=|\.\s*reload)|window\s*\.\s*open\s*\(/, level: 'flag', why: '页面跳转/弹窗劫持风险' },
  { id: 'inject-remote', re: /https?:\/\/[^\s'"`)]+\.(js|css)/i, level: 'flag', why: '外链脚本/样式，来源不可控' },
  { id: 'css-exfil', re: /url\s*\(\s*['"]?https?:/i, level: 'flag', why: 'CSS 远程资源可作数据外带' },
  { id: 'style-hide-all', re: /display\s*:\s*none\s*!important/, level: 'flag', why: '可能整体隐藏宿主界面' },
  { id: 'observer-loop', re: /while\s*\(\s*(true|1)\s*\)|setInterval\s*\(\s*[^,]{0,40},\s*0\s*\)/, level: 'reject', why: '死循环/0 间隔定时器会卡死工作台' }
];

function auditL1(code) {
  const hits = [];
  for (let i = 0; i < RULES.length; i++) {
    const r = RULES[i];
    if (r.re.test(code)) hits.push({ id: r.id, level: r.level, why: r.why });
  }
  const rejects = hits.filter((h) => h.level === 'reject');
  return { pass: rejects.length === 0, hits: hits, rejects: rejects };
}

/* ------------------------------------------------------------------ *
 * L2 / L3：模型审核（走服务端密钥，前端拿不到）
 * ------------------------------------------------------------------ */
function modelCfg() {
  const base = String(process.env.AYCHO_MODEL_BASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.AYCHO_MODEL_API_KEY || '');
  const model = String(process.env.AYCHO_MODEL_NAME || process.env.AYCHO_MODEL || '').trim();
  return { base: base, key: key, model: model, ready: !!(base && key) };
}

async function callModel(messages, maxTokens, temperature, role) {
  /* 优先走 aipool 多模型集群（免费池）；池全空时回退旧单模型环境变量 */
  const aipool = require("./aipool");
  try {
    const r = await aipool.call({
      role: role || "audit",
      messages: messages,
      temperature: temperature == null ? 0 : temperature,
      maxTokens: maxTokens || 400,
      timeoutMs: 30000
    });
    return r.text;
  } catch (e) {
    if (String(e.message || e).indexOf("No usable model") === 0) {
      const cfg = modelCfg();
      if (!cfg.ready) throw new Error("无可用模型：aipool 无密钥且未配 AYCHO_MODEL_BASE_URL/KEY。请在 .env 填至少一个密钥。");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(cfg.base + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
          body: JSON.stringify({ model: cfg.model || undefined, messages: messages, temperature: temperature == null ? 0 : temperature, max_tokens: maxTokens || 400 }),
          signal: ctrl.signal
        });
        if (!res.ok) throw new Error("模型返回 " + res.status);
        const data = await res.json();
        const ch = data && data.choices && data.choices[0];
        return ch && ch.message ? String(ch.message.content || "") : "";
      } finally { clearTimeout(timer); }
    }
    throw e;
  }
}

/* 多模型投票：N 台并行，任一明确否决即否决（保守）；全部不可用 → fail-closed */
async function callModelVote(messages, maxTokens, temperature, role) {
  const aipool = require("./aipool");
  const n = parseInt(process.env.AYCHO_AUDIT_VOTERS, 10) || 2;
  const r = await aipool.vote({ role: role || "audit", messages: messages, maxTokens: maxTokens, temperature: temperature, voters: n });
  const votes = [];
  let passCount = 0, rejectCount = 0, unknownCount = 0;
  const reasons = [];
  for (const v of r.votes) {
    if (v.error) {
      unknownCount++;
      reasons.push((v.entry.name || "?") + " 不可用：" + String(v.error).slice(0, 80));
      continue;
    }
    const j = extractJson(v.text);
    if (!j || typeof j.pass !== "boolean") {
      unknownCount++;
      reasons.push((v.entry.name || "?") + " 未返回可解析结论（fail-closed）");
      continue;
    }
    votes.push({ entry: (v.entry.name || v.entry.id || "?"), pass: j.pass, reason: String(j.reason || "").slice(0, 120) });
    if (j.pass) passCount++;
    else { rejectCount++; if (j.reason) reasons.push((v.entry.name || "?") + "：" + String(j.reason).slice(0, 120)); }
  }
  if (rejectCount === 0 && passCount > 0) return { pass: true, reasons: reasons, votes: votes };
  if (unknownCount === r.votes.length) return { pass: false, reasons: reasons.length ? reasons : ["所有投票模型不可用（fail-closed）"], votes: votes };
  return { pass: false, reasons: reasons, votes: votes };
}

function extractJson(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

const L2_SYS = '你是代码安全快审器。判断给定前端技能代码是否存在「触达宿主系统能力 / 窃取凭据 / 向外部发送数据 / 破坏工作台」的风险。只输出 JSON：{"pass":true|false,"reason":"不超过40字"}。无法判断时 pass 设为 false。';

async function auditL2(code, ctx) {
  const user = '动作：' + (ctx.action || '-') + '\n技能：' + (ctx.skillId || '-') + '\n代码（截断）：\n' + code.slice(0, 6000);
  /* 多模型投票快审：2 台并行，全票通过才过（防单模型误判） */
  const v = await callModelVote([{ role: 'system', content: L2_SYS }, { role: 'user', content: user }], 120, 0, 'audit');
  return { pass: v.pass, reason: (v.reasons || []).join('；').slice(0, 200), votes: v.votes };
}

const L3_SYS = '你是 AYCHO 工作台的后端安全裁决模型，职责是审核「技能提权代码」。技能被允许改写的边界仅限：工作台页面自身的 DOM / 样式 / 文案、注册槽位按钮、读写用户已授权的工作区目录。任何越界（读取凭据与登录态、外发数据、执行命令、访问宿主文件系统、越出沙箱窗口、破坏界面可用性）都必须拒绝。只输出 JSON：{"allow":true|false,"risk":0-3,"reasons":["..."],"fix":"若拒绝，给出一句整改建议"}。拿不准时必须 allow=false。';

async function auditL3(code, ctx, l1) {
  const user = '动作：' + (ctx.action || '-') + '\n技能：' + (ctx.skillId || '-') + '\n目标：' + (ctx.target || '-') +
    '\nL1 规则命中：' + JSON.stringify(l1.hits) + '\n代码全文：\n' + code.slice(0, 20000);
  /* L3 裁决也用投票（格式是 allow/risk/reasons/fix，非 pass，单独解析） */
  const v3 = await callModelVote([{ role: 'system', content: L3_SYS }, { role: 'user', content: user }], 400, 0, 'audit');
  const l3votes = (v3.votes || []).map((x) => {
    const j2 = extractJson(x.text || x.raw || '');
    return j2 && typeof j2.allow === 'boolean'
      ? { entry: x.entry && x.entry.name || '?', allow: j2.allow, risk: Number(j2.risk) || 0, reasons: Array.isArray(j2.reasons) ? j2.reasons : [] }
      : null;
  }).filter(Boolean);
  const allAllow = l3votes.length > 0 && l3votes.every((x) => x.allow === true);
  if (!allAllow) {
    const merged = l3votes.filter((x) => !x.allow);
    return {
      allow: false, risk: 3,
      reasons: (merged.length ? merged.map((m) => m.reasons[0] || (m.entry + ' 否决')).slice(0, 6) : (v3.reasons || ['裁决未获全票（fail-closed）'])),
      fix: '请移除命中规则或降低风险后重试',
      votes: l3votes
    };
  }
  return { allow: true, risk: 0, reasons: [], fix: '', votes: l3votes };
}

/* ------------------------------------------------------------------ *
 * 串联三层 + 审计日志
 * ------------------------------------------------------------------ */
async function audit(req, res) {
  const body = await readJson(req);
  const code = String(body.code == null ? '' : body.code);
  const ctx = {
    skillId: String(body.skillId || 'unknown').slice(0, 120),
    action: String(body.action || '').slice(0, 120),
    target: String(body.target || '').slice(0, 300),
    sessionId: String(body.sessionId || '').slice(0, 120)
  };
  const started = Date.now();
  const auditId = 'aud_' + started.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const result = {
    ok: true, auditId: auditId, skillId: ctx.skillId, action: ctx.action,
    allowed: false, level1: null, level2: null, level3: null,
    final: { allowed: false, blockedBy: '', code: '' }, ms: 0
  };

  if (!code) {
    result.final.blockedBy = 'l1';
    result.final.reason = '缺少待审代码';
    result.ms = Date.now() - started;
    return sendJson(res, 200, result);
  }
  if (code.length > MAX_CODE) {
    result.final.blockedBy = 'l1';
    result.final.reason = '代码超长（>' + MAX_CODE + ' 字节）';
    result.ms = Date.now() - started;
    return sendJson(res, 200, result);
  }

  /* L1 */
  const l1 = auditL1(code);
  result.level1 = { pass: l1.pass, hits: l1.hits };
  if (!l1.pass) {
    result.final.blockedBy = 'l1';
    result.final.reason = '规则引擎命中高危原语：' + l1.rejects.map((h) => h.id).join(', ');
    result.ms = Date.now() - started;
    pushLog(result, ctx);
    return sendJson(res, 200, result);
  }

  /* L2 */
  try {
    const l2 = await auditL2(code, ctx);
    result.level2 = l2;
    if (!l2.pass) {
      result.final.blockedBy = 'l2';
      result.final.reason = l2.reason;
      result.ms = Date.now() - started;
      pushLog(result, ctx);
      return sendJson(res, 200, result);
    }
  } catch (e) {
    result.level2 = { pass: false, reason: '快审不可用：' + e.message };
    result.final.blockedBy = 'l2';
    result.final.reason = result.level2.reason;
    result.ms = Date.now() - started;
    pushLog(result, ctx);
    return sendJson(res, 200, result);
  }

  /* L3 */
  try {
    const l3 = await auditL3(code, ctx, l1);
    result.level3 = l3;
    if (!l3.allow) {
      result.final.blockedBy = 'l3';
      result.final.reason = (l3.reasons[0] || '裁决模型拒绝') + (l3.fix ? '｜建议：' + l3.fix : '');
      result.risk = 3;  /* 高风险：需要密码验证才能强制加入 */
      result.ms = Date.now() - started;
      pushLog(result, ctx);
      return sendJson(res, 200, result);
    }
  } catch (e) {
    result.level3 = { allow: false, reasons: ['裁决不可用：' + e.message] };
    result.final.blockedBy = 'l3';
    result.final.reason = '裁决不可用：' + e.message;
    result.risk = 2;  /* 中风险：可强制加入但需密码验证 */
    result.ms = Date.now() - started;
    pushLog(result, ctx);
    return sendJson(res, 200, result);
  }

  /* 通过三层但 L1 命中了 flag 级规则 → 中风险，前端弹确认但不需密码 */
  const flagHits = (l1.hits || []).filter((h) => h.level === 'flag');
  if (flagHits.length) {
    result.risk = 1;  /* 低风险：正常加入即可 */
  } else {
    result.risk = 0;  /* 无风险 */
  }

  result.allowed = true;
  result.final.allowed = true;
  result.final.blockedBy = '';
  result.final.code = code;
  result.ms = Date.now() - started;
  pushLog(result, ctx);
  return sendJson(res, 200, result);
}

function pushLog(result, ctx) {
  try {
    LOG.unshift({
      auditId: result.auditId, at: Date.now(), skillId: ctx.skillId, action: ctx.action,
      allowed: result.allowed, blockedBy: result.final.blockedBy,
      hits: result.level1 && result.level1.hits ? result.level1.hits.map((h) => h.id) : []
    });
    if (LOG.length > LOG_MAX) LOG.length = LOG_MAX;
  } catch (e) { /* ignore */ }
}

async function logs(req, res, q) {
  const n = Math.max(1, Math.min(LOG_MAX, parseInt(q.limit, 10) || 50));
  return sendJson(res, 200, { ok: true, total: LOG.length, items: LOG.slice(0, n) });
}

function status(req, res) {
  const cfg = modelCfg();
  const aipool = require('./aipool');
  return sendJson(res, 200, {
    ok: true,
    layers: ['l1-rules', 'l2-fast-model-vote', 'l3-verdict-model-vote'],
    policy: 'multi-model vote, fail-closed, backend-only',
    modelReady: cfg.ready || aipool.poolStatus().some((p) => p.hasKey),
    modelConfigured: !!cfg.base,
    rules: RULES.length,
    logSize: LOG.length,
    pool: aipool.poolStatus()
  });
}

/* 强制加入（用户要求：检测出有风险时，输入登录密码可强制加入）
 * POST /api/skill/audit/force
 *   req  { auditId, password, code?, skillId?, action? }
 *   resp { ok, forced, user }
 * 安全边界：只有已登录用户 + 密码匹配才放行；密码验证走 auth.verifyIdentity 同一套逻辑。 */
async function forceAudit(req, res) {
  const db = require('./db');
  const { bearer, sendJson, readJson } = require('./http');
  const user = db.userByToken(bearer(req));
  if (!user) return sendJson(res, 401, { ok: false, message: '未登录或登录已过期，无法强制加入' });
  const body = await readJson(req);
  const pw = String(body.password || '');
  if (!pw) return sendJson(res, 400, { ok: false, message: '请输入登录密码' });
  const authMod = require('./auth');
  /* 复用 auth 里的 verifyPassword 逻辑 */
  let pwOk = false;
  try {
    const crypto = require('crypto');
    if (user.pass && user.pass.salt && user.pass.hash) {
      const got = crypto.scryptSync(pw, user.pass.salt, 64).toString('hex');
      const a = Buffer.from(got, 'hex');
      const b = Buffer.from(user.pass.hash, 'hex');
      pwOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
  } catch (e) { pwOk = false; }
  if (!pwOk) return sendJson(res, 400, { ok: false, message: '密码不正确，强制加入被拒绝' });
  const ctx = {
    skillId: String(body.skillId || 'unknown').slice(0, 120),
    action: String(body.action || 'force').slice(0, 120)
  };
  const auditId = 'force_' + Date.now().toString(36);
  LOG.unshift({
    auditId: auditId, at: Date.now(), skillId: ctx.skillId, action: ctx.action,
    allowed: true, forced: true, forcedBy: user.email,
    hits: []
  });
  if (LOG.length > LOG_MAX) LOG.length = LOG_MAX;
  console.log('[skillaudit] 强制加入（密码验证）→ ' + user.email + ' skill=' + ctx.skillId);
  return sendJson(res, 200, { ok: true, forced: true, auditId: auditId, user: { email: user.email, name: user.name || '' } });
}

module.exports = { audit: audit, logs: logs, status: status, forceAudit: forceAudit, auditL1: auditL1, RULES: RULES };
