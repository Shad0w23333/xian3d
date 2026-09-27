// 中式古建构件库 —— 核心：几何累加器（ArchBuilder）、材质/程序化纹理（ArchKit）、夜景泛光、LOD 工具。
// 约定（全库统一）：
//   · 单位米；构件局部坐标原点 = 构件平面中心、地面（或所给基准面）高度；Y 向上。
//   · 正面朝 +Z（西安世界坐标 +Z = 南，古建坐北朝南时无需旋转）；面阔沿 X，进深沿 Z。
//   · 所有几何写入 ArchBuilder，按材质合并；重复构件（斗拱、灯笼、望柱……）可实例化。
//   · 颜色一律走顶点色（sRGB 十六进制），同一材质可承载多种颜色 → 一座殿 ≤ 12 个材质/draw call。
import * as THREE from 'three';

// ───────────────────────────── 小工具 ─────────────────────────────
const _c = new THREE.Color();
const colorCache = new Map();
/** sRGB 十六进制/数组/Color → 线性 [r,g,b]（缓存） */
export function lin(c) {
  if (Array.isArray(c)) return c;
  if (c && c.isColor) return [c.r, c.g, c.b];
  let v = colorCache.get(c);
  if (!v) {
    _c.set(c ?? 0xffffff);
    v = [_c.r, _c.g, _c.b];
    colorCache.set(c, v);
  }
  return v;
}
/** 线性颜色按系数缩放（明暗变化） */
export function shadeLin(c, k) {
  const v = lin(c);
  return [v[0] * k, v[1] * k, v[2] * k];
}
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e9) / 1e9;
  };
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

