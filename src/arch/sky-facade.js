// skyline：程序化玻璃幕墙材质（MeshPhysicalMaterial + onBeforeCompile）
// 每个墙面顶点带：
//   aUv  (u 沿周长米, v 离塔底米)
//   aFac (层高, 竖梃间距, 窗槛墙比例 0..1, 随机种子)
//   aSty (竖梃宽米, 夜间亮灯率, 模式, 设备层间隔层数)
//   aTint 玻璃底色（线性）  aSpd 窗槛墙/竖梃/石材颜色（线性）
// 模式 mode：0 普通幕墙  1 LED 媒体幕墙（绿地中心“丝路之门”）  2 楼层线灯  3 横向白色百叶（体育之窗）
//            4 塔冠玻璃（v 为塔冠内高度，aFac.x=塔冠高度，自下而上泛光渐隐）  5 LED 大屏  6 商业裙房（大玻璃、夜间通亮）
//            7 石材墙面+窗洞（行政中心、老式高层）  8 彩色渐变泛光  9 石材+暖色基座泛光
//            10 办公楼玻璃幕墙（白天同 0；夜间整层成片的冷白办公亮窗 + 玻璃反射城市天光的深蓝灰底亮，不再是死黑墙上的随机亮块）
// 竖梃/横梁/窗槛墙都由着色器按“米”生成，fwidth 抗锯齿，远处自动退化为平均色（不闪烁）。
import * as THREE from 'three';

const PARS_V = /* glsl */ `
attribute vec2 aUv;
attribute vec4 aFac;
attribute vec4 aSty;
attribute vec3 aTint;
attribute vec3 aSpd;
varying vec2 vFuv;
varying vec4 vFac;
varying vec4 vSty;
varying vec3 vTint;
varying vec3 vSpd;
varying vec3 vTanV;
`;

const PARS_F = /* glsl */ `
uniform float uTime;
uniform float uNight;
varying vec2 vFuv;
varying vec4 vFac;
varying vec4 vSty;
varying vec3 vTint;
varying vec3 vSpd;
varying vec3 vTanV;
float skH21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// 周期坐标 f∈[0,1) 上、以 0 为中心、宽 w（占比）的线条，带抗锯齿；太细时退化为平均覆盖率
float skLine(float f, float w, float fw) {
  float d = min(f, 1.0 - f);
  float a = 1.0 - smoothstep(w * 0.5 - fw, w * 0.5 + fw, d);
  return mix(a, clamp(w, 0.0, 1.0), smoothstep(0.22, 0.55, fw));
}
vec3 skHsv(vec3 c) { vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y); }
`;

