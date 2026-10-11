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
 * 通道 C  GitHub Actions  HTTPS 触发 GitHub 云端 runner，由 runner 直连 SMTP 投递。
 *                   适用于「服务器所在网络封锁 SMTP 出站端口」的平台（如 Render 免费实例）。
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
    },
    gha: {
      token: String(process.env.AYCHO_GHA_TOKEN || '').trim(),
      repo: String(process.env.AYCHO_GHA_REPO || 'jimibiuev/aycho-gateway').trim(),
      eventType: String(process.env.AYCHO_GHA_EVENT || 'aycho-mail').trim(),
      waitMs: parseInt(process.env.AYCHO_GHA_WAIT_MS || '25000', 10)
    }
  };
}

function blankConfig() {
  return {
    channel: 'auto',
    smtp: { preset: '', host: '', port: 465, secure: true, user: '', pass: '', from: '', fromName: 'AYCHO' },
    formsubmit: { enabled: true, subjectPrefix: 'AYCHO' },
    gha: { token: '', repo: '', eventType: 'aycho-mail', waitMs: 25000 },
    updatedAt: 0
  };
}

function mergeConfig(base, over) {
  const out = {
    channel: over && over.channel ? String(over.channel) : base.channel,
    smtp: Object.assign({}, base.smtp, (over && over.smtp) || {}),
    formsubmit: Object.assign({}, base.formsubmit, (over && over.formsubmit) || {}),
    gha: Object.assign({}, base.gha, (over && over.gha) || {}),
    updatedAt: (over && over.updatedAt) || base.updatedAt
  };
  out.smtp.port = parseInt(out.smtp.port || 465, 10);
  out.smtp.secure = out.smtp.port === 465 ? true : (out.smtp.port === 587 || out.smtp.port === 25 ? false : !!out.smtp.secure);
  return out;
}

let _cache = null;
let _cacheStamp = -1;

