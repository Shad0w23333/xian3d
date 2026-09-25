# 模块开发指南（所有建模代理必读）

目标：用 Three.js 做一个**真实风格、高精度、可交互**的西安三维模型。质量标准：从近处（离地 20~80 m）看，建筑的**窗户、檐口、斗拱、栏杆、招牌文字**都要清晰可辨；白天是真实 PBR 质感，夜晚有真实的城市灯光（亮窗、路灯、泛光照明、轮廓灯、LED 幕墙），配合泛光（Bloom）效果。同时要流畅（M 系列 Mac 上“高”画质 60 fps，普通笔记本“中”画质 30 fps 以上）。

> 现有模块多为外部代理写的低精度初版（白盒子、平屋顶），**你负责的模块请整体重写**，不必保留旧实现。

## 1. 工程结构与约定

- 坐标：世界坐标单位米，**X 东、Z 南（北为 -Z）、Y 为绝对海拔**。经纬度 → 世界坐标用 `ctx.geo.project(lon, lat)`；贴地用 `ctx.terrain.heightAt(x, z)`；便捷函数 `ctx.at(lon, lat, 离地高)` 返回 Vector3。详见 `docs/CONTRACT.md`。
- 模块接口（`src/modules/<id>.js`）：
  ```js
  export default {
    id: 'belltower', name: '钟楼与鼓楼',
    prepare(ctx) { /* 可选：ctx.terrain.addFlatten(...) 平整台基；ctx.exclusions.add(...) 让通用建筑/树木让位 */ },
    async build(ctx) { /* 构建并 ctx.scene.add(...) */ return { update(dt, t) {}, setLayer(name, on) {}, setQuality(q) {} }; },
  };
  ```
- **只改你负责的文件**（你的模块文件、你新建的 `src/arch/<你的前缀>*.js`、`research/refs/<你的模块>/`、`shots/<你的模块>/`）。`src/core/*`、`src/main.js`、别人的模块一律不改；需要核心改动时写在最终汇报里（总负责人统一处理）。可以 import 核心工具。
- 不要引入新的 npm 依赖；不要下载外部 3D 模型文件——全部程序化建模（几何 + Canvas 程序化纹理），这样没有版权问题也能单文件打包。

## 2. 可用的核心工具

- `ctx.mats.get(name)`：共享 PBR 材质（名字见 `src/core/materials.js`：wallBrick、pagodaBrick、roofGray、roofGreenGlazed、roofYellowGlazed、lacquerRed、caihua、gold、marble、stonePaving、woodDark、latticeRed、paperWindow、asphalt、concrete、glassBlue、glassDark、glassGold、metalGray、paintWhite、grass、lampWarm、lampWhite、lanternRed、ledGold…）。纹理以“米”为 UV 单位（`util.worldBoxUV(geo, 1)`），材质内部已设置平铺尺寸。需要特殊材质就在自己文件里新建（推荐 `MeshStandardMaterial`/`MeshPhysicalMaterial` + Canvas 纹理，见 `src/core/textures.js` 的 brick/roofTiles/grain/wood/lattice/caihua/text）。
- `ctx.tex.text(str, opts)`：Canvas 文字贴图（中文字体，支持竖排、描边、发光、边框）；`ctx.sign(str, {height, bg, color, border, serif, vertical, emissive})`：直接得到招牌/匾额平面网格（夜间自动发光）。
- `ctx.night.register(material, {day, night})`：核心每帧按夜间系数（0 白天 → 1 深夜）设置 `emissiveIntensity`。泛光阈值约 0.7~0.95（线性 HDR），emissive 强度 > 1.5 会明显发光。
- `ctx.uniforms`：`uTime`、`uNight`、`uSunDir`、`uCameraPos` —— 自定义着色器直接引用这些对象即可自动更新（例如在 `onBeforeCompile` 里 `shader.uniforms.uNight = ctx.uniforms.uNight`）。
- `ctx.lights.add({position, color, intensity, distance, nightOnly, priority})`：动态点光源池（只点亮离相机最近的 4~12 盏真实 PointLight）。用于地标泛光、广场灯等“重要光源”；大量路灯请用自发光 + 假光斑贴花，不要全部注册。
- `ctx.exclusions.add({points|rect|circle}, {buildings, trees, roads})`（prepare 阶段）：通用 OSM/CMAB 建筑和树木会避开这些区域——地标模块一定要把自己的占地加进来，否则会和白盒建筑重叠。
- `ctx.terrain.addFlatten({points, height, feather, mode})`（prepare 阶段）：把台基/广场/跑道下的地形压平（height 为 null 时取平均）。
- `util.js`：`Batcher`（按材质合并几何，**强烈推荐**，每个地标最终 draw call ≤ 30~40）、`worldBoxUV`、`ribbon`（贴地条带）、`overlay(material, bias)`（贴地覆盖层防 Z 冲突）、`rectPoly`、`circlePoly`、`resample`、`pointInPoly` 等。
- `ctx.labels.add(text, Vector3, {category, minDist, maxDist, priority})`：浮动地名标注。**每个模块最多 6 个**，只给真正的地标名称（比如“钟楼”“永宁门”），不要把 POI 全部加进来。
- `ctx.data`：`roads / water / landuse / aeroway / pois / rail / buildings(ArrayBuffer) / buildingNames / landmarks / skyline`。
- `ctx.quality`：`{level 0..3, shadows, pointLights, buildingDistance, trafficDensity, treeDensity, …}`，模块可据此调整密度与细节。
- 高度雾已替换 three 的 FogExp2 片段（`src/core/fog.js`）：自定义 `ShaderMaterial` 请包含 `#include <fog_pars_vertex>` / `<fog_vertex>` / `<fog_pars_fragment>` / `<fog_fragment>` 并设 `fog: true`，否则远处不会被雾化。自定义着色器也请包含 `logdepthbuf_*` 片段（某些浏览器会回退到对数深度）。

