// 小汽车程序化几何：轿车 / SUV / MPV 三个形变目标（拓扑完全一致，实例 iData.z = 0/1/2 选形），出租车顶灯按车型折叠。
// 两级细节：lod 0 近景（约 1700 三角形：18 点车身环 × 18 站放样、腰线/特征线、五辐轮毂、凸出轮眉、立体灯组、
//   后视镜、雨刮、鲨鱼鳍、行李架、第三刹车灯、带“陕A”字样的号牌）；lod 1 中景（约 800 三角形）。
// 门缝、门把手、B 柱等细节在着色器里按局部坐标画（见 vehicle-mats.js）。
// 参考尺寸：轿车 4.75×1.83×1.46 m（比亚迪秦/吉利帝豪级）、SUV 4.78×1.90×1.72 m、MPV 5.05×1.88×1.79 m（别克 GL8 级）。
import * as THREE from 'three';
import { GeoBuilder, M, PM, EM, VK, col, withKind, smoothNormals } from './traffic_models.js';

// 站点：[z, yb(底), ys(裙线), yw(腰线), yt(顶), hw(腰线半宽), hwt(顶半宽)]，18 站语义一致：
// 0 鼻尖 1 保险杠上沿 2 机盖前缘 3,4 机盖 5 前风挡下沿 6 风挡中 7 风挡顶 8~11 车顶 12 后窗顶 13 后窗中 14 后窗下沿/尾箱 15,16 尾部 17 尾端
const SEDAN = {
  st: [
    [2.37, 0.33, 0.42, 0.58, 0.62, 0.76, 0.68], [2.33, 0.25, 0.38, 0.68, 0.72, 0.86, 0.78], [2.2, 0.2, 0.36, 0.75, 0.79, 0.895, 0.83],
    [1.85, 0.19, 0.36, 0.81, 0.85, 0.91, 0.86], [1.45, 0.19, 0.36, 0.86, 0.9, 0.915, 0.87], [1.0, 0.19, 0.36, 0.9, 0.95, 0.915, 0.86],
    [0.55, 0.19, 0.36, 0.93, 1.22, 0.915, 0.77], [0.15, 0.19, 0.36, 0.945, 1.42, 0.915, 0.705], [-0.1, 0.19, 0.36, 0.95, 1.455, 0.915, 0.7],
    [-0.4, 0.19, 0.36, 0.95, 1.46, 0.915, 0.7], [-0.75, 0.19, 0.36, 0.95, 1.45, 0.915, 0.695], [-1.0, 0.19, 0.36, 0.95, 1.42, 0.915, 0.685],
    [-1.22, 0.19, 0.36, 0.95, 1.37, 0.915, 0.68], [-1.55, 0.19, 0.36, 0.95, 1.17, 0.915, 0.72], [-1.85, 0.2, 0.37, 0.95, 1.01, 0.91, 0.8],
    [-2.2, 0.24, 0.4, 0.93, 0.99, 0.89, 0.8], [-2.33, 0.28, 0.42, 0.86, 0.92, 0.85, 0.76], [-2.38, 0.34, 0.45, 0.78, 0.82, 0.78, 0.7],
  ],
  wheelR: 0.33, axleF: 1.4, axleR: -1.37, headY: 0.7, tailY: 0.86, plateY: 0.42, rearPlateY: 0.6,
  frontZ: 2.33, rearZ: -2.36, mirrorY: 1.0, mirrorZ: 0.82, roofY: 1.46, rail: -0.07, brakeZ: -1.25,
};
const SUV = {
  st: [
    [2.38, 0.4, 0.52, 0.72, 0.78, 0.82, 0.74], [2.33, 0.31, 0.48, 0.86, 0.92, 0.91, 0.84], [2.2, 0.28, 0.46, 0.96, 1.01, 0.94, 0.88],
    [1.9, 0.27, 0.46, 1.01, 1.06, 0.95, 0.9], [1.55, 0.27, 0.46, 1.05, 1.09, 0.95, 0.9], [1.15, 0.27, 0.46, 1.07, 1.12, 0.95, 0.89],
    [0.75, 0.27, 0.46, 1.08, 1.45, 0.95, 0.8], [0.38, 0.27, 0.46, 1.08, 1.69, 0.95, 0.765], [0.05, 0.27, 0.46, 1.08, 1.72, 0.95, 0.78],
    [-0.4, 0.27, 0.46, 1.08, 1.725, 0.95, 0.78], [-0.9, 0.27, 0.46, 1.08, 1.72, 0.95, 0.78], [-1.5, 0.27, 0.46, 1.08, 1.71, 0.95, 0.775],
    [-1.95, 0.27, 0.46, 1.08, 1.69, 0.95, 0.77], [-2.15, 0.27, 0.46, 1.08, 1.45, 0.95, 0.8], [-2.27, 0.28, 0.47, 1.07, 1.16, 0.945, 0.84],
    [-2.33, 0.3, 0.49, 1.03, 1.08, 0.93, 0.85], [-2.37, 0.33, 0.5, 0.93, 0.98, 0.9, 0.82], [-2.4, 0.4, 0.52, 0.83, 0.87, 0.82, 0.74],
  ],
  wheelR: 0.37, axleF: 1.45, axleR: -1.4, headY: 0.9, tailY: 1.04, plateY: 0.52, rearPlateY: 0.72,
  frontZ: 2.36, rearZ: -2.38, mirrorY: 1.2, mirrorZ: 1.02, roofY: 1.725, rail: 0.045, brakeZ: -2.0,
};
const MPV = {
  st: [
    [2.5, 0.36, 0.48, 0.66, 0.72, 0.8, 0.72], [2.45, 0.27, 0.44, 0.8, 0.86, 0.9, 0.82], [2.3, 0.24, 0.42, 0.9, 0.95, 0.93, 0.87],
    [2.05, 0.23, 0.42, 0.97, 1.02, 0.94, 0.89], [1.75, 0.23, 0.42, 1.01, 1.08, 0.94, 0.88], [1.45, 0.23, 0.42, 1.03, 1.14, 0.94, 0.87],
    [1.05, 0.23, 0.42, 1.05, 1.5, 0.94, 0.8], [0.65, 0.23, 0.42, 1.06, 1.75, 0.94, 0.77], [0.3, 0.23, 0.42, 1.06, 1.78, 0.94, 0.78],
    [-0.4, 0.23, 0.42, 1.06, 1.785, 0.94, 0.785], [-1.1, 0.23, 0.42, 1.06, 1.78, 0.94, 0.785], [-1.8, 0.23, 0.42, 1.06, 1.77, 0.94, 0.78],
    [-2.3, 0.23, 0.42, 1.06, 1.74, 0.94, 0.77], [-2.42, 0.23, 0.42, 1.06, 1.42, 0.94, 0.8], [-2.46, 0.24, 0.43, 1.05, 1.12, 0.935, 0.84],
    [-2.49, 0.26, 0.45, 1.0, 1.05, 0.92, 0.84], [-2.52, 0.3, 0.47, 0.9, 0.95, 0.89, 0.8], [-2.55, 0.37, 0.49, 0.8, 0.84, 0.82, 0.72],
  ],
  wheelR: 0.35, axleF: 1.55, axleR: -1.5, headY: 0.86, tailY: 1.0, plateY: 0.5, rearPlateY: 0.68,
  frontZ: 2.47, rearZ: -2.52, mirrorY: 1.18, mirrorZ: 1.25, roofY: 1.785, rail: 0.03, brakeZ: -2.36,
};
export const CAR_SHAPES = [SEDAN, SUV, MPV];
/** 各形的车长（跟驰间距） */
export const CAR_LEN = [4.75, 4.78, 5.05];
// 区间类型：[侧面 0 车身 / 1 玻璃, 顶面 0 车身 / 1 玻璃 / 2 车顶 / 3 立柱（外侧圆角带随车顶色、内侧玻璃）]
// 前风挡（第 5、6 段）与后窗（第 12、13 段）两侧的外侧圆角带是 A 柱 / C 柱，从车顶一直连到机盖、尾箱：
// 风挡与后窗是夹在两根立柱之间的梯形——不再是玻璃包到侧面、后窗下段突然冒出一块车漆三角尖插进后风挡
const IV = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 3], [1, 3], [1, 2], [1, 2], [1, 2], [1, 2], [1, 2], [1, 3], [0, 3], [0, 0], [0, 0], [0, 0]];

