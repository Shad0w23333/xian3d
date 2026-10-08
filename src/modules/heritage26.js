// 全城古建与历史遗迹批量精建：寺观（大兴善寺、青龙寺、卧龙寺、广仁寺、八仙宫、香积寺、兴教寺、草堂寺……）、
// 碑林/孔庙、书院门·关中书院、永兴坊、大唐西市、易俗社、七贤庄、张学良公馆、新城黄楼、各代帝陵封土与遗址台基、
// 华清宫、兵马俑、半坡等。数据：public/data/landmarks2026.json 的 heritage（tools/build_landmarks2026.py 由
// research/refs/landmarks2026/heritage.json 生成：院落中心/朝向/尺寸 + 主体建筑的类型、开间、屋顶形式与颜色、局部位置）。
// 已有专门模块的（钟鼓楼、城墙、大小雁塔、大明宫丹凤门、陕历博……）在调研清单里标 already_modeled，不在这里重复。
// 构建策略：先全部建 detail 0（远景体量），相机靠近（< 900 m）时每帧最多升级一个院落到 detail 2。
//
// 防穿模 / 贴地（tools/check_arch_clip.mjs 体检）：
//  · 尺寸拟合：数据给的是建筑平面（含出檐）尺寸 w×d。原先开间/进深按经验公式取，建成后常比数据大一圈（进深最少两间 × 7 m、
//    楼阁一律做成正方形、密檐塔一律 60 m 高），与相邻建筑、院墙互相穿插。现在先用 detail 0 试建、量实际包围盒，
//    反推开间宽/进深宽再建，使建成平面 ≤ 数据尺寸（fitBuilding）。
//  · 贴地：每座建筑按自身平面内的地面最高点落位（不再统一用院落中心高度），低处用石台基补足到地面以下（sitePlan）。
//  · 院墙：围住全部建筑（外扩），门类建筑骑在墙线上时墙在门两侧断开；墙分段顺地形（siteWall）。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';
import { ArchBuilder, hall, multiStoreyTower, pavilion, paifang, yardWall, balustrade } from '../arch/chinese.js';
import { denseEavePagoda, ruinTerrace, whiteBlock, roofMaterials } from '../arch/heritage-parts.js';
import { isSuperseded } from '../arch/dossier-kit.js';
import { shadowReach } from '../arch/perf-lod.js';

const HIDE = 9000;
const NEAR = 900;
const ROOF = { xieshan: 'xieshan', wudian: 'wudian', yingshan: 'yingshan', xuanshan: 'xuanshan', juanpeng: 'juanpeng' };
const COLOR = (c) => (/黄|yellow|gold/.test(c) ? 'yellow' : /绿|green/.test(c) ? 'green' : /蓝|blue/.test(c) ? 'blue' : /黑|black/.test(c) ? 'black' : /dark|深灰/.test(c) ? 'darkgray' : 'gray');
const odd = (n) => Math.max(1, n % 2 ? n : n + 1);
const clamp = THREE.MathUtils.clamp;
const WALL_H = 3.4, WALL_T = 0.6;
const TERRACE = 3.0; // 建筑平面内地面高差超过此值 → 平整成台地（否则石台基补足）

/** 密檐塔参数：数据 w = 塔身底边长，h = 通高（含台基、塔刹） */
function pagodaSpec(q) {
  const w = clamp(q.w * 0.9, 1.6, 14);
  const podH = clamp(w * 0.16, 0.5, 1.6);
  const podW = w + 2 * clamp(w * 0.28, 0.8, 3.0);
  const H = q.h || clamp(w * 4, 8, 60);
  const finH = clamp(H * 0.09, 0.8, 4.5);
  const bodyH = Math.max(3, H - podH - finH);
  const floors = clamp(q.storeys || Math.round(bodyH / 3.2), 3, 15);
  const firstH = clamp(bodyH * (floors <= 5 ? 0.3 : 0.2), 1.6, 7);
  return { w, podH, podW, bodyH, floors, firstH, finH };
}

