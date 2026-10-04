/* AYCHO module: server/lib/sync | 真实多端同步（账号级云端快照）
 * 同一账号在任意设备登录后，拉取/推送工作台快照（会话、产出物、设置、记忆等）。
 *   GET  /api/sync            拉取当前账号快照
 *   POST /api/sync {data}     推送快照（最后写入生效，rev 递增）
 * 安全：必须携带有效会话令牌；快照按 userId 隔离，互不可见。
 * 注意：前端推送前会剥离模型密钥，密钥不出本机。
 */
'use strict';

const db = require('./db');
const { sendJson, readJson, bearer } = require('./http');

const MAX_SNAPSHOT = 4 * 1024 * 1024;   // 4MB

function ensure() {
  const d = db.load();
  if (!d.syncs) d.syncs = {};
  return d;
}

function pull(req, res) {
  const user = db.userByToken(bearer(req));
  if (!user) return sendJson(res, 401, { ok: false, message: '未登录或登录已过期' });
  const d = ensure();
  const rec = d.syncs[user.id];
  if (!rec) return sendJson(res, 200, { ok: true, empty: true, data: null, rev: 0, updatedAt: 0 });
  return sendJson(res, 200, { ok: true, empty: false, data: rec.data, rev: rec.rev, updatedAt: rec.updatedAt });
}

async function push(req, res) {
  const user = db.userByToken(bearer(req));
  if (!user) return sendJson(res, 401, { ok: false, message: '未登录或登录已过期' });
  const body = await readJson(req, MAX_SNAPSHOT);
  if (body.data == null) return sendJson(res, 400, { ok: false, message: '缺少 data' });
  const size = Buffer.byteLength(JSON.stringify(body.data), 'utf8');
  if (size > MAX_SNAPSHOT) return sendJson(res, 413, { ok: false, message: '快照过大（' + Math.round(size / 1024) + 'KB），上限 4MB' });
  const d = ensure();
  const prev = d.syncs[user.id];
  const rev = (prev ? prev.rev : 0) + 1;
  d.syncs[user.id] = { data: body.data, rev: rev, updatedAt: Date.now(), size: size };
  db.save();
  return sendJson(res, 200, { ok: true, rev: rev, updatedAt: d.syncs[user.id].updatedAt, size: size });
}

function status(req, res) {
  const user = db.userByToken(bearer(req));
  if (!user) return sendJson(res, 401, { ok: false, message: '未登录或登录已过期' });
  const d = ensure();
  const rec = d.syncs[user.id];
  return sendJson(res, 200, {
    ok: true,
    exists: !!rec,
    rev: rec ? rec.rev : 0,
    updatedAt: rec ? rec.updatedAt : 0,
    size: rec ? rec.size : 0
  });
}

module.exports = { pull: pull, push: push, status: status };