/** 车身环：左侧自下而上 9 点（细模）/ 5 点（中景），再镜像到右侧 */
function carRing(s, fine) {
  const [, yb, ys, yw, yt, hw, hwt] = s;
  // 腰线以上各点按高度单调排列（机盖/尾箱处 yt−yw 很小，不能折回）
  const d = yt - yw;
  const ysh = yw + Math.min(0.04, d * 0.25);
  const L = fine
    ? [[hw * 0.9, yb], [hw * 0.972, yb + 0.06], [hw, ys], [hw * 1.006, ys + (yw - ys) * 0.62], [hw * 0.996, yw], [hw * 0.965, ysh],
      [hwt, Math.max(yt - 0.07, yw + d * 0.55)], [hwt * 0.88, Math.max(yt - 0.022, yw + d * 0.85)], [hwt * 0.45, yt]]
    : [[hw * 0.93, yb], [hw, ys], [hw, yw], [hw * 0.97, ysh], [hwt, Math.max(yt - 0.05, yw + d * 0.65)], [hwt * 0.55, yt]];
  return [...L, ...L.slice().reverse().map(([x, y]) => [-x, y])];
}
/** 边号 → 左侧对应边号（-1 = 顶中 / 底） */
function sideEdge(k, nHalf) {
  if (k < nHalf - 1) return k;
  if (k === nHalf - 1) return -1; // 顶中
  if (k === 2 * nHalf - 1) return -2; // 底
  return 2 * nHalf - 2 - k;
}
function hwAt(P, z) {
  const st = P.st;
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i], b = st[i + 1];
    if ((z <= a[0] && z >= b[0]) || (z >= a[0] && z <= b[0])) return a[5] + ((b[5] - a[5]) * (z - a[0])) / (b[0] - a[0] || 1);
  }
  return st[0][5];
}
/** 站点表在 z 处的某列（线性插值） */
function stAt(P, z, col) {
  const st = P.st;
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i], b = st[i + 1];
    if (z <= a[0] && z >= b[0]) return a[col] + ((b[col] - a[col]) * (z - a[0])) / (b[0] - a[0] || 1);
  }
  return z > st[0][0] ? st[0][col] : st[st.length - 1][col];
}

