/* AYCHO module: server/lib/mailer | 真实发信（双通道 · 零依赖）
 *
 * 通道 A  SMTP      任意邮箱服务商的真实 SMTP（QQ/163/126/腾讯企业邮/Outlook/自建）
 *                   需要「授权码/应用专用密码」，直连投递到任意收件邮箱，最可靠。
 * 通道 B  FormSubmit HTTPS 表单转发网关，零配置：把内容转发到收件邮箱。
 *                   首次向某邮箱转发时，该邮箱会收到一封 Activate Form 邮件，
 *                   收件人点一次即完成一次性激活，之后正常直达。
 *
 * 配置来源（后者覆盖前者）：
 *   1) 环境变量 AYCHO_SMTP_* / AYCHO_MAIL_* / AYCHO_MAIL_CHANNEL
 *   2) 运行时配置文件 server/data/mail.json（保存后即时生效，无需重启）
 *
 * 未配置任何通道时 sendMail() 返回 {sent:false, channel:'none', reason}，绝不假装成功。
 */
'use strict';

const net = require('net');
const tls = require('tls');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONF_FILE = path.join(DATA_DIR, 'mail.json');

/* 常见邮箱预设：一键带出主机/端口，并给出授权码获取路径 */
const PRESETS = {
  qq: { label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: true, hint: 'QQ邮箱 → 设置 → 账号 → 开启「POP3/SMTP服务」→ 生成授权码（16位，非QQ密码）' },
  exmail: { label: '腾讯企业邮', host: 'smtp.exmail.qq.com', port: 465, secure: true, hint: '企业微信邮箱 → 设置 → 收发信设置 → 客户端专用密码' },
  '163': { label: '163 邮箱', host: 'smtp.163.com', port: 465, secure: true, hint: '163邮箱 → 设置 → POP3/SMTP/IMAP → 开启服务 → 新增授权密码' },
  '126': { label: '126 邮箱', host: 'smtp.126.com', port: 465, secure: true, hint: '126邮箱 → 设置 → POP3/SMTP/IMAP → 开启服务 → 新增授权密码' },
  outlook: { label: 'Outlook / Hotmail', host: 'smtp-mail.outlook.com', port: 587, secure: false, hint: '需先开启双重验证，再生成「应用密码」' },
  o365: { label: 'Office 365', host: 'smtp.office365.com', port: 587, secure: false, hint: '企业账号需管理员允许 SMTP AUTH' },
  gmail: { label: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true, hint: '需 Google 应用专用密码（无 Google 直连的网络环境不可用）' },
  custom: { label: '自定义 SMTP', host: '', port: 465, secure: true, hint: '填写服务商提供的 SMTP 主机与端口' }
};

/* ------------------------------ 配置层 ------------------------------ */
function envConfig() {
  const host = String(process.env.AYCHO_SMTP_HOST || '').trim();
  const user = String(process.env.AYCHO_SMTP_USER || '').trim();
  const pass = String(process.env.AYCHO_SMTP_PASS || '');
  const port = parseInt(process.env.AYCHO_SMTP_PORT || '465', 10);
  return {
    channel: String(process.env.AYCHO_MAIL_CHANNEL || '').trim() || '',
    smtp: {
      preset: '',
      host: host,
      port: host ? port : 465,
      secure: host ? port !== 587 && port !== 25 : true,
      user: user,
      pass: pass,
      from: String(process.env.AYCHO_MAIL_FROM || user).trim(),
      fromName: String(process.env.AYCHO_MAIL_FROM_NAME || 'AYCHO').trim()
    },
    formsubmit: {
      enabled: String(process.env.AYCHO_FORMSUBMIT || '1') !== '0',
      subjectPrefix: String(process.env.AYCHO_MAIL_FROM_NAME || 'AYCHO').trim()
    }
  };
}

