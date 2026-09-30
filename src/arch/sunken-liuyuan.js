// 南门榴园（南门·映巷 榴园片区）下沉广场：永宁门外东侧、护城河南岸、环城南路东段以北。
// 资料与取值见 research/refs/sunken/liuyuan_notes.md（出处：西安晚报 2014-06-30 开园报道、曲江文商“南门·映巷”推介、
// 携程/Trip 游客照片；轮廓按 Google / Esri / Bing 卫星影像与 OSM 步道环量取，世界坐标 X 东 Z 南）。
//
// 形制（照片 + 影像）：
//   · 坑口是一个不规则九边形（约 1800 m²），西北边是贯通全宽的大台阶（跑距 14 m，中间一段 2 m 休息平台，平台上摆黑色花箱），
//     台阶顶直接接地面步道，不设栏杆；其余各边为 B1 商铺立面 + 顶部石材压顶 + 玻璃栏杆。
//   · 北边：地面层“漫咖啡”（灰石墙 + 歇山灰瓦顶）之下的 B1 骑楼，方形青砖柱 + 进深约 3 m 的店面，每根柱前一根黄铜诗词灯柱。
//   · 东边：MOTOTO 101 酒吧；东南斜边：一排酒吧/餐饮（白色遮阳篷）；南边：SUG 白石拱门小店、壁画、通往松园的“南门映巷”地下街入口。
//   · 台阶东侧挡墙上画着秦腔脸谱壁画；坑底浅灰花岗岩铺地，中部偏北一方长条水池 + 木质长凳花箱，外摆白色遮阳伞。
//   · 夜景：暖白为基调、黄光点睛（铜灯柱、玻璃栏杆底部灯带、店面暖光），东侧 LED 大屏与酒吧霓虹招牌。
// 做法：地形在坑口挖洞（terrain.addHole），坑内全部由本文件几何补齐；坑外地形保持原高度，道路/树木/通用建筑按排除区让位。
import * as THREE from 'three';
import * as TX from '../core/textures.js';
import * as G from './sky-geom.js';
import { SignAtlas } from './sky-towers.js';
import { buildArch, roof, eaveLights, hall } from './chinese.js';
import { glowQuad } from './chinese-wall.js';

// ───────────── 实测参数 ─────────────
/** 坑口（世界坐标，俯视 CCW）：A B 为大台阶顶边 */
export const LY_RIM = [
  [136, 979], // A 台阶顶西南端
  [150, 947], // B 台阶顶东北端
  [165, 947], // C
  [165, 963], // D 骑楼西端
  [198, 963], // E 骑楼东端
  [198, 976], // F
  [177, 994], // G 东南斜边
  [151, 993], // H
  [149, 987], // J
];
export const LY_DEPTH = 5.5; // 坑深（B1 店面 4.2 m + 顶板/女儿墙带 1.3 m，照片按人高比例估）
const RUN = 14; // 大台阶水平跑距
const LANDING = [6, 8]; // 休息平台（沿台阶方向的距离）
const TREAD = 0.4;
/** 地面层建筑（坑外，照片 + 影像） */
const MAAN = { x0: 168.5, z0: 940.5, x1: 196, z1: 952.3, h: 5.2 }; // 漫咖啡（北）
const SHALL = { x0: 152, z0: 995.3, x1: 170, z1: 1001.5, h: 4.3 }; // 南侧悬山小殿（照片 02）

const flat = (P) => P.flatMap((p) => p);
/** 地面层小殿配色：新浪博客评“现代味道太浓，色彩单一，一片灰色”；照片 02：青灰砖墙、原木色柱与山花博风、深灰瓦（不用唐风朱柱白壁） */
const LY_PAL = {
  col: 0x6b5842, colBase: 0x8a867e, wall: 0x8e8a82, frame: 0x4a4038, door: 0x4a4038, lattice: 0x4a4038,
  dou: 0x6b5842, gong: 0x6b5842, ang: 0x6b5842, armEnd: 0xb8a888, panel: 0x9a958c, rafter: 0x5e4c3a, rafterEnd: 0xb8a888, flyEnd: 0xb8a888,
  soffit: 0x6e5c48, fascia: 0x5e4c3a, stone: 0xb8b2a6, gable: 0xc8b48c, boFeng: 0x8a6a48, railing: 0x5e5850,
};
export const LY_RIM_FLAT = flat(LY_RIM);

// ───────────── 坑外地面物件（建模与排除区共用同一份常量） ─────────────
const LY_E = LY_RIM.map((p, i) => edgeFrame(p, LY_RIM[(i + 1) % LY_RIM.length]));
/** s 沿边，o 沿内法线（正 = 坑内） */
const lyW = (e, s, o, y) => [e.a[0] + e.ux * s + e.nx * o, y, e.a[1] + e.uz * s + e.nz * o];
/** 诗词灯柱点位：坑外 1.6 m（J–A 边不布，那里贴着外侧环形步道 23107） */
const LY_POLES = (() => {
  const out = [];
  for (const i of [1, 3]) {
    const e = LY_E[i];
    for (let s = 3; s < e.L - 2; s += 9) {
      const p = lyW(e, s, -1.6, 0);
      out.push([p[0], p[2]]);
    }
  }
  const p = lyW(LY_E[6], 1.6, -1.6, 0);
  out.push([p[0], p[2]]);
  return out;
})();
/** “榴园”刻字景石（有向盒：中心、长边方向、半长、半宽） */
const LY_STONE = { x: 139.5, z: 992.5, ux: 0.85, uz: -0.53, hl: 1.7, hw: 0.7 };
/** LED 大屏（东侧坑口外，面向西）及其支架占地 */
const LY_SCREEN = { x: 199.2, zc: 969.5, w: 8 };
const LY_SCREEN_RECT = [199, LY_SCREEN.zc - LY_SCREEN.w / 2 - 0.4, 199.8, LY_SCREEN.zc + LY_SCREEN.w / 2 + 0.4];
/** 东南斜边（E[5]）外坡顶小屋：6 开间 × 3.8 m，进深 1.6 m，台基外扩 0.2 m；
 *  柱网 o∈[-2.4,-0.8]、台基 o∈[-2.6,-0.6]（正好接压顶外沿，不进坑，也不压外侧步道 23106） */
const LY_HUT = { e: 5, o: -1.6, depthW: 1.6, bays: 6, bayW: 3.8, margin: 0.2 };
const lyHutRect = () => {
  const e = LY_E[LY_HUT.e], hs = (LY_HUT.bays * LY_HUT.bayW) / 2 + LY_HUT.margin, ho = LY_HUT.depthW / 2 + LY_HUT.margin;
  const s0 = e.L / 2 - hs, s1 = e.L / 2 + hs, o0 = LY_HUT.o - ho, o1 = LY_HUT.o + ho;
  return [[s0, o1], [s1, o1], [s1, o0], [s0, o0]].map(([s, o]) => lyW(e, s, o, 0)).flatMap((p) => [p[0], p[2]]);
};

