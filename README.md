# 西安 3D 城市漫游

这是一个用 Three.js 从零搭建的西安三维可交互场景，包含真实地形、渭河与城市水系、道路交通、机场设施、城墙与城门、钟楼、大雁塔、大唐不夜城、曲江、高新、未央等片区。城墙、历史建筑和商业街景由项目内的几何与程序化 PBR 材质构成；普通建筑轮廓、高层轮廓、机场、道路与兴趣点由本项目的数据管线从 OpenStreetMap 等开放地理数据生成。

## 运行

需要 Node.js 20.19+ 或 22.12+。在项目目录执行：

```bash
npm install
npm run dev
```

浏览器打开终端显示的地址（默认 `http://localhost:5173`）。这是 Vite 项目，需要通过本地 HTTP 服务访问，不能直接双击 `index.html` 使用 `file://` 打开。

生产构建与本地预览：

```bash
npm run build
npm run preview
```

## 操作

- 单击场景锁定鼠标，移动鼠标转向；按 `Esc` 释放。未锁定时按住鼠标左键也可拖动转向。
- `W A S D` 或方向键移动；`E` / 空格上升，`Q` / `C` 下降；`Shift` 加速，`Alt` 慢速；滚轮调整移动速度。
- `G` 切换飞行与贴地步行；`O` 开关环绕展示。
- 数字 `1` 至 `0` 切换全城俯视、钟楼、大雁塔、大唐不夜城夜景、永宁门、曲江、高新、未央国际商圈、咸阳机场和渭河视角。
- `Shift` + `1` 至 `5` 切换秦岭远眺、阎良机场、北门城墙、小雁塔和陕西电视塔视角。
- `N` 或右侧面板切换日夜；时间滑块与播放按钮控制太阳、环境光和夜间灯光。
- `H` 显示操作帮助；右侧面板可调画质与在线卫星影像、交通、标注和建筑图层。

建议较旧设备从“低”或“中”画质开始。在线卫星影像需要联网；关闭该图层或断网时，场景继续使用地形、建筑和机场内置影像数据。

## 离线高清卫星影像（推荐）

在线流式影像很费带宽。可以在本机一次性下载高清瓦片，打包成少量大文件（`tiles/*.xtp`，前端用 HTTP Range 按需读取）：

```bash
python tools/imagery_pack.py plan                                   # 估算：默认方案约 7 万张 / 1.7 GB（lite 方案约 0.6 GB）
python tools/imagery_pack.py compare --lon 108.9423 --lat 34.2610 --z 19   # 对比 Google/Esri/Bing/高德同一位置的清晰度
python tools/imagery_pack.py all --source google,esri               # 下载（断点续传）+ 打包；前者缺图时用后者补
```

- 覆盖：全域 z11–15、城区 z16–17、城墙内/曲江/小寨/高新/未央/浐灞 z18–19、奥体北站/咸阳机场 z18（片区在脚本 `PLANS` 里改）。
- 高德（`--source amap`）是 GCJ-02 坐标，脚本会逐瓦片纠偏回 WGS-84 后再打包。
- 打包结果在仓库根目录 `tiles/`（不进 `dist/`，已加入 `.gitignore`）。`npm run dev` / `npm run preview` / 双击启动脚本都会把它挂到 `/tiles/`，页面自动启用“本地离线高清”影像源（`?pack=0` 可关闭）。
- 注意：Python 自带的 `http.server` 不支持 Range，请用 `node tools/serve.mjs` 或 `python3 tools/serve.py`。
- 各图源都有使用条款，打包结果仅供个人本地使用，不要公开发布。

## 数据生成

仓库内的 `data-src/` 是下载的源数据缓存，`public/data/` 是浏览器读取的生成结果。可在联网环境中重新抓取或重建：

```bash
python3 -m venv .venv-tools
. .venv-tools/bin/activate
python -m pip install -r requirements-data.txt
python tools/fetch_geofabrik.py
python tools/build_data.py
python tools/build_dem.py --source auto
npm run dev
```

`fetch_geofabrik.py` 下载陕西省 OpenStreetMap PBF 区域包并本地筛出西安场景所需的矢量数据，不依赖 Overpass 服务。若需要刷新成每日最新数据，可另外运行 `python tools/fetch_osm.py`；它会按区域切块、缓存，并在超时后细分请求。本项目自带的窄范围研究缓存也会补齐城墙、机场、渭河、高层与主干路数据。`build_dem.py` 优先使用 FABDEM v1-2 的约 30 米地面高程数据，并复用本地生成的水面矢量做河湖平整；输出与 Web Mercator 对齐的 Terrarium 编码地形。`--source terrarium` 可在 FABDEM 不可用时只用公开高程瓦片。DEM 主区和外区分别输出为 `public/data/dem_main.png` 与 `dem_outer.png`。

增量更新（不需要重跑整条管线）：

```bash
python tools/fetch_overture.py --theme transportation --type segment --bbox 108.60,33.95,109.40,34.72
python tools/fetch_overture.py --theme buildings --type building --bbox 108.80,34.15,109.12,34.42
python tools/roads_update.py      # 用 Overture（每月发布，源自最新 OSM）增量更新 roads.json，保留原车道/宽度属性
python tools/build_huimin.py      # 回民街·洒金桥逐户建筑 → public/data/huimin.json（并修正主街路宽）
python tools/extract_fp2.py       # 2026-09 地标轮廓 → src/arch/sky-footprints2.js
```

生成过程会把建筑高度、道路宽度、水体和机场边界等矢量要素转换成统一的本地米制坐标。源数据缺失时相应图层可降级，场景仍会启动；构建后可在 `public/data/` 检查生成的数据文件与来源元数据。

## 数据来源与署名

- OpenStreetMap：道路、建筑、用地、兴趣点、机场与水系。遵守 ODbL，并在公开展示中注明 [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright)。
- Geofabrik：陕西省 OpenStreetMap 区域数据下载与提取服务；数据仍署名 OpenStreetMap contributors。
- FABDEM v1-2：去除建筑与森林影响的地形高程，来源 University of Bristol，许可为 CC BY-NC-SA 4.0；其基础数据衍生自 Copernicus DEM。具体署名记录在生成的 `meta.json` 中。
- Overture Maps Foundation（2026-09-23 版，AWS 公共桶）：交通网与建筑轮廓，底层为 OpenStreetMap（ODbL）。
- 在线卫星底图：Esri World Imagery，影像归属 Esri、Maxar、Earthstar Geographics 与 GIS User Community；按 [Esri 的底图署名说明](https://support.esri.com/en-us/knowledge-base/what-is-the-correct-way-to-cite-an-arcgis-online-basema-000012040)保留署名。

FABDEM 的非商业与相同方式共享条款适用于该高程数据及其衍生品。在线底图的可用性由 Esri 服务决定；项目不会在运行时下载或储存整座城市的在线瓦片。
