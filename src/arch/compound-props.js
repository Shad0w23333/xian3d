// 小区设施构件库：几何写入器 + 门岗亭/道闸/门头/围栏/健身器材/儿童游乐/凉亭廊架/车棚/垃圾分类亭/快递柜/篮球架/旗杆/庭院灯/停放车辆。
// 全部顶点色（线性 RGB），局部坐标：x 右、y 上、z 前（yaw 绕 Y 轴：局部 +z → 世界 (sin yaw, cos yaw)）。
// 尺寸依据（常见规格 / 实景照片目测）：
//   门岗亭 2.4×2.0 m、高 2.7 m（成品岗亭）；道闸机箱 0.35×0.3×1.0 m、闸杆 3.5~4.5 m 红白相间；
//   铁艺围栏高 1.8~2.2 m，立柱间距 2.5~3 m，下设 0.3~0.5 m 砖/石基座；老小区砖围墙高 2.2~2.5 m；
//   室外健身路径器材：太空漫步机/扭腰器/单双杠，黄蓝绿撞色钢管；儿童滑梯组合平台高 1.2~1.5 m；
//   垃圾分类亭（西安：其他垃圾灰、可回收物蓝、有害垃圾红、厨余垃圾绿）；智能快递柜 高约 1.9 m、单元宽 0.6 m；
//   标准篮球架篮圈高 3.05 m、篮板 1.8×1.05 m；小型轿车 4.6×1.8×1.45 m。
import * as THREE from 'three';

// 面层种类（地面着色器按此画沥青/草坪/铺装/塑胶/球场/标线…，见 src/modules/compounds.js）
export const K = { ASPHALT: 0, CONCRETE: 1, LAWN: 2, PAVER: 3, PAVER_R: 4, RUBBER: 5, COURT: 6, PAINT: 7, CURB: 8, GRASSPAVE: 9, SOIL: 10, FLOWER: 11 };

const _c = new THREE.Color();
/** sRGB 十六进制 → 线性 RGB 数组（可乘系数） */
export function C(hex, k = 1) {
  _c.set(hex);
  return [_c.r * k, _c.g * k, _c.b * k];
}
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/** 可增长的 Float32 缓冲 */
class FBuf {
  constructor(n = 4096) {
    this.a = new Float32Array(n);
    this.n = 0;
  }
  need(k) {
    if (this.n + k <= this.a.length) return;
    let m = this.a.length * 2;
    while (m < this.n + k) m *= 2;
    const b = new Float32Array(m);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  push3(x, y, z) {
    this.need(3);
    const a = this.a, n = this.n;
    a[n] = x; a[n + 1] = y; a[n + 2] = z;
    this.n = n + 3;
  }
  push2(x, y) {
    this.need(2);
    this.a[this.n] = x; this.a[this.n + 1] = y;
    this.n += 2;
  }
  push1(x) {
    this.need(1);
    this.a[this.n++] = x;
  }
  out() {
    return this.a.slice(0, this.n);
  }
}

/**
 * 几何写入器：非索引三角形，position / normal / color（可选 uv、aK）。
 * 局部变换：setXf(x, y, z, yaw) 之后的 box/quad/… 都按局部坐标写，世界 y = 局部 y + 原点 y。
 */
export class GeoWriter {
  constructor({ uv = false, kind = false } = {}) {
    this.P = new FBuf(); this.N = new FBuf(); this.Cl = new FBuf();
    this.U = uv ? new FBuf() : null;
    this.K = kind ? new FBuf() : null;
    this.ox = 0; this.oy = 0; this.oz = 0; this.c = 1; this.s = 0;
    this.k = 0; // 当前 aK
    this.uvDef = [0, 0]; // 未给 uv 时写入的默认 uv（发光体用 uv.x 区分灯头/窗）
  }
  get count() { return this.P.n / 3; }
  setXf(x, y, z, yaw = 0) {
    this.ox = x; this.oy = y; this.oz = z;
    this.c = Math.cos(yaw); this.s = Math.sin(yaw);
    return this;
  }
  _w(p) {
    // 局部 → 世界
    return [this.ox + p[0] * this.c + p[2] * this.s, this.oy + p[1], this.oz - p[0] * this.s + p[2] * this.c];
  }
  /** 世界坐标三角形（法线自动） */
  triW(a, b, c, col, uva, uvb, uvc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    if (this.forceN) { nx = this.forceN[0]; ny = this.forceN[1]; nz = this.forceN[2]; }
    const ca = col.length === 3 ? col : col[0], cb = col.length === 3 ? col : col[1], cc = col.length === 3 ? col : col[2];
    for (const [p, cl, t] of [[a, ca, uva], [b, cb, uvb], [c, cc, uvc]]) {
      this.P.push3(p[0], p[1], p[2]);
      this.N.push3(nx, ny, nz);
      this.Cl.push3(cl[0], cl[1], cl[2]);
      if (this.U) this.U.push2(t ? t[0] : this.uvDef[0], t ? t[1] : this.uvDef[1]);
      if (this.K) this.K.push1(this.k);
    }
  }
  /** 世界坐标四边形 a→b→c→d（逆时针朝外） */
  quadW(a, b, c, d, col, uv) {
    const cc = col.length === 4 && Array.isArray(col[0]) ? col : null;
    this.triW(a, b, c, cc ? [cc[0], cc[1], cc[2]] : col, uv && uv[0], uv && uv[1], uv && uv[2]);
    this.triW(a, c, d, cc ? [cc[0], cc[2], cc[3]] : col, uv && uv[0], uv && uv[2], uv && uv[3]);
  }
  tri(a, b, c, col) { this.triW(this._w(a), this._w(b), this._w(c), col); }
  quad(a, b, c, d, col, uv) { this.quadW(this._w(a), this._w(b), this._w(c), this._w(d), col, uv); }
  /** 局部轴对齐盒（min/max 角）；bottom=false 不画底面 */
  box(x0, y0, z0, x1, y1, z1, col, { bottom = false, top = true, sides = 15, colTop = null } = {}) {
    const q = (a, b, c, d, cl) => this.quad(a, b, c, d, cl);
    if (sides & 1) q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col); // 前 +z
    if (sides & 2) q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], col); // 后 -z
    if (sides & 4) q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], col); // 右 +x
    if (sides & 8) q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col); // 左 -x
    if (top) q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], colTop || col);
    if (bottom) q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col);
  }
  /** 中心-尺寸盒（底面在 y） */
  boxC(cx, y, cz, sx, sy, sz, col, opt) {
    this.box(cx - sx / 2, y, cz - sz / 2, cx + sx / 2, y + sy, cz + sz / 2, col, opt);
  }
  /** 竖直圆柱（无底） */
  cyl(cx, y0, cz, r, h, col, seg = 6, top = true, r1 = r) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r];
      const q0 = [cx + Math.cos(a0) * r1, y0 + h, cz + Math.sin(a0) * r1], q1 = [cx + Math.cos(a1) * r1, y0 + h, cz + Math.sin(a1) * r1];
      this.quad(p1, p0, q0, q1, col);
      if (top) this.tri([cx, y0 + h, cz], q1, q0, col);
    }
  }
  /** 竖直旋转体（树干：根部外扩 + 锥台），rings = [[y, r], ...] 自下而上，无顶无底，法线朝外 */
  lathe(cx, cz, rings, col, seg = 6, a0 = 0) {
    for (let k = 0; k + 1 < rings.length; k++) {
      const [ya, ra] = rings[k], [yb, rb] = rings[k + 1];
      for (let i = 0; i < seg; i++) {
        const t0 = a0 + (i / seg) * Math.PI * 2, t1 = a0 + ((i + 1) / seg) * Math.PI * 2;
        const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
        this.quad([cx + c1 * ra, ya, cz + s1 * ra], [cx + c0 * ra, ya, cz + s0 * ra], [cx + c0 * rb, yb, cz + s0 * rb], [cx + c1 * rb, yb, cz + s1 * rb], col);
      }
    }
  }
  /** 两点之间的锥管（局部坐标，半径 ra → rb，seg 边，无端面）：树枝 */
  tube(a, b, ra, rb, col, seg = 5) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    const t = [dx / L, dy / L, dz / L];
    const ref = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
    const ul = Math.hypot(u[0], u[1], u[2]) || 1;
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const v = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
    const P = (p, r, k) => {
      const an = (k / seg) * Math.PI * 2, c = Math.cos(an) * r, s = Math.sin(an) * r;
      return [p[0] + u[0] * c + v[0] * s, p[1] + u[1] * c + v[1] * s, p[2] + u[2] * c + v[2] * s];
    };
    for (let k = 0; k < seg; k++) this.quad(P(a, ra, k), P(a, ra, k + 1), P(b, rb, k + 1), P(b, rb, k), col);
  }
  /** 两点之间的方截面杆（宽 w），用于钢管/横梁（比圆管省面） */
  bar(a, b, w, col, h = w) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    const t = [dx / L, dy / L, dz / L];
    // 取一个与 t 不平行的参考向量
    const ref = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
    const ul = Math.hypot(...u) || 1;
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const v = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
    const hw = w / 2, hh = h / 2;
    const corner = (p, su, sv) => [p[0] + u[0] * hw * su + v[0] * hh * sv, p[1] + u[1] * hw * su + v[1] * hh * sv, p[2] + u[2] * hw * su + v[2] * hh * sv];
    const A = [corner(a, 1, 1), corner(a, -1, 1), corner(a, -1, -1), corner(a, 1, -1)];
    const B = [corner(b, 1, 1), corner(b, -1, 1), corner(b, -1, -1), corner(b, 1, -1)];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(A[i], A[j], B[j], B[i], col);
    }
  }
  /** 四坡（攒尖）屋顶：底 w×d，檐口 y，高 h */
  pyramid(cx, y, cz, w, d, h, col, colUnder = null) {
    const a = [cx - w / 2, y, cz + d / 2], b = [cx + w / 2, y, cz + d / 2], c = [cx + w / 2, y, cz - d / 2], e = [cx - w / 2, y, cz - d / 2];
    const t = [cx, y + h, cz];
    this.tri(a, b, t, col);
    this.tri(b, c, t, col);
    this.tri(c, e, t, col);
    this.tri(e, a, t, col);
    if (colUnder) this.quad(e, c, b, a, colUnder);
  }
  /** 低面数球（二十面体一次细分 = 80 面；detail 0 = 20 面），缩放 sx,sy,sz，逐面明暗抖动 */
  blob(cx, cy, cz, sx, sy, sz, col, detail = 0, jitter = 0.12, seed = 1) {
    const g = detail ? ICO1 : ICO0;
    for (let i = 0; i < g.length; i += 9) {
      const k = 1 + (((Math.sin((i + seed * 13.7) * 12.9898) * 43758.5453) % 1 + 1) % 1 - 0.5) * jitter * 2;
      const cl = [col[0] * k, col[1] * k, col[2] * k];
      this.tri([cx + g[i] * sx, cy + g[i + 1] * sy, cz + g[i + 2] * sz], [cx + g[i + 3] * sx, cy + g[i + 4] * sy, cz + g[i + 5] * sz], [cx + g[i + 6] * sx, cy + g[i + 7] * sy, cz + g[i + 8] * sz], cl);
    }
  }
  /** 合入另一个写入器的全部三角形（已是世界坐标） */
  append(o) {
    if (!o.count) return;
    for (const [d, s] of [[this.P, o.P], [this.N, o.N], [this.Cl, o.Cl]]) {
      d.need(s.n);
      d.a.set(s.a.subarray(0, s.n), d.n);
      d.n += s.n;
    }
  }
  /**
   * 输出 BufferGeometry（非索引）。compact：法线 Int8、顶点色 Uint8（归一化）、aK Uint8——每顶点 36 B → 18 B，
   * 合批缓冲（BatchedMesh）显存减半
   */
  geometry(compact = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.P.out(), 3));
    if (compact) {
      const n = this.N.n, N = this.N.a, Cs = this.Cl.a;
      const ni = new Int8Array(n), ci = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        ni[i] = Math.round(N[i] * 127);
        const v = Cs[i];
        ci[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
      }
      g.setAttribute('normal', new THREE.BufferAttribute(ni, 3, true));
      g.setAttribute('color', new THREE.BufferAttribute(ci, 3, true));
      if (this.U) g.setAttribute('uv', new THREE.BufferAttribute(this.U.out(), 2));
      if (this.K) g.setAttribute('aK', new THREE.BufferAttribute(Uint8Array.from(this.K.a.subarray(0, this.K.n)), 1));
      return g;
    }
    g.setAttribute('normal', new THREE.BufferAttribute(this.N.out(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.Cl.out(), 3));
    if (this.U) g.setAttribute('uv', new THREE.BufferAttribute(this.U.out(), 2));
    if (this.K) g.setAttribute('aK', new THREE.BufferAttribute(this.K.out(), 1));
    return g;
  }
}
const ICO0 = (() => {
  let g = new THREE.IcosahedronGeometry(1, 0);
  if (g.index) g = g.toNonIndexed();
  return Array.from(g.attributes.position.array);
})();
const ICO1 = (() => {
  let g = new THREE.IcosahedronGeometry(1, 1);
  if (g.index) g = g.toNonIndexed();
  return Array.from(g.attributes.position.array);
})();