function blankConfig() {
  return {
    channel: 'auto',
    smtp: { preset: '', host: '', port: 465, secure: true, user: '', pass: '', from: '', fromName: 'AYCHO' },
    formsubmit: { enabled: true, subjectPrefix: 'AYCHO' },
    updatedAt: 0
  };
}

function mergeConfig(base, over) {
  const out = {
    channel: over && over.channel ? String(over.channel) : base.channel,
    smtp: Object.assign({}, base.smtp, (over && over.smtp) || {}),
    formsubmit: Object.assign({}, base.formsubmit, (over && over.formsubmit) || {}),
    updatedAt: (over && over.updatedAt) || base.updatedAt
  };
  out.smtp.port = parseInt(out.smtp.port || 465, 10);
  out.smtp.secure = out.smtp.port === 465 ? true : (out.smtp.port === 587 || out.smtp.port === 25 ? false : !!out.smtp.secure);
  return out;
}

let _cache = null;
let _cacheStamp = -1;

function loadConfig() {
  let stamp = 0;
  try { stamp = fs.statSync(CONF_FILE).mtimeMs; } catch (e) { stamp = 0; }
  if (_cache && stamp === _cacheStamp) return _cache;
  let fileCfg = blankConfig();
  try {
    const raw = fs.readFileSync(CONF_FILE, 'utf8');
    fileCfg = mergeConfig(blankConfig(), JSON.parse(raw));
    fileCfg.updatedAt = fileCfg.updatedAt || 0;
  } catch (e) { /* 无配置文件走默认 */ }
  const env = envConfig();
  const cfg = mergeConfig(fileCfg, {
    channel: fileCfg.channel && fileCfg.channel !== 'auto' ? fileCfg.channel : (env.channel || 'auto'),
    smtp: {
      preset: fileCfg.smtp.preset,
      host: fileCfg.smtp.host || env.smtp.host,
      port: fileCfg.smtp.host ? fileCfg.smtp.port : env.smtp.port,
      secure: fileCfg.smtp.host ? fileCfg.smtp.secure : env.smtp.secure,
      user: fileCfg.smtp.user || env.smtp.user,
      pass: fileCfg.smtp.pass || env.smtp.pass,
      from: fileCfg.smtp.from || env.smtp.from,
      fromName: fileCfg.smtp.fromName || env.smtp.fromName
    },
    formsubmit: {
      enabled: fileCfg.updatedAt ? fileCfg.formsubmit.enabled : env.formsubmit.enabled,
      subjectPrefix: fileCfg.formsubmit.subjectPrefix || env.formsubmit.subjectPrefix
    },
    updatedAt: fileCfg.updatedAt
  });
  _cache = cfg;
  _cacheStamp = stamp;
  return cfg;
}

