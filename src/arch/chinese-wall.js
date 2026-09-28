// 中式古建构件库 —— 围护：隔扇门、槛窗、直棂窗、板门（门钉/门簪）、墙（下碱）、券门、城台（券洞/垛口）、院墙。
// 立面局部系：x = 从外向里看左→右，y 向上，+Z 朝外，墙（门窗）中面在 z=0。先 b.push(中点, 0, 0, side.yaw) 再调用。
import * as THREE from 'three';
import { lin, clamp, lerp, rng, palette, ArchBuilder } from './chinese-core.js';

// 窗棂图集单元（见 core makeLattice）：0 三交六椀菱花 1 正方格 2 步步锦 3 直棂
const LAT_CELL = [[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]];
/**
 * 格心：在 [x0,x1]×[y0,y1] 铺窗棂（alphaTest 透空），其后 3 cm 放一块透光纸面（glow，夜间按 lit 发暖光）。
 * o: {pattern 0~3, cell（单元尺寸米）, color, z, lit（0~1.5）, paper（白天纸面颜色）}
 */
export function latticePanel(b, x0, x1, y0, y1, o = {}) {
  const pat = o.pattern ?? 0;
  const cs = o.cell ?? (pat === 0 ? 0.42 : pat === 3 ? 0.5 : 0.36);
  const z = o.z ?? 0;
  const W = x1 - x0, H = y1 - y0;
  const nx = Math.max(1, Math.round(W / cs)), ny = Math.max(1, Math.round(H / cs));
  const [cu, cv] = LAT_CELL[pat];
  const col = o.color ?? 0x8a2a1c;
  if (b.detail >= 1) {
    const bk = b.bucket('lattice');
    const cl = lin(col);
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        const xa = x0 + (W * i) / nx, xb = x0 + (W * (i + 1)) / nx;
        const ya = y0 + (H * j) / ny, yb = y0 + (H * (j + 1)) / ny;
        const e = 0.003;
        const base = bk.count;
        b.vtx(bk, xa, ya, z, 0, 0, 1, cu + e, cv + e, cl);
        b.vtx(bk, xb, ya, z, 0, 0, 1, cu + 0.5 - e, cv + e, cl);
        b.vtx(bk, xb, yb, z, 0, 0, 1, cu + 0.5 - e, cv + 0.5 - e, cl);
        b.vtx(bk, xa, yb, z, 0, 0, 1, cu + e, cv + 0.5 - e, cl);
        b.quadIdx(bk, base, base + 1, base + 2, base + 3);
      }
  }
  glowQuad(b, x0, x1, y0, y1, z - 0.035, o.lit ?? 0.8, o.paper ?? 0x3a2f28);
}
/** 透光面（glow 材质：白天 = 顶点色；夜间暖光 × lit） */
export function glowQuad(b, x0, x1, y0, y1, z, lit = 1, color = 0x3a2f28) {
  const bk = b.bucket('glow');
  const cl = lin(color);
  const base = bk.count;
  b.vtx(bk, x0, y0, z, 0, 0, 1, lit, 0, cl);
  b.vtx(bk, x1, y0, z, 0, 0, 1, lit, 0, cl);
  b.vtx(bk, x1, y1, z, 0, 0, 1, lit, 1, cl);
  b.vtx(bk, x0, y1, z, 0, 0, 1, lit, 1, cl);
  b.quadIdx(bk, base, base + 1, base + 2, base + 3);
}

// 立面上的木框条（x0..x1, y0..y1, 厚 t 以 z 为中心）
function bar(b, x0, x1, y0, y1, z, t, col, mk = 'paint') {
  b.box(mk, x0, y0, z - t / 2, x1, y1, z + t / 2, col, { skip: 'bottom' });
}

/**
 * 一扇隔扇（五抹头）：左下角 (x, y)，宽 w、高 h。o: {pal, pattern, lit, carve(裙板金饰), style}
 */
