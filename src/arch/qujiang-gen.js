// 曲江模块专用工具：OSM 足迹 → 唐风建筑、湖面投影倒影、湖面遮罩、水幕灯光秀。
// 只被 src/modules/qujiang.js 使用。
import * as THREE from 'three';
import { hall, pavilion, corridor, multiStoreyTower } from './chinese.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ───────────── buildings.bin 读取（v1/v2） ─────────────
export function readBuildings(buf) {
  if (!buf) return null;
  if (buf.buffer && !(buf instanceof ArrayBuffer)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(buf);
  const ver = dv.getUint32(4, true), n = dv.getUint32(8, true), tv = dv.getUint32(12, true);
  let o = 16;
  const ax = new Float32Array(buf, o, n); o += 4 * n;
  const az = new Float32Array(buf, o, n); o += 4 * n;
  const vs = new Uint32Array(buf, o, n); o += 4 * n;
  const vc = new Uint16Array(buf, o, n); o += 2 * n;
  const hd = new Uint16Array(buf, o, n); o += 2 * n;
  o += 2 * n; // minHeight
  o += n; // kind
  o += n; // flags
  if (ver >= 2) o += n; // style
  o = (o + 3) & ~3;
  const offs = new Int16Array(buf, o, tv * 2);
  return {
    n, ax, az, hd,
    poly(i) {
      const pts = [];
      for (let k = 0; k < vc[i]; k++) pts.push([ax[i] + offs[(vs[i] + k) * 2] / 10, az[i] + offs[(vs[i] + k) * 2 + 1] / 10]);
      return pts;
    },
  };
}

// ───────────── 平面几何 ─────────────
export function signedArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i], r = p[(i + 1) % p.length];
    a += q[0] * r[1] - r[0] * q[1];
  }
  return a / 2;
}
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** 最小面积外接矩形：{cx, cz, w（长边）, d, ux, uz（长边方向）, fill} */
export function obb(pts) {
  const h = hull(pts);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const q of h) {
      const u = q[0] * ux + q[1] * uz, v = -q[0] * uz + q[1] * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const ar = (u1 - u0) * (v1 - v0);
    if (!best || ar < best.ar) {
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      best = { ar, cx: um * ux - vm * uz, cz: um * uz + vm * ux, w: u1 - u0, d: v1 - v0, ux, uz };
    }
  }
  if (!best) return null;
  if (best.d > best.w) { const t = best.w; best.w = best.d; best.d = t; const ux = best.ux; best.ux = -best.uz; best.uz = ux; }
  best.fill = Math.abs(signedArea(pts)) / Math.max(1, best.ar);
  return best;
}
/** 环形 Douglas-Peucker 简化 */
export function simplifyRing(p, tol) {
  if (p.length <= 4) return p;
  const dp = (pts) => {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let md = 0, mi = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md < tol) return [a, b];
    return dp(pts.slice(0, mi + 1)).slice(0, -1).concat(dp(pts.slice(mi)));
  };
  let far = 0, fi = 0;
  for (let i = 1; i < p.length; i++) { const d = Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1]); if (d > far) { far = d; fi = i; } }
  const a = dp(p.slice(0, fi + 1)), b = dp(p.slice(fi).concat([p[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}
function resampleChain(ch, N) {
  const cum = [0];
  for (let i = 1; i < ch.length; i++) cum.push(cum[i - 1] + Math.hypot(ch[i][0] - ch[i - 1][0], ch[i][1] - ch[i - 1][1]));
  const T = cum[cum.length - 1], out = [];
  let j = 0;
  for (let k = 0; k < N; k++) {
    const s = (T * k) / (N - 1);
    while (j < ch.length - 2 && cum[j + 1] < s) j++;
    const t = clamp((s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]), 0, 1);
    out.push([ch[j][0] + (ch[j + 1][0] - ch[j][0]) * t, ch[j][1] + (ch[j + 1][1] - ch[j][1]) * t]);
  }
  return out;
}
/** 细长多边形（廊）→ 中心线 + 平均宽度 */
export function centerline(p) {
  let far = 0, fi = 0, fj = 0;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
    const d = Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]);
    if (d > far) { far = d; fi = i; fj = j; }
  }
  const A = p.slice(fi, fj + 1), B = p.slice(fj).concat(p.slice(0, fi + 1)).reverse();
  const N = Math.max(3, Math.round(far / 7) + 1);
  const ra = resampleChain(A, N), rb = resampleChain(B, N);
  let wsum = 0;
  const line = ra.map((q, k) => { wsum += Math.hypot(q[0] - rb[k][0], q[1] - rb[k][1]); return [(q[0] + rb[k][0]) / 2, (q[1] + rb[k][1]) / 2]; });
  return { line, width: wsum / N, length: far };
}

