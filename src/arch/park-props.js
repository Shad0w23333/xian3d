// 公园近景：实例化小品的几何（顶点色）与全局实例池。
//
// 尺度参考（西安兴庆宫公园 / 环城公园 / 革命公园实景与市政常用规格）：
//   · 庭院灯：总高 3.6 m，黑色铝合金方灯头（中式灯笼形，0.34×0.34×0.48 m，四角立柱 + 四坡小顶），暖白 2700 K；
//   · 座椅：1.8 m 长、座高 0.44 m、座深 0.42 m，铸铁扶手腿 + 防腐木条（座 5 条、靠背 3 条，靠背后仰 15°）；
//   · 分类垃圾桶：双桶（可回收物 蓝 / 其他垃圾 灰），0.4×0.35×0.85 m，带顶盖与投口；
//   · 汉白玉栏杆：望柱 0.2 m 见方、高 1.05 m（含柱头），栏板高 0.62 m、寻杖扶手高 0.9 m，跨距约 2 m；
//   · 河堤金属护栏：高 1.1 m，三道横杆 + 竖向栏杆，柱距 2.5 m；
//   · 树池环凳：外径 2.7 m 的八角形木凳，座高 0.45 m。
// 全局实例池：每种小品一个 InstancedMesh（全部已加载块的实例拼在一起，块集合变化时重填），draw call 与块数无关。
import * as THREE from 'three';

const _col = new THREE.Color();
function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  _col.set(hex);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
function merge(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
const box = (w, h, d, x, y, z, hex, rx = 0, ry = 0, rz = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return colored(g, hex);
};
const cyl = (r0, r1, h, seg, x, y, z, hex, rz = 0, rx = 0) => {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg, 1);
  if (rz || rx) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, 0, rz)));
  g.translate(x, y, z);
  return colored(g, hex);
};

// —— 庭院灯 ——
const LAMP_BLACK = '#232527';
export function lampPoleGeometry() {
  const p = [];
  p.push(box(0.32, 0.3, 0.32, 0, 0.15, 0, '#3a3c3e')); // 混凝土/铸铁底座
  p.push(cyl(0.07, 0.085, 2.9, 6, 0, 1.75, 0, LAMP_BLACK));
  p.push(cyl(0.09, 0.09, 0.08, 6, 0, 3.2, 0, LAMP_BLACK)); // 灯头托
  p.push(box(0.4, 0.04, 0.4, 0, 3.26, 0, LAMP_BLACK)); // 底框
  for (const [x, z] of [[-0.17, -0.17], [0.17, -0.17], [0.17, 0.17], [-0.17, 0.17]]) p.push(box(0.035, 0.48, 0.035, x, 3.52, z, LAMP_BLACK));
  p.push(box(0.46, 0.04, 0.46, 0, 3.77, 0, LAMP_BLACK)); // 顶框
  const roof = new THREE.ConeGeometry(0.36, 0.2, 4, 1);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, 3.89, 0);
  p.push(colored(roof, LAMP_BLACK));
  p.push(cyl(0.025, 0.04, 0.1, 4, 0, 4.03, 0, LAMP_BLACK));
  return merge(p);
}
export function lampGlassGeometry() {
  return merge([box(0.31, 0.44, 0.31, 0, 3.52, 0, '#fff4dc')]);
}

// —— 座椅（正面朝 +Z，靠背在 −Z）——
export function benchGeometry() {
  const p = [];
  const wood = '#8c5a33', iron = '#2b2d2f';
  for (const x of [-0.78, 0.78]) {
    // 铸铁端架：前腿、后腿（连靠背立柱）、座撑、扶手
    p.push(box(0.06, 0.44, 0.06, x, 0.22, 0.17, iron));
    p.push(box(0.06, 0.86, 0.06, x, 0.43, -0.2, iron, -0.12));
    p.push(box(0.06, 0.05, 0.46, x, 0.42, -0.01, iron));
    p.push(box(0.07, 0.04, 0.4, x, 0.66, 0.02, iron));
    p.push(box(0.05, 0.24, 0.05, x, 0.54, 0.2, iron));
  }
  for (let i = 0; i < 5; i++) p.push(box(1.8, 0.035, 0.07, 0, 0.455, 0.18 - i * 0.085, wood));
  for (let i = 0; i < 3; i++) p.push(box(1.8, 0.08, 0.03, 0, 0.6 + i * 0.12, -0.22 - i * 0.03, wood, -0.26));
  return merge(p);
}

