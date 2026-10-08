// 通用城市建筑：由 public/data/buildings.bin（v1 / v2，见 docs/CONTRACT.md 3.4）生成全城十几万栋建筑。
//
// 结构（几何在 Web Worker 里生成，见 src/arch/bld-gen.js；立面全部由着色器程序化生成，见 src/arch/bld-shader.js）：
//   · 远景 lo：8 km 大块合批，块内 1 km 小块按 Morton 序连续排列；每帧对 1 km 小块做视锥/距离剔除，
//     把可见小块合并成 ≤ 4 段 drawRange（块级剔除 + 少量 draw call）；外墙共享角点、轮廓简化、无女儿墙。
//   · 近景 hi：相机附近（离地 < 900 m）的 1 km 小块按需生成：外墙逐边独立 UV（开间避开转角）、女儿墙、
//     窗洞视差凹进 + 简化室内映射；hi 接管的小块在 lo 顶点着色器里整栋塌缩（uHiRect），两者严格互补。
//   · 立面附属几何（近景小块内，按画质细节档位 DETAIL）：南向凸阳台叠柱、东西北向凸窗、高层顶部构架、老式多层北向单元入口雨棚、
//     底商雨棚——只出体块（给轮廓与自阴影），楼层内的栏板/玻璃/楼板线/防盗笼/晾晒/夜间亮灯由立面着色器按构件类型画；
//     与近景外墙同一网格、同一材质，不增加 draw call。低画质不生成。
//   · 老旧多层“平改坡”：无小区风貌依据的 80~90 年代板楼按年代概率加红/橙红/灰蓝瓦四坡顶（远近景几何都有）。
//   · 屋顶构件（11 种实例，见 PROP_NAMES）：高层电梯机房 + 楼梯间（挑檐/门/百叶）、机房顶水箱、构架收头（满铺花架或四周飘板）、
//     通信天线；多层每单元上人孔小屋、厨卫排风道、逐台的成排太阳能热水器、圆/方水箱；商业办公多联机、冷却塔、临街广告牌支架。
//     随近景小块实例化；小构件（水箱、空调、热水器、天线、排风道）只画相机 650 m 内的小块。
//   · 近景细部层（相机离地 < 100 m、300 m 内的 400 m 小格，Worker 按需生成，bld-gen.js nearChunk）：老楼外挂空调、防盗窗（镂空、
//     alpha-to-coverage）、窗外晾衣，高层空调格栅机位、凸阳台每层楼板挑檐，所有楼的勒脚凸台；位置与立面着色器逐位一致。
//   · 屋面（第二张数据纹理 uBld2：主轴角/屋面中心/半长半宽/屋面类型/勒脚高/小区种子）：按楼型与年代画上人屋面面砖、矿物面卷材、
//     老沥青油毡、TPO/碎石、彩钢板、水泥砂浆，主轴对齐的分格缝/卷材搭接/排水坡分水线/雨水口，远处淡化为均值。
//   · 同一小区（landuse residential 多边形）的住宅楼共用主色、点缀色、立面变体、阳台做法、屋面做法、勒脚。
//   · 航空障碍灯：高度 ≥ 100 m 的楼顶四角红色闪光灯（Points）。
//   · 夜景：按时段的亮灯率曲线（住宅/办公/商业）驱动着色器里的亮灯（住宅按户成组、楼梯间声控灯、单元门灯、雨棚下店铺灯光）；
//     约 1/3 的高层/写字楼楼顶亮化（顶部泛光 + 轮廓灯带，中画质以上）。
//   · 小区风貌：public/data/estates_style.json（tools/build_estates.py，按档案与实景照片）——落在有照片依据的小区多边形内的
//     住宅楼按小区 style 着色与生成细节（墙色/点缀色/窗套/腰线/阳台/坡屋顶/塔冠/构架），参数走一张 RGBA32F 小纹理（uEst），
//     不新建材质；有照片依据的小区大门合并成一个网格（src/arch/bld-estates.js）。
// 对外 API：nearestFacade(x, z, maxDist) → {x, z, nx, nz, height, index, …}（招牌模块用）、occluded()（标注遮挡）
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { parseBuildings, createGenerator, CHUNK, LO_STRIDE, HI_STRIDE, LO_QXZ, STYLE_NAMES, packEstateStyles } from '../arch/bld-gen.js';
import { createFacadeMaterials, createDataTexture, createDataTexture2, createClassTexture, createEstateTexture } from '../arch/bld-shader.js';
import { buildEstateGates } from '../arch/bld-estates.js';
import { loadJSON } from '../core/data.js';
import { preprocess } from '../arch/bld-skip.js';
import { classifyBuildings, classTextureData, BLD_CLASSES } from '../arch/bld-class.js';
import { shadowReach } from '../arch/perf-lod.js';
import BldWorker from '../arch/bld-worker.js?worker&inline';

const HI_AGL = 900; // 相机离地高于此值不使用近景小块
const HI_RADIUS = [650, 900, 1200, 1500]; // 近景半径（按画质档位）
const MAX_RUNS = 4; // 每个远景大块最多几段 drawRange
const GAP_MERGE = 60000; // 相邻可见段之间的不可见索引数小于此值时合并（少一次 draw call）
const NEAR_KEEP = 1300; // 相机附近的小块即使不在视锥内也绘制（保证画面外建筑的阴影）
const FAR_D = [2500, 3200, 4000, 5500]; // 超过此距离的小块改用超远景子集（只画显眼建筑，且不投射阴影）
// 远景全集里只有离相机此距离内的小块投射阴影（阴影贴图只覆盖相机周围几百米到一两公里，更远的块进阴影通道纯属浪费）：
// 同一套索引分成“投影段 / 不投影段”两组网格，各自 ≤ MAX_RUNS 段
const SHADOW_D = [900, 1400, 2000, 2800];
// 超过此距离改用“超远景·精简子集”（只有高 ≥ 40 m 或占地 ≥ 3000 m² 的楼；地面视角下几公里外的小楼亚像素且多被近楼遮挡）
const FAR2_D = [4500, 6000, 8000, 11000];
const HI_CACHE = 40; // 近景小块缓存上限
// 近景细部层（bld-gen.js nearChunk）：400 m 小格、相机 300 m 内、离地 100 m 以下
const NEAR_CELL = 400, NEAR_R = 300, NEAR_AGL = 100, NEAR_CACHE = 24;
// 立面细节档位（按画质）：0 低 = 不生成立面附属几何、关闭楼顶亮化与单元门；1 中 = 凸阳台/凸窗叠柱、单元入口雨棚（着色器同时画单元门）；2 高/超高 = 再加顶部构架、底商雨棚
const DETAIL = [0, 1, 2, 2];

