// 中式古建程序化构件库 —— 统一入口（组合器 + 夜景 + 构建/LOD 工具）。API 文档见 docs/ARCH_KIT.md。
//
// 坐标约定（全库统一）：
//   · 单位米；Y 向上；构件/建筑局部原点 = 平面中心、地面（台基底）高度 y=0（可用 o.y0 抬高）。
//   · 正面朝 +Z（西安世界 +Z = 南：坐北朝南的建筑无需旋转）；面阔沿 X，进深沿 Z。
//   · 旋转：group.rotation.y = θ 后正面朝 (sin θ, 0, cos θ)。朝东 θ=+π/2，朝北 θ=π，朝西 θ=-π/2。
//   · 所有几何写入 ArchBuilder（按材质合并），b.build() 得到 THREE.Group（一座中型殿 ≈ 10~12 个网格）。
import * as THREE from 'three';
import { ArchBuilder, STYLES, palette, clamp, lerp, rng, lin, floodlit, makeLOD, stats, getKit, ROOF_COLORS, roofColors } from './chinese-core.js';
import { roof, roofYFor } from './chinese-roof.js';
import { frameDims, rectRing, polyRing, ringColumns, bayCoords, bayList, offsetCorners, columns, beam, lintelRing, bracketRing, queti } from './chinese-wood.js';
import { bayFill, wallPanel, latticePanel, glowQuad, archWall, archOutline, cityPlatform, yardWall } from './chinese-wall.js';
import { platform, steps, balustrade, lantern, lanternPost, lanternString, stoneLion, offsetPoly, rectPoly, ngonPoly } from './chinese-base.js';

export {
  ArchBuilder, STYLES, palette, floodlit, makeLOD, stats, getKit, ROOF_COLORS, roofColors,
  roof, roofYFor,
  frameDims, rectRing, polyRing, ringColumns, bayCoords, bayList, offsetCorners, columns, beam, lintelRing, bracketRing, queti,
  bayFill, wallPanel, latticePanel, glowQuad, archWall, archOutline, cityPlatform, yardWall,
  platform, steps, balustrade, lantern, lanternPost, lanternString, stoneLion, offsetPoly, rectPoly, ngonPoly,
};

// ───────────── 构建工具 ─────────────
/**
 * 一步构建：fn(b) 往 builder 里建模（可返回 info），返回 THREE.Group（group.userData.info = info）。
 * o: {detail(0/1/2，默认 2), style, instancing, flood（泛光配置，见 floodlit）, castShadow, name}
 */
export function buildArch(ctx, fn, o = {}) {
  const b = new ArchBuilder(ctx, { detail: o.detail ?? 2, style: o.style || 'ming', instancing: o.instancing, name: o.name });
  const info = fn(b) || {};
  const g = b.build({ flood: o.flood, castShadow: o.castShadow, name: o.name });
  g.userData.info = info;
  g.userData.lights = b.lightAnchors;
  return g;
}
/**
 * 多级 LOD：levels = [[detail, 距离], ...]（默认 [[2,0],[1,160],[0,550]]），返回 THREE.LOD（渲染器自动切换）。
 * 注意：fn 会被调用多次（每级一次），不要在 fn 里做有副作用的事（如注册灯光）。
 */
export function buildLOD(ctx, fn, o = {}) {
  const levels = o.levels ?? [[2, 0], [1, 160], [0, 550]];
  const lod = new THREE.LOD();
  let info = null;
  for (const [d, dist] of levels) {
    const g = buildArch(ctx, fn, { ...o, detail: d });
    info = info || g.userData.info;
    lod.addLevel(g, dist);
  }
  lod.userData.info = info;
  return lod;
}

// ───────────── 内部：立面、门窗方案 ─────────────
function sideFrame(side) {
  const p0 = side.pts[0], p1 = side.pts[side.pts.length - 1];
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const tx = Math.cos(side.yaw), tz = -Math.sin(side.yaw);
  const local = side.pts.map((p) => (p[0] - mid[0]) * tx + (p[1] - mid[1]) * tz);
  return { mid, local };
}
/** 门窗方案 → 每间构件类型数组 */
export function sideKinds(scheme, n, style = 'ming') {
  if (Array.isArray(scheme)) return scheme;
  const c = (n - 1) / 2;
  const mid = (k, r) => Math.abs(k - c) <= r;
  const arr = [];
  for (let k = 0; k < n; k++) {
    switch (scheme) {
      case 'doors': arr.push('geshan'); break;
      case 'center3': arr.push(n < 3 || mid(k, 1) ? 'geshan' : 'kanchuang'); break;
      case 'center1': arr.push(mid(k, 0.5) ? 'geshan' : 'kanchuang'); break;
      case 'windows': arr.push('kanchuang'); break;
      case 'wall': arr.push('wall'); break;
      case 'open': arr.push('open'); break;
      case 'tang': arr.push(mid(k, n >= 7 ? 1 : 0.5) ? 'banmen' : 'zhiling'); break;
      case 'tangshop': arr.push(mid(k, n >= 5 ? 1 : 0.5) ? 'geshan' : 'zhiling'); break; // 仿唐商铺：中间隔扇门、两侧直棂窗
      case 'gate': arr.push(mid(k, 0.5) ? 'banmen' : 'wall'); break;
      case 'arch': arr.push(mid(k, 0.5) ? 'arch' : 'wall'); break;
      case 'zhiling': arr.push('zhiling'); break;
      default: arr.push('wall');
    }
  }
  return arr;
}
function schemeFor(o, side, style) {
  const n = side.name;
  if (n === 'front') return o.front ?? (style === 'tang' ? 'tang' : 'center3');
  if (n === 'back') return o.back ?? 'wall';
  if (n === 'left' || n === 'right') return o.sides ?? 'wall';
  return o.sidesAll ?? o.front ?? 'doors'; // 多边形各边
}
function fillRing(b, ring, y0, y1, o) {
  const style = o.style;
  ring.sides.forEach((side, si) => {
    const nb = side.pts.length - 1;
    const kinds = sideKinds(schemeFor(o, side, style), nb, style);
    const { mid, local } = sideFrame(side);
    // 相邻两面墙在转角柱处交叠：奇数边整体抬高 6 mm，槛墙顶/墙顶不再与相邻面共面闪烁
    b.push(mid[0], (si % 2) * 0.006, mid[1], side.yaw);
    for (let k = 0; k < nb; k++) {
      bayFill(b, kinds[k] || 'wall', local[k], local[k + 1], y0, y1, { pal: o.pal, style, D: o.D, seed: (o.seed ?? 1) * 97 + k * 13 + side.name.length * 7, carve: o.carve, pattern: o.pattern, wallColor: o.wallColor, lit: o.lit });
    }
    b.pop();
  });
}
function quetiRing(b, ring, yTop, o) {
  for (const side of ring.sides) {
    if (o.quetiSides && !o.quetiSides.includes(side.name)) continue;
    const { mid, local } = sideFrame(side);
    b.push(mid[0], 0, mid[1], side.yaw);
    for (let k = 0; k < local.length; k++) {
      for (const dir of [-1, 1]) {
        const j = k + (dir > 0 ? 1 : -1);
        if (j < 0 || j >= local.length) continue;
        const bay = Math.abs(local[j] - local[k]);
        const len = Math.min(bay * 0.26, 1.4);
        queti(b, local[k] + dir * o.D * 0.45, yTop, 0, dir, len, len * 0.42, { color: o.color, gold: o.gold, t: o.D * 0.3 });
      }
    }
    b.pop();
  }
}
function overhangFor(style, colH, proj, o = {}) {
  const S = STYLES[style] || STYLES.ming;
  return o.overhang ?? colH * S.ovK * (style === 'tang' ? 0.65 : 0.85) + proj;
}
function roofDims(ring) {
  return ring.rect ? { w: ring.w, d: ring.d } : { w: ring.w, d: ring.w, sides: ring.N };
}

/**
 * 一层木构（柱 + 额枋 + 斗拱 + 门窗）。内部使用，也导出给需要自定义组合的模块。
 * spec: {ring（外檐柱环）, wallRing（门窗所在环，默认 = ring）, y（柱脚高）, colH, style, pal, F（frameDims），
 *        brackets（true/false/'simple'）, front/back/sides（门窗方案）, queti, rich, infillTop（门窗顶高，默认额枋底）}
 * 返回 {colTop, bracketBase, br（bracketRing 结果）, infillTop}
 */
