// 界面：加载页、信息栏、控制面板（时间/视角/画质/图层）、帮助、小地图、提示
import { unproject } from './geo.js';
import { QUALITY_LEVELS, PRESETS, PRESETS_EXTRA } from './config.js';

const h = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

const fmtTime = (hours) => {
  const hh = Math.floor(hours);
  const mm = Math.floor((hours - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

export class UI {
  constructor(root) {
    this.root = root;
    this.handlers = {};
    this.loading = h('div', 'loading');
    this.loading.innerHTML = `
      <div class="loading-inner">
        <div class="loading-seal">长安</div>
        <h1>西安 · 3D</h1>
        <p class="loading-sub">城墙 · 钟楼 · 大雁塔 · 大唐不夜城 · 曲江 · 高新 · 未央 · 咸阳机场 · 渭河</p>
        <div class="bar"><div class="bar-fill"></div></div>
        <p class="loading-msg">正在准备……</p>
        <p class="loading-tip">提示：单击画面锁定鼠标，WASD 漫游；按 1~0 切换预设视角，N 切换日夜。</p>
      </div>`;
    root.appendChild(this.loading);
    this.hidden = new URLSearchParams(location.search).get('ui') === '0';
  }

  setLoading(frac, msg) {
    this.loading.querySelector('.bar-fill').style.width = `${Math.round(frac * 100)}%`;
    if (msg) this.loading.querySelector('.loading-msg').textContent = msg;
  }

  hideLoading() {
    this.loading.classList.add('done');
    setTimeout(() => this.loading.remove(), 900);
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }
  emit(name, ...args) {
    if (this.handlers[name]) this.handlers[name](...args);
  }

  build(app) {
    this.app = app;
    const root = this.root;
    if (this.hidden) root.classList.add('ui-hidden');

    // —— 左上：标题与坐标 ——
    this.info = h('div', 'panel info');
    this.info.innerHTML = `
      <div class="brand"><span class="brand-seal">长安</span><div><b>西安 3D</b><small>Three.js 城市模型</small></div></div>
      <div class="info-grid">
        <span>位置</span><b class="i-place">—</b>
        <span>坐标</span><b class="i-ll">—</b>
        <span>海拔</span><b class="i-alt">—</b>
        <span>模式</span><b class="i-mode">飞行</b>
        <span>速度</span><b class="i-speed">—</b>
      </div>`;
    root.appendChild(this.info);

    // —— 右侧：控制面板 ——
    this.panel = h('div', 'panel side');
    const presetBtns = PRESETS.map((p) => `<button class="preset" data-key="${p.key}"><kbd>${p.key}</kbd>${p.name}</button>`).join('');
    const extraBtns = PRESETS_EXTRA.map((p) => `<button class="preset" data-key="${p.key}"><kbd>⇧${p.key.slice(1)}</kbd>${p.name}</button>`).join('');
    this.panel.innerHTML = `
      <div class="sec">
        <div class="sec-h">时间 <b class="t-clock">16:00</b><span class="t-phase"></span></div>
        <input type="range" class="t-slider" min="0" max="24" step="0.01" value="16" />
        <div class="row">
          <button class="t-day">☀ 白天</button>
          <button class="t-night">☾ 夜景</button>
          <button class="t-play">▶ 流逝</button>
          <select class="t-speed" title="时间流速">
            <option value="0.0166667">1 分/秒</option>
            <option value="0.1666667" selected>10 分/秒</option>
            <option value="1">1 时/秒</option>
          </select>
        </div>
      </div>
      <div class="sec">
        <div class="sec-h">预设视角</div>
        <div class="presets">${presetBtns}</div>
        <details class="more"><summary>更多视角</summary><div class="presets">${extraBtns}</div></details>
      </div>
      <div class="sec">
        <div class="sec-h">画质 <span class="fps">— fps</span></div>
        <div class="row q-row">${QUALITY_LEVELS.map((q, i) => `<button class="q" data-q="${i}">${q.name}</button>`).join('')}</div>
        <div class="stats"></div>
      </div>
      <div class="sec">
        <div class="sec-h">图层</div>
        <label><input type="checkbox" class="l-online" checked /> 在线高清卫星影像 <em class="online-status"></em></label>
        <label>影像源 <select class="l-provider"><option value="local">本地离线高清</option><option value="amap">高德卫星（较新）</option><option value="esri">Esri 卫星</option></select></label>
        <label><input type="checkbox" class="l-traffic" checked /> 交通流与航班</label>
        <label><input type="checkbox" class="l-labels" checked /> 地名标注</label>
        <label><input type="checkbox" class="l-buildings" checked /> 城市建筑</label>
      </div>
      <button class="collapse" title="收起/展开">⟩</button>`;
    root.appendChild(this.panel);

    // —— 底部：按键提示 ——
    this.hints = h('div', 'hints');
    this.hints.innerHTML = `<span><kbd>单击</kbd>锁定鼠标</span><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>移动</span><span><kbd>Q</kbd><kbd>E</kbd>降/升</span><span><kbd>Shift</kbd>加速</span><span><kbd>滚轮</kbd>调速</span><span><kbd>1</kbd>~<kbd>0</kbd>视角</span><span><kbd>N</kbd>日夜</span><span><kbd>G</kbd>步行</span><span><kbd>O</kbd>环绕</span><span><kbd>H</kbd>帮助</span>`;
    root.appendChild(this.hints);

    // —— 版权 ——
    this.attrib = h('div', 'attrib');
    root.appendChild(this.attrib);

    // —— 提示气泡 ——
    this.toastEl = h('div', 'toast');
    root.appendChild(this.toastEl);

    // —— 准星 ——
    this.cross = h('div', 'crosshair');
    root.appendChild(this.cross);

    // —— 小地图 ——
    this.mini = h('div', 'panel minimap');
    this.miniCanvas = h('canvas');
    this.miniCanvas.width = 220;
    this.miniCanvas.height = 220;
    this.mini.appendChild(this.miniCanvas);
    root.appendChild(this.mini);

    // —— 帮助 ——
    this.help = h('div', 'help');
    this.help.innerHTML = `
      <div class="help-card">
        <h2>操作说明</h2>
        <div class="help-cols">
          <div>
            <h3>漫游</h3>
            <p><kbd>单击画面</kbd> 锁定鼠标（<kbd>Esc</kbd> 释放）；未锁定时也可按住左键拖动转视角</p>
            <p><kbd>W A S D</kbd> / 方向键：前后左右（飞行模式沿视线方向）</p>
            <p><kbd>E</kbd>/<kbd>空格</kbd> 上升，<kbd>Q</kbd>/<kbd>C</kbd> 下降</p>
            <p><kbd>Shift</kbd> 5 倍加速，<kbd>Alt</kbd> 精细慢速，<kbd>滚轮</kbd> 调整基础速度</p>
            <p>速度会随离地高度自动变化：贴地慢、高空快</p>
            <h3>模式</h3>
            <p><kbd>G</kbd> 步行模式（重力贴地、<kbd>空格</kbd> 跳跃）/ 飞行模式</p>
            <p><kbd>O</kbd> 环绕展示模式（自动绕视点旋转，滚轮缩放）</p>
          </div>
          <div>
            <h3>预设视角</h3>
            ${PRESETS.map((p) => `<p><kbd>${p.key}</kbd> ${p.name}</p>`).join('')}
            <p><kbd>Shift</kbd> + <kbd>1</kbd>~<kbd>5</kbd>：${PRESETS_EXTRA.map((p) => p.name).join('、')}</p>
          </div>
          <div>
            <h3>时间与显示</h3>
            <p><kbd>N</kbd> 日/夜切换，<kbd>T</kbd> 时间流逝开关，<kbd>[</kbd> <kbd>]</kbd> 时间 ±30 分钟</p>
            <p><kbd>L</kbd> 地名标注，<kbd>M</kbd> 小地图，<kbd>P</kbd> 控制面板</p>
            <p><kbd>F</kbd> 全屏，<kbd>K</kbd> 截图保存 PNG</p>
            <p><kbd>H</kbd> 或 <kbd>?</kbd> 打开/关闭本帮助</p>
            <h3>画质</h3>
            <p>右侧面板可选 低/中/高/超高。卡顿时先降一档；“在线高清卫星影像”需联网，离线时自动使用内置影像。</p>
          </div>
        </div>
        <p class="help-close">按 <kbd>H</kbd> 或点击任意处关闭</p>
      </div>`;
    this.help.addEventListener('click', () => this.toggleHelp(false));
    root.appendChild(this.help);

    this._bind();
  }

  _bind() {
    const $ = (s) => this.panel.querySelector(s);
    this.slider = $('.t-slider');
    this.slider.addEventListener('input', () => this.emit('hours', parseFloat(this.slider.value)));
    $('.t-day').addEventListener('click', () => this.emit('hoursAnimated', 13.5));
    $('.t-night').addEventListener('click', () => this.emit('hoursAnimated', 20.6));
    $('.t-play').addEventListener('click', () => this.emit('togglePlay'));
    $('.t-speed').addEventListener('change', (e) => this.emit('speed', parseFloat(e.target.value)));
    this.panel.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => this.emit('preset', b.dataset.key)));
    this.panel.querySelectorAll('.q').forEach((b) => b.addEventListener('click', () => this.emit('quality', parseInt(b.dataset.q))));
    $('.l-online').addEventListener('change', (e) => this.emit('online', e.target.checked));
    $('.l-provider').addEventListener('change', (e) => this.emit('provider', e.target.value));
    $('.l-traffic').addEventListener('change', (e) => this.emit('traffic', e.target.checked));
    $('.l-labels').addEventListener('change', (e) => this.emit('labels', e.target.checked));
    $('.l-buildings').addEventListener('change', (e) => this.emit('buildings', e.target.checked));
    $('.collapse').addEventListener('click', () => this.togglePanel());
    // 面板内交互不触发画面锁定
    for (const el of [this.panel, this.info, this.mini]) el.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  setQualityActive(i) {
    this.panel.querySelectorAll('.q').forEach((b) => b.classList.toggle('on', parseInt(b.dataset.q) === i));
  }
  setPlaying(p) {
    this.panel.querySelector('.t-play').textContent = p ? '❚❚ 暂停' : '▶ 流逝';
  }
  setLayer(name, v) {
    const el = this.panel.querySelector('.l-' + name);
    if (el) el.checked = v;
  }
  setProvider(id, hasLocal = true) {
    const el = this.panel.querySelector('.l-provider');
    if (!el) return;
    const opt = el.querySelector('option[value="local"]');
    if (opt && !hasLocal) opt.remove();
    el.value = id;
  }
  setAttribution(list) {
    this.attrib.textContent = list.join(' · ');
  }
  togglePanel(force) {
    const c = force ?? !this.panel.classList.contains('collapsed');
    this.panel.classList.toggle('collapsed', c);
  }
  toggleHelp(force) {
    const on = force ?? !this.help.classList.contains('on');
    this.help.classList.toggle('on', on);
  }
  toggleMinimap(force) {
    const on = force ?? this.mini.classList.contains('off');
    this.mini.classList.toggle('off', !on);
  }
  toast(msg, ms = 2200) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('on');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.toastEl.classList.remove('on'), ms);
  }

  /** 小地图底图：取最大范围的内置影像 */
  setMinimapImage(bitmap, bounds) {
    this.miniImg = { bitmap, bounds };
  }

  update(state) {
    const { camera, sky, fps, stats, place, mode, speed, online, locked } = state;
    this._n = (this._n || 0) + 1;
    if (this._n % 6 === 0) {
      const ll = unproject(camera.position.x, camera.position.z);
      const q = (s) => this.info.querySelector(s);
      q('.i-place').textContent = place || '西安';
      q('.i-ll').textContent = `${ll.lon.toFixed(5)}°E ${ll.lat.toFixed(5)}°N`;
      q('.i-alt').textContent = `${camera.position.y.toFixed(0)} m（离地 ${Math.max(0, camera.userData.agl || 0).toFixed(0)} m）`;
      q('.i-mode').textContent = { fly: '飞行', walk: '步行', orbit: '环绕' }[mode] + (locked ? ' · 鼠标已锁定' : '');
      q('.i-speed').textContent = `${speed.toFixed(1)} m/s`;
      this.panel.querySelector('.fps').textContent = `${fps.toFixed(0)} fps`;
      this.panel.querySelector('.stats').textContent = stats;
      this.panel.querySelector('.online-status').textContent = online;
      this.cross.classList.toggle('on', locked);
    }
    if (!this.slider.matches(':active')) this.slider.value = sky.hours.toFixed(2);
    this.panel.querySelector('.t-clock').textContent = fmtTime(sky.hours);
    const el = sky.sunElev;
    this.panel.querySelector('.t-phase').textContent = el > 8 ? '白昼' : el > -1 ? '黄昏/清晨' : el > -8 ? '蓝调时刻' : '夜晚';
    if (this._n % 3 === 0) this._drawMinimap(camera);
  }

  _drawMinimap(camera) {
    if (!this.miniImg || this.mini.classList.contains('off')) return;
    const c = this.miniCanvas, g = c.getContext('2d');
    const { bitmap, bounds } = this.miniImg;
    const span = 16000; // 小地图显示范围（米）
    const cx = camera.position.x, cz = camera.position.z;
    const bw = bounds.x1 - bounds.x0, bh = bounds.z1 - bounds.z0;
    const sx = ((cx - span / 2 - bounds.x0) / bw) * bitmap.width;
    const sy = ((cz - span / 2 - bounds.z0) / bh) * bitmap.height;
    const sw = (span / bw) * bitmap.width, sh = (span / bh) * bitmap.height;
    g.save();
    g.fillStyle = '#111';
    g.fillRect(0, 0, c.width, c.height);
    // 位图在解码时已上下翻转，这里翻回来
    g.translate(0, c.height);
    g.scale(1, -1);
    g.drawImage(bitmap, sx, bitmap.height - sy - sh, sw, sh, 0, 0, c.width, c.height);
    g.restore();
    // 相机箭头
    const yaw = Math.atan2(-camera.matrixWorld.elements[8], -camera.matrixWorld.elements[10]);
    g.save();
    g.translate(c.width / 2, c.height / 2);
    g.rotate(-yaw + Math.PI);
    g.fillStyle = '#ffcf5a';
    g.strokeStyle = '#000';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(7, 8);
    g.lineTo(0, 4);
    g.lineTo(-7, 8);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = '11px sans-serif';
    g.fillText('北 ↑   范围 16 km', 8, 16);
  }
}
