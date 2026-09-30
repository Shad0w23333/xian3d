// 行人：轻量“活动气泡”行人系统（全城人行道 / 步行街 / 广场）
//
//   · 路径：roads.json 中的步行街（pedestrian）、人行道（footway）中心线，以及主干/次干/支路两侧人行道
//     （按路宽 + 人行道宽偏移；单行道只取右侧，对应分幅道路的外侧），居住区道路两侧少量；桥梁/隧道不放人。
//   · 热点：钟楼、鼓楼·回民街、大唐不夜城、大雁塔、小寨、永宁门、曲江池等处密度加倍，夜里更热闹（夜间照样有人）。
//   · 气泡：只在相机附近（离地 < 数百米）仿真，半径随高度变化；出圈的人回收并在视野外/远处补人，维持目标密度。
//   · 渲染：一个 InstancedMesh（复用不夜城游客几何），腿/手臂摆动在顶点着色器里完成；CPU 只做沿折线行走。
//   · 开关：setLayer('people', false) 时整个系统停更新、不绘制；同时隐藏大唐不夜城的游客人流（'不夜城人流'）。
import * as THREE from 'three';
import { personGeometry } from '../arch/datang-props.js';
import { LIFT, roadY } from '../core/roadheight.js';

// 各画质档：最大人数 / 活动半径上限 / 绘制距离 / 生效的最大离地高度
const CAP = [500, 1000, 1800, 2800];
const R_MAX = [420, 600, 800, 1000];
const DRAW_D = [180, 260, 340, 430];
const AGL_MAX = [320, 480, 650, 850];
const CELL = 200; // 空间网格（米）
const BASE_DENSITY = 0.022; // 人 / 米路径（热点 ×，时段 ×，密度设置 ×）

// 热点：[lon, lat, 半径 m, 倍率]
const HOTSPOTS = [
  [108.9423, 34.2610, 320, 4], // 钟楼
  [108.9395, 34.2632, 420, 5], // 鼓楼 · 回民街
  [108.9595, 34.2120, 700, 3.5], // 大唐不夜城
  [108.9642, 34.2196, 420, 3], // 大雁塔
  [108.9480, 34.2230, 500, 3], // 小寨
  [108.9423, 34.2515, 260, 2], // 永宁门
  [108.9440, 34.2620, 1800, 1.6], // 明城墙内
  [108.9780, 34.2050, 800, 1.6], // 曲江池
  [108.8850, 34.2250, 1800, 1.2], // 高新区
];
// 时段人流（相对傍晚高峰）
const HOUR_KEYS = [[0, 0.3], [2, 0.1], [5, 0.06], [7, 0.45], [9, 0.7], [12, 0.85], [15, 0.8], [18, 1], [20.5, 1], [22.5, 0.65], [24, 0.3]];
function hourFactor(h) {
  h = ((h % 24) + 24) % 24;
  for (let i = 1; i < HOUR_KEYS.length; i++) {
    const [h1, v1] = HOUR_KEYS[i];
    if (h <= h1) {
      const [h0, v0] = HOUR_KEYS[i - 1];
      return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
    }
  }
  return 0.3;
}
// 与 arch/roads_net.js 的 CFG 对应：路面最小宽 / 人行道宽
const MIN_W = [7.5, 7, 7, 6.5, 6, 5, 3.5, 5, 4.5, 4.5, 4.5, 4, 4, 2];
const SIDEWALK = [0, 4.5, 5, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const COLORS = ['#2b2f38', '#e8e4dc', '#6d7a8a', '#3a4a5e', '#8a3a32', '#c9b79c', '#1f1f22', '#5a6b4a', '#b04a3a', '#d8d2c4', '#f0f0ee', '#344a78', '#c8312a', '#e0b050', '#9ec3d6', '#d8667a'];

let seed = 987654;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function crowdMaterial(ctx) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, emissive: 0x2a2724, emissiveIntensity: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aAnim; attribute float tint;
        uniform float uTime;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float wMov = step(0.05, aAnim.y);
          float wPh = uTime * (2.2 + aAnim.y * 1.9) + aAnim.x * 40.0;
          float legK = max(0.0, 0.84 - transformed.y) * step(0.03, abs(transformed.x));
          transformed.z += sin(wPh) * sign(transformed.x) * legK * 0.55 * wMov;
          float armK = step(0.2, abs(transformed.x)) * step(0.78, transformed.y) * max(0.0, 1.42 - transformed.y);
          transformed.z -= sin(wPh) * sign(transformed.x) * armK * 0.5 * wMov;
          transformed.y += abs(sin(wPh)) * 0.035 * wMov;
        }`
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb = mix(color.rgb, color.rgb * instanceColor.rgb, tint);
        #endif`
      );
  };
  mat.customProgramCacheKey = () => 'xianPeds';
  return mat;
}

