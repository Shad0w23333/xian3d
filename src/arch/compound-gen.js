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
//   crowns   小乔木树冠与灌木球（广告牌实例）[x, y, z, 半径, r, g, b, 扁度]
//   bigCrowns 宅间大树树冠（同上，显示得更远）
//   flowers  花坛花丛（广告牌实例）[x, y, z, 半径, 花色 r, g, b]
//   signs    门头名称牌 {x, y, z, yaw, w, h, text}
//   gates    大门位置（夜间点光源候选）
// 生成器函数：每个小区按阶段（道路停车 → 设施 → 每 125 m 小方块的草坪栅格 → 围墙大门）让出，由模块按帧时间预算推进。
import { K, GeoWriter, C, PAL, mix, scl, booth, barrier, gateFrame, fenceSpan, fitness, playground, pavilion, bikeShed, trashKiosk, locker, hoop, flagpole, lamp, bench, garageRamp, twoWheeler, clothesLine } from './compound-props.js';
import { CHUNK, pip, ringDist, hash01, obbObb, obbRect } from './compound-plan.js';
import { pickCarColor } from './traffic_models.js';
import { drawField } from './compound-sports.js';

export { K };

const LIFT = { lane: 0.05, park: 0.06, paint: 0.075, path: 0.07, apron: 0.06, pad: 0.08, lawn: 0.17, curb0: 0.0 };
const GENERIC_NAME = /^(社区|小区|家属|住宅|住宅区|居民区|居住区|家属院|宿舍|新村|生活区|村)$/;
const PARA_L = 6.0, PARA_D = 2.4; // 平行车位（与 compound-plan.js 一致）
const CAR_H1 = 2.42, CAR_H2 = 0.97; // 停放车辆占位半长/半宽（车长 4.6~4.75 m、车宽 1.8 m + 后视镜）
// 花丛配色（线性 RGB，降饱和：月季红、萱草黄、鼠尾草紫、白晶菊、粉色矮牵牛）
const FLOWER_COLS = [[0.5, 0.09, 0.1], [0.62, 0.42, 0.08], [0.3, 0.17, 0.42], [0.72, 0.7, 0.62], [0.62, 0.26, 0.36]];

/** 局部四边形贴地（任意朝向）：按世界坐标叉积保证法线朝上 */
function quadUp(Gt, a, b, c, d, col, uv) {
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  if (ny >= 0) Gt.quadW(a, b, c, d, col, uv);
  else Gt.quadW(d, c, b, a, col, uv && [uv[3], uv[2], uv[1], uv[0]]);
}

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
    crowns: [], // 树冠/灌木球（广告牌实例）[x, y, z, 半径, r, g, b, 扁度]
    bigCrowns: [], // 宅间大树树冠（同上；显示距离与远看实体一致，大树远看不能只剩树干）
    flowers: [], // 花坛花丛（广告牌实例）[x, y, z, 半径, 花色 r, g, b]
    pool: new GeoWriter({ uv: true }),
    cars: [],
    signs: [],
    gates: [],
    stats: { lawn: 0, cars: 0, fence: 0, pads: 0, v: {}, tri: {} },
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
  // 车辆占位：小区局部坐标里的旋转矩形，互不相交、不压设施（原先抖动/路边乱停/OSM 路旁车位各放各的，
  // 车辆互相穿插、斜压在别的车上，审查 g4 P1）
  const carBoxes = [];
  const placeCar = (u, v, du, dv, rot, r) => {
    const ca = Math.cos(rot), sa = Math.sin(rot);
    const cdu = du * ca - dv * sa, cdv = du * sa + dv * ca;
    for (const b of carBoxes) if (Math.abs(b[0] - u) < 5.2 && Math.abs(b[1] - v) < 5.2 && obbObb(u, v, cdu, cdv, CAR_H1, CAR_H2, b[0], b[1], b[2], b[3], CAR_H1, CAR_H2)) return false;
    for (const p of c.pads) if (obbRect(u, v, cdu, cdv, CAR_H1, CAR_H2, p.u0 - 0.3, p.u1 + 0.3, p.v0 - 0.3, p.v1 + 0.3)) return false;
    carBoxes.push([u, v, cdu, cdv]);
    addCar(W, S, X(u, v), Z(u, v), yaw(cdu, cdv), r);
    return true;
  };
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
      const jl = messy ? (hh(k, p.u0, 5) - 0.5) * 0.5 : (hh(k, p.u0, 5) - 0.5) * 0.15;
      const jc = messy ? (hh(k, p.v0, 6) - 0.5) * 0.35 : (hh(k, p.v0, 6) - 0.5) * 0.12;
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
      const jy = (hh(k, p.u0 + p.v0, 9) - 0.5) * (messy ? 0.16 : 0.05);
      placeCar(u, v, du, dv, jy, hh(k * 3, p.v0 + p.u1, 12));
    }
  }
  // 老小区：沿车行道一侧路边停车（不画车位线，约六成泊位有车），车身贴车行道边缘、顺车行道方向，不停在路口上
  if (oldM) {
    for (const L of c.lanes) {
      if (L.kind !== 'lane' || !centerIn(L.u0, L.u1, L.v0, L.v1)) continue;
      const along = L.dir === 0;
      const len = along ? L.u1 - L.u0 : L.v1 - L.v0;
      const side = hh(L.u0, L.v0, 21) < 0.5 ? -1 : 1;
      let t = 4 + hh(L.u1, L.v1, 22) * 4;
      while (t < len - 4) {
        const r = hh(t, L.u0 + L.v0, 23);
        if (r < 0.62) {
          const off = side < 0 ? (along ? L.v0 + 1.05 : L.u0 + 1.05) : along ? L.v1 - 1.05 : L.u1 - 1.05;
          const u = along ? L.u0 + t : off, v = along ? off : L.v0 + t;
          const x = X(u, v), z = Z(u, v);
          const junction = c.lanes.some((M) => M !== L && u > M.u0 - 3.5 && u < M.u1 + 3.5 && v > M.v0 - 3.5 && v < M.v1 + 3.5);
          const fwd = r < 0.31 ? 1 : -1;
          if (!junction && inChunk(x, z)) placeCar(u, v, along ? fwd : 0, along ? 0 : fwd, (r - 0.31) * 0.1, hh(t, L.v1, 24));
        }
        t += 5.0 + hh(t, L.v0, 25) * 2.4;
      }
    }
  }
  // 小区内 OSM 道路旁平行车位（规划时已逐个核验不压楼/车行道/设施）：铺装 + 车位端线 + 约七成有车
  {
    const slotCol = oldM ? C('#8f8c86') : C('#7f8a6c'), slotK = oldM ? K.CONCRETE : K.GRASSPAVE;
    for (const [su, sv, du, dv] of c.osmSlots || []) {
      const x = X(su, sv), z = Z(su, sv);
      if (!inChunk(x, z) || ex(x, z)) continue;
      const hl = PARA_L / 2 - 0.15, hw = PARA_D / 2, nu = -dv, nv = du;
      const Q = (a, b, lift) => { const u = su + du * a + nu * b, v = sv + dv * a + nv * b, xx = X(u, v), zz = Z(u, v); return [xx, T.heightAt(xx, zz) + lift, zz]; };
      const UV = (a, b) => [su + du * a + nu * b, sv + dv * a + nv * b];
      G.k = slotK;
      quadUp(G, Q(-hl, -hw, LIFT.park), Q(hl, -hw, LIFT.park), Q(hl, hw, LIFT.park), Q(-hl, hw, LIFT.park), slotCol, [UV(-hl, -hw), UV(hl, -hw), UV(hl, hw), UV(-hl, hw)]);
      if (!oldM) {
        W.gdetail.k = K.PAINT;
        for (const a of [-hl, hl]) quadUp(W.gdetail, Q(a - 0.05, -hw, LIFT.paint), Q(a + 0.05, -hw, LIFT.paint), Q(a + 0.05, hw, LIFT.paint), Q(a - 0.05, hw, LIFT.paint), paint, [UV(a, -hw), UV(a, -hw), UV(a, hw), UV(a, hw)]);
      }
      if (hh(su, sv, 31) < 0.7) placeCar(su, sv, du, dv, hh(su, sv, 32) < 0.5 ? 0 : Math.PI, hh(su, sv, 33));
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
  // —— 5b. 宅间大树（老小区：车行道两侧成排 + 宅间绿地按 9~10 m 一棵，规划见 compound-plan.js 第 9 步）+ 树池 ——
  //        西安八九十年代单位家属院楼间多是和楼一样高的法桐、国槐、杨树，树冠连片（审查 fe_土门老小区 / fe_西工大老小区）
  if (c.bigTrees && c.bigTrees.length) {
    const pitSoil = C('#4a3f33'), pitCurb = C('#a9a49a');
    for (const [u, v, h, rr] of c.bigTrees) {
      const x = X(u, v), z = Z(u, v);
      if (!inChunk(x, z) || ex(x, z)) continue;
      const y = T.heightAt(x, z);
      bigTree(W, x, y - 0.02, z, h, rr);
      // 树池：1.4 m 见方的土面 + 一圈水泥边（落在水泥地上可见；落在草坪里被草面盖住）
      const hp = 0.7, cw = 0.1;
      const Q = (a, b, lift) => { const uu = u + a, vv = v + b, xx = X(uu, vv), zz = Z(uu, vv); return [xx, T.heightAt(xx, zz) + lift, zz]; };
      G.k = K.SOIL;
      quadUp(G, Q(-hp, -hp, 0.048), Q(hp, -hp, 0.048), Q(hp, hp, 0.048), Q(-hp, hp, 0.048), pitSoil, [[u - hp, v - hp], [u + hp, v - hp], [u + hp, v + hp], [u - hp, v + hp]]);
      W.gdetail.k = K.CURB;
      for (const [a0, a1, b0, b1] of [[-hp - cw, hp + cw, -hp - cw, -hp], [-hp - cw, hp + cw, hp, hp + cw], [-hp - cw, -hp, -hp, hp], [hp, hp + cw, -hp, hp]])
        quadUp(W.gdetail, Q(a0, b0, 0.075), Q(a1, b0, 0.075), Q(a1, b1, 0.075), Q(a0, b1, 0.075), pitCurb, [[u + a0, v + b0], [u + a1, v + b0], [u + a1, v + b1], [u + a0, v + b1]]);
    }
  }
  yield 'pads';
  // —— 6. 草坪（栅格 → 合并矩形）、路缘、绿篱、灌木 ——
  // 按 125 m 小方块逐块栅格化（每块 ≤ 3 万格），每块之后让出一次，单步耗时有上限
  const SUB = 125;
  for (let sx = x0; sx < x1; sx += SUB)
    for (let sz = z0; sz < z1; sz += SUB) {
      if (sx + SUB < c.bb[0] || sx > c.bb[2] || sz + SUB < c.bb[1] || sz > c.bb[3]) continue;
      yield* genLawns(S, W, c, sx, sz, sx + SUB, sz + SUB);
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
// 草坪：1 m 栅格分类 + 角点解析距离 → 等值线（marching squares）出平滑边界
// ————————————————————————————————————————————————————————————————————————————————
// 栅格只用来知道“哪些格附近有什么障碍”：每个非草坪格记下把它占掉的障碍（矩形/胶囊/多边形，局部坐标），
// 格点上取附近各障碍的解析有符号距离的最小值 F（> 0 = 空地）。草坪边界 = F 的 0 等值线：斜向道路、斜楼、斜围墙边
// 都是直线/平滑曲线，不再是 1 m 一级的直角台阶（审查 st_chanba_road / fe_曲江小区：路缘石走成锯齿）。
// 内部整格仍按矩形合并（三角形数与原来相当），只有边界格出多边形。
const CODE = { OUT: 0, LAWN: 1, BLD: 2, LANE: 3, PARK: 4, PATH: 5, APRON: 6, PAD: 7, ROAD: 8, EDGE: 9, HOLE: 10, BASE: 11, FC: 12, FIELD: 13 };
const FCAP = 3.2; // 格点到障碍的距离只精确算到 3.2 m（更远的按 3.2 m）
const LIFT_BASE = 0.04; // 老小区水泥地 / 临街铺装（压在车行道 0.05、车位 0.06、园路 0.07 之下，边缘塞进它们底下不留缝）
const STREET_CLS = new Set([1, 2, 3, 4, 5, 7, 12]); // 与通用建筑模块“临街底商”判定同一组道路等级（buildings.js packRoads）

function segD2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px, ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}
/** 点到多边形的有符号距离（内负外正） */
function sdPoly(u, v, r) {
  let d2 = Infinity, ins = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const ui = r[i], vi = r[i + 1], uj = r[j], vj = r[j + 1];
    if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) ins = !ins;
    const d = segD2(u, v, uj, vj, ui, vi);
    if (d < d2) d2 = d;
  }
  const d = Math.sqrt(d2);
  return ins ? -d : d;
}
/**
 * 多边形障碍源（局部环 r，外扩 off）：顶点多（楼群小区把相邻用地整块当洞，环上几百个点）时建 8 m 边网格 + 2 m 行带，
 * 求距离只看附近的边、判内外只看本行带的边
 */
