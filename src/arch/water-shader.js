// 水面材质：基于 MeshStandardMaterial（自动获得 scene.environment 的 IBL 菲涅尔反射、太阳 GGX 高光、阴影、
// 高度雾、对数深度）+ onBeforeCompile 注入：
//   · 程序化法线：6 个方向波（Gerstner 斜率近似）+ 3 层随水流滚动的值噪声（解析导数），远处降幅防闪烁
//   · 分水体着色：按顶点 aWater.y（水体类型）取浅水/深水色，aWater.x = 离岸距离（米）做深浅过渡、岸边淡化、泡沫
//   · 渭河含沙水体的泥沙条纹与浅滩；泾渭交汇处按 aWater.z（泾河清水羽流）混合，并用噪声扰动界面 —— “泾渭分明”
//   · 夜间：城市灯光在水面的竖向拉长倒影（以相机为中心的放射状光带 + 波纹破碎），aWater.w = 城市化程度
import * as THREE from 'three';

// 类型表：0 渭河 1 泾河 2 其他河流（灞/浐/沣…） 3 护城河 4 城市湖泊 5 水库/大湖 6 池塘/调蓄池 7 小河/渠
// deep/shallow 为漫反射色（sRGB 十六进制）；param = [深水过渡距离 m, 泡沫带宽 m, 波浪强度, 流速 m/s]
export const WATER_TYPES = [
  { deep: '#5d5441', shallow: '#8f7f60', param: [70, 3.2, 1.0, 1.1] }, // 渭河：黄褐含沙
  { deep: '#34463f', shallow: '#56695d', param: [45, 2.2, 0.85, 0.9] }, // 泾河：较清，青灰
  { deep: '#384841', shallow: '#5b6a5a', param: [35, 1.8, 0.8, 0.7] }, // 灞浐沣等
  { deep: '#2b3a26', shallow: '#46553a', param: [9, 0.0, 0.35, 0.05] }, // 护城河：墨绿
  { deep: '#27402f', shallow: '#4b6149', param: [26, 0.6, 0.5, 0.05] }, // 城市湖泊：偏绿
  { deep: '#203a41', shallow: '#40605a', param: [60, 0.8, 0.75, 0.05] }, // 水库/大湖：蓝绿
  { deep: '#2f3f2a', shallow: '#4f5b3c', param: [10, 0.0, 0.3, 0.02] }, // 池塘
  { deep: '#3a4a40', shallow: '#5a6655', param: [5, 0.6, 0.6, 0.6] }, // 小河/渠
];

export function createWaterMaterial(ctx, { level = 2 } = {}) {
  const deep = WATER_TYPES.map((t) => new THREE.Color(t.deep));
  const shallow = WATER_TYPES.map((t) => new THREE.Color(t.shallow));
  const param = WATER_TYPES.map((t) => new THREE.Vector4(...t.param));
  const U = {
    uTime: ctx.uniforms.uTime,
    uNight: ctx.uniforms.uNight,
    uReflBoost: { value: 0.62 },
    uDeep: { value: deep },
    uShallow: { value: shallow },
    uParam: { value: param },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.05,
    metalness: 0.0,
    transparent: true,
    depthWrite: true,
    fog: true,
  });
  mat.name = 'water-surface';
  mat.userData.uniforms = U;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.defines = shader.defines || {};
    shader.defines.WATER_Q = level;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aWater;
