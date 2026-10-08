// 地铁车站站体（按需生成，只在地下浏览时构建离相机近的车站）：
//   站台层：岛式站台（花岗岩铺地 + 盲道 + 门前候车标线 + 中线导向带）、两排站台柱（包板 + 不锈钢柱脚/柱帽）、
//           全高屏蔽门（玻璃 + 立柱 + 门楣深灰包板 + 线路色带 + 门头指示灯 + 站名牌）、铝格栅吊顶与三条灯带
//           （6 号线为“古今长安”屋脊式吊顶，钟楼一带赭石/木色）、轨行区（道床 + 钢轨）、侧墙（搪瓷钢板 + 线路色带
//           + 站名牌与灯箱广告，隔着屏蔽门玻璃可见）、站台端墙、两组楼梯 + 扶梯（逐级踏步、防滑条、玻璃栏板、扶手）、
//           导向吊牌（出口 / 换乘）；
//   站厅层：花岗岩铺地（楼梯洞口 + 玻璃栏杆）、格栅吊顶与灯带、闸机群与栏杆、售票机、线路色导向带、
//           端墙文化墙（古城一带为木色窗棂装饰板）、通往各出入口的通道（墙上开洞、末段踏步）。
// 一座车站 ≈ 11 次绘制调用（每种材质合并成一个网格）；几何在局部框架 (u 沿站台, v 横向, y 自轨面向上) 里生成。
import * as THREE from 'three';
import { metroMaterials, signTexture } from './metro-tex.js';

// —— 尺寸（米） ——
export const PLAT_L = 120;   // 站台长（B 型车 6 节编组）
export const HALL_L = 150;   // 车站主体长
export const HALL_W = 22;    // 车站主体宽（岛式站台 12 m + 两侧轨行区）
export const PLAT_W = 12;
export const PLAT_H = 1.05;  // 站台面高出轨面
export const LVL_H = 4.6;    // 站台层结构净高
export const SLAB = 0.8;
export const CONC_H = 5.2;   // 站厅层结构净高
export const TRACK_V = 7.6;  // 轨道中心距站台中线
const CEIL_P = 3.3;          // 站台吊顶高（站台面以上）
const CEIL_C = 3.6;          // 站厅吊顶高
const STAIR_U = 22, STAIR_RUN = 12, STAIR_HW = 1.9, HOLE_HW = 2.05; // 楼梯：脚在 |u|=22，顶在 |u|=34
const COL_V = 2.6;           // 站台柱列
const Y = (() => {
  const yP = PLAT_H, yTop = PLAT_H + LVL_H, yC0 = yTop + SLAB;
  return { yP, yCl: yP + CEIL_P, yTop, yC0, yCc: yC0 + CEIL_C, yC1: yC0 + CONC_H };
})();
export const LEVELS = Y;

const C = (hex) => new THREE.Color(hex);
const mul = (c, k) => c.clone().multiplyScalar(k);

/** 主题：6 号线“古今长安”（钟楼一带赭石色，向西南渐变科技蓝、向东生态绿，屋脊式吊顶）；古城内其他线加窗棂装饰；其余现代灰白 */
function themeOf(b) {
  const d = Math.hypot(b.cx, b.cz);
  if (b.l.num === 6) {
    if (d < 2800) return { name: 'ochre', wall: C('#c58f62'), col: C('#eadcc8'), ceil: C('#d8a56e'), ridge: true, deco: true };
    return b.cx < 0
      ? { name: 'blue', wall: C('#a9c3dc'), col: C('#eef2f5'), ceil: C('#ffffff'), ridge: true, deco: false }
      : { name: 'green', wall: C('#b9d6b2'), col: C('#eef3ec'), ceil: C('#ffffff'), ridge: true, deco: false };
  }
  if (d < 2600) return { name: 'ancient', wall: C('#ddd3c2'), col: C('#f0ebe2'), ceil: C('#efe2cc'), ridge: false, deco: true };
  return { name: 'modern', wall: C('#eeece7'), col: C('#f2f1ee'), ceil: C('#ffffff'), ridge: false, deco: false };
}

/** 按材质分桶的三角形收集器；quad 的 UV 以米为单位，按面朝向自动取平面投影（与相邻面连续） */
class Geo {
  constructor() { this.p = []; this.c = []; this.t = []; }
  push(P, col, uv) {
    this.p.push(P[0], P[1], P[2]);
    this.c.push(col.r, col.g, col.b);
    this.t.push(uv[0], uv[1]);
  }
  build(mat, name) {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.matrixAutoUpdate = false;
    return m;
  }
}

