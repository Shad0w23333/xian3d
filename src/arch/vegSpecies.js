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
//        塔形，大枝近平展、枝梢下垂，短枝上簇生针叶，整体呈一层层羽毛状的水平枝叶片；针叶灰绿。
//   垂柳 Salix babylonica —— 护城河、兴庆湖、曲江池、汉城湖等水岸。高 8~15 m，冠幅 8~12 m，
//        细长枝条下垂可近地面，叶狭披针形、黄绿色；树干常向水面倾斜。
//   银杏 Ginkgo biloba —— 近 20 年行道树新宠（雁塔西路“黄金大道”等）。高 10~15 m（街道多为 8~12 m 青年树），
//        主干通直、冠塔形至长卵形；扇形叶，9 月下旬开始由绿转微黄（11 月才全黄）。
//   石榴 Punica granatum —— 西安市花，小区/公园小乔木，高 3~5 m，常多干丛生，叶小有光泽；9 月果实红熟。
//   灌木：大叶黄杨/小叶女贞/海桐球、红叶石楠（新叶红色）绿篱，高 0.6~1.5 m，常修剪成球或篱带。
//   侧柏 Platycladus orientalis —— 寺院（荐福寺、卧龙寺、大兴善寺）古柏、陵园、环城公园与山地造林。高 8~15 m，
//        卵圆形至宝塔形冠，老树冠形不规则；鳞叶小枝扁平、竖向排列成扇状，暗绿。
//
// 阔叶树几何采用“叶团法”：树冠由十几到三十个叶团组成，每个叶团是一组叶簇卡片（法线 = 叶团外向与树冠外向混合，
// 每团各有受光面和背光面），枝条从主干/主枝一直长进每个叶团——近看是浓密、有体积的树冠，不再是枝头挂几张卡片。
// 叶簇贴图：多团不规则外形、团心暗外缘亮、叶片高度重叠（中心不透光、边缘是叶形），并自建 mipmap 保持 alpha 覆盖率
// （普通 mipmap 平均后低于 alphaTest 阈值，远一点叶片就被剔成稀疏的“乱涂”状）。
import * as THREE from 'three';

export const SP = { HUAI: 0, WUTONG: 1, XUESONG: 2, LIU: 3, YINXING: 4, SHILIU: 5, GUANMU: 6, BAI: 7 };
export const SPECIES_COUNT = 8;
export const SPECIES_NAMES = ['国槐', '法国梧桐', '雪松', '垂柳', '银杏', '石榴', '灌木', '侧柏'];

// 每个树种叶片的实例着色参数（叶片乘色 rgb，w=秋色/泛黄程度上限）
export const LEAF_TINT = [
  [0.96, 1.0, 0.92, 0.04], // 国槐
  [1.0, 1.0, 0.94, 0.12], // 法桐：9 月下旬少量泛黄褐
  [0.86, 0.95, 0.88, 0.0], // 雪松
  [1.0, 1.0, 0.9, 0.03], // 垂柳
  [1.0, 1.0, 0.92, 0.2], // 银杏：开始微黄
  [0.98, 1.0, 0.95, 0.03], // 石榴
  [0.95, 1.0, 0.94, 0.0], // 灌木
  [0.92, 0.98, 0.9, 0.0], // 侧柏
];

export const ATLAS = 2048;
const ALPHA_CUT = 0.45; // 与 vegetation.js 的 alphaTest 一致（mipmap 覆盖率按此阈值保持）

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
export const LT = { HUAI: 0, WUTONG: 1, XUESONG: 2, LIU: 3, YINXING: 4, SHILIU: 5, GUANMU: 6, BAI: 7 };
// 树皮条编号
export const BT = { HUAI: 0, WUTONG: 1, XUESONG: 2, LIU: 3, YINXING: 4, SHILIU: 5, TWIG: 6, SHRUB: 7 };

