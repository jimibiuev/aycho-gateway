#!/usr/bin/env node
/* AYCHO module: terminal-server | owner: B | contract: v1
 * 真实终端后端：HTTP 静态服务 + WebSocket(/pty) + node-pty 伪终端。
 * 协议（与 js/rb-terminal.js 对应）：
 *   client → server : {type:'init', cols, rows, cwd} / {type:'input', data} / {type:'resize', cols, rows} / {type:'ping'}
 *   server → client : {type:'ready', cwd, shell} / {type:'data', data} / {type:'exit', code} / {type:'pong'} / {type:'error', message}
 * 用法：node server/terminal-server.js [--port 8787] [--host 127.0.0.1] [--cwd /path] [--static ../] [--shell /bin/bash]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

/* 载入 server/.env（零依赖解析；已存在的环境变量优先，不被覆盖） */
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    const txt = fs.readFileSync(p, 'utf8');
    txt.split(/\r?\n/).forEach((line) => {
      if (!line || /^\s*#/.test(line)) return;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) return;
      let v = m[2];
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    });
  } catch (e) { /* .env 缺失或不可读时静默跳过 */ }
})();

const api = require('./lib/api');   // 统一后端网关（登录/对话/分享），与静态托管同源

function arg(name, dft) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dft;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}

const PORT = parseInt(arg('port', process.env.PTY_PORT || '8787'), 10);
const HOST = String(arg('host', process.env.PTY_HOST || '127.0.0.1'));
let CWD = path.resolve(String(arg('cwd', process.env.PTY_CWD || path.join(__dirname, '..'))));
const STATIC_DIR = path.resolve(String(arg('static', process.env.PTY_STATIC || path.join(__dirname, '..'))));
const SHELL = String(arg('shell', process.env.PTY_SHELL || process.env.SHELL || '/bin/bash'));
const RING_LIMIT = parseInt(arg('ring', '262144'), 10);      // 环形缓冲字节数
const ORPHAN_MS = parseInt(arg('orphan', String(30 * 1000)), 10);   // 断线会话保留窗口（毫秒）
const REUSE_ORPHAN = arg('no-reuse', false) !== true;        // 重连是否复用孤儿会话
const IDLE_MS = parseInt(arg('idle', '0'), 10);              // >0 时无连接则退出

let pty = null;
let ptyErr = '';
try { pty = require('node-pty'); } catch (e) { ptyErr = e && e.message ? e.message : String(e); }
let WebSocketServer = null;
try { WebSocketServer = require('ws').WebSocketServer; } catch (e) { /* 兼容旧版 ws */ }
try { if (!WebSocketServer) WebSocketServer = require('ws').Server; } catch (e) {}

/* ------------------------------------------------------------------ 静态服务 */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8'
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function serveStatic(req, res) {
  let p = decodeURIComponent(url.parse(req.url).pathname || '/');
  if (p === '/' || p === '') p = '/index.html';
  else if (p.charAt(p.length - 1) === '/') p += 'index.html';   // 子目录直达：/login/ → /login/index.html
  const target = path.join(STATIC_DIR, p);
  // 防目录穿越
  if (!target.startsWith(STATIC_DIR)) { send(res, 403, 'Forbidden'); return; }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 降级：无扩展名请求回落到 index.html
      if (!path.extname(target)) {
        const idx = path.join(STATIC_DIR, 'index.html');
        fs.readFile(idx, (e2, buf) => {
          if (e2) send(res, 404, 'Not Found（未找到 index.html）');
          else send(res, 200, buf, MIME['.html']);
        });
        return;
      }
      send(res, 404, 'Not Found: ' + p);
      return;
    }
    fs.readFile(target, (e2, buf) => {
      if (e2) { send(res, 500, 'Read Error'); return; }
      send(res, 200, buf, MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
    });
  });
}

