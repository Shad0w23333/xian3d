// 公园、广场与水岸的近景细节（2026-10 精修轮新建）。
//
// 此前城市公园（兴庆宫、革命、莲湖、丰庆、劳动、环城公园、曲江池、唐城墙遗址、浐灞/渭河沿岸……）里只有草地着色、树和
// roads.json 里少量园路的铺装：人眼高度看是一整片平整绿毯；湖岸、河岸、护城河岸是水面直接贴地。本模块按相机距离流式生成：
//   · 水岸（src/arch/park-shore.js）：湖泊毛石驳岸 + 花岗岩/汉白玉压顶 + 湖滨步道 + 汉白玉栏杆 + 亲水台阶 + 木平台；
//     护城河压顶石栏杆 + 步道；河道六角砖斜坡护岸 + 不锈钢护栏 + 堤顶步道。水位由 water 模块按岸高重定（低于岸顶 0.5~2.2 m）。
//   · 园路（parks.json：OSM 公园内园路 3400 余条，roads 模块不画的）：花岗岩/透水砖铺装 + 花岗岩路缘石；园桥（桥面 + 汉白玉栏杆）。
//   · 小品（实例化）：庭院灯（夜间暖光 + 地面光斑 + 最近 10 盏真实点光源）、座椅（沿园路每 25~40 m，背向草地）、分类垃圾桶、
//     导览牌（入口，图面为本园轮廓/水面/园路示意）、健身步道标识、“水深危险”“爱护花草”牌、绿篱与花境（十月：菊花、月季、
//     一串红、红叶石楠）、孤植树下的树池环凳；相机 40 m 内的草丛（风摆）。
//   · 构筑物：中式六角亭/四角亭/游廊（湖边与园路交汇处，复用 src/arch/chinese*.js）、木廊架、青砖灰瓦小公厕、
//     有名大园的主入口牌楼（OSM 园路与公园边界交点中临主干路者）。夜间亭子檐口暖白轮廓灯，水岸栏杆不发光。
// 流式：450 m 分块，相机 1 km 内生成（离地 260 m 以上不生成：看不清，只是负担）、1.35 km 外卸载；块生成是生成器，每帧限时，
// 相机附近 420 m 内的块同步补齐。实例按距离分档进池（小件 220~320 m、栏杆 340~420 m、灯 650 m），块静态网格 300 m 内才投影。
// draw call：每块 1（静态网格）+ 实例池约 12 + 亭廊大门按材质约 10 + 草丛 1，与块数基本无关。
// 曲江模块精建的芙蓉园/曲江池（ctx.exclusions 登记的园区）里只放座椅、垃圾桶、灯、草丛、花境，不重复驳岸、亭、门、公厕。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';
import { ParkIndex, CELL, M_ROAD, greenAt as greenOf } from '../arch/park-index.js';
import { ParkTextures, staticMaterial } from '../arch/park-tex.js';
import {
  InstancePool, lampPoleGeometry, lampGlassGeometry, benchGeometry, binGeometry, balusterPostGeometry, balusterPanelGeometry,
  metalRailGeometry, ringBenchGeometry, flowerClumpGeometry, hedgeGeometry, glowDecal,
} from '../arch/park-props.js';
import { GrassField, windMaterial } from '../arch/park-grass.js';
import { buildTemplates, StructureSet } from '../arch/park-struct.js';
import { planParks, buildChunk, TreeIndex } from '../arch/park-layout.js';

const NEAR = 1000, FAR = 1350, MAX_AGL = 260;
const N_LIGHTS = 10;

