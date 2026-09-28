// 卫星影像：内置降级底图（img_*.jpg）+ 在线瓦片流式加载（高德/Esri，高德自动做 GCJ-02 纠偏拼接；LRU 缓存、按距离优先、离线自动降级）
import * as THREE from 'three';
import { loadImageBitmap } from './data.js';
import { IMAGERY_PROVIDERS, DEFAULT_IMAGERY } from './config.js';
import { wgs2gcj } from './gcj.js';

const ENTRY = new WeakMap(); // texture -> cache entry

export class Imagery {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), quality.anisotropy || 8);
    this.mosaics = [];
    this.provider = IMAGERY_PROVIDERS[DEFAULT_IMAGERY];
    this.providerId = DEFAULT_IMAGERY;
    this.raw = new Map(); // GCJ 原始瓦片缓存 key -> Promise<ImageBitmap>
    // 是否允许联网影像（?online=0 / 面板“在线高清卫星影像”勾选框）；本地离线包不联网，不受它影响
    this.netAllowed = true;
    this.generation = 0;
    this.online = {
      enabled: true, // 当前影像源是否加载瓦片 = 本地包 || netAllowed（见 _syncEnabled）
      url: this.provider.url,
      maxZoom: this.provider.maxZoom,
      status: '等待', // 等待 / 在线 / 离线
      ok: 0,
      fail: 0,
    };
    this.cache = new Map(); // key -> {tex, refs, lastUse, z}
    this.failed = new Set();
    this.pending = new Map(); // key -> {z,x,y,priority}
    this.inflight = new Map();
    this.maxInflight = 12;
    this.cacheLimit = 700;
    this.listeners = new Set();
    this.frame = 0;
    this.retries = new Map(); // key -> 重试次数
    this.backoff = new Map(); // key -> 允许重试的时间
    this.consecutiveFail = 0;
    this.pauseUntil = 0;
    this.hosts = ['server.arcgisonline.com', 'services.arcgisonline.com'];
  }

  setOnlineConfig(cfg) {
    // meta.json 里的 online 配置只对 Esri 源生效（旧数据）；默认用高德
    if (!cfg || this.provider.gcj) return;
    if (cfg.maxZoom) this.online.maxZoom = cfg.maxZoom;
  }

  /** 挂接本地离线瓦片包（TilePack） */
  attachPack(pack) {
    this.pack = pack;
    if (pack.attribution) IMAGERY_PROVIDERS.local.attribution = pack.attribution;
    IMAGERY_PROVIDERS.local.maxZoom = pack.maxZoom;
  }

  /** 切换影像源（'local' | 'amap' | 'esri'），清空已加载的瓦片 */
  setProvider(id) {
    const p = IMAGERY_PROVIDERS[id];
    if (!p || id === this.providerId) return false;
    if (p.local && !this.pack) return false;
    this.provider = p;
    this.providerId = id;
    this.online.url = p.url;
    this.online.maxZoom = p.maxZoom;
    this.maxInflight = p.local ? 16 : 12;
    this.pending.clear();
    this.failed.clear();
    // 中止旧源的在途请求，释放并发槽（否则网络不通时旧请求要等 15 s 超时才让出，其失败还会计入新源的退避）
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    for (const [, e] of this.cache) if (e.refs === 0) { e.tex.dispose(); e.tex.image && e.tex.image.close && e.tex.image.close(); }
    this.cache = new Map([...this.cache].filter(([, e]) => e.refs > 0)); // 仍被地形引用的旧瓦片稍后自然回收
    this.generation = (this.generation || 0) + 1;
    this._syncEnabled();
    return true;
  }

  async loadMosaics(list) {
    const jobs = (list || []).map(async (m) => {
      const bmp = await loadImageBitmap(m.file, { optional: true });
      if (!bmp) return null;
      const tex = new THREE.Texture(bmp);
      tex.flipY = false; // 位图已在解码时翻转
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.anisotropy;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.needsUpdate = true;
      const b = m.bounds;
      return {
        file: m.file,
        bounds: b,
        w: bmp.width,
        h: bmp.height,
        mpp: (b.x1 - b.x0) / bmp.width,
        priority: m.priority ?? 0,
        texture: tex,
      };
    });
    this.mosaics = (await Promise.all(jobs)).filter(Boolean).sort((a, b) => a.mpp - b.mpp);
    // 预上传，避免首帧卡顿
    for (const m of this.mosaics) this.renderer.initTexture(m.texture);
  }

  /** 找到覆盖 bounds 的最高清底图：优先完全覆盖；否则取覆盖率 ≥ 50% 的；都没有返回 null（不拉伸） */
  bestMosaic(b) {
    let partial = null, bestFrac = 0.5;
    const area = (b.x1 - b.x0) * (b.z1 - b.z0);
    for (const m of this.mosaics) {
      const mb = m.bounds;
      if (b.x0 >= mb.x0 - 1 && b.x1 <= mb.x1 + 1 && b.z0 >= mb.z0 - 1 && b.z1 <= mb.z1 + 1) return m;
      const ox = Math.max(0, Math.min(b.x1, mb.x1) - Math.max(b.x0, mb.x0));
      const oz = Math.max(0, Math.min(b.z1, mb.z1) - Math.max(b.z0, mb.z0));
      const f = (ox * oz) / area;
      if (f > bestFrac) { bestFrac = f; partial = m; }
    }
    return partial;
  }

  key(z, x, y) {
    return `${this.providerId}/${z}/${x}/${y}`;
  }

  /** 已加载的在线瓦片纹理（主纹理），不存在返回 null */
  get(z, x, y) {
    const e = this.cache.get(this.key(z, x, y));
    if (e) e.lastUse = this.frame;
    return e ? e.tex : null;
  }

  isFailed(z, x, y) {
    return this.failed.has(this.key(z, x, y));
  }

  /** 请求在线瓦片；priority 越小越先加载 */
  request(z, x, y, priority) {
    if (!this.online.enabled) return;
    const k = this.key(z, x, y);
    if (this.cache.has(k) || this.failed.has(k) || this.inflight.has(k)) return;
    // 本地包：包里没有的瓦片直接记为失败（地形会退回祖先瓦片或内置底图）
    if (this.provider.local && !this.pack.has(z, x, y)) { this.failed.add(k); return; }
    const bo = this.backoff.get(k);
    if (bo && performance.now() < bo) return;
    const p = this.pending.get(k);
    if (p) {
      p.priority = Math.min(p.priority, priority);
      p.frame = this.frame;
    } else this.pending.set(k, { z, x, y, priority, frame: this.frame });
  }

  retain(tex) {
    const e = tex && ENTRY.get(tex);
    if (e) e.refs++;
  }
  release(tex) {
    const e = tex && ENTRY.get(tex);
    if (e) e.refs = Math.max(0, e.refs - 1);
  }

  onLoaded(fn) {
    this.listeners.add(fn);
  }

  update() {
    this.frame++;
    // 丢弃过期请求（连续 30 帧无人再要）
    for (const [k, p] of this.pending) if (this.frame - p.frame > 30) this.pending.delete(k);
    if (!this.online.enabled) {
      this.pending.clear();
      return;
    }
    if (performance.now() < this.pauseUntil) return;
    if (this.inflight.size < this.maxInflight && this.pending.size) {
      const sorted = [...this.pending.entries()].sort((a, b) => a[1].priority - b[1].priority);
      for (const [k, p] of sorted) {
        if (this.inflight.size >= this.maxInflight) break;
        this.pending.delete(k);
        this._fetch(k, p);
      }
    }
    if (this.cache.size > this.cacheLimit) this._evict();
  }

  _url(z, x, y) {
    let u = this.online.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const subs = this.provider.subdomains;
    if (subs) u = u.replace('{s}', subs[(x + y) % subs.length]);
    // Esri 两个同源主机轮换，分摊连接
    if (u.includes('server.arcgisonline.com')) u = u.replace('server.arcgisonline.com', this.hosts[(x + y) & 1]);
    return u;
  }

  /** 取一张原始瓦片（带缓存），返回 ImageBitmap（未翻转） */
  _raw(z, x, y, signal) {
    const k = `${this.providerId}:${z}/${x}/${y}`;
    let pr = this.raw.get(k);
    if (pr) {
      this.raw.delete(k);
      this.raw.set(k, pr); // LRU 刷新
      return pr;
    }
    pr = (async () => {
      const res = await fetch(this._url(z, x, y), { mode: 'cors', signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (blob.size < 900) throw new Error('placeholder');
      return createImageBitmap(blob, { colorSpaceConversion: 'none' });
    })();
    pr.catch(() => this.raw.delete(k));
    this.raw.set(k, pr);
    if (this.raw.size > 360) {
      const old = this.raw.keys().next().value;
      const op = this.raw.get(old);
      this.raw.delete(old);
      op.then((b) => b.close && setTimeout(() => b.close(), 2000)).catch(() => {});
    }
    return pr;
  }

  /** GCJ-02 源：把 WGS 瓦片 (z,x,y) 对应的区域从 2×2 张火星坐标瓦片中裁出来，返回翻转好的 ImageBitmap */
  async _composeGcj(z, x, y, signal) {
    const n = 2 ** z;
    const lonW = (x / n) * 360 - 180;
    const latN = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    const lonC = ((x + 0.5) / n) * 360 - 180;
    const latC = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
    const g = wgs2gcj(lonC, latC);
    const lon = lonW + (g.lon - lonC), lat = latN + (g.lat - latC);
    const tx = ((lon + 180) / 360) * n;
    const lr = (lat * Math.PI) / 180;
    const ty = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n;
    const ix = Math.floor(tx), iy = Math.floor(ty);
    const fx = tx - ix, fy = ty - iy;
    const need = [[0, 0], [1, 0], [0, 1], [1, 1]].filter(([dx, dy]) => (dx === 0 || fx > 1e-4) && (dy === 0 || fy > 1e-4));
    const bmps = await Promise.all(need.map(([dx, dy]) => this._raw(z, ix + dx, iy + dy, signal)));
    const S = 256;
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S) : Object.assign(document.createElement('canvas'), { width: S, height: S });
    const g2 = cv.getContext('2d');
    need.forEach(([dx, dy], i) => g2.drawImage(bmps[i], (dx - fx) * S, (dy - fy) * S, S, S));
    return createImageBitmap(cv, { imageOrientation: 'flipY' });
  }

  async _fetch(k, p) {
    const ctrl = new AbortController();
    this.inflight.set(k, ctrl);
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const gen = this.generation || 0;
    try {
      let bmp;
      if (this.provider.local) {
        const blob = await this.pack.get(p.z, p.x, p.y, ctrl.signal);
        if (!blob) throw new Error('placeholder');
        bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', colorSpaceConversion: 'none' });
      } else if (this.provider.gcj) {
        bmp = await this._composeGcj(p.z, p.x, p.y, ctrl.signal);
      } else {
        const res = await fetch(this._url(p.z, p.x, p.y), { mode: 'cors', signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        // Esri 在无数据区域会返回很小的灰色占位图
        if (blob.size < 1200) throw new Error('placeholder');
        bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', colorSpaceConversion: 'none' });
      }
      if (gen !== (this.generation || 0)) { bmp.close && bmp.close(); return; } // 期间切换了影像源
      const tex = new THREE.Texture(bmp);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.anisotropy;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      const entry = { tex, refs: 0, lastUse: this.frame, z: p.z };
      ENTRY.set(tex, entry);
      this.cache.set(k, entry);
      this.online.ok++;
      this.consecutiveFail = 0;
      this.retries.delete(k);
      this.online.status = '在线';
      for (const fn of this.listeners) fn(p.z, p.x, p.y, tex);
    } catch (e) {
      // 期间切换了影像源（旧请求已被中止）：不计入失败/退避
      if (gen !== (this.generation || 0)) return;
      // 占位图/404：永久失败；网络错误：退避重试，不永久关闭在线影像
      const permanent = e.message === 'placeholder' || /HTTP 4\d\d/.test(e.message);
      if (permanent) this.failed.add(k);
      else {
        const r = (this.retries.get(k) || 0) + 1;
        this.retries.set(k, r);
        if (r >= 4) this.failed.add(k);
        else this.backoff.set(k, performance.now() + 1500 * r * r);
        this.online.fail++;
        this.consecutiveFail++;
        if (this.online.ok === 0 && this.consecutiveFail >= 16) {
          this.online.status = '连接失败，重试中';
          this.pauseUntil = performance.now() + 15000;
          this.consecutiveFail = 8;
        }
      }
    } finally {
      clearTimeout(timer);
      // 切换源后同名 key 可能已被新请求占用，只删自己的
      if (this.inflight.get(k) === ctrl) this.inflight.delete(k);
    }
  }

  _evict() {
    const entries = [...this.cache.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].lastUse - b[1].lastUse);
    let n = this.cache.size - Math.floor(this.cacheLimit * 0.85);
    for (const [k, e] of entries) {
      if (n-- <= 0) break;
      e.tex.dispose();
      if (e.tex.image && e.tex.image.close) e.tex.image.close();
      this.cache.delete(k);
    }
  }

  /** 允许/禁止联网影像（?online=0、面板勾选框）；本地离线包照常加载 */
  setOnlineEnabled(on) {
    this.netAllowed = !!on;
    this._syncEnabled();
  }

  /** 按当前影像源重算 online.enabled：本地包总是加载，联网源受 netAllowed 控制 */
  _syncEnabled() {
    const on = !!this.provider.local || this.netAllowed;
    this.online.enabled = on;
    this.online.status = on ? (this.online.ok ? '在线' : '等待') : '离线';
    if (on) {
      this.online.fail = 0;
      this.consecutiveFail = 0;
      this.pauseUntil = 0;
      this.retries.clear();
      this.backoff.clear();
      this.failed.clear();
    }
  }
}
