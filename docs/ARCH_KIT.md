# 中式古建程序化构件库（ARCH_KIT）

供城墙城楼、钟鼓楼、大雁塔寺院、大唐不夜城、大唐芙蓉园、小雁塔等模块共用。全部程序化几何 + Canvas 纹理，按材质合并，
近景看得清斗拱、瓦垄、脊兽、栏杆、门窗格心，远景只保留轮廓。

- 统一入口：`src/arch/chinese.js`（组合器、夜景、构建/LOD 工具，并转出下列子模块的全部构件）
- `chinese-core.js`：`ArchBuilder`（几何累加器）、材质库 `getKit`、`floodlit`、`palette`/`STYLES`/`ROOF_COLORS`、`stats`
- `chinese-roof.js`：`roof()`（庑殿/歇山/攒尖/悬山/硬山/卷棚/腰檐 band）
- `chinese-wood.js`：柱、额枋、斗拱层、雀替、柱网环
- `chinese-wall.js`：隔扇门/槛窗/直棂窗/板门/墙/券门、城台、院墙
- `chinese-base.js`：台基（须弥座）、踏跺、栏杆、灯笼、灯笼串、石狮
- 测试场：`src/modules/dev/archtest.js`（`?modules=archtest`），截图在 `shots/archtest/`
- 不要用 `src/arch/traditional.js` / `shared.js`（外部粗糙版本）

---

## 1. 坐标约定（全库统一）

| 项目 | 约定 |
|---|---|
| 单位 | 米；Y 向上 |
| 局部原点 | 建筑平面中心、台基**底面**（地面）高度 y=0；`o.y0` 可整体抬高（如城楼放在城台顶） |
| 朝向 | **正面朝 +Z**（西安世界 +Z = 南，坐北朝南的建筑不用旋转）；面阔沿 X，进深沿 Z |
| 旋转 | `group.rotation.y = θ` 后正面朝 `(sin θ, 0, cos θ)`：朝南 0，朝东 `+π/2`，朝北 `π`，朝西 `-π/2` |
| 间（bay） | 柱中线到柱中线；`bays` 可给间数（明间最宽、梢/尽间递减）或各间宽数组（西→东） |
| 世界放置 | `g.position.set(x, ctx.terrain.heightAt(x,z) 或压平高度, z)`；构件内部 y 均为相对量 |

构件级函数（`roof`、`balustrade` 等）使用 **builder 当前变换**下的局部坐标：
`b.push(x, y, z, rotY)` … `b.pop()` 可在同一 builder 里摆多座建筑（合批的关键）。

---

## 2. 快速上手

```js
import * as THREE from 'three';
import { buildArch, buildLOD, hall, multiStoreyTower, gateTower, pavilion, paifang, corridor,
         balustrade, lantern, lanternString, eaveLights, ArchBuilder, stats } from '../arch/chinese.js';

export default {
  id: 'mytemple', name: '示例寺院',
  prepare(ctx) {
    const c = ctx.geo.project(108.9594, 34.2198);
    this.flat = ctx.terrain.addFlatten({ points: [c.x-60,c.z-60, c.x+60,c.z-60, c.x+60,c.z+60, c.x-60,c.z+60], height: null, feather: 20 });
    ctx.exclusions.add({ rect: [c.x-60, c.z-60, c.x+60, c.z+60] }, { buildings: true, trees: true });
  },
  async build(ctx) {
    const c = ctx.geo.project(108.9594, 34.2198);
    const y = this.flat ?? ctx.terrain.heightAt(c.x, c.z);
    // ① 单座建筑 + 三级 LOD（近 detail2 / 160m 起 detail1 / 550m 起 detail0）
    const hallObj = buildLOD(ctx, (b) => hall(b, {
      style: 'ming', bays: 5, bayW: 5, centerW: 6, depthBays: 4, colH: 6, eaves: 2, roof: 'xieshan',
      roofColor: 'yellow', platform: 'sumeru', platformH: 1.6, railing: true, plaque: '大雄寶殿',
    }), { style: 'ming', flood: { color: 0xffc47a, strength: 1.4, baseY: y + 1.6, height: 24 } });
    hallObj.position.set(c.x, y, c.z);          // 坐北朝南：不旋转
    ctx.scene.add(hallObj);
    // ② 多座小建筑合进一个 builder（整条街 ≈ 10~12 个 draw call）
    const g = buildArch(ctx, (b) => {
      for (let i = 0; i < 10; i++) {
        b.push(-40 + i * 9, 0, 30, Math.PI / 2);   // 朝东
        hall(b, { style: 'tang', bays: 3, bayW: 3.2, depthBays: 2, colH: 3.6, roof: 'xieshan', front: 'tangshop', lanterns: true });
        b.pop();
      }
    }, { style: 'tang', instancing: true, detail: 1 });
    g.position.set(c.x, y, c.z);
    ctx.scene.add(g);
    // ③ 灯笼的真实点光（少量）：builder 收集的锚点
    for (const L of g.userData.lights) ctx.lights.add({ position: new THREE.Vector3(...L.position).add(g.position), color: L.color, intensity: L.intensity, distance: L.distance, nightOnly: true });
    return {};
  },
};
```

