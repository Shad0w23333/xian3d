// 大唐不夜城：街道家具 / 人流 / 雕塑 / 灯光效果（程序化，实例化为主）。供 src/modules/datang.js 使用；
// personGeometry 另被 src/modules/pedestrians.js 复用（行走动画约定见 personGeometry 注释）。
//
// 参考（research/refs/datang/ 与公开照片）：
//   · 步行街中轴为“中央景观带”：雕塑群台座 + 花坛 + 水景；两侧各约 25 m 步行道；
//   · 灯具：金色纹饰灯柱（约 7 m）+ 六角宫灯；树冠缠绕暖金色串灯（密集的小光点，树形轮廓清楚）；红灯笼成串悬挂；
//   · 雕塑：大唐群英谱（佛教/绘画/诗歌/书法/科技/天文医学）、贞观之治（太宗骑马群像）、房谋杜断、万国来朝、
//     武后行从、大唐文化柱、开元盛世碑、开元盛世（玄宗群像，开元广场）。铜像为青铜本色（白天棕铜、有高光，不是黑块），
//     台座为花岗岩须弥座（上下枋、枭混线脚、束腰浮雕带）。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvas, heightToNormal } from '../core/textures.js';

// ───────────── 几何小工具 ─────────────
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);

/**
 * 统一属性（position/normal/color/tint），非索引。保留生成器的平滑法线（随矩阵变换），
 * 不再 computeVertexNormals（非索引几何上重算会变成逐面法线 → 雕塑、人像一块块的多面体感）。
 */
function prep(g, col, tint = 0, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  let geo = g.index ? g.toNonIndexed() : g;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
  geo.applyMatrix4(_m);
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
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
const V = (x, y, z) => new THREE.Vector3(x, y, z);
/** 两点间的圆台（a 端半径 r0，b 端半径 r1），seg 段；caps=false 为开口 */
function tube(a, b, r0, r1, seg, col, tint = 0, caps = false) {
  const d = new THREE.Vector3().subVectors(b, a);
  const L = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, !caps);
  g.translate(0, L / 2, 0);
  g.applyQuaternion(_q.setFromUnitVectors(UPV, d.normalize()));
  g.translate(a.x, a.y, a.z);
  return prep(g, col, tint);
}
/** 绕 Y 轴回转体：prof = [[r, y], ...]（自下而上） */
function lathe(prof, seg, col, tint = 0, o) {
  return prep(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y)), seg), col, tint, o);
}
const ball = (r, ws, hs, col, tint, o) => prep(new THREE.SphereGeometry(r, ws, hs), col, tint, o);

// ───────────── 人流 ─────────────
/**
 * 现代游客（长裤）/ 汉服游客（长裙）；面朝 +Z，脚底 y=0，身高约 1.72 m，约 230 个三角形。
 * 部位：鞋、腿、胯、躯干、颈、头（带发型）、上臂袖、前臂、手。tint=1 的部位（上衣/汉服）吃实例颜色，tint 0.3 为裤子（深色微染）。
 * 行走动画约定（crowdMesh 与 pedestrians.js 着色器共用）：|x|>0.03 且 y<0.84 的顶点为腿（前后摆）；
 * |x|>0.2 且 0.78<y<1.42 的顶点为手臂（以肩为轴反向摆）。因此腿与手臂几何都整段落在各自区间内，躯干半宽 < 0.2。
 */
