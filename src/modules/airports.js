// 西安咸阳国际机场（XIY/ZLXY）与西安其它机场。
// 资料（2026-09 核对）：
//  · 跑道：OSM + Esri 影像核对，四条平行跑道（真方位约 48.7°）：西飞行区 05L/23R 3800×45、05R/23L 3000×45；
//    东飞行区（三期扩建）06L/24R 3800×60（4F）、06R/24L 3000×45。原北跑道已改为平行滑行道。
//    道面：影像核对跑道、滑行道、机坪均为浅灰色水泥混凝土（5 m 分仓切缝），跑道接地带有黑色橡胶痕，大跑道道肩为沥青。
//  · T5 航站楼 2025-02-20 投运，“主楼 + 六指廊”，建筑面积 70.55 万㎡，陆侧屋面有红色“西安”书法大字；
//    T1（停用）/T2/T3 位于西航站区，T2/T3 主楼为拱形肋屋面（T2 深灰、T3 白色），T3 东侧高架落客平台，T2 东南侧地面落客。
//    OSM 只给 T5 西北指廊画了机位线（parking_position），南/东南/东指廊只有登机口节点（aeroway=gate，位于廊桥旋转台处），
//    这些登机口按影像规律补机位：机头朝指廊、旋转台在飞机左前方、固定廊垂直于立面。
//  · 夜景：玻璃幕墙透出偏冷白光（按 1.5 m 竖梃分格、6 m 分区亮度不同），屋檐与拱顶山墙有轮廓灯，陆侧雨棚下筒灯与落客平台照明最亮；
//    助航灯光按 ICAO 附件 14：最醒目的是白色跑道边灯与进近灯；滑行道只设绿色中线灯（弯道补蓝色边灯），机坪边缘蓝灯。
//  · 塔台：OSM man_made=tower（tower:type=aircraft_control），高脚杯形，灰色塔身 + 蓝色玻璃喇叭口 + 管制室。
//  · 阎良机场：中国飞行试验研究院（试飞院），双跑道 06L/24R、06R/24L 约 3500 m，北端舰载机滑跃起飞试验台。
//  · 西关机场：1924 年启用、1991 年随咸阳机场投运关闭（仅标注旧址）。
//  参考照片见 research/refs/airports/credits.tsv（Wikimedia Commons，CC BY-SA/CC0）。
import * as THREE from 'three';
import { Batcher, toShape, pointInPoly, polyCentroid } from '../core/util.js';
import { STANDS, LEADIN, HOLDS, WINDSOCKS, HANGARS, TOWER } from '../arch/airport-data.js';
import { TYPES, XIY_MIX, buildAircraftGeometry, aircraftMaterial, liveryUniform, aircraftLightOffsets } from '../arch/airport-aircraft.js';
import {
  runwayInfo, TriSink, markingAtlas, markRect, markLine, offsetLine, runwaySurface, runwayMarkings,
  LightList, LC, lightPoints, runwayLights, WHITE, YELLOW, RED,
} from '../arch/airport-ground.js';

const XIY_C = [-16800, -20200];
const YL_C = [27500, -42600];
const TERM_H = { '1号航站楼': 14, '2号航站楼': 20, '3号航站楼': 22, '5号航站楼': 24, '国际指廊': 18, '南一指廊': 18, '南二指廊': 18, '南三指廊': 18, 'T5综合交通中心': 22 };
const TERM_DISUSED = { '1号航站楼': 1 }; // T1 已停用：实墙 + 条窗，夜里不亮
// 主楼大跨屋盖（中心、长轴方向、长、宽、檐口高、拱高、屋面色）——按影像量取。
// 陆侧在 +b 方向（b = (a.z, -a.x)）；walls=0 表示墙体由 OSM 轮廓生成，这里只加屋盖；deck=高架落客平台；curb=地面落客雨棚
const HALLS = [
  { n: 'T5', c: [-15119, -21512], a: [0.7, 0.714], len: 540, wid: 235, eave: 30, rise: 9, roof: 'grey', sky: 1, over: 14, deck: 1, sign: 't5' },
  { n: 'T3', c: [-17148, -19637], a: [0.646, 0.761], len: 350, wid: 112, eave: 24, rise: 12, roof: 'white', ribs: 1, over: 8, deck: 1, sign: 'xiy' },
  { n: 'T2', c: [-17180, -20093], a: [-0.753, 0.658], len: 242, wid: 64, eave: 22, rise: 7, roof: 'grey', ribs: 1, over: 10, walls: 0, curb: 1 },
];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function pickW(r, mix) {
  const tot = mix.reduce((a, b) => a + b[1], 0);
  let x = r() * tot;
  for (const [v, w] of mix) if ((x -= w) <= 0) return v;
  return mix[0][0];
}
function bboxOf(p) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
  return { x0, x1, z0, z1 };
}
function runwayRect(R, extra = 0, side = 0) {
  const hw = R.w / 2 + side, e = extra;
  const P = (s, o) => [R.ax + R.ux * s + R.rx * o, R.az + R.uz * s + R.rz * o];
  return [...P(-e, -hw), ...P(R.L + e, -hw), ...P(R.L + e, hw), ...P(-e, hw)];
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** 机头尖到前轮的距离（机型本地坐标：原点在主轮，机身中点 z=-mgz，前轮 z=wb） */
const noseAhead = (T) => T.L / 2 - T.mgz - T.wb;
/** 舱门地板离地高度（与程序化机身一致：客舱地板略低于机身中线） */
const doorSill = (T) => T.yc - 0.35 * T.R;

// ---------- 程序化纹理 ----------
function canvasTex(w, h, draw, { srgb = true, repeat = [1, 1] } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}
/**
 * 航站楼玻璃幕墙。UV = (沿墙米, 离楼地面米)，纹理一格 96 m × 48 m：
 *   0~0.6 m 勒脚；0.8~4.4 m 机坪层（行李/服务用房，部分亮）；4.6~6.0 m 楼板带；6 m 以上出发/候机层大玻璃；
 *   竖梃 1.5 m、横档 3 m。夜间按 6 m 分区给不同亮度（有的区域只开值守灯），越往上越亮（看得见吊顶灯），偏冷白光。
 */
function curtainMaterial(ctx) {
  const W = 1024, H = 512, U = 96, V = 48;
  const px = (m) => (m / U) * W, py = (m) => H - (m / V) * H;
  const r = rng(11);
  const bays = [];
  for (let x = 0; x < U; x += 6) bays.push({ x, k: r() < 0.14 ? 0.18 + r() * 0.2 : 0.6 + r() * 0.4, low: r() < 0.5 ? 0.3 + r() * 0.3 : 0.03 });
  const map = canvasTex(W, H, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#6f8794'); gr.addColorStop(1, '#41545f');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = '#4b4f53'; g.fillRect(0, py(0.6), W, H - py(0.6));
    g.fillStyle = '#b8bec3'; g.fillRect(0, py(6.0), W, py(4.6) - py(6.0));
    g.fillStyle = '#c9ced2';
    for (let x = 0; x < U; x += 1.5) g.fillRect(px(x), 0, 2, py(0.6));
    for (let y = 9; y < V; y += 3) g.fillRect(0, py(y), W, 2);
    g.fillRect(0, py(2.6), W, 2);
  }, { repeat: [1 / U, 1 / V] });
  const em = canvasTex(W, H, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const c = (k) => `rgb(${(236 * k) | 0},${(243 * k) | 0},${(252 * k) | 0})`;
    for (const b of bays) {
      const gr = g.createLinearGradient(0, py(6), 0, py(V));
      gr.addColorStop(0, c(b.k * 0.62)); gr.addColorStop(10 / 42, c(b.k)); gr.addColorStop(24 / 42, c(b.k * 0.82)); gr.addColorStop(1, c(b.k * 0.7));
      g.fillStyle = gr; g.fillRect(px(b.x), 0, px(6), py(6.0));
      g.fillStyle = c(b.low); g.fillRect(px(b.x), py(4.4), px(6), py(0.8) - py(4.4));
      // 室内剪影（座椅、柜台、店铺隔断、人流）与少量暖色登机口指示牌，避免整面“灯箱”感
      for (let n = 0; n < 5; n++) {
        const w = 0.6 + r() * 3.2, h = 0.5 + r() * 1.8, x = b.x + r() * (6 - w);
        g.fillStyle = `rgba(0,0,0,${0.35 + r() * 0.35})`;
        g.fillRect(px(x), py(6.0 + h), px(w), py(6.0) - py(6.0 + h));
      }
      if (r() < 0.45) {
        const x = b.x + 0.5 + r() * 4;
        g.fillStyle = r() < 0.6 ? 'rgb(255,214,120)' : 'rgb(150,215,255)';
        g.fillRect(px(x), py(9.6), px(1.4), py(9.0) - py(9.6));
      }
      if (r() < 0.3) { // 吊顶下的一条更亮的灯槽
        g.fillStyle = c(Math.min(1, b.k * 1.15));
        g.fillRect(px(b.x), py(13.2), px(6), py(12.8) - py(13.2));
      }
    }
    g.fillStyle = '#000';
    for (let x = 0; x < U; x += 1.5) g.fillRect(px(x) - 1, 0, 3, H);
    for (let y = 9; y < V; y += 3) g.fillRect(0, py(y) - 1, W, 2);
    g.fillRect(0, py(2.6) - 1, W, 2);
  }, { repeat: [1 / U, 1 / V] });
  const m = new THREE.MeshStandardMaterial({ map, emissiveMap: em, emissive: 0xdfe9f5, emissiveIntensity: 0, metalness: 0.55, roughness: 0.14, envMapIntensity: 1.3 });
  ctx.night.register(m, { day: 0.0, night: 0.72 });
  return m;
}
/** 停用的 T1：浅色实墙 + 两条条窗（UV 同幕墙：沿墙米, 离地米），夜里不亮 */
function disusedWallMaterial() {
  const map = canvasTex(256, 256, (g, W, H) => {
    const py = (m) => H - (m / 16) * H;
    g.fillStyle = '#c9c5bc'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#3d454b';
    for (const [a, b] of [[3.6, 5.8], [8.4, 10.8]]) g.fillRect(0, py(b), W, py(a) - py(b));
    g.fillStyle = '#9ea2a3';
    for (let x = 0; x < W; x += 21) g.fillRect(x, 0, 2, H);
  }, { repeat: [1 / 12, 1 / 16] });
  return new THREE.MeshStandardMaterial({ map, roughness: 0.7, metalness: 0.1 });
}
function roofMaterial(color, seam) {
  const map = canvasTex(256, 256, (g) => {
    g.fillStyle = color; g.fillRect(0, 0, 256, 256);
    const r = rng(5);
    for (let i = 0; i < 600; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.04})`; g.fillRect(r() * 256, r() * 256, 6, 6); }
    g.fillStyle = seam;
    for (let x = 0; x < 256; x += 16) g.fillRect(x, 0, 2, 256);
  }, { repeat: [1 / 8, 1 / 8] });
  return new THREE.MeshStandardMaterial({ map, metalness: 0.15, roughness: 0.6, envMapIntensity: 0.5 });
}
/** 水泥混凝土道面：20 m 一格，5 m 分仓切缝 + 板间色差 + 少量油污/修补 */
function pavementTex() {
  const r = rng(77);
  return canvasTex(512, 512, (g, W, H) => {
    g.fillStyle = '#aba89f'; g.fillRect(0, 0, W, H);
    const cell = W / 4;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const k = (r() - 0.5) * 0.08;
      g.fillStyle = k > 0 ? `rgba(255,255,248,${k})` : `rgba(40,38,34,${-k})`;
      g.fillRect(i * cell, j * cell, cell, cell);
    }
    for (let n = 0; n < 5000; n++) { g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${r() * 0.06})` : `rgba(255,255,255,${r() * 0.05})`; g.fillRect(r() * W, r() * H, 1 + r() * 2, 1 + r() * 2); }
    for (let n = 0; n < 9; n++) {
      const rr = 8 + r() * 26, x = rr + r() * (W - 2 * rr), y = rr + r() * (H - 2 * rr);
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, `rgba(36,33,30,${0.08 + r() * 0.12})`); gr.addColorStop(1, 'rgba(36,33,30,0)');
      g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    g.fillStyle = 'rgba(58,55,50,0.38)';
    for (let i = 0; i < 4; i++) { g.fillRect(i * cell, 0, 2, H); g.fillRect(0, i * cell, W, 2); }
  }, { repeat: [1 / 20, 1 / 20] });
}
function radialTex() {
  return canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  }, { srgb: false });
}