/** 局部框架里的几何写入器：F(u,v,y) → 世界坐标 */
class Kit {
  constructor(F) { this.F = F; this.g = {}; }
  geo(k) { return this.g[k] || (this.g[k] = new Geo()); }
  /** 四边形（局部坐标 A→B→C→D），col 为颜色或四角颜色数组，uvs 可显式给出（站名牌等） */
  quad(k, A, B, Cc, D, col, uvs = null) {
    const G = this.geo(k);
    const cs = Array.isArray(col) ? col : [col, col, col, col];
    let T = uvs;
    if (!T) {
      // 面法向（局部）→ 投影平面：水平面 (u,v)，沿 u 的竖直面 (u,y)，沿 v 的竖直面 (v,y)
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
      const n = [Math.abs(e1[1] * e2[2] - e1[2] * e2[1]), Math.abs(e1[2] * e2[0] - e1[0] * e2[2]), Math.abs(e1[0] * e2[1] - e1[1] * e2[0])];
      const pr = n[2] >= n[0] && n[2] >= n[1] ? (P) => [P[0], P[1]] : n[1] >= n[0] ? (P) => [P[0], P[2]] : (P) => [P[1], P[2]];
      T = [pr(A), pr(B), pr(Cc), pr(D)];
    }
    const W = [A, B, Cc, D].map((P) => this.F(P[0], P[1], P[2]));
    for (const i of [0, 1, 2, 0, 2, 3]) G.push(W[i], cs[i], T[i]);
  }
  tri(k, A, B, Cc, col) {
    const G = this.geo(k);
    const W = [A, B, Cc].map((P) => this.F(P[0], P[1], P[2]));
    // 竖直三角（楼梯侧板）：按 (u,y) 投影
    for (let i = 0; i < 3; i++) G.push(W[i], col, [[A, B, Cc][i][0], [A, B, Cc][i][2]]);
  }
  /** 轴对齐盒（局部坐标），faces：省略的面用 skip 集合 */
  box(k, u0, u1, v0, v1, y0, y1, col, { top = col, bottom = null, skip = '' } = {}) {
    const P = (u, v, y) => [u, v, y];
    const a = P(u0, v0, y0), b = P(u1, v0, y0), c = P(u1, v1, y0), d = P(u0, v1, y0);
    const e = P(u0, v0, y1), f = P(u1, v0, y1), g = P(u1, v1, y1), h = P(u0, v1, y1);
    if (!skip.includes('t')) this.quad(k, e, f, g, h, top);
    if (bottom) this.quad(k, a, b, c, d, bottom);
    const lo = mul(col, 0.86);
    const sides = [[a, b, f, e, 'n'], [b, c, g, f, 'e'], [c, d, h, g, 's'], [d, a, e, h, 'w']];
    for (const [p0, p1, p2, p3, nm] of sides) if (!skip.includes(nm)) this.quad(k, p0, p1, p2, p3, [lo, lo, col, col]);
  }
  /** 站名牌/灯箱：A 左下、B 右下（从观看一侧看） */
  sign(A, B, Cc, D, r) {
    this.quad('sign', A, B, Cc, D, WHITE, [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]);
  }
}
const WHITE = C('#ffffff');

/** 区间 [a,b] 减去若干洞口区间，返回剩余区间 */
function subtract(a, b, holes) {
  let segs = [[a, b]];
  for (const [h0, h1] of holes) {
    const out = [];
    for (const [s0, s1] of segs) {
      if (h1 <= s0 || h0 >= s1) { out.push([s0, s1]); continue; }
      if (h0 > s0) out.push([s0, h0]);
      if (h1 < s1) out.push([h1, s1]);
    }
    segs = out;
  }
  return segs.filter(([s0, s1]) => s1 - s0 > 0.05);
}

