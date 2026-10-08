#!/usr/bin/env python3
"""公园近景数据：OSM 公园内的园路 / 座椅 / 公厕 / 亭廊 / 导览牌 / 入口 / 栈道 → public/data/parks.json（世界坐标）。

为什么要单独提取：roads.json 的 footway 只收了城墙内与大唐不夜城一带（见 docs/CONTRACT.md 3.5），
兴庆宫公园 OSM 有 227 条园路、丰庆公园/劳动公园也有几十条，原来一条都没画（人眼高度只看到一整片草地）。

规则：
  · 公园范围 = public/data/landuse.json 的 k=park 多边形（与前端一致）；园路中点与 ≥ 50% 顶点落在公园内才收。
  · 已在 roads.json 里的（≥ 60% 顶点离 roads.json 任一折线 < 1.6 m）跳过——那些由 roads 模块画路面。
  · 隧道 / 室内 / 地下层（layer<0）不收；桥（bridge=*）标 b=1（前端画桥面 + 栏杆）。
  · 点要素：amenity=bench/waste_basket/toilets/shelter/drinking_water，tourism=information，leisure=fitness_station，
    entrance=* 与 barrier=gate（公园边界 25 m 内），man_made=pier（栈道/亲水平台，线或面）。
用法：.venv-tools/bin/python tools/build_parks.py   （读 data-src/geofabrik/shaanxi-latest.osm.pbf，约 40 s）
"""
import json
import math
import os
import sys

import osmium

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import geo  # noqa: E402

W, S, E, N = 108.62, 34.02, 109.30, 34.52
PATH_KINDS = {'footway': 2.5, 'path': 1.8, 'pedestrian': 4.0, 'steps': 2.5, 'cycleway': 2.5, 'track': 3.0, 'living_street': 4.0}
CELL = 250.0

# —— 公园多边形（landuse.json）——
lu = json.load(open('public/data/landuse.json'))
parks = []
for p in lu['polys']:
    if p.get('k') != 'park' or len(p.get('outer', [])) < 6:
        continue
    o = p['outer']
    a = abs(sum(o[i] * o[(i + 3) % len(o)] - o[(i + 2) % len(o)] * o[i + 1] for i in range(0, len(o), 2)) / 2)
    if a > 30e6:  # 秦岭自然保护区一类的超大面
        continue
    parks.append({'n': p.get('n', ''), 'o': o, 'holes': p.get('holes', []), 'bb': (min(o[0::2]), min(o[1::2]), max(o[0::2]), max(o[1::2])), 'a': a})
pgrid = {}
for i, p in enumerate(parks):
    x0, z0, x1, z1 = p['bb']
    for cx in range(int(math.floor(x0 / CELL)), int(math.floor(x1 / CELL)) + 1):
        for cz in range(int(math.floor(z0 / CELL)), int(math.floor(z1 / CELL)) + 1):
            pgrid.setdefault((cx, cz), []).append(i)


def pip(x, z, o):
    c = False
    n = len(o) // 2
    j = n - 1
    for i in range(n):
        xi, zi, xj, zj = o[i * 2], o[i * 2 + 1], o[j * 2], o[j * 2 + 1]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            c = not c
        j = i
    return c


def park_at(x, z):
    for i in pgrid.get((int(math.floor(x / CELL)), int(math.floor(z / CELL))), []):
        p = parks[i]
        x0, z0, x1, z1 = p['bb']
        if x0 <= x <= x1 and z0 <= z <= z1 and pip(x, z, p['o']) and not any(pip(x, z, h) for h in p['holes']):
            return p
    return None


def seg_dist(x, z, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    l2 = dx * dx + dz * dz or 1e-9
    t = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / l2))
    return math.hypot(ax + dx * t - x, az + dz * t - z)


def near_park_edge(x, z, r):
    for i in pgrid.get((int(math.floor(x / CELL)), int(math.floor(z / CELL))), []):
        p = parks[i]
        x0, z0, x1, z1 = p['bb']
        if not (x0 - r <= x <= x1 + r and z0 - r <= z <= z1 + r):
            continue
        o = p['o']
        n = len(o) // 2
        for k in range(n):
            j = (k + 1) % n
            if seg_dist(x, z, o[k * 2], o[k * 2 + 1], o[j * 2], o[j * 2 + 1]) < r:
                return p
    return None


# —— roads.json 折线索引（去重）——
roads = json.load(open('public/data/roads.json'))
rgrid = {}
for f in roads['features']:
    p = f['p']
    for i in range(0, len(p) - 2, 2):
        ax, az, bx, bz = p[i], p[i + 1], p[i + 2], p[i + 3]
        for cx in range(int(math.floor((min(ax, bx) - 3) / 50)), int(math.floor((max(ax, bx) + 3) / 50)) + 1):
            for cz in range(int(math.floor((min(az, bz) - 3) / 50)), int(math.floor((max(az, bz) + 3) / 50)) + 1):
                rgrid.setdefault((cx, cz), []).append((ax, az, bx, bz))


def on_roads(x, z, r=1.6):
    for s in rgrid.get((int(math.floor(x / 50)), int(math.floor(z / 50))), []):
        if seg_dist(x, z, *s) < r:
            return True
    return False


def proj_ring(nodes):
    out = []
    for n in nodes:
        x, z = geo.project(n.lon, n.lat)
        out += [round(x, 1), round(z, 1)]
    return out


