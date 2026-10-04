/* AYCHO module: server/lib/webproxy | 浏览器面板的真实渲染后端
 * 右侧浏览器面板若直接 iframe 外站，会被 X-Frame-Options / CSP 拒绝而白屏。
 * 这里由服务端代取页面（带真实 UA、跟随跳转、注入 <base> 修正相对资源），
 * 前端在直连失败时自动切到 /api/browser/proxy?url=，从而「真能打开网页」。
 * 安全：仅允许 http/https，禁止内网/环回/云元数据地址，限制响应体大小。
 */
'use strict';

const { sendText } = require('./http');

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AYCHO/1.0';

function blockedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || /^127\./.test(h) || /^0\./.test(h)) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/\.local$/.test(h) || /^\[?fc00|^\[?fd[0-9a-f]{2}/.test(h)) return true;
  return false;
}

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function proxy(req, res, q) {
  let target = String(q.url || '').trim();
  if (!/^https?:\/\//i.test(target)) return sendText(res, 400, '仅支持 http/https 网址', 'text/plain; charset=utf-8');
  let u;
  try { u = new URL(target); } catch (e) { return sendText(res, 400, '网址不合法', 'text/plain; charset=utf-8'); }
  if (blockedHost(u.hostname)) return sendText(res, 403, '该地址不允许代理（内网/环回地址）', 'text/plain; charset=utf-8');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(target, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
  } catch (e) {
    clearTimeout(timer);
    return sendText(res, 504, '代理抓取失败：' + (e && e.message ? e.message : String(e)), 'text/plain; charset=utf-8');
  }
  clearTimeout(timer);

  const ctype = String(resp.headers.get('content-type') || 'text/html');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_BYTES) return sendText(res, 413, '页面过大，已放弃代理', 'text/plain; charset=utf-8');

  const finalUrl = resp.url || target;
  if (/text\/html|application\/xhtml/i.test(ctype)) {
    let html = buf.toString('utf8');
    const baseTag = '<base href="' + escAttr(finalUrl) + '">';
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, '<head$1>' + baseTag);
    else html = baseTag + html;
    // 去掉会阻止内嵌的元信息（服务端已直出，XFO/CSP 头不存在，仅清理 meta 参考）
    html = html.replace(/<meta[^>]+http-equiv=["']?(x-frame-options|content-security-policy)["']?[^>]*>/gi, '');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Aycho-Proxied': '1',
      'X-Aycho-Final-Url': encodeURIComponent(finalUrl)
    });
    res.end(html);
    return;
  }

  res.writeHead(200, {
    'Content-Type': ctype,
    'Cache-Control': 'no-store',
    'X-Aycho-Proxied': '1',
    'X-Aycho-Final-Url': encodeURIComponent(finalUrl)
  });
  res.end(buf);
}

module.exports = { proxy: proxy };
