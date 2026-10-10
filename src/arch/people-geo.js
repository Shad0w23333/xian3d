// 行人 / 骑手人形：程序化几何 + 顶点着色器骨骼动画（实例化，一类一个 draw call）。
// 供 src/modules/pedestrians.js（行人）与 src/modules/traffic.js（电动车/自行车/三轮车骑手）共用。
//
// 比例（基准身高 1.70 m，实例矩阵整体缩放到 1.55~1.85 m）：头高 ≈ 身高/7.5（0.227 m）、肩峰高 0.82H、
// 髋关节 0.515H、膝 0.28H、肘 0.635H、腕 0.49H；男性肩宽（三角肌外缘）约 0.46 m、臀宽约 0.34 m；
// 女性肩窄 7%、腰细、臀宽、胸部前凸（着色器按实例体型参数变形，不另建几何）。
//
// 骨骼（11 根，全部绕关节做俯仰/外展/扭转；每个顶点绑定一根骨骼 + 与父骨骼的混合权重，关节处平滑弯折）：
//   0 骨盆  1 胸（前倾/扭转） 2 头  3/4 大腿 左/右  5/6 小腿（含脚） 7/8 上臂  9/10 前臂（含手、手机）
//   人面朝 +z，左手在 +x。
//
// 顶点属性：position / normal / aPart(bone, slot, mask, axisX) / aW（相对父骨骼的混合权重，1 = 完全跟随本骨骼）
//   slot：颜色槽（皮肤/头发/上衣/内搭/下装/鞋/包/帽/腿/鞋底/手机/屏幕/眼眉/嘴唇/背带），颜色由实例给出；
//   mask：可选部件位（发型、帽子、头盔、背包、挎包、手机、裙、长外套、帽兜、敞怀内搭），实例掩码不含该位的部件折叠掉；
//   axisX：体型缩放中心（四肢 = 肢体轴线 x；9 = 躯干类按躯干缩放；99 = 不缩放）。
// 实例属性（createPeopleMesh 建好，写入器见 PeopleWriter）：
//   instanceMatrix（位置/朝向/身高缩放）、iPose(相位 0~1, 速度 m/s, 模式, 部件掩码)、iBody(胖瘦, 女性 0~1, 年龄 -1 儿童~0~1 老人, 0)、
//   iCol0(皮肤, 头发, 上衣, 内搭)、iCol1(下装, 鞋, 包, 帽)：每个分量是 0xRRGGBB 整数（float32 可精确表示 24 位整数）。
//   模式：0 步行/站立  1 骑踏板电动车/三轮（双脚踏板、手扶车把）  2 骑自行车（蹬踏）
import * as THREE from 'three';

// ———————————————————— 常量 ————————————————————
export const BONE = { PELVIS: 0, CHEST: 1, HEAD: 2, THIGH_L: 3, THIGH_R: 4, SHIN_L: 5, SHIN_R: 6, UARM_L: 7, UARM_R: 8, FARM_L: 9, FARM_R: 10 };
export const SLOT = { SKIN: 0, HAIR: 1, TOP: 2, TOP2: 3, BOTTOM: 4, SHOES: 5, BAG: 6, HAT: 7, LEG: 8, SOLE: 9, PHONE: 10, SCREEN: 11, EYE: 12, LIP: 13, STRAP: 14 };
export const MASK = {
  HAIR_SHORT: 1, HAIR_LONG: 2, HAIR_PONY: 4, HAIR_BOB: 8,
  CAP: 16, BEANIE: 32, HELMET: 64,
  BACKPACK: 128, SHOULDERBAG: 256, CROSSBAG: 512, PHONE: 1024,
  SKIRT: 2048, COAT: 4096, HOOD: 8192, OPEN: 16384,
  DARK_TIGHTS: 32768, DARK_SOLE: 65536,
};
export const MODE = { WALK: 0, SCOOTER: 1, BICYCLE: 2 };
// 关节（基准身高 1.70 m）
const J = {
  hipX: 0.09, hipY: 0.875,
  kneeX: 0.088, kneeY: 0.475, kneeZ: 0.012,
  shX: 0.19, shY: 1.405,
  elX: 0.205, elY: 1.08, elZ: -0.02,
  waistY: 1.0, neckY: 1.465, neckZ: -0.012,
};
/** 坐姿时臀底离脚底的高度（基准身高）：骑手实例原点 = 座面 - SEAT_H × 身高缩放 */
export const SEAT_H = 0.80;
/** 髋关节离脚底高度（基准身高） */
export const HIP_H = J.hipY;

// ———————————————————— 几何构建 ————————————————————
const TORSO = 9, NOSCALE = 99;
class PB {
  constructor() { this.P = []; this.N = []; this.A = []; this.W = []; this.I = []; this.nv = 0; }
  /** 加一块索引网格；attr(x,y,z) → [bone, slot, mask, axisX, w]；normals 省略时按面积加权平滑 */
  mesh(pos, idx, attr, normals = null) {
    const base = this.nv, n = pos.length / 3;
    const nr = normals || smoothNormals(pos, idx);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      this.P.push(x, y, z);
      this.N.push(nr[i * 3], nr[i * 3 + 1], nr[i * 3 + 2]);
      const a = attr(x, y, z);
      this.A.push(a[0], a[1], a[2], a[3]);
      this.W.push(a[4] ?? 1);
    }
    for (const k of idx) this.I.push(base + k);
    this.nv += n;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.A, 4));
    g.setAttribute('aW', new THREE.Float32BufferAttribute(this.W, 1));
    g.setIndex(this.nv > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2.2);
    return g;
  }
}
function smoothNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}
/** 把三角形翻成外法线朝外（参考点 = 部件内部的点或轴线函数） */
function orient(pos, idx, inside) {
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const cx = (pos[a] + pos[b] + pos[c]) / 3, cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    const r = inside(cx, cy, cz);
    if (nx * (cx - r[0]) + ny * (cy - r[1]) + nz * (cz - r[2]) < 0) { const k = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = k; }
  }
}
const sgnPow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);
/**
 * 竖向放样（四肢/躯干/头颈）：rings = [{y, rx, rzF, rzB, xc, zc, e}]（自下而上），seg 段；
 * 环为超椭圆（e=2 椭圆，越大越方），前半(z>0)半径 rzF、后半 rzB。capB/capT：底/顶封口（极点相对环心的 y 偏移，null 不封）
 */
