#!/usr/bin/env python3
"""2026-09 地标更新：从 Overture（OSM/ML）建筑中按调研坐标取轮廓 → src/arch/sky-footprints2.js（世界坐标 [x,z,...]，外环 CCW）。
调研：research/refs/{weiyang,qujiang,chanba}/notes*.md"""
import json
import sys

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

sys.path.insert(0, 'tools')
from geo import project

# key: (x, z, 说明)
SEEDS = {
    'xidigang': (-143, -8786, '熙地港 OSM w1372139894'),
    'darongcheng': (181, -8811, '大融城 OSM w1373232024'),
    'wygj': (-74, -8610, '未央国际 OSM r18903164（带内院）'),
    'ihg': (-178, -8925, '经开洲际酒店 OSM'),
    'ehb': (-144, -8979, 'EHB 企业总部大厦（ML 轮廓）'),
    'xuhuiA': (-371, -8747, '旭辉中心 A'),
    'xuhuiB': (-359, -8881, '旭辉中心 B'),
    'zhixuan': (-227, -8731, '智选假日'),
    'wygjzx': (132, -8608, '未央国际中心（OSM 不全）'),
    'meridienT': (6269, -8898, '艾美塔楼'),
    'meridienP': (6281, -8872, '艾美裙房'),
    'jinjiang': (6469, -8625, '锦江国际（原凯宾斯基，欧亚论坛永久会址）'),
    'icc': (6355, -8075, '欧亚国际一期 ICC'),
    'wsite': (3840, 7060, '万众国际/W 酒店裙房（OSM w1370071044）'),
}


def main():
    t = pq.read_table('data-src/overture/building.parquet', columns=['geometry', 'sources', 'names'])
    rows = t.to_pylist()
    geoms, meta = [], []
    for r in rows:
        g = shapely.from_wkb(r['geometry'])
        for pg in ([g] if g.geom_type == 'Polygon' else list(getattr(g, 'geoms', []))):
            geoms.append(pg)
            meta.append(r['sources'][0]['dataset'])
    # 用经纬度查询：先把种子点反投影
    from geo import unproject
    tree = STRtree(geoms)
    out = {}
    for k, (x, z, note) in SEEDS.items():
        lon, lat = unproject(x, z)
        p = Point(lon, lat)
        cand = tree.query(p.buffer(0.0004))
        best = None
        for j in cand:
            g = geoms[j]
            d = g.distance(p)
            score = (0 if g.contains(p) else 1, g.area if g.contains(p) else d)
            if best is None or score < best[0]:
                best = (score, j)
        if best is None:
            print('未找到', k)
            continue
        g = geoms[best[1]]
        ext = [project(a, b) for a, b in g.exterior.coords]
        wp = Polygon(ext, [[project(a, b) for a, b in h.coords] for h in g.interiors]).simplify(0.8)
        ring = np.array(wp.exterior.coords)[:-1]
        sa = 0.5 * np.sum(ring[:, 0] * np.roll(ring[:, 1], -1) - ring[:, 1] * np.roll(ring[:, 0], -1))
        if sa < 0:
            ring = ring[::-1]
        out[k] = np.round(ring, 1).flatten().tolist()
        holes = []
        for h in wp.interiors:
            hr = np.array(h.coords)[:-1]
            holes.append(np.round(hr, 1).flatten().tolist())
        if holes:
            out[k + '_holes'] = holes
        c = wp.centroid
        print(f'{k:12s} {meta[best[1]][:14]:14s} 面积 {wp.area:8.0f} m² 顶点 {len(ring):3d} 质心 ({c.x:.0f},{c.y:.0f}) 内院 {len(holes)}  {note}')
    with open('src/arch/sky-footprints2.js', 'w', encoding='utf-8') as f:
        f.write('// 自动生成（tools/extract_fp2.py）：2026-09 地标更新轮廓，来源 Overture 2026-09-23（OSM / ML），世界坐标 [x,z,...]，外环 CCW\n')
        f.write('export const FP2 = ' + json.dumps(out, separators=(',', ':')) + ';\n')


if __name__ == '__main__':
    main()
