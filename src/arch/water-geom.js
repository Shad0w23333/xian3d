// 水系几何工具（water 模块专用）：多边形清洗/异常剔除、耳切三角化 + 最长边二分细化、
// 离岸距离（排除 2400 m 数据分块产生的“人工切边”）、河道条带、护城河石砌压顶与栏杆。
import * as THREE from 'three';

export const TILE = 2400; // water.json 大河按 2400 m 网格切块（见数据管线），切边不是岸线

/** 清洗环：去非数、去连续重复点与闭合重复点；返回 [x,z,...] 或 null */
export function cleanRing(arr) {
  if (!arr || arr.length < 6) return null;
  const out = [];
  for (let i = 0; i + 1 < arr.length; i += 2) {
    const x = +arr[i], z = +arr[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const n = out.length;
    if (n && Math.abs(out[n - 2] - x) < 0.05 && Math.abs(out[n - 1] - z) < 0.05) continue;
    out.push(x, z);
  }
  const n = out.length;
  if (n >= 4 && Math.abs(out[0] - out[n - 2]) < 0.05 && Math.abs(out[1] - out[n - 1]) < 0.05) out.length = n - 2;
  return out.length >= 6 ? out : null;
}

/** 带符号面积（x,z 平面 shoelace；>0 为 CCW） */
export function ringArea(p) {
  let s = 0;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) s += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return s / 2;
}

export function ringBBox(p) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i], z = p[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}

const onGrid = (v) => Math.abs(v - Math.round(v / TILE) * TILE) < 0.3;
/** 线段是否落在数据分块网格线上（人工切边） */
export function isTileEdge(ax, az, bx, bz) {
  return (Math.abs(ax - bx) < 0.3 && onGrid(ax) && onGrid(bx)) || (Math.abs(az - bz) < 0.3 && onGrid(az) && onGrid(bz));
}

/** 点在多边形内（含洞） */
export function inPoly(x, z, rings) {
  let c = false;
  for (const p of rings) {
    for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
      const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
  }
  return c;
}

/**
 * 三角化 + 细化。rings[0] 为外环，其余为洞。
 * 细化规则：边长 > maxEdge 的边、以及连接两个岸线点但本身不是岸线的“对角线”（否则窄水面整片都是 d=0）一律二分；
 * 采用“最长待分边”二分，边中点共享缓存，最多 maxTris 个三角形。
 * 返回 { xs, zs, bnd(Uint8Array 岸点标记), tris(Uint32Array) }
 */
export function triangulate(rings, maxEdge, maxTris = 120000) {
  const contour = [], holes = [];
  const xs = [], zs = [], bnd = [];
  const bEdges = new Set();
  const key = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  rings.forEach((p, ri) => {
    const arr = [];
    const base = xs.length;
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      arr.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
      xs.push(p[i * 2]); zs.push(p[i * 2 + 1]); bnd.push(1);
      bEdges.add(key(base + i, base + ((i + 1) % n)));
    }
    if (ri === 0) contour.push(...arr); else holes.push(arr);
  });
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch (e) {
    return null;
  }
  const mid = new Map();
  const midpoint = (a, b) => {
    const k = key(a, b);
    let m = mid.get(k);
    if (m !== undefined) return m;
    m = xs.length;
    xs.push((xs[a] + xs[b]) / 2); zs.push((zs[a] + zs[b]) / 2);
    const onB = bEdges.has(k);
    bnd.push(onB ? 1 : 0);
    if (onB) { bEdges.add(key(a, m)); bEdges.add(key(m, b)); }
    mid.set(k, m);
    return m;
  };
  const me2 = maxEdge * maxEdge;
  const need = (a, b) => {
    const dx = xs[b] - xs[a], dz = zs[b] - zs[a], l2 = dx * dx + dz * dz;
    if (l2 > me2) return l2;
    if (bnd[a] && bnd[b] && l2 > 2.25 && !bEdges.has(key(a, b))) return l2;
    return 0;
  };
  const out = [];
  const stack = [];
  for (const f of faces) stack.push(f[0], f[1], f[2]);
  let budget = maxTris;
  while (stack.length) {
    const c = stack.pop(), b = stack.pop(), a = stack.pop();
    if (budget <= 0) { out.push(a, b, c); continue; }
    const lab = need(a, b), lbc = need(b, c), lca = need(c, a);
    if (!lab && !lbc && !lca) { out.push(a, b, c); continue; }
    budget--;
    if (lab >= lbc && lab >= lca) { const m = midpoint(a, b); stack.push(a, m, c, m, b, c); }
    else if (lbc >= lca) { const m = midpoint(b, c); stack.push(b, m, a, m, c, a); }
    else { const m = midpoint(c, a); stack.push(c, m, b, m, a, b); }
  }
  // 统一为法线朝上（x,z 平面顺时针 = 从 +Y 俯视逆时针）
  for (let i = 0; i < out.length; i += 3) {
    const a = out[i], b = out[i + 1], c = out[i + 2];
    const cy = (zs[b] - zs[a]) * (xs[c] - xs[a]) - (xs[b] - xs[a]) * (zs[c] - zs[a]);
    if (cy < 0) { out[i + 1] = c; out[i + 2] = b; }
  }
  return { xs, zs, bnd: Uint8Array.from(bnd), tris: Uint32Array.from(out) };
}