const RIM = { c: col(0xbfc3c7), rough: 0.25, metal: 0.9 };
const RIM_DARK = { c: col(0x2a2c2f), rough: 0.6, metal: 0.4 };
const GRILLE = { c: col(0x0e0f10), rough: 0.5, metal: 0.4 };
const LENS = { c: col(0xdfe4e8), rough: 0.06, metal: 0.85, em: EM.HEAD };
// 大灯：透明灯罩下的镀铬反光碗（浅银亮面，反射天空）+ 深色玻璃投射透镜（夜里发光）
const HEAD_COVER = { c: col(0x8d959d), rough: 0.07, metal: 0.92 };
const PROJ = { c: col(0x1c2126), rough: 0.04, metal: 0.3, em: EM.HEAD };
const PLATE_FRAME = { c: col(0x101112), rough: 0.5, metal: 0.2 };

// —— 车身表面采样：灯组、格栅等做成贴着车身的面片（不再是凸出车身的方盒）——
/** 细模车身环左半（自下而上 9 点）上部轮廓在 x 处的高度（腰线以上；x 落在顶部平段内取 yt） */
function upperY(s, x) {
  const L = carRing(s, true);
  if (x <= L[8][0]) return L[8][1];
  for (let i = 7; i >= 4; i--) {
    const a = L[i], b = L[i + 1];
    if (x <= a[0] && x >= b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0] || 1);
  }
  return L[4][1];
}
/** 车身上表面 (x, z) 处高度（站点间线性插值，与放样一致到毫米级） */
function surfY(P, x, z) {
  const st = P.st;
  if (z >= st[0][0]) return upperY(st[0], x);
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i], b = st[i + 1];
    if (z <= a[0] && z >= b[0]) { const t = (z - a[0]) / (b[0] - a[0] || 1); return upperY(a, x) * (1 - t) + upperY(b, x) * t; }
  }
  return upperY(st[st.length - 1], x);
}
/** 车身上部轮廓在 z 处的最大半宽（腰线点） */
const edgeAt = (P, z) => hwAt(P, z) * 0.99;
/**
 * 贴车身上表面的面片：单侧（sd = ±1）x ∈ [xa, xb]（xb 超出车身边缘时按各 z 处边缘收窄，xa 可为负 = 跨过中线），
 * zs = 纵向取样位置（取在站点上 → 与放样车身逐段吻合；三种车形站点语义一致，三角形数相同）；沿外法线抬起 off（米）。
 */
