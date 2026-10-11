/* AYCHO module: server/lib/datasync | 账号库/分享数据 ↔ GitHub 数据分支 持久化
 *
 * 背景：Render 免费实例没有持久盘，容器一旦重建，server/data/db.json 即清零，
 * 于是用户登录时被提示「此邮箱尚未注册」——但工作区文件因 gitsync 已云同步而仍在，
 * 造成「账号没了、数据还在」的假象。本模块把账号库（users/sessions/codes/shares/syncs）
 * 与分享文件一并加密同步到 GitHub 独立数据分支，容器重建后自动恢复。
 *
 * 环境变量（全部可选，默认复用工作区同步已有的仓库与令牌 → 零额外配置即可生效）：
 *   AYCHO_DATA_REPO   仓库 full_name，默认 jimibiuev/aycho-gateway（未设时也可用 AYCHO_WS_REPO 覆盖）
 *   AYCHO_DATA_BRANCH 分支名，默认 aycho-data（独立分支，不触发前台部署）
 *   AYCHO_DATA_PATH   仓库内文件名，默认 aycho-db.enc.json
 *   AYCHO_DATA_TOKEN  GitHub PAT（contents 读写），回退链 AYCHO_DATA_TOKEN → AYCHO_GHA_TOKEN → AYCHO_WS_TOKEN → GITHUB_TOKEN
 *   AYCHO_DATA_KEY    加密口令，缺省由 TOKEN 派生（仓库里只存密文，公开仓库也不泄露）
 *   AYCHO_DATA_AUTO   1=改动后自动推送（默认，db.save() 防抖 5s 触发），0=仅手动
 * 启动流程：terminal-server.js 的 bootDataSync() 先跑 datasync.pull()（25s 超时兜底，
 * 拉取失败降级本地 + 记日志，绝不让启动卡死），再 startServer()。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const db = require('./db');

const CFG = {
  repo: String(process.env.AYCHO_DATA_REPO || process.env.AYCHO_WS_REPO || 'jimibiuev/aycho-gateway').trim(),
  branch: String(process.env.AYCHO_DATA_BRANCH || 'aycho-data').trim() || 'aycho-data',
  file: String(process.env.AYCHO_DATA_PATH || 'aycho-db.enc.json').replace(/^\/+/, '').trim() || 'aycho-db.enc.json',
  token: String(process.env.AYCHO_DATA_TOKEN || process.env.AYCHO_GHA_TOKEN || process.env.AYCHO_WS_TOKEN || process.env.GITHUB_TOKEN || '').trim(),
  key: String(process.env.AYCHO_DATA_KEY || '').trim(),
  auto: String(process.env.AYCHO_DATA_AUTO == null ? '1' : process.env.AYCHO_DATA_AUTO) !== '0'
};

const STATE_FILE = path.join(path.dirname(db.DB_FILE), '.datasync-state.json');
const PUSH_DEBOUNCE = 5000;        // db.save() 后 5s 防抖推云
const PUSH_RETRY = 30 * 1000;
const BOOT_TIMEOUT = 25000;        // 启动回灌兜底：绝不让启动卡死

let state = { lastPullAt: 0, lastPushAt: 0, lastError: '' };
let timer = null;
let running = false;
let queued = false;
let suppress = false;

function enabled() { return !!(CFG.repo && CFG.token); }

function loadState() {
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { /* 首次 */ }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
}
loadState();

/* ------------------------------ 加密（AES-256-GCM） ------------------------------ */
function deriveKey() {
  const secret = CFG.key || CFG.token;
  if (!secret) throw new Error('缺少同步密钥（AYCHO_DATA_KEY / AYCHO_DATA_TOKEN 均为空）');
  return crypto.createHash('sha256').update('aycho-datasync/v1:' + secret).digest();
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function decrypt(b64) {
  const b = Buffer.from(String(b64 || ''), 'base64');
  if (b.length < 29) throw new Error('云端数据为空或已损坏');
  const iv = b.slice(0, 12);
  const tag = b.slice(12, 28);
  const data = b.slice(28);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

/* ------------------------------ GitHub API ------------------------------ */
function apiCall(p, method, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      'User-Agent': 'aycho-datasync',
      'Accept': 'application/vnd.github+json',
      'Authorization': 'token ' + CFG.token
    };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const req = https.request({ hostname: 'api.github.com', path: p, method: method, headers: headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf || '{}'); } catch (e) { j = null; }
        resolve({ status: res.statusCode, body: j, raw: buf });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('GitHub API 超时')));
    if (payload) req.write(payload);
    req.end();
  });
}
const contentsPath = () => '/repos/' + CFG.repo + '/contents/' + CFG.file.split('/').map(encodeURIComponent).join('/');

