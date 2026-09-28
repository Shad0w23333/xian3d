#!/usr/bin/env node
// 诊断：加载场景后遍历全部网格，统计含 NaN/Inf 坐标、零长度或 NaN 法线的几何体（Metal 上 normalize(0) = NaN，会经泛光扩散成全屏黑）
// 用法：node tools/diag_nan.mjs "online=0&view=5&time=20.8"
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const query = process.argv[2] || 'online=0&view=5&time=20.8';
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const exe = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({
  ...(exe && process.platform !== 'darwin' ? { executablePath: exe } : {}),
  args: process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://127.0.0.1:${port}/?${query}&ui=0&shot=1`);
await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 600000, polling: 500 });
const res = await page.evaluate(() => {
  window.xian.paused = true;
  const out = [];
  const scene = window.xian.ctx.scene;
  const owner = (o) => { while (o && !o.userData.module && o.parent) o = o.parent; return o?.userData.module || '?'; };
  scene.traverse((o) => {
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    const P = g.attributes.position, N = g.attributes.normal;
    let badP = 0, zeroN = 0, nanN = 0;
    const pa = P.array, stride = P.isInterleavedBufferAttribute ? P.data.stride : P.itemSize, off = P.offset || 0;
    for (let i = 0; i < P.count; i++) {
      const k = i * stride + off;
      if (!Number.isFinite(pa[k]) || !Number.isFinite(pa[k + 1]) || !Number.isFinite(pa[k + 2])) badP++;
    }
    if (N && !N.normalized) {
      const na = N.array, ns = N.isInterleavedBufferAttribute ? N.data.stride : N.itemSize, no = N.offset || 0;
      for (let i = 0; i < N.count; i++) {
        const k = i * ns + no;
        const x = na[k], y = na[k + 1], z = na[k + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nanN++;
        else if (x * x + y * y + z * z < 1e-12) zeroN++;
      }
    }
    let badInst = 0;
    if (o.isInstancedMesh) {
      const m = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        let bad = false, sx = 0;
        for (let j = 0; j < 16; j++) if (!Number.isFinite(m[i * 16 + j])) bad = true;
        sx = m[i * 16] ** 2 + m[i * 16 + 1] ** 2 + m[i * 16 + 2] ** 2;
        if (bad || sx < 1e-12) badInst++;
      }
    }
    if (badP || zeroN || nanN || badInst)
      out.push({ module: owner(o), name: o.name, mat: [].concat(o.material).map((m) => m.type + ':' + (m.name || '')).join(','), verts: P.count, badP, zeroN, nanN, badInst, inst: !!o.isInstancedMesh, visible: o.visible });
  });
  return out;
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
await server.close();
