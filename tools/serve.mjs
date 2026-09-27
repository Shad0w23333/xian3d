#!/usr/bin/env node
// 零依赖静态服务器（支持 HTTP Range）：dist/ + 仓库根目录 tiles/（离线影像包）挂到 /tiles/。
// 用法：node tools/serve.mjs [目录=dist] [端口=4173] [监听地址=127.0.0.1，局域网访问用 0.0.0.0]
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFile } from './range-static.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || path.join(root, 'dist'));
const tiles = path.join(root, 'tiles');
const port = +(process.argv[3] || 4173);
// 默认只监听本机（影像包仅供个人本地使用）；需要局域网访问时显式传 0.0.0.0
const host = process.argv[4] || '127.0.0.1';
http.createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    // 畸形百分号编码（如 /%E0%A4%A）会让 decodeURIComponent 抛 URIError：回 400，不能让进程崩掉
    res.writeHead(400).end('bad request');
    return;
  }
  if (p.startsWith('/tiles/') && sendFile(req, res, tiles, p.slice(7))) return;
  if (p.endsWith('/')) p += 'index.html';
  if (!sendFile(req, res, dir, p)) res.writeHead(404).end('not found');
}).listen(port, host, () => console.log(`服务已启动：http://localhost:${port}/ （目录 ${dir}，离线影像 ${tiles}，支持 Range；监听 ${host}）`));
