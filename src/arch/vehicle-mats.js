// 车辆材质（traffic.js 用）：逐顶点材质参数 + 实例车漆色 + 车型/选项折叠 + 三目标形变 + 号牌贴图 + 夜间灯光。
// 实例属性：iColor = (车漆 rgb, 第二色)  第二色 > 1.5 时为 0xRRGGBB 打包整数（外卖箱、公交色带等），否则用 uSecond 调色板；
//          iData  = (车型 / 列车型, 灯光标志位, 形状(小汽车 0 轿车 1 SUV 2 MPV；两轮车 = 选项位), 打包: 第二色号 + 号牌类型×16 + 牌号种子×64)
import * as THREE from 'three';
import { DOOR_Z } from './vehicle-cars.js';

// ———————————————————— 号牌贴图 ————————————————————
// 图集 4 列 × 8 行，每格 256×80：0~2 行蓝牌（小型车，白字）、3~5 行渐变绿牌（小型新能源，黑字，“D/F”开头 6 位）、
// 6 行黄牌（大型车，黑字）、7 行黄绿双拼牌（大型新能源，公交），全部“陕A”。
const PW = 256, PH = 80;
let plateTex = null;
function plateTexture() {
  if (plateTex) return plateTex;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = PW * 4; c.height = PH * 8;
  const g = c.getContext('2d');
  let s = 20251008;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ', DG = '0123456789';
  const ch = (k) => (k < 0.25 ? AL[(r() * AL.length) | 0] : DG[(r() * 10) | 0]);
  const fam = '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
  for (let row = 0; row < 8; row++)
    for (let colI = 0; colI < 4; colI++) {
      const x = colI * PW, y = row * PH;
      const type = row < 3 ? 0 : row < 6 ? 1 : row === 6 ? 2 : 3;
      let bg, fg;
      if (type === 0) { bg = '#0b45a6'; fg = '#f4f6f8'; }
      else if (type === 1) { const gr = g.createLinearGradient(0, y, 0, y + PH); gr.addColorStop(0, '#f2fbf3'); gr.addColorStop(1, '#3fbf6a'); bg = gr; fg = '#111'; }
      else if (type === 2) { bg = '#f2b705'; fg = '#111'; }
      else { const gr = g.createLinearGradient(x, 0, x + PW, 0); gr.addColorStop(0, '#f2b705'); gr.addColorStop(0.3, '#f2b705'); gr.addColorStop(0.31, '#3fbf6a'); gr.addColorStop(1, '#3fbf6a'); bg = gr; fg = '#111'; }
      g.fillStyle = bg;
      g.fillRect(x, y, PW, PH);
      g.strokeStyle = fg;
      g.lineWidth = 3;
      g.strokeRect(x + 4, y + 4, PW - 8, PH - 8);
      let num = '';
      if (type === 1) num = (r() < 0.6 ? 'D' : 'F') + [0, 1, 2, 3, 4].map(() => DG[(r() * 10) | 0]).join('');
      else num = [0, 1, 2, 3, 4].map((k) => ch(k === 0 ? r() * 0.6 : r())).join('');
      g.fillStyle = fg;
      g.textBaseline = 'middle';
      g.font = `bold 50px ${fam}`;
      g.fillText('陕A', x + 12, y + PH / 2 + 2);
      g.beginPath(); g.arc(x + 98, y + PH / 2, 4, 0, Math.PI * 2); g.fill();
      g.font = `bold ${type === 1 ? 46 : 52}px "DIN Alternate","Helvetica Neue",Arial,sans-serif`;
      const w0 = g.measureText(num).width, room = PW - 116;
      g.save();
      g.translate(x + 108, y + PH / 2 + 2);
      g.scale(Math.min(1, room / w0), 1);
      g.fillText(num, 0, 0);
      g.restore();
    }
  plateTex = new THREE.CanvasTexture(c);
  plateTex.colorSpace = THREE.SRGBColorSpace;
  plateTex.anisotropy = 4;
  plateTex.generateMipmaps = true;
  plateTex.minFilter = THREE.LinearMipmapLinearFilter;
  return plateTex;
}

