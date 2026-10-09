#!/usr/bin/env node
// 全城网格巡检机位生成：内城（二环到三环以内）1 km 一格、外圈 2 km 一格；每格一张低空斜视 + 一张人行道人眼高度，每 6 格加一张夜景。
// 低空机位：从格心后退 300 m、朝格心看，朝向按格子轮换北/东/南/西，离地高 = max(90, 周边 80 m 内最高楼 + 40)。
// 人眼机位：离格心最近的机动车道（非隧道非桥），右侧人行道（路半宽 + 3.2 m），沿路看 150 m；落在楼里或车道上就换另一侧/另一段。
// 用法：node tools/make_grid_tour.mjs [--out tools/tour_grid.json]
// 输出机位 id：ga_<列>_<行>（低空）、ge_<列>_<行>（人眼）、gn_<列>_<行>（夜景低空）；note 里写格心经纬度。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const g = await import(path.join(root, 'src/core/geo.js'));
const a = process.argv.slice(2);
const outFile = path.resolve(root, a.includes('--out') ? a[a.indexOf('--out') + 1] : 'tools/tour_grid.json');

const INNER = [108.86, 34.19, 109.03, 34.33]; // 1 km 格
const OUTER = [108.80, 34.10, 109.10, 34.42]; // 2 km 格（扣掉内城）

const roads = JSON.parse(fs.readFileSync(path.join(root, 'public/data/roads.json'), 'utf8'));
const buf = fs.readFileSync(path.join(root, 'public/data/buildings.bin'));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dv = new DataView(ab);
const ver = dv.getUint32(4, true), N = dv.getUint32(8, true);
let o = 16;
const AX = new Float32Array(ab, o, N); o += N * 4;
const AZ = new Float32Array(ab, o, N); o += N * 4;
const VS = new Uint32Array(ab, o, N); o += N * 4;
const VC = new Uint16Array(ab, o, N); o += N * 2;
const HD = new Uint16Array(ab, o, N); o += N * 2; o += N * 2; // 高度、底高（分米）
o += N; const FL = new Uint8Array(ab, o, N); o += N; o += ver >= 2 ? N : 0; o += (4 - (o % 4)) % 4;
const OF = new Int16Array(ab, o);

// 建筑按 100 m 分格索引
const BG = 100, bgrid = new Map();
for (let i = 0; i < N; i++) {
  if (FL[i] & 128) continue;
  const k = Math.floor(AX[i] / BG) + ',' + Math.floor(AZ[i] / BG);
  (bgrid.get(k) || bgrid.set(k, []).get(k)).push(i);
}
function nearB(x, z, r) {
  const res = [];
  for (let i = Math.floor((x - r - 150) / BG); i <= Math.floor((x + r + 150) / BG); i++)
    for (let j = Math.floor((z - r - 150) / BG); j <= Math.floor((z + r + 150) / BG); j++) res.push(...(bgrid.get(i + ',' + j) || []));
  return res;
}
function ring(i) { const r = []; for (let k = VS[i] * 2, e = k + VC[i] * 2; k < e; k += 2) r.push([AX[i] + OF[k] * 0.1, AZ[i] + OF[k + 1] * 0.1]); return r; }
function pip(x, z, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; }
function segd(x, z, ax, az, bx, bz) { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); return Math.hypot(ax + dx * t - x, az + dz * t - z); }
function bldCheck(x, z) {
  let inB = false, wall = 99;
  for (const i of nearB(x, z, 60)) {
    if (Math.abs(AX[i] - x) > 150 || Math.abs(AZ[i] - z) > 150) continue;
    const r = ring(i);
    if (pip(x, z, r)) inB = true;
    for (let k = 0; k < r.length; k++) { const p = r[k], q = r[(k + 1) % r.length]; wall = Math.min(wall, segd(x, z, p[0], p[1], q[0], q[1])); }
  }
  return { inB, wall };
}
function hmax(x, z, r) { let h = 0; for (const i of nearB(x, z, r)) if (Math.hypot(AX[i] - x, AZ[i] - z) < r + 30) h = Math.max(h, HD[i] / 10); return h; }

// 机动车道按 200 m 分格索引（存线段）
const MOTOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
const STREET = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);
const RG = 200, rgrid = new Map(), segs = [];
for (const f of roads.features) {
  const cls = roads.classes[f.c];
  if (!MOTOR.has(cls)) continue;
  const p = f.p, w = +f.w || 8;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const s = { ax: p[i], az: p[i + 1], bx: p[i + 2], bz: p[i + 3], w, street: STREET.has(cls) && !f.t && !f.b, n: f.n || '' };
    const id = segs.push(s) - 1;
    const x0 = Math.floor(Math.min(s.ax, s.bx) / RG), x1 = Math.floor(Math.max(s.ax, s.bx) / RG);
    const z0 = Math.floor(Math.min(s.az, s.bz) / RG), z1 = Math.floor(Math.max(s.az, s.bz) / RG);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) { const k = gx + ',' + gz; (rgrid.get(k) || rgrid.set(k, []).get(k)).push(id); }
  }
}
function nearSegs(x, z, r) {
  const ids = new Set();
  for (let i = Math.floor((x - r) / RG); i <= Math.floor((x + r) / RG); i++)
    for (let j = Math.floor((z - r) / RG); j <= Math.floor((z + r) / RG); j++) for (const id of rgrid.get(i + ',' + j) || []) ids.add(id);
  return [...ids].map((id) => segs[id]);
}
function roadEdge(x, z) { let d = 99; for (const s of nearSegs(x, z, 60)) d = Math.min(d, segd(x, z, s.ax, s.az, s.bx, s.bz) - s.w / 2); return d; }

