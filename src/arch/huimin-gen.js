// 回民街 / 洒金桥精细街区：由 OSM 逐户轮廓（public/data/huimin.json，tools/build_huimin.py 生成）程序化生成
//   · 立面：按开间（3.2 m）× 层（≈3.2 m）平铺的 Canvas 贴图——青砖木格窗 / 白瓷砖铝窗 / 红砖；临街首层为
//     仿古木排门（北院门、西羊市、大皮院等回坊主街）或现代玻璃门面 + 灯箱（洒金桥等混搭老街）；夜间窗户与铺面内透
//   · 屋顶：北院门 2 层仿明清街房与小体量临街铺为灰筒瓦硬山坡顶；寺院/城隍庙院落内为庑殿式大屋顶；其余平顶 + 女儿墙，
//     临街平顶楼在首层檐口加灰瓦披檐
//   · 招牌（黑底金字木匾 / 蓝底白字灯箱 / 红绿 LED 竖招）合成一张图集；红灯笼实例化
// 资料：research/refs/huimin/notes.md（2026-09 调研：层数、街宽、色板、店名）
import * as THREE from 'three';
import { SignAtlas } from './sky-towers.js';
import { inset as insetPoly } from './sky-geom.js';

const BAY = 3.2; // 开间（贴图横向重复单位，米）
const TRAD_LANES = new Set(['北院门', '西羊市', '大皮院', '化觉巷', '北广济街', '小皮院', '大学习巷']);
// 寺院 / 庙宇院落（世界坐标矩形，调研 §3）：院内建筑一律做古建大屋顶，不挂招牌
const COMPOUNDS = [
  { n: '化觉巷清真大寺', x0: -676, x1: -424, z0: -290, z1: -236 },
  { n: '大学习巷清真寺', x0: -1080, x1: -999, z0: -320, z1: -286 },
  { n: '洒金桥清真古寺', x0: -1426, x1: -1344, z0: -606, z1: -563 },
  { n: '西安都城隍庙', x0: -918, x1: -862, z0: -300, z1: -150 },
  { n: '高家大院', x0: -346, x1: -318, z0: -420, z1: -380 },
];
const GENERIC_TRAD = ['老马家泡馍', '清真·腊牛羊肉', '老白家水盆', '回坊甑糕', '马家烤肉', '米家凉皮', '酸梅汤', '黄桂柿子饼',
  '肉丸胡辣汤', '小炒泡馍', '粉蒸肉夹馍', '灌汤包子', '镜糕', '羊肉串', '牛肉饼', '油茶麻花', '清真·羊杂汤', '老金家夹馍',
  '腊牛肉夹馍', '石子馍', '蜂蜜粽子', '炒米', '麻酱酿皮', '清真·羊肉面', '水晶饼', '老孙家饭庄'];
const GENERIC_MODERN = ['肉丸胡辣汤', '便利店', '水果店', '烟酒副食', '酸汤水饺', '清真牛肉面', '腊牛肉夹馍', '小炒泡馍',
  '菜蛋夹馍', '甑糕', '手机维修', '早餐', '清真超市', '干果行', '茶叶', '理发'];