class F32 {
  constructor(n = 1024) {
    this.a = new Float32Array(n);
    this.n = 0;
  }
  grow(k) {
    if (this.n + k <= this.a.length) return;
    let s = this.a.length * 2;
    while (s < this.n + k) s *= 2;
    const b = new Float32Array(s);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
}
class U32 {
  constructor(n = 1024) {
    this.a = new Uint32Array(n);
    this.n = 0;
  }
  grow(k) {
    if (this.n + k <= this.a.length) return;
    let s = this.a.length * 2;
    while (s < this.n + k) s *= 2;
    const b = new Uint32Array(s);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
}

/** 一种材质的几何累加桶（带索引） */
export class Bucket {
  constructor(key) {
    this.key = key;
    this.p = new F32();
    this.n = new F32();
    this.t = new F32();
    this.c = new F32();
    this.i = new U32();
    this.count = 0;
  }
  get triCount() {
    return this.i.n / 3;
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p.a.slice(0, this.p.n), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.n.a.slice(0, this.n.n), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.t.a.slice(0, this.t.n), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.c.a.slice(0, this.c.n), 3));
    const idx = this.count > 65535 ? this.i.a.slice(0, this.i.n) : Uint16Array.from(this.i.a.subarray(0, this.i.n));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ───────────────────────────── 材质 & 纹理 ─────────────────────────────
function cnv(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function tex(c, { srgb = true, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
function heightToNormal(hc, strength = 2) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = cnv(w, h);
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
function noise(g, w, h, r, amp) {
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * amp;
    img.data[i] = clamp(img.data[i] + n, 0, 255);
    img.data[i + 1] = clamp(img.data[i + 1] + n, 0, 255);
    img.data[i + 2] = clamp(img.data[i + 2] + n, 0, 255);
  }
  g.putImageData(img, 0, 0);
}

/**
 * 瓦面纹理。一个纹理单元 = 横向 2 垄（u 0..1 ↔ 2×瓦垄宽）、纵向 8 行瓦（v 0..1 ↔ 8×瓦长）。
 * 筒瓦中心位于 u=0.25/0.75，板瓦沟位于 u=0/0.5。
 * flat=true：远景用，筒瓦画进贴图 + 强法线；flat=false：近景底瓦（筒瓦用几何）。
 */
function makeTileTextures(flat) {
  const W = 256, H = 512;
  const c = cnv(W, H), hc = cnv(W, H);
  const g = c.getContext('2d'), hg = hc.getContext('2d');
  const r = rng(flat ? 17 : 23);
  // 底色（近白，由顶点色着色）
  g.fillStyle = '#c9c9c9';
  g.fillRect(0, 0, W, H);
  hg.fillStyle = '#808080';
  hg.fillRect(0, 0, W, H);
  const col = W / 2;
  const rows = 8, rh = H / rows;
  for (let k = 0; k < 2; k++) {
    const x0 = k * col - col / 2; // 沟中心在 k*col
    for (let pass = 0; pass < 2; pass++) {
      const ox = x0 + pass * W; // 横向环绕
      // 板瓦沟（凹）：中心亮、两侧暗
      const gr = g.createLinearGradient(ox, 0, ox + col, 0);
      gr.addColorStop(0, '#8d8d8d');
      gr.addColorStop(0.22, '#b4b4b4');
      gr.addColorStop(0.5, '#d0d0d0');
      gr.addColorStop(0.78, '#b4b4b4');
      gr.addColorStop(1, '#8d8d8d');
      g.fillStyle = gr;
      g.fillRect(ox, 0, col, H);
      const hgr = hg.createLinearGradient(ox, 0, ox + col, 0);
      hgr.addColorStop(0, '#9a9a9a');
      hgr.addColorStop(0.5, '#606060');
      hgr.addColorStop(1, '#9a9a9a');
      hg.fillStyle = hgr;
      hg.fillRect(ox, 0, col, H);
    }
  }
  // 板瓦搭接（每行一条阴影线 + 亮边）
  for (let j = 0; j < rows; j++) {
    const y = j * rh;
    for (let k = -1; k < 3; k++) {
      const x = k * col - col / 2 + 3;
      const jitter = (r() - 0.5) * 4;
      g.fillStyle = 'rgba(0,0,0,0.30)';
      g.fillRect(x, y + jitter, col - 6, 4);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(x, y + jitter + 4, col - 6, 3);
      const hgr = hg.createLinearGradient(0, y, 0, y + rh);
      hgr.addColorStop(0, 'rgba(0,0,0,0.35)');
      hgr.addColorStop(0.08, 'rgba(255,255,255,0.10)');
      hgr.addColorStop(1, 'rgba(0,0,0,0.0)');
      hg.fillStyle = hgr;
      hg.fillRect(x, y + jitter, col - 6, rh);
    }
  }
  if (flat) {
    // 筒瓦（凸）画进贴图
    for (let k = 0; k < 2; k++) {
      const cx = k * col + col / 2;
      const tw = col * 0.52;
      const gr = g.createLinearGradient(cx - tw / 2, 0, cx + tw / 2, 0);
      gr.addColorStop(0, '#6a6a6a');
      gr.addColorStop(0.3, '#bdbdbd');
      gr.addColorStop(0.55, '#e2e2e2');
      gr.addColorStop(0.85, '#a0a0a0');
      gr.addColorStop(1, '#5e5e5e');
      g.fillStyle = gr;
      g.fillRect(cx - tw / 2, 0, tw, H);
      const hgr = hg.createLinearGradient(cx - tw / 2, 0, cx + tw / 2, 0);
      hgr.addColorStop(0, '#707070');
      hgr.addColorStop(0.5, '#ffffff');
      hgr.addColorStop(1, '#707070');
      hg.fillStyle = hgr;
      hg.fillRect(cx - tw / 2, 0, tw, H);
      // 筒瓦节（每行一节）
      for (let j = 0; j < rows; j++) {
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(cx - tw / 2, j * rh + rh * 0.5, tw, 3);
      }
    }
  }
  noise(g, W, H, r, 16);
  // 污渍/色差
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},${0.03 + r() * 0.05})`;
    g.fillRect(r() * W, r() * H, 6 + r() * 40, 10 + r() * 60);
  }
  return { map: tex(c), normalMap: tex(heightToNormal(hc, flat ? 5 : 3), { srgb: false }) };
}

/** 彩画图集：1024×512，4 行，每行一种（u 0..1 = 一间枋长；v 行内 0..1 = 枋高） */
function makeCaihuaAtlas() {
  const W = 1024, H = 512, RH = 128;
  const c = cnv(W, H);
  const g = c.getContext('2d');
  const r = rng(91);
  const gold = '#d9b25a', blue = '#1f4e78', green = '#2d6b4f', dk = '#10283a', white = '#ece6d6';
  // 行 0：旋子彩画（明清常用，青绿 + 金线）
  const xuanzi = (y0, rich) => {
    g.fillStyle = blue;
    g.fillRect(0, y0, W, RH);
    // 箍头
    g.fillStyle = green;
    g.fillRect(0, y0, W * 0.05, RH);
    g.fillRect(W * 0.95, y0, W * 0.05, RH);
    g.fillStyle = gold;
    g.fillRect(W * 0.05, y0, 4, RH);
    g.fillRect(W * 0.95 - 4, y0, 4, RH);
    // 找头：旋花
    for (const cx of [W * 0.16, W * 0.84]) {
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.strokeStyle = i === 1 ? white : gold;
        g.lineWidth = i === 1 ? 5 : 4;
        g.arc(cx, y0 + RH / 2, RH * (0.42 - i * 0.13), 0, Math.PI * 2);
        g.stroke();
      }
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        g.beginPath();
        g.fillStyle = k % 2 ? green : white;
        g.ellipse(cx + Math.cos(a) * RH * 0.3, y0 + RH / 2 + Math.sin(a) * RH * 0.3, RH * 0.08, RH * 0.045, a, 0, Math.PI * 2);
        g.fill();
      }
    }
    // 枋心
    g.fillStyle = green;
    g.beginPath();
    g.moveTo(W * 0.32, y0 + RH * 0.14);
    g.lineTo(W * 0.68, y0 + RH * 0.14);
    g.lineTo(W * 0.74, y0 + RH / 2);
    g.lineTo(W * 0.68, y0 + RH * 0.86);
    g.lineTo(W * 0.32, y0 + RH * 0.86);
    g.lineTo(W * 0.26, y0 + RH / 2);
    g.closePath();
    g.fill();
    g.strokeStyle = gold;
    g.lineWidth = 5;
    g.stroke();
    if (rich) {
      // 和玺：枋心内金色龙纹（抽象卷草）
      g.strokeStyle = gold;
      g.lineWidth = 4;
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        const x = W * (0.35 + i * 0.065);
        g.moveTo(x, y0 + RH * 0.7);
        g.bezierCurveTo(x + 20, y0 + RH * 0.2, x + 40, y0 + RH * 0.8, x + 60, y0 + RH * 0.35);
        g.stroke();
      }
    } else {
      g.fillStyle = blue;
      g.fillRect(W * 0.36, y0 + RH * 0.44, W * 0.28, RH * 0.12);
    }
    // 上下金线
    g.fillStyle = gold;
    g.fillRect(0, y0, W, 3);
    g.fillRect(0, y0 + RH - 3, W, 3);
  };
  xuanzi(0, false);
  xuanzi(RH, true);
  // 行 2：唐 七朱八白（土朱底 + 白色长方块）
  {
    const y0 = RH * 2;
    g.fillStyle = '#9a3524';
    g.fillRect(0, y0, W, RH);
    g.fillStyle = '#efe6d0';
    const n = 7;
    const seg = W / (n + 1);
    for (let i = 0; i < n + 1; i++) g.fillRect(i * seg + seg * 0.18, y0 + RH * 0.34, seg * 0.64, RH * 0.32);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, y0, W, 3);
    g.fillRect(0, y0 + RH - 3, W, 3);
  }
  // 行 3：朱红枋 + 金色箍头（简化，远景或唐风商业建筑）
  {
    const y0 = RH * 3;
    g.fillStyle = '#8f2a1c';
    g.fillRect(0, y0, W, RH);
    g.fillStyle = gold;
    for (const x of [W * 0.04, W * 0.93]) {
      g.fillRect(x, y0, W * 0.03, RH);
    }
    g.strokeStyle = gold;
    g.lineWidth = 3;
    g.strokeRect(W * 0.3, y0 + RH * 0.2, W * 0.4, RH * 0.6);
    g.fillStyle = '#1f4e78';
    g.fillRect(W * 0.3 + 3, y0 + RH * 0.2 + 3, W * 0.4 - 6, RH * 0.6 - 6);
  }
  noise(g, W, H, r, 10);
  const t = tex(c, { repeat: false });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** 石材（汉白玉/青石），近白，靠顶点色着色 */
function makeStone() {
  const S = 256;
  const c = cnv(S), hc = cnv(S);
  const g = c.getContext('2d'), hg = hc.getContext('2d');
  const r = rng(33);
  g.fillStyle = '#ececec';
  g.fillRect(0, 0, S, S);
  hg.fillStyle = '#808080';
  hg.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${r() > 0.6 ? '255,255,255' : '60,55,50'},${r() * 0.06})`;
    g.beginPath();
    g.ellipse(r() * S, r() * S, 4 + r() * 40, 3 + r() * 20, r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  noise(g, S, S, r, 18);
  noise(hg, S, S, r, 70);
  // 石块接缝（每 1 米一条，单元 2 m）
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  hg.strokeStyle = '#303030';
  g.lineWidth = hg.lineWidth = 2;
  for (const cx of [g, hg]) {
    cx.beginPath();
    cx.moveTo(0, 1); cx.lineTo(S, 1);
    cx.moveTo(0, S / 2); cx.lineTo(S, S / 2);
    cx.moveTo(1, 0); cx.lineTo(1, S / 2);
    cx.moveTo(S / 2, S / 2); cx.lineTo(S / 2, S);
    cx.stroke();
  }
  return { map: tex(c), normalMap: tex(heightToNormal(hc, 1.5), { srgb: false }) };
}

/** 城砖（约 0.42×0.105 m），单元 1.68 m × 1.68 m */
function makeBrick() {
  const S = 512, cols = 4, rows = 16;
  const c = cnv(S), hc = cnv(S);
  const g = c.getContext('2d'), hg = hc.getContext('2d');
  const r = rng(71);
  g.fillStyle = '#b8b4ac';
  g.fillRect(0, 0, S, S);
  hg.fillStyle = '#303030';
  hg.fillRect(0, 0, S, S);
  const bw = S / cols, bh = S / rows, m = 3;
  for (let y = 0; y < rows; y++)
    for (let x = -1; x <= cols; x++) {
      const off = y % 2 ? bw / 2 : 0;
      const v = 0.86 + r() * 0.16;
      const k = (v * 200) | 0;
      g.fillStyle = `rgb(${k},${(k * 0.985) | 0},${(k * 0.96) | 0})`;
      g.fillRect(x * bw + off + m / 2, y * bh + m / 2, bw - m, bh - m);
      const hv = (190 + r() * 50) | 0;
      hg.fillStyle = `rgb(${hv},${hv},${hv})`;
      hg.fillRect(x * bw + off + m / 2, y * bh + m / 2, bw - m, bh - m);
    }
  noise(g, S, S, r, 22);
  noise(hg, S, S, r, 30);
  for (let i = 0; i < 50; i++) {
    g.fillStyle = `rgba(30,28,25,${r() * 0.06})`;
    g.beginPath();
    g.ellipse(r() * S, r() * S, r() * 90, r() * 30, 0, 0, Math.PI * 2);
    g.fill();
  }
  return { map: tex(c), normalMap: tex(heightToNormal(hc, 2.5), { srgb: false }) };
}

/** 抹灰墙/油饰：淡噪声 + 污渍（单元 4 m） */
function makePlaster() {
  const S = 256;
  const c = cnv(S);
  const g = c.getContext('2d');
  const r = rng(55);
  g.fillStyle = '#eeeeee';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 30; i++) {
    g.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '40,36,30'},${r() * 0.05})`;
    g.beginPath();
    g.ellipse(r() * S, r() * S, 10 + r() * 60, 5 + r() * 40, r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  noise(g, S, S, r, 10);
  return tex(c);
}

/**
 * 窗棂图集 2×2：0 三交六椀菱花，1 正方格，2 步步锦，3 直棂。map 近白（顶点色着色），alphaMap 白=棂条。
 * 每格 u/v 0..0.5，重复靠几何细分（格心按单元数复制 UV）。
 */
function makeLattice() {
  const S = 512, C = S / 2;
  const c = cnv(S), a = cnv(S);
  const g = c.getContext('2d'), ag = a.getContext('2d');
  g.fillStyle = '#d4d4d4';
  g.fillRect(0, 0, S, S);
  ag.fillStyle = '#000';
  ag.fillRect(0, 0, S, S);
  // 棂条的立体感：在 map 上画边缘暗线
  const bar = (ctx, x0, y0, x1, y1, w) => {
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  const cell = (ox, oy, fn) => {
    ag.save();
    ag.beginPath();
    ag.rect(ox, oy, C, C);
    ag.clip();
    ag.strokeStyle = '#fff';
    ag.fillStyle = '#fff';
    fn(ag, ox, oy);
    ag.restore();
    g.save();
    g.beginPath();
    g.rect(ox, oy, C, C);
    g.clip();
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    fn(g, ox, oy, true);
    g.restore();
  };
  // 0 三交六椀菱花：三组 60° 斜棂 + 交点小圆
  cell(0, 0, (ctx, ox, oy, shade) => {
    const n = 4, s = C / n;
    const w = shade ? 2 : s * 0.16;
    for (let i = -n * 2; i <= n * 2; i++) {
      const x = ox + i * s;
      bar(ctx, x, oy, x + C * Math.tan(Math.PI / 6) * 1.0, oy + C, w);
      bar(ctx, x, oy, x - C * Math.tan(Math.PI / 6) * 1.0, oy + C, w);
    }
    for (let j = 0; j <= n; j++) bar(ctx, ox, oy + j * s * 0.866 * 2, ox + C, oy + j * s * 0.866 * 2, shade ? 1 : w * 0.7);
    if (!shade)
      for (let i = 0; i <= n * 2; i++)
        for (let j = 0; j <= n * 2; j++) {
          ctx.beginPath();
          ctx.arc(ox + i * s / 2 + ((j % 2) * s) / 4, oy + j * s * 0.433, s * 0.13, 0, Math.PI * 2);
          ctx.fill();
        }
    bar(ctx, ox, oy, ox + C, oy, w * 2);
    bar(ctx, ox, oy + C, ox + C, oy + C, w * 2);
    bar(ctx, ox, oy, ox, oy + C, w * 2);
    bar(ctx, ox + C, oy, ox + C, oy + C, w * 2);
  });
  // 1 正方格
  cell(C, 0, (ctx, ox, oy, shade) => {
    const n = 5, s = C / n, w = shade ? 2 : s * 0.16;
    for (let i = 0; i <= n; i++) {
      bar(ctx, ox + i * s, oy, ox + i * s, oy + C, w);
      bar(ctx, ox, oy + i * s, ox + C, oy + i * s, w);
    }
  });
  // 2 步步锦
  cell(0, C, (ctx, ox, oy, shade) => {
    const w = shade ? 2 : C * 0.035;
    const rects = [
      [0.08, 0.08, 0.84, 0.84], [0.22, 0.2, 0.56, 0.6], [0.36, 0.34, 0.28, 0.32],
    ];
    for (const [x, y, rw, rh] of rects) {
      ctx.lineWidth = w;
      ctx.strokeRect(ox + x * C, oy + y * C, rw * C, rh * C);
    }
    const lines = [
      [0.08, 0.3, 0.22, 0.3], [0.78, 0.3, 0.92, 0.3], [0.08, 0.7, 0.22, 0.7], [0.78, 0.7, 0.92, 0.7],
      [0.35, 0.08, 0.35, 0.2], [0.65, 0.08, 0.65, 0.2], [0.35, 0.8, 0.35, 0.92], [0.65, 0.8, 0.65, 0.92],
      [0.22, 0.5, 0.36, 0.5], [0.64, 0.5, 0.78, 0.5], [0.5, 0.2, 0.5, 0.34], [0.5, 0.66, 0.5, 0.8],
    ];
    for (const [x0, y0, x1, y1] of lines) bar(ctx, ox + x0 * C, oy + y0 * C, ox + x1 * C, oy + y1 * C, w);
    ctx.lineWidth = w * 2;
    ctx.strokeRect(ox, oy, C, C);
  });
  // 3 直棂（唐）
  cell(C, C, (ctx, ox, oy, shade) => {
    const n = 8, s = C / n;
    for (let i = 0; i <= n; i++) {
      const x = ox + i * s;
      if (shade) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(x - s * 0.18, oy, s * 0.12, C);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + s * 0.06, oy, s * 0.12, C);
      } else ctx.fillRect(x - s * 0.2, oy, s * 0.4, C);
    }
    ctx.fillRect(ox, oy, C, C * 0.04);
    ctx.fillRect(ox, oy + C * 0.96, C, C * 0.04);
  });
  const map = tex(c, { repeat: false });
  const alphaMap = tex(a, { srgb: false, repeat: false });
  return { map, alphaMap };
}

function makeNoise() {
  const S = 128;
  const c = cnv(S);
  const g = c.getContext('2d');
  const r = rng(5);
  g.fillStyle = '#f0f0f0';
  g.fillRect(0, 0, S, S);
  noise(g, S, S, r, 12);
  for (let i = 0; i < 12; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.05})`;
    g.fillRect(r() * S, r() * S, 2 + r() * 30, 20 + r() * 80);
  }
  return tex(c);
}

