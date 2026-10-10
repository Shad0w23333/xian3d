// 车辆 / 列车程序化几何（全部顶点色 + 逐顶点材质参数，一个 draw call 画一类）
// 局部坐标：+x = 车辆左侧，+y = 上，+z = 车头方向；原点 = 车身中心在路面（轨顶）处的投影。
// 逐顶点属性：
//   color    基色（线性 RGB）
//   aMat     (paintMode, roughness, metalness, emissiveKind)
//             paintMode 0=顶点色 1=车漆(实例色) 2=第二色(车顶黑/货箱色) 3=号牌(蓝/绿) 4=条纹(实例色,列车) 5=车窗玻璃(深色贴膜 + 透见头枕)
//             emissiveKind 见 EM
//   aKU      (所属车型 -1 = 通用部件 / uber 几何按实例车型折叠其它车型的顶点, 号牌纹理 u, v)
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
// BUS_A = 18 m 铰接公交（前节，后节只在绘制时作为 BUS_R 另放一个实例，随路径折转）
export const VK = { CAR: 0, TAXI: 1, BUS: 2, DUMP: 3, BOXTRUCK: 4, SEMI: 5, BUS_A: 6, BUS_R: 7 };
// 车长（米，用于间距/跟驰）
export const VK_LEN = [4.7, 4.7, 12.0, 8.6, 7.6, 16.5, 18.0, 6.0];
// 列车车辆编码
export const TK = { HSR_HEAD: 0, HSR_MID: 1, LOCO: 2, COACH: 3, GONDOLA: 4, TANK: 5, METRO_HEAD: 6, METRO_MID: 7 };
export const TK_LEN = [27.2, 25.0, 20.8, 25.5, 13.9, 12.2, 19.5, 19.0];

export const col = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const lerp = (a, b, t) => a + (b - a) * t;

// —— 常用材质规格 ——
export const M = {
  paint: { c: [1, 1, 1], paint: PM.BODY, rough: 0.28, metal: 0.45 },
  paintLow: { c: [0.82, 0.82, 0.82], paint: PM.BODY, rough: 0.32, metal: 0.4 },
  roof: { c: [1, 1, 1], paint: PM.SECOND, rough: 0.3, metal: 0.4 },
  second: { c: [1, 1, 1], paint: PM.SECOND, rough: 0.45, metal: 0.2 },
  // 车窗：金属度 0、极低粗糙度 → 环境贴图按菲涅耳反射天空/街景（正视发暗、斜视发亮），漫反射为透见的车内（着色器）
  glass: { c: col(0x0b0e12), paint: PM.GLASS, rough: 0.04, metal: 0.0 },
  lamp: { c: col(0x2a2c30), rough: 0.25, metal: 0.6 }, // 灯腔（深色反光碗）
  // 公交车窗：深色玻璃（金属度低，夜里不再把环境反射成一整块白板），夜间车内灯光与窗框分格在着色器里画
  glassBus: { c: col(0x0a0c0f), rough: 0.07, metal: 0.05, em: EM.INTERIOR },
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
  // 出租车顶灯字面（号牌图集里的“出租 TAXI”格，u ∈ [2, 3]），夜里随顶灯一起亮
  taxiText: { c: [1, 1, 1], paint: PM.PLATE, rough: 0.35, metal: 0.0, em: EM.TAXI },
  greyLight: { c: col(0xc9ccd0), rough: 0.5, metal: 0.2 },
  greyDark: { c: col(0x3a3d41), rough: 0.6, metal: 0.2 },
};
export const withKind = (m, kind) => ({ ...m, kind });

