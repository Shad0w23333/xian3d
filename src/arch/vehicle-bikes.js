// 两轮/三轮车程序化几何：踏板电动车（可带外卖箱/车筐）、共享单车（美团黄/哈啰蓝/青桔绿，带车筐）、快递电动三轮。
// 与 traffic_models.js 同一套顶点格式（color / aMat / aKU），由 traffic.js 的车辆材质（选项折叠模式）绘制：
//   aKU.x = -1 常显；否则为选项位（OPT.*），实例 iData.z 的选项位不含它就折叠掉。
// 局部坐标：+x 左、+y 上、+z 车头；原点 = 两轮触地点连线中点。
// 参考尺寸：踏板电动车（雅迪/爱玛一类）长 1.75 m、把宽 0.66 m、座高 0.78 m、10~12 寸轮（外径约 0.47 m）；
//   共享单车 26 寸轮（外径约 0.66 m）、座高约 0.9 m；快递三轮车长约 2.9 m、宽 1.15 m、货箱约 1.5×1.1×1.15 m。
import { GeoBuilder, M, PM, EM, col } from './traffic_models.js';

export const BIKE = { SCOOTER: 0, BICYCLE: 1, TRICYCLE: 2 };
export const OPT = { BOX: 1, BASKET: 2, SHIELD: 4 };
/** 骑手座面：[座面高, 座面中心 z]（米，车辆局部坐标） */
export const SEAT = [[0.8, -0.3], [0.9, -0.24], [0.8, 0.34]];
/** 车长（跟驰间距用） */
export const BIKE_LEN = [1.75, 1.7, 2.9];

const BODY = { c: [1, 1, 1], paint: PM.BODY, rough: 0.3, metal: 0.25 };
const SECOND = { c: [1, 1, 1], paint: PM.SECOND, rough: 0.45, metal: 0.1 };
const RUBBER = { c: col(0x161617), rough: 0.85, metal: 0 };
const PLASTIC = { c: col(0x1e1f21), rough: 0.55, metal: 0.05 };
const GREY = { c: col(0x55585c), rough: 0.5, metal: 0.4 };
const SILVER = { c: col(0xa8acb0), rough: 0.3, metal: 0.85 };
const SEATM = { c: col(0x131313), rough: 0.6, metal: 0 };
const BASKET = { c: col(0x2a2b2d), rough: 0.6, metal: 0.3 };
const WHITE = { c: col(0xd8d8d4), rough: 0.5, metal: 0 };
const opt = (m, k) => ({ ...m, kind: k });

/** 单个车轮（轴沿 x，两面都有）：胎面 + 胎壁 + 轮毂（spokes>0 时为辐条，否则为实心轮辋盘） */
function wheel(B, cx, cz, r, w, { seg = 12, rim = SILVER, spokes = 0, hub = 0.3 } = {}) {
  const ref = [cx, r, cz];
  const ang = (k) => (k / seg) * Math.PI * 2;
  const P = (x, a, rr) => [x, r + Math.cos(a) * rr, cz + Math.sin(a) * rr];
  const xo = cx + w / 2, xi = cx - w / 2;
  const ri = r * 0.78;
  for (let k = 0; k < seg; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    B.quad(P(xo, a0, r), P(xo, a1, r), P(xi, a1, r), P(xi, a0, r), M.tire, ref);
    for (const [x, sd] of [[xo, 1], [xi, -1]]) {
      B.quad(P(x, a0, r), P(x, a1, r), P(x, a1, ri), P(x, a0, ri), M.tire, { n: [sd, 0, 0] });
      if (!spokes) {
        // 实心轮毂（电动车）：轮辋环 + 盘
        B.quad(P(x, a0, ri), P(x, a1, ri), P(x - sd * 0.01, a1, ri * 0.92), P(x - sd * 0.01, a0, ri * 0.92), rim, { n: [sd, 0, 0] });
        B.tri([x - sd * 0.012, r, cz], P(x - sd * 0.01, a0, ri * 0.92), P(x - sd * 0.01, a1, ri * 0.92), k % 2 ? rim : GREY, { n: [sd, 0, 0] });
      }
    }
    if (spokes) {
      // 细轮辋（内圈）
      B.quad(P(xo - 0.008, a0, ri), P(xo - 0.008, a1, ri), P(xi + 0.008, a1, ri), P(xi + 0.008, a0, ri), rim, [cx, r, cz]);
    }
  }
  if (spokes) {
    // 辐条：交叉薄片（两面可见）+ 花鼓
    for (let k = 0; k < spokes; k++) {
      const a = (k / spokes) * Math.PI;
      const ca = Math.cos(a) * ri, sa = Math.sin(a) * ri;
      for (const sd of [1, -1]) {
        const x = cx + sd * 0.004;
        B.quad([x, r + ca, cz + sa], [x, r - ca, cz - sa], [x, r - ca * 1.0 + 0.008, cz - sa], [x, r + ca + 0.008, cz + sa], rim, { n: [sd, 0, 0] });
      }
    }
    B.tube([cx - w * 0.6, r, cz], [cx + w * 0.6, r, cz], r * hub * 0.25, GREY, 6, true);
  }
}

