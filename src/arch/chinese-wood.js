// 中式古建构件库 —— 大木作：柱网环（ring）、柱与柱础、额枋（彩画）、平板枋/普拍枋、斗拱层（原型实例化/合并）、雀替。
// 坐标约定同 chinese-core.js：单位米，原点为平面中心，Y 向上，正面朝 +Z；立面局部系 x = 从外向里看的左→右，+Z = 朝外。
import * as THREE from 'three';
import { lin, clamp, lerp, palette, STYLES } from './chinese-core.js';

// ───────────── 尺度 ─────────────
/**
 * 按风格与柱高给出大木尺度（米）。
 *   唐（佛光寺东大殿：柱高 4.99、柱径 0.54、斗拱高 ≈ 0.42 柱高、出跳 ≈ 斗拱高）；
 *   明清（清式：柱高 ≈ 10 柱径；五踩斗拱高 ≈ 0.2 柱高，出两拽架 ≈ 0.63 斗拱高）。
 */
export function frameDims(style = 'ming', colH = 5, o = {}) {
  const tang = style === 'tang';
  const D = o.colD ?? colH * (tang ? 0.105 : 0.085);
  const bracketH = o.bracketH ?? colH * (tang ? 0.4 : 0.2);
  const projK = tang ? 0.98 : 0.63;
  return {
    D,
    bracketH,
    proj: bracketH * projK,
    projK,
    plankH: tang ? D * 0.3 : D * 0.42, // 普拍枋 / 平板枋
    plankW: D * 1.1,
    fangH: tang ? D * 0.85 : D * 0.9, // 阑额 / 大额枋
    fang2H: tang ? 0 : D * 0.66, // 小额枋（明清）
    padH: tang ? 0 : D * 0.32, // 由额垫板
    fangT: D * 0.75,
    spacing: tang ? Infinity : bracketH * 1.25, // 平身科攒档（明清 11 斗口）
  };
}

// ───────────── 柱网环 ─────────────
/**
 * 矩形柱网环：xs（自西向东递增）、zs（自北向南递增，z 最大为正面）。返回 {sides, corners, poly}
 * sides[k] = {pts:[[x,z]...]（自外看从左到右，含两端角柱）, n:[nx,nz] 外法线, yaw, name}
 * 顺序：0 前(+Z) 1 右(+X) 2 后(-Z) 3 左(-X)
 */
export function rectRing(xs, zs) {
  const x0 = xs[0], x1 = xs[xs.length - 1], z0 = zs[0], z1 = zs[zs.length - 1];
  const sides = [
    { name: 'front', pts: xs.map((x) => [x, z1]), n: [0, 1] },
    { name: 'right', pts: [...zs].reverse().map((z) => [x1, z]), n: [1, 0] },
    { name: 'back', pts: [...xs].reverse().map((x) => [x, z0]), n: [0, -1] },
    { name: 'left', pts: zs.map((z) => [x0, z]), n: [-1, 0] },
  ];
  for (const s of sides) s.yaw = Math.atan2(s.n[0], s.n[1]);
  const corners = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  return { sides, corners, rect: true, w: x1 - x0, d: z1 - z0 };
}
/**
 * 正多边形柱网环：N 边（3~12），apothem = 中心到边的距离（= roof 的 w/2），第 0 边朝 +Z；perSide：每边间数。
 * N=0（圆亭）按 8 根柱处理。
 */
