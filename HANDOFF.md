# 西安 3D 城市模型 —— 交接文档

> 最后更新：2026-09-27。本文件写给第一次接手的工程师 / 云端 Claude 会话。先读完本文件，再读 `docs/CONTRACT.md`（坐标与数据格式契约）、`docs/MODULE_GUIDE.md`（模块开发规范）、`docs/ARCH_KIT.md`（中式古建构件库 API）。

## 1. 项目目标

用 Three.js 从零构建**高精度、真实风格、可交互**的西安三维模型，直接在浏览器运行。必须包含：

- 明城墙与 18 座城门（四大城门含闸楼/箭楼/城楼/瓮城）、钟楼、鼓楼、大雁塔与大慈恩寺、大唐不夜城、曲江（大唐芙蓉园、曲江池）、高新区、未央国际商圈、咸阳国际机场及其它机场（阎良、西关旧址）
- 主要道路与交通流（车流、高铁、地铁）、真实地形高差与渭河
- PBR 材质、日夜切换、动态灯光（夜景泛光、亮窗、路灯、LED）
- WASD + 鼠标自由漫游、数字键预设视角
- 细节达到“看得清窗户与招牌”的级别，同时保持流畅

## 2. 如何运行

需要 Node.js 20.19+ / 22.12+（本机为 Node 26）。

```bash
npm install
npm run dev              # 开发服务器 http://localhost:5173
npm run build            # 生产构建 → dist/
npm run preview          # 预览 dist/（端口 4173）
npm run build:standalone # 单文件离线版 → dist-standalone/西安3D-离线单文件版.html（可直接双击 file:// 打开）
```

- 入口：`index.html` → `src/main.js`
- 双击启动脚本：`启动-macOS.command`、`启动-Windows.bat`（没有 dist 时会先构建，再起静态服务器）
- 常用 URL 参数（调试/截图）：`?online=0`（只用内置离线底图，**网络差时必用**）、`view=1..0 / !1..!5`（预设视角）、`time=20.5`（时刻）、`q=0..3`（画质）、`modules=a,b`（只加载指定模块）、`skip=a,b`、`ll=lon,lat,离地高,目标lon,目标lat,目标离地高`、`ui=0`、`labels=0`、`imagery=esri|amap`
- 操作：单击锁定鼠标，WASD 移动，Q/E 升降，Shift 加速，滚轮调速，1~0 预设视角，Shift+1~5 扩展视角，N 日夜，T 时间流逝，G 步行，O 环绕，L 标注，M 小地图，H 帮助，K 截图

### 自动化工具

- `node tools/shot.mjs --shot "online=0&view=2&time=15|shots/x.png" [--w 1280 --h 720]`：自动起 Vite + 无头 Chromium（Metal GPU）截图，打印 fps / draw calls / 三角形 / 控制台错误。**所有视觉改动都用它自测**。
- `node tools/perf.mjs [--q 2] [--night]`：逐个预设视角测帧率。
- `tools/workflows/modules_r*.js`：此前用于并行派发 15 个建模代理的工作流脚本（含每个模块的详细需求说明，可作为需求文档参考）。

## 3. 目录结构

