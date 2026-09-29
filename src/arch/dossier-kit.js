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
  // 裸露结构（在建/停工楼：混凝土楼板 + 柱、黑洞洞的内部，夜间不亮灯；同 sky-special buildUnderConstruction）
  openFrame: { mode: 7, floorH: 4.2, colW: 8.5, spandrel: 0.16, mullW: 0.9, lit: 0, tint: '#15181b', spd: '#9c988f' },
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
/** 半平面裁切多边形（Sutherland–Hodgman）：保留 f(x, z) ≥ 0 的一侧 */
function clipHalfPlane(pts, f) {
  const out = [];
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[j * 2], bz = pts[j * 2 + 1];
    const fa = f(ax, az), fb = f(bx, bz);
    if (fa >= 0) out.push(ax, az);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push(ax + (bx - ax) * t, az + (bz - az) * t);
    }
  }
  return out;
}
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
  // cut：沿某方位把轮廓切掉一截（{face:'S', by:7} = 保留离南端 7 m 以北的部分），用于“沿街立面逐层退台”
  for (const c of [].concat(part.cut || [])) {
    const d = faceDir(c.face);
    let m = -Infinity;
    for (let i = 0; i < pts.length; i += 2) m = Math.max(m, pts[i] * d[0] + pts[i + 1] * d[1]);
    pts = G.ccw(clipHalfPlane(pts, (x, z) => m - (c.by || 0) - (x * d[0] + z * d[1])));
    holes = holes.map((h) => clipHalfPlane(G.ccw(h), (x, z) => m - (c.by || 0) - (x * d[0] + z * d[1]))).filter((h) => h.length >= 6);
  }
  if (part.grow) pts = G.inset(pts, -part.grow);
  if (part.roundCorners) pts = roundCorners(pts, part.roundCorners, part.roundSeg ?? 5);
  if (Array.isArray(part.holes)) holes = holes.concat(part.holes);
  // 放样（loft）：topPts 为体块顶面轮廓（世界坐标），与底面同点数、同起点同绕向；立面在两者之间直纹过渡（如逐层变大的切角）
  let topPts = null;
  if (part.topPts) {
    if (part.roundCorners) throw new Error(`part ${part.name || ''}：topPts 不能与 roundCorners 同用`);
    topPts = G.area(part.topPts) >= 0 ? part.topPts.slice() : G.ccw(part.topPts);
    if (part.grow) topPts = G.inset(topPts, -part.grow);
    if (topPts.length !== pts.length) throw new Error(`part ${part.name || ''}：topPts 点数 ${topPts.length / 2} ≠ 底面 ${pts.length / 2}`);
  } else if (part.topInset != null || part.topScale != null || part.topShift) {
    // 放样简写（2026-09 地标补建）：顶面 = 底面按质心缩放 topScale、再内缩 topInset 米、再平移 topShift:[东,北] 米
    // （水晶体温室的斜玻璃面、折板屋面、四坡“盝顶”式收进）；轮廓点数不变，可用于任意多边形（含 fp 轮廓）
    let t = pts;
    if (part.topScale != null) { const c = G.centroid(t); t = G.scaleAbout(t, c.x, c.z, part.topScale); }
    if (part.topInset) t = G.inset(t, part.topInset);
    if (part.topShift) { const [e, n] = part.topShift; t = t.map((v, i) => v + (i % 2 ? -n : e)); }
    topPts = t;
  }
  return { pts, holes, topPts };
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
    const { pts, holes, topPts } = partPolygon(spec, part, center);
    return { part, i, name: part.name ?? String(i), pts, holes, topPts, base: part.base ?? 0, top: part.top };
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
  if (P.topPts) { // 放样体块：底面 → 顶面线性插值
    const k = Math.min(1, Math.max(0, (yRel - P.base) / (P.top - P.base)));
    return P.pts.map((v, i) => v + (P.topPts[i] - v) * k);
  }
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

/** 三角形列表（每 9 个数一个三角形）→ 几何；零面积三角形丢弃，法线统一朝上（up=true）、背离参考点 ref、或与水平方向 dir=[dx,dz] 同向 */
function triGeom(pos, { up = true, ref = null, dir = null } = {}) {
  const out = [];
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const e1 = [pos[i + 3] - ax, pos[i + 4] - ay, pos[i + 5] - az], e2 = [pos[i + 6] - ax, pos[i + 7] - ay, pos[i + 8] - az];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.hypot(...n) < 1e-6) continue;
    let flip;
    if (ref) {
      const m = [(ax + pos[i + 3] + pos[i + 6]) / 3 - ref[0], (ay + pos[i + 4] + pos[i + 7]) / 3 - ref[1], (az + pos[i + 5] + pos[i + 8]) / 3 - ref[2]];
      flip = n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0;
    } else if (dir) flip = n[0] * dir[0] + n[2] * dir[1] < 0;
    else flip = up && n[1] < 0;
    if (flip) out.push(ax, ay, az, pos[i + 6], pos[i + 7], pos[i + 8], pos[i + 3], pos[i + 4], pos[i + 5]);
    else for (let k = 0; k < 9; k++) out.push(pos[i + k]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}
/**
 * 四坡顶 / 庑殿顶 / 盝顶（截顶四坡）：局部矩形 W×D（W 沿 u），中心 (cx,cz)，rot 为 G 约定（弧度，= −地图角）；
 * y0 檐口（坡面起点）高程，rise 坡高，ridge 正脊长（默认 W−D：四面等坡），flat∈(0,1) 截顶比例（盝顶，顶部平台）。
 */
function hipGeom(cx, cz, W, D, rot, y0, rise, ridge, flat) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (u, v, y) => [cx + u * c - v * s, y, cz + u * s + v * c];
  const hw = W / 2, hd = D / 2, r = Math.min(hw, Math.max(0, ridge / 2));
  const t = flat > 0 && flat < 1 ? flat : 1;
  const iu = hw - t * (hw - r), iv = hd * (1 - t), yt = y0 + rise * t;
  const O = [P(-hw, -hd, y0), P(hw, -hd, y0), P(hw, hd, y0), P(-hw, hd, y0)];
  const I = [P(-iu, -iv, yt), P(iu, -iv, yt), P(iu, iv, yt), P(-iu, iv, yt)];
  const pos = [];
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    pos.push(...O[k], ...O[j], ...I[j], ...O[k], ...I[j], ...I[k]);
  }
  if (t < 1) pos.push(...I[0], ...I[1], ...I[2], ...I[0], ...I[2], ...I[3]);
  return triGeom(pos);
}
// ═════════════════════════ 中式坡屋顶（hip / eave / slab 塔冠用） ═════════════════════════
/** 屋顶平面框：cr.size + at/offset + rot（地图角度），或默认取体块顶面最小外接矩形 → {cx, cz, w（长）, d（短）, rot（世界弧度）} */
function roofFrame(cr, topPoly, c) {
  if (cr.size) {
    const [w, d = w] = cr.size;
    return { cx: c.x, cz: c.z, w, d, rot: -(cr.rot || 0) * D };
  }
  const o = G.obb(topPoly);
  if (cr.along === 'short') return { cx: o.cx, cz: o.cz, w: o.d, d: o.w, rot: o.rot + Math.PI / 2 };
  return o;
}
/**
 * 中式大屋顶几何（直坡面，檐角可起翘）：局部 u 沿长边（半长 A）、v 沿短边（半宽 B），檐口高 y0、屋脊高 y0+h。
 * style：'wudian' 庑殿（四坡，戗脊 45°）| 'xieshan' 歇山（下部四坡、上部两坡 + 竖直山花）| 'zanjian' 攒尖（四坡交于一点）。
 * 返回 {roof, gable, ridge:[u0,u1]}（非索引几何；gable 为山花三角，可能为 null）
 */