---

## 3. 构建工具

### `buildArch(ctx, fn, o?) → THREE.Group`
新建 `ArchBuilder`，调用 `fn(b)` 建模，`b.build()` 输出合并好的 Group。`group.userData.info` = fn 的返回值（尺寸、檐口高度等），
`group.userData.lights` = 灯笼等收集的点光锚点。
- `o.detail`：0/1/2（默认 2）。2 = 近景全细节（筒瓦几何、瓦当滴水、飞椽、斗拱各分件、隔扇抹头、望柱栏板）；
  1 = 中景（瓦垄画进贴图、斗拱简化、门窗面片）；0 = 远景（只保留轮廓：台基、柱、墙、屋面、正脊）。
- `o.style`：'tang' | 'ming'（组合器未显式给 style 时的默认）
- `o.instancing`：true 时重复构件（斗拱、瓦当、望柱、灯笼……）数量 ≥ 12 时用 `InstancedMesh`（跨多座建筑合批时推荐）；默认 false = 烘焙合并
- `o.flood`：泛光配置（同 `floodlit`），会克隆非发光材质注入泛光着色
- `o.castShadow`（默认 true）、`o.name`

### `buildLOD(ctx, fn, o?) → THREE.LOD`
`o.levels`（默认 `[[2,0],[1,160],[0,550]]`，即 `[detail, 起始距离]`）每级各调一次 `fn`，three 自动按相机距离切换。
`fn` 会被调用多次，**不要在 fn 里注册灯光等副作用**。`lod.userData.info` 为第一级的 info。

### `new ArchBuilder(ctx, {detail, style, instancing, minInstances=12, name})`
- `b.push(x, y, z, rotY, s=1)` / `b.pop()` / `b.at(x, y, z, rotY, fn)`：变换栈
- 基本几何（`mk` = 材质键，`col` = 0xRRGGBB 顶点色）：`b.box(mk,x0,y0,z0,x1,y1,z1,col,{skip})`、`b.boxC(mk,cx,cy,cz,sx,sy,sz,col)`、
  `b.cyl(mk,cx,y0,cz,r0,r1,h,seg,col)`、`b.frustum(...)`、`b.lathe(mk,prof,seg,col,cx,cz)`、`b.prism(mk,poly,axis,d0,d1,col)`、
  `b.sweep(mk,path,prof,col)`、`b.quad(mk,a,b,c,d,col)`、`b.geometry(mk, BufferGeometry, col, matrix)`
- `b.proto(key, factory, tint)`：放置一个可复用原型（同 key 只建一次，自动实例化/烘焙）
- `b.plaque(text, cx, cy, cz, w, h, {vertical, bg, color, border, serif})`：匾额（全部匾额共用一张图集，1 个 draw call）
- `b.led(points, {color, width=0.06, closed})`：沿折线的 LED 灯条
- `b.lightAnchors`：`{position:[x,y,z], color, intensity, distance}`（局部坐标）
- `b.build({flood, castShadow, receiveShadow, materials:{键: 自定义材质}})` → Group（每个材质 1 个 Mesh）