/* 数据分支不存在时创建（contents API 不会自动建分支，需基于默认分支 HEAD 新建） */
async function ensureBranch() {
  const cur = await apiCall('/repos/' + CFG.repo + '/git/ref/heads/' + encodeURIComponent(CFG.branch), 'GET');
  if (cur.status === 200) return { ok: true };
  const repo = await apiCall('/repos/' + CFG.repo, 'GET');
  const def = (repo.body && repo.body.default_branch) || 'main';
  const head = await apiCall('/repos/' + CFG.repo + '/git/ref/heads/' + encodeURIComponent(def), 'GET');
  if (head.status !== 200 || !head.body || !head.body.object) {
    return { ok: false, message: '读取默认分支失败 HTTP ' + head.status };
  }
  const r = await apiCall('/repos/' + CFG.repo + '/git/refs', 'POST', {
    ref: 'refs/heads/' + CFG.branch,
    sha: head.body.object.sha
  });
  if (r.status === 201 || /already exists/i.test(String(r.raw || ''))) return { ok: true, created: true };
  return { ok: false, message: '创建数据分支失败 HTTP ' + r.status + ' ' + String(r.raw || '').slice(0, 160) };
}

/* ------------------------------ 打包 / 合并 ------------------------------ */
function collectShares() {
  const out = {};
  try {
    fs.readdirSync(db.SHARE_DIR).forEach((f) => {
      if (!/\.json$/.test(f)) return;
      try { out[f] = fs.readFileSync(path.join(db.SHARE_DIR, f)).toString('base64'); } catch (e) { /* 跳过 */ }
    });
  } catch (e) { /* 目录不存在 */ }
  return out;
}

function collect() {
  const d = db.load();
  if (typeof db.prune === 'function') db.prune();
  return { v: 1, at: Date.now(), db: d, shares: collectShares() };
}

/* 合并云端与本地：两边都保留，避免「刚注册的账号被云端旧数据覆盖」 */
function mergeDb(local, remote) {
  const L = local || {};
  const R = remote || {};
  const out = { version: 1, users: [], sessions: [], codes: {}, shares: [], syncs: {}, meta: {} };

  const userKey = (u) => String((u && u.email) || (u && u.id) || '');
  const byEmail = new Map();
  (R.users || []).forEach((u) => { if (u) byEmail.set(userKey(u), u); });
  (L.users || []).forEach((u) => { if (u && !byEmail.has(userKey(u))) byEmail.set(userKey(u), u); });
  out.users = Array.from(byEmail.values());

  const sessions = new Map();
  (R.sessions || []).concat(L.sessions || []).forEach((s) => { if (s && s.token) sessions.set(s.token, s); });
  out.sessions = Array.from(sessions.values()).filter((s) => !s.expiresAt || s.expiresAt > Date.now());

  const codes = {};
  [R.codes || {}, L.codes || {}].forEach((src) => {
    Object.keys(src).forEach((k) => {
      const a = codes[k], b = src[k];
      if (!b) return;
      if (!a || (b.sentAt || 0) >= (a.sentAt || 0)) codes[k] = b;
    });
  });
  Object.keys(codes).forEach((k) => { if (codes[k] && codes[k].expiresAt && codes[k].expiresAt <= Date.now()) delete codes[k]; });
  out.codes = codes;

  const shares = new Map();
  (R.shares || []).concat(L.shares || []).forEach((s) => {
    if (!s || !s.slug) return;
    const prev = shares.get(s.slug);
    if (!prev || (s.createdAt || 0) > (prev.createdAt || 0)) shares.set(s.slug, s);
  });
  out.shares = Array.from(shares.values());

  const syncs = {};
  Object.keys(R.syncs || {}).forEach((k) => { syncs[k] = R.syncs[k]; });
  Object.keys(L.syncs || {}).forEach((k) => {
    const a = syncs[k], b = L.syncs[k];
    if (!a || ((b && b.updatedAt) || 0) >= ((a && a.updatedAt) || 0)) syncs[k] = b;
  });
  out.syncs = syncs;
  Object.keys(L.meta || {}).forEach((k) => { out.meta[k] = L.meta[k]; });
  Object.keys(R.meta || {}).forEach((k) => { if (out.meta[k] === undefined) out.meta[k] = R.meta[k]; });
  return out;
}