/** 任意截面放样：secs[i] = 闭合环（[x,y,z] 点数一致），ref = 内部参考点；capA/capB 为首末封口材质（null 不封） */
function loft3(B, secs, m, ref, capA = null, capB = null) {
  const n = secs[0].length;
  for (let i = 0; i + 1 < secs.length; i++)
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      B.quad(secs[i][k], secs[i][k2], secs[i + 1][k2], secs[i + 1][k], m, ref);
    }
  for (const [S, cm] of [[secs[0], capA], [secs[secs.length - 1], capB]]) {
    if (!cm) continue;
    const c = S.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n, a[2] + p[2] / n], [0, 0, 0]);
    for (let k = 0; k < n; k++) B.tri(c, S[k], S[(k + 1) % n], cm, ref);
  }
}
/** x-y 平面内的圆角矩形环（中心 cx，半宽 w，y0~y1，下角半径 rb、上角半径 rt），放在 z 处；11 点（逆时针） */
function rrect(w, y0, y1, rb, rt, z, cx = 0) {
  const pts = [];
  const arc = (xc, yc, r, a0, a1) => { for (let k = 0; k <= 1; k++) { const a = a0 + ((a1 - a0) * (k + 0.5)) / 2; pts.push([cx + xc + Math.cos(a) * r, yc + Math.sin(a) * r, z]); } };
  pts.push([cx + w, y0 + rb, z]);
  arc(w - rt, y1 - rt, rt, 0, Math.PI / 2);
  pts.push([cx + w - rt, y1, z]);
  arc(-w + rt, y1 - rt, rt, Math.PI / 2, Math.PI);
  pts.push([cx - w, y0 + rb, z]);
  arc(-w + rb, y0 + rb, rb, Math.PI, 1.5 * Math.PI);
  arc(w - rb, y0 + rb, rb, 1.5 * Math.PI, 2 * Math.PI);
  return pts;
}

