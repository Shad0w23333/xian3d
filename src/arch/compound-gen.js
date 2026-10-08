// 小区内部：按 500 m 块把规划结果（src/arch/compound-plan.js）生成几何。
// 一个块的输出（全部世界坐标、非索引）：
//   ground   贴地面层（uv = 小区局部坐标米，aK = 面层种类，着色器按种类画沥青/草坪/铺装/塑胶/球场/花坛…）
//   gdetail  近看才画的贴地细节（路缘、车位线、减速带、球场/跑道标线）
//   coarse   远看也要有的实体（围墙基座/墙体、门头、岗亭、道闸、凉亭、垃圾亭、快递柜、篮球架、旗杆、看台、车库坡道）
//   fine     近看才画的实体（围栏立柱、健身器材、游乐设施、庭院灯杆、长椅、绿篱、车棚与车、门前电动车、晾衣杆、小乔木树干）
//   alpha    铁艺栏杆/花格墙的透明贴图面
//   glow     夜间发光体（灯头、岗亭窗、快递柜屏、充电桩指示灯）
//   pool     夜间灯下地面光斑（加色混合）
//   cars     停放车辆实例 [x, y, z, yaw, r, g, b, sy, sz]
//   crowns   小乔木树冠与灌木球（广告牌实例）[x, y, z, 半径, r, g, b]
//   signs    门头名称牌 {x, y, z, yaw, w, h, text}
//   gates    大门位置（夜间点光源候选）
// 生成器函数：每个小区按阶段（道路停车 → 设施 → 每 125 m 小方块的草坪栅格 → 围墙大门）让出，由模块按帧时间预算推进。
import { K, GeoWriter, C, PAL, mix, scl, booth, barrier, gateFrame, fenceSpan, fitness, playground, pavilion, bikeShed, trashKiosk, locker, hoop, flagpole, lamp, bench, garageRamp, twoWheeler, clothesLine } from './compound-props.js';
import { CHUNK, pip, ringDist, hash01 } from './compound-plan.js';
import { pickCarColor } from './traffic_models.js';
import { drawField } from './compound-sports.js';

export { K };

const LIFT = { lane: 0.05, park: 0.06, paint: 0.075, path: 0.07, apron: 0.06, pad: 0.08, lawn: 0.17, curb0: 0.0 };
const GENERIC_NAME = /^(社区|小区|家属|住宅|住宅区|居民区|居住区|家属院|宿舍|新村|生活区|村)$/;

function hh(a, b, c) { return hash01(Math.round(a * 7.3) | 0, Math.round(b * 7.3) | 0, c | 0); }

/** 一个块的写入器集合 */
function writers() {
  return {
    ground: new GeoWriter({ uv: true, kind: true }),
    gdetail: new GeoWriter({ uv: true, kind: true }), // 路缘、标线、车位线（近看才画）
    coarse: new GeoWriter(),
    fine: new GeoWriter(),
    alpha: new GeoWriter({ uv: true }),
    glow: new GeoWriter({ uv: true }),
    crowns: [], // 小乔木树冠（广告牌实例）[x, y, z, 半径, r, g, b]
    pool: new GeoWriter({ uv: true }),
    cars: [],
    signs: [],
    gates: [],
    stats: { lawn: 0, cars: 0, fence: 0, pads: 0, v: {} },
  };
}

/**
 * 块生成器。S（共享状态）：{ list, chunkMap, index, terrain, excluded(x,z), quality }
 * 用法：const it = genChunk(S, ci, cj); 反复 it.next() 直到 done，value 为结果。
 */
export function* genChunk(S, ci, cj) {
  const W = writers();
  const x0 = ci * CHUNK, z0 = cj * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const ids = S.chunkMap.get(ci + ',' + cj) || [];
  for (const id of ids) {
    const c = S.list[id];
    try {
      yield* genCompound(S, W, c, x0, z0, x1, z1);
    } catch (e) {
      console.warn('[compounds] 生成失败', c.name, e);
    }
    yield 'fence';
  }
  // 运动场地（中心在本块内；精建区内不画）
  const I = S.index;
  if (I.sgrid) {
    const seen = new Set();
    const list = [];
    I.sgrid.each(x0, z0, x1, z1, (i) => {
      if (seen.has(i)) return;
      seen.add(i);
      const f = I.sports[i];
      if (f.cx < x0 || f.cx >= x1 || f.cz < z0 || f.cz >= z1 || S.excluded(f.cx, f.cz)) return;
      list.push(f);
    });
    for (const f of list) {
      try {
        drawField(W, f, S.terrain, { stand: !!f.campus, seed: Math.floor(hash01(Math.round(f.cx), Math.round(f.cz), 3) * 64), blocked: (x, z) => inBuilding(I, x, z) });
      } catch (e) {
        console.warn('[compounds] 场地生成失败', f.kind, e);
      }
    }
    if (list.length) yield 'fields';
  }
  return W;
}

// ————————————————————————————————————————————————————————————————————————————————

