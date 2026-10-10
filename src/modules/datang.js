// 大唐不夜城步行街（夜景是本项目最重要的展示之一，预设视角 4）
//
// 位置核对（OSM pois/roads/buildings + Esri 影像）：中轴 x≈1570（雁塔南路旧路中线），北起慈恩路南沿 z≈4918，
// 南至开元广场南端 z≈6165（再往南为雁塔南路机动车道）；雁南一路在 z≈5296~5334 横穿（机动车路口，保留给道路模块）。
// 立面线：西侧沿街建筑东立面 x≈1537，东侧西立面 x≈1603（街面净宽约 66 m：两侧步行道各约 25 m + 中央景观带 16 m）。
// 节点（自北向南，POI 实测）：大唐群英谱（佛教 4966/绘画 5083/诗歌 5124/书法 5166/科技 5209/天文医学 5268）、团花广场 5016、
//   贞观广场（西：西安美术馆 5389、陕西大剧院 5512；东：太平洋影城 5378、西安音乐厅 5510；中：贞观之治 5450、房谋杜断 5509）、
//   万国来朝 5739、武后行从 5856、大唐文化柱 5909、开元盛世碑 5961、开元盛世（开元广场）6101。
// 沿街店铺名取自 OSM POI（西安饭庄、德发长、同盛祥、茶话弄、巧克巧蔻、锦绣唐朝、曲江正唐、万象幻唐、唐·长安里、半唐空间……），
//   其余用不夜城真实常见业态（长安大牌档、老孙家泡馍、樊记腊汁肉夹馍、袁家村等）。
// 建筑：唐风（朱柱白壁灰瓦、鸱尾、出檐深远、斗拱雄大），2~3 层，底层隔扇门 + 直棂窗店面；檐口/屋脊/柱 LED 金色轮廓灯。
// 夜景基调（照片）：金光很亮但轮廓清楚——能看清地面铺装、雕塑与人群，天空是深色的；串灯树是一颗颗小暖光点勾出的树形。
// 因此各类自发光的 HDR 亮度都压在泛光阈值附近（灯带/宫灯/灯笼/铜像泛光），不让大面积发光面把整条街糊成一片金雾；
// 远景（数公里外）用屏幕尺寸受控的金色光点合成一条约 1.3 km 的金色光带（全城夜景里最亮的南北轴线）。
import * as THREE from 'three';
import { ArchBuilder, hall, multiStoreyTower, pavilion, paifang } from '../arch/chinese.js';
import { Batcher, ribbon } from '../core/util.js';
import { floodlit } from '../arch/chinese-core.js';
import { shadowReach } from '../arch/perf-lod.js';
import { uplights, groundGlow } from '../arch/landmark-ground.js';
import {
  personGeometry, crowdMesh, treeMeshes, lampMeshes, lanternInstances, lightPools, lightBeams,
  figureGeometry, riderGeometry, camelGeometry, plinthGeometry, plinthRelief, reliefMaterial, farGlow, columnReliefMaterial,
} from '../arch/datang-props.js';
import { peopleGeometry, peopleMaterial, peopleDepthMaterial, createPeopleMesh, randomLook, MASK } from '../arch/people-geo.js';

// ───────────── 布局常量（世界坐标，米） ─────────────
const AX = 1570; // 中轴
const ZN = 4918, ZS = 6165;
const HW = 33; // 中轴 → 沿街立面
const CROSS = [5294, 5336]; // 雁南一路路口
const ZG = [5338, 5566]; // 贞观广场
const KY = [6046, 6165]; // 开元广场
const SEGS = [[ZN + 4, 5290], [5570, 6044]]; // 沿街店铺段
const BELT = 8; // 中央景观带半宽

