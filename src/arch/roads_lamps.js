// roads 模块路灯：五种灯型的程序化几何（实例化）+ 远景灯头光点（Points，加法混合）。
// 灯型依据（调研，见最终汇报）：
//   SINGLE  普通单臂 LED 路灯：灯杆 10 m，锥形钢杆，臂长 ~2.2 m，扁平 LED 灯头（西安主次干道常见）
//   DOUBLE  中央分隔带双臂灯：杆高 11.5 m，两侧各 2.6 m 臂
//   KNOT    “中国结”装饰灯：东西南北大街、长安路一带灯杆挂红色 LED 中国结（国际在线《西安市民生工程之城市夜景亮化》：
//           “东西南北大街红红的中国结”），灯头为双臂仿古灯罩
//   PALACE  唐风宫灯：曲江/大雁塔/大唐不夜城一带，深色仿古灯杆 + 横担吊挂六角宫灯 + 顶部宫灯
//   LANTERN 二环红灯笼：“二环路沿线的红灯笼”（同上），普通灯杆中部挂一对红灯笼
// 约定：局部 +Z 指向路面（灯臂方向），+Y 向上，原点为灯杆底部中心。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAMP } from './roads_net.js';

const C_POLE = [0.42, 0.44, 0.47];
const C_DARK = [0.16, 0.16, 0.17];
const C_BRONZE = [0.2, 0.12, 0.08];
const C_RED = [0.55, 0.05, 0.035];
const C_GOLD = [0.62, 0.45, 0.16];
const E_LED = [1.0, 0.8, 0.56];
const E_WARM = [1.0, 0.66, 0.3];
const E_RED = [1.0, 0.07, 0.03];

/** 统一属性（position/normal/color/aEmi），去掉 uv，便于合并 */
function prep(geo, color, emi, strength = 0) {
  const g = geo.index ? geo : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3), e = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = color[0]; c[i * 3 + 1] = color[1]; c[i * 3 + 2] = color[2];
    if (emi) { e[i * 3] = emi[0] * strength; e[i * 3 + 1] = emi[1] * strength; e[i * 3 + 2] = emi[2] * strength; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aEmi', new THREE.BufferAttribute(e, 3));
  return g;
}

function box(w, h, d, x, y, z, color, emi, s, rotX = 0, rotY = 0, rotZ = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotX || rotY || rotZ) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotX, rotY, rotZ)));
  g.translate(x, y, z);
  return prep(g, color, emi, s);
}
function cyl(rt, rb, h, seg, x, y, z, color, emi, s) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, false);
  g.translate(x, y, z);
  return prep(g, color, emi, s);
}
/** 两点之间的圆杆 */
function rod(a, b, r, seg, color, emi, s) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const L = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, L, seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  g.applyQuaternion(q);
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return prep(g, color, emi, s);
}
function sphere(r, sx, sy, sz, x, y, z, color, emi, s, seg = 10) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg - 2));
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return prep(g, color, emi, s);
}

/** 标准 LED 灯头（在 +Z 方向 z 处） */
function ledHead(parts, y, z, dir = 1) {
  parts.push(box(0.36, 0.13, 0.8, 0, y, z * dir, C_POLE));
  parts.push(box(0.3, 0.03, 0.66, 0, y - 0.075, z * dir, [0.9, 0.9, 0.85], E_LED, 4.5));
}
/** 弯臂：从杆顶 (0,y0,0) 上挑到 (0,y0+rise,len) */
function arm(parts, y0, len, rise, dir = 1, r = 0.045) {
  const mid = [0, y0 + rise * 0.8, len * 0.45 * dir];
  parts.push(rod([0, y0 - 0.1, 0], mid, r, 6, C_POLE));
  parts.push(rod(mid, [0, y0 + rise, len * dir], r, 6, C_POLE));
}
function pole(parts, h, rb = 0.12, rt = 0.065, color = C_POLE) {
  parts.push(box(0.38, 0.6, 0.38, 0, 0.3, 0, C_DARK));
  parts.push(cyl(rt, rb, h - 0.6, 10, 0, 0.6 + (h - 0.6) / 2, 0, color));
}

/** 六角宫灯（中心 x,y,z） */
function palaceLantern(parts, x, y, z, r = 0.3, h = 0.66) {
  parts.push(cyl(r, r, h, 6, x, y, z, [0.95, 0.8, 0.55], E_WARM, 5));
  // 立柱
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    parts.push(box(0.04, h + 0.04, 0.04, x + Math.cos(a) * r, y, z + Math.sin(a) * r, C_BRONZE));
  }
  parts.push(cyl(0.02, r * 1.55, 0.28, 6, x, y + h / 2 + 0.14, z, C_BRONZE)); // 攒尖顶
  parts.push(cyl(r * 0.9, r * 1.1, 0.06, 6, x, y + h / 2 + 0.02, z, C_GOLD));
  parts.push(cyl(r * 1.05, r * 0.3, 0.16, 6, x, y - h / 2 - 0.08, z, C_BRONZE));
  parts.push(box(0.05, 0.45, 0.05, x, y - h / 2 - 0.38, z, C_RED, E_RED, 1.5)); // 流苏
}

