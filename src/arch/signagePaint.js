// 招牌文字图集：4096² 纹理页（最多 2 页），按“行段”（1024×72 px）分配给流式加载的区块，
// 每个区块把自己的招牌文字打包进若干行段，用 copyTextureToTexture 局部上传（不整页重传）。
// 另含所有 Canvas 绘制函数（招牌、银行标志、地铁标志/站名、公交站牌、灯箱海报）。

export const PAGE = 4096;
export const ROW = 72; // 行高（像素）
export const PAD = 3; // 上下留缝，防 mip 串色
export const CH = ROW - PAD * 2; // 单元内容高 66
export const SEG = 1024; // 行段宽
export const STATIC_H = 432; // 第 0 页顶部静态区（地铁标志、海报等）

export const SANS = '"PingFang SC","Hiragino Sans GB","Heiti SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
export const SERIF = '"Songti SC","STSong","Noto Serif CJK SC","SimSun","Hiragino Mincho ProN",serif';
export const LATIN = '"Helvetica Neue",Helvetica,Arial,sans-serif';
const FS = 50; // 标准字号

const hasLatin = (s) => /[A-Za-z]/.test(s);

export class SignAtlas {
  constructor(THREE, renderer, { maxPages = 2, anisotropy = 8 } = {}) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.maxPages = maxPages;
    this.anisotropy = anisotropy;
    this.pages = [];
    this.onPage = null;
    this.stage = document.createElement('canvas');
    this.stage.width = SEG;
    this.stage.height = ROW;
    this.g = this.stage.getContext('2d');
    this.src = new THREE.Texture(this.stage); // 仅作为 copyTextureToTexture 的源（从不参与渲染）
    this.src.flipY = false;
    this.dst = new THREE.Vector2();
    this.pending = new Set();
    this.usedSegs = 0;
  }
  addPage() {
    const T = this.THREE;
    const tex = new T.DataTexture(null, PAGE, PAGE, T.RGBAFormat, T.UnsignedByteType);
    tex.colorSpace = T.SRGBColorSpace;
    tex.flipY = false;
    tex.premultiplyAlpha = true; // 预乘：透明底发光字 mip 过滤时不出黑边（着色器按预乘合成）
    tex.generateMipmaps = true;
    tex.minFilter = T.LinearMipmapLinearFilter;
    tex.magFilter = T.LinearFilter;
    tex.anisotropy = this.anisotropy;
    tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping;
    tex.source.dataReady = false; // 只分配显存，不上传
    tex.needsUpdate = true;
    this.renderer.initTexture(tex);
    const index = this.pages.length;
    const free = [];
    const y0 = index === 0 ? STATIC_H : 0;
    for (let y = PAGE - ROW; y >= y0; y -= ROW) for (let x = PAGE - SEG; x >= 0; x -= SEG) free.push({ page: index, x, y });
    const page = { index, tex, free, total: free.length };
    this.pages.push(page);
    if (this.onPage) this.onPage(page);
    return page;
  }
  capacity() {
    let n = 0;
    for (const p of this.pages) n += p.free.length;
    return n + (this.maxPages - this.pages.length) * Math.floor(PAGE / ROW) * (PAGE / SEG);
  }
  alloc() {
    for (const p of this.pages) if (p.free.length) { this.usedSegs++; return p.free.pop(); }
    if (this.pages.length < this.maxPages) { this.usedSegs++; return this.addPage().free.pop(); }
    return null;
  }
  free(seg) {
    this.usedSegs--;
    this.pages[seg.page].free.push(seg);
  }
  /** 把舞台画布（当前内容）上传到 seg；mip 在 flush 时统一生成 */
  upload(seg, canvas = this.stage) {
    const page = this.pages[seg.page];
    this.src.image = canvas;
    page.tex.generateMipmaps = false;
    this.dst.set(seg.x, seg.y);
    this.renderer.copyTextureToTexture(this.src, page.tex, null, this.dst);
    this.pending.add(page);
  }
  /** 只上传舞台画布 [x0, x1) 列到行段 seg 的对应位置（分帧绘制时增量上传） */
  uploadRegion(seg, x0, x1) {
    const page = this.pages[seg.page];
    this.src.image = this.stage;
    page.tex.generateMipmaps = false;
    const box = this.box || (this.box = new this.THREE.Box2());
    box.min.set(x0, 0);
    box.max.set(Math.min(SEG, x1), ROW);
    this.dst.set(seg.x + x0, seg.y);
    this.renderer.copyTextureToTexture(this.src, page.tex, box, this.dst);
    this.pending.add(page);
  }
  /** 为本批改动过的页生成一次 mipmap */
  flush() {
    if (!this.pending.size) return;
    const gl = this.renderer.getContext();
    const state = this.renderer.state;
    for (const page of this.pending) {
      page.tex.generateMipmaps = true;
      const p = this.renderer.properties.get(page.tex);
      if (!p.__webglTexture) continue;
      state.bindTexture(gl.TEXTURE_2D, p.__webglTexture);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    state.unbindTexture();
    this.pending.clear();
  }
  dispose() {
    for (const p of this.pages) p.tex.dispose();
  }
}