/** 站台层 + 站厅层（一个站体 = 一站一线） */
function buildBox(K, b, lineColor, rects) {
  const { yP, yCl, yTop, yC0, yCc } = Y;
  const hl = HALL_L / 2, hw = HALL_W / 2, pl = PLAT_L / 2, pw = PLAT_W / 2;
  const th = themeOf(b);
  const lc = C(lineColor(b.l.num));
  const wallC = th.wall, colC = th.col, ceilC = th.ceil;
  const dark = C('#4a4c50'), conc = C('#8b8a85'), concD = C('#5b5a56');
  const steel = C('#cdd1d5'), steelD = C('#7e858c'), black = C('#1d1f22');
  const floorC = C('#f2efea');
  const holes = [[-STAIR_U - STAIR_RUN - 0.2, -STAIR_U + 0.5], [STAIR_U - 0.5, STAIR_U + STAIR_RUN + 0.2]];
  const holeV = HOLE_HW;
  const ao = (c) => [mul(c, 0.72), mul(c, 0.72), c, c]; // 下暗上亮（墙脚环境遮蔽）

  // —— 轨行区：道床、钢轨、顶板、端墙洞口 ——
  for (const s of [-1, 1]) {
    K.quad('conc', [-hl, s * pw, -0.5], [hl, s * pw, -0.5], [hl, s * hw, -0.5], [-hl, s * hw, -0.5], C('#77756f'));
    for (const dv of [-0.75, 0.75]) K.box('metal', -hl, hl, s * TRACK_V + dv - 0.04, s * TRACK_V + dv + 0.04, -0.5, -0.32, C('#6d7075'), { top: C('#b9bec4'), skip: 'we' });
    K.quad('conc', [-hl, s * (pw + 0.2), yTop], [hl, s * (pw + 0.2), yTop], [hl, s * hw, yTop], [-hl, s * hw, yTop], concD);
    // 侧墙（搪瓷钢板，隔着屏蔽门可见）
    K.quad('wall', [-hl, s * hw, -0.5], [hl, s * hw, -0.5], [hl, s * hw, yTop], [-hl, s * hw, yTop], ao(wallC));
    K.quad('paint', [-hl, s * (hw - 0.01), yP + 1.95], [hl, s * (hw - 0.01), yP + 1.95], [hl, s * (hw - 0.01), yP + 2.12], [-hl, s * (hw - 0.01), yP + 2.12], lc);
    // 站名牌与灯箱广告交替（看向 +v 时文字从 +u 往 -u 排）
    for (let k = 0; k < 5; k++) {
      const un = -48 + k * 24, ua = -36 + k * 24, v = s * (hw - 0.03);
      const L = (u0, u1) => (s > 0 ? [u1, u0] : [u0, u1]);
      const [n0, n1] = L(un - 3.4, un + 3.4);
      K.sign([n0, v, yP + 0.8], [n1, v, yP + 0.8], [n1, v, yP + 1.8], [n0, v, yP + 1.8], rects.name);
      K.box('metal', un - 3.5, un + 3.5, v - 0.02 * s, v + 0.02 * s, yP + 0.72, yP + 0.8, steelD, { skip: 'we' });
      const [a0, a1] = L(ua - 1.4, ua + 1.4);
      K.sign([a0, v, yP + 0.65], [a1, v, yP + 0.65], [a1, v, yP + 1.87], [a0, v, yP + 1.87], k % 2 ? rects.ad1 : rects.ad0);
    }
    // 端墙：轨行区（隧道洞口涂黑）；站台端以外轨行区内侧为设备区隔墙
    for (const u of [-hl, hl]) {
      K.quad('conc', [u, s * pw, -0.5], [u, s * hw, -0.5], [u, s * hw, yTop], [u, s * pw, yTop], conc);
      K.quad('paint', [u * 0.999, s * (pw + 0.1), -0.5], [u * 0.999, s * (hw - 0.6), -0.5], [u * 0.999, s * (hw - 0.6), 4.4], [u * 0.999, s * (pw + 0.1), 4.4], C('#050506'));
      const ue = Math.sign(u) * pl;
      K.quad('conc', [ue, s * pw, -0.5], [u, s * pw, -0.5], [u, s * pw, yTop], [ue, s * pw, yTop], [mul(conc, 0.8), mul(conc, 0.8), conc, conc]);
    }
  }

  // —— 站台：铺地、站台边、盲道、门前标线、中线导向带 ——
  K.quad('floor', [-pl, -pw, yP], [pl, -pw, yP], [pl, pw, yP], [-pl, pw, yP], floorC);
  for (const s of [-1, 1]) {
    K.quad('conc', [-pl, s * pw, -0.5], [pl, s * pw, -0.5], [pl, s * pw, yP], [-pl, s * pw, yP], conc);
    K.quad('tactile', [-pl + 1, s * (pw - 1.15), yP], [pl - 1, s * (pw - 1.15), yP], [pl - 1, s * (pw - 0.75), yP], [-pl + 1, s * (pw - 0.75), yP], WHITE);
  }
  for (const u of [-pl, pl]) K.quad('conc', [u, -pw, -0.5], [u, pw, -0.5], [u, pw, yP], [u, -pw, yP], conc);
  const doors = [];
  for (let c = 0; c < 6; c++) for (let k = 0; k < 4; k++) doors.push(-58.5 + 19.5 * c + 2.4 + 4.9 * k);
  const green = C('#2f9e5c'), pale = C('#d9d9d4');
  for (const s of [-1, 1]) for (const ud of doors) {
    const v0 = s * (pw - 0.66), v1 = s * (pw - 0.12);
    for (const [a, bb, col] of [[ud - 0.95, ud - 0.6, green], [ud + 0.6, ud + 0.95, green], [ud - 0.28, ud + 0.28, pale]]) {
      K.quad('paint', [a, v0, yP], [bb, v0, yP], [bb, v1, yP], [a, v1, yP], col);
    }
  }
  const guide = lc.clone().lerp(C('#9a968f'), 0.5);
  for (const [a, bb] of subtract(-pl + 2, pl - 2, holes)) K.quad('paint', [a, -0.06, yP], [bb, -0.06, yP], [bb, 0.06, yP], [a, 0.06, yP], guide);

  // —— 站台柱 ——
  for (let u = -54; u <= 54; u += 9) for (const v of [-COL_V, COL_V]) {
    K.box('wall', u - 0.4, u + 0.4, v - 0.4, v + 0.4, yP + 0.15, yCl - 0.2, colC, { skip: 't' });
    K.box('metal', u - 0.44, u + 0.44, v - 0.44, v + 0.44, yP, yP + 0.15, steelD, { top: steel });
    K.box('metal', u - 0.5, u + 0.5, v - 0.5, v + 0.5, yCl - 0.2, yCl + (th.ridge ? 0.6 : 0), steel, { skip: 't', bottom: steel });
  }

  // —— 屏蔽门（全高）：玻璃、立柱、门槛、门楣（深灰包板 + 线路色带 + 门头灯 + 站名牌）、门楣以上封板 ——
  const psdL = 58.6;
  for (const s of [-1, 1]) {
    const v = s * pw;
    K.quad('glass', [-psdL, v, yP], [psdL, v, yP], [psdL, v, yP + 2.3], [-psdL, v, yP + 2.3], C('#d6eef6'));
    K.box('metal', -psdL, psdL, v - 0.12, v + 0.12, yP, yP + 0.1, steelD, { top: steel });
    for (const ud of doors) for (const e of [-0.95, 0.95]) K.box('metal', ud + e - 0.05, ud + e + 0.05, v - 0.06, v + 0.06, yP, yP + 2.3, steel, { skip: 'tb' });
    for (let i = 0; i < doors.length - 1; i++) {
      const um = (doors[i] + doors[i + 1]) / 2;
      K.box('metal', um - 0.04, um + 0.04, v - 0.05, v + 0.05, yP, yP + 2.3, steelD, { skip: 'tb' });
    }
    const vf = s * (pw - 0.2), vb = s * (pw + 0.2);
    K.quad('wall', [-psdL, vf, yP + 2.3], [psdL, vf, yP + 2.3], [psdL, vf, yCl], [-psdL, vf, yCl], C('#5b6067'));
    K.quad('metal', [-psdL, vf, yP + 2.3], [psdL, vf, yP + 2.3], [psdL, vb, yP + 2.3], [-psdL, vb, yP + 2.3], steelD);
    K.quad('metal', [-psdL, vb, yP + 2.3], [psdL, vb, yP + 2.3], [psdL, vb, yCl], [-psdL, vb, yCl], dark);
    const vf2 = s * (pw - 0.21);
    K.quad('paint', [-psdL, vf2, yP + 2.34], [psdL, vf2, yP + 2.34], [psdL, vf2, yP + 2.46], [-psdL, vf2, yP + 2.46], lc);
    for (const ud of doors) K.quad('light', [ud - 0.22, vf2, yP + 2.53], [ud + 0.22, vf2, yP + 2.53], [ud + 0.22, vf2, yP + 2.6], [ud - 0.22, vf2, yP + 2.6], C('#ffae42'));
    for (let c = 0; c < 6; c++) {
      const uc = -48.75 + 19.5 * c;
      const [a0, a1] = s > 0 ? [uc + 1.75, uc - 1.75] : [uc - 1.75, uc + 1.75];
      K.sign([a0, vf2, yP + 2.68], [a1, vf2, yP + 2.68], [a1, vf2, yP + 3.2], [a0, vf2, yP + 3.2], rects.name);
    }
    // 门楣以上到顶板的封板
    K.quad('wall', [-hl, s * pw, yCl], [hl, s * pw, yCl], [hl, s * pw, yTop], [-hl, s * pw, yTop], mul(wallC, 0.55));
  }

  // —— 站台吊顶（铝格栅；6 号线屋脊式），三条灯带，楼梯洞口处断开 ——
  const cv = pw - 0.2;
  const ridgeY = (v) => yCl + (th.ridge ? 0.6 * (1 - Math.abs(v) / cv) : 0);
  for (const [a, bb] of subtract(-pl, pl, holes)) {
    for (const s of [-1, 1]) K.quad('ceil', [a, 0, ridgeY(0)], [bb, 0, ridgeY(0)], [bb, s * cv, ridgeY(cv)], [a, s * cv, ridgeY(cv)], [ceilC, ceilC, mul(ceilC, 0.9), mul(ceilC, 0.9)]);
    K.quad('light', [a, -0.09, ridgeY(0) - 0.02], [bb, -0.09, ridgeY(0) - 0.02], [bb, 0.09, ridgeY(0) - 0.02], [a, 0.09, ridgeY(0) - 0.02], C('#fff4e2'));
  }
  for (const [h0, h1] of holes) for (const s of [-1, 1]) {
    K.quad('ceil', [h0, s * holeV, ridgeY(holeV)], [h1, s * holeV, ridgeY(holeV)], [h1, s * cv, ridgeY(cv)], [h0, s * cv, ridgeY(cv)], ceilC);
  }
  for (const s of [-1, 1]) {
    const vl = s * 3.9, yl = ridgeY(3.9) - 0.02;
    K.quad('light', [-pl, vl - 0.11, yl], [pl, vl - 0.11, yl], [pl, vl + 0.11, yl], [-pl, vl + 0.11, yl], C('#fff4e2'));
  }
  if (th.ridge) {
    // 屋脊：中线一道深色脊檩
    for (const [a, bb] of subtract(-pl, pl, holes)) K.box('metal', a, bb, -0.3, 0.3, ridgeY(0) + 0.02, ridgeY(0) + 0.12, mul(ceilC, 0.55), { skip: 't' });
  }
  // 站台端墙（设备区门 + 中间装饰/站名）
  for (const sg of [-1, 1]) {
    const u = sg * pl;
    K.quad('wall', [u, -pw, yP], [u, pw, yP], [u, pw, yTop], [u, -pw, yTop], ao(wallC));
    for (const v of [-4.2, 4.2]) K.quad('paint', [u - sg * 0.01, v - 0.75, yP], [u - sg * 0.01, v + 0.75, yP], [u - sg * 0.01, v + 0.75, yP + 2.2], [u - sg * 0.01, v - 0.75, yP + 2.2], C('#3b3e43'));
    const uu = u - sg * 0.02;
    if (th.deco) K.quad('deco', [uu, -2.4, yP + 0.5], [uu, 2.4, yP + 0.5], [uu, 2.4, yCl - 0.35], [uu, -2.4, yCl - 0.35], WHITE);
    else {
      // 看向 +u（sg>0）时右方为 +v
      const [a0, a1] = sg > 0 ? [-2.6, 2.6] : [2.6, -2.6];
      K.sign([uu, a0, yP + 1.6], [uu, a1, yP + 1.6], [uu, a1, yP + 2.36], [uu, a0, yP + 2.36], rects.name);
    }
  }

  // —— 导向吊牌（楼梯前方，双面） ——
  for (const sg of [-1, 1]) {
    const u = sg * 13, y0 = yCl - 0.95, y1 = yCl - 0.4;
    // 迎着楼梯方向看（看向 sg·u）：右方 = sg·v
    K.sign([u - sg * 0.04, -sg * 2.2, y0], [u - sg * 0.04, sg * 2.2, y0], [u - sg * 0.04, sg * 2.2, y1], [u - sg * 0.04, -sg * 2.2, y1], rects.guide);
    K.sign([u + sg * 0.04, sg * 2.2, y0], [u + sg * 0.04, -sg * 2.2, y0], [u + sg * 0.04, -sg * 2.2, y1], [u + sg * 0.04, sg * 2.2, y1], rects.guide);
    K.box('metal', u - 0.05, u + 0.05, -2.28, 2.28, y0 - 0.06, y0, black);
    K.box('metal', u - 0.05, u + 0.05, -2.28, 2.28, y1, y1 + 0.06, black);
    for (const v of [-1.6, 1.6]) K.box('metal', u - 0.02, u + 0.02, v - 0.02, v + 0.02, y1 + 0.06, ridgeY(v), steelD, { skip: 'tb' });
  }

  // —— 楼梯 + 扶梯（两组，脚在 |u|=22、向端部上行到站厅） ——
  const N = 36, rise = (yC0 - yP) / N, run = STAIR_RUN / N;
  const treadC = C('#e3dfd8'), riserC = C('#c9c5bd'), nosing = C('#34363a');
  for (const sg of [-1, 1]) {
    const ua = sg * STAIR_U, ub = sg * (STAIR_U + STAIR_RUN);
    const v0 = -STAIR_HW, v1 = 0.25, e0 = 0.45, e1 = STAIR_HW;
    for (let i = 0; i < N; i++) {
      const u0 = ua + sg * i * run, u1 = ua + sg * (i + 1) * run, y0 = yP + i * rise, y1 = y0 + rise;
      K.quad('floor', [u0, v0, y0], [u0, v1, y0], [u0, v1, y1], [u0, v0, y1], riserC);
      K.quad('floor', [u0, v0, y1], [u1, v0, y1], [u1, v1, y1], [u0, v1, y1], treadC);
      K.quad('paint', [u0, v0, y1], [u0 + sg * 0.07, v0, y1], [u0 + sg * 0.07, v1, y1], [u0, v1, y1], nosing);
    }
    // 扶梯：上下平台 + 斜段（约 30°）
    const ea = ua + sg * 1.2, eb = ub - sg * 1.2;
    const escC = C('#5d6166');
    K.quad('metal', [ua, e0, yP + 0.02], [ea, e0, yP + 0.02], [ea, e1, yP + 0.02], [ua, e1, yP + 0.02], escC);
    K.quad('metal', [ea, e0, yP + 0.02], [eb, e0, yC0 + 0.02], [eb, e1, yC0 + 0.02], [ea, e1, yP + 0.02], escC);
    K.quad('metal', [eb, e0, yC0 + 0.02], [ub, e0, yC0 + 0.02], [ub, e1, yC0 + 0.02], [eb, e1, yC0 + 0.02], escC);
    // 侧板（梯下封闭）+ 玻璃栏板 + 扶手；中间隔板
    for (const v of [v0, e1, (v1 + e0) / 2]) {
      const mid = v === (v1 + e0) / 2;
      if (!mid) K.tri('wall', [ua, v, yP], [ub, v, yP], [ub, v, yC0], mul(wallC, 0.92));
      K.quad(mid ? 'metal' : 'glass', [ua, v, yP + (mid ? 0 : 0.05)], [ub, v, yC0 + (mid ? 0 : 0.05)], [ub, v, yC0 + 1.0], [ua, v, yP + 1.0], mid ? steel : C('#d6eef6'));
      K.quad('metal', [ua, v - 0.05, yP + 1.0], [ub, v - 0.05, yC0 + 1.0], [ub, v + 0.05, yC0 + 1.0], [ua, v + 0.05, yP + 1.0], black);
    }
    K.quad('wall', [ub, -STAIR_HW, yP], [ub, STAIR_HW, yP], [ub, STAIR_HW, yC0], [ub, -STAIR_HW, yC0], mul(wallC, 0.9));
    // 楼板洞口侧面
    const h0 = sg > 0 ? holes[1] : holes[0];
    for (const s of [-1, 1]) K.quad('wall', [h0[0], s * holeV, yTop], [h0[1], s * holeV, yTop], [h0[1], s * holeV, yC0], [h0[0], s * holeV, yC0], C('#9a9893'));
    const uLow = sg > 0 ? h0[0] : h0[1];
    K.quad('wall', [uLow, -holeV, yTop], [uLow, holeV, yTop], [uLow, holeV, yC0], [uLow, -holeV, yC0], C('#9a9893'));
  }

  // —— 站厅层 ——
  for (const [a, bb] of subtract(-hl, hl, holes)) K.quad('floor', [a, -hw, yC0], [bb, -hw, yC0], [bb, hw, yC0], [a, hw, yC0], floorC);
  for (const [h0, h1] of holes) for (const s of [-1, 1]) K.quad('floor', [h0, s * holeV, yC0], [h1, s * holeV, yC0], [h1, s * hw, yC0], [h0, s * hw, yC0], floorC);
  // 洞口栏杆（两长边 + 低端），高 1.1 m
  for (const sg of [-1, 1]) {
    const [h0, h1] = sg > 0 ? holes[1] : holes[0];
    const uLow = sg > 0 ? h0 : h1;
    for (const s of [-1, 1]) {
      K.quad('glass', [h0, s * holeV, yC0], [h1, s * holeV, yC0], [h1, s * holeV, yC0 + 1.1], [h0, s * holeV, yC0 + 1.1], C('#d6eef6'));
      K.box('metal', h0, h1, s * holeV - 0.04, s * holeV + 0.04, yC0 + 1.1, yC0 + 1.16, steel);
    }
    K.quad('glass', [uLow, -holeV, yC0], [uLow, holeV, yC0], [uLow, holeV, yC0 + 1.1], [uLow, -holeV, yC0 + 1.1], C('#d6eef6'));
    K.box('metal', uLow - 0.04, uLow + 0.04, -holeV, holeV, yC0 + 1.1, yC0 + 1.16, steel);
  }
  // 吊顶与灯带
  K.quad('ceil', [-hl, -hw, yCc], [hl, -hw, yCc], [hl, hw, yCc], [-hl, hw, yCc], ceilC);
  for (const v of [-6.5, 0, 6.5]) for (const [a, bb] of subtract(-hl + 2, hl - 2, v === 0 ? holes : [])) {
    K.quad('light', [a, v - 0.15, yCc - 0.02], [bb, v - 0.15, yCc - 0.02], [bb, v + 0.15, yCc - 0.02], [a, v + 0.15, yCc - 0.02], C('#fff6e8'));
  }
  // 线路色导向带
  for (const [a, bb] of subtract(-hl + 3, hl - 3, [[-46, -42], [42, 46]])) K.quad('paint', [a, -4.1, yC0], [bb, -4.1, yC0], [bb, -3.95, yC0], [a, -3.95, yC0], guide);
  // 站厅柱（避开闸机）
  for (const u of [-63, -54, -36, -27, -18, -9, 0, 9, 18, 27, 36, 54, 63]) for (const v of [-5.5, 5.5]) {
    K.box('wall', u - 0.45, u + 0.45, v - 0.45, v + 0.45, yC0 + 0.15, yCc, colC, { skip: 't' });
    K.box('metal', u - 0.49, u + 0.49, v - 0.49, v + 0.49, yC0, yC0 + 0.15, steelD, { top: steel });
  }
  // 站厅导向吊牌（楼梯洞口外侧，双面）
  for (const sg of [-1, 1]) {
    const u = sg * 17, y0 = yCc - 1.05, y1 = yCc - 0.5;
    K.sign([u - sg * 0.04, -sg * 2.2, y0], [u - sg * 0.04, sg * 2.2, y0], [u - sg * 0.04, sg * 2.2, y1], [u - sg * 0.04, -sg * 2.2, y1], rects.guide);
    K.sign([u + sg * 0.04, sg * 2.2, y0], [u + sg * 0.04, -sg * 2.2, y0], [u + sg * 0.04, -sg * 2.2, y1], [u + sg * 0.04, sg * 2.2, y1], rects.guide);
    K.box('metal', u - 0.05, u + 0.05, -2.28, 2.28, y0 - 0.06, y0, black);
    K.box('metal', u - 0.05, u + 0.05, -2.28, 2.28, y1, y1 + 0.06, black);
    for (const v of [-1.6, 1.6]) K.box('metal', u - 0.02, u + 0.02, v - 0.02, v + 0.02, y1 + 0.06, yCc, steelD, { skip: 'tb' });
  }
  // 闸机群（u=±44）与两侧栏杆
  for (const ug of [-44, 44]) {
    for (let v = -8; v <= 8.01; v += 1.6) {
      K.box('metal', ug - 0.9, ug + 0.9, v - 0.14, v + 0.14, yC0, yC0 + 1.0, C('#c9ccd0'), { top: C('#2f3439') });
      for (const e of [-0.82, 0.82]) K.quad('light', [ug + e - 0.06, v - 0.05, yC0 + 1.005], [ug + e + 0.06, v - 0.05, yC0 + 1.005], [ug + e + 0.06, v + 0.05, yC0 + 1.005], [ug + e - 0.06, v + 0.05, yC0 + 1.005], C(e < 0 ? '#3ad16f' : '#ff5a4a'));
    }
    for (const [v0, v1] of [[8.2, hw - 0.6], [-(hw - 0.6), -8.2]]) {
      K.quad('glass', [ug, v0, yC0], [ug, v1, yC0], [ug, v1, yC0 + 1.1], [ug, v0, yC0 + 1.1], C('#d6eef6'));
      K.box('metal', ug - 0.04, ug + 0.04, v0, v1, yC0 + 1.1, yC0 + 1.16, steel);
    }
  }
  // 自动售票机
  for (const us of [-54, 54]) for (const s of [-1, 1]) for (let k = 0; k < 4; k++) {
    const u = us + (k - 1.5) * 1.3, v = s * (hw - 0.45);
    K.box('metal', u - 0.5, u + 0.5, v - 0.3, v + 0.3, yC0, yC0 + 1.8, C('#d4d7db'), { top: C('#9aa0a6') });
    const vf = v - s * 0.31;
    K.quad('light', [u - 0.32, vf, yC0 + 1.0], [u + 0.32, vf, yC0 + 1.0], [u + 0.32, vf, yC0 + 1.5], [u - 0.32, vf, yC0 + 1.5], C('#3b78c8'));
  }
  return th;
}

