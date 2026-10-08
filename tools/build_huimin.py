#!/usr/bin/env python3
"""回民街 / 洒金桥精细街区数据：OSM 逐户建筑轮廓（Overture 2026-09）+ CMAB 高度迁移 + 临街面识别 + POI 店名。

输出 public/data/huimin.json：
  {"district": [[x,z,...], ...],        # 街区范围（前端注册 exclusions，maxHeight 让低层通用建筑让位）
   "maxH": 15,
   "streets": ["北院门", ...],          # 街名表
   "b": [{"p":[x,z,...], "h":高度, "fl":层数, "fr":[临街边下标...], "st":街名下标|-1, "sg":"店名"|null, "k":类型}],
   "lanes": [{"n":街名, "p":[x,z,...], "w":宽}],   # 挂灯笼串/人流的主街中心线
   "keep": [[x,z,...], ...]}            # 街区内仍由通用建筑模块渲染的现有建筑（高楼 / 锚点在街区外）轮廓：
                                        #   前端据此判断街区内 POI 归属（靠近这些楼的 POI 仍交给 signage，其余由本街区招牌负责）
b 中除 OSM 逐户轮廓外，还补入“被让位但 OSM 没有替代轮廓”的现有建筑空地（CMAB 轮廓扣除 OSM 后的剩余部分），避免出现空地块。

用法：
  python tools/build_huimin.py            # 全量重建（需要 data-src/overture/building.parquet）
  python tools/build_huimin.py --augment  # 增量：在现有 huimin.json 上扩街区（EXTRA_DISTRICT）并补空洞，
                                          #   新增街段的 OSM 轮廓取 data-src/osm/buildings__geofabrik.json（不需要 Overture）
依赖：public/data/buildings.bin、roads.json、pois.json；全量另需 Overture building.parquet，增量另需 geofabrik 建筑 JSON
"""
import json
import math
import os
import sys
import warnings
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

sys.path.insert(0, 'tools')
import bldbin
from geo import project, unproject

warnings.filterwarnings('ignore', category=RuntimeWarning, module='shapely')  # 退化碎片求最小外接矩形时的除零告警

BOX =(-1650.0, -1450.0, -60.0, -15.0)   # x0, z0, x1, z1（世界坐标；钟楼为原点，西大街以北、北大街以西）
MAXH = 15.0     # 让位的通用建筑高度上限
CELL = 40.0
# 手工补充的街区范围（x0, z0, x1, z1, 是否保留其中的大体量现有建筑）：OSM 小建筑密度判定漏掉、但属于回坊街景的街段
EXTRA_DISTRICT = [
    # 洒金桥北段（原街区北界 z≈-800 → 莲湖路南侧人行道 z≈-1128），中线 x≈-1316：西侧 34 m、东侧 16 m 的临街铺面带
    # （审查 g5：西侧无铺面、摊位、店招，像空地）。带内的大体量现有建筑（酒店裙楼、剧院、学校等，见 EXTRA_KEEP_AREA）
    # 从街区里扣掉，仍由通用建筑模块渲染
    (-1350.0, -1128.0, -1300.0, -790.0, True),
    # 北院门南口东侧（鼓楼北、z -168 ~ -116）：CMAB 把这片 2 层灰瓦坡顶的连排铺面并成一块 14.8 m 的大体块，锚点又落在
    # 原街区外，于是由通用建筑模块渲染（黑色大坡顶 + 填充灯箱招牌贴着北院门，夜里近看严重过曝；审查 g4）。并入街区后
    # 按北院门临街规则做成 2 层仿明清街房
    (-318.0, -168.0, -256.0, -116.0, False),
]
# 补充街区内面积超过此值（m²）的现有建筑不让位：从补充街区多边形里扣掉其轮廓（外扩 2 m）
EXTRA_KEEP_AREA = 450.0


