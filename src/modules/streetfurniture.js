// 全城街道设施：精建片区（streetscape）之外的所有主次干道人行道——
//   路口悬臂信号灯（机动车灯三灯竖排 + 人行横道两端人行灯，按 64 s 周期红黄绿切换，东西/南北两相位相反，夜间发光）、
//   蓝底白字路名牌（中文 + 拼音，转角立杆，每路口 2~4 块）、交通标志（限速、禁止停车、人行横道、公交专用）、
//   公交站（OSM 2975 个站点吸附到道路外侧人行道：候车亭 + 檐口站名 + 夜间发光的广告灯箱 + 长凳 + 站牌杆）、
//   人行道小品（分类双桶垃圾桶约 50 m、阻车石球/不锈钢桩、成簇共享单车（美团黄/哈啰蓝/青桔绿）停在地铁口/公交站/路段、
//   电动车（部分带外卖箱）、消火栓、配电箱、少量报刊亭）、主干道路口部分路段人行道护栏。
// 布置规则见 src/arch/furniture-place.js；构件几何/材质/图集见 src/arch/furniture-geo.js；数据见 src/arch/furniture-data.js。
//
// 性能：只在相机附近按 450 m 分块流式生成/卸载（大件 1.2 km、小件 450 m、护栏 700 m，随画质缩放；离地 > 600 m 全部隐藏），
//   每种构件一个全局 InstancedMesh（约 21 个 draw call），分块变化时重拼实例缓冲；文字全部进一张 2048² 动态图集（引用计数回收）。
import * as THREE from 'three';
import { Planner, CHUNK } from '../arch/furniture-place.js';
import { makeGeometries, makeMaterials, TextAtlas } from '../arch/furniture-geo.js';

// [名称, 材质, 距离档 far/mid/near, 投影, 实例色, 自定义实例属性]
const POOLS = [
  ['sigPole', 'metal', 'far', true, false],
  ['sigArm', 'metal', 'far', true, false],
  ['sigHead', 'matte', 'far', true, false],
  ['pedHead', 'matte', 'far', true, false],
  ['lens', 'lens', 'far', false, false, { aSig: 4 }],
  ['post', 'metal', 'far', true, true],
  ['plate', 'plate', 'far', true, false, { aUV: 4, aUV2: 4 }],
  ['ad', 'ad', 'far', false, false, { aUV: 4, aUV2: 4 }],
  ['pane', 'glass', 'far', false, false],
  ['shelter2', 'metal', 'far', true, false],
  ['shelter3', 'metal', 'far', true, false],
  ['kiosk', 'paint', 'far', true, false],
  ['fence', 'paint', 'mid', true, false],
  ['bin', 'paint', 'near', true, false],
  ['bike', 'paint', 'near', true, true],
  ['ebike', 'paint', 'near', true, true],
  ['dbox', 'paint', 'near', true, true],
  ['hydrant', 'paint', 'near', false, false],
  ['cabinet', 'paint', 'near', true, true],
  ['ball', 'matte', 'near', false, false],
  ['bollard', 'metal', 'near', false, false],
];
// 距离档半径（画质 低/中/高/超高）
const RADII = {
  far: [600, 900, 1200, 1500],
  mid: [350, 500, 700, 900],
  near: [250, 350, 450, 560],
  text: [300, 450, 650, 800], // 路名牌/站牌文字（图集 105 格）只在此半径内的分块生成
};
const HIDE_AGL = 600; // 相机离地高于此值：全部隐藏、不再生成
const NEAR_AGL = 70; // 小件只在相机离地低于此值时显示

