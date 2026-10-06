# 西安 3D 城市模型 —— 交接文档

> 最后更新：2026-09-27（云端会话，见第 10 节）。本文件写给第一次接手的工程师 / 云端 Claude 会话。先读完本文件，再读 `docs/CONTRACT.md`（坐标与数据格式契约）、`docs/MODULE_GUIDE.md`（模块开发规范）、`docs/ARCH_KIT.md`（中式古建构件库 API）。

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

- `node tools/shot.mjs --shot "online=0&view=2&time=15|shots/x.png" [--w 1280 --h 720]`：自动起 Vite + 无头 Chromium（macOS 用 Metal GPU；Linux/云端无 GPU 时自动用 SwiftShader 软件渲染，约 2 分钟/张）截图，打印 fps / draw calls / 三角形 / 控制台错误。**所有视觉改动都用它自测**。任意视角推荐 `cam=x,离地高,z,tx,目标离地高,tz`（世界坐标）。
- `node tools/diag_nan.mjs "online=0&view=5&time=20.8"`：遍历场景网格，列出含 NaN 坐标 / 零长度法线的几何体及其所属模块（排查夜景黑屏）。
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

1. ~~永宁门夜景整屏全黑~~（2026-09-27 已修，待在 Mac/Metal 上复核）：`post.js` 在 RenderPass 后加了位运算 NaN/Inf 钳制（Metal fast-math 下 `isnan` 会被优化掉，所以用 `floatBitsToUint` 判断指数位）；`main.js` 构建后统一把零长度法线改为朝上（skyline 有 1692 个，Metal 上 `normalize(0)` = NaN）；古建泛光（chinese-core）、不夜城光柱、大雁塔喷泉的 normalize/pow 做了防护。云端 SwiftShader 无法复现原问题，只能确认修复后画面正常。
2. 白天远景地平线偏白、整体略灰（大气/雾/曝光可再调，参数在 `src/core/sky.js` 与 `fog.js`）。
3. 内置离线底图（img_*.jpg）来自 Esri，是冬季带积雪的旧影像，地面有白色雪斑。→ 用 `tools/imagery_pack.py` 生成本地高清影像包后自然解决（见 README“离线高清卫星影像”）。
4. CMAB 对超高层仍有低估（高新 CBD ≥100 m 的楼偏少），重点高楼需要手工校正。
5. ~~三角形数偏高（最高 19M）~~（2026-10-06 已做一轮：道路结构分块/阴影按距离、植被远景分格剔除、建筑远景阴影段与精简子集、
   不夜城/遗迹/回民街/城墙按距离隐藏与关阴影等，高画质各视角 2~8M（含曲江的视角 12~15M，其中曲江模块 5~6M 未动）；
   各模块占比与前后对比见 `docs/PERF_TRIANGLES.md`，归属统计工具 `tools/perf_tris.mjs`）。
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

## 10. 2026-09-27 云端会话更新（分支 `claude/data-refresh`）

云端环境只能访问 npm/PyPI 和 AWS S3（Overpass、Geofabrik、各家影像瓦片都被网络策略拦截），因此：道路/建筑用 **Overture Maps**（S3 公共桶，每月发布，底层是最新 OSM）更新；影像瓦片下载脚本写好了但必须在本机运行。

**已完成**
- 夜景黑屏修复（第 7 节第 1 条）。
- **离线高清影像包**：`tools/imagery_pack.py`（Google/Esri/Bing/高德，多源回退、断点续传、高德 GCJ 逐瓦片纠偏、`compare` 出清晰度对比图）→ 仓库根 `tiles/*.xtp`（自定义格式：头 + 排序索引 + JPEG，见 `src/core/tilepack.js` 注释）。前端 `TilePack` 用 HTTP Range 读取，存在即默认启用（`?pack=0` 关）。`vite.config.js`、`tools/serve.mjs`、`tools/serve.py`、启动脚本都支持 Range 并挂载 `/tiles/`。已用本地底图切出的测试瓦片验证整条链路（对齐误差 0）。
- **道路**：`tools/roads_update.py` 用 Overture 2026-09 增量更新 `roads.json`（新增 384 段 129 km、删除 22 段 13 km，保留原车道/宽度；步行街与城墙内路段受保护）。原始文件备份在 `data-src/roads.before_overture.json`（未入库）。
- **回民街·洒金桥**（新模块 `huimin`）：`tools/build_huimin.py` 用 OSM 逐户轮廓（7515 栋）替换 CMAB 粗块，层数按调研修正，临街面识别、59 个真实店名；`src/arch/huimin-gen.js` 程序化立面/硬山坡顶/寺院庑殿顶/披檐/招牌图集/红灯笼；北院门北口石牌楼；主街路宽修正。`exclusions` 新增 `maxHeight`（只让低层通用建筑让位）。
- **地标精建**（`src/arch/sky-data2.js`、`sky-special2.js`、`sky-footprints2.js`，接入 skyline 模块，旧的熙地港/大融城/未央国际定义被取代）：
  - 未央：熙地港（OSM 真实轮廓 195×171 m、34 m）、大融城（137×244 m、西北弧面）、未央国际（99.6 m 三角塔 + We Young 168 退台）、经开洲际、EHB 160 m、旭辉中心 A/B、智选假日、未央国际中心。
  - 曲江：万众国际（WFive Park C 形裙房）+ W 酒店与 A/B 写字楼三座“下大上小斜顶”塔。
  - 浐灞：艾美 147 m + 裙房、锦江国际（原凯宾斯基，三翼 + 穹顶）、欧亚国际 ICC、凯悦“叠石”塔、灞河 2 号桥（彩虹桥：倾斜椭圆拱塔 + 82 根夜间彩虹斜拉索）、浐灞 1 号桥（蝴蝶桥）、后海东岸夜市灯串。