// ======================================================================
// 几何构建器
// ======================================================================
export class GeoBuilder {
  constructor(replay = null) {
    this.P = []; this.C = []; this.M = []; this.K = []; this.U = [];
    this.flips = replay || [];
    this.replay = !!replay;
    this.fi = 0;
    this.kind = -1;
  }
  /** 三角形；ref = 内部参考点（数组）或 {n:[外法线]}，自动定向为外法线朝外 */
  tri(a, b, c, m, ref, uv = null) {
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
    const us = uv ? (flip ? [uv[0], uv[2], uv[1]] : uv) : null;
    const k = m.kind !== undefined ? m.kind : this.kind;
    for (let q = 0; q < 3; q++) {
      const v = vs[q];
      this.P.push(v[0], v[1], v[2]);
      if (us) this.U.push(us[q][0], us[q][1]); else this.U.push(-1, -1);
      this.C.push(m.c[0], m.c[1], m.c[2]);
      this.M.push(m.paint || 0, m.rough ?? 0.5, m.metal ?? 0, m.em || 0);
      this.K.push(k);
    }
  }
  quad(a, b, c, d, m, ref, uv = null) { this.tri(a, b, c, m, ref, uv && [uv[0], uv[1], uv[2]]); this.tri(a, c, d, m, ref, uv && [uv[0], uv[2], uv[3]]); }
  /** 号牌贴面（法线 ±z，带 0..1 纹理坐标，从观看者看去左→右为 u 增大） */
  plateZ(cx, cy, z, w, h, m, facing) {
    const n = { n: [0, 0, facing] };
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    // 正面（+z）观看者的右手 = +x；背面（-z）观看者的右手 = -x
    const uL = facing > 0 ? 0 : 1, uR = 1 - uL;
    this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], m, n, [[uL, 0], [uR, 0], [uR, 1], [uL, 1]]);
  }
  /** 两点间圆管（seg 段，caps 封口） */
  tube(a, b, r, m, seg = 6, caps = false, r2 = r) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1e-6;
    const ax = [dx / L, dy / L, dz / L];
    const t = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [ax[1] * t[2] - ax[2] * t[1], ax[2] * t[0] - ax[0] * t[2], ax[0] * t[1] - ax[1] * t[0]];
    const ul = Math.hypot(...u); u = u.map((v) => v / ul);
    const v = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const ring = (c, rr, k) => { const an = (k / seg) * Math.PI * 2, ca = Math.cos(an) * rr, sa = Math.sin(an) * rr; return [c[0] + u[0] * ca + v[0] * sa, c[1] + u[1] * ca + v[1] * sa, c[2] + u[2] * ca + v[2] * sa]; };
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    for (let k = 0; k < seg; k++) {
      this.quad(ring(a, r, k), ring(a, r, k + 1), ring(b, r2, k + 1), ring(b, r2, k), m, mid);
      if (caps) {
        this.tri(a, ring(a, r, k), ring(a, r, k + 1), m, { n: [-ax[0], -ax[1], -ax[2]] });
        this.tri(b, ring(b, r2, k), ring(b, r2, k + 1), m, { n: ax });
      }
    }
  }
  /** 绕 x 轴倾斜 tilt 的盒子（中心 c、尺寸 s） */
  obox(cx, cy, cz, sx, sy, sz, tilt, m, skip = '') {
    const c = Math.cos(tilt), s = Math.sin(tilt);
    const P = (x, y, z) => [cx + x, cy + y * c - z * s, cz + y * s + z * c];
    const x0 = -sx / 2, x1 = sx / 2, y0 = -sy / 2, y1 = sy / 2, z0 = -sz / 2, z1 = sz / 2;
    const ref = [cx, cy, cz];
    if (!skip.includes('top')) this.quad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), m, ref);
    if (!skip.includes('bottom')) this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), m, ref);
    if (!skip.includes('front')) this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), m, ref);
    if (!skip.includes('back')) this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), m, ref);
    if (!skip.includes('left')) this.quad(P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1), m, ref);
    if (!skip.includes('right')) this.quad(P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1), m, ref);
  }
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
    // aKU = (车型/选项, 号牌纹理 u, v)：合成一个属性（小汽车三目标形变已占 16 个顶点属性槽的大半）
    const n = this.K.length, ku = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { ku[i * 3] = this.K[i]; ku[i * 3 + 1] = this.U[i * 2]; ku[i * 3 + 2] = this.U[i * 2 + 1]; }
    g.setAttribute('aKU', new THREE.BufferAttribute(ku, 3));
    if (extra) for (const [k, v] of Object.entries(extra)) g.setAttribute(k, v);
    return g;
  }
}