export default {
  id: 'pedestrians',
  name: '行人',
  async build(ctx) {
    const { terrain, camera } = ctx;
    const Q = ctx.quality;
    let level = Math.max(0, Math.min(3, Q.level ?? 2));

    // —— 路径 ——
    // 每条路径：pts（x,z 交错）、cum（累计里程）、len、off（横向偏移基准）、jit（横向抖动幅度）、w（密度权重）、lift
    const paths = [];
    const hot = HOTSPOTS.map(([lon, lat, r, k]) => { const p = ctx.geo.project(lon, lat); return { x: p.x, z: p.z, r, k }; });
    const hotAt = (x, z) => {
      let k = 1;
      for (const h of hot) {
        const d = Math.hypot(x - h.x, z - h.z);
        if (d < h.r) k = Math.max(k, 1 + (h.k - 1) * (1 - (d / h.r) ** 2));
      }
      return k;
    };
    const feats = ctx.data.roads?.features || [];
    for (const f of feats) {
      const c = f.c;
      if (f.t || f.b || !f.p || f.p.length < 4) continue;
      let sides = null;
      const W = Math.min(42, Math.max(Number(f.w) || MIN_W[c] || 5, MIN_W[c] || 5, c >= 1 && c <= 4 ? Math.max(1, f.l | 0 || 1) * (c <= 2 ? 3.4 : 3.1) : 0));
      if (c === 12) sides = [[0, W * 0.8, 1.6]];
      else if (c === 13) sides = [[0, Math.min(W, 3) * 0.6, 1.1]];
      else if (c >= 1 && c <= 4) {
        const sw = SIDEWALK[c];
        const o = W / 2 + sw * 0.5;
        sides = f.o ? [[o, sw * 0.6, 1]] : [[o, sw * 0.6, 1], [-o, sw * 0.6, 1]];
      } else if (c === 5) {
        const o = W / 2 - 0.7;
        sides = [[o, 0.8, 0.3], [-o, 0.8, 0.3]];
      }
      if (!sides) continue;
      const src = f.p;
      const n = src.length / 2;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(src[i * 2] - src[i * 2 - 2], src[i * 2 + 1] - src[i * 2 - 1]);
      const len = cum[n - 1];
      if (len < 8) continue;
      const pts = Float32Array.from(src);
      const mid = Math.floor(n / 2) * 2;
      const hk = hotAt(src[mid], src[mid + 1]);
      for (const [off, jit, w] of sides) paths.push({ f, pts, cum, n, len, off, jit, w: w * hk, lift: c >= 1 && c <= 4 ? 0.14 : 0.04 });
    }
    // 空间网格：cell → [pathIndex, segIndex, ...]；道路模块不画的路段（排除区 roads）与地形挖洞处不放人
    const hidden = (x, z) => !!(terrain.inHole?.(x, z) || ctx.exclusions?.test(x, z, 'roads'));
    const grid = new Map();
    const key = (cx, cz) => cx * 65536 + cz;
    paths.forEach((p, pi) => {
      for (let i = 0; i < p.n - 1; i++) {
        const mx = (p.pts[i * 2] + p.pts[i * 2 + 2]) * 0.5, mz = (p.pts[i * 2 + 1] + p.pts[i * 2 + 3]) * 0.5;
        if (hidden(mx, mz)) continue;
        const k = key(Math.floor(mx / CELL) + 32768, Math.floor(mz / CELL) + 32768);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(pi, i);
      }
    });

    // —— 渲染 ——
    const MAXN = CAP[3];
    const geo = personGeometry('modern').clone();
    const aAnim = new THREE.InstancedBufferAttribute(new Float32Array(MAXN * 2), 2);
    aAnim.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAnim', aAnim);
    const mat = crowdMaterial(ctx);
    const mesh = new THREE.InstancedMesh(geo, mat, MAXN);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXN * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = '行人';
    ctx.scene.add(mesh);

    // —— 行人状态（SoA） ——
    const wPath = new Int32Array(MAXN), wSeg = new Int32Array(MAXN);
    const wS = new Float32Array(MAXN), wDir = new Int8Array(MAXN), wSpd = new Float32Array(MAXN), wOff = new Float32Array(MAXN);
    const wPh = new Float32Array(MAXN), wCol = new Uint8Array(MAXN), wScale = new Float32Array(MAXN), wYaw = new Float32Array(MAXN);
    const wY = new Float32Array(MAXN), wX = new Float32Array(MAXN), wZ = new Float32Array(MAXN), wTimer = new Float32Array(MAXN);
    const wHid = new Uint8Array(MAXN); // 上次检查时是否已在隐藏区内（区分“走进去”与“生成/卡在里面”）
    let N = 0;

    // 活动区候选段（按权重×长度的累计分布抽样）
    let candP = new Int32Array(1024), candI = new Int32Array(1024), candCum = new Float64Array(1024), nCand = 0;
    const bub = { x: 1e9, z: 1e9, R: 0, on: false };
    let target = 0;

    const frustum = new THREE.Frustum();
    const projM = new THREE.Matrix4();
    const sphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
    const palette = COLORS.map((h) => new THREE.Color(h));

    const locate = (i) => {
      const p = paths[wPath[i]];
      let g = wSeg[i];
      const s = wS[i];
      while (g < p.n - 2 && s > p.cum[g + 1]) g++;
      while (g > 0 && s < p.cum[g]) g--;
      wSeg[i] = g;
      const ax = p.pts[g * 2], az = p.pts[g * 2 + 1], bx = p.pts[g * 2 + 2], bz = p.pts[g * 2 + 3];
      const sl = p.cum[g + 1] - p.cum[g] || 1;
      const t = Math.min(1, Math.max(0, (s - p.cum[g]) / sl));
      const dx = (bx - ax) / sl, dz = (bz - az) / sl;
      // 右法线 (-dz, dx)
      wX[i] = ax + (bx - ax) * t - dz * wOff[i];
      wZ[i] = az + (bz - az) * t + dx * wOff[i];
      if (wSpd[i] > 0) wYaw[i] = Math.atan2(dx * wDir[i], dz * wDir[i]);
    };
    // 高度跟随道路纵断面（引桥路堤、被抬高的地面路上行人不再低于路面）；无纵断面时退回地形
    const groundY = (i) => {
      const p = paths[wPath[i]];
      const g = terrain.heightAt(wX[i], wZ[i]) + LIFT;
      const r = p.f._rp ? roadY(terrain, p.f, wX[i], wZ[i], wS[i], p.len) : null;
      wY[i] = Math.max(g, r ?? g) + p.lift;
    };

    const spawn = (i, anywhere) => {
      if (!nCand) return false;
      const cp = camera.position;
      for (let tries = 0; tries < 5; tries++) {
        const r = rnd() * candCum[nCand - 1];
        let lo = 0, hi = nCand - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (candCum[m] < r) lo = m + 1; else hi = m; }
        const pi = candP[lo], g = candI[lo], p = paths[pi];
        wPath[i] = pi;
        wSeg[i] = g;
        wS[i] = p.cum[g] + rnd() * (p.cum[g + 1] - p.cum[g]);
        wOff[i] = p.off + (rnd() - 0.5) * p.jit;
        const stand = rnd() < 0.12;
        wSpd[i] = stand ? 0 : 0.9 + rnd() * 0.7;
        wDir[i] = rnd() < 0.5 ? 1 : -1;
        wYaw[i] = rnd() * Math.PI * 2;
        wTimer[i] = stand ? 5 + rnd() * 25 : 20 + rnd() * 60;
        locate(i);
        // 中点不在隐藏区的路段也可能部分穿进坑口/楼体排除区：落点在区内就重抽，5 次都不行就不补这个人
        if (hidden(wX[i], wZ[i])) { if (tries < 4) continue; return false; }
        if (anywhere || tries === 4) break;
        // 非初始补人：尽量补在视野外或较远处，避免“凭空出现”
        const d = Math.hypot(wX[i] - cp.x, wZ[i] - cp.z);
        sphere.center.set(wX[i], terrain.heightAt(wX[i], wZ[i]) + 1, wZ[i]);
        sphere.radius = 1.5;
        if (d > bub.R * 0.55 || !frustum.intersectsSphere(sphere)) break;
      }
      wPh[i] = rnd();
      wCol[i] = (rnd() * palette.length) | 0;
      wScale[i] = 0.9 + rnd() * 0.18;
      wHid[i] = 0;
      groundY(i);
      return true;
    };
    const kill = (i) => {
      const j = --N;
      if (i === j) return;
      wPath[i] = wPath[j]; wSeg[i] = wSeg[j]; wS[i] = wS[j]; wDir[i] = wDir[j]; wSpd[i] = wSpd[j]; wOff[i] = wOff[j];
      wPh[i] = wPh[j]; wCol[i] = wCol[j]; wScale[i] = wScale[j]; wYaw[i] = wYaw[j]; wY[i] = wY[j]; wX[i] = wX[j]; wZ[i] = wZ[j]; wTimer[i] = wTimer[j]; wHid[i] = wHid[j];
    };

    let density = Q.peopleDensity ?? 1;
    const refresh = (first) => {
      const cp = camera.position;
      const agl = camera.userData.agl ?? cp.y - terrain.heightAt(cp.x, cp.z);
      if (agl > AGL_MAX[level] || density <= 0) {
        bub.on = false;
        N = 0;
        nCand = 0;
        return;
      }
      const R = THREE.MathUtils.clamp(260 + Math.max(0, agl) * 1.3, 300, R_MAX[level]);
      const wasOn = bub.on;
      bub.on = true;
      bub.x = cp.x; bub.z = cp.z; bub.R = R;
      // 候选段
      nCand = 0;
      let acc = 0;
      const c0x = Math.floor((cp.x - R) / CELL) + 32768, c1x = Math.floor((cp.x + R) / CELL) + 32768;
      const c0z = Math.floor((cp.z - R) / CELL) + 32768, c1z = Math.floor((cp.z + R) / CELL) + 32768;
      const R2 = R * R;
      for (let cx = c0x; cx <= c1x; cx++)
        for (let cz = c0z; cz <= c1z; cz++) {
          const a = grid.get(key(cx, cz));
          if (!a) continue;
          for (let k = 0; k < a.length; k += 2) {
            const p = paths[a[k]], g = a[k + 1];
            const mx = (p.pts[g * 2] + p.pts[g * 2 + 2]) * 0.5 - cp.x, mz = (p.pts[g * 2 + 1] + p.pts[g * 2 + 3]) * 0.5 - cp.z;
            if (mx * mx + mz * mz > R2) continue;
            if (nCand >= candP.length) {
              const grow = (A, T) => { const b = new T(A.length * 2); b.set(A); return b; };
              candP = grow(candP, Int32Array); candI = grow(candI, Int32Array); candCum = grow(candCum, Float64Array);
            }
            acc += (p.cum[g + 1] - p.cum[g]) * p.w;
            candP[nCand] = a[k]; candI[nCand] = g; candCum[nCand] = acc; nCand++;
          }
        }
      const night = ctx.uniforms.uNight.value;
      const hf = hourFactor(ctx.sky?.hours ?? 16) * (1 + 0.15 * night);
      target = Math.min(CAP[level], Math.round(acc * BASE_DENSITY * hf * density));
      // 回收出圈的人
      const out2 = (R * 1.08) ** 2;
      for (let i = N - 1; i >= 0; i--) {
        const dx = wX[i] - cp.x, dz = wZ[i] - cp.z;
        if (dx * dx + dz * dz > out2) kill(i);
      }
      while (N > target) kill(N - 1);
      const anywhere = first || !wasOn;
      // 每次最多补一部分，分摊到多次刷新
      const add = anywhere ? target - N : Math.min(target - N, 300);
      for (let k = 0; k < add; k++) if (spawn(N, anywhere)) N++;
    };

    // —— 帧更新 ——
    let enabled = true;
    let refreshT = 0, frame = 0, first = true;
    const M = mesh.instanceMatrix.array;
    const C = mesh.instanceColor.array;
    const A = aAnim.array;
    const crowdMeshes = [];
    let crowdScanned = false;
    const scanCrowds = () => {
      crowdScanned = true;
      ctx.scene.traverse((o) => { if (o.isInstancedMesh && o.name === '不夜城人流') crowdMeshes.push(o); });
    };

    const inst = {
      update(dt) {
        if (!enabled) return;
        dt = Math.min(dt, 0.1);
        frame++;
        const cp = camera.position;
        refreshT -= dt;
        const moved = Math.hypot(cp.x - bub.x, cp.z - bub.z);
        projM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projM, camera.coordinateSystem, camera.reversedDepth);
        if (first || refreshT <= 0 || (bub.on && moved > bub.R * 0.3)) {
          refresh(first);
          first = false;
          refreshT = 0.6;
        }
        if (!bub.on || !N) { mesh.count = 0; mesh.visible = false; return; }
        mesh.visible = true;
        const drawD2 = DRAW_D[level] ** 2;
        let n = 0;
        for (let i = 0; i < N; i++) {
          const p = paths[wPath[i]];
          // 状态机：走一段 ↔ 驻足
          wTimer[i] -= dt;
          if (wTimer[i] <= 0) {
            if (wSpd[i] > 0 && rnd() < 0.3) { wSpd[i] = 0; wTimer[i] = 3 + rnd() * 12; }
            else { wSpd[i] = 0.9 + rnd() * 0.7; wTimer[i] = 20 + rnd() * 60; if (rnd() < 0.25) wDir[i] = -wDir[i]; }
          }
          if (wSpd[i] > 0) {
            let s = wS[i] + wDir[i] * wSpd[i] * dt;
            if (s < 0) { s = -s; wDir[i] = 1; } else if (s > p.len) { s = 2 * p.len - s; wDir[i] = -1; }
            wS[i] = s;
            locate(i);
            if ((frame + i) % 8 === 0) {
              groundY(i);
              // 从外面走进被隐藏的路段（下沉广场坑口、楼体内部等排除区）就掉头；
              // 连续两次检查都在区内（掉头也没走出来）说明卡住了，移除，由补人逻辑重新生成
              const h = hidden(wX[i], wZ[i]) ? 1 : 0;
              if (h && wHid[i]) { kill(i); i--; continue; }
              if (h) wDir[i] = -wDir[i];
              wHid[i] = h;
            }
          }
          const dx = wX[i] - cp.x, dy = wY[i] - cp.y, dz = wZ[i] - cp.z;
          if (dx * dx + dy * dy + dz * dz > drawD2) continue;
          sphere.center.set(wX[i], wY[i] + 0.9, wZ[i]);
          sphere.radius = 1.2;
          if (!frustum.intersectsSphere(sphere)) continue;
          const sc = wScale[i], cy = Math.cos(wYaw[i]) * sc, sy = Math.sin(wYaw[i]) * sc;
          const o = n * 16;
          M[o] = cy; M[o + 1] = 0; M[o + 2] = -sy; M[o + 3] = 0;
          M[o + 4] = 0; M[o + 5] = sc; M[o + 6] = 0; M[o + 7] = 0;
          M[o + 8] = sy; M[o + 9] = 0; M[o + 10] = cy; M[o + 11] = 0;
          M[o + 12] = wX[i]; M[o + 13] = wY[i]; M[o + 14] = wZ[i]; M[o + 15] = 1;
          const col = palette[wCol[i]];
          C[n * 3] = col.r; C[n * 3 + 1] = col.g; C[n * 3 + 2] = col.b;
          A[n * 2] = wPh[i]; A[n * 2 + 1] = wSpd[i];
          n++;
        }
        mesh.count = n;
        mesh.visible = n > 0;
        const im = mesh.instanceMatrix;
        im.clearUpdateRanges(); im.addUpdateRange(0, Math.max(1, n) * 16); im.needsUpdate = true;
        const ic = mesh.instanceColor;
        ic.clearUpdateRanges(); ic.addUpdateRange(0, Math.max(1, n) * 3); ic.needsUpdate = true;
        aAnim.clearUpdateRanges(); aAnim.addUpdateRange(0, Math.max(1, n) * 2); aAnim.needsUpdate = true;
        // 夜里略提亮（路灯下可辨认）
        mat.emissiveIntensity = ctx.uniforms.uNight.value * 0.9;
      },
      setLayer(name, on) {
        if (name !== 'people') return;
        enabled = !!on;
        mesh.visible = enabled && mesh.count > 0;
        if (!enabled) { mesh.count = 0; N = 0; bub.on = false; }
        else first = true;
        if (!crowdScanned) scanCrowds();
        for (const m of crowdMeshes) m.visible = enabled;
      },
      setQuality(q) {
        level = Math.max(0, Math.min(3, q.level ?? level));
        density = q.peopleDensity ?? density;
        refreshT = 0;
      },
      stats() {
        return { walkers: N, drawn: mesh.count, target, bubbleR: Math.round(bub.R), paths: paths.length, cand: nCand };
      },
      dispose() {
        geo.dispose();
        mat.dispose();
        ctx.scene.remove(mesh);
      },
    };
    if (typeof window !== 'undefined') window.__peds = inst;
    return inst;
  },
};