- 调研笔记：`research/refs/{weiyang,qujiang,chanba,huimin}/notes*.md`（含坐标、尺寸、高度、来源 URL；多为搜索摘要，标注了【推测】项）。

**尝试后放弃**
- 用 Overture 里的“东亚建筑数据集”（zenodo 8174931）补全 CMAB 缺失建筑：核查发现它在凯悦（2025 开业）原址只有施工工棚，比 CMAB 更旧，补全会引入过时信息，已撤销。

- 用户追加要求（最清晰最新的免费影像、用高德数据替代陈旧的 OSM）：
  - `imagery_pack.py` 新增源 `esri_clarity`、`wayback`（Esri 历史期）、`tianditu`（天地图，需服务器端 Key）、`tencent`（GCJ 纠偏）、`jl1`（吉林一号共生地球，需 mk/tk）、`custom`（任意 XYZ 模板）；`--pick sharp` 按 8×8 瓦片块抽样打分自动择优；`bench` 各片区抽样评测；`--plan ultra` 核心片区 z20；前端地形 LOD 在本地包有 z20 时可细分到 z20。
  - `tools/amap_fetch.py`：高德 Web 服务 API（多边形 POI 搜索四叉细分、交通态势矩形道路），缓存续传、配额保护，`merge` 做 GCJ→WGS 逆变换后合并进 pois.json（类型码映射到招牌类别与重要度）与 roads.json（补缺失路段、给无名路补路名）。已用伪造数据离线测试；真实抓取需用户 Key 在本机运行（云端网络不通高德）。

**遗留 / 下一步**
1. 在本机运行 `python tools/imagery_pack.py bench ...` 选源，再 `all --pick sharp --plan ultra` 生成影像包；运行 `tools/amap_fetch.py poi/roads/merge` 更新 POI 与路网；在 Mac 上复核永宁门夜景（`?online=0&view=5&time=20.8`）。
2. 待核实并补建：欧亚国际三期两栋 180 m 塔（坐标、是否竣工未知）、凯悦准确轮廓（现为按调研推测的叠石体块）、W 酒店三塔准确落位、彩虹桥主塔偏向哪一岸、西北国金中心 228 m 是否已建成。有高清影像后可逐一校准。
3. 浐灞/港务区 2022 年后新建的大量住宅在 CMAB 中缺失或高度被截在约 86 m；需要更新的建筑数据源（或用高清影像人工补录重点片区）。
4. 曲江道路：数据已是 2026 年最新 OSM；登高路南段（杜陵西路—航天大道 1,177 m）OSM 尚未绘出。
5. 招牌字体：headless Linux 下中文字体回退可能与 macOS 不同，招牌以 macOS 实机效果为准。

## 11. 2026-09-28 云端会话更新（分支 `claude/landmarks-all`，PR #2）

用户需求（原话摘要）：西安所有地标精细化（联网搜名称）、全部商场商圈、更深度高德数据；学校/公共建筑/历史遗迹/景点；城墙券洞与圆角台；
光影与详细画质开关、可视度、车辆/人物开关；路名、小区、建筑分类高亮俯视；全西安地铁地下网络（官方色、可进入、一键俯视透视）；全西安下沉广场；所有高校。

- **联网调研清单** `research/refs/landmarks2026/`：towers 75、malls 90、heritage 80、venues 85、metro 14 线/263 站、sunken 27、universities 109 校区（各有 *_notes.md）。
  注意：`data-src/overture/place.parquet` 坐标混杂——多数与 OSM 重合（WGS-84），少数品牌店来源为 GCJ-02，不要整体纠偏。
