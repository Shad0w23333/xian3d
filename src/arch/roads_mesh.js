// roads 模块几何构建：可增长类型化数组写入器、折线分段采样、路面/人行道/铁路/桥梁剖面挤出。
// 约定：横向坐标 o 以“行进方向左侧为正”（世界位置 = 中心 - 右法线 * o），
// 剖面按 (o, y) 平面顺时针排列时，挤出面的法线朝外（见 emitProfile）。
import * as THREE from 'three';

const DET0 = [0, 0, 0, 0];

// ---------------- 路面写入器（统一着色器用） ----------------
export class SurfWriter {
  constructor(cap = 8192) {
    this.n = 0;
    this.ni = 0;
    this._alloc(cap, cap * 3);
  }
  _alloc(cap, icap) {
    const o = this;
    const grow = (Old, len, T) => {
      const a = new T(len);
      if (Old) a.set(Old.subarray(0, Math.min(Old.length, len)));
      return a;
    };
    o.cap = cap;
    o.pos = grow(o.pos, cap * 3, Float32Array);
    o.nor = grow(o.nor, cap * 3, Int8Array);
    o.uv = grow(o.uv, cap * 2, Float32Array);
    o.road = grow(o.road, cap * 4, Uint16Array);
    o.junc = grow(o.junc, cap * 4, Uint16Array);
    o.det = grow(o.det, cap * 4, Uint8Array);
    o.icap = icap;
    o.idx = grow(o.idx, icap, Uint32Array);
  }
  ensure(nv, ni) {
    if (this.n + nv > this.cap || this.ni + ni > this.icap) this._alloc(Math.max(this.cap * 2, this.n + nv + 1024), Math.max(this.icap * 2, this.ni + ni + 4096));
  }
  /**
   * 写入一个顶点；attr = [kind, lanes|灯距<<4|亮度<<10, flags, widthCm]，junc = [距边起点, 距边终点, R0, R1]（米，按分米存 Uint16），
   * det = 细节通道 [0..255]×4（可省）：人行道 [缘石坡道权重, 标线位, 坡道类型, 0]；沥青 [0, 标线位, 起点端转向, 终点端转向]
   */
  v(x, y, z, nx, ny, nz, u, w, attr, junc, det = DET0) {
    const i = this.n++;
    const p = this.pos, q = this.nor, t = this.uv, r = this.road, j = this.junc, d = this.det;
    d[i * 4] = det[0]; d[i * 4 + 1] = det[1]; d[i * 4 + 2] = det[2]; d[i * 4 + 3] = det[3];
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    q[i * 3] = nx * 127; q[i * 3 + 1] = ny * 127; q[i * 3 + 2] = nz * 127;
    t[i * 2] = u; t[i * 2 + 1] = w;
    r[i * 4] = attr[0]; r[i * 4 + 1] = attr[1]; r[i * 4 + 2] = attr[2]; r[i * 4 + 3] = attr[3];
    j[i * 4] = Math.min(65535, Math.max(0, junc[0] * 10)); j[i * 4 + 1] = Math.min(65535, Math.max(0, junc[1] * 10));
    j[i * 4 + 2] = Math.min(65535, junc[2] * 10); j[i * 4 + 3] = Math.min(65535, junc[3] * 10);
    return i;
  }
  tri(a, b, c) {
    const k = this.ni;
    this.idx[k] = a; this.idx[k + 1] = b; this.idx[k + 2] = c;
    this.ni += 3;
  }
  geometry() {
    if (!this.ni) return null;
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3, true));
    g.setAttribute('aUV', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    g.setAttribute('aRoad', new THREE.BufferAttribute(this.road.slice(0, n * 4), 4, false));
    g.setAttribute('aJunc', new THREE.BufferAttribute(this.junc.slice(0, n * 4), 4));
    g.setAttribute('aDet', new THREE.BufferAttribute(this.det.slice(0, n * 4), 4, false));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.ni), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------- 结构写入器（桥梁/路堤：标准材质 + 顶点色） ----------------
