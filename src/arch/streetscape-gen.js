// streetscape 模块的几何生成：街道断面带（花池/人行道/非机动车道/草坪）、公交候车亭、铺装广场与小品、
// 地面停车场（车位线 + 停放车辆）、落客车道、围墙与大门、路口信号灯、回坊街边摊位与灯笼串。
// 全部程序化（Canvas 贴图 + 盒子/条带几何），按材质合并，重复小品实例化。坐标：世界坐标米（X 东、Z 南、Y 海拔）。
import * as THREE from 'three';
import { chainage, roadY } from '../core/roadheight.js';
import { CFG } from './roads_net.js';
import { pointInPoly, polyBBox, rectPoly, toShape } from '../core/util.js';
import { canvas as mkCanvas, rng as mkRng } from '../core/textures.js';
import { lanternGroup, groundGlow } from './streetscape-lantern.js';

const D2R = Math.PI / 180;
const _ax = { ux: 1, uz: 0, vx: 0, vz: 1 };
/** 偏航角 → 局部 +X 方向 (ux,uz) 与局部 +Z（右法线）(vx,vz)；角度：0 = 东，逆时针为正 */
function axes(yaw) {
  _ax.ux = Math.cos(yaw); _ax.uz = -Math.sin(yaw);
  _ax.vx = -_ax.uz; _ax.vz = _ax.ux;
  return _ax;
}
const yawOf = (dx, dz) => Math.atan2(-dz, dx);
const hash01 = (i, j = 0, k = 0) => {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ───────────────────────── Canvas 贴图 ─────────────────────────
function tex(c, { repeat = 1, srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(repeat, repeat);
  return t;
}
function noiseRect(g, w, h, r, amp, n = 1800) {
  for (let i = 0; i < n; i++) {
    const v = (r() - 0.5) * amp;
    g.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`;
    g.fillRect(r() * w, r() * h, 2 + r() * 10, 2 + r() * 10);
  }
}
/** 方砖人行道（1 m 重复：0.5 m 灰砖，双色随机） */
function pavingTiles(seed, a = '#8d8a84', b = '#7c7a75', cells = 2, size = 256) {
  const c = mkCanvas(size), g = c.getContext('2d'), r = mkRng(seed);
  const s = size / cells;
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < cells; j++) {
      g.fillStyle = r() < 0.5 ? a : b;
      g.fillRect(i * s, j * s, s, s);
      g.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.08})`;
      g.fillRect(i * s, j * s, s, s);
    }
  noiseRect(g, size, size, r, 28, 900);
  g.strokeStyle = 'rgba(40,38,36,0.55)';
  g.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, size); g.stroke();
    g.beginPath(); g.moveTo(0, i * s); g.lineTo(size, i * s); g.stroke();
  }
  return c;
}
/** 广场花岗岩（2 m 重复：大板 + 深色分隔条） */
function pavingGranite(seed) {
  const size = 256, c = mkCanvas(size), g = c.getContext('2d'), r = mkRng(seed);
  g.fillStyle = '#a39d93';
  g.fillRect(0, 0, size, size);
  const s = size / 4;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const t = r();
      g.fillStyle = t < 0.25 ? '#8e8679' : t < 0.5 ? '#b0aaa0' : t < 0.75 ? '#9d9389' : '#a9a299';
      g.fillRect(i * s, j * s, s, s);
    }
  noiseRect(g, size, size, r, 22, 1200);
  g.fillStyle = '#5d564f';
  g.fillRect(0, size / 2 - 5, size, 10);
  g.fillRect(size / 2 - 5, 0, 10, size);
  g.strokeStyle = 'rgba(50,46,42,0.5)';
  g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, size); g.stroke();
    g.beginPath(); g.moveTo(0, i * s); g.lineTo(size, i * s); g.stroke();
  }
  return c;
}
function noiseMap(seed, base = '#808080', amp = 40) {
  const size = 256, c = mkCanvas(size), g = c.getContext('2d'), r = mkRng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  noiseRect(g, size, size, r, amp, 2600);
  return c;
}
function hedgeMap(seed) {
  const size = 256, c = mkCanvas(size), g = c.getContext('2d'), r = mkRng(seed);
  g.fillStyle = '#2f5a24';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const t = r();
    g.fillStyle = t < 0.3 ? '#3f7a2c' : t < 0.6 ? '#2a4f1e' : t < 0.8 ? '#4d8a34' : '#223f18';
    g.beginPath();
    g.ellipse(r() * size, r() * size, 3 + r() * 6, 2 + r() * 4, r() * 3.14, 0, 6.3);
    g.fill();
  }
  return c;
}
function leafCard(seed) {
  const size = 256, c = mkCanvas(size), g = c.getContext('2d'), r = mkRng(seed);
  g.clearRect(0, 0, size, size);
  for (let i = 0; i < 160; i++) {
    const x = size * (0.15 + r() * 0.7), y = size * (0.08 + r() * 0.78);
    const d = Math.hypot(x - size / 2, y - size * 0.45) / (size * 0.42);
    if (d > 1) continue;
    const t = r();
    g.fillStyle = t < 0.35 ? '#3a6f2a' : t < 0.7 ? '#4f8a35' : t < 0.88 ? '#2c5520' : '#6aa244';
    g.beginPath();
    g.ellipse(x, y, 7 + r() * 13, 5 + r() * 9, r() * 3.14, 0, 6.3);
    g.fill();
  }
  return c;
}
function barsMap() {
  const c = mkCanvas(128, 64), g = c.getContext('2d');
  g.clearRect(0, 0, 128, 64);
  g.fillStyle = '#20232a';
  for (let i = 0; i < 8; i++) g.fillRect(i * 16 + 6, 0, 3, 64);
  g.fillRect(0, 4, 128, 3);
  g.fillRect(0, 56, 128, 3);
  return c;
}
function stripesMap(a, b) {
  const c = mkCanvas(128, 128), g = c.getContext('2d');
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? a : b;
    g.fillRect(i * 16, 0, 16, 128);
  }
  return c;
}
function posterMap(i) {
  const c = mkCanvas(256, 384), g = c.getContext('2d');
  const P = [
    ['#1d5fa8', '#56b0f0', '未央 · 城市新客厅', '#ffffff'],
    ['#b3242b', '#f07a4a', '西安欢迎您', '#fff3d6'],
    ['#2b7a4b', '#8fd46a', '绿色出行 低碳生活', '#ffffff'],
    ['#4a2d8c', '#b58cff', '曲江 · 千年诗意', '#ffe9a8'],
  ][i % 4];
  const gr = g.createLinearGradient(0, 0, 0, 384);
  gr.addColorStop(0, P[0]); gr.addColorStop(1, P[1]);
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 384);
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.beginPath(); g.arc(190, 110, 70, 0, 6.3); g.fill();
  g.fillStyle = P[3];
  g.font = '700 30px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  g.textAlign = 'center';
  g.fillText(P[2], 128, 300);
  g.font = '500 18px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  g.fillText('公益广告', 128, 340);
  return c;
}

/** 文字图集：固定 4 列 × 48 行网格（每格 256×40 px），(style, text) 条目各占一格；先建纹理占位，全部登记后 paint() 一次绘制 */
class NameAtlas {
  constructor() {
    this.items = new Map();
    this.list = [];
    this.cols = 4;
    this.rows = 48;
    this.cw = 256;
    this.ch = 40;
    this.canvas = mkCanvas(this.cols * this.cw, this.rows * this.ch);
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    this.texture = t;
  }
  add(style, text) {
    const k = style + '|' + text;
    if (!this.items.has(k)) { this.items.set(k, this.list.length); this.list.push([style, text]); }
    return this.items.get(k) % (this.cols * this.rows);
  }
  /** 第 i 格的 uv 区间 {u0,u1,v0,v1}（v0 为下边） */
  cell(i) {
    const col = i % this.cols, row = Math.floor(i / this.cols);
    return { u0: col / this.cols, u1: (col + 1) / this.cols, v1: 1 - row / this.rows, v0: 1 - (row + 1) / this.rows };
  }
  /** 四边形 uv（顺序：左下、右下、右上、左上），ua/ub 为格内横向比例（可反向用于背面） */
  quadUV(i, ua = 0, ub = 1) {
    const c = this.cell(i);
    const A = c.u0 + (c.u1 - c.u0) * ua, B = c.u0 + (c.u1 - c.u0) * ub;
    return [[A, c.v0], [B, c.v0], [B, c.v1], [A, c.v1]];
  }
  paint() {
    const g = this.canvas.getContext('2d');
    g.fillStyle = '#20232a';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const n = Math.min(this.list.length, this.cols * this.rows);
    for (let i = 0; i < n; i++) {
      const [style, text] = this.list[i];
      const x = (i % this.cols) * this.cw, y = Math.floor(i / this.cols) * this.ch;
      const S = { bus: ['#1f4f8f', '#ffffff'], gate: ['#f2ecdf', '#8a1d14'], stall: ['#d9262c', '#ffe79a'], stall2: ['#1d3f8a', '#ffffff'], stall3: ['#1f8a3d', '#ffffff'] }[style] || ['#333333', '#ffffff'];
      g.fillStyle = S[0];
      g.fillRect(x, y, this.cw, this.ch);
      g.fillStyle = S[1];
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const chars = [...text].length;
      const px = Math.min(26, Math.floor((this.cw - 16) / Math.max(1, chars)));
      g.font = `700 ${px}px "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif`;
      g.fillText(text, x + this.cw / 2, y + this.ch / 2 + 1);
    }
    this.texture.needsUpdate = true;
    return this.texture;
  }
}

