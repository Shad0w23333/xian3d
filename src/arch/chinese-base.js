// 中式古建构件库 —— 台基与附属：台基（须弥座/普通/砖）、垂带踏跺（含御路）、栏杆（石/木/美人靠，沿任意折线）、灯笼/宫灯/灯笼串、石狮。
import * as THREE from 'three';
import { lin, clamp, lerp, palette } from './chinese-core.js';

// ───────────── 多边形工具 ─────────────
/** 凸多边形向外偏移 d（负值向内），poly=[[x,z]...]（任意绕向） */
export function offsetPoly(poly, d) {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const s = area > 0 ? -1 : 1; // 使法线朝外
  const nrm = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const l = Math.hypot(ex, ez) || 1;
    nrm.push([(s * -ez) / l, (s * ex) / l]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = nrm[(i - 1 + n) % n], B = nrm[i];
    const c = poly[i];
    const det = A[0] * B[1] - A[1] * B[0];
    if (Math.abs(det) < 1e-6) {
      out.push([c[0] + B[0] * d, c[1] + B[1] * d]);
      continue;
    }
    const x = (d * B[1] - A[1] * d) / det, z = (A[0] * d - d * B[0]) / det;
    out.push([c[0] + x, c[1] + z]);
  }
  return out;
}
export function rectPoly(w, d) {
  return [[-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]];
}
export function ngonPoly(N, apothem) {
  const Rc = apothem / Math.cos(Math.PI / N);
  const out = [];
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N - Math.PI / N;
    out.push([Math.sin(a) * Rc, Math.cos(a) * Rc]);
  }
  return out;
}
/** 多边形“台”：底 y0 处外扩 i0，顶 y1 处外扩 i1 的侧面（+ 可选顶面） */
function ringFrustum(b, mk, poly, y0, i0, y1, i1, col, top = false, topCol = null) {
  const A = offsetPoly(poly, i0), B = offsetPoly(poly, i1);
  const n = poly.length;
  // 判定绕向，保证侧面朝外
  let area = 0;
  for (let i = 0; i < n; i++) area += poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a0 = [A[i][0], y0, A[i][1]], a1 = [A[j][0], y0, A[j][1]], b1 = [B[j][0], y1, B[j][1]], b0 = [B[i][0], y1, B[i][1]];
    if (area > 0) b.quad(mk, a1, a0, b0, b1, col);
    else b.quad(mk, a0, a1, b1, b0, col);
  }
  if (top) {
    const bk = b.bucket(mk);
    const cl = lin(topCol ?? col);
    const base = bk.count;
    for (const p of B) b.vtx(bk, p[0], y1, p[1], 0, 1, 0, p[0], p[1], cl);
    const tris = THREE.ShapeUtils.triangulateShape(B.map((p) => new THREE.Vector2(p[0], p[1])), []);
    for (const t of tris) {
      // 俯视 x-z：保证法线 +y
      const p0 = B[t[0]], p1 = B[t[1]], p2 = B[t[2]];
      const cr = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      if (cr < 0) b.tri(bk, base + t[0], base + t[1], base + t[2]);
      else b.tri(bk, base + t[0], base + t[2], base + t[1]);
    }
  }
}

// ───────────── 台基 ─────────────
/**
 * 台基。poly：平面外轮廓（[[x,z]...]，台明边缘），或 {w,d} / {sides, apothem}。
 * o: {h 台高, kind:'sumeru'须弥座|'plain'普通阶条石台明|'brick'砖台, color, capColor, y0}
 * 返回台面高。
 */