function geshanLeaf(b, x, y, w, h, o) {
  const pal = o.pal;
  const fr = pal.frame, dc = pal.door;
  const d2 = b.detail >= 2;
  const sw = clamp(w * 0.075, 0.045, 0.085);
  const t = 0.07;
  if (!d2) {
    // 中景：门扇板 + 格心
    b.box('paint', x, y, -0.03, x + w, y + h * 0.36, 0.03, dc, { skip: 'bottom' });
    latticePanel(b, x + sw, x + w - sw, y + h * 0.4, y + h * 0.92, { pattern: o.pattern, color: pal.lattice, lit: o.lit, z: 0.01 });
    bar(b, x, x + w, y + h * 0.36, y + h * 0.4, 0, t, fr);
    bar(b, x, x + w, y + h * 0.92, y + h, 0, t, fr);
    bar(b, x, x + sw, y + h * 0.36, y + h, 0, t, fr);
    bar(b, x + w - sw, x + w, y + h * 0.36, y + h, 0, t, fr);
    return;
  }
  // 边梃
  bar(b, x, x + sw, y, y + h, 0, t, fr);
  bar(b, x + w - sw, x + w, y, y + h, 0, t, fr);
  // 抹头：0、裙板上、绦环上、格心上、顶
  const Y = [0, 0.3, 0.37, 0.88, 0.93, 1.0].map((k) => y + h * k);
  const rh = sw * 0.9;
  bar(b, x + sw, x + w - sw, Y[0], Y[0] + rh, 0, t, fr);
  bar(b, x + sw, x + w - sw, Y[1] - rh / 2, Y[1] + rh / 2, 0, t, fr);
  bar(b, x + sw, x + w - sw, Y[2] - rh / 2, Y[2] + rh / 2, 0, t, fr);
  bar(b, x + sw, x + w - sw, Y[3] - rh / 2, Y[3] + rh / 2, 0, t, fr);
  bar(b, x + sw, x + w - sw, Y[4] - rh / 2, Y[4] + rh / 2, 0, t, fr);
  bar(b, x + sw, x + w - sw, Y[5] - rh, Y[5], 0, t, fr);
  // 裙板、绦环板（凹入）
  b.box('paint', x + sw, Y[0] + rh, -0.018, x + w - sw, Y[1] - rh / 2, 0.018, dc, { skip: 'bottom' });
  b.box('paint', x + sw, Y[1] + rh / 2, -0.018, x + w - sw, Y[2] - rh / 2, 0.018, dc, { skip: 'bottom' });
  b.box('paint', x + sw, Y[4] + rh / 2, -0.018, x + w - sw, Y[5] - rh, 0.018, dc, { skip: 'bottom' });
  if (o.carve) {
    // 裙板如意云头（金/深色浮雕）
    const cx = x + w / 2, cy = (Y[0] + Y[1]) / 2, rw = (w - 2 * sw) * 0.36, rh2 = (Y[1] - Y[0]) * 0.3;
    b.prism('paint', [[cx - rw, cy], [cx - rw * 0.5, cy - rh2], [cx + rw * 0.5, cy - rh2], [cx + rw, cy], [cx + rw * 0.5, cy + rh2], [cx - rw * 0.5, cy + rh2]], 'z', 0.012, 0.03, o.carve);
  }
  // 格心
  latticePanel(b, x + sw, x + w - sw, Y[2] + rh / 2, Y[3] - rh / 2, { pattern: o.pattern, color: pal.lattice, lit: o.lit, z: 0 });
}

/**
 * 在一间内填充门窗墙。坐标：立面局部系，x0..x1（柱中线间），y0（地面/台明）.. y1（额枋底）。
 * kind: 'geshan' 隔扇门 | 'kanchuang' 槛窗 | 'zhiling' 直棂窗（唐）| 'banmen' 板门 | 'wall' 墙 | 'arch' 券门 | 'open' 空
 * o: {pal, style, D（柱径，门框让柱）, lit（夜间亮度 0~1.5，默认随机）, pattern（窗棂 0~3）, leaves, seed, carve,
 *     wallMat:'plaster'|'brick', wallColor, skirt（下碱高）, nails（门钉行列 [r,c]）}
 */