// 真实店铺（POI：side -1 西 / 1 东，z）
const POI_SHOPS = [
  [-1, 5048, '雁塔故事'], [-1, 5061, '新华读书阁'], [-1, 5104, '茶话弄'], [-1, 5164, '巧克巧蔻'], [-1, 5209, '唐·长安里'],
  [-1, 5238, '锦绣唐朝'], [-1, 5268, '半唐空间'], [1, 5033, '西安饭庄'], [1, 5085, '德发长'], [1, 5125, '同盛祥'],
  [1, 5204, '哈苏影像'], [1, 5226, '万象幻唐'], [1, 5250, '曲江正唐'], [1, 4960, '长安大牌档'], [-1, 4990, '曲江艺术博物馆'],
  [1, 5621, '肯德基'], [1, 5610, '壹洋购物中心'], [-1, 5637, '大城志'], [-1, 5845, '特斯拉'], [-1, 5872, '六福珠宝'],
  [1, 5879, '汉堡王'], [-1, 5906, '资生堂'], [-1, 5950, '奈雪的茶'], [-1, 5989, '瑞幸咖啡'], [-1, 6030, '蜜雪冰城'],
  [1, 5700, '长安大牌档'], [1, 5760, '老孙家泡馍'], [1, 5820, '樊记肉夹馍'], [1, 5960, '星巴克臻选'], [1, 6010, '同盛祥'],
];
const FILL_NAMES = [
  '长安礼物', '大唐文创', '盛唐茶肆', '胡姬酒肆', '魏家凉皮', '袁家村', '长安书局', '唐韵丝绸', '大唐通宝', '长安酒肆',
  '西市坊', '凤鸣茶社', '长安乐坊', '唐宫胭脂', '丝路驿站', '太白酒楼', '雁塔茶舍', '曲江春宴', '镜花缘', '长恨歌',
  '大唐珍宝', '唐三彩', '皮影馆', '秦腔茶社', '甑糕铺', '长安汤饼', '唐风汉服', '长安锦绣', '上元灯铺', '霓裳阁',
];
const BANNERS = ['茶', '酒', '食', '礼', '唐', '宴', '汤', '饼', '锦', '灯', '书', '乐'];
const BANNER2 = ['长安好礼', '肉夹馍', '羊肉泡馍', '甑糕', '凉皮', '镜糕', '汉服', '文创', '茶饮', '胡饼'];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────── 程序化地面纹理 ─────────────
function pavingTexture() {
  const S = 1024, M = 8; // 1024 px = 8 m
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const r = rng(11);
  const px = S / M;
  g.fillStyle = '#7d766d';
  g.fillRect(0, 0, S, S);
  // 0.9×0.45 m 石板错缝 + 每 4 m 一道深色花岗岩带
  const sw = 0.9 * px, sh = 0.45 * px;
  for (let row = 0; row * sh < S; row++) {
    const off = (row % 2) * sw * 0.5;
    for (let x = -sw; x < S + sw; x += sw) {
      const v = 150 + r() * 26;
      g.fillStyle = `rgb(${v + 6},${v},${v - 10})`;
      g.fillRect(x + off + 1.5, row * sh + 1.5, sw - 3, sh - 3);
      for (let k = 0; k < 14; k++) {
        g.fillStyle = `rgba(${r() < 0.5 ? 60 : 230},${r() < 0.5 ? 55 : 220},50,0.06)`;
        g.fillRect(x + off + r() * sw, row * sh + r() * sh, 2, 2);
      }
    }
  }
  g.fillStyle = '#5b554e';
  for (const y of [0, S / 2]) g.fillRect(0, y, S, 0.3 * px);
  g.strokeStyle = 'rgba(200,170,110,0.55)';
  g.lineWidth = 3;
  for (const y of [0.3 * px + 2, S / 2 + 0.3 * px + 2]) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(S, y);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
/** 团花（唐代宝相花）地面拼花 */
function tuanhuaTexture() {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  const ring = (r, w, col) => {
    g.strokeStyle = col;
    g.lineWidth = w;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.stroke();
  };
  g.fillStyle = '#6c5a44';
  g.beginPath();
  g.arc(0, 0, 500, 0, Math.PI * 2);
  g.fill();
  ring(490, 16, '#c9a45a');
  ring(455, 6, '#c9a45a');
  for (let k = 0; k < 3; k++) {
    const n = [16, 12, 8][k], R = [380, 250, 130][k], s = [70, 60, 50][k];
    for (let i = 0; i < n; i++) {
      g.save();
      g.rotate((i / n) * Math.PI * 2 + k * 0.2);
      g.fillStyle = ['#b98a44', '#d4b070', '#8a3a28'][k];
      g.beginPath();
      g.ellipse(0, -R, s * 0.55, s, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#e8d3a0';
      g.beginPath();
      g.ellipse(0, -R, s * 0.18, s * 0.45, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  g.fillStyle = '#d6b36a';
  g.beginPath();
  g.arc(0, 0, 60, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function flowerTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const r = rng(5);
  g.fillStyle = '#3d5a2a';
  g.fillRect(0, 0, S, S);
  const cols = ['#d8324a', '#f2c230', '#f07aa0', '#ffffff', '#e8641e', '#b83aa0'];
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() < 0.35 ? '#4f7a34' : cols[(r() * cols.length) | 0];
    g.beginPath();
    g.arc(r() * S, r() * S, 2 + r() * 3.5, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 贴地网格（x0..x1 × z0..z1，按地形起伏，UV = 世界米 / uvM） */
function groundGrid(H, x0, x1, z0, z1, step, lift, uvM) {
  const nx = Math.max(1, Math.ceil((x1 - x0) / step)), nz = Math.max(1, Math.ceil((z1 - z0) / step));
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx, z = z0 + ((z1 - z0) * j) / nz;
      pos.push(x, H(x, z) + lift, z);
      uv.push(x / uvM, -z / uvM);
    }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ───────────── 沿街唐风商铺 ─────────────
/**
 * 在 builder 里放一座商铺。side：-1 西侧（面朝东），1 东侧（面朝西）。zc：沿街中心；返回占用长度。
 */
function placeShop(b, H, side, zc, spec, r, o = [0, 0, 0]) {
  const { type, bays, bayW, depthBays, depthW, colH, name } = spec;
  const margin = 1.6;
  const PD = depthBays * depthW + 2 * margin;
  const facadeX = AX + side * HW;
  const cx = facadeX + side * (PD / 2 + 0.4);
  const y = H(cx - side * PD * 0.3, zc) - 0.05;
  const yaw = side < 0 ? Math.PI / 2 : -Math.PI / 2;
  const roofColor = r() < 0.8 ? 'darkgray' : 'gray';
  const common = {
    style: 'tang', roofColor, platform: 'plain', platformH: 0.45, platformMargin: margin, steps: 'front',
    plaque: name, lanterns: true, lanternSize: 0.62, eaveLights: { columns: true, width: 0.08 },
  };
  b.push(cx - o[0], y - o[1], zc - o[2], yaw);
  let info;
  if (type === 'tower2' || type === 'tower3') {
    const floors = type === 'tower3' ? 3 : 2;
    const storeys = [{ bays, depthBays, bayW, depthW, colH, front: 'tangshop', back: 'wall', sides: 'wall' }];
    for (let i = 1; i < floors; i++) storeys.push({ colH: colH * 0.78, front: 'zhiling', back: 'wall', sides: i === floors - 1 ? 'zhiling' : 'wall' });
    info = multiStoreyTower(b, { ...common, storeys, shrink: 0.7, pingzuo: true, balcony: 1.1, roof: type === 'tower3' ? 'xieshan' : r() < 0.5 ? 'wudian' : 'xieshan' });
  } else {
    info = hall(b, {
      ...common, bays, bayW, depthBays, depthW, colH, eaves: type === 'hall2' ? 2 : 1, roof: r() < 0.6 ? 'xieshan' : 'wudian',
      front: 'tangshop', sides: 'wall', back: 'wall',
    });
  }
  // 竖向幌子（檐下两端，面向街）
  if (b.detail >= 1) {
    const W = bays * bayW;
    const zF = (depthBays * depthW) / 2 + 0.95;
    const t1 = r() < 0.5 ? BANNERS[(r() * BANNERS.length) | 0] : BANNER2[(r() * BANNER2.length) | 0];
    const bgs = ['#8e1c12', '#1f2a44', '#6a1a10', '#2a1a12'];
    const bg = bgs[(r() * bgs.length) | 0];
    const len = [...t1].length;
    const bh = len === 1 ? 1.3 : 0.55 * len + 0.5;
    b.plaque(t1, -W / 2 + bayW * 0.5, colH * 0.62 + 0.45, zF, 0.62, bh, { vertical: true, bg, color: '#f6dc8a', border: '#d4a94e' });
    b.plaque(t1, W / 2 - bayW * 0.5, colH * 0.62 + 0.45, zF, 0.62, bh, { vertical: true, bg, color: '#f6dc8a', border: '#d4a94e' });
  }
  b.pop();
  return { info, PW: bays * bayW + 2 * margin, PD };
}

function shopSpecs(side, za, zb, r, used) {
  const out = [];
  let z = za;
  let k = 0;
  while (z < zb - 10) {
    const rem = zb - z;
    const t = r();
    const endCap = k === 0 || rem < 40;
    let type = endCap ? 'tower3' : t < 0.45 ? 'tower2' : t < 0.75 ? 'hall' : 'hall2';
    const bayW = type === 'tower3' ? 4.2 : 4.4 + r() * 0.9;
    let bays = type === 'tower3' ? 3 : type === 'hall2' ? 7 : [3, 5, 5, 7][(r() * 4) | 0];
    let W = bays * bayW + 3.2;
    if (W > rem) {
      bays = Math.max(3, Math.floor((rem - 3.2) / bayW) | 1);
      W = bays * bayW + 3.2;
      if (W > rem + 2) break;
    }
    const colH = type === 'tower3' ? 4.4 : type === 'hall2' ? 5.2 : type === 'hall' ? 5.6 + r() * 0.8 : 4.6 + r() * 0.5;
    const depthBays = type === 'tower3' ? 3 : type === 'hall2' ? 4 : 3;
    const depthW = type === 'tower3' ? 4.2 : 4.6;
    const zc = z + W / 2;
    // 就近真实店名
    let name = null;
    for (const p of POI_SHOPS) if (p[0] === side && Math.abs(p[1] - zc) < W / 2 + 2 && !used.has(p[2] + p[1])) { name = p[2]; used.add(p[2] + p[1]); break; }
    if (!name) name = FILL_NAMES[(r() * FILL_NAMES.length) | 0];
    out.push({ type, bays, bayW, depthBays, depthW, colH, name, zc });
    z += W + 2.5 + (r() < 0.25 ? 4 + r() * 3 : 0);
    k++;
  }
  return out;
}

// ───────────── 模块 ─────────────
export default {
  id: 'datang',
  name: '大唐不夜城',

  prepare(ctx) {
    const E = ctx.exclusions;
    const rect = (x0, x1, z0, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];
    // 沿街两侧街区（我们自建唐风建筑，通用建筑与树让位）
    E.add({ points: rect(1440, 1538, ZN - 6, KY[0]), name: '不夜城西街区' }, { buildings: true, trees: true });
    E.add({ points: rect(1602, 1706, ZN - 6, KY[0]), name: '不夜城东街区' }, { buildings: true, trees: true });
    // 步行街本体（含旧雁塔南路两条车道：让道路模块不画）
    E.add({ points: rect(1534, 1606, ZN - 4, CROSS[0]), name: '不夜城步行街北' }, { buildings: true, trees: true, roads: true });
    E.add({ points: rect(1534, 1606, CROSS[1], ZS), name: '不夜城步行街南' }, { buildings: true, trees: true, roads: true });
    E.add({ points: rect(1500, 1640, KY[0], ZS), name: '开元广场' }, { buildings: true, trees: true });
    // 平整：街面分段（每段取平均，段间差 < 0.3 m），广场整体
    const T = ctx.terrain;
    for (let z = ZN - 2; z < ZS; z += 78) {
      const z1 = Math.min(ZS + 2, z + 78);
      if (z1 > CROSS[0] && z < CROSS[1]) continue;
      T.addFlatten({ points: rect(AX - HW - 2, AX + HW + 2, z, z1), height: null, feather: 12 });
    }
  },

  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = '大唐不夜城';
    ctx.scene.add(root);
    const H = (x, z) => ctx.terrain.heightAt(x, z);
    const q = ctx.quality || { level: 2 };
    const lvl = q.level ?? 2;
    // 绘制负担控制（按画质）：离街区超过 FAR_HIDE 时隐藏商铺/后街/雕塑/灯柱/树/灯笼/人流（几公里外都是亚像素，
    // 夜里由地面灯带、光柱、贞观广场大建筑表现）；超过 SHADOW_D 时整片不投射阴影；人流数量随距离线性减少
    const FAR_HIDE = [3000, 4500, 6500, 9000][lvl] ?? 6500;
    const SHADOW_D = [600, 1200, 2200, 3200][lvl] ?? 2200;
    const r = rng(20260925);
    const yMid = H(AX, (ZN + ZS) / 2);
    const tick = () => new Promise((res) => setTimeout(res, 0));

    // ───── 1. 地面铺装 ─────
    const pave = pavingTexture();
    const paveMat = ctx.overlay(new THREE.MeshStandardMaterial({ map: pave, roughness: 0.52, metalness: 0.05, color: 0xf2eee6 }), 0.0006);
    const gb = new Batcher();
    gb.add(groundGrid(H, AX - HW - 1, AX + HW + 1, ZN - 2, CROSS[0], 8, 0.06, 8), paveMat);
    gb.add(groundGrid(H, AX - HW - 1, AX + HW + 1, ZG[1], KY[0], 8, 0.06, 8), paveMat);
    gb.add(groundGrid(H, 1506, 1634, CROSS[1], ZG[1], 8, 0.06, 8), paveMat);
    gb.add(groundGrid(H, 1512, 1628, KY[0], ZS, 8, 0.06, 8), paveMat);
    // 团花拼花（团花广场 / 贞观广场 / 开元广场）
    const thMat = ctx.overlay(new THREE.MeshStandardMaterial({ map: tuanhuaTexture(), transparent: true, alphaTest: 0.02, roughness: 0.45, metalness: 0.2 }), 0.0012);
    const disc = (x, z, R) => {
      const g = new THREE.CircleGeometry(R, 48);
      g.rotateX(-Math.PI / 2);
      g.translate(x, H(x, z) + 0.1, z);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), 1 - uv.getY(i));
      return g;
    };
    gb.add(disc(AX, 5016, 13), thMat);
    gb.add(disc(AX, 5400, 11), thMat);
    gb.add(disc(AX, 6070, 13), thMat);
    const ground = gb.build({ castShadow: false, receiveShadow: true, name: '铺装' });
    ground.children.forEach((m) => (m.renderOrder = 1));
    root.add(ground);

    // 逐栋档案建筑（曲江银泰城、威斯汀大酒店……按真实轮廓精建，见 src/arch/dossier-specs）占用的地块不再摆程序化唐风建筑，
    // 否则两套建筑叠在一起（dossier 先于本模块 prepare，ctx.superseded.polys 为其落地轮廓）
    const dos = (ctx.superseded?.polys || []).filter((p) => {
      for (let i = 0; i < p.length; i += 2) if (p[i] > 1380 && p[i] < 1760 && p[i + 1] > 4850 && p[i + 1] < 6250) return true;
      return false;
    });
    const pip = (x, z, p) => {
      let c = false;
      for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2)
        if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
      return c;
    };
    const taken = (xa, xb, za, zb) => {
      const x0 = Math.min(xa, xb) - 1, x1 = Math.max(xa, xb) + 1, z0 = Math.min(za, zb) - 1, z1 = Math.max(za, zb) + 1;
      for (const p of dos) {
        for (let i = 0; i < p.length; i += 2) if (p[i] > x0 && p[i] < x1 && p[i + 1] > z0 && p[i + 1] < z1) return true;
        for (let a = 0; a <= 8; a++) for (let c = 0; c <= 8; c++) if (pip(x0 + ((x1 - x0) * a) / 8, z0 + ((z1 - z0) * c) / 8, p)) return true;
      }
      return false;
    };
    let nTaken = 0;

    // ───── 2. 沿街唐风建筑 ─────
    const used = new Set();
    // 每段每侧一个 LOD 块：近处 detail 1（斗拱/门窗/匾额/幌子），远处 detail 0
    const levels = lvl >= 2 ? [[1, 0], [0, 420]] : [[0, 0]];
    for (let si = 0; si < SEGS.length; si++) {
      const [za, zb] = SEGS[si];
      const baseY = H(AX, (za + zb) / 2);
      for (const side of [-1, 1]) {
        const specs = shopSpecs(side, za, zb, r, used).filter((s) => {
          const PD = s.depthBays * s.depthW + 3.2, hw = (s.bays * s.bayW) / 2 + 1.6;
          const hit = taken(AX + side * HW, AX + side * (HW + PD + 0.4), s.zc - hw, s.zc + hw);
          if (hit) nTaken++;
          return !hit;
        });
        const o = [AX + side * (HW + 9), H(AX + side * (HW + 9), (za + zb) / 2), (za + zb) / 2];
        const lod = new THREE.LOD();
        lod.name = '不夜城商铺' + si + (side < 0 ? '西' : '东');
        lod.position.set(o[0], o[1], o[2]);
        const seed = 1000 + si * 10 + side;
        for (const [d, dist] of levels) {
          const b = new ArchBuilder(ctx, { detail: d, style: 'tang', name: lod.name });
          const rr = rng(seed);
          for (const s of specs) placeShop(b, H, side, s.zc, s, rr, o);
          lod.addLevel(b.build({ flood: { color: 0xffc27a, strength: 0.55, baseY: baseY - 0.5, height: 15, top: 0.45, upDim: 0.95 }, name: lod.name + 'd' + d }), dist);
        }
        lod.addLevel(new THREE.Object3D(), FAR_HIDE); // 远处整段隐藏
        root.add(lod);
        await tick();
      }
    }
    let backStreet = null;
    // 后排：街区纵深的大体量唐风建筑（酒店/商业综合体），低细节
    {
      const b = new ArchBuilder(ctx, { detail: 0, style: 'tang', name: '不夜城后街' });
      for (const [za, zb] of SEGS)
        for (const side of [-1, 1]) {
          for (let z = za + 4; z < zb - 30; ) {
            const bays = 5 + 2 * ((r() * 2) | 0), bw = 6 + r() * 1.2;
            const W = bays * bw;
            if (z + W > zb) break;
            const depthBays = 4, dw = 6.2;
            const D = depthBays * dw + 3;
            const cx = AX + side * (HW + 19 + D / 2 + 1);
            const zc = z + W / 2;
            const hOpt = { style: 'tang', bays, bayW: bw, depthBays, depthW: dw, colH: 6 + r() * 1.5, eaves: r() < 0.45 ? 2 : 1, roof: r() < 0.5 ? 'wudian' : 'xieshan', roofColor: 'darkgray', front: 'tang', sides: 'wall', back: 'wall', platform: 'plain', platformH: 0.6, platformMargin: 1.5, eaveLights: { width: 0.1 } };
            if (taken(cx - D / 2 - 1.5, cx + D / 2 + 1.5, z - 1.5, z + W + 1.5)) nTaken++;
            else {
              b.push(cx, H(cx, zc) - 0.05, zc, side < 0 ? Math.PI / 2 : -Math.PI / 2);
              hall(b, hOpt);
              b.pop();
            }
            z += W + 6 + r() * 6;
          }
        }
      const g = b.build({ flood: { color: 0xffc27a, strength: 0.55, baseY: yMid - 1, height: 18, top: 0.4, upDim: 0.95 }, name: '不夜城后街' });
      root.add(g);
      backStreet = g;
      await tick();
    }

    // ───── 3. 贞观广场重点建筑 ─────
    {
      const O = [AX, H(AX, 5460), 5460];
      const lod = new THREE.LOD();
      lod.name = '贞观广场建筑';
      lod.position.set(O[0], O[1], O[2]);
      for (const [d, dist] of lvl >= 2 ? [[1, 0], [0, 650]] : [[0, 0]]) {
        const b = new ArchBuilder(ctx, { detail: d, style: 'tang', name: '贞观广场建筑' });
        const put = (x, z, yaw, fn) => {
          if (taken(x - 12, x + 12, z - 12, z + 12)) return; // 该处已有逐栋档案建筑
          b.push(x - O[0], H(x, z) - 0.05 - O[1], z - O[2], yaw);
          fn();
          b.pop();
        };
        const E = Math.PI / 2, W = -Math.PI / 2;
        // 陕西大剧院（西，面东）：重檐庑殿大殿 + 高台 + 前庭双阙楼
        put(1478, 5512, E, () => hall(b, { style: 'tang', bays: 9, bayW: 7.0, centerW: 7.6, depthBays: 5, depthW: 6.6, colH: 8.2, eaves: 2, roof: 'wudian', roofColor: 'darkgray', front: 'tang', sides: 'zhiling', back: 'wall', platform: 'brick', platformH: 3.0, steps: 'front', stepW: 16, railing: true, plaque: '陕西大剧院', lanterns: true, lanternSize: 1.1, eaveLights: { columns: true, width: 0.1 } }));
        for (const z of [5474, 5550]) put(1523, z, E, () => multiStoreyTower(b, { style: 'tang', floors: 3, bays: 3, bayW: 4.0, depthBays: 3, depthW: 4.0, colH: 4.2, roof: 'wudian', roofColor: 'darkgray', platform: 'brick', platformH: 1.8, eaveLights: { columns: true } }));
        // 西安美术馆（西，面东）
        // （门扇、窗棂深褐木色，红色只留柱与额枋；原先门板与窗棂全是朱红，远看像一排红色卷帘门，审查 g8）
        put(1497, 5389, E, () => multiStoreyTower(b, { style: 'tang', storeys: [{ bays: 7, depthBays: 4, bayW: 5.4, depthW: 5.2, colH: 5.6, front: 'tang', back: 'wall', sides: 'zhiling' }, { colH: 4.4, front: 'zhiling', back: 'wall', sides: 'zhiling' }], roof: 'xieshan', roofColor: 'darkgray', platform: 'brick', platformH: 1.4, plaque: '西安美术馆', lanterns: true, eaveLights: { columns: true }, pal: { door: 0x5a3a26, frame: 0x6b4430, lattice: 0x5a3a26 } }));
        // 西安音乐厅（东，面西）：重檐歇山
        put(1645, 5510, W, () => hall(b, { style: 'tang', bays: 7, bayW: 7.0, depthBays: 4, depthW: 6.8, colH: 7.6, eaves: 2, roof: 'xieshan', roofColor: 'darkgray', front: 'tang', sides: 'zhiling', back: 'wall', platform: 'brick', platformH: 2.4, steps: 'front', stepW: 12, railing: true, plaque: '西安音乐厅', lanterns: true, lanternSize: 1.0, eaveLights: { columns: true, width: 0.1 } }));
        for (const z of [5478, 5543]) put(1611, z, W, () => pavilion(b, { style: 'tang', sides: 4, size: 5.5, colH: 3.8, roofColor: 'darkgray', eaveLights: true }));
        // 曲江太平洋电影城（东，面西）
        put(1640, 5378, W, () => multiStoreyTower(b, { style: 'tang', storeys: [{ bays: 7, depthBays: 4, bayW: 5.4, depthW: 5.2, colH: 5.4, front: 'tangshop', back: 'wall', sides: 'wall' }, { colH: 4.4, front: 'zhiling', back: 'wall', sides: 'wall' }], roof: 'wudian', roofColor: 'darkgray', platform: 'plain', platformH: 0.6, plaque: '太平洋电影城', lanterns: true, eaveLights: { columns: true } }));
        // 开元广场南端牌楼
        put(AX, ZS - 6, Math.PI, () => paifang(b, { style: 'tang', bays: 5, width: 30, h: 7.5, text: '开元盛世', sideText: ['大唐', '气象'], roofColor: 'darkgray', eaveLights: true }));

        lod.addLevel(b.build({ flood: { color: 0xffc47a, strength: 0.85, baseY: H(AX, 5450) - 0.5, height: 26, top: 0.4, upDim: 0.8 }, name: '贞观广场建筑d' + d }), dist);
      }
      lod.addLevel(new THREE.Object3D(), FAR_HIDE * 1.8); // 大体量建筑保留得更远
      root.add(lod);
      await tick();
    }

    // ───── 4. 中央景观带：雕塑群、台座、花坛、水景 ─────
    // 青铜：棕铜本色 + 金属高光（原先 0x7c5a33、金属度 0.7 → 白天几乎纯黑）；夜间泛光 2.6 → 0.85（原先整座雕塑糊成奶油色）
    // 深青铜（不夜城群雕实物为暗棕铜带铜绿；原 0xa27a4a 读成发亮的黄铜，审查 g1）：低饱和、金属度中等、略粗糙；
    // 夜间泛光从台座向上打（台顶约 1.3~1.8 m → 头部 5 m 处降到 0.22；原 height 12 整尊均匀发光，审查 g8）
    const bronze = new THREE.MeshStandardMaterial({ color: 0x7b6447, metalness: 0.55, roughness: 0.5, vertexColors: true });
    bronze.shadowSide = THREE.BackSide; // 曲面自阴影的网点状摩尔纹
    floodlit(bronze, { ctx, color: 0xffc070, strength: 1.15, baseY: yMid + 1.2, height: 4.5, top: 0.22, upDim: 0.35 });
    const stoneMat = ctx.mats.clone('marble', { color: 0xd8d0c2 });
    floodlit(stoneMat, { ctx, color: 0xffc47a, strength: 0.5, baseY: yMid - 1, height: 3, top: 0.4 });
    const relief = floodlit(reliefMaterial(), { ctx, color: 0xffc47a, strength: 0.5, baseY: yMid - 1, height: 3, top: 0.5 });
    // 金色灯带：不夜城专用副本，夜间 4.5 → 1.15、宽 0.16 → 0.1 m（贴地灯带离人眼近，原亮度在人眼高度下泛光成一大片金雾）
    const led = ctx.mats.clone('ledGold');
    ctx.night.register(led, { day: 0, night: 1.15 });
    const waterMat = new THREE.MeshPhysicalMaterial({ color: 0x0d1b20, roughness: 0.04, metalness: 0.1, clearcoat: 1, envMapIntensity: 1.2 });
    const flowerMat = new THREE.MeshStandardMaterial({ map: flowerTexture(), roughness: 0.9 });
    const curbMat = ctx.mats.get('stonePaving');
    const sb = new Batcher();
    const G = { stand: figureGeometry('stand'), raise: figureGeometry('raise'), wide: figureGeometry('wide'), seated: figureGeometry('seated'), rider: riderGeometry(), camel: camelGeometry() };
    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), S3 = new THREE.Vector3(), P3 = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
    const put = (geo, mat, x, y, z, yaw = 0, s = 1) => sb.add(geo, mat, M4.compose(P3.set(x, y, z), Q.setFromAxisAngle(UP, yaw), S3.set(s, s, s)));
    const titles = new ArchBuilder(ctx, { detail: 1, style: 'tang', name: '雕塑题名' });
    const ledRect = (x0, x1, z0, z1, y) => {
      const pts = [x0, z0, x1, z0, x1, z1, x0, z1, x0, z0];
      for (let i = 0; i < 8; i += 2) {
        const g = ribbon([pts[i], pts[i + 1], pts[i + 2], pts[i + 3]], 0.14, () => y, { lift: 0, step: 50 });
        if (g) sb.add(g, led);
      }
    };
    const plinthAt = (x, y, z, w, d, h) => {
      put(plinthGeometry(w, d, h), stoneMat, x, y, z);
      const rg = plinthRelief(w, d, h);
      if (rg) put(rg, relief, x, y, z);
    };
    const plinth = (z, w, d, h) => {
      const y = H(AX, z);
      plinthAt(AX, y, z, w, d, h);
      ledRect(AX - w / 2 - 0.2, AX + w / 2 + 0.2, z - d / 2 - 0.2, z + d / 2 + 0.2, y + h + 0.02);
      ledRect(AX - w / 2 - 0.35, AX + w / 2 + 0.35, z - d / 2 - 0.35, z + d / 2 + 0.35, y + 0.27);
      return y + h;
    };
    const title = (text, z, y, faceNorth = true) => {
      titles.push(AX, y, z, faceNorth ? Math.PI : 0);
      titles.box('stone', -2.4, 0, -0.35, 2.4, 1.4, 0.35, 0x9a8f80);
      titles.plaque(text, 0, 0.8, 0.37, 4.2, 1.0, { bg: '#3a2a1c', color: '#f2cf7a', border: '#c9a24e' });
      titles.pop();
    };
    const groupOnPlinth = (z, len, n, name, opts = {}) => {
      const top = plinth(z, 9, len, 1.3);
      title(name, z - len / 2 - 1.5, H(AX, z - len / 2 - 1.5));
      const kinds = ['stand', 'raise', 'wide', 'stand', 'seated'];
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const zz = z - len / 2 + 1.6 + t * (len - 3.2);
        const xx = AX + (i % 2 ? 1 : -1) * (1.2 + r() * 2.2);
        const kind = opts.kinds ? opts.kinds[i % opts.kinds.length] : kinds[(r() * kinds.length) | 0];
        put(G[kind], bronze, xx, top, zz, (xx < AX ? 0.9 : -0.9) + Math.PI + (r() - 0.5) * 0.8, (opts.scale ?? 1.35) * (0.95 + r() * 0.1));
      }
      if (opts.riders) for (let i = 0; i < opts.riders; i++) put(G.rider, bronze, AX + (i % 2 ? 1.8 : -1.8), top, z - len * 0.25 + i * 3.5, Math.PI, opts.scale ?? 1.35);
      if (opts.camels) for (let i = 0; i < opts.camels; i++) put(G.camel, bronze, AX + (i % 2 ? 2.4 : -2.4), top, z + len * 0.15 + i * 4, Math.PI + 0.3, 1.2);
    };
    // 大唐群英谱
    const QY = [[4966, '群英谱·佛教', 20], [5083, '群英谱·绘画', 18], [5124, '群英谱·诗歌', 18], [5166, '群英谱·书法', 18], [5209, '群英谱·科技', 18], [5266, '群英谱·天文医学', 20]];
    for (const [z, name, len] of QY) groupOnPlinth(z, len, 7, name);
    // 贞观之治：太宗骑马居中，文武群臣两列
    {
      const z = 5450, len = 40;
      const top = plinth(z, 13, len, 1.8);
      title('贞观之治', z - len / 2 - 1.8, H(AX, z - len / 2 - 1.8));
      put(G.rider, bronze, AX, top, z - 8, Math.PI, 2.6);
      for (let i = 0; i < 16; i++) {
        const row = i % 2 ? 1 : -1;
        const zz = z - 2 + Math.floor(i / 2) * 2.6;
        put(G[i % 3 === 0 ? 'wide' : 'stand'], bronze, AX + row * (3.2 + (i % 4 === 0 ? 1.5 : 0)), top, zz, Math.PI + row * 0.25, 2.0);
      }
    }
    // 房谋杜断（二人对坐）
    {
      const top = plinth(5509, 7, 9, 1.2);
      put(G.seated, bronze, AX - 1.3, top, 5509, Math.PI / 2, 1.8);
      put(G.seated, bronze, AX + 1.3, top, 5509, -Math.PI / 2, 1.8);
    }
    groupOnPlinth(5739, 30, 12, '万国来朝', { camels: 2, riders: 1, kinds: ['stand', 'wide', 'raise'] });
    groupOnPlinth(5856, 24, 10, '武后行从', { kinds: ['stand', 'stand', 'wide'], scale: 1.5 });
    // 大唐文化柱
    {
      const z = 5909, y = H(AX, z);
      plinthAt(AX, y, z, 6, 6, 2);
      // 柱身满布浮雕（人物 / 卷云分段，法线贴图 + 凹处压暗），柱头莲瓣、顶珠夜间自发光（原光面圆柱 + 夜里发黑的金珠，审查 g8）
      const colMat = columnReliefMaterial();
      floodlit(colMat, { ctx, color: 0xffc070, strength: 1.0, baseY: y + 2, height: 22, top: 0.35, upDim: 0.3 });
      const col = new THREE.CylinderGeometry(1.15, 1.35, 22, 32, 1, true);
      col.translate(0, 11, 0);
      put(col, colMat, AX, y + 2, z);
      for (const [yy, r] of [[2, 1.5], [24, 1.3]]) {
        const band = new THREE.TorusGeometry(r, 0.16, 8, 40);
        band.rotateX(Math.PI / 2);
        put(band, bronze, AX, y + yy, z);
      }
      const cap = new THREE.LatheGeometry([[1.25, 0], [1.5, 0.25], [2.1, 0.75], [2.25, 1.05], [2.0, 1.25], [1.3, 1.4], [0.9, 1.45]].map(([r, h]) => new THREE.Vector2(r, h)), 32);
      put(cap, colMat, AX, y + 24, z);
      const pearl = new THREE.SphereGeometry(1.1, 24, 16);
      pearl.translate(0, 1.1, 0);
      const pearlMat = new THREE.MeshStandardMaterial({ color: 0xd9a84a, metalness: 0.8, roughness: 0.28, emissive: 0xffb84a, emissiveIntensity: 0 });
      ctx.night.register(pearlMat, { day: 0, night: 1.6 });
      put(pearl, pearlMat, AX, y + 25.4, z);
      for (let k = 0; k < 6; k++) {
        const ring = new THREE.TorusGeometry(1.32 - k * 0.03, 0.06, 6, 32);
        ring.rotateX(Math.PI / 2);
        put(ring, led, AX, y + 4 + k * 3.8, z);
      }
      ledRect(AX - 3.2, AX + 3.2, z - 3.2, z + 3.2, y + 2.02);
    }
    // 开元盛世碑
    {
      const z = 5961, y = H(AX, z);
      plinthAt(AX, y, z, 6, 3.2, 1.6);
      const stele = new THREE.BoxGeometry(3.4, 7.5, 0.9);
      stele.translate(0, 3.75, 0);
      put(stele, stoneMat, AX, y + 1.6, z);
      titles.push(AX, y + 1.6, z, Math.PI);
      titles.plaque('开元盛世', 0, 4.3, 0.47, 1.6, 5.6, { vertical: true, bg: '#2e2418', color: '#f0c86a', border: '#b8903e' });
      titles.pop();
      titles.push(AX, y + 1.6, z, 0);
      titles.plaque('开元盛世', 0, 4.3, 0.47, 1.6, 5.6, { vertical: true, bg: '#2e2418', color: '#f0c86a', border: '#b8903e' });
      titles.pop();
    }
    // 开元盛世（开元广场）：三层圆台，玄宗居中，乐舞环绕
    {
      const z = 6101, y = H(AX, z);
      const tiers = [[15, 1.2], [11, 1.2], [7, 1.4]];
      let yy = y;
      for (const [R, h] of tiers) {
        const cyl = new THREE.CylinderGeometry(R, R + 0.3, h, 48);
        cyl.translate(0, h / 2, 0);
        put(cyl, stoneMat, AX, yy, z);
        const ring = new THREE.TorusGeometry(R + 0.15, 0.07, 5, 96);
        ring.rotateX(Math.PI / 2);
        put(ring, led, AX, yy + h + 0.03, z);
        yy += h;
      }
      put(G.wide, bronze, AX, yy, z, Math.PI, 3.6);
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        put(G[i % 2 ? 'seated' : 'raise'], bronze, AX + Math.sin(a) * 9, y + 2.4, z + Math.cos(a) * 9, a, 1.7);
      }
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2 + 0.1;
        put(G[i % 3 ? 'stand' : 'raise'], bronze, AX + Math.sin(a) * 13, y + 1.2, z + Math.cos(a) * 13, a, 1.6);
      }
      title('开元盛世', z - 17.5, y);
    }
    // 北端题名石（“大唐不夜城”）与含元殿铜模（简化为石屏）
    title('大唐不夜城', 4940, H(AX, 4940));
    // 花坛与水景（避开台座）
    const occupied = [[4954, 4978], [5006, 5026], [5072, 5094], [5113, 5135], [5155, 5177], [5198, 5220], [5254, 5278], [5428, 5472], [5502, 5516], [5722, 5756], [5842, 5870], [5904, 5914], [5957, 5965], [6084, 6118]];
    const free = [];
    for (const [a, b2] of [[ZN + 14, CROSS[0] - 2], [CROSS[1] + 2, KY[0] + 20]]) {
      let s = a;
      for (const [o0, o1] of occupied) {
        if (o1 < s || o0 > b2) continue;
        if (o0 - 2 > s) free.push([s, o0 - 2]);
        s = Math.max(s, o1 + 2);
      }
      if (s < b2) free.push([s, b2]);
    }
    for (const [z0, z1] of free) {
      if (z1 - z0 < 6) continue;
      for (const sgn of [-1, 1]) {
        // 花坛（两侧）
        const x = AX + sgn * (BELT - 0.9);
        const y = H(x, (z0 + z1) / 2);
        const curb = new THREE.BoxGeometry(1.6, 0.5, z1 - z0);
        curb.translate(x, y + 0.25, (z0 + z1) / 2);
        sb.add(curb, curbMat, null, { worldUV: 1 });
        const top = new THREE.PlaneGeometry(1.35, z1 - z0 - 0.3);
        top.rotateX(-Math.PI / 2);
        top.translate(x, y + 0.52, (z0 + z1) / 2);
        const uv = top.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.6, uv.getY(i) * (z1 - z0) / 2.2);
        sb.add(top, flowerMat);
        const lg = ribbon([x - sgn * 0.85, z0, x - sgn * 0.85, z1], 0.12, (xx, zz) => H(xx, zz), { lift: 0.08, step: 20 });
        if (lg) sb.add(lg, led);
      }
      // 水景（长池 + 金色池沿灯带）
      if (z1 - z0 > 14) {
        const y = H(AX, (z0 + z1) / 2);
        const wz0 = z0 + 3, wz1 = z1 - 3;
        const rim = new THREE.BoxGeometry(9, 0.45, wz1 - wz0);
        rim.translate(AX, y + 0.225, (wz0 + wz1) / 2);
        sb.add(rim, stoneMat, null, { worldUV: 1 });
        const w = new THREE.PlaneGeometry(8.2, wz1 - wz0 - 0.8);
        w.rotateX(-Math.PI / 2);
        w.translate(AX, y + 0.47, (wz0 + wz1) / 2);
        sb.add(w, waterMat);
        ledRect(AX - 4.15, AX + 4.15, wz0 + 0.35, wz1 - 0.35, y + 0.48);
      }
    }
    // “不倒翁”表演台（贞观广场以南，东侧步行道）
    const stage = [AX + 17, 5596];
    {
      const y = H(stage[0], stage[1]);
      const cyl = new THREE.CylinderGeometry(2.6, 2.8, 1.1, 32);
      cyl.translate(0, 0.55, 0);
      put(cyl, stoneMat, stage[0], y, stage[1]);
      const ring = new THREE.TorusGeometry(2.7, 0.07, 5, 64);
      ring.rotateX(Math.PI / 2);
      put(ring, led, stage[0], y + 1.12, stage[1]);
      const base = new THREE.SphereGeometry(0.7, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
      base.translate(0, 0.7, 0);
      put(base, ctx.mats.get('gold'), stage[0], y + 1.1, stage[1]);
    }
    const sculpt = sb.build({ castShadow: true, receiveShadow: true, name: '中央景观带' });
    root.add(sculpt);
    const tg = titles.build({ name: '雕塑题名' });
    root.add(tg);
    // 夜景地面：中央景观带两侧地埋灯（每 6 m）+ 贞观广场地埋灯阵（每 10 m），各带贴地暖光斑
    // （原先景观带夜里整体暗灰、广场地面大片暗褐，中轴反而比两侧行道树暗，审查 g8 p4_night / st_datang_n）
    const groundLights = new THREE.Group();
    groundLights.name = '不夜城地埋灯';
    {
      const ups = [], glow = [];
      for (let z = ZN + 12; z < KY[0] - 2; z += 6) {
        if (z > CROSS[0] - 3 && z < CROSS[1] + 3) continue;
        for (const sg of [-1, 1]) {
          const x = AX + sg * 5.5;
          ups.push([x, z]);
          glow.push([x, z, 2.1, 0.85]);
        }
      }
      for (let z = ZG[0] + 8; z < ZG[1] - 4; z += 10)
        for (const dx of [-28, -20, -13, 13, 20, 28]) {
          ups.push([AX + dx, z]);
          glow.push([AX + dx, z, 3.0, 0.7]);
        }
      groundLights.add(uplights(ctx, ups, { size: 0.28 }), groundGlow(ctx, glow, { color: 0xffb860, intensity: 0.5 }));
    }
    root.add(groundLights);
    // 水景池底灯：池面夜间透出暖光
    waterMat.emissive = new THREE.Color(0xffb066);
    ctx.night.register(waterMat, { day: 0, night: 0.22 });
    await tick();

    // ───── 5. 灯柱、行道树、红灯笼、光斑 ─────
    const lampMats = {
      gold: ctx.mats.get('gold'),
      glow: new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffb258, emissiveIntensity: 0, roughness: 0.4 }),
      red: ctx.mats.get('lanternRed'),
    };
    ctx.night.register(lampMats.glow, { day: 0.15, night: 2.0 });
    const inStreet = (z) => z > ZN + 10 && z < ZS - 10 && !(z > CROSS[0] - 3 && z < CROSS[1] + 3);
    const lamps = [], pools = [], trees = [], lant = [];
    for (let z = ZN + 14; z < ZS - 8; z += 20) {
      if (!inStreet(z)) continue;
      for (const s of [-1, 1]) {
        const onBelt = !(z > 6070 && z < 6130);
        if (onBelt) lamps.push([AX + s * (BELT + 1.8), H(AX + s * 10, z), z, s < 0 ? 0 : Math.PI]);
        const inZG = z > ZG[0] && z < ZG[1];
        if (!inZG) lamps.push([AX + s * 26.5, H(AX + s * 26.5, z + 10), z + 10, 0]);
      }
    }
    for (const [x, y, z] of lamps) pools.push([x, y + 0.14, z, 8]);
    // 行道树：两侧各两排（贞观广场、开元广场留空）
    for (const s of [-1, 1])
      for (const [off, st, ph] of [[15.5, 10, 0], [21, 10, 5]]) {
        for (let z = ZN + 16 + ph; z < ZS - 20; z += st) {
          if (!inStreet(z) || (z > ZG[0] + 4 && z < ZG[1] - 4) || z > KY[0] - 4) continue;
          const x = AX + s * off;
          trees.push([x, H(x, z), z, 0.85 + r() * 0.3]);
        }
      }
    // 红灯笼串：内侧树排之间悬链
    const inner = trees.filter((t) => Math.abs(Math.abs(t[0] - AX) - 15.5) < 0.1).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    for (let i = 0; i + 1 < inner.length; i++) {
      const a = inner[i], c = inner[i + 1];
      if (a[0] !== c[0] || c[2] - a[2] > 12) continue;
      const n = 6;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        lant.push([a[0], (a[1] + c[1]) / 2 + 5.0 - 0.9 * 4 * t * (1 - t), a[2] + (c[2] - a[2]) * t, 1]);
      }
    }
    // 广场灯笼阵（贞观广场、开元广场上空的灯笼串，横跨）
    for (const zz of [5360, 5380, 5540, 5560, 6056]) {
      for (let x = AX - 30; x <= AX + 30; x += 1.5) {
        const t = (x - (AX - 30)) / 60;
        lant.push([x, H(x, zz) + 8.5 - 2.2 * 4 * t * (1 - t), zz, 1.1]);
      }
    }
    const lanternMat = new THREE.MeshStandardMaterial({ color: 0xb52a1a, emissive: 0xff4a1c, emissiveIntensity: 0, roughness: 0.55 });
    ctx.night.register(lanternMat, { day: 0.12, night: 1.7 });
    // 远处隐藏的对象集合（见 FAR_HIDE）；灯柱与灯笼不投射阴影（细小构件，阴影不可辨但三角形翻倍）
    const farItems = [sculpt, tg, ground, backStreet, groundLights].filter(Boolean);
    for (const m of lampMeshes(ctx, lamps, lampMats)) {
      m.castShadow = false;
      root.add(m);
      farItems.push(m);
    }
    // 树干、树冠随远景隐藏；串灯光点（夜间才有，白天也不提交三角形）另在 update 里按昼夜与距离开关
    const [trunkM, crownM, treeLights] = treeMeshes(ctx, trees);
    for (const m of [trunkM, crownM]) {
      root.add(m);
      farItems.push(m);
    }
    root.add(treeLights);
    {
      const li = lanternInstances(lant, lanternMat, { r: 0.28 });
      li.castShadow = false;
      root.add(li);
      farItems.push(li);
      const lp = lightPools(ctx, pools, { color: 0xffa24a, night: 0.16 });
      root.add(lp);
      farItems.push(lp);
    }
    // 地面灯带：步行道边线 + 沿街台基前沿
    {
      const lb = new Batcher();
      for (const [z0, z1] of [[ZN + 4, CROSS[0] - 1], [CROSS[1] + 1, ZS - 4]])
        for (const s of [-1, 1])
          for (const off of [BELT + 0.2, HW - 1.2]) {
            if (off > 20 && z0 > CROSS[1] && false) continue;
            const x = AX + s * off;
            const g = ribbon([x, z0, x, z1], 0.1, H, { lift: 0.09, step: 16 });
            if (g) lb.add(g, led);
          }
      const lg = lb.build({ castShadow: false, name: '地面灯带' });
      root.add(lg);
    }
    let farLights = null;
    // 光柱：贞观广场四角 + 开元广场两侧（夜间）
    const beams = [];
    for (const [x, z, tx, tz] of [[1540, 5345, -0.08, -0.05], [1600, 5345, 0.08, -0.05], [1540, 5560, -0.06, 0.06], [1600, 5560, 0.06, 0.06], [AX - 22, 6085, -0.1, 0.02], [AX + 22, 6085, 0.1, 0.02], [AX - 22, 6125, -0.05, 0.08], [AX + 22, 6125, 0.05, 0.08]])
      beams.push([x, H(x, z) + 0.2, z, tx, tz]);
    root.add(lightBeams(ctx, beams, { h: 360, alpha: 0.32 }));

    // 远景金色光带：沿灯柱、中央景观带、两侧檐口的光点（1.4 km 外渐显，2~20 km 合成连续的金色南北轴线）
    {
      const fp = [];
      for (let z = ZN + 6; z < ZS - 4; z += 9) {
        if (z > CROSS[0] - 2 && z < CROSS[1] + 2) continue;
        for (const s of [-1, 1]) {
          fp.push([AX + s * 9.8, H(AX, z) + 6, z], [AX + s * 26.5, H(AX, z) + 6, z + 4.5]);
          if (!(z > ZG[0] && z < ZG[1]) && z < KY[0]) fp.push([AX + s * (HW + 2), H(AX, z) + 9, z + 2]);
        }
      }
      for (const [x0, x1, z0, z1] of [[1510, 1630, ZG[0] + 6, ZG[1] - 6], [1515, 1625, KY[0] + 6, ZS - 6]])
        for (let x = x0; x <= x1; x += 18) for (let z = z0; z <= z1; z += 18) fp.push([x, H(x, z) + 8, z]);
      farLights = farGlow(ctx, fp);
      root.add(farLights);
    }
    await tick();

    // ───── 6. 人流（顶点着色器行走） ─────
    const hz0 = ZN - 10, hdz = (ZS - ZN + 20) / 47;
    const heights = new Float32Array(48);
    for (let i = 0; i < 48; i++) heights[i] = H(AX, hz0 + i * hdz) + 0.06;
    // 人形约 200 个三角形（原积木假人约 90），高画质人数 3200 → 2800 抵消大部分增量
    const nNight = [800, 1600, 2800, 4000][lvl] ?? 2800;
    const len = ZS - ZN - 4;
    const mk = (n, hanfu) => {
      const w = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const u = r();
        let x, z, spd;
        if (u < 0.8) {
          const s = r() < 0.5 ? -1 : 1;
          const off = r() < 0.18 ? 25 + r() * 5.5 : 9.6 + r() * 19;
          x = AX + s * off;
          z = r() * len;
          spd = (r() < 0.5 ? -1 : 1) * (0.7 + r() * 0.7);
        } else if (u < 0.9) {
          // 雕塑前驻足
          const grp = [4966, 5124, 5209, 5450, 5739, 5856, 5909, 6101][(r() * 8) | 0];
          x = AX + (r() < 0.5 ? -1 : 1) * (BELT + 0.6 + r() * 5);
          z = grp - ZN + (r() - 0.5) * 20;
          spd = 0;
        } else if (u < 0.96) {
          // 广场闲逛
          const kz = r() < 0.6;
          x = kz ? 1515 + r() * 110 : AX - 38 + r() * 76;
          z = (kz ? ZG[0] + 8 + r() * (ZG[1] - ZG[0] - 16) : KY[0] + 4 + r() * 50) - ZN;
          if (!kz && Math.hypot(x - AX, z + ZN - 6101) < 16) x += 30 * Math.sign(x - AX || 1);
          spd = 0;
        } else {
          // 不倒翁表演围观
          const a = r() * Math.PI * 2, rr = 4 + r() * 5;
          x = stage[0] + Math.sin(a) * rr;
          z = stage[1] + Math.cos(a) * rr - ZN;
          spd = 0;
        }
        w.set([x, z, spd, r()], i * 4);
      }
      // 夜间多、白天少：按 count 截断，先打乱确保均匀
      return w;
    };
    const nH = Math.round(nNight * 0.4), nM = nNight - nH;
    const crowdCfg = { z0: ZN, len, heights, hz0, hdz };
    const modern = crowdMesh(ctx, personGeometry('modern'), mk(nM, false), { ...crowdCfg, colors: ['#2b2f38', '#e8e4dc', '#6d7a8a', '#3a4a5e', '#8a3a32', '#c9b79c', '#1f1f22', '#5a6b4a', '#b04a3a', '#d8d2c4', '#f0f0ee', '#344a78'], leg: 1 });
    const hanfu = crowdMesh(ctx, personGeometry('hanfu'), mk(nH, true), { ...crowdCfg, colors: ['#c8312a', '#e9c9c0', '#f2efe6', '#d8667a', '#9ec3d6', '#e0b050', '#7a3c8c', '#e87a5a', '#b8e0d2', '#ffffff', '#a82020'], leg: 0 });
    // 不倒翁表演者（固定在台上，红色唐装）
    root.add(modern, hanfu);
    {
      const perf = crowdMesh(ctx, personGeometry('hanfu'), new Float32Array([stage[0], stage[1] - ZN, 0, 0.5]), { ...crowdCfg, heights: heights.map(() => H(stage[0], stage[1]) + 1.75), colors: ['#d42a1e'], leg: 0 });
      perf.scale.set(1, 1, 1);
      root.add(perf);
    }

    // ───── 7. 灯光（点光源池） ─────
    for (let z = ZN + 30, i = 0; z < ZS; z += 55, i++) {
      if (!inStreet(z)) continue;
      const s = i % 2 ? 1 : -1;
      // 灯在景观带边灯柱的顶灯处（x ±10、离地 8 m）；原先 x ±18、离地 7 m 正好在内侧树排（±15.5）的树冠里，
      // 树冠被照成一团黄绿色发光球（审查 g8）
      ctx.lights.add({ position: new THREE.Vector3(AX + s * 10, H(AX, z) + 8, z), color: 0xffb05a, intensity: 300, distance: 34, nightOnly: true, priority: 1.6 });
    }
    // 雕塑群上空的点光源降强度（原 900~1100 cd 自上而下把整组铜像打成均匀橙色，盖过台座向上的泛光，审查 g8）
    for (const [x, z, y, I] of [[AX, 5450, 12, 340], [AX, 6101, 14, 420], [stage[0], stage[1], 6, 350], [1520, 5512, 16, 900], [1620, 5510, 14, 800], [AX, 5909, 10, 240]])
      ctx.lights.add({ position: new THREE.Vector3(x, H(x, z) + y, z), color: 0xffc27a, intensity: I, distance: 70, nightOnly: true, priority: 2.2 });

    // ───── 8. 标注 ─────
    ctx.labels.add('大唐不夜城', new THREE.Vector3(AX, yMid + 40, 5200), { category: 'district', minDist: 200, maxDist: 16000, priority: 5 });
    ctx.labels.add('陕西大剧院', new THREE.Vector3(1478, H(1478, 5512) + 36, 5512), { category: 'landmark', minDist: 80, maxDist: 3000, priority: 2 });
    ctx.labels.add('西安音乐厅', new THREE.Vector3(1645, H(1645, 5510) + 30, 5510), { category: 'landmark', minDist: 80, maxDist: 3000, priority: 2 });
    ctx.labels.add('开元广场', new THREE.Vector3(AX, H(AX, 6101) + 22, 6101), { category: 'landmark', minDist: 80, maxDist: 4000, priority: 1.8 });

    // 招牌亮度：古建构件库匾额默认夜间 0.55，不夜城需更亮（后注册覆盖）
    root.traverse((o) => {
      if (o.isMesh && o.name === 'plaque') ctx.night.register(o.material, { day: 0.02, night: 1.0 });
    });

    // 统计
    let tris = 0, draws = 0;
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      draws++;
      const g = o.geometry;
      const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
      tris += o.isInstancedMesh ? t * o.count : t;
    });
    const brk = root.children.map((c) => {
      let t = 0, d = 0;
      c.traverse((o) => {
        if (!o.isMesh) return;
        d++;
        const g = o.geometry;
        t += ((g.index ? g.index.count : g.attributes.position.count) / 3) * (o.isInstancedMesh ? o.count : 1);
      });
      return `${c.name}:${d}/${(t / 1000).toFixed(0)}k`;
    });
    console.warn('[datang] ' + brk.join(' '));
    console.warn(`[datang] build ${(performance.now() - t0).toFixed(0)} ms, meshes ${draws}, tris ${(tris / 1e6).toFixed(2)} M, lamps ${lamps.length}, trees ${trees.length}, lanterns ${lant.length}, people ${nNight}，让位档案建筑 ${nTaken} 处`);

    const crowds = [modern, hanfu];
    const totals = [nM, nH];
    // —— 近景细模：相机 NEAR_R 米内的游客改用 people-geo 的真实比例人形（步态、衣着、发型），远处仍是轻量人形 ——
    const NEAR_R = 55, NEAR_CAP = 700;
    const nearMat = peopleMaterial(ctx);
    const nearGeo = peopleGeometry(0);
    const NW = createPeopleMesh(ctx, nearGeo, nearMat, NEAR_CAP, '不夜城人流（近景）');
    nearGeo.dispose();
    NW.mesh.customDepthMaterial = peopleDepthMaterial(ctx);
    NW.mesh.castShadow = false;
    NW.mesh.receiveShadow = true;
    root.add(NW.mesh);
    // 每人固定外观（按序号播种）：汉服游客用长外套 + 汉服配色近似
    const HANFU_TOP = [0xc8312a, 0xe9c9c0, 0xf2efe6, 0xd8667a, 0x9ec3d6, 0xe0b050, 0x7a3c8c, 0xe87a5a, 0xb8e0d2, 0xf4f2ec, 0xa82020];
    const looks = crowds.map((m, ci) => {
      const n = m.userData.walkers.length / 4, out = new Array(n);
      for (let i = 0; i < n; i++) {
        let sd = (i + 1) * 2654435761 % 4294967296 + ci * 97;
        const rnd = () => ((sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296);
        const ap = randomLook(rnd);
        if (ci === 1) { ap.mask = (ap.mask | MASK.COAT) & ~(MASK.HOOD | MASK.OPEN | MASK.CAP | MASK.BEANIE | MASK.PHONE); ap.cols[2] = HANFU_TOP[i % HANFU_TOP.length]; ap.cols[4] = HANFU_TOP[(i * 7 + 3) % HANFU_TOP.length]; }
        out[i] = ap;
      }
      return out;
    });
    const uTimeRef = ctx.uniforms.uTime;
    const updateNear = (on) => {
      const cp = ctx.camera.position;
      NW.reset();
      crowds.forEach((m) => { const h = m.userData.crowdU.uHide.value; h.set(cp.x, cp.z, on ? NEAR_R : 0, 0); });
      if (!on) { NW.commit(); return; }
      const t = uTimeRef.value;
      crowds.forEach((m, ci) => {
        const W = m.userData.walkers, C = m.userData.cfg, L = looks[ci];
        const n = Math.min(m.count, W.length / 4);
        for (let i = 0; i < n && !NW.full(); i++) {
          const x = W[i * 4], y0 = W[i * 4 + 1], spd = W[i * 4 + 2], w = W[i * 4 + 3];
          if (Math.abs(x - cp.x) > NEAR_R) continue;
          const z = C.z0 + (((y0 + spd * t) % C.len) + C.len) % C.len;
          const dd = Math.hypot(x - cp.x, z - cp.z);
          if (dd >= NEAR_R) continue;
          // 镜头前 2.6 m 内不放人（原先人流穿过相机位置，1~2 m 处出现半个人身/后脑勺挡住画面，审查 g8 st_datang_n）
          if (dd < 2.6) continue;
          const hi = Math.min(46.999, Math.max(0, (z - C.hz0) / C.hdz)), i0 = Math.floor(hi);
          const y = C.heights[i0] + (C.heights[i0 + 1] - C.heights[i0]) * (hi - i0);
          const moving = Math.abs(spd) > 0.001;
          const yaw = moving ? (spd > 0 ? 0 : Math.PI) : w * Math.PI * 2;
          const ap = L[i];
          NW.put(x, y, z, yaw, ap.height / 1.7, ap, w, moving ? Math.abs(spd) * ap.speedK : 0, 0);
        }
      });
      NW.commit();
    };
    farItems.push(modern, hanfu);
    // 阴影开关：建成时投射阴影的网格（整片按距离切换）
    const casters = [];
    root.traverse((o) => { if (o.isMesh && o.castShadow) casters.push(o); });
    let farOn = true, shadowOn = true, frame = 0;
    return {
      /** 诊断（tools/check_overlap*.mjs）：程序化唐风建筑已给逐栋档案建筑让位（沿街区排除区不再代表“这里有唐风楼”） */
      diag: () => ({ yieldToDossier: true, taken: nTaken }),
      update() {
        frame++;
        const cp = ctx.camera.position;
        // 相机到步行街轴线矩形（AX±HW，ZN..ZS）的水平距离 + 离地高
        const dx = Math.max(0, Math.abs(cp.x - AX) - HW), dz = Math.max(0, ZN - cp.z, cp.z - ZS);
        const d = Math.hypot(dx, dz, Math.max(0, cp.y - yMid));
        const near = d < FAR_HIDE;
        if (near !== farOn) {
          farOn = near;
          for (const o of farItems) o.visible = near;
          if (!near) updateNear(false);
        }
        if (frame % 10 === 1) {
          const sh = d < shadowReach(ctx, SHADOW_D, 30);
          if (sh !== shadowOn) {
            shadowOn = sh;
            for (const o of casters) o.castShadow = sh;
          }
        }
        const k = ctx.sky ? ctx.sky.night ?? 0 : 0;
        treeLights.visible = near && k > 0.15 && d < 2500;
        if (farLights) farLights.visible = k > 0.15 && d > 1200;
        if (!near) return;
        // 人流：夜多昼少 × 随距离减少（500 m 内全量，到 FAR_HIDE 的 1/3 处降到 1/4）
        const dk = 1 - 0.75 * Math.min(1, Math.max(0, (d - 500) / Math.max(1, FAR_HIDE / 3 - 500)));
        const f = (0.4 + 0.6 * k) * dk;
        crowds.forEach((m, i) => (m.count = Math.max(1, Math.floor(totals[i] * f))));
        // 近景细模：相机离地 40 m 内、离步行街 60 m 内才启用
        const nearOn = d < 60 && cp.y - yMid < 40;
        updateNear(nearOn);
      },
      setLayer(layer, visible) {
        if (layer === 'landmarks') root.visible = visible;
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};