function* genCompound(S, W, c, x0, z0, x1, z1) {
  const T = S.terrain;
  const inChunk = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
  const { cs, sn, ox, oz } = c;
  const X = (u, v) => ox + u * cs - v * sn, Z = (u, v) => oz + u * sn + v * cs;
  const yaw = (du, dv) => {
    // 局部方向 (du,dv) → 世界方向 → GeoWriter yaw（局部 +z 指向该方向）
    const wx = du * cs - dv * sn, wz = du * sn + dv * cs;
    return Math.atan2(wx, wz);
  };
  const ex = (x, z) => S.excluded(x, z);
  const G = W.ground;
  const oldM = c.mode === 'old';
  // 分阶段统计各写入器新增顶点（调试用：S.tally 为真时）
  let tv = null;
  const tally = (name) => {
    if (!S.tally) return;
    const now = { g: W.ground.count, c: W.coarse.count, f: W.fine.count, a: W.alpha.count };
    if (tv) {
      const o = W.stats.v[name] || (W.stats.v[name] = { g: 0, c: 0, f: 0, a: 0 });
      for (const k in now) o[k] += now[k] - tv[k];
    }
    tv = now;
  };
  tally('');

  // —— 贴地矩形（局部轴对齐，≤ 8 m 细分以贴合地形） ——
  const rect = (u0, u1, v0, v1, lift, kind, col, step = 8) => {
    const nu = Math.max(1, Math.ceil((u1 - u0) / step)), nv = Math.max(1, Math.ceil((v1 - v0) / step));
    const Gt = kind === K.PAINT ? W.gdetail : G;
    Gt.k = kind;
    const ys = new Float32Array((nu + 1) * (nv + 1));
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) {
        const u = u0 + ((u1 - u0) * i) / nu, v = v0 + ((v1 - v0) * j) / nv;
        ys[j * (nu + 1) + i] = T.heightAt(X(u, v), Z(u, v)) + lift;
      }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const ua = u0 + ((u1 - u0) * i) / nu, ub = u0 + ((u1 - u0) * (i + 1)) / nu;
        const va = v0 + ((v1 - v0) * j) / nv, vb = v0 + ((v1 - v0) * (j + 1)) / nv;
        const p = (u, v, ii, jj) => [X(u, v), ys[jj * (nu + 1) + ii], Z(u, v)];
        // 逆时针（俯视，X 东 Z 南）：(ua,vb) → (ub,vb) → (ub,va) → (ua,va) 在局部坐标里 v 向南
        Gt.quadW(p(ua, vb, i, j + 1), p(ub, vb, i + 1, j + 1), p(ub, va, i + 1, j), p(ua, va, i, j), col, [[ua, vb], [ub, vb], [ub, va], [ua, va]]);
      }
  };
  const centerIn = (u0, u1, v0, v1) => {
    const u = (u0 + u1) / 2, v = (v0 + v1) / 2;
    const x = X(u, v), z = Z(u, v);
    return inChunk(x, z) && !ex(x, z);
  };

  // —— 1. 车行道 ——
  const laneCol = oldM ? C('#9a978f') : C('#55585c');
  const laneK = oldM ? K.CONCRETE : K.ASPHALT;
  for (const L of c.lanes) {
    if (!centerIn(L.u0, L.u1, L.v0, L.v1)) continue;
    rect(L.u0, L.u1, L.v0, L.v1, LIFT.lane, laneK, laneCol);
    // 门内减速带（黄黑相间）
    if (L.kind === 'gate') {
      const along = L.dir === 0, len = along ? L.u1 - L.u0 : L.v1 - L.v0;
      if (len > 7) {
        const g = c.gates.find((q) => Math.abs(q.u - (along ? (q.du > 0 ? L.u0 : L.u1) : (L.u0 + L.u1) / 2)) < 6 && Math.abs(q.v - (along ? (L.v0 + L.v1) / 2 : q.dv > 0 ? L.v0 : L.v1)) < 6);
        const t = g ? 5 : len / 2;
        const s0 = along ? (g && g.du < 0 ? L.u1 - t : L.u0 + t) : g && g.dv < 0 ? L.v1 - t : L.v0 + t;
        const n = 8;
        for (let k = 0; k < n; k++) {
          const a = (along ? L.v0 : L.u0) + ((along ? L.v1 - L.v0 : L.u1 - L.u0) * k) / n, b = a + (along ? L.v1 - L.v0 : L.u1 - L.u0) / n;
          const col = k & 1 ? C('#202020') : C('#e2b21c');
          if (along) rect(s0 - 0.2, s0 + 0.2, a, b, LIFT.paint + 0.02, K.PAINT, col, 20);
          else rect(a, b, s0 - 0.2, s0 + 0.2, LIFT.paint + 0.02, K.PAINT, col, 20);
        }
      }
    }
  }

  // —— 2. 停车 ——
  const paint = C('#e9e8e2', 0.95);
  const parkCol = oldM ? C('#8f8c86') : C('#7f8a6c');
  for (const p of c.parks) {
    if (!centerIn(p.u0, p.u1, p.v0, p.v1)) continue;
    const along = p.dir === 0;
    const perp = p.type === 'perp';
    const D = perp ? 5.3 : 2.4, Wd = perp ? 2.5 : 6.0;
    // 面层：新小区植草砖（灰绿格）、老小区水泥地
    if (!oldM || p.lines) rect(p.u0, p.u1, p.v0, p.v1, LIFT.park, oldM ? K.CONCRETE : K.GRASSPAVE, parkCol);
    if (p.lines) {
      const lw = 0.1;
      for (let k = 0; k <= p.n; k++) {
        const s = (along ? p.u0 : p.v0) + k * Wd;
        if (along) rect(s - lw / 2, s + lw / 2, p.v0, p.v1, LIFT.paint, K.PAINT, paint, 20);
        else rect(p.u0, p.u1, s - lw / 2, s + lw / 2, LIFT.paint, K.PAINT, paint, 20);
      }
      // 外沿线（远离车行道的一侧）
      if (along) {
        const v = p.side < 0 ? p.v0 : p.v1;
        rect(p.u0, p.u1, v - lw / 2, v + lw / 2, LIFT.paint, K.PAINT, paint, 20);
      } else {
        const u = p.side < 0 ? p.u0 : p.u1;
        rect(u - lw / 2, u + lw / 2, p.v0, p.v1, LIFT.paint, K.PAINT, paint, 20);
      }
    }
    // 车辆（占用率 60~85%，老小区更满、更乱）
    const occ = oldM ? 0.78 + hh(p.u0, p.v0, 3) * 0.12 : 0.6 + hh(p.u0, p.v0, 3) * 0.2;
    for (let k = 0; k < p.n; k++) {
      const r = hh(p.u0 + k, p.v0, 11 + k);
      if (r > occ) continue;
      const s = (along ? p.u0 : p.v0) + (k + 0.5) * Wd;
      const cmid = along ? (p.v0 + p.v1) / 2 : (p.u0 + p.u1) / 2;
      const messy = oldM && !p.lines;
      const jl = messy ? (hh(k, p.u0, 5) - 0.5) * 0.8 : (hh(k, p.u0, 5) - 0.5) * 0.15;
      const jc = messy ? (hh(k, p.v0, 6) - 0.5) * 0.5 : (hh(k, p.v0, 6) - 0.5) * 0.12;
      const u = along ? s + jl : cmid + jc, v = along ? cmid + jc : s + jl;
      // 车头方向：垂直车位朝车行道（倒车入库）或背向；平行车位沿道路
      let du, dv;
      if (perp) {
        const toLane = p.side < 0 ? 1 : -1; // 车位在北侧 → 车行道在南（+v）
        const out = hh(k, p.v1, 7) < 0.7 ? 1 : -1;
        if (along) { du = 0; dv = toLane * out; } else { du = toLane * out; dv = 0; }
      } else {
        const f = hh(k, p.u1, 8) < 0.5 ? 1 : -1;
        if (along) { du = f; dv = 0; } else { du = 0; dv = f; }
      }
      const jy = (hh(k, p.u0 + p.v0, 9) - 0.5) * (messy ? 0.25 : 0.05);
      addCar(W, S, X(u, v), Z(u, v), yaw(du, dv) + jy, hh(k * 3, p.v0 + p.u1, 12));
    }
  }
  // 老小区：沿车行道一侧路边乱停（不画车位线）
  if (oldM) {
    for (const L of c.lanes) {
      if (L.kind !== 'lane' || !centerIn(L.u0, L.u1, L.v0, L.v1)) continue;
      const along = L.dir === 0;
      const len = along ? L.u1 - L.u0 : L.v1 - L.v0;
      const side = hh(L.u0, L.v0, 21) < 0.5 ? -1 : 1;
      let t = 4 + hh(L.u1, L.v1, 22) * 8;
      while (t < len - 4) {
        const r = hh(t, L.u0 + L.v0, 23);
        if (r < 0.45) {
          const off = side < 0 ? (along ? L.v0 + 1.0 : L.u0 + 1.0) : along ? L.v1 - 1.0 : L.u1 - 1.0;
          const u = along ? L.u0 + t : off, v = along ? off : L.v0 + t;
          const x = X(u, v), z = Z(u, v);
          if (inChunk(x, z)) addCar(W, S, x, z, yaw(along ? (r < 0.22 ? 1 : -1) : 0, along ? 0 : r < 0.22 ? 1 : -1) + (r - 0.22) * 0.3, hh(t, L.v1, 24));
        }
        t += 5.2 + hh(t, L.v0, 25) * 7;
      }
    }
  }
  // 小区内 OSM 道路旁平行车位（只放车，不画线）
  for (const o of c.osmParks) {
    for (let k = 0; k < o.n; k++) {
      const t = (k + 0.5) * 6.0;
      const u = o.au + o.du * t, v = o.av + o.dv * t;
      const x = X(u, v), z = Z(u, v);
      if (!inChunk(x, z) || ex(x, z) || hh(u, v, 31) > 0.7) continue;
      addCar(W, S, x, z, yaw(o.du, o.dv) + (hh(u, v, 32) < 0.5 ? 0 : Math.PI), hh(u, v, 33));
    }
  }

  // —— 3. 入户铺装带、园路 ——
  const paverCol = oldM ? C('#a39e94') : C('#b9b5ad');
  const ebCols = [C('#2b2d30'), C('#d8dadc'), C('#c23a2e'), C('#2f6fb3'), C('#e8e6e0'), C('#7a8a96'), C('#3a7a4a'), C('#e0b030')];
  for (const a of c.aprons) {
    if (!centerIn(a.u0, a.u1, a.v0, a.v1)) continue;
    rect(a.u0, a.u1, a.v0, a.v1, LIFT.apron, K.PAVER, paverCol);
    // 单元门前停放的电动车/自行车（老小区多、新小区少；车头朝楼）
    const step = oldM ? 8 : 16;
    const n = Math.floor((a.u1 - a.u0) / step);
    for (let k = 0; k < n; k++) {
      if (hh(a.u0 + k, a.v0, 41) > (oldM ? 0.55 : 0.3)) continue;
      const m = 1 + Math.floor(hh(k, a.u1, 42) * (oldM ? 3 : 2));
      const u0b = a.u0 + 1 + k * step + hh(k, a.v1, 43) * 3;
      for (let q = 0; q < m; q++) {
        const u = u0b + q * 0.75, v = a.v1 - 1.0;
        const x = X(u, v), z = Z(u, v);
        W.fine.setXf(x, S.terrain.heightAt(x, z) + LIFT.apron, z, yaw(0, 1) + (hh(q, u, 44) - 0.5) * 0.3);
        twoWheeler(W.fine, ebCols[Math.floor(hh(u, q, 45) * ebCols.length)], hh(q, u, 46) < (oldM ? 0.6 : 0.85));
      }
    }
  }
  // 老小区宅间晾衣杆
  if (oldM) {
    for (const gd of c.gardens || []) {
      if (gd.u1 - gd.u0 < 10 || gd.v1 - gd.v0 < 6 || hh(gd.u0, gd.v0, 47) > 0.45) continue;
      const u = gd.u0 + 2 + hh(gd.u1, gd.v0, 48) * Math.max(0, gd.u1 - gd.u0 - 10), v = gd.v0 + 1.6;
      const x = X(u + 3, v), z = Z(u + 3, v);
      if (!inChunk(x, z) || ex(x, z)) continue;
      W.fine.setXf(x, S.terrain.heightAt(x, z) + LIFT.lawn, z, yaw(0, 1));
      clothesLine(W.fine, 6, Math.floor(hh(u, v, 49) * 97));
    }
  }
  const pathCol = oldM ? C('#9e9a92') : hh(c.pid, 1, 2) < 0.5 ? C('#8c6152') : C('#bdb7ab');
  const pathK = oldM ? K.CONCRETE : pathCol[0] > pathCol[2] * 1.3 ? K.PAVER_R : K.PAVER;
  for (const p of c.paths) if (centerIn(p.u0, p.u1, p.v0, p.v1)) rect(p.u0, p.u1, p.v0, p.v1, LIFT.path, pathK, pathCol);

  tally('lanes+parks+paths');
  yield 'lanes';
  // —— 4. 设施 ——
  for (const p of c.pads) {
    if (!centerIn(p.u0, p.u1, p.v0, p.v1)) continue;
    genPad(S, W, c, p, X, Z, yaw, rect);
    W.stats.pads++;
  }

  tally('pads');
  // —— 5. 庭院灯 ——
  for (const l of c.lamps) {
    const x = X(l[0], l[1]), z = Z(l[0], l[1]);
    if (!inChunk(x, z) || ex(x, z)) continue;
    const y = T.heightAt(x, z) + 0.05;
    W.fine.setXf(x, y, z, 0);
    lamp(W.fine, W.glow, l[2]);
    // 灯下光斑
    const r = l[2] ? 3.0 : 9.0;
    pool(W.pool, x, y + 0.22, z, r, l[2] ? 0.8 : 1);
  }

  tally('lamps');
  yield 'pads';
  // —— 6. 草坪（栅格 → 合并矩形）、路缘、绿篱、灌木 ——
  // 按 125 m 小方块逐块栅格化（每块 ≤ 3 万格），每块之后让出一次，单步耗时有上限
  const SUB = 125;
  for (let sx = x0; sx < x1; sx += SUB)
    for (let sz = z0; sz < z1; sz += SUB) {
      if (sx + SUB < c.bb[0] || sx > c.bb[2] || sz + SUB < c.bb[1] || sz > c.bb[3]) continue;
      genLawns(S, W, c, sx, sz, sx + SUB, sz + SUB, X, Z);
      yield 'lawns';
    }
  tally('lawns');

  // —— 7. 围墙/围栏与大门 ——
  genFence(S, W, c, x0, z0, x1, z1, X, Z, yaw);
  tally('fence+gates');
}

