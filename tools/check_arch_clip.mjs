#!/usr/bin/env node
// 古建几何体检（无浏览器）：穿模 / 悬空 / NaN 与零法线 / 共面重叠（Z-fighting）/ LOD 顶部错位 / 院落布局与地形。
// 用法：node tools/check_arch_clip.mjs [--modules belltower,citywall,pagoda,heritage,heritage26] [--json out.json] [--list 20]
//
// 几何来源：tools/arch_env.mjs 在 Node 里用 DOM 桩 + 真实 DEM 跑模块 prepare/build，遍历 scene（世界坐标）。
// 城墙城门与 heritage26 院落的近景 LOD 按需构建：脚本把相机逐个移到目标处调用模块 update()，直到最高细节都建好。
//
// 判定口径（所有距离单位：米）：
//  · 构件：同一目标内按顶点位置（2 mm 量化）焊接后的连通块（一个 box/lathe/sweep 即一个构件）。
//  · 悬空：构件之间距离 ≤ 0.3 视为“接触”，接触关系连成簇；簇内没有任何构件落地（最低点离地形 ≤ 0.3）即为悬空簇。
//    灯具/灯条/窗纸/匾额（emit/led/glow/lattice/plaque）属悬挂装饰，不计。
//  · 穿插（穿出屋面）：非屋面构件在同一片屋面（瓦面连通块）上下两侧都伸出 > 0.3（柱穿屋顶、斗拱/梁头戳出瓦面等）。
//    按单个瓦面三角形判定（上下两侧都 > 0.5）；屋脊/宝顶座（ridge*）本来就压在瓦面上，不计。
//  · Z-fighting：不同构件的同向三角形共面（法线夹角 < 2.6°、平面距离 < 5 mm）且重叠面积 > 0.01 m²。
//  · NaN/零法线：顶点坐标或法线含 NaN，或法线长度 < 1e-6。
//  · LOD 顶部：同一 LOD 各级的最高点（宝顶/塔刹/正脊，不计灯具）相差 > 0.3（切换细节时顶部跳变）。
//  · heritage26 布局：同院建筑平面相交（> 1 m²）、建筑压院墙/出院墙、建筑落地处地形高差（埋地/悬空 > 0.3，按建筑自身平面四角+中心取样）。
import { buildModules } from './arch_env.mjs';
import * as THREE from 'three';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = { modules: ['citywall', 'belltower', 'pagoda', 'heritage', 'heritage26'], json: null, list: 12 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--modules') opt.modules = args[++i].split(',');
  else if (args[i] === '--json') opt.json = args[++i];
  else if (args[i] === '--list') opt.list = +args[++i];
}

const DECO = new Set(['emit', 'led', 'glow', 'lattice', 'plaque']);
const ROOF = new Set(['tile', 'tileGlazed', 'tileFlat', 'tileFlatGlazed']);
const RIDGE = new Set(['ridge', 'ridgeGlazed']);
const TOUCH = 0.3;
const PIERCE = 0.5; // 穿出屋面：瓦面上下两侧都伸出 > 0.5 m（0.3 m 以内的榫接/压脊属正常搭接，瓦面遮住看不见）

let terrain = null, ctx = null;