function hipGeometry(F, A, B, y0, h, style, lift, xk) {
  const c = Math.cos(F.rot), s = Math.sin(F.rot);
  const W = (u, v, y) => [F.cx + u * c - v * s, y, F.cz + u * s + v * c];
  let Gu, hg; // 山花（或正脊端点）位置与高度
  if (style === 'zanjian') { Gu = 0; hg = h; }
  else if (style === 'xieshan') { hg = h * (xk ?? 0.45); Gu = Math.max(0.3, A - B * (hg / h)); }
  else { Gu = Math.max(0, A - B); hg = h; }
  const vg = B * (1 - hg / h);
  const roof = [], gable = [];
  const tri = (out, p, q, r, up) => {
    // 三角形朝向：up=[nx,ny,nz] 期望的大致法线方向
    const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const L = Math.hypot(...n);
    if (L < 1e-6) return;
    if (n[0] * up[0] + n[1] * up[1] + n[2] * up[2] < 0) out.push(...p, ...r, ...q);
    else out.push(...p, ...q, ...r);
  };
  // 一个坡面：檐口边从 (ua,va) 到 (ub,vb)（端点为檐角，起翘 lift），上缘为 T0→T1（可重合），外法线水平分量 dir
  const slope = (ea, eb, T0, T1, dirU, dirV) => {
    const up = [dirU * c - dirV * s, 1.2, dirU * s + dirV * c];
    const P = [0, 0.2, 0.8, 1].map((t) => {
      const u = ea[0] + (eb[0] - ea[0]) * t, v = ea[1] + (eb[1] - ea[1]) * t;
      return W(u, v, y0 + (t === 0 || t === 1 ? lift : 0));
    });
    const t0 = W(T0[0], T0[1], y0 + T0[2]), t1 = W(T1[0], T1[1], y0 + T1[2]);
    tri(roof, P[0], P[1], t0, up);
    tri(roof, P[1], P[2], t0, up);
    tri(roof, P[2], t1, t0, up);
    tri(roof, P[2], P[3], t1, up);
  };
  // 两个长坡（±v）：檐口 → 戗脊/山花 → 正脊
  for (const sv of [1, -1]) {
    slope([-A, sv * B], [A, sv * B], [-Gu, sv * vg, hg], [Gu, sv * vg, hg], 0, sv);
    if (hg < h - 1e-3) { // 歇山：上部两坡（山花斜边与正脊之间）
      const a = W(-Gu, sv * vg, y0 + hg), b = W(Gu, sv * vg, y0 + hg), r1 = W(-Gu, 0, y0 + h), r2 = W(Gu, 0, y0 + h);
      const upv = [-s * sv, 1.2, c * sv];
      tri(roof, a, b, r2, upv);
      tri(roof, a, r2, r1, upv);
    }
  }
  // 两个端坡（±u）
  for (const su of [1, -1]) {
    slope([su * A, -B], [su * A, B], [su * Gu, -vg, hg], [su * Gu, vg, hg], su, 0);
    if (hg < h - 1e-3) tri(gable, W(su * Gu, -vg, y0 + hg), W(su * Gu, vg, y0 + hg), W(su * Gu, 0, y0 + h), [su * c, 0, su * s]);
  }
  const mk = (pos) => {
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  };
  return { roof: mk(roof), gable: mk(gable), ridge: [-Gu, Gu], W };
}

/**
 * 唐风庑殿（四坡）大屋顶几何：屋面“举折”微凹（檐部平缓、近脊陡）、翼角起翘；四个坡面各自成网格，戗脊（四条斜脊）处精确闭合。
 * P(u, v, y) → 世界坐标 [x, y, z]；u 沿长边（半长 A）、v 沿短边（半宽 B），均已含出檐；rh 正脊半长（0 = 攒尖）；
 * y0 檐口高（绝对）、h 檐口到正脊的高；curve 凹曲指数（0 = 平直坡面）；lift 翼角起翘（米）。
 * 返回 {roof 屋面（含檐口封边与檐底）, ridges 正脊/戗脊/鸱吻, eave 檐口轮廓（世界坐标扁平数组，供夜景灯带）}
 */
function tangGeometry(P, A, B, rh, y0, h, curve, lift, { nt = 18, ns = 8, sMax = 1 } = {}) {
  // sMax < 1：盝顶（只做檐口一圈宽 sMax×B 的坡面，h 为这圈坡面的高，中间为平屋面）
  const f = (s) => Math.pow(Math.max(0, Math.min(1, s / sMax)), 1 + curve);
  const Lc = Math.min(A, B) * 0.5;
  const liftAt = (u, v) => {
    const d = Math.hypot(A - Math.abs(u), B - Math.abs(v));
    return lift * Math.max(0, 1 - d / Lc) ** 2;
  };
  const H = (u, v, s) => y0 + h * f(s) + liftAt(u, v);
  const pos = [];
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  // 四个坡面：face(t, s) → [u, v]
  const faces = [
    (t, s) => { const e = A - s * (A - rh); return [-e + 2 * e * t, -B + s * B]; },
    (t, s) => { const e = A - s * (A - rh); return [e - 2 * e * t, B - s * B]; },
    (t, s) => { const e = B - s * B; return [A - s * (A - rh), -e + 2 * e * t]; },
    (t, s) => { const e = B - s * B; return [-(A - s * (A - rh)), e - 2 * e * t]; },
  ];
  for (const F of faces) {
    const n = F === faces[0] || F === faces[1] ? nt : Math.max(4, Math.round((nt * B) / A));
    for (let j = 0; j < ns; j++) {
      const s0 = (sMax * j) / ns, s1 = (sMax * (j + 1)) / ns;
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const pt = (t, s) => { const [u, v] = F(t, s); return P(u, v, H(u, v, s)); };
        quad(pt(t0, s0), pt(t1, s0), pt(t1, s1), pt(t0, s1));
      }
    }
  }
  // 檐口封边（0.5 m 厚的竖向檐板，随翼角起翘）与檐底
  const rim = [[-A, -B], [A, -B], [A, B], [-A, B]];
  const eave = [];
  for (let k = 0; k < 4; k++) {
    const [ua, va] = rim[k], [ub, vb] = rim[(k + 1) % 4];
    const m = 12;
    for (let i = 0; i < m; i++) {
      const u0 = ua + ((ub - ua) * i) / m, v0 = va + ((vb - va) * i) / m, u1 = ua + ((ub - ua) * (i + 1)) / m, v1 = va + ((vb - va) * (i + 1)) / m;
      quad(P(u0, v0, y0 - 0.5), P(u1, v1, y0 - 0.5), P(u1, v1, H(u1, v1, 0)), P(u0, v0, H(u0, v0, 0)));
      const w = P(u0, v0, 0);
      eave.push(w[0], w[2]);
    }
  }
  const [a, b, c, d] = rim.map(([u, v]) => P(u, v, y0 - 0.5));
  quad(a, d, c, b);
  if (sMax < 0.999) { // 盝顶中间的平屋面
    const eu = A - sMax * (A - rh), evv = B - sMax * B;
    quad(P(-eu, -evv, y0 + h), P(eu, -evv, y0 + h), P(eu, evv, y0 + h), P(-eu, evv, y0 + h));
  }
  const roof = new THREE.BufferGeometry();
  roof.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // 统一绕序：屋面朝上、檐板朝外、檐底朝下
  const p = roof.attributes.position.array;
  const [ox, , oz] = P(0, 0, y0);
  for (let i = 0; i < p.length; i += 9) {
    const e1 = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]], e2 = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const mx = (p[i] + p[i + 3] + p[i + 6]) / 3 - ox, my = (p[i + 1] + p[i + 4] + p[i + 7]) / 3, mz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3 - oz;
    const soffit = Math.abs(my - (y0 - 0.5)) < 0.01 && Math.abs(p[i + 1] - p[i + 4]) < 0.01 && Math.abs(p[i + 1] - p[i + 7]) < 0.01;
    const want = soffit ? ny < 0 : Math.abs(ny) > 1e-6 && Math.hypot(nx, nz) < Math.abs(ny) * 4 ? ny > 0 : nx * mx + nz * mz > 0;
    if (!want) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
  }
  roof.computeVertexNormals();
  // 正脊、戗脊、鸱吻
  const rg = [];
  const top = y0 + h;
  if (rh > 0.5 && sMax >= 0.999) {
    const [x0, , z0] = P(-rh, 0, 0), [x1, , z1] = P(rh, 0, 0);
    rg.push(beam(x0, top + 0.35, z0, x1, top + 0.35, z1, 0.9));
    for (const sgn of [-1, 1]) {
      const [x, , z] = P(sgn * rh, 0, 0);
      rg.push(G.box(x, top + 1.3, z, 1.0, 2.2, 1.0));
    }
  }
  for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const K = 6;
    for (let k = 0; k < K; k++) {
      const s0 = (sMax * k) / K, s1 = (sMax * (k + 1)) / K;
      const q = (s) => { const u = su * (A - s * (A - rh)), v = sv * (B - s * B); return P(u, v, H(u, v, s) + 0.25); };
      const A0 = q(s0), A1 = q(s1);
      rg.push(beam(A0[0], A0[1], A0[2], A1[0], A1[1], A1[2], 0.55));
    }
  }
  return { roof, ridges: rg, eave };
}