// ———————————————————— 测量与绘制 ————————————————————
let mctx = null;
function mc() {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  return mctx;
}
function fontFor(s, text, size = FS) {
  const fam = hasLatin(text) && !/[㐀-鿿]/.test(text) ? LATIN : s.serif ? SERIF : SANS;
  const w = s.serif ? 800 : hasLatin(text) ? 700 : 600;
  return `${w} ${size}px ${fam}`;
}
function darker(hex, k = 0.55) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) * k, g = ((n >> 8) & 255) * k, b = (n & 255) * k;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
function lighter(hex, k = 0.55) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => (v + (255 - v) * k) | 0;
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/**
 * 招牌单元尺寸（像素，高度固定 CH）。vertical：竖排（绘制时每字旋转 -90°，着色器再转回）。
 * 返回 {w, size}（size = 实际字号）
 */
export function measureSign(s, text, vertical = false) {
  const g = mc();
  let size = s.type === 'ticker' ? 40 : FS;
  const emb = s.emblem && !vertical ? CH * 0.95 : 0;
  const pad = s.type === 'led' || s.type === 'neon' ? 10 : CH * 0.32;
  if (vertical) {
    const n = [...text].length;
    const w = pad * 2 + n * size * 1.06 + emb;
    return { w: Math.min(SEG - 8, Math.ceil(w)), size, pad };
  }
  g.font = fontFor(s, text, size);
  let tw = g.measureText(text).width + [...text].length * size * 0.04;
  let w = pad * 2 + tw + emb;
  if (w > SEG - 8) {
    size = Math.max(24, Math.floor((size * (SEG - 8 - pad * 2 - emb)) / tw));
    g.font = fontFor(s, text, size);
    tw = g.measureText(text).width + [...text].length * size * 0.04;
    w = pad * 2 + tw + emb;
  }
  return { w: Math.min(SEG - 8, Math.ceil(w)), size, pad };
}

function drawEmblem(g, kind, cx, cy, e, fg, bg, ch) {
  g.save();
  const r = e * 0.42;
  g.lineWidth = e * 0.085;
  g.strokeStyle = fg;
  g.fillStyle = fg;
  if (kind === 'm') {
    g.font = `900 ${e * 1.05}px ${LATIN}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('M', cx, cy + e * 0.04);
  } else if (kind === 'cross') {
    const a = e * 0.36, b = e * 0.12;
    g.fillRect(cx - a, cy - b, a * 2, b * 2);
    g.fillRect(cx - b, cy - a, b * 2, a * 2);
  } else if (kind === 'cup') {
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    g.fillRect(cx - r * 0.42, cy - r * 0.35, r * 0.7, r * 0.8);
    g.beginPath(); g.arc(cx + r * 0.32, cy + r * 0.02, r * 0.2, -Math.PI / 2, Math.PI / 2); g.stroke();
  } else {
    // 圆形钱币式标志
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    if (kind === 'boc') {
      g.strokeRect(cx - r * 0.42, cy - r * 0.32, r * 0.84, r * 0.64);
      g.fillRect(cx - r * 0.06, cy - r * 0.95, r * 0.12, r * 1.9);
    } else if (kind === 'icbc') {
      g.strokeRect(cx - r * 0.5, cy - r * 0.5, r, r);
      g.fillRect(cx - r * 0.34, cy - r * 0.3, r * 0.68, r * 0.12);
      g.fillRect(cx - r * 0.34, cy + r * 0.18, r * 0.68, r * 0.12);
      g.fillRect(cx - r * 0.06, cy - r * 0.3, r * 0.12, r * 0.6);
    } else if (kind === 'ccb') {
      g.save(); g.translate(cx, cy); g.rotate(Math.PI / 4);
      g.fillStyle = bg || '#000';
      g.fillRect(-r * 0.36, -r * 0.36, r * 0.72, r * 0.72);
      g.strokeRect(-r * 0.36, -r * 0.36, r * 0.72, r * 0.72);
      g.restore();
      g.fillRect(cx - r * 0.06, cy - r, r * 0.12, r * 0.5);
    } else {
      const c = kind === 'abc' ? '农' : kind === 'post' ? '邮' : ch || '行';
      g.font = `700 ${r * 1.15}px ${SANS}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(c, cx, cy + r * 0.06);
    }
  }
  g.restore();
}