// ———————————————————————————————— 调色 ————————————————————————————————
export const PAL = {
  white: C('#e6e4de'), offwhite: C('#d8d3c8'), gray: C('#9a9894'), dgray: C('#4a4c4f'), black: C('#26282a'),
  iron: C('#2c2f32'), ironG: C('#2f4438'), ironB: C('#3b2f2a'),
  stone: C('#c9bea9'), stone2: C('#b7ab95'), granite: C('#a8a49c'), brick: C('#8a4e3b'), brickD: C('#6e3d2e'), plaster: C('#c7c0b2'), tile: C('#5d5f62'),
  glass: C('#2e3b40'), glassL: C('#6f8a92'),
  yellow: C('#f0c419'), blue: C('#2c6fd1'), green: C('#3a9a4a'), red: C('#c8372d'), orange: C('#e8792b'), sky: C('#5fb6e0'), purple: C('#7b4fb3'),
  wood: C('#9a6a42'), woodD: C('#6b4529'), redWood: C('#7a2e22'),
  roofBlue: C('#3d6ea8'), roofGreen: C('#4f7d5a'), roofGray: C('#6d7175'),
  leaf: C('#4f7a36'), leafD: C('#3c6229'), leafY: C('#7e9a3e'), leafR: C('#8a3b2f'),
  rubber: C('#b2463a'), rubberG: C('#4f8a4a'), rubberB: C('#3f6fa8'),
};

// ———————————————————————————————— 构件 ————————————————————————————————

/** 门岗亭：S 实体写入器，G 发光写入器（夜间亮灯的窗） */
export function booth(S, G, { w = 2.4, d = 2.0, h = 2.7, wall = PAL.white, trim = PAL.dgray, roof = PAL.dgray } = {}) {
  S.box(-w / 2 - 0.1, 0, -d / 2 - 0.1, w / 2 + 0.1, 0.15, d / 2 + 0.1, PAL.granite);
  // 下部墙裙
  S.box(-w / 2, 0.15, -d / 2, w / 2, 0.95, d / 2, wall, { top: false });
  // 四角立柱
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) S.box(sx * w / 2 - (sx > 0 ? 0.12 : 0), 0.95, sz * d / 2 - (sz > 0 ? 0.12 : 0), sx * w / 2 + (sx < 0 ? 0.12 : 0), h - 0.35, sz * d / 2 + (sz < 0 ? 0.12 : 0), trim, { top: false });
  // 窗带（发光写入器）
  const y0 = 0.95, y1 = h - 0.35;
  const gc = C('#ffd9a0');
  G.setXf(S.ox, S.oy, S.oz, Math.atan2(S.s, S.c));
  G.uvDef = [1, 0];
  G.quad([-w / 2 + 0.12, y0, d / 2 + 0.005], [w / 2 - 0.12, y0, d / 2 + 0.005], [w / 2 - 0.12, y1, d / 2 + 0.005], [-w / 2 + 0.12, y1, d / 2 + 0.005], gc);
  G.quad([w / 2 - 0.12, y0, -d / 2 - 0.005], [-w / 2 + 0.12, y0, -d / 2 - 0.005], [-w / 2 + 0.12, y1, -d / 2 - 0.005], [w / 2 - 0.12, y1, -d / 2 - 0.005], gc);
  G.quad([w / 2 + 0.005, y0, d / 2 - 0.12], [w / 2 + 0.005, y0, -d / 2 + 0.12], [w / 2 + 0.005, y1, -d / 2 + 0.12], [w / 2 + 0.005, y1, d / 2 - 0.12], gc);
  G.quad([-w / 2 - 0.005, y0, -d / 2 + 0.12], [-w / 2 - 0.005, y0, d / 2 - 0.12], [-w / 2 - 0.005, y1, d / 2 - 0.12], [-w / 2 - 0.005, y1, -d / 2 + 0.12], gc);
  G.uvDef = [0, 0];
  // 檐口与屋面
  S.box(-w / 2, h - 0.35, -d / 2, w / 2, h - 0.05, d / 2, wall, { top: false });
  S.box(-w / 2 - 0.3, h - 0.05, -d / 2 - 0.3, w / 2 + 0.3, h + 0.12, d / 2 + 0.3, roof, { bottom: true });
}

