// 城市植被：行道树 / 公园绿地 / 环城公园 / 校园大院 / 水岸垂柳 / 绿篱。
//
// 树种（详见 src/arch/vegSpecies.js 注释）：国槐（市树，行道树主力）、法国梧桐（友谊路/含光路/咸宁路等老路）、
// 雪松（公园/单位大院/校园）、垂柳（护城河/湖岸）、银杏（雁塔西路等，9 月下旬开始微黄）、石榴（市花，小乔木）、
// 灌木球与绿篱（大叶黄杨 / 金叶女贞 / 红叶石楠）。
//
// 种植点：src/arch/vegPlant.js 在 Web Worker 中生成（道路两侧 6.5~8.5 m 间距、单行道中央分隔带、城墙与护城河之间
// 的环城公园逐排加密、水岸垂柳、按用地类型 + 团簇噪声撒点；避开建筑/路面/水面/排除区/城墙本体）。
//
// 渲染（≤ 16 个 draw call + 近景阴影 ≤ 7）：
//   近景（< 90~170 m）：每树种 1 个 InstancedMesh，完整程序化几何（主干/主枝/次枝管 + Canvas 叶簇卡片），投射阴影；
//   中景（至 300~900 m）：每树种 1 个 InstancedMesh，叶片抽稀放大的简化几何；
//   远景：1 个 InstancedBufferGeometry impostor（启动时把近景几何正交烘焙成侧视/俯视图集），GPU 按距离/密度剔除；
//   绿篱：1 个 InstancedMesh。
//   近/中景实例每帧（相机移动时）按 200 m 分块 + 视锥剔除重新填充；LOD 之间用屏幕空间抖动交叉淡化。
//   顶点着色器风摆（整树摆动 + 叶片颤动），片元着色器做银杏/法桐秋色、夜间路灯暖光（按到道路的距离）。
import * as THREE from 'three';
import { buildAtlas, buildSpeciesGeometries, buildHedgeGeometry, buildHedgeTexture, SPECIES_COUNT } from '../arch/vegSpecies.js';
import VegWorker from '../arch/vegWorker.js?worker&inline';
import { simplifyTree, bakeImpostors, patchTreeMaterial, makeFarMaterial, makeFarGeometry, patchHedgeMaterial } from '../arch/vegRender.js';

const GUANMU = 6;
// 画质档位 → [近景半径, 中景（远景起点）半径, 远景最远, 绿篱半径, 灌木半径]
const LOD_BY_LEVEL = [
  [60, 300, 2600, 110, 110],
  [90, 460, 4200, 160, 150],
  [130, 650, 6500, 220, 190],
  [170, 900, 9000, 280, 240],
];
const BAND = 16; // 近↔中 交叉淡化带（米）
const FARBAND = 60; // 中↔远 交叉淡化带（米）

// 本模块自己的让位区（地标内部的铺装广场 / 大唐不夜城步行街轴线由对应模块自行布置树木）
function localExclusions(ctx) {
  const rect = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];
  const circle = (cx, cz, r, n = 20) => {
    const p = [];
    for (let i = 0; i < n; i++) p.push(cx + Math.cos((i / n) * Math.PI * 2) * r, cz + Math.sin((i / n) * Math.PI * 2) * r);
    return p;
  };
  return [
    rect(1535, 4960, 1615, 7010), // 大唐不夜城步行街中轴
    rect(1512, 4085, 1632, 4462), // 大雁塔北广场喷泉水景
    circle(1572, 4850, 55), // 南广场玄奘像
    circle(1572, 4590, 42), // 大雁塔塔基
    circle(0, 0, 70), // 钟楼台基与环岛
  ];
}

function toBuffer(b) {
  if (!b) return null;
  if (b instanceof ArrayBuffer) return b.slice(0);
  if (ArrayBuffer.isView(b)) return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return null;
}

function startPlanting(ctx) {
  const items = [];
  for (const it of ctx.exclusions?.items || []) if (it.flags?.trees) items.push({ p: Array.from(it.p) });
  for (const p of localExclusions(ctx)) items.push({ p });
  const lm = ctx.data.landmarks || {};
  const msg = {
    roads: ctx.data.roads,
    landuse: ctx.data.landuse,
    water: ctx.data.water,
    rail: ctx.data.rail,
    buildings: toBuffer(ctx.data.buildings),
    exclusions: items,
    wall: lm.wall || [],
    mamian: lm.mamian || [],
    gates: lm.gates || [],
  };
  return new Promise((resolve, reject) => {
    let worker = null;
    try {
      worker = new VegWorker();
    } catch (e) {
      worker = null;
    }
    const fallback = async () => {
      const { plantVegetation } = await import('../arch/vegPlant.js');
      resolve(plantVegetation(msg));
    };
    if (!worker) {
      fallback().catch(reject);
      return;
    }
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.r);
      else {
        console.warn('[vegetation] worker 失败，改用主线程', e.data.error);
        fallback().catch(reject);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      console.warn('[vegetation] worker 错误，改用主线程', e.message);
      fallback().catch(reject);
    };
    worker.postMessage(msg, msg.buildings ? [msg.buildings] : []);
  });
}