// —— 亮灯率曲线（北京时间小时 → 亮灯比例）：傍晚高、午夜后下降 ——
const LIT_RES = [[0, 0.27], [1, 0.17], [2, 0.1], [4, 0.06], [5.5, 0.08], [6.5, 0.22], [7.5, 0.15], [9, 0.08], [16, 0.08], [17.5, 0.24], [19, 0.42], [20.5, 0.5], [22, 0.45], [23, 0.36], [24, 0.27]];
const LIT_OFF = [[0, 0.12], [5, 0.08], [7, 0.2], [8.5, 0.8], [17, 0.85], [18, 0.76], [19, 0.56], [20.5, 0.4], [22, 0.26], [23, 0.17], [24, 0.12]];
const LIT_COM = [[0, 0.34], [1, 0.2], [3, 0.1], [6, 0.12], [8, 0.5], [10, 0.9], [21.5, 0.95], [22.5, 0.7], [23.5, 0.45], [24, 0.34]];
function curve(tab, h) {
  h = ((h % 24) + 24) % 24;
  for (let k = 1; k < tab.length; k++) {
    if (h <= tab[k][0]) {
      const [h0, v0] = tab[k - 1], [h1, v1] = tab[k];
      return v0 + ((v1 - v0) * (h - h0)) / Math.max(1e-6, h1 - h0);
    }
  }
  return tab[tab.length - 1][1];
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ———— Worker 调用（失败时回退主线程） ————
class GenClient {
  constructor() {
    this.q = [];
    this.w = null;
    this.local = null;
    this.initMsg = null;
    try {
      this.w = new BldWorker();
      this.w.onmessage = (e) => {
        const job = this.q.shift();
        if (job) job.resolve(e.data);
      };
      this.w.onerror = (e) => {
        console.warn('[buildings] Worker 出错，回退主线程生成', e && e.message);
        this._fail();
      };
    } catch (e) {
      console.warn('[buildings] 无法创建 Worker，回退主线程生成', e);
      this.w = null;
    }
  }
  _fail() {
    if (this.w) this.w.terminate();
    this.w = null;
    const jobs = this.q;
    this.q = [];
    for (const j of jobs) this._runLocal(j);
  }
  _runLocal(job) {
    setTimeout(() => {
      if (!this.local) {
        this.local = createGenerator();
        if (this.initMsg && job.msg.type !== 'init') this.local.handle(this.initMsg);
      }
      let r;
      try {
        r = this.local.handle(job.msg).msg;
      } catch (err) {
        r = { type: 'error', message: String((err && err.stack) || err) };
      }
      job.resolve(r);
    }, 0);
  }
  /** 不转移（transfer）主线程数据：Worker 失败时还能用同一消息在主线程重跑 */
  call(msg) {
    if (msg.type === 'init') this.initMsg = msg;
    return new Promise((resolve) => {
      const job = { msg, resolve };
      if (this.w) {
        this.q.push(job);
        this.w.postMessage(msg);
      } else this._runLocal(job);
    });
  }
  dispose() {
    if (this.w) this.w.terminate();
    this.w = null;
  }
}


/** 临街判定用道路（主干道 + 支路 + 步行街） */
function packRoads(roads) {
  const feats = roads?.features || [];
  const keep = new Set([1, 2, 3, 4, 5, 7, 12]);
  let np = 0, nr = 0;
  for (const f of feats) if (keep.has(f.c) && f.p && f.p.length >= 4) (np += f.p.length / 2), nr++;
  const pts = new Float32Array(np * 2), starts = new Int32Array(nr + 1), widths = new Float32Array(nr);
  let o = 0, r = 0;
  for (const f of feats) {
    if (!keep.has(f.c) || !f.p || f.p.length < 4) continue;
    pts.set(f.p, o * 2);
    starts[r] = o;
    widths[r] = f.w || 8;
    o += f.p.length / 2;
    r++;
  }
  starts[nr] = o;
  return { pts, starts, widths };
}

/** 小区分组用的住区多边形（landuse residential 外环，扁平坐标 + 起点表），见 bld-gen.js buildGroupIndex */
function packGroups(landuse) {
  const polys = (landuse?.polys || []).filter((p) => p.k === 'residential' && p.outer && p.outer.length >= 6);
  let np = 0;
  for (const p of polys) np += p.outer.length / 2;
  const pts = new Float32Array(np * 2), starts = new Int32Array(polys.length + 1);
  let o = 0;
  polys.forEach((p, k) => {
    starts[k] = o;
    pts.set(p.outer, o * 2);
    o += p.outer.length / 2;
  });
  starts[polys.length] = o;
  return { pts, starts };
}

// ———— 屋顶构件几何（单位尺寸，实例缩放；顶点色 × 实例色） ————
function tint(g, c) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) (a[i * 3] = c[0]), (a[i * 3 + 1] = c[1]), (a[i * 3 + 2] = c[2]);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g.index) g = g.toNonIndexed();
  return g;
}
// 屋顶构件类型（与 bld-gen.js roofProps 的 type 编号一致）
const PROP_NAMES = ['屋顶盒体构件', '屋顶圆水箱', '屋顶空调机组', '太阳能热水器', '冷却塔', '屋顶广告牌', '方形水箱', '通信天线', '机房与楼梯间', '排风道出屋面', '高层构架收头'];
// 投射阴影的构件（小构件不投影，省一半三角形）
const PROP_SHADOW = [true, false, false, false, true, true, false, false, true, false, false];
// 小构件（圆水箱、空调机组、热水器、方水箱、天线、排风道）只在相机附近的近景小块里画（远处几个像素、三角形却不少）
const PROP_SMALL = [false, true, true, true, false, false, true, true, false, true, false];
const PROP_SMALL_R = 650;
const box3 = (w, h, d, x, y, z, c) => tint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), c);
function propGeometries() {
  // 构件三角形预算：老城屋面由坡顶改回平屋面后构件数量翻倍（审查 st_eastgate），每种构件都压到够用的最少面数
  // 0 盒体：彩钢棚/通风器/构架梁柱/门/百叶（底面在 y=0；构架梁悬空，底面要保留）
  const box = tint(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), [1, 1, 1]);
  // 1 水箱：不锈钢/玻璃钢圆罐（8 边，顶盖；总是坐在屋面或机房顶上，去掉底面）
  const tank = tint(new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, false).translate(0, 0.5, 0), [1, 1, 1]);
  dropFace(tank, 0, -1, 0);
  // 2 空调室外机组（多联机）：机身 + 顶部风扇格栅（深色顶板）
  const ac = mergeGeometries([
    tint(new THREE.BoxGeometry(1, 0.86, 1).translate(0, 0.43, 0), [1, 1, 1]),
    tint(new THREE.BoxGeometry(0.92, 0.08, 0.86).translate(0, 0.9, 0), [0.16, 0.16, 0.17]),
  ]);
  // 3 太阳能热水器（朝南 +Z）：真空管集热板（深蓝黑）倾角 40° + 顶部储水罐 + 支架，实尺寸 1.8×1.4 m
  //   储水罐为积灰的不锈钢（审查 st_shanbo：原 0.86 近白反照率在成排拼接后像一根发光灯管）
  const tilt = (40 * Math.PI) / 180;
  const solar = mergeGeometries([
    // 集热板：朝上一块面片（逐台实例后每台三角形要省）
    tint(new THREE.PlaneGeometry(1.8, 1.4).rotateX(-Math.PI / 2).rotateX(tilt).translate(0, 0.34 + 0.7 * Math.sin(tilt), 0.2), [0.07, 0.09, 0.13]),
    tint(new THREE.CylinderGeometry(0.2, 0.2, 1.9, 6, 1, true).rotateZ(Math.PI / 2).translate(0, 0.3 + 1.4 * Math.sin(tilt) + 0.12, 0.2 - 0.7 * Math.cos(tilt) - 0.1), [0.5, 0.51, 0.5]),
    // 支架背板：一块朝北的面片（原薄盒 12 个三角形）+ 前脚一道镀锌角钢（面片）
    tint(new THREE.PlaneGeometry(1.7, 1.2).rotateY(Math.PI).translate(0, 0.6, -0.38), [0.42, 0.42, 0.41]),
    tint(new THREE.PlaneGeometry(1.75, 0.3).translate(0, 0.15, 0.74), [0.5, 0.51, 0.51]),
  ]);
  // 4 冷却塔（方形横流式，商业/办公楼屋面）：塔体 + 两侧进风百叶（深色）+ 顶部风筒与风机（深灰）
  const cool = mergeGeometries([
    box3(1, 0.72, 1, 0, 0.36, 0, [1, 1, 1]),
    box3(1.02, 0.42, 0.9, 0, 0.3, 0, [0.32, 0.34, 0.35]),
    box3(0.9, 0.04, 0.9, 0, 0.74, 0, [0.86, 0.86, 0.85]),
    tint(new THREE.CylinderGeometry(0.34, 0.36, 0.26, 12, 1, true).translate(0, 0.89, 0), [0.6, 0.62, 0.63]),
    tint(new THREE.CircleGeometry(0.33, 12).rotateX(-Math.PI / 2).translate(0, 0.94, 0), [0.12, 0.12, 0.13]),
  ]);
  // 5 屋顶广告牌：钢架（立柱 + 斜撑 + 横梁，深灰）+ 牌面（正面朝 +Z，实例色 = 底色），实尺寸 1×1×1 → 按牌长/高/支架深缩放
  const fr = [0.32, 0.33, 0.34];
  const bill = mergeGeometries([
    box3(1, 0.62, 0.04, 0, 0.69, 0.02, [1, 1, 1]),
    box3(1.02, 0.03, 0.06, 0, 1.0, 0.02, [0.85, 0.85, 0.83]),
    box3(1.02, 0.03, 0.06, 0, 0.385, 0.02, [0.85, 0.85, 0.83]),
    box3(0.03, 0.4, 0.03, -0.42, 0.2, -0.02, fr), box3(0.03, 0.4, 0.03, 0.42, 0.2, -0.02, fr), box3(0.03, 0.4, 0.03, 0, 0.2, -0.02, fr),
    box3(0.03, 0.9, 0.03, -0.42, 0.55, -0.6, fr), box3(0.03, 0.9, 0.03, 0.42, 0.55, -0.6, fr),
    box3(0.03, 0.03, 0.62, -0.42, 0.68, -0.3, fr), box3(0.03, 0.03, 0.62, 0.42, 0.68, -0.3, fr),
    box3(0.9, 0.03, 0.03, 0, 0.98, -0.6, fr),
    tint(new THREE.BoxGeometry(0.025, 0.025, 0.85).rotateX(-0.95).translate(-0.42, 0.42, -0.3), fr),
    tint(new THREE.BoxGeometry(0.025, 0.025, 0.85).rotateX(-0.95).translate(0.42, 0.42, -0.3), fr),
  ]);
  // 6 方形不锈钢水箱 + 型钢支座（老楼、城中村、商业屋面）：约 30 个三角形——箱体 + 一道加强肋 + 支座四面 + 人孔盖
  const st = [0.36, 0.37, 0.38];
  const ring = (w, h, y, c) => {
    const g = tint(new THREE.BoxGeometry(w, h, w).translate(0, y, 0), c);
    dropFace(g, 0, -1, 0);
    return dropFace(g, 0, 1, 0);
  };
  const tankSq = mergeGeometries([
    box3(1, 0.72, 1, 0, 0.61, 0, [1, 1, 1]),
    ring(1.03, 0.05, 0.6, [0.8, 0.8, 0.8]),
    ring(0.92, 0.25, 0.125, st),
    tint(new THREE.PlaneGeometry(0.2, 0.2).rotateX(-Math.PI / 2).translate(0.28, 0.975, 0.28), [0.62, 0.62, 0.62]),
  ]);
  dropFace(tankSq, 0, -1, 0);
  // 7 通信基站天线（高层/写字楼屋面）：抱杆 + 三面板状天线 + 底部机柜，实尺寸 1×1×1 → 高度按 6~9 m 缩放
  const pole = [0.62, 0.63, 0.64];
  const ant = mergeGeometries([
    tint(new THREE.CylinderGeometry(0.012, 0.016, 1, 6, 1, true).translate(0, 0.5, 0), pole),
    ...[0, 2.094, 4.189].map((a) =>
      tint(new THREE.BoxGeometry(0.05, 0.2, 0.016).translate(0, 0.84, 0.035).rotateY(a), [0.86, 0.86, 0.84])
    ),
    box3(0.07, 0.11, 0.05, 0.06, 0.055, 0.0, [0.78, 0.79, 0.8]),
  ]);
  // 8 电梯机房 / 楼梯间（出屋面小屋）：墙体（实例色 = 楼体色）+ 挑出的屋面板 + 一樘深色门 + 侧面百叶
  //   （约 26 个三角形：墙体去底 10 + 屋面板 12 + 门、百叶各一块面片）
  const hutBody = tint(new THREE.BoxGeometry(1, 0.92, 1).translate(0, 0.46, 0), [1, 1, 1]);
  dropFace(hutBody, 0, -1, 0);
  dropFace(hutBody, 0, 1, 0);
  const hut = mergeGeometries([
    hutBody,
    box3(1.07, 0.08, 1.07, 0, 0.96, 0, [0.95, 0.94, 0.92]),
    tint(new THREE.PlaneGeometry(0.24, 0.6).translate(0.22, 0.3, 0.503), [0.2, 0.19, 0.18]),
    tint(new THREE.PlaneGeometry(0.34, 0.16).rotateY(Math.PI / 2).translate(0.503, 0.7, -0.1), [0.42, 0.43, 0.43]),
  ]);
  // 9 厨卫排风道出屋面：砌体 + 架空的混凝土风帽板（约 22 个三角形）
  const shaftBody = tint(new THREE.BoxGeometry(1, 0.8, 1).translate(0, 0.4, 0), [1, 1, 1]);
  dropFace(shaftBody, 0, -1, 0);
  const shaft = mergeGeometries([shaftBody, box3(1.35, 0.06, 1.4, 0, 0.95, 0, [0.82, 0.82, 0.8])]);
  // 10 高层构架收头的梁柱（与 0 同为盒体，单独一组：不投射阴影）
  return [box, tank, ac, solar, cool, bill, tankSq, ant, hut, shaft, box.clone()];
}
/** 去掉法线为 (nx,ny,nz) 的面（非索引几何，按三角形逐个检查；屋顶构件贴在屋面上的底面永远看不见） */
function dropFace(g, nx, ny, nz) {
  const p = g.attributes.position.array, n = g.attributes.normal.array;
  const keep = [];
  for (let t = 0; t < p.length / 9; t++) {
    const o = t * 9;
    if (n[o] * nx + n[o + 1] * ny + n[o + 2] * nz > 0.99) continue;
    keep.push(t);
  }
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name], s = a.itemSize, src = a.array;
    const out = new src.constructor(keep.length * 3 * s);
    keep.forEach((t, k) => out.set(src.subarray(t * 3 * s, (t + 1) * 3 * s), k * 3 * s));
    g.setAttribute(name, new THREE.BufferAttribute(out, s));
  }
  return g;
}

