// 地面停车场：OSM amenity=parking（地面式；tools/build_parking.py → public/data/parking.json，全城约 840 处，合计约 4.7 km²）。
// 此前这些地方只有卫星图（机场 T2 陆侧、商场、医院、景区停车场近看是一张糊照片：车、车棚贴在地上，审查 g9 P1）。
//
// 做法（只在相机 1.6 km 内、按 600 m 分格流式生成，离开后卸载）：
//   · 沥青地面：多边形三角剖分、细分到 ≤ 5 m 贴地（深灰带轻微斑驳），外圈路缘石；
//   · 车位：按多边形最长边方向排成“双排车位 + 6 m 通道”的模块（2.5 × 5.3 m），白线；车位四角都在多边形内、不压楼才画；
//   · 停放车辆：占用率 40~75%（每块地随机，一端略满），实例化简模（下车身 + 机盖尾箱 + 斜风挡座舱 + 车顶 + 灯带 + 四轮），
//     车身颜色按真实分布（白/黑/银灰为主）；双排车位两端绿化岛（路缘 + 绿篱）；
//   · 灯杆：沿通道每 ~30 m 一根，夜间灯头发光，少量真实点光源。
// 跳过：精建模块已登记“通用建筑让位”的地块（街景片区停车场、地标广场等），以及住宅/校园用地内的（由小区模块负责）。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';
import { ObjectBatcher, MatTable, hasMultiDraw } from '../core/util.js';

const CELL = 600, NEAR = 1600, FAR = 1900;
const CAR_LOD = 150; // 停放车辆细模只画相机 150 m 内（机场等大车场上万辆车，全用细模三角形会多出一百多万）
const STALL_W = 2.5, STALL_D = 5.3, AISLE = 6.0, MOD = STALL_D * 2 + AISLE;
const CAR_COLORS = [
  ['#e8e8e6', 0.32], ['#1c1d20', 0.2], ['#9a9da2', 0.14], ['#c3c6ca', 0.1], ['#3a4250', 0.06], ['#7a1e22', 0.05],
  ['#1f3a68', 0.05], ['#5b5f4a', 0.03], ['#b08d57', 0.03], ['#2d5a3c', 0.02],
];

function pip(x, z, p) {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
  }
  return c;
}
function bbox(p) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
  }
  return { x0, x1, z0, z1 };
}
function area(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return Math.abs(a / 2);
}
const hash = (a, b, s = 0) => { const v = Math.sin(a * 12.9898 + b * 78.233 + s * 37.719) * 43758.5453; return v - Math.floor(v); };
function pickColor(h) {
  let acc = 0;
  for (const [c, w] of CAR_COLORS) { acc += w; if (h < acc) return c; }
  return CAR_COLORS[0][0];
}

/**
 * 停放车辆简模（车头朝 +x，原点在车底中心，约 120 个三角形）：下车身（离地 0.33 m，露出四个车轮）、前低后高的机盖/尾箱、
 * 斜风挡座舱（深色车窗）+ 车顶板、前白后红的灯带、四个六棱轮胎。车身与车顶由实例色染，车窗/轮胎/灯固定色。
 */
