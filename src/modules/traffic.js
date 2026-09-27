// 道路车流 + 铁路/地铁列车（整体重写）
//
// 道路车辆 —— 以相机为中心的“活动气泡”微观仿真（CPU，数千辆）：
//   · 路网：arch/traffic_net.js 把 roads.json 拆成有向边（双向路两条、单行路一条），节点合并、路口聚类成信号灯组；
//   · 车道：每个方向按车道数分道，右侧通行；右转车走最右道、左转车走最左道，换道时横向平滑过渡；
//   · 跟驰：IDM（智能驾驶员模型）。同车道前车 + 路口“预占”（离路口 < 40 m 的车预先登记到下一条边，
//     汇入/环岛时近者先行），红灯/黄灯在停止线前停车，右转不受红灯限制；转弯前减速，路口内用二次贝塞尔过弯；
//   · 密度：等级越高车越多越快（高速 80~100 km/h，主干道 40~60 km/h），早晚高峰更密更慢、深夜稀疏，
//     再乘 ctx.quality.trafficDensity；气泡外的边不仿真，边进入气泡时按目标密度撒车，
//     之后在“看不见的地方”（视锥外或远处）补车/收车维持密度，路线选择也偏向缺车的路；
//   · 高度：与道路模块一致，roadheight.js 规则（地面 + LIFT + bridgeLift，隧道不渲染）。
// 渲染（全部实例化，≤ 6 个 draw call）：
//   近景小汽车（轿车/SUV 形变 + 出租车顶灯）、近景大车（公交/渣土车/厢货/半挂 uber 几何）、
//   远景统一代理盒（按车型参数化）、夜间车灯精灵（前大灯白、尾灯红、刹车加亮、路面光斑，最小像素尺寸保证远处成“光带”）、
//   近景列车、远景列车。
// 列车 —— 按时刻表的确定性运行（时间的函数），不做 CPU 跟驰：
//   复兴号（CR400AF 红飘带 / CR400BF 金飘带 / CRH 蓝，8/16 编组）跑高铁线，西安北站停站；
//   陇海/西康等普速线跑客车（机车 + 25G 客车）与货车（敞车/罐车）；地铁 B 型车只在地面/高架段可见。
//   国铁双线左侧行车，地铁右侧行车（按平行线位关系判断每条股道的运行方向）。
import * as THREE from 'three';
import { buildRoadGraph, resampleFeature, buildRailStrokes, resampleStroke, RAIL_KIND } from '../arch/traffic_net.js';
import {
  carNearGeometry, heavyNearGeometry, farVehicleGeometry, trainNearGeometry, trainFarGeometry,
  VK, VK_LEN, TK, TK_LEN, pickCarColor, TAXI_GREEN, TAXI_YELLOW, BUS_COLORS, DUMP_GREEN,
  TRUCK_CAB_COLORS, SECOND_COLORS, METRO_LINE_COLORS,
} from '../arch/traffic_models.js';
import * as roadsNet from '../arch/roads_net.js';
import { BRIDGE_UNIT } from '../core/roadheight.js';

// ======================================================================
// 参数
// ======================================================================
const CAP_BY_LEVEL = [2600, 4600, 7000, 9000]; // 同时仿真的最大车辆数
const NEAR_CAR = [110, 180, 250, 330]; // 近景小汽车距离
const NEAR_HEAVY = [150, 240, 330, 430];
const RADIUS_MAX = [2000, 3000, 4200, 5200]; // 活动气泡最大半径
const NEAR_TRAIN = [350, 520, 720, 950];
const TRAIN_FAR = 14000;
const DEBUG_STATS = false; // true：启动 1 s 后在控制台打印仿真统计
// 各等级相对活动半径 / 绝对上限（小路只在近处仿真）
//                   0    1    2    3     4     5    6    7    8    9    10   11
const CLASS_REACH = [1, 1, 1, 0.8, 0.46, 0.2, 0.1, 0.2, 1, 1, 1, 0.75];
const CLASS_REACH_CAP = [1e9, 1e9, 1e9, 1e9, 2000, 650, 350, 750, 1e9, 1e9, 1e9, 2600];
const STOP_BACK = [0, 0, 11, 9.5, 8, 5, 4, 5, 0, 0, 7, 6]; // 停止线距路口节点
// 时段密度（相对早晚高峰）
const HOUR_KEYS = [
  [0, 0.3], [1.5, 0.19], [3.5, 0.12], [5, 0.17], [6, 0.36], [7, 0.74], [8, 1.0], [9, 0.9], [10.5, 0.74], [12, 0.78], [14, 0.74],
  [16, 0.82], [17.5, 0.98], [18.5, 1.0], [19.5, 0.95], [20.5, 0.88], [21.5, 0.78], [22.5, 0.62], [23.5, 0.45], [24, 0.3],
];
function hourDensity(h) {
  h = ((h % 24) + 24) % 24;
  for (let i = 1; i < HOUR_KEYS.length; i++) {
    const [h1, v1] = HOUR_KEYS[i];
    if (h <= h1) {
      const [h0, v0] = HOUR_KEYS[i - 1];
      return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
    }
  }
  return 0.3;
}
const bump = (h, a, b) => Math.max(0, Math.min(1, (h - a) / 0.8, (b - h) / 0.8));
const peakness = (h) => Math.max(bump(h, 7.0, 9.3), bump(h, 17.0, 19.6));

function hash(n) {
  let x = (n | 0) + 0x9e3779b9;
  x ^= x >>> 16; x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15; x = Math.imul(x, 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
let rngState = 12345;
function rnd() {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// 远景代理车型参数（与 traffic_models.farVehicleGeometry 的编码对应）
//   A=(车身半宽, 窗顶半宽, 灯距缩放, 车身用第二色), Y=(底, 腰线, 窗顶, 车顶), Z=(车头, 车尾, 前挡下沿, 后挡下沿), Z2=(前挡上沿, 后挡上沿)
const FAR_T = [
  { A: [0.9, 0.7, 1.0, 0], Y: [0.2, 0.93, 1.38, 1.45], Z: [2.35, -2.35, 1.05, -1.2], Z2: [0.2, -0.95, 0, 0] },
  { A: [0.9, 0.7, 1.0, 0], Y: [0.2, 0.93, 1.38, 1.45], Z: [2.35, -2.35, 1.05, -1.2], Z2: [0.2, -0.95, 0, 0] },
  { A: [1.27, 1.25, 1.5, 0], Y: [0.3, 1.15, 2.75, 3.22], Z: [6.0, -6.0, 5.98, -5.98], Z2: [5.95, -5.95, 0, 0] },
  { A: [1.25, 1.2, 1.5, 0], Y: [0.55, 1.95, 2.95, 3.35], Z: [4.3, -4.3, 4.28, -4.28], Z2: [4.05, -4.25, 0, 0] },
  { A: [1.2, 1.2, 1.4, 1], Y: [0.5, 1.7, 2.8, 3.35], Z: [3.8, -3.8, 3.78, -3.78], Z2: [3.55, -3.75, 0, 0] },
  { A: [1.27, 1.25, 1.5, 1], Y: [0.6, 2.0, 3.7, 3.95], Z: [8.25, -8.25, 8.2, -8.2], Z2: [7.95, -8.2, 0, 0] },
];
const FAR_SUV = { Y: [0.28, 1.07, 1.66, 1.72], Z: [2.38, -2.38, 1.18, -1.95], Z2: [0.42, -1.9, 0, 0] };
// 车灯精灵参数：(灯半距, 前灯 z, 尾灯 z, 灯高)
const LIGHT_T = [[0.62, 2.28, -2.32, 0.72], [0.62, 2.28, -2.32, 0.72], [0.95, 6.0, -6.0, 0.82], [0.95, 4.3, -4.3, 1.0], [0.95, 3.8, -3.8, 0.95], [0.95, 8.25, -8.25, 1.0]];
const IS_HEAVY = [0, 0, 1, 1, 1, 1];
// 列车远景尺寸 (宽, 高)
const TRAIN_WH = [[3.36, 4.05], [3.36, 4.05], [3.1, 4.3], [3.1, 4.3], [3.2, 3.1], [2.9, 3.9], [2.8, 3.75], [2.8, 3.75]];

// ======================================================================
// 着色器注入
// ======================================================================
const PLATE_GLSL = /* glsl */ `
vec3 trPlate(float p) {
  if (p < 0.5) return vec3(0.02, 0.09, 0.42);
  if (p < 1.5) return vec3(0.18, 0.55, 0.22);
  if (p < 2.5) return vec3(0.85, 0.6, 0.03);
  return vec3(0.42, 0.66, 0.12);
}
float trBit(float f, float b) { return mod(floor(f / b), 2.0); }
`;

/** 近景车辆/列车材质：逐顶点材质参数 + 实例车漆色 + 车型折叠 + 夜间灯光 */
function nearMaterial(ctx, { morph = false, train = false, secondLin }) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.0 });
  const decl = /* glsl */ `
attribute vec4 aMat;
attribute float aKind;
attribute vec4 iColor;
attribute vec4 iData;
${morph ? 'attribute vec3 position2;\nattribute vec3 normal2;' : ''}
varying vec4 vTrMat;
varying vec3 vTrBody;
varying vec4 vTrInfo;
varying vec3 vTrLocal;
`;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.uniforms.uSecond = { value: secondLin };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + decl)
      .replace('#include <beginnormal_vertex>', morph
        ? 'vec3 objectNormal = normalize(mix(normal, normal2, iData.z));'
        : '#include <beginnormal_vertex>')
      .replace('#include <begin_vertex>', /* glsl */ `
vec3 transformed = ${morph ? 'mix(position, position2, iData.z)' : 'vec3(position)'};
if (aKind > -0.5 && abs(aKind - iData.x) > 0.5) transformed = vec3(0.0);
vTrMat = aMat; vTrBody = iColor.rgb; vTrInfo = iData; vTrLocal = transformed;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
uniform float uNight;
uniform float uTime;
uniform vec3 uSecond[8];
varying vec4 vTrMat;
varying vec3 vTrBody;
varying vec4 vTrInfo;
varying vec3 vTrLocal;
${PLATE_GLSL}`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
{
  float pm = vTrMat.x;
  if (pm > 0.5 && pm < 1.5) diffuseColor.rgb = vTrBody * vColor.rgb;
  else if (pm > 1.5 && pm < 2.5) { float sc = mod(vTrInfo.w, 16.0); diffuseColor.rgb = (sc > 7.5 ? vTrBody : uSecond[int(sc)]) * vColor.rgb; }
  else if (pm > 2.5 && pm < 3.5) diffuseColor.rgb = trPlate(floor(vTrInfo.w / 16.0));
  else if (pm > 3.5) diffuseColor.rgb = vTrBody;
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vTrMat.y;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vTrMat.z;')
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
  if (em > 0.5 && em < 1.5) E = vec3(1.0, 0.95, 0.85) * (nt * 7.0);
  else if (em > 1.5 && em < 2.5) E = vec3(1.0, 0.03, 0.015) * (trBit(fl, 1.0) > 0.5 ? 7.0 : 0.05 + nt * 3.2);
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
  else if (em > 6.5 && em < 7.5) E = vec3(0.92, 0.96, 1.0) * (0.25 + nt * 2.6);
  else if (em > 8.5 && em < 9.5) E = vec3(1.0, 0.98, 0.95) * (1.6 + nt * 2.5);`}
  totalEmissiveRadiance = E;
}`);
  };
  mat.customProgramCacheKey = () => 'traffic-near-' + (morph ? 'm' : '') + (train ? 't' : '');
  return mat;
}