// ═════════════════════════ 塔冠 ═════════════════════════
const VOLUME_CROWNS = new Set(['parapet', 'lantern', 'glassCylinder', 'disk', 'frame', 'pyramid', 'hip', 'cnhip', 'slab', 'tangRoof', 'pubHip']);

/**
 * 坡屋顶（hip 塔冠）：中心 (cx,cz)、长 w（沿 rot 方向）、宽 d，檐口高 y0（绝对）。返回屋顶高（檐口到正脊）。
 * o: {h 矢高（默认 0.3·宽）, eave 挑檐（默认 1.5 m）, ridge 正脊长占屋面长的比例（默认四坡等坡 (W−D)/W；取大些近似歇山，
 *     1 = 两坡硬山）, top:[长, 宽] 平顶四坡（盝顶 / 行政楼“大挑檐帽”，给了就不做正脊）, topMat 平顶材质（默认同 mat）, eaveH 檐口厚（默认 0.8）,
 *     mat 屋面（默认 roofTile 深灰瓦）, eaveMat 檐口（默认 dark）, ridgeH 正脊高（默认 0.6，0 不建）}
 */
function hipRoof(env, cx, cz, w, d, rot, y0, o = {}) {
  const ov = o.eave ?? 1.5, W = w + ov * 2, Dd = d + ov * 2;
  const rh = o.h ?? Dd * 0.3;
  const half = Math.max(0, Math.min(W / 2, o.ridge != null ? (o.ridge * W) / 2 : (W - Dd) / 2));
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (u, v, y) => [cx + u * c - v * s, y, cz + u * s + v * c];
  const a = P(-W / 2, -Dd / 2, y0), b = P(W / 2, -Dd / 2, y0), cc = P(W / 2, Dd / 2, y0), dd = P(-W / 2, Dd / 2, y0);
  let pos, topPos = null;
  if (o.top) {
    // 平顶四坡（“盝顶”/大挑檐帽）：顶面 top:[长, 宽]，四个梯形坡面 + 平顶（平顶可用 topMat 单独给材质，如只有一圈琉璃挑檐的平屋面）
    const tw = Math.min(o.top[0], W) / 2, td = Math.min(o.top[1] ?? o.top[0], Dd) / 2, yt = y0 + rh;
    const ta = P(-tw, -td, yt), tb = P(tw, -td, yt), tc = P(tw, td, yt), tdd = P(-tw, td, yt);
    pos = [...a, ...ta, ...b, ...b, ...ta, ...tb, ...b, ...tb, ...cc, ...cc, ...tb, ...tc, ...cc, ...tc, ...dd, ...dd, ...tc, ...tdd,
      ...dd, ...tdd, ...a, ...a, ...tdd, ...ta];
    topPos = [...ta, ...tdd, ...tb, ...tb, ...tdd, ...tc];
  } else {
    const r1 = P(-half, 0, y0 + rh), r2 = P(half, 0, y0 + rh);
    pos = [...a, ...r1, ...b, ...b, ...r1, ...r2, ...b, ...r2, ...cc, ...cc, ...r2, ...dd, ...dd, ...r2, ...r1, ...dd, ...r1, ...a];
  }
  const upGeo = (arr) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    // 统一法线朝上（坐标系手性与 rot 无关）
    const pa = g.attributes.position.array, na = g.attributes.normal.array;
    for (let i = 0; i < pa.length; i += 9) if (na[i + 1] < 0) for (let k = 0; k < 3; k++) { const t = pa[i + 3 + k]; pa[i + 3 + k] = pa[i + 6 + k]; pa[i + 6 + k] = t; }
    g.computeVertexNormals();
    return g;
  };
  env.solid.add(upGeo(pos), solidMat(env, o.mat || 'roofTile'), null, { worldUV: 1 });
  if (topPos) env.solid.add(upGeo(topPos), solidMat(env, o.topMat || o.mat || 'roofTile'), null, { worldUV: 1 });
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
 * 屋面类（dome/arch/masts/spire/helipad/hip/sawtooth/crane）不抬游标（除非 stack:true）。crown.y（离地米）可显式指定起点。
 * hip：四坡顶/庑殿/盝顶 + 出檐；sawtooth：锯齿天窗；crane：在建塔吊（2026-09 城北档案新增，见 docs/DOSSIER_KIT.md §3.6）。
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
      case 'tangRoof': { // 唐风庑殿大屋顶（可重檐、可盝顶）：默认取体块外接矩形；size:[长,宽]+at/offset+rot 可显式指定（不含出檐）
        let w, d, ang, cx = c.x, cz = c.z;
        if (cr.size) {
          [w, d] = cr.size;
          ang = -(cr.rot || 0) * D;
        } else {
          const o = G.obb(topPoly);
          ({ w, d } = o); ang = o.rot; cx = o.cx; cz = o.cz;
        }
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const P = (u, v, yy) => [cx + u * cs - v * sn, yy, cz + u * sn + v * cs];
        const ev = cr.eave ?? 2.5, A = w / 2 + ev, B = d / 2 + ev;
        const h = cr.h ?? B * 0.55;
        const rh = cr.ridge != null ? Math.max(0, cr.ridge * A) : Math.max(0, A - B);
        const y0 = yb + (cr.base ?? 1.0); // 檐口默认比屋面高 1 m：盖住女儿墙，不让墙顶穿出屋面
        const mat = solidMat(env, cr.mat || 'roofTile');
        const ridgeMat = solidMat(env, cr.ridgeMat || 'dark');
        // band：盝顶——只有檐口一圈宽 band 米的坡面（高 h），中间平屋面
        const sMax = cr.band ? Math.min(1, cr.band / B) : 1;
        const R0 = tangGeometry(P, A, B, rh, y0, h, cr.curve ?? 0.45, cr.lift ?? Math.min(2.2, h * 0.12), { sMax });
        solid.add(R0.roof, mat, null, { worldUV: 1 });
        for (const g of R0.ridges) detail.add(g, ridgeMat);
        if (cr.glow) detail.add(ribbon(G.ccw(R0.eave), () => y0 - 0.5, 0.35, 0.08), glowMat(env, cr.glow, { base: '#6b5a3c', night: cr.strength ?? 2.4 }));
        if (cr.double) { // 重檐：主屋面下 gap 米处一圈外挑 out 米、坡高 h 的下檐
          const dd = cr.double, gap = dd.gap ?? 4, out = dd.out ?? ev + 2, hh = dd.h ?? 2.2;
          const A2 = w / 2, B2 = d / 2, yT = y0 - gap, yE = yT - hh;
          const pos = [];
          const q = (a, b, cc, e) => pos.push(...a, ...b, ...cc, ...a, ...cc, ...e);
          const inner = [[-A2, -B2], [A2, -B2], [A2, B2], [-A2, B2]], outer = [[-A2 - out, -B2 - out], [A2 + out, -B2 - out], [A2 + out, B2 + out], [-A2 - out, B2 + out]];
          for (let k = 0; k < 4; k++) {
            const j = (k + 1) % 4;
            q(P(...outer[k], yE), P(...outer[j], yE), P(...inner[j], yT), P(...inner[k], yT));
            q(P(...outer[k], yE - 0.45), P(...outer[j], yE - 0.45), P(...outer[j], yE), P(...outer[k], yE));
          }
          const sk = new THREE.BufferGeometry();
          sk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          const p = sk.attributes.position.array;
          for (let i = 0; i < p.length; i += 9) {
            const e1 = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]], e2 = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
            const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
            const mx = (p[i] + p[i + 3] + p[i + 6]) / 3 - cx, mz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3 - cz;
            const ok = Math.abs(ny) > Math.hypot(nx, nz) * 0.2 ? ny > 0 : nx * mx + nz * mz > 0;
            if (!ok) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
          }
          sk.computeVertexNormals();
          solid.add(sk, mat, null, { worldUV: 1 });
          const ob = outer.flatMap(([u, v]) => { const r = P(u, v, 0); return [r[0], r[2]]; });
          solid.add(G.capGeometry(G.ccw(ob), yE - 0.45, { down: true }), ridgeMat);
          if (cr.glow) detail.add(ribbon(G.ccw(ob), () => yE - 0.45, 0.3, 0.08), glowMat(env, cr.glow, { base: '#6b5a3c', night: cr.strength ?? 2.4 }));
        }
        yNext = y0 + h;
        break;
      }
      case 'dome': { // 穹顶：半球按 r / h 缩放；r 可为 [东西半径, 南北半径]；full:true 为整球（底部落在 yb，h 为整球高）
        const [rx, rz] = [].concat(cr.r ?? 10).length > 1 ? cr.r : [cr.r ?? 10, cr.r ?? 10];
        const g = new THREE.SphereGeometry(1, cr.seg ?? 28, cr.full ? 20 : 10, 0, TAU, 0, cr.full ? Math.PI : Math.PI / 2);
        if (cr.full) { // full:true 整球（底部落在 yb，h 为整球高）
          const hh = (cr.h ?? 2 * Math.min(rx, rz)) / 2;
          g.scale(rx, hh, rz);
          if (cr.rot) g.rotateY(cr.rot * D);
          g.translate(c.x, yb + hh, c.z);
        } else {
          g.scale(rx, cr.h ?? Math.min(rx, rz) * 0.5, rz);
          if (cr.rot) g.rotateY(cr.rot * D); // rot：rx 轴的地图方位角（度，北 = 90），椭圆穹顶/梭形天窗顺建筑走向
          g.translate(c.x, yb, c.z);
        }
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
      case 'hip': { // 四坡顶/庑殿顶/盝顶 + 出檐：size:[长,宽]+at/offset+rot，或默认取体块顶部轮廓的最小外接矩形
        let w, d, rot, cx = c.x, cz = c.z;
        if (cr.size) {
          [w, d] = cr.size;
          rot = -(cr.rot || 0) * D;
        } else {
          const o = G.obb(topPoly);
          ({ w, d, rot } = o); cx = o.cx; cz = o.cz;
        }
        if (d > w && cr.ridge == null) { [w, d] = [d, w]; rot += Math.PI / 2; }
        const ov = cr.over ?? 2, W = w + 2 * ov, Dd = d + 2 * ov;
        const eave = cr.eave ?? 0.8, rise = cr.h ?? Dd * 0.2;
        const ridge = cr.ridge ?? Math.max(0, W - Dd);
        const y0 = yb + (cr.lift ?? 0); // 檐口底
        const mat = solidMat(env, cr.mat || { color: '#62686d', metalness: 0.55, roughness: 0.45 });
        const eaveMat = solidMat(env, cr.eaveMat || cr.mat || { color: '#62686d', metalness: 0.55, roughness: 0.45 });
        const rect = G.rect(cx, cz, W, Dd, rot);
        if (eave > 0) {
          solid.add(G.wallGeometry(rect, rect, y0, y0 + eave), eaveMat);
          solid.add(G.capGeometry(rect, y0, { down: true }), cr.soffit ? solidMat(env, cr.soffit) : eaveMat);
        }
        solid.add(hipGeom(cx, cz, W, Dd, rot, y0 + eave, rise, ridge, cr.flat), mat);
        if (cr.glow) detail.add(ribbon(rect, () => y0 + eave * 0.2, cr.glowH ?? 0.3, 0.06), glowMat(env, cr.glow, { base: cr.glowBase || '#d9d4c8', night: cr.strength ?? 2.4 }));
        yNext = y0 + eave + rise * (cr.flat > 0 && cr.flat < 1 ? cr.flat : 1);
        break;
      }
      case 'sawtooth': { // 锯齿形天窗屋面（老厂房）：沿长边 n 个齿，竖直采光面朝 face 方位（默认北）
        let w, d, rot, cx = c.x, cz = c.z;
        if (cr.size) {
          [w, d] = cr.size;
          rot = -(cr.rot || 0) * D;
        } else {
          const o = G.obb(topPoly);
          ({ w, d, rot } = o); cx = o.cx; cz = o.cz;
        }
        const cs = Math.cos(rot), sn = Math.sin(rot);
        const P = (u, v, yy) => [cx + u * cs - v * sn, yy, cz + u * sn + v * cs];
        // 采光面朝向：局部 +u 对应的世界方向与 face 同向则不翻转
        const fd = faceDir(cr.face ?? 'N'), sgn = cs * fd[0] + sn * fd[1] >= 0 ? 1 : -1;
        const n = Math.max(1, cr.n ?? Math.round(w / 12)), h = cr.h ?? 4, step = w / n, pos = [], glass = [];
        for (let k = 0; k < n; k++) {
          const u0 = sgn * (-w / 2 + k * step), u1 = sgn * (-w / 2 + (k + 1) * step);
          const A = P(u0, -d / 2, yb), B = P(u0, d / 2, yb), C = P(u1, -d / 2, yb + h), Dp = P(u1, d / 2, yb + h);
          const C0 = P(u1, -d / 2, yb), D0 = P(u1, d / 2, yb);
          pos.push(...A, ...C, ...Dp, ...A, ...Dp, ...B); // 背坡
          pos.push(...A, ...C0, ...C, ...B, ...Dp, ...D0); // 两端三角山墙
          glass.push(...C0, ...D0, ...Dp, ...C0, ...Dp, ...C); // 竖直采光面
        }
        const ref = [cx, yb - 50, cz];
        solid.add(triGeom(pos, { ref }), solidMat(env, cr.mat || { color: '#8e8a84', roughness: 0.85 }));
        solid.add(triGeom(glass, { dir: [sgn * cs, sgn * sn] }), solidMat(env, cr.glass || { color: '#5b6f7c', metalness: 0.6, roughness: 0.2, glow: cr.glow || null }));
        yNext = yb + h;
        break;
      }
      case 'crane': { // 塔吊（在建）：塔身从 from（离地米，默认 0）到 top，吊臂朝 rot（地图角），长 jib，配重臂 counter
        const q = cr.at ? { x: cr.at[0], z: cr.at[1] } : offsetPt(c0, cr.offset);
        const top = g0 + (cr.top ?? (yb - g0) + (cr.h ?? 30)), bot = g0 + (cr.from ?? 0); // h：高出体块顶（高新 spec 用法）
        const [ux, uz] = dirOf(cr.rot ?? 0), jib = cr.jib ?? 55, cnt = cr.counter ?? 16;
        const ry = -(cr.rot ?? 0) * D;
        detail.add(G.box(q.x, (bot + top) / 2, q.z, 2.0, top - bot, 2.0), mats.yellow);
        detail.add(G.box(q.x + (ux * jib) / 2, top + 1, q.z + (uz * jib) / 2, jib, 1.6, 1.4, ry), mats.yellow);
        detail.add(G.box(q.x - (ux * cnt) / 2, top + 1, q.z - (uz * cnt) / 2, cnt, 1.4, 2.2, ry), mats.yellow);
        detail.add(G.box(q.x - ux * (cnt - 3), top - 0.5, q.z - uz * (cnt - 3), 5, 3, 3, ry), mats.roof);
        detail.add(G.box(q.x, top + 5, q.z, 1.0, 9, 1.0), mats.yellow);
        if (cr.beacon !== false) {
          beacons.add(q.x, top + 10, q.z, 0, 4);
          beacons.add(q.x + ux * (jib - 3), top + 2, q.z + uz * (jib - 3), 1, 2.5);
        }
        break;
      }
      case 'cnhip': { // 中式大屋顶（庑殿/歇山/攒尖）：出檐 ov、矢高 h、檐角起翘 lift；默认取体块顶面外接矩形
        const F = roofFrame(cr, topPoly, c);
        const ov = cr.ov ?? 1.2, A = F.w / 2 + ov, B = F.d / 2 + ov;
        const style = cr.style || (Math.abs(F.w - F.d) < 0.5 ? 'zanjian' : 'wudian');
        const h = cr.h ?? Math.max(2, B * 0.55);
        const lift = cr.lift ?? Math.min(1.2, h * 0.12);
        const fh = cr.fascia ?? 0.6; // 檐口（封檐板）厚度
        const y0 = yb + fh; // 坡面檐口
        const R = hipGeometry(F, A, B, y0, h, style, lift, cr.xk);
        const roofMat = cr.mat ? solidMat(env, cr.mat) : mats.roofTile;
        solid.add(R.roof, roofMat);
        if (R.gable) solid.add(R.gable, cr.gableMat ? solidMat(env, cr.gableMat) : roofMat);
        // 檐口封檐板（檐角随起翘抬高）+ 檐下（朝下）
        const eaveMat = solidMat(env, cr.eaveMat || '#3e3833');
        const ring = [[-A, -B], [A, -B], [A, B], [-A, B]].flatMap(([u, v]) => { const p = R.W(u, v, 0); return [p[0], p[2]]; });
        const er = G.ccw(ring);
        const liftY = () => y0 + lift;
        solid.add(G.wallGeometry(er, er, yb, liftY), eaveMat);
        solid.add(G.capGeometry(er, yb, { down: true }), eaveMat);
        // 正脊（攒尖为宝顶）
        const ridgeMat = cr.ridgeMat ? solidMat(env, cr.ridgeMat) : mats.dark;
        const [ua, ub] = R.ridge, rh = cr.ridgeH ?? Math.min(1.0, h * 0.12);
        if (ub - ua > 0.5) {
          const a = R.W(ua, 0, y0 + h), b = R.W(ub, 0, y0 + h);
          detail.add(beam(a[0], a[1] + rh * 0.3, a[2], b[0], b[1] + rh * 0.3, b[2], rh), ridgeMat);
          if (cr.chiwei !== false) for (const p of [a, b]) detail.add(G.box(p[0], p[1] + rh * 1.1, p[2], rh * 1.4, rh * 2.2, rh * 1.4, F.rot), ridgeMat); // 鸱吻（简化）
        } else {
          const a = R.W(0, 0, y0 + h);
          detail.add(G.cyl(a[0], a[1] - 0.2, a[2], rh * 0.9, rh * 0.3, rh * 2.6, 8), cr.finialMat ? solidMat(env, cr.finialMat) : ridgeMat); // 宝顶
        }
        yNext = y0 + h;
        break;
      }
      case 'eave': { // 腰檐 / 披檐（重檐的下檐、裙房檐口）：沿体块轮廓外挑 ov、向内 depth 的一圈斜坡屋面（可用 y 放在墙身任意高度）
        const ov = cr.ov ?? 1.8, depth = cr.depth ?? 2.5, h = cr.h ?? 1.6, fh = cr.fascia ?? 0.5;
        const out = G.inset(topPoly, -ov), inn = G.inset(topPoly, depth);
        const roofMat = cr.mat ? solidMat(env, cr.mat) : mats.roofTile;
        solid.add(G.wallGeometry(out, inn, yb + fh, yb + fh + h), roofMat);
        const eaveMat = solidMat(env, cr.eaveMat || '#3e3833');
        solid.add(G.wallGeometry(out, out, yb, yb + fh), eaveMat);
        solid.add(G.capGeometry(out, yb, { down: true }), eaveMat);
        if (cr.stack) yNext = yb + fh + h;
        break;
      }
      case 'slab': { // 挑檐平板（大出挑薄屋檐、亭式平顶）：轮廓外扩 ov、厚 h
        const p = G.inset(topPoly, -(cr.ov ?? 1.5)), h = cr.h ?? 0.8;
        const m = cr.mat ? solidMat(env, cr.mat) : mats.stone;
        solid.add(G.wallGeometry(p, p, yb, yb + h), m);
        solid.add(G.capGeometry(p, yb + h), m);
        solid.add(G.capGeometry(p, yb, { down: true }), m);
        if (cr.glow) detail.add(G.wallGeometry(G.inset(p, -0.05), G.inset(p, -0.05), yb + h * 0.2, yb + h * 0.8), glowMat(env, cr.glow, { base: cr.glowBase || '#d9d4c8', night: cr.strength ?? 2.4 }));
        yNext = yb + h;
        break;
      }
      case 'pubHip': { // 坡屋顶（公共建筑的仿古大屋顶 / 屋顶亭阁 / 行政楼大挑檐帽）：四坡（庑殿）或长脊近似歇山，挑檐 + 檐口厚度
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
        if (EXT_CROWNS[cr.type]) { yNext = EXT_CROWNS[cr.type](env, R, P, cr, yb, c, topPoly); break; }
        throw new Error('未知塔冠类型 ' + cr.type);
    }
    if (VOLUME_CROWNS.has(cr.type) || cr.stack) y = yNext;
  }
  return y;
}

