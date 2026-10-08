// 车辆 / 列车程序化几何（全部顶点色 + 逐顶点材质参数，一个 draw call 画一类）
// 局部坐标：+x = 车辆左侧，+y = 上，+z = 车头方向；原点 = 车身中心在路面（轨顶）处的投影。
// 逐顶点属性：
//   color    基色（线性 RGB）
//   aMat     (paintMode, roughness, metalness, emissiveKind)
//             paintMode 0=顶点色 1=车漆(实例色) 2=第二色(车顶黑/货箱色) 3=号牌(蓝/绿) 4=条纹(实例色,列车) 5=车窗玻璃(深色贴膜 + 透见头枕)
//             emissiveKind 见 EM
//   aKind    所属车型（-1 = 通用部件；uber 几何按实例车型折叠其它车型的顶点）
// 参考尺寸：
//   轿车 4.70×1.83×1.46 m（吉利帝豪/比亚迪 e5 级别），SUV 4.75×1.90×1.72 m
//   西安公交：比亚迪 K9/BYD6122 纯电动 12.0×2.55×3.15 m（顶置电池舱），车身黄绿色、黑色窗带、红色 LED 路牌
//   渣土车：西安新型智能环保渣土车统一“活力绿”，全封闭顶盖，约 8.6×2.5×3.4 m
//   复兴号 CR400AF/BF：头车 27.2 m、中间车 25 m、宽 3.36 m、高 4.05 m；白色车体 + 红色(AF)/金色(BF)飘带
//   西安地铁 B 型车：19 m×2.8 m×3.8 m，不锈钢车体 + 线路色腰带（14 号线天蓝、3 号线品红）
import * as THREE from 'three';

export const EM = { NONE: 0, HEAD: 1, TAIL: 2, TURN_L: 3, TURN_R: 4, INTERIOR: 5, LED: 6, TAXI: 7, TRAIN_END: 8, DRL: 9, TRAIN_WIN: 10 };
export const PM = { NONE: 0, BODY: 1, SECOND: 2, PLATE: 3, STRIPE: 4, GLASS: 5 };

// 道路车辆车型编码
export const VK = { CAR: 0, TAXI: 1, BUS: 2, DUMP: 3, BOXTRUCK: 4, SEMI: 5 };
// 车长（米，用于间距/跟驰）
export const VK_LEN = [4.7, 4.7, 12.0, 8.6, 7.6, 16.5];
// 列车车辆编码
export const TK = { HSR_HEAD: 0, HSR_MID: 1, LOCO: 2, COACH: 3, GONDOLA: 4, TANK: 5, METRO_HEAD: 6, METRO_MID: 7 };
export const TK_LEN = [27.2, 25.0, 20.8, 25.5, 13.9, 12.2, 19.5, 19.0];

const col = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const lerp = (a, b, t) => a + (b - a) * t;

// —— 常用材质规格 ——
const M = {
  paint: { c: [1, 1, 1], paint: PM.BODY, rough: 0.28, metal: 0.45 },
  paintLow: { c: [0.82, 0.82, 0.82], paint: PM.BODY, rough: 0.32, metal: 0.4 },
  roof: { c: [1, 1, 1], paint: PM.SECOND, rough: 0.3, metal: 0.4 },
  second: { c: [1, 1, 1], paint: PM.SECOND, rough: 0.45, metal: 0.2 },
  // 车窗：金属度 0、极低粗糙度 → 环境贴图按菲涅耳反射天空/街景（正视发暗、斜视发亮），漫反射为透见的车内（着色器）
  glass: { c: col(0x0b0e12), paint: PM.GLASS, rough: 0.04, metal: 0.0 },
  lamp: { c: col(0x2a2c30), rough: 0.25, metal: 0.6 }, // 灯腔（深色反光碗）
  glassBus: { c: col(0x0a0c0f), rough: 0.06, metal: 0.3, em: EM.INTERIOR },
  black: { c: col(0x141516), rough: 0.7, metal: 0.0 },
  trim: { c: col(0x1d1f22), rough: 0.45, metal: 0.3 },
  under: { c: col(0x060606), rough: 1.0, metal: 0.0 },
  tire: { c: col(0x121212), rough: 0.9, metal: 0.0 },
  rim: { c: col(0xb9bcc0), rough: 0.3, metal: 0.9 },
  chrome: { c: col(0xcfd3d6), rough: 0.2, metal: 1.0 },
  head: { c: col(0xd8dde2), rough: 0.08, metal: 0.2, em: EM.HEAD },
  drl: { c: col(0xe8ecf0), rough: 0.1, metal: 0.1, em: EM.DRL },
  tail: { c: col(0x6a0a08), rough: 0.12, metal: 0.1, em: EM.TAIL },
  turnL: { c: col(0x8a5a10), rough: 0.12, metal: 0.1, em: EM.TURN_L },
  turnR: { c: col(0x8a5a10), rough: 0.12, metal: 0.1, em: EM.TURN_R },
  plate: { c: [1, 1, 1], paint: PM.PLATE, rough: 0.4, metal: 0.3 },
  led: { c: col(0x1a0c06), rough: 0.3, metal: 0.0, em: EM.LED },
  taxiSign: { c: col(0xf2f2ee), rough: 0.35, metal: 0.0, em: EM.TAXI },
  taxiBand: { c: col(0x1f4f9a), rough: 0.35, metal: 0.0 },
  greyLight: { c: col(0xc9ccd0), rough: 0.5, metal: 0.2 },
  greyDark: { c: col(0x3a3d41), rough: 0.6, metal: 0.2 },
};
const withKind = (m, kind) => ({ ...m, kind });