材质键（全部 vertexColors，共享于 `getKit(ctx)`）：
`tile`（近景屋面，筒瓦用几何）、`tileFlat`（中远景屋面，瓦垄画进贴图）、`ridge`（屋脊/吻兽/走兽）、`paint`（油饰木构）、
`caihua`（彩画枋）、`stone`（台基/栏杆/石狮）、`brick`（城砖/青砖）、`plaster`（白墙/红墙）、`lattice`（窗棂，alphaTest 透空）、
`glow`（窗纸/室内，夜间暖光）、`emit`（灯笼/宫灯，夜间发光）、`led`（轮廓灯条，白天暗色灯具外壳）、`metal`（宝顶/门钉）。
夜间系数由 `ctx.night` 自动驱动：glow 0→1.5、emit 0.03→2.4、led 0→2.2。

### `stats(obj) → {tris, meshes, materials}`
统计三角形 / 网格 / 材质数（自测用，InstancedMesh 按实例数计）。

---

## 4. 风格与配色

- `style: 'tang'`（唐风：佛光寺东大殿式。屋面平缓 pitch≈0.46、出檐深远、雄大斗拱（≈0.4 柱高，出跳≈斗拱高）、每间 1 朵补间、
  鸱尾、七朱八白阑额、朱柱白壁、直棂窗、板门；灰/深灰瓦）
- `style: 'ming'`（明清官式：陡峻 pitch≈0.66、举折下凹明显、斗拱细密（≈0.2 柱高，攒档 11 斗口）、吻兽 + 走兽、
  旋子/和玺彩画、朱柱红墙、隔扇槛窗、须弥座汉白玉栏杆）
- `STYLES[style]`：`{pitch, k0f(举折下凹), ovK(出檐/柱高), lift(翼角起翘), flare(翼角冲出), sheng(生起), bracketK, ridgeK, ornament}`
- `palette(style, 覆盖)`：木构配色 `{col 柱, colBase 柱础, wall 墙, frame 门窗框, door, lattice, dou 斗, gong 拱, ang 昂, armEnd, panel 栱眼壁,
  rafter, rafterEnd, flyEnd, soffit, fascia, stone, gable, boFeng, railing, ...}`；组合器用 `o.pal` 传覆盖，如 `pal: { col: 0x8a1f16 }`
- `roofColor`：`'gray'`（青灰瓦）| `'darkgray'`（深灰，唐风/城楼）| `'green'`（绿琉璃）| `'yellow'`（黄琉璃）| `'blue'` | `'black'`，
  或 `{tile, tube, ridge, glazed}` 自定义

---

## 5. 组合器（推荐直接用）

所有组合器签名 `fn(b, o) → info`，写入 builder `b`，在 `buildArch`/`buildLOD` 的回调里调用。通用返回 info：
`{w, d（含台基的外廓）, W, D（柱网面阔/进深）, platformTop, colTop, eaveY（最下一层檐口高）, topY（最高点）,
roofs:[roofInfo...], columns:[[x,z,y0,y1,D]...], footprint:[[x,z]...], plaqueY, frontRing}`。

### 5.1 `hall(b, o)` 殿堂（单檐 / 重檐）
| 参数 | 默认 | 说明 |
|---|---|---|
| `style` | builder 的 style | 'tang' / 'ming' |
| `bays` | 5 | 面阔间数或各间宽数组 |
| `bayW` / `centerW` / `endW` | 4.5 / bayW×1.2 / bayW×0.9 | 次间宽 / 明间宽 / 尽间宽 |
| `depthBays` / `depthW` | 3（重檐 4）/ bayW×0.95 | 进深间数 / 间宽 |
| `colH` | 明间宽×1.05（3.2~9） | 檐柱高 |
| `eaves` | 1 | 2 = 重檐（外圈副阶周匝 + 殿身金柱升高 + 下檐 band） |
| `roof` | 'xieshan' | 'xieshan' / 'wudian' / 'xuanshan' / 'yingshan' / 'juanpeng' |
| `roofColor` | 'gray' | 见第 4 节 |
| `platform` / `platformH` / `platformMargin` | 唐 'brick' 1.0 / 明 'sumeru' 1.4 / 自动 | 'sumeru' / 'plain' / 'brick' / 'none' |
| `steps` / `stepW` / `stepsYulu` | 'front' / 明间×0.85 / 0 | 'front' / 'frontback' / 'all' / 'none'；御路宽 |
| `railing` / `railingKind` | false / 明 'stone' 唐 'wood' | 台基栏杆（自动在踏跺处留口） |
| `front` / `back` / `sides` | 唐 'tang' 明 'center3' / 'wall' / 'wall' | 门窗方案（见下） |
| `plaque` / `plaqueVertical` | — / 明 true 唐 false | 匾额文字（繁体原文可） |
| `lanterns` / `lanternKind` / `lanternSize` | false / 'round' | 檐下每间挂灯笼（夜间发光） |
| `eaveLights` | false | true 或 `{color, width, columns, colSides}`：LED 轮廓灯 |
| `rich` | false | 大额枋金龙和玺（太和殿式） |
| `carve` | — | 隔扇裙板金饰颜色 |
| `pattern` | 唐 1 明 0 | 窗棂 0 方格 / 1 直棂 / 2 菱花 / 3 步步锦 |
| `bracketH` / `perBay` | 自动 | 斗拱高 / 每间补间朵数 |
| `beasts` / `ornament` | 按规模 / 唐 'chiwei' 明 'wen' | 走兽数 / 'chiwei' 鸱尾 'wen' 吻兽 'none' |
| `pal` / `wallColor` | — | 配色覆盖 |
| `y0` | 0 | 台基底高 |