function inBuilding(I, x, z) {
  let hit = false;
  I.bgrid.each(x, z, x, z, (b) => {
    if (hit) return;
    const bb = I.bbx;
    if (x < bb[b * 4] || x > bb[b * 4 + 2] || z < bb[b * 4 + 1] || z > bb[b * 4 + 3]) return;
    const B = I.B, s = B.vs[b] * 2, n = B.vc[b], ax = B.ax[b], az = B.az[b];
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ax + B.offs[s + i * 2] * 0.1, zi = az + B.offs[s + i * 2 + 1] * 0.1, xj = ax + B.offs[s + j * 2] * 0.1, zj = az + B.offs[s + j * 2 + 1] * 0.1;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) hit = true;
  });
  return hit;
}

function addCar(W, S, x, z, yaw, r) {
  const col = C(pickCarColor(r));
  const y = S.terrain.heightAt(x, z) + 0.06;
  const suv = hash01(Math.round(x * 3), Math.round(z * 3), 77) < 0.35;
  W.cars.push(x, y, z, yaw, col[0], col[1], col[2], suv ? 1.16 : 1, suv ? 1.03 : 0.97 + r * 0.06);
  W.stats.cars++;
}

/** 灯下光斑（加色混合，uv 0..1 → 着色器画径向衰减） */
function pool(P, x, y, z, r, k = 1) {
  P.quadW([x - r, y, z + r], [x + r, y, z + r], [x + r, y, z - r], [x - r, y, z - r], [k, k * 0.82, k * 0.55], [[0, 1], [1, 1], [1, 0], [0, 0]]);
}