export function personGeometry(kind = 'modern') {
  const skin = 0xd9ae88, hair = 0x1f1a17, shoe = 0x2b2725, pants = 0x2c3140;
  const parts = [];
  if (kind === 'modern') {
    for (const s of [-1, 1]) {
      parts.push(B(0.095, 0.07, 0.24, shoe, 0, { x: s * 0.1, y: 0.035, z: 0.03 }));
      parts.push(tube(V(s * 0.1, 0.06, 0), V(s * 0.1, 0.88, 0), 0.05, 0.07, 5, pants, 0.3));
    }
    parts.push(lathe([[0.15, 0.84], [0.158, 0.99]], 6, pants, 0.3, { sz: 0.72 }));
    parts.push(lathe([[0.158, 0.98], [0.172, 1.3], [0.166, 1.4], [0.075, 1.47]], 6, 0xffffff, 1, { sz: 0.66 }));
    for (const s of [-1, 1]) {
      parts.push(tube(V(s * 0.25, 1.42, 0), V(s * 0.252, 1.12, 0.005), 0.045, 0.04, 5, 0xffffff, 1)); // 短袖
      parts.push(tube(V(s * 0.252, 1.12, 0.005), V(s * 0.25, 0.79, 0.04), 0.035, 0.03, 5, skin, 0)); // 前臂 + 手
    }
  } else {
    // 汉服：高腰长裙 + 交领短襦 + 宽袖（手藏袖中）+ 腰带 + 发髻
    parts.push(lathe([[0.27, 0.01], [0.24, 0.25], [0.19, 0.6], [0.152, 0.95]], 6, 0xffffff, 1, { sz: 0.85 }));
    parts.push(lathe([[0.16, 0.9], [0.17, 1.3], [0.163, 1.4], [0.075, 1.47]], 6, 0xffffff, 0.8, { sz: 0.68 }));
    parts.push(lathe([[0.16, 0.93], [0.16, 1.0]], 6, 0xd8b25a, 0, { sz: 0.71 }));
    for (const s of [-1, 1]) parts.push(tube(V(s * 0.256, 1.42, 0), V(s * 0.275, 0.86, 0.02), 0.05, 0.074, 6, 0xffffff, 1)); // 宽袖
    parts.push(ball(0.062, 5, 3, hair, 0, { y: 1.795, z: -0.035 })); // 发髻
  }
  parts.push(tube(V(0, 1.44, 0), V(0, 1.53, 0.005), 0.046, 0.043, 4, skin, 0));
  parts.push(lathe([[0, 1.5], [0.085, 1.53], [0.1, 1.62], [0.088, 1.71], [0, 1.758]], 6, skin, 0, { sz: 1.1, z: 0.005 }));
  parts.push(lathe([[0.106, 1.62], [0.09, 1.735], [0, 1.776]], 6, hair, 0, { z: -0.012, sz: 1.12 }));
  return merge(parts);
}

/**
 * 人流：全部在顶点着色器里行走（零 CPU）。walkers: Float32Array(n*4) = [x, zOffset, speed(±m/s，0=站立), phase]。
 * 高度沿 z 用 48 点采样表插值。返回 InstancedMesh（count 可按昼夜调整）。夜间不自发光（亮度来自路灯/店面灯光与环境光）。
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
/** 树冠：3 个叠合的椭球团（平滑法线、顶亮底暗的顶点色），取代原先单个低多边形二十面体 */
function crownGeometry(seed) {
  let s = seed * 9301 + 49297;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const blobs = [[0, 5.5, 0, 2.35], [1.1 * (r() - 0.3), 5.0 + r() * 0.4, 1.0 * (r() - 0.5), 1.75], [-1.2 * r(), 5.3 + r() * 0.6, 0.9 * (r() - 0.3), 1.65]];
  const parts = [];
  for (const [x, y, z, R] of blobs) {
    const g = new THREE.IcosahedronGeometry(R, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const k = 1 + 0.07 * Math.sin(vx * 3.1 + seed) * Math.cos(vz * 2.7) + 0.05 * Math.sin(vy * 4.3);
      p.setXYZ(i, vx * k, vy * k * 0.8, vz * k);
    }
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    const m = mergeVerts(g);
    m.computeVertexNormals();
    m.translate(x, y, z);
    parts.push(m.toNonIndexed());
  }
  const g = mergeGeometries(parts, false);
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) - 3.6) / 4.0, 0, 1);
    const v = 0.62 + 0.45 * t;
    col.set([v * 0.95, v, v * 0.88], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return { geo: g, blobs };
}
function mergeVerts(g) {
  // 简单按坐标去重（IcosahedronGeometry 非索引输出），得到可平滑的索引几何
  const p = g.attributes.position, map = new Map(), idx = [], out = [];
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    let j = map.get(k);
    if (j === undefined) { j = out.length / 3; map.set(k, j); out.push(p.getX(i), p.getY(i), p.getZ(i)); }
    idx.push(j);
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  m.setIndex(idx);
  return m;
}

/**
 * 行道树：树干 + 树冠（白天正常绿树）+ 串灯光点（夜间，实例化公告板小光点，沿树冠外表面分布，近处是一颗颗小灯，
 * 远处按屏幕尺寸自动变淡，不会糊成白团）。pts: [[x, y, z, scale], ...]；返回 [树干, 树冠, 串灯]。
 */