function saveConfig(patch) {
  const cfg = mergeConfig(loadConfig(), patch || {});
  cfg.updatedAt = Date.now();
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(CONF_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  _cache = null; _cacheStamp = -1;
  return loadConfig();
}

function smtpReady(cfg) { return !!(cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass); }

function resolveChannel(cfg) {
  const want = String(cfg.channel || 'auto');
  if (want === 'none') return 'none';
  if (want === 'smtp') return smtpReady(cfg) ? 'smtp' : 'none';
  if (want === 'formsubmit') return cfg.formsubmit.enabled ? 'formsubmit' : 'none';
  if (smtpReady(cfg)) return 'smtp';
  if (cfg.formsubmit.enabled) return 'formsubmit';
  return 'none';
}

function configured() { return resolveChannel(loadConfig()) !== 'none'; }

function maskMail(s) {
  const v = String(s || '');
  const at = v.indexOf('@');
  if (at <= 0) return v ? v.slice(0, 2) + '***' : '';
  return v.slice(0, Math.min(3, at)) + '***' + v.slice(at);
}

function status() {
  const cfg = loadConfig();
  const ch = resolveChannel(cfg);
  return {
    channel: ch,
    ready: ch !== 'none',
    smtp: {
      ready: smtpReady(cfg),
      preset: cfg.smtp.preset || '',
      host: cfg.smtp.host || '',
      port: cfg.smtp.port,
      secure: !!cfg.smtp.secure,
      user: maskMail(cfg.smtp.user),
      from: cfg.smtp.from || cfg.smtp.user || '',
      fromName: cfg.smtp.fromName || 'AYCHO'
    },
    formsubmit: {
      enabled: !!cfg.formsubmit.enabled,
      endpoint: 'https://formsubmit.co/ajax/<收件邮箱>',
      note: '零配置通道：首次向某邮箱转发时，该邮箱会收到一封 Activate Form 激活邮件，点一次即完成一次性激活'
    },
    updatedAt: cfg.updatedAt,
    presets: PRESETS
  };
}

/* ------------------------------ SMTP 实现 ------------------------------ */
function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
function encodeHeader(s) { return '=?UTF-8?B?' + b64(s) + '?='; }

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
    this.waiters = [];
    socket.setEncoding('utf8');
    socket.on('data', (d) => this._onData(d));
    socket.on('error', (e) => this._fail(e));
    socket.on('close', () => this._fail(new Error('SMTP 连接已关闭')));
  }
  _onData(d) {
    this.buf += d;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx + 1);
      this.buf = this.buf.slice(idx + 1);
      this._onLine(line);
    }
  }
  _onLine(line) {
    if (!this.waiters.length) return;
    const w = this.waiters[0];
    w.lines.push(line);
    if (line.charAt(3) === '-') return;          // 多行响应继续
    this.waiters.shift();
    clearTimeout(w.timer);
    w.resolve({ code: line.slice(0, 3), text: w.lines.join('') });
  }
  _fail(err) {
    const list = this.waiters.splice(0);
    list.forEach((w) => { clearTimeout(w.timer); w.reject(err); });
  }
  expect(timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { resolve: resolve, reject: reject, lines: [], timer: null };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('SMTP 响应超时（服务商未在 20 秒内响应，可能被网络拦截）'));
      }, timeoutMs || 20000);
      this.waiters.push(w);
    });
  }
  async cmd(line, expectCode) {
    const p = this.expect();
    this.socket.write(line + '\r\n');
    const r = await p;
    if (expectCode && String(r.code).charAt(0) !== String(expectCode).charAt(0)) {
      throw new Error('SMTP 命令失败 [' + line.split(' ')[0] + '] ' + r.code + ' ' + r.text.trim().slice(0, 200));
    }
    return r;
  }
  async payload(msg) {
    const p = this.expect();
    this.socket.write(msg + '\r\n.\r\n');
    const r = await p;
    if (String(r.code).charAt(0) !== '2') throw new Error('SMTP 投递被拒 ' + r.code + ' ' + r.text.trim().slice(0, 200));
    return r;
  }
  quit() { try { this.socket.write('QUIT\r\n'); this.socket.end(); } catch (e) {} }
}

function connect(host, port, secure) {
  return new Promise((resolve, reject) => {
    const opts = { host: host, port: port, servername: host };
    const sock = secure ? tls.connect(opts, () => resolve(sock)) : net.connect(opts, () => resolve(sock));
    sock.setTimeout(20000, () => { try { sock.destroy(); } catch (e) {} reject(new Error('SMTP 连接超时（网络不可达或端口被拦截）')); });
    sock.once('error', (e) => reject(new Error('SMTP 连接失败：' + (e && e.message ? e.message : e))));
  });
}