export function platform(b, o) {
  const poly = o.poly || (o.sides ? ngonPoly(o.sides, o.apothem ?? o.w / 2) : rectPoly(o.w, o.d));
  const h = o.h ?? 1;
  const y0 = o.y0 ?? 0;
  const kind = o.kind || 'plain';
  const col = o.color ?? (kind === 'brick' ? 0x8e8a82 : 0xd8d2c4);
  const cap = o.capColor ?? col;
  if (b.detail === 0 || kind === 'plain' || h < 0.4) {
    const mk = kind === 'brick' ? 'brick' : 'stone';
    ringFrustum(b, 'stone', poly, y0 - 0.1, 0.12, y0 + 0.12, 0.12, 0xb9b2a6); // 土衬
    ringFrustum(b, mk, poly, y0 + 0.12, 0, y0 + h - 0.16, 0, col);
    ringFrustum(b, 'stone', poly, y0 + h - 0.16, 0.02, y0 + h, 0.02, cap, true, cap); // 阶条石
    return y0 + h;
  }
  if (kind === 'brick') {
    ringFrustum(b, 'stone', poly, y0 - 0.1, 0.1, y0 + 0.3, 0.1, 0xb9b2a6);
    ringFrustum(b, 'brick', poly, y0 + 0.3, 0.05, y0 + h - 0.2, 0, col);
    ringFrustum(b, 'stone', poly, y0 + h - 0.2, 0.06, y0 + h, 0.06, cap, true, cap);
    return y0 + h;
  }
  // 须弥座：圭脚、下枋、下枭、束腰、上枭、上枋
  const k = clamp(h * 0.08, 0.05, 0.3);
  const L = [
    [0.0, 0.1, k * 0.3, k * 0.3], // 圭脚
    [0.1, 0.22, 0, 0], // 下枋
    [0.22, 0.32, 0, -k * 0.9], // 下枭
    [0.32, 0.64, -k * 1.1, -k * 1.1], // 束腰
    [0.64, 0.74, -k * 0.9, 0], // 上枭
    [0.74, 1.0, k * 0.15, k * 0.15], // 上枋
  ];
  const tints = [0.92, 1, 0.97, 0.9, 0.97, 1.02];
  L.forEach(([a, c, i0, i1], idx) => {
    const cc = lin(col).map((v) => v * tints[idx]);
    ringFrustum(b, 'stone', poly, y0 + a * h, i0, y0 + c * h, i1, cc, idx === L.length - 1, cap);
  });
  // 束腰上的角柱/玛瑙柱（近景：各角竖条）
  if (b.detail >= 2) {
    const P = offsetPoly(poly, -k * 1.1 + 0.02);
    for (const p of P) b.box('stone', p[0] - 0.09, y0 + 0.32 * h, p[1] - 0.09, p[0] + 0.09, y0 + 0.64 * h, p[1] + 0.09, lin(col).map((v) => v * 1.05));
  }
  return y0 + h;
}

// ───────────── 台阶 ─────────────
/**
 * 垂带踏跺：自台边 (0, h, 0) 向 +Z 下行至地面 y0。o: {w 宽, h 高差, y0, tread(踏面深 0.32), riser(0.15),
 *   band(垂带宽 0.5), yulu（御路宽，0 = 无）, color}。返回 {run 水平长度}
 */
export function steps(b, o) {
  const h = o.h, y0 = o.y0 ?? 0, w = o.w ?? 3;
  const riser = o.riser ?? 0.15;
  const n = Math.max(1, Math.round(h / riser));
  const rh = h / n;
  const tread = o.tread ?? 0.32;
  const run = n * tread;
  const band = o.band ?? clamp(w * 0.12, 0.35, 0.6);
  const col = o.color ?? 0xd8d2c4;
  const yulu = o.yulu ?? 0;
  const segs = yulu > 0 ? [[-w / 2, -yulu / 2], [yulu / 2, w / 2]] : [[-w / 2, w / 2]];
  if (b.detail === 0) {
    b.prism('stone', [[0, y0 + h], [0, y0], [run, y0]].map(([z, y]) => [z, y]), 'x', -w / 2 - band, w / 2 + band, col);
    return { run };
  }
  for (const [xa, xb] of segs)
    for (let i = 0; i < n; i++) {
      const yTop = y0 + h - i * rh;
      b.box('stone', xa, y0, i * tread - 0.02, xb, yTop, (i + 1) * tread, lin(col).map((v) => v * (i % 2 ? 0.97 : 1)), { skip: 'bottom' });
    }
  // 垂带
  for (const sg of [-1, 1]) {
    const x0 = sg > 0 ? w / 2 : -w / 2 - band, x1 = x0 + band;
    b.prism('stone', [[-0.05, y0], [run + 0.12, y0], [run + 0.12, y0 + rh * 0.8], [-0.05, y0 + h + 0.06]], 'x', x0, x1, col);
  }
  // 御路（丹陛石）：斜面浮雕板
  if (yulu > 0) {
    b.prism('stone', [[-0.05, y0], [run, y0], [run, y0 + 0.06], [-0.05, y0 + h + 0.04]], 'x', -yulu / 2, yulu / 2, lin(col).map((v) => v * 1.03));
    if (b.detail >= 2) {
      const nC = Math.max(2, Math.round(run / 1.2));
      for (let i = 0; i < nC; i++) {
        const t = (i + 0.5) / nC;
        const z = t * run, y = y0 + h * (1 - t) + 0.05;
        b.push(0, y, z, 0);
        b.push(new THREE.Matrix4().makeRotationX(Math.atan2(h, run)));
        b.lathe('stone', [[yulu * 0.32, 0], [yulu * 0.26, 0.05], [0.001, 0.07]], 10, lin(col).map((v) => v * 0.95));
        b.pop();
        b.pop();
      }
    }
  }
  return { run, n, band };
}

