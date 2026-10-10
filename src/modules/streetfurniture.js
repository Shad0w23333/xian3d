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
  ['cdown', 'lens', 'far', false, false, { aSig: 4 }], // 信号倒计时面板（与灯面同一相位着色器）
  ['post', 'metal', 'far', true, true],
  ['plate', 'plate', 'far', true, false, { aUV: 4, aUV2: 4 }],
  ['ad', 'ad', 'far', false, false, { aUV: 4, aUV2: 4 }],
  ['pane', 'glass', 'far', false, false],
  ['shelter2', 'metal', 'far', true, false],
  ['shelter3', 'metal', 'far', true, false],
  ['shelter2c', 'metal', 'far', true, false], // 贴路缘的候车亭（设施带里，站台垫层不伸出）
  ['shelter3c', 'metal', 'far', true, false],
  ['kiosk', 'paint', 'far', true, false],
  ['fence', 'paint', 'mid', true, false],
  ['bin', 'paint', 'near', true, false],
  ['bike', 'paint', 'near', true, true],
  ['ebike', 'paint', 'near', true, true],
  // 距离分级：细模（bin/bike/ebike）只画相机 LOD_D 内的实例，其余进对应的简模池（实例数据同源，见 rebuildLod）
  ['binLo', 'paint', 'near', true, false],
  ['bikeLo', 'paint', 'near', true, true],
  ['ebikeLo', 'paint', 'near', true, true],
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
// 细模/简模分界（米，画质 低/中/高/超高）；细模池名 → 简模池名
const LOD_D = [25, 35, 45, 60];
const LOD_PAIRS = { bin: 'binLo', bike: 'bikeLo', ebike: 'ebikeLo' };
const NEAR_AGL = 70; // 小件只在相机离地低于此值时显示

export default {
  id: 'streetfurniture',
  name: '全城街道设施',

  // 布置器（路网分析、公交站吸附）提前到 prepare：路缘候车亭的范围要登记成“让树”排除区，
  // 而 vegetation 在自己的 prepare 里就开始后台种树
  prepare(ctx) {
    try {
      this._planner = new Planner(ctx);
      this._nShelterEx = this._planner.registerExclusions(ctx.exclusions);
    } catch (e) {
      console.error('[streetfurniture] prepare 失败', e);
      this._planner = null;
    }
  },

  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = '全城街道设施';
    ctx.scene.add(root);
    const atlas = new TextAtlas();
    const M = makeMaterials(ctx, atlas);
    const G = makeGeometries();
    const planner = this._planner || new Planner(ctx);
    this._planner = null;
    planner.posters = M.posterCell;

    // —— 实例池 ——
    const pools = POOLS.map(([name, mat, range, shadow, color, attrs]) => ({ name, mat: M[mat], geo: G[name], range, shadow, color, attrs: attrs || {}, cap: 0, mesh: null }));
    for (const P of pools) if (LOD_PAIRS[P.name]) { const Lo = pools.find((q) => q.name === LOD_PAIRS[P.name]); P.lodTo = Lo; Lo.lodOf = P; }
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
        if (P.lodOf || P.lodTo) continue; // 分级池由 rebuildLod 拼
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
      rebuildLod();
    };
    // —— 距离分级：细模池只放相机 LOD_D 内的实例，其余放简模池（相机每移动 6 m 或分块变化时重分）——
    const lodPos = new THREE.Vector3(1e9, 0, 1e9);
    const writePool = (P, m16, c3, n) => {
      if (!n) { if (P.mesh) { P.mesh.count = 0; P.mesh.visible = false; } return; }
      grow(P, n);
      const m = P.mesh;
      m.instanceMatrix.array.set(m16.subarray(0, n * 16));
      if (P.color) m.instanceColor.array.set(c3.subarray(0, n * 3));
      m.count = n;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, n * 16);
      m.instanceMatrix.needsUpdate = true;
      if (P.color) { m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, n * 3); m.instanceColor.needsUpdate = true; }
      m.visible = true;
    };
    const rebuildLod = () => {
      lodPos.copy(cam.position);
      const d2 = LOD_D[level] ** 2, cx = cam.position.x, cz = cam.position.z;
      for (const F of pools) {
        if (!F.lodTo) continue;
        const Lo = F.lodTo;
        let n = 0;
        for (const ch of chunks.values()) { if (ch.act[F.range]) { const d = ch.data[F.name]; if (d) n += d.n; } }
        const mF = new Float32Array(n * 16), mL = new Float32Array(n * 16), cF = new Float32Array(n * 3), cL = new Float32Array(n * 3);
        let nF = 0, nL = 0;
        for (const ch of chunks.values()) {
          if (!ch.act[F.range]) continue;
          const d = ch.data[F.name];
          if (!d || !d.n) continue;
          for (let i = 0; i < d.n; i++) {
            const dx = d.m[i * 16 + 12] - cx, dz = d.m[i * 16 + 14] - cz;
            if (dx * dx + dz * dz < d2) { mF.set(d.m.subarray(i * 16, i * 16 + 16), nF * 16); cF.set(d.c.subarray(i * 3, i * 3 + 3), nF * 3); nF++; }
            else { mL.set(d.m.subarray(i * 16, i * 16 + 16), nL * 16); cL.set(d.c.subarray(i * 3, i * 3 + 3), nL * 3); nL++; }
          }
        }
        writePool(F, mF, cF, nF);
        writePool(Lo, mL, cL, nL);
      }
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
        else if (cam.position.distanceToSquared(lodPos) > 36) rebuildLod();
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
      /** 调试：(x,z) 半径 r 内的公交站（是否贴路缘、候车亭放置结果 why：0 已放 / 原因码，undefined = 所在块未生成） */
      debugStops(x, z, r = 150) {
        const out = [];
        for (const l of planner.stops.values()) for (const st of l) {
          const d = Math.hypot(st.x - x, st.z - z);
          if (d < r) out.push({ name: st.name, fi: st.fi, side: st.side, s: +st.s.toFixed(1), curb: st.curb, why: st.why, tag: st.tag, x: Math.round(st.x), z: Math.round(st.z), d: Math.round(d), zones: planner.zones(st.fi) });
        }
        return out.sort((a, b) => a.d - b.d);
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