export function polyRing(N, apothem, perSide = 1) {
  const n = N || 8;
  const Rc = apothem / Math.cos(Math.PI / n);
  const sides = [];
  const corners = [];
  for (let i = 0; i < n; i++) {
    const phi = (2 * Math.PI * i) / n;
    const a0 = phi - Math.PI / n, a1 = phi + Math.PI / n;
    const c0 = [Math.sin(a0) * Rc, Math.cos(a0) * Rc], c1 = [Math.sin(a1) * Rc, Math.cos(a1) * Rc];
    corners.push(c0);
    const pts = [];
    for (let k = 0; k <= perSide; k++) pts.push([lerp(c0[0], c1[0], k / perSide), lerp(c0[1], c1[1], k / perSide)]);
    sides.push({ name: 'side' + i, pts, n: [Math.sin(phi), Math.cos(phi)], yaw: phi });
  }
  return { sides, corners, rect: false, w: apothem * 2, d: apothem * 2, N: n };
}
/** 环上所有柱位（去重） */
export function ringColumns(ring) {
  const out = [];
  for (const s of ring.sides) for (let k = 0; k < s.pts.length - 1; k++) out.push(s.pts[k]);
  return out;
}
/** 由各间尺寸得到柱中线坐标（居中） */
export function bayCoords(bays) {
  const tot = bays.reduce((a, b) => a + b, 0);
  const out = [-tot / 2];
  for (const b of bays) out.push(out[out.length - 1] + b);
  return out;
}
/** 各间尺寸：数组原样返回；数字 n → 明间最宽、向两侧递减（centerW / w / endW） */
export function bayList(n, w = 4.5, centerW = null, endW = null) {
  if (Array.isArray(n)) return n;
  const cw = centerW ?? w * 1.2;
  const ew = endW ?? w * 0.9;
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = Math.abs(i - (n - 1) / 2);
    if (n % 2 && k === 0) out.push(cw);
    else if (i === 0 || i === n - 1) out.push(n > 2 ? ew : w);
    else out.push(n % 2 ? w : k < 1 ? cw : w);
  }
  return out;
}
/** 环向外偏移 d 米后的角点（用于挑檐枋、平座边缘） */
export function offsetCorners(ring, d) {
  const n = ring.sides.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = ring.sides[(i - 1 + n) % n], B = ring.sides[i];
    const c = B.pts[0];
    // (P-c)·nA = d, (P-c)·nB = d
    const det = A.n[0] * B.n[1] - A.n[1] * B.n[0];
    const x = (d * B.n[1] - A.n[1] * d) / det, z = (A.n[0] * d - d * B.n[0]) / det;
    out.push([c[0] + x, c[1] + z]);
  }
  return out; // out[i] = 第 i 边起点处的偏移角点
}

// ───────────── 柱 ─────────────
/**
 * 柱：pts=[[x,z]...]，o: {y0, h, D, style, pal, taper(收分,默认 0.93), base(柱础,默认 true), color}
 */
export function columns(b, pts, o) {
  const style = o.style || b.style;
  const pal = o.pal || palette(style);
  const D = o.D, h = o.h, y0 = o.y0 ?? 0;
  const seg = b.detail >= 2 ? 14 : b.detail === 1 ? 8 : 6;
  const col = o.color ?? pal.col;
  const taper = o.taper ?? 0.93;
  const baseH = b.detail >= 1 && o.base !== false ? D * (style === 'tang' ? 0.3 : 0.22) : 0;
  for (const [x, z] of pts) {
    b.cyl('paint', x, y0 + baseH * 0.6, z, D / 2, (D / 2) * taper, h - baseH * 0.6, seg, col, { top: false });
    if (baseH > 0) {
      const sc = pal.colBase;
      if (style === 'tang') {
        // 覆盆柱础（莲瓣覆盆）
        b.box('stone', x - D * 0.95, y0 - 0.02, z - D * 0.95, x + D * 0.95, y0 + D * 0.08, z + D * 0.95, sc, { skip: 'bottom' });
        b.lathe('stone', [[D * 0.86, y0 + D * 0.08], [D * 0.84, y0 + D * 0.14], [D * 0.74, y0 + D * 0.22], [D * 0.6, y0 + D * 0.27], [D * 0.52, y0 + D * 0.3]], seg, sc, x, z);
      } else {
        // 古镜柱础
        b.box('stone', x - D * 0.8, y0 - 0.02, z - D * 0.8, x + D * 0.8, y0 + D * 0.04, z + D * 0.8, sc, { skip: 'bottom' });
        b.lathe('stone', [[D * 0.68, y0 + D * 0.04], [D * 0.66, y0 + D * 0.12], [D * 0.58, y0 + D * 0.2], [D * 0.52, y0 + D * 0.22]], seg, sc, x, z);
      }
    }
  }
}

