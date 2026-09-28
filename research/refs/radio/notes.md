# 西安 / 陕西网络广播：频率核实与直播流地址

用于 `src/core/radio.js`（左上角“西安时讯”卡片的“网络广播”页）。整理时间：2026-09-28。

## 一、频率与台名核实

### 陕西广播电视台（陕西广电融媒体集团），现存 6 套

| 频率（西安） | 台名 | 说明 |
|---|---|---|
| FM106.6 / AM693 | 陕西新闻广播 | 前身陕西人民广播电台（1953） |
| FM91.6 / AM1323 | 陕西交通广播 | 用户提到的 91.6 |
| FM98.8 | 陕西音乐广播 | |
| FM105.5 | 陕西青春广播（青少广播 · 好听1055） | 用户提到的 105.5，原“少儿/朝阳广播”，曾用名 Hi Radio / MY FM |
| FM89.6 | 唐诗电台 | 原陕西经济广播 / 汽车调频，2025-03-17 改版为唐诗主题电台 |
| FM104.9 / AM900 | 陕西农村广播 | 部分旧表写 FM88.5，以维基百科与 2018 年频率表 FM104.9 为准 |

已停播：陕西都市广播 FM101.8 / AM1008（“陕广新闻”，2026-01-01 起）、陕西戏曲广播 FM107.8 / AM747（2026-01-01 起）、
陕西故事广播 FM87.8 / AM603（2024-12-31）、陕西秦腔广播 FM101.1（2024-12-31）。

### 西安广播电视台，现存 4 套

| 频率 | 台名 |
|---|---|
| FM95.0 / AM810 | 西安新闻广播 |
| FM104.3 | 西安交通旅游广播 |
| FM93.1 | 西安音乐广播 |
| FM102.4 | 西安综艺广播 |

已停播：西安资讯广播 FM106.1（2026-01-31 24 时起）。

### 中央台在西安的转播频率

| 频率 | 台名 |
|---|---|
| FM96.4（另 AM540） | 中国之声（CNR-1） |
| FM103.0 | 经济之声（CNR-2） |
| FM95.5 | 音乐之声（CNR-3） |

### 周边（西安可收，蜻蜓 FM 有直播）

FM100.7 咸阳综合广播（咸阳人民广播电台）、FM90.9 渭南交通广播、FM102.6 渭南综合广播。

### 频率来源

- 维基百科“陕西广播电视台”：https://zh.wikipedia.org/zh-hans/陕西广播电视台 （现存 6 套 + 停播 4 套，含停播日期）
- 维基百科“西安广播电视台”：https://zh.wikipedia.org/zh-hans/西安广播电视台 （4 套 + 资讯广播停播）
- 2026 年停播频道/频率汇总：https://zuiai.tv/data/TingBo2026.html （陕西都市、戏曲 2026-01-01；西安资讯 2026-01-31）
- 西安地区广播电台频率表（2018-06）：https://www.xfdream.com/37878.html （中国之声 FM96.4、经济之声 FM103.0、音乐之声 FM95.5、农村 FM104.9 等）
- World Radio Map 西安：https://worldradiomap.com/cn/xian
- 唐诗电台改版：https://news.qq.com/rain/a/20250317A019YD00
- 蜻蜓 FM 频道元数据接口（台名/地区/简介，用于对照频道 ID）：https://rapi.qingting.fm/channels/<ID>、
  陕西地区频道列表 https://rapi.qingting.fm/categories/316/channels?with_total=true&page=1&pagesize=100

## 二、直播流地址（代码中的候选顺序）

地址模板：
- 蜻蜓 FM 主 CDN：`https://lhttp.qingting.fm/live/<ID>/64k.mp3`（MP3 64k，`Access-Control-Allow-Origin: *`）
- 蜻蜓 FM 华为云 CDN：`https://lhttp-hw.qtfm.cn/live/<ID>/64k.mp3`（同上，另一条 CDN，作为第 2 候选）
- 蜻蜓 FM HLS：`http://ls.qingting.fm/live/<ID>.m3u8`（仅 http、无 CORS 头 → 只在 http 页面 + 原生 HLS（Safari）可能可用）
- 西安台官方：`http://stream3.xiancity.cn/<n>/sd/live.m3u8`（1 新闻、2 资讯（已停播）、4 音乐、5 交通；3 = 综艺为按编号规律推测）
- 央广卫星直播 CDN：`https://satellitepull.cnr.cn/live/wx<key>/playlist.m3u8`（HLS/AAC，`CORS *`，会 302 式跳到带会话参数的 100ycdn 子播放列表）
- 央广 ngcdn：`https://ngcdn00x.cnr.cn/live/<key>/index.m3u8`（CORS 只允许 cctv 域名 → hls.js 不可用，仅原生 HLS 可播）

| 台 | 蜻蜓 ID | 候选（按顺序） |
|---|---|---|
| 陕西新闻广播 FM106.6 | 1600 | 蜻蜓主 / 蜻蜓华为云 / 蜻蜓 HLS |
| 陕西交通广播 FM91.6 | 1601 | 同上 |
| 陕西音乐广播 FM98.8 | 4873 | 同上 |
| 陕西青春广播 FM105.5 | 4885 | 同上 |
| 唐诗电台 FM89.6 | 1603 | 同上（蜻蜓台名已是“唐诗电台”，简介仍为“896汽车调频”） |
| 陕西农村广播 FM104.9 | 1602 | 同上 |
| 西安新闻广播 FM95.0 | 1610 | 蜻蜓主 / 蜻蜓华为云 / xiancity 1 |
| 西安交通旅游广播 FM104.3 | 1611 | 蜻蜓主 / 蜻蜓华为云 / xiancity 5 |
| 西安音乐广播 FM93.1 | 1612 | 蜻蜓主 / 蜻蜓华为云 / xiancity 4 |
| 西安综艺广播 FM102.4 | 无 | xiancity 3（推测，未核实；界面标“未核实”） |
| 中国之声 FM96.4 | — | satellitepull wxzgzs / ngcdn001 zgzs |
| 经济之声 FM103.0 | — | satellitepull wxjjzs / ngcdn002 jjzs |
| 音乐之声 FM95.5 | — | satellitepull wxyyzs / ngcdn001 yyzs |
| 咸阳综合广播 FM100.7 | 5022397 | 蜻蜓主 / 蜻蜓华为云 |
| 渭南交通广播 FM90.9 | 5022389 | 同上 |
| 渭南综合广播 FM102.6 | 5022388 | 同上 |