function fillTextSpaced(g, text, x, y, size, stroke) {
  const chars = [...text];
  const sp = size * 0.04;
  for (const ch of chars) {
    if (stroke) g.strokeText(ch, x, y);
    g.fillText(ch, x, y);
    x += g.measureText(ch).width + sp;
  }
}

/** 在 (x, y) 处绘制 w×CH 的招牌单元。s = 样式；m = measureSign 结果 */
export function paintSign(g, x, y, w, s, text, m, vertical = false) {
  const h = CH;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  const t = s.type;
  const fg = s.fg || '#ffffff';
  if (t === 'lightbox' || t === 'plaque' || t === 'trad' || t === 'ticker' || (t === 'neon' && s.back)) {
    g.fillStyle = t === 'ticker' ? '#0b0b0b' : t === 'neon' ? s.back : s.bg || '#ffffff';
    g.fillRect(x, y, w, h);
  }
  if (t === 'trad') {
    g.strokeStyle = s.frame || '#b08d3c';
    g.lineWidth = 3;
    g.strokeRect(x + 3, y + 3, w - 6, h - 6);
    g.lineWidth = 1.2;
    g.strokeRect(x + 8, y + 8, w - 16, h - 16);
  } else if (t === 'plaque' && s.frame) {
    g.strokeStyle = s.frame;
    g.lineWidth = 2;
    g.strokeRect(x + 5, y + 5, w - 10, h - 10);
  } else if (t === 'lightbox') {
    // 灯箱边缘略暗（亚克力面板的阴影过渡）
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, 'rgba(0,0,0,0.10)');
    gr.addColorStop(0.12, 'rgba(0,0,0,0)');
    gr.addColorStop(0.88, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
  }
  const size = m.size;
  g.font = fontFor(s, text, size);
  g.textBaseline = 'middle';
  let tx = x + m.pad;
  const cy = y + h * 0.53;
  if (s.emblem && !vertical) {
    const e = CH * 0.95;
    drawEmblem(g, s.emblem, tx + e * 0.45, y + h / 2, e * 0.92, s.emblemColor || fg, s.bg, s.emblemChar);
    tx += e;
  }
  if (t === 'led') {
    g.strokeStyle = darker(fg, 0.45);
    g.lineWidth = size * 0.07;
    g.lineJoin = 'round';
  } else if (t === 'neon') {
    g.shadowColor = fg;
    g.shadowBlur = size * 0.22;
    g.strokeStyle = fg;
    g.lineWidth = size * 0.1;
    g.lineJoin = 'round';
  }
  g.fillStyle = t === 'neon' ? lighter(fg, 0.62) : t === 'ticker' ? fg || '#ff4b1f' : fg;
  const stroke = t === 'led' || t === 'neon';
  if (vertical) {
    g.textAlign = 'center';
    let cx = x + m.pad + size * 0.53;
    for (const ch of text) {
      g.save();
      g.translate(cx, y + h / 2);
      g.rotate(-Math.PI / 2);
      if (stroke) g.strokeText(ch, 0, size * 0.03);
      g.fillText(ch, 0, size * 0.03);
      g.restore();
      cx += size * 1.06;
    }
  } else {
    g.textAlign = 'left';
    fillTextSpaced(g, text, tx, cy, size, stroke);
  }
  g.shadowBlur = 0;
  if (t === 'ticker' || s.dots) {
    // LED 点阵：栅格暗线
    g.fillStyle = t === 'ticker' ? 'rgba(8,8,8,0.9)' : 'rgba(10,10,10,0.55)';
    for (let i = x; i < x + w; i += 4) g.fillRect(i, y, 1.4, h);
    for (let j = y; j < y + h; j += 4) g.fillRect(x, j, w, 1.4);
  }
  g.restore();
}