// ======================================================================
// 几何构建器
// ======================================================================
class GeoBuilder {
  constructor(replay = null) {
    this.P = []; this.C = []; this.M = []; this.K = [];
    this.flips = replay || [];
    this.replay = !!replay;
    this.fi = 0;
    this.kind = -1;
  }
  /** 三角形；ref = 内部参考点（数组）或 {n:[外法线]}，自动定向为外法线朝外 */
  tri(a, b, c, m, ref) {
    let flip;
    if (this.replay) flip = this.flips[this.fi++];
    else {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      let dx, dy, dz;
      if (ref && ref.n) { [dx, dy, dz] = ref.n; }
      else {
        dx = (a[0] + b[0] + c[0]) / 3 - ref[0];
        dy = (a[1] + b[1] + c[1]) / 3 - ref[1];
        dz = (a[2] + b[2] + c[2]) / 3 - ref[2];
      }
      flip = nx * dx + ny * dy + nz * dz < 0;
      this.flips.push(flip);
    }
    const vs = flip ? [a, c, b] : [a, b, c];
    const k = m.kind !== undefined ? m.kind : this.kind;
    for (const v of vs) {
      this.P.push(v[0], v[1], v[2]);
      this.C.push(m.c[0], m.c[1], m.c[2]);
      this.M.push(m.paint || 0, m.rough ?? 0.5, m.metal ?? 0, m.em || 0);
      this.K.push(k);
    }
  }
  quad(a, b, c, d, m, ref) { this.tri(a, b, c, m, ref); this.tri(a, c, d, m, ref); }
  /** 轴对齐盒（中心、尺寸）；skip: 'bottom'/'back' 等可省面 */
  box(cx, cy, cz, sx, sy, sz, m, skip = '') {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const ref = [cx, cy, cz];
    if (!skip.includes('top')) this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], m, ref);
    if (!skip.includes('bottom')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], m, ref);
    if (!skip.includes('front')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], m, ref);
    if (!skip.includes('back')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], m, ref);
    if (!skip.includes('left')) this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], m, ref);
    if (!skip.includes('right')) this.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], m, ref);
  }
  /** 竖直矩形面板（法线 n），用于灯、窗、号牌等贴面 */
  panelZ(cx, cy, z, sx, sy, m, facing) {
    const n = { n: [0, 0, facing] };
    this.quad([cx - sx / 2, cy - sy / 2, z], [cx + sx / 2, cy - sy / 2, z], [cx + sx / 2, cy + sy / 2, z], [cx - sx / 2, cy + sy / 2, z], m, n);
  }
  panelX(x, cy, cz, sz, sy, m, facing) {
    const n = { n: [facing, 0, 0] };
    this.quad([x, cy - sy / 2, cz - sz / 2], [x, cy - sy / 2, cz + sz / 2], [x, cy + sy / 2, cz + sz / 2], [x, cy + sy / 2, cz - sz / 2], m, n);
  }
  /** 车轮：轴沿 x，中心 (cx, r, cz)，side=+1 左轮（外侧朝 +x） */
  wheel(cx, cz, r, w, side, seg = 12, rimScale = 0.62) {
    const xo = cx + (side * w) / 2, xi = cx - (side * w) / 2;
    const ref = [cx, r, cz];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const y0 = r + Math.cos(a0) * r, z0 = cz + Math.sin(a0) * r, y1 = r + Math.cos(a1) * r, z1 = cz + Math.sin(a1) * r;
      this.quad([xo, y0, z0], [xo, y1, z1], [xi, y1, z1], [xi, y0, z0], M.tire, ref);
      // 外侧：胎壁环 + 轮毂盘
      const rr = r * rimScale;
      const ya = r + Math.cos(a0) * rr, za = cz + Math.sin(a0) * rr, yb = r + Math.cos(a1) * rr, zb = cz + Math.sin(a1) * rr;
      this.quad([xo, y0, z0], [xo, y1, z1], [xo, yb, zb], [xo, ya, za], M.tire, { n: [side, 0, 0] });
      this.tri([xo + side * 0.005, r, cz], [xo + side * 0.005, ya, za], [xo + side * 0.005, yb, zb], M.rim, { n: [side, 0, 0] });
    }
  }
  /** 放样：sections[i] = {z, ring:[[x,y],...]}（闭合环），edgeMat(i, k) 返回区间 i 的第 k 条环边材质 */
  loft(sections, edgeMat, { capFront = null, capBack = null, center = null } = {}) {
    const nR = sections[0].ring.length;
    for (let i = 0; i + 1 < sections.length; i++) {
      const A = sections[i], B = sections[i + 1];
      for (let k = 0; k < nR; k++) {
        const k2 = (k + 1) % nR;
        const m = edgeMat(i, k);
        if (!m) continue;
        const a = [A.ring[k][0], A.ring[k][1], A.z], b = [A.ring[k2][0], A.ring[k2][1], A.z];
        const c = [B.ring[k2][0], B.ring[k2][1], B.z], d = [B.ring[k][0], B.ring[k][1], B.z];
        const cy = center ? center(i) : (A.ring.reduce((s, p) => s + p[1], 0) / nR);
        const ref = [0, cy, (A.z + B.z) / 2];
        this.quad(a, b, c, d, m, ref);
      }
    }
    const cap = (S, m, dir) => {
      if (!m) return;
      const cy = S.ring.reduce((s, p) => s + p[1], 0) / nR;
      const c = [0, cy, S.z];
      for (let k = 0; k < nR; k++) {
        const k2 = (k + 1) % nR;
        this.tri(c, [S.ring[k][0], S.ring[k][1], S.z], [S.ring[k2][0], S.ring[k2][1], S.z], m, { n: [0, 0, dir] });
      }
    };
    cap(sections[0], capFront, sections[0].z > sections[sections.length - 1].z ? 1 : -1);
    cap(sections[sections.length - 1], capBack, sections[0].z > sections[sections.length - 1].z ? -1 : 1);
  }
  toGeometry(creaseDeg = 40, extra = null) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(this.P);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(smoothNormals(pos, creaseDeg), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.C), 3));
    g.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(this.M), 4));
    g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(this.K), 1));
    if (extra) for (const [k, v] of Object.entries(extra)) g.setAttribute(k, v);
    return g;
  }
}

/** 折痕角平滑法线：同位置、法线夹角小于 crease 的面参与平均 */
function smoothNormals(pos, creaseDeg) {
  const nTri = pos.length / 9;
  const fn = new Float32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    fn[t * 3] = uy * vz - uz * vy; fn[t * 3 + 1] = uz * vx - ux * vz; fn[t * 3 + 2] = ux * vy - uy * vx; // 面积加权
  }
  const key = (i) => `${Math.round(pos[i] * 500)},${Math.round(pos[i + 1] * 500)},${Math.round(pos[i + 2] * 500)}`;
  const map = new Map();
  for (let v = 0; v < pos.length / 3; v++) {
    const k = key(v * 3);
    let l = map.get(k);
    if (!l) map.set(k, (l = []));
    l.push(v);
  }
  const cosC = Math.cos((creaseDeg * Math.PI) / 180);
  const out = new Float32Array(pos.length);
  for (const l of map.values()) {
    for (const v of l) {
      const t = (v / 3) | 0;
      let ax = fn[t * 3], ay = fn[t * 3 + 1], az = fn[t * 3 + 2];
      const la = Math.hypot(ax, ay, az) || 1;
      let sx = 0, sy = 0, sz = 0;
      for (const w of l) {
        const u = (w / 3) | 0;
        const bx = fn[u * 3], by = fn[u * 3 + 1], bz = fn[u * 3 + 2];
        const lb = Math.hypot(bx, by, bz) || 1;
        if ((ax * bx + ay * by + az * bz) / (la * lb) >= cosC) { sx += bx; sy += by; sz += bz; }
      }
      const ls = Math.hypot(sx, sy, sz) || 1;
      out[v * 3] = sx / ls; out[v * 3 + 1] = sy / ls; out[v * 3 + 2] = sz / ls;
      void ax; void ay; void az;
    }
  }
  return out;
}

