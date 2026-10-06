#!/usr/bin/env python3
"""西安全城地标批量精建：调研清单 → 轮廓对位 → 渲染规格 public/data/landmarks2026.json

输入：
  research/refs/landmarks2026/{towers,malls,venues,heritage}.json   联网调研的地标清单（名称/坐标/高度/层数/造型/立面/塔冠/招牌/夜景）
  data-src/amap/places.json（可选）  tools/amap_fetch.py place 用高德关键字搜索逐个定位的坐标（有精确同名结果时优先）
  public/data/skyline.json            OSM 高层轮廓与实测高度
  data-src/overture/building.parquet  Overture 2026-09 建筑轮廓（含 OSM 名称）
输出（世界坐标，渲染端见 src/modules/skyline.js 与 src/modules/landmarks26.js）：
  towers  —— buildTower 规格（高度/塔冠/立面/楼顶字/裙房）
  malls   —— buildPodium 规格（商场、场馆、站房；体育场为带内场洞的环形看台）
  heritage—— 古建院落（主体建筑按中轴排布，交给中式建筑套件）
  labels  —— 公园/校园等只做标注的地标
已精建（already_modeled）的条目跳过；渲染端还会跳过落在已有精建轮廓/排除区内的条目。

用法：python tools/build_landmarks2026.py [--report]
      python tools/build_landmarks2026.py --relayout-heritage   # 只重排已生成文件里的古建院落（防重叠）
"""
import argparse
import json
import math
import re
import sys
import zlib
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geo import project  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / 'research' / 'refs' / 'landmarks2026'
OUT = ROOT / 'public' / 'data' / 'landmarks2026.json'
MAX_R = 47000  # 与 skyline 通用高层同样的范围限制


# ───────────── 坐标/高度覆盖表（tools/check_coords.py 审计 + research/refs/dossiers/*.json 逐栋档案；调研清单原值保留，在此覆盖） ─────────────
# 键：调研清单中的 name。字段：
#   lon/lat（WGS-84）或 xz（世界坐标）新位置；rid 强制使用的 OSM 轮廓（Overture record_id 去掉 @ 版本）；
#   rect=[长, 宽, 转角°]（按此尺寸合成轮廓、不去对位现有轮廓；转角按 G.rect 约定：+x 转向 +z 为正）；
#   h 新高度；skip 不生成（已精建 / 已拆 / 停业 / 不是高层 / 另有表达）；sign_text / sign_color 商场招牌；note 依据
DOSSIER = 'research/refs/dossiers/'
OVERRIDE = {
    # —— 塔楼 ——
    '西安浐灞凯悦酒店（欧亚国际三期商业4号楼）': dict(
        lon=109.01254, lat=34.33135, skip=True,
        note='place.parquet 原值 109.0175,34.33 为 GCJ-02（比纠偏值正好东 454 m、南 152 m）；纠偏后落在 sky-data2 SPECIAL2.hyatt'
             '（6458,−7833）“叠石”精建上，与 chanba/notes.md“欧亚大道×浐河西路西南角”一致；原先按错误坐标在浐河东岸重复生成了一栋'),
    '招商局丝路中心 北塔': dict(
        note='144 m/31F 有设计方出处；位置未定：双寨站旁 OSM 两个候选方形轮廓 w1381177356/57 东西并列，与“南北对称”描述不符'
             f'（{DOSSIER}east_west.json），保持调研推测坐标，待影像核对'),
    '招商局丝路中心 南塔': dict(note='同北塔：坐标未定，保持推测；原先“就近”对上的 385 m² 小楼轮廓已由塔楼平面合理性检查排除，改为合成'),
    '西安安达仕酒店（迈科）': dict(
        xz=(-6632, 7648), h=85,
        note='设计 247.4 m/50F，但 2022-05 主体约 20 层后停滞（腾讯 2023；高楼迷 2024-04 仍记停工），按 20F×4.2 m 取 85 m 现状高度；'
             f'位置取 CTBUH 坐标（宗地：锦业一路以南、丈八三路以西、锦业五街以东；{DOSSIER}gaoxin.json）'),
    '秦商国际中心（天朗·秦商国际总部大厦）1号楼': dict(
        xz=(-5794, 7521), rect=[52.65, 34.3, 0], h=217,
        note='CTBUH 217 m/50F；楼书：丈八一路与锦业一路十字西北角地块东侧、标准层 52.65×34.3 m；OSM w1387164542（87×31 m，被标成'
             f'“永利 212 m”）正落在该地块，塔楼放在其东段（原推测点 (−5930,7497) 偏西约 130 m；{DOSSIER}gaoxin.json）'),
    '泰信大厦': dict(
        xz=(-5904, 7654), h=214,
        note=f'CTBUH 坐标（锦业一路 6 号、永利西侧）214 m/37F（199.9 m 屋面 + 塔冠）；原推测点对上的是中投国际综合体（{DOSSIER}gaoxin.json）'),
    # 曲江文创中心双塔：澎湃新闻 / 网易楼盘资料为“雁翔路与南三环交汇处东南角”、占地 67 亩（约 4.5 ha，边长约 210 m），
    # 调研坐标为估计值，落在路口东南 550–650 m 外的住宅楼上（model_log_landmarks2.md 第 5 节）；错位的 238 m 超高层比缺失更显眼，
    # 先不生成，待按雁翔路—南三环东南角地块（卫星可见在建塔楼）与现状照片重建
    '曲江文创中心1#楼': dict(skip=True, note='位置错误（估计坐标落在住宅区），待按雁翔路—南三环东南角地块重建'),
    '曲江文创中心2#楼': dict(skip=True, note='同上'),
    '西安皇冠假日酒店': dict(skip=True, note='皇冠假日即陕西信息大厦裙楼内的酒店（core_south.json），信息大厦已精建，不再单列一栋 80 m 楼'),
    '长安国际中心（南关正街）': dict(
        skip=True, note='实际为永宁门外西南的 2×2 四塔组团（108.9413,34.2492，王府井百货永宁门店裙楼上），22 层；四座塔在 buildings.bin 中'
                        '已有轮廓，由 tools/check_heights.py 的 POINT_FIX 按 22 层改高，这里不再在错误位置另立一栋'),
    '钟楼饭店': dict(skip=True, note='7 层长板楼（新浪 2022 实拍“一共是七层”），不是高层；buildings.bin 中该楼由 POINT_FIX 按 7 层改高'),
    '陕西省人民政府（新城大院）': dict(skip=True, note='约 12 层东西向长板楼（照片计数，非官方），由 POINT_FIX 按 12 层改 buildings.bin 高度'),
    '金花豪生国际大酒店': dict(h=75.6, note='21 层（携程/百科摘要），按 21×3.6 m 取 75.6 m（原 70 m 为估计）'),
    '陕铁大厦': dict(
        lon=108.968439, lat=34.157468, h=99.8,
        note='99.8 m/23F（商策网招商稿，二手）；位于东长安街×神舟四路十字西北角（路口 108.9697,34.1561），取路口西北侧 54×45 m 候选轮廓'
             f'（Overture 5e076029，未证实）；原推测坐标 108.99,34.147 相差约 2 km（{DOSSIER}east_west.json）'),
    '中国国际丝路中心大厦（绿地）': dict(
        lon=108.768209, lat=34.258591,
        note='现状核心筒约 300 m/61 层（2024-03 官方回复）；位置取 buildings.bin 该处 71 m 局部块（沣东大道×复兴大道东南角），'
             '原推测点偏开约 30 m 导致旧块与新塔并存'),
    '西北国金中心A座': dict(
        xz=(-915, -8719), rect=[50, 48, 0], h=205,
        note='原坐标 (−1024,−8973) 取到的 OSM w1418071031 是住宅；卫星图带八角停机坪的塔顶在文景路×凤城七路西北角约 (−915,−8719)'
             f'（{DOSSIER}north.json）；该处 Overture 无塔楼轮廓，按 50×48 m 合成；主塔 205 m（百科/官网）与 210 m/50F 两说，取 205'),
    '西安赛瑞喜来登大酒店': dict(h=111.6, note='主楼 31 层（north.json 资料；OSM 标 26 层），按 31×3.6 m 取 111.6 m'),
    '中国电信大厦（未央路）': dict(note='80 m 为估计值，无出处（north.json 亦未查到），仅作标注'),
    '长庆苏里格大厦': dict(note='90 m 为估计值，无出处（north.json 亦未查到），仅作标注'),
    '天朗·经开中心': dict(note='100 m 为估计值；资料为 29 层（north.json），29×3.6≈104 m，与 100 m 相近，保留'),
    '西安市人民政府（行政中心）主楼': dict(
        note='清单坐标 108.954153,34.344043 实为西安市中医医院 POI；真正的市政府在未央路以西 (−669,−9258)（OSM r18903162，240×247 m 对称院落）；'
             'sky-data 的 FP.gov 是未央路以东的市委/人大/政协与中医医院楼群（north.json）。本条 already_modeled，不生成'),
    # —— 商场 ——
    '百盛购物中心(西大街/时代盛典)': dict(skip=True, note='西大街百盛 2018 年底终止经营（搜狐）；楼体（时代盛典大厦）留给通用建筑，不再挂“百盛”招牌'),
    '群光广场': dict(sign_text='华侨印象', sign_color='#ffffff', note='已更名“华侨印象”（core_south 档案）；招牌颜色未查到，用白色'),
    '西安西咸吾悦广场': dict(sign_color='#1d3f8c', note='照片中招牌为深蓝色字（east_west 档案；颜色值为目测近似，未取色），malls.json 记为红色有误'),
    '盛大时代广场': dict(skip=True, note='2025 年起拆除改造（高楼迷 2025-04/05，gaoxin 档案），不再按商场建'),
}

