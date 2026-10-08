#!/usr/bin/env node
// 平面交叉口节点恢复（可重复运行，幂等）：public/data/roads.json 原地修正。
//
// 问题：tools/build_data.py 逐条 way 做 Douglas-Peucker 简化（容差 0.7~1.25 m，preserve_topology=False），
// 两条道路在 OSM 里共用的路口节点只要近似共线就会被其中一条（或两条）删掉。roads.json 里于是有上万处
// “几何上相交、却不共用节点”的平面交叉（用 data-src/osm 原始坐标核对：99% 在 3 m 内有 OSM 共用节点）。
// roads 模块按共用节点识别路口，这些交叉处
//   · 人行道/路缘石不断开，一条人行道铺装横穿另一条路的车行道（fs_锦业路：丈八一路两幅的人行道穿过锦业路南幅）；
//   · 没有路口半径 → 没有停止线/人行横道/导向箭头，车道线一直画进路口；车流也不能在此转弯；
//   · 两条路各自求纵断面，交叉处可能有高差（一条压在另一条上面）。
// 修正：同层地面车行道（非桥、非隧道、layer=0；不含高速公路与步行街/步道）两两求线段交点，交点 3 m 内两者
// 没有共用节点的，选定一个节点坐标 N 并保证两条折线都有顶点恰在 N（坐标取 0.1 m，与前端 nodeKey 一致）：
//   N 优先取交点 1.5 m 内已有的、被别的要素共用的顶点（不能挪），其次取等级高的一方的顶点，都没有就用交点本身；
//   缺 N 的一方在最近的线段上插入 N（离线段端点 <0.15 m 且该端点不被共用、不是折线端点时，就把端点挪到 N）。
// 循环到不再发现新的交叉为止（输出是不动点：再运行一次不会改变任何东西）。
// 不处理：高速公路（全立交）、步行街/步道（过街处不是车行路口，roads 模块另行处理）、桥/隧道/非 0 层。
// 用法：node tools/roads_junctions.mjs [--dry] [--in public/data/roads.json] [--out public/data/roads.json] [--dump 交点.json]
// 上游重新生成 roads.json（build_data.py / roads_update.py / roads_fix.mjs / roads_district_fix.mjs）后需再运行一次。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { in: 'public/data/roads.json', out: 'public/data/roads.json', dry: false, dump: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--in') opt.in = args[++i];
  else if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--dry') opt.dry = true;
  else if (args[i] === '--dump') opt.dump = args[++i];
}
const R = JSON.parse(fs.readFileSync(path.resolve(root, opt.in), 'utf8'));
const feats = R.features;
const CLS = R.classes;
const r1 = (v) => Math.round(v * 10) / 10;
const key = (x, z) => Math.round(x * 10) + ':' + Math.round(z * 10);

// 参与的要素：地面车行道（trunk..secondary_link，不含 motorway / pedestrian / footway）
const MOTOR = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 11]);
const ok = (f) => f && f.p && f.p.length >= 4 && MOTOR.has(f.c) && !f.b && !f.t && !(f.y || 0);

const total = { pairs: 0, newNode: 0, reuse: 0, moved: 0, inserted: 0, byClass: {} };
const touched = new Set();
const dumpPts = [];