export function storey(b, s) {
  const { ring, style, pal, F } = s;
  const y = s.y, colH = s.colH;
  const colTop = y + colH;
  const tang = style === 'tang';
  columns(b, ringColumns(ring), { y0: y, h: colH, D: F.D, style, pal, base: s.colBase });
  const stackH = tang ? F.fangH : F.fangH + F.padH + F.fang2H;
  const bracketBase = lintelRing(b, ring, colTop, { style, pal, dims: F, rich: s.rich, plank: s.brackets !== false });
  let br = { proj: 0, topY: bracketBase, bearY: bracketBase, tip: offsetCorners(ring, 0) };
  if (s.brackets !== false) br = bracketRing(b, ring, { y: bracketBase, H: F.bracketH, style, pal, perBay: s.perBay });
  else {
    // 无斗拱（小亭、廊）：檐檩直接落在柱头上
    br = { proj: F.D * 0.6, topY: bracketBase + F.D * 0.8, bearY: bracketBase + F.D * 0.8, tip: offsetCorners(ring, F.D * 0.6) };
    const n = ring.sides.length;
    for (let i = 0; i < n; i++) beam(b, br.tip[i], br.tip[(i + 1) % n], bracketBase, F.D * 0.8, F.D * 0.8, { mat: 'paint', color: pal.gong, ext: 0.2 });
  }
  const infillTop = s.infillTop ?? colTop - stackH;
  const wr = s.wallRing || ring;
  if (s.fill !== false) fillRing(b, wr, s.infillBase ?? y, infillTop, { ...s, D: F.D });
  if (s.queti ?? !tang) {
    if (b.detail >= 1) quetiRing(b, ring, colTop - stackH, { D: F.D, color: s.quetiColor ?? (tang ? pal.col : 0x2f6a5a), gold: tang ? 0xd2a04a : 0xb88a3a, quetiSides: s.quetiSides ?? (ring.rect ? ['front', 'back', 'left', 'right'] : null) });
  }
  return { colTop, bracketBase, br, infillTop, stackH };
}

/**
 * 按承托（斗拱外拽）自动定高的屋顶。r: {ring, br, colH, type, style, pal, color, top(band), overhang, underside, ...}
 */
export function eaveRoof(b, r) {
  const ov = overhangFor(r.style, r.colH, r.br.proj, r);
  const dims = roofDims(r.ring);
  const type = r.type;
  const ro = { type, style: r.style, overhang: ov, pitch: r.pitch };
  const y = roofYFor(ro, r.br.bearY, r.br.proj);
  return roof(b, { ...r, ...dims, sides: r.sides ?? dims.sides ?? 4, type, y, overhang: ov, pal: r.pal, color: r.color, top: r.top, underside: r.underside, ornament: r.ornament, beasts: r.beasts, finial: r.finial, pitch: r.pitch, lift: r.lift, flare: r.flare, ridgeH: r.ridgeH });
}

// ───────────── 组合器：殿 ─────────────
/**
 * 殿堂（单檐 / 重檐）。见 docs/ARCH_KIT.md。常用参数：
 *   bays（面阔间数或各间宽数组，默认 5）、bayW（4.5）、centerW、depthBays（进深间数或数组）、depthW
 *   colH 柱高、roof:'xieshan'|'wudian'|'xuanshan'|'yingshan'|'juanpeng'、eaves 1|2、style 'tang'|'ming'
 *   roofColor 'gray'|'green'|'yellow'|…、pal（palette 覆盖）、platform 'sumeru'|'plain'|'brick'|'none'、platformH、platformMargin
 *   front/back/sides 门窗方案（'center3'|'doors'|'windows'|'wall'|'tang'|'tangshop'|'gate'|'open'|数组）
 *   steps 'front'|'frontback'|'all'|'none'、stepsYulu、railing（台基石栏杆）、plaque（匾额文字）、plaqueVertical
 *   lanterns（檐下每间挂灯笼）、eaveLights（轮廓灯：true 或 {color, width, columns}）、y0（台基底高）
 * 返回 info: {w, d, W, D, platformTop, colTop, eaveY, topY, roofs:[roofInfo], rings, columns:[[x,z,y0,y1]], footprint}
 */