/** 数据 → 构件参数（未拟合时的初值） */
function initParams(q) {
  const w = q.w, d = q.d, h = q.h || null;
  const type = q.type;
  if (type === 'hall' || type === 'gate') {
    const bays = odd(clamp(q.bays || Math.round(w / 5), 3, 11));
    const bayW = clamp((w / bays) * 0.86, 2.8, 7.2);
    const depthBays = clamp(Math.round((d * 0.8) / bayW), 2, 6);
    return { bays, bayW, depthBays, depthW: bayW * 0.95 };
  }
  if (type === 'tower') {
    const bays = odd(clamp(q.bays || Math.round(w / 4), 1, 5));
    const bayW = clamp((w / Math.max(1, bays)) * 0.8, 2.6, 5);
    const depthBays = odd(clamp(Math.round(d / 4), 1, 5));
    return { bays, bayW, depthBays, depthW: clamp((d / depthBays) * 0.8, 2.6, 5) };
  }
  if (type === 'pavilion') return { size: clamp(Math.min(w, d), 4, 14), w: null, d: null };
  return {};
}

/**
 * 单座建筑（院落局部坐标：q.x/q.z/q.rot）。p = 拟合后的构件参数（缺省按数据估算）；y = 落位高度（相对院落原点）。
 */
export function building(b, q, style, p = q._fit || initParams(q), y = 0) {
  const w = q.w, d = q.d, type = q.type, rc = COLOR(q.color), roofT = ROOF[q.roof] || 'xieshan';
  const h = q.h || null;
  b.push(q.x, y, q.z, q.rot || 0);
  try {
    if (type === 'hall' || type === 'gate') {
      const { bays, bayW, depthBays, depthW } = p;
      if ((q.storeys || 1) >= 2) {
        multiStoreyTower(b, { style, floors: Math.min(3, q.storeys), bays, depthBays, bayW, depthW, colH: clamp(bayW * 0.9, 3.2, 5.5), roof: roofT, roofColor: rc, platformH: 1.0 });
      } else {
        hall(b, { style, bays, depthBays, bayW, depthW, colH: h ? clamp(h * 0.38, 3.2, 8) : undefined, roof: roofT, roofColor: rc, eaves: h && h > 18 ? 2 : 1, steps: type === 'gate' ? 'frontback' : 'front', front: type === 'gate' ? 'gate' : undefined });
      }
    } else if (type === 'tower') {
      const { bays, bayW, depthBays, depthW } = p;
      multiStoreyTower(b, { style, floors: clamp(q.storeys || 2, 2, 4), bays, depthBays, bayW, depthW, colH: 3.6, roof: roofT === 'xuanshan' ? 'xieshan' : roofT, roofColor: rc, platformH: 1.2 });
    } else if (type === 'pagoda') {
      // 原先传 height（构件不认）→ 一律按小雁塔默认 40 m 塔身、塔顶残缺；现按数据通高分配塔身/台基/塔刹
      const s = pagodaSpec(q);
      const r = denseEavePagoda(b, { floors: s.floors, baseW: s.w, podium: { w: s.podW, h: s.podH }, firstH: s.firstH, totalH: s.bodyH, broken: false, topW: 0.55 });
      // 塔刹：覆钵 + 相轮 + 宝珠（石/铁）
      const tw = r.widths[r.widths.length - 1] * 0.55, fh = s.finH;
      const yt = r.topY;
      b.frustum('brick', 0, 0, yt - 0.02, tw, tw, yt + fh * 0.18, tw * 0.7, tw * 0.7, 0x9a8d79);
      b.lathe('stone', [[0.001, yt + fh * 0.18], [tw * 0.42, yt + fh * 0.2], [tw * 0.4, yt + fh * 0.36], [tw * 0.16, yt + fh * 0.44], [tw * 0.12, yt + fh * 0.8], [tw * 0.2, yt + fh * 0.86], [tw * 0.12, yt + fh * 0.95], [0.001, yt + fh]], b.detail >= 2 ? 12 : 6, 0x8a8478);
    } else if (type === 'pavilion') {
      pavilion(b, { style, sides: /cuanjian|zanjian|攒尖/.test(q.roof) ? 8 : 4, size: p.size, w: p.w ?? undefined, d: p.d ?? undefined, roofColor: rc });
    } else if (type === 'paifang') {
      paifang(b, { style, bays: clamp(odd(q.bays || 3), 1, 5), width: clamp(w, 5, 24) });
    } else if (type === 'mound') {
      const hh = h || clamp(Math.min(w, d) * 0.2, 6, 60);
      b.frustum('plaster', 0, 0, 0, w, d, hh, w * 0.32, d * 0.32, 0x8c7c58);
    } else if (type === 'platform') {
      ruinTerrace(b, [{ w, d, h: h || 6 }, { w: w * 0.7, d: d * 0.7, h: (h || 6) * 0.5 }]);
    } else if (type === 'other') {
      other(b, q);
    } else {
      whiteBlock(b, { w, d, h: h || 12, color: type === 'modern' ? 0xe6e1d6 : 0xd8d0c0 });
    }
  } catch (e) {
    console.error('[heritage26] 构件失败', q.n, e);
  }
  b.pop();
}

