// 钟鼓楼专用构件（belltower 模块私有）：十字券洞砖台、景云钟、钟架、大鼓与鼓架、东侧登台踏步、广场灯。
// 全部写入古建 ArchBuilder（按材质合并），坐标约定同构件库：局部 Y 向上、正面 +Z（南）。
import * as THREE from 'three';
import { archWall, balustrade } from './chinese.js';

const BRICK = 0x8f8b84; // 钟楼台基青砖（照片：灰白斑驳）
const STONE = 0xd6d0c4;

/**
 * 钟楼砖台：边长 S、高 H，四面券洞十字贯通（宽 tw、高 th，拱顶 = th）。
 * 顶部：叠涩砖檐 + 石压面 + 海墁 + 汉白玉石栏杆。返回 {topY}
 */
export function crossPlatform(b, o = {}) {
  const S = o.S ?? 35.5, H = o.H ?? 8.6, tw = o.tw ?? 6, th = o.th ?? 6.3;
  const half = S / 2, c = tw / 2 + 0.2; // 券洞两侧墙垛宽 0.2（与四角砖墩无重叠面）
  const hb = H - 0.95; // 墙身顶（其上为叠涩与压面）
  // 四角砖墩
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x0 = sx > 0 ? c : -half, x1 = sx > 0 ? half : -c;
      const z0 = sz > 0 ? c : -half, z1 = sz > 0 ? half : -c;
      b.box('brick', x0, 0, z0, x1, hb, z1, BRICK, { skip: 'bottom' });
      // 石土衬（墙脚）：四面都外凸 0.12（含券洞一侧；原先券洞侧与砖墩墙面齐平 → 共面闪烁）
      b.box('stone', x0 - 0.12, -0.05, z0 - 0.12, x1 + 0.12, 0.62, z1 + 0.12, 0xb9b3a8, { skip: 'bottom' });
    }
  // 四个券洞臂（带券脸），中心十字交叉处平顶
  const L = half - c, zc = (half + c) / 2;
  for (let k = 0; k < 4; k++) {
    const yaw = (k * Math.PI) / 2;
    b.push(Math.sin(yaw) * zc, 0, Math.cos(yaw) * zc, yaw);
    archWall(b, -c, c, 0, hb, { depth: L, archs: [{ cx: 0, w: tw, h: th }], mat: 'brick', color: BRICK, frameColor: 0x6f6b64, frameW: 0.62 });
    if (b.detail >= 1) {
      // 券洞内拱脚暖光灯带（夜景：洞内通透发亮）
      for (const sx of [-1, 1]) b.led([[sx * (tw / 2 - 0.08), th - tw / 2, -L / 2 + 0.3], [sx * (tw / 2 - 0.08), th - tw / 2, L / 2 - 0.3]], { color: 0xffc98a, width: 0.12 });
      // 券脸外回纹框（照片中券洞外一圈装饰带）
      const r = tw / 2 + 0.95;
      const yS = th - tw / 2;
      const pts = [];
      for (let i = 0; i <= 14; i++) {
        const a = Math.PI - (i / 14) * Math.PI;
        pts.push([Math.cos(a) * r, yS + Math.sin(a) * r, L / 2 + 0.08]);
      }
      b.sweep('stone', [[-r, 0.62, L / 2 + 0.08], ...pts, [r, 0.62, L / 2 + 0.08]], [[-0.14, -0.05], [0.14, -0.05], [0.14, 0.05], [-0.14, 0.05]], 0x9a958c, { caps: true, up: [0, 0, 1] });
    }
    b.pop();
  }
  b.box('brick', -c, th, -c, c, hb, c, BRICK, { skip: 'bottom' });
  b.box('stone', -c, th - 0.02, -c, c, th, c, 0x6c6862, {});
  // 叠涩砖檐 + 石压面
  b.box('brick', -half - 0.1, hb, -half - 0.1, half + 0.1, hb + 0.3, half + 0.1, 0x7d7973, { skip: 'bottom' });
  b.box('brick', -half - 0.22, hb + 0.3, -half - 0.22, half + 0.22, hb + 0.55, half + 0.22, 0x86827b, {});
  b.box('stone', -half - 0.3, hb + 0.55, -half - 0.3, half + 0.3, H, half + 0.3, 0xcfc9bd, {});
  const top = H + 0.06;
  b.box('stone', -half, H - 0.01, -half, half, top, half, 0xa8a398, { skip: 'bottom' });
  if (b.detail >= 1) {
    const e = half - 0.2;
    balustrade(b, [[-e, top, -e], [e, top, -e], [e, top, e], [-e, top, e]], { kind: 'stone', closed: true, color: 0xe3ded3 });
  }
  return { topY: top };
}

