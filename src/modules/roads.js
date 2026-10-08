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
import { buildRoadNet, placeLamps, buildRailNet, lampStyleFor, pairGapAt, markParkWalkways, F, KIND, LAMP } from '../arch/roads_net.js';
import { SurfWriter, StructWriter, sampleSections } from '../arch/roads_mesh.js';
import { createSurfaceMaterial, createStructMaterial } from '../arch/roads_shader.js';
import { lampGeometries, lampGeometriesLow, lampMaterial, lampPointsMaterial } from '../arch/roads_lamps.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shadowReach } from '../arch/perf-lod.js';

const LAMPL = 2048, LAMPR = 4096, LAMPM = 8192;
const KIND_SLAB = 6, KIND_MEDIAN = 3, KIND_HEDGE = 8, KIND_FENCE = 9;
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

export default {
  id: 'roads',
  name: '道路与轨道交通',

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

    // —— 网络 ——
    const T0 = performance.now();
    // 景区/公园里的无名支路（寺院甬道、园路）按步行道画：石板铺装、不布路灯（traffic 同一规则不跑车）
    const nPark = markParkWalkways(ctx.data.roads, ctx.data.landuse);
    const net = buildRoadNet(ctx.data.roads, { inDetail: inCore });
    const T1 = performance.now();
    const { edges, feats, info, chain, total } = net;
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
    function band(W, secs, iA, iB, ys, pts, nrm, attr, E) {
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
          W.v(cx - rx * p.o, ys[i] + p.dy, cz - rz * p.o, nx, ny, nz, p.u, secs.s[i], attr, JUNC);
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
      for (let i = 0; i < secs.n; i++) {
        const y = roadY(terrain, f, secs.x[i], secs.z[i], secs.s[i], tot);
        ys[i] = y === null ? 0 : y;
        valid[i] = y !== null && !excluded(secs.x[i], secs.z[i]) ? 1 : 0;
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
      if (!cfg.lamp || !lampRegion(mx, mz, false)) return 0;
      if (f.c === 0) {
        if (!lampRegion(mx, mz, true)) return 0;
        if (E.flags & F.PAIRED) return E.gapMed > 0.5 && E.gapMed < 30 ? LAMPL : 0;
        return LAMPR;
      }
      let b = LAMPR;
      if (cfg.lampOne) return b; // 支路单侧灯
      if (E.flags & F.PAIRED) {
        if (E.gapMed > 1.2 && E.gapMed < 40 && !E.b) b |= LAMPL;
      } else {
        b |= LAMPL;
        if (!E.oneway && E.W >= 24 && !E.b) b |= LAMPM;
      }
      return b;
    }

    // ================= 道路 =================
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
        const keep = f.c <= 2 || f.c === 8 || f.c === 9 || f.c === 10 || (f.c === 3 && r2 < FAR_SECONDARY_R * FAR_SECONDARY_R);
        if (!keep) continue;
      }
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
      const secs = sampleSections(f.p, ch, sA, sB, stepFn, grid);
      if (!secs) continue;
      const { ys, valid } = sectionYs(secs, f, tot);
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
      // 断面只要左右两点：横向 UV 与世界坐标在着色器里都是线性插值，宽路中点纯属冗余（去掉后宽路三角形减半）
      const pts = cfg.paving ? [{ o: hw, dy: 0, u: 0 }, { o: -hw, dy: 0, u: W }] : [{ o: hw, dy: 0, u: 0 }, { o: -hw, dy: 0, u: 1 }];
      runs(secs, valid, T, tag, (key, kx, kz, iA, iB) => {
        band(getTile(key, T, kx, kz, minor), secs, iA, iB, ys, pts, TOP, attr, E);
      });
      nEdges++;

      // —— 人行道 + 路缘石（核心区、非桥、主要道路） ——
      if (core && cfg.sw > 0 && !isBridge && !cfg.link) {
        const sw = cfg.sw;
        for (const side of [1, -1]) {
          const on = side === 1 ? E.swR : E.swL;
          if (!on) continue;
          const rA = E.s0 + E.sw0 + 0.5, rB = E.s1 - E.sw1 - 0.5;
          if (rB - rA < 4) continue;
          const s2 = sampleSections(f.p, ch, rA, rB, stepFn, grid);
          if (!s2) continue;
          const y2 = sectionYs(s2, f, tot);
          const sideLamp = side === 1 ? lb & LAMPR : lb & (LAMPL | LAMPM) ? LAMPL : 0;
          attrS[1] = (sideLamp ? S << 4 : 0) | (lvl << 10);
          attrS[2] = sideLamp;
          attrS[3] = Math.round(sw * 100);
          const H = 0.15;
          const curb = side === 1 ? [{ o: -hw, dy: 0, u: 0 }, { o: -hw, dy: H, u: 0 }] : [{ o: hw, dy: H, u: 0 }, { o: hw, dy: 0, u: 0 }];
          const top = side === 1 ? [{ o: -hw, dy: H, u: 0 }, { o: -hw - sw, dy: H, u: sw }] : [{ o: hw + sw, dy: H, u: sw }, { o: hw, dy: H, u: 0 }];
          const cn = side === 1 ? [1, 0] : [-1, 0];
          runs(s2, y2.valid, T_SUB, 'w', (key, kx, kz, iA, iB) => {
            const w = getTile(key, T_SUB, kx, kz, 'sub');
            attrS[0] = KIND.CURB;
            band(w, s2, iA, iB, y2.ys, curb, cn, attrS, E);
            attrS[0] = KIND.SIDEWALK;
            band(w, s2, iA, iB, y2.ys, top, TOP, attrS, E);
          });
        }
      }
      // —— 中央分隔带（双幅路之间）：两幅各建靠自己一侧的一半，按断面处的局部中分带宽选型 ——
      if (core && (E.flags & F.PAIRED) && !isBridge) buildMedian(E, f, ch, tot, stepFn, grid, lb, S, lvl);
      // —— 桥梁：桥面板 + 护栏 + 箱梁 + 桥墩 ——
      if (isBridge) buildBridgeDeck(E, f, ch, tot, secs, ys, valid, core);
      // —— 被纵断面抬高的地面路段（引桥路堤/匝道）：两侧挡土墙，避免路面悬空露缝 ——
      else embankWalls(E, secs, ys, valid, cfg, swAt(mx, mz));
    }

    /**
     * 中央分隔带（实体构件，人眼高度有体积）。每幅路从自己的左路缘建到局部中分带中线（另一半由对向一幅建），
     * 中分带宽 g 逐断面用 pairGapAt 求（同一条边上宽度可从 0.2 m 变到 4 m）：
     *   g < 1.3 m：混凝土隔离墩 + 中线金属护栏（护栏面朝本幅，两幅各画一面）；
     *   1.3~12 m：花岗岩路缘 + 绿篱（箱形修剪灌木，高 0.7~0.85 m）；
     *   ≥ 12 m：宽绿化带只做路缘 + 1.5 m 宽的边缘绿篱，中间交给影像/植被。
     */
    function buildMedian(E, f, ch, tot, stepFn, grid, lb, S, lvl) {
      const rA = E.s0 + Math.max(E.R0 + 1.5, E.sw0 * 0.5, 1), rB = E.s1 - Math.max(E.R1 + 1.5, E.sw1 * 0.5, 1);
      if (rB - rA < 8) return;
      const s2 = sampleSections(f.p, ch, rA, rB, stepFn, grid);
      const backed = !!pairedBy.get(E.fi)?.has(E.pairF);
      if (!s2) return;
      const y2 = sectionYs(s2, f, tot);
      const n = s2.n, hw = E.W / 2;
      const gap = new Float32Array(n), type = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        const g = pairGapAt(net, E, s2.x[i], s2.z[i], s2.rx[i], s2.rz[i]);
        gap[i] = g ?? -1;
        type[i] = g === null || g < 0.25 || g > 70 ? -1 : g < 1.3 ? 0 : g < 12 ? 1 : 2;
        if (type[i] < 0) y2.valid[i] = 0;
      }
      attrS[1] = (lb & LAMPL ? S << 4 : 0) | (lvl << 10);
      attrS[2] = lb & LAMPL;
      const Hc = 0.18; // 路缘高
      const P = (k) => { const a = []; for (let j = 0; j < k; j++) a.push({ o: 0, dy: 0, u: 0 }); return a; };
      const p2 = P(2);
      // 按类型切成连续段（每个断面间隔取两端较宽的类型；类型变化处两段共用断面，不留缺口）
      const segT = (i) => (y2.valid[i] && y2.valid[i + 1] ? Math.max(type[i], type[i + 1]) : -1);
      for (let a = 0; a < n - 1; ) {
        const t = segT(a);
        let b = a + 1;
        while (b < n - 1 && segT(b) === t) b++;
        if (t >= 0) emit(t, a, b);
        a = b;
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
            // 隔离墩：从本幅路缘到中线，高 0.25 m；中线护栏 1.0 m
            const Hb = 0.25;
            attrS[3] = 30;
            face(KIND.CURB, [-1, 0], (i, q) => { q[0].o = hw; q[0].dy = Hb; q[1].o = hw; q[1].dy = 0; });
            face(KIND.CURB, TOP, (i, q) => { const c = hw + Math.max(gap[i] / 2, 0.2); q[0].o = c; q[0].dy = Hb; q[1].o = hw; q[1].dy = Hb; });
            face(KIND_FENCE, [-1, 0], (i, q) => {
              const c = hw + Math.max(gap[i] / 2, 0.2) - 0.02;
              q[0].o = c; q[0].dy = Hb + 1.0; q[0].u = 1.0; q[1].o = c; q[1].dy = Hb; q[1].u = 0;
            });
            return;
          }
          const Hh = t === 2 ? 0.6 : 0.7; // 绿篱高（路缘顶以上）
          const hedgeW = (i) => (t === 2 ? 1.5 : Math.max(gap[i] / 2, 0.36)); // 本幅一侧绿篱外缘到其内缘（中线）
          attrS[3] = Math.round(Math.min(gap[iA], 99) * 100);
          // 路缘立面 + 路缘顶（0.25 m 花岗岩）
          face(KIND.CURB, [-1, 0], (i, q) => { q[0].o = hw; q[0].dy = Hc; q[1].o = hw; q[1].dy = 0; });
          face(KIND_MEDIAN, TOP, (i, q) => { q[0].o = hw + 0.25; q[0].dy = Hc; q[0].u = 0.25; q[1].o = hw; q[1].dy = Hc; q[1].u = 0; });
          // 绿篱外侧面（略内收）、顶面
          face(KIND_HEDGE, [-0.99, 0.12], (i, q) => {
            q[0].o = hw + 0.32; q[0].dy = Hc + Hh; q[0].u = Hh;
            q[1].o = hw + 0.25; q[1].dy = Hc; q[1].u = 0;
          });
          face(KIND_HEDGE, TOP, (i, q) => {
            const e = hw + Math.min(hedgeW(i), Math.max(gap[i] / 2, 0.36));
            q[0].o = e; q[0].dy = Hc + Hh; q[0].u = Hh + e - hw;
            q[1].o = hw + 0.32; q[1].dy = Hc + Hh; q[1].u = Hh + 0.32;
          });
          // 段首段尾端面（路口处绿篱断开，不封口会看见空壳）
          for (const [i, sg] of [[A, -1], [B, 1]]) {
            const e = hw + Math.min(hedgeW(i), Math.max(gap[i] / 2, 0.36));
            endCap(w, s2, i, sg, hw, hw + 0.25, y2.ys[i], 0, Hc, KIND.CURB);
            endCap(w, s2, i, sg, hw + 0.25, e, y2.ys[i], t === 2 ? -0.3 : 0, Hc + Hh, KIND_HEDGE);
          }
          // 内侧面：宽带落到地面；窄带只在对向一幅没有配对回来时在中线处封口（不露空）
          if (t === 1 && backed) return;
          face(KIND_HEDGE, [1, 0], (i, q) => {
            const e = hw + Math.min(hedgeW(i), Math.max(gap[i] / 2, 0.36));
            q[0].o = e; q[0].dy = t === 2 ? -0.3 : 0; q[0].u = 0;
            q[1].o = e; q[1].dy = Hc + Hh; q[1].u = Hh;
          });
        });
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
    function bandF(W, secs, iA, iB, ys, pts, fill, nrm, attr, E) {
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
        for (let k = 0; k < np; k++) {
          const p = pts[k];
          W.v(cx - rx * p.o, ys[i] + p.dy, cz - rz * p.o, nx, ny, nz, p.u, secs.s[i], attr, JUNC);
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
        const oo = -side * (hw + (swOn ? cfg.sw : 0) + 0.05);
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
    // 把核心区地面主路的路口节点按 35 m 聚类（双幅路交叉口是 4 个节点），取各进口在“路口半径”处的左右路缘点
    // 求凸包，铺一块沥青（无标线、比路面低 4 cm：条带处条带在上，缺口处露出铺面）。
    const T6 = performance.now();
    let nJunc = 0;
    {
      const ends = new Map(); // node -> [{x,z,dx,dz,hw,R,y}]
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
          a.push({ x, z, dx: dx * sg, dz: dz * sg, hw: E.W / 2, R: atStart ? E.R0 : E.R1, y, f, s, sg, tot });
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
        if (!g) groups.set(r, (g = []));
        g.push(...ends.get(n));
      }
      const JA = [KIND.ASPHALT, 1, F.NOMARK, 1000], JJ = [0, 0, 99, 99];
      for (const g of groups.values()) {
        // 凸包顶点带高程（各进口在该里程处的路面高）：路口铺面随路面纵坡倾斜，整体比路面低 4 cm，
        // 不会在下坡一侧顶出路面（平的铺面在有坡的路口会盖住条带，夜里成一块没有路灯光斑的暗斑）
        const pts = [];
        let ymin = Infinity;
        for (const e of g) {
          const D = Math.min(Math.max(e.R, e.hw) + 0.5, 40);
          const rx = -e.dz, rz = e.dx;
          const fx = e.x + e.dx * D, fz = e.z + e.dz * D;
          const yf = roadY(terrain, e.f, fx, fz, Math.min(Math.max(e.s + e.sg * D, 0), e.tot), e.tot) ?? e.y;
          pts.push([fx + rx * e.hw, fz + rz * e.hw, yf], [fx - rx * e.hw, fz - rz * e.hw, yf]);
          pts.push([e.x + rx * e.hw, e.z + rz * e.hw, e.y], [e.x - rx * e.hw, e.z - rz * e.hw, e.y]);
          if (e.y < ymin) ymin = e.y;
        }
        // 凸包（Andrew 单调链）
        pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lo = [], hi = [];
        for (const q of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
        for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
        const hull = lo.slice(0, -1).concat(hi.slice(0, -1));
        if (hull.length < 3) continue;
        let area = 0, cx = 0, cz = 0, diam = 0;
        for (let i = 0; i < hull.length; i++) {
          const a = hull[i], b = hull[(i + 1) % hull.length];
          area += a[0] * b[1] - b[0] * a[1];
          cx += a[0]; cz += a[1];
        }
        area = Math.abs(area) / 2;
        cx /= hull.length; cz /= hull.length;
        for (const a of hull) diam = Math.max(diam, Math.hypot(a[0] - cx, a[1] - cz));
        // 立交、环岛、大广场之类的大凸包会盖住绿地/建筑：只铺普通平面交叉口
        if (area > 9000 || diam > 75) continue;
        const w = getTile(tileKey(cx, cz, T_MAJOR, 'm'), T_MAJOR, cx, cz, false);
        w.ensure(hull.length + 1, hull.length * 3);
        const c0 = w.v(cx, ymin - 0.04, cz, 0, 1, 0, 0.5, 0, JA, JJ);
        for (const a of hull) w.v(a[0], Math.min(a[2], ymin + 1.5) - 0.04, a[1], 0, 1, 0, 0.5, 0, JA, JJ);
        for (let i = 0; i < hull.length; i++) {
          const a = c0 + 1 + i, b = c0 + 1 + ((i + 1) % hull.length);
          // 朝上：(b-a)×(c-a) 的 y 分量 > 0 时按 (c0, a, b)，否则反过来
          const A = hull[i], B = hull[(i + 1) % hull.length];
          const ny = (A[1] - cz) * (B[0] - cx) - (A[0] - cx) * (B[1] - cz);
          if (ny > 0) w.tri(c0, a, b); else w.tri(c0, b, a);
        }
        kindTris.j = (kindTris.j || 0) + hull.length;
        nJunc++;
      }
    }
    console.warn(`[roads] 路口铺面 ${nJunc} 处，${(performance.now() - T6).toFixed(0)} ms`);

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
    });
    const lampGeo = lampGeometries();
    const lampMat = lampMaterial(ctx);
    const types = [LAMP.SINGLE, LAMP.DOUBLE, LAMP.KNOT, LAMP.PALACE, LAMP.LANTERN];
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
        [LAMP.SINGLE]: [1.0, 0.64, 0.33], [LAMP.DOUBLE]: [1.0, 0.66, 0.36], [LAMP.KNOT]: [1.0, 0.7, 0.42],
        [LAMP.PALACE]: [1.0, 0.58, 0.24], [LAMP.LANTERN]: [1.0, 0.64, 0.33],
      };
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
          const red = (t === LAMP.KNOT && h === 2) || (t === LAMP.LANTERN && h > 0);
          const cc = red ? [1.0, 0.16, 0.08] : COLS[t];
          const b = lamps.lvl ? 0.55 + 0.15 * lamps.lvl[i] : 1;
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