/** 杂项（原先一律做成 24×14×12 m 的白色方块：照壁、桥、水景、石刻都成了大白盒子） */
function other(b, q) {
  const n = q.n || '';
  if (/照壁|影壁|萧墙/.test(n)) {
    const L = clamp(q.w, 6, 24), hh = clamp(q.h || 6, 3, 8);
    yardWall(b, [[-L / 2, 0], [L / 2, 0]], { h: hh, t: 1.1, color: 0xa4382a, skirt: 1.0 });
  } else if (/桥/.test(n)) {
    // 单孔石拱桥（示意）：桥面 + 两侧石栏
    const L = clamp(q.w, 8, 24), W = clamp(Math.min(q.d, 6), 3, 6), rise = 1.2;
    const prof = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      prof.push([-L / 2 + L * t, 0.35 + rise * Math.sin(Math.PI * t)]);
    }
    b.prism('stone', [[-L / 2, 0], ...prof, [L / 2, 0]], 'z', -W / 2, W / 2, 0xc9c2b4);
    if (b.detail >= 1)
      for (const s of [1, -1]) balustrade(b, prof.map(([x, y]) => [x, y, s * (W / 2 - 0.2)]), { kind: 'stone', h: 0.8, color: 0xd6d0c4 });
  } else if (/水景|喷|池/.test(n)) {
    // 旱喷/水景：地面铺装即可
    b.box('stone', -q.w / 2, -0.2, -q.d / 2, q.w / 2, 0.06, q.d / 2, 0x9ea3a6, { skip: 'bottom' });
  } else if (/碑|石刻|石像|狮|天禄/.test(n)) {
    const hh = clamp(q.h || 3, 1.5, 10);
    b.box('stone', -1.2, 0, -0.8, 1.2, 0.6, 0.8, 0xa9a397, { skip: 'bottom' });
    b.box('stone', -0.7, 0.6, -0.25, 0.7, hh, 0.25, 0x8d8a84, { skip: 'bottom' });
  } else {
    whiteBlock(b, { w: q.w, d: q.d, h: q.h || 8, color: 0xd8d0c0 });
  }
}

/** 量一座建筑（单独 detail 0 构建）在其局部坐标下的平面包围盒：full = 全部几何，base = 离地 0.3 m 以内（台基/踏步） */
function measure(ctx, q, style, p) {
  const b = new ArchBuilder(ctx, { detail: 0, style });
  building(b, { ...q, x: 0, z: 0, rot: 0 }, style, p);
  const full = [Infinity, Infinity, -Infinity, -Infinity], base = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [, bk] of b.buckets) {
    const P = bk.p.a;
    for (let i = 0; i < bk.count; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      full[0] = Math.min(full[0], x); full[1] = Math.min(full[1], z); full[2] = Math.max(full[2], x); full[3] = Math.max(full[3], z);
      if (y < 0.3) {
        base[0] = Math.min(base[0], x); base[1] = Math.min(base[1], z); base[2] = Math.max(base[2], x); base[3] = Math.max(base[3], z);
      }
    }
  }
  b.buckets.clear();
  b.inst.clear();
  b.plaques = [];
  if (!Number.isFinite(base[0])) base.splice(0, 4, ...full);
  return { full, base };
}