门窗方案（`front/back/sides`，也可给每间类型数组，如 `['wall','kanchuang','geshan','kanchuang','wall']`）：
`'center3'`（中三间隔扇、其余槛窗）、`'center1'`、`'doors'`（全隔扇）、`'windows'`（全槛窗）、`'wall'`、`'open'`（敞开）、
`'tang'`（明间板门、余直棂窗）、`'tangshop'`（仿唐商铺：中间隔扇、两侧直棂窗）、`'gate'`（明间板门、余墙）、`'arch'`（券门）、`'zhiling'`。
单间类型：`'geshan' | 'kanchuang' | 'zhiling' | 'banmen' | 'wall' | 'arch' | 'open'`。

### 5.2 `multiStoreyTower(b, o)`（别名 `pavilionTower`）楼阁：钟鼓楼、城楼、阁
每层 = 柱 + 额枋 + 斗拱 + 门窗；层间 = 腰檐（band）+ 平座（平座斗拱、楼板、寻杖栏杆）；顶 = 屋顶（可重檐）。
| 参数 | 默认 | 说明 |
|---|---|---|
| `storeys` | — | `[{bays, depthBays, bayW, depthW, colH, front, back, sides, veranda, brackets, apothem, perSide}]` 逐层；不给 bays 则沿用下层内圈 |
| `floors` + `bays/depthBays/bayW/colH` | 2 / 3 / 3 / 4.2 / 4.2 | 统一各层 |
| `shrink` | 0.6 | 每层每边内收 |
| `pingzuo` / `balcony` / `balconyRail` | true / 1.4 / 'wood' | 平座、挑出宽 |
| `roof` / `topEaves` | 'xieshan'（多边形 'zanjian'）/ 1 | 顶层屋顶；2 = 顶层重檐 |
| `sides` | 4 | 6/8 = 多边形楼阁（`apothem` 默认 6，`perSide` 每边间数） |
| `finial` | — | 攒尖宝顶 `{h, gold:true}` |
| 其他 | | `platform/platformH/steps/railing/style/roofColor/pal/plaque/plaqueVertical/lanterns/eaveLights/y0/pitch` 同 hall |
钟楼式（三重檐四角攒尖）= 首层 `veranda:true` 的腰檐 + 顶层 `topEaves:2, roof:'zanjian'`，见测试场 `bellTower`。

### 5.3 `gateTower(b, o)` 城门楼 = 城台（砖砌、收分、券洞、垛口）+ 城楼
`o: {w=40, d=22, h=12, tunnels=1|3, tw, th, spacing, crenel=true, innerSide=['back'], batter, wallColor, style='ming', roofColor='darkgray', plaque,
tower:{…multiStoreyTower 覆盖} | hall:{…hall 参数} | arrow:{…arrowTower 参数}}`。
默认城楼 = 西安城楼式：面阔七间、首层回廊、二层平座、重檐歇山（三滴水）。返回 `{...towerInfo, platformTopY, cityPlatform, w, d, h}`。

### 5.4 `arrowTower(b, o)` 箭楼
砖砌楼身 + 多层箭窗 + 前出抱厦 + 歇山灰瓦顶。`o: {w=34, d=14, h=15, rows=4, cols=12, sideCols=4, baosha=true, roofColor='darkgray', style, y0, plaque}`。

