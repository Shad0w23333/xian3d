# 逐栋档案建模（DOSSIER_KIT）

用户要求：**不要主观臆断，按互联网真实信息与照片建模，认真建模每一个商场、小区、公共建筑、地标。**
逐栋档案已在 `research/refs/dossiers/{core_south,gaoxin,north,east_west,public,residential}.json`（及 `*_notes.md`）里，
本工具链把档案变成模型：每栋楼写一个 **spec**（纯数据 JS 对象），建模库负责几何、立面、塔冠、招牌、夜景，并自动替代旧模型。

| 文件 | 作用 |
|---|---|
| `tools/build_dossier_fp.py` | 从 Overture `building.parquet` 按档案 + spec 里出现的全部 overture_id 抽轮廓 → `public/data/dossier_fp.json` |
| `src/arch/dossier-kit.js` | 建模库：`buildDossier(env, spec)`、`resolveSpec`、形状库、立面 pattern、塔冠、招牌、夜景、`isSuperseded` |
| `src/arch/dossier-specs/<片区>.js` | spec 数组（`export default [...]`），`index.js` 用 `import.meta.glob` 自动收集，**新增片区文件不用改 index** |
| `src/modules/dossier.js` | 模块：prepare 登记替代与排除区，build 合批输出（按 3 km 网格分组、细部 LOD） |
| `src/modules/skyline.js` | `isSuperseded(ctx, s)`：跳过被档案替代的 sky-data / sky-data2 / landmarks2026 / skyline.json 通用高层 / SPECIAL(2) |
| `research/refs/dossiers/model_log.md` | 每栋建完后的“照片 vs 模型”对照差异记录 |
| `src/arch/dossier-specs/demo.js` | 示范：陕西信息大厦、西安SKP、大明宫万达（读这三个就能上手） |

---

## 1. 工作流程（每栋楼）

1. **读档案**：`research/refs/dossiers/<片区>.json` 里该条的 `overture_id / footprint_size_m / height_m / floors / massing / crown / facade / podium / signage / night / photos / confidence / notes`。
2. **看照片**：档案 `photos` 的本地副本在 `/tmp/claude-0/-home-user/cdda9a62-d609-5ebd-a0b7-50a268f8e058/scratchpad/dossier_*/`（`photos/`、`art/`、`sat/`、`*_grid.jpg`），用 Read 打开。先判断**拍摄方向**（远山=秦岭在南、已知道路/地标的左右关系），再读形体。
3. **核轮廓与卫星**：`fp` 用档案里的 overture_id；形体分块（塔楼/裙房）找轮廓内的 OSM 分体（见 §6 小工具）。
   卫星上高楼**屋面会向一侧偏移**（楼身倾斜，Esri 西安一带约 0.3–0.4 m/每米楼高），塔楼落位 = 屋面位置 − 倾斜位移，**不要把屋面当底座**。
4. **定数值**：档案有出处的数值直接用；档案为 `null` 的**不要编**——
   - 能从照片数层就数层 × 合理层高，并在 `meta.notes` 写“按照片数层（约 N 层）”；
   - 能从卫星量取就量取，写“按卫星量取（±N m）”；
   - 都做不到就保守处理（用轮廓 + 最低可信高度），并在 notes 说明。
5. **写 spec** 到 `src/arch/dossier-specs/<片区>.js`；需要新轮廓就在 spec 里写完整 UUID，然后重跑 `python3 tools/build_dossier_fp.py`（它也扫描 spec 文件里的 UUID）。
6. **声明替代**（§5），**构建** `npx vite build`，**截图**（§7）并用 Read 对照照片，差异写进 `research/refs/dossiers/model_log.md`。

---

## 2. 坐标与单位约定

| 项目 | 约定 |
|---|---|
| 世界坐标 | X 东、Z 南（**北 = −Z**），原点钟楼；`tools/geo.py project(lon, lat)` |
| 轮廓 `pts` | 世界坐标扁平数组 `[x0,z0,x1,z1,…]`，库内统一转 CCW（`G.ccw`） |
| `at: [x, z]` | 世界坐标（绝对位置） |
| `offset: [东, 北]` | 相对**建筑中心**的地图偏移（米）；塔冠的 offset 相对**所在体块质心** |
| `rot` | 长边相对正东**逆时针**的角度（度），北 = 90、西北—东南走向 = −45（与档案 `rotation_deg` / `long_axis_deg_from_east_ccw` 同义） |
| 方位 `face` / `near` | `'N' 'E' 'S' 'W' 'NE' 'SE' 'SW' 'NW'`（也可 16 方位、角度或 `[dx,dz]`） |
| 高度 | `base / top / y / masts.top` 都是**离地米数**；地面 = 所有落地体块轮廓下的最低地形高（`spec.ground` 可覆盖为绝对高程） |