// ————————————————————————————————————————————————————————————————————————————————
// 设施
// ————————————————————————————————————————————————————————————————————————————————
function genPad(S, W, c, p, X, Z, yaw, rect) {
  const T = S.terrain;
  const cu = (p.u0 + p.u1) / 2, cv = (p.v0 + p.v1) / 2;
  const w = p.u1 - p.u0, d = p.v1 - p.v0;
  const x = X(cu, cv), z = Z(cu, cv);
  const y = T.heightAt(x, z) + LIFT.pad;
  const sd = p.seed || 0;
  const F = W.fine, Co = W.coarse;
  switch (p.type) {
    case 'fit': {
      rect(p.u0, p.u1, p.v0, p.v1, LIFT.pad, K.RUBBER, C('#4f8a4a'));
      F.setXf(x, y, z, yaw(0, 1));
      fitness(F, w - 1, d - 1, sd);
      // 两张长椅
      F.setXf(X(p.u0 + 0.6, cv), y, Z(p.u0 + 0.6, cv), yaw(1, 0));
      bench(F);
      break;
    }
    case 'play': {
      const cols = [C('#b2463a'), C('#3f6fa8'), C('#4f8a4a'), C('#d39a2a')];
      // 塑胶地垫拼色：四块
      const um = cu + (hash01(sd, 1, 2) - 0.5) * w * 0.3, vm = cv + (hash01(sd, 2, 3) - 0.5) * d * 0.3;
      rect(p.u0, um, p.v0, vm, LIFT.pad, K.RUBBER, cols[sd % 4]);
      rect(um, p.u1, p.v0, vm, LIFT.pad, K.RUBBER, cols[(sd + 1) % 4]);
      rect(p.u0, um, vm, p.v1, LIFT.pad, K.RUBBER, cols[(sd + 2) % 4]);
      rect(um, p.u1, vm, p.v1, LIFT.pad, K.RUBBER, cols[(sd + 3) % 4]);
      const along = w >= d;
      F.setXf(x, y, z, along ? yaw(0, 1) : yaw(1, 0));
      playground(F, along ? w - 1 : d - 1, along ? d - 1 : w - 1, sd);
      break;
    }
    case 'pav': {
      rect(p.u0 - 0.5, p.u1 + 0.5, p.v0 - 0.5, p.v1 + 0.5, LIFT.pad, K.PAVER, C('#b8b2a6'));
      Co.setXf(x, y, z, yaw(0, 1));
      pavilion(Co, w, d, c.old || (sd & 3) === 0 ? 'ting' : (sd & 1 ? 'lang' : 'ting'), sd);
      break;
    }
    case 'bike':
    case 'ebike': {
      rect(p.u0, p.u1, p.v0, p.v1, LIFT.pad - 0.02, K.CONCRETE, C('#9d9a93'));
      // 车棚后墙朝向最近的楼：这里取 +v 侧（楼在南）或 -v 侧
      const along = w >= d;
      Co.setXf(x, y, z, along ? yaw(0, -1) : yaw(-1, 0));
      // 车棚骨架 + 屋面画在 coarse，车与充电桩画在 fine：先写 coarse 只含骨架
      const tmp = new GeoWriter();
      tmp.setXf(x, y, z, along ? yaw(0, -1) : yaw(-1, 0));
      bikeShed(tmp, W.glow, along ? w : d, along ? d : w, p.type === 'ebike', sd);
      F.append(tmp);
      break;
    }
    case 'trash': {
      const along = w >= d;
      Co.setXf(x, y, z, along ? yaw(0, 1) : yaw(1, 0));
      trashKiosk(Co, along ? w : d, along ? d : w);
      break;
    }
    case 'locker': {
      const f = p.face || [0, 1];
      const along = Math.abs(f[1]) > 0.5;
      Co.setXf(x, y, z, yaw(f[0], f[1]));
      locker(Co, W.glow, along ? w : d);
      break;
    }
    case 'court': {
      // 篮球场：外圈红褐、内场蓝/绿，白线（场地 28×15）
      const inner = hash01(sd, 4, 5) < 0.5 ? C('#3f6fa0') : C('#4c7f58');
      rect(p.u0, p.u1, p.v0, p.v1, LIFT.pad, K.COURT, C('#9a4a3c'));
      const along = w >= d;
      const L = along ? w : d, B = along ? d : w;
      const m = 1.2;
      const R = (a0, a1, b0, b1, lift, k, col) => (along ? rect(cu + a0, cu + a1, cv + b0, cv + b1, lift, k, col, 30) : rect(cu + b0, cu + b1, cv + a0, cv + a1, lift, k, col, 30));
      R(-L / 2 + m, L / 2 - m, -B / 2 + m, B / 2 - m, LIFT.pad + 0.004, K.COURT, inner);
      const lw = 0.06, lc = C('#efefea'), ly = LIFT.pad + 0.009;
      const hl = L / 2 - m, hb = B / 2 - m;
      R(-hl, hl, -hb, -hb + lw, ly, K.PAINT, lc); R(-hl, hl, hb - lw, hb, ly, K.PAINT, lc);
      R(-hl, -hl + lw, -hb, hb, ly, K.PAINT, lc); R(hl - lw, hl, -hb, hb, ly, K.PAINT, lc);
      R(-lw / 2, lw / 2, -hb, hb, ly, K.PAINT, lc);
      for (const s of [-1, 1]) {
        const a = s * hl, b = a - s * 5.8;
        R(Math.min(a, b), Math.max(a, b), -2.45, -2.45 + lw, ly, K.PAINT, lc);
        R(Math.min(a, b), Math.max(a, b), 2.45 - lw, 2.45, ly, K.PAINT, lc);
        R(b - lw / 2, b + lw / 2, -2.45, 2.45, ly, K.PAINT, lc);
        // 篮球架
        const hu = along ? cu + s * (hl - 0.0) : cu, hv = along ? cv : cv + s * (hl - 0.0);
        const hx = X(hu, hv), hz = Z(hu, hv);
        Co.setXf(hx, T.heightAt(hx, hz) + LIFT.pad, hz, along ? yaw(-s, 0) : yaw(0, -s));
        hoop(Co);
      }
      break;
    }
    case 'ramp': {
      const dir = p.dir || [0, 1];
      const alongU = Math.abs(dir[0]) > 0.5;
      rect(p.u0, p.u1, p.v0, p.v1, LIFT.pad - 0.02, K.ASPHALT, C('#3a3c3f'));
      Co.setXf(x, y, z, yaw(dir[0], dir[1]));
      garageRamp(Co, alongU ? d : w, alongU ? w : d);
      break;
    }
    case 'flag': {
      rect(p.u0, p.u1, p.v0, p.v1, LIFT.pad, K.PAVER, C('#c8c2b6'));
      Co.setXf(x, y, z, yaw(0, p.face || -1));
      flagpole(Co);
      break;
    }
    default:
      break;
  }
}

// ————————————————————————————————————————————————————————————————————————————————
// 草坪栅格
// ————————————————————————————————————————————————————————————————————————————————
const CODE = { OUT: 0, LAWN: 1, BLD: 2, LANE: 3, PARK: 4, PATH: 5, APRON: 6, PAD: 7, ROAD: 8, EDGE: 9, HOLE: 10 };

