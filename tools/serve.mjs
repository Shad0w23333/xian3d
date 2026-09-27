#!/usr/bin/env node
// 零依赖静态服务器（支持 HTTP Range）：dist/ + 仓库根目录 tiles/（离线影像包）挂到 /tiles/。
// 用法：node tools/serve.mjs [目录=dist] [端口=4173]
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFile } from './range-static.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || path.join(root, 'dist'));
const tiles = path.join(root, 'tiles');
const port = +(process.argv[3] || 4173);
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/tiles/') && sendFile(req, res, tiles, p.slice(7))) return;
  if (p.endsWith('/')) p += 'index.html';
  if (!sendFile(req, res, dir, p)) res.writeHead(404).end('not found');
}).listen(port, () => console.log(`服务已启动：http://localhost:${port}/ （目录 ${dir}，离线影像 ${tiles}，支持 Range）`));
