// 通用建筑立面着色器：MeshStandardMaterial + onBeforeCompile
//
// 几何只有平面外墙 + 屋面；所有立面细节（窗洞凹进、窗框、阳台、空调机位、底商橱窗、招牌带、广告位、卷帘门、
// 彩钢瓦楞、砖缝/面砖缝、污渍）都由片元着色器按“开间 × 楼层”网格程序化生成：
//   · UV = (沿周长米数 u, 离地高度 v)，每栋建筑的种子/层高/首层高/女儿墙高/风格/主色/副色/玻璃色来自数据纹理
//   · 近景（hi）：u 为每条边自起点起算的米数 + 边长，开间在每条边内均分，避开转角；窗洞视差凹进（侧壁/窗台/过梁）
//     + 简化室内映射（后墙/天花/地面/侧墙，夜间顶灯），窗帘；远景（lo）：u 为全周长，无视差
//   · 抗锯齿：所有矩形/周期线用盒式滤波（按像素足迹解析积分）；开间尺度小于约 1 像素时淡化为“墙+窗面积加权平均”，
//     亮灯也换成期望值 → 远看不闪烁
//   · 夜景：按窗哈希与时段亮灯率（住宅/办公/商业三条曲线）亮灯，暖白/冷白/少量彩色；底商橱窗与招牌带发光
//   · 小区风貌（flags bit 6–13 = style 编号，参数纹理 uEst，见 bld-gen.js packEstateStyles / tools/build_estates.py）：
//     照片墙色/点缀色、饰面（涂料/面砖/砖纹/仿石）、基座与顶部变色、腰线、竖向构件（阳台两侧色带/楼梯间色带/通高壁柱/整开间色块）、
//     按户型周期排布的阳台/飘窗/窗/空调百叶、窗套、Art Deco 窗间墙；塔冠等屋面以上墙面不开窗；坡屋面画筒瓦/平瓦（flags bit 14）
//   · 近景附属构件（vPart，体块见 bld-gen.js facadeParts）：凸阳台/凸窗叠柱按层画楼板线、栏板、通长推拉窗（竖梃/亮子）、转角立框，
//     老楼部分户敞开晾晒、低层防盗笼；顶部构架、入口雨棚、底商雨棚按构件着色（雨棚底夜间被店铺灯照亮，入口有门灯）
//   · 通用楼：老式多层北向单元门 + 楼梯间半层窗（声控灯）；住宅按户成组亮灯；约 1/3 高层楼顶亮化（uBDetail ≥ 1）；
//     积灰屋面减弱间接高光（避免掠射角下整片泛天空蓝）
//   · 平屋面按类型（uBld2 第二张数据纹理，bld-gen.js ROOF）：上人屋面面砖、矿物面卷材、老沥青油毡（补丁/沥青糊补/银粉或绿色涂层）、
//     TPO/碎石 + 走道板 + 采光顶、彩钢板 + 采光带、水泥砂浆；楼主轴局部坐标、排水坡分水线、雨水口、天沟；女儿墙内侧泛水
//   · 窗洞进深自阴影（太阳方向反推，直射光 × bldSunK）、窗台板、勒脚、逐窗玻璃/窗帘差异、高层大堂门、铺面卷帘箱
//   · 近景细部（PART 8~14，bld-gen.js nearParts）：楼板挑檐、空调格栅、外挂空调、防盗窗与晾晒衣物（镂空）、勒脚凸台、晾衣杆
import * as THREE from 'three';
import { TEX_W, TEX2_W } from './bld-gen.js';

// 直射光乘以 bldSunK（立面着色器算的窗洞/阳台自阴影系数）；太阳阴影改走 bldShadowDir（见 SHADOW_PARS）
const SH_CALL = 'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';
const LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin
  .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= bldSunK;')
  .replace(SH_CALL, SH_CALL.replace('getShadow(', 'bldShadowDir(').replace(' )', ', bldShOff, bldShLift, bldShRad )'));
if (!LIGHTS_BEGIN.includes('bldShadowDir(')) console.warn('[buildings] three 的平行光阴影片段已变，女儿墙/墙顶阴影修正未生效');

// 太阳阴影的两处修正（审查 fe_西工大老小区 / fe_长安区小区 / st_shanbo / fe_浐灞小区：女儿墙与立面顶部一圈带锯齿噪点的深色毛边）：
//  · 外墙顶部受光面：阴影贴图一个纹素约 0.5 m，纹素里存的是女儿墙顶的深度，墙顶往下约 1 m 被当成“在阴影里”（锯齿暗边）。
//    同一栋楼的屋面挡不到自己的受光外墙，这一带改用同一面墙往下 2.4 m 处的阴影（邻楼的大片阴影照样保留）
//  · 女儿墙内侧与屋面边缘 2.5 m：女儿墙投在屋面上的窄条阴影只有两三个纹素宽，边缘台阶状——这里改用 3×3 帐篷核、半径 ×2.5 的柔和 PCF
const SHADOW_PARS = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
#if defined( SHADOWMAP_TYPE_PCF )
float bldShadowSoft(sampler2DShadow m, vec2 sz, float inten, float bias, float rad, vec4 c) {
  c.xyz /= c.w; c.z += bias;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  vec2 ts = vec2(rad) / sz;
  float s = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int k = -1; k <= 1; k++) {
      float wt = (j == 0 && k == 0) ? 0.25 : (j == 0 || k == 0) ? 0.125 : 0.0625;
      s += texture(m, vec3(c.xy + vec2(float(j), float(k)) * ts, c.z)) * wt;
    }
  }
  return mix(1.0, s, inten);
}
float bldShadowDir(sampler2DShadow m, vec2 sz, float inten, float bias, float rad, vec4 c, vec3 off, float lift, float radK) {
  float s0 = radK > 1.01 ? bldShadowSoft(m, sz, inten, bias, rad * radK, c) : getShadow(m, sz, inten, bias, rad, c);
  if (lift > 0.001) s0 = mix(s0, getShadow(m, sz, inten, bias, rad, vec4(c.xyz + off * c.w, c.w)), lift);
  return s0;
}
#else
float bldShadowDir(sampler2D m, vec2 sz, float inten, float bias, float rad, vec4 c, vec3 off, float lift, float radK) {
  return getShadow(m, sz, inten, bias, rad, c);
}
#endif
#endif
`;

const VERT_PARS = /* glsl */ `
#ifdef BLD_HI
  attribute vec4 aData;   // u(分米) 边长(分米) idLo idHi（idHi 高 8 位 = 附属构件类型 PART）
  attribute float aMeta;  // 0-7 外法线角 8-12 边序号 13 临街 14 女儿墙内侧
  flat varying float vPart;
#else
  attribute vec3 aData;   // u(分米) idLo idHi
#endif
uniform highp sampler2D uBld;
uniform highp sampler2D uBld2;  // 第二张数据纹理：每栋 2 texel（屋面主轴/类型、勒脚、小区种子，见 bld-gen.js tex2）
flat varying vec4 vR0;
flat varying vec4 vR1;
uniform float uDrawDist;
uniform vec4 uHiRect;   // 已由近景小块接管的 1 km 小块范围（含端点，小块坐标）；远景在其中的建筑塌缩
uniform highp sampler2D uCls;   // 分类高亮：每栋 1 texel（R8，类别编号），每行 1024 栋
flat varying float vCls;
varying vec3 vWPos;
varying vec3 vFac;
flat varying vec4 vB0;
flat varying vec4 vB1;
flat varying vec4 vB2;
flat varying vec4 vB3;
`;

const VERT_NORMAL = /* glsl */ `
#ifdef BLD_HI
  float bldAng = mod(aMeta, 256.0) * (6.28318530718 / 256.0);
  vec3 objectNormal = vec3(cos(bldAng), 0.0, sin(bldAng));
#else
  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
#endif
`;

const VERT_BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
#ifdef BLD_HI
  int bldHiW = int(aData.w + 0.5);
  int bldId = int(aData.z + 0.5) + (bldHiW & 255) * 65536;
  vPart = float(bldHiW >> 8);
  vFac = vec3(aData.x * 0.1, aData.y * 0.1, aMeta);
#else
  int bldId = int(aData.y + aData.z * 65536.0 + 0.5);
  vFac = vec3(aData.x * 0.1, 0.0, 0.0);
#endif
ivec2 bldT = ivec2((bldId & 1023) * 4, bldId >> 10);
vB0 = texelFetch(uBld, bldT, 0);
vB1 = texelFetch(uBld, bldT + ivec2(1, 0), 0);
vB2 = texelFetch(uBld, bldT + ivec2(2, 0), 0);
vB3 = texelFetch(uBld, bldT + ivec2(3, 0), 0);
vR0 = texelFetch(uBld2, ivec2((bldId & 1023) * 2, bldId >> 10), 0);
vR1 = texelFetch(uBld2, ivec2((bldId & 1023) * 2 + 1, bldId >> 10), 0);
vCls = texelFetch(uCls, ivec2(bldId & 1023, bldId >> 10), 0).r * 255.0;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
// 超出绘制距离的整栋建筑塌缩成退化三角形
if (distance(cameraPosition.xz, vB3.xy) - vB3.z > uDrawDist) transformed = vec3(0.0);
#ifndef BLD_HI
{
  vec2 bc = floor(vB3.xy / 1000.0);
  if (bc.x >= uHiRect.x && bc.x <= uHiRect.z && bc.y >= uHiRect.y && bc.y <= uHiRect.w) transformed = vec3(0.0);
}
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform highp sampler2D uEst;   // 小区风貌参数：每种 style 4 texel（见 bld-gen.js packEstateStyles）
uniform float uTime;
uniform float uNight;
uniform vec4 uLit;   // 亮灯率：x 住宅 y 办公 z 商业；w 夜间开灯系数
uniform float uClsOn;        // 分类高亮开关（0/1）
uniform vec4 uClsCol[12];    // 类别色（线性），a=1 选中高亮，a=0 灰化
uniform float uBDetail;      // 立面细节档位（画质：0 低 1 中 2 高/超高）：低档关闭楼顶亮化灯带等附加效果
flat varying float vCls;
#ifdef BLD_HI
  flat varying float vPart;
#endif
varying vec3 vWPos;
varying vec3 vFac;
flat varying vec4 vB0;
flat varying vec4 vB1;
flat varying vec4 vB2;
flat varying vec4 vB3;
flat varying vec4 vR0;   // 主轴角 屋面中心(s,t，相对锚点) 屋面类型
flat varying vec4 vR1;   // 半长 半宽 勒脚高 小区种子（0 = 不分组）

uint bHash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float bRand(int a, int b, int c) {
  uint h = bHash(uint(a) ^ bHash(uint(b + 1048576) * 0x9E3779B9u ^ bHash(uint(c) + 0x632BE5ABu)));
  return float(h >> 8) * (1.0 / 16777216.0);
}
float bNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = p - i; f = f * f * (3.0 - 2.0 * f);
  int ix = int(i.x) + 262144, iy = int(i.y) + 262144;
  float a = bRand(ix, iy, 71), b = bRand(ix + 1, iy, 71), c = bRand(ix, iy + 1, 71), d = bRand(ix + 1, iy + 1, 71);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// 盒式滤波：像素足迹 [x-w/2, x+w/2] 落在 [a,b] 内的比例
float bPulse(float a, float b, float x, float w) {
  return clamp((min(b, x + 0.5 * w) - max(a, x - 0.5 * w)) / w, 0.0, 1.0);
}
float bRect(vec4 r, vec2 p, vec2 w) { return bPulse(r.x, r.z, p.x, w.x) * bPulse(r.y, r.w, p.y, w.y); }
// 周期线（宽 d，周期 per，中心在 per 的整数倍）覆盖率
float bLines(float x, float per, float d, float w) {
  x += 0.5 * d;
  float a = x - 0.5 * w, b = x + 0.5 * w;
  float fa = floor(a / per), fb = floor(b / per);
  float ia = fa * d + min(a - fa * per, d);
  float ib = fb * d + min(b - fb * per, d);
  return clamp((ib - ia) / w, 0.0, 1.0);
}
// 带限版周期线：像素足迹接近周期时盒式滤波的残余起伏会形成摩尔纹（中远距离砖缝/瓦垄/分格缝），
// 足迹达到周期的 0.3~0.9 倍时淡化为覆盖率均值 d/per
float bLinesF(float x, float per, float d, float w) {
  return mix(bLines(x, per, d, w), d / per, smoothstep(0.3, 0.9, w / per));
}
vec3 bUnpack(float f) {
  float r = floor(f / 65536.0); float g = floor((f - r * 65536.0) / 256.0); float b = f - r * 65536.0 - g * 256.0;
  return pow(vec3(r, g, b) / 255.0, vec3(2.2));
}
vec3 bAwning(int ci) {    // 底商雨棚：蓝/绿阳光板、红/橙帆布、灰白彩钢（线性反照率）
  return ci == 0 ? vec3(0.1, 0.24, 0.42) : ci == 1 ? vec3(0.08, 0.26, 0.14) : ci == 2 ? vec3(0.42, 0.06, 0.05) : ci == 3 ? vec3(0.32, 0.33, 0.34)
       : ci == 4 ? vec3(0.6, 0.6, 0.58) : ci == 5 ? vec3(0.55, 0.22, 0.05) : ci == 6 ? vec3(0.06, 0.1, 0.3) : vec3(0.48, 0.53, 0.56);
}
vec3 bPalette(float r) {   // 招牌/广告主色
  return r < 0.22 ? vec3(0.62, 0.05, 0.04) : r < 0.4 ? vec3(0.03, 0.14, 0.45) : r < 0.55 ? vec3(0.75, 0.52, 0.06)
       : r < 0.68 ? vec3(0.05, 0.3, 0.12) : r < 0.82 ? vec3(0.8, 0.8, 0.78) : r < 0.92 ? vec3(0.35, 0.05, 0.3) : vec3(0.06, 0.06, 0.07);
}
// 线段笔画覆盖率（q、a、b 在字格单位；hw 半笔宽，fw 像素足迹）
float bStroke(vec2 q, vec2 a, vec2 b, float hw, float fw) {
  vec2 pa = q - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float d = length(pa - ba * h);
  return 1.0 - smoothstep(hw - fw, hw + fw, d);
}
// 伪汉字（店招 / 广告上的“字”）：字格 q ∈ [0,1]²（y 向上），按种子 s 取 2~4 道横、1~3 道竖、常带一撇一捺或口字框；
// 笔画全部盒式滤波，远看自然淡成覆盖率均值（不再是空白“字块”，审查 fs_含光路 / fs_长乐中路 / fs_唐延路 / fs_科技路）
float bGlyph(vec2 q, vec2 w, int s) {
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
  float sw = 0.11, c = 0.0;
  int nh = 0;
  for (int k = 0; k < 4; k++) {
    if (bRand(s, k, 101) < 0.6 || (k == 3 && nh == 0)) {
      float y = 0.08 + 0.84 * (float(k) + 0.2 + 0.6 * bRand(s, k, 102)) * 0.25;
      float a = 0.04 + 0.36 * bRand(s, k, 103), b = 0.6 + 0.36 * bRand(s, k, 104);
      c = max(c, bPulse(a, b, q.x, w.x) * bPulse(y - sw * 0.45, y + sw * 0.45, q.y, w.y));
      nh++;
    }
  }
  int nv = 0;
  for (int k = 0; k < 3; k++) {
    if (bRand(s, k, 105) < 0.5 || (k == 2 && nv == 0)) {
      float x = 0.12 + 0.76 * (float(k) + 0.15 + 0.7 * bRand(s, k, 106)) / 3.0;
      float a = 0.03 + 0.4 * bRand(s, k, 107), b = 0.55 + 0.42 * bRand(s, k, 108);
      c = max(c, bPulse(x - sw * 0.5, x + sw * 0.5, q.x, w.x) * bPulse(a, b, q.y, w.y));
      nv++;
    }
  }
  float fw = 0.5 * max(w.x, w.y);
  float rs = bRand(s, 9, 109);
  if (rs < 0.45) {   // 撇 + 捺
    c = max(c, bStroke(q, vec2(0.5, 0.62), vec2(0.08, 0.06), sw * 0.45, fw));
    if (bRand(s, 9, 110) < 0.7) c = max(c, bStroke(q, vec2(0.5, 0.5), vec2(0.93, 0.06), sw * 0.45, fw));
  } else if (rs < 0.62) {   // 口字框
    vec4 bx = vec4(0.2, 0.1 + 0.3 * bRand(s, 9, 111), 0.8, 0.0);
    bx.w = bx.y + 0.32;
    float o = bPulse(bx.x, bx.z, q.x, w.x) * bPulse(bx.y, bx.w, q.y, w.y);
    float i = bPulse(bx.x + sw * 0.9, bx.z - sw * 0.9, q.x, w.x) * bPulse(bx.y + sw * 0.9, bx.w - sw * 0.9, q.y, w.y);
    c = max(c, o - i);
  }
  return clamp(c, 0.0, 1.0);
}
// 一行伪汉字：x 为行内横坐标、y 为行内纵坐标（米），ch 字高（米），n 字数，s 种子；返回覆盖率
float bTextRow(float x, float y, float ch, float n, int s, vec2 fw) {
  float pitch = ch * 1.12;
  float tw = n * pitch - ch * 0.12;
  if (x < 0.0 || x > tw || y < 0.0 || y > ch) return 0.0;
  float ci = floor(x / pitch);
  vec2 q = vec2((x - ci * pitch) / ch, y / ch);
  return bGlyph(q, fw / ch, s * 31 + int(ci));
}

// 平屋面基色（线性反照率）：屋面类型见 bld-gen.js ROOF；同一小区（gs > 0）同一档
vec3 bRoofCol(int rType, float gs, int sd) {
  float r = gs > 0.0 ? fract(gs * 7.31) : bRand(sd, 5, 1);
  if (rType == 1) return r < 0.42 ? vec3(0.33, 0.325, 0.31) : r < 0.72 ? vec3(0.4, 0.395, 0.38) : r < 0.88 ? vec3(0.27, 0.15, 0.11) : vec3(0.36, 0.31, 0.25);   // 水泥砖灰 / 浅灰 / 红缸砖 / 米黄
  if (rType == 2) return r < 0.5 ? vec3(0.26, 0.26, 0.255) : r < 0.78 ? vec3(0.33, 0.335, 0.34) : r < 0.92 ? vec3(0.3, 0.285, 0.26) : vec3(0.1, 0.15, 0.12);  // 浅灰矿物面 / 银灰 / 暖灰 / 绿色（约 8%，审查 px3_day：成片薄荷绿）
  if (rType == 3) return r < 0.65 ? vec3(0.12, 0.117, 0.112) : vec3(0.14, 0.135, 0.125);   // 风化沥青油毡（深灰，不是纯黑）
  if (rType == 5) return r < 0.4 ? vec3(0.43, 0.43, 0.42) : r < 0.75 ? vec3(0.36, 0.365, 0.37) : vec3(0.28, 0.29, 0.3);   // 白 / 浅灰 / 灰 TPO（积灰后）
  if (rType == 6) return vec3(0.25, 0.245, 0.235);   // 碎石
  if (rType == 8) return vec3(0.22, 0.215, 0.205);   // 水泥砂浆
  return vec3(0.24, 0.235, 0.22);
}

// 4×4 Bayer 抖动阈值（镂空构件远处按覆盖率稀疏丢像素，不闪烁成一片）
float bDither() {
  ivec2 q = ivec2(gl_FragCoord.xy) & 3;
  int k = q.x + q.y * 4;
  int b = k == 0 ? 0 : k == 1 ? 8 : k == 2 ? 2 : k == 3 ? 10 : k == 4 ? 12 : k == 5 ? 4 : k == 6 ? 14 : k == 7 ? 6
        : k == 8 ? 3 : k == 9 ? 11 : k == 10 ? 1 : k == 11 ? 9 : k == 12 ? 15 : k == 13 ? 7 : k == 14 ? 13 : 5;
  return (float(b) + 0.5) / 16.0;
}

struct BSurf { vec3 alb; float rou; float met; vec3 nT; vec3 emi; float ao; };

#ifdef BLD_HI
// 简化室内映射：p 为玻璃面上的点（相对窗洞左下角，米），sz 窗洞尺寸，sill 窗台高，D 进深；rd 切线空间射线（z<0 向内）
vec3 bInterior(vec2 p, vec2 sz, float sill, float fH, float D, vec3 rd, float rnd, int kind, out float lampK) {
  float x0 = -0.9, x1 = sz.x + 0.9, y0 = -sill, y1 = fH - sill - 0.22;
  if (abs(rd.x) < 1e-4) rd.x = 1e-4;
  if (abs(rd.y) < 1e-4) rd.y = 1e-4;
  float tx = ((rd.x > 0.0 ? x1 : x0) - p.x) / rd.x;
  float ty = ((rd.y > 0.0 ? y1 : y0) - p.y) / rd.y;
  float tz = D / max(-rd.z, 1e-3);
  float t = min(tx, min(ty, tz));
  vec3 h = vec3(p, 0.0) + rd * t;
  vec3 wallC = mix(vec3(0.78, 0.72, 0.62), vec3(0.66, 0.7, 0.72), rnd);
  vec3 col;
  float depthK = clamp(-h.z / D, 0.0, 1.0);
  if (t == tz) {
    col = wallC;
    if (kind == 0) {
      // 家具剪影：沙发/柜子、挂画
      float fx = fract(h.x * 0.45 + rnd * 7.0);
      if (h.y < y0 + 0.55 + 0.35 * rnd && fx > 0.25) col *= 0.35;
      if (abs(h.y - (y0 + 1.6)) < 0.3 && abs(fract(h.x * 0.3 + rnd * 3.0) - 0.5) < 0.12) col = mix(col, vec3(0.25, 0.3, 0.35), 0.8);
    } else if (kind == 2) {
      // 商铺：浅色后墙 + 一组组货柜（层板 + 低饱和的货品色块，按 0.9 m 柜格随机有无），不再是整面红蓝白横条（像旗子）
      col = mix(vec3(0.84, 0.82, 0.78), vec3(0.76, 0.79, 0.8), rnd);
      float cell = floor(h.x / 0.9);
      float shelfOn = step(0.3, bRand(int(cell) + 4096, int(rnd * 997.0), 91)) * step(y0 + 0.1, h.y) * step(h.y, y1 - 0.45);
      float boards = bLines(h.y - y0, 0.42, 0.035, 0.01);
      float gn = bNoise(vec2(h.x * 5.0, h.y * 3.0 + rnd * 40.0));
      vec3 goods = mix(vec3(0.62, 0.56, 0.48), vec3(0.48, 0.52, 0.56), fract(rnd * 7.0 + cell * 0.37)) * (0.65 + 0.6 * gn);
      col = mix(col, mix(goods, vec3(0.34, 0.32, 0.3), boards), shelfOn * 0.85);
    } else {
      col = mix(wallC, vec3(0.5), 0.3);
      if (h.y < y0 + 0.8) col *= 0.6;   // 工位隔板
    }
  } else if (t == ty) {
    if (rd.y > 0.0) {
      col = vec3(0.86);
      if (kind == 1) col += vec3(0.55) * bLines(h.x, 1.2, 0.6, 0.02) * bLines(h.z, 1.8, 0.6, 0.02);   // 办公格栅灯盘
      if (kind == 2) col += vec3(0.9, 0.8, 0.6) * (1.0 - smoothstep(0.08, 0.16, length(vec2(fract(h.x / 1.5) - 0.5, fract(h.z / 1.5) - 0.5) * 1.5)));   // 商铺筒灯
    } else col = kind == 1 ? vec3(0.32, 0.33, 0.35) : kind == 2 ? mix(vec3(0.62, 0.6, 0.56), vec3(0.5, 0.48, 0.45), bLines(h.x, 0.8, 0.02, 0.01) + bLines(h.z, 0.8, 0.02, 0.01))
                          : mix(vec3(0.45, 0.32, 0.2), vec3(0.55, 0.53, 0.5), step(0.5, rnd));
  } else {
    col = wallC * 0.82;
    if (kind == 2) {
      // 商铺侧墙：货架层板 + 货品色块（斜看进店也看得到陈列，夜里不再是一块灰白平板，审查 fs_南大街_n）
      col = mix(vec3(0.82, 0.8, 0.76), vec3(0.74, 0.77, 0.78), rnd);
      float cell = floor(-h.z / 0.9);
      float on = step(0.25, bRand(int(cell) + 8192, int(rnd * 997.0), 92)) * step(y0 + 0.1, h.y) * step(h.y, y1 - 0.5);
      float gn = bNoise(vec2(h.z * 5.0, h.y * 3.0 + rnd * 30.0));
      vec3 goods = mix(vec3(0.66, 0.52, 0.4), vec3(0.42, 0.5, 0.6), fract(rnd * 5.0 + cell * 0.41)) * (0.6 + 0.7 * gn);
      col = mix(col, mix(goods, vec3(0.32, 0.3, 0.28), bLines(h.y - y0, 0.42, 0.035, 0.01)), on * 0.9);
    }
  }
  vec2 lampP = vec2((x0 + x1) * 0.5, -D * 0.5);
  float dl = length(vec2(h.x - lampP.x, h.z - lampP.y));
  lampK = (0.4 + 0.6 * exp(-dl * dl * 0.18)) * (1.0 - 0.3 * depthK);
  if (t == ty && rd.y > 0.0) lampK *= 1.3;
  return col;
}
#endif
`;