/** 踏板电动车 */
function buildScooter(B) {
  const rF = 0.235, rR = 0.235, zF = 0.62, zR = -0.6;
  wheel(B, 0, zF, rF, 0.085, { seg: 16 });
  wheel(B, 0, zR, rR, 0.095, { seg: 16 });
  // 前叉、前挡泥板（沿轮弧弯曲的窄壳）
  for (const sd of [1, -1]) B.tube([sd * 0.065, rF, zF], [sd * 0.05, 0.86, 0.52], 0.018, SILVER, 6);
  {
    const R = rF + 0.045, n = 6;
    for (let k = 0; k < n; k++) {
      const a0 = 0.15 + (k / n) * 1.9, a1 = 0.15 + ((k + 1) / n) * 1.9;
      const p = (a, x, rr) => [x, rF + Math.sin(a) * rr, zF + Math.cos(a) * rr];
      B.quad(p(a0, 0.065, R), p(a1, 0.065, R), p(a1, -0.065, R), p(a0, -0.065, R), BODY, [0, rF, zF]);
      for (const sd of [1, -1]) B.quad(p(a0, sd * 0.065, R), p(a1, sd * 0.065, R), p(a1, sd * 0.065, R - 0.03), p(a0, sd * 0.065, R - 0.03), BODY, { n: [sd, 0, 0] });
    }
  }
  // 前护板（挡风围板）：自踏板前端上到车把，下宽上窄、前凸的曲面壳；内侧黑色内衬
  {
    const lv = [[0.29, 0.43, 0.2], [0.48, 0.47, 0.195], [0.68, 0.505, 0.175], [0.88, 0.535, 0.15]];
    const ring = ([y, zc, w]) => {
      const pts = [];
      for (let k = 0; k <= 6; k++) { const a = Math.PI * (k / 6); pts.push([Math.cos(a) * w, y, zc + 0.02 + Math.sin(a) * 0.075]); }
      pts.push([-w * 0.92, y, zc - 0.03], [w * 0.92, y, zc - 0.03]);
      return pts;
    };
    loft3(B, lv.map(ring), BODY, [0, 0.6, 0.44], PLASTIC, BODY);
  }
  // 踏板（脚踏面黑色橡胶）
  B.box(0, 0.25, 0.13, 0.34, 0.08, 0.6, BODY);
  B.box(0, 0.295, 0.13, 0.3, 0.012, 0.56, RUBBER);
  // 座下车身：前低后高、尾部收圆上翘的壳体
  const body = [[-0.1, 0.17, 0.27, 0.5], [-0.3, 0.172, 0.27, 0.71], [-0.55, 0.165, 0.31, 0.74], [-0.76, 0.145, 0.4, 0.735], [-0.9, 0.11, 0.5, 0.7], [-0.95, 0.07, 0.56, 0.67]];
  loft3(B, body.map(([z, w, y0, y1]) => rrect(w, y0, y1, 0.03, Math.min(0.08, (y1 - y0) / 2.2), z)), BODY, [0, 0.5, -0.5], BODY, BODY);
  B.box(0, 0.25, -0.38, 0.22, 0.12, 0.6, GREY); // 电机/后摇臂
  // 坐垫：圆鼓的软垫，前低后高
  const seat = [[-0.1, 0.12, 0.69, 0.74], [-0.22, 0.15, 0.7, 0.79], [-0.45, 0.155, 0.725, 0.81], [-0.66, 0.145, 0.73, 0.805], [-0.76, 0.12, 0.725, 0.78]];
  loft3(B, seat.map(([z, w, y0, y1]) => rrect(w, y0, y1, 0.015, Math.min(0.05, (y1 - y0) / 2.1), z)), SEATM, [0, 0.74, -0.45], SEATM, SEATM);
  // 尾灯 + 扶手 + 号牌
  B.obox(0, 0.66, -0.94, 0.18, 0.05, 0.03, 0.4, M.tail);
  B.box(0, 0.79, -0.82, 0.26, 0.03, 0.1, PLASTIC);
  B.panelZ(0, 0.48, -0.902, 0.15, 0.1, WHITE, -1);
  // 车把：圆角龙头罩（车身色）+ 前大灯 + 横把 + 握把 + 后视镜
  const hd = [[0.64, 0.13, 0.9, 0.99], [0.57, 0.15, 0.89, 1.02], [0.47, 0.14, 0.9, 1.03], [0.42, 0.11, 0.92, 1.0]];
  loft3(B, hd.map(([z, w, y0, y1]) => rrect(w, y0, y1, 0.03, 0.04, z)), BODY, [0, 0.96, 0.53], BODY, BODY);
  B.box(0, 0.958, 0.645, 0.13, 0.05, 0.012, M.head);
  B.tube([-0.31, 1.0, 0.5], [0.31, 1.0, 0.5], 0.013, PLASTIC, 6);
  for (const sd of [1, -1]) {
    B.tube([sd * 0.24, 1.0, 0.5], [sd * 0.33, 1.0, 0.5], 0.019, RUBBER, 8, true);
    B.tube([sd * 0.2, 1.0, 0.52], [sd * 0.25, 1.24, 0.48], 0.006, PLASTIC, 4);
    B.obox(sd * 0.26, 1.25, 0.48, 0.1, 0.055, 0.02, 0.1, PLASTIC);
  }
  // 选项：外卖箱（后座上方，第二色：圆角箱体 + 黑色箱盖沿）、前车筐、挡风罩
  const bx = [[-0.41, 0.22, 0.83, 1.23], [-0.83, 0.22, 0.83, 1.23]];
  loft3(B, bx.map(([z, w, y0, y1]) => rrect(w, y0, y1, 0.03, 0.04, z)), opt(SECOND, OPT.BOX), [0, 1.03, -0.62], opt(SECOND, OPT.BOX), opt(SECOND, OPT.BOX));
  B.box(0, 1.17, -0.62, 0.452, 0.025, 0.432, opt(PLASTIC, OPT.BOX));
  B.box(0, 0.82, -0.62, 0.3, 0.03, 0.34, opt(PLASTIC, OPT.BOX));
  B.box(0, 0.83, 0.66, 0.34, 0.2, 0.24, opt(BASKET, OPT.BASKET));
  B.obox(0, 1.22, 0.56, 0.44, 0.34, 0.01, -0.35, opt({ c: col(0x0d1114), paint: PM.GLASS, rough: 0.05, metal: 0 }, OPT.SHIELD));
  B.quad([0.36, 0.02, 1.0], [-0.36, 0.02, 1.0], [-0.36, 0.02, -1.0], [0.36, 0.02, -1.0], M.under, { n: [0, 1, 0] });
}

