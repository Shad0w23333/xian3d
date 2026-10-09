// 回民街 / 洒金桥精细街区：由 OSM 逐户轮廓（public/data/huimin.json，tools/build_huimin.py 生成）程序化生成
//   · 立面：每种墙面一张“4 开间 × 2 层”的 Canvas 图集（青砖 / 白瓷砖 / 红砖 / 水泥 / 水刷石 / 米黄涂料，各两种窗型），
//     每栋楼随机错开开间与层，窗型、窗帘、防盗网、空调外机、封闭阳台逐窗不同；夜里逐窗随机亮灯（暖黄 / 中性 / 电视蓝光，
//     亮度不一，室内有家具剪影和吸顶灯光斑），不再是整层等亮度米黄平板。约两成平顶楼的顶层是彩钢加建层
//   · 层数：数据里 CMAB 把回坊西片整片标成 12.6~14.8 m，街坊内部自建房按确定性随机降 0~2 层，高低错落 2~5 层
//   · 屋顶：北院门 2 层仿明清街房与小体量临街铺为灰筒瓦硬山坡顶（屋脊平行临街面；进深大的做成几道平行坡顶）；
//     街坊内低层自建房约三成灰瓦坡顶；寺院/城隍庙院落内为庑殿式大屋顶；其余平顶 + 女儿墙，屋面有楼梯间、
//     太阳能热水器、水箱、彩钢加建棚；临街平顶楼在首层檐口加灰瓦披檐
//   · 临街：首层仿古木排门（回坊主街）或现代玻璃门面 + 灯箱（混搭老街），墙根石阶 + 青石板铺到路面（补上铺装与墙之间的缝）
//   · 招牌（黑底金字木匾 / 蓝底白字灯箱 / 红绿 LED 竖招）合成一张图集；檐下红灯笼（实例化，夜里有光晕）；
//     夜间沿街铺面前的石板路上叠暖色光斑
// 资料：research/refs/huimin/notes.md（2026-09 调研：层数、街宽、色板、店名）
import * as THREE from 'three';
import earcut from 'three/src/extras/lib/earcut.js';
import { SignAtlas } from './sky-towers.js';
import { inset as insetPoly } from './sky-geom.js';
import { pointInPoly } from '../core/util.js';
import { lanternGroup, groundGlow } from './streetscape-lantern.js';
import { NeutralSkyMaterial } from './heritage-parts.js';
import { courtyardTrees } from './streetscape-trees.js';

const BAY = 3.2; // 开间（米）
const TRAD_LANES = new Set(['北院门', '西羊市', '大皮院', '化觉巷', '北广济街', '小皮院', '大学习巷']);
const MAIN_TRAD = new Set(['北院门', '西羊市']);
// 夜里铺面前石板路铺暖光的主街（回坊环线 + 洒金桥等小吃街）
const GLOW_LANES = new Set([...TRAD_LANES, '洒金桥', '大麦市街', '庙后街', '西仓南巷', '光明巷', '麦苋街', '桥梓口']);
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
  '菜蛋夹馍', '甑糕', '手机维修', '早餐', '清真超市', '干果行', '茶叶', '理发', '烤肉', '凉皮米线', '羊肉泡馍', '炒米'];

