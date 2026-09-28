// 高德深度数据图层：行政区界（区县边界 + 街道/镇名）、商圈（POI business_area 聚合）、地铁全线网与车站。
// 数据：public/data/amap_extra.json（tools/amap_fetch.py metro / district / poi → merge）；文件不存在时本模块不做任何事。
// 图层开关“行政区界·商圈·地铁线”（默认关）：控制三维线框与街道/商圈/车站标注；区县名随“地名标注”常显。
import * as THREE from 'three';
import { BOUNDS, lonLatBoxToWorld } from '../core/geo.js';

// 西安地铁线路标识色（近似官方配色）
const LINE_COLOR = {
  1: '#0068b7', 2: '#e60012', 3: '#b67bb4', 4: '#00a29a', 5: '#8fc31f', 6: '#1d2088', 8: '#f4a100',
  9: '#f39800', 10: '#7d6fb0', 14: '#5bb5d7', 15: '#c4a86b', 16: '#e5007f',
};
const LAYER_CATS = ['town', 'biz', 'metro'];

export default {
  id: 'amapinfo',
  name: '高德区划·商圈·地铁',
  build(ctx) {
    const D = ctx.data.amapExtra;
    const group = new THREE.Group();
    group.name = 'amapinfo';
    group.visible = false;
    ctx.scene.add(group);
    const labels = ctx.labels;
    for (const c of LAYER_CATS) labels.hidden.add(c);
    if (!D) return { update() {}, setLayer() {}, dispose() { ctx.scene.remove(group); } };

    const box = lonLatBoxToWorld(BOUNDS.OUTER);
    const inBox = (x, z, m = 0) => x > box.x0 + m && x < box.x1 - m && z > box.z0 + m && z < box.z1 - m;
    const H = (x, z) => ctx.terrain.heightAt(x, z);

    /** 折线（扁平 x,z）→ 贴地线段（每 step 米加密，框外的段丢弃），写入 pos/col */
    const drape = (p, closed, lift, step, color, pos, col, dash = 0) => {
      const n = p.length / 2;
      const m = closed ? n : n - 1;
      let run = 0;
      for (let i = 0; i < m; i++) {
        const ax = p[i * 2], az = p[i * 2 + 1], j = (i + 1) % n, bx = p[j * 2], bz = p[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        const k = Math.max(1, Math.ceil(L / step));
        for (let s = 0; s < k; s++) {
          const x0 = ax + (bx - ax) * s / k, z0 = az + (bz - az) * s / k;
          const x1 = ax + (bx - ax) * (s + 1) / k, z1 = az + (bz - az) * (s + 1) / k;
          run++;
          if (dash && run % 2) continue;
          if (!inBox(x0, z0, 50) || !inBox(x1, z1, 50)) continue;
          pos.push(x0, H(x0, z0) + lift, z0, x1, H(x1, z1) + lift, z1);
          col.push(color.r, color.g, color.b, color.r, color.g, color.b);
        }
      }
    };
    const mkLines = (pos, col, opacity, name) => {
      if (!pos.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, fog: false });
      const l = new THREE.LineSegments(g, m);
      l.name = name;
      l.renderOrder = 3;
      l.frustumCulled = false;
      group.add(l);
    };
    const V = (x, z, up) => new THREE.Vector3(x, H(x, z) + up, z);

    // —— 行政区 ——
    const dpos = [], dcol = [];
    const dc = new THREE.Color('#ffcc66');
    for (const d of D.districts || []) {
      for (const r of d.rings) drape(r, true, 6, 60, dc, dpos, dcol);
      if (d.c && inBox(d.c[0], d.c[1], 200)) {
        labels.add(d.n, V(d.c[0], d.c[1], 160), { category: 'admin', priority: 2.2, minDist: 2500, maxDist: 60000 });
      }
      for (const s of d.st || []) {
        if (inBox(s.c[0], s.c[1], 100)) labels.add(s.n, V(s.c[0], s.c[1], 40), { category: 'town', priority: 0.7, minDist: 500, maxDist: 9000 });
      }
    }
    mkLines(dpos, dcol, 0.9, 'amap-districts');

    // —— 商圈 ——
    const bpos = [], bcol = [];
    const bc = new THREE.Color('#4fc3f7');
    for (const b of D.business || []) {
      if (!inBox(b.x, b.z, 100)) continue;
      const ring = [];
      const seg = Math.max(24, Math.round(b.r / 25));
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        ring.push(b.x + Math.cos(a) * b.r, b.z + Math.sin(a) * b.r);
      }
      drape(ring, true, 4, 30, bc, bpos, bcol, 1);
      labels.add(b.n, V(b.x, b.z, 55), { category: 'biz', sub: '商圈', priority: 1.3 + Math.min(1, b.c / 800), minDist: 250, maxDist: 14000 });
    }
    mkLines(bpos, bcol, 0.85, 'amap-business');

    // —— 地铁线网与车站 ——
    const mpos = [], mcol = [];
    const stations = new Map();
    for (const L of D.metro || []) {
      const c = new THREE.Color(LINE_COLOR[L.num] || '#9aa4b0');
      drape(L.p, false, 3, 40, c, mpos, mcol);
      for (const s of L.s) {
        const k = s.n;
        const it = stations.get(k) || { x: s.x, z: s.z, lines: [] };
        it.lines.push(L.num ? `${L.num}号线` : L.n);
        stations.set(k, it);
      }
    }
    mkLines(mpos, mcol, 0.95, 'amap-metro');
    for (const [n, s] of stations) {
      if (inBox(s.x, s.z, 50)) labels.add(n, V(s.x, s.z, 22), { category: 'metro', sub: s.lines.join(' · '), priority: 0.9 + 0.2 * s.lines.length, minDist: 120, maxDist: 6000 });
    }

    return {
      update() {},
      setLayer(layer, v) {
        if (layer !== 'districts') return;
        group.visible = v;
        for (const c of LAYER_CATS) (v ? labels.hidden.delete(c) : labels.hidden.add(c));
      },
      dispose() {
        group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
        ctx.scene.remove(group);
      },
    };
  },
};
