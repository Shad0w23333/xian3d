// 中式古建构件库 —— 屋顶生成器
// 统一“多边形坡面”算法：每条檐边生成一个坡面（s = 自柱中线向内的水平距离，a = 沿檐方向坐标），
// 坡面高度 H(s) 为“举折”下凹曲线（檐部平缓、近脊陡峻）；翼角处按离角距离 q 施加起翘（抬高）与冲出（平面外扩），
// 相邻坡面在戗脊/垂脊线上精确闭合。庑殿、歇山、攒尖（四/六/八角、圆）、悬山/硬山、卷棚、重檐下檐/腰檐（band）都由此生成。
// 近景（detail=2）：几何筒瓦垄 + 瓦当滴水 + 檐椽飞椽 + 角梁套兽 + 正脊垂脊戗脊 + 鸱吻/鸱尾 + 仙人走兽；
// 中景（1）：瓦垄画进法线贴图；远景（0）：粗网格只留轮廓。
import * as THREE from 'three';
import { lin, clamp, lerp, smooth, STYLES, roofColors, palette } from './chinese-core.js';

// ───────────── 举折曲线 ─────────────
function makeProfile(R, pitch, k0f, rolled) {
  const p = 1.6;
  const k0 = pitch * k0f;
  const k1 = k0 + (pitch - k0) * (p + 1);
  const N = 96;
  const H = new Float32Array(N + 1), K = new Float32Array(N + 1);
  let h = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let k = k0 + (k1 - k0) * Math.pow(t, p);
    if (rolled) k *= 1 - 0.97 * smooth(0.78, 1.0, t);
    K[i] = k;
    if (i) h += ((K[i - 1] + K[i]) / 2) * (R / N);
    H[i] = h;
  }
  return { R, k0, k1, kE: k0 * 0.9, H, K, N };
}
function hAt(P, s, ov) {
  if (s >= 0) {
    const f = (s / P.R) * P.N;
    if (f >= P.N) return P.H[P.N] + (s - P.R) * P.K[P.N];
    const i = Math.floor(f), t = f - i;
    return P.H[i] * (1 - t) + P.H[i + 1] * t;
  }
  // 出檐段：坡度 kE，并向檐口微微上扬（飞椽）
  return P.kE * s + 0.22 * P.kE * (s * s) / Math.max(ov, 0.1);
}

/**
 * 屋顶几何核心。所有坐标为 builder 局部坐标（屋顶平面中心为原点，y 为绝对高度）。
 */
export class RoofGeom {
  constructor(o) {
    this.o = o;
    this.y = o.y;
    this.ov = o.ov;
    this.edges = [];
  }
  sOf(i, x, z) {
    const E = this.edges[i];
    return (x - E.o[0]) * E.n[0] + (z - E.o[1]) * E.n[1];
  }
  /** 坡面 i 上 (a, s) 的变形后顶面坐标 → out[3] */
  point(i, a, s, out = [0, 0, 0]) {
    const E = this.edges[i];
    let x = E.o[0] + E.e[0] * a + E.n[0] * s;
    let z = E.o[1] + E.e[1] * a + E.n[1] * s;
    let y = this.y + hAt(this.prof, s, this.ov);
    let best = Infinity, j = -1;
    if (E.nbL >= 0) {
      const sl = this.sOf(E.nbL, x, z);
      if (sl < best) { best = sl; j = E.nbL; }
    }
    if (E.nbR >= 0) {
      const sr = this.sOf(E.nbR, x, z);
      if (sr < best) { best = sr; j = E.nbR; }
    }
    if (j >= 0) {
      const q = Math.max(s, best) + this.ov;
      const Lz = this.Lz;
      if (q < Lz) {
        const f = Math.pow(1 - q / Lz, 2.1);
        const N2 = this.edges[j].n;
        let bx = -(E.n[0] + N2[0]), bz = -(E.n[1] + N2[1]);
        const bl = Math.hypot(bx, bz) || 1;
        bx /= bl; bz /= bl;
        y += this.lift * f;
        x += bx * this.flare * f;
        z += bz * this.flare * f;
      }
      if (this.sheng > 0) {
        const t2 = q / (E.half + this.ov);
        if (t2 < 1) y += this.sheng * (1 - t2) * (1 - t2);
      }
    }
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  }
  /** 数值法线（朝上） */
  normal(i, a, s, out = [0, 1, 0]) {
    const e = 0.04;
    const pa = this.point(i, a + e, s, [0, 0, 0]), pb = this.point(i, a - e, s, [0, 0, 0]);
    const sa = this.point(i, a, s + e, [0, 0, 0]), sb = this.point(i, a, s - e, [0, 0, 0]);
    const dax = pa[0] - pb[0], day = pa[1] - pb[1], daz = pa[2] - pb[2];
    const dsx = sa[0] - sb[0], dsy = sa[1] - sb[1], dsz = sa[2] - sb[2];
    let nx = day * dsz - daz * dsy, ny = daz * dsx - dax * dsz, nz = dax * dsy - day * dsx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  }
  /** 两坡面交线（戗脊/垂脊）上 s=t 的平面点 */
  hipPlan(i, j, t) {
    const A = this.edges[i], B = this.edges[j];
    // 解 (P-oA)·nA = t, (P-oB)·nB = t
    const c1 = t + A.o[0] * A.n[0] + A.o[1] * A.n[1];
    const c2 = t + B.o[0] * B.n[0] + B.o[1] * B.n[1];
    const det = A.n[0] * B.n[1] - A.n[1] * B.n[0];
    const x = (c1 * B.n[1] - A.n[1] * c2) / det;
    const z = (A.n[0] * c2 - c1 * B.n[0]) / det;
    return [x, z];
  }
  hipPoint(i, j, t) {
    const [x, z] = this.hipPlan(i, j, t);
    const E = this.edges[i];
    const a = (x - E.o[0]) * E.e[0] + (z - E.o[1]) * E.e[1];
    return this.point(i, a, t, [0, 0, 0]);
  }
  aOf(i, x, z) {
    const E = this.edges[i];
    return (x - E.o[0]) * E.e[0] + (z - E.o[1]) * E.e[1];
  }
}

// ───────────── 预设 ─────────────
function defaults(b, o) {
  const style = o.style || b.style || 'ming';
  const S = STYLES[style] || STYLES.ming;
  const pal = o.pal || palette(style);
  const rc = roofColors(o.color);
  return { style, S, pal, rc };
}

/**
 * 屋顶。
 * @param {ArchBuilder} b
 * @param {object} o
 *   type: 'wudian'庑殿 | 'xieshan'歇山 | 'zanjian'攒尖 | 'xuanshan'悬山 | 'yingshan'硬山 | 'juanpeng'卷棚 | 'band'重檐下檐/腰檐
 *   w, d：柱中线平面尺寸（米）；攒尖/多边形 band 用 sides(3~8，0=圆) + w（对边距=2×内切圆半径；圆形为直径）
 *   y：柱中线处屋面（瓦面）高度；overhang：自柱中线出檐（水平）；pitch：平均举高比；
 *   top：band 专用，坡面上缘距柱中线的水平距离；gableInset：歇山收山（山花距侧檐柱中线）；gableOverhang：出际
 *   color：'gray'|'darkgray'|'green'|'yellow'|'blue'|'black'|{tile,tube,ridge,glazed}
 *   style：'tang'|'ming'；pal：palette() 结果；ornament：'chiwei'|'wen'|'none'；beasts：走兽数（明清，默认按规模）
 *   lift/flare/sheng：起翘/冲出/生起（米，默认按风格×出檐）；tileW：瓦垄宽；thick：屋面厚（瓦+望板+椽）
 *   underside：'eave'（只做出檐段望板）|'full'（亭子等敞开构筑，整个屋内可见）；rolled：卷棚
 *   finial：攒尖宝顶 {h, gold:true}；ridgeH：正脊高；noRidge：不做正脊
 * @returns {object} info {ridgeY, topY, eaveY, eaveLines:[[x,y,z]...], ridgeLines, bandTopY, geom}
 */