// ======================================================================
// 小汽车（轿车 ↔ SUV 形变，拓扑一致）
// ======================================================================
// 站点：[z, yb(底), ys(裙线), yw(腰线), yt(顶), hw(腰线半宽), hwt(顶半宽)]
const SEDAN = {
  st: [
    [2.36, 0.30, 0.42, 0.60, 0.66, 0.78, 0.70],
    [2.30, 0.22, 0.38, 0.70, 0.76, 0.87, 0.80],
    [2.05, 0.19, 0.36, 0.78, 0.84, 0.905, 0.85],
    [1.45, 0.19, 0.36, 0.86, 0.91, 0.915, 0.87],
    [0.98, 0.19, 0.36, 0.90, 0.95, 0.915, 0.86],
    [0.18, 0.19, 0.36, 0.94, 1.43, 0.915, 0.69],
    [-0.12, 0.19, 0.36, 0.95, 1.46, 0.915, 0.70],
    [-0.30, 0.19, 0.36, 0.95, 1.46, 0.915, 0.70],
    [-0.95, 0.19, 0.36, 0.95, 1.44, 0.915, 0.69],
    [-1.18, 0.19, 0.36, 0.95, 1.40, 0.915, 0.68],
    [-1.78, 0.20, 0.37, 0.95, 1.02, 0.91, 0.80],
    [-2.20, 0.24, 0.40, 0.93, 0.99, 0.89, 0.80],
    [-2.33, 0.28, 0.42, 0.86, 0.92, 0.85, 0.76],
    [-2.37, 0.34, 0.45, 0.78, 0.82, 0.78, 0.70],
  ],
  wheelR: 0.325, axleF: 1.40, axleR: -1.37, track: 0.80, headY: 0.70, tailY: 0.86, plateY: 0.42, rearPlateY: 0.58,
  frontZ: 2.33, rearZ: -2.35, mirrorY: 1.0, mirrorZ: 0.80, roofY: 1.46,
};
const SUV = {
  st: [
    [2.38, 0.38, 0.52, 0.72, 0.80, 0.82, 0.74],
    [2.32, 0.30, 0.48, 0.88, 0.94, 0.91, 0.84],
    [2.10, 0.27, 0.46, 0.98, 1.04, 0.94, 0.89],
    [1.55, 0.27, 0.46, 1.04, 1.09, 0.95, 0.91],
    [1.18, 0.27, 0.46, 1.06, 1.12, 0.95, 0.90],
    [0.42, 0.27, 0.46, 1.08, 1.68, 0.95, 0.76],
    [0.08, 0.27, 0.46, 1.08, 1.72, 0.95, 0.78],
    [-0.12, 0.27, 0.46, 1.08, 1.72, 0.95, 0.78],
    [-1.15, 0.27, 0.46, 1.08, 1.71, 0.95, 0.78],
    [-1.95, 0.27, 0.46, 1.08, 1.69, 0.95, 0.77],
    [-2.27, 0.28, 0.47, 1.06, 1.14, 0.94, 0.84],
    [-2.33, 0.30, 0.49, 1.02, 1.06, 0.93, 0.85],
    [-2.37, 0.33, 0.50, 0.92, 0.97, 0.90, 0.82],
    [-2.40, 0.40, 0.52, 0.82, 0.86, 0.82, 0.74],
  ],
  wheelR: 0.37, axleF: 1.45, axleR: -1.40, track: 0.83, headY: 0.90, tailY: 1.05, plateY: 0.52, rearPlateY: 0.70,
  frontZ: 2.36, rearZ: -2.38, mirrorY: 1.2, mirrorZ: 1.00, roofY: 1.72,
};
// 区间类型：[侧面 0 车身 / 1 玻璃 / 2 黑色立柱, 顶面 0 车身(引擎盖/行李箱) / 1 玻璃 / 2 车顶]
const CAR_INTERVALS = [
  [0, 0], [0, 0], [0, 0], [0, 0], [1, 1], [1, 2], [2, 2], [1, 2], [1, 2], [0, 1], [0, 0], [0, 0], [0, 0],
];

function carRing(s) {
  const [, yb, ys, yw, yt, hw, hwt] = s;
  // 腰线肩部（车窗下沿向内收 2.5%）：侧面在腰线处有一道折线高光，车身不再是平板盒子
  const ysh = Math.min(yw + 0.045, yt - 0.06);
  return [
    [hw * 0.93, yb], [hw, ys], [hw, yw], [hw * 0.975, ysh], [hwt, yt - 0.05], [hwt * 0.55, yt],
    [-hwt * 0.55, yt], [-hwt, yt - 0.05], [-hw * 0.975, ysh], [-hw, yw], [-hw, ys], [-hw * 0.93, yb],
  ];
}
/** 站点表在 z 处的腰线半宽（线性插值） */
function hwAt(P, z) {
  const st = P.st;
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i], b = st[i + 1];
    if ((z <= a[0] && z >= b[0]) || (z >= a[0] && z <= b[0])) return a[5] + ((b[5] - a[5]) * (z - a[0])) / (b[0] - a[0] || 1);
  }
  return st[0][5];
}

function buildCar(B, P) {
  const secs = P.st.map((s) => ({ z: s[0], ring: carRing(s) }));
  B.loft(secs, (i, k) => {
    const [side, top] = CAR_INTERVALS[i];
    if (k === 11) return M.under;
    if (k === 0 || k === 10) return M.paintLow;
    if (k === 1 || k === 9 || k === 2 || k === 8) return M.paint; // 侧板 + 腰线肩部
    if (k === 3 || k === 7) return side === 1 ? M.glass : side === 2 ? M.trim : M.paint;
    // 4,5,6：顶面
    return top === 1 ? M.glass : top === 2 ? M.roof : M.paint;
  }, { capFront: M.paint, capBack: M.paint, center: () => 0.7 });
  const fz = P.frontZ, rz = P.rearZ;
  // 前脸
  B.box(0, P.headY - 0.17, fz + 0.01, 0.92, 0.2, 0.08, M.trim); // 格栅
  B.box(0, P.plateY - 0.12, fz + 0.03, 1.2, 0.1, 0.05, M.black); // 下进气
  for (const sd of [1, -1]) {
    // 前大灯：深色灯腔（略大、略靠后）+ 发光灯罩 + 下沿日行灯条 → 有进深的灯组，而不是一块贴片
    B.box(sd * 0.60, P.headY + 0.005, fz - 0.1, 0.46, 0.15, 0.2, M.lamp, 'back');
    B.box(sd * 0.60, P.headY, fz - 0.06, 0.4, 0.1, 0.2, M.head);
    B.box(sd * 0.62, P.headY - 0.075, fz - 0.03, 0.40, 0.03, 0.14, M.drl);
    B.box(sd * 0.83, P.headY, fz - 0.2, 0.08, 0.07, 0.2, sd > 0 ? M.turnL : M.turnR);
    // 尾灯：深红灯腔 + 内侧亮条
    B.box(sd * 0.60, P.tailY, rz + 0.06, 0.5, 0.15, 0.12, M.lamp, 'front');
    B.box(sd * 0.60, P.tailY, rz + 0.04, 0.46, 0.12, 0.12, M.tail);
    B.box(sd * 0.84, P.tailY - 0.02, rz + 0.12, 0.06, 0.1, 0.12, sd > 0 ? M.turnL : M.turnR);
    // 后视镜
    B.box(sd * 0.99, P.mirrorY, P.mirrorZ, 0.16, 0.12, 0.24, M.paint);
    B.box(sd * 0.99, P.mirrorY, P.mirrorZ - 0.121, 0.13, 0.09, 0.005, M.chrome);
    // 车轮外侧面与车身侧板齐平（原先整轮缩在车身里，只露底下一条，像方盒在地上滑），
    // 轮上方贴半圆形暗色轮拱开口（8 个三角形）
    for (const az of [P.axleF, P.axleR]) {
      const hwA = hwAt(P, az);
      B.wheel(sd * (hwA + 0.012 - 0.11), az, P.wheelR, 0.22, sd);
      const x = sd * (hwA + 0.004), R = P.wheelR + 0.075;
      for (let k = 0; k < 8; k++) {
        const a0 = (Math.PI * k) / 8, a1 = (Math.PI * (k + 1)) / 8;
        B.tri([x, P.wheelR, az], [x, P.wheelR + Math.sin(a0) * R, az + Math.cos(a0) * R], [x, P.wheelR + Math.sin(a1) * R, az + Math.cos(a1) * R], M.under, { n: [sd, 0, 0] });
      }
    }
  }
  B.box(0, P.tailY + 0.02, rz + 0.01, 0.72, 0.035, 0.06, M.tail); // 贯穿式尾灯
  B.box(0, P.plateY, fz + 0.06, 0.44, 0.14, 0.02, M.plate);
  B.box(0, P.rearPlateY, rz - 0.02, 0.44, 0.14, 0.02, M.plate);
  B.box(0, 0.33, rz - 0.0, 1.3, 0.1, 0.06, M.black);
  // 接触阴影
  B.quad([1.0, 0.03, 2.5], [-1.0, 0.03, 2.5], [-1.0, 0.03, -2.5], [1.0, 0.03, -2.5], M.under, { n: [0, 1, 0] });
  // 出租车顶灯（仅 kind=1 显示）：白色灯箱 + 蓝色字带（西安出租车顶灯为白底蓝字）
  B.box(0, P.roofY + 0.03, -0.30, 0.82, 0.06, 0.32, withKind(M.black, VK.TAXI));
  B.box(0, P.roofY + 0.15, -0.30, 0.74, 0.18, 0.26, withKind(M.taxiSign, VK.TAXI));
  B.box(0, P.roofY + 0.13, -0.30, 0.76, 0.05, 0.28, withKind(M.taxiBand, VK.TAXI));
}

