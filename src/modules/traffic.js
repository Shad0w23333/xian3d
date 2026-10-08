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
import { buildRoadGraph, blockEdges, resampleFeature, buildRailStrokes, resampleStroke, RAIL_KIND } from '../arch/traffic_net.js';
import {
  heavyNearGeometry, farVehicleGeometry, trainNearGeometry, trainFarGeometry,
  VK, VK_LEN, TK, TK_LEN, pickCarColor, TAXI_GREEN, TAXI_YELLOW, BUS_LIVERIES, DUMP_GREEN,
  TRUCK_CAB_COLORS, SECOND_COLORS, METRO_LINE_COLORS,
} from '../arch/traffic_models.js';
import { carGeometry, CAR_LEN, CAR_SHAPES } from '../arch/vehicle-cars.js';
import { nearMaterial, depthMaterial, packRGB } from '../arch/vehicle-mats.js';
import { bikeGeometries, BIKE, OPT, SEAT, BIKE_LEN, SCOOTER_COLORS, SHARED_BIKES, PRIVATE_BIKES, COURIER, EXPRESS_BOX } from '../arch/vehicle-bikes.js';
import { peopleGeometry, peopleMaterial, peopleDepthMaterial, createPeopleMesh, randomLook, SEAT_H, MODE } from '../arch/people-geo.js';
import * as roadsNet from '../arch/roads_net.js';
import { BRIDGE_UNIT, LIFT } from '../core/roadheight.js';
import { parkingPlan, parkHash, featureWidth } from '../arch/vehicle-parking.js';

// ======================================================================
// 参数
// ======================================================================
const CAP_BY_LEVEL = [2600, 4600, 7000, 9000]; // 同时仿真的最大车辆数
const NEAR_CAR = [110, 180, 250, 330]; // 近景小汽车距离
const NEAR_HEAVY = [150, 240, 330, 430];
const FINE_CAR = [35, 50, 70, 90]; // 小汽车细模距离
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
/** 加权抽取：list = [[..., weight], ...]（权重为最后一项），返回下标 */
function pickW(r, list) {
  let s = 0;
  for (const it of list) s += it[it.length - 1];
  let x = r * s;
  for (let k = 0; k < list.length; k++) { x -= list[k][list[k].length - 1]; if (x <= 0) return k; }
  return list.length - 1;
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
  { A: [1.27, 1.25, 1.5, 0], Y: [0.3, 1.15, 2.75, 3.22], Z: [9.0, -9.0, 8.98, -8.98], Z2: [8.95, -8.95, 0, 0] },
  { A: [1.27, 1.25, 1.5, 0], Y: [0.3, 1.15, 2.75, 3.22], Z: [3.0, -3.0, 2.98, -2.98], Z2: [2.95, -2.95, 0, 0] },
];
const FAR_SUV = { Y: [0.28, 1.07, 1.66, 1.72], Z: [2.38, -2.38, 1.18, -1.95], Z2: [0.42, -1.9, 0, 0] };
const FAR_MPV = { Y: [0.24, 1.05, 1.72, 1.785], Z: [2.5, -2.55, 1.45, -2.44], Z2: [0.65, -2.3, 0, 0] };
// 车灯精灵参数：(灯半距, 前灯 z, 尾灯 z, 灯高)
const LIGHT_T = [[0.62, 2.28, -2.32, 0.72], [0.62, 2.28, -2.32, 0.72], [0.95, 6.0, -6.0, 0.82], [0.95, 4.3, -4.3, 1.0], [0.95, 3.8, -3.8, 0.95], [0.95, 8.25, -8.25, 1.0], [0.95, 9.0, -9.0, 0.82], [0.95, 3.0, -3.0, 0.82]];
const IS_HEAVY = [0, 0, 1, 1, 1, 1, 1, 1];
const isBus = (t) => t === VK.BUS || t === VK.BUS_A;
// 列车远景尺寸 (宽, 高)
const TRAIN_WH = [[3.36, 4.05], [3.36, 4.05], [3.1, 4.3], [3.1, 4.3], [3.2, 3.1], [2.9, 3.9], [2.8, 3.75], [2.8, 3.75]];

// ======================================================================
// 着色器注入
// ======================================================================
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
    sh.uniforms.uMpvY = { value: new THREE.Vector4(...FAR_MPV.Y) };
    sh.uniforms.uMpvZ = { value: new THREE.Vector4(...FAR_MPV.Z) };
    sh.uniforms.uMpvZ2 = { value: new THREE.Vector4(...FAR_MPV.Z2) };
    sh.uniforms.uPixel = pixelU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
attribute vec4 aFar;
attribute vec3 aFarOff;
attribute vec4 iColor;
attribute vec4 iData;
uniform vec4 uFA[8];
uniform vec4 uFY[8];
uniform vec4 uFZ[8];
uniform vec4 uFZ2[8];
uniform vec4 uSuvY;
uniform vec4 uSuvZ;
uniform vec4 uSuvZ2;
uniform vec4 uMpvY;
uniform vec4 uMpvZ;
uniform vec4 uMpvZ2;
uniform float uPixel;
varying vec4 vFar;
varying vec3 vTrBody;
varying vec4 vTrInfo;
varying float vFront;`)
      .replace('#include <begin_vertex>', /* glsl */ `