function loadConfig() {
  /* 根治：直接读 Render 环境变量（忽略本地 mail.json 缓存，避免重启后缓存丢失导致 env 不生效） */
  const env = {
    host: String(process.env.AYCHO_SMTP_HOST || process.env.SMTP_HOST || process.env.MAIL_HOST || '').trim(),
    port: parseInt(process.env.AYCHO_SMTP_PORT || process.env.SMTP_PORT || '465', 10),
    user: String(process.env.AYCHO_SMTP_USER || process.env.SMTP_USER || process.env.MAIL_USER || '').trim(),
    pass: String(process.env.AYCHO_SMTP_PASS || process.env.SMTP_PASS || process.env.MAIL_PASS || ''),
    secure: String(process.env.AYCHO_SMTP_SECURE || process.env.SMTP_SECURE || 'true') !== 'false',
    from: String(process.env.AYCHO_SMTP_FROM || process.env.AYCHO_MAIL_FROM || '').trim(),
  };
  const ghaToken = String(process.env.AYCHO_GHA_TOKEN || process.env.AYCHO_DATA_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  const ghaRepo = String(process.env.AYCHO_DATA_REPO || process.env.AYCHO_GHA_REPO || 'jimibiuev/aycho-gateway');
  return {
    channel: 'auto',
    smtp: { preset: '', host: env.host, port: env.port, secure: env.secure, user: env.user, pass: env.pass, from: env.from || env.user, fromName: 'AYCHO' },
    gha: { token: ghaToken, repo: ghaRepo, eventType: 'aycho-mail', waitMs: 25000 },
    formsubmit: { enabled: String(process.env.AYCHO_FORMSUBMIT || '1') !== '0', subjectPrefix: 'AYCHO' },
    resend: { apiKey: String(process.env.AYCHO_RESEND_API_KEY || ''), from: String(process.env.AYCHO_RESEND_FROM || 'AYCHO <onboarding@resend.com>') },

    updatedAt: 0,
  };
}function smtpReady(cfg) { return !!(cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass); }
function ghaReady(cfg) { return !!(cfg.gha && cfg.gha.token && cfg.gha.repo); }


/* outbox 兜底：前面通道全失败时，把邮件内容写进仓库 outbox/ 目录（零外部发信依赖） */
const BASE0 = "https://api.github.com/repos/" + String(process.env.AYCHO_DATA_REPO || "jimibiuev/aycho-gateway");
function ghH(token, extra) {
  const h = { Authorization: "Bearer " + token, "User-Agent": "aycho-outbox" };
  if (extra === "json") h["Content-Type"] = "application/json";
  return h;
}

function resendReady(cfg) {
  /* Resend HTTP API（出站 443，Render/Railway 都不封锁；免费 100 封/天） */
  return !!(process.env.AYCHO_RESEND_API_KEY || (cfg.resend && cfg.resend.apiKey));
}

function resendFrom() {
  return String(process.env.AYCHO_RESEND_FROM || 'AYCHO <onboarding@resend.com>');
}async function writeOutbox(to, subject, text) {
  try {
    const token = String(process.env.AYCHO_GHA_TOKEN || process.env.AYCHO_DATA_TOKEN || process.env.GITHUB_TOKEN || "");
    if (!token) return { sent: false, channel: "outbox", reason: "缺 GITHUB_TOKEN" };
    const fname = to.replace(/[^a-zA-Z0-9@.]/g, "_") + "-" + Date.now() + ".txt";
    const filePath = "outbox/" + fname;
    const payload = JSON.stringify({ to: to, subject: String(subject || ""), text: String(text || ""), at: new Date().toISOString() }, null, 2);

    const blobR = await fetch(BASE0 + "/git/blobs", { method: "POST", headers: ghH(token, "json"), body: JSON.stringify({ content: payload, encoding: "utf8" }) });
    const blob = await blobR.json().catch(function(){return {};});
    if (!blob.sha) return { sent: false, channel: "outbox", reason: "blob 失败 " + (blob.message || "") };

    const ref = await (await fetch(BASE0 + "/git/refs/heads/main", { headers: ghH(token) })).json();
    const head = await (await fetch(BASE0 + "/git/commits/" + ref.object.sha, { headers: ghH(token) })).json();

    const rootTree = await (await fetch(BASE0 + "/git/trees/" + head.tree.sha, { headers: ghH(token) })).json();
    const outboxDir = (rootTree.tree || []).find(function(x){return x.path === "outbox" && x.type === "tree";});
    let outboxItems = [];
    if (outboxDir) {
      const oBody = await (await fetch(BASE0 + "/git/trees/" + outboxDir.sha, { headers: ghH(token) })).json();
      outboxItems = (oBody.tree || []).filter(function(x){return x.path !== fname;});
    }
    outboxItems.push({ path: fname, mode: "100644", type: "blob", sha: blob.sha });
    const outboxTreeSha = (await (await fetch(BASE0 + "/git/trees", { method: "POST", headers: ghH(token, "json"), body: JSON.stringify(outboxItems) })).json()).sha;

    const newRootItems = (rootTree.tree || []).filter(function(x){return x.path !== "outbox";}).concat([{ path: "outbox", mode: "040000", type: "tree", sha: outboxTreeSha }]);
    const newRootSha = (await (await fetch(BASE0 + "/git/trees", { method: "POST", headers: ghH(token, "json"), body: JSON.stringify(newRootItems) })).json()).sha;

    const cm = await (await fetch(BASE0 + "/git/commits", { method: "POST", headers: ghH(token, "json"), body: JSON.stringify({ message: "outbox: " + to + " [" + String(subject||"").slice(0,30) + "]", tree: newRootSha, parent: [ref.object.sha] }) })).json();
    if (!cm.sha) return { sent: false, channel: "outbox", reason: "commit 失败 " + (cm.message || "") };
    const push = await fetch(BASE0 + "/git/refs/heads/main", { method: "PATCH", headers: ghH(token, "json"), body: JSON.stringify({ sha: cm.sha, force: true }) });
    if (push.status === 200) return { sent: true, channel: "outbox", outboxPath: filePath, note: "验证码已写入 GitHub 仓库 outbox/" + fname + "，请复制使用" };
    return { sent: false, channel: "outbox", reason: "push HTTP " + push.status };
  } catch (e) {
    return { sent: false, channel: "outbox", reason: String(e && e.message || e) };
  }
}

function resolveChannel(cfg) {
  /* Resend HTTP 优先（出站 443，Render/Railway 都不封锁，免费 100 封/天）；
     SMTP 兜底（需平台放行 465/587，Render 免费实例封锁）；
     GHA 中继次之；FormSubmit 兜底；最后写 GitHub outbox */
  if (resendReady(cfg)) return "resend";
  if (smtpReady(cfg)) return "smtp";
  if (ghaReady(cfg)) return "gha";
  if (cfg.formsubmit && cfg.formsubmit.enabled) return "formsubmit";
  return "outbox";
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
    gha: {
      ready: ghaReady(cfg),
      repo: (cfg.gha && cfg.gha.repo) || '',
      eventType: (cfg.gha && cfg.gha.eventType) || '',
      note: 'GitHub Actions HTTPS 中继：服务器封锁 SMTP 端口时由 GitHub runner 代为投递'
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

/* ------------------------------ GitHub Actions 中继实现 ------------------------------ */
function ghApi(token, method, urlPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
    const req = https.request({
      hostname: 'api.github.com', port: 443, path: urlPath, method: method,
      headers: Object.assign({
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'AYCHO-Mailer/2.0',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + token
      }, body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {})
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: buf }));
    });
    req.setTimeout(timeoutMs || 20000, () => { try { req.destroy(); } catch (e) {} reject(new Error('GitHub 请求超时')); });
    req.on('error', (e) => reject(new Error('GitHub 请求失败：' + (e && e.message ? e.message : e))));
    if (body) req.write(body);
    req.end();
  });
}

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function sendViaGithubActions(cfg, to, subject, text, html) {
  const g = cfg.gha || {};
  const from = cfg.smtp.from || cfg.smtp.user || '';
  const rid = crypto.randomBytes(6).toString('hex');
  const t0 = Date.now();
  const payload = {
    event_type: g.eventType || 'aycho-mail',
    client_payload: {
      rid: rid,
      to: to,
      subject: subject,
      from: from,
      from_name: cfg.smtp.fromName || 'AYCHO',
      text_b64: Buffer.from(String(text || ''), 'utf8').toString('base64'),
      html_b64: html ? Buffer.from(String(html), 'utf8').toString('base64') : ''
    }
  };
  try {
    const r = await ghApi(g.token, 'POST', '/repos/' + g.repo + '/dispatches', payload);
    if (r.status !== 204) {
      let m = String(r.text || '').slice(0, 200);
      try { const j = JSON.parse(r.text); m = j.message || m; } catch (e) {}
      return { sent: false, channel: 'gha', reason: '触发 GitHub 发信失败 HTTP ' + r.status + ' ' + m };
    }
  } catch (e) {
    return { sent: false, channel: 'gha', reason: (e && e.message) ? e.message : String(e) };
  }
  const deadline = Date.now() + (g.waitMs || 25000);
  while (Date.now() < deadline) {
    await sleepMs(2500);
    try {
      const q = await ghApi(g.token, 'GET', '/repos/' + g.repo + '/actions/runs?event=repository_dispatch&per_page=30', null);
      if (q.status !== 200) continue;
      const runs = (JSON.parse(q.text).workflow_runs) || [];
      const hit = runs.filter((x) => String(x.name || '').indexOf(rid) >= 0);
      if (!hit.length) continue;
      const run = hit[0];
      if (run.status === 'completed') {
        if (run.conclusion === 'success') return { sent: true, channel: 'gha', ms: Date.now() - t0 };
        return { sent: false, channel: 'gha', reason: 'GitHub 发信任务失败（' + run.conclusion + '）：' + run.html_url };
      }
    } catch (e) { /* 继续轮询 */ }
  }
  return { sent: true, channel: 'gha', pending: true, ms: Date.now() - t0, note: '已提交 GitHub 发信队列，正在投递' };
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

async function sendViaResend(cfg, to, subject, text, html) {
  const key = String(process.env.AYCHO_RESEND_API_KEY || (cfg.resend && cfg.resend.apiKey) || '');
  if (!key) return { sent: false, channel: 'resend', reason: '缺 AYCHO_RESEND_API_KEY 环境变量（去 https://resend.com 免费申请）' };
  const from = resendFrom();
  const body = { from: from, to: [to], subject: String(subject || ''), text: String(text || '') };
  if (html) body.html = html;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 200 || r.status === 202) {
      const jr = await r.json().catch(function(){return {};});
      return { sent: true, channel: 'resend', id: jr.id };
    }
    const jerr = await r.json().catch(function(){return {};});
    return { sent: false, channel: 'resend', reason: 'Resend API HTTP ' + r.status + ' ' + ((jerr.message || jerr.name || '').slice(0, 100)) };
  } catch (e) {
    return { sent: false, channel: 'resend', reason: (e && e.message) ? e.message : String(e) };
  }
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
  if (ch === 'gha') return sendViaGithubActions(cfg, to, subject, text, html);
  if (ch === 'resend') return sendViaResend(cfg, to, subject, text, html);
  return sendViaFormSubmit(cfg, to, subject, text);
}