export function bayFill(b, kind, x0, x1, y0, y1, o = {}) {
  if (kind === 'open' || !kind) return;
  const style = o.style || b.style;
  const pal = o.pal || palette(style);
  const D = o.D ?? 0.5;
  const r = rng(o.seed ?? Math.floor((x0 * 131 + y0 * 71 + x1 * 17) * 100));
  const lit = o.lit ?? (r() < 0.8 ? 0.55 + r() * 0.6 : 0.12);
  const a = x0 + D * 0.5, c = x1 - D * 0.5; // 抱框内侧
  const W = c - a, H = y1 - y0;
  const d2 = b.detail >= 2;
  const fr = pal.frame;
  const pattern = o.pattern ?? (style === 'tang' ? 1 : 0);
  if (b.detail === 0) {
    // 远景：整间一块面（门窗 = 透光面；墙 = 抹灰）
    if (kind === 'wall') b.box(o.wallMat || 'plaster', x0, y0, -D * 0.3, x1, y1, D * 0.2, o.wallColor ?? pal.wall, { skip: 'bottom' });
    else glowQuad(b, x0, x1, y0, y1, 0.02, kind === 'kanchuang' || kind === 'geshan' || kind === 'zhiling' ? lit * 0.7 : 0, pal.door);
    return;
  }
  const frameT = 0.14;
  const postW = clamp(W * 0.03, 0.1, 0.16);
  const frameBox = (ya, yb) => {
    bar(b, a - 0.02, a + postW, ya, yb, 0, frameT, fr);
    bar(b, c - postW, c + 0.02, ya, yb, 0, frameT, fr);
  };
  if (kind === 'wall') {
    wallPanel(b, x0, x1, y0, y1, { ...o, pal, style, D });
    return;
  }
  if (kind === 'geshan' || kind === 'kanchuang') {
    // 上槛、（中槛 + 横披）、下槛 / 风槛
    const hasTransom = H > 3.4;
    const tH = hasTransom ? clamp(H * 0.17, 0.5, 1.2) : 0;
    const sillH = kind === 'geshan' ? 0.16 : 0.1;
    const topRail = 0.16;
    frameBox(y0, y1);
    bar(b, a, c, y1 - topRail, y1, 0, frameT, fr); // 上槛
    let yDoorTop = y1 - topRail;
    if (hasTransom) {
      const yM = y1 - topRail - tH;
      bar(b, a, c, yM - 0.14, yM, 0, frameT, fr); // 中槛
      latticePanel(b, a + postW, c - postW, yM, y1 - topRail, { pattern: pattern === 0 ? 1 : pattern, color: pal.lattice, lit, z: 0 });
      yDoorTop = yM - 0.14;
    }
    let yb = y0;
    if (kind === 'kanchuang') {
      // 槛墙（明清：下碱砖；唐：抹灰）+ 榻板 + 风槛
      const wallH = clamp(H * 0.3, 0.75, 1.1);
      const wm = style === 'tang' ? 'plaster' : 'brick';
      b.box(wm, a, y0, -0.2, c, y0 + wallH, 0.12, style === 'tang' ? pal.wall : 0xa8a49c, { skip: 'bottom' });
      b.box('stone', a - 0.02, y0 + wallH, -0.24, c + 0.02, y0 + wallH + 0.08, 0.2, pal.stone, {});
      yb = y0 + wallH + 0.08;
      bar(b, a, c, yb, yb + sillH, 0, frameT, fr);
      yb += sillH;
    } else {
      bar(b, a, c, y0, y0 + sillH, 0, frameT * 1.2, fr); // 下槛
      yb = y0 + sillH;
    }
    const n = o.leaves ?? (W > 4.2 ? 6 : W > 1.6 ? 4 : 2);
    const lw = (W - 2 * postW) / n;
    for (let i = 0; i < n; i++) {
      const lx = a + postW + i * lw;
      if (kind === 'geshan') geshanLeaf(b, lx + 0.005, yb, lw - 0.01, yDoorTop - yb, { pal, pattern, lit: lit * (0.85 + r() * 0.3), carve: o.carve, style });
      else {
        // 槛窗扇：格心 + 上下绦环
        const hh = yDoorTop - yb;
        const sw = clamp(lw * 0.075, 0.045, 0.085);
        bar(b, lx, lx + sw, yb, yDoorTop, 0, 0.07, fr);
        bar(b, lx + lw - sw, lx + lw, yb, yDoorTop, 0, 0.07, fr);
        bar(b, lx + sw, lx + lw - sw, yb, yb + sw, 0, 0.07, fr);
        bar(b, lx + sw, lx + lw - sw, yDoorTop - sw, yDoorTop, 0, 0.07, fr);
        if (d2) {
          bar(b, lx + sw, lx + lw - sw, yb + hh * 0.1, yb + hh * 0.1 + sw, 0, 0.07, fr);
          bar(b, lx + sw, lx + lw - sw, yDoorTop - hh * 0.1 - sw, yDoorTop - hh * 0.1, 0, 0.07, fr);
          b.box('paint', lx + sw, yb + sw, -0.015, lx + lw - sw, yb + hh * 0.1, 0.015, pal.door, { skip: 'bottom' });
          b.box('paint', lx + sw, yDoorTop - hh * 0.1, -0.015, lx + lw - sw, yDoorTop - sw, 0.015, pal.door, { skip: 'bottom' });
        }
        latticePanel(b, lx + sw, lx + lw - sw, yb + (d2 ? hh * 0.1 + sw : sw), yDoorTop - (d2 ? hh * 0.1 + sw : sw), { pattern, color: pal.lattice, lit: lit * (0.85 + r() * 0.3), z: 0 });
      }
    }
    return;
  }
  if (kind === 'zhiling') {
    // 唐：白壁 + 直棂窗（破子棂）
    const wallC = o.wallColor ?? pal.wall;
    const wy0 = y0 + H * 0.34, wy1 = y0 + H * 0.78;
    const wx0 = a + W * 0.12, wx1 = c - W * 0.12;
    wallPanel(b, x0, x1, y0, y1, { ...o, pal, style, D, hole: [wx0, wx1, wy0, wy1], wallColor: wallC });
    const fw = 0.12;
    bar(b, wx0 - fw, wx1 + fw, wy0 - fw, wy0, 0.02, 0.18, fr);
    bar(b, wx0 - fw, wx1 + fw, wy1, wy1 + fw, 0.02, 0.18, fr);
    bar(b, wx0 - fw, wx0, wy0, wy1, 0.02, 0.18, fr);
    bar(b, wx1, wx1 + fw, wy0, wy1, 0.02, 0.18, fr);
    const nb = Math.max(5, Math.round((wx1 - wx0) / 0.16));
    for (let i = 1; i < nb; i++) {
      const x = lerp(wx0, wx1, i / nb);
      if (d2) {
        // 破子棂：截面三角
        b.box('paint', x - 0.03, wy0, -0.02, x + 0.03, wy1, 0.05, fr, { skip: 'bottom' });
      } else b.box('paint', x - 0.03, wy0, -0.02, x + 0.03, wy1, 0.05, fr, { skip: 'bottom top' });
    }
    glowQuad(b, wx0, wx1, wy0, wy1, -0.06, lit, 0x2e2622);
    return;
  }
  if (kind === 'banmen' || kind === 'arch') {
    const doorH = Math.min(H - 0.3, o.doorH ?? Math.max(2.6, H * 0.72));
    const doorW = Math.min(W - 0.3, o.doorW ?? clamp(W * 0.72, 1.6, 4.2));
    const dx0 = (x0 + x1) / 2 - doorW / 2, dx1 = dx0 + doorW;
    if (kind === 'arch') {
      archWall(b, x0, x1, y0, y1, { ...o, pal, style, D, archW: doorW, archH: doorH });
    } else {
      // 余塞板 / 走马板（门上与两侧）
      wallPanel(b, x0, x1, y0, y1, { ...o, pal, style, D, hole: [dx0, dx1, y0, y0 + doorH], wallColor: o.wallColor ?? (style === 'tang' ? pal.wall : pal.frame), wallMat: style === 'tang' ? 'plaster' : 'paint', thin: style !== 'tang' });
      // 门框 + 中槛 + 门簪
      bar(b, dx0 - 0.16, dx0, y0, y0 + doorH + 0.2, 0.05, 0.2, fr);
      bar(b, dx1, dx1 + 0.16, y0, y0 + doorH + 0.2, 0.05, 0.2, fr);
      bar(b, dx0 - 0.16, dx1 + 0.16, y0 + doorH, y0 + doorH + 0.2, 0.05, 0.22, fr);
      if (d2)
        for (let k = 0; k < (doorW > 2.5 ? 4 : 2); k++) {
          const xm = lerp(dx0 + doorW * 0.18, dx1 - doorW * 0.18, (doorW > 2.5 ? 4 : 2) === 2 ? k : k / 3);
          b.box('paint', xm - 0.07, y0 + doorH + 0.03, 0.1, xm + 0.07, y0 + doorH + 0.17, 0.2, 0xc9973a);
        }
    }
    // 门扇（两扇，略凹）
    const lz = kind === 'arch' ? -(o.depth ?? 1.2) * 0.3 : -0.02;
    const dc = pal.door;
    for (const s of [0, 1]) {
      const xa = s ? (dx0 + dx1) / 2 : dx0, xb = s ? dx1 : (dx0 + dx1) / 2;
      b.box('paint', xa + 0.004, y0, lz - 0.05, xb - 0.004, y0 + doorH, lz + 0.05, dc, { skip: 'bottom' });
      if (d2) {
        // 门钉
        const [nr, nc] = o.nails ?? (style === 'tang' ? [5, 4] : [7, 5]);
        if (nr > 0) {
          const gold = o.nailColor ?? 0xc9973a;
          for (let i = 0; i < nr; i++)
            for (let j = 0; j < nc; j++) {
              const nx = lerp(xa + (xb - xa) * 0.16, xb - (xb - xa) * 0.16, nc > 1 ? j / (nc - 1) : 0.5);
              const ny = lerp(y0 + doorH * 0.12, y0 + doorH * 0.9, nr > 1 ? i / (nr - 1) : 0.5);
              b.push(nx, ny, lz + 0.05, 0);
              b.proto('nail', (pb) => {
                pb.push(new THREE.Matrix4().makeRotationX(Math.PI / 2));
                pb.lathe('metal', [[0.05, 0], [0.045, 0.012], [0.03, 0.036], [0.001, 0.045]], 6, 0xffffff);
                pb.pop();
              }, gold);
              b.pop();
            }
        }
        // 铺首（门环）
        const hx = s ? xa + 0.18 : xb - 0.18;
        b.push(hx, y0 + doorH * 0.5, lz + 0.05, 0);
        b.push(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        b.lathe('metal', [[0.11, 0], [0.09, 0.03], [0.001, 0.05]], 8, 0xb88a3a);
        b.pop();
        b.pop();
      }
    }
  }
}
/**
 * 墙面（抹灰/砖，下碱）：x0..x1、y0..y1；hole=[x0,x1,y0,y1] 可开洞（门窗洞）。
 * o: {pal, style, D, wallColor, wallMat, skirt（下碱高，明清默认 0.9m）, thin（薄板，如走马板）}
 */
export function wallPanel(b, x0, x1, y0, y1, o = {}) {
  const style = o.style || b.style;
  const pal = o.pal || palette(style);
  const D = o.D ?? 0.5;
  const t = o.thin ? 0.08 : o.t ?? D * 1.1;
  const zc = o.thin ? 0 : -t * 0.35;
  const mk = o.wallMat || 'plaster';
  const col = o.wallColor ?? pal.wall;
  const skirt = o.thin ? 0 : o.skirt ?? (style === 'tang' ? 0.35 : 0.9);
  const skirtC = style === 'tang' ? 0x8f3a26 : 0x9c9a94;
  const skirtM = style === 'tang' ? 'plaster' : 'brick';
  const rect = (xa, xb, ya, yb) => {
    if (xb - xa < 0.01 || yb - ya < 0.01) return;
    const ys = Math.max(ya, Math.min(yb, y0 + skirt));
    if (ys > ya + 0.01) b.box(skirtM, xa, ya, zc - t / 2 - 0.02, xb, ys, zc + t / 2 + 0.02, skirtC, { skip: 'bottom' });
    if (yb > ys + 0.01) b.box(mk, xa, ys, zc - t / 2, xb, yb, zc + t / 2, col, { skip: 'bottom' });
  };
  if (!o.hole) rect(x0, x1, y0, y1);
  else {
    const [hx0, hx1, hy0, hy1] = o.hole;
    rect(x0, hx0, y0, y1);
    rect(hx1, x1, y0, y1);
    rect(hx0, hx1, hy1, y1);
    rect(hx0, hx1, y0, hy0);
  }
}

/** 拱券轮廓（半圆 + 两侧直墙）：返回 [x,y] 点，自左下 → 拱顶 → 右下 */
export function archOutline(cx, y0, w, h, seg = 12) {
  const r = w / 2;
  const ys = y0 + Math.max(0, h - r);
  const pts = [[cx - r, y0]];
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI - (i / seg) * Math.PI;
    pts.push([cx + Math.cos(a) * r, ys + Math.sin(a) * r]);
  }
  pts.push([cx + r, y0]);
  return pts;
}
/**
 * 带券洞的墙：立面 x0..x1、y0..y1，券洞宽 archW、高 archH（含半圆），墙厚 depth（沿 z，外面 z=+depth/2）。
 * o: {mat:'brick'|'plaster', color, archs:[{cx, w, h}]（多洞）, frame（券脸石颜色）, pal}
 */