const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${Math.max(0, l).toFixed(1)}%,${a})`;

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

/** 叶簇明暗（旧版：离簇心越远、越靠上越亮），灌木/垂柳仍用 */
function clusterShade(dx, dy, R) {
  const r = Math.min(1, Math.hypot(dx, dy) / R);
  return 0.72 + 0.28 * r + (-dy / R) * 0.1;
}

// —— 叶簇外形：中心大团 + 周围 n 个小团（不规则、带缺口的团状轮廓） ——
function makeBlobs(cx, cy, R, rand, n = 7) {
  const b = [[cx + (rand() - 0.5) * R * 0.12, cy + (rand() - 0.5) * R * 0.12, R * (0.5 + rand() * 0.08)]];
  const a0 = rand() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.7;
    const r = R * (0.27 + rand() * 0.16);
    const d = R - r - rand() * R * 0.1;
    b.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, r]);
  }
  return b;
}
/** 按面积随机挑一个团，团内均匀取点；返回 [x, y, 团, 团内归一化半径] */
function blobPick(b, rand) {
  let tot = 0;
  for (const q of b) tot += q[2] * q[2];
  let r = rand() * tot, q = b[0];
  for (const c of b) {
    r -= c[2] * c[2];
    if (r <= 0) {
      q = c;
      break;
    }
  }
  const a = rand() * Math.PI * 2, u = Math.sqrt(rand());
  return [q[0] + Math.cos(a) * u * q[2], q[1] + Math.sin(a) * u * q[2], q, u];
}
/** 叶团明暗：团心与整簇中心暗（内膛互相遮挡），团外缘亮（外层受光）——卡片随机旋转，不做“上亮下暗” */
function lobeShade(x, y, u, cx, cy, R) {
  return 0.68 + 0.24 * u + 0.2 * Math.min(1, Math.hypot(x - cx, y - cy) / R);
}
/** 把从 (x,y) 沿 dir 伸出 len 的叶片截短到簇半径 Rmax 以内（避免被瓦片边缘切出直边） */
function clampLen(x, y, dir, len, cx, cy, Rmax, min) {
  const over = Math.hypot(x + Math.cos(dir) * len - cx, y + Math.sin(dir) * len - cy) - Rmax;
  return over > 0 ? Math.max(min, len - over) : len;
}

// —— 国槐：羽状复叶（小叶卵形、深绿），多团叶簇 ——
function drawHuai(g, rc, rand) {
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, R = 238;
  clipRect(g, rc, 6);
  const blobs = makeBlobs(cx, cy, 166, rand, 7);
  const LAY = [[120, 18], [140, 24], [120, 31]];
  for (let layer = 0; layer < 3; layer++) {
    const [cnt, Lb] = LAY[layer];
    for (let i = 0; i < cnt; i++) {
      const [sx, sy, q, u] = blobPick(blobs, rand);
      const out = Math.atan2(sy - q[1], sx - q[0]);
      const dir = out + (rand() - 0.5) * 1.9;
      const len = clampLen(sx, sy, dir, 46 + rand() * 46, cx, cy, R, 20);
      const L0 = Lb * lobeShade(sx, sy, u, cx, cy, 166) + rand() * 4;
      const H = 92 + rand() * 18, S = 36 + rand() * 16;
      g.strokeStyle = hsl(80, 28, L0 * 0.7);
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(dir) * len, sy + Math.sin(dir) * len);
      g.stroke();
      const pairs = 3 + ((rand() * 3) | 0);
      for (let k = 0; k <= pairs; k++) {
        const t = 0.16 + (k / pairs) * 0.8;
        const px = sx + Math.cos(dir) * len * t, py = sy + Math.sin(dir) * len * t;
        const ll = 15 + rand() * 6, ww = 6.2 + rand() * 2.2;
        const L = L0 + (rand() - 0.5) * 7;
        if (k === pairs) ellipseLeaf(g, px, py, dir, ll + 2, ww, hsl(H, S, L), hsl(H, S * 0.7, L + 8, 0.45));
        else for (const s of [-1, 1]) ellipseLeaf(g, px, py, dir + s * (0.95 + rand() * 0.4), ll, ww, hsl(H + (rand() - 0.5) * 6, S, L + (rand() - 0.5) * 4), hsl(H, S * 0.7, L + 9, 0.4));
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
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, R = 238;
  clipRect(g, rc, 6);
  const blobs = makeBlobs(cx, cy, 168, rand, 6);
  const LAY = [[48, 16], [58, 22], [46, 29]];
  for (let layer = 0; layer < 3; layer++) {
    const [cnt, Lb] = LAY[layer];
    for (let i = 0; i < cnt; i++) {
      const [x, y, q, u] = blobPick(blobs, rand);
      const out = Math.atan2(y - q[1], x - q[0]);
      const ang = out + (rand() - 0.5) * 1.5;
      const s = clampLen(x, y, ang, 34 + rand() * 26, cx, cy, R, 22);
      const brown = rand() < 0.06;
      const H = brown ? 42 + rand() * 10 : 78 + rand() * 16;
      const S = brown ? 42 : 34 + rand() * 14;
      const L = (Lb + rand() * 6) * lobeShade(x, y, u, cx, cy, 168) + (brown ? 8 : 0);
      palmLeaf(g, x, y, ang + Math.PI / 2, s, hsl(H, S, L), hsl(H, S * 0.6, L + 10, 0.5));
    }
  }
  g.restore();
}

// —— 雪松：水平枝叶片（俯视）——细枝上密布短枝簇生针叶，外形基部窄、中段宽、梢部收尖，外缘参差（不是蕨类羽片） ——
function drawXuesong(g, rc, rand) {
  clipRect(g, rc, 6);
  const x0 = rc.x + 16, x1 = rc.x + rc.w - 16, cy = rc.y + rc.h / 2;
  const L = x1 - x0;
  const halfW = (t) => rc.h * 0.43 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.92)), 0.75) * (1 - 0.28 * t);
  // 细枝（若隐若现的褐色小枝）
  const axisY = (t) => cy + Math.sin(t * 2.6) * 6;
  g.strokeStyle = hsl(28, 20, 26, 0.8);
  g.lineWidth = 1.8;
  g.beginPath();
  for (let t = 0; t <= 1.001; t += 0.05) (t ? g.lineTo : g.moveTo).call(g, x0 + t * L, axisY(t));
  g.stroke();
  let sideFlip = 1;
  for (let t = 0.08; t < 0.92; t += 0.06 + rand() * 0.03) {
    sideFlip = -sideFlip;
    const bx = x0 + t * L, by = axisY(t), w = halfW(t) * (0.45 + rand() * 0.25);
    g.lineWidth = 1.1;
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(bx + w * 0.5, by + sideFlip * w);
    g.stroke();
  }
  // 针叶簇：每簇 10~16 根短针叶放射状；三层（下层暗、上层亮），越靠外缘越亮
  const tuft = (x, y, len, H, S, Lc) => {
    const n = 10 + ((rand() * 7) | 0);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand() * 0.5;
      const l = len * (0.6 + rand() * 0.5);
      g.strokeStyle = hsl(H + rand() * 10, S, Lc + (rand() - 0.5) * 8);
      g.lineWidth = 1.25;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
  };
  const LAY = [[520, 21], [600, 29], [480, 37]];
  for (let layer = 0; layer < 3; layer++) {
    const [cnt, Lb] = LAY[layer];
    for (let i = 0; i < cnt; i++) {
      const t = Math.pow(rand(), 0.9);
      const w = halfW(t);
      const e = (rand() * 2 - 1) * Math.sqrt(rand());
      const x = x0 + t * L + (rand() - 0.5) * 8, y = axisY(t) + e * w * 0.92;
      const edge = Math.abs(e);
      const Lc = Lb * (0.68 + 0.32 * edge + 0.12 * t);
      tuft(x, y, 6 + rand() * 4, 98 + rand() * 26, 20 + rand() * 12, Lc);
    }
  }
  g.restore();
}

// —— 侧柏：扁平鳞叶小枝（竖向扇状），多团密集 ——
function baiSpray(g, x, y, ang, len, Lc, rand) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.lineCap = 'round';
  const H = 84 + rand() * 14, S = 30 + rand() * 12;
  const seg = (ax, ay, bx, by, w, L) => {
    g.strokeStyle = hsl(H, S, L);
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
  };
  seg(0, 0, len, 0, 3.2, Lc * 0.85);
  for (let t = 0.12, s = 1; t < 0.96; t += 0.11 + rand() * 0.05, s = -s) {
    const bx = len * t, bl = len * 0.48 * (1 - t * 0.55) * (0.8 + rand() * 0.4);
    const a = s * (0.55 + rand() * 0.35);
    const ex = bx + Math.cos(a) * bl, ey = Math.sin(a) * bl;
    seg(bx, 0, ex, ey, 3.0, Lc + (rand() - 0.3) * 6);
    // 二级小枝
    for (let u = 0.35; u < 0.95; u += 0.3) {
      const px = bx + (ex - bx) * u, py = ey * u;
      const a2 = a + s * (0.5 + rand() * 0.3), l2 = bl * 0.35;
      seg(px, py, px + Math.cos(a2) * l2, py + Math.sin(a2) * l2, 2.6, Lc + 3 + (rand() - 0.5) * 6);
    }
  }
  g.restore();
}
function drawBai(g, rc, rand) {
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, R = 238;
  clipRect(g, rc, 6);
  const blobs = makeBlobs(cx, cy, 168, rand, 7);
  const LAY = [[110, 13], [130, 18], [100, 24]];
  for (let layer = 0; layer < 3; layer++) {
    const [cnt, Lb] = LAY[layer];
    for (let i = 0; i < cnt; i++) {
      const [x, y, q, u] = blobPick(blobs, rand);
      const out = Math.atan2(y - q[1], x - q[0]);
      const ang = out + (rand() - 0.5) * 1.6;
      const len = clampLen(x, y, ang, 40 + rand() * 32, cx, cy, R, 18);
      baiSpray(g, x, y, ang, len, Lb * lobeShade(x, y, u, cx, cy, 168) + rand() * 4, rand);
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

// —— 银杏：短枝上簇生扇形叶（无长叶柄线，避免远看成“乱涂”），9 月下旬少量叶片转黄绿 ——
function fanLeaf(g, x, y, ang, r, fill) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(r * 0.3, -1.6);
  const a0 = -0.95, a1 = 0.95;
  for (let a = a0; a <= a1 + 1e-3; a += 0.1) {
    const notch = Math.abs(a) < 0.12 ? 0.86 : 1;
    g.lineTo(Math.cos(a) * r * notch, Math.sin(a) * r * notch);
  }
  g.lineTo(r * 0.3, 1.6);
  g.closePath();
  g.fill();
  g.restore();
}
function drawYinxing(g, rc, rand) {
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, R = 238;
  clipRect(g, rc, 6);
  const blobs = makeBlobs(cx, cy, 168, rand, 7);
  const LAY = [[90, 18], [110, 24], [90, 31]];
  for (let layer = 0; layer < 3; layer++) {
    const [cnt, Lb] = LAY[layer];
    for (let i = 0; i < cnt; i++) {
      const [x, y, q, u] = blobPick(blobs, rand);
      const k = 3 + ((rand() * 4) | 0);
      const yellow = rand() < 0.04;
      const base = Math.atan2(y - q[1], x - q[0]) + (rand() - 0.5) * 1.6;
      const sh = lobeShade(x, y, u, cx, cy, 168);
      for (let j = 0; j < k; j++) {
        const la = base + (j / Math.max(1, k - 1) - 0.5) * 1.1 + (rand() - 0.5) * 0.3;
        const pl = 3 + rand() * 5;
        const px = x + Math.cos(la) * pl, py = y + Math.sin(la) * pl;
        const r = clampLen(px, py, la, 21 + rand() * 9, cx, cy, R, 10);
        const H = yellow ? 68 + rand() * 8 : 84 + rand() * 14;
        const S = yellow ? 52 + rand() * 10 : 40 + rand() * 12;
        const L = (Lb + rand() * 6) * sh + (yellow ? 8 : 0);
        fanLeaf(g, px, py, la, r, hsl(H, S, L));
      }
    }
  }
  g.restore();
}

// —— 石榴：光亮狭长叶 + 9 月红熟果实 ——
function drawShiliu(g, rc, rand) {
  const cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, R = 236;
  clipRect(g, rc, 6);
  const blobs = makeBlobs(cx, cy, 165, rand, 6);
  const fruits = [];
  for (let i = 0; i < 7; i++) {
    const [x, y] = blobPick(blobs, rand);
    fruits.push([x, y, 14 + rand() * 7]);
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
  const LAY = [[60, 18], [72, 25], [60, 31]];
  for (let layer = 0; layer < 3; layer++) {
    if (layer === 2) fruits.slice(0, 4).forEach(drawFruit);
    const [cnt, Lb] = LAY[layer];
    for (let i = 0; i < cnt; i++) {
      const [sx, sy, q, u] = blobPick(blobs, rand);
      const dir = Math.atan2(sy - q[1], sx - q[0]) + (rand() - 0.5) * 1.8;
      const len = clampLen(sx, sy, dir, 40 + rand() * 40, cx, cy, R, 20);
      const sh = lobeShade(sx, sy, u, cx, cy, 165);
      g.strokeStyle = hsl(20, 25, 25);
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(dir) * len, sy + Math.sin(dir) * len);
      g.stroke();
      for (let t = 0.1; t < 1; t += 0.12) {
        const px = sx + Math.cos(dir) * len * t, py = sy + Math.sin(dir) * len * t;
        for (const s of [-1, 1]) {
          const L = Lb * sh + rand() * 6;
          ellipseLeaf(g, px, py, dir + s * (0.6 + rand() * 0.5), 17 + rand() * 6, 4.2 + rand() * 1.6, hsl(95 + rand() * 12, 46 + rand() * 12, L), hsl(90, 30, L + 16, 0.55));
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

// ---------------------------------------------------------------------------
// mipmap：2×2 平均；叶簇瓦片按 alpha 覆盖率保持（Castaño 2010）——每级二分一个 alpha 缩放系数，
// 使 alpha ≥ 阈值的像素比例与第 0 级相同，叶簇远看不会越来越稀、碎成“乱涂”
function coverage(d, size, r, scale, cut) {
  let hit = 0, n = 0;
  const x1 = r.x + r.w, y1 = r.y + r.h;
  for (let y = r.y; y < y1; y++)
    for (let x = r.x; x < x1; x++) {
      if (d[(y * size + x) * 4 + 3] * scale >= cut) hit++;
      n++;
    }
  return n ? hit / n : 0;
}
function buildMipChain(base, size, tiles) {
  const cut = ALPHA_CUT * 255;
  const cov0 = tiles.map((r) => coverage(base, size, r, 1, cut));
  const levels = [{ data: base, width: size, height: size }];
  let prev = base, s = size, k = 1;
  while (s > 1) {
    const ns = s >> 1;
    k *= 2;
    const out = new Uint8Array(ns * ns * 4);
    for (let y = 0; y < ns; y++)
      for (let x = 0; x < ns; x++) {
        const i0 = (2 * y * s + 2 * x) * 4, i1 = i0 + s * 4;
        const o = (y * ns + x) * 4;
        for (let c = 0; c < 4; c++) out[o + c] = (prev[i0 + c] + prev[i0 + 4 + c] + prev[i1 + c] + prev[i1 + 4 + c] + 2) >> 2;
      }
    tiles.forEach((r0, t) => {
      const r = { x: r0.x / k, y: r0.y / k, w: r0.w / k, h: r0.h / k };
      if (r.w < 2 || !cov0[t]) return;
      let lo = 0.5, hi = 6;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        if (coverage(out, ns, r, mid, cut) < cov0[t]) lo = mid;
        else hi = mid;
      }
      const sc = (lo + hi) / 2;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = (y * ns + x) * 4 + 3;
          out[i] = Math.min(255, Math.round(out[i] * sc));
        }
    });
    levels.push({ data: out, width: ns, height: ns });
    prev = out;
    s = ns;
  }
  return levels;
}

/**
 * 生成植被图集（DataTexture，sRGB，自建 mipmap）。透明像素的 RGB 用瓦片平均色填充，避免 mip 黑边。
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
  drawBai(g, leafRect(LT.BAI), rand);
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
  const tiles = [];
  for (let t = 0; t < 8; t++) {
    const r = leafRect(t);
    tiles.push(r);
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
  const base = new Uint8Array(d.buffer.slice(0));
  const tex = new THREE.DataTexture(base, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = buildMipChain(base, ATLAS, tiles);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
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
   * crown = {c: Vector3, r: Vector3} 用于球面法线与 AO；lobe = {c, r}（可选）：叶团球心/半径——
   * 法线改为叶团外向与树冠外向混合、叶团内侧加暗，每团各有受光面与背光面。flut 摆动权重；bendY 摆动参考高度
   */
  card(center, right, up, uv, crown, opts = {}) {
    const { flut = 1, bendY = center.y, sphere = 0.8, tint = [1, 1, 1], flipU = false, aoBias = 0, lobe = null } = opts;
    const cn = _a.crossVectors(right, up).normalize().clone();
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const base = this.P.length / 3;
    for (const [sx, sy] of corners) {
      const p = center.clone().addScaledVector(right, sx).addScaledVector(up, sy);
      const rel = p.clone().sub(crown.c).divide(crown.r);
      const shell = Math.min(1.25, rel.length());
      let sn = rel.lengthSq() > 1e-6 ? rel.clone().normalize() : new THREE.Vector3(0, 1, 0);
      let lobeAO = 1;
      if (lobe) {
        const lr = p.clone().sub(lobe.c).divideScalar(lobe.r);
        const ll = lr.length();
        if (ll > 1e-4) sn = lr.multiplyScalar(0.6 / ll).addScaledVector(sn, 0.4).normalize();
        lobeAO = 0.8 + 0.2 * smooth(0.1, 1.0, ll);
      }
      if (cn.dot(sn) < 0) cn.negate();
      const n = cn.clone().multiplyScalar(1 - sphere).addScaledVector(sn, sphere).normalize();
      const hf = Math.max(0, Math.min(1, (p.y - (crown.c.y - crown.r.y)) / (2 * crown.r.y)));
      const ao = Math.min(1.05, (lobe ? 0.55 + 0.45 * smooth(0.15, 1.0, shell) : 0.42 + 0.58 * smooth(0.15, 1.0, shell)) * (0.82 + 0.23 * hf) * lobeAO + aoBias);
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

/**
 * 阔叶树（叶团法）：
 *  1. 在树冠椭球内撒叶团（偏外层、互不过分重叠；叶团 + 卡片外沿不超出 crownR，保证与种植侧冠幅一致）；
 *  2. 骨架：主干 →（合轴）主枝按方位分管叶团 / （单轴）主干直通冠顶、侧枝从主干分出 / （丛生）多干；
 *     每个叶团都有一根枝条从骨架长到叶团里，末端再分两根小枝——近看不再是“枝头挂卡片、大段光枝”；
 *  3. 每个叶团 cardsPerLobe 张叶簇卡片，法线 = 叶团外向 0.6 + 树冠外向 0.4（逐角点），叶团内侧压暗。
 * o：trunkH 分枝点高、r0 主干半径、lean 主干倾斜、crownC/crownR 树冠椭球、lobes 叶团数、lobeR 叶团半径、
 *    cardsPerLobe、cardSize、limbs 主枝数（合轴）、excurrent 单轴、stems 丛生干数、branchRise 侧枝上扬、
 *    flatTop 平顶（法桐杯状冠）、vertCards 卡片竖向倾向（侧柏扁平小枝竖排）、upright 贴图上方朝天（垂柳）
 */
function broadleaf(tg, rand, o) {
  const C = o.crownC, CR = o.crownR;
  const leanX = (rand() - 0.5) * o.lean, leanZ = (rand() - 0.5) * o.lean;
  const ext = o.lobeR * 0.8 + o.cardSize[1] * 0.42; // 叶团中心到卡片外沿的最大距离
  const CE = V(Math.max(0.5, CR.x - ext * 0.62), Math.max(0.5, CR.y - ext * 0.62), Math.max(0.5, CR.z - ext * 0.62));
  // —— 1. 叶团 ——
  const lobes = [];
  for (let tries = 0; lobes.length < o.lobes && tries < 6000; tries++) {
    const d = randDir(rand);
    if (o.flatTop && d.y > 0.55) d.y = 0.55;
    const sh = 0.4 + Math.pow(rand(), 0.5) * 0.6;
    const c = C.clone().add(d.multiply(CE).multiplyScalar(sh));
    if (c.y < o.trunkH + 0.6) continue;
    const r = o.lobeR * (0.78 + rand() * 0.44);
    let ok = true;
    for (const l of lobes) if (l.c.distanceTo(c) < (l.r + r) * (o.pack ?? 0.55)) { ok = false; break; }
    if (ok) lobes.push({ c, r });
  }
  // —— 2. 骨架 ——
  // 末端小枝：只给树冠外层的叶团加一根（内膛的看不见；控制近景三角形数）
  const twigs = (end, dir, l) => {
    const rel = l.c.clone().sub(C).divide(CR).length();
    if (rel < 0.55) return;
    const d = dir.clone().add(randDir(rand).multiplyScalar(0.9)).normalize();
    tg.tube([end, end.clone().addScaledVector(d, l.r * (0.5 + rand() * 0.3))], [0.02, 0.007], 3, o.twig, 2, 0.9, 1);
  };
  const branchTo = (s, l, r0b) => {
    const dir = l.c.clone().sub(s);
    const dist = dir.length();
    if (dist < 0.4) return;
    dir.divideScalar(dist);
    const end = l.c.clone().addScaledVector(dir, -l.r * 0.3);
    const len = s.distanceTo(end);
    const mid = s.clone().lerp(end, 0.5).add(V(0, len * 0.07, 0)).add(randDir(rand).multiplyScalar(len * 0.06));
    tg.tube([s, mid, end], [r0b, r0b * 0.62, Math.max(0.022, r0b * 0.3)], 3, o.twig, 3, 0.82, 1);
    twigs(end, dir, l);
  };
  let trunkTop;
  if (o.stems) {
    // 丛生（石榴）：多根细干从地面斜出，叶团挂到最近的干顶
    const tops = [];
    for (let s = 0; s < o.stems; s++) {
      const az = (s / o.stems) * Math.PI * 2 + rand() * 0.5;
      const lean = 0.22 + rand() * 0.18;
      const p = [];
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        p.push(V(Math.cos(az) * lean * o.trunkH * t + Math.sin(t * 5 + s) * 0.05, t * o.trunkH, Math.sin(az) * lean * o.trunkH * t));
      }
      tg.tube(p, lerpR(o.r0, o.r0 * 0.55, 4), 5, o.bark, 3, 0.75, 1);
      tops.push(p[4]);
    }
    for (const l of lobes) {
      let best = tops[0];
      for (const t of tops) if (t.distanceTo(l.c) < best.distanceTo(l.c)) best = t;
      branchTo(best, l, o.r0 * 0.5);
    }
  } else {
  trunkTop = V(leanX, o.trunkH, leanZ);
  tg.tube([V(0, 0, 0), V(leanX * 0.3, o.trunkH * 0.35, leanZ * 0.3), V(leanX * 0.7, o.trunkH * 0.7, leanZ * 0.7), trunkTop], [o.r0 * 1.2, o.r0, o.r0 * 0.93, o.r0 * 0.86], o.segs || 8, o.bark, 4, 0.7, 0.95);
  if (o.excurrent) {
    // 单轴（银杏、侧柏）：主干通到冠顶，侧枝在叶团高度以下从主干分出并斜向上
    const topY = C.y + CE.y * 0.95;
    const axisAt = (y) => {
      const f = Math.max(0, Math.min(1, (y - o.trunkH) / (topY - o.trunkH)));
      return V(leanX * (1 - 0.7 * f), y, leanZ * (1 - 0.7 * f));
    };
    const lead = [trunkTop, axisAt((o.trunkH + topY) / 2), axisAt(topY)];
    tg.tube(lead, [o.r0 * 0.86, o.r0 * 0.5, o.r0 * 0.14], 6, o.bark, 4, 0.8, 1);
    for (const l of lobes) {
      const hd = Math.hypot(l.c.x - leanX, l.c.z - leanZ);
      const y = Math.max(o.trunkH, Math.min(topY - 0.4, l.c.y - hd * (o.branchRise ?? 0.5)));
      const f = (y - o.trunkH) / (topY - o.trunkH);
      branchTo(axisAt(y), l, o.r0 * (0.42 - 0.25 * f));
    }
  } else {
    // 合轴（国槐、法桐）：主枝从分枝点斜出，按方位分管叶团；叶团枝从主枝上离它最近的一点分出
    const nL = o.limbs;
    const az0 = rand() * Math.PI * 2;
    const limbs = [];
    for (let i = 0; i < nL; i++) limbs.push({ az: az0 + (i / nL) * Math.PI * 2 + (rand() - 0.5) * 0.5, lobes: [] });
    for (const l of lobes) {
      const a = Math.atan2(l.c.z - trunkTop.z, l.c.x - trunkTop.x);
      let best = limbs[0], bd = 9;
      for (const m of limbs) {
        const d = Math.abs(((a - m.az + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < bd) { bd = d; best = m; }
      }
      best.lobes.push(l);
    }
    for (const m of limbs) {
      if (!m.lobes.length) continue;
      const mean = V(0, 0, 0);
      for (const l of m.lobes) mean.add(l.c);
      mean.divideScalar(m.lobes.length);
      const dir = mean.clone().sub(trunkTop);
      const dist = dir.length();
      dir.divideScalar(dist || 1);
      const path = limbPath(trunkTop.clone(), dir, dist * (o.limbFrac ?? 0.55), o.limbBend ?? 0.1, 4);
      const rr = lerpR(o.r0 * 0.66, o.r0 * 0.3, 4);
      tg.tube(path, rr, 6, o.bark, 4, 0.8, 1);
      for (const l of m.lobes) {
        let k = 2, bd = 1e9;
        for (let i = 2; i <= 4; i++) {
          const d = path[i].distanceTo(l.c);
          if (d < bd) { bd = d; k = i; }
        }
        branchTo(path[k], l, rr[k] * 0.75);
      }
    }
  }
  }
  // —— 3. 叶簇卡片 ——
  const crown = { c: C, r: CR };
  for (const l of lobes) {
    const nC = Math.max(3, Math.round(o.cardsPerLobe * (l.r / o.lobeR) ** 2));
    for (let k = 0; k < nC; k++) {
      const d = randDir(rand);
      const p = l.c.clone().addScaledVector(d, l.r * (0.2 + 0.6 * Math.sqrt(rand())));
      const lo = p.clone().sub(l.c).normalize();
      const co = p.clone().sub(C).divide(CR).normalize();
      const n = lo.multiplyScalar(0.6).addScaledVector(co, 0.4).add(randDir(rand).multiplyScalar(o.normJitter ?? 0.55));
      if (o.vertCards) n.y *= 1 - o.vertCards;
      n.normalize();
      const s = o.cardSize[0] + rand() * (o.cardSize[1] - o.cardSize[0]);
      let R, U;
      if (o.upright) {
        // 贴图“上”方向尽量朝天（垂柳枝条贴图自上而下垂挂）
        R = new THREE.Vector3().crossVectors(V(0, 1, 0), n);
        if (R.lengthSq() < 1e-4) R.set(1, 0, 0);
        R.normalize().multiplyScalar(s / 2);
        U = new THREE.Vector3().crossVectors(n, R).normalize().multiplyScalar(s / 2);
      } else [R, U] = cardAxes(n, s, s, rand);
      const tv = 0.92 + rand() * 0.14;
      tg.card(p, R, U, o.leafUV, crown, { flut: 1, tint: [tv, tv * (0.97 + rand() * 0.06), tv], lobe: l, sphere: 0.85 });
    }
  }
  return lobes;
}

/** 构建各树种近景几何（本地坐标，树基在原点，Y 向上，单位米） */
export function buildSpeciesGeometries() {
  const out = [];
  const leaf = (i) => rectUV(leafRect(i), 10);
  const bark = (j) => rectUV(barkRect(j), 2);

  // 0 国槐：H≈10.5 m，冠幅≈8.6 m，分枝点 2.6 m，圆球形冠
  {
    const rand = mulberry(101);
    const tg = new TreeGeo(10.5);
    broadleaf(tg, rand, {
      trunkH: 2.5, r0: 0.18, lean: 0.25, limbs: 5, limbFrac: 0.5, limbBend: 0.12,
      bark: bark(BT.HUAI), twig: bark(BT.TWIG), crownC: V(0, 6.6, 0), crownR: V(4.4, 3.7, 4.4),
      lobes: 24, lobeR: 1.5, cardsPerLobe: 7, cardSize: [1.6, 2.2], leafUV: leaf(LT.HUAI),
    });
    out.push(tg);
  }
  // 1 法国梧桐：H≈17 m，冠幅≈14 m，杯状整形（3~4 主枝斜展），平顶
  {
    const rand = mulberry(202);
    const tg = new TreeGeo(17);
    broadleaf(tg, rand, {
      trunkH: 3.1, r0: 0.3, lean: 0.2, limbs: 4, limbFrac: 0.5, limbBend: 0.08,
      bark: bark(BT.WUTONG), twig: bark(BT.TWIG), crownC: V(0, 10.6, 0), crownR: V(7.2, 5.9, 7.2),
      lobes: 30, lobeR: 2.1, cardsPerLobe: 7, cardSize: [2.1, 2.9], leafUV: leaf(LT.WUTONG), flatTop: true, segs: 9,
    });
    out.push(tg);
  }
  // 2 雪松：H≈15 m，基部冠幅≈9.6 m，塔形；大枝近平展、梢下垂，枝上一簇簇羽毛状针叶枝（每簇两张交叉的叶片，
  //   一张近水平、一张斜立——侧看、仰看都有厚度，不会像水平薄片那样侧面只剩一条线）
  {
    const rand = mulberry(303);
    const H = 15;
    const tg = new TreeGeo(H);
    const trunk = [];
    for (let i = 0; i <= 6; i++) trunk.push(V(0, (i / 6) * H, 0));
    tg.tube(trunk, lerpR(0.32, 0.03, 6), 7, bark(BT.XUESONG), 6, 0.55, 0.9);
    const uv = leaf(LT.XUESONG);
    const crown = { c: V(0, 5.8, 0), r: V(4.8, 6.4, 4.8) };
    const tiers = 17;
    let az = rand() * 6;
    const rMaxAt = (y) => 4.7 * Math.pow(Math.max(0, 1 - (y - 0.8) / (H - 0.8)), 0.92) + 0.4;
    for (let t = 0; t < tiers; t++) {
      const f = t / (tiers - 1);
      const y = 0.9 + f * (H - 2.2);
      const L = rMaxAt(y) * (0.88 + rand() * 0.18);
      const nb = t > tiers - 4 ? 3 : 6;
      for (let b = 0; b < nb; b++) {
        az += 2.39996 + (rand() - 0.5) * 0.4;
        const d = V(Math.cos(az), 0, Math.sin(az));
        const side = V(-d.z, 0, d.x);
        const p0 = V(d.x * 0.12, y, d.z * 0.12);
        const mid = p0.clone().addScaledVector(d, L * 0.5).add(V(0, 0.06 * L, 0));
        const tip = p0.clone().addScaledVector(d, L).add(V(0, -0.16 * L, 0));
        tg.tube([p0, mid, tip], [0.075 * (1 - f * 0.6), 0.04, 0.012], 3, bark(BT.TWIG), 3, 0.6, 0.9);
        const along = (k) => (k < 0.5 ? p0.clone().lerp(mid, k * 2) : mid.clone().lerp(tip, (k - 0.5) * 2));
        const w0 = (1.3 + 1.5 * (1 - f)) * (0.85 + rand() * 0.3);
        const ks = L > 2.2 ? [0.3, 0.58, 0.86] : L > 1.1 ? [0.45, 0.85] : [0.6];
        for (const k of ks) {
          const c = along(k);
          const half = (L / ks.length) * 0.75 + 0.3;
          // 沿枝方向（含梢部下垂）
          const dir = along(Math.min(1, k + 0.1)).sub(along(Math.max(0, k - 0.1))).normalize();
          const right = dir.multiplyScalar(half);
          const w = w0 * (1 - 0.35 * k);
          const roll = (rand() - 0.5) * 0.7;
          for (const r2 of [roll, roll + 1.15 + rand() * 0.3]) {
            const upv = side.clone().multiplyScalar(Math.cos(r2) * w * 0.5).add(V(0, Math.sin(r2) * w * 0.5, 0));
            tg.card(c, right, upv, uv, crown, { flut: 0.6, sphere: 0.5, tint: [0.97, 1, 1] });
          }
        }
        // 枝梢下垂的竖向叶片：一层层下垂的边缘
        if (L > 1.0) {
          const c2 = along(0.8).add(V(0, -0.25 - 0.05 * L, 0));
          tg.card(c2, d.clone().multiplyScalar(L * 0.3), V(0, w0 * 0.3, 0).addScaledVector(side, w0 * 0.1), uv, crown, { flut: 0.7, sphere: 0.55 });
        }
      }
    }
    // 冠内补片：随机朝向的针叶枝，补满层间空隙（大雪松枝叶浓密、近乎垂地）
    for (let i = 0; i < 90; i++) {
      const fy = Math.pow(rand(), 0.85);
      const y = 1.2 + fy * (H - 2.8);
      const rMax = rMaxAt(y);
      const a = rand() * Math.PI * 2;
      const rr = rMax * (0.3 + 0.55 * rand());
      const p = V(Math.cos(a) * rr, y, Math.sin(a) * rr);
      const n = V(Math.cos(a) * 0.6, 0.7, Math.sin(a) * 0.6).add(randDir(rand).multiplyScalar(0.7)).normalize();
      const sz = (1.1 + rMax * 0.32) * (0.8 + rand() * 0.4);
      const [R, U] = cardAxes(n, sz, sz * 0.7, rand);
      tg.card(p, R, U, uv, crown, { flut: 0.5, sphere: 0.6, tint: [0.95, 0.98, 0.98] });
    }
    // 塔尖（主梢略下垂）
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      tg.card(V(0.1, H - 0.9, 0), V(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5), V(0.08, 0.95, 0), uv, crown, { flut: 0.4, sphere: 0.4 });
    }
    out.push(tg);
  }
  // 3 垂柳：H≈10 m，冠幅≈10 m；树干斜向水面、分成几根大枝，圆顶叶团 + 从叶团下缘垂下的细长枝条帘（下垂到离地 1.5~3 m）
  {
    const rand = mulberry(404);
    const H = 10;
    const tg = new TreeGeo(H);
    const uv = leaf(LT.LIU);
    const lobes = broadleaf(tg, rand, {
      trunkH: 2.4, r0: 0.3, lean: 1.6, limbs: 5, limbFrac: 0.55, limbBend: 0.06,
      bark: bark(BT.LIU), twig: bark(BT.TWIG), crownC: V(0.6, 7.0, 0.2), crownR: V(4.6, 2.6, 4.6),
      lobes: 14, lobeR: 1.4, cardsPerLobe: 4, cardSize: [1.8, 2.4], leafUV: uv, segs: 8, upright: true,
    });
    const crown = { c: V(0.6, 7.0, 0.2), r: V(4.6, 2.6, 4.6) };
    // 下垂枝帘：从每个叶团下半边挂出 5~7 张竖向卡片，卡片法线水平朝外，上端藏进叶团里
    for (const l of lobes) {
      const out0 = Math.atan2(l.c.z - crown.c.z, l.c.x - crown.c.x);
      const nh = 5 + ((rand() * 3) | 0);
      for (let k = 0; k < nh; k++) {
        const az = out0 + (rand() - 0.5) * 2.4;
        const od = V(Math.cos(az), 0, Math.sin(az));
        const top = l.c.clone().addScaledVector(od, l.r * (0.45 + rand() * 0.5)).add(V(0, -l.r * (0.1 + rand() * 0.4), 0));
        const reach = Math.hypot(top.x - crown.c.x, top.z - crown.c.z) / crown.r.x; // 越靠外缘垂得越长
        const hang = Math.min(top.y - 1.4, (2.2 + 3.2 * reach) * (0.75 + rand() * 0.5));
        if (hang < 1) continue;
        const w = 0.9 + rand() * 0.6;
        const yaw = az + (rand() - 0.5) * 0.8;
        const right = V(-Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(w / 2);
        const up = V(Math.cos(yaw) * 0.07, 1, Math.sin(yaw) * 0.07).multiplyScalar(hang / 2);
        const c = top.clone().sub(up);
        tg.card(c, right, up, uv, crown, { flut: (sy) => (sy > 0 ? 1.0 : 2.2), bendY: top.y, sphere: 0.5, tint: [1, 1, 0.95] });
      }
    }
    out.push(tg);
  }
  // 4 银杏：H≈12 m，主干通直，侧枝斜上，冠长卵形
  {
    const rand = mulberry(505);
    const tg = new TreeGeo(12);
    broadleaf(tg, rand, {
      excurrent: true, trunkH: 2.6, r0: 0.21, lean: 0.12, branchRise: 0.55,
      bark: bark(BT.YINXING), twig: bark(BT.TWIG), crownC: V(0, 7.3, 0), crownR: V(3.1, 4.5, 3.1),
      lobes: 19, lobeR: 1.15, cardsPerLobe: 7, cardSize: [1.3, 1.8], leafUV: leaf(LT.YINXING), segs: 7,
    });
    out.push(tg);
  }
  // 5 石榴：H≈4.2 m，3 干丛生
  {
    const rand = mulberry(606);
    const tg = new TreeGeo(4.2);
    broadleaf(tg, rand, {
      stems: 3, trunkH: 2.2, r0: 0.075, lean: 0,
      bark: bark(BT.SHILIU), twig: bark(BT.TWIG), crownC: V(0, 2.9, 0), crownR: V(1.9, 1.4, 1.9),
      lobes: 8, lobeR: 0.75, cardsPerLobe: 6, cardSize: [0.9, 1.25], leafUV: leaf(LT.SHILIU), pack: 0.45,
    });
    out.push(tg);
  }
  // 6 灌木球：H≈1.3 m，Ø≈1.7 m（不规则团块实心 + 外伸叶簇打破轮廓；不再是光滑椭球“西瓜”）
  {
    const rand = mulberry(707);
    const tg = new TreeGeo(1.3);
    const crown = { c: V(0, 0.66, 0), r: V(0.86, 0.64, 0.86) };
    const ico = new THREE.IcosahedronGeometry(1, 2);
    const pos = ico.attributes.position;
    const dense = rectUV(barkRect(BT.SHRUB), 4);
    // 低频起伏：几个随机方向的“鼓包”叠加（修剪过的球也有一团团的轮廓）
    const bumps = [];
    for (let k = 0; k < 7; k++) bumps.push([randDir(rand), 0.08 + rand() * 0.1]);
    const map = new Map();
    const idx = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
      if (!map.has(key)) {
        const n = V(x, y, z).normalize();
        let k = 1 + (rand() - 0.5) * 0.08;
        for (const [d, a] of bumps) k += a * Math.max(0, n.dot(d) - 0.55) * 2.2;
        const p = V(x * crown.r.x * k, Math.max(0.02, crown.c.y + y * crown.r.y * k), z * crown.r.z * k);
        // 平面投影 UV（贴图是无方向的密叶，避免球面展开在顶/底聚成条纹）
        const u = dense.u0 + (dense.u1 - dense.u0) * (0.5 + 0.42 * (x * 0.8 + z * 0.6));
        // 树皮条 256×1024：v 方向按 1/4 取，叶片不被拉长
        const v = dense.vBot + (dense.vTop - dense.vBot) * (0.5 + 0.105 * (y * 0.85 + (z * 0.8 - x * 0.6) * 0.35));
        const ao = 0.62 + 0.38 * (0.5 + y * 0.5);
        map.set(key, tg.vert(p, n, u, v, [ao, ao, ao], p.y, 0.3));
      }
      idx.push(map.get(key));
    }
    for (let i = 0; i < idx.length; i += 3) tg.I.push(idx[i], idx[i + 1], idx[i + 2]);
    ico.dispose();
    const uv = leaf(LT.GUANMU);
    for (let i = 0; i < 40; i++) {
      const d = randDir(rand);
      d.y = Math.abs(d.y) * 0.9 + 0.05;
      const p = crown.c.clone().add(d.clone().multiply(crown.r).multiplyScalar(0.9 + rand() * 0.15));
      const [R, U] = cardAxes(d.clone().normalize().add(randDir(rand).multiplyScalar(0.4)).normalize(), 0.85, 0.85, rand);
      tg.card(p, R, U, uv, crown, { flut: 0.6, sphere: 0.8 });
    }
    out.push(tg);
  }
  // 7 侧柏：H≈11 m，卵圆至宝塔形冠，鳞叶小枝竖排（卡片偏竖向），老树主干略倾斜
  {
    const rand = mulberry(808);
    const tg = new TreeGeo(11);
    broadleaf(tg, rand, {
      excurrent: true, trunkH: 1.9, r0: 0.22, lean: 0.4, branchRise: 0.9,
      bark: bark(BT.HUAI), twig: bark(BT.TWIG), crownC: V(0, 6.3, 0), crownR: V(2.6, 4.6, 2.6),
      lobes: 19, lobeR: 1.0, cardsPerLobe: 7, cardSize: [1.1, 1.55], leafUV: leaf(LT.BAI), vertCards: 0.6, pack: 0.5,
    });
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
