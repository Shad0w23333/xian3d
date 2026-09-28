// 大唐不夜城：街道家具 / 人流 / 雕塑 / 灯光效果（程序化，实例化为主）。仅供 src/modules/datang.js 使用。
//
// 参考（research/refs/datang/ 与公开照片）：
//   · 步行街中轴为“中央景观带”：雕塑群台座 + 花坛 + 水景；两侧各约 25 m 步行道；
//   · 灯具：金色纹饰灯柱（约 7 m）+ 六角宫灯；树冠缠绕暖金色串灯；红灯笼成串悬挂；
//   · 雕塑：大唐群英谱（佛教/绘画/诗歌/书法/科技/天文医学）、贞观之治（太宗骑马群像）、房谋杜断、万国来朝、
//     武后行从、大唐文化柱、开元盛世碑、开元盛世（玄宗群像，开元广场）。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ───────────── 几何小工具 ─────────────
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** 统一属性（position/normal/color/tint），非索引 */
function prep(g, col, tint = 0, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  let geo = g.index ? g.toNonIndexed() : g;
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
  geo.applyMatrix4(_m);
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
  geo.computeVertexNormals();
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  const cc = new THREE.Color(col);
  for (let i = 0; i < n; i++) c.set([cc.r, cc.g, cc.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
  return geo;
}
const B = (w, h, d, col, tint, o) => prep(new THREE.BoxGeometry(w, h, d), col, tint, o);
const merge = (arr) => mergeGeometries(arr, false);

// ───────────── 人流 ─────────────
/** 现代游客（长裤）/ 汉服游客（长裙）；面朝 +Z，脚底 y=0，身高约 1.7 m。tint=1 的部位吃实例颜色 */
export function personGeometry(kind = 'modern') {
  const skin = 0xd9b08c, hair = 0x1c1714;
  const parts = [];
  if (kind === 'modern') {
    parts.push(B(0.15, 0.84, 0.17, 0x2c2f3a, 0.3, { x: -0.1, y: 0.42 }));
    parts.push(B(0.15, 0.84, 0.17, 0x2c2f3a, 0.3, { x: 0.1, y: 0.42 }));
    parts.push(B(0.4, 0.62, 0.23, 0xffffff, 1, { y: 1.14 }));
    parts.push(B(0.1, 0.6, 0.12, 0xffffff, 1, { x: -0.26, y: 1.12 }));
    parts.push(B(0.1, 0.6, 0.12, 0xffffff, 1, { x: 0.26, y: 1.12 }));
  } else {
    // 汉服：高腰长裙 + 宽袖 + 发髻
    parts.push(prep(new THREE.CylinderGeometry(0.17, 0.36, 1.05, 8, 1, true), 0xffffff, 1, { y: 0.525 }));
    parts.push(B(0.34, 0.5, 0.21, 0xffffff, 0.8, { y: 1.22 }));
    parts.push(B(0.16, 0.58, 0.2, 0xffffff, 1, { x: -0.25, y: 1.1 }));
    parts.push(B(0.16, 0.58, 0.2, 0xffffff, 1, { x: 0.25, y: 1.1 }));
    parts.push(B(0.12, 0.12, 0.14, hair, 0, { y: 1.78 }));
  }
  parts.push(prep(new THREE.IcosahedronGeometry(0.115, 0), skin, 0, { y: 1.6, sy: 1.12 }));
  parts.push(B(0.22, 0.07, 0.22, hair, 0, { y: 1.69 }));
  return merge(parts);
}

/**
 * 人流：全部在顶点着色器里行走（零 CPU）。walkers: Float32Array(n*4) = [x, zOffset, speed(±m/s，0=站立), phase]。
 * 高度沿 z 用 48 点采样表插值。返回 InstancedMesh（count 可按昼夜调整）。
 */
export function crowdMesh(ctx, geo, walkers, { z0, len, heights, hz0, hdz, colors, leg = 1 }) {
  const n = walkers.length / 4;
  const g = geo.clone();
  g.setAttribute('aWalk', new THREE.InstancedBufferAttribute(walkers, 4));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 });
  const U = { uZ0: { value: z0 }, uLen: { value: len }, uH: { value: heights }, uHz0: { value: hz0 }, uHdz: { value: hdz }, uLeg: { value: leg } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, { uTime: ctx.uniforms.uTime });
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aWalk; attribute float tint;
        uniform float uTime, uZ0, uLen, uHz0, uHdz, uLeg; uniform float uH[48];`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        float wSpd = aWalk.z;
        float wMov = step(0.001, abs(wSpd));
        float wYaw = wMov > 0.5 ? (wSpd > 0.0 ? 0.0 : 3.14159265) : aWalk.w * 6.2831853;
        float wc = cos(wYaw), ws = sin(wYaw);
        objectNormal = vec3(wc * objectNormal.x + ws * objectNormal.z, objectNormal.y, -ws * objectNormal.x + wc * objectNormal.z);`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float wPh = uTime * (2.2 + abs(wSpd) * 1.9) + aWalk.w * 40.0;
        float legK = max(0.0, 0.84 - transformed.y) * step(0.03, abs(transformed.x)) * uLeg;
        transformed.z += sin(wPh) * sign(transformed.x) * legK * 0.55 * wMov;
        float armK = step(0.2, abs(transformed.x)) * step(0.78, transformed.y) * max(0.0, 1.42 - transformed.y);
        transformed.z -= sin(wPh) * sign(transformed.x) * armK * 0.5 * wMov;
        transformed.y += abs(sin(wPh)) * 0.035 * wMov;
        transformed *= 0.9 + fract(aWalk.w * 7.13) * 0.18;
        transformed = vec3(wc * transformed.x + ws * transformed.z, transformed.y, -ws * transformed.x + wc * transformed.z);
        float wz = uZ0 + mod(aWalk.y + wSpd * uTime, uLen);
        float hi = clamp((wz - uHz0) / uHdz, 0.0, 46.999);
        int i0 = int(hi);
        float wy = mix(uH[i0], uH[i0 + 1], hi - float(i0));
        transformed += vec3(aWalk.x, wy, wz);`
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb = mix(color.rgb, color.rgb * instanceColor.rgb, tint);
        #endif`
      );
  };
  mat.customProgramCacheKey = () => 'dtCrowd' + leg;
  const mesh = new THREE.InstancedMesh(g, mat, n);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) mesh.setColorAt(i, c.set(colors[i % colors.length]));
  mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = '不夜城人流';
  return mesh;
}