export function archWall(b, x0, x1, y0, y1, o = {}) {
  const depth = o.depth ?? 1.2;
  const mk = o.mat || (o.wallMat === 'brick' ? 'brick' : 'plaster');
  const col = o.color ?? o.wallColor ?? (o.pal ? o.pal.wall : 0xeeeeee);
  const seg = b.detail >= 2 ? 14 : b.detail === 1 ? 8 : 5;
  const archs = o.archs || [{ cx: (x0 + x1) / 2, w: o.archW ?? 2, h: o.archH ?? 3 }];
  // 立面多边形：底边依次绕过各券洞
  const poly = [[x0, y0]];
  for (const a of [...archs].sort((p, q) => p.cx - q.cx)) {
    const pts = archOutline(a.cx, y0, a.w, a.h, seg);
    poly.push(pts[0]);
    for (let i = 1; i < pts.length - 1; i++) poly.push(pts[i]);
    poly.push(pts[pts.length - 1]);
  }
  poly.push([x1, y0], [x1, y1], [x0, y1]);
  // 顺序为顺时针（底边左→右时洞在上方）；prism 会自动判断
  b.prism(mk, poly, 'z', -depth / 2, depth / 2, col);
  // 券脸（券石环）
  if (b.detail >= 1 && o.frame !== false)
    for (const a of archs) {
      const pts = archOutline(a.cx, y0, a.w, a.h, seg);
      const inner = pts.slice(1, -1);
      const k = o.frameW ?? clamp(a.w * 0.1, 0.18, 0.6);
      const outer = archOutline(a.cx, y0, a.w + 2 * k, a.h + k, seg).slice(1, -1);
      const ring = [...inner, ...[...outer].reverse()];
      b.prism(mk, ring, 'z', depth / 2, depth / 2 + 0.06, o.frameColor ?? shadeHex(col, 0.9));
    }
}
function shadeHex(c, k) {
  const v = lin(c);
  return [v[0] * k, v[1] * k, v[2] * k];
}