// ───────────── 几何累加器：顶点色 + 按面朝向的平面 UV（米） ─────────────
class Mesher {
  constructor() {
    this.pos = [];
    this.col = [];
    this.uv = [];
  }
  tri(a, b, c, col) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    let tx = -nz, tz = nx;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(col.r, col.g, col.b);
      if (Math.abs(ny) > 0.7) this.uv.push(p[0], p[2]);
      else this.uv.push(p[0] * tx + p[2] * tz, p[1]);
    }
  }
  quad(a, b, c, d, col) {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }
  /** 水平多边形（[x,z] 列表），y 高，朝上/朝下 */
  poly(pts, y, col, down = false) {
    if (pts.length < 3) return;
    const V = pts.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(V, []);
    for (const [i, j, k] of tris) {
      const a = [pts[i][0], y, pts[i][1]], b = [pts[j][0], y, pts[j][1]], c = [pts[k][0], y, pts[k][1]];
      // 顶面朝上：俯视 (x,z) 下 CCW 的三角形 → 法线 -Y，所以反序
      const up = (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]) > 0;
      if (up !== down) this.tri(a, c, b, col);
      else this.tri(a, b, c, col);
    }
  }
  /** 轴对齐盒（世界坐标），只出 5 个面（不出底面） */
  box(x0, y0, z0, x1, y1, z1, col, top = col) {
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], top);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], col);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], col);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col);
  }
  /** 定向盒：中心 (cx, cz)，沿 (ux,uz) 半长 hu，沿法向半宽 hv，y0..y1 */
  obox(cx, cz, ux, uz, hu, hv, y0, y1, col, top = col) {
    const vx = -uz, vz = ux;
    const P = (su, sv, y) => [cx + ux * su * hu + vx * sv * hv, y, cz + uz * su * hu + vz * sv * hv];
    this.quad(P(-1, -1, y1), P(-1, 1, y1), P(1, 1, y1), P(1, -1, y1), top);
    this.quad(P(-1, 1, y0), P(1, 1, y0), P(1, 1, y1), P(-1, 1, y1), col);
    this.quad(P(1, -1, y0), P(-1, -1, y0), P(-1, -1, y1), P(1, -1, y1), col);
    this.quad(P(1, 1, y0), P(1, -1, y0), P(1, -1, y1), P(1, 1, y1), col);
    this.quad(P(-1, -1, y0), P(-1, 1, y0), P(-1, 1, y1), P(-1, -1, y1), col);
  }
  cyl(cx, cz, r, y0, y1, col, seg = 10, capCol = col) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * r, cz + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, cz + Math.sin(a1) * r];
      this.quad([p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]], col);
      this.tri([cx, y1, cz], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]], capCol);
    }
  }
  /** 伞：圆锥伞面 + 杆 */
  umbrella(cx, cz, y0, r, h, col, pole) {
    this.cyl(cx, cz, 0.035, y0, y0 + h, pole, 5);
    const seg = 8, yr = y0 + h - 0.45;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * r, yr, cz + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, yr, cz + Math.sin(a1) * r];
      this.tri([cx, y0 + h, cz], p1, p0, col);
      this.tri([cx, y0 + h - 0.02, cz], p0, p1, col);
    }
  }
  mesh(mat, name, { shadow = true } = {}) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = shadow;
    m.receiveShadow = true;
    return m;
  }
}

// ───────────── 多边形工具 ─────────────
/** Sutherland–Hodgman：保留 f(x,z) ≥ 0 的一侧（凹多边形被凸区域裁切同样适用） */
function clipHalf(P, f) {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
function edgeFrame(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
  const ux = dx / L, uz = dz / L;
  // CCW 多边形的内法线 (-dz, dx)
  return { a, b, L, ux, uz, nx: -uz, nz: ux };
}

// ───────────── 材质 ─────────────
/** 顶点色同时乘到自发光上（每家店面/灯各自的夜光颜色） */
function tintEmissive(mat, key) {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n  totalEmissiveRadiance *= vColor.rgb;\n#endif'
    );
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}
function repeatTex(t, meters) {
  const c = t.clone();
  c.wrapS = c.wrapT = THREE.RepeatWrapping;
  c.repeat.set(1 / meters, 1 / meters);
  c.needsUpdate = true;
  return c;
}
function makeMats(ctx) {
  const pave = TX.grain({ color: '#b3afa7', amp: 16, seed: 41, spots: 10, joints: 4 });
  const brick = TX.brick({ color: '#7d7a74', mortar: '#a19c93', cols: 4, rows: 12, seed: 17, variance: 0.08 });
  const M = {
    pave: new THREE.MeshStandardMaterial({ vertexColors: true, map: repeatTex(pave.map, 2.4), normalMap: repeatTex(pave.normalMap, 2.4), roughness: 0.82, side: THREE.DoubleSide }),
    brick: new THREE.MeshStandardMaterial({ vertexColors: true, map: repeatTex(brick.map, 1.8), normalMap: repeatTex(brick.normalMap, 1.8), roughness: 0.9, side: THREE.DoubleSide }),
    plain: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.75, side: THREE.DoubleSide }),
    shop: tintEmissive(new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x3c3a36, roughness: 0.18, metalness: 0.45, emissive: 0xffffff, emissiveIntensity: 0.12, side: THREE.DoubleSide }), 'lyShop'),
    lamp: tintEmissive(new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x8a7a5a, roughness: 0.45, metalness: 0.3, emissive: 0xffffff, emissiveIntensity: 0, side: THREE.DoubleSide }), 'lyLamp'),
    rail: new THREE.MeshStandardMaterial({ color: 0xcfe0e6, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }),
    water: new THREE.MeshStandardMaterial({ color: 0x2c4a58, roughness: 0.06, metalness: 0.55 }),
    // 夜间地面光斑（店面、骑楼筒灯、灯柱照到地上的暖光）：黑色底 + 径向渐变自发光，叠加混合，白天强度 0
    pool: tintEmissive(new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x000000, emissive: 0xffffff, emissiveMap: poolTexture(), emissiveIntensity: 0, roughness: 1, metalness: 0,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 'lyPool'),
  };
  ctx.night.register(M.shop, { day: 0.12, night: 0.85 });
  ctx.night.register(M.pool, { day: 0, night: 1.2 });
  ctx.night.register(M.lamp, { day: 0, night: 2.6 });
  return M;
}

/** 光斑贴图：中心亮、边缘平滑衰减到 0 */
function poolTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.35, '#a0a0a0');
  gr.addColorStop(0.7, '#303030');
  gr.addColorStop(1, '#000000');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 秦腔脸谱壁画（照片 39：台阶东侧挡墙上两张大脸谱） */