/** 近景小汽车几何（position = 轿车，position2 = SUV，normal2 = SUV 法线） */
export function carNearGeometry() {
  const A = new GeoBuilder();
  buildCar(A, SEDAN);
  const Bb = new GeoBuilder(A.flips);
  buildCar(Bb, SUV);
  const pos2 = new Float32Array(Bb.P);
  const g = A.toGeometry(38, {
    position2: new THREE.BufferAttribute(pos2, 3),
    normal2: new THREE.BufferAttribute(smoothNormals(pos2, 38), 3),
  });
  return g;
}

// ======================================================================
// 大型车：公交 / 渣土车 / 厢式货车 / 半挂（uber 几何，按 aKind 折叠）
// ======================================================================
function buildBus(B) {
  B.kind = VK.BUS;
  const hw = 1.275;
  const ring = [
    [hw - 0.03, 0.32], [hw, 0.62], [hw, 1.05], [hw, 2.72], [hw - 0.08, 3.02], [hw - 0.4, 3.13],
    [-hw + 0.4, 3.13], [-hw + 0.08, 3.02], [-hw, 2.72], [-hw, 1.05], [-hw, 0.62], [-hw + 0.03, 0.32],
  ];
  // 纵向站点：前门 4.1~5.3、中门 -0.55~0.65，窗柱
  const zs = [6.0, 5.88, 5.3, 4.1, 3.2, 3.05, 1.9, 1.75, 0.65, -0.55, -1.6, -1.75, -2.9, -3.05, -4.2, -4.35, -5.85, -6.0];
  const door = (za, zb) => (za <= 5.3 && zb >= 4.1) || (za <= 0.65 && zb >= -0.55);
  const secs = zs.map((z, i) => {
    const sc = i === 0 || i === zs.length - 1 ? 0.97 : 1;
    return { z, ring: ring.map(([x, y]) => [x * sc, y * (i === 0 ? 0.995 : 1)]) };
  });
  const paint = M.paint, low = { c: col(0x2b2d30), rough: 0.6, metal: 0.2 };
  B.loft(secs, (i, k) => {
    const za = zs[i], zb = zs[i + 1];
    const isDoor = door(Math.max(za, zb), Math.min(za, zb)) && Math.abs(za - zb) > 0.5;
    const pillar = Math.abs(za - zb) < 0.2 || i === 0 || i === zs.length - 2;
    if (k === 11) return M.under;
    if (k === 0 || k === 10) return low;
    if (k === 1 || k === 9) return isDoor && k === 9 ? M.glassBus : paint; // 右侧（-x）为车门侧
    if (k === 2 || k === 8) return pillar ? M.black : M.glassBus;
    return paint;
  }, { capFront: paint, capBack: paint, center: () => 1.6 });
  // 前脸：大挡风玻璃、LED 路牌、前灯
  B.panelZ(0, 1.85, 6.02, 2.3, 1.55, M.glassBus, 1);
  B.panelZ(0, 2.82, 6.02, 1.8, 0.24, M.led, 1);
  B.panelZ(0, 0.72, 6.02, 2.4, 0.5, M.paint, 1);
  for (const sd of [1, -1]) {
    B.box(sd * 0.92, 0.72, 6.0, 0.42, 0.2, 0.08, M.head);
    B.box(sd * 0.93, 0.58, 6.0, 0.36, 0.04, 0.08, M.drl);
    B.box(sd * 1.18, 0.74, 5.95, 0.1, 0.12, 0.12, sd > 0 ? M.turnL : M.turnR);
    B.box(sd * 1.1, 0.95, -6.0, 0.16, 0.6, 0.06, M.tail);
    B.box(sd * 1.1, 1.35, -6.0, 0.14, 0.14, 0.06, sd > 0 ? M.turnL : M.turnR);
    // 羊角后视镜
    B.box(sd * 1.42, 2.3, 6.15, 0.1, 0.35, 0.18, M.black);
    // 车轮（后轴双胎）
    B.wheel(sd * 1.02, 3.4, 0.5, 0.3, sd, 12, 0.55);
    B.wheel(sd * 0.98, -2.5, 0.5, 0.55, sd, 12, 0.55);
  }
  B.panelZ(0, 2.2, -6.02, 1.9, 0.75, M.glassBus, -1);
  B.panelZ(0, 2.82, -6.02, 0.9, 0.24, M.led, -1);
  B.panelZ(0, 0.55, 6.04, 0.44, 0.14, M.plate, 1);
  B.panelZ(0, 0.6, -6.04, 0.44, 0.14, M.plate, -1);
  // 车顶电池舱 / 空调
  B.box(0, 3.24, -1.2, 2.0, 0.24, 5.6, M.greyLight, 'bottom');
  B.box(0, 3.22, 3.4, 1.7, 0.2, 1.8, M.paint, 'bottom');
  B.quad([1.35, 0.03, 6.2], [-1.35, 0.03, 6.2], [-1.35, 0.03, -6.2], [1.35, 0.03, -6.2], M.under, { n: [0, 1, 0] });
}

function truckCab(B, z0, z1, hw, y0, y1, cabMat) {
  // 平头驾驶室：箱体 + 前挡风 + 侧窗
  const zc = (z0 + z1) / 2;
  B.box(0, (y0 + y1) / 2, zc, hw * 2, y1 - y0, z1 - z0, cabMat, 'bottom');
  B.panelZ(0, lerp(y0, y1, 0.66), z1 + 0.01, hw * 1.8, (y1 - y0) * 0.36, M.glass, 1);
  for (const sd of [1, -1]) B.panelX(sd * (hw + 0.01), lerp(y0, y1, 0.66), zc + 0.1, (z1 - z0) * 0.6, (y1 - y0) * 0.32, M.glass, sd);
  // 前保险杠与大灯
  B.box(0, y0 - 0.2, z1 + 0.06, hw * 2, 0.35, 0.18, M.greyDark);
  for (const sd of [1, -1]) {
    B.box(sd * (hw - 0.35), y0 - 0.2, z1 + 0.16, 0.36, 0.14, 0.04, M.head);
    B.box(sd * (hw - 0.08), y0 - 0.2, z1 + 0.16, 0.1, 0.1, 0.04, sd > 0 ? M.turnL : M.turnR);
    B.box(sd * (hw + 0.12), lerp(y0, y1, 0.62), z1 - 0.1, 0.08, 0.4, 0.12, M.black);
  }
  B.panelZ(0, y0 - 0.02, z1 + 0.16, 0.44, 0.14, M.plate, 1);
}

