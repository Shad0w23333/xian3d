// 西安现代地标与摩天楼：高新区 CBD（国瑞、绿地中心“丝路之门”、中铁、迈科、永利、体育之窗、延长石油…）、
// 未央国际商圈（未央国际、熙地港、大融城、行政中心、大明宫万达、荣民金融中心）、陕西广播电视塔、长安塔、
// 西安奥体中心、西安北站、丝路国际会议/展览中心、赛格、开元商城、陕西信息大厦，以及 skyline.json 中其余 OSM 实测高层。
// 立面：共享程序化幕墙着色器（src/arch/sky-facade.js）——竖梃/横梁/窗槛墙/设备层按米生成，夜间亮窗、LED 媒体幕墙、塔冠泛光。
import * as THREE from 'three';
import { Batcher } from '../core/util.js';
import * as G from '../arch/sky-geom.js';
import { createFacadeMaterial } from '../arch/sky-facade.js';
import { SignAtlas, Beacons, solidMats, buildTower, buildPodium, groundMin } from '../arch/sky-towers.js';
import * as SP from '../arch/sky-special.js';
import { loadJSON } from '../core/data.js';
import { DISTRICTS, towerSpecs as towerSpecs1, mallSpecs as mallSpecs1, SPECIAL } from '../arch/sky-data.js';
import { SUPERSEDED, towerSpecs2, mallSpecs2, SPECIAL2, special2Footprints } from '../arch/sky-data2.js';
import * as SP2 from '../arch/sky-special2.js';

// 2026-09 地标更新（sky-data2.js）取代失真的旧定义（熙地港、大融城、未央国际）
// landmarks2026：全城地标批量精建（tools/build_landmarks2026.py 由联网调研清单生成）；prepare 时加载并去掉已精建/已被其他模块占用的
let LM = null;
const towerSpecs = (ctx) => towerSpecs1().filter((t) => !SUPERSEDED.has(t.key)).concat(towerSpecs2(), LM?.towers || []).filter((t) => !isSuperseded(ctx, t));
const mallSpecs = (ctx) => mallSpecs1().filter((m) => !SUPERSEDED.has(m.key)).concat(mallSpecs2(), LM?.malls || []).filter((m) => !isSuperseded(ctx, m));

/** 逐栋档案（src/modules/dossier.js，先于本模块 prepare）已替代的旧定义：key / 名称命中 ctx.superseded，或质心落在档案建筑轮廓内。
 *  s 可以是塔楼/商场 spec（key、name、pts）、skyline.json 要素（n、x、z、outer）或只带 key 的特殊地标 */
function isSuperseded(ctx, s) {
  const S = ctx?.superseded;
  if (!S || !s) return false;
  if ((s.key && S.keys.has(s.key)) || S.names.has(s.name ?? s.n)) return true;
  const pts = s.pts || s.outer;
  const c = pts?.length >= 6 ? G.centroid(G.ccw(pts)) : s.x != null ? { x: s.x, z: s.z } : null;
  return !!c && S.polys.some((p) => G.pointIn(c.x, c.z, p));
}

/** 轮廓内 6×6 网格取样点（落在轮廓内的），取不到时退回质心 */
function samplesIn(p) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
  }
  const out = [];
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 6; j++) {
      const x = x0 + ((i + 0.5) / 6) * (x1 - x0), z = z0 + ((j + 0.5) / 6) * (z1 - z0);
      if (G.pointIn(x, z, p)) out.push([x, z]);
    }
  if (!out.length) { const c = G.centroid(p); out.push([c.x, c.z]); }
  return out;
}
const HIT_FRAC = 0.25; // 批量地标轮廓落入精建轮廓/其他模块排除区的比例 ≥ 此值则跳过