export function hall(b, o = {}) {
  const style = o.style || b.style || 'ming';
  const tang = style === 'tang';
  const pal = palette(style, o.pal);
  const eaves = o.eaves ?? 1;
  const bw = o.bayW ?? 4.5;
  const bays = bayList(o.bays ?? 5, bw, o.centerW, o.endW);
  let dbays = bayList(o.depthBays ?? (eaves >= 2 ? 4 : 3), o.depthW ?? bw * 0.95, o.depthW ?? bw * 0.95, o.depthW ?? bw * 0.95);
  if (eaves >= 2 && !Array.isArray(o.depthBays)) {
    // 重檐：副阶（外廊）进深与面阔尽间一致，便于下檐围脊贴合
    dbays = dbays.slice();
    dbays[0] = dbays[dbays.length - 1] = bays[0];
  }
  const xs = bayCoords(bays), zs = bayCoords(dbays);
  const W = xs[xs.length - 1] - xs[0], Dp = zs[zs.length - 1] - zs[0];
  const colH = o.colH ?? clamp(bays[(bays.length / 2) | 0] * 1.05, 3.2, 9);
  // 斗拱高：唐风随规模缩小（小殿/商铺不宜用佛光寺式雄大斗拱），明清随面阔略缩
  const F = frameDims(style, colH, { ...o, bracketH: o.bracketH ?? colH * (tang ? 0.4 * clamp(W / 26, 0.5, 1) : 0.2 * clamp(W / 16, 0.75, 1)) });
  const y0 = o.y0 ?? 0;
  const ovEst = overhangFor(style, colH, F.proj, o);
  const margin = o.platformMargin ?? ovEst * 0.55 + 0.3;
  const pH = o.platform === 'none' ? 0 : o.platformH ?? (tang ? 1.0 : 1.4);
  const PW = W + 2 * margin, PD = Dp + 2 * margin;
  let yP = y0;
  if (pH > 0) yP = platform(b, { w: PW, d: PD, h: pH, kind: o.platform ?? (tang ? 'brick' : 'sumeru'), y0, color: o.platformColor ?? (tang ? 0x8e8a82 : 0xe2ddd2), capColor: o.platformCap });
  // 台阶
  const stepSides = o.steps ?? 'front';
  const stepW = o.stepW ?? bays[(bays.length / 2) | 0] * (tang ? 0.9 : 0.85);
  const stepList = [];
  if (pH > 0.25 && stepSides !== 'none') {
    stepList.push([0, PD / 2, 0]);
    if (stepSides === 'frontback' || stepSides === 'all') stepList.push([0, -PD / 2, Math.PI]);
    if (stepSides === 'all') {
      stepList.push([PW / 2, 0, Math.PI / 2]);
      stepList.push([-PW / 2, 0, -Math.PI / 2]);
    }
    for (const [x, z, yaw] of stepList) {
      b.push(x, 0, z, yaw);
      steps(b, { w: stepW, h: pH, y0, yulu: o.stepsYulu ?? 0, color: o.platformColor ?? 0xe2ddd2 });
      b.pop();
    }
  }
  // 台基栏杆
  if (o.railing && pH > 0.5 && b.detail >= 1) {
    const inset = 0.25;
    const x1 = PW / 2 - inset, z1 = PD / 2 - inset;
    const yR = yP;
    const gap = stepW / 2 + 0.6;
    const kind = o.railingKind ?? (tang ? 'wood' : 'stone');
    const rc = tang ? pal.railing : undefined;
    const hasBack = stepList.some((s) => s[2] === Math.PI);
    balustrade(b, [[gap, yR, z1], [x1, yR, z1], [x1, yR, -z1], ...(hasBack ? [[gap, yR, -z1]] : [[-x1, yR, -z1], [-x1, yR, z1], [-gap, yR, z1]])], { kind, color: rc });
    if (hasBack) balustrade(b, [[-gap, yR, -z1], [-x1, yR, -z1], [-x1, yR, z1], [-gap, yR, z1]], { kind, color: rc });
  }
  const outer = rectRing(xs, zs);
  const info = { w: PW, d: PD, W, D: Dp, platformTop: yP, roofs: [], rings: [outer], columns: [], footprint: rectPoly(PW, PD), style };
  let res;
  if (eaves >= 2 && xs.length >= 4 && zs.length >= 4) {
    // —— 重檐：外圈副阶（敞廊）+ 内圈殿身 ——
    const inner = rectRing(xs.slice(1, -1), zs.slice(1, -1));
    info.rings.push(inner);
    const ringW = xs[1] - xs[0];
    res = storey(b, { ring: outer, y: yP, colH, style, pal, F, fill: false, rich: o.rich, queti: o.queti, perBay: o.perBay });
    // 穿插枋（外檐柱 → 金柱）
    const yT = res.colTop - res.stackH * 0.7;
    for (const [x, z] of ringColumns(outer)) {
      const xi = clamp(x, xs[1], xs[xs.length - 2]), zi = clamp(z, zs[1], zs[zs.length - 2]);
      beam(b, [x, z], [xi, zi], yT, F.fangH * 0.7, F.D * 0.5, { mat: 'paint', color: pal.gong });
    }
    // 下檐（副阶）坡顶止于金柱外皮：原先止于金柱中线，金柱与其上板壁从下檐瓦面顶带穿出
    const lower = eaveRoof(b, { ring: outer, br: res.br, colH, type: 'band', style, pal, color: o.roofColor, top: ringW - F.D * 0.5 - 0.03, underside: 'full', beasts: o.beasts });
    info.roofs.push(lower);
    // 金柱（通柱）至上檐
    const F2 = frameDims(style, colH, { ...o, bracketH: (o.bracketH ?? F.bracketH) * (o.upperBracketK ?? 1) });
    const upColTop = lower.bandTopY + Math.max(0.7, colH * 0.14) + (tang ? F2.fangH : F2.fangH + F2.padH + F2.fang2H);
    const up = storey(b, { ring: inner, y: yP, colH: upColTop - yP, style, pal, F: F2, fill: false, rich: o.rich, queti: false, perBay: o.perBay, colBase: true });
    // 殿身门窗（在金柱线）、其上板壁
    const doorTop = res.colTop - res.stackH;
    fillRing(b, inner, yP, doorTop, { ...o, style, pal, D: F.D });
    lintelRing(b, inner, res.colTop, { style, pal, dims: F, plank: false });
    for (const side of inner.sides) {
      const { mid, local } = sideFrame(side);
      b.push(mid[0], 0, mid[1], side.yaw);
      wallPanel(b, local[0], local[local.length - 1], res.colTop, up.infillTop, { pal, style, D: F.D, thin: true, wallColor: tang ? pal.wall : pal.frame, wallMat: tang ? 'plaster' : 'paint' });
      b.pop();
    }
    const upper = eaveRoof(b, { ring: inner, br: up.br, colH: colH * 0.9, type: o.roof || 'xieshan', style, pal, color: o.roofColor, beasts: o.beasts, ornament: o.ornament });
    info.roofs.push(upper);
    info.colTop = res.colTop;
    info.upperColTop = up.colTop;
    info.plaqueY = up.bracketBase - F2.fangH * 0.2;
    info.plaqueZ = zs[zs.length - 2] + F.D * 0.5 + 0.12;
    for (const [x, z] of ringColumns(outer)) info.columns.push([x, z, yP, res.colTop, F.D]);
    for (const [x, z] of ringColumns(inner)) info.columns.push([x, z, yP, up.colTop, F.D]);
    info.frontRing = inner;
  } else {
    res = storey(b, { ring: outer, y: yP, colH, style, pal, F, front: o.front, back: o.back, sides: o.sides, rich: o.rich, queti: o.queti, perBay: o.perBay, carve: o.carve, pattern: o.pattern, wallColor: o.wallColor, brackets: o.brackets });
    const r = eaveRoof(b, { ring: outer, br: res.br, colH, type: o.roof || 'xieshan', style, pal, color: o.roofColor, beasts: o.beasts, ornament: o.ornament, underside: o.roof === 'juanpeng' ? 'full' : undefined });
    info.roofs.push(r);
    info.colTop = res.colTop;
    info.plaqueY = res.bracketBase - F.fangH * 0.3;
    info.plaqueZ = zs[zs.length - 1] + F.D * 0.5 + 0.12;
    for (const [x, z] of ringColumns(outer)) info.columns.push([x, z, yP, res.colTop, F.D]);
    info.frontRing = outer;
  }
  info.eaveY = info.roofs[0].eaveY;
  info.topY = Math.max(...info.roofs.map((r) => r.topY));
  // 匾额
  if (o.plaque && b.detail >= 1) {
    const cw = bays[(bays.length / 2) | 0];
    const vert = o.plaqueVertical ?? !tang;
    const pw = vert ? clamp(cw * 0.2, 0.7, 2.2) : clamp(cw * 0.55, 1.6, 5);
    const ph = vert ? pw * 2.6 : pw * 0.34;
    b.plaque(o.plaque, 0, info.plaqueY - (vert ? ph * 0.25 : 0), info.plaqueZ + F.proj * (vert ? 0.2 : 0.05), pw, ph, { vertical: vert, bg: o.plaqueBg, color: o.plaqueColor, border: o.plaqueBorder });
  }
  // 檐下灯笼
  if (o.lanterns && b.detail >= 1) {
    const side = info.frontRing.sides[0];
    for (let k = 0; k < side.pts.length - 1; k++) {
      const x = (side.pts[k][0] + side.pts[k + 1][0]) / 2;
      if (o.plaque && Math.abs(x) < 0.5) continue;
      lantern(b, x, res.colTop - 0.1, side.pts[k][1] + F.D * 0.8, { kind: o.lanternKind || 'round', size: o.lanternSize ?? clamp(bays[0] * 0.18, 0.6, 1.1), color: o.lanternColor });
    }
  }
  if (o.eaveLights) eaveLights(b, info, o.eaveLights === true ? {} : o.eaveLights);
  return info;
}

// ───────────── 组合器：楼阁（钟鼓楼、城楼、塔楼） ─────────────
/**
 * 多层楼阁：每层 = 柱 + 额枋 + 斗拱 + 门窗；层间 = 腰檐（band）+ 平座（斗拱、楼板、栏杆）；顶 = 屋顶（可重檐）。
 * o: {
 *   storeys: [{bays, depthBays, bayW, colH, front, back, sides, brackets}]，或 floors（层数，默认 2）+ bays/depthBays/bayW/colH（统一）
 *   shrink（每上一层每边内收，米，默认 0.6）、pingzuo（true：二层起设平座，默认 true）、balcony（平座挑出宽，默认 1.4）
 *   roof（顶层屋顶类型，默认 'xieshan'；多边形塔用 'zanjian'）、topEaves（顶层重檐 1|2，默认 1）、sides（0/6/8：多边形楼阁）
 *   platform/platformH/platformMargin/steps/railing（同 hall）、style、roofColor、pal、plaque、lanterns、eaveLights、y0
 * }
 * 返回 info（同 hall，另含 storeyTops）
 */