function buildDump(B) {
  B.kind = VK.DUMP;
  const hw = 1.25;
  truckCab(B, 2.95, 4.3, hw, 1.05, 3.05, M.paint);
  // 导流罩
  B.box(0, 3.18, 3.45, 2.2, 0.26, 1.2, M.paint, 'bottom');
  // 底盘
  B.box(0, 0.78, -0.2, 0.9, 0.42, 8.3, M.black);
  // 货箱（封闭顶盖）
  B.box(0, 1.95, -0.75, 2.5, 1.6, 7.1, M.paint);
  B.box(0, 2.82, -0.75, 2.3, 0.14, 7.0, M.paintLow, 'bottom');
  for (const z of [-3.6, -2.4, -1.2, 0, 1.2, 2.3]) B.box(0, 1.95, z, 2.56, 1.5, 0.12, M.paintLow);
  B.box(0, 1.2, -0.75, 2.56, 0.12, 7.14, M.greyDark);
  for (const sd of [1, -1]) {
    B.box(sd * 1.0, 0.95, -4.33, 0.3, 0.14, 0.06, M.tail);
    B.box(sd * 0.72, 0.95, -4.33, 0.14, 0.14, 0.06, sd > 0 ? M.turnL : M.turnR);
    B.wheel(sd * 1.0, 3.45, 0.52, 0.32, sd, 12, 0.5);
    B.wheel(sd * 0.95, -1.5, 0.52, 0.6, sd, 12, 0.5);
    B.wheel(sd * 0.95, -2.85, 0.52, 0.6, sd, 12, 0.5);
  }
  B.box(0, 0.5, -4.3, 2.3, 0.14, 0.1, M.greyDark);
  B.panelZ(0, 0.72, -4.36, 0.44, 0.22, M.plate, -1);
  B.quad([1.3, 0.03, 4.5], [-1.3, 0.03, 4.5], [-1.3, 0.03, -4.4], [1.3, 0.03, -4.4], M.under, { n: [0, 1, 0] });
}

function buildBoxTruck(B) {
  B.kind = VK.BOXTRUCK;
  const hw = 1.18;
  truckCab(B, 2.4, 3.8, hw, 0.95, 2.75, M.paint);
  B.box(0, 0.7, -0.3, 0.85, 0.36, 7.2, M.black);
  B.box(0, 2.2, -0.75, 2.4, 2.3, 6.1, M.second);
  B.box(0, 1.03, -0.75, 2.44, 0.1, 6.14, M.greyDark);
  for (const sd of [1, -1]) {
    B.box(sd * 0.95, 1.2, -3.82, 0.24, 0.14, 0.05, M.tail);
    B.wheel(sd * 0.98, 2.95, 0.45, 0.28, sd, 12, 0.5);
    B.wheel(sd * 0.93, -2.1, 0.45, 0.52, sd, 12, 0.5);
  }
  B.panelZ(0, 0.8, -3.84, 0.44, 0.22, M.plate, -1);
  B.quad([1.25, 0.03, 4.0], [-1.25, 0.03, 4.0], [-1.25, 0.03, -3.9], [1.25, 0.03, -3.9], M.under, { n: [0, 1, 0] });
}

function buildSemi(B) {
  B.kind = VK.SEMI;
  const hw = 1.25;
  truckCab(B, 6.35, 8.25, hw, 1.1, 3.75, M.paint);
  B.box(0, 3.95, 7.2, 2.3, 0.4, 1.6, M.paint, 'bottom');
  B.box(0, 0.85, 1.0, 0.9, 0.4, 14.5, M.black);
  // 集装箱（第二色）+ 瓦楞
  B.box(0, 2.65, -1.25, 2.5, 2.6, 13.6, M.second);
  for (let z = -7.6; z <= 5.2; z += 1.6) B.box(0, 2.65, z, 2.54, 2.5, 0.08, M.second);
  B.box(0, 1.3, -1.25, 2.5, 0.2, 13.8, M.greyDark);
  for (const sd of [1, -1]) {
    B.box(sd * 1.0, 1.1, -8.12, 0.26, 0.14, 0.05, M.tail);
    B.wheel(sd * 1.0, 7.35, 0.52, 0.32, sd, 12, 0.5);
    B.wheel(sd * 0.95, 5.1, 0.52, 0.6, sd, 12, 0.5);
    B.wheel(sd * 0.95, 3.8, 0.52, 0.6, sd, 12, 0.5);
    for (const z of [-5.0, -6.3, -7.6]) B.wheel(sd * 0.95, z, 0.5, 0.55, sd, 10, 0.5);
  }
  B.panelZ(0, 0.9, -8.07, 0.44, 0.22, M.plate, -1);
  B.quad([1.3, 0.03, 8.4], [-1.3, 0.03, 8.4], [-1.3, 0.03, -8.3], [1.3, 0.03, -8.3], M.under, { n: [0, 1, 0] });
}

export function heavyNearGeometry() {
  const B = new GeoBuilder();
  buildBus(B);
  buildDump(B);
  buildBoxTruck(B);
  buildSemi(B);
  return B.toGeometry(38);
}