// ———— 航空障碍灯（红色中光强闪光灯，约 40 次/分） ————
function makeObstacleLights(ctx, arr) {
  const n = arr.length / 4;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), ph = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = arr[i * 4];
    pos[i * 3 + 1] = arr[i * 4 + 1];
    pos[i * 3 + 2] = arr[i * 4 + 2];
    ph[i] = arr[i * 4 + 3];
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  g.computeBoundingSphere();
  // 屏幕尺寸封顶约 3 px、HDR 亮度压低（审查 p7_night：成片住宅楼顶的红色光团被泛光放大成“火灾”）
  const m = new THREE.PointsMaterial({ size: 3.0, sizeAttenuation: false, transparent: true, depthWrite: false, fog: true });
  m.color.setRGB(2.6, 0.08, 0.04);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPhase;\nuniform float uTime;\nuniform float uNight;\nvarying float vBlink;')
      .replace(
        'gl_PointSize = size;',
        `float bph = fract(uTime / 1.5 + aPhase);
        vBlink = smoothstep(0.0, 0.05, bph) * (1.0 - smoothstep(0.3, 0.42, bph)) * mix(0.04, 1.0, smoothstep(0.1, 0.6, uNight));
        // 远距离衰减：从低机位远看，成片高楼的障碍灯会压到地平线上叠成红色光团再被泛光放大，3 km 起减弱、9 km 外不可见
        float obD = length(mvPosition.xyz);
        float obFade = 1.0 - smoothstep(3000.0, 9000.0, obD);
        vBlink *= obFade * obFade;
        gl_PointSize = size * clamp(1.2 - obD / 8000.0, 0.6, 1.0);`
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBlink;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= smoothstep(0.5, 0.15, length(gl_PointCoord - 0.5)) * vBlink;');
  };
  m.customProgramCacheKey = () => 'xian-bld-obstacle-v3';
  const pts = new THREE.Points(g, m);
  pts.name = '航空障碍灯';
  pts.renderOrder = 5;
  return pts;
}