// ═════════════════════════ 扩展塔冠（2026-09 东西两翼：flyEave 挑檐 / wudian 庑殿顶 / saddleRoof 体育场罩棚 / luffCrane 塔吊；名称特意与其他片区扩展区分，避免合并后同名异义） ═════════════════════════
/** 多边形逐边细分：每边按参考多边形 ref 同一边的长度分 k 段（两个同构多边形细分后顶点一一对应）。返回 [x, z, 边内参数 t, 边长 L] × N */
function subdivide(poly, ref, step) {
  const n = poly.length / 2, out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const L = Math.hypot(ref[j * 2] - ref[i * 2], ref[j * 2 + 1] - ref[i * 2 + 1]);
    const k = Math.max(1, Math.ceil(L / step));
    for (let s = 0; s < k; s++) {
      const t = s / k;
      out.push(poly[i * 2] + (poly[j * 2] - poly[i * 2]) * t, poly[i * 2 + 1] + (poly[j * 2 + 1] - poly[i * 2 + 1]) * t, t, L);
    }
  }
  return out;
}
/** 非索引三角形 → 几何；orient: 'up' 全部朝上、'down' 全部朝下、'both' 双面（竖向封边等朝向不定的面） */
function triGeomO(pos, orient = null) {
  let p = pos;
  if (orient === 'both') {
    p = pos.slice();
    for (let i = 0; i < pos.length; i += 9) p.push(...pos.slice(i, i + 3), ...pos.slice(i + 6, i + 9), ...pos.slice(i + 3, i + 6));
  } else if (orient) {
    p = pos.slice();
    for (let i = 0; i < p.length; i += 9) {
      const ax = p[i + 3] - p[i], az = p[i + 5] - p[i + 2], bx = p[i + 6] - p[i], bz = p[i + 8] - p[i + 2];
      const ny = az * bx - ax * bz; // (b−a)×(c−a) 的 y 分量
      if ((orient === 'up' && ny < 0) || (orient === 'down' && ny > 0)) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}
const EXT_CROWNS = {
  /**
   * flyEave 挑檐板：沿体块顶轮廓外挑 out 米、厚 h 米的檐板，转角起翘 lift 米（丝路会议中心“上月牙”、唐风挑檐）。
   * 参数：out、h、lift、span（起翘范围占边长比例，默认 0.35）、step（细分步长）、mat（檐面）、under（檐底）、glow（夜间檐口线灯色）
   */
  flyEave(env, R, P, cr, yb, c, topPoly) {
    const out = cr.out ?? 4, h = cr.h ?? 1.2, lift = cr.lift ?? 0, span = cr.span ?? 0.35, step = cr.step ?? 4;
    const O = G.inset(topPoly, -out), I = G.inset(topPoly, 0.3);
    const so = subdivide(O, O, step), si = subdivide(I, O, step);
    const up = (t, L) => {
      if (!lift) return 0;
      const s = Math.min(t, 1 - t) * L, w = Math.max(1e-3, L * span);
      return s >= w ? 0 : lift * (1 - s / w) ** 2;
    };
    const oP = [], iP = [], lf = [];
    for (let k = 0; k < so.length; k += 4) { oP.push(so[k], so[k + 1]); iP.push(si[k], si[k + 1]); lf.push(up(so[k + 2], so[k + 3])); }
    const n = oP.length / 2, top = [], bot = [], fas = [];
    const V = (p, k, y) => [p[k * 2], y, p[k * 2 + 1]];
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const o1 = V(oP, k, yb + h + lf[k]), o2 = V(oP, j, yb + h + lf[j]);
      const i1 = V(iP, k, yb + h + lf[k] * 0.4), i2 = V(iP, j, yb + h + lf[j] * 0.4);
      top.push(...o1, ...i2, ...o2, ...o1, ...i1, ...i2);
      const b1 = V(oP, k, yb + lf[k] * 0.85), b2 = V(oP, j, yb + lf[j] * 0.85), c1 = V(iP, k, yb), c2 = V(iP, j, yb);
      bot.push(...b1, ...b2, ...c2, ...b1, ...c2, ...c1);
      fas.push(...b1, ...o2, ...b2, ...b1, ...o1, ...o2);
    }
    const mat = solidMat(env, cr.mat || 'white');
    env.solid.add(triGeomO(top, 'up'), mat);
    env.solid.add(triGeomO(bot, 'down'), solidMat(env, cr.under || cr.mat || 'white'));
    const fm = cr.glow ? glowMat(env, cr.glow, { base: typeof cr.mat === 'string' && cr.mat[0] === '#' ? cr.mat : '#e6e6e2', night: cr.strength ?? 1.6 }) : mat;
    env.solid.add(triGeomO(fas, 'both'), fm);
    return yb + h;
  },
  /**
   * wudian 庑殿顶（四坡、正脊、举折曲面、翼角起翘）：默认取体块顶轮廓外接矩形；也可 size:[长,宽] + at/offset + rot 显式给。
   * 参数：h（正脊高出檐口）、out（出檐）、ridge（正脊长 / 长边；默认 (长−宽)/长 即 45° 戗脊；0 = 攒尖）、lift（翼角起翘）、
   *       curve（举折指数，>1 越近正脊越陡，默认 1.5）、mat（屋面，默认深灰金属）、ridgeMat（正脊/鸱尾）、fascia（檐口封板高）、chiwei:false 不要鸱尾
   */
  wudian(env, R, P, cr, yb, c, topPoly) {
    let w, d, rot, cx, cz;
    if (cr.size) {
      [w, d] = cr.size; rot = cr.rot || 0; cx = c.x; cz = c.z;
    } else {
      const o = G.obb(topPoly);
      w = o.w; d = o.d; cx = o.cx; cz = o.cz; rot = (-o.rot) / D; // G.obb 的 rot：+x 转向 +z 为正 → 地图角取负
      if (d > w) { [w, d] = [d, w]; rot += 90; }
    }
    const out = cr.out ?? 3, L = w + 2 * out, W = d + 2 * out, H = cr.h ?? W * 0.3, lift = cr.lift ?? 0, curve = cr.curve ?? 1.5;
    const r = Math.max(0, Math.min(L / 2 - 0.5, cr.ridge != null ? (cr.ridge * L) / 2 : (L - W) / 2));
    const T = local2world(cx, cz, rot);
    const K = cr.seg ?? 8, J = cr.rows ?? 6;
    const eave = []; // [u, w, 起翘]
    const cn = [[-L / 2, -W / 2], [L / 2, -W / 2], [L / 2, W / 2], [-L / 2, W / 2]];
    for (let e = 0; e < 4; e++) {
      const a = cn[e], b = cn[(e + 1) % 4];
      for (let s = 0; s < K; s++) {
        const t = s / K;
        eave.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, lift * (Math.abs(t - 0.5) * 2) ** 3]);
      }
    }
    const ridgeU = (u) => Math.max(-r, Math.min(r, u)); // 檐口点 → 正脊上的对应点（短边都汇到正脊端点）
    const P3 = (u, v, y) => { const [x, z] = T(u, v); return [x, y, z]; };
    const n = eave.length, pos = [];
    const q = (e, t) => P3(e[0] + (ridgeU(e[0]) - e[0]) * t, e[1] * (1 - t), yb + e[2] * (1 - t) ** 2 + H * t ** curve);
    for (let k = 0; k < n; k++) {
      const e1 = eave[k], e2 = eave[(k + 1) % n];
      for (let j = 0; j < J; j++) {
        const a = q(e1, j / J), b = q(e2, j / J), cc = q(e2, (j + 1) / J), dd = q(e1, (j + 1) / J);
        pos.push(...a, ...b, ...cc, ...a, ...cc, ...dd);
      }
    }
    const roofMat = solidMat(env, cr.mat || { color: '#4b5058', roughness: 0.75, metalness: 0.25 });
    env.solid.add(triGeomO(pos, 'up'), roofMat);
    // 檐底 + 檐口封板（封板随翼角起翘）
    const fh = cr.fascia ?? 0.8, und = [], fas = [];
    for (let k = 0; k < n; k++) {
      const e1 = eave[k], e2 = eave[(k + 1) % n];
      const a = P3(e1[0], e1[1], yb + e1[2]), b = P3(e2[0], e2[1], yb + e2[2]);
      const a0 = P3(e1[0], e1[1], yb + e1[2] - fh), b0 = P3(e2[0], e2[1], yb + e2[2] - fh), o = P3(0, 0, yb - fh);
      fas.push(...a0, ...b0, ...b, ...a0, ...b, ...a);
      und.push(...a0, ...b0, ...o);
    }
    env.solid.add(triGeomO(fas, 'both'), roofMat);
    env.solid.add(triGeomO(und, 'down'), roofMat);
    // 正脊 + 鸱尾
    const rm = solidMat(env, cr.ridgeMat || { color: '#3a3e44', roughness: 0.7, metalness: 0.3 });
    if (r > 0.5) {
      const [ax, az] = T(-r, 0), [bx, bz] = T(r, 0);
      env.solid.add(beam(ax, yb + H + 0.4, az, bx, yb + H + 0.4, bz, cr.ridgeW ?? 1.4), rm);
      if (cr.chiwei !== false) for (const s of [-1, 1]) { const [x, z] = T(s * r, 0); env.detail.add(G.box(x, yb + H + 1.8, z, 1.8, 3.6, 1.8, rot * D), rm); }
    }
    return yb + H;
  },
  /**
   * saddleRoof 体育场罩棚：外缘沿体块轮廓（grow 外扩），内缘为椭圆开口；内缘高度随方位做马鞍起伏，剖面为帐篷曲面（外缘平缓、近内缘陡）。
   * 参数：y（外缘离地）、open:{size:[长,宽], rot（长轴地图角）, at 或 offset}、rim（内缘平均离地）、amp（马鞍半幅）、axis（高点方位角，度）、
   *       grow、h（厚度）、power（剖面指数，默认 1.8）、n（周向分段）、rings、mat（上表面）、under（下表面）
   */
  saddleRoof(env, R, P, cr, yb, c) {
    const g0 = R.ground, op = cr.open || {};
    const oc = op.at ? { x: op.at[0], z: op.at[1] } : offsetPt(partCentroid(P), op.offset);
    const [ea, eb] = op.size || [60, 90];
    const T = local2world(oc.x, oc.z, op.rot || 0);
    const poly = G.inset(P.pts, -(cr.grow ?? 0));
    const n = cr.n ?? 120, J = cr.rings ?? 10, th = cr.h ?? 1.5, pw = cr.power ?? 1.8;
    const yo = g0 + (cr.y ?? P.top), rim = g0 + (cr.rim ?? (cr.y ?? P.top) + 15), amp = cr.amp ?? 0, ax = (cr.axis ?? 0) * D;
    const rows = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      const [ix, iz] = T((ea / 2) * Math.cos(a), (eb / 2) * Math.sin(a));
      const dx = ix - oc.x, dz = iz - oc.z, dl = Math.hypot(dx, dz) || 1;
      const hit = rayHit(poly, oc, [dx / dl, dz / dl]);
      const phi = Math.atan2(-dz, dx); // 地图方位角
      const yi = rim + amp * Math.cos(2 * (phi - ax));
      const row = [];
      for (let j = 0; j <= J; j++) {
        const t = j / J; // 0 内缘 → 1 外缘
        row.push([ix + (hit.x - ix) * t, yo + (yi - yo) * (1 - t) ** pw, iz + (hit.z - iz) * t]);
      }
      rows.push(row);
    }
    const top = [], bot = [], edge = [];
    const dn = (p) => [p[0], p[1] - th, p[2]];
    for (let k = 0; k < n; k++) {
      const A = rows[k], B = rows[(k + 1) % n];
      for (let j = 0; j < J; j++) {
        const a = A[j], b = B[j], cc = B[j + 1], dd = A[j + 1];
        top.push(...a, ...b, ...cc, ...a, ...cc, ...dd);
        bot.push(...dn(a), ...dn(b), ...dn(cc), ...dn(a), ...dn(cc), ...dn(dd));
      }
      for (const j of [0, J]) {
        const a = A[j], b = B[j];
        edge.push(...a, ...dn(b), ...b, ...a, ...dn(a), ...dn(b));
      }
    }
    env.solid.add(triGeomO(top, 'up'), solidMat(env, cr.mat || { color: '#eceae4', roughness: 0.5, metalness: 0.2 }));
    env.solid.add(triGeomO(bot, 'down'), solidMat(env, cr.under || { color: '#d8d6d0', roughness: 0.6 }));
    env.solid.add(triGeomO(edge, 'both'), solidMat(env, cr.mat || { color: '#eceae4', roughness: 0.5, metalness: 0.2 }));
    return Math.max(yo, rim + amp);
  },
  /**
   * luffCrane 塔吊：at/offset 定位；top（塔身顶离地）、jib（起重臂长）、back（平衡臂长）、rot（起重臂方向，地图角度）、
   *   luff（动臂仰角，度；0 = 水平臂平头塔吊，超高层核心筒上的动臂塔吊常为 50–75°）；塔身从塔冠基准（或 y）起
   */
  luffCrane(env, R, P, cr, yb, c) {
    const { detail, mats, beacons } = env;
    const top = R.ground + (cr.top ?? yb - R.ground + 30), m = cr.mast ?? 2, jib = cr.jib ?? 55, back = cr.back ?? 18;
    const [ux, uz] = dirOf(cr.rot ?? 0), lf = (cr.luff ?? 0) * D;
    const jx = c.x + ux * jib * Math.cos(lf), jz = c.z + uz * jib * Math.cos(lf), jy = top + 1 + jib * Math.sin(lf);
    detail.add(G.box(c.x, (yb + top) / 2, c.z, m, top - yb, m), mats.yellow);
    detail.add(beam(c.x, top + 1, c.z, jx, jy, jz, 1.2), mats.yellow);
    detail.add(beam(c.x - ux * back, top + 1, c.z - uz * back, c.x, top + 1, c.z, 1.4), mats.yellow);
    detail.add(G.box(c.x - ux * (back - 3), top - 0.6, c.z - uz * (back - 3), 5, 3, 5), mats.roof);
    if (!lf) detail.add(G.box(c.x, top + 5, c.z, 1, 9, 1), mats.yellow);
    if (cr.beacon !== false) { beacons.add(c.x, lf ? top + 3 : top + 10, c.z, 0, 4); beacons.add(jx, jy + 1, jz, 1, 2.5); }
    return yb;
  },
};

