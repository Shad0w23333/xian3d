// 电视塔东侧华润两座综合体的几何：西安万象城（华润 CCBD，Heatherwick Studio）与西安万象天地。
// 数据与调研见 src/modules/mixc.js、research/refs/mixc/notes.md。
// 构件：
//   陶板框架“盒子”（中间下垂、两端上翘的曲梁屋檐 + 四角粗陶板立柱 + 深色玻璃 + 上部深红色竖向褶皱板 + 草坪/玻璃屋顶）、
//   弧形凹顶塔楼（两端高、中部低）、生命之树（中央核心筒 + 10 根柱 + 风车状错位花瓣平台 + 扇形褶皱底板 + 竖杆栏杆 + 植栽）、
//   圆形下沉庭院、叶形双曲玻璃天窗、四角星形天窗、连廊“灵感之桥”、银杏树、万象天地圆形广场退台与圆柱玻璃体量。
import * as THREE from 'three';
import * as G from './sky-geom.js';
import { buildTower, buildPodium } from './sky-towers.js';
import { style as mkStyle } from './sky-facade.js';

const D2R = Math.PI / 180;

// ───────────── 程序化贴图与材质 ─────────────
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
}
function canvasTex(c, meters, { srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (meters) t.repeat.set(1 / meters[0], 1 / meters[1]);
  t.anisotropy = 8;
  return t;
}

/** 釉面陶板：米白 / 粉米 / 浅褐斑驳，错缝铺贴（4 m × 4 m 一张，板约 0.8 m × 0.33 m） */
function ceramicCanvas(ctx) {
  const c = ctx.tex.canvas(512), g = c.getContext('2d'), r = rng(71);
  g.fillStyle = '#e6d9c6'; g.fillRect(0, 0, 512, 512);
  const pal = ['#d6bb9a', '#dfc9ab', '#c9a37f', '#d4ae8e', '#c29870', '#e3d0b6', '#c69480', '#cda57c', '#b58a63', '#bf9a6a'];
  const rows = 12, cols = 5, th = 512 / rows, tw = 512 / cols;
  for (let j = 0; j < rows; j++) {
    const off = (j % 2) * tw * 0.5;
    for (let i = -1; i <= cols; i++) {
      const x = i * tw + off, y = j * th;
      g.fillStyle = pal[Math.floor(r() * pal.length)];
      g.fillRect(x + 1.5, y + 1.5, tw - 3, th - 3);
      // 斑点（釉里的深色颗粒）
      for (let k = 0; k < 40; k++) {
        g.fillStyle = r() < 0.5 ? 'rgba(110,70,45,0.28)' : 'rgba(250,240,225,0.35)';
        g.fillRect(x + r() * tw, y + r() * th, 1 + r() * 2.5, 1 + r() * 2.5);
      }
      // 釉面高光（上沿亮一点）
      g.fillStyle = 'rgba(255,250,240,0.12)';
      g.fillRect(x + 2, y + 2, tw - 4, th * 0.28);
    }
  }
  return c;
}
/** 深红色竖向褶皱板（每道褶约 0.5 m：亮面—暗面交替） */
function pleatCanvas(ctx) {
  const c = ctx.tex.canvas(256, 64), g = c.getContext('2d');
  const n = 8, w = 256 / n;
  for (let i = 0; i < n; i++) {
    const gr = g.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    gr.addColorStop(0, '#5a1719'); gr.addColorStop(0.35, '#8e2c2c'); gr.addColorStop(0.55, '#a8413b'); gr.addColorStop(1, '#4a1214');
    g.fillStyle = gr; g.fillRect(i * w, 0, w, 64);
  }
  return c;
}
/** 生命之树扇形底板：米白褶皱面 + 深古铜肋（u 每 1 个单位一道肋） */
function fanCanvas(ctx) {
  const c = ctx.tex.canvas(256, 64), g = c.getContext('2d');
  g.fillStyle = '#ddd0b4'; g.fillRect(0, 0, 256, 64);
  for (let k = 0; k < 5; k++) { // 细褶
    const x = 32 + k * 48;
    const gr = g.createLinearGradient(x - 24, 0, x + 24, 0);
    gr.addColorStop(0, 'rgba(120,100,70,0.0)'); gr.addColorStop(0.5, 'rgba(120,100,70,0.22)'); gr.addColorStop(1, 'rgba(255,250,235,0.18)');
    g.fillStyle = gr; g.fillRect(x - 24, 0, 48, 64);
  }
  g.fillStyle = '#2a2119'; g.fillRect(0, 0, 18, 64); g.fillRect(256 - 6, 0, 6, 64);
  return c;
}
/** 竖杆栏杆（透明底） */
function railCanvas(ctx) {
  const c = ctx.tex.canvas(128, 64), g = c.getContext('2d');
  g.clearRect(0, 0, 128, 64);
  g.fillStyle = '#6a625a';
  for (let i = 0; i < 8; i++) g.fillRect(i * 16 + 6, 0, 3, 64);
  g.fillRect(0, 0, 128, 4); g.fillRect(0, 34, 128, 2);
  return c;
}
/** 广场铺装：灰色石材 + 深色弧线鳞纹 */
function paveCanvas(ctx) {
  const c = ctx.tex.canvas(512), g = c.getContext('2d'), r = rng(9);
  g.fillStyle = '#a3a5a4'; g.fillRect(0, 0, 512, 512);
  for (let k = 0; k < 900; k++) { g.fillStyle = r() < 0.5 ? 'rgba(80,84,88,0.18)' : 'rgba(210,210,205,0.2)'; g.fillRect(r() * 512, r() * 512, 10 + r() * 20, 5 + r() * 8); }
  g.strokeStyle = '#4a4e52'; g.lineWidth = 7;
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const x = i * 170 + (j % 2) * 85, y = j * 170 + 60;
    g.beginPath(); g.arc(x, y, 85, 0, Math.PI); g.stroke();
  }
  return c;
}
/** 穿孔铝板（万象天地）：浅灰白底 + 像素点阵 */
function perfCanvas(ctx) {
  const c = ctx.tex.canvas(256), g = c.getContext('2d'), r = rng(33);
  g.fillStyle = '#cfd2d3'; g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 8) for (let x = 0; x < 256; x += 8) {
    const a = 0.08 + 0.3 * Math.max(0, Math.sin(x * 0.03 + y * 0.011) + r() * 0.6 - 0.3);
    g.fillStyle = `rgba(70,74,78,${a.toFixed(3)})`;
    g.beginPath(); g.arc(x + 4, y + 4, 2.2, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = 'rgba(90,94,98,0.5)'; g.fillRect(0, 0, 256, 3); g.fillRect(0, 0, 3, 256);
  return c;
}

export function mixcMats(ctx) {
  const cer = canvasTex(ceramicCanvas(ctx), [4, 4]);
  const M = {
    ceramic: new THREE.MeshStandardMaterial({ map: cer, color: 0xf2dcc4, roughness: 0.5, metalness: 0.04, emissive: 0xffe2c4, emissiveMap: cer, emissiveIntensity: 0 }),
    soffit: new THREE.MeshStandardMaterial({ map: cer, color: 0xb9a893, roughness: 0.6, metalness: 0.02, emissive: 0xffd2a0, emissiveMap: cer, emissiveIntensity: 0 }),
    pleat: new THREE.MeshStandardMaterial({ map: canvasTex(pleatCanvas(ctx), [4, 4]), roughness: 0.42, metalness: 0.18, emissive: 0xff7a55, emissiveIntensity: 0 }),
    bronze: new THREE.MeshStandardMaterial({ color: 0x3e3226, metalness: 0.8, roughness: 0.34 }),
    fan: new THREE.MeshStandardMaterial({ map: canvasTex(fanCanvas(ctx)), color: 0xffffff, roughness: 0.42, metalness: 0.12, emissive: 0xffc062, emissiveIntensity: 0, side: THREE.DoubleSide }),
    edgeLed: new THREE.MeshStandardMaterial({ color: 0x2c2f33, metalness: 0.6, roughness: 0.4, emissive: 0x3d63ff, emissiveIntensity: 0 }),
    rail: new THREE.MeshStandardMaterial({ map: canvasTex(railCanvas(ctx), [1.6, 1.6]), transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6 }),
    plant: new THREE.MeshStandardMaterial({ color: 0x5e7040, roughness: 0.95 }),
    plantY: new THREE.MeshStandardMaterial({ color: 0xa79a45, roughness: 0.9 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x8ea043, roughness: 0.88 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x5b4a3b, roughness: 0.9 }),
    pave: new THREE.MeshStandardMaterial({ map: canvasTex(paveCanvas(ctx), [12, 12]), roughness: 0.85 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x9a6a3c, roughness: 0.7, emissive: 0xffa050, emissiveIntensity: 0 }),
    perf: new THREE.MeshStandardMaterial({ map: canvasTex(perfCanvas(ctx), [3, 3]), roughness: 0.45, metalness: 0.45 }),
    white: new THREE.MeshStandardMaterial({ color: 0xe4e4e1, roughness: 0.45, metalness: 0.2, emissive: 0xfff0dc, emissiveIntensity: 0 }),
    glassRail: new THREE.MeshStandardMaterial({ color: 0xaec3cc, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.3, side: THREE.DoubleSide, depthWrite: false }),
    skylight: new THREE.MeshPhysicalMaterial({ color: 0x9fb2bd, metalness: 0.55, roughness: 0.1, envMapIntensity: 1.3, emissive: 0xffd6a0, emissiveIntensity: 0 }),
  };
  M.fan.userData.ownUV = true; // 扇形底板自带放射 UV
  M.rail.userData.ownUV = true; // 栏杆自带 UV
  // 夜景（照片 n_main）：陶板框架被暖光柔和洗亮；树的扇形底板暖金色投光；平台边缘与下沉坑栏杆蓝色灯带
  ctx.night.register(M.ceramic, { day: 0, night: 0.06 });
  ctx.night.register(M.soffit, { day: 0, night: 0.22 });
  ctx.night.register(M.pleat, { day: 0, night: 0.07 });
  ctx.night.register(M.fan, { day: 0.1, night: 0.5 }); // 白天略加自发光模拟地面反射光（照片中底板在阴影里仍是米白色）
  ctx.night.register(M.edgeLed, { day: 0, night: 2.6 });
  ctx.night.register(M.wood, { day: 0, night: 0.5 });
  ctx.night.register(M.white, { day: 0, night: 0.22 });
  ctx.night.register(M.skylight, { day: 0, night: 0.3 });
  return M;
}

// ───────────── 几何小工具 ─────────────
/** 三角形收集器：quad 自动按期望法线定向；最后生成非索引几何（平面法线） */
class Tris {
  constructor() { this.P = []; this.UV = []; }
  tri(a, b, c, n, uv) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-10) return; // 退化三角形（如天窗两端尖点）不输出，避免零长度法线
    if (n && cx * n[0] + cy * n[1] + cz * n[2] < 0) { [b, c] = [c, b]; if (uv) uv = [uv[0], uv[2], uv[1]]; }
    this.P.push(...a, ...b, ...c);
    if (uv) this.UV.push(...uv[0], ...uv[1], ...uv[2]);
  }
  quad(a, b, c, d, n, uv) {
    this.tri(a, b, c, n, uv && [uv[0], uv[1], uv[2]]);
    this.tri(a, c, d, n, uv && [uv[0], uv[2], uv[3]]);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    if (this.UV.length === (this.P.length / 3) * 2) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.UV, 2));
    g.computeVertexNormals();
    return g;
  }
  get empty() { return !this.P.length; }
}
/** 两点之间的圆管 */
function tube(a, b, r0, r1 = r0, seg = 8) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1e-3;
  const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, true);
  g.translate(0, L / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / L, dy / L, dz / L));
  g.applyQuaternion(q);
  g.translate(a[0], a[1], a[2]);
  return g;
}
const edgesOf = (p) => {
  const n = p.length / 2, E = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    E.push({ i, ax, az, bx, bz, L, dx: (bx - ax) / (L || 1), dz: (bz - az) / (L || 1), nx: (bz - az) / (L || 1), nz: -(bx - ax) / (L || 1) });
  }
  return E;
};
/** 伪随机 0..1（可复现） */
const hash = (a, b = 0) => { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s); };

