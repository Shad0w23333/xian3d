// 通用工具：几何合批、米制 UV、多边形/折线运算、覆盖层深度偏移
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
export { rng } from './textures.js';

/** 按法线主轴生成以“米”为单位的 UV（墙面用 (水平, 高度)，顶面用 (x, z)） */
export function worldBoxUV(geo, scale = 1, matrix = null) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  const v = new THREE.Vector3(), nn = new THREE.Vector3();
  const nm = matrix ? new THREE.Matrix3().getNormalMatrix(matrix) : null;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    nn.fromBufferAttribute(n, i);
    if (matrix) {
      v.applyMatrix4(matrix);
      nn.applyMatrix3(nm).normalize();
    }
    const ax = Math.abs(nn.x), ay = Math.abs(nn.y), az = Math.abs(nn.z);
    let u, w;
    if (ay >= ax && ay >= az) { u = v.x; w = v.z; }
    else if (ax >= az) { u = v.z * Math.sign(nn.x || 1); w = v.y; }
    else { u = -v.x * Math.sign(nn.z || 1); w = v.y; }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = w * scale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * 几何合批器：按材质把大量零件合成少量网格。
 *   const b = new Batcher();
 *   b.add(geometry, material, matrix?)   // geometry 会被复制并烘焙矩阵
 *   const group = b.build({castShadow:true, receiveShadow:true})
 */
export class Batcher {
  constructor() {
    this.buckets = new Map();
  }
  add(geometry, material, matrix = null, { worldUV = 0 } = {}) {
    let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (worldUV) g = worldBoxUV(g, worldUV);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
    const key = material.uuid;
    if (!this.buckets.has(key)) this.buckets.set(key, { material, geos: [] });
    this.buckets.get(key).geos.push(g);
    return this;
  }
  build({ castShadow = true, receiveShadow = true, name = 'batch' } = {}) {
    const group = new THREE.Group();
    group.name = name;
    for (const { material, geos } of this.buckets.values()) {
      const hasColor = geos.some((g) => g.attributes.color);
      if (hasColor)
        for (const g of geos)
          if (!g.attributes.color) {
            const c = new Float32Array(g.attributes.position.count * 3).fill(1);
            g.setAttribute('color', new THREE.BufferAttribute(c, 3));
          }
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const m = new THREE.Mesh(merged, material);
      m.castShadow = castShadow;
      m.receiveShadow = receiveShadow;
      group.add(m);
    }
    this.buckets.clear();
    return group;
  }
}

// ---------- 多边形 ----------
export function polyArea(p) {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}
export function polyCentroid(p) {
  let x = 0, z = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) { x += p[i * 2]; z += p[i * 2 + 1]; }
  return { x: x / n, z: z / n };
}
export function pointInPoly(x, z, p) {
  let c = false;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
export function polyBBox(p) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
  }
  return { x0, x1, z0, z1 };
}
/** 矩形多边形（中心、宽、深、旋转弧度：绕 Y 轴，0 = 宽沿 X） */
export function rectPoly(cx, cz, w, d, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  return pts.flatMap(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c]);
}
export function circlePoly(cx, cz, r, n = 24) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
  }
  return out;
}
/** 扁平数组 [x,z,...] -> THREE.Shape（注意：Shape 的 y 对应世界 -z，便于 rotateX(-90°) 后落在 XZ 平面） */
export function toShape(p, holes = []) {
  const s = new THREE.Shape();
  for (let i = 0; i < p.length; i += 2) (i ? s.lineTo(p[i], -p[i + 1]) : s.moveTo(p[i], -p[i + 1]));
  for (const h of holes) {
    const hp = new THREE.Path();
    for (let i = 0; i < h.length; i += 2) (i ? hp.lineTo(h[i], -h[i + 1]) : hp.moveTo(h[i], -h[i + 1]));
    s.holes.push(hp);
  }
  return s;
}

// ---------- 折线 ----------
export function polylineLength(p) {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return L;
}
/** 按固定间距重采样，返回 [{x,z,dx,dz,s}]（dx,dz 为单位切向） */
export function resample(p, step) {
  const out = [];
  let acc = 0, next = 0;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    while (next <= acc + L) {
      const t = next - acc;
      out.push({ x: ax + dx * t, z: az + dz * t, dx, dz, s: next });
      next += step;
    }
    acc += L;
  }
  return out;
}

// ---------- 覆盖层防 Z-fighting ----------
/**
 * 让覆盖在地面上的材质（道路、水面、标线、贴花）在视空间里朝相机收缩 bias 比例，
 * 相当于随距离增长的深度偏移。可与已有 onBeforeCompile 叠加。
 */
export function overlay(material, bias = 0.0015) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : () => '';
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      gl_Position = projectionMatrix * vec4(mvPosition.xyz * (1.0 - ${bias.toFixed(6)}), 1.0);`
    );
  };
  material.customProgramCacheKey = () => prevKey() + '|ov' + bias;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;
  return material;
}

/** 沿地形铺设的条带（折线 → 三角带），y 由 heightFn 给出，附加 lift 米 */
export function ribbon(p, width, heightFn, { lift = 0.3, step = 12, uvScale = 1 } = {}) {
  const pts = resample(p, step);
  if (pts.length < 2) return null;
  // 保证终点
  const n = p.length;
  const last = pts[pts.length - 1];
  if (Math.hypot(last.x - p[n - 2], last.z - p[n - 1]) > 0.5) pts.push({ x: p[n - 2], z: p[n - 1], dx: last.dx, dz: last.dz, s: last.s + Math.hypot(last.x - p[n - 2], last.z - p[n - 1]) });
  const pos = new Float32Array(pts.length * 6);
  const uv = new Float32Array(pts.length * 4);
  const idx = [];
  const hw = width / 2;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    // 平滑切向（前后平均）
    let dx = a.dx, dz = a.dz;
    if (i > 0) { dx += pts[i - 1].dx; dz += pts[i - 1].dz; }
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const nx = -dz, nz = dx;
    const lx = a.x + nx * hw, lz = a.z + nz * hw, rx = a.x - nx * hw, rz = a.z - nz * hw;
    pos.set([lx, heightFn(lx, lz) + lift, lz, rx, heightFn(rx, rz) + lift, rz], i * 6);
    uv.set([0, a.s * uvScale, 1, a.s * uvScale], i * 4);
    if (i) {
      const b = (i - 1) * 2;
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); // 法线朝上
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
