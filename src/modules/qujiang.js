// 曲江新区园林与文旅地标：大唐芙蓉园（紫云楼、芙蓉湖、园内唐风建筑群、水幕灯光秀）、曲江池遗址公园（阅江楼、岛亭、驳岸）、
// 唐城墙遗址公园（夯土城墙残段）、寒窑遗址公园。现代高层住宅由通用建筑模块、会展中心由现代地标模块负责。
//
// 资料（research/refs/qujiang/）：
//   · Esri 卫星拼图 furong_z17.jpg / qujiangchi_z16.jpg（带世界坐标网格；卫星图相对 OSM 约西偏 30~40 m，本模块以 OSM 为准）。
//   · 紫云楼：芙蓉园主体建筑，主楼高 39 m、四层（外观三层 + 重檐庑殿顶），建筑面积 8632 m²；坐南朝北，前临芙蓉湖，
//     北侧为半圆形临水广场，湖中即水幕电影/喷泉/激光秀场地。两翼配殿 + 角楼（阙式）。唐风：朱柱白壁、深灰筒瓦、鸱尾、雄大斗拱。
//   · 彩霞长廊：沿湖东岸由北向东延伸约 270~300 m 的唐风长廊。园内其余殿阁（御宴宫、仕女馆/望春阁、凤鸣九天剧院、杏园、
//     唐市、芳林阁……）按 OSM 足迹（buildings.bin）逐栋程序化重建为唐风殿堂/楼阁/亭/廊，位置尺度与实际一致。
//   · 夜景：芙蓉园全园金色轮廓灯（檐口 + 屋脊 LED）、紫云楼暖金泛光、湖面倒影（投影镜像，见 qujiang-gen.js）、水幕灯光秀。
//   · 曲江池遗址公园：南湖水面、岛屿、阅江楼（南岸，三层唐风楼阁）、畅观楼等；唐城墙遗址公园为东西向带状夯土城墙残段。
import * as THREE from 'three';
import { ArchBuilder, buildLOD, multiStoreyTower, hall, pavilion, paifang, platform, steps, balustrade, lantern, getKit } from '../arch/chinese.js';
import { readBuildings, tangFromFootprint, lakeMask, addReflection, waterShow, signedArea } from '../arch/qujiang-gen.js';
import { pointInPoly, polyCentroid } from '../core/util.js';

const PARK_NAMES = ['大唐芙蓉园', '曲江池遗址公园', '曲江寒窑遗址公园'];
const ZIYUN = { x: 2455, z: 5232 }; // 紫云楼主楼中心（OSM 足迹前部）
const ZIYUN_ZONE = [2375, 5140, 2550, 5312]; // 紫云楼 + 临水广场（手工建模，通用足迹跳过）
const YUEJIANG = { x: 3510, z: 7093 }; // 阅江楼
const YUEJIANG_ZONE = [3485, 7062, 3537, 7122];
const FACE = { 大唐芙蓉园: [2470, 5030], 曲江池遗址公园: [3450, 6620], 曲江寒窑遗址公园: null };
const CELL = 320;

const inZone = (x, z, r) => x > r[0] && x < r[2] && z > r[1] && z < r[3];
const state = { parks: [], fps: [], ziyunH: null };

function findParks(ctx) {
  const lu = ctx.data.landuse?.polys || [];
  const parks = [];
  for (const n of PARK_NAMES) {
    let best = null;
    for (const p of lu) if (p.n === n && p.k === 'park' && (!best || (p.a || 0) > (best.a || 0))) best = p;
    if (best) parks.push({ n, outer: best.outer });
  }
  return parks;
}