/** 单边竖直面板（a→b，朝外法线 (dz,-dx)），y0..y1 可为常数 */
function wallQuad(T, ax, az, bx, bz, y0, y1, out = 0) {
  const L = Math.hypot(bx - ax, bz - az) || 1, nx = (bz - az) / L, nz = -(bx - ax) / L;
  const o = out;
  T.quad([ax + nx * o, y0, az + nz * o], [bx + nx * o, y0, bz + nz * o], [bx + nx * o, y1, bz + nz * o], [ax + nx * o, y1, az + nz * o], [nx, 0, nz]);
}

// ───────────── 陶板框架“盒子”（Heatherwick 裙楼单元） ─────────────
/**
 * p: {pts, base, h, roof:'grass'|'glass'|'gray', red(0..1 概率), redFrom(0..1), rise(翘角高度), band(檐梁高), glass(风格覆盖), key}
 * 立面：内缩 0.9 m 的深色玻璃（古铜竖框，夜间通亮）；部分立面上段为深红色褶皱板；
 * 屋檐：沿每条边的陶板曲梁，中间下垂、两端上翘并外挑（f=(2t-1)²）；凸角处粗陶板立柱落地。
 */
export function framedBox(E, M, p, T) {
  const { fb, solid } = E;
  const pts = G.ccw(p.pts), base = p.base, h = p.h;
  const band = p.band ?? Math.min(2.4, 1.2 + h * 0.035);
  const glassSt = mkStyle({ mode: 6, floorH: h > 14 ? 5.4 : Math.max(4.5, h / 2), colW: 3.0, spandrel: 0.16, mullW: 0.16, lit: 0.95, tint: '#262d33', spd: '#7a5b3e', seed: hash(pts[0], pts[1]) * 90, ...(p.glass || {}) });
  const inner = G.inset(pts, 0.9);
  fb.prism(inner, base - 0.6, base + h - band * 0.4, glassSt, { vBase: base });
  // 屋面（檐梁顶以下 0.3 m）
  const roofY = base + h;
  const roofMat = p.roof === 'grass' ? E.mats.grass : p.roof === 'glass' ? M.skylight : E.mats.roof;
  solid.add(G.capGeometry(G.inset(pts, 0.3), roofY + 0.05), roofMat, null, { worldUV: 1 });
  if (p.roof === 'glass') { // 采光顶格栅（每 6 m 一道）
    const bb = G.bbox(pts);
    for (let x = bb.x0 + 3; x < bb.x1 - 2; x += 6) {
      const seg = clipLine(inner, x, true);
      for (const [z0, z1] of seg) E.detail.add(G.box(x, roofY + 0.3, (z0 + z1) / 2, 0.25, 0.4, z1 - z0), M.bronze);
    }
  }
  // 红色褶皱板 / 檐梁 / 立柱
  const edges = edgesOf(pts);
  const cer = T.cer, sof = T.sof, red = T.red;
  const rise = (L) => p.rise ?? Math.max(0.9, Math.min(3.2, L * 0.07));
  for (const e of edges) {
    if (e.L < 0.8) continue;
    // 上段深红褶皱板（长边、按概率），贴在玻璃外 0.15 m
    if (e.L > 7 && hash(e.ax * 0.37 + e.az * 0.11, p.key || 1) < (p.red ?? 0.45)) {
      const f0 = p.redFrom ?? 0.45;
      const ie = edgesOf(inner)[e.i];
      wallQuad(red, ie.ax, ie.az, ie.bx, ie.bz, base + h * f0, roofY - band * 0.4, 0.15);
    }
    // 檐梁
    const N = Math.max(3, Math.ceil(e.L / 2.5)), rs = rise(e.L);
    const out = (f) => 0.25 + 0.9 * f, thick = 0.9;
    const yT = (f) => roofY + 0.35 + rs * f, yB = (f) => yT(f) - band;
    let prev = null;
    for (let k = 0; k <= N; k++) {
      const t = k / N, f = (2 * t - 1) ** 2;
      const px = e.ax + (e.bx - e.ax) * t, pz = e.az + (e.bz - e.az) * t;
      const o = out(f), oi = o - thick;
      const cur = { ox: px + e.nx * o, oz: pz + e.nz * o, ix: px + e.nx * oi, iz: pz + e.nz * oi, yt: yT(f), yb: yB(f) };
      if (prev) {
        const a = prev, b = cur, n = [e.nx, 0, e.nz];
        cer.quad([a.ox, a.yb, a.oz], [b.ox, b.yb, b.oz], [b.ox, b.yt, b.oz], [a.ox, a.yt, a.oz], n); // 外面
        cer.quad([a.ix, a.yt, a.iz], [b.ix, b.yt, b.iz], [b.ox, b.yt, b.oz], [a.ox, a.yt, a.oz], [0, 1, 0]); // 顶面
        sof.quad([a.ix, a.yb, a.iz], [b.ix, b.yb, b.iz], [b.ox, b.yb, b.oz], [a.ox, a.yb, a.oz], [0, -1, 0]); // 底面（檐下）
        cer.quad([a.ix, a.yb, a.iz], [b.ix, b.yb, b.iz], [b.ix, b.yt, b.iz], [a.ix, a.yt, a.iz], [-e.nx, 0, -e.nz]); // 内面
      }
      prev = cur;
    }
  }
  // 凸角立柱（1.8 m 见方，落地到翘角顶）
  const n = edges.length;
  for (let i = 0; i < n; i++) {
    const e1 = edges[(i - 1 + n) % n], e2 = edges[i];
    if (e1.L < 0.8 || e2.L < 0.8) continue;
    const cross = e1.dx * e2.dz - e1.dz * e2.dx;
    if (cross <= 0.2) continue; // 只做凸角
    const x = e2.ax, z = e2.az;
    const cx = x + (e1.nx + e2.nx) * 0.62, cz = z + (e1.nz + e2.nz) * 0.62;
    const top = roofY + 0.35 + Math.max(rise(e1.L), rise(e2.L)) + 0.2;
    const hgt = top - (base - 0.6);
    solid.add(G.box(cx, base - 0.6 + hgt / 2, cz, 1.8, hgt, 1.8, Math.atan2(e2.dz, e2.dx)), M.ceramic, null, { worldUV: 1 });
  }
}
/** 竖线 x=c（vertical=true）与多边形相交的区间（z 方向） */
function clipLine(poly, c, vertical) {
  const zs = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = vertical ? poly[i * 2] : poly[i * 2 + 1], az = vertical ? poly[i * 2 + 1] : poly[i * 2];
    const bx = vertical ? poly[j * 2] : poly[j * 2 + 1], bz = vertical ? poly[j * 2 + 1] : poly[j * 2];
    if ((ax <= c) !== (bx <= c)) zs.push(az + ((c - ax) / (bx - ax)) * (bz - az));
  }
  zs.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < zs.length; i += 2) if (zs[i + 1] - zs[i] > 1) out.push([zs[i] + 0.5, zs[i + 1] - 0.5]);
  return out;
}