export function treeMeshes(ctx, pts, { seed = 3, lightsPerTree = 140 } = {}) {
  const n = pts.length;
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.24, 4.4, 7, 1);
  trunkGeo.translate(0, 2.2, 0);
  const { geo: crown, blobs } = crownGeometry(seed);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.9, emissive: 0xffb45a, emissiveIntensity: 0 });
  ctx.night.register(trunkMat, { day: 0, night: 0.12 }); // 树干缠灯：夜间微亮
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x4d6e35, roughness: 0.85, vertexColors: true, emissive: 0xffa040, emissiveIntensity: 0 });
  ctx.night.register(crownMat, { day: 0, night: 0.035 }); // 串灯在叶面上的散射微光
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
  crownM.name = '行道树冠';

  // —— 串灯光点：每棵树 lightsPerTree 个，落在树冠各团的外表面（略外凸）——
  let rs = seed * 7919 + 13;
  const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
  const local = [];
  const vol = blobs.map((b) => b[3] ** 2);
  const tot = vol.reduce((a, v) => a + v, 0);
  for (let k = 0; k < lightsPerTree; k++) {
    let u = rnd() * tot, bi = 0;
    while (u > vol[bi] && bi < blobs.length - 1) u -= vol[bi++];
    const [bx, by, bz, R] = blobs[bi];
    const th = rnd() * Math.PI * 2, ph = Math.acos(1 - 2 * Math.pow(rnd(), 0.8)); // 偏上半球
    const rr = R * (1.0 + rnd() * 0.06);
    local.push([bx + Math.sin(ph) * Math.cos(th) * rr, by + Math.cos(ph) * rr * 0.8, bz + Math.sin(ph) * Math.sin(th) * rr, rnd()]);
  }
  const N = n * local.length;
  const lp = new Float32Array(N * 4);
  const v = new THREE.Vector3();
  const mtx = new THREE.Matrix4();
  for (let i = 0, o = 0; i < n; i++) {
    crownM.getMatrixAt(i, mtx);
    for (const [x, y, z, ph] of local) {
      v.set(x, y, z).applyMatrix4(mtx);
      lp.set([v.x, v.y, v.z, (ph + i * 0.137) % 1], o);
      o += 4;
    }
  }
  const lights = sprites(ctx, lp, { size: 0.075, minPx: 1.1, color: 0xffb860, intensity: 3.0, twinkle: 0.25, name: '行道树串灯' });
  return [trunk, crownM, lights];
}

/**
 * 夜间发光公告板点（实例化）：pts = Float32Array([x, y, z, 相位] × n)。
 * size：世界尺寸（米）；minPx：屏幕最小像素尺寸（远处保持可见，但按面积比例压低亮度，不会叠成白团，除非 keepEnergy=false）；
 * fade：[近淡出起点, 近淡出终点]（米，用于远景层：近处由真实几何表现）；intensity：HDR 亮度（交给泛光）。
 */