---

## 3. spec 字段

```js
{
  id: 'xinxi',                      // 唯一键（全体 spec 不重复；重复时文件名靠后的覆盖）
  name: '陕西信息大厦',               // 标注名；同时自动加入替代名称
  fp: '<overture_id>',              // 可选：建筑中心取此轮廓质心（否则 center，或第一个带 fp/pts 的体块）
  center: [x, z],                   // 可选：建筑中心（offset 的参照）
  ground: 405.2,                    // 可选：绝对地面高程
  parts: [ /* 体块，见 3.1 */ ],
  signs: [ /* 招牌，见 3.4 */ ],
  bands: [ /* 装饰线条/灯带，见 3.5 */ ],
  night: { outline, floodlight, media }, // 夜景，见 3.5
  supersede: { names: [...], keys: [...] }, // 替代声明，见 §5
  site: [ '<overture_id>' | [x,z,...] ],     // 可选：额外排除区（广场、附属低层），也参与质心替代判定
  clearance: 2.5,                   // 排除区外扩（米）
  flatten: false,                   // true：落地体块下压平地形
  label: false | { text, y, priority },      // 标注（默认 name，放在最高点上方 8 m）
  meta: { dossier, sources: [...], photos: [...], confidence, notes }, // 追溯信息（不参与建模，必须写）
}
```

### 3.1 体块 part

```js
{
  name: 'body',                     // 招牌/夜景按名字引用
  kind: 'tower',                    // 'tower'（默认，buildTower：幕墙+女儿墙+屋面设备+障碍灯）| 'podium'（buildPodium：裙房/商场，支持内院）
                                    // | 'solid'（实体挤出：石材端墙、环带、实墙体量）| 'facade'（只有立面的直筒，如首层橱窗罩面）
                                    // | 'lattice'（斜交网格钢构：门洞桁架、外骨架，见 3.7）
  topPts: [x, z, ...],              // 可选：放样顶面轮廓（世界坐标，与底面同点数、同起点同绕向）。tower/facade 在底面与顶面之间直纹过渡
                                    // （逐层变大的切角、不等比收分），见 3.7；不能与 roundCorners 同用
  // —— 轮廓（三选一）——
  fp: '<overture_id 或 8 位前缀>',   // Overture 实测轮廓
  pts: [x, z, ...],                 // 世界坐标轮廓
  shape: 'rect', size: [长, 宽],     // 参数形状（见 3.2），配合 at / offset、rot、shapeOpt
  grow: 0.15,                       // 轮廓外扩（米，负数内缩）
  roundCorners: 9,                  // 凸角倒圆半径（“四角圆润”的商场）
  holes: 'fp' | [[x,z,...]],        // 内院/天井（podium 支持：院内立面朝内、屋面挖空）；'fp' 取 Overture 内环
  // —— 高度 ——
  base: 0, top: 180,                // 离地米数；叠在别的体块上就把 base 设为下层 top
  setbacks: [{ at: 120, inset: 2 }, { at: 160, inset: 4.5 }], // 退台：离地 at 米以上整体内缩 inset 米（累计值）
  taper: 0.9,                       // 收分：顶部轮廓缩放系数（体块内线性）
  style: { pattern: 'curtain', tint: '#23507e', spd: '#e6e6e6', floorH: 3.6, lit: 0.4 }, // 立面，见 3.3
  roof: { mech: false, parapet: 1.2 }, // 屋面：mech 屋顶设备盒（默认：没有塔冠时 true）
  mat: 'stone' | '#ebe8e1' | { color, roughness, metalness, glow }, // kind:'solid' 的材质
  roofMat: '#6f8a5b',               // kind:'podium' 的屋面材质（绿色屋面、深色屋面等）
  crown: 'flat' | {type,...} | [ {type,...}, ... ], // 塔冠，见 3.6
  seed: 12,                         // 立面随机种子（不写自动递增）
  footprint: true,                  // base>0 的体块默认不参与排除区；需要时置 true
}
```