/**
 * 尺寸拟合：反推开间宽/进深宽，使建成平面（含出檐）不超过数据 w×d（两轮迭代）。返回 {p, full, base}（局部坐标）。
 */
export function fitBuilding(ctx, q, style) {
  let p = initParams(q);
  let m = measure(ctx, q, style, p);
  const t = q.type;
  // 目标外廓：数据尺寸（OSM/调研多为墙身或台基轮廓）外加每边 0.75 m 檐口余量；tools/build_landmarks2026.py 排布时留 3 m 净距
  const TW = q.w + 1.5, TD = q.d + 1.5;
  if (t === 'hall' || t === 'gate' || t === 'tower') {
    const maxBW = t === 'tower' ? 5 : 7.2;
    for (let it = 0; it < 3; it++) {
      const X = m.full[2] - m.full[0], Z = m.full[3] - m.full[1];
      const exX = X - p.bays * p.bayW, exZ = Z - p.depthBays * p.depthW; // 出檐、台基等固定外延
      let bw = (TW - exX) / p.bays;
      if (bw < 2.4 && p.bays > 1) {
        p.bays = Math.max(1, p.bays - 2);
        bw = (TW - exX) / p.bays;
      }
      // 进深不宜过浅（数据只给到半边轮廓时，避免拟合出“纸片殿”）：进深柱网 ≥ max(3.5 m, 面阔柱网 × 0.22)
      const spanD = Math.max(TD - exZ, 3.5, 0.22 * p.bays * clamp(bw, 2.2, maxBW));
      let dBays = p.depthBays;
      let dw = spanD / dBays;
      while (dw < 2.2 && dBays > 1) dw = spanD / --dBays;
      while (dw > maxBW && dBays < 6) dw = spanD / ++dBays;
      let nb = clamp(bw, 2.2, maxBW), nd = clamp(dw, 2.0, maxBW);
      // 楼阁逐层内收（每层每边 0.6 m）：顶层柱网不能收成负值（否则几何 NaN）
      const minSpan = t === 'tower' ? 2.6 + 1.2 * (clamp(q.storeys || 2, 2, 4) - 1) : (q.storeys || 1) >= 2 ? 2.6 + 1.2 * (Math.min(3, q.storeys) - 1) : 0;
      nb = Math.max(nb, minSpan / p.bays);
      nd = Math.max(nd, minSpan / dBays);
      if (Math.abs(nb - p.bayW) < 0.02 && Math.abs(nd - p.depthW) < 0.02 && dBays === p.depthBays) break;
      p = { ...p, bayW: nb, depthBays: dBays, depthW: nd };
      m = measure(ctx, q, style, p);
    }
  } else if (t === 'pavilion') {
    for (let it = 0; it < 2; it++) {
      const X = m.full[2] - m.full[0], Z = m.full[3] - m.full[1];
      const rect = !/cuanjian|zanjian|攒尖/.test(q.roof) && (q.w > q.d * 1.3 || q.d > q.w * 1.3); // 只有四角亭能做矩形柱网
      if (rect) {
        // 长方形戏台等：四角亭按矩形柱网
        const cw = p.w ?? p.size, cd = p.d ?? p.size;
        p = { ...p, w: clamp(cw - (X - TW), 2.5, 24), d: clamp(cd - (Z - TD), 2.5, 24) };
      } else p = { ...p, size: clamp(p.size - (Math.max(X - TW, Z - TD)), 2.5, 14) };
      m = measure(ctx, q, style, p);
    }
  }
  return { p, full: m.full, base: m.base };
}

function styleOf(s) {
  return /唐|tang/i.test(s.era || '') && !/明|清/.test(s.era || '') ? 'tang' : 'ming';
}

/** 局部矩形 → 院落局部（考虑建筑自身 rot）的轴对齐包围盒 */
function toSite(q, r) {
  const c = Math.cos(q.rot || 0), s = Math.sin(q.rot || 0);
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, z] of [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]) {
    const X = q.x + x * c + z * s, Z = q.z - x * s + z * c;
    out[0] = Math.min(out[0], X); out[1] = Math.min(out[1], Z); out[2] = Math.max(out[2], X); out[3] = Math.max(out[3], Z);
  }
  return out;
}