// ───────────── 弧形凹顶塔楼（华润 CCBD 四塔：两端最高、中部下凹） ─────────────
/**
 * s: {name, pts, h(公示高度=翘角顶), rise(中部下凹量), style, signs, base}
 * 做法：buildTower 做到 h-rise-1.5 的平屋面，再沿外轮廓（细分）立一圈幕墙“屏”，
 * 顶边高度 y = base + h - rise + rise·((u/U)² + (v/V)² - 1)（u,v 为主轴坐标）：每个立面中点低、两端（转角）最高。
 */
export function arcTower(E, M, s) {
  const pts = G.ccw(s.pts);
  const flatH = s.h - s.rise - 1.5;
  const r = buildTower(E, { ...s, pts, h: flatH, crown: null, roof: { parapet: 0.4, mech: true }, signs: [] });
  const base = r.base;
  const o = G.obb(pts), cs = Math.cos(o.rot), sn = Math.sin(o.rot), U = o.w / 2, V = o.d / 2;
  const yTop = (x, z) => {
    const u = (x - o.cx) * cs + (z - o.cz) * sn, v = -(x - o.cx) * sn + (z - o.cz) * cs;
    return base + s.h - s.rise + s.rise * (Math.min(1, (u / U) ** 2) + Math.min(1, (v / V) ** 2) - 1);
  };
  // 细分外轮廓（每段 ≤ 3 m），使顶边成为平滑弧线
  const sub = [];
  for (const e of edgesOf(pts)) {
    const k = Math.max(1, Math.ceil(e.L / 3));
    for (let i = 0; i < k; i++) sub.push(e.ax + (e.bx - e.ax) * (i / k), e.az + (e.bz - e.az) * (i / k));
  }
  const st = mkStyle({ ...s.style, seed: (s.style?.seed ?? 1) + 0.5 });
  E.fb.ring(sub, sub, base + flatH - 0.05, (x, z) => yTop(x, z), st, { vBase: base });
  // 顶边金属收口 + 内侧深色背板
  E.solid.add(G.wallGeometry(sub, sub, (x, z) => yTop(x, z) - 0.3, (x, z) => yTop(x, z) + 0.25), E.mats.parapet);
  const inner = G.inset(sub, 0.35), rev = [];
  for (let i = inner.length - 2; i >= 0; i -= 2) rev.push(inner[i], inner[i + 1]);
  E.solid.add(G.wallGeometry(rev, rev, base + flatH, (x, z) => yTop(x, z) + 0.2), E.mats.dark);
  E.solid.add(G.annulus(sub, inner, (x, z) => yTop(x, z) + 0.25), E.mats.parapet);
  // 立面中缝（照片 c_3/c_4：长立面正中一道竖向凹缝）
  for (const e of edgesOf(pts)) {
    if (e.L < 28) continue;
    const mx = (e.ax + e.bx) / 2, mz = (e.az + e.bz) / 2;
    E.solid.add(G.box(mx + e.nx * 0.1, base + (s.h - s.rise) / 2, mz + e.nz * 0.1, 0.6, s.h - s.rise - 2, 0.25, Math.atan2(e.dz, e.dx)), E.mats.parapet);
  }
  // 楼顶障碍灯：每个象限取离中心最远的角（即弧顶最高的四角）
  const q = [null, null, null, null];
  for (let i = 0; i < pts.length; i += 2) {
    const u = (pts[i] - o.cx) * cs + (pts[i + 1] - o.cz) * sn, v = -(pts[i] - o.cx) * sn + (pts[i + 1] - o.cz) * cs;
    const k = (u > 0 ? 1 : 0) + (v > 0 ? 2 : 0), sc = Math.abs(u) / U + Math.abs(v) / V;
    if (!q[k] || sc > q[k].sc) q[k] = { sc, x: pts[i], z: pts[i + 1] };
  }
  for (const c of q) if (c) E.beacons.add(c.x, yTop(c.x, c.z) + 0.8, c.z, 0, 4);
  // 招牌（面向 face 方向的立面，贴在上部）
  for (const sg of s.signs || []) {
    const e = pickFace(pts, sg.face[0], sg.face[1]);
    if (!e) continue;
    const t = sg.at ?? 0.5, px = e.ax + (e.bx - e.ax) * t, pz = e.az + (e.bz - e.az) * t;
    E.signs.place(sg.text, { x: px, y: base + s.h - s.rise - sg.down, z: pz }, e.nx, e.nz, sg.h, e.L * 0.6, { color: sg.color, weight: 800, glow: sg.glow || null });
  }
  return r;
}
/** 平顶塔楼（万象天地街区高层）：玻璃塔身 + 顶部 4 m 玻璃塔冠 + 白色屋顶女儿墙（影像可见），MT8 屋顶停机坪 */
export function plainTower(E, t) {
  return buildTower(E, {
    key: t.key, name: t.key, pts: t.pts, h: t.h, base: t.base,
    crown: { h: 4, color: '#e3ebf2', colW: 2.2 },
    roof: t.helipad ? { helipad: true, helipadY: 2.2, mech: false } : { mech: true },
    style: t.style,
  });
}

