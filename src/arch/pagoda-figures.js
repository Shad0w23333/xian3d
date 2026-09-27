// 大雁塔南/北广场小品：玄奘法师铜像、唐风灯柱、铜雕群像、香炉。全部写入 ArchBuilder。
//
// 玄奘像（南广场，2001 年落成）：铜像立姿，右手持锡杖，左手当胸，身披袈裟，面向南方（大唐不夜城）；
// 花岗岩须弥基座，基座南面刻“玄奘”。像高约 5 m，连基座约 9 m（据现场照片比例估算）。
import * as THREE from 'three';

const circle = (r, n = 8) => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r]);

/** 玄奘法师铜像（含基座），原点 = 基座底面中心，面朝 +Z */
export function xuanzangStatue(b) {
  const stone = 0xcfc7b8, bronze = 0x8a6a45, bronzeD = 0x6d5236;
  // 基座：三级台 + 须弥座身 + 顶盘
  b.box('stone', -5.2, 0, -5.2, 5.2, 0.45, 5.2, 0xbdb6a8, { skip: 'bottom' });
  b.box('stone', -4.2, 0.45, -4.2, 4.2, 0.9, 4.2, stone, { skip: 'bottom' });
  b.frustum('stone', 0, 0, 0.9, 3.4, 3.4, 1.3, 3.0, 3.0, stone);
  b.box('stone', -1.35, 1.3, -1.35, 1.35, 3.5, 1.35, 0xd6cfc2, { skip: 'bottom' });
  b.frustum('stone', 0, 0, 3.5, 2.7, 2.7, 3.85, 3.2, 3.2, stone);
  b.box('stone', -1.6, 3.85, -1.6, 1.6, 4.05, 1.6, 0xc4bcae, { skip: 'bottom' });
  b.plaque('玄奘', 0, 2.45, 1.37, 1.5, 1.1, { bg: '#5b4a36', color: '#e9cf8e', border: '#8a7050' });
  const y0 = 4.05;
  // 袈裟（前后略扁）
  b.push(new THREE.Matrix4().makeScale(1, 1, 0.72).setPosition(0, y0, 0));
  b.lathe('metal', [[0.95, 0], [0.92, 0.25], [0.8, 0.9], [0.68, 1.7], [0.6, 2.4], [0.62, 3.0], [0.72, 3.45], [0.74, 3.7], [0.56, 3.92], [0.22, 4.02], [0.001, 4.03]], 18, bronze);
  b.pop();
  // 衣褶（前襟斜带）
  b.sweep('metal', [[-0.62, y0 + 3.5, 0.35], [0.1, y0 + 2.6, 0.5], [0.55, y0 + 1.2, 0.55]], circle(0.07, 6), bronzeD, { smooth: true });
  // 头与颈
  b.cyl('metal', 0, y0 + 3.95, 0, 0.16, 0.15, 0.25, 10, bronze);
  b.push(0, y0 + 4.12, 0);
  b.lathe('metal', [[0.001, 0], [0.2, 0.04], [0.29, 0.18], [0.31, 0.34], [0.28, 0.5], [0.18, 0.62], [0.001, 0.66]], 14, bronze);
  b.pop();
  // 右臂持锡杖（向前伸），左手当胸
  const arm = circle(0.15, 8);
  b.sweep('metal', [[0.68, y0 + 3.6, 0.02], [0.82, y0 + 2.9, 0.2], [0.78, y0 + 2.45, 0.55]], arm, bronze, { smooth: true, caps: true });
  b.sweep('metal', [[-0.68, y0 + 3.6, 0.02], [-0.6, y0 + 2.85, 0.35], [-0.12, y0 + 2.95, 0.55]], arm, bronze, { smooth: true, caps: true });
  b.push(0.78, y0 + 2.36, 0.6);
  b.lathe('metal', [[0.001, 0], [0.13, 0.05], [0.14, 0.18], [0.001, 0.26]], 8, bronze);
  b.pop();
  // 锡杖
  const sx = 0.8, sz = 0.62;
  b.cyl('metal', sx, y0 + 0.05, sz, 0.045, 0.04, 6.1, 8, bronzeD);
  const ring = [];
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ring.push([sx + Math.sin(a) * 0.26, y0 + 6.4 + Math.cos(a) * 0.34, sz]);
  }
  b.sweep('metal', ring, circle(0.035, 5), bronzeD, { closed: true });
  b.push(sx, y0 + 6.72, sz);
  b.lathe('metal', [[0.001, 0], [0.08, 0.1], [0.05, 0.3], [0.001, 0.36]], 8, bronzeD);
  b.pop();
  return { top: y0 + 6.9, figureBase: y0 };
}