### 3.2 形状库 `shape`（局部坐标：u 沿长边 = size[0]，w 沿短边 = size[1]；rot=0 时 u 朝东、w 朝北）

| shape | 说明 | shapeOpt |
|---|---|---|
| `rect` | 矩形 | — |
| `chamfer` | 切角矩形 | `c` 切角长（默认短边 12%） |
| `round` | 圆角矩形 | `r` 圆角半径、`seg` |
| `circle` / `ellipse` | 圆 / 椭圆（size 为直径） | `seg`（默认 48） |
| `L` | L 形，拐角在 (−u,−w) 角 | `arm` 竖臂宽、`arm2` 横臂宽、`flip` 左右镜像 |
| `U` | U 形，开口朝 +w | `arm` 两臂宽、`base` 底宽 |
| `triangle` | 底边在 −w，顶点在 +w | `apex` ∈ [−1,1]（−1 = 直角在左） |
| `trapezoid` | 底边 L 在 −w，顶边在 +w | `top` 顶边长、`shift` 顶边偏移 |
| `lens` | 透镜（两段圆弧） | `flat` 两端平直端墙宽 |
| `crescent` | 新月（外弧弓高 W） | `inner` 内弧弓高 |
| `arcSlab` | 弧形板楼：中线弧（弦长 L、弓高 sag）+ 厚度 W | `sag` |
| `ring` | 圆环（外径 L，环宽 W），自动带内环 | `seg` |

### 3.3 立面 `style`

`pattern`（语义化）→ sky-facade 参数，其余字段覆盖：

| pattern | 模式 | 用于 |
|---|---|---|
| `curtain` | 0 | 普通玻璃幕墙 |
| `grid` | 0 | 明框网格、实墙为主的深色盒子（spandrel 调大到 0.7 即“大面实墙”） |
| `verticalFins` | 0 | 竖向金属/石材肋（mullW 粗） |
| `horizontalBands` | 3 | 横向带窗、玻璃间的白色横带（夜间楼层线灯） |
| `louver` | 3 | 密集横向铝板/百叶带 |
| `floorLines` | 2 | 夜间楼层线灯 |
| `stoneWindows` | 7 | 石材墙 + 窗洞（老式高层、酒店、公建） |
| `stoneLit` | 9 | 石材 + 夜间暖色基座泛光 |
| `media` | 1 | LED 线条媒体幕墙（夜间彩色动画） |
| `openFrame` | 7 | 裸露结构（在建/停工楼：混凝土楼板 + 柱、内部黑洞洞，夜间不亮） |
| `screen` | 5 | LED 大屏 |
| `retail` | 6 | 商业裙房大玻璃（夜间通亮），podium 默认 |
| `crownGlass` | 4 | 塔冠泛光玻璃 |

参数：`tint` 玻璃色、`spd` 窗槛墙/竖梃/石材色（档案 `glass_color_hex` → tint，`wall_color_hex`/`frame_color_hex` → spd）、
`floorH` 层高、`colW` 竖梃间距、`spandrel` 窗槛墙占层高比例、`mullW` 竖梃宽、`lit` 夜间亮窗率、`band` 设备层间隔层数、`mode` 直接指定模式。

### 3.4 招牌 `signs`

```js
{ text: '中信银行', part: 'drum', face: ['N', 'SW'], y: 190.6, h: 3.2, color: '#c8102e' }
{ text: '西安SKP', part: 'mall', face: 'N', near: 'W', y: 25.5, h: 5, color: '#e36cc9' } // 北立面靠西端（西北角）
{ text: 'CROWNE PLAZA', part: 'crowne', face: 'roof', at: [-643.5, 3075], rot: 0, h: 7 }  // 屋面平铺大字
```
- `face`：方位（可数组，每个方位一块）；自动挑**外法线最接近该方位、且长度 ≥ 2×字高**的边；圆/曲面没有合适的边时按该方向外缘切平面贴字。
- `edge`：直接给边下标（`G.ccw` 后的轮廓）。`near`：沿该边推向某方位一端；`shift`：沿边再平移（米）；`margin`：离边端距离（默认 3）。
- `y` 字中心离地高（默认体块顶下 0.9×字高）、`h` 字高、`fill` 最大宽度占边长比例（0.8）、`out` 离墙距离、`color` / `glow` / `serif` / `weight` / `bg`。
- `vertical: true`：竖排字（`h` 为整列字高，如角楼上的竖排店名、酒店竖排名）。
- `face:'roof'`：屋面文字，`at`/`offset` 定中心，`rot` 为文字行进方向（地图角度），`maxW` 最大宽度。
- 所有招牌进同一张图集（夜间自发光）。字要写**档案 signage 里的原文**，颜色用档案 `color_hex`。
- `part: null` + `at:[x,z]` + `face`（方位/角度）+ `y`（离本栋地面米）：不挂体块的独立字牌——挂在旧模型/别的模块的墙面上（如未央国际裙房的 CUB GROCERY）、落地字等。