// ───────────────────────── 几何写入器 ─────────────────────────
class GeoWriter {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.hasColor = false; }
  v(x, y, z, nx, ny, nz, u, v, col) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, v);
    if (col) { this.hasColor = true; this.c.push(col[0], col[1], col[2]); } else this.c.push(1, 1, 1);
    return this.p.length / 3 - 1;
  }
  /** 四边形 a b c d（逆时针看向法线），法线自动 */
  quad(a, b, c, d, uvs, col) {
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
    const fx = d[0] - a[0], fy = d[1] - a[1], fz = d[2] - a[2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const U = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
    this.v(a[0], a[1], a[2], nx, ny, nz, U[0][0], U[0][1], col);
    this.v(b[0], b[1], b[2], nx, ny, nz, U[1][0], U[1][1], col);
    this.v(c[0], c[1], c[2], nx, ny, nz, U[2][0], U[2][1], col);
    this.v(a[0], a[1], a[2], nx, ny, nz, U[0][0], U[0][1], col);
    this.v(c[0], c[1], c[2], nx, ny, nz, U[2][0], U[2][1], col);
    this.v(d[0], d[1], d[2], nx, ny, nz, U[3][0], U[3][1], col);
  }
  /** 盒子：中心 (cx,cy,cz)，尺寸 w(局部X) h(Y) d(局部Z)，偏航 yaw；uv 以米计 */
  box(cx, cy, cz, w, h, d, yaw, col, { top = true, bottom = false } = {}) {
    const A = axes(yaw);
    const P = (lx, ly, lz) => [cx + A.ux * lx + A.vx * lz, cy + ly, cz + A.uz * lx + A.vz * lz];
    const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2, z0 = -d / 2, z1 = d / 2;
    const U = (a, b) => [[0, 0], [a, 0], [a, b], [0, b]];
    // -Z 面（前）
    this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), U(w, h), col);
    // +Z 面（后）
    this.quad(P(x1, y0, z1), P(x0, y0, z1), P(x0, y1, z1), P(x1, y1, z1), U(w, h), col);
    // +X
    this.quad(P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0), U(d, h), col);
    // -X
    this.quad(P(x0, y0, z1), P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), U(d, h), col);
    if (top) this.quad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), U(w, d), col);
    if (bottom) this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y0, z0), P(x0, y0, z0), U(w, d), col);
  }
  /** 竖直圆柱（无盖可选） */
  cyl(cx, cy, cz, r0, r1, h, seg, col, { cap = true } = {}) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const a = [cx + c0 * r0, cy, cz + s0 * r0], b = [cx + c1 * r0, cy, cz + s1 * r0];
      const c = [cx + c1 * r1, cy + h, cz + s1 * r1], d = [cx + c0 * r1, cy + h, cz + s0 * r1];
      this.quad(b, a, d, c, [[0, 0], [0.3, 0], [0.3, h], [0, h]], col);
      if (cap) {
        const nc = [cx, cy + h, cz];
        this.v(nc[0], nc[1], nc[2], 0, 1, 0, 0, 0, col);
        this.v(d[0], d[1], d[2], 0, 1, 0, 0, 0, col);
        this.v(c[0], c[1], c[2], 0, 1, 0, 0, 0, col);
      }
    }
  }
  geometry() {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.hasColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** 实例收集器 */
class Inst {
  constructor() { this.m = []; this.col = []; }
  add(x, y, z, yaw, s = 1, col = null, sy = null) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, sy ?? s, s));
    this.m.push(m);
    this.col.push(col);
  }
  mesh(geo, mat, name, { shadow = true } = {}) {
    if (!this.m.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, this.m.length);
    for (let i = 0; i < this.m.length; i++) {
      im.setMatrixAt(i, this.m[i]);
      if (this.col[i]) im.setColorAt(i, this.col[i]);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = shadow;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.name = name;
    return im;
  }
}

// ───────────────────────── 道路索引 ─────────────────────────
function featureInfo(f) {
  const cfg = CFG[f.c] || CFG[7];
  const lanes = Math.max(1, Math.min(8, f.l | 0 || 1));
  let W = Number(f.w) || cfg.minW;
  if (!cfg.paving) W = Math.max(W, cfg.minW, lanes * (cfg.rank >= 8 ? 3.4 : 3.1));
  return { cfg, lanes, W: Math.min(W, 42) };
}
const inBox = (x, z, b) => x > b[0] && x < b[2] && z > b[1] && z < b[3];
export function roadIndex(roads, bbox) {
  const out = [];
  const feats = roads?.features || [];
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    if (!f.p || f.p.length < 4 || f.t) continue;
    let inside = false;
    for (let k = 0; k < f.p.length; k += 2) if (inBox(f.p[k], f.p[k + 1], bbox)) { inside = true; break; }
    if (!inside) continue;
    const info = featureInfo(f);
    const ch = chainage(f.p);
    out.push({ f, i, hw: info.W / 2, cfg: info.cfg, ch, total: ch[ch.length - 1], bb: polyBBox(f.p) });
  }
  return out;
}
/** 点到折线距离：返回 {d, s(里程), tx, tz} */
function distToLine(R, x, z) {
  const p = R.f.p;
  let best = Infinity, bs = 0, btx = 1, btz = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    const qx = ax + dx * t, qz = az + dz * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best) { best = d; bs = R.ch[i / 2] + Math.sqrt(L2) * t; const l = Math.sqrt(L2); btx = dx / l; btz = dz / l; }
  }
  return { d: best, s: bs, tx: btx, tz: btz };
}
/** 到其它道路车行道边缘的最小距离（排除 self 与同名要素） */
function clearance(idx, x, z, self, name) {
  let best = Infinity;
  for (const R of idx) {
    if (R === self) continue;
    if (name && R.f.n === name) continue;
    const b = R.bb;
    if (x < b.x0 - 60 || x > b.x1 + 60 || z < b.z0 - 60 || z > b.z1 + 60) continue;
    const d = distToLine(R, x, z).d - R.hw;
    if (d < best) best = d;
  }
  return best;
}
function pointOn(R, s) {
  const p = R.f.p, ch = R.ch;
  let i = 0;
  const n = p.length / 2;
  while (i < n - 2 && ch[i + 1] < s) i++;
  const L = ch[i + 1] - ch[i] || 1;
  const t = Math.max(0, Math.min(1, (s - ch[i]) / L));
  const dx = p[i * 2 + 2] - p[i * 2], dz = p[i * 2 + 3] - p[i * 2 + 1];
  const l = Math.hypot(dx, dz) || 1;
  return [p[i * 2] + dx * t, p[i * 2 + 1] + dz * t, dx / l, dz / l];
}

// ───────────────────────── 主生成器 ─────────────────────────
export class StreetscapeBuilder {
  constructor(ctx, mats, atlas) {
    this.ctx = ctx;
    this.M = mats;
    this.atlas = atlas;
    this.terrain = ctx.terrain;
    this.W = new Map(); // 材质键 -> GeoWriter
    this.I = {}; // 实例收集
    this.lightPts = [];
    this.lanternPts = []; // 灯笼串（[x,y,z,...]，灯身中心）
    this.smallLanterns = []; // 摊位棚角的小灯笼
    this.glowPts = []; // 夜间地面暖光斑 [x,y,z,直径,拉伸,偏航]
    this.stats = {};
  }
  w(key) { let w = this.W.get(key); if (!w) this.W.set(key, (w = new GeoWriter())); return w; }
  inst(key) { return this.I[key] || (this.I[key] = new Inst()); }
  count(k, n = 1) { this.stats[k] = (this.stats[k] || 0) + n; }
  /** 是否落在别的模块的占地上：用 trees 标志判断（地标/档案/回坊逐户轮廓都登记 trees:true；回坊的整片街区排除区只对低层通用建筑生效，不能拿来挡街上的物件） */
  excluded(x, z) { const E = this.ctx.exclusions; return E && E.items && E.items.length && E.test(x, z, 'trees'); }
  ground(x, z) { return this.terrain.heightAt(x, z); }