export function roof(b, o) {
  const { style, S, pal, rc } = defaults(b, o);
  const detail = b.detail;
  const type = o.type || 'xieshan';
  const sides = o.sides ?? 4;
  const round = (type === 'zanjian' || type === 'band') && sides === 0;
  const w = o.w, d = o.d ?? o.w;
  const ov = o.overhang ?? Math.max(0.8, Math.min(w, d) * 0.12);
  const pitch = o.pitch ?? S.pitch;
  const rolled = !!o.rolled || type === 'juanpeng';
  const G = new RoofGeom({ y: o.y, ov });
  const X = w / 2, Z = d / 2;
  let polyA = 0;
  const E = G.edges;
  const gableOv = o.gableOverhang ?? Math.max(0.5, ov * 0.45);
  let xG = 0, sG = 0; // 歇山山花位置
  let run;
  const addEdge = (ox, oz, ex, ez, nx, nz, half, aL, aR, sTop, extra = {}) => {
    E.push({ o: [ox, oz], e: [ex, ez], n: [nx, nz], half, aL, aR, sTop, nbL: -1, nbR: -1, ...extra });
  };
  if (round) {
    polyA = w / 2;
    run = type === 'band' ? o.top : polyA;
  } else if (type === 'zanjian' || (type === 'band' && sides !== 4)) {
    const N = sides;
    polyA = w / 2;
    const tn = Math.tan(Math.PI / N);
    const sTop = type === 'band' ? o.top : polyA * 0.985;
    for (let i = 0; i < N; i++) {
      const phi = (2 * Math.PI * i) / N;
      const dx = Math.sin(phi), dz = Math.cos(phi); // 外法线，i=0 朝 +Z
      const f = (s) => Math.max(0, (polyA - s) * tn);
      addEdge(dx * polyA, dz * polyA, dz, -dx, -dx, -dz, polyA * tn, f, f, sTop);
    }
    for (let i = 0; i < N; i++) {
      E[i].nbR = (i + 1) % N;
      E[i].nbL = (i - 1 + N) % N;
    }
    run = type === 'band' ? o.top : polyA;
  } else {
    // 矩形：0 前(+Z) 1 右(+X) 2 后(-Z) 3 左(-X)；e 沿檐（从左到右看），n 向内
    const hipF = (half) => (s) => half - s;
    if (type === 'wudian' || type === 'band' || type === 'zanjian') {
      const sTop = type === 'band' ? o.top : Math.min(X, Z);
      addEdge(0, Z, 1, 0, 0, -1, X, hipF(X), hipF(X), sTop);
      addEdge(X, 0, 0, -1, -1, 0, Z, hipF(Z), hipF(Z), sTop);
      addEdge(0, -Z, -1, 0, 0, 1, X, hipF(X), hipF(X), sTop);
      addEdge(-X, 0, 0, 1, 1, 0, Z, hipF(Z), hipF(Z), sTop);
      for (let i = 0; i < 4; i++) {
        E[i].nbR = (i + 1) % 4;
        E[i].nbL = (i + 3) % 4;
      }
      run = type === 'band' ? o.top : Math.min(X, Z);
    } else if (type === 'xieshan') {
      sG = o.gableInset ?? Math.min(Z * (style === 'tang' ? 0.46 : 0.4), X * 0.6);
      xG = X - sG;
      const fa = (s) => Math.max(X - s, xG + gableOv);
      addEdge(0, Z, 1, 0, 0, -1, X, fa, fa, Z);
      addEdge(X, 0, 0, -1, -1, 0, Z, hipF(Z), hipF(Z), sG, { side: true });
      addEdge(0, -Z, -1, 0, 0, 1, X, fa, fa, Z);
      addEdge(-X, 0, 0, 1, 1, 0, Z, hipF(Z), hipF(Z), sG, { side: true });
      for (let i = 0; i < 4; i++) {
        E[i].nbR = (i + 1) % 4;
        E[i].nbL = (i + 3) % 4;
      }
      run = Z;
    } else {
      // 悬山/硬山/卷棚：两坡
      const g = type === 'yingshan' ? 0.32 : gableOv;
      const fa = () => X + g;
      addEdge(0, Z, 1, 0, 0, -1, X, fa, fa, Z, { gable: true });
      addEdge(0, -Z, -1, 0, 0, 1, X, fa, fa, Z, { gable: true });
      run = Z;
    }
  }
  G.prof = makeProfile(run, type === 'band' ? (o.pitch ?? pitch * 0.8) : pitch, S.k0f, rolled);
  const gableType = !round && E.length === 2;
  const halfMin = round ? polyA : Math.min(...E.map((e) => e.half));
  G.lift = gableType || round ? 0 : o.lift ?? ov * S.lift;
  G.flare = gableType || round ? 0 : o.flare ?? ov * S.flare;
  G.sheng = gableType || round ? 0 : o.sheng ?? S.sheng * clamp(w / 12, 0.4, 1.6);
  G.Lz = Math.min(o.cornerZone ?? ov + Math.min(halfMin * 0.55, 1.2 + ov * 0.9), 0.95 * (halfMin + ov));
  const thick = o.thick ?? clamp(0.18 + ov * 0.07, 0.2, 0.5);
  const tileW = o.tileW ?? clamp(0.2 + (w + d) * 0.0035, 0.22, 0.36);
  const courseL = tileW * 0.95;
  const glazed = rc.glazed;
  const mTop = detail >= 2 ? (glazed ? 'tileGlazed' : 'tile') : glazed ? 'tileFlatGlazed' : 'tileFlat';
  const mRidge = glazed ? 'ridgeGlazed' : 'ridge';
  const info = { geom: G, eaveLines: [], ridgeLines: [], thick, ov, tileW };

  if (round) {
    roundRoof(b, G, o, { polyA, run, ov, thick, tileW, courseL, mTop, mRidge, rc, pal, detail, type, info });
    return info;
  }

  // v 坐标（沿坡弧长 / 8 行瓦）
  const arc = (s) => (s + ov) * Math.sqrt(1 + G.prof.k0 * G.prof.k0) / (8 * courseL);
  const P = [0, 0, 0], Nn = [0, 1, 0];

  // ——— 坡面（顶面 + 望板底面 + 连檐） ———
  const undersideIn = o.underside === 'full' ? Infinity : 0.9;
  for (let i = 0; i < E.length; i++) {
    const Ed = E[i];
    const sTop = Ed.sTop;
    const span = sTop + ov;
    const rows = detail >= 2 ? clamp(Math.ceil(span / 0.6), 8, 24) : detail === 1 ? clamp(Math.ceil(span / 1.5), 5, 10) : clamp(Math.ceil(span / 3), 3, 4);
    const len = Ed.aL(-ov) + Ed.aR(-ov);
    const cols = detail >= 2 ? clamp(Math.ceil(len / 0.9) + 8, 12, 72) : detail === 1 ? clamp(Math.ceil(len / 2.2) + 6, 8, 30) : clamp(Math.ceil(len / 6) + 3, 4, 8);
    const sAt = (j) => -ov + span * Math.pow(j / rows, 1.2);
    const tAt = (k) => {
      const t = k / cols;
      return 0.45 * t + 0.55 * (0.5 - 0.5 * Math.cos(Math.PI * t));
    };
    const bk = b.bucket(mTop);
    const cl = lin(rc.tile);
    const base = bk.count;
    for (let j = 0; j <= rows; j++) {
      const s = sAt(j);
      const aL = Ed.aL(s), aR = Ed.aR(s);
      for (let k = 0; k <= cols; k++) {
        const a = -aL + (aL + aR) * tAt(k);
        G.point(i, a, s, P);
        G.normal(i, a, s, Nn);
        b.vtx(bk, P[0], P[1], P[2], Nn[0], Nn[1], Nn[2], a / (2 * tileW), arc(s), cl);
      }
    }
    for (let j = 0; j < rows; j++)
      for (let k = 0; k < cols; k++) {
        const v0 = base + j * (cols + 1) + k;
        b.quadIdx(bk, v0, v0 + 1, v0 + cols + 2, v0 + cols + 1);
      }
    // 底面（望板，出檐段）
    const sUnder = Math.min(sTop, undersideIn);
    if (sUnder > -ov + 0.05) {
      const ub = b.bucket('paint');
      const uc = lin(pal.soffit);
      const urows = Math.max(2, Math.ceil(rows * (sUnder + ov) / span));
      const ubase = ub.count;
      for (let j = 0; j <= urows; j++) {
        const s = -ov + (sUnder + ov) * Math.pow(j / urows, 1.2);
        const aL = Ed.aL(s), aR = Ed.aR(s);
        for (let k = 0; k <= cols; k++) {
          const a = -aL + (aL + aR) * tAt(k);
          G.point(i, a, s, P);
          G.normal(i, a, s, Nn);
          b.vtx(ub, P[0], P[1] - thick, P[2], -Nn[0], -Nn[1], -Nn[2], a, s, uc);
        }
      }
      for (let j = 0; j < urows; j++)
        for (let k = 0; k < cols; k++) {
          const v0 = ubase + j * (cols + 1) + k;
          b.quadIdx(ub, v0, v0 + cols + 1, v0 + cols + 2, v0 + 1);
        }
    }
    // 连檐（檐口封板）
    {
      const fb = b.bucket('paint');
      const fc = lin(pal.fascia);
      const s = -ov;
      const aL = Ed.aL(s), aR = Ed.aR(s);
      const fbase = fb.count;
      const line = [];
      for (let k = 0; k <= cols; k++) {
        const a = -aL + (aL + aR) * tAt(k);
        G.point(i, a, s, P);
        const q = [P[0], P[1], P[2]];
        line.push(q);
        // 外法线：沿檐切向 × 竖直
        const P2 = G.point(i, a + 0.05, s, [0, 0, 0]);
        let tx = P2[0] - P[0], tz = P2[2] - P[2];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const nx = tz, nz = -tx; // 向外
        b.vtx(fb, P[0], P[1] + 0.02, P[2], nx, 0, nz, a, 0, fc);
        b.vtx(fb, P[0], P[1] - thick - 0.04, P[2], nx, 0, nz, a, thick, fc);
      }
      for (let k = 0; k < cols; k++) {
        const v0 = fbase + k * 2;
        b.quadIdx(fb, v0, v0 + 1, v0 + 3, v0 + 2);
      }
      info.eaveLines.push(line);
    }
    // 悬山/歇山的山面封口：博风板（沿坡面两侧边）
    if (Ed.gable || type === 'xieshan') {
      if (!Ed.side) boFeng(b, G, i, Ed, ov, thick, pal, detail, type === 'xieshan' ? sG - gableOv : -ov);
    }
  }

  // ——— 几何筒瓦垄 + 瓦当滴水（近景） ———
  if (detail >= 2 && !o.noTiles) {
    for (let i = 0; i < E.length; i++) tileRows(b, G, i, E[i], { ov, tileW, courseL, mTop, rc, arc, rolled });
  }

  // ——— 椽子（檐椽 + 飞椽）、角梁 ———
  if (detail >= 2 && o.rafters !== false) {
    for (let i = 0; i < E.length; i++) rafters(b, G, i, E[i], { ov, thick, pal, style, gableType, gableOv, xG, sG, type });
  }
  if (detail >= 1 && !gableType) {
    for (let i = 0; i < E.length; i++) {
      if (E[i].nbR < 0) continue;
      cornerBeam(b, G, i, E[i].nbR, { ov, thick, pal, style, rc, mRidge, detail });
    }
  }

  // ——— 屋脊 ———
  const ridgeH = o.ridgeH ?? clamp(d * S.ridgeK, 0.35, 2.0) * (type === 'band' ? 0.5 : 1);
  const ridgeW = clamp(ridgeH * 0.7, 0.25, 0.9);
  const mainProf = ridgeProfile(style, ridgeW, ridgeH, detail);
  const hipProf = ridgeProfile(style, ridgeW * 0.8, ridgeH * 0.62, detail);
  const topY = G.y + hAt(G.prof, run, ov);
  info.ridgeY = topY;
  info.topY = topY + ridgeH;
  info.eaveY = G.point(0, 0, -ov, [0, 0, 0])[1];
  const ornament = o.ornament ?? S.ornament;
  const beasts = o.beasts ?? (style === 'ming' ? (w > 20 ? 7 : w > 10 ? 5 : 3) : 0);

  const hipRidge = (i, j, t0, t1, withBeasts) => {
    const n = detail >= 2 ? 14 : detail === 1 ? 8 : 3;
    const path = [];
    for (let k = 0; k <= n; k++) {
      const t = lerp(t0, t1, Math.pow(k / n, 0.8));
      const p = G.hipPoint(i, j, t);
      path.push([p[0], p[1] - 0.06, p[2]]);
    }
    b.sweep(mRidge, path, hipProf, rc.ridge, { capColor: rc.ridge });
    info.ridgeLines.push(path.map((p) => [p[0], p[1] + ridgeH * 0.62 + 0.02, p[2]]));
    if (detail >= 1 && withBeasts) ridgeBeasts(b, G, i, j, { t0, t1, style, ridgeH, beasts: detail >= 2 ? beasts : 0, rc, mRidge, hipH: ridgeH * 0.62, ov });
  };

  if (type === 'band') {
    for (let i = 0; i < E.length; i++) hipRidge(i, E[i].nbR, -ov + 0.02, E[i].sTop, true);
    // 围脊（上缘贴墙）
    const n = E.length;
    const loop = [];
    for (let i = 0; i < n; i++) {
      const p = G.hipPoint(i, E[i].nbR, E[i].sTop);
      loop.push([p[0], p[1] - 0.05, p[2]]);
    }
    // 从每边起点到终点（按顺序）
    const ord = [];
    for (let i = 0; i < n; i++) ord.push(loop[(i + n - 1) % n]);
    b.sweep(mRidge, ord, ridgeProfile(style, ridgeW * 0.9, ridgeH * 0.9, detail), rc.ridge, { closed: true });
    info.bandTopY = G.y + hAt(G.prof, o.top, ov);
    info.ridgeLines.push(ord.map((p) => [p[0], p[1] + ridgeH * 0.9, p[2]]).concat([[ord[0][0], ord[0][1] + ridgeH * 0.9, ord[0][2]]]));
  } else if (type === 'zanjian') {
    const N = E.length;
    for (let i = 0; i < N; i++) hipRidge(i, E[i].nbR, -ov + 0.02, polyA * 0.93, true);
    finial(b, [0, topY - 0.1, 0], o.finial, { size: clamp(w * 0.09, 0.8, 3.2), rc, mRidge, style, detail });
    info.topY = topY + clamp(w * 0.09, 0.8, 3.2) * 1.5;
  } else if (type === 'wudian') {
    const xr = Math.abs(X - Z);
    const alongX = X >= Z;
    const path = alongX ? [[-xr, topY - 0.08, 0], [xr, topY - 0.08, 0]] : [[0, topY - 0.08, -xr], [0, topY - 0.08, xr]];
    if (xr > 0.2) {
      b.sweep(mRidge, path, mainProf, rc.ridge, { up: [0, 1, 0] });
      info.ridgeLines.push(path.map((p) => [p[0], p[1] + ridgeH + 0.02, p[2]]));
    }
    for (let i = 0; i < 4; i++) hipRidge(i, E[i].nbR, -ov + 0.02, run, true);
    if (ornament !== 'none' && detail >= 1)
      for (const sgn of [-1, 1]) ridgeEnd(b, alongX ? [sgn * xr, topY - 0.08, 0] : [0, topY - 0.08, sgn * xr], alongX ? (sgn > 0 ? 0 : Math.PI) : sgn > 0 ? -Math.PI / 2 : Math.PI / 2, { ornament, ridgeH, ridgeW, rc, mRidge, style, detail });
  } else if (type === 'xieshan') {
    const xr = xG + gableOv * 0.5;
    if (!rolled) {
      const path = [[-xr, topY - 0.08, 0], [xr, topY - 0.08, 0]];
      b.sweep(mRidge, path, mainProf, rc.ridge, {});
      info.ridgeLines.push(path.map((p) => [p[0], p[1] + ridgeH + 0.02, p[2]]));
      if (ornament !== 'none' && detail >= 1)
        for (const sgn of [-1, 1]) ridgeEnd(b, [sgn * xr, topY - 0.08, 0], sgn > 0 ? 0 : Math.PI, { ornament, ridgeH, ridgeW, rc, mRidge, style, detail });
    }
    // 垂脊（山面前后坡沿博风）→ 戗脊（下段斜向翼角）
    const t0 = sG - gableOv * 0.35;
    const ac = xG + gableOv * 0.35;
    for (const [i, sgnA] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
      const n = detail >= 2 ? 10 : 4;
      const path = [];
      for (let k = 0; k <= n; k++) {
        const s = lerp(run - (rolled ? 0 : ridgeW * 0.3), t0, k / n);
        const p = G.point(i, sgnA * ac, s, [0, 0, 0]);
        path.push([p[0], p[1] - 0.05, p[2]]);
      }
      b.sweep(mRidge, path, hipProf, rc.ridge, {});
      info.ridgeLines.push(path.map((p) => [p[0], p[1] + ridgeH * 0.62 + 0.02, p[2]]));
      // 垂兽
      if (detail >= 1) {
        const pe = path[path.length - 1];
        const pp = path[path.length - 3];
        const yaw = Math.atan2(pe[0] - pp[0], pe[2] - pp[2]);
        beastAt(b, 'chui', [pe[0], pe[1] + ridgeH * 0.45, pe[2]], yaw, ridgeH * 0.95, rc, mRidge, style);
      }
    }
    for (const i of [0, 2]) {
      hipRidge(i, E[i].nbR, -ov + 0.02, t0, true);
      hipRidge(i, E[i].nbL, -ov + 0.02, t0, true);
    }
    // 博脊 + 山花
    for (const i of [1, 3]) {
      const Ed = E[i];
      const aSpan = Ed.aR(sG);
      const n = detail >= 2 ? 8 : 2;
      const path = [];
      for (let k = 0; k <= n; k++) {
        const p = G.point(i, lerp(-aSpan, aSpan, k / n), sG, [0, 0, 0]);
        path.push([p[0], p[1] - 0.04, p[2]]);
      }
      b.sweep(mRidge, path, ridgeProfile(style, ridgeW * 0.6, ridgeH * 0.45, detail), rc.ridge, {});
      gableFace(b, G, i, { xG, sG, run, Z, pal, style, detail, thick, sgn: i === 1 ? 1 : -1, rolled });
    }
  } else {
    // 悬山/硬山/卷棚
    const xr = X + (type === 'yingshan' ? 0.32 : gableOv) - 0.05;
    if (!rolled && !o.noRidge) {
      const path = [[-xr, topY - 0.08, 0], [xr, topY - 0.08, 0]];
      b.sweep(mRidge, path, mainProf, rc.ridge, {});
      info.ridgeLines.push(path.map((p) => [p[0], p[1] + ridgeH + 0.02, p[2]]));
      if (ornament !== 'none' && detail >= 1)
        for (const sgn of [-1, 1]) ridgeEnd(b, [sgn * xr, topY - 0.08, 0], sgn > 0 ? 0 : Math.PI, { ornament, ridgeH, ridgeW, rc, mRidge, style, detail });
    }
    const ac = xr - gableOv * 0.15;
    for (const [i, sgnA] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
      const n = detail >= 2 ? 10 : 4;
      const path = [];
      for (let k = 0; k <= n; k++) {
        const s = lerp(run, -ov + 0.05, k / n);
        const p = G.point(i, sgnA * ac, s, [0, 0, 0]);
        path.push([p[0], p[1] - 0.05, p[2]]);
      }
      b.sweep(mRidge, path, hipProf, rc.ridge, {});
      info.ridgeLines.push(path.map((p) => [p[0], p[1] + ridgeH * 0.62 + 0.02, p[2]]));
    }
    for (const sgn of [1, -1]) gableEnd(b, G, { X, Z, run, pal, style, detail, thick, sgn, type, rolled, ov });
  }
  return info;
}