// ---------- 几何工具 ----------
/** 平铺多边形；ang≠0 时 UV 旋转到该方向（让分仓缝顺着机坪长边） */
function flatPoly(outer, hf, lift, ang = 0) {
  const g = new THREE.ShapeGeometry(toShape(outer), 1);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, hf(p.getX(i), p.getZ(i)) + lift);
  const uv = g.attributes.uv;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let i = 0; i < uv.count; i++) { const x = p.getX(i), z = p.getZ(i); uv.setXY(i, x * ca + z * sa, -x * sa + z * ca); }
  g.computeVertexNormals();
  return g;
}
/** 多边形最长边方向角（UV 旋转用） */
function longEdgeAngle(o) {
  let best = 0, ang = 0;
  for (let i = 0, n = o.length / 2; i < n; i++) {
    const j = (i + 1) % n, dx = o[j * 2] - o[i * 2], dz = o[j * 2 + 1] - o[i * 2 + 1], l = Math.hypot(dx, dz);
    if (l > best) { best = l; ang = Math.atan2(dz, dx); }
  }
  return ang;
}
/** 多边形竖直墙面：UV = (周长米, 离 vBase 的高度米) */
function polyWalls(outer, y0, y1, vBase = y0) {
  const pos = [], uv = [];
  const n = outer.length / 2;
  // 统一为逆时针（俯视 X 东 Z 南下 shoelace>0）以使法线朝外
  let a = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += outer[i * 2] * outer[j * 2 + 1] - outer[j * 2] * outer[i * 2 + 1]; }
  let s = 0;
  const v0 = y0 - vBase, v1 = y1 - vBase;
  for (let k = 0; k < n; k++) {
    const i = a > 0 ? k : n - 1 - k, j = a > 0 ? (k + 1) % n : (n - 2 - k + n) % n;
    const x0 = outer[i * 2], z0 = outer[i * 2 + 1], x1 = outer[j * 2], z1 = outer[j * 2 + 1];
    const l = Math.hypot(x1 - x0, z1 - z0);
    if (l < 0.05) continue;
    pos.push(x0, y0, z0, x1, y1, z1, x1, y0, z1, x0, y0, z0, x0, y1, z0, x1, y1, z1);
    uv.push(s, v0, s + l, v1, s + l, v0, s, v0, s, v1, s + l, v1);
    s += l;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
function orientedBox(w, h, d, x, y, z, yaw, pitch = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
  return { g, m };
}
/** 拱形屋面（横向抛物线），返回世界坐标几何（UV 米） */
function vaultGeo(H, y0, over) {
  const W = H.wid + over * 2, Lx = H.len + over * 2;
  const g = new THREE.PlaneGeometry(W, Lx, 28, 2);
  const p = g.attributes.position, uv = g.attributes.uv;
  const ax = H.a[0], az = H.a[1], bx = az, bz = -ax;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i), v = p.getY(i);
    const t = (2 * u) / W;
    const y = y0 + H.eave + H.rise * (1 - t * t);
    const x = H.c[0] + bx * u + ax * v, z = H.c[1] + bz * u + az * v;
    p.setXYZ(i, x, y, z);
    uv.setXY(i, u, v);
  }
  g.computeVertexNormals();
  // 让法线朝上
  if (g.attributes.normal.getY(0) < 0) { g.index.array.reverse(); g.computeVertexNormals(); }
  return g;
}
/**
 * 去掉轮廓上的窄突出：OSM 把廊桥固定廊 + 旋转台（根部宽 3~8 m 的“T”形小块）画进了 T5 指廊轮廓，
 * 直接拉伸会变成一排 24 m 高的玻璃方柱。根部间隙 < maxGap、面积 < maxArea 的子环整段切掉，
 * 并记下每个突出的根部中点与最远端（= 固定廊根部与旋转台位置），供廊桥复用。
 */
function denotch(o, maxGap = 9, maxArea = 900) {
  let p = [];
  for (let i = 0; i < o.length; i += 2) p.push([o[i], o[i + 1]]);
  const stubs = [];
  let changed = true, guard = 0;
  while (changed && guard++ < 400) {
    changed = false;
    const n = p.length;
    if (n < 8) break;
    outer: for (let i = 0; i < n; i++) {
      for (let k = 3; k <= Math.min(14, n - 3); k++) {
        const j = (i + k) % n, a = p[i], b = p[j];
        const gap = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (gap > maxGap) continue;
        let path = 0, area = 0;
        for (let t = 0; t < k; t++) { const u = p[(i + t) % n], v = p[(i + t + 1) % n]; path += Math.hypot(v[0] - u[0], v[1] - u[1]); area += u[0] * v[1] - v[0] * u[1]; }
        area = Math.abs(area + b[0] * a[1] - a[0] * b[1]) / 2;
        if (path < gap + 12 || area > maxArea) continue;
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        let tip = null, dep = 0;
        for (let t = 1; t < k; t++) { const q = p[(i + t) % n], d = Math.hypot(q[0] - mx, q[1] - mz); if (d > dep) { dep = d; tip = q; } }
        // 被切掉的突出里若含有更早记下的突出（T 形横杆先被切），以离根部最远者为准
        for (let s = stubs.length - 1; s >= 0; s--) {
          const st = stubs[s];
          if (Math.hypot(st.rx - mx, st.rz - mz) < dep + 2 && Math.hypot(st.tx - mx, st.tz - mz) <= dep + 12) {
            const d2 = Math.hypot(st.tx - mx, st.tz - mz);
            if (d2 > dep) { dep = d2; tip = [st.tx, st.tz]; }
            stubs.splice(s, 1);
          }
        }
        if (dep > 6) stubs.push({ rx: mx, rz: mz, tx: tip[0], tz: tip[1], dep });
        const keep = [];
        for (let t = 0; t < n; t++) { const off = (t - i + n) % n; if (off === 0 || off >= k) keep.push(p[t]); }
        p = keep; changed = true;
        break outer;
      }
    }
  }
  return { outer: p.flat(), stubs };
}
/** 立面索引：射线求交与最近立面（廊桥固定端、登机口补机位用） */
function facadeIndex(polys) {
  const E = [];
  for (const o of polys) {
    const n = o.length / 2;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; E.push([o[i * 2], o[i * 2 + 1], o[j * 2], o[j * 2 + 1], o]); }
  }
  return {
    ray(x, z, dx, dz, maxd) {
      let best = null;
      for (const [ax, az, bx, bz] of E) {
        const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((ax - x) * ez - (az - z) * ex) / den, u = ((ax - x) * dz - (az - z) * dx) / den;
        if (u >= 0 && u <= 1 && t > 0 && t < maxd && (best === null || t < best)) best = t;
      }
      return best;
    },
    nearest(x, z) {
      let best = null;
      for (const [ax, az, bx, bz, o] of E) {
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        if (l2 < 1) continue;
        const k = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
        const px = ax + dx * k, pz = az + dz * k, d = Math.hypot(px - x, pz - z);
        if (!best || d < best.d) { const l = Math.sqrt(l2); best = { d, px, pz, ex: dx / l, ez: dz / l, poly: o }; }
      }
      return best;
    },
  };
}