function loftY(rings, seg, { capB = null, capT = null } = {}) {
  const pos = [], idx = [];
  for (const r of rings) {
    const e = r.e || 2;
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2 + (r.rot || 0);
      const cx = sgnPow(Math.cos(a), 2 / e), sz = sgnPow(Math.sin(a), 2 / e);
      pos.push((r.xc || 0) + cx * r.rx, r.y, (r.zc || 0) + sz * (sz > 0 ? r.rzF : r.rzB));
    }
  }
  const nR = rings.length;
  for (let i = 0; i + 1 < nR; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j, b = i * seg + ((j + 1) % seg), c = (i + 1) * seg + ((j + 1) % seg), d = (i + 1) * seg + j;
      idx.push(a, b, c, a, c, d);
    }
  if (capB !== null) {
    const r = rings[0], k = pos.length / 3;
    pos.push(r.xc || 0, r.y + capB, (r.zc || 0) + ((r.rzF - r.rzB) * 0.5));
    for (let j = 0; j < seg; j++) idx.push(k, j, (j + 1) % seg);
  }
  if (capT !== null) {
    const r = rings[nR - 1], k = pos.length / 3, o = (nR - 1) * seg;
    pos.push(r.xc || 0, r.y + capT, (r.zc || 0) + ((r.rzF - r.rzB) * 0.5));
    for (let j = 0; j < seg; j++) idx.push(k, o + j, o + ((j + 1) % seg));
  }
  // 方向：参考点取同高度的环心
  const ys = rings.map((r) => r.y);
  orient(pos, idx, (x, y, z) => {
    let i = 0;
    while (i + 1 < nR - 1 && y > ys[i + 1]) i++;
    const r0 = rings[i], r1 = rings[Math.min(nR - 1, i + 1)];
    const t = r1.y > r0.y ? Math.min(1, Math.max(0, (y - r0.y) / (r1.y - r0.y))) : 0;
    const xc = (r0.xc || 0) + ((r1.xc || 0) - (r0.xc || 0)) * t;
    const zc = (r0.zc || 0) + ((r1.zc || 0) - (r0.zc || 0)) * t + ((r0.rzF - r0.rzB) * 0.5);
    if (y < rings[0].y - 1e-4) return [xc, rings[0].y + 0.05, zc];
    if (y > rings[nR - 1].y + 1e-4) return [xc, rings[nR - 1].y - 0.05, zc];
    return [xc, y, zc];
  });
  return { pos, idx };
}
/** 纵向放样（鞋、帽檐等沿 z）：rings = [{z, rx, ryT, ryB, xc, yc, e}] */
function loftZ(rings, seg, { capB = null, capF = null } = {}) {
  const pos = [], idx = [];
  for (const r of rings) {
    const e = r.e || 2;
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const cx = sgnPow(Math.cos(a), 2 / e), sy = sgnPow(Math.sin(a), 2 / e);
      pos.push((r.xc || 0) + cx * r.rx, (r.yc || 0) + sy * (sy > 0 ? r.ryT : r.ryB), r.z);
    }
  }
  const nR = rings.length;
  for (let i = 0; i + 1 < nR; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j, b = i * seg + ((j + 1) % seg), c = (i + 1) * seg + ((j + 1) % seg), d = (i + 1) * seg + j;
      idx.push(a, b, c, a, c, d);
    }
  const capAt = (ri, dz) => {
    const r = rings[ri], k = pos.length / 3, o = ri * seg;
    pos.push(r.xc || 0, (r.yc || 0) + (r.ryT - r.ryB) * 0.5, r.z + dz);
    for (let j = 0; j < seg; j++) idx.push(k, o + j, o + ((j + 1) % seg));
  };
  if (capB !== null) capAt(0, capB);
  if (capF !== null) capAt(nR - 1, capF);
  const zs = rings.map((r) => r.z);
  orient(pos, idx, (x, y, z) => {
    let i = 0;
    while (i + 1 < nR - 1 && z > zs[i + 1]) i++;
    const r0 = rings[i], r1 = rings[Math.min(nR - 1, i + 1)];
    const t = r1.z > r0.z ? Math.min(1, Math.max(0, (z - r0.z) / (r1.z - r0.z))) : 0;
    const xc = (r0.xc || 0) + ((r1.xc || 0) - (r0.xc || 0)) * t;
    const yc = (r0.yc || 0) + ((r1.yc || 0) - (r0.yc || 0)) * t + (r0.ryT - r0.ryB) * 0.5;
    if (z < rings[0].z - 1e-4) return [xc, yc, rings[0].z + 0.03];
    if (z > rings[nR - 1].z + 1e-4) return [xc, yc, rings[nR - 1].z - 0.03];
    return [xc, yc, z];
  });
  return { pos, idx };
}
/** 椭球（经纬网格） */
function ellipsoid(cx, cy, cz, rx, ry, rz, ws, hs) {
  const rings = [];
  for (let i = 1; i < hs; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / hs;
    rings.push({ y: cy + Math.sin(t) * ry, rx: Math.cos(t) * rx, rzF: Math.cos(t) * rz, rzB: Math.cos(t) * rz, xc: cx, zc: cz });
  }
  return loftY(rings, ws, { capB: -(ry + rings[0].y - cy), capT: cy + ry - rings[rings.length - 1].y });
}
/** 盒子（平面法线），可绕 x 轴倾斜 tilt */
function box(cx, cy, cz, sx, sy, sz, tilt = 0) {
  const pos = [], idx = [], nrm = [];
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const R = (x, y, z) => [cx + x, cy + y * c - z * s, cz + y * s + z * c];
  const F = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const h = [sx / 2, sy / 2, sz / 2];
  for (const [n, u, v] of F) {
    const k = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 1, 2].map((i) => n[i] * h[i] + u[i] * a * h[i] + v[i] * b * h[i]);
      pos.push(...R(p[0], p[1], p[2]));
      const nn = R(n[0], n[1], n[2]);
      nrm.push(nn[0] - cx, nn[1] - cy, nn[2] - cz);
    }
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  }
  orient(pos, idx, () => [cx, cy, cz]);
  return { pos, idx, nrm };
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 人形几何。lod 0 = 近景细模（约 2000 三角形，含全部可选部件），lod 1 = 远景简模（约 300 三角形）
 */
