// 用地与公园：不再绘制纯色用地色块（卫星影像已有真实地面），用地数据只供植被模块决定种树位置/密度。
// 本模块只做两件事：
//  1. 大型公园/绿地极淡的色调增强（草地略提绿、降一点灰度），贴地网格按地形逐点贴合，只在城区近处可见；
//  2. 少量公园地名标注（≤ 6 个）。
import * as THREE from 'three';
import { toShape, polyCentroid } from '../core/util.js';

// 只标这些（大唐芙蓉园/曲江池等由曲江模块负责）
const LABELS = ['兴庆宫公园', '革命公园', '莲湖公园', '丰庆公园', '劳动公园', '唐城墙遗址公园'];
const TINT_KINDS = new Set(['park', 'grass']);
const TINT_RADIUS = 11000; // 只增强城区（远处影像分辨率低，色块会显脏）
const MIN_AREA = 6000;

export default {
  id: 'landuse',
  name: '公园与用地',
  async build(ctx) {
    const root = new THREE.Group();
    root.name = '公园绿地色调';
    ctx.scene.add(root);
    const polys = ctx.data.landuse?.polys || [];

    // —— 1. 极淡的绿地色调增强（乘法混合：只改变色相/饱和度，不遮盖影像纹理） ——
    const P = [], I = [];
    let nv = 0;
    const th = ctx.terrain;
    for (const f of polys) {
      if (!TINT_KINDS.has(f.k) || !f.outer || f.outer.length < 6) continue;
      if ((f.a || 0) < MIN_AREA) continue;
      const c = polyCentroid(f.outer);
      if (Math.hypot(c.x, c.z) > TINT_RADIUS) continue;
      let g;
      try {
        g = new THREE.ShapeGeometry(toShape(f.outer, f.holes || []), 1);
      } catch (e) {
        continue;
      }
      // 大三角形细分，保证贴地
      const pos = g.attributes.position;
      const idx = g.index ? g.index.array : null;
      const tris = [];
      const nT = idx ? idx.length / 3 : pos.count / 3;
      for (let t = 0; t < nT; t++) {
        const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, cI = idx ? idx[t * 3 + 2] : t * 3 + 2;
        tris.push([pos.getX(a), -pos.getY(a)], [pos.getX(b), -pos.getY(b)], [pos.getX(cI), -pos.getY(cI)]); // toShape 用 (x, -z)
      }
      g.dispose();
      // 地形挖洞（下沉广场坑口）处不铺色调面：色调面贴在地面高度，会把坑内的墙和坑底一起染绿；洞口附近细分到 1.5 m 再剔除
      const holes = th.holes || [];
      const nearHole = (a, b, c) => holes.some((h) => Math.max(a[0], b[0], c[0]) > h.bb.x0 && Math.min(a[0], b[0], c[0]) < h.bb.x1 && Math.max(a[1], b[1], c[1]) > h.bb.z0 && Math.min(a[1], b[1], c[1]) < h.bb.z1);
      const emit = (a, b, c, depth) => {
        const la = Math.hypot(a[0] - b[0], a[1] - b[1]), lb = Math.hypot(b[0] - c[0], b[1] - c[1]), lc = Math.hypot(c[0] - a[0], c[1] - a[1]);
        const L = Math.max(la, lb, lc);
        const hole = holes.length && nearHole(a, b, c);
        // 近洞细分到 1.5 m；三个顶点或质心任一落进洞就整块丢弃（只看质心会留下伸进坑口 1~2 m 的薄片）
        if (hole && L <= 1.5 && (th.inHole(a[0], a[1]) || th.inHole(b[0], b[1]) || th.inHole(c[0], c[1]) || th.inHole((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3))) return;
        if ((L > 60 && depth < 7) || (hole && L > 1.5 && depth < 20)) {
          // 最长边二分
          if (L === la) {
            const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            emit(a, m, c, depth + 1);
            emit(m, b, c, depth + 1);
          } else if (L === lb) {
            const m = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
            emit(a, b, m, depth + 1);
            emit(a, m, c, depth + 1);
          } else {
            const m = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
            emit(a, b, m, depth + 1);
            emit(m, b, c, depth + 1);
          }
          return;
        }
        for (const p of [a, b, c]) {
          P.push(p[0], th.heightAt(p[0], p[1]) + 0.25, p[1]);
          I.push(nv++);
        }
      };
      for (let k = 0; k < tris.length; k += 3) emit(tris[k], tris[k + 1], tris[k + 2], 0);
    }
    if (I.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      // ShapeGeometry 的环向在 x/z 平面上可能是顺/逆时针，统一双面
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.9, 1.0, 0.86),
        blending: THREE.MultiplyBlending,
        premultipliedAlpha: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      ctx.overlay(mat, 0.0012);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = '公园草地色调';
      mesh.renderOrder = -1;
      mesh.frustumCulled = true;
      geo.computeBoundingSphere();
      mesh.receiveShadow = false;
      root.add(mesh);
    }

    // —— 2. 公园标注 ——
    const done = new Set();
    for (const f of polys) {
      if (!f.n || done.has(f.n) || !LABELS.includes(f.n) || f.k !== 'park') continue;
      done.add(f.n);
      const c = polyCentroid(f.outer);
      const x = c.x, z = c.z;
      ctx.labels.add(f.n, new THREE.Vector3(x, th.heightAt(x, z) + 24, z), { category: 'district', minDist: 300, maxDist: 9000, priority: 1.0 });
      if (done.size >= 6) break;
    }

    return {
      setLayer(layer, on) {
        if (layer === 'landuse') root.visible = on;
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};