// ───────────── 枋（额枋/平板枋/随梁枋） ─────────────
/**
 * 两平面点之间的水平枋：底高 y0、高 h、厚 t。o: {mat:'caihua'|'paint', row(彩画行 0~3), color, ext(两端外伸), top:false 不画顶面}
 * 彩画 UV：u 0..1 = 一间枋长（箍头在两端），v = 图集行。
 */
const CAI_ROWS = 4;
export function beam(b, p0, p1, y0, h, t, o = {}) {
  // o.inset：截面四周内缩（米）。环形枋子在转角十字相交时，相邻两边一粗一细（奇数边内缩数毫米），
  // 交叠段的顶/底/侧面不再共面闪烁（Z-fighting）。
  if (o.inset) {
    y0 += o.inset;
    h -= 2 * o.inset;
    t -= 2 * o.inset;
  }
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
  const L = Math.hypot(dx, dz) || 1;
  const ex = dx / L, ez = dz / L;
  const ext = o.ext ?? 0;
  const ax = p0[0] - ex * ext, az = p0[1] - ez * ext, bx = p1[0] + ex * ext, bz = p1[1] + ez * ext;
  const sx = ez * (t / 2), sz = -ex * (t / 2); // 横向（右手侧；保证各面朝外）
  const y1 = y0 + h;
  const mk = o.mat || 'paint';
  const col = o.color ?? 0xffffff;
  const A = [ax + sx, az + sz], B = [bx + sx, bz + sz], C = [bx - sx, bz - sz], D = [ax - sx, az - sz];
  if (mk === 'caihua') {
    const r = o.row ?? 0;
    const v0 = 1 - (r + 1) / CAI_ROWS + 0.004, v1 = 1 - r / CAI_ROWS - 0.004;
    const vm = (v0 + v1) / 2;
    const uu = o.uRepeat ?? 1;
    // 两个长立面
    b.quad(mk, [D[0], y0, D[1]], [C[0], y0, C[1]], [C[0], y1, C[1]], [D[0], y1, D[1]], col, [[0, v0], [uu, v0], [uu, v1], [0, v1]]);
    b.quad(mk, [B[0], y0, B[1]], [A[0], y0, A[1]], [A[0], y1, A[1]], [B[0], y1, B[1]], col, [[0, v0], [uu, v0], [uu, v1], [0, v1]]);
    const uvc = [[0.5, vm], [0.5, vm], [0.5, vm], [0.5, vm]];
    b.quad(mk, [D[0], y0, D[1]], [A[0], y0, A[1]], [B[0], y0, B[1]], [C[0], y0, C[1]], col, uvc); // 底
    if (o.top !== false) b.quad(mk, [A[0], y1, A[1]], [D[0], y1, D[1]], [C[0], y1, C[1]], [B[0], y1, B[1]], col, uvc);
    if (o.ends !== false) {
      b.quad(mk, [C[0], y0, C[1]], [B[0], y0, B[1]], [B[0], y1, B[1]], [C[0], y1, C[1]], col, uvc);
      b.quad(mk, [A[0], y0, A[1]], [D[0], y0, D[1]], [D[0], y1, D[1]], [A[0], y1, A[1]], col, uvc);
    }
  } else {
    b.quad(mk, [D[0], y0, D[1]], [C[0], y0, C[1]], [C[0], y1, C[1]], [D[0], y1, D[1]], col);
    b.quad(mk, [B[0], y0, B[1]], [A[0], y0, A[1]], [A[0], y1, A[1]], [B[0], y1, B[1]], col);
    b.quad(mk, [D[0], y0, D[1]], [A[0], y0, A[1]], [B[0], y0, B[1]], [C[0], y0, C[1]], col);
    if (o.top !== false) b.quad(mk, [A[0], y1, A[1]], [D[0], y1, D[1]], [C[0], y1, C[1]], [B[0], y1, B[1]], col);
    if (o.ends !== false) {
      b.quad(mk, [C[0], y0, C[1]], [B[0], y0, B[1]], [B[0], y1, B[1]], [C[0], y1, C[1]], col);
      b.quad(mk, [A[0], y0, A[1]], [D[0], y0, D[1]], [D[0], y1, D[1]], [A[0], y1, A[1]], col);
    }
  }
}