// ———————————————————— 地铁 ————————————————————
export const LINE_COLORS = {
  1: '#0077C8', 2: '#EF3340', 3: '#CE70CC', 4: '#2CCCD3', 5: '#A6E35F', 6: '#485CC7', 8: '#DEAE39',
  9: '#FF9E1B', 10: '#4AAA94', 14: '#00C1D4', 15: '#CE607E', 16: '#DE8663',
};
const METRO_RED = '#e60012';

/** 西安地铁标志：红色圆角方块 + 白色城墙垛口带 */
export function paintMetroLogo(g, x, y, s) {
  g.save();
  const r = s * 0.14;
  g.fillStyle = METRO_RED;
  g.beginPath();
  g.roundRect(x, y, s, s, r);
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = s * 0.105;
  g.lineJoin = 'round';
  g.lineCap = 'butt';
  const P = (u, v) => [x + u * s, y + v * s];
  const pts = [[0, 0.7], [0.1, 0.7], [0.1, 0.5], [0.46, 0.5], [0.46, 0.64], [0.56, 0.64], [0.56, 0.5], [0.92, 0.5], [0.92, 0.7], [1, 0.7]];
  g.beginPath();
  pts.forEach(([u, v], i) => (i ? g.lineTo(...P(u, v)) : g.moveTo(...P(u, v))));
  g.save();
  g.clip(new Path2D(`M${x} ${y}h${s}v${s}h${-s}z`));
  g.stroke();
  g.restore();
  // 垛口下的红色拱形
  g.fillStyle = METRO_RED;
  for (const u of [0.22, 0.72]) {
    g.beginPath();
    g.moveTo(x + (u - 0.07) * s, y + 0.72 * s);
    g.lineTo(x + (u - 0.07) * s, y + 0.62 * s);
    g.arc(x + u * s, y + 0.62 * s, 0.07 * s, Math.PI, 0);
    g.lineTo(x + (u + 0.07) * s, y + 0.72 * s);
    g.fill();
  }
  g.restore();
}

/** 地铁口顶部蓝色标牌：标志 + 西安地铁 + XI'AN METRO */
export function paintMetroBoard(g, x, y, w, h) {
  g.save();
  g.fillStyle = '#1f78c1';
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fillRect(x, y, w, h * 0.08);
  const s = h * 0.62;
  paintMetroLogo(g, x + h * 0.2, y + (h - s) / 2, s);
  g.fillStyle = '#ffffff';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.font = `700 ${h * 0.4}px ${SANS}`;
  const tx = x + h * 0.2 + s + h * 0.18;
  g.fillText('西安地铁', tx, y + h * 0.55);
  g.font = `700 ${h * 0.17}px ${LATIN}`;
  g.fillText("XI'AN METRO", tx + 2, y + h * 0.82);
  g.restore();
}

/** 线路色块“2号线” */
function lineBadge(g, x, y, h, n, withText = true) {
  const col = LINE_COLORS[n] || '#888888';
  g.font = `700 ${h * 0.62}px ${SANS}`;
  const label = withText ? `${n}号线` : String(n);
  const w = g.measureText(label).width + h * 0.5;
  g.fillStyle = col;
  g.beginPath();
  g.roundRect(x, y, w, h, h * 0.18);
  g.fill();
  g.fillStyle = n === 5 || n === 8 || n === 10 || n === 14 ? '#111111' : '#ffffff';
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(label, x + h * 0.25, y + h * 0.54);
  return w;
}