# 调研清单里没有、逐栋档案补充的已建/现状塔楼（与 towers.json 同字段）
EXTRA_TOWERS = [
    dict(name='华润国际广场T1', lon=108.826087, lat=34.291173, height_m=187, floors=41, status='completed', coord_source='dossier',
         note='187 m/41F（百科摘要），西咸万象城·三桥站上盖；OSM w969242842 仅 49×16 m 不可用，按标准层约 2000 m² 合成 50×40 m',
         _rect=[50, 40, 0]),
    dict(name='苏陕国际金融中心 塔1', lon=None, lat=None, _xz=(9827.4, -5754.8), height_m=132.7, floors=32, status='completed',
         coord_source='dossier', form='烂尾塔（幕墙未闭合）',
         note='原规划 153.4 m/37F，2023-06—2024-08 因限高拆降至 32 层（拍卖公告），按原层高折算 153.4×32/37 ≈ 132.7 m；位置为 Overture ML 候选'
              ' a5834407（35×34 m，长边自正东逆时针 17°），未经影像确认', _rect=[35, 34, -17]),
    dict(name='苏陕国际金融中心 塔2', lon=None, lat=None, _xz=(9916.4, -5718.8), height_m=132.7, floors=32, status='completed',
         coord_source='dossier', form='烂尾塔（幕墙未闭合）', note='同塔1；候选 07ab9d29（40×31 m，21°）', _rect=[40, 31, -21]),
    dict(name='比亚迪西安研发中心', lon=108.84043, lat=34.18185, height_m=200, floors=43, status='completed', coord_source='dossier',
         note='CTBUH 200 m/43F（2025 完工），亚迪路 2 号；平面尺寸未查到，按 48×40 m 合成（该点 Overture 93.6×90 m 轮廓疑为裙房）',
         _rect=[48, 40, 0]),
]


def load_list(name):
    f = REF / f'{name}.json'
    if not f.exists():
        return []
    d = json.loads(f.read_text('utf-8'))
    return d if isinstance(d, list) else d.get('items', [])


def num(v, default=None):
    if v is None:
        return default
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r'-?\d+(\.\d+)?', str(v))
    return float(m.group()) if m else default


def rng(key, k):
    return (zlib.crc32(f'{key}|{k}'.encode()) % 10000) / 10000


def key_of(name):
    return 'lm' + format(zlib.crc32(name.encode()), '08x')


def norm(n):
    return re.sub(r'[\s·・\-—()（）]', '', str(n or '')).lower()


# ───────────────────────── 轮廓数据 ─────────────────────────
class Footprints:
    def __init__(self):
        import pyarrow.parquet as pq
        self.polys, self.names, self.src = [], [], []
        self.by_rid = {}
        sk = json.loads((ROOT / 'public/data/skyline.json').read_text('utf-8'))
        for f in sk['features']:
            o = f.get('outer') or []
            if len(o) >= 6:
                p = Polygon(np.array(o, float).reshape(-1, 2))
                if p.is_valid and p.area > 50:
                    self.polys.append(p)
                    self.names.append(f.get('n') or '')
                    self.src.append(('skyline', f.get('h')))
        pf = ROOT / 'data-src/overture/building.parquet'
        if pf.exists():
            t = pq.read_table(pf, columns=['names', 'height', 'num_floors', 'geometry', 'sources'])
            geoms = shapely.from_wkb(t.column('geometry').to_pylist())
            names = t.column('names').to_pylist()
            hs = t.column('height').to_pylist()
            rids = [next((str(q.get('record_id') or '').split('@')[0] for q in (ss or []) if q.get('dataset') == 'OpenStreetMap'), '')
                    for ss in t.column('sources').to_pylist()]
            for g, n, h, rid in zip(geoms, names, hs, rids):
                if g is None or g.geom_type not in ('Polygon', 'MultiPolygon'):
                    continue
                if g.geom_type == 'MultiPolygon':
                    g = max(g.geoms, key=lambda q: q.area)
                xy = np.array(g.exterior.coords)
                pts = np.array([project(lon, lat) for lon, lat in xy])
                p = Polygon(pts)
                if not p.is_valid:
                    p = p.buffer(0)
                    if p.geom_type != 'Polygon':
                        continue
                if p.area < 50:
                    continue
                self.polys.append(p)
                self.names.append((n or {}).get('primary') or '')
                self.src.append(('overture', h))
                if rid:
                    self.by_rid[rid] = len(self.polys) - 1
        self.tree = STRtree(self.polys)
        print(f'轮廓库：{len(self.polys)} 个（skyline + Overture）')

    def near(self, x, z, r):
        idx = self.tree.query(Point(x, z).buffer(r))
        return [int(i) for i in idx]

    def by_name(self, name, x, z, r=400):
        k = norm(name)
        if len(k) < 2:
            return None
        best = None
        for i in self.near(x, z, r):
            nk = norm(self.names[i])
            if nk and (nk == k or (len(nk) >= 3 and (nk in k or k in nk))):
                d = self.polys[i].distance(Point(x, z))
                if best is None or d < best[0]:
                    best = (d, i)
        return best[1] if best else None


def tower_min_area(h):
    """高层塔楼标准层的最小占地（m²）：百米以上 500"""
    return 500 if h >= 100 else 250


def tower_fp_ok(p, h):
    """对位到的轮廓能否当塔楼平面：太小/太细（百米以上宽 < 18 m）或整片综合体（塔楼 + 裙房）都不行。
    上限：150 m 以上 4500 m²、100 m 以上 6000 m²、其余 8000 m²（超过的多半把裙房/整个街坊画成了一个轮廓，
    整体拉到塔楼高度就成了一堵“巨墙”）"""
    r = p.minimum_rotated_rectangle
    c = list(r.exterior.coords)
    w = min(math.dist(c[0], c[1]), math.dist(c[1], c[2]))
    if p.area < tower_min_area(h) or (h >= 100 and w < 18):
        return False
    return p.area <= (4500 if h >= 150 else 6000 if h >= 100 else 8000)


def poly_out(p, tol=0.6):
    p = p.simplify(tol, preserve_topology=True)
    if p.geom_type != 'Polygon':
        p = max(p.geoms, key=lambda q: q.area)
    c = list(p.exterior.coords)[:-1]
    # CCW（x 东 z 南 坐标系下 shoelace>0）
    s = sum(c[i][0] * c[(i + 1) % len(c)][1] - c[(i + 1) % len(c)][0] * c[i][1] for i in range(len(c)))
    if s < 0:
        c = c[::-1]
    return [round(v, 1) for xy in c for v in xy]