/** 外法线最接近 (dx,dz) 的最长边 */
export function pickFace(pts, dx, dz, minL = 6) {
  let best = null, bs = -1e9;
  for (const e of edgesOf(G.ccw(pts))) {
    if (e.L < minL) continue;
    const s = e.nx * dx + e.nz * dz + e.L / 500;
    if (s > bs) { bs = s; best = e; }
  }
  return best;
}

// ───────────── 生命之树（Xi'an Tree） ─────────────
/**
 * T: {cx, cz, y0(坑底), top(广场面), pitR, petals:[{y,r,a,w,d,rot}]}
 * 57 m（自地下一层起算）；中央电梯+圆楼梯核心筒（直径约 9 m）；外圈 10 根柱（半径约 7 m）；
 * 花瓣为错位旋转的矩形平台（风车状），下方为米白扇形褶皱底板 + 深古铜肋，边缘竖杆栏杆与植栽。
 */
export function buildTree(E, M, T) {
  const { solid, detail } = E;
  const { cx, cz, y0 } = T;
  // 核心筒（深古铜 + 玻璃）
  solid.add(G.cyl(cx, y0, cz, 4.3, 3.6, 50, 20), M.bronze);
  solid.add(G.cyl(cx, y0 + 50, cz, 3.6, 2.8, 4, 20), M.bronze);
  // 10 根柱：自坑底略向外张开上升（平面 g038：半径约 7 m 一圈八角柱）
  const cols = [];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 + 0.2;
    const x0 = cx + Math.cos(a) * 6.8, z0 = cz + Math.sin(a) * 6.8;
    cols.push({ a, x0, z0 });
    solid.add(tube([x0, y0, z0], [cx + Math.cos(a) * 7.6, y0 + 46, cz + Math.sin(a) * 7.6], 0.62, 0.5, 8), M.bronze);
  }
  const fan = new Tris(), top = new Tris(), led = new Tris();
  const railP = [], railUV = [];
  const RIM = 4; // 每条边的细分数
  for (const [pi, pt] of T.petals.entries()) {
    const px = cx + Math.cos(pt.a) * pt.r, pz = cz + Math.sin(pt.a) * pt.r, py = y0 + pt.y;
    const rim = G.rect(px, pz, pt.w, pt.d, pt.rot);
    // 细分并让四角微微上翘（叶片边缘外卷）
    const R = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      for (let k = 0; k < RIM; k++) {
        const t = k / RIM;
        const x = rim[i * 2] + (rim[j * 2] - rim[i * 2]) * t, z = rim[i * 2 + 1] + (rim[j * 2 + 1] - rim[i * 2 + 1]) * t;
        const lift = 0.5 * (1 - Math.sin(t * Math.PI)); // 角部抬高 0.5 m
        R.push([x, py + lift, z]);
      }
    }
    // 扇形底板：顶点在平台中心偏向核心的一点、平台下方 depth 处
    const depth = 0.58 * Math.max(pt.w, pt.d); // 扇底很深，尖端收向核心筒（照片 c_5/c_12：像从树干伸出的扇形枝）
    const ax = px + (cx - px) * 0.45, az = pz + (cz - pz) * 0.45, ay = py - depth;
    const n = R.length;
    for (let i = 0; i < n; i++) {
      const a = R[i], b = R[(i + 1) % n];
      // 底板朝下（外侧）
      const u0 = (i % 2) * 0.5; // 每两段一道深色肋（每片 8 道）
      fan.tri([ax, ay, az], a, b, [((a[0] + b[0]) / 2 - ax) * 0.2, -1, ((a[2] + b[2]) / 2 - az) * 0.2], [[u0 + 0.25, 0], [u0, 1], [u0 + 0.5, 1]]);
      // 平台顶面（种植土）
      top.tri([px, py + 0.35, pz], [a[0], a[1] + 0.35, a[2]], [b[0], b[1] + 0.35, b[2]], [0, 1, 0]);
      // 边缘翻边（蓝色灯带）
      led.quad([a[0], a[1] - 0.25, a[2]], [b[0], b[1] - 0.25, b[2]], [b[0], b[1] + 0.45, b[2]], [a[0], a[1] + 0.45, a[2]], [(a[0] + b[0]) / 2 - px, 0, (a[2] + b[2]) / 2 - pz]);
      // 竖杆栏杆（1.6 m）
      const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      railP.push(a[0], a[1] + 0.45, a[2], b[0], b[1] + 0.45, b[2], b[0], b[1] + 2.05, b[2], a[0], a[1] + 0.45, a[2], b[0], b[1] + 2.05, b[2], a[0], a[1] + 2.05, a[2]);
      railUV.push(0, 0, L / 1.6, 0, L / 1.6, 1, 0, 0, L / 1.6, 1, 0, 1);
    }
    // 肋梁：从扇底顶点伸向四角与边中点（立体肋）
    for (let i = 0; i < n; i += RIM / 2) detail.add(tube([ax, ay, az], R[i], 0.22, 0.14, 6), M.bronze);
    // 支撑：扇底顶点连到最近的柱
    let best = cols[0], bd = 1e9;
    for (const c of cols) { const d = Math.hypot(c.x0 - ax, c.z0 - az); if (d < bd) { bd = d; best = c; } }
    const cy = Math.max(y0 + 1, ay - 7);
    solid.add(tube([cx + Math.cos(best.a) * 7.2, cy, cz + Math.sin(best.a) * 7.2], [ax, ay, az], 0.55, 0.42, 8), M.bronze);
    // 植栽：小灌木球 + 1~2 棵小树
    const r0 = rng(pi * 31 + 7);
    for (let k = 0; k < 3; k++) {
      const bx = px + (r0() - 0.5) * pt.w * 0.6, bz = pz + (r0() - 0.5) * pt.d * 0.6;
      const s = 0.9 + r0() * 1.1;
      const g = new THREE.IcosahedronGeometry(s, 0); g.scale(1.3, 0.8, 1.3); g.translate(bx, py + 0.35 + s * 0.6, bz);
      detail.add(g, r0() < 0.4 ? M.plantY : M.plant);
    }
    if (pt.w > 9) {
      const bx = px + (r0() - 0.5) * pt.w * 0.4, bz = pz + (r0() - 0.5) * pt.d * 0.4;
      detail.add(G.cyl(bx, py + 0.3, bz, 0.18, 0.12, 2.6, 5), M.trunk);
      const g = new THREE.IcosahedronGeometry(1.9, 0); g.scale(1, 1.2, 1); g.translate(bx, py + 3.6, bz);
      detail.add(g, r0() < 0.5 ? M.plantY : M.leaf);
    }
  }
  solid.add(fan.geometry(), M.fan);
  solid.add(top.geometry(), M.plant);
  solid.add(led.geometry(), M.edgeLed);
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(railP, 3));
  rg.setAttribute('uv', new THREE.Float32BufferAttribute(railUV, 2));
  rg.computeVertexNormals();
  detail.add(rg, M.rail);
}

