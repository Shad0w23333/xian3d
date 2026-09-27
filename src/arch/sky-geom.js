// skyline：几何工具（多边形偏移/缩放、幕墙环带生成器、实体合批辅助）
import * as THREE from 'three';

// ---------- 多边形（扁平数组 [x,z,...]，CCW：shoelace>0，外法线 = (dz,-dx)） ----------
export function area(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a / 2;
}
export function ccw(p) {
  if (area(p) >= 0) return p.slice();
  const o = [];
  for (let i = p.length - 2; i >= 0; i -= 2) o.push(p[i], p[i + 1]);
  return o;
}
export function centroid(p) {
  let x = 0, z = 0, a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n, c = p[i] * p[j + 1] - p[j] * p[i + 1];
    a += c;
    x += (p[i] + p[j]) * c;
    z += (p[i + 1] + p[j + 1]) * c;
  }
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sz = 0;
    for (let i = 0; i < p.length; i += 2) { sx += p[i]; sz += p[i + 1]; }
    return { x: (sx * 2) / p.length, z: (sz * 2) / p.length };
  }
  return { x: x / (3 * a), z: z / (3 * a) };
}
export function bbox(p) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
  }
  return { x0, x1, z0, z1 };
}
/** 内缩（d>0 向内）。简单斜接，适合凸/近凸建筑轮廓 */
export function inset(p, d) {
  if (!d) return p.slice();
  const n = p.length / 2, o = [];
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, c = (i + 1) % n;
    const x = p[i * 2], z = p[i * 2 + 1];
    let d1x = x - p[a * 2], d1z = z - p[a * 2 + 1], d2x = p[c * 2] - x, d2z = p[c * 2 + 1] - z;
    const l1 = Math.hypot(d1x, d1z) || 1, l2 = Math.hypot(d2x, d2z) || 1;
    d1x /= l1; d1z /= l1; d2x /= l2; d2z /= l2;
    // 内法线（CCW：外法线 (dz,-dx) → 内法线 (-dz,dx)）
    const n1x = -d1z, n1z = d1x, n2x = -d2z, n2z = d2x;
    let bx = n1x + n2x, bz = n1z + n2z;
    const bl = Math.hypot(bx, bz) || 1;
    bx /= bl; bz /= bl;
    const cos = Math.max(0.35, bx * n1x + bz * n1z);
    o.push(x + (bx * d) / cos, z + (bz * d) / cos);
  }
  return o;
}
export function scaleAbout(p, cx, cz, s) {
  const o = new Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    o[i] = cx + (p[i] - cx) * s;
    o[i + 1] = cz + (p[i + 1] - cz) * s;
  }
  return o;
}
/** 旋转矩形（rot：局部 +x 转向 +z 的角度，弧度），可带圆角/倒角 */
export function rect(cx, cz, w, d, rot = 0, { round = 0, chamfer = 0, seg = 6 } = {}) {
  const c = Math.cos(rot), s = Math.sin(rot), pts = [];
  const hw = w / 2, hd = d / 2;
  const push = (x, z) => pts.push(cx + x * c - z * s, cz + x * s + z * c);
  // 局部坐标 CCW（x 右 z 下 → shoelace>0 的顺序：(-,-)→(+,-)→(+,+)→(-,+)）
  const corners = [[-hw, -hd, Math.PI], [hw, -hd, -Math.PI / 2], [hw, hd, 0], [-hw, hd, Math.PI / 2]];
  if (round > 0) {
    const r = Math.min(round, hw, hd);
    const cc = [[-hw + r, -hd + r, Math.PI], [hw - r, -hd + r, 1.5 * Math.PI], [hw - r, hd - r, 0], [-hw + r, hd - r, 0.5 * Math.PI]];
    for (const [x, z, a0] of cc) for (let k = 0; k <= seg; k++) {
      const a = a0 + (k / seg) * (Math.PI / 2);
      push(x + Math.cos(a) * r, z + Math.sin(a) * r);
    }
  } else if (chamfer > 0) {
    const e = chamfer;
    push(-hw + e, -hd); push(hw - e, -hd); push(hw, -hd + e); push(hw, hd - e);
    push(hw - e, hd); push(-hw + e, hd); push(-hw, hd - e); push(-hw, -hd + e);
  } else for (const [x, z] of corners) push(x, z);
  return ccw(pts);
}
export function circle(cx, cz, r, n = 32, a0 = 0) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    p.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
  }
  return ccw(p);
}
/** 最小外接矩形（按边方向枚举） → {cx,cz,w,d,rot}（w 沿 rot 方向为长边） */
export function obb(p) {
  let best = null;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ang = Math.atan2(p[j * 2 + 1] - p[i * 2 + 1], p[j * 2] - p[i * 2]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = p[k * 2], z = p[k * 2 + 1], u = x * c + z * s, v = -x * s + z * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const a = (u1 - u0) * (v1 - v0);
    if (!best || a < best.a) best = { a, ang, u0, u1, v0, v1 };
  }
  let { ang, u0, u1, v0, v1 } = best;
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2, c = Math.cos(ang), s = Math.sin(ang);
  let w = u1 - u0, d = v1 - v0;
  if (d > w) { [w, d] = [d, w]; ang += Math.PI / 2; }
  return { cx: uc * c - vc * s, cz: uc * s + vc * c, w, d, rot: ang };
}
export function pointIn(x, z, p) {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
  }
  return c;
}
export function perimeter(p) {
  let L = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    L += Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1]);
  }
  return L;
}