def rect(cx, cz, w, d, rot=0.0):
    c, s = math.cos(rot), math.sin(rot)
    out = []
    for ax, az in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        x, z = ax * w / 2, az * d / 2
        out += [round(cx + x * c - z * s, 1), round(cz + x * s + z * c, 1)]
    return ccw_flat(out)


def ccw_flat(p):
    n = len(p) // 2
    s = sum(p[i * 2] * p[(i + 1) % n * 2 + 1] - p[(i + 1) % n * 2] * p[i * 2 + 1] for i in range(n))
    return p if s > 0 else [v for i in range(n - 1, -1, -1) for v in (p[i * 2], p[i * 2 + 1])]


def ellipse(cx, cz, a, b, rot=0.0, n=40):
    c, s = math.cos(rot), math.sin(rot)
    out = []
    for k in range(n):
        t = 2 * math.pi * k / n
        x, z = a * math.cos(t), b * math.sin(t)
        out += [round(cx + x * c - z * s, 1), round(cz + x * s + z * c, 1)]
    return ccw_flat(out)


_ROADS = None


def road_rot(x, z, r=120):
    """最近的主要道路（非匝道/小路）走向；下沉广场长边顺着街道"""
    global _ROADS
    if _ROADS is None:
        from shapely.geometry import LineString
        R = json.loads((ROOT / 'public/data/roads.json').read_text('utf-8'))
        keep = {i for i, c in enumerate(R['classes']) if c in ('primary', 'secondary', 'tertiary', 'trunk', 'pedestrian', 'residential', 'unclassified')}
        segs = []
        for f in R['features']:
            if f['c'] not in keep:
                continue
            q = f['p']
            for i in range(0, len(q) - 2, 2):
                segs.append(LineString([(q[i], q[i + 1]), (q[i + 2], q[i + 3])]))
        _ROADS = (segs, STRtree(segs))
    segs, tree = _ROADS
    P = Point(x, z)
    idx = [int(i) for i in tree.query(P.buffer(r))]
    if not idx:
        return None
    j = min(idx, key=lambda i: segs[i].distance(P))
    (ax, az), (bx, bz) = segs[j].coords
    a = math.atan2(bz - az, bx - ax)
    return (a + math.pi / 2) % math.pi - math.pi / 2


# 已知走向（影像核对）：南门两翼顺护城河东西向；张家堡四象限正南北
SUNKEN_ROT = {'榴园': 0.0, '合生汇': 0.0, '未央城市广场': 0.0}


def _sunken_rot(name, x, z, fp):
    for k, v in SUNKEN_ROT.items():
        if k in name:
            return v
    r = road_rot(x, z)
    return r if r is not None else local_rot(fp, x, z)


def local_rot(fp, x, z):
    """附近最大建筑的最小外接矩形方向（合成矩形轮廓时顺着街区走向）"""
    best = None
    for i in fp.near(x, z, 150):
        p = fp.polys[i]
        if best is None or p.area > best.area:
            best = p
    if best is None:
        return 0.0
    r = best.minimum_rotated_rectangle
    c = list(r.exterior.coords)
    return math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0])


# ───────────────────────── 轮廓选择与合成（防穿模） ─────────────────────────
# 轮廓面积上限：对位时超过上限的候选一律不要（曾把“世纪金花(钟楼店)”对到 1100 万 m² 的城墙整环，
# 渲染成盖住整个城墙内的 12 m 大盒子，并让其中的通用建筑、回民街、古建全部让位/穿模）
MAX_AREA = {'tower': 15000, 'mall': 250000, 'venue': 250000, 'stadium': 200000, 'campus': 40000}
# 地下商场（地面只有出入口/下沉广场）：不生成地上体量，只做标注
UNDERGROUND = r'地下商场为主|以地下为主|主体在.{0,8}地下|地上仅|地面仅.{0,6}出入口'
SAME_BLD = 0.6      # 较小者 ≥ 60% 落在另一条目轮廓内 → 视为同一栋（后出现的丢弃）
ROAD_KEEP = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified',
             'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'}


def poly_of(pts):
    return Polygon(np.array(pts, float).reshape(-1, 2))


def same_building(p, q):
    """同一栋：交叠 ≥ 较小者的 60%，且两者面积相近（塔楼落在商场裙房里不算）"""
    a0, a1 = sorted((p.area, q.area))
    return a0 >= 0.35 * a1 and p.intersection(q).area >= SAME_BLD * a0


class Obstacles:
    """合成矩形要避开的东西：机动车道路面（中心线按路宽/2 缓冲，隧道除外）、skyline.json 实测高层（渲染端通用塔楼）、
    已放置的其他地标轮廓。通用建筑（buildings.bin）不算：它们会给地标让位。"""

    def __init__(self):
        from shapely.geometry import LineString
        R = json.loads((ROOT / 'public/data/roads.json').read_text('utf-8'))
        keep = {i for i, c in enumerate(R['classes']) if c in ROAD_KEEP}
        g = []
        for f in R['features']:
            if f['c'] not in keep or f.get('t'):
                continue
            q, hw = f['p'], max(2.0, (f.get('w') or 8) / 2)
            for i in range(0, len(q) - 2, 2):
                g.append(LineString([(q[i], q[i + 1]), (q[i + 2], q[i + 3])]).buffer(hw, cap_style='flat'))
        sk = json.loads((ROOT / 'public/data/skyline.json').read_text('utf-8'))
        for f in sk['features']:
            o = f.get('outer') or []
            if len(o) >= 6 and (f.get('h') or 0) >= 34:
                p = poly_of(o)
                if p.is_valid:
                    g.append(p)
        self.static = g
        self.tree = STRtree(g)
        self.placed = []

    def overlap(self, p):
        a = sum(self.static[i].intersection(p).area for i in self.tree.query(p, predicate='intersects'))
        return a + sum(q.intersection(p).area for q in self.placed if q.intersects(p))


def fit_rect(obs, x, z, w, d, rot):
    """合成矩形落位：在 ±30 m、缩放 1.0~0.6 内找与障碍（道路/实测高层/其他地标）重叠最小的位置；原位无重叠则不动"""
    base = Polygon(np.array(rect(x, z, w, d, rot), float).reshape(-1, 2))
    ov0 = obs.overlap(base)
    if ov0 < 1:
        return rect(x, z, w, d, rot), 0.0
    c, s = math.cos(rot), math.sin(rot)
    best = (3 * ov0 / base.area, x, z, 1.0)
    for sc in (1.0, 0.9, 0.8, 0.7, 0.6):
        for du in range(-30, 31, 6):
            for dv in range(-30, 31, 6):
                cx, cz = x + du * c - dv * s, z + du * s + dv * c
                q = Polygon(np.array(rect(cx, cz, w * sc, d * sc, rot), float).reshape(-1, 2))
                cost = 3 * obs.overlap(q) / q.area + 0.004 * math.hypot(du, dv) + 0.5 * (1 - sc)
                if cost < best[0] - 1e-6:
                    best = (cost, cx, cz, sc)
    _, cx, cz, sc = best
    pts = rect(cx, cz, w * sc, d * sc, rot)
    ov = obs.overlap(Polygon(np.array(pts, float).reshape(-1, 2)))
    if ov > ov0 - max(50.0, 0.3 * ov0):   # 改善不明显则不动（重复运行时保持稳定）
        return rect(x, z, w, d, rot), ov0
    return pts, ov


def rect_params(pts):
    """由 rect() 生成的四边形反求 (cx, cz, w, d, rot)"""
    q = np.array(pts, float).reshape(-1, 2)
    cx, cz = q.mean(0)
    e0, e1 = q[1] - q[0], q[2] - q[1]
    return cx, cz, float(np.hypot(*e0)), float(np.hypot(*e1)), math.atan2(e0[1], e0[0])


def contains_fp(fp, x, z, min_area, max_area, used):
    """合成前兜底：若点落在某个面积合理的实测轮廓内（对位时因面积与调研尺寸相差过大被拒），直接用它"""
    P = Point(x, z)
    c = [j for j in fp.near(x, z, 5) if j not in used and min_area <= fp.polys[j].area <= max_area and fp.polys[j].contains(P)]
    return min(c, key=lambda j: fp.polys[j].area) if c else None