function writeLocalDb(obj) {
  const tmp = db.DB_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.mkdirSync(path.dirname(db.DB_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, db.DB_FILE);
}

function writeLocalShares(shares) {
  if (!shares) return 0;
  try { fs.mkdirSync(db.SHARE_DIR, { recursive: true }); } catch (e) { return 0; }
  let n = 0;
  Object.keys(shares).forEach((name) => {
    if (!/^[\w.-]+\.json$/.test(name)) return;
    const p = path.join(db.SHARE_DIR, name);
    if (fs.existsSync(p)) return;                 // 本地已存在的不覆盖
    try { fs.writeFileSync(p, Buffer.from(shares[name], 'base64')); n++; } catch (e) { /* 跳过 */ }
  });
  return n;
}

/* ------------------------------ pull / push ------------------------------ */
async function pull() {
  if (!enabled()) return { ok: false, message: '未配置 AYCHO_DATA_REPO / AYCHO_DATA_TOKEN，账号云同步未启用' };
  let r;
  try {
    r = await apiCall(contentsPath() + '?ref=' + encodeURIComponent(CFG.branch), 'GET');
  } catch (e) {
    return { ok: false, message: (e && e.message) || '拉取失败' };
  }
  if (r.status === 404) return { ok: true, empty: true, message: '云端暂无账号数据（首次运行）' };
  if (r.status !== 200 || !r.body || !r.body.content) {
    return { ok: false, message: '云端返回 HTTP ' + r.status + ' ' + String(r.raw || '').slice(0, 160) };
  }
  let remote;
  try {
    /* contents API 返回的 content 即密文的 base64 编码（PUT 时 GitHub 已把 content 解码为原始字节存储） */
    const b64 = String(r.body.content).replace(/\s/g, '');
    console.log('[datasync] 云端密文 ' + Buffer.from(b64, 'base64').length + ' 字节');
    remote = decrypt(b64);
  } catch (e) {
    return { ok: false, message: '解密失败：' + ((e && e.message) || '数据损坏') };
  }
  let merged;
  try {
    suppress = true;
    merged = mergeDb(db.load(), remote.db);
    writeLocalDb(merged);
    const n = writeLocalShares(remote.shares);
    if (typeof db.reset === 'function') db.reset();
    state.lastPullAt = Date.now();
    state.lastError = '';
    saveState();
    return { ok: true, users: (merged.users || []).length, shares: n };
  } catch (e) {
    return { ok: false, message: '写入失败：' + ((e && e.message) || '未知错误') };
  } finally {
    suppress = false;
  }
}

async function push(reason, retry) {
  if (!enabled()) return { ok: false, message: '未配置 AYCHO_DATA_REPO / AYCHO_DATA_TOKEN，账号云同步未启用' };
  if (running) { queued = true; return { ok: false, message: '同步进行中，已排队' }; }
  running = true;
  try {
    const payload = encrypt(collect());
    const br = await ensureBranch();
    if (!br.ok) {
      state.lastError = br.message; saveState();
      if (retry !== false) scheduleRetry();
      return { ok: false, message: br.message };
    }
    let sha = null;
    const g = await apiCall(contentsPath() + '?ref=' + encodeURIComponent(CFG.branch), 'GET');
    if (g.status === 200 && g.body && g.body.sha) sha = g.body.sha;
    const body = {
      message: 'data: 账号库同步（' + (reason || 'auto') + '）',
      content: payload,
      branch: CFG.branch
    };
    if (sha) body.sha = sha;
    const r = await apiCall(contentsPath(), 'PUT', body);
    if (r.status >= 200 && r.status < 300) {
      state.lastPushAt = Date.now();
      state.lastError = '';
      saveState();
      return { ok: true, at: state.lastPushAt, created: !sha };
    }
    state.lastError = 'HTTP ' + r.status + ' ' + String(r.raw || '').slice(0, 160);
    saveState();
    if (retry !== false) scheduleRetry();
    return { ok: false, message: state.lastError };
  } catch (e) {
    state.lastError = (e && e.message) || '推送异常';
    saveState();
    if (retry !== false) scheduleRetry();
    return { ok: false, message: state.lastError };
  } finally {
    running = false;
    if (queued) { queued = false; schedule(1500); }
  }
}

function schedule(delay) {
  if (!enabled() || !CFG.auto) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; push('auto'); }, delay == null ? PUSH_DEBOUNCE : delay);
}
function scheduleRetry() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; push('retry'); }, PUSH_RETRY);
}

/* db.save() 之后自动排一次同步（pull 落盘期间抑制，避免自触发） */
db.onSave(() => { if (!suppress) schedule(); });

async function bootInit() {
  if (!enabled()) {
    console.log('[datasync] 未配置数据仓库/令牌，账号云同步关闭（账号仍存在容器临时盘中）');
    return { ok: false, message: '未启用' };
  }
  console.log('[datasync] 已启用：' + CFG.repo + '@' + CFG.branch + '（账号库加密同步）');
  let r;
  try {
    r = await Promise.race([
      pull(),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: '回灌超时（25s 兜底），降级使用本地数据' }), BOOT_TIMEOUT))
    ]);
  } catch (e) {
    r = { ok: false, message: (e && e.message) || '回灌异常' };
  }
  if (!r.ok) {
    console.error('[datasync] 启动拉取失败，降级使用本地账号库：' + r.message);
    return r;
  }
  if (r.ok && r.empty) {
    console.log('[datasync] 云端为空，正在把当前账号库首次上传…');
    const p = await push('initial');
    const n = (collect().db.users || []).length;
    console.log('[datasync] 首次上传' + (p.ok ? '完成（账号 ' + n + ' 个）' : '失败：' + p.message));
    return { ok: p.ok, empty: true, users: n, message: p.message };
  }
  console.log('[datasync] 启动恢复' + (r.ok ? '完成：账号 ' + r.users + ' 个、分享文件 ' + r.shares + ' 个' : '失败：' + r.message));
  return r;
}

function status() {
  return {
    enabled: enabled(),
    repo: CFG.repo,
    branch: CFG.branch,
    file: CFG.file,
    auto: CFG.auto,
    lastPullAt: state.lastPullAt,
    lastPushAt: state.lastPushAt,
    lastError: state.lastError,
    encrypted: true
  };
}

module.exports = { status: status, pull: pull, push: push, schedule: schedule, bootInit: bootInit };
