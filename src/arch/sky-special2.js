// skyline：2026-09 新增特殊地标构件——曲江 W 酒店·万众国际、浐灞凯悦“叠石”塔、灞河 2 号桥（彩虹桥）、浐灞 1 号桥（蝴蝶桥）、
// 后海东岸夜市灯串。数据见 sky-data2.js，调研见 research/refs/{qujiang,chanba}/。
import * as THREE from 'three';
import * as G from './sky-geom.js';
import { buildTower, buildPodium, groundMin } from './sky-towers.js';
import { roadY, chainage } from '../core/roadheight.js';
import { strut } from './sky-special.js';

const D = Math.PI / 180;

// ───────────── 曲江·万众国际 + 西安 W 酒店 ─────────────
// 三栋楼“下大上小、体量被斜面收缩到屋顶形成一个尖”，整体呈“山”字形；深灰蓝玻璃 + 浅灰金属竖肋；
// 夜间层间暗藏像素灯条（媒体立面）。裙房为 C 形连体商业（WFive Park），开口朝西北南湖。
export function buildW(env, S) {
  buildPodium(env, {
    pts: S.site, h: S.podiumH,
    style: { tint: '#2f3c47', spd: '#b4b8bc', floorH: 5.5, colW: 3.2, spandrel: 0.3 },
    signs: [{ text: 'WFIVE PARK 万众国际', h: 3.4, faces: 1 }],
  });
  const [qx, qz] = S.court;
  for (const t of S.towers) {
    const c = G.centroid(G.ccw(t.pts));
    const dx = c.x - qx, dz = c.z - qz; // 塔尖朝外（背离中心庭园）
    buildTower(env, {
      key: t.key, name: t.name, pts: t.pts, h: t.h, taper: 0.62,
      slope: { dir: [dx, dz], drop: t.h * 0.3 },
      roof: { mech: false },
      style: { tint: '#2b3a48', spd: '#aeb4ba', floorH: 4.2, colW: 1.4, spandrel: 0.18, mullW: 0.14, lit: 0.45, mode: 2, seed: 120 + t.h },
      signs: t.sign ? [{ text: t.sign, color: '#ff4fb0', h: 13, faces: 2, y: t.h * 0.52, glow: '#ff4fb0' }] : [],
    });
  }
}

// ───────────── 浐灞凯悦（叠石流水） ─────────────
export function buildHyatt(env, H) {
  const { ctx } = env;
  const P = H.podium;
  const ppts = G.rect(H.cx + P.dx, H.cz + P.dz, P.w, P.d, P.rot * D, { round: 10, seg: 5 });
  const base = groundMin(ctx, ppts);
  buildPodium(env, { pts: ppts, h: P.h, base, style: { tint: '#3a4650', spd: '#cfc6b8', floorH: 5.5 }, signs: [{ text: '凯悦酒店', h: 3.4, faces: 1, color: '#f4e4c6' }] });
  let y = 0;
  H.blocks.forEach((b, i) => {
    const last = i === H.blocks.length - 1;
    const pts = G.rect(H.cx + b.dx, H.cz + b.dz, b.w, b.d, b.rot * D, { round: Math.min(b.d * 0.42, 11), seg: 5 });
    buildTower(env, {
      key: 'hyatt' + i, pts, h: b.h, base: base + y,
      // 每块底部 1.8 m 退进的“石缝”（玻璃暗缝 + 夜间线性灯）
      tiers: i ? [{ to: 1.8, inset: 1.8, style: { mode: 2, spandrel: 0, lit: 0.9 } }, { to: 1, inset: 0 }] : undefined,
      roof: last ? { parapet: 1.2, mech: true } : { parapet: 0.6, mech: false },
      style: { tint: '#56636d', spd: '#cfc6b8', floorH: 4.0, colW: 1.6, spandrel: 0.34, mullW: 0.1, lit: 0.55, seed: 130 + i },
      signs: last ? [{ text: 'HYATT REGENCY 凯悦', color: '#ffffff', h: 3.6, faces: 2 }] : [],
    });
    y += b.h;
  });
}