### 5.5 `pavilion(b, o)` 亭
`o: {sides=8（4 方亭 / 6 / 8 / 0 圆亭）, size=6（对边距）, colH, eaves=1|2, roof（默认攒尖；方亭可 'xieshan'）, seats=true（美人靠）,
brackets（唐默认 true）, platformH=0.6, style, roofColor, finial, lanterns, eaveLights, y0}`。

### 5.6 `paifang(b, o)` 牌坊 / 牌楼
`o: {bays=3（1/3/5）, width, h（明间净高）, kind='wood'|'stone', roofs=true, text（明间匾）, sideText=['..','..'], roofColor, style, postW}`。原点 = 中心地面，正面 +Z。

### 5.7 `corridor(b, pts, o)` 游廊 / 回廊
`pts=[[x,z]...]` 廊中心线（局部坐标）；`o: {w=3, colH=3, bay=3.3, roof='juanpeng'|'xuanshan', closed, seats=true, hanging=true（倒挂楣子）, style, roofColor, y0, platformH=0.3}`。

---

## 6. 构件（自定义组合时使用）

| 函数 | 说明 |
|---|---|
| `roof(b, o) → roofInfo` | 屋顶。`type`：'wudian' / 'xieshan' / 'zanjian' / 'xuanshan' / 'yingshan' / 'juanpeng' / 'band'（重檐下檐/腰檐）；`w, d`（柱中线平面）；攒尖 `sides`（3~8，0=圆）；`y`（柱中线处瓦面高）；`overhang`（出檐）；`pitch`；`top`（band 上缘距柱中线）；`gableInset`（收山）；`gableOverhang`（出际）；`color`；`style`；`ornament`；`beasts`；`lift/flare/sheng`；`underside:'eave'|'full'`；`finial`；`ridgeH`；`noRidge`。返回 `{ridgeY, topY, eaveY, eaveLines, ridgeLines, bandTopY}`。含举折曲面、翼角起翘冲出、筒瓦垄、瓦当滴水、正脊/垂脊/戗脊、鸱尾/吻兽、仙人走兽、檐椽飞椽、连檐封檐板、望板 |
| `roofYFor(o, bearY, bearOut)` | 由挑檐枋高度推出柱中线处瓦面高 |
| `frameDims(style, colH, o)` | 大木尺度 `{D 柱径, bracketH, proj 出跳, plankH, fangH, fang2H, padH, spacing}` |
| `rectRing(xs, zs)` / `polyRing(N, apothem, perSide)` | 柱网环（sides 顺序：前 +Z、右 +X、后、左） |
| `bayList(n, w, centerW, endW)` / `bayCoords(bays)` | 间宽 / 柱中线坐标 |
| `columns(b, pts, {y0, h, D, style, pal, taper, base})` | 朱柱（收分）+ 柱础 |
| `beam(b, p0, p1, y0, h, t, {mat, row, color, ext})` | 枋（'caihua' 彩画按间展开） |
| `lintelRing(b, ring, colTop, o)` | 檐柱头枋子组合（明清大小额枋+垫板+平板枋；唐阑额+普拍枋），返回斗拱底高 |
| `bracketRing(b, ring, {y, H, style, pal, perBay, kind:'eave'|'pingzuo'})` | 斗拱层（柱头科/平身科/角科、栱眼壁、正心枋、挑檐枋），返回 `{proj, topY, bearY, tip}` |
| `queti(b, x, yTop, z, dir, len, h, o)` | 雀替 |
| `bayFill(b, kind, x0, x1, y0, y1, o)` | 一间门窗墙（格心透光，夜间暖光） |
| `latticePanel` / `glowQuad` / `wallPanel` / `archWall` | 窗棂面 / 透光面 / 墙面（可开洞、下碱）/ 券洞墙 |
| `cityPlatform(b, {w,d,h,tunnels,tw,th,spacing,batter,crenel,parapetH,color})` | 城台（返回 `{topY, topW, topD}`） |
| `yardWall(b, pts, {h, t, color, capColor, closed})` | 院墙（瓦帽） |
| `platform(b, {poly | w,d | sides,apothem, h, kind, color, y0})` | 台基（须弥座六层线脚），返回台面高 |
| `steps(b, {w, h, y0, tread, riser, band, yulu, color})` | 垂带踏跺，自 (0,h,0) 向 +Z 下行 |
| `balustrade(b, pts3d, {kind:'stone'|'wood'|'seat', h, spacing, color, closed, endPosts})` | 沿任意折线（可沿台阶倾斜）的栏杆：望柱 + 栏板（寻杖、荷叶净瓶） |
| `lantern(b, x, y, z, {kind:'round'|'palace', size, color, light})` | 灯笼 / 宫灯（吊点坐标），`light` > 0 时记录点光锚点 |
| `lanternString(b, p0, p1, {n, sag, size, color, kind, cable})` | 悬链灯笼串 |
| `stoneLion(b, x, y0, z, yaw, {h=2.4, color})` | 石狮（含座） |
| `offsetPoly` / `rectPoly` / `ngonPoly` | 平面多边形工具 |

