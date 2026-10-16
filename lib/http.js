/* AYCHO module: server/lib/http | HTTP 小工具（零依赖）
 * 统一的 JSON 响应 / 请求体读取 / 鉴权头解析 / CORS。 */
'use strict';

const MAX_BODY = 32 * 1024 * 1024;   // 32MB，够分享大文件用

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendText(res, code, text, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const cap = limit || MAX_BODY;
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('请求体不是合法 JSON'); }
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : '';
}

/**
 * 同源部署时无需 CORS；当允许跨域（前端与后端不同源）时按白名单放行。
 * AYCHO_CORS=* 或逗号分隔的来源列表；默认同源（不添加头）。
 */
function applyCors(req, res) {
  const allow = String(process.env.AYCHO_CORS || '').trim();
  const origin = req.headers['origin'];
  if (!allow || !origin) return;
  const list = allow === '*' ? ['*'] : allow.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.indexOf('*') >= 0 || list.indexOf(origin) >= 0) {
    res.setHeader('Access-Control-Allow-Origin', list.indexOf('*') >= 0 ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
}

module.exports = { sendJson, sendText, readBody, readJson, bearer, applyCors, MAX_BODY };
