/* AYCHO module: server/lib/gitsync | 工作区 ↔ GitHub 仓库 持久化同步
 * 背景：Render 免费实例文件系统为临时盘（ephemeral），容器每次重建/重启后工作区清空。
 * 本模块把工作区（ROOT）与 GitHub 仓库某分支下的子目录做双向同步：
 *   - 启动时自动 pull：把云端文件恢复到本地工作区
 *   - IDE / 终端改动后 debounce 自动 push：一次 commit 覆盖全部变更
 *   - 手动：GET /api/ws/status、POST /api/ws/pull、POST /api/ws/push
 * 环境变量：
 *   AYCHO_WS_REPO    仓库 full_name，如 jimibiuev/aycho-gateway（缺省=功能关闭）
 *   AYCHO_WS_BRANCH  分支名，默认 workspace（不触发 Render 部署）
 *   AYCHO_WS_PREFIX  仓库内子目录，默认 workspace
 *   AYCHO_WS_TOKEN   GitHub PAT（contents: read & write），缺省回退 AYCHO_GHA_TOKEN / GITHUB_TOKEN
 *   AYCHO_WS_AUTO    1=改动后自动推送（默认），0=仅手动
 *   AYCHO_WS_PRUNE   1=推送时删除云端多余文件以保持镜像（默认），0=只增不删
 *   AYCHO_WS_MAX     单文件上限字节，默认 943718（0.9MB，GitHub 单文件安全区）
 *   AYCHO_WS_DEBOUNCE 自动推送防抖毫秒，默认 6000
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(process.env.AYCHO_WORKSPACE || path.join(__dirname, '..', 'data', 'workspace'));
const STATE_FILE = path.join(path.dirname(ROOT), '.gitsync-state.json');
const SKIP_NAMES = ['.git', '.svn', 'node_modules', '.cache', '__pycache__', '.venv', 'venv', '.DS_Store'];

function cfg() {
  const max = parseInt(process.env.AYCHO_WS_MAX || '943718', 10);
  return {
    repo: String(process.env.AYCHO_WS_REPO || '').trim(),
    branch: String(process.env.AYCHO_WS_BRANCH || 'workspace').trim() || 'workspace',
    prefix: String(process.env.AYCHO_WS_PREFIX == null ? 'workspace' : process.env.AYCHO_WS_PREFIX).replace(/^\/+|\/+$/g, ''),
    token: String(process.env.AYCHO_WS_TOKEN || process.env.AYCHO_GHA_TOKEN || process.env.GITHUB_TOKEN || '').trim(),
    auto: String(process.env.AYCHO_WS_AUTO == null ? '1' : process.env.AYCHO_WS_AUTO) !== '0',
    prune: String(process.env.AYCHO_WS_PRUNE == null ? '1' : process.env.AYCHO_WS_PRUNE) !== '0',
    max: isNaN(max) ? 943718 : max,
    debounce: Math.max(1000, parseInt(process.env.AYCHO_WS_DEBOUNCE || '6000', 10) || 6000)
  };
}

function enabled() {
  const c = cfg();
  return !!(c.repo && c.token && c.repo.indexOf('/') > 0);
}

/* ------------------------------------------------------------------ 状态文件 */
let state = { files: {}, lastPull: '', lastPush: '', lastError: '' };

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || state;
  } catch (e) { /* 忽略损坏状态 */ }
  if (!state.files) state.files = {};
  return state;
}

function writeState() {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch (e) {}
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch (e) {}
}

/* ------------------------------------------------------------------ GitHub API */
function request(method, apiPath, body) {
  const c = cfg();
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      'User-Agent': 'aycho-gitsync',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + c.token
    };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method: method, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = txt ? JSON.parse(txt) : null; } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: txt });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('GitHub API 超时')));
    if (data) req.write(data);
    req.end();
  });
}

function apiErr(prefix, r) {
  const msg = (r && r.json && r.json.message) || (r && r.text) || '';
  return new Error(prefix + ' (HTTP ' + (r && r.status) + ') ' + String(msg).slice(0, 200));
}

/* 远端文件清单：relPath → { sha, size } */
async function listRemote() {
  const c = cfg();
  const r = await request('GET', '/repos/' + c.repo + '/git/trees/' + encodeURIComponent(c.branch) + '?recursive=1');
  if (r.status === 404) return new Map();          // 分支还不存在
  if (r.status !== 200) throw apiErr('读取云端文件清单失败', r);
  const map = new Map();
  ((r.json && r.json.tree) || []).forEach((it) => {
    if (it.type !== 'blob') return;
    if (c.prefix) {
      if (it.path.indexOf(c.prefix + '/') !== 0) return;
      map.set(it.path.slice(c.prefix.length + 1), { sha: it.sha, size: it.size });
    } else {
      map.set(it.path, { sha: it.sha, size: it.size });
    }
  });
  return map;
}