// ───────────── 足迹 → 唐风建筑（写入共享 ArchBuilder） ─────────────
function oddBays(span, target) {
  let n = Math.max(1, Math.round(span / target));
  if (n % 2 === 0) n += span / n > target ? 1 : -1;
  return Math.max(1, Math.min(11, n));
}
/** 在 builder 当前变换下（原点=建筑中心地面，+Z=正面）按包围矩形建一栋唐风建筑 */
export function tangRect(b, w, d, h, o = {}) {
  const spanW = Math.max(2.6, w * 0.8), spanD = Math.max(2.6, d * 0.74);
  const lights = o.eaveLights ?? { color: 0xffc56a };
  if (spanW < 8 && spanD < 8 && spanW / spanD < 1.45) {
    const sq = spanW / spanD < 1.15;
    return pavilion(b, { style: 'tang', sides: 4, w: spanW, d: spanD, size: Math.max(spanW, spanD), colH: clamp(h * 0.34, 2.8, 4.0), roof: sq ? 'zanjian' : 'xieshan', eaves: h > 10 ? 2 : 1, roofColor: 'darkgray', platformH: 0.45, eaveLights: lights, lanterns: o.lanterns });
  }
  const bays = oddBays(spanW, 4.4), bayW = spanW / bays;
  const depthBays = clamp(Math.round(spanD / 4.4), 1, 6), depthW = spanD / depthBays;
  const colH = clamp(Math.min(bayW, depthW * 1.2) * 0.95, 3.0, 5.2);
  const area = w * d;
  if (h >= 13.5 && area >= 150 && w / d < 2.2 && bays >= 3 && depthBays >= 2) {
    return multiStoreyTower(b, { style: 'tang', floors: 2, bays, depthBays, bayW, depthW, colH: colH * 0.92, shrink: 0.5, roof: area > 500 ? 'wudian' : 'xieshan', roofColor: 'darkgray', platformH: 0.8, eaveLights: lights, lanterns: o.lanterns, plaque: o.plaque });
  }
  const eaves = h >= 11.5 && bays >= 3 && depthBays >= 3 ? 2 : 1;
  return hall(b, {
    style: 'tang', bays, bayW, depthBays, depthW, colH, eaves, roof: area > 650 ? 'wudian' : 'xieshan', roofColor: 'darkgray',
    platformH: 0.75, front: bays >= 5 ? 'tangshop' : 'tang', back: 'wall', sides: 'wall', steps: 'front', lanterns: o.lanterns && bays >= 3, eaveLights: lights, plaque: o.plaque,
  });
}

/**
 * 一个足迹 → 唐风建筑。fp: {pts(世界), h}；origin: builder 原点 {x, y, z}；ground(x,z)；face: [fx,fz] 期望正面朝向。
 * 返回占地矩形列表（世界坐标，供排除树木）
 */