const MAP_F = /* glsl */ `
  float skMode = floor(vSty.z + 0.5);
  float skCrown = skMode == 4.0 ? 1.0 : 0.0;
  float fH = skCrown > 0.5 ? 4.2 : max(vFac.x, 0.5);
  float cW = max(vFac.y, 0.3);
  float spR = skCrown > 0.5 ? 0.0 : vFac.z;
  float seed = vFac.w;
  vec2 q = vec2(vFuv.x / cW, vFuv.y / fH);
  vec2 fwq = max(fwidth(q), vec2(1e-4));
  // 单元格小于约 2~8 像素时，逐格随机（色差、卷帘、粗糙度、亮灯）淡出为平均值：
  // 原先 2 km 外每像素跨几个格子，哈希值逐像素跳变 → 整栋楼密布白色雪花噪点、转动时闪烁（审查 g6 p7_day / px5_day）
  float skCf = 1.0 - smoothstep(0.12, 0.45, max(fwq.x, fwq.y));
  vec2 cell = floor(q);
  vec2 fq = fract(q);
  float fl = cell.y, col = cell.x;
  // 设备层 / 避难层（整层百叶）
  float band = 0.0;
  if (vSty.w > 0.5 && skCrown < 0.5) band = step(vSty.w - 0.5, mod(fl + 1.0, vSty.w)) * step(3.0, fl);
  float mW = vSty.x / cW;
  float mull = skLine(fq.x, mW, fwq.x);
  float slab = skLine(fq.y, skMode == 3.0 ? 0.0 : 0.05, fwq.y);
  float spd = 0.0, tr2 = 0.0;
  if (spR > 0.001) {
    spd = 1.0 - smoothstep(spR - fwq.y, spR + fwq.y, fq.y);
    spd = mix(spd, spR, smoothstep(0.22, 0.55, fwq.y));
    tr2 = skLine(fract(fq.y - spR + 1.0), 0.035, fwq.y);
  }
  float frame = clamp(max(mull, max(slab, tr2)), 0.0, 1.0);
  float vision = (1.0 - frame) * (1.0 - spd);
  float ph = mix(0.5, skH21(cell + seed * 17.13), skCf);
  float ph2r = skH21(cell.yx * 1.37 + seed * 5.1);
  float ph2 = mix(0.5, ph2r, skCf);
  vec3 glassC = vTint * (0.94 + 0.12 * ph);
  // 反射玻璃提亮：深色底色混入一点天光灰蓝（原先高新 CBD、万象城塔楼远看是近黑的方柱，几乎不映天空）
  bool skStoneLike = skMode > 6.5 && !(skMode > 9.5 && skMode < 10.5); // 7/8/9 石材类（10 办公玻璃幕墙仍按玻璃）
  glassC = mix(glassC, vec3(0.36, 0.42, 0.50), skStoneLike || skMode == 6.0 ? 0.0 : 0.34);
  // 远处（窗格已小于几个像素）：反射玻璃整体映天，再往浅蓝灰提一档（2 km 外高新 CBD 仍读成深藏青色方柱，审查 g6 p7_day）
  glassC = mix(glassC, vec3(0.44, 0.52, 0.62), (skStoneLike || skMode == 6.0 || skMode == 5.0) ? 0.0 : 0.3 * (1.0 - skCf) * (1.0 - uNight));
  // 部分窗后有浅色卷帘/室内（白天可见的内部层次）；远处取其平均覆盖率
  float blind = mix(0.1, step(0.9, ph2r), skCf) * (skMode == 6.0 ? 0.0 : 1.0);
  glassC = mix(glassC, vec3(0.26, 0.26, 0.25), blind * 0.35);
  vec3 spdC = vSpd;
  // 10：办公楼玻璃幕墙（白天同 0；夜间按整层成片的办公亮窗 + 玻璃反射城市天光的底亮，见 EMIS_F）
  bool office = skMode > 9.5 && skMode < 10.5;
  bool stone = skMode > 6.5 && !office;
  vec3 mullC = stone ? vSpd * 0.92 : mix(vSpd, vec3(0.50, 0.52, 0.54), 0.6);
  vec3 louv = vec3(0.10, 0.11, 0.115) * (0.75 + 0.25 * step(0.5, fract(vFuv.y * 2.2)));
  float lv = band * (1.0 - frame);
  vec3 skBase = glassC * vision + spdC * spd * (1.0 - frame) + mullC * frame;
  skBase = mix(skBase, louv, lv);
  if (skMode == 3.0) { // 横向百叶：窗槛墙区即水平遮阳 / 横带（颜色取 spd：白色百叶、银灰横带各按规格；原先一律 0.78 白）
    // 夜里百叶只受城市天光，压暗到约 1/4（原先白天的白色横带在夜里仍是成片灰白横条，盖过窗灯，审查 g2 p7_night）
    vec3 louvC = min(vSpd * 1.08, vec3(0.8)) * (1.0 - 0.72 * uNight);
    skBase = mix(skBase, louvC, spd * (1.0 - mull));
  }
  if (skMode == 5.0) skBase = vec3(0.035, 0.04, 0.045) + mullC * mull * 0.3;
  diffuseColor.rgb = skBase;
  float skGlass = vision * (1.0 - lv);
`;