def extra_district(cm):
    """补充街区：矩形扣掉其中的大体量现有建筑"""
    big = [c['g'].buffer(2.0, join_style=2) for c in cm if c['g'].area > EXTRA_KEEP_AREA]
    big_u = unary_union(big) if big else Polygon()
    parts = []
    for *b, keep_big in EXTRA_DISTRICT:
        g = box(*b).difference(big_u) if keep_big else box(*b)
        parts += [p for p in parts_of(g) if p.geom_type == 'Polygon' and p.area > 200]
    return parts


# 手工补的建筑（CMAB 与 OSM 都没有、影像上清楚可见的整栋房子；矩形 x0, z0, x1, z1 + 层数）
EXTRA_BUILDINGS = [
    # 庙后街以南、大麦市街东侧两座灰顶大棚房 + 西侧浅色长条楼（影像核对 2026-10；不补的话低空俯视是一块“影像上的假房子”）
    ((-1308.0, -228.0, -1297.0, -199.0), 2),
    ((-1296.0, -226.0, -1280.0, -207.0), 2),
    ((-1278.0, -226.0, -1263.0, -207.0), 2),
]
# 补空地（被让位的 CMAB 粗块扣掉逐户轮廓后的剩余部分）：
#   · OSM 几乎没覆盖（< 20%）：剩余部分做 1 m 开运算后整块补
#   · OSM 已覆盖一部分：剩余部分先扣掉道路走廊，再做 FILL_OPEN 开运算（去掉巷道、院落缝），只补面积 ≥ FILL_MIN_AREA、
#     短边 ≥ FILL_MIN_W 的整块（审查 g5：庙后街—小学习巷一带 60×40 m 空洞，影像上明明是一片屋顶）
FILL_OPEN = 2.0
FILL_MIN_AREA = 45.0
FILL_MIN_W = 5.0
# 主街（挂灯笼串、临街商铺优先）：回民街核心 + 洒金桥
MAIN_LANES = ['北院门', '西羊市', '大皮院', '化觉巷', '北广济街', '洒金桥', '大麦市街', '庙后街', '红埠街',
              '西仓南巷', '大学习巷', '小学习巷', '麦苋街', '桥梓口', '西举院巷', '贡院门', '光明巷']
SHOP_KINDS = {'restaurant', 'fast_food', 'cafe', 'shop', 'food', 'bakery', 'confectionery', 'hotel', 'motel',
              'bank', 'convenience', 'supermarket', 'clothes', 'gift', 'tea', 'ice_cream', 'bar', 'pharmacy'}
# 主街宽度修正（调研：北院门建筑间距约 15 m、西羊市 8、大皮院 11、北广济街 10、洒金桥 10；roads.json 原为 6~6.5）
WFIX = {'北院门': 12.0, '西羊市': 7.0, '大皮院': 8.5, '北广济街': 8.0, '洒金桥': 8.5, '大麦市街': 10.0, '庙后街': 8.0}


def world_poly(g):
    return Polygon([project(a, b) for a, b in g.exterior.coords])


def parts_of(g):
    return list(g.geoms) if hasattr(g, 'geoms') else [g]


def load_cmab(x0, z0, x1, z1):
    B = bldbin.read()
    sel = np.where((B['ax'] > x0 - 60) & (B['ax'] < x1 + 60) & (B['az'] > z0 - 60) & (B['az'] < z1 + 60))[0]
    cm = []
    for i in sel:
        p = Polygon(bldbin.ring(B, i))
        if not p.is_valid:
            p = p.buffer(0)
        cm.append({'i': int(i), 'g': p, 'h': float(B['h'][i]), 'x': float(B['ax'][i]), 'z': float(B['az'][i])})
    return cm


def load_roads(x0, z0, x1, z1):
    R = json.load(open('public/data/roads.json'))
    roads = []
    for f in R['features']:
        p = np.array(f['p']).reshape(-1, 2)
        if p[:, 0].max() < x0 - 50 or p[:, 0].min() > x1 + 50 or p[:, 1].max() < z0 - 50 or p[:, 1].min() > z1 + 50:
            continue
        roads.append({'ls': shapely.LineString(p), 'n': f.get('n', ''), 'w': f['w'], 'c': R['classes'][f['c']]})
    return R, roads, STRtree([r['ls'] for r in roads])