/** 青铜钟（景云钟式：六弧钟口、钟身带纹带），吊点 (x, yTop, z)，通高 h，钟口外径 dia */
export function bronzeBell(b, x, yTop, z, h = 2.45, dia = 1.65) {
  const R = dia / 2;
  const prof = [
    [R * 0.93, 0], [R, 0.04 * h], [R * 0.97, 0.1 * h], [R * 0.86, 0.3 * h], [R * 0.8, 0.55 * h],
    [R * 0.78, 0.78 * h], [R * 0.74, 0.86 * h], [R * 0.52, 0.93 * h], [R * 0.2, 0.96 * h], [0.02, 0.965 * h],
  ];
  const y0 = yTop - h;
  b.lathe('metal', prof.map(([r, y]) => [r, y0 + y]), b.detail >= 2 ? 28 : 14, 0x5f5236, x, z);
  // 腰带纹
  for (const k of [0.3, 0.55])
    b.lathe('metal', [[R * (k === 0.3 ? 0.87 : 0.81), y0 + k * h - 0.04], [R * (k === 0.3 ? 0.88 : 0.82), y0 + k * h], [R * (k === 0.3 ? 0.87 : 0.81), y0 + k * h + 0.04]], 20, 0x7a6840, x, z);
  // 蒲牢钟钮
  b.box('metal', x - 0.22, y0 + 0.96 * h, z - 0.08, x + 0.22, yTop + 0.02, z + 0.08, 0x54482e);
}

/** 红漆钟架（两柱 + 双横梁 + 顶部小披檐），跨 span，高 h。原点=架中心地面，横梁沿 X */
export function bellFrame(b, span = 3.4, h = 4.6) {
  const red = 0x9c2a1c;
  for (const sx of [-1, 1]) {
    b.box('paint', sx * span / 2 - 0.18, 0, -0.18, sx * span / 2 + 0.18, h, 0.18, red, { skip: 'bottom' });
    // 戗柱
    b.box('paint', sx * span / 2 - 0.12, 0, -0.9, sx * span / 2 + 0.12, 0.3, 0.9, 0x7a5a3a, { skip: 'bottom' });
    b.cyl('stone', sx * span / 2, 0, 0, 0.32, 0.28, 0.3, 8, 0xcfc9bd);
  }
  b.box('paint', -span / 2 - 0.5, h - 0.42, -0.2, span / 2 + 0.5, h - 0.02, 0.2, red);
  b.box('caihua', -span / 2 - 0.2, h - 0.95, -0.16, span / 2 + 0.2, h - 0.62, 0.16, 0x2f6a8a);
  // 小披檐（两坡绿琉璃）
  b.prism('tileFlatGlazed', [[-0.9, h], [0.9, h], [0.12, h + 0.55], [-0.12, h + 0.55]], 'x', -span / 2 - 0.9, span / 2 + 0.9, 0x2e7446);
  b.box('ridgeGlazed', -span / 2 - 0.95, h + 0.5, -0.1, span / 2 + 0.95, h + 0.68, 0.1, 0x235a36);
}