### 3.5 装饰线条与夜景

```js
bands: [{ part: 'mall', levels: [6.5, 11.5, 16.5], wave: { amp: 1.3, len: 88, phase: 1.7 },
          h: 0.22, depth: 0.18, color: '#9c8458', glow: '#ffc978', strength: 2.2 }],
night: {
  outline:    [{ part: 'towerN', color: '#ff9a3c', y: 81, w: 0.6, vertical: false }], // 轮廓灯：体块顶沿一圈（vertical 同时勾转角竖线）
  floodlight: [{ part: 'body', color: '#3f7dff', strength: 0.32, from: 26, to: 180 }],  // 泛光：立面外加色光幕，自下而上渐隐，仅夜间
  media:      [{ part: 'mall', face: 'W', from: 8, to: 24, width: 40, shift: 0, pattern: 'screen' }], // LED 屏
  // media 另可给 tint / spd（白天的玻璃色，默认近黑）与 style（覆盖立面参数）：EHB 的竖向 LED 媒体带白天仍是幕墙色
  beams:      [{ part: 'body', from: 270, at: [[x, z], …], len: 160, w: 2.2, color: '#e6f0ff', strength: 0.55 }], // 楼顶竖向光束
}
```
- `bands`：沿体块轮廓的水平线条（白天是实体金属/铝板带，`glow` 给了就在夜间发光）；`wave` 让线条沿周长上下起伏（“波浪线条灯”）。
- `beams`：楼顶上照灯形成的竖向光束（两片交叉竖直面片，自下而上渐隐，仅夜间）；`at` 世界坐标点列，或 `offsets` 相对体块质心 `[东,北]`，
  都不写就取 `from` 高度处轮廓的各个转角；`len` 光束长（默认 120 m）。
- 立面本身的夜景（亮窗、楼层线灯、LED 网格）由 `style.pattern` / `lit` 决定；`night` 只补额外灯光。

### 3.6 塔冠 `crown`（可组合成数组，按顺序叠放）

