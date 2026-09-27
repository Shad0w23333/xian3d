// 机场地面：跑道/滑行道/机坪几何、ICAO 标线（纹理图集 + 顶点色，一次绘制）、助航灯光点精灵着色器。
// 跑道标线按 ICAO 附件 14 第 5 章：入口标志（45 m 宽 12 条 / 60 m 宽 16 条，1.8 m×30 m）、跑道号（9 m 高）、
// 中线（30 m 线段 + 20 m 间隔，0.9 m 宽）、瞄准点（定距标志，距入口 400 m，10 m×50 m）、接地带标志、边线。
import * as THREE from 'three';
import { resample } from '../core/util.js';

// ---------- 小工具 ----------
export function runwayInfo(f) {
  const p = f.p;
  const n = p.length;
  const ax = p[0], az = p[1], bx = p[n - 2], bz = p[n - 1];
  const L = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / L, uz = (bz - az) / L;
  const brg = ((Math.atan2(ux, -uz) * 180) / Math.PI + 360) % 360;
  let dA = '', dB = '';
  if (f.ref && f.ref.includes('/')) {
    const [r1, r2] = f.ref.split('/');
    const h1 = parseInt(r1, 10) * 10;
    const diff = Math.abs(((brg - h1 + 540) % 360) - 180);
    if (diff < 90) { dA = r1; dB = r2; } else { dA = r2; dB = r1; }
  }
  return { ax, az, bx, bz, L, ux, uz, rx: -uz, rz: ux, w: f.w || 45, dA, dB, ref: f.ref || '' };
}

/** 采集器：按材质的非索引三角形（位置/法线/uv/颜色） */
export class TriSink {
  constructor() { this.pos = []; this.uv = []; this.col = []; }
  quad(a, b, c, d, uva, uvb, uvc, uvd, col) {
    // a,b,c,d 逆时针（俯视，法线朝上）: 输入顺序为 近左 近右 远右 远左（相对 +Y 向上时手动保证朝上）
    const P = this.pos, U = this.uv, C = this.col;
    for (const [v, t] of [[a, uva], [c, uvc], [b, uvb], [a, uva], [d, uvd], [c, uvc]]) {
      P.push(v[0], v[1], v[2]); U.push(t[0], t[1]); C.push(col[0], col[1], col[2]);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    // 保证法线朝上
    const nrm = g.attributes.normal.array;
    let flip = 0;
    for (let i = 1; i < nrm.length; i += 3) flip += nrm[i] < 0 ? 1 : -1;
    if (flip > 0) {
      const pa = g.attributes.position.array, ua = g.attributes.uv.array;
      for (let i = 0; i < pa.length; i += 9) for (let k = 0; k < 3; k++) { const t = pa[i + 3 + k]; pa[i + 3 + k] = pa[i + 6 + k]; pa[i + 6 + k] = t; }
      for (let i = 0; i < ua.length; i += 6) for (let k = 0; k < 2; k++) { const t = ua[i + 2 + k]; ua[i + 2 + k] = ua[i + 4 + k]; ua[i + 4 + k] = t; }
      g.computeVertexNormals();
    }
    g.computeBoundingSphere();
    return g;
  }
}

// ---------- 标线图集 ----------
const GLYPHS = '0123456789LRC';
export function markingAtlas() {
  const W = 1024, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#ffffff';
  g.fillRect(4, 4, 56, 56);
  // 虚线（用于等待位置 B 型虚线）：64..128
  for (let i = 0; i < 4; i++) g.fillRect(64 + i * 16, 4, 9, 56);
  g.font = 'bold 128px "DIN Condensed","Arial Narrow","Helvetica Neue",Arial,sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < GLYPHS.length; i++) {
    g.save();
    g.translate(128 + i * 64 + 32, 64);
    g.scale(0.62, 1.06);
    g.fillText(GLYPHS[i], 0, 6);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
const UV_SOLID = [16 / 1024, 16 / 128, 48 / 1024, 48 / 128];
const UV_DASH = [64 / 1024, 16 / 128, 128 / 1024, 48 / 128];
const glyphUV = (ch) => {
  const i = GLYPHS.indexOf(ch);
  return [(128 + i * 64 + 2) / 1024, 2 / 128, (128 + i * 64 + 62) / 1024, 126 / 128];
};

/** 在地面画一个沿方向 (ux,uz) 的矩形：中心 (cx,cz)，沿向长 len，横向宽 wid */
export function markRect(sink, hf, cx, cz, ux, uz, len, wid, col, uvr = UV_SOLID, lift = 0.06) {
  const rx = -uz, rz = ux;
  const hl = len / 2, hw = wid / 2;
  const P = (s, o) => { const x = cx + ux * s + rx * o, z = cz + uz * s + rz * o; return [x, hf(x, z) + lift, z]; };
  // 近左(-s,-o) 近右(-s,+o) 远右(+s,+o) 远左(+s,-o)；纹理 u 随 +o，v 随 +s
  sink.quad(P(-hl, -hw), P(-hl, hw), P(hl, hw), P(hl, -hw), [uvr[0], uvr[1]], [uvr[2], uvr[1]], [uvr[2], uvr[3]], [uvr[0], uvr[3]], col);
}

export const WHITE = [0.9, 0.9, 0.88], YELLOW = [0.95, 0.7, 0.08], RED = [0.75, 0.08, 0.06];

/** 沿折线画细线（黄中线等），分段矩形 */
export function markLine(sink, hf, p, width, col, { step = 15, trim = 0, dash = 0, gap = 0, lift = 0.06 } = {}) {
  const pts = resample(p, step);
  if (pts.length < 2) return;
  const total = pts[pts.length - 1].s;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.s < trim || b.s > total - trim) continue;
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
    if (l < 0.2) continue;
    if (dash) {
      const cyc = dash + gap;
      if (a.s % cyc > dash) continue;
    }
    markRect(sink, hf, (a.x + b.x) / 2, (a.z + b.z) / 2, dx / l, dz / l, l + width * 0.5, width, col, UV_SOLID, lift);
  }
}

