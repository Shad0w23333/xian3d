// 全城古建与历史遗迹批量精建：寺观（大兴善寺、青龙寺、卧龙寺、广仁寺、八仙宫、香积寺、兴教寺、草堂寺……）、
// 碑林/孔庙、书院门·关中书院、永兴坊、大唐西市、易俗社、七贤庄、张学良公馆、新城黄楼、各代帝陵封土与遗址台基、
// 华清宫、兵马俑、半坡等。数据：public/data/landmarks2026.json 的 heritage（tools/build_landmarks2026.py 由
// research/refs/landmarks2026/heritage.json 生成：院落中心/朝向/尺寸 + 主体建筑的类型、开间、屋顶形式与颜色、局部位置）。
// 已有专门模块的（钟鼓楼、城墙、大小雁塔、大明宫丹凤门、陕历博……）在调研清单里标 already_modeled，不在这里重复。
// 构建策略：先全部建 detail 0（远景体量），相机靠近（< 900 m）时每帧最多升级一个院落到 detail 2。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';
import { ArchBuilder, hall, multiStoreyTower, pavilion, paifang, yardWall } from '../arch/chinese.js';
import { denseEavePagoda, ruinTerrace, whiteBlock } from '../arch/heritage-parts.js';

const HIDE = 9000;
const NEAR = 900;
const ROOF = { xieshan: 'xieshan', wudian: 'wudian', yingshan: 'yingshan', xuanshan: 'xuanshan', juanpeng: 'juanpeng' };
const COLOR = (c) => (/黄|yellow|gold/.test(c) ? 'yellow' : /绿|green/.test(c) ? 'green' : /蓝|blue/.test(c) ? 'blue' : /黑|black/.test(c) ? 'black' : /dark|深灰/.test(c) ? 'darkgray' : 'gray');
const odd = (n) => Math.max(1, n % 2 ? n : n + 1);
const clamp = THREE.MathUtils.clamp;

function building(b, q, style) {
  const w = q.w, d = q.d, type = q.type, rc = COLOR(q.color), roofT = ROOF[q.roof] || 'xieshan';
  const h = q.h || null;
  b.push(q.x, 0, q.z, q.rot || 0);
  try {
    if (type === 'hall' || type === 'gate') {
      const bays = odd(clamp(q.bays || Math.round(w / 5), 3, 11));
      const bayW = clamp(w / bays * 0.86, 2.8, 7.2);
      const depthBays = clamp(Math.round((d * 0.8) / bayW), 2, 6);
      if ((q.storeys || 1) >= 2) {
        multiStoreyTower(b, { style, floors: Math.min(3, q.storeys), bays, depthBays, bayW, colH: clamp(bayW * 0.9, 3.2, 5.5), roof: roofT, roofColor: rc, platformH: 1.0 });
      } else {
        hall(b, { style, bays, depthBays, bayW, colH: h ? clamp(h * 0.38, 3.2, 8) : undefined, roof: roofT, roofColor: rc, eaves: h && h > 18 ? 2 : 1, steps: type === 'gate' ? 'frontback' : 'front', front: type === 'gate' ? 'gate' : undefined });
      }
    } else if (type === 'tower') {
      const bays = odd(clamp(q.bays || Math.round(w / 4), 1, 5));
      multiStoreyTower(b, { style, floors: clamp(q.storeys || 2, 2, 4), bays, depthBays: bays, bayW: clamp(w / Math.max(1, bays) * 0.8, 2.6, 5), colH: 3.6, roof: roofT === 'xuanshan' ? 'xieshan' : roofT, roofColor: rc, platformH: 1.2 });
    } else if (type === 'pagoda') {
      const floors = clamp(q.storeys || Math.round((h || 20) / 3.2), 3, 15);
      denseEavePagoda(b, { floors, baseW: clamp(w * 0.72, 3, 14), podium: { w: clamp(w * 1.5, 5, 26), h: clamp(w * 0.2, 0.8, 3.2) }, height: h || undefined });
    } else if (type === 'pavilion') {
      pavilion(b, { style, sides: /cuanjian|zanjian|攒尖/.test(q.roof) ? 8 : 4, size: clamp(Math.min(w, d), 4, 14), roofColor: rc });
    } else if (type === 'paifang') {
      paifang(b, { style, bays: clamp(odd(q.bays || 3), 1, 5), width: clamp(w, 5, 24) });
    } else if (type === 'mound') {
      const hh = h || clamp(Math.min(w, d) * 0.2, 6, 60);
      b.frustum('plaster', 0, 0, 0, w, d, hh, w * 0.32, d * 0.32, 0x8c7c58);
    } else if (type === 'platform') {
      ruinTerrace(b, [{ w, d, h: h || 6 }, { w: w * 0.7, d: d * 0.7, h: (h || 6) * 0.5 }]);
    } else {
      whiteBlock(b, { w, d, h: h || 12, color: type === 'modern' ? 0xe6e1d6 : 0xd8d0c0 });
    }
  } catch (e) {
    console.error('[heritage26] 构件失败', q.n, e);
  }
  b.pop();
}