/* TCP 连通性探测：只握手读问候语，不发信 */
function probeSmtp(host, port, secure) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const done = (ok, detail) => resolve({ ok: ok, host: host, port: port, ms: Date.now() - t0, detail: detail });
    let sock;
    try {
      sock = (secure === undefined ? (port === 465) : !!secure)
        ? tls.connect({ host: host, port: port, servername: host }, onConn)
        : net.connect({ host: host, port: port }, onConn);
    } catch (e) { return done(false, String(e && e.message || e)); }
    let got = false;
    function onConn() { /* 等待问候语 */ }
    sock.setTimeout(10000, () => { if (!got) { try { sock.destroy(); } catch (e) {} done(false, '连接超时'); } });
    sock.once('data', (d) => { got = true; const s = String(d).trim().split('\n')[0]; try { sock.destroy(); } catch (e) {} done(true, '服务端问候：' + s); });
    sock.once('error', (e) => { if (!got) done(false, (e && e.message) ? e.message : String(e)); });
  });
}

function buildMessage(from, fromName, to, subject, text, html) {
  const boundary = 'aycho-' + crypto.randomBytes(8).toString('hex');
  const head = [
    'From: ' + encodeHeader(fromName) + ' <' + from + '>',
    'To: <' + to + '>',
    'Subject: ' + encodeHeader(subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@aycho>',
    'MIME-Version: 1.0'
  ];
  const bodyText = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  let msg;
  if (html) {
    const bodyHtml = Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    msg = head.concat([
      'Content-Type: multipart/alternative; boundary="' + boundary + '"', '',
      '--' + boundary, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', bodyText,
      '--' + boundary, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', bodyHtml,
      '--' + boundary + '--'
    ]).join('\r\n');
  } else {
    msg = head.concat(['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', bodyText]).join('\r\n');
  }
  return msg.split('\r\n').map((l) => (l.charAt(0) === '.' ? '.' + l : l)).join('\r\n');
}

function smtpErrorHint(msg) {
  const s = String(msg || '');
  if (/535|authentication|auth/i.test(s)) return s + '（授权码/账号不正确，请重新生成授权码，注意不是登录密码）';
  if (/ECONNREFUSED|ETIMEDOUT|timeout|超时/i.test(s)) return s + '（网络不可达：该 SMTP 主机/端口在当前服务器所在网络被拦截）';
  if (/getaddrinfo|ENOTFOUND/i.test(s)) return s + '（SMTP 主机名无法解析）';
  return s;
}

async function sendViaSmtp(cfg, to, subject, text, html) {
  const s = cfg.smtp;
  const from = s.from || s.user;
  const fromName = s.fromName || 'AYCHO';
  const secure = (s.port === 465) ? true : (s.port === 587 || s.port === 25 ? false : !!s.secure);
  let sock, session;
  try {
    sock = await connect(s.host, s.port, secure);
    session = new SmtpSession(sock);
    await session.expect(20000);
    let ehlo = await session.cmd('EHLO aycho.local', '2');
    if (!secure) {
      if (ehlo.text.toUpperCase().indexOf('STARTTLS') >= 0) {
        await session.cmd('STARTTLS', '2');
        session.socket.removeAllListeners('data');
        session.socket.removeAllListeners('error');
        session.socket.removeAllListeners('close');
        sock = await new Promise((resolve, reject) => {
          const t = tls.connect({ socket: session.socket, servername: s.host }, () => resolve(t));
          t.once('error', reject);
        });
        session = new SmtpSession(sock);
        await session.cmd('EHLO aycho.local', '2');
      } else {
        throw new Error('服务端不支持 STARTTLS，出于安全已中止');
      }
    }
    await session.cmd('AUTH LOGIN', '3');
    await session.cmd(b64(s.user), '3');
    await session.cmd(b64(s.pass), '2');
    await session.cmd('MAIL FROM:<' + from + '>', '2');
    await session.cmd('RCPT TO:<' + to + '>', '2');
    await session.cmd('DATA', '3');
    await session.payload(buildMessage(from, fromName, to, subject, text, html));
    session.quit();
    return { sent: true, channel: 'smtp' };
  } catch (e) {
    try { if (session) session.quit(); else if (sock) sock.destroy(); } catch (_) {}
    return { sent: false, channel: 'smtp', reason: smtpErrorHint(e && e.message ? e.message : String(e)) };
  }
}

/* ------------------------------ FormSubmit 实现 ------------------------------ */
function httpsPostJson(urlStr, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('URL 非法')); }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + (u.search || ''), method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Accept': 'application/json',
        'Origin': 'https://formsubmit.co',
        'Referer': 'https://formsubmit.co/',
        'User-Agent': 'AYCHO-Mailer/2.0'
      }, headers || {})
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: buf }));
    });
    req.setTimeout(timeoutMs || 25000, () => { try { req.destroy(); } catch (e) {} reject(new Error('HTTPS 请求超时')); });
    req.on('error', (e) => reject(new Error('HTTPS 请求失败：' + (e && e.message ? e.message : e))));
    req.write(body);
    req.end();
  });
}