export class StructWriter {
  constructor(cap = 8192) {
    this.n = 0;
    this.ni = 0;
    this._alloc(cap, cap * 3);
  }
  _alloc(cap, icap) {
    const grow = (Old, len, T) => {
      const a = new T(len);
      if (Old) a.set(Old.subarray(0, Math.min(Old.length, len)));
      return a;
    };
    this.cap = cap;
    this.pos = grow(this.pos, cap * 3, Float32Array);
    this.nor = grow(this.nor, cap * 3, Int8Array);
    this.uv = grow(this.uv, cap * 2, Float32Array);
    this.col = grow(this.col, cap * 4, Uint8Array);
    this.icap = icap;
    this.idx = grow(this.idx, icap, Uint32Array);
  }
  ensure(nv, ni) {
    if (this.n + nv > this.cap || this.ni + ni > this.icap) this._alloc(Math.max(this.cap * 2, this.n + nv + 1024), Math.max(this.icap * 2, this.ni + ni + 4096));
  }
  /** col = [r,g,b,glow] 0..255 */
  v(x, y, z, nx, ny, nz, u, w, col) {
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.nor[i * 3] = nx * 127; this.nor[i * 3 + 1] = ny * 127; this.nor[i * 3 + 2] = nz * 127;
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = w;
    this.col[i * 4] = col[0]; this.col[i * 4 + 1] = col[1]; this.col[i * 4 + 2] = col[2]; this.col[i * 4 + 3] = col[3];
    return i;
  }
  tri(a, b, c) {
    const k = this.ni;
    this.idx[k] = a; this.idx[k + 1] = b; this.idx[k + 2] = c;
    this.ni += 3;
  }
  geometry() {
    if (!this.ni) return null;
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col.slice(0, n * 4), 4, true));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.ni), 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------- 折线分段采样 ----------------
/**
 * 在折线 p（累计里程 ch）的 [sA, sB] 区间生成断面：包含折线顶点、网格线交点（grid:{x0,z0,T}）、
 * 以及按 stepFn(s) 细分（stepFn 返回该处最大步长）。
 * 返回 {n, x, z, s, rx, rz}：rx,rz 为带斜接缩放的右法线（单位长度 * 1/cos(半角)）。
 */
