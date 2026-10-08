// 渭河与城市水系（整体重写）
// 数据：public/data/water.json（polys = 水面多边形，大河按 2400 m 网格切块；lines = 小河/渠中心线）。
// 做法：
//   · 每个多边形：清洗 + 异常剔除（面积 > 30 km²、包围盒 > 26 km、非数坐标、自交导致三角化失败）→ 耳切三角化
//     → 最长边二分细化（近城 26 m、远郊 70 m）→ 每顶点离岸距离（排除网格切边）、水体类型、泾河羽流、城市化程度、流向。
//   · 水面高度：同名河流按分块 h 做反距离加权（跨块连续、无台阶）；h 异常（与地形低分位数差 > 6 m）时回退到地形；
//     顶点再做有限贴地 y = max(L+0.15, min(T+0.3, L+2.5))，保证水面不被 DEM 起伏吞没，也不会高出地面去穿桥。
//   · 材质：见 src/arch/water-shader.js（程序化法线、IBL 菲涅尔、太阳高光、分水体色、泾渭分明、夜间灯光倒影）。
//   · 护城河：石砌压顶 + 石栏杆（近景细节，远处隐藏）。
// 类型色参考：research/refs/water/（中新网泾渭交汇航拍：渭河黄褐含沙、大片沙洲；护城河实拍：墨绿水色 + 灰石驳岸 + 石栏杆）。
// draw call：水面 1 + 小河渠 1 + 压顶 1 + 栏杆 1 = 4。
import * as THREE from 'three';
import {
  cleanRing, ringArea, ringBBox, triangulate, shoreSegments, ShoreDistance, resampleLine, inPoly,
  moatEdgeGeometry, railingTexture,
} from '../arch/water-geom.js';
import { createWaterMaterial } from '../arch/water-shader.js';

const MAX_AREA = 30e6; // m²
const MAX_SPAN = 26000; // m
const CORE_R = 14000; // 近城细化半径

// 泾渭交汇（高陵陈家滩一带）——泾河多边形最东端与渭河相接处，运行时从数据求精确点
const JING_MOUTH_HINT = { x: 11400, z: -22900 };

function typeOf(p) {
  const n = p.n || '';
  if (n === '渭河') return 0;
  if (n === '泾河') return 1;
  if (p.k === 'moat' || n.includes('护城河')) return 3;
  if (p.k === 'river' || p.k === 'canal') return 2;
  if (p.k === 'reservoir') return 5;
  if (p.k === 'lake') return p.a > 1.5e6 || /水库/.test(n) ? 5 : 4;
  return 6; // pond / basin
}

// ---------- 近景平面倒影 ----------
// 相机低空靠近某块水面时，按该水面的镜面高度把场景镜像渲染到一张半分辨率贴图（斜裁剪近平面 = 水面，水下的东西不进倒影），
// 水面着色器在镜面高度附近用它代替天空环境反射。远处/高空仍用环境反射 + 曲江模块的投影倒影（近景渲染期间隐藏，免得重复）。
const _pv = new THREE.Vector3(), _pf = new THREE.Vector3(), _pu = new THREE.Vector3(), _pl = new THREE.Plane(), _pq = new THREE.Vector4();
const _pc = new THREE.Vector4(), _pm = new THREE.Matrix4(), _fr = new THREE.Frustum(), _pb = new THREE.Box3(), _ps = new THREE.Vector3();
const REFL_FAR = 2500; // 倒影里只画这个距离内的物体（米）
class PlanarReflection {
  constructor(renderer, scale) {
    this.renderer = renderer;
    this.scale = scale;
    this.cam = new THREE.PerspectiveCamera();
    this.cam.matrixAutoUpdate = true;
    this.texMat = new THREE.Matrix4();
    this.rt = null;
    this.items = null;
    this._hideScan = -1e9;
  }

