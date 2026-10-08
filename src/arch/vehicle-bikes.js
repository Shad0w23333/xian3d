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

/** 踏板电动车 */
function buildScooter(B) {
  const rF = 0.235, rR = 0.235, zF = 0.62, zR = -0.6;
  wheel(B, 0, zF, rF, 0.085, { seg: 12 });
  wheel(B, 0, zR, rR, 0.095, { seg: 12 });
  // 前叉、挡泥板
  for (const sd of [1, -1]) B.tube([sd * 0.065, rF, zF], [sd * 0.05, 0.86, 0.52], 0.018, SILVER, 5);
  B.obox(0, rF + 0.2, zF - 0.02, 0.13, 0.03, 0.42, 0.25, BODY);
  // 前护板（挡风围板）：自踏板前端斜向上到车把
  B.obox(0, 0.62, 0.47, 0.4, 0.66, 0.1, -0.24, BODY);
  B.obox(0, 0.6, 0.41, 0.34, 0.62, 0.05, -0.24, PLASTIC, 'front');
  // 踏板（脚踏面黑色橡胶）
  B.box(0, 0.25, 0.13, 0.34, 0.08, 0.6, BODY);
  B.box(0, 0.295, 0.13, 0.3, 0.012, 0.56, RUBBER);
  // 座下车身：两段斜盒拼出前低后高、尾部上翘的坐垫箱
  B.obox(0, 0.48, -0.32, 0.34, 0.38, 0.56, 0.12, BODY);
  B.obox(0, 0.56, -0.72, 0.3, 0.3, 0.34, 0.35, BODY);
  B.box(0, 0.25, -0.38, 0.22, 0.12, 0.6, GREY); // 电机/后摇臂
  // 坐垫
  B.obox(0, 0.775, -0.42, 0.3, 0.07, 0.66, 0.04, SEATM);
  // 尾灯 + 扶手 + 号牌
  B.obox(0, 0.66, -0.9, 0.2, 0.06, 0.04, 0.35, M.tail);
  B.box(0, 0.79, -0.82, 0.26, 0.03, 0.1, PLASTIC);
  B.panelZ(0, 0.48, -0.902, 0.15, 0.1, WHITE, -1);
  // 车把：龙头罩（车身色）+ 横把 + 握把 + 前大灯 + 后视镜
  B.obox(0, 0.97, 0.53, 0.3, 0.14, 0.2, -0.2, BODY);
  B.box(0, 0.985, 0.6, 0.12, 0.08, 0.04, M.head);
  B.tube([-0.31, 1.0, 0.5], [0.31, 1.0, 0.5], 0.013, PLASTIC, 5);
  for (const sd of [1, -1]) {
    B.tube([sd * 0.24, 1.0, 0.5], [sd * 0.33, 1.0, 0.5], 0.019, RUBBER, 6, true);
    B.tube([sd * 0.2, 1.0, 0.52], [sd * 0.25, 1.24, 0.48], 0.006, PLASTIC, 4);
    B.box(sd * 0.26, 1.25, 0.48, 0.1, 0.06, 0.02, PLASTIC);
  }
  // 选项：外卖箱（后座上方，第二色）、前车筐、挡风罩
  B.box(0, 1.03, -0.62, 0.44, 0.4, 0.42, opt(SECOND, OPT.BOX));
  B.box(0, 1.235, -0.62, 0.45, 0.012, 0.43, opt(PLASTIC, OPT.BOX));
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