/** 唐风灯柱（原型）：石座 + 八棱柱 + 宫灯式灯箱 + 攒尖小顶，高约 5.2 m */
export function tangLampPost(b, x, y, z, yaw = 0, s = 1) {
  b.push(x, y, z, yaw, s);
  b.proto('pagoda-lamppost', (pb) => {
    pb.box('stone', -0.38, 0, -0.38, 0.38, 0.55, 0.38, 0xc9c1b2, { skip: 'bottom' });
    pb.frustum('stone', 0, 0, 0.55, 0.62, 0.62, 0.8, 0.4, 0.4, 0xc9c1b2);
    pb.cyl('paint', 0, 0.8, 0, 0.13, 0.11, 3.5, 8, 0x3b2e25);
    pb.box('paint', -0.36, 4.3, -0.36, 0.36, 4.38, 0.36, 0x3b2e25);
    pb.box('emit', -0.28, 4.38, -0.28, 0.28, 5.0, 0.28, 0xffd9a0);
    for (const [xx, zz] of [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]) pb.box('paint', xx - 0.03, 4.38, zz - 0.03, xx + 0.03, 5.0, zz + 0.03, 0x3b2e25);
    pb.frustum('paint', 0, 0, 5.0, 0.9, 0.9, 5.3, 0.12, 0.12, 0x2f2a26);
    pb.push(0, 5.3, 0);
    pb.lathe('paint', [[0.001, 0], [0.07, 0.05], [0.05, 0.2], [0.001, 0.26]], 6, 0x2f2a26);
    pb.pop();
  });
  b.pop();
}

/** 铜雕群像（抽象化：人物 + 基座），原点为基座中心 */
export function bronzeGroup(b, n = 3, seed = 1) {
  const r = (k) => {
    const v = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  b.box('stone', -2.2, 0, -1.4, 2.2, 0.8, 1.4, 0xb9b1a3, { skip: 'bottom' });
  for (let i = 0; i < n; i++) {
    const x = -1.4 + (i / Math.max(1, n - 1)) * 2.8, z = (r(i) - 0.5) * 0.9;
    const h = 1.7 + r(i + 5) * 0.4;
    b.push(new THREE.Matrix4().makeScale(1, 1, 0.75).setPosition(x, 0.8, z));
    b.lathe('metal', [[0.42, 0], [0.4, 0.2], [0.3, h * 0.5], [0.26, h * 0.78], [0.18, h * 0.84], [0.001, h * 0.85]], 10, 0x6f5638);
    b.pop();
    b.push(x, 0.8 + h * 0.83, z);
    b.lathe('metal', [[0.001, 0], [0.12, 0.03], [0.15, 0.15], [0.12, 0.27], [0.001, 0.3]], 8, 0x6f5638);
    b.pop();
  }
}

/** 香炉（大雄宝殿前） */
export function censer(b, x, y, z) {
  b.push(x, y, z);
  b.box('stone', -1.1, 0, -1.1, 1.1, 0.5, 1.1, 0xbdb6a8, { skip: 'bottom' });
  b.lathe('metal', [[0.001, 0.5], [0.7, 0.55], [0.95, 0.9], [1.0, 1.3], [0.85, 1.5], [0.9, 1.6], [0.001, 1.6]], 14, 0x4a3b2c);
  b.frustum('metal', 0, 0, 1.6, 1.3, 1.3, 2.2, 0.5, 0.5, 0x4a3b2c);
  b.cyl('metal', 0, 2.2, 0, 0.18, 0.12, 0.5, 8, 0x4a3b2c);
  b.pop();
}