const rand = (a, b = 0) => {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
/** 可复现的伪随机序列（贴图逐窗变化用） */
function rng(seed) {
  let s = (seed * 9301 + 49297) % 233280;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
}

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

// 墙面风格：青砖 / 白瓷砖 / 红砖 / 灰水泥 / 水刷石 / 米黄涂料（wood：木窗；grille：防盗网概率）
const WALLS = {
  brick: { base: '#62666a', line: 'rgba(40,42,44,0.35)', brick: true, wood: true, grille: 0.2 },
  tile: { base: '#bdb8ad', line: 'rgba(120,118,110,0.25)', tile: true, grille: 0.7 },
  red: { base: '#84452f', line: 'rgba(60,30,22,0.4)', brick: true, wood: true, grille: 0.35 },
  plaster: { base: '#8e8a82', line: null, grille: 0.5 },
  wash: { base: '#8c867b', grain: true, grille: 0.55 },
  cream: { base: '#b2a283', line: null, grille: 0.5 },
  // 仿明清铺面（北院门/西羊市等主街）：青砖、木格窗，不画防盗网、空调外机、封闭阳台与晾衣
  trad: { base: '#5d6164', line: 'rgba(36,38,40,0.4)', brick: true, wood: true, grille: 0, trad: true },
};
const STYLE_KEYS = Object.keys(WALLS);

/** 铺满墙面底纹（砖缝 / 瓷砖缝 / 水刷石颗粒）+ 噪声 */
function paintWall(g, W, H, st, seed, cell = 256) {
  const S = WALLS[st];
  g.fillStyle = S.base;
  g.fillRect(0, 0, W, H);
  const r = rng(seed + 7);
  if (S.brick) {
    // 每层 3.2 m 约 26 皮（≈0.12 m/皮），丁顺错缝
    g.fillStyle = S.line;
    const bh = cell / 26;
    for (let y = 0, k = 0; y < H; y += bh, k++) {
      g.fillRect(0, y, W, 1.2);
      const off = (k % 2) * (cell / 16);
      for (let x = off; x < W; x += cell / 8) g.fillRect(x, y, 1.2, bh);
    }
    // 单砖色差
    for (let i = 0; i < (W * H) / 220; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${0.03 + r() * 0.06})`;
      g.fillRect(Math.floor(r() * W / (cell / 8)) * (cell / 8), Math.floor(r() * H / bh) * bh, cell / 8, bh);
    }
  } else if (S.tile) {
    g.fillStyle = S.line;
    for (let y = 0; y < H; y += cell / 20) g.fillRect(0, y, W, 1);
    for (let x = 0; x < W; x += cell / 10) g.fillRect(x, 0, 1, H);
  } else if (S.grain) {
    // 水刷石：石子颗粒 + 每层一道分格缝
    for (let i = 0; i < (W * H) / 18; i++) {
      const t = r();
      g.fillStyle = t < 0.4 ? 'rgba(60,56,50,0.35)' : t < 0.75 ? 'rgba(210,205,195,0.35)' : 'rgba(120,96,70,0.3)';
      g.fillRect(r() * W, r() * H, 1.5 + r() * 1.5, 1.5 + r() * 1.5);
    }
    g.fillStyle = 'rgba(40,38,34,0.35)';
    for (let y = cell / 2; y < H; y += cell / 2) g.fillRect(0, y, W, 1.5);
  }
  noise(g, W, H, st === 'tile' ? 10 : 22, seed);
}

/** 雨水污迹：窗台下方、墙顶向下的竖向暗纹 */
function streak(g, x, y, w, len, a) {
  const gr = g.createLinearGradient(0, y, 0, y + len);
  gr.addColorStop(0, `rgba(30,28,24,${a})`);
  gr.addColorStop(1, 'rgba(30,28,24,0)');
  g.fillStyle = gr;
  g.fillRect(x, y, w, len);
}

/**
 * 窗型布局（只取决于窗型变体 v 与格子 (i,j)，与墙面风格无关：同一变体的夜间自发光贴图各风格共用）
 * 返回窗洞矩形（格内 0..1 比例，y 向下）与类型：win 普通双扇 / wide 三扇 / pair 两个小窗 / balc 封闭阳台 / high 高窗
 */
function cellLayout(v, i, j) {
  const r = rng(1000 + v * 97 + i * 13 + j * 7);
  const t = r();
  let type;
  if (v === 0) type = t < 0.62 ? 'win' : t < 0.8 ? 'wide' : 'balc';
  else type = t < 0.25 ? 'wide' : t < 0.58 ? 'pair' : t < 0.8 ? 'balc' : 'high';
  const jx = (r() - 0.5) * 0.06; // 窗位微错
  const W = [];
  if (type === 'win') W.push([0.2 + jx, 0.22, 0.8 + jx, 0.72]);
  else if (type === 'wide') W.push([0.1, 0.25, 0.9, 0.7]);
  else if (type === 'pair') { W.push([0.1, 0.28, 0.42, 0.66]); W.push([0.58, 0.28, 0.9, 0.66]); }
  else if (type === 'balc') W.push([0.06, 0.16, 0.94, 0.58]);
  else W.push([0.32 + jx, 0.2, 0.68 + jx, 0.46]);
  const lights = W.map(() => {
    const on = r() < 0.5;
    const c = r();
    return { on, col: c < 0.6 ? [255, 196, 120] : c < 0.85 ? [255, 228, 186] : [176, 205, 255], a: 0.45 + r() * 0.55, cur: r(), lamp: r(), furn: r() };
  });
  return { type, W, lights, ac: r() < 0.42, acSide: r() < 0.5 };
}

const CELL = 192; // 立面图集每格像素（3.2 m → 60 px/m）
/** 上层立面图集（4 开间 × 2 层）：map；emis 为该变体共用的夜间自发光贴图（只生成一次） */
function upperAtlas(st, v, seed) {
  const S = WALLS[st];
  const W = CELL * 4, H = CELL * 2;
  const c = cv(W, H), g = c.getContext('2d');
  paintWall(g, W, H, st, seed, CELL);
  const r = rng(seed * 3 + v);
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 4; i++) {
      const X = i * CELL, Y = j * CELL;
      const L = cellLayout(v, i, j);
      // 楼板线（层间腰线）
      g.fillStyle = st === 'tile' ? '#b9b4a8' : 'rgba(30,30,30,0.3)';
      g.fillRect(X, Y + CELL - 8, CELL, 8);
      L.W.forEach(([a, b, c2, d], k) => {
        const x0 = X + a * CELL, y0 = Y + b * CELL, x1 = X + c2 * CELL, y1 = Y + d * CELL;
        const balc = L.type === 'balc' && !S.trad;
        if (balc) {
          // 封闭阳台：下部实心栏板（墙色略深）+ 上部铝合金推拉窗
          g.fillStyle = 'rgba(0,0,0,0.12)';
          g.fillRect(x0, y1, x1 - x0, CELL * 0.22);
          g.fillStyle = 'rgba(255,255,255,0.18)';
          g.fillRect(x0, y1, x1 - x0, 3);
        }
        // 窗洞阴影 + 窗框
        g.fillStyle = 'rgba(0,0,0,0.38)';
        g.fillRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 8);
        g.fillStyle = S.wood && !balc ? '#4a2f1c' : balc ? '#d8dcdc' : '#9aa1a6';
        g.fillRect(x0, y0, x1 - x0, y1 - y0);
        // 玻璃（上亮下暗：反射天空）
        const gl = g.createLinearGradient(0, y0, 0, y1);
        gl.addColorStop(0, '#4a5a66'); gl.addColorStop(1, '#222c33');
        const panes = L.type === 'wide' || balc ? 3 : 2;
        const pw = (x1 - x0 - 4) / panes;
        for (let p = 0; p < panes; p++) {
          const px0 = x0 + 3 + p * pw, px1 = px0 + pw - 3;
          g.fillStyle = gl;
          g.fillRect(px0, y0 + 4, px1 - px0, y1 - y0 - 8);
          // 窗帘（颜色、拉开程度逐窗不同）
          const cf = L.lights[k].cur;
          if (cf > 0.25 && !S.trad) {
            g.fillStyle = `rgba(${140 + r() * 100 | 0},${110 + r() * 70 | 0},${80 + r() * 60 | 0},0.55)`;
            g.fillRect(px0, y0 + 4, (px1 - px0) * Math.min(1, cf * 0.9), y1 - y0 - 8);
          }
        }
        // 木格 / 铝窗竖框
        if (S.wood && !balc) {
          g.strokeStyle = '#5a3a22';
          g.lineWidth = 2;
          for (let p = 0; p < panes; p++) {
            const px0 = x0 + 3 + p * pw, px1 = px0 + pw - 3;
            for (let q = 1; q < 3; q++) { const x = px0 + ((px1 - px0) * q) / 3; g.beginPath(); g.moveTo(x, y0 + 4); g.lineTo(x, y1 - 4); g.stroke(); }
            for (let q = 1; q < 4; q++) { const y = y0 + 4 + ((y1 - y0 - 8) * q) / 4; g.beginPath(); g.moveTo(px0, y); g.lineTo(px1, y); g.stroke(); }
          }
        } else {
          g.fillStyle = balc ? '#e4e6e6' : '#c8ccd0';
          for (let p = 1; p < panes; p++) g.fillRect(x0 + 1 + p * pw - 2, y0, 4, y1 - y0);
          if (balc) g.fillRect(x0, y0 + (y1 - y0) * 0.3, x1 - x0, 3);
        }
        // 防盗网（凸出的不锈钢笼：竖条 + 上下横档 + 顶部小雨棚）
        if (!balc && r() < S.grille) {
          g.strokeStyle = 'rgba(205,205,210,0.85)';
          g.lineWidth = 1.5;
          for (let x = x0 - 5; x <= x1 + 5; x += 9) { g.beginPath(); g.moveTo(x, y0 - 6); g.lineTo(x, y1 + 4); g.stroke(); }
          g.fillStyle = 'rgba(205,205,210,0.9)';
          g.fillRect(x0 - 7, y0 - 9, x1 - x0 + 14, 3);
          g.fillRect(x0 - 7, y1 + 3, x1 - x0 + 14, 3);
          if (r() < 0.5) { g.fillStyle = 'rgba(70,120,170,0.85)'; g.fillRect(x0 - 9, y0 - 15, x1 - x0 + 18, 6); }
        }
        // 窗台 + 窗下污迹
        g.fillStyle = 'rgba(210,205,195,0.9)';
        g.fillRect(x0 - 5, y1 + 2, x1 - x0 + 10, 4);
        if (!S.brick) streak(g, x0 + (x1 - x0) * 0.2, y1 + 6, (x1 - x0) * 0.6, CELL * (0.12 + r() * 0.2), 0.12 + r() * 0.1);
        // 晾衣（阳台外挑杆上的衣物，少量）
        if (balc && r() < 0.35) {
          for (let q = 0; q < 4; q++) {
            g.fillStyle = ['#c84a3a', '#3a6ab0', '#e8e2d0', '#4a8a5a', '#d8a030'][Math.floor(r() * 5)];
            g.fillRect(x0 + 8 + q * (x1 - x0 - 16) / 4, y1 + 8, (x1 - x0) / 7, CELL * 0.1 + r() * 8);
          }
        }
      });
      // 空调外机
      if (L.ac && !S.trad) {
        const ax = L.acSide ? X + CELL * 0.84 : X + CELL * 0.02, ay = Y + CELL * 0.6;
        g.fillStyle = '#e4e4e0';
        g.fillRect(ax, ay, CELL * 0.14, CELL * 0.12);
        g.fillStyle = '#9a9a96';
        g.beginPath(); g.arc(ax + CELL * 0.07, ay + CELL * 0.06, CELL * 0.04, 0, Math.PI * 2); g.fill();
        if (st === 'tile' || st === 'cream' || st === 'wash') streak(g, ax + CELL * 0.05, ay + CELL * 0.12, 3, CELL * 0.3, 0.25);
      }
    }
  }
  // 顶部整体污迹（女儿墙雨水下淌）
  for (let k = 0; k < 10; k++) streak(g, r() * W, 0, 4 + r() * 10, CELL * (0.2 + r() * 0.5), 0.06 + r() * 0.08);
  return tex(c);
}

const _emis = new Map();
/** 某窗型变体的夜间自发光图集（各墙面风格共用） */
function upperEmis(v) {
  if (_emis.has(v)) return _emis.get(v);
  const W = CELL * 4, H = CELL * 2;
  const e = cv(W, H), ge = e.getContext('2d');
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 4; i++) {
      const X = i * CELL, Y = j * CELL;
      const L = cellLayout(v, i, j);
      L.W.forEach(([a, b, c2, d], k) => {
        const Lt = L.lights[k];
        const x0 = X + a * CELL + 3, y0 = Y + b * CELL + 4, x1 = X + c2 * CELL - 3, y1 = Y + d * CELL - 4;
        if (!Lt.on) {
          // 未开灯：少量电视蓝光
          if (Lt.lamp < 0.12) { ge.fillStyle = 'rgba(90,120,200,0.22)'; ge.fillRect(x0, y0 + (y1 - y0) * 0.4, (x1 - x0) * 0.5, (y1 - y0) * 0.6); }
          return;
        }
        const [R, G, B] = Lt.col;
        const gr = ge.createLinearGradient(0, y0, 0, y1);
        gr.addColorStop(0, `rgba(${R},${G},${B},${Lt.a})`);
        gr.addColorStop(1, `rgba(${R * 0.7 | 0},${G * 0.62 | 0},${B * 0.55 | 0},${Lt.a * 0.75})`);
        ge.fillStyle = gr;
        ge.fillRect(x0, y0, x1 - x0, y1 - y0);
        // 吸顶灯光斑
        const lx = x0 + (x1 - x0) * (0.3 + Lt.lamp * 0.4);
        const rg = ge.createRadialGradient(lx, y0, 0, lx, y0, (x1 - x0) * 0.5);
        rg.addColorStop(0, 'rgba(255,240,215,0.55)');
        rg.addColorStop(1, 'rgba(255,240,215,0)');
        ge.fillStyle = rg;
        ge.fillRect(x0, y0, x1 - x0, y1 - y0);
        // 窗帘半遮（透出的光更暗、更暖）
        if (Lt.cur > 0.25) { ge.fillStyle = 'rgba(0,0,0,0.45)'; ge.fillRect(x0, y0, (x1 - x0) * Math.min(1, Lt.cur * 0.9), y1 - y0); }
        // 家具剪影（柜子 / 人影）
        ge.fillStyle = 'rgba(0,0,0,0.6)';
        if (Lt.furn < 0.5) ge.fillRect(x0 + (x1 - x0) * (0.1 + Lt.furn), y1 - (y1 - y0) * 0.35, (x1 - x0) * 0.28, (y1 - y0) * 0.35);
        else ge.fillRect(x0 + (x1 - x0) * (Lt.furn - 0.3), y1 - (y1 - y0) * 0.55, (x1 - x0) * 0.08, (y1 - y0) * 0.55);
        // 窗框遮挡
        ge.fillStyle = 'rgba(0,0,0,0.85)';
        const panes = L.type === 'wide' || L.type === 'balc' ? 3 : 2;
        const pw = (x1 - x0) / panes;
        for (let p = 1; p < panes; p++) ge.fillRect(x0 + p * pw - 2, y0, 4, y1 - y0);
      });
    }
  }
  const t = tex(e);
  _emis.set(v, t);
  return t;
}

/** 无窗墙面（山墙、女儿墙、楼梯间） */
function plainTex(st, seed) {
  const S = 256, c = cv(S, S), g = c.getContext('2d');
  paintWall(g, S, S, st, seed, 256);
  const r = rng(seed);
  if (st !== 'brick' && st !== 'red' && st !== 'trad') for (let k = 0; k < 6; k++) streak(g, r() * S, 0, 3 + r() * 8, S * (0.3 + r() * 0.5), 0.08 + r() * 0.08);
  return tex(c);
}

/** 彩钢加建层：竖向压型钢板 + 小铝窗（map / emis） */
function addonTex() {
  const W = 512, H = 256;
  const c = cv(W, H), g = c.getContext('2d');
  const e = cv(W, H), ge = e.getContext('2d');
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  g.fillStyle = '#d9dcdc';
  g.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 10) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, 0, 3, H); g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x + 4, 0, 2, H); }
  g.fillStyle = '#3d6fae';
  g.fillRect(0, 0, W, 14);
  g.fillRect(0, H - 10, W, 10);
  const r = rng(77);
  for (let i = 0; i < 2; i++) {
    const x0 = i * 256 + 70, x1 = x0 + 110, y0 = 70, y1 = 160;
    g.fillStyle = '#9aa1a6';
    g.fillRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
    g.fillStyle = '#2e3a42';
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.fillStyle = '#c8ccd0';
    g.fillRect((x0 + x1) / 2 - 2, y0, 4, y1 - y0);
    if (r() < 0.6) { ge.fillStyle = r() < 0.7 ? 'rgba(255,205,140,0.85)' : 'rgba(225,235,255,0.8)'; ge.fillRect(x0, y0, x1 - x0, y1 - y0); ge.fillStyle = '#000'; ge.fillRect((x0 + x1) / 2 - 2, y0, 4, y1 - y0); }
  }
  noise(g, W, H, 10, 5);
  return { map: tex(c), emis: tex(e) };
}

/** 首层铺面图集（4 开间）：trad 仿古木排门（朱红柱 + 栗木隔扇 + 檐下木匾带），modern 玻璃门面 + 灯箱带；逐开间不同 */
function shopTex(kind, seed) {
  const B = 256, W = B * 4, H = 256;
  const c = cv(W, H), g = c.getContext('2d');
  const e = cv(W, H), ge = e.getContext('2d');
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  const r = rng(seed);
  // 室内（暖光渐变 + 吸顶灯 + 人影 / 桌椅 / 货架剪影）
  const interior = (x0, y0, w, h, warm, a = 1) => {
    g.fillStyle = '#2a1d14';
    g.fillRect(x0, y0, w, h);
    g.fillStyle = 'rgba(200,150,90,0.35)';
    g.fillRect(x0 + 4, y0 + h * 0.2, w - 8, 5);
    g.fillRect(x0 + 4, y0 + h * 0.45, w - 8, 5);
    const gr = ge.createLinearGradient(0, y0, 0, y0 + h);
    const col = warm ? [255, 178, 96] : [255, 236, 205];
    gr.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${a})`);
    gr.addColorStop(1, `rgba(${col[0] * 0.75 | 0},${col[1] * 0.6 | 0},${col[2] * 0.5 | 0},${a * 0.8})`);
    ge.fillStyle = gr;
    ge.fillRect(x0, y0, w, h);
    for (let q = 0; q < 2; q++) {
      const lx = x0 + w * (0.25 + q * 0.5);
      const rg = ge.createRadialGradient(lx, y0 + 6, 0, lx, y0 + 6, w * 0.4);
      rg.addColorStop(0, 'rgba(255,245,225,0.7)');
      rg.addColorStop(1, 'rgba(255,245,225,0)');
      ge.fillStyle = rg;
      ge.fillRect(x0, y0, w, h);
    }
    // 剪影：人（竖条 + 头）/ 桌子 / 蒸笼摞
    for (let q = 0; q < 3; q++) {
      const t = r(), px = x0 + w * (0.1 + r() * 0.75);
      ge.fillStyle = 'rgba(0,0,0,0.65)';
      g.fillStyle = 'rgba(20,14,10,0.7)';
      if (t < 0.45) {
        const pw = w * 0.07, ph = h * (0.45 + r() * 0.15);
        for (const gg of [g, ge]) { gg.fillRect(px, y0 + h - ph, pw, ph); gg.beginPath(); gg.arc(px + pw / 2, y0 + h - ph - pw * 0.55, pw * 0.5, 0, 6.3); gg.fill(); }
      } else if (t < 0.75) {
        for (const gg of [g, ge]) { gg.fillRect(px, y0 + h * 0.68, w * 0.22, h * 0.05); gg.fillRect(px + 2, y0 + h * 0.72, 4, h * 0.28); gg.fillRect(px + w * 0.22 - 6, y0 + h * 0.72, 4, h * 0.28); }
      } else {
        g.fillStyle = '#b89a6a';
        for (let s = 0; s < 4; s++) g.fillRect(px, y0 + h * (0.5 + s * 0.08), w * 0.16, h * 0.06);
        ge.fillStyle = 'rgba(0,0,0,0.35)';
        ge.fillRect(px, y0 + h * 0.5, w * 0.16, h * 0.32);
      }
    }
  };
  for (let b = 0; b < 4; b++) {
    const X = b * B;
    if (kind === 'trad') {
      g.fillStyle = '#3a2618';
      g.fillRect(X, 0, B, H);
      g.fillStyle = '#1c1a18'; // 檐下额枋 / 匾带
      g.fillRect(X, 0, B, H * 0.16);
      g.fillStyle = '#c9a24a';
      g.fillRect(X, H * 0.16, B, 3);
      g.fillStyle = '#8b2a1e'; // 朱红柱
      g.fillRect(X, 0, 16, H);
      g.fillRect(X + B - 16, 0, 16, H);
      const n = 4, dw = (B - 32) / n;
      const mode = r(); // 开门数：两扇 / 三扇 / 全开 + 售卖台
      for (let i = 0; i < n; i++) {
        const x0 = X + 16 + i * dw;
        const open = mode < 0.45 ? i === 1 || i === 2 : mode < 0.8 ? i !== 0 : true;
        if (open) {
          interior(x0 + 2, H * 0.19, dw - 4, H * 0.81, true, 0.75 + r() * 0.25);
        } else {
          g.fillStyle = '#5a3a22';
          g.fillRect(x0 + 2, H * 0.19, dw - 4, H * 0.81);
          g.strokeStyle = '#7a5334';
          g.lineWidth = 2;
          for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(x0 + (dw * k) / 4, H * 0.24); g.lineTo(x0 + (dw * k) / 4, H * 0.62); g.stroke(); }
          for (let k = 0; k < 6; k++) { g.beginPath(); g.moveTo(x0 + 4, H * (0.24 + k * 0.076)); g.lineTo(x0 + dw - 4, H * (0.24 + k * 0.076)); g.stroke(); }
          g.fillStyle = '#4a2f1c';
          g.fillRect(x0 + 4, H * 0.66, dw - 8, H * 0.3);
          ge.fillStyle = `rgba(255,170,90,${0.18 + r() * 0.25})`;
          ge.fillRect(x0 + 4, H * 0.24, dw - 8, H * 0.38);
          ge.fillStyle = 'rgba(0,0,0,0.6)';
          for (let k = 1; k < 4; k++) ge.fillRect(x0 + (dw * k) / 4 - 1, H * 0.24, 2, H * 0.38);
        }
      }
      if (mode >= 0.8) {
        // 临街售卖台（不锈钢台面 + 玻璃罩）
        g.fillStyle = '#9aa0a4';
        g.fillRect(X + 20, H * 0.66, B - 40, 6);
        g.fillStyle = '#4a3020';
        g.fillRect(X + 20, H * 0.68, B - 40, H * 0.28);
        ge.fillStyle = 'rgba(0,0,0,0.85)';
        ge.fillRect(X + 20, H * 0.68, B - 40, H * 0.28);
      }
      g.fillStyle = '#5f6468'; // 石阶
      g.fillRect(X, H - 8, B, 8);
    } else {
      // 现代门面：瓷砖柱 + 大玻璃 + 顶部灯箱带（逐开间换色）
      const cols = ['#1e4e9a', '#c8261c', '#1f7a4d', '#e0a21c', '#f2f2f2', '#d24a14'];
      const band = cols[Math.floor(rand(seed, b) * cols.length)];
      g.fillStyle = '#d8d4ca';
      g.fillRect(X, 0, B, H);
      g.fillStyle = band;
      g.fillRect(X, 0, B, H * 0.2);
      ge.fillStyle = band === '#f2f2f2' ? '#ffffff' : band;
      ge.globalAlpha = 0.75;
      ge.fillRect(X, 0, B, H * 0.2);
      ge.globalAlpha = 1;
      g.fillStyle = '#b8b4aa';
      g.fillRect(X, 0, 12, H);
      g.fillRect(X + B - 12, 0, 12, H);
      const shut = r();
      interior(X + 16, H * 0.24, B - 32, H * 0.72, r() < 0.55, 0.6 + r() * 0.3);
      g.fillStyle = 'rgba(160,190,210,0.18)'; // 玻璃反光
      g.fillRect(X + 16, H * 0.24, B - 32, H * 0.72);
      g.fillStyle = '#9aa0a4';
      g.fillRect(X + B / 2 - 3, H * 0.24, 6, H * 0.72);
      ge.fillStyle = '#000';
      ge.fillRect(X + B / 2 - 3, H * 0.24, 6, H * 0.72);
      if (shut < 0.35) {
        // 半卷的卷帘门
        const sh = H * (0.15 + r() * 0.35);
        g.fillStyle = '#a8aaa8';
        g.fillRect(X + 16, H * 0.24, B - 32, sh);
        for (let y = H * 0.24; y < H * 0.24 + sh; y += 5) { g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(X + 16, y, B - 32, 1); }
        ge.fillStyle = '#000';
        ge.fillRect(X + 16, H * 0.24, B - 32, sh);
      }
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

/** 屋面杂物贴图：太阳能真空管 / 压型钢板 */
function solarTex() {
  const W = 256, H = 128, c = cv(W, H), g = c.getContext('2d');
  g.fillStyle = '#8a8e92';
  g.fillRect(0, 0, W, H);
  for (let x = 4; x < W; x += 12) {
    const gr = g.createLinearGradient(x, 0, x + 9, 0);
    gr.addColorStop(0, '#1a2430'); gr.addColorStop(0.45, '#4a5a70'); gr.addColorStop(1, '#141c26');
    g.fillStyle = gr;
    g.fillRect(x, 6, 9, H - 12);
  }
  return tex(c);
}
function steelTex(col) {
  const W = 128, c = cv(W, W), g = c.getContext('2d');
  g.fillStyle = col;
  g.fillRect(0, 0, W, W);
  for (let x = 0; x < W; x += 16) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x, 0, 4, W); g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x + 7, 0, 3, W); }
  noise(g, W, W, 12, 9);
  return tex(c);
}
/** 青石板（沿街铺装）：深灰青石，错缝条石 */
function slabTex() {
  const S = 256, c = cv(S, S), g = c.getContext('2d');
  const r = rng(31);
  g.fillStyle = '#7d7d7a';
  g.fillRect(0, 0, S, S);
  const rows = 4, rh = S / rows;
  for (let j = 0; j < rows; j++) {
    let x = -(j % 2) * S * 0.18;
    while (x < S) {
      const w = S * (0.28 + r() * 0.22);
      const v = 128 + r() * 22 | 0;
      g.fillStyle = `rgb(${v},${v},${v - 3})`;
      g.fillRect(x + 1.5, j * rh + 1.5, w - 3, rh - 3);
      x += w;
    }
  }
  noise(g, S, S, 16, 3);
  // 磨损暗斑
  for (let k = 0; k < 14; k++) { g.fillStyle = `rgba(20,20,22,${0.05 + r() * 0.08})`; g.beginPath(); g.ellipse(r() * S, r() * S, 10 + r() * 30, 6 + r() * 16, r() * 3, 0, 6.3); g.fill(); }
  return tex(c);
}

