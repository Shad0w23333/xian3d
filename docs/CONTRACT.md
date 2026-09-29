# 西安 3D —— 工程契约（所有参与者必须遵守）

## 1. 坐标系与投影（唯一真相）

- 原点：钟楼中心 `LAT0 = 34.2610119`, `LON0 = 108.9423419`（OSM way 254488435 质心）。
- 投影：Web Mercator（EPSG:3857）米坐标，再乘以 `K = cos(LAT0)` 缩放到“当地真实米”。
  ```
  R = 6378137
  mercX(lon) = R * lon * PI/180
  mercY(lat) = R * ln(tan(PI/4 + lat*PI/360))
  K = cos(LAT0 * PI/180)                       // ≈ 0.826
  worldX =  (mercX(lon) - mercX(LON0)) * K    // 东为 +X
  worldZ = -(mercY(lat) - mercY(LAT0)) * K    // 北为 -Z（Three.js 右手系，Y 向上）
  worldY = 海拔高度（米，绝对海拔，不减原点）
  ```
- 这样卫星瓦片（Web Mercator）在世界坐标里是严格的轴对齐矩形，所有数据共用这一个函数，对齐零误差。
- Python 与 JS 必须实现完全相同的公式（JS 在 `src/core/geo.js`，Python 在 `tools/geo.py`）。
- 世界坐标单位 = 米。所有矢量数据在离线管线里就投影成世界坐标（保留 1 位小数），浏览器端不再做经纬度换算（除 UI 显示）。

## 2. 区域范围

| 名称 | 经度 | 纬度 | 用途 |
|---|---|---|---|
| OUTER | 108.30 – 109.70 | 33.65 – 34.90 | 远景地形（秦岭）、低清影像 |
| MAIN  | 108.60 – 109.40 | 33.95 – 34.72 | 主区域：地形、道路、水系、机场、全部数据 |
| CORE  | 108.84 – 109.06 | 34.17 – 34.35 | 城市核心：建筑全量、住宅路网、高清影像 |

建筑覆盖：CORE 全量 + MAIN 内的咸阳市区/机场/阎良/长安区等（总文件大小受限，见下）。

## 3. 数据文件（`public/data/`，浏览器通过 `src/core/data.js` 加载）

所有文件名固定，管线必须产出这些文件；可选文件缺失时前端必须能降级运行。

### 3.1 `meta.json`
```json
{
  "origin": {"lat": 34.2610119, "lon": 108.9423419},
  "k": 0.826...,
  "generated": "ISO 时间",
  "dem": [ {"file": "dem_main.png", "w": 2048, "h": 2048, "bounds": {"x0":..,"x1":..,"z0":..,"z1":..}, "lonlat": [w,s,e,n]}, {"file":"dem_outer.png", ...} ],
  "imagery": [ {"file": "img_outer.jpg", "w":2048,"h":2048, "bounds": {...}, "mpp": 60, "priority": 0}, ... ],
  "sources": ["© OpenStreetMap contributors", "Esri World Imagery", "..."]
}
```
- `bounds` 均为**世界坐标**：`x0 < x1`（西→东），`z0 < z1`（北→南，注意北是 -Z，所以 z0 是北边）。
- DEM 与影像的像素网格都与 Web Mercator 对齐：像素 (i=列, j=行) 的**中心**位于
  `x = x0 + (i+0.5)*(x1-x0)/w`, `z = z0 + (j+0.5)*(z1-z0)/h`。第 0 行是北边。

### 3.2 DEM：`dem_main.png`, `dem_outer.png`
- Terrarium 编码 8-bit RGB PNG：`h = R*256 + G + B/256 - 32768`（米）。
- **必须是“去建筑”的地面高程（DTM）**：城市区域 SRTM/Copernicus 是 DSM，含建筑高度，需滤掉（优先 FABDEM；否则城区做低分位数滤波 + 平滑）。水面（渭河、湖泊）需平整。
- dem_main ≥ 2048×2048 覆盖 MAIN（≈36~45 m/px）；dem_outer 1024×1024 覆盖 OUTER。

