#!/usr/bin/env python3
"""用 Overture 2026-09 路网（源自最新 OSM）增量更新 public/data/roads.json：
  - 新增：Overture 中有、现有数据里没有（10 m 采样点 <50% 落在现有道路 9 m 内）的路段
  - 删除：现有数据中有、Overture 已没有（在 Overture 抓取范围内的采样点 <40% 有对应）的路段
  - 保留：其余现有路段原样（保留 OSM lanes/width 等精细属性）
先运行 tools/fetch_overture.py --theme transportation --type segment --bbox 108.60,33.95,109.40,34.72
原始 roads.json 备份为 data-src/roads.before_overture.json。"""
import json
import os
import shutil
import sys
from collections import Counter

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.strtree import STRtree

sys.path.insert(0, 'tools')
from geo import project, BOUNDS
from build_data import (ROAD_CLASSES, ROAD_LANE_W, ROAD_LANES_ONEWAY, ROAD_LANES_TWOWAY, ROAD_EXTRA_ONEWAY,
                        ROAD_EXTRA_TWOWAY)

OV_CLASS = {'motorway': 'motorway', 'trunk': 'trunk', 'primary': 'primary', 'secondary': 'secondary',
            'tertiary': 'tertiary', 'residential': 'residential', 'living_street': 'residential',
            'unclassified': 'unclassified', 'pedestrian': 'pedestrian'}
MAJOR = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}
FETCH_BOX = (108.60, 33.95, 109.40, 34.72)


def in_box(lon, lat, b):
    return b[0] <= lon <= b[2] and b[1] <= lat <= b[3]


def sample(p, step=10.0):
    seg = np.diff(p, axis=0)
    L = np.hypot(seg[:, 0], seg[:, 1])
    tot = L.sum()
    if tot < 1e-6:
        return p[:1]
    s = np.arange(step / 2, tot, step) if tot > step else np.array([tot / 2])
    cum = np.r_[0, np.cumsum(L)]
    return np.c_[np.interp(s, cum, p[:, 0]), np.interp(s, cum, p[:, 1])]


def coverage(tree, pts, tol=9.0):
    idx, dist = tree.query_nearest(shapely.points(pts), max_distance=tol * 3, return_distance=True, all_matches=False)
    d = np.full(len(pts), 1e9)
    d[idx[0]] = dist
    return d < tol


def attrs(r, cls):
    """由 Overture 属性推导 (w, l, o, b, t, y)。无 lanes 信息，按等级默认车道数。"""
    oneway = False
    for a in r['access_restrictions'] or []:
        w = a.get('when') or {}
        if a.get('access_type') == 'denied' and w.get('heading') == 'backward' and not w.get('mode') and not w.get('using') \
                and not w.get('vehicle') and not a.get('between'):
            oneway = True
    b = t = 0
    for f in r['road_flags'] or []:
        if f.get('between'):
            lo, hi = f['between']
            if hi - lo < 0.5:
                continue
        v = f.get('values') or []
        b |= 'is_bridge' in v
        t |= 'is_tunnel' in v
    y = 0
    for lv in r['level_rules'] or []:
        if not lv.get('between'):
            y = int(lv.get('value') or 0)
    if b and y <= 0:
        y = 1
    if t and y >= 0:
        y = -1
    hw = cls + '_link' if (r['subclass'] == 'link' and cls in ('motorway', 'trunk', 'primary', 'secondary')) else cls
    if cls == 'pedestrian':
        return hw, 6.0, 1, 0, b, t, y
    lanes = (ROAD_LANES_ONEWAY if oneway else ROAD_LANES_TWOWAY).get(hw, 1)
    width = lanes * ROAD_LANE_W.get(hw, 3.0) + (ROAD_EXTRA_ONEWAY if oneway else ROAD_EXTRA_TWOWAY).get(hw, 0.5)
    for wr in r['width_rules'] or []:
        v = wr.get('value')
        if v and not wr.get('between') and 0.6 * width <= v <= 2.2 * width and 2.5 <= v <= 60:
            width = v
    return hw, round(max(2.5, min(45.0, width)), 1), lanes, int(oneway), int(b), int(t), max(-5, min(5, y))