/** 站厅墙（按出入口通道开洞）+ 端墙文化墙 */
function buildConcourseWalls(K, b, th, gaps, rects) {
  const { yC0, yCc } = Y;
  const hl = HALL_L / 2, hw = HALL_W / 2;
  const wallC = th.wall;
  const ao = [mul(wallC, 0.75), mul(wallC, 0.75), wallC, wallC];
  const DOOR_H = 3.2;
  const wall = (side, t0, t1, fix, alongU) => {
    const P = (t, y) => (alongU ? [t, fix, y] : [fix, t, y]);
    const gs = gaps.filter((g) => g.side === side).map((g) => [g.t - g.w, g.t + g.w]);
    for (const [a, bb] of subtract(t0, t1, gs)) K.quad('wall', P(a, yC0), P(bb, yC0), P(bb, yCc), P(a, yCc), ao);
    for (const [a, bb] of gs) {
      const a2 = Math.max(a, t0), b2 = Math.min(bb, t1);
      if (b2 - a2 < 0.1) continue;
      K.quad('wall', P(a2, yC0 + DOOR_H), P(b2, yC0 + DOOR_H), P(b2, yCc), P(a2, yCc), wallC);
      K.quad('metal', P(a2, yC0 + DOOR_H - 0.05), P(b2, yC0 + DOOR_H - 0.05), P(b2, yC0 + DOOR_H + 0.1), P(a2, yC0 + DOOR_H + 0.1), C('#7e858c'));
    }
  };
  wall('v+', -hl, hl, hw, true);
  wall('v-', -hl, hl, -hw, true);
  wall('u+', -hw, hw, hl, false);
  wall('u-', -hw, hw, -hl, false);
  // 端墙文化墙 / 站名
  for (const sg of [-1, 1]) {
    const side = sg > 0 ? 'u+' : 'u-';
    const busy = gaps.some((g) => g.side === side && Math.abs(g.t) < 7);
    if (busy) continue;
    const u = sg * (hl - 0.03);
    if (th.deco) for (const v of [-4.8, -1.6, 1.6]) K.quad('deco', [u, v, yC0 + 0.6], [u, v + 3.2, yC0 + 0.6], [u, v + 3.2, yC0 + 2.9], [u, v, yC0 + 2.9], WHITE);
    const [a0, a1] = sg > 0 ? [-3.2, 3.2] : [3.2, -3.2];
    K.sign([u, a0, yC0 + (th.deco ? 3.0 : 1.9)], [u, a1, yC0 + (th.deco ? 3.0 : 1.9)], [u, a1, yC0 + (th.deco ? 3.45 : 2.85)], [u, a0, yC0 + (th.deco ? 3.45 : 2.85)], rects.name);
  }
}

