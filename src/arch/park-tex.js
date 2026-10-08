// 公园近景：程序化贴图（2D 纹理数组，每层 512²）与“块静态网格”共用材质。
//
// 一个块里的驳岸石壁、压顶、园路铺装、路缘石、亲水台阶、木栈道、护坡、公厕、导览牌、指示牌全部合成一个网格、一个材质：
// 顶点属性 aMat 选纹理层（平铺层按米换算 UV，标牌层直接用层内 UV），顶点色做色差。每块 1 次 draw call。
// 层：0 花岗岩园路板 1 透水砖（湖滨步道）2 防腐木栈道 3 毛石驳岸 4 青砖 5 小青瓦 6 六角护坡砖 7 细面花岗岩（压顶/路缘）
//     8 草坡 9 汉白玉 10 深色金属 11 混凝土 12 标牌条（公厕/健身步道/水深危险/爱护花草）13~14 园名牌槽位 15~16 导览图槽位
// 参考：西安兴庆宫公园/环城公园实景（花岗岩园路 + 汉白玉栏杆 + 毛石驳岸），公厕为仿古青砖灰瓦小屋（多处公园同款）。
import * as THREE from 'three';

export const L = { GRANITE: 0, BRICK: 1, WOOD: 2, MASONRY: 3, QINGZHUAN: 4, TILE: 5, HEX: 6, STONE: 7, BERM: 8, MARBLE: 9, METAL: 10, CONCRETE: 11, SIGNS: 12, NAMES: 13, MAPS: 15 };
const LAYERS = 17;
const S = 512;
// 每层平铺尺寸（米/张）与粗糙度
const TILE = [3.0, 2.4, 2.0, 3.2, 1.6, 2.0, 2.4, 2.0, 3.0, 1.5, 1.0, 3.0, 1, 1, 1, 1, 1];
const ROUGH = [0.82, 0.86, 0.72, 0.9, 0.9, 0.7, 0.92, 0.66, 0.97, 0.5, 0.42, 0.9, 0.6, 0.55, 0.55, 0.65, 0.65];
const METAL = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0.05, 0, 0, 0, 0];
// 标牌条（层 12，四条各 128 px 高）
export const SIGN_BANDS = { toilet: 0, fitness: 1, danger: 2, lawn: 3 };
export const FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif';

function rnd(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1e9) / 1e9;
  };
}
const mk = () => {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  return c;
};
/** 叠一层细噪声（亮度 ±amp）：直接改像素（逐格 fillRect 画 6 万个小方块太慢，启动多花 0.4 s） */
function grain(g, amp, seed, cell = 2) {
  const r = rnd(seed);
  const img = g.getImageData(0, 0, S, S), d = img.data;
  const nc = S / cell;
  const v = new Float32Array(nc * nc);
  for (let i = 0; i < v.length; i++) v[i] = (r() - 0.5) * amp;
  for (let y = 0; y < S; y++) {
    const row = ((y / cell) | 0) * nc;
    for (let x = 0; x < S; x++) {
      const k = v[row + ((x / cell) | 0)], o = (y * S + x) * 4;
      if (k > 0) { d[o] += (255 - d[o]) * k; d[o + 1] += (255 - d[o + 1]) * k; d[o + 2] += (255 - d[o + 2]) * k; }
      else { const m = 1 + k; d[o] *= m; d[o + 1] *= m; d[o + 2] *= m; }
    }
  }
  g.putImageData(img, 0, 0);
}
function shade(hex, k) {
  const c = new THREE.Color(hex);
  return `rgb(${Math.round(Math.min(255, c.r * 255 * k))},${Math.round(Math.min(255, c.g * 255 * k))},${Math.round(Math.min(255, c.b * 255 * k))})`;
}
/** 块料铺装：bw×bh 像素一块，错缝 offset，缝宽 joint */
function pavers(g, { bw, bh, offset = 0.5, joint = 3, base, jointCol, vary = 0.12, seed = 1, speck = 0.12 }) {
  const r = rnd(seed);
  g.fillStyle = jointCol;
  g.fillRect(0, 0, S, S);
  for (let row = 0, y = 0; y < S; row++, y += bh) {
    const off = (row % 2) * offset * bw;
    for (let x = -bw; x < S + bw; x += bw) {
      const k = 1 + (r() - 0.5) * vary * 2;
      g.fillStyle = shade(base, k);
      const x0 = Math.round(x + off), w = bw - joint;
      // 环绕：左右越界部分折回，保证无缝平铺
      for (const dx of [0, -S, S]) g.fillRect(x0 + dx, y, w, bh - joint);
    }
  }
  grain(g, speck, seed + 7, 2);
}