/** 阴影深度材质：同样做车型折叠与形变，避免 uber 几何投出重叠阴影 */
function depthMaterial(morph) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aKind;
attribute vec4 iData;
${morph ? 'attribute vec3 position2;' : ''}`)
      .replace('#include <begin_vertex>', `
vec3 transformed = ${morph ? 'mix(position, position2, iData.z)' : 'vec3(position)'};
if (aKind > -0.5 && abs(aKind - iData.x) > 0.5) transformed = vec3(0.0);`);
  };
  m.customProgramCacheKey = () => 'traffic-depth-' + (morph ? 'm' : '');
  return m;
}

/** 远景车辆代理材质：顶点按车型参数化，平面着色 */
function farVehicleMaterial(ctx, secondLin, pixelU) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2, flatShading: true });
  const toArr = (key) => FAR_T.map((t) => new THREE.Vector4(...(t[key].length === 4 ? t[key] : [...t[key], 0, 0])));
  const uA = toArr('A'), uY = toArr('Y'), uZ = toArr('Z'), uZ2 = toArr('Z2');
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.uniforms.uSecond = { value: secondLin };
    sh.uniforms.uFA = { value: uA };
    sh.uniforms.uFY = { value: uY };
    sh.uniforms.uFZ = { value: uZ };
    sh.uniforms.uFZ2 = { value: uZ2 };
    sh.uniforms.uSuvY = { value: new THREE.Vector4(...FAR_SUV.Y) };
    sh.uniforms.uSuvZ = { value: new THREE.Vector4(...FAR_SUV.Z) };
    sh.uniforms.uSuvZ2 = { value: new THREE.Vector4(...FAR_SUV.Z2) };
    sh.uniforms.uPixel = pixelU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
attribute vec4 aFar;
attribute vec3 aFarOff;
attribute vec4 iColor;
attribute vec4 iData;
uniform vec4 uFA[6];
uniform vec4 uFY[6];
uniform vec4 uFZ[6];
uniform vec4 uFZ2[6];
uniform vec4 uSuvY;
uniform vec4 uSuvZ;
uniform vec4 uSuvZ2;
uniform float uPixel;
varying vec4 vFar;
varying vec3 vTrBody;
varying vec4 vTrInfo;
varying float vFront;`)
      .replace('#include <begin_vertex>', /* glsl */ `
int ty = int(iData.x + 0.5);
vec4 A = uFA[ty]; vec4 Y = uFY[ty]; vec4 Z = uFZ[ty]; vec4 Z2 = uFZ2[ty];
if (ty <= 1) { Y = mix(Y, uSuvY, iData.z); Z = mix(Z, uSuvZ, iData.z); Z2 = mix(Z2, uSuvZ2, iData.z); }
float sx = aFar.x; int lv = int(aFar.y + 0.5); int zc = int(aFar.z + 0.5); float mt = aFar.w;
float hw = abs(sx) > 1.5 ? A.y : A.x;
float y = lv == 0 ? Y.x : lv == 1 ? Y.y : lv == 2 ? Y.z : Y.w;
float z = zc == 0 ? Z.x : zc == 1 ? Z.y : zc == 2 ? Z.z : zc == 3 ? Z.w : zc == 4 ? Z2.x : Z2.y;
vec3 transformed = vec3(sign(sx) * hw, y, z);
if (mt > 2.5) transformed = vec3(aFarOff.x * A.z, Y.y + aFarOff.y * (ty >= 2 ? 1.6 : 1.0), z + aFarOff.z);
// 远处保证最小像素宽度（车流在中远景仍可辨）
float trK = clamp(uPixel * distance(instanceMatrix[3].xyz, cameraPosition) * 1.2 / (2.0 * A.x), 1.0, 2.6);
transformed.xy *= trK;
transformed.z *= sqrt(trK);
vFar = aFar; vTrBody = iColor.rgb; vTrInfo = iData;
vFront = (zc == 2 || zc == 4) ? 1.0 : 0.0;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
uniform float uNight;
uniform vec3 uSecond[8];
varying vec4 vFar;
varying vec3 vTrBody;
varying vec4 vTrInfo;
varying float vFront;
float trBit(float f, float b) { return mod(floor(f / b), 2.0); }`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
float trMt = floor(vFar.w + 0.5);
int trTy = int(vTrInfo.x + 0.5);
float trSc = mod(vTrInfo.w, 16.0);
vec3 trPaint = (trTy >= 4 && trSc < 7.5) ? uSecond[int(trSc)] : vTrBody;
bool trGlass = trMt > 0.5 && trMt < 1.5 && (trTy < 3 || vFront > 0.99);
diffuseColor.rgb = trGlass ? vec3(0.025, 0.03, 0.035) : trMt > 1.5 ? vec3(0.03) : trPaint;
if (trMt > 0.5 && trMt < 1.5 && !trGlass) diffuseColor.rgb = trPaint * 0.8;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = trGlass ? 0.08 : 0.4;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = trGlass ? 0.3 : 0.35;')
      .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
{
  vec3 E = vec3(0.0);
  if (trMt > 2.5 && trMt < 3.5) E = vec3(1.0, 0.95, 0.85) * (0.6 + uNight * 7.0);
  else if (trMt > 3.5) E = vec3(1.0, 0.03, 0.015) * (trBit(vTrInfo.y, 1.0) > 0.5 ? 7.0 : 0.05 + uNight * 3.5);
  else if (trGlass && trTy == 2) E = vec3(1.0, 0.88, 0.68) * uNight * 0.3;
  totalEmissiveRadiance = E;
}`);
  };
  mat.customProgramCacheKey = () => 'traffic-farveh';
  return mat;
}

/** 远景列车：单位盒 × 实例缩放，车头收窄压低 */
function farTrainMaterial(ctx, pixelU) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.25, flatShading: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.uniforms.uPixel = pixelU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aFar;
attribute vec4 iColor;
attribute vec4 iData;
uniform float uPixel;
varying vec4 vFar;
varying vec3 vTrBody;
varying vec4 vTrInfo;`)
      .replace('#include <begin_vertex>', /* glsl */ `
vec3 transformed = vec3(position);
float k = iData.x;
if (aFar.y > 0.5 && (k < 0.5 || abs(k - 6.0) < 0.5)) {
  float hsr = step(k, 0.5);
  transformed.y = mix(transformed.y, 0.12 + transformed.y * 0.35, hsr * 0.85 + (1.0 - hsr) * 0.12);
  transformed.x *= mix(0.94, 0.5, hsr);
}
{
  vec3 ax = instanceMatrix[0].xyz;
  float wdt = length(ax);
  float trK = clamp(uPixel * distance(instanceMatrix[3].xyz, cameraPosition) * 1.3 / max(wdt, 0.5), 1.0, 2.2);
  transformed.x *= trK; transformed.y *= mix(1.0, trK, 0.6);
}
vFar = aFar; vTrBody = iColor.rgb; vTrInfo = iData;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight;
varying vec4 vFar;
varying vec3 vTrBody;
varying vec4 vTrInfo;
float trBit(float f, float b) { return mod(floor(f / b), 2.0); }`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
float tk = vTrInfo.x;
float mt = floor(vFar.z + 0.5);
bool pax = tk < 3.5 || tk > 5.5;
vec3 body = tk < 1.5 ? vec3(0.74, 0.76, 0.77) : tk > 5.5 ? vec3(0.58, 0.6, 0.62) : vTrBody;
bool win = mt > 0.5 && mt < 1.5 && pax;
diffuseColor.rgb = win ? vec3(0.03, 0.035, 0.04) : mt > 1.5 && mt < 2.5 ? (pax ? vec3(0.5, 0.52, 0.54) : vTrBody * 0.7) : body;
if (mt > 0.5 && mt < 1.5 && !pax) diffuseColor.rgb = body;
if (tk < 1.5 && mt < 0.5 && vFar.x > 0.5 && vFar.x < 1.5) diffuseColor.rgb = mix(body, vTrBody, 0.8);`)
      .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
{
  vec3 E = vec3(0.0);
  if (win) E = vec3(1.0, 0.9, 0.72) * uNight * 0.55;
  if (mt > 2.5) {
    if (trBit(vTrInfo.y, 1.0) > 0.5) E = vec3(1.0, 0.95, 0.86) * (0.6 + uNight * 9.0);
    else if (trBit(vTrInfo.y, 2.0) > 0.5) E = vec3(1.0, 0.05, 0.03) * (0.3 + uNight * 4.0);
  }
  totalEmissiveRadiance = E;
}`);
  };
  mat.customProgramCacheKey = () => 'traffic-fartrain';
  return mat;
}

