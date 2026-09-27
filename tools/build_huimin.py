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
依赖：data-src/overture/building.parquet（tools/fetch_overture.py）、public/data/buildings.bin、roads.json、pois.json
"""
import json
import math
import sys
from collections import defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

sys.path.insert(0, 'tools')
import bldbin
from geo import project, unproject

BOX = (-1650.0, -1450.0, -60.0, -15.0)   # x0, z0, x1, z1（世界坐标；钟楼为原点，西大街以北、北大街以西）
MAXH = 15.0     # 让位的通用建筑高度上限
CELL = 40.0
# 主街（挂灯笼串、临街商铺优先）：回民街核心 + 洒金桥
MAIN_LANES = ['北院门', '西羊市', '大皮院', '化觉巷', '北广济街', '洒金桥', '大麦市街', '庙后街', '红埠街',
              '西仓南巷', '大学习巷', '小学习巷', '麦苋街', '桥梓口', '西举院巷', '贡院门', '光明巷']
SHOP_KINDS = {'restaurant', 'fast_food', 'cafe', 'shop', 'food', 'bakery', 'confectionery', 'hotel', 'motel',
              'bank', 'convenience', 'supermarket', 'clothes', 'gift', 'tea', 'ice_cream', 'bar', 'pharmacy'}


def world_poly(g):
    return Polygon([project(a, b) for a, b in g.exterior.coords])


def main():
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
        parts = [g] if g.geom_type == 'Polygon' else list(getattr(g, 'geoms', []))
        for pg in parts:
            wp = world_poly(pg)
            if not wp.is_valid:
                wp = wp.buffer(0)
                if wp.geom_type != 'Polygon':
                    continue
            if wp.area < 10:
                continue
            osm.append({'g': wp, 'name': (r['names'] or {}).get('primary'), 'cls': r['class'], 'nf': r['num_floors']})
    print('OSM 建筑', len(osm))

    # —— CMAB/现有建筑 ——
    B = bldbin.read()
    sel = np.where((B['ax'] > x0 - 60) & (B['ax'] < x1 + 60) & (B['az'] > z0 - 60) & (B['az'] < z1 + 60))[0]
    cm = []
    for i in sel:
        p = Polygon(bldbin.ring(B, i))
        if not p.is_valid:
            p = p.buffer(0)
        cm.append({'i': int(i), 'g': p, 'h': float(B['h'][i]), 'x': float(B['ax'][i]), 'z': float(B['az'][i])})
    print('现有建筑', len(cm))

    # —— 街区范围：OSM 小建筑密集的网格 ——
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
    polys = [p for p in (dist.geoms if dist.geom_type == 'MultiPolygon' else [dist]) if p.area > 30000]
    dist = unary_union(polys).simplify(4)
    polys = [p for p in (dist.geoms if dist.geom_type == 'MultiPolygon' else [dist])]
    # 与写进 JSON、前端注册排除区完全一致的（0.1 m 取整）轮廓：让位判定按它做，避免边界附近前后端不一致
    dist_rings = [np.round(np.array(p.exterior.coords)[:-1], 1) for p in polys]
    dist_js = unary_union([Polygon(r) for r in dist_rings])
    print('街区', len(polys), '块，面积', round(dist.area / 1e4, 1), '公顷')

    # —— 被替换的现有低层建筑（前端按锚点落在街区内且 h ≤ MAXH 隐藏）、仍会渲染的现有建筑（高楼 + 锚点在街区外） ——
    rep = [c for c in cm if c['h'] <= MAXH and dist_js.contains(shapely.Point(c['x'], c['z']))]
    rep_ids = {c['i'] for c in rep}
    keep = [c for c in cm if c['i'] not in rep_ids and dist.intersects(c['g'])]
    trep = STRtree([c['g'] for c in rep])
    tkeep = STRtree([c['g'] for c in keep]) if keep else None
    print('替换现有低层', len(rep), '保留现有建筑', len(keep), '（其中高楼', sum(1 for c in keep if c['h'] > MAXH), '）')

    # —— 道路（临街面识别） ——
    R = json.load(open('public/data/roads.json'))
    roads = []
    for f in R['features']:
        p = np.array(f['p']).reshape(-1, 2)
        if p[:, 0].max() < x0 - 50 or p[:, 0].min() > x1 + 50 or p[:, 1].max() < z0 - 50 or p[:, 1].min() > z1 + 50:
            continue
        roads.append({'ls': shapely.LineString(p), 'n': f.get('n', ''), 'w': f['w'], 'c': R['classes'][f['c']]})
    troad = STRtree([r['ls'] for r in roads])

    streets = []
    sidx = {}
    out = []

    def overlaps_keep(g):
        """与仍会渲染的现有建筑（高楼 / 锚点在街区外的低层）重叠超过 30%：丢弃，避免墙体互相穿插"""
        if tkeep is None:
            return False
        return any(g.intersection(keep[j]['g']).area > 0.3 * g.area for j in tkeep.query(g, predicate='intersects'))

    def emit(g, name, nf_osm):
        c = g.centroid
        # 高度：与被替换建筑的面积加权
        hs = [(g.intersection(rep[j]['g']).area, rep[j]['h']) for j in trep.query(g, predicate='intersects')]
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
            idx = troad.query(probe.buffer(9))
            for j in idx:
                r = roads[j]
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
            if best_st not in sidx:
                sidx[best_st] = len(streets)
                streets.append(best_st)
            st = sidx[best_st]
        if best_st == '北院门' and fr:
            h, fl = 7.2, 2
        kind = 'mosque' if (name and '清真' in name and '寺' in name) else ('shop' if fr else 'res')
        out.append({'p': np.round(ring, 1).flatten().tolist(), 'h': round(h, 1), 'fl': fl, 'fr': fr, 'st': st,
                    'sg': None, 'k': kind, 'nm': name})

    ndrop = 0
    for o in osm:
        g = o['g']
        if not dist.contains(g.centroid):
            continue
        if overlaps_keep(g):
            ndrop += 1
            continue
        emit(g, o['name'], o['nf'])
    n_osm = len(out)

    # —— 补空地：被让位的现有低层建筑中，OSM 几乎没有替代轮廓（覆盖 < 20%）的，用其轮廓扣掉 OSM 后的剩余部分补建 ——
    #   （覆盖较多的保持空缺：剩余部分多为院落/巷道，CMAB 粗块在这里本就偏大）
    osm_g = [Polygon(np.array(b['p']).reshape(-1, 2)) for b in out]
    tosm = STRtree(osm_g)
    nfill, filled = 0, []
    for c in rep:
        g0 = c['g']
        if g0.is_empty or g0.area < 20:
            continue
        near = [osm_g[j] for j in tosm.query(g0, predicate='intersects')]
        cov = unary_union(near).intersection(g0).area if near else 0.0
        if cov >= 0.2 * g0.area:
            continue
        # CMAB 轮廓之间偶有重叠：再扣掉已补的空地块
        near_all = near + [f for f in filled if f.intersects(g0)]
        rest0 = g0.difference(unary_union(near_all)) if near_all else g0
        # 开运算去掉细长碎片（< 2 m 宽），再简化
        rest = rest0.buffer(-1.0, join_style=2).buffer(1.0, join_style=2).intersection(rest0).simplify(0.3)
        for pg in (rest.geoms if hasattr(rest, 'geoms') else [rest]):
            if pg.geom_type != 'Polygon' or pg.is_empty or pg.area < 20 or not pg.is_valid:
                continue
            pg = Polygon(pg.exterior)  # 内环（极少）忽略
            if overlaps_keep(pg):
                continue
            emit(pg, None, None)
            filled.append(Polygon(np.array(out[-1]['p']).reshape(-1, 2)))
            nfill += 1
    print('输出建筑', len(out), '（OSM', n_osm, '，补空地', nfill, '；与保留建筑重叠而丢弃的 OSM', ndrop, '）',
          '临街', sum(1 for b in out if b['fr']))

    # —— POI 店名 → 最近临街建筑 ——
    P = json.load(open('public/data/pois.json'))['pois']
    cen = np.array([np.array(b['p']).reshape(-1, 2).mean(axis=0) for b in out])
    used = set()
    nsign = 0
    for p in P:
        if p['k'] not in SHOP_KINDS or not dist.contains(shapely.Point(p['x'], p['z'])):
            continue
        d = np.hypot(cen[:, 0] - p['x'], cen[:, 1] - p['z'])
        for j in np.argsort(d)[:6]:
            if d[j] > 30:
                break
            if out[j]['fr'] and j not in used:
                nm = p['n'].split('(')[0].split('（')[0].strip()
                if 1 < len(nm) <= 12:
                    out[j]['sg'] = nm
                    used.add(j)
                    nsign += 1
                break
    print('POI 招牌', nsign)

    # —— 主街中心线 ——
    lanes = []
    for r in roads:
        if r['n'] in MAIN_LANES and r['ls'].length > 25 and dist.buffer(15).intersects(r['ls']):
            ls = r['ls'].intersection(dist.buffer(10))
            for part in (ls.geoms if hasattr(ls, 'geoms') else [ls]):
                if part.geom_type == 'LineString' and part.length > 25:
                    lanes.append({'n': r['n'], 'p': np.round(np.array(part.coords), 1).flatten().tolist(), 'w': r['w']})
    print('主街', len(lanes), sorted({l['n'] for l in lanes}))

    # —— 主街宽度修正（调研：北院门建筑间距约 15 m、西羊市 8、大皮院 11、北广济街 10、洒金桥 10；roads.json 原为 6~6.5）——
    WFIX = {'北院门': 12.0, '西羊市': 7.0, '大皮院': 8.5, '北广济街': 8.0, '洒金桥': 8.5, '大麦市街': 10.0, '庙后街': 8.0}
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
    print('主街宽度修正', nfix, '段')

    keep_rings = []
    for c in keep:
        g = c['g'] if c['g'].geom_type == 'Polygon' else max(c['g'].geoms, key=lambda x: x.area)
        keep_rings.append(np.round(np.array(g.exterior.coords)[:-1], 1).flatten().tolist())
    res = {'district': [r.flatten().tolist() for r in dist_rings],
           'maxH': MAXH, 'streets': streets, 'b': out, 'lanes': lanes, 'keep': keep_rings,
           'source': 'OpenStreetMap（Overture 2026-09-23）轮廓 + CMAB 高度（无 OSM 替代处补 CMAB 轮廓）'}
    for b in out:
        if not b['nm']:
            b.pop('nm')
    with open('public/data/huimin.json', 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, separators=(',', ':'))
    import os
    print('huimin.json', round(os.path.getsize('public/data/huimin.json') / 1e6, 2), 'MB')


if __name__ == '__main__':
    main()
