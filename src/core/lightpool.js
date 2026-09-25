// 动态点光源池：模块注册任意多个“光源候选”，每帧只把离相机最近的 N 个分配给真实 PointLight
// 灯的数量固定（不因开关导致着色器重编译），不用的灯强度置 0。
import * as THREE from 'three';

export class LightPool {
  constructor(scene, count) {
    this.scene = scene;
    this.sources = [];
    this.lights = [];
    this.group = new THREE.Group();
    this.group.name = 'lightpool';
    scene.add(this.group);
    this.setCount(count);
    this._frame = 0;
  }

  setCount(n) {
    for (const l of this.lights) this.group.remove(l);
    this.lights = [];
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 100, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }
  }

  /**
   * 注册光源：{position: Vector3, color, intensity(坎德拉，参考 50~3000), distance(米), nightOnly=true, priority=1}
   * 返回句柄，可修改其字段。
   */
  add(src) {
    const s = {
      position: src.position.clone ? src.position.clone() : new THREE.Vector3(...src.position),
      color: new THREE.Color(src.color ?? 0xffd9a0),
      intensity: src.intensity ?? 400,
      distance: src.distance ?? 60,
      nightOnly: src.nightOnly !== false,
      priority: src.priority ?? 1,
      enabled: true,
    };
    this.sources.push(s);
    return s;
  }

  update(camera, night) {
    this._frame++;
    if (!this.lights.length) return;
    if (this._frame % 6 !== 0 && this._assigned) {
      this._applyIntensity(night);
      return;
    }
    const cp = camera.position;
    const cands = [];
    for (const s of this.sources) {
      if (!s.enabled) continue;
      if (s.nightOnly && night < 0.05) continue;
      const d = s.position.distanceTo(cp);
      if (d > Math.max(1500, s.distance * 12)) continue;
      cands.push([d / (s.priority * Math.sqrt(s.intensity / 400)), s]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    this._assigned = [];
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const s = cands[i] && cands[i][1];
      if (s) {
        l.position.copy(s.position);
        l.color.copy(s.color);
        l.distance = s.distance;
        l.userData.src = s;
        this._assigned.push(s);
      } else {
        l.userData.src = null;
        l.intensity = 0;
      }
    }
    this._applyIntensity(night);
  }

  _applyIntensity(night) {
    for (const l of this.lights) {
      const s = l.userData.src;
      if (!s) {
        l.intensity = 0;
        continue;
      }
      l.intensity = s.intensity * (s.nightOnly ? night : 1);
    }
  }
}