function surfPatch(B, P, sd, xa, xb, zs, m, off, nx = 3) {
  const pt = (u, z) => {
    const x1 = Math.min(xb, edgeAt(P, z)), x0 = Math.min(xa, x1 - 0.01);
    const x = x0 + (x1 - x0) * u;
    const y = surfY(P, x, z);
    const ax = Math.abs(x);
    const dydx = ((surfY(P, ax + 0.01, z) - surfY(P, Math.max(0, ax - 0.01), z)) / 0.02) * Math.sign(x || 1);
    const dz = 0.006;
    const dydz = (surfY(P, x, z + dz) - surfY(P, x, z - dz)) / (2 * dz);
    let nX = -dydx, nY = 1, nZ = -dydz;
    const l = Math.hypot(nX, nY, nZ);
    nX /= l; nY /= l; nZ /= l;
    return [sd * (x + nX * off), y + nY * off, z + nZ * off];
  };
  const zm = (zs[0] + zs[zs.length - 1]) / 2;
  const ref = [sd * 0.5 * (xa + Math.min(xb, edgeAt(P, zm))), surfY(P, Math.abs(0.5 * (xa + xb)), zm) - 0.3, zm];
  for (let j = 0; j + 1 < zs.length; j++)
    for (let i = 0; i < nx; i++)
      B.quad(pt(i / nx, zs[j]), pt((i + 1) / nx, zs[j]), pt((i + 1) / nx, zs[j + 1]), pt(i / nx, zs[j + 1]), m, ref);
}
/** 车头/车尾端面（站点 0 / 17 的平封口）上的竖直面板 */
function capPanel(B, P, front, x0, x1, y0, y1, m, off) {
  const z = front ? P.st[0][0] + off : P.st[P.st.length - 1][0] - off;
  B.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], m, { n: [0, 0, front ? 1 : -1] });
}
/**
 * 后视镜：车门上的支臂 + 圆鼻楔形镜壳（前端收圆、后端为镜面），根部贴在 A 柱下方的车身肩线上。
 * 镜壳按 z 放样：前缘（收成 55%）→ 中段 → 后缘（满尺寸，封口为镜面）。
 */