export function peopleGeometry(lod = 0) {
  const fine = lod === 0;
  const B = new PB();
  const add = (g, attr) => B.mesh(g.pos, g.idx, attr, g.nrm || null);
  const S = SLOT, M = MASK;
  // —— 骨盆（下装）——
  const pelvisR = fine
    ? [[0.785, 0.075, 0.06, 0.068], [0.815, 0.136, 0.082, 0.094], [0.875, 0.16, 0.088, 0.106], [0.95, 0.156, 0.089, 0.1], [1.03, 0.146, 0.09, 0.094]]
    : [[0.79, 0.12, 0.08, 0.09], [0.88, 0.165, 0.09, 0.112], [1.03, 0.146, 0.09, 0.094]];
  add(loftY(pelvisR.map(([y, rx, f, b]) => ({ y, rx, rzF: f, rzB: b, e: 2.4 })), fine ? 12 : 6, { capB: -0.012 }), () => [BONE.PELVIS, S.BOTTOM, 0, TORSO, 1]);
  // —— 躯干（上衣，下摆罩住腰头）——
  const torsoR = fine
    ? [[0.855, 0.18, 0.11, 0.126], [0.92, 0.172, 0.105, 0.118], [0.98, 0.166, 0.101, 0.11], [1.04, 0.158, 0.099, 0.101], [1.12, 0.163, 0.102, 0.1], [1.2, 0.172, 0.112, 0.104],
      [1.27, 0.178, 0.114, 0.106], [1.33, 0.18, 0.104, 0.102], [1.375, 0.176, 0.092, 0.094], [1.408, 0.168, 0.08, 0.082], [1.428, 0.13, 0.068, 0.07], [1.448, 0.075, 0.056, 0.06]]
    : [[0.86, 0.18, 0.11, 0.124], [1.04, 0.158, 0.1, 0.1], [1.25, 0.177, 0.113, 0.105], [1.375, 0.178, 0.09, 0.092], [1.44, 0.09, 0.06, 0.064]];
  const torsoW = (y) => sstep(0.97, 1.16, y);
  add(loftY(torsoR.map(([y, rx, f, b]) => ({ y, rx, rzF: f, rzB: b, e: 2.6 })), fine ? 12 : 6, { capT: 0.01 }), (x, y) => [BONE.CHEST, S.TOP, 0, TORSO, torsoW(y)]);
  // —— 颈 + 头 ——
  const neckW = (y) => sstep(1.445, 1.5, y);
  if (fine) add(loftY([[1.425, 0.05, 0.048, 0.05], [1.47, 0.049, 0.046, 0.05], [1.51, 0.048, 0.045, 0.048]].map(([y, rx, f, b]) => ({ y, rx, rzF: f, rzB: b, zc: -0.005 })), 8), (x, y) => [BONE.HEAD, S.SKIN, 0, NOSCALE, neckW(y)]);
  const headR = [
    // y, rx, rzF, rzB, zc
    [1.482, 0.03, 0.025, 0.03, 0.048], [1.5, 0.052, 0.045, 0.055, 0.022], [1.53, 0.065, 0.072, 0.074, 0.004], [1.57, 0.072, 0.086, 0.09, -0.004],
    [1.61, 0.077, 0.091, 0.097, -0.009], [1.65, 0.075, 0.085, 0.095, -0.012], [1.68, 0.064, 0.07, 0.081, -0.015], [1.698, 0.04, 0.043, 0.05, -0.018],
  ];
  const headRings = (fine ? headR : [headR[1], headR[3], headR[5], headR[7]]).map(([y, rx, f, b, zc]) => ({ y, rx, rzF: f, rzB: b, zc }));
  add(loftY(headRings, fine ? 12 : 6, { capB: -0.008, capT: 0.008 }), () => [BONE.HEAD, S.SKIN, 0, NOSCALE, 1]);
  if (fine) {
    // 鼻、耳、眼、眉、嘴
    const nose = { pos: [0, 1.548, 0.104, 0.013, 1.55, 0.088, -0.013, 1.55, 0.088, 0, 1.585, 0.093, 0, 1.553, 0.084], idx: [0, 1, 3, 0, 3, 2, 0, 2, 1, 1, 2, 4] };
    orient(nose.pos, nose.idx, () => [0, 1.56, 0.07]);
    add(nose, () => [BONE.HEAD, S.SKIN, 0, NOSCALE, 1]);
    for (const s of [1, -1]) {
      add(ellipsoid(s * 0.077, 1.585, -0.008, 0.012, 0.028, 0.019, 6, 4), () => [BONE.HEAD, S.SKIN, 0, NOSCALE, 1]);
      add(ellipsoid(s * 0.031, 1.597, 0.079, 0.012, 0.0065, 0.006, 6, 3), () => [BONE.HEAD, S.EYE, 0, NOSCALE, 1]);
      add(box(s * 0.032, 1.616, 0.083, 0.03, 0.006, 0.008, 0.15), () => [BONE.HEAD, S.EYE, 0, NOSCALE, 1]);
    }
    add(box(0, 1.523, 0.073, 0.032, 0.007, 0.008), () => [BONE.HEAD, S.LIP, 0, NOSCALE, 1]);
  }
  // —— 发型（每人一种）——
  hair(B, fine);
  // —— 帽子 / 头盔 ——
  hats(B, fine);
  // —— 腿（下装/打底）——
  for (const s of [1, -1]) {
    const legR = fine
      ? [[0.93, 0.084, 0.086, 0.086, 0], [0.86, 0.088, 0.09, 0.092, 0.002], [0.75, 0.08, 0.084, 0.084, 0.004], [0.63, 0.07, 0.072, 0.072, 0.008],
        [0.53, 0.06, 0.062, 0.06, 0.012], [0.475, 0.057, 0.06, 0.058, 0.014], [0.41, 0.058, 0.058, 0.064, 0.004], [0.31, 0.056, 0.056, 0.062, -0.006],
        [0.2, 0.045, 0.046, 0.047, -0.012], [0.11, 0.041, 0.043, 0.044, -0.016], [0.085, 0.043, 0.046, 0.046, -0.016]]
      : [[0.93, 0.085, 0.087, 0.087, 0], [0.6, 0.068, 0.07, 0.07, 0.009], [0.33, 0.056, 0.057, 0.061, -0.004], [0.09, 0.044, 0.046, 0.046, -0.016]];
    const xs = (y) => s * lerp(J.kneeX, J.hipX, sstep(J.kneeY, J.hipY, y)) * (y < J.kneeY ? 1 : 1) - s * (y < J.kneeY ? (J.kneeY - y) * 0.008 : 0);
    const rings = legR.slice().reverse().map(([y, rx, f, b, zc]) => ({ y, rx, rzF: f, rzB: b, xc: xs(y), zc }));
    const th = s > 0 ? BONE.THIGH_L : BONE.THIGH_R, sh = s > 0 ? BONE.SHIN_L : BONE.SHIN_R;
    add(loftY(rings, fine ? 9 : 5, { capB: -0.01 }), (x, y) => {
      if (y > J.kneeY + 0.09) return [th, S.LEG, 0, s * J.hipX, sstep(0.99, 0.82, y)];
      return [sh, S.LEG, 0, s * J.kneeX, sstep(J.kneeY + 0.09, J.kneeY - 0.07, y)];
    });
    // 鞋：沿 z 放样（鞋头圆、鞋跟略高）+ 鞋底
    const ax = s * 0.083;
    const shoeR = fine
      ? [[-0.085, 0.037, 0.07, 0.0, 0.044], [-0.06, 0.042, 0.082, 0.0, 0.045], [0.0, 0.046, 0.078, 0.0, 0.042], [0.07, 0.049, 0.06, 0.0, 0.034], [0.13, 0.046, 0.045, 0.0, 0.028], [0.165, 0.036, 0.033, 0.0, 0.026], [0.182, 0.02, 0.02, 0.0, 0.024]]
      : [[-0.085, 0.04, 0.075, 0, 0.044], [0.06, 0.048, 0.06, 0, 0.034], [0.18, 0.03, 0.025, 0, 0.026]];
    if (!fine) { add(box(ax, 0.04, 0.045, 0.095, 0.08, 0.27), () => [sh, S.SHOES, 0, s * J.kneeX, 1]); continue; }
    add(loftZ(shoeR.map(([z, rx, ryT, ryB, yc]) => ({ z, rx, ryT: ryT - yc, ryB: yc - 0.018, xc: ax, yc, e: 2.6 })), 8, { capB: -0.006, capF: 0.004 }), () => [sh, S.SHOES, 0, s * J.kneeX, 1]);
    const sole = box(ax, 0.011, 0.045, 0.098, 0.022, 0.275);
    add(sole, () => [sh, S.SOLE, 0, s * J.kneeX, 1]);
  }
  // —— 手臂（上衣袖 + 手）——
  for (const s of [1, -1]) {
    const ua = s > 0 ? BONE.UARM_L : BONE.UARM_R, fa = s > 0 ? BONE.FARM_L : BONE.FARM_R;
    const armR = fine
      ? [[1.41, 0.026, 0.026, 0.026, 0.186, 0], [1.395, 0.046, 0.046, 0.049, 0.19, -0.004], [1.36, 0.052, 0.05, 0.053, 0.197, -0.008], [1.29, 0.049, 0.047, 0.049, 0.202, -0.012],
        [1.2, 0.046, 0.045, 0.046, 0.205, -0.016], [1.115, 0.042, 0.042, 0.042, 0.206, -0.02], [1.065, 0.041, 0.042, 0.04, 0.206, -0.02], [1.0, 0.041, 0.042, 0.04, 0.207, -0.016],
        [0.92, 0.036, 0.036, 0.035, 0.208, -0.008], [0.855, 0.034, 0.034, 0.033, 0.209, -0.002], [0.84, 0.034, 0.034, 0.033, 0.209, 0]]
      : [[1.42, 0.035, 0.035, 0.035, 0.188, 0], [1.36, 0.052, 0.05, 0.053, 0.197, -0.008], [1.08, 0.042, 0.042, 0.04, 0.206, -0.02], [0.86, 0.034, 0.034, 0.033, 0.209, -0.002]];
    const rings = armR.slice().reverse().map(([y, rx, f, b, xc, zc]) => ({ y, rx, rzF: f, rzB: b, xc: s * xc, zc }));
    add(loftY(rings, fine ? 8 : 4, { capB: -0.004, capT: 0.006 }), (x, y) => {
      if (y > J.elY + 0.07) return [ua, S.TOP, 0, s * 0.203, sstep(1.42, 1.32, y)];
      return [fa, S.TOP, 0, s * 0.207, sstep(J.elY + 0.07, J.elY - 0.06, y)];
    });
    if (!fine) {
      add(loftY([[0.86, 0.022, 0.03, 0.03, 0.004], [0.7, 0.014, 0.03, 0.03, 0.008]].map(([y, rx, f, b, zc]) => ({ y, rx, rzF: f, rzB: b, xc: s * 0.21, zc })), 3, { capB: -0.01 }), () => [fa, S.SKIN, 0, s * 0.21, 1]);
      continue;
    }
    // 手（手掌朝内，四指并拢，拇指前凸）
    const handR = fine
      ? [[0.862, 0.022, 0.026, 0.026, 0.0], [0.83, 0.021, 0.03, 0.03, 0.004], [0.79, 0.019, 0.044, 0.042, 0.008], [0.745, 0.017, 0.043, 0.04, 0.01], [0.705, 0.014, 0.034, 0.032, 0.01], [0.675, 0.011, 0.02, 0.02, 0.008]]
      : [[0.86, 0.022, 0.03, 0.03, 0.002], [0.77, 0.018, 0.042, 0.04, 0.008], [0.69, 0.012, 0.025, 0.025, 0.008]];
    add(loftY(handR.slice().reverse().map(([y, rx, f, b, zc]) => ({ y, rx, rzF: f, rzB: b, xc: s * 0.21, zc })), fine ? 7 : 4, { capB: -0.01 }), () => [fa, S.SKIN, 0, s * 0.21, 1]);
    if (fine) add(ellipsoid(s * 0.2, 0.8, 0.045, 0.012, 0.03, 0.012, 5, 3), () => [fa, S.SKIN, 0, s * 0.21, 1]);
  }
  // —— 可选：裙 / 长外套下摆（随大腿摆动的“软”部件）——
  const skirtAttr = (mask, slot) => (x, y) => {
    const s = x >= 0 ? 1 : -1;
    const w = 0.6 * sstep(0.97, 0.5, y) * sstep(0.0, 0.1, Math.abs(x));
    return [s > 0 ? BONE.THIGH_L : BONE.THIGH_R, slot, mask, TORSO, w];
  };
  // 裙腰收在上衣下摆里面（同一超椭圆指数，下摆处各向都比上衣小）
  const skirtR = fine
    ? [[1.0, 0.148, 0.096, 0.098], [0.9, 0.166, 0.099, 0.113], [0.82, 0.185, 0.125, 0.138], [0.72, 0.2, 0.145, 0.155], [0.58, 0.212, 0.162, 0.17], [0.52, 0.215, 0.168, 0.174]]
    : [[1.0, 0.148, 0.096, 0.098], [0.88, 0.17, 0.104, 0.118], [0.53, 0.214, 0.166, 0.172]];
  add(loftY(skirtR.map(([y, rx, f, b]) => ({ y, rx, rzF: f, rzB: b, e: 2.6 })), fine ? 12 : 6), skirtAttr(M.SKIRT, S.BOTTOM));
  const coatR = fine
    ? [[0.93, 0.178, 0.11, 0.126], [0.82, 0.19, 0.122, 0.138], [0.7, 0.2, 0.135, 0.15], [0.58, 0.207, 0.145, 0.158], [0.55, 0.208, 0.146, 0.16]]
    : [[0.93, 0.178, 0.11, 0.126], [0.56, 0.206, 0.144, 0.158]];
  add(loftY(coatR.map(([y, rx, f, b]) => ({ y, rx, rzF: f, rzB: b, e: 2.4 })), fine ? 12 : 6), skirtAttr(M.COAT, S.TOP));
  // —— 可选：帽兜、敞怀内搭 ——
  if (fine) add(ellipsoid(0, 1.425, -0.098, 0.105, 0.05, 0.05, 8, 4), () => [BONE.CHEST, S.TOP, M.HOOD, TORSO, 1]);
  if (fine) {
    // 内搭条：贴着躯干前表面（V 形开口）
    const pos = [], idx = [];
    const ys = [0.92, 1.04, 1.16, 1.26, 1.34, 1.405];
    const frontZ = (y) => {
      let i = 0;
      while (i + 1 < torsoR.length - 1 && y > torsoR[i + 1][0]) i++;
      const a = torsoR[i], b = torsoR[i + 1], t = Math.min(1, Math.max(0, (y - a[0]) / (b[0] - a[0])));
      return lerp(a[2], b[2], t) + 0.006;
    };
    ys.forEach((y, k) => {
      const hw = 0.028 + 0.03 * sstep(1.2, 1.405, y);
      for (const x of [-hw, 0, hw]) pos.push(x, y, frontZ(y) - Math.abs(x) * 0.25);
      if (k) { const o = (k - 1) * 3; idx.push(o, o + 1, o + 4, o, o + 4, o + 3, o + 1, o + 2, o + 5, o + 1, o + 5, o + 4); }
    });
    orient(pos, idx, (x, y) => [0, y, 0]);
    add({ pos, idx }, (x, y) => [BONE.CHEST, S.TOP2, M.OPEN, TORSO, torsoW(y)]);
    // 领口
    add(loftY([[1.43, 0.074, 0.066, 0.068], [1.465, 0.062, 0.058, 0.064]].map(([y, rx, f, b]) => ({ y, rx, rzF: f, rzB: b, zc: -0.005 })), 10), (x, y) => [BONE.CHEST, S.TOP2, M.OPEN, TORSO, 1]);
  }
  // —— 包 ——
  accessories(B, fine);
  return B.geometry();
}