export default {
  id: 'airports',
  name: '咸阳国际机场、阎良与其它机场',

  prepare(ctx) {
    const A = ctx.data.aeroway;
    if (!A) return;
    for (const a of A.aerodromes || []) {
      if (!a.outer || a.outer.length < 6) continue;
      const big = a.iata === 'XIY' || /阎良/.test(a.n);
      if (big) ctx.terrain.addFlatten({ points: a.outer, height: null, feather: 220 });
      ctx.exclusions.add({ points: a.outer, name: a.n }, { buildings: false, trees: true, roads: false, pois: false });
    }
    for (const f of A.runways || []) {
      if (!f.p || f.p.length < 4) continue;
      const R = runwayInfo(f);
      ctx.exclusions.add({ points: runwayRect(R, 60, 75) }, { buildings: true, trees: true });
      const inBig = (A.aerodromes || []).some((a) => (a.iata === 'XIY' || /阎良/.test(a.n)) && pointInPoly(R.ax, R.az, a.outer));
      if (!inBig) ctx.terrain.addFlatten({ points: runwayRect(R, 30, 20), height: null, feather: 80 });
    }
    for (const f of A.aprons || []) if (f.outer) ctx.exclusions.add({ points: f.outer }, { buildings: true, trees: true });
    for (const t of A.terminals || []) if (TERM_H[t.n]) ctx.exclusions.add({ points: t.outer, name: t.n }, { buildings: true, trees: true });
    for (const H of HALLS) {
      const ax = H.a[0], az = H.a[1];
      ctx.exclusions.add({ rect: [H.c[0], H.c[1], H.wid + 80, H.len + 40, Math.atan2(ax, az)] }, { buildings: true, trees: true });
    }
    for (const h of HANGARS) ctx.exclusions.add({ points: h }, { buildings: true, trees: true });
    if (TOWER) ctx.exclusions.add({ circle: [TOWER[0], TOWER[1], 30] }, { buildings: true, trees: true });
  },

  async build(ctx) {
    const A = ctx.data.aeroway || {};
    const hf = (x, z) => ctx.terrain.heightAt(x, z);
    const root = new THREE.Group();
    root.name = '机场群';
    ctx.scene.add(root);

    // ===== 按机场分组：标线/廊桥/高杆灯等近景细节各自按距离显隐（阎良等不再跟着咸阳一起隐藏） =====
    const AD = (A.aerodromes || []).filter((a) => a.outer && a.outer.length >= 6).map((a) => {
      const b = bboxOf(a.outer);
      const g = new THREE.Group();
      g.name = '机场细节-' + a.n;
      root.add(g);
      return { a, cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, rad: Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2, marks: new TriSink(), detail: new Batcher(), pools: [], group: g };
    });
    if (!AD.length) {
      const g = new THREE.Group();
      root.add(g);
      AD.push({ a: { n: '咸阳', iata: 'XIY', outer: [] }, cx: XIY_C[0], cz: XIY_C[1], rad: 4000, marks: new TriSink(), detail: new Batcher(), pools: [], group: g });
    }
    const adOf = (x, z) => {
      let best = AD[0], bd = Infinity;
      for (const c of AD) {
        if (c.a.outer.length && pointInPoly(x, z, c.a.outer)) return c;
        const d = Math.hypot(x - c.cx, z - c.cz) - c.rad;
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    };
    const XIY = AD.find((c) => c.a.iata === 'XIY') || adOf(XIY_C[0], XIY_C[1]);
    const xiyGroup = XIY.group;

    // ===== 材质 =====
    const pav = pavementTex();
    const matApron = new THREE.MeshStandardMaterial({ map: pav, color: 0xd6d3cc, roughness: 0.9 });
    const matTaxi = new THREE.MeshStandardMaterial({ map: pav, color: 0xcbc8c1, roughness: 0.9 });
    const matRwy = new THREE.MeshStandardMaterial({ map: pav, color: 0xd0cdc6, roughness: 0.88, vertexColors: true });
    ctx.overlay(matApron, 0.00012); ctx.overlay(matTaxi, 0.0002); ctx.overlay(matRwy, 0.00026);
    const atlas = markingAtlas();
    const matMark = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, alphaTest: 0.45, roughness: 0.75 });
    ctx.overlay(matMark, 0.00034);
    const matGlass = curtainMaterial(ctx);
    const matT1 = disusedWallMaterial();
    const matRoofW = roofMaterial('#d9dcdf', '#b9bdc1');
    const matRoofG = roofMaterial('#9aa2a8', '#838b91');
    const matStruct = new THREE.MeshStandardMaterial({ color: 0xd4d7da, metalness: 0.45, roughness: 0.45 });
    // 屋盖底面（吊顶）：夜里被雨棚筒灯与机坪灯照亮，略带暖白
    const matSoffit = new THREE.MeshStandardMaterial({ color: 0xd4d7da, metalness: 0.4, roughness: 0.5, emissive: 0xfff2e2, emissiveIntensity: 0 });
    ctx.night.register(matSoffit, { day: 0, night: 0.12 });
    // 屋檐轮廓灯 / 雨棚筒灯带（冷白 LED）
    const matEave = new THREE.MeshStandardMaterial({ color: 0xe9edf1, emissive: 0xf0f5ff, emissiveIntensity: 0, roughness: 0.4 });
    ctx.night.register(matEave, { day: 0, night: 2.4 });
    const matDown = new THREE.MeshStandardMaterial({ color: 0xe9edf1, emissive: 0xfff6ea, emissiveIntensity: 0, roughness: 0.4 });
    ctx.night.register(matDown, { day: 0, night: 1.4 });
    // 天窗：夜里透出室内光
    const matSky = new THREE.MeshStandardMaterial({ color: 0x4d6474, metalness: 0.6, roughness: 0.1, emissive: 0xe4ecf8, emissiveIntensity: 0 });
    ctx.night.register(matSky, { day: 0, night: 0.3 });
    // 廊桥玻璃带
    const matBridgeGlass = new THREE.MeshStandardMaterial({ color: 0x33434e, metalness: 0.5, roughness: 0.15, emissive: 0xfff1de, emissiveIntensity: 0 });
    ctx.night.register(matBridgeGlass, { day: 0, night: 0.42 });
    const matDark = new THREE.MeshStandardMaterial({ color: 0x3a3f44, metalness: 0.5, roughness: 0.5 });
    const matConc = ctx.mats.get('concrete');
    const matTowerGlass = new THREE.MeshPhysicalMaterial({ color: 0x2f6f96, metalness: 0.7, roughness: 0.08, envMapIntensity: 1.5, emissive: 0x6fb7e0, emissiveIntensity: 0 });
    ctx.night.register(matTowerGlass, { day: 0, night: 0.9 });
    const matCab = new THREE.MeshStandardMaterial({ color: 0x1d3038, metalness: 0.6, roughness: 0.1, emissive: 0x9fffd8, emissiveIntensity: 0 });
    ctx.night.register(matCab, { day: 0, night: 1.4 });
    const matLamp = ctx.mats.get('lampWhite');

    const surf = new Batcher();
    const bld = new Batcher();
    // 不投影的附属件：屋盖吊顶（离屋面只有 1.6 m，阴影偏移会让整片拱顶被自己的吊顶“遮暗”成蓝灰色）、筒灯等
    const bldNS = new Batcher();
    const rwySink = new TriSink();
    const L = new LightList();
    const r = rng(20260925);
    const deckPools = []; // 陆侧落客平台/雨棚下的冷白光斑

    // ===== 道面 =====
    for (const f of A.aprons || []) {
      if (!f.outer || f.outer.length < 6) continue;
      surf.add(flatPoly(f.outer, hf, 0.1, longEdgeAngle(f.outer)), matApron);
    }
    const taxis = [];
    for (const f of A.taxiways || []) {
      if (!f.p || f.p.length < 4) continue;
      const w = Math.max(10, Math.min(f.w || 23, 30));
      taxis.push({ p: f.p, w });
      const sink = adOf(f.p[0], f.p[1]).marks;
      const pts = offsetLine(f.p, 0);
      const g = ribbonUV(pts, w, hf, 0.16);
      if (g) surf.add(g, matTaxi);
      // 黄色中线（0.3 m，略加宽以便远看）与边线
      markLine(sink, hf, f.p, 0.3, YELLOW, { step: 10, lift: 0.22 });
      let len = 0;
      for (let i = 2; i < f.p.length; i += 2) len += Math.hypot(f.p[i] - f.p[i - 2], f.p[i + 1] - f.p[i - 1]);
      if (len > 180) for (const sd of [-1, 1]) {
        markLine(sink, hf, offsetLine(f.p, sd * (w / 2 - 0.6)), 0.15, YELLOW, { step: 10, trim: 45, lift: 0.22 });
        markLine(sink, hf, offsetLine(f.p, sd * (w / 2 - 0.95)), 0.15, YELLOW, { step: 10, trim: 45, lift: 0.22 });
      }
      // 滑行道灯：绿色中线灯 30 m（亮度低于跑道灯）；直线段不设边灯，只在弯道外侧补蓝色边灯（ICAO：有中线灯的滑行道一般不设边灯）
      const pp = resampleArr(f.p, 30);
      for (let i = 1; i < pp.length - 1; i++) { const q = pp[i]; L.add(q.x, hf(q.x, q.z) + 0.25, q.z, LC.twy, 0.3); }
      const pc = resampleArr(f.p, 15);
      for (let i = 1; i < pc.length - 1; i++) {
        const a0 = pc[i - 1], a1 = pc[i + 1];
        const turn = Math.abs(Math.atan2(a0.dx * a1.dz - a0.dz * a1.dx, a0.dx * a1.dx + a0.dz * a1.dz));
        if (turn < 0.3) continue;
        const q = pc[i];
        for (const sd of [-1, 1]) { const x = q.x - q.dz * sd * (w / 2 + 1), z = q.z + q.dx * sd * (w / 2 + 1); L.add(x, hf(x, z) + 0.35, z, LC.twyEdge, 0.32); }
      }
    }
    const RW = [];
    for (const f of A.runways || []) {
      if (!f.p || f.p.length < 4) continue;
      const R = runwayInfo(f);
      if (R.L < 40) continue; // 滑跃台单独建
      const big = R.L > 2400;
      R.big = big;
      R.xiy = Math.hypot(R.ax - XIY_C[0], R.az - XIY_C[1]) < 6000;
      RW.push(R);
      runwaySurface(rwySink, hf, R, { shoulder: big ? 7.5 : 0, lift: 0.24 });
      runwayMarkings(adOf(R.ax, R.az).marks, hf, R, { big });
      runwayLights(L, hf, R, { approach: R.xiy, center: big });
    }
    surf.add(rwySink.geometry(), matRwy);

    // 跑道等待位置标志（A 型：两实两虚）+ 停止排灯（红）+ 跑道警戒灯（黄闪）
    for (let i = 0; i < HOLDS.length; i += 2) {
      const hx = HOLDS[i], hz = HOLDS[i + 1];
      const t = nearestTaxi(taxis, hx, hz);
      if (!t) continue;
      const sink = adOf(hx, hz).marks;
      let [dx, dz] = t.dir;
      const Rn = RW.reduce((b, R) => { const d = distToRunway(R, hx, hz); return !b || d < b.d ? { R, d } : b; }, null);
      if (Rn) {
        const R = Rn.R, s = (hx - R.ax) * R.ux + (hz - R.az) * R.uz;
        const cx = R.ax + R.ux * s, cz = R.az + R.uz * s;
        if ((hx - cx) * dx + (hz - cz) * dz < 0) { dx = -dx; dz = -dz; } // dx,dz 指向远离跑道
      }
      const w = t.w;
      for (let k = 0; k < 4; k++) {
        const off = (k - 1.5) * 0.45;
        markRect(sink, hf, hx + dx * off, hz + dz * off, -dz, dx, w, 0.28, YELLOW, k < 2 ? undefined : [64 / 1024, 16 / 128, 128 / 1024, 48 / 128], 0.24);
      }
      for (let o = -w / 2 + 1; o <= w / 2 - 1; o += 3) {
        const x = hx + dx * 1.2 - dz * o, z = hz + dz * 1.2 + dx * o;
        L.add(x, hf(x, z) + 0.25, z, LC.red, 0.4, 0, 0, dx, dz);
      }
      for (const sd of [-1, 1]) for (const k of [0, 1]) {
        const x = hx + dx * 2 - dz * sd * (w / 2 + 2 + k * 0.6), z = hz + dz * 2 + dx * sd * (w / 2 + 2 + k * 0.6);
        L.add(x, hf(x, z) + 0.8, z, LC.yellow, 0.7, 2, k * 0.5, dx, dz);
      }
    }
    // 机位引导线 + 停止线
    for (const p of LEADIN) {
      const sink = adOf(p[0], p[1]).marks;
      markLine(sink, hf, p, 0.2, YELLOW, { step: 8, lift: 0.2 });
      const n = p.length;
      const dx = p[n - 2] - p[n - 4], dz = p[n - 1] - p[n - 3], l = Math.hypot(dx, dz) || 1;
      markRect(sink, hf, p[n - 2], p[n - 1], dx / l, dz / l, 0.35, 5, YELLOW, undefined, 0.2);
    }

    // 风向标（橙白相间锥袋）
    for (let i = 0; i < WINDSOCKS.length; i += 2) {
      const x = WINDSOCKS[i], z = WINDSOCKS[i + 1], y = hf(x, z);
      const D = adOf(x, z).detail;
      const pole = new THREE.CylinderGeometry(0.08, 0.1, 6, 6); pole.translate(x, y + 3, z);
      D.add(pole, matStruct);
      const sock = new THREE.CylinderGeometry(0.45, 0.2, 3.6, 10, 1, true); sock.rotateZ(Math.PI / 2 - 0.25); sock.rotateY(0.8); sock.translate(x + 1.4, y + 5.6, z - 1.2);
      D.add(sock, ctx.mats.get('lanternRed'));
      L.add(x, y + 6.3, z, LC.red, 0.6);
    }

    // ===== 航站楼 =====
    const termPolys = [], stubs = [];
    for (const t of A.terminals || []) {
      const h = TERM_H[t.n];
      if (!h || !t.outer) continue;
      const dn = denotch(t.outer);
      const outer = dn.outer;
      if (t.n !== 'T5综合交通中心') { termPolys.push(outer); stubs.push(...dn.stubs); }
      const c = polyCentroid(outer);
      const y0 = hf(c.x ?? c[0], c.z ?? c[1]);
      const disused = TERM_DISUSED[t.n];
      bld.add(polyWalls(outer, y0, y0 + h), disused ? matT1 : matGlass);
      // 檐口封边（中间夹一道轮廓灯带；停用的 T1 不亮）
      if (disused) bld.add(polyWalls(outer, y0 + h, y0 + h + 1.8), matStruct);
      else {
        bld.add(polyWalls(outer, y0 + h, y0 + h + 1.3), matStruct);
        bld.add(polyWalls(outer, y0 + h + 1.3, y0 + h + 1.65), matEave);
        bld.add(polyWalls(outer, y0 + h + 1.65, y0 + h + 1.8), matStruct);
      }
      const roof = flatPoly(outer, () => y0 + h + 1.8, 0);
      bld.add(roof, t.n === '5号航站楼' ? matRoofG : matRoofW);
    }
    const facades = facadeIndex(termPolys);
    for (const H of HALLS) {
      const y0 = hf(H.c[0], H.c[1]);
      const ax = H.a[0], az = H.a[1], bx = az, bz = -ax;
      const yaw = Math.atan2(ax, az);
      const P = (u, v) => [H.c[0] + bx * u + ax * v, H.c[1] + bz * u + az * v];
      const W2 = H.wid + 2 * H.over;
      const ySoff = (u) => y0 + H.eave + H.rise * (1 - ((2 * u) / W2) ** 2) - 1.6; // 屋盖底面高度
      // 主楼玻璃幕墙体（UV 自楼地面起算）
      if (H.walls !== 0) {
        const rect = [...P(-H.wid / 2, -H.len / 2), ...P(H.wid / 2, -H.len / 2), ...P(H.wid / 2, H.len / 2), ...P(-H.wid / 2, H.len / 2)];
        bld.add(polyWalls(rect, y0, y0 + H.eave), matGlass);
      }
      // 屋面（拱）+ 吊顶 + 檐口封边 + 檐口轮廓灯
      bld.add(vaultGeo(H, y0, H.over), H.roof === 'white' ? matRoofW : matRoofG);
      const under = vaultGeo(H, y0 - 1.6, H.over);
      under.index.array.reverse(); under.computeVertexNormals();
      bldNS.add(under, matSoffit);
      for (const sd of [-1, 1]) {
        const [ex, ez] = P(sd * (H.wid / 2 + H.over), 0);
        const e = orientedBox(1.2, 1.8, H.len + H.over * 2, ex, y0 + H.eave - 0.8, ez, yaw);
        bld.add(e.g, matStruct, e.m);
        const [lx, lz] = P(sd * (H.wid / 2 + H.over + 0.62), 0);
        const lt = orientedBox(0.08, 0.28, H.len + H.over * 2, lx, y0 + H.eave - 1.45, lz, yaw);
        bld.add(lt.g, matEave, lt.m);
      }
      // 山墙玻璃（拱下）+ 拱顶山墙轮廓灯
      for (const sd of [-1, 1]) {
        const pos = [], uv = [];
        const N = 16;
        const yA = (u) => y0 + H.eave + H.rise * (1 - ((2 * u) / W2) ** 2) - 1.6;
        const Q = (u, yy) => { const [x, z] = P(u, sd * H.len / 2); return [x, yy, z]; };
        for (let k = 0; k < N; k++) {
          const u0 = -H.wid / 2 + (H.wid * k) / N, u1 = -H.wid / 2 + (H.wid * (k + 1)) / N;
          const tri = [[u0, y0 + H.eave], [u1, y0 + H.eave], [u1, yA(u1)], [u0, y0 + H.eave], [u1, yA(u1)], [u0, yA(u0)]];
          for (const [u, yy] of tri) { pos.push(...Q(u, yy)); uv.push(u * sd, yy - y0); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        g.computeVertexNormals();
        const g2 = g.clone();
        { const a = g2.attributes.position.array, ua = g2.attributes.uv.array; for (let i = 0; i < a.length; i += 9) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; } for (let i = 0; i < ua.length; i += 6) for (let k = 0; k < 2; k++) { const t = ua[i + 2 + k]; ua[i + 2 + k] = ua[i + 4 + k]; ua[i + 4 + k] = t; } g2.computeVertexNormals(); }
        bld.add(g, matGlass); bld.add(g2, matGlass);
        // 山墙拱边轮廓灯（沿屋盖外缘）
        const NA = 20;
        for (let k = 0; k < NA; k++) {
          const u0 = -W2 / 2 + (W2 * k) / NA, u1 = -W2 / 2 + (W2 * (k + 1)) / NA, um = (u0 + u1) / 2;
          const yT = (u) => y0 + H.eave + H.rise * (1 - ((2 * u) / W2) ** 2) - 0.35;
          const [x, z] = P(um, sd * (H.len / 2 + H.over + 0.06));
          // 盒子局部 X 轴 = 横向 b（yaw 旋转后），再绕局部 Z 轴按拱的坡度倾斜
          const len = Math.hypot(u1 - u0, yT(u1) - yT(u0));
          const ang = Math.atan2(yT(u1) - yT(u0), u1 - u0);
          const g = new THREE.BoxGeometry(len + 0.05, 0.28, 0.08);
          const m = new THREE.Matrix4().compose(new THREE.Vector3(x, yT(um), z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, ang, 'YXZ')), new THREE.Vector3(1, 1, 1));
          bld.add(g, matEave, m);
        }
      }
      // 屋面肋 / 天窗
      if (H.ribs) {
        for (let v = -H.len / 2 + 15; v < H.len / 2; v += 28) {
          const N = 14;
          for (let k = 0; k < N; k++) {
            const u0 = -W2 / 2 + (W2 * k) / N, u1 = -W2 / 2 + (W2 * (k + 1)) / N;
            const y = (u) => y0 + H.eave + H.rise * (1 - ((2 * u) / W2) ** 2) + 0.5;
            const um = (u0 + u1) / 2, len = Math.hypot(u1 - u0, y(u1) - y(u0));
            const [x, z] = P(um, v);
            const e = orientedBox(1.4, 1.0, len + 0.3, x, y(um), z, Math.atan2(bx, bz), -Math.atan2(y(u1) - y(u0), u1 - u0));
            bld.add(e.g, matStruct, e.m);
          }
        }
      }
      if (H.sky) {
        const e = orientedBox(14, 1.2, H.len * 0.8, H.c[0], y0 + H.eave + H.rise + 0.3, H.c[1], yaw);
        bld.add(e.g, matSky, e.m, { worldUV: 1 });
        for (const sd of [-1, 1]) {
          const [x, z] = P(sd * H.wid * 0.3, 0);
          const e2 = orientedBox(4, 0.8, H.len * 0.7, x, y0 + H.eave + H.rise * 0.64 + 0.3, z, yaw);
          bld.add(e2.g, matSky, e2.m, { worldUV: 1 });
        }
      }
      // 陆侧：屋盖挑檐下两排筒灯（每 6 m 一盏；做成连续灯带会被泛光糊成一条白光）
      for (const f of [0.32, 0.74]) {
        const u = H.wid / 2 + H.over * f;
        for (let v = -H.len / 2 + 3; v < H.len / 2; v += 6) {
          const [x, z] = P(u, v);
          const e = orientedBox(0.7, 0.1, 0.7, x, ySoff(u) - 0.06, z, yaw);
          bldNS.add(e.g, matDown, e.m);
        }
      }
      if (H.deck) {
        // 高架落客平台 + 雨棚柱
        const off = H.wid / 2 + 26, dl = H.len * 0.86, dw = 24, dy = y0 + 9;
        const [cx, cz] = P(off, 0);
        const deck = orientedBox(dw, 1.6, dl, cx, dy, cz, yaw);
        bld.add(deck.g, matConc, deck.m, { worldUV: 1 });
        for (let v = -dl / 2 + 10; v <= dl / 2 - 10; v += 30) {
          const col = new THREE.CylinderGeometry(0.9, 0.9, 9, 10);
          col.translate(cx + ax * v, y0 + 4.5, cz + az * v);
          bld.add(col, matConc);
          const pole = new THREE.CylinderGeometry(0.35, 0.45, H.eave - 9, 8);
          const [px, pz] = P(H.wid / 2 + H.over - 3, v);
          pole.translate(px, dy + (H.eave - 9) / 2, pz);
          bld.add(pole, matStruct);
        }
        for (const sd of [-1, 1]) {
          const rail = orientedBox(0.3, 1.1, dl, cx + bx * sd * (dw / 2 - 0.2), dy + 1.3, cz + bz * sd * (dw / 2 - 0.2), yaw);
          bld.add(rail.g, matStruct, rail.m);
        }
        // 平台照明：灯杆灯点 + 地面光斑（一排、间距大于光斑半径，避免加色叠成白团）+ 少量动态点光源（只点亮离相机最近的几盏）
        for (let v = -dl / 2 + 10; v <= dl / 2 - 10; v += 20) {
          const x = cx + ax * v, z = cz + az * v;
          L.add(x - bx * 7, dy + 6.5, z - bz * 7, LC.mast, 0.45);
          deckPools.push([x, dy + 0.86, z, 20]);
        }
        for (let v = -dl / 2 + 40; v <= dl / 2 - 40; v += 80) ctx.lights.add({ position: new THREE.Vector3(cx + ax * v, dy + 7, cz + az * v), color: 0xeef3ff, intensity: 700, distance: 55, priority: 2 });
        // 招牌
        if (H.sign === 'xiy') {
          const s = ctx.sign('西安咸阳国际机场', { height: 7.5, color: '#ffffff', emissive: 2.6, weight: 800 });
          const d = H.wid / 2 + H.over + 0.9;
          s.position.set(H.c[0] + bx * d, y0 + H.eave + 1.5, H.c[1] + bz * d);
          s.rotation.y = Math.atan2(bx, bz);
          xiyGroup.add(s);
        } else if (H.sign === 't5') {
          const s = ctx.sign('西安', { height: 22, color: '#c8161d', serif: true, emissive: 2.2, stroke: '#7a0c10', letterSpacing: 1.2 });
          const d = H.wid / 2 + H.over - 10;
          s.position.set(H.c[0] + bx * d, y0 + H.eave + H.rise * 0.55 + 11, H.c[1] + bz * d);
          s.rotation.y = Math.atan2(bx, bz);
          xiyGroup.add(s);
          const s2 = ctx.sign('西安咸阳国际机场  T5', { height: 3.2, color: '#ffffff', bg: '#1d2f45', emissive: 2.0 });
          s2.position.set(cx + bx * (dw / 2 + 0.3), dy + 3.2, cz + bz * (dw / 2 + 0.3));
          s2.rotation.y = Math.atan2(bx, bz);
          xiyGroup.add(s2);
        }
      } else if (H.curb) {
        // 地面层落客：挑檐下路面光斑（灯具本身就是上面的筒灯带）
        const u = H.wid / 2 + H.over * 0.55;
        for (let v = -H.len / 2 + 10; v <= H.len / 2 - 10; v += 20) {
          const [x, z] = P(u, v);
          deckPools.push([x, hf(x, z) + 0.45, z, 18]);
        }
        for (let v = -H.len / 2 + 40; v <= H.len / 2 - 40; v += 80) { const [x, z] = P(u, v); ctx.lights.add({ position: new THREE.Vector3(x, y0 + 8, z), color: 0xeef3ff, intensity: 600, distance: 45, priority: 2 }); }
      }
    }

    // ===== 塔台 =====
    if (TOWER) {
      const [tx, tz] = TOWER, ty = hf(tx, tz);
      const lathe = (pts, mat, seg = 8) => {
        const g = new THREE.LatheGeometry(pts.map(([rr, y]) => new THREE.Vector2(rr, y)), seg).toNonIndexed();
        g.computeVertexNormals();
        g.translate(tx, ty, tz);
        bld.add(g, mat, null, { worldUV: 0.5 });
      };
      lathe([[0.01, 0], [6.4, 0], [5.6, 18], [4.9, 40], [4.8, 52], [5.2, 58]], matStruct);
      lathe([[5.2, 58], [6.2, 64], [7.6, 70], [9.2, 77]], matTowerGlass);
      lathe([[9.2, 77], [9.6, 78.6], [6.4, 79], [0.01, 79.2]], matStruct);
      lathe([[6.2, 79], [7.0, 84.6], [7.4, 85]], matCab, 12);
      lathe([[7.8, 85], [7.9, 86.2], [0.01, 86.6]], matDark, 12);
      for (const a of [0.4, 2.2, 4.1]) {
        const ant = new THREE.CylinderGeometry(0.08, 0.1, 7, 5); ant.translate(tx + Math.cos(a) * 3, ty + 90, tz + Math.sin(a) * 3);
        bld.add(ant, matDark);
      }
      // 竖向分缝（深色）
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
        const e = orientedBox(0.35, 58, 0.3, tx + Math.sin(a) * 5.35, ty + 29, tz + Math.cos(a) * 5.35, a);
        bld.add(e.g, matDark, e.m);
      }
      L.add(tx, ty + 94, tz, LC.red, 1.4, 3, 0.3);
      L.add(tx, ty + 86.8, tz, LC.red, 1.0);
      ctx.lights.add({ position: new THREE.Vector3(tx, ty + 70, tz), color: 0x9fd8ff, intensity: 900, distance: 90, priority: 2 });
    }

    // ===== 机库 =====
    for (const h of HANGARS) {
      const c = polyCentroid(h);
      const y0 = hf(c.x ?? c[0], c.z ?? c[1]);
      bld.add(polyWalls(h, y0, y0 + 24), matStruct);
      bld.add(flatPoly(h, () => y0 + 24, 0), matRoofW);
    }

    // ===== 机位：OSM 机位线 + 登机口补机位 → 去重（按翼展）→ 飞机 + 廊桥 =====
    const types = ['a320', 'b738', 'a330', 'b789', 'a359', 'y20', 'ma60'];
    const place = Object.fromEntries(types.map((k) => [k, []]));
    const stands = [];
    for (let i = 0; i < STANDS.length; i += 5) {
      const [x, z, h, cls, hit0] = STANDS.slice(i, i + 5);
      const contact = hit0 > 0 && hit0 < 70;
      // 立面距离按切掉突出后的轮廓重算（原值多半打在廊桥固定端突出上）
      const hit = contact ? facades.ray(x, z, Math.sin(h), Math.cos(h), 140) ?? hit0 : 0;
      stands.push({ x, z, h, cls, hit });
    }
    // OSM 近机位配对轮廓上切下来的廊桥突出（旋转台在机头左前方约 11 m）
    const usedStub = new Set();
    for (const s of stands) {
      if (!s.hit) continue;
      const dx = Math.sin(s.h), dz = Math.cos(s.h), lx = dz, lz = -dx;
      const qx = s.x + dx * 11 + lx * 11, qz = s.z + dz * 11 + lz * 11;
      let best = -1, bd = 32;
      stubs.forEach((st, i) => { const d = Math.hypot(st.tx - qx, st.tz - qz); if (!usedStub.has(i) && d < bd) { bd = d; best = i; } });
      if (best >= 0) { usedStub.add(best); s.stub = stubs[best]; }
    }
    // 登机口补机位：OSM 只给 T5 西北指廊画了机位线，其余指廊只有登机口节点（位于廊桥旋转台）
    const synth = [];
    for (const g of A.gates || []) {
      if ([...usedStub].some((i) => Math.hypot(stubs[i].tx - g.x, stubs[i].tz - g.z) < 16)) continue;
      const served = stands.some((s) => {
        if (!s.hit) return false;
        const dx = Math.sin(s.h), dz = Math.cos(s.h), vx = g.x - s.x, vz = g.z - s.z;
        const along = vx * dx + vz * dz, lat = vx * dz - vz * dx; // lat > 0：飞机左侧
        return along > -10 && along < s.hit + 15 && Math.abs(lat - 10) < 20;
      });
      if (served) continue;
      // 登机口落在某个没配上的突出上：直接用该突出做固定廊 + 旋转台
      let stub = null;
      stubs.forEach((st, i) => { if (!stub && !usedStub.has(i) && Math.hypot(st.tx - g.x, st.tz - g.z) < 16) { stub = st; usedStub.add(i); } });
      const f = facades.nearest(stub ? stub.rx : g.x, stub ? stub.rz : g.z);
      if (!f || f.d > 60) continue;
      let nx = -f.ez, nz = f.ex;
      if (pointInPoly(f.px + nx * 2, f.pz + nz * 2, f.poly)) { nx = -nx; nz = -nz; }
      const px = stub ? stub.rx : f.px, pz = stub ? stub.rz : f.pz;
      const gr = stub ? clamp(stub.dep, 8, 40) : clamp(Math.hypot(g.x - f.px, g.z - f.pz), 12, 40);
      if (synth.some((o) => Math.hypot(o.px - px, o.pz - pz) < 18)) continue;
      const rx = stub ? stub.tx : px + nx * gr, rz = stub ? stub.tz : pz + nz * gr;
      synth.push({ px, pz, rx, rz, nx, nz, gr, ref: g.ref || '', syn: 1 });
    }
    for (const s of synth) {
      let nd = 99;
      for (const o of synth) if (o !== s && o.nx * s.nx + o.nz * s.nz > 0.7) nd = Math.min(nd, Math.hypot(o.px - s.px, o.pz - s.pz));
      s.cls = /;/.test(s.ref) ? 2 : nd >= 68 ? 2 : nd >= 52 ? 1 : 0;
    }
    // 近机位先放（优先保证廊桥机位有飞机），远机位后放；按翼展/机身长圆形去重，压在滑行通道上的丢弃
    const placed = [];
    const fits = (x, z, rad) => !placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.rad + rad);
    const onTaxi = (x, z) => taxis.some((t) => distToLine(t.p, x, z) < t.w / 2 + 2);
    const pickType = (cls) => (cls === 0 ? (r() < 0.58 ? 'a320' : 'b738') : cls === 1 ? (r() < 0.5 ? 'a330' : 'b789') : ['a359', 'b789', 'a330'][Math.floor(r() * 3)]);
    const order = [...synth, ...stands.filter((s) => s.hit), ...stands.filter((s) => !s.hit)];
    const bridges = [];
    for (const s of order) {
      const contact = !!(s.syn || s.hit);
      const occupied = r() <= (contact ? 0.86 : 0.7);
      const want = pickType(s.cls);
      let got = null;
      for (const type of occupied ? (s.cls > 0 ? [want, 'a320'] : [want]) : []) {
        const T = TYPES[type];
        const st = standGeom(s, T);
        const midX = st.sx - st.dx * (T.wb + T.mgz), midZ = st.sz - st.dz * (T.wb + T.mgz);
        const rad = Math.max(T.span, T.L) * 0.46;
        if (!fits(midX, midZ, rad) || onTaxi(midX, midZ)) continue;
        placed.push({ x: midX, z: midZ, rad });
        const gx = st.sx - st.dx * T.wb, gz = st.sz - st.dz * T.wb;
        place[type].push({ x: gx, z: gz, y: hf(gx, gz) + 0.12, h: Math.atan2(st.dx, st.dz), liv: pickW(r, XIY_MIX) });
        got = { type, T, st };
        break;
      }
      if (contact) {
        // 空机位也有廊桥（收回停放）
        const T = got ? got.T : TYPES.a320;
        const st = got ? got.st : standGeom(s, T);
        const b = bridgeGeom(s, st, T, !!got);
        if (b) bridges.push(b);
        // 补机位画引导线 + 停止线
        if (s.syn) {
          const sink = adOf(st.sx, st.sz).marks;
          markLine(sink, hf, [st.sx + s.nx * 55, st.sz + s.nz * 55, st.sx, st.sz], 0.2, YELLOW, { step: 8, lift: 0.2 });
          markRect(sink, hf, st.sx, st.sz, st.dx, st.dz, 0.35, 5, YELLOW, undefined, 0.2);
        }
      }
      // 远机位放不下（与相邻机位重叠或压在滑行通道上）就空着
    }
    /** 机位几何：前轮停止点 (sx,sz)、机头方向 (dx,dz)、机头到立面距离 N、立面点（机身中线延长线上）(fx,fz) */
    function standGeom(s, T) {
      if (s.syn) {
        // 补机位：机头朝立面，机头尖比旋转台再往外 2 m，机身中线在旋转台右侧 R+12 m（L1 门在左侧，伸缩通道斜向接门）
        const dx = -s.nx, dz = -s.nz, lx = dz, lz = -dx;
        const off = T.R + 12, k = noseAhead(T);
        const noseX = s.rx + s.nx * 2 - lx * off, noseZ = s.rz + s.nz * 2 - lz * off;
        const N = s.gr + 2;
        return { sx: noseX + s.nx * k, sz: noseZ + s.nz * k, dx, dz, N, fx: noseX - s.nx * N, fz: noseZ - s.nz * N };
      }
      const dx = Math.sin(s.h), dz = Math.cos(s.h);
      return { sx: s.x, sz: s.z, dx, dz, N: s.hit - noseAhead(T), fx: s.x + dx * s.hit, fz: s.z + dz * s.hit };
    }
    /** 廊桥：立面固定端 → 固定廊（垂直立面）→ 旋转台 → 两节伸缩通道 → 接机口（飞机左侧 L1 门） */
    function bridgeGeom(s, st, T, occupied) {
      const { dx, dz } = st;
      const lx = dz, lz = -dx;
      let rx, rz, fx, fz;
      if (s.syn) {
        fx = s.px; fz = s.pz; rx = s.rx; rz = s.rz;
      } else if (s.stub) {
        fx = s.stub.rx; fz = s.stub.rz; rx = s.stub.tx; rz = s.stub.tz;
      } else {
        if (st.N < 6) return null;
        const off = T.R + 7, gr = clamp(st.N - 16, 8, 30);
        rx = st.fx - dx * gr + lx * off; rz = st.fz - dz * gr + lz * off;
        const t = facades.ray(rx, rz, dx, dz, gr + 40);
        if (t !== null) { fx = rx + dx * t; fz = rz + dz * t; }
        else { fx = st.fx + lx * off; fz = st.fz + lz * off; }
      }
      const noseX = st.sx + dx * noseAhead(T), noseZ = st.sz + dz * noseAhead(T);
      let cx = noseX - dx * T.doorF + lx * (T.R + 1.6), cz = noseZ - dz * T.doorF + lz * (T.R + 1.6);
      if (!occupied) { cx = rx + (cx - rx) * 0.45; cz = rz + (cz - rz) * 0.45; }
      return { fx, fz, rx, rz, cx, cz, doorH: occupied ? doorSill(T) : 3.2 };
    }
    for (const b of bridges) {
      const D = adOf(b.rx, b.rz).detail;
      const yR = hf(b.rx, b.rz), yF = yR + b.doorH;
      // 固定廊 + 立柱
      const fl = Math.hypot(b.rx - b.fx, b.rz - b.fz);
      if (fl > 1) {
        const yaw = Math.atan2(b.rx - b.fx, b.rz - b.fz);
        const mx = (b.fx + b.rx) / 2, mz = (b.fz + b.rz) / 2;
        const e = orientedBox(3.2, 3.0, fl, mx, yF + 1.5, mz, yaw);
        D.add(e.g, matStruct, e.m);
        const w = orientedBox(3.28, 0.85, fl * 0.92, mx, yF + 1.85, mz, yaw);
        D.add(w.g, matBridgeGlass, w.m);
        for (let t = 7; t < fl - 3; t += 12) {
          const x = b.fx + ((b.rx - b.fx) * t) / fl, z = b.fz + ((b.rz - b.fz) * t) / fl, yg = hf(x, z), ch = yF - yg;
          if (ch < 0.5) continue;
          const col = new THREE.CylinderGeometry(0.4, 0.45, ch, 8); col.translate(x, yg + ch / 2, z);
          D.add(col, matStruct);
        }
      }
      // 旋转台 + 立柱（柱高 = 地板离地高，不是绝对海拔）
      const rot = new THREE.CylinderGeometry(2.3, 2.3, 3.8, 12); rot.translate(b.rx, yF + 1.7, b.rz); D.add(rot, matStruct);
      {
        const ch = yF - yR;
        const col = new THREE.CylinderGeometry(0.7, 0.8, ch, 8); col.translate(b.rx, yR + ch / 2, b.rz);
        D.add(col, matDark);
      }
      // 伸缩通道
      const bl = Math.hypot(b.cx - b.rx, b.cz - b.rz);
      if (bl < 4) continue;
      const yaw = Math.atan2(b.cx - b.rx, b.cz - b.rz);
      const ux = (b.cx - b.rx) / bl, uz = (b.cz - b.rz) / bl;
      const tunnel = (a, c, w, hh) => {
        const cxm = b.rx + (ux * (a + c)) / 2, czm = b.rz + (uz * (a + c)) / 2;
        const e = orientedBox(w, hh, c - a, cxm, yF + hh / 2, czm, yaw);
        D.add(e.g, matStruct, e.m);
        const wnd = orientedBox(w + 0.06, hh * 0.28, (c - a) * 0.92, cxm, yF + hh * 0.62, czm, yaw);
        D.add(wnd.g, matBridgeGlass, wnd.m);
      };
      tunnel(2, bl * 0.55, 3.2, 3.1);
      tunnel(bl * 0.53, bl - 2.5, 2.8, 2.8);
      const cab = orientedBox(3.8, 3.4, 3.2, b.cx - ux * 1.5, yF + 1.7, b.cz - uz * 1.5, yaw);
      D.add(cab.g, matDark, cab.m);
      // 行走支腿（两根，高 = 通道地板离地高）+ 行走轮架
      const legX = b.rx + ux * bl * 0.62, legZ = b.rz + uz * bl * 0.62, yL = hf(legX, legZ), lh = yF - yL;
      if (lh > 0.3) for (const sd of [-1, 1]) {
        const leg = new THREE.CylinderGeometry(0.25, 0.25, lh, 6); leg.translate(legX + uz * sd * 1.2, yL + lh / 2, legZ - ux * sd * 1.2); D.add(leg, matDark);
      }
      const bog = orientedBox(3.6, 0.9, 1.6, legX, yL + 0.45, legZ, yaw + Math.PI / 2);
      D.add(bog.g, matDark, bog.m);
    }
    // 阎良：试飞院机坪停放运-20、新舟 60、试飞涂装窄体机
    const ylAD = AD.find((c) => /阎良/.test(c.a.n));
    const ylApron = ylAD && (A.aprons || []).find((f) => f.outer && pointInPoly(f.outer[0], f.outer[1], ylAD.a.outer));
    const ylR = RW.filter((R) => Math.hypot(R.ax - YL_C[0], R.az - YL_C[1]) < 4000 && R.L > 3000);
    const ylHangars = [];
    if (ylApron && ylR.length) {
      const R = ylR[0];
      const c = polyCentroid(ylApron.outer);
      const cx0 = c.x ?? c[0], cz0 = c.z ?? c[1];
      // 远离跑道的法向
      const s = (cx0 - R.ax) * R.ux + (cz0 - R.az) * R.uz;
      let nx = cx0 - (R.ax + R.ux * s), nz = cz0 - (R.az + R.uz * s);
      const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
      const faceH = Math.atan2(-nx, -nz); // 机头朝跑道
      const lineup = [['y20', 9], ['y20', 9], ['y20', 9], ['a320', 8], ['ma60', 10], ['ma60', 8], ['y20', 9]];
      lineup.forEach(([t, liv], k) => {
        const o = (k - (lineup.length - 1) / 2) * 62;
        const x = cx0 + R.ux * o - nx * 20, z = cz0 + R.uz * o - nz * 20;
        place[t].push({ x, z, y: hf(x, z) + 0.12, h: faceH, liv });
      });
      for (let k = -1; k <= 1; k++) {
        const x = cx0 + R.ux * k * 120 + nx * 170, z = cz0 + R.uz * k * 120 + nz * 170;
        ylHangars.push({ x, z, yaw: Math.atan2(R.ux, R.uz) });
      }
    }
    for (const hg of ylHangars) {
      const y0 = hf(hg.x, hg.z);
      const e = orientedBox(96, 26, 72, hg.x, y0 + 13, hg.z, hg.yaw + Math.PI / 2);
      bld.add(e.g, matStruct, e.m, { worldUV: 1 });
      const H = { c: [hg.x, hg.z], a: [Math.sin(hg.yaw), Math.cos(hg.yaw)], len: 72, wid: 96, eave: 26, rise: 6 };
      bld.add(vaultGeo(H, y0, 1), matRoofG);
    }
    // 滑跃起飞试验台（阎良）
    for (const f of A.runways || []) {
      if (!f.p || f.p.length !== 4) continue;
      const R = runwayInfo(f);
      if (R.L > 80 || Math.hypot(R.ax - YL_C[0], R.az - YL_C[1]) > 5000) continue;
      const N = 8;
      for (let k = 0; k < N; k++) {
        const s0 = (R.L * k) / N, s1 = (R.L * (k + 1)) / N, sm = (s0 + s1) / 2;
        const hh = 6 * (sm / R.L) ** 2;
        const e = orientedBox(24, Math.max(0.3, hh), R.L / N, R.ax + R.ux * sm, hf(R.ax, R.az) + hh / 2, R.az + R.uz * sm, Math.atan2(R.ux, R.uz));
        bld.add(e.g, matConc, e.m, { worldUV: 1 });
      }
    }

    // ===== 机坪高杆灯 + 机坪边缘蓝灯 =====
    for (const f of A.aprons || []) {
      if (!f.outer) continue;
      const C = adOf(f.outer[0], f.outer[1]);
      const c = polyCentroid(f.outer);
      const cx0 = c.x ?? c[0], cz0 = c.z ?? c[1];
      const ring = [...f.outer, f.outer[0], f.outer[1]];
      const pts = resampleArr(ring, 140);
      for (const q of pts) {
        let x = q.x, z = q.z;
        const vx = cx0 - x, vz = cz0 - z, vl = Math.hypot(vx, vz) || 1;
        x += (vx / vl) * 18; z += (vz / vl) * 18;
        if (!pointInPoly(x, z, f.outer)) continue;
        const y = hf(x, z);
        const pole = new THREE.CylinderGeometry(0.28, 0.5, 30, 8); pole.translate(x, y + 15, z);
        C.detail.add(pole, matStruct);
        const head = new THREE.CylinderGeometry(2.2, 2.2, 0.9, 10); head.translate(x, y + 30.2, z);
        C.detail.add(head, matLamp);
        L.add(x, y + 29.5, z, LC.mast, 2.6);
        C.pools.push([x, y + 0.35, z, 110]);
      }
      for (const q of resampleArr(ring, 60)) {
        const fn = facades.nearest(q.x, q.z);
        if (fn && fn.d < 20) continue; // 贴着航站楼的边不设
        L.add(q.x, hf(q.x, q.z) + 0.35, q.z, LC.twyEdge, 0.32);
      }
    }
    const merge = (await import('three/addons/utils/BufferGeometryUtils.js')).mergeGeometries;
    const poolMat = (color) => {
      const pm = new THREE.MeshBasicMaterial({ map: radialTex(), color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
      ctx.overlay(pm, 0.0004);
      return pm;
    };
    const poolMesh = (list, mat) => {
      if (!list.length) return null;
      const geos = list.map(([x, y, z, s]) => { const pl = new THREE.PlaneGeometry(s, s); pl.rotateX(-Math.PI / 2); pl.translate(x, y, z); return pl; });
      const m = new THREE.Mesh(merge(geos, false), mat);
      m.renderOrder = 3;
      return m;
    };
    const matPool = poolMat(0xffe2b8), matDeckPool = poolMat(0xeef3ff);
    for (const C of AD) { const m = poolMesh(C.pools, matPool); if (m) C.group.add(m); }
    { const m = poolMesh(deckPools, matDeckPool); if (m) { m.name = '落客平台光斑'; xiyGroup.add(m); } }

    // ===== 组装静态网格 =====
    const surfG = surf.build({ name: '机场道面', castShadow: false, receiveShadow: true });
    root.add(surfG);
    for (const C of AD) {
      if (C.marks.pos.length) {
        const mg = new THREE.Mesh(C.marks.geometry(), matMark);
        mg.receiveShadow = true; mg.name = '机场标线-' + C.a.n;
        C.group.add(mg);
      }
      C.group.add(C.detail.build({ name: '廊桥与高杆灯-' + C.a.n, castShadow: true, receiveShadow: true }));
    }
    root.add(bld.build({ name: '航站楼与塔台', castShadow: true, receiveShadow: true }));
    root.add(bldNS.build({ name: '航站楼吊顶与灯具', castShadow: false, receiveShadow: true }));

    // ===== 飞机（每机型一个 InstancedMesh：停场 + 起降动态） =====
    const palette = liveryUniform();
    const OPS = [
      // 西飞行区：05L 着陆，05R 起飞；东飞行区：06R 着陆，06L 起飞（东北风运行，真方位约 48.7°）
      { rw: '05L', kind: 'arr', type: 'a320', liv: 0, t0: 150 },
      { rw: '05R', kind: 'dep', type: 'b738', liv: 1, t0: 42 },
      { rw: '06R', kind: 'arr', type: 'a359', liv: 0, t0: 110 },
      { rw: '06L', kind: 'dep', type: 'a330', liv: 2, t0: 55 },
    ];
    const meshes = {};
    const dynSlots = [];
    for (const k of types) {
      const ops = OPS.filter((o) => o.type === k);
      const n = place[k].length + ops.length;
      if (!n) continue;
      const { geometry, T } = buildAircraftGeometry(k);
      const liv = new Float32Array(n), gear = new Float32Array(n).fill(1);
      geometry.setAttribute('aLiv', new THREE.InstancedBufferAttribute(liv, 1));
      geometry.setAttribute('aGear', new THREE.InstancedBufferAttribute(gear, 1));
      const im = new THREE.InstancedMesh(geometry, aircraftMaterial(ctx, T, palette), n);
      im.name = '飞机-' + T.name;
      im.castShadow = true; im.receiveShadow = true;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
      place[k].forEach((p, i) => {
        m4.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(up, p.h), one);
        im.setMatrixAt(i, m4);
        liv[i] = p.liv;
      });
      ops.forEach((o, j) => {
        const idx = place[k].length + j;
        liv[idx] = o.liv;
        dynSlots.push({ op: o, mesh: im, idx, T, gearAttr: geometry.attributes.aGear });
      });
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceMatrix.needsUpdate = true;
      {
        const pts = place[k].map((q) => new THREE.Vector3(q.x, q.y, q.z));
        if (ops.length) pts.push(new THREE.Vector3(XIY_C[0] - 14000, 500, XIY_C[1] - 14000), new THREE.Vector3(XIY_C[0] + 14000, 3000, XIY_C[1] + 14000));
        im.boundingSphere = new THREE.Sphere().setFromPoints(pts);
        im.boundingSphere.radius += 80;
      }
      meshes[k] = im;
      root.add(im);
    }

    // ===== 起降动画 =====
    const rwEnd = (des) => {
      for (const R of RW) {
        if (!R.xiy) continue;
        if (R.dA === des) return { x: R.ax, z: R.az, ux: R.ux, uz: R.uz, L: R.L, rx: R.rx, rz: R.rz };
        if (R.dB === des) return { x: R.bx, z: R.bz, ux: -R.ux, uz: -R.uz, L: R.L, rx: -R.rx, rz: -R.rz };
      }
      return null;
    };
    const DL = new LightList();
    const slotLights = [];
    for (const s of dynSlots) {
      s.end = rwEnd(s.op.rw);
      s.y0 = s.end ? hf(s.end.x, s.end.z) : 0;
      s.st = { t: s.op.t0 };
      s.lights = aircraftLightOffsets(s.T);
      s.l0 = DL.count;
      for (const [, , , ty] of s.lights) {
        const col = [LC.red, LC.green, LC.white, LC.red, LC.strobe, LC.land][ty];
        const size = [0.9, 0.9, 0.7, 1.1, 1.3, 2.4][ty];
        const mode = ty === 3 ? 3 : ty === 4 ? 4 : 5;
        DL.add(0, -9999, 0, col, size, mode, ty === 3 ? Math.random() : ty === 4 ? 0.37 : 0);
      }
      s.pl = ctx.lights.add({ position: new THREE.Vector3(0, -9999, 0), color: 0xfff4e0, intensity: 2500, distance: 220, priority: 3 });
      slotLights.push(s);
    }
    const dynPts = lightPoints(ctx, DL, { dayVisible: 0.55, fade: [9000, 16000] }); // 飞机灯稀疏，比助航灯晚衰减
    dynPts.name = '飞机灯光';
    root.add(dynPts);
    const staticPts = lightPoints(ctx, L);
    staticPts.name = '助航灯光';
    root.add(staticPts);

    const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(0, 0, 0, 'YXZ'), tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3(1, 1, 1), tmpL = new THREE.Vector3();
    const hideM = new THREE.Matrix4().makeScale(0, 0, 0);
    const G3 = Math.tan((3 * Math.PI) / 180);
    function pose(s) {
      // 返回 {s(沿跑道), lat, h(离地), yawOff, pitch, roll, gear, vis}
      const t = s.st.t % (s.op.kind === 'arr' ? 250 : 165);
      if (s.op.kind === 'arr') {
        const vA = 72, sTd = 420, flareH = 14;
        const tTd = 175; // 接地时刻（从 -12 km 起算）
        const sAt = (tt) => (tt < tTd ? sTd - vA * (tTd - tt) : null);
        if (t < tTd) {
          const sp = sAt(t);
          let hh = Math.max(0, (sTd - 60 - sp) * G3);
          let pitch = 2.6;
          if (hh < flareH) { const k = hh / flareH; hh = flareH * k * k * 0.9 + 0.1 * flareH * k; pitch = 2.6 + (1 - k) * 3.2; }
          return { s: sp, lat: 0, h: hh, yawOff: 0, pitch, roll: 0, gear: 1, vis: 1, land: 1 };
        }
        const tr = t - tTd;
        const dec = 2.3, v1 = 14;
        const tb = (vA - v1) / dec;
        let sp, pitch = 0;
        if (tr < tb) { sp = sTd + vA * tr - 0.5 * dec * tr * tr; pitch = Math.max(0, 5.8 - tr * 1.6); }
        else sp = sTd + vA * tb - 0.5 * dec * tb * tb + v1 * (tr - tb);
        // 快速脱离：沿 30° 转出
        const sExit = sTd + vA * tb - 0.5 * dec * tb * tb + 250;
        let lat = 0, yawOff = 0;
        if (sp > sExit) { const d = sp - sExit; yawOff = Math.min(1, d / 60) * 0.52; lat = d * Math.sin(yawOff) * 0.9; sp = sExit + d * Math.cos(yawOff); }
        const vis = sp - sExit < 450 ? 1 : 0;
        return { s: sp, lat, h: 0, yawOff, pitch, roll: 0, gear: 1, vis, land: 1 };
      }
      // 起飞
      const hold = 10, acc = 2.1, vr = 76;
      if (t < hold) return { s: 40, lat: 0, h: 0, yawOff: 0, pitch: 0, roll: 0, gear: 1, vis: 1, land: 1 };
      const ta = t - hold, tr = vr / acc;
      const sR = 40 + 0.5 * acc * tr * tr;
      if (ta < tr) return { s: 40 + 0.5 * acc * ta * ta, lat: 0, h: 0, yawOff: 0, pitch: 0, roll: 0, gear: 1, vis: 1, land: 1 };
      const tc = ta - tr;
      const v = vr + Math.min(20, tc * 1.2);
      const rot = Math.min(1, tc / 3.5);
      const tlo = 3.5;
      let hh = 0, sp = sR + vr * tc;
      if (tc > tlo) hh = (tc - tlo) * v * Math.sin((8 * Math.PI) / 180) * Math.min(1, (tc - tlo) / 4);
      const pitch = rot * 13;
      const gear = tc > tlo + 6 ? 0 : 1;
      // 离场转弯：高度 350 m 以上右转
      let yawOff = 0, lat = 0, roll = 0;
      const tTurn = tlo + 350 / (v * Math.sin((8 * Math.PI) / 180));
      if (tc > tTurn) {
        const tt = tc - tTurn, rate = (2.2 * Math.PI) / 180;
        yawOff = -Math.min(tt * rate, 1.2);
        roll = Math.min(1, tt / 4) * 22 * (yawOff > -1.19 ? 1 : 0.2);
        const s0 = sR + vr * tTurn;
        const Rr = v / rate;
        const ang = Math.min(tt * rate, 1.2);
        const extra = Math.max(0, tt - 1.2 / rate) * v;
        sp = s0 + Rr * Math.sin(ang) + extra * Math.cos(1.2);
        lat = -(Rr * (1 - Math.cos(ang)) + extra * Math.sin(1.2));
      }
      return { s: sp, lat, h: hh, yawOff, pitch, roll, gear, vis: hh < 2600 ? 1 : 0, land: hh < 3000 ? 1 : 0 };
    }
    let trafficOn = true;
    function stepOps(dt) {
      const pa = dynPts.geometry.attributes.position;
      for (const s of slotLights) {
        s.st.t += dt;
        const E = s.end;
        if (!E) { s.mesh.setMatrixAt(s.idx, hideM); continue; }
        const P = pose(s);
        const vis = P.vis && trafficOn;
        if (!vis) {
          s.mesh.setMatrixAt(s.idx, hideM);
          for (let k = 0; k < s.lights.length; k++) pa.setXYZ(s.l0 + k, 0, -9999, 0);
          s.pl.position.set(0, -9999, 0);
        } else {
          const cy = Math.cos(P.yawOff), sy = Math.sin(P.yawOff);
          const dx = E.ux * cy + E.rx * sy, dz = E.uz * cy + E.rz * sy;
          const x = E.x + E.ux * P.s + E.rx * P.lat, z = E.z + E.uz * P.s + E.rz * P.lat;
          const g = P.h > 30 ? s.y0 : hf(x, z);
          tmpV.set(x, Math.max(g, s.y0) + P.h + 0.26, z);
          tmpE.set((-P.pitch * Math.PI) / 180, Math.atan2(dx, dz), (P.roll * Math.PI) / 180);
          tmpQ.setFromEuler(tmpE);
          tmpM.compose(tmpV, tmpQ, tmpS);
          s.mesh.setMatrixAt(s.idx, tmpM);
          s.gearAttr.array[s.idx] = P.gear;
          s.gearAttr.needsUpdate = true;
          s.lights.forEach(([lx, ly, lz, ty], k) => {
            if (ty === 5 && !P.land) { pa.setXYZ(s.l0 + k, 0, -9999, 0); return; }
            tmpL.set(lx, ly, lz).applyMatrix4(tmpM);
            pa.setXYZ(s.l0 + k, tmpL.x, tmpL.y, tmpL.z);
          });
          s.pl.position.set(x + dx * 45, tmpV.y + 6 - Math.min(P.h, 0), z + dz * 45);
          if (P.h > 120) s.pl.position.y = -9999;
        }
        s.mesh.instanceMatrix.needsUpdate = true;
      }
      pa.needsUpdate = true;
    }
    stepOps(0);

    // ===== 其它机场标注 =====
    const lab = (text, x, z, agl, opt = {}) => ctx.labels.add(text, new THREE.Vector3(x, hf(x, z) + agl, z), { category: 'landmark', ...opt });
    lab('西安咸阳国际机场', HALLS[1].c[0], HALLS[1].c[1], 90, { priority: 3 });
    lab('T5航站楼', HALLS[0].c[0], HALLS[0].c[1], 70, { priority: 2, maxDist: 12000 });
    lab('阎良机场（中国飞行试验研究院）', YL_C[0], YL_C[1], 60, { priority: 2 });
    { const p = ctx.geo.project(108.8995, 34.2555); lab('西关机场旧址（1991年停用）', p.x, p.z, 40, { priority: 1, maxDist: 9000 }); }

    // ===== 每帧 =====
    let lodT = 0;
    return {
      update(dt) {
        const d = Math.min(0.1, Math.max(0, dt || 0));
        const cam = ctx.camera.position;
        const hpx = ctx.renderer.domElement.height || 720;
        const sc = hpx / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));
        staticPts.material.uniforms.uScale.value = sc;
        dynPts.material.uniforms.uScale.value = sc;
        const nt = ctx.uniforms.uNight.value;
        matPool.opacity = nt * 0.32;
        matDeckPool.opacity = nt * 0.3;
        if ((lodT -= d) <= 0) {
          lodT = 0.25;
          for (const C of AD) C.group.visible = Math.hypot(cam.x - C.cx, cam.z - C.cz) < C.rad + 16000 + cam.y * 2;
          for (const im of Object.values(meshes)) {
            const bs = im.boundingSphere;
            im.visible = Math.hypot(cam.x - bs.center.x, cam.z - bs.center.z) < bs.radius + 20000 + cam.y * 2;
          }
        }
        stepOps(d);
      },
      setLayer(name, on) {
        if (name === 'traffic') trafficOn = on;
      },
      setQuality() {},
    };
  },
};