/**
 * 檐柱头的枋子组合（沿环一周）：明清 = 大额枋 + 由额垫板 + 小额枋 + 平板枋；唐 = 阑额（七朱八白）+ 普拍枋。
 * colTop：柱顶高。返回平板枋顶（= 斗拱底）高度。o: {style, pal, dims, detail, rich(大额枋用金龙/金线大点金), plank:true}
 */
export function lintelRing(b, ring, colTop, o) {
  const style = o.style || b.style;
  const pal = o.pal || palette(style);
  const F = o.dims;
  const tang = style === 'tang';
  const detail = b.detail;
  const plank = o.plank !== false;
  ring.sides.forEach((s, si) => {
    const inset = (si % 2) * 0.008; // 转角相交：奇数边略细，避免与相邻边枋子共面
    for (let k = 0; k < s.pts.length - 1; k++) {
      const p0 = s.pts[k], p1 = s.pts[k + 1];
      if (detail === 0) {
        // 远景：额枋与平板枋并成一条（高度含平板枋，保证各级 LOD 的斗拱/屋面/宝顶高度一致，切换时不跳）
        beam(b, p0, p1, colTop - F.fangH, F.fangH + (plank ? F.plankH : 0), F.fangT, { mat: 'paint', color: tang ? pal.col : 0x2f5f78, top: false, inset });
        continue;
      }
      if (tang) {
        beam(b, p0, p1, colTop - F.fangH, F.fangH, F.fangT, { mat: 'caihua', row: 2, top: false, inset });
      } else {
        const y1 = colTop - F.fangH;
        beam(b, p0, p1, y1, F.fangH, F.fangT, { mat: 'caihua', row: o.rich ? 1 : 0, top: false, inset });
        beam(b, p0, p1, y1 - F.padH, F.padH, F.fangT * 0.7, { mat: 'paint', color: pal.panel, top: false, ends: false, inset });
        beam(b, p0, p1, y1 - F.padH - F.fang2H, F.fang2H, F.fangT * 0.9, { mat: 'caihua', row: 0, top: false, inset });
      }
    }
  });
  if (!plank) return colTop;
  if (detail === 0) return colTop + F.plankH;
  // 平板枋 / 普拍枋：沿柱顶一周（角部出头）
  const n = ring.sides.length;
  for (let i = 0; i < n; i++) {
    const s = ring.sides[i];
    const p0 = s.pts[0], p1 = s.pts[s.pts.length - 1];
    beam(b, p0, p1, colTop, F.plankH, F.plankW, { mat: tang ? 'paint' : 'caihua', row: 3, color: tang ? pal.gong : 0xffffff, ext: F.plankW * 0.6, uRepeat: Math.max(1, s.pts.length - 1), inset: (i % 2) * 0.008 });
  }
  return colTop + F.plankH;
}