export function sprites(ctx, pts, { size = 0.1, minPx = 1, color = 0xffc070, intensity = 3, twinkle = 0, fade = null, keepEnergy = 0, name = '光点' } = {}) {
  const n = pts.length / 4;
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('iP', new THREE.InstancedBufferAttribute(pts, 4));
  g.instanceCount = n;
  const uVH = { value: 720 };
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNight: ctx.uniforms.uNight, uTime: ctx.uniforms.uTime, uVH, uColor: { value: new THREE.Color(color).multiplyScalar(intensity) },
      uSize: { value: size }, uMinPx: { value: minPx }, uTw: { value: twinkle }, uFade: { value: new THREE.Vector2(...(fade || [-1, 0])) }, uKeep: { value: keepEnergy },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 iP;
      uniform float uNight, uTime, uVH, uSize, uMinPx, uTw, uKeep;
      uniform vec2 uFade;
      varying vec2 vQ; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(iP.xyz, 1.0);
        float dist = max(-mv.z, 0.1);
        float py = uSize * projectionMatrix[1][1] / dist;            // 半尺寸（NDC）
        float pmin = uMinPx / uVH;
        float k = py / max(py, pmin);                                  // 被放大到最小像素时的面积补偿
        py = max(py, pmin);
        float a = smoothstep(0.3, 0.75, uNight) * mix(k * k, 1.0, uKeep);
        a *= 1.0 - uTw + uTw * (0.5 + 0.5 * sin(uTime * 2.6 + iP.w * 71.0));
        if (uFade.y > 0.0) a *= smoothstep(uFade.x, uFade.y, dist);
        vA = a;
        vQ = position.xy;
        gl_Position = projectionMatrix * mv;
        gl_Position.xy += position.xy * vec2(py * projectionMatrix[0][0] / projectionMatrix[1][1], py) * gl_Position.w;
        if (a < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      varying vec2 vQ; varying float vA;
      void main() {
        #include <logdepthbuf_fragment>
        float r2 = dot(vQ, vQ);
        if (r2 > 1.0) discard;
        float f = exp(-r2 * 3.2);
        gl_FragColor = vec4(uColor * f * vA, 1.0); // 加色混合（SRC_ALPHA, ONE）：alpha 必须为 1，亮度已乘进颜色
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.renderOrder = 4;
  mesh.name = name;
  const vs = new THREE.Vector2();
  mesh.onBeforeRender = (renderer) => { uVH.value = Math.max(1, renderer.getDrawingBufferSize(vs).y); };
  return mesh;
}

/**
 * 远景金色光带（不夜城远景 LOD）：沿步行街灯位/檐口布置的屏幕尺寸受控光点，2~20 km 外合成一条连续的金色光带。
 * pts: [[x, y, z], ...]；近处（< fade[0]）不显示（由真实灯具几何表现）。
 */
export function farGlow(ctx, pts, { size = 6, minPx = 1.8, color = 0xffb24a, intensity = 0.55, fade = [1400, 2600] } = {}) {
  const a = new Float32Array(pts.length * 4);
  pts.forEach(([x, y, z], i) => a.set([x, y, z, (i * 0.618) % 1], i * 4));
  return sprites(ctx, a, { size, minPx, color, intensity, fade, keepEnergy: 1, name: '不夜城远景光带' });
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
export function lightBeams(ctx, pts, { h = 320, color = 0xffd9a0, alpha = 0.55 } = {}) {
  const geo = new THREE.CylinderGeometry(9, 1.2, h, 16, 1, true);
  geo.translate(0, h / 2, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNight: ctx.uniforms.uNight, uColor: { value: new THREE.Color(color) }, uH: { value: h }, uA: { value: alpha } },
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
      uniform float uNight, uH, uA; uniform vec3 uColor;
      varying float vY; varying vec3 vN; varying vec3 vV;
      void main() {
        #include <logdepthbuf_fragment>
        float t = vY / uH;
        float edge = pow(clamp(abs(dot(vN / max(length(vN), 1e-4), vV / max(length(vV), 1e-4))), 0.0, 1.0), 1.6);
        float a = (1.0 - t) * (1.0 - t) * edge * smoothstep(0.35, 0.8, uNight) * uA;
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

// ───────────── 雕塑：人物 / 骑马 / 坐像（青铜，平滑法线） ─────────────
const C = 0xffffff;
/** 头部 + 幞头（展脚可选）。原点：颈根 y0 */
function headWithFutou(parts, y0, { z = 0, wings = true, beard = false } = {}) {
  parts.push(tube(V(0, y0, z), V(0, y0 + 0.1, z + 0.01), 0.055, 0.05, 6, C));
  const h = y0 + 0.06;
  parts.push(lathe([[0, h], [0.07, h + 0.02], [0.1, h + 0.08], [0.105, h + 0.15], [0.09, h + 0.22], [0, h + 0.265]], 8, C, 0, { z: z + 0.005, sz: 1.08 }));
  parts.push(prep(new THREE.ConeGeometry(0.022, 0.05, 5), C, 0, { y: h + 0.13, z: z + 0.11, rx: Math.PI / 2 })); // 鼻
  // 幞头：圆顶软裹 + 后部高起的巾子 + 两侧展脚
  parts.push(lathe([[0.113, h + 0.15], [0.116, h + 0.2], [0.1, h + 0.255], [0.06, h + 0.285], [0, h + 0.29]], 8, C, 0, { z: z - 0.005, sz: 1.08 }));
  parts.push(ball(0.065, 6, 4, C, 0, { y: h + 0.3, z: z - 0.04, sy: 1.25 }));
  if (wings) for (const s of [-1, 1]) parts.push(B(0.3, 0.02, 0.035, C, 0, { x: s * 0.24, y: h + 0.24, z: z - 0.07, rz: s * 0.08 }));
  if (beard) parts.push(prep(new THREE.ConeGeometry(0.05, 0.16, 6), C, 0, { y: h + 0.0, z: z + 0.07, rx: Math.PI }));
}
/** 唐装立像（幞头、圆领袍、束带、宽袖、执笏），高约 1.85 m，面朝 +Z */
export function figureGeometry(kind = 'stand') {
  const parts = [];
  if (kind === 'seated') {
    // 坐像：方凳 + 下摆垂地的袍 + 前伸的膝 + 上身
    parts.push(B(0.7, 0.42, 0.55, C, 0, { y: 0.21, z: -0.05 }));
    parts.push(lathe([[0.4, 0], [0.4, 0.2], [0.36, 0.45], [0.27, 0.58]], 9, C, 0, { sz: 0.8 }));
    for (const s of [-1, 1]) parts.push(tube(V(s * 0.13, 0.52, 0.0), V(s * 0.14, 0.52, 0.42), 0.12, 0.11, 6, C, 0, true)); // 大腿
    parts.push(B(0.56, 0.42, 0.12, C, 0, { y: 0.26, z: 0.42 })); // 垂下的前襟
    parts.push(lathe([[0.25, 0.55], [0.22, 0.7], [0.24, 0.9], [0.24, 1.0], [0.14, 1.07], [0.06, 1.1]], 12, C, 0, { sz: 0.78 }));
    for (const s of [-1, 1]) {
      parts.push(tube(V(s * 0.22, 1.0, 0), V(s * 0.27, 0.74, 0.1), 0.07, 0.09, 6, C));
      parts.push(tube(V(s * 0.27, 0.74, 0.1), V(s * 0.12, 0.66, 0.36), 0.09, 0.13, 6, C)); // 宽袖搭在膝上
    }
    headWithFutou(parts, 1.06, { beard: true });
    return merge(parts);
  }
  const h = 1.5, rb = kind === 'wide' ? 0.42 : 0.33;
  // 圆领袍：下摆外撇、腰部束带、胸背饱满
  parts.push(lathe([[rb, 0], [rb * 0.93, h * 0.12], [rb * 0.8, h * 0.35], [0.235, h * 0.56], [0.215, h * 0.63], [0.235, h * 0.72], [0.255, h * 0.85], [0.24, h * 0.93], [0.15, h * 0.975], [0.06, h], [0, h + 0.01]], 9, C, 0, { sz: 0.78 }));
  parts.push(lathe([[0.226, h * 0.6], [0.236, h * 0.62], [0.226, h * 0.645]], 9, C, 0, { sz: 0.8 })); // 革带
  parts.push(B(0.2, 0.03, 0.05, C, 0, { y: h * 0.25, z: rb * 0.62 })); // 前襟褶
  for (const s of [-1, 1]) parts.push(B(0.1, 0.07, 0.18, C, 0, { x: s * 0.1, y: 0.035, z: 0.24 })); // 靴尖
  const sh = h - 0.08;
  if (kind === 'raise') {
    // 左臂下垂执卷、右臂高举吟诗
    parts.push(tube(V(-0.23, sh, 0), V(-0.3, 1.05, 0.06), 0.075, 0.1, 6, C));
    parts.push(tube(V(-0.3, 1.05, 0.06), V(-0.28, 0.82, 0.12), 0.1, 0.13, 6, C)); // 垂袖
    parts.push(tube(V(-0.27, 0.95, 0.18), V(-0.27, 1.2, 0.2), 0.04, 0.04, 6, C, 0, true)); // 书卷
    parts.push(tube(V(0.23, sh, 0), V(0.38, sh + 0.14, 0.1), 0.075, 0.085, 6, C));
    parts.push(tube(V(0.38, sh + 0.14, 0.1), V(0.46, sh + 0.42, 0.2), 0.085, 0.12, 6, C));
    parts.push(ball(0.045, 6, 4, C, 0, { x: 0.47, y: sh + 0.48, z: 0.22 }));
  } else if (kind === 'wide') {
    // 武将：双手按带，袖摆外张
    for (const s of [-1, 1]) {
      parts.push(tube(V(s * 0.25, sh, 0), V(s * 0.42, 1.12, 0.04), 0.085, 0.1, 6, C));
      parts.push(tube(V(s * 0.42, 1.12, 0.04), V(s * 0.22, 0.95, 0.16), 0.1, 0.12, 6, C));
      parts.push(tube(V(s * 0.4, 1.1, 0.0), V(s * 0.42, 0.8, -0.02), 0.1, 0.15, 6, C)); // 垂袖
    }
    parts.push(tube(V(0.3, 0.2, 0.25), V(0.3, 1.25, 0.25), 0.025, 0.025, 6, C)); // 仪刀（立于身侧）
  } else {
    // 文臣：双手于胸前执笏，宽袖下垂
    for (const s of [-1, 1]) {
      parts.push(tube(V(s * 0.23, sh, 0), V(s * 0.27, 1.06, 0.07), 0.075, 0.09, 6, C));
      parts.push(tube(V(s * 0.27, 1.06, 0.07), V(s * 0.07, 1.12, 0.25), 0.09, 0.13, 6, C));
      parts.push(tube(V(s * 0.2, 1.1, 0.17), V(s * 0.18, 0.78, 0.15), 0.12, 0.07, 6, C)); // 垂袖
    }
    parts.push(B(0.075, 0.38, 0.022, C, 0, { y: 1.3, z: 0.29, rx: -0.22 })); // 笏板
  }
  headWithFutou(parts, h - 0.01, { beard: kind !== 'raise' });
  return merge(parts);
}
/** 马腿：上段（前臂/大腿）+ 下段（管骨）+ 蹄；a 根部，k 膝/飞节，f 球节 */
function horseLeg(parts, a, k, f, r = 1) {
  parts.push(tube(a, k, 0.13 * r, 0.075 * r, 6, C));
  parts.push(ball(0.075 * r, 6, 4, C, 0, { x: k.x, y: k.y, z: k.z }));
  parts.push(tube(k, f, 0.06 * r, 0.05 * r, 7, C));
  const hoofDir = new THREE.Vector3().subVectors(f, k).normalize();
  parts.push(tube(f, f.clone().addScaledVector(hoofDir, 0.12), 0.055 * r, 0.075 * r, 7, C, 0, true));
}
/** 骑马像（马身长约 2.6 m、肩高约 1.6 m），骑者着袍、左手执缰右手前指；前左腿抬起作行进状。面朝 +Z */
export function riderGeometry() {
  const parts = [];
  // 马身：沿 z 的回转体（胸宽臀圆）
  parts.push(lathe([[0, -1.05], [0.28, -0.96], [0.4, -0.7], [0.42, -0.25], [0.4, 0.2], [0.42, 0.55], [0.36, 0.85], [0.2, 1.0], [0, 1.04]], 14, C, 0, { rx: Math.PI / 2, y: 1.35, sx: 0.82 }));
  // 颈、头、耳、鬃
  parts.push(tube(V(0, 1.5, 0.78), V(0, 2.12, 1.22), 0.3, 0.16, 10, C));
  parts.push(tube(V(0, 2.18, 1.2), V(0, 1.95, 1.72), 0.15, 0.085, 10, C, 0, true));
  parts.push(ball(0.15, 8, 6, C, 0, { y: 2.16, z: 1.22, sz: 1.15 }));
  for (const s of [-1, 1]) parts.push(prep(new THREE.ConeGeometry(0.035, 0.14, 5), C, 0, { x: s * 0.07, y: 2.33, z: 1.2, rx: -0.3 }));
  parts.push(B(0.06, 0.12, 0.62, C, 0, { y: 2.06, z: 1.0, rx: -0.95 }));
  // 腿：前右支撑、前左抬起；后腿飞节向后弯
  horseLeg(parts, V(0.2, 1.15, 0.72), V(0.21, 0.6, 0.76), V(0.21, 0.14, 0.74));
  horseLeg(parts, V(-0.2, 1.15, 0.72), V(-0.21, 0.82, 0.98), V(-0.21, 0.6, 0.88));
  for (const s of [-1, 1]) horseLeg(parts, V(s * 0.22, 1.25, -0.72), V(s * 0.23, 0.68, -0.92), V(s * 0.23, 0.14, -0.8), 1.08);
  parts.push(tube(V(0, 1.55, -1.0), V(0, 0.85, -1.28), 0.09, 0.05, 7, C)); // 尾
  // 鞍、障泥
  parts.push(B(0.86, 0.1, 0.62, C, 0, { y: 1.77, z: 0.02 }));
  for (const s of [-1, 1]) parts.push(B(0.03, 0.42, 0.58, C, 0, { x: s * 0.36, y: 1.5, z: 0.02 }));
  // 骑者
  parts.push(lathe([[0.2, 1.78], [0.215, 1.9], [0.2, 2.08], [0.23, 2.28], [0.21, 2.4], [0.08, 2.47], [0, 2.48]], 12, C, 0, { sz: 0.78, z: 0.02 }));
  for (const s of [-1, 1]) {
    parts.push(tube(V(s * 0.16, 1.86, 0.02), V(s * 0.4, 1.62, 0.22), 0.12, 0.1, 6, C)); // 大腿（袍裹）
    parts.push(tube(V(s * 0.4, 1.62, 0.22), V(s * 0.38, 1.12, 0.12), 0.08, 0.06, 6, C)); // 小腿
    parts.push(B(0.09, 0.1, 0.22, C, 0, { x: s * 0.38, y: 1.08, z: 0.18 })); // 靴
    parts.push(tube(V(s * 0.2, 1.84, 0.0), V(s * 0.36, 1.5, -0.12), 0.14, 0.2, 6, C)); // 袍摆垂于马侧
  }
  parts.push(tube(V(-0.22, 2.36, 0.02), V(-0.3, 2.06, 0.22), 0.075, 0.08, 6, C));
  parts.push(tube(V(-0.3, 2.06, 0.22), V(-0.1, 1.98, 0.48), 0.08, 0.1, 6, C)); // 执缰
  parts.push(tube(V(0.22, 2.36, 0.02), V(0.38, 2.42, 0.3), 0.075, 0.085, 6, C));
  parts.push(tube(V(0.38, 2.42, 0.3), V(0.46, 2.55, 0.66), 0.085, 0.1, 6, C)); // 前指
  parts.push(tube(V(-0.1, 1.98, 0.48), V(0, 2.02, 1.5), 0.012, 0.012, 4, C)); // 缰绳
  headWithFutou(parts, 2.46, { z: 0.02, beard: true });
  return merge(parts);
}
/** 骆驼（万国来朝）：双峰、长颈前探、细长腿 */
export function camelGeometry() {
  const parts = [];
  parts.push(lathe([[0, -0.95], [0.3, -0.85], [0.44, -0.5], [0.46, 0.1], [0.42, 0.55], [0.26, 0.85], [0, 0.92]], 14, C, 0, { rx: Math.PI / 2, y: 1.6, sx: 0.8 }));
  for (const z of [0.35, -0.38]) parts.push(lathe([[0.3, 0], [0.26, 0.2], [0.14, 0.38], [0, 0.44]], 10, C, 0, { y: 1.88, z, sx: 0.9, sz: 1.2 }));
  parts.push(tube(V(0, 1.65, 0.78), V(0, 1.75, 1.28), 0.24, 0.13, 9, C));
  parts.push(tube(V(0, 1.72, 1.26), V(0, 2.25, 1.42), 0.13, 0.11, 9, C));
  parts.push(tube(V(0, 2.32, 1.38), V(0, 2.2, 1.82), 0.13, 0.08, 9, C, 0, true));
  parts.push(ball(0.13, 8, 6, C, 0, { y: 2.3, z: 1.4 }));
  for (const [x, z, kz] of [[-0.22, 0.6, 0.66], [0.22, 0.62, 0.66], [-0.22, -0.65, -0.78], [0.22, -0.65, -0.78]]) horseLeg(parts, V(x, 1.35, z), V(x * 1.05, 0.72, kz), V(x * 1.05, 0.12, z), 0.95);
  parts.push(tube(V(0, 1.75, -0.92), V(0, 1.15, -1.05), 0.05, 0.03, 6, C));
  // 驼囊
  for (const s of [-1, 1]) parts.push(B(0.16, 0.42, 0.55, C, 0, { x: s * 0.46, y: 1.65, z: 0 }));
  return merge(parts);
}

/** 矩形台的收分段（无底面）：底 w0×d0 → 顶 w1×d1，y0→y1 */
function frust(w0, d0, w1, d1, y0, y1) {
  const a = [[-w0 / 2, y0, -d0 / 2], [w0 / 2, y0, -d0 / 2], [w0 / 2, y0, d0 / 2], [-w0 / 2, y0, d0 / 2]];
  const b = [[-w1 / 2, y1, -d1 / 2], [w1 / 2, y1, -d1 / 2], [w1 / 2, y1, d1 / 2], [-w1 / 2, y1, d1 / 2]];
  const pos = [];
  const quad = (p, q, r, s) => pos.push(...p, ...q, ...r, ...p, ...r, ...s);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(a[j], a[i], b[i], b[j]);
  }
  quad(b[0], b[3], b[2], b[1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/**
 * 石质须弥座台座，宽 w（x）深 d（z）高 h：圭脚 / 下枋 / 下枭 / 束腰 / 上枭 / 上枋 / 顶面压边。
 * 束腰的浮雕带另由 plinthRelief 生成（单独的浮雕材质）。
 */
export function plinthGeometry(w, d, h) {
  const parts = [];
  const band = (w0, d0, w1, d1, y0, y1) => parts.push(prep(frust(w0, d0, w1, d1, y0, y1), C, 0));
  const yW0 = 0.42, yW1 = h - 0.42; // 束腰上下
  band(w + 0.7, d + 0.7, w + 0.7, d + 0.7, 0, 0.16); // 圭脚
  band(w + 0.5, d + 0.5, w + 0.5, d + 0.5, 0.16, 0.3); // 下枋
  band(w + 0.5, d + 0.5, w + 0.06, d + 0.06, 0.3, yW0); // 下枭
  band(w - 0.02, d - 0.02, w - 0.02, d - 0.02, yW0, yW1); // 束腰（芯）
  band(w + 0.06, d + 0.06, w + 0.42, d + 0.42, yW1, yW1 + 0.12); // 上枭
  band(w + 0.42, d + 0.42, w + 0.42, d + 0.42, yW1 + 0.12, h - 0.06); // 上枋
  band(w + 0.36, d + 0.36, w + 0.3, d + 0.3, h - 0.06, h); // 压面
  return merge(parts);
}
/** 须弥座束腰浮雕带：四面贴面（外凸 1 cm），UV：u = 沿周长米数 / 2.4（一块“壸门 + 祥云”浮雕单元），v = 0..1 */
export function plinthRelief(w, d, h) {
  const yW0 = 0.42, yW1 = h - 0.42;
  if (yW1 - yW0 < 0.2) return null;
  const hw = (w - 0.02) / 2 + 0.012, hd = (d - 0.02) / 2 + 0.012;
  const pos = [], uv = [], nrm = [];
  let u0 = 0;
  const face = (ax, az, bx, bz, nx, nz) => {
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(L / 2.4));
    const u1 = u0 + n;
    const P = [[ax, yW0, az, u0, 0], [bx, yW0, bz, u1, 0], [bx, yW1, bz, u1, 1], [ax, yW1, az, u0, 1]];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(P[k][0], P[k][1], P[k][2]);
      uv.push(P[k][3], P[k][4]);
      nrm.push(nx, 0, nz);
    }
    u0 = u1;
  };
  face(-hw, hd, hw, hd, 0, 1);
  face(hw, hd, hw, -hd, 1, 0);
  face(hw, -hd, -hw, -hd, 0, -1);
  face(-hw, -hd, -hw, hd, -1, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
/** 浮雕带材质：壸门框 + 卷草祥云（高度图 → 法线贴图 + 凹处压暗的颜色贴图） */
export function reliefMaterial() {
  const W = 512, H = 160;
  const hc = canvas(W, H), g = hc.getContext('2d');
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, W, H);
  // 两侧间柱（凸）
  g.fillStyle = '#d0d0d0';
  g.fillRect(0, 0, 18, H);
  g.fillRect(W - 18, 0, 18, H);
  // 壸门：凹入的花瓣形龛
  g.fillStyle = '#5a5a5a';
  g.beginPath();
  g.moveTo(40, H - 16);
  g.lineTo(40, 52);
  g.quadraticCurveTo(70, 50, 86, 30);
  g.quadraticCurveTo(110, 46, 150, 26);
  g.quadraticCurveTo(W / 2, 4, W - 150, 26);
  g.quadraticCurveTo(W - 110, 46, W - 86, 30);
  g.quadraticCurveTo(W - 70, 50, W - 40, 52);
  g.lineTo(W - 40, H - 16);
  g.closePath();
  g.fill();
  // 龛内卷草祥云（凸起）
  g.strokeStyle = '#d8d8d8';
  g.lineCap = 'round';
  const scroll = (cx, cy, r, dir) => {
    g.lineWidth = 7;
    g.beginPath();
    for (let t = 0; t <= 1.0; t += 0.02) {
      const a = dir * t * Math.PI * 3.2, rr = r * (1 - t * 0.8);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.75;
      t ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  };
  for (let i = 0; i < 5; i++) {
    const cx = 90 + i * 83, cy = 92 + (i % 2 ? -8 : 10);
    scroll(cx, cy, 26, i % 2 ? 1 : -1);
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(cx - 28, cy + 22);
    g.bezierCurveTo(cx - 5, cy + 40, cx + 30, cy + 8, cx + 56, cy + 24);
    g.stroke();
  }
  const nm = new THREE.CanvasTexture(heightToNormal(hc, 3.2));
  nm.wrapS = nm.wrapT = THREE.RepeatWrapping;
  nm.colorSpace = THREE.NoColorSpace;
  // 颜色：浅灰白花岗岩，凹处略暗（近似环境光遮蔽）
  const cc = canvas(W, H), cg = cc.getContext('2d');
  const src = g.getImageData(0, 0, W, H).data;
  const img = cg.createImageData(W, H);
  for (let i = 0; i < src.length; i += 4) {
    const k = 0.72 + 0.28 * (src[i] / 255);
    img.data[i] = 222 * k;
    img.data[i + 1] = 214 * k;
    img.data[i + 2] = 198 * k;
    img.data[i + 3] = 255;
  }
  cg.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(cc);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({ map, normalMap: nm, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.72 });
  m.name = 'datang.relief';
  return m;
}
