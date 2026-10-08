// 大雁塔北广场音乐喷泉（亚洲最大矩阵式音乐喷泉之一）：多级叠水池 + 实例化水柱着色器 + 水花/水雾粒子 + 夜间灯光。
//
// 资料：北广场东西宽约 218 m、南北长约 346 m（含两侧唐风群楼约 480×218 m 范围）；喷泉位于中轴，
// 由北端“音乐水池”（主喷、环喷、跑泉）、中段八级叠水池（矩阵喷头 + 两侧拱形跑泉）与南端跌水瀑布组成，
// 以 Esri 卫星影像核对：中轴 x≈1570，水池区 z≈4150~4440，宽约 56~62 m。
// 表演场次（公开资料，按季节略有出入）：约 12:00、16:00、19:00、21:00 各一场，每场约 20 分钟；其余时间只有静水与叠水。
// 夜间灯光以暖白、金色为主，只有表演时水柱与水面才变彩色。
//
// 水柱：一个 InstancedMesh（开口细圆管，y∈[0,1]），每个喷头的高度由顶点着色器按“时间编排程序”实时计算
// （6 段节目循环：齐喷呼吸 / 纵向波浪 / 交替跳泉 / 中心涟漪 / 左右摇摆 / 高潮主喷），不在 CPU 上逐帧更新。
// 水花：每个喷头若干个公告板粒子，沿“伞形”落水轨迹循环下落；水雾：喷头根部的大号淡粒子。
// 混合：预乘 alpha（ONE, ONE_MINUS_SRC_ALPHA）——白天按正常透明叠加（白色水柱遮住背后），夜间 alpha 置零变成纯加色发光。
// 水柱/水花/水雾都不投射阴影（半透明物体投实心阴影会在地砖上留下一排暗斑）。
import * as THREE from 'three';
import { heightToNormal, canvas, rng } from '../core/textures.js';

// 节目编排（水柱、水花共用）
const JET_COMMON = /* glsl */ `
uniform float uTime, uNight, uShow, uColorful;
vec3 hue2rgb(float h) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return k * k * (3.0 - 2.0 * k);
}
float jetK(float t, float type, float u, float v, float ph, out float scene) {
  float cyc = mod(t, 72.0);
  scene = floor(cyc / 12.0);
  float st = mod(cyc, 12.0);
  float fade = smoothstep(0.0, 1.6, st) * (1.0 - smoothstep(10.6, 12.0, st));
  float k;
  if (scene < 0.5) k = 0.55 + 0.45 * sin(t * 2.0);
  else if (scene < 1.5) k = 0.15 + 0.85 * pow(max(0.5 + 0.5 * sin(t * 2.6 - u * 16.0), 0.0), 1.5);
  else if (scene < 2.5) k = 0.12 + 0.88 * smoothstep(-0.35, 0.35, sin(t * 2.4 + ph * 3.14159));
  else if (scene < 3.5) k = 0.2 + 0.8 * (0.5 + 0.5 * sin(t * 2.8 - length(vec2((u - 0.5) * 5.0, v * 1.2)) * 4.0));
  else if (scene < 4.5) k = 0.2 + 0.8 * pow(max(0.5 + 0.5 * sin(t * 1.6 + v * 2.2), 0.0), 2.0);
  else k = 0.82 + 0.18 * sin(t * 5.0 + ph * 6.28);
  // 拱喷在 2、4 段最活跃，主喷在 0、5 段冲高
  if (type > 0.5 && type < 1.5) k *= (scene > 1.5 && scene < 2.5) || (scene > 3.5 && scene < 4.5) ? 1.0 : 0.45;
  if (type > 1.5) k *= scene > 4.5 ? 1.0 : scene < 0.5 ? 0.7 : 0.28;
  return k * mix(0.12, 1.0, fade) * uShow;
}
vec3 showColor(float s, float u, float v, float scene) {
  float hueT = uTime * 0.035 + scene * 0.19;
  vec3 c1 = hue2rgb(fract(hueT + u * 0.45 + v * 0.08));
  vec3 c2 = hue2rgb(fract(hueT + 0.33 + u * 0.2));
  // 非表演色（暖白）与表演彩色按 uColorful 混合
  return mix(vec3(1.0, 0.86, 0.66), mix(c1, c2, s * 0.6), uColorful);
}
`;