// ───────────── 圆攒尖 ─────────────
function roundRoof(b, G, o, c) {
  const { polyA, run, ov, thick, tileW, courseL, mTop, mRidge, rc, pal, detail, type, info } = c;
  const sTop = type === 'band' ? o.top : polyA * 0.96;
  const segs = detail >= 2 ? 64 : detail === 1 ? 32 : 14;
  const rows = detail >= 2 ? 18 : detail === 1 ? 8 : 4;
  const span = sTop + ov;
  const pt = (th, s) => {
    const r = polyA - s;
    return [Math.sin(th) * r, G.y + hAt(G.prof, s, ov), Math.cos(th) * r];
  };
  const nrm = (th, s) => {
    const k = (hAt(G.prof, s + 0.03, ov) - hAt(G.prof, s - 0.03, ov)) / 0.06;
    const l = Math.hypot(k, 1);
    return [(Math.sin(th) * k) / l, 1 / l, (Math.cos(th) * k) / l];
  };
  const bk = b.bucket(mTop);
  const cl = lin(rc.tile);
  const base = bk.count;
  const circ = 2 * Math.PI * (polyA + ov);
  for (let j = 0; j <= rows; j++) {
    const s = -ov + span * Math.pow(j / rows, 1.15);
    for (let k = 0; k <= segs; k++) {
      const th = (k / segs) * Math.PI * 2;
      const p = pt(th, s), n = nrm(th, s);
      b.vtx(bk, p[0], p[1], p[2], n[0], n[1], n[2], ((k / segs) * circ) / (2 * tileW), ((s + ov) * 1.2) / (8 * courseL), cl);
    }
  }
  for (let j = 0; j < rows; j++)
    for (let k = 0; k < segs; k++) {
      const v0 = base + j * (segs + 1) + k;
      b.quadIdx(bk, v0, v0 + segs + 1, v0 + segs + 2, v0 + 1);
    }
  // 底面 + 连檐
  const ub = b.bucket('paint');
  const uc = lin(pal.soffit), fc = lin(pal.fascia);
  const sU = o.underside === 'full' ? sTop : Math.min(sTop, 0.9);
  const ubase = ub.count;
  const urows = 4;
  for (let j = 0; j <= urows; j++) {
    const s = -ov + (sU + ov) * (j / urows);
    for (let k = 0; k <= segs; k++) {
      const th = (k / segs) * Math.PI * 2;
      const p = pt(th, s), n = nrm(th, s);
      b.vtx(ub, p[0], p[1] - thick, p[2], -n[0], -n[1], -n[2], k, s, uc);
    }
  }
  for (let j = 0; j < urows; j++)
    for (let k = 0; k < segs; k++) {
      const v0 = ubase + j * (segs + 1) + k;
      b.quadIdx(ub, v0, v0 + 1, v0 + segs + 2, v0 + segs + 1);
    }
  const fbase = ub.count;
  const line = [];
  for (let k = 0; k <= segs; k++) {
    const th = (k / segs) * Math.PI * 2;
    const p = pt(th, -ov);
    line.push(p);
    b.vtx(ub, p[0], p[1] + 0.02, p[2], Math.sin(th), 0, Math.cos(th), k, 0, fc);
    b.vtx(ub, p[0], p[1] - thick - 0.04, p[2], Math.sin(th), 0, Math.cos(th), k, 1, fc);
  }
  for (let k = 0; k < segs; k++) {
    const v0 = fbase + k * 2;
    b.quadIdx(ub, v0, v0 + 2, v0 + 3, v0 + 1);
  }
  info.eaveLines.push(line);
  // 筒瓦（放射状）
  if (detail >= 2) {
    const n = Math.round(circ / tileW);
    const rt = tileW * 0.3;
    const tb = b.bucket(mTop);
    const tc = lin(rc.tube);
    const PHI = [-0.2, 0.7, 1.5708, 2.44, 3.34];
    const sEnd = Math.min(sTop, polyA - (polyA * 0.35));
    for (let r = 0; r < n; r++) {
      const th = ((r + 0.5) / n) * Math.PI * 2;
      const st = r % 2 ? sEnd * 0.6 : sEnd; // 越近顶越稀
      const nr = clamp(Math.ceil((st + ov) / 0.9), 2, 12);
      const A = [Math.cos(th), 0, -Math.sin(th)];
      const rb = tb.count;
      for (let j = 0; j <= nr; j++) {
        const s = -ov + (st + ov) * (j / nr);
        const p = pt(th, s), N = nrm(th, s);
        for (const ph of PHI) {
          const ca = Math.cos(ph), sa = Math.sin(ph);
          const nx = A[0] * ca + N[0] * sa, ny = A[1] * ca + N[1] * sa, nz = A[2] * ca + N[2] * sa;
          b.vtx(tb, p[0] + N[0] * rt * 0.2 + nx * rt, p[1] + N[1] * rt * 0.2 + ny * rt, p[2] + N[2] * rt * 0.2 + nz * rt, nx, ny, nz, 0.5 + (ph / Math.PI - 0.5) * 0.3, ((s + ov) * 1.2) / (8 * courseL), tc);
        }
      }
      for (let j = 0; j < nr; j++)
        for (let q = 0; q < 4; q++) {
          const v0 = rb + j * 5 + q;
          b.quadIdx(tb, v0, v0 + 5, v0 + 6, v0 + 1);
        }
    }
  }
  const topY = G.y + hAt(G.prof, sTop, ov);
  info.ridgeY = topY;
  info.topY = topY;
  info.eaveY = pt(0, -ov)[1];
  if (type === 'band') info.bandTopY = topY;
  else {
    const size = clamp(polyA * 0.2, 0.6, 2.5);
    finial(b, [0, topY - 0.15, 0], o.finial, { size, rc, mRidge, style: o.style || b.style, detail });
    info.topY = topY + size * 1.5;
  }
}