// ======================================================================
// 远景代理（所有道路车辆共用，一个盒子 + 玻璃带 + 灯，尺寸由着色器按车型参数化）
// 顶点属性 aFar = (侧 -1/0/+1, 层级 0 底 / 1 腰 / 2 窗顶 / 3 顶, z 代码 0..5, 材质 0 漆 1 玻璃 2 暗 3 前灯 4 尾灯)
//   z 代码：0 车身前 1 车身后 2 腰线处玻璃前 3 腰线处玻璃后 4 窗顶玻璃前 5 窗顶玻璃后
// aFarOff = 额外偏移（米），用于灯片
// ======================================================================
export function farVehicleGeometry() {
  const P = [], F = [], O = [];
  const v = (sx, lvl, zc, mat, off = [0, 0, 0]) => { P.push(0, 0, 0); F.push(sx, lvl, zc, mat); O.push(...off); };
  const quad = (a, b, c, d) => { for (const q of [a, b, c, a, c, d]) v(...q); };
  // 下车身：四周 + 底
  quad([1, 0, 0, 0], [-1, 0, 0, 0], [-1, 1, 0, 0], [1, 1, 0, 0]); // 前
  quad([-1, 0, 1, 0], [1, 0, 1, 0], [1, 1, 1, 0], [-1, 1, 1, 0]); // 后
  quad([1, 0, 1, 0], [1, 0, 0, 0], [1, 1, 0, 0], [1, 1, 1, 0]); // 左
  quad([-1, 0, 0, 0], [-1, 0, 1, 0], [-1, 1, 1, 0], [-1, 1, 0, 0]); // 右
  // 腰线平面：前段（引擎盖）、后段（行李箱）
  quad([1, 1, 0, 0], [-1, 1, 0, 0], [-1, 1, 2, 0], [1, 1, 2, 0]);
  quad([1, 1, 3, 0], [-1, 1, 3, 0], [-1, 1, 1, 0], [1, 1, 1, 0]);
  // 玻璃罩（前挡、后挡、左右侧窗）：腰线环 (x=±1, z 2/3) → 窗顶环 (x=±t, z 4/5)
  quad([1, 1, 2, 1], [-1, 1, 2, 1], [-2, 2, 4, 1], [2, 2, 4, 1]);
  quad([-1, 1, 3, 1], [1, 1, 3, 1], [2, 2, 5, 1], [-2, 2, 5, 1]);
  quad([1, 1, 3, 1], [1, 1, 2, 1], [2, 2, 4, 1], [2, 2, 5, 1]);
  quad([-1, 1, 2, 1], [-1, 1, 3, 1], [-2, 2, 5, 1], [-2, 2, 4, 1]);
  // 窗顶 → 车顶（窄带）与车顶
  quad([2, 2, 4, 0], [-2, 2, 4, 0], [-2, 3, 4, 0], [2, 3, 4, 0]);
  quad([-2, 2, 5, 0], [2, 2, 5, 0], [2, 3, 5, 0], [-2, 3, 5, 0]);
  quad([2, 2, 5, 0], [2, 2, 4, 0], [2, 3, 4, 0], [2, 3, 5, 0]);
  quad([-2, 2, 4, 0], [-2, 2, 5, 0], [-2, 3, 5, 0], [-2, 3, 4, 0]);
  quad([2, 3, 4, 0], [-2, 3, 4, 0], [-2, 3, 5, 0], [2, 3, 5, 0]);
  // 灯片（前灯白、尾灯红），在腰线下方
  for (const sd of [1, -1]) {
    const lx = sd * 0.62;
    quad([1, 1, 0, 3, [lx - sd * 1e-3 - 0.18 * sd, -0.25, 0.03]], [1, 1, 0, 3, [lx + 0.18 * sd, -0.25, 0.03]], [1, 1, 0, 3, [lx + 0.18 * sd, -0.12, 0.03]], [1, 1, 0, 3, [lx - 0.18 * sd, -0.12, 0.03]]);
    quad([1, 1, 1, 4, [lx + 0.2 * sd, -0.18, -0.03]], [1, 1, 1, 4, [lx - 0.2 * sd, -0.18, -0.03]], [1, 1, 1, 4, [lx - 0.2 * sd, -0.05, -0.03]], [1, 1, 1, 4, [lx + 0.2 * sd, -0.05, -0.03]]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('aFar', new THREE.BufferAttribute(new Float32Array(F), 4));
  g.setAttribute('aFarOff', new THREE.BufferAttribute(new Float32Array(O), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(P.length), 3));
  return g;
}

// ======================================================================
// 列车
// ======================================================================
/** 复兴号横断面（半边自下而上，镜像成闭环）；返回 [环, 环边材质函数] */
function hsrRing() {
  const half = [
    [1.50, 0.50], [1.66, 0.95], [1.68, 1.30], [1.68, 1.52], [1.68, 2.02], [1.68, 2.62], [1.64, 3.10], [1.45, 3.62], [1.00, 3.93], [0.40, 4.05],
  ];
  const ring = [...half, ...half.slice().reverse().map(([x, y]) => [-x, y])];
  return ring;
}
const WHITE = { c: col(0xdcdfe1), rough: 0.25, metal: 0.15 };
const WHITE_ROOF = { c: col(0xc6cacd), rough: 0.35, metal: 0.2 };
const SKIRT = { c: col(0x7a7f85), rough: 0.5, metal: 0.3 };
const STRIPE = { c: [1, 1, 1], paint: PM.STRIPE, rough: 0.3, metal: 0.25 };
const TWIN = { c: col(0x0d1116), rough: 0.05, metal: 0.4, em: EM.TRAIN_WIN };
const TEND = { c: col(0xdfe6ea), rough: 0.1, metal: 0.2, em: EM.TRAIN_END };
const BOGIE = { c: col(0x2a2c2e), rough: 0.7, metal: 0.4 };

// 复兴号环边 → 材质（环点 0..19，边 k 连接 k 与 k+1）
const TCAB = { c: col(0x0b0e12), rough: 0.05, metal: 0.45 }; // 司机室挡风玻璃（夜间不亮）
function hsrEdgeMat(k, win, cab) {
  // 左侧 k=0..8，顶 9，右侧 10..18，底 19
  const side = k <= 8 ? k : k >= 10 && k <= 18 ? 18 - k : -1;
  if (k === 19) return BOGIE;
  if (k === 9) return cab ? TCAB : WHITE_ROOF;
  switch (side) {
    case 0: return SKIRT;
    case 1: return WHITE;
    case 2: return STRIPE;
    case 3: return WHITE;
    case 4: return win ? TWIN : WHITE;
    case 5: return WHITE;
    case 6: return WHITE_ROOF;
    case 7: return cab ? TCAB : WHITE_ROOF;
    case 8: return cab ? TCAB : WHITE_ROOF;
  }
  return WHITE;
}

function bogies(B, halfLen, inset = 2.6) {
  for (const z of [halfLen - inset, -halfLen + inset]) {
    B.box(0, 0.45, z, 2.3, 0.5, 3.0, BOGIE, 'top');
    for (const sd of [1, -1]) for (const dz of [-1.25, 1.25]) B.wheel(sd * 0.75, z + dz, 0.43, 0.14, sd, 10, 0.7);
  }
}

function buildHsrMid(B) {
  B.kind = TK.HSR_MID;
  const ring = hsrRing();
  const zs = [12.5, 12.2];
  // 车窗：约 1.2 m 窗 + 0.55 m 窗间
  for (let z = 10.6; z > -10.6; z -= 1.75) zs.push(z, z - 1.2);
  zs.push(-12.2, -12.5);
  const secs = zs.map((z, i) => ({ z, ring: ring.map(([x, y]) => (i === 0 || i === zs.length - 1 ? [x * 0.9, 0.6 + (y - 0.6) * 0.93] : [x, y])) }));
  B.loft(secs, (i, k) => hsrEdgeMat(k, i >= 2 && i < zs.length - 3 && (i % 2 === 0), false), { capFront: WHITE_ROOF, capBack: WHITE_ROOF, center: () => 2.2 });
  bogies(B, 12.5);
  // 受电弓底座（部分车有）
  B.box(0, 4.12, -5, 1.6, 0.14, 2.2, BOGIE, 'bottom');
}

function buildHsrHead(B) {
  B.kind = TK.HSR_HEAD;
  const ring = hsrRing();
  const zs = [-13.6, -13.3];
  for (let z = -11.4; z < 0.8; z += 1.75) zs.push(z, z + 1.2);
  // 车头：z 1.5 → 13.6（11.2 m 流线型）
  const noseStart = 2.4, tip = 13.6;
  const nose = [];
  for (let i = 0; i <= 12; i++) nose.push(i / 12);
  const secs = zs.map((z, i) => ({ z, ring: ring.map(([x, y]) => (i === 0 ? [x * 0.9, 0.6 + (y - 0.6) * 0.93] : [x, y])), t: -1 }));
  for (const t of nose) {
    const z = lerp(noseStart, tip, t);
    const wf = Math.pow(Math.max(0, 1 - Math.pow(t, 2.3)), 0.55) * 0.97 + 0.03;
    const yb = 0.5 + 0.28 * t;
    const yt = 4.05 - 2.55 * Math.pow(t, 1.25);
    secs.push({ z, t, ring: ring.map(([x, y]) => [x * wf, yb + ((y - 0.5) / 3.55) * (yt - yb)]) });
  }
  B.loft(secs, (i, k) => {
    const s = secs[i], s2 = secs[i + 1];
    const cab = s.t >= 0.22 && s2.t <= 0.52 && s.t >= 0;
    const win = s.t < 0 && i >= 2 && i % 2 === 0 && s2.z < 0.9;
    return hsrEdgeMat(k, win, cab);
  }, { capFront: WHITE_ROOF, capBack: WHITE, center: () => 2.0 });
  // 车头灯（前白后红由实例标志决定）
  for (const sd of [1, -1]) {
    const t = 0.78, z = lerp(noseStart, tip, t);
    const wf = Math.pow(1 - Math.pow(t, 2.3), 0.55) * 0.97 + 0.03;
    B.box(sd * 1.1 * wf + sd * 0.2, 1.2, z, 0.2, 0.16, 0.9, TEND);
  }
  bogies(B, 13.0);
}

function boxCarRing(hw, yb, yw0, yw1, yroof, stripe = null) {
  // 普通客车/机车：直壁 + 圆顶
  const half = [[hw - 0.08, yb], [hw, yb + 0.4]];
  if (stripe) half.push([hw, stripe[0]], [hw, stripe[1]]);
  half.push([hw, yw0], [hw, yw1], [hw - 0.1, yroof - 0.45], [hw * 0.6, yroof - 0.1], [hw * 0.2, yroof]);
  return [...half, ...half.slice().reverse().map(([x, y]) => [-x, y])];
}

function buildMetro(B, head) {
  B.kind = head ? TK.METRO_HEAD : TK.METRO_MID;
  const hw = 1.4;
  const ring = boxCarRing(hw, 0.45, 1.3, 2.25, 3.75, [1.02, 1.22]);
  const nR = ring.length, halfN = nR / 2;
  const SILVER = { c: col(0xb4b9be), rough: 0.35, metal: 0.75 };
  const SILVER_R = { c: col(0x9ea3a8), rough: 0.45, metal: 0.6 };
  // 车门位置（每侧 4 扇，1.4 m）
  const doors = [-7.3, -2.45, 2.45, 7.3];
  const half = 9.5;
  const zs = [half + (head ? 0 : 0.15)];
  const marks = [];
  for (const d of doors) marks.push(d - 0.7, d + 0.7);
  const cuts = [...marks, -half + 0.3, half - 0.3].sort((a, b) => b - a);
  zs.push(...cuts);
  zs.push(-half - 0.15);
  const secs = zs.map((z, i) => ({ z, ring: i === 0 && !head || i === zs.length - 1 ? ring.map(([x, y]) => [x * 0.9, 0.6 + (y - 0.6) * 0.93]) : ring }));
  B.loft(secs, (i, k) => {
    const za = secs[i].z, zb = secs[i + 1].z, zm = (za + zb) / 2;
    const isDoor = doors.some((d) => Math.abs(zm - d) < 0.7);
    const end = i === 0 || i === secs.length - 2;
    const side = k < halfN ? k : nR - 1 - k;
    if (k === nR - 1) return BOGIE;
    if (side === 0) return SKIRT;
    if (side === 2) return end ? SILVER : STRIPE; // 腰带
    if (side === 4) return end ? SILVER : TWIN; // 窗带
    if (side === 3 || side === 1) return isDoor && !end ? { ...TWIN, em: EM.TRAIN_WIN } : SILVER;
    return SILVER_R;
  }, { capFront: SILVER, capBack: SILVER, center: () => 2.0 });
  if (head) {
    // 车头：前端略收的司机室 + 大挡风 + 线路色饰带 + 头灯
    const zf = half, zt = half + 0.75;
    const sec2 = [
      { z: zf, ring },
      { z: zt, ring: ring.map(([x, y]) => [x * 0.93, 0.5 + (y - 0.45) * 0.95]) },
    ];
    B.loft(sec2, (i, k) => {
      const side = k < halfN ? k : nR - 1 - k;
      if (k === nR - 1) return BOGIE;
      if (side >= 4) return TWIN;
      if (side === 2) return STRIPE;
      return SILVER;
    }, { capBack: SILVER, center: () => 2.0 });
    B.panelZ(0, 2.35, zt + 0.01, 2.3, 1.35, TWIN, 1);
    B.panelZ(0, 1.2, zt + 0.01, 2.5, 0.28, STRIPE, 1);
    for (const sd of [1, -1]) B.box(sd * 0.95, 1.2, zt, 0.4, 0.14, 0.06, TEND);
  }
  bogies(B, 9.5, 2.3);
}

function buildLoco(B) {
  B.kind = TK.LOCO;
  const hw = 1.55;
  const ring = boxCarRing(hw, 0.9, 2.35, 3.0, 4.25, [1.9, 2.15]);
  const nR = ring.length, halfN = nR / 2;
  const zs = [10.4, 10.1, 8.9, -8.9, -10.1, -10.4];
  const WHITEP = { c: col(0xe6e3dc), rough: 0.4, metal: 0.1 };
  B.loft(zs.map((z) => ({ z, ring })), (i, k) => {
    const side = k < halfN ? k : nR - 1 - k;
    const cab = i === 1 || i === 3;
    if (k === nR - 1) return BOGIE;
    if (side === 2) return WHITEP;
    if (side === 4 && cab) return TWIN;
    if (side >= 5) return M.greyDark;
    return M.paint;
  }, { capFront: M.paint, capBack: M.paint, center: () => 2.5 });
  for (const zf of [10.41, -10.41]) {
    const f = Math.sign(zf);
    B.panelZ(0, 3.25, zf, 2.4, 0.8, TWIN, f);
    B.panelZ(0, 2.05, zf, 3.0, 0.22, WHITEP, f);
    for (const sd of [1, -1]) B.box(sd * 1.05, 1.5, zf, 0.3, 0.2, 0.05, TEND);
  }
  B.box(0, 4.35, 0, 1.8, 0.25, 10, M.greyDark, 'bottom');
  bogies(B, 10.4, 3.4);
}

function buildCoach(B) {
  B.kind = TK.COACH;
  const hw = 1.55;
  const ring = boxCarRing(hw, 0.85, 2.0, 2.95, 4.3, [1.45, 1.6]);
  const nR = ring.length, halfN = nR / 2;
  const zs = [12.75, 12.45, 11.0];
  for (let z = 9.6; z > -9.6; z -= 1.95) zs.push(z, z - 1.2);
  zs.push(-11.0, -12.45, -12.75);
  const YEL = { c: col(0xe0b33a), rough: 0.4, metal: 0.1 };
  const ROOFG = { c: col(0x505458), rough: 0.6, metal: 0.2 };
  const secs = zs.map((z, i) => ({ z, ring: i === 0 || i === zs.length - 1 ? ring.map(([x, y]) => [x * 0.85, 0.9 + (y - 0.9) * 0.92]) : ring }));
  B.loft(secs, (i, k) => {
    const side = k < halfN ? k : nR - 1 - k;
    const win = i >= 3 && i < zs.length - 4 && i % 2 === 1;
    if (k === nR - 1) return BOGIE;
    if (side === 2) return YEL;
    if (side === 4) return win ? TWIN : M.paint;
    if (side >= 5) return ROOFG;
    return M.paint;
  }, { capFront: ROOFG, capBack: ROOFG, center: () => 2.5 });
  bogies(B, 12.75, 3.0);
}

function buildGondola(B) {
  B.kind = TK.GONDOLA;
  const hw = 1.58, L2 = 6.95, y0 = 1.05, y1 = 3.05;
  const RUST = { c: [1, 1, 1], paint: PM.BODY, rough: 0.85, metal: 0.25 };
  const COAL = { c: col(0x16171a), rough: 0.95, metal: 0 };
  B.box(0, (y0 + y1) / 2, 0, hw * 2, y1 - y0, L2 * 2, RUST, 'top');
  for (let z = -L2 + 0.8; z < L2; z += 1.4) for (const sd of [1, -1]) B.box(sd * (hw + 0.03), (y0 + y1) / 2, z, 0.07, y1 - y0, 0.12, RUST);
  B.quad([hw - 0.05, 2.75, L2 - 0.05], [-hw + 0.05, 2.75, L2 - 0.05], [-hw + 0.05, 2.75, -L2 + 0.05], [hw - 0.05, 2.75, -L2 + 0.05], COAL, { n: [0, 1, 0] });
  B.box(0, 0.85, 0, 1.2, 0.3, L2 * 2 + 0.4, BOGIE);
  bogies(B, L2, 1.9);
}

function buildTank(B) {
  B.kind = TK.TANK;
  const r = 1.45, cy = 2.35, L2 = 5.8;
  const TANKM = { c: [1, 1, 1], paint: PM.BODY, rough: 0.6, metal: 0.3 };
  const seg = 14;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a, z) => [Math.cos(a) * r, cy + Math.sin(a) * r, z];
    B.quad(p(a0, L2), p(a1, L2), p(a1, -L2), p(a0, -L2), TANKM, [0, cy, 0]);
    for (const z of [L2, -L2]) B.tri([0, cy, z + Math.sign(z) * 0.35], p(a0, z), p(a1, z), TANKM, [0, cy, 0]);
  }
  B.box(0, cy + r + 0.15, 0, 0.9, 0.3, 0.9, M.greyDark, 'bottom');
  B.box(0, 0.9, 0, 1.4, 0.35, L2 * 2 + 0.6, BOGIE);
  bogies(B, 6.1, 1.8);
}