function inRoot(abs) {
  return abs === ROOT || abs.indexOf(ROOT + path.sep) === 0;
}

/* git blob 对象的 sha1（与 GitHub 返回的 blob sha 同算法，可用于差异比对） */
function blobSha(buf) {
  return crypto.createHash('sha1').update('blob ' + buf.length + '\0', 'binary').update(buf).digest('hex');
}

/* 收集本地工作区文件：{ files: {rel: Buffer}, skipped: [rel] } */
function collectLocal() {
  const out = { files: {}, skipped: [] };
  const c = cfg();
  (function walk(dir, base) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (let i = 0; i < ents.length; i++) {
      const ent = ents[i];
      if (SKIP_NAMES.indexOf(ent.name) >= 0) continue;
      const abs = path.join(dir, ent.name);
      const rel = base ? base + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { walk(abs, rel); continue; }
      if (!ent.isFile()) continue;
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (st.size > c.max) { out.skipped.push(rel); continue; }
      try { out.files[rel] = fs.readFileSync(abs); } catch (e) { /* 读失败跳过 */ }
    }
  })(ROOT, '');
  return out;
}

/* ------------------------------------------------------------------ pull */
async function pull() {
  if (!enabled()) return { ok: false, message: '未配置 AYCHO_WS_REPO / AYCHO_WS_TOKEN，云同步未启用' };
  const c = cfg();
  readState();
  let remote;
  try { remote = await listRemote(); }
  catch (e) { state.lastError = 'pull: ' + e.message; writeState(); return { ok: false, message: e.message }; }

  const writtenList = [];
  for (const pair of remote) {
    const rel = pair[0], info = pair[1];
    const abs = path.join(ROOT, rel);
    if (!inRoot(abs)) continue;
    if (state.files[rel] === info.sha && fs.existsSync(abs)) continue;
    const b = await request('GET', '/repos/' + c.repo + '/git/blobs/' + info.sha);
    if (b.status !== 200 || !b.json || !b.json.content) continue;
    const buf = Buffer.from(String(b.json.content).replace(/\n/g, ''), 'base64');
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      state.files[rel] = info.sha;
      writtenList.push(rel);
    } catch (e) { /* 单个文件失败不影响整体 */ }
  }
  state.lastPull = new Date().toISOString();
  state.lastError = '';
  writeState();
  return { ok: true, pulled: writtenList.length, upToDate: remote.size - writtenList.length, remoteTotal: remote.size, files: writtenList.slice(0, 50), at: state.lastPull };
}