const PLATE_GLSL = /* glsl */ `
vec3 trPlate(float p) {
  if (p < 0.5) return vec3(0.02, 0.09, 0.42);
  if (p < 1.5) return vec3(0.18, 0.55, 0.22);
  if (p < 2.5) return vec3(0.85, 0.6, 0.03);
  return vec3(0.42, 0.66, 0.12);
}
float trBit(float f, float b) { return mod(floor(f / b), 2.0); }
`;

/**
 * 近景车辆/列车材质。opts：morph（小汽车三目标形变 + 门缝细节）、train（列车灯光规则）、bike（两轮车：按选项位折叠）、secondLin（第二色调色板）
 */
export function nearMaterial(ctx, { morph = false, train = false, bike = false, secondLin }) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.0 });
  const tex = plateTexture();
  const decl = /* glsl */ `
attribute vec4 aMat;
attribute vec3 aKU;
attribute vec4 iColor;
attribute vec4 iData;
${morph ? 'attribute vec3 position2;\nattribute vec3 normal2;\nattribute vec3 position3;\nattribute vec3 normal3;' : ''}
varying vec4 vTrMat;
varying vec3 vTrBody;
varying vec3 vTrSecond;
varying vec4 vTrInfo;
varying vec3 vTrLocal;
varying vec2 vTrUv;
`;
  const fold = bike
    ? 'if (aKU.x > -0.5 && (int(aKU.x + 0.5) & int(iData.z + 0.5)) == 0) transformed = vec3(0.0);'
    : 'if (aKU.x > -0.5 && abs(aKU.x - iData.x) > 0.5) transformed = vec3(0.0);';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.uniforms.uSecond = { value: secondLin };
    sh.uniforms.uPlateTex = { value: tex };
    sh.uniforms.uDoor = { value: DOOR_Z.map((d) => new THREE.Vector4(...d)) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + decl)
      .replace('#include <beginnormal_vertex>', morph
        ? 'vec3 objectNormal = iData.z < 0.5 ? normal : iData.z < 1.5 ? normal2 : normal3;'
        : '#include <beginnormal_vertex>')
      .replace('#include <begin_vertex>', /* glsl */ `
vec3 transformed = ${morph ? '(iData.z < 0.5 ? position : iData.z < 1.5 ? position2 : position3)' : 'vec3(position)'};
${fold}
vTrMat = aMat; vTrBody = iColor.rgb; vTrInfo = iData; vTrLocal = transformed; vTrUv = aKU.yz;
{
  float f = floor(iColor.w + 0.5);
  vTrSecond = iColor.w > 1.5 ? pow(vec3(floor(f / 65536.0), mod(floor(f / 256.0), 256.0), mod(f, 256.0)) / 255.0, vec3(2.2)) : vec3(-1.0);
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
uniform float uNight;
uniform float uTime;
uniform vec3 uSecond[8];
uniform sampler2D uPlateTex;
uniform vec4 uDoor[3];
varying vec4 vTrMat;
varying vec3 vTrBody;
varying vec3 vTrSecond;
varying vec4 vTrInfo;
varying vec3 vTrLocal;
varying vec2 vTrUv;
float trTrim = 0.0;
${PLATE_GLSL}`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
{
  float pm = vTrMat.x;
  float pack = vTrInfo.w;
  if (pm > 0.5 && pm < 1.5) {
    diffuseColor.rgb = vTrBody * vColor.rgb;
    ${morph ? /* glsl */ `
    // 门缝与门把手（局部坐标，按车形取门位置）
    vec3 lp = vTrLocal;
    int shp = int(vTrInfo.z + 0.5);
    vec4 dz = uDoor[shp];
    float belt = shp == 0 ? 0.93 : 1.06;
    if (abs(lp.x) > 0.8 && lp.y > 0.4 && lp.y < belt) {
      float aa = max(fwidth(lp.z) * 1.2, 0.002);
      float seam = 0.0;
      for (int k = 0; k < 3; k++) { float zz = k == 0 ? dz.x : k == 1 ? dz.y : dz.z; seam = max(seam, 1.0 - smoothstep(0.004, 0.004 + aa, abs(lp.z - zz))); }
      diffuseColor.rgb *= 1.0 - 0.75 * seam;
      float hy = belt - 0.1;
      float hd = 0.0;
      for (int k = 0; k < 2; k++) { float zz = (k == 0 ? dz.y : dz.z) + 0.16; hd = max(hd, step(abs(lp.z - zz), 0.1) * step(abs(lp.y - hy), 0.018)); }
      if (hd > 0.5) { diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6), 0.5); trTrim = 2.0; }
    }` : ''}
  }
  else if (pm > 1.5 && pm < 2.5) {
    float sc = mod(pack, 16.0);
    diffuseColor.rgb = (vTrSecond.x >= 0.0 ? vTrSecond : sc > 7.5 ? vTrBody : uSecond[int(sc)]) * vColor.rgb;
  }
  else if (pm > 2.5 && pm < 3.5) {
    float pt = mod(floor(pack / 16.0), 4.0);
    if (vTrUv.x >= 0.0) {
      float seed = floor(pack / 64.0);
      float row = pt < 0.5 ? mod(seed, 3.0) : pt < 1.5 ? 3.0 + mod(seed, 3.0) : pt < 2.5 ? 6.0 : 7.0;
      float cl = mod(floor(seed / 3.0), 4.0);
      vec2 uv = vec2((cl + 0.02 + vTrUv.x * 0.96) / 4.0, 1.0 - (row + 0.98 - vTrUv.y * 0.96) / 8.0);
      diffuseColor.rgb = texture2D(uPlateTex, uv).rgb * 0.85;
    } else diffuseColor.rgb = trPlate(pt);
  }
  else if (pm > 4.5) {
    // 车窗：深色贴膜，隐约透见座椅头枕；金属度 0 + 低粗糙度，反射由环境贴图按菲涅耳给出
    vec3 lp = vTrLocal;
    int shp = int(vTrInfo.z + 0.5);
    float hy = shp == 0 ? 1.17 : shp == 1 ? 1.33 : 1.36;
    float hr = 0.0;
    if (abs(lp.x) > 0.62) {
      for (int k = 0; k < 2; k++) {
        float sz = k == 0 ? 0.02 : -0.86;
        hr = max(hr, smoothstep(1.0, 0.55, length(vec2((lp.z - sz) / 0.15, (lp.y - hy) / 0.13))));
      }
    } else {
      hr = smoothstep(1.0, 0.55, length(vec2((abs(lp.x) - 0.4) / 0.14, (lp.y - hy) / 0.13)));
    }
    float lowK = smoothstep(hy + 0.25, hy - 0.35, lp.y);
    diffuseColor.rgb = vec3(0.012, 0.015, 0.018) + vec3(0.03, 0.028, 0.026) * max(hr, 0.35 * lowK);
    ${morph ? /* glsl */ `
    // B 柱（亮黑饰板）
    if (abs(lp.x) > 0.6 && abs(lp.z - uDoor[shp].w) < 0.055) { diffuseColor.rgb = vec3(0.01); trTrim = 1.0; }` : ''}
  }
  else if (pm > 3.5) diffuseColor.rgb = vTrBody;
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = trTrim > 0.5 ? 0.25 : vTrMat.y;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = trTrim > 1.5 ? 0.9 : vTrMat.z;')
      .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
{
  float em = floor(vTrMat.w + 0.5);
  float fl = vTrInfo.y;
  float nt = uNight;
  vec3 E = vec3(0.0);
  ${train ? /* glsl */ `
  if (em > 7.5 && em < 8.5) {
    if (trBit(fl, 1.0) > 0.5) E = vec3(1.0, 0.95, 0.86) * (0.6 + nt * 9.0);
    else if (trBit(fl, 2.0) > 0.5) E = vec3(1.0, 0.05, 0.03) * (0.3 + nt * 4.0);
  } else if (em > 9.5 && em < 10.5) {
    E = vec3(1.0, 0.9, 0.72) * nt * 0.6;
  } else if (em > 4.5 && em < 5.5) {
    E = vec3(1.0, 0.9, 0.72) * nt * 0.5;
  }` : /* glsl */ `
  float blink = step(0.5, fract(uTime * 1.4 + vTrInfo.w * 0.013));
  if (em > 0.5 && em < 1.5) E = vec3(1.0, 0.95, 0.85) * (nt * 7.0) * (1.0 - trBit(fl, 16.0));
  else if (em > 1.5 && em < 2.5) E = vec3(1.0, 0.03, 0.015) * (trBit(fl, 1.0) > 0.5 ? 7.0 : (0.05 + nt * 3.2) * (1.0 - trBit(fl, 16.0)));
  else if (em > 2.5 && em < 3.5) E = vec3(1.0, 0.45, 0.04) * (trBit(fl, 2.0) * blink * 7.0);
  else if (em > 3.5 && em < 4.5) E = vec3(1.0, 0.45, 0.04) * (trBit(fl, 4.0) * blink * 7.0);
  else if (em > 4.5 && em < 5.5) E = vec3(1.0, 0.88, 0.68) * nt * 0.22;
  else if (em > 5.5 && em < 6.5) {
    // 公交 LED 线路牌：程序化点阵“字”
    vec2 q = vec2(vTrLocal.x * 13.0, vTrLocal.y * 16.0);
    vec2 c = floor(q);
    float glyph = step(0.42, fract(sin(dot(floor(q / vec2(3.0, 4.0)), vec2(12.9898, 78.233))) * 43758.5453));
    float dotm = step(0.25, fract(q.x)) * step(0.25, fract(q.y));
    float on = max(glyph * step(0.35, fract(sin(dot(c, vec2(39.3, 11.7))) * 9631.7)), 0.12);
    E = vec3(1.0, 0.28, 0.04) * on * dotm * (2.0 + nt * 4.0);
  }
  else if (em > 6.5 && em < 7.5) E = vec3(0.92, 0.96, 1.0) * (0.25 + nt * 2.6) * (1.0 - trBit(fl, 16.0));
  else if (em > 8.5 && em < 9.5) E = vec3(1.0, 0.98, 0.95) * (1.6 + nt * 2.5) * (1.0 - trBit(fl, 16.0));`}
  totalEmissiveRadiance = E;
}`);
  };
  mat.customProgramCacheKey = () => 'traffic-near3-' + (morph ? 'm' : '') + (train ? 't' : '') + (bike ? 'b' : '');
  return mat;
}

/** 阴影深度材质：同样做车型/选项折叠与形变，避免 uber 几何投出重叠阴影 */
export function depthMaterial({ morph = false, bike = false } = {}) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aKU;
attribute vec4 iData;
${morph ? 'attribute vec3 position2;\nattribute vec3 position3;' : ''}`)
      .replace('#include <begin_vertex>', `
vec3 transformed = ${morph ? '(iData.z < 0.5 ? position : iData.z < 1.5 ? position2 : position3)' : 'vec3(position)'};
${bike ? 'if (aKU.x > -0.5 && (int(aKU.x + 0.5) & int(iData.z + 0.5)) == 0) transformed = vec3(0.0);' : 'if (aKU.x > -0.5 && abs(aKU.x - iData.x) > 0.5) transformed = vec3(0.0);'}`);
  };
  m.customProgramCacheKey = () => 'traffic-depth3-' + (morph ? 'm' : '') + (bike ? 'b' : '');
  return m;
}

/** 0xRRGGBB → 可精确存进 float 的整数（实例第二色） */
export const packRGB = (hex) => Math.max(2, hex & 0xffffff);