| type | 参数 | 说明 |
|---|---|---|
| `flat` | — | 平屋面（默认：女儿墙 + 屋面 + 设备盒） |
| `parapet` | `h`、`inset`、`mat` | 女儿墙高度 |
| `lantern` | `h`、`color`、`colW`、`inset`、`tint` | 发光玻璃塔冠（塔楼体块交给 buildTower；高度计入塔冠，体块 top 为屋面） |
| `slope` | `drop`、`dir`（**朝高侧**的方位） | 斜屋面（buildTower） |
| `spire` | `offset`、`top`（顶端离地）或 `len` | 避雷针/塔尖 |
| `masts` | `list: [[东,北],…]`、`top`（数或数组）或 `len`、`y`（杆底离地）、`r` | 桅杆若干，顶端障碍灯 |
| `helipad` | `r`、`lift` | 停机坪（直接落在塔楼屋面时用 buildTower 的带支柱版本） |
| `glassCylinder` | `r` 或 `inset`、`h`、`style` | 退进的玻璃圆筒 |
| `disk` | `r`、`h`、`rimH`、`mat`、`glow`、`profile` | 飞碟圆盘 / 薄圆盘屋顶（旋转体） |
| `frame` | `h`、`inset`、`step`、`post`、`mat`、`glow`、`color` | 屋顶通透构架 / 设备屏风 |
| `pyramid` | `h`、`inset`、`spire`、`mat` | 玻璃棱锥 + 可选塔尖 |
| `arch` | `h`（矢高）；`size:[长,跨]`+`at`/`offset`+`rot`，或默认取体块外接矩形（`along:'short'` 换向） | 筒拱：采光中庭、拱形屋面 |
| `dome` | `r` 或 `r:[东西,南北]`、`h`、`at`/`offset`、`mat`、`glow`、`ring`、`rot` | 穹顶；`rot`（度，地图角）把椭圆的第一轴转到该方位（梭形天窗、斜放的椭圆顶；此时建议 `ring:false`） |
| `hip` | `size:[长,宽]`+`at`/`offset`+`rot`（或默认取体块顶部外接矩形）、`over` 出檐、`eave` 檐口厚、`h` 坡高、`ridge` 正脊长（默认 长−宽，四面等坡）、`flat`∈(0,1) 截顶比例（盝顶，顶部平台）、`lift`、`mat`、`eaveMat`、`soffit`、`glow`（檐口夜间线灯） | 四坡顶 / 庑殿顶 / 盝顶 + 出檐（行政中心、北站等“大屋顶”）。屋面类：多个 `hip` 可叠在同一体块上，L/U 形楼按每个臂一个矩形，坡面在转角自然相交；`stack:true` 才抬游标 |
| `sawtooth` | `size`+`at`+`rot`（或外接矩形）、`n` 齿数、`h` 齿高、`face` 采光面朝向（默认北）、`mat`、`glass`（可带 `glow`） | 锯齿形天窗屋面（老厂房），齿沿 `size[0]` 方向排列 |
| `crane` | `at`/`offset`、`from`（塔身底，离地米，默认 0）、`top`（塔身顶离地）或 `h`（高出体块顶，默认 30）、`beacon:false`、`jib` 吊臂长、`counter` 配重臂长、`rot` 吊臂方位 | 在建塔楼的塔吊（黄色塔身 + 吊臂 + 障碍灯） |
| `dome` | `r` 或 `r:[东西,南北]`、`h`、`at`/`offset`、`mat`、`glow`、`ring` | 穹顶 |
| `cnhip` | `style`（`'wudian'` 庑殿 / `'xieshan'` 歇山 / `'zanjian'` 攒尖；正方平面默认攒尖）、`h`（屋面矢高）、`ov`（出檐，默认 1.2）、`lift`（檐角起翘）、`fascia`（封檐板厚）、`xk`（歇山山花高度比，默认 0.45）、`mat`（默认深灰筒瓦 roofTile）、`eaveMat`、`gableMat`、`ridgeMat`、`chiwei:false`、`finialMat`；`size:[长,宽]`+`at`/`offset`+`rot`，或默认取体块顶面外接矩形（`along:'short'` 换向） | 中式大屋顶（直坡面 + 正脊/鸱吻或宝顶）；放在 tower 体块上时女儿墙自动压到 0.2 m |
| `eave` | `ov`（外挑，默认 1.8）、`depth`（向内，默认 2.5）、`h`（坡高，默认 1.6）、`fascia`、`mat`、`eaveMat`、`y` | 沿体块轮廓一圈的斜坡披檐（重檐的下檐、仿古街区檐口、挑檐）；任意多边形可用 |
| `slab` | `ov`（外扩，默认 1.5）、`h`（厚，默认 0.8）、`mat`、`glow`（檐口夜间发光带） | 挑檐平板：大出挑薄屋檐、亭式平顶、帽檐 |

叠放规则：`glassCylinder / disk / frame / pyramid / lantern / parapet / hip / slab` 是**体量类**，会把高度游标抬到自己顶上，后面的塔冠叠在其上；
`dome / arch / masts / spire / helipad / eave` 是**屋面类**，不抬游标（`stack:true` 可强制）。任何塔冠都可用 `y`（离地米）显式指定起点。

中式屋顶的常见写法（`src/arch/dossier-specs/core.js` 有实例）：
- 单檐歇山顶：`crown: [{ type: 'hip', style: 'xieshan', ov: 1.6, h: 4.2 }]`（钟楼邮局两端、时代盛典裙楼亭）；
- 重檐：墙身体块 `crown: [{ type: 'eave', ov: 2.4, depth: 3.5, h: 2 }]` + 上一层小体块（`base` = 下层 `top`）`crown: [{ type: 'hip', … }]`（中环广场角楼、省政府屋顶楼阁）；
- 仿古街区的檐口：`crown: [{ type: 'eave', … }]`；大出挑平屋檐 / 亭式平顶：`{ type: 'slab', ov: 3, h: 1.2, glow: '#ffd08a' }`（希尔顿、钟楼饭店塔屋、皇城海航角亭）。
需要挂招牌或有明确层数的顶部体量（如信息大厦的玻璃圆筒）建议写成一个 **part**（`base` = 下层 `top`），而不是塔冠。