function polySrc(r, off) {
  const o = { t: 2, r, off, n: r.length / 2 };
  if (o.n > 24) {
    const grid = new Map(), bands = new Map();
    const put = (m, k, e) => { const a = m.get(k); if (a) a.push(e); else m.set(k, [e]); };
    for (let i = 0, j = o.n - 1; i < o.n; j = i++) {
      const ua = r[j * 2], va = r[j * 2 + 1], ub = r[i * 2], vb = r[i * 2 + 1];
      for (let gx = Math.floor(Math.min(ua, ub) / 8); gx <= Math.floor(Math.max(ua, ub) / 8); gx++)
        for (let gy = Math.floor(Math.min(va, vb) / 8); gy <= Math.floor(Math.max(va, vb) / 8); gy++) put(grid, gx * 100003 + gy, i);
      for (let b = Math.floor(Math.min(va, vb) / 2); b <= Math.floor(Math.max(va, vb) / 2); b++) put(bands, b, i);
    }
    o.grid = grid;
    o.bands = bands;
  }
  return o;
}
function phiPoly(o, u, v) {
  if (!o.grid) return sdPoly(u, v, o.r) - o.off;
  const r = o.r, n = o.n;
  let d2 = 64;
  const gx = Math.floor(u / 8), gy = Math.floor(v / 8);
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++) {
      const es = o.grid.get((gx + a) * 100003 + gy + b);
      if (!es) continue;
      for (const i of es) { const j = (i + n - 1) % n; const d = segD2(u, v, r[j * 2], r[j * 2 + 1], r[i * 2], r[i * 2 + 1]); if (d < d2) d2 = d; }
    }
  let ins = false;
  const es = o.bands.get(Math.floor(v / 2));
  if (es)
    for (const i of es) {
      const j = (i + n - 1) % n;
      const ui = r[i * 2], vi = r[i * 2 + 1], uj = r[j * 2], vj = r[j * 2 + 1];
      if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) ins = !ins;
    }
  const d = Math.sqrt(d2);
  return (ins ? -d : d) - o.off;
}
/**
 * 倒角距离（格）：每格到最近的 m[k] === target 格的距离（两遍扫描，8 邻域）。
 * 行首/行尾、首行/末行单独展开，内层不再逐格判边界（每格的候选与取最小、写回 Float32 的时机与逐格判边界的写法完全一致）
 */
function chamfer(m, target, nx, ny) {
  const N = nx * ny;
  const D = new Float32Array(N);
  for (let k = 0; k < N; k++) D[k] = m[k] === target ? 0 : 1e6;
  if (!N) return D;
  const L = nx - 1;
  // 正向：左、上、左上、右上
  for (let i = 1; i < nx; i++) { const d = D[i]; if (!d) continue; const t = D[i - 1] + 1; if (t < d) D[i] = t; }
  for (let j = 1; j < ny; j++) {
    const r = j * nx;
    {
      let d = D[r];
      if (d) {
        let t = D[r - nx] + 1; if (t < d) d = t;
        if (L > 0) { t = D[r - nx + 1] + 1.414; if (t < d) d = t; }
        D[r] = d;
      }
    }
    for (let k = r + 1, e = r + L; k < e; k++) {
      let d = D[k];
      if (!d) continue;
      let t = D[k - 1] + 1; if (t < d) d = t;
      t = D[k - nx] + 1; if (t < d) d = t;
      t = D[k - nx - 1] + 1.414; if (t < d) d = t;
      t = D[k - nx + 1] + 1.414; if (t < d) d = t;
      D[k] = d;
    }
    if (L > 0) {
      const k = r + L;
      let d = D[k];
      if (d) {
        let t = D[k - 1] + 1; if (t < d) d = t;
        t = D[k - nx] + 1; if (t < d) d = t;
        t = D[k - nx - 1] + 1.414; if (t < d) d = t;
        D[k] = d;
      }
    }
  }
  // 反向：右、下、右下、左下
  {
    const r = (ny - 1) * nx;
    for (let i = L - 1; i >= 0; i--) { const k = r + i, d = D[k]; if (!d) continue; const t = D[k + 1] + 1; if (t < d) D[k] = t; }
  }
  for (let j = ny - 2; j >= 0; j--) {
    const r = j * nx;
    {
      const k = r + L;
      let d = D[k];
      if (d) {
        let t = D[k + nx] + 1; if (t < d) d = t;
        if (L > 0) { t = D[k + nx - 1] + 1.414; if (t < d) d = t; }
        D[k] = d;
      }
    }
    for (let k = r + L - 1; k > r; k--) {
      let d = D[k];
      if (!d) continue;
      let t = D[k + 1] + 1; if (t < d) d = t;
      t = D[k + nx] + 1; if (t < d) d = t;
      t = D[k + nx + 1] + 1.414; if (t < d) d = t;
      t = D[k + nx - 1] + 1.414; if (t < d) d = t;
      D[k] = d;
    }
    if (L > 0) {
      const k = r;
      let d = D[k];
      if (d) {
        let t = D[k + 1] + 1; if (t < d) d = t;
        t = D[k + nx] + 1; if (t < d) d = t;
        t = D[k + nx + 1] + 1.414; if (t < d) d = t;
        D[k] = d;
      }
    }
  }
  return D;
}
/** 世界坐标三角形贴地：保证法线朝上 */
function triUp(Gt, a, b, c, col, ua, ub, uc) {
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  if (ny >= 0) Gt.triW(a, b, c, col, ua, ub, uc);
  else Gt.triW(a, c, b, col, ua, uc, ub);
}

/**
 * 草坪：纯计算（lawnOps，生成器：一个小方块分几步算完、中途让出）记成出图指令，再在主线程按原顺序回放（replayLawns）。
 * 纯计算不碰地形高度与写入器，可整段放进 Worker（compound-pool.js）；回放与原来边算边出图的结果逐位相同。
 */
function* genLawns(S, W, c, x0, z0, x1, z1) {
  const ops = yield* lawnOps(S, c, x0, z0, x1, z1);
  if (ops) replayLawns(S, W, c, ops);
}