const ROUGH_F = /* glsl */ `
  roughnessFactor = mix(stone ? 0.82 : 0.38, 0.05 + 0.08 * ph + blind * 0.25, skGlass);
  roughnessFactor = mix(roughnessFactor, 0.55, lv);
  if (skMode == 5.0) roughnessFactor = 0.3;
  if (skMode == 3.0) roughnessFactor = mix(roughnessFactor, 0.55, spd * (1.0 - mull)); // 横带/百叶：哑光金属板
`;
const METAL_F = /* glsl */ `
  metalnessFactor = mix(stone ? 0.0 : (spd > 0.5 ? 0.45 : 0.85), 0.56 - blind * 0.36, skGlass);
  metalnessFactor = mix(metalnessFactor, 0.5, lv);
  if (skMode == 6.0) metalnessFactor *= 0.55;
  // 横带/百叶：低金属度，按规格色（银灰/白）显示，不再镜面映出暖色地面（金花豪生圆柱塔读成金白相间横条，审查 g3）
  if (skMode == 3.0) metalnessFactor = mix(metalnessFactor, 0.15, spd * (1.0 - mull));
`;
const NORMAL_F = /* glsl */ `
  {
    vec3 skT = normalize(vTanV);
    vec3 skB = normalize(cross(normal, skT));
    float fade = 1.0 - smoothstep(0.08, 0.35, max(fwq.x, fwq.y));
    // 单元板块的微小倾斜（“油罐效应”），让反射一格一格有变化
    normal = normalize(normal + (skT * (ph - 0.5) + skB * (ph2 - 0.5)) * 0.022 * skGlass * fade);
  }
`;
const EMIS_F = /* glsl */ `
  {
    float nt = uNight;
    vec3 em = vec3(0.0);
    float rid = floor(col / 3.0);
    float r1 = skH21(vec2(rid, fl) + seed * 7.31);
    float litR = vSty.y * 0.75;
    float floorAll = step(skH21(vec2(fl * 0.713, seed * 3.1)), litR * 0.2);
    float lit = max(step(r1, litR), floorAll) * (1.0 - band);
    vec3 lc = mix(vec3(1.0, 0.74, 0.46), vec3(0.86, 0.93, 1.0), step(0.42, skH21(vec2(fl * 0.37, seed + 0.5))));
    if (skMode == 6.0) lc = vec3(1.0, 0.80, 0.56);
    float inner = smoothstep(spR, 1.0, fq.y);
    float grad = 0.5 + 0.5 * inner;
    float k = (0.55 + 0.75 * skH21(vec2(rid * 1.7, fl * 2.3)));
    if (office) {
      // 办公楼：亮灯以“整层”为单位（加班的楼层整层亮），亮层里个别开间关灯，暗层里零星几间亮；
      // 冷白日光灯为主、亮度均匀；玻璃在夜里反射城市天光，暗处保留深蓝灰底色而不是死黑
      float floorOn = step(skH21(vec2(fl * 0.913, seed * 1.7)), vSty.y);
      float bay = skH21(vec2(floor(col / 2.0), fl) + seed * 3.9);
      lit = (floorOn > 0.5 ? step(0.12, bay) : step(0.93, bay)) * (1.0 - band);
      lit = mix(vSty.y * 0.82 + 0.06, lit, max(skCf, 1.0 - smoothstep(0.3, 1.2, fwq.y))); // 远处按整层平均（楼层仍可分辨时保留整层亮灯）
      lc = mix(vec3(0.88, 0.94, 1.0), vec3(1.0, 0.86, 0.66), step(0.8, skH21(vec2(fl * 0.29, seed + 2.5))));
      k = 0.85 + 0.25 * skH21(vec2(col * 0.37, fl * 1.9));
      em += lc * lit * vision * (0.6 + 0.4 * inner) * k * 0.24;
      em += vTint * (0.05 + 0.04 * ph) * vision * (1.0 - lit);
    } else if (skCrown < 0.5) {
      // 远处窗格小于几个像素时：先退到“整层 12 开间一组”的亮灯块（块仍有十几像素宽，不闪烁），楼层也分辨不出时才取平均并压暗；
      // 原先直接取平均亮度，所有窗都均匀发一层冷白光，夜里整栋楼成了灰白横条块（审查 g2 p7_night）
      float litB = step(skH21(vec2(floor(col / 12.0), fl) + seed * 2.7), litR) * (1.0 - band);
      float litFar = mix(litB, litR * 0.6, smoothstep(0.35, 0.9, fwq.y));
      em += lc * mix(litFar, lit, skCf) * vision * grad * k * (skMode == 6.0 ? 0.8 : 0.38);
    }
    if (skMode == 1.0) { // 绿地中心：竖梃/横梁 LED 线条动画
      float t = uTime;
      float wave = 0.5 + 0.5 * sin(vFuv.y * 0.05 - t * 1.1 + sin(vFuv.x * 0.045 + t * 0.35) * 1.6);
      float sweep = smoothstep(0.0, 0.15, fract(vFuv.y / 260.0 - t * 0.06)) * (1.0 - smoothstep(0.15, 0.3, fract(vFuv.y / 260.0 - t * 0.06)));
      vec3 c1 = skHsv(vec3(fract(0.55 + 0.1 * sin(t * 0.07) + vFuv.y * 0.0012), 0.7, 1.0));
      vec3 ledc = mix(vec3(1.0, 0.72, 0.32), c1, wave);
      float lines = max(mull, slab);
      // 亮度系数：lit < 0.2 时按 lit×5 压暗（单独挂在办公楼立面上的媒体带，不抢窗灯；绿地中心等 lit ≥ 0.3 不变）
      float mk = vSty.y < 0.2 ? max(vSty.y, 0.02) * 5.0 : 1.0;
      em += ledc * lines * (0.6 + 1.3 * wave + 3.0 * sweep) * mk;
    }
    if (skMode == 2.0 || skMode == 3.0) {
      em += vec3(0.85, 0.93, 1.0) * max(slab, skMode == 3.0 ? tr2 : 0.0) * (skMode == 3.0 ? 0.22 : 0.8) * (1.0 + 0.2 * sin(uTime * 0.6 + vFuv.y * 0.03));
    }
    // 横带楼：带窗内的亮灯偏暖、略提亮（夜景主要靠窗灯而不是白色横带）
    if (skMode == 3.0) em *= 1.0 + 0.35 * vision;
    if (skMode == 4.0) { // 塔冠：自下而上的泛光 + 竖梃亮线
      float ch = clamp(vFuv.y / max(vFac.x, 1.0), 0.0, 1.0);
      vec3 cc = vSpd;
      em += cc * (pow(1.0 - ch, 1.6) * 1.3 + 0.18) * (0.4 + 0.6 * (1.0 - vision));
      em += cc * mull * 2.2;
    }
    if (skMode == 5.0) { // LED 大屏：每 8 秒换一屏的“画面”（大色块构图 + 缓慢流动）+ 底部白字滚动字幕条
      // 原来是整屏同一色调、亮度 1.7×(0.9..1.4) 的色块，泛光后过曝成纯白矩形；现在亮度上限约 0.8、饱和度更高，有明暗构图
      vec2 q = vFuv;
      float slot = floor(uTime / 8.0 + seed * 0.37);
      float hA = skH21(vec2(slot, seed + 1.3)), hB = skH21(vec2(slot + 7.1, seed));
      vec2 p = q * vec2(0.035, 0.05);
      float s1 = sin(p.x * 3.0 + uTime * 0.5) + sin(p.y * 4.0 - uTime * 0.6) + sin((p.x + p.y) * 2.0 + uTime * 0.3);
      vec3 bg = skHsv(vec3(fract(hA + s1 * 0.05), 0.8, 0.55 + 0.15 * sin(s1)));
      // 画面主体：一块随画面变化位置的亮色椭圆（人物/产品图的近似）
      vec2 ctr = vec2(fract(hB * 3.7) * 30.0 + 4.0, 6.0 + hB * 5.0);
      float blob = 1.0 - smoothstep(3.5, 6.5, length((vec2(mod(q.x, 40.0), q.y) - ctr) * vec2(0.8, 1.0)));
      vec3 c = mix(bg, skHsv(vec3(fract(hA + 0.45), 0.55, 1.0)), blob * 0.85);
      // 字幕条（屏底 0.6~2.4 m）：深色底 + 向左滚动的白色“字块”
      float bar = step(0.6, q.y) * (1.0 - step(2.4, q.y));
      float gx = floor((q.x + uTime * 3.0) / 0.9);
      float glyph = step(0.45, skH21(vec2(gx, floor(q.y / 0.6) + slot))) * step(0.12, fract((q.x + uTime * 3.0) / 0.9)) * step(0.25, skH21(vec2(floor(gx / 7.0), slot)));
      c = mix(c, vec3(0.05) + vec3(0.95, 0.95, 0.9) * glyph, bar);
      em = c * 0.8 * (1.0 - mull * 0.6);
      nt = max(nt, 0.35); // 白天也亮（较弱）
    }
    if (skMode > 7.5 && !office) {
      if (skMode < 8.5) { // 8：彩色渐变泛光（电视塔塔身）
        // 底部投光灯自下而上渐隐 + 沿塔身上行的彩色光带（LED 线条），不做“整根发光管”
        float ch = clamp(vFuv.y / 150.0, 0.0, 1.0);
        vec3 c = skHsv(vec3(fract(0.58 + 0.1 * sin(uTime * 0.05) + ch * 0.22), 0.55, 1.0));
        float rise = pow(0.5 + 0.5 * sin(vFuv.y * 0.11 - uTime * 1.6), 6.0);
        float stripe = smoothstep(0.35, 0.0, abs(fract(vFuv.x / 2.2) - 0.5) - 0.12);
        em += c * (0.05 + 0.42 * pow(1.0 - ch, 2.2)) * (1.0 - vision * 0.5);
        em += c * rise * stripe * 0.9;
      } else { // 9：石材建筑暖色基座泛光
        float ch = clamp(vFuv.y / 36.0, 0.0, 1.0);
        em += vec3(1.0, 0.74, 0.46) * 0.55 * pow(1.0 - ch, 1.8) * (1.0 - vision);
      }
    }
    totalEmissiveRadiance = em * nt;
  }
`;