材质名：`stone`、`white`、`dark`、`metal`、`parapet`、`glassRoof`、`roof`、`granite`、`membrane`，或 `'#rrggbb'`，或 `{color, roughness, metalness, glow}`。

### 3.7 放样、斜交网格、在建楼（高新区示例，`src/arch/dossier-specs/gaoxin.js`）

- **放样 `topPts`**：`kind:'tower'` 且带 `topPts` 时不走 buildTower，而是 `buildLoft`：底面 → 顶面直纹幕墙 + 女儿墙 + 屋面（+ 设备盒、障碍灯），
  塔冠（`lantern` / `parapet` / `frame` / `helipad` …）接在顶面轮廓上；`kind:'facade'` 也支持 `topPts`。招牌、灯带按插值后的轮廓贴。
  注意：`fb.ring` 以底边长判断退化边（< 0.05 m 跳过），所以“从 0 开始长大的切角”底面切角写 0.2 m 而不是 0。
  ```js
  // 绿地中心 A 座：72 m 以上西南角切角由 0.2 m 线性长到屋面 12 m
  { name: 'body', pts: cutRect(x0, x1, zN, zS, 'SW', 0.2), topPts: cutRect(x0, x1, zN, zS, 'SW', 12), base: 72, top: 261,
    style: { pattern: 'media' }, crown: [{ type: 'lantern', h: 9 }] }
  ```
- **斜交网格 `kind:'lattice'`**：沿轮廓各边生成菱形斜杆 + 上下环梁 + 转角立柱；`lattice: { step 斜杆水平间距, rise 每格高, w 杆宽, open:[不做的边下标], rings }`，
  材质 `mat`。迈科中心连桥下的古铜色门洞：`{ kind:'lattice', pts: 四边形, base: 0, top: 96, lattice: { step: 7, rise: 9, w: 0.9, open: [0, 2] } }`。
- **在建/停工**：立面 `pattern:'openFrame'`（裸露楼板与柱），塔冠 `{ type:'crane', offset, top, jib, rot }`；按现状高度建，不按设计全高。

---

## 4. 示例（节选自 demo.js）

```js
// 陕西信息大厦：圆柱玻璃塔身 + 西北/东南两道贯通石材端墙 + 退进玻璃圆筒 + 薄圆盘 + 停机坪 + 双桅杆
const XX = -654.3, XZ = 3174.4, XR = 21.4; // OSM 轮廓圆弧点最小二乘拟合
export default [{
  id: 'xinxi', name: '陕西信息大厦', center: [XX, XZ],
  parts: [
    { name: 'plinth', shape: 'circle', size: [2 * XR + 1, 2 * XR + 1], at: [XX, XZ], base: 0, top: 26,
      style: { pattern: 'stoneWindows', spd: '#e3dccd', tint: '#34414b' }, roof: { mech: false } },
    { name: 'body', shape: 'circle', size: [2 * XR, 2 * XR], at: [XX, XZ], base: 26, top: 180,
      style: { pattern: 'horizontalBands', tint: '#23507e', spd: '#e6e6e6', floorH: 3.6 }, roof: { mech: false } },
    { name: 'fins', kind: 'solid', mat: '#ebe8e1', shape: 'rect', size: [59, 5.4], at: [XX, XZ], rot: -45, base: 0, top: 190 },
    { name: 'drum', shape: 'circle', size: [2 * XR - 5, 2 * XR - 5], at: [XX, XZ], base: 180.8, top: 194,
      style: { pattern: 'curtain', tint: '#2e5d8c' }, roof: { mech: false },
      crown: [{ type: 'disk', r: XR - 0.4, h: 1.8 }, { type: 'helipad', r: 11 },
              { type: 'masts', y: 190, list: [[-14.1, 14.1], [14.1, -14.1]], top: 228 }] },
    { name: 'crowne', kind: 'podium', fp: '60562511', top: 24, style: { pattern: 'stoneWindows' }, roofMat: '#6f8a5b' },
  ],
  signs: [{ text: '中信银行', part: 'drum', face: ['N', 'SW'], y: 190.6, h: 3.2, color: '#c8102e' }],
  night: { floodlight: [{ part: 'body', color: '#3f7dff', strength: 0.32 }] },
  supersede: { keys: ['xinxi'], names: ['陕西信息大厦', '西安皇冠假日酒店'] },
  meta: { dossier: 'core_south.json#陕西信息大厦（西安皇冠假日酒店）', sources: [...], photos: [...], confidence: 'high',
          notes: '228 m 按桅杆顶处理……分段高度按照片比例估算……' },
}];
```