/** 折痕角平滑法线：同位置、法线夹角小于 crease 的面参与平均 */
export function smoothNormals(pos, creaseDeg) {
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
// 大型车：公交 / 渣土车 / 厢式货车 / 半挂（uber 几何，按 aKU.x 车型折叠）
// ======================================================================
/**
 * 公交车身（低地板纯电动）。part：'single' 12 m 单机（z +6 ~ −6）；'front' 铰接前节（z +9 ~ −2.6，车辆中心在铰接车全长中点）；
 * 'rear' 铰接后节（以铰接点为原点，z 0 ~ −6，含 0 ~ −0.8 的折棚）。
 * 涂装：车身（实例色，白）+ 下部色带与前脸下裙（第二色，实例打包色：绿/蓝），窗带黑色。
 */
function buildBus(B, part = 'single') {
  B.kind = part === 'single' ? VK.BUS : part === 'front' ? VK.BUS_A : VK.BUS_R;
  const hw = 1.275;
  const ring = [
    [hw - 0.03, 0.32], [hw, 0.62], [hw, 1.05], [hw, 2.72], [hw - 0.08, 3.02], [hw - 0.4, 3.13],
    [-hw + 0.4, 3.13], [-hw + 0.08, 3.02], [-hw, 2.72], [-hw, 1.05], [-hw, 0.62], [-hw + 0.03, 0.32],
  ];
  const accent = { c: [1, 1, 1], paint: PM.SECOND, rough: 0.32, metal: 0.35 };
  let zs, doors, wheels, front = true, rear = true, zF, zR;
  if (part === 'single') {
    zs = [6.0, 5.88, 5.3, 4.1, 3.2, 3.05, 1.9, 1.75, 0.65, -0.55, -1.6, -1.75, -2.9, -3.05, -4.2, -4.35, -5.85, -6.0];
    doors = [[4.1, 5.3], [-0.55, 0.65]]; wheels = [[3.4, 0], [-2.5, 1]]; zF = 6.0; zR = -6.0;
  } else if (part === 'front') {
    zs = [9.0, 8.88, 8.3, 7.1, 6.2, 6.05, 4.9, 4.75, 3.65, 2.45, 1.4, 1.25, 0.1, -0.05, -1.2, -1.35, -3.0];
    doors = [[7.1, 8.3], [2.45, 3.65]]; wheels = [[6.4, 0], [-0.9, 1]]; rear = false; zF = 9.0; zR = -3.0;
  } else {
    zs = [-0.8, -0.95, -1.4, -2.6, -3.6, -3.75, -4.9, -5.05, -5.85, -6.0];
    doors = [[-1.4, -2.6]]; wheels = [[-4.3, 1]]; front = false; zF = -0.8; zR = -6.0;
  }
  const isDoor = (za, zb) => doors.some(([d0, d1]) => za <= d1 + 1e-3 && zb >= d0 - 1e-3);
  const secs = zs.map((z, i) => {
    const endF = front && i === 0, endR = rear && i === zs.length - 1;
    const sc = endF || endR ? 0.97 : 1;
    return { z, ring: ring.map(([x, y]) => [x * sc, y * (endF ? 0.995 : 1)]) };
  });
  const paint = M.paint, low = { c: col(0x2b2d30), rough: 0.6, metal: 0.2 };
  B.loft(secs, (i, k) => {
    const za = zs[i], zb = zs[i + 1];
    const door = isDoor(Math.max(za, zb), Math.min(za, zb)) && Math.abs(za - zb) > 0.5;
    const pillar = Math.abs(za - zb) < 0.2 || (front && i === 0) || (rear && i === zs.length - 2);
    if (k === 11) return M.under;
    if (k === 0 || k === 10) return low;
    if (k === 1 || k === 9) return door && k === 9 ? M.glassBus : accent; // 右侧（-x）为车门侧
    if (k === 2 || k === 8) return pillar ? M.black : M.glassBus;
    return paint;
  }, { capFront: front ? paint : null, capBack: rear ? paint : null, center: () => 1.6 });
  if (front) {
    // 前脸：大挡风玻璃、LED 路牌、前灯、下裙色带
    B.panelZ(0, 1.85, zF + 0.02, 2.3, 1.55, M.glassBus, 1);
    B.panelZ(0, 2.82, zF + 0.02, 1.8, 0.24, M.led, 1);
    B.panelZ(0, 0.72, zF + 0.02, 2.4, 0.5, accent, 1);
    B.plateZ(0, 0.55, zF + 0.04, 0.44, 0.14, M.plate, 1);
    for (const sd of [1, -1]) {
      B.box(sd * 0.92, 0.72, zF, 0.42, 0.2, 0.08, M.head);
      B.box(sd * 0.93, 0.58, zF, 0.36, 0.04, 0.08, M.drl);
      B.box(sd * 1.18, 0.74, zF - 0.05, 0.1, 0.12, 0.12, sd > 0 ? M.turnL : M.turnR);
      B.box(sd * 1.42, 2.3, zF + 0.15, 0.1, 0.35, 0.18, M.black); // 羊角后视镜
    }
  }
  if (rear) {
    B.panelZ(0, 2.2, zR - 0.02, 1.9, 0.75, M.glassBus, -1);
    B.panelZ(0, 2.82, zR - 0.02, 0.9, 0.24, M.led, -1);
    B.plateZ(0, 0.6, zR - 0.04, 0.44, 0.14, M.plate, -1);
    for (const sd of [1, -1]) {
      B.box(sd * 1.1, 0.95, zR, 0.16, 0.6, 0.06, M.tail);
      B.box(sd * 1.1, 1.35, zR, 0.14, 0.14, 0.06, sd > 0 ? M.turnL : M.turnR);
    }
  }
  for (const sd of [1, -1]) for (const [wz, dual] of wheels) B.wheel(sd * (dual ? 0.98 : 1.02), wz, 0.5, dual ? 0.55 : 0.3, sd, 12, 0.55);
  if (part === 'rear') {
    // 折棚：黑色波纹段（铰接处）
    const bell = { c: col(0x1a1b1c), rough: 0.9, metal: 0 };
    for (let k = 0; k < 4; k++) B.box(0, 1.75, -0.1 - k * 0.2, 2.42 - (k % 2) * 0.08, 2.75, 0.18, bell, 'bottom');
  }
  // 车顶电池舱 / 空调
  if (part !== 'rear') {
    B.box(0, 3.24, zF - 7.2, 2.0, 0.24, 5.6, M.greyLight, 'bottom');
    B.box(0, 3.22, zF - 2.6, 1.7, 0.2, 1.8, M.paint, 'bottom');
  } else B.box(0, 3.24, -3.4, 2.0, 0.22, 3.6, M.greyLight, 'bottom');
  B.quad([1.35, 0.03, zF + 0.2], [-1.35, 0.03, zF + 0.2], [-1.35, 0.03, zR - 0.2], [1.35, 0.03, zR - 0.2], M.under, { n: [0, 1, 0] });
}

/** 圆角矩形环（半宽 hw、y0~y1、顶角半径 r，左右对称；自左下逆时针） */
function cabRing(hw, y0, y1, r) {
  const pts = [[hw, y0], [hw, y1 - r]];
  for (let k = 1; k < 4; k++) { const a = (k / 4) * (Math.PI / 2); pts.push([hw - r + Math.cos(a) * r, y1 - r + Math.sin(a) * r]); }
  pts.push([hw - r, y1]);
  const L = pts.slice();
  return [...L, ...L.slice().reverse().map(([x, y]) => [-x, y])];
}
function truckCab(B, z0, z1, hw, y0, y1, cabMat) {
  // 平头驾驶室：圆角放样体，前上沿倒角（前脸上部后倾），侧面车门分缝、门把手、侧窗与小三角窗
  const H = y1 - y0;
  const secs = [
    { z: z0, ring: cabRing(hw, y0, y1, 0.16) },
    { z: z1 - 0.32, ring: cabRing(hw, y0, y1, 0.16) },
    { z: z1 - 0.06, ring: cabRing(hw - 0.03, y0, y1 - 0.12, 0.13) },
    { z: z1, ring: cabRing(hw - 0.06, y0, y1 - 0.3, 0.1) },
  ];
  const nR = secs[0].ring.length;
  const ref = [0, (y0 + y1) / 2, (z0 + z1) / 2];
  for (let i = 0; i + 1 < secs.length; i++) {
    const A = secs[i], Bs = secs[i + 1];
    for (let k = 0; k < nR; k++) {
      const k2 = (k + 1) % nR;
      if (k === nR - 1) continue; // 底面
      B.quad([A.ring[k][0], A.ring[k][1], A.z], [A.ring[k2][0], A.ring[k2][1], A.z], [Bs.ring[k2][0], Bs.ring[k2][1], Bs.z], [Bs.ring[k][0], Bs.ring[k][1], Bs.z], cabMat, ref);
    }
  }
  for (const S of [secs[0], secs[secs.length - 1]]) {
    const c = [0, (y0 + y1) / 2 - 0.1, S.z], dir = S === secs[0] ? -1 : 1;
    for (let k = 0; k < nR; k++) { const k2 = (k + 1) % nR; B.tri(c, [S.ring[k][0], S.ring[k][1], S.z], [S.ring[k2][0], S.ring[k2][1], S.z], cabMat, { n: [0, 0, dir] }); }
  }
  // 前挡风（在后倾的前脸上部）+ 黑色胶条
  const yw0 = lerp(y0, y1, 0.52), yw1 = y1 - 0.34;
  B.panelZ(0, (yw0 + yw1) / 2, z1 + 0.012, hw * 1.84, yw1 - yw0 + 0.06, M.black, 1);
  B.panelZ(0, (yw0 + yw1) / 2, z1 + 0.016, hw * 1.76, yw1 - yw0, M.glass, 1);
  const zc = (z0 + z1) / 2;
  for (const sd of [1, -1]) {
    const xs = sd * (hw + 0.008);
    // 侧窗（门窗 + 前角小三角窗）与门缝、门把手、门下脚踏
    B.panelX(xs, lerp(y0, y1, 0.7), zc + 0.12, (z1 - z0) * 0.5, H * 0.3, M.glass, sd);
    B.panelX(xs, lerp(y0, y1, 0.7), z1 - 0.2, 0.18, H * 0.26, M.glass, sd);
    B.panelX(sd * (hw + 0.004), (y0 + y1) / 2 - 0.05, z0 + 0.12, 0.025, H * 0.86, M.black, sd);
    B.panelX(sd * (hw + 0.004), (y0 + y1) / 2 - 0.05, z1 - 0.06, 0.025, H * 0.8, M.black, sd);
    B.box(sd * (hw + 0.02), lerp(y0, y1, 0.48), z0 + 0.26, 0.03, 0.04, 0.16, M.chrome);
    B.box(sd * (hw - 0.1), y0 - 0.12, (z0 + z1) / 2 - 0.1, 0.32, 0.05, 0.5, M.greyDark);
    // 后视镜（支架 + 镜壳）
    B.box(sd * (hw + 0.08), lerp(y0, y1, 0.78), z1 - 0.08, 0.16, 0.03, 0.03, M.black);
    B.box(sd * (hw + 0.17), lerp(y0, y1, 0.62), z1 - 0.1, 0.08, 0.42, 0.12, M.black);
  }
  // 格栅（挡风下方：黑底 + 三道镀铬横条）、前保险杠、大灯组嵌在保险杠两端
  const yg = lerp(y0, y1, 0.3);
  B.panelZ(0, yg, z1 + 0.008, hw * 1.2, H * 0.26, M.black, 1);
  for (const k of [-1, 0, 1]) B.box(0, yg + k * H * 0.07, z1 + 0.02, hw * 1.16, 0.025, 0.02, M.chrome);
  B.box(0, y0 - 0.2, z1 + 0.06, hw * 2, 0.35, 0.18, M.greyDark);
  for (const sd of [1, -1]) {
    B.box(sd * (hw - 0.33), y0 - 0.17, z1 + 0.15, 0.4, 0.16, 0.02, M.lamp);
    B.box(sd * (hw - 0.37), y0 - 0.17, z1 + 0.16, 0.26, 0.11, 0.02, M.head);
    B.box(sd * (hw - 0.1), y0 - 0.17, z1 + 0.16, 0.1, 0.1, 0.02, sd > 0 ? M.turnL : M.turnR);
  }
  B.plateZ(0, y0 - 0.02, z1 + 0.16, 0.44, 0.14, M.plate, 1);
}
/** 前轮挡泥板（驾驶室下、轮胎上方的黑色半圆弧罩） */
function fender(B, sd, xc, zc, r, w) {
  const n = 6, R = r + 0.08;
  for (let k = 0; k < n; k++) {
    const a0 = (Math.PI * k) / n, a1 = (Math.PI * (k + 1)) / n;
    const p = (a, x) => [x, r + Math.sin(a) * R, zc + Math.cos(a) * R];
    B.quad(p(a0, xc - w / 2), p(a1, xc - w / 2), p(a1, xc + w / 2), p(a0, xc + w / 2), M.black, [xc, r, zc]);
  }
}
/** 货箱细节：侧面竖筋、侧防护栏、后门（中缝、铰链、锁杆） */
function cargoDetail(B, hw, y0, y1, zA, zB, ribMat) {
  for (let z = zB + 0.5; z < zA - 0.3; z += 0.62)
    for (const sd of [1, -1]) B.box(sd * (hw + 0.012), (y0 + y1) / 2, z, 0.024, y1 - y0 - 0.1, 0.05, ribMat);
  for (const sd of [1, -1]) {
    B.box(sd * (hw + 0.012), y1 - 0.04, (zA + zB) / 2, 0.03, 0.06, zA - zB, M.greyDark);
  }
  const zr = zB - 0.01;
  B.panelZ(0, (y0 + y1) / 2, zr - 0.002, 0.03, y1 - y0 - 0.12, M.black, -1);
  for (const sd of [1, -1]) {
    for (const yy of [y0 + 0.35, y1 - 0.35]) B.box(sd * (hw - 0.06), yy, zr - 0.02, 0.06, 0.1, 0.04, M.greyDark);
    for (const xx of [0.32, 0.72]) B.box(sd * xx, (y0 + y1) / 2, zr - 0.025, 0.035, y1 - y0 - 0.2, 0.03, M.chrome);
  }
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
    fender(B, sd, sd * 1.0, 3.45, 0.52, 0.38);
    B.wheel(sd * 0.95, -1.5, 0.52, 0.6, sd, 12, 0.5);
    B.wheel(sd * 0.95, -2.85, 0.52, 0.6, sd, 12, 0.5);
  }
  B.box(0, 0.5, -4.3, 2.3, 0.14, 0.1, M.greyDark);
  B.plateZ(0, 0.72, -4.36, 0.44, 0.14, M.plate, -1);
  B.quad([1.3, 0.03, 4.5], [-1.3, 0.03, 4.5], [-1.3, 0.03, -4.4], [1.3, 0.03, -4.4], M.under, { n: [0, 1, 0] });
}