export function measureMetroHeader(name, lines, exit) {
  const g = mc();
  g.font = `700 ${44}px ${SANS}`;
  let w = 24 + g.measureText(name + '站').width + 24;
  g.font = `700 ${26}px ${SANS}`;
  for (const n of lines) w += g.measureText(`${n}号线`).width + 21;
  w += 70 + 20;
  return Math.min(SEG - 8, Math.ceil(w));
}
/** 地铁口门头：深灰底 + 线路色块 + 黄色站名 + 出口字母 */
export function paintMetroHeader(g, x, y, w, name, lines, exit) {
  const h = CH;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#2a2f35';
  g.fillRect(x, y, w, h);
  let cx = x + 16;
  for (const n of lines) cx += lineBadge(g, cx, y + h * 0.27, h * 0.46, n) + 8;
  g.fillStyle = '#f5c518';
  g.font = `700 44px ${SANS}`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(name + '站', cx + 8, y + h * 0.54);
  // 出口字母
  const ex = x + w - 70;
  g.fillStyle = '#f5c518';
  g.fillRect(ex, y + 8, 56, h - 16);
  g.fillStyle = '#1b1f24';
  g.font = `800 ${exit.length > 1 ? 30 : 40}px ${LATIN}`;
  g.textAlign = 'center';
  g.fillText(exit, ex + 28, y + h * 0.54);
  g.restore();
}
/** 立柱：出口字母（深底黄字） */
export function paintExitLetter(g, x, y, w, exit, lines) {
  const h = CH;
  g.save();
  g.fillStyle = '#23272c';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#f5c518';
  g.font = `800 ${exit.length > 1 ? 36 : 50}px ${LATIN}`;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillText(exit, x + h / 2, y + h * 0.54);
  let cx = x + h;
  for (const n of lines) cx += lineBadge(g, cx, y + h * 0.18, h * 0.64, n, false) + 6;
  g.restore();
}
export function measureExitLetter(lines) {
  return CH + lines.length * 40 + 8;
}

// ———————————————————— 公交 ————————————————————
export function measureBusName(name, vertical) {
  const g = mc();
  if (vertical) return Math.min(SEG - 8, Math.ceil(24 + [...name].length * 46 + 80));
  g.font = `700 44px ${SANS}`;
  return Math.min(SEG - 8, Math.ceil(28 + g.measureText(name).width + 130));
}
/** 公交站名牌：蓝底白字 + 黄色“公交”标签（竖排时每字旋转） */
export function paintBusName(g, x, y, w, name, vertical) {
  const h = CH;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#1d4f91';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#ffffff';
  g.textBaseline = 'middle';
  if (vertical) {
    g.font = `700 42px ${SANS}`;
    g.textAlign = 'center';
    let cx = x + 14 + 23;
    for (const ch of name) {
      g.save(); g.translate(cx, y + h / 2); g.rotate(-Math.PI / 2); g.fillText(ch, 0, 2); g.restore();
      cx += 46;
    }
    g.fillStyle = '#f5c518';
    g.fillRect(x + w - 70, y + 6, 62, h - 12);
    g.fillStyle = '#1d4f91';
    g.font = `800 26px ${SANS}`;
    g.save(); g.translate(x + w - 39, y + h / 2); g.rotate(-Math.PI / 2); g.fillText('公交', 0, 1); g.restore();
  } else {
    g.font = `700 44px ${SANS}`;
    g.textAlign = 'left';
    g.fillText(name, x + 20, y + h * 0.54);
    g.fillStyle = '#f5c518';
    g.fillRect(x + w - 118, y + 12, 104, h - 24);
    g.fillStyle = '#1d4f91';
    g.font = `800 28px ${SANS}`;
    g.textAlign = 'center';
    g.fillText('公交车站', x + w - 66, y + h * 0.54);
  }
  g.restore();
}

// ———————————————————— 静态区（第 0 页顶部） ————————————————————
// 布局（像素）：地铁标志、地铁蓝牌、纯白、4 张灯箱海报
export const STATIC = {
  logo: [0, 0, 200, 200],
  board: [216, 0, 800, 200],
  white: [1032, 8, 48, 48],
  dark: [1032, 72, 48, 48],
  posters: [
    [1100, 0, 280, 420],
    [1396, 0, 280, 420],
    [1692, 0, 280, 420],
    [1988, 0, 280, 420],
  ],
};