export function multiStoreyTower(b, o = {}) {
  const style = o.style || b.style || 'ming';
  const tang = style === 'tang';
  const pal = palette(style, o.pal);
  const N = o.sides ?? 4;
  const poly = N !== 4;
  const floors = o.storeys ? o.storeys.length : o.floors ?? 2;
  const shrink = o.shrink ?? 0.6;
  const bw = o.bayW ?? 4.2;
  const specs = [];
  for (let i = 0; i < floors; i++) {
    const s = o.storeys?.[i] || {};
    const colH = s.colH ?? o.colH ?? 4.2;
    let ring;
    const prev = specs[i - 1];
    if (prev && prev.inner && !s.bays) ring = prev.inner;
    else if (poly) {
      const ap = (s.apothem ?? o.apothem ?? 6) - i * shrink;
      ring = polyRing(N, ap, s.perSide ?? o.perSide ?? 1);
    } else {
      const bays = bayList(s.bays ?? o.bays ?? 3, s.bayW ?? bw, s.centerW ?? o.centerW, s.endW ?? o.endW);
      const dbays = bayList(s.depthBays ?? o.depthBays ?? 3, s.depthW ?? o.depthW ?? bw, s.depthW ?? o.depthW ?? bw, s.depthW ?? o.depthW ?? bw);
      const xs = bayCoords(bays), zs = bayCoords(dbays);
      const k = s.bays ? 0 : i * shrink;
      const sx = xs.map((x, j) => x + (j === 0 ? k : j === xs.length - 1 ? -k : 0));
      const sz = zs.map((z, j) => z + (j === 0 ? k : j === zs.length - 1 ? -k : 0));
      ring = rectRing(sx, sz);
    }
    let inner = null;
    if (s.veranda && ring.rect && ring.sides[0].pts.length >= 4 && ring.sides[1].pts.length >= 4) {
      const xs = ring.sides[0].pts.map((p) => p[0]), zs = ring.sides[3].pts.map((p) => p[1]);
      inner = rectRing(xs.slice(1, -1), zs.slice(1, -1));
    }
    specs.push({ ...s, colH, ring, inner });
  }
  const F0 = frameDims(style, specs[0].colH, o);
  const y0 = o.y0 ?? 0;
  const W0 = specs[0].ring.w, D0 = specs[0].ring.d;
  const ovEst = overhangFor(style, specs[0].colH, F0.proj, o);
  const margin = o.platformMargin ?? ovEst * 0.55 + 0.3;
  const pH = o.platform === 'none' ? 0 : o.platformH ?? 0.9;
  let yP = y0;
  const fp = poly ? ngonPoly(N || 8, W0 / 2 + margin) : rectPoly(W0 + 2 * margin, D0 + 2 * margin);
  if (pH > 0) yP = platform(b, { poly: fp, h: pH, kind: o.platform ?? (tang ? 'brick' : 'sumeru'), y0, color: o.platformColor ?? (tang ? 0x8e8a82 : 0xe2ddd2) });
  if (pH > 0.25 && (o.steps ?? 'front') !== 'none') {
    const pd = poly ? W0 / 2 + margin : D0 / 2 + margin;
    b.push(0, 0, pd, 0);
    steps(b, { w: o.stepW ?? 3, h: pH, y0 });
    b.pop();
  }
  const info = { roofs: [], rings: [], columns: [], storeyTops: [], platformTop: yP, footprint: fp, style, w: W0 + 2 * margin, d: D0 + 2 * margin };
  let y = yP;
  const balcony = o.balcony ?? 1.4;
  for (let i = 0; i < floors; i++) {
    const s = specs[i];
    const top = i === floors - 1;
    const F = frameDims(style, s.colH, { ...o, bracketH: s.bracketH ?? o.bracketH });
    info.rings.push(s.ring);
    const topDouble = top && (o.topEaves ?? 1) >= 2;
    const scheme = {
      front: s.front ?? o.front ?? (i === 0 ? 'center3' : 'windows'), back: s.back ?? o.back ?? (i === 0 ? 'wall' : 'windows'), sides: s.sides ?? o.sidesScheme ?? (i === 0 ? 'wall' : 'windows'),
      sidesAll: s.front ?? o.front ?? 'doors', carve: o.carve, pattern: o.pattern,
    };
    const res = storey(b, {
      fill: !s.inner, ring: s.ring, y, colH: s.colH, style, pal, F,
      ...scheme, rich: o.rich, queti: o.queti, brackets: s.brackets,
    });
    if (s.inner) {
      // 回廊：外圈檐柱敞开，门窗在内圈金柱线；穿插枋连接内外柱
      const xs = s.ring.sides[0].pts.map((p) => p[0]), zs = s.ring.sides[3].pts.map((p) => p[1]);
      columns(b, ringColumns(s.inner), { y0: y, h: s.colH, D: F.D, style, pal });
      lintelRing(b, s.inner, res.colTop, { style, pal, dims: F, plank: false });
      fillRing(b, s.inner, y, res.colTop - res.stackH, { ...scheme, style, pal, D: F.D, seed: i + 3 });
      for (const [x, z] of ringColumns(s.ring)) {
        const xi = clamp(x, xs[1], xs[xs.length - 2]), zi = clamp(z, zs[1], zs[zs.length - 2]);
        beam(b, [x, z], [xi, zi], res.colTop - res.stackH * 0.7, F.fangH * 0.7, F.D * 0.5, { mat: 'paint', color: pal.gong });
      }
      for (const [x, z] of ringColumns(s.inner)) info.columns.push([x, z, y, res.colTop, F.D]);
    }
    for (const [x, z] of ringColumns(s.ring)) info.columns.push([x, z, y, res.colTop, F.D]);
    info.storeyTops.push(res.colTop);
    if (i === 0) {
      info.colTop = res.colTop;
      info.plaqueY = res.bracketBase - F.fangH * 0.3;
    }
    if (!top) {
      // 腰檐 → 平座
      const nx = specs[i + 1].ring;
      const pz = o.pingzuo !== false;
      const inset = insetBetween(s.ring, nx);
      const edge = pz ? Math.max(0.3, inset - balcony) : inset; // 本层檐柱线 → 平座边缘（或上层柱线）
      const band = eaveRoof(b, { ring: s.ring, br: res.br, colH: s.colH, type: 'band', style, pal, color: o.roofColor, top: edge, underside: s.inner ? 'full' : 'eave', sides: poly ? N : 4 });
      info.roofs.push(band);
      let yNext = band.bandTopY + 0.25;
      if (pz) {
        const pzRing = poly ? polyRing(N, nx.w / 2 + (inset - edge), nx.sides[0].pts.length - 1) : expandRect(nx, inset - edge);
        const pzH = Math.max(0.55, F.bracketH * 0.62);
        const pb = bracketRing(b, pzRing, { y: band.bandTopY - 0.15, H: pzH, style, pal, kind: 'pingzuo', panel: true, outer: false });
        yNext = pb.topY + 0.18;
        // 楼板（地面）+ 栏杆
        const edgePoly = offsetCorners(pzRing, pb.proj + 0.1);
        slab(b, edgePoly, yNext - 0.2, yNext, pal);
        const rail = offsetCorners(pzRing, pb.proj - 0.05).map(([x, z]) => [x, yNext, z]);
        balustrade(b, rail, { kind: o.balconyRail ?? (tang ? 'wood' : 'wood'), color: pal.railing, closed: true, h: 1.05 });
        info.balconyY = info.balconyY ?? yNext;
      }
      y = yNext;
      continue;
    }
    // 顶层屋顶
    const type = o.roof || (poly ? 'zanjian' : 'xieshan');
    if (topDouble) {
      const ringW = o.topRing ?? (poly ? Math.min(1.8, s.ring.w * 0.12) : Math.min((s.ring.sides[0].pts[1][0] - s.ring.sides[0].pts[0][0]) * 0.4, 1.8));
      // 重檐下檐坡顶止于上檐柱（檐柱缩进 ringW）外皮，不压进柱身
      const band = eaveRoof(b, { ring: s.ring, br: res.br, colH: s.colH, type: 'band', style, pal, color: o.roofColor, top: ringW - F.D * 0.5 - 0.03, underside: 'eave', sides: poly ? N : 4 });
      info.roofs.push(band);
      const inner = poly ? polyRing(N, s.ring.w / 2 - ringW, 1) : expandRect(s.ring, -ringW);
      const F2 = frameDims(style, s.colH, { ...o, bracketH: F.bracketH * 0.95 });
      const drumTop = band.bandTopY + Math.max(0.9, s.colH * 0.22) + (tang ? F2.fangH : F2.fangH + F2.padH + F2.fang2H);
      const up = storey(b, { ring: inner, y: band.bandTopY - 0.3, colH: drumTop - band.bandTopY + 0.3, style, pal, F: F2, fill: false, queti: false, colBase: false });
      for (const side of inner.sides) {
        const { mid, local } = sideFrame(side);
        b.push(mid[0], 0, mid[1], side.yaw);
        wallPanel(b, local[0], local[local.length - 1], band.bandTopY - 0.3, up.infillTop, { pal, style, D: F2.D, thin: true, wallColor: tang ? pal.wall : pal.frame, wallMat: tang ? 'plaster' : 'paint' });
        b.pop();
      }
      const r = eaveRoof(b, { ring: inner, br: up.br, colH: s.colH, type, style, pal, color: o.roofColor, sides: poly ? N : 4, finial: o.finial, ornament: o.ornament, pitch: o.pitch ?? (type === 'zanjian' ? 0.9 : undefined) });
      info.roofs.push(r);
      info.plaqueY2 = up.bracketBase;
    } else {
      const r = eaveRoof(b, { ring: s.ring, br: res.br, colH: s.colH, type, style, pal, color: o.roofColor, sides: poly ? N : 4, finial: o.finial, ornament: o.ornament });
      info.roofs.push(r);
    }
  }
  info.eaveY = info.roofs[0].eaveY;
  info.topY = Math.max(...info.roofs.map((r) => r.topY));
  // 匾额（首层正面檐下；有平座时挂在二层平座下）
  if (o.plaque && b.detail >= 1) {
    const fr = specs[0].ring;
    const z = (fr.rect ? fr.sides[0].pts[0][1] : fr.w / 2) + F0.D * 0.5 + F0.proj * 0.3;
    const vert = o.plaqueVertical ?? !tang;
    const pw = vert ? 0.9 : 2.8, ph = vert ? 2.4 : 0.95;
    const py = floors > 1 && o.plaqueUpper !== false ? info.storeyTops[1] - ph * 0.9 : info.plaqueY;
    const pzf = floors > 1 && o.plaqueUpper !== false ? (specs[1].ring.rect ? specs[1].ring.sides[0].pts[0][1] : specs[1].ring.w / 2) + F0.D * 0.6 : z;
    b.plaque(o.plaque, 0, py, pzf + 0.1, pw, ph, { vertical: vert });
  }
  if (o.lanterns && b.detail >= 1) {
    const fr = specs[0].ring;
    for (const side of fr.sides) {
      for (let k = 0; k < side.pts.length - 1; k++) {
        const x = (side.pts[k][0] + side.pts[k + 1][0]) / 2, z = (side.pts[k][1] + side.pts[k + 1][1]) / 2;
        lantern(b, x + side.n[0] * F0.D * 0.8, info.colTop - 0.1, z + side.n[1] * F0.D * 0.8, { kind: o.lanternKind || 'palace', size: 0.9 });
      }
    }
  }
  if (o.eaveLights) eaveLights(b, info, o.eaveLights === true ? {} : o.eaveLights);
  return info;
}
export const pavilionTower = multiStoreyTower;