int ty = int(iData.x + 0.5);
vec4 A = uFA[ty]; vec4 Y = uFY[ty]; vec4 Z = uFZ[ty]; vec4 Z2 = uFZ2[ty];
if (ty <= 1 && iData.z > 0.5) {
  if (iData.z < 1.5) { Y = uSuvY; Z = uSuvZ; Z2 = uSuvZ2; } else { Y = uMpvY; Z = uMpvZ; Z2 = uMpvZ2; }
}
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
  float trOn = 1.0 - trBit(vTrInfo.y, 16.0); // 16 = 路边停车（熄火）
  if (trMt > 2.5 && trMt < 3.5) E = vec3(1.0, 0.95, 0.85) * (0.6 + uNight * 7.0) * trOn;
  else if (trMt > 3.5) E = vec3(1.0, 0.03, 0.015) * (trBit(vTrInfo.y, 1.0) > 0.5 ? 7.0 : (0.05 + uNight * 3.5) * trOn);
  else if (trGlass && trTy == 2) E = vec3(1.0, 0.88, 0.68) * uNight * 0.3;
  totalEmissiveRadiance = E;
}`);
  };
  mat.customProgramCacheKey = () => 'traffic-farveh2';
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

/** 车灯精灵几何：每实例 6 个四边形（左右前灯、左右尾灯、前大灯路面光斑、尾灯路面红晕） */
function lightGeometry() {
  const P = [], L = [], I = [];
  let v = 0;
  const quad = (which, side) => {
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { P.push(0, 0, 0); L.push(which, side, cx, cy); }
    I.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };
  quad(0, 1); quad(0, -1); quad(1, 1); quad(1, -1); quad(2, 0); quad(3, 0);
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
  float ks = iLF.y > 0.0 ? iLF.y : 1.0; // 尺寸系数（两轮车 0.3 左右）
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
    float worldR = (big ? 0.32 : (head ? 0.16 : 0.13)) * ks;
    float pixR = uPixel * d * (head ? 1.5 : 1.45) * sqrt(ks);
    float r = max(worldR, pixR);
    float e = clamp(worldR * worldR / (r * r), 0.0, 1.0);
    e = mix(0.6, 1.0, e);
    float brake = trBit(fl, 1.0);
    vec3 col = (head ? vec3(1.0, 0.9, 0.74) * (big ? 7.0 : 3.4) : vec3(1.0, 0.07, 0.03) * (brake > 0.5 ? 5.0 : 2.6)) * mix(0.6, 1.0, ks);
    vCol = col * vis * e * uNight;
    vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    wp = c + V * min(0.6, d * 0.02) + (camR * aL.z + camU * aL.w) * r * 2.6;
  } else if (which < 2.5) {
    // 前大灯在路面上的光斑（近处才有）：两束近光叠成前窄后宽的扇形，近处亮
    float on = trBit(fl, 2.0) * (big ? 0.0 : 1.0);
    float d = distance(cameraPosition, O);
    float fade = 1.0 - smoothstep(160.0, 300.0, d);
    float L = 9.0 * ks;
    vec3 c = O + Fz * (iLight.y + L);
    vec3 Lh = normalize(vec3(Lx.x, 0.0, Lx.z));
    vec3 Fh = normalize(vec3(Fz.x, 0.0, Fz.z));
    wp = c + Lh * aL.z * 3.0 * ks * (0.75 + 0.25 * aL.w) + Fh * aL.w * L + vec3(0.0, 0.12, 0.0);
    vCol = vec3(1.0, 0.86, 0.66) * 0.42 * on * fade * uNight * mix(0.5, 1.0, ks);
  } else {
    // 尾灯在路面上的红晕（刹车时更亮）
    float on = trBit(fl, 4.0) * (big ? 0.0 : 1.0);
    float d = distance(cameraPosition, O);
    float fade = 1.0 - smoothstep(90.0, 180.0, d);
    vec3 c = O + Fz * (iLight.z - 1.4 * ks);
    vec3 Lh = normalize(vec3(Lx.x, 0.0, Lx.z));
    vec3 Fh = normalize(vec3(Fz.x, 0.0, Fz.z));
    wp = c + Lh * aL.z * 1.3 * ks + Fh * aL.w * 1.6 * ks + vec3(0.0, 0.11, 0.0);
    vCol = vec3(1.0, 0.05, 0.02) * (trBit(fl, 1.0) > 0.5 ? 0.32 : 0.12) * on * fade * uNight;
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
  } else if (vKind < 2.5) {
    vec2 q = vUv;
    // 近亮远暗、边缘柔和
    a = (1.0 - smoothstep(0.15, 1.0, length(vec2(q.x, q.y * 0.9)))) * smoothstep(-1.0, -0.55, q.y) * (1.25 - 0.5 * (q.y * 0.5 + 0.5));
  } else {
    a = 1.0 - smoothstep(0.0, 1.0, length(vUv));
    a *= a;
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
    // 小汽车两级：细模（近，约 1700 三角形）/ 中景模（约 800）；远处统一代理盒
    const carMat = nearMaterial(ctx, { morph: true, secondLin });
    const carFineMesh = instanced(carGeometry(0), carMat, 900, ['iColor', 'iData'], '近景小汽车（细）');
    const carMesh = instanced(carGeometry(1), carMat, 2600, ['iColor', 'iData'], '近景小汽车');
    carFineMesh.customDepthMaterial = carMesh.customDepthMaterial = depthMaterial({ morph: true });
    const heavyMesh = instanced(heavyNearGeometry(), nearMaterial(ctx, { secondLin }), 900, ['iColor', 'iData'], '近景大型车');
    heavyMesh.customDepthMaterial = depthMaterial();
    // 两轮/三轮车（踏板电动车、自行车、快递三轮各一个网格）+ 骑手（近景细模 / 远景简模）
    const bikeMat = nearMaterial(ctx, { bike: true, secondLin });
    const bikeDepth = depthMaterial({ bike: true });
    const bikeMeshes = bikeGeometries().map((g, k) => {
      const m = instanced(g, bikeMat, [800, 450, 140][k], ['iColor', 'iData'], ['电动车', '自行车', '快递三轮'][k]);
      m.customDepthMaterial = bikeDepth;
      return m;
    });
    const riderMat = peopleMaterial(ctx);
    const RN = createPeopleMesh(ctx, peopleGeometry(0), riderMat, 260, '骑手（近景）');
    const RF = createPeopleMesh(ctx, peopleGeometry(1), riderMat, 1000, '骑手');
    RN.mesh.customDepthMaterial = peopleDepthMaterial(ctx);
    const farMesh = instanced(farVehicleGeometry(), farVehicleMaterial(ctx, secondLin, pixelU), CAPMAX, ['iColor', 'iData'], '远景车辆');
    const lightMat = lightMaterial(ctx);
    lightMat.uniforms.uPixel = pixelU;
    lightMat.uniforms.uNight = ctx.uniforms.uNight;
    const lightMesh = instanced(lightGeometry(), lightMat, CAPMAX + 400, ['iLight', 'iLF'], '车灯');
    lightMesh.renderOrder = 8;
    const trainNearMesh = instanced(trainNearGeometry(), nearMaterial(ctx, { train: true, secondLin }), 700, ['iColor', 'iData'], '近景列车');
    trainNearMesh.customDepthMaterial = depthMaterial();
    const trainFarMesh = instanced(trainFarGeometry(), farTrainMaterial(ctx, pixelU), 2400, ['iColor', 'iData'], '远景列车');
    const shadowsOn = () => !!Q.shadows && level >= 1;
    const shadowCasters = [carFineMesh, carMesh, heavyMesh, trainNearMesh, ...bikeMeshes, RN.mesh];
    for (const m of shadowCasters) { m.castShadow = shadowsOn(); m.receiveShadow = true; }
    farMesh.receiveShadow = true;
    RF.mesh.receiveShadow = true;
    root.add(carFineMesh, carMesh, heavyMesh, farMesh, trainNearMesh, trainFarMesh, lightMesh, ...bikeMeshes, RN.mesh, RF.mesh);
    const W = {
      carFine: new Writer(carFineMesh, ['iColor', 'iData']),
      car: new Writer(carMesh, ['iColor', 'iData']),
      bike0: new Writer(bikeMeshes[0], ['iColor', 'iData']),
      bike1: new Writer(bikeMeshes[1], ['iColor', 'iData']),
      bike2: new Writer(bikeMeshes[2], ['iColor', 'iData']),
      heavy: new Writer(heavyMesh, ['iColor', 'iData']),
      far: new Writer(farMesh, ['iColor', 'iData']),
      light: new Writer(lightMesh, ['iLight', 'iLF']),
      tNear: new Writer(trainNearMesh, ['iColor', 'iData']),
      tFar: new Writer(trainFarMesh, ['iColor', 'iData']),
    };
    const WL = Object.values(W);
    const WB = [W.bike0, W.bike1, W.bike2];

    // —— 路网 ——
    // 景区/公园里的无名支路（大慈恩寺绕三藏院的环路等）按步行道处理，不进车行路网（与 roads 同一规则）
    if (typeof roadsNet.markParkWalkways === 'function') roadsNet.markParkWalkways(ctx.data.roads, ctx.data.landuse);
    const G = buildRoadGraph(ctx.data.roads);
    // 步行街与“道路模块不画路面”的地方（大唐不夜城步行街、下沉广场坑口、楼体内部路段等，排除区 roads=true）不跑车
    const EX = ctx.exclusions;
    const nBlocked = EX && EX.items && EX.items.length ? blockEdges(G, (x, z) => EX.test(x, z, 'roads')) : 0;
    if (nBlocked) console.warn(`[traffic] 封闭不通车的边 ${nBlocked} 条（步行街/排除区）`);
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
    // 车道中心偏移（右正）；有路边停车的一侧整体向中线让出 parkShift
    const laneOffset = (e, lane) => (e.twoWay ? (e.lanes - lane - 0.5) * e.lw : ((e.lanes - 1) / 2 - lane) * e.lw) - e.parkShift;
    // —— 路边停车方案（按要素；停车一侧的行车道向中线让位）——
    const parkPlans = new Array(feats.length);
    let nParkFeat = 0;
    for (let fi = 0; fi < feats.length; fi++) {
      const f = feats[fi];
      if (!f || !f.p) continue;
      const pl = parkingPlan(f, fi);
      if (pl) { parkPlans[fi] = pl; nParkFeat++; }
    }
    for (const e of edges) {
      e.parkShift = 0;
      const pl = parkPlans[e.f];
      if (!pl) continue;
      // 有向边的右侧 = 要素右侧（正向）或左侧（反向）
      const sideOn = e.dir > 0 ? pl.side[0] : pl.side[1];
      if (!sideOn) continue;
      const base = e.twoWay ? (e.lanes - 0.5) * e.lw : ((e.lanes - 1) / 2) * e.lw;
      e.parkShift = Math.max(0, base - pl.minLane);
    }
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
    const vCol = new Float32Array(CAP * 3), vPack = new Float32Array(CAP), vSuv = new Uint8Array(CAP), vSec = new Float32Array(CAP);
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
      // 铰接公交：主干道上约占公交的 12%
      if ((r -= pBus) < 0) return (cls === 2 || cls === 1) && r + pBus < pBus * 0.12 ? VK.BUS_A : VK.BUS;
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
      vSec[i] = 1;
      let second = 0, plate = 0;
      const r = rnd();
      switch (type) {
        case VK.CAR: {
          setColor(i, pickCarColor(rnd()));
          // 轿车约一半、SUV 约四成、MPV 约一成
          vSuv[i] = r < 0.5 ? 0 : r < 0.88 ? 1 : 2;
          second = rnd() < 0.08 ? 7 : -1;
          plate = rnd() < 0.32 ? 1 : 0; // 新能源绿牌约三成
          break;
        }
        case VK.TAXI: {
          // 西安纯电动出租车（比亚迪 e5）：荷叶绿车身 + 黑色车顶、绿牌；其余为甲醇车（车身色按推测取琉璃黄）
          const green = r < 0.74;
          setColor(i, green ? TAXI_GREEN : TAXI_YELLOW);
          vSuv[i] = green && rnd() < 0.12 ? 1 : 0;
          second = green ? 7 : -1;
          plate = green ? 1 : 0;
          break;
        }
        case VK.BUS: case VK.BUS_A: {
          const lv = BUS_LIVERIES[pickW(r, BUS_LIVERIES)];
          setColor(i, lv[0]);
          vSec[i] = packRGB(lv[1]);
          plate = 3; second = 8;
          break;
        }
        case VK.DUMP: setColor(i, DUMP_GREEN); plate = 2; second = 8; break;
        case VK.BOXTRUCK: setColor(i, TRUCK_CAB_COLORS[(r * TRUCK_CAB_COLORS.length) | 0]); second = [0, 0, 1, 2, 5, 6][(rnd() * 6) | 0]; plate = 2; break;
        case VK.SEMI: setColor(i, TRUCK_CAB_COLORS[(r * TRUCK_CAB_COLORS.length) | 0]); second = [2, 3, 4, 5, 6, 1, 0][(rnd() * 7) | 0]; plate = 2; break;
      }
      if (second < 0) second = 8; // 8 = 车顶与车身同色
      vPack[i] = second + plate * 16 + ((rnd() * 12) | 0) * 64;
      if (type <= 1) vLen[i] = CAR_LEN[vSuv[i]];
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
      if (IS_HEAVY[type] && e.lanes > 1) lane = Math.min(lane, isBus(type) ? 0 : 1);
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
      if (heavy) lane = Math.min(lane, isBus(vType[i]) ? 0 : 1);
      vLane[i] = Math.min(lane, e.lanes - 1);
      let nlane;
      if (a > 0.5) nlane = 0;
      else if (a < -0.5) nlane = nl - 1;
      else nlane = e.lanes > 1 ? Math.round((vLane[i] * (nl - 1)) / (e.lanes - 1)) : Math.min(vLane[i], nl - 1);
      if (heavy) nlane = Math.min(nlane, isBus(vType[i]) ? 0 : 1);
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
        if (e.blocked) continue;
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
      bikeRefresh(Q.trafficDensity ?? 1); // 时段系数由 bikeHour 单独给出
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
        let v0 = e.speed * vVf[i] * (isBus(type) ? 0.78 : heavy ? 0.86 : 1);
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

    // ==================================================================
    // 两轮/三轮车：电动车（含外卖骑手）、共享单车/自行车、快递三轮。在非机动车道（车道外有富余时）或最右车道外缘骑行，
    // 12~20 km/h，遵守信号灯（右转不受限），路口红灯时排队停在停止线后；只在相机附近的活动边上仿真。
    // ==================================================================
    const BIKE_CAP = [260, 450, 680, 900];
    const BIKE_DRAW = [140, 190, 240, 300];
    const BIKE_R = [450, 600, 750, 900];
    const RIDER_NEAR = 60;
    //                 0  1  2   3   4   5  6  7  8  9  10 11   （每向每公里，高峰）
    const BIKE_DENS = [0, 0, 30, 26, 20, 8, 0, 9, 0, 0, 10, 9];
    const BIKE_HOURS = [[0, 0.12], [5, 0.06], [6.5, 0.35], [7.5, 1.0], [9, 0.72], [11, 0.66], [12, 0.92], [13.5, 0.75], [16, 0.72], [17.5, 1.0], [19, 0.9], [20.5, 0.68], [22, 0.42], [24, 0.12]];
    const bikeHour = (h) => {
      h = ((h % 24) + 24) % 24;
      for (let k = 1; k < BIKE_HOURS.length; k++) {
        const [h1, v1] = BIKE_HOURS[k];
        if (h <= h1) { const [h0, v0] = BIKE_HOURS[k - 1]; return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0); }
      }
      return 0.12;
    };
    // 外卖骑手占电动车比例：饭点高、深夜高
    const courierShare = (h) => 0.1 + 0.18 * Math.max(bump(h, 10.8, 13.2), bump(h, 17.0, 20.2)) + (h >= 21.5 || h < 1.5 ? 0.15 : 0);
    const BMAX = BIKE_CAP[3];
    let bikeCapNow = BIKE_CAP[level];
    const bEdge = new Int32Array(BMAX).fill(-1), bNext = new Int32Array(BMAX).fill(-1), bPrev = new Int32Array(BMAX).fill(-1);
    const bS = new Float32Array(BMAX), bV = new Float32Array(BMAX), bVf = new Float32Array(BMAX), bAcc = new Float32Array(BMAX);
    const bLat = new Float32Array(BMAX), bPrevLat = new Float32Array(BMAX), bNextA = new Float32Array(BMAX), bPrevA = new Float32Array(BMAX);
    const bSlot = new Int8Array(BMAX), bType = new Uint8Array(BMAX), bOpt = new Uint8Array(BMAX), bFl = new Uint8Array(BMAX), bStuck = new Float32Array(BMAX);
    const bCol = new Float32Array(BMAX * 3), bSec = new Float32Array(BMAX), bPh = new Float32Array(BMAX), bPose = new Float32Array(BMAX * 6);
    const bLook = new Array(BMAX);
    const bAlive = new Int32Array(BMAX), bWhere = new Int32Array(BMAX).fill(-1), bFree = new Int32Array(BMAX);
    let nB = 0, nBFree = BMAX;
    for (let k = 0; k < BMAX; k++) bFree[k] = BMAX - 1 - k;
    const bCount = new Uint16Array(NE), bTarget = new Float32Array(NE), bActive = new Uint8Array(NE);
    let bikeList = [];
    const bikeOK = (e) => !e.blocked && BIKE_DENS[e.cls] > 0 && !feats[e.f].b;
    // 骑行横向位置：车道外有 ≥ 1.3 m 富余 → 富余带中间（非机动车道）；否则最右车道外缘；该侧有路边停车 → 停车带内侧
    const bLatCache = new Float32Array(NE).fill(NaN);
    function bikeLatOf(e) {
      let v = bLatCache[e.id];
      if (v === v) return v;
      const f = feats[e.f];
      const half = featureWidth(f) / 2;
      const carEdge = e.twoWay ? e.lanes * e.lw : (e.lanes * e.lw) / 2;
      const spare = half - carEdge;
      const pl = parkPlans[e.f];
      const parkedHere = pl && (e.dir > 0 ? pl.side[0] : pl.side[1]);
      if (parkedHere) v = pl.lat - 0.92 - 0.55;
      else v = spare >= 1.3 ? carEdge + Math.min(spare * 0.5, 1.4) : Math.max(carEdge - 0.45, half - 0.75);
      bLatCache[e.id] = v;
      return v;
    }
    const colTmp2 = new THREE.Color();
    const setBikeColor = (b, hex) => { colTmp2.setHex(hex); bCol[b * 3] = colTmp2.r; bCol[b * 3 + 1] = colTmp2.g; bCol[b * 3 + 2] = colTmp2.b; };
    function dressBike(b) {
      const h = hoursNow;
      const day = h >= 7 && h < 20;
      const r = rnd();
      let type = r < (day ? 0.05 : 0.015) ? BIKE.TRICYCLE : r < 0.34 ? BIKE.BICYCLE : BIKE.SCOOTER;
      let opt = 0, courier = null, sec = 1, speed;
      if (type === BIKE.SCOOTER) {
        setBikeColor(b, SCOOTER_COLORS[pickW(rnd(), SCOOTER_COLORS)][0]);
        if (rnd() < courierShare(h)) {
          courier = rnd() < 0.6 ? 'meituan' : 'eleme';
          opt |= OPT.BOX;
          sec = packRGB(COURIER[courier]);
        } else {
          if (rnd() < 0.35) opt |= OPT.BASKET;
          if (rnd() < 0.08) opt |= OPT.SHIELD;
        }
        speed = courier ? 4.6 + rnd() * 0.95 : 3.9 + rnd() * 1.5;
      } else if (type === BIKE.BICYCLE) {
        if (rnd() < 0.85) { setBikeColor(b, SHARED_BIKES[pickW(rnd(), SHARED_BIKES)][0]); opt |= OPT.BASKET; }
        else { setBikeColor(b, PRIVATE_BIKES[(rnd() * PRIVATE_BIKES.length) | 0]); if (rnd() < 0.4) opt |= OPT.BASKET; }
        speed = 3.3 + rnd() * 1.3;
      } else {
        setBikeColor(b, rnd() < 0.6 ? 0xe8e8e4 : 0x8a8d92);
        sec = packRGB(EXPRESS_BOX[pickW(rnd(), EXPRESS_BOX)][0]);
        speed = 3.6 + rnd() * 1.2;
      }
      bType[b] = type; bOpt[b] = opt; bSec[b] = sec; bVf[b] = speed;
      const look = randomLook(rnd, { rider: type !== BIKE.BICYCLE, courier });
      // 骑电动车约八成戴头盔；骑共享单车的人不拿手机
      if (type !== BIKE.BICYCLE && !courier && rnd() < 0.2) look.mask &= ~64;
      look.mask &= ~1024;
      bLook[b] = look;
      bPh[b] = rnd();
      const sr = rnd();
      bSlot[b] = sr < 0.5 ? 0 : sr < 0.78 ? 1 : -1;
    }
    function bikeSpawn(eid, s, v) {
      if (!nBFree || nB >= bikeCapNow) return -1;
      const b = bFree[--nBFree];
      const e = edges[eid];
      dressBike(b);
      bEdge[b] = eid; bS[b] = s; bV[b] = Math.min(v, bVf[b]); bAcc[b] = 0; bPrev[b] = -1; bStuck[b] = 0;
      bLat[b] = bikeLatOf(e) + bSlot[b] * 0.42;
      bikeChooseNext(b);
      bCount[eid]++;
      bWhere[b] = nB; bAlive[nB++] = b;
      return b;
    }
    function bikeDespawn(b) {
      const e = bEdge[b];
      if (e < 0) return;
      if (bCount[e] > 0) bCount[e]--;
      bEdge[b] = -1;
      const w = bWhere[b], last = bAlive[--nB];
      bAlive[w] = last; bWhere[last] = w; bWhere[b] = -1;
      bFree[nBFree++] = b;
    }
    function bikeChooseNext(b) {
      const e = edges[bEdge[b]];
      const nx = e.next;
      bNext[b] = -1;
      if (!nx.length) return;
      let tot = 0;
      for (let k = 0; k < nx.length && k < 16; k++) {
        const o = edges[nx[k].e], a = nx[k].a;
        let w = Math.abs(a) < 0.35 ? 4 : a > 0 ? 1.3 : 0.7;
        if (!bikeOK(o)) w = 0;
        else if (!bActive[o.id]) w *= 0.04;
        wTmp[k] = w; tot += w;
      }
      if (tot <= 0) return;
      let r = rnd() * tot, pick = -1;
      for (let k = 0; k < nx.length && k < 16; k++) { r -= wTmp[k]; if (r <= 0 && wTmp[k] > 0) { pick = k; break; } }
      if (pick < 0) return;
      bNext[b] = nx[pick].e;
      bNextA[b] = nx[pick].a;
    }
    function bikeRefresh(dens) {
      const cp = camera.position;
      const R = BIKE_R[level];
      const hk = bikeHour(hoursNow) * dens;
      const list = [];
      const fill = [];
      for (const id of activeList) {
        const e = edges[id];
        if (!bikeOK(e)) continue;
        const d = Math.hypot(Math.max(e.x0 - cp.x, 0, cp.x - e.x1), Math.max(e.z0 - cp.z, 0, cp.z - e.z1));
        if (d > R) continue;
        bTarget[id] = (e.L * BIKE_DENS[e.cls] * hk) / 1000;
        list.push(id);
        if (!bActive[id]) fill.push(id);
      }
      for (const id of bikeList) bActive[id] = 0;
      for (const id of list) bActive[id] = 1;
      bikeList = list;
      for (let k = nB - 1; k >= 0; k--) { const b = bAlive[k]; if (!bActive[bEdge[b]]) bikeDespawn(b); }
      for (const id of fill) {
        const e = edges[id];
        let n = Math.floor(bTarget[id] + rnd());
        for (let q = 0; q < n; q++) if (bikeSpawn(id, (q + 0.2 + rnd() * 0.6) * (e.L / n), 2 + rnd() * 3) < 0) break;
      }
    }
    // 排序键：(边×4 + 车位) → 里程 → 车号
    const bKeys = new Float64Array(BMAX + 8);
    const bLaneKey = (k) => Math.floor(k / 33554432);
    function bikeSim(dt, t) {
      let nk = 0;
      for (let q = 0; q < nB; q++) {
        const b = bAlive[q];
        const sq = Math.max(0, Math.min(32767, Math.round((bS[b] + 20) * 20)));
        bKeys[nk++] = ((bEdge[b] * 4 + bSlot[b] + 1) * 32768 + sq) * 1024 + q;
      }
      const ks = bKeys.subarray(0, nk);
      ks.sort();
      for (let p = 0; p < nk; p++) {
        const q = ks[p] % 1024, b = bAlive[q];
        const e = edges[bEdge[b]];
        const v = bV[b], s = bS[b], L = e.L, rem = L - s;
        const len = BIKE_LEN[bType[b]];
        let v0 = bVf[b];
        if (bNext[b] >= 0 && Math.abs(bNextA[b]) > 0.5) v0 = Math.min(v0, Math.sqrt(9 + 2 * 1.2 * Math.max(0, rem - 3)));
        let acc = 1.1 * (1 - Math.pow(v / v0, 4));
        if (p + 1 < nk && bLaneKey(ks[p + 1]) === bLaneKey(ks[p])) {
          const j = bAlive[ks[p + 1] % 1024];
          const gap = bS[j] - s - (BIKE_LEN[bType[j]] + len) * 0.5;
          const sStar = 1.1 + Math.max(0, v * 0.9 + (v * (v - bV[j])) / 3.0);
          acc -= 1.1 * (sStar / Math.max(gap, 0.05)) ** 2;
        }
        if (e.junction >= 0) {
          const stopAt = L - Math.max(1.2, (STOP_BACK[e.cls] || 6) - 1.2);
          const dStop = stopAt - s - len * 0.5;
          if (dStop > -0.5 && dStop < 60) {
            const st = signal(e, t);
            const rightTurn = bNext[b] >= 0 && bNextA[b] > 0.5;
            if (st !== 0 && !rightTurn && !(st === 1 && dStop < (v * v) / 5)) {
              const g = Math.max(dStop, 0.05);
              const sStar = 0.6 + v * 0.9 + (v * v) / 3.0;
              const a2 = 1.1 * (1 - (sStar / g) ** 2);
              if (a2 < acc) acc = a2;
            }
          }
        }
        if (acc < -5) acc = -5;
        bAcc[b] = acc;
        bV[b] = Math.max(0, v + acc * dt);
        if (bV[b] < 0.1) { bStuck[b] += dt; if (bStuck[b] > 60) bS[b] += 0.5; } else bStuck[b] = 0;
      }
      for (let q = nB - 1; q >= 0; q--) {
        const b = bAlive[q];
        let eid = bEdge[b], e = edges[eid];
        let s = bS[b] + bV[b] * dt;
        let dead = false;
        while (s >= e.L) {
          const nx = bNext[b];
          if (nx < 0 || !bActive[nx]) { dead = true; break; }
          s -= e.L;
          bPrev[b] = eid; bPrevLat[b] = bLat[b]; bPrevA[b] = bNextA[b];
          if (bCount[eid] > 0) bCount[eid]--;
          bCount[nx]++;
          eid = nx; e = edges[nx]; bEdge[b] = nx;
          bLat[b] = bikeLatOf(e) + bSlot[b] * 0.42;
          bikeChooseNext(b);
        }
        if (dead) { bikeDespawn(b); continue; }
        bS[b] = s;
        const inA = bNext[b] >= 0 && s > e.L - junctionR(bNextA[b], e.L);
        const inB = bPrev[b] >= 0 && s < junctionR(bPrevA[b], e.L);
        if (!inA && !inB) {
          const d = bikeLatOf(e) + bSlot[b] * 0.42 - bLat[b];
          const mx = 0.5 * dt;
          bLat[b] += d > mx ? mx : d < -mx ? -mx : d;
          if (bPrev[b] >= 0 && s > 25) bPrev[b] = -1;
        }
        bFl[b] = bAcc[b] < -0.8 || bV[b] < 0.3 ? 1 : 0;
      }
    }
    let bBalCursor = 0;
    function bikeBalance() {
      const n = bikeList.length;
      if (!n) return;
      const cnt = Math.min(n, 200);
      for (let q = 0; q < cnt; q++) {
        const id = bikeList[(bBalCursor + q) % n];
        const e = edges[id];
        const tg = bTarget[id], c = bCount[id];
        if (c < tg * 0.7 - 0.3 && e.L > 16 && nB < bikeCapNow) {
          const s = 4 + rnd() * (e.L - 8);
          edgePose(id, s, bikeLatOf(e), tmpPose, 0);
          if (hidden(tmpPose[0], tmpPose[1], tmpPose[2])) bikeSpawn(id, s, 4);
        } else if (c > tg * 1.6 + 1) {
          for (let k = 0; k < nB; k++) {
            const b = bAlive[k];
            if (bEdge[b] !== id) continue;
            const o = b * 6;
            if (hidden(bPose[o], bPose[o + 1], bPose[o + 2])) { bikeDespawn(b); break; }
          }
        }
      }
      bBalCursor = (bBalCursor + cnt) % Math.max(1, n);
    }
    function bikePose(b) {
      const eid = bEdge[b], e = edges[eid], s = bS[b], off = b * 6;
      const nx = bNext[b];
      if (nx >= 0) {
        const rA = junctionR(bNextA[b], e.L), rB = junctionR(bNextA[b], edges[nx].L);
        if (s > e.L - rA) { blendPose(eid, nx, bLat[b], bikeLatOf(edges[nx]) + bSlot[b] * 0.42, rA, rB, (s - (e.L - rA)) / (rA + rB), bPose, off); return; }
      }
      const pv = bPrev[b];
      if (pv >= 0) {
        const rA = junctionR(bPrevA[b], edges[pv].L), rB = junctionR(bPrevA[b], e.L);
        if (s < rB) { blendPose(pv, eid, bPrevLat[b], bLat[b], rA, rB, (rA + s) / (rA + rB), bPose, off); return; }
      }
      edgePose(eid, s, bLat[b], bPose, off);
    }
    const m16 = new Float32Array(16);
    function drawBikes(night) {
      const cp = camera.position;
      const maxD = BIKE_DRAW[level];
      const lightsOn = night > 0.02;
      for (let q = 0; q < nB; q++) {
        const b = bAlive[q];
        bikePose(b);
        const o = b * 6;
        const x = bPose[o], y = bPose[o + 1], z = bPose[o + 2];
        const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
        if (d > maxD || !inFrustum(x, y + 1, z, 2)) continue;
        let fx = bPose[o + 3], fy = bPose[o + 4], fz = bPose[o + 5];
        const fl = Math.hypot(fx, fy, fz) || 1;
        fx /= fl; fy /= fl; fz /= fl;
        const type = bType[b];
        const w = WB[type];
        if (w.full()) continue;
        const idx = w.put(x, y, z, fx, fy, fz);
        w.set4(0, idx, bCol[b * 3], bCol[b * 3 + 1], bCol[b * 3 + 2], bSec[b]);
        w.set4(1, idx, type, bFl[b], bOpt[b], 8);
        // 骑手：坐在座面上（实例矩阵 = 车辆朝向 × 身高缩放，原点下移到脚底）
        const look = bLook[b];
        const sc = look.height / 1.7;
        let lx = fz, lz = -fx;
        const ll = Math.hypot(lx, lz) || 1;
        lx /= ll; lz /= ll;
        const Ux = fy * lz, Uy = fz * lx - fx * lz, Uz = -fy * lx;
        const seat = SEAT[type];
        const up = seat[0] - SEAT_H * sc, fw = seat[1] + 0.03;
        m16[0] = lx * sc; m16[1] = 0; m16[2] = lz * sc; m16[3] = 0;
        m16[4] = Ux * sc; m16[5] = Uy * sc; m16[6] = Uz * sc; m16[7] = 0;
        m16[8] = fx * sc; m16[9] = fy * sc; m16[10] = fz * sc; m16[11] = 0;
        m16[12] = x + Ux * up + fx * fw; m16[13] = y + Uy * up + fy * fw; m16[14] = z + Uz * up + fz * fw; m16[15] = 1;
        const rw = d < RIDER_NEAR && !RN.full() ? RN : RF;
        if (!rw.full()) rw.putMatrix(m16, look, bPh[b], bV[b], type === BIKE.BICYCLE ? MODE.BICYCLE : MODE.SCOOTER);
        if (lightsOn && !W.light.full()) {
          const li = W.light.put(x, y, z, fx, fy, fz);
          W.light.set4(0, li, 0, type === BIKE.TRICYCLE ? 1.0 : 0.62, type === BIKE.TRICYCLE ? -1.36 : -0.9, type === BIKE.BICYCLE ? 0.9 : 0.8);
          W.light.set4(1, li, bFl[b] | 2 | 4, 0.3, 0, 0);
        }
      }
    }

    // ==================================================================
    // 路边停车（支路/小区路/三级路，静态，按 200 m 网格懒生成；离路口 11 m 内、桥隧、排除区不停）
    // ==================================================================
    const PARK_CELL = 200;
    const PARK_R = [350, 500, 650, 800];
    const PARK_NEAR = [70, 110, 150, 190];
    const parkFeatGrid = new Map();
    for (let fi = 0; fi < feats.length; fi++) {
      if (!parkPlans[fi]) continue;
      const p = feats[fi].p;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < p.length; k += 2) { x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); z0 = Math.min(z0, p[k + 1]); z1 = Math.max(z1, p[k + 1]); }
      for (let cx = Math.floor((x0 - 6) / PARK_CELL); cx <= Math.floor((x1 + 6) / PARK_CELL); cx++)
        for (let cz = Math.floor((z0 - 6) / PARK_CELL); cz <= Math.floor((z1 + 6) / PARK_CELL); cz++) {
          const k = cx * 100003 + cz;
          let a = parkFeatGrid.get(k);
          if (!a) parkFeatGrid.set(k, (a = []));
          a.push(fi);
        }
    }
    // 路口节点网格（两条以上不同道路交汇的节点）
    const JN_CELL = 40, jnGrid = new Map();
    for (const nd of G.nodes) {
      const fs = new Set();
      for (const id of nd.inE) fs.add(edges[id].f);
      for (const id of nd.outE) fs.add(edges[id].f);
      if (fs.size < 2) continue;
      const k = Math.floor(nd.x / JN_CELL) * 100003 + Math.floor(nd.z / JN_CELL);
      let a = jnGrid.get(k);
      if (!a) jnGrid.set(k, (a = []));
      a.push(nd.x, nd.z);
    }
    const nearJunction = (x, z, r) => {
      const gx = Math.floor(x / JN_CELL), gz = Math.floor(z / JN_CELL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          const a = jnGrid.get((gx + dx) * 100003 + gz + dz);
          if (a) for (let k = 0; k < a.length; k += 2) if (Math.hypot(a[k] - x, a[k + 1] - z) < r) return true;
        }
      return false;
    };
    const parkCells = new Map();
    const PSTRIDE = 12; // x y z fx fy fz r g b shape pack len
    function genParkCell(cx, cz) {
      const out = [];
      const list = parkFeatGrid.get(cx * 100003 + cz);
      const night = hoursNow < 7 || hoursNow > 20;
      if (list) for (const fi of list) {
        const f = feats[fi], pl = parkPlans[fi], p = f.p;
        const occ = Math.min(0.85, pl.occ * (night && f.c >= 5 ? 1.35 : 1));
        let acc = 0;
        for (let k = 2; k < p.length; k += 2) {
          const ax = p[k - 2], az = p[k - 1], bx = p[k], bz = p[k + 1];
          const sl = Math.hypot(bx - ax, bz - az);
          if (sl < 7) { acc += sl; continue; }
          const hx = (bx - ax) / sl, hz = (bz - az) / sl;
          const n = Math.floor((sl - 4) / 6.4);
          for (let q = 0; q < n; q++) {
            const t = 2 + 3.2 + q * 6.4;
            for (let sd = 0; sd < 2; sd++) {
              if (!pl.side[sd]) continue;
              const key = fi * 8191 + Math.round(acc + t) * 2 + sd;
              if (parkHash(key) > occ) continue;
              const lat = sd === 0 ? pl.lat : -pl.lat;
              const jit = (parkHash(key + 7) - 0.5) * 0.5;
              const x = ax + hx * (t + jit) - hz * lat, z = az + hz * (t + jit) + hx * lat;
              if (Math.floor(x / PARK_CELL) !== cx || Math.floor(z / PARK_CELL) !== cz) continue;
              if (nearJunction(x, z, 11)) continue;
              if (EX && (EX.test(x, z, 'roads') || EX.test(x + hx * 2.3, z + hz * 2.3, 'roads') || EX.test(x - hx * 2.3, z - hz * 2.3, 'roads'))) continue;
              if (terrain.inHole?.(x, z)) continue;
              const rev = parkHash(key + 3) < 0.08;
              const dir = (sd === 0) !== rev ? 1 : -1;
              const fxx = hx * dir, fzz = hz * dir;
              const y0 = terrain.heightAt(x, z) + LIFT;
              const yf = terrain.heightAt(x + fxx * 2.2, z + fzz * 2.2), yb = terrain.heightAt(x - fxx * 2.2, z - fzz * 2.2);
              const fy = (yf - yb) / 4.4;
              const h2 = parkHash(key + 11);
              const shape = h2 < 0.52 ? 0 : h2 < 0.88 ? 1 : 2;
              colTmp.setHex(pickCarColor(parkHash(key + 13)));
              const plate = parkHash(key + 17) < 0.3 ? 1 : 0;
              const pack = 8 + plate * 16 + ((parkHash(key + 19) * 12) | 0) * 64;
              out.push(x, y0, z, fxx, fy, fzz, colTmp.r, colTmp.g, colTmp.b, shape, pack, CAR_LEN[shape]);
            }
          }
          acc += sl;
        }
      }
      return Float32Array.from(out);
    }
    let parkCount = 0;
    function drawParked() {
      const cp = camera.position;
      const R = PARK_R[level], nearD = Math.min(PARK_NEAR[level], nearCar()), fineD = FINE_CAR[level];
      const agl = cp.y - terrain.heightAt(cp.x, cp.z);
      if (agl > 900) return;
      const c0x = Math.floor((cp.x - R) / PARK_CELL), c1x = Math.floor((cp.x + R) / PARK_CELL);
      const c0z = Math.floor((cp.z - R) / PARK_CELL), c1z = Math.floor((cp.z + R) / PARK_CELL);
      let budget = 3; // 每帧最多新生成 3 格，避免卡顿
      parkCount = 0;
      for (let cx = c0x; cx <= c1x; cx++)
        for (let cz = c0z; cz <= c1z; cz++) {
          const k = cx * 100003 + cz;
          if (!parkFeatGrid.has(k)) continue;
          let cell = parkCells.get(k);
          if (!cell) {
            if (budget <= 0) continue;
            budget--;
            cell = { cx, cz, a: genParkCell(cx, cz) };
            parkCells.set(k, cell);
          }
          const a = cell.a;
          for (let q = 0; q < a.length; q += PSTRIDE) {
            const x = a[q], y = a[q + 1], z = a[q + 2];
            const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
            if (d > R || !inFrustum(x, y + 0.8, z, 3)) continue;
            const w = d < fineD && !W.carFine.full() ? W.carFine : d < nearD ? W.car : W.far;
            if (w.full()) continue;
            const idx = w.put(x, y, z, a[q + 3], a[q + 4], a[q + 5]);
            w.set4(0, idx, a[q + 6], a[q + 7], a[q + 8], 1);
            w.set4(1, idx, VK.CAR, 16, a[q + 9], a[q + 10]);
            parkCount++;
          }
        }
      // 缓存过大时丢弃远处的格子
      if (parkCells.size > 600) {
        for (const [k, c] of parkCells) if (Math.hypot((c.cx + 0.5) * PARK_CELL - cp.x, (c.cz + 0.5) * PARK_CELL - cp.z) > R * 2) parkCells.delete(k);
      }
    }
    // 铰接公交后节：铰接点（车辆中心后 3.0 m）与后轴（后 7.3 m）沿路径取样，后节朝向随之折转
    const PJ = new Float32Array(6), PR = new Float32Array(6);
    function poseAt(i, ds, out) {
      let eid = vEdge[i], s = vS[i] + ds, lat = vLat[i];
      if (s < 0 && vPrev[i] >= 0) { eid = vPrev[i]; s += edges[eid].L; lat = vPrevLat[i]; }
      else if (s > edges[eid].L && vNext[i] >= 0) { s -= edges[eid].L; eid = vNext[i]; lat = laneOffset(edges[eid], vNextLane[i]); }
      edgePose(eid, Math.max(0, Math.min(edges[eid].L, s)), lat, out, 0);
    }

    // —— 绘制道路车辆 ——
    const nearCar = () => NEAR_CAR[level], nearHeavy = () => NEAR_HEAVY[level];
    function drawVehicles(night) {
      const cp = camera.position;
      const nc = nearCar(), nh = nearHeavy(), fineD = FINE_CAR[level];
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
        if (heavy) w = d < nh ? W.heavy : W.far;
        else w = d < fineD && !W.carFine.full() ? W.carFine : d < nc ? W.car : W.far;
        if (!w.full()) {
          const idx = w.put(x, y, z, fx, fy, fz);
          w.set4(0, idx, vCol[i * 3], vCol[i * 3 + 1], vCol[i * 3 + 2], vSec[i]);
          w.set4(1, idx, type, vFlags[i], vSuv[i], vPack[i]);
          if (type === VK.BUS_A && w === W.heavy && !w.full()) {
            poseAt(i, -3.0, PJ);
            poseAt(i, -7.3, PR);
            let gx = PJ[0] - PR[0], gy = PJ[1] - PR[1], gz = PJ[2] - PR[2];
            const gl = Math.hypot(gx, gy, gz);
            if (gl > 1) { gx /= gl; gy /= gl; gz /= gl; } else { gx = fx; gy = fy; gz = fz; }
            const j = w.put(x - fx * 3.0, y - fy * 3.0, z - fz * 3.0, gx, gy, gz);
            w.set4(0, j, vCol[i * 3], vCol[i * 3 + 1], vCol[i * 3 + 2], vSec[i]);
            w.set4(1, j, VK.BUS_R, vFlags[i], vSuv[i], vPack[i]);
          }
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
    // 图层开关：vehicles = 道路车辆，trains = 铁路/地铁列车，traffic = 两者（旧的总开关）。
    // 关闭的部分不仿真、不写实例（count=0 且隐藏），真正省掉 CPU 与绘制开销。
    let vehOn = true, trainOn = true;
    let enabled = true;
    const vehMeshes = [carFineMesh, carMesh, heavyMesh, farMesh, ...bikeMeshes, RN.mesh, RF.mesh];
    const trainMeshes = [trainNearMesh, trainFarMesh];
    const applyLayers = () => {
      enabled = vehOn || trainOn;
      root.visible = enabled;
      for (const m of vehMeshes) { m.visible = vehOn; if (!vehOn) m.count = 0; }
      for (const m of trainMeshes) { m.visible = trainOn; if (!trainOn) m.count = 0; }
      if (!enabled) lightMesh.count = 0;
    };
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
        if (vehOn) {
          if (first || refreshT <= 0) {
            refreshActive();
            refreshT = 0.4;
            first = false;
          }
          mark('refresh');
          // 大步长时分两次积分
          if (dt > 0.05) { simulate(dt * 0.5); simulate(dt * 0.5); } else simulate(dt);
          bikeSim(dt, simTime);
          mark('sim');
          balT -= dt;
          if (balT <= 0) { balance(); bikeBalance(); balT = 0.25; }
          mark('balance');
        }
        camera.updateMatrixWorld();
        projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projScreen, camera.coordinateSystem, camera.reversedDepth);
        const night = ctx.uniforms.uNight.value;
        for (const w of WL) w.reset();
        RN.reset(); RF.reset();
        tq = performance.now();
        if (vehOn) { drawVehicles(night); drawParked(); drawBikes(night); }
        mark('drawV');
        if (trainOn) drawTrains(simTime, night);
        mark('drawT');
        for (const w of WL) w.commit();
        RN.commit(); RF.commit();
        lightMesh.visible = night > 0.02;
        perfMs = perfMs * 0.95 + (performance.now() - t0) * 0.05;
        if (DEBUG_STATS && simTime > 1 && !statsShown) { statsShown = true; console.warn('[traffic] ' + JSON.stringify(inst.stats())); }
        const hgt = ctx.renderer.domElement.height || 1080;
        const fov = (camera.fov * Math.PI) / 180;
        pixelU.value = (2 * Math.tan(fov / 2)) / Math.max(1, hgt);
      },
      setLayer(name, on) {
        on = !!on;
        if (name === 'traffic') vehOn = trainOn = on;
        else if (name === 'vehicles') {
          if (on && !vehOn) refreshT = 0; // 重新打开：立即按当前视点刷新活动区
          vehOn = on;
        } else if (name === 'trains') trainOn = on;
        else return;
        applyLayers();
      },
      setQuality(q) {
        level = Math.max(0, Math.min(3, q.level ?? level));
        capNow = CAP_BY_LEVEL[level];
        bikeCapNow = BIKE_CAP[level];
        for (const m of shadowCasters) m.castShadow = shadowsOn();
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
      /** 调试：已生成的路边停车（前 n 辆，世界坐标） */
      debugParked(n = 20) {
        const out = [];
        for (const c of parkCells.values()) for (let q = 0; q < c.a.length && out.length < n; q += PSTRIDE) out.push([+c.a[q].toFixed(1), +c.a[q + 1].toFixed(1), +c.a[q + 2].toFixed(1)]);
        return out;
      },
      /** 调试：两轮车（位置、朝向、速度、车型） */
      debugBikes() {
        const out = [];
        for (let q = 0; q < nB; q++) {
          const b = bAlive[q], o = b * 6;
          bikePose(b);
          out.push({ x: bPose[o], y: bPose[o + 1], z: bPose[o + 2], fx: bPose[o + 3], fz: bPose[o + 5], v: bV[b], type: bType[b] });
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
        let bStop = 0;
        for (let q = 0; q < nB; q++) if (bV[bAlive[q]] < 0.3) bStop++;
        return { vehicles: nAlive, stopped, held, ghosts, bikesStopped: bStop, vAvg: +(vsum / Math.max(1, nAlive)).toFixed(2), ms: +perfMs.toFixed(2), activeEdges: activeList.length, bubbleR: bubble.R, near: W.car.n, heavy: W.heavy.n, far: W.far.n, lights: W.light.n, fine: W.carFine.n, parked: parkCount, parkFeat: nParkFeat, bikes: nB, bikesDrawn: W.bike0.n + W.bike1.n + W.bike2.n, riders: RN.n + RF.n, trainsNear: W.tNear.n, trainsFar: W.tFar.n, services: services.length };
      },
    };
    if (typeof window !== 'undefined') window.__traffic = inst;
    return inst;
  },
};