/** 台基范围内地面最低/最高（5×5 取样） */
function groundRange(ground, base) {
  let gmax = -Infinity, gmin = Infinity;
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++) {
      const g = ground(base[0] + ((base[2] - base[0]) * i) / 4, base[1] + ((base[3] - base[1]) * j) / 4);
      gmax = Math.max(gmax, g);
      gmin = Math.min(gmin, g);
    }
  return { gmin, gmax };
}

/** 相邻建筑平整台地（羽化带）会改变本建筑脚下地面：台地加完后，非台地建筑按新地面重新落位 */
function refreshGround(plan) {
  for (const it of plan.items) {
    if (it.terrace) continue;
    const { gmin, gmax } = groundRange(plan.ground, it.base);
    it.gmin = gmin;
    it.gmax = gmax;
    it.y = it.q.type === 'mound' ? gmin : gmax;
    it.plinth = it.q.type !== 'mound' && it.y - gmin > 0.05;
    it.bottom = it.plinth ? gmin - 0.4 : it.y;
  }
}

/**
 * 院落方案（缓存于 s._plan）：每座建筑的拟合参数、院落局部平面包围盒（full / base）、落位高度（世界 y）与台基补足底（世界 y）；
 * 以及院墙（siteWall）。地面按建筑自身台基范围取样，不再统一用院落中心高度。
 */
export function sitePlan(ctx, s) {
  if (s._plan) return s._plan;
  const style = styleOf(s);
  const cr = Math.cos(s.rot || 0), sr = Math.sin(s.rot || 0);
  const toW = (lx, lz) => [s.x + lx * cr + lz * sr, s.z - lx * sr + lz * cr];
  const ground = (lx, lz) => ctx.terrain.heightAt(...toW(lx, lz));
  const h0 = ctx.terrain.heightAt(s.x, s.z);
  const items = s.b.map((q) => {
    const f = fitBuilding(ctx, q, style);
    q._fit = f.p;
    const full = toSite(q, f.full), base = toSite(q, f.base);
    const { gmin, gmax } = groundRange(ground, base);
    // 封土：落在最低点（高处埋入土中是自然的）。其余建筑：平面内高差 ≤ 3 m 时落在最高点、低处石台基补足；
    // 山地寺院高差更大（DEM 36 m 格网，一座殿下面可差十几米）：取中间高度，prepare 里按台基范围平整地形（挖高填低，
    // 即山寺常见的台地），不再垫十几米高的石台
    const terrace = q.type !== 'mound' && gmax - gmin > TERRACE;
    const y = q.type === 'mound' ? gmin : terrace ? (gmin + gmax) / 2 : gmax;
    const plinth = q.type !== 'mound' && !terrace && y - gmin > 0.05;
    return { q, full, base, y, bottom: plinth ? gmin - 0.4 : y, plinth, terrace, gmin, gmax };
  });
  const plan = { style, h0, items, ground, wall: null };
  plan.wall = siteWall(s, plan);
  s._plan = plan;
  return plan;
}

/**
 * 院墙：中小院落、非陵/遗址/俑才画。先取数据院落矩形，再外扩到包住所有非门类建筑（留 2.5 m）；
 * 门类（gate / 名称含“门”）骑在墙线上时，该段墙在门两侧断开。外扩超过原尺寸 1.6 倍（院落数据不可靠）则不画。
 * 返回 {x0, z0, x1, z1, gaps:[{side, a, b}]}（院落局部）或 null。
 */