```
index.html / vite.config.js / package.json
src/
  main.js              启动：渲染器（反向深度或对数深度）、数据加载、模块 prepare→build、主循环、键盘与 UI 事件
  style.css            界面样式
  core/                核心引擎（所有模块共用）
    geo.js             投影（见第 4 节）；gcj.js WGS-84→GCJ-02 换算
    config.js          画质档位、在线影像源（高德/Esri）、预设视角
    data.js            数据加载（支持单文件版内嵌 base64）
    terrain.js         DEM 解码、heightAt、平整区 addFlatten、四叉树 LOD 地形瓦片 + 影像贴图
    imagery.js         影像：内置离线底图 img_*.jpg + 在线瓦片流式（LRU、优先级、重试、高德 GCJ 纠偏拼接）
    sky.js             Preetham 大气 + 云 + 夜空星月、太阳/月光、阴影相机跟随、环境贴图、曝光
    fog.js             高度雾（替换 three 的 FogExp2 片段）
    post.js            后期：HDR+MSAA → 泛光 → 色调映射 → FXAA
    controls.js        飞行/步行/环绕控制、预设视角平滑飞行
    lightpool.js       动态点光源池（只点亮离相机最近的 N 盏）
    materials.js       共享 PBR 材质库 + 夜间发光管理；textures.js Canvas 程序化纹理与中文文字贴图
    labels.js          浮动地名标注（屏幕碰撞避让）；exclusions.js 排除区（地标处让通用建筑/树让位）
    roadheight.js      道路/桥梁统一高程规则（道路与车流共用）；util.js 合批、UV、折线等工具
    context.js         模块上下文 ctx；ui.js 界面
  modules/             场景模块（每个一个文件，互不修改；注册表 index.js）
    water / landuse / roads / citywall / belltower / pagoda / datang / qujiang / heritage /
    skyline / airports / buildings / vegetation / signage / traffic ；dev/archtest.js 构件测试场
  arch/                模块私有的大型实现文件
    chinese*.js        中式古建构件库（屋顶举折起翘、斗拱、柱网、门窗、台基栏杆、城台城楼、箭楼、亭、牌坊、檐口灯带）
    bld-*.js           通用建筑（Worker 生成几何 + 立面窗户着色器 + 夜间亮窗）
    sky-*.js           现代地标高楼；roads_*.js 道路/路灯；traffic_*.js 车流模型与路网；veg*.js 植被
    airport-*.js、citywall-kit.js、belltower-parts.js、pagoda-*.js、datang-props.js、qujiang-gen.js、heritage-parts.js、water-*.js、signage*.js
    traditional.js / shared.js   早期外部代理的粗糙版本（已基本不用，可清理）
public/data/           浏览器运行数据（全部由 tools/ 脚本生成，见第 5 节）
tools/                 数据管线（Python，用 .venv-tools 虚拟环境）与截图/构建工具（Node）
research/              调研参考图（refs/）与矢量核对图（vector_check/）
docs/                  CONTRACT.md（坐标/数据格式）、MODULE_GUIDE.md（模块规范）、ARCH_KIT.md（构件库 API）
data-src/              原始数据缓存（**未入库**，约 800 MB，需用脚本重新下载）
```

## 4. 坐标系与投影

- 原点：钟楼中心 **LAT0 = 34.2610119, LON0 = 108.9423419**（OSM way 254488435 质心）。
- 投影：Web Mercator（EPSG:3857）米坐标 × `K = cos(LAT0) ≈ 0.82648`，缩放成当地真实米。
  - `worldX = (mercX(lon) − mercX(LON0)) × K`（东为 +X）
  - `worldZ = −(mercY(lat) − mercY(LAT0)) × K`（**北为 −Z**）
  - `worldY = 绝对海拔（米）`
- 好处：卫星瓦片在世界坐标中是严格轴对齐矩形，全部数据共用一个函数，对齐零误差。JS 实现 `src/core/geo.js`，Python 实现 `tools/geo.py`，两者必须保持一致。
- 所有矢量数据在离线管线中就投影成世界坐标（保留 1 位小数），浏览器端不再做经纬度换算。
- **GCJ-02**：工程内部全部是 WGS-84。只有高德在线影像是 GCJ-02（西安一带偏移约东 430 m、南 180 m），`src/core/imagery.js::_composeGcj` 在加载时按瓦片中心的偏移把 2×2 张高德瓦片拼接裁剪回 WGS-84 网格（`src/core/gcj.js` 为标准 WGS→GCJ 公式）。CMAB 建筑数据在管线中已核对为 WGS-84。

## 5. 数据来源与生成