// ───────────── 筒瓦垄 ─────────────
const PHI = [-0.22, 0.75, Math.PI / 2, Math.PI - 0.75, Math.PI + 0.22];
function tileRows(b, G, i, Ed, c) {
  const { ov, tileW, courseL, mTop, rc, arc, rolled } = c;
  const rt = tileW * 0.3;
  const bk = b.bucket(mTop);
  const tc = lin(rc.tube);
  const endC = shadeRGB(tc, 0.62);
  const P = [0, 0, 0], N = [0, 1, 0], P2 = [0, 0, 0];
  const amax = Math.max(Ed.aL(-ov), Ed.aR(-ov));
  const r0 = Math.ceil(-Ed.aL(-ov) / tileW - 0.5), r1 = Math.floor(Ed.aR(-ov) / tileW - 0.5);
  const sTop = Ed.sTop;
  for (let r = r0; r <= r1; r++) {
    const a = (r + 0.5) * tileW;
    const inside = (s) => (a >= 0 ? Ed.aR(s) - a : Ed.aL(s) + a) >= tileW * 0.45;
    if (!inside(-ov)) continue;
    let sEnd = sTop - (rolled ? 0 : 0.05);
    if (!inside(sEnd)) {
      let lo = -ov, hi = sEnd;
      for (let it = 0; it < 18; it++) {
        const m = (lo + hi) / 2;
        if (inside(m)) lo = m;
        else hi = m;
      }
      sEnd = lo;
    }
    const len = sEnd + ov;
    if (len < tileW * 1.2) continue;
    const nr = clamp(Math.ceil(len / 0.85), 2, 16);
    const rb = bk.count;
    let T0 = null, A0 = null, N0 = null, C0 = null;
    for (let j = 0; j <= nr; j++) {
      const s = -ov + len * (j / nr);
      G.point(i, a, s, P);
      G.normal(i, a, s, N);
      G.point(i, a + 0.05, s, P2);
      let ax = P2[0] - P[0], ay = P2[1] - P[1], az = P2[2] - P[2];
      // 横向正交化
      const dn = ax * N[0] + ay * N[1] + az * N[2];
      ax -= dn * N[0]; ay -= dn * N[1]; az -= dn * N[2];
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al; ay /= al; az /= al;
      const cx = P[0] + N[0] * rt * 0.2, cy = P[1] + N[1] * rt * 0.2, cz = P[2] + N[2] * rt * 0.2;
      if (j === 0) {
        A0 = [ax, ay, az];
        N0 = [N[0], N[1], N[2]];
        C0 = [cx, cy, cz];
        const Pn = G.point(i, a, s + 0.05, [0, 0, 0]);
        T0 = normalize3([Pn[0] - P[0], Pn[1] - P[1], Pn[2] - P[2]]);
      }
      const v = arc(s);
      for (const ph of PHI) {
        const ca = Math.cos(ph), sa = Math.sin(ph);
        const nx = ax * ca + N[0] * sa, ny = ay * ca + N[1] * sa, nz = az * ca + N[2] * sa;
        b.vtx(bk, cx + nx * rt, cy + ny * rt, cz + nz * rt, nx, ny, nz, 0.5 + (ph / Math.PI - 0.5) * 0.3, v, tc);
      }
    }
    for (let j = 0; j < nr; j++)
      for (let q = 0; q < 4; q++) {
        const v0 = rb + j * 5 + q;
        b.quadIdx(bk, v0, v0 + 5, v0 + 6, v0 + 1);
      }
    // 瓦当（圆盘，朝外下方）——放在粗糙的 paint 桶，避免琉璃高光把瓦当反射成一排白点
    const eb = b.bucket('paint');
    const db = eb.count;
    const off = 0.012;
    const cc = [C0[0] - T0[0] * off, C0[1] - T0[1] * off, C0[2] - T0[2] * off];
    b.vtx(eb, cc[0], cc[1], cc[2], -T0[0], -T0[1], -T0[2], 0.5, 0.02, endC);
    const segs = 8;
    for (let k = 0; k <= segs; k++) {
      const ph = -0.22 + (k / segs) * (Math.PI * 2);
      const ca = Math.cos(ph), sa = Math.sin(ph);
      const rr = rt * 1.08;
      b.vtx(eb, cc[0] + (A0[0] * ca + N0[0] * sa) * rr, cc[1] + (A0[1] * ca + N0[1] * sa) * rr, cc[2] + (A0[2] * ca + N0[2] * sa) * rr, -T0[0], -T0[1], -T0[2], 0.5, 0.02, endC);
    }
    for (let k = 0; k < segs; k++) b.tri(eb, db, db + 2 + k, db + 1 + k);
    // 滴水（两垄之间下垂的如意形瓦头）
    if (inside(-ov) && (a + tileW * 0.5 < Ed.aR(-ov) - tileW * 0.3)) {
      const am = a + tileW * 0.5;
      const Pm = G.point(i, am, -ov, [0, 0, 0]);
      const Nm = G.normal(i, am, -ov, [0, 1, 0]);
      const hw = tileW * 0.44;
      const ax = A0[0], ay = A0[1], az = A0[2];
      const pts = [
        [Pm[0] - ax * hw, Pm[1] - ay * hw + 0.01, Pm[2] - az * hw],
        [Pm[0] + ax * hw, Pm[1] + ay * hw + 0.01, Pm[2] + az * hw],
        [Pm[0] + ax * hw * 0.8 - T0[0] * 0.02, Pm[1] - tileW * 0.18, Pm[2] + az * hw * 0.8 - T0[2] * 0.02],
        [Pm[0] - T0[0] * 0.035, Pm[1] - tileW * 0.36, Pm[2] - T0[2] * 0.035],
        [Pm[0] - ax * hw * 0.8 - T0[0] * 0.02, Pm[1] - tileW * 0.18, Pm[2] - az * hw * 0.8 - T0[2] * 0.02],
      ];
      const fn = normalize3([-T0[0] - Nm[0] * 0.3, -T0[1] * 0.2, -T0[2] - Nm[2] * 0.3]);
      const pb = eb.count;
      for (const p of pts) b.vtx(eb, p[0], p[1], p[2], fn[0], fn[1], fn[2], 0.5, 0.02, endC);
      b.tri(eb, pb, pb + 4, pb + 1);
      b.tri(eb, pb + 1, pb + 4, pb + 2);
      b.tri(eb, pb + 2, pb + 4, pb + 3);
    }
  }
}