// ─────────────────────────── 材质 ───────────────────────────
function makeMaterials(ctx) {
  const M = {};
  // 全部用天光去蓝材质：晴天阴影里的灰屋面、白瓷砖墙被偏蓝的天光染成冷白蓝（审查 g1：全城俯视回坊是一块淡紫灰蓝斑）
  const std = (o) => new NeutralSkyMaterial({ roughness: 0.88, metalness: 0.0, ...o });
  const nstd = (o) => new NeutralSkyMaterial({ roughness: 0.9, metalness: 0.0, ...o });
  const withEmis = (map, emis, day, night, key, extra = {}) => {
    const m = std({ map, emissiveMap: emis, emissive: 0xffffff, emissiveIntensity: 0, ...extra });
    m.name = 'huimin-' + key;
    ctx.night.register(m, { day, night });
    return m;
  };
  let seed = 3;
  for (const st of STYLE_KEYS) {
    for (const v of [0, 1]) M[`up-${st}-${v}`] = withEmis(upperAtlas(st, v, seed++), upperEmis(v), 0, 0.95, `up-${st}-${v}`);
    M['plain-' + st] = std({ map: plainTex(st, seed++), name: 'huimin-plain-' + st });
  }
  const ad = addonTex();
  M.addon = withEmis(ad.map, ad.emis, 0, 0.9, 'addon', { metalness: 0.25, roughness: 0.6 });
  const sT = shopTex('trad', 11), sM1 = shopTex('modern', 12), sM2 = shopTex('modern', 17);
  M['shop-trad'] = withEmis(sT.map, sT.emis, 0.03, 0.85, 'shop-trad');
  M['shop-modern1'] = withEmis(sM1.map, sM1.emis, 0.05, 0.72, 'shop-modern1');
  M['shop-modern2'] = withEmis(sM2.map, sM2.emis, 0.05, 0.72, 'shop-modern2');
  const tt = templeTex();
  M.temple = withEmis(tt.map, tt.emis, 0, 0.6, 'temple');
  // 灰筒瓦：中性偏暖的灰，压低环境反射（否则天光把瓦面染成藏青）
  const rt = ctx.tex.roofTiles({ color: '#5a5855' });
  M.roofTile = nstd({ map: rt.map, normalMap: rt.normalMap, roughness: 0.86, name: 'huimin-roofTile', side: THREE.DoubleSide });
  // 平顶：暖灰水泥 / 褐色油毡（真实回坊屋面以深灰、褐色水泥平顶为主）
  // 平顶改中性浅灰水泥 / 深灰油毡（原 #6f685f / #53483e 偏褐，俯视整片回坊发红褐）
  const gr = ctx.tex.grain({ color: '#7e7a73', amp: 30, seed: 21, spots: 60 });
  M.roofFlat = nstd({ map: gr.map || gr, roughness: 0.95, name: 'huimin-roofFlat' });
  const gr2 = ctx.tex.grain({ color: '#57524c', amp: 26, seed: 23, spots: 40 });
  M.roofFelt = nstd({ map: gr2.map || gr2, roughness: 0.97, name: 'huimin-roofFelt' });
  M.ridge = nstd({ color: 0x3e3d3b, roughness: 0.85, name: 'huimin-ridge' });
  M.wood = std({ color: 0x4a2f1c, roughness: 0.7, name: 'huimin-wood' });
  M.solar = std({ map: solarTex(), roughness: 0.25, metalness: 0.4, name: 'huimin-solar' });
  M.metal = std({ color: 0xc9ccce, roughness: 0.35, metalness: 0.6, name: 'huimin-metal' });
  M.tankBlue = std({ color: 0x2f62a8, roughness: 0.5, name: 'huimin-tankBlue' });
  M.steelBlue = std({ map: steelTex('#3a6cb0'), roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide, name: 'huimin-steelBlue' });
  M.steelWhite = std({ map: steelTex('#d8dad8'), roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide, name: 'huimin-steelWhite' });
  M.apron = nstd({ map: slabTex(), roughness: 0.9, name: 'huimin-apron' });
  ctx.overlay(M.apron, 0.0004);
  M.step = std({ color: 0x77797a, roughness: 0.85, name: 'huimin-step' });
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
    const o = boxAlong(pts, ax, az);
    if (!best || o.area < best.area) best = o;
  }
  let o = best;
  if (o.bb > o.a) o = { ...o, a: o.bb, bb: o.a, ux: -o.uz, uz: o.ux }; // 长轴为 u
  return o;
}
/** 以 (ux,uz) 为 u 轴的外接矩形 */
function boxAlong(pts, ux, uz) {
  const n = pts.length / 2;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (let k = 0; k < n; k++) {
    const x = pts[k * 2], z = pts[k * 2 + 1];
    const u = x * ux + z * uz, v = -x * uz + z * ux;
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const cu = (u0 + u1) / 2, cv2 = (v0 + v1) / 2;
  return { cx: cu * ux - cv2 * uz, cz: cu * uz + cv2 * ux, a: (u1 - u0) / 2, bb: (v1 - v0) / 2, ux, uz, area: (u1 - u0) * (v1 - v0) };
}

function polyArea(p) {
  let s = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return s / 2;
}

function centroidOf(p) {
  const n = p.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += p[i * 2]; cz += p[i * 2 + 1]; }
  return [cx / n, cz / n];
}