/** 岸线线段（排除网格切边）；返回 Float64Array [ax,az,bx,bz,...] */
export function shoreSegments(rings, extra = null) {
  const seg = [];
  for (const p of rings) {
    for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
      const ax = p[j * 2], az = p[j * 2 + 1], bx = p[i * 2], bz = p[i * 2 + 1];
      if (isTileEdge(ax, az, bx, bz)) continue;
      if (extra && extra(ax, az, bx, bz)) continue;
      seg.push(ax, az, bx, bz);
    }
  }
  return Float64Array.from(seg);
}

/**
 * 离岸距离场：线段分桶（cell 米），查询半径 cap 以内的最近距离，超出返回 cap。
 */
export class ShoreDistance {
  constructor(seg, cap = 80, cell = 64) {
    this.seg = seg; this.cap = cap; this.cell = cell;
    this.grid = new Map();
    for (let s = 0; s < seg.length; s += 4) {
      const x0 = Math.min(seg[s], seg[s + 2]) - cap, x1 = Math.max(seg[s], seg[s + 2]) + cap;
      const z0 = Math.min(seg[s + 1], seg[s + 3]) - cap, z1 = Math.max(seg[s + 1], seg[s + 3]) + cap;
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
        for (let cz = Math.floor(z0 / cell); cz <= Math.floor(z1 / cell); cz++) {
          const k = cx * 1000003 + cz;
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(s);
        }
    }
  }
  at(x, z) {
    const l = this.grid.get(Math.floor(x / this.cell) * 1000003 + Math.floor(z / this.cell));
    if (!l) return this.cap;
    const s = this.seg;
    let best = this.cap * this.cap;
    for (const i of l) {
      const ax = s[i], az = s[i + 1], dx = s[i + 2] - ax, dz = s[i + 3] - az;
      const l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - ax) * dx + (z - az) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - x, ez = az + dz * t - z, d = ex * ex + ez * ez;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
}

/** 折线按步长重采样，返回 [{x,z,tx,tz}] */
export function resampleLine(p, step) {
  const pts = [];
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) continue;
    const n = Math.max(1, Math.ceil(len / step));
    for (let j = pts.length ? 1 : 0; j <= n; j++) {
      const t = j / n;
      pts.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / len, tz: (bz - az) / len });
    }
  }
  return pts;
}

/**
 * 护城河石砌压顶 + 栏杆。edges: [{ax,az,bx,bz,ox,oz}]（o = 朝外单位法线）；yAt(x,z) 水面高；ground(x,z) 地面高
 * 返回 { coping: BufferGeometry, rail: BufferGeometry }
 */
