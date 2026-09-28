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
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--report', action='store_true')
    args = ap.parse_args()
    places = {}
    pf = ROOT / 'data-src/amap/places.json'
    if pf.exists():
        from amap_fetch import gcj2wgs
        for n, p in json.loads(pf.read_text('utf-8')).items():
            if p and p.get('exact') and p.get('location'):
                lon, lat = map(float, p['location'].split(','))
                places[n] = project(*gcj2wgs(lon, lat))
    fp = Footprints()
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

    def match(it, x, z, want_area, min_area, r):
        """对位轮廓：同名 > 含点且面积合理 > 半径内最近且面积合理"""
        i = fp.by_name(it.get('name'), x, z)
        if i is None:
            for al in it.get('aliases') or []:
                i = fp.by_name(al, x, z)
                if i is not None:
                    break
        ok = lambda p: p.area >= min_area and (want_area is None or 0.2 * want_area <= p.area <= 5 * want_area)
        if i is not None and ok(fp.polys[i]):
            return i, 'name'
        P = Point(x, z)
        cand = [j for j in fp.near(x, z, r) if ok(fp.polys[j])]
        inside = [j for j in cand if fp.polys[j].contains(P)]
        if inside:
            return min(inside, key=lambda j: fp.polys[j].area), 'contains'
        if cand:
            j = min(cand, key=lambda j: fp.polys[j].distance(P))
            if fp.polys[j].distance(P) < r:
                return j, 'near'
        return None, 'synth'

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
        if ov.get('rect'):
            i, how = None, 'fix'
        elif ov.get('rid') and ov['rid'] in fp.by_rid:
            i, how = fp.by_rid[ov['rid']], 'fix'
        else:
            i, how = match(it, x, z, want, tower_min_area(h), 45)
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
            pts = rect(x, z, min(w, 90), min(d, 90), local_rot(fp, x, z))
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
        fl = num(it.get('floors_above'))
        h = num(it.get('height_m')) or (fl * 5.2 + 3 if fl else 28)
        h = max(12, min(h, 60))
        sz = it.get('footprint_size_m')
        want = (num(sz[0]) or 120) * (num(sz[1]) or 80) if isinstance(sz, list) and len(sz) == 2 else None
        i, how = match(it, x, z, want, 1500, 70)
        if i is not None:
            pts = poly_out(fp.polys[i], 0.8)
        else:
            w, d = (num(sz[0]) or 140, num(sz[1]) or 90) if isinstance(sz, list) and len(sz) == 2 else (140, 90)
            pts = rect(x, z, min(w, 320), min(d, 260), local_rot(fp, x, z))
        sign = str(it.get('short_sign') or name).strip()
        spec = {'key': key, 'name': name, 'pts': pts, 'h': round(h, 1), 'style': style_from(it, key, 'mall'), 'src': how,
                'signs': [{'text': sign[:12], 'h': round(max(3.5, min(7, h * 0.18)), 1), 'faces': 2, 'color': sign_color(it)}]}
        out['malls'].append(spec)
        report.append(('商场', name, how, cs, h))
        # 综合体里的塔楼：落在商场轮廓内沿长边排布
        tws = [t for t in it.get('towers') or [] if num(t.get('height_m')) and num(t.get('height_m')) > h + 15]
        if tws:
            P = Polygon(np.array(pts, float).reshape(-1, 2))
            r = P.minimum_rotated_rectangle
            c = list(r.exterior.coords)
            e0 = np.subtract(c[1], c[0])
            e1 = np.subtract(c[2], c[1])
            ax, L = (e0, np.hypot(*e0)) if np.hypot(*e0) >= np.hypot(*e1) else (e1, np.hypot(*e1))
            u = ax / max(L, 1e-6)
            rot = math.atan2(u[1], u[0])
            cx, cz = P.centroid.x, P.centroid.y
            for k, t in enumerate(tws[:4]):
                off = (k - (len(tws[:4]) - 1) / 2) * min(70, L / max(1, len(tws[:4])))
                tx, tz = cx + u[0] * off, cz + u[1] * off
                th = num(t['height_m'])
                tk = key_of(name + str(t.get('name') or k))
                out['towers'].append({'key': tk, 'name': t.get('name') or f'{name}{k + 1}号楼', 'pts': rect(tx, tz, 34, 30, rot),
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
            i, how = match(it, x, z, None, 8000, 80)
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
            i, how = match(it, x, z, want, 1200, 80)
            if i is not None:
                spec['pts'] = poly_out(fp.polys[i], 0.8)
            else:
                spec['pts'] = rect(x, z, min(L or 110, 400), min(W or 80, 300), local_rot(fp, x, z))
            spec['src'] = how
        st = str(it.get('sign_text') or '').strip()
        if st and st not in ('无', 'null') and len(st) <= 14:
            spec['signs'] = [{'text': st, 'h': round(max(3, min(6, h * 0.14)), 1), 'faces': 1, 'color': sign_color(it)}]
        out['malls'].append(spec)
        report.append(('场馆', name, spec['src'], cs, h))

    # —— 古建 ——
    for it in load_list('heritage'):
        name = it.get('name')
        if not name or it.get('already_modeled'):
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
            # 与已放置的建筑重叠（顺序排布/东西配殿常见）：往北挪，直到不重叠
            for _ in range(12):
                if not any(abs(lx - q['x']) < (bw + q['w']) / 2 + 3 and abs(lz - q['z']) < (bd + q['d']) / 2 + 3 for q in bl):
                    break
                lz -= bd + 6
            bl.append({
                'n': b.get('name') or '', 'type': typ,
                'x': round(lx, 1), 'z': round(lz, 1), 'rot': round(brot, 3),
                'w': round(min(bw, 400), 1), 'd': round(min(bd, 400), 1), 'h': bh,
                'bays': int(num(b.get('bays'), 0) or 0), 'storeys': int(num(b.get('storeys'), 1) or 1),
                'roof': str(b.get('roof') or ''), 'color': str(b.get('roof_color') or ''),
            })
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
            if j is None or fp.polys[j].area < 600 or fp.polys[j].area > 40000:
                continue
            P = fp.polys[j]
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


if __name__ == '__main__':
    main()