// ───────────── 树（冠缠金色串灯） ─────────────
export function treeMeshes(ctx, pts, { seed = 3 } = {}) {
  // pts: [[x, y, z, scale], ...]
  const n = pts.length;
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 4.2, 7, 1);
  trunkGeo.translate(0, 2.1, 0);
  const crown = new THREE.IcosahedronGeometry(2.6, 2);
  // 树冠起伏
  const p = crown.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.16 * Math.sin(x * 2.1 + seed) * Math.cos(z * 1.7) + 0.1 * Math.sin(y * 3.3);
    p.setXYZ(i, x * k * 1.05, y * k * 0.78, z * k * 1.05);
  }
  crown.computeVertexNormals();
  crown.translate(0, 5.4, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.9, emissive: 0xffb45a, emissiveIntensity: 0 });
  // 树干缠灯：夜间整根暖金
  ctx.night.register(trunkMat, { day: 0, night: 0.45 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x3f5a2a, roughness: 0.85, emissive: 0x000000 });
  crownMat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTw;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 tw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            tw = instanceMatrix * tw;
          #endif
          vTw = (modelMatrix * tw).xyz;
        }`
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTw; uniform float uNight, uTime;
        float dtHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float hh = dtHash(floor(vTw * 3.2));
          float tw = 0.65 + 0.35 * sin(uTime * 2.3 + hh * 60.0);
          float dots = step(0.9, hh) * tw;
          totalEmissiveRadiance += vec3(1.0, 0.68, 0.28) * uNight * (0.06 + dots * 2.6);
        }`
      );
  };
  crownMat.customProgramCacheKey = () => 'dtCrown';
  const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
  const crownM = new THREE.InstancedMesh(crown, crownMat, n);
  const d = new THREE.Object3D();
  pts.forEach(([x, y, z, s], i) => {
    d.position.set(x, y, z);
    d.rotation.set(0, (i * 2.39) % 6.28, 0);
    d.scale.set(s, s * (0.92 + ((i * 0.37) % 0.2)), s);
    d.updateMatrix();
    trunk.setMatrixAt(i, d.matrix);
    crownM.setMatrixAt(i, d.matrix);
  });
  for (const m of [trunk, crownM]) {
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    m.castShadow = true;
    m.receiveShadow = true;
  }
  trunk.name = '行道树干';
  crownM.name = '行道树冠(串灯)';
  return [trunk, crownM];
}