// ───────────── 斗拱原型（单位高 1） ─────────────
// 原型坐标：x 沿檐（面阔方向），y 向上（0 = 平板枋顶），z 朝外；实际放置时整体缩放 = 斗拱高。
function cup(pb, x, y, z, w, h, col, dw = w) {
  pb.frustum('paint', x, z, y, w * 0.7, dw * 0.7, y + h * 0.42, w, dw, col, { noTop: true });
  pb.box('paint', x - w / 2, y + h * 0.42, z - dw / 2, x + w / 2, y + h, z + dw / 2, col, { skip: 'bottom' });
}
function gongPoly(L, h) {
  const a = L / 2, c = Math.min(h * 1.1, L * 0.2);
  return [[-a + c, 0], [a - c, 0], [a - c * 0.5, h * 0.1], [a - c * 0.15, h * 0.3], [a, h * 0.55], [a, h], [-a, h], [-a, h * 0.55], [-a + c * 0.15, h * 0.3], [-a + c * 0.5, h * 0.1]];
}
/** 横拱（沿 x）：中心 (cx, y0, cz)，长 L、高 h、厚 t */
function gong(pb, cx, y0, cz, L, h, t, col) {
  pb.prism('paint', gongPoly(L, h).map(([p, q]) => [p + cx, q + y0]), 'z', cz - t / 2, cz + t / 2, col);
}
/** 出跳华拱/翘（沿 z）：z0 → z1（外端卷杀） */
function qiao(pb, z0, z1, y0, h, t, col) {
  const c = Math.min(h * 1.1, (z1 - z0) * 0.3);
  const poly = [[z0, y0], [z1 - c, y0], [z1 - c * 0.5, y0 + h * 0.1], [z1 - c * 0.15, y0 + h * 0.3], [z1, y0 + h * 0.55], [z1, y0 + h], [z0, y0 + h]];
  pb.prism('paint', poly, 'x', -t / 2, t / 2, col);
}
/** 明清假昂：水平段 + 下垂昂嘴 */
function angMing(pb, z0, z1, y0, h, t, col, tipCol) {
  const poly = [[z0, y0], [z1 - h * 0.9, y0], [z1 + h * 0.55, y0 - h * 0.62], [z1 + h * 0.62, y0 - h * 0.46], [z1 - h * 0.05, y0 + h * 0.55], [z1 - h * 0.05, y0 + h], [z0, y0 + h]];
  pb.prism('paint', poly, 'x', -t / 2, t / 2, col, { capColor: col });
  if (tipCol != null) pb.prism('paint', [[z1 + h * 0.3, y0 - h * 0.44], [z1 + h * 0.55, y0 - h * 0.62], [z1 + h * 0.62, y0 - h * 0.46], [z1 + h * 0.36, y0 - h * 0.2]], 'x', -t * 0.52, t * 0.52, tipCol);
}
/** 唐下昂：自内高处斜下至外端，批竹昂嘴 */
function angTang(pb, zi, yi, zt, yt, h, t, col) {
  const vx = zt - zi, vy = yt - yi;
  const l = Math.hypot(vx, vy);
  const ux = -vy / l, uy = vx / l; // 上法向
  const tx = vx / l, ty = vy / l;
  const A = [zi, yi], B = [zt, yt];
  const C = [zt - tx * h * 1.7 + ux * h, yt - ty * h * 1.7 + uy * h];
  const D = [zi + ux * h, yi + uy * h];
  pb.prism('paint', [A, B, C, D], 'x', -t / 2, t / 2, col);
}
/** 蚂蚱头 / 耍头 */
function shuatou(pb, z0, z1, y0, h, t, col, tang) {
  const poly = tang
    ? [[z0, y0], [z1 - h * 0.7, y0], [z1, y0 + h * 0.6], [z1, y0 + h], [z0, y0 + h]]
    : [[z0, y0], [z1 - h * 0.45, y0], [z1, y0 + h * 0.42], [z1 - h * 0.18, y0 + h * 0.62], [z1, y0 + h * 0.82], [z1 - h * 0.08, y0 + h], [z0, y0 + h]];
  pb.prism('paint', poly, 'x', -t / 2, t / 2, col);
}

/**
 * 斗拱原型工厂。kind: 'col'（柱头科）| 'mid'（平身科/补间）| 'corner'（角科斜出部分）| 'pingzuo'（平座斗拱，矮）
 * variant：明清青绿相间（0/1 互换斗与拱的颜色）。返回 factory(pb)。
 */