def podium_rects(pts, n):
    """综合体里的塔楼：落在商场轮廓内沿长边排布（34×30 m）"""
    P = Polygon(np.array(pts, float).reshape(-1, 2))
    r = P.minimum_rotated_rectangle
    c = list(r.exterior.coords)
    e0 = np.subtract(c[1], c[0])
    e1 = np.subtract(c[2], c[1])
    ax, L = (e0, np.hypot(*e0)) if np.hypot(*e0) >= np.hypot(*e1) else (e1, np.hypot(*e1))
    u = ax / max(L, 1e-6)
    rot = math.atan2(u[1], u[0])
    cx, cz = P.centroid.x, P.centroid.y
    out = []
    for k in range(n):
        off = (k - (n - 1) / 2) * min(70, L / max(1, n))
        out.append(rect(cx + u[0] * off, cz + u[1] * off, 34, 30, rot))
    return out


# ───────────────────────── 风格推断 ─────────────────────────
COLORS = [
    (r'金|香槟|铜', '#5a4a32', '#b8a37a'), (r'深蓝|宝蓝|蓝色|蓝绿|湖蓝', '#2f4a63', '#5b6b78'),
    (r'绿', '#3a5a55', '#5f6e6a'), (r'银|灰', '#4a5560', '#8e959c'), (r'茶|棕|褐', '#3d3a36', '#7a6a58'),
    (r'黑', '#23282d', '#3a3f45'), (r'白', '#46545f', '#e2e0da'),
]
STONE = r'石材|米黄|砖|干挂|花岗|陶板|面砖|实墙'


def style_from(it, key, kind):
    f = ' '.join(str(it.get(k) or '') for k in ('facade', 'form', 'colors', 'roof'))
    night = str(it.get('night') or '')
    tint, spd = '#3b5569', '#5b6670'
    for pat, t, s in COLORS:
        if re.search(pat, f):
            tint, spd = t, s
            break
    st = {'tint': tint, 'spd': spd, 'seed': round(rng(key, 's') * 1000, 1)}
    if re.search(STONE, f) and not re.search(r'全玻璃|玻璃幕墙为主', f):
        st.update(mode=7, spd='#cdbda6' if not re.search(r'灰|白', f) else '#d6d2ca', floorH=3.6, colW=2.4, mullW=1.1, spandrel=0.4, lit=0.5)
    else:
        st.update(floorH=4.0 if kind == 'tower' else 5.4, colW=1.5 + rng(key, 'c') * 0.4, spandrel=0.24 + rng(key, 'p') * 0.1, lit=0.4)
    if re.search(r'媒体|LED|立面屏|灯光秀|幻彩', night + f):
        st['mode'] = 1 if kind == 'tower' else 5
    elif re.search(r'楼层线|灯带|横向线条|轮廓灯', night) and st.get('mode') != 7:
        st['mode'] = 2
    if re.search(r'百叶|横向线条|水平线条', f) and st.get('mode') == 0:
        st['mode'] = 3
    if kind != 'tower' and 'mode' not in st:
        st['mode'] = 6
    h = num(it.get('height_m'), 0)
    if kind == 'tower' and h > 120:
        st['band'] = 12
    return st


def crown_from(it, key, h):
    c = str(it.get('crown') or '')
    if not c and h < 90:
        return None, {}
    roof = {}
    if re.search(r'尖|桅|天线|避雷', c):
        roof['spire'] = round(max(8, min(45, h * 0.08)), 1)
    if re.search(r'停机坪', c):
        roof['helipad'] = True
    ch = 5 + min(14, h * 0.035)
    if re.search(r'皇冠|镂空|桂冠|灯笼|钻石|塔冠', c):
        ch *= 1.5
    col = '#ffe2b8' if re.search(r'暖|金|黄', c + str(it.get('night') or '')) else '#dfe9ff'
    return {'h': round(ch, 1), 'color': col}, roof


SIGN_COLORS = {'红': '#ff3a2e', '金': '#ffd36a', '黄': '#ffd36a', '蓝': '#63c7ff', '绿': '#5dff9a', '白': '#ffffff'}


def sign_color(it):
    c = str(it.get('sign_color') or '')
    if re.fullmatch(r'#[0-9a-fA-F]{6}', c.strip()):
        return c.strip()
    for k, v in SIGN_COLORS.items():
        if k in c:
            return v
    return '#ffffff'


def taper_from(it):
    f = str(it.get('form') or '')
    return 0.86 if re.search(r'收分|渐收|锥', f) else None


# ───────────────────────── 主流程 ─────────────────────────
# ───────────────────────── 古建院落排布（防重叠） ─────────────────────────
HER_GAP = 3.0  # 相邻建筑外廓（出檐）之间的最小净距（米）
# 调研清单里核实为套错轮廓的古建条目：不生成（否则会把真实建筑排除掉、在其轮廓上建一座不存在的古建）
HERITAGE_SKIP = {
    '新城黄楼（陕西省人民政府·明秦王府）':
        '“黄楼”轮廓（OSM w1465146336 / Overture f85d1586，名称“陕西省人民政府”）实为约 10–12 层对称办公楼'
        '（research/refs/dossiers/public_notes.md）；1927 年黄楼真实位置与形制未查实，整条移除',
}


def built_extent(q):
    """渲染端（src/modules/heritage26.js）实际建成的平面外廓（含出檐、台基、踏步），返回 (宽, 深)。
    殿/门/楼/亭按数据 w×d 拟合（fitBuilding 保证不超出）；密檐塔 = 塔身 w 外加台基（每边 0.28w，0.8~3 m）
    与南北踏步（台基高 0.16w、0.15 m 一级、踏面 0.32 m）；牌坊宽 5~24 m、深约 3.5 m；其余按数据尺寸。
    （原先按数据 w×d 判重叠，而塔的台基+踏步比数据大 50% 以上，善导塔与法堂、玄奘塔与圆测塔因此相交）"""
    t, w, d = q['type'], q['w'], q['d']
    if t == 'pagoda':
        bw = min(max(w * 0.9, 1.6), 14)
        pod = bw + 2 * min(max(bw * 0.28, 0.8), 3.0)
        run = round(min(max(bw * 0.16, 0.5), 1.6) / 0.15) * 0.32
        return pod + 0.6, pod + 0.6 + 2 * run
    if t == 'paifang':
        return min(max(w, 5), 24) + 2, 3.5
    if t in ('hall', 'gate', 'tower', 'pavilion'):
        # 拟合目标 = 数据尺寸 + 每边 0.75 m 檐口余量；进深柱网不小于面阔柱网 × 0.22（出檐约 9 m）
        return w + 1.5, max(d + 1.5, 0.22 * (w + 1.5 - 9) + 9 if w > 20 else 0)
    return w, d


def _box(q):
    ew, ed = built_extent(q)
    return q['x'] - ew / 2, q['z'] - ed / 2, q['x'] + ew / 2, q['z'] + ed / 2


def _overlap(a, b, gap=HER_GAP):
    A, B = _box(a), _box(b)
    return A[0] < B[2] + gap and B[0] < A[2] + gap and A[1] < B[3] + gap and B[1] < A[3] + gap


def resolve_overlaps(bl, gap=HER_GAP):
    """按列表顺序逐个检查：与前面已定位的建筑（按建成外廓 + 净距）重叠时，挪动当前建筑。
    候选方向：北/南/东/西，取能一次避开全部已定位建筑的最小位移；中轴上的建筑（x≈0）优先沿中轴挪（横向代价 ×1.5）。
    封土/遗址台基（mound/platform）体量大、多为底座，不参与。返回挪动次数。"""
    moved = 0
    placed = []
    for q in bl:
        if q['type'] in ('mound', 'platform'):
            continue
        for _ in range(16):
            hits = [p for p in placed if _overlap(q, p, gap)]
            if not hits:
                break
            Q = _box(q)
            cands = []
            for p in hits:
                P = _box(p)
                cands += [('z', P[1] - gap - Q[3]), ('z', P[3] + gap - Q[1]), ('x', P[2] + gap - Q[0]), ('x', P[0] - gap - Q[2])]
            best = None
            for ax, dv in cands:
                trial = dict(q)
                trial[ax] = q[ax] + dv
                clear = not any(_overlap(trial, p, gap) for p in placed)
                cost = abs(dv) * (1.5 if ax == 'x' and abs(q['x']) < 0.5 else 1.0) + (0 if clear else 1000)
                if best is None or cost < best[0]:
                    best = (cost, ax, dv)
            q[best[1]] = round(q[best[1]] + best[2] + (0.05 if best[2] > 0 else -0.05), 1)
            moved += 1
        placed.append(q)
    return moved