  // ---------- 街道断面带 ----------
  buildStreets(D, idx) {
    const plazas = (D.plazas || []).map((p) => p.poly);
    const inPlaza = (x, z) => plazas.some((p) => pointInPoly(x, z, p));
    for (const S of D.streets || []) {
      for (const R of idx) {
        const f = R.f;
        if (!S.name.test(f.n || '') || f.b) continue;
        const sides = this.sidesFor(S.side, R);
        for (const side of sides) {
          for (const B of S.bands) this.bandAlong(R, side, B, S, idx, inPlaza);
        }
      }
    }
  }
  sidesFor(side, R) {
    if (side === 'both') return [1, -1];
    if (side === 'R' || side === 'outer') return [1];
    if (side === 'L') return [-1];
    const dir = { E: [1, 0], W: [-1, 0], N: [0, -1], S: [0, 1] }[side];
    if (!dir) return [1];
    // 用要素中段的右法线判断哪一侧朝向给定世界方向
    const [, , dx, dz] = pointOn(R, R.total / 2);
    const rx = -dz, rz = dx;
    return [rx * dir[0] + rz * dir[1] >= 0 ? 1 : -1];
  }
  bandAlong(R, side, B, S, idx, inPlaza) {
    const f = R.f, hw = R.hw, bbox = S.bbox;
    const step = 2.0;
    const om = (B.o0 + B.o1) / 2;
    const minClear = B.kind === 'planter' ? 9 : 0.4;
    const run = [];
    const flush = () => {
      if (run.length >= 2) {
        const L = run[run.length - 1].s - run[0].s;
        if (L >= (B.kind === 'planter' ? 6 : 4)) this.emitBand(run, B, side, hw, R);
      }
      run.length = 0;
    };
    for (let s = 0; s <= R.total; s += step) {
      const [cx, cz, dx, dz] = pointOn(R, s);
      const rx = -dz * side, rz = dx * side;
      const qx = cx + rx * (hw + om), qz = cz + rz * (hw + om);
      let ok = inBox(qx, qz, bbox) && !inPlaza(qx, qz) && !this.excluded(qx, qz);
      if (ok) {
        const cl = clearance(idx, qx, qz, R, f.n);
        if (cl < minClear) ok = false;
        // 带的外缘也不能压到其它道路
        if (ok && B.kind !== 'planter') {
          const ox = cx + rx * (hw + B.o1), oz = cz + rz * (hw + B.o1);
          if (clearance(idx, ox, oz, R, f.n) < 0.3) ok = false;
        }
      }
      let y = null;
      if (ok) {
        y = roadY(this.terrain, f, cx, cz, s, R.total);
        if (y === null) ok = false;
      }
      if (!ok) { flush(); continue; }
      run.push({ s, cx, cz, rx, rz, dx, dz, y: y + 0.15 });
    }
    flush();
  }
  emitBand(run, B, side, hw, R) {
    const K = B.kind;
    const o0 = hw + B.o0, o1 = hw + B.o1;
    const L = run[run.length - 1].s - run[0].s;
    this.count('band_' + K);
    this.count('band_km', L / 1000);
    if (K === 'tiles' || K === 'bike' || K === 'grass') {
      const w = this.w(K === 'tiles' ? 'tiles' : K === 'bike' ? 'bike' : 'grass');
      const lift = K === 'grass' ? 0.02 : 0;
      let prev = null;
      for (const p of run) {
        const a = [p.cx + p.rx * o0, p.y + lift, p.cz + p.rz * o0], b = [p.cx + p.rx * o1, p.y + lift, p.cz + p.rz * o1];
        if (prev) {
          if (side > 0) w.quad(prev[0], prev[1], b, a, [[B.o0, prev[2]], [B.o1, prev[2]], [B.o1, p.s], [B.o0, p.s]]);
          else w.quad(prev[1], prev[0], a, b, [[B.o1, prev[2]], [B.o0, prev[2]], [B.o0, p.s], [B.o1, p.s]]);
        }
        prev = [a, b, p.s];
      }
      // 草坪带外缘小路缘
      if (K === 'grass') this.curbLine(run, o1, side, 0.12, 0.1);
      if (B.trees) this.treesAlong(run, hw + B.trees.o, B.trees.step, 0.1);
      if (B.trees2) this.treesAlong(run, hw + B.trees2.o, B.trees2.step, 0.1);
    } else if (K === 'planter') {
      // 抬高花池：石质路缘（内外两面 + 顶）+ 绿篱体 + 端头封口
      const cw = this.w('curb'), hw2 = this.w('hedge');
      const H = 0.35, HH = 0.95, inset = 0.14;
      let prev = null;
      const pts = (p, o, y) => [p.cx + p.rx * o, y, p.cz + p.rz * o];
      for (const p of run) {
        const yb = p.y - 0.45, yt = p.y + H;
        const cur = {
          i0: pts(p, o0, yb), i1: pts(p, o0, yt), o1: pts(p, o1, yt), o0: pts(p, o1, yb),
          h0: pts(p, o0 + inset, yt - 0.02), h1: pts(p, o0 + inset, p.y + HH), h2: pts(p, o1 - inset, p.y + HH), h3: pts(p, o1 - inset, yt - 0.02), s: p.s,
        };
        if (prev) {
          const u0 = prev.s, u1 = p.s;
          const sgn = side > 0;
          const q = (w, a, b, c, d, uv) => (sgn ? w.quad(a, b, c, d, uv) : w.quad(b, a, d, c, [uv[1], uv[0], uv[3], uv[2]]));
          // 内侧立面（朝车行道）
          q(cw, prev.i1, prev.i0, cur.i0, cur.i1, [[u0, H], [u0, 0], [u1, 0], [u1, H]]);
          // 顶面
          q(cw, prev.i1, cur.i1, cur.o1, prev.o1, [[u0, 0], [u1, 0], [u1, B.o1 - B.o0], [u0, B.o1 - B.o0]]);
          // 外侧立面
          q(cw, prev.o0, prev.o1, cur.o1, cur.o0, [[u0, 0], [u0, H], [u1, H], [u1, 0]]);
          // 绿篱：内侧面、顶、外侧面
          q(hw2, prev.h1, prev.h0, cur.h0, cur.h1, [[u0, 1], [u0, 0], [u1, 0], [u1, 1]]);
          q(hw2, prev.h1, cur.h1, cur.h2, prev.h2, [[u0, 0], [u1, 0], [u1, 1.5], [u0, 1.5]]);
          q(hw2, prev.h3, prev.h2, cur.h2, cur.h3, [[u0, 0], [u0, 1], [u1, 1], [u1, 0]]);
        }
        prev = cur;
      }
      // 端头封口
      const cap = (p, flip) => {
        const yb = p.y - 0.45, yt = p.y + H;
        const a = pts(p, o0, yb), b = pts(p, o1, yb), c = pts(p, o1, yt), d = pts(p, o0, yt);
        if (flip !== side > 0) cw.quad(a, b, c, d, [[0, 0], [B.o1 - B.o0, 0], [B.o1 - B.o0, H], [0, H]]);
        else cw.quad(b, a, d, c, [[0, 0], [B.o1 - B.o0, 0], [B.o1 - B.o0, H], [0, H]]);
        const e = pts(p, o0 + inset, yt), g = pts(p, o1 - inset, yt), h = pts(p, o1 - inset, p.y + HH), i = pts(p, o0 + inset, p.y + HH);
        if (flip !== side > 0) hw2.quad(e, g, h, i, [[0, 0], [1, 0], [1, 1], [0, 1]]);
        else hw2.quad(g, e, i, h, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      };
      cap(run[0], true);
      cap(run[run.length - 1], false);
      if (B.trees) this.treesAlong(run, hw + B.trees.o, B.trees.step, H + 0.05);
    }
  }
  curbLine(run, o, side, h, w) {
    const cw = this.w('curb');
    let prev = null;
    for (const p of run) {
      const a = [p.cx + p.rx * (o - w), p.y + 0.02, p.cz + p.rz * (o - w)], b = [p.cx + p.rx * (o - w), p.y + h, p.cz + p.rz * (o - w)];
      const c = [p.cx + p.rx * o, p.y + h, p.cz + p.rz * o], d = [p.cx + p.rx * o, p.y + 0.02, p.cz + p.rz * o];
      if (prev) {
        if (side > 0) { cw.quad(prev[1], prev[0], a, b); cw.quad(prev[1], b, c, prev[2]); cw.quad(prev[3], prev[2], c, d); }
        else { cw.quad(prev[0], prev[1], b, a); cw.quad(b, prev[1], prev[2], c); cw.quad(prev[2], prev[3], d, c); }
      }
      prev = [a, b, c, d];
    }
  }
  treesAlong(run, o, step, dy) {
    const T = this.inst('tree');
    let next = run[0].s + step * 0.5;
    for (let i = 1; i < run.length; i++) {
      while (next <= run[i].s) {
        const t = (next - run[i - 1].s) / (run[i].s - run[i - 1].s || 1);
        const p = run[i - 1], q = run[i];
        const cx = p.cx + (q.cx - p.cx) * t, cz = p.cz + (q.cz - p.cz) * t;
        const rx = p.rx, rz = p.rz;
        const x = cx + rx * o, z = cz + rz * o;
        const h = hash01(Math.round(x * 7), Math.round(z * 7));
        if (h > 0.08 && !this.excluded(x, z)) {
          this.addTree(x, p.y + (q.y - p.y) * t + dy, z, 0.85 + h * 0.3);
        }
        next += step * (0.9 + 0.2 * hash01(Math.round(next)));
      }
    }
  }
  addTree(x, y, z, s = 1) {
    const h = hash01(Math.round(x * 3), Math.round(z * 3), 5);
    const col = new THREE.Color().setHSL(0.26 + h * 0.07, 0.42 + h * 0.2, 0.3 + h * 0.12);
    this.inst('tree').add(x, y, z, h * Math.PI * 2, s, col);
    this.inst('trunk').add(x, y, z, h * Math.PI * 2, s, null);
    this.count('tree');
  }

  // ---------- 公交候车亭 ----------
  buildBusStops(D, idx) {
    const seen = [];
    for (const st of D.busStops || []) {
      if (seen.some((o) => o.n === st.n && Math.hypot(o.x - st.x, o.z - st.z) < 35)) continue;
      seen.push(st);
      // 最近的主次干道（含支路）
      let best = null;
      for (const R of idx) {
        if (R.cfg.rank < 3 || R.cfg.paving) continue;
        const r = distToLine(R, st.x, st.z);
        if (r.d < 40 && (!best || r.d < best.d)) best = { R, ...r };
      }
      if (!best) continue;
      const R = best.R;
      const [cx, cz, dx, dz] = pointOn(R, best.s);
      const rx = -dz, rz = dx;
      // 单行（双幅路的一幅）：站台一定在外侧（右侧）；双向路按站点落在中心线哪一侧
      const side = R.f.o ? 1 : (st.x - cx) * rx + (st.z - cz) * rz >= 0 ? 1 : -1;
      const off = R.hw + 2.4;
      const x = cx + rx * side * off, z = cz + rz * side * off;
      if (this.excluded(x, z)) continue;
      const y = (roadY(this.terrain, R.f, cx, cz, best.s, R.total) ?? this.ground(cx, cz)) + 0.15;
      const yaw = yawOf(dx, dz) + (side < 0 ? Math.PI : 0);
      this.shelter(x, y, z, yaw, st.n);
      this.count('busStop');
    }
  }
  shelter(x, y, z, yaw, name) {
    const A = axes(yaw);
    const P = (lx, ly, lz) => [x + A.ux * lx + A.vx * lz, y + ly, z + A.uz * lx + A.vz * lz];
    const st = this.w('steel'), gl = this.w('glass'), dk = this.w('dark');
    const colS = [0.45, 0.47, 0.5];
    // 立柱（后排两根 + 前排两根细柱）
    for (const [lx, lz, r] of [[-2.1, 0.0, 0.07], [2.1, 0.0, 0.07], [-2.1, -1.5, 0.05], [2.1, -1.5, 0.05]]) {
      const p = P(lx, 0, lz);
      st.cyl(p[0], p[1], p[2], r, r, 2.75, 8, colS);
    }
    // 顶棚（前缘略低）
    {
      const a = P(-2.4, 2.75, 0.25), b = P(2.4, 2.75, 0.25), c = P(2.4, 2.6, -1.75), d = P(-2.4, 2.6, -1.75);
      const up = (v) => [v[0], v[1] + 0.09, v[2]];
      dk.quad(a, b, c, d, [[0, 0], [4.8, 0], [4.8, 2], [0, 2]]); // 底面
      dk.quad(up(d), up(c), up(b), up(a), [[0, 0], [4.8, 0], [4.8, 2], [0, 2]]); // 顶面
      dk.quad(d, c, up(c), up(d)); dk.quad(b, a, up(a), up(b)); dk.quad(a, d, up(d), up(a)); dk.quad(c, b, up(b), up(c));
    }
    // 背板玻璃（右半）与广告灯箱（左半）
    {
      const a = P(0.2, 0.45, 0.02), b = P(2.1, 0.45, 0.02), c = P(2.1, 2.6, 0.02), d = P(0.2, 2.6, 0.02);
      gl.quad(a, b, c, d); gl.quad(b, a, d, c);
      const i = Math.floor(hash01(Math.round(x), Math.round(z)) * 4);
      const pw = this.w('poster' + i);
      const e = P(-2.0, 0.45, 0.0), f = P(-0.2, 0.45, 0.0), g = P(-0.2, 2.6, 0.0), h = P(-2.0, 2.6, 0.0);
      pw.quad(f, e, h, g, [[0, 0], [1, 0], [1, 1], [0, 1]]); // 朝路一面（-Z）
      pw.quad(e, f, g, h, [[1, 0], [0, 0], [0, 1], [1, 1]]);
      // 灯箱边框
      dk.box(...P(-1.1, 1.525, 0.08), 1.9, 2.25, 0.1, yaw, colS);
    }
    // 座椅
    st.box(...P(0.6, 0.45, -0.55), 2.2, 0.06, 0.42, yaw, [0.55, 0.42, 0.3]);
    for (const lx of [-0.4, 1.6]) st.box(...P(lx, 0.22, -0.55), 0.06, 0.44, 0.38, yaw, colS);
    // 站牌：立杆 + 站名牌（图集）
    {
      const p = P(2.75, 0, -1.2);
      st.cyl(p[0], p[1], p[2], 0.045, 0.045, 2.9, 8, colS);
      const id = this.atlas.add('bus', name);
      const nw = this.w('names');
      const a = P(2.2, 2.3, -1.25), b = P(3.3, 2.3, -1.25), c = P(3.3, 2.75, -1.25), d = P(2.2, 2.75, -1.25);
      nw.quad(b, a, d, c, this.atlas.quadUV(id, 0, 1));
      nw.quad(a, b, c, d, this.atlas.quadUV(id, 1, 0));
      // 候车亭顶的站名条
      const e = P(-2.4, 2.84, -1.74), f2 = P(2.4, 2.84, -1.74), g = P(2.4, 3.2, -1.74), h = P(-2.4, 3.2, -1.74);
      nw.quad(f2, e, h, g, this.atlas.quadUV(id, 0, 1));
    }
    this.lightPts.push([x, y + 2.3, z, 0.9]);
  }

  // ---------- 铺装广场 ----------
  buildPlazas(D) {
    for (const P of D.plazas || []) {
      const poly = P.poly;
      const bb = polyBBox(poly);
      // 取平均地面高
      let ys = 0, n = 0;
      for (let i = 0; i < poly.length; i += 2) { ys += this.ground(poly[i], poly[i + 1]); n++; }
      const y = ys / n + 0.14;
      P.y = y;
      const shape = toShape(poly);
      const g = new THREE.ShapeGeometry(shape, 1);
      g.rotateX(-Math.PI / 2);
      const pos = g.attributes.position, uv = g.attributes.uv;
      const sc = P.style === 'granite' ? 0.5 : 1;
      for (let i = 0; i < pos.count; i++) { pos.setY(i, y); uv.setXY(i, pos.getX(i) * sc, pos.getZ(i) * sc); }
      const w = this.w(P.style === 'granite' ? 'granite' : 'tiles2');
      const idx = g.index ? g.index.array : null;
      const cnt = idx ? idx.length : pos.count;
      for (let k = 0; k < cnt; k++) { const i = idx ? idx[k] : k; w.v(pos.getX(i), pos.getY(i), pos.getZ(i), 0, 1, 0, uv.getX(i), uv.getY(i)); }
      g.dispose();
      this.count('plaza');
      // 树阵
      if (P.trees) {
        const T = P.trees;
        for (let gx = Math.ceil(bb.x0 / T.step) * T.step; gx < bb.x1; gx += T.step)
          for (let gz = Math.ceil(bb.z0 / T.step) * T.step; gz < bb.z1; gz += T.step) {
            const h1 = hash01(gx, gz, 1), h2 = hash01(gx, gz, 2);
            const x = gx + (h1 - 0.5) * T.step * 0.3, z = gz + (h2 - 0.5) * T.step * 0.3;
            if (hash01(gx, gz, 3) < (T.skip ?? 0.4)) continue;
            if (!pointInPoly(x, z, poly) || polyEdgeDist(poly, x, z) < (T.inset ?? 3)) continue;
            // 树池 + 广场乔木（比行道树大一号）
            this.w('curb').box(x, y + 0.06, z, 1.4, 0.12, 1.4, 0, [0.5, 0.48, 0.45]);
            this.addTree(x, y + 0.1, z, 1.15 + h1 * 0.35);
          }
      }
      // 灯柱（沿周边）
      if (P.lamps) this.alongPerimeter(poly, P.lamps.step, 1.8, (x, z, i) => this.addLamp(x, y, z));
      // 坐凳
      if (P.benches) {
        for (let i = 0; i < P.benches; i++) {
          const x = bb.x0 + hash01(i, 11, D.seed || 1) * (bb.x1 - bb.x0), z = bb.z0 + hash01(i, 12, D.seed || 1) * (bb.z1 - bb.z0);
          if (!pointInPoly(x, z, poly) || polyEdgeDist(poly, x, z) < 2) continue;
          this.inst('bench').add(x, y, z, hash01(i, 13) * Math.PI, 1, null);
          this.count('bench');
        }
      }
      // 护柱（指定边）
      if (P.bollards) for (const ei of P.bollards) this.bollardsOnEdge(poly, ei, y);
      // 旗杆
      if (P.flags) for (const [fx, fz] of P.flags) this.flagpole(fx, y, fz);
    }
  }
  alongPerimeter(poly, step, inset, cb) {
    const n = poly.length / 2;
    let acc = step * 0.5, k = 0;
    // 质心用于向内偏移
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += poly[i * 2]; cz += poly[i * 2 + 1]; }
    cx /= n; cz /= n;
    for (let i = 0; i < n; i++) {
      const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[((i + 1) % n) * 2], bz = poly[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-3) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      let nx = -tz, nz = tx;
      // 法线朝多边形内侧（以质心为参考）
      if (nx * (cx - (ax + bx) / 2) + nz * (cz - (az + bz) / 2) < 0) { nx = -nx; nz = -nz; }
      while (acc < L) {
        const x = ax + tx * acc + nx * inset, z = az + tz * acc + nz * inset;
        if (pointInPoly(x, z, poly)) cb(x, z, k++);
        acc += step;
      }
      acc -= L;
    }
  }
  bollardsOnEdge(poly, ei, y) {
    const n = poly.length / 2;
    const ax = poly[ei * 2], az = poly[ei * 2 + 1], bx = poly[((ei + 1) % n) * 2], bz = poly[((ei + 1) % n) * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const tx = (bx - ax) / L, tz = (bz - az) / L;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += poly[i * 2]; cz += poly[i * 2 + 1]; }
    cx /= n; cz /= n;
    let nx = -tz, nz = tx;
    if (nx * (cx - (ax + bx) / 2) + nz * (cz - (az + bz) / 2) < 0) { nx = -nx; nz = -nz; }
    for (let s = 1.0; s < L - 0.5; s += 1.7) {
      this.inst('bollard').add(ax + tx * s + nx * 0.7, y, az + tz * s + nz * 0.7, 0, 1, null);
      this.count('bollard');
    }
  }
  addLamp(x, y, z) {
    this.inst('lampPole').add(x, y, z, 0, 1, null);
    this.inst('lampGlobe').add(x, y, z, 0, 1, null);
    this.lightPts.push([x, y + 4.3, z, 1.0]);
    this.count('lamp');
  }
  flagpole(x, y, z) {
    const st = this.w('steel');
    st.cyl(x, y, z, 0.05, 0.035, 11, 8, [0.8, 0.82, 0.85]);
    st.cyl(x, y, z, 0.35, 0.35, 0.35, 10, [0.6, 0.6, 0.62]);
    const fw = this.w('flag');
    const h = hash01(Math.round(x), Math.round(z));
    const a = [x, y + 9.4, z], b = [x + 1.8, y + 9.6, z + 0.3], c = [x + 1.8, y + 10.8, z + 0.3], d = [x, y + 10.8, z];
    fw.quad(a, b, c, d, [[0, 0], [1, 0], [1, 1], [0, 1]], h < 0.5 ? [0.85, 0.1, 0.08] : [0.9, 0.9, 0.92]);
    fw.quad(b, a, d, c, [[1, 0], [0, 0], [0, 1], [1, 1]], h < 0.5 ? [0.85, 0.1, 0.08] : [0.9, 0.9, 0.92]);
  }