- **地标批量精建**：`tools/build_landmarks2026.py` → `public/data/landmarks2026.json`（塔楼/商场/场馆/高校标志楼→skyline；古建院落→`heritage26` 模块；下沉广场→`sunken` 模块；公园/校园→标注）。
  轮廓优先 OSM/Overture 同名，其次含点/就近，最后按调研尺寸合成矩形；已精建（already_modeled、手工轮廓内、其他模块排除区内）自动跳过。
- **地铁地下网络**：`tools/build_metro.py` → `public/data/metro.json`；`src/modules/metro.js`：隧道（官方线路色腰线）、站台层/站厅层/屏蔽门/站名牌、出入口通道、运行列车；
  X 透视俯视（压暗城市 + 发光线网 + 车站点 + 站名），U 进入最近车站地下步行（controls.groundFn 接管地面），再按返回地面。
- **高德深度接入**：`tools/amap_fetch.py metro|district|place|all` + merge → `public/data/amap_extra.json`；`amapinfo` 模块（行政区界、街道、商圈、高德地铁线，面板开关）。需要用户自己的 Web 服务 Key，云端网络访问不了高德。
- **城墙**：18 座门 65 孔券洞真实贯通墙体（`GATE_HOLES`）；西南圆形角台重做（资料与影像均为西南角圆、其余方角）；魁星楼移到文昌门西侧。
- **专题**：路名（近处沿路显示）、小区名与边界、建筑 12 类分类高亮（B）、一键俯视（V）；`src/core/{roadnames,estates,thematic}.js`、`src/arch/bld-class.js`。
- 待核：约 30 个地标坐标为 estimated；下沉广场深度/尺寸多为估计；skyline.json 原始数据里国瑞 IFC 为 330 m（精建模型已按 350 m）。

## 12. 2026-09-29 南门榴园重做 + 全城穿模排查

- **南门榴园**：旧数据把榴园估在南门外**西侧** (-200,1110)，150×40 m 矩形坑挖穿了兴道巷与环城南路西段匝道。按西安晚报 2014 开园报道
  （“榴园位于南门外东侧，紧邻护城河南岸”）、南门·映巷商户资料、游客照片与 Google/Esri/Bing 卫星 + OSM 步道环重做：
  不规则九边形坑口（约 1800 m²，深 5.5 m）、西北边全宽大台阶（32 级 + 休息平台花箱）、北侧漫咖啡之下的 B1 骑楼（青砖方柱 + 黄铜诗词灯柱）、
  东/东南/南三面 B1 店面（真实店名招牌）、脸谱壁画墙、水池木凳、SUG 白石拱门、“南门映巷”地下街入口、玻璃栏杆 + 暖光灯带、LED 大屏；
  地面层漫咖啡（歇山灰瓦）、南侧悬山小殿、东南坡顶小屋。代码 `src/arch/sunken-liuyuan.js`，资料 `research/refs/sunken/liuyuan_notes.md`。
- **地形挖洞** `terrain.addHole`（`src/core/terrain.js`）：坑内地形瓦片丢弃片元，坑外地形原样；替代原来“平整区压坑 + 10 m 铺装环”的做法
  （地形网格 4~21 m，压出来的斜面会爬上挡墙、盖住店铺，还会把坑外道路拉下去）。
- **下沉广场核验**：清单里其余下沉广场多为估计坐标，挖坑前核验（压机动车道/步行街、压其他模块精建区、压成片通用建筑或水面则不挖），
  目前 10 处未通过，只记录原因（`ctx.modules.sunken.diag()`），需要逐个用影像核实后补。
- **穿模排查工具**：`tools/check_overlap_node.mjs`（无浏览器，约 1 分钟，dump 格式与 check_overlap.mjs 相同，新增档案建筑各体块、下沉广场坑口、
  大唐不夜城让位信息）、`tools/check_trees.mjs`（树冠插进外墙统计）、`tools/node-glob-loader.mjs`（Node 里展开 Vite 的 import.meta.glob，
  arch_env 可加载 dossier-specs）；通用建筑让位预处理拆到 `src/arch/bld-skip.js` 供工具复用。
- **根因修复**：skyline 特殊地标被档案替代后不再登记占地/压平地形；档案建筑逐块取底高（旧写法把多块轮廓串成一个多边形求质心，整栋下沉）；
  落地轮廓地形起伏 > 2.5 m 时按全栋统一高度只压低（FABDEM 残留的“屋顶地形”，北站、锦江、交大主楼等；skyline 批量地标同一口径）；楼体内部路段不画；
  大唐不夜城程序化唐风建筑给档案建筑（曲江银泰城、威斯汀、温德姆、曼蒂、嘉悦里）让位；W 酒店与万众国际裙房共面；
  时代盛典大厦北广济街过街门洞；北站雨棚下让位；通用建筑“精建区从楼中间横穿”漏判；近楼树木按离墙距离收冠；行人不走被隐藏的路段。
