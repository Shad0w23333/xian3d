#!/usr/bin/env node
// 按模块统计绘制调用：拦截 renderer.renderBufferDirect，沿父节点找 userData.module 记账（含阴影、倒影等所有渲染遍）。
// 用法：node tools/drawcalls_by_module.mjs --list tools/tour_spots.json --only id1,id2 [--frames 3] [--out shots/dc.json]
//   输出每个机位：总调用、总三角形，以及按模块的 {calls, tris}（三角形按索引数/3 × 实例数估算；BatchedMesh 按本遍实际提交的段计）。
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
let spots = JSON.parse(fs.readFileSync(path.resolve(root, get('--list', 'tools/tour_spots.json')), 'utf8'));
const only = get('--only', '') ? new Set(get('--only', '').split(',')) : null;
if (only) spots = spots.filter((s) => only.has(s.id));
const FR = +get('--frames', 3);
const outFile = get('--out', '');

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${port}/?ui=0&labels=0&mini=0&online=0&shot=1&q=2&view=1&time=15`);
await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 300000, polling: 500 });
await page.evaluate(() => {
  const r = window.xian.renderer;
  const acc = (window.__dc = { on: false, m: {} });
  const orig = r.renderBufferDirect.bind(r);
  r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (acc.on) {
      let o = object, mod = null;
      while (o && !mod) { mod = o.userData && o.userData.module; o = o.parent; }
      mod = mod || (object.isMesh || object.isPoints || object.isLine ? '其他（地形/天空/后期）' : '其他');
      const e = (acc.m[mod] ||= { calls: 0, tris: 0 });
      e.calls++;
      const idx = geometry.index ? geometry.index.count : geometry.attributes.position ? geometry.attributes.position.count : 0;
      const cnt = group ? group.count : idx;
      const inst = object.isInstancedMesh ? object.count : geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1;
      if (object.isBatchedMesh) {
        // BatchedMesh（多重绘制）：只计本遍视锥裁剪后实际提交的各段（onBeforeRender / onBeforeShadow 已算好）
        let t = 0;
        for (let i = 0; i < object._multiDrawCount; i++) t += object._multiDrawCounts[i];
        e.tris += t / 3;
      } else e.tris += (Math.min(cnt, idx) / 3) * (inst === Infinity ? 1 : inst);
    }
    return orig(camera, scene, geometry, material, object, group);
  };
});
const out = [];
for (const s of spots) {
  await page.evaluate((s) => {
    const x = window.xian;
    if (s.view) x.goto(s.view);
    else {
      const [lon, lat, agl, tlon, tlat, tagl] = s.ll;
      const p = x.project(lon, lat), t = x.project(tlon, tlat);
      x.setView({ pos: [p.x, agl, p.z], target: [t.x, tagl, t.z], agl: true });
    }
    if (s.time != null) x.setHours(s.time);
  }, s);
  await page.waitForTimeout(2500);
  for (let i = 0; i < 60; i++) {
    const ok = await page.evaluate(() => { const b = window.xian.ctx.modules.buildings; const bs = b && b.stats ? b.stats() : {}; return window.xian.settled() && !(bs.hiLoading > 0) && !(bs.hiPending > 0); });
    if (ok) break;
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(800);
  const res = await page.evaluate(async (FR) => {
    const acc = window.__dc;
    acc.m = {}; acc.on = true;
    for (let i = 0; i < FR; i++) await new Promise((r) => requestAnimationFrame(() => r()));
    acc.on = false;
    const m = {};
    for (const [k, v] of Object.entries(acc.m)) m[k] = { calls: Math.round(v.calls / FR), tris: +(v.tris / FR / 1e6).toFixed(2) };
    const info = window.xian.renderer.info.render;
    return { m, calls: info.calls, fps: +window.xian.fps.toFixed(1) };
  }, FR);
  const rows = Object.entries(res.m).sort((p, q) => q[1].calls - p[1].calls);
  console.log(`${s.id}  总调用（最后一帧）${res.calls}  fps ${res.fps}`);
  console.log('   ' + rows.map(([k, v]) => `${k} ${v.calls}/${v.tris}M`).join('  '));
  out.push({ id: s.id, ...res });
}
if (outFile) fs.writeFileSync(path.resolve(root, outFile), JSON.stringify(out, null, 1));
await browser.close();
await server.close();