商场 + 屋面塔楼（大明宫万达）：裙房 `kind:'podium'` 用 fp 轮廓，塔冠放 `arch`（采光中轴）+ 两个 `dome`；
塔楼用 `shape:'rect'` + `at`（卫星量取、已按倾斜改正），`base: 0`（从地面起，裙房内部被遮住）。
商场 + 塔楼分体（SKP）：塔楼直接用轮廓内的 OSM 分体 `fp`；首层橱窗用 `kind:'facade'` + `grow:0.15` 的罩面。

---

## 5. 替代旧定义（supersede）

dossier 模块在 prepare 阶段（注册在 roads 之后、所有地标模块之前）登记：

```js
ctx.superseded = { names: Set, keys: Set, polys: [落地体块与 site 轮廓…], by: [spec id…] }
```
并为每个落地体块加排除区（`buildings`/`trees` 让位，外扩 `clearance`）。被替代的判定（`isSuperseded(ctx, s)`）：

1. `s.key ∈ supersede.keys` —— sky-data.js / sky-data2.js 的 key（如 `xinxi`、`dmgwd`、`saige`、`mixc`），以及 SPECIAL/SPECIAL2 特殊地标键：
   `tv igc1 changan aoti north conf expo gov w hyatt rainbow butterfly houhai`；
2. `s.name`（或 skyline.json 的 `n`）∈ spec.name ∪ `supersede.names` —— landmarks2026 的 `name`、skyline.json 通用高层名称；
3. `s` 的质心（`pts`/`outer` 轮廓质心，或 `x,z`）落在档案建筑的**落地轮廓**内。

所以：**同一地块上的旧模型通常靠第 3 条自动消失**；名称/键名写上是为了保险和可追溯。写 supersede 前在这些地方查旧定义：
`src/arch/sky-data.js`、`src/arch/sky-data2.js`（key）、`public/data/landmarks2026.json`（towers/malls 的 name）、
`public/data/skyline.json`（features 的 n）、`src/modules/skyline.js` 的 SPECIAL 调用。

注意：
- 被替代的 SPECIAL 特殊地标只跳过构建，它原来的排除区仍保留（不影响档案模型）。
- 通用建筑（buildings.bin）靠排除区让位：质心落在档案轮廓外扩 2.5 m 内的通用楼块都不再生成。若档案只建了综合体的一部分，
  其余部分要么也写成 part，要么别让排除区盖住（`clearance` 调小、不写 `site`）。
- 其他模块（heritage、qujiang 等）要支持替代，可 `import { isSuperseded } from '../arch/dossier-kit.js'` 在自己的 prepare/build 里过滤。

---

## 6. 小工具

- 轮廓：`python3 tools/build_dossier_fp.py [--show <id 前缀> …]`（打印世界坐标轮廓与元数据；worktree 缺 `data-src/` 时自动读主仓库）。
- 附近 Overture 楼块（找塔楼分体、看 OSM 编号）：参考 `tools/build_dossier_fp.py` 的读法，或直接用 shapely 按 bbox 过滤。
- 卫星 + 轮廓叠图：`research/refs/skyline/satcheck.py 名称 cx cz 半宽 [zoom]`（Esri 影像 + 100 m 网格）。
- 夜景/白天截图：见 §7。

## 7. 验证

```bash
npx vite build
node tools/shot.mjs --wait 900 --frames 30 --w 1400 --h 900 \
  --shot "modules=water,landuse,roads,dossier,skyline,buildings&time=15&online=0&cam=-930,95,3560,-654,110,3174|shots/dossier_xinxi.png"
# cam=x,离地高,z,目标x,目标离地高,目标z（世界坐标）；time=21 看夜景
```
截图后用 Read 打开截图与档案照片逐项对照（形体、层数、塔冠、立面颜色/分格、招牌位置与颜色、夜景），把差异写进
`research/refs/dossiers/model_log.md`（格式见该文件），能修的立刻修，修不了的写明原因。控制台出现 `[dossier] 解析失败/构建失败` 必须处理。