/** 偏移折线（横向 off 米） */
export function offsetLine(p, off) {
  const n = p.length / 2, out = [];
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    let dx = p[i1 * 2] - p[i0 * 2], dz = p[i1 * 2 + 1] - p[i0 * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    out.push(p[i * 2] - dz * off, p[i * 2 + 1] + dx * off);
  }
  return out;
}

/** 跑道道面 + 道肩 + 橡胶痕（顶点色），UV 以米计 */
export function runwaySurface(sink, hf, R, { shoulder = 7.5, lift = 0.12 } = {}) {
  const hw = R.w / 2;
  const offs = shoulder ? [-hw - shoulder, -hw, -hw + 3, -9, 0, 9, hw - 3, hw, hw + shoulder] : [-hw, -hw + 3, -9, 0, 9, hw - 3, hw];
  const step = 30;
  const n = Math.ceil(R.L / step);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tone = [];
  for (let i = 0; i <= n; i++) tone.push(0.92 + rnd() * 0.1);
  const colAt = (s, o, i) => {
    const ao = Math.abs(o);
    if (ao > hw + 0.1) return [0.62, 0.62, 0.6];
    let k = tone[i];
    const e = Math.min(s, R.L - s);
    if (ao < 10 && e > 150 && e < 1100) k *= 0.55 + 0.4 * Math.min(1, Math.abs(e - 550) / 550) + (ao > 6 ? 0.12 : 0);
    return [k, k, k * 0.98];
  };
  for (let i = 0; i < n; i++) {
    const s0 = (i * R.L) / n, s1 = ((i + 1) * R.L) / n;
    for (let j = 0; j < offs.length - 1; j++) {
      const o0 = offs[j], o1 = offs[j + 1];
      const P = (s, o) => { const x = R.ax + R.ux * s + R.rx * o, z = R.az + R.uz * s + R.rz * o; return [x, hf(x, z) + lift, z]; };
      const c = colAt((s0 + s1) / 2, (o0 + o1) / 2, i);
      sink.quad(P(s0, o0), P(s0, o1), P(s1, o1), P(s1, o0), [o0, s0], [o1, s0], [o1, s1], [o0, s1], c);
    }
  }
}