attribute vec2 aFlow;
varying vec3 vWPos;
varying vec4 vWater;
varying vec2 vFlow;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vWater = aWater; vFlow = aFlow;
vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uNight;
uniform float uReflBoost;
uniform vec3 uDeep[8];
uniform vec3 uShallow[8];
uniform vec4 uParam[8];
varying vec3 vWPos;
varying vec4 vWater;
varying vec2 vFlow;
float wHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
// 值噪声 + 解析导数（x = 值，yz = 梯度）
vec3 wNoised( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  vec2 du = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );
  float a = wHash( i ), b = wHash( i + vec2( 1.0, 0.0 ) ), c = wHash( i + vec2( 0.0, 1.0 ) ), d = wHash( i + vec2( 1.0, 1.0 ) );
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3( a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2( k1 + k4 * u.y, k2 + k4 * u.x ) );
}
float wNoise( vec2 p ) { return wNoised( p ).x; }
// 水面高度梯度（dh/dx, dh/dz）
vec2 wWaves( vec2 p, vec2 flow, float t, float amp, float far ) {
  vec2 g = vec2( 0.0 );
  vec2 fd = length( flow ) > 1e-3 ? normalize( flow ) : vec2( 0.8, 0.6 );
  float spd = length( flow );
  // 方向波：围绕“风向/流向”散布，波数 0.3~2.3 rad/m（波长 2.7~21 m）
  for ( int i = 0; i < 6; i ++ ) {
    float fi = float( i );
    float ang = atan( fd.y, fd.x ) + ( fi - 2.5 ) * 0.55 + sin( fi * 3.7 ) * 0.3;
    vec2 d = vec2( cos( ang ), sin( ang ) );
    float k = 0.3 * pow( 1.5, fi );
    float w = sqrt( 9.81 * k );
    float a = 0.045 / pow( 1.45, fi ) * ( 1.0 - far * smoothstep( 1.0, 4.0, fi ) );
    g += d * ( a * k * cos( dot( d, p ) * k - w * t + fi * 1.7 ) );
  }
  // 随流滚动的噪声（湍流纹理）
  vec2 drift = flow * t;
  vec3 n1 = wNoised( ( p - drift ) * 0.18 );
  g += n1.yz * 0.18 * 0.35;
  vec3 n2 = wNoised( ( p - drift * 1.3 ) * 0.55 + vec2( t * 0.07, -t * 0.05 ) );
  g += n2.yz * 0.55 * 0.06 * ( 1.0 - far * 0.7 );
#if WATER_Q >= 2
  vec3 n3 = wNoised( ( p - drift * 1.6 ) * 1.7 + vec2( -t * 0.21, t * 0.17 ) );
  g += n3.yz * 1.7 * 0.012 * ( 1.0 - far );
#endif
  return g * amp * ( 0.6 + 0.4 * min( spd, 1.0 ) + 0.25 );
}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
int wType = int( vWater.y + 0.5 );
vec3 wDeepC = uDeep[ 0 ], wShalC = uShallow[ 0 ]; vec4 wPrm = uParam[ 0 ];
for ( int i = 1; i < 8; i ++ ) if ( i == wType ) { wDeepC = uDeep[ i ]; wShalC = uShallow[ i ]; wPrm = uParam[ i ]; }
float wDist = length( vWPos - cameraPosition );
float wFar = smoothstep( 250.0, 3500.0, wDist );
float wD = vWater.x;
vec2 wP = vWPos.xz;
vec2 wG = wWaves( wP, vFlow, uTime, wPrm.z, wFar ) * mix( 1.0, 0.8, wFar );
vec3 wN = normalize( vec3( -wG.x, 1.0, -wG.y ) );
// 低频噪声：深浅/泥沙/界面扰动
float wLo = wNoise( wP * 0.012 ) * 0.65 + wNoise( wP * 0.045 + 7.3 ) * 0.35;
float wDepthT = smoothstep( 0.0, wPrm.x, wD * ( 0.75 + 0.5 * wLo ) );
vec3 wCol = mix( wShalC, wDeepC, wDepthT );
if ( wType == 0 ) {
  // 渭河：沿流向拉长的泥沙条纹 + 浅滩（隐约可见的沙底）
  vec2 fd = length( vFlow ) > 1e-3 ? normalize( vFlow ) : vec2( 1.0, 0.0 );
  vec2 q = vec2( dot( wP, fd ) * 0.004, dot( wP, vec2( -fd.y, fd.x ) ) * 0.03 );
  float streak = wNoise( q + vec2( -uTime * 0.002, 0.0 ) ) * 0.7 + wNoise( q * 2.7 + 3.1 ) * 0.3;
  wCol *= 0.86 + 0.28 * streak;
  float shoal = smoothstep( 0.62, 0.8, wLo + ( 1.0 - wDepthT ) * 0.25 );
  wCol = mix( wCol, vec3( 0.36, 0.30, 0.2 ), shoal * 0.45 );
  // 泾河清水羽流（泾渭分明）
  float cl = vWater.z + ( wNoise( wP * 0.02 + vec2( uTime * 0.01, 0.0 ) ) - 0.5 ) * 0.28;
  cl = smoothstep( 0.46, 0.54, cl );
  wCol = mix( wCol, mix( uShallow[ 1 ], uDeep[ 1 ], wDepthT ), cl );
}
// 岸边泡沫/湿边
float wFoam = 0.0;
if ( wPrm.y > 0.0 ) {
  float fn = wNoise( ( wP - vFlow * uTime * 0.8 ) * 0.35 ) * 0.6 + wNoise( wP * 1.3 + uTime * 0.2 ) * 0.4;
  wFoam = ( 1.0 - smoothstep( 0.0, wPrm.y * ( 0.6 + fn ), wD ) ) * smoothstep( 0.35, 0.65, fn + 0.25 );
  wFoam *= 1.0 - wFar * 0.6;
}
wCol = mix( wCol, vec3( 0.62, 0.6, 0.55 ), wFoam * 0.55 );
diffuseColor.rgb = wCol;
diffuseColor.a = mix( 0.5, 0.97, smoothstep( 0.0, 2.5, wD ) );`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix( 0.04, 0.22, wFar ) + wFoam * 0.5;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `normal = normalize( ( viewMatrix * vec4( wN, 0.0 ) ).xyz );`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
if ( uNight > 0.02 ) {
  vec3 wV = normalize( cameraPosition - vWPos );
  float wFres = 0.02 + 0.98 * pow( 1.0 - max( dot( wN, wV ), 0.0 ), 5.0 );
  float urban = vWater.w;
  // 城市夜空辉光的反射（暖橙）
  vec3 em = vec3( 0.16, 0.10, 0.055 ) * wFres * urban;
  // 灯光倒影：以相机为中心的放射状光带（真实倒影总指向观察者），被波浪扭曲并碎成波纹
  vec2 vd = vWPos.xz - cameraPosition.xz;
  float ang = atan( vd.y, vd.x ) * ( 900.0 / 6.2831853 ) + ( wN.x * 1.7 + wN.z * 1.3 ) * 30.0;
  float lane = floor( ang );
  float fl = fract( ang );
  float r1 = wHash( vec2( lane, 17.0 ) ), r2 = wHash( vec2( lane, 91.3 ) );
  float on = step( 0.58, r1 );
  float wid = 0.12 + 0.3 * r2;
  float s = ( 1.0 - smoothstep( 0.0, wid, abs( fl - 0.5 ) ) ) * on;
  float along = length( vd );
  // 相位先取模再求正弦：along 在十几公里外达上万弧度（uTime 久了也一样），Metal fast-math 的 sin 对大参数会吐出
  // 无穷大/垃圾值，远处水面会冒出孤立的超亮像素，被泛光放大成地平线上一团团“假太阳”
  float ripPh = mod( along * 1.3 + wN.x * 60.0 + uTime * 1.1 + r2 * 40.0, 6.2831853 );
  float rip = clamp( 0.45 + 0.55 * sin( ripPh ), 0.0, 1.0 );
  float shore = 0.35 + 0.65 * exp( -wD / 45.0 );
  vec3 lc = mix( vec3( 1.0, 0.6, 0.26 ), vec3( 0.8, 0.88, 1.0 ), step( 0.72, r2 ) );
  lc = mix( lc, vec3( 1.0, 0.25, 0.18 ), step( 0.93, r1 ) );
  em += lc * s * rip * ( 0.5 + 1.7 * r2 ) * shore * ( 0.35 + 0.65 * wFres ) * ( 1.0 - wFar * 0.5 ) * urban;
  // 远处（> 2 km）倒影减弱：掠射角下 wFres→1，远处河湖整片亮到 1 以上会在地平线上结成亮线；并给发光封顶兜底
  em *= 1.0 - 0.8 * smoothstep( 2000.0, 7000.0, wDist );
  em = min( em, vec3( 3.0 ) );
  totalEmissiveRadiance += em * uNight;
}`
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular )
  radiance *= uReflBoost;
#endif`
      );
  };
  mat.customProgramCacheKey = () => 'xian-water-v2-' + level;
  ctx.overlay(mat, 0.00018);
  return mat;
}
