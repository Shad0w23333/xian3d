// 漫游控制：飞行模式（WASD + 鼠标，指针锁定）、步行模式（重力贴地）、环绕展示、预设视角平滑飞行
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m = new THREE.Matrix4();

export class Controls {
  constructor(camera, dom, terrain) {
    this.camera = camera;
    this.dom = dom;
    this.terrain = terrain;
    this.mode = 'fly'; // fly | walk | orbit
    this.yaw = 0;
    this.pitch = -0.3;
    this.keys = new Set();
    this.speedFactor = 1;
    this.velocity = new THREE.Vector3();
    this.vy = 0;
    this.locked = false;
    this.enabled = true;
    this.tween = null;
    this.orbit = { target: new THREE.Vector3(), radius: 300, angle: 0, height: 120, speed: 0.08 };
    this.eye = 1.7;
    // 地下浏览（地铁模块设置）：groundFn(x, z, y) → 脚下地面高度（车站/隧道/通道），null 表示不在地下空间内（保持当前高度）
    this.groundFn = null;
    this.onModeChange = null;
    this.onPresetArrive = null;
    this.lookSensitivity = 0.0022;
    this._drag = null;
    camera.rotation.order = 'YXZ';

    this._onKeyDown = (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      this.keys.add(e.code);
      if (e.code === 'Space' && this.mode === 'walk' && this._onGround) this.vy = 4.2;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();
    this._onMouseMove = (e) => {
      if (!this.enabled) return;
      if (this.locked) this._look(e.movementX, e.movementY);
      else if (this._drag) {
        this._look(e.clientX - this._drag.x, e.clientY - this._drag.y);
        this._drag.x = e.clientX;
        this._drag.y = e.clientY;
        this._drag.moved = true;
      }
    };
    this._onMouseDown = (e) => {
      if (e.button === 2 || e.button === 0) this._drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
    };
    this._onMouseUp = (e) => {
      const d = this._drag;
      this._drag = null;
      // 左键单击（未拖动）进入指针锁定
      if (d && !d.moved && d.button === 0 && !this.locked && e.target === this.dom) this.lock();
    };
    this._onWheel = (e) => {
      e.preventDefault();
      if (this.mode === 'orbit') {
        this.orbit.radius = THREE.MathUtils.clamp(this.orbit.radius * (e.deltaY > 0 ? 1.12 : 0.89), 30, 30000);
      } else {
        this.speedFactor = THREE.MathUtils.clamp(this.speedFactor * (e.deltaY > 0 ? 0.85 : 1.18), 0.05, 40);
      }
    };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
    };
    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('mousemove', this._onMouseMove);
    dom.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    dom.addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onLockChange);
    this._initTouch();
  }

  lock() {
    if (this.dom.requestPointerLock) {
      const p = this.dom.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
  }
  unlock() {
    if (document.exitPointerLock) document.exitPointerLock();
  }

  _look(dx, dy) {
    if (this.tween) return;
    if (this.mode === 'orbit') {
      this.orbit.angle -= dx * 0.004;
      this.orbit.height = THREE.MathUtils.clamp(this.orbit.height + dy * this.orbit.radius * 0.004, 5, 20000);
      return;
    }
    this.yaw -= dx * this.lookSensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * this.lookSensitivity, -1.55, 1.55);
  }

  _initTouch() {
    let last = null;
    let pinch = null;
    this.dom.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }, { passive: true });
    this.dom.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && last) {
        const t = e.touches[0];
        this._look((t.clientX - last.x) * 1.4, (t.clientY - last.y) * 1.4);
        last = { x: t.clientX, y: t.clientY };
      } else if (e.touches.length === 2 && pinch) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this._touchMove = (d - pinch) * 0.04;
        pinch = d;
      }
    }, { passive: true });
    this.dom.addEventListener('touchend', () => {
      last = null;
      pinch = null;
      this._touchMove = 0;
    }, { passive: true });
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'orbit') {
      // 以视线与地面交点为环绕中心
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const hit = this.terrain.raycast(this.camera.position, dir, 20000);
      const tgt = hit || this.camera.position.clone().addScaledVector(dir, 500);
      this.orbit.target.copy(tgt);
      const off = this.camera.position.clone().sub(tgt);
      this.orbit.radius = Math.max(50, Math.hypot(off.x, off.z));
      this.orbit.height = Math.max(10, off.y);
      this.orbit.angle = Math.atan2(off.x, off.z);
    }
    if (mode === 'walk') this.vy = 0;
    this.mode = mode;
    if (this.onModeChange) this.onModeChange(mode);
  }

  /** 飞到指定视角：pos / target 为世界坐标 Vector3 */
  flyTo(pos, target, { duration = null, onArrive = null } = {}) {
    const from = this.camera.position.clone();
    const dist = from.distanceTo(pos);
    const dur = duration ?? THREE.MathUtils.clamp(1.2 + Math.log10(1 + dist / 50) * 0.9, 1.2, 4.2);
    _m.lookAt(pos, target, new THREE.Vector3(0, 1, 0));
    const qEnd = new THREE.Quaternion().setFromRotationMatrix(_m);
    this.tween = {
      from,
      to: pos.clone(),
      qFrom: this.camera.quaternion.clone(),
      qTo: qEnd,
      t: 0,
      dur,
      arc: Math.min(dist * 0.28, 6000),
      target: target.clone(),
      onArrive,
    };
    if (this.mode === 'walk') this.setMode('fly');
  }

  _syncAnglesFromCamera() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  update(dt) {
    const cam = this.camera;
    dt = Math.min(dt, 0.1);
    const ground = this.terrain.heightAt(cam.position.x, cam.position.z);
    const agl = cam.position.y - ground;
    cam.userData.agl = agl;
    cam.userData.ground = ground;

    if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      cam.position.lerpVectors(tw.from, tw.to, e);
      cam.position.y += Math.sin(Math.PI * e) * tw.arc;
      cam.quaternion.slerpQuaternions(tw.qFrom, tw.qTo, e);
      if (k >= 1) {
        this.tween = null;
        this._syncAnglesFromCamera();
        if (this.mode === 'orbit') {
          this.orbit.target.copy(tw.target);
          const off = cam.position.clone().sub(tw.target);
          this.orbit.radius = Math.max(30, Math.hypot(off.x, off.z));
          this.orbit.height = off.y;
          this.orbit.angle = Math.atan2(off.x, off.z);
        }
        if (tw.onArrive) tw.onArrive();
      }
      this._clampAboveGround(1.5);
      return;
    }

    if (this.mode === 'orbit') {
      const o = this.orbit;
      if (!this.keys.size) o.angle += dt * o.speed;
      if (this.keys.has('KeyA')) o.angle -= dt * 0.6;
      if (this.keys.has('KeyD')) o.angle += dt * 0.6;
      if (this.keys.has('KeyW')) o.radius = Math.max(30, o.radius * (1 - dt * 0.8));
      if (this.keys.has('KeyS')) o.radius = Math.min(30000, o.radius * (1 + dt * 0.8));
      if (this.keys.has('KeyE') || this.keys.has('Space')) o.height += dt * o.radius * 0.6;
      if (this.keys.has('KeyQ') || this.keys.has('KeyC')) o.height = Math.max(3, o.height - dt * o.radius * 0.6);
      cam.position.set(o.target.x + Math.sin(o.angle) * o.radius, o.target.y + o.height, o.target.z + Math.cos(o.angle) * o.radius);
      this._clampAboveGround(2);
      cam.lookAt(o.target);
      this._syncAnglesFromCamera();
      return;
    }

    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    const fwd = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) move.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) move.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) move.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) move.sub(right);
    if (this._touchMove) move.addScaledVector(fwd, this._touchMove);

    if (this.mode === 'walk') {
      const run = k.has('ShiftLeft') || k.has('ShiftRight');
      const sp = (run ? 11 : 4.2) * Math.min(this.speedFactor, 3);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(sp);
      this.velocity.lerp(move, 1 - Math.exp(-dt * 10));
      cam.position.addScaledVector(this.velocity, dt);
      this.vy -= 9.8 * dt;
      cam.position.y += this.vy * dt;
      const g = this._groundAt(cam.position.x, cam.position.z, cam.position.y) + this.eye;
      if (this.groundFn) this._lastUnder = g - this.eye;
      this._onGround = cam.position.y <= g + 0.01;
      if (cam.position.y < g) {
        cam.position.y = g;
        this.vy = 0;
      }
      return;
    }

    // 飞行：速度随离地高度自适应
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 5 : 1;
    const slow = k.has('AltLeft') || k.has('AltRight') ? 0.2 : 1;
    const base = this.groundFn ? 8 : THREE.MathUtils.clamp(Math.max(agl, 2) * 0.9, 6, 3000);
    const sp = base * this.speedFactor * boost * slow;
    // 飞行时 W/S 沿视线方向（含俯仰），更直观
    const look = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const m3 = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) m3.add(look);
    if (k.has('KeyS') || k.has('ArrowDown')) m3.sub(look);
    if (k.has('KeyD') || k.has('ArrowRight')) m3.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) m3.sub(right);
    if (k.has('KeyE') || k.has('Space')) m3.y += 1;
    if (k.has('KeyQ') || k.has('KeyC')) m3.y -= 1;
    if (this._touchMove) m3.addScaledVector(look, this._touchMove);
    if (m3.lengthSq() > 0) m3.normalize().multiplyScalar(sp);
    this.velocity.lerp(m3, 1 - Math.exp(-dt * 6));
    cam.position.addScaledVector(this.velocity, dt);
    // 活动范围限制
    cam.position.x = THREE.MathUtils.clamp(cam.position.x, -75000, 75000);
    cam.position.z = THREE.MathUtils.clamp(cam.position.z, -75000, 75000);
    cam.position.y = Math.min(cam.position.y, 40000);
    this._clampAboveGround(1.6);
  }

  _groundAt(x, z, y) {
    if (!this.groundFn) return this.terrain.heightAt(x, z);
    const g = this.groundFn(x, z, y);
    return g ?? (this._lastUnder ?? y - this.eye);
  }

  _clampAboveGround(min) {
    const cam = this.camera;
    if (this.groundFn) {
      // 地下：只在车站/隧道/通道内防止穿地板；空间外自由飞行
      const g = this.groundFn(cam.position.x, cam.position.z, cam.position.y);
      if (g != null) {
        this._lastUnder = g;
        if (cam.position.y < g + min) cam.position.y = g + min;
      }
      return;
    }
    const g = this.terrain.heightAt(cam.position.x, cam.position.z);
    if (cam.position.y < g + min) cam.position.y = g + min;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