/**
 * 实际层数与高度：数据里回坊西片的 CMAB 高度整片 12.6~14.8 m（4~5 层一刀切）。街坊内部的自建房（非北院门临街、非寺院）
 * 按确定性随机降 0~2 层，得到高低错落的 2~5 层；面积大的楼（> 420 m²，多为单位宿舍楼）保持原高。
 */
export function houseDims(b, streets) {
  const p = b.p;
  const [cx, cz] = centroidOf(p);
  const street = b.st >= 0 ? streets[b.st] : '';
  if (street === '北院门' || b.k === 'mosque' || COMPOUNDS.some((c) => cx > c.x0 && cx < c.x1 && cz > c.z0 && cz < c.z1)) return { h: b.h, fl: b.fl };
  const area = Math.abs(polyArea(p));
  const hv = rand(cx * 0.37 + 11.3, cz * 0.71 - 5.9);
  let fl = b.fl;
  if (fl >= 4 && area < 420) fl -= hv < 0.24 ? 2 : hv < 0.56 ? 1 : 0;
  else if (fl === 3 && hv < 0.2) fl = 2;
  fl = Math.max(area > 40 ? 2 : 1, fl);
  if (fl === b.fl) return { h: b.h, fl };
  return { h: fl * 3.2 + 0.7 + (b.fr && b.fr.length ? 0.4 : 0), fl };
}

