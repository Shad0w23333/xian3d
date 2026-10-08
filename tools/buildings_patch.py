#!/usr/bin/env python3
"""通用建筑数据修补：就地改写 public/data/buildings.bin（v2），幂等，可重复运行。

不重排已有建筑的下标（buildings_names.json、estates_style.json、各模块按下标引用的数据都不受影响）：
删除用 flags bit7 标记（渲染端 src/arch/bld-skip.js 让位），补楼一律追加到末尾并带 flags bit6，重跑时先去掉旧的追加段。

1. 老城 kind 纠正（根因修复）
   OSM 关系 3450809「西安城墙」带 building=yes + historic=citywalls，build_buildings_v2.py 把多边形的内环也当成实心面，
   城墙以内约 6500 栋 CMAB 楼全部“最佳匹配”到它 → kind=5（历史/宗教）、style 功能=8（公共）。渲染端因此整片老城都用
   “传统风貌”（深灰砖墙 + 近黑的青瓦大坡顶）。这里按 CMAB 自身功能（居住/商服/办公/公服/其他）重算 kind 与 style 功能位，
   与 build_buildings_v2.py assign_kind_style 同一规则（该脚本也已改为匹配时跳过城墙类要素）。
   依赖 data-src/buildings_v2/stage_footprints.pkl、stage_features.pkl（缺失时跳过此步，已修好的 bin 不受影响）。

2. 仿古风貌带：style 功能位 = 9（仿古商业，渲染端 STYLE.ANTIQUE：灰瓦坡顶 + 挑檐 + 深色檐下 + 木格门窗 + 檐柱）
   · 顺城巷：城墙内侧 30 m 带（距城墙中心线 ≤ 37 m，质心 ≤ 50 m）的通用建筑，限高 8 m（城墙顶马道约 12 m，
     从城墙上能越过它们看到老城）；
   · 西大街（竹笆市—西门，2001–2006 年综合整治的“仿古一条街”）、北院门外围、书院门、三学街、东大街东段（≤ 22 m 的楼）
     沿街第一排（≤ 4000 m²；整个街坊合成一块的超大轮廓不改，免得一整块灰瓦大屋顶压在街坊上）；
   · 大雁塔北广场两侧与慈恩镇（仿唐商业）、大慈恩寺院内（寺内殿堂/僧院，限高 7.5 m）。

3. 数据层让位（flags bit7）：建筑数据把工地临建、站场设施、广场采光井等识别成了楼
   · 张家堡环岛（未央城市广场，2026 年改造为下沉庭院）环岛内全部通用楼；
   · 西安站站场（股道上的“商场楼”）与南广场；
   · 荐福寺山门前中轴上的小方盒（≤ 4 m）；大慈恩寺玄奘三藏院回廊上的楼（慈恩图书馆等，回廊由 pagoda 模块建）；
   · 地铁出入口：出口点落在其轮廓内（或 3 m 内）的小体量楼（面积 < 200 m²、高 < 8 m，由 metro 模块建出入口）；
   · 细条碎片：去重叠/去压路裁切剩下的外接矩形宽 < 2.2 m、长 > 6 m、高 > 5 m 的“墙片”（如南大街路中 1.4 m 厚、14.8 m 高的 #104048）。

4. 缺楼片区补楼：CMAB（2022 影像）在空港新城几乎没有楼、OSM 也只有零星几百栋 → 用 3D-GloBFP（Che et al. 2024，
   CC BY 4.0，逐栋轮廓 + 高度）补：空港新城只在 250 m 网格内现有建筑面积 < GloBFP 面积 30% 的缺口格里加（≥ 80 m²）；
   北客站、草滩经开北、浐灞、阎良只补 CMAB 漏掉的中高层（≥ 18 m、≥ 150 m²）。一律与现有楼/档案建筑不重叠、
   不进机场围界与水面；轮廓简化 0.6 m（buildings.bin 预算 ≤ 14 MB）；追加到末尾（flags bit6）。

用法：.venv-tools/bin/python tools/buildings_patch.py [--dry]
      （build_buildings_v2.py 全量重建、check_heights / estate_floors 改写 buildings.bin 之后都要再跑一次；连跑两次结果逐字节相同）
"""
from __future__ import annotations