// ---------- 幕墙环带生成器（自定义属性，单独合批） ----------
export class FacadeBuilder {
  constructor() {
    this.P = []; this.N = []; this.UV = []; this.F = []; this.S = []; this.T = []; this.D = []; this.I = [];
  }
  get count() { return this.P.length / 3; }
  _v(x, y, z, nx, ny, nz, u, v, st) {
    this.P.push(x, y, z);
    this.N.push(nx, ny, nz);
    this.UV.push(u, v);
    this.F.push(st.floorH, st.colW, st.spandrel, st.seed);
    this.S.push(st.mullW, st.lit, st.mode, st.band);
    this.T.push(st.tint[0], st.tint[1], st.tint[2]);
    this.D.push(st.spd[0], st.spd[1], st.spd[2]);
    return this.P.length / 3 - 1;
  }
  /**
   * 两个等点数多边形之间的环形侧墙（bot 在 y0，top 在 y1；y 可以是数或 (x,z,i)=>y 函数）
   * vBase：v 坐标零点（塔底海拔）；uStart：周长起点
   */
  ring(bot, top, y0, y1, st, { vBase = 0, uStart = 0, vLocal = false } = {}) {
    const n = bot.length / 2;
    const Y0 = typeof y0 === 'function' ? y0 : () => y0;
    const Y1 = typeof y1 === 'function' ? y1 : () => y1;
    let u = uStart;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = bot[i * 2], az = bot[i * 2 + 1], bx = bot[j * 2], bz = bot[j * 2 + 1];
      const cx = top[i * 2], cz = top[i * 2 + 1], dx = top[j * 2], dz = top[j * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const ya0 = Y0(ax, az, i), yb0 = Y0(bx, bz, j), ya1 = Y1(cx, cz, i), yb1 = Y1(dx, dz, j);
      // 面法线
      const e1x = bx - ax, e1y = yb0 - ya0, e1z = bz - az;
      const e2x = cx - ax, e2y = ya1 - ya0, e2z = cz - az;
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      // 保证朝外（与 (dz,-dx) 同向）；e1×e2 若朝内，则三角形绕序也要反过来
      const flip = nx * (bz - az) + nz * -(bx - ax) < 0;
      if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // 着色器切线 t = (-nz,0,nx)，与边方向 (bx-ax,bz-az) 同向时 u 递增，否则取负
      const sgn = -nz * (bx - ax) + nx * (bz - az) >= 0 ? 1 : -1;
      const ua = u * sgn, ub = (u + L) * sgn;
      const vb = vLocal ? 0 : vBase;
      const v0 = this._v(ax, ya0, az, nx, ny, nz, ua, ya0 - vb, st);
      const v1 = this._v(bx, yb0, bz, nx, ny, nz, ub, yb0 - vb, st);
      const v2 = this._v(dx, yb1, dz, nx, ny, nz, ub, vLocal ? yb1 - Math.min(ya0, yb0) : yb1 - vb, st);
      const v3 = this._v(cx, ya1, cz, nx, ny, nz, ua, vLocal ? ya1 - Math.min(ya0, yb0) : ya1 - vb, st);
      if (vLocal) { this.UV[v0 * 2 + 1] = 0; this.UV[v1 * 2 + 1] = 0; }
      if (flip) this.I.push(v0, v2, v1, v0, v3, v2);
      else this.I.push(v0, v1, v2, v0, v2, v3);
      u += L;
    }
    return u;
  }
  /** 直立挤出：poly 从 y0 到 y1 */
  prism(poly, y0, y1, st, opt = {}) {
    return this.ring(poly, poly, y0, y1, st, opt);
  }
  /** 单个竖直矩形面板（a→b 为水平边，朝外法线由 a→b 决定：(dz,-dx)） */
  panel(ax, az, bx, bz, y0, y1, st, { vBase = y0, u0 = 0 } = {}) {
    this.ring([ax, az, bx, bz], [ax, az, bx, bz], y0, y1, st, { vBase, uStart: u0 });
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.UV, 2));
    g.setAttribute('aFac', new THREE.Float32BufferAttribute(this.F, 4));
    g.setAttribute('aSty', new THREE.Float32BufferAttribute(this.S, 4));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.T, 3));
    g.setAttribute('aSpd', new THREE.Float32BufferAttribute(this.D, 3));
    g.setIndex(this.P.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------- 实体几何（普通材质） ----------
/** 多边形顶盖（y 可为函数），返回非索引几何 */
export function capGeometry(poly, y, { down = false } = {}) {
  const Y = typeof y === 'function' ? y : () => y;
  const pts = [];
  for (let i = 0; i < poly.length; i += 2) pts.push(new THREE.Vector2(poly[i], poly[i + 1]));
  const tris = THREE.ShapeUtils.triangulateShape(pts, []);
  const pos = [];
  for (const t of tris) {
    const a = pts[t[0]], b = pts[t[1]], c = pts[t[2]];
    // (b-a)×(c-a) 的 y 分量 >0 即朝上
    const up = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y) > 0;
    const order = up !== down ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]];
    for (const k of order) pos.push(pts[k].x, Y(pts[k].x, pts[k].y, k), pts[k].y);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/** 普通侧墙（非幕墙：女儿墙、台基等），非索引 */