/** 车灯精灵几何：每实例 5 个四边形（左右前灯、左右尾灯、路面光斑） */
function lightGeometry() {
  const P = [], L = [], I = [];
  let v = 0;
  const quad = (which, side) => {
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { P.push(0, 0, 0); L.push(which, side, cx, cy); }
    I.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };
  quad(0, 1); quad(0, -1); quad(1, 1); quad(1, -1); quad(2, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aL', new THREE.Float32BufferAttribute(L, 4));
  g.setIndex(I);
  return g;
}

function lightMaterial(ctx) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uPixel: { value: 0.001 } }]),
    vertexShader: /* glsl */ `
attribute vec4 aL;
attribute vec4 iLight;
attribute vec4 iLF;
uniform float uPixel;
uniform float uNight;
varying vec3 vCol;
varying vec2 vUv;
varying float vKind;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
float trBit(float f, float b) { return mod(floor(f / b), 2.0); }
void main() {
  vec3 Lx = normalize(instanceMatrix[0].xyz);
  vec3 Uy = normalize(instanceMatrix[1].xyz);
  vec3 Fz = normalize(instanceMatrix[2].xyz);
  vec3 O = instanceMatrix[3].xyz;
  float which = aL.x;
  float fl = iLF.x;
  bool big = trBit(fl, 8.0) > 0.5;
  vUv = aL.zw;
  vKind = which;
  vec3 wp;
  if (which < 1.5) {
    bool head = which < 0.5;
    float on = head ? trBit(fl, 2.0) : trBit(fl, 4.0);
    vec3 c = O + Lx * (aL.y * iLight.x) + Fz * (head ? iLight.y : iLight.z) + Uy * iLight.w;
    vec3 toCam = cameraPosition - c;
    float d = length(toCam);
    vec3 V = toCam / max(d, 1e-3);
    float facing = dot(Fz, V) * (head ? 1.0 : -1.0);
    float vis = smoothstep(-0.12, 0.45, facing) * on;
    float worldR = big ? 0.32 : (head ? 0.16 : 0.13);
    float pixR = uPixel * d * (head ? 1.5 : 1.45);
    float r = max(worldR, pixR);
    float e = clamp(worldR * worldR / (r * r), 0.0, 1.0);
    e = mix(0.6, 1.0, e);
    float brake = trBit(fl, 1.0);
    vec3 col = head ? vec3(1.0, 0.9, 0.74) * (big ? 7.0 : 3.4) : vec3(1.0, 0.07, 0.03) * (brake > 0.5 ? 5.0 : 2.6);
    vCol = col * vis * e * uNight;
    vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    wp = c + V * min(0.6, d * 0.02) + (camR * aL.z + camU * aL.w) * r * 2.6;
  } else {
    // 前大灯在路面上的淡光斑（近处才有）
    float on = trBit(fl, 2.0) * (big ? 0.0 : 1.0);
    float d = distance(cameraPosition, O);
    float fade = 1.0 - smoothstep(180.0, 320.0, d);
    vec3 c = O + Fz * (iLight.y + 7.5);
    vec3 Lh = normalize(vec3(Lx.x, 0.0, Lx.z));
    vec3 Fh = normalize(vec3(Fz.x, 0.0, Fz.z));
    wp = c + Lh * aL.z * 2.4 + Fh * aL.w * 7.5 + vec3(0.0, 0.12, 0.0);
    vCol = vec3(1.0, 0.86, 0.66) * 0.26 * on * fade * uNight;
  }
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  if (which > 1.5) mvPosition.xyz *= 0.996;
  gl_Position = projectionMatrix * mvPosition;
  if (dot(vCol, vCol) < 1e-7) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */ `
varying vec3 vCol;
varying vec2 vUv;
varying float vKind;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float a;
  if (vKind < 1.5) {
    float r2 = dot(vUv, vUv) * 6.76;
    a = exp(-r2 * 3.2) + 0.1 * exp(-r2 * 0.6);
  } else {
    vec2 q = vUv;
    a = (1.0 - smoothstep(0.1, 1.0, length(vec2(q.x, q.y * 0.9)))) * smoothstep(-1.0, -0.4, q.y);
  }
  vec3 c = vCol * a;
  gl_FragColor = vec4(c, 1.0);
  #include <fog_fragment>
  #ifdef USE_FOG
  gl_FragColor.rgb = c * (1.0 - clamp(fogFactor, 0.0, 1.0));
  #endif
}`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    fog: true,
    toneMapped: true,
  });
}

// ======================================================================
// 实例写入器
// ======================================================================
class Writer {
  constructor(mesh, attrs) {
    this.mesh = mesh;
    this.mat = mesh.instanceMatrix.array;
    this.attrs = attrs.map((n) => mesh.geometry.getAttribute(n));
    this.arrs = this.attrs.map((a) => a.array);
    this.n = 0;
    this.cap = mesh.instanceMatrix.count;
  }
  reset() { this.n = 0; }
  full() { return this.n >= this.cap; }
  /** 写入一个实例：位置 p、前向 f（单位向量）、缩放 (sx, sy, sz) */
  put(px, py, pz, fx, fy, fz, sx = 1, sy = 1, sz = 1) {
    const i = this.n++;
    const m = this.mat, o = i * 16;
    let lx = fz, lz = -fx;
    const ll = Math.hypot(lx, lz) || 1;
    lx /= ll; lz /= ll;
    // up = F × left
    // F=(fx,fy,fz), Lv=(lx,0,lz) → U = F×Lv = (fy*lz - fz*0, fz*lx - fx*lz, fx*0 - fy*lx)
    const Ux = fy * lz, Uy = fz * lx - fx * lz, Uz = -fy * lx;
    m[o] = lx * sx; m[o + 1] = 0; m[o + 2] = lz * sx; m[o + 3] = 0;
    m[o + 4] = Ux * sy; m[o + 5] = Uy * sy; m[o + 6] = Uz * sy; m[o + 7] = 0;
    m[o + 8] = fx * sz; m[o + 9] = fy * sz; m[o + 10] = fz * sz; m[o + 11] = 0;
    m[o + 12] = px; m[o + 13] = py; m[o + 14] = pz; m[o + 15] = 1;
    return i;
  }
  set4(k, i, a, b, c, d) { const r = this.arrs[k], o = i * 4; r[o] = a; r[o + 1] = b; r[o + 2] = c; r[o + 3] = d; }
  commit() {
    const n = this.n;
    this.mesh.count = n;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, Math.max(1, n) * 16); im.needsUpdate = true;
    for (const a of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * a.itemSize); a.needsUpdate = true; }
  }
}

function instanced(geo, mat, cap, attrs, name) {
  for (const n of attrs) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(n, a);
  }
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = name;
  return mesh;
}

// ======================================================================
// 模块
// ======================================================================
export default {
  id: 'traffic',
  name: '道路车流与列车',
  async build(ctx) {
    const { terrain, camera } = ctx;
    const root = new THREE.Group();
    root.name = '交通流（车辆/列车）';
    ctx.scene.add(root);
    const Q = ctx.quality;
    let level = Math.max(0, Math.min(3, Q.level ?? 2));

    // —— 几何与材质 ——
    const secondLin = SECOND_COLORS.map((h) => new THREE.Color(h));
    const pixelU = { value: 0.001 }; // 每像素对应的世界尺寸（距离 1 m 处）
    const CAPMAX = CAP_BY_LEVEL[3];
    const carMesh = instanced(carNearGeometry(), nearMaterial(ctx, { morph: true, secondLin }), 2600, ['iColor', 'iData'], '近景小汽车');
    carMesh.customDepthMaterial = depthMaterial(true);
    const heavyMesh = instanced(heavyNearGeometry(), nearMaterial(ctx, { secondLin }), 900, ['iColor', 'iData'], '近景大型车');
    heavyMesh.customDepthMaterial = depthMaterial(false);
    const farMesh = instanced(farVehicleGeometry(), farVehicleMaterial(ctx, secondLin, pixelU), CAPMAX, ['iColor', 'iData'], '远景车辆');
    const lightMat = lightMaterial(ctx);
    lightMat.uniforms.uPixel = pixelU;
    lightMat.uniforms.uNight = ctx.uniforms.uNight;
    const lightMesh = instanced(lightGeometry(), lightMat, CAPMAX + 400, ['iLight', 'iLF'], '车灯');
    lightMesh.renderOrder = 8;
    const trainNearMesh = instanced(trainNearGeometry(), nearMaterial(ctx, { train: true, secondLin }), 700, ['iColor', 'iData'], '近景列车');
    trainNearMesh.customDepthMaterial = depthMaterial(false);
    const trainFarMesh = instanced(trainFarGeometry(), farTrainMaterial(ctx, pixelU), 2400, ['iColor', 'iData'], '远景列车');
    const shadowsOn = () => !!Q.shadows && level >= 1;
    for (const m of [carMesh, heavyMesh, trainNearMesh]) { m.castShadow = shadowsOn(); m.receiveShadow = true; }
    farMesh.receiveShadow = true;
    root.add(carMesh, heavyMesh, farMesh, trainNearMesh, trainFarMesh, lightMesh);
    const W = {
      car: new Writer(carMesh, ['iColor', 'iData']),
      heavy: new Writer(heavyMesh, ['iColor', 'iData']),
      far: new Writer(farMesh, ['iColor', 'iData']),
      light: new Writer(lightMesh, ['iLight', 'iLF']),
      tNear: new Writer(trainNearMesh, ['iColor', 'iData']),
      tFar: new Writer(trainFarMesh, ['iColor', 'iData']),
    };
    const WL = Object.values(W);

    // —— 路网 ——
    const G = buildRoadGraph(ctx.data.roads);
    const edges = G.edges;
    const NE = edges.length;
    const feats = G.feats;
    const featRes = new Array(feats.length);
    const resOf = (fi) => featRes[fi] || (featRes[fi] = resampleFeature(feats[fi], G.featLen[fi], terrain, 4));
    const active = new Uint8Array(NE);
    const activeStamp = new Uint32Array(NE);
    const eTarget = new Float32Array(NE);
    const eCount = new Uint16Array(NE);
    const qStamp = new Uint32Array(NE);
    let qStampN = 1, actStampN = 1;
    let activeList = [];
    const laneOffset = (e, lane) => (e.twoWay ? (e.lanes - lane - 0.5) * e.lw : ((e.lanes - 1) / 2 - lane) * e.lw);
    // 城区（出租车更多）：大致二环以内
    const inCity = (x, z) => x > -4300 && x < 4600 && z > -4700 && z < 4400;
    const inWall = (x, z) => Math.abs(x) < 1500 && Math.abs(z + 150) < 1350;

    // —— 车辆存储（SoA） ——
    const CAP = CAPMAX;
    const vEdge = new Int32Array(CAP).fill(-1), vNext = new Int32Array(CAP).fill(-1), vPrev = new Int32Array(CAP).fill(-1);
    const vLane = new Uint8Array(CAP), vNextLane = new Uint8Array(CAP);
    const vS = new Float32Array(CAP), vV = new Float32Array(CAP), vAcc = new Float32Array(CAP), vVf = new Float32Array(CAP);
    const vType = new Uint8Array(CAP), vLen = new Float32Array(CAP);
    const vLat = new Float32Array(CAP), vPrevLat = new Float32Array(CAP);
    const vNextA = new Float32Array(CAP), vPrevA = new Float32Array(CAP);
    const vCol = new Float32Array(CAP * 3), vPack = new Float32Array(CAP), vSuv = new Uint8Array(CAP);
    const vStuck = new Float32Array(CAP), vHold = new Uint8Array(CAP), vGhost = new Float32Array(CAP);
    const vFlags = new Uint8Array(CAP);
    const vPose = new Float32Array(CAP * 6);
    const alive = new Int32Array(CAP), where = new Int32Array(CAP).fill(-1);
    let nAlive = 0;
    const freeStack = new Int32Array(CAP);
    let nFree = CAP;
    for (let i = 0; i < CAP; i++) freeStack[i] = CAP - 1 - i;
    let capNow = CAP_BY_LEVEL[level];

    const colTmp = new THREE.Color();
    function setColor(i, hex) {
      colTmp.setHex(hex);
      vCol[i * 3] = colTmp.r; vCol[i * 3 + 1] = colTmp.g; vCol[i * 3 + 2] = colTmp.b;
    }
    function pickType(r, cls, x, z) {
      const h = ((ctx.sky?.hours ?? 14) % 24 + 24) % 24;
      const night = h < 6 || h >= 22;
      const busDay = h >= 6 && h < 22.5;
      const city = inCity(x, z);
      let pBus = 0, pDump = 0, pBox = 0, pSemi = 0;
      switch (cls) {
        case 0: case 8: pSemi = 0.11; pBox = 0.08; pDump = night ? 0.1 : 0.02; pBus = 0.006; break;
        case 1: case 9: pSemi = 0.03; pBox = 0.05; pDump = night ? 0.1 : city ? 0.012 : 0.03; pBus = busDay ? 0.015 : 0; break;
        case 2: case 10: pBox = 0.03; pDump = night && !city ? 0.03 : 0.004; pBus = busDay ? 0.055 : 0.008; pSemi = city ? 0 : 0.006; break;
        case 3: case 11: pBox = 0.03; pBus = busDay ? 0.045 : 0.006; pDump = night ? 0.012 : 0.002; break;
        case 4: pBox = 0.022; pBus = busDay ? 0.03 : 0.004; break;
        default: pBox = 0.012; break;
      }
      if (inWall(x, z)) { pSemi = 0; pDump = 0; pBox *= 0.5; }
      const pTaxi = (inWall(x, z) ? 0.24 : city ? 0.16 : 0.06) * (night ? 1.5 : 1) * (cls === 0 || cls === 8 ? 0.35 : 1);
      if ((r -= pBus) < 0) return VK.BUS;
      if ((r -= pDump) < 0) return VK.DUMP;
      if ((r -= pBox) < 0) return VK.BOXTRUCK;
      if ((r -= pSemi) < 0) return VK.SEMI;
      if ((r -= pTaxi) < 0) return VK.TAXI;
      return VK.CAR;
    }
    function dressVehicle(i, type) {
      vType[i] = type;
      vLen[i] = VK_LEN[type];
      vSuv[i] = 0;
      let second = 0, plate = 0;
      const r = rnd();
      switch (type) {
        case VK.CAR: {
          setColor(i, pickCarColor(rnd()));
          vSuv[i] = r < 0.42 ? 1 : 0;
          second = rnd() < 0.08 ? 7 : -1;
          plate = rnd() < 0.3 ? 1 : 0;
          break;
        }
        case VK.TAXI: {
          const green = r < 0.74;
          setColor(i, green ? TAXI_GREEN : TAXI_YELLOW);
          vSuv[i] = green && rnd() < 0.35 ? 1 : 0;
          second = green && rnd() < 0.45 ? 7 : -1;
          plate = green ? 1 : 0;
          break;
        }
        case VK.BUS: setColor(i, BUS_COLORS[(r * BUS_COLORS.length) | 0]); plate = 3; second = 8; break;
        case VK.DUMP: setColor(i, DUMP_GREEN); plate = 2; second = 8; break;
        case VK.BOXTRUCK: setColor(i, TRUCK_CAB_COLORS[(r * TRUCK_CAB_COLORS.length) | 0]); second = [0, 0, 1, 2, 5, 6][(rnd() * 6) | 0]; plate = 2; break;
        case VK.SEMI: setColor(i, TRUCK_CAB_COLORS[(r * TRUCK_CAB_COLORS.length) | 0]); second = [2, 3, 4, 5, 6, 1, 0][(rnd() * 7) | 0]; plate = 2; break;
      }
      if (second < 0) second = 8; // 8 = 车顶与车身同色
      vPack[i] = second + plate * 16;
      vVf[i] = 0.86 + rnd() * 0.28;
    }

    function spawn(eid, lane, s, v) {
      if (nFree === 0 || nAlive >= capNow) return -1;
      const i = freeStack[--nFree];
      const e = edges[eid];
      const R = resOf(e.f);
      const u = e.dir > 0 ? e.s0 + s : e.s1 - s;
      const k = Math.min(R.n - 1, Math.max(0, Math.round(u / R.st)));
      const type = pickType(rnd(), e.cls, R.xyz[k * 3], R.xyz[k * 3 + 2]);
      dressVehicle(i, type);
      if (IS_HEAVY[type] && e.lanes > 1) lane = Math.min(lane, type === VK.BUS ? 0 : 1);
      vEdge[i] = eid; vLane[i] = lane; vS[i] = s; vV[i] = v; vAcc[i] = 0;
      vPrev[i] = -1; vLat[i] = laneOffset(e, lane); vStuck[i] = 0; vHold[i] = 0; vGhost[i] = 0; vFlags[i] = 0;
      chooseNext(i);
      eCount[eid]++;
      where[i] = nAlive; alive[nAlive++] = i;
      return i;
    }
    function despawn(i) {
      const e = vEdge[i];
      if (e < 0) return;
      if (eCount[e] > 0) eCount[e]--;
      vEdge[i] = -1;
      const w = where[i], last = alive[--nAlive];
      alive[w] = last; where[last] = w; where[i] = -1;
      freeStack[nFree++] = i;
    }
    const wTmp = new Float32Array(16);
    function chooseNext(i) {
      const e = edges[vEdge[i]];
      const nx = e.next;
      vNext[i] = -1;
      if (!nx.length) return;
      let tot = 0;
      const heavy = IS_HEAVY[vType[i]];
      for (let k = 0; k < nx.length && k < 16; k++) {
        const o = edges[nx[k].e], a = nx[k].a, aa = Math.abs(a);
        let w = aa < 0.35 ? 4.0 : a > 0 ? 1.1 : 0.85;
        if (o.cls > e.cls + 2 && o.cls < 8) w *= 0.3;
        if (o.cls >= 5 && o.cls <= 7 && e.cls <= 4) w *= heavy ? 0.05 : 0.3;
        if (!active[o.id]) w *= 0.03;
        if (!o.next.length) w *= 0.08;
        const tg = eTarget[o.id];
        if (tg > 0.05) w *= Math.min(2.5, Math.max(0.25, 1 + (1.5 * (tg - eCount[o.id])) / (tg + 1)));
        wTmp[k] = w; tot += w;
      }
      let r = rnd() * tot, pick = 0;
      for (let k = 0; k < nx.length && k < 16; k++) { r -= wTmp[k]; if (r <= 0) { pick = k; break; } }
      const o = edges[nx[pick].e], a = nx[pick].a;
      vNext[i] = o.id;
      vNextA[i] = a;
      // 车道：右转走最右道、左转走最左道；大车靠右
      const nl = o.lanes;
      let lane = vLane[i];
      if (a > 0.5) lane = 0;
      else if (a < -0.5 && !heavy) lane = e.lanes - 1;
      else if (e.lanes > 1 && rnd() < 0.15) lane = (rnd() * e.lanes) | 0;
      if (heavy) lane = Math.min(lane, vType[i] === VK.BUS ? 0 : 1);
      vLane[i] = Math.min(lane, e.lanes - 1);
      let nlane;
      if (a > 0.5) nlane = 0;
      else if (a < -0.5) nlane = nl - 1;
      else nlane = e.lanes > 1 ? Math.round((vLane[i] * (nl - 1)) / (e.lanes - 1)) : Math.min(vLane[i], nl - 1);
      if (heavy) nlane = Math.min(nlane, vType[i] === VK.BUS ? 0 : 1);
      vNextLane[i] = Math.max(0, Math.min(nl - 1, nlane));
    }

    // —— 位姿计算 ——
    const P0 = new Float32Array(6), P2 = new Float32Array(6);
    function edgePose(eid, s, lat, o, off) {
      const e = edges[eid];
      const R = resOf(e.f);
      const st = R.st, n = R.n, xyz = R.xyz;
      const u = e.dir > 0 ? e.s0 + s : e.s1 - s;
      let fi = u / st;
      if (fi < 0) fi = 0;
      if (fi > n - 1.0001) fi = n - 1.0001;
      const i0 = fi | 0, t = fi - i0;
      const a = i0 * 3, b = a + 3;
      const x = xyz[a] + (xyz[b] - xyz[a]) * t;
      const y = xyz[a + 1] + (xyz[b + 1] - xyz[a + 1]) * t;
      const z = xyz[a + 2] + (xyz[b + 2] - xyz[a + 2]) * t;
      const im = (i0 > 0 ? i0 - 1 : 0) * 3, ip = (i0 + 2 < n ? i0 + 2 : n - 1) * 3;
      const tx0 = xyz[b] - xyz[im], tz0 = xyz[b + 2] - xyz[im + 2];
      const tx1 = xyz[ip] - xyz[a], tz1 = xyz[ip + 2] - xyz[a + 2];
      let hx = tx0 + (tx1 - tx0) * t, hz = tz0 + (tz1 - tz0) * t;
      const hl = Math.hypot(hx, hz) || 1;
      hx = (hx / hl) * e.dir; hz = (hz / hl) * e.dir;
      const slope = ((xyz[b + 1] - xyz[a + 1]) / st) * e.dir;
      o[off] = x - hz * lat; o[off + 1] = y; o[off + 2] = z + hx * lat;
      o[off + 3] = hx; o[off + 4] = slope; o[off + 5] = hz;
    }
    const junctionR = (a, L) => Math.min(Math.max(3.5, Math.min(12, 3.5 + 6 * Math.abs(a))), L * 0.45);
    function blendPose(eA, eB, latA, latB, rA, rB, t, o, off) {
      edgePose(eA, edges[eA].L - rA, latA, P0, 0);
      edgePose(eB, rB, latB, P2, 0);
      const k0 = rA * 0.55, k2 = rB * 0.55;
      const c1x = (P0[0] + P0[3] * k0 + P2[0] - P2[3] * k2) * 0.5;
      const c1z = (P0[2] + P0[5] * k0 + P2[2] - P2[5] * k2) * 0.5;
      const c1y = (P0[1] + P2[1]) * 0.5;
      const u = 1 - t;
      o[off] = u * u * P0[0] + 2 * u * t * c1x + t * t * P2[0];
      o[off + 1] = u * u * P0[1] + 2 * u * t * c1y + t * t * P2[1];
      o[off + 2] = u * u * P0[2] + 2 * u * t * c1z + t * t * P2[2];
      let dx = 2 * u * (c1x - P0[0]) + 2 * t * (P2[0] - c1x);
      let dz = 2 * u * (c1z - P0[2]) + 2 * t * (P2[2] - c1z);
      const dl = Math.hypot(dx, dz);
      if (dl < 1e-4) { dx = P0[3]; dz = P0[5]; } else { dx /= dl; dz /= dl; }
      o[off + 3] = dx; o[off + 4] = P0[4] * u + P2[4] * t; o[off + 5] = dz;
    }
    function vehiclePose(i) {
      const eid = vEdge[i], e = edges[eid], s = vS[i], off = i * 6;
      const nx = vNext[i];
      if (nx >= 0) {
        const rA = junctionR(vNextA[i], e.L), rB = junctionR(vNextA[i], edges[nx].L);
        if (s > e.L - rA) {
          blendPose(eid, nx, vLat[i], laneOffset(edges[nx], vNextLane[i]), rA, rB, (s - (e.L - rA)) / (rA + rB), vPose, off);
          return 1;
        }
      }
      const pv = vPrev[i];
      if (pv >= 0) {
        const rA = junctionR(vPrevA[i], edges[pv].L), rB = junctionR(vPrevA[i], e.L);
        if (s < rB) {
          blendPose(pv, eid, vPrevLat[i], vLat[i], rA, rB, (rA + s) / (rA + rB), vPose, off);
          return 2;
        }
      }
      edgePose(eid, s, vLat[i], vPose, off);
      return 0;
    }

    // —— 信号灯 ——
    const junctions = G.junctions;
    function signal(e, t) {
      const J = junctions[e.junction];
      const c = J.cycle;
      let ph = (t + J.offset) % c;
      if (e.group === 1) ph = (ph + c * 0.5) % c;
      const half = c * 0.5;
      if (ph < half - 5) return 0;
      if (ph < half - 2) return 1;
      return 2;
    }

    // —— 活动气泡 ——
    const fwd = new THREE.Vector3();
    let bubble = { x: 1e9, z: 1e9, R: 0 };
    let hoursNow = ctx.sky?.hours ?? 14;
    const densityBase = () => (Q.trafficDensity ?? 1) * hourDensity(hoursNow);
    const qList = [];
    function refreshActive() {
      const cp = camera.position;
      camera.getWorldDirection(fwd);
      const agl = Math.max(2, cp.y - terrain.heightAt(cp.x, cp.z));
      const R = Math.min(RADIUS_MAX[level], Math.max(1300, 900 + agl * 5.5));
      const fl = Math.hypot(fwd.x, fwd.z) || 1;
      const lead = Math.min(agl * 1.3, R * 0.45);
      const cx = cp.x + (fwd.x / fl) * lead, cz = cp.z + (fwd.z / fl) * lead;
      bubble = { x: cx, z: cz, R };
      G.query(cx, cz, R, qList, ++qStampN, qStamp);
      const stamp = ++actStampN;
      const dens = densityBase();
      const newList = [];
      const toFill = [];
      let sum = 0;
      for (const id of qList) {
        const e = edges[id];
        const d = Math.hypot(Math.max(e.x0 - cx, 0, cx - e.x1), Math.max(e.z0 - cz, 0, cz - e.z1));
        const reach = Math.min(R * CLASS_REACH[e.cls], CLASS_REACH_CAP[e.cls]);
        if (d > reach) continue;
        activeStamp[id] = stamp;
        const fall = 1 - 0.45 * Math.min(1, Math.max(0, (d - 0.3 * R) / (0.7 * R)));
        eTarget[id] = (e.L * e.lanes * e.density * dens * fall) / 1000;
        sum += eTarget[id];
        newList.push(id);
        if (!active[id]) { active[id] = 1; toFill.push(id); }
      }
      for (const id of activeList) if (activeStamp[id] !== stamp) { active[id] = 0; eTarget[id] = 0; }
      activeList = newList;
      const scale = Math.min(1, (capNow * 0.88) / Math.max(1, sum));
      if (scale < 1) for (const id of activeList) eTarget[id] *= scale;
      for (let k = nAlive - 1; k >= 0; k--) {
        const i = alive[k];
        if (!active[vEdge[i]]) despawn(i);
      }
      for (const id of toFill) fillEdge(id);
    }
    function fillEdge(id) {
      const e = edges[id];
      const tg = eTarget[id];
      let n = Math.floor(tg + rnd());
      if (n <= 0) return;
      const perLane = Math.ceil(n / e.lanes);
      for (let lane = 0; lane < e.lanes && n > 0; lane++) {
        const m = Math.min(perLane, n, Math.floor(e.L / 9));
        if (m <= 0) continue;
        const slot = e.L / m;
        for (let k = 0; k < m; k++) {
          const s = (k + 0.15 + rnd() * 0.5) * slot;
          if (spawn(id, lane, Math.min(e.L - 0.5, s), e.speed * (0.5 + rnd() * 0.4)) < 0) return;
          n--;
        }
      }
    }

    // —— 视锥 ——
    const frustum = new THREE.Frustum();
    const projScreen = new THREE.Matrix4();
    const planes = frustum.planes;
    const inFrustum = (x, y, z, r) => {
      for (let k = 0; k < 6; k++) {
        const p = planes[k];
        if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.constant < -r) return false;
      }
      return true;
    };

    // —— 排序键：车道 → 里程 → 车辆 ——
    const S_RES = 5, S_OFF = 100, S_BITS = 131072, I_BITS = 32768;
    const keys = new Float64Array(CAP * 2 + 16);
    const primPos = new Int32Array(CAP), lookPos = new Int32Array(CAP).fill(-1);
    let nKeys = 0;
    const laneKeyOfKey = (k) => Math.floor(Math.floor(k / I_BITS) / S_BITS);
    const pushKey = (laneKey, s, code) => {
      let sq = Math.round((s + S_OFF) * S_RES);
      if (sq < 0) sq = 0; else if (sq >= S_BITS) sq = S_BITS - 1;
      keys[nKeys++] = (laneKey * S_BITS + sq) * I_BITS + code;
    };
    // 在排好序的键里找某车道的首个下标
    function laneLower(laneKey) {
      const target = laneKey * S_BITS * I_BITS;
      let lo = 0, hi = nKeys;
      while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < target) lo = m + 1; else hi = m; }
      return lo;
    }

    // —— 仿真步 ——
    let simTime = 0;
    function simulate(dt) {
      const t = simTime;
      const pk = peakness(hoursNow);
      // 1) 键
      nKeys = 0;
      for (let k = 0; k < nAlive; k++) {
        const i = alive[k];
        const eid = vEdge[i], e = edges[eid];
        pushKey(eid * 8 + vLane[i], vS[i], i * 2);
        const nx = vNext[i];
        const rem = e.L - vS[i];
        if (nx >= 0 && active[nx] && !vHold[i] && rem < Math.max(30, vV[i] * 3 + 12)) pushKey(nx * 8 + vNextLane[i], vS[i] - e.L, i * 2 + 1);
      }
      const ks = keys.subarray(0, nKeys);
      ks.sort();
      for (let p = 0; p < nKeys; p++) {
        const code = ks[p] % I_BITS;
        const i = code >> 1;
        if (code & 1) lookPos[i] = p; else primPos[i] = p;
      }
      // 2) 加速度
      for (let k = 0; k < nAlive; k++) {
        const i = alive[k];
        const eid = vEdge[i], e = edges[eid];
        const type = vType[i], heavy = IS_HEAVY[type];
        const v = vV[i], s = vS[i], L = e.L, rem = L - s;
        const aMax = heavy ? 0.85 : 1.5, bC = 2.2, s0 = heavy ? 3.0 : 2.2, T = heavy ? 1.6 : 1.25;
        let v0 = e.speed * vVf[i] * (type === VK.BUS ? 0.78 : heavy ? 0.86 : 1);
        if (e.cls >= 2 && e.cls <= 4) v0 *= 1 - 0.28 * pk;
        const R = resOf(e.f);
        if (R.vcap < v0) v0 = Math.max(R.vcap, v0 * 0.6);
        const nx = vNext[i];
        if (nx >= 0) {
          const aa = Math.abs(vNextA[i]);
          if (aa > 0.3) {
            const vt = e.cls === 0 || e.cls === 8 ? 14 : 4.8 + 7.5 * Math.max(0, 1 - aa / 2.6);
            const lim = Math.sqrt(vt * vt + 2 * 1.6 * Math.max(0, rem - 4));
            if (lim < v0) v0 = lim;
          }
        }
        if (v0 < 1) v0 = 1;
        let acc = aMax * (1 - Math.pow(v / v0, 4));
        const ghost = vGhost[i] > 0;
        // 前车
        let gap = Infinity, lv = 0;
        const pp = primPos[i];
        const myKey = laneKeyOfKey(ks[pp]);
        if (pp + 1 < nKeys && laneKeyOfKey(ks[pp + 1]) === myKey) {
          const c = ks[pp + 1] % I_BITS, j = c >> 1;
          const sj = c & 1 ? vS[j] - edges[vEdge[j]].L : vS[j];
          gap = sj - s - vLen[j] * 0.5 - vLen[i] * 0.5;
          lv = vV[j];
        } else if (nx >= 0 && lookPos[i] >= 0 && ks.length > 0) {
          const lp = lookPos[i];
          const lk = laneKeyOfKey(ks[lp]);
          if (lp + 1 < nKeys && laneKeyOfKey(ks[lp + 1]) === lk) {
            const c = ks[lp + 1] % I_BITS, j = c >> 1;
            const sj = c & 1 ? vS[j] - edges[vEdge[j]].L : vS[j];
            gap = sj - (s - L) - vLen[j] * 0.5 - vLen[i] * 0.5;
            lv = vV[j];
          }
        }
        lookPos[i] = -1;
        if (gap < Infinity && !ghost) {
          const sStar = s0 + Math.max(0, v * T + (v * (v - lv)) / (2 * Math.sqrt(aMax * bC)));
          const g = Math.max(gap, 0.05);
          acc -= aMax * (sStar / g) * (sStar / g);
        }
        // 信号灯
        vHold[i] = 0;
        if (e.junction >= 0 && !ghost) {
          const stopAt = L - Math.min(STOP_BACK[e.cls] || 6, L * 0.4);
          const dStop = stopAt - s - vLen[i] * 0.5;
          if (dStop > -0.5 && dStop < 160) {
            const st = signal(e, t);
            const rightTurn = nx >= 0 && vNextA[i] > 0.5;
            if (st !== 0 && !rightTurn && !(st === 1 && dStop < (v * v) / (2 * 3.2))) {
              vHold[i] = 1;
              const g = Math.max(dStop, 0.05);
              const sStar = 1.0 + Math.max(0, v * T + (v * v) / (2 * Math.sqrt(aMax * bC)));
              const a2 = aMax * (1 - Math.pow(v / v0, 4) - (sStar / g) * (sStar / g));
              if (a2 < acc) acc = a2;
            }
          }
        }
        if (acc < -9) acc = -9;
        let nv = v + acc * dt;
        if (nv < 0) nv = 0;
        if (gap < 0.3 && !ghost) nv = Math.min(nv, 0.2);
        vAcc[i] = acc;
        vV[i] = nv;
        // 卡死保护：长时间停住且不是等红灯 → 短暂“穿越”
        if (nv < 0.1 && !vHold[i]) { vStuck[i] += dt; if (vStuck[i] > 45) { vGhost[i] = 4; vStuck[i] = 0; } }
        else vStuck[i] = 0;
        if (vGhost[i] > 0) vGhost[i] -= dt;
      }
      // 3) 积分 + 换边
      for (let k = nAlive - 1; k >= 0; k--) {
        const i = alive[k];
        let eid = vEdge[i];
        let e = edges[eid];
        let s = vS[i] + vV[i] * dt;
        let dead = false;
        let guard = 0;
        while (s >= e.L && guard++ < 4) {
          const nx = vNext[i];
          if (nx < 0 || !active[nx]) { dead = true; break; }
          s -= e.L;
          vPrev[i] = eid; vPrevLat[i] = vLat[i]; vPrevA[i] = vNextA[i];
          if (eCount[eid] > 0) eCount[eid]--;
          eCount[nx]++;
          eid = nx; e = edges[nx];
          vEdge[i] = nx;
          vLane[i] = vNextLane[i];
          vLat[i] = laneOffset(e, vLane[i]);
          chooseNext(i);
        }
        if (dead) { despawn(i); continue; }
        vS[i] = s;
        // 横向：路口过渡区之外才平滑换道
        const nx = vNext[i];
        const inBlendA = nx >= 0 && s > e.L - junctionR(vNextA[i], e.L);
        const inBlendB = vPrev[i] >= 0 && s < junctionR(vPrevA[i], e.L);
        if (!inBlendA && !inBlendB) {
          const tgt = laneOffset(e, vLane[i]);
          const d = tgt - vLat[i];
          const mx = 1.0 * dt * (0.4 + Math.min(1, vV[i] / 8));
          vLat[i] += d > mx ? mx : d < -mx ? -mx : d;
          if (inBlendB === false && vPrev[i] >= 0 && s > 30) vPrev[i] = -1;
        }
        // 灯光标志
        let fl = 0;
        if (vAcc[i] < -1.0 || vV[i] < 0.3) fl |= 1;
        const rem = e.L - s;
        if (nx >= 0 && rem < 50) { if (vNextA[i] < -0.5) fl |= 2; else if (vNextA[i] > 0.5) fl |= 4; }
        const dl = laneOffset(e, vLane[i]) - vLat[i];
        if (dl > 0.4) fl |= 4; else if (dl < -0.4) fl |= 2;
        vFlags[i] = fl;
      }
    }

    // —— 补车/收车（在看不见的地方）——
    let balCursor = 0;
    const tmpPose = new Float32Array(6);
    function hidden(x, y, z) {
      const cp = camera.position;
      const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
      return d > 1100 || !inFrustum(x, y, z, 12);
    }
    function balance() {
      const n = activeList.length;
      if (!n) return;
      const cnt = Math.min(n, 500);
      for (let q = 0; q < cnt; q++) {
        const id = activeList[(balCursor + q) % n];
        const e = edges[id];
        const tg = eTarget[id], c = eCount[id];
        if (c < tg * 0.7 - 0.4 && e.L > 24 && nAlive < capNow) {
          const lane = (rnd() * e.lanes) | 0;
          const s = 6 + rnd() * (e.L - 12);
          edgePose(id, s, laneOffset(e, lane), tmpPose, 0);
          if (!hidden(tmpPose[0], tmpPose[1], tmpPose[2])) continue;
          const lo = laneLower(id * 8 + lane);
          let ok = true;
          for (let p = lo; p < nKeys && laneKeyOfKey(keys[p]) === id * 8 + lane; p++) {
            const j = (keys[p] % I_BITS) >> 1;
            if (vEdge[j] === id && Math.abs(vS[j] - s) < 14) { ok = false; break; }
          }
          if (ok) spawn(id, lane, s, e.speed * 0.7);
        } else if (c > tg * 1.6 + 1.2) {
          for (let lane = 0; lane < e.lanes; lane++) {
            const lo = laneLower(id * 8 + lane);
            let done = false;
            for (let p = lo; p < nKeys && laneKeyOfKey(keys[p]) === id * 8 + lane; p++) {
              const code = keys[p] % I_BITS;
              if (code & 1) continue;
              const j = code >> 1;
              if (vEdge[j] !== id) continue;
              const o = j * 6;
              if (hidden(vPose[o], vPose[o + 1], vPose[o + 2])) { despawn(j); done = true; break; }
            }
            if (done) break;
          }
        }
      }
      balCursor = (balCursor + cnt) % Math.max(1, n);
    }

    // —— 绘制道路车辆 ——
    const nearCar = () => NEAR_CAR[level], nearHeavy = () => NEAR_HEAVY[level];
    function drawVehicles(night) {
      const cp = camera.position;
      const nc = nearCar(), nh = nearHeavy();
      const farMax = bubble.R + 400;
      const lightsOn = night > 0.02;
      for (let k = 0; k < nAlive; k++) {
        const i = alive[k];
        vehiclePose(i);
        const o = i * 6;
        const x = vPose[o], y = vPose[o + 1], z = vPose[o + 2];
        const type = vType[i];
        const len = vLen[i];
        if (!inFrustum(x, y + 1.5, z, len * 0.5 + 2)) continue;
        const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
        if (d > farMax) continue;
        let fx = vPose[o + 3], fy = vPose[o + 4], fz = vPose[o + 5];
        const fl = Math.hypot(fx, fy, fz) || 1;
        fx /= fl; fy /= fl; fz /= fl;
        const heavy = IS_HEAVY[type];
        let w;
        if (heavy ? d < nh : d < nc) w = heavy ? W.heavy : W.car;
        else w = W.far;
        if (!w.full()) {
          const idx = w.put(x, y, z, fx, fy, fz);
          w.set4(0, idx, vCol[i * 3], vCol[i * 3 + 1], vCol[i * 3 + 2], 1);
          w.set4(1, idx, type, vFlags[i], vSuv[i], vPack[i]);
        }
        if (lightsOn && !W.light.full()) {
          const lt = LIGHT_T[type];
          const idx = W.light.put(x, y, z, fx, fy, fz);
          const ly = type <= 1 && vSuv[i] ? 0.9 : lt[3];
          W.light.set4(0, idx, lt[0], lt[1], lt[2], ly);
          W.light.set4(1, idx, (vFlags[i] & 1) | 2 | 4, 0, 0, 0);
        }
      }
    }

    // ==================================================================
    // 列车
    // ==================================================================
    const rail = ctx.data.rail;
    const { feats: rfeats, strokes } = buildRailStrokes(rail);
    // 高架抬升与道路模块一致（roads_net.buildRailNet），缺失时退回 roadheight 规则
    const RAIL_TOP = 0.55;
    let railLift = null;
    try {
      if (typeof roadsNet.buildRailNet === 'function') {
        railLift = new Map();
        for (const r of roadsNet.buildRailNet(rail)) {
          const p = r.p;
          railLift.set(p.length + ':' + p[0] + ',' + p[1] + ':' + p[p.length - 2] + ',' + p[p.length - 1], r);
        }
      }
    } catch (err) {
      console.warn('[traffic] roads_net.buildRailNet 不可用，铁路高度退回 roadheight 规则', err);
      railLift = null;
    }
    const railUnit = roadsNet.RAIL_UNIT || BRIDGE_UNIT;
    const liftCache = new Map();
    function liftOf(f, ls, len) {
      let r = liftCache.get(f);
      if (r === undefined) {
        const p = f.p;
        r = railLift ? railLift.get(p.length + ':' + p[0] + ',' + p[1] + ':' + p[p.length - 2] + ',' + p[p.length - 1]) || null : null;
        liftCache.set(f, r);
      }
      if (r && r.lift) {
        const ch = r.ch, lf = r.lift, n = ch.length;
        const s = ls; // lift 数组按要素自身顶点顺序存储，ls 也是沿要素自身方向的里程
        let lo = 1, hi = n - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (ch[m] < s) lo = m + 1; else hi = m; }
        const t = Math.max(0, Math.min(1, (s - ch[lo - 1]) / Math.max(1e-6, ch[lo] - ch[lo - 1])));
        return RAIL_TOP + lf[lo - 1] + (lf[lo] - lf[lo - 1]) * t;
      }
      if (!f.b) return RAIL_TOP;
      const lift = railUnit * Math.max(1, f.y || 1);
      const ramp = Math.min(320, len * 0.35);
      const k = Math.max(0, Math.min(1, ls / ramp, (len - ls) / ramp));
      return RAIL_TOP + lift * k * k * (3 - 2 * k);
    }

    // 车站（停站用）
    const stations = (ctx.data.pois?.pois || []).filter((p) => p.k === 'station');
    // 笔画 50 m 采样点（粗定位/平行股道/车站匹配）
    const SAMPLE = 50;
    function strokeSamples(st) {
      const p = st.p;
      const out = [];
      let seg = 2, acc = 0, segL = Math.hypot(p[2] - p[0], p[3] - p[1]);
      for (let s = 0; s <= st.L; s += SAMPLE) {
        while (seg < p.length - 2 && acc + segL < s) { acc += segL; seg += 2; segL = Math.hypot(p[seg] - p[seg - 2], p[seg + 1] - p[seg - 1]); }
        const t = segL > 1e-6 ? Math.min(1, Math.max(0, (s - acc) / segL)) : 0;
        const dx = p[seg] - p[seg - 2], dz = p[seg + 1] - p[seg - 1], l = Math.hypot(dx, dz) || 1;
        out.push(p[seg - 2] + dx * t, p[seg - 1] + dz * t, dx / l, dz / l);
      }
      return Float32Array.from(out);
    }
    const lineNo = (name) => { const m = /(\d+)号线/.exec(name || ''); return m ? +m[1] : 0; };
    const cands = [];
    for (let si = 0; si < strokes.length; si++) {
      const st = strokes[si];
      if (st.kind < 0) continue;
      if (st.kind === RAIL_KIND.HSR && st.L < 3000) continue;
      if (st.kind === RAIL_KIND.CONV && (!st.name || st.L < 8000)) continue;
      if (st.kind === RAIL_KIND.METRO) {
        if (!lineNo(st.name) || st.L < 3000) continue;
        if (st.parts.every((q) => rfeats[q.fi].t || (rfeats[q.fi].y || 0) < 0)) continue;
      }
      cands.push({ si, st, smp: strokeSamples(st) });
    }
    // 平行股道 → 运行方向（国铁左侧行车，地铁右侧行车）
    const GC = 40, sgrid = new Map();
    cands.forEach((c, ci) => {
      const s = c.smp;
      for (let k = 0; k < s.length; k += 4) {
        const key = Math.floor(s[k] / GC) * 100003 + Math.floor(s[k + 1] / GC);
        let l = sgrid.get(key);
        if (!l) sgrid.set(key, (l = []));
        l.push(ci, k);
      }
    });
    for (let ci = 0; ci < cands.length; ci++) {
      const c = cands[ci], s = c.smp, ns = s.length / 4;
      let vote = 0;
      for (let q = Math.floor(ns * 0.15); q < ns * 0.85; q += Math.max(1, Math.floor(ns / 24))) {
        const k = q * 4, x = s[k], z = s[k + 1], hx = s[k + 2], hz = s[k + 3];
        let best = 1e9, side = 0;
        const gx = Math.floor(x / GC), gz = Math.floor(z / GC);
        for (let dx = -1; dx <= 1; dx++)
          for (let dz = -1; dz <= 1; dz++) {
            const l = sgrid.get((gx + dx) * 100003 + gz + dz);
            if (!l) continue;
            for (let m = 0; m < l.length; m += 2) {
              const cj = l[m];
              if (cj === ci || cands[cj].st.cls !== c.st.cls) continue;
              const o = cands[cj].smp, kk = l[m + 1];
              if (Math.abs(o[kk + 2] * hx + o[kk + 3] * hz) < 0.95) continue;
              const ddx = o[kk] - x, ddz = o[kk + 1] - z;
              const lat = ddx * -hz + ddz * hx;
              const lon = ddx * hx + ddz * hz;
              if (Math.abs(lat) < 2.5 || Math.abs(lat) > 12 || Math.abs(lon) > 30) continue;
              const dd = Math.abs(lat) + Math.abs(lon) * 0.2;
              if (dd < best) { best = dd; side = Math.sign(lat); }
            }
          }
        vote += side;
      }
      const leftRunning = c.st.kind !== RAIL_KIND.METRO;
      // side>0 = 另一股道在右侧 → 本股道是左股
      c.dir = vote === 0 ? (ci % 2 ? -1 : 1) : (vote > 0) === leftRunning ? 1 : -1;
    }
    // 停站
    const SG = 300, stGrid = new Map();
    stations.forEach((p, k) => {
      const key = Math.floor(p.x / SG) * 100003 + Math.floor(p.z / SG);
      let l = stGrid.get(key);
      if (!l) stGrid.set(key, (l = []));
      l.push(k);
    });
    function stopsFor(c) {
      const kind = c.st.kind;
      const s = c.smp;
      const lim = kind === RAIL_KIND.METRO ? 90 : 260;
      const best = new Map();
      for (let k = 0; k < s.length; k += 4) {
        const gx = Math.floor(s[k] / SG), gz = Math.floor(s[k + 1] / SG);
        for (let dx = -1; dx <= 1; dx++)
          for (let dz = -1; dz <= 1; dz++) {
            const l = stGrid.get((gx + dx) * 100003 + gz + dz);
            if (!l) continue;
            for (const si of l) {
              const p = stations[si];
              if (kind !== RAIL_KIND.METRO && (p.i || 0) < 3) continue;
              const dd = Math.hypot(s[k] - p.x, s[k + 1] - p.z);
              if (dd > lim) continue;
              const b = best.get(si);
              if (!b || dd < b.d) best.set(si, { d: dd, s: (k / 4) * SAMPLE });
            }
          }
      }
      const out = [];
      for (const b of best.values()) out.push({ s: b.s, dwell: kind === RAIL_KIND.METRO ? 30 : 120 });
      return out;
    }
    function buildTable(L, vmax, acc, stops) {
      const ds = 25, n = Math.max(2, Math.ceil(L / ds) + 1);
      const tA = new Float64Array(n), dw = new Float32Array(n), vs = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const s = Math.min(L, i * ds);
        let v = vmax;
        for (const st of stops) v = Math.min(v, Math.sqrt(2 * acc * Math.abs(s - st.s)) + 1.0);
        vs[i] = v;
      }
      for (const st of stops) { const k = Math.min(n - 1, Math.round(st.s / ds)); dw[k] += st.dwell; }
      for (let i = 1; i < n; i++) {
        const dsi = Math.min(L, i * ds) - Math.min(L, (i - 1) * ds);
        tA[i] = tA[i - 1] + dw[i - 1] + dsi / ((vs[i - 1] + vs[i]) * 0.5);
      }
      return { ds, n, tA, dw, L, T: tA[n - 1] + dw[n - 1] };
    }
    function sAt(tab, tau) {
      const { tA, dw, ds, n, L } = tab;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tA[m] <= tau) lo = m; else hi = m - 1; }
      const i = lo;
      const dep = tA[i] + dw[i];
      if (tau <= dep || i >= n - 1) return Math.min(L, i * ds);
      const f = (tau - dep) / Math.max(1e-6, tA[i + 1] - dep);
      return Math.min(L, (i + f) * ds);
    }
    // 编组
    const HSR_STRIPES = [0xd4262c, 0xd4262c, 0xd8a33a, 0xd8a33a, 0x2a62b8];
    const LOCO_COLS = [0xb22a20, 0xb22a20, 0x2f6a3e];
    const COACH_COLS = [0x2e5c40, 0x2e5c40, 0x9d2b22];
    const TANK_COLS = [0x1d1f22, 0x2a2c30];
    const RUST_COLS = [0x5b3a28, 0x6a4430, 0x4d3527];
    function consist(kind, seed, st) {
      const cars = [];
      const add = (tk, color, flags = 0, rev = false) => cars.push({ tk, len: TK_LEN[tk], color, flags, rev });
      if (kind === 'hsr') {
        const stripe = HSR_STRIPES[(hash(seed) * HSR_STRIPES.length) | 0];
        const n = hash(seed + 7) < 0.3 ? 16 : 8;
        add(TK.HSR_HEAD, stripe, 1);
        for (let k = 0; k < n - 2; k++) add(TK.HSR_MID, stripe);
        add(TK.HSR_HEAD, stripe, 2, true);
      } else if (kind === 'pax') {
        add(TK.LOCO, LOCO_COLS[(hash(seed) * 3) | 0], 1);
        const cc = COACH_COLS[(hash(seed + 3) * 3) | 0];
        const n = 12 + ((hash(seed + 5) * 6) | 0);
        for (let k = 0; k < n; k++) add(TK.COACH, cc, k === n - 1 ? 2 : 0);
      } else if (kind === 'freight') {
        add(TK.LOCO, LOCO_COLS[(hash(seed) * 3) | 0], 1);
        const tank = hash(seed + 9) < 0.3;
        const n = 22 + ((hash(seed + 5) * 14) | 0);
        for (let k = 0; k < n; k++) {
          const h = hash(seed * 31 + k);
          if (tank) add(TK.TANK, TANK_COLS[(h * 2) | 0], k === n - 1 ? 2 : 0);
          else add(TK.GONDOLA, RUST_COLS[(h * 3) | 0], k === n - 1 ? 2 : 0);
        }
      } else {
        const col = METRO_LINE_COLORS[lineNo(st.name)] || 0x3fb4e5;
        const n = lineNo(st.name) === 16 ? 4 : 6;
        add(TK.METRO_HEAD, col, 1);
        for (let k = 0; k < n - 2; k++) add(TK.METRO_MID, col);
        add(TK.METRO_HEAD, col, 2, true);
      }
      let off = 0;
      for (const c of cars) { c.off = off; off += c.len + 0.35; }
      return { cars, length: off };
    }
    const services = [];
    for (const c of cands) {
      const st = c.st;
      const stops = stopsFor(c);
      const name = st.name || '';
      if (st.kind === RAIL_KIND.HSR) {
        const tab = buildTable(st.L, 69, 0.38, stops);
        const n = Math.max(1, Math.floor(tab.T / 330));
        services.push({ c, kind: 'hsr', tab, n, period: tab.T + 60, phase: hash(c.si) * 1000, hours: [6.3, 23.7] });
      } else if (st.kind === RAIL_KIND.CONV) {
        const freightOnly = /北环|专用|联络|货/.test(name);
        if (!freightOnly) {
          const tab = buildTable(st.L, 33, 0.3, stops);
          services.push({ c, kind: 'pax', tab, n: Math.max(1, Math.floor(tab.T / 1500)), period: tab.T + 120, phase: hash(c.si + 1) * 3000, hours: [0, 24] });
        }
        const tabF = buildTable(st.L, 21, 0.2, []);
        services.push({ c, kind: 'freight', tab: tabF, n: Math.max(1, Math.floor(tabF.T / 1800)), period: tabF.T + 200, phase: hash(c.si + 2) * 5000, hours: [0, 24] });
      } else {
        const tab = buildTable(st.L, 21, 0.9, stops);
        services.push({ c, kind: 'metro', tab, n: Math.max(1, Math.floor(tab.T / 300)), period: tab.T + 60, phase: hash(c.si + 3) * 2000, hours: [6.0, 23.5] });
      }
    }
    for (const sv of services) {
      sv.trains = [];
      for (let k = 0; k < sv.n; k++) sv.trains.push(consist(sv.kind, sv.c.si * 131 + k * 17 + sv.kind.length, sv.c.st));
    }
    const strokeRes = new Map();
    let resampleBudget = 1; // 每帧最多新重采样 1 条线路（长线 3 万点），避免卡顿
    const strokeGeo = (c) => {
      let r = strokeRes.get(c.si);
      if (!r) {
        if (resampleBudget <= 0) return null;
        resampleBudget--;
        r = resampleStroke(c.st, rfeats, terrain, 5, 0, liftOf);
        strokeRes.set(c.si, r);
      }
      return r;
    };
    const TP = new Float32Array(4), TQ = new Float32Array(4);
    function strokePoint(r, s, out) {
      const n = r.n, st = r.st, xyz = r.xyz;
      let fi = s / st;
      if (fi < 0) fi = 0;
      if (fi > n - 1.0001) fi = n - 1.0001;
      const i0 = fi | 0, t = fi - i0, a = i0 * 3, b = a + 3;
      out[0] = xyz[a] + (xyz[b] - xyz[a]) * t;
      out[1] = xyz[a + 1] + (xyz[b + 1] - xyz[a + 1]) * t;
      out[2] = xyz[a + 2] + (xyz[b + 2] - xyz[a + 2]) * t;
      out[3] = r.tun[i0] || r.tun[i0 + 1] ? 1 : 0;
    }
    function drawTrains(t, night) {
      resampleBudget = 1;
      const cp = camera.position;
      const nearD = NEAR_TRAIN[level];
      const h = hoursNow;
      for (const sv of services) {
        if (h < sv.hours[0] || h > sv.hours[1]) continue;
        const c = sv.c, L = c.st.L, smp = c.smp;
        for (let k = 0; k < sv.n; k++) {
          const tr = sv.trains[k];
          const tau = (((t + sv.phase + (k * sv.period) / sv.n) % sv.period) + sv.period) % sv.period;
          if (tau > sv.tab.T) continue;
          const sh = sAt(sv.tab, tau);
          // 粗判距离
          const q = Math.min(smp.length / 4 - 1, Math.max(0, Math.round(sh / SAMPLE))) * 4;
          const u0 = c.dir > 0 ? q : (Math.min(smp.length / 4 - 1, Math.max(0, Math.round((L - sh) / SAMPLE)))) * 4;
          if (Math.hypot(smp[u0] - cp.x, smp[u0 + 1] - cp.z) > TRAIN_FAR + tr.length) continue;
          const r = strokeGeo(c);
          if (!r) continue;
          for (const car of tr.cars) {
            const sc = sh - car.off - car.len * 0.5;
            if (sc < -car.len || sc > L + car.len) continue;
            const half = car.len * 0.5 - 2.6;
            const sa = sc + half, sb = sc - half;
            const ua = c.dir > 0 ? sa : L - sa, ub = c.dir > 0 ? sb : L - sb;
            strokePoint(r, ua, TP);
            strokePoint(r, ub, TQ);
            if (TP[3] && TQ[3]) continue;
            const x = (TP[0] + TQ[0]) * 0.5, y = (TP[1] + TQ[1]) * 0.5, z = (TP[2] + TQ[2]) * 0.5;
            let fx = TP[0] - TQ[0], fy = TP[1] - TQ[1], fz = TP[2] - TQ[2];
            const fl = Math.hypot(fx, fy, fz);
            if (fl < 1e-3) continue;
            fx /= fl; fy /= fl; fz /= fl;
            if (!inFrustum(x, y + 2, z, car.len * 0.5 + 3)) continue;
            const tfx = fx, tfy = fy, tfz = fz; // 列车行进方向
            if (car.rev) { fx = -fx; fy = -fy; fz = -fz; } // 尾部头车：模型车头朝后
            const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
            const lf = car.flags; // 1 = 列车前端（白灯） 2 = 列车尾端（红灯）
            if (d < nearD) {
              if (!W.tNear.full()) {
                const i = W.tNear.put(x, y, z, fx, fy, fz);
                colTmp.setHex(car.color);
                W.tNear.set4(0, i, colTmp.r, colTmp.g, colTmp.b, 1);
                W.tNear.set4(1, i, car.tk, lf, 0, 0);
              }
            } else if (!W.tFar.full()) {
              const wh = TRAIN_WH[car.tk];
              const i = W.tFar.put(x, y, z, fx, fy, fz, wh[0], wh[1], car.len);
              colTmp.setHex(car.color);
              W.tFar.set4(0, i, colTmp.r, colTmp.g, colTmp.b, 1);
              W.tFar.set4(1, i, car.tk, lf, 0, 0);
            }
            if (night > 0.02 && lf && !W.light.full()) {
              const i = W.light.put(x, y, z, tfx, tfy, tfz);
              const zf = car.len * 0.5 + 0.1;
              W.light.set4(0, i, car.tk <= 1 ? 1.2 : 1.0, zf, -zf, car.tk <= 1 ? 1.25 : 1.4);
              W.light.set4(1, i, 8 | (lf & 1 ? 2 : 0) | (lf & 2 ? 4 : 0), 0, 0, 0);
            }
          }
        }
      }
    }

    // ==================================================================
    // 帧更新
    // ==================================================================
    let enabled = true;
    let statsShown = false;
    let perfMs = 0;
    const prof = { refresh: 0, sim: 0, balance: 0, drawV: 0, drawT: 0 };
    let refreshT = 0, balT = 0, first = true;
    const inst = {
      update(dt) {
        if (!enabled) return;
        const t0 = performance.now();
        dt = Math.min(dt, 0.1);
        simTime += dt;
        hoursNow = ctx.sky?.hours ?? hoursNow;
        refreshT -= dt;
        let tq = performance.now();
        const mark = (k) => { const n = performance.now(); if (n - tq > prof[k]) prof[k] = n - tq; tq = n; };
        if (first || refreshT <= 0) {
          refreshActive();
          refreshT = 0.4;
          first = false;
        }
        mark('refresh');
        // 大步长时分两次积分
        if (dt > 0.05) { simulate(dt * 0.5); simulate(dt * 0.5); } else simulate(dt);
        mark('sim');
        balT -= dt;
        if (balT <= 0) { balance(); balT = 0.25; }
        mark('balance');
        camera.updateMatrixWorld();
        projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projScreen, camera.coordinateSystem, camera.reversedDepth);
        const night = ctx.uniforms.uNight.value;
        for (const w of WL) w.reset();
        tq = performance.now();
        drawVehicles(night);
        mark('drawV');
        drawTrains(simTime, night);
        mark('drawT');
        for (const w of WL) w.commit();
        lightMesh.visible = night > 0.02;
        perfMs = perfMs * 0.95 + (performance.now() - t0) * 0.05;
        if (DEBUG_STATS && simTime > 1 && !statsShown) { statsShown = true; console.warn('[traffic] ' + JSON.stringify(inst.stats())); }
        const hgt = ctx.renderer.domElement.height || 1080;
        const fov = (camera.fov * Math.PI) / 180;
        pixelU.value = (2 * Math.tan(fov / 2)) / Math.max(1, hgt);
      },
      setLayer(name, on) {
        if (name !== 'traffic') return;
        enabled = on;
        root.visible = on;
      },
      setQuality(q) {
        level = Math.max(0, Math.min(3, q.level ?? level));
        capNow = CAP_BY_LEVEL[level];
        for (const m of [carMesh, heavyMesh, trainNearMesh]) m.castShadow = shadowsOn();
        refreshT = 0;
      },
      /** 调试：列出 (x,z) 半径 r 内的列车车头 */
      debugTrains(x, z, r, t = simTime) {
        const out = [];
        for (const sv of services) {
          const c = sv.c, L = c.st.L, smp = c.smp;
          for (let k = 0; k < sv.n; k++) {
            const tau = (((t + sv.phase + (k * sv.period) / sv.n) % sv.period) + sv.period) % sv.period;
            if (tau > sv.tab.T) continue;
            const sh = sAt(sv.tab, tau);
            const u = c.dir > 0 ? sh : L - sh;
            const q = Math.min(smp.length / 4 - 1, Math.max(0, Math.round(u / SAMPLE))) * 4;
            const d = Math.hypot(smp[q] - x, smp[q + 1] - z);
            if (d < r) out.push({ name: c.st.name, kind: sv.kind, dir: c.dir, x: Math.round(smp[q]), z: Math.round(smp[q + 1]), d: Math.round(d) });
          }
        }
        return out;
      },
      /** 调试：各阶段最大耗时（ms），读取后清零 */
      profile() { const o = { ...prof }; for (const k in prof) prof[k] = 0; return o; },
      stats() {
        let stopped = 0, ghosts = 0, vsum = 0, held = 0;
        for (let k = 0; k < nAlive; k++) {
          const i = alive[k];
          if (vV[i] < 0.3) stopped++;
          if (vGhost[i] > 0) ghosts++;
          if (vHold[i]) held++;
          vsum += vV[i];
        }
        return { vehicles: nAlive, stopped, held, ghosts, vAvg: +(vsum / Math.max(1, nAlive)).toFixed(2), ms: +perfMs.toFixed(2), activeEdges: activeList.length, bubbleR: bubble.R, near: W.car.n, heavy: W.heavy.n, far: W.far.n, lights: W.light.n, trainsNear: W.tNear.n, trainsFar: W.tFar.n, services: services.length };
      },
    };
    if (typeof window !== 'undefined') window.__traffic = inst;
    return inst;
  },
};