/** 跑道标线 */
export function runwayMarkings(sink, hf, R, { big = true } = {}) {
  const hw = R.w / 2;
  const L = R.L;
  const M = (s, o, len, wid, col = WHITE, uv) => markRect(sink, hf, R.ax + R.ux * s + R.rx * o, R.az + R.uz * s + R.rz * o, R.ux, R.uz, len, wid, col, uv);
  // 边线
  M(L / 2, -hw + 0.6, L - 4, 0.9); M(L / 2, hw - 0.6, L - 4, 0.9);
  // 中线
  for (let s = 95; s < L - 95 - 30; s += 50) M(s + 15, 0, 30, 0.9);
  // 两端
  for (const end of [0, 1]) {
    const des = end ? R.dB : R.dA;
    const sgn = end ? -1 : 1, base = end ? L : 0;
    const S = (d) => base + sgn * d;
    // 反向时标线方向翻转：用负向量画（字形朝向入口）
    const E = (d, o, len, wid, col = WHITE, uv) => {
      const cx = R.ax + R.ux * S(d) + R.rx * o * sgn, cz = R.az + R.uz * S(d) + R.rz * o * sgn;
      markRect(sink, hf, cx, cz, R.ux * sgn, R.uz * sgn, len, wid, col, uv);
    };
    const nStr = R.w >= 58 ? 8 : R.w >= 44 ? 6 : R.w >= 29 ? 4 : 3;
    for (let k = 0; k < nStr; k++) for (const sd of [-1, 1]) E(6 + 15, sd * (1.8 + 0.9 + k * 3.6), 30, 1.8);
    if (des) {
      const num = des.replace(/[^0-9]/g, '').padStart(2, '0');
      const let_ = des.replace(/[0-9]/g, '');
      let d0 = 48;
      if (let_) { E(d0 + 4.5, 0, 9, 3.3, WHITE, glyphUV(let_[0])); d0 += 12; }
      E(d0 + 4.5, -1.9, 9, 3.3, WHITE, glyphUV(num[0]));
      E(d0 + 4.5, 1.9, 9, 3.3, WHITE, glyphUV(num[1]));
    }
    if (big && L > 1800) {
      // 瞄准点（定距标志）
      for (const sd of [-1, 1]) E(400 + 25, sd * 14.5, 50, 10);
      // 接地带标志
      for (const [d, cnt] of [[150, 3], [300, 3], [600, 2], [750, 2], [900, 1]]) {
        for (const sd of [-1, 1]) for (let k = 0; k < cnt; k++) E(d + 11.25, sd * (9.5 + 0.9 + k * 3.3), 22.5, 1.8);
      }
    }
  }
}

// ---------- 灯光点精灵 ----------
export class LightList {
  constructor() { this.p = []; this.c = []; this.s = []; this.m = []; }
  add(x, y, z, col, size = 0.6, mode = 0, phase = 0, dx = 0, dz = 0) {
    this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]); this.s.push(size); this.m.push(mode, phase, dx, dz);
  }
  get count() { return this.s.length; }
}

export const LC = {
  white: [3.2, 3.0, 2.6], yellow: [3.4, 2.4, 0.5], green: [0.4, 3.4, 1.2], red: [3.6, 0.35, 0.2], blue: [0.35, 0.7, 3.6],
  amber: [3.2, 2.0, 0.6], mast: [3.4, 3.0, 2.3], strobe: [5, 5, 5], land: [6, 5.6, 5],
};

/**
 * 点精灵着色器：mode 0 常亮 1 顺序闪光 2 交替闪（跑道警戒灯）3 红色防撞灯 4 白频闪 5 白天也亮（飞机灯）
 * 方向灯：prm.zw 非零时只朝该方向可见。
 */