### 3.3 影像降级底图：`img_*.jpg`（在线 Esri 瓦片不可用时使用，也作为首帧底图）
| 文件 | 覆盖 | 尺寸 | 约分辨率 |
|---|---|---|---|
| img_outer.jpg | OUTER | 2048² | ~60 m/px |
| img_main.jpg | MAIN | 4096² | ~20 m/px |
| img_core.jpg | CORE | 4096² | ~5 m/px |
| img_wall.jpg | 城墙内 108.922–108.966, 34.247–34.279 | 2048² | ~2 m/px |
| img_qujiang.jpg | 大雁塔/不夜城/曲江 108.950–108.990, 34.192–34.226 | 2048² | ~2 m/px |
| img_xiy.jpg | 咸阳机场 108.70–108.82, 34.41–34.47 | 4096×2048 | ~2.7 m/px |
JPEG 质量 ~82，单文件 ≤ 8 MB。实际 bounds 以 meta.json 为准（对齐到瓦片边界后会略有外扩）。

### 3.4 建筑：`buildings.bin`（小端二进制，SoA 布局）
```
Header (16 B): magic "XBLD" | uint32 version=1 | uint32 count | uint32 totalVerts
float32 anchorX[count], float32 anchorZ[count]        // 建筑质心（世界坐标）
uint32  vertStart[count]                              // 在顶点数组中的起始下标（以顶点计）
uint16  vertCount[count]
uint16  heightDm[count]                               // 建筑顶高（分米）
uint16  minHeightDm[count]                            // 底部起始高度（分米，building:part 用，通常 0）
uint8   kind[count]   // 0 通用 1 住宅 2 商业/办公 3 工业 4 公共/政府 5 历史/宗教 6 交通 7 学校/医院 8 酒店
uint8   flags[count]  // bit0 高度为实测(OSM/数据集)；bit1 有名称(见 buildings_names.json)；bit2 高层地标
(对齐到 4 字节)
int16   offs[totalVerts*2]                            // 相对 anchor 的顶点偏移（分米），外环逆时针（俯视，X 东 Z 南坐标下按 shoelace 面积 >0 定义为 CCW），不重复首点
```
- `buildings_names.json`：`{"<index>": "名称", ...}` 仅含有名称的建筑。
- 大小预算：`buildings.bin` ≤ 14 MB。
- 高度来源优先级：OSM `height` > `building:levels`×3.2 m > 建筑高度数据集 > 启发式（按面积/形状/用地类型）。

### 3.5 道路：`roads.json`
```json
{"classes": ["motorway","trunk","primary","secondary","tertiary","residential","service","unclassified","motorway_link","trunk_link","primary_link","secondary_link","pedestrian","footway"],
 "features": [ {"c": 0, "n": "名称", "w": 24.0, "l": 6, "o": 1, "b": 0, "t": 0, "y": 0, "p": [x,z, x,z, ...]} ] }
```
- `c` classes 下标；`w` 路面宽度（米，按 lanes/等级估算）；`l` 车道数；`o` 单行 1/0；`b` 桥梁；`t` 隧道；`y` layer；`p` 世界坐标折线（1 位小数）。
- MAIN 内：motorway..tertiary 及 *_link；CORE 内：再加 residential / unclassified / pedestrian（footway/service 仅城墙内与大唐不夜城一带）。
- 同时产出 `rail.json`（同结构，classes: rail/subway/light_rail，含 `n`，隧道标记，地铁一般不渲染地下段）。

### 3.6 水系：`water.json`
```json
{"polys": [ {"n": "渭河", "k": "river", "outer": [x,z,...], "holes": [[x,z,...]], "h": 363.2} ],
 "lines": [ {"n": "浐河", "k": "river", "w": 30, "p": [x,z,...]} ]}
```
`k`: river / lake / reservoir / moat / pond / canal / basin；`h`：建议水面海拔（由 DEM 在多边形内取低分位数）。护城河务必包含。

### 3.7 用地与绿地：`landuse.json`
`{"polys": [ {"k": "park|forest|grass|farmland|orchard|residential|commercial|industrial|university|cemetery|military|construction|square", "n": "名称", "outer": [...], "holes": [...]} ]}`

