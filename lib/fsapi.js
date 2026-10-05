/* AYCHO module: server/lib/fsapi | 真实云端工作区文件系统
 * IDE / 项目文件 面板的落盘后端（不再是浏览器 localStorage 假文件）。
 * 所有路径被限制在 AYCHO_WORKSPACE（默认 server/data/workspace）内，禁止 ../ 越界。
 * 路由：
 *   GET   /api/fs/tree?withContent=1   列出工作区文件（可选带内容）
 *   POST  /api/fs/write   {path,content}               写文件
 *   POST  /api/fs/mkdir   {path}                       建目录
 *   POST  /api/fs/rename  {path,to}                    重命名/移动
 *   POST  /api/fs/delete  {path}                       删除
 *   POST  /api/fs/sync    {files:[{path,kind,content}]} 全量镜像（前端项目文件 → 磁盘）
 *   POST  /api/run        {cmd,cwd?}                   在工作区执行命令并回传输出
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { sendJson, readJson } = require('./http');

const ROOT = path.resolve(process.env.AYCHO_WORKSPACE || path.join(__dirname, '..', 'data', 'workspace'));
const MAX_BYTES = 2 * 1024 * 1024;

function ensureRoot() {
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch (e) { /* ignore */ }
}

function inRoot(abs) {
  return abs === ROOT || abs.indexOf(ROOT + path.sep) === 0;
}

/* /api/run 的 cwd 解析：兼容 绝对值路径 / 相对路径 / 二次拼接路径，最终必须落在 ROOT 内且为已存在目录，否则回落 ROOT */
function resolveCwd(p) {
  const raw = String(p == null ? '' : p).replace(/\\/g, '/').trim();
  if (!raw || raw === '.' || raw === './' || raw === '/' || raw === ROOT) return ROOT;
  if (raw.indexOf('\0') >= 0) return ROOT;

  const tried = [];
  const push = (v) => { const a = path.resolve(v); if (tried.indexOf(a) < 0) tried.push(a); };

  if (raw.charAt(0) === '/') {
    push(raw);                                   // 期望：真实绝对路径，如 /app/data/workspace
    push(ROOT + raw);                            // 兼容：绝对路径被当成相对路径二次拼接
    if (raw.indexOf(ROOT + '/') === 0) push(raw.slice(ROOT.length)); // 兼容：ROOT+ROOT 叠层
  } else {
    push(path.resolve(ROOT, raw));               // 期望：相对 ROOT 的路径
    push(path.resolve(ROOT, ROOT + '/' + raw));
  }

  for (let i = 0; i < tried.length; i++) {
    const a = tried[i];
    if (!inRoot(a)) continue;
    try { if (fs.statSync(a).isDirectory()) return a; } catch (e) { /* 不存在则试下一个 */ }
  }
  return ROOT;
}

/* 把外部路径收敛到 ROOT 内；越界返回 null */
function safeAbs(p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) return null;
  if (raw.indexOf('\0') >= 0) return null;
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(ROOT, cleaned);
  if (abs !== ROOT && abs.indexOf(ROOT + path.sep) !== 0) return null;
  return abs;
}

function toRel(abs) {
  const r = path.relative(ROOT, abs).split(path.sep).join('/');
  return '/' + r;
}

function statOf(abs) {
  try { return fs.statSync(abs); } catch (e) { return null; }
}

function walk(dir, out) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  names.sort();
  for (let i = 0; i < names.length; i++) {
    const abs = path.join(dir, names[i]);
    const st = statOf(abs);
    if (!st) continue;
    if (st.isDirectory()) {
      out.push({ path: toRel(abs), kind: 'dir', size: 0, updatedAt: st.mtimeMs });
      walk(abs, out);
    } else if (st.isFile()) {
      out.push({ path: toRel(abs), kind: 'file', size: st.size, updatedAt: st.mtimeMs });
    }
  }
  return out;
}

function seedIfEmpty() {
  ensureRoot();
  const items = walk(ROOT, []);
  if (items.length) return false;
  const files = {
    '/README.md': '# AYCHO 云端工作区\n\n这是服务端真实落盘目录（server/data/workspace）。\nIDE 面板的保存 = 真写文件；项目文件面板的增删改 = 真改磁盘。\n',
    '/src/app.js': "console.log('hello from AYCHO workspace');\n",
    '/docs/notes.md': '# 笔记\n\n- 在 IDE 里改这行，Ctrl/Cmd+S 保存\n- 打开终端执行 `cat docs/notes.md` 可验证落盘\n'
  };
  Object.keys(files).forEach((rel) => {
    const abs = safeAbs(rel);
    if (!abs) return;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, files[rel], 'utf8');
    } catch (e) { /* ignore */ }
  });
  return true;
}

