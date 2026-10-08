// 公园近景：几何累加器（块静态网格：位置 / 法线 / 顶点色 / UV（米）/ 纹理层 aMat）与常用形体。
import * as THREE from 'three';

const _c = new THREE.Color();
/** 十六进制颜色 → 线性 rgb（顶点色在线性空间相乘） */
export function lin(hex, k = 1) {
  _c.set(hex);
  return [_c.r * k, _c.g * k, _c.b * k];
}

export class MeshBuf {
  constructor() {
    this.P = []; this.N = []; this.C = []; this.U = []; this.M = []; this.I = [];
    this.n = 0;
  }
  get empty() { return this.I.length === 0; }
  v(x, y, z, nx, ny, nz, col, u, w, mat) {
    this.P.push(x, y, z); this.N.push(nx, ny, nz); this.C.push(col[0], col[1], col[2]); this.U.push(u, w); this.M.push(mat);
    return this.n++;
  }
  /**
   * 四边形 a→b→c→d（从法线一侧看逆时针），n 为法线；uv 四角 [[u,v]×4]
   */
  quad(a, b, c, d, n, col, uv, mat) {
    const i = this.v(a[0], a[1], a[2], n[0], n[1], n[2], col, uv[0][0], uv[0][1], mat);
    this.v(b[0], b[1], b[2], n[0], n[1], n[2], col, uv[1][0], uv[1][1], mat);
    this.v(c[0], c[1], c[2], n[0], n[1], n[2], col, uv[2][0], uv[2][1], mat);
    this.v(d[0], d[1], d[2], n[0], n[1], n[2], col, uv[3][0], uv[3][1], mat);
    this.I.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  /** 四边形（自动按期望法线 n 定绕序；n 不必精确，只看朝向） */
  quadN(a, b, c, d, n, col, uv, mat) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const l = Math.hypot(cx, cy, cz) || 1;
    let nn = [cx / l, cy / l, cz / l];
    if (nn[0] * n[0] + nn[1] * n[1] + nn[2] * n[2] < 0) {
      nn = [-nn[0], -nn[1], -nn[2]];
      this.quad(a, d, c, b, nn, col, [uv[0], uv[3], uv[2], uv[1]], mat);
    } else this.quad(a, b, c, d, nn, col, uv, mat);
  }
  /**
   * 定向长方体：中心底面 (x, y0, z)，绕 Y 旋转 yaw（局部 +X = (cos, −sin)…与 three 一致：x' = x cos + z sin, z' = −x sin + z cos），
   * 尺寸 sx（局部 X）× sy（高）× sz（局部 Z）。skipBottom 默认 true。UV 以米计（侧面 u 水平、v 竖直）。
   */
  box(x, y0, z, yaw, sx, sy, sz, col, mat, { skipBottom = true, top = col, uvScale = 1 } = {}) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const hx = sx / 2, hz = sz / 2, y1 = y0 + sy;
    const P = (lx, ly, lz) => [x + lx * c + lz * s, ly, z - lx * s + lz * c];
    const ex = [c, 0, -s], ez = [s, 0, c];
    const k = uvScale;
    // +Z 面
    this.quad(P(-hx, y0, hz), P(hx, y0, hz), P(hx, y1, hz), P(-hx, y1, hz), ez, col, [[0, 0], [sx * k, 0], [sx * k, sy * k], [0, sy * k]], mat);
    // −Z 面
    this.quad(P(hx, y0, -hz), P(-hx, y0, -hz), P(-hx, y1, -hz), P(hx, y1, -hz), [-ez[0], 0, -ez[2]], col, [[0, 0], [sx * k, 0], [sx * k, sy * k], [0, sy * k]], mat);
    // +X 面
    this.quad(P(hx, y0, hz), P(hx, y0, -hz), P(hx, y1, -hz), P(hx, y1, hz), ex, col, [[0, 0], [sz * k, 0], [sz * k, sy * k], [0, sy * k]], mat);
    // −X 面
    this.quad(P(-hx, y0, -hz), P(-hx, y0, hz), P(-hx, y1, hz), P(-hx, y1, -hz), [-ex[0], 0, -ex[2]], col, [[0, 0], [sz * k, 0], [sz * k, sy * k], [0, sy * k]], mat);
    // 顶
    this.quad(P(-hx, y1, hz), P(hx, y1, hz), P(hx, y1, -hz), P(-hx, y1, -hz), [0, 1, 0], top, [[0, 0], [sx * k, 0], [sx * k, sz * k], [0, sz * k]], mat);
    if (!skipBottom) this.quad(P(-hx, y0, -hz), P(hx, y0, -hz), P(hx, y0, hz), P(-hx, y0, hz), [0, -1, 0], col, [[0, 0], [sx, 0], [sx, sz], [0, sz]], mat);
  }
  /** 合并另一个缓冲 */
  append(o) {
    const base = this.n;
    for (let i = 0; i < o.P.length; i++) this.P.push(o.P[i]);
    for (let i = 0; i < o.N.length; i++) this.N.push(o.N[i]);
    for (let i = 0; i < o.C.length; i++) this.C.push(o.C[i]);
    for (let i = 0; i < o.U.length; i++) this.U.push(o.U[i]);
    for (let i = 0; i < o.M.length; i++) this.M.push(o.M[i]);
    for (let i = 0; i < o.I.length; i++) this.I.push(o.I[i] + base);
    this.n += o.n;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.M, 1));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * 沿折线的条带（顶面 + 可选两侧立面），断面在每个折点按角平分线展开（不开裂）。
 * pts: [{x,z}]（已重采样），hw 半宽，yFn(x,z, side) 顶面高度，opts: {mat, col, side (立面下沿高度函数，null 不画), uvLen}
 */