// ───────────── 金色纹饰灯柱（宫灯） ─────────────
function lampParts() {
  const gold = [], glow = [], red = [];
  const G = (g) => gold.push(g);
  G(B(0.72, 0.55, 0.72, 0xffffff, 0, { y: 0.275 }));
  G(prep(new THREE.CylinderGeometry(0.46, 0.5, 0.35, 6), 0xffffff, 0, { y: 0.72 }));
  G(prep(new THREE.CylinderGeometry(0.1, 0.14, 6.6, 6), 0xffffff, 0, { y: 4.1 }));
  for (const y of [1.3, 2.6, 4.2, 5.7]) G(prep(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 6), 0xffffff, 0, { y }));
  G(prep(new THREE.SphereGeometry(0.22, 6, 4), 0xffffff, 0, { y: 3.4 }));
  // 横担 + 云头卷
  G(B(2.7, 0.12, 0.12, 0xffffff, 0, { y: 6.35 }));
  for (const s of [-1, 1]) G(prep(new THREE.TorusGeometry(0.18, 0.04, 4, 8), 0xffffff, 0, { x: s * 1.42, y: 6.2 }));
  // 两侧六角宫灯 + 顶灯
  for (const [x, y, r, h] of [[-1.15, 5.55, 0.32, 0.72], [1.15, 5.55, 0.32, 0.72], [0, 7.75, 0.4, 0.95]]) {
    glow.push(prep(new THREE.CylinderGeometry(r, r * 0.92, h, 6), 0xffffff, 0, { x, y }));
    G(prep(new THREE.CylinderGeometry(r * 0.35, r * 1.3, 0.2, 6), 0xffffff, 0, { x, y: y + h / 2 + 0.1 }));
    G(prep(new THREE.CylinderGeometry(r * 1.1, r * 0.6, 0.1, 6), 0xffffff, 0, { x, y: y - h / 2 - 0.05 }));
    G(prep(new THREE.ConeGeometry(0.06, 0.25, 5), 0xffffff, 0, { x, y: y + h / 2 + 0.32 }));
    red.push(prep(new THREE.ConeGeometry(0.07, 0.42, 5), 0xffffff, 0, { x, y: y - h / 2 - 0.3, rx: Math.PI }));
    if (x) G(prep(new THREE.CylinderGeometry(0.015, 0.015, 0.45, 4), 0xffffff, 0, { x, y: y + h / 2 + 0.45 }));
  }
  return { gold: merge(gold), glow: merge(glow), red: merge(red) };
}