import collections
import json
import os
import pickle
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bldbin  # noqa: E402
import geo  # noqa: E402

ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'data-src')
DATA = os.path.join(ROOT, 'public', 'data')
BIN = os.path.join(DATA, 'buildings.bin')
DRY = '--dry' in sys.argv

FLAG_FILL = 64      # bit6：3D-GloBFP 补楼（追加段）
FLAG_DROP = 128     # bit7：数据层让位（不渲染）
FUNC_ANTIQUE = 9    # style 功能位 9：仿古商业
FUNC_TO_KIND = {'居住': 1, '商服': 2, '办公': 2, '工业': 3, '公服': 4, '其他': 0, '': 0}


def log(*a):
    print(*a, flush=True)


def ring_area(r):
    x, z = r[:, 0], r[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(z, -1)) - np.dot(z, np.roll(x, -1)))


# ───────────────────────── 0. 读入并去掉旧的追加段 ─────────────────────────
def load():
    B = bldbin.read(BIN)
    fill = (B['flags'] & FLAG_FILL) != 0
    if fill.any():
        first = int(np.argmax(fill))
        assert fill[first:].all(), '补楼段（flags bit6）必须在末尾'
        log(f'去掉上次追加的补楼 {B["n"] - first} 栋')
        keep = np.arange(first)
        B = {k: (v[keep] if isinstance(v, np.ndarray) and v.shape[:1] == (B['n'],) else v) for k, v in B.items()}
        B['n'] = first
        total = int(B['start'][-1] + B['cnt'][-1]) if first else 0
        B['offs'] = B['offs'][:total]
    B['rings'] = [bldbin.ring(B, i) for i in range(B['n'])]
    B['flags'] = B['flags'] & ~np.uint8(FLAG_DROP)   # 让位标记每次重算
    return B


# ───────────────────────── 1. 老城 kind 纠正 ─────────────────────────
def style_func(kind, h, area, cov60, cnt60, office):
    """与 build_buildings_v2.assign_kind_style 同一规则（单栋）。"""
    sf = 0
    if kind == 1:
        sf = 1 if h >= 30 else 2 if h >= 10 else 3
        if h < 13 and area < 450 and cov60 < 0.3:
            sf = 3
    if kind in (0, 1) and area < 400 and cov60 >= 0.4 and cnt60 >= 8 and h <= 26:
        sf = 4
    if kind == 2:
        sf = 5 if office else 6
    if kind == 8:
        sf = 6
    if kind == 3:
        sf = 7
    if kind in (4, 5, 6, 7):
        sf = 8
    return sf


def fix_oldtown_kind(B):
    import shapely
    fp = os.path.join(SRC, 'buildings_v2', 'stage_footprints.pkl')
    fx = os.path.join(SRC, 'buildings_v2', 'stage_features.pkl')
    if not (os.path.exists(fp) and os.path.exists(fx)):
        log('缺少 stage_footprints/stage_features 缓存，跳过老城 kind 纠正')
        return 0
    F = pickle.load(open(fp, 'rb'))
    X = pickle.load(open(fx, 'rb'))
    G = shapely.from_wkb(F['wkb'])
    tags = F['tags']
    wall = np.array([bool(t) and (t.get('barrier') == 'city_wall' or t.get('historic') == 'citywalls') for t in tags])
    cand = np.nonzero(wall)[0]
    tree = shapely.STRtree(G[cand])
    # bin 里的轮廓后来经过去重叠/去压路裁切，锚点不一定还落在原 CMAB 轮廓内：按轮廓相交面积取最大的那一栋（≥ 30%）
    bg = np.array([shapely.Polygon(r) for r in B['rings']], dtype=object)
    qb, qg = tree.query(bg, predicate='intersects')
    inter = shapely.area(shapely.intersection(bg[qb], G[cand[qg]]))
    ba = shapely.area(bg)
    best = {}
    for b, g, a in zip(qb, cand[qg], inter):
        if a >= 0.3 * ba[b] and a > best.get(b, (0, -1))[0]:
            best[b] = (a, g)
    fnames = F['func_names']
    n = 0
    stat = collections.Counter()
    for b, (_, g) in best.items():
        if B['flags'][b] & FLAG_FILL:
            continue
        f = int(F['func'][g])
        fn = fnames[f] if f >= 0 else ''
        k = FUNC_TO_KIND.get(fn, 0)
        r = B['rings'][b]
        sf = style_func(k, float(B['h'][b]), ring_area(r), float(X['cov60'][g]), float(X['cnt60'][g]), fn == '办公')
        B['kind'][b] = k
        B['style'][b] = (B['style'][b] & 15) | (sf << 4)
        stat[fn or '未知'] += 1
        n += 1
    log(f'老城 kind 纠正：{n} 栋（{dict(stat)}）')
    return n


