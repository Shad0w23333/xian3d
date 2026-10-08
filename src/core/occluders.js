// 遮挡体登记（ctx.occluders）：把精建模块（城墙、城门楼、钟鼓楼、回民街逐户、档案楼、地标高楼、古建、曲江、不夜城……）的
// 实体几何栅格化成 1 m 分辨率的“2.5D 高度场”，供
//   · 标注（地名 / 路名 / 小区名）做视线遮挡：segmentBlocked(a, b)
//   · 相机做“建筑内推出”：solidAt(x, y, z)
// 通用建筑（buildings 模块）有自己按真实轮廓的 occluded()，不进本表。
//
// 每个格子记：top = 该格所有三角形采样点的最高处；含朝下面（券洞顶、檐底、桥底）的格子另记
//   down = 最低的朝下面、up = 最低的朝上面。点 (x,y,z) 判为“在实体内”：y < top，且头顶第一层面不是朝下面
//   （即不在券洞 / 桥下 / 骑楼下这种“上有顶、下是空”的空间里）。
// 栅格化按网格分帧进行（process(预算毫秒)），相机附近的网格优先；模块也可以直接登记外包盒 / 轮廓棱柱：
//   ctx.occluders.addBox(x0, z0, x1, z1, y0, y1)、addPrism(ring[x,z,...], y0, y1)、addObject(object3D)
import * as THREE from 'three';

const CELL = 1; // 米
const TS = 32; // 每块格数（32 m × 32 m）
const ENC = (y) => Math.max(1, Math.min(65535, Math.round((y + 100) * 10)));
const DEC = (v) => v * 0.1 - 100;
const SKIP_NAME = /倒影|refl|glow|光晕|halo|光柱|beam|\bled\b|灯带|光斑|喷泉水|水柱|水面|water/i;
// 细部装饰材质（彩画梁枋、屋脊吻兽、灯带、花格、金属件）：三角形多、对遮挡贡献小（屋面/墙体/台基已覆盖），跳过以省时
const SKIP_MAT = /^arch\.(paint|ridge|led|caihua|lattice|metal|gold|glass)$/;
const _m = new THREE.Matrix4();

/** LOD 选用哪一级：200~800 m 之间的中等精度级优先（足够做遮挡、三角形少），否则最精细级 */
function pickLodLevel(lod) {
  const lv = lod.levels;
  for (let i = 1; i < lv.length; i++) if (lv[i].distance >= 200 && lv[i].distance <= 800 && hasMesh(lv[i].object)) return lv[i].object;
  return lv.length ? lv[0].object : null;
}
function hasMesh(o) {
  let ok = false;
  o.traverse((m) => { if (m.isMesh && m.geometry) ok = true; });
  return ok;
}
function skipMaterial(m) {
  if (!m) return true;
  if (m.depthWrite === false || m.colorWrite === false) return true;
  if (m.blending === THREE.AdditiveBlending) return true;
  if (m.transparent && m.opacity < 0.6) return true;
  if (m.name && (SKIP_NAME.test(m.name) || SKIP_MAT.test(m.name))) return true;
  return false;
}

export class Occluders {
  constructor(terrain) {
    this.terrain = terrain;
    this.tiles = new Map();
    this.queue = []; // { mesh, tri, n, pos, idx, mw, flip, double }
    this.meshes = 0;
    this.tris = 0;
    this.ms = 0;
    this.version = 0; // 每次写入新数据 +1（缓存失效用）
    this.onIdle = null; // 队列清空时回调
  }

  get pending() {
    let n = 0;
    for (const q of this.queue) n += q.n - q.tri;
    return n;
  }

  _tile(tx, tz, create) {
    const k = tx * 100003 + tz;
    let t = this.tiles.get(k);
    if (!t && create) {
      t = { top: new Uint16Array(TS * TS), up: new Uint16Array(TS * TS), down: null, max: -Infinity };
      this.tiles.set(k, t);
    }
    return t;
  }