// —— 分类垃圾桶（双桶，正面朝 +Z）——
export function binGeometry() {
  const p = [];
  p.push(box(0.92, 0.06, 0.4, 0, 0.03, 0, '#2b2d2f'));
  for (const [x, c] of [[-0.22, '#1f5fa8'], [0.22, '#5d6163']]) {
    p.push(box(0.4, 0.74, 0.36, x, 0.43, 0, c));
    p.push(box(0.42, 0.06, 0.38, x, 0.83, 0, '#2b2d2f'));
    p.push(box(0.2, 0.08, 0.02, x, 0.68, 0.185, '#151617')); // 投口
    p.push(box(0.3, 0.12, 0.012, x, 0.48, 0.183, '#f2f2ee')); // 标识贴
  }
  return merge(p);
}

// —— 汉白玉栏杆：望柱（原点 = 柱底中心）与栏板（沿 +X 跨 1 m，实例缩放到跨距）——
const MARBLE = '#e4dfd4';
export function balusterPostGeometry() {
  const p = [];
  p.push(box(0.2, 0.86, 0.2, 0, 0.43, 0, MARBLE));
  p.push(box(0.24, 0.06, 0.24, 0, 0.89, 0, '#d8d2c6'));
  const cap = new THREE.CylinderGeometry(0.075, 0.1, 0.12, 6);
  cap.translate(0, 0.98, 0);
  p.push(colored(cap, MARBLE));
  const ball = new THREE.SphereGeometry(0.085, 6, 4);
  ball.translate(0, 1.1, 0);
  p.push(colored(ball, MARBLE));
  return merge(p);
}
export function balusterPanelGeometry() {
  // 0..1 沿 X；地栿 + 下枋 + 中枋 + 三根小立柱 + 两块板心浅浮雕 + 寻杖扶手（方截面）
  const p = [];
  p.push(box(1, 0.14, 0.18, 0.5, 0.07, 0, '#d4cec2'));
  p.push(box(1, 0.07, 0.08, 0.5, 0.175, 0, MARBLE));
  p.push(box(1, 0.06, 0.08, 0.5, 0.6, 0, MARBLE));
  for (const x of [0.06, 0.5, 0.94]) p.push(box(0.06, 0.37, 0.07, x, 0.395, 0, MARBLE));
  p.push(box(0.38, 0.3, 0.025, 0.28, 0.39, 0, '#cdc6b9'));
  p.push(box(0.38, 0.3, 0.025, 0.72, 0.39, 0, '#cdc6b9'));
  for (const x of [0.28, 0.72]) p.push(box(0.08, 0.24, 0.07, x, 0.75, 0, MARBLE)); // 净瓶（方）
  p.push(box(1, 0.08, 0.09, 0.5, 0.88, 0, MARBLE));
  return merge(p);
}

// —— 金属护栏段（沿 +X 跨 1 m；颜色由实例色给出：河堤不锈钢灰、亲水平台木扶手棕）——
export function metalRailGeometry() {
  const p = [];
  p.push(box(0.07, 1.1, 0.07, 0, 0.55, 0, '#ffffff'));
  p.push(box(1, 0.06, 0.06, 0.5, 1.07, 0, '#ffffff'));
  p.push(box(1, 0.04, 0.04, 0.5, 0.6, 0, '#e8e8e8'));
  p.push(box(1, 0.04, 0.04, 0.5, 0.14, 0, '#e8e8e8'));
  for (let i = 1; i < 8; i++) p.push(box(0.022, 0.46, 0.022, i / 8, 0.37, 0, '#dcdcdc'));
  return merge(p);
}

// —— 树池环凳（八角）——
export function ringBenchGeometry() {
  const p = [];
  const R0 = 0.82, R1 = 1.34, N = 8;
  for (let i = 0; i < N; i++) {
    const a = ((i + 0.5) / N) * Math.PI * 2;
    const rm = (R0 + R1) / 2, w = 2 * R1 * Math.tan(Math.PI / N) * 0.98;
    p.push(box(w * 0.86, 0.06, R1 - R0, Math.cos(a) * rm, 0.44, Math.sin(a) * rm, '#8c5a33', 0, -a + Math.PI / 2));
    p.push(box(w * 0.7, 0.4, 0.12, Math.cos(a) * (R0 + 0.06), 0.2, Math.sin(a) * (R0 + 0.06), '#9d978c', 0, -a + Math.PI / 2));
    p.push(box(w * 0.82, 0.38, 0.1, Math.cos(a) * (R1 - 0.08), 0.19, Math.sin(a) * (R1 - 0.08), '#9d978c', 0, -a + Math.PI / 2));
  }
  return merge(p);
}