/* ------------------------------- 路由 ------------------------------- */
async function tree(req, res, q) {
  ensureRoot();
  seedIfEmpty();
  const withContent = String(q.withContent || '') === '1';
  const items = walk(ROOT, []);
  if (withContent) {
    items.forEach((it) => {
      if (it.kind !== 'file' || it.size > MAX_BYTES) return;
      try { it.content = fs.readFileSync(path.join(ROOT, it.path.replace(/^\//, '')), 'utf8'); } catch (e) { it.content = ''; }
    });
  }
  return sendJson(res, 200, { ok: true, root: ROOT, items: items });
}

async function write(req, res) {
  const body = await readJson(req);
  const abs = safeAbs(body.path);
  if (!abs) return sendJson(res, 400, { ok: false, message: '路径非法或越界' });
  const content = body.content == null ? '' : String(body.content);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  } catch (e) {
    return sendJson(res, 500, { ok: false, message: '写入失败: ' + e.message });
  }
  return sendJson(res, 200, { ok: true, path: toRel(abs), size: Buffer.byteLength(content, 'utf8'), updatedAt: Date.now() });
}

async function mkdir(req, res) {
  const body = await readJson(req);
  const abs = safeAbs(body.path);
  if (!abs) return sendJson(res, 400, { ok: false, message: '路径非法或越界' });
  try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { return sendJson(res, 500, { ok: false, message: '建目录失败: ' + e.message }); }
  return sendJson(res, 200, { ok: true, path: toRel(abs) });
}

async function rename(req, res) {
  const body = await readJson(req);
  const from = safeAbs(body.path);
  const to = safeAbs(body.to);
  if (!from || !to) return sendJson(res, 400, { ok: false, message: '路径非法或越界' });
  if (!statOf(from)) return sendJson(res, 404, { ok: false, message: '源不存在' });
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  } catch (e) { return sendJson(res, 500, { ok: false, message: '重命名失败: ' + e.message }); }
  return sendJson(res, 200, { ok: true, path: toRel(to) });
}

async function remove(req, res) {
  const body = await readJson(req);
  const abs = safeAbs(body.path);
  if (!abs) return sendJson(res, 400, { ok: false, message: '路径非法或越界' });
  if (abs === ROOT) return sendJson(res, 400, { ok: false, message: '不允许删除工作区根目录' });
  const st = statOf(abs);
  if (!st) return sendJson(res, 404, { ok: false, message: '不存在' });
  try { fs.rmSync(abs, { recursive: true, force: true }); } catch (e) { return sendJson(res, 500, { ok: false, message: '删除失败: ' + e.message }); }
  return sendJson(res, 200, { ok: true, path: toRel(abs) });
}

/* 前端 projectFiles 全量镜像到磁盘：先写文件，再删掉磁盘上多余的（限工作区内） */
async function sync(req, res) {
  const body = await readJson(req);
  const files = Array.isArray(body.files) ? body.files : [];
  ensureRoot();
  const wish = {};
  let written = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    const abs = safeAbs(f.path);
    if (!abs) continue;
    const rel = toRel(abs);
    if (f.kind === 'dir') {
      try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { /* ignore */ }
      wish[rel] = 'dir';
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content == null ? '' : String(f.content), 'utf8');
      wish[rel] = 'file';
      written++;
    } catch (e) { /* ignore */ }
  }
  const removed = [];
  walk(ROOT, []).forEach((it) => {
    if (wish[it.path]) return;
    const abs = safeAbs(it.path);
    if (!abs) return;
    try {
      if (fs.rmSync(abs, { recursive: true, force: true })) removed.push(it.path);
    } catch (e) { /* ignore */ }
  });
  return sendJson(res, 200, { ok: true, root: ROOT, written: written, removed: removed, total: Object.keys(wish).length });
}

/* 在工作区内执行命令（IDE 的「运行」/终端可用） */
async function run(req, res) {
  const body = await readJson(req);
  const cmd = String(body.cmd || '').trim();
  if (!cmd) return sendJson(res, 400, { ok: false, message: '缺少 cmd' });
  const cwd = resolveCwd(body.cwd);
  const started = Date.now();
  exec(cmd, { cwd: cwd, timeout: 20000, maxBuffer: 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
    const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
    return sendJson(res, 200, {
      ok: !err,
      code: code,
      cwd: cwd,
      stdout: String(stdout || ''),
      stderr: String(stderr || '') + (err && err.killed ? '\n(超时终止)' : ''),
      ms: Date.now() - started
    });
  });
}

module.exports = {
  tree: tree, write: write, mkdir: mkdir, rename: rename,
  remove: remove, sync: sync, run: run, ROOT: ROOT
};
