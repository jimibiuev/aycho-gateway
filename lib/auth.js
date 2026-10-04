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
  const email = normEmail(body.email);
  const scene = String(body.scene || 'register');
  if (!isEmail(email)) return sendJson(res, 400, { ok: false, message: '邮箱格式不正确' });
  if (['register', 'login', 'reset', 'change'].indexOf(scene) < 0) return sendJson(res, 400, { ok: false, message: '未知场景' });

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
  const CODE_TITLES = { register: '注册验证码', reset: '重置密码验证码', login: '登录验证码', change: '更换邮箱验证码' };
  const title = CODE_TITLES[scene] || '验证码';
  const text = '你的 AYCHO ' + title + '是：' + code + '\n有效期 10 分钟。如非本人操作请忽略本邮件。';
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#222">' +
    '<p>你的 AYCHO ' + title + '是：</p>' +
    '<p style="font-size:28px;letter-spacing:6px;font-weight:700;color:#3b5bdb">' + code + '</p>' +
    '<p style="color:#666">有效期 10 分钟。如非本人操作请忽略本邮件。</p></div>';

  const mail = await mailer.sendMail(email, 'AYCHO ' + title, text, html);

  if (!mail.sent) {
    console.error('[mail] 发送失败（' + (mail.reason || 'unknown') + '）→ ' + email);
    return sendJson(res, 502, {
      ok: false, sent: false,
      message: '验证码邮件发送失败：' + (mail.reason || '发信通道未配置')
    });
  }

  d.codes[key] = { code: code, expiresAt: Date.now() + CODE_TTL, tries: 0, sentAt: Date.now() };
  db.save();
  console.log('[mail] 已发送 ' + title + ' → ' + email);
  return sendJson(res, 200, { ok: true, sent: true, channel: mail.channel || 'smtp' });
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

function logout(req, res) {
  db.dropSession(bearer(req));
  return sendJson(res, 200, { ok: true });
}

module.exports = {
  sendCode: sendCode,
  register: register,
  login: login,
  resetPassword: resetPassword,
  changePassword: changePassword,
  changeEmail: changeEmail,
  me: me,
  logout: logout,
  publicUser: publicUser,
  findUser: findUser,
  verifyPassword: verifyPassword
};