function muralTexture() {
  const c = TX.canvas(1024, 256), g = c.getContext('2d');
  g.fillStyle = '#8f8a82';
  g.fillRect(0, 0, 1024, 256);
  const mask = (cx, base, accent) => {
    g.save();
    g.translate(cx, 128);
    g.fillStyle = base;
    g.beginPath();
    g.ellipse(0, 6, 78, 104, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = accent;
    g.beginPath();
    g.moveTo(-78, -30); g.quadraticCurveTo(0, -120, 78, -30); g.quadraticCurveTo(0, -60, -78, -30);
    g.fill();
    g.fillStyle = '#111';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(s * 32, -8, 26, 14, s * 0.35, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#f2efe8';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.arc(s * 30, -8, 6, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#1a1a1a';
    g.beginPath();
    g.ellipse(0, 58, 34, 22, 0, 0, Math.PI);
    g.fill();
    g.fillStyle = '#c8b04a';
    g.fillRect(-6, -60, 12, 70);
    g.restore();
  };
  mask(300, '#c93a2e', '#1f1f1f');
  mask(560, '#f1ece2', '#b0302a');
  // 零散涂鸦色块
  const cols = ['#3b6ea8', '#d9a13b', '#5a9a5a', '#9a4aa0'];
  for (let i = 0; i < 14; i++) {
    g.fillStyle = cols[i % 4];
    g.globalAlpha = 0.55;
    g.beginPath();
    g.arc(720 + (i % 5) * 60, 60 + ((i * 37) % 150), 14 + (i % 3) * 8, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
/** LED 大屏画面（照片 s1/04：蓝紫抽象流光 + 演出信息） */
function screenTexture() {
  const c = TX.canvas(512, 192), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 512, 192);
  gr.addColorStop(0, '#1a1f6e');
  gr.addColorStop(0.5, '#5b2a9a');
  gr.addColorStop(1, '#0d4d7a');
  g.fillStyle = gr;
  g.fillRect(0, 0, 512, 192);
  g.lineWidth = 10;
  for (let i = 0; i < 6; i++) {
    g.strokeStyle = ['#ff5ab4', '#46d2ff', '#ffd24a', '#8a6bff', '#ff8a3a', '#6affc8'][i];
    g.globalAlpha = 0.7;
    g.beginPath();
    g.moveTo(-20, 150 - i * 18);
    g.bezierCurveTo(140, 20 + i * 12, 300, 190 - i * 10, 540, 40 + i * 14);
    g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = '#ffffff';
  g.font = '700 52px "PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
  g.fillText('光音 LIVE', 30, 110);
  g.font = '600 26px sans-serif';
  g.fillText('TONIGHT 21:00', 32, 150);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const C = (h) => new THREE.Color(h);

/**
 * 建造榴园。site = {top（坑口压顶高度，已高于洞口一圈地形）, ground(x,z)（坑外地面高）}
 * 返回 {group, lights:[{position,color,intensity,distance}], label:Vector3}
 */
export function buildLiuyuan(ctx, site) {
  const T0 = site.top, D = LY_DEPTH, Yf = T0 - D;
  const rise = D / 32;
  const M = makeMats(ctx);
  const pave = new Mesher(), brick = new Mesher(), plain = new Mesher(), metal = new Mesher(), shop = new Mesher(), lamp = new Mesher(), rail = new Mesher(), water = new Mesher();
  const signs = new SignAtlas(ctx, 2048, 1024, { rowH: 96, side: THREE.FrontSide });
  const group = new THREE.Group();
  group.name = '南门榴园';
  const lights = [];

  const col = {
    pave: C('#ffffff'), paveDark: C('#b9b5ad'), step: C('#f2efe9'), stepEdge: C('#d9d5cd'), brick: C('#ffffff'), brickDark: C('#d6d2ca'),
    coping: C('#dcd8d0'), stone: C('#c9c4ba'), frame: C('#2e3033'), wood: C('#8a5f3c'), woodDark: C('#5e3f27'), ceil: C('#cfccc6'),
    planter: C('#26282a'), soil: C('#3b2d22'), handrail: C('#9aa0a6'), brass: C('#b08d4a'), white: C('#f4f1ea'), pole: C('#6d6f72'),
  };
  const rim = LY_RIM;
  const A = rim[0], B = rim[1];
  const ab = edgeFrame(A, B);
  const n = { x: ab.nx, z: ab.nz }; // 台阶下行方向（指向坑内）
  const dOf = (p) => (p[0] - A[0]) * n.x + (p[1] - A[1]) * n.z;

  // ───── 1. 大台阶（西北边全宽）+ 休息平台 + 坑底 ─────
  const riserDs = [];
  for (let j = 0; j < 16; j++) riserDs.push(j * TREAD); // 上跑：0 … 6.0
  for (let j = 0; j < 16; j++) riserDs.push(LANDING[1] + j * TREAD); // 下跑：8.0 … 14.0
  const strip = (d0, d1) => clipHalf(clipHalf(rim, (p) => dOf(p) - d0), (p) => d1 - dOf(p));
  const segAt = (d) => {
    // 直线 d=const 与坑口的交段（台阶区只交两点）
    const P = strip(d - 0.001, d + 0.001);
    if (P.length < 2) return null;
    let lo = null, hi = null;
    for (const p of P) {
      const t = (p[0] - A[0]) * ab.ux + (p[1] - A[1]) * ab.uz;
      if (!lo || t < lo.t) lo = { t, p };
      if (!hi || t > hi.t) hi = { t, p };
    }
    const ex = (q, dd) => [q[0] + n.x * (dd - dOf(q)), q[1] + n.z * (dd - dOf(q))];
    return [ex(lo.p, d), ex(hi.p, d)];
  };
  for (let k = 0; k < riserDs.length; k++) {
    const d = riserDs[k];
    const yHi = T0 - k * rise, yLo = T0 - (k + 1) * rise;
    const s = segAt(d);
    if (s) pave.quad([s[0][0], yLo, s[0][1]], [s[1][0], yLo, s[1][1]], [s[1][0], yHi, s[1][1]], [s[0][0], yHi, s[0][1]], col.stepEdge);
    const dNext = k === riserDs.length - 1 ? null : riserDs[k + 1];
    if (dNext === null) break; // 最后一级之后是坑底
    const P = strip(d, dNext);
    pave.poly(P, yLo, k === 15 ? col.pave : col.step);
  }
  // 坑底（台阶之外）
  const floorP = clipHalf(rim, (p) => dOf(p) - RUN);
  pave.poly(floorP, Yf, col.pave);
  // 台阶顶外侧铺装平台（盖住洞口外缘，地形在其下）
  {
    const e = 3.2, ext = 0.6;
    const a0 = [A[0] - ab.ux * ext, A[1] - ab.uz * ext], b0 = [B[0] + ab.ux * ext, B[1] + ab.uz * ext];
    const o = (p) => [p[0] - n.x * e, p[1] - n.z * e];
    pave.poly([a0, b0, o(b0), o(a0)], T0, col.pave);
    for (const [p, q] of [[o(a0), o(b0)], [a0, o(a0)], [o(b0), b0]]) pave.quad([p[0], T0 - 0.9, p[1]], [q[0], T0 - 0.9, q[1]], [q[0], T0, q[1]], [p[0], T0, p[1]], col.stone);
  }
  // 休息平台上的黑色花箱（照片 39）
  {
    const s = segAt((LANDING[0] + LANDING[1]) / 2);
    if (s) {
      const L = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
      const y = T0 - 16 * rise;
      for (let t = 2.2; t < L - 1.5; t += 3.4) {
        const cx = s[0][0] + ab.ux * t, cz = s[0][1] + ab.uz * t;
        plain.obox(cx, cz, ab.ux, ab.uz, 0.6, 0.3, y, y + 0.55, col.planter, col.soil);
        const fl = [C('#d8342c'), C('#f0c030'), C('#e86aa0')][Math.floor(t) % 3];
        plain.obox(cx, cz, ab.ux, ab.uz, 0.52, 0.24, y + 0.55, y + 0.78, fl);
      }
    }
  }

  // ───── 2. 挡墙与立面（AB 之外的各边） ─────
  const E = rim.map((p, i) => edgeFrame(p, rim[(i + 1) % rim.length]));
  const W = (e, s, o, y) => [e.a[0] + e.ux * s + e.nx * o, y, e.a[1] + e.uz * s + e.nz * o]; // s 沿边，o 沿内法线（正 = 坑内）
  // 地面光斑：沿边 s±hs、沿法线 o±ho 的矩形，径向渐变贴图；k 为亮度系数
  const poolP = [], poolC = [], poolU = [];
  const addPool = (e, s, o, hs, ho, hex, k = 1) => {
    const c = C(hex);
    const q = [W(e, s - hs, o - ho, Yf + 0.02), W(e, s + hs, o - ho, Yf + 0.02), W(e, s + hs, o + ho, Yf + 0.02), W(e, s - hs, o + ho, Yf + 0.02)];
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const i of [0, 2, 1, 0, 3, 2]) {
      poolP.push(...q[i]);
      poolC.push(c.r * k, c.g * k, c.b * k);
      poolU.push(...uv[i]);
    }
  };
  /** 墙面矩形（内侧面），o=0 */
  const wallRect = (mesher, e, s0, s1, y0, y1, c, o = 0) => mesher.quad(W(e, s0, o, y0), W(e, s1, o, y0), W(e, s1, o, y1), W(e, s0, o, y1), c);
  /**
   * 一条边的立面：openings = [{s0, s1, y1, depth, kind, ...}]，其余是青砖墙；开口做侧壁/顶板/底板与后壁。
   * kind: 'shop'（玻璃店面）| 'arcade'（骑楼：后壁店面 + 天花）| 'portal'（地下街入口）| 'door'
   */
  const facade = (e, openings) => {
    // 墙面：按开口把 [0,L]×[Yf,T0] 切成格子
    const ss = new Set([0, e.L]), ys = new Set([Yf, T0]);
    for (const op of openings) { ss.add(op.s0); ss.add(op.s1); ys.add(Yf + op.y1); }
    const S = [...ss].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b);
    for (let i = 0; i + 1 < S.length; i++)
      for (let j = 0; j + 1 < Y.length; j++) {
        const sm = (S[i] + S[i + 1]) / 2, ym = (Y[j] + Y[j + 1]) / 2;
        if (openings.some((op) => sm > op.s0 && sm < op.s1 && ym < Yf + op.y1)) continue;
        wallRect(brick, e, S[i], S[i + 1], Y[j], Y[j + 1], ym > T0 - 1.3 ? col.brickDark : col.brick);
      }
    // 墙脚石材踢脚（0.35 m）
    for (let i = 0; i + 1 < S.length; i++) {
      const sm = (S[i] + S[i + 1]) / 2;
      if (openings.some((op) => sm > op.s0 && sm < op.s1)) continue;
      const P0 = W(e, S[i], 0.04, Yf), P1 = W(e, S[i + 1], 0.04, Yf);
      plain.quad(P0, P1, [P1[0], Yf + 0.35, P1[2]], [P0[0], Yf + 0.35, P0[2]], col.stone);
    }
    for (const op of openings) {
      const dep = op.depth, y1 = Yf + op.y1;
      // 侧壁、顶板、底板
      brick.quad(W(e, op.s0, -dep, Yf), W(e, op.s0, 0, Yf), W(e, op.s0, 0, y1), W(e, op.s0, -dep, y1), col.brickDark);
      brick.quad(W(e, op.s1, 0, Yf), W(e, op.s1, -dep, Yf), W(e, op.s1, -dep, y1), W(e, op.s1, 0, y1), col.brickDark);
      plain.quad(W(e, op.s0, 0, y1), W(e, op.s1, 0, y1), W(e, op.s1, -dep, y1), W(e, op.s0, -dep, y1), op.kind === 'arcade' ? col.ceil : col.stone);
      pave.quad(W(e, op.s0, -dep, Yf + 0.005), W(e, op.s1, -dep, Yf + 0.005), W(e, op.s1, 0, Yf + 0.005), W(e, op.s0, 0, Yf + 0.005), col.paveDark);
      if (op.kind === 'portal') {
        // 地下街：通道尽头暗色 + 顶部灯带
        plain.quad(W(e, op.s0, -dep, Yf), W(e, op.s1, -dep, Yf), W(e, op.s1, -dep, y1), W(e, op.s0, -dep, y1), C('#2a2622'));
        shop.quad(W(e, op.s0 + 0.6, -dep + 0.02, Yf + 0.4), W(e, op.s1 - 0.6, -dep + 0.02, Yf + 0.4), W(e, op.s1 - 0.6, -dep + 0.02, y1 - 0.6), W(e, op.s0 + 0.6, -dep + 0.02, y1 - 0.6), C('#ffcf8a'));
        addPool(e, (op.s0 + op.s1) / 2, 1.4, (op.s1 - op.s0) * 0.6, 2.0, '#ffc070', 0.9);
        for (let k = 1; k < dep; k += 1.6) {
          const q0 = W(e, op.s0 + 0.8, -k, y1 - 0.02), q1 = W(e, op.s1 - 0.8, -k, y1 - 0.02), q2 = W(e, op.s1 - 0.8, -k - 0.25, y1 - 0.02), q3 = W(e, op.s0 + 0.8, -k - 0.25, y1 - 0.02);
          lamp.quad(q0, q3, q2, q1, C('#fff2d8'));
        }
        continue;
      }
      // 后壁：店面玻璃（arcade 的后壁按店分间）
      const backO = -dep + 0.02;
      const glassTop = Yf + (op.glassTop ?? op.y1 - 0.25);
      const units = op.units || [[op.s0, op.s1, op.glow || '#ffd9a0', op.sign]];
      for (const [u0, u1, gl, sg] of units) {
        const g0 = u0 + 0.15, g1 = u1 - 0.15;
        const um = (u0 + u1) / 2;
        if (op.kind === 'arcade') {
          addPool(e, um, -dep * 0.5, (u1 - u0) * 0.5, dep * 0.55, gl, 0.9); // 骑楼内筒灯
          addPool(e, um, 1.2, (u1 - u0) * 0.45, 1.6, gl, 0.45); // 溢出到广场
        } else addPool(e, um, 1.0, (u1 - u0) * 0.6, 1.5, gl, 0.8);
        shop.quad(W(e, g0, backO, Yf + 0.12), W(e, g1, backO, Yf + 0.12), W(e, g1, backO, glassTop), W(e, g0, backO, glassTop), C(gl));
        // 竖梃 + 横档
        const nm = Math.max(1, Math.round((g1 - g0) / 1.5));
        for (let k = 0; k <= nm; k++) {
          const s = g0 + ((g1 - g0) * k) / nm;
          const c0 = W(e, s, backO + 0.06, Yf), P = [c0[0], c0[2]];
          metal.obox(P[0], P[1], e.ux, e.uz, 0.045, 0.05, Yf, glassTop, col.frame);
        }
        const hb = W(e, (g0 + g1) / 2, backO + 0.06, 0);
        metal.obox(hb[0], hb[2], e.ux, e.uz, (g1 - g0) / 2, 0.05, glassTop - 0.08, glassTop + 0.04, col.frame);
        metal.obox(hb[0], hb[2], e.ux, e.uz, (g1 - g0) / 2, 0.05, Yf + 2.5, Yf + 2.58, col.frame);
        // 店招（玻璃上方的招牌带）
        if (sg) {
          const sy0 = glassTop + 0.1, sy1 = Math.min(Yf + op.y1 - 0.08, glassTop + 0.85);
          const mid = W(e, (u0 + u1) / 2, backO + 0.03, 0);
          plain.obox(mid[0], mid[2], e.ux, e.uz, (u1 - u0) / 2 - 0.25, 0.03, sy0, sy1, C(sg.bg || '#1c1c1e'));
          const p = W(e, (u0 + u1) / 2, backO + 0.1 - 0.45, (sy0 + sy1) / 2); // place() 再沿法线外推 0.45
          signs.place(sg.t, new THREE.Vector3(p[0], p[1], p[2]), e.nx, e.nz, (sy1 - sy0) * 0.62, (u1 - u0) * 0.8, { color: sg.c || '#ffffff', weight: 700 });
        }
      }
    }
  };
  const rimH = T0; // 墙顶 = 压顶底
  // 边 1：B→C（台阶东北侧挡墙）
  facade(E[1], []);
  // 边 2：C→D（脸谱壁画墙）
  facade(E[2], []);
  {
    const e = E[2];
    const tex = muralTexture();
    const mm = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
    const s0 = 1.2, s1 = e.L - 1.0, y0 = Yf + 0.5, y1 = T0 - 0.35;
    const g = new THREE.BufferGeometry();
    // 从坑内朝东看：s0（北）在左
    const P = [W(e, s0, 0.02, y0), W(e, s1, 0.02, y0), W(e, s1, 0.02, y1), W(e, s0, 0.02, y1)];
    g.setAttribute('position', new THREE.Float32BufferAttribute([...P[0], ...P[1], ...P[2], ...P[0], ...P[2], ...P[3]], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mm);
    m.name = '脸谱壁画';
    m.receiveShadow = true;
    group.add(m);
  }
  // 边 3：D→E 骑楼（地面层漫咖啡之下）
  const arcShops = [
    { t: '光音LIVE', bg: '#101014', c: '#ff5ab4', gl: '#ff9ed6' },
    { t: '诺茉', bg: '#e9e4da', c: '#3a3530', gl: '#ffe6c4' },
    { t: '桂君的土豆汤', bg: '#1f2b24', c: '#f2e6c8', gl: '#ffd9a0' },
    { t: '薇酌饮', bg: '#5a1f1f', c: '#f5dfb0', gl: '#ffc98a' },
    { t: '7CUPS', bg: '#141414', c: '#46d2ff', gl: '#a8e8ff' },
    { t: '暮色天珍', bg: '#2a1840', c: '#ffcf6a', gl: '#ffb070' },
    { t: '串天下', bg: '#8a1c14', c: '#ffe08a', gl: '#ffc07a' },
  ];
  {
    const e = E[3], s0 = 0.9, s1 = e.L - 0.9, nb = arcShops.length, bw = (s1 - s0) / nb;
    const units = arcShops.map((sh, k) => [s0 + k * bw, s0 + (k + 1) * bw, sh.gl, { t: sh.t, bg: sh.bg, c: sh.c }]);
    facade(e, [{ s0, s1, y1: 4.2, depth: 3.2, kind: 'arcade', glassTop: 3.25, units }]);
    // 方形青砖柱 + 柱前黄铜诗词灯柱 + 天花筒灯
    for (let k = 1; k < nb; k++) {
      const s = s0 + k * bw, c = W(e, s, -0.45, 0);
      brick.obox(c[0], c[2], e.ux, e.uz, 0.45, 0.45, Yf, Yf + 4.19, col.brick); // 柱顶低于天花 1 cm，免得共面闪烁
      const lp = W(e, s, 0.55, 0);
      metal.cyl(lp[0], lp[2], 0.2, Yf, Yf + 0.25, col.frame, 10);
      lamp.cyl(lp[0], lp[2], 0.13, Yf + 0.25, Yf + 2.4, C('#ffc85a'), 10, C('#ffe9b0'));
      metal.cyl(lp[0], lp[2], 0.16, Yf + 2.4, Yf + 2.52, C('#6a5530'), 10);
      addPool(e, s, 0.55, 1.4, 1.4, '#ffc85a', 0.7);
    }
    for (let k = 0; k < nb; k++) {
      const s = s0 + (k + 0.5) * bw;
      for (const o of [-1.0, -2.3]) {
        const q = W(e, s, o, Yf + 4.18);
        lamp.box(q[0] - 0.14, q[1] - 0.02, q[2] - 0.14, q[0] + 0.14, q[1], q[2] + 0.14, C('#fff4dc'));
      }
    }
    for (const k of [1, 3, 5]) {
      const L = W(e, s0 + (k + 0.5) * bw, -1.6, Yf + 3.6);
      lights.push({ position: new THREE.Vector3(L[0], L[1], L[2]), color: 0xffc78a, intensity: 2.2, distance: 16 });
    }
  }
  // 边 4：E→F MOTOTO 101
  facade(E[4], [{ s0: 1.0, s1: E[4].L - 1.0, y1: 3.8, depth: 0.45, kind: 'shop', glassTop: 3.3, glow: '#ff86c8', sign: { t: 'MOTOTO 101', bg: '#0e0e10', c: '#ff4fa8' } }]);
  // 边 5：F→G 东南斜边一排酒吧/餐饮（白色遮阳篷）
  const seShops = [
    { t: 'CODE酒吧', bg: '#111', c: '#f0f0f0', gl: '#d8e4ff' },
    { t: '猩猩地堡', bg: '#3d2a14', c: '#ffcf6a', gl: '#ffb86a' },
    { t: 'LA咖啡', bg: '#ece6da', c: '#5a3a24', gl: '#ffe0b0' },
    { t: '东湖水岸', bg: '#153a3a', c: '#e8f4ee', gl: '#ffe6c4' },
  ];
  {
    const e = E[5], s0 = 1.0, s1 = e.L - 1.0, nb = seShops.length, bw = (s1 - s0) / nb;
    const ops = seShops.map((sh, k) => ({ s0: s0 + k * bw + 0.4, s1: s0 + (k + 1) * bw - 0.4, y1: 3.7, depth: 0.45, kind: 'shop', glassTop: 3.2, glow: sh.gl, sign: { t: sh.t, bg: sh.bg, c: sh.c } }));
    facade(e, ops);
    for (const op of ops) {
      // 遮阳篷（白 / 深绿相间）
      const cA = op === ops[1] || op === ops[3] ? C('#2f5a45') : C('#f1eee6');
      const a0 = W(e, op.s0 + 0.1, 0, Yf + 3.95), a1 = W(e, op.s1 - 0.1, 0, Yf + 3.95), b1 = W(e, op.s1 - 0.1, 1.4, Yf + 3.45), b0 = W(e, op.s0 + 0.1, 1.4, Yf + 3.45);
      plain.quad(a0, a1, b1, b0, cA);
      plain.quad(b0, b1, [b1[0], b1[1] - 0.25, b1[2]], [b0[0], b0[1] - 0.25, b0[2]], cA);
    }
  }
  // 边 6：G→H 南边：小店 + SUG 白石拱门 + 壁画 + 地下街入口“南门映巷”
  {
    const e = E[6];
    facade(e, [
      { s0: 1.2, s1: 6.2, y1: 3.6, depth: 0.45, kind: 'shop', glassTop: 3.1, glow: '#ffe6c4', sign: { t: '十悦·OCT', bg: '#222', c: '#e8d6a8' } },
      { s0: 8.6, s1: 11.4, y1: 3.2, depth: 0.5, kind: 'door', glassTop: 3.0, glow: '#ffdcae' },
      { s0: 18.6, s1: 23.2, y1: 3.4, depth: 9, kind: 'portal' },
    ]);
    // SUG 白石门套 + 半圆拱楣 + 招牌
    const cx = 10;
    for (const s of [8.25, 11.75]) {
      const q = W(e, s, 0.15, 0);
      plain.obox(q[0], q[2], e.ux, e.uz, 0.35, 0.15, Yf, Yf + 3.2, col.white);
    }
    const arcC = W(e, cx, 0.15, Yf + 3.2);
    for (let i = 0; i < 12; i++) {
      const a0 = (i / 12) * Math.PI, a1 = ((i + 1) / 12) * Math.PI, r0 = 1.4, r1 = 2.0;
      const P = (a, r) => [arcC[0] + e.ux * Math.cos(a) * r, Yf + 3.2 + Math.sin(a) * r * 0.6, arcC[2] + e.uz * Math.cos(a) * r];
      const off = (p) => [p[0] + e.nx * 0.16, p[1], p[2] + e.nz * 0.16];
      plain.quad(off(P(a0, r0)), off(P(a0, r1)), off(P(a1, r1)), off(P(a1, r0)), col.white);
    }
    const sp = W(e, cx, 0.3 - 0.45, Yf + 4.85);
    signs.place('SUG', new THREE.Vector3(sp[0], sp[1], sp[2]), e.nx, e.nz, 0.55, 3, { color: '#c8a24a', weight: 700 });
    // 壁画（城墙夜景）面板
    const m0 = 12.6, m1 = 17.4;
    const mc = [C('#2a3a6a'), C('#d8a040'), C('#6a2a2a'), C('#3a6a5a')];
    for (let k = 0; k < 8; k++) {
      const s = m0 + ((m1 - m0) * k) / 8, s2 = m0 + ((m1 - m0) * (k + 1)) / 8;
      plain.quad(W(e, s, 0.03, Yf + 0.6), W(e, s2, 0.03, Yf + 0.6), W(e, s2, 0.03, Yf + 3.4), W(e, s, 0.03, Yf + 3.4), mc[k % 4]);
    }
    // 地下街入口牌匾（深红底金字）
    const pc = W(e, 20.9, 0.08, 0);
    plain.obox(pc[0], pc[2], e.ux, e.uz, 2.4, 0.08, Yf + 3.55, Yf + 4.45, C('#6e1a14'));
    const pp = W(e, 20.9, 0.2 - 0.45, Yf + 4.0);
    signs.place('南门映巷', new THREE.Vector3(pp[0], pp[1], pp[2]), e.nx, e.nz, 0.62, 4.4, { color: '#f0c860', weight: 700, serif: true });
    const L = W(e, 20.9, 1.5, Yf + 3.2);
    lights.push({ position: new THREE.Vector3(L[0], L[1], L[2]), color: 0xffc070, intensity: 1.6, distance: 12 });
  }
  facade(E[7], []);
  facade(E[8], []);

  // ───── 3. 压顶 + 玻璃栏杆 + 底部灯带（AB 台阶顶除外） ─────
  for (let i = 1; i < E.length; i++) {
    const e = E[i];
    // 相邻边转角处压顶互相搭接 0.6 m
    const s0 = -0.6, s1 = e.L + 0.6;
    const q = (s, o, y) => W(e, s, o, y);
    // 顶面、内侧面（墙顶以上）、外侧面（压到地形以下）
    plain.quad(q(s0, 0.02, rimH + 0.14), q(s1, 0.02, rimH + 0.14), q(s1, -0.62, rimH + 0.14), q(s0, -0.62, rimH + 0.14), col.coping);
    plain.quad(q(s0, 0.02, rimH - 0.12), q(s1, 0.02, rimH - 0.12), q(s1, 0.02, rimH + 0.14), q(s0, 0.02, rimH + 0.14), col.coping);
    plain.quad(q(s1, -0.62, rimH - 0.9), q(s0, -0.62, rimH - 0.9), q(s0, -0.62, rimH + 0.14), q(s1, -0.62, rimH + 0.14), col.stone);
    if (i === 1 || i === 8) {
      // 台阶两侧：不锈钢栏杆（照片 01：暖光玻璃栏板）
    }
    const r0 = 0.05, r1 = e.L - 0.05;
    rail.quad(q(r0, -0.3, rimH + 0.14), q(r1, -0.3, rimH + 0.14), q(r1, -0.3, rimH + 1.15), q(r0, -0.3, rimH + 1.15), col.white);
    metal.obox(...(() => { const c = q(e.L / 2, -0.3, 0); return [c[0], c[2]]; })(), e.ux, e.uz, e.L / 2, 0.035, rimH + 1.15, rimH + 1.21, col.handrail);
    for (let s = 0; s <= e.L; s += 1.5) {
      const c = q(Math.min(s, e.L - 0.03), -0.3, 0);
      metal.obox(c[0], c[2], e.ux, e.uz, 0.02, 0.02, rimH + 0.14, rimH + 1.15, col.handrail);
    }
    // 栏板底部暖光灯带（坑内一侧）
    lamp.quad(q(r0, 0.03, rimH + 0.02), q(r1, 0.03, rimH + 0.02), q(r1, 0.03, rimH + 0.08), q(r0, 0.03, rimH + 0.08), C('#ffcf7a'));
  }

  // ───── 4. 坑底陈设：水池 + 木长凳花箱、外摆伞、彩色方块雕塑、人 ─────
  {
    const x0 = 172, x1 = 188.5, z0 = 966.6, z1 = 971;
    plain.box(x0, Yf, z0, x1, Yf + 0.34, z0 + 0.3, col.stone);
    plain.box(x0, Yf, z1 - 0.3, x1, Yf + 0.34, z1, col.stone);
    plain.box(x0, Yf, z0 + 0.3, x0 + 0.3, Yf + 0.34, z1 - 0.3, col.stone);
    plain.box(x1 - 0.3, Yf, z0 + 0.3, x1, Yf + 0.34, z1 - 0.3, col.stone);
    water.poly([[x0 + 0.3, z0 + 0.3], [x1 - 0.3, z0 + 0.3], [x1 - 0.3, z1 - 0.3], [x0 + 0.3, z1 - 0.3]], Yf + 0.24, C('#ffffff'));
    // 木质长凳花箱（照片 s1/04：水池边一条木箱）
    plain.box(173.5, Yf, 971.3, 187.5, Yf + 0.48, 972.9, col.wood, C('#9a6c46'));
    for (const [a, b, c] of [[173.8, 176.5, '#d8342c'], [184.5, 187.2, '#f0c030']]) plain.box(a, Yf + 0.48, 971.5, b, Yf + 0.72, 972.7, C(c));
    // 水池底灯
    for (let x = x0 + 1.5; x < x1 - 1; x += 3) lamp.box(x - 0.1, Yf + 0.18, z0 + 0.45, x + 0.1, Yf + 0.22, z0 + 0.65, C('#9fd8ff'));
  }
  // 外摆伞（按各边的沿边距离 s / 离墙距离 o 摆放，保证伞面不碰墙）
  const umbs = [[3, 2.9, 2.4, '#f4f1ea'], [3, 30.1, 2.4, '#f4f1ea'], [5, 4, 3.2, '#f4f1ea'], [5, 17.5, 3.2, '#c9442f'], [5, 24, 3.2, '#f4f1ea'], [6, 3.7, 3.0, '#f4f1ea'], [6, 14.8, 3.2, '#2f5a45']].map(([i, s, o, c]) => {
    const p = W(E[i], s, o, 0);
    return [p[0], p[2], 1.3, C(c)];
  });
  for (const [x, z, r, c] of umbs) {
    plain.umbrella(x, z, Yf, r, 2.5, c, col.pole);
    plain.cyl(x, z, 0.38, Yf + 0.72, Yf + 0.76, col.frame, 10);
    plain.cyl(x, z, 0.05, Yf, Yf + 0.72, col.frame, 5);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + x, sx = x + Math.cos(a) * 0.75, sz = z + Math.sin(a) * 0.75;
      plain.box(sx - 0.2, Yf, sz - 0.2, sx + 0.2, Yf + 0.45, sz + 0.2, col.frame, col.woodDark);
    }
  }
  // 彩色叠箱雕塑（照片 39 右侧）
  {
    const bx = 186.6, bz = 979.2, cs = ['#d8342c', '#3b8ad6', '#f0c030', '#5ab46a', '#b04ac8', '#ff8a3a'];
    plain.box(bx - 1.6, Yf, bz - 1.2, bx + 1.6, Yf + 0.15, bz + 1.2, col.frame);
    for (let k = 0; k < 6; k++) {
      const o = (k % 2 ? 0.25 : -0.2), w = 0.75 - k * 0.04;
      plain.box(bx - w + o, Yf + 0.15 + k * 0.5, bz - 0.55, bx + w + o, Yf + 0.62 + k * 0.5, bz + 0.55, C(cs[k]));
    }
  }
  // 坑内暖光点光源 + 对应的地面光斑（点光源池只点亮最近几盏，远看靠光斑）
  const addPoolXZ = (x, z, r, hex, k) => addPool({ a: [x, z], ux: 1, uz: 0, nx: 0, nz: 1 }, 0, 0, r, r, hex, k);
  addPoolXZ(172, 980, 8, '#ffc27a', 0.4);
  addPoolXZ(186.6, 979.2, 3.2, '#ffb8e0', 0.45);
  lights.push({ position: new THREE.Vector3(172, Yf + 4.5, 980), color: 0xffc27a, intensity: 3, distance: 32 });
  lights.push({ position: new THREE.Vector3(188, Yf + 4, 972), color: 0xffb8e0, intensity: 1.6, distance: 20 });

  // ───── 5. 地面层：诗词灯柱、LED 大屏、“榴园”石、外摆 ─────
  const gy = (x, z) => site.ground(x, z);
  const poleAt = (x, z) => {
    const y = gy(x, z) - 0.2;
    metal.cyl(x, z, 0.16, y, y + 0.35, col.frame, 10);
    metal.cyl(x, z, 0.07, y + 0.35, y + 2.3, col.brass, 8);
    lamp.cyl(x, z, 0.17, y + 2.3, y + 3.0, C('#ffd88a'), 10, C('#f6e8c8'));
    metal.cyl(x, z, 0.2, y + 3.0, y + 3.08, col.brass, 10);
  };
  // 坑外 1.6 m 一圈（避开漫咖啡外摆、东侧大屏、南侧小殿与东南小屋；J–A 边让给外侧步道）
  for (const [x, z] of LY_POLES) poleAt(x, z);
  // LED 大屏（东侧坑口外，面向西）
  {
    const { x, zc, w } = LY_SCREEN, y0 = rimH + 0.6, y1 = y0 + 3.2;
    const st = new THREE.MeshStandardMaterial({ map: screenTexture(), emissive: 0xffffff, emissiveMap: null, emissiveIntensity: 0, roughness: 0.4 });
    st.emissiveMap = st.map;
    ctx.night.register(st, { day: 0.55, night: 1.6 });
    const g = new THREE.BufferGeometry();
    // 面向西（-X）：从坑内看北端在左
    g.setAttribute('position', new THREE.Float32BufferAttribute([x, y0, zc - w / 2, x, y0, zc + w / 2, x, y1, zc + w / 2, x, y0, zc - w / 2, x, y1, zc + w / 2, x, y1, zc - w / 2], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, st);
    m.name = 'LED大屏';
    group.add(m);
    metal.box(x + 0.02, y0 - 0.2, zc - w / 2 - 0.2, x + 0.4, y1 + 0.2, zc + w / 2 + 0.2, col.frame);
    for (const z of [zc - w / 2 + 0.6, zc + w / 2 - 0.6]) metal.box(x + 0.1, gy(x, z) - 0.2, z - 0.12, x + 0.34, y0, z + 0.12, col.frame);
  }
  // “榴园”刻字石（照片：入口景石）
  {
    const { x, z, ux, uz, hl, hw } = LY_STONE, y = gy(x, z) - 0.2;
    plain.obox(x, z, ux, uz, hl, hw, y, y + 1.9, C('#b8b2a6'), C('#c8c2b6'));
    const nx = 0.53, nz = 0.85; // 面向东北（朝坑口/步道）
    signs.place('榴园', new THREE.Vector3(x + nx * (0.72 - 0.45), y + 1.15, z + nz * (0.72 - 0.45)), nx, nz, 0.8, 2.4, { color: '#b22a1e', weight: 700, serif: true });
  }
  // 漫咖啡招牌：南立面窗顶以上的墙带（照片 s1-04 红字 MAAN COFFEE）
  {
    const { x0, z0, x1, z1, h } = MAAN;
    const y = Math.min(gy(x0, z0), gy(x1, z0), gy(x0, z1), gy(x1, z1)) - 0.3;
    signs.place('MAAN COFFEE 漫咖啡', new THREE.Vector3(x0 + 9, y + h - 0.35, z1 + 0.03 - 0.45), 0, 1, 0.62, 11, { color: '#c3262a', weight: 700 });
  }
  // 北侧平台外摆（漫咖啡门前）
  for (const x of [172.5, 180.5, 188.5]) plain.umbrella(x, 960.6, gy(x, 960.6), 1.3, 2.6, C('#f4f1ea'), col.pole);

  // ───── 6. 地面层建筑（灰石墙 + 灰瓦屋顶，照片 02 / s1-04 / s1-18） ─────
  const archG = buildArch(ctx, (b) => {
    // 漫咖啡：灰石墙、南立面落地窗、歇山顶
    {
      const { x0, z0, x1, z1, h } = MAAN;
      const y = Math.min(gy(x0, z0), gy(x1, z0), gy(x0, z1), gy(x1, z1)) - 0.3;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
      b.push(cx, y, cz, 0);
      b.box('stone', -w / 2, 0, -d / 2, w / 2, h + 0.3, d / 2, 0xa8a49c);
      for (let k = 0; k < 6; k++) {
        const x = -w / 2 + 2 + k * ((w - 4) / 6) + 0.3;
        glowQuad(b, x, x + (w - 4) / 6 - 0.6, 0.8, h - 1.0, d / 2 + 0.03, 0.65, 0x4a4d52); // 白天深色玻璃，夜间暖光（亮度走 uv.x）
        b.box('stone', x - 0.1, 0.62, d / 2, x + (w - 4) / 6 - 0.5, 0.8, d / 2 + 0.12, 0x8e8a84); // 窗台
      }
      b.box('stone', -w / 2 - 0.2, h + 0.3, -d / 2 - 0.2, w / 2 + 0.2, h + 0.7, d / 2 + 0.2, 0x9a968e);
      // 屋顶座（墙顶到瓦面之间的实体，免得檐下露空）
      b.box('stone', -(w - 1.8) / 2, h + 0.7, -(d - 1.8) / 2, (w - 1.8) / 2, h + 1.75, (d - 1.8) / 2, 0x8e8a84);
      const r = roof(b, { type: 'xieshan', w: w - 1.5, d: d - 1.5, y: h + 1.6, overhang: 1.6, color: 'darkgray', style: 'tang' });
      eaveLights(b, { roofs: [r] }, { color: 0xffb45a, width: 0.07, ridges: false });
      b.pop();
    }
    const minG = (pts) => Math.min(...pts.map(([x, z]) => gy(x, z))) - 0.25;
    // 南侧悬山小殿（照片 02：青砖墙、悬山灰瓦、山面朝东西），正面朝北对着坑口
    {
      const { x0, z0, x1, z1 } = SHALL;
      b.push((x0 + x1) / 2, minG([[x0, z0], [x1, z0], [x0, z1], [x1, z1]]), (z0 + z1) / 2, Math.PI);
      hall(b, { style: 'tang', bays: [3.8, 4.2, 4.2, 3.8], depthBays: 2, depthW: 2.2, colH: 3.9, roof: 'xuanshan', roofColor: 'darkgray',
        front: 'windows', back: 'wall', sides: 'wall', platform: 'plain', platformH: 0.3, steps: 'none', pal: LY_PAL, eaveLights: { color: 0xffc56a, ridges: false } });
      b.pop();
    }
    // 东南斜边外一溜坡顶小屋（影像：沿斜边的双坡屋面），正面朝坑口；进深让开外侧步道
    {
      // 台基外扩显式取 0.2 m（默认按出檐算约 1.6 m，会前伸进坑口、后压外侧步道），出檐 1.0 m
      const e = E[LY_HUT.e];
      const c = W(e, e.L / 2, LY_HUT.o, 0);
      const fx = e.nx, fz = e.nz; // 正面朝向 = 坑内法线
      b.push(c[0], minG([W(e, 2, -0.6, 0), W(e, e.L - 2, -2.6, 0), W(e, 2, -2.6, 0), W(e, e.L - 2, -0.6, 0)].map((p) => [p[0], p[2]])), c[2], Math.atan2(fx, fz));
      hall(b, { style: 'tang', bays: LY_HUT.bays, bayW: LY_HUT.bayW, depthBays: 1, depthW: LY_HUT.depthW, colH: 3.2, roof: 'xuanshan', roofColor: 'darkgray',
        platformMargin: LY_HUT.margin, overhang: 1.0, front: 'tangshop', back: 'wall', sides: 'wall', platform: 'plain', platformH: 0.2, steps: 'none', pal: { ...LY_PAL, wall: 0xa8a39a } });
      b.pop();
    }
  }, { style: 'tang', detail: 1, name: '榴园地面建筑' });
  group.add(archG);

  // ───── 7. 人（静态，坐/站/走） ─────
  // 用简单体块人形（与行人模块同一套比例），顶点色
  {
    const pts = [[166, 968, 0], [169.5, 975, 1], [176, 976.5, 2], [181, 975.2, 0], [186.5, 974.8, 1], [191, 972, 2], [183.5, 985.8, 0], [179, 988.4, 1], [174.5, 984, 2],
      [165, 982, 0], [160.5, 986.5, 1], [156, 976, 2], [154.8, 972.5, 0], [168.4, 991.2, 1], [194, 967.5, 2], [171.5, 964.6, 0], [189, 963.9, 1], [162.2, 963.9, 2]];
    const shirt = ['#e8e4dc', '#2b2f38', '#8a3a32', '#344a78', '#d8667a', '#5a6b4a', '#f0f0ee', '#c8312a'];
    pts.forEach(([x, z, v], i) => {
      const yaw = (i * 2.39) % (Math.PI * 2), ca = Math.cos(yaw), sa = Math.sin(yaw);
      const P = (lx, lz) => [x + lx * ca - lz * sa, z + lx * sa + lz * ca];
      const legs = C('#2c2f3a'), top = C(shirt[i % shirt.length]), skin = C('#d9b08c'), hair = C('#1c1714');
      for (const s of [-0.1, 0.1]) { const q = P(s, 0); plain.obox(q[0], q[1], ca, sa, 0.075, 0.085, Yf, Yf + 0.84, legs); }
      const q = P(0, 0);
      plain.obox(q[0], q[1], ca, sa, 0.2, 0.115, Yf + 0.84, Yf + 1.46, top);
      plain.obox(q[0], q[1], ca, sa, 0.1, 0.1, Yf + 1.46, Yf + 1.7, skin, hair);
      void v;
    });
  }

  // ───── 输出 ─────
  for (const [ms, mat, name, sh] of [[pave, M.pave, '铺装与台阶', true], [brick, M.brick, '青砖挡墙', true], [plain, M.plain, '石材与陈设', true], [metal, M.metal, '金属', true],
    [shop, M.shop, '店面玻璃', false], [lamp, M.lamp, '灯', false], [rail, M.rail, '玻璃栏板', false], [water, M.water, '水池', false]]) {
    const m = ms.mesh(mat, name, { shadow: sh });
    if (m) group.add(m);
  }
  if (poolP.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(poolP, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(poolC, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(poolU, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, M.pool);
    m.name = '夜间地面光斑';
    m.renderOrder = 2;
    group.add(m);
  }
  const sm = signs.build();
  if (sm) {
    sm.name = '榴园招牌';
    group.add(sm);
  }
  for (const L of archG.userData.lights || []) lights.push({ position: new THREE.Vector3(...L.position), color: L.color, intensity: L.intensity, distance: L.distance });
  return { group, lights, label: new THREE.Vector3(172, T0 + 12, 972) };
}

/** 榴园占地：坑口 + 地面层建筑 + 坑外地面物件（排除区 / 挖洞 / 检查工具共用） */
export function liuyuanFootprints() {
  const rect = (r) => [r.x0, r.z0, r.x1, r.z0, r.x1, r.z1, r.x0, r.z1];
  const box = ([x0, z0, x1, z1]) => [x0, z0, x1, z0, x1, z1, x0, z1];
  const { x, z, ux, uz, hl, hw } = LY_STONE, vx = -uz, vz = ux;
  const stone = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([a, c]) => [x + ux * hl * a + vx * hw * c, z + uz * hl * a + vz * hw * c]);
  return {
    rim: LY_RIM_FLAT.slice(),
    buildings: [rect(MAAN), rect(SHALL), lyHutRect()],
    /** 景石、LED 大屏支架、灯柱（外扩 0.5 m 的小方块）：树木与通用建筑让位 */
    props: [stone, box(LY_SCREEN_RECT), ...LY_POLES.map(([px, pz]) => box([px - 0.5, pz - 0.5, px + 0.5, pz + 0.5]))],
  };
}
