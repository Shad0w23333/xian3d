// 古建构件测试场（开发用，?modules=archtest 时加载）。
// 位置：渭河北岸农田（108.955E, 34.455N）一块压平的空地；所有展品坐北朝南（正面 +Z），自西向东排开。
//   x=-165 城楼（城台+三券洞+重檐歇山楼）  x=-85 唐风五开间庑殿（佛光寺式，檐口/屋脊 LED）
//   x=0 明式五开间重檐歇山殿（黄琉璃、须弥座、汉白玉栏杆、御路踏跺）  x=85 钟楼式三重檐四角攒尖楼阁（砖台上）
//   x=150 八角重檐亭 + 游廊   z=+55 三间四柱七楼牌坊、石狮、灯笼串、仿唐商铺
// 统计：每个展品构建后以 console.warn('[archtest] …') 打印三角形/网格/材质数（shot.mjs 会收集）。
import * as THREE from 'three';
import { buildArch, buildLOD, hall, multiStoreyTower, gateTower, pavilion, paifang, corridor, lanternString, lantern, stoneLion, balustrade, steps, stats, cityPlatform, eaveLights } from '../../arch/chinese.js';

const LON = 108.955, LAT = 34.455;

export default {
  id: 'archtest',
  name: '古建构件测试',
  prepare(ctx) {
    const c = ctx.geo.project(LON, LAT);
    const pts = [c.x - 230, c.z - 90, c.x + 230, c.z - 90, c.x + 230, c.z + 110, c.x - 230, c.z + 110];
    this.h = ctx.terrain.addFlatten({ points: pts, height: null, feather: 40 });
    ctx.exclusions.add({ points: pts }, { buildings: true, trees: true, roads: true });
  },
  async build(ctx) {
    const c = ctx.geo.project(LON, LAT);
    const y = this.h ?? ctx.terrain.heightAt(c.x, c.z);
    const root = new THREE.Group();
    root.name = 'archtest';
    root.position.set(c.x, y, c.z);
    ctx.scene.add(root);
    const report = {};
    const add = (name, obj, x, z, rotY = 0) => {
      obj.position.set(x, 0, z);
      obj.rotation.y = rotY;
      root.add(obj);
      const lvl = obj.isLOD ? obj.levels[0].object : obj;
      obj.traverse((m) => {
        if (!m.isMesh) return;
        const a = m.geometry.attributes.position.array;
        for (let i = 0; i < a.length; i++)
          if (!Number.isFinite(a[i])) {
            console.warn('[archtest] NaN in ' + name + ' / ' + m.name + ' @' + i);
            break;
          }
      });
      report[name] = stats(lvl);
      if (obj.isLOD) {
        if (obj.levels.length > 2) report[name + '@d1'] = stats(obj.levels[1].object);
        report[name + '@d0'] = stats(obj.levels[obj.levels.length - 1].object);
      }
      return obj;
    };
    const t0 = performance.now();

    // 1. 城楼：城台（三券洞）+ 重檐歇山城楼（永宁门式，灰瓦）
    add('gateTower', buildArch(ctx, (b) => gateTower(b, {
      w: 52, d: 22, h: 11, tunnels: 3, tw: 5.5, th: 7.4, spacing: 13,
      style: 'ming', roofColor: 'gray', plaque: '永寧門',
      tower: { floors: 2, bays: 7, depthBays: 3, bayW: 4.6, centerW: 5.4, colH: 5.0, shrink: 0, topEaves: 1, roof: 'xieshan', front: 'center3', pingzuo: true, balcony: 1.2, lanterns: true, lanternKind: 'palace' },
    }), { style: 'ming', flood: { color: 0xffc47a, strength: 1.4, baseY: y + 0.5, height: 30 } }), -165, 0);

    // 1b. 箭楼（砖砌箭窗 + 抱厦 + 歇山）于单券洞城台上
    add('arrowGate', buildArch(ctx, (b) => gateTower(b, { w: 40, d: 18, h: 11, tunnels: 1, tw: 6, th: 7.6, arrow: { w: 30, d: 12, h: 13 }, plaque: '永寧門' })), -165, 80);

    // 2. 唐风五开间单檐庑殿（佛光寺东大殿式：雄大斗拱、深远出檐、鸱尾、灰瓦、白壁朱柱）+ 轮廓灯
    add('tangHall', buildLOD(ctx, (b) => hall(b, {
      style: 'tang', bays: 5, bayW: 5.0, centerW: 5.0, depthBays: 4, depthW: 4.4, colH: 5.0,
      roof: 'wudian', roofColor: 'darkgray', front: 'tang', sides: 'zhiling', platform: 'brick', platformH: 1.1,
      plaque: '大唐', eaveLights: { columns: true },
    }), { style: 'tang' }), -85, 0);

    // 3. 明式五开间重檐歇山（黄琉璃，须弥座 + 汉白玉栏杆 + 御路）——性能基准
    const ming = add('mingHall', buildLOD(ctx, (b) => hall(b, {
      style: 'ming', bays: 5, bayW: 5.2, centerW: 6.4, depthBays: 4, depthW: 5.0, colH: 6.2, eaves: 2,
      roof: 'xieshan', roofColor: 'yellow', platform: 'sumeru', platformH: 1.8, railing: true, steps: 'front', stepsYulu: 1.6,
      plaque: '太和殿', rich: true, carve: 0xb88a3a,
    }), { style: 'ming', flood: { color: 0xffd8a0, strength: 1.2, baseY: y + 1.8, height: 26 } }), 0, -5);

    // 4. 钟楼式：砖台（十字券洞简化为南北一洞）+ 二层楼阁 + 顶层重檐四角攒尖（三重檐，绿琉璃）
    add('bellTower', buildArch(ctx, (b) => {
      b.push(0, 0, 0, 0);
      const cp = cityPlatform(b, { w: 35.5, d: 35.5, h: 8.6, tunnels: 1, tw: 6, th: 6.2, crenel: false, color: 0x8c8880 });
      b.pop();
      // 砖台顶沿石栏杆
      const e = 17.2;
      balustrade(b, [[-e, cp.topY, -e], [e, cp.topY, -e], [e, cp.topY, e], [-e, cp.topY, e]], { kind: 'stone', closed: true, color: 0xd9d3c8 });
      return multiStoreyTower(b, {
        y0: cp.topY, style: 'ming',
        storeys: [
          { bays: [3.4, 4.6, 6.4, 4.6, 3.4], depthBays: [3.4, 4.6, 6.4, 4.6, 3.4], colH: 5.8, veranda: true, front: 'center3', back: 'center3', sides: 'center3' },
          { colH: 4.6, front: 'doors', back: 'doors', sides: 'doors' },
        ],
        balcony: 1.6, topEaves: 2, roof: 'zanjian', roofColor: 'green', platform: 'plain', platformH: 0.5, steps: 'none',
        plaque: '聲聞於天', plaqueVertical: false, finial: { h: 3.2, gold: true },
        // 夜景（参考 research/refs/arch/belltower_night.jpg）：砖台白光泛照、檐下暖光、檐口/屋脊冷白绿 LED 勾边、檐下红灯笼
        lanterns: true, lanternKind: 'round', eaveLights: { color: 0xd4ffe6, width: 0.08 },
      });
    }, { style: 'ming', flood: { color: 0xffe2bc, strength: 1.6, baseY: y, height: 40, top: 0.55 } }), 85, 0);

    // 5. 八角重檐亭 + L 形游廊
    add('pavilion', buildArch(ctx, (b) => pavilion(b, { sides: 8, size: 7, colH: 3.6, eaves: 2, roofColor: 'gray', lanterns: true })), 150, -10);
    add('corridor', buildArch(ctx, (b) => corridor(b, [[118, 12], [182, 12], [182, -30]], { w: 3, colH: 3, roof: 'juanpeng', roofColor: 'gray' })), 0, 0);
    add('pavilion4', buildArch(ctx, (b) => pavilion(b, { sides: 4, size: 5, colH: 3.4, roof: 'xieshan', roofColor: 'green', style: 'ming' })), 205, 20);
    add('pavilion6', buildArch(ctx, (b) => pavilion(b, { sides: 6, size: 5.5, colH: 3.4, roofColor: 'darkgray', style: 'tang', eaveLights: true })), 205, -20);

    // 6. 牌坊（三间四柱七楼式简化：三楼）+ 石狮 + 灯笼串 + 仿唐商铺
    add('paifang', buildArch(ctx, (b) => paifang(b, { bays: 3, width: 16, h: 6.5, text: '大唐不夜城', sideText: ['盛世', '華章'], roofColor: 'yellow' })), 0, 58);
    add('paifangStone', buildArch(ctx, (b) => paifang(b, { bays: 3, width: 12, h: 5.2, kind: 'stone', text: '慈恩寺' })), -85, 60);
    add('props', buildArch(ctx, (b) => {
      stoneLion(b, -5.5, 0, 38, 0);
      stoneLion(b, 5.5, 0, 38, 0);
      // 灯笼串：两排立杆之间
      for (const x of [-40, -20, 20, 40]) {
        b.cyl('paint', x, 0, 70, 0.12, 0.1, 6, 8, 0x8a2418, {});
        b.cyl('paint', x + 12, 0, 70, 0.12, 0.1, 6, 8, 0x8a2418, {});
        lanternString(b, [x, 5.8, 70], [x + 12, 5.8, 70], { n: 6, sag: 0.8, size: 0.7 });
      }
      // 独立石栏杆 + 台阶（沿折线/斜坡）
      b.push(-40, 0, 90, 0);
      b.box('stone', -6, 0, -3, 6, 1.5, 3, 0xd9d3c8, { skip: 'bottom' });
      steps(b, { w: 3, h: 1.5, y0: 0 });
      b.pop();
      balustrade(b, [[-45.8, 1.5, 92.8], [-45.8, 1.5, 87.2], [-34.2, 1.5, 87.2], [-34.2, 1.5, 92.8]], { kind: 'stone' });
      balustrade(b, [[-41.7, 1.5, 93.0], [-41.7, 0.0, 93 + 3.2]], { kind: 'stone', h: 1.0 });
      balustrade(b, [[-38.3, 1.5, 93.0], [-38.3, 0.0, 93 + 3.2]], { kind: 'stone', h: 1.0 });
      for (let i = 0; i < 6; i++) lantern(b, -58 + i * 2.2, 3.2, 84, { kind: i % 2 ? 'palace' : 'round' });
    }), 0, 0);
    add('tangShop', buildArch(ctx, (b) => hall(b, {
      style: 'tang', bays: 3, bayW: 4.2, depthBays: 2, depthW: 4.5, colH: 4.2, roof: 'xieshan', roofColor: 'darkgray',
      front: 'tangshop', sides: 'wall', platform: 'plain', platformH: 0.45, plaque: '長安酒肆', lanterns: true, eaveLights: { columns: true },
    }), { style: 'tang' }), 60, 70);

    const ms = performance.now() - t0;
    report.buildMs = Math.round(ms);
    console.warn('[archtest] buildMs=' + report.buildMs + ' ' + Object.entries(report).filter(([k]) => k !== 'buildMs').map(([k, v]) => k + ':' + v.tris + '/' + v.meshes).join(' '));
    window.__archtest = report;
    return {};
  },
};