export default {
  id: 'heritage26',
  name: '古建与历史遗迹（全城）',
  async prepare(ctx) {
    const raw = await loadJSON('landmarks2026.json', { optional: true });
    this.sites = [];
    for (const s of raw?.heritage || []) {
      if (!s.b?.length) continue;
      if (ctx.exclusions.test(s.x, s.z, 'buildings', 0)) continue; // 已被专门模块占用
      this.sites.push(s);
    }
    const c = (s) => Math.cos(s.rot), n = (s) => Math.sin(s.rot);
    for (const s of this.sites) {
      for (const q of s.b) {
        if (q.type === 'mound') continue; // 封土不排除周边
        const hw = q.w / 2 + 3, hd = q.d / 2 + 3, cr = c(s), sr = n(s);
        const pts = [];
        for (const [ax, az] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
          const lx = q.x + ax, lz = q.z + az;
          pts.push(s.x + lx * cr + lz * sr, s.z - lx * sr + lz * cr);
        }
        ctx.exclusions.add({ points: pts, name: 'heritage26' }, { buildings: true, trees: true, pois: false });
      }
    }
  },

  build(ctx) {
    const root = new THREE.Group();
    root.name = '古建与历史遗迹';
    ctx.scene.add(root);
    const items = [];
    const make = (s, detail) => {
      const style = /唐|tang/i.test(s.era || '') && !/明|清/.test(s.era || '') ? 'tang' : 'ming';
      const b = new ArchBuilder(ctx, { detail, style, name: s.key });
      for (const q of s.b) building(b, q, style);
      // 院墙（中小院落才画，帝陵/遗址公园不画）
      if (s.w <= 260 && s.d <= 360 && !/陵|遗址|俑/.test(s.name)) {
        const W = s.w / 2, D = s.d / 2;
        yardWall(b, [[-W, -D], [W, -D], [W, D], [-W, D]], { closed: true, h: 3.4, color: /寺|庙|宫|观|祠/.test(s.name) ? 0xa4382a : 0x8f8a82 });
      }
      return b.build({ name: s.key + '@' + detail });
    };
    let n = 0;
    for (const s of this.sites || []) {
      try {
        const h0 = ctx.terrain.heightAt(s.x, s.z);
        const lod = new THREE.LOD();
        lod.addLevel(make(s, 0), 0);
        lod.addLevel(new THREE.Object3D(), HIDE);
        lod.position.set(s.x, h0, s.z);
        lod.rotation.y = s.rot || 0;
        lod.name = 'heritage26:' + s.name;
        root.add(lod);
        items.push({ s, lod, hi: false });
        const top = Math.max(12, ...s.b.map((q) => (q.h || 10)));
        ctx.labels.add(s.name.replace(/（.*?）|\(.*?\)/g, ''), new THREE.Vector3(s.x, h0 + top + 10, s.z), { category: 'landmark', priority: 1.8, minDist: 80, maxDist: 7000 });
        n++;
      } catch (e) {
        console.error('[heritage26] ' + s.name, e);
      }
    }
    console.warn(`[heritage26] ${n} 处院落/遗址`);
    return {
      update() {
        // 近景升级：每帧最多一个
        const cp = ctx.camera.position;
        for (const it of items) {
          if (it.hi) continue;
          if (Math.hypot(it.s.x - cp.x, it.s.z - cp.z) < NEAR) {
            try {
              const g = make(it.s, 2);
              const old = it.lod.levels[0].object;
              it.lod.remove(old);
              it.lod.levels[0].object = g;
              it.lod.add(g);
              old.traverse((o) => o.geometry?.dispose());
            } catch (e) {
              console.error('[heritage26] 近景构建失败 ' + it.s.name, e);
            }
            it.hi = true;
            break;
          }
        }
      },
      setLayer(layer, v) {
        if (layer === 'buildings') root.visible = v;
      },
      dispose() {
        root.traverse((o) => o.geometry?.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};