export function tangFromFootprint(b, fp, origin, ground, face, o = {}) {
  const pts = fp.pts;
  const area = Math.abs(signedArea(pts));
  if (area < 14) return [];
  const bb = obb(pts);
  if (!bb) return [];
  let per = 0;
  for (let i = 0; i < pts.length; i++) per += Math.hypot(pts[(i + 1) % pts.length][0] - pts[i][0], pts[(i + 1) % pts.length][1] - pts[i][1]);
  const thin = (per * per) / area;
  const out = [];
  const place = (cx, cz, ux, uz, w, d, h, extra = {}) => {
    // 局部 X 对齐 (ux,uz)；正面 (sinθ, cosθ) 取更接近 face 的一侧
    let th = Math.atan2(-uz, ux);
    if (face && Math.sin(th) * face[0] + Math.cos(th) * face[1] < 0) th += Math.PI;
    b.push(cx - origin.x, ground(cx, cz) - origin.y, cz - origin.z, th);
    tangRect(b, w, d, h, { ...o, ...extra });
    b.pop();
    out.push([cx, cz, w, d, -th]);
  };
  // 1) 细长（廊）：中心线扫廊
  if (bb.fill < 0.62 && thin > 38 && bb.w > 25) {
    const c = centerline(pts);
    if (c.width < 10) {
      const line = c.line.map((q) => [q[0] - origin.x, q[1] - origin.z]);
      const y = ground(c.line[(c.line.length / 2) | 0][0], c.line[(c.line.length / 2) | 0][1]) - origin.y;
      corridor(b, line, { style: 'tang', w: clamp(c.width * 0.75, 2.6, 4.5), colH: 3.0, bay: 3.4, roofColor: 'darkgray', y0: y, platformH: 0.35 });
      if (o.ledCorridor !== false) {
        // 廊檐轮廓灯
        const lpts = c.line.map((q) => [q[0] - origin.x, y + 3.9, q[1] - origin.z]);
        b.led(lpts, { color: 0xffc56a, width: 0.08 });
      }
      out.push([bb.cx, bb.cz, bb.w, bb.d, Math.atan2(bb.uz, bb.ux)]);
      return out;
    }
  }
  // 2) 规整：包围矩形一栋
  if (bb.fill >= 0.62 || area < 400) {
    const k = Math.sqrt(clamp(bb.fill, 0.6, 1));
    place(bb.cx, bb.cz, bb.ux, bb.uz, bb.w * k, bb.d * k, fp.h);
    return out;
  }
  // 3) 院落 / 异形：沿简化后的外环各长边布置一进殿
  const ring = simplifyRing(pts, 1.6);
  const sgn = signedArea(ring) > 0 ? 1 : -1;
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (L >= 7) edges.push({ a, c, L });
  }
  edges.sort((p, q) => q.L - p.L);
  const dd = clamp(bb.d * 0.28, 5.5, 10);
  for (const e of edges.slice(0, 10)) {
    const ux = (e.c[0] - e.a[0]) / e.L, uz = (e.c[1] - e.a[1]) / e.L;
    const nx = -uz * sgn, nz = ux * sgn; // 指向内侧
    const cx = (e.a[0] + e.c[0]) / 2 + nx * dd * 0.55, cz = (e.a[1] + e.c[1]) / 2 + nz * dd * 0.55;
    place(cx, cz, ux, uz, e.L * 0.9, dd, fp.h * 0.85, { plaque: null });
  }
  return out;
}

// ───────────── 湖面遮罩 ─────────────
/** 多个水面多边形 → 遮罩纹理 {tex, mb: Vector4(x0, z0, 1/w, 1/h)} */
export function lakeMask(polys, pad = 20, size = 1024) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const p of polys) for (let i = 0; i < p.outer.length; i += 2) {
    x0 = Math.min(x0, p.outer[i]); x1 = Math.max(x1, p.outer[i]); z0 = Math.min(z0, p.outer[i + 1]); z1 = Math.max(z1, p.outer[i + 1]);
  }
  x0 -= pad; x1 += pad; z0 -= pad; z1 += pad;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#fff';
  const sx = size / (x1 - x0), sz = size / (z1 - z0);
  for (const p of polys) {
    g.beginPath();
    for (const ring of [p.outer, ...(p.holes || [])]) {
      for (let i = 0; i < ring.length; i += 2) {
        const X = (ring[i] - x0) * sx, Y = (ring[i + 1] - z0) * sz;
        if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
      }
      g.closePath();
    }
    g.fill('evenodd');
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { tex, mb: new THREE.Vector4(x0, z0, 1 / (x1 - x0), 1 / (z1 - z0)), bounds: { x0, x1, z0, z1 } };
}