function extractCode(text) {
  const m = /(\d{6})/.exec(String(text || ''));
  return m ? m[1] : '';
}

async function sendViaFormSubmit(cfg, to, subject, text) {
  const prefix = cfg.formsubmit.subjectPrefix || 'AYCHO';
  const code = extractCode(text);
  const payload = {
    _subject: '[' + prefix + '] ' + subject,
    _template: 'table',
    _captcha: 'false',
    收件邮箱: to,
    验证码: code || '（见正文）',
    正文: text,
    时间: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  };
  try {
    const url = 'https://formsubmit.co/ajax/' + encodeURIComponent(to);
    const r = await httpsPostJson(url, payload);
    let data = null;
    try { data = JSON.parse(r.text); } catch (e) {}
    const msg = data && (data.message || data.success) ? String(data.message || '') : String(r.text || '').slice(0, 200);
    if (r.status >= 200 && r.status < 300 && data && String(data.success) === 'true') {
      return { sent: true, channel: 'formsubmit' };
    }
    if (/activat/i.test(msg)) {
      return {
        sent: false, channel: 'formsubmit', needActivate: true,
        reason: '该邮箱尚未激活转发通道：激活邮件已发往 ' + to + '，请在收件箱（含垃圾箱）点击 “Activate Form” 完成一次性激活后重试'
      };
    }
    return { sent: false, channel: 'formsubmit', reason: '转发服务返回：' + (msg || ('HTTP ' + r.status)) };
  } catch (e) {
    return { sent: false, channel: 'formsubmit', reason: (e && e.message) ? e.message : String(e) };
  }
}

/* ------------------------------ 统一发送入口 ------------------------------ */
async function sendMail(to, subject, text, html) {
  const cfg = loadConfig();
  const ch = resolveChannel(cfg);
  if (ch === 'none') {
    return { sent: false, channel: 'none', reason: '未配置发信通道（可在「设置 → 邮件服务」中填写 SMTP 授权码）' };
  }
  if (ch === 'smtp') return sendViaSmtp(cfg, to, subject, text, html);
  return sendViaFormSubmit(cfg, to, subject, text);
}

/* 带通道回退：优先 SMTP，失败自动降级到 FormSubmit（用于测试发信与关键通知） */
async function sendMailWithFallback(to, subject, text, html) {
  const cfg = loadConfig();
  const first = await sendMail(to, subject, text, html);
  if (first.sent) return first;
  if (resolveChannel(cfg) === 'smtp' && cfg.formsubmit.enabled) {
    const fb = await sendViaFormSubmit(cfg, to, subject, text);
    if (fb.sent) return { sent: true, channel: 'formsubmit', fallbackFrom: 'smtp' };
    return { sent: false, channel: 'none', reason: 'SMTP：' + (first.reason || '') + '；转发通道：' + (fb.reason || '') };
  }
  return first;
}

module.exports = {
  configured: configured,
  sendMail: sendMail,
  sendMailWithFallback: sendMailWithFallback,
  status: status,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  probeSmtp: probeSmtp,
  PRESETS: PRESETS
};