function dougongFactory(style, kind, pal, variant = 0) {
  return (pb) => {
    const d2 = pb.detail >= 2;
    const tang = style === 'tang';
    const dou = variant ? pal.gong : pal.dou;
    const gcol = variant ? pal.dou : pal.gong;
    const angC = pal.ang;
    const zs = kind === 'corner' ? 1.414 : 1; // 角科：出跳沿对角线放大
    if (!d2) {
      // 中景：三层叠涩
      const P = tang ? 0.98 : 0.63;
      pb.box('paint', -0.16, 0, -0.16, 0.16, 0.18, 0.16, dou);
      if (kind !== 'corner') pb.box('paint', -0.42, 0.14, -0.06, 0.42, 0.52, 0.06, gcol);
      pb.box('paint', -0.06, 0.14, -0.2, 0.06, 0.32, P * 0.45 * zs, gcol);
      pb.box('paint', -0.065, 0.32, -0.2, 0.065, 0.55, P * 0.8 * zs, gcol);
      pb.box('paint', -0.07, 0.55, -0.2, 0.07, 0.8, (P + 0.08) * zs, gcol);
      return;
    }
    if (tang) {
      // 唐：双抄双下昂（七铺作简化）。材高 0.16、厚 0.11；栌斗 0.36×0.2
      const h = 0.16, t = 0.11;
      if (kind === 'pingzuo') {
        cup(pb, 0, 0, 0, 0.34, 0.2, dou);
        gong(pb, 0, 0.12, 0, 0.62, h, t, gcol);
        qiao(pb, -0.2, 0.36, 0.12, h, t, gcol);
        cup(pb, 0, 0.28, 0.3, 0.18, 0.1, dou);
        qiao(pb, -0.2, 0.62, 0.36, h, t, gcol);
        gong(pb, 0, 0.36, 0.56, 0.7, h, t, gcol);
        for (const x of [-0.3, 0.3]) cup(pb, x, 0.52, 0.56, 0.16, 0.09, dou);
        return;
      }
      if (kind !== 'corner') {
        cup(pb, 0, 0, 0, kind === 'mid' ? 0.26 : 0.36, 0.2, dou);
        gong(pb, 0, 0.12, 0, 0.66, h, t, gcol); // 泥道拱
        for (const x of [-0.29, 0.29]) cup(pb, x, 0.28, 0, 0.16, 0.08, dou);
        gong(pb, 0, 0.36, 0, 1.0, h, t, gcol); // 泥道慢拱
        for (const x of [-0.46, 0.46]) cup(pb, x, 0.52, 0, 0.16, 0.08, dou);
      } else cup(pb, 0, 0, 0, 0.36, 0.2, dou);
      qiao(pb, -0.25, 0.34 * zs, 0.12, h, t, gcol); // 第一跳华拱
      cup(pb, 0, 0.28, 0.3 * zs, 0.18, 0.1, dou); // 交互斗
      qiao(pb, -0.25, 0.64 * zs, 0.36, h, t, gcol); // 第二跳华拱
      cup(pb, 0, 0.52, 0.6 * zs, 0.18, 0.1, dou);
      if (kind === 'mid') {
        gong(pb, 0, 0.62, 0.6, 0.72, h, t, gcol); // 令拱
        for (const x of [-0.31, 0.31]) cup(pb, x, 0.78, 0.6, 0.16, 0.08, dou);
        shuatou(pb, -0.1, 0.78, 0.62, h, t, gcol, true);
        return;
      }
      angTang(pb, -0.35, 0.98, 0.98 * zs, 0.5, h * 1.05, t, angC); // 下昂（昂身）
      cup(pb, 0, 0.7, 0.96 * zs - 0.04, 0.17, 0.09, dou);
      if (kind !== 'corner') {
        gong(pb, 0, 0.66, 0.96, 0.76, h, t, gcol); // 令拱
        for (const x of [-0.33, 0.33]) cup(pb, x, 0.82, 0.96, 0.16, 0.08, dou);
      }
      shuatou(pb, -0.2, 1.08 * zs, 0.72, h * 0.9, t, gcol, true); // 耍头
      return;
    }
    // 明清五踩重昂：斗口 d≈0.105；拽架 e=0.315；材高 0.147
    const h = 0.147, t = 0.105, e = 0.315;
    if (kind === 'pingzuo') {
      cup(pb, 0, 0, 0, 0.3, 0.2, dou);
      gong(pb, 0, 0.13, 0, 0.62, h, t, gcol);
      qiao(pb, -0.15, e + 0.02, 0.13, h, t, gcol);
      cup(pb, 0, 0.277, e, 0.18, 0.1, dou);
      qiao(pb, -0.15, 2 * e, 0.34, h, t, gcol);
      gong(pb, 0, 0.34, 2 * e - 0.04, 0.72, h, t, gcol);
      for (const x of [-0.3, 0.3]) cup(pb, x, 0.487, 2 * e - 0.04, 0.14, 0.09, dou);
      return;
    }
    if (kind !== 'corner') {
      cup(pb, 0, 0, 0, kind === 'col' ? 0.4 : 0.315, 0.21, dou); // 坐斗
      gong(pb, 0, 0.13, 0, 0.65, h, t * 1.2, gcol); // 正心瓜拱
      for (const x of [-0.29, 0.29]) cup(pb, x, 0.277, 0, 0.15, 0.09, dou);
      gong(pb, 0, 0.34, 0, 0.97, h, t * 1.2, gcol); // 正心万拱
      for (const x of [-0.45, 0.45]) cup(pb, x, 0.487, 0, 0.15, 0.09, dou);
      gong(pb, 0, 0.34, e, 0.65, h, t, gcol); // 外拽瓜拱
      for (const x of [-0.29, 0.29]) cup(pb, x, 0.487, e, 0.15, 0.09, dou);
      gong(pb, 0, 0.55, e, 0.97, h, t, gcol); // 外拽万拱
      gong(pb, 0, 0.55, 2 * e, 0.76, h, t, gcol); // 厢拱
      for (const x of [-0.34, 0.34]) cup(pb, x, 0.697, 2 * e, 0.15, 0.09, dou);
    } else cup(pb, 0, 0, 0, 0.4, 0.21, dou);
    qiao(pb, -0.2, e * zs + 0.02, 0.13, h, t * (kind === 'col' ? 1.6 : 1), gcol); // 头翘
    cup(pb, 0, 0.277, e * zs, 0.19, 0.1, dou); // 十八斗
    angMing(pb, -0.2, 2 * e * zs, 0.34, h, t * (kind === 'col' ? 1.8 : 1), angC, pal.armEnd); // 昂（假昂）
    cup(pb, 0, 0.487, 2 * e * zs - 0.02, 0.19, 0.1, dou);
    shuatou(pb, -0.2, (2 * e + 0.28) * zs, 0.55, h, t * (kind === 'col' ? 2 : 1), gcol, false); // 蚂蚱头
    pb.box('paint', -t / 2, 0.76, -0.2, t / 2, 0.93, (2 * e + 0.06) * zs, gcol); // 撑头木
  };
}
function palKey(pal) {
  return [pal.dou, pal.gong, pal.ang, pal.armEnd].join(',');
}

