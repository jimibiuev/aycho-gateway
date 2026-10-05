/* AYCHO module: server/lib/api | 统一后端网关路由
 * 与终端 WebSocket(/pty)、静态托管共用一个 HTTP 服务，天然同源，前端 apiBase 留空即可。
 * 路由表：
 *   GET  /api/health                健康检查 + 能力自述（前端据此判定「真实模式」）
 *   POST /api/auth/send-code        发送邮箱验证码（真实 SMTP）
 *   POST /api/auth/register         注册
 *   POST /api/auth/login            登录
 *   POST /api/auth/reset-password   重置密码
 *   GET  /api/auth/me               当前用户
 *   POST /api/auth/logout           退出登录
 *   GET  /api/models                上游模型列表（服务端密钥）
 *   GET  /api/model/status          服务端模型配置状态
 *   POST /api/chat                  对话（SSE 流式代理）
 *   POST /api/share                 新建分享
 *   GET  /api/share/:id             取分享内容
 *   DELETE /api/share/:id           停止分享
 *   GET  /api/shares                分享列表
 *   GET  /artifact/:id              公开 HTML 分享页（链接本身即页面）
 *   GET  /s/:id                     分享只读页（带壳，公开）
 *   GET  /api/fs/tree               工作区真实文件树（IDE/文件面板）
 *   POST /api/fs/write|mkdir|rename|delete|sync  工作区真实增删改
 *   POST /api/run                   工作区内执行命令
 *   GET  /api/browser/proxy?url=    浏览器面板的服务端代理（绕过 X-Frame-Options）
 */
'use strict';

const url = require('url');
const auth = require('./auth');
const chat = require('./chat');
const share = require('./share');
const sync = require('./sync');
const fsapi = require('./fsapi');
const webproxy = require('./webproxy');
const mailer = require('./mailer');
const gitsync = require('./gitsync');
const { sendJson, applyCors, readJson } = require('./http');

function norm(p) { return String(p || '/').replace(/\/+$/, '') || '/'; }

async function route(req, res) {
  const parsed = url.parse(req.url, true);
  const path = norm(parsed.pathname);
  const q = parsed.query || {};
  const method = String(req.method || 'GET').toUpperCase();

  /* ---------------- 健康检查 / 能力自述 ---------------- */
  if (path === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      name: 'aycho-gateway',
      version: 1,
      time: Date.now(),
      features: {
        auth: true,
        chat: !!(process.env.AYCHO_MODEL_BASE_URL && process.env.AYCHO_MODEL_API_KEY),
        mail: mailer.configured(),
        share: true,
        fs: true,
        browserProxy: true,
        smtp: mailer.configured()
      },
      shareBase: String(process.env.AYCHO_SHARE_BASE || '')
    });
  }

  /* ---------------- 鉴权 ---------------- */
  if (path === '/api/auth/send-code' && method === 'POST') return auth.sendCode(req, res);
  if (path === '/api/auth/register' && method === 'POST') return auth.register(req, res);
  if (path === '/api/auth/login' && method === 'POST') return auth.login(req, res);
  if (path === '/api/auth/reset-password' && method === 'POST') return auth.resetPassword(req, res);
  if (path === '/api/auth/change-password' && method === 'POST') return auth.changePassword(req, res);
  if (path === '/api/auth/change-email' && method === 'POST') return auth.changeEmail(req, res);
  if (path === '/api/auth/me' && method === 'GET') return auth.me(req, res);
  if (path === '/api/auth/logout' && method === 'POST') return auth.logout(req, res);

  /* ---------------- 模型 ---------------- */
  if (path === '/api/models' && method === 'GET') return chat.models(req, res);
  if (path === '/api/model/status' && method === 'GET') return chat.status(req, res);
  if (path === '/api/chat' && method === 'POST') return chat.chat(req, res);

  /* ---------------- 多端同步 ---------------- */
  if (path === '/api/sync' && method === 'GET') return sync.pull(req, res);
  if (path === '/api/sync' && (method === 'POST' || method === 'PUT')) return sync.push(req, res);
  if (path === '/api/sync/status' && method === 'GET') return sync.status(req, res);

  /* ---------------- 分享 ---------------- */
  if (path === '/api/share' && method === 'POST') return share.create(req, res);
  if (path === '/api/shares' && method === 'GET') return share.list(req, res);
  const mShare = /^\/api\/share\/([A-Za-z0-9_-]+)$/.exec(path);
  if (mShare && method === 'GET') { q.slug = mShare[1]; return share.get(req, res, q); }
  if (mShare && method === 'DELETE') { q.slug = mShare[1]; return share.stop(req, res, q); }
  const mView = /^\/s\/([A-Za-z0-9_-]+)$/.exec(path);
  if (mView && method === 'GET') { q.slug = mView[1]; return share.view(req, res, q); }
  const mArt = /^\/artifact\/([A-Za-z0-9_-]+)$/.exec(path);
  if (mArt && method === 'GET') { q.id = mArt[1]; return share.artifact(req, res, q); }

  /* ---------------- 云端工作区（IDE / 项目文件真实落盘） ---------------- */
  if (path === '/api/fs/tree' && method === 'GET') return fsapi.tree(req, res, q);
  if (path === '/api/fs/write' && method === 'POST') return fsapi.write(req, res);
  if (path === '/api/fs/mkdir' && method === 'POST') return fsapi.mkdir(req, res);
  if (path === '/api/fs/rename' && method === 'POST') return fsapi.rename(req, res);
  if (path === '/api/fs/delete' && method === 'POST') return fsapi.remove(req, res);
  if (path === '/api/fs/sync' && method === 'POST') return fsapi.sync(req, res);
  if (path === '/api/run' && method === 'POST') return fsapi.run(req, res);
  if (path === '/api/fs/status' && method === 'GET') {
    return sendJson(res, 200, { ok: true, root: fsapi.ROOT, ready: true });
  }

  /* ---------------- 工作区云同步（GitHub 持久化） ---------------- */
  if (path === '/api/ws/status' && method === 'GET') return sendJson(res, 200, gitsync.status());
  if (path === '/api/ws/pull' && method === 'POST') {
    return gitsync.pull().then((r) => sendJson(res, r.ok ? 200 : 500, r));
  }
  if (path === '/api/ws/push' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    return gitsync.push(body && body.message).then((r) => sendJson(res, r.ok ? 200 : 500, r));
  }

  /* ---------------- 浏览器面板代理 ---------------- */
  if (path === '/api/browser/proxy' && method === 'GET') return webproxy.proxy(req, res, q);

  return false;
}

/**
 * @returns {boolean} true 表示该请求已被 API 处理（调用方不再走静态托管）
 */
function handle(req, res) {
  const path = norm(url.parse(req.url, true).pathname);
  const isApi = path.indexOf('/api/') === 0 || path === '/api' || path.indexOf('/s/') === 0 || path.indexOf('/artifact/') === 0;
  if (!isApi) return false;
  applyCors(req, res);
  if (String(req.method || '').toUpperCase() === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Max-Age': '600' });
    res.end();
    return true;
  }
  route(req, res).then((handled) => {
    if (handled === false) sendJson(res, 404, { ok: false, message: '接口不存在：' + path });
  }).catch((e) => {
    const msg = (e && e.message) ? e.message : String(e);
    console.error('[api] ' + path + ' 处理失败：' + msg);
    try { sendJson(res, 500, { ok: false, message: '服务端错误：' + msg }); } catch (_) {}
  });
  return true;
}

module.exports = { handle: handle };