export function lightMaterial(ctx, { dayVisible = 0.0 } = {}) {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 700 }, uDay: { value: dayVisible } }]);
  uniforms.uTime = ctx.uniforms.uTime;
  uniforms.uNight = ctx.uniforms.uNight;
  return new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 color; attribute float size; attribute vec4 prm;
      uniform float uTime, uNight, uScale, uDay;
      varying vec3 vCol; varying float vI;
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float dist = max(1.0, -mvPosition.z);
        int mode = int(prm.x + 0.5); float ph = prm.y;
        float I = 1.0;
        if (mode == 1) { float t = fract(uTime * 2.0); I = (1.0 - smoothstep(0.0, 0.035, abs(t - ph))) * 3.5; }
        else if (mode == 2) { I = step(0.5, fract(uTime * 0.85 + ph)) * 1.4; }
        else if (mode == 3) { float t = fract(uTime * 0.95 + ph); I = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.08, 0.22, t)) * 2.5; }
        else if (mode == 4) { float t = fract(uTime * 0.8 + ph); I = (step(t, 0.03) + step(abs(t - 0.13), 0.03)) * 3.5; }
        if (dot(prm.zw, prm.zw) > 0.01) {
          vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
          vec2 vd = normalize(cameraPosition.xz - wp.xz);
          I *= smoothstep(-0.15, 0.4, dot(vd, normalize(prm.zw)));
        }
        float vis = mode >= 3 ? max(uNight, uDay) : uNight;
        I *= vis;
        float px = size * uScale / dist;
        float ps = max(px, 2.2);
        I *= min(1.0, pow(px / 2.2, 0.55) + 0.12);
        I *= 1.0 - smoothstep(22000.0, 40000.0, dist);
        vCol = color; vI = I;
        gl_PointSize = I > 0.003 ? min(ps * 2.6, 96.0) : 0.0;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying float vI;
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c) * 2.0;
        float a = exp(-d * d * 7.0) + 0.35 * exp(-d * d * 1.6);
        if (a < 0.01) discard;
        vec3 col = vCol * vI * a;
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogB = ${(1 / 1500).toFixed(7)};
            float fogCamH = max(cameraPosition.y - 400.0, 0.0);
            float fogK = vFogDY * fogB;
            float fogT = abs(fogK) > 1e-4 ? (1.0 - exp(-fogK)) / fogK : 1.0;
            float fogF = 1.0 - exp(-fogDensity * vFogDepth * exp(-fogCamH * fogB) * fogT);
          #else
            float fogF = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          col *= 1.0 - clamp(fogF, 0.0, 1.0) * 0.8;
        #endif
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

export function lightPoints(ctx, list, opts = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(list.p, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(list.c, 3));
  g.setAttribute('size', new THREE.Float32BufferAttribute(list.s, 1));
  g.setAttribute('prm', new THREE.Float32BufferAttribute(list.m, 4));
  g.computeBoundingSphere();
  const pts = new THREE.Points(g, lightMaterial(ctx, opts));
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  return pts;
}