function shadeRGB(c, k) {
  return [c[0] * k, c[1] * k, c[2] * k];
}
function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ───────────── 椽子 ─────────────
const _m4 = new THREE.Matrix4();
function placeBeam(b, key, factory, p0, p1, r, upHint = [0, 1, 0]) {
  const T = normalize3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  let L = normalize3([T[1] * upHint[2] - T[2] * upHint[1], T[2] * upHint[0] - T[0] * upHint[2], T[0] * upHint[1] - T[1] * upHint[0]]);
  const U = [L[1] * T[2] - L[2] * T[1], L[2] * T[0] - L[0] * T[2], L[0] * T[1] - L[1] * T[0]];
  // 注意：proto 局部 x=横、y=上、z=长
  _m4.set(L[0] * r, U[0] * r, T[0] * len, p0[0], L[1] * r, U[1] * r, T[1] * len, p0[1], L[2] * r, U[2] * r, T[2] * len, p0[2], 0, 0, 0, 1);
  b.push(_m4);
  b.proto(key, factory);
  b.pop();
}
const HEX = [];
for (let k = 0; k < 6; k++) HEX.push([Math.cos((k / 6) * Math.PI * 2 + Math.PI / 6), Math.sin((k / 6) * Math.PI * 2 + Math.PI / 6)]);
const SQ = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function rafters(b, G, i, Ed, c) {
  const { ov, thick, pal, style, gableType } = c;
  const dr = clamp(ov * 0.045, 0.07, 0.2);
  const sp = dr * 2.4;
  const keyY = `rafterY|${pal.rafter}|${pal.rafterEnd}`;
  const keyF = `rafterF|${pal.rafter}|${pal.flyEnd}`;
  const facY = (pb) => pb.prism('paint', HEX, 'z', 0, 1, pal.rafter, { capColor: pal.rafterEnd });
  const facF = (pb) => pb.prism('paint', SQ, 'z', 0, 1, pal.rafter, { capColor: pal.flyEnd });
  const aTipL = Ed.aL(-ov), aTipR = Ed.aR(-ov);
  const half0R = Ed.aR(0), half0L = Ed.aL(0);
  const Lfan = gableType ? 0 : Math.min(G.Lz * 0.9, (aTipR + aTipL) * 0.35);
  const n0 = Math.ceil((-aTipL + sp * 0.6) / sp), n1 = Math.floor((aTipR - sp * 0.6) / sp);
  const P = [0, 0, 0];
  const pAt = (a, s, drop) => {
    G.point(i, a, s, P);
    return [P[0], P[1] - thick - drop, P[2]];
  };
  const sIn = Math.min(0.6, Ed.sTop * 0.5);
  for (let k = n0; k <= n1; k++) {
    const aTip = k * sp;
    const right = aTip >= 0;
    const tipEdge = right ? aTipR : aTipL;
    const colEdge = right ? half0R : half0L;
    const dist = tipEdge - Math.abs(aTip); // 距翼角檐口端点
    let f = 0;
    if (Lfan > 0 && dist < Lfan) f = Math.pow(1 - dist / Lfan, 1.3);
    // 内端：翼角椽向角柱收拢
    const sgn = right ? 1 : -1;
    const aIn = lerp(aTip, sgn * (colEdge - 0.35), f);
    const sInK = lerp(sIn, 0.25, f);
    // 飞椽 / 檐椽 沿直线 (aIn,sInK) → (aTip, -ov)
    const at = (u) => [lerp(aIn, aTip, u), lerp(sInK, -ov + 0.05, u)];
    const uY = (sInK + ov * 0.72) / (sInK + ov); // 檐椽到 -0.72ov
    const uF0 = (sInK + ov * 0.5) / (sInK + ov);
    const [a0, s0] = at(0), [a1, s1] = at(uY), [a2, s2] = at(uF0), [a3, s3] = at(1);
    placeBeam(b, keyY, facY, pAt(a0, s0, dr * 0.95), pAt(a1, s1, dr * 0.95), dr);
    placeBeam(b, keyF, facF, pAt(a2, s2, dr * 0.8), pAt(a3, s3, dr * 0.8), dr * 0.8);
  }
}