/** 道路中线索引（铺装补缝用）：只取街区附近的要素 */
function roadSegs(ctx, data) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of data.district) for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
  const C = 40, grid = new Map();
  const feats = ctx.data.roads?.features || [];
  for (const f of feats) {
    const p = f.p;
    if (!p || f.t || f.b) continue;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
      if (Math.max(ax, bx) < x0 - 30 || Math.min(ax, bx) > x1 + 30 || Math.max(az, bz) < z0 - 30 || Math.min(az, bz) > z1 + 30) continue;
      const s = { ax, az, bx, bz, hw: (Number(f.w) || 6) / 2 };
      const gx0 = Math.floor(Math.min(ax, bx) / C), gx1 = Math.floor(Math.max(ax, bx) / C), gz0 = Math.floor(Math.min(az, bz) / C), gz1 = Math.floor(Math.max(az, bz) / C);
      for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
        const k = gx * 100003 + gz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(s);
      }
    }
  }
  /** 点 (x,z) 到最近道路车行/铺装边缘的距离（30 m 内找不到道路返回 Infinity） */
  const roadClear = (x, z) => {
    let best = Infinity;
    const gx = Math.floor(x / C), gz = Math.floor(z / C);
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iz = gz - 1; iz <= gz + 1; iz++) {
      const L = grid.get(ix * 100003 + iz);
      if (!L) continue;
      for (const s of L) {
        const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1;
        const t = Math.max(0, Math.min(1, ((x - s.ax) * ex + (z - s.az) * ez) / l2));
        const d = Math.hypot(s.ax + ex * t - x, s.az + ez * t - z) - s.hw;
        if (d < best) best = d;
      }
    }
    return best;
  };
  /** 临街边（中点 m、外法线 n、边方向 d）到对面道路车行/铺装边缘的距离；找不到平行道路返回 -1 */
  const apron = (mx, mz, nx, nz, dx, dz) => {
    let best = -1, bd = 1e9;
    const gx = Math.floor(mx / C), gz = Math.floor(mz / C);
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iz = gz - 1; iz <= gz + 1; iz++) {
      const L = grid.get(ix * 100003 + iz);
      if (!L) continue;
      for (const s of L) {
        const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1, l = Math.sqrt(l2);
        if (Math.abs((ex * dx + ez * dz) / l) < 0.8) continue;
        const t = Math.max(0, Math.min(1, ((mx - s.ax) * ex + (mz - s.az) * ez) / l2));
        const qx = s.ax + ex * t, qz = s.az + ez * t;
        const d = Math.hypot(qx - mx, qz - mz);
        if ((qx - mx) * nx + (qz - mz) * nz < 0.5) continue; // 必须在墙外侧
        if (d < bd && d < 30) { bd = d; best = d - s.hw; }
      }
    }
    return best;
  };
  return { apron, roadClear };
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
  const glowPts = [];
  const T = ctx.terrain;
  const streets = data.streets || [];
  const inCompound = (x, z) => COMPOUNDS.find((c) => x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1);
  const RS = roadSegs(ctx, data), apronDist = RS.apron;
  let nSigns = 0, nTrad = 0, nTemple = 0, nClutter = 0, nApron = 0;

  data.b.forEach((b, bi) => {
    const p = b.p;
    const n = p.length / 2;
    if (n < 3) return;
    const [cx, cz] = centroidOf(p);
    const area = Math.abs(polyArea(p));
    let ground = T.heightAt(cx, cz);
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4))) ground = Math.min(ground, T.heightAt(p[i * 2], p[i * 2 + 1]));
    const y0 = ground - 0.4;
    const street = b.st >= 0 ? streets[b.st] : '';
    const comp = inCompound(cx, cz);
    const trad = !comp && (TRAD_LANES.has(street) || street === '北院门');
    const fr = new Set(b.fr);
    const r = rand(cx, cz);
    const r2 = rand(cz * 1.3, cx * 0.7);
    // 墙面风格：回坊主街多青砖；街坊内部自建房青砖、红砖、白瓷砖、水刷石、米黄涂料混用
    // 北院门、西羊市主街：仿明清铺面（青砖木格窗，无空调外机）；其余老街以青砖为主；红砖、白瓷砖只留给背街自建房
    // （原先主街也有 12% 红砖、16% 水泥，暖光下一水红褐砖墙 + 外挂空调，像城中村；审查 g8）
    const mainTrad = !comp && fr.size > 0 && MAIN_TRAD.has(street);
    const st = comp ? 'brick' : mainTrad ? (r < 0.86 ? 'trad' : 'plaster') : trad ? (r < 0.4 ? 'trad' : r < 0.72 ? 'brick' : r < 0.88 ? 'plaster' : 'wash')
      : r < 0.24 ? 'brick' : r < 0.42 ? 'tile' : r < 0.6 ? 'red' : r < 0.72 ? 'plaster' : r < 0.86 ? 'wash' : 'cream';
    const variant = r2 < 0.5 ? 0 : 1;
    const uoff = Math.floor(rand(bi, 1.7) * 4) / 4, voff = rand(bi, 2.9) < 0.5 ? 0 : 1;
    const upMat = `up-${st}-${variant}`;
    let o = obb(p);
    const { h: bh, fl: bfl } = houseDims(b, streets);
    // 寺院 / 庙宇 / 大院内建筑是单层殿堂（数据里沿用了民居的 2~5 层规则）：檐高封顶，大殿略高
    const H = comp ? Math.min(bh, o.a > 12 ? 8.5 : 6) : bh;
    const fl = Math.max(1, bfl);
    const shopH = fr.size ? 3.6 : 3.2;
    const fh = fl > 1 ? (H - shopH) / (fl - 1) : H;
    const rect = o.area > 0 ? area / o.area : 0;
    // 屋顶类型
    let roof = 'flat';
    if (comp) roof = 'hip';
    else if (street === '北院门' && fr.size && rect > 0.75) roof = 'gable';
    else if (fr.size && trad && fl <= 2 && rect > 0.82 && o.bb < 9 && area < 260) roof = 'gable';
    else if (!fr.size && fl <= 1 && rect > 0.85 && o.bb < 7 && r < 0.5) roof = 'gable';
    else if (fl <= 3 && rect > 0.8 && o.bb < 8 && area < 220 && rand(bi, 4.1) < (fr.size ? 0.2 : 0.35)) roof = 'gable';
    if (roof === 'gable') nTrad++;
    if (roof === 'hip') nTemple++;
    // 坡顶屋脊平行于最长的临街面（前后坡朝街），而不是一律沿外接矩形长轴
    if (roof === 'gable' && fr.size) {
      const lf = longestFront(p, fr);
      if (lf >= 0) {
        const j = (lf + 1) % n;
        const dx = p[j * 2] - p[lf * 2], dz = p[j * 2 + 1] - p[lf * 2 + 1], L = Math.hypot(dx, dz) || 1;
        o = boxAlong(p, dx / L, dz / L);
      }
    }
    // 约两成 3 层以上平顶自建房的顶层是彩钢加建层
    const addon = roof === 'flat' && !comp && !trad && fl >= 3 && rand(bi, 6.6) < 0.2;
    const top = y0 + 0.4 + H;
    const eaveY = top;
    // —— 墙 ——
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const nb = Math.max(1, Math.round(L / BAY));
      const isFr = fr.has(i) && L >= 2.4;
      // 立面图集 4 开间 × 2 层：u 每开间 1/4，v 每层 1/2；逐栋错开起始开间与层
      const wallQuad = (mat, ya, yb, va, vb, atlas = true) => {
        const u0 = atlas ? uoff : 0, us = atlas ? 0.25 : 1;
        A(mat).quad([ax, ya, az], [ax, yb, az], [bx, yb, bz], [bx, ya, bz], [u0 + nb * us, va], [u0 + nb * us, vb], [u0, vb], [u0, va]);
      };
      const floorV = (f, a0 = 0, a1 = 1) => [(f + voff + a0) / 2, (f + voff + a1) / 2];
      if (comp) {
        // 殿堂墙面：贴图竖向只铺一次（额枋在上、槛窗居中、下碱在下），开间宽随檐高放大
        const tb = Math.max(1, Math.round(L / Math.max(3.2, (eaveY - y0) * 0.6)));
        A('temple').quad([ax, y0, az], [ax, eaveY, az], [bx, eaveY, bz], [bx, y0, bz], [tb, 0], [tb, 1], [0, 1], [0, 0]);
        continue;
      }
      if (L < 2.2) {
        wallQuad('plain-' + st, y0, eaveY + (roof === 'flat' ? 0.7 : 0), 0, (H + 1.1) / 3.2, false);
        continue;
      }
      // 首层
      const g1 = y0 + 0.4 + (fl > 1 ? shopH : H);
      if (isFr) wallQuad(trad ? 'shop-trad' : r < 0.5 ? 'shop-modern1' : 'shop-modern2', y0, g1, -0.11, 1);
      else wallQuad(upMat, y0, g1, ...floorV(0, -0.12, 1));
      // 上层（加建层换彩钢板）
      for (let f = 1; f < fl; f++) {
        const ya = y0 + 0.4 + shopH + (f - 1) * fh, yb = ya + fh;
        if (addon && f === fl - 1) wallQuad('addon', ya, yb, 0, 1, false);
        else wallQuad(upMat, ya, yb, ...floorV(f));
      }
      // 女儿墙
      if (roof === 'flat') wallQuad(addon ? 'steelWhite' : 'plain-' + st, top, top + 0.7, 0, 0.22, false);
      const dx = (bx - ax) / L, dz = (bz - az) / L, nx = dz, nz = -dx;
      // 临街：披檐、招牌、灯笼、墙根石阶与沿街铺装
      if (isFr && fl > 1 && roof === 'flat') {
        const ey = g1 + 0.95, d = trad ? 1.1 : 0.7, drop = trad ? 0.55 : 0.3;
        A('roofTile').quad(
          [bx + nx * d, ey - drop, bz + nz * d], [ax + nx * d, ey - drop, az + nz * d], [ax, ey, az], [bx, ey, bz],
          [0, 0], [L / 1.2, 0], [L / 1.2, d], [0, d],
        );
      }
      if (isFr) {
        // 墙根石阶（0.5 m 深、高出铺装 0.15 m）
        const gA = T.heightAt(ax + nx * 0.5, az + nz * 0.5), gB = T.heightAt(bx + nx * 0.5, bz + nz * 0.5);
        const s0 = 0.03, s1 = 0.5;
        const S = A('step');
        S.quad([ax + nx * s0, gA + 0.36, az + nz * s0], [bx + nx * s0, gB + 0.36, bz + nz * s0], [bx + nx * s1, gB + 0.36, bz + nz * s1], [ax + nx * s1, gA + 0.36, az + nz * s1], [0, 0], [L, 0], [L, 0.5], [0, 0.5]);
        S.quad([ax + nx * s1, gA + 0.1, az + nz * s1], [ax + nx * s1, gA + 0.36, az + nz * s1], [bx + nx * s1, gB + 0.36, bz + nz * s1], [bx + nx * s1, gB + 0.1, bz + nz * s1], [0, 0], [0, 0.26], [L, 0.26], [L, 0]);
        // 青石板铺到路面边缘（与道路铺装重叠 0.6 m；道路略高 3 cm，压在上面）
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const dd = apronDist(mx, mz, nx, nz, dx, dz);
        const ap = dd < 0 ? 2.5 : Math.min(4.5, dd + 0.6);
        if (ap > 0.6) {
          const P = (x, z) => [x, T.heightAt(x, z) + 0.2, z];
          const a0 = P(ax + nx * s1, az + nz * s1), b0 = P(bx + nx * s1, bz + nz * s1), b1 = P(bx + nx * ap, bz + nz * ap), a1 = P(ax + nx * ap, az + nz * ap);
          const k = 1 / 1.6;
          A('apron').quad(a0, b0, b1, a1, [0, s1 * k], [L * k, s1 * k], [L * k, ap * k], [0, ap * k]);
          nApron++;
        }
        // 夜间暖光斑：铺面门前每 ~4.5 m 一块
        if (GLOW_LANES.has(street) || trad) {
          const k = Math.max(1, Math.round(L / 5.5));
          for (let q = 0; q < k; q++) {
            const t = (q + 0.5) / k;
            const gx = ax + (bx - ax) * t + nx * 1.8, gz = az + (bz - az) * t + nz * 1.8;
            glowPts.push([gx, T.heightAt(gx, gz) + 0.24, gz, 4.2 + rand(gx, gz) * 1.2, 1.25, Math.atan2(-dz, dx)]);
          }
        }
      }
      if (isFr) {
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const wantSign = b.sg || (trad ? r < 0.6 : street === '洒金桥' ? r < 0.75 : r < 0.4);
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
            const lx = ax + dx * (Math.min(0.9, L * 0.2) + 0.45) + nx * 0.9, lz = az + dz * (Math.min(0.9, L * 0.2) + 0.45) + nz * 0.9;
            // place() 会沿牌面法线再外移 0.45 m：两面各自朝 ±d，最终相距 3 cm
            for (const sd of [1, -1]) signReq.push({ text: vt, real, p: { x: lx - sd * dx * 0.435, y: ly, z: lz - sd * dz * 0.435 }, nx: sd * dx, nz: sd * dz, h: lh, maxW: 3.2, opts: led });
          }
        }
        // 红灯笼（回坊主街，每开间一盏）：两层以上平顶铺面挂在披檐下、招牌下方（披檐在 0.85 m 处高 g1+0.525，招牌 g1+0.09…0.81，
        // 灯笼含提梁 +0.48、流苏 -0.67）；坡顶挂在檐下封口（top-0.19）以下；与招牌同高时让开招牌所在的一段
        if (trad && fl >= 1) {
          const k = Math.max(1, Math.round(L / 3.4));
          const out = roof === 'flat' ? 0.85 : 0.6;
          const ly = fl > 1 && roof === 'flat' ? g1 - 0.35 : top - (roof === 'flat' ? 0.55 : 0.75);
          const avoid = signHalf > 0 && ly - 0.67 < signY + 0.36 && ly + 0.48 > signY - 0.36 ? signHalf + 0.35 : 0;
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
      const W = A(addon ? 'steelWhite' : 'plain-' + st), yt = top + 0.7;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.05) continue;
        const cx2 = pin[i * 2], cz2 = pin[i * 2 + 1], ex = pin[j * 2], ez = pin[j * 2 + 1];
        const u = Math.max(1, Math.round(L / BAY));
        W.quad([ex, top, ez], [ex, yt, ez], [cx2, yt, cz2], [cx2, top, cz2], [0, 0], [0, 0.22], [u, 0.22], [u, 0]); // 内侧面，朝内
        W.quad([ax, yt, az], [cx2, yt, cz2], [ex, yt, ez], [bx, yt, bz], [0, 0], [0, 0.07], [u, 0.07], [u, 0]); // 压顶，朝上
      }
    }
    // —— 屋顶 ——
    if (roof === 'flat') {
      const contour = [];
      for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const RF = A(rand(bi, 3.3) < 0.25 ? 'roofFelt' : 'roofFlat');
      for (const [a, c2, d] of tris) {
        const P = (k) => [p[k * 2], top, p[k * 2 + 1]];
        const U = (k) => [p[k * 2] / 4, p[k * 2 + 1] / 4];
        // 朝上：保证法线 y>0
        const v1 = [p[c2 * 2] - p[a * 2], p[c2 * 2 + 1] - p[a * 2 + 1]], v2 = [p[d * 2] - p[a * 2], p[d * 2 + 1] - p[a * 2 + 1]];
        const ny = v1[1] * v2[0] - v1[0] * v2[1];
        if (ny > 0) RF.tri(P(a), P(c2), P(d), U(a), U(c2), U(d));
        else RF.tri(P(a), P(d), P(c2), U(a), U(d), U(c2));
      }
      if (!comp) nClutter += roofClutter(A, p, o, top, bi, area, st);
    } else {
      const over = roof === 'hip' ? 1.1 : 0.55;
      const ux = o.ux, uz = o.uz, vx = -uz, vz = ux;
      const P = (u, v, y) => [o.cx + ux * u + vx * v, y, o.cz + uz * u + vz * v];
      const R = A('roofTile');
      if (roof === 'hip') {
        const a = o.a + over, bb = o.bb + over;
        const rise = Math.min(o.bb * 0.62, 6.5);
        const ey = eaveY - over * 0.35;
        const ridgeA = Math.max(0.3, a - bb);
        const ry = eaveY + rise;
        R.quad(P(-a, bb, ey), P(a, bb, ey), P(ridgeA, 0, ry), P(-ridgeA, 0, ry), [0, 0], [2 * a / 1.2, 0], [2 * a / 1.2, bb], [0, bb]);
        R.quad(P(a, -bb, ey), P(-a, -bb, ey), P(-ridgeA, 0, ry), P(ridgeA, 0, ry), [0, 0], [2 * a / 1.2, 0], [2 * a / 1.2, bb], [0, bb]);
        R.tri(P(a, bb, ey), P(a, -bb, ey), P(ridgeA, 0, ry), [0, 0], [2 * bb / 1.2, 0], [bb / 1.2, bb]);
        R.tri(P(-a, -bb, ey), P(-a, bb, ey), P(-ridgeA, 0, ry), [0, 0], [2 * bb / 1.2, 0], [bb / 1.2, bb]);
        boxAt(A('ridge'), o.cx, ry - 0.08, o.cz, 2 * ridgeA + 0.3, 0.32, 0.28, ux, uz);
        if (o.a > 8) for (const s of [-1, 1]) boxAt(A('ridge'), o.cx + ux * s * ridgeA, ry, o.cz + uz * s * ridgeA, 0.5, 1.1, 0.4, ux, uz); // 大殿正吻（简化）
        R.quad(P(-a, -bb, ey), P(a, -bb, ey), P(a, bb, ey), P(-a, bb, ey), [0, 0], [1, 0], [1, 1], [0, 1]);
      } else {
        // 硬山：进深大（> 9 m）时做成几道平行坡顶（连排街房），每道进深约 8~9 m
        const a = o.a + 0.25;
        const k = Math.max(1, Math.round((2 * o.bb) / 8.5));
        const w = (2 * o.bb) / k;
        const ey = eaveY - over * 0.35;
        const W = A('plain-' + st);
        for (let s = 0; s < k; s++) {
          const v0 = -o.bb + s * w, v1 = v0 + w, vc = (v0 + v1) / 2;
          const e0 = s === 0 ? v0 - over : v0, e1 = s === k - 1 ? v1 + over : v1;
          const rise = (w / 2) * 0.58;
          const ry = eaveY + rise;
          const half = w / 2 + over;
          R.quad(P(-a, e1, ey), P(a, e1, ey), P(a, vc, ry), P(-a, vc, ry), [0, 0], [2 * a / 1.2, 0], [2 * a / 1.2, half], [0, half]);
          R.quad(P(a, e0, ey), P(-a, e0, ey), P(-a, vc, ry), P(a, vc, ry), [0, 0], [2 * a / 1.2, 0], [2 * a / 1.2, half], [0, half]);
          // 硬山山墙（三角）
          W.tri(P(o.a, v1, eaveY), P(o.a, v0, eaveY), P(o.a, vc, ry - 0.1), [0, 0], [w / 3.2, 0], [w / 6.4, rise / 3.2]);
          W.tri(P(-o.a, v0, eaveY), P(-o.a, v1, eaveY), P(-o.a, vc, ry - 0.1), [0, 0], [w / 3.2, 0], [w / 6.4, rise / 3.2]);
          boxAt(A('ridge'), o.cx + vx * vc, ry - 0.08, o.cz + vz * vc, 2 * a + 0.3, 0.32, 0.28, ux, uz);
        }
        // 坡顶下封口（檐口到墙顶的水平面，避免从下看穿帮）
        R.quad(P(-a, -o.bb - over, ey), P(a, -o.bb - over, ey), P(a, o.bb + over, ey), P(-a, o.bb + over, ey), [0, 0], [1, 0], [1, 1], [0, 1]);
      }
    }
  });

  // —— 院落树：院落 / 巷口空地（离墙 2~8 m、离路面边缘 ≥ 1.2 m），约每 60~90 m² 空地一棵 ——
  const treePts = courtyardTreePoints(data, T, RS.roadClear);
  // —— 招牌入图集：真实店名优先，其次通用横匾，竖招最后且按字数从多到少（同高条目排在同一行，图集利用率高） ——
  const rank = (q) => (q.opts.vertical ? 2 : q.real ? 0 : 1);
  signReq.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.text.length - a.text.length || b.real - a.real : 0));
  for (const q of signReq) signs.place(q.text, q.p, q.nx, q.nz, q.h, q.maxW, q.opts);

  // —— 输出 ——
  const group = new THREE.Group();
  group.name = '回民街·洒金桥';
  const houseMeshes = [];
  const NO_SHADOW = new Set(['apron']);
  for (const [k, a] of acc) {
    if (!a.p.length) continue;
    const m = new THREE.Mesh(a.geometry(), M[k]);
    m.castShadow = !NO_SHADOW.has(k);
    m.receiveShadow = true;
    m.name = k;
    if (k === 'apron') m.renderOrder = -1;
    group.add(m);
    houseMeshes.push(m);
  }
  const detail = new THREE.Group();
  detail.name = '回民街细部';
  const sm = signs.build();
  if (sm) {
    sm.name = '回民街招牌';
    detail.add(sm);
  }
  let lanternMesh = null;
  if (lanternPos.length) detail.add((lanternMesh = lanternGroup(ctx, lanternPos, { scale: 1, halo: 1.6, name: '回民街灯笼' })));
  if (glowPts.length) detail.add(groundGlow(ctx, glowPts, { color: 0xffa04a, night: 0.11, name: '回民街铺面暖光' }));
  if (treePts.length) {
    const tg = courtyardTrees(ctx, treePts, { name: '回民街院落树' });
    group.add(tg);
    for (const m of tg.children) houseMeshes.push(m); // 远景低模时一并隐藏
  }
  group.add(detail);
  return { group, detail, lanternMesh, houseMeshes, stats: { signs: nSigns, trad: nTrad, temple: nTemple, lanterns: lanternPos.length / 3, clutter: nClutter, apron: nApron, glow: glowPts.length, trees: treePts.length } };
}