export default {
  id: 'buildings',
  name: '城市建筑',

  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = '通用城市建筑';
    ctx.scene.add(root);
    const P = parseBuildings(ctx.data.buildings);
    if (!P) {
      console.warn('[buildings] buildings.bin 缺失或格式错误');
      const none = () => null;
      return { update() {}, setLayer() {}, nearestFacade: none, api: { nearestFacade: none }, dispose() { ctx.scene.remove(root); } };
    }
    const N = P.count;
    const pre = preprocess(ctx, P);
    // 最终让位结果（含按轮廓比例的判定）挂到排除区对象上，招牌模块据此判断楼是否存在，与渲染保持一致
    if (ctx.exclusions) ctx.exclusions.buildingSkip = pre.skip;
    const roads = packRoads(ctx.data.roads);
    const tPre = performance.now() - t0;
    // 小区风貌（可选数据；缺失时全部按通用规则）
    const estDoc = await loadJSON('estates_style.json', { optional: true });

    // —— Worker：解析 + 分类 + 数据纹理 + 远景几何 ——
    const gen = new GenClient();
    const init = await gen.call({ type: 'init', buffer: ctx.data.buildings, ga: pre.ga, base: pre.base, skip: pre.skip, roads, estates: estDoc, groups: packGroups(ctx.data.landuse) });
    if (!init || init.type !== 'init' || !init.ok) {
      gen.dispose();
      throw new Error('建筑生成失败：' + ((init && init.message) || '未知错误'));
    }
    const t1 = performance.now();
    const texArr = init.tex;
    const dataTex = createDataTexture(texArr, init.texRows);
    const mats = createFacadeMaterials(ctx, dataTex);
    const U = mats.uniforms;
    if (init.tex2) {
      U.uBld2.value.dispose();
      U.uBld2.value = createDataTexture2(init.tex2, init.texRows);
    }
    if (estDoc?.styles?.length) {
      const pk = packEstateStyles(estDoc.styles);
      U.uEst.value.dispose();
      U.uEst.value = createEstateTexture(pk.data, pk.width);
    }
    U.uDrawDist.value = ctx.quality.buildingDistance || 16000;
    let hiRadius = HI_RADIUS[ctx.quality.level ?? 2] || 1200;
    let detailLvl = DETAIL[ctx.quality.level ?? 2] ?? 2;
    U.uBDetail.value = detailLvl;
    let hiGen = 0; // 细节档位变化时递增：旧档位生成中的小块回来后丢弃重建

    // —— 远景大块 ——
    const loGroup = new THREE.Group();
    loGroup.name = '建筑远景';
    root.add(loGroup);
    const blocks = [];
    const chunkDir = new Map();
    for (const b of init.blocks) {
      const ib = new THREE.InterleavedBuffer(b.vbuf, LO_STRIDE);
      const blk = {
        ox: b.ox, oz: b.oz,
        pos: new THREE.InterleavedBufferAttribute(ib, 3, 0),
        dat: new THREE.InterleavedBufferAttribute(ib, 3, 3),
        // 索引集：0 远景全集（set 0 投影 / set 2 不投影共用）、1 超远景子集、3 超远景精简子集
        idx: [new THREE.BufferAttribute(b.ibuf, 1), new THREE.BufferAttribute(b.fibuf, 1), null, new THREE.BufferAttribute(b.fibuf2 || b.fibuf, 1)],
        chunks: [], pool: [[], [], [], []], box: new THREE.Box3(), localBox: null, localSphere: null, tris: b.ibuf.length / 3,
      };
      for (const c of b.chunks) {
        const box = new THREE.Box3(new THREE.Vector3(c.bounds[0], c.bounds[1], c.bounds[2]), new THREE.Vector3(c.bounds[3], c.bounds[4], c.bounds[5]));
        const ch = { cx: c.cx, cz: c.cz, r: [c.start, c.fstart, c.start, c.f2start ?? c.fstart], c: [c.count, c.fcount, c.count, c.f2count ?? c.fcount], box, n: c.n };
        blk.chunks.push(ch);
        blk.box.union(box);
        chunkDir.set(c.cx + ',' + c.cz, ch);
      }
      const lb = blk.box;
      blk.localBox = new THREE.Box3(
        new THREE.Vector3((lb.min.x - b.ox) * LO_QXZ, lb.min.y * 10, (lb.min.z - b.oz) * LO_QXZ),
        new THREE.Vector3((lb.max.x - b.ox) * LO_QXZ, lb.max.y * 10, (lb.max.z - b.oz) * LO_QXZ)
      );
      blk.localSphere = blk.localBox.getBoundingSphere(new THREE.Sphere());
      blocks.push(blk);
    }
    // set 0：远景全集·近处（投射阴影）；set 2：远景全集·较远（同一套索引，不投射阴影）；set 1：超远景子集
    const blockMesh = (blk, set, k) => {
      const pool = blk.pool[set];
      if (pool[k]) return pool[k];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', blk.pos);
      g.setAttribute('aData', blk.dat);
      g.setIndex(blk.idx[set === 2 ? 0 : set]);
      if (!g.index) return null;
      g.boundingBox = blk.localBox;
      g.boundingSphere = blk.localSphere;
      const m = new THREE.Mesh(g, mats.lo);
      m.position.set(blk.ox, 0, blk.oz);
      m.scale.set(1 / LO_QXZ, 0.1, 1 / LO_QXZ);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.frustumCulled = false; // 小块级剔除由 updateRuns 负责
      m.castShadow = set === 0;
      m.receiveShadow = true;
      m.visible = false;
      m.name = `建筑${set === 1 ? '超远景' : set === 3 ? '超远景精简' : set === 2 ? '远景无影' : '远景'} ${blk.ox},${blk.oz} #${k}`;
      loGroup.add(m);
      pool[k] = m;
      return m;
    };
    for (const blk of blocks) blockMesh(blk, 0, 0).visible = true; // 预热：保证 compileAsync 编译到远景材质
    let farD = FAR_D[ctx.quality.level ?? 2] || 4000;
    let far2D = FAR2_D[ctx.quality.level ?? 2] || 8000;
    let shadowDCap = SHADOW_D[ctx.quality.level ?? 2] || 2000;

    // —— 近景小块 ——
    const hiGroup = new THREE.Group();
    hiGroup.name = '建筑近景';
    root.add(hiGroup);
    const hiCache = new Map(); // key → {state, mesh, props, used}
    let hiShown = new Set();
    let hiRect = null; // [x0, z0, x1, z1]（小块坐标）
    let inflight = 0;
    let maxInflight = 2; // 近景小块最大并发请求数（慢帧时放宽）
    let hiPending = 0; // 目标近景小块中尚未就绪的个数（自动截图/性能测试据此等待）
    let layerOn = true;
    let frame = 0;
    const makeHiMesh = (m) => {
      const ib = new THREE.InterleavedBuffer(m.vbuf, HI_STRIDE);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
      g.setAttribute('aData', new THREE.InterleavedBufferAttribute(ib, 4, 3));
      g.setAttribute('aMeta', new THREE.InterleavedBufferAttribute(ib, 1, 7));
      g.setIndex(new THREE.BufferAttribute(m.ibuf, 1));
      const b = m.bounds;
      g.boundingBox = new THREE.Box3(
        new THREE.Vector3((b[0] - m.ox) * 10, b[1] * 10, (b[2] - m.oz) * 10),
        new THREE.Vector3((b[3] - m.ox) * 10, b[4] * 10, (b[5] - m.oz) * 10)
      );
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(g, mats.hi);
      mesh.position.set(m.ox, 0, m.oz);
      mesh.scale.setScalar(0.1);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.name = '建筑近景 ' + m.key;
      return mesh;
    };
    // 预热近景材质（一个退化三角形，首帧后移除）
    const warm = makeHiMesh({ vbuf: new Uint16Array(HI_STRIDE * 3), ibuf: new Uint32Array([0, 1, 2]), bounds: [0, 0, 0, 1, 1, 1], ox: 0, oz: 0, key: 'warm' });
    warm.visible = true;
    warm.frustumCulled = false;
    hiGroup.add(warm);
    const warmN = makeHiMesh({ vbuf: new Uint16Array(HI_STRIDE * 3), ibuf: new Uint32Array([0, 1, 2]), bounds: [0, 0, 0, 1, 1, 1], ox: 0, oz: 0, key: 'warmN' });
    warmN.material = mats.near;
    warmN.visible = true;
    warmN.frustumCulled = false;
    warmN.castShadow = false;
    hiGroup.add(warmN);

    // —— 屋顶构件（实例化） ——
    const propGroup = new THREE.Group();
    propGroup.name = '屋顶构件';
    root.add(propGroup);
    const propGeos = propGeometries();
    const propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.08, envMapIntensity: 0.5 });
    propMat.name = '屋顶构件';
    const NPROP = propGeos.length;
    const propMeshes = new Array(NPROP).fill(null);
    const propCap = new Array(NPROP).fill(0);
    const ensureProp = (t, n) => {
      if (propMeshes[t] && propCap[t] >= n) return propMeshes[t];
      let cap = 256;
      while (cap < n) cap *= 2;
      if (propMeshes[t]) {
        propGroup.remove(propMeshes[t]);
        propMeshes[t].dispose();
      }
      const m = new THREE.InstancedMesh(propGeos[t], propMat, cap);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = PROP_SHADOW[t]; // 小构件不投射阴影（省一半三角形）
      m.receiveShadow = true;
      m.name = PROP_NAMES[t];
      propGroup.add(m);
      propMeshes[t] = m;
      propCap[t] = cap;
      return m;
    };
    for (let t = 0; t < NPROP; t++) ensureProp(t, 1);
    const _m4 = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color();
    const _up = new THREE.Vector3(0, 1, 0);
    /** 相机附近（PROP_SMALL_R 内）的近景小块：小构件只在这些小块里画 */
    let smallKey = '';
    const smallSet = () => {
      const cam = ctx.camera.position;
      const r = [];
      for (const k of hiShown) {
        const c = chunkDir.get(k);
        if (!c) continue;
        const dx = Math.max(c.cx * CHUNK - cam.x, 0, cam.x - (c.cx + 1) * CHUNK), dz = Math.max(c.cz * CHUNK - cam.z, 0, cam.z - (c.cz + 1) * CHUNK);
        if (Math.hypot(dx, dz) < PROP_SMALL_R) r.push(k);
      }
      return r.sort().join(';');
    };
    const rebuildProps = () => {
      smallKey = smallSet();
      const near = new Set(smallKey ? smallKey.split(';') : []);
      const cnt = new Array(NPROP).fill(0);
      for (const k of hiShown) {
        const e = hiCache.get(k);
        if (!e || !e.props) continue;
        const pr = e.props, nk = near.has(k);
        for (let o = 0; o < pr.length; o += 9) if (nk || !PROP_SMALL[pr[o]]) cnt[pr[o]]++;
      }
      const ms = cnt.map((n, t) => ensureProp(t, n));
      const w = new Array(NPROP).fill(0);
      for (const k of hiShown) {
        const e = hiCache.get(k);
        if (!e || !e.props) continue;
        const pr = e.props, nk = near.has(k);
        for (let o = 0; o < pr.length; o += 9) {
          const t = pr[o];
          if (!nk && PROP_SMALL[t]) continue;
          _p.set(pr[o + 1], pr[o + 2], pr[o + 3]);
          _q.setFromAxisAngle(_up, pr[o + 7]);
          _s.set(pr[o + 4], pr[o + 5], pr[o + 6]);
          _m4.compose(_p, _q, _s);
          ms[t].setMatrixAt(w[t], _m4);
          _c.setHex(pr[o + 8] >>> 0);
          ms[t].setColorAt(w[t], _c);
          w[t]++;
        }
      }
      for (let t = 0; t < NPROP; t++) {
        ms[t].count = w[t];
        ms[t].instanceMatrix.needsUpdate = true;
        if (ms[t].instanceColor) ms[t].instanceColor.needsUpdate = true;
      }
    };

    // —— 近景细部层（外挂空调、防盗窗、晾衣、空调格栅、楼板挑檐、勒脚凸台）：相机离地 < NEAR_AGL 时，
    //    NEAR_R 内的 400 m 小格按需在 Worker 里生成（bld-gen.js nearChunk），与近景外墙同一材质、不投射阴影 ——
    const nearGroup = new THREE.Group();
    nearGroup.name = '建筑近景细部';
    root.add(nearGroup);
    const nearCache = new Map(); // key → {state, mesh, used, gen}
    let nearInflight = 0, nearPending = 0;
    const requestNear = (key) => {
      const g = hiGen;
      nearCache.set(key, { state: 'loading', used: frame, gen: g });
      nearInflight++;
      gen.call({ type: 'near', key, detail: detailLvl }).then((m) => {
        nearInflight--;
        const e = nearCache.get(key);
        if (!e) return;
        if (e.gen !== g) {
          nearCache.delete(key);
          return;
        }
        if (!m || m.type !== 'near' || m.empty || !m.ibuf || !m.ibuf.length) {
          if (!m || m.type !== 'near') console.warn('[buildings] 近景细部生成失败', key, m && m.message);
          e.state = 'empty';
          return;
        }
        e.mesh = makeHiMesh(m);
        e.mesh.material = mats.near;
        e.mesh.castShadow = false;
        e.mesh.name = '建筑近景细部 ' + key;
        e.state = 'ready';
        nearGroup.add(e.mesh);
      });
    };
    const disposeNear = (key) => {
      const e = nearCache.get(key);
      if (e && e.mesh) {
        nearGroup.remove(e.mesh);
        e.mesh.geometry.dispose();
      }
      nearCache.delete(key);
    };
    const manageNear = () => {
      const cam = ctx.camera.position;
      const agl = cam.y - ctx.terrain.heightAt(cam.x, cam.z);
      const want = [];
      // 近景外墙接管了相机所在小块才画细部（细部贴在近景外墙上；远景外墙轮廓简化过，对不上）
      if (layerOn && hiRect && detailLvl >= 1 && agl < NEAR_AGL) {
        const R = NEAR_R;
        for (let z = Math.floor((cam.z - R) / NEAR_CELL); z <= Math.floor((cam.z + R) / NEAR_CELL); z++)
          for (let x = Math.floor((cam.x - R) / NEAR_CELL); x <= Math.floor((cam.x + R) / NEAR_CELL); x++) {
            const dx = Math.max(x * NEAR_CELL - cam.x, 0, cam.x - (x + 1) * NEAR_CELL), dz = Math.max(z * NEAR_CELL - cam.z, 0, cam.z - (z + 1) * NEAR_CELL);
            if (Math.hypot(dx, dz) > R) continue;
            const ccx = Math.floor((x * NEAR_CELL + NEAR_CELL / 2) / CHUNK), ccz = Math.floor((z * NEAR_CELL + NEAR_CELL / 2) / CHUNK);
            if (ccx < hiRect[0] || ccx > hiRect[2] || ccz < hiRect[1] || ccz > hiRect[3]) continue;
            want.push(x + ',' + z);
          }
      }
      const miss = want.filter((k) => !nearCache.has(k));
      if (miss.length && nearInflight < 2) {
        const d = (k) => {
          const [x, z] = k.split(',').map(Number);
          return Math.hypot((x + 0.5) * NEAR_CELL - cam.x, (z + 0.5) * NEAR_CELL - cam.z);
        };
        miss.sort((a, b) => d(a) - d(b));
        for (const k of miss) {
          if (nearInflight >= 2) break;
          requestNear(k);
        }
      }
      const ws = new Set(want);
      nearPending = 0;
      for (const k of want) {
        const e = nearCache.get(k);
        if (!e || e.state === 'loading') nearPending++;
        if (e) e.used = frame;
      }
      for (const [k, e] of nearCache) if (e.mesh) e.mesh.visible = ws.has(k);
      if (nearCache.size > NEAR_CACHE) {
        const cand = [...nearCache.entries()].filter(([k, e]) => e.state !== 'loading' && !ws.has(k)).sort((a, b) => a[1].used - b[1].used);
        for (let i = 0; i < cand.length && nearCache.size > NEAR_CACHE; i++) disposeNear(cand[i][0]);
      }
    };

    const requestHi = (key) => {
      const g = hiGen;
      hiCache.set(key, { state: 'loading', used: frame, gen: g });
      inflight++;
      gen.call({ type: 'hi', key, detail: detailLvl }).then((m) => {
        inflight--;
        const e = hiCache.get(key);
        if (!e) return;
        if (e.gen !== g) {
          // 画质细节档位已变：丢弃，下一轮按新档位重新生成
          hiCache.delete(key);
          return;
        }
        if (!m || m.type !== 'hi' || m.empty || !m.ibuf || !m.ibuf.length) {
          if (!m || m.type !== 'hi') {
            console.warn('[buildings] 近景小块生成失败', key, m && m.message);
            e.err = true;
          }
          e.state = 'empty';
          return;
        }
        e.mesh = makeHiMesh(m);
        e.props = m.props;
        e.state = 'ready';
        hiGroup.add(e.mesh);
      });
    };
    const disposeHi = (key) => {
      const e = hiCache.get(key);
      if (e && e.mesh) {
        hiGroup.remove(e.mesh);
        e.mesh.geometry.dispose();
      }
      hiCache.delete(key);
    };
    const sameSet = (a, b) => {
      if (a.size !== b.size) return false;
      for (const k of a) if (!b.has(k)) return false;
      return true;
    };
    const manageHi = () => {
      const cam = ctx.camera.position;
      const agl = cam.y - ctx.terrain.heightAt(cam.x, cam.z);
      const keys = [];
      let rect = null;
      if (layerOn && agl < HI_AGL) {
        const R = hiRadius;
        rect = [Math.floor((cam.x - R) / CHUNK), Math.floor((cam.z - R) / CHUNK), Math.floor((cam.x + R) / CHUNK), Math.floor((cam.z + R) / CHUNK)];
        for (let cz = rect[1]; cz <= rect[3]; cz++)
          for (let cx = rect[0]; cx <= rect[2]; cx++) {
            const k = cx + ',' + cz;
            if (chunkDir.has(k)) keys.push(k);
          }
      }
      // 请求缺失的小块（由近及远，最多 maxInflight 个并发）
      const miss = keys.filter((k) => !hiCache.has(k));
      if (miss.length && inflight < maxInflight) {
        const d = (k) => {
          const c = chunkDir.get(k);
          return Math.hypot((c.cx + 0.5) * CHUNK - cam.x, (c.cz + 0.5) * CHUNK - cam.z);
        };
        miss.sort((a, b) => d(a) - d(b));
        for (const k of miss) {
          if (inflight >= maxInflight) break;
          requestHi(k);
        }
      }
      for (const k of keys) hiCache.get(k) && (hiCache.get(k).used = frame);
      // 目标小块全部就绪才切换（避免远/近景交接时出现空洞）
      const ready = keys.every((k) => hiCache.has(k) && hiCache.get(k).state !== 'loading');
      hiPending = ready ? 0 : keys.filter((k) => !hiCache.has(k) || hiCache.get(k).state === 'loading').length;
      // 任一小块生成失败：整片退回远景（不留空洞）
      if (ready && keys.some((k) => hiCache.get(k).err)) {
        keys.length = 0;
        rect = null;
      }
      if (ready) {
        const next = new Set(keys.filter((k) => hiCache.get(k).state === 'ready'));
        const rectChanged = String(rect) !== String(hiRect);
        if (!sameSet(next, hiShown) || rectChanged) {
          for (const k of hiShown) if (!next.has(k) && hiCache.get(k)?.mesh) hiCache.get(k).mesh.visible = false;
          for (const k of next) hiCache.get(k).mesh.visible = true;
          const propsChanged = !sameSet(next, hiShown);
          hiShown = next;
          hiRect = keys.length ? rect : null;
          if (hiRect) U.uHiRect.value.set(hiRect[0], hiRect[1], hiRect[2], hiRect[3]);
          else U.uHiRect.value.set(1e6, 1e6, -1e6, -1e6);
          if (propsChanged) rebuildProps();
        }
        // 相机跨过小块边界：附近小块集合变了，重排小构件
        if (frame % 9 === 0 && hiShown.size && smallSet() !== smallKey) rebuildProps();
      }
      // 淘汰远处缓存
      if (hiCache.size > HI_CACHE) {
        const cand = [...hiCache.entries()].filter(([k, e]) => e.state !== 'loading' && !hiShown.has(k)).sort((a, b) => a[1].used - b[1].used);
        for (let i = 0; i < cand.length && hiCache.size > HI_CACHE; i++) disposeHi(cand[i][0]);
      }
    };

    // —— 远景：每帧按 1 km 小块剔除（视锥 + 距离），按距离分到“远景全集 / 超远景子集”两套索引，
    //    各自把可见小块（Morton 序）合并成 ≤ MAX_RUNS 段 drawRange ——
    const frustum = new THREE.Frustum();
    const pm = new THREE.Matrix4();
    const mkRuns = () => {
      const r = [];
      for (let i = 0; i < 64; i++) r.push({ s: 0, e: 0, gap: 0 });
      return { runs: r, n: 0, cur: null, gap: 0 };
    };
    const RS = [mkRuns(), mkRuns(), mkRuns(), mkRuns()];
    const distXZ = (box, x, z) => {
      const dx = Math.max(box.min.x - x, 0, x - box.max.x), dz = Math.max(box.min.z - z, 0, z - box.max.z);
      return Math.hypot(dx, dz);
    };
    const runPush = (R, c, set) => {
      const st = c.r[set], cnt = c.c[set];
      if (!cnt) return;
      if (R.cur && R.gap <= GAP_MERGE) R.cur.e = st + cnt;
      else if (R.n < R.runs.length) {
        R.cur = R.runs[R.n++];
        R.cur.s = st;
        R.cur.e = st + cnt;
        R.cur.gap = R.gap;
      }
      R.gap = 0;
    };
    const runGap = (R, c, set) => {
      if (R.cur) R.gap += c.c[set];
    };
    const runFinish = (R, blk, set) => {
      const runs = R.runs;
      while (R.n > MAX_RUNS) {
        let bi = 1;
        for (let k = 2; k < R.n; k++) if (runs[k].gap < runs[bi].gap) bi = k;
        runs[bi - 1].e = runs[bi].e;
        const tmp = runs[bi];
        for (let k = bi; k < R.n - 1; k++) runs[k] = runs[k + 1];
        runs[R.n - 1] = tmp;
        R.n--;
      }
      for (let k = 0; k < R.n; k++) {
        const m = blockMesh(blk, set, k);
        if (!m) continue;
        m.geometry.drawRange.start = runs[k].s;
        m.geometry.drawRange.count = runs[k].e - runs[k].s;
        m.visible = true;
      }
      const pool = blk.pool[set];
      for (let k = R.n; k < pool.length; k++) if (pool[k]) pool[k].visible = false;
    };
    const updateRuns = () => {
      const cam = ctx.camera;
      pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pm, cam.coordinateSystem, cam.reversedDepth);
      const cx = cam.position.x, cz = cam.position.z;
      const dd = U.uDrawDist.value;
      const hr = hiRect;
      // 投影距离随阴影贴图实际覆盖范围（离地高、太阳高度角）收缩
      const shadowD = shadowReach(ctx, shadowDCap, 120);
      for (const blk of blocks) {
        for (const R of RS) (R.n = 0), (R.cur = null), (R.gap = 0);
        const bd = distXZ(blk.box, cx, cz);
        if (bd <= dd && (bd < NEAR_KEEP || frustum.intersectsBox(blk.box))) {
          for (const c of blk.chunks) {
            const inHi = hr && c.cx >= hr[0] && c.cx <= hr[2] && c.cz >= hr[1] && c.cz <= hr[3];
            let vis = false;
            const d = distXZ(c.box, cx, cz);
            if (!inHi) vis = d <= dd && (d < NEAR_KEEP || frustum.intersectsBox(c.box));
            // 四组：0 近处投影 / 2 较远不投影（同一索引缓冲）/ 1 超远景子集 / 3 超远景精简子集
            const want = !vis ? -1 : d < farD ? (d < shadowD ? 0 : 2) : d < far2D ? 1 : 3;
            for (let s = 0; s < 4; s++) if (s === want) runPush(RS[s], c, s); else runGap(RS[s], c, s);
          }
        }
        for (let s = 0; s < 4; s++) runFinish(RS[s], blk, s);
      }
    };

    // —— 小区大门（有照片依据的门楼/门架） ——
    let gates = null;
    if (estDoc) {
      try {
        gates = buildEstateGates(ctx, estDoc);
        root.add(gates.group);
      } catch (e) {
        console.warn('[buildings] 小区大门生成失败', e);
        gates = null;
      }
    }

    // —— 航空障碍灯 ——
    let obstacle = null;
    if (init.lights && init.lights.length) {
      obstacle = makeObstacleLights(ctx, init.lights);
      root.add(obstacle);
    }

    // —— nearestFacade：外墙最近点查询（招牌模块用） ——
    const FC = 64;
    let fgrid = null;
    const stamp = new Uint32Array(N);
    let qid = 0;
    const buildFacadeGrid = () => {
      const g = new Map();
      for (let i = 0; i < N; i++) {
        if (pre.skip[i]) continue;
        const x0 = Math.floor(pre.bb[i * 4] / FC), z0 = Math.floor(pre.bb[i * 4 + 1] / FC);
        const x1 = Math.floor(pre.bb[i * 4 + 2] / FC), z1 = Math.floor(pre.bb[i * 4 + 3] / FC);
        for (let cz = z0; cz <= z1; cz++)
          for (let cx = x0; cx <= x1; cx++) {
            const k = cx * 100003 + cz;
            let l = g.get(k);
            if (!l) g.set(k, (l = []));
            l.push(i);
          }
      }
      return g;
    };
    /**
     * 最近的建筑外墙点。
     * @returns {null|{x,z,nx,nz,height,index,dist,ground,bottom,top,edge,edgeLen,tx,tz,style,styleName,floorH,groundFloorH,street,name}}
     *   x,z 外墙上的最近点；nx,nz 外法线（单位向量，指向街道一侧）；height 建筑高度（米，离地）；
     *   ground 质心处地面海拔；top 屋顶海拔；tx,tz 沿墙切向；floorH/groundFloorH 标准层/首层层高；street 是否临街
     */
    const nearestFacade = (x, z, maxDist = 40) => {
      if (!fgrid) fgrid = buildFacadeGrid();
      if (++qid >= 0xffffffff) (qid = 1), stamp.fill(0);
      let best = -1, bd = maxDist, bpx = 0, bpz = 0, bdx = 0, bdz = 0, bL = 0, be = 0;
      const cx0 = Math.floor((x - maxDist) / FC), cx1 = Math.floor((x + maxDist) / FC);
      const cz0 = Math.floor((z - maxDist) / FC), cz1 = Math.floor((z + maxDist) / FC);
      const offs = P.offs;
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const l = fgrid.get(cx * 100003 + cz);
          if (!l) continue;
          for (const i of l) {
            if (stamp[i] === qid) continue;
            stamp[i] = qid;
            const q = i * 4;
            if (x < pre.bb[q] - bd || x > pre.bb[q + 2] + bd || z < pre.bb[q + 1] - bd || z > pre.bb[q + 3] + bd) continue;
            const s = P.vertStart[i], n = P.vertCount[i], ax = P.anchorX[i], az = P.anchorZ[i];
            for (let j = 0; j < n; j++) {
              const k = j + 1 < n ? j + 1 : 0;
              const x0 = ax + offs[(s + j) * 2] * 0.1, z0 = az + offs[(s + j) * 2 + 1] * 0.1;
              const x1 = ax + offs[(s + k) * 2] * 0.1, z1 = az + offs[(s + k) * 2 + 1] * 0.1;
              const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz;
              if (L2 < 1e-4) continue;
              let t = ((x - x0) * dx + (z - z0) * dz) / L2;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const px = x0 + dx * t, pz = z0 + dz * t;
              const d = Math.hypot(x - px, z - pz);
              if (d < bd) {
                bd = d;
                best = i;
                bpx = px;
                bpz = pz;
                bdx = dx;
                bdz = dz;
                bL = Math.sqrt(L2);
                be = j;
              }
            }
          }
        }
      if (best < 0) return null;
      // 外环方向（shoelace > 0 为逆时针，外法线 = (dz, -dx)）
      const s = P.vertStart[best], n = P.vertCount[best];
      let a = 0;
      for (let j = 0; j < n; j++) {
        const k = j + 1 < n ? j + 1 : 0;
        a += offs[(s + j) * 2] * offs[(s + k) * 2 + 1] - offs[(s + k) * 2] * offs[(s + j) * 2 + 1];
      }
      const sg = a >= 0 ? 1 : -1;
      const nx = (sg * bdz) / bL, nz = (-sg * bdx) / bL;
      const t = best * 16;
      const H = texArr[t + 1] || P.heightDm[best] * 0.1;
      const st = Math.round(texArr[t + 3]);
      return {
        x: bpx, z: bpz, nx, nz,
        height: H,
        index: best,
        dist: bd,
        ground: pre.ga[best],
        bottom: pre.base[best],
        top: pre.ga[best] + H,
        edge: be,
        edgeLen: bL,
        tx: bdx / bL, tz: bdz / bL,
        style: st,
        styleName: STYLE_NAMES[st] || '',
        floorH: texArr[t + 2] || 3,
        groundFloorH: texArr[t + 8] || 4,
        street: ((texArr[t + 11] | 0) & 1) === 1,
        name: (ctx.data.buildingNames && ctx.data.buildingNames[String(best)]) || '',
      };
    };

    /**
     * 视线遮挡：线段 a→b 是否被某栋建筑（按外包盒 + 底高/顶高近似）挡住。标注模块用来隐藏楼后面的地名。
     * 只检查线段 2D 投影经过的外墙网格格子（64 m），两端各留 margin 米不算（标注锚点本身贴着楼时不误判）。
     */
    const occluded = (ax, ay, az, bx, by, bz, margin = 6, retIdx = false) => {
      if (!fgrid) fgrid = buildFacadeGrid();
      if (++qid >= 0xffffffff) (qid = 1), stamp.fill(0);
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 1e-3) return false;
      const t0 = Math.min(0.49, margin / L), t1 = 1 - t0;
      const steps = Math.ceil(L / (FC * 0.5)) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = Math.floor((ax + dx * t) / FC), cz = Math.floor((az + dz * t) / FC);
        const l = fgrid.get(cx * 100003 + cz);
        if (!l) continue;
        for (const i of l) {
          if (stamp[i] === qid) continue;
          stamp[i] = qid;
          const q = i * 4;
          const x0 = pre.bb[q], z0 = pre.bb[q + 1], x1 = pre.bb[q + 2], z1 = pre.bb[q + 3];
          const H = texArr[i * 16 + 1] || P.heightDm[i] * 0.1;
          const y0 = pre.base[i], y1 = pre.ga[i] + H;
          // 线段与外包盒求交（slab 法）
          let lo = t0, hi = t1;
          const slab = (o, d, mn, mx) => {
            if (Math.abs(d) < 1e-9) return o >= mn && o <= mx;
            let ta = (mn - o) / d, tb = (mx - o) / d;
            if (ta > tb) [ta, tb] = [tb, ta];
            if (ta > lo) lo = ta;
            if (tb < hi) hi = tb;
            return lo <= hi;
          };
          if (!(slab(ax, dx, x0, x1) && slab(az, dz, z0, z1) && slab(ay, dy, y0, y1))) continue;
          // 外包盒命中后再按真实轮廓逐点检查（L 形/大院合并轮廓的外包盒常常盖住街道）
          const s0 = P.vertStart[i], n = P.vertCount[i], oxA = P.anchorX[i], ozA = P.anchorZ[i];
          const offs = P.offs;
          const segL = (hi - lo) * Math.hypot(dx, dy, dz);
          const k = Math.max(2, Math.min(40, Math.ceil(segL / 3)));
          for (let m = 0; m <= k; m++) {
            const tt = lo + ((hi - lo) * m) / k;
            const px = ax + dx * tt, py = ay + dy * tt, pz = az + dz * tt;
            if (py < y0 || py > y1) continue;
            let inside = false;
            for (let a = 0, b = n - 1; a < n; b = a++) {
              const xa = oxA + offs[(s0 + a) * 2] * 0.1, za = ozA + offs[(s0 + a) * 2 + 1] * 0.1;
              const xb = oxA + offs[(s0 + b) * 2] * 0.1, zb = ozA + offs[(s0 + b) * 2 + 1] * 0.1;
              if (za > pz !== zb > pz && px < ((xb - xa) * (pz - za)) / (zb - za) + xa) inside = !inside;
            }
            if (inside) return retIdx ? i : true;
          }
        }
      }
      return retIdx ? -1 : false;
    };

    const stat = init.stat;
    console.log(
      `[buildings] v${init.version} ${N} 栋（排除 ${pre.nEx}，skyline 让位 ${pre.nSky}）；远景 ${blocks.length} 块 ${(stat.loTris / 1e6).toFixed(2)}M 三角形；` +
        `Worker ${stat.ms} ms；主线程预处理 ${tPre.toFixed(0)} ms + 建网格 ${(performance.now() - t1).toFixed(0)} ms；风格 ` +
        STYLE_NAMES.map((s, i) => `${s}${stat.styles[i]}`).join(' ') +
        (estDoc ? `；小区风貌 ${stat.estNames} 个小区 ${stat.estates} 栋（坡屋面 ${stat.estRoofs}），大门 ${gates ? gates.count : 0} 座` : '') +
        `；通用平改坡 ${stat.genRoofs || 0} 栋；立面细节档位 ${detailLvl}`
    );
    updateRuns();

    // —— 分类高亮（专题图）：首次开启时在主线程分类（约 0.5 s），写入 R8 纹理；关闭只改 uniform，不重建几何 ——
    let clsResult = null;
    const ensureClasses = () => {
      if (clsResult) return clsResult;
      const t = performance.now();
      clsResult = classifyBuildings(P, ctx.data.buildingNames, ctx.data.landuse, ctx.data.pois);
      const td = classTextureData(clsResult.cls);
      const old = U.uCls.value;
      U.uCls.value = createClassTexture(td.data, td.width, td.height);
      old.dispose();
      const st = clsResult.stats;
      console.log(
        `[buildings] 分类 ${(performance.now() - t).toFixed(0)} ms：已判定 ${((st.classified / st.total) * 100).toFixed(1)}%；` +
          BLD_CLASSES.map((c, i) => `${c.name}${st.byClass[i]}`).join(' ')
      );
      return clsResult;
    };
    const _col = new THREE.Color();
    /** on：开关；selected：选中类别编号集合（null = 全部） */
    const setClassHighlight = (on, selected = null) => {
      if (on) ensureClasses();
      U.uClsOn.value = on ? 1 : 0;
      BLD_CLASSES.forEach((c, i) => {
        _col.set(c.color); // 转为线性工作色彩空间
        U.uClsCol.value[i].set(_col.r, _col.g, _col.b, !selected || selected.has(i) ? 1 : 0);
      });
    };

    const inst = {
      setClassHighlight,
      classStats: () => ensureClasses().stats,
      classOf: (i) => ensureClasses().cls[i],
      nearestFacade,
      occluded,
      api: { nearestFacade, occluded },
      // 诊断用（tools/check_overlap.mjs）：最终是否渲染（0=渲染）、底部高程、锚点地面高程
      diag: { skip: pre.skip, base: pre.base, ga: pre.ga },
      stats: () => ({
        blocks: blocks.length,
        loVisible: blocks.reduce((s, b) => s + b.pool[0].filter((m) => m && m.visible).length + b.pool[2].filter((m) => m && m.visible).length, 0),
        loShadow: blocks.reduce((s, b) => s + b.pool[0].filter((m) => m && m.visible).length, 0),
        farVisible: blocks.reduce((s, b) => s + b.pool[1].filter((m) => m && m.visible).length + b.pool[3].filter((m) => m && m.visible).length, 0),
        hiShown: hiShown.size,
        hiCached: hiCache.size,
        hiLoading: inflight + nearInflight,
        hiPending: hiPending + nearPending,
        nearShown: [...nearCache.values()].filter((e) => e.mesh && e.mesh.visible).length,
        detail: detailLvl,
        props: propMeshes.map((m) => m.count),
      }),
      update(dt, t) {
        frame++;
        if (frame === 3 && warm.parent) {
          hiGroup.remove(warm);
          warm.geometry.dispose();
          hiGroup.remove(warmN);
          warmN.geometry.dispose();
        }
        if (!root.visible) return;
        // 亮灯率：住宅 / 办公 / 商业 + 夜间开灯系数
        const h = ctx.sky ? ctx.sky.hours : 12;
        const nf = ctx.uniforms.uNight.value;
        U.uLit.value.set(curve(LIT_RES, h), curve(LIT_OFF, h), curve(LIT_COM, h), smooth(0.06, 0.5, nf));
        // 帧很慢时（弱机 / 软件渲染）每帧检查并放宽并发，近景小块更快补齐
        const slow = dt > 0.066; // dt 在主循环里被钳到 ≤ 0.1 s：低于约 15 fps 即视为慢帧
        maxInflight = slow ? 6 : 2;
        if (frame % 3 === 0 || frame < 3 || slow) manageHi();
        if (frame % 3 === 1 || frame < 3 || slow) manageNear();
        updateRuns();
        if (gates && frame % 15 === 0) gates.update(ctx.camera.position);
      },
      setLayer(name, on) {
        if (name !== 'buildings') return;
        root.visible = on;
        layerOn = on;
      },
      setQuality(q) {
        U.uDrawDist.value = q.buildingDistance || 16000;
        hiRadius = HI_RADIUS[q.level ?? 2] || 1200;
        farD = FAR_D[q.level ?? 2] || 4000;
        far2D = FAR2_D[q.level ?? 2] || 8000;
        shadowDCap = SHADOW_D[q.level ?? 2] || 2000;
        const d = DETAIL[q.level ?? 2] ?? 2;
        if (d !== detailLvl) {
          // 细节档位变化：近景小块全部按新档位重建（重建期间由远景补位，不留空洞）
          detailLvl = d;
          U.uBDetail.value = d;
          hiGen++;
          for (const [k, e] of [...hiCache.entries()]) {
            if (e.state === 'loading') e.gen = -1;
            else disposeHi(k);
          }
          for (const [k, e] of [...nearCache.entries()]) {
            if (e.state === 'loading') e.gen = -1;
            else disposeNear(k);
          }
          hiShown = new Set();
          hiRect = null;
          U.uHiRect.value.set(1e6, 1e6, -1e6, -1e6);
          rebuildProps();
        }
      },
      dispose() {
        gen.dispose();
        for (const k of [...hiCache.keys()]) disposeHi(k);
        for (const k of [...nearCache.keys()]) disposeNear(k);
        for (const blk of blocks) for (const pool of blk.pool) for (const m of pool) m && m.geometry.dispose();
        for (const m of propMeshes) m && m.dispose();
        propGeos.forEach((g) => g.dispose());
        dataTex.dispose();
        U.uBld2.value.dispose();
        U.uEst.value.dispose();
        if (gates) gates.dispose();
        mats.lo.dispose();
        mats.hi.dispose();
        mats.near.dispose();
        ctx.scene.remove(root);
      },
    };
    return inst;
  },
};
