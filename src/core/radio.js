// 西安 / 陕西网络广播：电台表 + 播放器（多候选源按顺序回退、m3u8 按需加载 hls.js、断流自动重连）
//
// 电台与频率按 2026 年 9 月现状核实，来源与各地址的验证情况见 research/refs/radio/notes.md。
// 直播流来自第三方聚合平台（蜻蜓 FM、央广云听/卫星直播 CDN 等），地址可能随时变动：
// 每台准备 1–3 个候选，前一个失败（网络错误 / 超时 / 解码失败）自动试下一个。

// 蜻蜓 FM：主 CDN（lhttp.qingting.fm）+ 华为云 CDN（lhttp-hw.qtfm.cn），HTTPS、MP3 64k、带 CORS 头
const qt = (id) => [`https://lhttp.qingting.fm/live/${id}/64k.mp3`, `https://lhttp-hw.qtfm.cn/live/${id}/64k.mp3`];
// 蜻蜓 FM HLS（仅 http、无 CORS 头：只在 http 页面 + 原生 HLS（Safari）下可能可用，作为最后备选）
const qtHls = (id) => `http://ls.qingting.fm/live/${id}.m3u8`;
// 西安广播电视台官方直播（stream3.xiancity.cn，云端探测返回 403，疑似仅限境内/需鉴权，作为最后备选）
const xa = (n) => `http://stream3.xiancity.cn/${n}/sd/live.m3u8`;
// 央广卫星直播 CDN（HTTPS、HLS、CORS *，hls.js 可用）
const cnrSat = (k) => `https://satellitepull.cnr.cn/live/wx${k}/playlist.m3u8`;

/**
 * 电台表。group：分组；freq：主频率（西安地区）；alt：其他频率/中波；src：候选直播地址（按顺序尝试）
 */
export const STATIONS = [
  // —— 陕西广播电视台（陕西广电融媒体集团），2026 年起现存 6 套 ——
  { id: 'sx-news', group: '陕西台', freq: 'FM106.6', alt: 'AM693', name: '陕西新闻广播', src: [...qt(1600), qtHls(1600)] },
  { id: 'sx-traffic', group: '陕西台', freq: 'FM91.6', alt: 'AM1323', name: '陕西交通广播', src: [...qt(1601), qtHls(1601)] },
  { id: 'sx-music', group: '陕西台', freq: 'FM98.8', name: '陕西音乐广播', src: [...qt(4873), qtHls(4873)] },
  { id: 'sx-youth', group: '陕西台', freq: 'FM105.5', name: '陕西青春广播', sub: '好听1055', src: [...qt(4885), qtHls(4885)] },
  { id: 'sx-tangshi', group: '陕西台', freq: 'FM89.6', name: '唐诗电台', sub: '原陕西经济广播', src: [...qt(1603), qtHls(1603)] },
  { id: 'sx-rural', group: '陕西台', freq: 'FM104.9', alt: 'AM900', name: '陕西农村广播', src: [...qt(1602), qtHls(1602)] },
  // —— 西安广播电视台，现存 4 套 ——
  { id: 'xa-news', group: '西安台', freq: 'FM95.0', alt: 'AM810', name: '西安新闻广播', src: [...qt(1610), xa(1)] },
  { id: 'xa-traffic', group: '西安台', freq: 'FM104.3', name: '西安交通旅游广播', src: [...qt(1611), xa(5)] },
  { id: 'xa-music', group: '西安台', freq: 'FM93.1', name: '西安音乐广播', src: [...qt(1612), xa(4)] },
  { id: 'xa-variety', group: '西安台', freq: 'FM102.4', name: '西安综艺广播', unverified: true, src: [xa(3)] },
  // —— 中央人民广播电台（西安本地转播频率） ——
  { id: 'cnr-1', group: '中央台', freq: 'FM96.4', alt: 'AM540', name: '中国之声', src: [cnrSat('zgzs'), 'https://ngcdn001.cnr.cn/live/zgzs/index.m3u8'] },
  { id: 'cnr-2', group: '中央台', freq: 'FM103.0', name: '经济之声', src: [cnrSat('jjzs'), 'https://ngcdn002.cnr.cn/live/jjzs/index.m3u8'] },
  { id: 'cnr-3', group: '中央台', freq: 'FM95.5', name: '音乐之声', src: [cnrSat('yyzs'), 'https://ngcdn001.cnr.cn/live/yyzs/index.m3u8'] },
  // —— 周边城市（西安可收） ——
  { id: 'xy-news', group: '周边', freq: 'FM100.7', name: '咸阳综合广播', src: qt(5022397) },
  { id: 'wn-traffic', group: '周边', freq: 'FM90.9', name: '渭南交通广播', src: qt(5022389) },
  { id: 'wn-news', group: '周边', freq: 'FM102.6', name: '渭南综合广播', src: qt(5022388) },
];