// ───────────── 角梁 + 套兽 + 风铎 ─────────────
function cornerBeam(b, G, i, j, c) {
  const { ov, thick, pal, style, rc, mRidge, detail } = c;
  const n = 5;
  const path = [];
  for (let k = 0; k <= n; k++) {
    const t = lerp(0.8, -ov, k / n);
    const p = G.hipPoint(i, j, t);
    path.push([p[0], p[1] - thick - 0.12, p[2]]);
  }
  // 伸出檐角
  const pl = path[n], pp = path[n - 1];
  const dv = normalize3([pl[0] - pp[0], pl[1] - pp[1], pl[2] - pp[2]]);
  const ext = clamp(ov * 0.14, 0.15, 0.6);
  const tip = [pl[0] + dv[0] * ext, pl[1] + dv[1] * ext + ext * 0.35, pl[2] + dv[2] * ext];
  path.push(tip);
  const bw = clamp(ov * 0.07, 0.12, 0.35), bh = bw * 1.35;
  b.sweep('paint', path, [[-bw / 2, -bh], [bw / 2, -bh], [bw / 2, 0.05], [-bw / 2, 0.05]], pal.gong, { capColor: pal.armEnd });
  if (detail < 2) return;
  // 套兽（明清：兽头；唐：素面梁头）
  const yaw = Math.atan2(dv[0], dv[2]);
  if (style === 'ming') {
    b.push(tip[0], tip[1] - bh * 0.55, tip[2], yaw);
    b.boxC(mRidge, 0, 0, bw * 0.4, bw * 1.25, bh * 1.2, bw * 1.3, rc.ridge);
    b.boxC(mRidge, 0, bh * 0.35, bw * 0.95, bw * 0.9, bh * 0.4, bw * 0.5, rc.ridge);
    b.pop();
  } else {
    // 风铎
    b.push(tip[0], tip[1] - bh, tip[2], yaw);
    const s = clamp(ov * 0.06, 0.12, 0.3);
    b.cyl('metal', 0, -s * 3.2, 0, 0, 0, s * 1.2, 4, 0x6b5a3a, { top: false });
    b.lathe('metal', [[0.0, -s * 3.8], [s * 0.55, -s * 3.6], [s * 0.45, -s * 2.6], [s * 0.2, -s * 2.0], [0, -s * 1.9]], 6, 0x5d6a52);
    b.pop();
  }
}