/** 圆形下沉庭院：坑底铺装、挡墙（陶板）、西侧大台阶、顶部栏杆（夜间蓝色灯带）、坑外铺装环（盖住压低的地形） */
export function sunkenCourt(E, M, S) {
  const { solid, detail } = E;
  const { cx, cz, r, y0, top } = S;
  const seg = 48;
  const floor = new THREE.CircleGeometry(r + 0.5, seg); floor.rotateX(-Math.PI / 2); floor.translate(cx, y0 + 0.04, cz);
  solid.add(floor, M.pave, null, { worldUV: 1 });
  // 挡墙（内侧朝向坑中心）
  const wall = new Tris();
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = [cx + Math.cos(a0) * r, cz + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, cz + Math.sin(a1) * r];
    const am = (a0 + a1) / 2;
    wall.quad([p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], top + 0.05, p1[1]], [p0[0], top + 0.05, p0[1]], [-Math.cos(am), 0, -Math.sin(am)]);
  }
  solid.add(wall.geometry(), M.ceramic, null, { worldUV: 1 });
  // 西侧（朝电视塔/树心广场）弧形大台阶：从广场面下到坑底
  const steps = Math.round((top - y0) / 0.6), aC = Math.PI, span = 0.55;
  const st = new Tris();
  for (let k = 0; k < steps; k++) {
    const yk = top - (k + 1) * (top - y0) / steps, ri = r - k * 0.55, ro = r + 0.2;
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a0 = aC - span + (i / n) * 2 * span, a1 = aC - span + ((i + 1) / n) * 2 * span;
      const P = (a, rr, y) => [cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr];
      st.quad(P(a0, ri, yk), P(a1, ri, yk), P(a1, ro, yk), P(a0, ro, yk), [0, 1, 0]);
      st.quad(P(a0, ri, yk), P(a1, ri, yk), P(a1, ri, yk + (top - y0) / steps), P(a0, ri, yk + (top - y0) / steps), [-Math.cos((a0 + a1) / 2), 0, -Math.sin((a0 + a1) / 2)]);
    }
  }
  solid.add(st.geometry(), E.mats.granite, null, { worldUV: 1 });
  // 坑口栏杆：深古铜扶手 + 蓝色灯带
  const ring = [];
  for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; ring.push(cx + Math.cos(a) * (r + 0.3), cz + Math.sin(a) * (r + 0.3)); }
  const ro = G.ccw(ring), rin = G.inset(ro, 0.25), rinRev = [];
  for (let i = rin.length - 2; i >= 0; i -= 2) rinRev.push(rin[i], rin[i + 1]);
  solid.add(G.wallGeometry(ro, ro, top, top + 1.1), M.bronze);
  solid.add(G.wallGeometry(rinRev, rinRev, top - 0.4, top + 1.1), M.bronze); // 朝坑内一面
  solid.add(G.annulus(ro, rin, top + 1.1), M.edgeLed);
  // 坑外铺装环（压低地形的过渡带被这圈铺装盖住）
  const deck = new THREE.RingGeometry(r + 0.3, r + S.deck, seg, 1); deck.rotateX(-Math.PI / 2); deck.translate(cx, top + 0.06, cz);
  solid.add(deck, M.pave, null, { worldUV: 1 });
  void detail;
}