def split_rep_keep(cm, dist, dist_js):
    """被替换的现有低层建筑（前端按锚点落在街区内且 h ≤ MAXH 隐藏）、仍会渲染的现有建筑（高楼 + 锚点在街区外）"""
    rep = [c for c in cm if c['h'] <= MAXH and dist_js.contains(shapely.Point(c['x'], c['z']))]
    rep_ids = {c['i'] for c in rep}
    keep = [c for c in cm if c['i'] not in rep_ids and dist.intersects(c['g'])]
    return rep, keep


class Emitter:
    """把一个轮廓写成 huimin.json 的建筑条目：高度（与被替换建筑面积加权 + 按面积的层数分布）、临街边、街名"""

    def __init__(self, rep, keep, roads, troad, streets=None, out=None):
        self.rep, self.keep, self.roads, self.troad = rep, keep, roads, troad
        self.trep = STRtree([c['g'] for c in rep]) if rep else None
        self.tkeep = STRtree([c['g'] for c in keep]) if keep else None
        self.streets = list(streets or [])
        self.sidx = {s: i for i, s in enumerate(self.streets)}
        self.out = out if out is not None else []

    def overlaps_keep(self, g):
        """与仍会渲染的现有建筑（高楼 / 锚点在街区外的低层）重叠超过 30%：丢弃，避免墙体互相穿插"""
        if self.tkeep is None:
            return False
        return any(g.intersection(self.keep[j]['g']).area > 0.3 * g.area for j in self.tkeep.query(g, predicate='intersects'))

    def emit(self, g, name, nf_osm):
        rep = self.rep
        c = g.centroid
        # 高度：与被替换建筑的面积加权
        hs = [(g.intersection(rep[j]['g']).area, rep[j]['h']) for j in self.trep.query(g, predicate='intersects')] if self.trep else []
        a = sum(x for x, _ in hs)
        hc = sum(x * y for x, y in hs) / a if a > 0.2 * g.area else 0.0
        # 调研（research/refs/huimin/notes.md）：CMAB 在回坊明显偏矮（中位 5.8 m）；实际临街 2 层仿明清街房、
        # 街坊内部 3~5 层自建楼为主。按面积给层数分布（确定性随机），取与 CMAB 的较大值。
        rnd = (math.sin(c.x * 12.9898 + c.y * 78.233) * 43758.5453) % 1
        A = g.area
        if A < 22:
            nf = 1 if rnd < 0.6 else 2
        elif A < 45:
            nf = 2 if rnd < 0.55 else 3
        else:
            nf = 2 if rnd < 0.15 else 3 if rnd < 0.5 else 4 if rnd < 0.88 else 5
        h = max(hc, nf * 3.2 + 0.7)
        if nf_osm:
            h = nf_osm * 3.3 + 0.6
        h = float(min(MAXH + 2.5, max(3.4, h)))
        fl = max(1, min(5, int(round((h - 0.7) / 3.2))))
        ring = np.array(g.exterior.coords)[:-1]
        # CCW（x 东 z 南，shoelace>0）
        sa = 0.5 * np.sum(ring[:, 0] * np.roll(ring[:, 1], -1) - ring[:, 1] * np.roll(ring[:, 0], -1))
        if sa < 0:
            ring = ring[::-1]
        fr, best_st, best_d = [], -1, 1e9
        m = len(ring)
        for k in range(m):
            A, Bp = ring[k], ring[(k + 1) % m]
            d = Bp - A
            L = math.hypot(*d)
            if L < 2.4:
                continue
            mid = (A + Bp) / 2
            # 外法线（CCW，x 东 z 南）：(dz, -dx)/L
            nx, nz = d[1] / L, -d[0] / L
            probe = shapely.Point(mid[0] + nx * 3, mid[1] + nz * 3)
            idx = self.troad.query(probe.buffer(9))
            for j in idx:
                r = self.roads[j]
                dd = r['ls'].distance(probe)
                if dd > max(4.0, r['w'] / 2 + 5):
                    continue
                # 与道路方向夹角
                pp = r['ls'].project(probe)
                q0 = r['ls'].interpolate(max(0, pp - 3))
                q1 = r['ls'].interpolate(pp + 3)
                vx, vz = q1.x - q0.x, q1.y - q0.y
                vl = math.hypot(vx, vz) or 1
                if abs((vx * d[0] + vz * d[1]) / (vl * L)) < 0.85:
                    continue
                fr.append(k)
                if r['n'] and dd < best_d:
                    best_d, best_st = dd, r['n']
                break
        st = -1
        if best_st != -1 and best_st:
            if best_st not in self.sidx:
                self.sidx[best_st] = len(self.streets)
                self.streets.append(best_st)
            st = self.sidx[best_st]
        if best_st == '北院门' and fr:
            h, fl = 7.2, 2
        kind = 'mosque' if (name and '清真' in name and '寺' in name) else ('shop' if fr else 'res')
        self.out.append({'p': np.round(ring, 1).flatten().tolist(), 'h': round(h, 1), 'fl': fl, 'fr': fr, 'st': st,
                         'sg': None, 'k': kind, 'nm': name})