---

## 7. 夜景

1. **泛光** `floodlit(material, {color=0xffc47a, strength=1.6, baseY, height=20, top=0.35, upDim=0.7, ctx})`：
   按世界高度渐变的暖色 emissive（onBeforeCompile，引用 `ctx.uniforms.uNight`）。`baseY` 是灯具所在**世界**高度（台基顶/城台顶），
   朝上的面（屋面）自动减弱，檐下斗拱更亮。一般不直接调，给 `buildArch/buildLOD` 传 `flood:{...}` 即可（自动克隆材质）。
2. **LED 轮廓灯** `eaveLights(b, info, {color=0xffc56a, width=0.07, eaves=true, ridges=true, columns=false, colSides='front'|'all'})`：
   沿檐口、屋脊、柱子的暖金灯条（大唐不夜城/城墙夜景标志）。`info` 为组合器返回值或 `{roofs:[roof() 返回值], columns:[...]}`；
   组合器也可直接传 `eaveLights: true | {...}`。
3. **窗格透光**：所有隔扇/槛窗/直棂窗格心后都有 `glow` 面，夜间随机亮度（`lit` 0~1.5 可指定）。
4. **灯笼**：`emit` 材质自动发光；真实点光只给少数重点灯笼（`lantern(..., {light: 2})` → `group.userData.lights` → `ctx.lights.add`）。

夜景配方（参考照片 `research/refs/arch/*_night.jpg`）：
| 场景 | flood | eaveLights | 其他 |
|---|---|---|---|
| 钟鼓楼 | `{color:0xffe2bc, strength:1.6, baseY:地面, height:40, top:0.55}` | `{color:0xd4ffe6}`（冷白绿） | `lanterns:true, lanternKind:'round'` |
| 城楼 | `{color:0xffc47a, strength:1.4, baseY:地面, height:30}` | 可选 `{color:0xffc56a}` | 城楼 `lanterns:true, lanternKind:'palace'` |
| 大唐不夜城仿唐建筑 | 可不用（靠 LED） | `{columns:true}`（暖金 0xffc56a，檐口+屋脊+柱） | `lanterns:true`、窗格透光 |
| 寺院大殿 | `{color:0xffd8a0, strength:1.2, baseY:台基顶, height:26}` | 不用 | — |
`baseY` 是**世界**高度：模块里通常写 `baseY: 地面y + 台高`；低于 baseY 的部分不被照亮。

---

## 8. 性能与 LOD

- 每个 builder 输出 = 每种材质 1 个 Mesh（+ 匾额图集 1 个 + 实例化原型若干）。**一片建筑群用一个 builder**（push/pop 摆放）→ 10~15 个 draw call。
- 测试场实测（`window.__archtest`，detail=2 / detail=0）：

  | 展品 | detail=2 三角形 | 网格(=draw call) / 材质 | detail=1 | detail=0 |
  |---|---|---|---|---|
  | `mingHall` 五开间重檐歇山（须弥座+栏杆+御路+匾） | 147k | 11 / 11 | 23.7k | 2.5k |
  | `tangHall` 唐风五开间庑殿（+LED 轮廓灯） | 73k | 11 / 11 | 13.1k | 1.7k |
  | `gateTower` 城台三券洞 + 七开间三滴水城楼 | 211k | 12 / 12 | — | — |
  | `bellTower` 砖台 + 三重檐攒尖楼阁 | 249k | 10 / 10 | — | — |

  大型楼阁（城楼、钟楼）请务必用 `buildLOD`：160 m 外切到 detail=1（约 1/6 三角形），550 m 外 detail=0。
  整个测试场（15 组建筑）在 M 系列 Mac 上 60 fps。