export default {
  id: 'qujiang',
  name: '曲江园林（大唐芙蓉园·曲江池）',

  prepare(ctx) {
    const T = ctx.terrain;
    state.parks = findParks(ctx);
    // 园区：通用建筑让位（由本模块按足迹重建为唐风建筑），树木保留
    for (const p of state.parks) ctx.exclusions.add({ points: p.outer, name: p.n }, { buildings: true, trees: false, pois: true });
    // 紫云楼台基 + 临水广场：压平，且不低于湖面
    const h0 = T.heightAt(ZIYUN.x, ZIYUN.z);
    const zy = [2380, 5178, 2420, 5160, 2455, 5150, 2490, 5160, 2548, 5180, 2548, 5310, 2380, 5310];
    state.ziyunH = T.addFlatten({ points: zy, height: Math.max(h0, 430.6), feather: 8 }) ?? Math.max(h0, 430.6);
    ctx.exclusions.add({ points: zy, name: '紫云楼' }, { buildings: true, trees: true, pois: true });
    const yj = [YUEJIANG_ZONE[0], YUEJIANG_ZONE[1], YUEJIANG_ZONE[2], YUEJIANG_ZONE[1], YUEJIANG_ZONE[2], YUEJIANG_ZONE[3], YUEJIANG_ZONE[0], YUEJIANG_ZONE[3]];
    T.addFlatten({ points: yj, height: null, feather: 6 });
    ctx.exclusions.add({ points: yj, name: '阅江楼' }, { buildings: true, trees: true, pois: true });
    // 园内足迹（重建对象）：树木避让
    const B = readBuildings(ctx.data.buildings);
    state.fps = [];
    if (B) {
      for (let i = 0; i < B.n; i++) {
        const x = B.ax[i], z = B.az[i];
        if (x < 1200 || x > 4500 || z < 4500 || z > 7300) continue;
        const park = state.parks.find((p) => pointInPoly(x, z, p.outer));
        if (!park || inZone(x, z, ZIYUN_ZONE) || inZone(x, z, YUEJIANG_ZONE)) continue;
        const pts = B.poly(i);
        const flat = pts.flat();
        state.fps.push({ x, z, pts, h: B.hd[i] / 10, park: park.n });
        if (Math.abs(signedArea(pts)) > 14) ctx.exclusions.add({ points: flat }, { buildings: false, trees: true, pois: false });
      }
    }
  },

  async build(ctx) {
    const root = new THREE.Group();
    root.name = '曲江园林';
    ctx.scene.add(root);
    const T = ctx.terrain;
    const ground = (x, z) => T.heightAt(x, z);
    const water = ctx.data.water?.polys || [];
    const furong = water.find((p) => p.n === '芙蓉湖');
    const qjc = water.find((p) => p.n === '曲江池');
    const lakes = {};
    if (furong) lakes.fr = { id: 'fr', y: Number.isFinite(furong.h) ? furong.h : 429.1, poly: furong, ...lakeMask([furong]) };
    if (qjc) lakes.qj = { id: 'qj', y: Number.isFinite(qjc.h) ? qjc.h : 441.6, poly: qjc, ...lakeMask([qjc]) };
    const reflRoot = new THREE.Group();
    reflRoot.name = '湖面倒影';
    root.add(reflRoot);
    const lodObjs = [];
    const t0 = performance.now();

    // ───── 1. 紫云楼 ─────
    const zyY = ground(ZIYUN.x, ZIYUN.z);
    const ziyun = buildLOD(ctx, (b) => buildZiyun(b), {
      style: 'tang', instancing: true, name: '紫云楼', levels: [[2, 0], [1, 260], [0, 800]],
      flood: { color: 0xffc47a, strength: 1.5, baseY: zyY + 3, height: 42, top: 0.45 },
    });
    ziyun.position.set(ZIYUN.x, zyY, ZIYUN.z);
    ziyun.rotation.y = Math.PI; // 坐南朝北
    root.add(ziyun);
    lodObjs.push(ziyun);
    const zyTop = ziyun.userData.info?.topY ?? 40;
    ctx.labels.add('紫云楼', new THREE.Vector3(ZIYUN.x, zyY + zyTop + 6, ZIYUN.z), { category: 'landmark', minDist: 120, maxDist: 5000, priority: 2 });
    for (const dx of [-30, 30]) ctx.lights.add({ position: new THREE.Vector3(ZIYUN.x + dx, zyY + 8, ZIYUN.z - 30), color: 0xffc47a, intensity: 900, distance: 70, nightOnly: true, priority: 1.8 });

    // ───── 2. 园内唐风建筑（按足迹、按格网分簇、两级 LOD） ─────
    const clusters = new Map();
    for (const fp of state.fps) {
      const k = Math.floor(fp.x / CELL) + ',' + Math.floor(fp.z / CELL);
      if (!clusters.has(k)) clusters.set(k, []);
      clusters.get(k).push(fp);
    }
    let nBuild = 0;
    const farGroups = { fr: [], qj: [] };
    for (const [, list] of clusters) {
      const cx = list.reduce((a, f) => a + f.x, 0) / list.length, cz = list.reduce((a, f) => a + f.z, 0) / list.length;
      const origin = { x: cx, y: ground(cx, cz), z: cz };
      const lod = new THREE.LOD();
      lod.name = '园林建筑簇';
      lod.position.set(origin.x, origin.y, origin.z);
      for (const detail of [1, 0]) {
        const b = new ArchBuilder(ctx, { detail, style: 'tang', instancing: true, name: '唐风建筑' });
        for (const fp of list) {
          tangFromFootprint(b, fp, origin, ground, FACE[fp.park] ? [FACE[fp.park][0] - fp.x, FACE[fp.park][1] - fp.z] : [0, 1], { lanterns: detail >= 1 });
          if (detail === 1) nBuild++;
        }
        const g = b.build({ name: '唐风建筑-' + detail });
        lod.addLevel(g, detail === 1 ? 0 : 420);
        if (detail === 0) {
          const pk = list[0].park;
          if (pk === '大唐芙蓉园') farGroups.fr.push(g);
          else if (pk === '曲江池遗址公园') farGroups.qj.push(g);
        }
      }
      lod.addLevel(new THREE.Group(), 6500);
      root.add(lod);
      lodObjs.push(lod);
      await new Promise((r) => setTimeout(r, 0));
    }

    // ───── 3. 园门、阅江楼、岛亭、唐城墙、寒窑 ─────
    const misc = new ArchBuilder(ctx, { detail: 2, style: 'tang', instancing: true, name: '曲江园林小品' });
    const O = { x: 2900, y: ground(2900, 5900), z: 5900 };
    const put = (x, z, yaw, fn) => { misc.push(x - O.x, ground(x, z) - O.y, z - O.z, yaw); fn(misc); misc.pop(); };
    // 芙蓉园西门（御苑门外牌楼）、南门
    put(2094, 5236, -Math.PI / 2, (b) => paifang(b, { style: 'tang', bays: 5, width: 24, h: 7.5, text: '大唐芙蓉園', roofColor: 'darkgray', eaveLights: { color: 0xffc56a, width: 0.09 } }));
    put(2693, 5590, 0, (b) => paifang(b, { style: 'tang', bays: 3, width: 16, h: 6.5, text: '芙蓉園', roofColor: 'darkgray', eaveLights: { color: 0xffc56a, width: 0.09 } }));
    ctx.lights.add({ position: new THREE.Vector3(2088, ground(2088, 5236) + 7, 5236), color: 0xffc47a, intensity: 500, distance: 45, nightOnly: true, priority: 1.4 });
    // 湖岛亭 + 曲桥
    for (const lk of Object.values(lakes)) islandPavilions(misc, lk, O, ground);
    // 唐城墙遗址（夯土残段）
    for (const p of ctx.data.landuse?.polys || []) {
      if (p.k !== 'park' || !p.n || !p.n.startsWith('唐城墙')) continue;
      rammedWall(misc, p.outer, O, ground);
    }
    // 寒窑遗址公园入口牌坊
    const hy = state.parks.find((p) => p.n === '曲江寒窑遗址公园');
    if (hy) put(3800, 6738, -Math.PI / 2, (b) => paifang(b, { style: 'tang', bays: 3, width: 12, h: 5.5, text: '寒窑', roofColor: 'darkgray', eaveLights: { color: 0xffc56a, width: 0.08 } }));
    const miscG = misc.build({ name: '园门·岛亭·遗址' });
    miscG.position.set(O.x, O.y, O.z);
    root.add(miscG);

    // 阅江楼（曲江池南岸，三层唐风楼阁，面北临水）
    const yjY = ground(YUEJIANG.x, YUEJIANG.z);
    const yue = buildLOD(ctx, (b) => multiStoreyTower(b, {
      style: 'tang', floors: 3, bays: 5, depthBays: 5, bayW: 4.6, depthW: 4.6, colH: 4.8, shrink: 1.0, roof: 'xieshan', topEaves: 2,
      platformH: 2.2, platform: 'brick', railing: true, steps: 'front', roofColor: 'darkgray', plaque: '閱江樓', lanterns: true, eaveLights: { color: 0xffc56a, width: 0.09 },
    }), { style: 'tang', instancing: true, name: '阅江楼', levels: [[2, 0], [1, 220], [0, 700]], flood: { color: 0xffc47a, strength: 1.3, baseY: yjY + 2, height: 30, top: 0.4 } });
    yue.position.set(YUEJIANG.x, yjY, YUEJIANG.z);
    yue.rotation.y = Math.PI;
    root.add(yue);
    lodObjs.push(yue);
    ctx.lights.add({ position: new THREE.Vector3(YUEJIANG.x, yjY + 6, YUEJIANG.z - 26), color: 0xffc47a, intensity: 600, distance: 55, nightOnly: true, priority: 1.5 });

    // ───── 4. 驳岸 + 湖畔宫灯 ─────
    const shore = new ArchBuilder(ctx, { detail: 1, style: 'tang', instancing: true, name: '驳岸宫灯' });
    for (const lk of Object.values(lakes)) shoreline(shore, lk, O, ground);
    const shoreG = shore.build({ name: '驳岸宫灯', castShadow: false });
    shoreG.position.set(O.x, O.y, O.z);
    root.add(shoreG);

    // ───── 5. 湖面倒影 ─────
    if (lakes.fr) {
      addReflection(ctx, reflRoot, ziyun.levels[1].object, lakes.fr);
      for (const g of farGroups.fr) addReflection(ctx, reflRoot, g, lakes.fr);
      addReflection(ctx, reflRoot, miscG, lakes.fr, { solids: false });
    }
    if (lakes.qj) {
      addReflection(ctx, reflRoot, yue.levels[1].object, lakes.qj);
      for (const g of farGroups.qj) addReflection(ctx, reflRoot, g, lakes.qj);
      addReflection(ctx, reflRoot, miscG, lakes.qj);
      addReflection(ctx, reflRoot, shoreG, lakes.qj, { solids: false });
    }
    if (lakes.fr) addReflection(ctx, reflRoot, shoreG, lakes.fr, { solids: false });

    // ───── 6. 水幕电影 / 喷泉 / 激光秀（紫云楼前湖面） ─────
    let show = null;
    if (lakes.fr) {
      show = waterShow(ctx, { x: ZIYUN.x, y: lakes.fr.y, z: 5118, yaw: 0, width: 72, height: 22 });
      root.add(show.group);
      ctx.lights.add({ position: new THREE.Vector3(ZIYUN.x, lakes.fr.y + 6, 5128), color: 0x7fb8ff, intensity: 700, distance: 60, nightOnly: true, priority: 1.3 });
    }

    // ───── 7. 标注（≤4） ─────
    const fpk = state.parks.find((p) => p.n === '大唐芙蓉园');
    if (fpk) {
      const c = polyCentroid(fpk.outer);
      const cx = c.x ?? c[0], cz = c.z ?? c[1];
      ctx.labels.add('大唐芙蓉园', new THREE.Vector3(cx, ground(cx, cz) + 90, cz - 150), { category: 'landmark', minDist: 700, maxDist: 16000, priority: 2.5 });
    }
    if (lakes.qj) ctx.labels.add('曲江池遗址公园', new THREE.Vector3(3450, lakes.qj.y + 40, 6600), { category: 'district', minDist: 300, maxDist: 12000, priority: 2 });
    ctx.labels.add('唐城墙遗址公园', new THREE.Vector3(2100, ground(2100, 6112) + 25, 6112), { category: 'district', minDist: 250, maxDist: 6000, priority: 1.2 });

    const buildMs = performance.now() - t0;
    root.userData.stats = { buildMs: Math.round(buildMs), buildings: nBuild };
    console.warn('[qujiang] 构建', Math.round(buildMs), 'ms，园林建筑', nBuild, '栋');

    const cam = ctx.camera;
    let reflOn = true;
    return {
      update(dt, t) {
        const night = ctx.uniforms.uNight.value;
        if (show) show.update(t, night);
        const p = cam.position;
        const d = Math.hypot(p.x - 2900, p.z - 5900);
        reflRoot.visible = reflOn && d < 4200 && p.y < 2600;
        if (show) show.group.visible = d < 6000;
      },
      setLayer(layer, visible) { if (layer === 'landmarks') root.visible = visible; },
      setQuality(q) { reflOn = (q?.level ?? 2) >= 1; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
    };
  },
};

// ───────────── 紫云楼（局部：原点=主楼中心地面，+Z=正面=北） ─────────────
function buildZiyun(b) {
  const T = 3.2; // 大台基高
  platform(b, { w: 98, d: 36, h: T, kind: 'brick', color: 0x9a948a, capColor: 0xcfc8b8 });
  for (const [x, w] of [[0, 16], [-30, 6], [30, 6]]) { b.push(x, 0, 18, 0); steps(b, { w, h: T, color: 0xd9d3c6 }); b.pop(); }
  if (b.detail >= 1) {
    const zf = 17.7, xe = 48.7;
    for (const [a, c] of [[-xe, -33.5], [-26.5, -8.5], [8.5, 26.5], [33.5, xe]]) balustrade(b, [[a, T, zf], [c, T, zf]], { kind: 'stone', color: 0xe6e1d6 });
    balustrade(b, [[xe, T, zf], [xe, T, -zf], [-xe, T, -zf], [-xe, T, zf]], { kind: 'stone', color: 0xe6e1d6 });
  }
  // 主楼：三层 + 顶层重檐庑殿，总高约 39 m
  const info = multiStoreyTower(b, {
    style: 'tang', y0: T, floors: 3, bays: 7, depthBays: 5, bayW: 4.7, depthW: 4.4, colH: 5.4, shrink: 1.2, roof: 'wudian', topEaves: 2,
    platformH: 1.4, railing: true, steps: 'front', roofColor: 'darkgray', plaque: '紫雲樓', lanterns: true, eaveLights: { color: 0xffc56a, width: 0.1 },
  });
  // 两翼配殿 + 角楼
  for (const s of [-1, 1]) {
    b.push(s * 27.5, 0, 1.5, 0);
    hall(b, { style: 'tang', y0: T, bays: 5, bayW: 3.9, depthBays: 3, depthW: 3.8, colH: 4.6, roof: 'xieshan', roofColor: 'darkgray', platformH: 0.5, steps: 'none', front: 'tang', back: 'wall', sides: 'wall', lanterns: true, eaveLights: { color: 0xffc56a, width: 0.08 } });
    b.pop();
    b.push(s * 42.5, 0, 3, 0);
    multiStoreyTower(b, { style: 'tang', y0: T, floors: 2, bays: 3, depthBays: 3, bayW: 3.4, colH: 4.2, shrink: 0.5, roof: 'xieshan', platformH: 0.6, steps: 'none', roofColor: 'darkgray', lanterns: true, eaveLights: { color: 0xffc56a, width: 0.08 } });
    b.pop();
  }
  // 后殿两进（OSM 足迹南延部分）
  for (const [z, bays] of [[-34, 7], [-58, 5]]) {
    b.push(0, 0, z, 0);
    hall(b, { style: 'tang', bays, bayW: 4.4, depthBays: 3, depthW: 4.2, colH: 4.8, eaves: 1, roof: 'xieshan', roofColor: 'darkgray', platformH: 0.9, front: 'tang', back: 'wall', sides: 'wall', eaveLights: { color: 0xffc56a, width: 0.08 } });
    b.pop();
  }
  // 临水半圆广场（圆心 (0,-58)、半径 140 的弧，北端至湖岸）
  const arc = [];
  for (let x = -80; x <= 80; x += 8) arc.push([x, -58 + Math.sqrt(140 * 140 - x * x)]);
  const poly = [[80, 17], ...arc.slice().reverse(), [-80, 17]];
  platform(b, { poly: signedArea(poly) > 0 ? poly : poly.slice().reverse(), h: 0.3, kind: 'plain', color: 0xd4cec2 });
  if (b.detail >= 1) {
    const rail = arc.map(([x, z]) => [x, 0.3, z - 0.6]);
    const mid = (rail.length / 2) | 0;
    balustrade(b, rail.slice(0, mid - 1), { kind: 'stone', color: 0xe6e1d6 });
    balustrade(b, rail.slice(mid + 2), { kind: 'stone', color: 0xe6e1d6 });
    // 广场宫灯柱
    for (let i = 1; i < arc.length - 1; i += 2) {
      const [x, z] = arc[i];
      b.box('stone', x - 0.18, 0.3, z - 3.2, x + 0.18, 3.3, z - 2.84, 0x6f6a61);
      lantern(b, x, 3.9, z - 3.0, { kind: 'palace', size: 0.7 });
    }
  }
  return info;
}

// ───────────── 岛亭与曲桥 ─────────────
function islandPavilions(b, lk, O, ground) {
  const holes = (lk.poly.holes || []).map((h) => ({ h, a: Math.abs(polyAreaFlat(h)) })).filter((o) => o.a > 350).sort((p, q) => q.a - p.a).slice(0, 4);
  const outer = lk.poly.outer;
  holes.forEach(({ h, a }, k) => {
    const c = polyCentroid(h);
    const cx = c.x ?? c[0], cz = c.z ?? c[1];
    const y = Math.max(ground(cx, cz), lk.y + 0.6);
    b.push(cx - O.x, y - O.y, cz - O.z, 0.4 * k);
    pavilion(b, { style: 'tang', sides: a > 1500 ? 8 : 6, size: a > 1500 ? 8 : 6, eaves: a > 1500 ? 2 : 1, roofColor: 'darkgray', platformH: 0.6, lanterns: true, eaveLights: { color: 0xffc56a, width: 0.08 } });
    b.pop();
    // 最近岸点 → 曲桥（折线平桥 + 栏杆）
    let bi = 0, bd = 1e9;
    for (let i = 0; i < outer.length; i += 2) { const d = Math.hypot(outer[i] - cx, outer[i + 1] - cz); if (d < bd) { bd = d; bi = i; } }
    let hi = 0, hd = 1e9;
    for (let i = 0; i < h.length; i += 2) { const d = Math.hypot(h[i] - outer[bi], h[i + 1] - outer[bi + 1]); if (d < hd) { hd = d; hi = i; } }
    if (hd > 8 && hd < 110) {
      const ax = h[hi], az = h[hi + 1], bx = outer[bi], bz = outer[bi + 1];
      const n = Math.max(2, Math.round(hd / 14));
      const dx = (bx - ax) / hd, dz = (bz - az) / hd;
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const s = i / n, off = i === 0 || i === n ? 0 : (i % 2 ? 3 : -3);
        pts.push([ax + (bx - ax) * s - dz * off, az + (bz - az) * s + dx * off]);
      }
      const yb = lk.y + 0.9;
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const yaw = -Math.atan2(q[1] - p[1], q[0] - p[0]);
        b.push((p[0] + q[0]) / 2 - O.x, yb - O.y, (p[1] + q[1]) / 2 - O.z, yaw);
        b.box('stone', -L / 2 - 1.3, -0.35, -1.3, L / 2 + 1.3, 0, 1.3, 0xcdc6b8);
        for (let k2 = -L / 2; k2 <= L / 2; k2 += 4.5) b.box('stone', k2 - 0.25, -1.6, -0.9, k2 + 0.25, -0.35, 0.9, 0x9d978b);
        b.pop();
        if (b.detail >= 1) for (const sd of [-1.2, 1.2]) {
          const nx = -(q[1] - p[1]) / L, nz = (q[0] - p[0]) / L;
          balustrade(b, [[p[0] + nx * sd - O.x, yb - O.y, p[1] + nz * sd - O.z], [q[0] + nx * sd - O.x, yb - O.y, q[1] + nz * sd - O.z]], { kind: 'stone', color: 0xe3ded2, h: 0.8, spacing: 2 });
        }
      }
    }
  });
}
function polyAreaFlat(p) {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) { const j = (i + 1) % n; a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
  return a / 2;
}

