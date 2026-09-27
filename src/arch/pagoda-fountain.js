// 大雁塔北广场音乐喷泉（亚洲最大矩阵式音乐喷泉之一）：多级叠水池 + 实例化水柱着色器 + 夜间彩色灯光。
//
// 资料：北广场东西宽约 218 m、南北长约 346 m（含两侧唐风群楼约 480×218 m 范围）；喷泉位于中轴，
// 由北端“音乐水池”（主喷、环喷、跑泉）、中段八级叠水池（矩阵喷头 + 两侧拱形跑泉）与南端跌水瀑布组成，
// 以 Esri 卫星影像核对：中轴 x≈1570，水池区 z≈4150~4440，宽约 56~62 m。
//
// 水柱：一个 InstancedMesh（开口圆管，y∈[0,1]），每个喷头的高度由顶点着色器按“时间编排程序”实时计算
// （6 段节目循环：齐喷呼吸 / 纵向波浪 / 交替跳泉 / 中心涟漪 / 左右摇摆 / 高潮主喷），不在 CPU 上逐帧更新。
// 夜间水柱按色相轮转着色并乘以 HDR 系数，交给泛光（Bloom）产生光晕；水面自发光随灯光色相变化。
import * as THREE from 'three';
import { heightToNormal, canvas, rng } from '../core/textures.js';

const JET_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec4 iA;   // x 类型(0 直喷 1 拱喷 2 主喷) y 轴向 u(0..1) z 横向 v(-1..1) w 最大高度
attribute vec4 iB;   // xy 拱喷方向  z 半径  w 相位
uniform float uTime, uNight;
varying float vS;
varying float vH;
varying vec3 vCol;
varying float vSeed;
varying float vType;

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
  else if (scene < 1.5) k = 0.15 + 0.85 * pow(0.5 + 0.5 * sin(t * 2.6 - u * 16.0), 1.5);
  else if (scene < 2.5) k = 0.12 + 0.88 * smoothstep(-0.35, 0.35, sin(t * 2.4 + ph * 3.14159));
  else if (scene < 3.5) k = 0.2 + 0.8 * (0.5 + 0.5 * sin(t * 2.8 - length(vec2((u - 0.5) * 5.0, v * 1.2)) * 4.0));
  else if (scene < 4.5) k = 0.2 + 0.8 * pow(0.5 + 0.5 * sin(t * 1.6 + v * 2.2), 2.0);
  else k = 0.82 + 0.18 * sin(t * 5.0 + ph * 6.28);
  // 拱喷在 2、4 段最活跃，主喷在 0、5 段冲高
  if (type > 0.5 && type < 1.5) k *= (scene > 1.5 && scene < 2.5) || (scene > 3.5 && scene < 4.5) ? 1.0 : 0.45;
  if (type > 1.5) k *= scene > 4.5 ? 1.0 : scene < 0.5 ? 0.7 : 0.28;
  return k * mix(0.12, 1.0, fade);
}