# ───────────────────────── 2. 仿古风貌带 ─────────────────────────
def antique_zones(B):
    import shapely
    n = B['n']
    geoms = np.array([shapely.Polygon(r) for r in B["rings"]], dtype=object)
    garea = shapely.area(geoms)
    cen = shapely.points(B['ax'], B['az'])
    H = B['h']
    mark = np.zeros(n, bool)
    clamp = np.full(n, np.inf)
    why = collections.Counter()
    alive = (B['flags'] & FLAG_FILL) == 0

    # 顺城巷：城墙内侧 30 m 带
    wall = json.load(open(os.path.join(SRC, 'landmarks_historic', 'wall_centerline.json'), encoding='utf-8'))
    poly = shapely.Polygon(wall['polygon'])
    ring = poly.exterior
    inside = shapely.contains(poly, cen)
    dmin = shapely.distance(geoms, ring)
    dcen = shapely.distance(cen, ring)
    band = alive & inside & (dmin <= 37.0) & (dcen <= 50.0) & (dmin >= 12.0)
    mark |= band & (garea <= 4000)   # 限高对带内全部楼；仿古风貌只给中小体量
    clamp[band] = np.minimum(clamp[band], 8.0)
    why['顺城巷城墙内侧带'] = int(band.sum())

    # 沿街第一排：按 roads.json 街名
    roads = json.load(open(os.path.join(DATA, 'roads.json'), encoding='utf-8'))['features']

    def street(name, xr=None, zr=None):
        ls = []
        for e in roads:
            if e.get('n') != name:
                continue
            p = np.array(e['p'], np.float64).reshape(-1, 2)
            if xr is not None:
                p = p[(p[:, 0] >= xr[0]) & (p[:, 0] <= xr[1])]
            if zr is not None:
                p = p[(p[:, 1] >= zr[0]) & (p[:, 1] <= zr[1])]
            if len(p) >= 2:
                ls.append(shapely.LineString(p))
        return shapely.union_all(ls) if ls else None

    def front(L, d_fp, d_cen, hmax, tag):
        if L is None:
            log('  未找到街道', tag)
            return
        # 整个街坊合成一块的超大轮廓（> 4000 m²，商场/大院）不改仿古：一整块灰瓦大屋顶比原来更压抑
        m = alive & inside & (shapely.distance(geoms, L) <= d_fp) & (shapely.distance(cen, L) <= d_cen) & (H <= hmax) & (garea <= 4000)
        mark[m] = True
        why[tag] = int(m.sum())

    front(street('西大街', xr=(-1940, -330)), 34, 80, 40, '西大街（竹笆市—西门）')
    front(street('北院门'), 22, 35, 40, '北院门外围')
    # 书院门步行街：路网里没有这条步行街，按建筑间的东西向空隙（z ≈ 720~731，x 45~470）与“书院门”牌楼 POI 定线
    front(shapely.LineString([(45, 726), (470, 726)]), 14, 35, 30, '书院门')
    front(street('三学街'), 20, 32, 30, '三学街')
    front(street('东大街', xr=(1100, 2150)), 30, 45, 22, '东大街东段')
    front(street('竹笆市'), 18, 30, 24, '竹笆市')

    # 大雁塔北广场两侧 + 慈恩镇（仿唐商业）
    ax, az = B['ax'], B['az']
    m = alive & (((ax >= 1400) & (ax < 1486)) | ((ax > 1658) & (ax <= 1745))) & (az >= 4098) & (az <= 4454) & (H <= 30)
    m |= alive & (ax >= 1272) & (ax <= 1431) & (az >= 4097) & (az <= 4278) & (H <= 30)
    mark |= m
    why['大雁塔北广场两侧/慈恩镇'] = int(m.sum())
    # 大慈恩寺院内（寺域 x 1488~1660、z 4454~4786；中轴与塔院由 pagoda 模块建，其余殿堂僧院按仿古单层殿处理）
    m = alive & (ax >= 1488) & (ax <= 1660) & (az >= 4454) & (az <= 4786)
    mark |= m
    clamp[m] = np.minimum(clamp[m], 7.5)
    why['大慈恩寺院内'] = int(m.sum())

    for i in np.nonzero(mark | np.isfinite(clamp))[0]:
        if mark[i]:
            B['style'][i] = (B['style'][i] & 15) | (FUNC_ANTIQUE << 4)
            if B['kind'][i] in (0, 1, 4, 5):
                B['kind'][i] = 2
        if H[i] > clamp[i]:
            B['h'][i] = clamp[i]
            B['minh'][i] = min(B['minh'][i], 0.0)
    log(f'仿古风貌：{int(mark.sum())} 栋（{dict(why)}），其中限高 {int(np.isfinite(clamp).sum())} 栋')
    return mark