function buildBoxTruck(B) {
  B.kind = VK.BOXTRUCK;
  const hw = 1.18;
  truckCab(B, 2.4, 3.8, hw, 0.95, 2.75, M.paint);
  B.box(0, 0.7, -0.3, 0.85, 0.36, 7.2, M.black);
  B.box(0, 2.2, -0.75, 2.4, 2.3, 6.1, M.second);
  B.box(0, 1.03, -0.75, 2.44, 0.1, 6.14, M.greyDark);
  cargoDetail(B, 1.2, 1.05, 3.35, 2.3, -3.8, M.second);
  for (const sd of [1, -1]) {
    B.box(sd * 0.95, 1.2, -3.82, 0.24, 0.14, 0.05, M.tail);
    B.box(sd * 0.95, 1.38, -3.82, 0.24, 0.08, 0.05, sd > 0 ? M.turnL : M.turnR);
    B.wheel(sd * 0.98, 2.95, 0.45, 0.28, sd, 12, 0.5);
    B.wheel(sd * 0.93, -2.1, 0.45, 0.52, sd, 12, 0.5);
    fender(B, sd, sd * 0.98, 2.95, 0.45, 0.34);
    fender(B, sd, sd * 0.93, -2.1, 0.45, 0.56);
    // 侧防护栏（两轮之间的两道横杆 + 立柱）
    for (const yy of [0.62, 0.86]) B.box(sd * 1.14, yy, 0.4, 0.04, 0.06, 2.9, M.greyLight);
    for (const zz of [-0.9, 0.4, 1.75]) B.box(sd * 1.12, 0.78, zz, 0.06, 0.4, 0.05, M.greyDark);
  }
  B.plateZ(0, 0.8, -3.84, 0.44, 0.14, M.plate, -1);
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
    fender(B, sd, sd * 1.0, 7.35, 0.52, 0.38);
    B.wheel(sd * 0.95, 5.1, 0.52, 0.6, sd, 12, 0.5);
    B.wheel(sd * 0.95, 3.8, 0.52, 0.6, sd, 12, 0.5);
    for (const z of [-5.0, -6.3, -7.6]) B.wheel(sd * 0.95, z, 0.5, 0.55, sd, 10, 0.5);
  }
  B.plateZ(0, 0.9, -8.07, 0.44, 0.14, M.plate, -1);
  B.quad([1.3, 0.03, 8.4], [-1.3, 0.03, 8.4], [-1.3, 0.03, -8.3], [1.3, 0.03, -8.3], M.under, { n: [0, 1, 0] });
}

