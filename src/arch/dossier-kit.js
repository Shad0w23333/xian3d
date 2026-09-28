// 逐栋档案建模库：buildDossier(env, spec)
// 目标：按 research/refs/dossiers/*.json（逐栋档案：实测轮廓、高度/层数出处、形体分块、塔冠、立面、招牌、夜景、照片）
//       与照片逐栋建模，不做主观臆断。spec 写在 src/arch/dossier-specs/<片区>.js（每个文件 export default 一个数组），
//       字段说明与示例见 docs/DOSSIER_KIT.md。
// 坐标：世界系 X 东、Z 南（北 = −Z），原点钟楼；spec 里的方位一律用“地图习惯”：
//       offset:[东, 北]（米，相对建筑中心），rot = 长边相对正东逆时针（度，北 = 90），face:'N|E|S|W|NE|…'。
// 高度：part.base / part.top / sign.y / masts.top 等都是“离地米数”（地面 = 建筑所有体块轮廓下的最低地形高）。
// 渲染：沿用 skyline 的共享幕墙着色器（sky-facade.js 模式 0–9）、buildTower / buildPodium（sky-towers.js）与招牌图集，
//       塔冠 / 桅杆 / 飞碟圆盘 / 装饰线条 / 泛光 / 媒体屏由本库补充。
import * as THREE from 'three';
import * as G from './sky-geom.js';
import { buildTower, buildPodium, groundMin } from './sky-towers.js';
import { style as mkStyle } from './sky-facade.js';
import { vault } from './sky-special.js';

const D = Math.PI / 180;
const TAU = Math.PI * 2;

// ═════════════════════════ 轮廓库（public/data/dossier_fp.json，tools/build_dossier_fp.py 生成） ═════════════════════════
let FP = {};
/** 设置轮廓库（dossier 模块 prepare 时加载后调用） */
export function setFootprints(json) {
  FP = json || {};
}
function fpKey(id) {
  if (!id) return null;
  if (FP[id]) return id;
  const a = FP._alias?.[id];
  if (a && FP[a]) return a;
  if (/^[0-9a-f]{8}$/.test(id)) for (const k in FP) if (k[0] !== '_' && k.startsWith(id)) return k;
  return null;
}
/** Overture 轮廓（世界坐标 CCW 扁平数组）；id 可以是完整 UUID 或 8 位前缀；找不到返回 null */
export function footprint(id) {
  const k = fpKey(id);
  return k ? FP[k] : null;
}
/** 轮廓的内环（内院/天井），没有返回 [] */
export function footprintHoles(id) {
  const k = fpKey(id);
  return (k && FP._holes?.[k]) || [];
}
/** 轮廓元数据 {n 名称, src 来源, h, f, a 面积, c 质心} */
export function footprintMeta(id) {
  const k = fpKey(id);
  return (k && FP._meta?.[k]) || null;
}

// ═════════════════════════ 方位与局部坐标 ═════════════════════════
const FACES = { E: 0, ENE: 22.5, NE: 45, NNE: 67.5, N: 90, NNW: 112.5, NW: 135, WNW: 157.5, W: 180, WSW: 202.5, SW: 225, SSW: 247.5, S: 270, SSE: 292.5, SE: 315, ESE: 337.5 };
/** 方位角（度，正东 = 0 逆时针，北 = 90）→ 世界系单位向量 [dx, dz] */
export const dirOf = (deg) => [Math.cos(deg * D), -Math.sin(deg * D)];
/** 'N' / 'SW' / 角度 / [dx,dz] → 世界系单位向量 */
export function faceDir(f) {
  if (Array.isArray(f)) {
    const l = Math.hypot(f[0], f[1]) || 1;
    return [f[0] / l, f[1] / l];
  }
  if (typeof f === 'number') return dirOf(f);
  const a = FACES[String(f).toUpperCase()];
  if (a == null) throw new Error('未知方位 ' + f);
  return dirOf(a);
}
/** 局部 (u 沿长边, w 长边左侧：rot=0 时 u 朝东、w 朝北) → 世界 (x, z) */
function local2world(cx, cz, rotDeg) {
  const c = Math.cos(rotDeg * D), s = Math.sin(rotDeg * D);
  return (u, w) => [cx + u * c - w * s, cz - u * s - w * c];
}
/** 地图偏移 [东, 北] → 世界点 */
const offsetPt = (center, off) => ({ x: center.x + (off?.[0] || 0), z: center.z - (off?.[1] || 0) });

// ═════════════════════════ 平面形状（局部坐标，u 沿长边 L，w 沿短边 W） ═════════════════════════
function arcPts(out, cu, cw, r, a0, a1, n) {
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cu + r * Math.cos(a), cw + r * Math.sin(a)]);
  }
}
/** 过 (±hl, wEnd) 与顶点 (0, apex) 的圆：返回 {cw, R, a0, a1}（a0→a1 逆时针经过顶点） */
function arcThrough(hl, wEnd, apex) {
  const cw = (apex * apex - hl * hl - wEnd * wEnd) / (2 * (apex - wEnd));
  const R = Math.abs(apex - cw);
  const a0 = Math.atan2(wEnd - cw, hl);
  return apex > cw ? { cw, R, a0, a1: Math.PI - a0 } : { cw, R, a0: -a0 - Math.PI, a1: a0 };
}
/**
 * 形状库。返回 {pts:[[u,w],…], holes:[[[u,w],…]]}
 *  rect 矩形 | chamfer 切角（o.c）| round 圆角（o.r, o.seg）| circle/ellipse 圆/椭圆（o.seg）
 *  L（o.arm 竖臂宽、o.arm2 横臂宽；拐角在 −u−w 角，o.flip 镜像）| U（开口朝 +w；o.arm 两臂宽、o.base 底宽）
 *  triangle（底边在 −w，o.apex ∈[−1,1] 顶点位置）| trapezoid（o.top 顶边长、o.shift 顶边偏移）
 *  lens 透镜（两段圆弧，o.flat 两端平直端墙宽）| crescent 新月（外弧弓高 W，o.inner 内弧弓高）
 *  arcSlab 弧形板楼（中线弧弦长 L、弓高 o.sag，厚 W）| ring 圆环（外径 L，环宽 W）
 */