const rand = (a, b = 0) => {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

// ─────────────────────────── 贴图 ───────────────────────────
function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function tex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
function noise(g, w, h, amp, seed) {
  const img = g.getImageData(0, 0, w, h), d = img.data;
  let s = seed * 9301 + 49297;
  for (let i = 0; i < d.length; i += 4) {
    s = (s * 9301 + 49297) % 233280;
    const n = (s / 233280 - 0.5) * amp;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

const WALLS = {
  brick: { base: '#62666a', line: 'rgba(40,42,44,0.35)', brick: true },  // 青砖
  tile: { base: '#bdb8ad', line: 'rgba(120,118,110,0.25)', tile: true },  // 白瓷砖
  red: { base: '#84452f', line: 'rgba(60,30,22,0.4)', brick: true },       // 红砖
  plaster: { base: '#8e8a82', line: null },                               // 灰水泥抹面
};

function paintWall(g, S, st, seed) {
  const W = WALLS[st];
  g.fillStyle = W.base;
  g.fillRect(0, 0, S, S);
  if (W.brick) {
    g.fillStyle = W.line;
    const bh = S / 26;
    for (let r = 0; r < 26; r++) {
      g.fillRect(0, r * bh, S, 1.2);
      const off = (r % 2) * (S / 16);
      for (let x = off; x < S; x += S / 8) g.fillRect(x, r * bh, 1.2, bh);
    }
  } else if (W.tile) {
    g.fillStyle = W.line;
    for (let y = 0; y < S; y += S / 20) g.fillRect(0, y, S, 1);
    for (let x = 0; x < S; x += S / 10) g.fillRect(x, 0, 1, S);
  }
  noise(g, S, S, st === 'tile' ? 10 : 22, seed);
}

/** 上层：墙 + 窗（style: brick 木格窗 / tile 铝窗+防盗网 / red 木窗 / plaster 铝窗）；返回 {map, emis} */
function upperTex(st, lit, seed) {
  const S = 256;
  const c = cv(S, S), g = c.getContext('2d');
  const e = cv(S, S), ge = e.getContext('2d');
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  paintWall(g, S, st, seed);
  // 楼板线（层间腰线）
  g.fillStyle = st === 'tile' ? '#b9b4a8' : 'rgba(30,30,30,0.35)';
  g.fillRect(0, S - 10, S, 10);
  const wx0 = S * 0.2, wx1 = S * 0.8, wy0 = S * 0.22, wy1 = S * 0.72;
  const wood = st === 'brick' || st === 'red';
  // 窗洞 + 窗台
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(wx0 - 4, wy0 - 4, wx1 - wx0 + 8, wy1 - wy0 + 10);
  g.fillStyle = wood ? '#4a2f1c' : '#9aa1a6';
  g.fillRect(wx0, wy0, wx1 - wx0, wy1 - wy0);
  const glassDay = '#2c3942';
  for (let k = 0; k < 2; k++) {
    const x0 = wx0 + 5 + k * ((wx1 - wx0) / 2), x1 = x0 + (wx1 - wx0) / 2 - 10;
    g.fillStyle = glassDay;
    g.fillRect(x0, wy0 + 5, x1 - x0, wy1 - wy0 - 10);
    // 窗帘
    const cur = rand(seed, k) * 0.6;
    g.fillStyle = `rgba(${150 + rand(seed + 3, k) * 80 | 0},${120 + rand(seed + 5, k) * 60 | 0},90,0.5)`;
    g.fillRect(x0, wy0 + 5, (x1 - x0) * cur, wy1 - wy0 - 10);
    if (lit) {
      const warm = rand(seed + 7, k) < 0.75;
      ge.fillStyle = warm ? '#ffcf8a' : '#e8f0ff';
      ge.globalAlpha = 0.55 + rand(seed + 9, k) * 0.45;
      ge.fillRect(x0, wy0 + 5, x1 - x0, wy1 - wy0 - 10);
      ge.globalAlpha = 1;
    }
  }
  if (wood) {
    // 木格（步步锦简化）
    g.strokeStyle = '#5a3a22';
    g.lineWidth = 2;
    for (let k = 0; k < 2; k++) {
      const x0 = wx0 + 5 + k * ((wx1 - wx0) / 2), x1 = x0 + (wx1 - wx0) / 2 - 10;
      for (let i = 1; i < 4; i++) { const x = x0 + ((x1 - x0) * i) / 4; g.beginPath(); g.moveTo(x, wy0 + 5); g.lineTo(x, wy1 - 5); g.stroke(); }
      for (let i = 1; i < 5; i++) { const y = wy0 + 5 + ((wy1 - wy0 - 10) * i) / 5; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
    }
    ge.fillStyle = 'rgba(0,0,0,0.45)'; // 窗格遮挡夜光
    for (let k = 0; k < 2; k++) {
      const x0 = wx0 + 5 + k * ((wx1 - wx0) / 2), x1 = x0 + (wx1 - wx0) / 2 - 10;
      for (let i = 1; i < 4; i++) ge.fillRect(x0 + ((x1 - x0) * i) / 4 - 1, wy0, 2, wy1 - wy0);
    }
  } else {
    // 铝窗竖框 + 防盗网
    g.fillStyle = '#c8ccd0';
    g.fillRect((wx0 + wx1) / 2 - 3, wy0, 6, wy1 - wy0);
    if (st === 'tile' || rand(seed, 11) < 0.5) {
      g.strokeStyle = 'rgba(200,200,205,0.8)';
      g.lineWidth = 1.5;
      for (let x = wx0 - 6; x <= wx1 + 6; x += 12) { g.beginPath(); g.moveTo(x, wy0 - 8); g.lineTo(x, wy1 + 4); g.stroke(); }
      g.fillStyle = 'rgba(200,200,205,0.9)';
      g.fillRect(wx0 - 8, wy0 - 10, wx1 - wx0 + 16, 3);
      g.fillRect(wx0 - 8, wy1 + 4, wx1 - wx0 + 16, 3);
    }
    // 空调外机
    if (rand(seed, 13) < 0.45) {
      g.fillStyle = '#e4e4e0';
      g.fillRect(wx1 + 6, wy1 - 34, 44, 30);
      g.fillStyle = '#9a9a96';
      g.beginPath(); g.arc(wx1 + 30, wy1 - 19, 10, 0, Math.PI * 2); g.fill();
    }
  }
  // 窗台
  g.fillStyle = 'rgba(210,205,195,0.9)';
  g.fillRect(wx0 - 6, wy1 + 2, wx1 - wx0 + 12, 5);
  return { map: tex(c), emis: lit ? tex(e) : null };
}

/** 无窗墙面（山墙、女儿墙） */
function plainTex(st, seed) {
  const S = 256, c = cv(S, S), g = c.getContext('2d');
  paintWall(g, S, st, seed);
  return tex(c);
}

/** 首层铺面：trad 仿古木排门（朱红柱 + 栗木隔扇 + 檐下木匾带），modern 玻璃门面 + 灯箱带 */
function shopTex(kind, seed) {
  const W = 256, H = 256;
  const c = cv(W, H), g = c.getContext('2d');
  const e = cv(W, H), ge = e.getContext('2d');
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  if (kind === 'trad') {
    g.fillStyle = '#3a2618';
    g.fillRect(0, 0, W, H);
    // 檐下额枋 / 匾带
    g.fillStyle = '#1c1a18';
    g.fillRect(0, 0, W, H * 0.16);
    g.fillStyle = '#c9a24a';
    g.fillRect(0, H * 0.16, W, 3);
    // 朱红柱
    g.fillStyle = '#8b2a1e';
    g.fillRect(0, 0, 16, H);
    g.fillRect(W - 16, 0, 16, H);
    // 隔扇门（中间两扇敞开，内透）
    const n = 4, dw = (W - 32) / n;
    for (let i = 0; i < n; i++) {
      const x0 = 16 + i * dw;
      const open = i === 1 || i === 2;
      if (open) {
        g.fillStyle = '#2a1d14';
        g.fillRect(x0 + 2, H * 0.19, dw - 4, H * 0.81);
        ge.fillStyle = '#ffb45e';
        ge.fillRect(x0 + 2, H * 0.19, dw - 4, H * 0.81);
        // 室内货架/灯
        g.fillStyle = 'rgba(200,150,90,0.35)';
        g.fillRect(x0 + 6, H * 0.35, dw - 12, 6);
        g.fillRect(x0 + 6, H * 0.55, dw - 12, 6);
      } else {
        g.fillStyle = '#5a3a22';
        g.fillRect(x0 + 2, H * 0.19, dw - 4, H * 0.81);
        g.strokeStyle = '#7a5334';
        g.lineWidth = 2;
        for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(x0 + (dw * k) / 4, H * 0.24); g.lineTo(x0 + (dw * k) / 4, H * 0.62); g.stroke(); }
        for (let k = 0; k < 6; k++) { g.beginPath(); g.moveTo(x0 + 4, H * (0.24 + k * 0.076)); g.lineTo(x0 + dw - 4, H * (0.24 + k * 0.076)); g.stroke(); }
        g.fillStyle = '#4a2f1c';
        g.fillRect(x0 + 4, H * 0.66, dw - 8, H * 0.3);
        ge.fillStyle = 'rgba(255,170,90,0.35)';
        ge.fillRect(x0 + 4, H * 0.24, dw - 8, H * 0.38);
      }
    }
    // 石阶
    g.fillStyle = '#5f6468';
    g.fillRect(0, H - 8, W, 8);
  } else {
    // 现代门面：瓷砖柱 + 大玻璃 + 顶部灯箱带（颜色由 seed 决定）
    const cols = ['#1e4e9a', '#c8261c', '#1f7a4d', '#e0a21c', '#f2f2f2'];
    const band = cols[Math.floor(rand(seed, 1) * cols.length)];
    g.fillStyle = '#d8d4ca';
    g.fillRect(0, 0, W, H);
    g.fillStyle = band;
    g.fillRect(0, 0, W, H * 0.2);
    ge.fillStyle = band === '#f2f2f2' ? '#ffffff' : band;
    ge.globalAlpha = 0.9;
    ge.fillRect(0, 0, W, H * 0.2);
    ge.globalAlpha = 1;
    g.fillStyle = '#b8b4aa';
    g.fillRect(0, 0, 12, H);
    g.fillRect(W - 12, 0, 12, H);
    // 玻璃门窗（内透）
    g.fillStyle = '#3a4650';
    g.fillRect(16, H * 0.24, W - 32, H * 0.72);
    g.fillStyle = 'rgba(240,230,210,0.25)';
    g.fillRect(24, H * 0.3, W - 48, 8);
    ge.fillStyle = '#fff1d8';
    ge.globalAlpha = 0.85;
    ge.fillRect(16, H * 0.24, W - 32, H * 0.72);
    ge.globalAlpha = 1;
    g.fillStyle = '#9aa0a4';
    g.fillRect(W / 2 - 3, H * 0.24, 6, H * 0.72);
    // 半卷的卷帘门
    if (rand(seed, 2) < 0.4) {
      g.fillStyle = '#a8aaa8';
      g.fillRect(16, H * 0.24, W - 32, H * 0.2);
      for (let y = H * 0.24; y < H * 0.44; y += 5) { g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(16, y, W - 32, 1); }
      ge.fillStyle = '#000';
      ge.fillRect(16, H * 0.24, W - 32, H * 0.2);
    }
  }
  noise(g, W, H, 14, seed);
  return { map: tex(c), emis: tex(e) };
}

/** 古建墙面：下碱青砖 + 朱红柱 + 槛窗 */
function templeTex() {
  const S = 256, c = cv(S, S), g = c.getContext('2d');
  const e = cv(S, S), ge = e.getContext('2d');
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  g.fillStyle = '#6e7271';
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#7a2a1e';
  g.fillRect(0, 0, 18, S);
  g.fillRect(S - 18, 0, 18, S);
  g.fillStyle = '#2d5a5a'; // 额枋彩画（青绿）
  g.fillRect(0, 0, S, S * 0.12);
  g.fillStyle = '#5a3a22';
  g.fillRect(30, S * 0.2, S - 60, S * 0.5);
  g.strokeStyle = '#7a5334';
  g.lineWidth = 2;
  for (let x = 40; x < S - 30; x += 14) { g.beginPath(); g.moveTo(x, S * 0.22); g.lineTo(x, S * 0.68); g.stroke(); }
  for (let y = S * 0.24; y < S * 0.7; y += 14) { g.beginPath(); g.moveTo(32, y); g.lineTo(S - 32, y); g.stroke(); }
  ge.fillStyle = 'rgba(255,190,110,0.5)';
  ge.fillRect(30, S * 0.2, S - 60, S * 0.5);
  noise(g, S, S, 16, 5);
  return { map: tex(c), emis: tex(e) };
}

// ─────────────────────────── 材质 ───────────────────────────
function makeMaterials(ctx) {
  const M = {};
  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0.0, ...o });
  const withEmis = (map, emis, day, night, key) => {
    const m = std({ map, emissiveMap: emis, emissive: 0xffffff, emissiveIntensity: 0 });
    m.name = 'huimin-' + key;
    ctx.night.register(m, { day, night });
    return m;
  };
  let seed = 3;
  for (const st of Object.keys(WALLS)) {
    const L = upperTex(st, true, seed++), D = upperTex(st, false, seed++);
    M['up-' + st + '-lit'] = withEmis(L.map, L.emis, 0, 0.85, 'up-' + st + '-lit');
    M['up-' + st + '-dark'] = std({ map: D.map, name: 'huimin-up-' + st + '-dark' });
    M['plain-' + st] = std({ map: plainTex(st, seed++), name: 'huimin-plain-' + st });
  }
  const sT = shopTex('trad', 11), sM1 = shopTex('modern', 12), sM2 = shopTex('modern', 17);
  M['shop-trad'] = withEmis(sT.map, sT.emis, 0.03, 0.9, 'shop-trad');
  M['shop-modern1'] = withEmis(sM1.map, sM1.emis, 0.05, 1.0, 'shop-modern1');
  M['shop-modern2'] = withEmis(sM2.map, sM2.emis, 0.05, 1.0, 'shop-modern2');
  const tt = templeTex();
  M.temple = withEmis(tt.map, tt.emis, 0, 0.6, 'temple');
  const rt = ctx.tex.roofTiles({ color: '#4a4d50' });
  M.roofTile = std({ map: rt.map, normalMap: rt.normalMap, roughness: 0.8, name: 'huimin-roofTile', side: THREE.DoubleSide });
  const gr = ctx.tex.grain({ color: '#6c6a65', amp: 30, seed: 21, spots: 60 });
  M.roofFlat = std({ map: gr.map || gr, roughness: 0.95, name: 'huimin-roofFlat' });
  M.ridge = std({ color: 0x3a3c3e, roughness: 0.85, name: 'huimin-ridge' });
  M.wood = std({ color: 0x4a2f1c, roughness: 0.7, name: 'huimin-wood' });
  return M;
}

// ─────────────────────────── 几何累加 ───────────────────────────
class Acc {
  constructor() { this.p = []; this.n = []; this.u = []; }
  tri(a, b, c, ua, ub, uc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    this.p.push(...a, ...b, ...c);
    this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.u.push(...ua, ...ub, ...uc);
  }
  /** 四边形 a b c d（逆时针，正面朝外） */
  quad(a, b, c, d, ua, ub, uc, ud) {
    this.tri(a, b, c, ua, ub, uc);
    this.tri(a, c, d, ua, uc, ud);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/** 最小外接矩形（旋转卡壳的简化版：逐边方向） */
function obb(pts) {
  let best = null;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let ax = pts[j * 2] - pts[i * 2], az = pts[j * 2 + 1] - pts[i * 2 + 1];
    const L = Math.hypot(ax, az);
    if (L < 1e-6) continue;
    ax /= L; az /= L;
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (let k = 0; k < n; k++) {
      const x = pts[k * 2], z = pts[k * 2 + 1];
      const u = x * ax + z * az, v = -x * az + z * ax;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ax, az, u0, u1, v0, v1 };
  }
  const b = best;
  const cu = (b.u0 + b.u1) / 2, cv2 = (b.v0 + b.v1) / 2;
  let o = { cx: cu * b.ax - cv2 * b.az, cz: cu * b.az + cv2 * b.ax, a: (b.u1 - b.u0) / 2, bb: (b.v1 - b.v0) / 2, ux: b.ax, uz: b.az, area: b.area };
  if (o.bb > o.a) o = { ...o, a: o.bb, bb: o.a, ux: -b.az, uz: b.ax }; // 长轴为 u
  return o;
}

function polyArea(p) {
  let s = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return s / 2;
}

// ─────────────────────────── 构建 ───────────────────────────
export function buildHuimin(ctx, data) {
  const M = makeMaterials(ctx);
  const acc = new Map();
  const A = (k) => {
    if (!acc.has(k)) acc.set(k, new Acc());
    return acc.get(k);
  };
  // 招牌图集：横排条目 96 px 高（0.72 m 的匾约 133 px/m），竖排 LED 按宽 64 px；全部单面（背面不显示镜像字）。
  // 约 240 种文字条目，默认 150 px 的行高装不下（会丢掉后放的真实店名），所以先收集、按“真实店名 → 通用店名 → 竖招”顺序入图集
  const signs = new SignAtlas(ctx, 4096, 2048, { rowH: 96, vW: 64, side: THREE.FrontSide });
  const signReq = [];
  const lanternPos = [];
  const T = ctx.terrain;
  const streets = data.streets || [];
  const inCompound = (x, z) => COMPOUNDS.find((c) => x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1);
  let nSigns = 0, nTrad = 0, nTemple = 0;

  data.b.forEach((b, bi) => {
    const p = b.p;
    const n = p.length / 2;
    if (n < 3) return;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += p[i * 2]; cz += p[i * 2 + 1]; }
    cx /= n; cz /= n;
    const area = Math.abs(polyArea(p));
    let ground = T.heightAt(cx, cz);
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4))) ground = Math.min(ground, T.heightAt(p[i * 2], p[i * 2 + 1]));
    const y0 = ground - 0.4;
    const street = b.st >= 0 ? streets[b.st] : '';
    const comp = inCompound(cx, cz);
    const trad = !comp && (TRAD_LANES.has(street) || street === '北院门');
    const fr = new Set(b.fr);
    const r = rand(cx, cz);
    // 墙面风格：回坊主街多青砖，洒金桥/西仓等多白瓷砖与红砖
    const st = comp ? 'brick' : trad ? (r < 0.7 ? 'brick' : r < 0.85 ? 'plaster' : 'red') : r < 0.38 ? 'brick' : r < 0.58 ? 'tile' : r < 0.8 ? 'red' : 'plaster';
    const o = obb(p);
    // 寺院 / 庙宇 / 大院内建筑是单层殿堂（数据里沿用了民居的 2~5 层规则）：檐高封顶，大殿略高
    const H = comp ? Math.min(b.h, o.a > 12 ? 8.5 : 6) : b.h;
    const fl = Math.max(1, b.fl);
    const shopH = fr.size ? 3.6 : 3.2;
    const fh = fl > 1 ? (H - shopH) / (fl - 1) : H;
    const rect = o.area > 0 ? area / o.area : 0;
    // 屋顶类型
    let roof = 'flat';
    if (comp) roof = 'hip';
    else if (street === '北院门' && fr.size && rect > 0.75) roof = 'gable';
    else if (fr.size && trad && fl <= 2 && rect > 0.82 && o.bb < 9 && area < 260) roof = 'gable';
    else if (!fr.size && fl <= 1 && rect > 0.85 && o.bb < 7 && r < 0.5) roof = 'gable';
    if (roof === 'gable') nTrad++;
    if (roof === 'hip') nTemple++;
    const top = y0 + 0.4 + H;
    const eaveY = roof === 'flat' ? top : top; // 坡顶从檐口起坡
    // —— 墙 ——
    const litFloor = (f) => rand(bi * 7 + f, 3.1) < 0.5;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const nb = Math.max(1, Math.round(L / BAY));
      const isFr = fr.has(i) && L >= 2.4;
      const wallQuad = (mat, ya, yb, va, vb) => {
        A(mat).quad([ax, ya, az], [ax, yb, az], [bx, yb, bz], [bx, ya, bz], [nb, va], [nb, vb], [0, vb], [0, va]);
      };
      if (comp) {
        // 殿堂墙面：贴图竖向只铺一次（额枋在上、槛窗居中、下碱在下），开间宽随檐高放大
        const tb = Math.max(1, Math.round(L / Math.max(3.2, (eaveY - y0) * 0.6)));
        A('temple').quad([ax, y0, az], [ax, eaveY, az], [bx, eaveY, bz], [bx, y0, bz], [tb, 0], [tb, 1], [0, 1], [0, 0]);
        continue;
      }
      if (L < 2.2) {
        wallQuad('plain-' + st, y0, eaveY + (roof === 'flat' ? 0.7 : 0), 0, (H + 1.1) / 3.2);
        continue;
      }
      // 首层
      const g1 = y0 + 0.4 + (fl > 1 ? shopH : H);
      if (isFr) wallQuad(trad ? 'shop-trad' : r < 0.5 ? 'shop-modern1' : 'shop-modern2', y0, g1, -0.11, 1);
      else wallQuad('up-' + st + (litFloor(0) ? '-lit' : '-dark'), y0, g1, -0.12, 1);
      // 上层
      for (let f = 1; f < fl; f++) {
        const ya = y0 + 0.4 + shopH + (f - 1) * fh, yb = ya + fh;
        wallQuad('up-' + st + (litFloor(f) ? '-lit' : '-dark'), ya, yb, 0, 1);
      }
      // 女儿墙
      if (roof === 'flat') wallQuad('plain-' + st, top, top + 0.7, 0, 0.22);
      // 临街：披檐、招牌、灯笼
      if (isFr && fl > 1 && roof === 'flat') {
        const dx = (bx - ax) / L, dz = (bz - az) / L, nx = dz, nz = -dx;
        const ey = g1 + 0.95, d = trad ? 1.1 : 0.7, drop = trad ? 0.55 : 0.3;
        A('roofTile').quad(
          [bx + nx * d, ey - drop, bz + nz * d], [ax + nx * d, ey - drop, az + nz * d], [ax, ey, az], [bx, ey, bz],
          [0, 0], [L / 1.2, 0], [L / 1.2, d], [0, d],
        );
      }
      if (isFr) {
        const dx = (bx - ax) / L, dz = (bz - az) / L, nx = dz, nz = -dx;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const wantSign = b.sg || (trad ? r < 0.6 : r < 0.4);
        let signHalf = 0, signY = 0; // 招牌沿墙半宽（估计值）与中心高，灯笼避让用
        if (wantSign && L > 3 && i === longestFront(p, fr)) {
          const text = b.sg || (trad ? GENERIC_TRAD : GENERIC_MODERN)[Math.floor(rand(bi, 5) * (trad ? GENERIC_TRAD.length : GENERIC_MODERN.length))];
          const real = !!b.sg;
          const sy = g1 + (fl > 1 ? 0.45 : -0.45);
          const opts = trad
            ? { bg: '#1c1a18', color: '#d9b25a', serif: true, border: '#8a6a2a' }
            : [{ bg: '#1e4e9a', color: '#ffffff' }, { bg: '#c8261c', color: '#ffe36b' }, { bg: '#f4f1ea', color: '#c8261c' }, { bg: '#1f7a4d', color: '#ffffff' }][Math.floor(rand(bi, 6) * 4)];
          const maxW = Math.min(L * 0.85, 7.5);
          signReq.push({ text, real, p: { x: mx - nx * 0.25, y: sy, z: mz - nz * 0.25 }, nx, nz, h: 0.72, maxW, opts });
          signHalf = Math.min(maxW, 0.72 * (0.75 * [...text].length + 0.13)) / 2; // 汉字约 0.75 字高/字 + 边距
          signY = sy;
          nSigns++;
          // LED 竖招（挑出墙面 0.6~1.2 m，朝街道两个方向）：背靠背两块单面牌，两边看都不镜像；
          // 平顶铺面有首层披檐：底边抬到披檐根部（g1+0.95）以上，不插进檐瓦
          if (fl >= 2 && rand(bi, 8) < (trad ? 0.35 : 0.25)) {
            const vt = text.replace(/[·\s]/g, '').slice(0, 5);
            const led = rand(bi, 9) < 0.5 ? { bg: '#b0120c', color: '#ffe36b', vertical: true } : { bg: '#0f6a3c', color: '#ffffff', vertical: true };
            const lh = 0.55 * vt.length, ly = g1 + (roof === 'flat' ? Math.max(1.9, 1.05 + lh / 2) : 1.9);
            const cx = ax + dx * (Math.min(0.9, L * 0.2) + 0.45) + nx * 0.9, cz = az + dz * (Math.min(0.9, L * 0.2) + 0.45) + nz * 0.9;
            // place() 会沿牌面法线再外移 0.45 m：两面各自朝 ±d，最终相距 3 cm
            for (const sd of [1, -1]) signReq.push({ text: vt, real, p: { x: cx - sd * dx * 0.435, y: ly, z: cz - sd * dz * 0.435 }, nx: sd * dx, nz: sd * dz, h: lh, maxW: 3.2, opts: led });
          }
        }
        // 红灯笼（回坊主街，每开间一盏）：两层以上平顶铺面挂在披檐下、招牌下方（披檐在 0.85 m 处高 g1+0.525，招牌 g1+0.09…0.81，
        // 灯笼含木托 +0.365、流苏 -0.99）；坡顶挂在檐下封口（top-0.19）以下；与招牌同高时让开招牌所在的一段
        if (trad && fl >= 1) {
          const k = Math.max(1, Math.round(L / 3.4));
          const out = roof === 'flat' ? 0.85 : 0.6;
          const ly = fl > 1 && roof === 'flat' ? g1 - 0.35 : top - (roof === 'flat' ? 0.55 : 0.6);
          const avoid = signHalf > 0 && ly - 0.99 < signY + 0.36 && ly + 0.365 > signY - 0.36 ? signHalf + 0.35 : 0;
          for (let q = 0; q < k; q++) {
            const t = (q + 0.5) / k;
            if (avoid && Math.abs(t - 0.5) * L < avoid) continue;
            lanternPos.push(ax + (bx - ax) * t + nx * out, ly, az + (bz - az) * t + nz * out);
          }
        }
      }
    }
    // 女儿墙内侧面 + 压顶：外侧面是单面的，从空中看远侧女儿墙只剩背面会被剔除（看起来没有女儿墙）
    if (roof === 'flat') {
      const pin = insetPoly(p, 0.22);
      const W = A('plain-' + st), yt = top + 0.7;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.05) continue;
        const cx = pin[i * 2], cz = pin[i * 2 + 1], ex = pin[j * 2], ez = pin[j * 2 + 1];
        const u = Math.max(1, Math.round(L / BAY));
        W.quad([ex, top, ez], [ex, yt, ez], [cx, yt, cz], [cx, top, cz], [0, 0], [0, 0.22], [u, 0.22], [u, 0]); // 内侧面，朝内
        W.quad([ax, yt, az], [cx, yt, cz], [ex, yt, ez], [bx, yt, bz], [0, 0], [0, 0.07], [u, 0.07], [u, 0]); // 压顶，朝上
      }
    }
    // —— 屋顶 ——
    if (roof === 'flat') {
      const contour = [];
      for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const [a, c2, d] of tris) {
        const P = (k) => [p[k * 2], top, p[k * 2 + 1]];
        const U = (k) => [p[k * 2] / 4, p[k * 2 + 1] / 4];
        // 朝上：保证法线 y>0
        const v1 = [p[c2 * 2] - p[a * 2], p[c2 * 2 + 1] - p[a * 2 + 1]], v2 = [p[d * 2] - p[a * 2], p[d * 2 + 1] - p[a * 2 + 1]];
        const ny = v1[1] * v2[0] - v1[0] * v2[1];
        if (ny > 0) A('roofFlat').tri(P(a), P(c2), P(d), U(a), U(c2), U(d));
        else A('roofFlat').tri(P(a), P(d), P(c2), U(a), U(d), U(c2));
      }
      // 屋面水箱/彩钢棚（少量）
      if (area > 60 && rand(bi, 21) < 0.35) {
        const w = 1.6 + rand(bi, 22) * 1.4;
        boxAt(A('plain-plaster'), o.cx + o.ux * o.a * 0.3, top, o.cz + o.uz * o.a * 0.3, w, 1.4, w * 0.8, o.ux, o.uz);
      }
    } else {
      const over = roof === 'hip' ? 1.1 : 0.55;
      const a = o.a + (roof === 'hip' ? over : 0.25), bb = o.bb + over;
      const rise = roof === 'hip' ? Math.min(o.bb * 0.62, 6.5) : o.bb * 0.58;
      const ey = eaveY - over * 0.35;
      const ux = o.ux, uz = o.uz, vx = -uz, vz = ux;
      const P = (u, v, y) => [o.cx + ux * u + vx * v, y, o.cz + uz * u + vz * v];
      const ridgeA = roof === 'hip' ? Math.max(0.3, a - bb) : a;
      const ry = eaveY + rise;
      const R = A('roofTile');
      // 前后坡（v=+bb 与 v=-bb）
      R.quad(P(-a, bb, ey), P(a, bb, ey), P(ridgeA, 0, ry), P(-ridgeA, 0, ry), [0, 0], [2 * a / 1.2, 0], [2 * a / 1.2, bb], [0, bb]);
      R.quad(P(a, -bb, ey), P(-a, -bb, ey), P(-ridgeA, 0, ry), P(ridgeA, 0, ry), [0, 0], [2 * a / 1.2, 0], [2 * a / 1.2, bb], [0, bb]);
      if (roof === 'hip') {
        R.tri(P(a, bb, ey), P(a, -bb, ey), P(ridgeA, 0, ry), [0, 0], [2 * bb / 1.2, 0], [bb / 1.2, bb]);
        R.tri(P(-a, -bb, ey), P(-a, bb, ey), P(-ridgeA, 0, ry), [0, 0], [2 * bb / 1.2, 0], [bb / 1.2, bb]);
      } else {
        // 硬山山墙（三角）
        const wb = o.bb, wa = o.a;
        const W = A('plain-' + st);
        W.tri(P(wa, wb, eaveY), P(wa, -wb, eaveY), P(wa, 0, ry - 0.1), [0, 0], [2 * wb / 3.2, 0], [wb / 3.2, rise / 3.2]);
        W.tri(P(-wa, -wb, eaveY), P(-wa, wb, eaveY), P(-wa, 0, ry - 0.1), [0, 0], [2 * wb / 3.2, 0], [wb / 3.2, rise / 3.2]);
      }
      // 正脊
      boxAt(A('ridge'), o.cx, ry - 0.08, o.cz, 2 * ridgeA + 0.3, 0.32, 0.28, ux, uz);
      if (roof === 'hip' && o.a > 8) {
        // 大殿正吻（简化）
        for (const s of [-1, 1]) boxAt(A('ridge'), o.cx + ux * s * ridgeA, ry, o.cz + uz * s * ridgeA, 0.5, 1.1, 0.4, ux, uz);
      }
      // 坡顶下封口（檐口到墙顶的水平面，避免从下看穿帮）
      R.quad(P(-a, -bb, ey), P(a, -bb, ey), P(a, bb, ey), P(-a, bb, ey), [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  });

  // —— 招牌入图集：真实店名优先，其次通用横匾，竖招最后且按字数从多到少（同高条目排在同一行，图集利用率高） ——
  const rank = (q) => (q.opts.vertical ? 2 : q.real ? 0 : 1);
  signReq.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.text.length - a.text.length || b.real - a.real : 0));
  for (const q of signReq) signs.place(q.text, q.p, q.nx, q.nz, q.h, q.maxW, q.opts);

  // —— 输出 ——
  const group = new THREE.Group();
  group.name = '回民街·洒金桥';
  for (const [k, a] of acc) {
    if (!a.p.length) continue;
    const m = new THREE.Mesh(a.geometry(), M[k]);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = k;
    group.add(m);
  }
  const detail = new THREE.Group();
  detail.name = '回民街细部';
  const sm = signs.build();
  if (sm) {
    sm.name = '回民街招牌';
    detail.add(sm);
  }
  if (lanternPos.length) detail.add(lanterns(ctx, lanternPos));
  group.add(detail);
  return { group, detail, stats: { signs: nSigns, trad: nTrad, temple: nTemple, lanterns: lanternPos.length / 3 } };
}