function insetBetween(a, b2) {
  if (a.rect && b2.rect) {
    const fa = a.sides[0].pts[0], fb = b2.sides[0].pts[0];
    return Math.min(Math.abs(fb[0] - fa[0]), Math.abs(fb[1] - fa[1]));
  }
  return (a.w - b2.w) / 2;
}
/** 矩形环整体外扩 d（负值内收），保留原柱位分间（端柱随之移动） */
function expandRect(ring, d) {
  const xs = ring.sides[0].pts.map((p) => p[0]);
  const zs = ring.sides[3].pts.map((p) => p[1]);
  const f = (a) => {
    const lo = a[0] - d, hi = a[a.length - 1] + d;
    return [lo, ...a.slice(1, -1).filter((x) => x > lo + 0.8 && x < hi - 0.8), hi];
  };
  return rectRing(f(xs), f(zs));
}
/** 楼板/地面（多边形板） */
function slab(b, poly, y0, y1, pal) {
  const n = poly.length;
  const bk = b.bucket('paint');
  const cl = lin(0x7a4a32);
  const base = bk.count;
  for (const p of poly) b.vtx(bk, p[0], y1, p[1], 0, 1, 0, p[0], p[1], cl);
  const tris = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p[0], p[1])), []);
  for (const t of tris) {
    const p0 = poly[t[0]], p1 = poly[t[1]], p2 = poly[t[2]];
    const cr = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    if (cr < 0) b.tri(bk, base + t[0], base + t[1], base + t[2]);
    else b.tri(bk, base + t[0], base + t[2], base + t[1]);
  }
  for (let i = 0; i < n; i++) {
    const a = poly[i], c = poly[(i + 1) % n];
    const q = [[a[0], y0, a[1]], [c[0], y0, c[1]], [c[0], y1, c[1]], [a[0], y1, a[1]]];
    // 朝外：检查法线与中心方向
    const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
    const ex = c[0] - a[0], ez = c[1] - a[1];
    const nx = ez, nz = -ex;
    if (nx * mx + nz * mz >= 0) b.quad('paint', q[0], q[1], q[2], q[3], pal.fascia);
    else b.quad('paint', q[1], q[0], q[3], q[2], pal.fascia);
  }
}

// ───────────── 组合器：城楼 ─────────────
/**
 * 城门楼 = 城台（砖砌、券洞、垛口）+ 城楼（多层楼阁或殿）。
 * o: {w,d,h（城台，默认 40×22×12）, tunnels（券洞数 1/3）, tw, th, crenel, innerSide（内侧矮女墙的边，默认 ['back']）,
 *     tower:{…multiStoreyTower 参数} 或 hall:{…hall 参数}，style（默认 'ming'）, roofColor, plaque}
 * 城楼中心在城台顶面中心；返回 info（含 platformTopY、tower info）
 */
export function gateTower(b, o = {}) {
  const style = o.style || b.style || 'ming';
  const w = o.w ?? 40, d = o.d ?? 22, h = o.h ?? 12;
  const y0 = o.y0 ?? 0;
  b.push(0, y0, 0, 0);
  const cp = cityPlatform(b, { w, d, h, tunnels: o.tunnels ?? 1, tw: o.tw, th: o.th, spacing: o.spacing, crenel: o.crenel, inner: o.innerSide ?? ['back'], color: o.wallColor, batter: o.batter });
  b.pop();
  const topY = y0 + cp.topY;
  let t;
  if (o.hall) t = hall(b, { style, roofColor: o.roofColor, platformH: 0.5, platform: 'plain', steps: 'none', plaque: o.plaque, ...o.hall, y0: topY });
  else if (o.arrow) t = arrowTower(b, { style, roofColor: o.roofColor, plaque: o.plaque, ...o.arrow, y0: topY });
  else
    t = multiStoreyTower(b, {
      // 西安城楼（永宁门/安定门等）：面阔七间、首层回廊、二层平座、重檐歇山（三滴水）
      style, roofColor: o.roofColor ?? 'darkgray', platform: 'plain', platformH: 0.45, steps: 'none', plaque: o.plaque,
      storeys: [
        { bays: [4.0, 4.6, 4.8, 5.6, 4.8, 4.6, 4.0], depthBays: [4.0, 4.8, 4.8, 4.0], colH: 5.4, veranda: true, front: 'center3', back: 'center3', sides: 'windows' },
        { colH: 4.6, front: 'doors', back: 'windows', sides: 'windows' },
      ],
      pingzuo: true, balcony: 1.5, topEaves: 2, roof: 'xieshan',
      ...o.tower, y0: topY,
    });
  return { ...t, platformTopY: topY, cityPlatform: cp, w, d, h };
}

// ───────────── 组合器：箭楼 ─────────────
/**
 * 箭楼（砖砌楼身 + 多层箭窗 + 前出抱厦 + 重檐/单檐歇山灰瓦顶，永宁门箭楼式）。原点 = 楼身底面中心，正面 +Z。
 * o: {w（面宽 34）, d（进深 14）, h（楼身高 15）, rows（箭窗层数 4）, cols（正面每层窗数 12）, sideCols（山面每层 4）,
 *     baosha（前抱厦 true）, roofColor（'darkgray'）, style, y0, plaque}
 */
