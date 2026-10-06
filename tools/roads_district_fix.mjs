#!/usr/bin/env node
// 片区道路几何修正（用户点名片区的“街景级”打磨，2026-10）。按路名 + 范围匹配要素；移动顶点时同步移动共享该节点的
// 其它要素顶点（保持路网拓扑，traffic / pedestrians / 路名等按节点坐标连通）。每条规则先检测“是否已应用”，可重复运行。
// 依据：research/refs/districts/ 的 Google z17 卫星拼图（50 m 网格量测，见 notes.md）。
//
//  R1 未央路（凤城五路—张家堡环岛）北行幅：数据为 3 车道 11.5 m、与南行幅（4 车道 15 m）中心距 14.7 m（中分带仅 1.4 m）。
//     卫星：双向各 4 车道、中分带约 4 m。→ 北行幅 l=4、w=15，中心线东移 4 m（中心距 18.7 m → 中分带约 3.7 m）。
//  R2 凤城七路 开元路以东（x ≥ 600）：卫星量得北幅中心 z≈-8637、南幅 z≈-8620，数据为 -8625 / -8617（两幅中心距 8 m，
//     小于路宽 10.2 m，几何上互相重叠、中分带为负）。→ 北幅（西行）北移 12 m、南幅（东行）北移 3 m，中心距 17 m，中分带 6.8 m。
// 用法：node tools/roads_district_fix.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');
const file = path.join(root, 'public/data/roads.json');
const R = JSON.parse(fs.readFileSync(file, 'utf8'));
const feats = R.features;
const r1 = (v) => Math.round(v * 10) / 10;
const key = (x, z) => `${r1(x)}|${r1(z)}`;

// 节点表：坐标 → [fi, vi, ...]
const nodes = new Map();
feats.forEach((f, fi) => {
  for (let i = 0; i + 1 < f.p.length; i += 2) {
    const k = key(f.p[i], f.p[i + 1]);
    let a = nodes.get(k);
    if (!a) nodes.set(k, (a = []));
    a.push(fi, i);
  }
});
const moved = new Set();
let nMoved = 0;
/** 移动节点（连带所有共享该坐标的要素顶点） */
function moveNode(x, z, dx, dz) {
  const k = key(x, z);
  if (moved.has(k)) return;
  moved.add(k);
  const a = nodes.get(k) || [];
  for (let j = 0; j < a.length; j += 2) {
    const f = feats[a[j]];
    f.p[a[j + 1]] = r1(f.p[a[j + 1]] + dx);
    f.p[a[j + 1] + 1] = r1(f.p[a[j + 1] + 1] + dz);
    nMoved++;
  }
}
const log = [];

// ---------- R1 未央路北行幅 ----------
{
  const cands = feats.map((f, i) => [f, i]).filter(([f]) => f.n === '未央路' && f.o && R.classes[f.c] === 'primary' && f.p.some((v, i) => i % 2 === 1 && v < -7700 && v > -8900));
  const north = cands.filter(([f]) => { let sx = 0, n = 0; for (let i = 0; i < f.p.length; i += 2) if (f.p[i + 1] < -7700 && f.p[i + 1] > -8900) { sx += f.p[i]; n++; } return n && sx / n > 20 && sx / n < 45; });
  const done = north.every(([f]) => f.l >= 4 && f.w >= 15);
  if (done) log.push('R1 未央路北行幅：已应用，跳过');
  else {
    for (const [f, i] of north) {
      f.l = Math.max(f.l | 0, 4);
      f.w = Math.max(Number(f.w) || 0, 15);
      for (let k = 0; k < f.p.length; k += 2) {
        const z = f.p[k + 1];
        if (z < -7700 && z > -8900) moveNode(f.p[k], z, 4, 0);
      }
      log.push(`R1 未央路北行幅 #${i}：l=4 w=15，顶点东移 4 m`);
    }
  }
}

// ---------- R2 凤城七路开元路以东 ----------
{
  const cands = feats.map((f, i) => [f, i]).filter(([f]) => f.n === '凤城七路' && f.o && f.p.some((v, i) => i % 2 === 0 && v >= 600));
  for (const [f, i] of cands) {
    const east = f.p[f.p.length - 2] > f.p[0]; // 东行 = 南幅
    // 已应用判定：x≥900 处的 z
    let zRef = null;
    for (let k = 0; k < f.p.length; k += 2) if (f.p[k] >= 900) { zRef = f.p[k + 1]; break; }
    if (zRef === null) continue;
    const applied = east ? zRef < -8618.5 : zRef < -8632;
    if (applied) { log.push(`R2 凤城七路 #${i}（${east ? '南幅/东行' : '北幅/西行'}）：已应用，跳过`); continue; }
    const dz = east ? -3 : -12;
    for (let k = 0; k < f.p.length; k += 2) if (f.p[k] >= 600) moveNode(f.p[k], f.p[k + 1], 0, dz);
    log.push(`R2 凤城七路 #${i}（${east ? '南幅/东行' : '北幅/西行'}）：x≥600 顶点北移 ${-dz} m`);
  }
}

for (const l of log) console.log(l);
console.log(`移动顶点 ${nMoved} 个${dry ? '（--dry 未写回）' : ''}`);
if (!dry && nMoved) {
  fs.writeFileSync(file, JSON.stringify(R));
  console.log('已写回', path.relative(root, file));
}