/** 中国结（在 YZ 平面，面向道路方向行驶的车辆） */
function chineseKnot(parts, y, z, S = 0.85) {
  const t = 0.07;
  const add = (w, h, yy, zz, rot) => parts.push(box(t, h, w, 0, yy, zz, C_RED, E_RED, 3.2, rot, 0, 0));
  const q = Math.PI / 4;
  // 外菱形 4 边
  const L = S * 0.72, o = S * 0.25;
  add(L, t, y + o, z + o, q);
  add(L, t, y + o, z - o, -q);
  add(L, t, y - o, z + o, -q);
  add(L, t, y - o, z - o, q);
  // 内菱形
  const L2 = S * 0.4, o2 = S * 0.14;
  add(L2, t, y + o2, z + o2, q);
  add(L2, t, y + o2, z - o2, -q);
  add(L2, t, y - o2, z + o2, -q);
  add(L2, t, y - o2, z - o2, q);
  parts.push(box(t, 0.14, 0.14, 0, y, z, C_RED, E_RED, 3.2));
  // 顶环与流苏
  parts.push(box(t, 0.2, 0.06, 0, y + S * 0.6, z, C_GOLD));
  parts.push(box(0.05, 0.7, 0.18, 0, y - S * 0.85, z, C_RED, E_RED, 2.0));
  parts.push(box(0.08, 0.08, 0.22, 0, y - S * 0.5, z, C_GOLD));
}

function redLantern(parts, x, y, z) {
  parts.push(sphere(0.3, 1, 0.82, 1, x, y, z, C_RED, E_RED, 2.6, 10));
  parts.push(cyl(0.14, 0.14, 0.07, 8, x, y + 0.27, z, C_GOLD));
  parts.push(cyl(0.14, 0.14, 0.07, 8, x, y - 0.27, z, C_GOLD));
  parts.push(box(0.04, 0.34, 0.04, x, y - 0.48, z, [0.75, 0.55, 0.12], E_RED, 1.0));
}

/** 生成各灯型几何；返回 {geo, headY}（headY：灯头高度，用于远景光点） */
export function lampGeometries() {
  const out = {};
  // 普通单臂
  {
    const p = [];
    pole(p, 10);
    arm(p, 10, 2.3, 0.35);
    ledHead(p, 10.3, 2.55);
    out[LAMP.SINGLE] = { geo: mergeGeometries(p), head: [[0, 10.2, 2.55]] };
  }
  // 中央双臂
  {
    const p = [];
    pole(p, 11.5, 0.14, 0.075);
    arm(p, 11.5, 2.6, 0.4, 1);
    arm(p, 11.5, 2.6, 0.4, -1);
    ledHead(p, 11.85, 2.85, 1);
    ledHead(p, 11.85, 2.85, -1);
    out[LAMP.DOUBLE] = { geo: mergeGeometries(p), head: [[0, 11.75, 2.85], [0, 11.75, -2.85]] };
  }
  // 中国结装饰灯（东西南北大街/长安路）
  {
    const p = [];
    pole(p, 9.5, 0.13, 0.08, [0.3, 0.3, 0.32]);
    arm(p, 9.5, 1.7, 0.3, 1, 0.05);
    arm(p, 9.5, 1.7, 0.3, -1, 0.05);
    for (const d of [1, -1]) {
      p.push(box(0.46, 0.5, 0.46, 0, 9.55, 1.75 * d, [0.95, 0.9, 0.8], E_LED, 5));
      p.push(cyl(0.02, 0.4, 0.22, 4, 0, 9.91, 1.75 * d, [0.3, 0.3, 0.32]));
    }
    p.push(cyl(0.02, 0.09, 0.5, 8, 0, 9.75, 0, C_GOLD));
    chineseKnot(p, 5.6, 0.22, 0.9);
    out[LAMP.KNOT] = { geo: mergeGeometries(p), head: [[0, 9.55, 1.75], [0, 9.55, -1.75], [0, 5.6, 0.2]] };
  }
  // 唐风宫灯
  {
    const p = [];
    p.push(box(0.5, 0.7, 0.5, 0, 0.35, 0, [0.28, 0.26, 0.24]));
    p.push(cyl(0.11, 0.14, 6.6, 8, 0, 0.7 + 3.3, 0, C_BRONZE));
    p.push(box(0.12, 0.14, 2.5, 0, 6.9, 0, C_BRONZE)); // 横担（沿 Z）
    p.push(box(0.06, 0.3, 0.06, 0, 6.72, 1.1, C_BRONZE));
    p.push(box(0.06, 0.3, 0.06, 0, 6.72, -1.1, C_BRONZE));
    palaceLantern(p, 0, 6.1, 1.1, 0.26, 0.56);
    palaceLantern(p, 0, 6.1, -1.1, 0.26, 0.56);
    palaceLantern(p, 0, 7.5, 0, 0.32, 0.7);
    // 杆身云纹箍
    p.push(cyl(0.17, 0.17, 0.1, 8, 0, 2.2, 0, C_GOLD));
    p.push(cyl(0.16, 0.16, 0.1, 8, 0, 4.6, 0, C_GOLD));
    out[LAMP.PALACE] = { geo: mergeGeometries(p), head: [[0, 7.5, 0], [0, 6.1, 1.1], [0, 6.1, -1.1]] };
  }
  // 二环：单臂灯 + 一对红灯笼
  {
    const p = [];
    pole(p, 10);
    arm(p, 10, 2.3, 0.35);
    ledHead(p, 10.3, 2.55);
    p.push(box(0.06, 0.06, 1.3, 0, 6.6, 0, C_DARK)); // 挂架（沿 Z 两侧）
    redLantern(p, 0, 6.2, 0.55);
    redLantern(p, 0, 6.2, -0.55);
    out[LAMP.LANTERN] = { geo: mergeGeometries(p), head: [[0, 10.2, 2.55], [0, 6.2, 0.55], [0, 6.2, -0.55]] };
  }
  for (const k in out) out[k].geo.computeBoundingSphere();
  return out;
}