/* ------------------------------------------------------------------ push */
async function push(message) {
  if (!enabled()) return { ok: false, message: '未配置 AYCHO_WS_REPO / AYCHO_WS_TOKEN，云同步未启用' };
  const c = cfg();
  const local = collectLocal();
  const rels = Object.keys(local.files);

  let remote = new Map();
  try { remote = await listRemote(); } catch (e) { /* 首次推送可能无分支 */ }

  if (rels.length === 0) return { ok: false, message: '本地工作区为空，已拒绝推送（防止清空云端）', remoteTotal: remote.size };

  /* 当前分支 head */
  let head = null, baseTree = null;
  const ref = await request('GET', '/repos/' + c.repo + '/git/ref/heads/' + encodeURIComponent(c.branch));
  if (ref.status === 200 && ref.json && ref.json.object) {
    head = ref.json.object.sha;
    const cm = await request('GET', '/repos/' + c.repo + '/git/commits/' + head);
    if (cm.status === 200 && cm.json && cm.json.tree) baseTree = cm.json.tree.sha;
  } else if (ref.status !== 404) {
    throw apiErr('读取分支失败', ref);
  }

  /* 上传 blob（内容未变化则跳过，避免无意义提交） */
  const tree = [];
  let changed = 0;
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i];
    const data = local.files[rel];
    const sha = blobSha(data);
    state.files[rel] = sha;
    const rinfo = remote.get(rel);
    if (rinfo && rinfo.sha === sha) continue;
    const blob = await request('POST', '/repos/' + c.repo + '/git/blobs', {
      content: data.toString('base64'), encoding: 'base64'
    });
    if (blob.status !== 201 || !blob.json || !blob.json.sha) throw apiErr('上传文件失败 ' + rel, blob);
    tree.push({ path: (c.prefix ? c.prefix + '/' : '') + rel, mode: '100644', type: 'blob', sha: blob.json.sha });
    changed++;
  }

  /* 删除云端多余文件（镜像模式）
   * 安全阀：本进程从未成功 pull 过、且云端文件比本地多时，禁止删除云端文件，
   * 避免「容器重建 + pull 失败 → 空/残缺本地工作区把云端备份清空」。 */
  const removed = [];
  const canPrune = c.prune && (!!state.lastPull || remote.size === 0);
  if (canPrune) {
    for (const pair of remote) {
      const rel = pair[0];
      if (local.files[rel]) continue;
      tree.push({ path: (c.prefix ? c.prefix + '/' : '') + rel, mode: '100644', type: 'blob', sha: null });
      delete state.files[rel];
      removed.push(rel);
    }
  } else if (remote.size > rels.length) {
    console.warn('[gitsync] 已跳过云端删除（本进程尚未成功拉取，云端 ' + remote.size + ' 个 > 本地 ' + rels.length + ' 个），如需对齐请先 pull');
  }

  if (tree.length === 0) {
    writeState();
    return { ok: true, changed: 0, removed: 0, message: '工作区与云端一致，无需同步', at: new Date().toISOString() };
  }

  const t = await request('POST', '/repos/' + c.repo + '/git/trees', baseTree ? { base_tree: baseTree, tree: tree } : { tree: tree });
  if (t.status !== 201 || !t.json || !t.json.sha) throw apiErr('创建树失败', t);

  const commit = await request('POST', '/repos/' + c.repo + '/git/commits', {
    message: message || ('chore(workspace): 同步 ' + rels.length + ' 个文件' + (removed.length ? '，删除 ' + removed.length + ' 个' : '') + ' @ ' + new Date().toISOString()),
    tree: t.json.sha,
    parents: head ? [head] : []
  });
  if (commit.status !== 201 || !commit.json || !commit.json.sha) throw apiErr('创建提交失败', commit);

  if (head) {
    const up = await request('PATCH', '/repos/' + c.repo + '/git/refs/heads/' + encodeURIComponent(c.branch), { sha: commit.json.sha, force: false });
    if (up.status !== 200) throw apiErr('更新分支失败', up);
  } else {
    const cr = await request('POST', '/repos/' + c.repo + '/git/refs', { ref: 'refs/heads/' + c.branch, sha: commit.json.sha });
    if (cr.status !== 201) throw apiErr('创建分支失败', cr);
  }

  state.lastPush = new Date().toISOString();
  state.lastError = '';
  writeState();
  return {
    ok: true, pushed: changed, totalFiles: rels.length, removed: removed.length, skipped: local.skipped.length,
    branch: c.branch, commit: commit.json.sha.slice(0, 12), commitUrl: commit.json.html_url || '',
    at: state.lastPush
  };
}

/* ------------------------------------------------------------------ 自动推送（防抖 + 互斥） */
let timer = null;
let running = false;
let queued = false;
let pendingMsg = '';

function schedulePush(message) {
  if (!enabled() || !cfg().auto) return;
  pendingMsg = message || pendingMsg || '';
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; autoPush(); }, cfg().debounce);
}

async function autoPush() {
  if (running) { queued = true; return; }
  running = true;
  const msg = pendingMsg; pendingMsg = '';
  try { await push(msg); }
  catch (e) { state.lastError = 'push: ' + e.message; writeState(); }
  finally {
    running = false;
    if (queued) { queued = false; schedulePush(''); }
  }
}

/* 启动时自动拉取（不阻塞服务启动） */
function bootPull() {
  if (!enabled()) {
    console.log('[gitsync] 未配置 AYCHO_WS_REPO / AYCHO_WS_TOKEN，云同步关闭（工作区仍为临时盘）');
    return;
  }
  const c = cfg();
  console.log('[gitsync] 已启用：' + c.repo + '@' + c.branch + (c.prefix ? '/' + c.prefix : '') + '，启动拉取中…');
  setTimeout(() => {
    pull().then((r) => {
      console.log('[gitsync] 启动拉取' + (r.ok ? '完成：恢复 ' + r.pulled + ' 个文件（云端共 ' + r.remoteTotal + ' 个）' : '失败：' + r.message));
    }).catch((e) => console.log('[gitsync] 启动拉取异常：' + e.message));
  }, 1200);
}

function status() {
  const c = cfg();
  const local = enabled() ? collectLocal() : { files: {}, skipped: [] };
  return {
    ok: true,
    enabled: enabled(),
    repo: c.repo, branch: c.branch, prefix: c.prefix,
    auto: c.auto, prune: c.prune, maxFile: c.max,
    localFiles: Object.keys(local.files).length,
    skippedLarge: local.skipped.length,
    lastPull: state.lastPull || '', lastPush: state.lastPush || '', lastError: state.lastError || '',
    root: ROOT
  };
}

module.exports = {
  pull: pull, push: push, status: status,
  schedulePush: schedulePush, bootPull: bootPull,
  enabled: enabled, ROOT: ROOT, stateFile: STATE_FILE
};