function genLawns(S, W, c, x0, z0, x1, z1, X, Z) {
  const T = S.terrain;
  const { cs, sn, ox, oz } = c;
  const toU = (x, z) => (x - ox) * cs + (z - oz) * sn, toV = (x, z) => -(x - ox) * sn + (z - oz) * cs;
  // 块（世界正方形）→ 局部外接框，再与小区局部外接框求交（外扩 1 格算边界）
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
    const u = toU(x, z), v = toV(x, z);
    a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, v); b1 = Math.max(b1, v);
  }
  a0 = Math.max(a0, c.U0) - 1; a1 = Math.min(a1, c.U1) + 1; b0 = Math.max(b0, c.V0) - 1; b1 = Math.min(b1, c.V1) + 1;
  if (a1 <= a0 || b1 <= b0) return;
  const CELL = 1;
  const u0 = Math.floor(a0), v0 = Math.floor(b0);
  const nx = Math.ceil(a1 - u0), ny = Math.ceil(b1 - v0);
  if (nx * ny > 900000) return;
  const g = new Uint8Array(nx * ny); // CODE
  const own = new Uint8Array(nx * ny); // 格心在本块内
  // 1. 多边形内部（扫描线）
  const fillRing = (rf, val, onlyIf = -1) => {
    const nE = rf.length / 2;
    for (let j = 0; j < ny; j++) {
      const vc = v0 + j + 0.5;
      const xs = [];
      for (let i = 0, k = nE - 1; i < nE; k = i++) {
        const va = rf[k * 2 + 1], vb = rf[i * 2 + 1];
        if (va > vc !== vb > vc) xs.push(rf[k * 2] + ((vc - va) * (rf[i * 2] - rf[k * 2])) / (vb - va));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const ia = Math.max(0, Math.ceil(xs[q] - u0 - 0.5)), ib = Math.min(nx - 1, Math.floor(xs[q + 1] - u0 - 0.5));
        for (let i = ia; i <= ib; i++) {
          const k = j * nx + i;
          if (onlyIf < 0 || g[k] === onlyIf) g[k] = val;
        }
      }
    }
  };
  fillRing(c.rf, CODE.LAWN);
  // 本块归属
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const u = u0 + i + 0.5, v = v0 + j + 0.5;
      const x = c.ox + u * cs - v * sn, z = c.oz + u * sn + v * cs;
      if (x >= x0 && x < x1 && z >= z0 && z < z1) own[j * nx + i] = 1;
    }
  // 2. 洞与内层多边形
  const toF = (ring) => {
    const r = new Float64Array(ring.length);
    for (let i = 0; i < ring.length; i += 2) { r[i] = toU(ring[i], ring[i + 1]); r[i + 1] = toV(ring[i], ring[i + 1]); }
    return r;
  };
  for (const h of c.holes || []) fillRing(toF(h), CODE.HOLE, CODE.LAWN);
  // 3. 楼（真实轮廓，外扩 1 格作散水）
  const I = S.index, B = I.B;
  const wx0 = Math.min(x0, c.bb[0]) - 5, wx1 = Math.max(x1, c.bb[2]) + 5, wz0 = Math.min(z0, c.bb[1]) - 5, wz1 = Math.max(z1, c.bb[3]) + 5;
  const seen = new Set();
  const bx0 = Math.max(wx0, x0 - 60), bx1 = Math.min(wx1, x1 + 60), bz0 = Math.max(wz0, z0 - 60), bz1 = Math.min(wz1, z1 + 60);
  I.bgrid.each(bx0, bz0, bx1, bz1, (b) => {
    if (seen.has(b)) return;
    seen.add(b);
    const s = B.vs[b] * 2, n = B.vc[b], ax = B.ax[b], az = B.az[b];
    const r = new Float64Array(n * 2);
    let mu0 = Infinity, mu1 = -Infinity, mv0 = Infinity, mv1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = ax + B.offs[s + k * 2] * 0.1, z = az + B.offs[s + k * 2 + 1] * 0.1;
      r[k * 2] = toU(x, z); r[k * 2 + 1] = toV(x, z);
      mu0 = Math.min(mu0, r[k * 2]); mu1 = Math.max(mu1, r[k * 2]); mv0 = Math.min(mv0, r[k * 2 + 1]); mv1 = Math.max(mv1, r[k * 2 + 1]);
    }
    if (mu1 < u0 - 2 || mu0 > u0 + nx + 2 || mv1 < v0 - 2 || mv0 > v0 + ny + 2) return;
    fillRing(r, CODE.BLD);
  });
  // 外扩 1 格（散水/墙根铺装）
  dilate(g, nx, ny, CODE.BLD, CODE.APRON, CODE.LAWN);
  // 4. 规划矩形
  const fillRect = (ua, ub, va, vb, val) => {
    const ia = Math.max(0, Math.floor(ua - u0)), ib = Math.min(nx - 1, Math.ceil(ub - u0) - 1);
    const ja = Math.max(0, Math.floor(va - v0)), jb = Math.min(ny - 1, Math.ceil(vb - v0) - 1);
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) { const k = j * nx + i; if (g[k] === CODE.LAWN || g[k] === CODE.APRON) g[k] = val; }
  };
  for (const L of c.lanes) fillRect(L.u0 - 0.3, L.u1 + 0.3, L.v0 - 0.3, L.v1 + 0.3, CODE.LANE);
  for (const p of c.parks) fillRect(p.u0 - 0.2, p.u1 + 0.2, p.v0 - 0.2, p.v1 + 0.2, CODE.PARK);
  for (const p of c.paths) fillRect(p.u0 - 0.2, p.u1 + 0.2, p.v0 - 0.2, p.v1 + 0.2, CODE.PATH);
  for (const p of c.aprons) fillRect(p.u0, p.u1, p.v0, p.v1, CODE.APRON);
  for (const p of c.pads) fillRect(p.u0 - 0.6, p.u1 + 0.6, p.v0 - 0.6, p.v1 + 0.6, CODE.PAD);
  for (const fi of c.fields || []) {
    const f = I.sports[fi];
    const r = new Float64Array(f.p.length);
    for (let i = 0; i < f.p.length; i += 2) { r[i] = toU(f.p[i], f.p[i + 1]); r[i + 1] = toV(f.p[i], f.p[i + 1]); }
    fillRing(r, CODE.PAD, CODE.LAWN);
    fillRing(r, CODE.PAD, CODE.APRON);
  }
  // 5. 道路（市政路含人行道净距；小区内 OSM 道路按路面半宽）
  {
    const s0 = new Set();
    I.rgrid.each(bx0, bz0, bx1, bz1, (id) => {
      if (s0.has(id)) return;
      s0.add(id);
      const r = I.rsegs[id];
      const cls = r[5];
      const rad = cls === 13 || cls === 12 ? r[7] + 0.6 : r[4];
      stampCapsule(g, nx, ny, u0, v0, toU(r[0], r[1]), toV(r[0], r[1]), toU(r[2], r[3]), toV(r[2], r[3]), rad, CODE.ROAD);
    });
  }
  // 6. 围墙内侧 1.6 m 留作铺装/绿化带（边界外扩带）
  {
    const rf = c.rf, nE = rf.length / 2;
    for (let i = 0, k = nE - 1; i < nE; k = i++) stampCapsule(g, nx, ny, u0, v0, rf[k * 2], rf[k * 2 + 1], rf[i * 2], rf[i * 2 + 1], 1.6, CODE.EDGE);
  }
  // 精建排除区
  for (let j = 0; j < ny; j += 2)
    for (let i = 0; i < nx; i += 2) {
      const k = j * nx + i;
      if (g[k] !== CODE.LAWN || !own[k]) continue;
      const u = u0 + i + 1, v = v0 + j + 1;
      if (S.excluded(c.ox + u * cs - v * sn, c.oz + u * sn + v * cs)) {
        for (let dj = 0; dj < 2 && j + dj < ny; dj++) for (let di = 0; di < 2 && i + di < nx; di++) g[(j + dj) * nx + i + di] = CODE.HOLE;
      }
    }
  // 7. 去掉细条（开运算：腐蚀 1 格再膨胀回来）
  opening(g, nx, ny);

  // —— 合并矩形 ——
  const used = new Uint8Array(nx * ny);
  const oldM = c.mode === 'old';
  const lawnBase = oldM ? C('#5b6a40') : C('#4c6b35');
  const MAXR = 28;
  const rects = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (g[k] !== CODE.LAWN || used[k] || !own[k]) continue;
      let w = 1;
      while (i + w < nx && w < MAXR && g[k + w] === CODE.LAWN && !used[k + w] && own[k + w]) w++;
      let h = 1;
      outer: while (j + h < ny && h < MAXR) {
        for (let q = 0; q < w; q++) {
          const kk = (j + h) * nx + i + q;
          if (g[kk] !== CODE.LAWN || used[kk] || !own[kk]) break outer;
        }
        h++;
      }
      for (let jj = 0; jj < h; jj++) for (let q = 0; q < w; q++) used[(j + jj) * nx + i + q] = 1;
      rects.push([i, j, w, h]);
    }
  const Gw = W.ground;
  Gw.k = K.LAWN;
  const H = (u, v) => T.heightAt(c.ox + u * cs - v * sn, c.oz + u * sn + v * cs);
  for (const [i, j, w, h] of rects) {
    const ua = u0 + i, ub = ua + w, va = v0 + j, vb = va + h;
    const P = (u, v) => [c.ox + u * cs - v * sn, H(u, v) + LIFT.lawn, c.oz + u * sn + v * cs];
    // 草色：低频噪声 + 老小区斑驳（裸土）
    const n = hash01(Math.floor(ua / 7), Math.floor(va / 7), c.pid);
    let col = mix(lawnBase, oldM ? C('#6e7448') : C('#5f7a3f'), n * 0.7);
    let kind = K.LAWN;
    // 老小区：草坪斑驳，约三成是踩秃的土面
    if (oldM && hash01(Math.floor(ua / 6), Math.floor(va / 6), c.pid + 9) < 0.32) { col = C('#8a7a5e'); kind = K.SOIL; }
    // 花坛：新小区大门内侧与凉亭旁的小块草坪，另有少量随机小块
    else if (!oldM && w * h <= 140) {
      const mu = (ua + ub) / 2, mv = (va + vb) / 2;
      const nearGate = c.gates.some((g) => Math.hypot(g.u + g.du * 12 - mu, g.v + g.dv * 12 - mv) < 20);
      const nearPav = c.pads.some((p) => p.type === 'pav' && Math.hypot((p.u0 + p.u1) / 2 - mu, (p.v0 + p.v1) / 2 - mv) < 12);
      if (nearGate || nearPav || hash01(Math.floor(mu), Math.floor(mv), c.pid + 31) < 0.06) kind = K.FLOWER;
    }
    Gw.k = kind;
    Gw.quadW(P(ua, vb), P(ub, vb), P(ub, va), P(ua, va), col, [[ua, vb], [ub, vb], [ub, va], [ua, va]]);
    W.stats.lawn += w * h;
  }
  // —— 路缘（草坪与非草坪交界的格边，合并成段）+ 绿篱 ——
  const curbCol = C('#b9b4aa');
  const hedgeCol = oldM ? C('#3f5a2c') : C('#33582a');
  const isL = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && g[j * nx + i] === CODE.LAWN;
  const codeAt = (i, j) => (i >= 0 && j >= 0 && i < nx && j < ny ? g[j * nx + i] : CODE.OUT);
  const curbs = []; // [ua, va, ub, vb, 外法线 nu, nv, 邻格类型]
  // 水平边（沿 u）：格 (i,j) 的北边 v = v0+j 与南边 v = v0+j+1
  for (let j = 0; j < ny; j++)
    for (const side of [-1, 1]) {
      let s = -1, code = -1;
      for (let i = 0; i <= nx; i++) {
        const ok = i < nx && isL(i, j) && own[j * nx + i] && !isL(i, j + side);
        const cd = ok ? codeAt(i, j + side) : -1;
        if (ok && s < 0) { s = i; code = cd; }
        else if ((!ok || cd !== code) && s >= 0) {
          const v = v0 + j + (side > 0 ? 1 : 0);
          curbs.push([u0 + s, v, u0 + i, v, 0, side, code]);
          s = ok ? i : -1; code = cd;
        }
      }
    }
  for (let i = 0; i < nx; i++)
    for (const side of [-1, 1]) {
      let s = -1, code = -1;
      for (let j = 0; j <= ny; j++) {
        const ok = j < ny && isL(i, j) && own[j * nx + i] && !isL(i + side, j);
        const cd = ok ? codeAt(i + side, j) : -1;
        if (ok && s < 0) { s = j; code = cd; }
        else if ((!ok || cd !== code) && s >= 0) {
          const u = u0 + i + (side > 0 ? 1 : 0);
          curbs.push([u, v0 + s, u, v0 + j, side, 0, code]);
          s = ok ? j : -1; code = cd;
        }
      }
    }
  const Gd = W.gdetail;
  Gd.k = K.CURB;
  const F = W.fine;
  for (const [ua, va, ub, vb, nu, nv, code] of curbs) {
    const L = Math.hypot(ub - ua, vb - va);
    // 靠围墙一侧（边界带/外部）不做路缘：斜边界的阶梯边很碎，且那里本来就是墙根绿化/铺装
    if (code === CODE.EDGE || code === CODE.OUT || code === CODE.HOLE) continue;
    const n = Math.max(1, Math.ceil(L / 16));
    for (let s = 0; s < n; s++) {
      const ta = s / n, tb = (s + 1) / n;
      const pa = [ua + (ub - ua) * ta, va + (vb - va) * ta], pb = [ua + (ub - ua) * tb, va + (vb - va) * tb];
      const ya = H(pa[0], pa[1]), yb = H(pb[0], pb[1]);
      const w = (u, v, y) => [c.ox + u * cs - v * sn, y, c.oz + u * sn + v * cs];
      // 外侧立面（朝外法线方向）
      const A = w(pa[0], pa[1], ya + 0.01), Bq = w(pb[0], pb[1], yb + 0.01), Cq = w(pb[0], pb[1], yb + LIFT.lawn + 0.02), Dq = w(pa[0], pa[1], ya + LIFT.lawn + 0.02);
      // 朝向：保证法线指向 (nu,nv)
      const dirOk = (ub - ua) * nv - (vb - va) * nu; // 叉积符号
      if (dirOk > 0) Gd.quadW(A, Bq, Cq, Dq, curbCol, [[pa[0], 0], [pb[0], 0], [pb[0], 1], [pa[0], 1]]);
      else Gd.quadW(Bq, A, Dq, Cq, curbCol, [[pb[0], 0], [pa[0], 0], [pa[0], 1], [pb[0], 1]]);
      // 顶面压条（向草坪内 0.12 m）
      const iu = -nu * 0.12, iv = -nv * 0.12;
      const E = w(pa[0] + iu, pa[1] + iv, ya + LIFT.lawn + 0.02), Fq = w(pb[0] + iu, pb[1] + iv, yb + LIFT.lawn + 0.02);
      if (dirOk > 0) Gd.quadW(Dq, Cq, Fq, E, curbCol, [[pa[0], pa[1]], [pb[0], pb[1]], [pb[0], pb[1]], [pa[0], pa[1]]]);
      else Gd.quadW(Cq, Dq, E, Fq, curbCol, [[pb[0], pb[1]], [pa[0], pa[1]], [pa[0], pa[1]], [pb[0], pb[1]]]);
    }
    // 绿篱：草坪临车行道/停车位一侧（新小区多，老小区少）
    if ((code === CODE.LANE || code === CODE.PARK) && L >= 4 && hash01(Math.round(ua), Math.round(va), c.pid + 3) < (oldM ? 0.3 : 0.75)) {
      const hgt = 0.6 + hash01(Math.round(ub), Math.round(vb), 4) * 0.35, wd = 0.8;
      const iu = -nu * (0.35 + wd / 2), iv = -nv * (0.35 + wd / 2);
      const m = Math.max(1, Math.ceil(L / 12));
      for (let s = 0; s < m; s++) {
        const ta = s / m + (s === 0 ? 0.03 : 0), tb = (s + 1) / m - (s === m - 1 ? 0.03 : 0);
        const pa = [ua + (ub - ua) * ta + iu, va + (vb - va) * ta + iv], pb = [ua + (ub - ua) * tb + iu, va + (vb - va) * tb + iv];
        const mu = (pa[0] + pb[0]) / 2, mv = (pa[1] + pb[1]) / 2;
        const x = c.ox + mu * cs - mv * sn, z = c.oz + mu * sn + mv * cs;
        const y = H(mu, mv) + LIFT.lawn;
        const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
        const yawH = Math.atan2((pb[0] - pa[0]) * cs - (pb[1] - pa[1]) * sn, (pb[0] - pa[0]) * sn + (pb[1] - pa[1]) * cs) - Math.PI / 2;
        F.setXf(x, y, z, yawH);
        const k = 0.85 + hash01(s, Math.round(mu), 5) * 0.3;
        F.box(-len / 2, 0, -wd / 2, len / 2, hgt, wd / 2, scl(hedgeCol, k), { colTop: scl(hedgeCol, k * 1.15) });
      }
    }
  }
  // —— 灌木球 / 花丛：散布在大块草坪里 ——
  const dens = oldM ? 1 / 150 : 1 / 70;
  const shrubCols = [[0.62, 0.7, 0.55], [0.72, 0.8, 0.62], [0.55, 0.62, 0.5], [0.8, 0.85, 0.6], [0.66, 0.72, 0.58], [0.95, 0.5, 0.42]]; // 叶簇贴图乘色（末项：红叶石楠）
  for (const [i, j, w, h] of rects) {
    if (w < 4 || h < 4) continue;
    const area = w * h;
    let n = area * dens;
    const nn = Math.floor(n) + (hash01(i, j, c.pid + 6) < n % 1 ? 1 : 0);
    for (let q = 0; q < nn; q++) {
      const u = u0 + i + 1 + hash01(i + q, j, 7) * (w - 2), v = v0 + j + 1 + hash01(i, j + q, 8) * (h - 2);
      const x = c.ox + u * cs - v * sn, z = c.oz + u * sn + v * cs;
      const y = H(u, v) + LIFT.lawn;
      const r = 0.5 + hash01(q, i + j, 9) * 0.6;
      const col = shrubCols[Math.floor(hash01(i, q, 10) * shrubCols.length)];
      // 灌木球用同一套树冠广告牌（叶簇贴图），压暗着色
      W.crowns.push(x, y + r * 0.85, z, r * 1.15, col[0], col[1], col[2]);
    }
  }
  // —— 小乔木（桂花、石楠、紫叶李、海棠一类 3~5 m 观赏树）：与植被模块的大树互补，宅间绿地不至于光秃 ——
  const tdens = oldM ? 1 / 240 : 1 / 160;
  const treeCols = [C('#ffffff'), C('#e8f0d8'), C('#d8e8c8'), C('#f4f0d0'), C('#c89aa8'), C('#e0ecd0'), C('#f0e8b8')]; // 叶簇贴图的乘色（含紫叶李、微黄）
  const trunkCol = C('#5a4632');
  for (const [i, j, w, h] of rects) {
    if (w < 6 || h < 6) continue;
    const n = w * h * tdens;
    const nn = Math.floor(n) + (hash01(i + 3, j, c.pid + 16) < n % 1 ? 1 : 0);
    for (let q = 0; q < nn; q++) {
      const u = u0 + i + 2 + hash01(i + q, j, 17) * (w - 4), v = v0 + j + 2 + hash01(i, j + q, 18) * (h - 4);
      const x = c.ox + u * cs - v * sn, z = c.oz + u * sn + v * cs;
      const y = H(u, v) + LIFT.lawn;
      const s = 0.8 + hash01(q, i + j, 19) * 0.6;
      const col = treeCols[Math.floor(hash01(j, q, 20) * treeCols.length)];
      F.setXf(x, y, z, hash01(q, j, 21) * 6.28);
      F.box(-0.08 * s, 0, -0.08 * s, 0.08 * s, 2.0 * s, 0.08 * s, trunkCol, { top: false });
      W.crowns.push(x, y + 2.9 * s, z, 1.75 * s, col[0], col[1], col[2]);
    }
  }
}