export function arrowTower(b, o = {}) {
  const style = o.style || 'ming';
  const pal = palette(style, o.pal);
  const w = o.w ?? 34, d = o.d ?? 14, h = o.h ?? 15;
  const y0 = o.y0 ?? 0;
  const rows = o.rows ?? 4, cols = o.cols ?? 12, sideCols = o.sideCols ?? 4;
  const brickC = o.color ?? 0x8f8a82;
  b.box('brick', -w / 2, y0, -d / 2, w / 2, y0 + h, d / 2, brickC, { skip: 'bottom' });
  // 各层腰线（白灰砖带）+ 箭窗（红框、内黑，夜间微光）
  const winW = 0.9, winH = 1.1;
  const hideFront = o.baosha !== false ? { x: w * 0.28 + 2.4, y: y0 + h * 0.72 + 0.6 + 5.5 * 0.55 } : null;
  const face = (L, n, z0, yaw) => {
    b.push(0, 0, 0, yaw);
    for (let r = 0; r < rows; r++) {
      const yb = y0 + h * 0.14 + (r * h * 0.8) / rows;
      if (b.detail >= 1) b.box('plaster', -L / 2 - 0.02, yb - 0.55, z0 - 0.05, L / 2 + 0.02, yb - 0.35, z0 + 0.04, 0xd8d2c6);
      for (let k = 0; k < n; k++) {
        const x = (k - (n - 1) / 2) * (L / (n + 0.5));
        // 正面被抱厦楼身与抱厦屋顶遮住的箭窗不做（原先窗框从抱厦屋面穿出）
        if (hideFront && yaw === 0 && Math.abs(x) < hideFront.x && yb < hideFront.y) continue;
        if (b.detail >= 1) {
          b.box('paint', x - winW / 2 - 0.12, yb, z0 - 0.02, x + winW / 2 + 0.12, yb + winH + 0.24, z0 + 0.06, pal.frame, { skip: 'bottom' });
          glowQuad(b, x - winW / 2, x + winW / 2, yb + 0.12, yb + 0.12 + winH, z0 + 0.08, (k + r) % 3 ? 0.08 : 0.5, 0x1e1a18); // 窗框外皮 z0+0.06，窗纸前移 2 cm 防共面闪烁
        } else glowQuad(b, x - winW / 2, x + winW / 2, yb, yb + winH, z0 + 0.02, 0.1, 0x3a1a14);
      }
    }
    b.pop();
  };
  face(w, cols, d / 2, 0);
  face(w, cols, d / 2, Math.PI);
  face(d, sideCols, w / 2, Math.PI / 2);
  face(d, sideCols, w / 2, -Math.PI / 2);
  // 顶部：檐下砖檐（叠涩）+ 歇山顶
  const ring = rectRing([-w / 2, w / 2], [-d / 2, d / 2]);
  for (let k = 0; k < 3; k++) {
    const e = 0.12 * (k + 1);
    b.box('brick', -w / 2 - e, y0 + h + k * 0.16, -d / 2 - e, w / 2 + e, y0 + h + (k + 1) * 0.16, d / 2 + e, brickC, { skip: 'bottom' });
  }
  const bear = { proj: 0.5, bearY: y0 + h + 0.5 };
  const info = { roofs: [], columns: [], style, w, d, footprint: rectPoly(w, d + 6) };
  info.roofs.push(eaveRoof(b, { ring, br: bear, colH: 5.5, type: 'xieshan', style, pal, color: o.roofColor ?? 'darkgray', overhang: o.overhang ?? 2.0 }));
  if (o.baosha !== false) {
    const bw = w * 0.56, bd = 5, bh = h * 0.72;
    b.box('brick', -bw / 2, y0, d / 2 - 0.5, bw / 2, y0 + bh, d / 2 + bd, brickC, { skip: 'bottom' });
    b.push(0, 0, d / 2 + bd, 0);
    for (let r = 0; r < rows - 1; r++) {
      const yb = y0 + h * 0.14 + (r * h * 0.8) / rows;
      for (let k = 0; k < 6; k++) {
        const x = (k - 2.5) * (bw / 6.5);
        if (b.detail >= 1) b.box('paint', x - winW / 2 - 0.12, yb, -0.02, x + winW / 2 + 0.12, yb + winH + 0.24, 0.06, pal.frame, { skip: 'bottom' });
        glowQuad(b, x - winW / 2, x + winW / 2, yb + 0.12, yb + 0.12 + winH, 0.08, k % 2 ? 0.1 : 0.45, 0x1e1a18);
      }
    }
    b.pop();
    // 抱厦顶：歇山，檐口压在楼身前檐之下
    const bz = d / 2 + (bd - 0.5) / 2;
    b.push(0, 0, bz, 0);
    const rr = roof(b, { type: 'xieshan', w: bw, d: bd + 0.5, y: y0 + bh + 0.6, overhang: 1.6, style, pal, color: o.roofColor ?? 'darkgray' });
    b.pop();
    info.roofs.push(xformRoofLines(rr, 0, bz));
  }
  if (o.plaque && b.detail >= 1) b.plaque(o.plaque, 0, y0 + h * 0.62, d / 2 + (o.baosha !== false ? 5.1 : 0.1), 4.2, 1.3, {});
  info.topY = info.roofs[0].topY;
  return info;
}

// ───────────── 组合器：亭 ─────────────
/**
 * 亭：sides 4（方亭）/6/8/0（圆亭），size（对边距 = 柱中线直径），colH，eaves 1|2，roof（默认攒尖；方亭可 'xieshan'），
 * seats（美人靠，默认 true，正面留口）、brackets（默认 false 小亭无斗拱；唐风默认 true）、platformH、style、roofColor、finial。
 */
export function pavilion(b, o = {}) {
  const style = o.style || b.style || 'ming';
  const tang = style === 'tang';
  const pal = palette(style, o.pal);
  const N = o.sides ?? 8;
  const size = o.size ?? 6;
  const colH = o.colH ?? clamp(size * 0.55, 2.8, 4.5);
  const F = frameDims(style, colH, { bracketH: o.bracketH ?? colH * (tang ? 0.3 : 0.16), colD: o.colD ?? clamp(colH * 0.075, 0.22, 0.4) });
  const rw = o.w ?? size, rd = o.d ?? o.w ?? size;
  const ring = N === 4 ? rectRing([-rw / 2, rw / 2], [-rd / 2, rd / 2]) : polyRing(N === 0 ? 8 : N, size / 2, 1);
  const y0 = o.y0 ?? 0;
  const pH = o.platformH ?? 0.6;
  const margin = o.platformMargin ?? 0.9;
  const fp = ring.rect ? rectPoly(ring.w + 2 * margin, ring.d + 2 * margin) : ngonPoly(N === 0 ? 8 : N, size / 2 + margin);
  let yP = y0;
  if (pH > 0) yP = platform(b, { poly: fp, h: pH, kind: o.platform ?? 'plain', y0, color: o.platformColor ?? 0xd8d2c4 });
  if (pH > 0.25 && o.steps !== 'none') {
    b.push(0, 0, ring.rect ? ring.d / 2 + margin : size / 2 + margin, 0);
    steps(b, { w: o.stepW ?? Math.min(2.4, size * 0.4), h: pH, y0 });
    b.pop();
  }
  const brackets = o.brackets ?? tang;
  const res = storey(b, { ring, y: yP, colH, style, pal, F, fill: false, brackets, queti: o.queti ?? true, quetiSides: null });
  // 倒挂楣子（檐下挂落）+ 美人靠
  if (b.detail >= 1) {
    for (const side of ring.sides) {
      const { mid, local } = sideFrame(side);
      b.push(mid[0], 0, mid[1], side.yaw);
      for (let k = 0; k < local.length - 1; k++) {
        const x0 = local[k] + F.D * 0.5, x1 = local[k + 1] - F.D * 0.5;
        const yT = res.colTop - (tang ? F.fangH : F.fangH + F.padH + F.fang2H);
        latticePanel(b, x0, x1, yT - 0.42, yT, { pattern: 1, color: pal.lattice, cell: 0.3, lit: 0, z: 0 });
      }
      b.pop();
    }
    if (o.seats !== false) {
      const n = ring.sides.length;
      for (let i = 0; i < n; i++) {
        if (i === 0) continue; // 正面留口
        const s = ring.sides[i];
        const p0 = s.pts[0], p1 = s.pts[s.pts.length - 1];
        const ex = p1[0] - p0[0], ez = p1[1] - p0[1], L = Math.hypot(ex, ez);
        const u = F.D * 0.6 / L;
        balustrade(b, [[p0[0] + ex * u, yP, p0[1] + ez * u], [p1[0] - ex * u, yP, p1[1] - ez * u]], { kind: 'seat', color: pal.railing, h: 0.5, spacing: 3, endPosts: false });
      }
    }
  }
  const eaves = o.eaves ?? 1;
  const type = o.roof || 'zanjian';
  const info = { roofs: [], columns: ringColumns(ring).map(([x, z]) => [x, z, yP, res.colTop, F.D]), rings: [ring], platformTop: yP, colTop: res.colTop, footprint: fp, style };
  if (eaves >= 2) {
    const ringW = size * 0.2;
    // 下檐坡顶止于内圈金柱外皮（金柱通高，原先下檐压到金柱中线，柱身从瓦面穿出）
    const band = eaveRoof(b, { ring, br: res.br, colH, type: 'band', style, pal, color: o.roofColor, top: ringW - F.D * 0.45 - 0.03, underside: 'full', sides: ring.rect ? 4 : N });
    info.roofs.push(band);
    const inner = ring.rect ? expandRect(ring, -ringW) : polyRing(N === 0 ? 8 : N, size / 2 - ringW, 1);
    const F2 = frameDims(style, colH, { bracketH: F.bracketH, colD: F.D * 0.9 });
    const upTop = band.bandTopY + Math.max(0.6, colH * 0.18);
    const up = storey(b, { ring: inner, y: yP, colH: upTop - yP, style, pal, F: F2, fill: false, brackets, queti: false });
    for (const side of inner.sides) {
      const { mid, local } = sideFrame(side);
      b.push(mid[0], 0, mid[1], side.yaw);
      wallPanel(b, local[0], local[local.length - 1], band.bandTopY - 0.2, up.infillTop, { pal, style, D: F2.D, thin: true, wallColor: pal.frame, wallMat: 'paint' });
      b.pop();
    }
    info.roofs.push(eaveRoof(b, { ring: inner, br: up.br, colH, type, style, pal, color: o.roofColor, sides: ring.rect ? 4 : N, underside: 'full', finial: o.finial }));
  } else {
    info.roofs.push(eaveRoof(b, { ring, br: res.br, colH, type: N === 0 ? 'zanjian' : type, style, pal, color: o.roofColor, sides: ring.rect ? 4 : N, underside: 'full', finial: o.finial, overhang: o.overhang ?? (colH * 0.42 + res.br.proj) }));
  }
  info.eaveY = info.roofs[0].eaveY;
  info.topY = Math.max(...info.roofs.map((r) => r.topY));
  if (o.lanterns && b.detail >= 1) for (const c of ringColumns(ring)) lantern(b, c[0] * 0.98, res.colTop - 0.05, c[1] * 0.98, { kind: o.lanternKind || 'palace', size: 0.7 });
  if (o.eaveLights) eaveLights(b, info, o.eaveLights === true ? {} : o.eaveLights);
  return info;
}