// ───────────── 栏杆 ─────────────
/**
 * 沿折线的栏杆。pts=[[x,y,z]...]（y = 栏杆底高，可沿台阶倾斜）。
 * o: {kind:'stone'（汉白玉寻杖栏板）|'wood'（木勾栏）|'seat'（坐凳楣子/美人靠）, h, spacing（望柱间距）, color, closed, endPosts:true}
 */
export function balustrade(b, pts, o = {}) {
  const kind = o.kind || 'stone';
  const stone = kind === 'stone';
  const h = o.h ?? (stone ? 1.1 : kind === 'seat' ? 0.55 : 1.0);
  const sp = o.spacing ?? (stone ? 1.5 : 1.8);
  const col = o.color ?? (stone ? 0xe6e1d6 : 0x9a2418);
  const mk = stone ? 'stone' : 'paint';
  const n = pts.length;
  const segs = o.closed ? n : n - 1;
  const postW = stone ? 0.2 : 0.12;
  const d2 = b.detail >= 2;
  const postKey = `post|${kind}|${d2}`;
  const postF = (pb) => {
    // 单位：高 1（按 h 缩放 y；xz 按 1 米计）
    if (stone) {
      pb.box(mk, -postW / 2, 0, -postW / 2, postW / 2, 1.0, postW / 2, 0xffffff, { skip: 'bottom' });
      if (d2) {
        pb.box(mk, -postW * 0.6, 1.0, -postW * 0.6, postW * 0.6, 1.08, postW * 0.6, 0xffffff);
        pb.lathe(mk, [[postW * 0.5, 1.08], [postW * 0.56, 1.18], [postW * 0.46, 1.3], [postW * 0.22, 1.38], [0.001, 1.42]], 8, 0xffffff);
      } else pb.box(mk, -postW * 0.5, 1.0, -postW * 0.5, postW * 0.5, 1.3, postW * 0.5, 0xffffff);
    } else {
      pb.box(mk, -postW / 2, 0, -postW / 2, postW / 2, 1.0, postW / 2, 0xffffff, { skip: 'bottom' });
      if (d2) pb.lathe(mk, [[postW * 0.5, 1.0], [postW * 0.6, 1.06], [postW * 0.4, 1.14], [0.001, 1.2]], 6, 0xffffff);
    }
  };
  // 栏板原型：x∈[0,1]（长度）、y∈[0,1]（高度 h）、z 厚（米）
  const panelKey = `panel|${kind}|${d2}`;
  const panelF = (pb) => {
    if (stone) {
      const t = 0.12;
      pb.box(mk, 0, 0, -t / 2, 1, 0.12, t / 2, 0xf2efe8, { skip: 'bottom' }); // 地栿之上的下枋
      pb.box(mk, 0.02, 0.12, -t * 0.4, 0.98, 0.52, t * 0.4, 0xffffff); // 华板
      if (d2) {
        // 净瓶（三个）+ 寻杖
        for (const x of [0.17, 0.5, 0.83]) pb.box(mk, x - 0.05, 0.52, -t * 0.35, x + 0.05, 0.78, t * 0.35, 0xffffff);
        pb.box(mk, 0.02, 0.78, -t * 0.42, 0.98, 0.9, t * 0.42, 0xffffff);
        // 华板上的浅雕框（两道条）
        pb.box(mk, 0.08, 0.2, t * 0.4, 0.92, 0.23, t * 0.46, 0xe0dbd0);
        pb.box(mk, 0.08, 0.42, t * 0.4, 0.92, 0.45, t * 0.46, 0xe0dbd0);
      } else pb.box(mk, 0.02, 0.52, -t * 0.4, 0.98, 0.9, t * 0.4, 0xffffff);
    } else if (kind === 'seat') {
      // 坐凳楣子：凳面 + 下部棂条（格栅用 lattice 需 UV 细分，这里用竖条）
      pb.box(mk, 0, 0.86, -0.18, 1, 1.0, 0.18, 0xffffff);
      for (let i = 1; i < 6; i++) pb.box(mk, i / 6 - 0.012, 0, -0.02, i / 6 + 0.012, 0.86, 0.02, 0xffffff, { skip: 'top bottom' });
      pb.box(mk, 0, 0, -0.04, 1, 0.08, 0.04, 0xffffff, { skip: 'bottom' });
    } else {
      // 木勾栏：寻杖、盆唇、地栿 + 蜀柱 + 勾片（斜棂）
      pb.box(mk, 0, 0.88, -0.05, 1, 1.0, 0.05, 0xffffff);
      pb.box(mk, 0, 0.5, -0.04, 1, 0.58, 0.04, 0xffffff);
      pb.box(mk, 0, 0, -0.05, 1, 0.08, 0.05, 0xffffff, { skip: 'bottom' });
      pb.box(mk, 0.49, 0.58, -0.03, 0.51, 0.88, 0.03, 0xffffff, { skip: 'top bottom' });
      if (d2) {
        for (let i = 0; i < 4; i++) {
          const x0 = i * 0.25, x1 = x0 + 0.25;
          // 斜棂（勾片）
          pb.quad(mk, [x0 + 0.02, 0.1, 0.012], [x0 + 0.05, 0.1, 0.012], [x1 - 0.02, 0.48, 0.012], [x1 - 0.05, 0.48, 0.012], 0xffffff);
          pb.quad(mk, [x1 - 0.05, 0.1, -0.012], [x1 - 0.02, 0.1, -0.012], [x0 + 0.05, 0.48, -0.012], [x0 + 0.02, 0.48, -0.012], 0xffffff);
          pb.quad(mk, [x0 + 0.05, 0.1, -0.012], [x0 + 0.02, 0.1, -0.012], [x1 - 0.05, 0.48, -0.012], [x1 - 0.02, 0.48, -0.012], 0xffffff);
          pb.quad(mk, [x1 - 0.02, 0.1, 0.012], [x1 - 0.05, 0.1, 0.012], [x0 + 0.02, 0.48, 0.012], [x0 + 0.05, 0.48, 0.012], 0xffffff);
        }
      } else pb.box(mk, 0, 0.08, -0.01, 1, 0.5, 0.01, 0xffffff, { skip: 'top bottom' });
    }
  };
  const m = new THREE.Matrix4();
  const tint = col;
  for (let i = 0; i < segs; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const Lh = Math.hypot(dx, dz);
    if (Lh < 0.2) continue;
    const k = Math.max(1, Math.round(Lh / sp));
    const ex = dx / Lh, ez = dz / Lh;
    // 地栿（石栏杆）
    if (stone) b.sweep('stone', [[p0[0], p0[1], p0[2]], [p1[0], p1[1], p1[2]]], [[-0.16, -0.02], [0.16, -0.02], [0.16, 0.1], [-0.16, 0.1]], col, { miter: false });
    for (let j = 0; j < k; j++) {
      const t0 = j / k, t1 = (j + 1) / k;
      const a = [p0[0] + dx * t0, p0[1] + dy * t0, p0[2] + dz * t0];
      // 望柱
      if (!(j === 0 && i > 0 && o.skipJoin)) {
        b.push(a[0], a[1], a[2], -Math.atan2(ez, ex));
        b.push(new THREE.Matrix4().makeScale(1, h, 1));
        b.proto(postKey, postF, tint);
        b.pop();
        b.pop();
      }
      // 栏板（剪切矩阵：x 轴沿斜段，y = 竖直 h，z = 横向）
      const gap = postW / 2 / Lh;
      const u0 = t0 + gap, u1 = t1 - gap;
      const A = [p0[0] + dx * u0, p0[1] + dy * u0 + (stone ? 0.1 : 0), p0[2] + dz * u0];
      const len = u1 - u0;
      m.set(dx * len, 0, -ez, A[0], dy * len, h * (stone ? 0.9 : 1), 0, A[1], dz * len, 0, ex, A[2], 0, 0, 0, 1);
      b.push(m);
      b.proto(panelKey, panelF, tint);
      b.pop();
    }
    // 末端望柱
    if (!o.closed && i === segs - 1 && o.endPosts !== false) {
      b.push(p1[0], p1[1], p1[2], -Math.atan2(ez, ex));
      b.push(new THREE.Matrix4().makeScale(1, h, 1));
      b.proto(postKey, postF, tint);
      b.pop();
      b.pop();
    }
  }
}