/** 道闸：机箱 + 红白闸杆（沿局部 +x 伸出 len） */
export function barrier(S, { len = 3.8, body = PAL.yellow } = {}) {
  S.box(-0.18, 0, -0.15, 0.18, 1.0, 0.15, body, { colTop: PAL.dgray });
  const n = Math.round(len / 0.45);
  for (let i = 0; i < n; i++) {
    const x0 = 0.18 + (i * len) / n, x1 = 0.18 + ((i + 1) * len) / n;
    S.box(x0, 0.86, -0.04, x1, 0.94, 0.04, i & 1 ? PAL.white : PAL.red);
  }
  // 闸杆末端支架
  S.box(len + 0.1, 0, -0.04, len + 0.18, 0.86, 0.04, PAL.dgray, { top: false });
}

/**
 * 大门门头（局部原点 = 车道中线与围墙线交点，+z 指向小区内，门洞总宽 W）
 * style: 'modern' 石材门柱 + 横梁（新小区）/ 'wall' 景墙 + 门柱（新小区）/ 'old' 砖门柱 + 铁艺拱（老小区）/ 'campus' 校门
 * 返回门牌位置（局部）：{x, y, z, w, h}
 */
export function gateFrame(S, W, style, seed = 0) {
  const hw = W / 2;
  if (style === 'old') {
    for (const sx of [-1, 1]) {
      S.box(sx * (hw + 0.45) - 0.4, 0, -0.4, sx * (hw + 0.45) + 0.4, 3.0, 0.4, PAL.brick, { colTop: PAL.tile });
      S.box(sx * (hw + 0.45) - 0.5, 3.0, -0.5, sx * (hw + 0.45) + 0.5, 3.15, 0.5, PAL.tile);
    }
    // 铁艺拱：两端 3.0 m、中间 4.0 m 的折线拱
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, x = -hw - 0.45 + t * (W + 0.9);
      pts.push([x, 3.0 + Math.sin(t * Math.PI) * 1.0, 0]);
    }
    for (let i = 0; i < 8; i++) S.bar(pts[i], pts[i + 1], 0.12, PAL.iron, 0.12);
    for (let i = 0; i < 8; i++) S.bar([pts[i][0], 3.0, 0], pts[i], 0.05, PAL.iron);
    return { x: 0, y: 3.35, z: 0.1, w: Math.min(W * 0.55, 4.5), h: 0.6 };
  }
  if (style === 'wall') {
    // 一侧景墙（石材，带名称），两侧方柱
    const side = seed & 1 ? 1 : -1;
    const x0 = side * (hw + 1.0), L = 9;
    const xa = Math.min(x0, x0 + side * L), xb = Math.max(x0, x0 + side * L);
    S.box(xa, 0, -0.35, xb, 2.4, 0.35, PAL.stone, { colTop: PAL.stone2 });
    S.box(xa - 0.1, 0, -0.45, xb + 0.1, 0.3, 0.45, PAL.granite);
    for (const sx of [-1, 1]) S.box(sx * (hw + 0.5) - 0.45, 0, -0.45, sx * (hw + 0.5) + 0.45, 3.2, 0.45, PAL.stone2, { colTop: PAL.dgray });
    return { x: (xa + xb) / 2, y: 1.15, z: -0.37, w: L * 0.7, h: 0.9, back: true };
  }
  if (style === 'campus') {
    for (const sx of [-1, 1]) S.box(sx * (hw + 0.8) - 0.7, 0, -0.7, sx * (hw + 0.8) + 0.7, 5.5, 0.7, PAL.offwhite, { colTop: PAL.dgray });
    S.box(-hw - 1.5, 5.5, -0.9, hw + 1.5, 6.6, 0.9, PAL.offwhite, { bottom: true });
    S.box(-hw - 1.7, 6.6, -1.0, hw + 1.7, 6.8, 1.0, PAL.dgray, { bottom: true });
    return { x: 0, y: 5.75, z: -0.92, w: Math.min(W + 2, 9), h: 0.7, back: true };
  }
  // modern：两侧石材门柱 + 门楣横梁 + 顶部金属构架
  const ph = 5.2;
  for (const sx of [-1, 1]) {
    S.box(sx * (hw + 0.7) - 0.6, 0, -0.6, sx * (hw + 0.7) + 0.6, ph, 0.6, PAL.stone, { colTop: PAL.stone2 });
    S.box(sx * (hw + 0.7) - 0.75, 0, -0.75, sx * (hw + 0.7) + 0.75, 0.4, 0.75, PAL.granite);
  }
  S.box(-hw - 1.3, ph - 1.0, -0.7, hw + 1.3, ph, 0.7, PAL.stone2, { bottom: true });
  S.box(-hw - 1.5, ph, -0.9, hw + 1.5, ph + 0.18, 0.9, PAL.dgray, { bottom: true });
  return { x: 0, y: ph - 0.55, z: -0.72, w: Math.min(W * 0.8, 7), h: 0.62, back: true };
}

/**
 * 围栏/围墙一跨（世界坐标，起点 (ax,ya,az) → 终点 (bx,yb,bz)，(nx,nz) 指向小区内），墙顶随地形坡度。
 * S 实体（基座/墙体/压顶），A 透明贴图写入器（铁艺栏杆/花格，uv.x 沿长度米、uv.y：铁艺 0..0.5、花格 0.5..1），
 * F 近看实体（立柱/壁柱，按间距排布）。kind: 'iron' | 'brick' | 'plaster' | 'lattice'
 */
export function fenceSpan(S, A, F, ax, ya, az, bx, yb, bz, nx, nz, kind, col) {
  const L = Math.hypot(bx - ax, bz - az);
  if (L < 0.2) return;
  const tx = (bx - ax) / L, tz = (bz - az) / L;
  // 侧向单位向量 n（指向内侧）
  const P = (t, off, y) => [ax + tx * t + nx * off, (t <= 0 ? ya : t >= L ? yb : ya + ((yb - ya) * t) / L) + y, az + tz * t + nz * off];
  // 一段“截面为矩形”的直墙：横向 [o0,o1]，竖向 [y0,y1]（相对地面）；只画两侧与顶
  const slab = (W, o0, o1, y0, y1, cs, ct) => {
    // 外侧面（o0 侧，法线朝外 = -n）与内侧面（o1 侧，法线朝内 = +n）
    const a0 = P(0, o0, y0), b0 = P(L, o0, y0), b1 = P(L, o0, y1), a1 = P(0, o0, y1);
    const c0 = P(0, o1, y0), d0 = P(L, o1, y0), d1 = P(L, o1, y1), c1 = P(0, o1, y1);
    const outN = tz * nx - tx * nz;
    // (a0→b0→b1→a1) 的法线 = t×up，与 n 的点积 = -outN：outN > 0 时它朝外
    if (outN > 0) { W.quadW(a0, b0, b1, a1, cs); W.quadW(d0, c0, c1, d1, cs); }
    else { W.quadW(b0, a0, a1, b1, cs); W.quadW(c0, d0, d1, c1, cs); }
    // 顶面：(a1→b1→d1→c1) 的法线 = (0, outN, 0)·(o1-o0)
    if (outN > 0) W.quadW(a1, b1, d1, c1, ct || cs); else W.quadW(a1, c1, d1, b1, ct || cs);
  };
  const quadV = (W, off, y0, y1, colr, v0, v1) => {
    const a0 = P(0, off, y0), b0 = P(L, off, y0), b1 = P(L, off, y1), a1 = P(0, off, y1);
    W.quadW(a0, b0, b1, a1, colr, [[0, v0], [L * (v1 > 0.5 ? 0.8 : 1), v0], [L * (v1 > 0.5 ? 0.8 : 1), v1], [0, v1]]);
  };
  const posts = (sp, w, h, colp) => {
    const n = Math.max(1, Math.round(L / sp));
    for (let i = 0; i <= n; i++) {
      const t = (i * L) / n;
      const c = P(t, 0, 0);
      F.setXf(c[0], c[1], c[2], Math.atan2(tx, tz));
      F.box(-w / 2, -0.2, -w / 2, w / 2, h + 0.2, w / 2, colp, { top: false });
    }
  };
  if (kind === 'iron') {
    const base = 0.42, top = 1.95;
    slab(S, -0.18, 0.18, -0.35, base, PAL.stone, PAL.stone2);
    quadV(A, 0, base, top, col, 0, 0.5);
    posts(3.5, 0.13, top + 0.1, col);
  } else if (kind === 'lattice') {
    const base = 0.9, top = 2.1;
    slab(S, -0.12, 0.12, -0.35, base, PAL.plaster, PAL.tile);
    quadV(A, 0, base, top, col, 0.5, 1);
    slab(S, -0.16, 0.16, top, top + 0.1, PAL.tile);
    posts(5, 0.36, top + 0.12, PAL.plaster);
  } else {
    // 实心砖墙 / 抹灰墙（2.3 m）+ 瓦压顶，壁柱 4 m 一根
    const h = 2.3;
    slab(S, -0.12, 0.12, -0.35, h, col);
    slab(S, -0.2, 0.2, h, h + 0.12, PAL.tile);
    posts(5, 0.4, h + 0.15, col);
  }
}