// ───────────── 投影倒影 ─────────────
// 把建筑按水面镜像后，沿视线投影回水面（屏幕位置与真实镜像一致，深度落在水面上 → 不被水面遮挡、
// 仍被岸上物体遮挡）。发光部分（灯带、窗光）加色混合 = 水面反射光叠加；实体部分（墙、柱、屋面）白天用半透明正常混合
// 盖在水面上（原先也是加色，白天只能把浅色水面再提亮一点，近景几乎看不出倒影）。湖面外用遮罩裁掉。
const reflCache = new Map();
function reflMaterial(ctx, kind, lake) {
  const key = kind + '|' + lake.id;
  if (reflCache.has(key)) return reflCache.get(key);
  const solid = kind !== 'emit' && kind !== 'glow';
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: solid ? THREE.NormalBlending : THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  m.name = 'qj.refl.' + kind;
  m.defines = { REFL_KIND: kind === 'emit' ? 1 : kind === 'glow' ? 2 : 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWY = { value: lake.y };
    sh.uniforms.uCam = ctx.uniforms.uCameraPos;
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.uniforms.uMask = { value: lake.tex };
    sh.uniforms.uMB = { value: lake.mb };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWY;\nuniform vec3 uCam;\nvarying vec3 vRW;\nvarying float vRH;')
      .replace('#include <project_vertex>', `
        vec4 rw = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          rw = instanceMatrix * rw;
        #endif
        rw = modelMatrix * rw;
        vRH = rw.y - uWY;
        rw.y = 2.0 * uWY - rw.y;
        vec3 rd = rw.xyz - uCam;
        float rt = ( uWY + 0.08 - uCam.y ) / min( rd.y, -1e-4 );
        vec3 rp = uCam + rd * clamp( rt, 0.0, 1.0 );
        vRW = rp;
        vec4 mvPosition = viewMatrix * vec4( rp, 1.0 );
        gl_Position = projectionMatrix * mvPosition;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uTime;\nuniform sampler2D uMask;\nuniform vec4 uMB;\nvarying vec3 vRW;\nvarying float vRH;')
      .replace('#include <opaque_fragment>', `
        vec2 muv = ( vRW.xz - uMB.xy ) * uMB.zw;
        if ( muv.x < 0.0 || muv.y < 0.0 || muv.x > 1.0 || muv.y > 1.0 ) discard;
        if ( texture2D( uMask, muv ).r < 0.5 ) discard;
        float rip = 0.72 + 0.28 * sin( vRW.x * 0.83 + uTime * 1.3 ) * sin( vRW.z * 1.9 - uTime * 1.7 );
        float fade = exp( -max( vRH, 0.0 ) * 0.02 );
        vec3 rc;
        #if REFL_KIND == 1
          rc = diffuseColor.rgb * uNight * 1.7 * rip * ( 0.55 + 0.45 * fade );
        #elif REFL_KIND == 2
          rc = vec3( 1.0, 0.62, 0.3 ) * uNight * 0.55 * rip * fade;
        #else
          // 实体倒影：近似受光的反照率（白天约 0.62，夜间压暗），半透明盖在水面上；多层重叠时透明度累积有限
          rc = diffuseColor.rgb * mix( 0.62, 0.05, uNight ) * ( 0.85 + 0.15 * rip );
          gl_FragColor = vec4( rc, 0.3 * fade * ( 0.75 + 0.25 * rip ) * ( 1.0 - 0.7 * uNight ) );
        #endif
        #if REFL_KIND != 0
        gl_FragColor = vec4( rc, 1.0 );
        #endif`);
  };
  m.customProgramCacheKey = () => 'qj-refl-' + kind;
  // 加色混合与绘制顺序无关：关掉 three 对“透明 + 双面”材质的背面/正面两遍绘制（否则每个网格 2 次 draw call）
  m.forceSinglePass = true;
  reflCache.set(key, m);
  return m;
}
const _rm = new THREE.Matrix4(), _rv = new THREE.Vector3(), _rc = new THREE.Color();
/**
 * 收集 obj 树里的古建网格（含 InstancedMesh，实例逐个展开）为世界坐标的顶点/颜色/索引块，按倒影种类归类。
 * out: {solid: [], emit: [], glow: []}，每块 {pos: Float32Array, col: Float32Array, idx: Uint32Array}
 */
function collectReflChunks(obj, solids, out) {
  obj.updateMatrixWorld(true);
  obj.traverse((m) => {
    if (!m.isMesh || !m.material || Array.isArray(m.material)) return;
    const nm = m.material.name || '';
    if (!nm.startsWith('arch.') || nm === 'arch.lattice') return;
    const kind = nm === 'arch.led' || nm === 'arch.emit' ? 'emit' : nm === 'arch.glow' ? 'glow' : 'solid';
    if (kind === 'solid' && !solids) return;
    const g = m.geometry;
    const pa = g.attributes.position, ca = g.attributes.color;
    const nV = pa.count;
    const ind = g.index ? g.index.array : null;
    const nI = ind ? g.index.count : nV;
    const nInst = m.isInstancedMesh ? m.count : 1;
    for (let k = 0; k < nInst; k++) {
      if (m.isInstancedMesh) _rm.fromArray(m.instanceMatrix.array, k * 16).premultiply(m.matrixWorld);
      else _rm.copy(m.matrixWorld);
      let tr = 1, tg = 1, tb = 1;
      if (m.isInstancedMesh && m.instanceColor) { m.getColorAt(k, _rc); tr = _rc.r; tg = _rc.g; tb = _rc.b; }
      const pos = new Float32Array(nV * 3), col = new Float32Array(nV * 3);
      for (let i = 0; i < nV; i++) {
        _rv.fromBufferAttribute(pa, i).applyMatrix4(_rm);
        pos[i * 3] = _rv.x; pos[i * 3 + 1] = _rv.y; pos[i * 3 + 2] = _rv.z;
        if (ca) { col[i * 3] = ca.getX(i) * tr; col[i * 3 + 1] = ca.getY(i) * tg; col[i * 3 + 2] = ca.getZ(i) * tb; }
        else { col[i * 3] = tr; col[i * 3 + 1] = tg; col[i * 3 + 2] = tb; }
      }
      const idx = new Uint32Array(nI);
      if (ind) idx.set(ind.subarray(0, nI)); else for (let i = 0; i < nI; i++) idx[i] = i;
      out[kind].push({ pos, col, idx });
    }
  });
}
/**
 * 为一个湖生成合并倒影：sources = [{obj, solids}]（obj 为建筑组/LOD 某级；solids=false 只取发光部分），
 * 所有来源按种类（solid/emit/glow）各合成 1 个网格（≤ 3 个 draw call），加入 parent。lake: {id, y, tex, mb}。
 * 几何复制为世界坐标（来源可以不在场景里，例如远景簇的临时 Group）。返回 {meshes, tris}。
 */
export function mergeReflections(ctx, parent, lake, sources) {
  const chunks = { solid: [], emit: [], glow: [] };
  for (const s of sources) collectReflChunks(s.obj, s.solids !== false, chunks);
  let meshes = 0, tris = 0;
  for (const kind of ['solid', 'emit', 'glow']) {
    const list = chunks[kind];
    if (!list.length) continue;
    let nV = 0, nI = 0;
    for (const c of list) { nV += c.pos.length / 3; nI += c.idx.length; }
    const pos = new Float32Array(nV * 3), col = new Float32Array(nV * 3), idx = new Uint32Array(nI);
    let vo = 0, io = 0;
    for (const c of list) {
      pos.set(c.pos, vo * 3); col.set(c.col, vo * 3);
      for (let i = 0; i < c.idx.length; i++) idx[io + i] = c.idx[i] + vo;
      vo += c.pos.length / 3; io += c.idx.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const r = new THREE.Mesh(geo, reflMaterial(ctx, kind, lake));
    r.name = 'refl:' + lake.id + ':' + kind;
    r.frustumCulled = false; // 顶点在着色器里被镜像并投影到水面，包围球无意义；由模块按距离整体显隐
    r.castShadow = r.receiveShadow = false;
    r.renderOrder = 2;
    parent.add(r);
    meshes++; tris += nI / 3;
  }
  return { meshes, tris: Math.round(tris) };
}

// ───────────── 远景簇合并集 ─────────────
/**
 * 把多个簇的远景（detail 0）输出合并为“每种材质 1 个网格”，并保留每簇的索引段：
 * 近景簇（显示 detail 1 的）或超出显示距离的簇通过重建索引剔除，不必为每簇各留一套网格。
 *   parts: [{group（ArchBuilder.build() 输出，instancing=false，group.position 已设为簇原点）}]
 *   setMask(Uint8Array)：1 = 剔除该簇；只在掩码变化时重建索引（bufferSubData 一次）。
 */
export class ClusterFarSet {
  constructor(parts, { name = '园林建筑-远景' } = {}) {
    this.group = new THREE.Group();
    this.group.name = name;
    this.n = parts.length;
    this.mask = new Uint8Array(parts.length);
    this.entries = [];
    const byMat = new Map();
    parts.forEach((p, pi) => {
      p.group.updateMatrixWorld(true);
      p.group.traverse((m) => {
        if (!m.isMesh || m.isInstancedMesh) return;
        let e = byMat.get(m.material);
        if (!e) { e = { material: m.material, castShadow: m.castShadow, chunks: [] }; byMat.set(m.material, e); }
        e.chunks.push({ pi, mesh: m });
      });
    });
    const nm3 = new THREE.Matrix3();
    for (const e of byMat.values()) {
      let nV = 0, nI = 0;
      for (const c of e.chunks) { const g = c.mesh.geometry; nV += g.attributes.position.count; nI += g.index ? g.index.count : g.attributes.position.count; }
      const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), col = new Float32Array(nV * 3);
      const partIdx = parts.map(() => []);
      let vo = 0;
      for (const c of e.chunks) {
        const g = c.mesh.geometry, mw = c.mesh.matrixWorld;
        nm3.getNormalMatrix(mw);
        const pa = g.attributes.position, na = g.attributes.normal, ta = g.attributes.uv, ca = g.attributes.color;
        const n = pa.count;
        for (let i = 0; i < n; i++) {
          _rv.fromBufferAttribute(pa, i).applyMatrix4(mw);
          pos[(vo + i) * 3] = _rv.x; pos[(vo + i) * 3 + 1] = _rv.y; pos[(vo + i) * 3 + 2] = _rv.z;
          if (na) { _rv.fromBufferAttribute(na, i).applyMatrix3(nm3).normalize(); nor[(vo + i) * 3] = _rv.x; nor[(vo + i) * 3 + 1] = _rv.y; nor[(vo + i) * 3 + 2] = _rv.z; }
          else nor[(vo + i) * 3 + 1] = 1;
          if (ta) { uv[(vo + i) * 2] = ta.getX(i); uv[(vo + i) * 2 + 1] = ta.getY(i); }
          if (ca) { col[(vo + i) * 3] = ca.getX(i); col[(vo + i) * 3 + 1] = ca.getY(i); col[(vo + i) * 3 + 2] = ca.getZ(i); }
          else { col[(vo + i) * 3] = col[(vo + i) * 3 + 1] = col[(vo + i) * 3 + 2] = 1; }
        }
        const ind = g.index ? g.index.array : null, ni = ind ? g.index.count : n;
        const arr = new Uint32Array(ni);
        for (let i = 0; i < ni; i++) arr[i] = (ind ? ind[i] : i) + vo;
        partIdx[c.pi].push(arr);
        vo += n;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const idx = new THREE.BufferAttribute(new Uint32Array(nI), 1);
      idx.setUsage(THREE.DynamicDrawUsage);
      geo.setIndex(idx);
      geo.computeBoundingSphere(); // 全集包围球（超集），索引重建后不必重算
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, e.material);
      mesh.name = (e.material.name || 'arch').replace('arch.', '');
      mesh.castShadow = e.castShadow;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.entries.push({ mesh, geo, partIdx, total: nI, tris: nI / 3 });
    }
    this._rebuild();
  }
  /** 剔除掩码（每簇 1 字节，1 = 不画）；变化时重建索引，返回是否重建 */
  setMask(mask) {
    let same = true;
    for (let i = 0; i < this.n; i++) if (mask[i] !== this.mask[i]) { same = false; break; }
    if (same) return false;
    this.mask.set(mask);
    this._rebuild();
    return true;
  }
  _rebuild() {
    for (const e of this.entries) {
      const idx = e.geo.index;
      let o = 0;
      for (let pi = 0; pi < this.n; pi++) {
        if (this.mask[pi]) continue;
        for (const arr of e.partIdx[pi]) { idx.array.set(arr, o); o += arr.length; }
      }
      e.geo.setDrawRange(0, o);
      e.mesh.visible = o > 0; // 绘制范围为 0 时 three 仍会发一次空 draw call，直接隐藏
      idx.needsUpdate = true;
    }
  }
  /** 当前实际绘制的三角形数（自测用） */
  get drawnTris() {
    let t = 0;
    for (const e of this.entries) t += e.geo.drawRange.count / 3;
    return Math.round(t);
  }
}

// ───────────── 水幕电影 + 喷泉 + 激光 ─────────────
const COMMON_V = `
#include <common>
#include <logdepthbuf_pars_vertex>
`;
export function waterShow(ctx, { x, y, z, yaw = 0, width = 76, height = 22 }) {
  const g = new THREE.Group();
  g.name = '芙蓉湖水幕灯光秀';
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  const U = ctx.uniforms;
  // 1) 水幕（扇形喷雾屏）
  const screenGeo = new THREE.PlaneGeometry(width, height, 48, 12);
  const pa = screenGeo.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const px = pa.getX(i), py = pa.getY(i) + height / 2;
    const t = px / (width / 2);
    pa.setXYZ(i, px * (0.86 + 0.14 * (py / height)), py, -2.5 * t * t);
  }
  const screenMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uNight: U.uNight },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: COMMON_V + `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uNight; varying vec2 vUv;
      float h1(float n){ return fract(sin(n*127.1)*43758.5453); }
      vec3 hue(float h){ return clamp(abs(mod(h*6.0+vec3(0.,4.,2.),6.)-3.)-1.,0.,1.); }
      void main() {
        #include <logdepthbuf_fragment>
        float u = vUv.x, v = vUv.y;
        float show = smoothstep(0.35, 0.75, uNight);
        if (show < 0.01) discard;
        float edge = smoothstep(0.0, 0.07, u) * smoothstep(1.0, 0.93, u);
        float top = 1.0 - smoothstep(0.62, 1.0, v + 0.06 * sin(u * 23.0 + uTime * 1.9));
        float col = floor(u * 220.0);
        float streak = 0.55 + 0.45 * fract(h1(col) + v * 0.6 - uTime * (0.35 + 0.3 * h1(col + 7.0)));
        float t = uTime; float sc = mod(floor(t / 11.0), 3.0); float lt = fract(t / 11.0);
        vec2 p = vec2((u - 0.5) * 3.4, v - 0.42);
        vec3 c;
        if (sc < 0.5) { // 盛放的芙蓉（莲瓣）
          float a = atan(p.y, p.x), r = length(p);
          float petal = 0.2 + 0.2 * smoothstep(0.0, 0.5, lt) * (0.6 + 0.4 * abs(cos(a * 4.0 + t * 0.3)));
          float f = smoothstep(petal + 0.03, petal - 0.03, r);
          c = mix(vec3(0.05, 0.25, 0.6), vec3(1.0, 0.35, 0.55), f) + vec3(1.0, 0.8, 0.3) * smoothstep(0.08, 0.0, r) ;
        } else if (sc < 1.5) { // 流光彩带
          float bnd = sin(p.x * 3.0 + t * 0.9 + sin(p.y * 4.0 + t) * 1.2);
          c = hue(fract(0.08 * t + p.x * 0.12 + 0.5 * bnd)) * (0.55 + 0.45 * bnd);
        } else { // 金色盛唐：光芒与飞星
          float a = atan(p.y + 0.2, p.x);
          float rays = pow(0.5 + 0.5 * cos(a * 18.0 + t * 0.6), 6.0);
          c = vec3(1.0, 0.68, 0.22) * (0.3 + rays * 0.9);
          vec2 q = fract(vec2(u * 18.0, v * 6.0 + t * 0.2)) - 0.5;
          c += vec3(1.0, 0.9, 0.7) * smoothstep(0.08, 0.0, length(q)) * step(0.75, h1(floor(u * 18.0) + floor(v * 6.0 + t * 0.2) * 31.0));
        }
        float a = edge * top * streak * show;
        gl_FragColor = vec4(c * a * 1.9 + vec3(0.06, 0.1, 0.14) * a, 1.0);
      }`,
  });
  const screen = new THREE.Mesh(screenGeo, screenMat);
  screen.frustumCulled = false;
  screen.renderOrder = 3;
  g.add(screen);
  // 2) 喷泉水柱（一行，动态高度）
  const N = 44, pos = [], uvs = [], ph = [], idx = [];
  for (let i = 0; i < N; i++) {
    const px = -width * 0.48 + (width * 0.96 * i) / (N - 1);
    for (let k = 0; k < 2; k++) {
      const base = pos.length / 3;
      const dx = k ? 0 : 0.7, dz = k ? 0.7 : 0;
      pos.push(px - dx, 0, 2.2 - dz, px + dx, 0, 2.2 + dz, px + dx, 1, 2.2 + dz, px - dx, 1, 2.2 - dz);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      for (let j = 0; j < 4; j++) ph.push(i * 0.37 + (i % 3) * 1.1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const jg = new THREE.BufferGeometry();
  jg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  jg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  jg.setAttribute('aPh', new THREE.Float32BufferAttribute(ph, 1));
  jg.setIndex(idx);
  const jetMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uNight: U.uNight },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: COMMON_V + `
      attribute float aPh; uniform float uTime; varying vec2 vUv; varying float vPh;
      void main() { vUv = uv; vPh = aPh;
        float hgt = 5.0 + 11.0 * (0.5 + 0.5 * sin(uTime * 1.25 + aPh)) * (0.6 + 0.4 * sin(uTime * 0.31 + aPh * 0.5));
        vec3 p = position; p.y *= hgt; p.xz += (position.xz - vec2(position.x, 2.2)) * position.y * 1.4;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uNight; varying vec2 vUv; varying float vPh;
      void main() {
        #include <logdepthbuf_fragment>
        float core = 1.0 - abs(vUv.x - 0.5) * 2.0;
        float a = core * core * (1.0 - vUv.y) * (0.55 + 0.45 * fract(vUv.y * 7.0 - uTime * 2.0 + vPh));
        vec3 day = vec3(0.55, 0.6, 0.62) * 0.55;
        vec3 night = 0.6 + 0.4 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + uTime * 0.07 + vPh * 0.05));
        vec3 c = mix(day, night * 1.8, smoothstep(0.3, 0.8, uNight));
        gl_FragColor = vec4(c * a, 1.0);
      }`,
  });
  const jets = new THREE.Mesh(jg, jetMat);
  jets.frustumCulled = false;
  jets.renderOrder = 3;
  g.add(jets);
  // 3) 激光束
  const lasers = new THREE.Group();
  const beamGeo = new THREE.CylinderGeometry(0.04, 0.5, 320, 5, 1, true);
  beamGeo.translate(0, 160, 0);
  const colors = [0x39ff9a, 0x44c8ff, 0xffc04a, 0xff4fd8, 0x44c8ff, 0x39ff9a];
  const beams = [];
  for (let i = 0; i < colors.length; i++) {
    const m = new THREE.ShaderMaterial({
      uniforms: { uNight: U.uNight, uCol: { value: new THREE.Color(colors[i]) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: COMMON_V + `varying float vH; void main(){ vH = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        #include <logdepthbuf_vertex>
      }`,
      fragmentShader: `#include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uNight; uniform vec3 uCol; varying float vH; void main(){
        #include <logdepthbuf_fragment>
        float a = (1.0 - vH); a = a * a * a * 0.32 * smoothstep(0.45, 0.85, uNight);
        gl_FragColor = vec4(uCol * a, 1.0); }`,
    });
    const bm = new THREE.Mesh(beamGeo, m);
    bm.position.set(-width * 0.42 + (width * 0.84 * i) / (colors.length - 1), 1, -6);
    bm.frustumCulled = false;
    beams.push(bm);
    lasers.add(bm);
  }
  g.add(lasers);
  return {
    group: g,
    update(t, night) {
      lasers.visible = night > 0.4;
      screen.visible = night > 0.3;
      if (!lasers.visible) return;
      for (let i = 0; i < beams.length; i++) {
        const s = i % 2 ? 1 : -1;
        beams[i].rotation.z = s * (0.25 + 0.35 * Math.sin(t * 0.45 + i * 0.8));
        beams[i].rotation.x = -0.35 + 0.25 * Math.sin(t * 0.33 + i * 1.3);
      }
    },
  };
}