// —— 花境：一丛花（半球，白色，由实例色染成月季红/粉、菊花黄/橙/白/紫、一串红）——
export function flowerClumpGeometry() {
  // 叶丛（暗绿半球）+ 7 个花头（小球，白色由实例色染色）；高约 0.32 m、冠幅约 0.36 m
  const parts = [];
  const leaf = new THREE.IcosahedronGeometry(0.17, 0);
  const lp = leaf.attributes.position;
  for (let i = 0; i < lp.count; i++) { const y = lp.getY(i); lp.setY(i, (y < 0 ? y * 0.2 : y * 0.9) + 0.06); }
  leaf.computeVertexNormals();
  const lc = colored(leaf, '#ffffff');
  const cc = lc.attributes.color;
  for (let i = 0; i < cc.count; i++) cc.setXYZ(i, 0.07, 0.13, 0.04);
  // 叶色单独标记：法线 w 不能用，借颜色 —— 实例色会相乘，叶也被染色；把叶做得很暗，染色后仍偏暗绿
  parts.push(lc);
  const heads = [[0, 0.24, 0], [0.09, 0.2, 0.05], [-0.08, 0.21, 0.06], [0.05, 0.19, -0.09], [-0.09, 0.17, -0.06]];
  for (const [x, y, z] of heads) {
    const h = new THREE.OctahedronGeometry(0.06, 0);
    h.scale(1, 0.7, 1);
    h.translate(x, y, z);
    parts.push(colored(h, '#ffffff'));
  }
  const nLeaf = lc.attributes.position.count;
  const g = merge(parts);
  // uv.x = 是否花头（只有花头吃实例色，叶丛保持绿色）；uv.y = 风摆高度系数
  const n = g.attributes.position.count, uv = new Float32Array(n * 2), pp = g.attributes.position;
  for (let i = 0; i < n; i++) { uv[i * 2] = i >= nLeaf ? 1 : 0; uv[i * 2 + 1] = Math.min(1, Math.max(0, pp.getY(i) / 0.26)); }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
// —— 绿篱（单位 1×1×1，顶部倒圆，实例缩放）——
export function hedgeGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (y > 0) { pos.setX(i, x * 0.88); pos.setZ(i, z * 0.82); }
    pos.setY(i, y + 0.5);
  }
  g.computeVertexNormals();
  return merge([colored(g, '#ffffff')]);
}

