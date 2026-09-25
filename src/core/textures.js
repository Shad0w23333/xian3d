// 程序化纹理（Canvas 生成，无外部素材）：砖、瓦、沥青、混凝土、石材、木纹、窗棂、彩画、文字招牌
import * as THREE from 'three';

const cache = new Map();

export function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 可复现随机数 */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e9) / 1e9;
  };
}

function toTex(c, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** 由灰度高度图生成法线贴图 */
export function heightToNormal(hc, strength = 2) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h);
  const g = out.getContext('2d');
  const img = g.createImageData(w, h);
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (dy / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return out;
}

function noiseFill(g, w, h, r, amp, base = 128) {
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * amp;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, k);
  return '#' + c.getHexString();
}

/**
 * 砖墙：返回 {map, normalMap, roughnessMap}，一个重复单元约 cols×rows 块砖。
 * 西安城墙砖约 0.48×0.12 m（含灰缝）。
 */
export function brick({ color = '#8a8276', mortar = '#b3ab9c', cols = 4, rows = 8, size = 512, seed = 7, variance = 0.1, key } = {}) {
  const k = key || `brick:${color}:${mortar}:${cols}:${rows}:${seed}`;
  if (cache.has(k)) return cache.get(k);
  const r = rng(seed);
  const c = canvas(size), hc = canvas(size);
  const g = c.getContext('2d'), hg = hc.getContext('2d');
  g.fillStyle = mortar;
  g.fillRect(0, 0, size, size);
  hg.fillStyle = '#303030';
  hg.fillRect(0, 0, size, size);
  const bw = size / cols, bh = size / rows, m = Math.max(1.5, bh * 0.1);
  for (let y = 0; y < rows; y++)
    for (let x = -1; x < cols + 1; x++) {
      const off = y % 2 ? bw / 2 : 0;
      const px = x * bw + off, py = y * bh;
      g.fillStyle = shade(color, (r() - 0.5) * variance);
      g.fillRect(px + m / 2, py + m / 2, bw - m, bh - m);
      hg.fillStyle = `rgb(${200 + r() * 40 | 0},0,0)`;
      hg.fillStyle = '#' + ((200 + r() * 40) | 0).toString(16).repeat(3);
      hg.fillRect(px + m / 2, py + m / 2, bw - m, bh - m);
    }
  noiseFill(g, size, size, r, 26);
  noiseFill(hg, size, size, r, 30);
  // 风化污渍
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(40,35,30,${r() * 0.07})`;
    g.beginPath();
    g.ellipse(r() * size, r() * size, r() * size * 0.2, r() * size * 0.08, 0, 0, Math.PI * 2);
    g.fill();
  }
  const res = { map: toTex(c), normalMap: toTex(heightToNormal(hc, 3), { srgb: false }), roughnessMap: null };
  cache.set(k, res);
  return res;
}

/** 筒瓦屋面：沿 V 方向的瓦垄，U 方向重复 */
export function roofTiles({ color = '#4b4d50', size = 256, rows = 8, seed = 3, glazed = false } = {}) {
  const k = `roof:${color}:${rows}:${glazed}`;
  if (cache.has(k)) return cache.get(k);
  const r = rng(seed);
  const c = canvas(size), hc = canvas(size);
  const g = c.getContext('2d'), hg = hc.getContext('2d');
  const cw = size / rows;
  for (let i = 0; i < rows; i++) {
    const x = i * cw;
    // 底瓦（凹）
    const grd = hg.createLinearGradient(x, 0, x + cw, 0);
    grd.addColorStop(0, '#606060');
    grd.addColorStop(0.3, '#303030');
    grd.addColorStop(0.5, '#a0a0a0');
    grd.addColorStop(0.7, '#e8e8e8');
    grd.addColorStop(0.85, '#a0a0a0');
    grd.addColorStop(1, '#606060');
    hg.fillStyle = grd;
    hg.fillRect(x, 0, cw, size);
    const cg = g.createLinearGradient(x, 0, x + cw, 0);
    cg.addColorStop(0, shade(color, -0.1));
    cg.addColorStop(0.5, shade(color, -0.04));
    cg.addColorStop(0.72, shade(color, glazed ? 0.12 : 0.06));
    cg.addColorStop(1, shade(color, -0.1));
    g.fillStyle = cg;
    g.fillRect(x, 0, cw, size);
  }
  // 瓦片横向接缝
  for (let y = 0; y < size; y += size / 8) {
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(0, y, size, 2);
    hg.fillStyle = 'rgba(0,0,0,0.5)';
    hg.fillRect(0, y, size, 2);
  }
  noiseFill(g, size, size, r, glazed ? 10 : 22);
  const res = { map: toTex(c), normalMap: toTex(heightToNormal(hc, 4), { srgb: false }) };
  cache.set(k, res);
  return res;
}

/** 通用颗粒表面（混凝土/石材/沥青/涂料） */
export function grain({ color = '#9a958c', amp = 30, size = 256, seed = 11, spots = 30, spotColor = 'rgba(0,0,0,0.05)', joints = 0 } = {}) {
  const k = `grain:${color}:${amp}:${seed}:${spots}:${joints}`;
  if (cache.has(k)) return cache.get(k);
  const r = rng(seed);
  const c = canvas(size), hc = canvas(size);
  const g = c.getContext('2d'), hg = hc.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  hg.fillStyle = '#808080';
  hg.fillRect(0, 0, size, size);
  for (let i = 0; i < spots; i++) {
    g.fillStyle = spotColor;
    g.beginPath();
    g.arc(r() * size, r() * size, r() * size * 0.12, 0, Math.PI * 2);
    g.fill();
  }
  if (joints) {
    const s = size / joints;
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    hg.strokeStyle = '#303030';
    g.lineWidth = hg.lineWidth = 2;
    for (let i = 0; i <= joints; i++) {
      for (const cx of [g, hg]) {
        cx.beginPath();
        cx.moveTo(i * s, 0);
        cx.lineTo(i * s, size);
        cx.moveTo(0, i * s);
        cx.lineTo(size, i * s);
        cx.stroke();
      }
    }
  }
  noiseFill(g, size, size, r, amp);
  noiseFill(hg, size, size, r, 80);
  const res = { map: toTex(c), normalMap: toTex(heightToNormal(hc, 1.2), { srgb: false }) };
  cache.set(k, res);
  return res;
}

/** 木纹 */
export function wood({ color = '#6b3a22', size = 256, seed = 5 } = {}) {
  const k = `wood:${color}`;
  if (cache.has(k)) return cache.get(k);
  const r = rng(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    g.strokeStyle = `rgba(${r() > 0.5 ? '255,220,180' : '20,10,5'},${r() * 0.08})`;
    g.lineWidth = 1 + r() * 2;
    g.beginPath();
    const y = r() * size;
    g.moveTo(0, y);
    for (let x = 0; x <= size; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 3);
    g.stroke();
  }
  noiseFill(g, size, size, r, 12);
  const res = { map: toTex(c) };
  cache.set(k, res);
  return res;
}

/** 窗棂（格心）：返回 {map, alphaMap}，type: grid(方格) | diamond(菱花) | vertical(直棂) */
export function lattice({ type = 'grid', color = '#7a2a1c', size = 256, cells = 8 } = {}) {
  const k = `lattice:${type}:${color}:${cells}`;
  if (cache.has(k)) return cache.get(k);
  const c = canvas(size), a = canvas(size);
  const g = c.getContext('2d'), ag = a.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  ag.fillStyle = '#000';
  ag.fillRect(0, 0, size, size);
  ag.strokeStyle = '#fff';
  const s = size / cells;
  ag.lineWidth = s * 0.22;
  ag.beginPath();
  if (type === 'grid') {
    for (let i = 0; i <= cells; i++) {
      ag.moveTo(i * s, 0); ag.lineTo(i * s, size);
      ag.moveTo(0, i * s); ag.lineTo(size, i * s);
    }
  } else if (type === 'diamond') {
    for (let i = -cells; i <= cells * 2; i++) {
      ag.moveTo(i * s, 0); ag.lineTo(i * s + size, size);
      ag.moveTo(i * s, size); ag.lineTo(i * s + size, 0);
    }
  } else {
    for (let i = 0; i <= cells; i++) { ag.moveTo(i * s, 0); ag.lineTo(i * s, size); }
    ag.moveTo(0, 0); ag.lineTo(size, 0); ag.moveTo(0, size); ag.lineTo(size, size);
  }
  ag.stroke();
  ag.lineWidth = size * 0.06;
  ag.strokeRect(0, 0, size, size);
  const res = { map: toTex(c), alphaMap: toTex(a, { srgb: false }) };
  cache.set(k, res);
  return res;
}

/** 彩画（旋子彩画风格的梁枋色带），U 方向重复 */
export function caihua({ size = 512, seed = 9, base = '#1f4f5a', band = '#2d6e4e', accent = '#d8b04a' } = {}) {
  const k = `caihua:${base}:${band}`;
  if (cache.has(k)) return cache.get(k);
  const r = rng(seed);
  const c = canvas(size, size / 4);
  const g = c.getContext('2d');
  const W = size, H = size / 4;
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  // 箍头 + 找头 + 枋心
  g.fillStyle = band;
  g.fillRect(0, 0, W * 0.12, H);
  g.fillRect(W * 0.88, 0, W * 0.12, H);
  g.fillStyle = shade(base, 0.08);
  g.beginPath();
  g.moveTo(W * 0.3, H * 0.15); g.lineTo(W * 0.7, H * 0.15); g.lineTo(W * 0.78, H * 0.5); g.lineTo(W * 0.7, H * 0.85); g.lineTo(W * 0.3, H * 0.85); g.lineTo(W * 0.22, H * 0.5); g.closePath();
  g.fill();
  g.strokeStyle = accent;
  g.lineWidth = 3;
  g.stroke();
  // 旋花
  for (const cx of [W * 0.17, W * 0.83]) {
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.strokeStyle = i % 2 ? '#e8e2cf' : accent;
      g.arc(cx, H / 2, H * (0.38 - i * 0.1), 0, Math.PI * 2);
      g.stroke();
    }
  }
  g.fillStyle = accent;
  for (let i = 0; i < 20; i++) g.fillRect(W * 0.3 + r() * W * 0.4, H * 0.3 + r() * H * 0.4, 3, 3);
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.fillRect(0, 0, W, 2);
  g.fillRect(0, H - 2, W, 2);
  const res = { map: toTex(c) };
  cache.set(k, res);
  return res;
}

/**
 * 文字贴图（招牌、匾额、标语）。返回 {texture, aspect, canvas}
 * opts: font(字体族) weight size color bg(背景色或 null) border(边框色) padding vertical(竖排) glow(发光色) stroke
 */
export function text(str, opts = {}) {
  const {
    font = '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif',
    weight = 700,
    size = 96,
    color = '#ffffff',
    bg = null,
    border = null,
    borderWidth = 0.06,
    padding = 0.35,
    vertical = false,
    glow = null,
    stroke = null,
    letterSpacing = 0.08,
    serif = false,
  } = opts;
  const fam = serif ? '"Songti SC","STSong","Noto Serif CJK SC","SimSun",serif' : font;
  const k = `text:${str}:${JSON.stringify(opts)}`;
  if (cache.has(k)) return cache.get(k);
  const chars = [...str];
  const probe = canvas(8).getContext('2d');
  probe.font = `${weight} ${size}px ${fam}`;
  const cw = chars.map((ch) => probe.measureText(ch).width);
  const pad = size * padding;
  const gap = size * letterSpacing;
  let W, H;
  if (vertical) {
    W = size + pad * 2;
    H = chars.length * (size + gap) - gap + pad * 2;
  } else {
    W = cw.reduce((a, b) => a + b, 0) + gap * (chars.length - 1) + pad * 2;
    H = size * 1.18 + pad * 2;
  }
  const scale = Math.min(1, 4096 / Math.max(W, H));
  const c = canvas(Math.ceil(W * scale), Math.ceil(H * scale));
  const g = c.getContext('2d');
  g.scale(scale, scale);
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
  }
  if (border) {
    g.strokeStyle = border;
    g.lineWidth = size * borderWidth;
    g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, W - g.lineWidth, H - g.lineWidth);
    g.lineWidth = size * borderWidth * 0.4;
    const ins = size * borderWidth * 1.8;
    g.strokeRect(ins, ins, W - ins * 2, H - ins * 2);
  }
  g.font = `${weight} ${size}px ${fam}`;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  if (glow) {
    g.shadowColor = glow;
    g.shadowBlur = size * 0.25;
  }
  let x = pad, y = pad;
  chars.forEach((ch, i) => {
    let px, py;
    if (vertical) {
      px = W / 2;
      py = y + size / 2;
      y += size + gap;
    } else {
      px = x + cw[i] / 2;
      py = H / 2 + size * 0.04;
      x += cw[i] + gap;
    }
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = size * 0.08;
      g.strokeText(ch, px, py);
    }
    g.fillStyle = color;
    g.fillText(ch, px, py);
  });
  const t = toTex(c, { repeat: false });
  const res = { texture: t, aspect: W / H, canvas: c };
  cache.set(k, res);
  return res;
}
