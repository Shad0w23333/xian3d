// 高度雾：替换 three 内置 FogExp2 着色片段 —— 雾浓度随海拔指数衰减（近地面有霾、高空俯瞰通透），
// 按真实视距（而非深度）计算。对所有使用 fog 的内置/派生材质自动生效，自定义 ShaderMaterial 只要包含
// fog_pars_* / fog_* 片段也会生效。
import * as THREE from 'three';

export const FOG_GROUND = 400; // 西安平原地面参考海拔（米）
export const FOG_SCALE_HEIGHT = 1500; // 雾标高（米）

let installed = false;

export function installHeightFog() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogDY;
#endif`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = length( mvPosition.xyz );
  // 视空间 -> 世界空间的竖直分量（viewMatrix 旋转部分正交）
  vFogDY = ( mvPosition.xyz * mat3( viewMatrix ) ).y;
#endif`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogDY;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogB = ${(1 / FOG_SCALE_HEIGHT).toFixed(7)};
    float fogCamH = max( cameraPosition.y - ${FOG_GROUND.toFixed(1)}, 0.0 );
    float fogK = vFogDY * fogB;
    float fogT = abs( fogK ) > 1e-4 ? ( 1.0 - exp( -fogK ) ) / fogK : 1.0;
    float fogOptical = fogDensity * vFogDepth * exp( -fogCamH * fogB ) * fogT;
    float fogFactor = 1.0 - exp( -fogOptical );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp( fogFactor, 0.0, 1.0 ) );
#endif`;
}