def main():
    src = 'public/data/roads.json'
    bak = 'data-src/roads.before_overture.json'
    if not os.path.exists(bak):
        shutil.copy(src, bak)
    R = json.load(open(bak))
    cls_idx = {n: i for i, n in enumerate(R['classes'])}
    assert tuple(R['classes']) == ROAD_CLASSES
    ex = [np.array(f['p'], np.float64).reshape(-1, 2) for f in R['features']]
    tex = STRtree([shapely.LineString(p) for p in ex])

    rows = pq.read_table('data-src/overture/segment.parquet',
                         columns=['id', 'geometry', 'subtype', 'class', 'subclass', 'names', 'road_flags', 'level_rules',
                                  'access_restrictions', 'width_rules']).to_pylist()
    all_lines, cand = [], []
    for r in rows:
        if r['subtype'] != 'road':
            continue
        g = shapely.from_wkb(r['geometry'])
        w = np.array([project(a, b) for a, b in g.coords])
        all_lines.append(shapely.LineString(w))
        c = OV_CLASS.get(r['class'])
        if not c:
            continue
        lon, lat = np.array(g.coords).mean(axis=0)
        if c in MAJOR:
            if not in_box(lon, lat, BOUNDS['MAIN']):
                continue
        elif not in_box(lon, lat, BOUNDS['CORE']):
            continue
        r['w'], r['cls'] = w, c
        cand.append(r)
    tall = STRtree(all_lines)

    added = []
    for r in cand:
        cov = coverage(tex, sample(r['w']))
        if cov.mean() >= 0.5:
            continue
        hw, width, lanes, o, b, t, y = attrs(r, r['cls'])
        ls = shapely.LineString(r['w']).simplify(1.25 if r['cls'] in MAJOR else 0.7, preserve_topology=False)
        p = np.round(np.array(ls.coords), 1)
        if len(p) < 2 or ls.length < 15:
            continue
        name = ((r['names'] or {}).get('primary') or '')
        added.append({'c': cls_idx[hw], 'n': name, 'w': width, 'l': lanes, 'o': o, 'b': b, 't': t, 'y': y,
                      'p': p.flatten().tolist(), 'src': 'ovt'})

    fx0, fz1 = project(FETCH_BOX[0], FETCH_BOX[1])
    fx1, fz0 = project(FETCH_BOX[2], FETCH_BOX[3])
    removed = []
    keep = []
    for i, p in enumerate(ex):
        pts = sample(p)
        inside = (pts[:, 0] > fx0 + 50) & (pts[:, 0] < fx1 - 50) & (pts[:, 1] > fz0 + 50) & (pts[:, 1] < fz1 - 50)
        f0 = R['features'][i]
        # 保护：步行街/人行道（新版 OSM 常改成面状步行区，不再是线）与城墙内街巷（人工核对过）
        protect = ROAD_CLASSES[f0['c']] in ('pedestrian', 'footway') or (-1950 < pts[:, 0].mean() < 2350 and -2100 < pts[:, 1].mean() < 1680)
        if inside.sum() >= 3 and not protect:
            cov = coverage(tall, pts[inside])
            if cov.mean() < 0.4:
                removed.append(i)
                continue
        keep.append(R['features'][i])
    feats = keep + added
    km = lambda fs: sum(shapely.LineString(np.array(f['p']).reshape(-1, 2)).length for f in fs) / 1000
    print(f'[roads_update] 原 {len(R["features"])} 段；删除 {len(removed)} 段 {km([R["features"][i] for i in removed]):.1f} km；'
          f'新增 {len(added)} 段 {km(added):.1f} km')
    print('  新增等级', Counter(ROAD_CLASSES[f['c']] for f in added))
    print('  删除等级', Counter(ROAD_CLASSES[R['features'][i]['c']] for i in removed))
    print('  删除路名', Counter(R['features'][i]['n'] for i in removed).most_common(20))
    print('  新增路名', Counter(f['n'] for f in added).most_common(30))
    for f in added:
        f.pop('src', None)
    with open(src, 'w', encoding='utf-8') as fp:
        json.dump({'classes': R['classes'], 'features': feats}, fp, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()