// ═════════════════════════ 列柱（columns：立面前的独立柱 / 树状柱 / 郁金香柱） ═════════════════════════
/**
 * spec.columns: [{ part, step（柱距，米）, r（柱半径）, rTop（柱顶半径，>r 即郁金香/喇叭口柱）, from/to（离地米，默认体块底/顶）,
 *                 out（离体块轮廓外扩米，负数内缩）, seg, mat, at:[[x,z],…]（直接给柱位，替代沿轮廓布置）, margin（离转角距离） }]
 */
function buildColumns(env, R) {
  for (const cl of R.spec.columns || []) {
    const P = findPart(R, cl.part ?? 0);
    const y0 = R.ground + (cl.from ?? P.base), y1 = R.ground + (cl.to ?? P.top);
    const r = cl.r ?? 0.4, rt = cl.rTop ?? r, seg = cl.seg ?? 10, mat = solidMat(env, cl.mat || 'white');
    let pts = [];
    if (cl.at) pts = cl.at;
    else {
      const poly = G.inset(P.pts, -(cl.out ?? 1.5)), n = poly.length / 2, step = cl.step ?? 6, mg = cl.margin ?? 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1], L = Math.hypot(bx - ax, bz - az);
        const usable = L - 2 * mg;
        if (usable < step * 0.5) continue;
        const k = Math.max(1, Math.round(usable / step));
        for (let s = 0; s <= k; s++) {
          if (s === k && mg === 0) continue; // 转角柱只放一次
          const t = (mg + (usable * s) / k) / L;
          pts.push([ax + (bx - ax) * t, az + (bz - az) * t]);
        }
      }
    }
    for (const [x, z] of pts) env.solid.add(G.cyl(x, y0, z, r, rt, y1 - y0, seg), mat);
  }
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
  if (kind === 'tower' && P.topPts) {
    yTop = buildLoft(env, R, P, crowns);
  } else if (kind === 'tower') {
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
        // 中式坡屋顶（cnhip）直接压在屋面上时女儿墙压低到 0.2 m；公建坡屋顶（pubHip）默认几乎不做女儿墙（否则会从挑檐坡面下穿出来）
        parapet: par ? par.h : part.roof?.parapet ?? (crowns.some((c) => c.type === 'cnhip' && c.y == null) ? 0.2 : crowns.some((c) => c.type === 'pubHip') ? 0.05 : undefined),
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
    // 落地实体向下多挤 2 m 埋进地形；悬空实体（挑檐板、连廊等，base > 0.5）不下挤，并补底面；taper 收分（方尖塔、锥形墩柱）
    const sink = part.sink ?? (P.base <= 0.5 ? 2 : 0);
    // topPts（放样）：实体也可从底面直纹过渡到顶面轮廓——折板屋面 / 棱锥形玻璃体 / 斜面实墙（顶面可收成细长“脊”多边形）
    const topPts = P.topPts ? P.topPts : part.taper && part.taper !== 1 ? polyAt(P, P.top) : P.pts;
    solid.add(G.wallGeometry(P.pts, topPts, base - sink, base + H), mat, null, { worldUV: 1 });
    solid.add(G.capGeometry(topPts, base + H), mat, null, { worldUV: 1 });
    if (!sink) solid.add(G.capGeometry(P.pts, base, { down: true }), mat, null, { worldUV: 1 });
  } else if (kind === 'facade') {
    // 只有立面、没有屋面处理的直筒（被上部体块盖住的中段等）；有 topPts 时为放样直纹面
    fb.ring(P.pts, P.topPts || P.pts, base - 0.5, base + H, mkStyle(facadeStyle(part.style, part.seed)), { vBase: g0 });
    solid.add(G.capGeometry(P.topPts || P.pts, base + H - 0.05), env.mats.roof);
  } else if (kind === 'lattice') {
    buildLattice(env, P, base, base + H);
  } else throw new Error('未知体块 kind ' + kind);
  buildCrowns(env, R, P, crowns, yTop, handled);
}