/** 健身器材区（局部原点 = 场地中心，场地 w×d）——黄蓝绿撞色钢管 */
export function fitness(S, w, d, seed = 0) {
  const cols = [PAL.yellow, PAL.blue, PAL.green, PAL.red, PAL.orange];
  const pick = (i) => cols[(seed + i) % cols.length];
  const sp = Math.min(w, d) > 7 ? 2.6 : 2.2;
  const nx = Math.max(2, Math.floor(w / sp)), nz = Math.max(1, Math.floor(d / 3.2));
  let k = 0;
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const x = -w / 2 + (ix + 0.5) * (w / nx), z = -d / 2 + (iz + 0.5) * (d / nz);
      const t = (seed + k * 7) % 5, c1 = pick(k), c2 = pick(k + 2);
      k++;
      if (t === 0) {
        // 太空漫步机：A 字架 + 两条摆腿
        S.bar([x - 0.5, 0, z], [x, 1.6, z], 0.09, c1); S.bar([x + 0.5, 0, z], [x, 1.6, z], 0.09, c1);
        S.bar([x - 0.35, 1.6, z], [x + 0.35, 1.6, z], 0.08, c1);
        for (const sz of [-0.3, 0.3]) { S.bar([x, 1.55, z + sz], [x, 0.35, z + sz], 0.05, c2); S.boxC(x, 0.3, z + sz, 0.35, 0.05, 0.18, PAL.dgray); }
        S.bar([x, 1.6, z - 0.3], [x, 1.9, z + 0.25], 0.05, c2);
      } else if (t === 1) {
        // 扭腰器：立柱 + 三个转盘
        S.cyl(x, 0, z, 0.06, 1.3, c1, 6);
        S.bar([x - 0.7, 1.3, z], [x + 0.7, 1.3, z], 0.06, c1);
        for (const dx of [-0.7, 0, 0.7]) S.cyl(x + dx, 0.15, z + 0.45, 0.28, 0.06, c2, 8);
      } else if (t === 2) {
        // 单杠（高低双杠）
        S.bar([x - 0.8, 0, z], [x - 0.8, 2.2, z], 0.09, c1); S.bar([x + 0.8, 0, z], [x + 0.8, 2.2, z], 0.09, c1);
        S.bar([x - 0.8, 2.15, z], [x + 0.8, 2.15, z], 0.05, PAL.gray);
        S.bar([x + 0.8, 0, z], [x + 1.5, 0, z], 0.09, c1); S.bar([x + 1.5, 0, z], [x + 1.5, 1.6, z], 0.09, c1); S.bar([x + 0.8, 1.6, z], [x + 1.5, 1.6, z], 0.05, PAL.gray);
      } else if (t === 3) {
        // 腰背按摩器：门形架 + 滚轮
        S.bar([x - 0.6, 0, z], [x - 0.6, 1.5, z], 0.09, c1); S.bar([x + 0.6, 0, z], [x + 0.6, 1.5, z], 0.09, c1);
        S.bar([x - 0.6, 1.45, z], [x + 0.6, 1.45, z], 0.08, c1);
        for (const y of [0.7, 1.05]) S.boxC(x, y, z + 0.1, 1.0, 0.18, 0.18, c2);
      } else {
        // 坐蹬器：座椅 + 踏板
        S.boxC(x, 0, z, 0.15, 0.55, 0.15, c1);
        S.boxC(x, 0.55, z - 0.1, 0.5, 0.06, 0.45, c2);
        S.bar([x, 0.6, z - 0.3], [x, 1.1, z - 0.4], 0.05, c1);
        S.bar([x, 0.4, z + 0.1], [x, 0.4, z + 0.8], 0.06, c1);
        S.boxC(x, 0.35, z + 0.85, 0.5, 0.05, 0.2, PAL.dgray);
      }
    }
}

/** 儿童游乐：滑梯组合 + 秋千 + 跷跷板 + 摇摇乐（局部原点 = 场地中心） */
export function playground(S, w, d, seed = 0) {
  const cA = [PAL.red, PAL.blue, PAL.yellow, PAL.green][seed % 4], cB = [PAL.yellow, PAL.green, PAL.sky, PAL.orange][(seed >> 2) % 4];
  // 滑梯组合（场地一端）
  const sx = -w / 2 + 3.2, sz = 0;
  const ph = 1.4;
  for (const dx of [-0.9, 0.9]) for (const dz of [-0.9, 0.9]) S.cyl(sx + dx, 0, sz + dz, 0.07, 2.9, cA, 6, false);
  S.box(sx - 1.0, ph - 0.08, sz - 1.0, sx + 1.0, ph, sz + 1.0, cB);
  S.pyramid(sx, 2.9, sz, 2.4, 2.4, 0.9, cA, cA);
  // 护栏
  S.box(sx - 1.0, ph, sz - 1.0, sx + 1.0, ph + 0.7, sz - 0.95, cB, { top: true });
  S.box(sx - 1.0, ph, sz + 0.95, sx + 1.0, ph + 0.7, sz + 1.0, cB, { top: true });
  // 滑道（向 +x 方向下滑）
  const x0 = sx + 1.0, x1 = sx + 3.6;
  S.quad([x0, ph, sz - 0.35], [x0, ph, sz + 0.35], [x1, 0.3, sz + 0.35], [x1, 0.3, sz - 0.35], PAL.yellow);
  S.quad([x0, ph, sz + 0.35], [x0, ph, sz - 0.35], [x1, 0.3, sz - 0.35], [x1, 0.3, sz + 0.35], PAL.yellow);
  for (const dz of [-0.4, 0.4]) S.bar([x0, ph + 0.25, sz + dz], [x1, 0.55, sz + dz], 0.08, PAL.yellow, 0.3);
  // 爬梯（-x 方向）
  for (let i = 0; i < 5; i++) S.boxC(sx - 1.2 - i * 0.18, i * 0.28, sz, 0.12, 0.05, 0.6, PAL.dgray);
  // 秋千（场地另一端）
  const qx = w / 2 - 2.4, qh = 2.4;
  for (const dz of [-1.6, 1.6]) {
    S.bar([qx - 0.7, 0, sz + dz], [qx, qh, sz + dz], 0.08, cA);
    S.bar([qx + 0.7, 0, sz + dz], [qx, qh, sz + dz], 0.08, cA);
  }
  S.bar([qx, qh, sz - 1.7], [qx, qh, sz + 1.7], 0.09, cA);
  for (const dz of [-0.75, 0.75]) {
    for (const ox of [-0.25, 0.25]) S.bar([qx, qh, sz + dz + ox], [qx, 0.5, sz + dz + ox], 0.02, PAL.gray);
    S.boxC(qx, 0.45, sz + dz, 0.25, 0.05, 0.6, PAL.dgray);
  }
  // 跷跷板 / 摇摇乐（中间）
  if (d > 7) {
    S.boxC(0, 0, -d / 2 + 1.6, 0.2, 0.45, 0.2, PAL.dgray);
    S.bar([-1.6, 0.25, -d / 2 + 1.6], [1.6, 0.65, -d / 2 + 1.6], 0.25, cB, 0.06);
  }
  for (let i = 0; i < 2; i++) {
    const x = -0.8 + i * 1.6, z = d / 2 - 1.5;
    S.cyl(x, 0, z, 0.05, 0.4, PAL.gray, 5, false);
    S.blob(x, 0.65, z, 0.4, 0.3, 0.25, i ? PAL.green : PAL.sky, 0, 0.1, seed + i);
  }
}

