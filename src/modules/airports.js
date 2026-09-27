// 西安咸阳国际机场（XIY/ZLXY）与西安其它机场。
// 资料（2026-09 核对）：
//  · 跑道：OSM + Esri 影像核对，四条平行跑道（真方位约 48.7°）：西飞行区 05L/23R 3800×45、05R/23L 3000×45；
//    东飞行区（三期扩建）06L/24R 3800×60（4F）、06R/24L 3000×45。原北跑道已改为平行滑行道。
//  · T5 航站楼 2025-02-20 投运，“主楼 + 六指廊”，建筑面积 70.55 万㎡，陆侧屋面有红色“西安”书法大字；
//    T1（停用）/T2/T3 位于西航站区，T3 主楼为白色拱形肋屋面，东侧高架落客平台。
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
// 主楼大跨屋盖（中心、长轴方向、长、宽、檐口高、拱高、屋面色）——按 Esri 影像量取
const HALLS = [
  { n: 'T5', c: [-15119, -21512], a: [0.7, 0.714], len: 540, wid: 235, eave: 30, rise: 9, roof: 'grey', sky: 1, over: 14 },
  { n: 'T3', c: [-17148, -19637], a: [0.646, 0.761], len: 350, wid: 112, eave: 24, rise: 12, roof: 'white', ribs: 1, over: 8 },
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
function curtainMaterial(ctx) {
  // 纹理表示 6 m × 6 m：竖梃 1.5 m、横档 3 m，底部 0.6 m 深色勒脚
  const r = rng(11);
  const map = canvasTex(256, 256, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#5f7682'); gr.addColorStop(1, '#3c4d58');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#c9ced2';
    for (let x = 0; x < 256; x += 64) g.fillRect(x, 0, 4, 256);
    for (let y = 0; y < 256; y += 128) g.fillRect(0, y, 256, 5);
  }, { repeat: [1 / 6, 1 / 6] });
  const em = canvasTex(256, 256, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 64) for (let y = 0; y < 256; y += 128) {
      const k = 0.55 + r() * 0.45;
      g.fillStyle = `rgb(${255 * k | 0},${205 * k | 0},${140 * k | 0})`;
      g.fillRect(x + 4, y + 5, 60, 123);
    }
    g.fillStyle = 'rgba(255,240,210,0.9)';
    for (let x = 0; x < 256; x += 64) g.fillRect(x + 4, 118, 60, 6);
  }, { repeat: [1 / 6, 1 / 6] });
  const m = new THREE.MeshStandardMaterial({ map, emissiveMap: em, emissive: 0xffd6a0, emissiveIntensity: 0, metalness: 0.55, roughness: 0.14, envMapIntensity: 1.3 });
  ctx.night.register(m, { day: 0.0, night: 1.35 });
  return m;
}
function roofMaterial(color, seam) {
  const map = canvasTex(256, 256, (g) => {
    g.fillStyle = color; g.fillRect(0, 0, 256, 256);
    const r = rng(5);
    for (let i = 0; i < 600; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.04})`; g.fillRect(r() * 256, r() * 256, 6, 6); }
    g.fillStyle = seam;
    for (let x = 0; x < 256; x += 16) g.fillRect(x, 0, 2, 256);
  }, { repeat: [1 / 8, 1 / 8] });
  return new THREE.MeshStandardMaterial({ map, metalness: 0.55, roughness: 0.42 });
}
function radialTex() {
  return canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  }, { srgb: false });
}

// ---------- 几何工具 ----------
function flatPoly(outer, hf, lift) {
  const g = new THREE.ShapeGeometry(toShape(outer), 1);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, hf(p.getX(i), p.getZ(i)) + lift);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i), p.getZ(i));
  g.computeVertexNormals();
  return g;
}
/** 多边形竖直墙面：UV = (周长米, 高度米) */
function polyWalls(outer, y0, y1) {
  const pos = [], uv = [];
  const n = outer.length / 2;
  // 统一为逆时针（俯视 X 东 Z 南下 shoelace>0）以使法线朝外
  let a = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += outer[i * 2] * outer[j * 2 + 1] - outer[j * 2] * outer[i * 2 + 1]; }
  let s = 0;
  for (let k = 0; k < n; k++) {
    const i = a > 0 ? k : n - 1 - k, j = a > 0 ? (k + 1) % n : (n - 2 - k + n) % n;
    const x0 = outer[i * 2], z0 = outer[i * 2 + 1], x1 = outer[j * 2], z1 = outer[j * 2 + 1];
    const l = Math.hypot(x1 - x0, z1 - z0);
    if (l < 0.05) continue;
    pos.push(x0, y0, z0, x1, y1, z1, x1, y0, z1, x0, y0, z0, x0, y1, z0, x1, y1, z1);
    uv.push(s, y0, s + l, y1, s + l, y0, s, y0, s, y1, s + l, y1);
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
    const y = y0 + H.eave + H.rise * (1 - t * t) - (Math.abs(t) > 0.999 ? 0 : 0);
    const x = H.c[0] + bx * u + ax * v, z = H.c[1] + bz * u + az * v;
    p.setXYZ(i, x, y, z);
    uv.setXY(i, u, v);
  }
  g.computeVertexNormals();
  // 让法线朝上
  if (g.attributes.normal.getY(0) < 0) { g.index.array.reverse(); g.computeVertexNormals(); }
  return g;
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
    const xiyGroup = new THREE.Group(); // 近景细节（标线/廊桥/飞机）按距离显隐
    const ylGroup = new THREE.Group();
    root.add(xiyGroup, ylGroup);

    // ===== 材质 =====
    const matApron = ctx.mats.clone('concrete', { color: 0xb9b6ae, roughness: 0.88 });
    const matTaxi = ctx.mats.clone('asphalt', { color: 0x6d6c68, roughness: 0.9 });
    const matRwy = ctx.mats.clone('asphalt', { color: 0x5a5a58, roughness: 0.88, vertexColors: true });
    ctx.overlay(matApron, 0.00012); ctx.overlay(matTaxi, 0.0002); ctx.overlay(matRwy, 0.00026);
    const atlas = markingAtlas();
    const matMark = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, alphaTest: 0.45, roughness: 0.75 });
    ctx.overlay(matMark, 0.00034);
    const matGlass = curtainMaterial(ctx);
    const matRoofW = roofMaterial('#d9dcdf', '#b9bdc1');
    const matRoofG = roofMaterial('#9aa2a8', '#838b91');
    const matStruct = new THREE.MeshStandardMaterial({ color: 0xd4d7da, metalness: 0.45, roughness: 0.45 });
    const matDark = new THREE.MeshStandardMaterial({ color: 0x3a3f44, metalness: 0.5, roughness: 0.5 });
    const matConc = ctx.mats.get('concrete');
    const matTowerGlass = new THREE.MeshPhysicalMaterial({ color: 0x2f6f96, metalness: 0.7, roughness: 0.08, envMapIntensity: 1.5, emissive: 0x6fb7e0, emissiveIntensity: 0 });
    ctx.night.register(matTowerGlass, { day: 0, night: 0.9 });
    const matCab = new THREE.MeshStandardMaterial({ color: 0x1d3038, metalness: 0.6, roughness: 0.1, emissive: 0x9fffd8, emissiveIntensity: 0 });
    ctx.night.register(matCab, { day: 0, night: 1.4 });
    const matLamp = ctx.mats.get('lampWhite');

    const surf = new Batcher();
    const bld = new Batcher();
    const detail = new Batcher();
    const marks = new TriSink();
    const rwySink = new TriSink();
    const L = new LightList();
    const r = rng(20260925);

    // ===== 道面 =====
    for (const f of A.aprons || []) {
      if (!f.outer || f.outer.length < 6) continue;
      surf.add(flatPoly(f.outer, hf, 0.1), matApron);
    }
    const taxis = [];
    for (const f of A.taxiways || []) {
      if (!f.p || f.p.length < 4) continue;
      const w = Math.max(10, Math.min(f.w || 23, 30));
      taxis.push({ p: f.p, w });
      const pts = offsetLine(f.p, 0);
      const g = ribbonUV(pts, w, hf, 0.16);
      if (g) surf.add(g, matTaxi);
      // 黄色中线（0.3 m，略加宽以便远看）与边线
      markLine(marks, hf, f.p, 0.3, YELLOW, { step: 10, lift: 0.22 });
      let len = 0;
      for (let i = 2; i < f.p.length; i += 2) len += Math.hypot(f.p[i] - f.p[i - 2], f.p[i + 1] - f.p[i - 1]);
      if (len > 180) for (const sd of [-1, 1]) {
        markLine(marks, hf, offsetLine(f.p, sd * (w / 2 - 0.6)), 0.15, YELLOW, { step: 10, trim: 45, lift: 0.22 });
        markLine(marks, hf, offsetLine(f.p, sd * (w / 2 - 0.95)), 0.15, YELLOW, { step: 10, trim: 45, lift: 0.22 });
      }
      // 滑行道灯：绿色中线灯 30 m、蓝色边灯 45 m
      const pp = resampleArr(f.p, 30);
      for (let i = 1; i < pp.length - 1; i++) { const q = pp[i]; L.add(q.x, hf(q.x, q.z) + 0.25, q.z, LC.green, 0.32); }
      if (len > 120) {
        const pe = resampleArr(f.p, 45);
        for (let i = 1; i < pe.length - 1; i++) {
          const q = pe[i];
          for (const sd of [-1, 1]) { const x = q.x - q.dz * sd * (w / 2 + 1), z = q.z + q.dx * sd * (w / 2 + 1); L.add(x, hf(x, z) + 0.35, z, LC.blue, 0.45); }
        }
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
      runwayMarkings(marks, hf, R, { big });
      runwayLights(L, hf, R, { approach: R.xiy, center: big });
    }
    surf.add(rwySink.geometry(), matRwy);

    // 跑道等待位置标志（A 型：两实两虚）+ 停止排灯（红）+ 跑道警戒灯（黄闪）
    for (let i = 0; i < HOLDS.length; i += 2) {
      const hx = HOLDS[i], hz = HOLDS[i + 1];
      const t = nearestTaxi(taxis, hx, hz);
      if (!t) continue;
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
        markRect(marks, hf, hx + dx * off, hz + dz * off, -dz, dx, w, 0.28, YELLOW, k < 2 ? undefined : [64 / 1024, 16 / 128, 128 / 1024, 48 / 128], 0.24);
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
      markLine(marks, hf, p, 0.2, YELLOW, { step: 8, lift: 0.2 });
      const n = p.length;
      const dx = p[n - 2] - p[n - 4], dz = p[n - 1] - p[n - 3], l = Math.hypot(dx, dz) || 1;
      markRect(marks, hf, p[n - 2], p[n - 1], dx / l, dz / l, 0.35, 5, YELLOW, undefined, 0.2);
    }

    // 风向标（橙白相间锥袋）
    for (let i = 0; i < WINDSOCKS.length; i += 2) {
      const x = WINDSOCKS[i], z = WINDSOCKS[i + 1], y = hf(x, z);
      const pole = new THREE.CylinderGeometry(0.08, 0.1, 6, 6); pole.translate(x, y + 3, z);
      detail.add(pole, matStruct);
      const sock = new THREE.CylinderGeometry(0.45, 0.2, 3.6, 10, 1, true); sock.rotateZ(Math.PI / 2 - 0.25); sock.rotateY(0.8); sock.translate(x + 1.4, y + 5.6, z - 1.2);
      detail.add(sock, ctx.mats.get('lanternRed'));
      L.add(x, y + 6.3, z, LC.red, 0.6);
    }

    // ===== 航站楼 =====
    const termByName = {};
    for (const t of A.terminals || []) {
      const h = TERM_H[t.n];
      if (!h || !t.outer) continue;
      termByName[t.n] = t;
      const c = polyCentroid(t.outer);
      const y0 = hf(c.x ?? c[0], c.z ?? c[1]);
      bld.add(polyWalls(t.outer, y0, y0 + h), matGlass);
      bld.add(polyWalls(t.outer, y0 + h, y0 + h + 1.8), matStruct);
      const roof = flatPoly(t.outer, () => y0 + h + 1.8, 0);
      bld.add(roof, t.n === '5号航站楼' ? matRoofG : matRoofW);
      // 屋顶设备与天窗条（沿长边）
    }
    const hallInfo = {};
    for (const H of HALLS) {
      const y0 = hf(H.c[0], H.c[1]);
      const ax = H.a[0], az = H.a[1], bx = az, bz = -ax;
      const yaw = Math.atan2(ax, az);
      hallInfo[H.n] = { y0, ax, az, bx, bz };
      // 主楼玻璃幕墙体
      const hb = new THREE.BoxGeometry(H.wid, H.eave, H.len);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(H.c[0], y0 + H.eave / 2, H.c[1]), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
      bld.add(hb, matGlass, m, { worldUV: 1 });
      // 屋面（拱）+ 檐口封边
      bld.add(vaultGeo(H, y0, H.over), H.roof === 'white' ? matRoofW : matRoofG);
      const under = vaultGeo(H, y0 - 1.6, H.over);
      under.index.array.reverse(); under.computeVertexNormals();
      bld.add(under, matStruct);
      for (const sd of [-1, 1]) {
        const e = orientedBox(1.2, 1.8, H.len + H.over * 2, H.c[0] + bx * sd * (H.wid / 2 + H.over), y0 + H.eave - 0.8, H.c[1] + bz * sd * (H.wid / 2 + H.over), yaw);
        bld.add(e.g, matStruct, e.m);
      }
      // 山墙玻璃（拱下三角区）
      for (const sd of [-1, 1]) {
        const g = new THREE.BufferGeometry();
        const pos = [];
        const N = 16;
        for (let k = 0; k < N; k++) {
          const u0 = -H.wid / 2 + (H.wid * k) / N, u1 = -H.wid / 2 + (H.wid * (k + 1)) / N;
          const y = (u) => y0 + H.eave + H.rise * (1 - ((2 * u) / (H.wid + 2 * H.over)) ** 2) - 1.6;
          const P = (u, yy) => [H.c[0] + bx * u + ax * sd * H.len / 2, yy, H.c[1] + bz * u + az * sd * H.len / 2];
          pos.push(...P(u0, y0 + H.eave), ...P(u1, y0 + H.eave), ...P(u1, y(u1)), ...P(u0, y0 + H.eave), ...P(u1, y(u1)), ...P(u0, y(u0)));
        }
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        const g2 = g.clone(); { const a = g2.attributes.position.array; for (let i = 0; i < a.length; i += 9) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; } g2.computeVertexNormals(); }
        bld.add(g, matGlass, null, { worldUV: 1 }); bld.add(g2, matGlass, null, { worldUV: 1 });
      }
      // 屋面肋 / 天窗
      if (H.ribs) {
        for (let v = -H.len / 2 + 15; v < H.len / 2; v += 28) {
          const N = 14, W = H.wid + 2 * H.over;
          for (let k = 0; k < N; k++) {
            const u0 = -W / 2 + (W * k) / N, u1 = -W / 2 + (W * (k + 1)) / N;
            const y = (u) => y0 + H.eave + H.rise * (1 - ((2 * u) / W) ** 2) + 0.5;
            const um = (u0 + u1) / 2, len = Math.hypot(u1 - u0, y(u1) - y(u0));
            const e = orientedBox(1.4, 1.0, len + 0.3, H.c[0] + bx * um + ax * v, y(um), H.c[1] + bz * um + az * v, Math.atan2(bx, bz), -Math.atan2(y(u1) - y(u0), u1 - u0));
            bld.add(e.g, matStruct, e.m);
          }
        }
      }
      if (H.sky) {
        const e = orientedBox(14, 1.2, H.len * 0.8, H.c[0], y0 + H.eave + H.rise + 0.3, H.c[1], yaw);
        bld.add(e.g, matGlass, e.m, { worldUV: 1 });
        for (const sd of [-1, 1]) {
          const e2 = orientedBox(4, 0.8, H.len * 0.7, H.c[0] + bx * sd * H.wid * 0.3, y0 + H.eave + H.rise * 0.64 + 0.3, H.c[1] + bz * sd * H.wid * 0.3, yaw);
          bld.add(e2.g, matGlass, e2.m, { worldUV: 1 });
        }
      }
      // 陆侧高架落客平台 + 雨棚柱
      const off = H.wid / 2 + 26, dl = H.len * 0.86, dw = 24, dy = y0 + 9;
      const cx = H.c[0] + bx * off, cz = H.c[1] + bz * off;
      const deck = orientedBox(dw, 1.6, dl, cx, dy, cz, yaw);
      bld.add(deck.g, matConc, deck.m, { worldUV: 1 });
      for (let v = -dl / 2 + 10; v <= dl / 2 - 10; v += 30) {
        const col = new THREE.CylinderGeometry(0.9, 0.9, 9, 10);
        col.translate(cx + ax * v, y0 + 4.5, cz + az * v);
        bld.add(col, matConc);
        const pole = new THREE.CylinderGeometry(0.35, 0.45, H.eave - 9, 8);
        pole.translate(H.c[0] + bx * (H.wid / 2 + H.over - 3) + ax * v, dy + (H.eave - 9) / 2, H.c[1] + bz * (H.wid / 2 + H.over - 3) + az * v);
        bld.add(pole, matStruct);
        L.add(cx + ax * v - bx * 8, dy + 7, cz + az * v - bz * 8, LC.mast, 1.2);
      }
      for (const sd of [-1, 1]) {
        const rail = orientedBox(0.3, 1.1, dl, cx + bx * sd * (dw / 2 - 0.2), dy + 1.3, cz + bz * sd * (dw / 2 - 0.2), yaw);
        bld.add(rail.g, matStruct, rail.m);
      }
      // 招牌
      if (H.n === 'T3') {
        const s = ctx.sign('西安咸阳国际机场', { height: 7.5, color: '#ffffff', emissive: 2.6, weight: 800 });
        const d = H.wid / 2 + H.over + 0.9;
        s.position.set(H.c[0] + bx * d, y0 + H.eave + 1.5, H.c[1] + bz * d);
        s.rotation.y = Math.atan2(bx, bz);
        xiyGroup.add(s);
      } else {
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

    // ===== 廊桥 + 停机位飞机 =====
    const types = ['a320', 'b738', 'a330', 'b789', 'a359', 'y20', 'ma60'];
    const place = Object.fromEntries(types.map((k) => [k, []]));
    const bridgeDoorH = { a320: 3.5, b738: 3.3, a330: 5.0, b789: 5.2, a359: 5.4 };
    for (let i = 0; i < STANDS.length; i += 5) {
      const [sx, sz, h, cls, hit] = STANDS.slice(i, i + 5);
      const contact = hit > 0;
      if (r() > (contact ? 0.86 : 0.7)) continue;
      let type;
      if (cls === 0) type = r() < 0.58 ? 'a320' : 'b738';
      else if (cls === 1) type = r() < 0.5 ? 'a330' : 'b789';
      else type = ['a359', 'b789', 'a330'][Math.floor(r() * 3)];
      const T = TYPES[type];
      const dx = Math.sin(h), dz = Math.cos(h);
      const gx = sx - dx * T.wb, gz = sz - dz * T.wb;
      place[type].push({ x: gx, z: gz, y: hf(gx, gz) + 0.12, h, liv: pickW(r, XIY_MIX) });
      if (contact && hit < 60) {
        // 廊桥：航站楼立面固定端 → 旋转台 → 伸缩通道 → 接机口（左侧 L1 门）
        const lx = dz, lz = -dx; // 左侧
        const noseD = 5;
        const doorX = sx + dx * (noseD - T.doorF) + lx * (T.R + 1.6), doorZ = sz + dz * (noseD - T.doorF) + lz * (T.R + 1.6);
        const fx = sx + dx * hit, fz = sz + dz * hit;
        const rx = fx - dx * 7 + lx * (T.R + 9), rz = fz - dz * 7 + lz * (T.R + 9);
        const yG = hf(rx, rz), yF = yG + bridgeDoorH[type];
        const fixedLen = Math.hypot(fx - rx, fz - rz);
        {
          const e = orientedBox(3.4, 3.2, fixedLen, (fx + rx) / 2, yF + 1.6, (fz + rz) / 2, Math.atan2(fx - rx, fz - rz));
          detail.add(e.g, matStruct, e.m);
        }
        const rot = new THREE.CylinderGeometry(2.2, 2.2, 4.2, 12); rot.translate(rx, yF + 1.6, rz); detail.add(rot, matStruct);
        const col = new THREE.CylinderGeometry(0.7, 0.8, yF, 8); col.translate(rx, yG + yF / 2 - yG / 2 * 0 - 0, rz); col.translate(0, 0, 0);
        detail.add(col, matDark);
        const bl = Math.hypot(doorX - rx, doorZ - rz);
        const yaw = Math.atan2(doorX - rx, doorZ - rz);
        const ux = (doorX - rx) / bl, uz = (doorZ - rz) / bl;
        const tunnel = (a, b, w, hh) => {
          const cxm = rx + ux * (a + b) / 2, czm = rz + uz * (a + b) / 2;
          const e = orientedBox(w, hh, b - a, cxm, yF + hh / 2, czm, yaw);
          detail.add(e.g, matStruct, e.m);
          const wnd = orientedBox(w + 0.06, hh * 0.28, (b - a) * 0.92, cxm, yF + hh * 0.62, czm, yaw);
          detail.add(wnd.g, matGlass, wnd.m, { worldUV: 1 });
        };
        tunnel(2, bl * 0.55, 3.2, 3.1);
        tunnel(bl * 0.53, bl - 2.5, 2.8, 2.8);
        const cab = orientedBox(3.8, 3.4, 3.2, doorX - ux * 1.5, yF + 1.7, doorZ - uz * 1.5, yaw);
        detail.add(cab.g, matDark, cab.m);
        const legX = rx + ux * bl * 0.62, legZ = rz + uz * bl * 0.62;
        for (const sd of [-1, 1]) {
          const leg = new THREE.CylinderGeometry(0.25, 0.25, yF, 6); leg.translate(legX + uz * sd * 1.2, yG + yF / 2, legZ - ux * sd * 1.2); detail.add(leg, matDark);
        }
        const bog = orientedBox(3.6, 0.9, 1.6, legX, yG + 0.45, legZ, yaw + Math.PI / 2);
        detail.add(bog.g, matDark, bog.m);
      }
    }
    // 阎良：试飞院机坪停放运-20、新舟 60、试飞涂装窄体机
    const ylApron = (A.aprons || []).find((f) => f.outer && pointInPoly(f.outer[0], f.outer[1], (A.aerodromes || []).find((a) => /阎良/.test(a.n))?.outer || []));
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
      const H = { c: [hg.x, hg.z], a: [Math.sin(hg.yaw + Math.PI / 2), Math.cos(hg.yaw + Math.PI / 2)], len: 96, wid: 72, eave: 26, rise: 6 };
      H.a = [Math.sin(hg.yaw), Math.cos(hg.yaw)];
      H.len = 72; H.wid = 96;
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

    // ===== 机坪高杆灯 =====
    const poolGeo = [];
    for (const f of A.aprons || []) {
      if (!f.outer) continue;
      const c = polyCentroid(f.outer);
      const cx0 = c.x ?? c[0], cz0 = c.z ?? c[1];
      const pts = resampleArr([...f.outer, f.outer[0], f.outer[1]], 140);
      for (const q of pts) {
        let x = q.x, z = q.z;
        const vx = cx0 - x, vz = cz0 - z, vl = Math.hypot(vx, vz) || 1;
        x += (vx / vl) * 18; z += (vz / vl) * 18;
        if (!pointInPoly(x, z, f.outer)) continue;
        const y = hf(x, z);
        const pole = new THREE.CylinderGeometry(0.28, 0.5, 30, 8); pole.translate(x, y + 15, z);
        detail.add(pole, matStruct);
        const head = new THREE.CylinderGeometry(2.2, 2.2, 0.9, 10); head.translate(x, y + 30.2, z);
        detail.add(head, matLamp);
        L.add(x, y + 29.5, z, LC.mast, 2.6);
        const pl = new THREE.PlaneGeometry(110, 110); pl.rotateX(-Math.PI / 2); pl.translate(x, y + 0.35, z);
        poolGeo.push(pl);
      }
    }
    let poolMesh = null;
    if (poolGeo.length) {
      const pg = new THREE.BufferGeometry();
      const merged = (await import('three/addons/utils/BufferGeometryUtils.js')).mergeGeometries(poolGeo, false);
      pg.copy(merged);
      const pm = new THREE.MeshBasicMaterial({ map: radialTex(), color: 0xffe2b8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
      ctx.overlay(pm, 0.0004);
      poolMesh = new THREE.Mesh(pg, pm);
      poolMesh.renderOrder = 3;
      xiyGroup.add(poolMesh);
    }

    // ===== 组装静态网格 =====
    const surfG = surf.build({ name: '机场道面', castShadow: false, receiveShadow: true });
    root.add(surfG);
    const mg = new THREE.Mesh(marks.geometry(), matMark);
    mg.receiveShadow = true; mg.name = '机场标线';
    xiyGroup.add(mg);
    root.add(bld.build({ name: '航站楼与塔台', castShadow: true, receiveShadow: true }));
    xiyGroup.add(detail.build({ name: '廊桥与高杆灯', castShadow: true, receiveShadow: true }));

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
    const dynPts = lightPoints(ctx, DL, { dayVisible: 0.55 });
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
      const E = s.end;
      if (s.op.kind === 'arr') {
        const vA = 72, sTd = 420, flareH = 14;
        const tTd = 175; // 接地时刻（从 -12 km 起算）
        const sAt = (tt) => (tt < tTd ? sTd - vA * (tTd - tt) : null);
        if (t < tTd) {
          const sp = sAt(t);
          let hh = Math.max(0, (sTd - 60 - sp) * G3) ;
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
          s.pl.position.set(x + dx * 45, tmpV.y + 6 - Math.min(P.h, 0) , z + dz * 45);
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
    const tmpC = new THREE.Vector3();
    let lodT = 0;
    return {
      update(dt) {
        const d = Math.min(0.1, Math.max(0, dt || 0));
        const cam = ctx.camera.position;
        const hpx = ctx.renderer.domElement.height || 720;
        const sc = hpx / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));
        staticPts.material.uniforms.uScale.value = sc;
        dynPts.material.uniforms.uScale.value = sc;
        if (poolMesh) poolMesh.material.opacity = ctx.uniforms.uNight.value * 0.32;
        if ((lodT -= d) <= 0) {
          lodT = 0.25;
          const dx = Math.hypot(cam.x - XIY_C[0], cam.z - XIY_C[1]);
          const dy = Math.hypot(cam.x - YL_C[0], cam.z - YL_C[1]);
          xiyGroup.visible = dx < 22000 + cam.y * 2;
          ylGroup.visible = dy < 18000 + cam.y * 2;
          for (const im of Object.values(meshes)) {
            const bs = im.boundingSphere;
            im.visible = Math.hypot(cam.x - bs.center.x, cam.z - bs.center.z) < bs.radius + 20000 + cam.y * 2;
          }
        }
        stepOps(d);
        tmpC.copy(cam);
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
function distToRunway(R, x, z) {
  const s = Math.max(0, Math.min(R.L, (x - R.ax) * R.ux + (z - R.az) * R.uz));
  return Math.hypot(R.ax + R.ux * s - x, R.az + R.uz * s - z);
}