/** 把在 b.push(x, 0, z, yaw) 局部系中得到的屋顶线（eaveLines/ridgeLines）换算到外层坐标系（供 eaveLights 使用） */
function xformRoofLines(r, x, z, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const f = (p) => [x + p[0] * c + p[2] * s, p[1], z - p[0] * s + p[2] * c];
  if (r.eaveLines) r.eaveLines = r.eaveLines.map((l) => l.map(f));
  if (r.ridgeLines) r.ridgeLines = r.ridgeLines.map((l) => l.map(f));
  return r;
}

// ───────────── 组合器：牌坊 ─────────────
/**
 * 牌坊（牌楼）：bays 1/3/5 间，width 总宽（柱中线），h 明间净高（额枋底），kind 'wood'（彩画木牌楼）|'stone'（石牌坊），
 * roofs（楼顶，默认 true），text（明间匾额）、sideText（次间匾额数组）、roofColor、style。正面朝 +Z，原点 = 中心地面。
 */
export function paifang(b, o = {}) {
  const style = o.style || b.style || 'ming';
  const pal = palette(style, o.pal);
  const nb = o.bays ?? 3;
  const stone = o.kind === 'stone';
  const W = o.width ?? (nb === 1 ? 5 : nb === 3 ? 14 : 22);
  const cw = W / (nb === 1 ? 1 : nb === 3 ? 2.6 : 4.2);
  const sw = nb === 1 ? 0 : (W - cw) / (nb - 1);
  const bays = nb === 1 ? [cw] : Array.from({ length: nb }, (_, i) => (i === (nb - 1) / 2 ? cw : sw));
  const xs = bayCoords(bays);
  const h = o.h ?? clamp(cw * 1.15, 4, 9);
  const y0 = o.y0 ?? 0;
  const pw = o.postW ?? clamp(h * 0.075, 0.35, 0.7);
  const colC = stone ? 0xd9d3c8 : pal.col;
  const mk = stone ? 'stone' : 'paint';
  const info = { roofs: [], columns: [], footprint: rectPoly(W + 2, 3), style, w: W + 2, d: 3 };
  // 柱 + 夹杆石 + 戗
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const center = i === (xs.length - 1) / 2 - 0.5 || i === (xs.length - 1) / 2 + 0.5;
    const ph = (center || nb === 1 ? h * 1.28 : h * 1.08) + (o.roofs === false ? 0.6 : 0);
    if (stone) b.box('stone', x - pw / 2, y0, -pw / 2, x + pw / 2, y0 + ph, pw / 2, colC, { skip: 'bottom' });
    else b.cyl('paint', x, y0, 0, pw / 2, pw * 0.47, ph, b.detail >= 2 ? 12 : 8, colC, { top: false });
    b.box('stone', x - pw * 0.95, y0, -pw * 1.25, x + pw * 0.95, y0 + clamp(h * 0.24, 1.0, 2.2), pw * 1.25, 0xcfc8ba, { skip: 'bottom' }); // 夹杆石
    if (b.detail >= 2) b.box('stone', x - pw * 1.05, y0 + clamp(h * 0.24, 1.0, 2.2), -pw * 1.35, x + pw * 1.05, y0 + clamp(h * 0.24, 1.0, 2.2) + 0.14, pw * 1.35, 0xcfc8ba);
    info.columns.push([x, 0, y0, y0 + ph, pw]);
  }
  // 每间：额枋 + 花板 + 匾 + 楼
  for (let i = 0; i < nb; i++) {
    const center = i === (nb - 1) / 2;
    const xa = xs[i], xb = xs[i + 1];
    const yb = y0 + (center ? h : h * 0.8);
    const fH = clamp(cw * 0.07, 0.3, 0.6);
    const t = pw * 0.8;
    beam(b, [xa, 0], [xb, 0], yb, fH, t, { mat: stone ? 'stone' : 'caihua', row: style === 'tang' ? 2 : 1, color: stone ? 0xd9d3c8 : 0xffffff, ext: pw * (i === 0 || i === nb - 1 ? 0.6 : 0) });
    const yPl = yb + fH;
    const plH = center ? clamp(cw * 0.2, 0.9, 2.0) : clamp(sw * 0.16, 0.6, 1.4);
    // 花板（字牌所在）
    b.box(mk, xa + pw / 2, yPl, -t * 0.3, xb - pw / 2, yPl + plH, t * 0.3, stone ? 0xd9d3c8 : pal.frame, { skip: 'bottom' });
    const text = center ? o.text : o.sideText?.[i < (nb - 1) / 2 ? 0 : 1];
    if (text && b.detail >= 1) {
      const tw = Math.min((xb - xa) * 0.55, plH * 3.4);
      for (const sg of [1, -1]) {
        b.push(0, 0, 0, sg > 0 ? 0 : Math.PI);
        b.plaque(text, sg > 0 ? (xa + xb) / 2 : -(xa + xb) / 2, yPl + plH / 2, t * 0.3 + 0.04, tw, plH * 0.8, { bg: stone ? '#cfc6b4' : '#1d3553', color: stone ? '#3a2c20' : '#e8c46a', border: stone ? '#a89c86' : '#d4a94e' });
        b.pop();
      }
    }
    const yTop = yPl + plH;
    beam(b, [xa, 0], [xb, 0], yTop, fH * 0.8, t, { mat: stone ? 'stone' : 'caihua', row: 0, color: stone ? 0xd9d3c8 : 0xffffff, ext: pw * 0.3 });
    if (o.roofs !== false) {
      // 楼：小斗拱 + 庑殿顶
      const rw = xb - xa + pw * 0.8, rd = Math.max(1.2, pw * 2.4);
      const ringR = rectRing([(xa + xb) / 2 - rw / 2, (xa + xb) / 2 + rw / 2], [-rd / 2, rd / 2]);
      const H = clamp(rw * 0.07, 0.35, 0.8);
      const br = bracketRing(b, ringR, { y: yTop + fH * 0.8, H, style, pal: stone ? palette(style, { dou: 0xd4cec2, gong: 0xd9d3c8, ang: 0xd9d3c8, armEnd: 0xd9d3c8, panel: 0xd0c9bc }) : pal, perBay: Math.max(2, Math.round(rw / (H * 1.3))) - 1, panel: true });
      const ov = clamp(rw * 0.12, 0.6, 1.3);
      // 楼顶按本间中心放置（roof() 以当前局部原点为平面中心）
      const cxb = (xa + xb) / 2;
      b.push(cxb, 0, 0, 0);
      const r = roof(b, { type: o.roofType || 'wudian', w: rw, d: rd, y: roofYFor({ style, type: 'wudian', overhang: ov }, br.bearY, br.proj), overhang: ov, style, pal, color: o.roofColor ?? (stone ? 'darkgray' : 'yellow'), beasts: center ? 3 : 1 });
      b.pop();
      info.roofs.push(xformRoofLines(r, cxb, 0));
    }
  }
  info.topY = Math.max(y0 + h * 1.4, ...info.roofs.map((r) => r.topY));
  if (o.eaveLights) eaveLights(b, info, o.eaveLights === true ? {} : o.eaveLights);
  return info;
}

