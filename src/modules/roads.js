// 道路与轨道交通：路面（沥青 PBR + 着色器车道线/斑马线/箭头/导流线）、人行道与路缘石、
// 中央分隔带（实体：路缘 + 箱形绿篱，窄处隔离墩 + 金属护栏；逐断面按局部中分带宽）、主路路口铺面、
// 桥梁高架（桥面板/护栏/箱梁/桥墩/匝道）、路灯（五种灯型实例化 + 远景光点 + 着色器贴地光斑）、
// 铁路（道砟/轨枕/钢轨、高铁与地铁高架箱梁 + 桥墩）。
// 路面高度统一使用 core/roadheight.js 的 roadY / bridgeLift（与车流模块一致）：build 开头先在整张路网上求纵断面
// （prepareRoadProfiles：桥链按里程平滑 + 最大坡度约束 + 两端顺接地面、立交按层保证净空、地面路取不入土的包络），
// 路面/人行道/桥面断面与纵断面节点对齐（profileStepFn）；被抬高的地面路段（引桥路堤）两侧加挡土墙。
// 分块：主要道路按 5 km 网格合并（视锥裁剪），支路按 2.5 km 网格合并并只在相机附近显示，核心区外只画高等级道路（粗采样）。
// 绘制负担（2026-10 优化）：桥梁/高架结构按 2.5 km 分块（视锥裁剪 + 只有相机附近的块投射阴影，此前是一整块 1.9M 三角形
//   全城常驻且每帧进阴影通道）；路面断面去掉冗余中点（着色器里横向 UV 线性插值，宽路三角形减半）；路灯分近/远两级实例
//   （远处只画杆 + 灯头盒）；桥墩分近（投影）/远（低模、不投影）两组。
import * as THREE from 'three';
import { LIFT, roadY, bridgeLift, prepareRoadProfiles, profileStepFn } from '../core/roadheight.js';
import { buildRoadNet, placeLamps, buildRailNet, lampStyleFor, pairGapAt, markParkWalkways, pavingCuts, carriageIndex, urbanDensity, urbanLanduse, lampUrbanOk, PED_ZONES, URBAN_MIN, FAR_URBAN, FAR_DISTRICTS, F, KIND, LAMP } from '../arch/roads_net.js';
import { SurfWriter, StructWriter, sampleSections } from '../arch/roads_mesh.js';
import { createSurfaceMaterial, createStructMaterial, patchShadowBias } from '../arch/roads_shader.js';
import { lampGeometries, lampGeometriesLow, lampMaterial, lampPointsMaterial, lampHeadRed } from '../arch/roads_lamps.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shadowReach } from '../arch/perf-lod.js';

const LAMPL = 2048, LAMPR = 4096, LAMPM = 8192;
const KIND_SLAB = 6, KIND_MEDIAN = 3, KIND_HEDGE = 8, KIND_FENCE = 9, KIND_XWALK = 10, KIND_GRASS = 11;
const T_MAJOR = 5000, T_MINOR = 5000, T_FAR = 10000; // 核心区外路面 10 km 分块（原 30 km：从任何视角都整块在视锥内）
const T_STRUCT = 2500; // 桥梁/高架结构分块
const T_SUB = 2500; // 人行道/路缘石/分隔带/钢轨（细小附属，只在相机附近显示）分块
const SUB_R = [1100, 1700, 2600, 3600]; // 附属分块显示半径（按画质）
const G0 = -30000; // 网格原点（足够西北）
const URBAN_R = 11500; // 高速/快速路布灯半径（三环附近）
const FAR_SECONDARY_R = 17000; // 核心区外次干道显示半径
// 按画质档位（低/中/高/超高）的距离参数
const LAMP_R = [450, 750, 1200, 1600]; // 路灯实例显示半径
const LAMP_NEAR_R = [200, 280, 380, 480]; // 此半径内用完整灯型几何，更远用低模（杆 + 灯头盒）
const MINOR_R = [1500, 2000, 2500, 3500]; // 支路分块显示半径
const PIER_R = [2000, 3000, 4500, 7000]; // 桥墩显示半径
const PIER_SHADOW_R = [500, 800, 1200, 1600]; // 此半径内的桥墩投射阴影（完整几何），更远用低模不投影
const MAST_R = [900, 1400, 2200, 2500]; // 接触网支柱显示半径
const STRUCT_SHADOW_R = [900, 1500, 2600, 4000]; // 桥梁结构块到相机的距离小于此值才投射阴影
const STRUCT_R = [6000, 12000, 40000, 40000]; // 桥梁结构块显示半径（三维距离；远处高架由影像/雾表现）
const FAR_TILE_R = [9000, 20000, 1e9, 1e9]; // 核心区外路面分块显示半径（三维距离；低/中画质远郊公路由影像表现）
const MAJOR_TILE_R = [5000, 14000, 1e9, 1e9]; // 核心区主要道路分块显示半径（三维距离；低画质远处/高空俯视时路网由影像表现）

// prepare 求出的路网（路网数据未被后续模块替换时 build 直接复用，省一次 buildRoadNet）
const netCache = new WeakMap();