# ───────────────────────── 3. 数据层让位 ─────────────────────────
def drop_marks(B):
    import shapely
    n = B['n']
    ax, az, H = B['ax'], B['az'], B['h']
    area = np.array([ring_area(r) for r in B['rings']])
    drop = np.zeros(n, bool)
    why = collections.Counter()

    def put(m, tag):
        drop[m] = True
        why[tag] += int(m.sum())

    # 张家堡环岛（中心约 (20,-9085)，岛宽约 270 m）
    put(np.hypot(ax - 20, az + 9085) <= 118, '张家堡环岛')
    # 西安站站场（股道区）与南广场
    put((ax >= 1060) & (ax <= 1720) & (az >= -2210) & (az <= -1995) & (H < 30), '西安站站场')
    sq = []
    for f in json.load(open(os.path.join(DATA, 'landuse.json'), encoding='utf-8'))['polys']:
        if f.get('n') == '西安站南广场' and f.get('outer'):
            sq.append(shapely.Polygon(np.array(f['outer']).reshape(-1, 2)))
    if sq:
        put(shapely.contains(shapely.union_all(sq), shapely.points(ax, az)) & (H < 30), '西安站南广场')
    # 荐福寺山门前中轴的小方盒
    put((ax >= -500) & (ax <= -420) & (az >= 2385) & (az <= 2445) & (H <= 4.0), '荐福寺山门前')
    # 玄奘三藏院回廊（pagoda 模块：x 1522~1622、z 4480~4559，外扩 8 m）上的楼
    geoms = np.array([shapely.Polygon(r) for r in B['rings']], dtype=object)
    cor = shapely.box(1514, 4472, 1630, 4567)
    put(shapely.intersects(geoms, cor) & (ax >= 1480) & (ax <= 1665), '玄奘三藏院回廊')
    # 细条碎片：去重叠/去压路裁切剩下的 1~2 m 厚、十几米高的“墙片”（如南大街路中 #104048 宽 1.4 m、高 14.8 m），真实楼不会这么薄
    with np.errstate(all='ignore'):   # 退化轮廓的除零警告
        rect = shapely.oriented_envelope(geoms)
    rc = [shapely.get_coordinates(r) for r in rect]
    thin = np.zeros(n, bool)
    for i, cc in enumerate(rc):
        if len(cc) >= 4:
            a, b = np.hypot(*(cc[1] - cc[0])), np.hypot(*(cc[2] - cc[1]))
            thin[i] = min(a, b) < 2.2 and max(a, b) > 6.0
    put(thin & (H > 5.0) & (B['minh'] < 0.5), '细条碎片')
    # 地铁出入口（metro 模块建标准出入口）
    metro = json.load(open(os.path.join(DATA, 'metro.json'), encoding='utf-8'))
    ex = [(e[0], e[1]) for s in metro.get('stations', []) for e in s.get('exits', [])]
    if ex:
        small = (area < 200) & (H < 8)
        tree = shapely.STRtree(geoms)
        pi, gi = tree.query(shapely.points(np.array(ex)), predicate='dwithin', distance=3.0)
        m = np.zeros(n, bool)
        m[gi] = True
        put(m & small, '地铁出入口')
    B['flags'] = np.where(drop, B['flags'] | FLAG_DROP, B['flags']).astype(np.uint8)
    log(f'数据层让位：{int(drop.sum())} 栋（{dict(why)}）')