/**
 * 斗拱层：沿环 ring 布置柱头科、平身科（补间）、角科，并做栱眼壁、正心枋与挑檐枋（橑檐枋）。
 * o: {y（平板枋顶）, H（斗拱高）, style, pal, perBay（每间补间数，默认唐 1、明清按攒档）, kind:'eave'|'pingzuo',
 *     panel:true（栱眼壁）, outer:true（挑檐枋）, dims}
 * 返回 {proj, topY, bearY（挑檐枋顶）, tip:[[x,z]...] 外拽角点}
 */
export function bracketRing(b, ring, o) {
  const style = o.style || b.style;
  const pal = o.pal || palette(style);
  const H = o.H;
  const tang = style === 'tang';
  const y = o.y;
  const pz = o.kind === 'pingzuo';
  const projK = pz ? (tang ? 0.62 : 0.63) : tang ? 0.98 : 0.63;
  const proj = H * projK;
  const out = { proj, topY: y + H, bearY: y + H * (tang ? 0.93 : 0.93), tip: offsetCorners(ring, proj) };
  if (b.detail === 0) {
    // 远景：整圈一条深色斗拱带
    const loop = offsetCorners(ring, proj * 0.5);
    const n = loop.length;
    for (let i = 0; i < n; i++) beam(b, loop[i], loop[(i + 1) % n], y, H * 0.9, proj, { mat: 'paint', color: tang ? pal.gong : 0x2d5a5a, ends: false, inset: (i % 2) * 0.008 });
    return out;
  }
  const kinds = pz ? ['pingzuo', 'pingzuo'] : ['col', 'mid'];
  const nSides = ring.sides.length;
  let cnt = 0;
  const place = (x, z, yaw, kind, variant) => {
    b.push(x, y, z, yaw, H);
    b.proto(`dg|${style}|${kind}|${variant}|${palKey(pal)}`, dougongFactory(style, kind, pal, variant));
    b.pop();
    cnt++;
  };
  for (let si = 0; si < nSides; si++) {
    const s = ring.sides[si];
    const pts = s.pts;
    for (let k = 0; k < pts.length; k++) {
      // 柱头科（含两端角柱：两侧各放一组，角部另放斜出角科）
      place(pts[k][0], pts[k][1], s.yaw, kinds[0], 0);
      if (k === pts.length - 1) continue;
      const p0 = pts[k], p1 = pts[k + 1];
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      let n = o.perBay ?? (tang ? (L > H * 2.2 ? 1 : 0) : Math.max(0, Math.round(L / (H * 1.25)) - 1));
      if (pz && tang) n = Math.max(n, 1);
      for (let j = 1; j <= n; j++) {
        const t = j / (n + 1);
        place(lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t), s.yaw, kinds[1], tang ? 0 : j % 2);
      }
    }
  }
  // 角科（斜出）
  if (!pz)
    for (let i = 0; i < nSides; i++) {
      const A = ring.sides[(i - 1 + nSides) % nSides], B = ring.sides[i];
      const c = B.pts[0];
      const bx = A.n[0] + B.n[0], bz = A.n[1] + B.n[1];
      const k = 1 / Math.max(0.3, Math.hypot(bx, bz) / 1.414);
      b.push(c[0], y, c[1], Math.atan2(bx, bz), H);
      // 非直角（多边形）时角科出跳按夹角缩放
      if (Math.abs(k - 1) > 0.05) b.push(new THREE.Matrix4().makeScale(1, 1, k));
      b.proto(`dg|${style}|corner|0|${palKey(pal)}`, dougongFactory(style, 'corner', pal, 0));
      if (Math.abs(k - 1) > 0.05) b.pop();
      b.pop();
    }
  // 栱眼壁 + 正心枋（柱中线）
  const tipC = out.tip;
  for (let i = 0; i < nSides; i++) {
    const s = ring.sides[i];
    const p0 = s.pts[0], p1 = s.pts[s.pts.length - 1];
    const inset = (i % 2) * 0.008; // 转角十字相交处奇数边略细，防共面
    if (o.panel !== false) beam(b, p0, p1, y, H * (tang ? 0.52 : 0.6), H * 0.07, { mat: tang ? 'plaster' : 'paint', color: pal.panel, ends: false, top: false, inset });
    beam(b, p0, p1, y + H * (tang ? 0.52 : 0.6), H * (tang ? 0.44 : 0.36), H * 0.12, { mat: 'paint', color: tang ? pal.gong : pal.dou, ext: H * 0.06, ends: false, inset });
    // 挑檐枋 / 橑檐枋（外拽，角部相交）
    if (o.outer !== false) {
      const q0 = tipC[i], q1 = tipC[(i + 1) % nSides];
      beam(b, q0, q1, y + H * (tang ? 0.8 : 0.76), H * (tang ? 0.16 : 0.18), H * 0.12, { mat: 'paint', color: pal.gong, ext: H * 0.08, inset });
    }
  }
  out.count = cnt;
  return out;
}

