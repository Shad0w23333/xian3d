// 历史文化地标专用构件（heritage 模块）：唐代密檐砖塔（小雁塔）、唐代城门遗址保护建筑（丹凤门）、
// 夯土遗址台基、夯土宫墙、现代仿唐体块（白墙 + 窗带）。全部写入 chinese-core 的 ArchBuilder（按材质合并）。
// 坐标约定同构件库：局部原点 = 平面中心地面，正面朝 +Z（南），Y 向上。
import { steps, balustrade, glowQuad, hall } from './chinese.js';

const rnd = (s) => {
  let t = s >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

/** 竖直面上的券形（半圆拱）开口轮廓：底边 y0，宽 w，总高 h */
function archPoly(cx, y0, w, h, seg = 8) {
  const r = w / 2, ys = y0 + h - r;
  const p = [[cx - r, y0], [cx + r, y0], [cx + r, ys]];
  for (let i = 1; i < seg; i++) {
    const a = (i / seg) * Math.PI;
    p.push([cx + r * Math.cos(a), ys + r * Math.sin(a)]);
  }
  p.push([cx - r, ys]);
  return p;
}

/** 在立面（局部 z = zf，朝 +Z）上做券窗：深色洞口 + 砖券边（detail≥1） */
function archWindow(b, cx, y0, w, h, zf, o = {}) {
  const dark = o.dark ?? 0x221e1b;
  b.prism('paint', archPoly(cx, y0, w, h), 'z', zf - 0.25, zf + 0.015, dark);
  if (b.detail >= 1 && o.frame !== false) {
    const t = Math.max(0.12, w * 0.12);
    const outer = archPoly(cx, y0 - 0.02, w + 2 * t, h + t, 10);
    // 券脸：外轮廓薄片（略凸出墙面），内部再盖深色洞口（上面已画，略前移）
    b.prism('brick', outer, 'z', zf - 0.05, zf + 0.008, o.frameColor ?? 0xa89a86);
  }
}

/**
 * 唐代方形密檐砖塔（小雁塔）。o: {floors 13, baseW 11.38（底层边长）, firstH 6.83（底层高）, totalH 40.2（塔身高，不含台基）,
 *   topW（顶层宽/底宽，默认 0.5）, podium {w 23.38, h 3.2}, color, broken（塔顶残缺）}
 * 返回 {topY, podiumTop, widths}
 */
export function denseEavePagoda(b, o = {}) {
  const N = o.floors ?? 13;
  const W0 = o.baseW ?? 11.38;
  const col = o.color ?? 0xb4a792; // 灰黄旧砖
  const colDark = o.colorDark ?? 0x9a8d79;
  const PW = o.podium?.w ?? 23.38, PH = o.podium?.h ?? 3.2;
  const y0 = o.y0 ?? 0;
  const R = rnd(7);
  // —— 台基：砖表土心方台 + 压沿石 + 南北踏步 ——
  b.box('stone', -PW / 2 - 0.3, y0 - 0.2, -PW / 2 - 0.3, PW / 2 + 0.3, y0 + 0.35, PW / 2 + 0.3, 0xbab2a4, { skip: 'bottom' });
  b.box('brick', -PW / 2, y0 + 0.35, -PW / 2, PW / 2, y0 + PH - 0.28, PW / 2, colDark, { skip: 'bottom' });
  b.box('stone', -PW / 2 - 0.12, y0 + PH - 0.28, -PW / 2 - 0.12, PW / 2 + 0.12, y0 + PH, PW / 2 + 0.12, 0xc4bcae, { skip: 'bottom' });
  for (const [z, yaw] of [[PW / 2, 0], [-PW / 2, Math.PI]]) {
    b.push(0, 0, z, yaw);
    steps(b, { w: 4.2, h: PH, y0, color: 0xc2baac });
    b.pop();
  }
  if (b.detail >= 1) {
    const e = PW / 2 - 0.3, g = 2.8;
    balustrade(b, [[g, y0 + PH, e], [e, y0 + PH, e], [e, y0 + PH, -e], [g, y0 + PH, -e]], { kind: 'stone', h: 0.9, color: 0xc9c2b4 });
    balustrade(b, [[-g, y0 + PH, -e], [-e, y0 + PH, -e], [-e, y0 + PH, e], [-g, y0 + PH, e]], { kind: 'stone', h: 0.9, color: 0xc9c2b4 });
  }
  // —— 塔身：底层高大，二层以上高、宽递减（卷刹：下缓上急的凸曲线） ——
  const firstH = o.firstH ?? 6.83;
  const totalH = o.totalH ?? 40.2;
  const topK = o.topW ?? 0.5;
  const Wf = (i) => W0 * (1 - (1 - topK) * Math.pow(i / N, 1.55));
  // 二层以上层高线性递减，总和 = totalH - firstH
  const rest = totalH - firstH;
  const hTop = (2 * rest) / (N - 1) / 1.45; // 顶层高
  const hSecond = hTop * 1.45;
  const Hf = (i) => (i === 0 ? firstH : hSecond + ((hTop - hSecond) * (i - 1)) / Math.max(1, N - 2));
  let y = y0 + PH;
  const widths = [];
  for (let i = 0; i < N; i++) {
    const w = Wf(i), wn = Wf(i + 1);
    widths.push(w);
    const hs = Hf(i);
    // 出檐：底层最深，向上逐渐减小
    const proj = (i === 0 ? 1.05 : 0.95 - 0.35 * (i / N)) * (W0 / 11.38);
    const courses = b.detail >= 2 ? (i === 0 ? 7 : 6) : b.detail === 1 ? 3 : 1;
    const back = b.detail >= 2 ? 4 : b.detail === 1 ? 2 : 1;
    const ct = i === 0 ? 0.14 : 0.12 - 0.02 * (i / N); // 每皮砖厚（含灰缝）
    const eaveH = 0.2 + (b.detail >= 2 ? courses : i === 0 ? 7 : 6) * ct + (b.detail >= 2 ? back : 4) * ct;
    const bodyH = Math.max(0.6, hs - eaveH);
    const last = i === N - 1;
    const bodyTop = y + (last && o.broken !== false ? bodyH * 0.75 : bodyH);
    // 塔身（略收分）
    b.frustum('brick', 0, 0, y, w, w, bodyTop, w - 0.04, w - 0.04, col, { noTop: !last });
    // 券窗（南北面居中）/ 底层券门（带石门楣）
    for (const s of [1, -1]) {
      b.push(0, 0, 0, s > 0 ? 0 : Math.PI);
      const zf = w / 2 - 0.01;
      if (i === 0) {
        const dw = 1.9, dh = 3.9;
        // 石门框 + 门楣（青石线刻）
        b.box('stone', -dw / 2 - 0.45, y, zf - 0.02, dw / 2 + 0.45, y + dh + 0.55, zf + 0.12, 0x8f8c86, { skip: 'bottom' });
        b.prism('paint', archPoly(0, y, dw, dh), 'z', zf - 0.5, zf + 0.13, 0x1d1a18);
        if (b.detail >= 1) glowQuad(b, -dw / 2 + 0.1, dw / 2 - 0.1, y + 0.1, y + dh - dw / 2, zf - 0.45, 0.45, 0x2a221c);
      } else if (bodyH > 0.9) {
        const ww = Math.min(1.1, w * 0.1), wh = Math.min(bodyH * 0.72, 1.6);
        archWindow(b, 0, y + (bodyH - wh) * 0.45, ww, wh, zf, { frame: b.detail >= 1 });
      }
      b.pop();
    }
    if (last && o.broken !== false) {
      // 塔顶残缺（1556 年大地震震毁上两层）：参差残砖 + 杂草
      for (let k = 0; k < 9; k++) {
        const a = R() * Math.PI * 2, r = R() * w * 0.35;
        const sx = 0.8 + R() * 1.6, sz = 0.8 + R() * 1.6;
        const hh = 0.3 + R() * 1.1;
        b.box('brick', Math.cos(a) * r - sx / 2, bodyTop - 0.1, Math.sin(a) * r - sz / 2, Math.cos(a) * r + sx / 2, bodyTop + hh, Math.sin(a) * r + sz / 2, k % 2 ? col : colDark, { skip: 'bottom' });
      }
      for (let k = 0; k < 5; k++) {
        const a = R() * Math.PI * 2, r = w * (0.2 + R() * 0.2);
        b.cyl('paint', Math.cos(a) * r, bodyTop, Math.sin(a) * r, 0.5 + R() * 0.4, 0.15, 0.7 + R() * 0.6, 6, 0x5a6a3a);
      }
      y = bodyTop;
      break;
    }
    y = bodyTop;
    // 檐：斜角牙砖（菱角牙子）带 + 叠涩出挑 + 反叠涩收进
    let cw = w;
    b.frustum('brick', 0, 0, y, cw, cw, y + 0.2, cw + 0.1, cw + 0.1, colDark, {});
    if (b.detail >= 2) {
      // 菱角牙子：每面一排三角齿
      const n = Math.max(8, Math.round(cw / 0.42));
      for (let s = 0; s < 4; s++) {
        b.push(0, 0, 0, (s * Math.PI) / 2);
        const zf = cw / 2 + 0.05;
        for (let k = 0; k < n; k++) {
          const x0 = -cw / 2 + (k * cw) / n, x1 = x0 + cw / n, xm = (x0 + x1) / 2;
          b.triangle('brick', [x0, y + 0.2, zf], [xm, y + 0.02, zf + 0.001], [x1, y + 0.2, zf], 0x8a7e6c);
        }
        b.pop();
      }
    }
    y += 0.2;
    cw += 0.1;
    const step = (proj - 0.05) / courses;
    for (let k = 0; k < courses; k++) {
      const hh = b.detail >= 2 ? ct : (ct * (i === 0 ? 7 : 6)) / courses;
      b.box('brick', -(cw + step * 2) / 2, y, -(cw + step * 2) / 2, (cw + step * 2) / 2, y + hh, (cw + step * 2) / 2, k % 2 ? col : 0xa99c87, { skip: 'bottom' });
      cw += step * 2;
      y += hh;
    }
    // 反叠涩：收进到上层塔身宽度
    const backs = b.detail >= 2 ? back : 1;
    const totalBack = (b.detail >= 2 ? back : 4) * ct;
    for (let k = 0; k < backs; k++) {
      const t = (k + 1) / backs;
      const w1 = cw + (wn - cw) * t;
      const hh = totalBack / backs;
      if (b.detail >= 2) b.box('brick', -w1 / 2, y, -w1 / 2, w1 / 2, y + hh, w1 / 2, col, { skip: 'bottom' });
      else b.frustum('brick', 0, 0, y, cw, cw, y + hh, wn, wn, col, {});
      y += hh;
    }
  }
  return { topY: y, podiumTop: y0 + PH, widths };
}

/** 两点间的夯土墙（遗址宫墙）：宽 t、高 h，顶面略收分 */
export function earthWall(b, p0, p1, o = {}) {
  const h = o.h ?? 1.6, t = o.t ?? 3.2;
  const col = o.color ?? 0xa88d6c;
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
  const L = Math.hypot(dx, dz);
  if (L < 0.5) return;
  b.push((p0[0] + p1[0]) / 2, o.y0 ?? 0, (p0[1] + p1[1]) / 2, -Math.atan2(dz, dx));
  // 局部 x 沿墙
  const q = [[-t / 2, 0], [t / 2, 0], [t / 2 - h * 0.18, h], [-t / 2 + h * 0.18, h]];
  b.prism('plaster', q, 'x', -L / 2, L / 2, col, { capColor: o.topColor ?? 0x8f8a5c });
  // 夯层纹（细横线，近看可见）
  if (b.detail >= 2 && h > 1) {
    for (let y = 0.35; y < h - 0.1; y += 0.35) {
      const inset = (y / h) * h * 0.18;
      for (const s of [1, -1]) b.box('plaster', -L / 2, y, s * (t / 2 - inset) - 0.02, L / 2, y + 0.05, s * (t / 2 - inset) + 0.02, 0x96795a, {});
    }
  }
  b.pop();
}

/**
 * 夯土遗址台基（分层收台，砖包边 + 夯土墙面 + 顶面碎石/草），tiers: [{w, d, h, x?, z?}...] 自下而上
 * 返回顶面高度
 */
export function ruinTerrace(b, tiers, o = {}) {
  let y = o.y0 ?? 0;
  const earth = o.color ?? 0xab8e6a, brick = o.brickColor ?? 0x8e8374, top = o.topColor ?? 0x9d9272;
  for (const t of tiers) {
    const x = t.x ?? 0, z = t.z ?? 0;
    const bt = t.batter ?? 0.25;
    b.frustum('plaster', x, z, y, t.w, t.d, y + t.h - 0.25, t.w - bt * 2, t.d - bt * 2, earth, { noTop: true });
    // 顶面包砖压沿
    b.box('brick', x - t.w / 2 + bt - 0.1, y + t.h - 0.25, z - t.d / 2 + bt - 0.1, x + t.w / 2 - bt + 0.1, y + t.h, z + t.d / 2 - bt + 0.1, brick, {
      skip: 'bottom',
      colors: { top: top },
    });
    // 夯层纹
    if (b.detail >= 2 && t.h > 1.5) {
      for (let yy = y + 0.45; yy < y + t.h - 0.4; yy += 0.45) {
        const k = (yy - y) / t.h;
        const w = t.w - bt * 2 * k, d = t.d - bt * 2 * k;
        b.frustum('plaster', x, z, yy, w + 0.04, d + 0.04, yy + 0.05, w + 0.04, d + 0.04, 0x94775a, { noTop: true });
      }
    }
    y += t.h;
  }
  return y;
}

/** 柱础阵列（遗址台面上的础石） */
export function columnBases(b, xs, zs, y, o = {}) {
  if (b.detail < 1) return;
  const r = o.r ?? 0.7;
  for (const x of xs) for (const z of zs) b.cyl('stone', x, y, z, r, r * 0.85, o.h ?? 0.35, 10, o.color ?? 0xb9b1a2);
}

/**
 * 现代仿唐体块：白墙方盒 + 横向窗带（夜间亮窗）+ 勒脚。o: {w, d, h, y0, floors, color, winColor, sides:['front','back','left','right']}
 */
export function whiteBlock(b, o) {
  const { w, d, h } = o;
  const y0 = o.y0 ?? 0;
  const col = o.color ?? 0xece8e0;
  b.box('stone', -w / 2 - 0.15, y0, -d / 2 - 0.15, w / 2 + 0.15, y0 + 0.9, d / 2 + 0.15, 0xb4ada2, { skip: 'bottom' });
  b.box('plaster', -w / 2, y0 + 0.9, -d / 2, w / 2, y0 + h, d / 2, col, { skip: 'bottom' });
  const floors = o.floors ?? Math.max(1, Math.round(h / 4.5));
  if (o.windows === false || b.detail < 1) return;
  const R = rnd(o.seed ?? 3);
  const fh = (h - 1.2) / floors;
  const sides = o.sides ?? ['front', 'back', 'left', 'right'];
  const defs = { front: [0, d / 2, w], back: [Math.PI, d / 2, w], left: [-Math.PI / 2, w / 2, d], right: [Math.PI / 2, w / 2, d] };
  for (const s of sides) {
    const [yaw, off, len] = defs[s];
    b.push(0, 0, 0, yaw);
    const bay = o.bay ?? 4.2;
    const n = Math.max(1, Math.floor((len - 3) / bay));
    const x0 = -(n * bay) / 2;
    for (let f = 0; f < floors; f++) {
      const yb = y0 + 1.2 + f * fh + fh * 0.28, yt = yb + fh * 0.5;
      for (let k = 0; k < n; k++) {
        const xa = x0 + k * bay + bay * 0.22, xb = x0 + (k + 1) * bay - bay * 0.22;
        glowQuad(b, xa, xb, yb, yt, off + 0.03, R() < 0.55 ? 0.35 + R() * 0.5 : 0.05, o.winColor ?? 0x2e3438);
        if (b.detail >= 2) b.box('paint', xa - 0.12, yb - 0.14, off, xb + 0.12, yb, off + 0.16, 0xd9d4ca, { skip: 'bottom' });
      }
    }
    b.pop();
  }
}

/** 单色（淡棕黄）调色板：丹凤门遗址保护建筑“从上到下全部为淡棕黄色” */
export function monoPalette(c = 0xc9ab80) {
  const k = (m) => {
    const r = ((c >> 16) & 255) * m, g = ((c >> 8) & 255) * m, bb = (c & 255) * m;
    return (Math.min(255, r | 0) << 16) | (Math.min(255, g | 0) << 8) | Math.min(255, bb | 0);
  };
  return {
    col: k(0.93), colBase: k(1.0), wall: k(1.06), frame: k(0.88), door: k(0.82), lattice: k(0.84),
    dou: k(0.98), gong: k(0.94), ang: k(0.94), armEnd: k(1.08), panel: k(1.05), rafter: k(0.9), rafterEnd: k(1.08),
    flyEnd: k(1.08), soffit: k(0.86), fascia: k(0.9), stone: k(1.02), gable: k(1.04), boFeng: k(0.92), railing: k(0.92),
    beamRow: 3, plankRow: 3,
  };
}

/**
 * 丹凤门遗址保护展示建筑（张锦秋设计，2010）：门址东西 74.5 m、南北 33 m，五门道各宽 8.5 m、隔墙厚 3.8 m；
 * 墩台 + 单檐庑殿门楼 + 两侧城墙（马道），整体淡棕黄色，高约 33 m。原点 = 墩台中心地面，正面 +Z（南）。
 */
export function danfengGate(b, o = {}) {
  const T = o.color ?? 0xc9ab80;
  const L = 74.5, D = 33, H = o.h ?? 14.5;
  const dw = 8.5, wall = 3.8, doorH = 9.4, ch = 1.7;
  const endW = (L - 5 * dw - 4 * wall) / 2;
  const cols = [];
  // 基座勒脚
  b.box('stone', -L / 2 - 0.4, -0.2, -D / 2 - 0.4, L / 2 + 0.4, 0.8, D / 2 + 0.4, 0xb89e78, { skip: 'bottom' });
  // 墩：两端墩 + 四道隔墙
  const piers = [[-L / 2, -L / 2 + endW]];
  for (let k = 0; k < 5; k++) {
    const xl = -L / 2 + endW + k * (dw + wall);
    cols.push([xl, xl + dw]);
    if (k < 4) piers.push([xl + dw, xl + dw + wall]);
  }
  piers.push([L / 2 - endW, L / 2]);
  for (const [a, c] of piers) b.box('plaster', a, 0.8, -D / 2, c, H, D / 2, T, { skip: 'bottom' });
  for (const [xl, xr] of cols) {
    // 门道上方过梁体 + 抹角（唐代排叉柱过梁式门道的梯形顶）
    b.box('plaster', xl, doorH + ch, -D / 2, xr, H, D / 2, T, { skip: '' });
    b.prism('plaster', [[xl, doorH], [xl + ch, doorH + ch], [xl, doorH + ch]], 'z', -D / 2, D / 2, T);
    b.prism('plaster', [[xr, doorH], [xr, doorH + ch], [xr - ch, doorH + ch]], 'z', -D / 2, D / 2, T);
    // 门道内：中部玻璃隔断（遗址展厅），夜间透出暖光
    b.box('paint', xl, 0.8, -0.3, xr, doorH + ch, 0.3, 0x2a2e30, {});
    glowQuad(b, xl + 0.3, xr - 0.3, 0.9, doorH + ch * 0.6, 0.32, 0.9, 0x3a3630);
    // 门道地面（遗址路土）
    b.box('stone', xl, 0.0, -D / 2, xr, 0.12, D / 2, 0x9c8466, {});
  }
  // 墩台顶：腰线 + 平座挑檐 + 女墙
  b.box('plaster', -L / 2 - 0.35, H - 1.0, -D / 2 - 0.35, L / 2 + 0.35, H - 0.6, D / 2 + 0.35, 0xbf9f74, { skip: '' });
  b.box('plaster', -L / 2 - 0.15, H - 0.6, -D / 2 - 0.15, L / 2 + 0.15, H, D / 2 + 0.15, 0xd1b58c, { skip: 'bottom' });
  if (b.detail >= 1) {
    const e = 0.4;
    const run = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / 2.4));
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 0.62) / n;
        const xa = x0 + (x1 - x0) * t0, xb = x0 + (x1 - x0) * t1, za = z0 + (z1 - z0) * t0, zb = z0 + (z1 - z0) * t1;
        b.box('plaster', Math.min(xa, xb) - e, H, Math.min(za, zb) - e, Math.max(xa, xb) + e, H + 1.1, Math.max(za, zb) + e, 0xcfb48a, { skip: 'bottom' });
      }
    };
    const x = L / 2 - 0.4, z = D / 2 - 0.4;
    run(-x, z, x, z);
    run(-x, -z, x, -z);
    run(-x, -z, -x, z);
    run(x, -z, x, z);
  }
  // 两侧城墙（向东西延伸约 70 m，顶面向外渐低）+ 北侧马道
  const WL = o.wingL ?? 70, WD = 16;
  for (const s of [1, -1]) {
    const xa = s * (L / 2), xb = s * (L / 2 + WL);
    const h0 = H - 3.2, h1 = 5.0;
    const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
    const hx0 = s > 0 ? h0 : h1, hx1 = s > 0 ? h1 : h0;
    const z0 = -WD / 2, z1 = WD / 2;
    // 南立面、北立面、端面、顶面
    b.quad('plaster', [x0, 0, z1], [x1, 0, z1], [x1, hx1, z1], [x0, hx0, z1], T);
    b.quad('plaster', [x1, 0, z0], [x0, 0, z0], [x0, hx0, z0], [x1, hx1, z0], T);
    const xe = s > 0 ? x1 : x0;
    const he = h1;
    if (s > 0) b.quad('plaster', [xe, 0, z1], [xe, 0, z0], [xe, he, z0], [xe, he, z1], T);
    else b.quad('plaster', [xe, 0, z0], [xe, 0, z1], [xe, he, z1], [xe, he, z0], T);
    b.quad('plaster', [x0, hx0, z1], [x1, hx1, z1], [x1, hx1, z0], [x0, hx0, z0], 0x9a7458);
    // 墙顶女墙（两侧矮墙）
    for (const zz of [z1 - 0.35, z0 + 0.35]) {
      b.quad('plaster', [x0, hx0, zz + 0.35], [x1, hx1, zz + 0.35], [x1, hx1 + 1.0, zz + 0.35], [x0, hx0 + 1.0, zz + 0.35], 0xcfb48a);
      b.quad('plaster', [x1, hx1, zz - 0.35], [x0, hx0, zz - 0.35], [x0, hx0 + 1.0, zz - 0.35], [x1, hx1 + 1.0, zz - 0.35], 0xcfb48a);
      b.quad('plaster', [x0, hx0 + 1.0, zz + 0.35], [x1, hx1 + 1.0, zz + 0.35], [x1, hx1 + 1.0, zz - 0.35], [x0, hx0 + 1.0, zz - 0.35], 0xd6bc94);
    }
    // 横向分缝（墙面板材分格）
    if (b.detail >= 2) {
      for (let x = x0 + 6; x < x1 - 1; x += 6) {
        const hh = hx0 + ((hx1 - hx0) * (x - x0)) / (x1 - x0);
        b.box('plaster', x - 0.08, 0.2, z1, x + 0.08, hh - 0.2, z1 + 0.05, 0xb3946c, {});
      }
    }
  }
  // 门楼：面阔十一间、进深四间，单檐庑殿（唐风），整体淡棕黄
  b.push(0, H, 0, 0, 1.5);
  const info = hall(b, {
    style: 'tang', bays: 11, bayW: 3.95, depthBays: 4, depthW: 3.7, colH: 4.9,
    roof: 'wudian', roofColor: { tile: 0xb89a70, tube: 0xb09268, ridge: 0x9a7e5a, glazed: false },
    pal: monoPalette(T), platform: 'plain', platformH: 0.35, platformColor: 0xcfb48a, steps: 'none',
    front: 'zhiling', back: 'zhiling', sides: 'wall', plaque: o.plaque ?? '丹鳳門', plaqueVertical: false,
  });
  b.pop();
  return { H, topY: H + info.topY * 1.5, L, D, hall: info };
}
