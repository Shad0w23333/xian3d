// 数据加载：优先读取单文件版内嵌数据（window.__XIAN3D_EMBED__），否则 fetch public/data/*
const BASE = (import.meta.env && import.meta.env.BASE_URL ? import.meta.env.BASE_URL : './') + 'data/';

const listeners = new Set();
const progress = { total: 0, done: 0, current: '' };

export function onProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn({ ...progress });
}

function embedded(name) {
  const e = typeof window !== 'undefined' && window.__XIAN3D_EMBED__;
  return e && e[name] ? e[name] : null;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function track(name, fn) {
  progress.total++;
  progress.current = name;
  emit();
  try {
    return await fn();
  } finally {
    progress.done++;
    emit();
  }
}

// 高德覆盖：tools/amap_fetch.py merge 把高德衍生数据写到 public/data/local/（私有仓库，个人本地使用）。
// 这些文件存在时优先读取，否则用 public/data 下的 OSM 版本。
const LOCAL_OVERRIDE = new Set(['pois.json', 'roads.json', 'rail.json', 'amap_extra.json']);
async function fetchData(name) {
  if (LOCAL_OVERRIDE.has(name)) {
    try {
      const r = await fetch(BASE + 'local/' + name);
      if (r.ok && !(r.headers.get('content-type') || '').includes('text/html')) {
        console.info('[data] 使用本地高德数据', 'local/' + name);
        return r;
      }
    } catch (e) { /* 没有本地覆盖 */ }
  }
  return fetch(BASE + name);
}

/** 读取原始字节（自动处理 gzip） */
export async function loadBytes(name, { optional = false } = {}) {
  return track(name, async () => {
    let bytes;
    const emb = embedded(name);
    if (emb) {
      bytes = b64ToBytes(emb);
    } else {
      const res = await fetchData(name);
      // 开发服务器对缺失文件会回退 index.html
      const html = (res.headers.get('content-type') || '').includes('text/html') && !name.endsWith('.html');
      if (!res.ok || html) {
        if (optional) return null;
        throw new Error(`加载 ${name} 失败：HTTP ${res.status}`);
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b && 'DecompressionStream' in window) {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return bytes;
  }).catch((e) => {
    if (optional) {
      console.warn('[data] 可选文件缺失：', name, e.message);
      return null;
    }
    throw e;
  });
}

export async function loadJSON(name, opts = {}) {
  const bytes = await loadBytes(name, opts);
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function loadBinary(name, opts = {}) {
  const bytes = await loadBytes(name, opts);
  return bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null;
}

/**
 * 读取图像为 ImageBitmap（已上下翻转，配合 texture.flipY=false 使用，等价于常规 flipY=true）。
 * flip=false 时得到未翻转位图（用于 DEM 像素读取）。
 */
export async function loadImageBitmap(name, { optional = false, flip = true } = {}) {
  return track(name, async () => {
    let blob;
    const emb = embedded(name);
    if (emb) {
      const mime = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
      blob = new Blob([b64ToBytes(emb)], { type: mime });
    } else {
      const res = await fetch(BASE + name);
      if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) throw new Error(`加载 ${name} 失败：HTTP ${res.status}`);
      blob = await res.blob();
    }
    return createImageBitmap(blob, {
      imageOrientation: flip ? 'flipY' : 'none',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
  }).catch((e) => {
    if (optional) {
      console.warn('[data] 可选图像缺失：', name, e.message);
      return null;
    }
    throw e;
  });
}

/** 读取 ImageBitmap 的原始 RGBA 像素 */
export function bitmapPixels(bmp) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height).data;
}