- 距离建议：`buildLOD` 默认 `[[2,0],[1,160],[0,550]]`；大量同类小建筑（商业街）建议 `detail:1` + `instancing:true`，
  近处 3~5 座主建筑再单独 `buildLOD`。超过 ~2 km 可直接隐藏 detail 0 以外的装饰组。
- 构建耗时：单座重檐殿三级 LOD ≈ 150~300 ms；整个测试场（15 组）≈ 1.5 s。大建筑群请分帧（`await new Promise(r => setTimeout(r))`）。
- 所有非发光网格默认 `castShadow = true`。

---

## 9. 示例

```js
// 钟楼式：砖台 + 二层楼阁 + 三重檐四角攒尖（绿琉璃）
const g = buildArch(ctx, (b) => {
  const cp = cityPlatform(b, { w: 35.5, d: 35.5, h: 8.6, tunnels: 1, tw: 6, th: 6.2, crenel: false });
  const e = 17.2;
  balustrade(b, [[-e, cp.topY, -e], [e, cp.topY, -e], [e, cp.topY, e], [-e, cp.topY, e]], { kind: 'stone', closed: true });
  return multiStoreyTower(b, {
    y0: cp.topY, style: 'ming', roof: 'zanjian', topEaves: 2, roofColor: 'green', platform: 'plain', platformH: 0.5, steps: 'none',
    storeys: [
      { bays: [3.4, 4.6, 6.4, 4.6, 3.4], depthBays: [3.4, 4.6, 6.4, 4.6, 3.4], colH: 5.8, veranda: true, front: 'center3', back: 'center3', sides: 'center3' },
      { colH: 4.6, front: 'doors', back: 'doors', sides: 'doors' },
    ],
    balcony: 1.6, plaque: '聲聞於天', plaqueVertical: false, finial: { h: 3.2, gold: true },
    lanterns: true, lanternKind: 'round', eaveLights: { color: 0xd4ffe6, width: 0.08 },   // 夜景：红灯笼 + 冷白绿 LED 勾边
  });
}, { style: 'ming', flood: { color: 0xffe2bc, strength: 1.6, baseY: y, height: 40, top: 0.55 } });   // baseY=地面：砖台也被照亮

// 城楼（永宁门式）：城台三券洞 + 七开间重檐歇山城楼
buildArch(ctx, (b) => gateTower(b, { w: 52, d: 22, h: 11, tunnels: 3, tw: 5.5, th: 7.4, spacing: 13, plaque: '永寧門',
  tower: { lanterns: true, lanternKind: 'palace' } }), { flood: { baseY: y + 11, height: 30 } });

// 唐风五开间庑殿（佛光寺东大殿式）+ LED 轮廓灯
buildLOD(ctx, (b) => hall(b, { style: 'tang', bays: 5, bayW: 5, depthBays: 4, depthW: 4.4, colH: 5, roof: 'wudian',
  roofColor: 'darkgray', front: 'tang', sides: 'zhiling', eaveLights: { columns: true } }), { style: 'tang' });

// 仿唐商铺（大唐不夜城）：一个 builder 摆一排，朝西（面向步行街）
buildArch(ctx, (b) => {
  for (let i = 0; i < 12; i++) b.at(0, 0, i * 16, -Math.PI / 2, () => hall(b, { style: 'tang', bays: 3, bayW: 4.2, depthBays: 2,
    colH: 4.2, roof: 'xieshan', front: 'tangshop', sides: 'wall', platform: 'plain', platformH: 0.45, plaque: '長安酒肆',
    lanterns: true, eaveLights: { columns: true } }));
}, { style: 'tang', instancing: true, detail: 1 });

// 八角重檐亭、牌坊、廊、灯笼串
buildArch(ctx, (b) => {
  pavilion(b, { sides: 8, size: 7, colH: 3.6, eaves: 2, roofColor: 'gray' });
  b.at(0, 0, 30, 0, () => paifang(b, { bays: 3, width: 16, h: 6.5, text: '大唐不夜城', sideText: ['盛世', '華章'], roofColor: 'yellow' }));
  corridor(b, [[20, 0], [60, 0], [60, -30]], { w: 3, roof: 'juanpeng' });
  lanternString(b, [-10, 5.8, 40], [10, 5.8, 40], { n: 8, sag: 0.8, size: 0.7 });
});
```