def road_corridor(roads, region):
    """街区内道路走廊（中线按半宽 + 0.5 m 外扩）：补空地不能补到路上"""
    segs = [r['ls'].buffer(r['w'] / 2 + 0.5, cap_style=2) for r in roads if r['ls'].intersects(region)]
    return unary_union(segs) if segs else Polygon()


def fill_gaps(em, region, corridor, relaxed=True):
    """补空地：被让位的现有低层建筑中，逐户轮廓没覆盖到的剩余部分。返回补入的块数。"""
    poly_of = lambda b: Polygon(np.array(b['p']).reshape(-1, 2)).buffer(0)
    hb = [poly_of(b) for b in em.out]
    tree = STRtree(hb) if hb else None
    nfill, filled = 0, []
    for c in em.rep:
        g0 = c['g']
        if g0.is_empty or g0.area < 20 or not region.intersects(g0):
            continue
        near = [hb[j] for j in tree.query(g0, predicate='intersects')] if tree is not None else []
        near += [f for f in filled if f.intersects(g0)]
        cov = unary_union(near).intersection(g0).area if near else 0.0
        rest0 = g0.difference(unary_union(near)) if near else g0
        if cov < 0.2 * g0.area:
            # OSM 几乎没有替代轮廓：开运算去掉细长碎片（< 2 m 宽），再简化
            rest = rest0.buffer(-1.0, join_style=2).buffer(1.0, join_style=2).intersection(rest0).simplify(0.3)
            min_a, min_w = 20.0, 0.0
        elif relaxed:
            rest0 = rest0.difference(corridor)
            rest = rest0.buffer(-FILL_OPEN, join_style=2).buffer(FILL_OPEN, join_style=2).intersection(rest0).simplify(0.3)
            min_a, min_w = FILL_MIN_AREA, FILL_MIN_W
        else:
            continue
        for pg in parts_of(rest):
            if pg.geom_type != 'Polygon' or pg.is_empty or pg.area < min_a or not pg.is_valid:
                continue
            pg = Polygon(pg.exterior)  # 内环（极少）忽略
            if min_w > 0:
                mr = pg.minimum_rotated_rectangle
                xy = np.array(mr.exterior.coords)[:4]
                e = [math.hypot(*(xy[(k + 1) % 4] - xy[k])) for k in range(4)]
                if min(e) < min_w or pg.area < 0.55 * mr.area:
                    continue
            if em.overlaps_keep(pg):
                continue
            em.emit(pg, None, None)
            filled.append(Polygon(np.array(em.out[-1]['p']).reshape(-1, 2)))
            nfill += 1
    return nfill


