// 小区大门：按 public/data/estates_style.json 里有照片依据的大门（tools/build_estates.py GATES 表）生成简单门楼/门架。
//
// 位置：构建脚本用 Overture 道路与小区多边形边界的交点定位（离主干道最近、门体不压楼的入口），dx/dz 为车道方向（指向小区内）。
// 形式（照片目测，尺寸为按照片估计的常见尺度）：
//   booth 岗亭+道闸 / pillars 石材门柱 / beam 门柱+横梁 / arcbeam 门柱+弧形横梁 / frame 方框门架 / paifang 三开间牌坊式门楼 /
//   arch 拱门门楼（可带两侧门房）/ arch3 三拱门楼 / gatehouse 门房（拱形门洞+坡屋顶）/ canopy 钢构雨棚门廊 / bridge 二层连廊门廊
// 全部合并成一个网格（顶点色 + 一个材质，1 次 draw call），离相机远时整体隐藏。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _c = new THREE.Color();

/** 给几何体加顶点色（sRGB 十六进制 → 线性），去掉 uv 便于合并 */
function paint(g, hex, k = 1) {
  if (g.index) g = g.toNonIndexed();
  g.deleteAttribute('uv');
  _c.set(hex).multiplyScalar(k);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) (a[i * 3] = _c.r), (a[i * 3 + 1] = _c.g), (a[i * 3 + 2] = _c.b);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** 大门局部坐标系：r 沿边界（横跨车道），f 沿车道（指向小区内），y 向上；原点 = 边界交点处地面 */
class GateFrame {
  constructor(x, y, z, dx, dz) {
    const l = Math.hypot(dx, dz) || 1;
    this.f = [dx / l, dz / l];
    this.r = [dz / l, -dx / l]; // (r, 上, f) 为右手系（行列式 +1），面朝向不翻转
    this.o = [x, y, z];
    this.m = new THREE.Matrix4().set(this.r[0], 0, this.f[0], x, 0, 1, 0, y, this.r[1], 0, this.f[1], z, 0, 0, 0, 1);
    this.geos = [];
  }
  add(g, hex, k = 1) {
    g.applyMatrix4(this.m);
    this.geos.push(paint(g, hex, k));
  }
  /** 盒体：局部中心 (r, y, f)，尺寸 (w 沿 r, h, d 沿 f) */
  box(r, y, f, w, h, d, hex, k) {
    this.add(new THREE.BoxGeometry(w, h, d).translate(r, y + h / 2, f), hex, k);
  }
  cyl(r, y, f, rad, h, hex, seg = 12, k) {
    this.add(new THREE.CylinderGeometry(rad, rad, h, seg).translate(r, y + h / 2, f), hex, k);
  }
  /** 四坡屋顶（4 棱锥），底边 w×d */
  hip(r, y, f, w, d, h, hex) {
    const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).scale(w, h, d).translate(r, y + h / 2, f);
    this.add(g, hex);
  }
  /** 带洞的竖直墙体（沿 r 展开，厚 depth 沿 f）：outer 宽 w 高 h；holes = [[中心 r, 宽, 起拱高, 拱形?]] */
  archWall(r0, y, f, w, h, depth, holes, hex) {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0);
    s.lineTo(w / 2, 0);
    s.lineTo(w / 2, h);
    s.lineTo(-w / 2, h);
    s.lineTo(-w / 2, 0);
    for (const [hc, hw, spring, arched] of holes) {
      const p = new THREE.Path();
      const a = hc - hw / 2, b = hc + hw / 2;
      p.moveTo(a, 0);
      p.lineTo(a, spring);
      if (arched) p.absarc(hc, spring, hw / 2, Math.PI, 0, true);
      else p.lineTo(b, spring);
      p.lineTo(b, 0);
      p.lineTo(a, 0);
      s.holes.push(p);
    }
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 10 });
    // Extrude 沿 +Z（= 局部 f），墙面在 XY（X = r）
    g.translate(r0, y, f - depth / 2);
    this.add(g, hex);
  }
}