# ───────────────────────── 4. 缺楼片区补楼（3D-GloBFP） ─────────────────────────
FILL_REGIONS = [
    # (名称, (西, 南, 东, 北), 最小面积 m², 最小高度 m, 只补缺口格)
    # 空港新城：CMAB/OSM 几乎整片缺楼 → 缺口格内全部补（含低层厂房、仓库）
    ('空港新城', (108.73, 34.385, 108.875, 34.475), 80.0, 0.0, True),
    # 其他审查点名的新区（CMAB 漏检的中高层）：只补 ≥ 18 m、≥ 150 m² 且与现有楼不重叠的
    ('北客站', (108.90, 34.36, 109.00, 34.42), 150.0, 18.0, False),
    ('草滩经开北', (109.00, 34.38, 109.05, 34.45), 150.0, 18.0, False),
    ('浐灞', (108.99, 34.30, 109.08, 34.36), 150.0, 18.0, False),
    ('阎良', (109.17, 34.62, 109.30, 34.70), 150.0, 18.0, False),
]


def fill_globfp(B):
    import shapely
    import build_buildings_v2 as bb
    add_r, add_h = [], []
    exist = np.array([shapely.Polygon(r) for r in B['rings']], dtype=object)
    etree = shapely.STRtree(exist)
    ex_area = shapely.area(exist)
    # 机场围界与水面不补
    aero = json.load(open(os.path.join(DATA, 'aeroway.json'), encoding='utf-8'))
    block = [shapely.Polygon(np.array(a['outer']).reshape(-1, 2)) for a in aero.get('aerodromes', []) if a.get('outer')]
    for w in json.load(open(os.path.join(DATA, 'water.json'), encoding='utf-8')).get('polys', []):
        if w.get('outer') and len(w['outer']) >= 6:
            block.append(shapely.Polygon(np.array(w['outer']).reshape(-1, 2)))
    # 逐栋档案建筑（dossier 模块，不在 buildings.bin 里）
    try:
        for p in json.load(open(os.path.join(DATA, 'dossier_fp.json'), encoding='utf-8')).values():
            if isinstance(p, list) and len(p) >= 6:
                block.append(shapely.Polygon(np.array(p).reshape(-1, 2)))
    except FileNotFoundError:
        pass
    block = shapely.make_valid(shapely.union_all(shapely.make_valid(np.array(block, dtype=object))))
    # 道路面：补楼片区范围内的道路按路宽缓冲（隧道、步道不算）
    boxes = []
    for _, (w0, s0, e0, n0), *_r in FILL_REGIONS:
        xa, za = geo.project(w0, n0)
        xb, zb = geo.project(e0, s0)
        boxes.append(shapely.box(xa, za, xb, zb))
    reg = shapely.union_all(boxes)
    rl = []
    for e in json.load(open(os.path.join(DATA, 'roads.json'), encoding='utf-8'))['features']:
        if e.get('c') == 13 or e.get('t'):
            continue
        p = np.array(e['p'], np.float64).reshape(-1, 2)
        if len(p) < 2:
            continue
        ls = shapely.LineString(p)
        if ls.intersects(reg):
            rl.append(shapely.buffer(ls, (e.get('w') or 6.0) / 2 + 1.0, cap_style='flat'))
    road_area = shapely.union_all(np.array(rl, dtype=object)) if rl else shapely.Polygon()
    for name, bbox, amin, hmin, gap_only in FILL_REGIONS:
        G, Hh = bb.load_globfp(bbox)
        if G is None:
            log('缺少 3D-GloBFP，跳过', name)
            continue
        G = shapely.simplify(G, 0.6, preserve_topology=True)   # 数据预算（buildings.bin ≤ 14 MB）：补楼轮廓简化到 0.6 m
        G = shapely.make_valid(G)
        ok = (shapely.get_type_id(G) == 3) & np.isfinite(Hh)
        G, Hh = G[ok], Hh[ok]
        ga = shapely.area(G)
        gc = shapely.get_coordinates(shapely.centroid(G))
        # 缺口格：250 m 网格内现有楼面积 < GloBFP 面积 30%
        C = 250.0
        key = lambda x, z: (np.floor(x / C).astype(np.int64) << 20) + np.floor(z / C).astype(np.int64)  # noqa: E731
        gk = key(gc[:, 0], gc[:, 1])
        bk = key(B['ax'], B['az'])
        gsum = collections.defaultdict(float)
        bsum = collections.defaultdict(float)
        for k, a in zip(gk, ga):
            gsum[k] += a
        for k, a in zip(bk, ex_area):
            bsum[k] += a
        gap = np.array([gsum[k] > 1500 and bsum.get(k, 0.0) < 0.3 * gsum[k] for k in gk])
        sel = (gap if gap_only else np.ones(len(G), bool)) & (ga >= amin) & (Hh >= hmin) & (ga <= 60000)
        # 与现有楼重叠（相交 > 2 m²）不补
        gi, ei = etree.query(G, predicate='intersects')
        if len(gi):
            inter = shapely.area(shapely.intersection(G[gi], exist[ei]))
            hit = inter > 2.0   # 与现有楼几乎不能相交（穿模检查 gen×gen）
            sel[np.unique(gi[hit])] = False
        sel &= ~shapely.intersects(G, block)
        # 压道路（GloBFP 影像期比路网旧，或轮廓略偏）：与道路面（按路宽缓冲）相交超过 5% 或 15 m² 的不补
        sel[sel] &= shapely.area(shapely.intersection(G[sel], road_area)) <= np.maximum(0.0, np.minimum(15.0, 0.05 * ga[sel]))
        # 补楼之间互相重叠（GloBFP 偶有重复轮廓）：按面积从大到小，与更大者重叠的让位
        keep = np.nonzero(sel)[0]
        keep = keep[np.argsort(-ga[keep])]
        if len(keep):
            kt = shapely.STRtree(G[keep])
            a2, b2 = kt.query(G[keep], predicate='intersects')
            m2 = a2 < b2
            a2, b2 = a2[m2], b2[m2]
            inter = shapely.area(shapely.intersection(G[keep][a2], G[keep][b2]))
            bad = inter > 2.0
            dropk = np.zeros(len(keep), bool)
            dropk[b2[bad]] = True   # 面积小的（排在后面）让位
            keep = keep[~dropk]
        added = []
        for j in keep:
            c = shapely.get_coordinates(shapely.get_exterior_ring(G[j]))[:-1]
            if len(c) < 3 or len(c) > 200:
                continue
            h = float(np.clip(Hh[j], 3.2, 150.0))
            # 按层取整（≤ 24 m 视为 3.0 m 层高的多层/低层）
            if h <= 24:
                h = max(3.2, round(h / 3.0) * 3.0 + 0.6)
            add_r.append(c)
            add_h.append(h)
            added.append(G[j])
        # 各区框有重叠：已补的楼并入“现有楼”，后面的区不再重复补
        if added:
            exist = np.concatenate([exist, np.array(added, dtype=object)])
            ex_area = shapely.area(exist)
            etree = shapely.STRtree(exist)
        log(f'补楼 {name}：GloBFP {len(G)} 栋，{"缺口格内 " + str(int(gap.sum())) + "，" if gap_only else ""}追加 {len(added)} 栋')
    return add_r, add_h


