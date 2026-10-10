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

// ---------- 材质参数表合批 ----------
// 只差“颜色 / 粗糙度 / 金属度 / 自发光”的无贴图不透明 MeshStandardMaterial（逐栋档案、地标楼的上百种楼体色）合成一个共享材质：
// 每个顶点带一个表索引 aMt，着色器按索引从数据纹理取参数（flat 传递，不插值），一个片区一次绘制。
// 源材质不再参与绘制，但保留作参数来源：update() 每帧把源材质当前的 color、emissive×emissiveIntensity、roughness、metalness
// 同步进表（夜间发光仍由 ctx.night 照常驱动源材质），因此动态改材质的逻辑不受影响，出图与逐材质绘制逐位一致（只差同深度面的绘制先后）。
const MT_MAPS = ['map', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'envMap'];
const MT_SAME = ['side', 'shadowSide', 'envMapIntensity', 'flatShading', 'wireframe', 'fog', 'toneMapped', 'dithering', 'depthTest', 'depthWrite', 'depthFunc',
  'colorWrite', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'forceSinglePass', 'precision', 'premultipliedAlpha', 'alphaToCoverage', 'stencilWrite', 'clipShadows', 'clipIntersection'];
export class MatTable {
  constructor(name = 'matTable') {
    this.name = name;
    this.src = []; // 源材质（表行顺序）
    this.row = new Map(); // 源材质 uuid → 行号
    this.shared = new Map(); // 变体键 → 共享材质
    this.uTex = { value: null };
    this.data = null;
  }
  /** 能否并入参数表：MeshStandardMaterial（不含 Physical）、无任何贴图、不透明、无自定义着色器/宏、不用顶点色 */
  static collapsible(m) {
    if (!m || m.type !== 'MeshStandardMaterial' || m.isMeshPhysicalMaterial) return false;
    if (m.transparent || m.opacity !== 1 || m.alphaTest !== 0 || m.alphaHash || m.vertexColors || m.visible === false) return false;
    if (m.blending !== THREE.NormalBlending || (m.clippingPlanes && m.clippingPlanes.length)) return false;
    if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') || Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey')) return false;
    if (m.defines && Object.keys(m.defines).some((k) => k !== 'STANDARD')) return false; // 构造函数自带 STANDARD
    for (const k of MT_MAPS) if (m[k]) return false;
    return true;
  }
  /** 源材质的行号（首次出现时登记） */
  index(m) {
    let i = this.row.get(m.uuid);
    if (i === undefined) {
      i = this.src.length;
      this.src.push(m);
      this.row.set(m.uuid, i);
      if (this.data) this._grow();
    }
    return i;
  }
  /** 与源材质同变体（双面、环境光强度等非表内参数相同）的共享材质 */
  material(m) {
    const key = MT_SAME.map((k) => String(m[k])).join('|') + '|' + (m.envMapRotation ? m.envMapRotation.toArray().join(',') : '');
    let s = this.shared.get(key);
    if (!s) {
      s = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, emissive: 0x000000 });
      for (const k of MT_SAME) s[k] = m[k];
      if (m.envMapRotation) s.envMapRotation.copy(m.envMapRotation);
      s.name = this.name;
      s.userData.matTable = this;
      const uTex = this.uTex;
      const V = 'flat varying vec3 vMtDiffuse;\nflat varying vec3 vMtEmissive;\nflat varying vec2 vMtRM;';
      s.onBeforeCompile = (shader) => {
        shader.uniforms.uMtTex = uTex;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\nattribute float aMt;\nuniform highp sampler2D uMtTex;\n${V}`)
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            {
              int mtRow = int( aMt + 0.5 );
              vec4 mtA = texelFetch( uMtTex, ivec2( 0, mtRow ), 0 );
              vec4 mtB = texelFetch( uMtTex, ivec2( 1, mtRow ), 0 );
              vMtDiffuse = mtA.rgb; vMtRM = vec2( mtA.a, mtB.a ); vMtEmissive = mtB.rgb;
            }`
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${V}`)
          .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( vMtDiffuse, opacity );')
          .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vMtEmissive;')
          .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMtRM.x;')
          .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMtRM.y;');
      };
      s.customProgramCacheKey = () => 'matTable1';
      this.shared.set(key, s);
    }
    return s;
  }
  _grow() {
    const n = Math.max(1, this.src.length);
    const data = new Float32Array(n * 8);
    if (this.data) data.set(this.data.subarray(0, Math.min(this.data.length, data.length)));
    this.data = data;
    const tex = new THREE.DataTexture(data, 2, n, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    if (this.uTex.value) this.uTex.value.dispose();
    this.uTex.value = tex;
    this._dirtyAll = true;
    this.update();
  }
  /** 建表（所有几何登记完后调用一次） */
  build() {
    this._grow();
    return this;
  }
  /** 同步源材质当前参数（每帧调用，参数没变不上传） */
  update() {
    const d = this.data;
    if (!d) return;
    let dirty = this._dirtyAll;
    this._dirtyAll = false;
    const f = Math.fround;
    for (let i = 0; i < this.src.length; i++) {
      const m = this.src[i], o = i * 8, c = m.color, e = m.emissive, k = m.emissiveIntensity;
      const v0 = f(c.r), v1 = f(c.g), v2 = f(c.b), v3 = f(m.roughness), v4 = f(e.r * k), v5 = f(e.g * k), v6 = f(e.b * k), v7 = f(m.metalness);
      if (d[o] !== v0 || d[o + 1] !== v1 || d[o + 2] !== v2 || d[o + 3] !== v3 || d[o + 4] !== v4 || d[o + 5] !== v5 || d[o + 6] !== v6 || d[o + 7] !== v7) {
        d[o] = v0; d[o + 1] = v1; d[o + 2] = v2; d[o + 3] = v3; d[o + 4] = v4; d[o + 5] = v5; d[o + 6] = v6; d[o + 7] = v7;
        dirty = true;
      }
    }
    if (dirty && this.uTex.value) this.uTex.value.needsUpdate = true;
  }
}

/**
 * 带材质参数表的合批器：可并入表的材质（MatTable.collapsible）改用表的共享材质并给几何写 aMt 行号，其余同 Batcher。
 * 多个合批器可共用一张表（整个模块一张），表须在构建完后 build()、每帧 update()。
 */
export class TableBatcher extends Batcher {
  constructor(table) {
    super();
    this.table = table;
  }
  add(geometry, material, matrix = null, o = {}) {
    const t = this.table;
    if (!t || !MatTable.collapsible(material)) return super.add(geometry, material, matrix, o);
    const shared = t.material(material);
    const row = t.index(material);
    super.add(geometry, shared, matrix, o);
    const geos = this.buckets.get(shared.uuid).geos;
    const g = geos[geos.length - 1];
    if (g.attributes.color) g.deleteAttribute('color'); // 源材质不用顶点色（collapsible 已保证），顶点色原本就不参与着色
    g.setAttribute('aMt', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(row), 1));
    return this;
  }
}

/** 取出合批器当前各桶合并后的几何（不建网格）并清空：[{material, geometry}]（合并规则同 Batcher.build） */
export function drainBatcher(b) {
  const out = [];
  for (const { material, geos } of b.buckets.values()) {
    if (geos.some((g) => g.attributes.color))
      for (const g of geos)
        if (!g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
    const merged = mergeGeometries(geos, false);
    if (merged) out.push({ material, geometry: merged });
  }
  b.buckets.clear();
  return out;
}

/**
 * 逐对象合批（THREE.BatchedMesh + WEBGL_multi_draw）：同一材质的多个对象（如逐栋楼）一次绘制，仍逐对象做视锥裁剪（主视图与阴影各自裁剪），
 * 并可逐对象开关可见性（LOD）。几何须已是世界坐标（实例矩阵恒为单位阵，着色结果与普通网格逐位一致）。
 *   const ob = new ObjectBatcher({ multiDraw }); ob.add(geometry, material, tag) …; const { group, refs } = ob.build({ castShadow, receiveShadow, name });
 *   refs: [{ mesh, id, tag }]；setRefVisible(ref, v) 开关单个对象。
 * 同材质的几何须属性一致（顶点色缺失时自动补白；有/无索引混用时统一转无索引）。实例按添加顺序绘制（不做逐帧排序，结果稳定）。
 * multiDraw = false（浏览器没有 WEBGL_multi_draw，three 会逐实例循环绘制、反而更慢）：退回“材质 × tag”合并的普通网格
 *   （tag 相同的对象合成一个网格，即按片区合批的老做法），此时 ref.id 为 null，可见性按整个网格开关。
 */
export class ObjectBatcher {
  constructor({ multiDraw = true } = {}) {
    this.groups = new Map();
    this.multiDraw = multiDraw;
  }
  add(geometry, material, tag = null) {
    let g = this.groups.get(material.uuid);
    if (!g) this.groups.set(material.uuid, (g = { material, items: [] }));
    g.items.push({ geometry, tag });
    return this;
  }
  build({ castShadow = true, receiveShadow = true, name = 'batch' } = {}) {
    const group = new THREE.Group();
    group.name = name;
    const refs = [];
    for (const { material, items } of this.groups.values()) {
      if (items.some((it) => it.geometry.attributes.color))
        for (const it of items)
          if (!it.geometry.attributes.color) it.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(it.geometry.attributes.position.count * 3).fill(1), 3));
      if (items.some((it) => it.geometry.index) && items.some((it) => !it.geometry.index))
        for (const it of items) if (it.geometry.index) it.geometry = it.geometry.toNonIndexed();
      if (!this.multiDraw) {
        const byTag = new Map();
        for (const it of items) {
          if (!byTag.has(it.tag)) byTag.set(it.tag, []);
          byTag.get(it.tag).push(it);
        }
        for (const [tag, list] of byTag) {
          const merged = mergeGeometries(list.map((it) => it.geometry), false);
          for (const it of list) it.geometry.dispose();
          if (!merged) continue;
          merged.computeBoundingSphere();
          const m = new THREE.Mesh(merged, material);
          m.castShadow = castShadow;
          m.receiveShadow = receiveShadow;
          m.name = material.name || name;
          group.add(m);
          for (const it of list) refs.push({ mesh: m, id: null, tag });
        }
        continue;
      }
      let nv = 0, ni = 0;
      for (const it of items) {
        nv += it.geometry.attributes.position.count;
        ni += it.geometry.index ? it.geometry.index.count : 0;
      }
      const bm = new THREE.BatchedMesh(items.length, nv, Math.max(ni, 1), material);
      bm.sortObjects = false;
      bm.perObjectFrustumCulled = true;
      for (const it of items) {
        const id = bm.addInstance(bm.addGeometry(it.geometry));
        refs.push({ mesh: bm, id, tag: it.tag });
        it.geometry.dispose();
      }
      bm.computeBoundingBox();
      bm.computeBoundingSphere();
      bm.castShadow = castShadow;
      bm.receiveShadow = receiveShadow;
      bm.name = material.name || name;
      group.add(bm);
    }
    this.groups.clear();
    return { group, refs };
  }
}
/** 开关 ObjectBatcher 的一个对象（退回普通网格时按整个网格开关） */
export function setRefVisible(r, v) {
  if (r.id === null) r.mesh.visible = v;
  else r.mesh.setVisibleAt(r.id, v);
}
/** 渲染器是否支持多重绘制（WEBGL_multi_draw）；URL 加 multidraw=0 可强制按不支持处理（测试兜底路径） */
export function hasMultiDraw(renderer) {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('multidraw') === '0') return false;
    return !!renderer?.extensions?.has('WEBGL_multi_draw');
  } catch {
    return false;
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