// ───────────── 灯笼 ─────────────
function roundLanternF(pb, color = 0xe0301c) {
  // 单位：直径 1（高 ≈ 1.1），原点 = 吊点（顶部），向下延伸
  const seg = pb.detail >= 2 ? 12 : 8;
  const prof = [];
  for (let i = 0; i <= 8; i++) {
    const a = -Math.PI / 2 + (i / 8) * Math.PI;
    prof.push([0.5 * Math.cos(a) + 0.001, -0.62 + 0.42 * Math.sin(a)]);
  }
  pb.lathe('emit', prof, seg, color);
  // 顶/底金箍
  pb.cyl('metal', 0, -0.26, 0, 0.2, 0.2, 0.1, seg, 0xc99a3e);
  pb.cyl('metal', 0, -1.08, 0, 0.18, 0.18, 0.08, seg, 0xc99a3e, { bottom: true });
  if (pb.detail >= 2) {
    // 灯笼骨架竖线（深色肋）
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      pb.push(0, 0, 0, a);
      pb.sweep('paint', prof.slice(1, -1).map(([r, y]) => [r + 0.006, y, 0]), [[-0.008, -0.008], [0.008, -0.008], [0.008, 0.008], [-0.008, 0.008]], 0x5a1a10, { caps: false, miter: false });
      pb.pop();
    }
    // 流苏
    pb.cyl('paint', 0, -1.5, 0, 0.07, 0.03, 0.42, 6, 0xd8b04a, { top: false });
  }
  pb.cyl('paint', 0, -0.26, 0, 0.012, 0.012, 0.26, 4, 0x3a2a20, { top: false });
}
function palaceLanternF(pb) {
  // 六角宫灯：单位高 1.2，宽 0.8；原点 = 吊点
  const seg = 6;
  pb.lathe('paint', [[0.52, -0.38], [0.46, -0.3], [0.2, -0.2], [0.08, -0.12], [0.001, -0.08]], seg, 0x8a1c14, 0, 0, { phase: Math.PI / 6 }); // 顶盖
  pb.cyl('emit', 0, -0.98, 0, 0.36, 0.36, 0.6, seg, 0xfff0c8, { phase: Math.PI / 6 }); // 灯罩（绢纱）
  const Rc = 0.4;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * Rc, z = Math.sin(a) * Rc;
    pb.box('paint', x - 0.025, -1.02, z - 0.025, x + 0.025, -0.36, z + 0.025, 0x7a1810);
    if (pb.detail >= 2) pb.cyl('paint', x, -1.34, z, 0.03, 0.012, 0.3, 4, 0xd8b04a, { top: false }); // 角穗
  }
  pb.lathe('paint', [[0.001, -1.14], [0.3, -1.1], [0.46, -1.02], [0.46, -0.98]], seg, 0x8a1c14, 0, 0, { phase: Math.PI / 6 });
  pb.cyl('paint', 0, -0.1, 0, 0.012, 0.012, 0.1, 4, 0x3a2a20, { top: false });
}
/**
 * 灯笼（原型合并/实例化）：吊点 (x,y,z)，o: {kind:'round'|'palace', size（直径米，默认 0.8/0.9）, color（圆灯笼色）}
 * 夜间 emit 材质自动发光；需要真实光照请用 b.lightAnchors 收集后自行注册 ctx.lights。
 */