/**
 * 城台（墩台）：面宽 w（x）、进深 d（z）、高 h，券洞 tunnels 个（宽 tw、高 th，穿透 z 向），砖砌；顶面铺地、外沿垛口、内沿女墙。
 * o: {tunnels, tw, th, spacing, batter（收分：顶面每边内收米数）, crenel:true, parapetH, capColor, color, plinth（石基高）, door:'banmen'|null}
 * 返回 {topY:h, topW, topD}
 */
export function cityPlatform(b, o) {
  const w = o.w, d = o.d, h = o.h;
  const bat = o.batter ?? h * 0.06;
  const nT = o.tunnels ?? 1;
  const tw = o.tw ?? 6, th = o.th ?? Math.min(h * 0.62, tw * 1.35);
  const sp = o.spacing ?? tw * 1.9;
  const col = o.color ?? 0x8e8a82;
  const mk = 'brick';
  const archs = [];
  for (let i = 0; i < nT; i++) archs.push({ cx: (i - (nT - 1) / 2) * sp, w: tw, h: th });
  // 主体：立面带券洞的棱柱（在临时 builder 中建模后逐顶点剪切出前后收分，再并入 b）
  const seg = b.detail >= 2 ? 16 : b.detail === 1 ? 10 : 6;
  const poly = [[-w / 2, 0]];
  for (const a of archs) for (const p of archOutline(a.cx, 0, a.w, a.h, seg)) poly.push(p);
  poly.push([w / 2, 0], [w / 2 - bat, h], [-w / 2 + bat, h]);
  const tb = new ArchBuilder(b.ctx, { detail: b.detail, style: b.style });
  tb.prism(mk, poly, 'z', -d / 2, d / 2, col);
  if (b.detail >= 1)
    for (const a of archs) {
      const inner = archOutline(a.cx, 0, a.w, a.h, seg).slice(1, -1);
      const k = clamp(a.w * 0.08, 0.3, 0.7);
      const outer = archOutline(a.cx, 0, a.w + 2 * k, a.h + k, seg).slice(1, -1);
      const ring = [...inner, ...[...outer].reverse()];
      for (const sg of [1, -1]) tb.prism(mk, ring, 'z', sg > 0 ? d / 2 - 0.01 : -d / 2 - 0.07, sg > 0 ? d / 2 + 0.07 : -d / 2 + 0.01, shadeHex(col, 0.9));
    }
  for (const [key, bk] of tb.buckets) {
    const P = bk.p.a, N = bk.n.a;
    for (let i = 0; i < bk.count; i++) {
      const z = P[i * 3 + 2];
      if (Math.abs(z) > d / 2 - 0.2) {
        const sg = Math.sign(z);
        P[i * 3 + 2] = z - sg * bat * clamp(P[i * 3 + 1] / h, 0, 1);
        if (Math.abs(N[i * 3 + 2]) > 0.9) {
          const ny = (bat / h) * Math.abs(N[i * 3 + 2]);
          const l = Math.hypot(ny, 1);
          N[i * 3 + 1] = ny / l;
          N[i * 3 + 2] = N[i * 3 + 2] / l;
        }
      }
    }
    b.geometry(key, bk.toGeometry(), 0xffffff);
  }
  // 石基（土衬）
  const plinth = o.plinth ?? 0.6;
  if (plinth > 0) {
    // 土衬石在券洞两侧也外凸 0.12（原先端面与券洞侧壁齐平，共面闪烁）
    const xs = [-w / 2 - 0.15];
    for (const a of archs) xs.push(a.cx - a.w / 2 + 0.12, a.cx + a.w / 2 - 0.12);
    xs.push(w / 2 + 0.15);
    for (let i = 0; i < xs.length; i += 2) b.box('stone', xs[i], -0.05, -d / 2 - 0.15, xs[i + 1], plinth, d / 2 + 0.15, 0xb9b2a6, { skip: 'bottom' });
  }
  // 顶面海墁（铺砖）
  const tw2 = w - 2 * bat, td2 = d - 2 * bat;
  b.box('brick', -tw2 / 2, h - 0.02, -td2 / 2, tw2 / 2, h + 0.08, td2 / 2, o.capColor ?? 0x7e7a72, { skip: 'bottom' });
  // 垛口（外）与女墙（内）：此处四周都做垛口；o.inner 指定哪些边用矮女墙
  if (o.crenel !== false && b.detail >= 1) {
    const ph = o.parapetH ?? 1.9;
    const cw = 1.6, gap = 0.55, low = ph * 0.55;
    const edges = [
      [[-tw2 / 2, td2 / 2], [tw2 / 2, td2 / 2], 'front'],
      [[tw2 / 2, td2 / 2], [tw2 / 2, -td2 / 2], 'right'],
      [[tw2 / 2, -td2 / 2], [-tw2 / 2, -td2 / 2], 'back'],
      [[-tw2 / 2, -td2 / 2], [-tw2 / 2, td2 / 2], 'left'],
    ];
    for (const [p0, p1, name] of edges) {
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const ex = (p1[0] - p0[0]) / L, ez = (p1[1] - p0[1]) / L;
      const inner = (o.inner || []).includes(name);
      const tP = 0.5;
      const nx = -ez, nz = ex; // 外法线
      const off = -tP / 2; // 墙外皮与台边齐
      // yl..yh：墙段高度区间（相对台顶）。垛口只做矮墙以上部分，不再与矮墙重叠共面
      const segWall = (s0, s1, yh, yl = 0) => {
        const ax = p0[0] + ex * s0 + nx * off, az = p0[1] + ez * s0 + nz * off;
        const bx = p0[0] + ex * s1 + nx * off, bz = p0[1] + ez * s1 + nz * off;
        const sx = nx * tP / 2, sz = nz * tP / 2;
        const A = [ax + sx, az + sz], B = [bx + sx, bz + sz], C = [bx - sx, bz - sz], Dd = [ax - sx, az - sz];
        const y0 = h + 0.08 + yl, y1 = h + 0.08 + yh;
        b.quad(mk, [A[0], y0, A[1]], [B[0], y0, B[1]], [B[0], y1, B[1]], [A[0], y1, A[1]], col);
        b.quad(mk, [C[0], y0, C[1]], [Dd[0], y0, Dd[1]], [Dd[0], y1, Dd[1]], [C[0], y1, C[1]], col);
        b.quad(mk, [A[0], y1, A[1]], [B[0], y1, B[1]], [C[0], y1, C[1]], [Dd[0], y1, Dd[1]], col);
        b.quad(mk, [B[0], y0, B[1]], [C[0], y0, C[1]], [C[0], y1, C[1]], [B[0], y1, B[1]], col);
        b.quad(mk, [Dd[0], y0, Dd[1]], [A[0], y0, A[1]], [A[0], y1, A[1]], [Dd[0], y1, Dd[1]], col);
      };
      // 转角：每边矮墙止于下一边墙内皮（L - tP），转角方块只由下一边占据，避免端面与相邻墙外皮共面
      if (inner) {
        segWall(0, L - tP, low);
        continue;
      }
      segWall(0, L - tP, low);
      const n = Math.max(1, Math.floor((L - tP + gap) / (cw + gap)));
      const used = n * cw + (n - 1) * gap;
      let s = (L - tP - used) / 2;
      for (let i = 0; i < n; i++) {
        segWall(s, s + cw, ph, low);
        s += cw + gap;
      }
    }
  }
  return { topY: h + 0.08, topW: tw2, topD: td2, archs };
}