/**
 * 放样塔楼（part.topPts）：底面 → 顶面直纹立面 + 女儿墙 + 屋面（+ 屋顶设备、四角障碍灯）。
 * 用于逐层变大的切角（绿地中心）、收分不等比的塔身等；塔冠（lantern / parapet / frame …）接在顶面轮廓上。
 */
function buildLoft(env, R, P, crowns) {
  const { fb, solid, detail, mats, beacons } = env;
  const part = P.part, g0 = R.ground, y0 = g0 + P.base, y1 = g0 + P.top;
  const bot = P.pts, top = P.topPts;
  fb.ring(bot, top, P.base <= 0.5 ? y0 - 3 : y0, y1, mkStyle(facadeStyle(part.style, part.seed)), { vBase: g0 });
  const par = part.roof?.parapet ?? 1.2, ti = G.inset(top, 0.35);
  solid.add(G.wallGeometry(top, top, y1, y1 + par), mats.parapet);
  solid.add(G.wallGeometry(ti, ti, y1 + par, y1 + 0.1), mats.parapet);
  solid.add(G.annulus(top, ti, y1 + par), mats.parapet);
  solid.add(G.capGeometry(ti, y1 + 0.1), mats.roof);
  const c = G.centroid(top), bb = G.bbox(top), mw = Math.min(bb.x1 - bb.x0, bb.z1 - bb.z0) * 0.4;
  if (part.roof?.mech ?? crowns.every((cr) => cr.type === 'flat')) detail.add(G.box(c.x, y1 + 2.6, c.z, mw, 5.2, mw * 0.8), mats.roof, null, { worldUV: 1 });
  if (P.top > 60) {
    // 顶面最远的几个角点（彼此分散）挂障碍灯
    const cand = [];
    for (let i = 0; i < top.length; i += 2) cand.push([top[i], top[i + 1]]);
    cand.sort((a, b) => Math.hypot(b[0] - c.x, b[1] - c.z) - Math.hypot(a[0] - c.x, a[1] - c.z));
    const pick = [];
    for (const p of cand) if (pick.length < 4 && pick.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > mw)) pick.push(p);
    for (const [x, z] of pick) beacons.add(x, y1 + par + 0.6, z, 0, P.top > 150 ? 5 : 3.5);
  }
  return y1;
}