void main() {
  float scene;
  float k = jetK(uTime, iA.x, iA.y, iA.z, iB.w, scene);
  float H = iA.w * k;
  float s = position.y;
  vec2 ring = position.xz;
  float r = iB.z * (0.55 + 1.1 * s * s);
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
  float hueT = uTime * 0.035 + scene * 0.19;
  vec3 c1 = hue2rgb(fract(hueT + iA.y * 0.45 + iA.z * 0.08));
  vec3 c2 = hue2rgb(fract(hueT + 0.33 + iA.y * 0.2));
  vCol = mix(c1, c2, s * 0.6);
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
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
void main() {
  #include <logdepthbuf_fragment>
  if (vH < 0.08) discard;
  float streak = 0.6 + 0.4 * sin(vS * vH * 2.2 - uTime * 11.0 + vSeed * 17.0);
  float a = smoothstep(0.0, 0.04, vS) * (1.0 - 0.8 * smoothstep(0.55, 1.0, vS));
  if (vType > 0.5 && vType < 1.5) a = smoothstep(0.0, 0.05, vS) * (1.0 - 0.6 * smoothstep(0.7, 1.0, vS));
  vec3 day = vec3(0.78, 0.86, 0.92);
  vec3 nightC = mix(vec3(1.0), vCol, 0.82) * (2.2 + 1.6 * smoothstep(0.3, 1.0, vS));
  vec3 col = mix(day * 0.55, nightC, uNight);
  float alpha = a * streak * mix(0.55, 0.75, uNight);
  gl_FragColor = vec4(col, alpha);
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

/**
 * 构建喷泉。o: {cx 中轴 x, pools:[{z0, z1, w, y}]（水面高，北→南），front:{z0,z1,w,y}（北端音乐水池）, yGround}
 * 返回 {group, update(t, camDist)}
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
    color: 0x223a42, roughness: 0.06, metalness: 0.05, normalMap: nrm, normalScale: new THREE.Vector2(0.35, 0.35),
    emissive: 0x2266ff, emissiveIntensity: 0, envMapIntensity: 1.2,
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
  water.name = 'fountainWater';
  group.add(water);

  // ───── 喷头布置 ─────
  const jets = []; // [type, u, v, maxH, x, y, z, dx, dz, r, phase]
  const zN = o.front.z0, zS = o.pools[o.pools.length - 1].z1;
  const U = (z) => (zS - z) / (zS - zN); // 北端 u=1（主水池），南端 u=0
  const R = rng(5);
  {
    const f = o.front, fz = (f.z0 + f.z1) / 2, hw = f.w / 2 - 2;
    jets.push([2, U(fz), 0, 42, cx, f.y, fz, 0, 0, 1.0, 0]);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      jets.push([0, U(fz + Math.sin(a) * 9), Math.cos(a) * 0.3, 15, cx + Math.cos(a) * 9, f.y, fz + Math.sin(a) * 9, 0, 0, 0.28, (i % 2) * 1]);
    }
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      jets.push([0, U(fz + Math.sin(a) * 15), Math.cos(a) * 0.5, 9, cx + Math.cos(a) * 15, f.y, fz + Math.sin(a) * 15, 0, 0, 0.22, ((i + 1) % 2) * 1]);
    }
    for (const zz of [f.z0 + 2.2, f.z1 - 2.2])
      for (let i = 0; i <= 22; i++) {
        const x = cx - hw + (i / 22) * 2 * hw;
        jets.push([0, U(zz), (x - cx) / hw, 7 + 3 * Math.cos(((x - cx) / hw) * 1.57), x, f.y, zz, 0, 0, 0.16, i % 2]);
      }
    for (const sx of [-1, 1])
      for (let i = 0; i < 12; i++) {
        const zz = f.z0 + 3 + (i / 11) * (f.z1 - f.z0 - 6);
        jets.push([1, U(zz), sx, 4.5, cx + sx * (f.w / 2 - 1.2), f.y, zz, -sx, 0, 0.1, i % 2]);
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
        jets.push([0, U(z), v, center ? 13 : 6.5 + 2.5 * (1 - Math.abs(v)), x, p.y, z, 0, 0, center ? 0.34 : 0.2, (r + c + pi) % 2]);
      }
    for (const sx of [-1, 1])
      for (let i = 0; i < 6; i++) {
        const z = p.z0 + 2.5 + (i / 5) * (p.z1 - p.z0 - 5);
        jets.push([1, U(z), sx, 3.6, cx + sx * (p.w / 2 - 1.0), p.y, z, -sx, 0, 0.09, (i + pi) % 2]);
      }
  });
  for (const j of jets) j[10] += R() * 0.05;

  // 开口圆管（y∈[0,1]），径向 6 段
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
  const jetMat = new THREE.ShaderMaterial({
    vertexShader: JET_VS,
    fragmentShader: JET_FS,
    uniforms: {},
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  jetMat.uniforms.uTime = ctx.uniforms.uTime;
  jetMat.uniforms.uNight = ctx.uniforms.uNight;
  const jetMesh = new THREE.Mesh(jg, jetMat);
  jetMesh.frustumCulled = false;
  jetMesh.renderOrder = 5;
  jetMesh.name = 'fountainJets';
  group.add(jetMesh);

  // ───── 水花（喷头落水处的白色水雾盘） ─────
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
  const foamMat = new THREE.ShaderMaterial({
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
  float a = (1.0 - vRad * vRad) * clamp(vH / 6.0, 0.15, 0.8);
  vec3 col = mix(vec3(0.75, 0.8, 0.82), mix(vec3(1.0), vCol, 0.7) * 1.6, uNight);
  gl_FragColor = vec4(col, a * 0.6);
}`,
    uniforms: {},
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  foamMat.uniforms.uTime = ctx.uniforms.uTime;
  foamMat.uniforms.uNight = ctx.uniforms.uNight;
  const foam = new THREE.Mesh(foamGeo, foamMat);
  foam.frustumCulled = false;
  foam.renderOrder = 4;
  group.add(foam);

  const col = new THREE.Color();
  let lastT = -1;
  return {
    group,
    jetCount: n,
    update(t, camDist) {
      const vis = camDist < 4500;
      jetMesh.visible = foam.visible = vis;
      if (Math.abs(t - lastT) < 0.03) return;
      lastT = t;
      nrm.offset.set((t * 0.013) % 1, (t * 0.009) % 1);
      // 水面灯光：色相轮转（与水柱同一时钟）
      const scene = Math.floor((t % 72) / 12);
      const h = (t * 0.035 + scene * 0.19 + 0.1) % 1;
      col.setHSL(h, 0.85, 0.5);
      waterMat.emissive.copy(col);
      waterMat.emissiveIntensity = 0.02 + ctx.uniforms.uNight.value * 0.55;
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