/** 院落树的落点：7.5 m 抖动网格采样，留在街区内、房子之间的院落与巷口（离墙 2~8 m） */
function courtyardTreePoints(data, T, roadClear) {
  const C = 16, grid = new Map();
  const bb = [];
  data.b.forEach((b, i) => {
    const p = b.p;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < p.length; k += 2) { x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); z0 = Math.min(z0, p[k + 1]); z1 = Math.max(z1, p[k + 1]); }
    bb.push([x0, z0, x1, z1]);
    for (let gx = Math.floor(x0 / C); gx <= Math.floor(x1 / C); gx++) for (let gz = Math.floor(z0 / C); gz <= Math.floor(z1 / C); gz++) {
      const k = gx * 100003 + gz;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  });
  const near = (x, z, m) => {
    const gx = Math.floor(x / C), gz = Math.floor(z / C);
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iz = gz - 1; iz <= gz + 1; iz++) {
      for (const i of grid.get(ix * 100003 + iz) || []) {
        const r = bb[i];
        if (x < r[0] - m || x > r[2] + m || z < r[1] - m || z > r[3] + m) continue;
        const p = data.b[i].p;
        if (pointInPoly(x, z, p)) return true;
        for (let k = 0, n = p.length / 2; k < n; k++) {
          const j = (k + 1) % n;
          const ax = p[k * 2], az = p[k * 2 + 1], ex = p[j * 2] - ax, ez = p[j * 2 + 1] - az, l2 = ex * ex + ez * ez || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
          if (Math.hypot(ax + ex * t - x, az + ez * t - z) < m) return true;
        }
      }
    }
    return false;
  };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of data.district) for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
  const out = [];
  const S = 7.5;
  for (let z = z0 + S / 2; z < z1; z += S) {
    for (let x = x0 + S / 2; x < x1; x += S) {
      const h = rand(x * 0.13 + 3.1, z * 0.17 - 7.3);
      if (h > 0.62) continue;
      const px = x + (rand(x, z * 1.7) - 0.5) * S * 0.8, pz = z + (rand(z, x * 1.3) - 0.5) * S * 0.8;
      if (!data.district.some((p) => pointInPoly(px, pz, p))) continue;
      if (roadClear(px, pz) < 1.2) continue;
      // 院落 / 巷口：离墙 ≥ 2 m、但 8 m 内要有房子（大片空场——停车场、校园操场、工地——不种成树林）
      if (near(px, pz, 2.0) || !near(px, pz, 8.0)) continue;
      out.push([px, T.heightAt(px, pz), pz, 0.75 + rand(px, pz) * 0.55]);
    }
  }
  return out;
}

