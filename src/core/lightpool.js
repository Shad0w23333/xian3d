// 动态点光源池：模块注册任意多个“光源候选”，每帧只把离相机最近的 N 个分配给真实 PointLight
// 灯的数量只在画质/设置改变时变化（不因开关导致着色器重编译），不用的灯强度置 0。
import * as THREE from 'three';

export class LightPool {
  /** renderer / camera（可选）：运行中改灯数时先在后台预编译新的着色器变体，编译完再换灯（见 setCount） */
  constructor(scene, count, renderer = null, camera = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.sources = [];
    this.pool = []; // 场景里实际的 PointLight
    this.active = 0; // 参与分配的灯数
    this._token = 0;
    this.group = new THREE.Group();
    this.group.name = 'lightpool';
    scene.add(this.group);
    this._frame = 0;
    this.setCount(count);
  }

  /** 参与分配的灯（长度 = 当前设置的灯数；画质面板据此判断是否需要 setCount） */
  get lights() {
    return this.pool.slice(0, this.active);
  }

  _mkLight() {
    const l = new THREE.PointLight(0xffffff, 0, 100, 2);
    l.castShadow = false;
    return l;
  }

  /**
   * 设置灯数。three 按场景里的点光源个数编译着色器（NUM_POINT_LIGHTS），直接增删灯会让全场 300 多个程序
   * 在下一帧同步重编译，画质切换时卡 20~30 秒（审查 P0）。运行中改灯数时：先用 renderer.compileAsync
   * 按“新灯数”在后台（KHR_parallel_shader_compile）预编译全部材质，编译完成后才真正增删灯；
   * 期间继续用旧灯渲染（多出来的名额暂不分配）。启动阶段（尚未渲染）直接增删，由启动时的整体预编译覆盖。
   */
  setCount(n) {
    n = Math.max(0, n | 0);
    this.active = n;
    this._assigned = null; // 下一帧重新分配
    const token = ++this._token;
    const cur = this.pool.length;
    if (n === cur) return;
    const r = this.renderer;
    if (!r || !this.camera || !r.compileAsync || this._frame === 0) {
      this._resize(n);
      return;
    }
    // 预编译：临时场景带上新增的灯（雾、环境贴图与主场景一致，着色器变体才对得上）；减灯时把要删的灯暂时隐藏
    const temp = new THREE.Scene();
    temp.fog = this.scene.fog;
    temp.environment = this.scene.environment;
    const added = [];
    for (let i = cur; i < n; i++) {
      const l = this._mkLight();
      temp.add(l);
      added.push(l);
    }
    const hid = [];
    for (let i = n; i < cur; i++) if (this.pool[i].visible) { this.pool[i].visible = false; hid.push(this.pool[i]); }
    const prevRT = r.getRenderTarget();
    // 主画面渲染进后期管线的浮点渲染目标（不做色调映射、线性输出）：预编译时也绑一个渲染目标，变体才一致
    if (!this._compileRT) this._compileRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    let job;
    try {
      r.setRenderTarget(this._compileRT);
      job = r.compileAsync(this.scene, this.camera, temp);
    } catch (e) {
      job = null;
    } finally {
      r.setRenderTarget(prevRT);
      for (const l of hid) l.visible = true;
    }
    const apply = () => {
      for (const l of added) temp.remove(l);
      if (token !== this._token) return; // 期间又改了灯数，以最新一次为准
      this._resize(n, added);
    };
    if (job && job.then) job.then(apply, apply);
    else apply();
  }

  /** 立即增删到 n 盏（reuse：新灯优先用已创建的） */
  _resize(n, reuse = []) {
    while (this.pool.length > n) this.group.remove(this.pool.pop());
    while (this.pool.length < n) {
      const l = reuse.shift() || this._mkLight();
      this.pool.push(l);
      this.group.add(l);
    }
    this._assigned = null;
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
    if (!this.camera) this.camera = camera;
    if (!this.pool.length) return;
    if (this._frame % 6 !== 0 && this._assigned) {
      this._applyIntensity(night);
      return;
    }
    const cp = camera.position;
    camera.getWorldDirection(this._fwd || (this._fwd = new THREE.Vector3()));
    const fwd = this._fwd;
    const cands = [];
    for (const s of this.sources) {
      if (!s.enabled) continue;
      if (s.nightOnly && night < 0.05) continue;
      const d = s.position.distanceTo(cp);
      if (d > Math.max(1500, s.distance * 12)) continue;
      // 相机身后、且照明范围够不到相机的灯排到后面：名额（4~12 盏）留给画面里看得见的灯
      const dx = s.position.x - cp.x, dy = s.position.y - cp.y, dz = s.position.z - cp.z;
      const ahead = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / Math.max(d, 1e-3);
      const behind = ahead < -0.2 && d > s.distance * 0.6 ? 3 : 1;
      cands.push([(d * behind) / (s.priority * Math.sqrt(s.intensity / 400)), s]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    // 已占用灯位的光源尽量留在原灯位（不重新分配就不会闪），新光源从 0 淡入
    const want = new Set();
    const nAct = Math.min(this.active, this.pool.length);
    for (let i = 0; i < nAct && i < cands.length; i++) want.add(cands[i][1]);
    const free = [];
    for (const l of this.pool) {
      const s = l.userData.src;
      if (s && want.has(s)) want.delete(s);
      else free.push(l);
    }
    for (const l of free) {
      const s = want.values().next().value;
      if (s) {
        want.delete(s);
        l.position.copy(s.position);
        l.color.copy(s.color);
        l.distance = s.distance;
        l.userData.src = s;
        l.userData.fade = 0;
      } else {
        l.userData.src = null;
        l.intensity = 0;
      }
    }
    this._assigned = [];
    for (const l of this.pool) if (l.userData.src) this._assigned.push(l.userData.src);
    this._applyIntensity(night);
  }

  _applyIntensity(night) {
    for (const l of this.pool) {
      const s = l.userData.src;
      if (!s) {
        l.intensity = 0;
        continue;
      }
      // 淡入约 12 帧（0.2 s）
      const f = (l.userData.fade = Math.min(1, (l.userData.fade ?? 1) + 0.085));
      l.intensity = s.intensity * (s.nightOnly ? night : 1) * f * f;
    }
  }
}