/** 发型：短发 / 长发 / 马尾 / 波波头（包住头顶的壳 + 垂发），绑定头骨 */
function hair(B, fine) {
  const S = SLOT, M = MASK;
  const cols = fine ? 11 : 6, rows = fine ? 5 : 2;
  // 头部表面：按 y 插值头部环
  const HR = [[1.47, 0.04, 0.035, 0.04, 0.04], [1.5, 0.052, 0.045, 0.055, 0.022], [1.53, 0.065, 0.072, 0.074, 0.004], [1.57, 0.072, 0.086, 0.09, -0.004],
    [1.61, 0.077, 0.091, 0.097, -0.009], [1.65, 0.075, 0.085, 0.095, -0.012], [1.68, 0.064, 0.07, 0.081, -0.015], [1.698, 0.04, 0.043, 0.05, -0.018], [1.706, 0.0, 0.0, 0.0, -0.02]];
  const surf = (y, a, grow) => {
    let i = 0;
    while (i + 1 < HR.length - 1 && y > HR[i + 1][0]) i++;
    const r0 = HR[i], r1 = HR[i + 1], t = Math.min(1, Math.max(0, (y - r0[0]) / (r1[0] - r0[0])));
    const rx = lerp(r0[1], r1[1], t), f = lerp(r0[2], r1[2], t), b = lerp(r0[3], r1[3], t), zc = lerp(r0[4], r1[4], t);
    const ca = Math.cos(a), sa = Math.sin(a);
    return [ca * (rx + grow), y, zc + sa * ((sa > 0 ? f : b) + grow)];
  };
  // a：环向角（0 = +x 左侧，π/2 = 正前，3π/2 = 正后）；hairEnd(a) → 该方向发际/发梢的 y；hang = 头部以下垂发
  const shell = (endY, grow, mask, hangR = 0) => {
    const pos = [], idx = [];
    const top = [0, 1.712 + grow * 1.1, -0.018];
    for (let r = 1; r <= rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = (c / cols) * Math.PI * 2;
        const ye = endY(a);
        const t = r / rows;
        const y = lerp(1.704, ye, Math.pow(t, 1.25));
        let p;
        if (hangR > 0 && y < 1.6) {
          // 垂发：从头部最宽处直落（不贴下颌、不钻进肩膀）
          const q = surf(1.6, a, grow + hangR * Math.min(1, (1.6 - y) / 0.12));
          const k = (1.6 - y) / 0.3;
          p = [q[0] * (1 + 0.06 * k), y, q[2] * (1 + 0.06 * k) - 0.008 * k];
        } else p = surf(Math.max(y, 1.47), a, grow * (1 - 0.35 * t) + 0.004 * (1 - t));
        pos.push(...p);
      }
    const k0 = pos.length / 3;
    pos.push(...top);
    for (let c = 0; c < cols; c++) idx.push(k0, c, (c + 1) % cols);
    for (let r = 0; r + 1 < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = r * cols + c, b = r * cols + ((c + 1) % cols), cc = (r + 1) * cols + ((c + 1) % cols), d = (r + 1) * cols + c;
        idx.push(a, b, cc, a, cc, d);
      }
    orient(pos, idx, (x, y) => [0, Math.max(1.45, Math.min(y, 1.62)), -0.01]);
    B.mesh(pos, idx, () => [BONE.HEAD, S.HAIR, mask, NOSCALE, 1]);
  };
  // 前额发际 1.655，两鬓 1.6（耳上），后脑 1.515（发根）
  const front = (a) => Math.max(0, Math.sin(a)); // 前方权重
  const back = (a) => Math.max(0, -Math.sin(a));
  if (!fine) {
    // 远景：短发/马尾共用一个发壳，长发/波波头共用一个
    shell((a) => 1.6 + 0.058 * front(a) ** 1.5 - 0.085 * back(a) ** 1.2, 0.013, M.HAIR_SHORT | M.HAIR_PONY);
    shell((a) => { const f = front(a); return f > 0.6 ? lerp(1.62, 1.648, (f - 0.6) / 0.4) : lerp(1.45, 1.36, back(a) ** 0.7); }, 0.016, M.HAIR_LONG | M.HAIR_BOB, 0.012);
    return;
  }
  shell((a) => 1.6 + 0.058 * front(a) ** 1.5 - 0.085 * back(a) ** 1.2, 0.011, M.HAIR_SHORT);
  shell((a) => 1.59 + 0.065 * front(a) ** 1.2 - 0.075 * back(a), 0.015, M.HAIR_PONY);
  // 波波头 / 长发：脸前（|角| 在正前 ±55° 内）留出发际线，两侧与脑后垂下
  shell((a) => { const f = front(a); return f > 0.6 ? lerp(1.6, 1.648, (f - 0.6) / 0.4) : lerp(1.505, 1.6, f / 0.6) - 0.01 * back(a); }, 0.018, M.HAIR_BOB, 0.008);
  shell((a) => { const f = front(a); return f > 0.6 ? lerp(1.62, 1.648, (f - 0.6) / 0.4) : lerp(1.43, 1.3, back(a) ** 0.7); }, 0.016, M.HAIR_LONG, 0.014);
  // 马尾
  B.mesh(...(() => { const g = ellipsoid(0, 1.53, -0.118, 0.032, 0.085, 0.03, fine ? 6 : 4, fine ? 5 : 3); return [g.pos, g.idx]; })(), () => [BONE.HEAD, S.HAIR, M.HAIR_PONY, NOSCALE, 1]);
}

/** 帽子：棒球帽、毛线帽、电动车头盔 */
function hats(B, fine) {
  const S = SLOT, M = MASK;
  const seg = fine ? 10 : 6;
  const dome = (y0, rx, rzF, rzB, h, zc, mask, rows) => {
    const rings = [];
    for (let i = 0; i < rows; i++) {
      const t = i / rows, k = Math.cos((t * Math.PI) / 2);
      rings.push({ y: y0 + Math.sin((t * Math.PI) / 2) * h, rx: rx * k, rzF: rzF * k, rzB: rzB * k, zc });
    }
    B.mesh(...(() => { const g = loftY(rings, seg, { capT: y0 + h - rings[rings.length - 1].y }); return [g.pos, g.idx]; })(), () => [BONE.HEAD, S.HAT, mask, NOSCALE, 1]);
  };
  if (!fine) { dome(1.6, 0.09, 0.1, 0.11, 0.12, -0.014, M.CAP | M.BEANIE | M.HELMET, 2); return; }
  // 棒球帽：帽冠 + 前檐
  dome(1.632, 0.085, 0.096, 0.104, 0.085, -0.012, M.CAP, fine ? 4 : 2);
  {
    const pos = [], idx = [];
    const n = fine ? 7 : 3;
    for (let i = 0; i <= n; i++) {
      const a = Math.PI * (0.18 + (0.64 * i) / n);
      const cx = Math.cos(a), sz = Math.sin(a);
      pos.push(cx * 0.085, 1.645, -0.012 + sz * 0.094, cx * 0.08, 1.632 - 0.012 * sz, -0.012 + sz * 0.172);
      if (i) { const o = (i - 1) * 2; idx.push(o, o + 2, o + 3, o, o + 3, o + 1); }
    }
    B.mesh(pos, idx, () => [BONE.HEAD, S.HAT, M.CAP, NOSCALE, 1], new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)));
  }
  // 毛线帽（略尖、包到耳上）
  dome(1.6, 0.084, 0.094, 0.104, 0.13, -0.014, M.BEANIE, fine ? 4 : 2);
  // 电动车头盔：大圆壳 + 护目檐
  dome(1.585, 0.1, 0.112, 0.12, 0.14, -0.014, M.HELMET, fine ? 5 : 2);
  B.mesh(...(() => { const g = box(0, 1.645, 0.112, 0.15, 0.03, 0.05, -0.35); return [g.pos, g.idx]; })(), () => [BONE.HEAD, S.HAT, M.HELMET, NOSCALE, 1]);
  if (fine) B.mesh(...(() => { const g = box(0, 1.6, 0.11, 0.14, 0.012, 0.016); return [g.pos, g.idx]; })(), () => [BONE.HEAD, S.STRAP, M.HELMET, NOSCALE, 1]);
}