| 数据 | 来源 | 产物 | 脚本 |
|---|---|---|---|
| 地形 DEM | **FABDEM v1-2**（去建筑/森林的 30 m 地面高程，CC BY-NC-SA 4.0）+ AWS Terrarium 补外区；平原区形态学开运算；大水面平整 | `public/data/dem_main.png`（MAIN 区 2048²）、`dem_outer.png`（OUTER 区 1024²），Terrarium RGB 编码 | `tools/build_dem.py` |
| 卫星影像（离线底图） | Esri World Imagery 瓦片拼接（z11~z17） | `img_outer/main/core/wall/qujiang/xiy.jpg` + `meta.json` 的 imagery 数组 | `tools/build_imagery.py`（瓦片缓存 `data-src/tiles/`） |
| 卫星影像（在线） | **当前默认高德卫星在线流式**（GCJ 纠偏），可切 Esri（面板“影像源”或 `?imagery=esri`） | 运行时 | `src/core/imagery.js` |
| 建筑 | **CMAB**（China Multi-Attribute Building dataset，Zhang et al. 2025，2022 年影像提取，屋顶轮廓+高度+层数+功能+年代）为主，经 OSM 实测高度标定；CMAB 覆盖区外用 OSM；地标高楼用调研值 | `buildings.bin`（v2，23.3 万栋，13 MB，格式见 CONTRACT 3.4）、`buildings_names.json` | `tools/heights_prepare.py` → `tools/build_buildings_v2.py`，校验 `tools/verify_buildings.py` |
| 道路/铁路/水系/用地/POI/机场 | OpenStreetMap（Geofabrik 陕西 PBF 本地提取 + Overpass 补抓） | `roads.json`、`rail.json`、`water.json`、`landuse.json`、`pois.json`（带重要度 i）、`aeroway.json` | `tools/fetch_geofabrik.py`、`tools/fetch_osm.py` → `tools/build_data.py` |
| 城墙几何 | OSM 护城河/顺城巷推算 + 卫星核对：中心线（周长 13749 m）、18 座城门、91 个马面 | `data-src/landmarks_historic/*.json` → `public/data/landmarks.json` | `tools/landmarks_*.py` |
| 现代高楼 | OSM 高楼轮廓 + 网络调研 | `skyline.json` | `tools/fetch_modern_landmarks_osm.py`、`build_data.py` |

注意：`tools/build_data.py` 重跑时会覆盖 `meta.json` 的 imagery 数组，重跑后需再执行 `python tools/build_imagery.py --meta-only`。Python 依赖见 `requirements-data.txt`（虚拟环境 `.venv-tools`，未入库）。

## 6. 已完成的功能

- 核心：四叉树 LOD 地形 + 卫星影像（离线底图 + 在线流式、断线重试、自动降级）、反向深度缓冲（不支持时退回对数深度）、高度雾、Preetham 天空+云+星空月亮、太阳轨迹（按北京时间与日期）、日夜平滑切换、阴影相机跟随与像素对齐、IBL 环境贴图、泛光后期、动态点光源池、画质四档（低/中/高/超高）
- 交互：飞行/步行/环绕三种模式、10 个预设视角 + 5 个扩展视角（平滑飞行）、时间滑块与流逝、图层开关、小地图、帮助页、截图
- 场景模块（均已重写为高精度版本，截图自测 0 报错）：
  - 城墙（中心线/垛口/马面/四大城门群/角楼/护城河/夜景轮廓灯）、钟楼与鼓楼、大雁塔与大慈恩寺（含北广场音乐喷泉）、大唐不夜城（仿唐街区、灯柱、人流、金色夜景——效果最好的一处）、曲江（芙蓉园/曲江池）、历史地标（小雁塔、丹凤门、陕历博等）
  - 现代地标高楼（22 座精建 + 56 座通用高楼）、通用建筑 23.3 万栋（立面窗户着色器、夜间随机亮窗、屋顶构件）、道路（路面标线、桥梁高架、路灯与光斑、铁路）、交通流（GPU 实例化车流、车灯、高铁/地铁）、机场（咸阳航站楼、跑道标线与灯光、起降动画、阎良机场）、水系（程序化水面、渭河含沙色）、植被（约 65 万棵分种类行道树/公园树）、街道招牌（POI 招牌图集流式加载）
- 发布：生产构建、单文件离线版（已验证 file:// 双击 4 秒进入）、双击启动脚本
- 性能（M4 Max、1280×720、“高”画质）：各预设视角 60 fps，200~1300 draw calls，6~19M 三角形

## 7. 已知问题与用户最新反馈（原样）

用户反馈（最高优先级在前）：

- 高德在线流式卫星影像带宽占用太高，要换成高质量、完整的离线卫星图，最好比高德更清晰
- 建筑和道路很多地方数据过时，最高优先级
- 缺少曲江W酒店、万众国际；曲江周边道路太抽象、太旧
- 浐灞需要精细化：浐灞桥、后海、浐灞艾美酒店、凯悦酒店、欧亚国际
- 回民街、洒金桥
- 凤城七路需要刻画得更好
- 未央国际商圈失真，熙地港和大融城最严重

