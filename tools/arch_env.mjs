// 无浏览器环境下构建古建模块几何（供 tools/check_arch_clip.mjs 使用）。
// 做法：给 Node 打最小 DOM/Canvas 桩（纹理全部是空白画布，几何不受影响），用真实 DEM（public/data/dem_*.png，自带 PNG 解码）
// 与真实 Terrain/Exclusions 类，按 src/modules/index.js 的顺序跑指定模块的 prepare → build，返回 scene 与 ctx。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ───────────── DOM / Canvas 桩 ─────────────
function fake2d(canvas) {
  const img = (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
  const grad = { addColorStop() {} };
  const target = {
    canvas,
    getImageData: (x, y, w, h) => img(w, h),
    createImageData: (w, h) => (typeof w === 'object' ? img(w.width, w.height) : img(w, h)),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createConicGradient: () => grad,
    createPattern: () => ({}),
    measureText: (t) => ({ width: String(t).length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return () => undefined; // fillRect/drawImage/…：全部空操作
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
}
function fakeCanvas(w = 1, h = 1) {
  const c = { width: w, height: h, style: {}, addEventListener() {}, toDataURL: () => '' };
  c.getContext = () => (c._g ||= fake2d(c));
  return c;
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : { style: {}, appendChild() {}, setAttribute() {} }),
    createElementNS: () => fakeCanvas(),
    body: { appendChild() {} },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      return fakeCanvas(w, h);
    }
  };
  globalThis.Image = class {
    constructor() {
      this.width = 1;
      this.height = 1;
    }
  };
}

// ───────────── PNG（8 位 RGB/RGBA，非隔行）解码 ─────────────
export function decodePNG(buf) {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      ct = d[9];
      if (d[8] !== 8 || d[12] !== 0) throw new Error('只支持 8 位非隔行 PNG');
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 0;
  if (!bpp) throw new Error('不支持的 PNG 颜色类型 ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (bpp === 1) out[o] = out[o + 1] = out[o + 2] = cur[x];
      else for (let k = 0; k < 3; k++) out[o + k] = cur[x * bpp + k];
      out[o + 3] = bpp === 4 ? cur[x * 4 + 3] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, px: out };
}

// 与 src/core/terrain.js 的 DEM 类相同的采样（双线性、像素中心对齐）
class DEM {
  constructor(hts, w, h, b) {
    Object.assign(this, { hts, w, h, b });
    this.sx = w / (b.x1 - b.x0);
    this.sz = h / (b.z1 - b.z0);
    this.mpp = (b.x1 - b.x0) / w;
  }
  contains(x, z, m = 0) {
    const b = this.b;
    return x >= b.x0 + m && x <= b.x1 - m && z >= b.z0 + m && z <= b.z1 - m;
  }
  sample(x, z) {
    let fx = (x - this.b.x0) * this.sx - 0.5, fz = (z - this.b.z0) * this.sz - 0.5;
    const w = this.w, h = this.h;
    fx = Math.min(Math.max(fx, 0), w - 1.001);
    fz = Math.min(Math.max(fz, 0), h - 1.001);
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, i = iz * w + ix;
    const a = this.hts[i], b = this.hts[i + 1], c = this.hts[i + w], d = this.hts[i + w + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }
  edgeDist(x, z) {
    const b = this.b;
    return Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z);
  }
}

/** fetch 桩：data/xxx → public/data/xxx */
globalThis.fetch = async (url) => {
  const name = String(url).replace(/^.*?data\//, '');
  const f = path.join(ROOT, 'public', 'data', name);
  const ok = fs.existsSync(f);
  const buf = ok ? fs.readFileSync(f) : Buffer.alloc(0);
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: () => (name.endsWith('.json') ? 'application/json' : 'application/octet-stream') },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString('utf8')),
  };
};

/**
 * 构建指定模块，返回 {THREE, scene, ctx, instances}
 * ids：模块 id 列表（按 index.js 顺序执行）
 */
export async function buildModules(ids) {
  const THREE = await import('three');
  const { Terrain } = await import('../src/core/terrain.js');
  const { Exclusions } = await import('../src/core/exclusions.js');
  const { createContext } = await import('../src/core/context.js');
  const { MODULES } = await import('../src/modules/index.js');
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/meta.json'), 'utf8'));
  const terrain = new Terrain();
  terrain.dems = (meta.dem || [])
    .map((d) => {
      const { w, h, px } = decodePNG(fs.readFileSync(path.join(ROOT, 'public/data', d.file)));
      const hts = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) hts[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      return new DEM(hts, w, h, d.bounds);
    })
    .sort((a, b) => a.mpp - b.mpp);
  terrain.ready = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 100000);
  camera.position.set(0, 3000, 0);
  const readJ = (n) => {
    const f = path.join(ROOT, 'public/data', n);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  const data = { landmarks: readJ('landmarks.json'), water: readJ('water.json') };
  const noop = { add() {}, remove() {}, update() {} };
  const ctx = createContext({ renderer: null, scene, camera, terrain, imagery: null, sky: null, lights: noop, labels: noop, exclusions: new Exclusions(), quality: { level: 3 }, data, meta });
  const mods = [];
  for (const m of MODULES) if (ids.includes(m.id)) mods.push((await m.load()).default);
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const mod of mods) if (mod.prepare) await mod.prepare(ctx);
    const instances = {};
    for (const mod of mods) {
      const n0 = scene.children.length;
      instances[mod.id] = (await mod.build(ctx)) || {};
      for (let k = n0; k < scene.children.length; k++) scene.children[k].userData.module = mod.id;
    }
    return { THREE, scene, ctx, instances, terrain };
  } finally {
    console.warn = warn;
  }
}