/** 背包、挎包、斜挎小包、手机 */
function accessories(B, fine) {
  const S = SLOT, M = MASK;
  const addBox = (g, bone, slot, mask, w = 1) => B.mesh(g.pos, g.idx, () => [bone, slot, mask, TORSO, w], g.nrm);
  // 双肩包：圆角包体（竖向放样）+ 肩带
  {
    const rings = fine
      ? [[0.98, 0.13, 0.05, 0.05], [1.0, 0.145, 0.07, 0.07], [1.15, 0.15, 0.075, 0.075], [1.3, 0.145, 0.07, 0.07], [1.36, 0.12, 0.055, 0.055]]
      : [[0.98, 0.14, 0.06, 0.06], [1.36, 0.13, 0.062, 0.062]];
    const g = loftY(rings.map(([y, rx, f, b]) => ({ y, rx, rzF: f, rzB: b, zc: -0.19, e: 3.2 })), fine ? 10 : 4, { capB: -0.01, capT: 0.012 });
    B.mesh(g.pos, g.idx, (x, y) => [BONE.CHEST, S.BAG, M.BACKPACK, TORSO, sstep(0.97, 1.16, y)]);
    if (fine) for (const s of [1, -1]) {
      // 肩带：从包顶越过肩到腋下前方
      const pts = [[0.1, 1.35, -0.14], [0.11, 1.43, -0.06], [0.12, 1.44, 0.03], [0.13, 1.38, 0.1], [0.14, 1.26, 0.12], [0.15, 1.17, 0.114]];
      const pos = [], idx = [];
      pts.forEach(([x, y, z], k) => {
        pos.push(s * (x - 0.022), y, z, s * (x + 0.022), y, z);
        if (k) { const o = (k - 1) * 2; idx.push(o, o + 1, o + 3, o, o + 3, o + 2); }
      });
      B.mesh(pos, idx, (x, y) => [BONE.CHEST, S.STRAP, M.BACKPACK, TORSO, sstep(0.97, 1.16, y)], pos.map((_, i) => (i % 3 === 1 ? 1 : 0)));
    }
  }
  // 单肩包（左肩挎，夹在左胯外侧；挎包的人左臂外张、少摆，见着色器）
  { const g = box(0.195, 0.99, -0.03, 0.065, 0.23, 0.27); B.mesh(g.pos, g.idx, (x, y) => [BONE.CHEST, S.BAG, M.SHOULDERBAG, TORSO, sstep(0.97, 1.16, y)], g.nrm); }
  if (fine) {
    const pos = [0.15, 1.432, 0.03, 0.19, 1.43, 0.03, 0.2, 1.1, 0.06, 0.19, 1.1, -0.12, 0.15, 1.432, -0.05];
    const idx = [0, 1, 2, 4, 3, 1];
    B.mesh(pos, idx, (x, y) => [BONE.CHEST, S.STRAP, M.SHOULDERBAG, TORSO, sstep(0.97, 1.2, y)], pos.map((_, i) => (i % 3 === 0 ? 1 : 0)));
  }
  // 斜挎小包（右胯前）+ 斜跨胸前的带子
  if (fine) addBox(box(-0.09, 0.98, 0.126, 0.15, 0.12, 0.05), BONE.PELVIS, S.BAG, M.CROSSBAG);
  if (fine) {
    const pts = [[0.15, 1.42, 0.0], [0.1, 1.33, 0.112], [0.0, 1.2, 0.126], [-0.08, 1.07, 0.122], [-0.09, 1.04, 0.13]];
    const pos = [], idx = [];
    pts.forEach(([x, y, z], k) => {
      pos.push(x - 0.012, y + 0.012, z, x + 0.012, y - 0.012, z);
      if (k) { const o = (k - 1) * 2; idx.push(o, o + 1, o + 3, o, o + 3, o + 2); }
    });
    B.mesh(pos, idx, (x, y) => [BONE.CHEST, S.STRAP, M.CROSSBAG, TORSO, sstep(0.97, 1.16, y)], pos.map((_, i) => (i % 3 === 2 ? 1 : 0)));
  }
  // 手机（右手，前臂骨）：机身 + 屏幕（屏幕朝上臂方向，抬手看手机时朝向脸）
  if (fine) {
    // 静止姿态里手机贴在掌前、屏幕朝前（+z）；前臂屈 90° 后屏幕朝上对着脸
    const g = box(-0.208, 0.745, 0.054, 0.07, 0.14, 0.009);
    B.mesh(g.pos, g.idx, () => [BONE.FARM_R, S.PHONE, M.PHONE, -0.21, 1], g.nrm);
    const s = box(-0.208, 0.745, 0.0595, 0.062, 0.128, 0.002);
    B.mesh(s.pos, s.idx, () => [BONE.FARM_R, S.SCREEN, M.PHONE, -0.21, 1], s.nrm);
  }
}