  /** 写一个采样点：top 取最高；face=1 朝上面 / -1 朝下面时另记该类的最低处（0 = 竖直面，只计 top） */
  _put(x, z, y, face) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const tx = Math.floor(cx / TS), tz = Math.floor(cz / TS);
    const t = this._tile(tx, tz, true);
    const i = (cz - tz * TS) * TS + (cx - tx * TS);
    const v = ENC(y);
    if (v > t.top[i]) {
      t.top[i] = v;
      if (y > t.max) t.max = y;
    }
    if (face > 0) {
      if (!t.up[i] || v < t.up[i]) t.up[i] = v;
    } else if (face < 0) {
      if (!t.down) t.down = new Uint16Array(TS * TS);
      if (!t.down[i] || v < t.down[i]) t.down[i] = v;
    }
  }

  _cell(x, z) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const tx = Math.floor(cx / TS), tz = Math.floor(cz / TS);
    const t = this.tiles.get(tx * 100003 + tz);
    if (!t) return null;
    const i = (cz - tz * TS) * TS + (cx - tx * TS);
    return t.top[i] ? { t, i } : null;
  }

  /** 该点上方实体的最高处（米，绝对高程）；无实体返回 -Infinity */
  topAt(x, z) {
    const c = this._cell(x, z);
    return c ? DEC(c.t.top[c.i]) : -Infinity;
  }

  /** 点是否在已登记实体内部（不在券洞顶 / 檐底 / 桥底之下的空间里） */
  solidAt(x, y, z) {
    const c = this._cell(x, z);
    if (!c) return false;
    const t = c.t, i = c.i;
    if (y > DEC(t.top[i]) - 0.3) return false;
    const dv = t.down ? t.down[i] : 0;
    if (dv) {
      // 头顶第一层是朝下面（且低于最低的朝上面）→ 上有顶、下是空
      const dl = DEC(dv), uv = t.up[i];
      if (y < dl - 0.05 && (!uv || dl < DEC(uv) - 0.15)) return false;
    }
    return true;
  }

  /**
   * 视线 a→b 是否被实体挡住。m0/m1：起点/终点各留多少米不算（相机贴近物体、标注锚点就在物体上时不误判）
   */
  segmentBlocked(ax, ay, az, bx, by, bz, m0 = 1, m1 = 6) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 1e-3 || !this.tiles.size) return false;
    const t0 = Math.min(0.5, m0 / L), t1 = Math.max(t0, 1 - m1 / L);
    if (t1 <= t0) return false;
    // 按块（64 m）走：块内实体最高处低于视线在该块内的最低处则整块跳过
    const span = TS * CELL;
    const stepT = Math.min(1, (span * 0.5) / L);
    for (let ta = t0; ta < t1; ta += stepT) {
      const tb = Math.min(t1, ta + stepT);
      const xa = ax + dx * ta, za = az + dz * ta, xb = ax + dx * tb, zb = az + dz * tb;
      const ylo = Math.min(ay + dy * ta, ay + dy * tb);
      // 这一小段跨越的块（最多 4 块）
      const kx0 = Math.floor(Math.min(xa, xb) / span), kx1 = Math.floor(Math.max(xa, xb) / span);
      const kz0 = Math.floor(Math.min(za, zb) / span), kz1 = Math.floor(Math.max(za, zb) / span);
      let need = false;
      for (let kx = kx0; kx <= kx1 && !need; kx++)
        for (let kz = kz0; kz <= kz1; kz++) {
          const t = this.tiles.get(kx * 100003 + kz);
          if (t && t.max > ylo) { need = true; break; }
        }
      if (!need) continue;
      const segL = (tb - ta) * L;
      const k = Math.max(1, Math.ceil(segL / (CELL * 0.7)));
      for (let s = 0; s <= k; s++) {
        const t = ta + ((tb - ta) * s) / k;
        const x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
        if (this.solidAt(x, y, z)) return true;
      }
    }
    return false;
  }

  // ———————————— 登记 ————————————

  /** 轴对齐外包盒（实体，无券洞） */
  addBox(x0, z0, x1, z1, y0, y1) {
    this.addPrism([x0, z0, x1, z0, x1, z1, x0, z1], y0, y1);
  }

  /** 轮廓棱柱：ring = [x,z, x,z, ...]，底 y0 顶 y1 */
  addPrism(ring, y0, y1) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]);
      x1 = Math.max(x1, ring[i]);
      z0 = Math.min(z0, ring[i + 1]);
      z1 = Math.max(z1, ring[i + 1]);
    }
    const n = ring.length / 2;
    for (let z = Math.floor(z0) + 0.5; z < z1; z += CELL)
      for (let x = Math.floor(x0) + 0.5; x < x1; x += CELL) {
        let inside = false;
        for (let a = 0, b = n - 1; a < n; b = a++) {
          const xa = ring[a * 2], za = ring[a * 2 + 1], xb = ring[b * 2], zb = ring[b * 2 + 1];
          if (za > z !== zb > z && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
        }
        if (inside) this._put(x, z, y1, 0);
      }
    // 轮廓边也写上（细长体量不漏格）
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const xa = ring[a * 2], za = ring[a * 2 + 1], xb = ring[b * 2], zb = ring[b * 2 + 1];
      const k = Math.max(1, Math.ceil(Math.hypot(xb - xa, zb - za) / (CELL * 0.5)));
      for (let s = 0; s <= k; s++) this._put(xa + ((xb - xa) * s) / k, za + ((zb - za) * s) / k, y1, 0);
    }
    void y0;
    this.version++;
  }

  /**
   * 登记一个对象子树的网格（分帧栅格化）。LOD 只取一级；InstancedMesh、发光/半透明/倒影材质跳过。
   */
  addObject(root) {
    if (!root) return;
    root.updateMatrixWorld(true);
    const visit = (o) => {
      if (o.isLOD) {
        const lv = pickLodLevel(o);
        if (lv) visit(lv);
        return;
      }
      if (o.isLight || o.isCamera || o.isLine || o.isPoints || o.isSprite) return;
      if (o !== root && o.name && SKIP_NAME.test(o.name)) return;
      if (o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && o.geometry?.attributes?.position) {
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        const pname = o.parent ? o.parent.name || '' : '';
        if (!skipMaterial(mat) && !SKIP_NAME.test(o.name || '') && !SKIP_NAME.test(pname)) {
          const g = o.geometry;
          const n = (g.index ? g.index.count : g.attributes.position.count) / 3 | 0;
          if (n > 0) {
            const mw = o.matrixWorld.clone();
            this.queue.push({ mesh: o, tri: 0, n, pos: g.attributes.position, idx: g.index, mw, flip: mw.determinant() < 0, d: 0 });
            this.meshes++;
          }
        }
      }
      // 同一层里既有“远景”又有“近景”两套（同一批建筑的两档精度）：只取远景档，省一半以上三角形
      const hasFar = o.children.some((c) => /远景/.test(c.name || ''));
      for (const c of o.children) if (!(hasFar && /近景/.test(c.name || ''))) visit(c);
    };
    visit(root);
  }

  /** 按离 (x,z) 的距离给队列排序（近处先做） */
  prioritize(x, z) {
    const v = new THREE.Vector3();
    for (const q of this.queue) {
      const g = q.mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      v.copy(g.boundingSphere.center).applyMatrix4(q.mw);
      const r = g.boundingSphere.radius * Math.cbrt(Math.abs(q.mw.determinant()) || 1);
      q.d = Math.max(0, Math.hypot(v.x - x, v.z - z) - r);
    }
    this.queue.sort((a, b) => a.d - b.d);
  }

  /** 处理队列，最多 budgetMs 毫秒（maxDist：只处理离优先点不超过该距离的网格）；返回剩余三角形数 */
  process(budgetMs = 4, maxDist = Infinity) {
    const t0 = performance.now();
    const T = this.terrain;
    const e = this._e || (this._e = new Float64Array(9));
    let done = 0;
    while (this.queue.length) {
      const q = this.queue[0];
      if (q.d > maxDist) break;
      const P = q.pos, I = q.idx, m = q.mw.elements;
      const inter = P.isInterleavedBufferAttribute;
      const pa = inter ? P.data.array : P.array, st = inter ? P.data.stride : P.itemSize, off = inter ? P.offset : 0;
      const ia = I ? I.array : null;
      const end = Math.min(q.n, q.tri + 3000);
      for (let f = q.tri; f < end; f++) {
        for (let k = 0; k < 3; k++) {
          const vi = (ia ? ia[f * 3 + k] : f * 3 + k) * st + off;
          const x = pa[vi], y = pa[vi + 1], z = pa[vi + 2];
          e[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
          e[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          e[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        this._raster(e, q.flip, T);
      }
      done += end - q.tri;
      this.tris += end - q.tri;
      q.tri = end;
      if (q.tri >= q.n) this.queue.shift();
      if (performance.now() - t0 > budgetMs) break;
    }
    this.ms += performance.now() - t0;
    if (done) this.version++;
    if (!this.queue.length && this.onIdle) {
      const f = this.onIdle;
      this.onIdle = null;
      f();
    }
    return this.pending;
  }

  _raster(e, flip, T) {
    const ax = e[0], ay = e[1], az = e[2], bx = e[3], by = e[4], bz = e[5], cx = e[6], cy = e[7], cz = e[8];
    if (!Number.isFinite(ax + ay + az + bx + by + bz + cx + cy + cz)) return;
    // 面法线（世界）的竖直分量
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
    let ny = uz * vx - ux * vz;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-8) return;
    ny /= flip ? -nl : nl;
    const ymax = ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy;
    // 贴地的低矮部分（铺装、草坪、台阶、路缘、矮墙、坐凳）不算遮挡体：最高点离地形不到 1.3 m
    if (ymax < T.heightAt((ax + bx + cx) / 3, (az + bz + cz) / 3) + 1.3) return;
    const face = ny > 0.3 ? 1 : ny < -0.3 ? -1 : 0;
    const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx), z0 = Math.min(az, bz, cz), z1 = Math.max(az, bz, cz);
    // 小三角形：外包盒落在一个格内 → 直接写（top 取最高点，朝上/朝下面取最低点）
    if (Math.floor(x0 / CELL) === Math.floor(x1 / CELL) && Math.floor(z0 / CELL) === Math.floor(z1 / CELL)) {
      this._put(x0, z0, ymax, 0);
      if (face) this._put(x0, z0, Math.min(ay, by, cy), face);
      return;
    }
    const a2 = Math.abs(ux * vz - uz * vx); // 水平投影面积 ×2
    const edge = Math.max(Math.hypot(ux, uz), Math.hypot(vx, vz), Math.hypot(cx - bx, cz - bz));
    if (a2 < 0.08 * edge) {
      // 近竖直面（墙）：沿三条边采样，墙顶自然取到
      const k = Math.max(1, Math.ceil(edge / (CELL * 0.5)));
      for (let s = 0; s <= k; s++) {
        const t = s / k;
        this._put(ax + (bx - ax) * t, az + (bz - az) * t, ay + (by - ay) * t, 0);
        this._put(bx + (cx - bx) * t, bz + (cz - bz) * t, by + (cy - by) * t, 0);
        this._put(cx + (ax - cx) * t, cz + (az - cz) * t, cy + (ay - cy) * t, 0);
      }
      return;
    }
    // 一般三角形：沿最长边逐行扫描（采样间距 ≤ 0.7 格；细长三角形不会退化成 O(边长²)）
    let pAx = ax, pAy = ay, pAz = az, pBx = bx, pBy = by, pBz = bz, pCx = cx, pCy = cy, pCz = cz;
    const lab = ux * ux + uz * uz, lbc = (cx - bx) ** 2 + (cz - bz) ** 2, lca = vx * vx + vz * vz;
    if (lbc >= lab && lbc >= lca) [pAx, pAy, pAz, pBx, pBy, pBz, pCx, pCy, pCz] = [bx, by, bz, cx, cy, cz, ax, ay, az];
    else if (lca >= lab && lca >= lbc) [pAx, pAy, pAz, pBx, pBy, pBz, pCx, pCy, pCz] = [cx, cy, cz, ax, ay, az, bx, by, bz];
    const L = Math.hypot(pBx - pAx, pBz - pAz) || 1e-6;
    const H = a2 / L; // 对最长边的高
    const rows = Math.max(1, Math.ceil(H / (CELL * 0.7)));
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      const sx = pAx + (pCx - pAx) * v, sy = pAy + (pCy - pAy) * v, sz = pAz + (pCz - pAz) * v;
      const ex = pBx + (pCx - pBx) * v, ey = pBy + (pCy - pBy) * v, ez = pBz + (pCz - pBz) * v;
      const n = Math.max(1, Math.ceil((L * (1 - v)) / (CELL * 0.7)));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        this._put(sx + (ex - sx) * t, sz + (ez - sz) * t, sy + (ey - sy) * t, face);
      }
    }
  }

  stats() {
    let bytes = 0, filled = 0;
    for (const t of this.tiles.values()) {
      bytes += t.top.byteLength * 2 + (t.down ? t.down.byteLength : 0);
      for (let i = 0; i < t.top.length; i++) if (t.top[i]) filled++;
    }
    return { tiles: this.tiles.size, meshes: this.meshes, tris: this.tris, pending: this.pending, ms: Math.round(this.ms), mb: +(bytes / 1048576).toFixed(1), fill: +(filled / (this.tiles.size * TS * TS || 1)).toFixed(2) };
  }
}

/** 精建模块（参与遮挡）；通用建筑 buildings 自带 occluded()，道路/植被/车流/行人/水面/街道小品不算 */
export const OCCLUDER_MODULES = new Set(['citywall', 'belltower', 'pagoda', 'datang', 'qujiang', 'heritage', 'heritage26', 'dossier', 'skyline', 'huimin', 'mixc', 'sunken', 'airports', 'weiyang']);