/** 近景列车 uber 几何 */
export function trainNearGeometry() {
  const B = new GeoBuilder();
  buildHsrHead(B);
  buildHsrMid(B);
  buildLoco(B);
  buildCoach(B);
  buildGondola(B);
  buildTank(B);
  buildMetro(B, true);
  buildMetro(B, false);
  return B.toGeometry(35);
}

/**
 * 远景列车代理：单位盒（x∈[-.5,.5], y∈[0,1], z∈[-.5,.5]）带窗带 + 车头楔形段，由着色器按车型缩放/收头
 * aFar = (层 0 底 1 窗下 2 窗上 3 顶, 段 0 车身 1 车头, 材质 0 车体 1 窗 2 顶 3 头灯, 左右 ±1)
 */
export function trainFarGeometry() {
  const P = [], F = [];
  const v = (x, y, z, lv, seg, mat) => { P.push(x, y, z); F.push(lv, seg, mat, 0); };
  const quad = (a, b, c, d) => { for (const q of [a, b, c, a, c, d]) v(...q); };
  const Y = [0, 0.48, 0.66, 1];
  // 车身段 z ∈ [-0.5, 0.25]，车头段 z ∈ [0.25, 0.5]（非头车时由着色器拉平）
  const zb = [-0.5, 0.25, 0.5];
  for (let s = 0; s < 2; s++) {
    const z0 = zb[s], z1 = zb[s + 1];
    for (let l = 0; l < 3; l++) {
      const mat = l === 1 ? 1 : 0;
      for (const sd of [0.5, -0.5]) quad([sd, Y[l], z0, l, 0, mat], [sd, Y[l], z1, l, s, mat], [sd, Y[l + 1], z1, l + 1, s, mat], [sd, Y[l + 1], z0, l + 1, 0, mat]);
    }
    quad([0.5, 1, z0, 3, 0, 2], [-0.5, 1, z0, 3, 0, 2], [-0.5, 1, z1, 3, s, 2], [0.5, 1, z1, 3, s, 2]);
  }
  quad([0.5, 0, 0.5, 0, 1, 0], [-0.5, 0, 0.5, 0, 1, 0], [-0.5, 1, 0.5, 3, 1, 0], [0.5, 1, 0.5, 3, 1, 0]);
  quad([0.5, 0, -0.5, 0, 0, 0], [-0.5, 0, -0.5, 0, 0, 0], [-0.5, 1, -0.5, 3, 0, 0], [0.5, 1, -0.5, 3, 0, 0]);
  // 头灯片
  quad([0.3, 0.25, 0.505, 0, 1, 3], [0.1, 0.25, 0.505, 0, 1, 3], [0.1, 0.35, 0.505, 0, 1, 3], [0.3, 0.35, 0.505, 0, 1, 3]);
  quad([-0.1, 0.25, 0.505, 0, 1, 3], [-0.3, 0.25, 0.505, 0, 1, 3], [-0.3, 0.35, 0.505, 0, 1, 3], [-0.1, 0.35, 0.505, 0, 1, 3]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('aFar', new THREE.BufferAttribute(new Float32Array(F), 4));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(P.length), 3));
  return g;
}