/** 跑道灯光：边灯、中线灯、入口/末端灯、接地带灯、进近灯（含顺序闪光）、PAPI */
export function runwayLights(L, hf, R, { approach = true, center = true } = {}) {
  const hw = R.w / 2;
  const P = (s, o, h = 0.35) => { const x = R.ax + R.ux * s + R.rx * o, z = R.az + R.uz * s + R.rz * o; return [x, hf(x, z) + h, z]; };
  // 边灯（每 60 m；距末端 600 m 内朝向跑道内侧为黄色）
  for (let s = 0; s <= R.L + 0.1; s += Math.min(60, R.L / Math.ceil(R.L / 60))) {
    for (const sd of [-1, 1]) {
      const [x, y, z] = P(s, sd * (hw + 1.5));
      if (s > 600 && s < R.L - 600) L.add(x, y, z, LC.white, 0.7);
      else {
        const nearB = s >= R.L - 600;
        const inx = nearB ? -R.ux : R.ux, inz = nearB ? -R.uz : R.uz;
        L.add(x, y, z, LC.yellow, 0.7, 0, 0, inx, inz);
        L.add(x, y, z, LC.white, 0.7, 0, 0, -inx, -inz);
      }
    }
  }
  if (center) {
    for (let s = 15; s < R.L - 10; s += 30) {
      const [x, y, z] = P(s, 0.6, 0.1);
      const e = Math.min(s, R.L - s);
      if (e > 900) L.add(x, y, z, LC.white, 0.45);
      else {
        const nearB = s > R.L / 2;
        const inx = nearB ? -R.ux : R.ux, inz = nearB ? -R.uz : R.uz;
        const col = e < 300 ? LC.red : Math.round(s / 30) % 2 ? LC.red : LC.white;
        L.add(x, y, z, col, 0.45, 0, 0, inx, inz);
        L.add(x, y, z, LC.white, 0.45, 0, 0, -inx, -inz);
      }
    }
  }
  for (const end of [0, 1]) {
    const sgn = end ? -1 : 1, base = end ? R.L : 0;
    const out = [-R.ux * sgn, -R.uz * sgn]; // 指向进近方向
    const S = (d) => base + sgn * d;
    // 入口灯（绿，朝进近方向）+ 翼排灯；末端灯（红，朝跑道内）
    for (let o = -hw - 10; o <= hw + 10.01; o += 3) {
      const [x, y, z] = P(S(-1), o, 0.3);
      L.add(x, y, z, LC.green, 0.7, 0, 0, out[0], out[1]);
      if (Math.abs(o) <= hw) { const q = P(S(1), o, 0.3); L.add(q[0], q[1], q[2], LC.red, 0.6, 0, 0, -out[0], -out[1]); }
    }
    if (!approach) continue;
    // 接地带灯
    for (let d = 60; d <= 900; d += 60) for (const sd of [-1, 1]) for (const o of [9, 10.5, 12]) {
      const [x, y, z] = P(S(d), sd * o, 0.1);
      L.add(x, y, z, LC.white, 0.35, 0, 0, out[0], out[1]);
    }
    // PAPI（左侧，距入口 350 m）：外侧两盏白、内侧两盏红
    for (let k = 0; k < 4; k++) {
      const [x, y, z] = P(S(350), -sgn * (hw + 15 + k * 9), 0.9);
      L.add(x, y, z, k >= 2 ? LC.white : LC.red, 1.1, 0, 0, out[0], out[1]);
    }
    // 进近灯光系统（Ⅰ类 900 m 中线排灯 + 5 道横排灯 + 顺序闪光灯）
    for (let d = 30; d <= 900; d += 30) {
      for (let k = -2; k <= 2; k++) {
        const [x, y, z] = P(S(-d), k * 1.05, 0.8 + d * 0.004);
        L.add(x, y, z, LC.white, 0.8, 0, 0, out[0], out[1]);
      }
      if (d >= 300) {
        const [x, y, z] = P(S(-d), 0, 1.8 + d * 0.004);
        L.add(x, y, z, LC.strobe, 1.4, 1, ((900 - d) / 600) * 0.45, out[0], out[1]);
      }
      if (d <= 270) for (const sd of [-1, 1]) for (let k = 0; k < 3; k++) {
        const [x, y, z] = P(S(-d), sd * (9 + k * 1.5), 0.8);
        L.add(x, y, z, LC.red, 0.7, 0, 0, out[0], out[1]);
      }
    }
    for (const [d, half] of [[150, 9], [300, 15], [450, 18], [600, 21], [750, 24]]) {
      for (let o = -half; o <= half + 0.01; o += 2.7) {
        if (Math.abs(o) < 3) continue;
        const [x, y, z] = P(S(-d), o, 0.8 + d * 0.004);
        L.add(x, y, z, LC.white, 0.8, 0, 0, out[0], out[1]);
      }
    }
  }
}
