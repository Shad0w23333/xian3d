// 城市植被：树种定义、Canvas 程序化叶簇/树皮图集、程序化树木几何（近景完整 LOD）。
// 由 src/modules/vegetation.js 使用。全部程序化生成，无外部素材。
//
// 树种资料（西安园林/行道树调查、《西安市基调树种》、实地照片 research/refs/vegetation/）：
//   国槐 Styphnolobium japonicum —— 西安市树，行道树主力（约 25%）。成年行道树高 8~14 m，冠幅 6~10 m，
//        分枝点 2.5~3 m，圆球形/伞形冠；树皮暗灰褐、纵裂；羽状复叶，小叶 7~17 枚、长 2.5~6 cm，深绿。
//   法国梧桐 二球悬铃木 Platanus × acerifolia —— 友谊路、唐延路、丈八东路、太白路等老路/主干道。高 15~25 m，
//        冠幅 12~20 m，杯状整形（分枝点约 3 m，3~4 主枝斜展形成绿廊）；树皮灰绿/米白/褐色斑驳片状剥落；
//        掌状 3~5 裂大叶 12~25 cm，9 月下旬仍绿、少量泛黄褐。
//   雪松 Cedrus deodara —— 公园、机关单位大院、校园常见（西北大学、交大等五六十年代栽植）。高 15~25 m，
//        塔形，大枝近平展、枝梢下垂，针叶灰绿/蓝绿色。
//   垂柳 Salix babylonica —— 护城河、兴庆湖、曲江池、汉城湖等水岸。高 8~15 m，冠幅 8~12 m，
//        细长枝条下垂可近地面，叶狭披针形、黄绿色；树干常向水面倾斜。
//   银杏 Ginkgo biloba —— 近 20 年行道树新宠（雁塔西路“黄金大道”等）。高 10~15 m（街道多为 8~12 m 青年树），
//        主干通直、冠塔形至长卵形；扇形叶，9 月下旬开始由绿转微黄（11 月才全黄）。
//   石榴 Punica granatum —— 西安市花，小区/公园小乔木，高 3~5 m，常多干丛生，叶小有光泽；9 月果实红熟。
//   灌木：大叶黄杨/小叶女贞/海桐球、红叶石楠（新叶红色）绿篱，高 0.6~1.5 m，常修剪成球或篱带。
import * as THREE from 'three';

export const SP = { HUAI: 0, WUTONG: 1, XUESONG: 2, LIU: 3, YINXING: 4, SHILIU: 5, GUANMU: 6 };
export const SPECIES_COUNT = 7;
export const SPECIES_NAMES = ['国槐', '法国梧桐', '雪松', '垂柳', '银杏', '石榴', '灌木'];

// 每个树种叶片的实例着色参数（叶片乘色 rgb，w=秋色/泛黄程度上限）
export const LEAF_TINT = [
  [0.96, 1.0, 0.92, 0.04], // 国槐
  [1.0, 1.0, 0.94, 0.12], // 法桐：9 月下旬少量泛黄褐
  [0.86, 0.95, 0.88, 0.0], // 雪松（压低蓝调，偏暗灰绿）
  [1.0, 1.0, 0.9, 0.03], // 垂柳
  [1.0, 1.0, 0.92, 0.32], // 银杏：开始微黄
  [0.98, 1.0, 0.95, 0.03], // 石榴
  [0.95, 1.0, 0.94, 0.0], // 灌木
];

export const ATLAS = 2048;

// ---------------------------------------------------------------------------
// 随机数
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 图集布局：上半 2 行 × 4 列 512² 叶簇瓦片；下半 8 条 256×1024 树皮条（u 绕周向可平铺，v 沿树干）
// DataTexture（flipY=false）：图像第 0 行 = v 0。这里统一用“画布坐标”描述，再换算 UV。
const LEAF_T = 512;
export function leafRect(i) {
  return { x: (i % 4) * LEAF_T, y: ((i / 4) | 0) * LEAF_T, w: LEAF_T, h: LEAF_T };
}
export function barkRect(j) {
  return { x: j * 256, y: 1024, w: 256, h: 1024 };
}
/** 画布矩形 → UV：u0/u1 左右，vTop 为画布上边（小 y），vBot 为画布下边 */
export function rectUV(r, inset = 3) {
  return {
    u0: (r.x + inset) / ATLAS,
    u1: (r.x + r.w - inset) / ATLAS,
    vTop: (r.y + inset) / ATLAS,
    vBot: (r.y + r.h - inset) / ATLAS,
  };
}
// 叶簇瓦片编号
export const LT = { HUAI: 0, WUTONG: 1, XUESONG: 2, LIU: 3, YINXING: 4, SHILIU: 5, GUANMU: 6, DENSE: 7 };
// 树皮条编号
export const BT = { HUAI: 0, WUTONG: 1, XUESONG: 2, LIU: 3, YINXING: 4, SHILIU: 5, TWIG: 6, SHRUB: 7 };