/**
 * 院墙（沿折线）：pts=[[x,z]...]，h 墙高，t 厚，顶部两坡瓦帽（筒瓦面用 tileFlat）。o: {color, capColor, closed, skirt, y0}
 * 转角处理（防共面闪烁）：每段起点外伸 t/2 占住转角方块，终点缩回 t/2 抵到下一段内皮；
 * 相邻段瓦帽/脊交叉处底面同高会共面，故逐段错开 1.5 cm。
 * o.ext0 / o.ext1：覆盖首段起点、末段终点的外伸量（开口折线默认两端都外伸 t/2）。
 * o.ys：每个折点的墙脚高度（可选，逐段取两端较低者，墙高随之补足，用于顺地形的院墙）。
 */
export function yardWall(b, pts, o = {}) {
  const h = o.h ?? 3.2, t = o.t ?? 0.6;
  const col = o.color ?? 0xa4382a;
  const capC = o.capColor ?? 0x6e7176;
  const skirt = o.skirt ?? 0.8;
  const n = pts.length;
  const segs = o.closed ? n : n - 1;
  // 顺地形分段时各段墙顶高（墙脚取两端较低者、墙高补足到较高端 + h）
  const topOf = (i) => (o.ys ? Math.max(o.ys[i], o.ys[(i + 1) % n]) + h : h);
  const dirOf = (i) => {
    const a = pts[i], c = pts[(i + 1) % n];
    return Math.atan2(c[1] - a[1], c[0] - a[0]);
  };
  for (let i = 0; i < segs; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const L = Math.hypot(dx, dz);
    if (L < 0.05) continue;
    const yaw = Math.atan2(dz, dx);
    // 起点外伸 t/2（占转角）；终点：闭合或非末段缩回 t/2，开口末段外伸
    const e0 = i === 0 && !o.closed ? o.ext0 ?? t * 0.5 : t * 0.5;
    const e1 = i === segs - 1 && !o.closed ? o.ext1 ?? t * 0.5 : -t * 0.5;
    const s1 = e1 < 0 ? e1 - 0.03 : e1; // 墙脚比墙身宽 0.03，终点再缩 0.03 抵到下一段墙脚内皮
    let y0 = o.y0 ?? 0, hh = h;
    if (o.ys) {
      const ya = o.ys[i], yb = o.ys[(i + 1) % n];
      y0 = Math.min(ya, yb);
      hh = h + Math.abs(ya - yb);
    }
    const dy = (i % 2) * 0.015 + (o.closed && segs % 2 && i === segs - 1 ? 0.015 : 0);
    b.push((p0[0] + p1[0]) / 2, y0, (p0[1] + p1[1]) / 2, -yaw);
    b.box('brick', -L / 2 - e0, 0, -t / 2 - 0.03, L / 2 + s1, skirt, t / 2 + 0.03, 0x9c9a94, { skip: 'bottom' });
    b.box('plaster', -L / 2 - e0, skirt, -t / 2, L / 2 + e1, hh, t / 2, col, { skip: 'bottom' });
    // 瓦帽：两坡 + 脊
    const ov = 0.22, rh = 0.42;
    const cap = [[-t / 2 - ov, 0], [t / 2 + ov, 0], [0.06, rh], [-0.06, rh]];
    // 瓦帽终点：缩回到下一段墙内皮（再退 2 cm，不与更高的下一段墙身接触面重合）
    const c1 = e1 < 0 ? e1 - 0.02 : e1 + 0.1;
    // 瓦帽起点：前一段墙更高（地形台阶）时，瓦帽不能伸进前一段墙身——直线相接止于接缝，转角处让过转角方块
    let c0 = -L / 2 - e0 - 0.1;
    const prev = i > 0 ? i - 1 : o.closed ? segs - 1 : -1;
    if (o.ys && prev >= 0 && topOf(prev) > topOf(i) + 0.01) {
      let da = Math.abs(dirOf(i) - dirOf(prev)) % (2 * Math.PI);
      if (da > Math.PI) da = 2 * Math.PI - da;
      c0 = da > 0.2 ? -L / 2 - e0 + t + 0.02 : -L / 2 - e0 + 0.02;
    }
    b.prism(b.detail >= 1 ? 'tileFlat' : 'tileFlat', cap.map(([p, q]) => [p, hh + dy + q]), 'x', c0, L / 2 + c1, capC);
    b.box('ridge', c0, hh + dy + rh - 0.04, -0.09, L / 2 + c1, hh + dy + rh + 0.12, 0.09, 0x55585c, {});
    b.pop();
  }
}