const JET_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec4 iA;   // x 类型(0 直喷 1 拱喷 2 主喷) y 轴向 u(0..1) z 横向 v(-1..1) w 最大高度
attribute vec4 iB;   // xy 拱喷方向  z 半径  w 相位
${JET_COMMON}
varying float vS;
varying float vH;
varying vec3 vCol;
varying float vSeed;
varying float vType;
varying float vEdge;

void main() {
  float scene;
  float k = jetK(uTime, iA.x, iA.y, iA.z, iB.w, scene);
  float H = iA.w * k;
  float s = position.y;
  vec2 ring = position.xz;
  // 细水柱：根部最细、向上略收后在顶端散开（散开部分交给水花粒子）
  float r = iB.z * (0.75 + 0.35 * s + 0.9 * s * s * s);
  vec3 p;
  if (iA.x > 0.5 && iA.x < 1.5) {
    float L = H * 1.5;
    float yy = 4.0 * H * s * (1.0 - s);
    p = iPos + vec3(iB.x * L * s, yy, iB.y * L * s) + vec3(ring.x, ring.y * 0.8, ring.y) * r;
  } else {
    p = iPos + vec3(ring.x * r, s * H, ring.y * r);
  }
  vS = s;
  vH = H;
  vSeed = iB.w;
  vType = iA.x;
  vCol = showColor(s, iA.y, iA.z, scene);
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  // 圆管侧面朝向视线的程度（边缘更不透明，像真实水柱的高光边）
  vec3 nV = normalize((modelViewMatrix * vec4(ring.x, 0.0, ring.y, 0.0)).xyz);
  vEdge = 1.0 - abs(dot(nV, normalize(-mvPosition.xyz)));
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
}
`;

const JET_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime, uNight;
varying float vS;
varying float vH;
varying vec3 vCol;
varying float vSeed;
varying float vType;
varying float vEdge;
void main() {
  #include <logdepthbuf_fragment>
  if (vH < 0.08) discard;
  // 向上流动的水纹
  float streak = 0.62 + 0.38 * sin(vS * vH * 3.1 - uTime * 14.0 + vSeed * 17.0) * sin(vS * vH * 1.3 - uTime * 6.0 + vSeed * 5.0);
  float a = smoothstep(0.0, 0.04, vS) * (1.0 - smoothstep(0.55, 1.0, vS));
  if (vType > 0.5 && vType < 1.5) a = smoothstep(0.0, 0.05, vS) * (1.0 - 0.75 * smoothstep(0.7, 1.0, vS));
  a *= streak * (0.45 + 0.55 * vEdge);
  vec3 day = vec3(0.93, 0.96, 1.0);
  vec3 nightC = mix(vec3(1.0), vCol, 0.85) * (1.5 + 1.1 * smoothstep(0.3, 1.0, vS));
  vec3 col = mix(day, nightC, uNight);
  float alpha = a * mix(0.62, 0.5, uNight);
  // 预乘：白天 alpha 遮挡背景（正常透明），夜间不遮挡（纯加色）
  gl_FragColor = vec4(col * alpha, alpha * mix(0.9, 0.08, uNight));
}
`;