  // ---------- 地面停车场 ----------
  buildParkings(D) {
    for (const P of D.parkings || []) {
      const poly = P.poly;
      let ys = 0, n = 0;
      for (let i = 0; i < poly.length; i += 2) { ys += this.ground(poly[i], poly[i + 1]); n++; }
      const y = ys / n + 0.12;
      const shape = toShape(poly);
      const g = new THREE.ShapeGeometry(shape, 1);
      g.rotateX(-Math.PI / 2);
      const pos = g.attributes.position;
      const w = this.w('lot');
      const idx = g.index ? g.index.array : null;
      const cnt = idx ? idx.length : pos.count;
      for (let k = 0; k < cnt; k++) { const i = idx ? idx[k] : k; w.v(pos.getX(i), y, pos.getZ(i), 0, 1, 0, pos.getX(i) * 0.3, pos.getZ(i) * 0.3); }
      g.dispose();
      // 车位：局部坐标 u 沿 deg 方向（车位排列方向），v 垂直（车位深度方向）；双排车位 + 6 m 通道
      const yaw = P.deg * D2R;
      const A = axes(yaw);
      const bb = polyBBox(poly);
      const cx = (bb.x0 + bb.x1) / 2, cz = (bb.z0 + bb.z1) / 2;
      const ext = Math.hypot(bb.x1 - bb.x0, bb.z1 - bb.z0) / 2;
      const SW = 2.5, SD = 5.3, AISLE = 6.0;
      const lw = this.w('line');
      const cars = this.inst('car');
      const toW = (u, v) => [cx + A.ux * u + A.vx * v, cz + A.uz * u + A.vz * v];
      const stripe = (u0, v0, u1, v1, wid) => {
        const [ax, az] = toW(u0, v0), [bx, bz] = toW(u1, v1);
        const L = Math.hypot(bx - ax, bz - az) || 1;
        const nx = (-(bz - az) / L) * wid / 2, nz = ((bx - ax) / L) * wid / 2;
        lw.quad([ax + nx, y + 0.015, az + nz], [bx + nx, y + 0.015, bz + nz], [bx - nx, y + 0.015, bz - nz], [ax - nx, y + 0.015, az - nz]);
      };
      let nStall = 0;
      const pitch = SD * 2 + AISLE;
      for (let v0 = -ext; v0 < ext; v0 += pitch) {
        for (const [va, vb, face] of [[v0, v0 + SD, 1], [v0 + SD + AISLE, v0 + SD * 2 + AISLE, -1]]) {
          let lineDrawn = false;
          for (let u = -ext; u < ext; u += SW) {
            const corners = [toW(u, va), toW(u + SW, va), toW(u + SW, vb), toW(u, vb)];
            if (!corners.every(([x, z]) => pointInPoly(x, z, poly) && polyEdgeDist(poly, x, z) > 0.3)) continue;
            if (!lineDrawn) { lineDrawn = true; }
            stripe(u, va, u, vb, 0.12);
            stripe(u + SW, va, u + SW, vb, 0.12);
            stripe(u, face > 0 ? va : vb, u + SW, face > 0 ? va : vb, 0.12);
            nStall++;
            const h = hash01(Math.round(u * 10), Math.round(va * 10), 7);
            if (h < (P.occupancy ?? 0.55)) {
              const [x, z] = toW(u + SW / 2, (va + vb) / 2);
              const col = CAR_COLORS[Math.floor(hash01(Math.round(u * 10), Math.round(va * 10), 8) * CAR_COLORS.length)];
              cars.add(x, y, z, yaw + Math.PI / 2 + (face > 0 ? 0 : Math.PI) + (hash01(Math.round(u), Math.round(va), 9) - 0.5) * 0.06, 1, new THREE.Color(col));
              this.count('car');
            }
          }
        }
      }
      this.count('stall', nStall);
      // 出入口道闸 + 岗亭（多边形第一条边中点）
      const ax = poly[0], az = poly[1], bx = poly[2], bz = poly[3];
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const ey = yawOf(bx - ax, bz - az);
      this.w('steel').box(mx, y + 0.5, mz, 0.5, 1.0, 0.4, ey, [0.9, 0.9, 0.9]);
      this.w('line').box(mx + Math.cos(ey) * 2.2, y + 0.95, mz - Math.sin(ey) * 2.2, 4.0, 0.08, 0.08, ey, [0.95, 0.3, 0.25]);
      this.count('parking');
    }
  }