export function lantern(b, x, y, z, o = {}) {
  const kind = o.kind || 'round';
  const s = o.size ?? (kind === 'palace' ? 0.9 : 0.8);
  b.push(x, y, z, o.yaw ?? 0, s);
  if (kind === 'palace') b.proto('lantern|palace', palaceLanternF);
  else {
    const c = o.color ?? 0xe0301c;
    b.proto('lantern|round|' + c, (pb) => roundLanternF(pb, c));
  }
  b.pop();
  if (o.light) b.lightAnchors.push({ position: [x, y - s * 0.6, z], color: kind === 'palace' ? 0xffd9a0 : 0xff5a30, intensity: o.light, distance: 12 });
}
/**
 * 灯笼柱（广场/甬道两侧）：石础 + 红漆立柱 + 横担，灯笼挂在横担端头。(x, z) = 灯笼吊点平面位置，hookY = 吊点高，
 * y0 = 地面高。o: {kind, size, color, yaw（横担从立柱指向灯笼的方向，默认 +X）, arm（横担长，默认 0.6）}
 * 用于替代“凭空悬挂”的灯笼（原先只有灯笼、没有任何挂点）。
 */
export function lanternPost(b, x, y0, z, hookY, o = {}) {
  const arm = o.arm ?? 0.6;
  b.push(x, 0, z, o.yaw ?? 0);
  const px = -arm; // 立柱在灯笼 -X 侧
  b.cyl('stone', px, y0, 0, 0.26, 0.22, 0.35, 8, 0xbab3a6);
  b.box('paint', px - 0.08, y0 + 0.35, -0.08, px + 0.08, hookY + 0.32, 0.08, 0x7a2418, { skip: 'bottom' });
  b.box('paint', px - 0.12, hookY + 0.32, -0.12, px + 0.12, hookY + 0.42, 0.12, 0x3a2a20, { skip: 'bottom' });
  b.box('paint', px, hookY + 0.04, -0.05, 0.12, hookY + 0.16, 0.05, 0x3a2a20);
  b.pop();
  lantern(b, x, hookY, z, { kind: o.kind, size: o.size, color: o.color });
}
/** 灯笼串：两点间悬链线（缆绳 + 等距灯笼）。o: {n, sag, size, color, kind, cable:true} */
export function lanternString(b, p0, p1, o = {}) {
  const n = o.n ?? Math.max(2, Math.round(Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) / 1.6));
  const sag = o.sag ?? 0.6;
  const at = (t) => [lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t) - sag * 4 * t * (1 - t), lerp(p0[2], p1[2], t)];
  if (o.cable !== false && b.detail >= 1) {
    const path = [];
    for (let i = 0; i <= 12; i++) path.push(at(i / 12));
    b.sweep('paint', path, [[-0.012, -0.012], [0.012, -0.012], [0.012, 0.012], [-0.012, 0.012]], 0x2a2420, { caps: false });
  }
  for (let i = 0; i < n; i++) {
    const p = at((i + 0.5) / n);
    lantern(b, p[0], p[1], p[2], o);
  }
}