/** 凉亭（方亭，攒尖屋面）或廊架（木质花架） */
export function pavilion(S, w, d, kind = 'ting', seed = 0) {
  if (kind === 'ting') {
    const h = 2.8, s = Math.min(w, d) - 1.6;
    const col = seed & 1 ? PAL.redWood : PAL.woodD;
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) S.boxC((dx * s) / 2, 0.25, (dz * s) / 2, 0.24, h - 0.25, 0.24, col);
    S.box(-s / 2 - 0.4, 0, -s / 2 - 0.4, s / 2 + 0.4, 0.25, s / 2 + 0.4, PAL.granite);
    S.box(-s / 2 - 0.15, h - 0.25, -s / 2 - 0.15, s / 2 + 0.15, h, s / 2 + 0.15, col, { bottom: true });
    S.pyramid(0, h, 0, s + 1.4, s + 1.4, s * 0.45 + 0.4, seed & 2 ? PAL.roofGray : C('#4a5560'), PAL.wood);
    S.cyl(0, h + s * 0.45 + 0.4, 0, 0.12, 0.35, PAL.yellow, 5); // 宝顶
    // 坐凳
    for (const dz of [-1, 1]) S.box(-s / 2, 0.25, dz * s / 2 - 0.2 * dz - 0.15, s / 2, 0.7, dz * s / 2 - 0.2 * dz + 0.15, PAL.wood);
  } else {
    // 廊架：两排立柱 + 主梁 + 横向格栅
    const h = 2.7, L = Math.max(w, d) - 1, D = Math.min(w, d) - 1.2;
    const along = w >= d;
    const n = Math.max(2, Math.round(L / 3));
    const P = (a, y, b) => (along ? [a, y, b] : [b, y, a]);
    for (let i = 0; i <= n; i++) {
      const a = -L / 2 + (i * L) / n;
      for (const sb of [-1, 1]) {
        const p = P(a, 0, (sb * D) / 2);
        S.boxC(p[0], 0, p[2], 0.3, h, 0.3, PAL.offwhite);
      }
    }
    for (const sb of [-1, 1]) S.bar(P(-L / 2 - 0.4, h + 0.1, (sb * D) / 2), P(L / 2 + 0.4, h + 0.1, (sb * D) / 2), 0.16, PAL.wood, 0.25);
    const m = Math.round(L / 0.6);
    for (let i = 0; i <= m; i++) {
      const a = -L / 2 + (i * L) / m;
      S.bar(P(a, h + 0.3, -D / 2 - 0.5), P(a, h + 0.3, D / 2 + 0.5), 0.08, PAL.wood, 0.14);
    }
    for (const sb of [-1, 1]) S.box(...(along ? [-L / 2, 0, (sb * D) / 2 - 0.25, L / 2, 0.45, (sb * D) / 2 + 0.25] : [(sb * D) / 2 - 0.25, 0, -L / 2, (sb * D) / 2 + 0.25, 0.45, L / 2]), PAL.wood);
  }
}

/** 自行车/电动车棚（局部：沿 x 长 w，深 d，后墙在 -z，车头朝 -z） */
export function bikeShed(S, G, w, d, ebike = false, seed = 0) {
  const h0 = 2.2, h1 = 2.6;
  const roof = ebike ? PAL.roofGreen : seed & 1 ? PAL.roofBlue : C('#8f949a');
  const n = Math.max(2, Math.round(w / 3));
  for (let i = 0; i <= n; i++) {
    const x = -w / 2 + (i * w) / n;
    S.boxC(x, 0, -d / 2 + 0.1, 0.1, h1, 0.1, PAL.gray);
    S.boxC(x, 0, d / 2 - 0.1, 0.1, h0, 0.1, PAL.gray);
  }
  // 单坡屋面（后高前低），双面
  const a = [-w / 2 - 0.2, h1 + 0.05, -d / 2 - 0.2], b = [w / 2 + 0.2, h1 + 0.05, -d / 2 - 0.2], c = [w / 2 + 0.2, h0 + 0.05, d / 2 + 0.3], e = [-w / 2 - 0.2, h0 + 0.05, d / 2 + 0.3];
  S.quad(e, c, b, a, roof);
  S.quad(a, b, c, e, scl(roof, 0.7));
  // 后挡板（下半）
  S.box(-w / 2, 0, -d / 2 + 0.05, w / 2, 1.0, -d / 2 + 0.12, PAL.gray, { sides: 3 });
  // 车：自行车或电动车，车头朝后墙
  const cols = [PAL.black, PAL.red, PAL.blue, C('#e0e0e0'), PAL.dgray, C('#b4b8bc'), PAL.green];
  const pitch = ebike ? 0.95 : 0.85;
  const m = Math.floor((w - 0.4) / pitch);
  for (let i = 0; i < m; i++) {
    if (((seed * 31 + i * 17) % 10) < (ebike ? 2 : 1)) continue; // 少数空位
    const x = -w / 2 + 0.2 + (i + 0.5) * pitch;
    const col = cols[(seed + i * 5) % cols.length];
    const z0 = -d / 2 + 0.4, z1 = z0 + (ebike ? 1.7 : 1.7);
    if (ebike) {
      S.box(x - 0.17, 0.25, z0 + 0.35, x + 0.17, 0.75, z1 - 0.3, col);
      S.box(x - 0.14, 0.75, z1 - 0.75, x + 0.14, 0.88, z1 - 0.3, PAL.black);
      S.bar([x, 0.6, z0 + 0.3], [x, 1.05, z0 + 0.2], 0.05, PAL.dgray);
      S.bar([x - 0.3, 1.05, z0 + 0.2], [x + 0.3, 1.05, z0 + 0.2], 0.04, PAL.dgray);
    } else {
      S.bar([x, 0.4, z0 + 0.35], [x, 0.85, z1 - 0.55], 0.05, col);
      S.bar([x - 0.25, 1.0, z0 + 0.3], [x + 0.25, 1.0, z0 + 0.3], 0.03, PAL.dgray);
    }
    // 车轮（八边形薄片，两侧各一个扇面）
    for (const z of [z0 + 0.3, z1 - 0.3])
      for (const sx of [-0.025, 0.025]) {
        for (let k = 0; k < 8; k++) {
          const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2;
          const p0 = [x + sx, 0.32 + Math.sin(a0) * 0.31, z + Math.cos(a0) * 0.31], p1 = [x + sx, 0.32 + Math.sin(a1) * 0.31, z + Math.cos(a1) * 0.31];
          if (sx > 0) S.tri([x + sx, 0.32, z], p0, p1, PAL.black); else S.tri([x + sx, 0.32, z], p1, p0, PAL.black);
        }
      }
  }
  if (ebike) {
    // 充电桩：后墙上一排白色充电箱（绿色指示灯发光）
    const k = Math.max(1, Math.floor(w / 3));
    for (let i = 0; i < k; i++) {
      const x = -w / 2 + (i + 0.5) * (w / k);
      S.box(x - 0.2, 1.1, -d / 2 + 0.12, x + 0.2, 1.6, -d / 2 + 0.3, PAL.white);
      G.setXf(S.ox, S.oy, S.oz, Math.atan2(S.s, S.c));
      G.quad([x - 0.12, 1.45, -d / 2 + 0.305], [x + 0.12, 1.45, -d / 2 + 0.305], [x + 0.12, 1.55, -d / 2 + 0.305], [x - 0.12, 1.55, -d / 2 + 0.305], C('#5cff8a'));
    }
  }
}