/** 共享单车 / 普通自行车 */
function buildBicycle(B) {
  const r = 0.33, zF = 0.53, zR = -0.52;
  wheel(B, 0, zF, r, 0.045, { seg: 14, spokes: 6, rim: BODY });
  wheel(B, 0, zR, r, 0.045, { seg: 14, spokes: 6, rim: BODY });
  const fr = 0.022;
  const bb = [0, 0.29, 0.0], head0 = [0, 0.72, 0.4], head1 = [0, 0.93, 0.43], seatT = [0, 0.84, -0.2];
  // 低跨车架（step-through）：下管弯到中轴、立管、上后叉、平后叉、头管、前叉
  B.tube(head0, [0, 0.38, 0.12], fr * 1.25, BODY, 6);
  B.tube([0, 0.38, 0.12], bb, fr * 1.25, BODY, 6);
  B.tube(bb, seatT, fr * 1.1, BODY, 6);
  for (const sd of [1, -1]) {
    B.tube([sd * 0.012, 0.3, -0.02], [sd * 0.05, r, zR], 0.012, BODY, 5);
    B.tube([sd * 0.012, 0.68, -0.16], [sd * 0.05, r, zR], 0.011, BODY, 5);
    B.tube([sd * 0.02, 0.72, 0.4], [sd * 0.05, r, zF], 0.013, BODY, 5);
  }
  B.tube(head0, head1, fr * 1.4, BODY, 6, true);
  // 座管 + 座垫
  B.tube(seatT, [0, 0.9, -0.23], 0.013, SILVER, 5);
  B.obox(0, 0.915, -0.22, 0.15, 0.05, 0.26, 0.05, SEATM);
  // 车把：立管 + 横把 + 握把
  B.tube(head1, [0, 1.06, 0.36], 0.014, SILVER, 5);
  B.tube([-0.28, 1.06, 0.34], [0.28, 1.06, 0.34], 0.012, PLASTIC, 5);
  for (const sd of [1, -1]) B.tube([sd * 0.2, 1.06, 0.34], [sd * 0.29, 1.06, 0.32], 0.017, RUBBER, 6, true);
  // 链罩（车身色）、曲柄与脚踏
  B.box(0.045, 0.3, -0.24, 0.02, 0.1, 0.56, BODY);
  for (const sd of [1, -1]) {
    B.box(sd * 0.075, 0.29 - sd * 0.06, 0.02 * sd, 0.015, 0.17, 0.025, GREY);
    B.box(sd * 0.11, 0.29 - sd * 0.15, 0.02 * sd, 0.08, 0.02, 0.06, RUBBER);
  }
  // 挡泥板（后） + 后部智能锁
  B.obox(0, r + 0.06, zR - 0.02, 0.06, 0.02, 0.5, -0.3, BODY);
  B.box(0, 0.48, -0.5, 0.08, 0.1, 0.12, BODY);
  B.box(0, 0.62, -0.62, 0.05, 0.03, 0.03, M.tail);
  // 前车筐（共享单车标配）+ 车灯
  B.box(0, 0.98, 0.58, 0.34, 0.2, 0.26, opt(BASKET, OPT.BASKET));
  B.box(0, 0.9, 0.48, 0.05, 0.05, 0.03, M.head);
  B.quad([0.3, 0.02, 0.9], [-0.3, 0.02, 0.9], [-0.3, 0.02, -0.9], [0.3, 0.02, -0.9], M.under, { n: [0, 1, 0] });
}