function shapeLocal(shape, L, W, o = {}) {
  const hl = L / 2, hw = W / 2, P = [];
  const n = o.seg ?? 12;
  switch (shape) {
    case 'rect':
      return { pts: [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]] };
    case 'chamfer': {
      const c = Math.min(o.c ?? Math.min(L, W) * 0.12, hl, hw);
      return { pts: [[-hl + c, -hw], [hl - c, -hw], [hl, -hw + c], [hl, hw - c], [hl - c, hw], [-hl + c, hw], [-hl, hw - c], [-hl, -hw + c]] };
    }
    case 'round': {
      const r = Math.min(o.r ?? Math.min(L, W) * 0.2, hl, hw), k = o.seg ?? 6;
      arcPts(P, hl - r, -hw + r, r, -Math.PI / 2, 0, k);
      arcPts(P, hl - r, hw - r, r, 0, Math.PI / 2, k);
      arcPts(P, -hl + r, hw - r, r, Math.PI / 2, Math.PI, k);
      arcPts(P, -hl + r, -hw + r, r, Math.PI, 1.5 * Math.PI, k);
      return { pts: P };
    }
    case 'circle':
    case 'ellipse': {
      const k = o.seg ?? 48;
      for (let i = 0; i < k; i++) P.push([hl * Math.cos((i / k) * TAU), hw * Math.sin((i / k) * TAU)]);
      return { pts: P };
    }
    case 'L': {
      const a = o.arm ?? W * 0.4, b = o.arm2 ?? a;
      const q = [[-hl, -hw], [hl, -hw], [hl, -hw + b], [-hl + a, -hw + b], [-hl + a, hw], [-hl, hw]];
      return { pts: o.flip ? q.map(([u, w]) => [-u, w]).reverse() : q };
    }
    case 'U': {
      const a = o.arm ?? L * 0.3, b = o.base ?? W * 0.4;
      return { pts: [[-hl, -hw], [hl, -hw], [hl, hw], [hl - a, hw], [hl - a, -hw + b], [-hl + a, -hw + b], [-hl + a, hw], [-hl, hw]] };
    }
    case 'triangle':
      return { pts: [[-hl, -hw], [hl, -hw], [(o.apex ?? 0) * hl, hw]] };
    case 'trapezoid': {
      const t = (o.top ?? L * 0.6) / 2, sh = o.shift ?? 0;
      return { pts: [[-hl, -hw], [hl, -hw], [sh + t, hw], [sh - t, hw]] };
    }
    case 'lens': {
      const f = Math.min(o.flat ?? 0, W * 0.95) / 2;
      const A = arcThrough(hl, f, hw);
      P.push([hl, -f]);
      arcPts(P, 0, A.cw, A.R, A.a0, A.a1, n * 2);
      P.push([-hl, -f]);
      const B = [];
      arcPts(B, 0, A.cw, A.R, A.a0, A.a1, n * 2);
      for (const [u, w] of B) P.push([-u, -w]);
      return { pts: dedupe(P) };
    }
    case 'crescent': {
      const inner = -hw + (o.inner ?? W * 0.5);
      const A = arcThrough(hl, -hw, hw), B = arcThrough(hl, -hw, inner);
      arcPts(P, 0, A.cw, A.R, A.a0, A.a1, n * 2);
      const Q = [];
      arcPts(Q, 0, B.cw, B.R, B.a0, B.a1, n * 2);
      Q.reverse();
      return { pts: dedupe(P.concat(Q.slice(1, -1))) };
    }
    case 'arcSlab': {
      const s = o.sag ?? L * 0.15;
      if (s < 1e-3) return shapeLocal('rect', L, W);
      const R = (hl * hl + s * s) / (2 * s), cw = s / 2 - R, phi = Math.asin(Math.min(1, hl / R));
      arcPts(P, 0, cw, R + hw, Math.PI / 2 - phi, Math.PI / 2 + phi, n * 2);
      const Q = [];
      arcPts(Q, 0, cw, R - hw, Math.PI / 2 - phi, Math.PI / 2 + phi, n * 2);
      return { pts: P.concat(Q.reverse()) };
    }
    case 'ring': {
      const k = o.seg ?? 48, ri = Math.max(0.5, hl - W);
      const H = [];
      for (let i = 0; i < k; i++) {
        P.push([hl * Math.cos((i / k) * TAU), hl * Math.sin((i / k) * TAU)]);
        H.push([ri * Math.cos((i / k) * TAU), ri * Math.sin((i / k) * TAU)]);
      }
      return { pts: P, holes: [H] };
    }
    default:
      throw new Error('未知形状 ' + shape);
  }
}
function dedupe(P) {
  const o = [];
  for (const p of P) if (!o.length || Math.hypot(p[0] - o[o.length - 1][0], p[1] - o[o.length - 1][1]) > 0.05) o.push(p);
  if (o.length > 2 && Math.hypot(o[0][0] - o[o.length - 1][0], o[0][1] - o[o.length - 1][1]) < 0.05) o.pop();
  return o;
}

/** 多边形凸角倒圆（四角圆润的商场等）：r 米，每角 seg 段；凹角不处理 */
export function roundCorners(p, r, seg = 5) {
  p = G.ccw(p);
  const n = p.length / 2, out = [];
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, c = (i + 1) % n;
    const x = p[i * 2], z = p[i * 2 + 1];
    let d1x = x - p[a * 2], d1z = z - p[a * 2 + 1], d2x = p[c * 2] - x, d2z = p[c * 2 + 1] - z;
    const l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z);
    d1x /= l1 || 1; d1z /= l1 || 1; d2x /= l2 || 1; d2z /= l2 || 1;
    const cross = d1x * d2z - d1z * d2x; // >0：CCW 轮廓上的凸角
    const turn = Math.acos(Math.max(-1, Math.min(1, d1x * d2x + d1z * d2z)));
    if (cross <= 1e-6 || turn < 10 * D) { out.push(x, z); continue; }
    const t = Math.min(r * Math.tan(turn / 2), l1 * 0.45, l2 * 0.45), rr = t / Math.tan(turn / 2);
    const px = x - d1x * t, pz = z - d1z * t;
    const cx = px - d1z * rr, cz = pz + d1x * rr; // 内法线（CCW：(−dz, dx)）
    const a0 = Math.atan2(pz - cz, px - cx);
    for (let k = 0; k <= seg; k++) {
      const aa = a0 + (turn * k) / seg;
      out.push(cx + Math.cos(aa) * rr, cz + Math.sin(aa) * rr);
    }
  }
  return G.ccw(out);
}

// ═════════════════════════ 立面：语义化 pattern → sky-facade 参数 ═════════════════════════
// sky-facade 模式：0 幕墙 1 LED 线条媒体幕墙 2 楼层线灯 3 横向白色百叶/横带 4 塔冠玻璃 5 LED 大屏 6 商业裙房 7 石材+窗洞 8 彩色泛光 9 石材+暖色基座泛光
export const PATTERNS = {
  curtain: { mode: 0, floorH: 4.0, colW: 1.5, spandrel: 0.22, mullW: 0.1 }, // 普通隐框/明框玻璃幕墙
  grid: { mode: 0, floorH: 4.0, colW: 1.6, spandrel: 0.3, mullW: 0.2 }, // 明显网格（明框 + 窗槛墙）
  verticalFins: { mode: 0, floorH: 4.0, colW: 1.2, spandrel: 0.1, mullW: 0.34 }, // 竖向金属/石材肋
  horizontalBands: { mode: 3, floorH: 3.8, colW: 3.0, spandrel: 0.3, mullW: 0.05 }, // 横向带窗 / 白色横带
  louver: { mode: 3, floorH: 1.6, colW: 4.0, spandrel: 0.55, mullW: 0.04 }, // 密集横向百叶 / 铝板横带
  floorLines: { mode: 2, floorH: 4.0, colW: 1.5, spandrel: 0.24, mullW: 0.1 }, // 夜间楼层线灯
  stoneWindows: { mode: 7, floorH: 3.6, colW: 2.4, spandrel: 0.45, mullW: 0.9 }, // 石材墙 + 窗洞
  stoneLit: { mode: 9, floorH: 3.6, colW: 2.4, spandrel: 0.45, mullW: 0.9 }, // 石材 + 夜间暖色基座泛光
  media: { mode: 1, floorH: 4.0, colW: 1.5, spandrel: 0.2, mullW: 0.14 }, // LED 线条媒体幕墙（夜间彩色动画）
  screen: { mode: 5, floorH: 1, colW: 0.9, spandrel: 0, mullW: 0.04, lit: 0 }, // LED 大屏
  retail: { mode: 6, floorH: 5.5, colW: 3.0, spandrel: 0.3, mullW: 0.18, lit: 0.9 }, // 商业裙房大玻璃
  crownGlass: { mode: 4, floorH: 4.2, colW: 2.6, spandrel: 0, mullW: 0.14, lit: 0 }, // 塔冠泛光玻璃
};
let seedN = 0;
/** part.style → sky-facade 的参数对象（颜色保持十六进制，交给 buildTower/buildPodium 内部 mkStyle 转换） */
export function facadeStyle(st = {}, seed) {
  const { pattern, ...rest } = st;
  const base = pattern ? PATTERNS[pattern] : null;
  if (pattern && !base) throw new Error('未知立面 pattern ' + pattern);
  return { seed: seed ?? (seedN += 7.3), ...(base || {}), ...rest };
}