// 片元主体：插在 normal_fragment_begin 之后
const FRAG_MAIN = /* glsl */ `
vec3 bldEmis = vec3(0.0);
float bldAlpha = 1.0;  // 近景细部（镂空构件）的覆盖率，alpha-to-coverage 用
float bldSunK = 1.0;   // 直射光系数：窗洞/阳台进深的自阴影（见 LIGHTS_BEGIN）
float bldAO = 1.0;
float bldIndK = 0.8;   // 间接漫反射系数：核心同时有半球光与环境贴图，朝天的屋面会被“双重天光”染成青蓝色
float bldAOS = 1.0;
float bldSpecK = 1.0;  // 间接高光系数：积灰的平屋面掠射角下不应反出一片天空蓝
float bldShLift = 0.0;   // 太阳阴影改取参考点的比例（外墙顶部受光面，见 SHADOW_PARS）
vec3 bldShOff = vec3(0.0);   // 参考点在阴影贴图坐标里的偏移
float bldShRad = 1.0;    // 柔和 PCF 半径倍率（女儿墙内侧、屋面边缘）
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
vec3 bldScX = dFdx(vDirectionalShadowCoord[0].xyz), bldScY = dFdy(vDirectionalShadowCoord[0].xyz);
#endif
{
  float gA = vB0.x, H = vB0.y, fh = max(vB0.z, 0.5);
  int st = int(vB0.w + 0.5);
  vec3 wallC = vB1.rgb * 0.63;   // 色板为“印象色”，实际墙面反照率更低（涂料/面砖 0.3~0.55）
  int sd = int(vB1.a * 16777216.0);
  float gf = max(vB2.x, 0.5), ph = vB2.y;
  vec3 accC = bUnpack(vB2.z) * 0.8;
  int fl = int(vB2.w + 0.5);
  vec3 glassT = bUnpack(vB3.w);
  bool street = (fl & 1) != 0;
  int variant = (fl >> 1) & 7;
  bool oldB = (fl & 16) != 0;
  // —— 小区风貌（flags bit 6–13 = style 编号，bit 14 = 坡屋面；参数见 packEstateStyles） ——
  int esid = (fl >> 6) & 255;
  bool est = esid > 0;
  bool pitched = (fl & 16384) != 0;
  int eSch = 0, eFin = 0, eBal = 0, eVs = 0, eBase = 0, eCrown = 0, eBand = 0, eFl = 0, eP = 3;
  vec3 eTrim = vec3(0.7), eBaseC = vec3(0.4), eCrownC = vec3(0.4), eBandC = vec3(0.7), eFrame = vec3(0.3), eAcc2 = vec3(0.5);
  bool eFrameSet = false;
  vec3 roofTile = vec3(0.35, 0.15, 0.1);
  if (est) {
    vec4 E0 = texelFetch(uEst, ivec2(esid * 4, 0), 0);
    vec4 E1 = texelFetch(uEst, ivec2(esid * 4 + 1, 0), 0);
    vec4 E2 = texelFetch(uEst, ivec2(esid * 4 + 2, 0), 0);
    vec4 E3 = texelFetch(uEst, ivec2(esid * 4 + 3, 0), 0);
    eSch = int(E0.x + 0.5); eFin = int(E0.y + 0.5); eBal = int(E0.z + 0.5); eVs = int(E0.w + 0.5);
    eBase = int(E1.x + 0.5); eCrown = int(E1.y + 0.5); eBand = int(E1.z + 0.5); eFl = int(E1.w + 0.5);
    vec3 accRaw = bUnpack(vB2.z);
    eTrim = E2.x >= 0.0 ? bUnpack(E2.x) : accRaw;
    eBaseC = E2.y >= 0.0 ? bUnpack(E2.y) : accRaw;
    eCrownC = E2.z >= 0.0 ? bUnpack(E2.z) : accRaw;
    eBandC = E2.w >= 0.0 ? bUnpack(E2.w) : eTrim;
    eFrameSet = E3.x >= 0.0;
    eFrame = eFrameSet ? bUnpack(E3.x) * 0.85 : vec3(0.3);
    eAcc2 = E3.z >= 0.0 ? bUnpack(E3.z) : accRaw;
    eP = max(1, int(E3.w + 0.5));
    roofTile = glassT;              // 小区楼：数据纹理这一格存坡屋面颜色
    glassT = E3.y >= 0.0 ? bUnpack(E3.y) : vec3(0.043, 0.065, 0.07);
  }
  // 通用楼“平改坡”（无小区 style）：数据纹理这一格同样存坡屋面颜色，玻璃取住宅默认色
  if (pitched && !est) { roofTile = glassT; glassT = vec3(0.042, 0.068, 0.071); }
  bool estF = est && eSch > 0;      // 覆盖立面（风格 0 = 只改屋面）
  // 近景附属构件类型（bld-gen.js PART）：1/2 凸阳台正/侧面 3 底商雨棚 4 顶部构架 5 单元入口雨棚 6/7 凸窗正/侧面
  int bPart = 0;
#ifdef BLD_HI
  bPart = int(vPart + 0.5);
#endif
  // 楼顶亮化：只给少数高层写字楼/酒店/商业（约 3 成、≥ 60 m）——顶部 1.5 层泛光 + 女儿墙顶细轮廓灯带；
  // 普通住宅楼不亮化（审查 p5_night：住宅楼顶一圈很粗的金色轮廓线）
  bool crownLit = !estF && uBDetail > 0.5 && (st == 2 || st == 3 || st == 8 || st == 4) && H >= 60.0 && bRand(sd, 61, 3) < 0.32;
  float crR = bRand(sd, 62, 3);
  vec3 crownC = crR < 0.55 ? vec3(1.0, 0.74, 0.42) : crR < 0.88 ? vec3(0.82, 0.88, 1.0) : vec3(0.45, 0.62, 1.0);
  // 同一小区（住区分组 vR1.w > 0）同一涂料：楼与楼之间只有轻微的新旧差
  wallC *= (estF || vR1.w > 0.0) ? (0.95 + 0.1 * bRand(sd, 3, 1)) * (oldB ? 0.93 : 1.0) : (0.86 + 0.24 * bRand(sd, 3, 1)) * (oldB ? 0.9 : 1.0);   // 每栋明度差异 + 老楼积灰（同一小区同一涂料，差异小）
  eTrim *= 0.72; eBaseC *= 0.66; eCrownC *= 0.66; eBandC *= 0.72; eAcc2 *= 0.7;
  float u = vFac.x;
  float v = vWPos.y - gA;
  vec3 Nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 Vw = normalize(cameraPosition - vWPos);
  vec3 alb = wallC; float rou = 0.86; float met = 0.0; vec3 nT = vec3(0.0, 0.0, 1.0); float ao = 1.0;
  vec3 emi = vec3(0.0);
  float nightOn = uLit.w;
  // 临街铺面落卷帘的比例：随商业营业曲线（uLit.z，白天约 0.9~0.95）——营业时段约 1 成（空铺/装修/歇业），打烊后陆续落下
  float shutP = clamp(1.04 - uLit.z, 0.1, 0.92);
  int litCls =(st == 2 || st == 3 || st == 7) ? 1 : (st == 4 ? 2 : 0);
  float litP = (litCls == 0 ? uLit.x : litCls == 1 ? uLit.y : uLit.z) * (0.55 + 0.9 * bRand(sd, 9, 1));

  if (abs(Nw.y) < 0.6) {
    // ================= 外墙 =================
    vec3 Nh = normalize(vec3(Nw.x, 0.0, Nw.z));
    vec3 Tt = vec3(-Nh.z, 0.0, Nh.x);
    vec3 Vt = vec3(dot(Vw, Tt), Vw.y, dot(Vw, Nh));
    vec2 fwp = vec2(length(vec2(dFdx(u), dFdy(u))), length(vec2(dFdx(v), dFdy(v)))) + 1e-4;
    bool south = Nh.z > 0.4;
    float r0 = bRand(sd, 1, 0);
    // u 的走向：Tt 指向“从外面看的左手边”，u 沿 Tt 增大时招牌/广告的字要镜像回来（否则字从右往左、店标跑到右端）
    float uSgn = sign(dFdx(u) * dot(dFdx(vWPos), Tt) + dFdy(u) * dot(dFdy(vWPos), Tt));

    bool crownT = st == 0 && !estF && (variant & 2) != 0 && bRand(sd, 67, 3) < 0.6;
    // —— 风格参数 ——
    float bayW = 3.3, margin = 0.8, dep = 0.22;
    if (st == 0) { bayW = 3.1 + 0.6 * r0; margin = 0.9; dep = 0.25; }
    else if (st == 1) { bayW = 3.0 + 0.4 * r0; margin = 0.7; dep = 0.2; }
    else if (st == 2) { bayW = 1.5 + 0.3 * float(variant & 1); margin = 0.0; dep = 0.0; }
    else if (st == 3) { bayW = (variant & 1) == 0 ? 1.5 : 3.2 + 0.6 * r0; margin = 0.6; dep = 0.3; }
    else if (st == 4) { bayW = 6.0 + 2.0 * r0; margin = 0.4; dep = 0.1; }
    else if (st == 5) { bayW = 2.8 + 0.8 * r0; margin = 0.4; dep = 0.15; }
    else if (st == 6) { bayW = 6.0; margin = 0.0; dep = 0.08; }
    else if (st == 7) { bayW = 3.6 + 0.6 * r0; margin = 0.8; dep = 0.25; }
    else if (st == 8) { bayW = 3.9 + 0.3 * r0; margin = 0.9; dep = 0.3; }
    else if (st == 10) { bayW = 3.6 + 0.6 * r0; margin = 0.45; dep = 0.16; }
    else { bayW = 3.6; margin = 1.0; dep = 0.25; }
    if (estF) { bayW = (eSch == 5 ? 3.0 : 3.3) + 0.3 * r0; margin = 0.75; dep = eSch == 3 ? 0.32 : 0.25; }

    // —— 开间 ——
    float bw; int bi; float bx; bool inBay; int eIdx = 0; bool eStreet = street;
#ifdef BLD_HI
    float len = vFac.y;
    int meta = int(vFac.z + 0.5);
    eIdx = (meta >> 8) & 31;
    eStreet = (meta & 8192) != 0;
    float usable = len - 2.0 * margin;
    float nb = max(1.0, floor(usable / bayW + 0.4));
    bw = max(usable / nb, 0.5);
    float ul = u - margin;
    inBay = usable > 0.55 * bayW && ul > 0.0 && ul < usable;
    float bif = clamp(floor(ul / bw), 0.0, nb - 1.0);
    bi = int(bif); bx = ul - bif * bw;
#else
    bw = bayW;
    float bif = floor(u / bw);
    bi = int(bif); bx = u - bif * bw; inBay = true;
    eStreet = street;
#endif
    int kBay = bi + 997 * eIdx;
    float rb = bRand(sd, kBay, 11);
    // 住宅山墙（板楼短边）：实墙 + 少量小窗，不画阳台/封闭阳台（审查 st_res_street：同一栋楼长边是推拉窗 + 防盗网，
    // 短边却是一整条通高玻璃，像幕墙）。按边长与楼体外接半径判定（近景才有逐边边长）
    bool gable = false;
#ifdef BLD_HI
    gable = !estF && (st == 0 || st == 1) && vB3.z > 8.0 && len < 0.62 * vB3.z;
#endif

    // —— 楼层 ——
    float roofV = H - ph;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0 && NUM_DIR_LIGHTS > 0
    {
      // 外墙顶部受光面的阴影参考点（见 SHADOW_PARS）：同一面墙往下 2.4 m
      bool innerP = false;
#ifdef BLD_HI
      innerP = (int(vFac.z + 0.5) & 16384) != 0;
#endif
      vec3 Lw0 = (vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz;
      float sunFace = dot(Nh, normalize(vec3(Lw0.x, 0.0, Lw0.z) + 1e-5));
      if (innerP) bldShRad = 2.5;
      else if (bPart == 0 && H > 4.5 && v > H - 2.2 && Lw0.y > 0.03 && sunFace > 0.05) {
        float dux = dFdx(u), duy = dFdy(u), dvx = dFdx(v), dvy = dFdy(v);
        float det = dux * dvy - duy * dvx;
        if (abs(det) > 1e-9) {
          vec3 dcdv = (bldScX * -duy + bldScY * dux) / det;
          bldShOff = dcdv * ((H - 2.4) - v);
          bldShLift = smoothstep(H - 2.2, H - 1.7, v) * smoothstep(0.05, 0.2, sunFace);
        }
      }
    }
#endif
    int fi; float fy; float fH;
    if (v < gf) { fi = 0; fy = v; fH = gf; }
    else { float t = (v - gf) / fh; float tf = floor(t); fi = 1 + int(tf); fy = (t - tf) * fh; fH = fh; }
    float fTop = fi == 0 ? gf : gf + float(fi) * fh;
    bool winFloor = v > 0.0 && fTop < roofV + 0.2;
    int kWin = kBay * 131 + fi;

    // —— 墙面饰面（盒式滤波） ——
    float wn = bNoise(vec2(u * 0.3 + float(eIdx) * 17.0, v * 0.25));
    float wn2 = bNoise(vec2(u * 2.1, v * 1.7 + 50.0));
    alb *= 0.9 + 0.14 * wn + 0.06 * wn2;
    bool brick = estF ? eFin == 2 : (wallC.r > 1.6 * wallC.b && wallC.r < 0.45);
    bool tile = estF ? eFin == 1 : ((st == 1 || st == 5 || (st == 0 && oldB)) && wallC.g > 0.55 && !brick);
    bool stoneF = estF && eFin == 3;
    float jDet = 1.0 - smoothstep(0.008, 0.026, max(fwp.x, fwp.y));   // 逐砖色差、灰缝法线：砖高 6.3 cm，足迹超过约 2 cm 就淡出（否则 2~3 像素一行的随机色差闪烁成噪点）
    if (estF && brick) {
      // 小区砖墙：红砖面砖为浅灰勾缝，青砖为深灰勾缝（240×53 顺砖错缝）
      float row = floor(v / 0.063);
      float bu = u + mod(row, 2.0) * 0.125;
      float jh = bLinesF(v, 0.063, 0.01, fwp.y);
      float jv = bLinesF(bu, 0.25, 0.01, fwp.x) * (1.0 - jh);
      float bc = bRand(int(floor(bu / 0.25)) + 65536, int(row) + 65536, 5);
      alb *= mix(1.0, 0.86 + 0.28 * bc, jDet);
      bool redB = wallC.r > 1.3 * wallC.b;
      alb = mix(alb, redB ? vec3(0.42, 0.4, 0.37) : wallC * 0.62, (jh + jv) * 0.8 * (0.35 + 0.65 * jDet));
      nT.y += (jh * 2.0 - bLinesF(v - 0.012, 0.063, 0.01, fwp.y)) * 0.22 * jDet;
      rou = 0.9;
    } else if (st == 9 || brick || (st == 10 && dot(wallC, vec3(0.333)) < 0.2)) {
      // 砖：240×53 mm 顺砖错缝，10 mm 灰缝
      float row = floor(v / 0.063);
      float bu = u + mod(row, 2.0) * 0.125;
      float jh = bLinesF(v, 0.063, 0.011, fwp.y);
      float jv = bLinesF(bu, 0.25, 0.011, fwp.x) * (1.0 - jh);
      float bc = bRand(int(floor(bu / 0.25)) + 65536, int(row) + 65536, 5);
      alb *= mix(1.0, 0.82 + 0.36 * bc, jDet);
      alb = mix(alb, (st == 9 ? vec3(0.42, 0.41, 0.39) : vec3(0.5, 0.47, 0.43)), (jh + jv) * 0.85);
      nT.y += (jh * 2.0 - bLinesF(v - 0.012, 0.063, 0.011, fwp.y)) * 0.25 * jDet;
      rou = 0.92;
    } else if (tile) {
      // 外墙面砖 240×60
      float jh = bLinesF(v, 0.065, 0.006, fwp.y);
      float jv = bLinesF(u + mod(floor(v / 0.065), 2.0) * 0.12, 0.24, 0.006, fwp.x);
      alb = mix(alb, alb * 0.72, max(jh, jv) * 0.9);
      rou = 0.55;
    } else if (st == 3 || st == 8 || (st == 4 && (variant & 1) == 1) || stoneF) {
      // 石材幕墙 1.2×0.6 分格
      float jh = bLinesF(v, 0.6, 0.012, fwp.y);
      float jv = bLinesF(u, 1.2, 0.012, fwp.x);
      float pc = bRand(int(floor(u / 1.2)) + 65536, int(floor(v / 0.6)) + 65536, 9);
      alb *= mix(1.0, 0.94 + 0.12 * pc, jDet);
      alb = mix(alb, alb * 0.55, max(jh, jv) * 0.9);
      rou = 0.62;
    } else if (st == 6) {
      // 彩钢瓦楞板：竖向波纹，周期 0.25 m；1.2 m 砖砌勒脚
      float ph6 = u / 0.25 * 6.2831853;
      float rk = 1.0 - smoothstep(0.03, 0.08, fwp.x);
      nT.x += sin(ph6) * 0.55 * rk;
      alb *= 0.94 + 0.06 * cos(ph6) * rk;
      rou = 0.5; met = 0.35;
      if (v < 1.2) { alb = vec3(0.34, 0.31, 0.28) * (0.9 + 0.2 * wn); rou = 0.9; met = 0.0; nT = vec3(0.0, 0.0, 1.0); }
    } else if (st == 2) {
      rou = 0.35; met = 0.6;   // 幕墙框料（铝）
    } else {
      // 涂料抹灰墙：近看有细微的抹灰起伏（法线）与粗糙度斑驳，避免“塑料盒”质感
      float pk = 1.0 - smoothstep(0.02, 0.06, max(fwp.x, fwp.y));
      if (pk > 0.0) {
        nT.x += (bNoise(vec2(u * 3.1, v * 2.3 + 7.0)) - 0.5) * 0.1 * pk;
        nT.y += (bNoise(vec2(u * 2.7 + 3.0, v * 3.3)) - 0.5) * 0.1 * pk;
      }
      rou = 0.8 + 0.12 * wn2;
    }

    // —— 小区风貌：基座、顶部变色、腰线、竖向构件（阳台两侧色带 / 楼梯间色带 / 通高壁柱 / 整开间色块） ——
    int eK = bi % eP;
    bool eBalBay = false, eCore = false, ePil = false;
    if (estF) {
      eBalBay = south && eK == 0 && eBal > 0;
#ifdef BLD_HI
      eCore = eVs == 2 && abs(float(bi) - (nb - 1.0) * 0.5) < 0.6 && nb >= 3.0;
#endif
      float roofVe = H - ph;
      // 矮楼按比例减少基座/顶部层数（照片里的石材基座、深色顶部都是高层的做法）
      float nFl = floor((H - ph - gf) / fh + 0.5) + 1.0;
      int eBaseN = min(eBase, int(nFl / 8.0));
      int eCrownN = min(eCrown, int(nFl / 9.0));
      float baseTop = eBaseN > 0 ? gf + float(eBaseN - 1) * fh : -1.0;
      float crownV = roofVe - float(eCrownN) * fh;
      if (eVs == 4 && eK == 1 && fi > 0 && inBay) alb = mix(alb, accC * (0.95 + 0.1 * wn), 0.92);          // 整开间竖向色块
      if (eVs == 1 && eBalBay && fi > 0) {                                                                 // 阳台两侧色带
        float fs = max(bPulse(0.0, 0.42, bx, fwp.x), bPulse(bw - 0.42, bw, bx, fwp.x));
        vec3 fc = ((bi / eP) % 2 == 1) ? eAcc2 * 1.14 : accC;   // 两种点缀色时按阳台组交替（荣华EE康城 黄/蓝）
        alb = mix(alb, fc * (0.95 + 0.1 * wn), fs * 0.95);
      }
      if (eCore) alb = mix(alb, accC * (0.95 + 0.1 * wn), 0.95);                                          // 楼梯间色带
      if (eVs == 3 && inBay) {                                                                           // 通高壁柱（每两开间一根）
        float pw = eSch == 3 ? 0.3 : 0.22;
        float pl = (bi % 2 == 0) ? bPulse(0.0, pw, bx, fwp.x) : bPulse(bw - pw, bw, bx, fwp.x);
        vec3 pc = (eSch == 3 || eFin == 3) ? mix(alb, eTrim * 1.25, 0.45) * 1.08 : mix(alb, eTrim * 1.2, 0.8);
        alb = mix(alb, pc, pl);
        nT.x += ((bi % 2 == 0) ? 1.0 : -1.0) * pl * (1.0 - pl) * 1.2 * jDet;
        ePil = pl > 0.5;
      }
      if (fi > 0 && v < roofVe + 0.05 && eBand > 0 && ((fi % eBand) == 0 || eBand == 1)) {                // 腰线（楼板处）
        float bh = eBand == 1 ? 0.16 : 0.3;
        float bl = bPulse(0.0, bh, fy, fwp.y);
        alb = mix(alb, eBandC * (0.95 + 0.1 * wn), bl * 0.95);
        nT.y -= bPulse(0.0, 0.05, fy, fwp.y) * 0.6 * jDet;
      }
      if (v < baseTop) {                                                                                 // 石材基座（水平分缝）
        alb = eBaseC * (0.9 + 0.14 * wn);
        float rj = bLines(v, 0.6, 0.035, fwp.y);
        alb *= 1.0 - 0.3 * rj;
        nT.y += rj * 0.35 * jDet;
        rou = 0.7;
      }
      if (eCrownN > 0 && v > crownV && v < H + 0.05) alb = mix(alb, eCrownC * (0.93 + 0.12 * wn), 0.94);  // 顶部变色
    }
    // 塔楼：顶部“皇冠”、竖向色带、基座石材
    if (st == 0 && !estF) {
      int P = 3 + (variant % 3);
      // 顶部两层“皇冠”变色：约 3 成塔楼，且与墙色半混（原来一半塔楼顶部一整圈深棕，成片看像同一模型复制，审查 st_changan / fe_曲江小区）
      if (crownT && v > roofV - 2.0 * fh) alb = mix(alb, accC, 0.6) * (0.94 + 0.1 * wn);
      if ((variant & 4) != 0 && inBay && bi % P == 0 && fi > 0) alb = mix(alb, accC, 0.8);
      // 临街高层约一半做两层裙房基座（红色面砖 / 深灰石材 / 米色石材，按 1.2×0.6 分缝），其余只有首层变色
      float rPod = bRand(sd, 64, 3);
      bool pod2 = street && rPod < 0.5 && roofV > gf + 4.0 * fh;
      if (pod2 && v < gf + fh && bPart == 0) {
        float rq = bRand(sd, 65, 3);
        vec3 podC = rq < 0.35 ? vec3(0.3, 0.11, 0.07) : rq < 0.7 ? vec3(0.17, 0.165, 0.16) : vec3(0.44, 0.39, 0.32);
        alb = podC * (0.9 + 0.15 * wn);
        float jg = max(bLines(v, 0.6, 0.012, fwp.y), bLines(u, 1.2, 0.012, fwp.x));
        alb *= 1.0 - 0.35 * jg;
        rou = 0.6;
      } else if (v < gf && fi == 0) alb = mix(alb, accC * 0.9, 0.55);
#ifdef BLD_HI
      if (!inBay && (variant & 1) == 1) alb = mix(alb, accC, 0.6);   // 转角壁柱
#endif
    }
    // 仿古商业：每开间两侧赭红檐柱（转角留柱）、楼层间额枋（木色 + 一道青绿彩画）、檐下深色斗拱带
    float antCol = 0.0;
    if (st == 10) {
      float cw0 = 0.34;
#ifdef BLD_HI
      antCol = (ul < 0.0 || ul > usable) ? 1.0 : (inBay ? max(bPulse(-0.01, cw0, bx, fwp.x), bPulse(bw - cw0, bw + 0.01, bx, fwp.x)) : 0.0);
#else
      antCol = max(bPulse(-0.01, cw0, bx, fwp.x), bPulse(bw - cw0, bw + 0.01, bx, fwp.x));
#endif
      antCol *= step(0.45, v) * (1.0 - step(H - 0.7, v));
      alb = mix(alb, accC * (0.86 + 0.18 * wn), antCol);
      nT.x += (bx < bw * 0.5 ? 1.0 : -1.0) * antCol * (1.0 - antCol) * 1.4 * jDet;
      float beam = bPulse(fH - 0.42, fH + 0.01, fy, fwp.y) * float(fTop < roofV - 0.3) * float(v > 0.5);
      vec3 beamC = mix(accC * 0.78, vec3(0.07, 0.15, 0.13), bPulse(fH - 0.31, fH - 0.19, fy, fwp.y));
      alb = mix(alb, beamC, beam * 0.95);
      float eaveB = bPulse(H - 0.72, H + 0.05, v, fwp.y);
      float brk = bLinesF(u + 0.31, 0.62, 0.26, fwp.x) * bPulse(H - 0.58, H - 0.16, v, fwp.y);
      vec3 brkC = mix(vec3(0.3, 0.085, 0.05), vec3(0.06, 0.17, 0.15), step(0.5, fract(u / 1.24)));
      alb = mix(alb, mix(vec3(0.055, 0.04, 0.032), brkC, brk * 0.85), eaveB);
      ao *= 1.0 - 0.3 * eaveB;
      rou = mix(rou, 0.75, max(antCol, beam));
    }
    // 楼板线、勒脚、女儿墙压顶带
    if (st == 0 || st == 1 || st == 5 || st == 7 || st == 8) alb *= 1.0 - 0.07 * bPulse(0.0, 0.16, fy, fwp.y) * float(fi > 0);
    if (st == 1 && brick) alb = mix(alb, vec3(0.5, 0.49, 0.46) * (0.9 + 0.2 * wn), bPulse(fh - 0.42, fh, fy, fwp.y) * float(fi > 0 || gf > 2.0));   // 圈梁
    // 勒脚（台基）：多层水泥砂浆/深灰面砖，高层与公建花岗岩（同一小区同一做法），顶部一道浅色压边；工业厂房的砖勒脚见上
    float plH = vR1.z;
    if (st != 6 && plH > 0.05) {
      float plr = vR1.w > 0.0 ? fract(vR1.w * 3.7) : bRand(sd, 71, 1);
      vec3 plc = (st == 1 || st == 5) ? (plr < 0.5 ? vec3(0.19, 0.185, 0.18) : plr < 0.8 ? vec3(0.29, 0.28, 0.26) : vec3(0.27, 0.13, 0.09))
                                      : (plr < 0.4 ? vec3(0.15, 0.148, 0.145) : plr < 0.75 ? vec3(0.33, 0.31, 0.28) : vec3(0.23, 0.2, 0.18));
      float inP = 1.0 - bPulse(plH, plH + 100.0, v, fwp.y);
      float pj = (st == 1 || st == 5) && plr < 0.5 ? bLinesF(v, 0.25, 0.02, fwp.y) * 0.6
               : max(bLinesF(v - plH, plH * 0.5 + 0.001, 0.01, fwp.y), bLinesF(u, plr < 0.4 ? 0.6 : 0.9, 0.01, fwp.x) * step(v, plH));
      vec3 pAlb = plc * (0.88 + 0.22 * wn) * (1.0 - 0.35 * pj);
      alb = mix(alb, pAlb, inP);
      rou = mix(rou, 0.72, inP);
      float cap = bPulse(plH - 0.05, plH + 0.01, v, fwp.y);
      alb = mix(alb, plc * 1.5 + 0.04, cap * 0.85);
      nT.y += (cap - bPulse(plH + 0.01, plH + 0.05, v, fwp.y)) * 0.5;
      ao *= 1.0 - 0.18 * bPulse(-0.5, 0.15, v, fwp.y);   // 墙根接地的暗边（散水交接处的积灰与遮挡）
    }
    if (v > roofV - 0.05) { alb = mix(alb, estF ? (eSch == 2 || eSch == 4 ? eTrim : alb * 1.06) : (st == 0 && crownT ? mix(alb, accC, 0.6) : alb * 1.07), 0.7); }
#ifdef BLD_HI
    if (bPart == 0 && (int(vFac.z + 0.5) & 16384) != 0) {
      // 女儿墙内侧：抹灰（比外墙旧、脏），根部 0.3 m 是屋面防水层翻上来的泛水 + 压条
      alb = mix(wallC * 0.82, vec3(0.32, 0.31, 0.3), 0.35) * (0.86 + 0.24 * wn);
      vec3 rcF = bRoofCol(int(vR0.w + 0.5) & 15, vR1.w, sd);
      float fl = 1.0 - bPulse(roofV + 0.3, H + 1.0, v, fwp.y);
      alb = mix(alb, rcF * 0.92, fl);
      alb = mix(alb, vec3(0.3, 0.3, 0.29), bPulse(roofV + 0.27, roofV + 0.33, v, fwp.y));
      alb *= 1.0 - 0.1 * (1.0 - smoothstep(roofV, roofV + 0.4, v));
      rou = 0.88; met = 0.0;
    }
#endif
    // 小区楼屋面以上的附属墙面（塔冠 / 中部升起 / 檐口）：不开窗；Art Deco 竖向凹槽，新古典百叶/盲窗
    bool eTop = estF && v > H + 0.03;
    if (eTop) {
      float hv = v - H;
      if (eSch == 3) {
        alb = mix(wallC, eCrownC, 0.25) * (0.94 + 0.1 * wn);
        float gr = bLines(u, 0.9, 0.14, fwp.x);
        alb *= 1.0 - 0.3 * gr;
        nT.x += (bLines(u - 0.07, 0.9, 0.07, fwp.x) - bLines(u + 0.07, 0.9, 0.07, fwp.x)) * 0.5 * jDet;
      } else {
        alb = wallC * (0.95 + 0.1 * wn);
        float lv = bRect(vec4(0.5, 0.6, 1.9, 2.4), vec2(mod(u, 2.4), hv), fwp);
        alb = mix(alb, vec3(0.12, 0.11, 0.1), lv * 0.8 * bLines(hv, 0.12, 0.06, fwp.y));
        alb = mix(alb, eTrim, bPulse(0.0, 0.3, hv, fwp.y));
      }
    }
    // 污渍：底部溅污、女儿墙下水渍
    alb *= 1.0 - 0.18 * exp(-max(v, 0.0) / 1.3);
    // 女儿墙压顶下的雨水挂痕：只在压顶下约 1 m、竖向细条（原来 3.5 m 宽的整圈深色渐变带，像渲染错误，审查 fe_曲江小区 / fe_西工大老小区）
    float streakN = smoothstep(0.35, 0.85, bNoise(vec2(u * 2.3, 3.0)));
    alb *= 1.0 - (oldB ? 0.12 : 0.06) * smoothstep(1.1, 0.0, roofV - v) * step(v, roofV + 0.02) * streakN;

    // —— 远近过渡 ——
    float detail = 1.0 - smoothstep(0.3, 0.85, max(fwp.x / max(bw, 0.5), fwp.y / max(fH, 0.5)));
    float nearK = 1.0 - smoothstep(0.035, 0.1, max(fwp.x, fwp.y));
    // 住宅按“户”（两开间 × 一层）成组亮灯，比逐窗随机更像真实的万家灯火；其他按窗
    int kHouse = (litCls == 0 && (st == 0 || st == 1 || st == 5)) ? ((bi >> 1) + 997 * eIdx) * 131 + fi : kWin;
    // 老式多层北向单元入口（与 bld-gen.js facadeParts 的入口雨棚同一规则）：首层单元门，以上楼梯间半层窗
    bool entBay = false, lobby = false;
#ifdef BLD_HI
    entBay = st == 1 && !estF && !gable && Nh.z < -0.4 && !eStreet && nb >= 4.0 && (bi % 4) == 1 + (variant & 1) && bPart == 0
      && H >= 6.0 && gf >= 2.7 && (roofV - gf) / fh >= 1.6 && uBDetail > 0.5;
    // 高层住宅单元大堂入口（与 bld-gen.js facadeParts 的大堂雨棚同一规则）：北向非临街长边的中间开间，首层玻璃门 + 石材门套
    lobby = st == 0 && !estF && !gable && Nh.z < -0.4 && !eStreet && nb >= 3.0 && bi == int(floor(nb * 0.5)) && bPart == 0 && fi == 0
      && H >= 24.0 && gf >= 3.0 && vB3.z >= 8.0 && uBDetail > 0.5;
#endif

    // ===== 近景附属构件（体块由 bld-gen.js facadeParts 生成，这里画楼层内细节） =====
    bool partDone = bPart > 0;
    float wfO = -1.0;   // 远看时玻璃面积占比（附属构件自定）
    if (bPart == 1 || bPart == 2 || bPart == 6 || bPart == 7) {
      // —— 凸阳台（1 正面 2 侧面）/ 凸窗（6 正面 7 侧面）：楼板线 + 栏板/窗台 + 通长玻璃（竖梃）+ 转角立框；老楼有敞开晾晒户与低层防盗笼 ——
      bool pSide = bPart == 2 || bPart == 7, pBay = bPart >= 6;
      float fLen = vFac.y;
      float x0 = pSide ? 0.0 : (pBay ? 0.45 : 0.1), x1 = pSide ? fLen : bw - x0;
      // 侧面的 u 由几何写成 10×(开间号+1) + 面内距离（bld-gen.js obox 的 sideU）：整面恒定的开间号直接取整得到，
      // 户哈希与前脸 kHouse 同一公式（同一户前脸与两侧一起亮灭、窗帘同色）；不再由世界坐标反推（量化误差会把一面切成两半）
      float hb = floor((u + 0.5) / 10.0);
      float su = u - hb * 10.0;
      int bS = max(int(hb) - 1, 0);
      int kSide = (litCls == 0 && (st == 0 || st == 1 || st == 5)) ? ((bS >> 1) + 997 * eIdx) * 131 + fi : (bS + 997 * eIdx) * 131 + fi;
      float sx = pSide ? su : bx;
      int kS = pSide ? kSide : kHouse;
      float rP = bRand(sd, 81, 1), rh = bRand(sd, kS, 83);
      vec3 trimC = st == 0 ? mix(accC * 1.1, vec3(0.6), 0.35) : vec3(0.55, 0.54, 0.51);
      vec3 panelC = rP < 0.4 ? alb : rP < 0.7 ? mix(accC, alb, 0.25) * (0.95 + 0.1 * wn) : vec3(0.6, 0.6, 0.58) * (0.94 + 0.1 * wn);
      if (oldB && rP > 0.86) panelC = vec3(0.4, 0.17, 0.12) * (0.9 + 0.2 * wn);   // 红褐色栏板（老楼常见）
      bool glassRail = !pBay && st == 0 && !oldB && (variant & 2) != 0;         // 新高层：玻璃栏板
      bool openB = !pBay && oldB && rh < 0.14;                                   // 未封闭阳台
      bool cage = !pBay && oldB && fi <= 2 && rh > 0.55;                         // 低层防盗笼
      float railH = pBay ? 0.5 : 1.0, headH = pBay ? fH - 0.4 : fH - 0.12;
      bool topBand = v > roofV - 0.02;
      float mw = pBay ? 0.72 : (oldB ? 0.62 + 0.2 * rP : 0.95 + 0.3 * rP);
      vec3 pa = panelC; float pr = 0.85, pm = 0.0; vec3 pe = vec3(0.0); vec3 pn = vec3(0.0, 0.0, 1.0); float pao = 1.0;
      if (glassRail && fy < railH) {
        pa = glassT * 0.5 + 0.02; pr = 0.08; pm = 0.2;
        pa = mix(pa, vec3(0.2) * alb * 3.0, 0.3);
      }
      float gz = topBand ? 0.0 : bPulse(railH, headH, fy, fwp.y);
      bool litH = bRand(sd, kS, 29) < litP;
      float rc = bRand(sd, kS, 31);
      vec3 lampH = rc < 0.5 ? vec3(1.0, 0.74, 0.46) : rc < 0.75 ? vec3(1.0, 0.86, 0.68) : vec3(0.85, 0.91, 1.0);
      float lampIH = 0.85 * (0.6 + 0.7 * bRand(sd, kS, 33)) * nightOn;
      if (gz > 0.0) {
        float lx = sx - x0, ly = fy - railH, gh = headH - railH;
        float mull = max(bLines(lx, mw, 0.05, fwp.x), max(bPulse(-0.01, 0.06, ly, fwp.y), bPulse(gh - 0.06, gh + 0.01, ly, fwp.y)));
        if (!pBay && !openB) mull = max(mull, bPulse(gh * 0.62 - 0.03, gh * 0.62 + 0.03, ly, fwp.y));   // 推拉窗上亮子
        vec3 frC = oldB ? vec3(0.66, 0.66, 0.64) : (st == 0 && (variant & 1) == 1 ? vec3(0.7, 0.7, 0.68) : vec3(0.26, 0.27, 0.28));
        vec3 ga; float gr, gm; vec3 ge;
        if (openB) {
          // 敞开阳台：内墙 + 顶板阴影；晾晒衣物（随机色块）
          ga = wallC * 0.5 * (0.8 + 0.4 * smoothstep(0.0, gh, ly)); gr = 0.9; gm = 0.0;
          float cl = bPulse(gh - 0.9, gh - 0.25, ly, fwp.y) * step(0.45, bNoise(vec2(lx * 2.3, float(kS & 1023))));
          ga = mix(ga, bPalette(bRand(sd, kS, 85)) * 0.8 + 0.1, cl * 0.9);
          ge = litH ? lampH * lampIH * 0.12 : vec3(0.0);
          mull = bPulse(-0.01, 0.06, ly, fwp.y);
        } else {
          // 每扇推拉窗玻璃的色差 / 粗糙度略有不同（新旧、贴膜、开启扇）
          float pv = bRand(sd, kS * 13 + int(floor(lx / mw)), 87);
          ga = (glassT * 0.35 + 0.01) * (0.8 + 0.4 * pv); gr = (oldB ? 0.12 : 0.04) + 0.1 * pv; gm = 0.0;   // 老楼封阳台玻璃积灰，不再镜面反出一整条蓝天
          // 窗帘 / 室内：白天略透出室内暗色，夜间亮灯
          float cu = bRand(sd, kS, 35);
          vec3 inC = cu < 0.3 ? vec3(0.62, 0.58, 0.5) : cu < 0.45 ? vec3(0.66, 0.66, 0.64) : vec3(0.16, 0.15, 0.14);
          float cov = cu < 0.45 ? (1.0 - bPulse(0.25 * mw, 0.75 * mw, mod(lx, mw), fwp.x)) : 0.0;
          ga = mix(ga, inC * 0.12, 0.35 + 0.3 * cov);
          ge = litH ? lampH * lampIH * mix(0.5, 0.32, cov) * (0.85 + 0.3 * bNoise(vec2(lx * 1.7, ly * 2.0 + float(kS & 255)))) : vec3(0.0);
        }
        pa = mix(ga, frC, mull); pr = mix(gr, 0.45, mull); pm = mix(gm, 0.5, mull); pe = ge * (1.0 - mull);
        pao = 1.0 - 0.28 * bPulse(gh - 0.3, gh, ly, fwp.y);   // 楼板挑檐下的阴影
        if (cage) {
          float gb = max(bLines(lx, 0.12, 0.016, fwp.x), bLines(ly, 0.45, 0.025, fwp.y));
          pa = mix(pa, vec3(0.14, 0.11, 0.09), gb * 0.9); pr = mix(pr, 0.6, gb); pm = mix(pm, 0.35, gb); pe *= 1.0 - 0.85 * gb;
        }
        pa = mix(panelC, pa, gz); pr = mix(0.85, pr, gz); pm = mix(0.0, pm, gz); pe *= gz;
      }
      // 楼板线（每层压顶）与转角立框
      float slab = max(bPulse(-0.01, 0.16, fy, fwp.y), bPulse(fH - 0.02, fH + 0.01, fy, fwp.y));
      if (topBand) slab = 1.0;
      float edgeF = pBay ? 0.0 : max(bPulse(x0 - 1.0, x0 + 0.08, sx, fwp.x), bPulse(x1 - 0.08, x1 + 1.0, sx, fwp.x));
      float solid = max(slab, edgeF * gz);
      pa = mix(pa, trimC * (0.95 + 0.1 * wn), solid); pr = mix(pr, 0.8, solid); pm = mix(pm, 0.0, solid); pe *= 1.0 - solid;
      pn.y += (bPulse(0.13, 0.16, fy, fwp.y) - bPulse(-0.01, 0.02, fy, fwp.y)) * 0.6 * nearK;
      alb = pa; rou = pr; met = pm; emi = pe; nT = normalize(pn); ao = pao;
      wfO = pBay ? 0.3 : 0.42;
    } else if (bPart == 4) {
      // —— 高层顶部构架：清水混凝土 / 与塔冠同色的涂料 ——
      alb = (st == 0 ? mix(accC * 1.15, vec3(0.66), 0.4) : vec3(0.62, 0.62, 0.6)) * (0.92 + 0.14 * wn);
      rou = 0.8; met = 0.0; wfO = 0.0;
    } else if (bPart == 5) {
      // —— 单元入口雨棚（混凝土挑板）边沿 ——
      alb = vec3(0.56, 0.55, 0.52) * (0.9 + 0.2 * wn); rou = 0.85; wfO = 0.0;
    } else if (bPart == 3) {
      // —— 底商雨棚边沿（彩钢包边）——
      int ci = (int(vFac.z + 0.5) >> 8) & 7;
      alb = mix(bAwning(ci), vec3(0.5), 0.3); rou = 0.5; met = 0.3; wfO = 0.0;
      emi = vec3(1.0, 0.82, 0.6) * 0.15 * nightOn * step(0.25, uLit.z);
    } else if (bPart >= 8) {
      // ===== 近景细部（bld-gen.js nearParts，PART 8~14）：u = 面内归一化横坐标 ×10，vFac.y = 构件底部离地高 =====
      // 横向的周期纹样（铁栏、衣物）用沿墙的世界坐标（米），竖向用构件内高度 lv
      int nm = int(vFac.z + 0.5);
      int pid = (nm >> 8) & 63;
      bool pSide = (nm & 16384) != 0;
      float un = vFac.x * 0.1;
      float lv = v - vFac.y;
      float ut = dot(vWPos.xz, Tt.xz);
      float pr1 = bRand(sd, pid + 97 * bPart, 7);
      wfO = 0.0; nT = vec3(0.0, 0.0, 1.0); met = 0.0;
      if (bPart == 8) {
        // 楼板挑檐：涂料/清水混凝土，下沿一道滴水线的阴影
        alb = mix(wallC * 1.12, vec3(0.6, 0.6, 0.58), 0.45) * (0.92 + 0.12 * wn); rou = 0.85;
        alb *= 1.0 - 0.22 * bPulse(-0.01, 0.035, lv, fwp.y);
      } else if (bPart == 9) {
        // 空调格栅机位：铝合金横百叶（叶片间露出里面外机的暗影）+ 边框，底部 10 cm 混凝土空调板
        vec3 lc = estF ? mix(wallC * 1.15, vec3(0.66, 0.66, 0.64), 0.6) : (variant & 1) == 1 ? vec3(0.72, 0.72, 0.7) : mix(wallC * 1.2, vec3(0.64, 0.64, 0.62), 0.55);
        float gap = bLinesF(lv - 0.12, 0.085, 0.04, fwp.y);
        float fr = max(max(bPulse(-0.01, 0.035, un, fwp.x / 0.8), bPulse(0.965, 1.01, un, fwp.x / 0.8)), bPulse(0.1, 0.15, lv, fwp.y));
        vec3 inside = vec3(0.05, 0.05, 0.05) * (pSide ? 0.8 : 1.0);
        alb = mix(mix(lc * (0.94 + 0.08 * wn), inside, gap * 0.85), lc * 1.05, fr);
        nT.y += (gap - 0.5) * 0.5 * nearK * (1.0 - fr);
        rou = 0.55; met = 0.25 * (1.0 - gap);
        if (lv < 0.1) { alb = mix(wallC * 1.1, vec3(0.58, 0.58, 0.56), 0.5) * (0.9 + 0.15 * wn); rou = 0.85; met = 0.0; }
      } else if (bPart == 10) {
        // 外挂空调：米白机壳；正面左侧圆形风扇格栅（同心圈 + 十字），右侧侧板；侧面散热百叶
        vec3 cc = mix(vec3(0.72, 0.72, 0.69), vec3(0.6, 0.6, 0.57), pr1) * (oldB ? 0.88 : 1.0);
        alb = cc * (0.94 + 0.08 * wn); rou = 0.5;
        if (!pSide) {
          vec2 fq = vec2((un - 0.36) * 0.78, lv - 0.27);
          float rr = length(fq);
          float fan = 1.0 - smoothstep(0.19, 0.19 + fwp.x * 1.5, rr);
          float rings = bLinesF(rr, 0.03, 0.008, fwp.x) * fan;
          alb = mix(alb, vec3(0.1, 0.1, 0.105), fan * 0.85);
          alb = mix(alb, cc * 0.8, rings * 0.7);
          alb = mix(alb, cc * 0.75, bPulse(0.66, 0.68, un, fwp.x / 0.78));
          alb *= 1.0 - 0.2 * smoothstep(0.2, 0.0, lv) * (0.5 + 0.5 * bNoise(vec2(ut * 9.0, lv * 3.0)));   // 底部锈迹水渍
        } else {
          alb *= 1.0 - 0.3 * bLinesF(lv, 0.04, 0.015, fwp.y) * step(0.1, lv) * step(lv, 0.45);
        }
      } else if (bPart == 11) {
        if ((pid & 32) != 0) {
          // 防盗窗顶上的雨棚板前沿
          alb = (pr1 < 0.5 ? vec3(0.16, 0.32, 0.42) : pr1 < 0.75 ? vec3(0.42, 0.42, 0.4) : vec3(0.22, 0.12, 0.08)) * (0.9 + 0.15 * wn); rou = 0.6;
        } else {
          // 防盗窗：竖向铁栏（12 cm）+ 横档（40 cm）+ 外框；栏杆之间镂空（远处按覆盖率抖动镂空，像半透明的网）
          float bars = max(bLinesF(ut + float(pid) * 0.037, 0.12, 0.018, fwp.x), bLinesF(lv, 0.42, 0.025, fwp.y));
          float frm = max(max(bPulse(-0.01, 0.03, un, fwp.x / 1.6), bPulse(0.97, 1.01, un, fwp.x / 1.6)), bPulse(-0.01, 0.04, lv, fwp.y));
          float cov = max(bars, frm);
#ifdef BLD_NEAR
          bldAlpha = cov;   // 近景细部材质开 alpha-to-coverage：栏杆按像素覆盖率半透明（MSAA 样本级），远处像一层淡淡的网
#else
          if (cov < bDither()) discard;
#endif
          vec3 cg = pr1 < 0.45 ? vec3(0.13, 0.09, 0.07) : pr1 < 0.75 ? vec3(0.6, 0.6, 0.58) : vec3(0.42, 0.43, 0.44);
          alb = cg * (0.85 + 0.3 * bNoise(vec2(ut * 3.0, lv * 3.0))); rou = 0.55; met = pr1 > 0.75 ? 0.5 : 0.2;
        }
      } else if (bPart == 12) {
        // 晾晒的衣物：按 0.45 m 一格挂衬衫 / 裤子 / 毛巾床单（衣架挂在钢丝上），轮廓以外镂空
        float cw = 0.45;
        float gi = floor((ut + float(pid) * 0.13) / cw);
        float gx = (ut + float(pid) * 0.13) - gi * cw;
        float lt = 0.88 - lv;
        float gr = bRand(sd, int(gi) + 4096 + pid * 31, 77);
        float gk = bRand(sd, int(gi) + 4096 + pid * 31, 78);
        float shape = 0.0;
        if (gr < 0.12) shape = 0.0;   // 空位
        else if (gk < 0.45) {   // 衬衫/T 恤
          float len = 0.55 + 0.15 * gr;
          shape = max(bRect(vec4(0.07, 0.03, cw - 0.07, len), vec2(gx, lt), fwp), bRect(vec4(0.0, 0.03, cw, 0.2), vec2(gx, lt), fwp));
        } else if (gk < 0.75) {  // 裤子
          float len = 0.72 + 0.1 * gr;
          shape = max(bRect(vec4(0.08, 0.02, cw - 0.08, 0.14), vec2(gx, lt), fwp), max(bRect(vec4(0.08, 0.02, 0.21, len), vec2(gx, lt), fwp), bRect(vec4(cw - 0.21, 0.02, cw - 0.08, len), vec2(gx, lt), fwp)));
        } else {                 // 毛巾 / 床单
          shape = bRect(vec4(0.02, 0.0, cw - 0.02, 0.38 + 0.4 * gr), vec2(gx, lt), fwp);
        }
#ifdef BLD_NEAR
        bldAlpha = shape;
#else
        if (shape < bDither()) discard;
#endif
        float cr = bRand(sd, int(gi) + 4096 + pid * 31, 79);
        vec3 cl = cr < 0.25 ? vec3(0.75, 0.74, 0.7) : cr < 0.4 ? vec3(0.08, 0.1, 0.18) : cr < 0.52 ? vec3(0.5, 0.08, 0.07) : cr < 0.64 ? vec3(0.15, 0.3, 0.5)
                : cr < 0.74 ? vec3(0.6, 0.45, 0.15) : cr < 0.84 ? vec3(0.1, 0.1, 0.1) : cr < 0.92 ? vec3(0.55, 0.3, 0.4) : vec3(0.3, 0.42, 0.25);
        alb = cl * (0.85 + 0.25 * bNoise(vec2(ut * 6.0, lv * 4.0))); rou = 0.95;
        alb *= 1.0 - 0.25 * smoothstep(0.0, 0.25, lt) * (1.0 - smoothstep(0.0, 0.08, lt));
      } else if (bPart == 13) {
        // 勒脚凸台正面：沿用上面算好的勒脚色（v < 勒脚高）
        rou = 0.72;
      } else {
        // 晾衣杆 / 托架：镀锌钢管
        alb = vec3(0.45, 0.46, 0.46) * (0.85 + 0.2 * wn); rou = 0.45; met = 0.6;
      }
    }

    // 窗户之前的墙面（远景/掠射角平均用：不拿已经混叠的窗格像素去平均）
    vec3 albW = alb; float rouW = rou, metW = met;
    if (!partDone) {
    // —— 立面构件选择：主构件 et/wr，副构件 et2/wr2 ——
    // 1 凹窗 2 凹阳台 3 空调百叶 4 橱窗 5 幕墙玻璃 6 广告位 7 卷帘门 8 外挂空调 9 封闭阳台 10 层间窗槛墙 11 高侧窗 12 招牌带 13 单元门
    int et = 0, et2 = 0; vec4 wr = vec4(0.0), wr2 = vec4(0.0);
    float ey = fy, eyo = 0.0;
    bool grille = false;
    bool eBayWin = false;
    float cx = bw * 0.5;
    if (!inBay || (!winFloor && st != 6)) {
      et = 0;
    } else if (estF) {
      // —— 小区楼：按户型开间组合（周期 eP）排布：南向 阳台 / 卧室窗（飘窗）/ 厨卫窗 + 空调百叶；其他朝向 窗 + 百叶 / 小窗 / 窗 ——
      bool oldS = eSch == 5;
      if (fi == 0 && eStreet) {
        et = 4; wr = vec4(0.12, 0.25, bw - 0.12, gf - 1.1); et2 = 12; wr2 = vec4(-0.6, gf - 0.95, bw + 0.6, gf - 0.2);
      } else if (fi == 0) {
        et = 1; wr = vec4(cx - 0.75, 0.9, cx + 0.75, min(2.5, gf - 0.45));
      } else if (eCore) {
        et = 1; eyo = 0.5 * fH; wr = vec4(cx - 0.35, 1.0, cx + 0.35, 2.1);          // 楼梯间半层窗
      } else if (eBalBay) {
        if (eBal == 1) { et = 9; wr = vec4(0.14, 0.05, bw - 0.14, fH - 0.28); }       // 凸阳台（玻璃封闭，下部栏板）
        else { et = 2; wr = vec4(0.22, 0.0, bw - 0.22, fH - 0.32); }                  // 凹阳台 / 开敞阳台
      } else if (eK == 1 || (!south && eK == 2)) {
        if ((eFl & 2) != 0 && eK == 1) { et = 1; eBayWin = true; wr = vec4(0.4, 0.5, bw - 0.4, fH - 0.4); }   // 飘窗
        else if (eSch == 7 || eSch == 3) { et = 1; wr = vec4(cx - 0.7, 0.45, cx + 0.7, fH - 0.45); }         // 落地长窗
        else { et = 1; wr = vec4(cx - (oldS ? 0.75 : 0.85), 0.9, cx + (oldS ? 0.75 : 0.85), 2.45); }
      } else {
        et = 1; wr = vec4(cx - 0.6, 1.05, cx + 0.45, 2.4);                               // 厨卫窗 + 空调位
        if (oldS) { if (bRand(sd, kWin, 5) < 0.5) { et2 = 8; wr2 = vec4(cx + 0.58, 0.5, min(cx + 1.36, bw), 1.05); } }
        else { et2 = 3; wr2 = vec4(cx + 0.62, 0.18, min(cx + 1.38, bw - 0.08), 0.98); }
      }
      if (eSch == 3 && et == 1 && !eBayWin) { wr.y = max(0.45, wr.y - 0.35); wr.w = min(fH - 0.35, wr.w + 0.2); }  // Art Deco 竖向长窗
      grille = (eFl & 4) != 0 && et == 1 && (fi <= 2 || oldS && bRand(sd, kWin, 6) < 0.3);
    } else if (st == 0) {
      int P = 3 + (variant % 3);
      int k = bi % P;
      if (fi == 0) {
        if (lobby) { et = 4; wr = vec4(0.3, 0.0, bw - 0.3, min(2.85, gf - 0.5)); }
        else if (eStreet) { et = 4; wr = vec4(0.12, 0.25, bw - 0.12, gf - 1.1); et2 = 12; wr2 = vec4(-0.6, gf - 0.95, bw + 0.6, gf - 0.2); }
        else { et = 1; wr = vec4(cx - 0.9, 0.9, cx + 0.9, min(2.6, gf - 0.4)); }
      } else if (gable) {
        if (rb < 0.45) { et = 1; wr = vec4(cx - 0.45, 1.05, cx + 0.45, 2.25); et2 = 3; wr2 = vec4(cx + 0.6, 0.2, min(cx + 1.35, bw - 0.1), 0.95); }
        else if (rb < 0.75) { et = 1; wr = vec4(cx - 0.75, 0.9, cx + 0.75, 2.4); }
      } else if (k == 0 && P > 3) {
        et = 1; wr = vec4(cx - 0.35, 1.0, cx + 0.35, 2.2);
      } else if ((south && rb < 0.62) || rb < 0.16) {
        if ((variant & 1) == 0) { et = 2; wr = vec4(0.18, 0.0, bw - 0.18, fH - 0.3); }
        else { et = 9; wr = vec4(0.12, 0.05, bw - 0.12, fH - 0.28); }
      } else if (rb < 0.8) {
        et = 1;
        if (rb < 0.62) { wr = vec4(0.35, 0.85, bw - 1.2, 2.45); et2 = 3; wr2 = vec4(bw - 0.95, 0.15, bw - 0.18, 1.05); }
        else wr = vec4(0.45, 0.55, bw - 0.45, 2.5);
      } else {
        et = 1; wr = vec4(cx - 0.5, 1.1, cx + 0.5, 2.4);
        et2 = 3; wr2 = vec4(cx + 0.65, 0.2, min(cx + 1.4, bw - 0.1), 0.95);
      }
    } else if (st == 1) {
      if (fi == 0 && eStreet) {
        // 临街铺面：营业时段绝大多数开门（橱窗/玻璃门），打烊后才陆续落卷帘（审查 fs_含光路/fs_科技路：下午整排卷帘像歇业）
        et = bRand(sd, kBay, 76) < shutP ? 7 : 4; wr = vec4(0.2, 0.0, bw - 0.2, min(gf - 0.35, 2.9));
        if (gf > 3.3) { et2 = 12; wr2 = vec4(-0.6, gf - 0.3 - 0.6, bw + 0.6, gf - 0.2); wr.w = min(wr.w, wr2.y - 0.12); }
      } else if (entBay) {
        if (fi == 0) { et = 13; wr = vec4(cx - 0.62, 0.0, cx + 0.62, min(2.35, gf - 0.3)); }        // 单元门（上方有雨棚）
        else { et = 1; eyo = 0.5 * fH; wr = vec4(cx - 0.5, 0.95, cx + 0.5, 1.95); }                 // 楼梯间半层窗
      } else if (gable) {
        if (rb < 0.5) {
          et = 1; wr = vec4(cx - 0.45, 1.0, cx + 0.45, 2.1);
          if (bRand(sd, kWin, 5) < 0.3) { et2 = 8; wr2 = vec4(cx + 0.58, 0.5, min(cx + 1.36, bw), 1.05); }
        }
      } else if (rb < 0.13) {
        et = 1; eyo = 0.5 * fH; wr = vec4(cx - 0.5, 0.95, cx + 0.5, 1.95);   // 楼梯间半层错位窗
      } else if (south && rb < 0.55 && vB3.z >= 8.0) {   // 封闭阳台（小点式楼不做，与 bld-gen.js facadeParts 一致）
        et = 9; wr = vec4(0.12, 0.05, bw - 0.12, fH - 0.3);
      } else {
        et = 1; wr = vec4(cx - 0.75, 0.9, cx + 0.75, 2.4);
        if (bRand(sd, kWin, 5) < 0.4) { et2 = 8; wr2 = vec4(cx + 0.88, 0.5, min(cx + 1.66, bw), 1.05); }
      }
      grille = et == 1 && (fi <= 2 || bRand(sd, kWin, 6) < 0.18);
    } else if (st == 2) {
      if (fi == 0) { et = 4; wr = vec4(0.05, 0.3, bw - 0.05, gf - 0.5); }
      else { et = 5; wr = vec4(0.04, 0.9, bw - 0.04, fH - 0.06); et2 = 10; wr2 = vec4(0.04, 0.0, bw - 0.04, 0.9); }
    } else if (st == 3) {
      if (fi == 0) { et = 4; wr = vec4(0.15, 0.3, bw - 0.15, gf - 0.8); }
      else if ((variant & 1) == 0) {
        if (!((variant & 2) != 0 && bi % 4 == 3)) { et = 5; wr = vec4(0.04, 0.95, bw - 0.04, fH - 0.55); }
      } else { et = 1; wr = vec4(cx - 0.85, 0.9, cx + 0.85, fH - 0.55); }
    } else if (st == 4) {
      if (fi == 0) { et = 4; wr = vec4(0.1, 0.25, bw - 0.1, gf - 1.35); et2 = 12; wr2 = vec4(-0.6, gf - 1.2, bw + 0.6, gf - 0.2); }
      else {
        float rg = bRand(sd, bi / 2 + 997 * eIdx, 21);
        if (rg < 0.14 && roofV > gf + 4.0) {
          // 广告位跨两开间连成一幅（单独剩一开间时只占这一间）
          bool pairL = (bi % 2) == 0, solo = false;
#ifdef BLD_HI
          solo = pairL && bi + 1 >= int(nb);
#endif
          et = 6; ey = v; wr = vec4(pairL ? 0.35 : -0.6, gf + 0.7, pairL && !solo ? bw + 0.6 : bw - 0.35, roofV - 0.9);   // 两开间交界处外扩，免得盒式滤波在交界露出一道墙缝
        }
        else if (rg < 0.68) { et = 5; wr = vec4(0.08, 0.8, bw - 0.08, fH - 0.6); }
        else { et = 1; wr = vec4(cx - 1.1, 1.0, cx + 1.1, fH - 1.1); }
      }
    } else if (st == 5) {
      if (fi == 0 && (eStreet || rb < 0.45)) {
        // 临街的是小店（营业时段开门）；不临街的底层多为车库/库房（卷帘为主）
        et = (eStreet ? bRand(sd, kWin, 4) >= shutP : bRand(sd, kWin, 4) < 0.3) ? 4 : 7; wr = vec4(0.25, 0.0, bw - 0.25, min(3.0, gf - 0.3));
      } else if (rb > 0.9) {
        et = 0;
      } else {
        float off = (bRand(sd, kBay, 9) - 0.5) * 0.5;
        float ww = 0.5 + 0.35 * bRand(sd, kBay, 8);
        et = 1; wr = vec4(cx + off - ww, 1.0, cx + off + ww, 2.35);
        if (bRand(sd, kWin, 5) < 0.3) { et2 = 8; wr2 = vec4(cx + off + ww + 0.12, 0.5, min(cx + off + ww + 0.9, bw), 1.05); }
      }
      grille = et == 1 && (fi <= 1 || bRand(sd, kWin, 6) < 0.22);
    } else if (st == 6) {
      ey = v;
      if (v > roofV - 2.8 && v < roofV - 1.0 && roofV > 6.0) { et = 11; wr = vec4(0.0, roofV - 2.7, bw, roofV - 1.1); }
      else if (v < 5.2 && bi % 3 == 1 && rb < 0.6 && roofV > 6.5) { et = 7; wr = vec4(1.0, 0.0, bw - 1.0, min(4.8, roofV - 3.2)); }
    } else if (st == 7) {
      if (fi == 0 && rb < 0.18) { et = 4; wr = vec4(0.3, 0.2, bw - 0.3, gf - 0.6); }
      else { et = 1; wr = vec4(0.55, 0.9, bw - 0.55, fH - 0.85); }
    } else if (st == 8) {
      if (fi == 0) { et = 4; wr = vec4(0.2, 0.3, bw - 0.2, gf - 0.6); }
      else { et = 1; wr = vec4(cx - 0.8, 0.55, cx + 0.8, fH - 0.5); }
    } else if (st == 10) {
      // 仿古商业：首层整开间木格门面（上部格心 + 匾额），上层木格窗（约 1/8 开间为实墙）
      if (fi == 0) {
        float dh = min(gf - 0.66, 3.5);   // 单层殿/铺面（首层很高）门高封顶，门上留墙放匾额
        et = 14; wr = vec4(0.4, 0.0, bw - 0.4, dh);
        if (bRand(sd, kBay, 73) < 0.7) { et2 = 16; wr2 = vec4(cx - min(1.25, bw * 0.34), dh + 0.08, cx + min(1.25, bw * 0.34), dh + 0.54); }
      } else if (rb > 0.12) {
        et = 15; wr = vec4(0.72, 0.85, bw - 0.72, fH - 0.72);
      }
    } else {
      et = 1; wr = vec4(cx - 0.7, 1.0, cx + 0.7, min(fH - 0.6, 2.6));
    }
    // 底商门：约每 2~3 开间一樘落地玻璃门（门洞从地面起，中缝 + 拉手 + 亮子横档）（审查 st_sajinqiao：整栋楼没有门）
    bool shopDoor = et == 4 && fi == 0 && (lobby || bRand(sd, kBay, 75) < 0.38 || bi % 3 == 1);
    if (lobby) {
      // 大堂门套：浅色石材，门两侧各 0.3 m、门顶 0.5 m
      float pf = bRect(vec4(wr.x - 0.3, 0.0, wr.z + 0.3, wr.w + 0.5), vec2(bx, fy), fwp) * (1.0 - bRect(wr, vec2(bx, fy), fwp));
      vec3 pc = mix(vec3(0.52, 0.48, 0.42), wallC * 1.1, 0.3) * (0.92 + 0.12 * wn);
      alb = mix(alb, pc * (1.0 - 0.3 * bLinesF(fy, 0.6, 0.01, fwp.y)), pf);
    }
    if (shopDoor) wr.y = 0.0;
    if (eyo > 0.0) ey = mod(fy + eyo, fH);
    vec2 p = vec2(bx, ey);
    vec2 p2 = vec2(bx, fy);

    // 窗台板（通用住宅楼的普通窗）：窗洞下一条略宽的浅色窗台 + 下方阴影（近看给窗户“进深”）
    if (!estF && et == 1 && (st == 0 || st == 1 || st == 5) && fi > 0 && eyo == 0.0 && nearK > 0.0) {
      vec4 sr = vec4(wr.x - 0.07, wr.y - 0.07, wr.z + 0.07, wr.y + 0.005);
      float sl = bRect(sr, p, fwp) * nearK;
      vec3 slc = oldB ? vec3(0.4, 0.39, 0.37) : mix(wallC * 1.18, vec3(0.62, 0.62, 0.6), 0.45);
      alb = mix(alb, slc * (0.94 + 0.12 * wn), sl);
      nT.y += sl * 0.35;
      ao *= 1.0 - 0.32 * nearK * bRect(vec4(sr.x + 0.02, sr.y - 0.16, sr.z - 0.02, sr.y), p, fwp) * (1.0 - smoothstep(sr.y - 0.16, sr.y, p.y) * 0.5);
    }
    // 雨水污渍：窗台下方
    if (et == 1 && oldB) {
      float sx = bPulse(wr.x, wr.z, bx, fwp.x);
      alb *= 1.0 - 0.1 * sx * smoothstep(1.6, 0.0, wr.y - ey) * step(ey, wr.y) * bNoise(vec2(u * 4.0, 1.0));
    }

    // 窗户亮灯与灯色（住宅按户成组；办公按“楼层×工位组”）
    // 办公按“楼层 × 3 开间”成组亮（原来 5 开间一组，整层白色横带排成条形码，审查 p2_night）
    float lr = litCls == 1 ? bRand(sd, fi * 64 + bi / 3 + 997 * eIdx, 29) : bRand(sd, kHouse, 29);
    bool lit = lr < litP;
    // 楼梯间半层窗：声控灯，与住户作息无关、亮度低
    bool stairW = eyo > 0.0;
    if (stairW) lit = bRand(sd, kWin, 57) < 0.34;
    float rc = bRand(sd, litCls == 0 ? kHouse : kWin, 31);
    vec3 lampC;
    // 灯色：住宅以暖白（3000K）为主、冷白（LED 吸顶灯）为辅，不再有粉/紫彩灯（审查 p5_night：窗户紫橙蓝五颜六色像夜店）；
    // 办公以冷白为主；仿古商业暖黄
    // 色温 2700~4500 K：住宅暖白为主，办公中性白偏冷（不再是纯白块）
    if (litCls == 1) lampC = rc < 0.55 ? vec3(0.86, 0.9, 0.96) : rc < 0.85 ? vec3(1.0, 0.9, 0.76) : vec3(1.0, 0.8, 0.6);
    else lampC = rc < 0.5 ? vec3(1.0, 0.72, 0.44) : rc < 0.8 ? vec3(1.0, 0.82, 0.6) : vec3(0.92, 0.92, 0.9);
    if (st == 10) lampC = vec3(1.0, 0.74, 0.44);
    // 亮度参差（0.4~1.0 倍）：同一面墙的亮窗明暗不一，不再一片纯白
    float lampI = (litCls == 1 ? 0.46 : 0.7) * (0.4 + 0.6 * bRand(sd, kWin, 33)) * nightOn;
    if (stairW) { lampC = rc < 0.6 ? vec3(0.95, 0.88, 0.7) : vec3(0.85, 0.9, 1.0); lampI = 0.45 * nightOn; }
    float curtain = bRand(sd, kWin, 35);
    // 窗帘：米色 / 白 / 浅驼 / 浅灰（低饱和，亮灯后整体仍是暖白）
    // 窗帘颜色更丰富（米白/纯白/浅驼/浅灰为主，少量淡蓝、淡粉、豆绿、深红），整面墙的窗不再一个样
    float ccr = bRand(sd, kWin, 36);
    vec3 curtainC = curtain < 0.15 ? vec3(0.85, 0.8, 0.68) : curtain < 0.25 ? vec3(0.9, 0.9, 0.88) : curtain < 0.3 ? vec3(0.8, 0.72, 0.6) : vec3(0.78, 0.77, 0.74);
    if (ccr < 0.08) curtainC = vec3(0.62, 0.72, 0.8); else if (ccr < 0.14) curtainC = vec3(0.82, 0.66, 0.66); else if (ccr < 0.19) curtainC = vec3(0.66, 0.74, 0.6); else if (ccr < 0.23) curtainC = vec3(0.55, 0.2, 0.18);
    vec3 frameC = st == 2 ? wallC : (st == 9 ? vec3(0.28, 0.09, 0.06) : st == 10 ? accC * 0.85 : (oldB ? vec3(0.7, 0.7, 0.68) : (st == 0 && (variant & 1) == 1 ? vec3(0.85, 0.85, 0.83) : vec3(0.32, 0.33, 0.34))));
    if (estF) frameC = eFrameSet ? eFrame : (eSch == 5 ? vec3(0.66, 0.66, 0.64) : eSch == 7 ? vec3(0.8, 0.79, 0.76) : vec3(0.27, 0.27, 0.28));

    if (estF && et > 0 && winFloor) {
      if (eBayWin) {
        // 飘窗：凸出窗框（线脚色）+ 窗台下阴影
        vec4 wo = wr + vec4(-0.24, -0.2, 0.24, 0.14);
        float ring = bRect(wo, p, fwp) * (1.0 - bRect(wr, p, fwp));
        alb = mix(alb, mix(wallC, eTrim, 0.55) * (0.96 + 0.08 * wn), ring);
        ao *= 1.0 - 0.35 * bRect(vec4(wo.x, wo.y - 0.25, wo.z, wo.y), p, fwp);
      } else if ((eFl & 1) != 0 && (et == 1 || et == 9 || et == 2)) {
        // 窗套 + 窗台
        vec4 wo = wr + vec4(-0.16, -0.12, 0.16, 0.14);
        float ring = bRect(wo, p, fwp) * (1.0 - bRect(wr, p, fwp));
        alb = mix(alb, eTrim * (0.96 + 0.08 * wn), ring);
        float sill = bRect(vec4(wo.x - 0.06, wo.y - 0.06, wo.z + 0.06, wo.y + 0.05), p, fwp);
        alb = mix(alb, eTrim * 1.05, sill);
        ao *= 1.0 - 0.3 * bRect(vec4(wo.x, wo.y - 0.3, wo.z, wo.y - 0.06), p, fwp);
      }
      if (eSch == 3 && et == 1 && !eBayWin && fi > 0) {
        // Art Deco：上下窗之间的窗间墙用深色面板，形成竖向窗带
        float spd = bRect(vec4(wr.x, wr.w, wr.z, fH + 0.001), p, fwp) + bRect(vec4(wr.x, -0.001, wr.z, wr.y), p, fwp);
        alb = mix(alb, accC * (0.92 + 0.1 * wn), min(spd, 1.0) * 0.9);
      }
    }
    // ===== 主构件着色 =====
    float c1 = et > 0 ? bRect(wr, p, fwp) : 0.0;
    if (c1 > 0.0) {
      BSurf s; s.alb = alb; s.rou = rou; s.met = met; s.nT = vec3(0.0, 0.0, 1.0); s.emi = vec3(0.0); s.ao = 1.0;
      float sunW = 1.0;   // 本构件的直射光系数（窗洞进深自阴影）
      vec2 ws = wr.zw - wr.xy;
      bool glassy = et == 1 || et == 2 || et == 4 || et == 5 || et == 9 || et == 11 || et == 14 || et == 15;
      bool shopLike = et == 4 || et == 14;   // 14 仿古木格门面：按店铺橱窗处理室内与夜间灯光
      if (et == 3) {
        // 空调百叶（与主构件共用时作为主构件出现的情况很少）
        s.alb = mix(wallC * 1.2, vec3(0.64, 0.64, 0.62), 0.55);
      } else if (et == 6) {
        // 广告位（商场外墙大幅喷绘，两开间连成一幅）：饱和底色渐变 + 主图（人像头肩剪影或瓶罐商品，带光晕）+ 一行大字标题 + 一行小字 + 角标店标；
        // 横幅（宽高比 > 1.3）主图在一侧、标题占另一侧大半；竖幅主图在上、标题在下。夜间内透光。
        // 原来是两色噪声渐变 + 两条色块，像没加载出来的贴图（审查 fe_经开小区）
        int adk = bi / 2 + 997 * eIdx;
        float r1 = bRand(sd, adk, 41), r2 = bRand(sd, adk, 43), r3 = bRand(sd, adk, 44);
        bool adSolo = false;
#ifdef BLD_HI
        adSolo = (bi % 2) == 0 && bi + 1 >= int(nb);
#endif
        ws.x = adSolo ? bw - 0.7 : 2.0 * bw - 0.7;
        vec2 lm = vec2(bx - 0.35 + float(bi % 2) * bw, p.y - wr.y);   // 广告内坐标（米，两开间连续）
        if (uSgn > 0.0) lm.x = ws.x - lm.x;                              // 从外面看 u 向左增：镜像回来（字从左往右）
        vec2 lq = lm / ws;
        vec3 ca = r1 < 0.2 ? vec3(0.55, 0.04, 0.05) : r1 < 0.38 ? vec3(0.03, 0.12, 0.42) : r1 < 0.52 ? vec3(0.8, 0.5, 0.05)
                : r1 < 0.64 ? vec3(0.04, 0.28, 0.14) : r1 < 0.76 ? vec3(0.3, 0.05, 0.3) : r1 < 0.88 ? vec3(0.02, 0.03, 0.06) : vec3(0.0, 0.3, 0.42);
        vec3 cb = mix(ca, vec3(0.9, 0.86, 0.8), 0.35 + 0.3 * r2);
        bool land = ws.x > 1.3 * ws.y;
        vec3 ad = mix(ca, ca * 0.62, land ? lq.x : 1.0 - lq.y);
        // 主图
        vec2 pc = land ? vec2(min(ws.y * 0.55, ws.x * 0.2), ws.y * 0.5) : vec2(ws.x * (0.5 + (r3 - 0.5) * 0.3), ws.y * 0.68);
        float u0 = land ? ws.y * 0.9 : min(ws.x, ws.y * 0.55);
        float halo = 1.0 - smoothstep(0.0, 0.55 * u0, length(lm - pc));
        ad = mix(ad, cb, halo * 0.8);
        float sil;
        if (r3 < 0.55) {
          // 人像：头 + 肩
          float hd = 1.0 - smoothstep(0.15 * u0 - fwp.x, 0.15 * u0 + fwp.x, length((lm - pc - vec2(0.0, 0.1 * u0)) / vec2(1.0, 1.25)));
          float sh = 1.0 - smoothstep(0.32 * u0 - fwp.x, 0.32 * u0 + fwp.x, length((lm - pc + vec2(0.0, 0.4 * u0)) / vec2(1.0, 0.62)));
          sil = max(hd, sh * step(pc.y - 0.5 * u0, lm.y));
          vec3 skin = vec3(0.78, 0.6, 0.48);
          ad = mix(ad, mix(skin, mix(bPalette(r2), vec3(0.08), 0.5), step(lm.y, pc.y - 0.08 * u0)), sil);
        } else {
          // 商品：瓶罐（圆角矩形 + 瓶颈 + 白标签）
          vec2 dq = abs(lm - pc + vec2(0.0, 0.08 * u0)) - vec2(0.13 * u0, 0.28 * u0);
          float body = 1.0 - smoothstep(-fwp.x, fwp.x, length(max(dq, 0.0)) + min(max(dq.x, dq.y), 0.0) - 0.04 * u0);
          vec2 nq = abs(lm - pc - vec2(0.0, 0.27 * u0)) - vec2(0.05 * u0, 0.09 * u0);
          float neck = 1.0 - smoothstep(-fwp.x, fwp.x, max(nq.x, nq.y));
          sil = max(body, neck);
          ad = mix(ad, mix(bPalette(fract(r2 * 7.0)), vec3(0.9), 0.1), sil);
          ad = mix(ad, vec3(0.92), bRect(vec4(pc.x - 0.13 * u0, pc.y - 0.2 * u0, pc.x + 0.13 * u0, pc.y), lm, fwp) * 0.85);
        }
        // 标题（大字）+ 小字
        vec3 tcol = r2 < 0.65 ? vec3(0.96, 0.94, 0.9) : vec3(0.98, 0.82, 0.2);
        float tx0 = land ? pc.x + 0.6 * u0 : ws.x * 0.06;
        float tAvail = ws.x - tx0 - ws.x * 0.05;
        float tch = land ? min(ws.y * 0.34, tAvail / 2.3) : min(ws.y * 0.11, tAvail / 2.3);
        float tn = clamp(floor(tAvail / (tch * 1.12)), 1.0, 2.0 + floor(r2 * 4.0));
        float ttw = tn * tch * 1.12 - tch * 0.12;
        float tyL = land ? ws.y * 0.44 : ws.y * 0.16;
        float tg = bTextRow(lm.x - (tx0 + 0.5 * (tAvail - ttw)), lm.y - tyL, tch, tn, sd * 5 + adk, fwp);
        ad = mix(ad, tcol, tg);
        float sch = tch * 0.38;
        float sn = floor(tAvail * 0.85 / (sch * 1.12));
        float stw = sn * sch * 1.12 - sch * 0.12;
        float sg = bTextRow(lm.x - (tx0 + 0.5 * (tAvail - stw)), lm.y - (tyL - sch * 1.9), sch, sn, sd * 3 + adk, fwp);
        ad = mix(ad, mix(tcol, cb, 0.25), sg * 0.9);
        // 角标店标（右上）
        float lgs = min(ws.y * 0.16, 1.2);
        float lgb = bRect(vec4(ws.x - lgs * 1.6, ws.y - lgs * 1.4, ws.x - lgs * 0.6, ws.y - lgs * 0.4), lm, fwp);
        ad = mix(ad, vec3(0.94), lgb * 0.9);
        float fr = 1.0 - bRect(vec4(0.012, 0.01, 0.988, 0.99), lq, fwp / ws);
        s.alb = mix(ad, vec3(0.2), fr); s.rou = 0.4; s.met = 0.0;
        s.emi = ad * (1.0 - fr) * 0.8 * nightOn * step(0.25, uLit.z);
      } else if (et == 7) {
        // 卷帘门：横向肋；镀锌/铝合金板积灰发乌（审查 fs_科技路：原来亮白过曝、条纹反光很强），底部溅泥、中部手印磨亮
        float rib = sin(p.y / 0.09 * 6.2831853);
        float rk = 1.0 - smoothstep(0.015, 0.05, fwp.y);
        float sr = bRand(sd, kBay, 77);
        vec3 shC = sr < 0.7 ? vec3(0.4, 0.405, 0.41) : sr < 0.85 ? vec3(0.33, 0.35, 0.36) : vec3(0.42, 0.4, 0.36);
        s.alb = shC * (0.94 + 0.06 * rib * rk) * (0.85 + 0.2 * wn);
        s.alb *= 1.0 - 0.22 * smoothstep(0.6, 0.0, p.y - wr.y);
        s.nT = normalize(vec3(0.0, rib * 0.3 * rk, 1.0));
        s.rou = 0.62; s.met = 0.3;
        if (st == 6) s.alb *= vec3(0.9, 0.95, 1.05);
      } else if (et == 12) {
        s.alb = accC;
      } else if (et == 13) {
        // 单元门：钢制防盗对开门（深红/墨绿/深灰/深蓝）+ 门框 + 上方玻璃亮子（夜间门厅灯透出）
        vec2 lq = p - wr.xy;
        float dr = bRand(sd, kBay, 59);
        vec3 dc = dr < 0.3 ? vec3(0.22, 0.05, 0.04) : dr < 0.55 ? vec3(0.05, 0.14, 0.08) : dr < 0.8 ? vec3(0.18, 0.19, 0.2) : vec3(0.05, 0.09, 0.22);
        float fr = 1.0 - bRect(vec4(0.07, 0.0, ws.x - 0.07, ws.y - 0.07), lq, fwp);
        float split = bPulse(ws.x * 0.5 - 0.015, ws.x * 0.5 + 0.015, lq.x, fwp.x);
        float trans = bRect(vec4(0.14, ws.y - 0.5, ws.x - 0.14, ws.y - 0.14), lq, fwp);
        float panel = bLines(lq.y, 0.5, 0.03, fwp.y) * nearK;
        s.alb = mix(dc * (1.0 - 0.3 * panel), dc * 0.5, split);
        s.alb = mix(s.alb, glassT * 0.4 + 0.01, trans);
        s.alb = mix(s.alb, vec3(0.45, 0.45, 0.43), fr);
        s.rou = mix(0.4, 0.1, trans); s.met = mix(0.5, 0.0, trans);
        s.emi = vec3(1.0, 0.82, 0.58) * 0.5 * trans * nightOn;
        s.ao = 0.85;
      } else if (glassy) {
        // —— 窗洞视差凹进 ——
        float d = et == 2 ? 1.3 : (et == 9 || et == 5 || et == 11 ? 0.03 : dep);
        vec2 q = p;
        bool jamb = false; vec3 jn = vec3(0.0, 0.0, 1.0);
#ifdef BLD_HI
        if (nearK > 0.0 && d > 0.05) {
          vec2 off = -Vt.xy / max(Vt.z, 0.3) * d * nearK;
          vec2 g = p + off;
          if (g.x < wr.x) { jamb = true; jn = vec3(1.0, 0.0, 0.0); }
          else if (g.x > wr.z) { jamb = true; jn = vec3(-1.0, 0.0, 0.0); }
          else if (g.y < wr.y) { jamb = true; jn = vec3(0.0, 1.0, 0.0); }
          else if (g.y > wr.w) { jamb = true; jn = vec3(0.0, -1.0, 0.0); }
          q = g;
        }
#endif
        if (et == 9 && p.y < 0.95) {
          // 封闭阳台下部实心栏板（老式住宅常刷点缀色，如太白小区红褐色）；通用楼也有栏板——
          // 原来通高玻璃，小楼南面一两个开间看起来像一条玻璃幕墙（审查 st_res_street）
          vec3 sp = estF ? (eSch == 5 ? accC : mix(wallC * 1.05, eTrim, (eFl & 1) != 0 ? 0.6 : 0.0))
                         : (oldB ? mix(wallC, vec3(0.55, 0.54, 0.5), 0.3) : mix(wallC * 1.03, accC, 0.3));
          s.alb = sp * (0.95 + 0.1 * wn); s.rou = 0.85; s.met = 0.0;
          s.alb = mix(s.alb, s.alb * 0.7, bPulse(0.88, 0.95, p.y, fwp.y));
          s.ao = 1.0 - 0.25 * bPulse(0.0, 0.08, p.y, fwp.y);
        } else if (estF && et == 2 && p.y < 1.12 && eBal == 3) {
          // 小区：开敞阳台金属栏杆（竖向栏杆 + 扶手），栏杆之间看到阳台内侧
          vec2 lq0 = p - wr.xy;
          float rail = max(max(bLines(lq0.x, 0.13, 0.03, fwp.x), bPulse(1.02, 1.1, p.y, fwp.y)), bPulse(0.06, 0.12, p.y, fwp.y));
          vec3 behind = wallC * 0.55;
          s.alb = mix(behind, eSch == 7 && !eFrameSet ? vec3(0.8, 0.79, 0.76) : frameC, rail);
          s.rou = mix(0.9, 0.45, rail); s.met = mix(0.0, 0.5, rail);
          s.ao = mix(0.6, 1.0, rail);
          if (lit) s.emi = lampC * lampI * 0.08 * (1.0 - rail);
        } else if (et == 2 && p.y < 1.1) {
          // 阳台栏板：玻璃或实心
          bool glassRail = estF ? eBal == 4 : ((variant >> 1) & 1) == 0;
          s.alb = glassRail ? glassT * 0.5 + 0.02 : mix(wallC, accC, 0.5);
          s.rou = glassRail ? 0.08 : 0.8; s.met = 0.0;
          s.ao = 1.0 - 0.15 * bPulse(0.95, 1.1, p.y, fwp.y);
          s.alb = mix(s.alb, vec3(0.75), bPulse(1.02, 1.1, p.y, fwp.y));   // 扶手
          if (glassRail && lit) s.emi = lampC * lampI * 0.12;
        } else if (jamb) {
          s.alb = (et == 2 ? wallC * 0.95 : wallC * 0.88); s.rou = 0.9; s.met = 0.0; s.nT = jn; s.ao = 0.78;
        } else {
          vec2 lq = q - wr.xy;
#ifdef BLD_HI
#if NUM_DIR_LIGHTS > 0
          // 窗洞进深自阴影：玻璃（凹进 d 米）上的点沿太阳方向回到墙面，落在窗洞以外就是被过梁/侧墙挡住（阴影贴图分辨不出这么小的凹进）
          if (d > 0.05 && nearK > 0.0) {
            vec3 Lw = (vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz;
            vec3 Lt = vec3(dot(Lw, Tt), Lw.y, dot(Lw, Nh));
            if (Lt.z > 0.02) {
              vec2 gS = q + Lt.xy / Lt.z * d;
              sunW = mix(1.0, bRect(wr, gS, fwp * 1.5 + 0.03), nearK);
            }
          }
#endif
#endif
          // 框料：外框 + 中梃/横档
          float fwid = et == 5 ? 0.05 : (et == 4 ? 0.07 : et >= 14 ? 0.1 : 0.06);
          float inner = bRect(vec4(fwid, fwid, ws.x - fwid, ws.y - fwid), lq, fwp);
          float mull = 0.0;
          if (et == 1) {
            if (ws.x > 1.1) mull = max(mull, bPulse(ws.x * 0.5 - 0.03, ws.x * 0.5 + 0.03, lq.x, fwp.x));
            if (ws.y > 1.6) mull = max(mull, bPulse(ws.y * 0.72 - 0.03, ws.y * 0.72 + 0.03, lq.y, fwp.y));
          } else if (et == 4) {
            mull = max(bLines(lq.x, 2.0, 0.07, fwp.x), bPulse(ws.y - 0.9, ws.y - 0.83, lq.y, fwp.y));
            if (shopDoor) {
              // 对开玻璃门：中缝 + 门顶亮子横档 + 两根竖拉手
              float dc0 = ws.x * 0.5;
              mull = max(mull, bPulse(dc0 - 0.04, dc0 + 0.04, lq.x, fwp.x) * step(lq.y, 2.45));
              mull = max(mull, bPulse(2.4, 2.48, lq.y, fwp.y));
              mull = max(mull, (bPulse(dc0 - 0.2, dc0 - 0.15, lq.x, fwp.x) + bPulse(dc0 + 0.15, dc0 + 0.2, lq.x, fwp.x)) * bPulse(0.85, 1.4, lq.y, fwp.y));
              mull = max(mull, bPulse(-0.01, 0.1, lq.y, fwp.y));   // 门槛
            }
          } else if (et == 14) {
            // 仿古木格门：每 0.9 m 一扇（门梃），中部腰板横档，上部 0.62 以上为方格心
            float leaf = bLinesF(lq.x, 0.9, 0.08, fwp.x);
            float rail = bPulse(ws.y * 0.58, ws.y * 0.58 + 0.09, lq.y, fwp.y) + bPulse(-0.01, 0.18, lq.y, fwp.y);
            float latt = max(bLinesF(lq.x, 0.18, 0.024, fwp.x), bLinesF(lq.y, 0.18, 0.024, fwp.y)) * step(ws.y * 0.62, lq.y);
            mull = max(max(leaf, min(rail, 1.0)), latt * 0.9);
          } else if (et == 15) {
            // 仿古木格窗：双扇（中梃）+ 方格心
            float latt = max(bLinesF(lq.x, 0.17, 0.022, fwp.x), bLinesF(lq.y, 0.17, 0.022, fwp.y));
            mull = max(bPulse(ws.x * 0.5 - 0.04, ws.x * 0.5 + 0.04, lq.x, fwp.x), latt * 0.85);
          } else if (et == 9) {
            mull = max(bLines(lq.x, 0.62, 0.05, fwp.x), bPulse(0.9, 0.96, lq.y, fwp.y));
          } else if (et == 2) {
            mull = max(bLines(lq.x, 0.9, 0.05, fwp.x), bPulse(ws.y - 0.5, ws.y - 0.45, lq.y, fwp.y));
          } else if (et == 11) {
            mull = bLines(lq.x, 1.5, 0.08, fwp.x);
          }
          float frameM = max(1.0 - inner, mull);
          // 临街铺面：橱窗顶上一道卷帘门箱（深灰铝板），门面不再是一整块玻璃
          if (et == 4 && fi == 0 && !lobby && st != 2 && st != 3) frameM = max(frameM, bPulse(ws.y - 0.26, ws.y + 0.01, lq.y, fwp.y));
          // 玻璃
          vec3 gAlb; float gRou, gMet;
          bool reflective = et == 5 || (et == 4 && (st == 2 || st == 3));
          if (reflective) { gAlb = glassT * 0.9; gRou = 0.05; gMet = 0.7; }
          else if (et == 11) { gAlb = vec3(0.62, 0.66, 0.66); gRou = 0.35; gMet = 0.0; }
          else {
            // 逐窗差异：玻璃新旧/贴膜（反射率）、擦没擦（粗糙度），整面墙的窗不再一模一样
            float gv = bRand(sd, kWin, 88);
            gAlb = (glassT * 0.35 + 0.01) * (0.7 + 0.6 * gv); gRou = 0.03 + 0.17 * bRand(sd, kWin, 89); gMet = 0.0;
          }
          if (reflective) {
            float gv = bRand(sd, kBay * 131 + fi, 88);
            gAlb *= 0.9 + 0.2 * gv; gRou += 0.06 * bRand(sd, kBay * 131 + fi, 89);
          }
          float F = 0.04 + 0.96 * pow(1.0 - clamp(Vt.z, 0.0, 1.0), 5.0);
          // 室内
          vec3 inAlb = shopLike ? vec3(0.55) : vec3(0.22);
          float lampK = 0.8;
          int ik = lobby ? 1 : shopLike ? 2 : (litCls == 1 ? 1 : 0);
#ifdef BLD_HI
          if (nearK > 0.0 && et != 11) {
            float D = shopLike ? 7.0 : (litCls == 1 ? 9.0 : 3.8 + 2.0 * bRand(sd, kWin, 37));
            vec3 ia = bInterior(lq, ws, wr.y - (et == 2 ? 0.0 : 0.0), fH, D, -Vt, bRand(sd, kWin, 39), ik, lampK);
            inAlb = mix(inAlb, ia, nearK);
          }
#endif
          // 窗帘（住宅、酒店）：白天看得出各家颜色；夜里亮灯时透出的光按中性暖白算（彩色窗帘不把窗灯染成五颜六色）
          vec3 inAlbD = inAlb;
          if (ik == 0 && et != 11 && curtain < 0.55) {
            float fold = 0.88 + 0.12 * sin(lq.x * 24.0) * (1.0 - smoothstep(0.01, 0.04, fwp.x));
            float cov = curtain < 0.35 ? 1.0 : (1.0 - bPulse(ws.x * 0.25, ws.x * 0.75, lq.x, fwp.x));
            vec3 cN = curtain < 0.15 ? vec3(0.85, 0.8, 0.68) : curtain < 0.25 ? vec3(0.9, 0.9, 0.88) : curtain < 0.3 ? vec3(0.8, 0.72, 0.6) : vec3(0.78, 0.77, 0.74);
            inAlbD = mix(inAlb, curtainC * fold, cov);
            inAlb = mix(inAlb, cN * fold, cov);
            lampK = mix(lampK, 0.62, cov);
          }
          float trans = (1.0 - F) * (reflective ? 0.35 : 1.0);
          vec3 dayIn = inAlbD * (shopLike ? 0.25 : 0.075) * (1.0 - uNight);
          vec3 nightIn = vec3(0.0);
          if (shopLike) {
            float shopOn = lobby ? 1.0 : step(bRand(sd, kWin, 45), uLit.z * 1.1);
            float shopK = 0.55 + 0.6 * bRand(sd, kWin, 47);
            vec3 shopC = (st == 10 || bRand(sd, kWin, 49) < 0.7) ? vec3(1.0, 0.84, 0.62) : vec3(0.85, 0.92, 1.0);
            nightIn = inAlb * shopC * 0.7 * shopK * lampK * shopOn * nightOn;
          } else if (et == 11) {
            nightIn = lit ? vec3(0.9, 0.95, 1.0) * 0.5 * nightOn : vec3(0.0);
          } else if (lit) {
            nightIn = inAlb * lampC * lampI * lampK;
          }
          s.emi = (dayIn + nightIn) * trans * (1.0 - frameM);
          s.alb = mix(gAlb, frameC, frameM);
          s.rou = mix(gRou, 0.4, frameM);
          s.met = mix(gMet, 0.55, frameM);
          s.ao = 1.0;
          // 防盗网（在墙面层，不随视差）
          if (grille) {
            vec2 gq = p - wr.xy;
            float gb = max(bLines(gq.x, 0.12, 0.014, fwp.x), bLines(gq.y, 0.42, 0.02, fwp.y));
            gb = max(gb, 1.0 - bRect(vec4(0.03, 0.03, ws.x - 0.03, ws.y - 0.03), gq, fwp));
            s.alb = mix(s.alb, vec3(0.16, 0.13, 0.11), gb * 0.9);
            s.rou = mix(s.rou, 0.6, gb); s.met = mix(s.met, 0.3, gb);
            s.emi *= 1.0 - gb * 0.9;
          }
        }
      }
      alb = mix(alb, s.alb, c1); rou = mix(rou, s.rou, c1); met = mix(met, s.met, c1);
      bldSunK = mix(bldSunK, sunW, c1);
      nT = normalize(mix(nT, s.nT, c1)); ao = mix(ao, s.ao, c1);
      emi += s.emi * c1;
    }

    // ===== 副构件 =====
    float c2 = et2 > 0 ? bRect(wr2, p2, fwp) : 0.0;
    if (c2 > 0.0) {
      vec2 lq = p2 - wr2.xy, ws = wr2.zw - wr2.xy;
      vec3 a2 = alb; float r2 = rou, m2 = met; vec3 n2 = nT; float o2 = 1.0; vec3 e2 = vec3(0.0);
      if (et2 == 3) {
        // 空调百叶
        float sl = bLines(lq.y, 0.09, 0.045, fwp.y);
        float rk = 1.0 - smoothstep(0.012, 0.04, fwp.y);
        // 百叶颜色：白 / 浅灰 / 与墙同色系的浅色（不再用点缀色——塔楼的点缀色多是红褐/深棕，整面墙一串红色小方块，审查 fe_曲江小区）
        vec3 lc = estF ? mix(wallC * 1.15, vec3(0.66, 0.66, 0.64), 0.6) : (variant & 1) == 1 ? vec3(0.78, 0.78, 0.76) : mix(wallC * 1.2, vec3(0.64, 0.64, 0.62), 0.55);
        a2 = mix(lc, lc * 0.25, sl * 0.8);
        n2 = normalize(vec3(0.0, (sl - 0.5) * 0.8 * rk, 1.0));
        r2 = 0.55; m2 = 0.2; o2 = 0.85;
        a2 = mix(a2, lc * 0.9, 1.0 - bRect(vec4(0.03, 0.03, ws.x - 0.03, ws.y - 0.03), lq, fwp));
      } else if (et2 == 8) {
        // 外挂空调：白色外壳 + 风扇格栅
        vec2 fc = vec2(ws.x * 0.62, ws.y * 0.5);
        float rr = length(lq - fc);
        float fan = 1.0 - smoothstep(0.2, 0.2 + fwp.x, rr);
        a2 = mix(vec3(0.74, 0.74, 0.71), vec3(0.2, 0.21, 0.22) * (0.8 + 0.4 * sin(rr * 90.0) * (1.0 - smoothstep(0.004, 0.02, fwp.x))), fan);
        r2 = 0.5; m2 = 0.0;
        a2 *= 1.0 - 0.25 * bPulse(0.0, 0.05, lq.y, fwp.y);
      } else if (et2 == 10) {
        // 层间窗槛墙（不透明玻璃）
        a2 = glassT * 0.5; r2 = 0.12; m2 = 0.6;
        a2 = mix(a2, wallC, 1.0 - bRect(vec4(0.0, 0.05, ws.x, ws.y), lq, fwp));
      } else if (et2 == 12) {
        // 门头招牌带：每两开间一家店，底色 + 居中一行 2~6 个伪汉字（店名）+ 约半数左侧方形店标 + 浅色包边，店与店之间一道缝；
        // 夜间灯箱发光（字更亮）。原来是底色上一串空白“字块”，近看像占位模板
        int shop = bi / 2 + 997 * eIdx;
        float r1 = bRand(sd, shop, 51);
        vec3 bc = bPalette(r1);
        float shopW = 2.0 * bw;
#ifdef BLD_HI
        if ((bi / 2) * 2 + 1 >= int(nb)) shopW = bw;
#endif
        float sx = p2.x + float(bi % 2) * bw;   // 店招内横坐标（两开间连成一块）
        if (uSgn > 0.0) sx = shopW - sx;   // 从外面看从左往右排字、店标在左
        n2 = vec3(0.0, 0.0, 1.0);          // 招牌板是平的：不继承墙面砖缝/卷帘的法线起伏（审查 fs_含光路：红蓝招牌带上有横向楞纹）
        float chH = clamp(ws.y * 0.6, 0.25, 0.75);
        float nMax = floor((shopW - 0.5 - (bRand(sd, shop, 57) < 0.5 ? chH * 1.3 : 0.0)) / (chH * 1.12));
        float nCh = clamp(min(nMax, 2.0 + floor(bRand(sd, shop, 53) * 5.0)), 1.0, 6.0);
        bool logo = bRand(sd, shop, 57) < 0.5 && nMax >= 2.0;
        float tw = nCh * chH * 1.12 - chH * 0.12 + (logo ? chH * 1.3 : 0.0);
        float x0 = 0.5 * (shopW - tw);
        float ty = 0.5 * (ws.y - chH);
        float gx = bTextRow(sx - x0 - (logo ? chH * 1.3 : 0.0), lq.y - ty, chH, nCh, sd * 7 + shop, fwp);
        float lg = logo ? bRect(vec4(x0, ty - 0.04, x0 + chH + 0.08, ty + chH + 0.04), vec2(sx, lq.y), fwp) : 0.0;
        float lgIn = logo ? bGlyph(vec2((sx - x0 - 0.04) / chH, (lq.y - ty) / chH), fwp / chH, sd * 13 + shop) : 0.0;
        vec3 tc = r1 > 0.68 && r1 < 0.82 ? vec3(0.62, 0.06, 0.04) : (r1 < 0.4 || r1 > 0.92) && bRand(sd, shop, 58) < 0.4 ? vec3(0.85, 0.66, 0.12) : vec3(0.92, 0.9, 0.84);
        float edge = 1.0 - bRect(vec4(0.06, 0.05, shopW - 0.06, ws.y - 0.05), vec2(sx, lq.y), fwp);
        float gap = max(bPulse(-0.05, 0.05, sx, fwp.x), bPulse(shopW - 0.05, shopW + 0.05, sx, fwp.x));
        a2 = mix(bc, tc, gx * 0.92);
        a2 = mix(a2, mix(tc, bc, lgIn * 0.9), lg);
        a2 = mix(a2, mix(bc * 1.3 + 0.05, vec3(0.7), 0.4), edge * 0.8);
        a2 = mix(a2, vec3(0.06), gap);
        r2 = 0.45; m2 = 0.0;
        float on = step(bRand(sd, shop, 55), uLit.z * 1.2) * nightOn;
        e2 = (bc * 0.3 + tc * (gx + lg * 0.5) * 1.3) * on * (1.0 - gap);
      } else if (et2 == 16) {
        n2 = vec3(0.0, 0.0, 1.0);
        // 仿古匾额：黑漆/朱红/藏青底 + 3~4 个金色伪汉字 + 金边，夜间字与边框发光
        int shop = bi + 997 * eIdx;
        float r1 = bRand(sd, shop, 51);
        vec3 bc = r1 < 0.6 ? vec3(0.035, 0.025, 0.02) : r1 < 0.85 ? vec3(0.24, 0.035, 0.025) : vec3(0.03, 0.06, 0.1);
        float nch = 3.0 + floor(bRand(sd, shop, 52) * 2.0);
        float chP = min(ws.y * 0.62, ws.x / (nch * 1.12 + 0.4));
        float pw = nch * chP * 1.12 - chP * 0.12;
        float px = uSgn > 0.0 ? ws.x - lq.x : lq.x;
        float gx = bTextRow(px - 0.5 * (ws.x - pw), lq.y - 0.5 * (ws.y - chP), chP, nch, sd * 11 + shop, fwp);
        float fr = 1.0 - bRect(vec4(0.05, 0.04, ws.x - 0.05, ws.y - 0.04), lq, fwp);
        vec3 gold = vec3(0.72, 0.52, 0.16);
        a2 = mix(mix(bc, gold, gx * 0.9 * (0.35 + 0.65 * detail)), gold * 0.75, fr);
        r2 = 0.35; m2 = 0.55 * max(gx, fr);
        float on = step(bRand(sd, shop, 55), uLit.z * 1.2) * nightOn;
        e2 = gold * (gx * 1.3 + fr * 0.4) * on;
      }
      // 外挂空调在墙上的投影
      alb = mix(alb, a2, c2); rou = mix(rou, r2, c2); met = mix(met, m2, c2); nT = normalize(mix(nT, n2, c2));
      ao = mix(ao, o2, c2); emi += e2 * c2;
    }
    if (et2 == 8) {
      ao *= 1.0 - 0.45 * bPulse(wr2.x, wr2.z, p2.x, fwp.x) * bPulse(wr2.y - 0.35, wr2.y, p2.y, fwp.y) * smoothstep(wr2.y - 0.35, wr2.y, p2.y);
    }
    }   // !partDone

    // ===== 远景平均（开间尺度 < 约 1 像素时） =====
    float wf = st == 2 ? 0.72 : st == 3 ? 0.45 : st == 0 ? 0.3 : st == 1 ? 0.22 : st == 4 ? 0.22 : st == 5 ? 0.16 : st == 6 ? 0.05 : 0.28;
    if (wfO >= 0.0) wf = wfO;
    vec3 gAvg = (st == 2 || st == 3) ? glassT * 0.7 : glassT * 0.25 + 0.02;
    vec3 aBase = partDone ? alb : albW;
    vec3 aAvg = mix(aBase, gAvg, wf);
    float rAvg = mix(partDone ? rou : rouW, st == 2 ? 0.12 : 0.3, wf);
    float mAvg = mix(partDone ? met : metW, (st == 2 || st == 3) ? 0.55 : 0.0, wf);
    vec3 lampAvg = litCls == 1 ? vec3(0.93, 0.92, 0.86) : vec3(1.0, 0.76, 0.5);   // 办公中性白（远看不再是冷白条码）
    float iAvg = litCls == 1 ? 0.3 : 0.38;   // 与近景亮窗的平均亮度一致（灯色 × 室内反照率 × 0.4~1.0 亮度）
    // 远看：亮窗按“每层 × 约 3 开间”成组亮灭（矩形块，不是整面墙均匀发光）；块小于约 1 像素时换成期望值（防闪烁）
    float cellW = litCls == 1 ? bw * 6.0 : bw * 3.0, cellH = max(fh, 2.5);   // 办公按半层成片亮
    float litPatch = step(bRand(sd, int(floor(u / cellW)) + 4096, int(floor(max(v, 0.0) / cellH)) + 77), litP * 0.8);
    litPatch *= 1.0 - 0.8 * bLines(v, cellH, 0.7, fwp.y);   // 楼板遮挡
    litPatch = mix(litPatch, min(litP * 0.8, 1.0) * 0.8, smoothstep(0.45, 1.2, max(fwp.y / cellH, fwp.x / cellW)));
    // 远处的城区：单栋楼只剩几个像素，亮窗平均值换算到屏幕上过暗（审查 p1_night：全城像停电）——按视距抬高平均亮窗
    float camD = length(cameraPosition - vWPos);
    // 远看抬高：几公里外单栋楼只剩几个像素，亮窗平均值换算到屏幕上太暗（审查 p1_night / p7_night / p2_night：远处住宅塔楼成片不亮窗、像白天的纸盒）
    float farBoost = 1.0 + 2.6 * smoothstep(500.0, 5000.0, camD);
    vec3 eAvg = lampAvg * wf * iAvg * nightOn * litPatch * farBoost;
    if (st == 4 || st == 10 || street) eAvg += vec3(1.0, 0.8, 0.6) * 0.22 * uLit.z * nightOn * (1.0 - smoothstep(gf - 0.5, gf + 0.5, v)) * float(v > 0.0);
    // 掠射角（开间方向已混叠、楼层方向还看得清）：按“楼层窗带”横向平均，窗不会整片消失成一堵实墙（审查 st_walltop）
    vec3 aRow = aAvg; vec3 eRow = eAvg; float rRow = rAvg, mRow = mAvg;
    float detailY = 1.0 - smoothstep(0.3, 0.85, fwp.y / max(fH, 0.5));
    if (!partDone && wfO < 0.0 && detailY > detail + 0.01) {
      vec3 rw = st == 0 || estF ? vec3(0.85, 2.45, 0.5) : st == 1 ? vec3(0.9, 2.4, 0.45) : st == 2 ? vec3(0.9, fH - 0.06, 0.95)
              : st == 3 ? vec3(0.95, fH - 0.55, 0.7) : st == 4 ? vec3(0.8, fH - 0.6, 0.55) : st == 5 ? vec3(1.0, 2.35, 0.35)
              : st == 6 ? vec3(0.0) : st == 7 ? vec3(0.9, fH - 0.85, 0.7) : st == 8 ? vec3(0.55, fH - 0.5, 0.4)
              : st == 10 ? vec3(0.85, fH - 0.72, 0.6) : vec3(1.0, min(fH - 0.6, 2.6), 0.38);
      if (fi == 0) rw = (eStreet || st == 4 || st == 10) ? vec3(0.25, gf - 0.7, 0.85) : vec3(0.9, min(2.6, gf - 0.4), 0.45);
      float rowWin = bPulse(rw.x, rw.y, fy, fwp.y) * rw.z * float(winFloor) * float(inBay);
      float litRow = step(bRand(sd, int(floor(u / cellW)) + 4096, fi + 77), litP * 0.8);
      litRow = mix(litRow, min(litP * 0.8, 1.0) * 0.8, smoothstep(0.45, 1.2, fwp.x / cellW));
      aRow = mix(albW, gAvg, rowWin);
      rRow = mix(rouW, st == 2 ? 0.12 : 0.1, rowWin);
      mRow = mix(metW, (st == 2 || st == 3) ? 0.55 : 0.0, rowWin);
      eRow = (fi == 0 && (eStreet || st == 4 || st == 10) ? vec3(1.0, 0.84, 0.62) * 0.3 * step(0.25, uLit.z) : lampAvg * iAvg * litRow) * rowWin * nightOn * farBoost;
    }
    if (!inBay && detail < 1.0 && wfO < 0.0) { aAvg = aRow = alb; eAvg *= 0.0; eRow *= 0.0; }
    alb = mix(mix(aAvg, aRow, detailY), alb, detail);
    rou = mix(mix(rAvg, rRow, detailY), rou, detail);
    met = mix(mix(mAvg, mRow, detailY), met, detail);
    emi = mix(mix(eAvg, eRow, detailY), emi, detail);
    nT = normalize(mix(vec3(0.0, 0.0, 1.0), nT, detail));
    bldSunK = mix(1.0, bldSunK, detail);

#if NUM_DIR_LIGHTS > 0
    // 白天地面反光：受光的路面/地面把约 2 成阳光反射到立面上，背阴面不再是一堵黑墙（审查 fs_凤城八路：下午北立面近乎黑灰）；
    // 越靠近地面越强（视角因子），受光面同样有、但相对直射光可以忽略
    {
      vec3 Lg = (vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz;
      float gb = max(Lg.y, 0.0) * (0.55 + 0.45 * exp(-max(v, 0.0) / 25.0));
      emi += alb * directionalLights[0].color * gb * 0.05 * (1.0 - uNight);
    }
#endif
    // 夜间墙面：底部路灯/店招反射 + 城市天光（很弱，只为勾出体量；临街/商业更亮，城区有成片暖光）
    float spill = (street || st == 4 || st == 10) ? 0.09 : 0.05;
    emi += alb * (vec3(1.0, 0.78, 0.55) * spill * exp(-max(v, 0.0) / 14.0) + vec3(0.55, 0.6, 0.75) * 0.012) * nightOn;
    // 楼顶亮化：顶部约 1.5 层向上渐强的泛光 + 女儿墙顶细轮廓灯带（构架一起亮）
    if (crownLit && nightOn > 0.0) {
      float kc = smoothstep(roofV - 1.6 * fh, H + 0.05, v);
      float strip = bPulse(H - 0.16, H + 0.02, v, fwp.y) * float(bPart == 0);
      emi += crownC * nightOn * (kc * kc * (bPart == 4 ? 0.8 : 0.4) + strip * 1.2);
    }
    // 仿古商业：檐口暖色轮廓灯（西大街、书院门夜景的金色檐线），约 3/4 的楼、随商业亮灯率
    if (st == 10 && nightOn > 0.0 && bRand(sd, 66, 3) < 0.75) {
      float eaveL = bPulse(H - 0.12, H + 0.02, v, fwp.y) + (H >= gf + 2.6 ? bPulse(gf + 0.2, gf + 0.32, v, fwp.y) : 0.0);
      emi += vec3(1.0, 0.68, 0.32) * eaveL * 1.1 * nightOn * step(0.25, uLit.z);
    }
    // 玻璃幕墙写字楼竖向 LED 线条灯（约 1/4）
    if (!estF && uBDetail > 0.5 && (st == 2 || st == 3) && H >= 60.0 && bRand(sd, 63, 3) < 0.25 && v > gf) {
      emi += crownC * bLines(u, bw * 4.0, 0.12, fwp.x) * 0.8 * nightOn;
    }
    vec3 nW = normalize(Tt * nT.x + vec3(0.0, 1.0, 0.0) * nT.y + Nh * nT.z);
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  } else {
    // ================= 屋面 / 女儿墙压顶 =================
    bldIndK = 0.5;
    bool coping = false;
#ifdef BLD_HI
    coping = ph > 0.05 && v > H - 0.12;
#endif
    vec2 wp = vWPos.xz;
    vec2 fwr = vec2(length(dFdx(wp)), length(dFdy(wp))) + 1e-4;
    float rn = bNoise(wp * 0.21) * 0.6 + bNoise(wp * 1.37) * 0.4;
    if (bPart >= 8) {
      // ===== 近景细部的水平面 =====
      int pid = (int(vFac.z + 0.5) >> 8) & 63;
      float pr1 = bRand(sd, pid + 97 * bPart, 7);
      met = 0.0; rou = 0.85;
      if (bPart == 11) {
        if ((pid & 32) != 0 && Nw.y > 0.0) {
          // 防盗窗雨棚：蓝/绿阳光板或彩钢瓦（垂直墙面的瓦楞），积灰落叶
          vec3 cv = pr1 < 0.5 ? vec3(0.16, 0.32, 0.42) : pr1 < 0.75 ? vec3(0.42, 0.42, 0.4) : vec3(0.22, 0.12, 0.08);
          alb = cv * (0.85 + 0.25 * rn) * (1.0 - 0.25 * smoothstep(0.5, 0.8, bNoise(wp * 2.0 + 7.0)));
          rou = 0.5;
        } else {
          // 防盗窗底板：锈铁板 / 杂物
          alb = vec3(0.16, 0.12, 0.1) * (0.8 + 0.4 * rn); rou = 0.7; met = 0.2;
        }
      } else if (bPart == 10) {
        alb = vec3(0.68, 0.68, 0.65) * (0.9 + 0.15 * rn) * (Nw.y < 0.0 ? 0.6 : 1.0); rou = 0.5;
      } else if (bPart == 9) {
        alb = Nw.y < 0.0 ? vec3(0.3, 0.3, 0.29) : vec3(0.5, 0.5, 0.48) * (0.85 + 0.25 * rn);
      } else if (bPart == 13) {
        float plr = vR1.w > 0.0 ? fract(vR1.w * 3.7) : bRand(sd, 71, 1);
        vec3 plc = (st == 1 || st == 5) ? (plr < 0.5 ? vec3(0.19, 0.185, 0.18) : plr < 0.8 ? vec3(0.29, 0.28, 0.26) : vec3(0.27, 0.13, 0.09))
                                        : (plr < 0.4 ? vec3(0.15, 0.148, 0.145) : plr < 0.75 ? vec3(0.33, 0.31, 0.28) : vec3(0.23, 0.2, 0.18));
        alb = (plc * 1.5 + 0.04) * (0.9 + 0.2 * rn); rou = 0.7;
      } else if (bPart == 14) {
        alb = vec3(0.45, 0.46, 0.46) * (0.85 + 0.2 * rn); rou = 0.45; met = 0.6;
      } else {
        // 楼板挑檐顶/底
        alb = Nw.y < 0.0 ? vec3(0.32, 0.315, 0.3) * (0.9 + 0.2 * rn) : mix(wallC, vec3(0.5, 0.5, 0.48), 0.5) * (0.85 + 0.25 * rn);
      }
      bldSpecK = 0.6;
    } else if (bPart > 0) {
      // ===== 附属构件的水平面 =====
      int ci = (int(vFac.z + 0.5) >> 8) & 7;
      if (Nw.y < 0.0) {
        // 底面：阳台/凸窗底板、雨棚与构架下表面
        alb = bPart == 3 ? bAwning(ci) * 0.55 : vec3(0.34, 0.335, 0.32) * (0.9 + 0.2 * rn); rou = 0.9;
        if (bPart == 3) emi = vec3(1.0, 0.82, 0.6) * 0.55 * nightOn * step(0.25, uLit.z);   // 店铺灯光照亮雨棚底
        if (bPart == 5) emi = vec3(1.0, 0.85, 0.62) * 0.9 * nightOn;                         // 单元门灯
        if (bPart == 4 && crownLit) emi = crownC * 0.9 * nightOn;
      } else if (bPart == 3) {
        // 雨棚顶面：阳光板 / 彩钢 / 帆布，垂直外墙方向的肋（世界坐标下取两向叠加近似）
        alb = bAwning(ci) * (0.88 + 0.2 * rn);
        float rib = max(bLines(wp.x, 0.6, 0.05, fwr.x), bLines(wp.y, 0.6, 0.05, fwr.y));
        alb *= 1.0 - 0.18 * rib;
        rou = ci == 3 || ci == 4 ? 0.45 : 0.35; met = ci == 3 ? 0.4 : 0.0;
        alb *= 1.0 - 0.2 * smoothstep(0.5, 0.8, bNoise(wp * 0.7 + 3.0));   // 积灰落叶
      } else if (bPart == 4) {
        alb = (st == 0 ? mix(accC * 1.15, vec3(0.66), 0.4) : vec3(0.62, 0.62, 0.6)) * (0.9 + 0.2 * rn); rou = 0.8;
        if (crownLit) emi = crownC * 0.5 * nightOn;
      } else {
        // 叠柱顶 / 入口雨棚顶：水泥压顶
        alb = mix(wallC, vec3(0.42, 0.41, 0.39), 0.55) * (0.85 + 0.25 * rn); rou = 0.85;
        bldSpecK = 0.6;
      }
    } else if ((est || pitched) && Nw.y < -0.3) {
      // 挑檐 / 檐口底面（仿古：深赭色椽望，“深色檐下”）
      alb = (st == 10 ? vec3(0.11, 0.05, 0.035) : estF ? mix(wallC, eTrim, 0.4) : vec3(0.3)) * 0.7; rou = 0.9;
      if (st == 10) {
        float raf = max(bLinesF(wp.x, 0.32, 0.12, fwr.x), bLinesF(wp.y, 0.32, 0.12, fwr.y));   // 椽子（两向近似）
        alb *= 1.0 + 0.6 * raf;
        emi = vec3(1.0, 0.7, 0.4) * 0.12 * nightOn * step(0.25, uLit.z);   // 檐下被檐灯/店铺灯照亮
      }
    } else if (pitched && (v > H - 0.1 || st == 10)) {
      // ===== 坡屋面（小区 + 通用平改坡 + 仿古腰檐）：红/橙色为筒瓦（纵向瓦垄），灰色为平瓦（错缝），颜色取卫星逐栋取样、照片目测或色库 =====
      // 审查 st_eastgate：近看满屏噪点、背光坡水平摩尔纹 → 逐瓦色差减弱并提早淡出、瓦垄/瓦行线改带限版、法线扰动减半
      float sinS = length(Nw.xz);
      vec2 T = sinS > 0.05 ? normalize(vec2(-Nw.z, Nw.x)) : vec2(1.0, 0.0);
      float tu = dot(wp, T);
      float sv = (v - H) / max(sinS, 0.25);
      vec2 fwt = vec2(length(vec2(dFdx(tu), dFdy(tu))), length(vec2(dFdx(sv), dFdy(sv)))) + 1e-4;
      float det = 1.0 - smoothstep(0.01, 0.045, max(fwt.x, fwt.y));
      bool redT = roofTile.r > roofTile.b * 1.5;
      bool clay = redT || !est;   // 通用平改坡 / 城内仿古一律按筒瓦（纵向瓦垄）
      float tid = bRand(int(floor(tu / 0.25)) + 65536, int(floor(sv / 0.3)) + 65536, 13);
      // 灰瓦色板本身已是“印象色”，不再 ×0.62（原来折算后接近纯黑）
      // 红瓦降饱和成褪色陶红（审查 st_eastgate：饱和大红平涂像塑料）
      vec3 rtC = redT ? mix(roofTile, vec3(dot(roofTile, vec3(0.3, 0.59, 0.11))), 0.3) * vec3(1.0, 0.94, 0.9) : roofTile;
      alb = rtC * (redT ? 0.6 : 0.95) * (0.9 + 0.08 * tid * det + 0.12 * rn);
      // 中尺度：一片片新旧不一的瓦（0.75 × 0.6 m 一块的明暗），中远距离（瓦垄已淡出）屋面不再是一块平涂
      float det2 = 1.0 - smoothstep(0.12, 0.45, max(fwt.x, fwt.y));
      float tp = bRand(int(floor(tu / 0.75)) + 65536, int(floor(sv / 0.6)) + 65536, 19);
      alb *= mix(1.0, 0.9 + 0.2 * tp, det2 * 0.8);
      // 顺坡的雨水/青苔挂痕（宽约 1~2 m 的竖条）
      float rs = bNoise(vec2(tu * 0.7, sv * 0.06 + 13.0));
      alb *= 1.0 - 0.16 * smoothstep(0.5, 0.85, rs);
      alb *= 1.0 - 0.26 * bLinesF(sv, 0.3, 0.05, fwt.y);
      if (clay) {
        float rk = 1.0 - smoothstep(0.3, 0.9, fwt.x / 0.25);
        float rid = cos(tu / 0.25 * 6.2831853);
        alb *= 1.0 + 0.12 * rid * rk;
        // 筒瓦之间的瓦沟（深色细线，带限：中距离仍看得出一垄垄瓦，远看淡成均值；审查 st_walltop：仿古坡顶像一条沥青板）
        alb *= 1.0 - 0.38 * bLinesF(tu + 0.125, 0.25, 0.07, fwt.x);
        // 檐口一排瓦当/滴水的阴影
        alb *= 1.0 - 0.3 * bPulse(H - 0.05, H + 0.22, v, fwt.y * sinS);
        vec3 tw = vec3(T.x, 0.0, T.y) * sin(tu / 0.25 * 6.2831853) * 0.18 * det * det;
        normal = normalize(normal + (viewMatrix * vec4(tw, 0.0)).xyz);
        rou = 0.72;
      } else {
        float jv = bLinesF(tu + mod(floor(sv / 0.3), 2.0) * 0.15, 0.3, 0.025, fwt.x);
        alb *= 1.0 - 0.25 * jv * det;
        rou = 0.62;
      }
      alb *= 1.0 - 0.18 * smoothstep(0.5, 0.85, bNoise(wp * 0.13 + 11.0));   // 积灰/雨渍
      bldSpecK = redT ? 0.7 : 0.45;   // 灰瓦：掠射角下不反出一片天空蓝（原来灰瓦顶远看发藏青）
    } else if (coping) {
      alb = mix(wallC, vec3(0.42, 0.41, 0.39), 0.55) * (0.9 + 0.2 * rn); rou = 0.8;
      bldShRad = 2.5;
    } else {
      // ===== 平屋面：按屋面类型（bld-gen.js ROOF）画真实屋面做法 =====
      // 纹样一律在楼的主轴局部坐标里（与女儿墙平行，不再是世界坐标对齐的大方块），全部盒式滤波，
      // 按像素足迹分三档淡化为均值：细纹（砖缝、颗粒）、中纹（分格缝、卷材搭接、排水坡线）、粗纹（补丁、污斑）——远看是均匀的屋面色调，不出摩尔纹
      int rCode = int(vR0.w + 0.5);
      int rType = rCode & 15;
      bool rRect = (rCode & 16) != 0, rSky = (rCode & 32) != 0;
      float gs = vR1.w;
      float ca = cos(vR0.x), sa = sin(vR0.x);
      vec2 dl = wp - vB3.xy;
      vec2 lp = vec2(dl.x * ca + dl.y * sa - vR0.y, -dl.x * sa + dl.y * ca - vR0.z);
      vec2 hs = vR1.xy;
      vec2 axS = vec2(ca, sa), axT = vec2(-sa, ca);
      if (hs.y > hs.x) { lp = vec2(lp.y, -lp.x); hs = hs.yx; axS = vec2(-sa, ca); axT = vec2(-ca, -sa); }   // s 取长向
      vec2 fwl = vec2(length(vec2(dFdx(lp.x), dFdy(lp.x))), length(vec2(dFdx(lp.y), dFdy(lp.y)))) + 1e-4;
      float fwm = max(fwl.x, fwl.y);
      float kF = 1.0 - smoothstep(0.012, 0.05, fwm);   // 细纹（颗粒）
      float kT = 1.0 - smoothstep(0.06, 0.18, fwm);    // 逐块色差（0.4~0.5 m 方砖）
      float kM = 1.0 - smoothstep(0.2, 0.6, fwm);      // 中纹（1~2 m 卷材逐幅色差）
      float kC = 1.0 - smoothstep(0.6, 2.4, fwm);      // 粗纹
      float eS = hs.x - abs(lp.x), eT = hs.y - abs(lp.y);
      float eD = min(eS, eT);   // 到外接矩形边的距离（矩形楼≈到女儿墙）
      if (ph > 0.05) bldShRad = mix(2.5, 1.0, smoothstep(1.4, 2.8, eD));   // 女儿墙投在屋面边缘的窄条阴影：柔和 PCF（见 SHADOW_PARS）
      vec3 rb0 = bRoofCol(rType, gs, sd);
      float rR = gs > 0.0 ? fract(gs * 13.7) : bRand(sd, 7, 1);
      vec3 ra = rb0; float rr = 0.9, rm = 0.0, specK = 0.42;
      vec2 slope = vec2(0.0);   // 找坡下坡方向（局部 s,t），给法线一点倾斜
      float skyE = 0.0;
      // 大尺度色差：积灰、新旧、雨后水渍
      float nL = bNoise(lp * 0.09 + vec2(gs * 61.0, float(sd & 255))) * 0.6 + bNoise(lp * 0.31 + 7.0) * 0.4;
      if (rType == 1) {
        // —— 新住宅·上人屋面：400/500 方砖 + 约 3 m 分格缝（沥青嵌缝）——
        float ts = rR < 0.5 ? 0.5 : 0.4;
        float jT = max(bLinesF(lp.x, ts, 0.012, fwl.x), bLinesF(lp.y, ts, 0.012, fwl.y));
        float gp = ts * 6.0;
        float jG = max(bLinesF(lp.x, gp, 0.03, fwl.x), bLinesF(lp.y, gp, 0.03, fwl.y));
        float tv = bRand(int(floor(lp.x / ts)) + 65536, int(floor(lp.y / ts)) + 65536, 17);
        ra *= mix(1.0, 0.92 + 0.16 * tv, kT);
        ra *= 1.0 - 0.28 * jT;
        ra = mix(ra, vec3(0.05, 0.05, 0.048), jG * 0.8);
        rr = 0.8;
      } else if (rType == 2) {
        // —— 新住宅·矿物面卷材：1 m 宽卷材沿长向铺，搭接边略浅；每卷新旧略有差别 ——
        float sL = lp.y + 0.37;
        float seam = bLinesF(sL, 1.0, 0.1, fwl.y);
        float sid = bRand(int(floor(sL)) + 65536, sd & 4095, 23);
        ra *= mix(1.0, 0.95 + 0.1 * sid, kM);
        ra *= 1.0 + 0.12 * seam;
        // 卷材端头搭接（约 10 m 一道，逐卷错开）
        ra *= 1.0 + 0.1 * bLinesF(lp.x + 7.3 * sid, 10.0, 0.12, fwl.x) * kM;
        ra *= 1.0 + 0.12 * (bNoise(lp * 9.0) - 0.5) * kF;
        rr = 0.88;
      } else if (rType == 3) {
        // —— 老住宅·沥青油毡：卷材搭接缝（沥青胶外溢）、新铺补丁（深、反光）、褪色起灰的老卷材、零星沥青糊补；
        //    约 1/5 刷银粉反光涂料（磨损处露黑），约 1/8 绿色防水涂料 ——
        float sL = lp.y + 0.21;
        float seam = bLinesF(sL, 1.0, 0.07, fwl.y);
        float sid = bRand(int(floor(sL)) + 65536, sd & 4095, 23);
        ra *= mix(1.0, 0.88 + 0.24 * sid, kM);
        ra *= 1.0 - 0.3 * seam;
        // 矩形补丁：一块块新油毡（顺卷材方向），稀疏、尺寸随机
        vec2 pc = vec2(4.6, 3.3);
        vec2 ci = floor(lp / pc);
        int cx = int(ci.x) + 4096, cz = int(ci.y) + 4096;
        float pr0 = bRand(cx, cz, 41 + (sd & 63));
        vec2 psz = vec2(1.2 + 2.6 * bRand(cx, cz, 42), 0.9 + 1.5 * bRand(cz, cx, 43));
        vec2 po = ci * pc + vec2(bRand(cx, cz, 44), bRand(cz, cx, 45)) * (pc - psz);
        float rp = bRect(vec4(po, po + psz), lp, fwl) * step(pr0, 0.3);
        float pDark = step(pr0, 0.17);
        ra = mix(ra, rb0 * (pDark > 0.5 ? 0.6 : 1.38), rp * kC);
        rr = mix(rr, 0.62, rp * pDark * kC);
        // 褪色起灰（浅）与沥青糊补（黑、亮）：噪声阈值，边缘宽度跟像素足迹走
        float pw = max(0.025, 0.5 * fwm);
        float fd = smoothstep(0.6 - pw, 0.6 + pw, bNoise(lp * 0.23 + 40.0 + float(sd & 31)));
        ra *= mix(1.0, 1.3, fd * kC);
        float tn = bNoise(lp * 0.55 + 3.7 + float(sd & 15)) * 0.7 + bNoise(lp * 1.9) * 0.3;
        float tar = smoothstep(0.76 - pw, 0.76 + pw, tn);
        ra = mix(ra, vec3(0.045, 0.044, 0.042), tar * 0.8 * kC);
        rr = mix(rr, 0.42, tar * kC);
        ra *= 1.0 + 0.16 * (bNoise(lp * 11.0) - 0.5) * kF;   // 砂粒
        bool silver = bRand(sd, 6, 1) < 0.2, green = !silver && bRand(sd, 6, 2) < 0.12;
        if (silver || green) {
          vec3 cc = silver ? vec3(0.43, 0.44, 0.45) : vec3(0.12, 0.2, 0.14);
          // 涂层顺卷材方向一幅幅刷，局部磨损露出底下的油毡（磨损处也只是半透）
          float wn3 = bNoise(lp * vec2(0.35, 1.1) + 17.0 + float(sd & 7)) * 0.75 + bNoise(lp * 2.3) * 0.25;
          float wear = smoothstep(0.74 - pw, 0.74 + pw, wn3) * kC * 0.65;
          vec3 ct = cc * (0.92 + 0.08 * sid) * (1.0 - 0.18 * seam) * (0.94 + 0.12 * bNoise(lp * 0.8 + 3.0));
          ra = mix(ct, ra, wear);
          rr = mix(silver ? 0.5 : 0.75, rr, wear);
          rm = silver ? 0.22 * (1.0 - wear) : 0.0;
          specK = silver ? 0.75 : 0.5;
        }
      } else if (rType == 5 || rType == 6) {
        // —— 商业办公：浅色 TPO 卷材（2 m 幅宽焊缝）或碎石压顶；屋脊一条混凝土走道板 ——
        if (rType == 5) {
          float sL = lp.y + 0.5;
          float seam = bLinesF(sL, 2.0, 0.05, fwl.y);
          float sid = bRand(int(floor(sL / 2.0)) + 65536, sd & 4095, 27);
          ra *= mix(1.0, 0.95 + 0.1 * sid, kM);
          ra *= 1.0 - 0.14 * seam;
          // 积灰与雨后水渍（浅色卷材最显脏）：顺坡的条状污迹 + 斑块
          float dirt = bNoise(lp * vec2(0.12, 0.6) + 5.0) * 0.6 + bNoise(lp * 0.5 + 2.0) * 0.4;
          ra *= 1.0 - 0.22 * smoothstep(0.45, 0.85, dirt);
          rr = 0.7; specK = 0.55;
        } else {
          float g = bNoise(lp * 13.0) * 0.5 + bNoise(lp * 29.0 + 5.0) * 0.5;
          ra *= 1.0 + 0.5 * (g - 0.5) * kF;
          ra *= 1.0 + 0.12 * (bNoise(lp * 1.1 + 3.0) - 0.5) * kM;
          rr = 0.96; specK = 0.3;
        }
        if (hs.x > 8.0 && hs.y > 5.0) {
          float wk = bPulse(-0.4, 0.4, lp.y, fwl.y) * step(abs(lp.x), hs.x - 1.2);
          vec3 pv = vec3(0.42, 0.415, 0.4) * (1.0 - 0.3 * max(bLinesF(lp.x, 0.6, 0.02, fwl.x), bLinesF(lp.y + 0.4, 0.8, 0.02, fwl.y)));
          ra = mix(ra, pv, wk * kM);
        }
      } else if (rType == 7) {
        // —— 工业彩钢板：顺坡压型板肋（与屋脊垂直）、屋脊盖板、每 6 m 一道采光带 ——
        float rt = bRand(sd, 5, 1);
        ra = rt < 0.4 ? vec3(0.2, 0.25, 0.31) : rt < 0.8 ? vec3(0.42, 0.44, 0.45) : vec3(0.3, 0.14, 0.11);
        float rib = bLinesF(lp.x, 0.3, 0.06, fwl.x);
        ra *= 1.0 - 0.2 * rib;
        float rk = 1.0 - smoothstep(0.03, 0.1, fwl.x);
        vec2 tw2 = axS * sin(lp.x / 0.3 * 6.2831853) * 0.25 * rk;
        normal = normalize(normal + (viewMatrix * vec4(tw2.x, 0.0, tw2.y, 0.0)).xyz);
        float ridgeC = bPulse(-0.3, 0.3, lp.y, fwl.y);
        ra = mix(ra, ra * 1.15, ridgeC);
        if (hs.x > 9.0) {
          float sk = bPulse(0.0, 1.0, mod(lp.x + 3.0, 6.0), fwl.x) * step(0.6, eT);
          ra = mix(ra, vec3(0.52, 0.56, 0.56), sk * 0.9);
          skyE = sk * 0.35;
        }
        rr = 0.5; rm = 0.3; specK = 1.0;
      } else if (rType == 8) {
        // —— 城中村：水泥砂浆面，补抹的新灰、分块抹面缝与杂物污迹 ——
        float pw = max(0.03, 0.5 * fwm);
        float pt = smoothstep(0.62 - pw, 0.62 + pw, bNoise(lp * 0.6 + float(sd & 31)));
        ra *= mix(1.0, 1.25, pt * kC);
        ra *= 1.0 - 0.25 * max(bLinesF(lp.x, 1.5, 0.015, fwl.x), bLinesF(lp.y, 1.5, 0.015, fwl.y)) * kM;
        ra *= 1.0 + 0.18 * (bNoise(lp * 8.0) - 0.5) * kF;
        rr = 0.92;
      }
      // —— 排水找坡（近似矩形的楼）：四坡分水线（屋脊 + 斜向到四角），面砖屋面是嵌缝线、卷材屋面是浅色折痕；坡面朝向不同略有明暗 ——
      if (rRect && (rType == 1 || rType == 2 || rType == 3 || rType == 5) && hs.y > 2.5) {
        float fwd = fwm * 1.5;
        float hip = bPulse(-0.035, 0.035, eS - eT, fwd) * step(0.3, eD);
        float ridge = bPulse(-0.035, 0.035, lp.y, fwl.y) * step(abs(lp.x), hs.x - hs.y);
        float dr = max(hip, ridge) * kM;
        ra = rType == 1 ? mix(ra, vec3(0.05, 0.05, 0.048), dr * 0.8) : ra * (1.0 + (rType == 3 ? -0.25 : 0.14) * dr);
        slope = eT < eS ? vec2(0.0, sign(lp.y)) : vec2(sign(lp.x), 0.0);
        ra *= 1.0 + 0.035 * (eT < eS ? sign(lp.y) : 0.6 * sign(lp.x));
        // 雨水口：长边两端各一个（深色方口 + 周围水渍）
        vec2 dq = vec2(hs.x - 1.3 - abs(lp.x), hs.y - 0.32 - abs(lp.y));
        float drain = bRect(vec4(-0.13, -0.13, 0.13, 0.13), dq, fwl);
        float stain = (1.0 - smoothstep(0.15, 1.7, length(dq))) * (0.55 + 0.45 * bNoise(lp * 1.7));
        ra *= 1.0 - 0.3 * stain * kC;
        ra = mix(ra, vec3(0.025), drain * kM);
      }
      // 女儿墙根部天沟：积灰积水更深
      float gut = 1.0 - smoothstep(0.08, 0.45, eD);
      ra *= 1.0 - (rRect ? 0.1 : 0.05) * gut;
      // —— 采光顶（大体量商业/公建）：屋面中部一条玻璃采光带（铝框分格 + 0.28 m 翻边），白天反天光、夜间透出室内灯光 ——
      if (rSky && hs.x > 10.0 && hs.y > 7.0) {
        float sw = min(3.2, hs.y * 0.34);
        vec4 sr = vec4(-hs.x * 0.62, -sw * 0.5, hs.x * 0.62, sw * 0.5);
        float inS = bRect(sr, lp, fwl);
        float curb = clamp(bRect(sr + vec4(-0.28, -0.28, 0.28, 0.28), lp, fwl) - inS, 0.0, 1.0);
        float mul = max(bLinesF(lp.x, 1.5, 0.08, fwl.x), bPulse(-0.05, 0.05, lp.y, fwl.y));
        ra = mix(ra, vec3(0.5, 0.5, 0.49), curb);
        ra = mix(ra, mix(vec3(0.035, 0.045, 0.05), vec3(0.55, 0.56, 0.57), mul), inS);
        rr = mix(rr, mix(0.06, 0.4, mul), inS); rm = mix(rm, mix(0.55, 0.6, mul), inS);
        specK = mix(specK, 1.0, inS);
        skyE = max(skyE, inS * (1.0 - mul));
      }
      ra *= 0.88 + 0.24 * nL;
      // 找坡法线：实际 2% 的坡，夸大到约 4%（四个坡面在斜光下有明暗差）
      if (slope.x != 0.0 || slope.y != 0.0) {
        vec2 sw2 = (axS * slope.x + axT * slope.y) * 0.04 * kM;
        normal = normalize(normal + (viewMatrix * vec4(sw2.x, 0.0, sw2.y, 0.0)).xyz);
      }
      alb = ra; rou = rr; met = rm; bldSpecK = specK;
      if (skyE > 0.0) emi += vec3(1.0, 0.86, 0.66) * skyE * 0.6 * nightOn * step(0.25, uLit.z);
      // 夜间屋面：商场/写字楼/公建屋顶的采光天窗与设备灯、住宅楼梯间出屋面门灯（俯视夜景不再是死黑一片）。
      // 灯点远看小于像素时换成期望值（按覆盖率平均），远近一致不闪
      if (nightOn > 0.0) {
        bool comm = st == 2 || st == 3 || st == 4 || st == 7 || st == 8;
        float cs = comm ? 9.0 : 14.0;
        vec2 cq = wp / cs;
        vec2 ci2 = floor(cq);
        float lr2 = bRand(int(ci2.x) + 65536, int(ci2.y) + 65536, 97 + (sd & 255));
        float pOn = comm ? 0.24 * uLit.z : 0.12 * uLit.x;
        vec2 fq = (cq - ci2) * cs;
        vec2 sz2 = comm ? vec2(3.2, 1.6) : vec2(0.9, 0.9);
        vec2 o2 = vec2(1.2 + 3.0 * bRand(int(ci2.x), int(ci2.y), 98), 1.2 + 5.0 * bRand(int(ci2.y), int(ci2.x), 99)) * (comm ? 1.0 : 1.4);
        float spot = bRect(vec4(o2, o2 + sz2), fq, fwr) * step(lr2, pOn);
        float spotAvg = (sz2.x * sz2.y) / (cs * cs) * pOn;
        float fk = smoothstep(0.25, 0.9, max(fwr.x, fwr.y) / min(sz2.x, sz2.y));
        vec3 sc2 = comm ? vec3(1.0, 0.8, 0.56) : vec3(1.0, 0.76, 0.48);
        float I2 = comm ? 0.7 : 1.4;
        emi += sc2 * I2 * mix(spot, spotAvg, fk) * nightOn;
        // 城市天光：屋面被路灯与霓虹的散射微微染暖（极弱）
        emi += alb * vec3(1.0, 0.8, 0.6) * 0.035 * nightOn;
        // 远看（几公里外）：城区屋面一层很淡的暖色（路灯与亮窗的散射，成片城区不再是死黑；近处不加）
        emi += vec3(1.0, 0.72, 0.42) * 0.012 * nightOn * smoothstep(2500.0, 8000.0, length(cameraPosition - vWPos));
      }
    }
  }
  diffuseColor.rgb = alb * mix(1.0, ao, 0.5);
  diffuseColor.a = bldAlpha;
  roughnessFactor = rou;
  metalnessFactor = met;
  bldAO = ao;
  bldAOS = mix(1.0, ao, 0.7) * bldSpecK;
  bldEmis = emi;
  // ===== 分类高亮（专题图）：选中类别按类别色着色（屋面满色、立面保留少量细节），其余灰化 =====
  if (uClsOn > 0.5) {
    vec4 cc = uClsCol[clamp(int(vCls + 0.5), 0, 11)];
    float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    bool roofF = abs(Nw.y) >= 0.6;
    if (cc.a > 0.5) {
      vec3 tc = cc.rgb * (roofF ? 1.0 : 0.8) * (0.85 + 0.6 * lum);
      diffuseColor.rgb = mix(diffuseColor.rgb, tc, roofF ? 0.94 : 0.72);
      bldEmis = bldEmis * 0.35 + cc.rgb * (0.03 + 0.28 * uNight) * (roofF ? 1.0 : 0.7);
    } else {
      diffuseColor.rgb = vec3(0.1 + 0.35 * lum);
      bldEmis *= 0.08;
    }
    roughnessFactor = max(roughnessFactor, 0.75);
    metalnessFactor = 0.0;
  }
}
`;