  // ---------- 落客车道 ----------
  buildDrives(D) {
    for (const Dv of D.drives || []) {
      let p = Dv.p;
      if (Dv.circle) {
        const [cx, cz, r] = Dv.circle;
        p = [];
        for (let i = 0; i <= 36; i++) { const a = (i / 36) * Math.PI * 2; p.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r); }
      }
      const w = Dv.w || 6, hw = w / 2;
      const lot = this.w('lot'), ln = this.w('line');
      let prev = null;
      let s = 0;
      for (let i = 0; i + 1 < p.length / 2; i++) {
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
        const L = Math.hypot(bx - ax, bz - az) || 1;
        const tx = (bx - ax) / L, tz = (bz - az) / L;
        const n = Math.max(1, Math.ceil(L / 4));
        for (let k = i === 0 ? 0 : 1; k <= n; k++) {
          const t = k / n;
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          // 落客车道压在广场铺装（+0.14）之上 4 cm，不被广场盖住
          const y = this.ground(x, z) + 0.18;
          const rx = -tz, rz = tx;
          const cur = { l: [x + rx * hw, y, z + rz * hw], r: [x - rx * hw, y, z - rz * hw], li: [x + rx * (hw - 0.15), y + 0.005, z + rz * (hw - 0.15)], ri: [x - rx * (hw - 0.15), y + 0.005, z - rz * (hw - 0.15)], s: s + L * t };
          if (prev) {
            lot.quad(prev.r, prev.l, cur.l, cur.r, [[0, prev.s * 0.3], [w * 0.3, prev.s * 0.3], [w * 0.3, cur.s * 0.3], [0, cur.s * 0.3]]);
            ln.quad(prev.li, prev.l, cur.l, cur.li);
            ln.quad(prev.r, prev.ri, cur.ri, cur.r);
          }
          prev = cur;
        }
        s += L;
      }
      this.count('drive_m', s);
    }
  }

  // ---------- 围墙与大门 ----------
  buildWalls(D) {
    for (const Wl of D.walls || []) {
      const p = Wl.p, h = Wl.h || 2.0;
      const gates = Wl.gates || [];
      const wall = this.w(Wl.style === 'brick' ? 'brickWall' : 'curb'), bars = this.w('bars');
      let s = 0;
      for (let i = 0; i + 1 < p.length / 2; i++) {
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
        const L = Math.hypot(bx - ax, bz - az) || 1;
        const tx = (bx - ax) / L, tz = (bz - az) / L;
        const yaw = yawOf(tx, tz);
        // 按 3 m 一跨
        let u = 0;
        while (u < L - 0.05) {
          const seg = Math.min(3, L - u);
          const sm = s + u + seg / 2;
          const gate = gates.find((g) => Math.abs(sm - g.s) < g.w / 2 + 1.5);
          const mx = ax + tx * (u + seg / 2), mz = az + tz * (u + seg / 2);
          const y = this.ground(mx, mz);
          if (!gate) {
            if (Wl.style === 'brick') {
              wall.box(mx, y + h / 2 - 0.2, mz, seg, h + 0.4, 0.3, yaw, [0.72, 0.66, 0.58]);
              wall.box(mx, y + h + 0.05, mz, seg, 0.1, 0.42, yaw, [0.5, 0.48, 0.46]);
            } else {
              wall.box(mx, y + 0.1, mz, seg, 0.7, 0.3, yaw, [0.62, 0.6, 0.56]);
              // 铁栅：双面 alpha 贴图
              const A = axes(yaw);
              const P2 = (lx, ly) => [mx + A.ux * lx, y + ly, mz + A.uz * lx];
              const a = P2(-seg / 2, 0.45), b = P2(seg / 2, 0.45), c = P2(seg / 2, h), d = P2(-seg / 2, h);
              bars.quad(a, b, c, d, [[0, 0], [seg, 0], [seg, 1], [0, 1]]);
              // 立柱
              wall.box(...P2(seg / 2, h / 2 + 0.1), 0.3, h + 0.3, 0.34, yaw, [0.6, 0.58, 0.54]);
            }
          }
          u += seg;
        }
        // 大门
        for (const g of gates) {
          if (g.s < s || g.s > s + L) continue;
          const gx = ax + tx * (g.s - s), gz = az + tz * (g.s - s);
          const y = this.ground(gx, gz);
          const A = axes(yaw);
          const P2 = (lx, ly, lz) => [gx + A.ux * lx + A.vx * lz, y + ly, gz + A.uz * lx + A.vz * lz];
          for (const sgn of [-1, 1]) {
            wall.box(...P2(sgn * (g.w / 2 + 0.4), 1.6, 0), 0.7, 3.2, 0.7, yaw, [0.66, 0.62, 0.56]);
            wall.box(...P2(sgn * (g.w / 2 + 0.4), 3.3, 0), 0.9, 0.2, 0.9, yaw, [0.4, 0.38, 0.36]);
            this.inst('lampGlobe').add(...P2(sgn * (g.w / 2 + 0.4), 0.4, 0), 0, 0.7, null); // 球灯几何在局部 y=4.35，×0.7 后落在门柱顶 3.45 m
          }
          // 半开的推拉门（铁栅）
          const a = P2(-g.w / 2, 0.2, 0.0), b = P2(-g.w / 2 + g.w * 0.45, 0.2, 0.0), c = P2(-g.w / 2 + g.w * 0.45, 1.9, 0.0), d = P2(-g.w / 2, 1.9, 0.0);
          bars.quad(a, b, c, d, [[0, 0], [g.w * 0.45, 0], [g.w * 0.45, 1], [0, 1]]);
          // 门卫亭
          const bw = this.w('booth');
          bw.box(...P2(g.w / 2 + 2.2, 1.35, 1.2), 2.2, 2.7, 2.0, yaw, [0.85, 0.86, 0.88]);
          this.w('dark').box(...P2(g.w / 2 + 2.2, 2.78, 1.2), 2.5, 0.12, 2.3, yaw, [0.25, 0.26, 0.28]);
          this.w('glass').box(...P2(g.w / 2 + 2.2, 1.7, 1.2), 2.24, 0.9, 2.04, yaw, null, { top: false });
          // 名牌（图集）
          if (g.name) {
            const id = this.atlas.add('gate', g.name);
            const nw = this.w('names');
            const e2 = P2(-g.w / 2 - 0.75, 2.6, -0.37), f2 = P2(g.w / 2 + 0.75, 2.6, -0.37), g2 = P2(g.w / 2 + 0.75, 3.1, -0.37), h2 = P2(-g.w / 2 - 0.75, 3.1, -0.37);
            // 门头横匾（名牌贴在朝街一面）
            wall.box(...P2(0, 2.85, -0.15), g.w + 1.5, 0.6, 0.3, yaw, [0.5, 0.2, 0.16]);
            nw.quad(e2, f2, g2, h2, this.atlas.quadUV(id, 0, 1));
          }
          this.lightPts.push([gx, y + 3.2, gz, 0.8]);
          this.count('gate');
        }
        s += L;
      }
      this.count('wall_m', s);
    }
  }

  // ---------- 路口信号灯 ----------
  buildSignals(D) {
    for (const J of D.signals || []) {
      const t1 = [Math.cos(J.deg1 * D2R), -Math.sin(J.deg1 * D2R)], t2 = [Math.cos(J.deg2 * D2R), -Math.sin(J.deg2 * D2R)];
      for (const a of [1, -1])
        for (const b of [1, -1]) {
          const x = J.x + t1[0] * a * (J.w1 / 2 + 2.6) + t2[0] * b * (J.w2 / 2 + 2.6);
          const z = J.z + t1[1] * a * (J.w1 / 2 + 2.6) + t2[1] * b * (J.w2 / 2 + 2.6);
          if (this.excluded(x, z)) continue;
          const y = this.ground(x, z) + 0.15;
          // 悬臂指向路口（沿 t2 回指，跨过本侧车行道一半）
          const dx = -b * t2[0], dz = -b * t2[1];
          const yaw = yawOf(dx, dz);
          const L = Math.min(J.w2 / 2 + 1, 9);
          this.signalMast(x, y, z, yaw, L);
        }
      this.count('junction');
    }
  }
  signalMast(x, y, z, yaw, L) {
    const st = this.w('steel'), dk = this.w('dark');
    const A = axes(yaw);
    const P = (lx, ly, lz) => [x + A.ux * lx + A.vx * lz, y + ly, z + A.uz * lx + A.vz * lz];
    st.cyl(x, y, z, 0.16, 0.12, 6.6, 10, [0.5, 0.52, 0.55]);
    // 横臂（略上翘）
    const a = P(0, 6.3, 0), b = P(L, 6.5, 0);
    const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...dir);
    const r = 0.07;
    const nx = A.vx * r, nz = A.vz * r;
    st.quad([a[0] + nx, a[1] - r, a[2] + nz], [b[0] + nx, b[1] - r, b[2] + nz], [b[0] + nx, b[1] + r, b[2] + nz], [a[0] + nx, a[1] + r, a[2] + nz], [[0, 0], [len, 0], [len, 0.14], [0, 0.14]], [0.5, 0.52, 0.55]);
    st.quad([b[0] - nx, b[1] - r, b[2] - nz], [a[0] - nx, a[1] - r, a[2] - nz], [a[0] - nx, a[1] + r, a[2] - nz], [b[0] - nx, b[1] + r, b[2] - nz], [[0, 0], [len, 0], [len, 0.14], [0, 0.14]], [0.5, 0.52, 0.55]);
    st.quad([a[0] - nx, a[1] + r, a[2] - nz], [a[0] + nx, a[1] + r, a[2] + nz], [b[0] + nx, b[1] + r, b[2] + nz], [b[0] - nx, b[1] + r, b[2] - nz], null, [0.5, 0.52, 0.55]);
    st.quad([a[0] + nx, a[1] - r, a[2] + nz], [a[0] - nx, a[1] - r, a[2] - nz], [b[0] - nx, b[1] - r, b[2] - nz], [b[0] + nx, b[1] - r, b[2] + nz], null, [0.5, 0.52, 0.55]);
    // 灯箱（三灯竖排，悬在臂端）+ 行人灯在杆上
    for (const lx of [L - 0.9, L - 3.4]) {
      if (lx < 1.5) continue;
      const c = P(lx, 5.35, 0);
      dk.box(c[0], c[1], c[2], 0.36, 1.1, 0.32, yaw, [0.12, 0.12, 0.13]);
      const sig = this.w('signal');
      // 灯面朝 -Z（面向驶来的车辆，即臂所覆盖车道的来向）
      for (const [ly, col] of [[0.36, [1.0, 0.12, 0.08]], [0, [0.2, 0.16, 0.05]], [-0.36, [0.05, 0.2, 0.08]]]) {
        const q = P(lx, 5.35 + ly, -0.17);
        const A2 = axes(yaw);
        const rr = 0.13;
        sig.quad([q[0] - A2.ux * rr, q[1] - rr, q[2] - A2.uz * rr], [q[0] + A2.ux * rr, q[1] - rr, q[2] + A2.uz * rr], [q[0] + A2.ux * rr, q[1] + rr, q[2] + A2.uz * rr], [q[0] - A2.ux * rr, q[1] + rr, q[2] - A2.uz * rr], null, col);
      }
    }
    const pl = P(0.3, 3.0, 0);
    dk.box(pl[0], pl[1], pl[2], 0.3, 0.6, 0.26, yaw, [0.12, 0.12, 0.13]);
    this.count('signalMast');
  }

  // ---------- 回坊街边摊位 ----------
  buildStalls(D, idx) {
    for (const S of D.stalls || []) {
      for (const R of idx) {
        const f = R.f;
        if (!S.name.test(f.n || '')) continue;
        const hw = R.hw;
        let k = 0;
        for (let s = S.step * 0.6; s < R.total; s += S.step, k++) {
          const [cx, cz, dx, dz] = pointOn(R, s);
          const side = k % 2 ? 1 : -1;
          const rx = -dz * side, rz = dx * side;
          // 摊位贴着铺面摆：从路边向街心找第一个不压在逐户轮廓上的位置（OSM 轮廓常比路幅宽度更靠近街心）；
          // 最多退到离中线 0.45 个半幅（北院门约 2.7 m）：再往里就挡在街中央了，宁可不摆
          const oMin = Math.max(1.6, hw * 0.45);
          let o = Math.max(oMin, hw - 1.5), x = 0, z = 0, ok = false;
          for (; o >= oMin; o -= 0.4) {
            x = cx + rx * o; z = cz + rz * o;
            if (!this.excluded(x, z) && !this.excluded(cx + rx * (o + 0.6), cz + rz * (o + 0.6))) { ok = true; break; }
          }
          if (!ok || !inBox(x, z, S.bbox)) continue;
          if (hash01(Math.round(x * 2), Math.round(z * 2), 21) > S.prob) continue;
          if (clearance(idx, x, z, R, f.n) < 2.5) continue;
          const y = (roadY(this.terrain, f, cx, cz, s, R.total) ?? this.ground(cx, cz)) + 0.02;
          const yaw = yawOf(dx, dz) + (side < 0 ? Math.PI : 0); // 局部 -Z 朝街心
          this.stall(x, y, z, yaw, S.style, k);
        }
        // 步行街两侧行道树（回坊主街的国槐；植被模块在逐户轮廓贴边的巷道里种不下，这里按摊位间隔错开补种）
        if (S.trees) {
          const o = Math.max(1.2, hw - 1.0);
          for (let s = S.trees * 0.35; s < R.total; s += S.trees) {
            const [cx, cz, dx, dz] = pointOn(R, s);
            for (const side of [1, -1]) {
              const x = cx - dz * side * o, z = cz + dx * side * o;
              if (!inBox(x, z, S.bbox) || this.excluded(x, z) || clearance(idx, x, z, R, f.n) < 3) continue;
              if (hash01(Math.round(x * 2), Math.round(z * 2), 41) > 0.8) continue;
              const y = (roadY(this.terrain, f, cx, cz, s, R.total) ?? this.ground(cx, cz)) + 0.02;
              this.w('curb').box(x, y + 0.06, z, 1.3, 0.12, 1.3, 0, [0.42, 0.4, 0.38]);
              this.addTree(x, y + 0.1, z, 1.25 + hash01(Math.round(x), Math.round(z), 42) * 0.4);
            }
          }
        }
      }
    }
  }
  /**
   * 回坊小吃摊（局部 -Z 朝街心，x 沿街）：不锈钢售卖车 / 木推车 + 正面印字板、台面货品（蒸笼摞 / 炭火烤炉 / 玻璃罩 / 大锅），
   * 四根方管撑起的人字布棚（条纹布 + 前后垂边 + 两端山花封口）+ 棚檐灯箱、棚下灯泡、棚角小灯笼、折叠桌与红塑料凳；夜里棚下一圈地面暖光
   */
  stall(x, y, z, yaw, style, k) {
    const h = hash01(Math.round(x * 3), Math.round(z * 3), 31);
    const h2 = hash01(Math.round(x * 7), Math.round(z * 5), 37);
    const A = axes(yaw);
    const P = (lx, ly, lz) => [x + A.ux * lx + A.vx * lz, y + ly, z + A.uz * lx + A.vz * lz];
    const st = this.w('steel'), dk = this.w('dark'), gd = this.w('goods');
    const wood = h2 < 0.35;
    // 售卖车：柜体（木推车深栗色 / 不锈钢）+ 台面 + 底部小轮
    (wood ? gd : st).box(...P(0, 0.48, 0.25), 2.2, 0.8, 0.9, yaw, wood ? [0.32, 0.2, 0.12] : [0.7, 0.72, 0.74]);
    st.box(...P(0, 0.9, 0.22), 2.36, 0.05, 1.02, yaw, [0.82, 0.84, 0.86]);
    for (const lx of [-0.85, 0.85]) dk.cyl(...P(lx, 0, -0.12), 0.07, 0.07, 0.1, 6, [0.1, 0.1, 0.1]);
    // 正面印字板（与棚檐灯箱同名）
    const names = style === 'sajinqiao' ? STALL_NAMES_SJQ : STALL_NAMES_HF;
    const name = names[Math.floor(hash01(k, 3, 9) * names.length)];
    const id = this.atlas.add(['stall', 'stall2', 'stall3'][Math.floor(hash01(k, 4) * 3)], name);
    const nw = this.w('names');
    // 朝街心（局部 -Z）的单面牌：顶点顺序从街上看是左下 → 右下 → 右上 → 左上（局部 +x 在观者左手）
    nw.quad(P(1.0, 0.18, -0.215), P(-1.0, 0.18, -0.215), P(-1.0, 0.78, -0.215), P(1.0, 0.78, -0.215), this.atlas.quadUV(id, 0.06, 0.94));
    // 台面货品
    const kind = Math.floor(h * 4);
    if (kind === 0) {
      // 蒸笼摞（甑糕、灌汤包）
      for (const [lx, n] of [[-0.6, 4], [-0.05, 3], [0.5, 5]]) {
        for (let i = 0; i < n; i++) gd.cyl(...P(lx, 0.93 + i * 0.12, 0.2), 0.24, 0.24, 0.115, 10, i === n - 1 ? [0.72, 0.56, 0.34] : [0.8, 0.64, 0.4]);
      }
    } else if (kind === 1) {
      // 炭火烤炉（烤肉、羊肉串）：长条炉 + 炭火 + 一排肉串 + 备料盘
      dk.box(...P(0, 1.04, 0.0), 1.6, 0.22, 0.38, yaw, [0.12, 0.12, 0.12]);
      this.w('coal').box(...P(0, 1.155, 0.0), 1.5, 0.02, 0.3, yaw, null);
      for (let i = 0; i < 12; i++) gd.box(...P(-0.66 + i * 0.12, 1.19, 0.0), 0.03, 0.03, 0.42, yaw, [0.45, 0.2, 0.1]);
      gd.box(...P(0.0, 0.97, 0.45), 1.8, 0.08, 0.3, yaw, [0.85, 0.55, 0.3]);
    } else if (kind === 2) {
      // 玻璃罩展柜（凉皮、肉夹馍）+ 卤肉锅
      const gc = [[0.85, 0.55, 0.25], [0.9, 0.8, 0.5], [0.75, 0.2, 0.15]][Math.floor(h2 * 3)];
      gd.box(...P(-0.35, 1.0, 0.2), 1.1, 0.14, 0.55, yaw, gc);
      this.w('glass').box(...P(-0.35, 1.15, 0.2), 1.3, 0.45, 0.7, yaw, null);
      gd.cyl(...P(0.7, 0.93, 0.2), 0.3, 0.32, 0.32, 10, [0.68, 0.7, 0.72]);
    } else {
      // 大锅 + 碗摞 + 酸梅汤桶
      st.cyl(...P(-0.45, 0.93, 0.2), 0.34, 0.38, 0.36, 12, [0.55, 0.56, 0.58]);
      gd.cyl(...P(-0.45, 1.27, 0.2), 0.33, 0.33, 0.02, 12, [0.6, 0.35, 0.18]);
      for (let i = 0; i < 4; i++) gd.cyl(...P(0.35 + (i % 2) * 0.32, 0.93 + Math.floor(i / 2) * 0.09, 0.05), 0.09, 0.11, 0.08, 8, [0.92, 0.9, 0.86]);
      gd.cyl(...P(0.75, 0.93, 0.35), 0.18, 0.18, 0.5, 10, [0.62, 0.14, 0.12]);
    }
    // 棚架：四根方管立柱 + 前后横梁
    const H0 = 2.3, HR = 2.75; // 檐口高、屋脊高
    for (const [lx, lz] of [[-1.35, -1.05], [1.35, -1.05], [-1.35, 1.0], [1.35, 1.0]]) st.box(...P(lx, H0 / 2, lz), 0.05, H0, 0.05, yaw, [0.58, 0.6, 0.62]);
    for (const lz of [-1.05, 1.0]) st.box(...P(0, H0, lz), 2.75, 0.05, 0.05, yaw, [0.58, 0.6, 0.62]);
    // 人字布棚（屋脊沿街向，出檐 0.15 m）+ 前后垂边 + 两端山花（棚布双面材质）
    const aw = this.w(style === 'sajinqiao' ? (h < 0.5 ? 'awningB' : 'awningR') : h < 0.3 ? 'awningB' : h < 0.55 ? 'awningG' : 'awningR');
    const X0 = -1.5, X1 = 1.5, ZF = -1.2, ZB = 1.15, ZR = -0.02;
    aw.quad(P(X0, H0 - 0.05, ZF), P(X1, H0 - 0.05, ZF), P(X1, HR, ZR), P(X0, HR, ZR), [[0, 0], [3, 0], [3, 1.3], [0, 1.3]]);
    aw.quad(P(X1, H0 - 0.05, ZB), P(X0, H0 - 0.05, ZB), P(X0, HR, ZR), P(X1, HR, ZR), [[0, 0], [3, 0], [3, 1.3], [0, 1.3]]);
    aw.quad(P(X0, H0 - 0.33, ZF), P(X1, H0 - 0.33, ZF), P(X1, H0 - 0.05, ZF), P(X0, H0 - 0.05, ZF), [[0, 0], [3, 0], [3, 0.28], [0, 0.28]]);
    aw.quad(P(X1, H0 - 0.33, ZB), P(X0, H0 - 0.33, ZB), P(X0, H0 - 0.05, ZB), P(X1, H0 - 0.05, ZB), [[0, 0], [3, 0], [3, 0.28], [0, 0.28]]);
    for (const lx of [X0, X1]) aw.quad(P(lx, H0 - 0.05, ZF), P(lx, H0 - 0.05, ZB), P(lx, HR, ZR + 0.01), P(lx, HR, ZR - 0.01), [[0, 0], [2.3, 0], [1.16, 0.7], [1.14, 0.7]]);
    // 棚檐灯箱（挂在前垂边外侧）
    nw.quad(P(0.85, H0 - 0.3, ZF - 0.03), P(-0.85, H0 - 0.3, ZF - 0.03), P(-0.85, H0 + 0.08, ZF - 0.03), P(0.85, H0 + 0.08, ZF - 0.03), this.atlas.quadUV(id, 0.1, 0.9));
    // 棚下灯泡 + 棚角小灯笼（夜里有光晕）+ 地面暖光
    for (const lx of [-0.8, 0, 0.8]) this.inst('bulb').add(...P(lx, H0 - 0.15, -0.3), 0, 1, null);
    if (h2 > 0.4) for (const lx of [-1.3, 1.3]) this.smallLanterns.push(...P(lx, H0 - 0.6, ZF + 0.05));
    const c = P(0, 0, -0.5);
    this.glowPts.push([c[0], y + 0.04, c[2], 5.5, 1.2, yaw]);
    // 折叠桌 + 红塑料凳（摆在摊位朝街一侧）
    if (h2 < 0.7) {
      const t = P(-0.2, 0, -1.9);
      gd.box(t[0], y + 0.7, t[2], 0.7, 0.04, 0.7, yaw, [0.85, 0.82, 0.76]);
      for (const [a, b] of [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]) st.box(...P(-0.2 + a, 0.35, -1.9 + b), 0.03, 0.7, 0.03, yaw, [0.5, 0.5, 0.5]);
      for (const [a, b] of [[-0.75, 0], [0.35, 0], [-0.2, -0.6]]) gd.box(...P(-0.2 + a, 0.2, -1.9 + b), 0.3, 0.4, 0.3, yaw, [0.82, 0.16, 0.14]);
    }
    this.lightPts.push([c[0], y + 2.2, c[2], 0.5]);
    this.count('stall_hf');
  }
  // 横跨街道的灯笼串
  buildLights(D, idx) {
    for (const S of D.lights || []) {
      for (const R of idx) {
        const f = R.f;
        if (!S.name.test(f.n || '')) continue;
        const hw = R.hw;
        const lw = this.w('cable');
        for (let s = S.step * 0.5; s < R.total; s += S.step) {
          const [cx, cz, dx, dz] = pointOn(R, s);
          if (!inBox(cx, cz, S.bbox)) continue;
          if (clearance(idx, cx, cz, R, f.n) < 3) continue;
          const y = (roadY(this.terrain, f, cx, cz, s, R.total) ?? this.ground(cx, cz)) + S.h;
          const rx = -dz, rz = dx;
          const span = hw * 2 + 1.0;
          const n = 12;
          let prev = null;
          for (let i = 0; i <= n; i++) {
            const t = i / n;
            const o = -span / 2 + span * t;
            const sag = -0.55 * 4 * t * (1 - t);
            const px = cx + rx * o, pz = cz + rz * o, py = y + sag;
            if (prev) {
              // 细缆：竖向薄带
              lw.quad([prev[0], prev[1] - 0.006, prev[2]], [px, py - 0.006, pz], [px, py + 0.006, pz], [prev[0], prev[1] + 0.006, prev[2]], null, [0.1, 0.1, 0.1]);
              lw.quad([px, py - 0.006, pz], [prev[0], prev[1] - 0.006, prev[2]], [prev[0], prev[1] + 0.006, prev[2]], [px, py + 0.006, pz], null, [0.1, 0.1, 0.1]);
            }
            if (i % 2 === 1) this.lanternPts.push(px, py - 0.42, pz); // 灯身中心在缆下 0.42 m（提梁顶贴缆）
            prev = [px, py, pz];
          }
          // 灯笼串下方石板路的夜间暖光（横跨街面拉长）
          this.glowPts.push([cx, y - S.h + 0.27, cz, 6, Math.max(1, span / 7), yawOf(rx, rz)]);
          this.count('lightString');
        }
      }
    }
  }

  // ---------- 汇总成网格 ----------
  finish(root, name) {
    const M = this.M;
    let tris = 0;
    for (const [key, w] of this.W) {
      const g = w.geometry();
      if (!g) continue;
      const mat = M[key] || M.curb;
      const m = new THREE.Mesh(g, mat);
      m.name = `${name}-${key}`;
      m.castShadow = !(key === 'tiles' || key === 'bike' || key === 'grass' || key === 'granite' || key === 'tiles2' || key === 'lot' || key === 'line' || key === 'cable');
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      if (key === 'tiles' || key === 'bike' || key === 'grass' || key === 'granite' || key === 'tiles2' || key === 'lot') m.renderOrder = -1;
      tris += g.attributes.position.count / 3;
      root.add(m);
    }
    const G = M.geos;
    const add = (key, geo, mat, opt) => {
      const I = this.I[key];
      if (!I) return;
      const im = I.mesh(geo, mat, `${name}-${key}`, opt);
      if (im) { root.add(im); tris += (geo.attributes.position.count / 3) * I.m.length; }
    };
    add('tree', G.treeCards, M.leaf, { shadow: true });
    add('trunk', G.trunk, M.trunk);
    add('lampPole', G.lampPole, M.steel);
    add('lampGlobe', G.lampGlobe, M.glow);
    add('bench', G.bench, M.wood);
    add('bollard', G.bollard, M.dark);
    add('car', G.car, M.car);
    add('bulb', G.bulb, M.bulb, { shadow: false });
    // 灯笼串与棚角小灯笼：竹骨灯身 + 木托流苏 + 夜间光晕；灯笼串与摊位下方的地面暖光
    if (this.lanternPts.length) { root.add(lanternGroup(this.ctx, this.lanternPts, { scale: 0.85, halo: 1.5, name: `${name}-灯笼串` })); tris += (this.lanternPts.length / 3) * 120; }
    if (this.smallLanterns.length) root.add(lanternGroup(this.ctx, this.smallLanterns, { scale: 0.6, halo: 1.2, name: `${name}-摊位灯笼` }));
    if (this.glowPts.length) root.add(groundGlow(this.ctx, this.glowPts, { color: 0xffa858, night: 0.12, name: `${name}-地面暖光` }));
    this.stats.lanterns = this.lanternPts.length / 3;
    this.stats.tris = Math.round(tris);
    return this.stats;
  }
}