/** 在材质里让自发光乘以顶点色（窗纸/灯笼/LED 共用一个材质、各自颜色） */
// 窗纸/室内透光：漫反射 = 顶点色（白天室内暗），自发光 = 暖光 × uv.x（逐间亮度，0 = 不亮）
const WHITE1 = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();
function emissiveTimesUvX(m) {
  m.map = WHITE1;
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      totalEmissiveRadiance *= vMapUv.x;`
    );
  };
  m.customProgramCacheKey = () => 'emisUvX';
  return m;
}
function emissiveTimesVertexColor(m) {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
        totalEmissiveRadiance *= vColor.rgb;
      #endif`
    );
  };
  m.customProgramCacheKey = () => 'emisVC';
  return m;
}

// 材质定义：所有材质 vertexColors=true，颜色走顶点色。
const MAT_DEFS = {
  // 屋面（近景底瓦，筒瓦用几何）
  tile: (k) => new THREE.MeshStandardMaterial({ map: k.tex.tile.map, normalMap: k.tex.tile.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.82, side: THREE.DoubleSide }),
  tileGlazed: (k) => new THREE.MeshStandardMaterial({ map: k.tex.tile.map, normalMap: k.tex.tile.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.32, metalness: 0.05, side: THREE.DoubleSide }),
  // 屋面（远/中景，瓦垄画进贴图）
  tileFlat: (k) => new THREE.MeshStandardMaterial({ map: k.tex.tileFlat.map, normalMap: k.tex.tileFlat.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.8, side: THREE.DoubleSide }),
  tileFlatGlazed: (k) => new THREE.MeshStandardMaterial({ map: k.tex.tileFlat.map, normalMap: k.tex.tileFlat.normalMap, normalScale: new THREE.Vector2(1.0, 1.0), roughness: 0.34, metalness: 0.05, side: THREE.DoubleSide }),
  // 屋脊、吻兽、走兽
  ridge: (k) => new THREE.MeshStandardMaterial({ map: k.tex.noise, roughness: 0.72 }),
  ridgeGlazed: (k) => new THREE.MeshStandardMaterial({ map: k.tex.noise, roughness: 0.3, metalness: 0.05 }),
  // 油饰木构（柱、枋、斗拱、椽、门框……）
  paint: (k) => new THREE.MeshStandardMaterial({ map: k.tex.noise, roughness: 0.55 }),
  // 彩画（额枋、平板枋）
  caihua: (k) => new THREE.MeshStandardMaterial({ map: k.tex.caihua, roughness: 0.6 }),
  // 石材（台基、栏杆、台阶、柱础、石狮）
  stone: (k) => new THREE.MeshStandardMaterial({ map: k.tex.stone.map, normalMap: k.tex.stone.normalMap, roughness: 0.62 }),
  // 城砖/青砖
  brick: (k) => new THREE.MeshStandardMaterial({ map: k.tex.brick.map, normalMap: k.tex.brick.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.92 }),
  // 抹灰墙（白墙/红墙）
  plaster: (k) => new THREE.MeshStandardMaterial({ map: k.tex.plaster, roughness: 0.9 }),
  // 窗棂（alphaTest 透空）
  lattice: (k) => new THREE.MeshStandardMaterial({ map: k.tex.lattice.map, alphaMap: k.tex.lattice.alphaMap, alphaTest: 0.5, roughness: 0.6, side: THREE.DoubleSide }),
  // 窗纸/室内（白天暗、夜间暖光透出；亮度随顶点色变化）
  glow: () => emissiveTimesUvX(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffc47e, emissiveIntensity: 0, roughness: 0.85, side: THREE.DoubleSide })),
  // 发光体（LED 灯条、灯笼、宫灯）：漫反射=顶点色，自发光=暖色×顶点色
  emit: () => emissiveTimesVertexColor(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.5 })),
  // LED 轮廓灯条：白天为暗色细线（灯具外壳），夜间按顶点色发光
  led: () => emissiveTimesVertexColor(new THREE.MeshStandardMaterial({ color: 0x3a3632, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.55, metalness: 0.4 })),
  // 金属（宝顶、门钉、铜饰）
  metal: () => new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.32 }),
};
// 夜间自发光（白天, 夜晚）
const NIGHT = { glow: [0, 1.5], emit: [0.03, 2.4], led: [0, 2.2] };