/**
 * 平顶屋面杂物：楼梯间、太阳能热水器（朝南）、水箱、彩钢加建棚。返回件数。
 * 位置取外接矩形内的候选点，四角都落在轮廓内才放（不规则轮廓不会伸出墙外）
 */
function roofClutter(A, p, o, top, bi, area, st) {
  if (area < 30) return 0;
  const ux = o.ux, uz = o.uz, vx = -uz, vz = ux;
  const at = (u, v) => [o.cx + ux * u + vx * v, o.cz + uz * u + vz * v];
  const fitsUV = (u, v, hu, hv) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([a, b]) => { const [x, z] = at(u + a * hu, v + b * hv); return pointInPoly(x, z, p); });
  let cnt = 0;
  const used = [];
  const free = (u, v, r) => used.every(([a, b, rr]) => Math.hypot(a - u, b - v) > r + rr);
  // 楼梯间（出屋面）
  if (area > 50 && rand(bi, 31) < 0.45) {
    const su = (rand(bi, 32) < 0.5 ? -1 : 1) * Math.max(0, o.a - 1.6);
    if (fitsUV(su, 0, 1.4, 1.3)) {
      const [x, z] = at(su, 0);
      boxAt(A('plain-' + st), x, top, z, 2.6, 2.5, 2.4, ux, uz);
      boxAt(A('roofFlat'), x, top + 2.5, z, 2.8, 0.12, 2.6, ux, uz);
      used.push([su, 0, 1.8]);
      cnt++;
    }
  }
  // 太阳能热水器：1~3 台，面板朝南（+Z）倾斜 40°，背后横置保温水箱
  if (area > 35 && rand(bi, 33) < 0.6) {
    const k = 1 + Math.floor(rand(bi, 34) * Math.min(3, area / 60));
    for (let q = 0; q < k; q++) {
      const u = (rand(bi, 35 + q) - 0.5) * Math.max(0, o.a * 2 - 3), v = (rand(bi, 45 + q) - 0.5) * Math.max(0, o.bb * 2 - 3);
      if (!free(u, v, 1.3) || !fitsUV(u, v, 1.1, 1.1)) continue;
      const [x, z] = at(u, v);
      solarHeater(A, x, top + 0.0, z);
      used.push([u, v, 1.3]);
      cnt++;
    }
  }
  // 水箱（蓝色塑料 / 不锈钢立罐）
  if (area > 40 && rand(bi, 51) < 0.32) {
    const u = (rand(bi, 52) - 0.5) * Math.max(0, o.a * 2 - 2.5), v = (rand(bi, 53) - 0.5) * Math.max(0, o.bb * 2 - 2.5);
    if (free(u, v, 0.9) && fitsUV(u, v, 0.8, 0.8)) {
      const [x, z] = at(u, v);
      boxAt(A('plain-plaster'), x, top, z, 1.3, 0.4, 1.3, ux, uz);
      prism(A(rand(bi, 54) < 0.4 ? 'tankBlue' : 'metal'), x, top + 0.4, z, 0.6, 1.3, 7);
      used.push([u, v, 0.9]);
      cnt++;
    }
  }
  // 彩钢加建棚（单坡蓝 / 白钢板顶，三面围合）
  if (area > 80 && rand(bi, 61) < 0.22) {
    const w = Math.min(5.5, o.a * 0.9), d = Math.min(4.2, o.bb * 1.2);
    const su = (rand(bi, 62) < 0.5 ? -1 : 1) * Math.max(0, o.a - w / 2 - 0.3), sv = (rand(bi, 63) < 0.5 ? -1 : 1) * Math.max(0, o.bb - d / 2 - 0.3);
    if (free(su, sv, Math.hypot(w, d) / 2) && fitsUV(su, sv, w / 2, d / 2)) {
      const [x, z] = at(su, sv);
      shed(A, x, top, z, w, d, ux, uz, rand(bi, 64) < 0.4 ? 'steelBlue' : 'steelWhite');
      cnt++;
    }
  }
  return cnt;
}