const CAR_COLORS = [0xdedede, 0xe8e8e8, 0x1a1a1c, 0x2b2b2e, 0x8c8f94, 0xb0b3b8, 0x7a1f1f, 0x1f3a73, 0xc9c9c9, 0x3a3a3c, 0x5a2a0a, 0xd8d8d8];
const STALL_NAMES_HF = ['老米家泡馍', '贾三灌汤包', '红红酸菜炒米', '花奶奶酸梅汤', '老孙家羊肉泡', '镜糕', '柿子饼', '桂花糕', '羊肉串', '烤面筋', '麻酱凉皮', '肉夹馍', '八宝玫瑰镜糕', '石榴汁'];
const STALL_NAMES_SJQ = ['马家甑糕', '定家小酥肉', '志亮灌汤蒸饺', '老安家炒凉粉', '李唯一肉丸胡辣汤', '刘家烧鸡', '老马家烤肉', '麻乃馄饨', '盛志望麻酱酿皮', '老刘家伊味儿', '杨天玉腊牛肉', '酸汤水饺'];

/** 点到多边形边的距离 */
function polyEdgeDist(poly, x, z) {
  let best = Infinity;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[((i + 1) % n) * 2], bz = poly[((i + 1) % n) * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

// ───────────────────────── 材质与小品几何 ─────────────────────────
export function makeMaterials(ctx) {
  const S = THREE.MeshStandardMaterial;
  const night = ctx.night;
  const M = {};
  M.tiles = new S({ map: tex(pavingTiles(3), { repeat: 1 }), roughness: 0.92, vertexColors: false });
  M.tiles2 = new S({ map: tex(pavingTiles(5, '#9b968d', '#847f77', 3), { repeat: 1 }), roughness: 0.9 });
  M.granite = new S({ map: tex(pavingGranite(7), { repeat: 1 }), roughness: 0.78 });
  M.bike = new S({ map: tex(noiseMap(9, '#7a4038', 34)), roughness: 0.95 });
  M.lot = new S({ map: tex(noiseMap(11, '#3a3a3c', 30)), roughness: 0.95 });
  M.grass = ctx.mats.get('grass');
  M.hedge = new S({ map: tex(hedgeMap(13)), roughness: 0.95 });
  M.curb = new S({ color: 0xa8a39a, roughness: 0.85, vertexColors: true });
  M.brickWall = new S({ color: 0xffffff, roughness: 0.9, vertexColors: true, map: tex(noiseMap(15, '#c9c0b2', 26)) });
  M.steel = new S({ color: 0xffffff, metalness: 0.7, roughness: 0.4, vertexColors: true });
  M.dark = new S({ color: 0xffffff, metalness: 0.5, roughness: 0.55, vertexColors: true });
  M.glass = new THREE.MeshPhysicalMaterial({ color: 0x9fb8c8, metalness: 0.2, roughness: 0.08, transparent: true, opacity: 0.45, envMapIntensity: 1.2, side: THREE.DoubleSide, depthWrite: false });
  M.line = new S({ color: 0xffffff, roughness: 0.7, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.05 });
  M.goods = new S({ color: 0xffffff, roughness: 0.8, vertexColors: true });
  M.booth = new S({ color: 0xffffff, roughness: 0.7, vertexColors: true });
  M.flag = new S({ color: 0xffffff, roughness: 0.8, vertexColors: true, side: THREE.DoubleSide });
  M.cable = new S({ color: 0xffffff, roughness: 0.9, vertexColors: true, side: THREE.DoubleSide });
  M.bars = new S({ map: tex(barsMap(), { repeat: 1 }), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xffffff, metalness: 0.4, roughness: 0.6 });
  M.awningR = new S({ map: tex(stripesMap('#c8302a', '#f2ece0')), roughness: 0.9, side: THREE.DoubleSide });
  M.awningB = new S({ map: tex(stripesMap('#1f4e9a', '#f2ece0')), roughness: 0.9, side: THREE.DoubleSide });
  for (let i = 0; i < 4; i++) {
    const t = tex(posterMap(i), { repeat: 1 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    const m = new S({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.5 });
    night.register(m, { day: 0.0, night: 1.6 });
    M['poster' + i] = m;
  }
  M.signal = new S({ color: 0xffffff, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4 });
  M.glow = new S({ color: 0xfff3dc, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.3 });
  night.register(M.glow, { day: 0.0, night: 2.4 });
  M.bulb = new S({ color: 0xfff1c8, emissive: 0xffc566, emissiveIntensity: 0, roughness: 0.3 });
  night.register(M.bulb, { day: 0.0, night: 1.6 });
  M.awningG = new S({ map: tex(stripesMap('#2a7a44', '#f2ece0')), roughness: 0.9, side: THREE.DoubleSide });
  // 烤炉炭火：白天暗红微亮，夜里橙红
  M.coal = new S({ color: 0x3a1408, emissive: 0xff5a14, emissiveIntensity: 0.6, roughness: 0.9 });
  night.register(M.coal, { day: 0.5, night: 1.3 });
  M.leaf = new S({ map: tex(leafCard(17), { repeat: 1 }), transparent: false, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, color: 0xffffff });
  M.leaf.map.wrapS = M.leaf.map.wrapT = THREE.ClampToEdgeWrapping;
  M.trunk = new S({ color: 0x5a4332, roughness: 0.95 });
  M.wood = new S({ color: 0x8a6a48, roughness: 0.85 });
  M.car = new S({ color: 0xffffff, metalness: 0.5, roughness: 0.35, vertexColors: true });
  M.geos = makeGeos();
  return M;
}

function makeGeos() {
  const G = {};
  // 树冠卡片：3 片竖直交叉 + 2 片斜置
  {
    const parts = [];
    const card = (w, h, y, ry, rx = 0) => {
      const g = new THREE.PlaneGeometry(w, h);
      g.rotateX(rx);
      g.rotateY(ry);
      g.translate(0, y, 0);
      return g;
    };
    parts.push(card(4.2, 3.6, 4.2, 0), card(4.2, 3.6, 4.2, Math.PI / 3), card(4.2, 3.6, 4.2, (2 * Math.PI) / 3));
    parts.push(card(3.4, 3.4, 5.2, 0.3, -Math.PI / 2 + 0.35), card(3.0, 3.0, 3.1, 1.2, -Math.PI / 2 - 0.3));
    G.treeCards = mergeNonIndexed(parts);
  }
  {
    const g = new THREE.CylinderGeometry(0.11, 0.17, 2.8, 7, 1);
    g.translate(0, 1.4, 0);
    G.trunk = g;
  }
  {
    const g = new THREE.CylinderGeometry(0.05, 0.075, 4.2, 8, 1);
    g.translate(0, 2.1, 0);
    const b = new THREE.CylinderGeometry(0.22, 0.26, 0.25, 8, 1);
    b.translate(0, 0.12, 0);
    G.lampPole = mergeNonIndexed([g, b]);
    const s = new THREE.SphereGeometry(0.3, 10, 8);
    s.translate(0, 4.35, 0);
    G.lampGlobe = s;
  }
  {
    const seat = new THREE.BoxGeometry(1.8, 0.07, 0.45);
    seat.translate(0, 0.45, 0);
    const back = new THREE.BoxGeometry(1.8, 0.4, 0.05);
    back.translate(0, 0.7, -0.2);
    const l1 = new THREE.BoxGeometry(0.06, 0.45, 0.42);
    l1.translate(-0.8, 0.225, 0);
    const l2 = new THREE.BoxGeometry(0.06, 0.45, 0.42);
    l2.translate(0.8, 0.225, 0);
    G.bench = mergeNonIndexed([seat, back, l1, l2]);
  }
  {
    const g = new THREE.CylinderGeometry(0.09, 0.11, 0.8, 8, 1);
    g.translate(0, 0.4, 0);
    G.bollard = g;
  }
  {
    // 轿车：车身 + 座舱 + 四轮；窗户用深色顶点色
    const body = new THREE.BoxGeometry(4.3, 0.6, 1.75);
    body.translate(0, 0.62, 0);
    const cab = new THREE.BoxGeometry(2.3, 0.62, 1.6);
    cab.translate(-0.15, 1.22, 0);
    const parts = [body, cab];
    for (const [x, z] of [[1.35, 0.8], [1.35, -0.8], [-1.35, 0.8], [-1.35, -0.8]]) {
      const w = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 10, 1);
      w.rotateX(Math.PI / 2);
      w.translate(x, 0.32, z);
      parts.push(w);
    }
    const g = mergeNonIndexed(parts);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const pos = g.attributes.position;
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i), x = pos.getX(i), z = pos.getZ(i);
      const isCab = y > 0.95 && Math.abs(x) < 1.3 && Math.abs(z) <= 0.81;
      const isWheel = y < 0.65 && Math.abs(Math.abs(x) - 1.35) < 0.4 && Math.abs(Math.abs(z) - 0.8) < 0.2 && (Math.abs(z) > 0.8 || y < 0.33);
      const v = isWheel ? 0.06 : isCab ? 0.12 : 1;
      col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    G.car = g;
  }
  G.bulb = new THREE.SphereGeometry(0.06, 6, 5);
  return G;
}
function mergeNonIndexed(list) {
  const out = [];
  for (const g of list) {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k);
    out.push(n);
  }
  const p = [], nn = [], uv = [];
  for (const g of out) {
    p.push(...g.attributes.position.array);
    nn.push(...g.attributes.normal.array);
    uv.push(...(g.attributes.uv ? g.attributes.uv.array : new Float32Array((g.attributes.position.count) * 2)));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}

/** 片区数据预处理：rect → points，统一 poly 字段 */
export function normalizeDistrict(D) {
  for (const P of [...(D.plazas || []), ...(D.parkings || [])]) {
    P.poly = P.points ? P.points.slice() : rectPoly(P.rect[0], P.rect[1], P.rect[2], P.rect[3], (P.rect[4] || 0) * D2R);
  }
  return D;
}
export { NameAtlas, yawOf, axes, inBox };
