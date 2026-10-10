// 小区与校园内部（新模块）：西安常见的封闭式住宅小区与校园——围墙/铁艺围栏、大门（门头 + 门岗亭 + 道闸 + 小区名）、
// 宅前车行道与地面停车（车位线 + 停放车辆）、宅间草坪/绿篱/灌木/园路、健身器材、儿童游乐、凉亭廊架、
// 自行车棚/电动车充电棚、单元门前电动车、垃圾分类亭、快递柜、地下车库坡道、晾衣杆、小乔木与灌木球、花坛；
// 校园：田径场（塑胶跑道 + 人工草坪 + 球门 + 看台）、篮球场/网球场、升旗台；夜间庭院灯（灯下光斑）与门岗亮灯。
//
// 数据：landuse.json（residential / university 多边形）+ buildings.bin（楼栋轮廓、年代、高度）+ roads.json（市政路与小区内道路）
//       + estates_style.json（有照片依据的大门：只开口、接车道，门楼由通用建筑模块画）
//       + sports.json（OSM 操场/球场，tools/build_sports.py 生成；缺失时不画场地）。
// 老小区（1990 年代及以前、以 6~7 层板楼为主）与新小区（高层塔楼）区别：
//   老：水泥宅间路（约 4 m）、垂直车位为主且一半不画线、路边乱停、砖墙/花格墙、自行车棚多、门前电动车多、晾衣杆、草坪斑驳、绿篱少；
//   新：沥青车行道（5.5 m）、植草砖平行车位、铁艺围栏 + 石材基座、门头石材门柱/景墙、电动车充电棚、儿童游乐、凉亭廊架、花坛、车库坡道。
//
// prepare：全城一次性规划（src/arch/compound-plan.js，约 2 s，按 40 ms 时间片让出主线程），然后
//   · 把车行道/停车/园路/铺装/设施/运动场地登记为“只让树”的排除区（buildings/roads/pois 均 false），植被模块据此不在路面和
//     车位上种树（所以本模块排在 vegetation 之前）；
//   · 把宅间绿地作为无名“公园”小地块（a = 0，用地着色层不画）追加进 ctx.data.landuse，植被模块按公园密度在里面种树
//     （与未央城市广场模块在 prepare 里就地改用地/路网数据的做法相同）。
// build：相机附近约 1.5 km（按画质）内按 500 m 块流式生成（src/arch/compound-gen.js，分帧推进，单步 ≤ 约 10 ms），远处卸载；
//   绘制（全部合批，共 9 个 draw call + 4 个阴影）：贴地面层 1 个 BatchedMesh（每块“基础 + 近看细节”两份几何，自定义着色器
//   按面层种类画沥青/草坪/铺装/塑胶/球场/标线/花坛）、实体 1 个 BatchedMesh（每块“远看/近看”两份）、透明栏杆 1 个、
//   夜间发光体 1 个、灯下光斑 1 个、停放车辆近景/远景各 1 个 InstancedMesh、树冠广告牌 1 个 InstancedMesh、
//   门头名称牌 1 个网格（8 个槽位的文字图集）。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';
import { parseBld, planIter, exclusionRings, chunkIndex, prepSports, rectWorld, CHUNK } from '../arch/compound-plan.js';
import { genChunk, K } from '../arch/compound-gen.js';
import { carNear, carFar, leafTexture, flowerTexture } from '../arch/compound-props.js';

// 按画质档位（0 低 … 3 超高）
const RADIUS = [700, 1000, 1500, 1800]; // 生成半径（米）
const FINE_R = [180, 300, 450, 600]; // 近看实体（器材、灯杆、灌木、绿篱、车棚里的车）
const COARSE_R = [450, 700, 1050, 1350]; // 远看实体（围墙、门头、岗亭、车棚、凉亭、球场设施）
const ALPHA_R = [350, 550, 850, 1100]; // 透明栏杆
const CAR_NEAR_R = [90, 160, 260, 340];
const CAR_FAR_R = [350, 550, 850, 1100];
const FLOWER_R = [50, 80, 120, 160]; // 花坛花丛实例（更远处由面层花坛底色代替）
const MAX_AGL = 1100; // 相机离地高于此值不生成/不显示
const SIGN_SLOTS = 8;