let _drumGeo = null;
function drumGeos() {
  if (_drumGeo) return _drumGeo;
  // 鼓身（腰鼓形，轴向 Z）、鼓面、两道铜箍（鼓钉带）
  const prof = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, zz = -0.5 + t;
    prof.push(new THREE.Vector2(0.44 + 0.08 * Math.sin(t * Math.PI), zz));
  }
  const body = new THREE.LatheGeometry(prof, 20).rotateX(Math.PI / 2);
  const face = new THREE.CircleGeometry(0.43, 20);
  const faceF = face.clone().translate(0, 0, 0.5);
  const faceB = face.clone().rotateY(Math.PI).translate(0, 0, -0.5);
  const ring = new THREE.TorusGeometry(0.455, 0.035, 5, 20);
  const r1 = ring.clone().translate(0, 0, 0.44), r2 = ring.clone().translate(0, 0, -0.44);
  _drumGeo = { body, faceF, faceB, r1, r2 };
  return _drumGeo;
}
/**
 * 大鼓 + 木鼓架：鼓心 (x, y, z)，直径 dia，鼓面朝 ±Z（yaw 旋转）。
 */
export function drum(b, x, y, z, dia = 1.5, yaw = 0, o = {}) {
  const G = drumGeos();
  const s = dia / 1.04;
  const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z).multiply(new THREE.Matrix4().makeScale(s, s, s * (o.len ?? 1.05)));
  b.geometry('paint', G.body, o.color ?? 0xa3261a, m);
  b.geometry('stone', G.faceF, 0xd8c49a, m);
  b.geometry('stone', G.faceB, 0xd8c49a, m);
  if (b.detail >= 1) {
    b.geometry('metal', G.r1, 0xb8913e, m);
    b.geometry('metal', G.r2, 0xb8913e, m);
  }
  // 鼓架：两侧 X 形木腿 + 托梁
  if (o.stand !== false) {
    b.push(x, 0, z, yaw);
    const yb = y - dia * 0.5 - 0.05, lx = dia * 0.42;
    const base = o.base ?? 0;
    for (const sx of [-1, 1]) {
      b.box('paint', sx * lx - 0.07, base, -0.45, sx * lx + 0.07, yb + dia * 0.18, -0.33, 0x5a2618, { skip: 'bottom' });
      b.box('paint', sx * lx - 0.07, base, 0.33, sx * lx + 0.07, yb + dia * 0.18, 0.45, 0x5a2618, { skip: 'bottom' });
    }
    b.box('paint', -lx - 0.1, yb - 0.12, -0.45, lx + 0.1, yb, 0.45, 0x5a2618);
    b.box('paint', -lx - 0.1, base + 0.25, -0.1, lx + 0.1, base + 0.37, 0.1, 0x5a2618);
    b.pop();
  }
}

/** 沿墙直跑石踏步（带外侧拦板墙）：自 (x, 0, z0) 起向 z1 爬升到 h，宽 w；踏步朝 dirX 侧开敞 */
export function wallStair(b, x0, x1, z0, z1, h, o = {}) {
  const n = Math.max(4, Math.round(h / 0.16));
  const run = (z1 - z0) / n;
  const col = o.color ?? 0xbdb6aa;
  for (let i = 0; i < n; i++) {
    const za = z0 + i * run, zb = za + run;
    b.box('stone', x0, 0, Math.min(za, zb), x1, (i + 1) * (h / n), Math.max(za, zb), col, { skip: 'bottom' });
  }
  // 外侧砖拦板（斜顶）
  const xo = o.outerX ?? x1;
  const t = 0.4;
  const pts = [[z0, 0], [z1, 0], [z1, h + 1.0], [z0, 1.0]];
  b.prism('brick', pts.map(([zz, yy]) => [zz, yy]), 'x', xo - (xo > x0 ? 0 : t), xo + (xo > x0 ? t : 0), BRICK);
}

/** 广场宫灯柱：高 h，顶挑两盏宫灯 */
export function plazaLamp(b, x, z, h = 5.2) {
  b.cyl('stone', x, 0, z, 0.3, 0.26, 0.5, 8, 0xc8c2b6);
  b.cyl('paint', x, 0.5, z, 0.11, 0.09, h - 0.5, 8, 0x3c2a22);
  b.box('paint', x - 0.9, h - 0.2, z - 0.06, x + 0.9, h - 0.08, z + 0.06, 0x3c2a22);
}

export const COLORS = { BRICK, STONE };