  _ensureTarget() {
    const r = this.renderer;
    const s = r.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.round(s.x * this.scale)), h = Math.max(64, Math.round(s.y * this.scale));
    if (this.rt && this.rt.width === w && this.rt.height === h) return;
    if (this.rt) this.rt.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0, depthBuffer: true });
    this.rt.texture.generateMipmaps = false;
    this.rt.texture.minFilter = THREE.LinearFilter;
    // 反向深度：需要浮点深度缓冲（与主渲染目标一致）
    if (r.state.buffers.depth.getReversed()) this.rt.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
  }

  /** 镜面 y = h；返回是否渲染成功 */
  render(scene, camera, h, frame, skip) {
    const r = this.renderer;
    this._ensureTarget();
    const cam = this.cam;
    // 镜像相机：位置、视线、上方向都按水平镜面翻转
    camera.getWorldPosition(_pv);
    camera.getWorldDirection(_pf);
    _pu.set(0, 1, 0).applyQuaternion(camera.quaternion);
    cam.position.set(_pv.x, 2 * h - _pv.y, _pv.z);
    cam.up.set(_pu.x, -_pu.y, _pu.z);
    cam.lookAt(cam.position.x + _pf.x, cam.position.y - _pf.y, cam.position.z + _pf.z);
    // 视野放宽 8%：波浪扰动取样会越出画面边缘，留一圈余量（否则画面两侧的水面退回环境反射，出现竖向亮边）
    cam.fov = (2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * 1.08) * 180) / Math.PI;
    cam.aspect = camera.aspect;
    cam.near = Math.max(0.1, camera.near);
    cam.far = Math.min(camera.far, REFL_FAR);
    cam._reversedDepth = !!camera.reversedDepth;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    // 投影矩阵（斜裁剪之前）→ 世界到倒影贴图的投影矩阵
    this.texMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.texMat.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    // 斜裁剪：近平面换成水面（略低 2 cm，岸边不露缝），水下的地形/湖底不进倒影
    _pl.set(_pu.set(0, 1, 0), -(h - 0.02)).applyMatrix4(cam.matrixWorldInverse);
    const P = cam.projectionMatrix, e = P.elements;
    const C = _pc.set(_pl.normal.x, _pl.normal.y, _pl.normal.z, _pl.constant);
    if (cam._reversedDepth) {
      // 反向深度（z_ndc：近 1 → 远 0）：z' = w − a·(C·P)，远平面过原视锥远角
      const qx = (Math.sign(C.x) + e[8]) / e[0], qy = (Math.sign(C.y) + e[9]) / e[5];
      const den = C.x * qx + C.y * qy - C.z + C.w / cam.far;
      if (Math.abs(den) < 1e-9) return false;
      const a = 1 / den;
      e[2] = -a * C.x; e[6] = -a * C.y; e[10] = -1 - a * C.z; e[14] = -a * C.w;
    } else {
      // 常规深度（three Reflector 同款）
      _pq.set((Math.sign(C.x) + e[8]) / e[0], (Math.sign(C.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
      C.multiplyScalar(2 / C.dot(_pq));
      e[2] = C.x; e[6] = C.y; e[10] = C.z + 1; e[14] = C.w;
    }
    cam.projectionMatrixInverse.copy(P).invert();
    // 倒影里不画的东西（物体表每 240 帧重建一次）：
    //  · 曲江模块的投影倒影（它本身就是倒影）、标了 userData.noReflect 的物体；
    //  · 贴地覆盖层（路面、用地色调等 polygonOffset 材质）：从水下的镜像相机看是背面，白白耗顶点；
    //  · 倒影作用半径外的物体、远处的小物件（行人、车辆、小品）。
    if (frame - this._hideScan > 240 || !this.items) {
      this._hideScan = frame;
      this.items = [];
      this.shadowLights = [];
      scene.traverse((o) => {
        if (o.isLight && o.castShadow) this.shadowLights.push(o);
        if (o.name === '湖面倒影' || (o.userData && o.userData.noReflect)) { this.items.push({ o, always: true }); return; }
        if (!(o.isMesh || o.isLine || o.isPoints) || !o.geometry) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const overlay = mats.every((m) => m && m.polygonOffset);
        this.items.push({ o, always: overlay });
      });
    }
    // 主渲染还没生成过阴影贴图（加载阶段的头几帧）时不画倒影：倒影这一遍关了阴影更新，阴影采样器会绑到空纹理，
    // 每次绘制都报 GL_INVALID_OPERATION（2026-10-08 定位：加载阶段 247 次，全部来自这里）
    for (const L of this.shadowLights) if (L.visible && !L.shadow.map) return false;
    const hidden = [];
    const cx = _pv.x, cy = _pv.y, cz = _pv.z;
    for (const it of this.items) {
      const o = it.o;
      if (!o.visible) continue;
      let hide = it.always;
      if (!hide) {
        const g = o.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        const bs = o.isInstancedMesh ? o.boundingSphere || (o.computeBoundingSphere(), o.boundingSphere) : g.boundingSphere;
        if (bs && Number.isFinite(bs.radius)) {
          _ps.copy(bs.center).applyMatrix4(o.matrixWorld);
          const rad = bs.radius * o.matrixWorld.getMaxScaleOnAxis();
          const d = Math.hypot(_ps.x - cx, _ps.y - cy, _ps.z - cz);
          // 地形瓦片只留近岸的（驳岸、坡地）；远处地形在倒影里只是地平线附近的一条细线
          hide = d - rad > (o.userData.terrain ? 500 : REFL_FAR) || (rad < 3 && d > 180) || (rad < 12 && d > 700);
        }
      }
      if (hide) { o.visible = false; hidden.push(o); }
    }
    for (const o of skip) if (o.visible) { o.visible = false; hidden.push(o); }
    const prevRT = r.getRenderTarget();
    const prevShadow = r.shadowMap.autoUpdate;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.rt);
    r.state.buffers.depth.setMask(true);
    r.clear();
    const c0 = r.info.render.calls, t0 = r.info.render.triangles;
    r.render(scene, cam);
    this.stats = { calls: r.info.render.calls - c0, tris: r.info.render.triangles - t0, hidden: hidden.length };
    r.setRenderTarget(prevRT);
    r.shadowMap.autoUpdate = prevShadow;
    r.xr.enabled = prevXr;
    for (const o of hidden) o.visible = true;
    return true;
  }

  dispose() {
    if (this.rt) this.rt.dispose();
  }
}