// ═════════════════════════ 材质 ═════════════════════════
const NAMED = { stone: 'stone', white: 'white', dark: 'dark', metal: 'metal', parapet: 'parapet', glassRoof: 'glassRoof', roof: 'roof', granite: 'granite', membrane: 'membrane', roofTile: 'roofTile', grass: 'grass' };
/** 'stone' | 'white' | … | '#rrggbb' | {color, metalness, roughness, emissive, glow} → 材质（同参数复用） */
export function solidMat(env, m) {
  if (!m) return env.mats.stone;
  if (typeof m === 'string' && NAMED[m]) return env.mats[NAMED[m]];
  const o = typeof m === 'string' ? { color: m } : m;
  const key = 'solid:' + JSON.stringify(o);
  env.dk ??= new Map();
  if (!env.dk.has(key)) {
    const mat = new THREE.MeshStandardMaterial({ color: o.color ?? '#cccccc', metalness: o.metalness ?? 0.15, roughness: o.roughness ?? 0.7 });
    if (o.glow) {
      mat.emissive = new THREE.Color(o.glow);
      mat.emissiveIntensity = 0;
      env.ctx.night.register(mat, { day: o.glowDay ?? 0, night: o.glowNight ?? 2.2 });
    }
    env.dk.set(key, mat);
  }
  return env.dk.get(key);
}
/** 夜间发光材质（轮廓灯/灯带/发光字底色）：白天显示 base 色，夜间自发光 color */
function glowMat(env, color, { base, day = 0, night = 2.6 } = {}) {
  return solidMat(env, { color: base ?? color, glow: color, glowDay: day, glowNight: night, metalness: 0.3, roughness: 0.45 });
}
/** 泛光（floodlight）：贴着立面的加色半透明“光幕”，自下而上渐隐，只在夜间出现 */
function washMat(env, color, strength) {
  const key = 'wash:' + color + strength;
  env.dk ??= new Map();
  if (env.dk.has(key)) return env.dk.get(key);
  const m = new THREE.ShaderMaterial({
    uniforms: { uNight: env.ctx.uniforms.uNight, uColor: { value: new THREE.Color(color) }, uK: { value: strength } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vT;
      void main(){
        vT = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform float uNight; uniform vec3 uColor; uniform float uK; varying float vT;
      void main(){
        #include <logdepthbuf_fragment>
        float a = pow(1.0 - clamp(vT, 0.0, 1.0), 1.7) * uK * uNight;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  m.userData.ownUV = true;
  env.dk.set(key, m);
  return m;
}

// ═════════════════════════ spec 解析（prepare 与 build 共用） ═════════════════════════
function partPolygon(spec, part, center) {
  let pts, holes = [];
  if (part.fp) {
    pts = footprint(part.fp);
    if (!pts) throw new Error(`找不到轮廓 ${part.fp}（先运行 python3 tools/build_dossier_fp.py）`);
    if (part.holes === 'fp') holes = footprintHoles(part.fp);
  } else if (part.pts) {
    pts = part.pts;
  } else if (part.shape) {
    const [L, W = L] = part.size || [];
    if (!(L > 0)) throw new Error(`part ${part.name || ''} 缺 size`);
    const c = part.at ? { x: part.at[0], z: part.at[1] } : offsetPt(center, part.offset);
    const T = local2world(c.x, c.z, part.rot || 0);
    const loc = shapeLocal(part.shape, L, W, part.shapeOpt || {});
    pts = loc.pts.flatMap(([u, w]) => T(u, w));
    holes = (loc.holes || []).map((h) => h.flatMap(([u, w]) => T(u, w)));
  } else throw new Error(`part ${part.name || ''} 需要 fp / pts / shape 之一`);
  pts = G.ccw(pts);
  if (part.grow) pts = G.inset(pts, -part.grow);
  if (part.roundCorners) pts = roundCorners(pts, part.roundCorners, part.roundSeg ?? 5);
  if (Array.isArray(part.holes)) holes = holes.concat(part.holes);
  return { pts, holes };
}
function specCenter(spec) {
  if (spec.center) return { x: spec.center[0], z: spec.center[1] };
  const f = spec.fp ? footprint(spec.fp) : null;
  if (f) return G.centroid(f);
  for (const p of spec.parts || []) {
    const q = p.fp ? footprint(p.fp) : p.pts;
    if (q) return G.centroid(G.ccw(q));
  }
  throw new Error('spec 需要 center / fp，或至少一个带 fp / pts 的 part');
}
/**
 * 解析 spec：各体块世界轮廓、中心、替代声明、占地（排除区）。不依赖地形，prepare 阶段可用。
 * 返回 {spec, center, parts:[{part, name, pts, holes, base, top}], polys（落地体块轮廓，用于排除区/替代判定）}
 */
export function resolveSpec(spec) {
  if (!spec.id) throw new Error('spec 缺 id');
  const center = specCenter(spec);
  const parts = (spec.parts || []).map((part, i) => {
    const { pts, holes } = partPolygon(spec, part, center);
    return { part, i, name: part.name ?? String(i), pts, holes, base: part.base ?? 0, top: part.top };
  });
  for (const p of parts) if (!(p.top > p.base)) throw new Error(`part ${p.name} 的 top 必须大于 base`);
  const polys = parts.filter((p) => p.base <= 0.5 || p.part.footprint).map((p) => p.pts);
  for (const s of [].concat(spec.site || [])) polys.push(G.ccw(typeof s === 'string' ? footprint(s) : s));
  return { spec, center, parts, polys };
}

// ═════════════════════════ 构件 ═════════════════════════
function partCentroid(P) {
  return G.centroid(P.pts);
}
/** 轮廓在方向 dir 上的外缘点（从质心出发的射线与轮廓的交点）与垂直方向的宽度 */
function rayHit(poly, c, dir) {
  const n = poly.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2] - c.x, az = poly[i * 2 + 1] - c.z, bx = poly[j * 2] - c.x, bz = poly[j * 2 + 1] - c.z;
    const ex = bx - ax, ez = bz - az, den = dir[0] * ez - dir[1] * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (ax * ez - az * ex) / den, s = (ax * dir[1] - az * dir[0]) / den;
    if (t > 0 && s >= 0 && s <= 1 && (!best || t > best.t)) best = { t };
  }
  const t = best ? best.t : 0;
  let wmin = Infinity, wmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const w = (poly[i * 2] - c.x) * -dir[1] + (poly[i * 2 + 1] - c.z) * dir[0];
    wmin = Math.min(wmin, w); wmax = Math.max(wmax, w);
  }
  return { x: c.x + dir[0] * t, z: c.z + dir[1] * t, width: wmax - wmin };
}
/** 外法线最接近 dir、且长度 ≥ minL 的边；没有合适的边返回 null */
function pickEdge(poly, dir, minL) {
  const n = poly.length / 2;
  let best = null, bs = -1e9;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = poly[j * 2] - poly[i * 2], ez = poly[j * 2 + 1] - poly[i * 2 + 1], L = Math.hypot(ex, ez);
    if (L < minL) continue;
    const nx = ez / L, nz = -ex / L, dot = nx * dir[0] + nz * dir[1];
    if (dot < 0.5) continue;
    const s = dot + L / 400;
    if (s > bs) { bs = s; best = { i, L, nx, nz, mx: (poly[i * 2] + poly[j * 2]) / 2, mz: (poly[i * 2 + 1] + poly[j * 2 + 1]) / 2, ex: ex / L, ez: ez / L }; }
  }
  return best;
}
function edgeByIndex(poly, i) {
  const n = poly.length / 2, j = (i + 1) % n;
  const ex = poly[j * 2] - poly[i * 2], ez = poly[j * 2 + 1] - poly[i * 2 + 1], L = Math.hypot(ex, ez) || 1;
  return { i, L, nx: ez / L, nz: -ex / L, mx: (poly[i * 2] + poly[j * 2]) / 2, mz: (poly[i * 2 + 1] + poly[j * 2 + 1]) / 2, ex: ex / L, ez: ez / L };
}
/** 某高度处的体块轮廓（考虑收分 taper：以体块底为 0、顶为 1 线性缩放） */
function polyAt(P, yRel) {
  const t = P.part.taper;
  if (!t || t === 1) return P.pts;
  const c = partCentroid(P), k = 1 - (1 - t) * Math.min(1, Math.max(0, (yRel - P.base) / (P.top - P.base)));
  return G.scaleAbout(P.pts, c.x, c.z, k);
}

/** 水平（屋面）文字：中心 (cx,y,cz)，rot 为文字行进方向（地图角度），字高 h */
function placeFlat(signs, text, cx, y, cz, h, rotDeg, maxW, opts) {
  const e = signs.entry(text, opts);
  if (!e) return;
  let w = h * e.aspect;
  if (maxW && w > maxW) { h *= maxW / w; w = maxW; }
  const [ux, uz] = dirOf(rotDeg), [vx, vz] = dirOf(rotDeg + 90);
  const P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + (ux * w * a + vx * h * b) / 2, y, cz + (uz * w * a + vz * h * b) / 2]);
  const U = [[e.u0, e.v0], [e.u1, e.v0], [e.u1, e.v1], [e.u0, e.v1]];
  for (const k of [0, 1, 2, 0, 2, 3]) { signs.pos.push(...P[k]); signs.uv.push(...U[k]); }
}