const server = http.createServer((req, res) => {
  /* CORS：允许静态托管站点（GitHub Pages / 自建前端）跨域调用本网关 */
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/health' || req.url === '/healthz') {
    send(res, 200, JSON.stringify({
      ok: true, pty: !!pty, ptyError: ptyErr || null, shell: SHELL, cwd: CWD, clients: rooms.size
    }), 'application/json; charset=utf-8');
    return;
  }
  if (api.handle(req, res)) return;
  serveStatic(req, res);
});

/* ------------------------------------------------------------------ 终端会话 */
const rooms = new Map();   // id → session
let nextId = 1;

function createRing(limit) {
  const chunks = [];
  let size = 0;
  return {
    push(buf) {
      chunks.push(buf);
      size += buf.length;
      while (size > limit && chunks.length) { size -= chunks.shift().length; }
    },
    text() { return Buffer.concat(chunks).toString('utf8'); },
    clear() { chunks.length = 0; size = 0; }
  };
}

function makeSession(opts) {
  const id = 's' + (nextId++);
  const session = {
    id: id,
    cols: Math.max(20, Math.min(400, parseInt(opts.cols, 10) || 80)),
    rows: Math.max(5, Math.min(200, parseInt(opts.rows, 10) || 24)),
    cwd: opts.cwd ? path.resolve(String(opts.cwd)) : CWD,
    ring: createRing(RING_LIMIT),
    sockets: new Set(),
    proc: null,
    backend: 'pty',
    orphanTimer: null,     // 最后一条连接断开后的延迟回收计时器
    orphanSince: 0         // 进入「孤儿」状态的时间戳（用于重连复用）
  };
  if (pty) {
    try {
      /* Termux 式两行提示符：┌─[root]─[~/path] / └─$ ，~ 随 cwd 实时变化。
       * 以容器工作区为「家目录」，使 \w 将工作区根显示为 ~（与 Termux 体验一致）。 */
      const isBash = /(^|\/)(bash|sh|zsh)$/.test(SHELL);
      const env = Object.assign({}, process.env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
      let shellArgs = ['-l'];
      if (isBash) {
        shellArgs = ['--noprofile', '--norc', '-i'];
        env.PS1 = '┌─[root]─[\\w]\n└─\\$ ';
        env.HOME = session.cwd;
        delete env.PWD;
        delete env.OLDPWD;
      }
      session.proc = pty.spawn(SHELL, shellArgs, {
        name: 'xterm-256color', cols: session.cols, rows: session.rows,
        cwd: session.cwd, env: env
      });
      session.proc.onData((data) => session.ring.push(Buffer.from(data, 'utf8')) || broadcast(session, { type: 'data', data: data }));
      session.proc.onExit(({ exitCode }) => {
        broadcast(session, { type: 'exit', code: exitCode == null ? 0 : exitCode });
        session.proc = null;
      });
    } catch (e) {
      session.backend = 'none';
      session.error = '启动伪终端失败: ' + (e && e.message ? e.message : String(e));
      console.error('[pty] ' + session.error);
    }
  } else {
    session.backend = 'none';
    session.error = '缺少 node-pty：请在 server 目录执行 npm install（' + (ptyErr || 'module not found') + '）';
  }
  return session;
}

function broadcast(session, msg) {
  const raw = JSON.stringify(msg);
  for (const ws of session.sockets) {
    if (ws.readyState === 1) { try { ws.send(raw); } catch (_) {} }
  }
}

function attach(session, ws) {
  if (session.orphanTimer) { clearTimeout(session.orphanTimer); session.orphanTimer = null; session.orphanSince = 0; }
  session.sockets.add(ws);
  ws.aycho = { sessionId: session.id, alive: true };
  if (session.backend === 'none') {
    try { ws.send(JSON.stringify({ type: 'error', message: session.error })); } catch (_) {}
  }
  const buf = session.ring.text();
  if (buf) { try { ws.send(JSON.stringify({ type: 'data', data: buf })); } catch (_) {} }
  try {
    ws.send(JSON.stringify({ type: 'ready', cwd: session.cwd, shell: SHELL, backend: session.backend, buffered: buf.length }));
  } catch (_) {}
}

function handleMessage(session, ws, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'init': {
      if (msg.cols && msg.rows && session.proc) { try { session.proc.resize(session.cols = msg.cols, session.rows = msg.rows); } catch (_) {} }
      if (msg.cwd) {
        const t = path.resolve(String(msg.cwd));
        if (fs.existsSync(t)) session.cwd = t;
      }
      try { ws.send(JSON.stringify({ type: 'ready', cwd: session.cwd, shell: SHELL, backend: session.backend })); } catch (_) {}
      break;
    }
    case 'input':
      if (session.proc && typeof msg.data === 'string') session.proc.write(msg.data);
      break;
    case 'resize':
      if (session.proc) {
        session.cols = Math.max(20, Math.min(400, parseInt(msg.cols, 10) || session.cols));
        session.rows = Math.max(5, Math.min(200, parseInt(msg.rows, 10) || session.rows));
        try { session.proc.resize(session.cols, session.rows); } catch (_) {}
      }
      break;
    case 'clear':
      session.ring.clear();
      break;
    case 'ping':
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
      break;
    default: break;
  }
}