- **修前→修后**（`node tools/check_overlap_node.mjs`）：轮廓相交 472→333（特殊×档案区 110→0、档案×不夜城区 22→0）、重复生成 40→9（档案×特殊 31→0）、
  悬空 1→0、档案建筑埋地 130→6 / 严重埋地 71→3（剩下 3 个是高度 < 2 m 的小体块，统计口径误报）、批量地标埋地 13→3、坑口压建筑/道路 18→0；
  树冠插墙 >1 m 2612→7 棵（`tools/check_trees.mjs`）；古建体检（check_arch_clip）悬空/穿屋面/NaN 均为 0，与修前一致。
- 残留：通用建筑压道路约 2000 处（OSM 轮廓与路网本身重叠，多为小区内部路/步行街）、通用×回民街 62、通用×heritage26 区 63 等多为 2.5 m 缓冲边缘；
  通用建筑“埋地”约 1.1 万处是 DEM 坡地（上坡侧埋、下坡侧露），非错误；W 酒店与万众国际、未央国际 wy168 叠层是设计如此。

## 12. 2026-10-06 本机（Mac/Metal）复核与修复轮

云端 PR #1~#6 已全部合并到 main（含 #6 持续优化，原为草稿）。本机 Metal GPU 全模块 13 个预设视角白天/夜景体检：0 报错、60 fps；用户点名的地标（熙地港、大融城、W 酒店/万众国际、艾美、凯悦、欧亚国际、彩虹桥、回民街 7515 栋）近景确认均已渲染。

**确认**：永宁门夜景整屏黑（第 7 节第 1 条）在 Metal 上已修好。

**新发现的问题（本轮修复）**：
1. 夜景地平线“假太阳”：只加载 airports 模块即可复现——咸阳机场跑道/滑行道/进近灯（`src/arch/airport-ground.js`）在 20 km 外被泛光糊成白团；钟楼夜景右上角一白一红两团同源。修法：灯点按相机距离衰减（6 km 起减弱、12 km 外不可见）并审计其他远距高亮发光体。
2. 曲江模块绘制调用：W 酒店机位全场景 1834 次，其中 qujiang 单独 995 次（按格分簇 × 2 级 LOD × 湖面倒影逐 mesh 复制）。目标 ≤120。
3. 小区边界线默认常开（夜景里黄色轮廓线抢眼）→ 已改为默认关闭，`?estatelines=1` 开启（提交 8182906）。
4. 白天整体发白、远景雾蒙蒙、天空近白：待调 `sky.js`/`fog.js`/`post.js`/`terrain.js` 色调。
5. 三角形偏高：高画质 8~23M（不夜城 22.9M、曲江 21.9M）。目标高画质 ≤12M。
6. 离线底图（Esri 冬季旧图）满地雪斑 → 正在用 `tools/imagery_pack.py all --source google,esri_clarity --pick sharp --plan ultra` 生成本地高清影像包（评测：Google 最清晰且几乎无雪，Esri 的高分是锐化伪影，esri_clarity 零雪作补缺）。影像包生成后 `tiles/*.xtp` 自动启用。

**影像源评测（`imagery_pack.py bench`，清晰度=拉普拉斯方差，雪=高亮低饱和像素比例）**：Google 各片区雪 0~3%（浐灞 11%，疑为水面/白色屋顶），esri_clarity 全部 0% 但清晰度最低，esri 雪 2~6%，bing 最糊。

**修复分工（5 个独立工作树代理）**：夜景远距光斑 / 曲江绘制调用（含 `tools/check_drawcalls.mjs` 与 `docs/PERF_DRAWCALLS.md`）/ 白天大气调校 / 三角形 LOD（含 `docs/PERF_TRIANGLES.md`）/ 用户点名片区的街景级打磨（未央商圈、凤城七路、曲江周边道路、浐灞后海、回民街洒金桥；可能新增 `src/modules/streetscape.js`）。合并后需再跑一遍 13 视角体检。

**影像包结论（2026-10-06 本机生成）**：最终用 **Google 单源**（`python tools/imagery_pack.py all --source google --plan ultra --workers 16`），`tiles/` 共 1.35 GB、108664 张（z11~z20，核心片区 z20），下载约 55 分钟。曾试过 `--source google,esri_clarity --pick sharp`：择优块里 Esri Clarity 色调偏青绿，在全城俯视里呈现成片矩形色差，比少量雪斑更碍眼，故弃用。`tiles/` 不入库，换机器需重新生成；瓦片缓存在 `data-src/tiles_hd/google/`（约 2.7 GB）。