// ———————————————————— 着色器 ————————————————————
// 共用顶点代码：pplPose(p, n) 把静止姿态的顶点变成当前姿态（体型 → 骨骼链）
const POSE_GLSL = /* glsl */ `
attribute vec4 aPart;
attribute float aW;
attribute vec4 iPose;
attribute vec4 iBody;
attribute vec4 iCol0;
attribute vec4 iCol1;
uniform float uTime;
varying vec3 vPCol;
varying float vPRough;
varying float vPEm;
varying float vPH;
varying vec3 vPBase; // 静止姿态坐标（基准身高，头部未放大）：片元里画五官、发丝、衣物阴影
flat varying float vPCode; // 颜色槽 + 16 × 骨骼
vec3 pRx(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c + v.z * s, -v.y * s + v.z * c); }
vec3 pRz(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z); }
vec3 pRy(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
vec3 pUnpack(float f) { f = floor(f + 0.5); vec3 c = vec3(floor(f / 65536.0), mod(floor(f / 256.0), 256.0), mod(f, 256.0)) / 255.0; return pow(c, vec3(2.2)); }
// 姿态参数（每个顶点算一遍，同一实例结果相同）
vec2 qT, qK, qU, qE, qAbd;
float qLean, qTwist, qHead, qBob, qSway, qPYaw;
vec3 qSh, qHip, qKnee, qEl;
float qHeadK;
void pplSetup() {
  float spd = iPose.y;
  int mode = int(iPose.z + 0.5);
  int msk = int(iPose.w + 0.5);
  float g = iBody.x, fem = iBody.y, age = iBody.z;
  float old = max(age, 0.0), kid = max(-age, 0.0);
  qHeadK = 1.0 + 0.2 * kid;
  float wid = (1.0 + 0.5 * (g - 1.0));
  qSh = vec3(${J.shX.toFixed(4)} * (1.0 - 0.07 * fem) * wid, ${J.shY.toFixed(4)}, 0.0);
  qHip = vec3(${J.hipX.toFixed(4)} * (1.0 + 0.05 * fem) * wid, ${J.hipY.toFixed(4)}, 0.0);
  qKnee = vec3(${J.kneeX.toFixed(4)} * (1.0 + 0.03 * fem) * wid, ${J.kneeY.toFixed(4)}, ${J.kneeZ.toFixed(4)});
  qEl = vec3(${J.elX.toFixed(4)} * (1.0 - 0.07 * fem) * wid, ${J.elY.toFixed(4)}, ${J.elZ.toFixed(4)});
  float ph0 = iPose.x * 6.2831853;
  qPYaw = 0.0; qSway = 0.0; qBob = 0.0; qTwist = 0.0;
  if (mode == 0) {
    float mv = smoothstep(0.05, 0.35, spd);
    float f = 0.55 + 0.3 * spd;
    float ph = 6.2831853 * uTime * f + ph0;
    float A = mv * clamp(0.16 + 0.19 * spd, 0.0, 0.5) * (1.0 - 0.3 * old);
    float s = sin(ph), c = cos(ph);
    qT = vec2(A * s, -A * s);
    float cl = max(c, 0.0), cr = max(-c, 0.0);
    qK = vec2(A * (0.3 + 2.3 * cl * cl), A * (0.3 + 2.3 * cr * cr)) + 0.04;
    // 长外套/裙：步幅略小（下摆兜着腿）
    if ((msk & ${MASK.COAT}) != 0 || (msk & ${MASK.SKIRT}) != 0) { A *= 0.82; qT = vec2(A * s, -A * s); }
    // 手臂随步态前后摆（约 ±20°），前摆时肘部多屈一些
    float Aa = 0.78 * A + 0.03 * mv;
    qU = vec2(-Aa * s, Aa * s) + 0.04;
    qE = vec2(0.18 + 0.75 * max(qU.x, 0.0), 0.18 + 0.75 * max(qU.y, 0.0)) + 0.14 * mv;
    qAbd = vec2(0.055 + 0.06 * (g - 1.0) + 0.03 * fem);
    qBob = (A / 0.4) * (0.022 * cos(2.0 * ph) - 0.012);
    qSway = 0.012 * s * mv;
    qPYaw = 0.07 * s * mv;
    qTwist = -qPYaw * 1.4;
    qLean = 0.035 * mv + 0.16 * old;
    qHead = -0.5 * qLean;
    // 站立：重心左右换脚、一侧膝微屈、手臂自然下垂
    float idle = 1.0 - mv;
    float sh = sin(uTime * 0.37 + ph0 * 3.0);
    qSway += idle * 0.014 * sh;
    qK += idle * vec2(max(sh, 0.0), max(-sh, 0.0)) * 0.1;
    // 看手机：右臂抬起、前臂横在胸前，低头
    if ((msk & ${MASK.PHONE}) != 0) {
      qU.y = 0.32; qE.y = 1.6; qAbd.y = -0.22; qHead += 0.38;
    }
    // 单肩包：左臂外张压着包、少摆
    if ((msk & ${MASK.SHOULDERBAG}) != 0) { qU.x = qU.x * 0.4 + 0.03; qAbd.x = 0.24; qE.x += 0.15; }
  } else if (mode == 1) {
    // 骑踏板车：大腿前平、小腿略前伸踩踏板，手扶车把
    qT = vec2(1.32); qK = vec2(1.02);
    qU = vec2(0.88); qE = vec2(0.42); qAbd = vec2(0.16);
    qLean = 0.1 + 0.08 * old; qHead = -0.12;
    qSway = 0.006 * sin(uTime * 1.3 + ph0) * smoothstep(0.5, 2.0, spd);
  } else {
    // 骑自行车：蹬踏（曲柄相位），上身前倾
    float cad = 0.2 * spd;
    float cph = 6.2831853 * uTime * cad + ph0;
    float s = sin(cph);
    qT = vec2(1.02 + 0.36 * s, 1.02 - 0.36 * s);
    qK = vec2(1.08 + 0.5 * s, 1.08 - 0.5 * s);
    qU = vec2(0.72); qE = vec2(0.38); qAbd = vec2(0.13);
    qLean = 0.36; qHead = -0.32;
    qPYaw = 0.04 * s * smoothstep(0.5, 2.0, spd);
  }
}
void pBone(int b, inout vec3 p, inout vec3 n) {
  if (b == 9 || b == 10) {
    float sg = b == 9 ? 1.0 : -1.0; int s = b - 9;
    vec3 c = vec3(sg * qEl.x, qEl.y, qEl.z);
    p = c + pRx(p - c, qE[s]); n = pRx(n, qE[s]);
    b = 7 + s;
  }
  if (b == 7 || b == 8) {
    float sg = b == 7 ? 1.0 : -1.0; int s = b - 7;
    vec3 c = vec3(sg * qSh.x, qSh.y, qSh.z);
    p = c + pRz(pRx(p - c, qU[s]), sg * qAbd[s]); n = pRz(pRx(n, qU[s]), sg * qAbd[s]);
    b = 1;
  }
  if (b == 5 || b == 6) {
    float sg = b == 5 ? 1.0 : -1.0; int s = b - 5;
    vec3 c = vec3(sg * qKnee.x, qKnee.y, qKnee.z);
    p = c + pRx(p - c, -qK[s]); n = pRx(n, -qK[s]);
    b = 3 + s;
  }
  if (b == 3 || b == 4) {
    float sg = b == 3 ? 1.0 : -1.0; int s = b - 3;
    vec3 c = vec3(sg * qHip.x, qHip.y, 0.0);
    p = c + pRx(p - c, qT[s]); n = pRx(n, qT[s]);
    b = 0;
  }
  if (b == 2) {
    vec3 c = vec3(0.0, ${J.neckY.toFixed(4)}, ${J.neckZ.toFixed(4)});
    p = c + pRx(p - c, qHead); n = pRx(n, qHead);
    b = 1;
  }
  if (b == 1) {
    vec3 c = vec3(0.0, ${J.waistY.toFixed(4)}, 0.0);
    p = c + pRy(pRx(p - c, -qLean), qTwist); n = pRy(pRx(n, -qLean), qTwist);
  }
  // 骨盆：扭转 + 起伏 + 左右
  p = pRy(p, qPYaw) + vec3(qSway, qBob, 0.0); n = pRy(n, qPYaw);
}
int pParent(int b) {
  if (b == 1 || b == 3 || b == 4) return 0;
  if (b == 2 || b == 7 || b == 8) return 1;
  if (b == 5 || b == 6) return b - 2;
  if (b == 9 || b == 10) return b - 2;
  return 0;
}
void pplPose(inout vec3 p, inout vec3 n) {
  int msk = int(iPose.w + 0.5);
  int pm = int(aPart.z + 0.5);
  int slot = int(aPart.y + 0.5);
  int bone = int(aPart.x + 0.5);
  vPBase = p; vPCode = float(slot) + 16.0 * float(bone);
  if (pm != 0 && (pm & msk) == 0) { p = vec3(0.0); vPCol = vec3(0.0); vPRough = 1.0; vPEm = 0.0; vPH = 0.0; return; }
  float g = iBody.x, fem = iBody.y, old = max(iBody.z, 0.0);
  pplSetup();
  // —— 体型（静止姿态下变形）——
  float ax = aPart.w;
  float y = p.y;
  if (ax > 50.0) {
    // 头部类：儿童头大一些（绕颈根缩放）
    vec3 c = vec3(0.0, ${J.neckY.toFixed(4)}, 0.0);
    p = c + (p - c) * qHeadK;
  } else if (ax > 5.0) {
    // 躯干类：胖瘦、女性腰臀胸
    float sx = g * (1.0 + fem * (0.055 * exp(-pow((y - 0.88) / 0.08, 2.0)) - 0.09 * exp(-pow((y - 1.07) / 0.07, 2.0)) - 0.07 * smoothstep(1.24, 1.42, y)));
    float sz = pow(g, 0.85) * (1.0 + 0.025 * fem * exp(-pow((y - 0.86) / 0.07, 2.0)) * step(p.z, 0.0));
    p.x *= sx; p.z *= sz;
    p.z += step(0.0, p.z) * smoothstep(0.02, 0.09, p.z) * (fem * 0.032 * exp(-pow((y - 1.245) / 0.06, 2.0)) + old * g * 0.025 * exp(-pow((y - 1.04) / 0.09, 2.0)));
  } else {
    // 四肢：绕肢体轴线粗细；手臂/腿整体随肩宽/髋宽平移
    float gl = (1.0 + 0.6 * (g - 1.0)) * (1.0 - 0.05 * fem);
    bool leg = bone >= 3 && bone <= 6;
    if (leg && (msk & ${MASK.SKIRT}) != 0 && slot == ${SLOT.LEG}) gl *= 0.86;
    float sg = sign(ax);
    p.x = ax + (p.x - ax) * gl; p.z *= gl;
    if (leg) p.x += sg * (qHip.x - ${J.hipX.toFixed(4)});
    else p.x += sg * (qSh.x - ${J.shX.toFixed(4)});
  }
  vPH = y;
  // —— 骨骼：本骨骼与父骨骼按权重混合 ——
  if (pm == ${MASK.SKIRT} || pm == ${MASK.COAT}) {
    // 裙/长外套下摆：左右两半跟各自大腿，正中（前后缘）跟更靠前/更靠后的那条腿——迈步时腿不从下摆前方穿出
    vec3 pa = p, na = n, pb = p, nb = n, pc = p, nc = n;
    pBone(3, pa, na); pBone(4, pb, nb); pBone(0, pc, nc);
    float sideL = smoothstep(-0.07, 0.07, p.x);
    vec3 t = mix(pb, pa, sideL);
    vec3 tn = normalize(mix(nb, na, sideL));
    float cen = 1.0 - smoothstep(0.02, 0.13, abs(p.x));
    float zx = p.z >= 0.0 ? max(pa.z, pb.z) : min(pa.z, pb.z);
    t.z = mix(t.z, zx, cen);
    float w = (pm == ${MASK.COAT} ? 0.95 : 0.85) * smoothstep(0.97, 0.5, y);
    p = mix(pc, t, w); n = normalize(mix(nc, tn, w));
  } else {
    vec3 p1 = p, n1 = n;
    pBone(bone, p1, n1);
    if (aW < 0.999) {
      vec3 p0 = p, n0 = n;
      pBone(pParent(bone), p0, n0);
      p1 = mix(p0, p1, aW); n1 = normalize(mix(n0, n1, aW));
    }
    p = p1; n = n1;
  }
  // —— 颜色 ——
  vec3 c;
  float rough = 0.85, em = 0.0;
  if (slot == 0) c = pUnpack(iCol0.x);
  else if (slot == 1) { c = pUnpack(iCol0.y); rough = 0.55; }
  else if (slot == 2) c = pUnpack(iCol0.z);
  else if (slot == 3) c = pUnpack(iCol0.w);
  else if (slot == 4) c = pUnpack(iCol1.x);
  else if (slot == 5) { c = pUnpack(iCol1.y); rough = 0.6; }
  else if (slot == 6) { c = pUnpack(iCol1.z); rough = 0.7; }
  else if (slot == 7) { c = pUnpack(iCol1.w); rough = (msk & ${MASK.HELMET}) != 0 ? 0.35 : 0.8; }
  else if (slot == 8) {
    c = pUnpack(iCol1.x);
    if ((msk & ${MASK.SKIRT}) != 0) c = (msk & ${MASK.DARK_TIGHTS}) != 0 ? vec3(0.012) : pUnpack(iCol0.x) * vec3(0.92, 0.86, 0.82);
  }
  else if (slot == 9) c = (msk & ${MASK.DARK_SOLE}) != 0 ? vec3(0.02) : vec3(0.6, 0.58, 0.55);
  else if (slot == 10) { c = vec3(0.02); rough = 0.3; }
  else if (slot == 11) { c = vec3(0.02, 0.025, 0.035); rough = 0.12; em = 1.0; }
  else if (slot == 12) c = pUnpack(iCol0.y) * 0.4;
  else if (slot == 13) c = pUnpack(iCol0.x) * vec3(0.78, 0.55, 0.52);
  else c = pUnpack(iCol1.z) * 0.55;
  vPCol = c; vPRough = rough; vPEm = em;
}
`;