/** 草坪纯计算：返回出图指令（Float64Array，见 LawnOps），小方块与小区不相交时返回 undefined */
export function* lawnOps(S, c, x0, z0, x1, z1) {
  const E = new LawnOps();
  const { cs, sn, ox, oz } = c;
  const oldM = c.mode === 'old';
  const toU = (x, z) => (x - ox) * cs + (z - oz) * sn, toV = (x, z) => -(x - ox) * sn + (z - oz) * cs;
  // 块（世界正方形）→ 局部外接框，与小区局部外接框求交；栅格再外扩 6 格（格点解析距离要看到窗口外的障碍，相邻小方块接缝一致）
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
    const u = toU(x, z), v = toV(x, z);
    a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, v); b1 = Math.max(b1, v);
  }
  const ia0 = Math.max(a0, c.U0), ia1 = Math.min(a1, c.U1), ib0 = Math.max(b0, c.V0), ib1 = Math.min(b1, c.V1);
  if (ia1 - ia0 <= -2 || ib1 - ib0 <= -2) return;
  const u0 = Math.floor(ia0 - 6), v0 = Math.floor(ib0 - 6);
  const nx = Math.ceil(ia1 + 6 - u0), ny = Math.ceil(ib1 + 6 - v0);
  if (nx * ny > 900000) return;
  const g = new Uint8Array(nx * ny); // CODE
  const own = new Uint8Array(nx * ny); // 格心在本块内
  const src = new Int32Array(nx * ny).fill(-1); // 占格的解析障碍（SR 下标）；-1 = 无（栅格判定的，按格边算）
  const SR = []; // {t:0 矩形 a,b,c,d | t:1 胶囊 ua,va,ub,vb,r | t:2 多边形 r,off}
  // 登记解析源：记下外接框（局部坐标）与占格代码，算格点距离时按源遍历附近格点
  const addSrc = (o, code = CODE.OUT) => {
    o.code = code;
    if (o.t === 0) o.bb = [o.a, o.b, o.c, o.d];
    else if (o.t === 1) o.bb = [Math.min(o.ua, o.ub) - o.r, Math.max(o.ua, o.ub) + o.r, Math.min(o.va, o.vb) - o.r, Math.max(o.va, o.vb) + o.r];
    else {
      const r = o.t === 3 ? o.o.r : o.r, off = o.t === 3 ? 0 : o.off;
      let a = Infinity, b = -Infinity, cc = Infinity, d = -Infinity;
      for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); b = Math.max(b, r[i]); cc = Math.min(cc, r[i + 1]); d = Math.max(d, r[i + 1]); }
      o.bb = [a - off, b + off, cc - off, d + off];
    }
    SR.push(o);
    return SR.length - 1;
  };
  // 1. 多边形内部（扫描线）
  const fillRing = (rf, val, onlyIf = -1, s = -1) => {
    const nE = rf.length / 2;
    // 只扫环的纵向范围内的行：格心 vc 不在 [环最低, 环最高) 内的行没有交点（结果与逐行全扫相同；环含 NaN 时退回全扫）
    let vmn = Infinity, vmx = -Infinity, bad = false;
    for (let q = 1; q < rf.length; q += 2) {
      const v = rf[q];
      if (v < vmn) vmn = v;
      if (v > vmx) vmx = v;
      if (v !== v) bad = true;
    }
    const ja = bad ? 0 : Math.max(0, Math.floor(vmn - v0 - 0.5)), jb = bad ? ny - 1 : Math.min(ny - 1, Math.ceil(vmx - v0));
    for (let j = ja; j <= jb; j++) {
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
          if (onlyIf < 0 || g[k] === onlyIf) { g[k] = val; src[k] = s; }
        }
      }
    }
  };
  fillRing(c.rf, CODE.LAWN);
  const inR = new Uint8Array(nx * ny); // 格心在小区边界内
  for (let k = 0; k < nx * ny; k++) inR[k] = g[k] === CODE.LAWN ? 1 : 0;
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
  for (const h of c.holes || []) { const r = toF(h); fillRing(r, CODE.HOLE, CODE.LAWN, addSrc(polySrc(r, 0), CODE.HOLE)); }
  // 3. 楼（真实轮廓）：楼格与外扩 1 m 的散水格共用一个解析源（楼轮廓外扩 1 m）
  const I = S.index, B = I.B;
  const wx0 = Math.min(x0, c.bb[0]) - 5, wx1 = Math.max(x1, c.bb[2]) + 5, wz0 = Math.min(z0, c.bb[1]) - 5, wz1 = Math.max(z1, c.bb[3]) + 5;
  const seen = new Set();
  const bx0 = Math.max(wx0, x0 - 60), bx1 = Math.min(wx1, x1 + 60), bz0 = Math.max(wz0, z0 - 60), bz1 = Math.min(wz1, z1 + 60);
  const blds = []; // [b, 局部环]
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
    fillRing(r, CODE.BLD, -1, addSrc(polySrc(r, 1.0), CODE.BLD));
    blds.push([b, r]);
  });
  // 外扩 1 格（散水/墙根铺装），沿用楼的解析源
  dilate(g, src, nx, ny, CODE.BLD, CODE.APRON, CODE.LAWN);
  // 4. 规划矩形
  const fillRect = (ua, ub, va, vb, val) => {
    const ia = Math.max(0, Math.floor(ua - u0)), ib = Math.min(nx - 1, Math.ceil(ub - u0) - 1);
    const ja = Math.max(0, Math.floor(va - v0)), jb = Math.min(ny - 1, Math.ceil(vb - v0) - 1);
    if (ia > ib || ja > jb) return;
    const s = addSrc({ t: 0, a: ua, b: ub, c: va, d: vb }, val);
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) { const k = j * nx + i; if (g[k] === CODE.LAWN || g[k] === CODE.APRON) { g[k] = val; src[k] = s; } }
  };
  for (const L of c.lanes) fillRect(L.u0 - 0.3, L.u1 + 0.3, L.v0 - 0.3, L.v1 + 0.3, CODE.LANE);
  for (const p of c.parks) fillRect(p.u0 - 0.2, p.u1 + 0.2, p.v0 - 0.2, p.v1 + 0.2, CODE.PARK);
  for (const p of c.paths) fillRect(p.u0 - 0.2, p.u1 + 0.2, p.v0 - 0.2, p.v1 + 0.2, CODE.PATH);
  for (const p of c.aprons) fillRect(p.u0, p.u1, p.v0, p.v1, CODE.APRON);
  for (const p of c.pads) fillRect(p.u0 - 0.6, p.u1 + 0.6, p.v0 - 0.6, p.v1 + 0.6, CODE.PAD);
  // 小区内 OSM 道路旁的平行车位（斜向，按旋转矩形的多边形登记）
  for (const [su, sv, du, dv] of c.osmSlots || []) {
    const hl = 3.15, hw = 1.4, nu = -dv, nv = du;
    const r = new Float64Array([su - du * hl - nu * hw, sv - dv * hl - nv * hw, su + du * hl - nu * hw, sv + dv * hl - nv * hw, su + du * hl + nu * hw, sv + dv * hl + nv * hw, su - du * hl + nu * hw, sv - dv * hl + nv * hw]);
    const s = addSrc(polySrc(r, 0), CODE.PARK);
    fillRing(r, CODE.PARK, CODE.LAWN, s);
    fillRing(r, CODE.PARK, CODE.APRON, s);
  }
  for (const fi of c.fields || []) {
    const f = I.sports[fi];
    const r = toF(f.p);
    const s = addSrc(polySrc(r, 0), CODE.FIELD);
    fillRing(r, CODE.FIELD, CODE.LAWN, s);
    fillRing(r, CODE.FIELD, CODE.APRON, s);
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
      const ua = toU(r[0], r[1]), va = toV(r[0], r[1]), ub = toU(r[2], r[3]), vb = toV(r[2], r[3]);
      stampCapsule(g, src, nx, ny, u0, v0, ua, va, ub, vb, rad, CODE.ROAD, addSrc({ t: 1, ua, va, ub, vb, r: rad }, CODE.ROAD));
    });
  }
  // 底层（老小区水泥地 / 临街铺装）的边界只看：小区边界、市政道路、洞（内层用地/排除区）、运动场地——
  // 车行道、车位、园路、楼都压在底层之上，不必绕开
  const bsel = new Int32Array(nx * ny).fill(-1), bk = new Uint8Array(nx * ny);
  {
    const ringS = addSrc({ t: 3, o: polySrc(c.rf, 0) });
    for (let k = 0; k < nx * ny; k++) {
      if (!inR[k]) { bk[k] = 1; bsel[k] = ringS; }
      else if (g[k] === CODE.ROAD || g[k] === CODE.HOLE || g[k] === CODE.FIELD) { bk[k] = 1; bsel[k] = src[k]; }
    }
  }
  // 6. 围墙内侧 1.6 m 留作铺装/绿化带（边界外扩带）
  {
    const rf = c.rf, nE = rf.length / 2;
    for (let i = 0, k = nE - 1; i < nE; k = i++) {
      const ua = rf[k * 2], va = rf[k * 2 + 1], ub = rf[i * 2], vb = rf[i * 2 + 1];
      stampCapsule(g, src, nx, ny, u0, v0, ua, va, ub, vb, 1.6, CODE.EDGE, addSrc({ t: 1, ua, va, ub, vb, r: 1.6 }, CODE.EDGE));
    }
  }
  // 精建排除区：2×2 格抽样（草坪格与底层可铺格）；与排除块相邻的格再逐格复核（排除区边缘不留整块草皮，审查 st_sajinqiao）
  // 抽样点都在局部矩形 [u0, u0+nx] × [v0, v0+ny] 内：按它的世界外接框（外扩 1 m）先挑出附近的排除区，没有就整段跳过（结果相同）
  let excF = S.excluded;
  if (S.excludedIn) {
    let ex0 = Infinity, ex1 = -Infinity, ez0 = Infinity, ez1 = -Infinity;
    for (const [uu, vv] of [[u0, v0], [u0 + nx, v0], [u0 + nx, v0 + ny], [u0, v0 + ny]]) {
      const x = c.ox + uu * cs - vv * sn, z = c.oz + uu * sn + vv * cs;
      if (x < ex0) ex0 = x; if (x > ex1) ex1 = x; if (z < ez0) ez0 = z; if (z > ez1) ez1 = z;
    }
    excF = S.excludedIn(ex0 - 1, ez0 - 1, ex1 + 1, ez1 + 1);
  }
  if (excF) {
    const exc = (i, j) => excF(c.ox + (u0 + i) * cs - (v0 + j) * sn, c.oz + (u0 + i) * sn + (v0 + j) * cs);
    const cand = (k) => own[k] && !bk[k];
    const mark = (q) => { if (bk[q]) return; bk[q] = 1; bsel[q] = -1; if (g[q] === CODE.LAWN) { g[q] = CODE.HOLE; src[q] = -1; } };
    const hitB = [];
    for (let j = 0; j < ny; j += 2)
      for (let i = 0; i < nx; i += 2) {
        if (!cand(j * nx + i)) continue;
        if (exc(i + 1, j + 1)) {
          for (let dj = 0; dj < 2 && j + dj < ny; dj++) for (let di = 0; di < 2 && i + di < nx; di++) mark((j + dj) * nx + i + di);
          hitB.push(i, j);
        }
      }
    for (let h = 0; h < hitB.length; h += 2) {
      const i0 = hitB[h], j0 = hitB[h + 1];
      for (let j = Math.max(0, j0 - 2); j < Math.min(ny, j0 + 4); j++)
        for (let i = Math.max(0, i0 - 2); i < Math.min(nx, i0 + 4); i++) {
          const k = j * nx + i;
          if (!bk[k] && exc(i + 0.5, j + 0.5)) mark(k);
        }
    }
  }
  // 7. 去掉细条（1 格宽）
  opening(g, src, nx, ny);

  yield 'lawns';
  // —— 临街铺装：楼的临街外墙（与通用建筑模块“底商”同一判据：边中点外 2 m 处距街道路缘 < 18 m 且面朝街道）
  //    门前到人行道一律铺装（最深 14 m），不留草坪——店门口是草坪、顾客要踩草进店（审查 fs_唐延路） ——
  const fcs = []; // [局部环, u0,u1,v0,v1]
  {
    const internal = new Map();
    const isInternal = (id) => {
      let v = internal.get(id);
      if (v === undefined) { const r = I.rsegs[id]; v = pip((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, c.ring); internal.set(id, v); }
      return v;
    };
    for (const [b, r] of blds) {
      if (B.hd[b] < 30) continue;
      const n = r.length / 2;
      let A = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) A += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
      const sg = A > 0 ? 1 : -1;
      const s = B.vs[b] * 2, ax = B.ax[b], az = B.az[b];
      for (let e = 0; e < n; e++) {
        const e2 = (e + 1) % n;
        const ua = r[e * 2], va = r[e * 2 + 1], ub = r[e2 * 2], vb = r[e2 * 2 + 1];
        const L = Math.hypot(ub - ua, vb - va);
        if (L < 3) continue;
        // 局部外法线（多边形逆/顺时针 → 右/左手）
        const tu = (ub - ua) / L, tv = (vb - va) / L, nu = tv * sg, nv = -tu * sg;
        // 世界坐标里取边中点外 2 m
        const xa = ax + B.offs[s + e * 2] * 0.1, za = az + B.offs[s + e * 2 + 1] * 0.1, xb = ax + B.offs[s + e2 * 2] * 0.1, zb = az + B.offs[s + e2 * 2 + 1] * 0.1;
        const nwx = nu * cs - nv * sn, nwz = nu * sn + nv * cs;
        const px = (xa + xb) / 2 + nwx * 2, pz = (za + zb) / 2 + nwz * 2;
        let best = Infinity, bq = null;
        I.rgrid.each(px - 20, pz - 20, px + 20, pz + 20, (id) => {
          const rs = I.rsegs[id];
          if (!STREET_CLS.has(rs[5]) || isInternal(id)) return;
          const dx = rs[2] - rs[0], dz = rs[3] - rs[1], l2 = dx * dx + dz * dz || 1e-9;
          let t = ((px - rs[0]) * dx + (pz - rs[1]) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = rs[0] + dx * t, qz = rs[1] + dz * t;
          const d = Math.hypot(qx - px, qz - pz) - rs[7];
          if (d < best) { best = d; bq = [qx - px, qz - pz]; }
        });
        if (best >= 18 || !bq) continue;
        const ql = Math.hypot(bq[0], bq[1]) || 1;
        if ((bq[0] * nwx + bq[1] * nwz) / ql <= 0.25) continue;
        const dep = Math.min(14, best + 2.5);
        const ea = 0.6;
        const q = new Float64Array([ua - tu * ea, va - tv * ea, ub + tu * ea, vb + tv * ea, ub + tu * ea + nu * dep, vb + tv * ea + nv * dep, ua - tu * ea + nu * dep, va - tv * ea + nv * dep]);
        let qu0 = Infinity, qu1 = -Infinity, qv0 = Infinity, qv1 = -Infinity;
        for (let k = 0; k < 8; k += 2) { qu0 = Math.min(qu0, q[k]); qu1 = Math.max(qu1, q[k]); qv0 = Math.min(qv0, q[k + 1]); qv1 = Math.max(qv1, q[k + 1]); }
        fcs.push([q, qu0, qu1, qv0, qv1]);
      }
    }
  }
  // 按 8 m 网格分桶（格点只看所在格与相邻格里的铺装四边形）
  const fcGrid = new Map();
  fcs.forEach(([, qu0, qu1, qv0, qv1], idx) => {
    for (let gx = Math.floor((qu0 - FCAP) / 8); gx <= Math.floor((qu1 + FCAP) / 8); gx++)
      for (let gy = Math.floor((qv0 - FCAP) / 8); gy <= Math.floor((qv1 + FCAP) / 8); gy++) {
        const k = gx * 100003 + gy;
        const a = fcGrid.get(k);
        if (a) a.push(idx); else fcGrid.set(k, [idx]);
      }
  });
  // 全部铺装四边形外接框的并（外扩 FCAP）：框外 phiFc 恒为 Infinity，调用方可直接跳过
  let fcU0 = Infinity, fcU1 = -Infinity, fcV0 = Infinity, fcV1 = -Infinity;
  for (const [, qu0, qu1, qv0, qv1] of fcs) {
    if (qu0 - FCAP < fcU0) fcU0 = qu0 - FCAP;
    if (qu1 + FCAP > fcU1) fcU1 = qu1 + FCAP;
    if (qv0 - FCAP < fcV0) fcV0 = qv0 - FCAP;
    if (qv1 + FCAP > fcV1) fcV1 = qv1 + FCAP;
  }
  const phiFc = (u, v) => {
    const a = fcGrid.get(Math.floor(u / 8) * 100003 + Math.floor(v / 8));
    if (!a) return Infinity;
    let f = Infinity;
    for (const idx of a) {
      const [q, qu0, qu1, qv0, qv1] = fcs[idx];
      if (u < qu0 - FCAP || u > qu1 + FCAP || v < qv0 - FCAP || v > qv1 + FCAP) continue;
      const d = sdPoly(u, v, q);
      if (d < f) f = d;
    }
    return f;
  };

  yield 'lawns';
  // —— 格点解析距离 F0（> 0 = 空地）：附近各障碍源的有符号距离取最小。
  //    只在草坪/障碍交界附近（离障碍 ≤ DEXACT 格、离草坪 ≤ 2 格）精确计算；远离障碍取倒角距离近似，障碍深处直接取负上限 ——
  const NX1 = nx + 1, NC = NX1 * (ny + 1);
  const F0 = new Float32Array(NC), C0 = new Uint8Array(NC);
  const stamp = new Uint32Array(SR.length + 1);
  let gen = 0;
  /** 格点 (i,j) 处、窗口 win 格内、mask 选中的解析源的最小有符号距离（ring 源取反号：环内为正） */
  const exactAt = (i, j, win, f, sel) => {
    gen++;
    const u = u0 + i, v = v0 + j;
    let code = -1;
    for (let jj = Math.max(0, j - win - 1); jj < Math.min(ny, j + win + 1); jj++)
      for (let ii = Math.max(0, i - win - 1); ii < Math.min(nx, i + win + 1); ii++) {
        const k = jj * nx + ii;
        const s = sel ? sel[k] : src[k];
        if (s < 0 || stamp[s] === gen) continue;
        stamp[s] = gen;
        const o = SR[s];
        let p;
        if (o.t === 0) {
          const dx = Math.max(o.a - u, u - o.b), dy = Math.max(o.c - v, v - o.d);
          p = dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy);
        } else if (o.t === 1) p = Math.sqrt(segD2(u, v, o.ua, o.va, o.ub, o.vb)) - o.r;
        else if (o.t === 3) p = -phiPoly(o.o, u, v);
        else p = phiPoly(o, u, v);
        if (p < f) { f = p; code = k; }
      }
    exactCode = code;
    return f;
  };
  let exactCode = -1;
  {
    const isL = new Uint8Array(nx * ny);
    for (let k = 0; k < nx * ny; k++) isL[k] = g[k] === CODE.LAWN ? 1 : 0;
    const dist = chamfer(isL, 0, nx, ny); // 到最近非草坪格
    const dl = chamfer(isL, 1, nx, ny); // 到最近草坪格
    const DEXACT = oldM ? 3.6 : 2.2;
    // 需要精确距离的格点按行登记（行内列号递增），下面各源只遍历外接框里的这些格点（与逐点扫外接框、按源顺序更新等价）
    const rowA = new Int32Array(ny + 2), needI = new Int32Array(NC);
    let nNeed = 0;
    for (let j = 0; j <= ny; j++) {
      rowA[j] = nNeed;
      for (let i = 0; i <= nx; i++) {
        const key = j * NX1 + i;
        let dmin = 1e6, lmin = 1e6, f = FCAP, code = CODE.LAWN, nonL = -1;
        for (let q = 0; q < 4; q++) {
          const ii = i - 1 + (q & 1), jj = j - 1 + (q >> 1);
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const k = jj * nx + ii;
          if (dist[k] < dmin) dmin = dist[k];
          if (dl[k] < lmin) lmin = dl[k];
          if (!isL[k]) nonL = k;
          if (!isL[k] && src[k] < 0 && f > -0.01) { f = -0.01; code = g[k]; }
        }
        // 离障碍较远：倒角距离近似（只用于等值线插值，不会过零）
        if (dmin > DEXACT) { F0[key] = Math.min(FCAP, dmin - 0.5); C0[key] = CODE.LAWN; continue; }
        // 障碍深处：等值线不会经过
        if (lmin > 2) { F0[key] = -FCAP; C0[key] = nonL >= 0 ? g[nonL] : CODE.OUT; continue; }
        F0[key] = f;
        C0[key] = code;
        needI[nNeed++] = i;
      }
    }
    rowA[ny + 1] = nNeed;
    // 精确距离：按源遍历它外接框（外扩 FCAP）里需要的格点
    const M = FCAP + 0.5;
    for (const o of SR) {
      if (o.t === 3) continue;
      const ia = Math.max(0, Math.ceil(o.bb[0] - M - u0)), ib = Math.min(nx, Math.floor(o.bb[1] + M - u0));
      const ja = Math.max(0, Math.ceil(o.bb[2] - M - v0)), jb = Math.min(ny, Math.floor(o.bb[3] + M - v0));
      if (!(ia <= ib)) continue;
      for (let j = ja; j <= jb; j++) {
        let qa = rowA[j], qb = rowA[j + 1];
        if (qa === qb) continue;
        while (qa < qb) { const m = (qa + qb) >> 1; if (needI[m] < ia) qa = m + 1; else qb = m; }
        for (let qn = qa, qe = rowA[j + 1]; qn < qe; qn++) {
          const i = needI[qn];
          if (i > ib) break;
          const key = j * NX1 + i;
          const u = u0 + i, v = v0 + j;
          let p;
          if (o.t === 0) {
            const dx = Math.max(o.a - u, u - o.b), dy = Math.max(o.c - v, v - o.d);
            p = dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy);
          } else if (o.t === 1) p = Math.sqrt(segD2(u, v, o.ua, o.va, o.ub, o.vb)) - o.r;
          else p = phiPoly(o, u, v);
          if (p < F0[key]) { F0[key] = p; C0[key] = o.code; }
        }
      }
    }
  }
  yield 'lawns';
  // —— 草坪函数 FL：新小区 = F0；老小区 = 离障碍 1.6 m 起（中间是水泥地）；临街铺装处让出 ——
  const FL = new Float32Array(NC), CLc = new Uint8Array(NC);
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const key = j * NX1 + i;
      let f = F0[key], code = C0[key];
      const u = u0 + i, v = v0 + j;
      if (oldM) { f -= 1.6; code = CODE.BASE; }
      if (fcs.length && f > -FCAP && u >= fcU0 && u <= fcU1 && v >= fcV0 && v <= fcV1) {
        const p = phiFc(u, v);
        if (p < f) { f = p; code = CODE.FC; }
      }
      FL[key] = f;
      CLc[key] = code;
    }

  // —— 单元格分类：整格草坪 / 边界格 / 无；去掉连通面积 < 10 m² 的碎草皮 ——
  const st = new Uint8Array(nx * ny); // 0 无 1 整格 2 边界
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = FL[j * NX1 + i], b = FL[j * NX1 + i + 1], d = FL[(j + 1) * NX1 + i], e = FL[(j + 1) * NX1 + i + 1];
      st[j * nx + i] = a > 0 && b > 0 && d > 0 && e > 0 ? 1 : a > 0 || b > 0 || d > 0 || e > 0 ? 2 : 0;
    }
  // 老小区：水泥地里的小块绿地——按 BU × BV 米分块（8~11 × 6~8 m），块间留 1 m 水泥走道，约三成整块是水泥地。
  // 按整格划分（走道边与栅格线重合，边界是直线、不出等值线多边形）
  const BU = 8 + Math.floor(hash01(c.pid, 41, 1) * 4), BV = 6 + Math.floor(hash01(c.pid, 42, 1) * 3);
  const walk = (i, j) => {
    const u = u0 + i, v = v0 + j;
    const bi = Math.floor(u / BU), bj = Math.floor(v / BV);
    return u - bi * BU === 0 || v - bj * BV === 0 || hash01(bi, bj, c.pid + 43) > 0.68;
  };
  if (oldM) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (st[j * nx + i] && walk(i, j)) st[j * nx + i] = 0;
  {
    const lab = new Int32Array(nx * ny).fill(-1);
    const queue = new Int32Array(nx * ny);
    for (let k0 = 0; k0 < nx * ny; k0++) {
      if (!st[k0] || lab[k0] >= 0) continue;
      let qh = 0, qt = 0, area = 0, edge = false;
      queue[qt++] = k0;
      lab[k0] = k0;
      while (qh < qt) {
        const k = queue[qh++];
        area += st[k] === 1 ? 1 : 0.4;
        const i = k % nx, j = (k / nx) | 0;
        if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) edge = true;
        if (i > 0 && st[k - 1] && lab[k - 1] < 0) { lab[k - 1] = k0; queue[qt++] = k - 1; }
        if (i + 1 < nx && st[k + 1] && lab[k + 1] < 0) { lab[k + 1] = k0; queue[qt++] = k + 1; }
        if (j > 0 && st[k - nx] && lab[k - nx] < 0) { lab[k - nx] = k0; queue[qt++] = k - nx; }
        if (j + 1 < ny && st[k + nx] && lab[k + nx] < 0) { lab[k + nx] = k0; queue[qt++] = k + nx; }
      }
      if (area < 10 && !edge) for (let q = 0; q < qt; q++) st[queue[q]] = 0;
    }
  }

  yield 'lawns';
  // —— 合并整格矩形 ——
  const used = new Uint8Array(nx * ny);
  const lawnBase = oldM ? C('#58683d') : C('#4c6b35');
  const lawnCol = mix(lawnBase, oldM ? C('#6e7448') : C('#5f7a3f'), hash01(c.pid, 7, 7) * 0.6);
  const MAXR = 28;
  const rects = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (st[k] !== 1 || used[k] || !own[k]) continue;
      let w = 1;
      while (i + w < nx && w < MAXR && st[k + w] === 1 && !used[k + w] && own[k + w]) w++;
      let h = 1;
      outer: while (j + h < ny && h < MAXR) {
        for (let q = 0; q < w; q++) {
          const kk = (j + h) * nx + i + q;
          if (st[kk] !== 1 || used[kk] || !own[kk]) break outer;
        }
        h++;
      }
      for (let jj = 0; jj < h; jj++) for (let q = 0; q < w; q++) used[(j + jj) * nx + i + q] = 1;
      rects.push([i, j, w, h]);
    }
  const flowerRects = [];
  for (const [i, j, w, h] of rects) {
    const ua = u0 + i, ub = ua + w, va = v0 + j, vb = va + h;
    let col = lawnCol;
    let kind = K.LAWN;
    // 老小区：绿地里约一成是踩秃的土面
    if (oldM && w * h >= 4 && hash01(Math.floor(ua / 5), Math.floor(va / 5), c.pid + 9) < 0.12) { col = C('#6b5d48'); kind = K.SOIL; }
    // 花坛：新小区大门内侧与凉亭旁的小块草坪（4~60 m²），偶有零星小块
    else if (!oldM && w * h >= 4 && w * h <= 60 && Math.min(w, h) >= 1.5) {
      const mu = (ua + ub) / 2, mv = (va + vb) / 2;
      const nearGate = c.gates.some((q) => Math.hypot(q.u + q.du * 12 - mu, q.v + q.dv * 12 - mv) < 18);
      const nearPav = c.pads.some((p) => p.type === 'pav' && Math.hypot((p.u0 + p.u1) / 2 - mu, (p.v0 + p.v1) / 2 - mv) < 10);
      const r = hash01(Math.floor(mu), Math.floor(mv), c.pid + 31);
      if (((nearGate || nearPav) && r < 0.6) || r < 0.015) {
        const fc = FLOWER_COLS[Math.floor(hash01(Math.floor(mu), Math.floor(mv), c.pid + 32) * FLOWER_COLS.length)];
        col = mix(C('#3a2e22'), fc, 0.32);
        kind = K.FLOWER;
        flowerRects.push([ua, ub, va, vb, fc]);
      }
    }
    E.quad(0, kind, ua, ub, va, vb, LIFT.lawn, col, w * h);
  }

  // —— 边界格：等值线多边形（草坪面）+ 等值线段（路缘） ——
  const PU = [0, 1, 1, 0], PV = [0, 0, 1, 1];
  const segs = []; // [ua, va, ub, vb, 外法线 nu, nv, 代码, 端点键 ka, kb]
  const ekey = (i, j, e) => (e === 0 ? (j * NX1 + i) * 2 : e === 2 ? ((j + 1) * NX1 + i) * 2 : e === 1 ? (j * NX1 + i + 1) * 2 + 1 : (j * NX1 + i) * 2 + 1);
  const poly = [];
  const emitPoly = (pts, lift, col, kind) => {
    if (pts.length < 3) return;
    E.poly(kind, lift, col, pts);
  };
  // 一个格的等值线：返回草坪多边形（可能两块）与等值线段
  const cellIso = (i, j, Fa, polys, segOut, codeArr) => {
    const f = [Fa[j * NX1 + i], Fa[j * NX1 + i + 1], Fa[(j + 1) * NX1 + i + 1], Fa[(j + 1) * NX1 + i]];
    const cks = [j * NX1 + i, j * NX1 + i + 1, (j + 1) * NX1 + i + 1, (j + 1) * NX1 + i];
    const ua = u0 + i, va = v0 + j;
    const cr = [null, null, null, null];
    let ncr = 0;
    for (let e = 0; e < 4; e++) {
      const e2 = (e + 1) & 3;
      if ((f[e] > 0) !== (f[e2] > 0)) {
        const t = f[e] / (f[e] - f[e2]);
        cr[e] = [ua + PU[e] + (PU[e2] - PU[e]) * t, va + PV[e] + (PV[e2] - PV[e]) * t];
        ncr++;
      }
    }
    polys.length = 0;
    const corner = (e) => [ua + PU[e], va + PV[e]];
    const addSeg = (ea, eb, negCorner) => {
      if (!segOut) return;
      const p = cr[ea], q = cr[eb];
      let nu = q[1] - p[1], nv = -(q[0] - p[0]);
      const L = Math.hypot(nu, nv);
      if (L < 1e-6) return;
      nu /= L; nv /= L;
      const nc = corner(negCorner);
      if (nu * (nc[0] - p[0]) + nv * (nc[1] - p[1]) < 0) { nu = -nu; nv = -nv; }
      segOut.push([p[0], p[1], q[0], q[1], nu, nv, codeArr[cks[negCorner]], ekey(i, j, ea), ekey(i, j, eb)]);
    };
    if (ncr === 4) {
      const center = (f[0] + f[1] + f[2] + f[3]) / 4;
      if (center > 0) {
        // 正值角相连：六边形；两个负角各被一段等值线包住
        const pts = [];
        for (let e = 0; e < 4; e++) { if (f[e] > 0) pts.push(corner(e)); if (cr[e]) pts.push(cr[e]); }
        polys.push(pts);
        for (let e = 0; e < 4; e++) if (f[e] <= 0) addSeg((e + 3) & 3, e, e);
      } else {
        for (let e = 0; e < 4; e++) {
          if (f[e] <= 0) continue;
          polys.push([corner(e), cr[e], cr[(e + 3) & 3]]);
          const neg = (e + 1) & 3;
          addSeg((e + 3) & 3, e, neg);
        }
      }
      return;
    }
    const pts = [];
    for (let e = 0; e < 4; e++) { if (f[e] > 0) pts.push(corner(e)); if (cr[e]) pts.push(cr[e]); }
    polys.push(pts);
    if (ncr === 2) {
      const es = [];
      for (let e = 0; e < 4; e++) if (cr[e]) es.push(e);
      // 负角：取 F 最小的那个（外侧代码取它的来源）
      let neg = -1;
      for (let e = 0; e < 4; e++) if (f[e] <= 0 && (neg < 0 || f[e] < f[neg])) neg = e;
      addSeg(es[0], es[1], neg);
    }
  };
  // 边界格合并：被等值线横切（只穿左右两边）的格沿行、被竖切（只穿上下两边）的格沿列，等值线共线（偏差 ≤ 2 cm）时
  // 并成一个梯形（直的楼边、车行道边、斜的小区边界、市政道路边都是直线，一行/一列几格到几十格合成两个三角形）；
  // 角上被斜切的格仍按单格多边形出。cells：要出的边界格下标；segOut：顺带收集等值线段（路缘用）
  const polysTmp = [];
  const emitBoundary = (cells, Fa, lift, col, kind, segOut, codeArr) => {
    const typ = new Int8Array(nx * ny); // 1 横切·下侧有面 2 横切·上侧有面 3 竖切·左侧有面 4 竖切·右侧有面
    for (const k of cells) {
      const i = k % nx, j = (k / nx) | 0;
      const f0 = Fa[j * NX1 + i] > 0, f1 = Fa[j * NX1 + i + 1] > 0, f2 = Fa[(j + 1) * NX1 + i + 1] > 0, f3 = Fa[(j + 1) * NX1 + i] > 0;
      let t = 0;
      if (f0 === f1 && f3 === f2 && f0 !== f3) t = f0 ? 1 : 2;
      else if (f0 === f3 && f1 === f2 && f0 !== f1) t = f0 ? 3 : 4;
      cellIso(i, j, Fa, polysTmp, segOut, codeArr);
      if (t) typ[k] = t;
      else for (const pts of polysTmp) emitPoly(pts, lift, col, kind);
    }
    const cross = (i, j, e) => {
      // e：0 左边（u = i，沿 v） 1 右边 2 下边（v = j，沿 u） 3 上边
      if (e < 2) { const ii = i + e, fa = Fa[j * NX1 + ii], fb = Fa[(j + 1) * NX1 + ii]; return [u0 + ii, v0 + j + fa / (fa - fb)]; }
      const jj = j + e - 2, fa = Fa[jj * NX1 + i], fb = Fa[jj * NX1 + i + 1];
      return [u0 + i + fa / (fa - fb), v0 + jj];
    };
    const colinear = (pts) => {
      const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
      for (let q = 1; q + 1 < pts.length; q++) if (segD2(pts[q][0], pts[q][1], ax, ay, bx, by) > 0.0004) return false;
      return true;
    };
    for (const horiz of [true, false]) {
      const nA = horiz ? ny : nx, nB = horiz ? nx : ny;
      for (let a = 0; a < nA; a++) {
        let b = 0;
        while (b < nB) {
          const k = horiz ? a * nx + b : b * nx + a;
          const t = typ[k];
          if (!t || (horiz ? t > 2 : t < 3)) { b++; continue; }
          const i0 = horiz ? b : a, j0 = horiz ? a : b;
          const pts = [cross(i0, j0, horiz ? 0 : 2), cross(i0, j0, horiz ? 1 : 3)];
          let e = b + 1;
          while (e < nB && e - b < MAXR) {
            const kk = horiz ? a * nx + e : e * nx + a;
            if (typ[kk] !== t) break;
            pts.push(cross(horiz ? e : a, horiz ? a : e, horiz ? 1 : 3));
            if (!colinear(pts)) { pts.pop(); break; }
            e++;
          }
          for (let q = b; q < e; q++) typ[horiz ? a * nx + q : q * nx + a] = 0;
          const ps = pts[0], pe = pts[pts.length - 1];
          let quad;
          if (horiz) {
            const lo = v0 + a, hi = v0 + a + 1;
            quad = t === 1 ? [[ps[0], lo], [pe[0], lo], pe, ps] : [ps, pe, [pe[0], hi], [ps[0], hi]];
          } else {
            const lo = u0 + a, hi = u0 + a + 1;
            quad = t === 3 ? [[lo, ps[1]], ps, pe, [lo, pe[1]]] : [ps, [hi, ps[1]], [hi, pe[1]], pe];
          }
          emitPoly(quad, lift, col, kind);
          b = e;
        }
      }
    }
  };
  {
    const cells = [];
    for (let k = 0; k < nx * ny; k++) if (st[k] === 2 && own[k]) cells.push(k);
    emitBoundary(cells, FL, LIFT.lawn, lawnCol, K.LAWN, segs, CLc);
  }

  yield 'lawns';
  // —— 底层（草坪之下）：老小区整片水泥地；新小区只在临街铺装处铺地砖。
  //    边界只绕小区边界、市政道路、洞与运动场地（车行道、车位、园路、楼都压在它上面），整格并成大矩形，边界格出等值线多边形 ——
  if (oldM || fcs.length) {
    const FB = new Float32Array(NC).fill(NaN);
    const db = chamfer(bk, 1, nx, ny), dbIn = chamfer(bk, 0, nx, ny);
    const fbAt = (i, j) => {
      const key = j * NX1 + i;
      let f = FB[key];
      if (f === f) return f;
      let dmin = 1e6, din = 1e6, ns = false;
      for (let q = 0; q < 4; q++) {
        const ii = i - 1 + (q & 1), jj = j - 1 + (q >> 1);
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) { ns = true; continue; }
        const k = jj * nx + ii;
        if (db[k] < dmin) dmin = db[k];
        if (dbIn[k] < din) din = dbIn[k];
        if (bk[k] && bsel[k] < 0) ns = true;
      }
      if (dmin > 2.5) f = FCAP;
      else if (din > 2.5) f = -FCAP;
      else f = exactAt(i, j, 3, ns ? -0.01 : FCAP, bsel);
      FB[key] = f;
      return f;
    };
    // 临街铺装：底层 ∩ 铺装四边形（新小区只铺这里）
    const fpAt = (i, j) => Math.min(fbAt(i, j), -phiFc(u0 + i, v0 + j));
    const concCol = C('#9b978e'), pavCol = C('#b2aca1');
    const FP = fcs.length ? new Float32Array(NC).fill(NaN) : null;
    const fp = (ii, jj) => { const key = jj * NX1 + ii; if (FP[key] !== FP[key]) FP[key] = fpAt(ii, jj); return FP[key]; };
    // 两层：老小区水泥（全部可铺格）；临街铺装（铺装四边形附近的格，略高 6 mm 盖在水泥上）
    for (const pav of oldM ? [false, true] : [true]) {
      if (pav && !fcs.length) continue;
      const lift = pav ? LIFT_BASE + 0.006 : LIFT_BASE, col = pav ? pavCol : concCol, kind = pav ? K.PAVER : K.CONCRETE;
      const bst = new Uint8Array(nx * ny); // 1 整格 2 边界格
      // 临街铺装层只看铺装四边形总外接框（外扩 FCAP ≥ 0.75）里的格：框外格心的 phiFc 为 Infinity，本来就会跳过
      let jA = 0, jB = ny - 1, iA = 0, iB = nx - 1;
      if (pav) {
        jA = Math.max(0, Math.floor(fcV0 - v0 - 0.5)); jB = Math.min(ny - 1, Math.ceil(fcV1 - v0));
        iA = Math.max(0, Math.floor(fcU0 - u0 - 0.5)); iB = Math.min(nx - 1, Math.ceil(fcU1 - u0));
      }
      for (let j = jA; j <= jB; j++)
        for (let i = iA; i <= iB; i++) {
          const k = j * nx + i;
          if (!own[k] || (bk[k] && dbIn[k] > 1.5)) continue;
          let a, b2, d, e;
          if (pav) {
            if (phiFc(u0 + i + 0.5, v0 + j + 0.5) >= 0.75) continue;
            a = fp(i, j); b2 = fp(i + 1, j); d = fp(i, j + 1); e = fp(i + 1, j + 1);
          } else { a = fbAt(i, j); b2 = fbAt(i + 1, j); d = fbAt(i, j + 1); e = fbAt(i + 1, j + 1); }
          if (!(a > 0 || b2 > 0 || d > 0 || e > 0)) continue;
          bst[k] = a > 0 && b2 > 0 && d > 0 && e > 0 ? 1 : 2;
        }
      const usedB = new Uint8Array(nx * ny);
      const cellsB = [];
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          const t = bst[k];
          if (!t || usedB[k]) continue;
          if (t === 2) { usedB[k] = 1; cellsB.push(k); continue; }
          let w = 1;
          while (i + w < nx && w < MAXR && bst[k + w] === 1 && !usedB[k + w]) w++;
          let h = 1;
          outerB: while (j + h < ny && h < MAXR) {
            for (let q = 0; q < w; q++) { const kk = (j + h) * nx + i + q; if (bst[kk] !== 1 || usedB[kk]) break outerB; }
            h++;
          }
          for (let jj = 0; jj < h; jj++) for (let q = 0; q < w; q++) usedB[(j + jj) * nx + i + q] = 1;
          const ua = u0 + i, ub = ua + w, va = v0 + j, vb = va + h;
          E.quad(1, kind, ua, ub, va, vb, lift, col, 0);
        }
      if (cellsB.length) emitBoundary(cellsB, pav ? FP : FB, lift, col, kind, null, C0);
    }
  }

  yield 'lawns';
  // —— 路缘：等值线段按端点串成折线 → 按外侧代码分段 → 道格拉斯-普克化简（0.05 m）→ 每段 ≤ 12 m 画路缘石；绿篱沿车行道/车位一侧 ——
  // 老小区：绿地边只有一道矮立面（旧水泥/砖砌收边，不画白色路缘石顶面）
  const curbCol = oldM ? C('#8a857b') : C('#b9b4aa');
  const hedgeCol = oldM ? C('#3f5a2c') : C('#33582a');
  {
    const ends = new Map();
    segs.forEach((s, idx) => {
      for (const key of [s[7], s[8]]) { const a = ends.get(key); if (a) a.push(idx); else ends.set(key, [idx]); }
    });
    const done = new Uint8Array(segs.length);
    const chains = [];
    const trace = (s0) => {
      // 从段 s0 出发向两头延伸
      const pts = [], codes = [], nrm = [];
      done[s0] = 1;
      let s = segs[s0];
      pts.push([s[0], s[1]], [s[2], s[3]]);
      codes.push(s[6]);
      nrm.push([s[4], s[5]]);
      for (const dir of [1, -1]) {
        let key = dir > 0 ? s[8] : s[7];
        for (;;) {
          const a = ends.get(key);
          if (!a) break;
          const nxt = a.find((q) => !done[q]);
          if (nxt === undefined) break;
          done[nxt] = 1;
          const t = segs[nxt];
          const fwd = t[7] === key;
          const p = fwd ? [t[2], t[3]] : [t[0], t[1]];
          key = fwd ? t[8] : t[7];
          if (dir > 0) { pts.push(p); codes.push(t[6]); nrm.push([t[4], t[5]]); }
          else { pts.unshift(p); codes.unshift(t[6]); nrm.unshift([t[4], t[5]]); }
        }
      }
      chains.push({ pts, codes, nrm });
    };
    for (let q = 0; q < segs.length; q++) if (!done[q]) trace(q);
    const keep = (code) => code !== CODE.EDGE && code !== CODE.OUT && code !== CODE.HOLE;
    const simplify = (pts, a, b, tol, out) => {
      // 道格拉斯-普克（闭区间 a..b），输出不含 a、含 b 的保留点下标
      let md = -1, mi = -1;
      const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
      for (let q = a + 1; q < b; q++) {
        const d = segD2(pts[q][0], pts[q][1], ax, ay, bx, by);
        if (d > md) { md = d; mi = q; }
      }
      if (md > tol * tol) { simplify(pts, a, mi, tol, out); simplify(pts, mi, b, tol, out); }
      else out.push(b);
    };
    for (const ch of chains) {
      // 按代码分段（段 q 连 pts[q] → pts[q+1]）
      let s = 0;
      while (s < ch.codes.length) {
        let e = s;
        while (e + 1 < ch.codes.length && ch.codes[e + 1] === ch.codes[s]) e++;
        const code = ch.codes[s];
        if (keep(code)) {
          const idx = [s];
          simplify(ch.pts, s, e + 1, 0.05, idx);
          for (let q = 0; q + 1 < idx.length; q++) {
            const pa0 = ch.pts[idx[q]], pb0 = ch.pts[idx[q + 1]];
            // 外法线：取这段原始小段法线的平均方向，再取与线段垂直的那一侧
            let mu = 0, mv = 0;
            for (let r = idx[q]; r < idx[q + 1]; r++) { mu += ch.nrm[r][0]; mv += ch.nrm[r][1]; }
            const L = Math.hypot(pb0[0] - pa0[0], pb0[1] - pa0[1]);
            if (L < 0.05) continue;
            let nu = (pb0[1] - pa0[1]) / L, nv = -(pb0[0] - pa0[0]) / L;
            if (nu * mu + nv * mv < 0) { nu = -nu; nv = -nv; }
            const nPiece = Math.max(1, Math.ceil(L / 12));
            for (let r = 0; r < nPiece; r++) {
              const ta = r / nPiece, tb = (r + 1) / nPiece;
              const pa = [pa0[0] + (pb0[0] - pa0[0]) * ta, pa0[1] + (pb0[1] - pa0[1]) * ta], pb = [pa0[0] + (pb0[0] - pa0[0]) * tb, pa0[1] + (pb0[1] - pa0[1]) * tb];
              E.curb(pa, pb, nu, nv, curbCol, !oldM, oldM ? 2 : 4);
            }
            // 绿篱：草坪临车行道/车位一侧（新小区多，老小区少）
            if ((code === CODE.LANE || code === CODE.PARK) && L >= 4 && hash01(Math.round(pa0[0]), Math.round(pa0[1]), c.pid + 3) < (oldM ? 0.3 : 0.75)) {
              const hgt = 0.6 + hash01(Math.round(pb0[0]), Math.round(pb0[1]), 4) * 0.35, wd = 0.8;
              const iu = -nu * (0.35 + wd / 2), iv = -nv * (0.35 + wd / 2);
              const m = Math.max(1, Math.ceil(L / 12));
              for (let r = 0; r < m; r++) {
                const ta = r / m + (r === 0 ? 0.03 : 0), tb = (r + 1) / m - (r === m - 1 ? 0.03 : 0);
                const pa = [pa0[0] + (pb0[0] - pa0[0]) * ta + iu, pa0[1] + (pb0[1] - pa0[1]) * ta + iv], pb = [pa0[0] + (pb0[0] - pa0[0]) * tb + iu, pa0[1] + (pb0[1] - pa0[1]) * tb + iv];
                const mu2 = (pa[0] + pb[0]) / 2, mv2 = (pa[1] + pb[1]) / 2;
                const x = c.ox + mu2 * cs - mv2 * sn, z = c.oz + mu2 * sn + mv2 * cs;
                const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
                const yawH = Math.atan2((pb[0] - pa[0]) * cs - (pb[1] - pa[1]) * sn, (pb[0] - pa[0]) * sn + (pb[1] - pa[1]) * cs) - Math.PI / 2;
                const k = 0.85 + hash01(r, Math.round(mu2), 5) * 0.3;
                E.hedge(x, z, mu2, mv2, yawH, len, hgt, wd, scl(hedgeCol, k), scl(hedgeCol, k * 1.15));
              }
            }
          }
        }
        s = e + 1;
      }
    }
  }

  // —— 老小区：整格绿地临水泥走道/水泥块的一侧出矮立面（沿栅格线合并成 ≤ 12 m 的段） ——
  if (oldM) {
    for (const horiz of [true, false]) {
      const nA = horiz ? ny : nx, nB = horiz ? nx : ny;
      for (let a = 0; a < nA; a++)
        for (const sd of [-1, 1]) {
          const nbA = a + sd;
          if (nbA < 0 || nbA >= nA) continue;
          let r0 = -1;
          for (let b = 0; b <= nB; b++) {
            let ok = false;
            if (b < nB) {
              const k = horiz ? a * nx + b : b * nx + a, kn = horiz ? nbA * nx + b : b * nx + nbA;
              ok = own[k] && st[k] === 1 && st[kn] === 0 && !bk[kn];
            }
            if (ok && r0 < 0) r0 = b;
            if ((!ok || b - r0 >= 12) && r0 >= 0) {
              const line = a + (sd > 0 ? 1 : 0);
              const pa = horiz ? [u0 + r0, v0 + line] : [u0 + line, v0 + r0], pb = horiz ? [u0 + b, v0 + line] : [u0 + line, v0 + b];
              E.curb(pa, pb, horiz ? 0 : sd, horiz ? sd : 0, curbCol, false, 2);
              r0 = ok ? b : -1;
            }
          }
        }
    }
  }

  yield 'lawns';
  // —— 花坛花丛（近看实例）：0.75 m 格抖动铺满花坛，每丛半径 0.3~0.45 m ——
  for (const [ua, ub, va, vb, fc] of flowerRects) {
    const nu = Math.max(1, Math.round((ub - ua - 0.3) / 0.75)), nv = Math.max(1, Math.round((vb - va - 0.3) / 0.75));
    for (let a = 0; a < nu; a++)
      for (let b = 0; b < nv; b++) {
        const u = ua + 0.15 + ((a + 0.5) * (ub - ua - 0.3)) / nu + (hash01(a, b, c.pid + 61) - 0.5) * 0.3;
        const v = va + 0.15 + ((b + 0.5) * (vb - va - 0.3)) / nv + (hash01(b, a, c.pid + 62) - 0.5) * 0.3;
        const r = 0.3 + hash01(a + 7, b, c.pid + 63) * 0.15;
        const k = 0.85 + hash01(a, b + 5, 64) * 0.3;
        const x = c.ox + u * cs - v * sn, z = c.oz + u * sn + v * cs;
        E.flower(u, v, x, z, r, fc[0] * k, fc[1] * k, fc[2] * k);
      }
  }
  // —— 灌木球：散布在大块草坪里（随机压扁与缩放） ——
  const dens = oldM ? 1 / 150 : 1 / 70;
  const shrubCols = [[0.62, 0.7, 0.55], [0.72, 0.8, 0.62], [0.55, 0.62, 0.5], [0.8, 0.85, 0.6], [0.66, 0.72, 0.58], [0.95, 0.5, 0.42]]; // 叶簇贴图乘色（末项：红叶石楠）
  for (const [i, j, w, h] of rects) {
    if (w < 4 || h < 4) continue;
    const area = w * h;
    const n = area * dens;
    const nn = Math.floor(n) + (hash01(i, j, c.pid + 6) < n % 1 ? 1 : 0);
    for (let q = 0; q < nn; q++) {
      const u = u0 + i + 1 + hash01(i + q, j, 7) * (w - 2), v = v0 + j + 1 + hash01(i, j + q, 8) * (h - 2);
      const x = c.ox + u * cs - v * sn, z = c.oz + u * sn + v * cs;
      const r = 0.45 + hash01(q, i + j, 9) * 0.65;
      const fl = 0.68 + hash01(q + 3, i + j, 19) * 0.27;
      const col = shrubCols[Math.floor(hash01(i, q, 10) * shrubCols.length)];
      E.shrub(u, v, x, z, r, fl, col);
    }
  }
  // —— 小乔木（桂花、石楠、紫叶李、海棠一类 3~5 m 观赏树）：根部外扩的锥台树干 + 两根分枝 + 主冠/侧冠；老小区以宅间大树为主，少种 ——
  const tdens = oldM ? 1 / 420 : 1 / 160;
  const treeCols = [C('#ffffff'), C('#e8f0d8'), C('#d8e8c8'), C('#f4f0d0'), C('#c89aa8'), C('#e0ecd0'), C('#f0e8b8')]; // 叶簇贴图的乘色（含紫叶李、微黄）
  const trunkCol = C('#5a4632');
  for (const [i, j, w, h] of rects) {
    if (w < 6 || h < 6) continue;
    const n = w * h * tdens;
    const nn = Math.floor(n) + (hash01(i + 3, j, c.pid + 16) < n % 1 ? 1 : 0);
    for (let q = 0; q < nn; q++) {
      const u = u0 + i + 2 + hash01(i + q, j, 17) * (w - 4), v = v0 + j + 2 + hash01(i, j + q, 18) * (h - 4);
      const x = c.ox + u * cs - v * sn, z = c.oz + u * sn + v * cs;
      const s = 0.8 + hash01(q, i + j, 19) * 0.6;
      const col = treeCols[Math.floor(hash01(j, q, 20) * treeCols.length)];
      const yaw = hash01(q, j, 21) * 6.28;
      E.tree(u, v, x, z, s, yaw, col, trunkCol);
    }
  }
  return E.out();
}