const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a})`;

function clipRect(g, r, pad) {
  g.save();
  g.beginPath();
  g.rect(r.x + pad, r.y + pad, r.w - pad * 2, r.h - pad * 2);
  g.clip();
}

function ellipseLeaf(g, x, y, ang, len, wid, fill, rib) {
  // 以叶柄为原点、沿 ang 方向伸出的卵形/披针形叶片
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(len * 0.25, -wid * 1.1, len * 0.75, -wid * 0.95, len, 0);
  g.bezierCurveTo(len * 0.75, wid * 0.95, len * 0.25, wid * 1.1, 0, 0);
  g.fill();
  if (rib) {
    g.strokeStyle = rib;
    g.lineWidth = Math.max(0.6, wid * 0.14);
    g.beginPath();
    g.moveTo(len * 0.05, 0);
    g.lineTo(len * 0.9, 0);
    g.stroke();
  }
  g.restore();
}

/** 叶簇明暗：离簇心越远、越靠上越亮（模拟外层受光） */
function clusterShade(dx, dy, R) {
  const r = Math.min(1, Math.hypot(dx, dy) / R);
  return 0.72 + 0.28 * r + (-dy / R) * 0.1;
}

// —— 国槐：羽状复叶，小叶卵形，深绿 ——
function drawHuai(g, rc, rand) {
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, R = 226;
  clipRect(g, rc, 10);
  for (let layer = 0; layer < 3; layer++) {
    const n = [16, 24, 22][layer];
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const r0 = rand() * R * (layer === 2 ? 0.55 : 0.4);
      let sx = cx + Math.cos(a) * r0, sy = cy + Math.sin(a) * r0;
      const dir = a + (rand() - 0.5) * 0.9;
      let len = 95 + rand() * 80;
      // 保证叶尖在簇半径内
      const ex = sx + Math.cos(dir) * len - cx, ey = sy + Math.sin(dir) * len - cy;
      const over = Math.hypot(ex, ey) - R;
      if (over > 0) len = Math.max(40, len - over);
      const shade = clusterShade(sx + Math.cos(dir) * len * 0.5 - cx, sy + Math.sin(dir) * len * 0.5 - cy, R);
      const L0 = [17, 23, 28][layer] * shade + rand() * 5;
      const H = 92 + rand() * 16, S = 42 + rand() * 14;
      g.strokeStyle = hsl(80, 30, L0 * 0.8);
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(dir) * len, sy + Math.sin(dir) * len);
      g.stroke();
      const pairs = 4 + ((rand() * 4) | 0);
      for (let k = 0; k <= pairs; k++) {
        const t = 0.18 + (k / pairs) * 0.8;
        const px = sx + Math.cos(dir) * len * t, py = sy + Math.sin(dir) * len * t;
        const ll = 17 + rand() * 7, ww = 6.5 + rand() * 2.5;
        const L = L0 + (rand() - 0.5) * 7;
        if (k === pairs) ellipseLeaf(g, px, py, dir, ll + 3, ww, hsl(H, S, L), hsl(H, S * 0.8, L + 8, 0.5));
        else
          for (const s of [-1, 1]) ellipseLeaf(g, px, py, dir + s * (1.0 + rand() * 0.35), ll, ww, hsl(H + (rand() - 0.5) * 6, S, L + (rand() - 0.5) * 4), hsl(H, S * 0.7, L + 9, 0.45));
      }
    }
  }
  g.restore();
}

// —— 法国梧桐：掌状 3~5 裂大叶 ——
function palmLeaf(g, x, y, ang, s, fill, vein) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = fill;
  g.beginPath();
  const lobes = [
    [-1.45, 0.52], [-0.78, 0.86], [0, 1.0], [0.78, 0.86], [1.45, 0.52],
  ];
  g.moveTo(0, 0);
  for (let i = 0; i < lobes.length; i++) {
    const [a, r] = lobes[i];
    const prev = i ? lobes[i - 1][0] : -1.9;
    const mid = (a + prev) / 2;
    const rs = i ? 0.42 : 0.25;
    g.lineTo(Math.sin(mid) * s * rs, -Math.cos(mid) * s * rs);
    g.lineTo(Math.sin(a - 0.13) * s * r * 0.82, -Math.cos(a - 0.13) * s * r * 0.82);
    g.lineTo(Math.sin(a) * s * r, -Math.cos(a) * s * r);
    g.lineTo(Math.sin(a + 0.13) * s * r * 0.82, -Math.cos(a + 0.13) * s * r * 0.82);
  }
  g.lineTo(Math.sin(1.9) * s * 0.25, -Math.cos(1.9) * s * 0.25);
  g.closePath();
  g.fill();
  g.strokeStyle = vein;
  g.lineWidth = Math.max(1, s * 0.035);
  g.beginPath();
  for (const [a, r] of lobes) {
    g.moveTo(0, 0);
    g.lineTo(Math.sin(a) * s * r * 0.85, -Math.cos(a) * s * r * 0.85);
  }
  g.stroke();
  g.restore();
}
function drawWutong(g, rc, rand) {
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, R = 214;
  clipRect(g, rc, 10);
  for (let layer = 0; layer < 3; layer++) {
    const n = [22, 30, 26][layer];
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * R * 0.82;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      const s = 44 + rand() * 30;
      const sh = clusterShade(x - cx, y - cy, R);
      const brown = rand() < 0.07;
      const H = brown ? 42 + rand() * 10 : 78 + rand() * 16;
      const S = brown ? 42 : 36 + rand() * 14;
      const L = ([16, 22, 28][layer] + rand() * 7) * sh + (brown ? 8 : 0);
      palmLeaf(g, x, y, a + Math.PI / 2 + (rand() - 0.5) * 1.2, s, hsl(H, S, L), hsl(H, S * 0.6, L + 10, 0.5));
    }
  }
  g.restore();
}

// —— 雪松：沿枝条（画布 x 向右 = 枝梢方向）排布的针叶簇，羽状外形 ——
function drawXuesong(g, rc, rand) {
  clipRect(g, rc, 8);
  const x0 = rc.x + 16, x1 = rc.x + rc.w - 18, cy = rc.y + rc.h / 2;
  const L = x1 - x0;
  const tuft = (x, y, len, L0) => {
    const n = 11;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand() * 0.4;
      const l = len * (0.7 + rand() * 0.5);
      g.strokeStyle = hsl(98 + rand() * 24, 16 + rand() * 12, L0 - 5 + rand() * 8); // 雪松针叶：暗灰绿（略带银蓝光泽）
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l * 0.8);
      g.stroke();
    }
  };
  // 两层：下层暗、上层亮
  for (let layer = 0; layer < 2; layer++) {
    const Lb = layer ? 30 : 20;
    // 主枝（略下垂）
    const main = (t) => [x0 + t * L, cy + t * t * 22];
    g.strokeStyle = hsl(30, 20, 22);
    g.lineWidth = 4 - layer;
    g.beginPath();
    for (let t = 0; t <= 1.001; t += 0.05) {
      const [x, y] = main(t);
      t ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    for (let t = 0.03; t < 0.98; t += 0.035) {
      const [bx, by] = main(t);
      const w = 205 * Math.pow(1 - t, 0.75) * (0.75 + rand() * 0.35);
      for (const s of [-1, 1]) {
        const ang = s * (0.9 + rand() * 0.35);
        const ex = bx + Math.cos(ang) * w * 0.5, ey = by + Math.sin(ang) * w;
        g.strokeStyle = hsl(30, 18, 26);
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(bx, by);
        g.lineTo(ex, ey);
        g.stroke();
        const steps = Math.max(2, (w / 9) | 0);
        for (let k = 1; k <= steps; k++) {
          const f = k / steps;
          tuft(bx + (ex - bx) * f + (rand() - 0.5) * 4, by + (ey - by) * f + (rand() - 0.5) * 4, 9 + rand() * 4, Lb + f * 8);
        }
      }
      tuft(bx, by, 10, Lb + 4);
    }
  }
  g.restore();
}

// —— 垂柳：自上而下的下垂枝条，狭披针形黄绿叶 ——
function drawLiu(g, rc, rand) {
  clipRect(g, rc, 6);
  for (let layer = 0; layer < 3; layer++) {
    const n = [26, 34, 30][layer];
    for (let i = 0; i < n; i++) {
      const x0 = rc.x + 18 + rand() * (rc.w - 36);
      // 挂点呈拱形（两侧低），长度参差：避免卡片上沿/下沿成直线的“帘子”感
      const ex = Math.abs(x0 - (rc.x + rc.w / 2)) / (rc.w / 2);
      const top = ex * ex * rc.h * 0.28 + rand() * 20;
      const len = (rc.h - top - 8) * (0.4 + rand() * 0.58) * (1 - ex * 0.25);
      const ph = rand() * 6, drift = (rand() - 0.5) * 30;
      const L0 = [20, 27, 34][layer];
      const pt = (t) => [x0 + Math.sin(t * 3 + ph) * 5 + drift * t * t, rc.y + 6 + top + t * len];
      g.strokeStyle = hsl(60, 28, L0 * 0.7);
      g.lineWidth = 1.1;
      g.beginPath();
      for (let t = 0; t <= 1.001; t += 0.04) {
        const [x, y] = pt(t);
        t ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      let side = 1;
      for (let t = 0.02; t < 1; t += 6.5 / len) {
        const [x, y] = pt(t);
        side = -side;
        const a = Math.PI / 2 + side * (0.35 + rand() * 0.3);
        const lf = 11 + rand() * 5;
        ellipseLeaf(g, x, y, a, lf, 2.2 + rand() * 0.8, hsl(74 + rand() * 14, 30 + rand() * 12, L0 * 0.9 + rand() * 8 - t * 4));
      }
    }
  }
  g.restore();
}

// —— 银杏：短枝上簇生扇形叶，9 月下旬约 1/5 叶片泛黄 ——
function fanLeaf(g, x, y, ang, r, fill) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(r * 0.35, -2);
  const a0 = -1.0, a1 = 1.0;
  g.lineTo(r * 0.35, 0);
  for (let a = a0; a <= a1 + 1e-3; a += 0.1) {
    const notch = Math.abs(a) < 0.12 ? 0.82 : 1;
    g.lineTo(Math.cos(a) * r * notch, Math.sin(a) * r * notch);
  }
  g.lineTo(r * 0.35, 0);
  g.closePath();
  g.fill();
  g.restore();
}
function drawYinxing(g, rc, rand) {
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, R = 218;
  clipRect(g, rc, 10);
  for (let layer = 0; layer < 3; layer++) {
    const n = [22, 34, 28][layer];
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * R * 0.85;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      const sh = clusterShade(x - cx, y - cy, R);
      const k = 4 + ((rand() * 4) | 0);
      const yellow = rand() < 0.2;
      const base = a + Math.PI + (rand() - 0.5);
      g.strokeStyle = hsl(30, 15, 30);
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(base) * 10, y + Math.sin(base) * 10);
      g.stroke();
      for (let j = 0; j < k; j++) {
        const la = base + Math.PI + (j / (k - 1) - 0.5) * 2.4 + (rand() - 0.5) * 0.3;
        const pl = 10 + rand() * 7;
        const px = x + Math.cos(la) * pl, py = y + Math.sin(la) * pl;
        g.strokeStyle = hsl(80, 30, 30);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(px, py);
        g.stroke();
        const H = yellow ? 56 + rand() * 10 : 80 + rand() * 14;
        const S = yellow ? 60 + rand() * 10 : 44 + rand() * 12;
        const L = ([20, 27, 33][layer] + rand() * 6) * sh + (yellow ? 12 : 0);
        fanLeaf(g, px, py, la, 19 + rand() * 9, hsl(H, S, L));
      }
    }
  }
  g.restore();
}

// —— 石榴：光亮狭长叶 + 9 月红熟果实 ——
function drawShiliu(g, rc, rand) {
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, R = 220;
  clipRect(g, rc, 10);
  const fruits = [];
  for (let i = 0; i < 6; i++) {
    const a = rand() * Math.PI * 2, r = (0.25 + rand() * 0.6) * R;
    fruits.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, 15 + rand() * 8]);
  }
  const drawFruit = ([x, y, r]) => {
    const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    gr.addColorStop(0, '#f0845a');
    gr.addColorStop(0.45, '#c8402c');
    gr.addColorStop(1, '#7e1c14');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#5c1a10';
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      g.lineTo(x + Math.cos(a) * r * 0.32, y + r * 0.95 + Math.sin(a) * r * 0.22);
    }
    g.fill();
  };
  for (let layer = 0; layer < 3; layer++) {
    if (layer === 2) fruits.slice(0, 4).forEach(drawFruit);
    const n = [14, 20, 18][layer];
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, r0 = rand() * R * 0.35;
      const sx = cx + Math.cos(a) * r0, sy = cy + Math.sin(a) * r0;
      const dir = a + (rand() - 0.5) * 0.8;
      let len = 90 + rand() * 90;
      const over = Math.hypot(sx + Math.cos(dir) * len - cx, sy + Math.sin(dir) * len - cy) - R;
      if (over > 0) len = Math.max(40, len - over);
      g.strokeStyle = hsl(20, 25, 25);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(dir) * len, sy + Math.sin(dir) * len);
      g.stroke();
      for (let t = 0.1; t < 1; t += 0.08) {
        const px = sx + Math.cos(dir) * len * t, py = sy + Math.sin(dir) * len * t;
        for (const s of [-1, 1]) {
          const L = [18, 25, 31][layer] * clusterShade(px - cx, py - cy, R) + rand() * 6;
          ellipseLeaf(g, px, py, dir + s * (0.6 + rand() * 0.5), 17 + rand() * 7, 4 + rand() * 1.6, hsl(95 + rand() * 12, 48 + rand() * 12, L), hsl(90, 30, L + 16, 0.55));
        }
      }
    }
  }
  fruits.slice(4).forEach(drawFruit);
  g.restore();
}

// —— 灌木（大叶黄杨/女贞/海桐）：密集小叶 ——
function drawGuanmu(g, rc, rand, opaque) {
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2;
  if (opaque) {
    g.fillStyle = hsl(100, 38, 13);
    g.fillRect(rc.x, rc.y, rc.w, rc.h);
  }
  clipRect(g, rc, opaque ? 0 : 10);
  const n = opaque ? 3200 : 1700;
  for (let i = 0; i < n; i++) {
    let x, y;
    if (opaque) {
      x = rc.x + rand() * rc.w;
      y = rc.y + rand() * rc.h;
    } else {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 228;
      x = cx + Math.cos(a) * r;
      y = cy + Math.sin(a) * r * 0.95;
    }
    const sh = opaque ? 0.8 + rand() * 0.4 : clusterShade(x - cx, y - cy, 228);
    const L = (16 + rand() * 18) * sh;
    ellipseLeaf(g, x, y, rand() * Math.PI * 2, 9 + rand() * 5, 3.6 + rand() * 1.6, hsl(96 + rand() * 18, 36 + rand() * 18, L), hsl(90, 30, L + 12, 0.4));
  }
  g.restore();
}

// —— 树皮 ——
function barkFurrows(g, rc, rand, { base, dark, light, n = 70, wmin = 2, wmax = 7, wav = 4, plates = 0 }) {
  g.fillStyle = base;
  g.fillRect(rc.x, rc.y, rc.w, rc.h);
  g.save();
  g.beginPath();
  g.rect(rc.x, rc.y, rc.w, rc.h);
  g.clip();
  for (let i = 0; i < n; i++) {
    const x = rand() * rc.w, y0 = rand() * rc.h - 100, len = 120 + rand() * 500;
    const w = wmin + rand() * (wmax - wmin);
    const col = rand() < 0.62 ? dark : light;
    const ph = rand() * 6;
    for (const off of [-rc.w, 0, rc.w]) {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.beginPath();
      for (let t = 0; t <= 1.001; t += 0.05) {
        const xx = rc.x + x + off + Math.sin(t * 7 + ph) * wav, yy = rc.y + y0 + t * len;
        t ? g.lineTo(xx, yy) : g.moveTo(xx, yy);
      }
      g.stroke();
    }
  }
  for (let i = 0; i < plates; i++) {
    const x = rand() * rc.w, y = rand() * rc.h;
    for (const off of [-rc.w, 0, rc.w]) {
      g.strokeStyle = dark;
      g.lineWidth = 1.5 + rand() * 1.5;
      g.beginPath();
      g.moveTo(rc.x + x + off, rc.y + y);
      g.lineTo(rc.x + x + off + 8 + rand() * 20, rc.y + y + (rand() - 0.5) * 4);
      g.stroke();
    }
  }
  g.restore();
}
function barkPlatanus(g, rc, rand) {
  // 斑驳片状剥落：米白/灰绿/黄褐斑块，基部 25% 为深色粗糙老皮
  g.fillStyle = '#a7a283';
  g.fillRect(rc.x, rc.y, rc.w, rc.h);
  g.save();
  g.beginPath();
  g.rect(rc.x, rc.y, rc.w, rc.h);
  g.clip();
  const pal = ['#cfcab0', '#8f9270', '#b6a987', '#7c7458', '#dcd8c2', '#9aa47f', '#c2bb95', '#6f7556'];
  for (let i = 0; i < 260; i++) {
    const x = rand() * rc.w, y = rand() * rc.h, r = 8 + rand() * 30;
    const col = pal[(rand() * pal.length) | 0];
    const pts = 9;
    const rr = [];
    for (let k = 0; k < pts; k++) rr.push(r * (0.6 + rand() * 0.5));
    for (const off of [-rc.w, 0, rc.w]) {
      g.fillStyle = col;
      g.beginPath();
      for (let k = 0; k < pts; k++) {
        const a = (k / pts) * Math.PI * 2;
        const px = rc.x + x + off + Math.cos(a) * rr[k] * 0.8, py = rc.y + y + Math.sin(a) * rr[k] * 1.5;
        k ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.fill();
    }
  }
  const grd = g.createLinearGradient(0, rc.y + rc.h * 0.7, 0, rc.y + rc.h);
  grd.addColorStop(0, 'rgba(70,58,42,0)');
  grd.addColorStop(0.5, 'rgba(70,58,42,0.75)');
  grd.addColorStop(1, 'rgba(58,48,36,0.95)');
  g.fillStyle = grd;
  g.fillRect(rc.x, rc.y + rc.h * 0.7, rc.w, rc.h * 0.3);
  g.restore();
  barkFurrowsOverlay(g, { x: rc.x, y: rc.y + rc.h * 0.78, w: rc.w, h: rc.h * 0.22 }, rand);
}
function barkFurrowsOverlay(g, rc, rand) {
  g.save();
  g.beginPath();
  g.rect(rc.x, rc.y, rc.w, rc.h);
  g.clip();
  for (let i = 0; i < 40; i++) {
    const x = rand() * rc.w;
    g.strokeStyle = 'rgba(35,28,20,0.6)';
    g.lineWidth = 2 + rand() * 3;
    g.beginPath();
    g.moveTo(rc.x + x, rc.y + rand() * rc.h * 0.5);
    g.lineTo(rc.x + x + (rand() - 0.5) * 8, rc.y + rc.h);
    g.stroke();
  }
  g.restore();
}

/**
 * 生成植被图集（DataTexture，sRGB，带 mipmap）。透明像素的 RGB 用瓦片平均色填充，避免 mip 黑边。
 */
export function buildAtlas() {
  const c = document.createElement('canvas');
  c.width = c.height = ATLAS;
  const g = c.getContext('2d', { willReadFrequently: true });
  const rand = mulberry(20260925);
  drawHuai(g, leafRect(LT.HUAI), rand);
  drawWutong(g, leafRect(LT.WUTONG), rand);
  drawXuesong(g, leafRect(LT.XUESONG), rand);
  drawLiu(g, leafRect(LT.LIU), rand);
  drawYinxing(g, leafRect(LT.YINXING), rand);
  drawShiliu(g, leafRect(LT.SHILIU), rand);
  drawGuanmu(g, leafRect(LT.GUANMU), rand, false);
  drawGuanmu(g, leafRect(LT.DENSE), rand, true);
  barkFurrows(g, barkRect(BT.HUAI), rand, { base: '#4b4239', dark: '#2a241f', light: '#6a5f53', n: 80, wmin: 3, wmax: 8 });
  barkPlatanus(g, barkRect(BT.WUTONG), rand);
  barkFurrows(g, barkRect(BT.XUESONG), rand, { base: '#584e45', dark: '#332c26', light: '#766a5d', n: 40, wmin: 1, wmax: 3, wav: 2, plates: 260 });
  barkFurrows(g, barkRect(BT.LIU), rand, { base: '#51483e', dark: '#2b251f', light: '#6f6556', n: 95, wmin: 3, wmax: 9, wav: 7 });
  barkFurrows(g, barkRect(BT.YINXING), rand, { base: '#6b645a', dark: '#46403a', light: '#857d71', n: 55, wmin: 1.5, wmax: 4, wav: 3 });
  barkFurrows(g, barkRect(BT.SHILIU), rand, { base: '#6a5b4c', dark: '#4a3f35', light: '#85766a', n: 36, wmin: 2, wmax: 5, wav: 14 });
  barkFurrows(g, barkRect(BT.TWIG), rand, { base: '#584b3f', dark: '#3d332b', light: '#716457', n: 50, wmin: 1, wmax: 3, wav: 2 });
  drawGuanmu(g, barkRect(BT.SHRUB), rand, true);

  const img = g.getImageData(0, 0, ATLAS, ATLAS);
  const d = img.data;
  // 树皮加噪声
  const nr = mulberry(77);
  for (let y = 1024; y < ATLAS; y++)
    for (let x = 0; x < ATLAS; x++) {
      const i = (y * ATLAS + x) * 4;
      const n = (nr() - 0.5) * 22;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
      d[i + 3] = 255;
    }
  // 叶簇瓦片：透明像素填平均色
  for (let t = 0; t < 8; t++) {
    const r = leafRect(t);
    let sr = 0, sg = 0, sb = 0, sn = 0;
    for (let y = r.y; y < r.y + r.h; y += 2)
      for (let x = r.x; x < r.x + r.w; x += 2) {
        const i = (y * ATLAS + x) * 4;
        if (d[i + 3] > 200) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sn++; }
      }
    if (!sn) continue;
    sr /= sn; sg /= sn; sb /= sn;
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * ATLAS + x) * 4;
        const a = d[i + 3];
        if (a < 250) {
          const k = a / 255;
          d[i] = d[i] * k + sr * (1 - k);
          d[i + 1] = d[i + 1] * k + sg * (1 - k);
          d[i + 2] = d[i + 2] * k + sb * (1 - k);
        }
      }
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.name = 'veg-atlas';
  return tex;
}

/** 绿篱纹理：灰度叶片（着色器里按品种上色），可平铺 */
export function buildHedgeTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#3a3a3a';
  g.fillRect(0, 0, S, S);
  const rand = mulberry(99);
  for (let i = 0; i < 1500; i++) {
    const x = rand() * S, y = rand() * S, a = rand() * Math.PI * 2;
    const l = 7 + rand() * 5, w = 3 + rand() * 1.8;
    const L = 45 + rand() * 45;
    for (const ox of [-S, 0, S])
      for (const oy of [-S, 0, S]) {
        if (x + ox < -20 || x + ox > S + 20 || y + oy < -20 || y + oy > S + 20) continue;
        ellipseLeaf(g, x + ox, y + oy, a, l, w, hsl(0, 0, L), hsl(0, 0, L + 18, 0.5));
      }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.name = 'veg-hedge';
  return t;
}

// ---------------------------------------------------------------------------
// 几何构建
const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

class TreeGeo {
  constructor(H) {
    this.H = H;
    this.P = []; this.N = []; this.U = []; this.C = []; this.W = []; this.I = [];
  }
  vert(p, n, u, v, col, bendY, flut) {
    const i = this.P.length / 3;
    this.P.push(p.x, p.y, p.z);
    this.N.push(n.x, n.y, n.z);
    this.U.push(u, v);
    this.C.push(col[0], col[1], col[2]);
    const b = Math.pow(Math.min(1, Math.max(0, bendY / this.H)), 1.5);
    this.W.push(b, flut);
    return i;
  }
  /** 管状枝干：path 为 Vector3 数组，radii 同长；strip 为树皮条 UV；vSpan 为纹理覆盖的长度（米） */
  tube(path, radii, segs, strip, vSpan = 4, ao0 = 0.78, ao1 = 1.0) {
    const n = path.length;
    let len = 0;
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push((len += path[i].distanceTo(path[i - 1])));
    const span = Math.max(vSpan, len);
    const base = this.P.length / 3;
    let prevN = null;
    for (let i = 0; i < n; i++) {
      const t = _a.copy(path[Math.min(n - 1, i + 1)]).sub(path[Math.max(0, i - 1)]).normalize();
      // 平行传输参考轴，避免扭转
      let ref = prevN ? prevN.clone() : Math.abs(t.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const n1 = new THREE.Vector3().crossVectors(t, ref).normalize();
      if (n1.lengthSq() < 1e-6) n1.set(1, 0, 0);
      const n2 = new THREE.Vector3().crossVectors(t, n1).normalize();
      prevN = n2.clone().negate();
      const v = strip.vBot + (strip.vTop - strip.vBot) * (cum[i] / span);
      const ao = ao0 + (ao1 - ao0) * (cum[i] / (len || 1));
      for (let s = 0; s <= segs; s++) {
        const ang = (s / segs) * Math.PI * 2;
        const dir = _b.copy(n1).multiplyScalar(Math.cos(ang)).addScaledVector(n2, Math.sin(ang));
        const p = _v.copy(path[i]).addScaledVector(dir, radii[i]);
        this.vert(p, dir, strip.u0 + (strip.u1 - strip.u0) * (s / segs), v, [ao, ao, ao], p.y, 0);
      }
    }
    for (let i = 0; i < n - 1; i++)
      for (let s = 0; s < segs; s++) {
        const a = base + i * (segs + 1) + s, b = a + segs + 1;
        this.I.push(a, b, a + 1, a + 1, b, b + 1);
      }
  }
  /**
   * 叶片卡片：center、right（半宽向量）、up（半高向量）；uv 为瓦片 UV；
   * crown = {c: Vector3, r: Vector3} 用于球面法线与 AO；flut 摆动权重；bendY 摆动参考高度
   */
  card(center, right, up, uv, crown, opts = {}) {
    const { flut = 1, bendY = center.y, sphere = 0.8, tint = [1, 1, 1], flipU = false, aoBias = 0 } = opts;
    const cn = _a.crossVectors(right, up).normalize().clone();
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const base = this.P.length / 3;
    for (const [sx, sy] of corners) {
      const p = center.clone().addScaledVector(right, sx).addScaledVector(up, sy);
      const rel = p.clone().sub(crown.c).divide(crown.r);
      const shell = Math.min(1.25, rel.length());
      const sn = rel.lengthSq() > 1e-6 ? rel.clone().normalize() : new THREE.Vector3(0, 1, 0);
      if (cn.dot(sn) < 0) cn.negate();
      const n = cn.clone().multiplyScalar(1 - sphere).addScaledVector(sn, sphere).normalize();
      const hf = Math.max(0, Math.min(1, (p.y - (crown.c.y - crown.r.y)) / (2 * crown.r.y)));
      const ao = Math.min(1.05, (0.42 + 0.58 * smooth(0.15, 1.0, shell)) * (0.82 + 0.23 * hf) + aoBias);
      const u = (flipU ? -sx : sx) < 0 ? uv.u0 : uv.u1;
      const v = sy > 0 ? uv.vTop : uv.vBot;
      this.vert(p, n, u, v, [ao * tint[0], ao * tint[1], ao * tint[2]], opts.bendAt ? opts.bendAt(p) : bendY, typeof flut === 'function' ? flut(sy) : flut);
    }
    this.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.W, 2));
    g.setIndex(this.I);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** 随机单位向量 */
function randDir(rand) {
  const u = rand() * 2 - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return V(s * Math.cos(a), u, s * Math.sin(a));
}

/** 在卡片法线 n 下构造随机旋转的 right/up 半轴 */
function cardAxes(n, w, h, rand) {
  const ref = Math.abs(n.y) < 0.95 ? V(0, 1, 0) : V(1, 0, 0);
  const r = new THREE.Vector3().crossVectors(ref, n).normalize();
  const u = new THREE.Vector3().crossVectors(n, r).normalize();
  const a = rand() * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
  const R = r.clone().multiplyScalar(c).addScaledVector(u, s).multiplyScalar(w / 2);
  const U = u.clone().multiplyScalar(c).addScaledVector(r, -s).multiplyScalar(h / 2);
  return [R, U];
}

/** 弯曲枝条路径：从 p0 沿 dir 伸出 len，末端向 upBend 方向弯 */
function limbPath(p0, dir, len, bend, n = 4) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(p0.clone().addScaledVector(dir, len * t).add(V(0, bend * t * t * len, 0)));
  }
  return pts;
}
const lerpR = (r0, r1, n) => Array.from({ length: n + 1 }, (_, i) => r0 + (r1 - r0) * (i / n));

/** 阔叶树通用：主干 + 主枝 + 次枝 + 椭球冠叶片 */
function broadleaf(tg, rand, o) {
  const trunkTop = V((rand() - 0.5) * o.lean, o.trunkH, (rand() - 0.5) * o.lean);
  const trunk = [V(0, 0, 0), V(trunkTop.x * 0.3, o.trunkH * 0.35, trunkTop.z * 0.3), V(trunkTop.x * 0.7, o.trunkH * 0.7, trunkTop.z * 0.7), trunkTop];
  tg.tube(trunk, [o.r0 * 1.18, o.r0, o.r0 * 0.92, o.r0 * 0.85], o.segs || 8, o.bark, 4, 0.7, 0.95);
  const tips = [];
  const nL = o.limbs;
  const az0 = rand() * Math.PI * 2;
  for (let i = 0; i < nL; i++) {
    const az = az0 + (i / nL) * Math.PI * 2 + (rand() - 0.5) * 0.6;
    const el = o.limbEl[0] + rand() * (o.limbEl[1] - o.limbEl[0]);
    const dir = V(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    const len = o.limbLen[0] + rand() * (o.limbLen[1] - o.limbLen[0]);
    const p = limbPath(trunkTop.clone(), dir, len, o.limbBend, 4);
    tg.tube(p, lerpR(o.r0 * 0.62, o.r0 * 0.22, 4), 6, o.bark, 4, 0.8, 1);
    for (const t of o.subAt) {
      const k = Math.min(3, Math.round(t * 4));
      const sp = p[k];
      const saz = az + (rand() - 0.5) * 1.8;
      const sel = el * 0.7 + (rand() - 0.2) * 0.5;
      const sd = V(Math.cos(saz) * Math.cos(sel), Math.sin(sel), Math.sin(saz) * Math.cos(sel));
      const sl = len * (0.4 + rand() * 0.25);
      const sp2 = limbPath(sp.clone(), sd, sl, 0.15, 2);
      tg.tube(sp2, lerpR(o.r0 * 0.24, o.r0 * 0.07, 2), 4, o.twig, 3, 0.85, 1);
      tips.push(sp2[2]);
    }
    tips.push(p[4]);
  }
  // 叶片卡片
  const crown = { c: o.crownC, r: o.crownR };
  for (let i = 0; i < o.cards; i++) {
    let p;
    if (i < tips.length * 2) {
      const tip = tips[i % tips.length];
      p = tip.clone().add(randDir(rand).multiplyScalar(0.9 + rand() * 0.8));
    } else {
      const d = randDir(rand);
      if (o.flatTop && d.y > 0.55) d.y = 0.55;
      const shell = rand() < 0.72 ? 0.72 + rand() * 0.3 : 0.35 + rand() * 0.35;
      p = o.crownC.clone().add(d.multiply(o.crownR).multiplyScalar(shell));
    }
    const out = p.clone().sub(o.crownC).divide(o.crownR).normalize();
    const n = out.clone().add(randDir(rand).multiplyScalar(o.normJitter ?? 0.85)).normalize();
    const s = o.cardSize[0] + rand() * (o.cardSize[1] - o.cardSize[0]);
    const [R, U] = cardAxes(n, s, s, rand);
    const tv = 0.94 + rand() * 0.12;
    tg.card(p, R, U, o.leafUV, crown, { flut: 1, tint: [tv, tv * (0.97 + rand() * 0.06), tv] });
  }
}

/** 构建各树种近景几何（本地坐标，树基在原点，Y 向上，单位米） */
export function buildSpeciesGeometries() {
  const out = [];
  const leaf = (i) => rectUV(leafRect(i), 10);
  const bark = (j) => rectUV(barkRect(j), 2);

  // 0 国槐：H≈10.5 m，冠幅≈8.5 m，分枝点 2.6 m
  {
    const rand = mulberry(101);
    const tg = new TreeGeo(10.5);
    broadleaf(tg, rand, {
      trunkH: 2.7, r0: 0.17, lean: 0.25, limbs: 4, limbEl: [0.75, 1.05], limbLen: [3.6, 4.6], limbBend: 0.12,
      subAt: [0.5, 0.85], bark: bark(BT.HUAI), twig: bark(BT.TWIG), crownC: V(0, 6.9, 0), crownR: V(4.3, 3.4, 4.3),
      cards: 116, cardSize: [2.4, 3.2], leafUV: leaf(LT.HUAI),
    });
    out.push(tg);
  }
  // 1 法国梧桐：H≈17 m，冠幅≈14 m，杯状整形
  {
    const rand = mulberry(202);
    const tg = new TreeGeo(17);
    broadleaf(tg, rand, {
      trunkH: 3.3, r0: 0.3, lean: 0.2, limbs: 4, limbEl: [0.85, 1.05], limbLen: [6.2, 7.4], limbBend: 0.1,
      subAt: [0.4, 0.7, 0.95], bark: bark(BT.WUTONG), twig: bark(BT.TWIG), crownC: V(0, 11.6, 0), crownR: V(7.2, 5.0, 7.2),
      cards: 140, cardSize: [3.1, 4.2], leafUV: leaf(LT.WUTONG), flatTop: true, segs: 9,
    });
    out.push(tg);
  }
  // 2 雪松：H≈15 m，基部冠幅≈9 m，塔形，大枝平展、梢下垂
  {
    const rand = mulberry(303);
    const H = 15;
    const tg = new TreeGeo(H);
    const trunk = [];
    for (let i = 0; i <= 6; i++) trunk.push(V(0, (i / 6) * H, 0));
    tg.tube(trunk, lerpR(0.3, 0.03, 6), 7, bark(BT.XUESONG), 6, 0.55, 0.9);
    const uv = leaf(LT.XUESONG);
    const crown = { c: V(0, 5.6, 0), r: V(4.6, 6.2, 4.6) };
    const tiers = 15;
    let az = rand() * 6;
    for (let t = 0; t < tiers; t++) {
      const f = t / (tiers - 1);
      const y = 0.9 + f * (H - 1.9);
      const L = 4.6 * Math.pow(1 - f, 0.95) + 0.5;
      const nb = t > tiers - 3 ? 3 : 5;
      for (let b = 0; b < nb; b++) {
        az += 2.39996 + (rand() - 0.5) * 0.3;
        const d = V(Math.cos(az), 0, Math.sin(az));
        const side = V(-d.z, 0, d.x);
        const p0 = V(d.x * 0.15, y, d.z * 0.15);
        const mid = p0.clone().addScaledVector(d, L * 0.55).add(V(0, 0.12 * L, 0));
        const tip = p0.clone().addScaledVector(d, L).add(V(0, -0.1 * L, 0));
        tg.tube([p0, mid, tip], [0.07 * (1 - f * 0.6), 0.04, 0.012], 4, bark(BT.TWIG), 3, 0.6, 0.9);
        const w = (1.3 + (1 - f) * 1.7) * (0.85 + rand() * 0.3);
        const ao = { c: crown.c, r: crown.r };
        // 内段近平展 + 外段下垂：两张卡片沿枝条（u 沿枝长）
        const segCard = (a, b2, wd, droop) => {
          const c = a.clone().add(b2).multiplyScalar(0.5);
          const along = b2.clone().sub(a).multiplyScalar(0.5);
          const across = side.clone().multiplyScalar(wd / 2).add(V(0, -droop, 0));
          const R = along, U = across;
          tg.card(c, R, U, uv, ao, { flut: 0.6, sphere: 0.55, tint: [0.97, 1, 1] });
        };
        segCard(p0.clone().addScaledVector(d, 0.1), mid, w, 0.05);
        segCard(mid, tip.clone().add(V(0, -0.25, 0)), w * 0.85, 0.12);
        // 竖向交叉卡增加侧视体积
        const c2 = p0.clone().addScaledVector(d, L * 0.6).add(V(0, -0.05 * L, 0));
        tg.card(c2, d.clone().multiplyScalar(L * 0.42), V(0, w * 0.32, 0), uv, ao, { flut: 0.5, sphere: 0.6 });
      }
    }
    // 锥体填充：在塔形冠内外壳随机布置针叶簇卡片，使树冠浓密、轮廓成实心宝塔形（公园里的大雪松枝叶几乎垂地）
    for (let i = 0; i < 96; i++) {
      const f = Math.pow(rand(), 0.8);
      const y = 1.0 + f * (H - 2.2);
      const rMax = 4.7 * Math.pow(1 - (y - 0.6) / (H - 0.6), 0.95) + 0.35;
      const a = rand() * Math.PI * 2;
      const rr = rMax * (0.45 + rand() * 0.5);
      const p = V(Math.cos(a) * rr, y, Math.sin(a) * rr);
      const n = V(Math.cos(a), 0.55 + rand() * 0.5, Math.sin(a)).add(randDir(rand).multiplyScalar(0.5)).normalize();
      const sz = (1.6 + rMax * 0.42) * (0.85 + rand() * 0.3);
      const [R, U] = cardAxes(n, sz, sz * 0.75, rand);
      tg.card(p, R, U, uv, crown, { flut: 0.5, sphere: 0.7, tint: [0.95, 0.98, 0.98] });
    }
    // 塔尖
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      tg.card(V(0, H - 0.8, 0), V(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55), V(0, 0.9, 0), uv, crown, { flut: 0.4, sphere: 0.4 });
    }
    out.push(tg);
  }
  // 3 垂柳：H≈10 m，冠幅≈10 m，下垂枝
  {
    const rand = mulberry(404);
    const H = 10;
    const tg = new TreeGeo(H);
    const lean = V(0.9, 0, 0.3);
    const trunkTop = V(lean.x, 2.5, lean.z);
    tg.tube([V(0, 0, 0), V(0.25, 0.9, 0.08), V(0.6, 1.8, 0.2), trunkTop], [0.32, 0.27, 0.25, 0.22], 8, bark(BT.LIU), 4, 0.65, 0.95);
    const crown = { c: V(0.7, 7.0, 0.2), r: V(4.8, 2.8, 4.8) };
    const tops = [];
    for (let i = 0; i < 5; i++) {
      const az = (i / 5) * Math.PI * 2 + rand() * 0.6;
      const el = 0.95 + rand() * 0.35;
      const dir = V(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      const p = limbPath(trunkTop.clone(), dir, 4.2 + rand() * 1.2, -0.08, 4);
      tg.tube(p, lerpR(0.16, 0.05, 4), 6, bark(BT.LIU), 4, 0.8, 1);
      tops.push(p[4]);
    }
    const uv = leaf(LT.LIU);
    // 下垂枝卡片：挂点在冠上壳，竖直下垂，法线水平朝外
    for (let i = 0; i < 64; i++) {
      const az = rand() * Math.PI * 2;
      const rr = 0.35 + Math.sqrt(rand()) * 0.75;
      const top = crown.c.clone().add(V(Math.cos(az) * crown.r.x * rr, crown.r.y * (0.75 - rr * 0.55) + rand() * 0.4, Math.sin(az) * crown.r.z * rr));
      const hang = Math.min(top.y - 1.0, 3.2 + rand() * 3.2);
      const w = 1.4 + rand() * 0.9;
      const outDir = V(Math.cos(az + (rand() - 0.5) * 0.9), 0, Math.sin(az + (rand() - 0.5) * 0.9));
      const right = V(-outDir.z, 0, outDir.x).multiplyScalar(w / 2);
      const up = V(outDir.x * 0.18, 1, outDir.z * 0.18).multiplyScalar(hang / 2);
      const c = top.clone().sub(up);
      const topY = top.y;
      tg.card(c, right, up, uv, crown, { flut: (sy) => (sy > 0 ? 1.0 : 2.0), bendY: topY, sphere: 0.55, tint: [1, 1, 0.96] });
    }
    // 冠顶覆盖卡
    for (let i = 0; i < 16; i++) {
      const d = randDir(rand);
      d.y = Math.abs(d.y) * 0.8 + 0.2;
      const p = crown.c.clone().add(d.clone().multiply(crown.r).multiplyScalar(0.8));
      const [R, U] = cardAxes(d.normalize(), 2.6, 2.6, rand);
      tg.card(p, R, U, uv, crown, { flut: 1 });
    }
    out.push(tg);
  }
  // 4 银杏：H≈12 m，主干通直，分层轮生斜上枝，冠长卵形
  {
    const rand = mulberry(505);
    const H = 12;
    const tg = new TreeGeo(H);
    const trunk = [];
    for (let i = 0; i <= 5; i++) trunk.push(V(0, (i / 5) * (H - 0.8), 0));
    tg.tube(trunk, lerpR(0.23, 0.04, 5), 7, bark(BT.YINXING), 5, 0.72, 0.95);
    const uv = leaf(LT.YINXING);
    const crown = { c: V(0, 7.2, 0), r: V(3.1, 4.4, 3.1) };
    const tips = [];
    let az = rand() * 6;
    for (let l = 0; l < 7; l++) {
      const f = l / 6;
      const y = 3.0 + f * 7.4;
      for (let b = 0; b < 3; b++) {
        az += 2.2 + rand() * 0.5;
        const el = 0.65 + rand() * 0.3;
        const dir = V(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
        const len = 3.3 * (1 - f * 0.62) * (0.85 + rand() * 0.3);
        const p = limbPath(V(0, y, 0), dir, len, 0.05, 3);
        tg.tube(p, lerpR(0.07 * (1 - f * 0.5), 0.015, 3), 4, bark(BT.TWIG), 3, 0.8, 1);
        tips.push(p[1], p[2], p[3]);
      }
    }
    for (let i = 0; i < 62; i++) {
      const tip = tips[(rand() * tips.length) | 0];
      const p = tip.clone().add(randDir(rand).multiplyScalar(0.4 + rand() * 0.6));
      const out2 = p.clone().sub(crown.c).divide(crown.r).normalize();
      const n = out2.add(randDir(rand).multiplyScalar(0.8)).normalize();
      const s = 1.7 + rand() * 0.6;
      const [R, U] = cardAxes(n, s, s, rand);
      tg.card(p, R, U, uv, crown, { flut: 1.0 });
    }
    out.push(tg);
  }
  // 5 石榴：H≈4.2 m，3 干丛生
  {
    const rand = mulberry(606);
    const tg = new TreeGeo(4.2);
    const uv = leaf(LT.SHILIU);
    const crown = { c: V(0, 2.85, 0), r: V(1.9, 1.45, 1.9) };
    const tips = [];
    for (let s = 0; s < 3; s++) {
      const az = (s / 3) * Math.PI * 2 + rand() * 0.5;
      const lean = 0.22 + rand() * 0.18;
      const p = [];
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        p.push(V(Math.cos(az) * lean * 2.3 * t + Math.sin(t * 5 + s) * 0.06, t * 2.3, Math.sin(az) * lean * 2.3 * t));
      }
      tg.tube(p, lerpR(0.075, 0.04, 4), 5, bark(BT.SHILIU), 3, 0.75, 1);
      for (let k = 0; k < 3; k++) {
        const saz = az + (rand() - 0.5) * 2;
        const d = V(Math.cos(saz) * 0.6, 0.8, Math.sin(saz) * 0.6).normalize();
        const q = limbPath(p[4].clone(), d, 1.0 + rand() * 0.5, 0.1, 2);
        tg.tube(q, lerpR(0.035, 0.012, 2), 4, bark(BT.TWIG), 2, 0.85, 1);
        tips.push(q[2]);
      }
    }
    for (let i = 0; i < 40; i++) {
      const d = randDir(rand);
      const p = i < tips.length ? tips[i].clone().add(d.clone().multiplyScalar(0.3)) : crown.c.clone().add(d.clone().multiply(crown.r).multiplyScalar(0.55 + rand() * 0.45));
      const n = p.clone().sub(crown.c).divide(crown.r).normalize().add(randDir(rand).multiplyScalar(0.8)).normalize();
      const s = 1.1 + rand() * 0.45;
      const [R, U] = cardAxes(n, s, s, rand);
      tg.card(p, R, U, uv, crown, { flut: 1 });
    }
    out.push(tg);
  }
  // 6 灌木球：H≈1.3 m，Ø≈1.7 m（椭球实心 + 外伸叶片打破轮廓）
  {
    const rand = mulberry(707);
    const tg = new TreeGeo(1.3);
    const crown = { c: V(0, 0.66, 0), r: V(0.86, 0.64, 0.86) };
    const ico = new THREE.IcosahedronGeometry(1, 2);
    const pos = ico.attributes.position;
    const dense = rectUV(barkRect(BT.SHRUB), 4);
    const base = tg.P.length / 3;
    const map = new Map();
    const idx = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
      if (!map.has(key)) {
        const n = V(x, y, z).normalize();
        const jitter = 1 + (rand() - 0.5) * 0.12;
        const p = V(x * crown.r.x * jitter, Math.max(0.02, crown.c.y + y * crown.r.y * jitter), z * crown.r.z * jitter);
        const u = dense.u0 + (dense.u1 - dense.u0) * (0.5 + Math.atan2(z, x) / (2 * Math.PI));
        const v = dense.vBot + (dense.vTop - dense.vBot) * (0.5 + y * 0.5);
        const ao = 0.62 + 0.38 * (0.5 + y * 0.5);
        map.set(key, tg.vert(p, n, u, v, [ao, ao, ao], p.y, 0.3));
      }
      idx.push(map.get(key));
    }
    for (let i = 0; i < idx.length; i += 3) tg.I.push(idx[i], idx[i + 1], idx[i + 2]);
    void base;
    const uv = leaf(LT.GUANMU);
    for (let i = 0; i < 18; i++) {
      const d = randDir(rand);
      d.y = Math.abs(d.y) * 0.9 + 0.05;
      const p = crown.c.clone().add(d.clone().multiply(crown.r).multiplyScalar(0.9));
      const [R, U] = cardAxes(d.clone().normalize(), 0.75, 0.75, rand);
      tg.card(p, R, U, uv, crown, { flut: 0.6, sphere: 0.8 });
    }
    out.push(tg);
  }
  return out.map((tg) => tg.toGeometry());
}

/** 绿篱单位盒（x∈[-0.5,0.5] 沿路方向，y∈[0,1]，z∈[-0.5,0.5]），顶部倒角 */
export function buildHedgeGeometry() {
  const prof = [
    [-0.5, 0], [-0.5, 0.78], [-0.4, 0.95], [-0.22, 1.0], [0.22, 1.0], [0.4, 0.95], [0.5, 0.78], [0.5, 0],
  ];
  const P = [], N = [], I = [];
  const nx = 4;
  // 侧面/顶面：沿 x 方向挤出
  for (let i = 0; i < prof.length - 1; i++) {
    const [z0, y0] = prof[i], [z1, y1] = prof[i + 1];
    const dz = z1 - z0, dy = y1 - y0, l = Math.hypot(dz, dy);
    const nz = dy / l, ny = -dz / l;
    // 外法线：profile 顺时针（从 -z 到 +z 经过顶部），外侧为 (−dy, dz) 取反修正
    const n = [0, -ny, -nz];
    if (Math.abs(n[1]) < 1e-6 && Math.abs(n[2]) < 1e-6) continue;
    const base = P.length / 3;
    for (let k = 0; k <= nx; k++) {
      const x = -0.5 + k / nx;
      P.push(x, y0, z0, x, y1, z1);
      N.push(...n, ...n);
    }
    for (let k = 0; k < nx; k++) {
      const a = base + k * 2;
      I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  // 端面
  for (const sx of [-0.5, 0.5]) {
    const base = P.length / 3;
    for (const [z, y] of prof) { P.push(sx, y, z); N.push(Math.sign(sx), 0, 0); }
    for (let i = 1; i < prof.length - 1; i++) (sx < 0 ? I.push(base, base + i + 1, base + i) : I.push(base, base + i, base + i + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((P.length / 3) * 2), 2));
  g.setIndex(I);
  return g;
}