// —— BatchedMesh 管理：按块增删几何，空间不足时先整理再扩容 ——
class Batch {
  constructor(name, material, verts, { shadow = false, receive = true, order = 0 } = {}) {
    this.mesh = new THREE.BatchedMesh(64, verts, 0, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false; // 整体包围球随增删变化，交给逐实例剔除
    this.mesh.perObjectFrustumCulled = true;
    this.mesh.sortObjects = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = receive;
    this.mesh.renderOrder = order;
    this.cap = verts;
    this.live = 0; // 活动顶点数
  }
  add(geo) {
    const nv = geo.attributes.position.count;
    if (!nv) return null;
    const m = this.mesh;
    let gid;
    if (m._nextVertexStart + nv > this.cap) {
      m.optimize();
      if (m._nextVertexStart + nv > this.cap) {
        this.cap = Math.ceil(Math.max(this.cap * 1.5, m._nextVertexStart + nv * 2));
        m.setGeometrySize(this.cap, 0);
      }
    }
    gid = m.addGeometry(geo);
    if (m._instanceInfo.length >= m.maxInstanceCount && !m._availableInstanceIds.length) m.setInstanceCount(m.maxInstanceCount * 2);
    const iid = m.addInstance(gid);
    this.live += nv;
    return { gid, iid, nv };
  }
  remove(h) {
    if (!h) return;
    this.mesh.deleteGeometry(h.gid);
    this.live -= h.nv;
  }
  vis(h, on) {
    if (h && this.mesh.getVisibleAt(h.iid) !== on) this.mesh.setVisibleAt(h.iid, on);
  }
}

// —— 面层着色器（世界米坐标 uv 上的程序化细节） ——
const GROUND_FRAG = /* glsl */ `
varying float vK;
varying vec2 vUvF;
float cmpH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cmpN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cmpH(i), cmpH(i + vec2(1.0, 0.0)), f.x), mix(cmpH(i + vec2(0.0, 1.0)), cmpH(i + vec2(1.0, 1.0)), f.x), f.y); }
`;
const GROUND_APPLY = /* glsl */ `
{
  int k = int(vK + 0.5);
  vec2 p = vUvF;
  float fw = max(length(fwidth(p)), 1e-4);
  float near = 1.0 - clamp(fw * 3.0, 0.0, 1.0); // 近处才画细纹理
  vec3 c = diffuseColor.rgb;
  if (k == ${K.ASPHALT} || k == ${K.CONCRETE}) {
    float n = cmpN(p * 2.7) * 0.55 + cmpN(p * 0.6) * 0.45;
    c *= 0.86 + n * 0.24 + (cmpH(floor(p * 30.0)) - 0.5) * 0.08 * near;
    if (k == ${K.CONCRETE}) {
      vec2 q = abs(fract(p / 4.0 + 0.5) - 0.5) * 4.0;
      float j = min(q.x, q.y);
      c *= mix(0.8, 1.0, smoothstep(0.015, 0.04 + fw, j) * near + (1.0 - near));
    }
  } else if (k == ${K.LAWN}) {
    float n1 = cmpN(p * 0.8), n2 = cmpN(p * 3.7 + 11.0);
    c *= 0.8 + n1 * 0.28 + (n2 - 0.5) * 0.16 + (cmpH(floor(p * 14.0)) - 0.5) * 0.12 * near;
    c = mix(c, c * vec3(1.22, 1.12, 0.72), smoothstep(0.6, 0.86, cmpN(p * 0.21 + 7.0)) * 0.55);
    c = mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))), 0.18); // 略降饱和（阳光直射下不发荧光绿）
  } else if (k == ${K.PAVER} || k == ${K.PAVER_R}) {
    vec2 s = k == ${K.PAVER} ? vec2(0.6, 0.3) : vec2(0.24, 0.115);
    vec2 q = p / s;
    q.x += step(1.0, mod(floor(q.y), 2.0)) * 0.5;
    vec2 f = fract(q), id = floor(q);
    float joint = min(min(f.x, 1.0 - f.x) * s.x, min(f.y, 1.0 - f.y) * s.y);
    float jm = smoothstep(0.003, 0.01 + fw * 0.5, joint);
    float fade = clamp(fw / (s.y * 0.6), 0.0, 1.0);
    c *= mix(mix(0.74, 1.0, jm) * (0.9 + cmpH(id) * 0.2), 0.94, fade);
  } else if (k == ${K.RUBBER}) {
    c *= 0.9 + (cmpH(floor(p * 25.0)) - 0.5) * 0.14 * near + cmpN(p * 1.3) * 0.1;
  } else if (k == ${K.COURT}) {
    c *= 0.94 + cmpN(p * 1.7) * 0.1;
  } else if (k == ${K.PAINT}) {
    c *= 0.85 + cmpN(p * 4.0) * 0.18;
  } else if (k == ${K.CURB}) {
    c *= 0.9 + cmpN(p * 3.0) * 0.14;
  } else if (k == ${K.GRASSPAVE}) {
    vec2 f = fract(p / 0.42);
    float g = step(0.2, f.x) * step(f.x, 0.8) * step(0.2, f.y) * step(f.y, 0.8);
    vec3 conc = vec3(0.36, 0.355, 0.33), grass = vec3(0.11, 0.17, 0.065) * (0.8 + cmpN(p * 2.3) * 0.5);
    float fade = clamp(fw * 4.0, 0.0, 1.0);
    c = mix(mix(conc, grass, g), mix(conc, grass, 0.4), fade) * (0.92 + cmpN(p * 0.7) * 0.16);
  } else if (k == ${K.FLOWER}) {
    // 花坛底：深褐覆盖物（树皮屑/土）夹少量叶色；近处由花丛实例盖满，远处（花丛实例之外）按顶点色出一片低饱和的花色
    // （原先按 0.33 m 格撒红黄紫圆点，人眼高度看像波点布、40 m 看是彩色马赛克，审查 st_chanba_road / fe_经开小区）
    float n = cmpN(p * 3.1);
    vec3 mulch = vec3(0.075, 0.06, 0.045) * (0.8 + 0.4 * n);
    mulch = mix(mulch, vec3(0.055, 0.085, 0.035), smoothstep(0.55, 0.8, cmpN(p * 1.7 + 4.0)) * 0.6);
    c = mix(c * (0.9 + 0.2 * n), mulch, near * 0.85);
  } else if (k == ${K.SOIL}) {
    c *= 0.82 + cmpN(p * 1.1) * 0.3;
    c = mix(c, vec3(0.16, 0.2, 0.08), smoothstep(0.5, 0.8, cmpN(p * 0.9 + 3.0)) * 0.6);
  }
  diffuseColor.rgb = c;
}
`;

function groundMaterial(ctx) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aK;\nvarying float vK;\nvarying vec2 vUvF;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvK = aK;\nvUvF = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GROUND_FRAG)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + GROUND_APPLY)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        { int kk = int(vK + 0.5); if (kk == ${K.PAINT}) roughnessFactor = 0.62; else if (kk == ${K.RUBBER} || kk == ${K.COURT}) roughnessFactor = 0.8; else if (kk == ${K.ASPHALT}) roughnessFactor = 0.88; }`,
      );
  };
  m.customProgramCacheKey = () => 'compounds-ground-v2';
  ctx.overlay(m, 0.00025);
  return m;
}

/** 铁艺栏杆 / 花格图集（下半 = 铁艺竖杆，宽 1 m；上半 = 花格砌块，宽 1.25 m） */
function fenceAtlas() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  // 下半（canvas y ∈ [128, 256)，对应 uv.y ∈ [0, 0.5)）：铁艺栏杆
  const y0 = 128, H = 128;
  g.fillStyle = '#ffffff';
  const bars = 8;
  for (let i = 0; i < bars; i++) {
    const x = (i + 0.5) * (S / bars);
    g.fillRect(x - 3, y0 + 4, 6, H - 4);
    // 矛头
    g.beginPath();
    g.moveTo(x - 6, y0 + 10);
    g.lineTo(x, y0);
    g.lineTo(x + 6, y0 + 10);
    g.fill();
  }
  g.fillRect(0, y0 + 16, S, 7); // 上横杆
  g.fillRect(0, y0 + H - 12, S, 8); // 下横杆
  g.fillRect(0, y0 + 30, S, 4);
  // 上横杆与次横杆之间的装饰圈
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3;
  for (let i = 0; i < bars; i++) {
    g.beginPath();
    g.arc((i + 1) * (S / bars), y0 + 26, 6, 0, Math.PI * 2);
    g.stroke();
  }
  // 上半（canvas y ∈ [0, 128)）：花格（混凝土镂空砌块，2 × 4 块）
  const bw = S / 4, bh = 64;
  for (let r = 0; r < 2; r++)
    for (let q = 0; q < 4; q++) {
      const x = q * bw, y = r * bh;
      g.fillStyle = '#ffffff';
      g.fillRect(x, y, bw, bh);
      g.globalCompositeOperation = 'destination-out';
      // 四个四分之一圆缺 + 中心菱形：典型“古钱/海棠”花格
      g.beginPath();
      g.ellipse(x + bw / 2, y + bh / 2, bw * 0.38, bh * 0.38, 0, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(x + bw / 2, y + bh * 0.18);
      g.lineTo(x + bw * 0.82, y + bh / 2);
      g.lineTo(x + bw / 2, y + bh * 0.82);
      g.lineTo(x + bw * 0.18, y + bh / 2);
      g.closePath();
      g.fill();
      g.globalCompositeOperation = 'destination-out';
      g.beginPath();
      g.ellipse(x + bw / 2, y + bh / 2, bw * 0.12, bh * 0.12, 0, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'source-over';
      g.fillRect(x, y, bw, 4); g.fillRect(x, y, 4, bh);
    }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export default {
  id: 'compounds',
  name: '小区与校园内部',

  async prepare(ctx) {
    const t0 = performance.now();
    const bld = parseBld(ctx.data.buildings instanceof ArrayBuffer ? ctx.data.buildings : ctx.data.buildings?.buffer);
    if (!bld) return;
    // 高德住宅小区（真实名称 + 出入口坐标，tools/build_compounds_amap.py 生成，私有本地数据，可缺省）
    const [estates, sportsRaw, amap] = await Promise.all([
      loadJSON('estates_style.json', { optional: true }),
      loadJSON('sports.json', { optional: true }),
      loadJSON('local/compounds_amap.json', { optional: true }),
    ]);
    const sports = prepSports(sportsRaw);
    const E = ctx.exclusions;
    const excluded = (x, z) => !!(E && E.items.length && E.test(x, z, 'buildings'));
    const it = planIter({ landuse: ctx.data.landuse, roads: ctx.data.roads, bld, estates, excluded, sports, amap });
    let r, ts = performance.now();
    while (!(r = it.next()).done) {
      if (performance.now() - ts > 40) {
        await new Promise((res) => setTimeout(res, 0));
        ts = performance.now();
      }
    }
    const plan = r.value;
    // 植被排除区：车行道/停车/园路/铺装带/设施（只让树）
    const ONLY_TREES = { buildings: false, trees: true, roads: false, pois: false };
    let nEx = 0, nGarden = 0;
    for (const c of plan.list) {
      for (const ring of exclusionRings(c)) {
        E.add({ points: ring, name: 'compounds' }, ONLY_TREES);
        nEx++;
      }
    }
    // 运动场地：整块不种树（外扩 2 m）
    for (const f of sports) {
      if (excluded(f.cx, f.cz)) continue;
      const ca = Math.cos(f.ang), sa = Math.sin(f.ang), hl = f.L / 2 + 2, hb = f.B / 2 + 2;
      const pts = [];
      for (const [a, b] of [[-hl, -hb], [hl, -hb], [hl, hb], [-hl, hb]]) pts.push(f.cx + a * ca - b * sa, f.cz + a * sa + b * ca);
      E.add({ points: pts, name: 'compounds' }, ONLY_TREES);
      nEx++;
    }
    // 宅间绿地：作为无名“公园”小地块加入用地数据（a = 0 → 用地着色层不画），植被模块按公园密度在里面种树
    // （园路、设施、停车已是排除区，树只会落在草坪上）。与未央城市广场模块就地改用地数据的做法一致。
    const lu = ctx.data.landuse;
    if (lu && Array.isArray(lu.polys)) {
      for (const c of plan.list) {
        // 老小区宅间由本模块按 9~10 m 种大树（compound-plan.js 第 9 步），不再交给植被模块按公园密度另种
        if (c.mode === 'old') continue;
        for (const g of c.gardens || []) {
          if ((g.u1 - g.u0) * (g.v1 - g.v0) < 60) continue;
          const outer = rectWorld(c, g.u0, g.u1, g.v0, g.v1).map((v) => Math.round(v * 10) / 10);
          lu.polys.push({ k: 'park', n: '', outer, holes: [], a: 0, boost: 0.85, src: 'compounds' });
          nGarden++;
        }
      }
    }
    this.plan = plan;
    this.chunkMap = chunkIndex(plan.list);
    const st = plan.stats;
    let nBig = 0;
    for (const c of plan.list) nBig += (c.bigTrees || []).length;
    console.log(
      `[compounds] 规划 ${st.planned}/${st.cand} 个小区/校园（跳过城中村 ${st.skipVillage}、无楼 ${st.skipEmpty}、精建区 ${st.skipExcl}）：` +
        `车行道 ${st.lanes}、连接道 ${st.conns}、大门 ${st.gates}、车位 ${st.stalls}、设施 ${st.pads}、园路 ${st.paths}、运动场地 ${sports.length}；排除区 ${nEx} 片、宅间绿地 ${nGarden} 块、老小区宅间大树 ${nBig} 棵；高德小区 ${st.amap}/${amap?.items?.length ?? 0} 条挂到用地、按出入口开门 ${st.amapGates}；${(performance.now() - t0).toFixed(0)} ms`,
    );
  },

  async build(ctx) {
    if (!this.plan) return {};
    const T = ctx.terrain;
    const root = new THREE.Group();
    root.name = '小区与校园内部';
    ctx.scene.add(root);
    const S = {
      list: this.plan.list,
      chunkMap: this.chunkMap,
      index: this.plan.index,
      terrain: T,
      excluded: (x, z) => ctx.exclusions.test(x, z, 'buildings'),
    };
    let level = Math.max(0, Math.min(3, ctx.quality.level ?? 2));

    // —— 材质 ——
    const matGround = groundMaterial(ctx);
    const matSolid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.04, side: THREE.DoubleSide });
    const atlas = fenceAtlas();
    const matAlpha = new THREE.MeshStandardMaterial({ vertexColors: true, map: atlas, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.35 });
    const leafTex = new THREE.CanvasTexture(leafTexture());
    leafTex.colorSpace = THREE.SRGBColorSpace;
    leafTex.anisotropy = 4;
    const flowerTex = new THREE.CanvasTexture(flowerTexture());
    flowerTex.colorSpace = THREE.SRGBColorSpace;
    flowerTex.anisotropy = 4;
    // 小乔木树冠：球面广告牌（始终正对相机/光源，任何角度都没有“插片”的边线；阴影通道里正对光源，投下圆形树影）
    const BILL = (sh) => {
      sh.vertexShader = sh.vertexShader.replace(
        '#include <project_vertex>',
        `vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float bsx = length(instanceMatrix[0].xyz), bsy = length(instanceMatrix[1].xyz);
        mvPosition.xy += position.xy * vec2(bsx, bsy);
        gl_Position = projectionMatrix * mvPosition;`,
      );
    };
    const matLeaf = new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    matLeaf.onBeforeCompile = (sh) => {
      BILL(sh);
      // 统一朝上的法线（广告牌各处受光一致，像一团树冠）
      sh.vertexShader = sh.vertexShader.replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\ntransformedNormal = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));');
    };
    matLeaf.customProgramCacheKey = () => 'compounds-crown-v2';
    // 花坛花丛：同一套球面广告牌；贴图里近白的花朵换成实例色（各花坛一种花色），叶片保持绿色
    const matFlower = new THREE.MeshStandardMaterial({ map: flowerTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    matFlower.onBeforeCompile = (sh) => {
      BILL(sh);
      sh.vertexShader = sh.vertexShader.replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\ntransformedNormal = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));');
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <color_fragment>',
        `{ float bl = smoothstep(0.22, 0.45, min(sampledDiffuseColor.r, sampledDiffuseColor.b));
           diffuseColor.rgb = mix(diffuseColor.rgb, vColor.rgb * (0.55 + 0.6 * dot(sampledDiffuseColor.rgb, vec3(0.333))), bl); }`,
      );
    };
    matFlower.customProgramCacheKey = () => 'compounds-flower-v1';
    const matLeafDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide });
    matLeafDepth.onBeforeCompile = BILL;
    matLeafDepth.customProgramCacheKey = () => 'compounds-crown-depth-v1';
    const matGlow = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0 });
    matGlow.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vWin;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = uv.x;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vWin;')
        // 白天：灯头是磨砂白、窗是深色玻璃；夜间：按顶点色发光
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(vec3(0.62, 0.6, 0.56), vec3(0.06, 0.08, 0.09), step(0.5, vWin));')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vColor.rgb;');
    };
    matGlow.customProgramCacheKey = () => 'compounds-glow-v1';
    ctx.night.register(matGlow, { day: 0, night: 2.4 });
    const uPool = { value: 0 };
    const matPool = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    matPool.onBeforeCompile = (sh) => {
      sh.uniforms.uPool = uPool;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vPuv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPuv = uv;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPuv;\nuniform float uPool;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n{ float r = length(vPuv - 0.5) * 2.0; float f = max(0.0, 1.0 - r); diffuseColor.rgb *= f * f * (0.6 + 0.4 * f) * uPool * 1.1; }');
    };
    matPool.customProgramCacheKey = () => 'compounds-pool-v1';
    ctx.overlay(matPool, 0.0004);

    const bGround = new Batch('小区·面层', matGround, 700000, { receive: true });
    const bSolid = new Batch('小区·实体', matSolid, 1200000, { shadow: true });
    const bAlpha = new Batch('小区·栏杆', matAlpha, 30000, { shadow: true });
    const bGlow = new Batch('小区·灯', matGlow, 60000, { receive: false });
    const bPool = new Batch('小区·光斑', matPool, 20000, { receive: false, order: 2 });
    for (const b of [bGround, bSolid, bAlpha, bGlow, bPool]) root.add(b.mesh);
    bPool.mesh.visible = false;

    // —— 停放车辆 ——
    const matCar = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.35 });
    const CAP_NEAR = 3000, CAP_FAR = 12000;
    const carN = new THREE.InstancedMesh(carNear(), matCar, CAP_NEAR);
    const carF = new THREE.InstancedMesh(carFar(), matCar, CAP_FAR);
    for (const m of [carN, carF]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.count * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.receiveShadow = true;
      root.add(m);
    }
    carN.castShadow = true;
    const CAP_CROWN = 64000;
    const crown = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), matLeaf, CAP_CROWN);
    crown.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    crown.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP_CROWN * 3), 3);
    crown.instanceColor.setUsage(THREE.DynamicDrawUsage);
    crown.count = 0;
    crown.frustumCulled = false;
    crown.castShadow = true;
    crown.receiveShadow = false;
    crown.customDepthMaterial = matLeafDepth;
    crown.name = '小区·树冠';
    root.add(crown);
    const CAP_FLOWER = 16000;
    const flower = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), matFlower, CAP_FLOWER);
    flower.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    flower.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP_FLOWER * 3), 3);
    flower.instanceColor.setUsage(THREE.DynamicDrawUsage);
    flower.count = 0;
    flower.frustumCulled = false;
    flower.name = '小区·花坛花丛';
    root.add(flower);
    carN.name = '小区·停放车辆（近）';
    carF.name = '小区·停放车辆（远）';

    // —— 门头名称牌：8 槽文字图集 + 一个网格 ——
    const signCv = document.createElement('canvas');
    signCv.width = 1024;
    signCv.height = 128 * SIGN_SLOTS;
    const signG = signCv.getContext('2d');
    const signTex = new THREE.CanvasTexture(signCv);
    signTex.colorSpace = THREE.SRGBColorSpace;
    signTex.anisotropy = 4;
    const matSign = new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.45, metalness: 0.2 });
    ctx.night.register(matSign, { day: 0.05, night: 1.4 });
    const signGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(SIGN_SLOTS * 4 * 3), sUv = new Float32Array(SIGN_SLOTS * 4 * 2), sNor = new Float32Array(SIGN_SLOTS * 4 * 3);
    const sIdx = [];
    for (let i = 0; i < SIGN_SLOTS; i++) sIdx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    signGeo.setIndex(sIdx);
    signGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3).setUsage(THREE.DynamicDrawUsage));
    signGeo.setAttribute('uv', new THREE.BufferAttribute(sUv, 2).setUsage(THREE.DynamicDrawUsage));
    signGeo.setAttribute('normal', new THREE.BufferAttribute(sNor, 3).setUsage(THREE.DynamicDrawUsage));
    const signMesh = new THREE.Mesh(signGeo, matSign);
    signMesh.frustumCulled = false;
    signMesh.name = '小区·门头名称';
    root.add(signMesh);
    const slots = Array.from({ length: SIGN_SLOTS }, () => ({ key: null, w: 0 }));
    const drawSlot = (k, s) => {
      const y = k * 128;
      signG.clearRect(0, y, 1024, 128);
      // 底：新小区深灰石材 + 金色字；老小区白底红字；校园黑底金字
      const bg = s.old ? '#f2efe8' : s.uni ? '#1f2326' : '#3a3b3d';
      const fg = s.old ? '#b5221b' : '#d9b46a';
      signG.fillStyle = bg;
      signG.fillRect(0, y, 1024, 128);
      signG.strokeStyle = s.old ? '#b5221b' : '#8a7448';
      signG.lineWidth = 5;
      signG.strokeRect(6, y + 6, 1012, 116);
      const txt = s.text;
      let size = 84;
      signG.font = `700 ${size}px "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif`;
      let tw = signG.measureText(txt).width;
      if (tw > 960) { size = Math.floor((size * 960) / tw); signG.font = `700 ${size}px "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif`; tw = signG.measureText(txt).width; }
      signG.fillStyle = fg;
      signG.textAlign = 'center';
      signG.textBaseline = 'middle';
      signG.fillText(txt, 512, y + 66);
      slots[k].aspect = Math.max(2.5, Math.min(8, (tw + 80) / 128));
    };

    // —— 门岗夜间点光源（3 盏，挪到最近的大门） ——
    const gateLights = [];
    for (let i = 0; i < 3; i++) {
      const s = ctx.lights.add({ position: new THREE.Vector3(0, -1e4, 0), color: 0xffd6a0, intensity: 70, distance: 18, nightOnly: true, priority: 0.5 });
      s.enabled = false;
      gateLights.push(s);
    }

    // —— 块管理 ——
    const chunks = new Map(); // key -> {ci,cj, h:{...}, cars, signs, gates}
    const allKeys = [...this.chunkMap.keys()].map((k) => k.split(',').map(Number));
    let job = null; // {key, ci, cj, it}
    const queue = [];
    const camP = ctx.camera.position;
    const lastP = new THREE.Vector3(1e9, 0, 0);
    let frame = 0, visible = true, dirtyCars = true;
    const chunkDist = (ci, cj, x, z) => {
      const dx = Math.max(ci * CHUNK - x, 0, x - (ci + 1) * CHUNK), dz = Math.max(cj * CHUNK - z, 0, z - (cj + 1) * CHUNK);
      return Math.hypot(dx, dz);
    };
    const finish = (key, ci, cj, W) => {
      const rec = { ci, cj, cars: new Float32Array(W.cars), crowns: new Float32Array(W.crowns), bigCrowns: new Float32Array(W.bigCrowns), flowers: new Float32Array(W.flowers), signs: W.signs, gates: W.gates, h: {} };
      const geo = (w) => (w.count ? w.geometry(true) : null);
      const add = (b, w) => { const g = geo(w); const h = g ? b.add(g) : null; if (g) g.dispose(); return h; };
      rec.h.ground = add(bGround, W.ground);
      rec.h.gdet = add(bGround, W.gdetail);
      rec.h.coarse = add(bSolid, W.coarse);
      rec.h.fine = add(bSolid, W.fine);
      rec.h.alpha = add(bAlpha, W.alpha);
      rec.h.glow = add(bGlow, W.glow);
      rec.h.pool = add(bPool, W.pool);
      chunks.set(key, rec);
      dirtyCars = true;
      return rec;
    };
    const unload = (key) => {
      const rec = chunks.get(key);
      if (!rec) return;
      bGround.remove(rec.h.ground); bGround.remove(rec.h.gdet); bSolid.remove(rec.h.coarse); bSolid.remove(rec.h.fine);
      bAlpha.remove(rec.h.alpha); bGlow.remove(rec.h.glow); bPool.remove(rec.h.pool);
      chunks.delete(key);
      dirtyCars = true;
    };
    const refresh = () => {
      const R = RADIUS[level];
      const want = [];
      for (const [ci, cj] of allKeys) {
        const d = chunkDist(ci, cj, camP.x, camP.z);
        if (d < R) want.push([d, ci, cj]);
      }
      want.sort((a, b) => a[0] - b[0]);
      queue.length = 0;
      for (const [d, ci, cj] of want) {
        const key = ci + ',' + cj;
        if (!chunks.has(key) && (!job || job.key !== key)) queue.push({ key, ci, cj, d });
      }
      for (const [key, rec] of chunks) if (chunkDist(rec.ci, rec.cj, camP.x, camP.z) > R + 300) unload(key);
    };
    const work = (budget) => {
      const t0 = performance.now();
      while (performance.now() - t0 < budget) {
        if (!job) {
          const q = queue.shift();
          if (!q) return;
          job = { ...q, it: genChunk(S, q.ci, q.cj) };
        }
        const r = job.it.next();
        if (r.done) {
          finish(job.key, job.ci, job.cj, r.value);
          job = null;
        }
      }
    };

    // —— 可见性、车辆、名称牌、灯 ——
    const _m = new Float32Array(16);
    const updateVis = () => {
      const fineR = FINE_R[level], coarseR = COARSE_R[level], alphaR = ALPHA_R[level], nearR = CAR_NEAR_R[level], farR = CAR_FAR_R[level];
      const night = ctx.sky?.night ?? 0;
      for (const rec of chunks.values()) {
        const d = chunkDist(rec.ci, rec.cj, camP.x, camP.z);
        bSolid.vis(rec.h.fine, d < fineR);
        bGround.vis(rec.h.gdet, d < fineR * 1.4);
        bSolid.vis(rec.h.coarse, d < coarseR);
        bAlpha.vis(rec.h.alpha, d < alphaR);
        bPool.vis(rec.h.pool, d < alphaR);
      }
      // 车辆：近景 / 远景两套实例
      let nN = 0, nF = 0;
      const mN = carN.instanceMatrix.array, mF = carF.instanceMatrix.array, cN = carN.instanceColor.array, cF = carF.instanceColor.array;
      const nr2 = nearR * nearR, fr2 = farR * farR;
      for (const rec of chunks.values()) {
        if (chunkDist(rec.ci, rec.cj, camP.x, camP.z) > farR) continue;
        const a = rec.cars;
        for (let i = 0; i < a.length; i += 9) {
          const dx = a[i] - camP.x, dz = a[i + 2] - camP.z, dy = a[i + 1] - camP.y;
          const d2 = dx * dx + dz * dz + dy * dy;
          if (d2 > fr2) continue;
          const near = d2 < nr2;
          if (near ? nN >= CAP_NEAR : nF >= CAP_FAR) continue;
          const yw = a[i + 3], c = Math.cos(yw), s = Math.sin(yw), sy = a[i + 7], sz = a[i + 8];
          _m[0] = c; _m[1] = 0; _m[2] = -s; _m[3] = 0;
          _m[4] = 0; _m[5] = sy; _m[6] = 0; _m[7] = 0;
          _m[8] = s * sz; _m[9] = 0; _m[10] = c * sz; _m[11] = 0;
          _m[12] = a[i]; _m[13] = a[i + 1]; _m[14] = a[i + 2]; _m[15] = 1;
          if (near) { mN.set(_m, nN * 16); cN[nN * 3] = a[i + 4]; cN[nN * 3 + 1] = a[i + 5]; cN[nN * 3 + 2] = a[i + 6]; nN++; }
          else { mF.set(_m, nF * 16); cF[nF * 3] = a[i + 4]; cF[nF * 3 + 1] = a[i + 5]; cF[nF * 3 + 2] = a[i + 6]; nF++; }
        }
      }
      carN.count = nN; carF.count = nF;
      // 树冠广告牌（[x, y, z, 半径, r, g, b, 扁度]，扁度 = 竖向缩放）：小乔木/灌木球近看半径 × 1.3 内；
      // 宅间大树与树干同在远看实体半径内（远处大树不能只剩光秃树干）。块按距离由近到远，实例数到上限时先舍远处
      let nc = 0;
      const mC = crown.instanceMatrix.array, cC = crown.instanceColor.array;
      const byD = [...chunks.values()].map((rec) => [chunkDist(rec.ci, rec.cj, camP.x, camP.z), rec]).sort((p, q) => p[0] - q[0]);
      for (const [key, R] of [['crowns', fineR * 1.3], ['bigCrowns', coarseR]]) {
        const r2c = R * R;
        for (const [d, rec] of byD) {
          if (d > R) break;
          const a = rec[key];
          for (let i = 0; i < a.length && nc < CAP_CROWN; i += 8) {
            const dx = a[i] - camP.x, dz = a[i + 2] - camP.z;
            if (dx * dx + dz * dz > r2c) continue;
            const r = a[i + 3], o = nc * 16;
            mC[o] = r; mC[o + 1] = 0; mC[o + 2] = 0; mC[o + 3] = 0;
            mC[o + 4] = 0; mC[o + 5] = r * a[i + 7]; mC[o + 6] = 0; mC[o + 7] = 0;
            mC[o + 8] = 0; mC[o + 9] = 0; mC[o + 10] = r; mC[o + 11] = 0;
            mC[o + 12] = a[i]; mC[o + 13] = a[i + 1]; mC[o + 14] = a[i + 2]; mC[o + 15] = 1;
            cC[nc * 3] = a[i + 4]; cC[nc * 3 + 1] = a[i + 5]; cC[nc * 3 + 2] = a[i + 6];
            nc++;
          }
        }
      }
      crown.count = nc;
      crown.instanceMatrix.needsUpdate = true;
      crown.instanceColor.needsUpdate = true;
      // 花坛花丛：FLOWER_R 内
      let nf = 0;
      const flR = FLOWER_R[level], fl2 = flR * flR, mF2 = flower.instanceMatrix.array, cF2 = flower.instanceColor.array;
      for (const rec of chunks.values()) {
        if (chunkDist(rec.ci, rec.cj, camP.x, camP.z) > flR) continue;
        const a = rec.flowers;
        for (let i = 0; i < a.length && nf < CAP_FLOWER; i += 7) {
          const dx = a[i] - camP.x, dz = a[i + 2] - camP.z, dy = a[i + 1] - camP.y;
          if (dx * dx + dz * dz + dy * dy > fl2) continue;
          const r = a[i + 3], o = nf * 16;
          mF2[o] = r; mF2[o + 1] = 0; mF2[o + 2] = 0; mF2[o + 3] = 0;
          mF2[o + 4] = 0; mF2[o + 5] = r * 0.62; mF2[o + 6] = 0; mF2[o + 7] = 0;
          mF2[o + 8] = 0; mF2[o + 9] = 0; mF2[o + 10] = r; mF2[o + 11] = 0;
          mF2[o + 12] = a[i]; mF2[o + 13] = a[i + 1]; mF2[o + 14] = a[i + 2]; mF2[o + 15] = 1;
          cF2[nf * 3] = a[i + 4]; cF2[nf * 3 + 1] = a[i + 5]; cF2[nf * 3 + 2] = a[i + 6];
          nf++;
        }
      }
      flower.count = nf;
      flower.instanceMatrix.needsUpdate = true;
      flower.instanceColor.needsUpdate = true;
      carN.instanceMatrix.needsUpdate = true; carN.instanceColor.needsUpdate = true;
      carF.instanceMatrix.needsUpdate = true; carF.instanceColor.needsUpdate = true;
      // 名称牌：220 m 内最近的 8 个
      const cand = [];
      for (const rec of chunks.values()) {
        if (chunkDist(rec.ci, rec.cj, camP.x, camP.z) > 260) continue;
        for (const s of rec.signs) {
          const d = Math.hypot(s.x - camP.x, s.z - camP.z);
          if (d < 240) cand.push([d, s]);
        }
      }
      cand.sort((a, b) => a[0] - b[0]);
      const pick = cand.slice(0, SIGN_SLOTS).map((c) => c[1]);
      const keyOf = (s) => `${s.text}@${s.x.toFixed(1)},${s.z.toFixed(1)}`;
      const keep = new Set(pick.map(keyOf));
      for (const sl of slots) if (sl.key && !keep.has(sl.key)) sl.key = null;
      let redraw = false;
      for (const s of pick) {
        const k = keyOf(s);
        if (slots.some((sl) => sl.key === k)) continue;
        const free = slots.findIndex((sl) => !sl.key);
        if (free < 0) break;
        slots[free].key = k;
        slots[free].s = s;
        drawSlot(free, s);
        redraw = true;
      }
      for (let i = 0; i < SIGN_SLOTS; i++) {
        const sl = slots[i];
        const o = i * 12;
        if (!sl.key) { sPos.fill(0, o, o + 12); continue; }
        const s = sl.s;
        // 牌面高 s.h，宽按文字长度但不超过门头可用宽 s.w
        const h = s.h, w = Math.min(s.w, h * sl.aspect);
        const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
        // 局部 +x = (cos, -sin)，法线 +z = (sin, cos)
        const P = (lx, ly) => [s.x + lx * c + 0.03 * sn, s.y + ly, s.z - lx * sn + 0.03 * c];
        const q = [P(-w / 2, -h / 2), P(w / 2, -h / 2), P(w / 2, h / 2), P(-w / 2, h / 2)];
        for (let k = 0; k < 4; k++) { sPos.set(q[k], o + k * 3); sNor.set([sn, 0, c], o + k * 3); }
        // uv：图集第 i 槽（canvas 自上而下，uv.y 自下而上）；按实际宽高比裁中间
        const v1 = 1 - (i * 128) / signCv.height, v0 = 1 - ((i + 1) * 128) / signCv.height;
        const fu = Math.min(1, (w / h) / (1024 / 128)) / 2;
        sUv.set([0.5 - fu, v0, 0.5 + fu, v0, 0.5 + fu, v1, 0.5 - fu, v1], i * 8);
      }
      signGeo.attributes.position.needsUpdate = true;
      signGeo.attributes.uv.needsUpdate = true;
      signGeo.attributes.normal.needsUpdate = true;
      if (redraw) signTex.needsUpdate = true;
      // 门岗点光源
      if (night > 0.05) {
        const gs = [];
        for (const rec of chunks.values()) {
          if (chunkDist(rec.ci, rec.cj, camP.x, camP.z) > 400) continue;
          for (const g of rec.gates) gs.push([Math.hypot(g[0] - camP.x, g[2] - camP.z), g]);
        }
        gs.sort((a, b) => a[0] - b[0]);
        for (let i = 0; i < gateLights.length; i++) {
          const s = gateLights[i], g = gs[i];
          if (g && g[0] < 400) { s.position.set(g[1][0], g[1][1], g[1][2]); s.enabled = true; }
          else s.enabled = false;
        }
      }
      bPool.mesh.visible = night > 0.03;
      uPool.value = night;
    };

    console.log(`[compounds] 流式生成就绪：${allKeys.length} 个 500 m 块含小区`);
    return {
      update() {
        frame++;
        const agl = camP.y - T.heightAt(camP.x, camP.z);
        const on = visible && agl < MAX_AGL;
        root.visible = on;
        if (!on) return;
        const jumped = camP.distanceToSquared(lastP) > 250 * 250;
        if (jumped || frame % 20 === 0) refresh();
        // 相机所在块尚未生成时加大时间预算（瞬移/起步）
        const urgent = queue.length && queue[0].d < 1;
        work(urgent || (job && job.d < 1) ? 18 : queue.length && queue[0].d < 600 ? 9 : 4);
        const moved = camP.distanceToSquared(lastP) > 16;
        if (moved || dirtyCars || frame % 30 === 0) {
          lastP.copy(camP);
          dirtyCars = false;
          updateVis();
        } else if (frame % 10 === 0) {
          uPool.value = ctx.sky?.night ?? 0;
          bPool.mesh.visible = uPool.value > 0.03;
        }
      },
      setQuality(q) {
        level = Math.max(0, Math.min(3, q.level ?? level));
        refresh();
        dirtyCars = true;
      },
      setLayer(name, on) {
        if (name === 'buildings' || name === 'compounds') visible = on;
      },
      stats() {
        return { chunks: chunks.size, queue: queue.length, busy: !!job, ground: bGround.live, solid: bSolid.live, alpha: bAlpha.live, glow: bGlow.live, crowns: crown.count, flowers: flower.count, cars: carN.count + carF.count };
      },
      dispose() {
        for (const k of [...chunks.keys()]) unload(k);
        for (const s of gateLights) s.enabled = false;
      },
    };
  },
};