开发侧已知问题：

1. **永宁门夜景整屏全黑**（`?online=0&view=5&time=20.8`，1280×720 稳定复现；白天正常）。多半是某模块夜间材质产生 NaN/Inf，经泛光模糊扩散成全屏黑。二分结果：跳过 water/landuse/roads/citywall/belltower/pagoda/datang 这一组后恢复正常，问题在这 7 个模块之一（单独只加载 citywall 时不复现，说明可能是组合或分辨率相关）。建议：继续二分；并在 `src/core/post.js` 的泛光前加一道 NaN 钳制（`if (any(isnan(c))) c = vec3(0)`）兜底。
2. 白天远景地平线偏白、整体略灰（大气/雾/曝光可再调，参数在 `src/core/sky.js` 与 `fog.js`）。
3. 离线底图来自 Esri，是冬季带积雪的旧影像，地面有白色雪斑。
4. CMAB 对超高层仍有低估（高新 CBD ≥100 m 的楼偏少），重点高楼需要手工校正。
5. 三角形数偏高（最高 19M），弱机需要降档；可做更激进的建筑/树木 LOD。
6. `src/arch/traditional.js`、`shared.js` 为旧版遗留，确认无引用后可删除。

## 8. 未完成的工作与下一步计划

**正在做到一半：**
- 影像源切换：已实现高德在线流式 + GCJ 纠偏（`imagery.js`、`gcj.js`、`config.js` 的 `IMAGERY_PROVIDERS`，面板“影像源”下拉），默认 `amap`。但用户已明确要改为**离线高清完整影像**，所以这只是过渡方案。
- 更清晰影像源探测：在钟楼处测试了各家最高层级——Google 卫星 z19/z20、Esri z19、Bing z19 均可取到；高德 z20 在钟楼处可取到（z18/z19 因飞机网络超时，未测完）。尚未系统对比清晰度与拍摄年份。

**下一步（建议顺序）：**
1. **离线高清影像金字塔**：选定最清晰、最新的源（按区域比较 Google/高德/Esri/Bing 的清晰度与年份），预下载瓦片做成本地金字塔：全区 z13~z15、城区 z16~z17、重点片区（城墙内、曲江、高新、未央、浐灞、机场）z18~z19；GCJ 源在管线中纠偏。存储建议打包成少量大文件（如 PMTiles 或按 z/x 分块的 tar）+ HTTP Range 读取，避免成千上万个小文件；前端 `imagery.js` 改为优先读本地金字塔。注意各图源的使用条款，仅限个人本地使用，不要公开发布。
2. **建筑与道路更新（最高优先级）**：对用户点名的片区逐一核对并补建——曲江 W 酒店、万众国际、曲江周边道路；浐灞（浐灞桥、后海、艾美酒店、凯悦酒店、欧亚国际）；回民街、洒金桥（老街巷尺度、仿古商铺）；凤城七路沿线；未央国际商圈的熙地港、大融城（最失真）。做法：调研真实轮廓/高度/立面照片，在 `skyline.js`（或新建片区模块）里手工精建，并在 prepare 中用 exclusions 替换掉失真的通用建筑；道路用更新的数据源或手工修正几何。可选：若用户提供高德 Web 服务 Key，可用官方 POI 接口更新招牌与地名（不要批量抓取其矢量瓦片，违反服务条款）。
3. 修复永宁门夜景黑屏（见第 7 节第 1 条）。
4. 视觉打磨：天空/雾/曝光、雪斑问题（换影像后自然解决）、夜景层次。
5. 性能：更激进的 LOD、按画质缩减植被与建筑三角形；用 `tools/perf.mjs` 验证。
6. 发布：更新 README、重新生成单文件离线版。

## 9. 协作注意

- 每个模块只改自己的文件；需要核心改动时统一改 `src/core/*`。
- 模块自测必须用 `tools/shot.mjs` 截图并目视检查，控制台 0 报错。
- 网络差时一律 `online=0`。
- 回复与文档一律使用简体中文。