export function heavyNearGeometry() {
  const B = new GeoBuilder();
  buildBus(B, 'single');
  buildBus(B, 'front');
  buildBus(B, 'rear');
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
  [0xeeeeea, 22], [0xf4f3ef, 9], [0xe4e7ea, 7], [0x16181b, 15], [0x2b2e33, 5], [0x9ea3a8, 9], [0x6f757c, 7], [0xc4c7ca, 6],
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
// 西安公交（纯电动，比亚迪 K8/K9 等）：[车身, 色带, 权重]。具体涂装未查到权威资料，按推测：白车身绿色带为主，另有蓝色带、通体黄绿
export const BUS_LIVERIES = [[0xeeeee8, 0x2f9e4a, 5], [0xeeeee8, 0x1f6fb8, 2], [0x8dc63f, 0x4f9a2a, 3]];
export const DUMP_GREEN = 0x3faa4f; // 渣土车“活力绿”
export const TRUCK_CAB_COLORS = [0x1e5bb5, 0x2a67c4, 0xeeeeea, 0xc0302b, 0x2f8f5a, 0xe6b12e];
// 第二色调色板（索引 0..7）：货箱/集装箱颜色；小汽车 twoTone 时车顶用黑色
export const SECOND_COLORS = [0xe8e8e4, 0xc9cdd1, 0x2e5fa8, 0xb33a2c, 0x2f7a4d, 0xd98c2b, 0x5a6168, 0x1a1c1e];
// 地铁线路色
export const METRO_LINE_COLORS = {
  1: 0x0071bc, 2: 0xe60012, 3: 0xc2187a, 4: 0x19a3a0, 5: 0x9ac733, 6: 0x2e4ea3, 8: 0xe8a23a, 9: 0xf08300,
  10: 0x8e5ea2, 14: 0x3fb4e5, 15: 0x7fb536, 16: 0x2eaa74,
};