/** 叶形（透镜形）双曲玻璃天窗：长轴 L、宽 W、脊高 H，沿 rot 方向；脊线为陶板条 */
export function lensSkylight(E, M, s) {
  const { cx, cz, L, W, H, rot, y0 } = s;
  const c = Math.cos(rot), sn = Math.sin(rot);
  const P = (u, v, y) => [cx + u * c - v * sn, y, cz + u * sn + v * c];
  const T = new Tris(), NU = 14, NV = 6;
  const hw = (u) => (W / 2) * (1 - (2 * u / L) ** 2);
  const yy = (u, t) => y0 + H * (1 - (2 * u / L) ** 2) * (1 - Math.abs(t)) ** 1.4;
  for (let i = 0; i < NU; i++) {
    const u0 = -L / 2 + (i / NU) * L, u1 = -L / 2 + ((i + 1) / NU) * L;
    for (let j = 0; j < NV; j++) {
      for (const sgn of [-1, 1]) {
        const t0 = (j / NV) * sgn, t1 = ((j + 1) / NV) * sgn;
        T.quad(P(u0, hw(u0) * t0, yy(u0, t0)), P(u1, hw(u1) * t0, yy(u1, t0)), P(u1, hw(u1) * t1, yy(u1, t1)), P(u0, hw(u0) * t1, yy(u0, t1)), [0, 1, 0]);
      }
    }
  }
  E.solid.add(T.geometry(), M.skylight);
  // 脊线（陶板条）
  for (let i = 0; i < NU; i++) {
    const u0 = -L / 2 + (i / NU) * L, u1 = -L / 2 + ((i + 1) / NU) * L;
    const a = P(u0, 0, yy(u0, 0) + 0.25), b = P(u1, 0, yy(u1, 0) + 0.25);
    E.detail.add(tube(a, b, 0.35, 0.35, 6), M.ceramic, null, { worldUV: 1 });
  }
}