/** 垃圾分类亭（局部：宽 w 沿 x，深 d，开口朝 +z） */
export function trashKiosk(S, w, d) {
  S.box(-w / 2, 0, -d / 2, w / 2, 0.12, d / 2, PAL.granite);
  S.box(-w / 2, 0.12, -d / 2, w / 2, 2.3, -d / 2 + 0.1, PAL.offwhite, { top: false });
  for (const sx of [-1, 1]) S.box(sx * w / 2 - 0.05, 0.12, -d / 2, sx * w / 2 + 0.05, 2.3, d / 2, PAL.offwhite, { top: false });
  S.box(-w / 2 - 0.25, 2.3, -d / 2 - 0.1, w / 2 + 0.25, 2.45, d / 2 + 0.35, PAL.green, { bottom: true });
  S.box(-w / 2, 2.0, d / 2 - 0.05, w / 2, 2.3, d / 2 + 0.02, PAL.green); // 标识带
  const bins = [C('#5e6266'), PAL.blue, PAL.red, PAL.green];
  const n = 4, bw = Math.min(0.62, (w - 0.4) / n);
  for (let i = 0; i < n; i++) {
    const x = -((n - 1) * (bw + 0.08)) / 2 + i * (bw + 0.08);
    S.box(x - bw / 2, 0.12, -0.35, x + bw / 2, 1.1, 0.35, bins[i], { colTop: scl(bins[i], 0.8) });
  }
}

/** 智能快递柜（局部：宽 w 沿 x，柜门朝 +z） */
export function locker(S, G, w) {
  const h = 1.95, d = 0.6;
  S.box(-w / 2, 0, -d / 2, w / 2, h, d / 2, C('#cfd3d6'), { colTop: PAL.dgray });
  const n = Math.round(w / 0.6);
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (i + 0.5) * (w / n);
    S.box(x - 0.008, 0.1, d / 2, x + 0.008, h - 0.15, d / 2 + 0.01, PAL.gray, { top: false });
  }
  S.box(-w / 2 - 0.1, h, -d / 2 - 0.1, w / 2 + 0.1, h + 0.08, d / 2 + 0.5, C('#2f7bb8'), { bottom: true });
  G.setXf(S.ox, S.oy, S.oz, Math.atan2(S.s, S.c));
  G.uvDef = [1, 0];
  G.quad([-0.25, 1.1, d / 2 + 0.012], [0.25, 1.1, d / 2 + 0.012], [0.25, 1.45, d / 2 + 0.012], [-0.25, 1.45, d / 2 + 0.012], C('#9ad0ff'));
  G.uvDef = [0, 0];
}

/** 篮球架（局部原点 = 底线中点，篮板朝 +z） */
export function hoop(S) {
  S.box(-0.15, 0, -1.3, 0.15, 3.2, -1.0, PAL.blue);
  S.bar([0, 3.1, -1.15], [0, 3.1, 0.1], 0.12, PAL.blue);
  S.box(-0.9, 2.9, 0.1, 0.9, 3.95, 0.16, C('#eef0f2'));
  S.box(-0.3, 2.95, 0.161, 0.3, 3.4, 0.17, PAL.red, { top: false });
  // 篮圈：八段
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
    S.bar([Math.cos(a0) * 0.23, 3.05, 0.4 + Math.sin(a0) * 0.23], [Math.cos(a1) * 0.23, 3.05, 0.4 + Math.sin(a1) * 0.23], 0.025, PAL.orange);
  }
  S.boxC(0, -0.0, -1.15, 0.8, 0.12, 0.8, PAL.dgray);
}

/** 升旗台 + 旗杆 + 国旗（局部原点 = 台中心，旗面朝 +z） */
export function flagpole(S, h = 13) {
  S.box(-2.2, 0, -2.2, 2.2, 0.25, 2.2, PAL.granite);
  S.box(-1.6, 0.25, -1.6, 1.6, 0.5, 1.6, PAL.stone);
  S.box(-1.0, 0.5, -1.0, 1.0, 0.75, 1.0, PAL.stone2);
  S.cyl(0, 0.75, 0, 0.09, h, C('#d4d7da'), 8, true, 0.05);
  S.blob(0, h + 0.85, 0, 0.1, 0.1, 0.1, PAL.yellow, 0, 0);
  // 旗面（2.88×1.92 m，三号旗）
  const y1 = h + 0.6, y0 = y1 - 1.92;
  const red = C('#d42a20');
  for (let i = 0; i < 4; i++) {
    const xa = 0.1 + i * 0.72, xb = xa + 0.72;
    const wa = Math.sin(i * 0.9) * 0.18, wb = Math.sin((i + 1) * 0.9) * 0.18;
    S.quad([xa, y0, wa], [xb, y0, wb], [xb, y1, wb], [xa, y1, wa], red); // 实体材质双面渲染
  }
}

/** 庭院灯（局部原点 = 灯杆底）：S 灯杆，G 灯头发光体 */
export function lamp(S, G, kind = 0) {
  if (kind === 1) {
    // 草坪灯
    S.box(-0.07, 0, -0.07, 0.07, 0.55, 0.07, PAL.dgray, { top: false });
    G.setXf(S.ox, S.oy, S.oz, 0);
    G.box(-0.09, 0.55, -0.09, 0.09, 0.72, 0.09, C('#ffe2b0'), { top: false });
    S.box(-0.13, 0.72, -0.13, 0.13, 0.77, 0.13, PAL.dgray);
    return;
  }
  S.box(-0.1, 0, -0.1, 0.1, 0.4, 0.1, PAL.dgray, { top: false });
  S.box(-0.05, 0.4, -0.05, 0.05, 3.4, 0.05, PAL.dgray, { top: false });
  G.setXf(S.ox, S.oy, S.oz, 0);
  G.box(-0.16, 3.4, -0.16, 0.16, 3.82, 0.16, C('#ffe2b0'), { top: false });
  S.pyramid(0, 3.82, 0, 0.5, 0.5, 0.22, PAL.dgray, PAL.dgray);
}

/**
 * 地下车库出入口（局部：宽 w 沿 x，长 L 沿 z；车从 -z 端驶入、向 +z 下行）：
 * 两侧混凝土挡墙 + 钢结构拱形玻璃雨棚（6 跨）+ 深色洞口；入口上方黄黑限高梁
 */
export function garageRamp(S, w, L) {
  const hw = w / 2, hl = L / 2;
  const wall = C('#b8b4ac'), steel = C('#5b6064'), glass = C('#8fb0b4'), dark = C('#0e0f10');
  // 挡墙（随坡道下行，墙顶保持 1.1 m）
  for (const sx of [-1, 1]) S.box(sx * hw - (sx > 0 ? 0.25 : 0), 0, -hl, sx * hw + (sx < 0 ? 0.25 : 0), 1.1, hl, wall);
  // 坡道下行：用几级逐渐变暗的地面片表现进深
  for (let i = 0; i < 6; i++) {
    const z0 = -hl + 3 + i * ((L - 3) / 6), z1 = z0 + (L - 3) / 6;
    const k = 1 - i * 0.14;
    S.quad([-hw + 0.25, 0.02 + 0.001 * i, z1], [hw - 0.25, 0.02 + 0.001 * i, z1], [hw - 0.25, 0.02 + 0.001 * i, z0], [-hw + 0.25, 0.02 + 0.001 * i, z0], scl(C('#3a3c3f'), k * 0.8));
  }
  // 洞口（末端竖向暗面 + 门楣）
  S.box(-hw, 0, hl - 0.3, hw, 3.2, hl, wall);
  S.quad([-hw + 0.3, 0.02, hl - 0.31], [hw - 0.3, 0.02, hl - 0.31], [hw - 0.3, 2.6, hl - 0.31], [-hw + 0.3, 2.6, hl - 0.31], dark);
  // 拱形雨棚：截面 8 段折线，拱脚在挡墙顶
  const seg = 8, rise = 2.3;
  const prof = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, x = -hw + t * w;
    prof.push([x, 1.1 + Math.sin(t * Math.PI) * rise]);
  }
  for (let i = 0; i < seg; i++) {
    const a = prof[i], b = prof[i + 1];
    S.quad([a[0], a[1], -hl + 1], [b[0], b[1], -hl + 1], [b[0], b[1], hl - 0.3], [a[0], a[1], hl - 0.3], glass);
    S.quad([b[0], b[1] - 0.02, -hl + 1], [a[0], a[1] - 0.02, -hl + 1], [a[0], a[1] - 0.02, hl - 0.3], [b[0], b[1] - 0.02, hl - 0.3], scl(glass, 0.7));
  }
  const ribs = 6;
  for (let r = 0; r <= ribs; r++) {
    const z = -hl + 1 + (r * (L - 1.3)) / ribs;
    for (let i = 0; i < seg; i++) S.bar([prof[i][0], prof[i][1] + 0.04, z], [prof[i + 1][0], prof[i + 1][1] + 0.04, z], 0.1, steel, 0.14);
  }
  // 限高梁（黄黑）
  for (let i = 0; i < 6; i++) {
    const x0 = -hw + (i * w) / 6, x1 = x0 + w / 6;
    S.box(x0, 2.45, -hl + 0.6, x1, 2.75, -hl + 0.8, i & 1 ? C('#1c1c1c') : C('#e2b21c'));
  }
  for (const sx of [-1, 1]) S.box(sx * hw - 0.12, 1.1, -hl + 0.55, sx * hw + 0.12, 2.75, -hl + 0.85, steel);
}