// ───────────── 石狮 ─────────────
function lionF(pb) {
  // 单位：狮身高 1（不含座），面朝 +Z；须弥座另做
  const c = 0xffffff;
  // 后腿蹲坐的躯干：侧剖面（z 前、y 上）
  const body = [[-0.36, 0], [0.18, 0], [0.22, 0.12], [0.16, 0.2], [0.18, 0.52], [0.24, 0.66], [0.1, 0.74], [-0.14, 0.62], [-0.3, 0.44], [-0.4, 0.3], [-0.42, 0.1]];
  pb.prism('stone', body, 'x', -0.2, 0.2, c);
  // 前腿
  pb.box('stone', -0.19, 0, 0.1, -0.07, 0.5, 0.24, c);
  pb.box('stone', 0.07, 0, 0.1, 0.19, 0.5, 0.24, c);
  // 鬃毛 + 头
  pb.lathe('stone', [[0.001, 0.56], [0.2, 0.6], [0.26, 0.74], [0.24, 0.9], [0.14, 0.98], [0.001, 1.0]], 10, c, 0, 0.06);
  pb.box('stone', -0.13, 0.66, 0.16, 0.13, 0.86, 0.34, c); // 面部
  pb.box('stone', -0.09, 0.66, 0.3, 0.09, 0.76, 0.38, 0xe8e2d6); // 口鼻
  // 绣球 / 幼狮（前爪下）
  pb.lathe('stone', [[0.001, 0.0], [0.09, 0.03], [0.11, 0.1], [0.09, 0.17], [0.001, 0.2]], 8, c, 0.2, 0.32);
}
/**
 * 石狮（含须弥座）：位置 (x, y0, z)，朝向 yaw（0 = 面朝 +Z），o: {h 总高（默认 2.4）, color}
 */
export function stoneLion(b, x, y0, z, yaw = 0, o = {}) {
  const H = o.h ?? 2.4;
  const ph = H * 0.38;
  const col = o.color ?? 0xd9d3c8;
  b.push(x, y0, z, yaw);
  const pw = H * 0.42, pd = H * 0.5;
  b.box('stone', -pw / 2 - 0.06, 0, -pd / 2 - 0.06, pw / 2 + 0.06, ph * 0.2, pd / 2 + 0.06, col, { skip: 'bottom' });
  b.box('stone', -pw / 2 + 0.05, ph * 0.2, -pd / 2 + 0.05, pw / 2 - 0.05, ph * 0.8, pd / 2 - 0.05, lin(col).map((v) => v * 0.94));
  b.box('stone', -pw / 2, ph * 0.8, -pd / 2, pw / 2, ph, pd / 2, col);
  b.push(0, ph, 0, 0, H - ph);
  b.proto('lion', lionF, col);
  b.pop();
  b.pop();
}
