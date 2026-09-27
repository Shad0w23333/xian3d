// 城市植被渲染：LOD 几何（中景简化）、远景 impostor 烘焙、着色器补丁（风摆 / 秋色 / 路灯暖光 / 抖动过渡）。
// 由 src/modules/vegetation.js 使用。
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 中景简化：保留树干下段 + 抽稀叶片卡片并放大（保持树冠覆盖率）
/**
 * @param {THREE.BufferGeometry} g 近景几何（vegSpecies.buildSpeciesGeometries 输出）
 * @param {object} o keep 叶片保留比例；grow 叶片放大倍数；trunkY 保留枝干的最高高度（米）
 */
export function simplifyTree(g, { keep = 0.3, grow = 1.6, trunkY = 4, seed = 1 } = {}) {
  const idx = g.index.array;
  const P = g.attributes.position.array, N = g.attributes.normal.array, U = g.attributes.uv.array;
  const C = g.attributes.color.array, Wd = g.attributes.aWind.array;
  const oP = [], oN = [], oU = [], oC = [], oW = [], oI = [];
  const remap = new Map();
  const vert = (v, px, py, pz) => {
    const k = oP.length / 3;
    oP.push(px ?? P[v * 3], py ?? P[v * 3 + 1], pz ?? P[v * 3 + 2]);
    oN.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
    oU.push(U[v * 2], U[v * 2 + 1]);
    oC.push(C[v * 3], C[v * 3 + 1], C[v * 3 + 2]);
    oW.push(Wd[v * 2], Wd[v * 2 + 1]);
    return k;
  };
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let t = 0; t < idx.length; ) {
    const a = idx[t];
    // 卡片：[a,a+1,a+2, a,a+2,a+3]
    if (t + 5 < idx.length && idx[t + 1] === a + 1 && idx[t + 2] === a + 2 && idx[t + 3] === a && idx[t + 4] === a + 2 && idx[t + 5] === a + 3 && Wd[a * 2 + 1] > 0) {
      t += 6;
      if (rnd() > keep) continue;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 4; k++) { cx += P[(a + k) * 3] / 4; cy += P[(a + k) * 3 + 1] / 4; cz += P[(a + k) * 3 + 2] / 4; }
      const b = [];
      for (let k = 0; k < 4; k++) {
        const v = a + k;
        b.push(vert(v, cx + (P[v * 3] - cx) * grow, Math.max(0.2, cy + (P[v * 3 + 1] - cy) * grow), cz + (P[v * 3 + 2] - cz) * grow));
      }
      oI.push(b[0], b[1], b[2], b[0], b[2], b[3]);
      continue;
    }
    // 其他三角形（枝干管 / 灌木实心球）：按高度保留
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    t += 3;
    const isShell = Wd[tri[0] * 2 + 1] > 0; // 灌木实心冠
    if (!isShell && Math.max(P[tri[0] * 3 + 1], P[tri[1] * 3 + 1], P[tri[2] * 3 + 1]) > trunkY) continue;
    for (const v of tri) {
      if (!remap.has(v)) remap.set(v, vert(v));
      oI.push(remap.get(v));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(oP, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(oN, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(oU, 2));
  out.setAttribute('color', new THREE.Float32BufferAttribute(oC, 3));
  out.setAttribute('aWind', new THREE.Float32BufferAttribute(oW, 2));
  out.setIndex(oI);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// 远景 impostor：把每个树种的近景几何正交渲染到 1024² 图集（4×4 格，0~6 侧视，8~14 俯视）
export const IMP_TILES = 4;
export function bakeImpostors(renderer, geos, atlas) {
  const S = 1024, T = S / IMP_TILES;
  const rt = new THREE.WebGLRenderTarget(S, S, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.SRGBColorSpace,
    depthBuffer: true,
  });
  rt.texture.name = 'veg-impostor';
  const scene = new THREE.Scene();
  const mat = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide });
  const info = [];
  const prev = {
    target: renderer.getRenderTarget(),
    clear: renderer.getClearColor(new THREE.Color()),
    alpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear,
    shadow: renderer.shadowMap.autoUpdate,
  };
  renderer.autoClear = false;
  renderer.shadowMap.autoUpdate = false;
  // 背景用叶色填充（alpha=0），避免 mip 黑边
  renderer.setClearColor(new THREE.Color(0.16, 0.2, 0.12), 0);
  rt.scissorTest = false;
  rt.viewport.set(0, 0, S, S);
  renderer.setRenderTarget(rt);
  renderer.clear(true, true, true);
  for (let sp = 0; sp < geos.length; sp++) {
    const g = geos[sp];
    const bb = g.boundingBox;
    const half = Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z) * 1.02;
    const H = bb.max.y * 1.02;
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    for (const view of [0, 1]) {
      const slot = sp + view * 8;
      const col = slot % IMP_TILES, row = (slot / IMP_TILES) | 0;
      let cam;
      if (view === 0) {
        cam = new THREE.OrthographicCamera(-half, half, H, 0, 1, 400);
        cam.position.set(0, 0, 200);
        cam.lookAt(0, 0, 0);
      } else {
        cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 400);
        cam.position.set(0, H + 100, 0);
        cam.up.set(0, 0, -1);
        cam.lookAt(0, 0, 0);
      }
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      rt.viewport.set(col * T, row * T, T, T);
      rt.scissor.set(col * T, row * T, T, T);
      rt.scissorTest = true;
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
    }
    scene.remove(mesh);
    info.push({ half, H, crownY: H * 0.62 });
  }
  rt.scissorTest = false;
  rt.viewport.set(0, 0, S, S);
  rt.scissor.set(0, 0, S, S);
  renderer.setRenderTarget(prev.target);
  renderer.setClearColor(prev.clear, prev.alpha);
  renderer.autoClear = prev.autoClear;
  renderer.shadowMap.autoUpdate = prev.shadow;
  mat.dispose();
  return { texture: rt.texture, rt, info };
}