def assign_signs(out, dist, start=0, used_names=()):
    """POI 店名 → 最近临街建筑（只处理下标 ≥ start 的建筑；已用过的店名不重复挂）"""
    P = json.load(open('public/data/pois.json'))['pois']
    cen = np.array([np.array(b['p']).reshape(-1, 2).mean(axis=0) for b in out])
    used = {j for j in range(start) if out[j].get('sg')}
    names = set(used_names)
    nsign = 0
    for p in P:
        if p['k'] not in SHOP_KINDS or not dist.contains(shapely.Point(p['x'], p['z'])):
            continue
        nm = p['n'].split('(')[0].split('（')[0].strip()
        if nm in names:
            continue
        d = np.hypot(cen[:, 0] - p['x'], cen[:, 1] - p['z'])
        for j in np.argsort(d)[:6]:
            if d[j] > 30:
                break
            if j < start:
                continue
            if out[j]['fr'] and j not in used:
                if 1 < len(nm) <= 12:
                    out[j]['sg'] = nm
                    used.add(j)
                    names.add(nm)
                    nsign += 1
                break
    return nsign


def main_lanes(roads, dist):
    lanes = []
    for r in roads:
        if r['n'] in MAIN_LANES and r['ls'].length > 25 and dist.buffer(15).intersects(r['ls']):
            ls = r['ls'].intersection(dist.buffer(10))
            for part in parts_of(ls):
                if part.geom_type == 'LineString' and part.length > 25:
                    lanes.append({'n': r['n'], 'p': np.round(np.array(part.coords), 1).flatten().tolist(), 'w': r['w']})
    return lanes


def fix_widths(R, dist):
    nfix = 0
    for f in R['features']:
        if f.get('n') in WFIX and f['w'] < WFIX[f['n']]:
            p = np.array(f['p']).reshape(-1, 2)
            if dist.buffer(40).intersects(shapely.LineString(p)):
                f['w'] = WFIX[f['n']]
                nfix += 1
    if nfix:
        with open('public/data/roads.json', 'w', encoding='utf-8') as fp:
            json.dump(R, fp, ensure_ascii=False, separators=(',', ':'))
    return nfix


def keep_rings_of(keep):
    rings = []
    for c in keep:
        g = c['g'] if c['g'].geom_type == 'Polygon' else max(c['g'].geoms, key=lambda x: x.area)
        rings.append(np.round(np.array(g.exterior.coords)[:-1], 1).flatten().tolist())
    return rings


def write_out(dist_rings, streets, out, lanes, keep):
    res = {'district': [r.flatten().tolist() if hasattr(r, 'flatten') else list(r) for r in dist_rings],
           'maxH': MAXH, 'streets': streets, 'b': out, 'lanes': lanes, 'keep': keep_rings_of(keep),
           'source': 'OpenStreetMap（Overture 2026-09-23 + Geofabrik 2026-09-24）轮廓 + CMAB 高度（无 OSM 替代处补 CMAB 轮廓）'}
    for b in out:
        if 'nm' in b and not b['nm']:
            b.pop('nm')
    with open('public/data/huimin.json', 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, separators=(',', ':'))
    print('huimin.json', round(os.path.getsize('public/data/huimin.json') / 1e6, 2), 'MB')


def district_rings(dist):
    polys = parts_of(dist)
    rings = [np.round(np.array(p.exterior.coords)[:-1], 1) for p in polys]
    return rings, unary_union([Polygon(r) for r in rings])