export function strip(buf, pts, hwL, hwR, yFn, { mat, col, sideCol = col, sideDown = null, u0 = 0, vScale = 1 } = {}) {
  const n = pts.length;
  if (n < 2) return;
  const L = [], R = [];
  let s = u0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    // 左法线 (tz, −tx)… 统一：左 = (−tz, tx)
    let nx = -tz, nz = tx;
    // 折点处按角平分线放宽，限制 1.8 倍
    if (i > 0 && i < n - 1) {
      const ax = p.x - a.x, az = p.z - a.z, al = Math.hypot(ax, az) || 1;
      const k = Math.min(1.8, 1 / Math.max(0.55, (nx * -az + nz * ax) / al || 1));
      nx *= k; nz *= k;
    }
    if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    const lx = p.x + nx * hwL, lz = p.z + nz * hwL, rx = p.x - nx * hwR, rz = p.z - nz * hwR;
    L.push([lx, yFn(lx, lz, 1, i), lz, s]);
    R.push([rx, yFn(rx, rz, -1, i), rz, s]);
  }
  const W = hwL + hwR;
  for (let i = 0; i + 1 < n; i++) {
    const a = L[i], b = L[i + 1], c = R[i + 1], d = R[i];
    // 顶面（从上看逆时针：R_i → R_i+1 → L_i+1 → L_i）
    buf.quadN([d[0], d[1], d[2]], [c[0], c[1], c[2]], [b[0], b[1], b[2]], [a[0], a[1], a[2]], [0, 1, 0], col,
      [[d[3], 0], [c[3], 0], [b[3], W * vScale], [a[3], W * vScale]], mat);
    if (sideDown) {
      for (const [p, q, sg] of [[a, b, 1], [d, c, -1]]) {
        const yp = sideDown(p[0], p[2], p[1]), yq = sideDown(q[0], q[2], q[1]);
        const ox = (q[2] - p[2]) * -sg, oz = (q[0] - p[0]) * sg;
        buf.quadN([p[0], yp, p[2]], [q[0], yq, q[2]], [q[0], q[1], q[2]], [p[0], p[1], p[2]], [ox, 0, oz], sideCol,
          [[p[3], 0], [q[3], 0], [q[3], q[1] - yq], [p[3], p[1] - yp]], mat);
      }
    }
  }
}

/** 折线按步长重采样（保留拐点），返回 [{x,z}] */
export function resamplePts(p, step) {
  const out = [];
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.05) continue;
    const k = Math.max(1, Math.ceil(L / step));
    for (let j = out.length ? 1 : 0; j <= k; j++) out.push({ x: ax + ((bx - ax) * j) / k, z: az + ((bz - az) * j) / k });
  }
  return out;
}
