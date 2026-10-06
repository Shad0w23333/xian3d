// 片区街景：用户点名片区（未央国际商圈·凤城七路 / 曲江 W 酒店·万众国际 / 浐灞 / 回民街·洒金桥）的“街景级”环境物件——
// 完整街道断面（抬高花池绿篱 + 红色非机动车道 + 方砖人行道 + 草坪树列）、公交候车亭（OSM 站名）、商场/酒店前铺装广场与小品
// （树阵、灯柱、坐凳、护柱、旗杆）、地面停车场（车位线 + 停放车辆）、落客环道、住宅区围墙与大门（门卫亭 + 名牌）、
// 路口悬臂信号灯、回坊街边摊位（遮阳棚 + 灯箱 + 灯泡串）与横跨街道的灯笼串。
// 数据：src/arch/streetscape-data.js；几何：src/arch/streetscape-gen.js；调研：research/refs/districts/
// 注册在 buildings / vegetation 之前：prepare 里登记广场/停车场排除区（通用低层建筑与树木让位）并压平地形。
import * as THREE from 'three';
import { DISTRICTS } from '../arch/streetscape-data.js';
import { StreetscapeBuilder, makeMaterials, NameAtlas, roadIndex, normalizeDistrict } from '../arch/streetscape-gen.js';

export default {
  id: 'streetscape',
  name: '片区街景',

  prepare(ctx) {
    for (const D of DISTRICTS) {
      normalizeDistrict(D);
      for (const P of D.plazas || []) {
        ctx.exclusions.add({ points: P.poly, name: 'streetscape:' + P.name }, { buildings: true, trees: true, pois: false, maxHeight: 14 });
        ctx.terrain.addFlatten({ points: P.poly, height: null, feather: 6 });
      }
      for (const P of D.parkings || []) {
        ctx.exclusions.add({ points: P.poly, name: 'streetscape:' + P.name }, { buildings: true, trees: true, pois: false, maxHeight: 12 });
        ctx.terrain.addFlatten({ points: P.poly, height: null, feather: 6 });
      }
    }
  },

  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = '片区街景';
    ctx.scene.add(root);
    const atlas = new NameAtlas();
    const M = makeMaterials(ctx);
    M.names = new THREE.MeshStandardMaterial({ map: atlas.texture, emissiveMap: atlas.texture, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.5 });
    ctx.night.register(M.names, { day: 0.0, night: 1.3 });
    const groups = [];
    const summary = {};
    let nLights = 0;
    for (const D of DISTRICTS) {
      const idx = roadIndex(ctx.data.roads, D.bbox);
      const B = new StreetscapeBuilder(ctx, M, atlas);
      B.buildPlazas(D);
      B.buildParkings(D);
      B.buildDrives(D);
      B.buildStreets(D, idx);
      B.buildBusStops(D, idx);
      B.buildWalls(D);
      B.buildSignals(D);
      B.buildStalls(D, idx);
      B.buildLights(D, idx);
      const g = new THREE.Group();
      g.name = '街景-' + D.name;
      root.add(g);
      const st = B.finish(g, D.id);
      summary[D.id] = st;
      // 重要光源：广场灯柱 / 大门 / 候车亭中抽样登记到动态点光源池（每片区 ≤ 14 盏）
      const pts = B.lightPts;
      const every = Math.max(1, Math.ceil(pts.length / 14));
      for (let i = 0; i < pts.length; i += every) {
        const [x, y, z, k] = pts[i];
        ctx.lights.add({ position: new THREE.Vector3(x, y, z), color: 0xffd9a8, intensity: 260 * k, distance: 32, nightOnly: true, priority: 0.4 });
        nLights++;
      }
      groups.push({ g, D });
    }
    atlas.paint();
    console.warn(`[streetscape] ${JSON.stringify(summary)} 点光源 ${nLights} 耗时 ${(performance.now() - t0).toFixed(0)} ms`);

    const cam = ctx.camera;
    let frame = 0;
    const updateVis = () => {
      const cx = cam.position.x, cz = cam.position.z;
      for (const { g, D } of groups) g.visible = Math.hypot(cx - D.center[0], cz - D.center[1]) < D.radius + 1500;
    };
    updateVis();
    return {
      update() {
        if ((++frame & 15) === 0) updateVis();
      },
      setLayer(name, on) {
        if (name === 'streetscape') root.visible = on;
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};