/** 构建模块、补建近景 LOD，返回待检目标列表 */
async function collectTargets() {
  const t0 = Date.now();
  const built = await buildModules(opt.modules);
    const { scene, instances } = built;
    terrain = built.terrain;
    ctx = built.ctx;
  console.error(`[check] 模块构建 ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // —— 近景 LOD 补建 ——
  if (instances.citywall?.update) {
    const cw = scene.children.find((o) => o.userData.module === 'citywall');
    const lods = [];
    cw?.traverse((o) => o.isLOD && lods.push(o));
    for (const l of lods) {
      const p = new THREE.Vector3();
      l.getWorldPosition(p);
      ctx.camera.position.set(p.x, p.y + 30, p.z);
      for (let k = 0; k < 4; k++) instances.citywall.update();
    }
  }
  if (instances.heritage26?.update) {
    const root = scene.children.find((o) => o.userData.module === 'heritage26');
    for (const l of root?.children || []) {
      ctx.camera.position.set(l.position.x, l.position.y + 50, l.position.z);
      for (let k = 0; k < 3; k++) instances.heritage26.update();
    }
  }
  scene.updateMatrixWorld(true);

  // ───────────── 目标收集 ─────────────
  // 每个目标 = 一个 LOD 的最高细节级（或一个普通组），另记 LOD 全部级别供顶部一致性检查
  const targets = [];
  for (const top of scene.children) {
    const mod = top.userData.module;
    if (!mod) continue;
    const seen = new Set();
    top.traverse((o) => {
      if (o.isLOD) {
        const lv = o.levels.map((l) => l.object).filter((x) => x.children?.length || x.isMesh);
        if (!lv.length) return;
        targets.push({ mod, name: o.name || lv[0].name, obj: lv[0], lod: o, levels: lv });
        for (const x of lv) x.traverse((c) => seen.add(c));
      }
    });
    // 非 LOD 的古建组（城门远景合批、广场小品等）：只取由构件库生成的组（子网格名为材质键）
    for (const c of top.children) {
      if (seen.has(c) || c.isLOD || !c.isGroup) continue;
      let arch = false;
      c.traverse((m) => m.isMesh && (ROOF.has(m.name) || m.name === 'paint' || m.name === 'stone') && (arch = true));
      if (arch) targets.push({ mod, name: c.name, obj: c });
    }
    // 模块内的“承托物”：目标之外的网格也能托住构件（如角楼立在城墙墙身上）。LOD 只取当前最高级，远景替身组不算
    const support = [];
    const skip = new Set();
    top.traverse((o) => {
      if (o.isLOD) for (const l of o.levels.slice(1)) l.object.traverse((c) => skip.add(c));
      if (/远景/.test(o.name)) o.traverse((c) => skip.add(c));
    });
    top.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || skip.has(o) || DECO.has(o.name) || !o.geometry?.attributes?.position) return;
      o.geometry.computeBoundingBox();
      support.push({ mesh: o, box: o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld) });
    });
    for (const tg of targets) if (tg.mod === mod) tg.support = support;
  }
  return targets;
}

/** 在目标以外的承托网格里找 (x,z) 处、高度不超过 y 的最高表面（没有则 -Infinity） */
function supportBelow(tg, x, y, z) {
  let best = -Infinity;
  const own = new Set();
  tg.obj.traverse((o) => own.add(o));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const { mesh, box } of tg.support || []) {
    if (own.has(mesh) || x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z || box.min.y > y + 0.01) continue;
    const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index?.array;
    const n = idx ? idx.length : pos.count;
    const M = mesh.matrixWorld;
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(pos, idx ? idx[i] : i).applyMatrix4(M);
      b.fromBufferAttribute(pos, idx ? idx[i + 1] : i + 1).applyMatrix4(M);
      c.fromBufferAttribute(pos, idx ? idx[i + 2] : i + 2).applyMatrix4(M);
      if (Math.min(a.x, b.x, c.x) > x || Math.max(a.x, b.x, c.x) < x || Math.min(a.z, b.z, c.z) > z || Math.max(a.z, b.z, c.z) < z) continue;
      const den = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(den) < 1e-12) continue;
      const l0 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / den, l1 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / den, l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const yy = l0 * a.y + l1 * b.y + l2 * c.y;
      if (yy <= y + 0.01 && yy > best) best = yy;
    }
  }
  return best;
}

// ───────────── 几何提取（世界坐标、焊接） ─────────────
function extract(obj) {
  const keyMap = new Map();
  const P = [];
  const tris = [];
  const triMat = [];
  const mats = [];
  let nanPos = 0, badNorm = 0, verts = 0;
  const v = new THREE.Vector3(), m4 = new THREE.Matrix4();
  const addMesh = (mesh, M) => {
    const g = mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal;
    if (!pos) return;
    let mi = mats.indexOf(mesh.name);
    if (mi < 0) mi = mats.push(mesh.name) - 1;
    const ids = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(M);
      verts++;
      if (!Number.isFinite(v.x + v.y + v.z)) {
        nanPos++;
        ids[i] = -1;
        continue;
      }
      if (nor) {
        const x = nor.getX(i), y = nor.getY(i), z = nor.getZ(i);
        if (!(x * x + y * y + z * z > 1e-12)) badNorm++;
      }
      const k = Math.round(v.x * 500) + ',' + Math.round(v.y * 500) + ',' + Math.round(v.z * 500);
      let id = keyMap.get(k);
      if (id === undefined) {
        id = P.length / 3;
        keyMap.set(k, id);
        P.push(v.x, v.y, v.z);
      }
      ids[i] = id;
    }
    const idx = g.index ? g.index.array : null;
    const n = idx ? idx.length : pos.count;
    for (let i = 0; i < n; i += 3) {
      const a = ids[idx ? idx[i] : i], b = ids[idx ? idx[i + 1] : i + 1], c = ids[idx ? idx[i + 2] : i + 2];
      if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
      tris.push(a, b, c);
      triMat.push(mi);
    }
  };
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (o.isInstancedMesh) {
      for (let k = 0; k < o.count; k++) {
        o.getMatrixAt(k, m4);
        addMesh(o, m4.clone().premultiply(o.matrixWorld));
      }
    } else addMesh(o, o.matrixWorld);
  });
  return { P: Float64Array.from(P), T: Int32Array.from(tris), TM: Uint8Array.from(triMat), mats, nanPos, badNorm, verts };
}

class UF {
  constructor(n) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  f(x) {
    const p = this.p;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  }
  u(a, b) {
    a = this.f(a);
    b = this.f(b);
    if (a !== b) this.p[a] = b;
    return a !== b;
  }
}

// 点到三角形最近距离²
function pt2tri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const sq = (x, y, z) => x * x + y * y + z * z;
  if (d1 <= 0 && d2 <= 0) return sq(apx, apy, apz);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return sq(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return sq(apx - abx * t, apy - aby * t, apz - abz * t);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return sq(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return sq(apx - acx * t, apy - acy * t, apz - acz * t);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return sq(px - (bx + (cx - bx) * t), py - (by + (cy - by) * t), pz - (bz + (cz - bz) * t));
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return sq(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
}

// 三维均匀网格（三角形按包围盒登记）
class Grid {
  constructor(cell) {
    this.c = cell;
    this.m = new Map();
  }
  key(i, j, k) {
    return (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  }
  insertBox(id, x0, y0, z0, x1, y1, z1) {
    const c = this.c;
    const i0 = Math.floor(x0 / c), i1 = Math.floor(x1 / c), j0 = Math.floor(y0 / c), j1 = Math.floor(y1 / c), k0 = Math.floor(z0 / c), k1 = Math.floor(z1 / c);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > 200000) return false;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++) {
          const q = this.key(i, j, k);
          let a = this.m.get(q);
          if (!a) this.m.set(q, (a = []));
          a.push(id);
        }
    return true;
  }
  query(x0, y0, z0, x1, y1, z1, fn) {
    const c = this.c;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++)
      for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++)
        for (let k = Math.floor(z0 / c); k <= Math.floor(z1 / c); k++) {
          const a = this.m.get(this.key(i, j, k));
          if (a) for (const id of a) if (fn(id) === false) return;
        }
  }
}

export function analyze(tg, groundFn = null) {
  const G = extract(tg.obj);
  const { P, T, TM, mats } = G;
  const nT = T.length / 3, nV = P.length / 3;
  // 构件：三角形共享顶点 → 连通
  const uf = new UF(nV);
  for (let t = 0; t < nT; t++) {
    uf.u(T[t * 3], T[t * 3 + 1]);
    uf.u(T[t * 3], T[t * 3 + 2]);
  }
  const compOfV = new Int32Array(nV);
  const compIds = new Map();
  for (let i = 0; i < nV; i++) {
    const r = uf.f(i);
    let c = compIds.get(r);
    if (c === undefined) compIds.set(r, (c = compIds.size));
    compOfV[i] = c;
  }
  const nC = compIds.size;
  const cMat = new Int16Array(nC).fill(-1);
  const cMin = new Float64Array(nC * 3).fill(Infinity), cMax = new Float64Array(nC * 3).fill(-Infinity);
  const cTris = Array.from({ length: nC }, () => []);
  for (let t = 0; t < nT; t++) {
    const c = compOfV[T[t * 3]];
    cTris[c].push(t);
    if (cMat[c] < 0) cMat[c] = TM[t];
  }
  for (let i = 0; i < nV; i++) {
    const c = compOfV[i];
    for (let a = 0; a < 3; a++) {
      const x = P[i * 3 + a];
      if (x < cMin[c * 3 + a]) cMin[c * 3 + a] = x;
      if (x > cMax[c * 3 + a]) cMax[c * 3 + a] = x;
    }
  }
  const cVerts = Array.from({ length: nC }, () => []);
  for (let i = 0; i < nV; i++) cVerts[compOfV[i]].push(i);
  const matOf = (c) => mats[cMat[c]] || '?';
  const isDeco = (c) => DECO.has(matOf(c));

  // —— 接触图 ——
  const grid = new Grid(1.0);
  const bigTris = [];
  for (let t = 0; t < nT; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ok = grid.insertBox(t, Math.min(P[a], P[b], P[c]) - TOUCH, Math.min(P[a + 1], P[b + 1], P[c + 1]) - TOUCH, Math.min(P[a + 2], P[b + 2], P[c + 2]) - TOUCH, Math.max(P[a], P[b], P[c]) + TOUCH, Math.max(P[a + 1], P[b + 1], P[c + 1]) + TOUCH, Math.max(P[a + 2], P[b + 2], P[c + 2]) + TOUCH);
    if (!ok) bigTris.push(t);
  }
  const touch = new UF(nC);
  const T2 = TOUCH * TOUCH;
  const triDist2 = (t, x, y, z) => {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    return pt2tri(x, y, z, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
  };
  for (let i = 0; i < nV; i++) {
    const ci = compOfV[i];
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const visit = (t) => {
      const cj = compOfV[T[t * 3]];
      if (cj === ci || touch.f(cj) === touch.f(ci)) return;
      if (triDist2(t, x, y, z) <= T2) touch.u(ci, cj);
    };
    grid.query(x, y, z, x, y, z, visit);
    for (const t of bigTris) visit(t);
  }
  // 落地：构件最低点离地形 ≤ 0.3
  const grounded = new Set();
  const groundAt = groundFn || ((x, z) => terrain.heightAt(x, z));
  for (let c = 0; c < nC; c++) {
    let lo = Infinity, lx = 0, lz = 0;
    for (const i of cVerts[c])
      if (P[i * 3 + 1] < lo) {
        lo = P[i * 3 + 1];
        lx = P[i * 3];
        lz = P[i * 3 + 2];
      }
    if (lo <= groundAt(lx, lz) + TOUCH) grounded.add(touch.f(c));
  }
  const clusters = new Map();
  for (let c = 0; c < nC; c++) {
    if (!cTris[c].length) continue; // 只剩退化三角形的孤立顶点
    const r = touch.f(c);
    if (grounded.has(r)) continue;
    let e = clusters.get(r);
    if (!e) clusters.set(r, (e = { comps: [], deco: true }));
    e.comps.push(c);
    if (!isDeco(c)) e.deco = false;
  }
  const floating = [];
  for (const e of clusters.values()) {
    if (e.deco) continue;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const ms = new Set();
    let nt = 0;
    for (const c of e.comps) {
      x0 = Math.min(x0, cMin[c * 3]); y0 = Math.min(y0, cMin[c * 3 + 1]); z0 = Math.min(z0, cMin[c * 3 + 2]);
      x1 = Math.max(x1, cMax[c * 3]); y1 = Math.max(y1, cMax[c * 3 + 1]); z1 = Math.max(z1, cMax[c * 3 + 2]);
      ms.add(matOf(c));
      nt += cTris[c].length;
    }
    // 下方最近的非本簇几何（沿 -Y 的间隙）
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    let below = -Infinity;
    const members = new Set(e.comps);
    for (let t = 0; t < nT; t++) {
      if (members.has(compOfV[T[t * 3]])) continue;
      const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
      const yM = Math.max(P[a + 1], P[b + 1], P[c + 1]);
      if (yM > y0 + 0.01 || yM < below) continue;
      if (Math.min(P[a], P[b], P[c]) > cx || Math.max(P[a], P[b], P[c]) < cx || Math.min(P[a + 2], P[b + 2], P[c + 2]) > cz || Math.max(P[a + 2], P[b + 2], P[c + 2]) < cz) continue;
      below = yM;
    }
    below = Math.max(below, groundAt(cx, cz));
    // 目标外承托：取簇最低的若干顶点，任一点正下方 0.3 m 内有模块内其他网格即算有支撑
    if (tg.support) {
      const low = [];
      for (const c of e.comps) for (const i of cVerts[c]) low.push(i);
      low.sort((p, q) => P[p * 3 + 1] - P[q * 3 + 1]);
      let held = false;
      for (const i of low.slice(0, 12)) {
        const sb = supportBelow(tg, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        if (P[i * 3 + 1] - sb <= TOUCH) {
          held = true;
          break;
        }
      }
      if (held) continue;
    }
    // 最低点及其正下方地面（便于定位）
    let li = -1;
    for (const c of e.comps) for (const i of cVerts[c]) if (li < 0 || P[i * 3 + 1] < P[li * 3 + 1]) li = i;
    const lowest = [P[li * 3], P[li * 3 + 1], P[li * 3 + 2], groundAt(P[li * 3], P[li * 3 + 2])].map((v) => +v.toFixed(2));
    floating.push({ mats: [...ms].join('+'), comps: e.comps.length, tris: nt, bbox: [x0, y0, z0, x1, y1, z1].map((v) => +v.toFixed(2)), gap: +(y0 - below).toFixed(2), lowest });
  }
  floating.sort((a, b) => b.tris - a.tris);

  // —— 穿出屋面 ——
  const roofGrid = new Map();
  const RC = 1.0;
  for (let t = 0; t < nT; t++) {
    if (!ROOF.has(mats[TM[t]])) continue;
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const i0 = Math.floor(Math.min(P[a], P[b], P[c]) / RC), i1 = Math.floor(Math.max(P[a], P[b], P[c]) / RC);
    const k0 = Math.floor(Math.min(P[a + 2], P[b + 2], P[c + 2]) / RC), k1 = Math.floor(Math.max(P[a + 2], P[b + 2], P[c + 2]) / RC);
    for (let i = i0; i <= i1; i++)
      for (let k = k0; k <= k1; k++) {
        const q = i * 100003 + k;
        let arr = roofGrid.get(q);
        if (!arr) roofGrid.set(q, (arr = []));
        arr.push(t);
      }
  }
  const pierce = [];
  if (roofGrid.size) {
    for (let c = 0; c < nC; c++) {
      const mt = matOf(c);
      if (ROOF.has(mt) || RIDGE.has(mt) || DECO.has(mt)) continue;
      // 同一块瓦面三角形（XZ 投影覆盖顶点）之上、之下都有本构件的顶点，且两侧都超过阈值 → 穿出屋面。
      // 按三角形而不是整片屋面判定：歇山山花、重檐围脊处的竖向构件夹在不同坡面之间，不算穿插。
      const rng = new Map(); // roofTri → [min, max, x, y, z]
      for (const i of cVerts[c]) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const arr = roofGrid.get(Math.floor(x / RC) * 100003 + Math.floor(z / RC));
        if (!arr) continue;
        for (const t of arr) {
          const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, cc = T[t * 3 + 2] * 3;
          // 重心坐标（XZ 投影）
          const x0 = P[a], z0 = P[a + 2], x1 = P[b], z1 = P[b + 2], x2 = P[cc], z2 = P[cc + 2];
          const den = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
          if (Math.abs(den) < 1e-9) continue;
          const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / den, l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / den, l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const yr = l0 * P[a + 1] + l1 * P[b + 1] + l2 * P[cc + 1];
          const d = y - yr;
          if (Math.abs(d) > 6) continue;
          let e = rng.get(t);
          if (!e) rng.set(t, (e = [Infinity, -Infinity, 0, 0, 0]));
          if (d < e[0]) e[0] = d;
          if (d > e[1]) {
            e[1] = d;
            e[2] = x;
            e[3] = y;
            e[4] = z;
          }
        }
      }
      let best = null;
      for (const [t, e] of rng) if (e[0] < -PIERCE && e[1] > PIERCE && (!best || Math.min(-e[0], e[1]) > Math.min(-best[1][0], best[1][1]))) best = [t, e];
      if (best) {
        const [t, e] = best;
        pierce.push({ mat: mt, roof: mats[TM[t]], above: +e[1].toFixed(2), below: +(-e[0]).toFixed(2), at: [e[2], e[3], e[4]].map((v) => +v.toFixed(2)), tris: cTris[c].length, bb: [0, 1, 2, 3, 4, 5].map((k) => +(k < 3 ? cMin[c * 3 + k] : cMax[c * 3 + k - 3]).toFixed(2)) });
      }
    }
  }
  pierce.sort((a, b) => b.above - a.above);

  // —— Z-fighting ——
  const planes = new Map();
  const nrm = new Float64Array(nT * 4);
  for (let t = 0; t < nT; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 2e-3) continue; // 面积 < 0.001 m²
    nx /= l; ny /= l; nz /= l;
    const d = nx * P[a] + ny * P[a + 1] + nz * P[a + 2];
    nrm[t * 4] = nx; nrm[t * 4 + 1] = ny; nrm[t * 4 + 2] = nz; nrm[t * 4 + 3] = d;
    const key = Math.round(nx * 40) + ',' + Math.round(ny * 40) + ',' + Math.round(nz * 40) + ',' + Math.round(d * 100);
    let arr = planes.get(key);
    if (!arr) planes.set(key, (arr = []));
    arr.push(t);
  }
  const zf = [];
  const zfPairs = new Set();
  const proj = (t, ax) => {
    const o = [];
    for (let k = 0; k < 3; k++) {
      const p = T[t * 3 + k] * 3;
      o.push(ax === 0 ? [P[p + 1], P[p + 2]] : ax === 1 ? [P[p], P[p + 2]] : [P[p], P[p + 1]]);
    }
    return o;
  };
  for (const [key, arr] of planes) {
    const [kx, ky, kz, kd] = key.split(',').map(Number);
    // 同法线、相邻平面距离格
    const cand = [...arr];
    for (const dd of [-1, 1]) {
      const o = planes.get(kx + ',' + ky + ',' + kz + ',' + (kd + dd));
      if (o && dd > 0) cand.push(...o);
    }
    if (cand.length < 2) continue;
    const ax = Math.abs(kx) >= Math.abs(ky) && Math.abs(kx) >= Math.abs(kz) ? 0 : Math.abs(ky) >= Math.abs(kz) ? 1 : 2;
    const bb = cand.map((t) => {
      const q = proj(t, ax);
      return { t, q, u0: Math.min(q[0][0], q[1][0], q[2][0]), u1: Math.max(q[0][0], q[1][0], q[2][0]), v0: Math.min(q[0][1], q[1][1], q[2][1]), v1: Math.max(q[0][1], q[1][1], q[2][1]) };
    });
    bb.sort((a, b) => a.u0 - b.u0);
    for (let i = 0; i < bb.length; i++) {
      const A = bb[i];
      const ca = compOfV[T[A.t * 3]];
      for (let j = i + 1; j < bb.length && bb[j].u0 < A.u1; j++) {
        const B = bb[j];
        if (B.v0 >= A.v1 || B.v1 <= A.v0) continue;
        const cb = compOfV[T[B.t * 3]];
        if (ca === cb) continue;
        const na = A.t * 4, nb = B.t * 4;
        if (nrm[na] * nrm[nb] + nrm[na + 1] * nrm[nb + 1] + nrm[na + 2] * nrm[nb + 2] < 0.999) continue;
        if (Math.abs(nrm[na + 3] - nrm[nb + 3]) > 0.005) continue;
        const area = clipArea(A.q, B.q);
        if (area < 0.01) continue;
        const pk = ca < cb ? ca + ':' + cb : cb + ':' + ca;
        if (zfPairs.has(pk)) continue;
        zfPairs.add(pk);
        const p = T[A.t * 3] * 3;
        const bbOf = (c) => [0, 1, 2, 3, 4, 5].map((k) => +(k < 3 ? cMin[c * 3 + k] : cMax[c * 3 + k - 3]).toFixed(2));
        zf.push({ mats: matOf(ca) + '/' + matOf(cb), area: +area.toFixed(3), at: [P[p], P[p + 1], P[p + 2]].map((v) => +v.toFixed(2)), ba: bbOf(ca), bb: bbOf(cb) });
      }
    }
  }
  zf.sort((a, b) => b.area - a.area);
  const zfBy = {};
  for (const z of zf) zfBy[z.mats] = (zfBy[z.mats] || 0) + 1;

  // —— LOD 顶部一致性 ——
  let lodTop = null;
  if (tg.levels && tg.levels.length > 1) {
    const c = new THREE.Vector3();
    tg.lod.getWorldPosition(c);
    const tops = tg.levels.map((lv) => {
      let top = -Infinity;
      const v = new THREE.Vector3();
      lv.updateMatrixWorld(true);
      lv.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh || DECO.has(o.name)) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          if (v.y > top) top = v.y;
        }
      });
      return top;
    });
    const fin = tops.filter(Number.isFinite);
    if (fin.length > 1) lodTop = { tops: tops.map((t) => (Number.isFinite(t) ? +t.toFixed(2) : null)), spread: +(Math.max(...fin) - Math.min(...fin)).toFixed(2) };
  }
  return { tris: nT, comps: nC, nanPos: G.nanPos, badNorm: G.badNorm, floating, pierce, zfight: zf, zfBy, lodTop };
}

// 两个凸多边形（三角形）交集面积（Sutherland–Hodgman）
function clipArea(a, b) {
  const orient = (p) => (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
  const A = orient(a) < 0 ? [a[0], a[2], a[1]] : a, B = orient(b) < 0 ? [b[0], b[2], b[1]] : b;
  let out = A;
  for (let i = 0; i < 3 && out.length; i++) {
    const p = B[i], q = B[(i + 1) % 3];
    const side = (s) => (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]);
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const s = inp[k], e = inp[(k + 1) % inp.length];
      const ss = side(s), se = side(e);
      if (ss >= 0) out.push(s);
      if (ss >= 0 !== se >= 0) {
        const t = ss / (ss - se);
        out.push([s[0] + (e[0] - s[0]) * t, s[1] + (e[1] - s[1]) * t]);
      }
    }
  }
  let ar = 0;
  for (let k = 0; k < out.length; k++) {
    const s = out[k], e = out[(k + 1) % out.length];
    ar += s[0] * e[1] - e[0] * s[1];
  }
  return Math.abs(ar) / 2;
}

// ───────────── heritage26 布局与地形 ─────────────
async function heritageLayout() {
  if (!opt.modules.includes('heritage26')) return null;
  const H = await import('../src/modules/heritage26.js');
  const mod = H.default;
  const { ArchBuilder } = await import('../src/arch/chinese.js');
  const sites = mod.sites || [];
  const res = { sites: sites.length, buildings: 0, overlapPairs: 0, wallCross: 0, outside: 0, buried: 0, floating: 0, maxBuried: 0, maxFloat: 0, list: [] };
  // 院墙：模块导出 siteWall 时以之为准，否则按模块原规则（中小院落、非陵/遗址/俑）
  const wallOf = H.siteWall || ((s) => (s.w <= 260 && s.d <= 360 && !/陵|遗址|俑/.test(s.name) ? { W: s.w / 2, D: s.d / 2 } : null));
  const box = new THREE.Box3();
  for (const s of sites) {
    // 每座建筑单独建 detail 0，取实际几何的平面包围盒（院落局部坐标）
    // 新版模块导出 sitePlan：直接取模块自己的落位结果（full = 含出檐的平面，base = 台基/踏步平面，y/bottom = 落位高与台基补足底）
    const plan = H.sitePlan ? H.sitePlan(ctx, s) : null;
    const fps = plan ? plan.items.map((it) => ({ q: it.q, x0: it.full[0], z0: it.full[1], x1: it.full[2], z1: it.full[3], b: it.base, base: it.y, bottom: it.bottom })) : s.b.map((q) => {
      let x0 = q.x - q.w / 2, x1 = q.x + q.w / 2, z0 = q.z - q.d / 2, z1 = q.z + q.d / 2;
      if (H.building) {
        const b = new ArchBuilder(ctx, { detail: 0, style: 'ming' });
        const warn = console.error;
        console.error = () => {};
        H.building(b, q, 'ming');
        console.error = warn;
        const g = b.build();
        box.setFromObject(g);
        if (Number.isFinite(box.min.x)) ({ x: x0, z: z0 } = box.min), ({ x: x1, z: z1 } = box.max);
        g.traverse((o) => o.geometry?.dispose());
      }
      const pl = H.buildingBase ? H.buildingBase(ctx, s, q, { x0, x1, z0, z1 }) : null;
      return { q, x0, x1, z0, z1, b: [x0, z0, x1, z1], base: pl ? pl.y : null, bottom: pl ? pl.bottom : null };
    });
    s.wall = wallOf(s);
    res.buildings += fps.length;
    const cr = Math.cos(s.rot || 0), sr = Math.sin(s.rot || 0);
    const toW = (lx, lz) => [s.x + lx * cr + lz * sr, s.z - lx * sr + lz * cr];
    const h0 = terrain.heightAt(s.x, s.z);
    for (let i = 0; i < fps.length; i++) {
      const A = fps[i];
      for (let j = i + 1; j < fps.length; j++) {
        const B = fps[j];
        const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0), oz = Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0);
        if (ox > 0.5 && oz > 0.5 && ox * oz > 1) {
          res.overlapPairs++;
          res.list.push({ site: s.name, kind: '重叠', a: A.q.n, b: B.q.n, area: +(ox * oz).toFixed(1) });
        }
      }
      if (s.wall) {
        // 墙 = 矩形四边（厚 0.6），扣掉门洞（gaps）；建筑平面与墙条相交 = 压院墙，完全在墙外 = 出院墙
        const w = s.wall.W !== undefined ? { x0: -s.wall.W, x1: s.wall.W, z0: -s.wall.D, z1: s.wall.D, gaps: [] } : s.wall;
        const t = 0.3;
        const strips = [
          ['S', w.x0, w.z1 - t, w.x1, w.z1 + t, 'x'], ['N', w.x0, w.z0 - t, w.x1, w.z0 + t, 'x'],
          ['E', w.x1 - t, w.z0, w.x1 + t, w.z1, 'z'], ['W', w.x0 - t, w.z0, w.x0 + t, w.z1, 'z'],
        ];
        // 墙从出檐下穿过不算穿插：按台基/踏步平面（离地 0.3 m 以内）判定
        const [bx0, bz0, bx1, bz1] = A.b;
        let hit = false;
        for (const [side, sx0, sz0, sx1, sz1, ax] of strips) {
          const ox0 = Math.max(bx0, sx0), ox1 = Math.min(bx1, sx1), oz0 = Math.max(bz0, sz0), oz1 = Math.min(bz1, sz1);
          if (ox1 <= ox0 + 0.05 || oz1 <= oz0 + 0.05) continue;
          // 交叠段是否全在门洞里
          const a = ax === 'x' ? ox0 : oz0, b = ax === 'x' ? ox1 : oz1;
          const inGap = (w.gaps || []).some((g) => g.side === side && g.a <= a + 0.3 && g.b >= b - 0.3); // 墙头伸进门台基 0.15 m 属对接
          if (!inGap) hit = true;
        }
        const isGate = A.q.type === 'gate' || /门/.test(A.q.n || '');
        if (hit) {
          res.wallCross++;
          res.list.push({ site: s.name, kind: '压院墙', a: A.q.n });
        } else if (!isGate && !(bx0 >= w.x0 && bx1 <= w.x1 && bz0 >= w.z0 && bz1 <= w.z1)) {
          res.outside++;
          res.list.push({ site: s.name, kind: '出院墙', a: A.q.n });
        }
      }
      if (A.q.type === 'mound') continue;
      // 建筑底面（实际放置高度）与自身平面内地形的高差
      const base = A.base ?? h0;
      let gmax = -Infinity, gmin = Infinity;
      const [tx0, tz0, tx1, tz1] = A.b;
      for (const [lx, lz] of [[tx0, tz0], [tx1, tz0], [tx1, tz1], [tx0, tz1], [(tx0 + tx1) / 2, (tz0 + tz1) / 2]]) {
        const g = terrain.heightAt(...toW(lx, lz));
        gmax = Math.max(gmax, g);
        gmin = Math.min(gmin, g);
      }
      const bottom = A.bottom ?? base; // 台基补足后的最低点
      if (gmax - base > TOUCH) {
        res.buried++;
        res.maxBuried = Math.max(res.maxBuried, +(gmax - base).toFixed(2));
        res.list.push({ site: s.name, kind: '埋地', a: A.q.n, d: +(gmax - base).toFixed(2) });
      }
      if (bottom - gmin > TOUCH) {
        res.floating++;
        res.maxFloat = Math.max(res.maxFloat, +(bottom - gmin).toFixed(2));
        res.list.push({ site: s.name, kind: '悬空', a: A.q.n, d: +(bottom - gmin).toFixed(2) });
      }
    }
  }
  return res;
}

// ───────────── 运行 ─────────────
async function main() {
  const targets = await collectTargets();
  const report = { targets: [], totals: { tris: 0, nanPos: 0, badNorm: 0, floating: 0, pierce: 0, zfight: 0, lodTop: 0 } };
  for (const tg of targets) {
    const ts = Date.now();
    let r;
    try {
      r = analyze(tg);
    } catch (e) {
      console.error('[check] 失败', tg.name, e);
      continue;
    }
    const row = { mod: tg.mod, name: tg.name, ...r, ms: Date.now() - ts };
    report.targets.push(row);
    const T = report.totals;
    T.tris += r.tris;
    T.nanPos += r.nanPos;
    T.badNorm += r.badNorm;
    T.floating += r.floating.length;
    T.pierce += r.pierce.length;
    T.zfight += r.zfight.length;
    if (r.lodTop && r.lodTop.spread > TOUCH) T.lodTop++;
    console.error(`[check] ${tg.mod}/${tg.name}: 三角 ${r.tris} 构件 ${r.comps} 悬空 ${r.floating.length} 穿出屋面 ${r.pierce.length} 共面 ${r.zfight.length} NaN ${r.nanPos} 零法线 ${r.badNorm}${r.lodTop ? ' LOD顶差 ' + r.lodTop.spread : ''}（${row.ms} ms）`);
  }
  report.heritage26 = await heritageLayout();

  // —— 输出 ——
  const byMod = {};
  for (const r of report.targets) {
    const m = (byMod[r.mod] ||= { targets: 0, tris: 0, floating: 0, pierce: 0, zfight: 0, nanPos: 0, badNorm: 0, lodTop: 0 });
    m.targets++;
    m.tris += r.tris;
    m.floating += r.floating.length;
    m.pierce += r.pierce.length;
    m.zfight += r.zfight.length;
    m.nanPos += r.nanPos;
    m.badNorm += r.badNorm;
    if (r.lodTop && r.lodTop.spread > TOUCH) m.lodTop++;
  }
  console.log('按模块：');
  console.table(byMod);
  console.log('合计：', JSON.stringify(report.totals));
  if (report.heritage26) {
    const h = report.heritage26;
    console.log(`heritage26：院落 ${h.sites}、建筑 ${h.buildings}｜建筑互相重叠 ${h.overlapPairs} 对、压院墙 ${h.wallCross}、出院墙 ${h.outside}、埋地 ${h.buried}（最深 ${h.maxBuried} m）、悬空 ${h.floating}（最高 ${h.maxFloat} m）`);
  }
  if (opt.list > 0) {
    for (const r of report.targets) {
      const lines = [];
      for (const f of r.floating.slice(0, opt.list)) lines.push(`  悬空 ${f.mats} 构件${f.comps} 三角${f.tris} 间隙${f.gap} bbox ${f.bbox.join(',')}`);
      for (const p of r.pierce.slice(0, opt.list)) lines.push(`  穿出屋面 ${p.mat}→${p.roof} 上${p.above} 下${p.below} @${p.at.join(',')}`);
      for (const z of r.zfight.slice(0, opt.list)) lines.push(`  共面 ${z.mats} ${z.area}m² @${z.at.join(',')}`);
      if (r.zfight.length) lines.push('  共面按材质：' + JSON.stringify(r.zfBy));
      if (r.lodTop && r.lodTop.spread > TOUCH) lines.push(`  LOD 顶部 ${r.lodTop.tops.join(' / ')}`);
      if (lines.length) console.log(`${r.mod}/${r.name}\n${lines.join('\n')}`);
    }
    if (report.heritage26) for (const l of report.heritage26.list.slice(0, opt.list * 4)) console.log('  heritage26', JSON.stringify(l));
  }
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(report, null, 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
