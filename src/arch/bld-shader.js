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
//     平屋面卷材修补块、银色反光涂料，积灰屋面减弱间接高光（避免掠射角下整片泛天空蓝）
import * as THREE from 'three';
import { TEX_W } from './bld-gen.js';

const VERT_PARS = /* glsl */ `
#ifdef BLD_HI
  attribute vec4 aData;   // u(分米) 边长(分米) idLo idHi（idHi 高 8 位 = 附属构件类型 PART）
  attribute float aMeta;  // 0-7 外法线角 8-12 边序号 13 临街 14 女儿墙内侧
  flat varying float vPart;
#else
  attribute vec3 aData;   // u(分米) idLo idHi
#endif
uniform highp sampler2D uBld;
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
      // 商铺：货架色条
      float sh = step(0.5, fract(h.y * 2.2));
      col = mix(vec3(0.9), mix(vec3(0.85, 0.35, 0.2), vec3(0.2, 0.45, 0.8), step(0.5, fract(h.x * 0.7 + rnd * 5.0))), sh * step(h.y, y1 - 0.8) * 0.7);
    } else {
      col = mix(wallC, vec3(0.5), 0.3);
      if (h.y < y0 + 0.8) col *= 0.6;   // 工位隔板
    }
  } else if (t == ty) {
    if (rd.y > 0.0) {
      col = vec3(0.86);
      if (kind == 1) col += vec3(0.55) * bLines(h.x, 1.2, 0.6, 0.02) * bLines(h.z, 1.8, 0.6, 0.02);   // 办公格栅灯盘
    } else col = kind == 1 ? vec3(0.32, 0.33, 0.35) : mix(vec3(0.45, 0.32, 0.2), vec3(0.55, 0.53, 0.5), step(0.5, rnd));
  } else {
    col = wallC * 0.82;
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
float bldAO = 1.0;
float bldIndK = 0.8;   // 间接漫反射系数：核心同时有半球光与环境贴图，朝天的屋面会被“双重天光”染成青蓝色
float bldAOS = 1.0;
float bldSpecK = 1.0;  // 间接高光系数：积灰的平屋面掠射角下不应反出一片天空蓝
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
  // 楼顶亮化（约 1/3 的高层与写字楼）：顶部 1.5 层泛光 + 女儿墙顶轮廓灯带；远近景一致，夜景天际线有层次
  bool crownLit = !estF && uBDetail > 0.5 && (st == 0 || st == 2 || st == 3 || st == 8) && H >= 45.0 && bRand(sd, 61, 3) < 0.36;
  float crR = bRand(sd, 62, 3);
  vec3 crownC = crR < 0.5 ? vec3(1.0, 0.7, 0.34) : crR < 0.78 ? vec3(0.78, 0.86, 1.0) : crR < 0.9 ? vec3(0.3, 0.5, 1.0) : vec3(0.95, 0.32, 0.55);
  wallC *= estF ? (0.95 + 0.1 * bRand(sd, 3, 1)) * (oldB ? 0.93 : 1.0) : (0.86 + 0.24 * bRand(sd, 3, 1)) * (oldB ? 0.9 : 1.0);   // 每栋明度差异 + 老楼积灰（同一小区同一涂料，差异小）
  eTrim *= 0.72; eBaseC *= 0.66; eCrownC *= 0.66; eBandC *= 0.72; eAcc2 *= 0.7;
  float u = vFac.x;
  float v = vWPos.y - gA;
  vec3 Nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 Vw = normalize(cameraPosition - vWPos);
  vec3 alb = wallC; float rou = 0.86; float met = 0.0; vec3 nT = vec3(0.0, 0.0, 1.0); float ao = 1.0;
  vec3 emi = vec3(0.0);
  float nightOn = uLit.w;
  int litCls = (st == 2 || st == 3 || st == 7) ? 1 : (st == 4 ? 2 : 0);
  float litP = (litCls == 0 ? uLit.x : litCls == 1 ? uLit.y : uLit.z) * (0.55 + 0.9 * bRand(sd, 9, 1));

  if (abs(Nw.y) < 0.6) {
    // ================= 外墙 =================
    vec3 Nh = normalize(vec3(Nw.x, 0.0, Nw.z));
    vec3 Tt = vec3(-Nh.z, 0.0, Nh.x);
    vec3 Vt = vec3(dot(Vw, Tt), Vw.y, dot(Vw, Nh));
    vec2 fwp = vec2(length(vec2(dFdx(u), dFdy(u))), length(vec2(dFdx(v), dFdy(v)))) + 1e-4;
    bool south = Nh.z > 0.4;
    float r0 = bRand(sd, 1, 0);

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

    // —— 楼层 ——
    float roofV = H - ph;
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
    float jDet = 1.0 - smoothstep(0.012, 0.04, max(fwp.x, fwp.y));
    if (estF && brick) {
      // 小区砖墙：红砖面砖为浅灰勾缝，青砖为深灰勾缝（240×53 顺砖错缝）
      float row = floor(v / 0.063);
      float bu = u + mod(row, 2.0) * 0.125;
      float jh = bLines(v, 0.063, 0.01, fwp.y);
      float jv = bLines(bu, 0.25, 0.01, fwp.x) * (1.0 - jh);
      float bc = bRand(int(floor(bu / 0.25)) + 65536, int(row) + 65536, 5);
      alb *= mix(1.0, 0.86 + 0.28 * bc, jDet);
      bool redB = wallC.r > 1.3 * wallC.b;
      alb = mix(alb, redB ? vec3(0.42, 0.4, 0.37) : wallC * 0.62, (jh + jv) * 0.8 * (0.35 + 0.65 * jDet));
      nT.y += (jh * 2.0 - bLines(v - 0.012, 0.063, 0.01, fwp.y)) * 0.22 * jDet;
      rou = 0.9;
    } else if (st == 9 || brick) {
      // 砖：240×53 mm 顺砖错缝，10 mm 灰缝
      float row = floor(v / 0.063);
      float bu = u + mod(row, 2.0) * 0.125;
      float jh = bLines(v, 0.063, 0.011, fwp.y);
      float jv = bLines(bu, 0.25, 0.011, fwp.x) * (1.0 - jh);
      float bc = bRand(int(floor(bu / 0.25)) + 65536, int(row) + 65536, 5);
      alb *= mix(1.0, 0.82 + 0.36 * bc, jDet);
      alb = mix(alb, (st == 9 ? vec3(0.42, 0.41, 0.39) : vec3(0.5, 0.47, 0.43)), (jh + jv) * 0.85);
      nT.y += (jh * 2.0 - bLines(v - 0.012, 0.063, 0.011, fwp.y)) * 0.25 * jDet;
      rou = 0.92;
    } else if (tile) {
      // 外墙面砖 240×60
      float jh = bLines(v, 0.065, 0.006, fwp.y);
      float jv = bLines(u + mod(floor(v / 0.065), 2.0) * 0.12, 0.24, 0.006, fwp.x);
      alb = mix(alb, alb * 0.72, max(jh, jv) * 0.9);
      rou = 0.55;
    } else if (st == 3 || st == 8 || (st == 4 && (variant & 1) == 1) || stoneF) {
      // 石材幕墙 1.2×0.6 分格
      float jh = bLines(v, 0.6, 0.012, fwp.y);
      float jv = bLines(u, 1.2, 0.012, fwp.x);
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
      if ((variant & 2) != 0 && v > roofV - 2.0 * fh) alb = accC * (0.92 + 0.12 * wn);
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
    // 楼板线、勒脚、女儿墙压顶带
    if (st == 0 || st == 1 || st == 5 || st == 7 || st == 8) alb *= 1.0 - 0.07 * bPulse(0.0, 0.16, fy, fwp.y) * float(fi > 0);
    if (st == 1 && brick) alb = mix(alb, vec3(0.5, 0.49, 0.46) * (0.9 + 0.2 * wn), bPulse(fh - 0.42, fh, fy, fwp.y) * float(fi > 0 || gf > 2.0));   // 圈梁
    if (v < 0.45) { alb = mix(alb, vec3(0.3, 0.29, 0.28), 0.65); rou = 0.8; }
    if (v > roofV - 0.05) { alb = mix(alb, estF ? (eSch == 2 || eSch == 4 ? eTrim : alb * 1.06) : (st == 0 ? accC : alb * 1.08), 0.7); }
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
    float streakN = bNoise(vec2(u * 1.3, 3.0));
    alb *= 1.0 - (oldB ? 0.16 : 0.08) * smoothstep(3.5, 0.0, roofV - v) * streakN;

    // —— 远近过渡 ——
    float detail = 1.0 - smoothstep(0.3, 0.85, max(fwp.x / max(bw, 0.5), fwp.y / max(fH, 0.5)));
    float nearK = 1.0 - smoothstep(0.035, 0.1, max(fwp.x, fwp.y));
    // 住宅按“户”（两开间 × 一层）成组亮灯，比逐窗随机更像真实的万家灯火；其他按窗
    int kHouse = (litCls == 0 && (st == 0 || st == 1 || st == 5)) ? ((bi >> 1) + 997 * eIdx) * 131 + fi : kWin;
    // 老式多层北向单元入口（与 bld-gen.js facadeParts 的入口雨棚同一规则）：首层单元门，以上楼梯间半层窗
    bool entBay = false;
#ifdef BLD_HI
    entBay = st == 1 && !estF && Nh.z < -0.4 && !eStreet && nb >= 4.0 && (bi % 4) == 1 + (variant & 1) && bPart == 0;
#endif

    // ===== 近景附属构件（体块由 bld-gen.js facadeParts 生成，这里画楼层内细节） =====
    bool partDone = bPart > 0;
    float wfO = -1.0;   // 远看时玻璃面积占比（附属构件自定）
    if (bPart == 1 || bPart == 2 || bPart == 6 || bPart == 7) {
      // —— 凸阳台（1 正面 2 侧面）/ 凸窗（6 正面 7 侧面）：楼板线 + 栏板/窗台 + 通长玻璃（竖梃）+ 转角立框；老楼有敞开晾晒户与低层防盗笼 ——
      bool pSide = bPart == 2 || bPart == 7, pBay = bPart >= 6;
      float fLen = vFac.y;
      float x0 = pSide ? 0.0 : (pBay ? 0.45 : 0.1), x1 = pSide ? fLen : bw - x0;
      float sx = pSide ? u : bx;
      // 侧面：用面起点（世界坐标，整面恒定）做户哈希
      vec2 fs0 = vWPos.xz - Tt.xz * u;
      int kS = pSide ? (fi * 131 + int(floor(dot(fs0, vec2(0.37, 0.71)) + 0.5)) + 997 * eIdx) : kHouse;
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
      vec3 lampH = rc < 0.45 ? vec3(1.0, 0.62, 0.3) : rc < 0.62 ? vec3(1.0, 0.8, 0.55) : vec3(0.8, 0.88, 1.0);
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
          ga = (glassT * 0.35 + 0.01) * (0.8 + 0.4 * pv); gr = 0.04 + 0.08 * pv; gm = 0.0;
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
    }

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
        et = 4; wr = vec4(0.12, 0.25, bw - 0.12, gf - 1.1); et2 = 12; wr2 = vec4(0.0, gf - 0.95, bw, gf - 0.2);
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
        if (eStreet) { et = 4; wr = vec4(0.12, 0.25, bw - 0.12, gf - 1.1); et2 = 12; wr2 = vec4(0.0, gf - 0.95, bw, gf - 0.2); }
        else { et = 1; wr = vec4(cx - 0.9, 0.9, cx + 0.9, min(2.6, gf - 0.4)); }
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
        et = rb < 0.55 ? 4 : 7; wr = vec4(0.2, 0.0, bw - 0.2, min(gf - 0.35, 2.9));
        if (gf > 3.3) { et2 = 12; wr2 = vec4(0.0, gf - 0.3 - 0.6, bw, gf - 0.2); }
      } else if (entBay) {
        if (fi == 0) { et = 13; wr = vec4(cx - 0.62, 0.0, cx + 0.62, min(2.35, gf - 0.3)); }        // 单元门（上方有雨棚）
        else { et = 1; eyo = 0.5 * fH; wr = vec4(cx - 0.5, 0.95, cx + 0.5, 1.95); }                 // 楼梯间半层窗
      } else if (rb < 0.13) {
        et = 1; eyo = 0.5 * fH; wr = vec4(cx - 0.5, 0.95, cx + 0.5, 1.95);   // 楼梯间半层错位窗
      } else if (south && rb < 0.55) {
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
      if (fi == 0) { et = 4; wr = vec4(0.1, 0.25, bw - 0.1, gf - 1.35); et2 = 12; wr2 = vec4(0.0, gf - 1.2, bw, gf - 0.2); }
      else {
        float rg = bRand(sd, bi / 2 + 997 * eIdx, 21);
        if (rg < 0.2 && roofV > gf + 4.0) { et = 6; ey = v; wr = vec4(0.35, gf + 0.7, bw - 0.35, roofV - 0.9); }
        else if (rg < 0.68) { et = 5; wr = vec4(0.08, 0.8, bw - 0.08, fH - 0.6); }
        else { et = 1; wr = vec4(cx - 1.1, 1.0, cx + 1.1, fH - 1.1); }
      }
    } else if (st == 5) {
      if (fi == 0 && (eStreet || rb < 0.45)) {
        et = bRand(sd, kWin, 4) < 0.3 ? 4 : 7; wr = vec4(0.25, 0.0, bw - 0.25, min(3.0, gf - 0.3));
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
    } else {
      et = 1; wr = vec4(cx - 0.7, 1.0, cx + 0.7, min(fH - 0.6, 2.6));
    }
    if (eyo > 0.0) ey = mod(fy + eyo, fH);
    vec2 p = vec2(bx, ey);
    vec2 p2 = vec2(bx, fy);

    // 雨水污渍：窗台下方
    if (et == 1 && oldB) {
      float sx = bPulse(wr.x, wr.z, bx, fwp.x);
      alb *= 1.0 - 0.1 * sx * smoothstep(1.6, 0.0, wr.y - ey) * step(ey, wr.y) * bNoise(vec2(u * 4.0, 1.0));
    }

    // 窗户亮灯与灯色（住宅按户成组；办公按“楼层×工位组”）
    float lr = litCls == 1 ? bRand(sd, fi * 64 + bi / 5 + 997 * eIdx, 29) : bRand(sd, kHouse, 29);
    bool lit = lr < litP;
    // 楼梯间半层窗：声控灯，与住户作息无关、亮度低
    bool stairW = eyo > 0.0;
    if (stairW) lit = bRand(sd, kWin, 57) < 0.34;
    float rc = bRand(sd, litCls == 0 ? kHouse : kWin, 31);
    vec3 lampC;
    // 灯色：住宅暖白（白炽/3000K）与冷白（LED 吸顶灯 6500K）混杂，少量彩色氛围灯；办公以冷白为主
    if (litCls == 1) lampC = rc < 0.7 ? vec3(0.78, 0.88, 1.0) : vec3(1.0, 0.86, 0.66);
    else lampC = rc < 0.45 ? vec3(1.0, 0.62, 0.3) : rc < 0.62 ? vec3(1.0, 0.8, 0.55) : rc < 0.95 ? vec3(0.8, 0.88, 1.0) : rc < 0.975 ? vec3(1.0, 0.4, 0.6) : vec3(0.55, 0.45, 1.0);
    float lampI = (litCls == 1 ? 0.58 : 0.9) * (0.6 + 0.7 * bRand(sd, kWin, 33)) * nightOn;
    if (stairW) { lampC = rc < 0.6 ? vec3(0.95, 0.88, 0.7) : vec3(0.85, 0.9, 1.0); lampI = 0.45 * nightOn; }
    float curtain = bRand(sd, kWin, 35);
    vec3 curtainC = curtain < 0.15 ? vec3(0.85, 0.8, 0.68) : curtain < 0.25 ? vec3(0.9, 0.9, 0.88) : curtain < 0.3 ? vec3(0.75, 0.3, 0.25) : vec3(0.7, 0.75, 0.8);
    vec3 frameC = st == 2 ? wallC : (st == 9 ? vec3(0.28, 0.09, 0.06) : (oldB ? vec3(0.7, 0.7, 0.68) : (st == 0 && (variant & 1) == 1 ? vec3(0.85, 0.85, 0.83) : vec3(0.32, 0.33, 0.34))));
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
      vec2 ws = wr.zw - wr.xy;
      bool glassy = et == 1 || et == 2 || et == 4 || et == 5 || et == 9 || et == 11;
      if (et == 3) {
        // 空调百叶（与主构件共用时作为主构件出现的情况很少）
        s.alb = accC;
      } else if (et == 6) {
        // 广告位：两色分块 + 夜间内透光
        float r1 = bRand(sd, bi / 2 + 997 * eIdx, 41), r2 = bRand(sd, bi / 2 + 997 * eIdx, 43);
        vec2 lq = (p - wr.xy) / ws;
        vec3 ca = bPalette(r1) * 0.8, cb = mix(bPalette(r2), vec3(0.75, 0.7, 0.62), 0.45);
        float img = bNoise(lq * vec2(3.0, 5.0) + r1 * 40.0) * 0.6 + bNoise(lq * vec2(9.0, 14.0) + r2 * 30.0) * 0.4;
        vec3 ad = mix(ca, cb, smoothstep(0.25, 0.85, lq.y + (img - 0.5) * 0.5));
        ad *= 0.75 + 0.5 * img * detail;
        ad = mix(ad, vec3(0.8), bRect(vec4(0.08, 0.1, 0.62, 0.17), lq, fwp / ws) * 0.85 * detail);
        ad = mix(ad, vec3(0.85, 0.75, 0.3), bRect(vec4(0.08, 0.2, 0.4, 0.24), lq, fwp / ws) * 0.7 * detail);
        float fr = 1.0 - bRect(vec4(0.012, 0.01, 0.988, 0.99), lq, fwp / ws);
        s.alb = mix(ad, vec3(0.2), fr); s.rou = 0.4; s.met = 0.0;
        s.emi = ad * (1.0 - fr) * 1.0 * nightOn * step(0.25, uLit.z);
      } else if (et == 7) {
        // 卷帘门：横向肋
        float rib = sin(p.y / 0.09 * 6.2831853);
        float rk = 1.0 - smoothstep(0.015, 0.05, fwp.y);
        s.alb = vec3(0.55, 0.56, 0.57) * (0.92 + 0.08 * rib * rk) * (0.85 + 0.2 * wn);
        s.nT = normalize(vec3(0.0, rib * 0.45 * rk, 1.0));
        s.rou = 0.45; s.met = 0.55;
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
        if (estF && et == 9 && p.y < 0.95) {
          // 小区：封闭凸阳台下部实心栏板（老式住宅常刷点缀色，如太白小区红褐色）
          vec3 sp = eSch == 5 ? accC : mix(wallC * 1.05, eTrim, (eFl & 1) != 0 ? 0.6 : 0.0);
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
          // 框料：外框 + 中梃/横档
          float fwid = et == 5 ? 0.05 : (et == 4 ? 0.07 : 0.06);
          float inner = bRect(vec4(fwid, fwid, ws.x - fwid, ws.y - fwid), lq, fwp);
          float mull = 0.0;
          if (et == 1) {
            if (ws.x > 1.1) mull = max(mull, bPulse(ws.x * 0.5 - 0.03, ws.x * 0.5 + 0.03, lq.x, fwp.x));
            if (ws.y > 1.6) mull = max(mull, bPulse(ws.y * 0.72 - 0.03, ws.y * 0.72 + 0.03, lq.y, fwp.y));
          } else if (et == 4) {
            mull = max(bLines(lq.x, 2.0, 0.07, fwp.x), bPulse(ws.y - 0.9, ws.y - 0.83, lq.y, fwp.y));
          } else if (et == 9) {
            mull = max(bLines(lq.x, 0.62, 0.05, fwp.x), bPulse(0.9, 0.96, lq.y, fwp.y));
          } else if (et == 2) {
            mull = max(bLines(lq.x, 0.9, 0.05, fwp.x), bPulse(ws.y - 0.5, ws.y - 0.45, lq.y, fwp.y));
          } else if (et == 11) {
            mull = bLines(lq.x, 1.5, 0.08, fwp.x);
          }
          float frameM = max(1.0 - inner, mull);
          // 玻璃
          vec3 gAlb; float gRou, gMet;
          bool reflective = et == 5 || (et == 4 && (st == 2 || st == 3));
          if (reflective) { gAlb = glassT * 0.9; gRou = 0.05; gMet = 0.7; }
          else if (et == 11) { gAlb = vec3(0.62, 0.66, 0.66); gRou = 0.35; gMet = 0.0; }
          else { gAlb = glassT * 0.35 + 0.01; gRou = 0.05; gMet = 0.0; }
          float F = 0.04 + 0.96 * pow(1.0 - clamp(Vt.z, 0.0, 1.0), 5.0);
          // 室内
          vec3 inAlb = et == 4 ? vec3(0.55) : vec3(0.22);
          float lampK = 0.8;
          int ik = et == 4 ? 2 : (litCls == 1 ? 1 : 0);
#ifdef BLD_HI
          if (nearK > 0.0 && et != 11) {
            float D = et == 4 ? 7.0 : (litCls == 1 ? 9.0 : 3.8 + 2.0 * bRand(sd, kWin, 37));
            vec3 ia = bInterior(lq, ws, wr.y - (et == 2 ? 0.0 : 0.0), fH, D, -Vt, bRand(sd, kWin, 39), ik, lampK);
            inAlb = mix(inAlb, ia, nearK);
          }
#endif
          // 窗帘（住宅、酒店）
          if (ik == 0 && et != 11 && curtain < 0.55) {
            float fold = 0.88 + 0.12 * sin(lq.x * 24.0) * (1.0 - smoothstep(0.01, 0.04, fwp.x));
            float cov = curtain < 0.35 ? 1.0 : (1.0 - bPulse(ws.x * 0.25, ws.x * 0.75, lq.x, fwp.x));
            inAlb = mix(inAlb, curtainC * fold, cov);
            lampK = mix(lampK, 0.62, cov);
          }
          float trans = (1.0 - F) * (reflective ? 0.35 : 1.0);
          vec3 dayIn = inAlb * (et == 4 ? 0.25 : 0.045) * (1.0 - uNight);
          vec3 nightIn = vec3(0.0);
          if (et == 4) {
            float shopOn = step(bRand(sd, kWin, 45), uLit.z * 1.1);
            float shopK = 0.55 + 0.6 * bRand(sd, kWin, 47);
            vec3 shopC = bRand(sd, kWin, 49) < 0.7 ? vec3(1.0, 0.84, 0.62) : vec3(0.85, 0.92, 1.0);
            nightIn = inAlb * shopC * 0.5 * shopK * lampK * shopOn * nightOn;
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
        vec3 lc = (variant & 1) == 1 ? vec3(0.82, 0.82, 0.8) : accC;
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
        // 门头招牌带：底色 + “字块” + 夜间发光
        int shop = bi / 2 + 997 * eIdx;
        float r1 = bRand(sd, shop, 51);
        vec3 bc = bPalette(r1);
        float gx = bLines(lq.x, 1.05, 0.72, fwp.x) * bPulse(ws.y * 0.22, ws.y * 0.78, lq.y, fwp.y) * step(bRand(sd, shop, 53), 0.75);
        vec3 tc = r1 > 0.68 && r1 < 0.82 ? vec3(0.7, 0.08, 0.05) : vec3(0.95, 0.9, 0.75);
        a2 = mix(bc, tc, gx * 0.9 * (0.35 + 0.65 * detail));
        r2 = 0.45; m2 = 0.0;
        float on = step(bRand(sd, shop, 55), uLit.z * 1.2) * nightOn;
        e2 = (bc * 0.45 + tc * gx * 1.5) * 1.0 * on;
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
    vec3 aAvg = mix(alb, gAvg, wf);
    float rAvg = mix(rou, st == 2 ? 0.12 : 0.3, wf);
    float mAvg = mix(met, (st == 2 || st == 3) ? 0.55 : 0.0, wf);
    vec3 lampAvg = litCls == 1 ? vec3(0.86, 0.92, 1.0) : vec3(1.0, 0.76, 0.5);
    float iAvg = litCls == 1 ? 0.5 : 0.45;
    // 远看：亮窗按“每层 × 约 3 开间”成组亮灭（矩形块，不是整面墙均匀发光）；块小于约 1 像素时换成期望值（防闪烁）
    float cellW = litCls == 1 ? bw * 9.0 : bw * 3.0, cellH = max(fh, 2.5);   // 办公按半层成片亮
    float litPatch = step(bRand(sd, int(floor(u / cellW)) + 4096, int(floor(max(v, 0.0) / cellH)) + 77), litP * 0.8);
    litPatch *= 1.0 - 0.8 * bLines(v, cellH, 0.7, fwp.y);   // 楼板遮挡
    litPatch = mix(litPatch, min(litP, 1.0) * 0.5, smoothstep(0.45, 1.2, max(fwp.y / cellH, fwp.x / cellW)));
    vec3 eAvg = lampAvg * wf * iAvg * nightOn * litPatch * 0.45;
    if (st == 4 || street) eAvg += vec3(1.0, 0.8, 0.6) * 0.22 * uLit.z * nightOn * (1.0 - smoothstep(gf - 0.5, gf + 0.5, v)) * float(v > 0.0);
    if (!inBay && detail < 1.0 && wfO < 0.0) { aAvg = alb; eAvg *= 0.0; }
    alb = mix(aAvg, alb, detail);
    rou = mix(rAvg, rou, detail);
    met = mix(mAvg, met, detail);
    emi = mix(eAvg, emi, detail);
    nT = normalize(mix(vec3(0.0, 0.0, 1.0), nT, detail));

    // 夜间墙面：底部路灯/店招反射 + 城市天光（很弱，只为勾出体量）
    emi += alb * (vec3(1.0, 0.78, 0.55) * 0.05 * exp(-max(v, 0.0) / 14.0) + vec3(0.55, 0.6, 0.75) * 0.012) * nightOn;
    // 楼顶亮化：顶部约 1.5 层向上渐强的泛光 + 女儿墙顶轮廓灯带（构架一起亮）
    if (crownLit && nightOn > 0.0) {
      float kc = smoothstep(roofV - 1.6 * fh, H + 0.05, v);
      float strip = bPulse(H - 0.3, H + 0.02, v, fwp.y) * float(bPart == 0);
      emi += crownC * nightOn * (kc * kc * (bPart == 4 ? 0.8 : 0.45) + strip * 2.0);
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
    if (bPart > 0) {
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
      // 挑檐 / 檐口底面
      alb = (estF ? mix(wallC, eTrim, 0.4) : vec3(0.3)) * 0.7; rou = 0.9;
    } else if (pitched && v > H - 0.1) {
      // ===== 坡屋面（小区 + 通用平改坡）：红/橙色为筒瓦（纵向瓦垄），灰色为平瓦（错缝），颜色取卫星逐栋取样、照片目测或平改坡色库 =====
      float sinS = length(Nw.xz);
      vec2 T = sinS > 0.05 ? normalize(vec2(-Nw.z, Nw.x)) : vec2(1.0, 0.0);
      float tu = dot(wp, T);
      float sv = (v - H) / max(sinS, 0.25);
      vec2 fwt = vec2(length(vec2(dFdx(tu), dFdy(tu))), length(vec2(dFdx(sv), dFdy(sv)))) + 1e-4;
      float det = 1.0 - smoothstep(0.015, 0.07, max(fwt.x, fwt.y));
      bool clay = roofTile.r > roofTile.b * 1.5 || !est;   // 通用平改坡 / 城内仿古一律按筒瓦（纵向瓦垄）
      float tid = bRand(int(floor(tu / 0.25)) + 65536, int(floor(sv / 0.3)) + 65536, 13);
      alb = roofTile * 0.62 * (0.88 + 0.18 * tid * det + 0.12 * rn);
      alb *= 1.0 - 0.32 * bLines(sv, 0.3, 0.05, fwt.y) * det;
      if (clay) {
        float rid = cos(tu / 0.25 * 6.2831853);
        alb *= 1.0 + 0.14 * rid * det;
        vec3 tw = vec3(T.x, 0.0, T.y) * sin(tu / 0.25 * 6.2831853) * 0.35 * det;
        normal = normalize(normal + (viewMatrix * vec4(tw, 0.0)).xyz);
        rou = 0.72;
      } else {
        float jv = bLines(tu + mod(floor(sv / 0.3), 2.0) * 0.15, 0.3, 0.025, fwt.x);
        alb *= 1.0 - 0.25 * jv * det;
        rou = 0.62;
      }
      alb *= 1.0 - 0.12 * smoothstep(0.55, 0.85, bNoise(wp * 0.13 + 11.0));   // 积灰/雨渍
    } else if (coping) {
      alb = mix(wallC, vec3(0.42, 0.41, 0.39), 0.55) * (0.9 + 0.2 * rn); rou = 0.8;
    } else {
      float rt = bRand(sd, 5, 1);
      vec3 rc;
      // 屋面：沥青卷材/水泥砂浆/彩钢板/绿色防水涂料（线性反照率）
      if (st == 6) rc = rt < 0.5 ? vec3(0.2, 0.3, 0.42) : rt < 0.8 ? vec3(0.42, 0.44, 0.45) : vec3(0.3, 0.12, 0.09);
      else if (oldB) rc = rt < 0.45 ? vec3(0.1, 0.1, 0.1) : rt < 0.8 ? vec3(0.2, 0.19, 0.18) : vec3(0.14, 0.17, 0.15);
      else rc = rt < 0.45 ? vec3(0.24, 0.235, 0.22) : rt < 0.7 ? vec3(0.16, 0.16, 0.17) : rt < 0.85 ? vec3(0.3, 0.29, 0.27) : vec3(0.12, 0.2, 0.15);
      // 老楼约 1/5 刷银色反光防水涂料（西安老旧小区屋面常见）
      bool silver = oldB && st != 6 && bRand(sd, 6, 1) < 0.2;
      if (silver) rc = vec3(0.36, 0.37, 0.38);
      alb = rc * (0.82 + 0.3 * rn);
      rou = silver ? 0.55 : 0.9;
      met = silver ? 0.2 : 0.0;
      // 积灰的平屋面：掠射角下不反出整片天空（间接高光减弱）
      bldSpecK = silver ? 0.75 : 0.42;
      // 屋面分格缝 / 彩钢板肋
      float jd = 1.0 - smoothstep(0.02, 0.08, max(fwr.x, fwr.y));
      if (st == 6) {
        alb *= 1.0 - 0.18 * bLines(wp.x + wp.y, 1.0, 0.2, max(fwr.x, fwr.y) * 1.4);
        rou = 0.5; met = 0.3; bldSpecK = 1.0;
      } else if (rt < 0.45 || rt > 0.7) {
        float jg = max(bLines(wp.x, 1.0, 0.02, fwr.x), bLines(wp.y, 1.0, 0.02, fwr.y));
        alb *= 1.0 - 0.3 * jg;
      }
      if (st != 6) {
        // 卷材修补块（新旧色差，1~3 m 的矩形）+ 搭接缝
        float pc = bRand(int(floor(wp.x / 2.3)) + 65536, int(floor(wp.y / 1.5)) + 65536, sd & 1023);
        float pk = 1.0 - smoothstep(0.6, 1.6, max(fwr.x, fwr.y));
        alb *= mix(1.0, pc < 0.16 ? 0.62 : pc > 0.9 ? 1.28 : 1.0, pk);
        alb *= 1.0 - 0.12 * bLines(wp.y + 0.3 * float(sd & 7), 1.0, 0.05, fwr.y) * jd * float(oldB);
      }
      // 积水 / 污斑
      alb *= 1.0 - 0.15 * smoothstep(0.55, 0.8, bNoise(wp * 0.09 + 30.0));
    }
  }
  diffuseColor.rgb = alb * mix(1.0, ao, 0.5);
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
  const make = (hi) => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, flatShading: true });
    if (hi) m.defines = { BLD_HI: '' };
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uBld = shared.uBld;
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
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + FRAG_MAIN)
        .replace('#include <normal_fragment_maps>', '')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = bldEmis;')
        .replace(
          '#include <aomap_fragment>',
          '#include <aomap_fragment>\nreflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, vec3(dot(reflectedLight.indirectDiffuse, vec3(0.2126, 0.7152, 0.0722))), 0.5) * bldAO * bldIndK;\nreflectedLight.indirectSpecular *= bldAOS;'
        );
    };
    m.customProgramCacheKey = () => (hi ? 'xian-bld-hi-v4' : 'xian-bld-lo-v4');
    m.name = hi ? '通用建筑立面（近景）' : '通用建筑立面（远景）';
    return m;
  };
  return { lo: make(false), hi: make(true), uniforms: shared };
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

/** 数据纹理（RGBA32F） */
export function createDataTexture(arr, rows) {
  const t = new THREE.DataTexture(arr, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