// —— 草丛：7 片草叶（两段），uv.y = 高度系数（风摆）——
export function grassTuftGeometry() {
  const P = [], N = [], C = [], U = [];
  // 修剪草坪的一小撮细草（4~9 cm、叶宽 1.6 cm），颜色贴近近景地面草色（地形着色器 0.05~0.1 线性），叶尖只略亮、不发黄。
  // 此前 11 片 7~15 cm 宽叶、叶尖明显黄绿，0.42 m 格点上一丛丛像撒了一地塑料草（审查 g3 曲江池、g5 小雁塔）
  const base = [0.06, 0.088, 0.032], tip = [0.1, 0.135, 0.046];
  const NB = 12;
  for (let b = 0; b < NB; b++) {
    const a = (b / NB) * Math.PI * 2 + b * 0.9;
    const r = 0.015 + ((b * 7) % 6) * 0.016;
    const h = 0.04 + ((b * 37) % 11) * 0.005;
    const lean = 0.012 + ((b * 13) % 5) * 0.008;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
    const w = 0.008;
    const pts = [
      [bx - px * w, 0, bz - pz * w, 0], [bx + px * w, 0, bz + pz * w, 0],
      [bx + dx * lean * 0.5 - px * w * 0.6, h * 0.55, bz + dz * lean * 0.5 - pz * w * 0.6, 0.55], [bx + dx * lean * 0.5 + px * w * 0.6, h * 0.55, bz + dz * lean * 0.5 + pz * w * 0.6, 0.55],
      [bx + dx * lean, h, bz + dz * lean, 1],
    ];
    const tri = (i, j, k) => {
      for (const q of [pts[i], pts[j], pts[k]]) {
        P.push(q[0], q[1], q[2]);
        // 法线近乎朝上：与地面同样受光，草丛融进草坪而不是一簇簇反光
        N.push(dx * 0.12, 0.99, dz * 0.12);
        const t = q[3];
        C.push(base[0] + (tip[0] - base[0]) * t, base[1] + (tip[1] - base[1]) * t, base[2] + (tip[2] - base[2]) * t);
        U.push(0, t);
      }
    };
    tri(0, 1, 3); tri(0, 3, 2); tri(2, 3, 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.computeBoundingSphere();
  return g;
}

/** 夜间地面光斑（庭院灯下 6 m 半径暖光），平面 + 径向渐变 */
export function glowDecal() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,214,150,1)');
  grd.addColorStop(0.35, 'rgba(255,190,120,0.45)');
  grd.addColorStop(1, 'rgba(255,170,100,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  return { tex: t, geo };
}

/**
 * 全局实例池：kind → InstancedMesh；块提交实例数组（Float32Array：每个实例 16 元矩阵 + 可选 rgb），collect() 重填。
 */
export class InstancePool {
  constructor(root) {
    this.root = root;
    this.kinds = new Map();
  }
  define(kind, geo, mat, { shadow = false, color = false, cap = 256, name, order = 0, noReflect = false } = {}) {
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.count = 0;
    im.name = name || kind;
    im.castShadow = shadow;
    im.receiveShadow = true;
    im.frustumCulled = false; // 全城范围的实例集合，包围球没有意义；每帧按块已裁剪
    im.renderOrder = order;
    if (noReflect) im.userData.noReflect = true;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (color) {
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.root.add(im);
    this.kinds.set(kind, { im, cap, color, geo, mat });
    return im;
  }
  /** lists: kind → [{m: Float32Array(16*k), c: Float32Array(3*k)|null, k}]（来自各已加载块） */
  fill(kind, parts) {
    const K = this.kinds.get(kind);
    if (!K) return;
    let total = 0;
    for (const p of parts) total += p.k;
    if (total > K.cap) {
      let cap = K.cap;
      while (cap < total) cap *= 2;
      const old = K.im;
      const im = new THREE.InstancedMesh(K.geo, K.mat, cap);
      im.name = old.name; im.castShadow = old.castShadow; im.receiveShadow = true; im.frustumCulled = false; im.renderOrder = old.renderOrder;
      im.userData = { ...old.userData };
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (K.color) { im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); im.instanceColor.setUsage(THREE.DynamicDrawUsage); }
      this.root.remove(old);
      old.dispose();
      this.root.add(im);
      K.im = im; K.cap = cap;
    }
    const im = K.im;
    const M = im.instanceMatrix.array;
    const C = K.color ? im.instanceColor.array : null;
    let o = 0;
    for (const p of parts) {
      M.set(p.m.subarray(0, p.k * 16), o * 16);
      if (C) {
        if (p.c) C.set(p.c.subarray(0, p.k * 3), o * 3);
        else C.fill(1, o * 3, (o + p.k) * 3);
      }
      o += p.k;
    }
    im.count = total;
    im.instanceMatrix.clearUpdateRanges();
    im.instanceMatrix.addUpdateRange(0, total * 16);
    im.instanceMatrix.needsUpdate = true;
    if (C) { im.instanceColor.clearUpdateRanges(); im.instanceColor.addUpdateRange(0, total * 3); im.instanceColor.needsUpdate = true; }
    im.visible = total > 0;
  }
}

/** 实例收集器（块内）：add(kind, x, y, z, yaw, sx, sy, sz, rgb?) */
export class InstanceList {
  constructor() { this.by = new Map(); }
  add(kind, x, y, z, yaw = 0, sx = 1, sy = 1, sz = 1, rgb = null) {
    let L = this.by.get(kind);
    if (!L) this.by.set(kind, (L = { m: [], c: [], k: 0, hasC: false }));
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // three 列主序：第 0 列 = 局部 X 轴 (c, 0, −s)·sx，第 1 列 = Y·sy，第 2 列 = 局部 Z (s, 0, c)·sz，第 3 列 = 平移
    L.m.push(c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1);
    if (rgb) { L.hasC = true; L.c.push(rgb[0], rgb[1], rgb[2]); } else L.c.push(1, 1, 1);
    L.k++;
  }
  /** 冻结成 typed array（块缓存） */
  freeze() {
    const out = new Map();
    for (const [k, L] of this.by) out.set(k, { m: Float32Array.from(L.m), c: L.hasC ? Float32Array.from(L.c) : null, k: L.k });
    return out;
  }
}