export default {
  id: 'vegetation',
  name: '城市植被',

  prepare(ctx) {
    // 在 prepare 阶段就开始后台种植（此时之前模块的排除区都已登记）
    this._plant = startPlanting(ctx);
    this._plant.catch(() => {});
  },

  async build(ctx) {
    const G = ctx.uniforms;
    const tBuild = performance.now();
    const root = new THREE.Group();
    root.name = '城市植被';
    ctx.scene.add(root);

    // —— 资源 ——
    const atlas = buildAtlas();
    atlas.anisotropy = Math.min(8, ctx.quality.anisotropy || 4);
    const nearGeos = buildSpeciesGeometries();
    const MID_OPT = [
      { keep: 0.34, grow: 1.55, trunkY: 3.4 },
      { keep: 0.3, grow: 1.65, trunkY: 4.6 },
      { keep: 0.42, grow: 1.35, trunkY: 2.2 },
      { keep: 0.45, grow: 1.35, trunkY: 3.2 },
      { keep: 0.36, grow: 1.5, trunkY: 4.5 },
      { keep: 0.4, grow: 1.45, trunkY: 1.4 },
    ];
    const midGeos = MID_OPT.map((o, sp) => simplifyTree(nearGeos[sp], { ...o, seed: 101 + sp }));
    const imp = bakeImpostors(ctx.renderer, nearGeos, atlas);
    const hedgeGeo = buildHedgeGeometry();
    const hedgeTex = buildHedgeTexture();

    // —— 材质 ——
    let level = Math.max(0, Math.min(3, ctx.quality.level ?? 2));
    let [nearR, farR, farMax, hedgeR, shrubR] = LOD_BY_LEVEL[level];
    const wind = { value: 1 };
    const lampK = { value: 0.85 };
    const fadeNear = new THREE.Vector4(-2, -1, nearR - BAND, nearR);
    const fadeShrub = new THREE.Vector4(-2, -1, shrubR - BAND, shrubR);
    const fadeMid = new THREE.Vector4(nearR - BAND, nearR, farR - FARBAND, farR);
    const fadeFar = new THREE.Vector4(farR - FARBAND, farR, farMax * 0.8, farMax);
    const fadeHedge = new THREE.Vector4(0, 0, hedgeR - 20, hedgeR);
    const rankMax = { value: 256 };
    const treeMat = (fade, key) =>
      patchTreeMaterial(
        new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.84, metalness: 0 }),
        G,
        { fade, wind, lampK, key },
      );
    const nearMat = treeMat(fadeNear, 'lod');
    const shrubMat = treeMat(fadeShrub, 'lod');
    const midMat = treeMat(fadeMid, 'lod');
    const depthMat = patchTreeMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.45, side: THREE.DoubleSide }), G, {
      fade: fadeNear,
      wind,
      lampK,
      key: 'depth',
      depth: true,
    });
    const farMat = makeFarMaterial(G, imp.texture, imp.info, { fade: fadeFar, rankMax, lampK });
    const hedgeMat = patchHedgeMaterial(new THREE.MeshStandardMaterial({ map: hedgeTex, roughness: 0.9, metalness: 0 }), G, fadeHedge);

    // —— 动态实例槽 ——
    const slots = [];
    const makeSlot = (geo, mat, cap, { shadow = false, name }) => {
      const g = geo;
      const info = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      info.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aInfo', info);
      const mesh = new THREE.InstancedMesh(g, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      if (shadow) mesh.customDepthMaterial = depthMat;
      mesh.name = name;
      root.add(mesh);
      const s = { mesh, cap, n: 0, m: mesh.instanceMatrix.array, info: info.array, shadow };
      slots.push(s);
      return s;
    };
    const growSlot = (s) => {
      const cap = s.cap * 2;
      const m = new Float32Array(cap * 16);
      m.set(s.m);
      const info = new Float32Array(cap * 4);
      info.set(s.info);
      s.mesh.instanceMatrix = new THREE.InstancedBufferAttribute(m, 16);
      s.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const ia = new THREE.InstancedBufferAttribute(info, 4);
      ia.setUsage(THREE.DynamicDrawUsage);
      s.mesh.geometry.setAttribute('aInfo', ia);
      s.cap = cap;
      s.m = m;
      s.info = info;
    };
    const NAMES = ['国槐', '法国梧桐', '雪松', '垂柳', '银杏', '石榴', '灌木'];
    const near = [], mid = [];
    for (let sp = 0; sp < SPECIES_COUNT; sp++)
      near.push(makeSlot(nearGeos[sp], sp === GUANMU ? shrubMat : nearMat, sp === GUANMU ? 4096 : 2048, { shadow: !!ctx.quality.shadows, name: `植被近景-${NAMES[sp]}` }));
    for (let sp = 0; sp < midGeos.length; sp++) mid.push(makeSlot(midGeos[sp], midMat, 4096, { name: `植被中景-${NAMES[sp]}` }));
    const hedgeSlot = makeSlot(hedgeGeo, hedgeMat, 2048, { name: '植被-绿篱' });
    hedgeSlot.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(hedgeSlot.cap * 3), 3);
    hedgeSlot.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    hedgeSlot.col = hedgeSlot.mesh.instanceColor.array;
    // 大叶黄杨 / 金叶女贞 / 红叶石楠
    const HEDGE_COL = [new THREE.Color(0x4f7436), new THREE.Color(0x93a64a), new THREE.Color(0x8c5a3c)];

    // —— 等待种植结果 ——
    let dirty = true;
    let D = null;
    let farMesh = null;
    const plant = this._plant || startPlanting(ctx);
    const onData = (r) => {
      const t0 = performance.now();
      const n = r.n;
      const y = new Float32Array(n);
      const th = ctx.terrain;
      for (let i = 0; i < n; i++) y[i] = th.heightAt(r.x[i], r.z[i]);
      const nC = r.ncx * r.ncz;
      const cy0 = new Float32Array(nC).fill(1e9), cy1 = new Float32Array(nC).fill(-1e9);
      for (let c = 0; c < nC; c++)
        for (let i = r.chunkStart[c]; i < r.chunkStart[c + 1]; i++) {
          if (y[i] < cy0[c]) cy0[c] = y[i];
          if (y[i] > cy1[c]) cy1[c] = y[i];
        }
      const hy = new Float32Array(r.hedgeN);
      for (let i = 0; i < r.hedgeN; i++) hy[i] = th.heightAt(r.hedges[i * 7], r.hedges[i * 7 + 1]);
      for (let c = 0; c < nC; c++)
        for (let i = r.hedgeStart[c]; i < r.hedgeStart[c + 1]; i++) {
          if (hy[i] < cy0[c]) cy0[c] = hy[i];
          if (hy[i] > cy1[c]) cy1[c] = hy[i];
        }
      // 远景：按 rank 升序（密度调低时只画前缀）
      const order = new Uint32Array(n);
      const cnt = new Uint32Array(257);
      for (let i = 0; i < n; i++) cnt[r.rank[i] + 1]++;
      for (let k = 0; k < 256; k++) cnt[k + 1] += cnt[k];
      for (let i = 0; i < n; i++) order[cnt[r.rank[i]]++] = i;
      const pos = new Float32Array(n * 3), dat = new Uint8Array(n * 4);
      for (let k = 0; k < n; k++) {
        const i = order[k];
        pos[k * 3] = r.x[i];
        pos[k * 3 + 1] = y[i];
        pos[k * 3 + 2] = r.z[i];
        dat[k * 4] = r.sp[i];
        dat[k * 4 + 1] = r.sc[i];
        dat[k * 4 + 2] = r.rank[i];
        dat[k * 4 + 3] = r.lamp[i];
      }
      const fg = makeFarGeometry(n);
      fg.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
      fg.setAttribute('aData', new THREE.InstancedBufferAttribute(dat, 4, false));
      farMesh = new THREE.Mesh(fg, farMat);
      farMesh.frustumCulled = false;
      farMesh.name = '植被远景-impostor';
      farMesh.castShadow = false;
      farMesh.receiveShadow = false;
      root.add(farMesh);
      D = { ...r, y, cy0, cy1, hy, rankSorted: cnt };
      applyDensity();
      console.warn(`[vegetation] 树木 ${n}（行道树 ${r.stats.street}、分隔带 ${r.stats.median}、环城公园 ${r.stats.wallpark}、水岸 ${r.stats.bank}、用地 ${r.stats.landuse}），绿篱 ${r.hedgeN} 段；种植 ${r.stats.ms} ms，装配 ${(performance.now() - t0).toFixed(0)} ms`);
    };
    let density = ctx.quality.treeDensity ?? 1;
    const applyDensity = () => {
      const k = Math.max(0.04, Math.min(1, density / 1.3));
      rankMax.value = Math.round(256 * k);
      if (farMesh && D) {
        // rank 升序：前缀计数
        let c = 0;
        for (let i = 0; i < D.n; i++) if (D.rank[i] < rankMax.value) c++;
        farMesh.geometry.instanceCount = Math.max(1, c);
      }
      dirty = true;
    };
    let dataReady = false;
    const timeout = new Promise((res) => setTimeout(() => res('timeout'), 12000));
    const first = await Promise.race([plant.then((r) => r), timeout]).catch((e) => {
      console.error('[vegetation] 种植失败', e);
      return null;
    });
    if (first && first !== 'timeout') {
      onData(first);
      dataReady = true;
    } else if (first === 'timeout') {
      plant.then((r) => {
        onData(r);
        dataReady = true;
      });
    }

    console.warn(`[vegetation] build ${(performance.now() - tBuild).toFixed(0)} ms（含等待后台种植）`);

    // —— LOD 分配 ——
    const COS = new Float32Array(256), SIN = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      COS[i] = Math.cos((i / 256) * Math.PI * 2);
      SIN[i] = Math.sin((i / 256) * Math.PI * 2);
    }
    const frustum = new THREE.Frustum();
    const projScreen = new THREE.Matrix4();
    const box = new THREE.Box3();
    const lastPos = new THREE.Vector3(1e9, 0, 0);
    const lastQuat = new THREE.Quaternion();
    let frame = 0;

    const writeTree = (s, i) => {
      if (s.n >= s.cap) growSlot(s);
      const k = s.n++;
      const o = k * 16;
      const sc = D.sc[i] / 127.5;
      const ro = D.rot[i];
      const br = D.br[i];
      const c = COS[ro] * sc, sn = SIN[ro] * sc;
      const sy = sc * (0.93 + (br & 15) * 0.009);
      const m = s.m;
      m[o] = c; m[o + 1] = 0; m[o + 2] = -sn; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = sn; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0;
      m[o + 12] = D.x[i]; m[o + 13] = D.y[i] - 0.05; m[o + 14] = D.z[i]; m[o + 15] = 1;
      const q = k * 4;
      s.info[q] = br / 255;
      s.info[q + 1] = D.yel[i] / 255;
      s.info[q + 2] = D.lamp[i] / 255;
      s.info[q + 3] = ((ro * 0.61803) % 1 + (br >> 4) / 16) % 1;
    };
    const writeHedge = (s, i) => {
      if (s.n >= s.cap) {
        growSlot(s);
        const col = new Float32Array(s.cap * 3);
        col.set(s.col);
        s.mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
        s.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        s.col = col;
      }
      const k = s.n++;
      const h = D.hedges;
      const b = i * 7;
      const a = h[b + 2], L = h[b + 3], W = h[b + 4], H = h[b + 5];
      const ca = Math.cos(a), sa = Math.sin(a);
      const m = s.m, o = k * 16;
      m[o] = ca * L; m[o + 1] = 0; m[o + 2] = sa * L; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = H; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = -sa * W; m[o + 9] = 0; m[o + 10] = ca * W; m[o + 11] = 0;
      m[o + 12] = h[b]; m[o + 13] = D.hy[i] - 0.05; m[o + 14] = h[b + 1]; m[o + 15] = 1;
      const col = HEDGE_COL[h[b + 6] | 0] || HEDGE_COL[0];
      const v = 0.9 + ((i * 0.618) % 1) * 0.2;
      s.col[k * 3] = col.r * v;
      s.col[k * 3 + 1] = col.g * v;
      s.col[k * 3 + 2] = col.b * v;
    };

    const assign = () => {
      const cam = ctx.camera;
      const cp = cam.position;
      projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreen);
      for (const s of slots) s.n = 0;
      const R = D.region, CH = D.chunk;
      const reach = Math.max(farR, hedgeR, shrubR) + 30;
      const cx0 = Math.max(0, Math.floor((cp.x - reach - R.x0) / CH)), cx1 = Math.min(D.ncx - 1, Math.floor((cp.x + reach - R.x0) / CH));
      const cz0 = Math.max(0, Math.floor((cp.z - reach - R.z0) / CH)), cz1 = Math.min(D.ncz - 1, Math.floor((cp.z + reach - R.z0) / CH));
      const nr2 = nearR * nearR, fr2 = farR * farR, sr2 = shrubR * shrubR, hr2 = hedgeR * hedgeR;
      const midIn2 = (nearR - BAND) * (nearR - BAND);
      const rk = rankMax.value;
      const X = D.x, Y = D.y, Z = D.z, SPA = D.sp, RK = D.rank;
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cz * D.ncx + cx;
          const t0 = D.chunkStart[c], t1 = D.chunkStart[c + 1];
          const h0 = D.hedgeStart[c], h1 = D.hedgeStart[c + 1];
          if (t0 === t1 && h0 === h1) continue;
          const bx0 = R.x0 + cx * CH, bz0 = R.z0 + cz * CH;
          // 块到相机的水平距离
          const ddx = Math.max(bx0 - cp.x, 0, cp.x - bx0 - CH), ddz = Math.max(bz0 - cp.z, 0, cp.z - bz0 - CH);
          const dd2 = ddx * ddx + ddz * ddz;
          if (dd2 > reach * reach) continue;
          box.min.set(bx0 - 12, D.cy0[c] - 2, bz0 - 12);
          box.max.set(bx0 + CH + 12, D.cy1[c] + 24, bz0 + CH + 12);
          if (!frustum.intersectsBox(box)) continue;
          if (dd2 <= fr2 || dd2 <= sr2)
            for (let i = t0; i < t1; i++) {
              if (RK[i] >= rk) continue;
              const dx = X[i] - cp.x, dy = Y[i] - cp.y, dz = Z[i] - cp.z;
              const d2 = dx * dx + dy * dy + dz * dz;
              const sp = SPA[i];
              if (sp === GUANMU) {
                if (d2 < sr2) writeTree(near[sp], i);
                continue;
              }
              if (d2 < nr2) writeTree(near[sp], i);
              if (d2 > midIn2 && d2 < fr2) writeTree(mid[sp], i);
            }
          if (dd2 <= hr2)
            for (let i = h0; i < h1; i++) {
              const dx = D.hedges[i * 7] - cp.x, dy = D.hy[i] - cp.y, dz = D.hedges[i * 7 + 1] - cp.z;
              if (dx * dx + dy * dy + dz * dz < hr2) writeHedge(hedgeSlot, i);
            }
        }
      for (const s of slots) {
        const mesh = s.mesh;
        mesh.count = s.n;
        mesh.visible = s.n > 0;
        if (!s.n) continue;
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, s.n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        const ia = mesh.geometry.attributes.aInfo;
        ia.clearUpdateRanges();
        ia.addUpdateRange(0, s.n * 4);
        ia.needsUpdate = true;
        if (s === hedgeSlot) {
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(0, s.n * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
    };

    const setRadii = () => {
      [nearR, farR, farMax, hedgeR, shrubR] = LOD_BY_LEVEL[level];
      fadeNear.set(-2, -1, nearR - BAND, nearR);
      fadeShrub.set(-2, -1, shrubR - BAND, shrubR);
      fadeMid.set(nearR - BAND, nearR, farR - FARBAND, farR);
      fadeFar.set(farR - FARBAND, farR, farMax * 0.8, farMax);
      fadeHedge.set(0, 0, hedgeR - 20, hedgeR);
      dirty = true;
    };

    let visibleLayer = true;
    return {
      get count() {
        return D ? D.n : 0;
      },
      update(dt, t) {
        if (!D || !visibleLayer) return;
        frame++;
        const cam = ctx.camera;
        const moved = cam.position.distanceToSquared(lastPos) > 2.25;
        const turned = 1 - Math.abs(cam.quaternion.dot(lastQuat)) > 2e-5;
        if (dirty || moved || turned || frame % 30 === 0) {
          lastPos.copy(cam.position);
          lastQuat.copy(cam.quaternion);
          dirty = false;
          assign();
        }
      },
      setQuality(q) {
        level = Math.max(0, Math.min(3, q.level ?? level));
        setRadii();
        density = q.treeDensity ?? density;
        applyDensity();
        for (const s of near) {
          s.mesh.castShadow = !!q.shadows;
        }
      },
      setLayer(layer, on) {
        if (layer === 'trees' || layer === 'vegetation') {
          visibleLayer = on;
          root.visible = on;
          if (on) dirty = true;
        }
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        for (const m of [nearMat, shrubMat, midMat, depthMat, farMat, hedgeMat]) m.dispose();
        atlas.dispose();
        hedgeTex.dispose();
        imp.rt.dispose();
        ctx.scene.remove(root);
      },
      stats() {
        return D ? { trees: D.n, hedges: D.hedgeN, ...D.stats, near: near.map((s) => s.n), mid: mid.map((s) => s.n), hedge: hedgeSlot.n } : null;
      },
      get ready() {
        return dataReady;
      },
    };
  },
};