def main():
    import pyarrow.parquet as pq
    x0, z0, x1, z1 = BOX
    w, s = unproject(x0, z1)
    e, n = unproject(x1, z0)
    # —— OSM 建筑 ——
    t = pq.read_table('data-src/overture/building.parquet', columns=['geometry', 'bbox', 'sources', 'names', 'class', 'num_floors'])
    bb = t.column('bbox').to_pylist()
    keep = [i for i, q in enumerate(bb) if q['xmax'] > w and q['xmin'] < e and q['ymax'] > s and q['ymin'] < n]
    rows = t.take(keep).to_pylist()
    osm = []
    for r in rows:
        if r['sources'][0]['dataset'] != 'OpenStreetMap':
            continue
        g = shapely.from_wkb(r['geometry'])
        for pg in parts_of(g):
            wp = world_poly(pg)
            if not wp.is_valid:
                wp = wp.buffer(0)
                if wp.geom_type != 'Polygon':
                    continue
            if wp.area < 10:
                continue
            osm.append({'g': wp, 'name': (r['names'] or {}).get('primary'), 'cls': r['class'], 'nf': r['num_floors']})
    print('OSM 建筑', len(osm))

    cm = load_cmab(x0, z0, x1, z1)
    print('现有建筑', len(cm))

    # —— 街区范围：OSM 小建筑密集的网格 + 手工补充街段 ——
    cnt = defaultdict(int)
    cov = defaultdict(float)
    for o in osm:
        if o['g'].area > 700:
            continue
        c = o['g'].centroid
        k = (int(math.floor(c.x / CELL)), int(math.floor(c.y / CELL)))
        cnt[k] += 1
        cov[k] += o['g'].area
    cells = [box(k[0] * CELL, k[1] * CELL, (k[0] + 1) * CELL, (k[1] + 1) * CELL)
             for k in cnt if cnt[k] >= 5 and cov[k] / CELL ** 2 >= 0.3]
    dist = unary_union(cells).buffer(30, join_style=2).buffer(-38, join_style=2).buffer(8, join_style=2)
    dist = dist.intersection(box(x0, z0, x1, z1))
    polys = [p for p in parts_of(dist) if p.area > 30000]
    dist = unary_union(polys + extra_district(cm)).simplify(1)
    # 与写进 JSON、前端注册排除区完全一致的（0.1 m 取整）轮廓：让位判定按它做，避免边界附近前后端不一致
    dist_rings, dist_js = district_rings(dist)
    print('街区', len(dist_rings), '块，面积', round(dist.area / 1e4, 1), '公顷')

    rep, keep = split_rep_keep(cm, dist, dist_js)
    print('替换现有低层', len(rep), '保留现有建筑', len(keep), '（其中高楼', sum(1 for c in keep if c['h'] > MAXH), '）')
    R, roads, troad = load_roads(x0, z0, x1, z1)
    em = Emitter(rep, keep, roads, troad)

    ndrop = 0
    for o in osm:
        g = o['g']
        if not dist.contains(g.centroid):
            continue
        if em.overlaps_keep(g):
            ndrop += 1
            continue
        em.emit(g, o['name'], o['nf'])
    n_osm = len(em.out)
    for (bx0, bz0, bx1, bz1), nf in EXTRA_BUILDINGS:
        em.emit(box(bx0, bz0, bx1, bz1), None, nf)
    nfill = fill_gaps(em, dist_js, road_corridor(roads, dist_js))
    out = em.out
    print('输出建筑', len(out), '（OSM', n_osm, '，补空地', nfill, '；与保留建筑重叠而丢弃的 OSM', ndrop, '）',
          '临街', sum(1 for b in out if b['fr']))
    print('POI 招牌', assign_signs(out, dist))
    lanes = main_lanes(roads, dist)
    print('主街', len(lanes), sorted({l['n'] for l in lanes}))
    print('主街宽度修正', fix_widths(R, dist), '段')
    write_out(dist_rings, em.streets, out, lanes, keep)