// ───────────── 桥面高程：取经过 (x,z) 的桥梁路段的路面高 ─────────────
function deckY(ctx, x, z) {
  const R = ctx.data.roads;
  let best = null;
  for (const f of R?.features || []) {
    if (!f.b) continue;
    const p = f.p;
    let near = false;
    for (let i = 0; i < p.length; i += 2) if (Math.abs(p[i] - x) < 400 && Math.abs(p[i + 1] - z) < 400) { near = true; break; }
    if (!near) continue;
    const ch = chainage(p), total = ch[ch.length - 1];
    for (let i = 0; i + 2 < p.length; i += 2) {
      const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
      const L2 = (bx - ax) ** 2 + (bz - az) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2));
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t, d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { d, y: roadY(ctx.terrain, f, px, pz, ch[i / 2] + Math.sqrt(L2) * t, total) };
    }
  }
  return best && best.d < 40 && best.y != null ? best.y : ctx.terrain.heightAt(x, z) + 8;
}

// 彩虹灯：沿参数 u 流动的色相（夜间），白天为白色/浅灰钢
function rainbowMaterial(ctx, { day = 0xe8eaec, lit = true, strength = 2.4 } = {}) {
  const m = new THREE.MeshStandardMaterial({ color: day, metalness: 0.55, roughness: 0.35 });
  if (!lit) return m;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aHue;\nvarying float vHue;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHue = aHue;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uTime; uniform float uNight; varying float vHue;
vec3 rbHue(float h) { vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); return k * k * (3.0 - 2.0 * k); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += rbHue(fract(vHue - uTime * 0.05)) * ${strength.toFixed(2)} * smoothstep(0.3, 0.8, uNight);`);
  };
  m.customProgramCacheKey = () => 'rainbow-' + strength;
  return m;
}
function withHue(g, h0, h1) {
  const n = g.attributes.position.count, a = new Float32Array(n);
  const uv = g.attributes.uv;
  for (let i = 0; i < n; i++) a[i] = h0 + (h1 - h0) * (uv ? uv.getX(i) : 0);
  g.setAttribute('aHue', new THREE.BufferAttribute(a, 1));
  return g;
}

// ───────────── 灞河 2 号桥（彩虹桥） ─────────────
// 独塔双索面、拱形单斜塔：椭圆拱圈跨桥面、整体向边跨一侧倾斜；两片索面各 41 根，主跨 145 m 伸向东北
export function buildRainbowBridge(env, S) {
  const { ctx } = env;
  const [ax, az] = S.a, [bx, bz] = S.b;
  const L = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / L, uz = (bz - az) / L; // 桥轴（西南→东北）
  const lx = -uz, lz = ux; // 横向
  const tx = ax + ux * L * S.t, tz = az + uz * L * S.t;
  const y0 = deckY(ctx, tx, tz);
  const grp = new THREE.Group();
  grp.name = '灞河2号桥（彩虹桥）';
  const archPt = (th) => {
    // θ∈[0,π]：横向 cos、竖向 sin；整体绕横轴向边跨（-u）倾斜 tilt
    const lat = Math.cos(th) * S.archHalf, up = Math.sin(th) * S.archH;
    const back = -Math.sin(S.tilt) * up, vy = Math.cos(S.tilt) * up;
    return new THREE.Vector3(tx + lx * lat + ux * back, y0 - 2 + vy, tz + lz * lat + uz * back);
  };
  class ArchCurve extends THREE.Curve {
    getPoint(t) { return archPt(t * Math.PI); }
  }
  const archGeo = withHue(new THREE.TubeGeometry(new ArchCurve(), 64, 1.5, 10, false), 0, 1);
  const archMat = rainbowMaterial(ctx, { day: 0xeef0f2, strength: 1.1 });
  const arch = new THREE.Mesh(archGeo, archMat);
  arch.castShadow = true;
  grp.add(arch);
  // 拱脚承台
  for (const s of [-1, 1]) {
    const f = G.cyl(tx + lx * s * S.archHalf, y0 - 12, tz + lz * s * S.archHalf, 3.2, 3.2, 10, 12);
    grp.add(new THREE.Mesh(f, env.mats.white));
  }
  // 斜拉索：每片 41 根，锚点沿拱圈上段，桥面锚点分布于主跨（+u）与边跨（-u），落在桥面两侧
  // （拱圈锚点取在与桥面锚点同侧的拱腿上：lat = cos(th)·archHalf 与 side 同号，两片索面互不交叉）
  const cab = [];
  const n = S.cables, deckHalf = S.deckHalf ?? 13.2;
  for (const side of [-1, 1]) {
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1);
      const main = k < Math.round(n * 0.6);
      const kk = main ? k / (Math.round(n * 0.6) - 1) : (k - Math.round(n * 0.6)) / (n - Math.round(n * 0.6) - 1);
      const s = main ? 22 + kk * (S.span - 26) : -(18 + kk * (S.back - 22));
      const th = Math.PI / 2 - side * (0.12 + 0.55 * (main ? kk : kk * 0.8)) * 0.5;
      const A = archPt(th);
      const B = new THREE.Vector3(tx + ux * s + lx * side * deckHalf, y0 + 1.2, tz + uz * s + lz * side * deckHalf);
      const g = strut(A, B, 0.28);
      const uvn = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvn * 2).fill(f), 2));
      cab.push(withHue(g, f, f));
    }
  }
  const cm = new THREE.Mesh(mergeAll(cab), rainbowMaterial(ctx, { day: 0xdfe3e6, strength: 1.2 }));
  cm.name = '斜拉索';
  grp.add(cm);
  // 桥面两侧彩虹灯带
  const edge = [];
  for (const side of [-1, 1]) {
    const pts = [];
    for (let s = -L * S.t; s <= L * (1 - S.t); s += 8) pts.push(new THREE.Vector3(tx + ux * s + lx * side * (deckHalf + 0.2), deckY(ctx, tx + ux * s, tz + uz * s) + 1.4, tz + uz * s + lz * side * (deckHalf + 0.2)));
    if (pts.length > 2) edge.push(withHue(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.18, 5, false), 0, 3));
  }
  if (edge.length) grp.add(new THREE.Mesh(mergeAll(edge), rainbowMaterial(ctx, { day: 0x8f969c, strength: 1.6 })));
  env.beacons.add(tx - ux * Math.sin(S.tilt) * S.archH, y0 + S.archH * Math.cos(S.tilt) + 1, tz - uz * Math.sin(S.tilt) * S.archH, 0, 4);
  return grp;
}

// ───────────── 浐灞 1 号桥（蝴蝶桥） ─────────────
export function buildButterflyBridge(env, S) {
  const { ctx } = env;
  const [ax, az] = S.a, [bx, bz] = S.b;
  const L = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / L, uz = (bz - az) / L, lx = -uz, lz = ux;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  const y0 = deckY(ctx, mx, mz);
  const grp = new THREE.Group();
  grp.name = '浐灞1号桥（蝴蝶桥）';
  const rib = (side) => {
    const pt = (t) => {
      const s = (t - 0.5) * S.span, up = S.rise * (1 - (2 * t - 1) ** 2);
      const out = S.half + Math.sin(S.lean) * up; // 拱肋向外倾
      return new THREE.Vector3(mx + ux * s + lx * side * out, y0 + 0.5 + Math.cos(S.lean) * up, mz + uz * s + lz * side * out);
    };
    class C extends THREE.Curve { getPoint(t) { return pt(t); } }
    const g = withHue(new THREE.TubeGeometry(new C(), 40, 0.9, 8, false), 0.55, 0.7);
    const hs = [];
    for (let k = 1; k < 16; k++) {
      const t = k / 16, P = pt(t);
      const Q = new THREE.Vector3(mx + ux * (t - 0.5) * S.span + lx * side * S.half, y0 + 0.6, mz + uz * (t - 0.5) * S.span + lz * side * S.half);
      const h = strut(Q, P, 0.12);
      h.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(h.attributes.position.count * 2).fill(0.6), 2));
      hs.push(withHue(h, 0.6, 0.6));
    }
    return mergeAll([g, ...hs]);
  };
  const mat = rainbowMaterial(ctx, { day: 0xf2f3f4, strength: 1.2 });
  grp.add(new THREE.Mesh(mergeAll([rib(-1), rib(1)]), mat));
  return grp;
}

// ───────────── 后海东岸：观景步道 + 夜市摊位灯串 ─────────────
/**
 * 名为 name 的道路在 a→b 路段范围内（沿 a→b 投影 0..L、横向 300 m 内）的折线，按 a→b 方向排列 [[x,z],...]；
 * 双幅路取偏 side（offset 符号）一侧的那幅。找不到返回 null。
 */
function roadPath(ctx, name, a, b, side) {
  const [ax, az] = a, [bx, bz] = b;
  const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
  const runs = [];
  for (const f of ctx.data.roads?.features || []) {
    if (f.n !== name || !f.p) continue;
    const p = f.p;
    let run = [];
    for (let i = 0; i + 1 < p.length; i += 2) {
      const s = (p[i] - ax) * ux + (p[i + 1] - az) * uz, l = (p[i] - ax) * nx + (p[i + 1] - az) * nz;
      if (s >= 0 && s <= L && Math.abs(l) < 300) run.push([p[i], p[i + 1], s, l]);
      else if (run.length) { runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);
  }
  const cand = runs.filter((r) => r.length >= 2).map((r) => ({ r, span: Math.abs(r[r.length - 1][2] - r[0][2]), lat: r.reduce((t, q) => t + q[3], 0) / r.length }));
  if (!cand.length) return null;
  const maxSpan = Math.max(...cand.map((c) => c.span));
  if (maxSpan < L * 0.5) return null;
  const best = cand.filter((c) => c.span >= maxSpan * 0.8).sort((p, q) => side * (q.lat - p.lat))[0].r;
  if (best[0][2] > best[best.length - 1][2]) best.reverse();
  return best.map((q) => [q[0], q[1]]);
}

/** 折线按弧长取点：返回 {x, z, tx, tz}（单位切线） */
function pathSampler(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  let k = 0;
  const at = (d) => {
    if (d < cum[k]) k = 0;
    while (k < path.length - 2 && cum[k + 1] < d) k++;
    const [x0, z0] = path[k], [x1, z1] = path[k + 1];
    const sl = cum[k + 1] - cum[k] || 1, t = Math.max(0, Math.min(1, (d - cum[k]) / sl));
    return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, tx: (x1 - x0) / sl, tz: (z1 - z0) / sl };
  };
  return { length: cum[cum.length - 1], at };
}

/** 点是否落在水面多边形内（water.json：{outer, holes}），只检查与 bbox 相交的水面 */
function waterTester(ctx, bb) {
  const polys = [];
  for (const w of ctx.data.water?.polys || []) {
    const o = w.outer;
    if (!o || o.length < 6) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
    if (x1 < bb.x0 || x0 > bb.x1 || z1 < bb.z0 || z0 > bb.z1) continue;
    polys.push({ o, holes: (w.holes || []).filter((h) => h.length >= 6), x0, x1, z0, z1 });
  }
  const pip = (x, z, p) => {
    let c = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
    }
    return c;
  };
  return (x, z) => polys.some((w) => x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1 && pip(x, z, w.o) && !w.holes.some((h) => pip(x, z, h)));
}

export function buildHouhai(env, S) {
  const { ctx } = env;
  // 沿真实道路布置（找不到道路时退回直线 a→b）
  const path = (S.road && roadPath(ctx, S.road, S.a, S.b, Math.sign(S.offset) || -1)) || [S.a, S.b];
  const P = pathSampler(path);
  const L = P.length;
  // 局部法线 (-tz, tx)：与原 a→b 直线的 n = (-uz, ux) 同向，offset 的正负含义不变
  const off = (d, o) => {
    const q = P.at(d);
    return { x: q.x - q.tz * o, z: q.z + q.tx * o, tx: q.tx, tz: q.tz };
  };
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const [x, z] of path) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
  const pad = Math.abs(S.offset) + 10;
  const inWater = waterTester(ctx, { x0: bx0 - pad, x1: bx1 + pad, z0: bz0 - pad, z1: bz1 + pad });
  const grp = new THREE.Group();
  grp.name = '后海夜市';
  const stallGeo = new THREE.BoxGeometry(2.6, 2.3, 2.2).translate(0, 1.15, 0);
  const stallMat = new THREE.MeshStandardMaterial({ roughness: 0.7, emissive: 0xffd9a0, emissiveIntensity: 0 });
  ctx.night.register(stallMat, { day: 0, night: 0.5 });
  const bulbGeo = new THREE.SphereGeometry(0.16, 6, 4);
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffc070, emissiveIntensity: 0 });
  ctx.night.register(bulbMat, { day: 0.05, night: 3.2 });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const cols = [0xc8261c, 0xf2f2f2, 0x1e4e9a, 0xe0a21c, 0x2e8b57];
  // 摊位（落水的跳过）
  const sM = [], sC = [];
  const nS = Math.floor(L / 7);
  for (let i = 0; i < nS; i++) {
    const o = off((i + 0.5) * 7, S.offset);
    if (inWater(o.x, o.z)) continue;
    q.setFromAxisAngle(Y, Math.atan2(o.tx, o.tz));
    p.set(o.x, ctx.terrain.heightAt(o.x, o.z), o.z);
    sM.push(m.compose(p, q, sc).clone());
    sC.push(new THREE.Color(cols[i % cols.length]));
  }
  // 灯串（落水的跳过）
  const bM = [];
  const nB = Math.floor(L / 1.6);
  for (let i = 0; i < nB; i++) {
    const s = i * 1.6, o = off(s, S.offset + 2.8);
    if (inWater(o.x, o.z)) continue;
    const sag = Math.sin(((s % 12) / 12) * Math.PI) * 0.6;
    bM.push(new THREE.Matrix4().makeTranslation(o.x, ctx.terrain.heightAt(o.x, o.z) + 3.6 - sag, o.z));
  }
  if (sM.length) {
    const stalls = new THREE.InstancedMesh(stallGeo, stallMat, sM.length);
    sM.forEach((mm, i) => { stalls.setMatrixAt(i, mm); stalls.setColorAt(i, sC[i]); });
    stalls.instanceMatrix.needsUpdate = true;
    stalls.computeBoundingSphere();
    stalls.castShadow = true;
    grp.add(stalls);
  }
  if (bM.length) {
    const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, bM.length);
    bM.forEach((mm, i) => bulbs.setMatrixAt(i, mm));
    bulbs.instanceMatrix.needsUpdate = true;
    bulbs.computeBoundingSphere();
    grp.add(bulbs);
  }
  // 暖光点光源（LightPool 强度单位为坎德拉，与其他街灯同量级）
  for (let s = 100; s < L; s += 300) {
    const o = off(s, S.offset);
    if (inWater(o.x, o.z)) continue;
    ctx.lights.add({ position: new THREE.Vector3(o.x, ctx.terrain.heightAt(o.x, o.z) + 5, o.z), color: 0xffb870, intensity: 600, distance: 40, nightOnly: true });
  }
  grp.userData.stats = { stalls: sM.length, bulbs: bM.length, pathLen: Math.round(L) };
  return grp;
}

function mergeAll(geos) {
  const attrs = ['position', 'normal', 'uv', 'aHue'];
  const out = {};
  for (const a of attrs) out[a] = [];
  for (let g of geos) {
    g = g.index ? g.toNonIndexed() : g;
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    for (const a of attrs) {
      const at = g.attributes[a];
      const size = a === 'position' || a === 'normal' ? 3 : a === 'uv' ? 2 : 1;
      if (at) out[a].push(...at.array);
      else out[a].push(...new Array(n * size).fill(0));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2));
  g.setAttribute('aHue', new THREE.Float32BufferAttribute(out.aHue, 1));
  g.computeBoundingSphere();
  return g;
}