// 片元细节（全部按静止姿态坐标 vPBase 画，远近两级模型通用）：
//   脸：眼窝阴影、深色眼睛、眉、鼻底阴影、唇色、两颊红润、下颌阴影；头发：发丝明暗 + 发梢略深；
//   衣物：腋下、领下、袖口内侧、裤裆的环境光遮蔽，躯干侧面略暗——近看不再是一块平涂的“人台”
const FACE_GLSL = /* glsl */ `
{
  vec3 cc = vPCol;
  float mxc = max(cc.r, max(cc.g, cc.b));
  cc *= min(1.0, 0.62 / max(mxc, 1e-4));
  int code = int(vPCode + 0.5);
  int pslot = code - (code / 16) * 16, pbone = code / 16;
  vec3 q = vPBase;
  if (pbone == 2 && pslot == 0) {
    float front = smoothstep(0.035, 0.07, q.z);
    float ax = abs(q.x);
    vec2 e = vec2(ax - 0.031, q.y - 1.597);
    float sock = 1.0 - smoothstep(0.011, 0.026, length(e * vec2(0.8, 1.35)));
    float eye = 1.0 - smoothstep(0.0055, 0.0085, length(e * vec2(0.62, 1.5)));
    float brow = (1.0 - smoothstep(0.013, 0.017, abs(ax - 0.034))) * (1.0 - smoothstep(0.0025, 0.0045, abs(q.y - 1.618 + 0.1 * (ax - 0.034))));
    float lip = (1.0 - smoothstep(0.014, 0.019, ax)) * (1.0 - smoothstep(0.0035, 0.006, abs(q.y - 1.524)));
    float nose = (1.0 - smoothstep(0.008, 0.016, ax)) * (1.0 - smoothstep(0.002, 0.008, abs(q.y - 1.545)));
    float cheek = 1.0 - smoothstep(0.0, 0.026, length(vec2(ax - 0.046, q.y - 1.566)));
    float jaw = smoothstep(1.53, 1.495, q.y) * (0.4 + 0.6 * smoothstep(0.02, 0.06, ax));
    cc *= 1.0 - 0.3 * sock * front;
    cc = mix(cc, vec3(0.018, 0.014, 0.012), eye * front);
    cc = mix(cc, cc * 0.32, brow * front);
    cc = mix(cc, cc * vec3(0.9, 0.52, 0.5), lip * front);
    cc *= 1.0 - 0.22 * nose * front;
    cc = mix(cc, cc * vec3(1.06, 0.88, 0.86), cheek * front * 0.6);
    cc *= 1.0 - 0.2 * jaw;
  } else if (pslot == 1) {
    float ang = atan(q.x, q.z + 0.02);
    float strand = 0.5 + 0.5 * sin(ang * 46.0 + q.y * 9.0);
    cc *= (0.8 + 0.28 * strand) * (0.85 + 0.15 * smoothstep(1.45, 1.66, q.y));
  } else if (pslot == 2 || pslot == 3 || pslot == 4 || pslot == 8) {
    float ao = 0.0;
    float ax = abs(q.x);
    // 腋下（躯干侧面挨着上臂处）与上臂内侧
    if (pbone <= 1) ao += 0.3 * smoothstep(0.13, 0.17, ax) * smoothstep(1.02, 1.2, q.y) * (1.0 - smoothstep(1.3, 1.38, q.y));
    if (pbone == 7 || pbone == 8) ao += 0.22 * smoothstep(0.205, 0.17, ax) * smoothstep(1.4, 1.25, q.y);
    // 领下、腰带下沿、裆部
    if (pbone <= 1) ao += 0.22 * smoothstep(1.39, 1.43, q.y) * (1.0 - smoothstep(0.06, 0.1, ax));
    if (pbone <= 1) ao += 0.12 * (1.0 - smoothstep(0.86, 0.9, q.y)) * smoothstep(0.82, 0.86, q.y);
    if (pbone >= 3 && pbone <= 6) ao += 0.25 * smoothstep(0.06, 0.035, ax) * smoothstep(0.7, 0.86, q.y);
    // 袖口、裤脚内侧
    if (pbone >= 9) ao += 0.15 * smoothstep(0.9, 0.85, q.y);
    cc *= 1.0 - min(ao, 0.45);
  }
  diffuseColor.rgb = cc;
}
`;
const uLitShared = { value: 0 };
/**
 * 人形材质（MeshStandardMaterial + 顶点骨骼）。夜间“路灯/店面补光”强度 = setPeopleLit(v)（全局共享）。
 */
