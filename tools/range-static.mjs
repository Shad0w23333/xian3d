// 带 HTTP Range 的静态文件处理（离线影像包 .xtp 用）：vite 开发/预览服务器与 tools/serve.mjs 共用
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.xtp': 'application/octet-stream', '.woff2': 'font/woff2',
};

/** 发送 dir 下的文件 rel；不存在返回 false */
export function sendFile(req, res, dir, rel) {
  const f = path.join(dir, path.normalize('/' + rel));
  if (!f.startsWith(dir)) return false;
  let st;
  try { st = fs.statSync(f); } catch { return false; }
  if (!st.isFile()) return false;
  const type = TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  // "bytes=-"（首尾都空）不是合法区间：忽略 Range，按整文件返回
  if (m && (m[1] !== '' || m[2] !== '')) {
    // 后缀区间 bytes=-N：N 超过文件长度时返回整个文件（RFC 9110 §14.1.2），不能让 start 变负
    const start = m[1] === '' ? Math.max(0, st.size - +m[2]) : +m[1];
    const end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(+m[2], st.size - 1);
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      return true;
    }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    stream(req, res, f, { start, end });
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    stream(req, res, f);
  }
  return true;
}

function stream(req, res, f, opts) {
  if (req.method === 'HEAD') return void res.end();
  // pipeline：打开/读取失败（文件被替换或删除、Windows 上 EBUSY/EPERM、移动硬盘拔出）或客户端中途断开时
  // 都会关闭文件并销毁响应，而不是抛出未处理的 'error' 事件把服务器进程带崩
  pipeline(fs.createReadStream(f, opts), res, () => {});
}

/** Vite 插件：把仓库根目录 tiles/（离线影像包，不进 dist）挂到 /tiles/ */
export function tilesPlugin(root) {
  const dir = path.resolve(root, 'tiles');
  const mw = (req, res, next) => {
    let rel;
    try {
      const u = new URL(req.url, 'http://x');
      const i = u.pathname.indexOf('/tiles/');
      if (i >= 0) rel = decodeURIComponent(u.pathname.slice(i + 7));
    } catch { /* 畸形 URL / 百分号编码：交给后续中间件处理 */ }
    if (rel === undefined || !sendFile(req, res, dir, rel)) return next();
  };
  return {
    name: 'xian3d-tiles',
    configureServer(server) { server.middlewares.use(mw); },
    configurePreviewServer(server) { server.middlewares.use(mw); },
  };
}