export default {
  id: 'roads',
  name: '道路与轨道交通',

  // 双幅路中央分隔带在人行横道处开口（行人过街通道）：登记成“让树”排除区，植被模块（prepare 里就开始后台种植）
  // 不在开口里种分隔带的树、灌木球与绿篱。只登记，不缓存路网（后续模块的 prepare 还可能改路网数据）。
  prepare(ctx) {
    try {
      const t0 = performance.now();
      const pa = ctx.geo.project(108.84, 34.35), pb = ctx.geo.project(109.06, 34.17);
      const inCore = (x, z) => x > pa.x && x < pb.x && z > pa.z && z < pb.z;
      markParkWalkways(ctx.data.roads, ctx.data.landuse);
      const net = buildRoadNet(ctx.data.roads, { inDetail: inCore });
      netCache.set(ctx.data.roads, { feats: ctx.data.roads.features, len: ctx.data.roads.features.length, net });
      let n = 0;
      for (const E of net.edges) {
        if (!(E.flags & F.PAIRED) || E.b) continue;
        const f = net.feats[E.fi], p = f.p, ch = net.chain[E.fi];
        const ends = [];
        // 与 build 里 buildMedian 的开口条件一致：分隔带一侧有横街接入（lx）才开口
        if (E.flags & F.CW0 && E.R0 > 0 && E.lx0 > 0) ends.push([E.s0 + E.R0 + 0.6, E.s0 + E.R0 + 6.6]);
        if (E.flags & F.CW1 && E.R1 > 0 && E.lx1 > 0) ends.push([E.s1 - E.R1 - 6.6, E.s1 - E.R1 - 0.6]);
        for (const [a, b] of ends) {
          const at = (s) => {
            let i = 0;
            while (i < ch.length - 2 && ch[i + 1] < s) i++;
            const L = ch[i + 1] - ch[i] || 1, t = Math.max(0, Math.min(1, (s - ch[i]) / L));
            const dx = (p[i * 2 + 2] - p[i * 2]) / L, dz = (p[i * 2 + 3] - p[i * 2 + 1]) / L;
            return [p[i * 2] + dx * L * t, p[i * 2 + 1] + dz * L * t, -dz, dx];
          };
          const [mx, mz, rx, rz] = at((a + b) / 2);
          if (!inCore(mx, mz)) continue;
          const g = pairGapAt(net, E, mx, mz, rx, rz);
          if (g === null || g < 0.8 || g > 70) continue;
          // 宽带只在两幅基本平行、不超过 30 m 时开口（buildMedian 的 medianGapKind 同一规则）
          if (g > 8) {
            const pa = at(a + 0.4), pb = at(b - 0.6);
            const ga = pairGapAt(net, E, pa[0], pa[1], pa[2], pa[3]), gb = pairGapAt(net, E, pb[0], pb[1], pb[2], pb[3]);
            if (ga === null || gb === null || Math.max(ga, gb) > 30 || Math.abs(ga - gb) > 1.5) continue;
          }
          const o0 = E.W / 2 - 0.2, o1 = E.W / 2 + g / 2 + 0.3;
          const P = [];
          for (const [s, o] of [[a, o0], [b, o0], [b, o1], [a, o1]]) {
            const [x, z, qx, qz] = at(s);
            P.push(x - qx * o, z - qz * o);
          }
          ctx.exclusions.add({ points: P, name: 'roads:分隔带过街开口' }, { buildings: false, trees: true, roads: false, pois: false });
          n++;
        }
      }
      // 景区步行化裁切段（西大街北侧单车道在钟鼓楼广场南缘这一段）：不画、不通车
      let nCut = 0;
      for (const Z of PED_ZONES) for (const c of Z.cut || []) {
        ctx.exclusions.add({ points: c, name: 'roads:步行化 ' + Z.name }, { buildings: false, trees: false, roads: true, pois: false });
        nCut++;
      }
      console.warn(`[roads] prepare：分隔带过街开口 ${n} 处（让树），步行化裁切 ${nCut} 段，${(performance.now() - t0).toFixed(0)} ms`);
    } catch (e) {
      console.warn('[roads] prepare 失败（分隔带开口不让树）', e);
    }
  },

  async build(ctx) {
    const t0 = performance.now();
    const terrain = ctx.terrain;
    // 纵断面：所有模块 prepare（含各处平整区）完成后才求，traffic / 路名 / skyline 桥塔随后直接复用
    try {
      const st = prepareRoadProfiles(ctx.data.roads, terrain);
      console.warn('[roads] 纵断面 ' + JSON.stringify(st));
    } catch (e) {
      console.warn('[roads] 纵断面求解失败，退回逐段规则', e);
    }
    const root = new THREE.Group();
    root.name = '道路与轨道交通';
    ctx.scene.add(root);

    // —— 区域 ——
    const pa = ctx.geo.project(108.84, 34.35), pb = ctx.geo.project(109.06, 34.17);
    const CORE = { x0: pa.x, z0: pa.z, x1: pb.x, z1: pb.z };
    const inCore = (x, z) => x > CORE.x0 && x < CORE.x1 && z > CORE.z0 && z < CORE.z1;
    // 布灯范围：核心区及其外渲染的高等级道路；高速公路只在城区半径内
    const lampRegion = (x, z, urban) => (urban ? x * x + z * z < URBAN_R * URBAN_R : true);
    const excl = ctx.exclusions;
    const excluded = (x, z) => excl && excl.items && excl.items.length && excl.test(x, z, 'roads');
    // 地标/精建实体占地（不限高的“让建筑”排除区：西安站站房、钟鼓楼广场等）
    const inLandmark = (x, z) => excl && excl.items && excl.items.length && excl.test(x, z, 'buildings', 1e6);
    // 建成区：城市建设用地，或建筑覆盖率（buildings.bin 轮廓面积，750 m 见方）≥ 2%，或在远郊新城名单里。
    // 乡道/田间路不布灯；核心区外的新城补画次干道与三级路
    const TD = performance.now();
    const dens = urbanDensity(ctx.data.buildings);
    const luUrban = urbanLanduse(ctx.data.landuse);
    const farBoxes = FAR_DISTRICTS.map(([, lo0, la0, lo1, la1]) => { const a = ctx.geo.project(lo0, la1), b = ctx.geo.project(lo1, la0); return [a.x, a.z, b.x, b.z]; });
    const inFarDistrict = (x, z) => farBoxes.some((b) => x > b[0] && x < b[2] && z > b[1] && z < b[3]);
    const urban = dens ? (x, z) => dens(x, z) >= URBAN_MIN || luUrban(x, z) || inFarDistrict(x, z) : null;
    console.warn(`[roads] 建成区判定准备 ${(performance.now() - TD).toFixed(0)} ms`);

    // —— 网络 ——
    const T0 = performance.now();
    // 景区/公园里的无名支路（寺院甬道、园路）按步行道画：石板铺装、不布路灯（traffic 同一规则不跑车）
    const nPark = markParkWalkways(ctx.data.roads, ctx.data.landuse);
    const cached = netCache.get(ctx.data.roads);
    const net = cached && cached.feats === ctx.data.roads.features && cached.len === ctx.data.roads.features.length ? cached.net : buildRoadNet(ctx.data.roads, { inDetail: inCore });
    netCache.delete(ctx.data.roads);
    const T1 = performance.now();
    const { edges, feats, info, chain, total } = net;
    // 步道/步行街落在车行道里的部分不画（否则一条铺装横穿车行道）；横穿主次干道处记路段人行横道（E.mids）
    const TC = performance.now();
    const cIdx = carriageIndex(net, inCore, excluded);
    const pc = pavingCuts(net, inCore, cIdx);
    // 机非分隔带（辅路左缘到相邻主路路缘，见 roads_net 的 sideF）：主路靠辅路一侧的人行道在其范围内不画（由分隔带接管）
    const inSideStrip = (() => {
      const CELL = 40, grid = new Map(), list = [];
      for (const E of edges) {
        if (!(E.sideF >= 0) || E.b) continue;
        const p = feats[E.fi].p, hwA = E.W / 2, gmax = Math.min(14, E.sideGap * 1.5 + 1.5);
        for (let k = E.i0; k < E.i1; k++) {
          const ax = p[k * 2], az = p[k * 2 + 1], bx = p[k * 2 + 2], bz = p[k * 2 + 3];
          const r = hwA + gmax + 1, id = list.length;
          list.push([ax, az, bx, bz, hwA, gmax, E.sideF]);
          for (let cx = Math.floor((Math.min(ax, bx) - r) / CELL); cx <= Math.floor((Math.max(ax, bx) + r) / CELL); cx++)
            for (let cz = Math.floor((Math.min(az, bz) - r) / CELL); cz <= Math.floor((Math.max(az, bz) + r) / CELL); cz++) {
              const key = cx * 1000003 + cz;
              let a = grid.get(key);
              if (!a) grid.set(key, (a = []));
              a.push(id);
            }
        }
      }
      return (x, z, mainFi) => {
        const a = grid.get(Math.floor(x / CELL) * 1000003 + Math.floor(z / CELL));
        if (!a) return false;
        for (const id of a) {
          const [ax, az, bx, bz, hwA, gmax, sf] = list[id];
          if (sf !== mainFi) continue;
          const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
          const t = ((x - ax) * dx + (z - az) * dz) / l2;
          if (t < -0.05 || t > 1.05) continue;
          const dl = ((x - ax) * dz - (z - az) * dx) / Math.sqrt(l2); // 到辅路中心线的左侧距离
          if (dl > hwA - 0.2 && dl < hwA + gmax) return true;
        }
        return false;
      };
    })();
    console.warn(`[roads] 步道剔除车行道重叠 ${pc.cuts.size} 条、路段人行横道 ${pc.nMid} 处，${(performance.now() - TC).toFixed(0)} ms`);
    // 落在地标/站房实体里的步行桥（OSM 把站房内的通道标成 footway 桥，如西安站“地面天街” b=1 y=2）：
    // 原样画成一根架在高架候车室屋面上方、没有桥墩扶手的长板梁（审查 P1），一半以上落在地标占地内的整条不画
    const skipFeat = new Set();
    {
      const names = [];
      for (let fi = 0; fi < feats.length; fi++) {
        const f = feats[fi];
        if (!f.b || !(info[fi].cfg.paving || f._ped) || !f.p || f.p.length < 4) continue;
        const p = f.p;
        let hit = 0, tot = 0;
        for (let i = 0; i < p.length; i += 2) {
          tot++; if (inLandmark(p[i], p[i + 1])) hit++;
          if (i + 3 < p.length) { tot++; if (inLandmark((p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2)) hit++; }
        }
        if (hit / tot > 0.5) { skipFeat.add(fi); names.push(f.n || '无名'); }
      }
      if (skipFeat.size) console.warn(`[roads] 地标占地内的步行桥不画 ${skipFeat.size} 条：${names.slice(0, 12).join('、')}`);
    }
    // 双幅路互相配对的要素：对向一幅也会建它那一半中分带（绿篱内侧封口面可省）
    const pairedBy = new Map();
    for (const E of edges) {
      if (!(E.flags & F.PAIRED)) continue;
      let st = pairedBy.get(E.pairF);
      if (!st) pairedBy.set(E.pairF, (st = new Set()));
      st.add(E.fi);
    }

    // —— 写入器 ——
    const tiles = new Map(); // key -> {w, minor, cx, cz}
    const tileKey = (x, z, T, tag) => {
      const i = Math.floor((x - G0) / T), j = Math.floor((z - G0) / T);
      return tag + ':' + i + ':' + j;
    };
    const getTile = (key, T, x, z, minor) => {
      let t = tiles.get(key);
      if (!t) {
        const i = Math.floor((x - G0) / T), j = Math.floor((z - G0) / T);
        t = { w: new SurfWriter(minor ? 4096 : 16384), minor, cx: G0 + (i + 0.5) * T, cz: G0 + (j + 0.5) * T, T };
        tiles.set(key, t);
      }
      return t.w;
    };
    /** 附属分块（人行道/路缘石/分隔带/钢轨）：2.5 km 网格，只在相机附近显示 */
    const subTileAt = (x, z) => getTile(tileKey(x, z, T_SUB, 'w'), T_SUB, x, z, 'sub');
    const lvl = Math.max(0, Math.min(3, ctx.quality.level ?? 2));
    // 结构物分块写入（桥面/箱梁/挡土墙/铁路梁）：核心区 2.5 km，核心区外 12.5 km（控制 draw call 数：全城俯视时所有块都在视锥内）
    const sTiles = new Map(); // key -> {w: StructWriter, cx, cz}
    const swAt = (x, z) => {
      const T = inCore(x, z) ? T_STRUCT : T_STRUCT * 5;
      const i = Math.floor((x - G0) / T), j = Math.floor((z - G0) / T);
      const key = (T === T_STRUCT ? 'c' : 'o') + i + ':' + j;
      let t = sTiles.get(key);
      if (!t) {
        t = { w: new StructWriter(8192), cx: G0 + (i + 0.5) * T, cz: G0 + (j + 0.5) * T };
        sTiles.set(key, t);
      }
      return t.w;
    };
    const structTris = () => { let n = 0; for (const t of sTiles.values()) n += t.w.ni / 3; return n; };
    const kindTris = {}; // 路面各类别三角形统计（调试日志）
    const piers = []; // {x, y, z, h, yaw, sx, sz, cap:[w, h, d]}
    const pierHash = new Map();
    const PH = 10;
    const addPier = (x, z, yTop, yaw, sx, sz, capW, capH, capD, dedupe = 6) => {
      // 邻域去重（平行股道/双幅桥共用桥墩）
      const cx = Math.floor(x / PH), cz = Math.floor(z / PH);
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++) {
          const a = pierHash.get((cx + i) * 100003 + cz + j);
          if (a) for (let k = 0; k < a.length; k += 2) if ((a[k] - x) ** 2 + (a[k + 1] - z) ** 2 < dedupe * dedupe) return;
        }
      const key = cx * 100003 + cz;
      let a = pierHash.get(key);
      if (!a) pierHash.set(key, (a = []));
      a.push(x, z);
      const g = terrain.heightAt(x, z) - 0.3;
      const h = yTop - capH - g;
      if (h < 1.5) return;
      piers.push(x, g, z, h, yaw, sx, sz, capW, capH, capD);
    };

    // —— 通用条带发射：pts 为从“左”到“右”越过外表面的剖面点 {o, dy, u, abs?}；nrm=[no, ny] ——
    const JUNC = [0, 0, 0, 0];
    const DET0 = [0, 0, 0, 0];
    function band(W, secs, iA, iB, ys, pts, nrm, attr, E, det = DET0) {
      const np = pts.length;
      W.ensure((iB - iA + 1) * np, (iB - iA) * (np - 1) * 6);
      kindTris[attr[0]] = (kindTris[attr[0]] || 0) + (iB - iA) * (np - 1) * 2;
      let prev = -1;
      const no = nrm[0], ny = nrm[1];
      for (let i = iA; i <= iB; i++) {
        const cx = secs.x[i], cz = secs.z[i], rx = secs.rx[i], rz = secs.rz[i];
        const rl = Math.hypot(rx, rz) || 1;
        const nx = (-rx / rl) * no, nz = (-rz / rl) * no;
        if (E) {
          JUNC[0] = secs.s[i] - E.s0;
          JUNC[1] = E.s1 - secs.s[i];
          JUNC[2] = E.R0;
          JUNC[3] = E.R1;
        }
        const base = W.n;
        for (let k = 0; k < np; k++) {
          const p = pts[k];
          W.v(cx - rx * p.o, ys[i] + p.dy, cz - rz * p.o, nx, ny, nz, p.u, secs.s[i], attr, JUNC, det);
        }
        if (prev >= 0)
          for (let k = 0; k < np - 1; k++) {
            const a0 = prev + k, a1 = a0 + 1, b0 = base + k, b1 = b0 + 1;
            W.tri(a0, a1, b0);
            W.tri(a1, b1, b0);
          }
        prev = base;
      }
    }
    /** 按网格把断面切成连续段，逐段回调 cb(tileKey, tileX, tileZ, iA, iB) */
    function runs(secs, valid, T, tag, cb) {
      let start = -1, key = null, kx = 0, kz = 0;
      for (let i = 0; i < secs.n - 1; i++) {
        const ok = valid[i] && valid[i + 1];
        const mx = (secs.x[i] + secs.x[i + 1]) / 2, mz = (secs.z[i] + secs.z[i + 1]) / 2;
        const k = ok ? tileKey(mx, mz, T, tag) : null;
        if (k !== key) {
          if (key !== null && start >= 0) cb(key, kx, kz, start, i);
          key = k;
          start = i;
          kx = mx;
          kz = mz;
        }
      }
      if (key !== null && start >= 0) cb(key, kx, kz, start, secs.n - 1);
    }
    const sectionYs = (secs, f, tot) => {
      const ys = new Float32Array(secs.n), valid = new Uint8Array(secs.n);
      const pz = !!f._pedZone; // 景区步行化的通道：落在地标广场铺装里的部分不画（广场模块自己铺石材）
      for (let i = 0; i < secs.n; i++) {
        const y = roadY(terrain, f, secs.x[i], secs.z[i], secs.s[i], tot);
        ys[i] = y === null ? 0 : y;
        valid[i] = y !== null && !excluded(secs.x[i], secs.z[i]) && !(pz && inLandmark(secs.x[i], secs.z[i])) ? 1 : 0;
      }
      return { ys, valid };
    };
    const pointAt = (p, ch, s) => {
      let i = 0;
      const n = p.length / 2;
      while (i < n - 2 && ch[i + 1] < s) i++;
      const L = ch[i + 1] - ch[i] || 1;
      const t = Math.max(0, Math.min(1, (s - ch[i]) / L));
      const dx = p[i * 2 + 2] - p[i * 2], dz = p[i * 2 + 3] - p[i * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      return [p[i * 2] + dx * t, p[i * 2 + 1] + dz * t, dx / l, dz / l];
    };

    // —— 路灯侧别（与 placeLamps 规则一致） ——
    function lampBits(E, f, cfg, mx, mz) {
      if (!cfg.lamp || f._ped || !lampRegion(mx, mz, false) || !lampUrbanOk(f, urban, mx, mz)) return 0;
      if (f.c === 0) {
        if (!lampRegion(mx, mz, true)) return 0;
        if (E.flags & F.PAIRED) return E.gapMed > 0.5 && E.gapMed < 30 ? LAMPL : 0;
        return LAMPR;
      }
      let b = LAMPR;
      if (cfg.lampOne) return b; // 支路单侧灯
      if (E.flags & F.PAIRED) {
        if (E.gapMed > 1.2 && E.gapMed < 40 && !E.b) b |= LAMPL;
      } else if (!(E.sideF >= 0)) {
        // 辅路左侧是机非分隔带：灯由相邻主路右侧那排负责（立在分隔带里），辅路不再单独一排
        b |= LAMPL;
        if (!E.oneway && E.W >= 24 && !E.b) b |= LAMPM;
      }
      return b;
    }

    /** 步长函数加断点：断面一定落在 br（升序）上的各里程处 */
    function withBreaks(stepFn, br) {
      const B = Array.from(new Set(br)).sort((a, b) => a - b);
      return (s) => {
        let st = stepFn(s);
        for (const b of B) if (b > s + 0.04) { st = Math.min(st, b - s); break; }
        return st;
      };
    }
    /**
     * 人行道缘石坡道规划（一侧）：
     *   端部坡道：路口处人行道最后 1.4 m 整幅降到路面 +3 cm（转角坡道），带提示盲道；
     *   过街坡道：本路进口有人行横道时，在斑马线落脚处（R+1.6 ~ R+5.4 m）路缘侧 1.5 m 降坡，两侧 0.9 m 渐变；
     *   出入口坡道：小区/单位/支路在路段中间接入（E.drives）处，路缘石降坡、人行道连续（不画提示盲道）。
     * 返回 {br 断点, at(s) → {w 路缘侧降坡权重, e 整幅降坡权重, t 类型}, n 坡道数}
     */
    function rampPlan(E, side, rA, rB) {
      const zones = [];
      const add = (a, b, fl, t) => {
        const a2 = Math.max(a, rA + 0.3), b2 = Math.min(b, rB - 0.3);
        if (b2 - a2 < 1.2) return;
        zones.push({ a: a2, b: b2, fl, t });
      };
      if (E.flags & F.CW0 && E.R0 > 0) add(E.s0 + E.R0 + 1.6, E.s0 + E.R0 + 5.4, 0.9, 1);
      if (E.flags & F.CW1 && E.R1 > 0) add(E.s1 - E.R1 - 5.4, E.s1 - E.R1 - 1.6, 0.9, 1);
      if (E.drives) for (const d of E.drives) if (d.side === side) add(d.s - d.hw - 0.6, d.s + d.hw + 0.6, 1.0, 2);
      const e0 = E.sw0 > 0, e1 = E.sw1 > 0;
      const br = [];
      if (e0) br.push(rA + 0.7, rA + 1.4);
      if (e1) br.push(rB - 1.4, rB - 0.7);
      for (const z of zones) br.push(z.a - z.fl, z.a, z.b, z.b + z.fl);
      const q = { w: 0, e: 0, t: 0 };
      const at = (s) => {
        let e = 0;
        if (e0) e = Math.max(e, 1 - (s - rA) / 1.4);
        if (e1) e = Math.max(e, 1 - (rB - s) / 1.4);
        e = Math.max(0, Math.min(1, e));
        let w = 0, t = 0;
        for (const z of zones) {
          const f = s >= z.a && s <= z.b ? 1 : s < z.a ? 1 - (z.a - s) / z.fl : 1 - (s - z.b) / z.fl;
          if (f > w) { w = f; t = z.t; }
        }
        w = Math.max(0, w);
        if (e > 0.01 && e >= w) t = 1;
        q.w = w; q.e = e; q.t = t;
        return q;
      };
      return { br: br.filter((b) => b > rA && b < rB), at, n: zones.length + (e0 ? 1 : 0) + (e1 ? 1 : 0) };
    }

    // ================= 道路 =================
    let nMidDecal = 0, nRamp = 0, tProbe = 0;
    const medStat = { pair: 0, side: 0, sideSeg: 0 };
    const attr = [0, 0, 0, 0];
    const attrS = [0, 0, 0, 0];
    let nEdges = 0;
    const DS = {}, DL = {};
    const TOP = [0, 1];
    for (const E of edges) {
      const f = feats[E.fi];
      const cfg = info[E.fi].cfg;
      const ch = chain[E.fi];
      const tot = total[E.fi];
      const [mx, mz] = pointAt(f.p, ch, (E.s0 + E.s1) / 2);
      const core = inCore(mx, mz);
      const minor = !cfg.major;
      if (!core) {
        if (minor) continue;
        const r2 = mx * mx + mz * mz;
        // 核心区外：高等级道路 + 17 km 内次干道；空港新城、长安区等建成区（建筑密度达到新城标准）再补次干道与三级路，
        // 夜里有路面光带与路灯（审查 P1：空港新城道路没有路灯，只看得到车灯）
        const keep = f.c <= 2 || f.c === 8 || f.c === 9 || f.c === 10 || (f.c === 3 && r2 < FAR_SECONDARY_R * FAR_SECONDARY_R) ||
          ((f.c === 3 || f.c === 4 || f.c === 11) && (inFarDistrict(mx, mz) || (dens && dens(mx, mz) >= FAR_URBAN)));
        if (!keep) continue;
      }
      if (skipFeat.has(E.fi)) continue;
      const W = E.W, hw = W / 2;
      const sA = E.s0 + (E.trim0 || 0), sB = E.s1 - (E.trim1 || 0);
      if (sB - sA < 1.5) continue;
      const isBridge = !!E.b;
      const base = core ? 36 : 75;
      // 断面落在纵断面节点上（桥 10 m、核心区地面 16 m、远郊 48 m），线性插值后不入土、桥面曲线不被削平
      const stepFn = profileStepFn(f, isBridge ? (core ? 12 : 20) : base);
      const T = core ? (minor ? T_MINOR : T_MAJOR) : T_FAR;
      const tag = core ? (minor ? 'n' : 'm') : 'f';
      const grid = { x0: G0, z0: G0, T };
      // 步道/步行街：落在车行道里的区间（pavingCuts）断开；断面落在区间端点与中点上，保证区间内一律无效
      const cuts = cfg.paving || f._ped ? pc.cuts.get(E.fi) : null;
      let cutBr = null;
      if (cuts) {
        cutBr = [];
        for (const [a, b] of cuts) if (b > sA && a < sB) cutBr.push(a, (a + b) / 2, b);
        if (!cutBr.length) cutBr = null;
      }
      const secs = sampleSections(f.p, ch, sA, sB, cutBr ? withBreaks(stepFn, cutBr) : stepFn, grid);
      if (!secs) continue;
      const { ys, valid } = sectionYs(secs, f, tot);
      if (cutBr)
        for (let i = 0; i < secs.n; i++) {
          const sv = secs.s[i];
          for (const [a, b] of cuts) if (sv > a + 0.02 && sv < b - 0.02) { valid[i] = 0; break; }
        }
      DS[tag + (isBridge ? 'b' : '')] = (DS[tag + (isBridge ? 'b' : '')] || 0) + secs.n;
      DL[tag + (isBridge ? 'b' : '')] = (DL[tag + (isBridge ? 'b' : '')] || 0) + (sB - sA) / 1000;
      const style = lampStyleFor(f);
      const S = style === LAMP.PALACE ? 26 : style === LAMP.KNOT ? 30 : cfg.lamp;
      const lb = lampBits(E, f, cfg, mx, mz);
      // 光斑亮度档：快速路/主干道 3，次干道 2，支路 1
      const lvl = f.c <= 2 || cfg.link ? 3 : f.c === 3 ? 2 : 1;
      E.rendered = true;
      const lanes = Math.max(1, Math.min(15, E.lanes));
      attr[0] = cfg.paving ? KIND.PAVING : KIND.ASPHALT;
      attr[1] = lanes | ((lb ? S : 0) << 4) | (lvl << 10);
      attr[2] = (E.flags | lb) & 0xffff;
      attr[3] = Math.round(W * 100);
      // 细节通道：标线位（公交专用道/禁停）+ 两端可用转向（导向箭头按车道数与路口实际出口排布）
      const detA = [0, E.mark || 0, E.turn0 || 0, E.turn1 || 0];
      // 断面只要左右两点：横向 UV 与世界坐标在着色器里都是线性插值，宽路中点纯属冗余（去掉后宽路三角形减半）
      const pts = cfg.paving ? [{ o: hw, dy: 0, u: 0 }, { o: -hw, dy: 0, u: W }] : [{ o: hw, dy: 0, u: 0 }, { o: -hw, dy: 0, u: 1 }];
      runs(secs, valid, T, tag, (key, kx, kz, iA, iB) => {
        band(getTile(key, T, kx, kz, minor), secs, iA, iB, ys, pts, TOP, attr, E, detA);
      });
      nEdges++;
      // —— 路段人行横道（步道横穿主次干道处，OSM 过街位置）：贴花条带（斑马线 + 两侧停止线），比路面高 1.2 cm ——
      if (E.mids && !cfg.paving)
        for (const sm of E.mids) {
          const a = Math.max(sA, sm - 4.8), b = Math.min(sB, sm + 4.8);
          if (b - a < 6) continue;
          const sd = sampleSections(f.p, ch, a, b, () => 2.4, grid);
          if (!sd) continue;
          const yd = sectionYs(sd, f, tot);
          attr[0] = KIND_XWALK;
          const pseudo = { s0: a, s1: b, R0: 0, R1: 0 };
          runs(sd, yd.valid, T, tag, (key, kx, kz, iA, iB) => {
            band(getTile(key, T, kx, kz, minor), sd, iA, iB, yd.ys, [{ o: hw - 0.05, dy: 0.012, u: 0.05 / W }, { o: -hw + 0.05, dy: 0.012, u: 1 - 0.05 / W }], TOP, attr, pseudo, detA);
          });
          nMidDecal++;
        }

      // —— 人行道 + 路缘石（核心区、非桥、主要道路） ——
      if (core && cfg.sw > 0 && !isBridge && !cfg.link) {
        const sw = info[E.fi].sw;
        const bike = !!info[E.fi].bike;
        const attached = net.attachedTo(E.fi);
        if (E.pairF >= 0) attached.add(E.pairF);
        for (const side of [1, -1]) {
          const on = side === 1 ? E.swR : E.swL;
          if (!on) continue;
          // 路口端退让 sw + 0.5 m；度 2 的接续点（OSM 分段处）不留缝，与下一段人行道接上
          const rA = E.s0 + (E.sw0 > 0 ? E.sw0 + 0.5 : 0), rB = E.s1 - (E.sw1 > 0 ? E.sw1 + 0.5 : 0);
          if (rB - rA < 4) continue;
          const rp = rampPlan(E, side, rA, rB);
          const s2 = sampleSections(f.p, ch, rA, rB, rp.br.length ? withBreaks(stepFn, rp.br) : stepFn, grid);
          if (!s2) continue;
          const y2 = sectionYs(s2, f, tot);
          const sideLamp = side === 1 ? lb & LAMPR : lb & (LAMPL | LAMPM) ? LAMPL : 0;
          attrS[1] = (sideLamp ? S << 4 : 0) | (lvl << 10);
          attrS[2] = sideLamp;
          attrS[3] = Math.round(sw * 100);
          // 禁停黄线只画在外侧（右侧）路缘；8 = 人非共板非机动车道，16 = 左侧人行道（自行车图标朝 -s）
          const mk = (side === 1 ? (E.mark || 0) & 6 : 0) | (bike ? 8 : 0) | (side === -1 ? 16 : 0);
          // 逐断面可用宽度：沿外法线探测，碰到并行的别的车行道（辅路等）就收窄，人行道不再铺到别的路面上
          const swS = new Float32Array(s2.n), sup = new Uint8Array(s2.n);
          const tP0 = performance.now();
          for (let i = 0; i < s2.n; i++) {
            const rl = Math.hypot(s2.rx[i], s2.rz[i]) || 1;
            const ux = (s2.rx[i] / rl) * side, uz = (s2.rz[i] / rl) * side; // 朝外（side=1 右侧）
            let w = sw;
            const px = s2.x[i], pz = s2.z[i];
            if (inSideStrip(px + ux * (hw + 0.6), pz + uz * (hw + 0.6), E.fi)) {
              sup[i] = 1;
              y2.valid[i] = 0;
              swS[i] = 0.8;
              continue;
            }
            // 先探外缘与中点（并行的路一般会盖住外缘），都不在别的路面里就整宽；否则从路缘往外逐步找
            if (!cIdx.inside(px + ux * (hw + sw), pz + uz * (hw + sw), attached) && !cIdx.inside(px + ux * (hw + sw * 0.5), pz + uz * (hw + sw * 0.5), attached)) {
              swS[i] = sw;
              continue;
            }
            for (let o = 0.9; o <= sw + 0.45; o += 0.9) {
              const oo = Math.min(o, sw);
              if (cIdx.inside(s2.x[i] + ux * (hw + oo), s2.z[i] + uz * (hw + oo), attached)) { w = Math.max(0.8, oo - 0.9); break; }
            }
            swS[i] = w;
          }
          tProbe += performance.now() - tP0;
          // 逐断面坡道：w 缘石坡道（路缘侧 1.5 m 内降到 3 cm）、e 端部坡道（整幅降坡）、t 类型（1 过街坡道带提示盲道，2 出入口）
          const n2 = s2.n, rw = new Float32Array(n2), re = new Float32Array(n2), rt = new Uint8Array(n2);
          for (let i = 0; i < n2; i++) {
            const q = rp.at(s2.s[i]);
            rw[i] = q.w; re[i] = q.e; rt[i] = q.t;
          }
          const H = 0.15, LOW = 0.03, RW = Math.min(1.5, sw * 0.45);
          const det = [0, mk, 0, 0];
          const detAt = (i) => { det[0] = Math.round(Math.max(rw[i], re[i]) * 255); det[2] = rt[i]; det[3] = Math.min(255, Math.round(swS[i] * 10)); return det; };
          const dIn = (i) => H - (H - LOW) * Math.max(rw[i], re[i]);
          const dOut = (i) => H - (H - LOW) * re[i];
          const p2 = [{ o: 0, dy: 0, u: 0 }, { o: 0, dy: 0, u: 0 }];
          const p3 = [{ o: 0, dy: 0, u: 0 }, { o: 0, dy: 0, u: 0 }, { o: 0, dy: 0, u: 0 }];
          const cn = side === 1 ? [1, 0] : [-1, 0];
          // 横向坐标 o（左正）：右侧人行道在 -hw 外，左侧在 +hw 外；各剖面点按 o 递减排列（法线朝上/朝路）
          const fillCurb = side === 1
            ? (i, q) => { q[0].o = -hw; q[0].dy = 0; q[0].u = 0; q[1].o = -hw; q[1].dy = dIn(i); q[1].u = 0; }
            : (i, q) => { q[0].o = hw; q[0].dy = dIn(i); q[0].u = 0; q[1].o = hw; q[1].dy = 0; q[1].u = 0; };
          const fillTop = side === 1
            ? (i, q) => {
                const w = swS[i], r = Math.min(RW, w * 0.45);
                q[0].o = -hw; q[0].dy = dIn(i); q[0].u = 0;
                q[1].o = -hw - r; q[1].dy = dOut(i); q[1].u = r;
                q[2].o = -hw - w; q[2].dy = dOut(i); q[2].u = w;
              }
            : (i, q) => {
                const w = swS[i], r = Math.min(RW, w * 0.45);
                q[0].o = hw + w; q[0].dy = dOut(i); q[0].u = w;
                q[1].o = hw + r; q[1].dy = dOut(i); q[1].u = r;
                q[2].o = hw; q[2].dy = dIn(i); q[2].u = 0;
              };
          runs(s2, y2.valid, T_SUB, 'w', (key, kx, kz, iA, iB) => {
            const w = getTile(key, T_SUB, kx, kz, 'sub');
            attrS[0] = KIND.CURB;
            bandF(w, s2, iA, iB, y2.ys, p2, fillCurb, cn, attrS, E, detAt);
            attrS[0] = KIND.SIDEWALK;
            bandF(w, s2, iA, iB, y2.ys, p3, fillTop, TOP, attrS, E, detAt);
            // 人行道端部（路口处）：外缘竖向封口面，抬高的板不再露出下面的空隙
            for (const [i, sg] of [[iA, -1], [iB, 1]]) {
              if ((i === 0 && E.sw0 > 0) || (i === n2 - 1 && E.sw1 > 0) || (sg < 0 && i > 0 && sup[i - 1]) || (sg > 0 && i < n2 - 1 && sup[i + 1])) {
                const o0 = side === 1 ? -hw - swS[i] : hw, o1 = side === 1 ? -hw : hw + swS[i];
                endCap(w, s2, i, sg, o0, o1, y2.ys[i], -0.05, dOut(i), KIND.CURB);
              }
            }
          });
          nRamp += rp.n;
        }
      }
      // —— 中央分隔带（双幅路之间）：两幅各建靠自己一侧的一半，按断面处的局部中分带宽选型 ——
      if (core && !isBridge) {
        if (E.flags & F.PAIRED) buildMedian(E, f, ch, tot, stepFn, grid, lb, S, lvl, false);
        else if (E.sideF >= 0) buildMedian(E, f, ch, tot, stepFn, grid, lb, S, lvl, true); // 辅路左侧机非分隔带
      }
      // —— 桥梁：桥面板 + 护栏 + 箱梁 + 桥墩 ——
      if (isBridge) buildBridgeDeck(E, f, ch, tot, secs, ys, valid, core);
      // —— 被纵断面抬高的地面路段（引桥路堤/匝道）：两侧挡土墙，避免路面悬空露缝 ——
      else embankWalls(E, secs, ys, valid, cfg, swAt(mx, mz));
    }

    /**
     * 中央分隔带（实体构件，人眼高度有体积）。每幅路从自己的左路缘建到局部中分带中线（另一半由对向一幅建），
     * 中分带宽 g 逐断面用 pairGapAt 求（同一条边上宽度可从 0.2 m 变到 4 m）：
     *   g < 1.3 m：混凝土隔离墩 + 中线金属护栏（护栏面朝本幅，两幅各画一面）；
     *   1.3~2.4 m：花岗岩路缘 + 一道低矮圆顶绿篱（路缘顶以上 0.55 m，顶面中线略拱、两侧圆角、底部略收露枝干）；
     *   ≥ 2.4 m：花岗岩路缘 + 本幅一侧一道圆角边缘绿篱（宽 0.5~1.2 m 随带宽、高 0.6 m）+ 与路缘顶齐平的草坪（植被模块在上面种
     *   灌木球/小乔木与中线绿篱）；机非分隔带只铺草坪。第二轮：原 1.3~4 m 是整块 0.88 m 高的直角“绿盒子”，挡住对向车道的车下半截（审查 P1）。
     *   双幅路宽带不能只铺草坪：植被模块的分隔带绿篱按地形高种，路面被纵断面抬高处大半埋在草坪下，只露出一片暗色顶，
     *   人眼高度像草坪上的一串黑色破洞（东大街）；根治要植被按道路纵断面 roadY 定绿篱底高，在那之前保留道路自己的边缘绿篱。
     * 开口（人行横道/路口）处绿篱 1 m 内收成圆头；剖面每个点带自己的法线（圆角平滑着色）。
     * 本端分隔带一侧（左侧）没有横街接入时（丁字口在外侧、或两条要素首尾相接）分隔带连续通过，不收头不开口：
     * 原按路口半径截断，半幅分隔带提前收头，另半幅还在，中间露出一块切进草坪的斜梯形地面（长安北路南门外，审查 P2）。
     */
    function buildMedian(E, f, ch, tot, stepFn, grid, lb, S, lvl, side) {
      // side：辅路左侧的机非分隔带（相邻主路 E.sideF 不画它那一半，这里从辅路左缘一直画到主路路缘，两侧都有路缘石）
      const nb = side ? E.sideF : E.pairF;
      const HALF = side ? 1 : 0.5;
      medStat[side ? 'side' : 'pair']++;
      const contA = !(E.lx0 > 0), contB = !(E.lx1 > 0);
      // 有人行横道的进口：分隔带在斑马线外断开（行人安全岛开口），不让绿篱/隔离墩横在斑马线上；
      // 开口里的过街铺面由 medianGap 判定（分岔三角区等不平行的宽带不开口，见下）
      const gapOk = (atStart) => {
        const cw = E.flags & (atStart ? F.CW0 : F.CW1), R = atStart ? E.R0 : E.R1;
        if (!cw || !(R > 0)) return false;
        const a = atStart ? E.s0 + R + 1.0 : E.s1 - R - 6.0;
        return medianGapKind(E, f, ch, a, a + 5.0, nb, HALF) > 0;
      };
      const g0 = !contA && gapOk(true), g1 = !contB && gapOk(false);
      const rA = contA ? E.s0 : E.s0 + Math.max(E.R0 + (g0 ? 6.4 : 1.5), E.sw0 * 0.5, 1);
      const rB = contB ? E.s1 : E.s1 - Math.max(E.R1 + (g1 ? 6.4 : 1.5), E.sw1 * 0.5, 1);
      if (g0) medianGap(E, f, ch, tot, grid, E.s0 + E.R0 + 0.8, Math.min(rA, E.s0 + E.R0 + 6.4), E.s0 + E.R0 + 1.0, lb, S, lvl, nb, HALF);
      if (g1) medianGap(E, f, ch, tot, grid, Math.max(rB, E.s1 - E.R1 - 6.4), E.s1 - E.R1 - 0.8, E.s1 - E.R1 - 6.0, lb, S, lvl, nb, HALF);
      if (rB - rA < (contA || contB ? 1 : 8)) return;
      const TAPER = 1.0;
      const br = [];
      if (!contA) br.push(rA + 0.22, rA + 0.55, rA + TAPER);
      if (!contB) br.push(rB - TAPER, rB - 0.55, rB - 0.22);
      const s2 = sampleSections(f.p, ch, rA, rB, br.length ? withBreaks(stepFn, br) : stepFn, grid);
      const backed = !side && !!pairedBy.get(E.fi)?.has(E.pairF);
      if (!s2) return;
      const y2 = sectionYs(s2, f, tot);
      const n = s2.n, hw = E.W / 2;
      const gap = new Float32Array(n), type = new Int8Array(n), rnd = new Float32Array(n), tap = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const g = pairGapAt(net, E, s2.x[i], s2.z[i], s2.rx[i], s2.rz[i], nb);
        gap[i] = g ?? -1;
        type[i] = g === null || g < (side ? 0.3 : 0.25) || g > (side ? 14 : 70) ? -1 : g < 1.3 ? 0 : g < 2.4 ? 1 : 2;
        if (type[i] < 0) y2.valid[i] = 0;
        // 边缘绿篱修剪起伏（±3 cm，按里程散列）与开口处圆头收口（连续通过的一端不收）
        const sv = s2.s[i];
        rnd[i] = (Math.sin(sv * 0.83 + E.fi * 1.7) * 0.6 + Math.sin(sv * 2.31 + 0.5) * 0.4) * 0.03;
        const d = Math.min(contA ? 1e9 : sv - rA, contB ? 1e9 : rB - sv);
        const q = Math.max(0, Math.min(1, d / TAPER));
        tap[i] = Math.sqrt(Math.max(0, 1 - (1 - q) * (1 - q)));
      }
      attrS[1] = (lb & LAMPL ? S << 4 : 0) | (lvl << 10);
      attrS[2] = lb & LAMPL;
      const Hc = 0.18; // 路缘高
      const P = (k) => { const a = []; for (let j = 0; j < k; j++) a.push({ o: 0, dy: 0, u: 0, no: 0, ny: 1 }); return a; };
      const p2 = P(2);
      // 本幅一侧铺到的外沿（双幅路 = 局部中线；机非分隔带 = 相邻主路路缘），与内沿（机非分隔带外沿留 0.25 m 路缘石）
      const cOut = (i, min) => hw + Math.max(gap[i] * HALF, min);
      const cIn = (i, min) => cOut(i, min) - (side ? 0.25 : 0);
      // 按类型切成连续段（每个断面间隔取两端较宽的类型；类型变化处两段共用断面，不留缺口）
      const segT = (i) => (y2.valid[i] && y2.valid[i + 1] ? Math.max(type[i], type[i + 1]) : -1);
      for (let a = 0; a < n - 1; ) {
        const t = segT(a);
        let b = a + 1;
        while (b < n - 1 && segT(b) === t) b++;
        if (t >= 0) { emit(t, a, b); if (side) medStat.sideSeg++; }
        a = b;
      }
      /**
       * 单道绿篱剖面（断面 i）：从外侧（路缘顶内缘）底部起，经外侧面、外圆角、顶面到中线（两幅在中线处对接）
       * 或机非分隔带另一侧路缘石内沿。每点 {o, dy, u=离路缘顶高度, no, ny 法线}。返回点数。
       */
      function hedgeProfile(i, q) {
        const Hh = 0.55 * (0.25 + 0.75 * tap[i]);
        const o0 = hw + 0.27 + (1 - tap[i]) * 0.18; // 外侧面（开口处向内收）
        const top = Hc + Hh;
        // 点序必须与路缘立面/顶面一致（从中线顶面往外、外侧面从上往下），三角形才朝外：下面按自下而上算好后倒序写入
        // （原自下而上写入，整段绿篱内外翻转被背面剔除，看到的是远侧内壁，像带草顶的空心方盒）
        let k = 6;
        const put = (o, dy, no, ny) => { const v = q[k--]; v.o = o; v.dy = dy; v.u = dy - Hc; v.no = no; v.ny = ny; };
        const r = Math.min(0.15, Hh * 0.35);
        put(o0 + 0.04, Hc, -0.92, -0.4); // 底部略收
        put(o0, Hc + 0.12, -1, 0);
        put(o0 + 0.01, top - r, -0.97, 0.24);
        put(o0 + 0.3 * r, top - 0.3 * r, -0.7, 0.71);
        put(o0 + r, top, -0.2, 0.98);
        const c = cIn(i, 0.36); // 中线：顶面略拱（+3 cm）
        put(Math.max(o0 + r + 0.05, (o0 + r + c) / 2), top + 0.025 * tap[i], -0.05, 1);
        put(Math.max(o0 + r + 0.1, c), top + 0.03 * tap[i], 0, 1);
        return 7;
      }
      /** 宽带边缘绿篱剖面（10 点）：外侧面 → 外圆角 → 顶面 → 内圆角 → 内侧面落到草坪；同样倒序写入（下标 0 = 内侧底部） */
      function edgeHedgeProfile(i, q) {
        const g2 = Math.max(gap[i] / 2, 0.36);
        const Hh = (0.6 + rnd[i]) * (0.25 + 0.75 * tap[i]);
        const o0 = hw + 0.27 + (1 - tap[i]) * 0.18;
        const top = Hc + Hh;
        let k = 9;
        const put = (o, dy, no, ny) => { const v = q[k--]; v.o = o; v.dy = dy; v.u = dy - Hc; v.no = no; v.ny = ny; };
        const r = Math.min(0.15, Hh * 0.35);
        put(o0 + 0.04, Hc, -0.92, -0.4);
        put(o0, Hc + 0.12, -1, 0);
        put(o0 + 0.01, top - r, -0.97, 0.24);
        put(o0 + 0.3 * r, top - 0.3 * r, -0.7, 0.71);
        put(o0 + r, top, -0.2, 0.98);
        const hwid = Math.min(1.2, Math.max(0.5, (g2 - 0.25) * 0.45)) * (0.7 + 0.3 * tap[i]);
        const oi = Math.min(o0 + hwid, hw + g2 - 0.1);
        put(Math.max(o0 + r + 0.02, oi - r), top, 0.2, 0.98);
        put(oi - 0.3 * r, top - 0.3 * r, 0.7, 0.71);
        put(oi, top - r, 0.97, 0.24);
        put(oi, Hc + 0.1, 1, 0);
        put(oi - 0.03, Hc - 0.02, 0.92, -0.4);
        return 10;
      }
      function emit(t, iA, iB) {
        runs(subSlice(s2, iA, iB), sliceArr(y2.valid, iA, iB), T_SUB, 'w', (key, kx, kz, a, b) => {
          const w = getTile(key, T_SUB, kx, kz, 'sub');
          const A = a + iA, B = b + iA;
          const face = (kind, nrm, fill) => {
            attrS[0] = kind;
            bandF(w, s2, A, B, y2.ys, p2, fill, nrm, attrS, E);
          };
          if (t === 0) {
            // 隔离墩：从本幅路缘到中线（机非分隔带到相邻主路路缘），高 0.25 m；中线护栏 1.0 m
            const Hb = 0.25;
            attrS[3] = 30;
            face(KIND.CURB, [-1, 0], (i, q) => { q[0].o = hw; q[0].dy = Hb; q[1].o = hw; q[1].dy = 0; });
            face(KIND.CURB, TOP, (i, q) => { const c = cOut(i, 0.2); q[0].o = c; q[0].dy = Hb; q[1].o = hw; q[1].dy = Hb; });
            face(KIND_FENCE, [-1, 0], (i, q) => {
              const c = hw + Math.max(gap[i] * 0.5, 0.2) - (side ? 0 : 0.02);
              q[0].o = c; q[0].dy = Hb + 1.0; q[0].u = 1.0; q[1].o = c; q[1].dy = Hb; q[1].u = 0;
            });
            if (side) {
              // 护栏另一面（朝主路）与隔离墩外侧面
              face(KIND_FENCE, [1, 0], (i, q) => {
                const c = hw + Math.max(gap[i] * 0.5, 0.2) + 0.02;
                q[0].o = c; q[0].dy = Hb; q[0].u = 0; q[1].o = c; q[1].dy = Hb + 1.0; q[1].u = 1.0;
              });
              face(KIND.CURB, [1, 0], (i, q) => { const c = cOut(i, 0.2); q[0].o = c; q[0].dy = 0; q[1].o = c; q[1].dy = Hb; });
            }
            return;
          }
          attrS[3] = Math.round(Math.min(gap[iA], 99) * 100);
          // 路缘立面 + 路缘顶（0.25 m 花岗岩）
          face(KIND.CURB, [-1, 0], (i, q) => { q[0].o = hw; q[0].dy = Hc; q[1].o = hw; q[1].dy = 0; });
          face(KIND_MEDIAN, TOP, (i, q) => { q[0].o = hw + 0.25; q[0].dy = Hc; q[0].u = 0.25; q[1].o = hw; q[1].dy = Hc; q[1].u = 0; });
          if (side) {
            // 机非分隔带另一侧（朝相邻主路）：路缘顶 + 路缘立面
            face(KIND_MEDIAN, TOP, (i, q) => { const c = cOut(i, 0.6); q[0].o = c; q[0].dy = Hc; q[0].u = 0; q[1].o = c - 0.25; q[1].dy = Hc; q[1].u = 0.25; });
            face(KIND.CURB, [1, 0], (i, q) => { const c = cOut(i, 0.6); q[0].o = c; q[0].dy = 0; q[1].o = c; q[1].dy = Hc; });
            for (const [i, sg] of [[A, -1], [B, 1]]) endCap(w, s2, i, sg, cOut(i, 0.6) - 0.25, cOut(i, 0.6), y2.ys[i], 0, Hc, KIND.CURB);
          }
          if (t === 2 && !side) {
            // 双幅路宽带：覆土条 + 边缘绿篱 + 绿篱内侧到中线的草坪（略低于路缘顶），段首段尾路缘端面、绿篱扇形封口、草坪端面
            face(KIND_MEDIAN, TOP, (i, q) => { const o0 = hw + 0.27 + (1 - tap[i]) * 0.18 + 0.04; q[0].o = o0; q[0].dy = Hc - 0.01; q[0].u = 0.3; q[1].o = hw + 0.25; q[1].dy = Hc - 0.01; q[1].u = 0.27; });
            const hp = P(10);
            attrS[0] = KIND_HEDGE;
            bandN(w, s2, A, B, y2.ys, hp, (i, q) => edgeHedgeProfile(i, q), attrS, E);
            face(KIND_GRASS, TOP, (i, q) => {
              edgeHedgeProfile(i, hp);
              const c = cIn(i, 0.6), e = Math.min(hp[0].o, c);
              q[0].o = c; q[0].dy = Hc - 0.02; q[0].u = c - hw;
              q[1].o = e; q[1].dy = Hc - 0.02; q[1].u = e - hw;
            });
            for (const [i, sg] of [[A, -1], [B, 1]]) {
              endCap(w, s2, i, sg, hw, hw + 0.25, y2.ys[i], 0, Hc, KIND.CURB);
              edgeHedgeProfile(i, hp);
              capFan(w, s2, i, sg, y2.ys[i], hp, 10, null, Hc, KIND_HEDGE);
              endCap(w, s2, i, sg, Math.min(hp[0].o, cIn(i, 0.6)), cIn(i, 0.6), y2.ys[i], 0, Hc - 0.02, KIND.CURB);
            }
            return;
          }
          if (t === 2) {
            // 机非分隔带宽带：路缘顶内缘到另一侧路缘石内沿铺草坪（略低于路缘顶），段首段尾路缘与草坪端面
            face(KIND_GRASS, TOP, (i, q) => {
              const c = cIn(i, 0.6);
              q[0].o = c; q[0].dy = Hc - 0.02; q[0].u = c - hw;
              q[1].o = hw + 0.25; q[1].dy = Hc - 0.02; q[1].u = 0.25;
            });
            for (const [i, sg] of [[A, -1], [B, 1]]) {
              endCap(w, s2, i, sg, hw, hw + 0.25, y2.ys[i], 0, Hc, KIND.CURB);
              endCap(w, s2, i, sg, hw + 0.25, cIn(i, 0.6), y2.ys[i], 0, Hc - 0.02, KIND.CURB);
            }
            return;
          }
          // 路缘顶内缘到绿篱外侧面之间（开口处绿篱内收后露出的一条）：覆土
          face(KIND_MEDIAN, TOP, (i, q) => { const o0 = hw + 0.27 + (1 - tap[i]) * 0.18 + 0.04; q[0].o = o0; q[0].dy = Hc - 0.01; q[0].u = 0.3; q[1].o = hw + 0.25; q[1].dy = Hc - 0.01; q[1].u = 0.27; });
          // 绿篱（外侧面 + 圆角 + 顶面），逐点法线
          const NP = 7;
          const hp = P(NP);
          attrS[0] = KIND_HEDGE;
          bandN(w, s2, A, B, y2.ys, hp, (i, q) => hedgeProfile(i, q), attrS, E);
          // 段首段尾：路缘端面 + 绿篱剖面封口（扇形，跟剖面轮廓一致）
          for (const [i, sg] of [[A, -1], [B, 1]]) {
            endCap(w, s2, i, sg, hw, hw + 0.25, y2.ys[i], 0, Hc, KIND.CURB);
            hedgeProfile(i, hp);
            capFan(w, s2, i, sg, y2.ys[i], hp, NP, cIn(i, 0.36), Hc, KIND_HEDGE);
          }
          // 对向一幅没有配对回来（或机非分隔带）时在中线 / 另一侧路缘石内沿处封口（不露空）
          if (!backed)
            face(KIND_HEDGE, [1, 0], (i, q) => {
              const e = cIn(i, 0.36);
              const Hh = 0.55 * (0.25 + 0.75 * tap[i]);
              q[0].o = e; q[0].dy = Hc - 0.02; q[0].u = -0.02;
              q[1].o = e; q[1].dy = Hc + Hh; q[1].u = Hh;
            });
        });
      }
    }
    /**
     * 分隔带开口铺面类型（本幅 [a,b] 段）：0 不开口；1 窄带（≤ 8 m）沥青 + 斑马线接续；2 宽带石板过街步道。
     * 宽带只在两幅基本平行（开口两端带宽差 < 1.5 m）且不超过 30 m 时开口：分岔三角区（长安北路南门外分叉处）
     * 原样铺出一块边缘切进草坪、形状与道路走向无关的斜梯形石板（审查 P2）。
     */
    function medianGapKind(E, f, ch, a, b, nb = E.pairF, HALF = 0.5) {
      const pa = pointAt(f.p, ch, a), pb = pointAt(f.p, ch, b);
      const ga0 = pairGapAt(net, E, pa[0], pa[1], -pa[3], pa[2], nb), gb0 = pairGapAt(net, E, pb[0], pb[1], -pb[3], pb[2], nb);
      if (ga0 === null || gb0 === null) return 0;
      // 按本幅要铺的宽度判定（机非分隔带整宽 = 双幅路的两倍半宽）
      const ga = ga0 * HALF * 2, gb = gb0 * HALF * 2;
      const g = Math.max(ga, gb);
      if (Math.min(ga, gb) < 0.25 || g > 70) return 0;
      if (g <= 8) return 1;
      if (g > 30 || Math.abs(ga - gb) > 1.5) return 0;
      return 2;
    }
    /** 分隔带人行横道开口 [a,b]（本幅一侧，从左路缘到局部中线）；xw0 = 斑马线带起点里程（带宽 5 m） */
    function medianGap(E, f, ch, tot, grid, a, b, xw0, lb, S, lvl, nb = E.pairF, HALF = 0.5) {
      if (b - a < 1) return;
      const sd = sampleSections(f.p, ch, a, b, () => 2.0, grid);
      if (!sd) return;
      const mid = sd.n >> 1;
      const g0 = pairGapAt(net, E, sd.x[mid], sd.z[mid], sd.rx[mid], sd.rz[mid], nb);
      if (g0 === null || g0 < 0.25 || g0 > 70) return;
      const g = g0 * HALF * 2; // 本幅铺到的宽度的两倍（与双幅路 g 同义）
      const yd = sectionYs(sd, f, tot);
      const hw = E.W / 2, half = g / 2 + (HALF < 1 ? 0.05 : 0);
      const pseudo = { s0: xw0, s1: xw0 + 5.0, R0: 0, R1: 0 };
      const att = [0, 1 | ((lb & LAMPL ? S : 0) << 4) | (lvl << 10), F.NOMARK | (E.flags & 1) | (lb & LAMPL), Math.round(E.W * 100)];
      if (g <= 8) {
        runs(sd, yd.valid, T_SUB, 'w', (key, kx, kz, iA, iB) => {
          const w = getTile(key, T_SUB, kx, kz, 'sub');
          // u 按本幅车行道宽归一并接着本幅左缘往外量（负值），斑马线条纹相位与车行道上的连续
          att[0] = KIND.ASPHALT;
          band(w, sd, iA, iB, yd.ys, [{ o: hw + half, dy: -0.005, u: -half / E.W }, { o: hw, dy: -0.005, u: 0 }], TOP, att, E);
          att[0] = KIND_XWALK;
          band(w, sd, iA, iB, yd.ys, [{ o: hw + half, dy: 0.008, u: -half / E.W }, { o: hw, dy: 0.008, u: 0 }], TOP, att, pseudo);
        });
        return;
      }
      // 宽带：只铺在斑马线延长线上（宽 5 m，与斑马线一致），两端（沿斑马线方向的两条边）带 0.12 m 收边石（着色器 32768 位）
      const sp = sampleSections(f.p, ch, xw0, xw0 + 5.0, () => 1.0, grid);
      if (!sp) return;
      const yp = sectionYs(sp, f, tot);
      att[0] = KIND.PAVING;
      att[2] = (att[2] | 32768) & 0xffff;
      att[3] = Math.round(half * 100);
      runs(sp, yp.valid, T_SUB, 'w', (key, kx, kz, iA, iB) => {
        const w = getTile(key, T_SUB, kx, kz, 'sub');
        band(w, sp, iA, iB, yp.ys, [{ o: hw + half, dy: 0.02, u: half }, { o: hw, dy: 0.02, u: 0 }], TOP, att, pseudo);
      });
    }
    /** 与 bandF 相同，但剖面点带各自法线（{o, dy, u, no, ny}），fill(i, pts) 返回点数（圆角构件平滑着色） */
    function bandN(W, secs, iA, iB, ys, pts, fill, attr, E) {
      const np = pts.length;
      W.ensure((iB - iA + 1) * np, (iB - iA) * (np - 1) * 6);
      kindTris[attr[0]] = (kindTris[attr[0]] || 0) + (iB - iA) * (np - 1) * 2;
      let prev = -1;
      for (let i = iA; i <= iB; i++) {
        fill(i, pts);
        const cx = secs.x[i], cz = secs.z[i], rx = secs.rx[i], rz = secs.rz[i];
        const rl = Math.hypot(rx, rz) || 1;
        if (E) {
          JUNC[0] = secs.s[i] - E.s0;
          JUNC[1] = E.s1 - secs.s[i];
          JUNC[2] = E.R0;
          JUNC[3] = E.R1;
        }
        const base = W.n;
        for (let k = 0; k < np; k++) {
          const p = pts[k];
          const nl = Math.hypot(p.no, p.ny) || 1;
          W.v(cx - rx * p.o, ys[i] + p.dy, cz - rz * p.o, (-rx / rl) * (p.no / nl), p.ny / nl, (-rz / rl) * (p.no / nl), p.u, secs.s[i], attr, JUNC, DET0);
        }
        if (prev >= 0)
          for (let k = 0; k < np - 1; k++) {
            const a0 = prev + k, a1 = a0 + 1, b0 = base + k, b1 = b0 + 1;
            W.tri(a0, a1, b0);
            W.tri(a1, b1, b0);
          }
        prev = base;
      }
    }
    /**
     * 剖面封口（扇形）：断面 i 处，按剖面轮廓 pts[0..np-1]（自下而上越过顶面）与底边围成的多边形，sg=+1 朝前进方向。
     * oc 不为 null 时轮廓终点在中线顶面，补一个中线底点（单道绿篱）。
     */
    function capFan(W, secs, i, sg, y, pts, np, oc, yb, kind) {
      const cx = secs.x[i], cz = secs.z[i], rx = secs.rx[i], rz = secs.rz[i];
      const rl = Math.hypot(rx, rz) || 1;
      const fx = (rz / rl) * sg, fz = (-rx / rl) * sg;
      const ux = rx / rl, uz = rz / rl;
      const poly = [];
      for (let k = 0; k < np; k++) poly.push([pts[k].o, pts[k].dy]);
      if (oc !== null) poly.push([oc, yb - 0.02]);
      let mo = 0, md = 0;
      for (const [o, d] of poly) { mo += o; md += d; }
      mo /= poly.length; md /= poly.length;
      attrS[0] = kind;
      W.ensure(poly.length + 1, poly.length * 3);
      const c0 = W.n;
      W.v(cx - ux * mo, y + md, cz - uz * mo, fx, 0, fz, md - yb, secs.s[i], attrS, JUNC);
      for (const [o, d] of poly) W.v(cx - ux * o, y + d, cz - uz * o, fx, 0, fz, d - yb, secs.s[i], attrS, JUNC);
      for (let k = 0; k < poly.length; k++) {
        const a = c0 + 1 + k, b = c0 + 1 + ((k + 1) % poly.length);
        // 绕序：几何法线 (Pa-C)×(Pb-C) 与期望朝向 (fx,0,fz) 同向
        const pa = poly[k], pb = poly[(k + 1) % poly.length];
        const ax = -ux * (pa[0] - mo), ay = pa[1] - md, az = -uz * (pa[0] - mo);
        const bx = -ux * (pb[0] - mo), by = pb[1] - md, bz = -uz * (pb[0] - mo);
        const nx = ay * bz - az * by, nz = ax * by - ay * bx;
        if (nx * fx + nz * fz > 0) W.tri(c0, a, b); else W.tri(c0, b, a);
      }
    }
    /** 构件端面：断面 i 处、横向 o0..o1、高 dy0..dy1 的竖直矩形，sg=+1 朝前进方向、-1 朝后 */
    function endCap(W, secs, i, sg, o0, o1, y, dy0, dy1, kind) {
      const cx = secs.x[i], cz = secs.z[i], rx = secs.rx[i], rz = secs.rz[i];
      const rl = Math.hypot(rx, rz) || 1;
      const fx = (rz / rl) * sg, fz = (-rx / rl) * sg; // 前进方向 = (rz, -rx)
      const ux = rx / rl, uz = rz / rl; // 单位右法线（o 方向为其反向）
      attrS[0] = kind;
      W.ensure(4, 6);
      const P = [[o0, dy0], [o1, dy0], [o1, dy1], [o0, dy1]];
      const b = W.n;
      for (const [o, dy] of P) W.v(cx - ux * o, y + dy, cz - uz * o, fx, 0, fz, dy, secs.s[i], attrS, JUNC);
      // 按几何法线与期望朝向一致定绕序
      const ax = -ux * (o1 - o0), az = -uz * (o1 - o0); // 0→1 方向（水平）
      const ny = dy1 - dy0; // 1→2 方向（竖直）
      // (p1-p0)×(p2-p1) = (ax,0,az)×(0,ny,0) = (-az*ny, 0, ax*ny)
      const dot = -az * ny * fx + ax * ny * fz;
      if (dot > 0) { W.tri(b, b + 1, b + 2); W.tri(b, b + 2, b + 3); }
      else { W.tri(b, b + 2, b + 1); W.tri(b, b + 3, b + 2); }
    }
    /** 断面子集（视图，便于对子区间调用 runs） */
    function subSlice(sc, a, b) {
      return { n: b - a + 1, x: sc.x.subarray(a, b + 1), z: sc.z.subarray(a, b + 1), s: sc.s.subarray(a, b + 1), rx: sc.rx.subarray(a, b + 1), rz: sc.rz.subarray(a, b + 1) };
    }
    function sliceArr(arr, a, b) { return arr.subarray(a, b + 1); }
    /** 与 band 相同，但剖面点逐断面由 fill(i, pts) 填写（宽度沿路变化的构件） */
    function bandF(W, secs, iA, iB, ys, pts, fill, nrm, attr, E, detAt = null) {
      const np = pts.length;
      W.ensure((iB - iA + 1) * np, (iB - iA) * (np - 1) * 6);
      kindTris[attr[0]] = (kindTris[attr[0]] || 0) + (iB - iA) * (np - 1) * 2;
      let prev = -1;
      const nl = Math.hypot(nrm[0], nrm[1]) || 1;
      const no = nrm[0] / nl, ny = nrm[1] / nl;
      for (let i = iA; i <= iB; i++) {
        fill(i, pts);
        const cx = secs.x[i], cz = secs.z[i], rx = secs.rx[i], rz = secs.rz[i];
        const rl = Math.hypot(rx, rz) || 1;
        const nx = (-rx / rl) * no, nz = (-rz / rl) * no;
        if (E) {
          JUNC[0] = secs.s[i] - E.s0;
          JUNC[1] = E.s1 - secs.s[i];
          JUNC[2] = E.R0;
          JUNC[3] = E.R1;
        }
        const base = W.n;
        const det = detAt ? detAt(i) : DET0;
        for (let k = 0; k < np; k++) {
          const p = pts[k];
          W.v(cx - rx * p.o, ys[i] + p.dy, cz - rz * p.o, nx, ny, nz, p.u, secs.s[i], attr, JUNC, det);
        }
        if (prev >= 0)
          for (let k = 0; k < np - 1; k++) {
            const a0 = prev + k, a1 = a0 + 1, b0 = base + k, b1 = b0 + 1;
            W.tri(a0, a1, b0);
            W.tri(a1, b1, b0);
          }
        prev = base;
      }
    }

    function embankWalls(E, secs, ys, valid, cfg, SW) {
      const n = secs.n;
      const ground = new Float32Array(n);
      let any = false;
      for (let i = 0; i < n; i++) {
        ground[i] = terrain.heightAt(secs.x[i], secs.z[i]);
        if (valid[i] && ys[i] - ground[i] - LIFT > 0.6) any = true;
      }
      if (!any) return;
      const hw = E.W / 2;
      for (const side of [1, -1]) {
        const swOn = cfg.sw > 0 && (side === 1 ? E.swR : E.swL);
        // 横向坐标约定 o 以前进方向左侧为正（世界位置 = 中心 − 右法线 × o）；side=1 为右侧墙
        const oo = -side * (hw + (swOn ? info[E.fi].sw : 0) + 0.05);
        let prev = -1;
        SW.ensure(n * 2, n * 6);
        for (let i = 0; i < n; i++) {
          // 抬高不足 0.3 m 的断面不建墙（两端各留一个断面作收口）
          const lift = ys[i] - ground[i] - LIFT;
          const keep = valid[i] && (lift > 0.3 || (i > 0 && ys[i - 1] - ground[i - 1] - LIFT > 0.3) || (i + 1 < n && ys[i + 1] - ground[i + 1] - LIFT > 0.3));
          if (!keep) { prev = -1; continue; }
          const rx = secs.rx[i], rz = secs.rz[i];
          const rl = Math.hypot(rx, rz) || 1;
          const x = secs.x[i] - rx * oo, z = secs.z[i] - rz * oo;
          const g = terrain.heightAt(x, z) - 0.4;
          const top = ys[i] + (swOn ? 0.15 : 0.02);
          const nx = (side * rx) / rl, nz = (side * rz) / rl; // 朝外
          const col = [176, 172, 164, 0];
          const b = SW.n;
          SW.v(x, top, z, nx, 0, nz, secs.s[i], 0, col);
          SW.v(x, Math.min(g, top - 0.05), z, nx, 0, nz, secs.s[i], top - g, col);
          if (prev >= 0) {
            if (side === 1) { SW.tri(prev, prev + 1, b); SW.tri(prev + 1, b + 1, b); }
            else { SW.tri(prev, b, prev + 1); SW.tri(prev + 1, b, b + 1); }
          }
          prev = b;
        }
      }
    }

    function buildBridgeDeck(E, f, ch, tot, secs, ys, valid, core) {
      const W = E.W, hw = W / 2;
      const D = W >= 12 ? 1.9 : 1.5;
      const wing = Math.min(2.4, hw * 0.3);
      const pw = 0.45, ph = 1.05;
      // 从右侧内缘开始，经右护栏、右翼缘、底板、左翼缘、左护栏回到左内缘（外表面在前进方向左手侧 → 法线朝外）
      const prof = core
        ? [
            [-hw + pw, 0], [-hw + pw, ph], [-hw, ph], [-hw, ph - 0.14], [-hw, -0.45], [-hw + wing, -D],
            [hw - wing, -D], [hw, -0.45], [hw, ph - 0.14], [hw, ph], [hw - pw, ph], [hw - pw, 0],
          ]
        : [[-hw + pw, ph], [-hw, ph], [-hw, -D * 0.7], [hw, -D * 0.7], [hw, ph], [hw - pw, ph]];
      const glowSeg = core ? new Set([2, 8]) : new Set(); // 护栏外侧顶部 LED 轮廓灯带
      const n = prof.length;
      const ground = new Float32Array(secs.n);
      for (let i = 0; i < secs.n; i++) ground[i] = terrain.heightAt(secs.x[i], secs.z[i]) + 0.02;
      // 按 2.5 km 结构分块逐段写入（块内断面连续）
      runs(secs, valid, T_STRUCT, 's', (key, kx, kz, iA, iB) => {
        const SW = swAt(kx, kz);
        let prevBase = -1;
        SW.ensure((iB - iA + 1) * (n - 1) * 2, (iB - iA) * (n - 1) * 6);
        for (let i = iA; i <= iB; i++) {
          const cx = secs.x[i], cz = secs.z[i], rx = secs.rx[i], rz = secs.rz[i];
          const rl = Math.hypot(rx, rz) || 1;
          const ux = -rx / rl, uz = -rz / rl; // 左方向
          const lift = ys[i] - ground[i];
          const glow = core && lift > 4 ? 90 : 0;
          const base = SW.n;
          for (let k = 0; k < n - 1; k++) {
            const [o0, d0] = prof[k], [o1, d1] = prof[k + 1];
            const y0 = Math.max(ys[i] + d0, d0 < 0 ? ground[i] : -1e9), y1 = Math.max(ys[i] + d1, d1 < 0 ? ground[i] : -1e9);
            const to = o1 - o0, ty = d1 - d0;
            const L = Math.hypot(to, ty) || 1;
            const no = ty / L, nyv = -to / L;
            const under = d0 < -0.3 && d1 < -0.3;
            const shade = under ? 150 : k === 0 || k === n - 2 ? 190 : 205;
            const col = [shade, shade - 2, shade - 6, glowSeg.has(k) ? glow : 0];
            SW.v(cx - rx * o0, y0, cz - rz * o0, ux * no, nyv, uz * no, secs.s[i], d0 + o0, col);
            SW.v(cx - rx * o1, y1, cz - rz * o1, ux * no, nyv, uz * no, secs.s[i], d1 + o1, col);
          }
          if (prevBase >= 0)
            for (let k = 0; k < n - 1; k++) {
              const a0 = prevBase + k * 2, a1 = a0 + 1, b0 = base + k * 2, b1 = b0 + 1;
              SW.tri(a0, a1, b0);
              SW.tri(a1, b1, b0);
            }
          prevBase = base;
        }
      });
      // 桥墩：按全要素里程统一相位（跨径 30 m），净空不足不设
      const SP = 30;
      const k0 = Math.ceil(E.s0 / SP - 0.5);
      for (let k = k0; ; k++) {
        const s = (k + 0.5) * SP;
        if (s > E.s1) break;
        if (s < E.s0) continue;
        const lift = bridgeLift(f, s, tot);
        if (lift - D < 2.4) continue;
        const [x, z, dx, dz] = pointAt(f.p, ch, s);
        if (!inCore(x, z) && x * x + z * z > 30000 * 30000) continue;
        const y = roadY(terrain, f, x, z, s, tot);
        if (y === null || excluded(x, z)) continue;
        const yaw = Math.atan2(dx, dz);
        const top = y - D;
        if (W > 15) {
          const off = hw - 3.2;
          addPier(x - dz * off, z + dx * off, top, yaw, 1.5, 1.5, 3.2, 1.3, 2.2, 4);
          addPier(x + dz * off, z - dx * off, top, yaw, 1.5, 1.5, 3.2, 1.3, 2.2, 4);
        } else {
          addPier(x, z, top, yaw, 1.6, 1.6, Math.max(3, W - 3), 1.3, 2.0, 5);
        }
      }
    }

    // ================= 路口铺面 =================
    // 每条边只画自己宽度的条带，十字/丁字路口里各条带之间的转角与（双幅路）中分带缺口没有路面，露出影像/地面。
    // 把核心区地面主路的路口节点按 35 m 聚类（双幅路交叉口是 4 个节点），去掉两端都在路口里的内部连接段，
    // 各进口按方位角排序，相邻进口之间沿两条路缘线求交得转角点，围成多边形铺一块沥青（无标线、比路面低 4 cm：
    // 条带处条带在上，缺口处露出铺面）。原用各进口路缘点的凸包：转角处凸包斜边切进四个人行道转角，
    // 俯视像一个比路面宽的深色圆盘/小环岛（审查 P2）。
    const T6 = performance.now();
    let nJunc = 0;
    {
      const ends = new Map(); // node -> [{x,z,dx,dz,hw,R,y,...}]
      for (const E of edges) {
        if (!E.rendered || E.b) continue;
        const f = feats[E.fi], cfg = info[E.fi].cfg;
        if (!cfg.major || cfg.link || f.c === 0) continue;
        const ch = chain[E.fi], tot = total[E.fi];
        for (const atStart of [true, false]) {
          const s = atStart ? E.s0 : E.s1;
          const [x, z, dx, dz] = pointAt(f.p, ch, Math.min(Math.max(s + (atStart ? 0.5 : -0.5), 0), tot));
          if (!inCore(x, z) || excluded(x, z)) continue;
          const y = roadY(terrain, f, x, z, s, tot);
          if (y === null) continue;
          const sg = atStart ? 1 : -1; // 离开节点的方向
          const node = atStart ? E.n0 : E.n1;
          let a = ends.get(node);
          if (!a) ends.set(node, (a = []));
          a.push({ x, z, dx: dx * sg, dz: dz * sg, hw: E.W / 2, R: atStart ? E.R0 : E.R1, y, f, s, sg, tot, other: atStart ? E.n1 : E.n0 });
        }
      }
      // 路口节点：≥3 个主路进口
      const jn = [];
      for (const [node, a] of ends) if (a.length >= 3) jn.push(node);
      // 35 m 聚类（并查集，网格加速）
      const par = new Map(jn.map((n) => [n, n]));
      const find = (a) => { while (par.get(a) !== a) { par.set(a, par.get(par.get(a))); a = par.get(a); } return a; };
      const JC = 35, jg = new Map();
      for (const n of jn) {
        const e0 = ends.get(n)[0];
        const k = Math.floor(e0.x / JC) * 100003 + Math.floor(e0.z / JC);
        let l = jg.get(k);
        if (!l) jg.set(k, (l = []));
        l.push(n);
      }
      for (const n of jn) {
        const e0 = ends.get(n)[0];
        const cx = Math.floor(e0.x / JC), cz = Math.floor(e0.z / JC);
        for (let i = -1; i <= 1; i++)
          for (let j = -1; j <= 1; j++) {
            const l = jg.get((cx + i) * 100003 + cz + j);
            if (!l) continue;
            for (const m of l) {
              if (m === n) continue;
              const e1 = ends.get(m)[0];
              if (Math.hypot(e1.x - e0.x, e1.z - e0.z) < JC) { const ra = find(n), rb = find(m); if (ra !== rb) par.set(ra, rb); }
            }
          }
      }
      const groups = new Map();
      for (const n of jn) {
        const r = find(n);
        let g = groups.get(r);
        if (!g) groups.set(r, (g = { nodes: new Set(), ends: [] }));
        g.nodes.add(n);
        g.ends.push(...ends.get(n));
      }
      const JA = [KIND.ASPHALT, 1 | (3 << 10), F.NOMARK, 1000], JJ = [0, 0, 99, 99]; // 亮度档 3：夜里远景光带与均匀照度同主干道
      for (const G of groups.values()) {
        // 去掉路口内部连接段（两端都在本路口里：双幅路两幅之间的短段）
        const g = G.ends.filter((e) => !G.nodes.has(e.other));
        if (g.length < 3) continue;
        let cx = 0, cz = 0, ymin = Infinity;
        for (const e of g) { cx += e.x; cz += e.z; if (e.y < ymin) ymin = e.y; }
        cx /= g.length; cz /= g.length;
        // 各进口：在“路口半径”处的左右路缘点（带该里程处路面高程：铺面随路面纵坡倾斜，不会在下坡一侧顶出路面）
        for (const e of g) {
          e.D = Math.min(Math.max(e.R, e.hw) + 0.5, 40);
          e.rx = -e.dz; e.rz = e.dx; // 指向方位角增大的一侧
          const fx = e.x + e.dx * e.D, fz = e.z + e.dz * e.D;
          e.yf = roadY(terrain, e.f, fx, fz, Math.min(Math.max(e.s + e.sg * e.D, 0), e.tot), e.tot) ?? e.y;
          e.fx = fx; e.fz = fz;
          e.ang = Math.atan2(fz - cz, fx - cx);
        }
        g.sort((a, b) => a.ang - b.ang);
        const poly = [];
        for (let k = 0; k < g.length; k++) {
          const e = g[k], n2 = g[(k + 1) % g.length];
          poly.push([e.fx - e.rx * e.hw, e.fz - e.rz * e.hw, e.yf], [e.fx + e.rx * e.hw, e.fz + e.rz * e.hw, e.yf]);
          // 转角：本进口“方位角增大一侧”的路缘线与下一进口另一侧路缘线的交点（两线近乎平行时直接相连）
          const ax = e.x + e.rx * e.hw, az = e.z + e.rz * e.hw, bx = n2.x - n2.rx * n2.hw, bz = n2.z - n2.rz * n2.hw;
          const den = e.dx * n2.dz - e.dz * n2.dx;
          if (Math.abs(den) < 0.2) continue;
          const wx = bx - ax, wz = bz - az;
          const t = (wx * n2.dz - wz * n2.dx) / den, u = (wx * e.dz - wz * e.dx) / den;
          if (t < -3 || u < -3 || t > e.D + 2 || u > n2.D + 2) continue;
          poly.push([ax + e.dx * t, az + e.dz * t, (e.y + n2.y) / 2]);
        }
        let area = 0, diam = 0;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          area += a[0] * b[1] - b[0] * a[1];
          diam = Math.max(diam, Math.hypot(a[0] - cx, a[1] - cz));
        }
        area = Math.abs(area) / 2;
        // 立交、环岛、大广场之类的大面会盖住绿地/建筑：只铺普通平面交叉口
        if (poly.length < 3 || area > 9000 || diam > 75) continue;
        const w = getTile(tileKey(cx, cz, T_MAJOR, 'm'), T_MAJOR, cx, cz, false);
        w.ensure(poly.length + 1, poly.length * 3);
        // 扇形三角化（路口多边形对中心是星形的）；每个三角形按朝上定绕序
        const c0 = w.v(cx, ymin - 0.04, cz, 0, 1, 0, 0.5, 0, JA, JJ);
        for (const a of poly) w.v(a[0], Math.min(a[2], ymin + 1.5) - 0.04, a[1], 0, 1, 0, 0.5, 0, JA, JJ);
        for (let i = 0; i < poly.length; i++) {
          const a = c0 + 1 + i, b = c0 + 1 + ((i + 1) % poly.length);
          const A = poly[i], B = poly[(i + 1) % poly.length];
          const ny = (A[1] - cz) * (B[0] - cx) - (A[0] - cx) * (B[1] - cz);
          if (ny > 0) w.tri(c0, a, b); else w.tri(c0, b, a);
        }
        kindTris.j = (kindTris.j || 0) + poly.length;
        nJunc++;
      }
    }
    console.warn(`[roads] 分隔带 ${JSON.stringify(medStat)}`);
    console.warn(`[roads] 路口铺面 ${nJunc} 处，${(performance.now() - T6).toFixed(0)} ms；路段人行横道贴花 ${nMidDecal}、人行道坡道 ${nRamp}、人行道宽度探测 ${tProbe.toFixed(0)} ms`);

    // ================= 铁路 =================
    console.warn('[roads] secs ' + JSON.stringify(DS) + ' km ' + JSON.stringify(DL));
    const T2 = performance.now();
    const dbg = { roadStruct: structTris(), roadPiers: piers.length / 10 };
    const rail = buildRailNet(ctx.data.rail);
    const masts = [];
    const mastHash = new Set();
    let nRail = 0;
    for (const r of rail) {
      const p = r.p, ch = r.ch, tot = r.total;
      const [mx, mz] = pointAt(p, ch, tot / 2);
      const core = inCore(mx, mz);
      const sub = r.cls !== 'rail';
      const hasLift = !!r.liftAt;
      const flatStep = core ? 40 : 90;
      // 抬升变化处加密（引桥/路堤过渡），平直段粗采样
      const stepFn = hasLift
        ? (s) => {
            const S = r.rev ? r.chainA + (tot - s) : r.chainA + s;
            const d = Math.abs(r.liftAt(S + 20) - r.liftAt(S)) + Math.abs(r.liftAt(S + flatStep) - r.liftAt(S));
            return d > 0.15 ? 12 : flatStep;
          }
        : () => flatStep;
      const T = core ? T_MAJOR : T_FAR;
      const tag = core ? 'm' : 'f';
      const secs = sampleSections(p, ch, 0, tot, stepFn, { x0: G0, z0: G0, T });
      if (!secs) continue;
      nRail++;
      const nS = secs.n;
      const ys = new Float32Array(nS), lifts = new Float32Array(nS), ground = new Float32Array(nS), valid = new Uint8Array(nS);
      for (let i = 0; i < nS; i++) {
        const S = r.rev ? r.chainA + (tot - secs.s[i]) : r.chainA + secs.s[i];
        const lift = hasLift ? r.liftAt(S) : 0;
        ground[i] = terrain.heightAt(secs.x[i], secs.z[i]);
        lifts[i] = lift;
        ys[i] = ground[i] + 0.45 + lift;
        valid[i] = excluded(secs.x[i], secs.z[i]) ? 0 : 1;
      }
      // 道砟路基（低于 2.5 m 的段）与高架箱梁（高于 2.5 m）分段
      const elev = new Uint8Array(nS);
      for (let i = 0; i < nS; i++) elev[i] = lifts[i] > 2.5 ? 1 : 0;
      const vGround = new Uint8Array(nS), vElev = new Uint8Array(nS);
      for (let i = 0; i < nS; i++) {
        const e0 = elev[i], e1 = i + 1 < nS ? elev[i + 1] : e0, em = i > 0 ? elev[i - 1] : e0;
        vGround[i] = valid[i] && (!e0 || !e1 || !em) ? 1 : 0;
        vElev[i] = valid[i] && (e0 || e1 || em) ? 1 : 0;
      }
      const hsr = r.hsr;
      const slabKind = hsr || sub ? KIND_SLAB : KIND.BALLAST;
      // —— 地面：道砟路堤 ——
      runs(secs, vGround, T, tag, (key, kx, kz, iA, iB) => {
        const w = getTile(key, T, kx, kz, false);
        // 路堤边坡外缘贴地：按平均抬升估算坡脚宽
        let lm = 0;
        for (let i = iA; i <= iB; i++) lm = Math.max(lm, lifts[i]);
        const toe = 2.7 + lm * 1.5;
        const drop = -0.55 - lm;
        attr[0] = KIND.BALLAST; attr[1] = 0; attr[2] = 0; attr[3] = 360;
        band(w, secs, iA, iB, ys, [{ o: toe, dy: drop, u: toe }, { o: 1.75, dy: 0, u: 1.75 }, { o: -1.75, dy: 0, u: -1.75 }, { o: -toe, dy: drop, u: -toe }], TOP, attr, null);
        if (core) railsBand(subTileAt(kx, kz), secs, iA, iB, ys, 0.02);
      });
      // —— 高架：箱梁/U 梁 + 轨道板 + 桥墩 ——
      const Wd = hsr ? 6.6 : sub ? 5.4 : 5.8;
      const Dg = hsr ? 3.0 : sub ? 1.9 : 2.4;
      const hwd = Wd / 2;
      runs(secs, vElev, T, tag, (key, kx, kz, iA, iB) => {
        const w = getTile(key, T, kx, kz, false);
        attr[0] = slabKind; attr[1] = 0; attr[2] = 0; attr[3] = Math.round(Wd * 100);
        band(w, secs, iA, iB, ys, [{ o: hwd - 0.3, dy: 0, u: hwd - 0.3 }, { o: -hwd + 0.3, dy: 0, u: -hwd + 0.3 }], TOP, attr, null);
        if (core) railsBand(subTileAt(kx, kz), secs, iA, iB, ys, 0.02);
        // 梁体（结构写入器）
        const prof = core
          ? [
              [-hwd + 0.3, 0], [-hwd + 0.3, 0.9], [-hwd, 0.9], [-hwd, -0.35], [-hwd * 0.55, -Dg],
              [hwd * 0.55, -Dg], [hwd, -0.35], [hwd, 0.9], [hwd - 0.3, 0.9], [hwd - 0.3, 0],
            ]
          : [[-hwd + 0.3, 0.9], [-hwd, 0.9], [-hwd * 0.6, -Dg], [hwd * 0.6, -Dg], [hwd, 0.9], [hwd - 0.3, 0.9]];
        const n = prof.length;
        const SW = swAt(kx, kz);
        SW.ensure((iB - iA + 1) * (n - 1) * 2, (iB - iA) * (n - 1) * 6);
        let prevBase = -1;
        for (let i = iA; i <= iB; i++) {
          const cx = secs.x[i], cz = secs.z[i], rx = secs.rx[i], rz = secs.rz[i];
          const rl = Math.hypot(rx, rz) || 1;
          const ux = -rx / rl, uz = -rz / rl;
          const base = SW.n;
          for (let k = 0; k < n - 1; k++) {
            const [o0, d0] = prof[k], [o1, d1] = prof[k + 1];
            const y0 = Math.max(ys[i] + d0, d0 < 0 ? ground[i] : -1e9), y1 = Math.max(ys[i] + d1, d1 < 0 ? ground[i] : -1e9);
            const to = o1 - o0, ty = d1 - d0;
            const L = Math.hypot(to, ty) || 1;
            const no = ty / L, nyv = -to / L;
            const sh = d0 < -0.3 && d1 < -0.3 ? 165 : 212;
            const col = [sh, sh - 1, sh - 4, 0];
            SW.v(cx - rx * o0, y0, cz - rz * o0, ux * no, nyv, uz * no, secs.s[i], d0 + o0, col);
            SW.v(cx - rx * o1, y1, cz - rz * o1, ux * no, nyv, uz * no, secs.s[i], d1 + o1, col);
          }
          if (prevBase >= 0)
            for (let k = 0; k < n - 1; k++) {
              const a0 = prevBase + k * 2, a1 = a0 + 1, b0 = base + k * 2, b1 = b0 + 1;
              SW.tri(a0, a1, b0);
              SW.tri(a1, b1, b0);
            }
          prevBase = base;
        }
      });
      // 接触网支柱（核心区电气化干线，50 m 一根，立在线路右侧）
      if (core && !sub && valid.length) {
        for (let s = 25; s < tot; s += 50) {
          const [x, z, dx, dz] = pointAt(p, ch, s);
          if (excluded(x, z)) continue;
          const S = r.rev ? r.chainA + (tot - s) : r.chainA + s;
          const lift = hasLift ? r.liftAt(S) : 0;
          const off = lift > 2.5 ? hwd - 0.5 : 2.9;
          const mx2 = x - dz * off, mz2 = z + dx * off;
          const k = Math.round(mx2 / 4) + ':' + Math.round(mz2 / 4);
          if (mastHash.has(k)) continue;
          mastHash.add(k);
          masts.push(mx2, terrain.heightAt(x, z) + 0.45 + lift, mz2, Math.atan2(dx, dz));
        }
      }
      // 桥墩（跨径 32 m；平行股道去重）
      if (hasLift) {
        const SP = hsr ? 32 : 30;
        for (let s = SP / 2; s < tot; s += SP) {
          const S = r.rev ? r.chainA + (tot - s) : r.chainA + s;
          const lift = r.liftAt(S);
          if (lift - Dg < 2.2) continue;
          const [x, z, dx, dz] = pointAt(p, ch, s);
          if (excluded(x, z)) continue;
          const g = terrain.heightAt(x, z);
          const top = g + 0.45 + lift - Dg;
          const yaw = Math.atan2(dx, dz);
          if (hsr) addPier(x, z, top, yaw, 4.2, 2.2, 5.6, 1.6, 3.0, 12);
          else addPier(x, z, top, yaw, sub ? 1.6 : 2.2, sub ? 1.6 : 1.8, Wd * 0.8, 1.3, 2.2, 8);
        }
      }
    }
    function railsBand(w, secs, iA, iB, ys, dy) {
      const hr = 0.036, H = 0.17;
      attr[0] = KIND.RAIL; attr[1] = 0; attr[2] = 0; attr[3] = 10;
      for (const l of [0.7175, -0.7175]) {
        // 左侧面（朝 +o）→ 顶 → 右侧面
        band(w, secs, iA, iB, ys, [{ o: l + hr, dy: dy + H, u: 1 }, { o: l - hr, dy: dy + H, u: 1 }], TOP, attr, null);
        band(w, secs, iA, iB, ys, [{ o: l + hr, dy: dy, u: 0 }, { o: l + hr, dy: dy + H, u: 0.3 }], [-1, 0], attr, null);
        band(w, secs, iA, iB, ys, [{ o: l - hr, dy: dy + H, u: 0.3 }, { o: l - hr, dy: dy, u: 0 }], [1, 0], attr, null);
      }
    }

    const T3 = performance.now();
    dbg.railStruct = structTris() - dbg.roadStruct;
    dbg.kinds = Object.fromEntries(Object.entries(kindTris).map(([k, v]) => [k, Math.round(v / 1000) + 'k']));
    dbg.structTiles = sTiles.size;
    dbg.railPiers = piers.length / 10 - dbg.roadPiers;
    dbg.tiles = {};
    for (const [key, t] of tiles) dbg.tiles[key[0]] = (dbg.tiles[key[0]] || 0) + t.w.ni / 3;
    console.warn('[roads] dbg ' + JSON.stringify(dbg));
    // ================= 网格 → 网格体 =================
    const surfMat = createSurfaceMaterial(ctx, { name: 'roadSurface' });
    surfMat.envMapIntensity = 0.12;
    ctx.overlay(surfMat, 0.0004);
    const minorTiles = [], subTiles = [], farTiles = [], majorTiles = [];
    let tris = 0;
    for (const [key, t] of tiles) {
      const g = t.w.geometry();
      if (!g) continue;
      tris += t.w.ni / 3;
      const m = new THREE.Mesh(g, surfMat);
      m.name = '路面-' + key;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.renderOrder = -1;
      root.add(m);
      if (t.minor === 'sub') subTiles.push({ mesh: m, cx: t.cx, cz: t.cz });
      else if (t.minor) minorTiles.push({ mesh: m, cx: t.cx, cz: t.cz });
      else if (key[0] === 'f') farTiles.push({ mesh: m, cx: t.cx, cz: t.cz });
      else if (key[0] === 'm') majorTiles.push({ mesh: m, cx: t.cx, cz: t.cz });
    }
    // 结构物：按 2.5 km 分块（视锥裁剪；阴影只给相机附近的块，见 updateLOD）
    const concMap = ctx.mats.get('concrete').map;
    const structMat = createStructMaterial(ctx, concMap);
    const structMeshes = []; // {mesh, cx, cz, r}
    for (const [key, t] of sTiles) {
      const g = t.w.geometry();
      if (!g) continue;
      tris += t.w.ni / 3;
      const m = new THREE.Mesh(g, structMat);
      m.name = '桥梁与高架结构-' + key;
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      root.add(m);
      const bs = g.boundingSphere;
      structMeshes.push({ mesh: m, cx: bs.center.x, cz: bs.center.z, r: bs.radius });
    }
    // 桥墩（实例化，只显示相机附近：远处细柱子亚像素）：近处一组投射阴影、完整圆柱；远处一组低模不投影
    const nP = piers.length / 10;
    const PCELL = 1000;
    const pierCells = new Map();
    for (let i = 0; i < nP; i++) {
      const k = Math.floor(piers[i * 10] / PCELL) * 100003 + Math.floor(piers[i * 10 + 2] / PCELL);
      let a = pierCells.get(k);
      if (!a) pierCells.set(k, (a = []));
      a.push(i);
    }
    const PCAP = 14000;
    const pierMat = new THREE.MeshStandardMaterial({ color: 0x8a867e, roughness: 0.88 });
    pierMat.onBeforeCompile = patchShadowBias; // 桥墩受光同样用方向正确的阴影偏移（见 roads_shader.js）
    pierMat.customProgramCacheKey = () => 'roadPier|v1';
    const colG = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, true);
    colG.translate(0, 0.5, 0);
    const colGLow = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true);
    colGLow.translate(0, 0.5, 0);
    const capG = new THREE.BoxGeometry(1, 1, 1);
    capG.translate(0, 0.5, 0);
    const mkPier = (geo, shadow, name) => {
      const im = new THREE.InstancedMesh(geo, pierMat, PCAP);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = shadow;
      im.receiveShadow = true;
      im.name = name;
      root.add(im);
      return im;
    };
    const pierCols = mkPier(colG, true, '桥墩柱'), pierCaps = mkPier(capG, true, '桥墩盖梁');
    const pierColsFar = mkPier(colGLow, false, '桥墩柱-远'), pierCapsFar = mkPier(capG, false, '桥墩盖梁-远');
    const pierSets = [[pierCols, pierCaps], [pierColsFar, pierCapsFar]];
    const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _sc = new THREE.Vector3(), _ps = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    // 接触网支柱实例（H 型钢柱 + 腕臂），与桥墩同步按距离刷新
    const nM = masts.length / 4;
    const mastCells = new Map();
    for (let i = 0; i < nM; i++) {
      const k = Math.floor(masts[i * 4] / PCELL) * 100003 + Math.floor(masts[i * 4 + 2] / PCELL);
      let a = mastCells.get(k);
      if (!a) mastCells.set(k, (a = []));
      a.push(i);
    }
    const mastGeo = (() => {
      const parts = [];
      const add = (w, h, d, x, y, z) => {
        const g = new THREE.BoxGeometry(w, h, d);
        g.translate(x, y, z);
        g.deleteAttribute('uv');
        parts.push(g);
      };
      add(0.3, 8.6, 0.3, 0, 4.3, 0); // 支柱（局部 +X 指向线路）
      add(3.4, 0.08, 0.08, 1.7, 7.6, 0); // 平腕臂
      add(3.6, 0.07, 0.07, 1.6, 6.9, 0); // 斜腕臂
      add(0.1, 0.9, 0.1, 3.0, 7.2, 0); // 吊弦/定位
      add(0.5, 0.5, 0.35, 0, 0.25, 0); // 基础
      return mergeGeometries(parts);
    })();
    const MCAP = 6000;
    const mastMesh = new THREE.InstancedMesh(mastGeo, new THREE.MeshStandardMaterial({ color: 0x6f7378, metalness: 0.6, roughness: 0.5 }), MCAP);
    mastMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mastMesh.count = 0;
    mastMesh.frustumCulled = false;
    mastMesh.castShadow = true;
    root.add(mastMesh);
    function refreshMasts(cx, cz, R) {
      let n = 0;
      const R2 = R * R;
      for (let gx = Math.floor((cx - R) / PCELL); gx <= Math.floor((cx + R) / PCELL); gx++)
        for (let gz = Math.floor((cz - R) / PCELL); gz <= Math.floor((cz + R) / PCELL); gz++) {
          const a = mastCells.get(gx * 100003 + gz);
          if (!a) continue;
          for (const i of a) {
            if (n >= MCAP) break;
            const x = masts[i * 4], z = masts[i * 4 + 2];
            if ((x - cx) ** 2 + (z - cz) ** 2 > R2) continue;
            _q.setFromAxisAngle(_up, masts[i * 4 + 3]);
            _m4.compose(_ps.set(x, masts[i * 4 + 1], z), _q, _sc.set(1, 1, 1));
            mastMesh.setMatrixAt(n++, _m4);
          }
        }
      mastMesh.count = n;
      mastMesh.visible = n > 0;
      mastMesh.instanceMatrix.needsUpdate = true;
    }
    function refreshPiers(cx, cz, R, Rnear) {
      const n = [0, 0];
      const R2 = R * R, Rn2 = Rnear * Rnear;
      const c0x = Math.floor((cx - R) / PCELL), c1x = Math.floor((cx + R) / PCELL);
      const c0z = Math.floor((cz - R) / PCELL), c1z = Math.floor((cz + R) / PCELL);
      for (let gx = c0x; gx <= c1x; gx++)
        for (let gz = c0z; gz <= c1z; gz++) {
          const a = pierCells.get(gx * 100003 + gz);
          if (!a) continue;
          for (const i of a) {
            const o = i * 10;
            const x = piers[o], g = piers[o + 1], z = piers[o + 2], h = piers[o + 3];
            const d2 = (x - cx) ** 2 + (z - cz) ** 2;
            if (d2 > R2) continue;
            const s = d2 < Rn2 ? 0 : 1;
            const k = n[s];
            if (k >= PCAP) continue;
            _q.setFromAxisAngle(_up, piers[o + 4]);
            _m4.compose(_ps.set(x, g, z), _q, _sc.set(piers[o + 5], h, piers[o + 6]));
            pierSets[s][0].setMatrixAt(k, _m4);
            _m4.compose(_ps.set(x, g + h, z), _q, _sc.set(piers[o + 7], piers[o + 8], piers[o + 9]));
            pierSets[s][1].setMatrixAt(k, _m4);
            n[s]++;
          }
        }
      for (let s = 0; s < 2; s++)
        for (const im of pierSets[s]) {
          im.count = n[s];
          im.visible = n[s] > 0;
          im.instanceMatrix.needsUpdate = true;
        }
      return n[0] + n[1];
    }

    // ================= 路灯 =================
    const T4 = performance.now();
    const lamps = placeLamps(net, terrain, roadY, {
      region: lampRegion,
      LIFT,
      edgeFilter: (E) => E.rendered,
      // 支路灯不立进片区自建建筑/地标范围（排除区里“让树”的都是实体占地）
      minorOk: (x, z) => !(excl && excl.items && excl.items.length && excl.test(x, z, 'trees')),
      urban,
    });
    const lampGeo = lampGeometries();
    const lampMat = lampMaterial(ctx);
    const types = [LAMP.SINGLE, LAMP.DOUBLE, LAMP.KNOT, LAMP.KNOT2, LAMP.PALACE, LAMP.LANTERN];
    const CELL = 400;
    const cellMap = new Map();
    for (let i = 0; i < lamps.n; i++) {
      if (excluded(lamps.x[i], lamps.z[i])) { lamps.type[i] = 255; continue; }
      const k = Math.floor(lamps.x[i] / CELL) * 100003 + Math.floor(lamps.z[i] / CELL);
      let a = cellMap.get(k);
      if (!a) cellMap.set(k, (a = []));
      a.push(i);
    }
    const CAP = 9000;
    const lampGeoLow = lampGeometriesLow(lampGeo);
    const inst = {}, instFar = {}; // 近处完整灯型 / 远处低模（杆 + 灯头盒）
    for (const t of types) {
      const mk = (geo, name) => {
        const im = new THREE.InstancedMesh(geo, lampMat, CAP);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = false;
        im.name = name;
        root.add(im);
        return im;
      };
      inst[t] = mk(lampGeo[t].geo, '路灯-' + t);
      instFar[t] = mk(lampGeoLow[t], '路灯远-' + t);
    }
    // 远景灯头光点
    let nPts = 0;
    for (let i = 0; i < lamps.n; i++) if (lamps.type[i] !== 255) nPts += lampGeo[lamps.type[i]].head.length;
    const pPos = new Float32Array(nPts * 3), pCol = new Float32Array(nPts * 3);
    {
      let k = 0;
      const COLS = {
        [LAMP.SINGLE]: [1.0, 0.64, 0.33], [LAMP.DOUBLE]: [1.0, 0.66, 0.36], [LAMP.KNOT]: [1.0, 0.7, 0.42], [LAMP.KNOT2]: [1.0, 0.7, 0.42],
        [LAMP.PALACE]: [1.0, 0.58, 0.24], [LAMP.LANTERN]: [1.0, 0.64, 0.33],
      };
      // 远景光点亮度按道路等级拉开层级：快速路/主干道 1、次干道 0.62、支路 0.32（原 1/0.85/0.7，全城灯点一样亮）
      const LVLB = [0.32, 0.32, 0.62, 1.0];
      for (let i = 0; i < lamps.n; i++) {
        const t = lamps.type[i];
        if (t === 255) continue;
        const c = Math.cos(lamps.yaw[i]), s = Math.sin(lamps.yaw[i]);
        const heads = lampGeo[t].head;
        for (let h = 0; h < heads.length; h++) {
          const [hx, hy, hz] = heads[h];
          pPos[k * 3] = lamps.x[i] + c * hx + s * hz;
          pPos[k * 3 + 1] = lamps.y[i] + hy;
          pPos[k * 3 + 2] = lamps.z[i] - s * hx + c * hz;
          const red = lampHeadRed(t, h);
          const cc = red ? [0.5, 0.06, 0.035] : COLS[t];
          const b = lamps.lvl ? LVLB[lamps.lvl[i]] : 1;
          pCol[k * 3] = cc[0] * b; pCol[k * 3 + 1] = cc[1] * b; pCol[k * 3 + 2] = cc[2] * b;
          k++;
        }
      }
    }
    const T5 = performance.now();
    console.warn(`[roads] 计时 net ${(T1 - T0).toFixed(0)} 路面 ${(T2 - T1).toFixed(0)} 铁路 ${(T3 - T2).toFixed(0)} 网格体 ${(T4 - T3).toFixed(0)} 路灯 ${(T5 - T4).toFixed(0)}`);
    const ptsGeo = new THREE.BufferGeometry();
    ptsGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    ptsGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
    ptsGeo.computeBoundingSphere();
    const ptsMat = lampPointsMaterial(ctx);
    const points = new THREE.Points(ptsGeo, ptsMat);
    points.name = '路灯光点';
    points.frustumCulled = false;
    points.renderOrder = 5;
    root.add(points);

    // ================= 标注（≤6） =================
    for (const [n, x, z] of [['西安站', 1400, -1830], ['西安北站', -771, -12985]]) {
      ctx.labels.add(n, new THREE.Vector3(x, terrain.heightAt(x, z) + 30, z), { category: 'station', minDist: 200, maxDist: 14000, priority: 0.9 });
    }

    // ================= LOD / 更新 =================
    const cam = ctx.camera;
    let qLvl = lvl;
    let lampR = LAMP_R[qLvl], lampNearR = LAMP_NEAR_R[qLvl], minorR = MINOR_R[qLvl], pierR = PIER_R[qLvl];
    let lastX = 1e9, lastZ = 1e9, lastR = 0, lastY = 1e9, lastPX = 1e9, lastPZ = 1e9, lastSX = 1e9, lastSZ = 1e9, lastSY = 1e9;
    const e = new Float32Array(16);
    let dbgFrame = 0;
    function refreshLamps(cx, cz, agl) {
      const counts = {}, countsFar = {};
      for (const t of types) (counts[t] = 0), (countsFar[t] = 0);
      if (agl < 1400) {
        const R = lampR, R2 = R * R, Rn2 = lampNearR * lampNearR;
        const c0x = Math.floor((cx - R) / CELL), c1x = Math.floor((cx + R) / CELL);
        const c0z = Math.floor((cz - R) / CELL), c1z = Math.floor((cz + R) / CELL);
        for (let gx = c0x; gx <= c1x; gx++)
          for (let gz = c0z; gz <= c1z; gz++) {
            const a = cellMap.get(gx * 100003 + gz);
            if (!a) continue;
            for (const i of a) {
              const dx = lamps.x[i] - cx, dz = lamps.z[i] - cz;
              const d2 = dx * dx + dz * dz;
              if (d2 > R2) continue;
              const t = lamps.type[i];
              const near = d2 < Rn2;
              const im = near ? inst[t] : instFar[t];
              const cnt = near ? counts : countsFar;
              const k = cnt[t];
              if (k >= CAP) continue;
              const c = Math.cos(lamps.yaw[i]), s = Math.sin(lamps.yaw[i]);
              const arr = im.instanceMatrix.array;
              const o = k * 16;
              arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -s; arr[o + 3] = 0;
              arr[o + 4] = 0; arr[o + 5] = 1; arr[o + 6] = 0; arr[o + 7] = 0;
              arr[o + 8] = s; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
              arr[o + 12] = lamps.x[i]; arr[o + 13] = lamps.y[i]; arr[o + 14] = lamps.z[i]; arr[o + 15] = 1;
              cnt[t] = k + 1;
            }
          }
      }
      for (const t of types)
        for (const [im, n] of [[inst[t], counts[t]], [instFar[t], countsFar[t]]]) {
          im.count = n;
          im.visible = n > 0;
          if (n) {
            im.instanceMatrix.clearUpdateRanges();
            im.instanceMatrix.addUpdateRange(0, n * 16);
            im.instanceMatrix.needsUpdate = true;
          }
        }
    }
    // 桥梁结构块：显示半径 + 只有近处的块投射阴影（阴影贴图范围本就只有相机周围几百米到几公里）
    function refreshStructs(cx, cz, agl) {
      const sr = shadowReach(ctx, STRUCT_SHADOW_R[qLvl], 25), vr = STRUCT_R[qLvl];
      for (const s of structMeshes) {
        const d = Math.hypot(s.cx - cx, s.cz - cz) - s.r;
        s.mesh.visible = Math.hypot(Math.max(0, d), agl) < vr;
        s.mesh.castShadow = d < sr;
      }
    }
    function updateLOD(force) {
      const cx = cam.position.x, cz = cam.position.z;
      const agl = cam.position.y - terrain.heightAt(cx, cz);
      const moved = Math.hypot(cx - lastX, cz - lastZ);
      if (force || Math.hypot(cx - lastPX, cz - lastPZ) > 350) {
        refreshPiers(cx, cz, pierR, shadowReach(ctx, PIER_SHADOW_R[qLvl], 20));
        refreshMasts(cx, cz, Math.min(pierR, MAST_R[qLvl]));
        lastPX = cx; lastPZ = cz;
      }
      if (force || Math.hypot(cx - lastSX, cz - lastSZ) > 150 || Math.abs(agl - lastSY) > 150) {
        refreshStructs(cx, cz, agl);
        lastSX = cx; lastSZ = cz; lastSY = agl;
      }
      if (force || moved > lampNearR * 0.25 || Math.abs(agl - lastY) > 150 || lastR !== lampR) {
        refreshLamps(cx, cz, agl);
        lastX = cx; lastZ = cz; lastY = agl; lastR = lampR;
      }
      const vis = agl < 3000;
      for (const t of minorTiles) {
        const d = Math.max(Math.abs(t.cx - cx), Math.abs(t.cz - cz)) - T_MINOR / 2;
        t.mesh.visible = vis && d < minorR;
      }
      // 人行道/路缘石/分隔带/钢轨：只在相机附近显示（远处亚像素）
      const subR = SUB_R[qLvl];
      for (const t of subTiles) {
        const d = Math.max(Math.abs(t.cx - cx), Math.abs(t.cz - cz)) - T_SUB / 2;
        t.mesh.visible = agl < 2500 && d < subR;
      }
      // 核心区外路面 / 核心区主要道路：低/中画质只显示相机附近（三维距离）的分块，远处与高空俯视由影像表现
      const farR = FAR_TILE_R[qLvl], majorR = MAJOR_TILE_R[qLvl];
      if (farR < 1e8)
        for (const t of farTiles) {
          const d = Math.max(0, Math.max(Math.abs(t.cx - cx), Math.abs(t.cz - cz)) - T_FAR / 2);
          t.mesh.visible = Math.hypot(d, agl) < farR;
        }
      else for (const t of farTiles) t.mesh.visible = true;
      if (majorR < 1e8)
        for (const t of majorTiles) {
          const d = Math.max(0, Math.max(Math.abs(t.cx - cx), Math.abs(t.cz - cz)) - T_MAJOR / 2);
          t.mesh.visible = Math.hypot(d, agl) < majorR;
        }
      else for (const t of majorTiles) t.mesh.visible = true;
    }
    updateLOD(true);
    const hFov = () => cam.fov;
    const renderer = ctx.renderer;
    const sz = new THREE.Vector2();

    console.warn(
      `[roads] 景区步行化支路 ${nPark}，边 ${nEdges}/${edges.length}，铁路 ${nRail}，分块 ${tiles.size}，三角形 ${(tris / 1e6).toFixed(2)}M，桥墩 ${nP}，路灯 ${lamps.n}，光点 ${nPts}，耗时 ${(performance.now() - t0).toFixed(0)} ms`
    );

    return {
      update(dt, t) {
        updateLOD(false);
        if (++dbgFrame === 90) {
          // 调试：统计本模块视锥内的 draw call（主通道 + 阴影通道）
          const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
          let main = 0, sh = 0;
          const byName = {};
          root.traverse((o) => {
            if (!o.visible || !(o.isMesh || o.isPoints)) return;
            if (o.isInstancedMesh && o.count === 0) return;
            if (o.frustumCulled && o.geometry.boundingSphere && !fr.intersectsSphere(o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld))) return;
            main++;
            if (o.castShadow) sh++;
            const k = o.name.split('-')[0];
            byName[k] = (byName[k] || 0) + 1;
          });
          console.warn(`[roads] drawcalls 主 ${main} 阴影 ${sh} ${JSON.stringify(byName)}`);
        }
        const night = ctx.uniforms.uNight.value;
        points.visible = night > 0.03;
        if (points.visible) {
          renderer.getDrawingBufferSize(sz);
          ptsMat.uniforms.uScale.value = sz.y / (2 * Math.tan((hFov() * Math.PI) / 360));
          if (ctx.scene.fog) ptsMat.uniforms.uFog.value = ctx.scene.fog.density || 3e-5;
        }
      },
      setQuality(q) {
        qLvl = Math.max(0, Math.min(3, q.level ?? qLvl));
        lampR = LAMP_R[qLvl];
        lampNearR = LAMP_NEAR_R[qLvl];
        minorR = MINOR_R[qLvl];
        pierR = PIER_R[qLvl];
        updateLOD(true);
      },
      setLayer(name, on) {
        if (name === 'roads') root.visible = on;
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};