export function peopleMaterial(ctx) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.uniforms.uLit = uLitShared;
    sh.uniforms.uNightP = ctx.uniforms.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + POSE_GLSL)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(normal);\nvec3 pplP = vec3(position);\npplPose(pplP, objectNormal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = pplP;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLit;\nuniform float uNightP;\nvarying vec3 vPCol;\nvarying float vPRough;\nvarying float vPEm;\nvarying float vPH;\nvarying vec3 vPBase;\nflat varying float vPCode;')
      // 反照率上限 0.62（白衣在近处点光源下不过曝）：按最大分量等比缩放、保持色相（原先逐通道截断把肤色的红削掉，脸发灰发绿）
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FACE_GLSL)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vPRough;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.78, 0.55) * uLit * (0.3 + 0.7 * smoothstep(0.3, 1.6, vPH));
        totalEmissiveRadiance += vPEm * vec3(0.55, 0.7, 1.0) * (0.15 + 1.6 * uNightP);`
      );
  };
  mat.customProgramCacheKey = () => 'xianPeople|v2';
  return mat;
}
/** 阴影深度材质（同样的姿态） */
export function peopleDepthMaterial(ctx) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + POSE_GLSL)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\nvec3 pplN = vec3(0.0, 1.0, 0.0);\npplPose(transformed, pplN);');
  };
  m.customProgramCacheKey = () => 'xianPeopleDepth|v1';
  return m;
}
/** 夜间补光强度（行人与骑手共用） */
export function setPeopleLit(v) { uLitShared.value = v; }

/**
 * 实例化人群网格：geometry 克隆一份挂实例属性；返回 PeopleWriter。
 */
export function createPeopleMesh(ctx, geo, mat, cap, name) {
  const g = geo.clone();
  const mk = (k) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, a); return a; };
  const attrs = [mk('iPose'), mk('iBody'), mk('iCol0'), mk('iCol1')];
  const mesh = new THREE.InstancedMesh(g, mat, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = name;
  return new PeopleWriter(mesh, attrs);
}
export class PeopleWriter {
  constructor(mesh, attrs) {
    this.mesh = mesh;
    this.attrs = attrs;
    this.M = mesh.instanceMatrix.array;
    this.arr = attrs.map((a) => a.array);
    this.cap = mesh.instanceMatrix.count;
    this.n = 0;
  }
  reset() { this.n = 0; }
  full() { return this.n >= this.cap; }
  /** 写一个人：位置、朝向（绕 y 的角度，0 = 面朝 +z）、整体缩放、外观 ap（见 randomLook） */
  put(x, y, z, yaw, scale, ap, phase, speed, mode) {
    const i = this.n++;
    const M = this.M, o = i * 16;
    const c = Math.cos(yaw) * scale, s = Math.sin(yaw) * scale;
    M[o] = c; M[o + 1] = 0; M[o + 2] = -s; M[o + 3] = 0;
    M[o + 4] = 0; M[o + 5] = scale; M[o + 6] = 0; M[o + 7] = 0;
    M[o + 8] = s; M[o + 9] = 0; M[o + 10] = c; M[o + 11] = 0;
    M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
    const [P, Bd, C0, C1] = this.arr, q = i * 4;
    P[q] = phase; P[q + 1] = speed; P[q + 2] = mode; P[q + 3] = ap.mask;
    Bd[q] = ap.girth; Bd[q + 1] = ap.fem; Bd[q + 2] = ap.age; Bd[q + 3] = 0;
    const c0 = ap.cols;
    C0[q] = c0[0]; C0[q + 1] = c0[1]; C0[q + 2] = c0[2]; C0[q + 3] = c0[3];
    C1[q] = c0[4]; C1[q + 1] = c0[5]; C1[q + 2] = c0[6]; C1[q + 3] = c0[7];
    return i;
  }
  /** 写一个带完整矩阵的人（骑手：跟随车辆的俯仰） */
  putMatrix(m16, ap, phase, speed, mode) {
    const i = this.n++;
    this.M.set(m16, i * 16);
    const [P, Bd, C0, C1] = this.arr, q = i * 4;
    P[q] = phase; P[q + 1] = speed; P[q + 2] = mode; P[q + 3] = ap.mask;
    Bd[q] = ap.girth; Bd[q + 1] = ap.fem; Bd[q + 2] = ap.age; Bd[q + 3] = 0;
    const c0 = ap.cols;
    C0[q] = c0[0]; C0[q + 1] = c0[1]; C0[q + 2] = c0[2]; C0[q + 3] = c0[3];
    C1[q] = c0[4]; C1[q + 1] = c0[5]; C1[q + 2] = c0[6]; C1[q + 3] = c0[7];
    return i;
  }
  commit() {
    const n = this.n;
    const mesh = this.mesh;
    mesh.count = n;
    mesh.visible = n > 0;
    const im = mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, Math.max(1, n) * 16); im.needsUpdate = true;
    for (const a of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * 4); a.needsUpdate = true; }
  }
}

// ———————————————————— 外观（10 月西安街头）————————————————————
const pick = (r, arr) => arr[Math.min(arr.length - 1, (r * arr.length) | 0)];
function wpick(r, list) {
  let s = 0;
  for (const [, w] of list) s += w;
  let x = r * s;
  for (const [v, w] of list) { x -= w; if (x <= 0) return v; }
  return list[list.length - 1][0];
}
// 外套/卫衣/毛衣：黑白灰藏青驼色为主，少量酒红、墨绿、雾蓝、芥末黄等低饱和色
const TOPS_M = [[0x1c1d20, 18], [0x2b2d31, 8], [0x3d4046, 7], [0x6d7076, 6], [0x9a9da2, 4], [0x24324a, 9], [0x2f3d55, 4], [0xd9d6cf, 5], [0xb7a385, 5], [0x8b6d4c, 4],
  [0x4b4f3a, 5], [0x5d4a3a, 3], [0x5b2b2d, 2], [0x46607a, 4], [0x6e7d6a, 2], [0xa98d3e, 1], [0x8a3a30, 1], [0x2e4a3c, 2]];
const TOPS_F = [[0x1c1d20, 12], [0xd9d6cf, 9], [0xe6dfd2, 5], [0xb9a080, 8], [0x9a7a5a, 5], [0x8a8d92, 5], [0x2c3446, 6], [0xc49a9a, 4], [0x8e4a4e, 3], [0x5f6e86, 4],
  [0x7b8a73, 3], [0xc8a24a, 2], [0x3d4a3e, 2], [0xa8b8c8, 3], [0x6a4a5a, 2], [0xe8e4dc, 3], [0x4a3a32, 3]];
const INNER = [[0xe8e6e0, 10], [0x2a2b2e, 6], [0x9fa3a8, 4], [0xd8cfc0, 3], [0x5a6a80, 2], [0x8a6a52, 1]];
const PANTS_M = [[0x22314a, 12], [0x34496a, 7], [0x5d7896, 3], [0x1b1b1d, 14], [0x3a3b3f, 8], [0x77736a, 4], [0x8e7f63, 5], [0x5c5a52, 3], [0x4a4036, 2], [0x8b8d91, 3]];
const PANTS_F = [[0x22314a, 8], [0x4a6486, 6], [0x7b93ad, 3], [0x1b1b1d, 14], [0x3a3b3f, 4], [0xd8d2c6, 4], [0x9c8a6c, 4], [0x6b5a4a, 2], [0x8b8d91, 2]];
const SKIRTS = [[0x1b1b1d, 6], [0x3a3d36, 3], [0xb39a78, 4], [0x6a3034, 2], [0x2c3446, 3], [0x8a8d92, 2], [0x5a4a3a, 2], [0xd6cfc2, 2]];
const SHOES = [[0xe6e5e1, 34], [0x1c1c1c, 26], [0x8a8a88, 8], [0x4a3426, 8], [0xc8b89a, 5], [0x2a3550, 3], [0x6a5040, 3]];
const HAIR = [[0x15110e, 60], [0x22180f, 18], [0x3a2618, 9], [0x4e3220, 5], [0x5a3a24, 3], [0x2a1f1a, 5]];
const HAIR_OLD = [[0x8c8884, 3], [0xb2aea8, 2], [0x4a4644, 2], [0x15110e, 2]];
const SKIN = [0xe3bf9e, 0xdcb391, 0xd4a886, 0xcc9d7b, 0xe8c8aa, 0xc39270];
const BAGS = [[0x1a1a1c, 10], [0x4a3426, 5], [0x8a6a4a, 4], [0xc8b69a, 3], [0x2c3446, 3], [0x7a7c80, 3], [0x7a2a2a, 1], [0xe0dcd4, 2]];
const CAPS = [[0x1a1a1c, 6], [0xe6e4de, 3], [0x2c3446, 3], [0xb8a688, 2], [0x5a5f4a, 1], [0x8a3030, 1]];
const BEANIES = [[0x2a2a2c, 4], [0x6e6a64, 2], [0x3a3048, 1], [0x8a6a4a, 1]];
const HELMETS = [[0xeeeeea, 8], [0x1a1a1c, 6], [0xf2c200, 3], [0x2f6fc0, 2], [0xe46a8a, 2], [0xc8302c, 2], [0x8a8d92, 3], [0xa8cfe0, 1]];

/**
 * 随机外观。opts.rider：骑手（戴头盔、不拿手机）；opts.courier：'meituan' | 'eleme' 外卖骑手（黄/蓝工装 + 同色头盔）
 * 返回 { mask, girth, fem, age, height, speedK, cols:[皮肤,头发,上衣,内搭,下装,鞋,包,帽] }
 */
export function randomLook(rnd, opts = {}) {
  const M = MASK;
  const rider = !!opts.rider;
  const fem = rnd() < (rider ? 0.32 : 0.5) ? 1 : 0;
  const ar = rnd();
  let age = 0;
  if (!rider && ar < 0.05) age = -(0.4 + rnd() * 0.6); // 儿童/少年
  else if (ar < (rider ? 0.1 : 0.2)) age = 0.5 + rnd() * 0.5; // 老人
  const kid = Math.max(0, -age), old = Math.max(0, age);
  // 身高：男 1.62~1.85、女 1.53~1.72（近似正态），老人略矮，儿童 1.15~1.5
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 0.82;
  let height = fem ? 1.61 + gauss() * 0.05 : 1.72 + gauss() * 0.06;
  height -= old * 0.04;
  if (kid) height = 1.5 - kid * 0.35 + gauss() * 0.04;
  height = Math.min(fem ? 1.74 : 1.88, Math.max(kid ? 1.1 : 1.52, height));
  let girth = 0.94 + rnd() * 0.16 + (rnd() < 0.18 ? 0.12 : 0) + old * 0.06 - kid * 0.08 - fem * 0.03;
  if (rnd() < 0.12) girth -= 0.06;
  let mask = 0;
  // 发型
  const hr = rnd();
  if (fem) mask |= old ? (hr < 0.7 ? M.HAIR_BOB : M.HAIR_SHORT) : hr < 0.45 ? M.HAIR_LONG : hr < 0.72 ? M.HAIR_PONY : hr < 0.9 ? M.HAIR_BOB : M.HAIR_SHORT;
  else mask |= M.HAIR_SHORT;
  // 衣着
  const outer = wpick(rnd(), fem ? TOPS_F : TOPS_M);
  let inner = wpick(rnd(), INNER);
  let bottom = wpick(rnd(), fem ? PANTS_F : PANTS_M);
  if (fem && !kid && rnd() < 0.2) { mask |= M.SKIRT; bottom = wpick(rnd(), SKIRTS); if (rnd() < 0.6) mask |= M.DARK_TIGHTS; }
  if (!kid && rnd() < (fem ? 0.16 : 0.08)) mask |= M.COAT; // 风衣/长外套
  else if (rnd() < 0.3) mask |= M.OPEN; // 敞怀夹克露内搭
  if (!(mask & M.COAT) && rnd() < (kid ? 0.4 : 0.18)) mask |= M.HOOD; // 卫衣帽兜
  const shoes = wpick(rnd(), SHOES);
  if (shoes === 0x4a3426 || (shoes === 0x1c1c1c && rnd() < 0.5)) mask |= M.DARK_SOLE;
  let hat = 0x1a1a1c;
  // 帽子
  if (rider) { mask |= M.HELMET; hat = wpick(rnd(), HELMETS); }
  else {
    const hp = rnd();
    if (hp < (fem ? 0.04 : old ? 0.22 : 0.09)) { mask |= M.CAP; hat = wpick(rnd(), CAPS); }
    else if (hp < (fem ? 0.06 : old ? 0.3 : 0.11)) { mask |= M.BEANIE; hat = wpick(rnd(), BEANIES); }
  }
  // 包与手机
  let bag = wpick(rnd(), BAGS);
  if (!rider) {
    const bp = rnd();
    if (bp < (kid ? 0.75 : old ? 0.05 : 0.22)) mask |= M.BACKPACK;
    else if (bp < (fem ? 0.6 : 0.3)) mask |= fem && rnd() < 0.6 ? M.SHOULDERBAG : M.CROSSBAG;
    if (rnd() < (old ? 0.06 : 0.2)) mask |= M.PHONE;
  } else if (rnd() < 0.15) mask |= M.BACKPACK;
  let top = outer;
  // 上下装别撞色成“连体衣”：颜色太接近就换一条裤子
  const near = (a, b) => Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs((a & 255) - (b & 255)) < 70;
  for (let k = 0; k < 4 && near(outer, bottom); k++) bottom = wpick(rnd(), mask & M.SKIRT ? SKIRTS : fem ? PANTS_F : PANTS_M);
  // 外卖骑手：美团黄 / 饿了么蓝工装 + 同色头盔
  if (opts.courier === 'meituan') { top = 0xf2bf1a; inner = 0x2a2a2a; hat = 0xf2c200; mask &= ~(M.COAT | M.HOOD); mask |= M.OPEN; }
  else if (opts.courier === 'eleme') { top = 0x1f8ae0; inner = 0xe8e8e8; hat = 0x1f8ae0; mask &= ~(M.COAT | M.HOOD); }
  if (kid && rnd() < 0.5) top = pick(rnd(), [0x2f6fc0, 0xd84a3a, 0xe8c040, 0x3a9a6a, 0xe68aa0, 0x5a6ad0]);
  const hairC = old && rnd() < 0.75 ? wpick(rnd(), HAIR_OLD) : wpick(rnd(), HAIR);
  const skin = pick(rnd(), SKIN);
  const speedK = old ? 0.7 : kid ? 0.95 : 1;
  return { mask, girth, fem: fem * (kid ? 0.3 : 1), age, height, speedK, cols: [skin, hairC, top, inner, bottom, shoes, bag, hat] };
}
