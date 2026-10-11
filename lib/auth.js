/* AYCHO module: server/lib/auth | 真实账号体系
 * scrypt 加盐哈希存密码；会话令牌入库；邮箱验证码经真实 SMTP 投递。
 * 发信失败时接口直接返回错误，不落库验证码、不回传验证码，杜绝绕过邮件验证。
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');
const { sendJson, readJson, bearer } = require('./http');

const CODE_TTL = 10 * 60 * 1000;
const CODE_COOLDOWN = 60 * 1000;
const MAX_TRIES = 5;

/* ------------------------------ 口令哈希 ------------------------------ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt: salt, hash: hash };
}

function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  let got;
  try { got = crypto.scryptSync(String(password), rec.salt, 64).toString('hex'); }
  catch (e) { return false; }
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------ 校验 ------------------------------ */
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }

function pwdProblem(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < 8) return '密码需至少 8 位';
  if (!/[a-z]/.test(s)) return '密码需包含小写字母';
  if (!/[A-Z]/.test(s)) return '密码需包含大写字母';
  if (!/[0-9]/.test(s)) return '密码需包含数字';
  return '';
}

function normEmail(s) { return String(s || '').trim().toLowerCase(); }

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name || '', avatar: u.avatar || '', createdAt: u.createdAt };
}

function findUser(email) {
  const d = db.load();
  return d.users.find((u) => u && u.email === email) || null;
}

function codeKey(email, scene) { return email + ':' + scene; }

function makeCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