/** 一辆电动自行车/自行车（局部：车身沿 z，原点 = 车底中心）；ebike = 电动车（车身更厚、有脚踏板） */
export function twoWheeler(S, col, ebike = true) {
  // 车轮：单片六边形（材质双面）
  const wheel = (z) => {
    const r = ebike ? 0.26 : 0.32, cy = r;
    for (let k = 0; k < 6; k++) {
      const a0 = (k / 6) * Math.PI * 2, a1 = ((k + 1) / 6) * Math.PI * 2;
      S.tri([0, cy, z], [0, cy + Math.sin(a0) * r, z + Math.cos(a0) * r], [0, cy + Math.sin(a1) * r, z + Math.cos(a1) * r], PAL.black);
    }
  };
  wheel(0.62);
  wheel(-0.62);
  if (ebike) {
    S.box(-0.16, 0.22, -0.55, 0.16, 0.6, 0.35, col);
    S.box(-0.13, 0.6, -0.55, 0.13, 0.72, -0.05, PAL.black, { sides: 12 });
    S.box(-0.03, 0.5, 0.42, 0.03, 1.0, 0.5, PAL.dgray, { top: false, sides: 12 });
    S.box(-0.3, 0.97, 0.47, 0.3, 1.02, 0.53, PAL.dgray, { sides: 3 });
  } else {
    S.bar([0, 0.35, -0.6], [0, 0.85, 0.5], 0.05, col);
    S.bar([-0.25, 1.0, 0.55], [0.25, 1.0, 0.55], 0.03, PAL.dgray);
    S.boxC(0, 0.85, -0.35, 0.1, 0.05, 0.22, PAL.black);
  }
}

/** 晾衣杆：两根立杆 + 两道铁丝 + 几件晾晒的衣物床单（局部：沿 x 长 L） */
export function clothesLine(S, L, seed = 0) {
  for (const x of [-L / 2, L / 2]) S.box(x - 0.04, 0, -0.04, x + 0.04, 2.1, 0.04, PAL.gray, { top: false });
  for (const z of [-0.15, 0.15]) S.bar([-L / 2, 2.0, z], [L / 2, 2.0, z], 0.015, PAL.gray);
  const cols = [C('#e8e4da'), C('#c84a3a'), C('#3f6fb3'), C('#e2c04a'), C('#7a9a5a'), C('#d88aa0')];
  let x = -L / 2 + 0.4;
  let k = 0;
  while (x < L / 2 - 0.6) {
    const w = 0.4 + ((seed * 7 + k * 13) % 10) / 10, h = 0.5 + ((seed * 3 + k * 5) % 9) / 10;
    if (((seed + k * 3) % 4) !== 0) {
      const col = cols[(seed + k) % cols.length];
      const z = k & 1 ? 0.15 : -0.15;
      S.quad([x, 2.0 - h, z], [x + w, 2.0 - h, z], [x + w, 2.0, z], [x, 2.0, z], col);
    }
    x += w + 0.25;
    k++;
  }
}

/**
 * 树冠/灌木球叶簇贴图（512²）：七八个“叶团”拼成不规则外轮廓，每团先铺一块实心暗绿底（远处 mip 平均后 alphaTest 不至于
 * 把树冠吃空），再密铺小叶片（长 7~14 px：3.5 m 宽的小乔木树冠上约 5~10 cm，6 m 宽的大树冠叶团上约 8~16 cm）；
 * 叶团左上受光、右下背光，整体下半部压暗（自阴影），边缘留零星透光的叶隙。
 * （原先 256² 上 1400 片 10~28 px 的大叶片，单片 20~40 cm，人眼高度看像一团贴纸，审查 st_res_street）
 */