function paintLayer(i, g) {
  const r = rnd(100 + i);
  switch (i) {
    case 0: pavers(g, { bw: 102, bh: 51, base: '#a7a39b', jointCol: '#6d6a64', vary: 0.07, seed: 3, speck: 0.16 }); break; // 600×300 花岗岩（3 m/512 px）
    case 1: { // 300×150 透水砖：浅灰为主，夹少量暖灰（西安公园湖滨步道常见）
      pavers(g, { bw: 64, bh: 32, base: '#c2bdb4', jointCol: '#97928a', vary: 0.07, seed: 5, speck: 0.08 });
      const rr = rnd(9);
      for (let n = 0; n < 60; n++) { g.fillStyle = `rgba(160,120,100,${0.12 + rr() * 0.12})`; g.fillRect(Math.floor(rr() * 8) * 64 + (Math.floor(rr() * 16) % 2) * 32, Math.floor(rr() * 16) * 32, 61, 29); }
      break;
    }
    case 2: { // 防腐木：140 mm 宽板，纵向木纹 + 板缝 + 钉
      for (let x = 0; x < S; x += 36) {
        const k = 0.85 + r() * 0.3;
        g.fillStyle = shade('#8a6243', k);
        g.fillRect(x, 0, 34, S);
        for (let t = 0; t < 26; t++) { g.fillStyle = `rgba(60,35,18,${0.08 + r() * 0.12})`; g.fillRect(x + r() * 34, 0, 1 + r() * 2, S); }
        g.fillStyle = 'rgba(30,18,10,0.85)';
        g.fillRect(x + 34, 0, 2, S);
        const cut = r() * S;
        g.fillRect(x, cut, 34, 2);
        g.fillStyle = 'rgba(40,40,40,0.6)';
        for (const yy of [64, 320]) { g.fillRect(x + 6, yy, 3, 3); g.fillRect(x + 25, yy, 3, 3); }
      }
      break;
    }
    case 3: { // 毛石驳岸：不规则块石（3.2 m / 512 px），深缝
      g.fillStyle = '#4f4b45';
      g.fillRect(0, 0, S, S);
      for (let y = 0; y < S;) {
        const h = 38 + r() * 36;
        for (let x = -r() * 60; x < S;) {
          const w = 60 + r() * 70;
          const k = 0.8 + r() * 0.35;
          g.fillStyle = shade(r() < 0.25 ? '#9b8e7a' : '#8b877e', k);
          g.beginPath();
          const j = 4;
          g.moveTo(x + j + r() * 4, y + j + r() * 3);
          g.lineTo(x + w - j - r() * 4, y + j + r() * 3);
          g.lineTo(x + w - j - r() * 3, y + h - j - r() * 4);
          g.lineTo(x + j + r() * 3, y + h - j - r() * 4);
          g.closePath();
          g.fill();
          x += w;
        }
        y += h;
      }
      grain(g, 0.2, 13, 2);
      break;
    }
    case 4: pavers(g, { bw: 77, bh: 17, base: '#7d7f80', jointCol: '#a9a8a2', vary: 0.1, seed: 17, joint: 3 }); break; // 青砖 240×53（1.6 m）
    case 5: { // 小青瓦：竖向瓦垄（2 m / 512 px，垄距 ~0.2 m）
      for (let x = 0; x < S; x += 52) {
        const grd = g.createLinearGradient(x, 0, x + 52, 0);
        grd.addColorStop(0, '#2e3134'); grd.addColorStop(0.35, '#575b5f'); grd.addColorStop(0.6, '#4a4e52'); grd.addColorStop(1, '#25282b');
        g.fillStyle = grd;
        g.fillRect(x, 0, 52, S);
        for (let y = 0; y < S; y += 32) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, y, 52, 3); }
      }
      grain(g, 0.12, 21, 2);
      break;
    }
    case 6: { // 六角护坡砖（混凝土），缝里长草
      g.fillStyle = '#5d6a3f';
      g.fillRect(0, 0, S, S);
      const R = 46, W = R * Math.sqrt(3);
      for (let row = -1; row * R * 1.5 < S + R; row++)
        for (let col = -1; col * W < S + W; col++) {
          const cx = col * W + (row % 2 ? W / 2 : 0), cy = row * R * 1.5;
          g.fillStyle = shade('#a39d91', 0.85 + r() * 0.25);
          g.beginPath();
          for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; g.lineTo(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4)); }
          g.closePath();
          g.fill();
          g.fillStyle = 'rgba(70,90,45,0.55)';
          g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill(); // 中心植草孔
        }
      grain(g, 0.15, 29, 2);
      break;
    }
    case 7: g.fillStyle = '#b9b5ad'; g.fillRect(0, 0, S, S); grain(g, 0.14, 31, 2); grain(g, 0.06, 32, 8); break; // 细面花岗岩
    case 8: { // 草坡
      g.fillStyle = '#3f5427';
      g.fillRect(0, 0, S, S);
      for (let n = 0; n < 9000; n++) { g.fillStyle = `rgba(${90 + r() * 60},${110 + r() * 60},${40 + r() * 30},${0.25 + r() * 0.3})`; g.fillRect(r() * S, r() * S, 1 + r() * 2, 3 + r() * 6); }
      break;
    }
    case 9: g.fillStyle = '#dcd8cf'; g.fillRect(0, 0, S, S); grain(g, 0.08, 41, 2); grain(g, 0.05, 42, 16); break; // 汉白玉
    case 10: g.fillStyle = '#2a2c2e'; g.fillRect(0, 0, S, S); grain(g, 0.05, 51, 4); break; // 深色金属（漆面）
    case 11: g.fillStyle = '#9d9a93'; g.fillRect(0, 0, S, S); grain(g, 0.16, 61, 2); grain(g, 0.06, 62, 32); g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, 0, S, 2); g.fillRect(0, 0, 2, S); break; // 混凝土（3 m 分缝）
    case 12: paintSigns(g); break;
    default: g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, S, S); break;
  }
}