export default {
  id: 'streetfurniture',
  name: '全城街道设施',

  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = '全城街道设施';
    ctx.scene.add(root);
    const atlas = new TextAtlas();
    const M = makeMaterials(ctx, atlas);
    const G = makeGeometries();
    const planner = new Planner(ctx);
    planner.posters = M.posterCell;

    // —— 实例池 ——
    const pools = POOLS.map(([name, mat, range, shadow, color, attrs]) => ({ name, mat: M[mat], geo: G[name], range, shadow, color, attrs: attrs || {}, cap: 0, mesh: null }));
    const grow = (P, n) => {
      if (P.mesh && n <= P.cap) return;
      const cap = Math.max(64, Math.ceil(n * 1.5));
      if (P.mesh) { root.remove(P.mesh); P.mesh.dispose(); P.geo.dispose(); }
      for (const k in P.attrs) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * P.attrs[k]), P.attrs[k]);
        a.setUsage(THREE.DynamicDrawUsage);
        P.geo.setAttribute(k, a);
      }
      const m = new THREE.InstancedMesh(P.geo, P.mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (P.color) {
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = P.shadow && !!ctx.quality.shadows;
      m.receiveShadow = P.name !== 'lens' && P.name !== 'pane';
      m.matrixAutoUpdate = false;
      m.name = '街道设施-' + P.name;
      if (P.name === 'pane') m.renderOrder = 2;
      root.add(m);
      P.mesh = m;
      P.cap = cap;
    };

    // —— 分块 ——
    const chunks = new Map(); // key -> {i,j,data,keys,dist,act:{far,mid,near}}
    const key = (i, j) => i * 100003 + j;
    let level = Math.max(0, Math.min(3, ctx.quality.level ?? 2));
    const radii = (l) => ({ far: RADII.far[l], mid: RADII.mid[l], near: RADII.near[l], text: RADII.text[l] });
    let R = radii(level);
    let queue = [];
    let dirty = false;
    let visible = true, layerOn = true;
    let frame = 0;
    const lastPos = new THREE.Vector3(1e9, 0, 1e9);
    const stats = { chunks: 0, gen: 0, genMs: 0, inst: 0 };
    const cam = ctx.camera;

    const rectDist = (i, j, x, z) => {
      const x0 = i * CHUNK, z0 = j * CHUNK;
      const dx = Math.max(x0 - x, 0, x - x0 - CHUNK), dz = Math.max(z0 - z, 0, z - z0 - CHUNK);
      return Math.hypot(dx, dz);
    };
    const refresh = () => {
      const x = cam.position.x, z = cam.position.z;
      // 卸载
      for (const [k, ch] of chunks) {
        ch.dist = rectDist(ch.i, ch.j, x, z);
        // 超出远档卸载；进入文字半径的无字块、远离文字半径的有字块重新生成（释放/占用图集格）
        if (ch.dist > R.far + 260 || (!ch.text && ch.dist <= R.text) || (ch.text && ch.dist > R.text + 400)) {
          for (const kk of ch.keys) atlas.release(kk);
          chunks.delete(k);
          dirty = true;
          continue;
        }
        for (const r of ['far', 'mid', 'near']) {
          const on = ch.dist <= R[r];
          if (on !== ch.act[r]) { ch.act[r] = on; dirty = true; }
        }
      }
      // 待生成（近的先）
      const i0 = Math.floor((x - R.far) / CHUNK), i1 = Math.floor((x + R.far) / CHUNK);
      const j0 = Math.floor((z - R.far) / CHUNK), j1 = Math.floor((z + R.far) / CHUNK);
      const want = [];
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        if (chunks.has(key(i, j))) continue;
        const d = rectDist(i, j, x, z);
        if (d <= R.far) want.push([d, i, j]);
      }
      want.sort((a, b) => a[0] - b[0]);
      queue = want;
    };
    const generate = (budgetMs) => {
      const t = performance.now();
      let n = 0;
      while (queue.length && (n === 0 || performance.now() - t < budgetMs)) {
        const [d0, i, j] = queue.shift();
        if (chunks.has(key(i, j))) continue;
        const t1 = performance.now();
        const out = planner.plan(i, j, atlas, d0 <= R.text);
        stats.genMs += performance.now() - t1;
        stats.gen++;
        const x = cam.position.x, z = cam.position.z;
        out.dist = rectDist(i, j, x, z);
        out.act = { far: out.dist <= R.far, mid: out.dist <= R.mid, near: out.dist <= R.near };
        chunks.set(key(i, j), out);
        dirty = true;
        n++;
      }
    };
    const rebuild = () => {
      dirty = false;
      let total = 0;
      for (const P of pools) {
        let n = 0;
        const list = [];
        for (const ch of chunks.values()) {
          if (!ch.act[P.range]) continue;
          const d = ch.data[P.name];
          if (d && d.n) { list.push(d); n += d.n; }
        }
        if (!n) { if (P.mesh) { P.mesh.count = 0; P.mesh.visible = false; } continue; }
        grow(P, n);
        const m = P.mesh;
        let o = 0;
        for (const d of list) {
          m.instanceMatrix.array.set(d.m, o * 16);
          if (P.color) m.instanceColor.array.set(d.c, o * 3);
          for (const k in P.attrs) P.geo.attributes[k].array.set(d.a[k], o * P.attrs[k]);
          o += d.n;
        }
        m.count = n;
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, n * 16);
        m.instanceMatrix.needsUpdate = true;
        if (P.color) { m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, n * 3); m.instanceColor.needsUpdate = true; }
        for (const k in P.attrs) {
          const a = P.geo.attributes[k];
          a.clearUpdateRanges();
          a.addUpdateRange(0, n * P.attrs[k]);
          a.needsUpdate = true;
        }
        m.visible = true;
        total += n;
      }
      stats.inst = total;
      stats.chunks = chunks.size;
      atlas.flush();
    };
    const applyVis = (agl) => {
      root.visible = visible && layerOn;
      for (const P of pools) if (P.mesh && P.range === 'near') P.mesh.visible = P.mesh.count > 0 && agl < NEAR_AGL;
    };

    console.warn(`[streetfurniture] ${JSON.stringify(planner.stats)} 构建 ${(performance.now() - t0).toFixed(0)} ms`);

    return {
      update() {
        frame++;
        const agl = cam.position.y - ctx.terrain.heightAt(cam.position.x, cam.position.z);
        visible = agl < HIDE_AGL;
        if (!visible || !layerOn) { root.visible = false; return; }
        const moved = cam.position.distanceToSquared(lastPos);
        if (moved > 400 || frame % 30 === 0) {
          if (moved > 400) lastPos.copy(cam.position);
          refresh();
        }
        if (queue.length) generate(frame < 5 ? 40 : 6);
        if (dirty && (!queue.length || frame % 4 === 0)) rebuild();
        applyVis(agl);
      },
      setQuality(q) {
        level = Math.max(0, Math.min(3, q.level ?? level));
        R = radii(level);
        for (const P of pools) if (P.mesh) P.mesh.castShadow = P.shadow && !!q.shadows;
        lastPos.set(1e9, 0, 1e9);
      },
      setLayer(name, on) {
        if (name === 'streetfurniture') layerOn = on;
      },
      stats() {
        const per = {};
        let tris = 0;
        for (const P of pools) if (P.mesh && P.mesh.count) {
          per[P.name] = P.mesh.visible ? P.mesh.count : -P.mesh.count;
          if (P.mesh.visible) tris += P.mesh.count * (P.geo.attributes.position.count / 3);
        }
        return { ...stats, queue: queue.length, atlasMiss: atlas.misses, atlasUsed: atlas.map.size, genAvg: stats.gen ? +(stats.genMs / stats.gen).toFixed(1) : 0, tris: Math.round(tris), per, why: planner.why };
      },
      dispose() {
        for (const P of pools) { if (P.mesh) P.mesh.dispose(); P.geo.dispose(); }
        atlas.texture.dispose();
        ctx.scene.remove(root);
      },
    };
  },
};