export function sampleSections(p, ch, sA, sB, stepFn, grid = null) {
  const X = [], Z = [], S = [], RX = [], RZ = [];
  const nP = p.length / 2;
  if (sB - sA < 0.2) return null;
  // 找起点所在段
  let i = 0;
  while (i < nP - 2 && ch[i + 1] <= sA) i++;
  const segDir = (k) => {
    const dx = p[k * 2 + 2] - p[k * 2], dz = p[k * 2 + 3] - p[k * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const push = (x, z, s, dx, dz, miter) => {
    X.push(x); Z.push(z); S.push(s);
    let rx = -dz, rz = dx;
    if (miter) {
      rx *= miter; rz *= miter;
    }
    RX.push(rx); RZ.push(rz);
  };
  const pointAt = (k, s) => {
    const L = ch[k + 1] - ch[k] || 1;
    const t = (s - ch[k]) / L;
    return [p[k * 2] + (p[k * 2 + 2] - p[k * 2]) * t, p[k * 2 + 1] + (p[k * 2 + 3] - p[k * 2 + 1]) * t];
  };
  let s = sA;
  {
    const [x, z] = pointAt(i, s);
    const [dx, dz] = segDir(i);
    push(x, z, s, dx, dz, 0);
  }
  while (s < sB - 1e-3) {
    // 本段终点
    const segEnd = Math.min(ch[i + 1], sB);
    const [dx, dz] = segDir(i);
    // 网格交点
    let nextGrid = Infinity;
    if (grid) {
      const [x0, z0] = pointAt(i, s);
      const T = grid.T;
      if (Math.abs(dx) > 1e-6) {
        const gx = dx > 0 ? Math.floor((x0 - grid.x0) / T + 1e-6) + 1 : Math.ceil((x0 - grid.x0) / T - 1e-6) - 1;
        const t = (grid.x0 + gx * T - x0) / dx;
        if (t > 0.05) nextGrid = Math.min(nextGrid, s + t);
      }
      if (Math.abs(dz) > 1e-6) {
        const gz = dz > 0 ? Math.floor((z0 - grid.z0) / T + 1e-6) + 1 : Math.ceil((z0 - grid.z0) / T - 1e-6) - 1;
        const t = (grid.z0 + gz * T - z0) / dz;
        if (t > 0.05) nextGrid = Math.min(nextGrid, s + t);
      }
    }
    const step = stepFn(s);
    let target = Math.min(segEnd, nextGrid, s + step);
    // 避免产生过短的尾段
    if (target < segEnd && segEnd - target < step * 0.25 && nextGrid > segEnd) target = segEnd;
    if (target - s < 0.05) target = Math.min(segEnd, s + 0.05);
    s = target;
    const [x, z] = pointAt(i, s);
    if (s >= ch[i + 1] - 1e-4 && i < nP - 2 && s < sB - 1e-3) {
      // 折点：斜接
      const [ex, ez] = segDir(i + 1);
      let mx = dx + ex, mz = dz + ez;
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-3) { mx = dx; mz = dz; } else { mx /= ml; mz /= ml; }
      const cosHalf = Math.max(0.55, mx * dx + mz * dz);
      push(p[(i + 1) * 2], p[(i + 1) * 2 + 1], s, mx, mz, 1 / cosHalf);
      i++;
    } else {
      push(x, z, s, dx, dz, 0);
      if (s >= ch[i + 1] - 1e-4 && i < nP - 2) i++;
    }
  }
  const n = X.length;
  if (n < 2) return null;
  return { n, x: Float64Array.from(X), z: Float64Array.from(Z), s: Float64Array.from(S), rx: Float32Array.from(RX), rz: Float32Array.from(RZ) };
}

/**
 * 通用剖面挤出。secs: 断面数组；profile: [{o0,y0,o1,y1}]（相对量，顺时针顺序）；
 * yAt(i, o) 返回断面 i 在横向 o 处的基准高度；emitV(writer, x,y,z, nx,ny,nz, u, v, segIndex) 写顶点；
 * valid(i) 断面是否有效（无效则断开）。
 */
export function extrude(secs, iA, iB, profile, yAt, emitV, W, valid = null) {
  const segs = profile.length;
  const nSec = iB - iA + 1;
  if (nSec < 2) return;
  W.ensure(nSec * segs * 2, (nSec - 1) * segs * 6);
  let prevBase = -1;
  for (let i = iA; i <= iB; i++) {
    const ok = !valid || valid(i);
    if (!ok) { prevBase = -1; continue; }
    const cx = secs.x[i], cz = secs.z[i];
    const rx = secs.rx[i], rz = secs.rz[i];
    const rl = Math.hypot(rx, rz) || 1;
    const ux = rx / rl, uz = rz / rl;
    const base = W.n;
    for (let k = 0; k < segs; k++) {
      const pr = profile[k];
      // 顺时针剖面：法线 = 切向逆时针旋转 90°
      const tO = pr.o1 - pr.o0, tY = (pr.y1 - pr.y0);
      let no = -tY, ny = tO;
      const nl = Math.hypot(no, ny) || 1;
      no /= nl; ny /= nl;
      if (pr.up) { no = 0; ny = 1; }
      // o 方向（向左）= -右法线
      const nx = -ux * no, nz = -uz * no;
      for (const [o, yo] of [[pr.o0, pr.y0], [pr.o1, pr.y1]]) {
        const x = cx - rx * o, z = cz - rz * o;
        const y = yAt(i, o, pr) + yo;
        emitV(W, x, y, z, nx, ny, nz, o, secs.s[i], k, pr);
      }
    }
    if (prevBase >= 0) {
      for (let k = 0; k < segs; k++) {
        const a0 = prevBase + k * 2, a1 = a0 + 1, b0 = base + k * 2, b1 = b0 + 1;
        W.tri(a0, b0, a1);
        W.tri(a1, b0, b1);
      }
    }
    prevBase = base;
  }
}