export function lampMeshes(ctx, pts, mats) {
  const parts = lampParts();
  const out = [];
  for (const [k, geo] of Object.entries(parts)) {
    const im = new THREE.InstancedMesh(geo, mats[k], pts.length);
    const d = new THREE.Object3D();
    pts.forEach(([x, y, z, yaw], i) => {
      d.position.set(x, y, z);
      d.rotation.set(0, yaw || 0, 0);
      d.updateMatrix();
      im.setMatrixAt(i, d.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = k === 'gold';
    im.name = '灯柱:' + k;
    out.push(im);
  }
  return out;
}

// ───────────── 红灯笼（实例化） ─────────────
export function lanternInstances(pts, mat, { r = 0.3 } = {}) {
  const body = new THREE.SphereGeometry(r, 7, 5);
  body.scale(1, 1.18, 1);
  const cap = new THREE.CylinderGeometry(r * 0.45, r * 0.45, r * 0.25, 6, 1, true);
  cap.translate(0, r * 1.2, 0);
  const cap2 = cap.clone();
  cap2.translate(0, -r * 2.4, 0);
  const strip = (x) => {
    const y = x.index ? x.toNonIndexed() : x;
    for (const k of Object.keys(y.attributes)) if (k !== 'position' && k !== 'normal') y.deleteAttribute(k);
    return y;
  };
  const g = mergeGeometries([body, cap, cap2].map(strip), false);
  const im = new THREE.InstancedMesh(g, mat, pts.length);
  const d = new THREE.Object3D();
  pts.forEach(([x, y, z, s = 1], i) => {
    d.position.set(x, y, z);
    d.scale.setScalar(s);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.name = '红灯笼串';
  return im;
}

// ───────────── 地面光斑（贴花，夜间叠加） ─────────────
let _poolTex = null;
function poolTexture() {
  if (_poolTex) return _poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  _poolTex = new THREE.CanvasTexture(c);
  _poolTex.colorSpace = THREE.SRGBColorSpace;
  return _poolTex;
}
export function lightPools(ctx, pts, { color = 0xffa550, night = 0.55 } = {}) {
  const t = poolTexture();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: color, emissiveMap: t, emissiveIntensity: 0, alphaMap: t, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, roughness: 1,
  });
  ctx.overlay(mat, 0.0008);
  ctx.night.register(mat, { day: 0, night });
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const im = new THREE.InstancedMesh(geo, mat, pts.length);
  const d = new THREE.Object3D();
  pts.forEach(([x, y, z, s], i) => {
    d.position.set(x, y, z);
    d.scale.set(s, 1, s);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.renderOrder = 2;
  im.receiveShadow = false;
  im.name = '地面光斑';
  return im;
}

// ───────────── 光柱（探照灯束，夜间） ─────────────
export function lightBeams(ctx, pts, { h = 320, color = 0xffd9a0 } = {}) {
  const geo = new THREE.CylinderGeometry(9, 1.2, h, 16, 1, true);
  geo.translate(0, h / 2, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNight: ctx.uniforms.uNight, uColor: { value: new THREE.Color(color) }, uH: { value: h } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vY; varying vec3 vN; varying vec3 vV;
      void main() {
        vY = position.y;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uNight, uH; uniform vec3 uColor;
      varying float vY; varying vec3 vN; varying vec3 vV;
      void main() {
        #include <logdepthbuf_fragment>
        float t = vY / uH;
        float edge = pow(clamp(abs(dot(vN / max(length(vN), 1e-4), vV / max(length(vV), 1e-4))), 0.0, 1.0), 1.6);
        float a = (1.0 - t) * (1.0 - t) * edge * smoothstep(0.35, 0.8, uNight) * 0.55;
        gl_FragColor = vec4(uColor * a * 1.6, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const im = new THREE.InstancedMesh(geo, mat, pts.length);
  const d = new THREE.Object3D();
  pts.forEach(([x, y, z, tx, tz], i) => {
    d.position.set(x, y, z);
    d.rotation.set(tz || 0, 0, tx || 0);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.frustumCulled = false;
  im.renderOrder = 5;
  im.castShadow = false;
  im.name = '光柱';
  return im;
}

// ───────────── 雕塑：人物 / 骑马 / 坐像 ─────────────
/** 唐装立像（幞头、圆领袍、宽袖、执笏），高约 1.8 m，面朝 +Z */
export function figureGeometry(kind = 'stand') {
  const c = 0xffffff;
  const parts = [];
  const robe = (h, rb) => {
    const prof = [[0.001, 0], [rb, 0], [rb * 0.9, h * 0.22], [0.25, h * 0.55], [0.22, h * 0.77], [0.27, h * 0.93], [0.2, h], [0.001, h + 0.02]].map(([x, y]) => new THREE.Vector2(x, y));
    return prep(new THREE.LatheGeometry(prof, 10), c, 0);
  };
  if (kind === 'seated') {
    parts.push(B(0.7, 0.45, 0.6, c, 0, { y: 0.225 }));
    parts.push(prep(new THREE.LatheGeometry([[0.001, 0.45], [0.42, 0.45], [0.38, 0.62], [0.24, 0.9], [0.27, 1.12], [0.2, 1.2], [0.001, 1.22]].map(([x, y]) => new THREE.Vector2(x, y)), 10), c, 0));
    parts.push(B(0.6, 0.2, 0.5, c, 0, { y: 0.55, z: 0.28 }));
    parts.push(prep(new THREE.SphereGeometry(0.12, 8, 6), c, 0, { y: 1.33 }));
    parts.push(B(0.2, 0.13, 0.2, c, 0, { y: 1.47 }));
    parts.push(B(0.2, 0.3, 0.08, c, 0, { x: 0.25, y: 0.92, z: 0.2, rx: 0.9 }));
    return merge(parts);
  }
  parts.push(robe(1.5, kind === 'wide' ? 0.42 : 0.34));
  parts.push(prep(new THREE.SphereGeometry(0.12, 8, 6), c, 0, { y: 1.63 }));
  parts.push(B(0.2, 0.13, 0.2, c, 0, { y: 1.77 })); // 幞头
  parts.push(B(0.56, 0.03, 0.05, c, 0, { y: 1.75, z: -0.08 })); // 展脚
  if (kind === 'raise') {
    parts.push(B(0.17, 0.62, 0.2, c, 0, { x: -0.3, y: 1.05, rz: -0.12 }));
    parts.push(B(0.15, 0.6, 0.18, c, 0, { x: 0.36, y: 1.62, rz: 0.55 })); // 举臂吟诗
  } else {
    parts.push(B(0.2, 0.66, 0.24, c, 0, { x: -0.3, y: 1.05, rz: -0.14 }));
    parts.push(B(0.2, 0.66, 0.24, c, 0, { x: 0.3, y: 1.05, rz: 0.14 }));
    parts.push(B(0.08, 0.34, 0.03, c, 0, { y: 1.18, z: 0.26, rx: -0.25 })); // 笏板
  }
  return merge(parts);
}
/** 骑马像（马长约 2.8 m），骑者着袍 */
export function riderGeometry() {
  const c = 0xffffff;
  const parts = [];
  parts.push(prep(new THREE.SphereGeometry(0.5, 12, 8), c, 0, { y: 1.3, sx: 0.85, sy: 0.95, sz: 2.2 }));
  parts.push(B(0.34, 0.95, 0.5, c, 0, { y: 1.85, z: 0.95, rx: 0.55 })); // 颈
  parts.push(B(0.26, 0.3, 0.62, c, 0, { y: 2.2, z: 1.35, rx: 0.35 })); // 头
  parts.push(B(0.06, 0.5, 0.36, c, 0, { y: 2.05, z: 0.95, rx: 0.55 })); // 鬃
  for (const [x, z, r] of [[-0.22, 0.75, -0.25], [0.22, 0.8, 0.1], [-0.22, -0.8, 0.12], [0.22, -0.8, -0.2]]) parts.push(B(0.14, 1.1, 0.16, c, 0, { x, y: 0.55, z, rx: r }));
  parts.push(B(0.1, 0.8, 0.12, c, 0, { y: 1.1, z: -1.2, rx: -0.4 })); // 尾
  // 骑者
  parts.push(prep(new THREE.LatheGeometry([[0.001, 1.55], [0.3, 1.55], [0.24, 1.8], [0.21, 2.2], [0.26, 2.42], [0.19, 2.5], [0.001, 2.52]].map(([x, y]) => new THREE.Vector2(x, y)), 10), c, 0));
  for (const s of [-1, 1]) parts.push(B(0.14, 0.7, 0.2, c, 0, { x: s * 0.36, y: 1.35, z: 0.12, rx: 0.3 })); // 腿
  parts.push(B(0.18, 0.55, 0.22, c, 0, { x: -0.3, y: 2.15, z: 0.12, rx: -0.6 }));
  parts.push(B(0.16, 0.6, 0.2, c, 0, { x: 0.38, y: 2.4, z: 0.2, rx: -1.3, rz: 0.3 })); // 扬手
  parts.push(prep(new THREE.SphereGeometry(0.13, 8, 6), c, 0, { y: 2.64 }));
  parts.push(B(0.22, 0.14, 0.22, c, 0, { y: 2.79 }));
  return merge(parts);
}
/** 骆驼（万国来朝） */
export function camelGeometry() {
  const c = 0xffffff;
  const parts = [];
  parts.push(prep(new THREE.SphereGeometry(0.55, 12, 8), c, 0, { y: 1.55, sx: 0.8, sy: 0.8, sz: 1.9 }));
  parts.push(prep(new THREE.SphereGeometry(0.32, 8, 6), c, 0, { y: 2.05, z: 0.35 }));
  parts.push(prep(new THREE.SphereGeometry(0.32, 8, 6), c, 0, { y: 2.05, z: -0.4 }));
  parts.push(B(0.24, 0.9, 0.3, c, 0, { y: 1.95, z: 1.1, rx: -0.6 }));
  parts.push(B(0.22, 0.24, 0.5, c, 0, { y: 2.35, z: 1.45 }));
  for (const [x, z] of [[-0.22, 0.7], [0.22, 0.7], [-0.22, -0.75], [0.22, -0.75]]) parts.push(B(0.13, 1.25, 0.15, c, 0, { x, y: 0.62, z }));
  return merge(parts);
}

/** 石质台座（带须弥座收分），宽 w（x）深 d（z）高 h */
export function plinthGeometry(w, d, h) {
  const parts = [];
  parts.push(B(w + 0.6, 0.25, d + 0.6, 0xffffff, 0, { y: 0.125 }));
  parts.push(B(w, h - 0.5, d, 0xffffff, 0, { y: 0.25 + (h - 0.5) / 2 }));
  parts.push(B(w + 0.3, 0.25, d + 0.3, 0xffffff, 0, { y: h - 0.125 }));
  return merge(parts);
}