/** 沿轮廓的水平带（装饰线条 / 灯带 / 轮廓灯）：y(u) 可随周长 u 波动；返回非索引几何（朝外竖面 + 顶面） */
function ribbon(poly, yFn, hgt, depth, step = 2) {
  const p = G.inset(poly, -depth), n = p.length / 2, pos = [];
  let u = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.05) continue;
    const k = Math.max(1, Math.ceil(L / step));
    const nx = (bz - az) / L, nz = -(bx - ax) / L;
    for (let s = 0; s < k; s++) {
      const t0 = s / k, t1 = (s + 1) / k;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      const y0 = yFn(u + L * t0), y1 = yFn(u + L * t1);
      // 朝外竖面（CCW 轮廓：a→b 右手外法线）
      pos.push(x0, y0, z0, x1, y1 + hgt, z1, x1, y1, z1, x0, y0, z0, x0, y0 + hgt, z0, x1, y1 + hgt, z1);
      // 顶面（向内挑出 depth）
      const ix0 = x0 - nx * depth, iz0 = z0 - nz * depth, ix1 = x1 - nx * depth, iz1 = z1 - nz * depth;
      pos.push(x0, y0 + hgt, z0, ix1, y1 + hgt, iz1, x1, y1 + hgt, z1, x0, y0 + hgt, z0, ix0, y0 + hgt, iz0, ix1, y1 + hgt, iz1);
    }
    u += L;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/** 立面泛光光幕：沿轮廓外 0.6 m 的竖直环带，uv.y 自下(0)而上(1) */
function washShell(poly, y0, y1, off = 0.6) {
  const p = G.inset(poly, -off), n = p.length / 2, pos = [], uv = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = [p[i * 2], p[i * 2 + 1]], b = [p[j * 2], p[j * 2 + 1]];
    pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y0, a[1], b[0], y1, b[1], a[0], y1, a[1]);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