/** 每个 ctx 一套古建材质库 */
export class ArchKit {
  constructor(ctx) {
    this.ctx = ctx;
    this.tex = {
      tile: makeTileTextures(false),
      tileFlat: makeTileTextures(true),
      caihua: makeCaihuaAtlas(),
      stone: makeStone(),
      brick: makeBrick(),
      plaster: makePlaster(),
      lattice: makeLattice(),
      noise: makeNoise(),
    };
    this.mats = new Map();
    this.protos = new Map();
  }
  /** 共享材质（按名） */
  mat(name) {
    let m = this.mats.get(name);
    if (m) return m;
    const f = MAT_DEFS[name];
    if (!f) throw new Error('古建构件库：未知材质 ' + name);
    m = f(this);
    m.vertexColors = true;
    m.name = 'arch.' + name;
    this.mats.set(name, m);
    if (NIGHT[name] && this.ctx.night) this.ctx.night.register(m, { day: NIGHT[name][0], night: NIGHT[name][1] });
    return m;
  }
}

const kits = new WeakMap();
let lastCtx = null;
/** 取得（或创建）ctx 对应的古建材质库 */
export function getKit(ctx) {
  let k = kits.get(ctx);
  if (!k) {
    k = new ArchKit(ctx);
    kits.set(ctx, k);
  }
  lastCtx = ctx;
  return k;
}

// ───────────────────────────── 夜景泛光 ─────────────────────────────
/**
 * 泛光照明：按世界高度渐变的暖色自发光（反射率 × 光色），夜间系数取 ctx.uniforms.uNight。
 *   floodlit(material, {color, strength, baseY, height, top, ctx})
 *   color: 光色（默认暖金 0xffc47a）；strength：强度（1~3，默认 1.6）；baseY：灯具所在世界高度（通常为台基/城台顶）；
 *   height：渐变高度（米）；top：顶部相对亮度（默认 0.35）；朝上的面（屋面）亮度自动减弱，檐下/斗拱（朝下的面）更亮。
 * 会修改并返回该材质（如需与其他建筑区分，先 clone）。可与已有 onBeforeCompile 叠加。
 */