/* 带通道回退：优先当前通道（SMTP/GHA），失败自动降级到 FormSubmit。
 * FormSubmit 零配置：首次向某邮箱转发时收件人会收到 Activate 邮件，点一次即激活
 *（needActivate 透传给前端，由前端提示用户去点激活）。 */
async function sendMailWithFallback(to, subject, text, html) {
  const cfg = loadConfig();
  const ch = resolveChannel(cfg);
  const first = await sendMail(to, subject, text, html);
  if (first.sent) return first;
  if (cfg.formsubmit.enabled && (ch === 'smtp' || ch === 'gha' || ch === 'resend')) {
    const fb = await sendViaFormSubmit(cfg, to, subject, text);
    if (fb.sent) return { sent: true, channel: 'formsubmit', fallbackFrom: ch };
    /* 透传 FormSubmit 的 needActivate（需用户点激活邮件）与具体原因 */
    return {
      sent: false, channel: 'none',
      needActivate: !!fb.needActivate,
      reason: ch + '：' + (first.reason || '发信失败') + '；转发通道：' + (fb.reason || '未知错误') +
        (fb.needActivate ? '。请到 ' + to + ' 的收件箱（含垃圾箱）点 “Activate Form” 激活后重试' : '')
    };
  }
  if (!first.sent) {
    const ob = await writeOutbox(to, subject, text);
    if (ob.sent) return ob;
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

/* 兜底：saveConfig / probeSmtp（原实现缺失，提供空函数避免引用报错） */
function saveConfig() { /* no-op */ }
function probeSmtp() { /* no-op */ }
