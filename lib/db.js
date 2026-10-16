/* AYCHO module: server/lib/db | 真实持久化层
 * 极简 JSON 文件数据库（零外部依赖）：用户 / 会话令牌 / 验证码 / 分享索引。
 * 写入采用「临时文件 + rename」原子替换，避免半截文件。
 * 数据目录：server/data（可用环境变量 AYCHO_DATA_DIR 覆盖）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.AYCHO_DATA_DIR || path.join(__dirname, '..', 'data'));
const SHARE_DIR = path.join(DATA_DIR, 'shares');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  version: 1,
  users: [],       // {id,email,name,pass:{salt,hash},createdAt,updatedAt}
  sessions: [],    // {token,userId,createdAt,expiresAt}
  codes: {},       // email+':'+scene → {code,expiresAt,tries}
  shares: [],      // {slug,artifactId,name,mime,size,ownerUserId,createdAt,revoked}
  syncs: {},       // userId → {data,rev,updatedAt,size}
  meta: {}
};

let db = null;

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SHARE_DIR, { recursive: true });
}

function load() {
  if (db) return db;
  ensureDirs();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = Object.assign({}, DEFAULT_DB, parsed);
  } catch (e) {
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
    save();
  }
  return db;
}

const saveHooks = [];
function onSave(fn) { if (typeof fn === 'function') saveHooks.push(fn); }

function save() {
  if (!db) return;
  ensureDirs();
  const tmp = DB_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
  for (let i = 0; i < saveHooks.length; i++) {
    try { saveHooks[i](); } catch (e) { /* 同步钩子异常不影响主流程 */ }
  }
}

/* 云端数据回灌后丢弃内存缓存，下次 load 重新读盘 */
function reset() { db = null; }

/* 清理过期会话与验证码，避免库无限膨胀 */
function prune() {
  const d = load();
  const now = Date.now();
  const before = { s: d.sessions.length, c: Object.keys(d.codes).length };
  d.sessions = (d.sessions || []).filter((s) => s && s.expiresAt > now);
  Object.keys(d.codes || {}).forEach((k) => {
    const c = d.codes[k];
    if (!c || !c.expiresAt || c.expiresAt <= now) delete d.codes[k];
  });
  if (before.s !== d.sessions.length || before.c !== Object.keys(d.codes).length) save();
}

/* ------------------------------ 会话 ------------------------------ */
const SESSION_TTL = 30 * 24 * 3600 * 1000;

function createSession(userId) {
  const d = load();
  const token = require('crypto').randomBytes(32).toString('hex');
  d.sessions.push({ token: token, userId: userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
  pruneSessions();
  save();
  return token;
}

function pruneSessions() {
  const d = load();
  const now = Date.now();
  d.sessions = d.sessions.filter((s) => s && s.expiresAt > now);
}

function userByToken(token) {
  if (!token) return null;
  const d = load();
  const s = d.sessions.find((x) => x && x.token === token);
  if (!s || s.expiresAt <= Date.now()) return null;
  return d.users.find((u) => u && u.id === s.userId) || null;
}

function dropSession(token) {
  const d = load();
  d.sessions = d.sessions.filter((s) => s && s.token !== token);
  save();
}

/* ------------------------------ 分享内容 ------------------------------ */
function sharePath(slug) { return path.join(SHARE_DIR, slug + '.json'); }

function writeShareBlob(slug, obj) {
  ensureDirs();
  const p = sharePath(slug);
  const tmp = p + '.tmp-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, p);
}

function readShareBlob(slug) {
  try { return JSON.parse(fs.readFileSync(sharePath(slug), 'utf8')); } catch (e) { return null; }
}

function removeShareBlob(slug) {
  try { fs.unlinkSync(sharePath(slug)); } catch (e) { /* 忽略 */ }
}

module.exports = {
  DATA_DIR: DATA_DIR,
  SHARE_DIR: SHARE_DIR,
  DB_FILE: DB_FILE,
  load: load,
  save: save,
  onSave: onSave,
  reset: reset,
  prune: prune,
  createSession: createSession,
  userByToken: userByToken,
  dropSession: dropSession,
  writeShareBlob: writeShareBlob,
  readShareBlob: readShareBlob,
  removeShareBlob: removeShareBlob
};