export function floodlit(material, opts = {}) {
  const ctx = opts.ctx || lastCtx;
  const uNight = ctx ? ctx.uniforms.uNight : { value: 1 };
  const u = {
    uFloodColor: { value: new THREE.Color(opts.color ?? 0xffc47a) },
    uFloodStrength: { value: opts.strength ?? 1.6 },
    uFloodBase: { value: opts.baseY ?? 0 },
    uFloodHeight: { value: Math.max(1, opts.height ?? 20) },
    uFloodTop: { value: opts.top ?? 0.35 },
    uFloodUp: { value: opts.upDim ?? 0.7 },
  };
  material.userData.flood = u;
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : () => '';
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, u, { uNight });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vFloodW;\nvarying vec3 vFloodN;`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        {
          vec4 fw = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            fw = instanceMatrix * fw;
          #endif
          fw = modelMatrix * fw;
          vFloodW = fw.xyz;
          vec3 fn = objectNormal;
          #ifdef USE_INSTANCING
            fn = mat3( instanceMatrix ) * fn;
          #endif
          vFloodN = normalize( mat3( modelMatrix ) * fn );
        }`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vFloodW;
        varying vec3 vFloodN;
        uniform vec3 uFloodColor;
        uniform float uFloodStrength, uFloodBase, uFloodHeight, uFloodTop, uFloodUp, uNight;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float fh = clamp( ( vFloodW.y - uFloodBase ) / uFloodHeight, 0.0, 1.0 );
          float prof = mix( 1.0, uFloodTop, fh ) * smoothstep( -1.5, 0.5, vFloodW.y - uFloodBase );
          vec3 fN = normalize( vFloodN );
          float face = 1.0 - uFloodUp * max( fN.y, 0.0 ) + 0.35 * max( -fN.y, 0.0 );
          totalEmissiveRadiance += diffuseColor.rgb * uFloodColor * ( uFloodStrength * uNight * prof * face );
        }`
      );
  };
  material.customProgramCacheKey = () => prevKey() + '|flood';
  material.needsUpdate = true;
  return material;
}

// ───────────────────────────── 几何累加器 ─────────────────────────────
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * ArchBuilder：古建几何累加器（按材质合并 + 可选实例化 + 匾额图集 + LED 灯条）。
 *   const b = new ArchBuilder(ctx, {detail:2, style:'ming'});
 *   b.push(x, y, z, rotY);  …构件函数(b, opts)…  b.pop();
 *   const group = b.build();   // THREE.Group，local 原点 = 构建时坐标原点
 */
export class ArchBuilder {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.kit = getKit(ctx);
    this.detail = opts.detail ?? 2;
    this.style = opts.style || 'ming';
    this.instancing = opts.instancing ?? false; // true：重复构件用 InstancedMesh（跨建筑共享 builder 时推荐）
    this.minInstances = opts.minInstances ?? 12;
    this.name = opts.name || 'arch';
    this.buckets = new Map();
    this.inst = new Map();
    this.plaques = [];
    this.m = new THREE.Matrix4();
    this.nm = new THREE.Matrix3();
    this.stack = [];
    this.lightAnchors = []; // {position, color, intensity, distance}：供模块注册 ctx.lights
    this.meta = {};
  }

  // —— 变换栈 ——
  /** push(Matrix4) 或 push(x, y, z, rotY=0, scale=1) */
  push(x = 0, y = 0, z = 0, rotY = 0, s = 1) {
    this.stack.push(this.m.clone());
    let mm;
    if (x && x.isMatrix4) mm = x;
    else {
      mm = new THREE.Matrix4().makeRotationY(rotY);
      if (s !== 1) mm.scale(new THREE.Vector3(s, s, s));
      mm.setPosition(x, y, z);
    }
    this.m.multiply(mm);
    this.nm.getNormalMatrix(this.m);
    return this;
  }
  pop() {
    this.m.copy(this.stack.pop());
    this.nm.getNormalMatrix(this.m);
    return this;
  }
  /** 在临时变换下执行 fn */
  at(x, y, z, rotY, fn) {
    this.push(x, y, z, rotY);
    try {
      fn(this);
    } finally {
      this.pop();
    }
    return this;
  }
  bucket(key) {
    let b = this.buckets.get(key);
    if (!b) {
      b = new Bucket(key);
      this.buckets.set(key, b);
    }
    return b;
  }

  /** 添加一个顶点（局部坐标，经当前变换），返回索引 */
  vtx(bk, x, y, z, nx, ny, nz, u, v, col) {
    const e = this.m.elements;
    const X = e[0] * x + e[4] * y + e[8] * z + e[12];
    const Y = e[1] * x + e[5] * y + e[9] * z + e[13];
    const Z = e[2] * x + e[6] * y + e[10] * z + e[14];
    const q = this.nm.elements;
    let NX = q[0] * nx + q[3] * ny + q[6] * nz;
    let NY = q[1] * nx + q[4] * ny + q[7] * nz;
    let NZ = q[2] * nx + q[5] * ny + q[8] * nz;
    const l = Math.hypot(NX, NY, NZ);
    if (l > 1e-9) {
      NX /= l; NY /= l; NZ /= l;
    } else {
      NX = 0; NY = 1; NZ = 0; // 退化法线兜底（避免着色器 normalize(0) → NaN → 泛光全屏发黑）
    }
    const P = bk.p, N = bk.n, T = bk.t, C = bk.c;
    P.grow(3); N.grow(3); T.grow(2); C.grow(3);
    P.a[P.n++] = X; P.a[P.n++] = Y; P.a[P.n++] = Z;
    N.a[N.n++] = NX; N.a[N.n++] = NY; N.a[N.n++] = NZ;
    T.a[T.n++] = u; T.a[T.n++] = v;
    C.a[C.n++] = col[0]; C.a[C.n++] = col[1]; C.a[C.n++] = col[2];
    return bk.count++;
  }
  tri(bk, a, b, c) {
    const I = bk.i;
    I.grow(3);
    I.a[I.n++] = a; I.a[I.n++] = b; I.a[I.n++] = c;
  }
  quadIdx(bk, a, b, c, d) {
    this.tri(bk, a, b, c);
    this.tri(bk, a, c, d);
  }

  // —— 基本体（均在当前局部坐标下） ——
  /** 平面四边形 a,b,c,d（逆时针为正面），uv 可选 [[u,v]×4]；默认按米投影 */
  quad(mk, a, b, c, d, col, uv = null) {
    const bk = this.bucket(mk);
    const cl = lin(col);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    let uvs = uv;
    if (!uvs) {
      const lu = Math.hypot(ux, uy, uz) || 1, lv = Math.hypot(vx, vy, vz) || 1;
      const tx = ux / lu, ty = uy / lu, tz = uz / lu;
      const bx = vx / lv, by = vy / lv, bz = vz / lv;
      const p = (q) => [(q[0] - a[0]) * tx + (q[1] - a[1]) * ty + (q[2] - a[2]) * tz, (q[0] - a[0]) * bx + (q[1] - a[1]) * by + (q[2] - a[2]) * bz];
      const o = [a[0] * tx + a[1] * ty + a[2] * tz, a[1]];
      uvs = [a, b, c, d].map((q) => {
        const r = p(q);
        return [r[0] + o[0], r[1] + o[1]];
      });
    }
    const i0 = this.vtx(bk, a[0], a[1], a[2], nx, ny, nz, uvs[0][0], uvs[0][1], cl);
    const i1 = this.vtx(bk, b[0], b[1], b[2], nx, ny, nz, uvs[1][0], uvs[1][1], cl);
    const i2 = this.vtx(bk, c[0], c[1], c[2], nx, ny, nz, uvs[2][0], uvs[2][1], cl);
    const i3 = this.vtx(bk, d[0], d[1], d[2], nx, ny, nz, uvs[3][0], uvs[3][1], cl);
    this.quadIdx(bk, i0, i1, i2, i3);
  }
  triangle(mk, a, b, c, col, uv = null) {
    const bk = this.bucket(mk);
    const cl = lin(col);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const t = uv || [[a[0] + a[2], a[1]], [b[0] + b[2], b[1]], [c[0] + c[2], c[1]]];
    const i0 = this.vtx(bk, a[0], a[1], a[2], nx, ny, nz, t[0][0], t[0][1], cl);
    const i1 = this.vtx(bk, b[0], b[1], b[2], nx, ny, nz, t[1][0], t[1][1], cl);
    const i2 = this.vtx(bk, c[0], c[1], c[2], nx, ny, nz, t[2][0], t[2][1], cl);
    this.tri(bk, i0, i1, i2);
  }
  /**
   * 轴对齐长方体 [x0,x1]×[y0,y1]×[z0,z1]。UV 以米计（可 uvScale）。
   * opts.skip: 省略的面 'top','bottom','px','nx','pz','nz' 组成的字符串
   * opts.colors: {top, side, end}（分面着色，如椽头异色）
   */
  box(mk, x0, y0, z0, x1, y1, z1, col, opts = {}) {
    const bk = this.bucket(mk);
    const s = opts.uvScale ?? 1;
    const skip = opts.skip || '';
    const cc = opts.colors || {};
    const face = (name, pts, n, uvf, fc) => {
      if (skip.includes(name)) return;
      const cl = lin(fc ?? col);
      const idx = pts.map((p) => {
        const [u, v] = uvf(p);
        return this.vtx(bk, p[0], p[1], p[2], n[0], n[1], n[2], u * s, v * s, cl);
      });
      this.quadIdx(bk, idx[0], idx[1], idx[2], idx[3]);
    };
    face('pz', [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], (p) => [p[0], p[1]], cc.pz ?? cc.side);
    face('nz', [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], (p) => [-p[0], p[1]], cc.nz ?? cc.side);
    face('px', [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], (p) => [-p[2], p[1]], cc.px ?? cc.end);
    face('nx', [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], (p) => [p[2], p[1]], cc.nx ?? cc.end);
    face('top', [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], (p) => [p[0], -p[2]], cc.top);
    face('bottom', [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], (p) => [p[0], p[2]], cc.bottom);
  }
  /** 中心尺寸式长方体 */
  boxC(mk, cx, cy, cz, sx, sy, sz, col, opts) {
    this.box(mk, cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, col, opts);
  }
  /** 棱台（底 bw×bd 于 y0，顶 tw×td 于 y1），用于斗、柱础、台基收分 */
  frustum(mk, cx, cz, y0, bw, bd, y1, tw, td, col, opts = {}) {
    const B = [[cx - bw / 2, y0, cz + bd / 2], [cx + bw / 2, y0, cz + bd / 2], [cx + bw / 2, y0, cz - bd / 2], [cx - bw / 2, y0, cz - bd / 2]];
    const T = [[cx - tw / 2, y1, cz + td / 2], [cx + tw / 2, y1, cz + td / 2], [cx + tw / 2, y1, cz - td / 2], [cx - tw / 2, y1, cz - td / 2]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(mk, B[i], B[j], T[j], T[i], col);
    }
    if (!opts.noTop) this.quad(mk, T[0], T[1], T[2], T[3], opts.topColor ?? col);
    if (opts.bottom) this.quad(mk, B[3], B[2], B[1], B[0], col);
  }
  /** 竖直圆台/圆柱（光滑法线）。r0 底半径，r1 顶半径 */
  cyl(mk, cx, y0, cz, r0, r1, h, seg, col, opts = {}) {
    const bk = this.bucket(mk);
    const cl = lin(col);
    const s = opts.uvScale ?? 1;
    const dr = r0 - r1;
    const sl = Math.hypot(dr, h);
    const ny = dr / sl, nr = h / sl;
    const base = bk.count;
    const circ = 2 * Math.PI * Math.max(r0, r1);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2 + (opts.phase || 0);
      const ca = Math.cos(a), sa = Math.sin(a);
      this.vtx(bk, cx + ca * r0, y0, cz + sa * r0, ca * nr, ny, sa * nr, (i / seg) * circ * s, y0 * s, cl);
      this.vtx(bk, cx + ca * r1, y0 + h, cz + sa * r1, ca * nr, ny, sa * nr, (i / seg) * circ * s, (y0 + h) * s, cl);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      this.quadIdx(bk, a, a + 1, a + 3, a + 2);
    }
    if (opts.top !== false && r1 > 0) {
      const c0 = this.vtx(bk, cx, y0 + h, cz, 0, 1, 0, cx * s, cz * s, lin(opts.topColor ?? col));
      const b1 = bk.count;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2 + (opts.phase || 0);
        this.vtx(bk, cx + Math.cos(a) * r1, y0 + h, cz + Math.sin(a) * r1, 0, 1, 0, (cx + Math.cos(a) * r1) * s, (cz + Math.sin(a) * r1) * s, lin(opts.topColor ?? col));
      }
      for (let i = 0; i < seg; i++) this.tri(bk, c0, b1 + i + 1, b1 + i);
    }
    if (opts.bottom) {
      const c0 = this.vtx(bk, cx, y0, cz, 0, -1, 0, 0, 0, cl);
      const b1 = bk.count;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2 + (opts.phase || 0);
        this.vtx(bk, cx + Math.cos(a) * r0, y0, cz + Math.sin(a) * r0, 0, -1, 0, 0, 0, cl);
      }
      for (let i = 0; i < seg; i++) this.tri(bk, c0, b1 + i, b1 + i + 1);
    }
  }
  /** 回转体：prof = [[r, y], ...]（自下而上），seg 分段；光滑法线 */
  lathe(mk, prof, seg, col, cx = 0, cz = 0, opts = {}) {
    const bk = this.bucket(mk);
    const cl = lin(col);
    const n = prof.length;
    // 轮廓法线
    const pn = prof.map((p, i) => {
      const a = prof[Math.max(0, i - 1)], b = prof[Math.min(n - 1, i + 1)];
      const dr = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dr, dy) || 1;
      return [dy / l, -dr / l];
    });
    const base = bk.count;
    const cols = opts.colors; // 每个轮廓点的颜色（可选）
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2 + (opts.phase || 0);
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let j = 0; j < n; j++) {
        const [r, y] = prof[j];
        const c = cols ? lin(cols[j]) : cl;
        this.vtx(bk, cx + ca * r, y, cz + sa * r, ca * pn[j][0], pn[j][1], sa * pn[j][0], i / seg, y, c);
      }
    }
    for (let i = 0; i < seg; i++)
      for (let j = 0; j < n - 1; j++) {
        const a = base + i * n + j, b = base + (i + 1) * n + j;
        this.quadIdx(bk, a, a + 1, b + 1, b);
      }
  }
  /**
   * 平面多边形拉伸成棱柱。poly=[[p,q],...]（逆时针）；axis='z'：poly 在 (x,y) 平面，沿 z∈[d0,d1] 拉伸；
   * axis='x'：poly 在 (z,y) 平面（p=z 向外，q=y），沿 x∈[d0,d1] 拉伸。
   */
  prism(mk, poly, axis, d0, d1, col, opts = {}) {
    const bk = this.bucket(mk);
    const cl = lin(col);
    const capCol = opts.capColor != null ? lin(opts.capColor) : cl;
    const P = (p, q, d) => (axis === 'z' ? [p, q, d] : [d, q, p]);
    const n = poly.length;
    // 侧面
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const sgn = area >= 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const l = Math.hypot(ex, ey) || 1;
      // 外法线（对逆时针多边形为 (ey, -ex)）
      const on = [(ey / l) * sgn, (-ex / l) * sgn];
      const N = axis === 'z' ? [on[0], on[1], 0] : [0, on[1], on[0]];
      const A0 = P(a[0], a[1], d0), B0 = P(b[0], b[1], d0), B1 = P(b[0], b[1], d1), A1 = P(a[0], a[1], d1);
      const L = Math.hypot(ex, ey);
      const i0 = this.vtx(bk, ...A0, ...N, 0, d0, cl);
      const i1 = this.vtx(bk, ...B0, ...N, L, d0, cl);
      const i2 = this.vtx(bk, ...B1, ...N, L, d1, cl);
      const i3 = this.vtx(bk, ...A1, ...N, 0, d1, cl);
      // 方向：保证外向
      if ((axis === 'x') === (sgn > 0)) this.quadIdx(bk, i0, i3, i2, i1);
      else this.quadIdx(bk, i0, i1, i2, i3);
    }
    if (opts.caps === false) return;
    const tris = triCache(poly);
    for (const [d, s] of [[d0, -1], [d1, 1]]) {
      const N = axis === 'z' ? [0, 0, s] : [s, 0, 0];
      const base = bk.count;
      for (const p of poly) this.vtx(bk, ...P(p[0], p[1], d), ...N, p[0], p[1], capCol);
      const want = axis === 'z' ? s : -s;
      for (const t of tris) {
        // 截面上逆时针三角形：axis=z 时法线 +z；axis=x 时法线 -x
        if (triSign(poly, t) === want) this.tri(bk, base + t[0], base + t[1], base + t[2]);
        else this.tri(bk, base + t[0], base + t[2], base + t[1]);
      }
    }
  }
  /**
   * 沿三维折线扫掠截面。path=[[x,y,z],...]；prof=[[px,py],...]（截面坐标：px 横向、py 竖向，逆时针）
   * opts: up 参考上方向（默认 [0,1,0]），closed 路径闭合，caps 端面，smooth 截面光滑法线，colors 每截面点颜色
   */
  sweep(mk, path, prof, col, opts = {}) {
    const bk = this.bucket(mk);
    const cl = lin(col);
    const np = path.length, nq = prof.length;
    if (np < 2) return;
    const up = opts.up || [0, 1, 0];
    const closed = !!opts.closed;
    const frames = [];
    for (let i = 0; i < np; i++) {
      const a = path[closed ? (i - 1 + np) % np : Math.max(0, i - 1)];
      const b = path[closed ? (i + 1) % np : Math.min(np - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      let l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;
      // 横向 L = T × up
      let lx = ty * up[2] - tz * up[1], ly = tz * up[0] - tx * up[2], lz = tx * up[1] - ty * up[0];
      l = Math.hypot(lx, ly, lz);
      if (l < 1e-5) {
        // 切向与参考上方向平行（竖直灯条、灯笼肋条）：改用 +Z / +X 作参考
        const u2 = Math.abs(tz) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        lx = ty * u2[2] - tz * u2[1]; ly = tz * u2[0] - tx * u2[2]; lz = tx * u2[1] - ty * u2[0];
        l = Math.hypot(lx, ly, lz);
      }
      l = l || 1;
      lx /= l; ly /= l; lz /= l;
      // 竖向 U = L × T
      const ux = ly * tz - lz * ty, uy = lz * tx - lx * tz, uz = lx * ty - ly * tx;
      // 转角处横向缩放（斜接）
      let miter = 1;
      if ((closed || (i > 0 && i < np - 1)) && opts.miter !== false) {
        const p0 = path[closed ? (i - 1 + np) % np : i - 1], p1 = path[i], p2 = path[closed ? (i + 1) % np : i + 1];
        const d0 = norm2([p1[0] - p0[0], p1[2] - p0[2]]), d1 = norm2([p2[0] - p1[0], p2[2] - p1[2]]);
        const cosh = Math.sqrt(Math.max(0.05, (1 + d0[0] * d1[0] + d0[1] * d1[1]) / 2));
        miter = 1 / cosh;
      }
      frames.push({ L: [lx * miter, ly * miter, lz * miter], U: [ux, uy, uz], T: [tx, ty, tz] });
    }
    // 截面法线
    const pn = [];
    for (let j = 0; j < nq; j++) {
      const a = prof[(j - 1 + nq) % nq], b = prof[(j + 1) % nq], c = prof[j], d = prof[(j + 1) % nq];
      const e = opts.smooth ? [b[0] - a[0], b[1] - a[1]] : [d[0] - c[0], d[1] - c[1]];
      const l = Math.hypot(e[0], e[1]) || 1;
      pn.push([e[1] / l, -e[0] / l]);
    }
    const colors = opts.colors ? opts.colors.map(lin) : null;
    let acc = 0;
    if (opts.smooth) {
      const base = bk.count;
      for (let i = 0; i < np; i++) {
        if (i) acc += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
        const f = frames[i], p = path[i];
        for (let j = 0; j < nq; j++) {
          const [px, py] = prof[j];
          const nx = f.L[0] * pn[j][0] + f.U[0] * pn[j][1], ny = f.L[1] * pn[j][0] + f.U[1] * pn[j][1], nz = f.L[2] * pn[j][0] + f.U[2] * pn[j][1];
          this.vtx(bk, p[0] + f.L[0] * px + f.U[0] * py, p[1] + f.L[1] * px + f.U[1] * py, p[2] + f.L[2] * px + f.U[2] * py, nx, ny, nz, j / nq, acc, colors ? colors[j] : cl);
        }
      }
      const segs = closed ? np : np - 1;
      for (let i = 0; i < segs; i++) {
        const i2 = (i + 1) % np;
        for (let j = 0; j < nq; j++) {
          const j2 = (j + 1) % nq;
          this.quadIdx(bk, base + i * nq + j, base + i2 * nq + j, base + i2 * nq + j2, base + i * nq + j2);
        }
      }
    } else {
      // 平直法线：每个截面边一条独立带
      const segs = closed ? np : np - 1;
      for (let j = 0; j < nq; j++) {
        const j2 = (j + 1) % nq;
        const base = bk.count;
        acc = 0;
        for (let i = 0; i <= segs; i++) {
          const ii = i % np;
          if (i) acc += Math.hypot(path[ii][0] - path[i - 1][0], path[ii][1] - path[i - 1][1], path[ii][2] - path[i - 1][2]);
          const f = frames[ii], p = path[ii];
          const nx = f.L[0] * pn[j][0] + f.U[0] * pn[j][1], ny = f.L[1] * pn[j][0] + f.U[1] * pn[j][1], nz = f.L[2] * pn[j][0] + f.U[2] * pn[j][1];
          for (const q of [prof[j], prof[j2]]) {
            this.vtx(bk, p[0] + f.L[0] * q[0] + f.U[0] * q[1], p[1] + f.L[1] * q[0] + f.U[1] * q[1], p[2] + f.L[2] * q[0] + f.U[2] * q[1], nx, ny, nz, acc, q[1], colors ? colors[j] : cl);
          }
        }
        for (let i = 0; i < segs; i++) {
          const a = base + i * 2;
          this.quadIdx(bk, a, a + 2, a + 3, a + 1);
        }
      }
    }
    if (!closed && opts.caps !== false) {
      const tris = triCache(prof);
      for (const [i, s] of [[0, -1], [np - 1, 1]]) {
        const f = frames[i], p = path[i];
        const base = bk.count;
        const capCol = opts.capColor != null ? lin(opts.capColor) : cl;
        for (const q of prof) this.vtx(bk, p[0] + f.L[0] * q[0] + f.U[0] * q[1], p[1] + f.L[1] * q[0] + f.U[1] * q[1], p[2] + f.L[2] * q[0] + f.U[2] * q[1], f.T[0] * s, f.T[1] * s, f.T[2] * s, q[0], q[1], capCol);
        // 截面逆时针三角形的法线为 -T
        for (const t of tris) {
          if (triSign(prof, t) === -s) this.tri(bk, base + t[0], base + t[1], base + t[2]);
          else this.tri(bk, base + t[0], base + t[2], base + t[1]);
        }
      }
    }
  }
  /** 追加一个 THREE.BufferGeometry（当前变换下），可整体着色 */
  geometry(mk, geo, col = 0xffffff, matrix = null) {
    const bk = this.bucket(mk);
    const cl = lin(col);
    const p = geo.attributes.position, n = geo.attributes.normal, t = geo.attributes.uv, c = geo.attributes.color;
    if (matrix) this.push(matrix);
    const base = bk.count;
    for (let i = 0; i < p.count; i++) {
      const cc = c ? [c.getX(i) * cl[0], c.getY(i) * cl[1], c.getZ(i) * cl[2]] : cl;
      this.vtx(bk, p.getX(i), p.getY(i), p.getZ(i), n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0, t ? t.getX(i) : 0, t ? t.getY(i) : 0, cc);
    }
    if (geo.index) {
      const ix = geo.index.array;
      for (let i = 0; i < ix.length; i += 3) this.tri(bk, base + ix[i], base + ix[i + 1], base + ix[i + 2]);
    } else for (let i = 0; i < p.count; i += 3) this.tri(bk, base + i, base + i + 1, base + i + 2);
    if (matrix) this.pop();
  }

  // —— 原型 / 实例化 ——
  /**
   * 放置一个可复用原型（斗拱、灯笼、望柱……）。protoKey 相同即同一原型；factory(pb) 在一个临时 builder 中建模（原点为原型基点）。
   * builder.instancing=true 且数量 ≥ minInstances 时生成 InstancedMesh，否则烘焙合并。tint：整体乘色（可选）。
   */
  proto(key, factory, tint = null) {
    const k = key + '|d' + this.detail;
    let pr = this.kit.protos.get(k);
    if (!pr) {
      const pb = new ArchBuilder(this.ctx, { detail: this.detail, style: this.style });
      factory(pb);
      pr = { buckets: pb.buckets, tris: [...pb.buckets.values()].reduce((a, b) => a + b.triCount, 0) };
      this.kit.protos.set(k, pr);
    }
    let rec = this.inst.get(k);
    if (!rec) {
      rec = { pr, mats: [], tints: [] };
      this.inst.set(k, rec);
    }
    rec.mats.push(this.m.clone());
    rec.tints.push(tint ? lin(tint) : null);
    return this;
  }
  _bakeProto(pr, mat, tint) {
    const nm = new THREE.Matrix3().getNormalMatrix(mat);
    const e = mat.elements, q = nm.elements;
    for (const [key, sb] of pr.buckets) {
      const bk = this.bucket(key);
      const base = bk.count;
      const n = sb.count;
      bk.p.grow(n * 3); bk.n.grow(n * 3); bk.t.grow(n * 2); bk.c.grow(n * 3); bk.i.grow(sb.i.n);
      const P = sb.p.a, N = sb.n.a, T = sb.t.a, C = sb.c.a;
      for (let i = 0; i < n; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        bk.p.a[bk.p.n++] = e[0] * x + e[4] * y + e[8] * z + e[12];
        bk.p.a[bk.p.n++] = e[1] * x + e[5] * y + e[9] * z + e[13];
        bk.p.a[bk.p.n++] = e[2] * x + e[6] * y + e[10] * z + e[14];
        const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
        let X = q[0] * nx + q[3] * ny + q[6] * nz, Y = q[1] * nx + q[4] * ny + q[7] * nz, Z = q[2] * nx + q[5] * ny + q[8] * nz;
        const l = Math.hypot(X, Y, Z) || 1;
        bk.n.a[bk.n.n++] = X / l; bk.n.a[bk.n.n++] = Y / l; bk.n.a[bk.n.n++] = Z / l;
        bk.t.a[bk.t.n++] = T[i * 2]; bk.t.a[bk.t.n++] = T[i * 2 + 1];
        if (tint) {
          bk.c.a[bk.c.n++] = C[i * 3] * tint[0]; bk.c.a[bk.c.n++] = C[i * 3 + 1] * tint[1]; bk.c.a[bk.c.n++] = C[i * 3 + 2] * tint[2];
        } else {
          bk.c.a[bk.c.n++] = C[i * 3]; bk.c.a[bk.c.n++] = C[i * 3 + 1]; bk.c.a[bk.c.n++] = C[i * 3 + 2];
        }
      }
      for (let i = 0; i < sb.i.n; i++) bk.i.a[bk.i.n++] = sb.i.a[i] + base;
      bk.count += n;
    }
  }

  // —— 匾额（图集） ——
  /**
   * 匾额面：在局部坐标 (cx, cy, cz) 处放一块宽 w、高 h 的文字匾（正面 +Z）。
   * opts: bg 底色、color 字色、border 边框色、vertical 竖排、serif（默认 true）
   */
  plaque(text, cx, cy, cz, w, h, opts = {}) {
    const e = this.m.clone();
    this.plaques.push({ text, cx, cy, cz, w, h, opts, m: e });
  }

  // —— LED 灯条 ——
  /** 沿折线的发光灯条（emit 材质，夜间自动点亮）。width：截面边长（米） */
  led(points, { color = 0xffe2b0, width = 0.06, closed = false } = {}) {
    if (points.length < 2) return;
    const h = width / 2;
    this.sweep('led', points, [[-h, -h], [h, -h], [h, h], [-h, h]], color, { closed, caps: !closed });
  }

  // —— 输出 ——
  /**
   * 生成 THREE.Group。opts: castShadow/receiveShadow（默认 true）、flood（泛光配置，见 floodlit，
   * 会克隆本 builder 用到的非发光材质并注入泛光着色）、materials（{名称:材质} 覆盖）。
   */
  build(opts = {}) {
    const group = new THREE.Group();
    group.name = opts.name || this.name;
    const kit = this.kit;
    const matCache = new Map();
    const getMat = (key) => {
      if (matCache.has(key)) return matCache.get(key);
      let m = opts.materials?.[key] || kit.mat(key);
      if (opts.flood && !['emit', 'glow', 'lattice', 'led'].includes(key)) {
        m = m.clone();
        floodlit(m, { ctx: this.ctx, ...opts.flood });
      }
      matCache.set(key, m);
      return m;
    };
    // 实例化 / 烘焙原型
    for (const [, rec] of this.inst) {
      if (this.instancing && rec.mats.length >= this.minInstances) {
        for (const [key, sb] of rec.pr.buckets) {
          const geo = sb.toGeometry();
          const im = new THREE.InstancedMesh(geo, getMat(key), rec.mats.length);
          rec.mats.forEach((m, i) => im.setMatrixAt(i, m));
          if (rec.tints.some((t) => t)) {
            const c = new THREE.Color();
            rec.tints.forEach((t, i) => im.setColorAt(i, t ? c.setRGB(t[0], t[1], t[2]) : c.setRGB(1, 1, 1)));
          }
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          im.castShadow = !['emit', 'glow', 'lattice', 'led'].includes(key) && opts.castShadow !== false;
          im.receiveShadow = opts.receiveShadow !== false;
          im.name = 'inst:' + key;
          group.add(im);
        }
      } else rec.mats.forEach((m, i) => this._bakeProto(rec.pr, m, rec.tints[i]));
    }
    this.inst.clear();
    // 匾额图集
    if (this.plaques.length) this._buildPlaques(group, opts);
    for (const [key, bk] of this.buckets) {
      if (!bk.count) continue;
      const mesh = new THREE.Mesh(bk.toGeometry(), getMat(key));
      mesh.name = key;
      mesh.castShadow = !['emit', 'glow', 'lattice', 'led'].includes(key) && opts.castShadow !== false;
      mesh.receiveShadow = opts.receiveShadow !== false;
      group.add(mesh);
    }
    this.buckets.clear();
    group.userData.arch = { detail: this.detail, lights: this.lightAnchors, meta: this.meta };
    return group;
  }
  _buildPlaques(group, opts) {
    const n = this.plaques.length;
    const CW = 512, CH = 160;
    const perRow = 4;
    const rows = Math.ceil(n / perRow);
    const c = cnv(CW * perRow, CH * Math.max(1, rows));
    const g = c.getContext('2d');
    const ctx = this.ctx;
    const bk = new Bucket('plaque');
    const save = this.m.clone();
    this.plaques.forEach((p, i) => {
      const col = i % perRow, row = (i / perRow) | 0;
      const x0 = col * CW, y0 = row * CH;
      const vert = !!p.opts.vertical;
      const bg = p.opts.bg || '#1d3553';
      const fg = p.opts.color || '#e8c46a';
      const border = p.opts.border || '#d4a94e';
      // 竖匾：在旋转 -90° 的坐标系里按“竖长”画（宽 CH × 高 CW），UV 相应旋转，字保持正向
      g.save();
      let PW = CW, PH = CH;
      if (vert) {
        g.translate(x0, y0 + CH);
        g.rotate(-Math.PI / 2);
        PW = CH;
        PH = CW;
      } else g.translate(x0, y0);
      g.fillStyle = bg;
      g.fillRect(0, 0, PW, PH);
      g.strokeStyle = border;
      g.lineWidth = 10;
      g.strokeRect(8, 8, PW - 16, PH - 16);
      g.lineWidth = 3;
      g.strokeRect(20, 20, PW - 40, PH - 40);
      const tx = ctx.tex.text(p.text, { color: fg, serif: p.opts.serif !== false, weight: 700, size: 128, padding: 0.1, stroke: p.opts.stroke || null, vertical: vert });
      const img = tx.canvas;
      const maxW = PW - (vert ? 50 : 70), maxH = PH - (vert ? 70 : 50);
      const sc = Math.min(maxW / img.width, maxH / img.height);
      const dw = img.width * sc, dh = img.height * sc;
      g.drawImage(img, (PW - dw) / 2, (PH - dh) / 2, dw, dh);
      g.restore();
      const u0 = x0 / c.width, u1 = (x0 + CW) / c.width;
      const v0 = 1 - (y0 + CH) / c.height, v1 = 1 - y0 / c.height;
      this.m.copy(p.m);
      this.nm.getNormalMatrix(this.m);
      const { cx, cy, cz, w, h } = p;
      const cl = [1, 1, 1];
      const base = bk.count;
      if (!vert) {
        this.vtx(bk, cx - w / 2, cy - h / 2, cz, 0, 0, 1, u0, v0, cl);
        this.vtx(bk, cx + w / 2, cy - h / 2, cz, 0, 0, 1, u1, v0, cl);
        this.vtx(bk, cx + w / 2, cy + h / 2, cz, 0, 0, 1, u1, v1, cl);
        this.vtx(bk, cx - w / 2, cy + h / 2, cz, 0, 0, 1, u0, v1, cl);
      } else {
        // 竖匾：图集单元内逆时针旋转 90°（匾顶 → 单元左侧，匾左 → 单元底边）
        this.vtx(bk, cx - w / 2, cy - h / 2, cz, 0, 0, 1, u1, v0, cl);
        this.vtx(bk, cx + w / 2, cy - h / 2, cz, 0, 0, 1, u1, v1, cl);
        this.vtx(bk, cx + w / 2, cy + h / 2, cz, 0, 0, 1, u0, v1, cl);
        this.vtx(bk, cx - w / 2, cy + h / 2, cz, 0, 0, 1, u0, v0, cl);
      }
      this.quadIdx(bk, base, base + 1, base + 2, base + 3);
    });
    this.m.copy(save);
    this.nm.getNormalMatrix(this.m);
    const t = tex(c, { repeat: false });
    const mat = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.45, metalness: 0.1 });
    mat.name = 'arch.plaque';
    if (this.ctx.night) this.ctx.night.register(mat, { day: 0, night: 0.55 });
    if (opts.flood) floodlit(mat, { ctx: this.ctx, ...opts.flood });
    const mesh = new THREE.Mesh(bk.toGeometry(), mat);
    mesh.name = 'plaque';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    this.plaques = [];
  }
}

function norm2(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}
function triSign(poly, t) {
  const a = poly[t[0]], b = poly[t[1]], c = poly[t[2]];
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= 0 ? 1 : -1;
}
const triMemo = new WeakMap();
function triCache(poly) {
  let t = triMemo.get(poly);
  if (!t) {
    t = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p[0], p[1])), []);
    triMemo.set(poly, t);
  }
  return t;
}

// ───────────────────────────── LOD ─────────────────────────────
/**
 * 用多个细节层级的 Group 组成 THREE.LOD。levels = [[group(detail=2), 0], [group(detail=1), 150], [group(detail=0), 500]]
 * THREE.LOD 由渲染器自动按相机距离切换。
 */
export function makeLOD(levels) {
  const lod = new THREE.LOD();
  for (const [g, d] of levels) lod.addLevel(g, d);
  return lod;
}

/** 统计一个对象的三角形数 / 网格数 / 材质数（自测用） */
export function stats(obj) {
  let tris = 0, meshes = 0;
  const mats = new Set();
  obj.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    mats.add(o.material);
    const g = o.geometry;
    const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    tris += n * (o.isInstancedMesh ? o.count : 1);
  });
  return { tris: Math.round(tris), meshes, materials: mats.size };
}

// ───────────────────────────── 风格与配色 ─────────────────────────────
/** 屋面配色（顶点色，已按贴图亮度校正）。可传十六进制自定义：{tile, tube, ridge, glazed} */
export const ROOF_COLORS = {
  gray: { tile: 0x9a9ea3, tube: 0x8f9398, ridge: 0x5d6064, glazed: false },
  darkgray: { tile: 0x6e7176, tube: 0x676a6f, ridge: 0x46494d, glazed: false },
  green: { tile: 0x2e7446, tube: 0x2b6e42, ridge: 0x235a36, glazed: true },
  yellow: { tile: 0xf2b640, tube: 0xefb33d, ridge: 0xd99b2b, glazed: true },
  blue: { tile: 0x3a62a8, tube: 0x3960a3, ridge: 0x2d4f8a, glazed: true },
  black: { tile: 0x3d3f43, tube: 0x3a3c40, ridge: 0x2c2e31, glazed: true },
};
export function roofColors(c) {
  if (!c) return ROOF_COLORS.gray;
  if (typeof c === 'string') return ROOF_COLORS[c] || ROOF_COLORS.gray;
  if (typeof c === 'number') return { tile: c, tube: c, ridge: c, glazed: false };
  return { ...ROOF_COLORS.gray, ...c };
}

/**
 * 风格参数（唐风雄大舒展、明清细密陡峻）。
 *   pitch：举高/步长均值；k0f：檐部坡度占均值比例（举折下凹程度）；ovK：出檐/柱高；
 *   lift：翼角起翘/出檐；flare：翼角冲出/出檐；sheng：生起（整条檐线的缓升，米）
 *   bracketK：斗拱高/柱高；ridgeK：正脊高/进深
 */
export const STYLES = {
  tang: { pitch: 0.46, k0f: 0.58, ovK: 0.62, lift: 0.26, flare: 0.2, sheng: 0.18, bracketK: 0.42, ridgeK: 0.055, ornament: 'chiwei' },
  ming: { pitch: 0.66, k0f: 0.46, ovK: 0.36, lift: 0.3, flare: 0.22, sheng: 0.0, bracketK: 0.2, ridgeK: 0.075, ornament: 'wen' },
};

/**
 * 木构配色（顶点色）。style='tang'：朱柱白壁、土朱斗拱、七朱八白；'ming'：朱柱红墙、青绿斗拱、旋子彩画。
 * 任意字段可覆盖：palette('ming', {col: 0x8a1f16, wall: 0xe8e2d4})
 */
export function palette(style = 'ming', o = {}) {
  const base =
    style === 'tang'
      ? {
          col: 0x9e3a26, // 柱（朱红偏土朱）
          colBase: 0xcfc8b8, // 柱础
          wall: 0xf0ebe0, // 白壁
          frame: 0x9e3a26, // 门窗框、槛
          door: 0x9a3522, // 门扇
          lattice: 0x9e3a26,
          dou: 0xa84a2c, // 斗
          gong: 0x9c3a24, // 拱
          ang: 0x9c3a24, // 昂
          armEnd: 0xeae0c8, // 拱头/昂嘴端面（白/赭）
          panel: 0xf2ede2, // 栱眼壁
          rafter: 0x94402a,
          rafterEnd: 0xf0e6cc,
          flyEnd: 0xf0e6cc,
          soffit: 0x9c4a30,
          fascia: 0x8f3a26,
          beamRow: 2, // 七朱八白
          plankRow: 3,
          stone: 0xd9d3c6,
          gable: 0xf0ebe0,
          boFeng: 0x9e3a26,
          railing: 0x9e3a26,
        }
      : {
          col: 0x9a2418,
          colBase: 0xd6d1c6,
          wall: 0x9a3024,
          frame: 0x9a2418,
          door: 0x962316,
          lattice: 0x962316,
          dou: 0x2f6a8a,
          gong: 0x2f7a58,
          ang: 0x2f6a8a,
          armEnd: 0x2f6a8a,
          panel: 0x9a3024,
          rafter: 0x2f7a58,
          rafterEnd: 0x2a5e9a,
          flyEnd: 0x3a8a4a,
          soffit: 0x8a2c20,
          fascia: 0x9a2418,
          beamRow: 0,
          plankRow: 0,
          stone: 0xefebe3,
          gable: 0x9a2418,
          boFeng: 0x9a2418,
          railing: 0x9a2418,
        };
  return { ...base, ...o };
}