// ---------- 辅助 ----------
function resampleArr(p, step) {
  const out = [];
  let acc = 0;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1];
    const l = Math.hypot(bx - ax, bz - az);
    if (l < 1e-6) continue;
    const dx = (bx - ax) / l, dz = (bz - az) / l;
    let t = acc ? step - acc : 0;
    while (t <= l) { out.push({ x: ax + dx * t, z: az + dz * t, dx, dz }); t += step; }
    acc = l - (t - step);
    acc = acc >= step ? 0 : acc;
  }
  return out;
}
function ribbonUV(p, w, hf, lift) {
  const pts = resampleArr(p, 12);
  const n = p.length;
  if (pts.length < 1) return null;
  const last = { x: p[n - 2], z: p[n - 1], dx: pts[pts.length - 1].dx, dz: pts[pts.length - 1].dz };
  if (Math.hypot(last.x - pts[pts.length - 1].x, last.z - pts[pts.length - 1].z) > 0.3) pts.push(last);
  if (pts.length < 2) return null;
  const pos = [], uv = [], idx = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    if (i) s += Math.hypot(a.x - pts[i - 1].x, a.z - pts[i - 1].z);
    let dx = a.dx, dz = a.dz;
    if (i > 0) { dx += pts[i - 1].dx; dz += pts[i - 1].dz; }
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const nx = -dz * w / 2, nz = dx * w / 2;
    pos.push(a.x + nx, hf(a.x + nx, a.z + nz) + lift, a.z + nz, a.x - nx, hf(a.x - nx, a.z - nz) + lift, a.z - nz);
    uv.push(0, s, w, s);
    if (i) { const b = (i - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (g.attributes.normal.getY(0) < 0) { g.index.array.reverse(); g.computeVertexNormals(); }
  return g;
}
function nearestTaxi(taxis, x, z) {
  let best = null;
  for (const t of taxis) {
    const p = t.p;
    for (let i = 2; i < p.length; i += 2) {
      const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const k = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(ax + dx * k - x, az + dz * k - z);
      if (!best || d < best.d) { const l = Math.sqrt(l2); best = { d, dir: [dx / l, dz / l], w: t.w }; }
    }
  }
  return best && best.d < 40 ? best : null;
}
/** 点到折线的最近距离 */
function distToLine(p, x, z) {
  let best = Infinity;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az, l2 = dx * dx + dz * dz || 1;
    const k = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(ax + dx * k - x, az + dz * k - z));
  }
  return best;
}
function distToRunway(R, x, z) {
  const s = Math.max(0, Math.min(R.L, (x - R.ax) * R.ux + (z - R.az) * R.uz));
  return Math.hypot(R.ax + R.ux * s - x, R.az + R.uz * s - z);
}