/**
 * 斜交网格钢构（kind:'lattice'，如迈科中心连桥下的古铜色“门洞”桁架）：沿轮廓各边生成菱形斜杆 + 上下环梁 + 转角立柱。
 * part.lattice：{ step 斜杆水平间距（默认 8 m）、rise 每格高度（默认 = step）、w 杆宽（0.6）、open:[边下标…] 不做的边、rings 每格加横杆 }
 * 材质 part.mat（默认 metal）。
 */
function buildLattice(env, P, y0, y1) {
  const L = P.part.lattice || {}, poly = P.pts, n = poly.length / 2;
  const step = L.step ?? 8, rise = L.rise ?? step, w = L.w ?? 0.6, skip = new Set(L.open || []);
  const mat = solidMat(env, P.part.mat || 'metal');
  const rows = Math.max(1, Math.round((y1 - y0) / rise)), hh = (y1 - y0) / rows;
  for (let i = 0; i < n; i++) {
    if (skip.has(i)) continue;
    const j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1], len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) continue;
    const k = Math.max(1, Math.round(len / step));
    const X = (t) => ax + (bx - ax) * t, Z = (t) => az + (bz - az) * t;
    for (let r = 0; r < rows; r++) {
      const ya = y0 + r * hh, yb = ya + hh;
      for (let s = 0; s < k; s++) {
        const t0 = s / k, t1 = (s + 1) / k;
        env.detail.add(beam(X(t0), ya, Z(t0), X(t1), yb, Z(t1), w), mat);
        env.detail.add(beam(X(t1), ya, Z(t1), X(t0), yb, Z(t0), w), mat);
      }
      if (L.rings && r > 0) env.detail.add(beam(ax, ya, az, bx, ya, bz, w * 0.8), mat);
    }
    for (const yy of [y0 + w / 2, y1 - w / 2]) env.detail.add(beam(ax, yy, az, bx, yy, bz, w * 1.2), mat);
    env.detail.add(G.box(ax, (y0 + y1) / 2, az, w * 1.6, y1 - y0, w * 1.6), mat);
  }
}