/** 旋转体（飞碟圆盘等）：profile = [[r, y], …] 自下而上 */
function lathe(cx, y0, cz, profile, seg = 48) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y)), seg);
  g.translate(cx, y0, cz);
  return g;
}
/** 沿 a→b 的细杆（方截面） */
function beam(ax, ay, az, bx, by, bz, w) {
  const L = Math.hypot(bx - ax, by - ay, bz - az);
  const g = new THREE.BoxGeometry(w, L, w);
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

// ═════════════════════════ 塔冠 ═════════════════════════
const VOLUME_CROWNS = new Set(['parapet', 'lantern', 'glassCylinder', 'disk', 'frame', 'pyramid', 'hip']);

/**
 * 坡屋顶（hip 塔冠）：中心 (cx,cz)、长 w（沿 rot 方向）、宽 d，檐口高 y0（绝对）。返回屋顶高（檐口到正脊）。
 * o: {h 矢高（默认 0.3·宽）, eave 挑檐（默认 1.5 m）, ridge 正脊长占屋面长的比例（默认四坡等坡 (W−D)/W；取大些近似歇山，
 *     1 = 两坡硬山）, top:[长, 宽] 平顶四坡（盝顶 / 行政楼“大挑檐帽”，给了就不做正脊）, eaveH 檐口厚（默认 0.8）,
 *     mat 屋面（默认 roofTile 深灰瓦）, eaveMat 檐口（默认 dark）, ridgeH 正脊高（默认 0.6，0 不建）}
 */
function hipRoof(env, cx, cz, w, d, rot, y0, o = {}) {
  const ov = o.eave ?? 1.5, W = w + ov * 2, Dd = d + ov * 2;
  const rh = o.h ?? Dd * 0.3;
  const half = Math.max(0, Math.min(W / 2, o.ridge != null ? (o.ridge * W) / 2 : (W - Dd) / 2));
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (u, v, y) => [cx + u * c - v * s, y, cz + u * s + v * c];
  const a = P(-W / 2, -Dd / 2, y0), b = P(W / 2, -Dd / 2, y0), cc = P(W / 2, Dd / 2, y0), dd = P(-W / 2, Dd / 2, y0);
  let pos;
  if (o.top) {
    // 平顶四坡（“盝顶”/大挑檐帽）：顶面 top:[长, 宽]，四个梯形坡面 + 平顶
    const tw = Math.min(o.top[0], W) / 2, td = Math.min(o.top[1] ?? o.top[0], Dd) / 2, yt = y0 + rh;
    const ta = P(-tw, -td, yt), tb = P(tw, -td, yt), tc = P(tw, td, yt), tdd = P(-tw, td, yt);
    pos = [...a, ...ta, ...b, ...b, ...ta, ...tb, ...b, ...tb, ...cc, ...cc, ...tb, ...tc, ...cc, ...tc, ...dd, ...dd, ...tc, ...tdd,
      ...dd, ...tdd, ...a, ...a, ...tdd, ...ta, ...ta, ...tdd, ...tb, ...tb, ...tdd, ...tc];
  } else {
    const r1 = P(-half, 0, y0 + rh), r2 = P(half, 0, y0 + rh);
    pos = [...a, ...r1, ...b, ...b, ...r1, ...r2, ...b, ...r2, ...cc, ...cc, ...r2, ...dd, ...dd, ...r2, ...r1, ...dd, ...r1, ...a];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // 统一法线朝上（坐标系手性与 rot 无关）
  const pa = g.attributes.position.array, na = g.attributes.normal.array;
  for (let i = 0; i < pa.length; i += 9) if (na[i + 1] < 0) for (let k = 0; k < 3; k++) { const t = pa[i + 3 + k]; pa[i + 3 + k] = pa[i + 6 + k]; pa[i + 6 + k] = t; }
  g.computeVertexNormals();
  env.solid.add(g, solidMat(env, o.mat || 'roofTile'), null, { worldUV: 1 });
  // 檐口厚度（深色）+ 檐底
  const eh = o.eaveH ?? 0.8;
  const eave = G.rect(cx, cz, W, Dd, rot);
  env.solid.add(G.wallGeometry(eave, eave, y0 - eh, y0), solidMat(env, o.eaveMat || 'dark'));
  env.solid.add(G.capGeometry(eave, y0 - eh, { down: true }), solidMat(env, o.eaveMat || 'dark'));
  // 正脊
  const rH = o.ridgeH ?? 0.6;
  if (!o.top && rH > 0 && half > 0.5) {
    const m = P(0, 0, 0);
    env.detail.add(G.box(m[0], y0 + rh + rH / 2 - 0.1, m[2], half * 2 + 0.6, rH, 0.5, rot), solidMat(env, o.eaveMat || 'dark'));
  }
  return rh;
}
function normCrowns(c) {
  if (!c) return [];
  return [].concat(c).map((x) => (typeof x === 'string' ? { type: x } : x));
}
/**
 * 在体块 P 顶上依次构建塔冠（buildTower 已处理的 lantern/slope/spire/helipad(塔楼体块) 跳过）。
 * 体量类（glassCylinder/disk/frame/pyramid）会把“当前高度游标”抬高，后续塔冠叠在其上；
 * 屋面类（dome/arch/masts/spire/helipad）不抬游标（除非 stack:true）。crown.y（离地米）可显式指定起点。
 */
function buildCrowns(env, R, P, crowns, yTop, handled) {
  const { fb, solid, detail, mats, beacons } = env;
  const g0 = R.ground;
  const c0 = partCentroid(P);
  let y = yTop; // 绝对高程
  for (const cr of crowns) {
    if (handled.has(cr)) continue;
    const yb = cr.y != null ? g0 + cr.y : y;
    const c = cr.at ? { x: cr.at[0], z: cr.at[1] } : offsetPt(c0, cr.offset);
    const topPoly = polyAt(P, yb - g0);
    let yNext = yb;
    switch (cr.type) {
      case 'flat':
        break;
      case 'parapet': {
        const h = cr.h ?? 1.4, tp = G.inset(topPoly, cr.inset ?? 0);
        solid.add(G.wallGeometry(tp, tp, yb, yb + h), solidMat(env, cr.mat || 'parapet'));
        const ti = G.inset(tp, 0.35);
        solid.add(G.wallGeometry(ti, ti, yb + h, yb + 0.1), solidMat(env, cr.mat || 'parapet'));
        solid.add(G.annulus(tp, ti, yb + h), solidMat(env, cr.mat || 'parapet'));
        yNext = yb + h;
        break;
      }
      case 'glassCylinder': {
        const r = cr.r ?? Math.max(2, G.obb(topPoly).d / 2 - (cr.inset ?? 2));
        const poly = G.circle(c.x, c.z, r, cr.seg ?? 40);
        const st = mkStyle(facadeStyle({ pattern: 'curtain', tint: '#355c7d', spd: '#d4dde5', floorH: 3.6, colW: 1.6, spandrel: 0.12, mullW: 0.08, lit: 0.5, ...(cr.style || {}) }));
        fb.prism(poly, yb - 0.5, yb + cr.h, st, { vBase: yb });
        solid.add(G.capGeometry(poly, yb + cr.h - 0.05), mats.dark);
        yNext = yb + cr.h;
        break;
      }
      case 'lantern': { // 非塔楼体块上的发光玻璃塔冠（塔楼体块由 buildTower 的 crown 处理）
        const tp = G.inset(topPoly, cr.inset ?? 0);
        const st = mkStyle({ ...PATTERNS.crownGlass, spd: cr.color || '#ffe2b8', tint: cr.tint || '#3a4f60', floorH: cr.h, seed: 1 });
        fb.ring(tp, tp, yb, yb + cr.h, st, { vLocal: true });
        solid.add(G.capGeometry(G.inset(tp, 0.4), yb + cr.h - 2.5), mats.dark);
        yNext = yb + cr.h;
        break;
      }
      case 'disk': { // 飞碟圆盘 / 薄圆盘屋顶：上下微凸的扁旋转体
        const r = cr.r ?? 12, h = cr.h ?? 2;
        const rim = cr.rimH ?? h * 0.4;
        const prof = cr.profile || [[0, 0], [r * 0.82, h * 0.1], [r, (h - rim) / 2], [r, (h + rim) / 2], [r * 0.82, h * 0.9], [0, h]];
        solid.add(lathe(c.x, yb, c.z, prof, cr.seg ?? 56), solidMat(env, cr.mat || 'white'));
        if (cr.glow) detail.add(G.cyl(c.x, yb + (h - rim) / 2 + rim * 0.25, c.z, r + 0.08, r + 0.08, rim * 0.5, cr.seg ?? 56, true), glowMat(env, cr.glow, { base: '#dfe3e6' }));
        yNext = yb + h;
        break;
      }
      case 'frame': { // 屋顶构架 / 设备屏风：沿轮廓的立柱 + 顶部与中部横梁
        const h = cr.h ?? 5, tp = G.inset(topPoly, cr.inset ?? 0.5), n = tp.length / 2, w = cr.post ?? 0.5, step = cr.step ?? 4;
        const mat = cr.glow ? glowMat(env, cr.glow, { base: cr.color || '#8f969c', night: cr.strength ?? 1.6 }) : solidMat(env, cr.mat || 'metal');
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = tp[i * 2], az = tp[i * 2 + 1], bx = tp[j * 2], bz = tp[j * 2 + 1], L = Math.hypot(bx - ax, bz - az);
          const k = Math.max(1, Math.round(L / step));
          for (let s = 0; s < k; s++) detail.add(G.box(ax + ((bx - ax) * s) / k, yb + h / 2, az + ((bz - az) * s) / k, w, h, w), mat);
          for (const yy of [yb + h - w / 2, yb + h * 0.5]) detail.add(beam(ax, yy, az, bx, yy, bz, w), mat);
        }
        yNext = yb + h;
        break;
      }
      case 'pyramid': { // 玻璃四棱锥（或多棱锥）+ 可选塔尖
        const tp = G.inset(topPoly, cr.inset ?? 1), apex = [c.x, yb + cr.h, c.z], pos = [];
        for (let i = 0; i < tp.length; i += 2) {
          const j = (i + 2) % tp.length;
          pos.push(tp[i], yb, tp[i + 1], tp[j], yb, tp[j + 1], ...apex);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        const na = g.attributes.normal.array, pa = g.attributes.position.array;
        for (let i = 0; i < pa.length; i += 9) if (na[i + 1] < 0) for (let k = 0; k < 3; k++) { const t = pa[i + 3 + k]; pa[i + 3 + k] = pa[i + 6 + k]; pa[i + 6 + k] = t; }
        g.computeVertexNormals();
        solid.add(g, solidMat(env, cr.mat || 'glassRoof'));
        if (cr.spire) {
          detail.add(G.cyl(c.x, apex[1] - 2, c.z, 1.0, 0.2, cr.spire + 2, 8), mats.metal);
          beacons.add(c.x, apex[1] + cr.spire, c.z, 0, 5);
        }
        yNext = yb + cr.h;
        break;
      }
      case 'arch': { // 筒拱（采光中庭 / 拱形屋面）：默认取体块外接矩形，沿长边
        let w, d, rot, cx = c.x, cz = c.z;
        if (cr.size) {
          [w, d] = cr.size;
          rot = -(cr.rot || 0) * D;
        } else {
          const o = G.obb(topPoly);
          ({ w, d, rot } = o); cx = o.cx; cz = o.cz;
          if (cr.along === 'short') { [w, d] = [d, w]; rot += Math.PI / 2; }
        }
        solid.add(vault(cx, cz, w, d, rot, yb, cr.h ?? d * 0.25, cr.seg ?? 16), solidMat(env, cr.mat || 'glassRoof'));
        if (cr.stack) yNext = yb + (cr.h ?? d * 0.25);
        break;
      }
      case 'dome': { // 穹顶：半球按 r / h 缩放；r 可为 [东西半径, 南北半径]
        const [rx, rz] = [].concat(cr.r ?? 10).length > 1 ? cr.r : [cr.r ?? 10, cr.r ?? 10];
        const g = new THREE.SphereGeometry(1, cr.seg ?? 28, 10, 0, TAU, 0, Math.PI / 2);
        g.scale(rx, cr.h ?? Math.min(rx, rz) * 0.5, rz);
        g.translate(c.x, yb, c.z);
        solid.add(g, solidMat(env, cr.mat || 'glassRoof'));
        if (cr.ring !== false) detail.add(G.cyl(c.x, yb - 0.1, c.z, Math.max(rx, rz) + 0.5, Math.max(rx, rz) + 0.5, 0.8, cr.seg ?? 28), mats.parapet);
        if (cr.glow) detail.add(G.cyl(c.x, yb, c.z, Math.max(rx, rz) * 0.96, 0.4, (cr.h ?? Math.min(rx, rz) * 0.5) * 0.9, cr.seg ?? 28), washMat(env, cr.glow, 0.5));
        if (cr.stack) yNext = yb + (cr.h ?? Math.min(rx, rz) * 0.5);
        break;
      }
      case 'masts':
      case 'spire': { // 桅杆 / 避雷针：list 为 [[东,北],…]（相对体块质心），top 为顶端离地米数（数或数组），len 为杆长（与 top 二选一）
        const list = cr.type === 'spire' ? [cr.offset || [0, 0]] : cr.list || [[0, 0]];
        const pick = (v, k) => [].concat(v)[Math.min(k, [].concat(v).length - 1)];
        list.forEach((off, k) => {
          const q = offsetPt(c0, off);
          const tip = cr.top != null ? g0 + pick(cr.top, k) : yb + pick(cr.len ?? cr.h ?? 20, k);
          const r = cr.r ?? 0.6;
          detail.add(G.box(q.x, yb + 0.8, q.z, r * 4, 1.6, r * 4), mats.metal);
          detail.add(G.cyl(q.x, yb, q.z, r, r * 0.3, tip - yb, 8), mats.metal);
          if (cr.beacon !== false) beacons.add(q.x, tip, q.z, 0, cr.beaconSize ?? 5);
        });
        break;
      }
      case 'helipad': { // 停机坪圆盘（非塔楼体块、或叠在圆盘/圆筒之上时）
        const r = cr.r ?? 10, hy = yb + (cr.lift ?? 0.4);
        const disk = new THREE.CircleGeometry(r, 40);
        disk.rotateX(-Math.PI / 2);
        disk.translate(c.x, hy + 0.36, c.z);
        solid.add(disk, mats.heli);
        solid.add(G.cyl(c.x, hy - 0.4, c.z, r + 0.3, r + 0.3, 0.75, 40), mats.white);
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * TAU;
          detail.add(G.box(c.x + Math.cos(a) * r, hy + 0.5, c.z + Math.sin(a) * r, 0.3, 0.3, 0.3), mats.lampWarm);
        }
        if (cr.stack) yNext = hy + 0.4;
        break;
      }
      case 'hip': { // 坡屋顶（公共建筑的仿古大屋顶 / 屋顶亭阁）：四坡（庑殿）或长脊近似歇山，挑檐 + 檐口厚度
        let w, d, rot, cx = c.x, cz = c.z;
        if (cr.size) {
          [w, d] = cr.size;
          rot = -(cr.rot || 0) * D;
        } else {
          const o = G.obb(topPoly);
          ({ w, d, rot } = o); cx = o.cx; cz = o.cz;
          if (cr.along === 'short') { [w, d] = [d, w]; rot += Math.PI / 2; }
        }
        yNext = yb + hipRoof(env, cx, cz, w, d, rot, yb, cr);
        break;
      }
      case 'sphere': { // 整球（球幕影院 / 网壳球体）：r 半径，cy 球心离地高（默认 r，即球底落地），at/offset 定中心
        const r = cr.r ?? 10, cy = g0 + (cr.cy ?? r);
        const g = new THREE.SphereGeometry(r, cr.seg ?? 40, Math.max(12, Math.round((cr.seg ?? 40) / 2)));
        g.translate(c.x, cy, c.z);
        solid.add(g, solidMat(env, cr.mat || 'glassRoof'));
        if (cr.ribs !== false) { // 网壳经线（细杆，远看成三角分格感）
          const n = cr.ribs ?? 16;
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI;
            const ring = new THREE.TorusGeometry(r + 0.05, cr.ribW ?? 0.12, 4, 48);
            ring.rotateY(a);
            ring.translate(c.x, cy, c.z);
            detail.add(ring, solidMat(env, cr.ribMat || '#3c3f42'));
          }
        }
        if (cr.stack) yNext = cy + r;
        break;
      }
      case 'slope':
        break;
      default:
        throw new Error('未知塔冠类型 ' + cr.type);
    }
    if (VOLUME_CROWNS.has(cr.type) || cr.stack) y = yNext;
  }
  return y;
}