function poster(g, x, y, w, h, k) {
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  const vtext = (str, cx, cy0, size, color, font = SANS, weight = 800) => {
    g.fillStyle = color;
    g.font = `${weight} ${size}px ${font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let cy = cy0;
    for (const ch of str) { g.fillText(ch, cx, cy); cy += size * 1.08; }
  };
  if (k === 0) {
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, '#8e1b16'); gr.addColorStop(1, '#3b0a08');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    // 塔的剪影
    g.fillStyle = 'rgba(240,190,90,0.35)';
    const cx = x + w * 0.7;
    for (let i = 0; i < 7; i++) {
      const ww = w * (0.34 - i * 0.035), yy = y + h * (0.88 - i * 0.085);
      g.fillRect(cx - ww / 2, yy, ww, h * 0.07);
    }
    vtext('千年古都', x + w * 0.28, y + h * 0.16, 44, '#f3cf7a', SERIF);
    vtext('常来长安', x + w * 0.5, y + h * 0.3, 34, '#ffffff', SERIF, 700);
  } else if (k === 1) {
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, '#0d1b3d'); gr.addColorStop(1, '#402060');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    for (let i = 0; i < 70; i++) {
      g.fillStyle = `rgba(255,${180 + ((i * 37) % 70)},90,${0.4 + ((i * 13) % 50) / 100})`;
      g.beginPath(); g.arc(x + ((i * 97) % w), y + h * 0.55 + ((i * 53) % (h * 0.4)), 2 + (i % 3), 0, Math.PI * 2); g.fill();
    }
    vtext('大唐不夜城', x + w * 0.5, y + h * 0.1, 40, '#ffd27a', SERIF);
  } else if (k === 2) {
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, '#6fb2e6'); gr.addColorStop(0.7, '#dfeef8'); gr.addColorStop(1, '#dfeef8');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    g.fillStyle = '#5d564c';
    const wy = y + h * 0.66;
    g.fillRect(x, wy, w, h * 0.34);
    for (let i = 0; i < w; i += 28) g.fillRect(x + i, wy - 14, 16, 14);
    g.fillStyle = '#3a2f28';
    g.fillRect(x + w * 0.4, wy - h * 0.16, w * 0.2, h * 0.16);
    g.fillStyle = '#6b1d15';
    g.beginPath(); g.moveTo(x + w * 0.3, wy - h * 0.16); g.lineTo(x + w * 0.7, wy - h * 0.16); g.lineTo(x + w * 0.5, wy - h * 0.26); g.fill();
    vtext('西安城墙', x + w * 0.5, y + h * 0.1, 40, '#1f3552', SERIF);
  } else {
    g.fillStyle = '#f4f1e8'; g.fillRect(x, y, w, h);
    g.fillStyle = '#c1121f'; g.fillRect(x, y, w, h * 0.2);
    g.fillStyle = '#ffffff'; g.font = `800 40px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('文明西安', x + w / 2, y + h * 0.1);
    vtext('你我共建', x + w * 0.5, y + h * 0.32, 44, '#c1121f');
    g.fillStyle = '#2b6a3e'; g.fillRect(x, y + h * 0.9, w, h * 0.1);
  }
  g.restore();
}

/** 绘制并上传第 0 页静态区 */
export function paintStatic(atlas) {
  const c = document.createElement('canvas');
  c.width = PAGE;
  c.height = STATIC_H;
  const g = c.getContext('2d');
  const L = STATIC.logo;
  paintMetroLogo(g, L[0] + 10, L[1] + 10, L[2] - 20);
  const Bd = STATIC.board;
  paintMetroBoard(g, Bd[0] + 4, Bd[1] + 4, Bd[2] - 8, Bd[3] - 8);
  g.fillStyle = '#ffffff';
  g.fillRect(...STATIC.white);
  g.fillStyle = '#1b1d20';
  g.fillRect(...STATIC.dark);
  STATIC.posters.forEach((p, k) => poster(g, p[0] + 4, p[1] + 4, p[2] - 8, p[3] - 8, k));
  const page = atlas.pages[0] || atlas.addPage();
  atlas.upload({ page: page.index, x: 0, y: 0 }, c);
  atlas.flush();
}
/** 静态区矩形 → 归一化 [u0, v0, du, dv]（内缩 inset 像素防串色） */
export function staticRect(r, inset = 6) {
  return [(r[0] + inset) / PAGE, (r[1] + inset) / PAGE, (r[2] - inset * 2) / PAGE, (r[3] - inset * 2) / PAGE];
}