/** 四角星形 / 三角形玻璃天窗（帐篷式尖顶） */
export function starSkylight(E, M, s) {
  const { cx, cz, R, r, H, n, rot, y0 } = s;
  const T = new Tris();
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i / (n * 2)) * Math.PI * 2, rr = i % 2 ? r : R;
    pts.push([cx + Math.cos(a) * rr, y0, cz + Math.sin(a) * rr]);
  }
  const apex = [cx, y0 + H, cz];
  for (let i = 0; i < pts.length; i++) T.tri(apex, pts[i], pts[(i + 1) % pts.length], [0, 1, 0]);
  E.solid.add(T.geometry(), M.skylight);
}

/** 地块铺装（盖住卫星底图里的施工工地）：outer 多边形，holes 挖空（如下沉圆坑），y 为铺装面 */
export function paving(E, mat, outer, holes, y) {
  const toV = (p) => { const o = []; for (let i = 0; i < p.length; i += 2) o.push(new THREE.Vector2(p[i], -p[i + 1])); return o; };
  const shape = new THREE.Shape(toV(G.ccw(outer)));
  for (const h of holes) shape.holes.push(new THREE.Path(toV(h)));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2); // 形状平面 (x, -z) → 世界 (x, 0, z)，法线朝上
  g.translate(0, y, 0);
  E.solid.add(g, mat, null, { worldUV: 1 });
}

/** 连廊：桥面 + 陶板底面 + 玻璃栏板 */
export function bridge(E, M, b) {
  const { ax, az, bx, bz, w, y, th } = b;
  const L = Math.hypot(bx - ax, bz - az), a = Math.atan2(bz - az, bx - ax);
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  E.solid.add(G.box(mx, y - th / 2, mz, L, th, w, a), M.ceramic, null, { worldUV: 1 });
  E.solid.add(G.box(mx, y + 0.02, mz, L, 0.06, w - 0.3, a), E.mats.granite, null, { worldUV: 1 });
  const nx = -Math.sin(a), nz = Math.cos(a);
  for (const sgn of [-1, 1]) {
    const ox = nx * sgn * (w / 2 - 0.15), oz = nz * sgn * (w / 2 - 0.15);
    E.detail.add(G.box(mx + ox, y + 0.6, mz + oz, L, 1.2, 0.05, a), M.glassRail);
    E.detail.add(G.box(mx + ox, y + 1.22, mz + oz, L, 0.08, 0.12, a), M.bronze);
  }
}

/** 银杏（行道树）：树干 + 卵形树冠 */
export function ginkgo(E, M, x, y, z, s = 1) {
  E.detail.add(G.cyl(x, y, z, 0.22 * s, 0.15 * s, 4.5 * s, 6), M.trunk);
  const g = new THREE.IcosahedronGeometry(2.6 * s, 1); g.scale(1, 1.45, 1); g.translate(x, y + 7 * s, z);
  E.detail.add(g, M.leaf);
}