### 3.8 航空：`aeroway.json`
```json
{"aerodromes": [ {"n":"西安咸阳国际机场","iata":"XIY","icao":"ZLXY","outer":[...]} ],
 "runways":  [ {"ref":"05L/23R","w":45,"len":3000,"p":[x,z,x,z]} ],
 "taxiways": [ {"ref":"A","w":23,"p":[...]} ],
 "aprons":   [ {"outer":[...]} ],
 "terminals":[ {"n":"T3航站楼","outer":[...],"h":35} ],
 "gates":    [ {"ref":"...","x":..,"z":..} ],
 "helipads": [] }
```

### 3.9 兴趣点：`pois.json`（招牌与标注用）
`{"pois": [ {"n":"赛格国际购物中心","k":"mall|shop|restaurant|hotel|bank|cafe|cinema|landmark|station|metro|school|hospital|gov|museum|temple","x":..,"z":..} ]}`，仅带中文名称的点；CORE 内 ≤ 20000 条。

## 4. 前端模块接口（`src/modules/*.js`）

```js
export default {
  id: 'belltower', name: '钟楼与鼓楼',
  // 可选：地形/建筑准备阶段（在地形和通用建筑生成之前调用，同步或返回 Promise）
  prepare(ctx) { ctx.terrain.addFlatten({...}); ctx.exclusions.add({...}); },
  // 必须：构建
  async build(ctx) { ...; return { update(dt, t) {}, dispose() {} }; }
};
```
`ctx`（见 `src/core/context.js`）主要字段：
- `THREE`、`renderer`、`scene`、`camera`
- `geo.project(lon, lat) → {x, z}`，`geo.unproject(x, z) → {lon, lat}`
- `terrain.heightAt(x, z)`：地面海拔（已含平整区）；`terrain.addFlatten({points:[x,z,...], height, feather})`（仅 prepare 阶段）
- `terrain.addHole(points)`：地形挖洞（下沉广场等，prepare 阶段）——洞内地形瓦片不绘制、`heightAt` 不变，洞内几何由模块自己补齐；
  `terrain.holeRimTop(points)` 给出洞口一圈地形渲染面可能达到的最高高度（挡墙/压顶做到它以上就不会露缝）。
  坑深远大于地形网格间距（4~21 m）时不要用 `addFlatten` 压坑：斜面会爬上挡墙、盖住坑底。
- `exclusions.add({points:[x,z,...]}, {buildings:true, trees:true, roads:false})`：让通用 OSM 建筑/树木在地标位置让位
- `data.roads / data.water / data.landuse / data.aeroway / data.pois / data.rail / data.buildings`
- `uniforms`：全局共享 uniform 对象 `{uTime, uNight, uSunDir, uCameraPos}`（自定义着色器直接引用同一对象即可自动更新）
- `sky.night`（0 白天 … 1 深夜，已平滑）、`sky.hours`
- `night.register(material, {day: 0, night: 2.5})`：由核心每帧按夜间系数设置 `emissiveIntensity`
- `lights.add({position, color, intensity, distance, nightOnly:true})`：动态点光源池（只激活离相机最近的 N 个）
- `mats`：共享 PBR 材质库；`tex.text(text, opts)`：Canvas 文字贴图（招牌/匾额）
- `labels.add(text, Vector3, {category})`：浮动地名标注
- `quality`：当前画质档位 `{level:0..3, shadows, drawDistance, traffic, pixelRatio}`
- `overlay(material, bias)`：对覆盖层（道路/水面/标线）施加随距离增长的深度偏移，防 Z-fighting

约定：
1. 模块只在自己的文件里工作；共享工具放 `src/core/*` 或 `src/arch/*`。
2. 同材质几何尽量合并（`BufferGeometryUtils.mergeGeometries`），大量重复物用 `InstancedMesh`。单个地标 draw call 目标 ≤ 30。
3. 所有物体坐标用世界坐标，Y 用 `terrain.heightAt` 贴地。
4. PBR：`MeshStandardMaterial`/`MeshPhysicalMaterial`，贴图用 Canvas 程序化生成（无外部版权素材）。
5. 夜景：发光用 emissive（值 >1 会产生泛光），并注册到 `ctx.night`；重要光源注册到 `ctx.lights`。
6. 文字（招牌/匾额）一律简体中文，使用 `ctx.tex.text`。