export default {
  id: 'parks',
  name: '公园与水岸近景',

  async prepare(ctx) {
    ctx.parksShore = true; // water 模块不再画护城河贴图栏杆（本模块流式生成三维石栏杆）
    this.data = await loadJSON('parks.json', { optional: true });
  },

  async build(ctx) {
    const t0 = performance.now();
    const T = ctx.terrain;
    const cam = ctx.camera;
    const root = new THREE.Group();
    root.name = '公园与水岸近景';
    ctx.scene.add(root);

    const idx = new ParkIndex(ctx, this.data);
    // 植被种植结果（只读）：避开树干、找孤植树做树池环凳
    let trees = null;
    try {
      if (ctx.modules.vegetation) {
        const veg = (await import('./vegetation.js')).default;
        const r = veg && veg._plant ? await Promise.race([veg._plant, new Promise((res) => setTimeout(() => res(null), 4000))]) : null;
        if (r && r.x && r.chunkStart) trees = new TreeIndex(r);
      }
    } catch (e) {
      trees = null;
    }
    const tex = new ParkTextures(ctx);
    const smat = ctx.overlay(staticMaterial(ctx, tex.tex), 0.00035);
    const tpl = buildTemplates(ctx);
    const sset = new StructureSet(root, tpl);
    const { plan, stats: pstats } = planParks({ idx, trees, T }, this.data);

    // —— 实例池 ——
    const pool = new InstancePool(root);
    const propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.15 });
    const stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
    const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.55 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xf6efe0, emissive: 0xffc98a, emissiveIntensity: 0, roughness: 0.25, transparent: true, opacity: 0.92 });
    ctx.night.register(glassMat, { day: 0, night: 3.6 });
    const hedgeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    const flowerMat = windMaterial(ctx, { amp: 0.02, side: THREE.FrontSide, rough: 0.8, tintByUvX: true });
    const glow = glowDecal();
    const glowMat = ctx.overlay(new THREE.MeshBasicMaterial({ map: glow.tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffcf96, fog: true }), 0.0012);
    pool.define('lamp', lampPoleGeometry(), propMat, { name: '庭院灯' });
    pool.define('glass', lampGlassGeometry(), glassMat, { name: '庭院灯罩' });
    pool.define('glow', glow.geo, glowMat, { name: '庭院灯光斑', order: 2, noReflect: true });
    pool.define('bench', benchGeometry(), propMat, { shadow: true, name: '公园座椅', noReflect: true });
    pool.define('bin', binGeometry(), propMat, { shadow: true, name: '分类垃圾桶', noReflect: true });
    pool.define('bpost', balusterPostGeometry(), stoneMat, { color: true, name: '石栏杆望柱', cap: 1024 });
    pool.define('bpanel', balusterPanelGeometry(), stoneMat, { color: true, name: '石栏杆栏板', cap: 1024 });
    pool.define('rail', metalRailGeometry(), metalMat, { shadow: true, color: true, name: '金属护栏', cap: 1024 });
    pool.define('ring', ringBenchGeometry(), propMat, { shadow: true, name: '树池环凳', noReflect: true });
    pool.define('flower', flowerClumpGeometry(), flowerMat, { color: true, name: '花境', cap: 2048, noReflect: true });
    pool.define('hedge', hedgeGeometry(), hedgeMat, { color: true, name: '绿篱', cap: 512, noReflect: true });
    const KINDS = [...pool.kinds.keys()];

    const grass = new GrassField(ctx, root);
    grass.enabled = (ctx.quality?.level ?? 2) >= 1;

    // —— 真实点光源（固定句柄，指派给最近的庭院灯）——
    const handles = [];
    for (let i = 0; i < N_LIGHTS; i++) {
      const h = ctx.lights.add({ position: new THREE.Vector3(0, -9999, 0), color: 0xffcf96, intensity: 45, distance: 14, nightOnly: true, priority: 0.45 });
      h.enabled = false;
      handles.push(h);
    }

    // —— 分块 ——
    const chunks = new Map(); // key → {gx,gz, mesh, inst, lamps, structs, mk, green}
    let pending = [];
    let job = null; // {key, gen}
    let dirty = false;
    const env = { ctx, T, idx, tex, trees, plan };
    const keyOf = (gx, gz) => gx + ',' + gz;
    const finish = (key, res) => {
      const [gx, gz] = key.split(',').map(Number);
      let mesh = null;
      if (res.geo) {
        mesh = new THREE.Mesh(res.geo, smat);
        mesh.name = '公园块·' + key;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        root.add(mesh);
      }
      const gg = res.green;
      // 跨块的湖滨步道：互相在对方掩膜里登记成铺装（草丛、小品不压步道）
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          const nb = chunks.get(keyOf(gx + dx, gz + dz));
          if (!nb || !nb.mk || (!dx && !dz)) continue;
          for (const q of res.paved || []) nb.mk.stamp(q.p, q.hw, M_ROAD);
          for (const q of nb.paved || []) res.mk.stamp(q.p, q.hw, M_ROAD);
        }
      chunks.set(key, { gx, gz, mesh, inst: res.inst, lamps: res.lamps, structs: res.structs, mk: res.mk, green: gg, st: res.st, paved: res.paved });
      dirty = true;
    };
    const runJob = (budgetMs) => {
      const tEnd = performance.now() + budgetMs;
      while (true) {
        if (!job) {
          const key = pending.shift();
          if (!key) return;
          if (chunks.has(key)) continue;
          const [gx, gz] = key.split(',').map(Number);
          job = { key, gen: buildChunk(env, gx, gz) };
        }
        let r;
        try {
          r = job.gen.next();
        } catch (e) {
          console.warn('[parks] 块生成失败', job.key, e);
          chunks.set(job.key, { failed: true, inst: new Map(), lamps: [], structs: [] });
          job = null;
          continue;
        }
        if (r.done) { finish(job.key, r.value); job = null; }
        if (performance.now() > tEnd) return;
      }
    };
    const dropChunk = (key) => {
      const c = chunks.get(key);
      if (!c) return;
      if (c.mesh) { root.remove(c.mesh); c.mesh.geometry.dispose(); }
      chunks.delete(key);
      dirty = true;
    };
    const lastRefresh = new THREE.Vector3(1e9, 0, 0);
    let active = true;
    const refresh = (force) => {
      const x = cam.position.x, z = cam.position.z;
      if (!force && Math.hypot(x - lastRefresh.x, z - lastRefresh.z) < 40) return;
      lastRefresh.copy(cam.position);
      const agl = cam.position.y - T.heightAt(x, z);
      active = agl < MAX_AGL;
      const want = [];
      if (active) {
        for (let gx = Math.floor((x - NEAR) / CELL); gx <= Math.floor((x + NEAR) / CELL); gx++)
          for (let gz = Math.floor((z - NEAR) / CELL); gz <= Math.floor((z + NEAR) / CELL); gz++) {
            const cx = (gx + 0.5) * CELL, cz = (gz + 0.5) * CELL;
            const d = Math.hypot(cx - x, cz - z);
            if (d < NEAR + CELL * 0.71) want.push([keyOf(gx, gz), d]);
          }
      }
      for (const [k, c] of chunks) {
        const cx = (c.gx + 0.5) * CELL, cz = (c.gz + 0.5) * CELL;
        if (!active || Math.hypot(cx - x, cz - z) > FAR + CELL * 0.71) dropChunk(k);
      }
      want.sort((a, b) => a[1] - b[1]);
      pending = want.map((w) => w[0]).filter((k) => !chunks.has(k) && (!job || job.key !== k));
    };
    // 实例按块与相机的距离分档收集：小件 350 m、栏杆 550 m、灯 800 m 以外的块不进实例池（看不清，只是三角形与阴影负担）
    const KIND_R = { bench: 260, bin: 220, ring: 260, flower: 240, hedge: 320, bpost: 340, bpanel: 340, rail: 420, lamp: 650, glass: 650, glow: 700 };
    const lastCollect = new THREE.Vector3(1e9, 0, 0);
    const collect = () => {
      dirty = false;
      lastCollect.copy(cam.position);
      const x = cam.position.x, z = cam.position.z;
      const dist = new Map();
      for (const [k, c] of chunks) {
        if (!c.inst) continue;
        const x0 = c.gx * CELL, z0 = c.gz * CELL;
        dist.set(k, Math.hypot(Math.max(x0 - x, 0, x - x0 - CELL), Math.max(z0 - z, 0, z - z0 - CELL)));
      }
      // 块静态网格只在 300 m 内投影（驳岸压顶、公厕、廊架的影子近处才看得出），远处省掉阴影 pass 的 draw call
      for (const [k, c] of chunks) if (c.mesh) c.mesh.castShadow = dist.get(k) < 300;
      for (const kind of KINDS) {
        const R = KIND_R[kind] ?? 600;
        const parts = [];
        for (const [k, c] of chunks) { const p = c.inst && c.inst.get(kind); if (p && dist.get(k) < R) parts.push(p); }
        pool.fill(kind, parts);
      }
      const list = [];
      for (const c of chunks.values()) if (c.structs) list.push(...c.structs);
      sset.rebuild(list);
      grass.dirty = true;
      assignLights(true);
    };
    let lightFrame = 0;
    const assignLights = (force) => {
      if (!force && (++lightFrame % 30) !== 0) return;
      const x = cam.position.x, z = cam.position.z;
      const near = [];
      for (const c of chunks.values()) for (const l of c.lamps || []) { const d = (l[0] - x) ** 2 + (l[2] - z) ** 2; if (d < 250 * 250) near.push([d, l]); }
      near.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < N_LIGHTS; i++) {
        const h = handles[i], l = near[i];
        if (!l) { h.enabled = false; continue; }
        h.enabled = true;
        h.position.set(l[1][0], l[1][1] - 0.2, l[1][2]);
      }
    };
    const chunkAt = (x, z) => chunks.get(keyOf(Math.floor(x / CELL), Math.floor(z / CELL)));
    const maskAt = (x, z) => { const c = chunkAt(x, z); return c && c.mk ? c.mk.get(x, z) : -1; };
    const greenAt = (x, z) => {
      const c = chunkAt(x, z);
      return c && c.green ? Math.max(0, greenOf(c.green, x, z)) : 0;
    };
    const heightAt = (x, z) => T.heightAt(x, z);

    // 首帧：相机附近的块同步建好（截图 / 预设视角直接可见）
    const syncNear = () => {
      const x = cam.position.x, z = cam.position.z;
      refresh(true);
      let n = 0;
      for (const k of pending.slice()) {
        const [gx, gz] = k.split(',').map(Number);
        const cx = (gx + 0.5) * CELL, cz = (gz + 0.5) * CELL;
        if (Math.hypot(cx - x, cz - z) > 420 || n >= 4) continue;
        if (job && job.key === k) job = null;
        const gen = buildChunk(env, gx, gz);
        let r;
        try { do r = gen.next(); while (!r.done); finish(k, r.value); } catch (e) { console.warn('[parks] 块生成失败', k, e); chunks.set(k, { failed: true, inst: new Map(), lamps: [], structs: [] }); }
        n++;
      }
      pending = pending.filter((k) => !chunks.has(k));
      if (n) collect();
    };
    syncNear();

    const ms = performance.now() - t0;
    console.warn(`[parks] 公园 ${idx.stats.parks}、园路 ${idx.stats.lines}（自画 ${idx.stats.own}）、水体 ${idx.stats.water}、树 ${trees ? trees.r.n : '无'}；规划：大门 ${pstats.gates} 公厕 ${pstats.toilets}（OSM ${pstats.osmToilets}）亭 ${pstats.pavs} 廊 ${pstats.langs} 廊架 ${pstats.pergolas} 导览牌 ${pstats.boards} 路口 ${pstats.juncs}（${pstats.ms} ms）；模板 ${tpl.ms} ms；首批 ${chunks.size} 块；${ms.toFixed(0)} ms`);

    let frame = 0;
    const prevCam = cam.position.clone();
    let visible = true;
    return {
      update() {
        frame++;
        if (!visible) return;
        // 瞬移（预设视角 / 巡检机位）：附近块同步补齐
        if (cam.position.distanceTo(prevCam) > 250) syncNear();
        prevCam.copy(cam.position);
        if ((frame & 7) === 0) refresh(false);
        if (pending.length || job) runJob(job || pending.length ? 5 : 0);
        if (!dirty && Math.hypot(cam.position.x - lastCollect.x, cam.position.z - lastCollect.z) > 90) dirty = true;
        if (dirty && (!job || frame % 20 === 0)) collect();
        assignLights(false);
        const night = ctx.uniforms.uNight.value;
        glowMat.opacity = Math.min(1, night * 1.15) * 0.38;
        grass.update(cam, maskAt, greenAt, heightAt);
      },
      busy: () => pending.length > 0 || !!job,
      /** 诊断：某块的生成情况 */
      chunkInfo: (gx, gz) => {
        const c = chunks.get(keyOf(gx, gz));
        if (!c) return { loaded: false, pending: pending.includes(keyOf(gx, gz)), active };
        return { loaded: true, failed: !!c.failed, mesh: !!c.mesh, verts: c.mesh ? c.mesh.geometry.attributes.position.count : 0, st: c.st };
      },
      stats: () => {
        let lamps = 0, benches = 0, flowers = 0, ms = 0, msMax = 0;
        for (const c of chunks.values()) if (c.st) { lamps += c.st.lamps; benches += c.st.benches; flowers += c.st.flowers; ms += c.st.ms; msMax = Math.max(msMax, c.st.ms); }
        const tms = [...chunks.values()].filter((c) => c.st && c.st.ms > 30).map((c) => c.gx + ',' + c.gz + ':' + c.st.ms + '=' + c.st.tm);
        return { chunks: chunks.size, pending: pending.length, lamps, benches, flowers, grass: grass.im.count, structs: sset.meshes.length, buildMs: Math.round(ms), maxChunkMs: msMax, slow: tms };
      },
      setLayer(layer, on) {
        if (layer === 'trees' || layer === 'vegetation' || layer === 'parks') { visible = on; root.visible = on; }
      },
      setQuality(q) {
        grass.enabled = (q.level ?? 2) >= 1;
        grass.dirty = true;
      },
      dispose() {
        for (const k of [...chunks.keys()]) dropChunk(k);
        ctx.scene.remove(root);
        tex.tex.dispose();
      },
    };
  },
};