/** 按类型生成一座大门 */
function buildGate(F, g) {
  const col = g.col || '#cccccc', acc = g.acc || '#666666';
  const H = g.h || 6;
  const span = Math.max(6, g.span || 7.5); // 车道净宽（双向 2 车道 + 余量）
  const hs = span / 2;
  const b = -0.6; // 基础埋入地下（坡地不悬空）
  switch (g.type) {
    case 'booth': {
      // 岗亭（车道右侧）+ 道闸横杆
      F.box(hs + 2.0, b, 1.5, 2.8, H - b, 2.6, col);
      F.box(hs + 2.0, H, 1.5, 3.4, 0.25, 3.2, '#5a5a5c');
      F.box(hs + 2.0, 1.1, 1.5 - 1.31, 1.9, 1.0, 0.04, '#26303a'); // 窗
      F.box(hs + 0.35, b, 0.2, 0.35, 1.0 - b, 0.35, '#3a3a3c'); // 道闸机箱
      F.box(0, 0.95, 0.2, span - 0.6, 0.07, 0.07, acc); // 横杆
      break;
    }
    case 'pillars': {
      for (const s of [-1, 1]) {
        F.box(s * (hs + 0.7), b, 0, 1.2, H - b, 1.2, col);
        F.box(s * (hs + 0.7), H, 0, 1.45, 0.3, 1.45, col, 1.12);
      }
      F.box(hs + 3.2, b, 1.8, 2.6, 2.9 - b, 2.4, '#d6d2ca'); // 岗亭
      F.box(hs + 3.2, 2.9, 1.8, 3.0, 0.22, 2.8, '#5a5a5c');
      F.box(0, 0.95, 0.4, span - 0.4, 0.07, 0.07, acc);
      break;
    }
    case 'beam': {
      for (const s of [-1, 1]) F.box(s * (hs + 0.8), b, 0, 1.5, H - b, 1.5, col);
      F.box(0, H - 1.3, 0, span + 3.4, 1.3, 1.2, col, 1.05);
      F.box(0, H - 1.15, -0.62, span * 0.55, 1.0, 0.05, acc); // 匾额/立体字
      F.box(0, H, 0, span + 3.8, 0.22, 1.5, col, 1.12); // 压顶
      break;
    }
    case 'arcbeam': {
      // 两根立柱 + 横跨车道的弧形门楣（丰盛园：黄色立柱、红色弧形门楣）
      for (const s of [-1, 1]) F.cyl(s * (hs + 0.5), b, 0, 0.45, H + 0.6 - b, col, 14);
      const n = 12, R = (hs + 0.5) / Math.sin(0.9), cy = H - R * Math.cos(0.9);
      for (let k = 0; k < n; k++) {
        const a0 = -0.9 + (1.8 * k) / n, a1 = -0.9 + (1.8 * (k + 1)) / n;
        const x0 = R * Math.sin(a0), y0 = cy + R * Math.cos(a0), x1 = R * Math.sin(a1), y1 = cy + R * Math.cos(a1);
        const L = Math.hypot(x1 - x0, y1 - y0);
        const seg = new THREE.BoxGeometry(L + 0.05, 1.1, 0.5).rotateZ(Math.atan2(y1 - y0, x1 - x0)).translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
        F.add(seg, acc);
      }
      F.box(hs + 2.5, b, 1.6, 2.4, 2.8 - b, 2.2, '#dcd8d0'); // 岗亭
      break;
    }
    case 'frame': {
      // 方框门架：两侧立柱（墙片）+ 顶部横梁；荣华EE康城为竖向格栅框架门楼，顶部立红色大字
      const big = H >= 9;
      const pw = big ? 2.4 : 0.8;
      for (const s of [-1, 1]) {
        F.box(s * (hs + pw / 2), b, 0, pw, H - b, big ? 6 : 0.9, col);
        if (big) for (let k = 0; k < 4; k++) F.box(s * (hs + pw / 2), 1.0, -3.05, 0.12, H - 1.6, 0.12, '#5c5e62'); // 格栅
      }
      F.box(0, H - 1.0, 0, span + 2 * pw, 1.0, big ? 6 : 1.0, col, 1.04);
      if (big) F.box(0, H, 0, span * 0.8, 1.6, 0.3, acc); // 顶部大字
      break;
    }
    case 'paifang': {
      // 三开间牌坊式门楼：中间车道，两侧人行门；方柱 + 横梁 + 深色坡顶檐帽/门楣
      const side = 3.2;
      const xs = [-(hs + side + 0.4), -hs - 0.4, hs + 0.4, hs + side + 0.4];
      xs.forEach((x, k) => {
        const hh = k === 1 || k === 2 ? H : H - 1.4;
        F.box(x, b, 0, 0.9, hh - b, 0.9, col);
        F.hip(x, hh, 0, 1.3, 1.3, 0.8, acc);
      });
      F.box(0, H - 1.6, 0, span + 0.8, 1.1, 0.8, col, 1.06); // 中间门楣
      F.box(0, H - 1.5, -0.42, span * 0.5, 0.8, 0.05, acc === '#c83a2a' ? '#8a1c14' : '#2a2826'); // 匾额
      for (const s of [-1, 1]) F.box(s * (hs + side / 2 + 0.4), H - 2.8, 0, side, 0.8, 0.7, col, 1.06);
      F.hip(0, H - 0.5, 0, span + 1.8, 1.8, 1.1, acc);
      if (acc === '#c83a2a') for (const x of [-hs * 0.5, hs * 0.5]) F.add(new THREE.SphereGeometry(0.4, 10, 8).translate(x, H - 2.3, -0.3), '#d02a1c'); // 红灯笼
      break;
    }
    case 'arch': {
      const w = span + 4.4, d = 2.8;
      F.archWall(0, b, 0, w, H - b, d, [[0, span, H * 0.52 - b, true]], col);
      F.box(0, H * 0.52 + hs + 0.3, 0, w + 0.5, 0.45, d + 0.5, acc); // 拱上檐口线脚
      F.box(0, H, 0, w + 0.7, 0.4, d + 0.7, col, 1.08); // 顶部檐口
      for (const s of [-1, 1]) F.box(s * (w / 2 - 0.6), b, -d / 2 - 0.15, 1.0, H - b, 0.3, col, 1.06); // 壁柱
      if (g.wings) {
        for (const s of [-1, 1]) {
          F.box(s * (w / 2 + 2.8), b, 0, 5.2, 4.2 - b, 5.0, col);
          F.hip(s * (w / 2 + 2.8), 4.2, 0, 5.8, 5.6, 1.8, acc);
        }
      }
      break;
    }
    case 'arch3': {
      const side = 2.6, w = span + 2 * side + 5.0, d = 3.0;
      const sc = span / 2 + 1.2 + side / 2;
      F.archWall(0, b, 0, w, H - b, d, [[0, span, H * 0.5 - b, true], [-sc, side, 3.2 - b, true], [sc, side, 3.2 - b, true]], col);
      F.box(0, H, 0, w + 0.8, 0.45, d + 0.8, col, 1.08);
      F.box(0, H * 0.5 + hs + 0.2, -d / 2 - 0.05, span * 0.5, 0.9, 0.1, acc); // 门楣字牌
      for (const x of [-(span / 2 + 0.6), span / 2 + 0.6, -(w / 2 - 0.5), w / 2 - 0.5]) F.box(x, b, -d / 2 - 0.2, 0.9, H - b, 0.4, col, 1.06);
      F.box(0, b, d / 2 - 0.3, span - 0.4, 3.8 - b, 0.08, acc, 0.6); // 中门深色金属门扇（半掩）
      break;
    }
    case 'gatehouse': {
      // 门房（车道一侧，拱形门洞朝路）+ 坡屋顶；车道上为铁艺栅门
      const big = H >= 7;
      const w = big ? 10 : 6, dd = big ? 7 : 5, hh = big ? H - 2.2 : H - 2.0;
      const cxr = hs + w / 2 + 0.6;
      F.box(cxr, b, dd / 2 - 1, w, hh - b, dd, col);
      F.box(cxr, hh, dd / 2 - 1, w + 0.6, 0.35, dd + 0.6, col, 1.08);
      F.hip(cxr, hh + 0.35, dd / 2 - 1, w + 0.4, dd + 0.4, H - hh - 0.35, acc);
      F.archWall(cxr, 0, -1.02, 2.0, 3.2, 0.06, [[0, 1.6, 2.2, true]], '#2e2a28'); // 拱形门洞（深色门扇）
      F.box(0, 0, 0.2, span, 1.8, 0.06, '#232325'); // 铁艺栅门
      F.box(-(hs + 0.4), b, 0.2, 0.7, 2.4 - b, 0.7, col);
      break;
    }
    case 'canopy': {
      // 钢构雨棚门廊：四柱 + 挑出雨棚 + 正面金色大字招牌；两侧门房
      const D = 8;
      for (const s of [-1, 1]) for (const f of [-D / 2 + 0.5, D / 2 - 0.5]) F.cyl(s * (hs + 0.5), b, f, 0.25, H - b, '#8a9096', 10);
      F.box(0, H, 0, span + 3.0, 0.5, D + 1.0, col);
      F.box(0, H - 0.2, -D / 2 - 0.55, span + 2.6, 1.3, 0.2, '#3a3c40');
      F.box(0, H + 0.05, -D / 2 - 0.68, span * 0.85, 0.9, 0.05, acc);
      for (const s of [-1, 1]) {
        F.box(s * (hs + 3.0), b, 1.5, 4.0, 3.6 - b, 4.0, '#e2e2dc');
        F.box(s * (hs + 3.0), 3.6, 1.5, 4.4, 0.3, 4.4, '#2e8a86');
      }
      break;
    }
    case 'bridge': {
      // 二层连廊门廊：横跨车道的连廊体量架在白色圆柱上，两端落地楼梯间
      const L = span + 12, D = 6, y0 = H - 3.6;
      F.box(0, y0, 0, L, 3.6, D, col);
      F.box(0, y0 + 1.0, -D / 2 - 0.02, L - 1.0, 1.6, 0.05, '#34414a'); // 连廊窗带
      F.box(0, y0 + 1.0, D / 2 + 0.02, L - 1.0, 1.6, 0.05, '#34414a');
      F.box(0, H, 0, L + 0.6, 0.3, D + 0.6, acc);
      for (const s of [-1, 1]) {
        for (const f of [-D / 2 + 0.6, D / 2 - 0.6]) F.cyl(s * (hs + 0.8), b, f, 0.45, y0 - b, '#f2f0ea', 16);
        F.box(s * (L / 2 - 2.0), b, 0, 4.0, y0 - b, D - 0.4, col, 0.96);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 生成全部小区大门
 * @param ctx 模块上下文（terrain.heightAt）
 * @param doc estates_style.json
 * @returns {{group: THREE.Group, count: number, dispose: Function, update: Function}}
 */
export function buildEstateGates(ctx, doc) {
  const group = new THREE.Group();
  group.name = '小区大门';
  const geos = [];
  const pts = [];
  for (const e of doc?.estates || []) {
    const g = e.gate;
    if (!g || !isFinite(g.x) || !isFinite(g.z)) continue;
    const y = ctx.terrain.heightAt(g.x, g.z);
    const F = new GateFrame(g.x, y, g.z, g.dx, g.dz);
    try {
      buildGate(F, g);
    } catch (err) {
      console.warn('[buildings] 大门生成失败', e.name, err);
      continue;
    }
    geos.push(...F.geos);
    pts.push([g.x, g.z]);
  }
  let mesh = null;
  if (geos.length) {
    for (const g of geos) for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    merged.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.05, envMapIntensity: 0.6 });
    mat.name = '小区大门';
    mesh = new THREE.Mesh(merged, mat);
    mesh.name = '小区大门';
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  const RANGE = 3500;
  return {
    group,
    count: pts.length,
    /** 相机离所有大门都远时隐藏（省阴影与绘制） */
    update(cam) {
      if (!mesh) return;
      let near = false;
      for (const [x, z] of pts) if (Math.abs(cam.x - x) < RANGE && Math.abs(cam.z - z) < RANGE) (near = true);
      mesh.visible = near;
    },
    dispose() {
      if (mesh) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
  };
}