地址来源：
- 社区整理的电台 m3u 列表：https://github.com/reysc/M3U8/blob/master/radio.m3u （ls.qingting.fm、radio.sxtvs.com、stream3.xiancity.cn、ngcdn.cnr.cn 等）
- 网络电台源：https://blog.vvvtimes.com/index.php/2022/10/13/radio-source/ （lhttp.qtfm.cn 模板、央广 ngcdn）
- radio-browser 社区库：https://de1.api.radio-browser.info/json/stations/search?name=陕西 （lhttp-hw.qtfm.cn、satellitepull.cnr.cn）
- 蜻蜓 FM 电台页：https://www.qingting.fm/radios/1601/ 等

未采用（记录备查）：
- `http://radio.sxtvs.com/radio/{news,traffic,music,kids}.mp3`（陕西台旧官方流）：云端连接失败，疑已下线。
- `live.xmcdn.com` / `live.ximalaya.com`（喜马拉雅）：返回 403 或时好时坏，且无 CORS 头。
- `https://lhttp.qtfm.cn/live/15318317/64k.mp3`：radio-browser 标为“中国之声”，实测该蜻蜓 ID 现为“河北邯郸 欢乐调频”，不能用。
- 蜻蜓 1606（戏曲）、1609（都市）：404，与停播一致。

## 三、验证情况（2026-09-28，云端环境）

说明：云端出口在境外、经代理，结果不代表国内网络；浏览器实测用的是 Playwright 自带的开源 Chromium（只有 MP3 解码器，没有 AAC）。

1. **HTTP 层（curl，取 4–15 秒数据）**
   - 蜻蜓主 CDN / 华为云 CDN：上表 12 个蜻蜓频道全部 `200 audio/mpeg` 持续出数据，带 `Access-Control-Allow-Origin: *`。
   - `http://ls.qingting.fm/live/1601.m3u8`：可取到播放列表（AAC 分片，协议相对地址），但无 CORS 头。
   - 央广 `satellitepull.cnr.cn`（zgzs/jjzs/yyzs）：master → 子播放列表 → `.ts` 分片全部 200，均带 `CORS *`。
   - 央广 `ngcdn001/002`：200，但 `Access-Control-Allow-Origin` 固定为 cctv 域名；`ngcdn003 yyzs`、`ngcdn004`：403。
   - `stream3.xiancity.cn`：403（字节跳动 CDN，疑似限境内或需鉴权），**未能验证**。
2. **浏览器内播放（Playwright Chromium 141 + 代理，调用卡片的 RadioPlayer；开始播放且 2.5 秒内 `audio.currentTime` 前进约 2.5 秒才算成功）**

   | 台 | 结果 | 实际用到的源 | 起播耗时 |
   |---|---|---|---|
   | 陕西新闻广播 | 播放成功 | 源 1 蜻蜓主 CDN | 15.8 s |
   | 陕西交通广播 | 播放成功 | 源 1 | 9.4 s |
   | 陕西音乐广播 | 播放成功（另一轮 3 源全失败，网络瞬断） | 源 2 蜻蜓华为云（源 1 报媒体错误 4） | 35.7 s |
   | 陕西青春广播 | 播放成功 | 源 1 | 9.1 s |
   | 唐诗电台 | 播放成功 | 源 1 | 9.4 s |
   | 陕西农村广播 | 播放成功 | 源 1 | 9.1 s |
   | 西安新闻广播 | 播放成功 | 源 1 | 7.6 s |
   | 西安交通旅游广播 | 播放成功 | 源 1 | 8.2 s |
   | 西安音乐广播 | 播放成功 | 源 2 蜻蜓华为云（源 1 报媒体错误 4） | 20.1 s |
   | 咸阳综合广播 | 播放成功 | 源 2 蜻蜓华为云 | 23.3 s |
   | 渭南交通广播 | 播放成功 | 源 1 | 10.7 s |
   | 渭南综合广播 | 播放成功 | 源 1 | 12.6 s |
   | 西安综艺广播 | 失败（预期） | 唯一候选为推测地址：无 CORS 头 + 403 | — |
   | 中国之声 / 经济之声 / 音乐之声 | 未能验证 | 测试浏览器无 AAC 解码器（`MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"') = false`） | — |

   起播耗时偏长是因为测试机负载极高（load average ~90，4 核）；“媒体错误 4”与同时段代理隧道断开记录吻合，
   curl 复查同一地址为 200。正式版 Chrome / Edge / Safari 均带 AAC 解码器，央广三套在它们上面应可用 hls.js（或 Safari 原生 HLS）播放，但未实测。
3. **未在国内网络实测**：所有地址在国内网络、各浏览器（尤其 Safari 原生 HLS、移动端）上的表现都没有实测；
   https 部署时 http 候选会被跳过（混合内容）。