function pass() {
  // 节点表（坐标 → 引用的要素集合）
  const nodeFeats = new Map();
  feats.forEach((f, fi) => {
    if (!f.p) return;
    for (let i = 0; i + 1 < f.p.length; i += 2) {
      const k = key(f.p[i], f.p[i + 1]);
      let s = nodeFeats.get(k);
      if (!s) nodeFeats.set(k, (s = new Set()));
      s.add(fi);
    }
  });
  const shared = (x, z) => (nodeFeats.get(key(x, z))?.size || 0) > 1;
  // 线段网格
  const CELL = 40;
  const grid = new Map();
  const gk = (cx, cz) => cx * 1000003 + cz;
  feats.forEach((f, fi) => {
    if (!ok(f)) return;
    const p = f.p;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k], az = p[k + 1], bx = p[k + 2], bz = p[k + 3];
      if (Math.abs(bx - ax) > 30000 || Math.abs(bz - az) > 30000) continue;
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / (CELL * 0.5)));
      let last = null;
      for (let j = 0; j <= n; j++) {
        const t = j / n;
        const c = gk(Math.floor((ax + (bx - ax) * t) / CELL), Math.floor((az + (bz - az) * t) / CELL));
        if (c === last) continue;
        last = c;
        let a = grid.get(c);
        if (!a) grid.set(c, (a = []));
        a.push(fi, k >> 1);
      }
    }
  });
  // fa 与 fb 在 (x,z) 附近 Rr 米内是否已共用节点
  const sharedNear = (fa, fb, x, z, Rr) => {
    const p = feats[fa].p;
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (Math.abs(p[i] - x) > Rr || Math.abs(p[i + 1] - z) > Rr || Math.hypot(p[i] - x, p[i + 1] - z) > Rr) continue;
      if (nodeFeats.get(key(p[i], p[i + 1]))?.has(fb)) return true;
    }
    return false;
  };
  const nearestVertex = (fi, x, z, Rr) => {
    const p = feats[fi].p;
    let best = null;
    for (let i = 0; i + 1 < p.length; i += 2) {
      const d = Math.hypot(p[i] - x, p[i + 1] - z);
      if (d < Rr && (!best || d < best.d)) best = { d, x: p[i], z: p[i + 1], sh: shared(p[i], p[i + 1]) };
    }
    return best;
  };
  // 本轮的节点决定：fi -> [{x, z}]（N 坐标）；同一要素同一 N 去重
  const need = new Map();
  const want = (fi, x, z) => {
    let a = need.get(fi);
    if (!a) need.set(fi, (a = []));
    if (!a.some((q) => key(q.x, q.z) === key(x, z))) a.push({ x, z });
  };
  const seenPair = new Set();
  let pairs = 0;
  for (const [, arr] of grid) {
    for (let a = 0; a < arr.length; a += 2)
      for (let b = a + 2; b < arr.length; b += 2) {
        const fa = arr[a], sa = arr[a + 1], fb = arr[b], sb = arr[b + 1];
        if (fa === fb) continue;
        const pk = fa < fb ? `${fa}|${sa}|${fb}|${sb}` : `${fb}|${sb}|${fa}|${sa}`;
        if (seenPair.has(pk)) continue;
        seenPair.add(pk);
        const P = feats[fa].p, Q = feats[fb].p;
        const ax = P[sa * 2], az = P[sa * 2 + 1], rx = P[sa * 2 + 2] - ax, rz = P[sa * 2 + 3] - az;
        const cx = Q[sb * 2], cz = Q[sb * 2 + 1], qx = Q[sb * 2 + 2] - cx, qz = Q[sb * 2 + 3] - cz;
        const lr = Math.hypot(rx, rz), lq = Math.hypot(qx, qz);
        if (lr < 0.3 || lq < 0.3) continue;
        const den = rx * qz - rz * qx;
        if (Math.abs(den) / (lr * lq) < 0.26) continue; // 交角 <15°：并行/分合流，不是平面交叉
        const wx = cx - ax, wz = cz - az;
        const t = (wx * qz - wz * qx) / den, u = (wx * rz - wz * rx) / den;
        // 交点恰在某一方的顶点上时浮点误差会让两侧线段都“差一点”不相交：放宽 0.25 m
        const et = 0.25 / lr, eu = 0.25 / lq;
        if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) continue;
        const x = ax + rx * t, z = az + rz * t;
        if (sharedNear(fa, fb, x, z, 3.0)) continue;
        // 节点坐标 N：已被共用的顶点（不能挪）> 等级高的一方的顶点 > 交点
        const va = nearestVertex(fa, x, z, 1.5), vb = nearestVertex(fb, x, z, 1.5);
        let N = null;
        if (va && va.sh && (!vb || !vb.sh || va.d <= vb.d)) N = va;
        else if (vb && vb.sh) N = vb;
        else if (va && vb) N = feats[fa].c <= feats[fb].c ? va : vb;
        else N = va || vb;
        if (N) total.reuse++;
        else { N = { x: r1(x), z: r1(z) }; total.newNode++; }
        want(fa, N.x, N.z);
        want(fb, N.x, N.z);
        pairs++;
        dumpPts.push([r1(x), r1(z)]);
        const ck = CLS[feats[fa].c] + '×' + CLS[feats[fb].c];
        total.byClass[ck] = (total.byClass[ck] || 0) + 1;
      }
  }
  // 落实：每个要素保证有顶点恰在每个 N
  for (const [fi, list] of need) {
    const f = feats[fi];
    let pts = [];
    for (let i = 0; i + 1 < f.p.length; i += 2) pts.push([f.p[i], f.p[i + 1]]);
    for (const N of list) {
      if (pts.some((q) => key(q[0], q[1]) === key(N.x, N.z))) continue;
      // 最近的线段
      let best = null;
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((N.x - ax) * dx + (N.z - az) * dz) / l2));
        const d = Math.hypot(ax + dx * t - N.x, az + dz * t - N.z);
        if (!best || d < best.d) best = { k, t, d, L: Math.sqrt(l2) };
      }
      if (!best || best.d > 2.0) continue;
      const { k } = best;
      const dA = Math.hypot(pts[k][0] - N.x, pts[k][1] - N.z), dB = Math.hypot(pts[k + 1][0] - N.x, pts[k + 1][1] - N.z);
      const near = dA <= dB ? k : k + 1, dn = Math.min(dA, dB);
      if (dn < 0.15 && near > 0 && near < pts.length - 1 && !shared(pts[near][0], pts[near][1])) {
        pts[near] = [N.x, N.z];
        total.moved++;
      } else if (dn >= 0.05) {
        pts.splice(k + 1, 0, [N.x, N.z]);
        total.inserted++;
      } else continue;
      touched.add(fi);
    }
    f.p = pts.flat();
  }
  return pairs;
}

let nPass = 0, n;
do {
  n = pass();
  total.pairs += n;
  nPass++;
} while (n > 0 && nPass < 6);
const sorted = Object.entries(total.byClass).sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log(`[roads_junctions] ${nPass} 轮，恢复平面交叉 ${total.pairs} 处（新节点 ${total.newNode}，复用已有顶点 ${total.reuse}），插入顶点 ${total.inserted}、挪动顶点 ${total.moved}，涉及要素 ${touched.size}${n > 0 ? '（未收敛：最后一轮仍有 ' + n + ' 处）' : ''}`);
console.log('  按等级：', JSON.stringify(Object.fromEntries(sorted)));
if (opt.dump) fs.writeFileSync(path.resolve(root, opt.dump), JSON.stringify(dumpPts));
if (!opt.dry && total.pairs > 0) {
  fs.writeFileSync(path.resolve(root, opt.out), JSON.stringify(R));
  console.log('  已写回', opt.out);
}
