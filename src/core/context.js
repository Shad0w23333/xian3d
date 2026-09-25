// 模块上下文（见 docs/CONTRACT.md 第 4 节）
import * as THREE from 'three';
import * as geo from './geo.js';
import * as textures from './textures.js';
import { MaterialLibrary, NightMaterials } from './materials.js';
import { overlay } from './util.js';

export function createContext({ renderer, scene, camera, terrain, imagery, sky, lights, labels, exclusions, quality, data, meta }) {
  const night = new NightMaterials();
  const uniforms = {
    uTime: { value: 0 },
    uNight: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uCameraPos: { value: new THREE.Vector3() },
  };
  const ctx = {
    THREE,
    renderer,
    scene,
    camera,
    geo,
    terrain,
    imagery,
    sky,
    lights,
    labels,
    exclusions,
    quality,
    data,
    meta,
    uniforms,
    night,
    mats: new MaterialLibrary(night),
    tex: textures,
    overlay,
    modules: {},
    /** 便捷：经纬度 -> 贴地世界坐标 Vector3（可加离地高度） */
    at(lon, lat, agl = 0) {
      const p = geo.project(lon, lat);
      return new THREE.Vector3(p.x, terrain.heightAt(p.x, p.z) + agl, p.z);
    },
    /** 便捷：世界坐标 x,z -> 贴地 Vector3 */
    ground(x, z, agl = 0) {
      return new THREE.Vector3(x, terrain.heightAt(x, z) + agl, z);
    },
    /**
     * 招牌/匾额：返回一个平面网格（默认正面朝 +Z）。
     * opts: 同 textures.text，另有 height（米，文字牌高度）、emissive（夜间发光强度）、double（双面）
     */
    sign(str, opts = {}) {
      const { height = 1, emissive = 2.2, double = false, emissiveDay = 0.0 } = opts;
      const t = textures.text(str, opts);
      const w = height * t.aspect;
      const mat = new THREE.MeshStandardMaterial({
        map: t.texture,
        emissiveMap: t.texture,
        emissive: 0xffffff,
        emissiveIntensity: 0,
        roughness: 0.5,
        transparent: !opts.bg,
        alphaTest: opts.bg ? 0 : 0.05,
        side: double ? THREE.DoubleSide : THREE.FrontSide,
      });
      night.register(mat, { day: emissiveDay, night: emissive });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, height), mat);
      m.userData.width = w;
      return m;
    },
  };
  return ctx;
}