## 3. 质量要求

1. **比例与位置真实**：先做资料调研（WebSearch/WebFetch，下载 2~4 张参考照片到 `research/refs/<模块>/` 并用 Read 查看），把尺寸、层数、颜色、屋顶形式写进代码常量注释里。位置用 OSM/卫星核对（已有资料：`data-src/landmarks_historic/`（城墙中心线、18 座城门、91 个马面）、`data-src/airports_research/`、`public/data/skyline.json`、`public/data/landmarks.json`）。
2. **细节层级**：近看要有构件（窗框、窗格、栏杆、斗拱、瓦垄、脊兽、台阶、门钉、匾额、招牌、空调外机、玻璃幕墙竖梃……），远看要轮廓正确。用 LOD：`update()` 里按相机距离切换细节组可见性（如 > 1.5 km 隐藏小构件），或用 `THREE.LOD`。
3. **PBR**：金属度/粗糙度合理；玻璃用 `MeshPhysicalMaterial`（低粗糙度，反射环境）；木构朱漆带清漆；砖石有法线贴图。避免纯白（albedo ≤ 0.85）和纯黑。
4. **夜景**：每个模块都要有设计过的夜间效果（泛光照明用“随高度衰减的暖色 emissive”着色器或自发光轮廓灯条；窗户随机亮灯；灯笼、路灯、LED）。夜景要像真实照片那样有层次，不要一片死黑也不要一片过曝。
5. **性能**：合并几何、实例化重复构件（InstancedMesh）、共享材质；单模块构建时间 ≤ 2 s（重计算放到 Web Worker 或分帧）；不要每帧分配对象。地标阴影 `castShadow = true`。
6. **中文**：招牌、匾额、标语全部简体中文（古建匾额可用繁体原文，如“永寧門”），内容尽量真实。

## 4. 自测流程（必须做）

截图工具（自动起 Vite + 无头 Chromium，Metal GPU）：
```bash
node tools/shot.mjs --shot "modules=belltower&view=2&time=15|shots/belltower/day.png" \
                    --shot "modules=belltower&view=2&time=21|shots/belltower/night.png" --wait 45
```
- 查询参数：`modules=a,b`（只加载这些模块，迭代时用，快）；不写 modules = 全部模块；`view=1..0 / !1..!5`（预设视角，见 `src/core/config.js`）；`ll=lon,lat,离地高,目标lon,目标lat,目标离地高`（任意视角）；`time=小时`；`q=0..3` 画质；`online=0` 关闭在线卫星瓦片（更快，但地面只有内置底图）；`labels=1` 显示标注；`orbit=1`。
- 输出 PNG 用 **Read 工具查看**；控制台 JSON 含 fps、draw calls、三角形数、控制台错误、模块错误——必须 0 错误。
- 每个模块至少验证：近景白天、近景夜景、中景（300~800 m）、远景（全城俯视里是否协调）。与参考照片对比，列出差异并迭代，至少迭代 3 轮。
- 最后用**全部模块**再截一次确认没有和别的模块冲突（例如与通用建筑重叠、与道路打架）。
- 多个代理同时在跑截图，偶尔会慢，属正常；截图输出放 `shots/<你的模块>/`。

## 5. 汇报

最终回复（简体中文）写：实现了什么（构件清单）、参考资料来源、截图路径（白天/夜景/近景）、性能数据（draw calls、三角形、fps）、已知问题、需要核心配合的改动。