/** 快递电动三轮（封闭货箱，第二色） */
function buildTricycle(B) {
  const r = 0.24, zF = 1.08, zR = -0.78;
  wheel(B, 0, zF, r, 0.09, { seg: 12 });
  for (const sd of [1, -1]) wheel(B, sd * 0.5, zR, r, 0.1, { seg: 12 });
  // 前叉、挡泥板、前围板、车把、大灯
  for (const sd of [1, -1]) B.tube([sd * 0.065, r, zF], [sd * 0.05, 0.85, 0.94], 0.02, SILVER, 5);
  B.obox(0, r + 0.2, zF - 0.02, 0.14, 0.03, 0.42, 0.25, BODY);
  B.obox(0, 0.58, 0.9, 0.46, 0.6, 0.08, -0.22, BODY);
  B.obox(0, 0.97, 0.9, 0.3, 0.14, 0.2, -0.2, BODY);
  B.box(0, 0.98, 0.98, 0.14, 0.08, 0.04, M.head);
  B.tube([-0.32, 1.0, 0.86], [0.32, 1.0, 0.86], 0.014, PLASTIC, 5);
  for (const sd of [1, -1]) B.tube([sd * 0.24, 1.0, 0.86], [sd * 0.34, 1.0, 0.86], 0.02, RUBBER, 6, true);
  // 底盘与脚踏板、座椅
  B.box(0, 0.3, 0.55, 0.42, 0.08, 0.7, BODY);
  B.box(0, 0.345, 0.55, 0.38, 0.012, 0.64, RUBBER);
  B.box(0, 0.32, -0.55, 1.0, 0.1, 1.6, GREY);
  B.box(0, 0.55, 0.32, 0.3, 0.42, 0.3, BODY);
  B.obox(0, 0.785, 0.32, 0.36, 0.07, 0.36, 0.04, SEATM);
  // 货箱（第二色）：箱体 + 顶盖 + 后门缝
  B.box(0, 0.98, -0.6, 1.12, 1.12, 1.46, SECOND);
  B.box(0, 1.555, -0.6, 1.16, 0.035, 1.5, SECOND);
  B.panelZ(0, 0.98, -1.335, 0.012, 1.02, PLASTIC, -1);
  for (const sd of [1, -1]) {
    B.box(sd * 0.42, 0.5, -1.34, 0.18, 0.08, 0.03, M.tail);
    B.panelZ(sd * 0.27, 0.98, -1.336, 0.04, 0.12, SILVER, -1);
  }
  B.panelZ(0, 0.55, -1.338, 0.18, 0.1, WHITE, -1);
  B.quad([0.62, 0.02, 1.35], [-0.62, 0.02, 1.35], [-0.62, 0.02, -1.4], [0.62, 0.02, -1.4], M.under, { n: [0, 1, 0] });
}

/** 三种车的几何（各一个 InstancedMesh） */
export function bikeGeometries() {
  const out = [];
  for (const fn of [buildScooter, buildBicycle, buildTricycle]) {
    const B = new GeoBuilder();
    fn(B);
    out.push(B.toGeometry(40));
  }
  return out;
}

// —— 配色 ——
// 电动车车身：白色最多，其次黑、红、粉、蓝、灰、香槟
export const SCOOTER_COLORS = [[0xeeeeea, 30], [0x1a1b1d, 18], [0xb3262b, 8], [0xe8a0b4, 6], [0x2f6fc0, 6], [0x8a8d92, 10], [0xc8b48c, 6], [0x6fb4c8, 4], [0x3a4a3a, 3], [0xf0d040, 2]];
// 共享单车：美团黄、哈啰蓝（蓝白）、青桔绿；少量私人车
export const SHARED_BIKES = [[0xf5c400, 45], [0x1f86d8, 35], [0x22b573, 20]];
export const PRIVATE_BIKES = [0x1a1b1d, 0xe8e8e4, 0x8a8d92, 0x2f4a6a, 0x8a2a2a];
// 外卖箱：美团黄 / 饿了么蓝；快递货箱：邮政绿、京东红、顺丰黑、中通/韵达蓝、白色
export const COURIER = { meituan: 0xf5c400, eleme: 0x1a8ae6 };
export const EXPRESS_BOX = [[0x1f6e3e, 3], [0xc8202a, 3], [0x1d1e20, 3], [0x2a5aa8, 3], [0xe6e6e2, 2], [0xe8b020, 1]];