paths, pts, piers = [], [], []
stats = {'path_all': 0, 'path_dup': 0, 'path_out': 0}


def width_of(t, default):
    try:
        w = float(str(t.get('width', '')).replace('m', '').strip())
        if 0.8 <= w <= 20:
            return w
    except ValueError:
        pass
    return default


class H(osmium.SimpleHandler):
    def node(self, n):
        t = n.tags
        if not len(t):
            return
        lo, la = n.location.lon, n.location.lat
        if not (W < lo < E and S < la < N):
            return
        am, le, to = t.get('amenity'), t.get('leisure'), t.get('tourism')
        kind = None
        if am == 'bench':
            kind = 'bench'
        elif am == 'waste_basket':
            kind = 'bin'
        elif am == 'toilets':
            kind = 'toilet'
        elif am == 'shelter':
            kind = 'shelter'
        elif am == 'drinking_water':
            kind = 'water'
        elif to == 'information' and t.get('information') in ('board', 'map', None, 'guidepost'):
            kind = 'info'
        elif le == 'fitness_station':
            kind = 'fitness'
        elif 'entrance' in t or t.get('barrier') in ('gate', 'entrance'):
            kind = 'gate'
        if not kind:
            return
        x, z = geo.project(lo, la)
        if kind == 'gate':
            p = near_park_edge(x, z, 25)
        else:
            p = park_at(x, z) or near_park_edge(x, z, 8)
        if not p:
            return
        pts.append({'t': kind, 'x': round(x, 1), 'z': round(z, 1), 'pk': p['n'], 'n': t.get('name', '')})

    def way(self, w):
        t = w.tags
        hw = t.get('highway')
        mm = t.get('man_made')
        am = t.get('amenity')
        if not (hw in PATH_KINDS or mm == 'pier' or am in ('toilets', 'shelter')):
            return
        try:
            nodes = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(nodes) < 2:
            return
        lo, la = nodes[len(nodes) // 2]
        if not (W < lo < E and S < la < N):
            return
        flat = []
        for a, b in nodes:
            x, z = geo.project(a, b)
            flat += [round(x, 1), round(z, 1)]
        xs, zs = flat[0::2], flat[1::2]
        closed = len(nodes) > 3 and nodes[0] == nodes[-1]
        if am in ('toilets', 'shelter') and closed:
            cx, cz = sum(xs[:-1]) / (len(xs) - 1), sum(zs[:-1]) / (len(zs) - 1)
            p = park_at(cx, cz)
            if p:
                pts.append({'t': 'toilet' if am == 'toilets' else 'shelter', 'x': round(cx, 1), 'z': round(cz, 1), 'pk': p['n'], 'n': t.get('name', ''), 'poly': flat[:-2], 'bld': 1 if t.get('building') else 0})
            return
        if mm == 'pier':
            cx, cz = sum(xs) / len(xs), sum(zs) / len(zs)
            if not (park_at(cx, cz) or near_park_edge(cx, cz, 30)):
                return
            piers.append({'p': flat[:-2] if closed else flat, 'area': 1 if closed and t.get('area') != 'no' else 0, 'w': width_of(t, 2.4)})
            return
        # —— 园路 ——
        if t.get('tunnel') in ('yes', 'building_passage') or t.get('indoor') == 'yes' or t.get('level', '0').startswith('-'):
            return
        try:
            if int(t.get('layer', '0')) < 0:
                return
        except ValueError:
            pass
        if t.get('access') in ('private', 'no'):
            return
        stats['path_all'] += 1
        inside = sum(1 for i in range(len(xs)) if park_at(xs[i], zs[i]))
        mid = park_at((xs[len(xs) // 2] + xs[(len(xs) - 1) // 2]) / 2, (zs[len(zs) // 2] + zs[(len(zs) - 1) // 2]) / 2)
        if inside * 2 < len(xs) or not (mid or inside == len(xs)):
            stats['path_out'] += 1
            return
        dup = sum(1 for i in range(len(xs)) if on_roads(xs[i], zs[i]))
        if dup >= 0.6 * len(xs):
            stats['path_dup'] += 1
            return
        pk = mid or park_at(xs[0], zs[0])
        paths.append({
            'k': hw, 'w': width_of(t, PATH_KINDS[hw]), 'b': 1 if t.get('bridge') not in (None, 'no') else 0,
            'p': flat, 'pk': pk['n'] if pk else '', 's': t.get('surface', ''),
        })


h = H()
h.apply_file('data-src/geofabrik/shaanxi-latest.osm.pbf', locations=True)
out = {
    'version': 1,
    'source': 'OpenStreetMap（Geofabrik shaanxi-latest）：公园内园路、座椅、公厕、亭廊、导览牌、入口、栈道',
    'paths': paths, 'pts': pts, 'piers': piers,
}
json.dump(out, open('public/data/parks.json', 'w'), ensure_ascii=False, separators=(',', ':'))
from collections import Counter  # noqa: E402
print(f"园路 {len(paths)} 条（候选 {stats['path_all']}，公园外 {stats['path_out']}，与 roads.json 重复 {stats['path_dup']}）；"
      f"点 {len(pts)} {dict(Counter(p['t'] for p in pts))}；栈道 {len(piers)} → public/data/parks.json "
      f"{os.path.getsize('public/data/parks.json') / 1e6:.2f} MB")