// ═════════════════════════ 体块 ═════════════════════════
function buildPart(env, R, P) {
  const { fb, solid } = env;
  const part = P.part, g0 = R.ground;
  const base = g0 + P.base, H = P.top - P.base;
  const kind = part.kind || 'tower';
  const crowns = normCrowns(part.crown);
  const handled = new Set();
  let yTop = base + H;
  if (kind === 'tower') {
    const lantern = crowns.find((c) => c.type === 'lantern');
    const slope = crowns.find((c) => c.type === 'slope');
    // 停机坪直接落在塔楼屋面（前面没有圆筒/圆盘等体量塔冠）时交给 buildTower（带支柱与边灯），否则由本库叠在体量塔冠之上
    const firstVol = crowns.findIndex((c) => VOLUME_CROWNS.has(c.type) && c.type !== 'parapet');
    const heli = crowns.find((c, i) => c.type === 'helipad' && c.y == null && !c.at && !c.offset && (firstVol < 0 || i < firstVol));
    const par = crowns.find((c) => c.type === 'parapet' && c.inset == null && !c.mat);
    for (const c of [lantern, slope, heli, par]) if (c) handled.add(c);
    const spec = {
      pts: P.pts, base, h: H + (lantern ? lantern.h : 0), taper: part.taper,
      style: facadeStyle(part.style, part.seed),
      crown: lantern ? { h: lantern.h, color: lantern.color, colW: lantern.colW, inset: lantern.inset, tint: lantern.tint } : null,
      slope: slope ? { dir: faceDir(slope.dir ?? 'N'), drop: slope.drop } : null,
      roof: {
        mech: part.roof?.mech ?? crowns.every((c) => handled.has(c) || c.type === 'flat'),
        parapet: par ? par.h : part.roof?.parapet,
        helipad: !!heli, helipadY: heli?.lift ?? 2.5,
      },
    };
    if (part.setbacks?.length) {
      // setbacks：[{at: 离地米, inset: 米}] → buildTower 的分段（to 为体块内高度，inset 为相对原轮廓的累计内缩）
      const sb = part.setbacks.filter((s) => s.at > P.base + 1.5 && s.at < P.top).sort((a, b) => a.at - b.at);
      const tiers = [];
      let prev = 0;
      for (const s of sb) { tiers.push({ to: s.at - P.base, inset: prev }); prev = s.inset; }
      tiers.push({ to: H, inset: prev });
      spec.tiers = tiers;
    }
    yTop = buildTower(env, spec).top;
  } else if (kind === 'podium') {
    const st = facadeStyle({ pattern: 'retail', ...(part.style || {}) }, part.seed);
    buildPodium(env, { pts: P.pts, holes: P.holes.length ? P.holes : undefined, h: H, base, style: st, roofMat: part.roofMat ? solidMat(env, part.roofMat) : undefined });
    yTop = base + H; // 塔冠从屋面起算（女儿墙 1.2 m 另计）
  } else if (kind === 'solid') {
    const mat = solidMat(env, part.mat || 'stone');
    const topPts = part.taper && part.taper !== 1 ? polyAt(P, P.top) : P.pts; // 收分（方尖塔、锥形墩柱）
    solid.add(G.wallGeometry(P.pts, topPts, base - 2, base + H), mat, null, { worldUV: 1 });
    solid.add(G.capGeometry(topPts, base + H), mat, null, { worldUV: 1 });
  } else if (kind === 'facade') {
    // 只有立面、没有屋面处理的直筒（被上部体块盖住的中段等）
    fb.prism(P.pts, base - 0.5, base + H, mkStyle(facadeStyle(part.style, part.seed)), { vBase: g0 });
    solid.add(G.capGeometry(P.pts, base + H - 0.05), env.mats.roof);
  } else throw new Error('未知体块 kind ' + kind);
  buildCrowns(env, R, P, crowns, yTop, handled);
}