function carGeometry() {
  const parts = [];
  const colAttr = (g, col) => {
    const c = new THREE.Color(col);
    const cols = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < cols.length; i += 3) { cols[i] = c.r; cols[i + 1] = c.g; cols[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    parts.push(g);
  };
  const add = (w, h, d, x, y, z, col, bevel = 0) => {
    const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1).toNonIndexed();
    if (bevel) {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) { p.setX(i, p.getX(i) * (1 - bevel / w * 2)); p.setZ(i, p.getZ(i) * (1 - bevel / d * 2)); }
    }
    g.translate(x, y, z);
    colAttr(g, col);
  };
  // 梯形棱柱（沿 x 的截面：底长 lb、顶长 lt、顶相对底沿 x 平移 sx；宽 wb→wt），y0~y1
  const prism = (lb, lt, sx, wb, wt, y0, y1, x, col) => {
    const B = [[-lb / 2, y0, -wb / 2], [lb / 2, y0, -wb / 2], [lb / 2, y0, wb / 2], [-lb / 2, y0, wb / 2]];
    const T = [[-lt / 2 + sx, y1, -wt / 2], [lt / 2 + sx, y1, -wt / 2], [lt / 2 + sx, y1, wt / 2], [-lt / 2 + sx, y1, wt / 2]];
    const pos = [];
    const quad = (a, b2, c, d) => { for (const p of [a, b2, c, a, c, d]) pos.push(p[0] + x, p[1], p[2]); };
    quad(T[0], T[3], T[2], T[1]); // 顶
    quad(B[1], B[0], T[0], T[1]); // -z 侧
    quad(B[3], B[2], T[2], T[3]); // +z 侧
    quad(B[2], B[1], T[1], T[2]); // +x（前风挡）
    quad(B[0], B[3], T[3], T[0]); // -x（后窗）
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    colAttr(g, col);
  };
  add(4.46, 0.5, 1.78, 0, 0.6, 0, '#ffffff', 0.05); // 下车身（实例色，离地 0.35）
  prism(1.55, 1.4, -0.05, 1.74, 1.7, 0.85, 0.97, 1.42, '#ffffff'); // 机盖（前低）
  prism(1.0, 0.9, 0.0, 1.74, 1.7, 0.85, 1.03, -1.75, '#ffffff'); // 尾箱
  prism(2.75, 1.55, -0.28, 1.68, 1.36, 0.85, 1.4, -0.25, '#1d2329'); // 座舱（深色车窗，前后斜）
  add(1.5, 0.05, 1.32, -0.28, 1.41, 0, '#ffffff', 0.08); // 车顶板（实例色）
  add(0.04, 0.09, 1.5, 2.215, 0.78, 0, '#e8ecef'); // 前灯带
  add(0.04, 0.08, 1.5, -2.215, 0.8, 0, '#8a1010'); // 尾灯带
  // 轮胎：八棱柱，每侧两个
  for (const x of [1.4, -1.36]) for (const sd of [1, -1]) {
    const g = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 8, 1, false).toNonIndexed();
    g.rotateX(Math.PI / 2);
    g.translate(x, 0.33, sd * 0.78);
    colAttr(g, '#151515');
  }
  const g = mergeNonIndexed(parts);
  g.computeVertexNormals();
  return g;
}
/** 远处停放车辆简模（约 46 个三角形）：车身、深色座舱、每轴一块轮子 */
function carGeometryLo() {
  const parts = [];
  const add = (w, h, d, x, y, z, col) => {
    const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1).toNonIndexed();
    g.translate(x, y, z);
    const c = new THREE.Color(col);
    const cols = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < cols.length; i += 3) { cols[i] = c.r; cols[i + 1] = c.g; cols[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    parts.push(g);
  };
  add(4.46, 0.62, 1.78, 0, 0.66, 0, '#ffffff');
  add(2.4, 0.5, 1.5, -0.25, 1.2, 0, '#1d2329');
  for (const x of [1.4, -1.36]) add(0.66, 0.66, 1.72, x, 0.33, 0, '#151515');
  const g = mergeNonIndexed(parts);
  g.computeVertexNormals();
  return g;
}
function mergeNonIndexed(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export default {
  id: 'parking',
  name: '地面停车场',
  async prepare(ctx) {
    const raw = await loadJSON('parking.json', { optional: true });
    const lots = [];
    const lu = ctx.data.landuse?.polys || [];
    const res = lu.filter((f) => (f.k === 'residential' || f.k === 'university') && f.outer && f.outer.length >= 6).map((f) => ({ p: f.outer, bb: bbox(f.outer) }));
    const inRes = (x, z) => res.some((r) => x >= r.bb.x0 && x <= r.bb.x1 && z >= r.bb.z0 && z <= r.bb.z1 && pip(x, z, r.p));
    for (const L of raw?.lots || []) {
      const p = L.p;
      if (!p || p.length < 6) continue;
      const a = area(p);
      if (a < 250) continue; // 路边几个车位的小块不画（影像就够了）
      const b = bbox(p);
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      if (ctx.exclusions.test(cx, cz, 'buildings', 0)) continue; // 精建区（街景片区停车场、地标广场）
      if (inRes(cx, cz)) continue; // 小区/校园内由小区模块负责
      lots.push({ p, bb: b, a, cx, cz, name: L.n || '' });
    }
    // 停车场内不种树（OSM 绿地多边形常把停车场包进去）
    for (const L of lots) ctx.exclusions.add({ points: L.p, name: 'parking' }, { buildings: false, trees: true, pois: false });
    this.lots = lots;
  },

  build(ctx) {
    const lots = this.lots || [];
    const root = new THREE.Group();
    root.name = '地面停车场';
    ctx.scene.add(root);
    const T = ctx.terrain;
    // 格网索引
    const grid = new Map();
    for (let i = 0; i < lots.length; i++) {
      const b = lots[i].bb;
      for (let gx = Math.floor(b.x0 / CELL); gx <= Math.floor(b.x1 / CELL); gx++)
        for (let gz = Math.floor(b.z0 / CELL); gz <= Math.floor(b.z1 / CELL); gz++) {
          const k = gx + ',' + gz;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
    }
    // 通用建筑轮廓（车位不压楼）：按需解析相机附近的楼
    const B = ctx.data.buildings;
    let bldIdx = null;
    const buildingsNear = (b) => {
      if (!B) return [];
      if (!bldIdx) {
        const dv = new DataView(B);
        const ver = dv.getUint32(4, true), N = dv.getUint32(8, true);
        let o = 16;
        const ax = new Float32Array(B, o, N); o += N * 4;
        const az = new Float32Array(B, o, N); o += N * 4;
        const vs = new Uint32Array(B, o, N); o += N * 4;
        const vc = new Uint16Array(B, o, N); o += N * 2;
        o += N * 4; // h, minh
        const kind = new Uint8Array(B, o, N); o += N;
        const flags = new Uint8Array(B, o, N); o += N;
        o += ver >= 2 ? N : 0;
        o += (4 - (o % 4)) % 4;
        bldIdx = { ax, az, vs, vc, flags, offs: new Int16Array(B, o), N };
      }
      const { ax, az, vs, vc, flags, offs, N } = bldIdx;
      const out = [];
      for (let i = 0; i < N; i++) {
        if (ax[i] < b.x0 - 80 || ax[i] > b.x1 + 80 || az[i] < b.z0 - 80 || az[i] > b.z1 + 80) continue;
        if (flags[i] & 128) continue;
        const p = [];
        for (let k = vs[i] * 2, e = k + vc[i] * 2; k < e; k += 2) p.push(ax[i] + offs[k] * 0.1, az[i] + offs[k + 1] * 0.1);
        out.push({ p, bb: bbox(p) });
      }
      return out;
    };

    // —— 材质与共享几何 ——
    const matGround = ctx.overlay(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }), 0.0009);
    const matLine = ctx.overlay(new THREE.MeshStandardMaterial({ color: 0xd8d8d2, roughness: 0.8 }), 0.0011);
    const matCar = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.35 });
    const matCurb = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    const matIsland = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    // 绿化岛：1.4 m 宽、两排车位深（10.6 m）的路缘石框 + 绿篱（本地 +x 沿车位深度方向）
    const islandGeo = (() => {
      const list = [];
      const box = (w, h, d, y, col) => {
        const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
        g.translate(0, y, 0);
        const c = new THREE.Color(col), a = new Float32Array(g.attributes.position.count * 3);
        for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(a, 3));
        list.push(g);
      };
      box(STALL_D * 2, 0.2, 1.4, 0.05, '#8a8884');
      box(STALL_D * 2 - 0.5, 0.62, 0.95, 0.42, '#3f5a2c');
      const g = mergeNonIndexed(list);
      g.computeVertexNormals();
      return g;
    })();
    const matPole = new THREE.MeshStandardMaterial({ color: 0x6f7378, roughness: 0.6, metalness: 0.5 });
    const matLamp = new THREE.MeshStandardMaterial({ color: 0xf2efe6, emissive: 0xffe6bf, emissiveIntensity: 0 });
    ctx.night.register(matLamp, { day: 0, night: 1.8 });
    const carGeo = carGeometry(), carGeoLo = carGeometryLo();
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 9, 6).translate(0, 4.5, 0);
    const headGeo = new THREE.BoxGeometry(0.9, 0.18, 0.35).translate(0, 9, 0);
    const lampTable = new MatTable('parking.matTable');
    const poleLampMat = lampTable.material(matPole);
    const poleLampGeo = (() => {
      const parts = [[poleGeo, lampTable.index(matPole)], [headGeo, lampTable.index(matLamp)]].map(([g0, row]) => {
        const g = g0.toNonIndexed();
        g.setAttribute('aMt', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(row), 1));
        return g;
      });
      const n = parts.reduce((a, g) => a + g.attributes.position.count, 0);
      const out = new THREE.BufferGeometry();
      for (const [k, size] of [['position', 3], ['normal', 3], ['uv', 2], ['aMt', 1]]) {
        const arr = new Float32Array(n * size);
        let o = 0;
        for (const g of parts) { arr.set(g.attributes[k].array, o); o += g.attributes[k].array.length; }
        out.setAttribute(k, new THREE.BufferAttribute(arr, size));
      }
      return out;
    })();
    lampTable.build();

    const built = new Map(); // 格键 → { group, lights[] }
    // 每格的地面/路缘石/车位线：原先每块停车场各一个网格（大唐不夜城夜景 30 块地 → 74 次绘制），
    // 现按格、按材质各合成一个 BatchedMesh（逐块地仍做视锥裁剪，三角形不变多）
    let obGround = null, obLine = null;
    const multiDraw = hasMultiDraw(ctx.renderer); // 不支持多重绘制时退回每格每材质一个普通网格
    const buildLot = (L, group, lights) => {
      const { p, bb } = L;
      const blds = buildingsNear(bb);
      const inBld = (x, z) => blds.some((q) => x >= q.bb.x0 && x <= q.bb.x1 && z >= q.bb.z0 && z <= q.bb.z1 && pip(x, z, q.p));
      // 最长边方向
      let best = 0, ux = 1, uz = 0;
      for (let i = 0; i < p.length; i += 2) {
        const j = (i + 2) % p.length, dx = p[j] - p[i], dz = p[j + 1] - p[i + 1], l = Math.hypot(dx, dz);
        if (l > best) { best = l; ux = dx / l; uz = dz / l; }
      }
      const vx = -uz, vz = ux;
      // 局部坐标范围
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        const u = p[i] * ux + p[i + 1] * uz, v = p[i] * vx + p[i + 1] * vz;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const W = (u, v) => [u * ux + v * vx, u * uz + v * vz];
      const H = (x, z) => T.heightAt(x, z);
      // 地面：多边形三角剖分后按边长细分到 ≤ 5 m（顶点贴地），边缘沿真实轮廓（不再是 2 m 网格的锯齿边）；
      // 外圈一道 0.2 m 宽、高 0.12 m 的浅灰路缘石
      const seed = L.cx * 0.13 + L.cz * 0.07;
      const ring = [];
      for (let i = 0; i < p.length; i += 2) ring.push(new THREE.Vector2(p[i], p[i + 1]));
      if (THREE.ShapeUtils.isClockWise(ring)) ring.reverse();
      const tris = THREE.ShapeUtils.triangulateShape(ring, []);
      const gp = [], gc = [];
      // 沥青反照率与道路路面相近（约 0.08）：白色车位线才有对比度（原 0.2 被阳光照成浅灰，车位线看不出来）
      const tone = (x, z) => { const n = 0.86 + 0.14 * hash(Math.floor(x / 6), Math.floor(z / 6), seed) + 0.05 * hash(Math.floor(x), Math.floor(z), 3); return [0.082 * n, 0.083 * n, 0.088 * n]; };
      const emit = (a, b2, c, depth) => {
        const lab = Math.hypot(a[0] - b2[0], a[1] - b2[1]), lbc = Math.hypot(b2[0] - c[0], b2[1] - c[1]), lca = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (depth < 9 && Math.max(lab, lbc, lca) > 5) {
          const m = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
          const ab = m(a, b2), bc = m(b2, c), ca = m(c, a);
          emit(a, ab, ca, depth + 1); emit(ab, b2, bc, depth + 1); emit(ca, bc, c, depth + 1); emit(ab, bc, ca, depth + 1);
          return;
        }
        // 三角剖分是逆时针（x 东 z 南俯视）：翻成朝上的绕序
        for (const q of [a, c, b2]) { gp.push(q[0], H(q[0], q[1]) + 0.05, q[1]); gc.push(...tone(q[0], q[1])); }
      };
      for (const [i0, i1, i2] of tris) emit([ring[i0].x, ring[i0].y], [ring[i1].x, ring[i1].y], [ring[i2].x, ring[i2].y], 0);
      // 路缘石：沿轮廓每 4 m 一节（顶面 + 外立面）
      const cp = [], cc = [];
      const CURB = [0.46, 0.455, 0.44];
      const nR = ring.length;
      for (let i = 0; i < nR; i++) {
        const A = ring[i], Bq = ring[(i + 1) % nR];
        const dx = Bq.x - A.x, dz = Bq.y - A.y, l = Math.hypot(dx, dz);
        if (l < 0.05) continue;
        const ox = dz / l * 0.2, oz = -dx / l * 0.2; // 外法线（逆时针轮廓的右侧）× 0.2
        const k = Math.max(1, Math.ceil(l / 4));
        for (let j = 0; j < k; j++) {
          const x0 = A.x + (dx * j) / k, z0 = A.y + (dz * j) / k, x1 = A.x + (dx * (j + 1)) / k, z1 = A.y + (dz * (j + 1)) / k;
          const y0 = H(x0, z0), y1 = H(x1, z1);
          const i0 = [x0, y0 + 0.17, z0], i1 = [x1, y1 + 0.17, z1], o0 = [x0 + ox, y0 + 0.17, z0 + oz], o1 = [x1 + ox, y1 + 0.17, z1 + oz];
          const g0 = [x0 + ox, y0 - 0.05, z0 + oz], g1 = [x1 + ox, y1 - 0.05, z1 + oz];
          for (const q of [i0, i1, o1, i0, o1, o0, o0, o1, g1, o0, g1, g0]) { cp.push(...q); cc.push(...CURB); }
        }
      }
      if (gp.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(gc, 3));
        g.computeVertexNormals();
        obGround.add(g, matGround);
      }
      if (cp.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
        g.computeVertexNormals();
        obGround.add(g, matCurb);
      }
      // 车位：沿 v 方向排模块（双排 + 通道），沿 u 方向排车位
      const lp = [];
      const cars = [];
      const poles = [];
      const islands = [];
      // 停放率 40~75%（每块地随机；离入口/航站楼近的一端略满）：车位线在车间看得见
      const occ0 = 0.4 + 0.35 * hash(L.cx, L.cz, 7);
      const line = (a, b, w = 0.12) => {
        const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * w / 2, nz = (dx / l) * w / 2;
        const q = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]].map(([x, z]) => [x, H(x, z) + 0.07, z]);
        for (const k of [0, 2, 1, 0, 3, 2]) lp.push(...q[k]);
      };
      for (let v = v0 + 1.5; v + STALL_D * 2 <= v1 - 1; v += MOD) {
        let uMin = Infinity, uMax = -Infinity;
        for (const [vs, dir] of [[v, 1], [v + STALL_D, -1]]) {
          let rowAny = false;
          for (let u = u0 + 1.5; u + STALL_W <= u1 - 1.5; u += STALL_W) {
            const corners = [W(u, vs), W(u + STALL_W, vs), W(u + STALL_W, vs + STALL_D), W(u, vs + STALL_D)];
            if (!corners.every(([x, z]) => pip(x, z, p))) continue;
            const [cx, cz] = W(u + STALL_W / 2, vs + STALL_D / 2);
            if (inBld(cx, cz)) continue;
            rowAny = true;
            uMin = Math.min(uMin, u); uMax = Math.max(uMax, u + STALL_W);
            line(W(u, vs), W(u, vs + STALL_D));
            line(W(u + STALL_W, vs), W(u + STALL_W, vs + STALL_D));
            // 车位底线（靠通道一侧不画，靠背一侧画）
            const back = dir === 1 ? vs : vs + STALL_D;
            line(W(u, back), W(u + STALL_W, back));
            const occ = occ0 + 0.18 * (0.5 - (u - u0) / Math.max(1, u1 - u0)) + 0.12 * (hash(Math.floor(u / 12), vs, seed + 5) - 0.5);
            if (hash(u, vs, seed) < occ) {
              const yaw = Math.atan2(vz * dir, vx * dir); // 车头朝通道（-dir 的对侧）……按车位朝向
              const jitter = (hash(u, vs, 11) - 0.5) * 0.25;
              cars.push([cx + vx * jitter * dir, H(cx, cz), cz + vz * jitter * dir, yaw + (hash(u, vs, 13) < 0.5 ? 0 : Math.PI) + (hash(u, vs, 17) - 0.5) * 0.06, hash(u, vs, 19)]);
            }
          }
          if (rowAny && dir === -1 && uMax - uMin > 12) {
            // 双排车位两端的绿化岛（路缘 + 绿篱），以及每 ~40 m 一道把长排车位隔开的岛
            const isl = (uc) => {
              const [x, z] = W(uc, v + STALL_D);
              if (pip(x, z, p) && !inBld(x, z)) islands.push([x, H(x, z), z, Math.atan2(vz, vx)]);
            };
            isl(uMin - 0.8);
            isl(uMax + 0.8);
          }
          if (rowAny && dir === -1) {
            // 通道中线上每 30 m 一根灯杆（只在有车位的模块旁）
            for (let u = u0 + 12; u < u1 - 8; u += 30) {
              const [x, z] = W(u, v + STALL_D * 2 + AISLE * 0.5);
              if (pip(x, z, p) && !inBld(x, z)) poles.push([x, H(x, z), z]);
            }
          }
        }
      }
      if (lp.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
        g.computeVertexNormals();
        obLine.add(g, matLine);
      }
      return { cars, poles, islands };
    };

    const splitCars = (P) => {
      const x = cam.position.x, z = cam.position.z, r2 = CAR_LOD * CAR_LOD;
      let nh = 0, nl = 0;
      const H = P.hi.instanceMatrix.array, Hc = P.hi.instanceColor.array, Lm = P.lo.instanceMatrix.array, Lc = P.lo.instanceColor.array;
      for (let k = 0; k < P.n; k++) {
        const dx = P.xz[k * 2] - x, dz = P.xz[k * 2 + 1] - z;
        const m = P.mats.subarray(k * 16, k * 16 + 16), c = P.cols.subarray(k * 3, k * 3 + 3);
        if (dx * dx + dz * dz < r2) { H.set(m, nh * 16); Hc.set(c, nh * 3); nh++; }
        else { Lm.set(m, nl * 16); Lc.set(c, nl * 3); nl++; }
      }
      for (const [im, cnt] of [[P.hi, nh], [P.lo, nl]]) {
        im.count = cnt;
        im.visible = cnt > 0;
        im.instanceMatrix.needsUpdate = true;
        im.instanceColor.needsUpdate = true;
        if (cnt) im.computeBoundingSphere();
      }
      P.at = [x, z];
    };
    const buildCell = (key) => {
      const ids = grid.get(key) || [];
      const group = new THREE.Group();
      const allCars = [], allPoles = [], allIslands = [], lights = [];
      obGround = new ObjectBatcher({ multiDraw });
      obLine = new ObjectBatcher({ multiDraw });
      for (const i of ids) {
        const L = lots[i];
        // 跨格的停车场只在它中心所在的格里建
        if (Math.floor(L.cx / CELL) + ',' + Math.floor(L.cz / CELL) !== key) continue;
        const r = buildLot(L, group, lights);
        allCars.push(...r.cars);
        allPoles.push(...r.poles);
        allIslands.push(...r.islands);
      }
      group.add(obGround.build({ castShadow: false, receiveShadow: true, name: '地面' }).group);
      group.add(obLine.build({ castShadow: false, receiveShadow: false, name: '车位线' }).group);
      obGround = obLine = null;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), pv = new THREE.Vector3();
      let carPool = null;
      if (allCars.length) {
        // 细模/简模两个实例池；矩阵与颜色先算好，相机移动时按距离重分（splitCars）
        const n = allCars.length;
        const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3), xz = new Float32Array(n * 2);
        const c = new THREE.Color();
        allCars.forEach(([x, y, z, yaw, h], k) => {
          q.setFromAxisAngle(up, -yaw);
          m4.compose(pv.set(x, y + 0.02, z), q, s1).toArray(mats, k * 16);
          c.set(pickColor(h)).toArray(cols, k * 3);
          xz[k * 2] = x; xz[k * 2 + 1] = z;
        });
        const mk = (geo) => {
          const im = new THREE.InstancedMesh(geo, matCar, n);
          im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
          im.castShadow = true;
          im.receiveShadow = true;
          group.add(im);
          return im;
        };
        carPool = { n, mats, cols, xz, hi: mk(carGeo), lo: mk(carGeoLo), at: null };
        splitCars(carPool);
      }
      if (allIslands.length) {
        const im = new THREE.InstancedMesh(islandGeo, matIsland, allIslands.length);
        allIslands.forEach(([x, y, z, yaw], k) => {
          q.setFromAxisAngle(up, -yaw);
          im.setMatrixAt(k, m4.compose(pv.set(x, y, z), q, s1));
        });
        im.castShadow = true;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        group.add(im);
      }
      if (allPoles.length) {
        // 灯杆与灯头：同一组实例矩阵，几何合一、材质走参数表（灯头夜间发光照常由 matLamp 驱动），一次绘制（原两次）
        const pm = new THREE.InstancedMesh(poleLampGeo, poleLampMat, allPoles.length);
        allPoles.forEach(([x, y, z], k) => {
          m4.makeTranslation(x, y, z);
          pm.setMatrixAt(k, m4);
        });
        pm.computeBoundingSphere();
        group.add(pm);
        for (let k = 0; k < allPoles.length; k += 4) {
          const [x, y, z] = allPoles[k];
          lights.push(ctx.lights.add({ position: new THREE.Vector3(x, y + 8.6, z), color: 0xffe2b8, intensity: 260, distance: 30, nightOnly: true, priority: 0.35 }));
        }
      }
      root.add(group);
      return { group, lights, cars: allCars.length, carPool };
    };
    const disposeCell = (c) => {
      root.remove(c.group);
      c.group.traverse((o) => { if (o.geometry && o.geometry !== carGeo && o.geometry !== carGeoLo && o.geometry !== poleLampGeo && o.geometry !== islandGeo) o.geometry.dispose(); if (o.isInstancedMesh || o.isBatchedMesh) o.dispose(); });
      for (const l of c.lights) if (ctx.lights.remove) ctx.lights.remove(l); else l.enabled = false;
    };

    const cam = ctx.camera;
    let frame = 0, pending = [];
    const refresh = () => {
      const x = cam.position.x, z = cam.position.z;
      const agl = cam.position.y - T.heightAt(x, z);
      const near = agl < 600 ? NEAR : 0; // 高空俯视不画（看不清，只是负担）
      const want = new Set();
      if (near > 0)
        for (let gx = Math.floor((x - near) / CELL); gx <= Math.floor((x + near) / CELL); gx++)
          for (let gz = Math.floor((z - near) / CELL); gz <= Math.floor((z + near) / CELL); gz++) {
            const cx = (gx + 0.5) * CELL, cz = (gz + 0.5) * CELL;
            if (Math.hypot(cx - x, cz - z) < near + CELL * 0.71 && grid.has(gx + ',' + gz)) want.add(gx + ',' + gz);
          }
      for (const [k, c] of built) {
        const [gx, gz] = k.split(',').map(Number);
        const cx = (gx + 0.5) * CELL, cz = (gz + 0.5) * CELL;
        if (!want.has(k) && (near === 0 || Math.hypot(cx - x, cz - z) > FAR + CELL)) { disposeCell(c); built.delete(k); }
      }
      // 相机移动超过 10 m 的格重分细模/简模
      for (const c of built.values()) {
        const P = c.carPool;
        if (P && Math.hypot(P.at[0] - x, P.at[1] - z) > 10) splitCars(P);
      }
      pending = [...want].filter((k) => !built.has(k)).sort((a, b) => {
        const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number);
        return Math.hypot((ax + 0.5) * CELL - x, (az + 0.5) * CELL - z) - Math.hypot((bx + 0.5) * CELL - x, (bz + 0.5) * CELL - z);
      });
    };
    refresh();
    // 首帧前把相机所在格先建好（截图/预设视角直接可见）
    for (let i = 0; i < 4 && pending.length; i++) { const k = pending.shift(); built.set(k, buildCell(k)); }
    console.warn(`[parking] 地面停车场 ${lots.length} 处（OSM），首批 ${built.size} 格`);
    return {
      update() {
        lampTable.update();
        if ((++frame & 15) === 0) refresh();
        if (pending.length) { const k = pending.shift(); if (!built.has(k)) built.set(k, buildCell(k)); } // 每帧至多建一格
      },
      busy: () => pending.length > 0,
      stats: () => ({ lots: lots.length, cells: built.size, pending: pending.length, cars: [...built.values()].reduce((s, c) => s + c.cars, 0) }),
      setLayer(layer, v) { if (layer === 'buildings') root.visible = v; },
      dispose() { for (const c of built.values()) disposeCell(c); built.clear(); ctx.scene.remove(root); },
    };
  },
};
