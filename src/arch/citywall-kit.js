// 西安明城墙专用构件：城砖/海墁/条石程序化纹理、带夜间泛光与宏观风化的墙体材质、
// 墙体截面扫掠缓冲（MeshBuf）、垛口/轮廓灯实例几何、屏幕空间恒宽轮廓灯线。
// 仅供 src/modules/citywall.js 使用。单位米，UV 以米计（材质内部换算平铺尺寸）。
import * as THREE from 'three';

// ───────────── 程序化纹理 ─────────────
function cnv(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function toTex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
function heightToNormal(hc0, strength = 2.5) {
  // 法线图降到 512 计算（构建时间 ÷4）
  let hc = hc0;
  if (hc0.width > 512) {
    hc = cnv(512, 512);
    hc.getContext('2d').drawImage(hc0, 0, 0, 512, 512);
    strength *= 0.5;
  }
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = cnv(w, h);
  const og = out.getContext('2d');
  const img = og.createImageData(w, h);
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((dy / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  og.putImageData(img, 0, 0);
  return out;
}
function speckle(g, S, r, n, a) {
  for (let i = 0; i < n; i++) {
    const v = (r() * 255) | 0;
    g.fillStyle = `rgba(${v},${v},${v},${a * r()})`;
    g.fillRect(r() * S, r() * S, 1 + r() * 2.5, 1 + r() * 2.5);
  }
}

/**
 * 城砖立面：明代城砖约 0.48×0.24×0.12 m，顺砌错缝；1024 px = 2.4 m（20 皮 × 5 块）。
 * 颜色：青灰为主，夹杂旧砖（偏黄褐）与修补新砖（偏青），灰缝白灰。
 */
const TEX = new Map();
export function wallBrickTex() {
  if (TEX.has('brick')) return TEX.get('brick');
  const S = 1024, rows = 20, cols = 5;
  const c = cnv(S), hc = cnv(S);
  const g = c.getContext('2d'), hg = hc.getContext('2d');
  const r = rng(1378);
  g.fillStyle = '#9d988d';
  g.fillRect(0, 0, S, S);
  hg.fillStyle = '#3a3a3a';
  hg.fillRect(0, 0, S, S);
  const bh = S / rows, bw = S / cols, m = 5;
  for (let y = 0; y < rows; y++) {
    const off = (y % 2) * bw * 0.5 + (r() - 0.5) * 6;
    for (let x = -1; x <= cols; x++) {
      const x0 = x * bw + off + m / 2 + (r() - 0.5) * 3, w = bw - m + (r() - 0.5) * 6;
      const t = r();
      let R, G, B;
      if (t < 0.12) [R, G, B] = [128, 120, 106]; // 旧砖偏黄褐
      else if (t < 0.24) [R, G, B] = [104, 108, 108]; // 修补新砖偏青
      else [R, G, B] = [118, 115, 108];
      const k = 0.86 + r() * 0.24;
      g.fillStyle = `rgb(${(R * k) | 0},${(G * k) | 0},${(B * k) | 0})`;
      g.fillRect(x0, y * bh + m / 2, w, bh - m);
      // 砖面微起伏 + 缺角
      const hv = (175 + r() * 60) | 0;
      hg.fillStyle = `rgb(${hv},${hv},${hv})`;
      hg.fillRect(x0 + 1, y * bh + m / 2 + 1, w - 2, bh - m - 2);
      if (r() < 0.25) {
        hg.fillStyle = '#707070';
        const cx = r() < 0.5 ? x0 : x0 + w - 8;
        hg.fillRect(cx, y * bh + m / 2 + (r() < 0.5 ? 0 : bh - m - 7), 8 + r() * 8, 6);
      }
    }
  }
  speckle(g, S, r, 9000, 0.12);
  speckle(hg, S, r, 12000, 0.35);
  // 泛碱/水渍
  for (let i = 0; i < 26; i++) {
    g.fillStyle = r() < 0.5 ? `rgba(215,210,198,${0.05 + r() * 0.07})` : `rgba(40,38,34,${0.04 + r() * 0.06})`;
    g.beginPath();
    g.ellipse(r() * S, r() * S, 30 + r() * 160, 10 + r() * 50, 0, 0, Math.PI * 2);
    g.fill();
  }
  const res = { map: toTex(c), normalMap: toTex(heightToNormal(hc, 3.2), false), size: 2.4 };
  TEX.set('brick', res);
  return res;
}

/** 墙顶海墁：方砖 0.45 m 对缝铺，1024 px = 2.7 m（6×6） */
export function pavingTex() {
  if (TEX.has('pave')) return TEX.get('pave');
  const S = 1024, n = 6;
  const c = cnv(S), hc = cnv(S);
  const g = c.getContext('2d'), hg = hc.getContext('2d');
  const r = rng(91);
  g.fillStyle = '#8c887e';
  g.fillRect(0, 0, S, S);
  hg.fillStyle = '#404040';
  hg.fillRect(0, 0, S, S);
  const b = S / n, m = 4;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const k = 0.84 + r() * 0.26;
      const warm = r() < 0.2 ? 8 : 0;
      g.fillStyle = `rgb(${((122 + warm) * k) | 0},${((119 + warm * 0.6) * k) | 0},${(112 * k) | 0})`;
      g.fillRect(x * b + m / 2, y * b + m / 2, b - m, b - m);
      const hv = (190 + r() * 40) | 0;
      hg.fillStyle = `rgb(${hv},${hv},${hv})`;
      hg.fillRect(x * b + m / 2 + 1, y * b + m / 2 + 1, b - m - 2, b - m - 2);
    }
  speckle(g, S, r, 12000, 0.1);
  speckle(hg, S, r, 8000, 0.25);
  for (let i = 0; i < 18; i++) {
    g.fillStyle = `rgba(50,46,40,${0.04 + r() * 0.06})`;
    g.beginPath();
    g.ellipse(r() * S, r() * S, 40 + r() * 200, 20 + r() * 80, r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  const res = { map: toTex(c), normalMap: toTex(heightToNormal(hc, 2.2), false), size: 2.7 };
  TEX.set('pave', res);
  return res;
}

/** 条石（土衬石/驳岸）：0.45 m 一皮，块长 0.8~1.4 m，1024 px = 3.6 m */
export function stoneTex() {
  if (TEX.has('stone')) return TEX.get('stone');
  const S = 1024, rows = 8;
  const c = cnv(S), hc = cnv(S);
  const g = c.getContext('2d'), hg = hc.getContext('2d');
  const r = rng(7);
  g.fillStyle = '#8f8a80';
  g.fillRect(0, 0, S, S);
  hg.fillStyle = '#404040';
  hg.fillRect(0, 0, S, S);
  const bh = S / rows, m = 5;
  for (let y = 0; y < rows; y++) {
    let x = -r() * 200;
    while (x < S) {
      const w = S * (0.22 + r() * 0.17);
      const k = 0.85 + r() * 0.2;
      g.fillStyle = `rgb(${(160 * k) | 0},${(154 * k) | 0},${(143 * k) | 0})`;
      g.fillRect(x + m / 2, y * bh + m / 2, w - m, bh - m);
      const hv = (180 + r() * 50) | 0;
      hg.fillStyle = `rgb(${hv},${hv},${hv})`;
      hg.fillRect(x + m / 2 + 2, y * bh + m / 2 + 2, w - m - 4, bh - m - 4);
      if (x + w > S) {
        g.fillRect(x - S + m / 2, y * bh + m / 2, w - m, bh - m);
        hg.fillRect(x - S + m / 2 + 2, y * bh + m / 2 + 2, w - m - 4, bh - m - 4);
      }
      x += w;
    }
  }
  speckle(g, S, r, 14000, 0.14);
  speckle(hg, S, r, 16000, 0.4);
  const res = { map: toTex(c), normalMap: toTex(heightToNormal(hc, 2.6), false), size: 3.6 };
  TEX.set('stone', res);
  return res;
}

// ───────────── 材质 ─────────────
const NOISE_GLSL = `
float cwHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cwNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cwHash(i), cwHash(i + vec2(1.0, 0.0)), f.x), mix(cwHash(i + vec2(0.0, 1.0)), cwHash(i + vec2(1.0, 1.0)), f.x), f.y); }`;

/**
 * 城墙材质（kind: 'brick' | 'pave' | 'stone'）。几何需带属性 aH = (离墙脚高度 m, 泛光系数 0..1)。
 * 片元：按世界坐标的大尺度斑驳 + 顶部雨水垂痕 + 墙脚潮湿；夜间 emissive = 反照率 × 暖光 × 泛光系数。
 */
export function wallMaterial(ctx, kind = 'brick', o = {}) {
  const t = kind === 'pave' ? pavingTex() : kind === 'stone' ? stoneTex() : wallBrickTex();
  const rep = (tx) => {
    const c = tx.clone();
    c.repeat.set(1 / t.size, 1 / t.size);
    c.needsUpdate = true;
    return c;
  };
  const m = new THREE.MeshStandardMaterial({
    map: rep(t.map),
    normalMap: rep(t.normalMap),
    normalScale: new THREE.Vector2(o.normal ?? 1.0, o.normal ?? 1.0),
    roughness: kind === 'stone' ? 0.8 : 0.93,
    metalness: 0,
    color: o.color ?? 0xffffff,
  });
  m.name = 'citywall.' + kind;
  const floodK = o.flood ?? (kind === 'brick' ? 2.4 : kind === 'pave' ? 0.5 : 1.2);
  const streakK = kind === 'brick' ? 0.24 : 0.0;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.uniforms.uCwFlood = { value: new THREE.Color(o.floodColor ?? 0xffa650) };
    sh.uniforms.uCwFloodK = { value: floodK };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aH;\nvarying vec2 vCwH;\nvarying vec3 vCwW;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vCwH = aH;
        {
          vec4 cwP = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            cwP = instanceMatrix * cwP;
          #endif
          vCwW = (modelMatrix * cwP).xyz;
        }`
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uNight; uniform vec3 uCwFlood; uniform float uCwFloodK;\nvarying vec2 vCwH; varying vec3 vCwW;\n${NOISE_GLSL}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec2 q = vec2(vCwW.x + vCwW.z, vCwW.y);
          float big = cwNoise(q * vec2(0.031, 0.07)) * 0.6 + cwNoise(q * vec2(0.17, 0.23)) * 0.4;
          float st = cwNoise(vec2(q.x * 1.7, q.y * 0.04)) * cwNoise(vec2(q.x * 0.35, 3.1));
          float hasH = step(0.001, vCwH.y);
          float streak = st * smoothstep(4.0, 11.8, vCwH.x) * hasH;
          float damp = 1.0 - 0.18 * (1.0 - smoothstep(0.0, 1.8, vCwH.x)) * hasH;
          diffuseColor.rgb *= (0.86 + 0.28 * big) * (1.0 - ${streakK.toFixed(3)} * streak) * damp;
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * uCwFlood * (uNight * uCwFloodK * vCwH.y);`
      );
  };
  m.customProgramCacheKey = () => 'citywall-' + kind + floodK;
  return m;
}

// ───────────── 几何缓冲 ─────────────
/** 四边形累加器：位置/法线/UV/aH（高度、泛光），平面法线，按期望朝向自动定绕序 */
export class MeshBuf {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.h = [];
    this.i = [];
    this.c = 0;
  }
  /** a,b,c,d：[x,y,z]；uvs：4×[u,v]；hs：4×[h,flood] 或单个 [h,flood]；E：期望法线方向 */
  quad(a, b, c, d, uvs, hs, E) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const flip = E && nx * E[0] + ny * E[1] + nz * E[2] < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const base = this.c;
    const V = [a, b, c, d];
    const single = hs && !Array.isArray(hs[0]);
    for (let k = 0; k < 4; k++) {
      this.p.push(V[k][0], V[k][1], V[k][2]);
      this.n.push(nx, ny, nz);
      this.uv.push(uvs[k][0], uvs[k][1]);
      const hh = !hs ? [0, 0] : single ? hs : hs[k];
      this.h.push(hh[0], hh[1]);
    }
    this.c += 4;
    if (flip) this.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(a, b, c, uvs, hs, E) {
    this.quad(a, b, c, c, [uvs[0], uvs[1], uvs[2], uvs[2]], hs, E);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aH', new THREE.Float32BufferAttribute(this.h, 2));
    g.setIndex(this.c > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** 局部盒子（x 沿墙、y 上、z 向外），写入 MeshBuf（UV 以米计），用于实例几何原型 */
function boxInto(buf, x0, y0, z0, x1, y1, z1, hBase = 0, flood = 0.3, skipBottom = true) {
  const H = (y) => [y + hBase, flood];
  const P = (x, y, z) => [x, y, z];
  buf.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], [H(y0), H(y0), H(y1), H(y1)], [0, 0, 1]);
  buf.quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), [[-x1, y0], [-x0, y0], [-x0, y1], [-x1, y1]], [H(y0), H(y0), H(y1), H(y1)], [0, 0, -1]);
  buf.quad(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), [[-z1, y0], [-z0, y0], [-z0, y1], [-z1, y1]], [H(y0), H(y0), H(y1), H(y1)], [1, 0, 0]);
  buf.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), [[z0, y0], [z1, y0], [z1, y1], [z0, y1]], [H(y0), H(y0), H(y1), H(y1)], [-1, 0, 0]);
  buf.quad(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), [[x0, z1], [x1, z1], [x1, z0], [x0, z0]], H(y1), [0, 1, 0]);
  if (!skipBottom) buf.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], H(y0), [0, -1, 0]);
}