/** 太阳能热水器：面板（朝南、倾 40°）+ 横置水箱 + 支架 */
function solarHeater(A, x, y, z) {
  const hw = 0.95;
  const zf = z + 0.55, zb = z - 0.55, yf = y + 0.3, yb = y + 1.25;
  A('solar').quad([x - hw, yf, zf], [x + hw, yf, zf], [x + hw, yb, zb], [x - hw, yb, zb], [0, 0], [1, 0], [1, 1], [0, 1]);
  const M = A('metal');
  // 背面（从北侧看）
  M.quad([x + hw, yf, zf], [x - hw, yf, zf], [x - hw, yb, zb], [x + hw, yb, zb], [0, 0], [1, 0], [1, 1], [0, 1]);
  boxAt(M, x, yb - 0.05, zb - 0.2, 2.05, 0.42, 0.42, 1, 0); // 水箱（方形近似）
  // 两侧三角支架（单片，朝外）
  for (const s of [-1, 1]) {
    const xs = x + s * (hw - 0.02);
    const a = [xs, y, zf], b = [xs, y, zb - 0.2], c = [xs, yb, zb - 0.2];
    if (s > 0) M.tri(a, b, c, [0, 0], [1, 0], [1, 1]);
    else M.tri(a, c, b, [0, 0], [1, 1], [1, 0]);
  }
}

/** 彩钢棚：三面墙 + 单坡顶（坡向局部 -v） */
function shed(A, x, y, z, w, d, ux, uz, mat) {
  const vx = -uz, vz = ux, h0 = 2.3, h1 = 2.8;
  const P = (u, v, yy) => [x + ux * u + vx * v, yy, z + uz * u + vz * v];
  const W = A(mat), hw = w / 2, hd = d / 2;
  // 墙（u+ / u- / v+ 三面，v- 面开敞）
  W.quad(P(hw, -hd, y), P(hw, hd, y), P(hw, hd, y + h1), P(hw, -hd, y + h0), [0, 0], [d / 2, 0], [d / 2, 1], [0, 1]);
  W.quad(P(-hw, hd, y), P(-hw, -hd, y), P(-hw, -hd, y + h0), P(-hw, hd, y + h1), [0, 0], [d / 2, 0], [d / 2, 1], [0, 1]);
  W.quad(P(-hw, hd, y + h1), P(hw, hd, y + h1), P(hw, hd, y), P(-hw, hd, y), [0, 1], [w / 2, 1], [w / 2, 0], [0, 0]);
  // 单坡顶（出檐 0.3 m）
  W.quad(P(-hw - 0.3, -hd - 0.3, y + h0 - 0.05), P(hw + 0.3, -hd - 0.3, y + h0 - 0.05), P(hw + 0.3, hd + 0.2, y + h1 + 0.03), P(-hw - 0.3, hd + 0.2, y + h1 + 0.03), [0, 0], [w / 2, 0], [w / 2, d / 2], [0, d / 2]);
}

/** 竖直多棱柱（带顶盖） */
function prism(acc, x, y, z, r, h, seg) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = [x + Math.cos(a0) * r, z + Math.sin(a0) * r], p1 = [x + Math.cos(a1) * r, z + Math.sin(a1) * r];
    acc.quad([p0[0], y, p0[1]], [p0[0], y + h, p0[1]], [p1[0], y + h, p1[1]], [p1[0], y, p1[1]], [0, 0], [0, 1], [1, 1], [1, 0]);
    acc.tri([x, y + h, z], [p1[0], y + h, p1[1]], [p0[0], y + h, p0[1]], [0.5, 0.5], [1, 0], [0, 0]);
  }
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

/**
 * 远景低模：逐户轮廓拉伸成平顶体块（墙面米黄、屋顶深灰顶点色），全街区一个网格（约 7700 栋 → 十几万三角形），
 * 由 huimin 模块在离街区 FAR_R 以外代替精细街区显示。高度与精细街区一致（houseDims）。
 */
export function buildHuiminFar(ctx, data) {
  const T = ctx.terrain;
  const streets = data.streets || [];
  const pos = [], col = [], idx = [];
  // 颜色压暗 + 逐栋明暗变化：远看要与精细街区（青砖、灰瓦、少量白墙）的整体色调一致，否则全城俯视时街区成一块平板亮斑
  // 屋面按近景实际构成加权：约 2/3 浅灰水泥平顶、1/5 深灰油毡、其余灰瓦（原先统一深褐 [0.15,0.13,0.11]，
  // 全城俯视时整片回坊是一块边界方正的褐红“地毯”，与四周灰白城区断开；审查 g1）
  const WALL = [0.25, 0.24, 0.225];
  const ROOFS = [[0.27, 0.262, 0.245], [0.15, 0.145, 0.138], [0.115, 0.113, 0.108]];
  let base = 0;
  for (const b of data.b) {
    const p = b.p;
    const n = p.length / 2;
    if (n < 3 || !(b.h > 0)) continue;
    const [cx, cz] = centroidOf(p);
    const hv = Math.abs(Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453) % 1; // 逐栋哈希
    const kw = 0.8 + hv * 0.4, kr = 0.82 + ((hv * 7.31) % 1) * 0.36;
    const rk = (hv * 13.7) % 1, ROOF = ROOFS[rk < 0.66 ? 0 : rk < 0.86 ? 1 : 2];
    const tint = (((hv * 29.3) % 1) - 0.5) * 0.04; // 轻微冷暖抖动
    const WALL_C = [WALL[0] * kw, WALL[1] * kw, WALL[2] * kw], ROOF_C = [ROOF[0] * kr * (1 + tint), ROOF[1] * kr, ROOF[2] * kr * (1 - tint)];
    let ground = T.heightAt(cx, cz);
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4))) ground = Math.min(ground, T.heightAt(p[i * 2], p[i * 2 + 1]));
    const y0 = ground - 0.4, y1 = ground + houseDims(b, streets).h;
    // 外环方向（保证墙面法线朝外：这里不写法线，着色器用 flat 顶点色即可，用 computeVertexNormals）
    let a2 = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; a2 += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
    const ccw = a2 < 0; // 世界 Z 向南：shoelace < 0 表示从上方看逆时针
    // 墙：每边两个三角形（顶点不共享，便于平直着色）
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
      pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
      for (let k = 0; k < 4; k++) col.push(WALL_C[0], WALL_C[1], WALL_C[2]);
      if (ccw) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      base += 4;
    }
    // 屋顶
    const flat = [];
    for (let i = 0; i < n; i++) flat.push(p[i * 2] - cx, p[i * 2 + 1] - cz);
    const tri = earcut(flat, null, 2);
    for (let i = 0; i < n; i++) { pos.push(p[i * 2], y1, p[i * 2 + 1]); col.push(ROOF_C[0], ROOF_C[1], ROOF_C[2]); }
    for (let k = 0; k < tri.length; k += 3) {
      const a = tri[k], bq = tri[k + 1], c = tri[k + 2];
      const x1 = flat[bq * 2] - flat[a * 2], z1 = flat[bq * 2 + 1] - flat[a * 2 + 1], x2 = flat[c * 2] - flat[a * 2], z2 = flat[c * 2 + 1] - flat[a * 2 + 1];
      if (z1 * x2 - x1 * z2 >= 0) idx.push(base + a, base + bq, base + c);
      else idx.push(base + a, base + c, base + bq);
    }
    base += n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  // 双面：轮廓环方向不一，远景低模不值得逐栋判向；天光去蓝，平屋顶不要被天空照成淡蓝色
  const m = new THREE.Mesh(g, new NeutralSkyMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
  m.name = '回民街远景低模';
  m.castShadow = false;
  m.receiveShadow = true;
  return m;
}