// ═════════════════════════ 招牌 ═════════════════════════
function buildSigns(env, R) {
  const { signs } = env;
  for (const sg of R.spec.signs || []) {
    const P = findPart(R, sg.part ?? 0);
    const opts = { color: sg.color || '#ffffff', weight: sg.weight ?? 800, serif: !!sg.serif, glow: sg.glow || null, bg: sg.bg || null };
    const h = sg.h ?? 4;
    if (sg.face === 'roof') {
      const c = sg.at ? { x: sg.at[0], z: sg.at[1] } : offsetPt(partCentroid(P), sg.offset);
      placeFlat(signs, sg.text, c.x, R.ground + (sg.y ?? P.top) + 0.35, c.z, h, sg.rot ?? 0, sg.maxW ?? 1e9, opts);
      continue;
    }
    const yRel = sg.y ?? P.top - h * 0.9;
    const poly = polyAt(P, yRel);
    const faces = sg.edge != null ? [].concat(sg.edge) : [].concat(sg.face ?? 'S');
    for (const f of faces) {
      let e = null;
      if (typeof f === 'number' && sg.edge != null) e = edgeByIndex(poly, f);
      else {
        const dir = faceDir(f);
        e = pickEdge(poly, dir, sg.minEdge ?? Math.max(4, h * 2));
        if (!e) {
          // 圆形/曲面：取该方向外缘点，按切平面贴字
          const hit = rayHit(poly, partCentroid(P), dir);
          e = { mx: hit.x, mz: hit.z, nx: dir[0], nz: dir[1], L: hit.width * 0.55 };
        }
      }
      const off = sg.out ?? 0.3, maxW = e.L * (sg.fill ?? 0.8);
      let mx = e.mx, mz = e.mz;
      if ((sg.near || sg.shift) && e.ex != null) {
        // near：沿该边推向某方位的一端（如 near:'NW' 把北立面的字放到西北角）；shift：沿边方向额外平移（米）
        let d = sg.shift || 0;
        if (sg.near) {
          const nd = faceDir(sg.near), ent = signs.entry(sg.text, opts);
          const w = ent ? Math.min(h * ent.aspect, maxW) : maxW;
          d += Math.sign(e.ex * nd[0] + e.ez * nd[1]) * Math.max(0, e.L / 2 - w / 2 - (sg.margin ?? 3));
        }
        mx += e.ex * d; mz += e.ez * d;
      }
      signs.place(sg.text, { x: mx + e.nx * off, y: R.ground + yRel, z: mz + e.nz * off }, e.nx, e.nz, h, maxW, opts);
    }
  }
}
function findPart(R, key) {
  const P = typeof key === 'number' ? R.parts[key] : R.parts.find((p) => p.name === key);
  if (!P) throw new Error(`${R.spec.id}: 找不到体块 ${key}`);
  return P;
}