// —— 草坪出图指令：纯计算按顺序记下，回放时在主线程按同样顺序、同样参数调用原来的出图代码（结果逐位相同） ——
const OP_QUAD = 1, OP_POLY = 2, OP_CURB = 3, OP_HEDGE = 4, OP_FLOWER = 5, OP_SHRUB = 6, OP_TREE = 7;
class LawnOps {
  constructor() {
    this.a = new Float64Array(2048);
    this.n = 0;
  }
  _need(k) {
    if (this.n + k <= this.a.length) return;
    let m = this.a.length * 2;
    while (m < this.n + k) m *= 2;
    const b = new Float64Array(m);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  _p(v) { this.a[this.n++] = v; }
  /** 整格矩形（tag 0 草坪：计面积与三角形；1 底层） */
  quad(tag, kind, ua, ub, va, vb, lift, col, area) {
    this._need(12);
    this._p(OP_QUAD); this._p(tag); this._p(kind); this._p(ua); this._p(ub); this._p(va); this._p(vb); this._p(lift);
    this._p(col[0]); this._p(col[1]); this._p(col[2]); this._p(area);
  }
  poly(kind, lift, col, pts) {
    this._need(7 + pts.length * 2);
    this._p(OP_POLY); this._p(kind); this._p(lift); this._p(col[0]); this._p(col[1]); this._p(col[2]); this._p(pts.length);
    for (const q of pts) { this._p(q[0]); this._p(q[1]); }
  }
  curb(pa, pb, nu, nv, col, top, tri) {
    this._need(12);
    this._p(OP_CURB); this._p(pa[0]); this._p(pa[1]); this._p(pb[0]); this._p(pb[1]); this._p(nu); this._p(nv);
    this._p(col[0]); this._p(col[1]); this._p(col[2]); this._p(top ? 1 : 0); this._p(tri);
  }
  hedge(x, z, mu, mv, yaw, len, hgt, wd, col, colTop) {
    this._need(15);
    this._p(OP_HEDGE); this._p(x); this._p(z); this._p(mu); this._p(mv); this._p(yaw); this._p(len); this._p(hgt); this._p(wd);
    this._p(col[0]); this._p(col[1]); this._p(col[2]); this._p(colTop[0]); this._p(colTop[1]); this._p(colTop[2]);
  }
  flower(u, v, x, z, r, cr, cg, cb) {
    this._need(9);
    this._p(OP_FLOWER); this._p(u); this._p(v); this._p(x); this._p(z); this._p(r); this._p(cr); this._p(cg); this._p(cb);
  }
  shrub(u, v, x, z, r, fl, col) {
    this._need(10);
    this._p(OP_SHRUB); this._p(u); this._p(v); this._p(x); this._p(z); this._p(r); this._p(fl); this._p(col[0]); this._p(col[1]); this._p(col[2]);
  }
  tree(u, v, x, z, s, yaw, col, trunk) {
    this._need(13);
    this._p(OP_TREE); this._p(u); this._p(v); this._p(x); this._p(z); this._p(s); this._p(yaw);
    this._p(col[0]); this._p(col[1]); this._p(col[2]); this._p(trunk[0]); this._p(trunk[1]); this._p(trunk[2]);
  }
  out() {
    return this.a.slice(0, this.n);
  }
}

/** 回放草坪出图指令（主线程）：与原来边算边出图的代码逐句相同 */
export function replayLawns(S, W, c, a) {
  const T = S.terrain, cs = c.cs, sn = c.sn;
  const TRI = W.stats.tri; // 分项三角形计数（离线检查用）
  const H = (u, v) => T.heightAt(c.ox + u * cs - v * sn, c.oz + u * sn + v * cs);
  const P = (u, v, lift) => [c.ox + u * cs - v * sn, H(u, v) + lift, c.oz + u * sn + v * cs];
  const Gw = W.ground, Gd = W.gdetail, F = W.fine;
  for (let p = 0; p < a.length; ) {
    const op = a[p];
    if (op === OP_QUAD) {
      const tag = a[p + 1], kind = a[p + 2], ua = a[p + 3], ub = a[p + 4], va = a[p + 5], vb = a[p + 6], lift = a[p + 7];
      const col = [a[p + 8], a[p + 9], a[p + 10]], area = a[p + 11];
      p += 12;
      Gw.k = kind;
      Gw.quadW(P(ua, vb, lift), P(ub, vb, lift), P(ub, va, lift), P(ua, va, lift), col, [[ua, vb], [ub, vb], [ub, va], [ua, va]]);
      if (tag === 0) {
        W.stats.lawn += area;
        TRI.rect = (TRI.rect || 0) + 2;
      } else TRI.baseRect = (TRI.baseRect || 0) + 2;
    } else if (op === OP_POLY) {
      const kind = a[p + 1], lift = a[p + 2], col = [a[p + 3], a[p + 4], a[p + 5]], n = a[p + 6];
      const pts = new Array(n);
      for (let q = 0; q < n; q++) pts[q] = [a[p + 7 + q * 2], a[p + 8 + q * 2]];
      p += 7 + n * 2;
      TRI['poly' + lift] = (TRI['poly' + lift] || 0) + pts.length - 2;
      // 面积太小（< 0.01 m²，等值线贴着格边）不出面
      let A = 0;
      for (let q = 0, r = pts.length - 1; q < pts.length; r = q++) A += pts[r][0] * pts[q][1] - pts[q][0] * pts[r][1];
      if (Math.abs(A) < 0.02) continue;
      Gw.k = kind;
      const w0 = P(pts[0][0], pts[0][1], lift);
      for (let q = 1; q + 1 < pts.length; q++) triUp(Gw, w0, P(pts[q][0], pts[q][1], lift), P(pts[q + 1][0], pts[q + 1][1], lift), col, pts[0], pts[q], pts[q + 1]);
    } else if (op === OP_CURB) {
      const pa = [a[p + 1], a[p + 2]], pb = [a[p + 3], a[p + 4]], nu = a[p + 5], nv = a[p + 6], col = [a[p + 7], a[p + 8], a[p + 9]], top = a[p + 10] === 1, tri = a[p + 11];
      p += 12;
      curbPiece(Gd, P, pa, pb, nu, nv, col, top);
      TRI.curb = (TRI.curb || 0) + tri;
    } else if (op === OP_HEDGE) {
      const x = a[p + 1], z = a[p + 2], mu2 = a[p + 3], mv2 = a[p + 4], yawH = a[p + 5], len = a[p + 6], hgt = a[p + 7], wd = a[p + 8];
      const col = [a[p + 9], a[p + 10], a[p + 11]], colTop = [a[p + 12], a[p + 13], a[p + 14]];
      p += 15;
      const y = H(mu2, mv2) + LIFT.lawn;
      F.setXf(x, y, z, yawH);
      F.box(-len / 2, 0, -wd / 2, len / 2, hgt, wd / 2, col, { colTop });
    } else if (op === OP_FLOWER) {
      const u = a[p + 1], v = a[p + 2], x = a[p + 3], z = a[p + 4], r = a[p + 5];
      W.flowers.push(x, H(u, v) + LIFT.lawn + r * 0.56, z, r, a[p + 6], a[p + 7], a[p + 8]);
      p += 9;
    } else if (op === OP_SHRUB) {
      const u = a[p + 1], v = a[p + 2], x = a[p + 3], z = a[p + 4], r = a[p + 5], fl = a[p + 6];
      const y = H(u, v) + LIFT.lawn;
      W.crowns.push(x, y + r * fl * 0.82, z, r * 1.1, a[p + 7], a[p + 8], a[p + 9], fl);
      p += 10;
    } else if (op === OP_TREE) {
      const u = a[p + 1], v = a[p + 2], x = a[p + 3], z = a[p + 4], s = a[p + 5], yaw = a[p + 6];
      const col = [a[p + 7], a[p + 8], a[p + 9]], trunkCol = [a[p + 10], a[p + 11], a[p + 12]];
      p += 13;
      const y = H(u, v) + LIFT.lawn;
      smallTree(W, x, y, z, s, yaw, col, trunkCol);
    } else throw new Error('草坪出图指令损坏：' + op);
  }
}

/** 路缘石一段（局部 pa→pb，外法线 (nu,nv) 指向草坪外）：外立面 + 顶面压条（top = false 只出外立面） */
function curbPiece(Gd, P, pa, pb, nu, nv, col, top = true) {
  Gd.k = K.CURB;
  const A = P(pa[0], pa[1], 0.01), Bq = P(pb[0], pb[1], 0.01), Cq = P(pb[0], pb[1], LIFT.lawn + 0.02), Dq = P(pa[0], pa[1], LIFT.lawn + 0.02);
  // 立面朝外：(pb-pa) × 上 与外法线同向时按 A→B→C→D
  const dirOk = (pb[0] - pa[0]) * nv - (pb[1] - pa[1]) * nu;
  if (dirOk > 0) Gd.quadW(A, Bq, Cq, Dq, col, [[pa[0], 0], [pb[0], 0], [pb[0], 1], [pa[0], 1]]);
  else Gd.quadW(Bq, A, Dq, Cq, col, [[pb[0], 0], [pa[0], 0], [pa[0], 1], [pb[0], 1]]);
  if (!top) return;
  const iu = -nu * 0.12, iv = -nv * 0.12;
  const E = P(pa[0] + iu, pa[1] + iv, LIFT.lawn + 0.02), Fq = P(pb[0] + iu, pb[1] + iv, LIFT.lawn + 0.02);
  triUp(Gd, Dq, Cq, Fq, col, [pa[0], pa[1]], [pb[0], pb[1]], [pb[0], pb[1]]);
  triUp(Gd, Dq, Fq, E, col, [pa[0], pa[1]], [pb[0], pb[1]], [pa[0], pa[1]]);
}

/** 小乔木：树干（根部外扩的七棱锥台）+ 两根分枝（近看实体）+ 主冠与侧冠（树冠广告牌） */
function smallTree(W, x, y, z, s, yaw, col, trunkCol) {
  const F = W.fine;
  F.setXf(x, y, z, yaw);
  F.lathe(0, 0, [[-0.05, 0.13 * s], [0.22, 0.085 * s], [1.6 * s, 0.065 * s], [2.15 * s, 0.05 * s]], trunkCol, 7);
  F.tube([0, 1.55 * s, 0], [0.5 * s, 2.55 * s, 0.12 * s], 0.045 * s, 0.022 * s, trunkCol, 4);
  F.tube([0, 1.8 * s, 0], [-0.38 * s, 2.7 * s, -0.3 * s], 0.04 * s, 0.02 * s, trunkCol, 4);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  W.crowns.push(x, y + 2.95 * s, z, 1.55 * s, col[0], col[1], col[2], 0.86);
  const lx = 0.8 * s, lz = 0.25 * s;
  W.crowns.push(x + lx * cy + lz * sy, y + 2.55 * s, z - lx * sy + lz * cy, 1.0 * s, col[0] * 0.9, col[1] * 0.9, col[2] * 0.9, 0.85);
}

/**
 * 宅间大树（老小区：法桐 / 国槐 / 杨树，树高 h）：四棱锥台主干进“远看”实体，根部外扩与 3~4 根主枝进“近看”实体，
 * 树冠 = 一团主冠 + 每根主枝顶端一团侧冠（树冠广告牌，压扁成伞形；杨树窄高）。
 * 树皮：法桐灰白斑驳、国槐深灰褐、杨树灰白
 */
function bigTree(W, x, y, z, h, rr) {
  const Co = W.coarse, F = W.fine;
  const sp = rr < 0.42 ? 0 : rr < 0.8 ? 1 : 2; // 0 法桐 1 国槐 2 杨树
  const s = h / 12;
  const yaw = rr * 40;
  const bark = sp === 0 ? C('#8b8475') : sp === 1 ? C('#4d4439') : C('#a4a297');
  const fork = h * (sp === 2 ? 0.48 : sp === 0 ? 0.36 : 0.4);
  const r0 = (sp === 2 ? 0.17 : 0.22) * s;
  // 远看：四棱锥台主干（8 个三角形）；近看：根部外扩的六棱短台 + 主枝
  Co.setXf(x, y, z, yaw);
  Co.lathe(0, 0, [[-0.15, r0 * 1.15], [fork + 0.3, r0 * 0.78]], bark, 4, Math.PI / 4);
  F.setXf(x, y, z, yaw);
  F.lathe(0, 0, [[-0.15, r0 * 1.55], [0.5, r0 * 1.02], [1.6, r0 * 0.93]], bark, 6);
  const nB = sp === 2 ? 3 : 4;
  const spread = sp === 2 ? 0.1 : sp === 0 ? 0.27 : 0.23;
  const tips = [];
  for (let k = 0; k < nB; k++) {
    const a = (k / nB) * Math.PI * 2 + rr * 3.1;
    const ex = Math.cos(a) * h * spread, ez = Math.sin(a) * h * spread;
    const ey = sp === 2 ? h * (0.6 + 0.08 * (k % 2)) : h * (0.64 + 0.05 * (k % 2));
    F.tube([0, fork, 0], [ex * 0.8, ey, ez * 0.8], r0 * 0.62, r0 * 0.28, bark, 4);
    tips.push([ex, ey, ez]);
  }
  const leafK = sp === 0 ? [0.95, 1.0, 0.84] : sp === 1 ? [0.78, 0.88, 0.74] : [0.9, 1.0, 0.8];
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const push = (lx, ly, lz, r, k, flat) => W.bigCrowns.push(x + lx * cy + lz * sy, y + ly, z - lx * sy + lz * cy, r, leafK[0] * k, leafK[1] * k, leafK[2] * k, flat);
  if (sp === 2) {
    push(0, h * 0.6, 0, h * 0.17, 0.82, 1.25);
    push(0, h * 0.77, 0, h * 0.155, 0.95, 1.3);
    push(0, h * 0.91, 0, h * 0.105, 1.05, 1.2);
    for (const [lx, ly, lz] of tips) push(lx * 1.3, ly - h * 0.02, lz * 1.3, h * 0.12, 0.86, 1.2);
  } else {
    push(0, h * 0.8, 0, h * 0.27, 1.02, 0.8);
    for (const [lx, ly, lz] of tips) push(lx * 1.2, ly + h * 0.03, lz * 1.2, h * 0.215, 0.86, 0.78);
  }
}

// 8 邻域偏移（dilate 按此顺序登记，顺序决定同一格被多次登记时最后写入的来源）
const DIL8 = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, -1, 1, -1, -1, 1];
function dilate(g, src, nx, ny, from, to, onlyIf) {
  const add = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (g[j * nx + i] !== from) continue;
      for (let q = 0; q < 16; q += 2) {
        const a = i + DIL8[q], b = j + DIL8[q + 1];
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        if (g[b * nx + a] === onlyIf) add.push(b * nx + a, src[j * nx + i]);
      }
    }
  for (let q = 0; q < add.length; q += 2) { g[add[q]] = to; src[add[q]] = add[q + 1]; }
}
function opening(g, src, nx, ny) {
  const er = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (g[k] !== CODE.LAWN) continue;
      const L = (a, b) => a >= 0 && b >= 0 && a < nx && b < ny && g[b * nx + a] === CODE.LAWN;
      // 横竖任一方向两侧都不是草坪（1 格宽细条）→ 去掉
      if ((!L(i - 1, j) && !L(i + 1, j)) || (!L(i, j - 1) && !L(i, j + 1))) er.push(k);
    }
  for (const k of er) { g[k] = CODE.EDGE; src[k] = -1; }
}
function stampCapsule(g, src, nx, ny, u0, v0, ua, va, ub, vb, r, val, s) {
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
      if (eu * eu + ev * ev <= r2) { g[k] = val; src[k] = s; }
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
  const clean = (t) => (t && !GENERIC_NAME.test(t) ? t.replace(/[（(].*?[)）]/g, '').trim() : '');
  const name = clean(c.name);
  for (const g of gates) {
    if (!inChunk(g.x, g.z) || S.excluded(g.x, g.z)) continue;
    const y = T.heightAt(g.x, g.z);
    const yw = yaw(g.du, g.dv);
    W.gates.push([g.x + Math.sin(yw) * 5, y + 3.2, g.z + Math.cos(yw) * 5]);
    if (g.photo) continue; // 有照片依据的门楼由通用建筑模块画
    const style = c.uni ? 'campus' : c.old ? 'old' : hash01(c.pid, 8, 9) < 0.6 ? 'modern' : 'wall';
    Co.setXf(g.x, y, g.z, yw);
    const sign = g.main || style === 'wall' ? gateFrame(Co, g.W, style, c.pid) : null;
    // 门头名称：高德出入口大门写该出入口所属的高德小区名，其余写小区名
    const text = clean(g.name) || name;
    if (sign && text) {
      // 门牌：局部 (x, y, z) → 世界；牌面朝外（-z 方向，即朝街）
      const sx = g.x + sign.x * Math.cos(yw) + sign.z * Math.sin(yw), sz = g.z - sign.x * Math.sin(yw) + sign.z * Math.cos(yw);
      W.signs.push({ x: sx, y: y + sign.y, z: sz, yaw: yw + Math.PI, w: sign.w, h: sign.h, text, uni: c.uni, old: c.old });
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