/** 已停播频率（界面脚注说明） */
export const RETIRED = [
  ['FM101.8', '陕西都市广播', '2026-01-01'],
  ['FM107.8', '陕西戏曲广播', '2026-01-01'],
  ['FM106.1', '西安资讯广播', '2026-01-31'],
  ['FM87.8', '陕西故事广播', '2024-12-31'],
  ['FM101.1', '陕西秦腔广播', '2024-12-31'],
];

const isHls = (url) => /\.m3u8(\?|$)/i.test(url);
const CONNECT_TIMEOUT = 18000; // 单个候选源的连接超时（毫秒）
const MAX_RECONNECT = 3; // 播放中断流后的自动重连次数

let hlsModule = null;
async function loadHls() {
  if (!hlsModule) hlsModule = import('hls.js/light').then((m) => m.default || m);
  return hlsModule;
}

/**
 * 广播播放器。状态：idle / loading / playing / paused / error
 * onChange(state) 回调：{ status, station, srcIndex, srcCount, message }
 */
export class RadioPlayer {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.audio = new Audio();
    this.audio.preload = 'none';
    this.station = null;
    this.status = 'idle';
    this.message = '';
    this.srcIndex = -1;
    this.hls = null;
    this._token = 0;
    this._reconnects = 0;
    this._stallT = 0;
    const a = this.audio;
    // 播放中出错 / 长时间卡顿：重连当前台（从当前可用源开始）
    a.addEventListener('error', () => { if (this.status === 'playing') this._onDrop('音频流中断'); });
    a.addEventListener('stalled', () => this._armStall(false)); // 下载暂停：播放可能仍在继续，只挂看门狗
    a.addEventListener('waiting', () => this._armStall(true)); // 播放因缺数据停下：提示缓冲
    a.addEventListener('playing', () => { clearTimeout(this._stallT); if (this.status === 'playing') this._emit('playing', '直播中'); });
    a.addEventListener('ended', () => { if (this.status === 'playing') this._onDrop('直播流结束'); });
  }

  get volume() { return this.audio.volume; }
  set volume(v) { this.audio.volume = Math.min(1, Math.max(0, v)); }
  get muted() { return this.audio.muted; }
  set muted(v) { this.audio.muted = !!v; }

  _emit(status, message = '') {
    this.status = status;
    this.message = message;
    try {
      this.onChange({ status, message, station: this.station, srcIndex: this.srcIndex, srcCount: this.station ? this.station.src.length : 0 });
    } catch (e) {
      console.error('[radio] onChange', e);
    }
  }

  /** 播放某台（同一台再次调用 = 暂停/继续） */
  toggle(station) {
    if (this.station && station && this.station.id === station.id && (this.status === 'playing' || this.status === 'loading')) this.stop(true);
    else this.play(station || this.station);
  }

  /** 用户操作：从第一个候选源开始播放（重置重连计数） */
  play(station) {
    this._reconnects = 0;
    return this._play(station, 0);
  }

  async _play(station, startIndex = 0) {
    if (!station) return;
    const token = ++this._token;
    this.station = station;
    const list = station.src;
    const httpsPage = location.protocol === 'https:';
    // 尝试顺序：从 startIndex 起走完一轮；全部失败（常见于网络瞬断）时稍等，再从头试一轮
    const order = [];
    for (let i = startIndex; i < list.length; i++) order.push([i, 0]);
    for (let i = 0; i < list.length; i++) order.push([i, 1]);
    for (const [i, pass] of order) {
      if (pass && i === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        if (token !== this._token) return;
      }
      const url = list[i];
      this.srcIndex = i;
      if (httpsPage && url.startsWith('http:')) continue; // https 页面会拦截 http 媒体（混合内容），直接跳过
      this._emit('loading', `正在连接 源 ${i + 1}/${list.length}${pass ? '（重试）' : ''}`);
      try {
        await this._tryUrl(url, token);
        if (token !== this._token) return;
        this._emit('playing', '直播中');
        return;
      } catch (e) {
        if (token !== this._token) return; // 已切台/停止
        console.warn(`[radio] ${station.name} 源 ${i + 1} 失败：${url}`, e && e.message);
        if (e && e.fatalAll) {
          this._teardown();
          this._emit('error', e.message);
          return;
        }
      }
    }
    if (token !== this._token) return;
    this._teardown();
    this._emit('error', station.unverified ? '暂无可用直播源（该台地址未核实）' : '全部直播源连接失败（网络受限或源已变更）');
  }

  /** 停止（直播没有“暂停”：停止下载，继续时重新连接到最新直播点） */
  stop(keepStation = true) {
    this._token++;
    clearTimeout(this._stallT);
    this._teardown();
    if (!keepStation) this.station = null;
    this._emit(keepStation && this.station ? 'paused' : 'idle', keepStation ? '已暂停' : '');
  }

  _teardown() {
    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }
    const a = this.audio;
    try { a.pause(); } catch {}
    a.removeAttribute('src');
    try { a.load(); } catch {}
  }

  _armStall(show) {
    if (this.status !== 'playing') return;
    clearTimeout(this._stallT);
    if (show) this._emit('playing', '缓冲中…');
    // 12 秒后仍没有足够数据继续播放（readyState < HAVE_FUTURE_DATA）→ 视为断流重连
    this._stallT = setTimeout(() => { if (this.status === 'playing' && !this.audio.paused && this.audio.readyState < 3) this._onDrop('缓冲超时'); }, 12000);
  }

  _onDrop(reason) {
    clearTimeout(this._stallT);
    if (!this.station) return;
    if (this._reconnects >= MAX_RECONNECT) {
      this._token++;
      this._teardown();
      this._emit('error', `${reason}，重连失败`);
      return;
    }
    this._reconnects++;
    console.warn(`[radio] ${reason}，第 ${this._reconnects} 次重连`);
    // 先重试当前源，不行再往后
    this._play(this.station, Math.max(0, this.srcIndex));
  }

  /** 尝试一个地址：成功（开始出声）resolve，失败/超时 reject */
  async _tryUrl(url, token) {
    this._teardown();
    const a = this.audio;
    if (isHls(url)) {
      const native = !!a.canPlayType('application/vnd.apple.mpegurl');
      if (native) {
        try {
          return await this._attach(() => { a.src = url; }, token);
        } catch (e) {
          if (token !== this._token) throw e;
          this._teardown(); // 原生失败再试 hls.js（部分浏览器宣称支持但实际不行）
        }
      }
      const Hls = await loadHls();
      if (token !== this._token) throw new Error('cancelled');
      if (!Hls || !Hls.isSupported()) throw new Error('浏览器不支持 HLS');
      return this._attach((fail) => {
        const hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 2 });
        this.hls = hls;
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data || !data.fatal) return;
          if (this.status === 'playing' && this.hls === hls) this._onDrop('HLS 流中断');
          else fail(new Error(`HLS ${data.type}/${data.details}`));
        });
        hls.loadSource(url);
        hls.attachMedia(a);
      }, token);
    }
    return this._attach(() => { a.src = url; }, token);
  }

  /** 挂上源并等待真正开始播放（playing 事件），带超时 */
  _attach(setup, token) {
    const a = this.audio;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.removeEventListener('playing', onPlaying);
        a.removeEventListener('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const onPlaying = () => finish();
      const onError = () => finish(new Error('媒体错误 ' + (a.error ? a.error.code : '')));
      const timer = setTimeout(() => finish(new Error('连接超时')), CONNECT_TIMEOUT);
      a.addEventListener('playing', onPlaying);
      a.addEventListener('error', onError);
      try {
        setup((e) => finish(e));
      } catch (e) {
        finish(e);
        return;
      }
      const p = a.play();
      if (p && p.catch) {
        p.catch((e) => {
          // NotAllowedError：浏览器自动播放策略（需要用户手势）——直接报错，不再换源
          if (e && e.name === 'NotAllowedError') finish(Object.assign(new Error('浏览器阻止了自动播放，请再点一次'), { fatalAll: true }));
          else if (e && e.name !== 'AbortError') finish(e);
        });
      }
      if (token !== this._token) finish(new Error('cancelled'));
    });
  }
}
