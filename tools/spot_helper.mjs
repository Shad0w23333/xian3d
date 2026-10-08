// 巡检机位辅助：按路名找最近路段，把相机放到路中线或人行道上并沿路看；检查机位是否落在建筑轮廓里或离墙太近。
// 用法：node tools/spot_helper.mjs '<JSON 数组：[{id, road, lon, lat, side:0|1|-1, flip, agl, tagl, ahead}]>'
//   side：0 路中线；1 行进方向右侧人行道；-1 左侧人行道。flip：反向看。输出 [{id, ll, d（到路距离）, inBld, wall（最近墙距离）}]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const g = await import(path.join(root, 'src/core/geo.js'));
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
o += N * 4; o += N; const FL = new Uint8Array(ab, o, N); o += N; o += ver >= 2 ? N : 0; o += (4 - (o % 4)) % 4;
const OF = new Int16Array(ab, o);
function ring(i) { const r = []; for (let k = VS[i] * 2, e = k + VC[i] * 2; k < e; k += 2) r.push([AX[i] + OF[k] * 0.1, AZ[i] + OF[k + 1] * 0.1]); return r; }
function pip(x, z, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; }
function segd(x, z, a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)); return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z); }
function bldCheck(x, z) {
  let inB = -1, wall = 99;
  for (let i = 0; i < N; i++) {
    if (FL[i] & 128) continue;
    if (Math.abs(AX[i] - x) > 120 || Math.abs(AZ[i] - z) > 120) continue;
    const r = ring(i);
    if (pip(x, z, r)) inB = i;
    for (let k = 0; k < r.length; k++) wall = Math.min(wall, segd(x, z, r[k], r[(k + 1) % r.length]));
  }
  return { inBld: inB, wall: +wall.toFixed(1) };
}
const MOTOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'unclassified', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
/** 点到最近机动车道路面边缘的距离（负 = 在路面上） */
function roadEdge(x, z) {
  let d = 99;
  for (const f of roads.features) {
    if (f.t || f.b || !MOTOR.has(roads.classes[f.c])) continue;
    const p = f.p, hw = (+f.w || 6) / 2;
    if (Math.abs(p[0] - x) > 3000 && Math.abs(p[p.length - 2] - x) > 3000) continue;
    for (let i = 0; i + 3 < p.length; i += 2) d = Math.min(d, segd(x, z, [p[i], p[i + 1]], [p[i + 2], p[i + 3]]) - hw);
  }
  return +d.toFixed(1);
}
const req = JSON.parse(process.argv[2]);
const out = [];
for (const q of req) {
  const P = g.project(q.lon, q.lat);
  let best = null;
  for (const f of roads.features) {
    if ((q.road && f.n !== q.road) || f.t || f.b) continue;
    const p = f.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((P.x - ax) * dx + (P.z - az) * dz) / L2));
      const x = ax + dx * t, z = az + dz * t, d = Math.hypot(x - P.x, z - P.z);
      if (!best || d < best.d) best = { d, x, z, dx, dz, w: +f.w || 8 };
    }
  }
  if (!best) { out.push({ id: q.id, err: '找不到路 ' + q.road }); continue; }
  const L = Math.hypot(best.dx, best.dz); let ux = best.dx / L, uz = best.dz / L;
  if (q.flip) { ux = -ux; uz = -uz; }
  const side = q.side || 0, off = side ? best.w / 2 + (q.walk ?? 3.2) : 0;
  const cx = best.x - uz * off * side, cz = best.z + ux * off * side;
  const ah = q.ahead || 150;
  const c = g.unproject(cx, cz), t = g.unproject(cx + ux * ah, cz + uz * ah);
  out.push({ id: q.id, ll: [+c.lon.toFixed(6), +c.lat.toFixed(6), q.agl ?? 1.7, +t.lon.toFixed(6), +t.lat.toFixed(6), q.tagl ?? 4], d: +best.d.toFixed(1), road: roadEdge(cx, cz), ...bldCheck(cx, cz) });
}
console.log(JSON.stringify(out, null, 1));
