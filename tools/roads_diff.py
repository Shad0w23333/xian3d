#!/usr/bin/env python3
"""现有 roads.json 与 Overture 最新路网（2026-09，源自 OSM）逐段比对。
输出 data-src/overture/roads_diff.json：{new:[overture 段下标], stale:[roads.json 下标]} 及统计图。"""
import json
import sys

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.strtree import STRtree

sys.path.insert(0, 'tools')
from geo import project, BOUNDS

OV_CLASS = {'motorway': 'motorway', 'trunk': 'trunk', 'primary': 'primary', 'secondary': 'secondary',
            'tertiary': 'tertiary', 'residential': 'residential', 'living_street': 'residential',
            'unclassified': 'unclassified', 'service': 'service', 'pedestrian': 'pedestrian', 'footway': 'footway'}
MAJOR = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}


def in_box(lon, lat, b):
    return b[0] <= lon <= b[2] and b[1] <= lat <= b[3]


def load_overture():
    t = pq.read_table('data-src/overture/segment.parquet',
                      columns=['id', 'geometry', 'subtype', 'class', 'subclass', 'names', 'road_flags', 'level_rules',
                               'access_restrictions', 'width_rules', 'sources'])
    rows = t.to_pylist()
    out = []
    for r in rows:
        if r['subtype'] != 'road':
            continue
        c = OV_CLASS.get(r['class'])
        if not c:
            continue
        g = shapely.from_wkb(r['geometry'])
        coords = np.array(g.coords)
        lon, lat = coords[:, 0].mean(), coords[:, 1].mean()
        if c in MAJOR or r['subclass'] == 'link':
            if not in_box(lon, lat, BOUNDS['MAIN']):
                continue
        elif c in ('residential', 'unclassified', 'pedestrian'):
            if not in_box(lon, lat, BOUNDS['CORE']):
                continue
        else:
            continue   # service/footway 只用于比对，不新增（新增规则另定）
        w = np.array([project(a, b) for a, b in coords])
        r['world'] = w
        r['cls'] = c
        out.append(r)
    return out


def sample(p, step=10.0):
    seg = np.diff(p, axis=0)
    L = np.hypot(seg[:, 0], seg[:, 1])
    tot = L.sum()
    if tot < 1e-6:
        return p[:1]
    s = np.arange(step / 2, tot, step) if tot > step else np.array([tot / 2])
    cum = np.r_[0, np.cumsum(L)]
    x = np.interp(s, cum, p[:, 0])
    z = np.interp(s, cum, p[:, 1])
    return np.c_[x, z]


def main():
    R = json.load(open('public/data/roads.json'))
    cls = R['classes']
    ex = [np.array(f['p']).reshape(-1, 2) for f in R['features']]
    ex_lines = shapely.linestrings(ex) if False else [shapely.LineString(p) for p in ex]
    ov = load_overture()
    ov_lines = [shapely.LineString(r['world']) for r in ov]
    print('现有', len(ex), 'Overture 候选', len(ov))
    tex = STRtree(ex_lines)
    tov = STRtree(ov_lines)
    # Overture 覆盖参照也包括 service/footway 等全部道路，避免把现有 service 判为消失
    t_all = pq.read_table('data-src/overture/segment.parquet', columns=['geometry', 'subtype']).to_pylist()
    all_lines = []
    for r in t_all:
        if r['subtype'] != 'road':
            continue
        g = shapely.from_wkb(r['geometry'])
        all_lines.append(shapely.LineString([project(a, b) for a, b in g.coords]))
    tall = STRtree(all_lines)
    new, stale = [], []
    for k, r in enumerate(ov):
        pts = sample(r['world'])
        P = shapely.points(pts)
        idx, dist = tex.query_nearest(P, max_distance=40, return_distance=True, all_matches=False)
        d = np.full(len(pts), 1e9)
        d[idx[0]] = dist
        cov = (d < 9).mean()
        if cov < 0.5:
            new.append(k)
    for i, p in enumerate(ex):
        pts = sample(p)
        P = shapely.points(pts)
        idx, dist = tall.query_nearest(P, max_distance=40, return_distance=True, all_matches=False)
        d = np.full(len(pts), 1e9)
        d[idx[0]] = dist
        if (d < 9).mean() < 0.4:
            stale.append(i)
    def km(lines):
        return sum(l.length for l in lines) / 1000
    print(f'新增 {len(new)} 段 {km([ov_lines[k] for k in new]):.0f} km；消失/改线 {len(stale)} 段 {km([ex_lines[i] for i in stale]):.0f} km')
    from collections import Counter
    print('新增按等级', Counter(ov[k]['cls'] for k in new))
    print('消失按等级', Counter(cls[R['features'][i]['c']] for i in stale))
    json.dump({'new_ids': [ov[k]['id'] for k in new], 'stale': stale}, open('data-src/overture/roads_diff.json', 'w'))


if __name__ == '__main__':
    main()