// ═════════════════════════ 装饰线条 / 夜景 ═════════════════════════
function buildBands(env, R) {
  for (const b of R.spec.bands || []) {
    const P = findPart(R, b.part ?? 0);
    const levels = b.levels || [];
    const mat = b.glow ? glowMat(env, b.glow, { base: b.color || '#c8a060', day: b.glowDay ?? 0, night: b.strength ?? 2.4 }) : solidMat(env, b.color || '#e6e8ea');
    levels.forEach((lv, k) => {
      const amp = b.wave?.amp ?? 0, len = b.wave?.len ?? 60, ph = (b.wave?.phase ?? 1.3) * k;
      const yFn = (u) => R.ground + lv + amp * Math.sin((u / len) * TAU + ph);
      env.detail.add(ribbon(polyAt(P, lv), yFn, b.h ?? 0.3, b.depth ?? 0.25, b.step ?? 2), mat);
    });
  }
}
function buildNight(env, R) {
  const N = R.spec.night;
  if (!N) return;
  for (const o of [].concat(N.outline || [])) {
    // 轮廓灯：体块顶沿（或指定高度）一圈发光线；vertical: 同时勾勒转角竖线
    const P = findPart(R, o.part ?? 0), yRel = o.y ?? P.top, poly = polyAt(P, yRel);
    const mat = glowMat(env, o.color || '#fff2d8', { base: o.base || '#d9d4c8', night: o.strength ?? 2.6 });
    env.detail.add(ribbon(poly, () => R.ground + yRel - (o.w ?? 0.35), o.w ?? 0.35, o.depth ?? 0.2), mat);
    if (o.vertical) {
      const n = poly.length / 2;
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n, c = (i + 1) % n;
        const d1 = [poly[i * 2] - poly[a * 2], poly[i * 2 + 1] - poly[a * 2 + 1]], d2 = [poly[c * 2] - poly[i * 2], poly[c * 2 + 1] - poly[i * 2 + 1]];
        const cos = (d1[0] * d2[0] + d1[1] * d2[1]) / (Math.hypot(...d1) * Math.hypot(...d2) || 1);
        if (cos > 0.85) continue; // 只勾转角
        env.detail.add(G.box(poly[i * 2], R.ground + (P.base + yRel) / 2, poly[i * 2 + 1], o.w ?? 0.35, yRel - P.base, o.w ?? 0.35), mat);
      }
    }
  }
  for (const f of [].concat(N.floodlight || [])) {
    const P = findPart(R, f.part ?? 0);
    const y0 = R.ground + (f.from ?? P.base), y1 = R.ground + (f.to ?? P.top);
    env.detail.add(washShell(P.pts, y0, y1, f.offset ?? 0.6), washMat(env, f.color || '#ffd9a0', f.strength ?? 0.6));
  }
  for (const m of [].concat(N.media || [])) {
    // LED 媒体屏：挂在朝 face 的边上，from/to 离地米，width 米（默认边长 80%）
    const P = findPart(R, m.part ?? 0);
    const poly = polyAt(P, m.from ?? P.base);
    const e = m.edge != null ? edgeByIndex(poly, m.edge) : pickEdge(poly, faceDir(m.face ?? 'S'), 6);
    if (!e) continue;
    const w = Math.min(m.width ?? e.L * 0.8, e.L * 0.95), off = m.out ?? 0.5;
    const cx = e.mx + e.nx * off + e.ex * (m.shift ?? 0), cz = e.mz + e.nz * off + e.ez * (m.shift ?? 0);
    const ax = cx - (e.ex * w) / 2, az = cz - (e.ez * w) / 2, bx = cx + (e.ex * w) / 2, bz = cz + (e.ez * w) / 2;
    env.fb.panel(ax, az, bx, bz, R.ground + m.from, R.ground + m.to, mkStyle({ ...PATTERNS[m.pattern || 'screen'], seed: 3, tint: [0.02, 0.02, 0.02], spd: [0.2, 0.2, 0.2] }));
  }
}

// ═════════════════════════ 入口 ═════════════════════════
/**
 * 构建一栋档案建筑。env 同 skyline：{ctx, fb, solid, detail, mats, signs, beacons}
 * spec 可以是原始 spec，也可以是 resolveSpec 的结果。返回 {ground, top, center, polys}
 */
export function buildDossier(env, spec) {
  const R = spec.parts && spec.spec ? spec : resolveSpec(spec);
  const S = R.spec;
  const all = R.parts.filter((p) => p.base <= 0.5).flatMap((p) => p.pts);
  R.ground = S.ground ?? groundMin(env.ctx, all.length ? all : R.parts[0].pts);
  for (const P of R.parts) buildPart(env, R, P);
  buildSigns(env, R);
  buildBands(env, R);
  buildNight(env, R);
  const top = Math.max(...R.parts.map((p) => p.top));
  if (S.label !== false && env.ctx.labels) {
    const L = typeof S.label === 'object' ? S.label : {};
    env.ctx.labels.add(L.text || S.name, new THREE.Vector3(R.center.x, R.ground + (L.y ?? top + 8), R.center.z), {
      category: 'landmark', priority: L.priority ?? 1 + Math.min(1.5, top / 200), minDist: 100, maxDist: 6000 + top * 40,
    });
  }
  return { ground: R.ground, top: R.ground + top, center: R.center, polys: R.polys };
}

/**
 * 旧定义是否已被逐栋档案替代（dossier 模块 prepare 后可用；供 heritage 等其他模块调用，skyline.js 内有同逻辑的本地副本）：
 *   s.key ∈ supersede.keys；或 s.name / s.n ∈ 档案名称与 supersede.names；
 *   或 s 的质心（pts / outer 轮廓，或 x,z / cx,cz）落在档案建筑的落地轮廓内。
 */
export function isSuperseded(ctx, s) {
  const S = ctx?.superseded;
  if (!S || !s) return false;
  if (s.key && S.keys.has(s.key)) return true;
  const n = s.name ?? s.n;
  if (n && S.names.has(n)) return true;
  const pts = s.pts || s.outer;
  const c = pts?.length >= 6 ? G.centroid(G.ccw(pts)) : s.x != null ? { x: s.x, z: s.z } : s.cx != null ? { x: s.cx, z: s.cz } : null;
  return !!c && S.polys.some((p) => G.pointIn(c.x, c.z, p));
}