/**
 * 出入口通道（站厅 → 地面）：每个出口接离它最近的站体，从最近的那面站厅墙垂直伸出 6 m，再折向出口；
 * 平面上按折线斜接（转角处墙体连续），竖向先水平、末段逐级踏步升到地面。
 * 返回 {gaps: Map(站体 → 墙洞[]), runs: 步行查询用 [{pts:[[x,z,s]...], sM, sE, y0, y1}]}
 */
function buildPassages(K0, boxes, exits, H, rects) {
  const { yC0 } = Y;
  const hl = HALL_L / 2, hw = HALL_W / 2;
  const gaps = new Map(boxes.map((b) => [b, []])), runs = [];
  const W = 2.4, HH = 3.2, STUB = 6;
  const Kw = new Kit((x, z, y) => [x, y, z]); // 世界坐标写入器（显式 UV）
  Kw.g = K0.g;
  for (const [ex, ez, lab] of exits) {
    if (!lab) continue;
    // 最近的站体（到站体矩形的距离）
    let b = null, bd = Infinity, eu = 0, ev = 0;
    for (const q of boxes) {
      const dx = ex - q.cx, dz = ez - q.cz, u = dx * q.ux + dz * q.uz, v = dx * q.vx + dz * q.vz;
      const d = Math.hypot(Math.max(0, Math.abs(u) - hl), Math.max(0, Math.abs(v) - hw));
      if (d < bd) { bd = d; b = q; eu = u; ev = v; }
    }
    if (!b || bd < 4 || bd > 420) continue;
    // 出口所在一侧的墙：离哪面墙更远（超出量更大）就从哪面墙出
    let side, t, nu, nv;
    if (Math.abs(ev) - hw >= Math.abs(eu) - hl) { side = ev > 0 ? 'v+' : 'v-'; t = THREE.MathUtils.clamp(eu, -hl + 4, hl - 4); nu = 0; nv = Math.sign(ev); }
    else { side = eu > 0 ? 'u+' : 'u-'; t = THREE.MathUtils.clamp(ev, -hw + 3.2, hw - 3.2); nu = Math.sign(eu); nv = 0; }
    gaps.get(b).push({ side, t, w: W - 0.01 }); // 洞口与通道同宽（否则洞边露出墙后的黑缝）
    const L2W = (u, v) => [b.cx + b.ux * u + b.vx * v, b.cz + b.uz * u + b.vz * v];
    const g0 = side[0] === 'v' ? L2W(t, nv * hw) : L2W(nu * hl, t);
    const nx = b.ux * nu + b.vx * nv, nz = b.uz * nu + b.vz * nv;
    const j = [g0[0] + nx * STUB, g0[1] + nz * STUB];
    const dist2 = Math.hypot(ex - j[0], ez - j[1]);
    if (dist2 < 8) continue;
    const yW = b.yR + yC0, g1 = H(ex, ez), rise = g1 - 0.2 - yW;
    const ramp = Math.min(dist2 - 2, Math.max(10, Math.abs(rise) * 1.9));
    const tx = (ex - j[0]) / dist2, tz = (ez - j[1]) / dist2;
    const m = [ex - tx * ramp, ez - tz * ramp];
    // 折线 G → J → M → E，平面斜接
    const P = [g0, j, m, [ex, ez]];
    const S = [0];
    for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const dirs = [];
    for (let i = 1; i < P.length; i++) { const L = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) || 1; dirs.push([(P[i][0] - P[i - 1][0]) / L, (P[i][1] - P[i - 1][1]) / L]); }
    const off = P.map((p, i) => {
      const a = dirs[Math.max(0, i - 1)], c = dirs[Math.min(dirs.length - 1, i)];
      let mx = -(a[1] + c[1]), mz = a[0] + c[0];
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml; mz /= ml;
      const k = W / Math.max(0.35, mx * -a[1] + mz * a[0]); // 斜接长度
      return [[p[0] + mx * k, p[1] + mz * k], [p[0] - mx * k, p[1] - mz * k]];
    });
    const th = themeOf(b), wallC = th.wall, ceilC = th.ceil, floorC = C('#f2efea');
    const yAt = (i) => (i <= 2 ? yW : yW + rise);
    const run = (i) => {
      const [La, Ra] = off[i], [Lb, Rb] = off[i + 1], ya = yAt(i), yb = yAt(i + 1), s0 = S[i], s1 = S[i + 1];
      const P3 = (q, y) => [q[0], q[1], y];
      if (i < 2) Kw.quad('floor', P3(La, ya), P3(Lb, yb), P3(Rb, yb), P3(Ra, ya), floorC, [[s0, W], [s1, W], [s1, -W], [s0, -W]]);
      Kw.quad('ceil', P3(La, ya + HH), P3(Lb, yb + HH), P3(Rb, yb + HH), P3(Ra, ya + HH), ceilC, [[s0, W], [s1, W], [s1, -W], [s0, -W]]);
      for (const [A, B] of [[La, Lb], [Ra, Rb]]) {
        const y0a = i < 2 ? ya : ya - 0.2;
        Kw.quad('wall', P3(A, y0a), P3(B, yb - (i < 2 ? 0 : 0.2)), P3(B, yb + HH), P3(A, ya + HH), [mul(wallC, 0.75), mul(wallC, 0.75), wallC, wallC], [[s0, y0a], [s1, yb], [s1, yb + HH], [s0, ya + HH]]);
      }
      const ca = [(La[0] + Ra[0]) / 2, (La[1] + Ra[1]) / 2], cb = [(Lb[0] + Rb[0]) / 2, (Lb[1] + Rb[1]) / 2];
      const d = dirs[i], wx = -d[1] * 0.2, wz = d[0] * 0.2;
      Kw.quad('light', [ca[0] + wx, ca[1] + wz, ya + HH - 0.02], [cb[0] + wx, cb[1] + wz, yb + HH - 0.02], [cb[0] - wx, cb[1] - wz, yb + HH - 0.02], [ca[0] - wx, ca[1] - wz, ya + HH - 0.02], C('#fff6e8'), [[0, 0], [1, 0], [1, 1], [0, 1]]);
    };
    for (let i = 0; i < 3; i++) run(i);
    // 末段踏步（沿 M→E 的直线框架）
    const d = dirs[2], Kst = new Kit((s_, w, y) => [m[0] + d[0] * s_ - d[1] * w, y, m[1] + d[1] * s_ + d[0] * w]);
    Kst.g = K0.g;
    const L = S[3] - S[2];
    const n = Math.max(2, Math.ceil(Math.abs(rise) / 0.16)), r = rise / n, tt = L / n;
    for (let i = 0; i < n; i++) {
      const a0 = i * tt, a1 = a0 + tt, y0 = yW + i * r, y1 = y0 + r, yt = Math.max(y0, y1);
      Kst.quad('floor', [a0, -W, yt], [a1, -W, yt], [a1, W, yt], [a0, W, yt], floorC);
      Kst.quad('floor', [a0, -W, y0], [a0, W, y0], [a0, W, y1], [a0, -W, y1], C('#c9c5bd'));
      Kst.quad('paint', [a0, -W, yt], [a0 + 0.07, -W, yt], [a0 + 0.07, W, yt], [a0, W, yt], C('#34363a'));
    }
    for (const w of [-W + 0.08, W - 0.08]) Kst.quad('metal', [0, w, yW + 0.95], [L, w, yW + rise + 0.95], [L, w, yW + rise + 1.0], [0, w, yW + 1.0], C('#9aa0a6'));
    // 通道口导向牌（从站厅看向通道：右方为前进方向的右侧）
    const d0 = dirs[0], Ks = new Kit((s_, w, y) => [g0[0] + d0[0] * s_ - d0[1] * w, y, g0[1] + d0[1] * s_ + d0[0] * w]);
    Ks.g = K0.g;
    Ks.sign([0.8, -W + 0.2, yW + 2.5], [0.8, W - 0.2, yW + 2.5], [0.8, W - 0.2, yW + 3.0], [0.8, -W + 0.2, yW + 3.0], rects.guide);
    runs.push({ pts: P.map((p, i) => [p[0], p[1], S[i]]), sM: S[2], sE: S[3], y0: yW, y1: g1 - 0.2 });
  }
  return { gaps, runs };
}