// ───────────── 雀替 ─────────────
/**
 * 雀替：在柱与额枋交角处（立面局部系），x 为柱中心，yTop 为额枋底，向 dir(+1 右/-1 左) 伸出 len，高 h。
 * o: {color, gold, t(厚)}
 */
export function queti(b, x, yTop, z, dir, len, h, o = {}) {
  const t = o.t ?? 0.12;
  const col = o.color ?? 0x2f6a5a;
  const pts = [[0, 0], [len, 0], [len * 0.93, -h * 0.16], [len * 0.72, -h * 0.26], [len * 0.52, -h * 0.34], [len * 0.36, -h * 0.5], [len * 0.2, -h * 0.72], [len * 0.08, -h * 0.9], [0, -h]];
  const poly = pts.map(([p, q]) => [x + dir * p, yTop + q]);
  if (dir < 0) poly.reverse();
  b.prism('paint', poly, 'z', z - t / 2, z + t / 2, col, { capColor: col });
  if (b.detail >= 2 && o.gold !== false) {
    // 金色卷草（内嵌浅浮雕）
    const inner = pts.slice(1, 8).map(([p, q]) => [x + dir * (len * 0.12 + p * 0.72), yTop - h * 0.1 + q * 0.72]);
    if (dir < 0) inner.reverse();
    b.prism('paint', inner, 'z', z - t / 2 - 0.012, z + t / 2 + 0.012, o.gold ?? 0xb88a3a);
  }
}