export function siteWall(s, plan = s._plan) {
  if (!(s.w <= 260 && s.d <= 360 && !/陵|遗址|俑/.test(s.name))) return null;
  let x0 = -s.w / 2, x1 = s.w / 2, z0 = -s.d / 2, z1 = s.d / 2;
  const isGate = (q) => q.type === 'gate' || /门/.test(q.n || '');
  const M = 2.5;
  if (plan)
    for (const it of plan.items) {
      if (isGate(it.q)) continue;
      const f = it.full;
      x0 = Math.min(x0, f[0] - M); z0 = Math.min(z0, f[1] - M); x1 = Math.max(x1, f[2] + M); z1 = Math.max(z1, f[3] + M);
    }
  if (x1 - x0 > s.w * 1.6 || z1 - z0 > s.d * 1.6) return null;
  const gaps = [];
  if (plan)
    for (const it of plan.items) {
      if (!isGate(it.q)) continue;
      // 按门的台基平面判定/开口（墙从出檐下穿过没关系），墙头伸进台基 0.15 m，不留缝
      const f = it.base;
      const cut = (side, a, b) => gaps.push({ side, a: a + 0.15, b: b - 0.15 });
      // 门骑在哪条墙线上（墙厚 + 余量），就在那条边断开（断口 = 门的平面宽）
      if (f[1] < z1 + WALL_T && f[3] > z1 - WALL_T) cut('S', f[0], f[2]);
      if (f[1] < z0 + WALL_T && f[3] > z0 - WALL_T) cut('N', f[0], f[2]);
      if (f[0] < x1 + WALL_T && f[2] > x1 - WALL_T) cut('E', f[1], f[3]);
      if (f[0] < x0 + WALL_T && f[2] > x0 - WALL_T) cut('W', f[1], f[3]);
    }
  return { x0, z0, x1, z1, gaps };
}

/** 院墙几何：按周长展开，扣掉门洞，分成 ≤ 12 m 的小段顺地形 */
function buildWall(b, s, plan) {
  const w = plan.wall;
  if (!w) return;
  const color = /寺|庙|宫|观|祠/.test(s.name) ? 0xa4382a : 0x8f8a82;
  // 周长参数化：S 边（z1，x0→x1）、E 边（x1，z1→z0）、N 边（z0，x1→x0）、W 边（x0，z0→z1）
  const Lx = w.x1 - w.x0, Lz = w.z1 - w.z0;
  const sides = [
    { k: 'S', at: (t) => [w.x0 + t, w.z1], len: Lx, u: (v) => v - w.x0 },
    { k: 'E', at: (t) => [w.x1, w.z1 - t], len: Lz, u: (v) => w.z1 - v },
    { k: 'N', at: (t) => [w.x1 - t, w.z0], len: Lx, u: (v) => w.x1 - v },
    { k: 'W', at: (t) => [w.x0, w.z0 + t], len: Lz, u: (v) => v - w.z0 },
  ];
  const P = 2 * (Lx + Lz);
  // 断口（周长坐标）
  const cuts = [];
  let off = 0;
  for (const sd of sides) {
    for (const g of w.gaps)
      if (g.side === sd.k) {
        const a = sd.u(g.a), bb = sd.u(g.b);
        cuts.push([off + Math.max(0, Math.min(a, bb)), off + Math.min(sd.len, Math.max(a, bb))]);
      }
    off += sd.len;
  }
  cuts.sort((p, q) => p[0] - q[0]);
  const at = (t) => {
    t = ((t % P) + P) % P;
    let o = 0;
    for (const sd of sides) {
      if (t <= o + sd.len + 1e-6) return sd.at(t - o);
      o += sd.len;
    }
    return sides[3].at(sides[3].len);
  };
  const corners = [0, Lx, Lx + Lz, 2 * Lx + Lz];
  const run = (t0, t1, closed) => {
    // 折点：起止、转角、每 ≤ 12 m
    const ts = [t0];
    for (const c of [...corners, ...corners.map((c) => c + P)]) if (c > t0 + 0.01 && c < t1 - 0.01) ts.push(c);
    ts.push(t1);
    const pts = [];
    for (let i = 0; i < ts.length - 1; i++) {
      const n = Math.max(1, Math.ceil((ts[i + 1] - ts[i]) / 12));
      for (let k = 0; k < n; k++) pts.push(ts[i] + ((ts[i + 1] - ts[i]) * k) / n);
    }
    if (!closed) pts.push(t1);
    const xz = pts.map(at);
    const ys = xz.map(([x, z]) => plan.ground(x, z) - plan.h0 - 0.05);
    yardWall(b, xz, { closed, h: WALL_H, t: WALL_T, color, ys, ext0: 0, ext1: 0 });
  };
  if (!cuts.length) run(0, P, true);
  else
    for (let i = 0; i < cuts.length; i++) {
      const a = cuts[i][1], bb = i + 1 < cuts.length ? cuts[i + 1][0] : cuts[0][0] + P;
      if (bb - a > 0.8) run(a, bb, false);
    }
}