function longestFront(p, fr) {
  let best = -1, bl = 0;
  const n = p.length / 2;
  for (const i of fr) {
    const j = (i + 1) % n;
    const L = Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
    if (L > bl) { bl = L; best = i; }
  }
  return best;
}

/** 以 (x, y 底, z) 为底面中心、长轴方向 (ux,uz) 的盒子（不含底面） */
function boxAt(acc, x, y, z, L, H, W, ux, uz) {
  const vx = -uz, vz = ux;
  const c = (su, sv, sy) => [x + ux * su * L / 2 + vx * sv * W / 2, y + sy * H, z + uz * su * L / 2 + vz * sv * W / 2];
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const q = (a, b, cc, d) => acc.quad(a, b, cc, d, ...uv);
  q(c(-1, -1, 1), c(-1, 1, 1), c(1, 1, 1), c(1, -1, 1)); // 顶
  q(c(-1, 1, 0), c(1, 1, 0), c(1, 1, 1), c(-1, 1, 1));
  q(c(1, -1, 0), c(-1, -1, 0), c(-1, -1, 1), c(1, -1, 1));
  q(c(1, 1, 0), c(1, -1, 0), c(1, -1, 1), c(1, 1, 1));
  q(c(-1, -1, 0), c(-1, 1, 0), c(-1, 1, 1), c(-1, -1, 1));
}

/** 红灯笼（实例化）：椭球灯身 + 上下木托 */
function lanterns(ctx, pos) {
  const body = new THREE.SphereGeometry(0.26, 10, 7);
  body.scale(1, 1.25, 1);
  const cap = new THREE.CylinderGeometry(0.13, 0.13, 0.07, 8);
  const top = cap.clone().translate(0, 0.33, 0), bot = cap.clone().translate(0, -0.33, 0);
  const tassel = new THREE.CylinderGeometry(0.02, 0.05, 0.28, 5).translate(0, -0.5, 0);
  const g = mergeSimple([body, top, bot, tassel]);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd42a1f, roughness: 0.6, emissive: 0xff4a1a, emissiveIntensity: 0 });
  ctx.night.register(mat, { day: 0.1, night: 1.7 });
  const n = pos.length / 3;
  const im = new THREE.InstancedMesh(g, mat, n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    m.makeTranslation(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.name = '红灯笼';
  return im;
}

function mergeSimple(geos) {
  const p = [], nn = [], u = [];
  for (let g of geos) {
    g = g.index ? g.toNonIndexed() : g;
    p.push(...g.attributes.position.array);
    nn.push(...g.attributes.normal.array);
    u.push(...g.attributes.uv.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
  return out;
}