export function moatEdgeGeometry(edges, yAt, ground) {
  const cp = [], cn = [], cu = [], rp = [], rn = [], ru = [];
  const W = 0.7, TOP = 0.55, RH = 1.05;
  const quad = (P, N, U, a, b, c, d, n, ua, ub, va, vb) => {
    // a,b 底边两端，c 在 a 上方、d 在 b 上方；自动按期望法线 n 调整绕序
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const A = [a, ua, va], B = [b, ub, va], C = [c, ua, vb], D = [d, ub, vb];
    const tris = cx * n[0] + cy * n[1] + cz * n[2] >= 0 ? [A, B, D, A, D, C] : [A, D, B, A, C, D];
    for (const [v, u, w] of tris) { P.push(v[0], v[1], v[2]); N.push(n[0], n[1], n[2]); U.push(u, w); }
  };
  let run = 0;
  for (const e of edges) {
    const len = Math.hypot(e.bx - e.ax, e.bz - e.az);
    const ya = yAt(e.ax, e.az), yb = yAt(e.bx, e.bz);
    const ta = ya + TOP, tb = yb + TOP;
    const oax = e.ax + e.ox * W, oaz = e.az + e.oz * W, obx = e.bx + e.ox * W, obz = e.bz + e.oz * W;
    const ga = Math.min(ground(oax, oaz), ya) - 0.3, gb = Math.min(ground(obx, obz), yb) - 0.3;
    // 内侧立面（朝水面，法线 = -o）
    quad(cp, cn, cu, [e.ax, ya - 0.4, e.az], [e.bx, yb - 0.4, e.bz], [e.ax, ta, e.az], [e.bx, tb, e.bz], [-e.ox, 0, -e.oz], run, run + len, 0, TOP + 0.4);
    // 顶面
    quad(cp, cn, cu, [e.ax, ta, e.az], [e.bx, tb, e.bz], [oax, ta, oaz], [obx, tb, obz], [0, 1, 0], run, run + len, 0, W);
    // 外侧立面（法线 = +o）
    quad(cp, cn, cu, [oax, ga, oaz], [obx, gb, obz], [oax, ta, oaz], [obx, tb, obz], [e.ox, 0, e.oz], run, run + len, 0, TOP + 0.6);
    // 栏杆（压顶中线，双面）
    const rax = e.ax + e.ox * W * 0.5, raz = e.az + e.oz * W * 0.5, rbx = e.bx + e.ox * W * 0.5, rbz = e.bz + e.oz * W * 0.5;
    quad(rp, rn, ru, [rax, ta, raz], [rbx, tb, rbz], [rax, ta + RH, raz], [rbx, tb + RH, rbz], [-e.ox, 0, -e.oz], run / 2.0, (run + len) / 2.0, 0, 1);
    run += len;
  }
  const mk = (P, N, U) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    return g;
  };
  return { coping: mk(cp, cn, cu), rail: mk(rp, rn, ru) };
}

/** 石栏杆贴图（望柱 + 上下枋 + 镂空寻杖栏板），alphaTest 用 */
export function railingTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 128);
  const stone = '#8d8a84', dark = '#6f6c67';
  g.fillStyle = stone;
  g.fillRect(0, 0, 26, 128); // 望柱
  g.fillRect(0, 0, 30, 14); // 柱头
  g.fillRect(0, 12, 256, 12); // 扶手
  g.fillRect(0, 108, 256, 20); // 地栿
  g.fillRect(26, 52, 230, 10); // 中枋
  // 栏板镂空：竖向瓶式小柱
  for (let x = 44; x < 250; x += 22) {
    g.fillRect(x, 24, 8, 28);
    g.fillRect(x - 2, 62, 12, 46);
  }
  g.fillStyle = dark;
  g.fillRect(0, 22, 256, 2); g.fillRect(0, 106, 256, 2); g.fillRect(24, 0, 2, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