/* ------------------------------------------------------------------ WebSocket */
let wss = null;
if (WebSocketServer) {
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const pathname = url.parse(req.url).pathname || '/';
    if (pathname !== '/pty' && pathname !== '/') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const q = url.parse(req.url, true).query || {};
    // 优先复用 30s 内断线的「孤儿会话」，实现刷新页面后终端历史与进程延续
    let session = null;
    if (REUSE_ORPHAN) {
      for (const s of rooms.values()) {
        if (s.sockets.size === 0 && s.orphanTimer && s.proc) { session = s; break; }
      }
    }
    const reused = !!session;
    if (!session) {
      session = makeSession({ cols: q.cols, rows: q.rows, cwd: q.cwd || CWD });
      rooms.set(session.id, session);
    }
    ws.on('message', (raw) => {
      let msg = null;
      const s = raw.toString('utf8');
      try { msg = JSON.parse(s); } catch (_) { msg = { type: 'input', data: s }; }
      handleMessage(session, ws, msg);
    });
    ws.on('close', () => {
      session.sockets.delete(ws);
      if (session.sockets.size === 0) {
        if (session.orphanTimer) clearTimeout(session.orphanTimer);
        session.orphanSince = Date.now();
        session.orphanTimer = setTimeout(() => {
          session.orphanTimer = null;
          if (session.sockets.size > 0) return;
          if (session.proc) { try { session.proc.kill(); } catch (_) {} }
          rooms.delete(session.id);
          console.log('[ws] 会话 ' + session.id + ' 空闲超时，已回收');
        }, ORPHAN_MS);   // 断线保留窗口，期间重连可复用缓冲与进程
      }
    });
    ws.on('error', () => { session.sockets.delete(ws); });
    attach(session, ws);
    console.log('[ws] 新连接 → ' + (reused ? '复用会话 ' : '新建会话 ') + session.id + '（' + session.backend + '，cwd=' + session.cwd + '）');
  });
}

/* ------------------------------------------------------------------ 运行时自举：IDE Java 编译器
 * 镜像未内置 JDK 时（如平台未重建镜像），启动后后台静默安装，保证 /api/run 的 javac/java 真实可用。
 * 幂等：已具备 javac、非 root、非 Debian 系时直接跳过，不影响启动速度。 */
function ensureJavaRuntime() {
  let exec, spawn;
  try {
    const cp = require('child_process');
    exec = cp.exec; spawn = cp.spawn;
  } catch (_) { return; }
  try {
    exec('command -v javac', (err, stdout) => {
      if (!err && String(stdout || '').trim()) return;
      if (typeof process.getuid === 'function' && process.getuid() !== 0) return;
      if (!fs.existsSync('/usr/bin/apt-get')) return;
      let log = null;
      try { log = fs.openSync('/tmp/aycho-jdk-bootstrap.log', 'a'); } catch (_) { return; }
      const child = spawn('/bin/bash', ['-lc',
        'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openjdk-17-jdk-headless'
      ], { detached: true, stdio: ['ignore', log, log] });
      child.unref();
      console.log('  运行时就绪 : 后台安装 JDK17（javac/java 约 1~3 分钟后可用）');
    });
  } catch (e) { /* 缺失时静默，IDE 仍可运行 node/python/C/C++ */ }
}
ensureJavaRuntime();