function carMirror(B, P, sd, fine) {
  const zc = P.mirrorZ, yc = P.mirrorY;
  const body = hwAt(P, zc) * 0.965; // 肩线（侧窗下沿）处的车身半宽
  const hx = 0.095, hy = 0.062; // 镜壳半宽（横向）/ 半高
  const cx = sd * (body + 0.045 + hx), cy = yc;
  // 支臂：从肩线伸出的扁楔
  B.obox(sd * (body + 0.03), cy - 0.035, zc + 0.02, 0.08, 0.035, 0.1, 0, M.black);
  if (!fine) {
    B.box(cx, cy, zc, hx * 2, hy * 2, 0.17, M.paint);
    return;
  }
  const ring = (k) => {
    // 圆角矩形 8 点（x 向外为正）
    const pts = [[1, -0.55], [1, 0.55], [0.6, 1], [-0.75, 1], [-1, 0.5], [-1, -0.5], [-0.75, -1], [0.6, -1]];
    return pts.map(([u, v]) => [cx + sd * u * hx * k, cy + v * hy * (0.4 + 0.6 * k)]);
  };
  const secs = [{ z: zc + 0.1, r: ring(0.5) }, { z: zc + 0.055, r: ring(0.9) }, { z: zc - 0.075, r: ring(1) }];
  const ref = [cx, cy, zc];
  for (let i = 0; i + 1 < secs.length; i++) {
    const A = secs[i], Bs = secs[i + 1];
    for (let k = 0; k < 8; k++) {
      const k2 = (k + 1) % 8;
      B.quad([A.r[k][0], A.r[k][1], A.z], [A.r[k2][0], A.r[k2][1], A.z], [Bs.r[k2][0], Bs.r[k2][1], Bs.z], [Bs.r[k][0], Bs.r[k][1], Bs.z], M.paint, ref);
    }
  }
  // 前端封口（车漆）、后端镜面（暗银镜片 + 黑边）
  const f = secs[0], b = secs[2];
  for (let k = 0; k < 8; k++) {
    const k2 = (k + 1) % 8;
    B.tri([cx, cy, f.z + 0.004], [f.r[k][0], f.r[k][1], f.z], [f.r[k2][0], f.r[k2][1], f.z], M.paint, { n: [0, 0, 1] });
    B.tri([cx, cy, b.z], [b.r[k][0], b.r[k][1], b.z], [b.r[k2][0], b.r[k2][1], b.z], M.black, { n: [0, 0, -1] });
  }
  const mr = b.r.map(([x, y]) => [cx + (x - cx) * 0.82, cy + (y - cy) * 0.78]);
  for (let k = 0; k < 8; k++) {
    const k2 = (k + 1) % 8;
    B.tri([cx, cy, b.z - 0.003], [mr[k][0], mr[k][1], b.z - 0.003], [mr[k2][0], mr[k2][1], b.z - 0.003], M.chrome, { n: [0, 0, -1] });
  }
}

/** 车轮：胎面 + 圆鼓胎壁 + 轮辋 + 五辐（辐条间为深色凹陷）+ 轮毂盖；外侧朝 side */
function carWheel(B, cx, cz, r, w, side, fine) {
  const seg = fine ? 15 : 10;
  const xo = cx + (side * w) / 2, xi = cx - (side * w) / 2;
  const ref = [cx, r, cz];
  const P = (x, a, rr) => [x, r + Math.cos(a) * rr, cz + Math.sin(a) * rr];
  const n = { n: [side, 0, 0] };
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    B.quad(P(xo - side * 0.02, a0, r), P(xo - side * 0.02, a1, r), P(xi, a1, r), P(xi, a0, r), M.tire, ref);
    if (fine) {
      // 胎肩圆角 + 胎壁
      B.quad(P(xo - side * 0.02, a0, r), P(xo - side * 0.02, a1, r), P(xo, a1, r * 0.92), P(xo, a0, r * 0.92), M.tire, ref);
      B.quad(P(xo, a0, r * 0.92), P(xo, a1, r * 0.92), P(xo - side * 0.004, a1, r * 0.76), P(xo - side * 0.004, a0, r * 0.76), M.tire, n);
      // 轮辋外圈
      B.quad(P(xo - side * 0.004, a0, r * 0.76), P(xo - side * 0.004, a1, r * 0.76), P(xo - side * 0.012, a1, r * 0.68), P(xo - side * 0.012, a0, r * 0.68), RIM, n);
      // 五辐：每 3 段 1 段辐条（略凸），其余为深色凹陷
      const spoke = i % 3 === 0;
      const xr = spoke ? xo - side * 0.014 : xo - side * 0.05;
      B.quad(P(xo - side * 0.012, a0, r * 0.68), P(xo - side * 0.012, a1, r * 0.68), P(xr, a1, r * 0.24), P(xr, a0, r * 0.24), spoke ? RIM : RIM_DARK, n);
      B.tri([xo - side * 0.008, r, cz], P(xo - side * 0.016, a0, r * 0.24), P(xo - side * 0.016, a1, r * 0.24), RIM, n);
    } else {
      B.quad(P(xo, a0, r), P(xo, a1, r), P(xo, a1, r * 0.66), P(xo, a0, r * 0.66), M.tire, n);
      B.tri([xo + side * 0.003, r, cz], P(xo + side * 0.003, a0, r * 0.66), P(xo + side * 0.003, a1, r * 0.66), i % 2 ? RIM : RIM_DARK, n);
    }
  }
}