def relayout_heritage():
    """只重排现有 landmarks2026.json 的古建院落（其余段落原样保留），排布逻辑修改后无需重跑全部轮廓对位。"""
    raw = json.loads(OUT.read_text('utf-8'))
    total = 0
    drop = [s['name'] for s in raw.get('heritage', []) if s['name'] in HERITAGE_SKIP]
    raw['heritage'] = [s for s in raw.get('heritage', []) if s['name'] not in HERITAGE_SKIP]
    for n in drop:
        print(f'  移除 {n}：{HERITAGE_SKIP[n]}')
    for s in raw.get('heritage', []):
        n = resolve_overlaps(s['b'])
        if n:
            print(f'  {s["name"]}：挪动 {n} 次')
        total += n
    OUT.write_text(json.dumps(raw, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    print(f'古建院落重排完成：共挪动 {total} 次 → {OUT}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--relayout-heritage', action='store_true', help='只按新排布逻辑重排已生成文件中的古建院落')
    ap.add_argument('--refit', action='store_true', help='只对现有 landmarks2026.json 重做轮廓选择/合成（不改坐标/高度等其他字段）')
    args = ap.parse_args()
    if args.relayout_heritage:
        relayout_heritage()
        return
    if args.refit:
        return refit(args)
    places = {}
    pf = ROOT / 'data-src/amap/places.json'
    if pf.exists():
        from amap_fetch import gcj2wgs
        for n, p in json.loads(pf.read_text('utf-8')).items():
            if p and p.get('exact') and p.get('location'):
                lon, lat = map(float, p['location'].split(','))
                places[n] = project(*gcj2wgs(lon, lat))
    fp = Footprints()
    obs = Obstacles()
    placed_tw = []  # 已放置的塔楼轮廓（塔楼之间不许交叠）
    used = set()   # 已被某个地标占用的轮廓（同一轮廓不再分给第二个条目：长安云南/北馆、两校同名图书馆……）
    out = {'version': 1, 'towers': [], 'malls': [], 'heritage': [], 'labels': []}
    report = []
    seen = []

    def pos(it):
        n = it.get('name')
        ov = OVERRIDE.get(n) or {}
        if 'xz' in ov:
            return tuple(ov['xz']), 'fix'
        if it.get('_xz'):
            return tuple(it['_xz']), it.get('coord_source') or 'dossier'
        if 'lon' in ov:
            return project(ov['lon'], ov['lat']), 'fix'
        if ov.get('rid') and ov['rid'] in fp.by_rid:
            c = fp.polys[fp.by_rid[ov['rid']]].centroid
            return (c.x, c.y), 'fix'
        if n in places:
            return places[n], 'amap'
        lon, lat = num(it.get('lon')), num(it.get('lat'))
        if lon is None or lat is None or not (108.3 < lon < 109.7 and 33.6 < lat < 34.9):
            return None, None
        return project(lon, lat), it.get('coord_source') or '?'

    def dup(name, x, z):
        k = norm(name)
        for (k2, x2, z2) in seen:
            if k2 == k or (math.hypot(x - x2, z - z2) < 25 and (k in k2 or k2 in k)):
                return True
        seen.append((k, x, z))
        return False

    def match(it, x, z, want_area, min_area, r, kind):
        """对位轮廓：同名 > 含点且面积合理 > 半径内最近且面积合理；超过 MAX_AREA 或已被其他地标占用的轮廓不要"""
        max_area = MAX_AREA[kind]
        i = fp.by_name(it.get('name'), x, z)
        if i is None:
            for al in it.get('aliases') or []:
                i = fp.by_name(al, x, z)
                if i is not None:
                    break
        ok = lambda p: min_area <= p.area <= max_area and (want_area is None or 0.2 * want_area <= p.area <= 5 * want_area)
        if i is not None and i not in used and ok(fp.polys[i]):
            return i, 'name'
        P = Point(x, z)
        cand = [j for j in fp.near(x, z, r) if j not in used and ok(fp.polys[j])]
        inside = [j for j in cand if fp.polys[j].contains(P)]
        if inside:
            return min(inside, key=lambda j: fp.polys[j].area), 'contains'
        if cand:
            j = min(cand, key=lambda j: fp.polys[j].distance(P))
            if fp.polys[j].distance(P) < r:
                return j, 'near'
        j = contains_fp(fp, x, z, min_area, max_area, used)
        if j is not None:
            return j, 'contains'
        return None, 'synth'

    def place(pts, i, name):
        """登记轮廓；与已放置地标是同一栋则返回 False（条目丢弃）"""
        P = poly_of(pts)
        if any(same_building(P, q) for q in obs.placed):
            report.append(('重复', name, '同一轮廓', '', 0))
            return False
        if i is not None:
            used.add(i)
        obs.placed.append(P)
        return True

    # —— 塔楼 ——
    for it in load_list('towers') + EXTRA_TOWERS:
        name = it.get('name')
        ov = OVERRIDE.get(name) or {}
        if it.get('_rect') and 'rect' not in ov:
            ov = dict(ov, rect=it['_rect'])
        if not name or it.get('already_modeled') or ov.get('skip') or str(it.get('status', 'open')).startswith('under') and not re.search(r'封顶|topped', str(it.get('status'))):
            continue
        xz, cs = pos(it)
        if not xz or math.hypot(*xz) > MAX_R or dup(name, *xz):
            continue
        x, z = xz
        h = num(ov.get('h')) or num(it.get('height_m'))
        fl = num(it.get('floors'))
        if not h:
            h = fl * 3.8 if fl else None
        if not h or h < 30:
            continue
        sz = it.get('footprint_size_m')
        want = (num(sz[0]) or 40) * (num(sz[1]) or 40) if isinstance(sz, list) and len(sz) == 2 else None
        # 坐标/轮廓覆盖表（高度坐标审计）优先；否则按塔楼规则对位（面积上限、一轮廓一条目）并做合理性检查
        if ov.get('rect'):
            i, how = None, 'fix'
        elif ov.get('rid') and ov['rid'] in fp.by_rid:
            i, how = fp.by_rid[ov['rid']], 'fix'
            used.add(i)
        else:
            i, how = match(it, x, z, want, max(250, tower_min_area(h)), 45, 'tower')
            if i is not None and not tower_fp_ok(fp.polys[i], h):
                report.append(('塔楼轮廓不合理→合成', name, f'{fp.polys[i].area:.0f} m²', cs, h))
                i, how = None, 'synth'
        key = key_of(name)
        if i is not None:
            pts = poly_out(fp.polys[i])
        elif ov.get('rect'):
            w, d, rdeg = ov['rect']
            pts = rect(x, z, w, d, math.radians(rdeg))
        else:
            w, d = (num(sz[0]) or 42, num(sz[1]) or 42) if isinstance(sz, list) and len(sz) == 2 else (42, 42)
            pts, _ = fit_rect(obs, x, z, min(w, 90), min(d, 90), local_rot(fp, x, z))
        if i is not None and any(q.intersection(poly_of(pts)).area > 0.1 * min(q.area, poly_of(pts).area) for q in placed_tw):
            # 与已放置塔楼交叠（就近对位拿到了别的塔的底盘）：改为合成
            w, d = (num(sz[0]) or 42, num(sz[1]) or 42) if isinstance(sz, list) and len(sz) == 2 else (42, 42)
            pts, _ = fit_rect(obs, x, z, min(w, 90), min(d, 90), local_rot(fp, x, z))
            i, how = None, 'synth'
        if not place(pts, i, name):
            continue
        placed_tw.append(poly_of(pts))
        crown, roof = crown_from(it, key, h)
        if re.search(r'烂尾|停工', str(it.get('form') or '')) or ov.get('h') and str(it.get('status', '')).startswith('stalled'):
            crown, roof = None, {}   # 烂尾/停工现状：不加发光塔冠
        spec = {'key': key, 'name': name, 'pts': pts, 'h': round(h, 1), 'style': style_from(it, key, 'tower'), 'src': how}
        if crown:
            spec['crown'] = crown
        if roof:
            spec['roof'] = roof
        tp = taper_from(it)
        if tp:
            spec['taper'] = tp
        st = str(it.get('sign_text') or '').strip()
        if st and st not in ('无', 'null', 'None') and len(st) <= 12:
            spec['signs'] = [{'text': st, 'color': sign_color(it), 'h': round(max(3.5, min(9, h * 0.035)), 1), 'faces': 2}]
        out['towers'].append(spec)
        report.append(('塔楼', name, how, cs, h))

    # —— 商场 ——
    for it in load_list('malls'):
        name = it.get('name')
        ov = OVERRIDE.get(name) or {}
        if not name or it.get('already_modeled') or ov.get('skip') or str(it.get('status', 'open')).startswith('under'):
            continue
        if ov.get('sign_text') or ov.get('sign_color'):
            it = dict(it, short_sign=ov.get('sign_text') or it.get('short_sign'), sign_color=ov.get('sign_color') or it.get('sign_color'))
        xz, cs = pos(it)
        if not xz or math.hypot(*xz) > MAX_R or dup(name, *xz):
            continue
        x, z = xz
        key = key_of(name)
        if re.search(UNDERGROUND, ' '.join(str(it.get(k) or '') for k in ('form', 'facade', 'remark'))):
            out['labels'].append({'n': name, 'x': round(x, 1), 'z': round(z, 1), 'cat': 'mall'})
            report.append(('标注', name, 'underground', cs, 0))
            continue
        fl = num(it.get('floors_above'))
        h = num(it.get('height_m')) or (fl * 5.2 + 3 if fl else 28)
        h = max(12, min(h, 60))
        sz = it.get('footprint_size_m')
        want = (num(sz[0]) or 120) * (num(sz[1]) or 80) if isinstance(sz, list) and len(sz) == 2 else None
        i, how = match(it, x, z, want, 1500, 70, 'mall')
        if i is not None:
            pts = poly_out(fp.polys[i], 0.8)
        else:
            w, d = (num(sz[0]) or 140, num(sz[1]) or 90) if isinstance(sz, list) and len(sz) == 2 else (140, 90)
            pts, _ = fit_rect(obs, x, z, min(w, 320), min(d, 260), local_rot(fp, x, z))
        if not place(pts, i, name):
            continue
        sign = str(it.get('short_sign') or name).strip()
        spec = {'key': key, 'name': name, 'pts': pts, 'h': round(h, 1), 'style': style_from(it, key, 'mall'), 'src': how,
                'signs': [{'text': sign[:12], 'h': round(max(3.5, min(7, h * 0.18)), 1), 'faces': 2, 'color': sign_color(it)}]}
        out['malls'].append(spec)
        report.append(('商场', name, how, cs, h))
        # 综合体里的塔楼：落在商场轮廓内沿长边排布
        tws = [t for t in it.get('towers') or [] if num(t.get('height_m')) and num(t.get('height_m')) > h + 15]
        if tws:
            rects = podium_rects(pts, len(tws[:4]))
            for k, t in enumerate(tws[:4]):
                th = num(t['height_m'])
                tk = key_of(name + str(t.get('name') or k))
                out['towers'].append({'key': tk, 'name': t.get('name') or f'{name}{k + 1}号楼', 'pts': rects[k],
                                      'h': round(th, 1), 'base': None, 'onPodium': key,
                                      'style': style_from(it, tk, 'tower'), 'crown': {'h': 5, 'color': '#dfe9ff'} if th > 90 else None,
                                      'src': 'synth'})

    # —— 场馆 ——
    for it in load_list('venues'):
        name = it.get('name')
        if not name or it.get('already_modeled') or str(it.get('status', 'open')).startswith('under'):
            continue
        xz, cs = pos(it)
        if not xz or math.hypot(*xz) > MAX_R or dup(name, *xz):
            continue
        x, z = xz
        key = key_of(name)
        cat = str(it.get('category') or 'other')
        if cat in ('park', 'campus'):
            out['labels'].append({'n': name, 'x': round(x, 1), 'z': round(z, 1), 'cat': cat})
            report.append(('标注', name, cat, cs, 0))
            continue
        sz = it.get('footprint_size_m')
        L, W = (num(sz[0]) or 0, num(sz[1]) or 0) if isinstance(sz, list) and len(sz) == 2 else (0, 0)
        h = num(it.get('height_m')) or {'stadium': 45, 'arena': 32, 'station': 30, 'airport': 35, 'theater': 32,
                                        'library': 28, 'museum': 26, 'expo': 26}.get(cat, 24)
        h = max(10, min(h, 80))
        spec = {'key': key, 'name': name, 'h': round(h, 1), 'style': style_from(it, key, 'venue'), 'cat': cat}
        if cat == 'stadium':
            a, b = (L or 260) / 2, (W or 220) / 2
            i, how = match(it, x, z, None, 8000, 80, 'stadium')
            if i is not None:
                P = fp.polys[i]
                x, z = P.centroid.x, P.centroid.y
                r = P.minimum_rotated_rectangle
                c = list(r.exterior.coords)
                s0, s1 = np.hypot(*np.subtract(c[1], c[0])), np.hypot(*np.subtract(c[2], c[1]))
                rot = math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]) if s0 >= s1 else math.atan2(c[2][1] - c[1][1], c[2][0] - c[1][0])
                a, b = max(s0, s1) / 2, min(s0, s1) / 2
            else:
                rot = local_rot(fp, x, z)
            spec['pts'] = ellipse(x, z, a, b, rot)
            spec['holes'] = [ellipse(x, z, a * 0.62, b * 0.55, rot)]
            spec['src'] = how
        else:
            want = L * W if L and W else None
            i, how = match(it, x, z, want, 1200, 80, 'venue')
            if i is not None:
                spec['pts'] = poly_out(fp.polys[i], 0.8)
            else:
                spec['pts'], _ = fit_rect(obs, x, z, min(L or 110, 400), min(W or 80, 300), local_rot(fp, x, z))
            spec['src'] = how
        if not place(spec['pts'], i, name):
            continue
        st = str(it.get('sign_text') or '').strip()
        if st and st not in ('无', 'null') and len(st) <= 14:
            spec['signs'] = [{'text': st, 'h': round(max(3, min(6, h * 0.14)), 1), 'faces': 1, 'color': sign_color(it)}]
        out['malls'].append(spec)
        report.append(('场馆', name, spec['src'], cs, h))

    # —— 古建 ——
    for it in load_list('heritage'):
        name = it.get('name')
        if not name or it.get('already_modeled') or name in HERITAGE_SKIP:
            continue
        xz, cs = pos(it)
        if not xz or math.hypot(*xz) > MAX_R or dup(name, *xz):
            continue
        x, z = xz
        it_lon, it_lat = num(it.get('lon')), num(it.get('lat'))
        o = str(it.get('orientation') or '坐北朝南')
        rot = {'东': math.pi / 2, '西': -math.pi / 2, '北': math.pi}.get(next((c for c in ('东', '西', '北') if f'朝{c}' in o), ''), 0.0)
        cs_m = it.get('compound_size_m')
        cw, cd = (num(cs_m[0]) or 80, num(cs_m[1]) or 120) if isinstance(cs_m, list) and len(cs_m) == 2 else (80, 120)
        bl = []
        cr, sr = math.cos(rot), math.sin(rot)
        # 局部 → 世界：局部 +Z 为正面（朝南），rot 为绕 Y 的旋转（three.js：x' = x cos + z sin, z' = -x sin + z cos）
        to_w = lambda lx, lz: (x + lx * cr + lz * sr, z - lx * sr + lz * cr)
        to_l = lambda wx, wz: ((wx - x) * cr - (wz - z) * sr, (wx - x) * sr + (wz - z) * cr)
        axis_z = cd / 2 - 12   # 顺序排布：从南（正面，+Z）往北
        used = set()
        for b in it.get('main_buildings') or []:
            bw, bd, bh = num(b.get('width_m')), num(b.get('depth_m')), num(b.get('height_m'))
            typ = str(b.get('type') or 'hall')
            posx = str(b.get('position') or '')
            lx = lz = None
            brot = 0.0
            j = fp.by_name(b.get('name'), x, z, r=max(cw, cd) * 0.8) if b.get('name') and len(norm(b.get('name'))) >= 2 else None
            if j is not None and j not in used and fp.polys[j].area < 20000:
                used.add(j)
                P = fp.polys[j]
                lx, lz = to_l(P.centroid.x, P.centroid.y)
                r = P.minimum_rotated_rectangle
                c = list(r.exterior.coords)
                s0, s1 = math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]), math.hypot(c[2][0] - c[1][0], c[2][1] - c[1][1])
                if not bw or not bd:
                    bw, bd = max(s0, s1), min(s0, s1)
            else:
                mlat = re.search(r'lat\s*(3[34]\.\d+)', posx)
                mlon = re.search(r'lon\s*(10[89]\.\d+)', posx)
                if mlat or mlon:
                    wx, wz = project(float(mlon.group(1)) if mlon else it_lon, float(mlat.group(1)) if mlat else it_lat)
                    lx, lz = to_l(wx, wz)
                    if not mlon:
                        lx = 0.0
            bw = bw or {'pagoda': 10, 'pavilion': 8, 'paifang': 14, 'tower': 10, 'mound': 150, 'platform': 60}.get(typ, 24)
            bd = bd or {'pagoda': 10, 'pavilion': 8, 'paifang': 2, 'tower': 10, 'mound': 150, 'platform': 40}.get(typ, 14)
            if lx is None:
                side = -1 if '西' in posx and '东' not in posx else 1 if '东' in posx and '西' not in posx else 0
                if side:
                    lx, lz = side * (min(cw / 2 - bw / 2 - 4, 26 + bw / 2)), axis_z
                else:
                    lx, lz = 0.0, axis_z - bd / 2
                    axis_z -= bd + 14
            bl.append({
                'n': b.get('name') or '', 'type': typ,
                'x': round(lx, 1), 'z': round(lz, 1), 'rot': round(brot, 3),
                'w': round(min(bw, 400), 1), 'd': round(min(bd, 400), 1), 'h': bh,
                'bays': int(num(b.get('bays'), 0) or 0), 'storeys': int(num(b.get('storeys'), 1) or 1),
                'roof': str(b.get('roof') or ''), 'color': str(b.get('roof_color') or ''),
            })
        resolve_overlaps(bl)  # 按渲染端实际建成外廓（含出檐/台基/踏步）防重叠
        out['heritage'].append({'key': key_of(name), 'name': name, 'x': round(x, 1), 'z': round(z, 1), 'rot': round(rot, 4),
                                'w': round(min(cw, 400), 1), 'd': round(min(cd, 500), 1), 'b': bl,
                                'era': ' '.join(str(it.get(k) or '') for k in ('style', 'era', 'dynasty')).strip(), 'kind': it.get('category') or it.get('type') or ''})
        report.append(('古建', name, f'{len(bl)} 座', cs, 0))

    # —— 高校（校区标注 + 能对上 OSM 轮廓的标志楼：校门/主楼/图书馆） ——
    for it in load_list('universities'):
        name = (it.get('name') or '') + (('·' + it['campus']) if it.get('campus') and it['campus'] not in (it.get('name') or '') else '')
        xz, cs = pos(it)
        if not name or not xz or math.hypot(*xz) > MAX_R or dup(name, *xz):
            continue
        x, z = xz
        out['labels'].append({'n': name, 'x': round(x, 1), 'z': round(z, 1), 'cat': 'campus'})
        lbs = list(it.get('landmark_buildings') or []) + [q for q in it.get('named_buildings_in_campus(overture)') or []
                                                        if isinstance(q, dict) and re.search(r'图书馆|主楼|中心楼|大礼堂|博物馆|教学楼|科技楼|行政楼', q.get('name') or '')]
        for lb in lbs if isinstance(lbs, list) else []:
            bn = lb.get('name') if isinstance(lb, dict) else str(lb)
            if not bn or re.search(r'校门|大门|牌楼|门$', bn):
                continue
            j = fp.by_name(bn, x, z, r=1500)
            if j is None or j in used or fp.polys[j].area < 600 or fp.polys[j].area > MAX_AREA['campus']:
                continue
            P = fp.polys[j]
            if not place(poly_out(P, 0.8), j, f'{name} {bn}'):
                continue
            desc = json.dumps(lb, ensure_ascii=False) if isinstance(lb, dict) else bn
            h = num(lb.get('height_m')) if isinstance(lb, dict) else None
            h = h or (40 if re.search(r'主楼|中心楼', bn) else 26)
            key = key_of(name + bn)
            out['malls'].append({'key': key, 'name': f'{name} {bn}', 'pts': poly_out(P, 0.8), 'h': round(min(h, 90), 1), 'cat': 'campus',
                                 'style': style_from({'facade': desc, 'form': desc}, key, 'venue'), 'src': 'name'})
            report.append(('高校楼', f'{name} {bn}', 'name', cs, h))

    # —— 下沉广场 ——
    out['sunken'] = []
    for it in load_list('sunken'):
        name = it.get('name')
        if not name or it.get('confidence') == 'low' or str(it.get('status') or '').startswith('under'):
            continue
        # 只做露天下沉广场：地下通道/地下商业街/连廊/地下枢纽没有地面开口；大雁塔北广场由 datang 模块表现
        if re.search(r'地下通道|地下商业街|地下连|连廊|地下交通枢纽|连通|大雁塔北广场|室内|西安站南广场|陆空TOD', name):
            continue
        xz, cs = pos(it)
        if not xz or math.hypot(*xz) > MAX_R:
            continue
        x, z = xz
        sz = it.get('size_m')
        L, W = (num(sz[0]) or 60, num(sz[1]) or 40) if isinstance(sz, list) and len(sz) == 2 else (60, 40)
        dep = num(it.get('depth_m')) or 6.0
        feat = ' '.join(str(v) for v in (it.get('features') if isinstance(it.get('features'), list) else [it.get('features') or '']))
        shape = str(it.get('shape') or '')
        out['sunken'].append({
            'key': key_of('sk' + name), 'name': name, 'x': round(x, 1), 'z': round(z, 1),
            'L': round(min(max(L, 16), 260), 1), 'W': round(min(max(W, 12), 200), 1), 'depth': round(min(max(dep, 3), 16), 1),
            'rot': round(_sunken_rot(name, x, z, fp), 4),
            'round': bool(re.search(r'圆|环形', shape)),
            'terrace': bool(re.search(r'退台|阶梯|台阶|看台|多层', shape + feat)),
            'water': bool(re.search(r'水|喷泉|镜面', feat)),
            'stage': bool(re.search(r'舞台|演艺|表演', feat)),
            'bar': bool(re.search(r'酒吧|外摆|餐', feat + name)),
            'skylight': bool(re.search(r'天窗|玻璃顶|采光', feat)),
            'escal': bool(re.search(r'扶梯', feat)),
            'levels': int(num(it.get('levels'), 1) or 1),
            'cs': cs,
        })
        report.append(('下沉', name, '', cs, dep))

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    from collections import Counter
    print(f'写出 {OUT}：塔楼 {len(out["towers"])}、商场/场馆 {len(out["malls"])}、古建院落 {len(out["heritage"])}、仅标注 {len(out["labels"])}')
    print('轮廓来源：', dict(Counter(r[2] for r in report if r[0] in ('塔楼', '商场', '场馆'))))
    print('坐标来源：', dict(Counter(r[3] for r in report)))
    if args.report:
        for r in report:
            print('  ', *r)