/**
 * 远景低模灯型（几百米外用）：一根 5 边形灯杆 + 每个灯头位置一个发光小盒（颜色/发光与完整灯型一致），
 * 每盏约 22~46 个三角形（完整灯型 120~500 个）。入参为 lampGeometries() 的结果，返回 {type: geometry}。
 */
export function lampGeometriesLow(full) {
  const out = {};
  const H = { [LAMP.SINGLE]: 10, [LAMP.DOUBLE]: 11.5, [LAMP.KNOT]: 9.5, [LAMP.PALACE]: 7.3, [LAMP.LANTERN]: 10 };
  const HEADCOL = {
    [LAMP.SINGLE]: [[0.9, 0.9, 0.85], E_LED, 4.5], [LAMP.DOUBLE]: [[0.9, 0.9, 0.85], E_LED, 4.5], [LAMP.KNOT]: [[0.95, 0.9, 0.8], E_LED, 5],
    [LAMP.PALACE]: [[0.95, 0.8, 0.55], E_WARM, 5], [LAMP.LANTERN]: [[0.9, 0.9, 0.85], E_LED, 4.5],
  };
  for (const k in full) {
    const t = +k;
    const p = [];
    const poleCol = t === LAMP.PALACE ? C_BRONZE : t === LAMP.KNOT ? [0.3, 0.3, 0.32] : C_POLE;
    const g = new THREE.CylinderGeometry(0.07, 0.12, H[t] || 10, 5, 1, true);
    g.translate(0, (H[t] || 10) / 2, 0);
    p.push(prep(g, poleCol));
    full[k].head.forEach(([hx, hy, hz], i) => {
      // 中国结 / 红灯笼的附加灯头是红色
      const red = (t === LAMP.KNOT && i === 2) || (t === LAMP.LANTERN && i > 0);
      const [c, e, s] = red ? [C_RED, E_RED, 2.6] : HEADCOL[t];
      const big = t === LAMP.PALACE || red;
      p.push(box(big ? 0.55 : 0.4, big ? 0.6 : 0.16, big ? 0.55 : 0.8, hx, hy, hz, c, e, s));
    });
    out[k] = mergeGeometries(p);
    out[k].computeBoundingSphere();
  }
  return out;
}

/** 路灯材质：顶点色 + aEmi（夜间自发光） */
export function lampMaterial(ctx) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.55 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = ctx.uniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aEmi;\nvarying vec3 vEmi;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmi = aEmi;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec3 vEmi;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmi * (0.04 + uNight);');
  };
  mat.customProgramCacheKey = () => 'roadLamp|v1';
  return mat;
}

/** 远景灯头光点（加法混合），近处由实例化灯头代替而逐渐淡出 */
export function lampPointsMaterial(ctx) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNight: ctx.uniforms.uNight,
      uScale: { value: 800 },
      uFog: { value: 3e-5 },
      uGain: { value: 0.9 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uScale;
      uniform float uFog;
      attribute vec3 color;
      varying vec3 vCol;
      varying float vA;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float d = max(-mvPosition.z, 1.0);
        float px = 1.5 * uScale / d;
        float ps = clamp(px, 2.0, 12.0);
        vA = clamp(px / ps, 0.0, 1.0) * smoothstep(90.0, 260.0, d) * exp(-uFog * d * 0.8);
        gl_PointSize = ps;
        gl_Position = projectionMatrix * mvPosition;
        vCol = color;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uNight;
      uniform float uGain;
      varying vec3 vCol;
      varying float vA;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 c = gl_PointCoord - 0.5;
        float r2 = dot(c, c) * 4.0;
        float a = exp(-r2 * 5.0) + 0.25 * exp(-r2 * 1.6);
        if (a * vA < 0.004) discard;
        gl_FragColor = vec4(vCol * a * vA * uNight * uGain, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return mat;
}
