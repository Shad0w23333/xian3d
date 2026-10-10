// 车辆材质（traffic.js 用）：逐顶点材质参数 + 实例车漆色 + 车型/选项折叠 + 三目标形变 + 号牌贴图 + 夜间灯光。
// 实例属性：iColor = (车漆 rgb, 第二色)  第二色 > 1.5 时为 0xRRGGBB 打包整数（外卖箱、公交色带等），否则用 uSecond 调色板；
//          iData  = (车型 / 列车型, 灯光标志位, 形状(小汽车 0 轿车 1 SUV 2 MPV；两轮车 = 选项位), 打包: 第二色号 + 号牌类型×16 + 牌号种子×64)
import * as THREE from 'three';
import { DOOR_Z } from './vehicle-cars.js';

// ———————————————————— 号牌贴图 ————————————————————
// 图集 1024×512：
//   第 0 行（y 0~80）4 格 256×80 号牌底板：蓝牌（小型车，白字）/ 渐变绿牌（小型新能源）/ 黄牌（大型车）/ 黄绿双拼（大型新能源），
//     只画边框、“陕A”与分隔点，序号区留空；
//   第 1、2 行（y 96~256）字符格 48×80：0~9、A~Z（无 I、O）共 34 个，白字黑底（作遮罩）；
//   第 3 行（y 272~336）出租车顶灯字面 256×64：“出租 TAXI”。
// 序号在着色器里按实例种子（打包值 / 64，0~4095）逐位从字符格拼出：蓝/黄牌 5 位（首位字母概率高些），绿牌 D/F + 5 位数字，
// 大型新能源 5 位数字 + D——同一画面里几乎不会出现两块相同的号牌。
const PW = 256, PH = 80, TW = 1024, TH = 512;
const GLYPHS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
let plateTex = null;
function plateTexture() {
  if (plateTex) return plateTex;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = TW; c.height = TH;
  const g = c.getContext('2d');
  const fam = '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
  const din = '"DIN Alternate","Helvetica Neue",Arial,sans-serif';
  g.fillStyle = '#000';
  g.fillRect(0, 0, TW, TH);
  for (let type = 0; type < 4; type++) {
    const x = type * PW, y = 0;
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
    g.fillStyle = fg;
    g.textBaseline = 'middle';
    g.font = `bold 50px ${fam}`;
    g.fillText('陕A', x + 12, y + PH / 2 + 2);
    g.beginPath(); g.arc(x + 98, y + PH / 2, 4, 0, Math.PI * 2); g.fill();
  }
  // 字符格（白字黑底）
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.font = `bold 60px ${din}`;
  for (let k = 0; k < GLYPHS.length; k++) {
    const cx = (k % 21) * 48 + 24, cy = 96 + Math.floor(k / 21) * 80 + 42;
    const w = g.measureText(GLYPHS[k]).width;
    g.save();
    g.translate(cx, cy);
    g.scale(Math.min(1, 38 / w), 1);
    g.fillText(GLYPHS[k], 0, 0);
    g.restore();
  }
  // 出租车顶灯字面
  g.fillStyle = '#f6f6f2';
  g.fillRect(0, 272, 256, 64);
  g.fillStyle = '#1f4f9a';
  g.textAlign = 'left';
  g.font = `bold 40px ${fam}`;
  g.fillText('出租', 14, 305);
  g.fillStyle = '#c0281e';
  g.font = `bold 40px ${din}`;
  g.fillText('TAXI', 122, 306);
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
float trHash(float a, float b) { return fract(sin(a * 12.9898 + b * 78.233) * 43758.5453); }
// 号牌：底板（“陕A·”+ 边框）+ 按种子逐位拼出的序号；q = 牌面 0..1（u 从观看者左到右，v 自下而上）
vec3 trPlateTex(sampler2D tex, float pt, float seed, vec2 q) {
  vec2 bp = vec2(pt * 256.0 + 3.0 + q.x * 250.0, 3.0 + (1.0 - q.y) * 74.0);
  vec3 c = texture2D(tex, vec2(bp.x / 1024.0, 1.0 - bp.y / 512.0)).rgb;
  float n = (pt > 0.5 && pt < 1.5) || pt > 2.5 ? 6.0 : 5.0;
  float cw = 140.0 / n;
  float f = (q.x * 256.0 - 108.0) / cw;
  if (f >= 0.0 && f < n) {
    float k = floor(f), lx = fract(f);
    float h = trHash(seed, k + 1.0), h2 = trHash(seed + 17.0, k + 5.0);
    float gi;
    if (pt > 0.5 && pt < 1.5) gi = k < 0.5 ? (h < 0.6 ? 13.0 : 15.0) : floor(h * 9.999);
    else if (pt > 2.5) gi = k > 4.5 ? 13.0 : floor(h * 9.999);
    else gi = h2 < (k < 0.5 ? 0.42 : 0.2) ? 10.0 + floor(h * 23.999) : floor(h * 9.999);
    float col = mod(gi, 21.0), row = floor(gi / 21.0);
    vec2 gp = vec2(col * 48.0 + 24.0 + (lx - 0.5) * 44.0, 96.0 + row * 80.0 + 6.0 + (1.0 - q.y) * 70.0);
    vec2 duvx = vec2(dFdx(q.x) * 256.0 / cw * 44.0 / 1024.0, -dFdx(q.y) * 70.0 / 512.0);
    vec2 duvy = vec2(dFdy(q.x) * 256.0 / cw * 44.0 / 1024.0, -dFdy(q.y) * 70.0 / 512.0);
    float m = textureGrad(tex, vec2(gp.x / 1024.0, 1.0 - gp.y / 512.0), duvx, duvy).r;
    m = sqrt(clamp(m, 0.0, 1.0));
    vec3 fg = pt < 0.5 ? vec3(0.9) : vec3(0.006);
    c = mix(c, fg, m);
  }
  return c;
}
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
    if (vTrUv.x >= 1.5) {
      // 出租车顶灯字面
      vec2 tq = vec2(clamp(vTrUv.x - 2.0, 0.0, 1.0), vTrUv.y);
      diffuseColor.rgb = texture2D(uPlateTex, vec2((2.0 + tq.x * 252.0) / 1024.0, 1.0 - (274.0 + (1.0 - tq.y) * 60.0) / 512.0)).rgb;
    } else if (vTrUv.x >= 0.0) {
      diffuseColor.rgb = trPlateTex(uPlateTex, pt, floor(pack / 64.0), vTrUv) * 0.85;
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
  // 刹车灯/转向灯：白天亮度压到泛光阈值附近（看得出亮着，但不晕成一团），夜里照旧
  else if (em > 1.5 && em < 2.5) E = vec3(1.0, 0.03, 0.015) * (trBit(fl, 1.0) > 0.5 ? 2.4 + nt * 4.6 : (0.05 + nt * 3.2) * (1.0 - trBit(fl, 16.0)));
  else if (em > 2.5 && em < 3.5) E = vec3(1.0, 0.45, 0.04) * (trBit(fl, 2.0) * blink * (2.2 + nt * 4.8));
  else if (em > 3.5 && em < 4.5) E = vec3(1.0, 0.45, 0.04) * (trBit(fl, 4.0) * blink * (2.2 + nt * 4.8));
  else if (em > 4.5 && em < 5.5) {
    // 公交车厢（夜里车内灯亮）：顶灯下亮、往下渐暗；侧窗按局部坐标画窗框分格（约 1.15 m 一格 + 上部推拉窗横框）、
    // 窗下沿的座椅靠背和随机坐着的乘客剪影——不再是一整块亮白板
    vec3 lp = vTrLocal;
    float glow = mix(0.35, 1.0, smoothstep(1.1, 2.7, lp.y));
    float dark = 0.0;
    if (abs(lp.x) > 1.1) {
      float zc = fract((lp.z + 0.31) / 1.15);
      float aaz = max(fwidth(lp.z) / 1.15, 0.004);
      dark = max(dark, 1.0 - smoothstep(0.022, 0.022 + aaz, min(zc, 1.0 - zc)));
      dark = max(dark, 1.0 - smoothstep(0.015, 0.015 + fwidth(lp.y), abs(lp.y - 2.3)));
      float sz = lp.z / 0.82, sf = fract(sz) - 0.5, sid = floor(sz);
      float seat = step(lp.y, 1.42) * (1.0 - smoothstep(0.3, 0.34, abs(sf)));
      float occ = step(0.4, fract(sin(sid * 91.7 + vTrInfo.w * 0.37 + sign(lp.x) * 13.1) * 4375.5));
      float head = occ * (1.0 - smoothstep(0.1, 0.13, length(vec2(sf * 0.82, (lp.y - 1.64) * 0.9))));
      float torso = occ * step(lp.y, 1.52) * (1.0 - smoothstep(0.15, 0.18, abs(sf * 0.82)));
      dark = max(dark, max(seat * 0.55, max(head, torso) * 0.9));
    }
    E = vec3(0.96, 0.93, 0.84) * nt * 0.55 * glow * (1.0 - 0.92 * dark);
    diffuseColor.rgb *= 1.0 - 0.6 * dark;
  }
  else if (em > 5.5 && em < 6.5) {
    // 公交 LED 线路牌：程序化点阵“字”
    vec2 q = vec2(vTrLocal.x * 13.0, vTrLocal.y * 16.0);
    vec2 c = floor(q);
    float glyph = step(0.42, fract(sin(dot(floor(q / vec2(3.0, 4.0)), vec2(12.9898, 78.233))) * 43758.5453));
    float dotm = step(0.25, fract(q.x)) * step(0.25, fract(q.y));
    float on = max(glyph * step(0.35, fract(sin(dot(c, vec2(39.3, 11.7))) * 9631.7)), 0.12);
    E = vec3(1.0, 0.28, 0.04) * on * dotm * (2.0 + nt * 4.0);
  }
  else if (em > 6.5 && em < 7.5) E = (vTrMat.x > 2.5 && vTrMat.x < 3.5 ? diffuseColor.rgb * 1.15 : vec3(0.92, 0.96, 1.0)) * (0.25 + nt * 2.6) * (1.0 - trBit(fl, 16.0));
  else if (em > 8.5 && em < 9.5) E = vec3(1.0, 0.98, 0.95) * (0.8 + nt * 3.3) * (1.0 - trBit(fl, 16.0));`}
  totalEmissiveRadiance = E;
}`)
      .replace('#include <opaque_fragment>', /* glsl */ `#include <opaque_fragment>
{
  // 不发光的面（车漆、玻璃、轮毂、饰条）：线性亮度限在泛光阈值（日间 1.3）以下、保持色相——
  // 逆光时白车引擎盖与前挡的太阳高光不再晕成一大团白光把车头冲白
  if (totalEmissiveRadiance.r + totalEmissiveRadiance.g + totalEmissiveRadiance.b < 1e-3) {
    float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor.rgb *= min(1.0, 1.12 / max(lum, 1e-4));
  }
}`);
  };
  mat.customProgramCacheKey = () => 'traffic-near4-' + (morph ? 'm' : '') + (train ? 't' : '') + (bike ? 'b' : '');
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