// ───────────── 组合器：廊 ─────────────
/**
 * 廊（游廊/回廊）：沿平面折线 pts=[[x,z]...]（廊中心线），w 廊宽，colH，bay（柱距），roof 'juanpeng'（卷棚，默认）|'xuanshan'，
 * closed（闭合回廊）、seats（坐凳栏杆，默认 true）、hanging（倒挂楣子，默认 true）、style、roofColor、y0、platformH（0.3）
 */
export function corridor(b, pts, o = {}) {
  const style = o.style || b.style || 'ming';
  const pal = palette(style, o.pal);
  const w = o.w ?? 3, colH = o.colH ?? 3.0, bay = o.bay ?? 3.3;
  const y0 = o.y0 ?? 0;
  const pH = o.platformH ?? 0.3;
  const F = frameDims(style, colH, { colD: o.colD ?? 0.26, bracketH: 0.3 });
  const n = pts.length;
  const segs = o.closed ? n : n - 1;
  const info = { roofs: [], columns: [], style };
  for (let i = 0; i < segs; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const L = Math.hypot(dx, dz);
    if (L < 1) continue;
    const yaw = -Math.atan2(dz, dx); // 局部 x 沿廊
    b.push((p0[0] + p1[0]) / 2, 0, (p0[1] + p1[1]) / 2, yaw);
    // 局部：x 沿廊，z 横向（±w/2）
    const nb = Math.max(1, Math.round(L / bay));
    const xs = bayCoords(Array(nb).fill(L / nb));
    if (pH > 0) b.box('stone', -L / 2 - w / 2, y0, -w / 2 - 0.4, L / 2 + w / 2, y0 + pH, w / 2 + 0.4, 0xcfc8ba, { skip: 'bottom' });
    const yP = y0 + pH;
    const ring = rectRing(xs, [-w / 2, w / 2]);
    // 柱（去掉与下一段共享的末柱）
    const cols = [];
    for (const z of [-w / 2, w / 2]) for (let k = 0; k < xs.length; k++) if (!(o.closed || i < segs - 1) || k < xs.length - 1) cols.push([xs[k], z]);
    columns(b, cols, { y0: yP, h: colH, D: F.D, style, pal, base: b.detail >= 2 });
    // 檐枋 + 檩
    for (const z of [-w / 2, w / 2]) {
      beam(b, [xs[0] - 0.3, z], [xs[xs.length - 1] + 0.3, z], yP + colH - F.D * 1.1, F.D * 1.1, F.D * 0.8, { mat: 'caihua', row: style === 'tang' ? 2 : 0 });
      if (b.detail >= 1 && o.hanging !== false)
        for (let k = 0; k < xs.length - 1; k++) {
          b.push(0, 0, z, z > 0 ? 0 : Math.PI);
          const xa = z > 0 ? xs[k] : -xs[k + 1], xb = z > 0 ? xs[k + 1] : -xs[k];
          latticePanel(b, xa + F.D * 0.5, xb - F.D * 0.5, yP + colH - F.D * 1.1 - 0.4, yP + colH - F.D * 1.1, { pattern: 1, color: pal.lattice, cell: 0.28, lit: 0 });
          b.pop();
        }
      if (o.seats !== false && b.detail >= 1) {
        const skip = o.openings?.[i] || [];
        for (let k = 0; k < xs.length - 1; k++) {
          if (skip.includes(k)) continue;
          balustrade(b, [[xs[k] + F.D * 0.6, yP, z], [xs[k + 1] - F.D * 0.6, yP, z]], { kind: 'seat', color: pal.railing, h: 0.5, spacing: 4, endPosts: false });
        }
      }
    }
    const bear = yP + colH + F.D * 0.2;
    const ov = o.overhang ?? 0.9;
    const type = o.roof || 'juanpeng';
    // 转角处屋面只向相邻段一侧延伸 w/2（p0 端 = 局部 -x，p1 端 = 局部 +x）
    const extL = o.closed || i > 0 ? w * 0.5 : 0, extR = o.closed || i < segs - 1 ? w * 0.5 : 0;
    const rOff = (extR - extL) / 2;
    b.push(rOff, 0, 0, 0);
    const r = roof(b, { type, w: L + extL + extR, d: w, y: roofYFor({ style, type, overhang: ov }, bear, F.D * 0.6), overhang: ov, style, pal, color: o.roofColor ?? 'gray', underside: 'full', gableOverhang: 0.35, rafters: b.detail >= 2 });
    b.pop();
    b.pop();
    xformRoofLines(r, rOff, 0);
    info.roofs.push(xformRoofLines(r, (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, yaw));
  }
  return info;
}

// ───────────── 夜景：轮廓灯 ─────────────
/**
 * LED 轮廓灯（大唐不夜城/城墙夜景的暖金勾边）：沿檐口、屋脊、柱子布置发光灯条（emit 材质，夜间自动亮）。
 *   info：hall()/multiStoreyTower()/pavilion()/paifang() 的返回值，或 {roofs:[roof() 返回值], columns:[[x,z,y0,y1,D]]}
 *   o: {color（默认暖金 0xffc56a）, width（灯条截面，默认 0.07）, eaves:true, ridges:true, columns:false, colSides:'front'|'all'}
 */
export function eaveLights(b, info, o = {}) {
  const col = o.color ?? 0xffc56a;
  const wdt = o.width ?? 0.07;
  for (const r of info.roofs || []) {
    if (o.eaves !== false)
      for (const line of r.eaveLines || []) {
        // 连檐上沿稍外、稍下
        const pts = line.map((p) => [p[0], p[1] - 0.04, p[2]]);
        const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[2], 0) / pts.length;
        b.led(pts.map((p) => {
          const dx = p[0] - cx, dz = p[2] - cz, l = Math.hypot(dx, dz) || 1;
          return [p[0] + (dx / l) * 0.05, p[1], p[2] + (dz / l) * 0.05];
        }), { color: col, width: wdt });
      }
    if (o.ridges !== false) for (const line of r.ridgeLines || []) b.led(line, { color: col, width: wdt });
  }
  if (o.columns && info.columns) {
    for (const [x, z, y0, y1, D] of info.columns) {
      const l = Math.hypot(x, z) || 1;
      const r0 = (D ?? 0.5) / 2 + 0.03;
      b.led([[x + (x / l) * r0, y0 + 0.2, z + (z / l) * r0], [x + (x / l) * r0, y1 - 0.1, z + (z / l) * r0]], { color: col, width: wdt });
    }
  }
}