function urbanOf(x, z, type) {
  const r = Math.hypot(x, z);
  let u = 1 - THREE.MathUtils.smoothstep(r, 9000, 26000);
  if (type === 3 || type === 4) u = Math.max(u, 0.85);
  if (type === 0 || type === 1) u *= 0.55; // 大河两岸灯光稀疏（桥灯为主）
  return u;
}

export default {
  id: 'water',
  name: '渭河与城市水系',
  async build(ctx) {
    const t0 = performance.now();
    const data = ctx.data.water || {};
    const T = ctx.terrain;
    const root = new THREE.Group();
    root.name = '西安水系';
    ctx.scene.add(root);
    const log = { dropped: [], relevel: 0 };

    // ---------- 1. 清洗 + 异常剔除 ----------
    const polys = [];
    for (const src of data.polys || []) {
      const outer = cleanRing(src.outer);
      if (!outer) { log.dropped.push(`${src.n || '?'}:坏环`); continue; }
      const holes = (src.holes || []).map(cleanRing).filter(Boolean);
      const bb = ringBBox(outer);
      const area = Math.abs(ringArea(outer)) - holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
      if (!(area > 20) || area > MAX_AREA || bb.x1 - bb.x0 > MAX_SPAN || bb.z1 - bb.z0 > MAX_SPAN) {
        log.dropped.push(`${src.n || src.k}:面积${(area / 1e6).toFixed(2)}km²/跨度${Math.round(Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0))}m`);
        continue;
      }
      // 细长“尖刺”（多边形组装错误的典型形态）：面积/包围盒比极小且跨度很大
      if (area / ((bb.x1 - bb.x0) * (bb.z1 - bb.z0) + 1) < 0.004 && Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0) > 6000) {
        log.dropped.push(`${src.n || src.k}:尖刺`);
        continue;
      }
      let cx = 0, cz = 0;
      const n = outer.length / 2;
      for (let i = 0; i < outer.length; i += 2) { cx += outer[i]; cz += outer[i + 1]; }
      cx /= n; cz /= n;
      // 地形低分位数（最多 24 个边界点 + 质心）
      const hs = [T.heightAt(cx, cz)];
      const stepV = Math.max(1, Math.floor(n / 24));
      for (let i = 0; i < n; i += stepV) hs.push(T.heightAt(outer[i * 2], outer[i * 2 + 1]));
      hs.sort((a, b) => a - b);
      const q25 = hs[Math.floor(hs.length * 0.25)];
      let h = Number(src.h);
      if (!Number.isFinite(h) || h > q25 + 6 || h < q25 - 6) { h = q25 - 0.3; log.relevel++; }
      polys.push({ src, n: src.n || '', k: src.k, type: typeOf({ ...src, a: area }), outer, holes, bb, area, cx, cz, h });
    }

    // ---------- 2. 同名河流：水位场（反距离加权）+ 流向（h 线性回归的下坡方向）----------
    const byName = new Map();
    for (const p of polys) {
      if (p.k !== 'river' || !p.n) continue;
      if (!byName.has(p.n)) byName.set(p.n, []);
      byName.get(p.n).push(p);
    }
    const downhill = new Map();
    for (const [name, list] of byName) {
      if (list.length < 3) continue;
      // 最小二乘 h = a + b x + c z
      let sx = 0, sz = 0, sh = 0;
      for (const p of list) { sx += p.cx; sz += p.cz; sh += p.h; }
      const m = list.length, mx = sx / m, mz = sz / m, mh = sh / m;
      let xx = 0, xz = 0, zz = 0, xh = 0, zh = 0;
      for (const p of list) {
        const dx = p.cx - mx, dz = p.cz - mz, dh = p.h - mh;
        xx += dx * dx; xz += dx * dz; zz += dz * dz; xh += dx * dh; zh += dz * dh;
      }
      const det = xx * zz - xz * xz;
      if (Math.abs(det) < 1e-6) continue;
      const b = (xh * zz - zh * xz) / det, c = (zh * xx - xh * xz) / det;
      const l = Math.hypot(b, c);
      if (l > 1e-7) downhill.set(name, { x: -b / l, z: -c / l });
    }
    if (!downhill.has('渭河')) downhill.set('渭河', { x: 0.85, z: -0.52 });
    for (const p of polys) {
      p.nbrs = null;
      if (p.k === 'river' && p.n && byName.get(p.n).length > 1) {
        p.nbrs = byName.get(p.n).filter((q) => Math.hypot(q.cx - p.cx, q.cz - p.cz) < 7000);
      }
      // 局部主轴（PCA）+ 下坡符号
      let flow = { x: 0.6, z: 0.8 }, speed = 0.08;
      if (p.k === 'river' || p.k === 'canal') {
        let xx = 0, xz = 0, zz = 0;
        const o = p.outer;
        for (let i = 0; i < o.length; i += 2) {
          const dx = o[i] - p.cx, dz = o[i + 1] - p.cz;
          xx += dx * dx; xz += dx * dz; zz += dz * dz;
        }
        const ang = 0.5 * Math.atan2(2 * xz, xx - zz);
        flow = { x: Math.cos(ang), z: Math.sin(ang) };
        const g = downhill.get(p.n) || { x: 1, z: 0 };
        if (flow.x * g.x + flow.z * g.z < 0) { flow.x = -flow.x; flow.z = -flow.z; }
        speed = p.type === 0 ? 1.1 : 0.7;
      }
      p.flow = flow; p.speed = speed;
    }
    const levelAt = (p, x, z) => {
      if (!p.nbrs) return p.h;
      let sw = 0, sh = 0;
      for (const q of p.nbrs) {
        const d2 = (q.cx - x) ** 2 + (q.cz - z) ** 2;
        const w = 1 / (d2 + 640000);
        sw += w; sh += w * q.h;
      }
      return sh / sw;
    };
    const surfaceY = (p, x, z) => {
      const L = levelAt(p, x, z);
      return Math.max(L + 0.15, Math.min(T.heightAt(x, z) + 0.3, L + 2.5));
    };

    // ---------- 3. 泾渭交汇：泾河入渭点与局部流向 ----------
    let mouth = null;
    {
      const jing = polys.filter((p) => p.type === 1);
      const wei = polys.filter((p) => p.type === 0 && Math.hypot(p.cx - JING_MOUTH_HINT.x, p.cz - JING_MOUTH_HINT.z) < 8000);
      let best = Infinity;
      for (const j of jing) {
        if (Math.hypot(j.cx - JING_MOUTH_HINT.x, j.cz - JING_MOUTH_HINT.z) > 6000) continue;
        for (let i = 0; i < j.outer.length; i += 2) {
          for (const w of wei) {
            const o = w.outer;
            for (let k = 0; k < o.length; k += 2) {
              const d = (o[k] - j.outer[i]) ** 2 + (o[k + 1] - j.outer[i + 1]) ** 2;
              if (d < best) { best = d; mouth = { x: (o[k] + j.outer[i]) / 2, z: (o[k + 1] + j.outer[i + 1]) / 2 }; }
            }
          }
        }
      }
      if (mouth && best < 400 * 400) {
        // 入渭点附近渭河的流向
        let near = null, nd = Infinity;
        for (const w of wei) { const d = Math.hypot(w.cx - mouth.x, w.cz - mouth.z); if (d < nd) { nd = d; near = w; } }
        mouth.fx = near ? near.flow.x : 0.85; mouth.fz = near ? near.flow.z : -0.52;
      } else mouth = null;
    }
    const plume = (x, z) => {
      if (!mouth) return 0;
      const rx = x - mouth.x, rz = z - mouth.z;
      const s = rx * mouth.fx + rz * mouth.fz; // 下游距离
      if (s < -150 || s > 9000) return 0;
      const lat = Math.abs(-rx * mouth.fz + rz * mouth.fx); // 横向距离（入渭点在岸边，羽流贴岸向下游）
      const half = 110 + 0.07 * Math.max(s, 0);
      const k = 1 - THREE.MathUtils.smoothstep(lat, half * 0.7, half * 1.4);
      return k * (1 - THREE.MathUtils.smoothstep(s, 3500, 9000)) * THREE.MathUtils.smoothstep(s, -150, 60);
    };

    // ---------- 4. 水面几何 ----------
    const P = [], A = [], F = [], I = [];
    const moatPolys = [];
    let verts = 0;
    for (const p of polys) {
      const near = Math.hypot(p.cx, p.cz) < CORE_R;
      const maxEdge = p.type === 3 ? 18 : near ? 26 : p.area > 1.5e6 ? 90 : 70;
      const rings = [p.outer, ...p.holes];
      const tri = triangulate(rings, maxEdge, near ? 60000 : 20000);
      if (!tri || !tri.tris.length) { log.dropped.push(`${p.n || p.k}:三角化失败`); continue; }
      if (p.type === 3) moatPolys.push(p);
      const sd = new ShoreDistance(shoreSegments(rings), 90, 64);
      const base = verts;
      const nv = tri.xs.length;
      for (let i = 0; i < nv; i++) {
        const x = tri.xs[i], z = tri.zs[i];
        P.push(x, surfaceY(p, x, z), z);
        const d = tri.bnd[i] ? 0 : sd.at(x, z);
        A.push(d, p.type, p.type === 0 ? plume(x, z) : 0, urbanOf(x, z, p.type));
        F.push(p.flow.x * p.speed, p.flow.z * p.speed);
      }
      for (let i = 0; i < tri.tris.length; i++) I.push(tri.tris[i] + base);
      verts += nv;
      // 镜面高度：本块水面顶点高度的中位数（水面按地形有限贴地，大多数顶点在水位 +0.15 m）
      const ys = [];
      const stepY = Math.max(1, Math.floor(nv / 256));
      for (let i = 0; i < nv; i += stepY) ys.push(P[(base + i) * 3 + 1]);
      ys.sort((a, b) => a - b);
      p.planeY = ys[ys.length >> 1];
    }

    // ---------- 5. 小河/渠（lines）：3 列条带，落在水面多边形内的段剔除 ----------
    const LP = [], LA = [], LF = [], LI = [];
    {
      const cell = 600;
      const grid = new Map();
      polys.forEach((p, idx) => {
        for (let cx = Math.floor(p.bb.x0 / cell); cx <= Math.floor(p.bb.x1 / cell); cx++)
          for (let cz = Math.floor(p.bb.z0 / cell); cz <= Math.floor(p.bb.z1 / cell); cz++) {
            const k = cx * 100003 + cz;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(idx);
          }
      });
      const inWater = (x, z) => {
        const l = grid.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell));
        if (!l) return false;
        for (const i of l) {
          const p = polys[i];
          if (x < p.bb.x0 - 8 || x > p.bb.x1 + 8 || z < p.bb.z0 - 8 || z > p.bb.z1 + 8) continue;
          if (inPoly(x, z, [p.outer, ...p.holes])) return true;
        }
        return false;
      };
      let lv = 0;
      for (const f of data.lines || []) {
        if (!f.p || f.p.length < 4 || !f.p.every(Number.isFinite)) continue;
        const w = THREE.MathUtils.clamp(Number(f.w) || 6, 3, 30);
        const pts = resampleLine(f.p, THREE.MathUtils.clamp(w * 2.5, 12, 45));
        const u = urbanOf(f.p[0], f.p[1], 7);
        let run = [];
        const flush = () => {
          if (run.length >= 2) {
            for (let i = 0; i < run.length; i++) {
              const a = run[i];
              const nx = -a.tz, nz = a.tx;
              for (let s = -1; s <= 1; s++) {
                const x = a.x + nx * w * 0.5 * s, z = a.z + nz * w * 0.5 * s;
                LP.push(x, T.heightAt(x, z) + 0.35, z);
                LA.push(s === 0 ? w * 0.5 : 0, 7, 0, u);
                LF.push(a.tx * 0.6, a.tz * 0.6);
              }
              if (i) {
                const b = lv + (i - 1) * 3, c = lv + i * 3;
                // 法线朝上：(左,中)->(下一个)
                LI.push(b, b + 1, c, b + 1, c + 1, c, b + 1, b + 2, c + 1, b + 2, c + 2, c + 1);
              }
            }
            lv += run.length * 3;
          }
          run = [];
        };
        for (const a of pts) {
          if (inWater(a.x, a.z)) flush(); else run.push(a);
        }
        flush();
      }
      // 统一绕序（法线朝上）
      for (let i = 0; i < LI.length; i += 3) {
        const a = LI[i] * 3, b = LI[i + 1] * 3, c = LI[i + 2] * 3;
        const cy = (LP[b + 2] - LP[a + 2]) * (LP[c] - LP[a]) - (LP[b] - LP[a]) * (LP[c + 2] - LP[a + 2]);
        if (cy < 0) { const t = LI[i + 1]; LI[i + 1] = LI[i + 2]; LI[i + 2] = t; }
      }
    }

    const level = ctx.quality && ctx.quality.level != null ? ctx.quality.level : 2;
    const mat = createWaterMaterial(ctx, { level });
    const mkMesh = (pos, attr, flow, idx, name) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const nrm = new Float32Array(pos.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('aWater', new THREE.Float32BufferAttribute(attr, 4));
      g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
      g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.receiveShadow = true;
      m.castShadow = false;
      m.renderOrder = 1;
      return m;
    };
    const surface = mkMesh(P, A, F, I, '水面');
    root.add(surface);
    let streams = null;
    if (LI.length) { streams = mkMesh(LP, LA, LF, LI, '小河与渠'); root.add(streams); }

    // ---------- 6. 护城河石砌压顶 + 栏杆 ----------
    const edges = [];
    const moatSegs = [];
    for (const p of moatPolys) {
      const o = p.outer;
      for (let i = 0, n = o.length / 2, j = n - 1; i < n; j = i++) moatSegs.push({ p, ax: o[j * 2], az: o[j * 2 + 1], bx: o[i * 2], bz: o[i * 2 + 1] });
    }
    const nearOther = (p, x, z) => {
      for (const s of moatSegs) {
        if (s.p === p) continue;
        const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1e-9;
        let t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(s.ax + dx * t - x, s.az + dz * t - z) < 3) return true;
      }
      return false;
    };
    for (const p of moatPolys) {
      const o = p.outer, sgn = Math.sign(ringArea(o)) || 1;
      for (let i = 0, n = o.length / 2, j = n - 1; i < n; j = i++) {
        const ax = o[j * 2], az = o[j * 2 + 1], bx = o[i * 2], bz = o[i * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.8) continue;
        if (nearOther(p, (ax + bx) / 2, (az + bz) / 2)) continue; // 相邻两段护城河的拼接边（水面连通，不能加栏杆）
        const dx = (bx - ax) / len, dz = (bz - az) / len;
        edges.push({ ax, az, bx, bz, ox: sgn * dz, oz: -sgn * dx, p });
      }
    }
    let edgeGroup = null;
    if (edges.length) {
      const yOf = new Map();
      const { coping, rail } = moatEdgeGeometry(
        edges,
        (x, z) => {
          const k = x.toFixed(1) + ',' + z.toFixed(1);
          if (!yOf.has(k)) {
            const e = edges.find((q) => (q.ax === x && q.az === z) || (q.bx === x && q.bz === z));
            yOf.set(k, surfaceY(e ? e.p : moatPolys[0], x, z));
          }
          return yOf.get(k);
        },
        (x, z) => T.heightAt(x, z)
      );
      edgeGroup = new THREE.Group();
      edgeGroup.name = '护城河驳岸';
      const stone = ctx.mats.get('stonePaving');
      const cm = new THREE.Mesh(coping, stone);
      cm.castShadow = true; cm.receiveShadow = true;
      const railMat = new THREE.MeshStandardMaterial({ map: railingTexture(), roughness: 0.85, alphaTest: 0.5, side: THREE.DoubleSide });
      const rm = new THREE.Mesh(rail, railMat);
      rm.castShadow = true; rm.receiveShadow = true;
      edgeGroup.add(cm, rm);
      root.add(edgeGroup);
    }

    // ---------- 7. 标注（≤ 6） ----------
    const labelAt = (name, filter, opts) => {
      const list = polys.filter(filter);
      if (!list.length) return;
      // 取最接近城市中心的一块（渭河）或面积最大的一块
      const p = opts.nearCity ? list.reduce((a, b) => (Math.hypot(a.cx, a.cz + 16000) < Math.hypot(b.cx, b.cz + 16000) ? a : b)) : list.reduce((a, b) => (a.area > b.area ? a : b));
      ctx.labels.add(name, new THREE.Vector3(p.cx, p.h + 8, p.cz), { category: 'district', minDist: opts.min || 400, maxDist: opts.max || 30000, priority: opts.pri || 2 });
    };
    labelAt('渭河', (p) => p.type === 0, { nearCity: true, max: 45000, pri: 3 });
    if (mouth) ctx.labels.add('泾渭分明', new THREE.Vector3(mouth.x + mouth.fx * 900, 372, mouth.z + mouth.fz * 900), { category: 'district', minDist: 300, maxDist: 26000, priority: 2 });
    labelAt('灞河', (p) => p.n === '灞河' && Math.hypot(p.cx, p.cz) < 12000, { max: 22000 });
    labelAt('昆明池', (p) => /昆明池/.test(p.n), { max: 30000 });
    labelAt('曲江池', (p) => p.n === '曲江池', { min: 200, max: 9000 });
    labelAt('兴庆湖', (p) => p.n === '兴庆湖', { min: 200, max: 7000 });

    const ms = performance.now() - t0;
    console.info(`[water] ${polys.length} 块水面, ${verts} 顶点, ${I.length / 3} 三角形; 小河渠 ${LP.length / 3} 顶点; 护城河边 ${edges.length}; 剔除 ${log.dropped.length}${log.dropped.length ? '（' + log.dropped.slice(0, 8).join('；') + '）' : ''}; 水位回退 ${log.relevel}; 泾渭交汇 ${mouth ? Math.round(mouth.x) + ',' + Math.round(mouth.z) : '未找到'}; ${ms.toFixed(0)} ms`);

    const cam = ctx.camera;
    // 近景平面倒影：画质“中”以上启用（低画质不额外渲染一遍场景）；分辨率按画质取主画面的 0.35~0.6（运行中切换画质即时生效，贴图按需创建）
    const qNow = () => (ctx.quality && ctx.quality.level != null ? ctx.quality.level : level);
    // 近景镜面倒影：?refl=0 可关闭
    const reflOn = new URLSearchParams(location.search).get('refl') !== '0';
    const planar = ctx.renderer && reflOn ? new PlanarReflection(ctx.renderer, 0.5) : null;
    const reflPolys = polys.filter((p) => Number.isFinite(p.planeY));
    const WU = mat.userData.uniforms;
    const skipRefl = [surface, ...(streams ? [streams] : [])];
    let frame = 0, lastP = null, lastFrame = -9;
    const pickWater = () => {
      // 相机附近（包围盒 600 m 内）、相机在水面以上 0.3~250 m 的水体：取最近的一块（包含相机时优先面积大的）
      const cp = cam.position;
      let best = null, bestS = Infinity;
      for (const p of reflPolys) {
        const b = p.bb;
        const dx = Math.max(b.x0 - cp.x, 0, cp.x - b.x1), dz = Math.max(b.z0 - cp.z, 0, cp.z - b.z1);
        const d = Math.hypot(dx, dz);
        if (d > 600) continue;
        const hy = cp.y - p.planeY;
        if (hy < 0.3 || hy > 250) continue;
        const sc = d - Math.min(Math.sqrt(p.area), 400) * 0.25;
        if (sc < bestS) { bestS = sc; best = p; }
      }
      return best;
    };
    return {
      update() {
        frame++;
        if (edgeGroup) {
          const d = Math.hypot(cam.position.x - 100, cam.position.z + 500);
          edgeGroup.visible = root.visible && d < 5500 && cam.position.y < 2200;
        }
        let on = false;
        const qLevel = qNow();
        if (planar && qLevel >= 1 && root.visible && surface.visible) {
          planar.scale = qLevel >= 3 ? 0.6 : qLevel >= 2 ? 0.5 : 0.35;
          const p = pickWater();
          if (p) {
            // 水面在画面里才渲染倒影
            _pb.min.set(p.bb.x0, p.planeY - 2, p.bb.z0);
            _pb.max.set(p.bb.x1, p.planeY + 2, p.bb.z1);
            _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
            _fr.setFromProjectionMatrix(_pm, THREE.WebGLCoordinateSystem, !!cam.reversedDepth);
            if (_fr.intersectsBox(_pb)) {
              // 降频渲染（超高每 2 帧、高每 3 帧、中每 4 帧一次）：倒影贴图按渲染当帧的镜像相机投影取样（uPlanarMat 随贴图一起保存），
              // 相机移动时静态景物的倒影位置仍然正确，只是动态物体慢一两帧；换了水体或刚开启时立即渲染
              const every = qLevel >= 3 ? 2 : qLevel >= 2 ? 3 : 4;
              const fresh = lastP === p && frame - lastFrame < every;
              if (fresh) on = true;
              else {
                try {
                  on = planar.render(ctx.scene, cam, p.planeY, frame, skipRefl);
                } catch (e) {
                  console.warn('[water] 平面倒影渲染失败，关闭', e);
                  planar.render = () => false;
                }
                if (on) {
                  lastP = p;
                  lastFrame = frame;
                  WU.uPlanar.value = planar.rt.texture;
                  WU.uPlanarMat.value.copy(planar.texMat);
                  WU.uPlanarY.value = p.planeY;
                }
              }
            }
          }
        }
        WU.uPlanarOn.value = on ? 1 : 0;
      },
      setLayer(layer, visible) { if (layer === 'water') root.visible = visible; },
      /** 近景平面倒影统计（诊断）：是否开启、上一次倒影渲染的 draw call 与三角形数 */
      planarStats: () => ({ on: WU.uPlanarOn.value > 0, ...(planar && planar.stats) }),
      setQuality() {},
      dispose() {
        root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
        if (planar) planar.dispose();
        mat.dispose();
        ctx.scene.remove(root);
      },
    };
  },
};