const ll = (x, z) => { const u = g.unproject(x, z); return [+u.lon.toFixed(6), +u.lat.toFixed(6)]; };
function cells() {
  const out = [];
  const add = (lon0, lat0, step, tag, skipInner) => {
    const P0 = g.project(lon0[0], lat0[0]), P1 = g.project(lon0[1], lat0[1]);
    const xs = Math.min(P0.x, P1.x), xe = Math.max(P0.x, P1.x), zs = Math.min(P0.z, P1.z), ze = Math.max(P0.z, P1.z);
    const I0 = g.project(INNER[0], INNER[1]), I1 = g.project(INNER[2], INNER[3]);
    let ci = 0;
    for (let x = xs + step / 2; x < xe; x += step, ci++) {
      let ri = 0;
      for (let z = zs + step / 2; z < ze; z += step, ri++) {
        if (skipInner && x > Math.min(I0.x, I1.x) && x < Math.max(I0.x, I1.x) && z > Math.min(I0.z, I1.z) && z < Math.max(I0.z, I1.z)) continue;
        out.push({ x, z, key: `${tag}${String(ci).padStart(2, '0')}_${String(ri).padStart(2, '0')}`, step });
      }
    }
  };
  add([INNER[0], INNER[2]], [INNER[1], INNER[3]], 1000, 'i', false);
  add([OUTER[0], OUTER[2]], [OUTER[1], OUTER[3]], 2000, 'o', true);
  return out;
}

const HEAD = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // 朝北、东、南、西看（北 = -Z）
const spots = [], stat = { cells: 0, eye: 0, eyeMiss: 0 };
let n = 0;
for (const c of cells()) {
  stat.cells++;
  const [hx, hz] = HEAD[n % 4];
  const back = c.step === 1000 ? 300 : 500;
  const camx = c.x - hx * back, camz = c.z - hz * back;
  const alt = Math.round(Math.max(c.step === 1000 ? 90 : 140, hmax(camx, camz, 80) + 40));
  const cen = ll(c.x, c.z);
  spots.push({ id: `ga_${c.key}`, ll: [...ll(camx, camz), alt, ...cen, 0], time: 15, note: `网格低空 ${cen.join(',')}` });
  if (n % 6 === 3) spots.push({ id: `gn_${c.key}`, ll: [...ll(camx, camz), alt, ...cen, 0], time: 20.5, note: `网格夜景 ${cen.join(',')}` });
  n++;
  // 人眼：格心 0.45 格内最近的街道段，依次试右/左人行道、正/反方向
  const cand = nearSegs(c.x, c.z, c.step * 0.45).filter((s) => s.street && Math.hypot(s.bx - s.ax, s.bz - s.az) > 20)
    .map((s) => ({ s, d: segd(c.x, c.z, s.ax, s.az, s.bx, s.bz) })).sort((p, q) => p.d - q.d).slice(0, 12);
  let got = null;
  for (const { s } of cand) {
    const dx = s.bx - s.ax, dz = s.bz - s.az, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const mx = (s.ax + s.bx) / 2, mz = (s.az + s.bz) / 2;
    for (const side of [1, -1]) {
      for (const walk of [3.2, 2.2, 4.5]) {
        const off = s.w / 2 + walk;
        const px = mx - uz * off * side, pz = mz + ux * off * side;
        const re = roadEdge(px, pz), bc = bldCheck(px, pz);
        if (re < 0.8 || bc.inB || bc.wall < 0.8) continue;
        const dir = side === 1 ? 1 : -1; // 靠右行：右侧人行道顺着路方向看，左侧反过来
        got = { px, pz, tx: px + ux * dir * 150, tz: pz + uz * dir * 150, n: s.n, re, wall: bc.wall };
        break;
      }
      if (got) break;
    }
    if (got) break;
  }
  if (got) {
    stat.eye++;
    spots.push({ id: `ge_${c.key}`, ll: [...ll(got.px, got.pz), 1.7, ...ll(got.tx, got.tz), 4], time: 15, note: `网格人眼 ${got.n || '无名路'}（离车道 ${got.re.toFixed(1)} m，离墙 ${got.wall.toFixed(1)} m）` });
  } else stat.eyeMiss++;
}
fs.writeFileSync(outFile, JSON.stringify(spots, null, 1));
console.log(`格子 ${stat.cells}，人眼机位 ${stat.eye}（找不到合适街道 ${stat.eyeMiss}），总机位 ${spots.length} → ${path.relative(root, outFile)}`);