function paintSigns(g) {
  const band = (k, bg, fg, text, icon) => {
    const y = k * 128;
    g.fillStyle = bg;
    g.fillRect(0, y, S, 128);
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 5;
    g.strokeRect(8, y + 8, S - 16, 112);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 66px ${FONT}`;
    g.fillText(text, icon ? 290 : S / 2, y + 66);
    if (icon) icon(y);
  };
  // 公厕：深绿底白字 + 男女图标
  band(0, '#1f4a3a', '#f2efe6', '公共厕所', (y) => {
    g.fillStyle = '#f2efe6';
    for (const [x, skirt] of [[52, false], [104, true]]) {
      g.beginPath(); g.arc(x, y + 34, 11, 0, Math.PI * 2); g.fill();
      if (skirt) { g.beginPath(); g.moveTo(x, y + 48); g.lineTo(x + 18, y + 92); g.lineTo(x - 18, y + 92); g.closePath(); g.fill(); }
      else g.fillRect(x - 12, y + 48, 24, 44);
      g.fillRect(x - 9, y + 90, 7, 24); g.fillRect(x + 2, y + 90, 7, 24);
    }
  });
  // 健身步道：蓝底 + 跑步小人
  band(1, '#1d5a9e', '#ffffff', '健身步道', (y) => {
    g.strokeStyle = '#ffffff'; g.lineWidth = 9; g.lineCap = 'round';
    g.beginPath(); g.arc(92, y + 30, 11, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.beginPath(); g.moveTo(86, y + 46); g.lineTo(76, y + 78); g.lineTo(54, y + 104); g.moveTo(76, y + 78); g.lineTo(100, y + 92); g.lineTo(96, y + 116);
    g.moveTo(84, y + 52); g.lineTo(60, y + 64); g.moveTo(84, y + 52); g.lineTo(112, y + 62); g.stroke();
  });
  // 水深危险 禁止游泳：黄底黑字 + 红圈
  band(2, '#f0c419', '#1b1b1b', '水深危险', (y) => {
    g.strokeStyle = '#c8261d'; g.lineWidth = 12;
    g.beginPath(); g.arc(80, y + 64, 40, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(52, y + 36); g.lineTo(108, y + 92); g.stroke();
    g.fillStyle = '#1d5a9e'; g.fillRect(56, y + 70, 48, 8);
  });
  // 爱护花草：绿底白字
  band(3, '#3f7a35', '#ffffff', '爱护花草', (y) => {
    g.fillStyle = '#f2efe6';
    g.beginPath(); g.ellipse(70, y + 70, 18, 34, -0.5, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(104, y + 70, 18, 34, 0.5, 0, Math.PI * 2); g.fill();
    g.fillRect(84, y + 80, 6, 40);
  });
}

/**
 * 纹理数组 + 动态槽位（园名牌、导览图）。槽位按 LRU 复用：同一公园再次进入视野不重画。
 */
export class ParkTextures {
  constructor(ctx) {
    this.data = new Uint8Array(S * S * 4 * LAYERS);
    const cv = mk();
    const g = cv.getContext('2d', { willReadFrequently: true });
    for (let i = 0; i < LAYERS; i++) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, S, S);
      paintLayer(i, g);
      this.data.set(g.getImageData(0, 0, S, S).data, i * S * S * 4);
    }
    const t = new THREE.DataArrayTexture(this.data, S, S, LAYERS);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = Math.min(8, ctx.quality?.anisotropy || 4);
    t.needsUpdate = true;
    // 首次上传之前不能登记“只更新某层”：three 的纹理数组首次分配后若有 layerUpdates 只上传这些层，其余层是空的（黑）
    this.uploaded = false;
    t.onUpdate = () => { this.uploaded = true; };
    this.tex = t;
    this.cv = cv;
    this.g = g;
    this.names = new Map(); // 园名 → 槽位
    this.maps = new Map(); // 公园 id → 槽位
    this.nameUse = [];
    this.mapUse = [];
  }

  _upload(layer) {
    this.data.set(this.g.getImageData(0, 0, S, S).data, layer * S * S * 4);
    if (this.uploaded && this.tex.addLayerUpdate) this.tex.addLayerUpdate(layer);
    this.tex.needsUpdate = true;
  }
  _readLayer(layer) {
    const img = new ImageData(new Uint8ClampedArray(this.data.buffer, layer * S * S * 4, S * S * 4).slice(), S, S);
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.putImageData(img, 0, 0);
  }

  /** 园名牌槽位：返回层内 UV 矩形 {layer, u0, v0, u1, v1}（12 个槽：层 13~14 各 6 条，512×85） */
  nameSlot(text) {
    if (this.names.has(text)) { this._touch(this.nameUse, text); return this.names.get(text); }
    let k = this.names.size;
    if (k >= 12) { const old = this.nameUse.shift(); k = this.names.get(old).k; this.names.delete(old); }
    const layer = L.NAMES + Math.floor(k / 6), row = k % 6, H = 85;
    this._readLayer(layer);
    const g = this.g, y = row * H;
    g.fillStyle = '#efe6d2';
    g.fillRect(0, y, S, H);
    g.strokeStyle = '#8c6a3a'; g.lineWidth = 6; g.strokeRect(4, y + 4, S - 8, H - 8);
    g.fillStyle = '#5a2a16';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    let fs = 58;
    g.font = `700 ${fs}px "Songti SC","STSong","Noto Serif CJK SC","SimSun",serif`;
    while (g.measureText(text).width > S - 40 && fs > 24) { fs -= 4; g.font = `700 ${fs}px "Songti SC","STSong","Noto Serif CJK SC","SimSun",serif`; }
    g.fillText(text, S / 2, y + H / 2 + 2);
    this._upload(layer);
    const slot = { k, layer, u0: 0.01, u1: 0.99, v0: (y + 3) / S, v1: (y + H - 3) / S };
    this.names.set(text, slot);
    this.nameUse.push(text);
    return slot;
  }

  /** 导览图槽位：draw(g, x, y, size) 由调用者画图（256×256），返回 {layer, u0, v0, u1, v1}（8 个槽：层 15~16 各 4 格） */
  mapSlot(key, draw) {
    if (this.maps.has(key)) { this._touch(this.mapUse, key); return this.maps.get(key); }
    let k = this.maps.size;
    if (k >= 8) { const old = this.mapUse.shift(); k = this.maps.get(old).k; this.maps.delete(old); }
    const layer = L.MAPS + Math.floor(k / 4), q = k % 4, x = (q % 2) * 256, y = Math.floor(q / 2) * 256;
    this._readLayer(layer);
    this.g.save();
    this.g.beginPath(); this.g.rect(x, y, 256, 256); this.g.clip();
    draw(this.g, x, y, 256);
    this.g.restore();
    this._upload(layer);
    const slot = { k, layer, u0: (x + 2) / S, u1: (x + 254) / S, v0: (y + 2) / S, v1: (y + 254) / S };
    this.maps.set(key, slot);
    this.mapUse.push(key);
    return slot;
  }
  _touch(list, key) { const i = list.indexOf(key); if (i >= 0) { list.splice(i, 1); list.push(key); } }
}

/** 块静态网格材质：MeshStandardMaterial + 纹理数组取样（aMat 选层）+ 顶点色；对地面层做少量深度偏移防闪 */
export function staticMaterial(ctx, tex) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0 });
  m.name = 'park-static';
  const U = { uParkTex: { value: tex }, uTile: { value: TILE }, uRough: { value: ROUGH }, uMetal: { value: METAL } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMat;\nvarying float vMat;\nvarying vec2 vPUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat;\nvPUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform highp sampler2DArray uParkTex;
uniform float uTile[${LAYERS}];
uniform float uRough[${LAYERS}];
uniform float uMetal[${LAYERS}];
varying float vMat;
varying vec2 vPUv;`)
      .replace('#include <map_fragment>', `
int pmi = int(vMat + 0.5);
vec2 puv = pmi >= ${L.SIGNS} ? vPUv : vPUv / uTile[pmi];
vec4 ptex = texture(uParkTex, vec3(puv, float(pmi)));
diffuseColor.rgb *= ptex.rgb;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = uRough[pmi];')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = uMetal[pmi];');
  };
  m.customProgramCacheKey = () => 'park-static-v1';
  return m;
}