function buildCar(B, P, fine) {
  const secs = P.st.map((s) => ({ z: s[0], ring: carRing(s, fine) }));
  const nHalf = fine ? 9 : 6;
  const winE = fine ? 5 : 3; // 侧窗所在边
  B.loft(secs, (i, k) => {
    const [side, top] = IV[i];
    const e = sideEdge(k, nHalf);
    if (e === -2) return M.under;
    if (e === 0) return M.paintLow;
    if (e >= 0 && e < winE) return M.paint;
    if (e === winE) return side === 1 ? M.glass : M.paint;
    // 顶面（含两侧圆角）；top 3 = 外侧圆角带为立柱（与车顶同色：双色车身的立柱随黑车顶）、内侧玻璃
    if (top === 3) return e === winE + 1 ? M.roof : M.glass;
    return top === 1 ? M.glass : top === 2 ? M.roof : M.paint;
  }, { capFront: M.paint, capBack: M.paint, center: () => 0.75 });
  const fz = P.frontZ, rz = P.rearZ;
  const s0 = P.st[0], sN = P.st[P.st.length - 1];
  const zN = s0[0], zT = sN[0];
  // —— 前脸（全部贴在鼻尖封口上，不再凸出车身）：格栅（黑网 + 镀铬上框 + 车标）、下进气 ——
  const gTop = s0[4] - 0.03, gBot = Math.max(P.plateY + 0.085, s0[2] + 0.02);
  capPanel(B, P, true, -0.42, 0.42, gBot, gTop, GRILLE, 0.003);
  if (fine) {
    capPanel(B, P, true, -0.43, 0.43, gTop - 0.004, gTop + 0.014, M.chrome, 0.005);
    capPanel(B, P, true, -0.06, 0.06, (gBot + gTop) / 2 - 0.03, (gBot + gTop) / 2 + 0.03, M.chrome, 0.006); // 车标
  }
  B.box(0, P.plateY - 0.13, fz + 0.03, 1.2, 0.1, 0.05, M.black);
  // —— 号牌（深色牌框 + 贴图牌面）——
  B.box(0, P.plateY, fz + 0.055, 0.46, 0.155, 0.02, PLATE_FRAME);
  B.plateZ(0, P.plateY, fz + 0.066, 0.44, 0.14, M.plate, 1);
  B.box(0, P.rearPlateY, rz - 0.015, 0.46, 0.155, 0.02, PLATE_FRAME);
  B.plateZ(0, P.rearPlateY, rz - 0.026, 0.44, 0.14, M.plate, -1);
  // 前大灯：贴着机盖前缘与车头转角的灯面（透镜）、两只投射灯（细模）、前沿日行灯条、外端转向灯
  const st1 = P.st[1][0], st2 = P.st[2][0], t16 = P.st[16][0], t15 = P.st[15][0];
  const lerpZ = (a, b, t) => a + (b - a) * t;
  for (const sd of [1, -1]) {
    surfPatch(B, P, sd, 0.36, 0.98, [zN - 0.004, st1, st2], fine ? HEAD_COVER : M.head, 0.006, fine ? 4 : 2);
    if (fine) {
      surfPatch(B, P, sd, 0.49, 0.56, [lerpZ(zN, st1, 0.55), st1, lerpZ(st1, st2, 0.08)], PROJ, 0.009, 1);
      surfPatch(B, P, sd, 0.63, 0.7, [lerpZ(zN, st1, 0.55), st1, lerpZ(st1, st2, 0.08)], PROJ, 0.009, 1);
      surfPatch(B, P, sd, 0.38, 0.98, [zN - 0.005, lerpZ(zN, st1, 0.4)], M.drl, 0.011, 3);
    }
    surfPatch(B, P, sd, 0.76, 0.98, [lerpZ(st1, st2, 0.2), st2], sd > 0 ? M.turnL : M.turnR, 0.011, 1);
    if (fine) { B.box(sd * 0.68, P.plateY - 0.13, fz + 0.042, 0.16, 0.07, 0.03, M.lamp); B.box(sd * 0.68, P.plateY - 0.13, fz + 0.05, 0.1, 0.035, 0.02, LENS); } // 雾灯
    // 尾灯：贴在车尾上缘与转角的灯面（红色灯罩），内侧一道深色灯腔分隔，外端转向灯
    surfPatch(B, P, sd, 0.4, 0.98, [zT + 0.004, t16, t15], M.tail, 0.006, fine ? 4 : 2);
    if (fine) surfPatch(B, P, sd, 0.44, 0.98, [lerpZ(zT, t16, 0.55), lerpZ(zT, t16, 0.75)], M.lamp, 0.009, 3);
    surfPatch(B, P, sd, 0.8, 0.98, [t16, t15], sd > 0 ? M.turnL : M.turnR, 0.009, 1);
    carMirror(B, P, sd, fine);
    // 车轮 + 轮拱（深色轮罩开口 + 凸出的轮眉）
    for (const az of [P.axleF, P.axleR]) {
      const hwA = hwAt(P, az);
      carWheel(B, sd * (hwA + 0.012 - 0.11), az, P.wheelR, 0.22, sd, fine);
      const x = sd * (hwA + 0.004), R = P.wheelR + 0.07;
      const nA = fine ? 10 : 6;
      for (let k = 0; k < nA; k++) {
        const a0 = (Math.PI * k) / nA, a1 = (Math.PI * (k + 1)) / nA;
        const p0 = [x, P.wheelR + Math.sin(a0) * R, az + Math.cos(a0) * R], p1 = [x, P.wheelR + Math.sin(a1) * R, az + Math.cos(a1) * R];
        B.tri([x, P.wheelR, az], p0, p1, M.under, { n: [sd, 0, 0] });
        if (fine) {
          const R2 = R + 0.05, xo = x + sd * 0.016;
          const q0 = [xo, P.wheelR + Math.sin(a0) * R2, az + Math.cos(a0) * R2], q1 = [xo, P.wheelR + Math.sin(a1) * R2, az + Math.cos(a1) * R2];
          const r0 = [xo, p0[1], p0[2]], r1 = [xo, p1[1], p1[2]];
          B.quad(r0, r1, q1, q0, M.paint, { n: [sd, 0, 0] });
          B.quad(p0, p1, r1, r0, M.under, [0, P.wheelR, az]); // 轮眉内沿
        }
      }
    }
  }
  // 贯穿式尾灯（两灯之间的细亮条，贴车尾上缘）
  surfPatch(B, P, 1, -0.4, 0.4, [lerpZ(zT, t16, 0.4), lerpZ(zT, t16, 0.62)], M.tail, 0.007, 2);
  B.box(0, 0.35, rz - 0.0, 1.3, 0.1, 0.06, M.black);
  if (fine) {
    // 第三刹车灯（后窗顶）、鲨鱼鳍天线、雨刮
    B.box(0, stAt(P, P.brakeZ, 4) - 0.03, P.brakeZ, 0.3, 0.035, 0.05, M.tail);
    const zf = P.brakeZ + 0.4;
    B.obox(0, stAt(P, zf, 4) + 0.028, zf, 0.05, 0.06, 0.18, 0.2, M.paint);
    const zc = P.st[5][0] - 0.08, yc = P.st[5][4] + 0.02;
    for (const sd of [1, -1]) B.obox(sd * 0.28, yc, zc, 0.5, 0.012, 0.025, 0, M.black);
  }
  // 行李架（SUV/MPV）：纵梁 + 三个支脚，贴在车顶上；轿车的藏在车顶里（三形拓扑一致）
  for (const sd of [1, -1]) {
    const xr = stAt(P, -0.4, 6) * 0.82;
    const lift = P.rail > 0 ? 0.05 : -0.09;
    const ry = surfY(P, xr, -0.4) + lift;
    B.box(sd * xr, ry, -0.4, 0.035, 0.032, 1.55, M.black);
    for (const zf of [-1.1, -0.4, 0.3]) {
      const y0 = surfY(P, xr, zf) - 0.012;
      B.box(sd * xr, (y0 + ry) / 2, zf, 0.045, Math.max(0.01, ry - y0), 0.07, M.black);
    }
  }
  // 接触阴影
  B.quad([1.0, 0.03, 2.5], [-1.0, 0.03, 2.5], [-1.0, 0.03, -2.5], [1.0, 0.03, -2.5], M.under, { n: [0, 1, 0] });
  // 出租车顶灯（仅 kind=1 显示）：黑色底座贴在车顶上（略嵌入），白色灯箱 + 蓝色字带 + 前后“出租 TAXI”字面
  const ty = surfY(P, 0.36, -0.3);
  B.box(0, ty + 0.02, -0.30, 0.82, 0.06, 0.32, withKind(M.black, VK.TAXI));
  B.box(0, ty + 0.14, -0.30, 0.74, 0.18, 0.26, withKind(M.taxiSign, VK.TAXI));
  B.box(0, ty + 0.06, -0.30, 0.76, 0.03, 0.28, withKind(M.taxiBand, VK.TAXI));
  const tt = withKind(M.taxiText, VK.TAXI);
  B.quad([-0.34, ty + 0.075, -0.168], [0.34, ty + 0.075, -0.168], [0.34, ty + 0.215, -0.168], [-0.34, ty + 0.215, -0.168], tt, { n: [0, 0, 1] }, [[2, 0], [3, 0], [3, 1], [2, 1]]);
  B.quad([0.34, ty + 0.075, -0.432], [-0.34, ty + 0.075, -0.432], [-0.34, ty + 0.215, -0.432], [0.34, ty + 0.215, -0.432], tt, { n: [0, 0, -1] }, [[2, 0], [3, 0], [3, 1], [2, 1]]);
}

/** 小汽车几何：position = 轿车、position2 = SUV、position3 = MPV（法线同理） */
export function carGeometry(lod = 0) {
  const fine = lod === 0;
  const A = new GeoBuilder();
  buildCar(A, SEDAN, fine);
  const Bb = new GeoBuilder(A.flips);
  buildCar(Bb, SUV, fine);
  const C = new GeoBuilder(A.flips);
  buildCar(C, MPV, fine);
  const p2 = new Float32Array(Bb.P), p3 = new Float32Array(C.P);
  return A.toGeometry(38, {
    position2: new THREE.BufferAttribute(p2, 3),
    normal2: new THREE.BufferAttribute(smoothNormals(p2, 38), 3),
    position3: new THREE.BufferAttribute(p3, 3),
    normal3: new THREE.BufferAttribute(smoothNormals(p3, 38), 3),
  });
}
/** 着色器用的门缝/门把手位置（每形：前门前缘、前后门分缝、后门后缘、B 柱中心） */
export const DOOR_Z = [[0.83, -0.27, -1.25, -0.3], [0.86, -0.32, -1.32, -0.35], [0.95, -0.22, -1.5, -0.25]];