function dilate(g, nx, ny, from, to, onlyIf) {
  const add = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (g[j * nx + i] !== from) continue;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        if (g[b * nx + a] === onlyIf) add.push(b * nx + a);
      }
    }
  for (const k of add) g[k] = to;
}
function opening(g, nx, ny) {
  const er = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (g[k] !== CODE.LAWN) continue;
      const L = (a, b) => a >= 0 && b >= 0 && a < nx && b < ny && g[b * nx + a] === CODE.LAWN;
      // 横竖任一方向两侧都不是草坪（1 格宽细条）→ 去掉
      if ((!L(i - 1, j) && !L(i + 1, j)) || (!L(i, j - 1) && !L(i, j + 1))) er.push(k);
    }
  for (const k of er) g[k] = CODE.EDGE;
}
function stampCapsule(g, nx, ny, u0, v0, ua, va, ub, vb, r, val) {
  const ia = Math.max(0, Math.floor(Math.min(ua, ub) - r - u0)), ib = Math.min(nx - 1, Math.ceil(Math.max(ua, ub) + r - u0));
  const ja = Math.max(0, Math.floor(Math.min(va, vb) - r - v0)), jb = Math.min(ny - 1, Math.ceil(Math.max(va, vb) + r - v0));
  if (ia > ib || ja > jb) return;
  const du = ub - ua, dv = vb - va, l2 = du * du + dv * dv || 1e-9, r2 = r * r;
  for (let j = ja; j <= jb; j++) {
    const vc = v0 + j + 0.5;
    for (let i = ia; i <= ib; i++) {
      const k = j * nx + i;
      const cur = g[k];
      if (cur !== CODE.LAWN && cur !== CODE.APRON) continue;
      const uc = u0 + i + 0.5;
      let t = ((uc - ua) * du + (vc - va) * dv) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const eu = ua + du * t - uc, ev = va + dv * t - vc;
      if (eu * eu + ev * ev <= r2) g[k] = val;
    }
  }
}

