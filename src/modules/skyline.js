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
import { DISTRICTS, towerSpecs as towerSpecs1, mallSpecs as mallSpecs1, SPECIAL } from '../arch/sky-data.js';
import { SUPERSEDED, towerSpecs2, mallSpecs2, SPECIAL2, special2Footprints } from '../arch/sky-data2.js';
import * as SP2 from '../arch/sky-special2.js';

// 2026-09 地标更新（sky-data2.js）取代失真的旧定义（熙地港、大融城、未央国际）
const towerSpecs = () => towerSpecs1().filter((t) => !SUPERSEDED.has(t.key)).concat(towerSpecs2());
const mallSpecs = () => mallSpecs1().filter((m) => !SUPERSEDED.has(m.key)).concat(mallSpecs2());

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
const HFIX = { 西安公路研究院: 60 };
function genericFeatures(ctx, curated) {
  const feats = (ctx.data.skyline?.features || []).filter((f) => f.outer?.length >= 6 && f.h >= 34 && Math.hypot(f.x, f.z) < 47000);
  const out = [];
  for (const f of feats) {
    if (curated.names.has(f.n)) continue;
    if (curated.polys.some((p) => G.pointIn(f.x, f.z, p))) continue;
    out.push({ ...f, h: HFIX[f.n] ?? f.h });
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
  const towers = towerSpecs();
  for (const t of towers) { polys.push(G.ccw(t.pts)); if (t.podium) polys.push(G.ccw(t.podium.pts)); }
  for (const m of mallSpecs()) polys.push(G.ccw(m.pts));
  const S = SPECIAL;
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
  const curated = { names: new Set(towers.map((t) => t.name)), polys: polys.slice() };
  for (const f of genericFeatures(ctx, curated)) polys.push(G.ccw(f.outer));
  return { polys, curated };
}

export default {
  id: 'skyline',
  name: '现代地标与摩天楼',
  prepare(ctx) {
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
    for (const s of towerSpecs()) safe(s.name, () => {
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
    for (const m of mallSpecs()) safe(m.key, () => {
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
    // —— 特殊地标 ——
    safe('电视塔', () => SP.buildTVTower(env('south'), SPECIAL.tv));
    safe('环球贸易中心1号楼', () => SP.buildUnderConstruction(env('weiyang'), SPECIAL.igc1));
    safe('长安塔', () => SP.buildChanganTower(env('chanba'), SPECIAL.changan));
    safe('奥体中心', () => SP.buildAoti(env('chanba'), SPECIAL.aoti));
    safe('西安北站', () => SP.buildNorthStation(env('north'), SPECIAL.north));
    for (const c of SPECIAL.conf) safe('会议中心', () => SP.buildConference(env('chanba'), c));
    SPECIAL.expo.forEach((p, i) => safe('展馆', () => SP.buildHall(env('chanba'), p, { h: 18, rise: 7 })));
    for (const p of SPECIAL.gov) safe('行政中心', () => {
      const o = G.obb(G.ccw(p));
      const main = Math.abs(G.area(p)) > 3500 && o.w / o.d > 2.4;
      SP.buildGovBlock(env('weiyang'), p, { h: main ? 42 : o.w * o.d > 2000 ? 22 : 16 });
    });
    // —— 2026-09 新增：曲江 W 酒店·万众国际、浐灞凯悦 / 彩虹桥 / 蝴蝶桥 / 后海夜市 ——
    safe('万众国际·W酒店', () => SP2.buildW(env('south'), SPECIAL2.w));
    safe('浐灞凯悦', () => SP2.buildHyatt(env('chanba'), SPECIAL2.hyatt));
    safe('彩虹桥', () => root.add(SP2.buildRainbowBridge(env('chanba'), SPECIAL2.rainbow)));
    safe('蝴蝶桥', () => root.add(SP2.buildButterflyBridge(env('chanba'), SPECIAL2.butterfly)));
    safe('后海夜市', () => root.add(SP2.buildHouhai(env('chanba'), SPECIAL2.houhai)));
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
    const tv = SPECIAL.tv, ca = SPECIAL.changan, ao = SPECIAL.aoti.stadium;
    ctx.labels.add('陕西广播电视塔', new THREE.Vector3(tv.cx, ctx.terrain.heightAt(tv.cx, tv.cz) + 252, tv.cz), { category: 'landmark', priority: 2.5, minDist: 150 });
    ctx.labels.add('长安塔', new THREE.Vector3(ca.cx, ctx.terrain.heightAt(ca.cx, ca.cz) + 106, ca.cz), { category: 'landmark', priority: 2, minDist: 120 });
    ctx.labels.add('西安奥体中心', new THREE.Vector3(ao.cx, ctx.terrain.heightAt(ao.cx, ao.cz) + 70, ao.cz), { category: 'landmark', priority: 2, minDist: 200 });

    const stats = { towers: towerSpecs().length, generic: gen.length, ms: Math.round(performance.now() - t0), errors };
    console.warn('[skyline] 构建完成 ' + JSON.stringify(stats));
    const tmpBox = new THREE.Box3();
    void tmpBox;
    return {
      stats,
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
