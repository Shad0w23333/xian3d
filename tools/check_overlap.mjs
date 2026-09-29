#!/usr/bin/env node
// 全城建筑穿模/重叠诊断：启动 Vite + 无头 Chromium（与 tools/shot.mjs 相同的方式），场景 ready 后从 window.xian 取出
// “最终会被渲染”的建筑：通用建筑（buildings.bin，扣掉 skip）、skyline（手工精建 / landmarks2026 批量 / skyline.json 通用高层 / 特殊地标）、
// 回民街逐户轮廓、逐栋档案建筑（dossier 各体块）、下沉广场坑口，以及各片区模块注册的排除区（带注册模块名），
// 并在页面里按渲染规则取底高、沿轮廓采样地形高程。
// 然后交给 tools/check_overlap.py（shapely）统计：
//   a) 两栋渲染建筑轮廓相交（按来源对分类）   b) 建筑压在道路面上（按路宽缓冲）
//   c) 同一栋楼被两套来源重复生成             d) 底部悬空/埋地（底高与地形差 > 2 m）
// 用法：
//   node tools/check_overlap.mjs [--wait 900] [--out /tmp/overlap] [--dump 已有dump.json（跳过浏览器，只做分析）] [--top 20]
// 输出：<out>/dump.json（页面导出的原始数据）、<out>/report.json（统计 + 各类前 N 个样本）；控制台打印摘要
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { wait: 900, out: path.join(root, 'shots', 'overlap'), dump: null, top: 20, query: '' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--wait') opt.wait = +args[++i];
  else if (a === '--out') opt.out = path.resolve(args[++i]);
  else if (a === '--dump') opt.dump = path.resolve(args[++i]);
  else if (a === '--top') opt.top = +args[++i];
  else if (a === '--query') opt.query = args[++i];
  else if (a === '--verbose') opt.verbose = true;
}
fs.mkdirSync(opt.out, { recursive: true });

async function dumpScene() {
  const { chromium } = await import('playwright');
  const { createServer } = await import('vite');
  const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
  await server.listen();
  const port = server.httpServer.address().port;
  const exe = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await chromium.launch({
    ...(exe && process.platform !== 'darwin' ? { executablePath: exe } : {}),
    headless: true,
    args: process.platform === 'darwin' && !process.env.SWIFTSHADER
      ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
      : ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 270 }, deviceScaleFactor: 1 });
    page.on('console', (m) => {
      if (m.type() === 'error' || opt.verbose) console.error('[page]', m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)));
    // 让 Exclusions 记下注册模块
    await page.addInitScript(() => { globalThis.__XIAN_DIAG = 1; });
    // 不影响建筑的重模块跳过（植被/车流/招牌/行人/地铁/高德信息）；画质最低、离线底图
    const q = new URLSearchParams(opt.query || 'online=0&q=0&ui=0&mini=0&labels=0&skip=vegetation,traffic,signage,pedestrians,metro,amapinfo');
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/?${q}`);
    await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: opt.wait * 1000, polling: 1000 });
    const fatal = await page.evaluate(() => window.xian.fatal);
    if (fatal) throw new Error('fatal: ' + fatal);
    console.error(`[check] 场景就绪 ${((Date.now() - t0) / 1000).toFixed(0)} s，导出数据……`);
    const dump = await page.evaluate(() => {
      const X = window.xian, ctx = X.ctx, T = ctx.terrain;
      X.paused = true;
      const r1 = (v) => Math.round(v * 10) / 10;
      // 沿轮廓（顶点 + 每 ≤ 8 m 一点）采样地形：[min, max]
      const samp = (pts) => {
        let lo = Infinity, hi = -Infinity;
        const n = pts.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[j * 2], bz = pts[j * 2 + 1];
          const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
          for (let s = 0; s < k; s++) {
            const h = T.heightAt(ax + ((bx - ax) * s) / k, az + ((bz - az) * s) / k);
            if (h < lo) lo = h;
            if (h > hi) hi = h;
          }
        }
        return [r1(lo), r1(hi)];
      };
      const out = { modules: X.modules.map((m) => m.id), errors: X.errors };
      // —— 通用建筑 ——
      const B = ctx.modules.buildings?.diag;
      if (B) {
        const buf = ctx.data.buildings, dv = new DataView(buf);
        const ver = dv.getUint32(4, true), N = dv.getUint32(8, true);
        let o = 16;
        const ax = new Float32Array(buf, o, N); o += N * 4;
        const az = new Float32Array(buf, o, N); o += N * 4;
        const vs = new Uint32Array(buf, o, N); o += N * 4;
        const vc = new Uint16Array(buf, o, N); o += N * 2;
        o += N * 4; // heightDm + minHeightDm
        o += N * 2 + (ver >= 2 ? N : 0);
        o += (4 - (o % 4)) % 4;
        const offs = new Int16Array(buf, o);
        const tmin = new Float32Array(N), tmax = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          if (B.skip[i]) continue;
          const pts = [];
          for (let k = vs[i] * 2, e = k + vc[i] * 2; k < e; k += 2) pts.push(ax[i] + offs[k] * 0.1, az[i] + offs[k + 1] * 0.1);
          const [a, b] = samp(pts);
          tmin[i] = a;
          tmax[i] = b;
        }
        out.bld = { n: N, skip: Array.from(B.skip), base: Array.from(B.base, r1), ga: Array.from(B.ga, r1), tmin: Array.from(tmin), tmax: Array.from(tmax) };
      }
      // —— skyline ——
      const S = ctx.modules.skyline?.diag;
      out.sky = S ? S().map((s) => ({ ...s, pts: s.pts.map(r1), base: r1(s.base), t: samp(s.pts) })) : [];
      // —— 逐栋档案建筑（各体块） ——
      const Dz = ctx.modules.dossier?.diag;
      out.dossier = Dz ? Dz().map((p) => ({ ...p, pts: Array.from(p.pts, r1), bot: r1(p.bot), top: r1(p.top), t: samp(p.pts) })) : null;
      // —— 下沉广场（坑口轮廓、压顶/坑底高） ——
      const Sk = ctx.modules.sunken?.diag;
      out.sunken = Sk ? Sk() : null;
      out.datang = ctx.modules.datang?.diag ? ctx.modules.datang.diag() : null;
      // —— 排除区 ——
      out.excl = ctx.exclusions.items.map((it) => ({ owner: it.owner || '', name: it.name, flags: it.flags, p: Array.from(it.p, r1) }));
      return out;
    });
    return dump;
  } finally {
    await browser.close();
    await server.close();
  }
}

let dumpPath = opt.dump;
if (!dumpPath) {
  const d = await dumpScene();
  dumpPath = path.join(opt.out, 'dump.json');
  fs.writeFileSync(dumpPath, JSON.stringify(d));
  console.error(`[check] 已导出 ${dumpPath}（${(fs.statSync(dumpPath).size / 1e6).toFixed(1)} MB）`);
}
const py = process.env.PYTHON || (fs.existsSync(path.join(root, '.venv-tools/bin/python')) ? path.join(root, '.venv-tools/bin/python') : 'python3');
const r = spawnSync(py, [path.join(root, 'tools', 'check_overlap.py'), dumpPath, '--out', path.join(opt.out, 'report.json'), '--top', String(opt.top)], { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