// ───────────── 驳岸（石砌岸 + 压顶）与湖畔宫灯 ─────────────
function shoreline(b, lk, O, ground) {
  const ringList = [lk.poly.outer, ...(lk.poly.holes || [])];
  let lampAcc = 0;
  ringList.forEach((ring, ri) => {
    const n = ring.length / 2;
    if (n < 3) return;
    const sgn = polyAreaFlat(ring) > 0 ? 1 : -1;
    const outward = ri === 0 ? -sgn : sgn; // 外环：法向朝陆地（多边形外）；岛：朝岛内
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.5) continue;
      const nx = (-(bz - az) / L) * outward, nz = ((bx - ax) / L) * outward;
      const topA = Math.max(ground(ax + nx * 2, az + nz * 2), lk.y + 0.45) + 0.15;
      const topB = Math.max(ground(bx + nx * 2, bz + nz * 2), lk.y + 0.45) + 0.15;
      const yb = lk.y - 0.6;
      const P = (x, y, z) => [x - O.x, y - O.y, z - O.z];
      // 石砌立面（朝水）
      b.quad('stone', P(bx, yb, bz), P(ax, yb, az), P(ax, topA, az), P(bx, topB, bz), 0xb3ab9c);
      b.quad('stone', P(ax, yb, az), P(bx, yb, bz), P(bx, topB, bz), P(ax, topA, az), 0xb3ab9c);
      // 压顶石
      b.quad('stone', P(ax, topA, az), P(bx, topB, bz), P(bx + nx * 0.9, topB, bz + nz * 0.9), P(ax + nx * 0.9, topA, az + nz * 0.9), 0xd2ccbf);
      b.quad('stone', P(bx, topB, bz), P(ax, topA, az), P(ax + nx * 0.9, topA, az + nz * 0.9), P(bx + nx * 0.9, topB, bz + nz * 0.9), 0xd2ccbf);
      // 宫灯（外环每 ~26 m）
      if (ri === 0) {
        lampAcc += L;
        if (lampAcc > 26) {
          lampAcc = 0;
          const lx = bx + nx * 2.6, lz = bz + nz * 2.6, ly = Math.max(ground(lx, lz), lk.y + 0.5);
          b.push(lx - O.x, ly - O.y, lz - O.z, 0);
          b.box('stone', -0.16, 0, -0.16, 0.16, 2.9, 0.16, 0x5f5a52);
          b.box('stone', -0.3, 0, -0.3, 0.3, 0.35, 0.3, 0x8a857b);
          lantern(b, 0, 3.55, 0, { kind: 'palace', size: 0.62 });
          b.pop();
        }
      }
    }
  });
}