// ───────────── 屋脊截面 ─────────────
function ridgeProfile(style, w, h, detail) {
  if (detail === 0) return [[-w / 2, -0.4], [w / 2, -0.4], [w / 2, h], [-w / 2, h]];
  const hw = w / 2;
  if (style === 'tang') {
    // 叠瓦脊：多层线脚
    const R = [[hw, -0.45], [hw, 0.12 * h], [hw * 0.86, 0.2 * h], [hw * 0.94, 0.26 * h], [hw * 0.86, 0.42 * h], [hw * 0.94, 0.48 * h], [hw * 0.86, 0.64 * h], [hw * 0.92, 0.7 * h], [hw * 0.6, 0.9 * h], [hw * 0.3, h]];
    return mirrorProfile(R);
  }
  const R = [[hw, -0.45], [hw, 0.1 * h], [hw * 0.8, 0.16 * h], [hw * 0.8, 0.72 * h], [hw, 0.78 * h], [hw, 0.86 * h], [hw * 0.72, 0.92 * h], [hw * 0.45, h]];
  return mirrorProfile(R);
}
function mirrorProfile(R) {
  // R：右半边自下而上 → 逆时针完整截面
  const out = [[-R[0][0], R[0][1]]];
  for (const p of R) out.push(p);
  for (let i = R.length - 1; i >= 1; i--) out.push([-R[i][0], R[i][1]]);
  return out;
}

// ───────────── 正吻 / 鸱尾 ─────────────
function chiweiShape(tang) {
  // (u 向外, v 向上)，高度归一 1；u=0 为正脊端面（内侧）
  if (tang) {
    // 鸱尾：鱼尾状，上部向内（-u）弯卷，外缘带鳍齿
    const pts = [[0.0, 0.0], [0.42, 0.0], [0.5, 0.14]];
    for (let k = 0; k < 5; k++) {
      const v = 0.2 + k * 0.13;
      const u = 0.52 - k * 0.035 - Math.pow(k / 5, 2) * 0.08;
      pts.push([u + 0.05, v - 0.03], [u, v + 0.03]);
    }
    pts.push([0.33, 0.9], [0.18, 1.0], [0.0, 1.02], [-0.12, 0.96], [-0.02, 0.9], [0.1, 0.82], [0.12, 0.62], [0.08, 0.4], [0.02, 0.25]);
    return pts;
  }
  // 明清正吻：方正吻身 + 上部卷尾 + 张口吞脊
  return [[0.0, 0.0], [0.62, 0.0], [0.64, 0.5], [0.6, 0.78], [0.5, 0.92], [0.34, 1.0], [0.16, 0.98], [0.05, 0.9], [0.06, 0.78], [0.2, 0.8], [0.28, 0.72], [0.22, 0.62], [0.1, 0.6], [0.02, 0.52], [0.0, 0.42], [-0.08, 0.34], [-0.02, 0.28], [0.0, 0.18]];
}
function ridgeEnd(b, pos, yaw, c) {
  const { ornament, ridgeH, ridgeW, rc, mRidge, style, detail } = c;
  const tang = ornament === 'chiwei';
  const H = ridgeH * (tang ? 2.3 : 2.0) + 0.2;
  const shape = chiweiShape(tang).map(([u, v]) => [u * H, v * H]);
  const th = ridgeW * (tang ? 0.62 : 0.8);
  b.push(pos[0], pos[1], pos[2], yaw);
  // shape 在 (x,y) 平面，u→+x（外），沿 z 拉伸
  const col = c.color ?? rc.ridge;
  b.prism(mRidge, detail >= 2 ? shape : simplify(shape), 'z', -th / 2, th / 2, col);
  if (detail >= 2) {
    if (!tang) {
      // 剑把
      b.box(mRidge, H * 0.3, H * 0.95, -th * 0.12, H * 0.38, H * 1.18, th * 0.12, col);
      // 背兽（吻身侧面圆饼）
      for (const z of [-1, 1]) b.cyl(mRidge, 0, 0, 0, 0, 0, 0, 3, col); // 占位（空）
      b.boxC(mRidge, H * 0.4, H * 0.45, 0, H * 0.18, H * 0.18, th * 1.25, col);
    } else {
      // 鸱尾侧面鳍纹：两侧浅浮雕条
      for (let k = 0; k < 4; k++) {
        const v = 0.25 + k * 0.16;
        b.box(mRidge, H * 0.12, H * v, -th * 0.56, H * (0.4 - k * 0.04), H * (v + 0.035), th * 0.56, col);
      }
    }
  }
  b.pop();
}
function simplify(pts) {
  return pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
}

// ───────────── 走兽 ─────────────
const BEAST = [[-0.36, 0], [0.26, 0], [0.3, 0.32], [0.38, 0.52], [0.42, 0.72], [0.32, 0.86], [0.18, 1.0], [0.06, 0.9], [0.02, 0.68], [-0.18, 0.55], [-0.34, 0.5], [-0.44, 0.66], [-0.46, 0.42], [-0.38, 0.14]];
const XIANREN = [[-0.32, 0], [0.34, 0], [0.42, 0.24], [0.3, 0.3], [0.14, 0.34], [0.14, 0.9], [0.06, 1.06], [-0.07, 1.02], [-0.08, 0.4], [-0.28, 0.36], [-0.42, 0.48], [-0.4, 0.14]];
const CHUISHOU = [[-0.45, 0], [0.34, 0], [0.4, 0.46], [0.3, 0.8], [0.1, 1.0], [-0.18, 0.96], [-0.3, 0.7], [-0.45, 0.62]];
function beastAt(b, kind, pos, yaw, h, rc, mRidge, style) {
  const shape = kind === 'xian' ? XIANREN : kind === 'chui' ? CHUISHOU : BEAST;
  const th = h * (kind === 'chui' ? 0.42 : 0.3);
  b.push(pos[0], pos[1], pos[2], yaw);
  // 剪影在 (z 前, y 上) 平面，沿 x 拉伸
  b.prism(mRidge, shape.map(([z, y]) => [z * h, y * h]), 'x', -th / 2, th / 2, rc.ridge);
  b.pop();
}
function ridgeBeasts(b, G, i, j, c) {
  const { t0, t1, style, ridgeH, beasts, rc, mRidge, hipH, ov } = c;
  // 沿戗脊从檐角向上排：仙人 + 走兽 + 垂兽/戗兽
  const bh = clamp(ridgeH * 0.55, 0.22, 0.8);
  const step = bh * 0.95;
  const up = [0, 1, 0];
  const dir = (t) => {
    const p = G.hipPoint(i, j, t), q = G.hipPoint(i, j, t - 0.1);
    return [q[0] - p[0], q[2] - p[2]]; // 朝外（下坡）方向
  };
  let t = t0 + Math.max(0.35, ov * 0.12);
  const put = (kind, h) => {
    const p = G.hipPoint(i, j, t);
    const dv = dir(t);
    const yaw = Math.atan2(dv[0], dv[1]);
    beastAt(b, kind, [p[0], p[1] + hipH - 0.08, p[2]], yaw, h, rc, mRidge, style);
  };
  if (style === 'ming') {
    if (beasts > 0) {
      put('xian', bh * 1.05);
      t += step * 1.1;
      for (let k = 0; k < beasts && t < t1 - step * 2; k++) {
        put('beast', bh);
        t += step;
      }
    }
    t += step * 0.3;
    if (t < t1 - step) put('chui', bh * 1.5);
  } else {
    // 唐：戗脊端一枚兽头
    put('chui', bh * 1.4);
  }
}