export function wallGeometry(bot, top, y0, y1) {
  const Y0 = typeof y0 === 'function' ? y0 : () => y0;
  const Y1 = typeof y1 === 'function' ? y1 : () => y1;
  const n = bot.length / 2, pos = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = [bot[i * 2], Y0(bot[i * 2], bot[i * 2 + 1]), bot[i * 2 + 1]];
    const b = [bot[j * 2], Y0(bot[j * 2], bot[j * 2 + 1]), bot[j * 2 + 1]];
    const c = [top[j * 2], Y1(top[j * 2], top[j * 2 + 1]), top[j * 2 + 1]];
    const d = [top[i * 2], Y1(top[i * 2], top[i * 2 + 1]), top[i * 2 + 1]];
    // CCW 轮廓：a→b→c 的叉积朝外
    pos.push(...a, ...c, ...b, ...a, ...d, ...c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/** 实心挤出体（侧墙 + 顶盖） */
export function solidPrism(poly, y0, y1, { top = true, bottom = false } = {}) {
  const parts = [wallGeometry(poly, poly, y0, y1)];
  if (top) parts.push(capGeometry(poly, y1));
  if (bottom) parts.push(capGeometry(poly, y0, { down: true }));
  return parts;
}
/** 两个多边形之间的平环（檐口/挑板），top 朝上 */
export function annulus(outer, inner, y) {
  const n = outer.length / 2, pos = [];
  const Y = typeof y === 'function' ? y : () => y;
  const V = (p, k) => [p[k * 2], Y(p[k * 2], p[k * 2 + 1]), p[k * 2 + 1]];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const o1 = V(outer, i), o2 = V(outer, j), i1 = V(inner, i), i2 = V(inner, j);
    pos.push(...o1, ...i2, ...o2, ...o1, ...i1, ...i2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/** 简单盒子（世界坐标中心、尺寸、绕 Y 旋转） */
export function box(cx, cy, cz, w, h, d, rotY = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(-rotY);
  g.translate(cx, cy, cz);
  return g;
}
export function cyl(cx, y0, cz, r0, r1, h, seg = 12, open = false) {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, open);
  g.translate(cx, y0 + h / 2, cz);
  return g;
}