// ───────────── 唐城墙遗址：夯土残段 ─────────────
function rammedWall(b, outer, O, ground) {
  // 取最长轴
  const pts = [];
  for (let i = 0; i < outer.length; i += 2) pts.push([outer[i], outer[i + 1]]);
  let far = 0, A = pts[0], Bp = pts[0];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
    if (d > far) { far = d; A = pts[i]; Bp = pts[j]; }
  }
  if (far < 60) return;
  const ux = (Bp[0] - A[0]) / far, uz = (Bp[1] - A[1]) / far;
  const yaw = -Math.atan2(uz, ux);
  // 中线：两端点连线向多边形内侧偏移到质心线
  const c = polyCentroid(outer);
  const cx = c.x ?? c[0], cz = c.z ?? c[1];
  const off = (cx - A[0]) * -uz + (cz - A[1]) * ux;
  let s = 18, seed = Math.abs(Math.round(A[0] * 7 + A[1] * 3)) % 997;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (s < far - 20) {
    const L = 22 + rnd() * 40;
    const e = Math.min(far - 16, s + L);
    const m = (s + e) / 2;
    const x = A[0] + ux * m - uz * off, z = A[1] + uz * m + ux * off;
    const h = 4 + rnd() * 2.5;
    const y = ground(x, z);
    b.push(x - O.x, y - O.y, z - O.z, yaw);
    b.frustum('plaster', 0, 0, -0.5, e - s, 8.5, h, e - s - 3, 4.8, 0xae9168);
    // 残缺的顶面起伏
    for (let k = -(e - s) / 2 + 3; k < (e - s) / 2 - 4; k += 6 + rnd() * 5) b.box('plaster', k, h - 0.2, -2.2, k + 2 + rnd() * 3, h + 0.4 + rnd() * 0.8, 2.2, 0xa88a60);
    b.pop();
    s = e + 10 + rnd() * 22;
  }
}
