// 共享 PBR 材质库。纹理坐标约定：几何体 UV 以“米”为单位（见 util.worldBoxUV），
// 材质内部通过 texture.repeat 换算成每块纹理覆盖的实际尺寸。
import * as THREE from 'three';
import * as T from './textures.js';

function withRepeat(tex, meters) {
  if (!tex) return tex;
  const t = tex.clone();
  t.repeat.set(1 / meters, 1 / meters);
  t.needsUpdate = true;
  return t;
}

const defs = {
  // —— 古建 ——
  wallBrick: () => {
    const b = T.brick({ color: '#80796d', mortar: '#a59d8f', cols: 4, rows: 12, seed: 3 });
    return new THREE.MeshStandardMaterial({ map: withRepeat(b.map, 1.9), normalMap: withRepeat(b.normalMap, 1.9), normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.92, color: 0xffffff });
  },
  wallBrickDark: () => {
    const b = T.brick({ color: '#6b655b', mortar: '#8e877b', cols: 4, rows: 12, seed: 4 });
    return new THREE.MeshStandardMaterial({ map: withRepeat(b.map, 1.9), normalMap: withRepeat(b.normalMap, 1.9), roughness: 0.94 });
  },
  pagodaBrick: () => {
    const b = T.brick({ color: '#b09a7a', mortar: '#c8b89c', cols: 4, rows: 12, seed: 8, variance: 0.07 });
    return new THREE.MeshStandardMaterial({ map: withRepeat(b.map, 1.6), normalMap: withRepeat(b.normalMap, 1.6), roughness: 0.9 });
  },
  roofGray: () => {
    const r = T.roofTiles({ color: '#3f4246' });
    return new THREE.MeshStandardMaterial({ map: withRepeat(r.map, 3), normalMap: withRepeat(r.normalMap, 3), roughness: 0.75, side: THREE.DoubleSide });
  },
  roofGreenGlazed: () => {
    const r = T.roofTiles({ color: '#2f5a3a', glazed: true });
    return new THREE.MeshStandardMaterial({ map: withRepeat(r.map, 3), normalMap: withRepeat(r.normalMap, 3), roughness: 0.32, metalness: 0.05, side: THREE.DoubleSide });
  },
  roofYellowGlazed: () => {
    const r = T.roofTiles({ color: '#c99a2e', glazed: true });
    return new THREE.MeshStandardMaterial({ map: withRepeat(r.map, 3), normalMap: withRepeat(r.normalMap, 3), roughness: 0.3, metalness: 0.08, side: THREE.DoubleSide });
  },
  ridge: () => new THREE.MeshStandardMaterial({ color: 0x35373a, roughness: 0.7 }),
  lacquerRed: () => new THREE.MeshPhysicalMaterial({ color: 0x8a1d14, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
  lacquerRedDark: () => new THREE.MeshStandardMaterial({ color: 0x5e1510, roughness: 0.55 }),
  caihua: () => {
    const c = T.caihua();
    return new THREE.MeshStandardMaterial({ map: c.map, roughness: 0.6 });
  },
  bracketBlueGreen: () => new THREE.MeshStandardMaterial({ color: 0x2b5b58, roughness: 0.6 }),
  gold: () => new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 1, roughness: 0.28 }),
  marble: () => {
    const g = T.grain({ color: '#e4e0d6', amp: 14, seed: 21, spots: 12 });
    return new THREE.MeshStandardMaterial({ map: withRepeat(g.map, 2), normalMap: withRepeat(g.normalMap, 2), roughness: 0.55 });
  },
  stonePaving: () => {
    const g = T.grain({ color: '#9b958b', amp: 22, seed: 31, joints: 4 });
    return new THREE.MeshStandardMaterial({ map: withRepeat(g.map, 4), normalMap: withRepeat(g.normalMap, 4), roughness: 0.85 });
  },
  woodDark: () => {
    const w = T.wood({ color: '#4b2a1a' });
    return new THREE.MeshStandardMaterial({ map: withRepeat(w.map, 2), roughness: 0.7 });
  },
  latticeRed: () => {
    const l = T.lattice({ type: 'diamond', color: '#7c2418' });
    return new THREE.MeshStandardMaterial({ map: l.map, alphaMap: l.alphaMap, alphaTest: 0.5, roughness: 0.6, side: THREE.DoubleSide });
  },
  paperWindow: () => new THREE.MeshStandardMaterial({ color: 0xe9dcc0, roughness: 0.9, emissive: 0xffb45e, emissiveIntensity: 0 }),
  // —— 现代 ——
  asphalt: () => {
    const g = T.grain({ color: '#3b3c3e', amp: 34, seed: 41, spots: 60, spotColor: 'rgba(255,255,255,0.03)' });
    return new THREE.MeshStandardMaterial({ map: withRepeat(g.map, 6), normalMap: withRepeat(g.normalMap, 6), roughness: 0.93 });
  },
  concrete: () => {
    const g = T.grain({ color: '#a7a298', amp: 20, seed: 51 });
    return new THREE.MeshStandardMaterial({ map: withRepeat(g.map, 5), normalMap: withRepeat(g.normalMap, 5), roughness: 0.88 });
  },
  glassBlue: () => new THREE.MeshPhysicalMaterial({ color: 0x5f7f99, metalness: 0.6, roughness: 0.06, envMapIntensity: 1.4, clearcoat: 1, clearcoatRoughness: 0.05 }),
  glassDark: () => new THREE.MeshPhysicalMaterial({ color: 0x28323c, metalness: 0.7, roughness: 0.05, envMapIntensity: 1.3, clearcoat: 1 }),
  glassGold: () => new THREE.MeshPhysicalMaterial({ color: 0xa88a52, metalness: 0.85, roughness: 0.08, envMapIntensity: 1.3 }),
  metalGray: () => new THREE.MeshStandardMaterial({ color: 0x8c9095, metalness: 0.85, roughness: 0.35 }),
  metalWhite: () => new THREE.MeshStandardMaterial({ color: 0xdfe2e5, metalness: 0.6, roughness: 0.3 }),
  paintWhite: () => new THREE.MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.6 }),
  grass: () => {
    const g = T.grain({ color: '#4d6b35', amp: 40, seed: 61, spots: 80, spotColor: 'rgba(30,50,10,0.15)' });
    return new THREE.MeshStandardMaterial({ map: withRepeat(g.map, 5), roughness: 0.95 });
  },
  // —— 灯光 / 发光 ——
  lampWarm: () => new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffc27a, emissiveIntensity: 0, roughness: 0.4 }),
  lampWhite: () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xe8f0ff, emissiveIntensity: 0, roughness: 0.3 }),
  lanternRed: () => new THREE.MeshStandardMaterial({ color: 0xb3261e, emissive: 0xff3b1f, emissiveIntensity: 0.1, roughness: 0.6 }),
  ledGold: () => new THREE.MeshStandardMaterial({ color: 0xffd58a, emissive: 0xffb347, emissiveIntensity: 0, roughness: 0.5 }),
};