/** 建一个院落（相对院落原点 h0：各建筑按 sitePlan 落位，台基补足） */
function buildSite(ctx, s, detail) {
  const plan = sitePlan(ctx, s);
  const b = new ArchBuilder(ctx, { detail, style: plan.style, name: s.key });
  for (const it of plan.items) {
    const y = it.y - plan.h0;
    if (it.plinth) {
      // 台基补足：低处用毛石台基垫到建筑底面（顶面藏在建筑台基下）
      const [x0, z0, x1, z1] = it.base;
      b.box('stone', x0 - 0.25, it.bottom - plan.h0, z0 - 0.25, x1 + 0.25, y - 0.02, z1 + 0.25, 0xa9a397, { skip: 'bottom' });
    }
    building(b, it.q, plan.style, it.q._fit, y);
  }
  buildWall(b, s, plan);
  return b.build({ name: s.key + '@' + detail, materials: roofMaterials(ctx) }); // 瓦面少天光（否则读成藏青）
}

/** 供体检脚本：建筑实际落位（世界 y）与台基补足底 */
export function buildingBase(ctx, s, q) {
  const it = sitePlan(ctx, s).items.find((i) => i.q === q);
  return it ? { y: it.y, bottom: it.bottom } : null;
}

export default {
  id: 'heritage26',
  name: '古建与历史遗迹（全城）',
  async prepare(ctx) {
    const raw = await loadJSON('landmarks2026.json', { optional: true });
    this.sites = [];
    for (const s of raw?.heritage || []) {
      if (!s.b?.length) continue;
      if (ctx.exclusions.test(s.x, s.z, 'buildings', 0)) continue; // 已被专门模块占用
      if (isSuperseded(ctx, { name: s.name, x: s.x, z: s.z })) continue; // 已由逐栋档案精建（src/arch/dossier-specs，按名称或院落中心判定）
      this.sites.push(s);
    }
    // 院落方案（尺寸拟合、落位）在平整地形之前算；陡坡上的建筑把台基范围平整成台地
    for (const s of this.sites) {
      const plan = sitePlan(ctx, s);
      const cr = Math.cos(s.rot || 0), sr = Math.sin(s.rot || 0);
      for (const it of plan.items) {
        if (!it.terrace) continue;
        const [x0, z0, x1, z1] = it.base;
        const pts = [];
        for (const [lx, lz] of [[x0 - 1, z0 - 1], [x1 + 1, z0 - 1], [x1 + 1, z1 + 1], [x0 - 1, z1 + 1]]) pts.push(s.x + lx * cr + lz * sr, s.z - lx * sr + lz * cr);
        ctx.terrain.addFlatten({ points: pts, height: it.y, feather: 10 });
      }
    }
    for (const s of this.sites) refreshGround(sitePlan(ctx, s));
    const c = (s) => Math.cos(s.rot), n = (s) => Math.sin(s.rot);
    for (const s of this.sites) {
      for (const q of s.b) {
        if (q.type === 'mound') continue; // 封土不排除周边
        const hw = q.w / 2 + 3, hd = q.d / 2 + 3, cr = c(s), sr = n(s);
        const pts = [];
        for (const [ax, az] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
          const lx = q.x + ax, lz = q.z + az;
          pts.push(s.x + lx * cr + lz * sr, s.z - lx * sr + lz * cr);
        }
        ctx.exclusions.add({ points: pts, name: 'heritage26' }, { buildings: true, trees: true, pois: false });
      }
    }
  },

  build(ctx) {
    const root = new THREE.Group();
    root.name = '古建与历史遗迹';
    ctx.scene.add(root);
    const items = [];
    let n = 0;
    // 绘制负担：detail 0 的院落一处仍有几万三角形，9 km 内全显示时一个视角要画二三十处（2M 三角形）。
    // 按体量定隐藏距离（大体量/高塔 9 km，中等 5 km，小院落 2.8 km，再乘画质系数）；升级到 detail 2 后 detail 0 保留为中景级；
    // 只有相机附近 SHADOW_R 内的院落投射阴影
    const qk = [0.6, 0.8, 1, 1.25][ctx.quality.level ?? 2] ?? 1;
    const hideDistOf = (s) => {
      const area = s.b.reduce((a, q) => a + (q.w || 0) * (q.d || 0), 0);
      const hmax = Math.max(0, ...s.b.map((q) => q.h || 0));
      return (area >= 8000 || hmax >= 25 ? HIDE : area >= 2500 || hmax >= 16 ? 5000 : 2800) * qk;
    };
    const MID = 1300 * qk, SHADOW_R = 1100 * qk, NEAR2 = 380 * qk; // NEAR（900 m）内 detail 1，NEAR2 内 detail 2
    for (const s of this.sites || []) {
      try {
        const plan = sitePlan(ctx, s);
        const lod = new THREE.LOD();
        lod.addLevel(buildSite(ctx, s, 0), 0);
        lod.addLevel(new THREE.Object3D(), hideDistOf(s));
        lod.position.set(s.x, plan.h0, s.z);
        lod.rotation.y = s.rot || 0;
        lod.name = 'heritage26:' + s.name;
        root.add(lod);
        items.push({ s, lod, det: 0, sh: true });
        const top = Math.max(12, ...s.b.map((q) => (q.h || 10)));
        const yTop = Math.max(...plan.items.map((it) => it.y)) + top + 10;
        ctx.labels.add(s.name.replace(/（.*?）|\(.*?\)/g, ''), new THREE.Vector3(s.x, yTop, s.z), { category: 'landmark', priority: 1.8, minDist: 80, maxDist: 7000 });
        n++;
      } catch (e) {
        console.error('[heritage26] ' + s.name, e);
      }
    }
    console.warn(`[heritage26] ${n} 处院落/遗址`);
    let frame = 0;
    return {
      update() {
        frame++;
        const cp = ctx.camera.position;
        // 阴影：只给相机附近的院落（每 15 帧刷新一次；半径还随阴影贴图实际覆盖范围收缩）
        if (frame % 15 === 1) {
          const sr = shadowReach(ctx, SHADOW_R, 25);
          for (const it of items) {
            const sh = Math.hypot(it.s.x - cp.x, it.s.z - cp.z) < sr;
            if (sh !== it.sh) {
              it.sh = sh;
              it.lod.traverse((o) => { if (o.isMesh) o.castShadow = sh; });
            }
          }
        }
        // 近景升级：每帧最多一个。NEAR 内先建 detail 1（斗拱/门窗），NEAR2 内再建 detail 2；
        // 旧级别保留为更远的 LOD 级（detail 1 用到 NEAR2，detail 0 用到 MID），飞远后不再用近景级画整个院落
        for (const it of items) {
          if (it.det >= 2) continue;
          const d = Math.hypot(it.s.x - cp.x, it.s.z - cp.z);
          const want = d < NEAR2 ? 2 : d < NEAR ? 1 : 0;
          if (want <= it.det) continue;
          const det = it.det + 1; // 逐级升（detail 0 → 1 → 2）
          try {
            const g = buildSite(ctx, it.s, det);
            g.traverse((o) => { if (o.isMesh) o.castShadow = it.sh; });
            it.lod.levels[0].distance = det === 1 ? MID : NEAR2;
            it.lod.addLevel(g, 0);
          } catch (e) {
            console.error('[heritage26] 近景构建失败 ' + it.s.name, e);
          }
          it.det = det;
          break;
        }
      },
      setLayer(layer, v) {
        if (layer === 'buildings') root.visible = v;
      },
      dispose() {
        root.traverse((o) => o.geometry?.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};