// 水花（下落水滴团）与水雾：每个粒子一个公告板四边形
const SPRAY_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec4 iA;
attribute vec4 iB;
attribute vec2 iC;   // x 随机种子  y 种类（0 水花，1 水雾）
${JET_COMMON}
varying vec2 vUv;
varying float vAl;
varying vec3 vCol;
varying float vKind;
void main() {
  float scene;
  float k = jetK(uTime, iA.x, iA.y, iA.z, iB.w, scene);
  float H = iA.w * k;
  float seed = iC.x;
  vec3 c;
  float size, al;
  if (iC.y < 0.5) {
    float u = fract(uTime * (0.42 + 0.3 * fract(seed * 7.13)) + seed);
    if (iA.x > 0.5 && iA.x < 1.5) {
      // 拱喷：落点附近的水花
      float L = H * 1.5, s = 0.62 + 0.38 * u;
      vec3 j = vec3(fract(seed * 3.1) - 0.5, 0.0, fract(seed * 5.7) - 0.5) * 0.35;
      c = iPos + vec3(iB.x * L * s, 4.0 * H * s * (1.0 - s), iB.y * L * s) + j;
      size = 0.1 + 0.05 * H;
      al = 0.38 * (1.0 - 0.6 * u);
    } else {
      // 直喷/主喷：水到顶后向四周伞形落下
      float ang = seed * 43.7;
      float R = 0.17 * H + 0.2;
      float rr = R * u * (0.55 + 0.45 * fract(seed * 3.7));
      c = iPos + vec3(cos(ang) * rr, H * (1.0 - u * u) + 0.08, sin(ang) * rr);
      size = (0.09 + 0.03 * H) * (0.55 + 1.0 * u);
      al = 0.55 * (1.0 - u) * smoothstep(0.0, 0.08, u);
    }
  } else {
    // 根部水雾：缓慢升腾、淡入淡出
    float u = fract(uTime * 0.11 + seed);
    float ang = seed * 29.1;
    float rr = (0.25 + 0.07 * H) * fract(seed * 5.3);
    c = iPos + vec3(cos(ang) * rr, 0.2 + H * 0.1 * u, sin(ang) * rr);
    size = 0.45 + 0.16 * H * (0.6 + 0.7 * u);
    al = 0.13 * sin(3.14159 * u);
  }
  al *= smoothstep(0.25, 1.4, H);
  vAl = al;
  vKind = iC.y;
  vCol = showColor(0.7, iA.y, iA.z, scene);
  vUv = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;
const SPRAY_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uNight;
varying vec2 vUv;
varying float vAl;
varying vec3 vCol;
varying float vKind;
void main() {
  #include <logdepthbuf_fragment>
  if (vAl < 0.004) discard;
  float r = length(vUv);
  float a = vAl * (1.0 - smoothstep(vKind > 0.5 ? 0.0 : 0.25, 1.0, r));
  if (a < 0.003) discard;
  vec3 col = mix(vec3(0.94, 0.97, 1.0), mix(vec3(1.0), vCol, 0.8) * (vKind > 0.5 ? 0.9 : 1.6), uNight);
  gl_FragColor = vec4(col * a, a * mix(0.85, 0.06, uNight));
}
`;

/** 水面涟漪法线贴图（程序化） */
function rippleNormal() {
  const S = 256;
  const c = canvas(S), g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const r = rng(77);
  const waves = [];
  for (let i = 0; i < 9; i++) waves.push([1 + Math.floor(r() * 6), 1 + Math.floor(r() * 6), r() * 6.28, 0.4 + r() * 0.6]);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let h = 0;
      for (const [a, b, p, amp] of waves) h += amp * Math.sin(((x * a + y * b) / S) * Math.PI * 2 + p);
      const v = Math.max(0, Math.min(255, 128 + h * 28));
      const k = (y * S + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const n = heightToNormal(c, 1.6);
  const t = n instanceof THREE.Texture ? n : new THREE.CanvasTexture(n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** 预乘 alpha 混合：白天正常透明、夜间（片元 alpha≈0）纯加色 */
function premulBlend(m) {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  return m;
}

/**
 * 表演场次：返回 0..1（场次开始/结束各 1 分钟淡入淡出）。hours 为北京时间小时数。
 */
export const SHOW_TIMES = [12, 16, 19, 21];
export const SHOW_LEN = 20 / 60;
export function showFactor(hours) {
  let k = 0;
  for (const s of SHOW_TIMES) {
    const d = hours - s;
    if (d < -0.02 || d > SHOW_LEN + 0.02) continue;
    k = Math.max(k, Math.min(THREE.MathUtils.smoothstep(d, -0.017, 0.0), 1 - THREE.MathUtils.smoothstep(d, SHOW_LEN, SHOW_LEN + 0.017)));
  }
  return k;
}

/**
 * 构建喷泉。o: {cx 中轴 x, pools:[{z0, z1, w, y}]（水面高，北→南），front:{z0,z1,w,y}（北端音乐水池）}
 * 返回 {group, jetCount, waterMat, update(t, camDist, show=1, night=uNight)}
 */
export function buildFountain(ctx, o) {
  const group = new THREE.Group();
  group.name = '北广场音乐喷泉';
  const cx = o.cx;
  const all = [o.front, ...o.pools];

  // ───── 水面 ─────
  const nrm = rippleNormal();
  nrm.repeat.set(1 / 9, 1 / 9);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1d3238, roughness: 0.06, metalness: 0.05, normalMap: nrm, normalScale: new THREE.Vector2(0.35, 0.35),
    emissive: 0xffe2b8, emissiveIntensity: 0, envMapIntensity: 1.2,
  });
  waterMat.name = 'fountainWater';
  const geos = [];
  for (const p of all) {
    const g = new THREE.PlaneGeometry(p.w - 1.0, p.z1 - p.z0 - 1.0);
    g.rotateX(-Math.PI / 2);
    g.translate(cx, p.y, (p.z0 + p.z1) / 2);
    // 世界米制 UV
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
    geos.push(g);
  }
  const waterGeo = mergeSimple(geos);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.receiveShadow = true;
  water.castShadow = false;
  water.name = 'fountainWater';
  group.add(water);

  // ───── 喷头布置 ─────
  const jets = []; // [type, u, v, maxH, x, y, z, dx, dz, r, phase]
  const zN = o.front.z0, zS = o.pools[o.pools.length - 1].z1;
  const U = (z) => (zS - z) / (zS - zN); // 北端 u=1（主水池），南端 u=0
  const R = rng(5);
  {
    const f = o.front, fz = (f.z0 + f.z1) / 2, hw = f.w / 2 - 2;
    jets.push([2, U(fz), 0, 42, cx, f.y, fz, 0, 0, 0.42, 0]);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      jets.push([0, U(fz + Math.sin(a) * 9), Math.cos(a) * 0.3, 15, cx + Math.cos(a) * 9, f.y, fz + Math.sin(a) * 9, 0, 0, 0.13, (i % 2) * 1]);
    }
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      jets.push([0, U(fz + Math.sin(a) * 15), Math.cos(a) * 0.5, 9, cx + Math.cos(a) * 15, f.y, fz + Math.sin(a) * 15, 0, 0, 0.11, ((i + 1) % 2) * 1]);
    }
    for (const zz of [f.z0 + 2.2, f.z1 - 2.2])
      for (let i = 0; i <= 22; i++) {
        const x = cx - hw + (i / 22) * 2 * hw;
        jets.push([0, U(zz), (x - cx) / hw, 7 + 3 * Math.cos(((x - cx) / hw) * 1.57), x, f.y, zz, 0, 0, 0.08, i % 2]);
      }
    for (const sx of [-1, 1])
      for (let i = 0; i < 12; i++) {
        const zz = f.z0 + 3 + (i / 11) * (f.z1 - f.z0 - 6);
        jets.push([1, U(zz), sx, 4.5, cx + sx * (f.w / 2 - 1.2), f.y, zz, -sx, 0, 0.06, i % 2]);
      }
  }
  o.pools.forEach((p, pi) => {
    const hw = p.w / 2 - 3.5, z0 = p.z0 + 3.5, z1 = p.z1 - 3.5;
    const cols = 7, rows = 3;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = cx - hw + (c / (cols - 1)) * 2 * hw;
        const z = z0 + (r / (rows - 1)) * (z1 - z0);
        const v = (x - cx) / hw;
        const center = c === 3 && r === 1;
        jets.push([0, U(z), v, center ? 13 : 6.5 + 2.5 * (1 - Math.abs(v)), x, p.y, z, 0, 0, center ? 0.16 : 0.09, (r + c + pi) % 2]);
      }
    for (const sx of [-1, 1])
      for (let i = 0; i < 6; i++) {
        const z = p.z0 + 2.5 + (i / 5) * (p.z1 - p.z0 - 5);
        jets.push([1, U(z), sx, 3.6, cx + sx * (p.w / 2 - 1.0), p.y, z, -sx, 0, 0.055, (i + pi) % 2]);
      }
  });
  for (const j of jets) j[10] += R() * 0.05;

  // 开口细圆管（y∈[0,1]），径向 6 段
  const segR = 6, segY = 12;
  const pos = [], idx = [];
  for (let yi = 0; yi <= segY; yi++)
    for (let ri = 0; ri <= segR; ri++) {
      const a = (ri / segR) * Math.PI * 2;
      pos.push(Math.cos(a), yi / segY, Math.sin(a));
    }
  for (let yi = 0; yi < segY; yi++)
    for (let ri = 0; ri < segR; ri++) {
      const a = yi * (segR + 1) + ri, b = a + segR + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const jg = new THREE.InstancedBufferGeometry();
  jg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  jg.setIndex(idx);
  const n = jets.length;
  const iPos = new Float32Array(n * 3), iA = new Float32Array(n * 4), iB = new Float32Array(n * 4);
  jets.forEach((j, i) => {
    iPos.set([j[4], j[5], j[6]], i * 3);
    iA.set([j[0], j[1], j[2], j[3]], i * 4);
    iB.set([j[7], j[8], j[9], j[10]], i * 4);
  });
  jg.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
  jg.setAttribute('iA', new THREE.InstancedBufferAttribute(iA, 4));
  jg.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 4));
  jg.instanceCount = n;
  const uShow = { value: 0 }, uColorful = { value: 0 };
  const shared = () => ({ uTime: ctx.uniforms.uTime, uNight: ctx.uniforms.uNight, uShow, uColorful });
  const jetMat = premulBlend(new THREE.ShaderMaterial({
    vertexShader: JET_VS,
    fragmentShader: JET_FS,
    uniforms: shared(),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  }));
  const jetMesh = new THREE.Mesh(jg, jetMat);
  jetMesh.frustumCulled = false;
  jetMesh.castShadow = false;
  jetMesh.renderOrder = 5;
  jetMesh.name = 'fountainJets';
  group.add(jetMesh);

  // ───── 水花与水雾粒子（公告板） ─────
  const sprays = []; // 每个粒子：喷头索引 + [种子, 种类]
  const RS = rng(91);
  jets.forEach((j, ji) => {
    const [type, , , maxH] = j;
    const nd = type === 2 ? 44 : type === 1 ? 3 : maxH >= 12 ? 10 : maxH >= 8 ? 7 : 4;
    for (let k = 0; k < nd; k++) sprays.push([ji, (k + RS()) / nd, 0]);
    if (type !== 1) for (let k = 0; k < (type === 2 ? 6 : 1); k++) sprays.push([ji, RS(), 1]);
  });
  const ns = sprays.length;
  const sg = new THREE.InstancedBufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  sg.setIndex([0, 1, 2, 0, 2, 3]);
  const sPos = new Float32Array(ns * 3), sA = new Float32Array(ns * 4), sB = new Float32Array(ns * 4), sC = new Float32Array(ns * 2);
  sprays.forEach(([ji, seed, kind], i) => {
    sPos.set(iPos.subarray(ji * 3, ji * 3 + 3), i * 3);
    sA.set(iA.subarray(ji * 4, ji * 4 + 4), i * 4);
    sB.set(iB.subarray(ji * 4, ji * 4 + 4), i * 4);
    sC.set([seed, kind], i * 2);
  });
  sg.setAttribute('iPos', new THREE.InstancedBufferAttribute(sPos, 3));
  sg.setAttribute('iA', new THREE.InstancedBufferAttribute(sA, 4));
  sg.setAttribute('iB', new THREE.InstancedBufferAttribute(sB, 4));
  sg.setAttribute('iC', new THREE.InstancedBufferAttribute(sC, 2));
  sg.instanceCount = ns;
  const sprayMat = premulBlend(new THREE.ShaderMaterial({
    vertexShader: SPRAY_VS,
    fragmentShader: SPRAY_FS,
    uniforms: shared(),
    transparent: true,
    depthWrite: false,
    fog: false,
  }));
  const spray = new THREE.Mesh(sg, sprayMat);
  spray.frustumCulled = false;
  spray.castShadow = false;
  spray.renderOrder = 6;
  spray.name = 'fountainSpray';
  group.add(spray);

  // ───── 落水白沫（喷头落水处的水面白圈） ─────
  const foamGeo = new THREE.InstancedBufferGeometry();
  const fp = [0, 0, 0], fi = [];
  const fs = 10;
  for (let i = 0; i <= fs; i++) {
    const a = (i / fs) * Math.PI * 2;
    fp.push(Math.cos(a), 1, Math.sin(a));
  }
  for (let i = 0; i < fs; i++) fi.push(0, i + 2, i + 1);
  foamGeo.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
  foamGeo.setIndex(fi);
  foamGeo.setAttribute('iPos', jg.attributes.iPos);
  foamGeo.setAttribute('iA', jg.attributes.iA);
  foamGeo.setAttribute('iB', jg.attributes.iB);
  foamGeo.instanceCount = n;
  const foamMat = premulBlend(new THREE.ShaderMaterial({
    vertexShader: JET_VS.replace('void main() {', 'varying float vRad;\nvoid main() {').replace(
      '  vS = s;',
      `  if (iA.x < 0.5 || iA.x > 1.5) { p = iPos + vec3(ring.x, 0.0, ring.y) * (iB.z * 3.0 + H * 0.12) * s + vec3(0.0, 0.04, 0.0); }
  else { float L = H * 1.5; p = iPos + vec3(iB.x * L, 0.04, iB.y * L) + vec3(ring.x, 0.0, ring.y) * (0.35 + H * 0.1) * s; }
  vRad = s;
  vS = s;`
    ),
    fragmentShader: `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime, uNight;
varying float vH; varying vec3 vCol; varying float vRad;
void main() {
  #include <logdepthbuf_fragment>
  if (vH < 0.3) discard;
  float a = (1.0 - vRad * vRad) * clamp(vH / 6.0, 0.15, 0.8) * 0.55;
  vec3 col = mix(vec3(0.9, 0.94, 0.96), mix(vec3(1.0), vCol, 0.7) * 1.4, uNight);
  gl_FragColor = vec4(col * a, a * mix(0.8, 0.05, uNight));
}`,
    uniforms: shared(),
    transparent: true,
    depthWrite: false,
    fog: false,
  }));
  const foam = new THREE.Mesh(foamGeo, foamMat);
  foam.frustumCulled = false;
  foam.castShadow = false;
  foam.renderOrder = 4;
  foam.name = 'fountainFoam';
  group.add(foam);

  const col = new THREE.Color(), warm = new THREE.Color(0xffe2b8);
  let lastT = -1;
  return {
    group,
    jetCount: n,
    sprayCount: ns,
    waterMat,
    /** t：秒（uTime）；camDist：相机到喷泉中心距离；show：表演强度 0..1；返回当前水面灯光颜色（供点光源同步） */
    update(t, camDist, show = 1) {
      const night = ctx.uniforms.uNight.value;
      uShow.value = show;
      uColorful.value = show; // 只有表演时才彩色
      const vis = camDist < 4500 && show > 0.001;
      jetMesh.visible = foam.visible = vis;
      spray.visible = vis && camDist < 1800;
      if (Math.abs(t - lastT) < 0.03) return col;
      lastT = t;
      nrm.offset.set((t * 0.013) % 1, (t * 0.009) % 1);
      // 水面灯光：平时为水下暖白灯（低亮度），表演时色相轮转（与水柱同一时钟）；远处压低，避免整片水面成为全城最亮的色块
      const scene = Math.floor((t % 72) / 12);
      const h = (t * 0.035 + scene * 0.19 + 0.1) % 1;
      col.setHSL(h, 0.75, 0.55).lerp(warm, 1 - show);
      waterMat.emissive.copy(col);
      const far = 1 - 0.7 * THREE.MathUtils.smoothstep(camDist, 600, 3500);
      waterMat.emissiveIntensity = (0.015 + night * (0.06 + 0.22 * show)) * far;
      return col;
    },
  };
}

function mergeSimple(geos) {
  let nv = 0, ni = 0;
  for (const g of geos) { nv += g.attributes.position.count; ni += g.index.count; }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), I = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of geos) {
    P.set(g.attributes.position.array, ov * 3);
    N.set(g.attributes.normal.array, ov * 3);
    UV.set(g.attributes.uv.array, ov * 2);
    const ia = g.index.array;
    for (let i = 0; i < ia.length; i++) I[oi + i] = ia[i] + ov;
    ov += g.attributes.position.count;
    oi += ia.length;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(P, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  m.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  m.setIndex(new THREE.BufferAttribute(I, 1));
  m.computeBoundingSphere();
  return m;
}