// ======================================================================
// 配色
// ======================================================================
// 中国乘用车颜色分布（白色约一半，其次黑、灰银、蓝、红等）
const CAR_COLORS = [
  [0xeeeeea, 30], [0xf4f3ef, 12], [0x16181b, 14], [0x2b2e33, 4], [0x9ea3a8, 8], [0x6f757c, 6], [0xc4c7ca, 5],
  [0x1f3f73, 4], [0x3a5f8a, 2], [0x8c1c1c, 3], [0xb3262b, 2], [0x6e5a45, 2], [0xc8b28f, 2], [0x2f4a3a, 1], [0xd96f2b, 1], [0x5e6f5c, 1],
];
const CAR_SUM = CAR_COLORS.reduce((s, c) => s + c[1], 0);
export function pickCarColor(r) {
  let x = r * CAR_SUM;
  for (const [c, w] of CAR_COLORS) { x -= w; if (x <= 0) return c; }
  return CAR_COLORS[0][0];
}
// 西安出租车：比亚迪纯电动“荷叶绿”车身 + 黑色车顶；吉利帝豪甲醇车“琉璃黄”（橙黄）
export const TAXI_GREEN = 0x8ccb8c;
export const TAXI_YELLOW = 0xeea21f;
// 西安公交：黄绿色为主（比亚迪/宇通纯电动）
export const BUS_COLORS = [0x8dc63f, 0x7fbf3a, 0x9ccc3c, 0x6fb43f, 0x2f86c8];
export const DUMP_GREEN = 0x3faa4f; // 渣土车“活力绿”
export const TRUCK_CAB_COLORS = [0x1e5bb5, 0x2a67c4, 0xeeeeea, 0xc0302b, 0x2f8f5a, 0xe6b12e];
// 第二色调色板（索引 0..7）：货箱/集装箱颜色；小汽车 twoTone 时车顶用黑色
export const SECOND_COLORS = [0xe8e8e4, 0xc9cdd1, 0x2e5fa8, 0xb33a2c, 0x2f7a4d, 0xd98c2b, 0x5a6168, 0x1a1c1e];
// 地铁线路色
export const METRO_LINE_COLORS = {
  1: 0x0071bc, 2: 0xe60012, 3: 0xc2187a, 4: 0x19a3a0, 5: 0x9ac733, 6: 0x2e4ea3, 8: 0xe8a23a, 9: 0xf08300,
  10: 0x8e5ea2, 14: 0x3fb4e5, 15: 0x7fb536, 16: 0x2eaa74,
};