// 夜间发光强度（白天, 夜晚），由核心每帧自动更新
const nightDefaults = {
  lampWarm: [0, 6],
  lampWhite: [0, 5],
  lanternRed: [0.15, 3.2],
  ledGold: [0, 4.5],
  paperWindow: [0, 1.6],
};

export class MaterialLibrary {
  constructor(night) {
    this.cache = new Map();
    this.night = night;
  }
  /** 获取共享材质（同名返回同一实例，便于合批） */
  get(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const f = defs[name];
    if (!f) throw new Error('未知材质：' + name);
    const m = f();
    m.name = name;
    this.cache.set(name, m);
    if (nightDefaults[name]) this.night.register(m, { day: nightDefaults[name][0], night: nightDefaults[name][1] });
    return m;
  }
  /** 获取材质的独立副本（需要单独改颜色等时） */
  clone(name, overrides = {}) {
    const m = this.get(name).clone();
    Object.assign(m, overrides);
    if (overrides.color !== undefined) m.color = new THREE.Color(overrides.color);
    if (nightDefaults[name]) this.night.register(m, { day: nightDefaults[name][0], night: nightDefaults[name][1] });
    return m;
  }
  names() {
    return Object.keys(defs);
  }
}

/** 夜间发光材质管理 */
export class NightMaterials {
  constructor() {
    this.items = [];
  }
  register(material, { day = 0, night = 2, curve = 1 } = {}) {
    this.items.push({ material, day, night, curve });
    return material;
  }
  update(nightFactor) {
    for (const it of this.items) {
      const k = Math.pow(nightFactor, it.curve);
      it.material.emissiveIntensity = it.day + (it.night - it.day) * k;
    }
  }
}
