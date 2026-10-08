// 公园近景：相机 40 m 内的草丛（实例化，风摆），跟随相机按 0.62 m 抖动格点（世界坐标散列，相机移动不跳变）重填。
// 只种在“公园/草地用地 + 影像不偏亮（不是园路、广场）+ 不压路、水、楼、排除区”的格子里；离相机越远越稀、越矮，40 m 处淡出。
import * as THREE from 'three';
import { grassTuftGeometry } from './park-props.js';
import { M_PARK, M_GRASS, M_WATER, M_BLD, M_ROAD, M_EXCL, M_OCC, hash2 } from './park-index.js';

const R = 36, STEP = 0.42;

/** 风摆材质（草丛与花丛共用）：顶点按 uv.y² 摆动，摆幅随实例位置相位变化 */
export function windMaterial(ctx, { amp = 0.05, side = THREE.DoubleSide, rough = 0.95, tintByUvX = false } = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: 0, side });
  const U = { uTime: ctx.uniforms.uTime };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 wip = instanceMatrix[3].xyz;
#else
  vec3 wip = vec3(0.0);
#endif
  float wph = uTime * 1.9 + wip.x * 0.37 + wip.z * 0.23;
  float wk = ${amp.toFixed(3)} * (0.65 + 0.35 * sin(uTime * 0.37 + wip.x * 0.05)) * uv.y * uv.y;
  transformed.x += sin(wph) * wk;
  transformed.z += cos(wph * 0.83 + 1.3) * wk * 0.6;`);
    if (tintByUvX)
      sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = color * mix(vec3(1.0), instanceColor.rgb, uv.x);
#endif`);
  };
  m.customProgramCacheKey = () => 'park-wind-' + amp + (tintByUvX ? '-t' : '');
  return m;
}

export class GrassField {
  constructor(ctx, root, cap = 16000) {
    this.ctx = ctx;
    this.geo = grassTuftGeometry();
    this.mat = windMaterial(ctx, { amp: 0.045 });
    this.im = new THREE.InstancedMesh(this.geo, this.mat, cap);
    this.im.name = '公园草丛';
    this.im.count = 0;
    this.im.frustumCulled = false;
    this.im.castShadow = false;
    this.im.receiveShadow = true;
    this.im.userData.noReflect = true;
    this.im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    this.im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    root.add(this.im);
    this.cap = cap;
    this.last = new THREE.Vector3(1e9, 0, 0);
    this.enabled = true;
  }

  /**
   * maskAt(x,z) → 掩膜字节（-1 = 未加载），green(x,z) → 0..1 影像“是草”的置信度
   */
  update(cam, maskAt, green, heightAt) {
    const agl = cam.position.y - heightAt(cam.position.x, cam.position.z);
    if (!this.enabled || agl > 24) {
      if (this.im.count) { this.im.count = 0; this.im.visible = false; }
      this.last.set(1e9, 0, 0);
      return;
    }
    const dx = cam.position.x - this.last.x, dz = cam.position.z - this.last.z;
    if (dx * dx + dz * dz < 9 && !this.dirty) return;
    this.dirty = false;
    this.last.copy(cam.position);
    const M = this.im.instanceMatrix.array, C = this.im.instanceColor.array;
    const cx = cam.position.x, cz = cam.position.z;
    let k = 0;
    const g0 = Math.floor((cx - R) / STEP), g1 = Math.floor((cx + R) / STEP);
    const h0 = Math.floor((cz - R) / STEP), h1 = Math.floor((cz + R) / STEP);
    const BAD = M_WATER | M_BLD | M_ROAD | M_EXCL | M_OCC;
    for (let gz = h0; gz <= h1 && k < this.cap; gz++) {
      for (let gx = g0; gx <= g1 && k < this.cap; gx++) {
        const r1 = hash2(gx, gz, 11), r2 = hash2(gx, gz, 23);
        const x = (gx + r1) * STEP, z = (gz + r2) * STEP;
        const d = Math.hypot(x - cx, z - cz);
        if (d > R) continue;
        // 远处抽稀：距离 > 10 m 线性降到 15%（远处的草丛小于一个像素，只剩成本）
        const keep = d < 10 ? 1 : 1 - 0.85 * ((d - 10) / (R - 10));
        if (hash2(gx, gz, 37) > keep) continue;
        const v = maskAt(x, z);
        if (v < 0 || !(v & (M_PARK | M_GRASS)) || v & BAD) continue;
        const gr = green(x, z);
        if (gr < 0.35 + 0.4 * hash2(gx, gz, 41)) continue;
        const y = heightAt(x, z);
        const fade = 1 - THREE.MathUtils.smoothstep(d, R - 8, R);
        const s = (0.8 + 0.7 * hash2(gx, gz, 53)) * (0.4 + 0.6 * fade) * (1 + d * 0.012);
        const a = hash2(gx, gz, 61) * Math.PI * 2;
        const c = Math.cos(a) * s, sn = Math.sin(a) * s;
        const o = k * 16;
        M[o] = c; M[o + 1] = 0; M[o + 2] = -sn; M[o + 3] = 0;
        M[o + 4] = 0; M[o + 5] = s * (0.8 + 0.5 * hash2(gx, gz, 71)); M[o + 6] = 0; M[o + 7] = 0;
        M[o + 8] = sn; M[o + 9] = 0; M[o + 10] = c; M[o + 11] = 0;
        M[o + 12] = x; M[o + 13] = y - 0.02; M[o + 14] = z; M[o + 15] = 1;
        // 色差：十月草坪（偏黄绿，少量枯黄）
        const t = hash2(gx, gz, 83);
        const dry = hash2(Math.floor(gx / 9), Math.floor(gz / 9), 91) > 0.82 ? 0.35 : 0;
        C[k * 3] = 0.8 + 0.4 * t + dry; C[k * 3 + 1] = 0.85 + 0.3 * t + dry * 0.25; C[k * 3 + 2] = 0.8 + 0.25 * t;
        k++;
      }
    }
    this.im.count = k;
    this.im.visible = k > 0;
    this.im.instanceMatrix.clearUpdateRanges();
    this.im.instanceMatrix.addUpdateRange(0, k * 16);
    this.im.instanceMatrix.needsUpdate = true;
    this.im.instanceColor.clearUpdateRanges();
    this.im.instanceColor.addUpdateRange(0, k * 3);
    this.im.instanceColor.needsUpdate = true;
    return k;
  }
}