/**
 * 建立远景 / 近景两套立面材质（共享 uniforms）
 * dataTex：THREE.DataTexture（RGBA32F，每栋 4 texel）
 */
export function createFacadeMaterials(ctx, dataTex) {
  const shared = {
    uBld: { value: dataTex },
    // 第二张数据纹理（默认 1×1 空纹理，buildings 模块建好后替换）
    uBld2: { value: createDataTexture2(new Float32Array(8), 1) },
    uDrawDist: { value: 16000 },
    uHiRect: { value: new THREE.Vector4(1e6, 1e6, -1e6, -1e6) },
    uLit: { value: new THREE.Vector4(0.6, 0.4, 0.8, 0) },
    // 分类高亮（专题图）：默认 1×1 空纹理，开启时由 buildings 模块填充
    uCls: { value: createClassTexture(new Uint8Array(1), 1, 1) },
    uClsOn: { value: 0 },
    uClsCol: { value: Array.from({ length: 12 }, () => new THREE.Vector4(0.6, 0.6, 0.6, 1)) },
    // 小区风貌参数（默认 1 texel 空纹理，buildings 模块加载 estates_style.json 后替换）
    uEst: { value: createEstateTexture(new Float32Array(4), 1) },
    // 立面细节档位（buildings 模块按画质设置：0 低 1 中 2 高/超高）
    uBDetail: { value: 2 },
  };
  const make = (hi, near = false) => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, flatShading: true });
    if (hi) m.defines = near ? { BLD_HI: '', BLD_NEAR: '' } : { BLD_HI: '' };
    // 近景细部：防盗窗铁栏、晾晒衣物按覆盖率镂空（MSAA 下 alpha-to-coverage，无 MSAA 时退化为二值）
    if (near) m.alphaToCoverage = true;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uBld = shared.uBld;
      shader.uniforms.uBld2 = shared.uBld2;
      shader.uniforms.uDrawDist = shared.uDrawDist;
      shader.uniforms.uHiRect = shared.uHiRect;
      shader.uniforms.uLit = shared.uLit;
      shader.uniforms.uCls = shared.uCls;
      shader.uniforms.uClsOn = shared.uClsOn;
      shader.uniforms.uClsCol = shared.uClsCol;
      shader.uniforms.uEst = shared.uEst;
      shader.uniforms.uBDetail = shared.uBDetail;
      shader.uniforms.uTime = ctx.uniforms.uTime;
      shader.uniforms.uNight = ctx.uniforms.uNight;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_PARS)
        .replace('#include <beginnormal_vertex>', VERT_NORMAL)
        .replace('#include <begin_vertex>', VERT_BEGIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
        .replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n' + SHADOW_PARS)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + FRAG_MAIN)
        .replace('#include <normal_fragment_maps>', '')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = bldEmis;')
        // 窗洞/阳台进深的自阴影（阴影贴图分辨不出 0.2~1.3 m 的凹进）：只压直射光，天光照常
        .replace('#include <lights_fragment_begin>', LIGHTS_BEGIN)
        .replace(
          '#include <aomap_fragment>',
          '#include <aomap_fragment>\nreflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, vec3(dot(reflectedLight.indirectDiffuse, vec3(0.2126, 0.7152, 0.0722))), 0.5) * bldAO * bldIndK;\nreflectedLight.indirectSpecular *= bldAOS;'
        );
    };
    m.customProgramCacheKey = () => (near ? 'xian-bld-near-v2' : hi ? 'xian-bld-hi-v7' : 'xian-bld-lo-v7');
    m.name = near ? '通用建筑立面（近景细部）' : hi ? '通用建筑立面（近景）' : '通用建筑立面（远景）';
    return m;
  };
  return { lo: make(false), hi: make(true), near: make(true, true), uniforms: shared };
}

/** 分类纹理（R8，每栋 1 texel，值为类别编号） */
export function createClassTexture(data, width, height) {
  const t = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** 小区风貌参数纹理（RGBA32F，宽 = style 数 × 4，高 1） */
export function createEstateTexture(data, width) {
  const t = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** 第二张数据纹理（RGBA32F，每栋 2 texel，宽 TEX2_W） */
export function createDataTexture2(arr, rows) {
  const w = rows > 1 || arr.length >= TEX2_W * 4 ? TEX2_W : arr.length / 4;
  const t = new THREE.DataTexture(arr, w, rows, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** 数据纹理（RGBA32F） */
export function createDataTexture(arr, rows) {
  const t = new THREE.DataTexture(arr, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