// ───────────── 万象天地：圆形广场退台、球形木格构架 ─────────────
/** 圆形广场：沿弧线逐层外挑的白色楼板檐口 + 玻璃栏板（照片 t2_2：3 层退台，穿孔铝板） */
export function roundPlaza(E, M, s) {
  const { cx, cz, r, a0, a1, base, levels, floorH } = s;
  const N = 32;
  for (let L = 1; L <= levels; L++) {
    // 挑台从弧形立面（半径 r）伸向广场中心；越高越往后退（外缘半径增大）
    const y = base + L * floorH, ri = r - 3.4 + 0.9 * (L - 1), ro = r + 0.3;
    const band = new Tris(), topT = new Tris(), rail = new Tris();
    for (let i = 0; i < N; i++) {
      const t0 = a0 + ((a1 - a0) * i) / N, t1 = a0 + ((a1 - a0) * (i + 1)) / N;
      const P = (a, rad, yy) => [cx + Math.cos(a) * rad, yy, cz + Math.sin(a) * rad];
      const nIn = [-Math.cos((t0 + t1) / 2), 0, -Math.sin((t0 + t1) / 2)];
      band.quad(P(t0, ri, y - 0.9), P(t1, ri, y - 0.9), P(t1, ri, y + 0.25), P(t0, ri, y + 0.25), nIn);
      topT.quad(P(t0, ri, y + 0.25), P(t1, ri, y + 0.25), P(t1, ro, y + 0.25), P(t0, ro, y + 0.25), [0, 1, 0]);
      band.quad(P(t0, ri, y - 0.9), P(t1, ri, y - 0.9), P(t1, ro, y - 0.9), P(t0, ro, y - 0.9), [0, -1, 0]);
      rail.quad(P(t0, ri + 0.1, y + 0.25), P(t1, ri + 0.1, y + 0.25), P(t1, ri + 0.1, y + 1.35), P(t0, ri + 0.1, y + 1.35), nIn);
    }
    E.solid.add(band.geometry(), M.white);
    E.solid.add(topT.geometry(), E.mats.granite, null, { worldUV: 1 });
    E.detail.add(rail.geometry(), M.glassRail);
  }
}
/** 圆柱玻璃体量（圆形广场东侧，照片 t2_2 与协调方档案“圆柱形玻璃中庭体量与观光电梯”；影像量得直径约 18 m，
 *  屋顶为放射 + 环形格栅的采光顶）：玻璃幕墙筒（夜间通亮）+ 每层白色楼板挑檐 + 顶部格栅 */
export function glassDrum(E, M, s) {
  const { cx, cz, r, h, base, floorH } = s;
  const ring = G.circle(cx, cz, r, 28);
  const st = mkStyle({ mode: 6, floorH, colW: 1.6, spandrel: 0.08, mullW: 0.1, lit: 0.95, tint: '#4f6d80', spd: '#d8dadb', seed: 77 });
  E.fb.prism(ring, base - 0.5, base + h, st, { vBase: base });
  for (let y = base + floorH; y < base + h - 0.5; y += floorH) {
    const o = G.circle(cx, cz, r + 0.5, 28), inn = G.circle(cx, cz, r - 0.05, 28);
    E.solid.add(G.annulus(o, inn, y + 0.25), M.white);
    E.solid.add(G.wallGeometry(o, o, y - 0.35, y + 0.25), M.white);
  }
  E.solid.add(G.capGeometry(G.circle(cx, cz, r, 28), base + h + 0.1), M.skylight);
  const rim = G.circle(cx, cz, r + 0.2, 28);
  E.solid.add(G.wallGeometry(rim, rim, base + h - 0.6, base + h + 0.6), M.white);
  const y = base + h + 0.5;
  for (let k = 0; k < 12; k++) { // 放射肋
    const a = (k / 12) * Math.PI * 2;
    E.detail.add(tube([cx, y + 0.6, cz], [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r], 0.16, 0.16, 5), M.wood);
  }
  for (const rr of [r * 0.35, r * 0.7]) { // 环形肋
    for (let i = 0; i < 24; i++) {
      const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2, yy = y + 0.6 * (1 - rr / r);
      E.detail.add(tube([cx + Math.cos(a0) * rr, yy, cz + Math.sin(a0) * rr], [cx + Math.cos(a1) * rr, yy, cz + Math.sin(a1) * rr], 0.13, 0.13, 5), M.wood);
    }
  }
}

/** 万象天地的独栋 / 裙房：穿孔铝板或石材或玻璃盒子（buildPodium），可带竖向百叶 */
export function mtBlock(E, M, b) {
  buildPodium(E, { pts: b.pts, h: b.h, base: b.base, style: b.style, signs: b.signs, roofMat: b.roofMat });
  if (b.perf) { // 上部穿孔铝板带（留出底层橱窗）
    const pts = G.ccw(b.pts), T = new Tris();
    for (const e of edgesOf(pts)) if (e.L > 5 && hash(e.ax, e.az) < b.perf) wallQuad(T, e.ax, e.az, e.bx, e.bz, b.base + 6.2, b.base + b.h - 0.4, 0.25);
    if (!T.empty) E.solid.add(T.geometry(), M.perf, null, { worldUV: 1 });
  }
  if (b.louver) { // 白色横向百叶盒子（“the mixc 万象天地”招牌盒，照片 t2_1）
    const pts = G.ccw(b.pts);
    for (let y = b.base + 7; y < b.base + b.h - 0.5; y += 1.1) {
      const r0 = G.inset(pts, -0.35);
      E.detail.add(G.wallGeometry(r0, r0, y, y + 0.18), M.white);
    }
  }
}

export { Tris, tube, edgesOf, hash, D2R };