/** 出入口通道里的地面高度（步行用），不在通道内返回 null */
export function passageFloor(runs, x, z, foot) {
  for (const R of runs) {
    const p = R.pts;
    for (let i = 1; i < p.length; i++) {
      const ax = p[i - 1][0], az = p[i - 1][1], bx = p[i][0], bz = p[i][1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
      const t = ((x - ax) * ex + (z - az) * ez) / L2;
      if (t < -0.05 || t > 1.05) continue;
      if (Math.hypot(ax + ex * t - x, az + ez * t - z) > 2.6) continue;
      const s = p[i - 1][2] + Math.max(0, Math.min(1, t)) * (p[i][2] - p[i - 1][2]);
      const y = s <= R.sM ? R.y0 : R.y0 + (R.y1 - R.y0) * ((s - R.sM) / Math.max(1, R.sE - R.sM));
      if (Math.abs(y - foot) < 4) return y;
    }
  }
  return null;
}

/** 一座车站（含换乘的多个站体与出入口通道）→ THREE.Group；返回 {group, segs, dispose} */
export function buildStation(st, boxes, H, lineColor, badgeOf, seed) {
  const M = metroMaterials();
  const { tex, rect } = signTexture(st, lineColor, badgeOf, seed);
  const signMat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, fog: false, color: new THREE.Color(1.35, 1.35, 1.35), polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const group = new THREE.Group();
  group.name = `地铁站-${st.n}`;
  const kits = [];
  const K0 = new Kit((x, z, y) => [x, y, z]);
  const { gaps, runs } = buildPassages(K0, boxes, st.exits || [], H, rect);
  kits.push(K0);
  for (const b of boxes) {
    const K = new Kit((u, v, y) => b.F(u, v, y));
    const th = buildBox(K, b, lineColor, rect);
    buildConcourseWalls(K, b, th, gaps.get(b) || [], rect);
    kits.push(K);
  }
  const order = ['floor', 'paint', 'tactile', 'wall', 'deco', 'ceil', 'metal', 'conc', 'light', 'sign', 'glass'];
  for (const k of order) {
    // 同一车站的各站体合并到同一个网格（每种材质一次绘制）
    const G = new Geo();
    for (const K of kits) {
      const g = K.g[k];
      if (!g) continue;
      for (const a of ['p', 'c', 't']) for (let i = 0; i < g[a].length; i++) G[a].push(g[a][i]);
    }
    const mesh = G.build(k === 'sign' ? signMat : M[k], `${st.n}-${k}`);
    if (!mesh) continue;
    if (k === 'glass') mesh.renderOrder = 2;
    group.add(mesh);
  }
  return {
    group,
    runs,
    dispose() {
      group.traverse((o) => o.geometry?.dispose());
      signMat.dispose();
      tex.dispose();
    },
  };
}

/** 站体内的地面高度（步行用）：站台 / 轨行区 / 楼梯 / 站厅；foot 为当前脚底高度。返回 null 表示不在站体内 */
export function boxFloor(b, x, z, foot) {
  const dx = x - b.cx, dz = z - b.cz;
  const u = dx * b.ux + dz * b.uz, v = dx * b.vx + dz * b.vz;
  const hl = HALL_L / 2 + 0.5, hw = HALL_W / 2 + 0.5;
  if (Math.abs(u) > hl || Math.abs(v) > hw) return null;
  const { yP, yC0 } = Y;
  const cands = [];
  const au = Math.abs(u);
  const inHole = au > STAIR_U - 0.5 && au < STAIR_U + STAIR_RUN + 0.2 && Math.abs(v) < HOLE_HW;
  if (!inHole) cands.push(yC0);
  if (au > STAIR_U && au < STAIR_U + STAIR_RUN && Math.abs(v) < STAIR_HW) cands.push(yP + ((au - STAIR_U) / STAIR_RUN) * (yC0 - yP));
  else if (au >= STAIR_U + STAIR_RUN && au < STAIR_U + STAIR_RUN + 0.2 && Math.abs(v) < STAIR_HW) cands.push(yC0);
  cands.push(Math.abs(v) < PLAT_W / 2 && au < PLAT_L / 2 ? yP : -0.5);
  // 取不高于“脚底 + 0.7 m”的最高地面（可以上台阶，不会穿到楼上）
  const f = foot - b.yR;
  let best = null;
  for (const c of cands) if (c <= f + 0.7 && (best == null || c > best)) best = c;
  if (best == null) best = Math.min(...cands);
  return b.yR + best;
}