def load_geofabrik(region):
    """Geofabrik 导出的 OSM 建筑（way，含 geometry）：返回质心落在 region 内的轮廓"""
    D = json.load(open('data-src/osm/buildings__geofabrik.json'))['elements']
    x0, z0, x1, z1 = region.bounds
    res = []
    for e in D:
        if e.get('type') != 'way' or 'geometry' not in e:
            continue
        g0 = e['geometry']
        lon = sum(q['lon'] for q in g0) / len(g0)
        lat = sum(q['lat'] for q in g0) / len(g0)
        cx, cz = project(lon, lat)
        if cx < x0 - 80 or cx > x1 + 80 or cz < z0 - 80 or cz > z1 + 80 or len(g0) < 4:
            continue
        g = Polygon([project(q['lon'], q['lat']) for q in g0])
        if not g.is_valid:
            g = g.buffer(0)
            if g.geom_type != 'Polygon':
                continue
        if g.area < 10 or not region.contains(g.centroid):
            continue
        tags = e.get('tags', {})
        lv = tags.get('building:levels')
        try:
            nf = int(float(lv)) if lv else None
        except ValueError:
            nf = None
        res.append({'g': g, 'name': tags.get('name'), 'nf': nf})
    return res


def augment():
    """增量：扩街区（EXTRA_DISTRICT）+ 新街段 OSM 轮廓（Geofabrik）+ 放宽补空地；已有建筑保持不变"""
    H = json.load(open('public/data/huimin.json'))
    old = unary_union([Polygon(np.array(p).reshape(-1, 2)) for p in H['district']])
    dist = unary_union([old] + extra_district(load_cmab(*BOX))).simplify(0.5)
    dist_rings, dist_js = district_rings(dist)
    x0, z0, x1, z1 = dist.bounds
    cm = load_cmab(x0, z0, x1, z1)
    rep, keep = split_rep_keep(cm, dist, dist_js)
    R, roads, troad = load_roads(x0, z0, x1, z1)
    out = H['b']
    n0 = len(out)
    em = Emitter(rep, keep, roads, troad, H['streets'], out)
    # 新街段：OSM 逐户轮廓（与已有轮廓或保留建筑重叠的丢弃）
    new_area = dist_js.difference(old.buffer(0.5))
    hb = STRtree([Polygon(np.array(b['p']).reshape(-1, 2)).buffer(0) for b in out])
    nosm = ndrop = 0
    for o in load_geofabrik(new_area):
        g = o['g']
        if em.overlaps_keep(g) or any(g.intersection(q).area > 0.3 * g.area for q in hb.geometries.take(hb.query(g, predicate='intersects'))):
            ndrop += 1
            continue
        em.emit(g, o['name'], o['nf'])
        nosm += 1
    nman = 0
    for (bx0, bz0, bx1, bz1), nf in EXTRA_BUILDINGS:
        g = box(bx0, bz0, bx1, bz1)
        hb = STRtree([Polygon(np.array(b['p']).reshape(-1, 2)).buffer(0) for b in out])
        if any(g.intersection(q).area > 0.3 * g.area for q in hb.geometries.take(hb.query(g, predicate='intersects'))):
            continue
        em.emit(g, None, nf)
        nman += 1
    nfill = fill_gaps(em, dist_js, road_corridor(roads, dist_js))
    print(f'手工补建 {nman}')
    print(f'增量：原 {n0} 栋，新街段 OSM {nosm}（丢弃 {ndrop}），补空地 {nfill}，合计 {len(out)}；街区 {round(old.area / 1e4, 1)} → {round(dist.area / 1e4, 1)} 公顷')
    used = {b['sg'] for b in out[:n0] if b.get('sg')}
    print('新增 POI 招牌', assign_signs(out, dist, start=n0, used_names=used))
    lanes = main_lanes(roads, dist)
    print('主街', len(lanes), sorted({l['n'] for l in lanes}))
    print('主街宽度修正', fix_widths(R, dist), '段')
    write_out(dist_rings, em.streets, out, lanes, keep)


if __name__ == '__main__':
    if '--augment' in sys.argv:
        augment()
    else:
        main()