/* ------------------------------------------------------------------ 启动 */
function startServer() {
server.listen(PORT, HOST, () => {
  const modelReady = !!(process.env.AYCHO_MODEL_BASE_URL && process.env.AYCHO_MODEL_API_KEY);
  const mailReady = require('./lib/mailer').configured();
  console.log('AYCHO 服务已启动（前端静态托管 + 统一后端网关 + 真实终端）');
  console.log('  访问地址 : http://' + HOST + ':' + PORT + '/');
  console.log('  静态目录 : ' + STATIC_DIR);
  console.log('  API 网关 : /api/health · /api/auth/* · /api/chat · /api/share · /s/<slug>');
  console.log('  PTY 地址 : ws://' + HOST + ':' + PORT + '/pty');
  console.log('  工作目录 : ' + CWD);
  console.log('  Shell    : ' + SHELL + '  (node-pty: ' + (pty ? 'ok' : '缺失 → ' + ptyErr) + ')');
  console.log('  模型服务 : ' + (modelReady ? '已配置 ' + process.env.AYCHO_MODEL_BASE_URL + ' / ' + (process.env.AYCHO_MODEL_NAME || '') : '未配置 → /api/chat 会提示缺少 Key'));
  console.log('  邮件服务 : ' + (mailReady ? '已配置 SMTP（验证码真实发送）' : '未配置 SMTP → 验证码输出到本控制台'));
  if (!WebSocketServer) console.error('  警告：缺少 ws 模块，请执行 npm install');
  /* 工作区云同步：容器重建后自动从 GitHub 恢复文件（未配置则自动跳过） */
  try {
    const gs = require('./lib/gitsync');
    const st = gs.status();
    console.log('  云同步   : ' + (st.enabled ? st.repo + '@' + st.branch + (st.prefix ? '/' + st.prefix : '') + '（自动 pull + 改动自动 push）' : '未启用（未配置 AYCHO_WS_REPO / AYCHO_WS_TOKEN）'));
    gs.bootPull();
  } catch (e) { console.error('  云同步初始化失败：' + (e && e.message)); }
});
}

/* 账号库云同步改为后台异步：先开 HTTP 端口（保 Railway 健康检查通过），
     账号同步在后台跑，不阻塞服务启动（修复 Railway "已崩溃 N 秒" 的根因——
     之前 datasync 等待 GitHub 拉取超时，把 startServer 拖到 25s 后才开端口，被健康检查判崩） */
startServer();
(function bootDataSyncBg() {
  /* 延迟 1s 再同步，让服务先就绪；任何异常都不影响服务 */
  setTimeout(function() {
    let ds = null;
    try { ds = require('./lib/datasync'); } catch (e) { console.error('  账号同步模块加载失败：' + (e && e.message)); return; }
    ds.bootInit().then(function(r) {
      console.log('  账号同步 : ' + (r && r.ok
        ? (r.empty ? '云端为空，已上传当前账号库' : '已从云端恢复账号 ' + (r.users || 0) + ' 个')
        : '未启用/失败（' + ((r && r.message) || '') + '）'));
    }).catch(function(e) { console.error('  账号同步异常：' + (e && e.message)); });
  }, 1000);
})();

if (IDLE_MS > 0) {
  setInterval(() => { if (rooms.size === 0) { console.log('无活动会话，退出。'); process.exit(0); } }, IDLE_MS);
}

process.on('SIGINT', () => {
  for (const s of rooms.values()) if (s.proc) { try { s.proc.kill(); } catch (_) {} }
  process.exit(0);
});