// ————————————————————————————————————————————————————————————————————————————————
// 围墙与大门
// ————————————————————————————————————————————————————————————————————————————————
function genFence(S, W, c, x0, z0, x1, z1, X, Z, yaw) {
  const T = S.terrain, I = S.index;
  const inChunk = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
  if (c.area > 900000 || c.fence === 'none') return; // 特大用地（片区级）与推断的楼群范围不画围墙
  const kind = c.fence;
  const ironCol = [PAL.iron, PAL.iron, PAL.ironG, PAL.ironB][Math.floor(hash01(c.pid, 2, 3) * 4)];
  const wr = hash01(c.pid, 5, 6);
  const wallCol = kind === 'brick' ? (wr < 0.55 ? PAL.brick : wr < 0.85 ? C('#7d7a74') : PAL.plaster) : kind === 'lattice' ? C('#e2ddd2') : ironCol;
  const wk = kind === 'brick' ? (wallCol === PAL.brick ? 'brick' : 'plaster') : kind;
  // 道路净距：点到最近市政道路（不含小区内道路）的余量 = 距离 - 净距（<0 表示在路/人行道上）
  const roadClear = (x, z) => {
    let best = Infinity;
    I.rgrid.each(x - 1, z - 1, x + 1, z + 1, (id) => {
      const r = I.rsegs[id];
      const cls = r[5];
      if (cls >= 12) return;
      const dx = r[2] - r[0], dz = r[3] - r[1], l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - r[0]) * dx + (z - r[1]) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(r[0] + dx * t - x, r[1] + dz * t - z) - r[4];
      if (d < best) best = d;
    });
    return best;
  };
  const inBld = (x, z) => {
    let hit = false;
    I.bgrid.each(x, z, x, z, (b) => {
      if (hit) return;
      const bb = I.bbx;
      if (x < bb[b * 4] - 0.5 || x > bb[b * 4 + 2] + 0.5 || z < bb[b * 4 + 1] - 0.5 || z > bb[b * 4 + 3] + 0.5) return;
      const B = I.B, s = B.vs[b] * 2, n = B.vc[b], ax = B.ax[b], az = B.az[b];
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ax + B.offs[s + i * 2] * 0.1, zi = az + B.offs[s + i * 2 + 1] * 0.1, xj = ax + B.offs[s + j * 2] * 0.1, zj = az + B.offs[s + j * 2 + 1] * 0.1;
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) hit = true;
    });
    return hit;
  };
  // 与编号更小的已规划小区共边 → 由对方画
  const sharedEdge = (x, z) => {
    for (const oid of S.chunkMap.get(Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK)) || []) {
      if (oid >= c.id) continue;
      const o = S.list[oid];
      if (x < o.bb[0] - 3 || x > o.bb[2] + 3 || z < o.bb[1] - 3 || z > o.bb[3] + 3) continue;
      if (ringDist(x, z, o.ring) < 2.5) return true;
    }
    return false;
  };
  // 大门（局部 → 世界）：沿门的内向方向推到道路净距之外，得到门线位置
  const gates = [];
  for (const g of c.gates) {
    let u = g.u, v = g.v;
    for (let t = 0; t < 14; t += 1) {
      const x = X(u, v), z = Z(u, v);
      if (roadClear(x, z) > 0.2) break;
      u += g.du; v += g.dv;
    }
    const W0 = c.LW + 3.4;
    gates.push({ ...g, gu: u, gv: v, x: X(u, v), z: Z(u, v), W: W0 });
  }
  // 门洞附近不画围墙：到任一门点的距离 < W/2
  const nearGate = (x, z) => {
    if (gates.some((g) => Math.hypot(g.x - x, g.z - z) < g.W / 2 + 0.2 || Math.hypot(X(g.u, g.v) - x, Z(g.u, g.v) - z) < g.W / 2 + 0.2)) return true;
    // 任何小区（含相邻小区）的大门通道
    let hit = false;
    if (I.ggrid)
      I.ggrid.each(x, z, x, z, (k) => {
        if (hit) return;
        const q = I.gateLanes[k];
        const dx = q[2] - q[0], dz = q[3] - q[1], l2 = dx * dx + dz * dz || 1e-9;
        let t = ((x - q[0]) * dx + (z - q[1]) * dz) / l2;
        if (t < 0 || t > 1) return;
        if (Math.hypot(q[0] + dx * t - x, q[1] + dz * t - z) < q[4]) hit = true;
      });
    return hit;
  };

  // 边界逐段：重采样（≤ 3 m）→ 每点推离道路 → 去掉压楼/门洞/共边/精建区的点 → 连续段画围墙
  const ring = c.ring, n = ring.length / 2;
  // 内法线方向：多边形面积符号
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  const sgn = area > 0 ? 1 : -1;
  const A = W.alpha, Co = W.coarse;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    // 快速剔除：线段与本块无交
    if (Math.max(ax, bx) < x0 - 5 || Math.min(ax, bx) > x1 + 5 || Math.max(az, bz) < z0 - 5 || Math.min(az, bz) > z1 + 5) continue;
    const tx = (bx - ax) / L, tz = (bz - az) / L;
    // 内法线：(tz, -tx) * sgn 指向哪侧取决于环向
    let nxn = -tz * sgn, nzn = tx * sgn;
    // 用点测核实
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (!pip(mx + nxn * 1.5, mz + nzn * 1.5, ring)) { nxn = -nxn; nzn = -nzn; }
    const m = Math.max(1, Math.ceil(L / 3));
    const pts = [];
    for (let k = 0; k <= m; k++) {
      let x = ax + (bx - ax) * (k / m), z = az + (bz - az) * (k / m);
      const rc = roadClear(x, z);
      let push = 0;
      if (rc < 0.3) push = 0.3 - rc;
      if (push > 10) { pts.push(null); continue; }
      x += nxn * push; z += nzn * push;
      // 推开后仍在路面/人行道上（边界斜穿道路时内法线沿路方向，推不出去）→ 不画
      if (push > 0 && roadClear(x, z) < -0.2) { pts.push(null); continue; }
      if (inBld(x, z) || nearGate(x, z) || S.excluded(x, z) || sharedEdge(ax + (bx - ax) * (k / m), az + (bz - az) * (k / m))) { pts.push(null); continue; }
      pts.push([x, z]);
    }
    // 连续可画的点合并成跨段（共线、≤ 24 m、段中点在本块且不压楼），一跨一个墙体/基座 + 一片栏杆；立柱进“近看”集合
    let run = [];
    const flushRun = () => {
      if (run.length >= 2) {
        let s0 = 0;
        for (let k = 1; k < run.length; k++) {
          const a = run[s0], b = run[k];
          const L2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
          // 下一点若偏离 a→b 方向 > 0.08 m 或跨长超 24 m，就在 k 处截断
          let cut = L2 > 24 || k === run.length - 1;
          if (!cut && k + 1 < run.length) {
            const c2 = run[k + 1];
            const ux = (b[0] - a[0]) / (L2 || 1), uz = (b[1] - a[1]) / (L2 || 1);
            const off = Math.abs((c2[0] - a[0]) * uz - (c2[1] - a[1]) * ux);
            if (off > 0.08) cut = true;
          }
          if (cut) {
            const p = run[s0], q = run[k];
            const midx = (p[0] + q[0]) / 2, midz = (p[1] + q[1]) / 2;
            if (inChunk(midx, midz) && !inBld(midx, midz) && roadClear(midx, midz) > -0.2) {
              fenceSpan(Co, A, W.fine, p[0], T.heightAt(p[0], p[1]), p[1], q[0], T.heightAt(q[0], q[1]), q[1], nxn, nzn, wk, wallCol);
              W.stats.fence += Math.hypot(q[0] - p[0], q[1] - p[1]);
            }
            s0 = k;
          }
        }
      }
      run = [];
    };
    for (let k = 0; k <= m; k++) {
      if (pts[k]) run.push(pts[k]);
      else flushRun();
    }
    flushRun();
  }
  // 大门构件
  const name = c.name && !GENERIC_NAME.test(c.name) ? c.name.replace(/[（(].*?[)）]/g, '').trim() : '';
  for (const g of gates) {
    if (!inChunk(g.x, g.z) || S.excluded(g.x, g.z)) continue;
    const y = T.heightAt(g.x, g.z);
    const yw = yaw(g.du, g.dv);
    W.gates.push([g.x + Math.sin(yw) * 5, y + 3.2, g.z + Math.cos(yw) * 5]);
    if (g.photo) continue; // 有照片依据的门楼由通用建筑模块画
    const style = c.uni ? 'campus' : c.old ? 'old' : hash01(c.pid, 8, 9) < 0.6 ? 'modern' : 'wall';
    Co.setXf(g.x, y, g.z, yw);
    const sign = g.main || style === 'wall' ? gateFrame(Co, g.W, style, c.pid) : null;
    if (sign && name) {
      // 门牌：局部 (x, y, z) → 世界；牌面朝外（-z 方向，即朝街）
      const sx = g.x + sign.x * Math.cos(yw) + sign.z * Math.sin(yw), sz = g.z - sign.x * Math.sin(yw) + sign.z * Math.cos(yw);
      W.signs.push({ x: sx, y: y + sign.y, z: sz, yaw: yw + Math.PI, w: sign.w, h: sign.h, text: name, uni: c.uni, old: c.old });
    }
    // 岗亭（门内侧一边）+ 道闸
    const side = hash01(c.pid, g.gu | 0, 4) < 0.5 ? -1 : 1;
    const bx = side * (g.W / 2 + 1.6), bz = 2.6;
    Co.setXf(g.x + bx * Math.cos(yw) + bz * Math.sin(yw), y + 0.02, g.z - bx * Math.sin(yw) + bz * Math.cos(yw), yw);
    booth(Co, W.glow);
    pool(W.pool, g.x + 2 * Math.sin(yw), y + 0.27, g.z + 2 * Math.cos(yw), 9, 1.2);
    // 道闸：机箱在岗亭一侧车道边，闸杆横跨车道（进/出两根）
    for (const [off, dirS] of [[1.2, -side], [3.6, side]]) {
      const ex = -dirS * (c.LW / 2 + 0.25);
      Co.setXf(g.x + ex * Math.cos(yw) + off * Math.sin(yw), y + 0.05, g.z - ex * Math.sin(yw) + off * Math.cos(yw), yw + (dirS > 0 ? 0 : Math.PI));
      barrier(Co, { len: c.LW / 2 + 0.3, body: c.old ? PAL.yellow : C('#d8dadc') });
    }
  }
}