// —— 同名/近名塔楼去重 ——
/** 名称归一化：去空白、间隔号、连字符、括号（“禾盛京广中心-A座”与“禾盛京广中心A座”视为同名） */
const normName = (n) => String(n || '').replace(/[\s·・\-—_()（）]/g, '').toLowerCase();
/** 最长公共子串 */
function lcs(a, b) {
  let best = '';
  for (let i = 0; i < a.length; i++)
    for (let j = i + best.length + 1; j <= a.length; j++) {
      if (!b.includes(a.slice(i, j))) break;
      best = a.slice(i, j);
    }
  return best;
}
// 楼号/座号：A座、B座、1号楼、北塔……（仅这部分不同的是同一项目的不同楼，不算重复）
const DESIG = /^[a-z0-9#＃一二三四五六七八九十东西南北]{1,3}(座|号楼|号|栋|塔|楼)?$/;
/** 两座塔楼是否同一栋：相距 < 250 m、高度差 ≤ 6%，且同名；或其中一座是推算位置（合成矩形/综合体塔楼，soft），
 *  名称核心（≥ 4 字的公共子串）相同、剩余部分不是两个不同楼号。两座都有实测轮廓且不同名的不算（同名小区的两栋楼） */
function sameTower(a, b) {
  if (Math.hypot(a.x - b.x, a.z - b.z) > 250 || Math.abs(a.h - b.h) > 0.06 * Math.max(a.h, b.h)) return false;
  if (a.n === b.n) return true;
  if (!a.soft && !b.soft) return false;
  const core = lcs(a.n, b.n);
  if (core.length < 4) return false;
  const ra = a.n.replace(core, ''), rb = b.n.replace(core, '');
  return !(DESIG.test(ra) && DESIG.test(rb) && ra !== rb);
}
const towerKey = (t) => { const c = G.centroid(G.ccw(t.pts)); return { x: c.x, z: c.z, h: t.h, n: normName(t.name), soft: !!(t.onPodium || t.src === 'synth') }; };

/** 批量地标过滤（在 build 开头调用：此时所有模块的 prepare 都已注册完排除区——回民街/下沉广场/机场等排在 skyline 之后，
 *  放在 prepare 里会漏判）：与手工精建（sky-data / sky-data2 / 特殊地标）同名、质心落在其轮廓内或轮廓 ≥ HIT_FRAC 与之重叠、
 *  或质心/轮廓 ≥ HIT_FRAC 落在其他模块的建筑排除区内的跳过（skyline 自己注册的排除区不算）；
 *  商场综合体里推算落位的塔楼（onPodium），若轮廓内已有 OSM 实测高层（skyline.json）也跳过，以实测为准 */
function filterLandmarks(ctx, raw) {
  const { curated } = allFootprints(ctx); // 此时 LM 为空：curated.polys 只有手工精建与特殊地标（不含通用高层）
  const curNames = new Set([...curated.names].map(normName));
  const curTowers = towerSpecs(ctx).map((t) => G.ccw(t.pts));
  const zones = ctx.exclusions.items.filter((it) => it.flags.buildings && it.name !== 'skyline');
  const inZone = (x, z, h) =>
    zones.some((it) => {
      const b = it.bb;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return false;
      if (it.flags.maxHeight != null && h > it.flags.maxHeight) return false;
      return G.pointIn(x, z, it.p);
    });
  const hit = (s, isMall = false) => {
    if (isSuperseded(ctx, s)) return true; // 已由逐栋档案模型替代
    const p = G.ccw(s.pts), c = G.centroid(p);
    if (curNames.has(normName(s.name)) || curated.polys.some((q) => G.pointIn(c.x, c.z, q)) || inZone(c.x, c.z, s.h)) return true;
    const sp = samplesIn(p);
    const frac = (f) => sp.filter(([x, z]) => f(x, z)).length / sp.length;
    // 商场/场馆：手工精建塔楼立在其裙房上属正常（禾盛京广 T11 与 A/B 座），塔楼占的部分不算重叠
    const tw = isMall ? curTowers : [];
    const inCur = (x, z) => curated.polys.some((q) => G.pointIn(x, z, q)) && !tw.some((q) => G.pointIn(x, z, q));
    return frac(inCur) >= HIT_FRAC || frac((x, z) => inZone(x, z, s.h)) >= HIT_FRAC;
  };
  const malls = (raw.malls || []).filter((m) => m.pts?.length >= 6 && !hit(m, true));
  const mallKeys = new Set(malls.map((m) => m.key));
  const osm = (ctx.data.skyline?.features || []).filter((f) => f.h >= 34);
  const cand = (raw.towers || []).filter((t) => {
    if (!(t.pts?.length >= 6) || hit(t)) return false;
    if (!t.onPodium) return true;
    if (!mallKeys.has(t.onPodium)) return false;
    const m = malls.find((q) => q.key === t.onPodium), mp = G.ccw(m.pts);
    return !osm.some((f) => G.pointIn(f.x, f.z, mp));
  });
  // 同一栋被建两遍（手工精建与批量同名/近名，或批量清单里独立条目与“综合体塔楼”各一份，如 ICC 写字楼/酒店、禾盛京广 A/B）：
  // 手工精建 > 批量实测轮廓 > 批量合成 > 综合体推算塔楼，依次接纳，与已接纳者 sameTower 的丢弃
  const rank = (t) => (t.onPodium ? 3 : t.src === 'synth' ? 2 : 1);
  const kept = towerSpecs1().filter((t) => !SUPERSEDED.has(t.key)).concat(towerSpecs2()).map(towerKey);
  const towers = [];
  for (const t of [...cand].sort((a, b) => rank(a) - rank(b))) {
    const k = towerKey(t);
    if (kept.some((q) => sameTower(k, q))) continue;
    kept.push(k);
    towers.push(t);
  }
  towers.sort((a, b) => cand.indexOf(a) - cand.indexOf(b));
  for (const s of malls) { s.lm = true; if (!s.d) { const c = G.centroid(G.ccw(s.pts)); s.d = districtOf(c.x, c.z); } }
  for (const s of towers) s.lm = true;
  console.warn(`[skyline] landmarks2026：塔楼 ${towers.length}/${(raw.towers || []).length}，商场·场馆 ${malls.length}/${(raw.malls || []).length}`);
  return { towers, malls, labels: raw.labels || [] };
}

/** 有贴图的材质自动套“米制”UV（贴图自带 UV 的除外） */
class SBatcher extends Batcher {
  add(g, m, mtx = null, o = {}) {
    if (m.map && !m.userData.ownUV && !o.worldUV) o = { ...o, worldUV: 1 };
    return super.add(g, m, mtx, o);
  }
}

const districtOf = (x, z) => {
  let best = DISTRICTS[0], bd = Infinity;
  for (const d of DISTRICTS) {
    const dd = Math.hypot(d.x - x, d.z - z);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best.id;
};

// —— skyline.json 中其余实测高层（OSM height/levels）：通用塔楼 ——
// 数据本身已由 tools/check_heights.py --fix 修正（SKY_FIX：公路研究院 103 层/330 m 错标降为通用建筑、IFC 330→350、
// 迈科/延长石油整片综合体轮廓取裙房高）；HFIX 只作运行时兜底（旧数据文件仍能得到正确结果），按名称覆盖高度，0 = 不是高层
const HFIX = { 西安公路研究院: 0, 'IFC国瑞·西安金融中心': 350 };
function genericFeatures(ctx, curated) {
  const feats = (ctx.data.skyline?.features || [])
    .map((f) => (f.n in HFIX && f.hsrc !== 'fix' ? { ...f, h: HFIX[f.n] } : f))
    .filter((f) => f.outer?.length >= 6 && f.h >= 34 && Math.hypot(f.x, f.z) < 47000);
  const out = [];
  for (const f of feats) {
    if (curated.names.has(f.n) || isSuperseded(ctx, f)) continue;
    if (curated.polys.some((p) => G.pointIn(f.x, f.z, p))) continue;
    out.push(f);
  }
  return out;
}
const RES_WALL = ['#ddd5c6', '#d2cabb', '#e3ddd1', '#cdbda6', '#d9d3cb'];
const OFFICE_TINT = ['#3b5569', '#44606f', '#2f4556', '#51697a', '#3d4f5c'];
function genericSpec(f, i) {
  const r = (k) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  const res = f.kind === 1 || (f.kind === 0 && f.h < 110 && /号楼|栋|公寓|花园|嘉园|城/.test(f.n || ''));
  const pts = G.ccw(f.outer);
  if (res) {
    return {
      pts, h: f.h, roof: { parapet: 1.2 },
      style: { mode: 7, floorH: 3.0, colW: 3.3 + r(1) * 0.6, mullW: 1.3 + r(2) * 0.4, spandrel: 0.34, tint: '#2c3740', spd: RES_WALL[Math.floor(r(3) * RES_WALL.length)], lit: 0.5, seed: i * 1.7 },
    };
  }
  return {
    pts, h: f.h, crown: f.h > 90 ? { h: 5, color: '#dfe9ff', colW: 2.6 } : null,
    style: { mode: r(4) > 0.6 ? 2 : 0, floorH: 3.9, colW: 1.5 + r(5) * 0.4, spandrel: 0.24 + r(6) * 0.12, tint: OFFICE_TINT[Math.floor(r(7) * OFFICE_TINT.length)], spd: '#5a6570', band: f.h > 120 ? 12 : 0, lit: 0.38, seed: i * 2.3 },
  };
}

/** 所有占地轮廓（prepare 排除区用） */
function allFootprints(ctx) {
  const polys = [];
  const towers = towerSpecs(ctx);
  for (const t of towers) { polys.push(G.ccw(t.pts)); if (t.podium) polys.push(G.ccw(t.podium.pts)); }
  // 批量地标的商场/场馆轮廓（常是整个综合体地块）不参与“通用高层去重”：地块内的 OSM 实测塔楼照常生成
  const soft = [];
  for (const m of mallSpecs(ctx)) { polys.push(G.ccw(m.pts)); if (m.lm) soft.push(polys[polys.length - 1]); }
  const S = SPECIAL;
  const s0 = polys.length;
  polys.push(G.ccw(S.tv.basePts), G.circle(S.tv.cx, S.tv.cz, 24, 16));
  polys.push(G.rect(S.changan.cx, S.changan.cz, 60, 60, S.changan.rot));
  polys.push(G.ccw(Array.from({ length: 48 }, (_, i) => [S.aoti.stadium.cx + Math.cos((i / 48) * Math.PI * 2) * 156, S.aoti.stadium.cz + Math.sin((i / 48) * Math.PI * 2) * 174]).flat()));
  polys.push(G.circle(S.aoti.arena.cx, S.aoti.arena.cz, S.aoti.arena.r + 4, 24));
  polys.push(G.rect(S.aoti.aqua.cx, S.aoti.aqua.cz, S.aoti.aqua.w + 6, S.aoti.aqua.d + 6, S.aoti.aqua.rot));
  polys.push(G.ccw(S.igc1.pts));
  polys.push(G.rect(S.north.cx, S.north.cz, S.north.w + 18 + 2 * 137, S.north.L + 18, S.north.rot));
  for (const c of S.conf) polys.push(G.rect(c.cx, c.cz, c.side + 4, c.side + 4, c.rot));
  for (const p of S.expo) { const o = G.obb(G.ccw(p)); polys.push(G.rect(o.cx, o.cz, o.w + 4, o.d + 4, o.rot)); }
  for (const p of S.gov) polys.push(G.ccw(p));
  polys.push(...special2Footprints());
  const special = polys.slice(s0);
  const curated = { names: new Set(towers.map((t) => t.name)), polys: polys.filter((p) => !soft.includes(p)) };
  for (const f of genericFeatures(ctx, curated)) polys.push(G.ccw(f.outer));
  return { polys, curated, special };
}

export default {
  id: 'skyline',
  name: '现代地标与摩天楼',
  async prepare(ctx) {
    // 批量地标（landmarks2026）只在这里读入；过滤与排除区注册推迟到 build 开头（见 filterLandmarks）
    this.lmRaw = await loadJSON('landmarks2026.json', { optional: true });
    LM = null;
    const { polys } = allFootprints(ctx);
    for (const p of polys) ctx.exclusions.add({ points: G.inset(p, -2.5), name: 'skyline' }, { buildings: true, trees: true });
    // 大型场馆/站房下压平地形
    const S = SPECIAL;
    ctx.terrain.addFlatten({ points: G.rect(S.north.cx, S.north.cz, S.north.w + 300, S.north.L + 30, S.north.rot), height: null, feather: 40 });
    ctx.terrain.addFlatten({ points: G.circle(S.aoti.stadium.cx, S.aoti.stadium.cz, 180, 32), height: null, feather: 40 });
    for (const c of S.conf) ctx.terrain.addFlatten({ points: G.rect(c.cx, c.cz, c.side + 10, c.side + 10, c.rot), height: null, feather: 30 });
    ctx.terrain.addFlatten({ points: G.rect(S.changan.cx, S.changan.cz, 80, 80, S.changan.rot), height: null, feather: 25 });
  },

  async build(ctx) {
    const t0 = performance.now();
    // 所有模块的 prepare 已完成：过滤批量地标，并为保留下来的注册排除区（通用建筑 buildings 在其后 build，树木更晚）
    if (this.lmRaw) {
      LM = filterLandmarks(ctx, this.lmRaw);
      for (const s of [...LM.towers, ...LM.malls]) ctx.exclusions.add({ points: G.inset(G.ccw(s.pts), -2.5), name: 'skyline' }, { buildings: true, trees: true });
      // skyline.json 通用高层与地标塔楼的去重由 genericFeatures（此后 curated 含地标塔楼）负责
    }
    const root = new THREE.Group();
    root.name = '现代地标与摩天楼';
    ctx.scene.add(root);
    const fmat = createFacadeMaterial(ctx);
    const mats = solidMats(ctx);
    mats.heli.userData.ownUV = true;
    const signs = new SignAtlas(ctx);
    const beacons = new Beacons(ctx);
    const envs = new Map();
    const env = (id) => {
      if (!envs.has(id)) envs.set(id, { ctx, id, fb: new G.FacadeBuilder(), solid: new SBatcher(), detail: new SBatcher(), mats, signs, beacons });
      return envs.get(id);
    };
    const { curated } = allFootprints(ctx);
    const errors = [];
    const safe = (name, fn) => {
      try { return fn(); } catch (e) { console.error('[skyline]', name, e); errors.push(name); }
    };

    // —— 塔楼 ——
    for (const s of towerSpecs(ctx)) safe(s.name, () => {
      const c = G.centroid(s.pts);
      const E = env(s.d || districtOf(c.x, c.z));
      const r = buildTower(E, s);
      if (s.pyramid) {
        // 陕西信息大厦：玻璃四棱锥塔冠 + 塔尖
        const top = G.inset(G.ccw(s.pts), 3.2);
        const y = r.top, apex = [r.c.x, y + s.pyramid.h, r.c.z];
        const pos = [];
        for (let i = 0; i < top.length; i += 2) {
          const j = (i + 2) % top.length;
          pos.push(top[i], y, top[i + 1], ...apex, top[j], y, top[j + 1]);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const pa = g.attributes.position.array;
        g.computeVertexNormals();
        const na = g.attributes.normal.array;
        for (let i = 0; i < pa.length; i += 9) if (na[i + 1] < 0) for (let k = 0; k < 3; k++) { const tt = pa[i + 3 + k]; pa[i + 3 + k] = pa[i + 6 + k]; pa[i + 6 + k] = tt; }
        g.computeVertexNormals();
        E.solid.add(g, mats.glassRoof);
        E.detail.add(G.cyl(r.c.x, apex[1] - 2, r.c.z, 1.0, 0.2, s.pyramid.spire + 2, 8), mats.metal);
        beacons.add(r.c.x, apex[1] + s.pyramid.spire, r.c.z, 0, 5);
      }
    });
    // —— 商场/裙房 ——
    for (const m of mallSpecs(ctx)) safe(m.key, () => {
      const E = env(m.d);
      const base = buildPodium(E, m);
      if (m.domes) SP.domes(E, m.domes, base + m.h + 0.2);
      if (m.led) {
        // 赛格：西立面（长安路）巨型 LED 屏
        const p = G.ccw(m.pts), n = p.length / 2;
        let best = null;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, dx = p[j * 2] - p[i * 2], dz = p[j * 2 + 1] - p[i * 2 + 1], L = Math.hypot(dx, dz);
          const nx = dz / L;
          if (nx < -0.6 && (!best || L > best.L)) best = { i, j, L, dx: dx / L, dz: dz / L, nx, nz: -dx / L };
        }
        if (best) {
          const w = Math.min(best.L * 0.8, 64), mx = (p[best.i * 2] + p[best.j * 2]) / 2, mz = (p[best.i * 2 + 1] + p[best.j * 2 + 1]) / 2;
          const ax = mx - best.dx * w / 2 + best.nx * 0.8, az = mz - best.dz * w / 2 + best.nz * 0.8;
          const bx = mx + best.dx * w / 2 + best.nx * 0.8, bz = mz + best.dz * w / 2 + best.nz * 0.8;
          E.fb.panel(ax, az, bx, bz, base + 14, base + m.h - 8, { floorH: 1, colW: 0.9, spandrel: 0, seed: 1, mullW: 0.04, lit: 0, mode: 5, band: 0, tint: [0.02, 0.02, 0.02], spd: [0.2, 0.2, 0.2] });
        }
      }
    });
    // —— 特殊地标（逐栋档案 supersede.keys 含其键名时跳过：tv/igc1/changan/aoti/north/conf/expo/gov/w/hyatt/rainbow/butterfly/houhai） ——
    const sp = (key, name, fn) => (isSuperseded(ctx, { key }) ? null : safe(name, fn));
    sp('tv', '电视塔', () => SP.buildTVTower(env('south'), SPECIAL.tv));
    sp('igc1', '环球贸易中心1号楼', () => SP.buildUnderConstruction(env('weiyang'), SPECIAL.igc1));
    sp('changan', '长安塔', () => SP.buildChanganTower(env('chanba'), SPECIAL.changan));
    sp('aoti', '奥体中心', () => SP.buildAoti(env('chanba'), SPECIAL.aoti));
    sp('north', '西安北站', () => SP.buildNorthStation(env('north'), SPECIAL.north));
    for (const c of SPECIAL.conf) sp('conf', '会议中心', () => SP.buildConference(env('chanba'), c));
    SPECIAL.expo.forEach((p, i) => sp('expo', '展馆', () => SP.buildHall(env('chanba'), p, { h: 18, rise: 7 })));
    for (const p of SPECIAL.gov) sp('gov', '行政中心', () => {
      const o = G.obb(G.ccw(p));
      const main = Math.abs(G.area(p)) > 3500 && o.w / o.d > 2.4;
      SP.buildGovBlock(env('weiyang'), p, { h: main ? 42 : o.w * o.d > 2000 ? 22 : 16 });
    });
    // —— 2026-09 新增：曲江 W 酒店·万众国际、浐灞凯悦 / 彩虹桥 / 蝴蝶桥 / 后海夜市 ——
    sp('w', '万众国际·W酒店', () => SP2.buildW(env('south'), SPECIAL2.w));
    sp('hyatt', '浐灞凯悦', () => SP2.buildHyatt(env('chanba'), SPECIAL2.hyatt));
    sp('rainbow', '彩虹桥', () => root.add(SP2.buildRainbowBridge(env('chanba'), SPECIAL2.rainbow)));
    sp('butterfly', '蝴蝶桥', () => root.add(SP2.buildButterflyBridge(env('chanba'), SPECIAL2.butterfly)));
    sp('houhai', '后海夜市', () => root.add(SP2.buildHouhai(env('chanba'), SPECIAL2.houhai)));
    // —— 其余 OSM 实测高层 ——
    const gen = genericFeatures(ctx, curated);
    gen.forEach((f, i) => safe('generic', () => buildTower(env(districtOf(f.x, f.z)), genericSpec(f, i))));

    // —— 输出网格 ——
    const lod = [];
    for (const E of envs.values()) {
      const grp = new THREE.Group();
      grp.name = 'skyline-' + E.id;
      if (E.fb.count) {
        const m = new THREE.Mesh(E.fb.geometry(), fmat);
        m.castShadow = true; m.receiveShadow = true; m.name = '幕墙';
        grp.add(m);
      }
      grp.add(E.solid.build({ castShadow: true, receiveShadow: true, name: '实体' }));
      const det = E.detail.build({ castShadow: false, receiveShadow: false, name: '细部' });
      grp.add(det);
      const bs = new THREE.Box3().setFromObject(det);
      if (!bs.isEmpty()) lod.push({ obj: det, box: bs, range: 3200 });
      root.add(grp);
    }
    const sm = signs.build();
    if (sm) {
      root.add(sm);
      lod.push({ obj: sm, box: new THREE.Box3().setFromObject(sm), range: 9000 });
    }
    root.add(beacons.build());

    // —— 标注（每片区一个） ——
    for (const d of DISTRICTS) if (d.label) {
      const [x, z, h] = d.label;
      ctx.labels.add(d.name, new THREE.Vector3(x, ctx.terrain.heightAt(x, z) + h, z), { category: d.id === 'north' ? 'station' : 'district', priority: 2, minDist: 300, maxDist: 16000 });
    }
    // 批量地标：塔楼（≥ 80 m 或有楼顶字）、商场、场馆，以及仅标注的公园/校园
    for (const s of LM?.towers || []) if (!s.onPodium && (s.h >= 80 || s.signs)) {
      const c = G.centroid(G.ccw(s.pts));
      ctx.labels.add(s.name, new THREE.Vector3(c.x, ctx.terrain.heightAt(c.x, c.z) + s.h + 6, c.z), { category: 'landmark', priority: 1 + Math.min(1.5, s.h / 200), minDist: 120, maxDist: 6000 + s.h * 40 });
    }
    for (const m of LM?.malls || []) {
      const c = G.centroid(G.ccw(m.pts));
      ctx.labels.add(m.name, new THREE.Vector3(c.x, ctx.terrain.heightAt(c.x, c.z) + m.h + 8, c.z), { category: 'landmark', priority: m.cat ? 1.4 : 1.2, minDist: 100, maxDist: 7000 });
    }
    for (const l of LM?.labels || []) {
      ctx.labels.add(l.n, new THREE.Vector3(l.x, ctx.terrain.heightAt(l.x, l.z) + 30, l.z), { category: 'district', priority: l.cat === 'park' ? 1.3 : 1.1, minDist: 250, maxDist: 9000 });
    }
    const tv = SPECIAL.tv, ca = SPECIAL.changan, ao = SPECIAL.aoti.stadium;
    ctx.labels.add('陕西广播电视塔', new THREE.Vector3(tv.cx, ctx.terrain.heightAt(tv.cx, tv.cz) + 252, tv.cz), { category: 'landmark', priority: 2.5, minDist: 150 });
    ctx.labels.add('长安塔', new THREE.Vector3(ca.cx, ctx.terrain.heightAt(ca.cx, ca.cz) + 106, ca.cz), { category: 'landmark', priority: 2, minDist: 120 });
    ctx.labels.add('西安奥体中心', new THREE.Vector3(ao.cx, ctx.terrain.heightAt(ao.cx, ao.cz) + 70, ao.cz), { category: 'landmark', priority: 2, minDist: 200 });

    const stats = { towers: towerSpecs(ctx).length, generic: gen.length, ms: Math.round(performance.now() - t0), errors };
    console.warn('[skyline] 构建完成 ' + JSON.stringify(stats));
    const tmpBox = new THREE.Box3();
    void tmpBox;
    return {
      stats,
      /** 诊断（tools/check_overlap.mjs）：本模块最终渲染的全部建筑轮廓与底高 */
      diag() {
        const out = [];
        const put = (src, name, key, pts, h, base) => out.push({ src, name: name || '', key: key || '', pts: Array.from(pts), h, base });
        for (const t of towerSpecs(ctx)) {
          const pts = G.ccw(t.pts), b = t.base ?? groundMin(ctx, t.podium ? t.podium.pts.concat(pts) : pts);
          put(t.lm ? (t.src === 'synth' ? 'lm-synth' : 'lm') : 'cur', t.name, t.onPodium || t.key, pts, t.h, b); // 坐商场裙房的塔楼与商场同 key（有意嵌套，不算重叠）
          if (t.podium) put(t.lm ? 'lm' : 'cur', (t.name || '') + '·裙房', t.key, G.ccw(t.podium.pts), t.podium.h, b);
        }
        for (const m of mallSpecs(ctx)) {
          const pts = G.ccw(m.pts);
          put(m.lm ? (m.src === 'synth' ? 'lm-synth' : 'lm') : 'cur', m.name || m.key, m.key, pts, m.h, m.base ?? groundMin(ctx, pts));
        }
        const { special } = allFootprints(ctx);
        special.forEach((p, i) => put('special', 'special#' + i, '', p, 30, groundMin(ctx, p)));
        gen.forEach((f, i) => put('osm', f.n, '', G.ccw(f.outer), f.h, groundMin(ctx, G.ccw(f.outer))));
        return out;
      },
      update() {
        const cam = ctx.camera;
        beacons.update(ctx.renderer, cam);
        for (const l of lod) l.obj.visible = l.box.distanceToPoint(cam.position) < l.range;
      },
      setLayer(layer, v) {
        if (layer === 'buildings') root.visible = v;
      },
      setQuality(q) {
        for (const l of lod) l.range = q.level === 0 ? (l.range > 5000 ? 6000 : 1800) : l.range > 5000 ? 9000 : 3200;
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};