/** 创建共享幕墙材质（整个 skyline 模块共用一个，便于合批） */
export function createFacadeMaterial(ctx) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0.7,
    roughness: 0.1,
    envMapIntensity: 1.25,
    specularIntensity: 1,
    ior: 1.52,
  });
  m.name = 'skyFacade';
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = ctx.uniforms.uTime;
    s.uniforms.uNight = ctx.uniforms.uNight;
    s.vertexShader = PARS_V + s.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vFuv = aUv; vFac = aFac; vSty = aSty; vTint = aTint; vSpd = aSpd;
      vTanV = normalMatrix * normalize(vec3(-objectNormal.z, 0.0, objectNormal.x) + vec3(1e-4, 0.0, 0.0));`,
    );
    s.fragmentShader = PARS_F + s.fragmentShader
      .replace('#include <map_fragment>', MAP_F)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + ROUGH_F)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + METAL_F)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + NORMAL_F)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + EMIS_F);
  };
  m.customProgramCacheKey = () => 'skyFacade-v7';
  return m;
}

/** 常用立面风格（颜色为 sRGB 十六进制，内部转线性） */
const lin = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
export function style(o = {}) {
  // 种子折回 [0, 9.73)：着色器哈希 skH21(格号 + seed×17.13 …) 先乘 123/456 再取小数，seed 一大（档案建筑缺省种子按 7.3 递增到几千、
  // 通用塔楼 i×2.3）乘积超过 float32 精度，fract 退化成常数——整栋亮灯率失效（裙楼一整圈通亮白带）、亮窗成大块“二维码”
  const s0 = o.seed ?? Math.random() * 100;
  return {
    floorH: o.floorH ?? 4.2,
    colW: o.colW ?? 1.5,
    spandrel: o.spandrel ?? 0.28,
    seed: ((s0 % 9.73) + 9.73) % 9.73,
    mullW: o.mullW ?? 0.12,
    lit: o.lit ?? 0.35,
    mode: o.mode ?? 0,
    band: o.band ?? 0,
    tint: Array.isArray(o.tint) ? o.tint : lin(o.tint ?? '#34495a'),
    spd: Array.isArray(o.spd) ? o.spd : lin(o.spd ?? '#5b6670'),
  };
}
export const linColor = lin;