export function leafTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lit = ['#5f8240', '#6d8f48', '#7a9a50', '#577a3a'];
  const mid = ['#3f6129', '#47692e', '#4f7233', '#3a5a26'];
  const shade = ['#2a451d', '#2f4c20', '#243d19', '#33521f'];
  // 叶团：中心一团 + 外圈 7 团（半径 0.30~0.36 S 的环上），团半径 0.17~0.23 S
  const lobes = [[S / 2, S / 2 + 6, S * 0.24]];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + rnd() * 0.5, rr = S * (0.25 + rnd() * 0.06);
    lobes.push([S / 2 + Math.cos(a) * rr, S / 2 + Math.sin(a) * rr * 0.9, S * (0.15 + rnd() * 0.05)]);
  }
  // 实心底
  for (const [x, y, r] of lobes) {
    g.fillStyle = '#2c4820';
    g.beginPath();
    g.arc(x, y, r * 0.84, 0, Math.PI * 2);
    g.fill();
  }
  // 叶片：逐团密铺，团内按相对受光方向（左上亮、右下暗）选色
  for (const [x0, y0, r0] of lobes) {
    const n = Math.round(r0 * r0 * 0.12);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.6) * r0;
      const x = x0 + Math.cos(a) * rr, y = y0 + Math.sin(a) * rr;
      const lum = (-(x - x0) - (y - y0)) / (r0 * 1.414) + (y < S * 0.45 ? 0.25 : y > S * 0.62 ? -0.35 : 0) + (rnd() - 0.5) * 0.6;
      const pal = lum > 0.3 ? lit : lum > -0.25 ? mid : shade;
      g.fillStyle = pal[Math.floor(rnd() * pal.length)];
      const sz = 3.5 + rnd() * 3.2;
      g.save();
      g.translate(x, y);
      g.rotate(rnd() * Math.PI);
      g.beginPath();
      g.ellipse(0, 0, sz, sz * 0.48, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  // 叶隙：外缘随机抠掉少量小洞（透出天空）
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 160; i++) {
    const a = rnd() * Math.PI * 2, rr = S * (0.3 + rnd() * 0.16);
    g.beginPath();
    g.arc(S / 2 + Math.cos(a) * rr, S / 2 + Math.sin(a) * rr, 2 + rnd() * 4, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  return cv;
}

/**
 * 花丛贴图（256²）：一丛半球形的低矮花丛侧影——下部密实的深绿叶片，上半部点缀花朵。
 * 花朵画成近白色（R、B 都高），着色器据此把花朵换成实例色（月季红/萱草黄/鼠尾草紫/白晶菊/矮牵牛粉），叶片保持绿色。
 */
export function flowerTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  let seed = 31;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // 叶丛：底边平、上沿呈拱形（半椭圆）
  const inMound = (x, y) => { const dx = (x - S / 2) / (S * 0.48), dy = (S * 0.96 - y) / (S * 0.62); return y <= S * 0.98 && dx * dx + dy * dy <= 1; };
  g.fillStyle = '#25401b';
  g.beginPath();
  g.ellipse(S / 2, S * 0.96, S * 0.44, S * 0.56, 0, Math.PI, Math.PI * 2);
  g.fill();
  const leaf = ['#2f5222', '#3a6128', '#46702f', '#2a481e'];
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * S, y = S * 0.3 + rnd() * S * 0.68;
    if (!inMound(x, y)) continue;
    g.fillStyle = leaf[Math.floor(rnd() * leaf.length)];
    g.save();
    g.translate(x, y);
    g.rotate(-0.8 + rnd() * 1.6);
    g.beginPath();
    g.ellipse(0, 0, 2.5 + rnd() * 2.5, 1.2 + rnd(), 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // 花朵：集中在上半部，五瓣小花（近白，中心略暗）
  for (let i = 0; i < 260; i++) {
    const x = rnd() * S, y = S * 0.36 + Math.pow(rnd(), 1.6) * S * 0.5;
    if (!inMound(x, y + 6)) continue;
    const r = 3 + rnd() * 3.2;
    g.fillStyle = rnd() < 0.5 ? '#f4f2f0' : '#e2e0de';
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2 + rnd();
      g.beginPath();
      g.arc(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.5, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#b8b6b4';
    g.beginPath();
    g.arc(x, y, r * 0.28, 0, Math.PI * 2);
    g.fill();
  }
  return cv;
}

/** 长椅（局部：长沿 x，面朝 +z） */
export function bench(S) {
  for (const sx of [-0.7, 0.7]) S.boxC(sx, 0, 0, 0.06, 0.42, 0.4, PAL.dgray);
  S.boxC(0, 0.42, 0, 1.7, 0.05, 0.42, PAL.wood);
  S.box(-0.85, 0.5, -0.22, 0.85, 0.85, -0.18, PAL.wood);
}

// ———————————————————————————————— 车辆 ————————————————————————————————

/** 近景停放车（约 130 面）：车身顶点色白（乘实例色）、玻璃/轮胎深色。原点 = 车底中心，车头 +z */
export function carNear() {
  const W = new GeoWriter();
  const hw = 0.9;
  // 侧面轮廓（z, y）：前保险杠下 → 前脸 → 引擎盖 → 前挡顶 → 车顶尾 → 后窗底 → 行李箱尾 → 后保险杠下
  const prof = [[2.3, 0.28], [2.33, 0.72], [1.1, 0.92], [0.3, 1.42], [-1.0, 1.44], [-1.85, 0.98], [-2.3, 0.88], [-2.3, 0.28]];
  const body = [1, 1, 1];
  const n = prof.length;
  // 两侧面：剖面在引擎盖与前挡交界处是凹的，从车头角点扇形三角化会翻出一片反面三角形，
  // 改为从剖面内部一点（z 0、y 0.8，剖面对它星形可见）扇形三角化
  for (const sx of [-1, 1]) {
    const x = sx * hw, c0 = [x, 0.8, 0];
    for (let i = 0; i < n; i++) {
      const b = [x, prof[i][1], prof[i][0]], c = [x, prof[(i + 1) % n][1], prof[(i + 1) % n][0]];
      if (sx > 0) W.tri(c0, c, b, body); else W.tri(c0, b, c, body);
    }
  }
  // 周边面（顶、前、后），车顶两侧略内收。剖面按“车头下沿 → 车顶 → 车尾下沿”走，左 → 右的顶点顺序法线才朝外
  // （原先右 → 左，顶/前/后全部朝内被背面剔除，40 m 俯看只剩侧板和车轮，审查 g4/g5 P0）
  const inset = (y) => (y > 1.0 ? 0.12 : 0);
  for (let i = 0; i < n; i++) {
    const p = prof[i], q = prof[(i + 1) % n];
    if (i === n - 1) continue; // 底面不画
    const ia = inset(p[1]), ib = inset(q[1]);
    const glass = i === 2 || i === 4; // 前挡 / 后窗
    W.quad([-hw + ia, p[1], p[0]], [hw - ia, p[1], p[0]], [hw - ib, q[1], q[0]], [-hw + ib, q[1], q[0]], glass ? C('#151b1f') : body);
  }
  // 侧窗（贴在侧面外 1 cm，法线朝车外）
  for (const sx of [-1, 1]) {
    const x = sx * (hw + 0.01);
    const a = [x, 0.98, 1.0], b = [x, 0.98, -1.75], c = [x, 1.36, -0.95], d = [x, 1.36, 0.3];
    if (sx > 0) W.quad(a, b, c, d, C('#151b1f')); else W.quad(b, a, d, c, C('#151b1f'));
  }
  // 车灯
  for (const sx of [-1, 1]) {
    W.quad([sx * 0.55 - 0.18, 0.62, 2.335], [sx * 0.55 + 0.18, 0.62, 2.335], [sx * 0.55 + 0.18, 0.72, 2.335], [sx * 0.55 - 0.18, 0.72, 2.335], C('#d8dde0', 0.9));
    W.quad([sx * 0.6 + 0.16, 0.7, -2.305], [sx * 0.6 - 0.16, 0.7, -2.305], [sx * 0.6 - 0.16, 0.82, -2.305], [sx * 0.6 + 0.16, 0.82, -2.305], C('#7a1010'));
  }
  // 车轮（六棱柱，轴向 x；胎面法线沿径向朝外；外侧一片扇形轮辋。每轮 18 个三角形——
  // 小区里近景车成百上千辆，轮子是三角形大头）
  for (const z of [1.42, -1.38])
    for (const sx of [-1, 1]) {
      const r = 0.33, cy = 0.33, x0 = sx * (hw - 0.2), x1 = sx * (hw + 0.005);
      const SEG = 6, xo = x1 + sx * 0.003;
      for (let k = 0; k < SEG; k++) {
        const a0 = ((k + 0.5) / SEG) * Math.PI * 2, a1 = ((k + 1.5) / SEG) * Math.PI * 2;
        const p0 = [cy + Math.sin(a0) * r, z + Math.cos(a0) * r], p1 = [cy + Math.sin(a1) * r, z + Math.cos(a1) * r];
        if (sx > 0) {
          W.quad([x1, p0[0], p0[1]], [x1, p1[0], p1[1]], [x0, p1[0], p1[1]], [x0, p0[0], p0[1]], C('#141414'));
          W.tri([xo, cy, z], [xo, p1[0], p1[1]], [xo, p0[0], p0[1]], C('#3b3d3f'));
        } else {
          W.quad([x0, p0[0], p0[1]], [x0, p1[0], p1[1]], [x1, p1[0], p1[1]], [x1, p0[0], p0[1]], C('#141414'));
          W.tri([xo, cy, z], [xo, p0[0], p0[1]], [xo, p1[0], p1[1]], C('#3b3d3f'));
        }
      }
    }
  // 接触阴影（略高于地面的朝上暗色片，比车身略小）
  W.quad([-hw + 0.05, 0.02, 2.2], [hw - 0.05, 0.02, 2.2], [hw - 0.05, 0.02, -2.2], [-hw + 0.05, 0.02, -2.2], C('#050505'));
  return W.geometry();
}

/**
 * 自检：每个三角形的法线与“面心 − 部件中心”同向（车身取车体中轴、车轮取轮心）；返回朝内的三角形数。
 * 用于 node 单元检查（tools/check_compound_car.mjs），渲染时不调用。
 */
export function checkCarWinding(geo) {
  const P = geo.attributes.position.array;
  let bad = 0;
  for (let i = 0; i < P.length; i += 9) {
    const ax = P[i], ay = P[i + 1], az = P[i + 2], bx = P[i + 3], by = P[i + 4], bz = P[i + 5], cx = P[i + 6], cy = P[i + 7], cz = P[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
    const L = Math.hypot(nx, ny, nz) || 1;
    let ox, oy, oz;
    if (Math.abs(nx) / L > 0.9) { ox = 0; oy = my; oz = mz; } // 侧板/侧窗/轮毂盖：朝车外（x 与面心同号）
    else if (my < 0.7 && Math.abs(mx) > 0.68 && (Math.abs(mz - 1.42) < 0.4 || Math.abs(mz + 1.38) < 0.4)) {
      ox = mx; oy = 0.33; oz = Math.abs(mz - 1.42) < 0.4 ? 1.42 : -1.38; // 胎面：沿径向朝外
    } else if (my < 0.05) { ox = mx; oy = -1; oz = mz; } // 接触阴影片：朝上
    else { ox = 0; oy = 0.6; oz = mz * 0.5; } // 车身：剖面对 (y 0.6, z 0.5·z) 星形
    if (nx * (mx - ox) + ny * (my - oy) + nz * (mz - oz) <= 0) bad++;
  }
  return bad;
}

/** 远景停放车（约 18 面）：车身盒 + 座舱盒 */
export function carFar() {
  const W = new GeoWriter();
  W.box(-0.9, 0.25, -2.3, 0.9, 0.9, 2.3, [1, 1, 1]);
  W.box(-0.78, 0.9, -1.4, 0.78, 1.42, 0.6, C('#1a2024'), { sides: 15 });
  return W.geometry();
}