/**
 * 垛（实例原型）：原点 = 垛墙（下段矮墙）顶面中心；x 沿墙、z 向外。
 * 宽 w、高 h、厚 t；顶面略带压顶（外挑 3 cm 的薄砖檐）。
 */
export function merlonGeometry(w = 1.8, h = 0.72, t = 0.62) {
  const b = new MeshBuf();
  boxInto(b, -w / 2, 0, -t / 2, w / 2, h - 0.08, t / 2, 13.25, 0.42);
  boxInto(b, -w / 2 - 0.03, h - 0.08, -t / 2 - 0.03, w / 2 + 0.03, h, t / 2 + 0.03, 13.25, 0.3);
  return b.geometry();
}

/** 垛口轮廓灯（实例原型，与垛同矩阵）：外立面上沿垛的左、上、右边及右侧垛口底边的发光灯条 */
export function merlonLedGeometry(w = 1.8, h = 0.72, t = 0.62, gap = 0.5, s = 0.05) {
  // 只做朝外的发光面片（每条 2 三角），省三角
  const z = t / 2 + 0.03;
  const pos = [], nor = [], idx = [];
  const add = (x0, y0, x1, y1) => {
    const b = pos.length / 3;
    pos.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
    nor.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  add(-w / 2 - s / 2, 0, -w / 2 + s / 2, h + s / 2);
  add(-w / 2, h - s / 2 + 0.01, w / 2, h + s / 2 + 0.01);
  add(w / 2 - s / 2, 0, w / 2 + s / 2, h + s / 2);
  add(w / 2, -s / 2, w / 2 + gap, s / 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** 灯杆（实例原型）：立于女墙顶，铁杆 + 向外（步道一侧）挑出的弯臂；原点 = 女墙顶，z 指向步道 */
export function lampPostGeometry() {
  const geos = [];
  const box = (sx, sy, sz, x, y, z) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    geos.push(g);
  };
  box(0.34, 0.12, 0.34, 0, 0.06, 0);
  box(0.09, 2.0, 0.09, 0, 1.0, 0);
  box(0.06, 0.06, 0.95, 0, 1.98, 0.45);
  box(0.05, 0.3, 0.05, 0, 1.82, 0.9);
  box(0.16, 0.16, 0.16, 0, 2.08, 0);
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const idx = [];
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (const i of g.index.array) idx.push(i + o);
    o += g.attributes.position.count;
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// ───────────── 远景轮廓灯线（屏幕空间恒宽，叠加混合） ─────────────
/**
 * lines：折线数组（每条为 [[x,y,z],...]）。像素宽由 uPix（半宽/距离）控制；近处（<fadeNear）淡出让位于逐垛灯条。
 */
export function outlineLines(ctx, lines, { color = 0xffb85a, intensity = 2.2, pix = 0.00075, fadeNear = 140, fadeFar = 420 } = {}) {
  const pos = [], tan = [], side = [], idx = [];
  let base = 0;
  for (const L of lines) {
    for (let i = 0; i < L.length; i++) {
      const a = L[Math.max(0, i - 1)], b = L[Math.min(L.length - 1, i + 1)];
      const tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      const l = Math.hypot(tx, ty, tz) || 1;
      for (const s of [-1, 1]) {
        pos.push(L[i][0], L[i][1], L[i][2]);
        tan.push(tx / l, ty / l, tz / l);
        side.push(s);
      }
      if (i) {
        const k = base + (i - 1) * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    base += L.length * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTan', new THREE.Float32BufferAttribute(tan, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(base > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  const c = new THREE.Color(color).multiplyScalar(intensity);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: c }, uNight: ctx.uniforms.uNight, uPix: { value: pix }, uFade: { value: new THREE.Vector2(fadeNear, fadeFar) } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aTan; attribute float aSide;
      uniform float uPix; uniform vec2 uFade;
      varying float vFade;
      void main(){
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 toCam = cameraPosition - wp; float d = length(toCam);
        vec3 sd = cross(aTan, toCam / max(d, 1e-3));
        float sl = length(sd);
        sd = sl > 1e-4 ? sd / sl : vec3(0.0, 1.0, 0.0);
        float w = max(0.05, d * uPix);
        wp += sd * aSide * w;
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vFade = smoothstep(uFade.x, uFade.y, d) * exp(-d / 16000.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor; uniform float uNight;
      varying float vFade;
      void main(){
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(uColor * (uNight * vFade), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.name = '城墙轮廓灯线';
  return mesh;
}