def append(B, rings, hs):
    if not rings:
        return
    import shapely
    k = len(rings)
    # 锚点用质心（与 build_buildings_v2 一致）
    cen = shapely.get_coordinates(shapely.centroid(np.array([shapely.Polygon(r) for r in rings], dtype=object)))
    ax, az = cen[:, 0].astype(np.float32), cen[:, 1].astype(np.float32)
    # 朝向：shoelace > 0
    rr = []
    for r in rings:
        x, z = r[:, 0], r[:, 1]
        s = np.dot(x, np.roll(z, -1)) - np.dot(z, np.roll(x, -1))
        rr.append(r if s > 0 else r[::-1])
    B['rings'] = B['rings'] + rr
    for key, val in (('ax', ax), ('az', az), ('h', np.array(hs)), ('minh', np.zeros(k)),
                     ('kind', np.zeros(k, np.uint8)), ('flags', np.full(k, FLAG_FILL, np.uint8)), ('style', np.zeros(k, np.uint8))):
        B[key] = np.concatenate([B[key], val.astype(B[key].dtype)])
    B['n'] += k


def main():
    B = load()
    n0 = B['n']
    fix_oldtown_kind(B)
    antique_zones(B)
    drop_marks(B)
    rings, hs = fill_globfp(B)
    append(B, rings, hs)
    log(f'合计 {n0} → {B["n"]} 栋')
    if DRY:
        log('--dry：不写文件')
        return
    tmp = BIN + '.part'
    bldbin.write(B, tmp)
    os.replace(tmp, BIN)
    log(f'写出 {BIN}：{os.path.getsize(BIN) / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