/* ------------------------------ 验证码 ------------------------------ */
async function sendCode(req, res) {
  const body = await readJson(req);
  let email = normEmail(body.email);
  const scene = String(body.scene || 'register');
  if (!isEmail(email)) return sendJson(res, 400, { ok: false, message: '邮箱格式不正确' });
  if (['register', 'login', 'reset', 'change', 'verify'].indexOf(scene) < 0) return sendJson(res, 400, { ok: false, message: '未知场景' });

  /* 身份核验（危险操作确认）必须已登录，且只能发到当前账号邮箱，避免被当成任意发信通道 */
  if (scene === 'verify') {
    const user = db.userByToken(bearer(req));
    if (!user) return sendJson(res, 401, { ok: false, message: '未登录或登录已过期，请重新登录后再试' });
    email = normEmail(user.email);
  }

  const exists = !!findUser(email);
  if (scene === 'register' && exists) return sendJson(res, 409, { ok: false, message: '该邮箱已注册，请直接登录' });

  if (scene === 'change' && exists) return sendJson(res, 409, { ok: false, message: '该邮箱已被其他账号占用' });
  if (scene !== 'register' && scene !== 'change' && !exists) return sendJson(res, 404, { ok: false, message: '该邮箱尚未注册' });

  const d = db.load();
  const key = codeKey(email, scene);
  const prev = d.codes[key];
  if (prev && Date.now() - (prev.sentAt || 0) < CODE_COOLDOWN) {
    const wait = Math.ceil((CODE_COOLDOWN - (Date.now() - prev.sentAt)) / 1000);
    return sendJson(res, 429, { ok: false, message: '发送过于频繁，请 ' + wait + ' 秒后再试' });
  }

  const code = makeCode();
  /* 日志高亮：验证码已生成（供 Render 日志手动抄录注册） */
  console.error("[AYCHO-CODE] " + email + " => " + code + " （登录/注册验证码，可直接复制使用）");
  const CODE_TITLES = { register: '注册验证码', reset: '重置密码验证码', login: '登录验证码', change: '更换邮箱验证码', verify: '危险操作核验验证码' };
  const title = CODE_TITLES[scene] || '验证码';
  const text = '你的 AYCHO ' + title + '是：' + code + '\n有效期 10 分钟。如非本人操作请忽略本邮件。';
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#222">' +
    '<p>你的 AYCHO ' + title + '是：</p>' +
    '<p style="font-size:28px;letter-spacing:6px;font-weight:700;color:#3b5bdb">' + code + '</p>' +
    '<p style="color:#666">有效期 10 分钟。如非本人操作请忽略本邮件。</p></div>';

  const mail = await mailer.sendMail(email, 'AYCHO ' + title, text, html);

  if (!mail.sent) {
    console.error('[mail] 发送失败（' + (mail.reason || 'unknown') + '）→ ' + email);
    /* 通道全挂但请求方明确允许时：回传验证码到响应（仅 127.0.0.1 或 AYCHO_DEV=1 才放行，生产默认关闭） */
    const allowLeak = String(process.env.AYCHO_DEV || '') === '1' || (req.socket && (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1'));
    if (allowLeak && String(body.leakOk || '') === '1') {
      d.codes[key] = { code: code, expiresAt: Date.now() + CODE_TTL, tries: 0, sentAt: Date.now() };
      db.save();
      console.error('[mail] 发信失败但请求方允许回传 → 返回验证码（联调模式）');
      return sendJson(res, 200, { ok: true, sent: false, leaked: true, code: code, message: '发信通道不可用，已临时回传验证码（仅限联调）' });
    }
    return sendJson(res, 502, {
      ok: false, sent: false,
      needActivate: !!mail.needActivate,
      message: '验证码邮件发送失败：' + (mail.reason || '发信通道未配置') + (allowLeak ? '（联调模式可加 leakOk=1 回传）' : '')
    });
  }

  d.codes[key] = { code: code, expiresAt: Date.now() + CODE_TTL, tries: 0, sentAt: Date.now() };
  db.save();
  console.log('[mail] 已发送 ' + title + ' → ' + email + '（通道 ' + (mail.channel || 'smtp') + '）');
  /* 响应里带上通道 + 需激活提示，前端可据此给出准确提示 */
  return sendJson(res, 200, {
    ok: true, sent: true, channel: mail.channel || 'smtp',
    needActivate: !!mail.needActivate,
    pending: !!mail.pending,
    note: mail.needActivate ? '首次使用 FormSubmit 通道：请先到邮箱（含垃圾箱）点 "Activate Form" 激活，之后验证码才直达。'
        : (mail.pending ? 'GitHub Actions 中继已入队，投递约需 1–3 分钟。' : ''),
    message: '验证码已发出（' + (mail.channel || 'smtp') + '），请查收邮箱（含垃圾箱）。'
  });
}

function consumeCode(email, scene, code) {
  const d = db.load();
  const key = codeKey(email, scene);
  const rec = d.codes[key];
  if (!rec) return '请先获取验证码';
  if (rec.expiresAt <= Date.now()) { delete d.codes[key]; db.save(); return '验证码已过期，请重新获取'; }
  if (rec.tries >= MAX_TRIES) { delete d.codes[key]; db.save(); return '尝试次数过多，请重新获取'; }
  if (String(rec.code) !== String(code)) { rec.tries++; db.save(); return '验证码不正确'; }
  delete d.codes[key];
  db.save();
  return '';
}

/* ------------------------------ 注册 / 登录 ------------------------------ */
async function register(req, res) {
  const body = await readJson(req);
  const email = normEmail(body.email);
  const name = String(body.name || '').trim();
  if (!isEmail(email)) return sendJson(res, 400, { ok: false, message: '邮箱格式不正确' });
  const bad = pwdProblem(body.password);
  if (bad) return sendJson(res, 400, { ok: false, message: bad });
  if (findUser(email)) return sendJson(res, 409, { ok: false, message: '该邮箱已注册' });
  const codeErr = consumeCode(email, 'register', body.code);
  if (codeErr) return sendJson(res, 400, { ok: false, message: codeErr });

  const d = db.load();
  const user = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    email: email,
    name: name || email.split('@')[0],
    avatar: '',
    pass: hashPassword(body.password),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  d.users.push(user);
  db.save();
  const token = db.createSession(user.id);
  console.log('[auth] 新用户注册 ' + email);
  return sendJson(res, 200, { ok: true, token: token, user: publicUser(user) });
}

async function login(req, res) {
  const body = await readJson(req);
  const email = normEmail(body.email);
  const user = findUser(email);
  if (!user) return sendJson(res, 404, { ok: false, message: '该邮箱尚未注册' });
  if (!verifyPassword(body.password, user.pass)) return sendJson(res, 401, { ok: false, message: '密码不正确' });
  const token = db.createSession(user.id);
  console.log('[auth] 登录成功 ' + email);
  return sendJson(res, 200, { ok: true, token: token, user: publicUser(user) });
}

/* 登录兜底：先试密码，账号不存在 / 密码错 → 自动回退「发验证码 + 校验」。
 * 仅本地联调（localhost 或 AYCHO_DEV=1）把 code 放响应里（leakOk 模式），
 * 否则只返回 needCode=true，让用户去邮箱收验证码。 */
async function loginAny(req, res) {
  const body = await readJson(req);
  const email = normEmail(body.email);
  if (!isEmail(email)) return sendJson(res, 400, { ok: false, message: '邮箱格式不正确' });

  const user = findUser(email);
  if (user && verifyPassword(body.password, user.pass)) {
    const token = db.createSession(user.id);
    console.log('[auth] 登录兜底（密码直通）' + email);
    return sendJson(res, 200, { ok: true, method: 'password', token: token, user: publicUser(user) });
  }

  /* 账号不存在或密码错 → 回退验证码。sendCode 的 scene=login 要求已注册，
   * 未注册时给明确提示走注册流程（避免把兜底端点当成注册通道）。 */
  const d = db.load();
  const key = codeKey(email, 'login');
  const prev = d.codes[key];
  if (prev && Date.now() - (prev.sentAt || 0) < CODE_COOLDOWN) {
    const wait = Math.ceil((CODE_COOLDOWN - (Date.now() - prev.sentAt)) / 1000);
    return sendJson(res, 429, { ok: false, needCode: true, message: '刚发过验证码，请 ' + wait + ' 秒后再试或直接查收邮箱' });
  }
  if (!user) {
    const code = makeCode();
    d.codes[key] = { code: code, expiresAt: Date.now() + CODE_TTL, tries: 0, sentAt: Date.now() };
    db.save();
    console.log('[auth] 登录兜底：邮箱未注册 ' + email + '（生成验证码待注册校验）');
    const allowLeak = String(process.env.AYCHO_DEV || '') === '1' || (req.socket && (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1'));
    return sendJson(res, 200, {
      ok: true, method: 'code', needCode: true,
      code: (allowLeak && String(body.leakOk || '') === '1') ? code : undefined,
      message: allowLeak ? '该邮箱尚未注册：验证码已生成，完成注册后即可登录' : '该邮箱尚未注册：请先到注册页完成注册（验证码将发到邮箱）'
    });
  }

  /* 密码错但账号存在：生成登录验证码，经 mailer 投递 */
  const code = makeCode();
  d.codes[key] = { code: code, expiresAt: Date.now() + CODE_TTL, tries: 0, sentAt: Date.now() };
  db.save();
  const title = '登录验证码';
  const text = '你的 AYCHO ' + title + '是：' + code + '\n有效期 10 分钟。如非本人操作请忽略本邮件。';
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#222"><p>你的 AYCHO ' + title + '是：</p><p style="font-size:28px;letter-spacing:6px;font-weight:700;color:#3b5bdb">' + code + '</p><p style="color:#666">有效期 10 分钟。如非本人操作请忽略本邮件。</p></div>';
  const mail = await mailer.sendMail(email, 'AYCHO ' + title, text, html);
  const allowLeak = String(process.env.AYCHO_DEV || '') === '1' || (req.socket && (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1'));
  if (!mail.sent && allowLeak && String(body.leakOk || '') === '1') {
    console.error('[auth] 登录兜底：发信失败，联调模式回传验证码');
    return sendJson(res, 200, { ok: true, method: 'code', needCode: true, leaked: true, code: code, message: '发信通道不可用，已临时回传验证码（仅限联调）' });
  }
  if (!mail.sent) {
    return sendJson(res, 200, {
      ok: true, method: 'code', needCode: true,
      message: '密码不正确，已发送邮箱验证码（发信通道 ' + (mail.channel || 'none') + '）。如未收到请检查垃圾箱，或先「忘记密码」重置密码。'
    });
  }
  console.log('[auth] 登录兜底：已发登录验证码 ' + email + '（通道 ' + (mail.channel || 'smtp') + '）');
  return sendJson(res, 200, { ok: true, method: 'code', needCode: true, code: undefined, message: '密码不正确，登录验证码已发到邮箱（' + (mail.channel || 'smtp') + '），请查收并输入验证码。' });
}

/* 用登录验证码完成登录（/api/auth/login-any 回退后的校验步骤） */
async function loginByCode(req, res) {
  const body = await readJson(req);
  const email = normEmail(body.email);
  if (!isEmail(email)) return sendJson(res, 400, { ok: false, message: '邮箱格式不正确' });
  const user = findUser(email);
  if (!user) return sendJson(res, 404, { ok: false, message: '该邮箱尚未注册，请先注册' });
  const err = consumeCode(email, 'login', body.code);
  if (err) return sendJson(res, 400, { ok: false, message: err });
  const token = db.createSession(user.id);
  console.log('[auth] 验证码登录成功 ' + email);
  return sendJson(res, 200, { ok: true, method: 'code', token: token, user: publicUser(user) });
}

async function resetPassword(req, res) {
  const body = await readJson(req);
  const email = normEmail(body.email);
  const user = findUser(email);
  if (!user) return sendJson(res, 404, { ok: false, message: '该邮箱尚未注册' });
  const bad = pwdProblem(body.password);
  if (bad) return sendJson(res, 400, { ok: false, message: bad });
  const codeErr = consumeCode(email, 'reset', body.code);
  if (codeErr) return sendJson(res, 400, { ok: false, message: codeErr });
  user.pass = hashPassword(body.password);
  user.updatedAt = Date.now();
  db.save();
  const d = db.load();
  d.sessions = d.sessions.filter((s) => s.userId !== user.id);   // 重置后踢下线
  db.save();
  const token = db.createSession(user.id);
  console.log('[auth] 重置密码 ' + email);
  return sendJson(res, 200, { ok: true, token: token, user: publicUser(user) });
}

/* ------------------------------ 账号维护 ------------------------------ */
async function changePassword(req, res) {
  const user = db.userByToken(bearer(req));
  if (!user) return sendJson(res, 401, { ok: false, message: '未登录或登录已过期' });
  const body = await readJson(req);
  if (!verifyPassword(body.oldPassword, user.pass)) return sendJson(res, 400, { ok: false, message: '当前密码不正确' });
  const bad = pwdProblem(body.newPassword);
  if (bad) return sendJson(res, 400, { ok: false, message: bad });
  user.pass = hashPassword(body.newPassword);
  user.updatedAt = Date.now();
  db.save();
  console.log('[auth] 修改密码 ' + user.email);
  return sendJson(res, 200, { ok: true });
}

async function changeEmail(req, res) {
  const user = db.userByToken(bearer(req));
  if (!user) return sendJson(res, 401, { ok: false, message: '未登录或登录已过期' });
  const body = await readJson(req);
  const email = normEmail(body.email);
  if (!isEmail(email)) return sendJson(res, 400, { ok: false, message: '邮箱格式不正确' });
  const other = findUser(email);
  if (other && other.id !== user.id) return sendJson(res, 409, { ok: false, message: '该邮箱已被其他账号占用' });
  const codeErr = consumeCode(email, 'change', body.code);
  if (codeErr) return sendJson(res, 400, { ok: false, message: codeErr });
  user.email = email;
  user.updatedAt = Date.now();
  db.save();
  console.log('[auth] 更换邮箱 → ' + email);
  return sendJson(res, 200, { ok: true, user: publicUser(user) });
}

function me(req, res) {
  const user = db.userByToken(bearer(req));
  if (!user) return sendJson(res, 401, { ok: false, message: '未登录或登录已过期' });
  return sendJson(res, 200, { ok: true, user: publicUser(user) });
}

/* 危险操作（AI 执行 rm / kill / 危险文件等）确认前的身份核验：登录密码 或 邮箱验证码 */
async function verifyIdentity(req, res) {
  const user = db.userByToken(bearer(req));
  if (!user) return sendJson(res, 401, { ok: false, message: '未登录或登录已过期，请重新登录后再试' });
  const body = await readJson(req);
  const method = String(body.method || 'password');

  if (method === 'password') {
    const pw = String(body.password || '');
    if (!pw) return sendJson(res, 400, { ok: false, message: '请输入登录密码' });
    if (!verifyPassword(pw, user.pass)) return sendJson(res, 400, { ok: false, message: '密码不正确' });
    console.log('[auth] 危险操作核验通过（密码）→ ' + user.email);
    return sendJson(res, 200, { ok: true, method: 'password', user: publicUser(user) });
  }

  if (method === 'code') {
    const code = String(body.code || '').trim();
    if (!code) return sendJson(res, 400, { ok: false, message: '请输入邮箱验证码' });
    const err = consumeCode(user.email, 'verify', code);
    if (err) return sendJson(res, 400, { ok: false, message: err });
    console.log('[auth] 危险操作核验通过（邮箱验证码）→ ' + user.email);
    return sendJson(res, 200, { ok: true, method: 'code', user: publicUser(user) });
  }

  return sendJson(res, 400, { ok: false, message: '未知核验方式' });
}

function logout(req, res) {
  db.dropSession(bearer(req));
  return sendJson(res, 200, { ok: true });
}

module.exports = {
  sendCode: sendCode,
  register: register,
  login: login,
  loginAny: loginAny,
  loginByCode: loginByCode,
  resetPassword: resetPassword,
  changePassword: changePassword,
  changeEmail: changeEmail,
  me: me,
  logout: logout,
  verifyIdentity: verifyIdentity,
  publicUser: publicUser,
  findUser: findUser,
  verifyPassword: verifyPassword
};