// ───────────── 宝顶 ─────────────
function finial(b, pos, opt = {}, c) {
  const { size, rc, mRidge, style, detail } = c;
  const s = opt?.h ? opt.h / 1.5 : size;
  const seg = detail >= 2 ? 16 : 8;
  // 座（屋面色）
  b.lathe(mRidge, [[0.5 * s, -0.3 * s], [0.5 * s, 0.1 * s], [0.36 * s, 0.16 * s], [0.3 * s, 0.3 * s], [0.4 * s, 0.36 * s], [0.4 * s, 0.44 * s]].map(([r, y]) => [r, y]), seg, rc.ridge, pos[0], pos[2]);
  b.push(pos[0], pos[1], pos[2]);
  // 宝珠（金）
  const gold = opt?.gold === false ? rc.ridge : 0xd9a63a;
  const prof = [[0.001, 0.44 * s], [0.18 * s, 0.46 * s], [0.34 * s, 0.56 * s], [0.4 * s, 0.72 * s], [0.34 * s, 0.9 * s], [0.14 * s, 1.0 * s], [0.08 * s, 1.08 * s], [0.18 * s, 1.18 * s], [0.2 * s, 1.28 * s], [0.12 * s, 1.36 * s], [0.03 * s, 1.44 * s], [0.001, 1.5 * s]];
  b.lathe(opt?.gold === false ? mRidge : 'metal', prof, seg, gold);
  b.pop();
  b.lathe(mRidge, [[0.001, pos[1] - 0.3 * s], [0.5 * s, pos[1] - 0.3 * s]], seg, rc.ridge, pos[0], pos[2]);
}

// ───────────── 博风板（山面檐边） ─────────────
function boFeng(b, G, i, Ed, ov, thick, pal, detail, sFrom) {
  const n = detail >= 2 ? 10 : 4;
  const sTop = Ed.sTop;
  for (const sgn of [-1, 1]) {
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const s = lerp(Math.max(sFrom, -ov), sTop, k / n);
      const a = sgn > 0 ? Ed.aR(s) : -Ed.aL(s);
      const p = G.point(i, a, s, [0, 0, 0]);
      pts.push(p);
    }
    const bh = thick + clamp(ov * 0.12, 0.2, 0.55);
    const bw = 0.06;
    // 从外侧看的一条竖板（顶面随屋面）
    const path = pts.map((p) => [p[0] + sgn * Ed.e[0] * 0.02, p[1] + 0.03, p[2] + sgn * Ed.e[1] * 0.02]);
    b.sweep('paint', path, [[-bw, -bh], [bw, -bh], [bw, 0], [-bw, 0]], pal.boFeng, { up: [0, 1, 0] });
  }
}

// ───────────── 歇山山花 ─────────────
function gableFace(b, G, i, c) {
  const { xG, sG, run, Z, pal, style, detail, thick, sgn } = c;
  // 平面 x = sgn*(xG) 处的三角形：底边为博脊高度，顶边沿前后坡面
  const x = sgn * (xG + 0.02);
  const zSpan = Z - sG;
  const n = detail >= 2 ? 10 : 4;
  const top = [];
  for (let k = 0; k <= n; k++) {
    const z = lerp(-zSpan, zSpan, k / n);
    const ei = z >= 0 ? 0 : 2;
    const s = Z - Math.abs(z);
    const a = ei === 0 ? x : -x;
    const p = G.point(ei, a, s, [0, 0, 0]);
    top.push([x, p[1] - thick * 0.6, z]);
  }
  const yb = G.point(i, 0, sG, [0, 0, 0])[1] - 0.1;
  const bk = b.bucket('plaster');
  const cl = lin(pal.gable);
  const base = bk.count;
  for (const p of top) {
    b.vtx(bk, x, p[1], p[2], sgn, 0, 0, p[2], p[1], cl);
    b.vtx(bk, x, yb, p[2], sgn, 0, 0, p[2], yb, cl);
  }
  for (let k = 0; k < n; k++) {
    const v0 = base + k * 2;
    if (sgn > 0) b.quadIdx(bk, v0, v0 + 1, v0 + 3, v0 + 2);
    else b.quadIdx(bk, v0, v0 + 2, v0 + 3, v0 + 1);
  }
  if (detail >= 1) {
    // 明清：山花金色绶带；唐：悬鱼
    const yTop = top[n >> 1][1];
    if (style === 'ming') {
      b.push(x + sgn * 0.03, 0, 0, sgn > 0 ? Math.PI / 2 : -Math.PI / 2);
      const h = (yTop - yb) * 0.14;
      b.box('metal', -zSpan * 0.55, yb + h * 0.8, -0.02, zSpan * 0.55, yb + h * 1.3, 0.02, 0xc9973a);
      b.pop();
    } else {
      const s = clamp((yTop - yb) * 0.22, 0.3, 1.4);
      b.push(x + sgn * 0.05, yTop - s * 0.1, 0, sgn > 0 ? Math.PI / 2 : -Math.PI / 2);
      b.prism('paint', [[-s * 0.18, 0], [s * 0.18, 0], [s * 0.3, -s * 0.7], [0, -s * 1.1], [-s * 0.3, -s * 0.7]], 'z', -0.04, 0.04, pal.boFeng);
      b.pop();
    }
  }
}

// ───────────── 悬山/硬山山面 ─────────────
function gableEnd(b, G, c) {
  const { X, Z, run, pal, style, detail, thick, sgn, type, ov } = c;
  const x = sgn * X;
  const n = detail >= 2 ? 12 : 4;
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const z = lerp(-Z, Z, k / n);
    const ei = z >= 0 ? 0 : 1;
    const s = Z - Math.abs(z);
    const a = ei === 0 ? x : -x;
    const p = G.point(ei, a, s, [0, 0, 0]);
    pts.push([p[1], z]);
  }
  const yb = G.y - thick;
  if (type === 'yingshan') {
    // 硬山：砖砌山墙（厚 0.5）顶部略高于屋面
    const poly = [[-Z - 0.3, yb - 0.2]];
    for (const [y, z] of pts) poly.push([z, y + 0.12]);
    poly.push([Z + 0.3, yb - 0.2]);
    const p2 = poly.map(([z, y]) => [z, y]);
    b.prism('brick', p2, 'x', x - 0.25 + sgn * 0.25, x + 0.25 + sgn * 0.25, 0xb4b0a8);
  } else {
    const bk = b.bucket('plaster');
    const cl = lin(pal.gable);
    const base = bk.count;
    for (const [y, z] of pts) {
      b.vtx(bk, x, y - thick, z, sgn, 0, 0, z, y, cl);
      b.vtx(bk, x, yb, z, sgn, 0, 0, z, yb, cl);
    }
    for (let k = 0; k < n; k++) {
      const v0 = base + k * 2;
      if (sgn > 0) b.quadIdx(bk, v0, v0 + 1, v0 + 3, v0 + 2);
      else b.quadIdx(bk, v0, v0 + 2, v0 + 3, v0 + 1);
    }
  }
}

// ───────────── 工具：按承托点反算屋面高度 ─────────────
/**
 * 给定屋顶参数与承托点（挑檐桁/枋顶，距柱中线向外 bearOut 米、高 bearY），返回 roof() 应传入的 y（柱中线处瓦面高）。
 * 与 roof() 内部公式一致：出檐段坡度 kE = 0.9 × pitch × k0f（band 下檐 pitch×0.8），屋面厚 thick 默认 clamp(0.18+0.07·ov, 0.2, 0.5)。
 */
export function roofYFor(o, bearY, bearOut) {
  const style = o.style || 'ming';
  const S = STYLES[style] || STYLES.ming;
  const pitch = o.type === 'band' ? o.pitch ?? S.pitch * 0.8 : o.pitch ?? S.pitch;
  const kE = pitch * S.k0f * 0.9;
  const ov = o.overhang;
  const th = o.thick ?? clamp(0.18 + ov * 0.07, 0.2, 0.5);
  const s = -bearOut;
  const h = kE * s + (0.22 * kE * s * s) / Math.max(ov, 0.1);
  return bearY + th - h;
}
/** 屋面在距柱中线 s（向内为正、出檐为负）处的相对高度（不含起翘），供组合器计算 */
export function roofRise(o, run, s) {
  const style = o.style || 'ming';
  const S = STYLES[style] || STYLES.ming;
  const pitch = o.type === 'band' ? o.pitch ?? S.pitch * 0.8 : o.pitch ?? S.pitch;
  const P = makeProfile(run, pitch, S.k0f, o.type === 'juanpeng' || !!o.rolled);
  return hAt(P, s, o.overhang);
}