// ---------------------------------------------------------------------------
// 着色器补丁
const IGN = /* glsl */ `
float vegIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

/**
 * 树木（近景 / 中景）材质补丁。uniforms：{uTime, uNight, uCameraPos} 为全局共享对象；
 * fade：THREE.Vector4（淡入起止、淡出起止，单位米，按树基到相机距离）
 */
export function patchTreeMaterial(mat, G, { fade, wind, lampK, key, depth = false }) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = G.uTime;
    sh.uniforms.uNight = G.uNight;
    sh.uniforms.uCamPos = G.uCameraPos;
    sh.uniforms.uFade = { value: fade };
    sh.uniforms.uWind = wind;
    sh.uniforms.uLampK = lampK;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aWind;
attribute vec4 aInfo;
uniform float uTime;
uniform vec3 uCamPos;
uniform vec4 uFade;
uniform float uWind;
varying vec4 vInfo;
varying float vFadeIn;
varying float vFadeOut;
varying float vLeaf;
varying float vHgt;`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 iPos = instanceMatrix[3].xyz;
  float iS = length( instanceMatrix[1].xyz );
#else
  vec3 iPos = vec3( 0.0 );
  float iS = 1.0;
#endif
{
  float ph = aInfo.w * 6.2831853;
  float gust = 0.55 + 0.45 * sin( uTime * 0.37 + iPos.x * 0.011 + iPos.z * 0.007 );
  float sway = ( sin( uTime * 1.1 + ph ) + 0.4 * sin( uTime * 2.37 + ph * 1.9 ) ) * gust * uWind;
  mvPosition.xz += vec2( 0.8, 0.45 ) * ( aWind.x * sway * 0.16 * iS );
  float fl = sin( uTime * 6.3 + ph * 4.0 + position.y * 2.1 + position.x * 1.7 + position.z * 1.3 );
  mvPosition.xyz += vec3( 0.6, 0.35, 0.5 ) * ( aWind.y * fl * 0.05 * gust * uWind * iS );
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
{
  float dcam = distance( iPos, uCamPos );
  vFadeIn = smoothstep( uFade.x, uFade.y, dcam );
  vFadeOut = smoothstep( uFade.z, uFade.w, dcam );
  vInfo = aInfo;
  vLeaf = step( uv.y, 0.5 );
  vHgt = position.y * iS;
}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uNight;
uniform float uLampK;
varying vec4 vInfo;
varying float vFadeIn;
varying float vFadeOut;
varying float vLeaf;
varying float vHgt;
${IGN}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
${depth ? '' : `{
  float dth = vegIGN( gl_FragCoord.xy );
  if ( dth >= 1.0 - vFadeOut ) discard;
  if ( 1.0 - dth > vFadeIn ) discard;
}`}`,
      );
    if (!depth) {
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb *= 0.84 + 0.32 * vInfo.x;
{
  float yv = vInfo.y * vLeaf;
  if ( yv > 0.002 ) {
    float nz = fract( sin( dot( floor( vMapUv * 48.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    float lum = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
    vec3 gold = vec3( lum * 2.05, lum * 1.72, lum * 0.32 );
    diffuseColor.rgb = mix( diffuseColor.rgb, gold, clamp( yv * ( 0.35 + 1.1 * nz ), 0.0, 1.0 ) );
  }
}`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', 'normal *= mix( faceDirection, 1.0, vLeaf );'),
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
{
  // 路灯（约 9~12 m 高）从下方/侧方照亮树冠：下部亮、树顶暗；颜色偏暖、降低饱和度
  float lampH = 1.0 - 0.8 * smoothstep( 4.0, 14.0, vHgt );
  vec3 base = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) ) ), 0.45 );
  totalEmissiveRadiance += base * vec3( 1.0, 0.62, 0.3 ) * ( vInfo.z * uNight * uLampK * lampH );
}`,
        );
    }
  };
  mat.customProgramCacheKey = () => `veg-tree-${key}${depth ? '-d' : ''}`;
  return mat;
}

/** 远景 impostor 材质（InstancedBufferGeometry：aCorner / aPos / aData） */
export function makeFarMaterial(G, texture, info, { fade, rankMax, lampK }) {
  const mat = new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.5, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const imp = [];
  for (let i = 0; i < 8; i++) {
    const f = info[i] || info[0];
    imp.push(new THREE.Vector4(f.half, f.H, f.crownY, 0));
  }
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = G.uNight;
    sh.uniforms.uCamPos = G.uCameraPos;
    sh.uniforms.uImp = { value: imp };
    sh.uniforms.uFarP = { value: fade };
    sh.uniforms.uRankMax = rankMax;
    sh.uniforms.uLampK = lampK;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aCorner;
attribute vec3 aPos;
attribute vec4 aData;
uniform vec3 uCamPos;
uniform vec4 uImp[8];
uniform vec4 uFarP;
uniform float uRankMax;
varying float vFarFade;
varying float vViewW;
varying float vViewTop;
varying float vLampF;
varying float vShadeY;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 bbPos;
vec3 objectNormal;
vec2 impUv;
{
  int spi = int( aData.x + 0.5 );
  vec4 imp = uImp[ spi ];
  float s = aData.y / 127.5;
  vec3 toC = uCamPos - aPos;
  float d = length( toC );
  float fin = smoothstep( uFarP.x, uFarP.y, d );
  float fout = 1.0 - smoothstep( uFarP.z, uFarP.w, d );
  float elev = clamp( toC.y / max( d, 1.0 ), 0.0, 1.0 );
  float topW = smoothstep( 0.5, 0.82, elev );
  float viewW = aCorner.z > 0.5 ? topW : 1.0 - topW;
  vec3 up = vec3( 0.0, 1.0, 0.0 );
  vec3 hd = normalize( vec3( toC.x, 0.0, toC.z ) + vec3( 1e-4, 0.0, 0.0 ) );
  vec3 hr = vec3( hd.z, 0.0, -hd.x );
  float cu = aCorner.x * 2.0 - 1.0;
  float slot;
  if ( aCorner.z < 0.5 ) {
    bbPos = aPos + hr * ( cu * imp.x * s ) + up * ( aCorner.y * imp.y * s ) + hd * ( imp.x * s * 0.3 );
    objectNormal = normalize( hd * 0.8 + hr * cu * 0.75 + up * ( aCorner.y - 0.3 ) * 1.1 );
    slot = aData.x;
  } else {
    vec3 camR = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
    vec3 camU = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
    float cv = aCorner.y * 2.0 - 1.0;
    bbPos = aPos + up * ( imp.z * s ) + camR * ( cu * imp.x * s ) + camU * ( cv * imp.x * s );
    objectNormal = normalize( up * 1.1 + camR * cu * 0.55 + camU * cv * 0.55 );
    slot = aData.x + 8.0;
  }
  if ( spi == 6 || aData.z >= uRankMax || fin <= 0.0 || fout <= 0.0 || viewW <= 0.002 ) bbPos = aPos;
  float col = mod( slot, 4.0 ), row = floor( slot / 4.0 );
  impUv = ( vec2( col, row ) + vec2( 0.004 ) + aCorner.xy * 0.992 ) / 4.0;
  vFarFade = fin * fout;
  vViewW = viewW;
  vViewTop = aCorner.z;
  vLampF = aData.w / 255.0 * ( 1.0 - smoothstep( 700.0, 2600.0, d ) );
  vShadeY = aCorner.z > 0.5 ? 1.0 : 0.6 + 0.4 * aCorner.y;
}`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = bbPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvMapUv = impUv;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uNight;
uniform float uLampK;
varying float vFarFade;
varying float vViewW;
varying float vViewTop;
varying float vLampF;
varying float vShadeY;
${IGN}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
{
  float dth = vegIGN( gl_FragCoord.xy );
  if ( 1.0 - dth > vFarFade ) discard;
  float d2 = vegIGN( gl_FragCoord.yx * 1.37 + 17.0 );
  if ( vViewTop < 0.5 ? ( d2 >= vViewW ) : ( 1.0 - d2 > vViewW ) ) discard;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
diffuseColor.a = clamp( ( diffuseColor.a - 0.42 ) / max( fwidth( diffuseColor.a ), 1e-3 ) + 0.5, 0.0, 1.0 );
diffuseColor.rgb *= vShadeY;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) ) ), 0.45 ) * vec3( 1.0, 0.62, 0.3 ) * ( vLampF * uNight * uLampK * 0.7 );`,
      );
  };
  mat.customProgramCacheKey = () => 'veg-far';
  return mat;
}

/** 远景 impostor 几何：两张四边形（侧视柱面公告板 + 俯视球面公告板） */
export function makeFarGeometry(n) {
  const g = new THREE.InstancedBufferGeometry();
  const corner = [];
  for (const view of [0, 1]) corner.push(0, 0, view, 1, 0, view, 1, 1, view, 0, 1, view);
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24), 3));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(16), 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  g.instanceCount = n;
  return g;
}

/** 绿篱材质：单位盒按实例缩放，UV 以米计 */
export function patchHedgeMaterial(mat, G, fade) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCamPos = G.uCameraPos;
    sh.uniforms.uFade = { value: fade };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uCamPos;\nuniform vec4 uFade;\nvarying float vFadeOut;\nvarying float vTop;')
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
#ifdef USE_INSTANCING
{
  float hL = length( instanceMatrix[0].xyz ), hH = length( instanceMatrix[1].xyz ), hW = length( instanceMatrix[2].xyz );
  vMapUv = vec2( position.x * hL + position.z * hW, position.y * hH + position.z * hW * 0.6 ) / 1.1;
  vFadeOut = smoothstep( uFade.z, uFade.w, distance( instanceMatrix[3].xyz, uCamPos ) );
}
#endif
vTop = normal.y;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vFadeOut;\nvarying float vTop;\n${IGN}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if ( vegIGN( gl_FragCoord.xy ) >= 1.0 - vFadeOut ) discard;`,
      )
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 0.78 + 0.3 * max( vTop, 0.0 );');
  };
  mat.customProgramCacheKey = () => 'veg-hedge';
  return mat;
}