# ───────────────────────── --refit：只重做轮廓 ─────────────────────────
def refit(args):
    """对现有 landmarks2026.json 重做“轮廓选择与合成”，其余字段（坐标来源、高度、立面、招牌……）原样保留：
      1. 调研清单标明地下商场的条目 → 去掉体量，改为标注；
      2. 轮廓面积超上限（对位错到城墙整环/整片街区）→ 用清单坐标重新对位（带上限），对不上则合成矩形；
      3. 合成矩形（src=synth）：点落在面积合理的实测轮廓内则改用该轮廓，否则避开道路/实测高层/其他地标重新落位；
      4. 与前面条目是同一栋（长安云南/北馆、两校同名图书馆……）→ 丢弃；
      5. 商场轮廓变了，其综合体塔楼（onPodium）按新轮廓重新排布；商场被丢弃则其塔楼一并丢弃。
    （data-src/amap/places.json 缺失时完整重建会改变坐标；日常修轮廓用本模式即可）
    """
    data = json.loads(OUT.read_text('utf-8'))
    fp = Footprints()
    obs = Obstacles()
    used = set()
    lists = {}
    for nm in ('towers', 'malls', 'venues', 'universities'):
        for it in load_list(nm):
            if it.get('name'):
                lists.setdefault(it['name'], it)

    def pos(it):
        lon, lat = num(it.get('lon')), num(it.get('lat'))
        if lon is None or lat is None or not (108.3 < lon < 109.7 and 33.6 < lat < 34.9):
            return None
        return project(lon, lat)

    def kind_of(sec, e):
        if sec == 'towers':
            return 'tower'
        c = e.get('cat')
        return 'stadium' if c == 'stadium' else 'campus' if c == 'campus' else 'venue' if c else 'mall'

    def rematch(it, x, z, kind):
        mn = {'tower': 250, 'mall': 1500, 'venue': 1200, 'stadium': 8000, 'campus': 600}[kind]
        mx = MAX_AREA[kind]
        ok = lambda j: j not in used and mn <= fp.polys[j].area <= mx
        for nm in [it.get('name')] + list(it.get('aliases') or []):
            j = fp.by_name(nm, x, z) if nm else None
            if j is not None and ok(j):
                return j
        P = Point(x, z)
        c = [j for j in fp.near(x, z, 45 if kind == 'tower' else 70) if ok(j)]
        inside = [j for j in c if fp.polys[j].contains(P)]
        if inside:
            return min(inside, key=lambda j: fp.polys[j].area)
        return min(c, key=lambda j: fp.polys[j].distance(P)) if c else None

    labels = {l['n']: (l['x'], l['z']) for l in data['labels']}

    def campus_d(e):
        c = poly_of(e['pts']).centroid
        L = labels.get(e['name'].split(' ')[0])
        return math.hypot(c.x - L[0], c.y - L[1]) if L else 1e9

    log = []
    placed_e = []
    changed_malls, dropped_keys = set(), set()
    new = {'towers': [], 'malls': []}
    RANK = {'name': 0, 'contains': 1, 'near': 2, 'synth': 3}
    placed_tw = []
    for sec in ('towers', 'malls'):
        # 按对位可靠度处理（同名 > 含点 > 就近 > 合成），输出仍保持原顺序
        idx = {id(e): k for k, e in enumerate(data[sec])}
        for e in sorted(data[sec], key=lambda e: RANK.get(e.get('src'), 3)):
            if e.get('onPodium'):
                new[sec].append(e)
                continue
            kind = kind_of(sec, e)
            it = lists.get(e['name'].split(' ')[0] if kind == 'campus' else e['name'], {})
            P = poly_of(e['pts'])
            old = list(e['pts'])
            if kind != 'campus' and it and re.search(UNDERGROUND, ' '.join(str(it.get(k) or '') for k in ('form', 'facade', 'remark'))):
                c = P.centroid
                xz = pos(it) or (c.x, c.y)
                data['labels'].append({'n': e['name'], 'x': round(xz[0], 1), 'z': round(xz[1], 1), 'cat': 'mall'})
                dropped_keys.add(e['key'])
                log.append(('地下商场→标注', e['name'], round(P.area)))
                continue
            if P.area > MAX_AREA[kind] or not P.is_valid:
                xz = pos(it) if it else None
                if xz is None:
                    dropped_keys.add(e['key'])
                    log.append(('轮廓超限且无坐标→丢弃', e['name'], round(P.area)))
                    continue
                j = rematch(it, *xz, kind)
                if j is not None:
                    e['pts'], e['src'] = poly_out(fp.polys[j], 0.6 if kind == 'tower' else 0.8), 'name'
                    used.add(j)
                else:
                    sz = it.get('footprint_size_m')
                    dflt = (42, 42) if kind == 'tower' else (140, 90)
                    w, d = (num(sz[0]) or dflt[0], num(sz[1]) or dflt[1]) if isinstance(sz, list) and len(sz) == 2 else dflt
                    e['pts'], _ = fit_rect(obs, xz[0], xz[1], min(w, 320), min(d, 260), local_rot(fp, *xz))
                    e['src'] = 'synth'
                log.append(('轮廓超限→重新对位', e['name'], round(P.area), e['src'], round(poly_of(e['pts']).area)))
            elif e.get('src') == 'synth' and kind != 'stadium':
                cx, cz, w, d, rot = rect_params(e['pts'])
                mn = {'tower': 250, 'mall': 1500, 'venue': 1200, 'campus': 600}[kind]
                j = contains_fp(fp, cx, cz, mn, MAX_AREA[kind], used)
                if j is not None:
                    e['pts'], e['src'] = poly_out(fp.polys[j], 0.6 if kind == 'tower' else 0.8), 'contains'
                    used.add(j)
                    log.append(('合成→实测轮廓', e['name'], round(P.area), round(fp.polys[j].area)))
                else:
                    ov0 = obs.overlap(P)
                    pts, ov = fit_rect(obs, cx, cz, w, d, rot)
                    if ov < ov0 - 1:   # 没挪动就保留原坐标（反求矩形参数有取整误差）
                        e['pts'] = pts
                        log.append(('合成矩形避让', e['name'], f'重叠 {ov0:.0f}→{ov:.0f} m²'))
            Q = poly_of(e['pts'])
            if kind == 'tower' and any(q.intersection(Q).area > 0.1 * min(q.area, Q.area) for q in placed_tw):
                # 两座塔楼轮廓交叠（“就近”对位把相邻综合体的整块底盘分给了另一座塔）：可靠度低的一座改按清单坐标合成
                xz = pos(it) if it else None
                if xz is not None:
                    sz = it.get('footprint_size_m')
                    w, d = (num(sz[0]) or 42, num(sz[1]) or 42) if isinstance(sz, list) and len(sz) == 2 else (42, 42)
                    e['pts'], ov = fit_rect(obs, xz[0], xz[1], min(w, 90), min(d, 90), local_rot(fp, *xz))
                    e['src'] = 'synth'
                    Q = poly_of(e['pts'])
                    log.append(('塔楼轮廓互相交叠→合成', e['name'], round(P.area), f'重叠 {ov:.0f} m²'))
            hit = [k for k, q in enumerate(obs.placed) if same_building(Q, q)]
            if hit and kind == 'campus' and len(hit) == 1 and placed_e[hit[0]].get('cat') == 'campus':
                # 两个校区的标志楼对到同一轮廓（如“雁塔校区图书馆”）：留给校区标注更近的那个
                o = placed_e[hit[0]]
                if campus_d(e) < campus_d(o):
                    new[sec].remove(o)
                    dropped_keys.add(o['key'])
                    log.append(('同一栋重复→丢弃', o['name'], round(obs.placed[hit[0]].area)))
                    del obs.placed[hit[0]], placed_e[hit[0]]
                    hit = []
            if hit:
                dropped_keys.add(e['key'])
                log.append(('同一栋重复→丢弃', e['name'], round(Q.area)))
                continue
            obs.placed.append(Q)
            placed_e.append(e)
            if kind == 'tower':
                placed_tw.append(Q)
            if sec == 'malls' and e['pts'] != old:
                changed_malls.add(e['key'])
            new[sec].append(e)
        new[sec].sort(key=lambda e: idx[id(e)])
    # 综合体塔楼：商场轮廓变了则重新排布
    for m in new['malls']:
        if m['key'] not in changed_malls:
            continue
        tws = [t for t in new['towers'] if t.get('onPodium') == m['key']]
        for t, r in zip(tws, podium_rects(m['pts'], len(tws))):
            t['pts'] = r
    new['towers'] = [t for t in new['towers'] if t.get('onPodium') not in dropped_keys]
    data['towers'], data['malls'] = new['towers'], new['malls']
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    print(f'--refit：塔楼 {len(data["towers"])}、商场/场馆 {len(data["malls"])}，改动 {len(log)} 条')
    for r in log:
        print('  ', *r)


if __name__ == '__main__':
    main()