// ═════════════════════════ 招牌 ═════════════════════════
function buildSigns(env, R) {
  const { signs } = env;
  for (const sg of R.spec.signs || []) {
    const opts = { color: sg.color || '#ffffff', weight: sg.weight ?? 800, serif: !!sg.serif, glow: sg.glow || null, bg: sg.bg || null };
    if (sg.vertical) opts.vertical = true; // 竖排字（h 为字列总高）
    const h = sg.h ?? 4;
    if (sg.part === null && sg.at && sg.face !== 'roof') {
      // 不挂体块的独立字牌（挂在别的模块/旧模型的墙面上、落地字等）：at 世界坐标、face 朝向、y 离地（本栋地面）
      const [nx, nz] = faceDir(sg.face ?? 'S');
      signs.place(sg.text, { x: sg.at[0] + nx * (sg.out ?? 0.3), y: R.ground + (sg.y ?? h), z: sg.at[1] + nz * (sg.out ?? 0.3) }, nx, nz, h, sg.maxW ?? 1e9, opts);
      continue;
    }
    const P = findPart(R, sg.part ?? 0);
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
  for (const b of [].concat(N.beams || [])) {
    // 竖向光束（楼顶上照灯）：at 世界坐标点列 [[x,z]…]，或 offsets 相对体块质心 [[东,北]…]，缺省取 from 高度处轮廓的角点（转角 > 25°）；
    // from 光束起点离地（默认体块顶）、len 长度（默认 120 m）、w 宽（默认 2.5 m）、color、strength。两片交叉竖直面片，自下而上渐隐，仅夜间
    const P = findPart(R, b.part ?? 0), yRel = b.from ?? P.top, poly = polyAt(P, yRel);
    let spots = b.at;
    if (!spots && b.offsets) { const c = partCentroid(P); spots = b.offsets.map((o) => { const q = offsetPt(c, o); return [q.x, q.z]; }); }
    if (!spots) {
      spots = [];
      const n = poly.length / 2;
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n, c = (i + 1) % n;
        const d1 = [poly[i * 2] - poly[a * 2], poly[i * 2 + 1] - poly[a * 2 + 1]], d2 = [poly[c * 2] - poly[i * 2], poly[c * 2 + 1] - poly[i * 2 + 1]];
        const cos = (d1[0] * d2[0] + d1[1] * d2[1]) / (Math.hypot(...d1) * Math.hypot(...d2) || 1);
        if (cos < 0.9) spots.push([poly[i * 2], poly[i * 2 + 1]]);
      }
    }
    const y0 = R.ground + yRel, y1 = y0 + (b.len ?? 120), hw = (b.w ?? 2.5) / 2, pos = [], uv = [];
    for (const [x, z] of spots) {
      for (const [ux, uz] of [[1, 0], [0, 1]]) {
        const ax = x - ux * hw, az = z - uz * hw, bx = x + ux * hw, bz = z + uz * hw;
        pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
        uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      }
    }
    if (!pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    env.detail.add(g, washMat(env, b.color || '#dfe8ff', b.strength ?? 0.5));
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
    env.fb.panel(ax, az, bx, bz, R.ground + m.from, R.ground + m.to, mkStyle({ ...PATTERNS[m.pattern || 'screen'], seed: 3, tint: m.tint ?? [0.02, 0.02, 0.02], spd: m.spd ?? [0.2, 0.2, 0.2], ...(m.style || {}) }));
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
  buildColumns(env, R);
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
