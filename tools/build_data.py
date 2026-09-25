#!/usr/bin/env python3
"""把 OpenStreetMap 与地标研究缓存转换成浏览器端城市数据。

不读取其它项目中的模型代码。原始数据来自本项目 data-src/，转换结果写入 public/data/。
用法：.venv-tools/bin/python tools/build_data.py
"""
from __future__ import annotations

import glob
import json
import math
import os
import re
import shutil
import struct
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import geo  # noqa: E402

SRC = ROOT / 'data-src'
OUT = ROOT / 'public' / 'data'


def read_json(path: Path, fallback=None):
    try:
        with path.open(encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def name_of(tags):
    return (tags.get('name:zh-Hans') or tags.get('name:zh') or tags.get('name') or '').strip()


def numeric(v, default=0.0):
    if v is None:
        return default
    try:
        import re
        m = re.search(r'-?\d+(?:\.\d+)?', str(v).replace(',', '.'))
        return float(m.group()) if m else default
    except (TypeError, ValueError):
        return default


def tag_world(el):
    if 'lon' in el and 'lat' in el:
        return geo.project(float(el['lon']), float(el['lat']))
    c = el.get('center')
    if c and 'lon' in c and 'lat' in c:
        return geo.project(float(c['lon']), float(c['lat']))
    return None


def raw_coords(geom):
    return [(float(p['lon']), float(p['lat'])) for p in (geom or []) if 'lon' in p and 'lat' in p]


def as_world(coords):
    return [geo.project(lon, lat) for lon, lat in coords]


def flat(points):
    return [round(v, 1) for p in points for v in p]


def lines_from_element(el):
    if el.get('type') == 'way':
        p = raw_coords(el.get('geometry'))
        return [p] if len(p) >= 2 else []
    if el.get('type') != 'relation':
        return []
    out = []
    for m in el.get('members', []):
        if m.get('type') == 'way' and m.get('role', 'outer') in ('', 'outer', 'inner'):
            p = raw_coords(m.get('geometry'))
            if len(p) >= 2:
                out.append(p)
    return out


def _segments_to_polygons(segments):
    """把多边形关系某一角色（outer 或 inner）的成员组装成面。

    - 已闭合的成员直接成环；
    - 未闭合的成员片段（Overpass `out geom` 的关系成员常被拆成多段）先整体打结，再 polygonize 拼成闭环；
    - 拼不成闭环的残段直接丢弃，绝不用首尾连线强行闭合（旧实现把河流中心线/残段首尾连线，
      造成灞河、石川河等几百平方公里的错误水面）。
    """
    from shapely.geometry import LineString, Polygon
    from shapely.ops import polygonize, unary_union
    polys, open_lines = [], []
    for seg in segments:
        if len(seg) >= 4 and seg[0] == seg[-1]:
            try:
                p = Polygon(seg)
                if not p.is_valid:
                    p = p.buffer(0)
                polys.extend(g for g in getattr(p, 'geoms', [p]) if g.geom_type == 'Polygon' and not g.is_empty)
            except Exception:
                pass
        elif len(seg) >= 2:
            open_lines.append(LineString(seg))
    if open_lines:
        try:
            polys.extend(p for p in polygonize(unary_union(open_lines)) if not p.is_empty)
        except Exception:
            pass
    return polys


def polygons_from_element(el, allow_open=False):
    """取 way 闭合面；relation 按 outer/inner 角色分别拼环后配对（外环减内环，支持湖中岛内的池塘）。

    allow_open=False 时未闭合的 way 不成面（线状要素如河流中心线、道路不会被误当成面）。
    """
    try:
        from shapely.geometry import Polygon
        from shapely.ops import unary_union
    except ImportError:
        return []
    if el.get('type') == 'way':
        ring = raw_coords(el.get('geometry'))
        if len(ring) < 3:
            return []
        if ring[0] != ring[-1]:
            if not allow_open or len(ring) < 3:
                return []
            ring = ring + [ring[0]]
        outers = _segments_to_polygons([ring])
        inners = []
    elif el.get('type') == 'relation':
        outer_segs, inner_segs = [], []
        for m in el.get('members', []):
            if m.get('type') != 'way':
                continue
            role = m.get('role', '')
            if role not in ('', 'outer', 'inner'):
                continue   # 河流关系的 main_stream/side_stream 等是中心线，不是面边界
            pts = raw_coords(m.get('geometry'))
            if len(pts) < 2:
                continue
            (inner_segs if role == 'inner' else outer_segs).append(pts)
        outers = _segments_to_polygons(outer_segs)
        inners = _segments_to_polygons(inner_segs)
    else:
        return []
    if not outers:
        return []
    try:
        if inners and any(i.contains(o.representative_point()) and i.area > o.area for o in outers for i in inners):
            # 嵌套结构（外环里有内环、内环里又有外环岛），按奇偶规则逐环异或。
            merged = outers[0]
            for g in outers[1:] + inners:
                merged = merged.symmetric_difference(g)
        else:
            merged = unary_union(outers)
            if inners:
                merged = merged.difference(unary_union(inners))
    except Exception:
        try:
            merged = unary_union([o.buffer(0) for o in outers])
        except Exception:
            return []
    if merged.is_empty:
        return []
    if merged.geom_type == 'Polygon':
        return [merged]
    return [g for g in getattr(merged, 'geoms', []) if g.geom_type == 'Polygon' and not g.is_empty]


def world_shapes(el, tolerance=0.8, min_area=20):
    """元素 → 世界坐标（米）下化简后的 shapely Polygon 列表。"""
    from shapely.ops import transform
    out = []
    for poly in polygons_from_element(el):
        # 先转当地米坐标再化简，避免经纬度方向偏差。
        wpoly = transform(lambda x, y, z=None: geo.project(x, y), poly)
        # OSM 原始 Polygon.area 是经纬度平方度；面积阈值必须在米坐标中判断。
        # 先前在投影前比较 100 m² 阈值，会把几乎所有道路边界、机场和绿地都过滤掉。
        if wpoly.area < min_area:
            continue
        tol = tolerance(wpoly.centroid.x, wpoly.centroid.y, wpoly.area) if callable(tolerance) else tolerance
        wpoly = wpoly.simplify(tol, preserve_topology=True)
        if not wpoly.is_valid:
            wpoly = wpoly.buffer(0)
        for g in getattr(wpoly, 'geoms', [wpoly]):
            if g.geom_type == 'Polygon' and not g.is_empty:
                out.append(g)
    return out


def shape_rings(wpoly, min_hole_area=0.0):
    """shapely 世界坐标 Polygon → (外环扁平数组, [内环扁平数组])；外环逆时针（CCW，X 东 Z 南）。"""
    from shapely.geometry.polygon import orient
    wpoly = orient(wpoly, 1.0)
    rings = []
    for idx, ring in enumerate([wpoly.exterior, *wpoly.interiors]):
        if idx and min_hole_area:
            from shapely.geometry import Polygon
            if Polygon(ring).area < min_hole_area:
                continue
        pts = [(round(x, 1), round(y, 1)) for x, y in ring.coords[:-1]]
        if len(pts) >= 3:
            rings.append(flat(pts))
    if not rings:
        return None, []
    return rings[0], rings[1:]


def world_polygons(el, tolerance=0.8, min_area=20):
    out = []
    for wpoly in world_shapes(el, tolerance, min_area):
        rings = []
        for ring in [wpoly.exterior, *wpoly.interiors]:
            pts = [(round(x, 1), round(y, 1)) for x, y in ring.coords[:-1]]
            if len(pts) >= 3:
                rings.append(flat(pts))
        if rings:
            out.append((rings[0], rings[1:], float(wpoly.area)))
    return out


class DemSampler:
    """按 meta.json 登记的网格采样 public/data/dem_main.png（前端实际渲染的地形，Terrarium 编码）。"""

    def __init__(self):
        self.ok = False
        try:
            import numpy as np
            from PIL import Image
        except ImportError:
            return
        meta = read_json(OUT / 'meta.json', {}) or {}
        entry = next((d for d in meta.get('dem', []) if d.get('file') == 'dem_main.png'), None)
        path = OUT / 'dem_main.png'
        if not entry or not path.exists():
            return
        a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64)
        self.np = np
        self.h = (a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768).astype(np.float32)
        b = entry['bounds']
        self.x0, self.x1, self.z0, self.z1 = b['x0'], b['x1'], b['z0'], b['z1']
        self.H, self.W = self.h.shape
        self.dx = (self.x1 - self.x0) / self.W
        self.dz = (self.z1 - self.z0) / self.H
        self.ok = True

    def at(self, x, z):
        c = min(max((x - self.x0) / self.dx - 0.5, 0.0), self.W - 1.001)
        r = min(max((z - self.z0) / self.dz - 0.5, 0.0), self.H - 1.001)
        i, j = int(c), int(r)
        fx, fz = c - i, r - j
        h = self.h
        return float(h[j, i] * (1 - fx) * (1 - fz) + h[j, i + 1] * fx * (1 - fz)
                     + h[j + 1, i] * (1 - fx) * fz + h[j + 1, i + 1] * fx * fz)

    def values(self, wpoly):
        """多边形覆盖到的 DEM 像元高程（像元中心在面内）。"""
        from PIL import Image, ImageDraw
        np = self.np
        minx, minz, maxx, maxz = wpoly.bounds
        i0 = max(0, int((minx - self.x0) / self.dx) - 1)
        i1 = min(self.W, int((maxx - self.x0) / self.dx) + 2)
        j0 = max(0, int((minz - self.z0) / self.dz) - 1)
        j1 = min(self.H, int((maxz - self.z0) / self.dz) + 2)
        if i1 - i0 < 1 or j1 - j0 < 1:
            return np.empty(0, np.float32)
        im = Image.new('L', (i1 - i0, j1 - j0), 0)
        d = ImageDraw.Draw(im)

        def px(coords):
            return [((x - self.x0) / self.dx - 0.5 - i0, (z - self.z0) / self.dz - 0.5 - j0) for x, z in coords]
        d.polygon(px(wpoly.exterior.coords), fill=1)
        for hole in wpoly.interiors:
            d.polygon(px(hole.coords), fill=0)
        m = np.asarray(im, bool)
        return self.h[j0:j1, i0:i1][m]

    def level(self, wpoly, pct):
        """水面建议海拔：面内像元的 pct 分位数；像元太少时取代表点与边界采样的中位数。"""
        np = self.np
        vals = self.values(wpoly)
        if vals.size >= 4:
            return float(np.percentile(vals, pct))
        rp = wpoly.representative_point()
        samples = [self.at(rp.x, rp.y)]
        ring = wpoly.exterior
        for t in range(8):
            q = ring.interpolate(t / 8, normalized=True)
            samples.append(self.at(q.x, q.y))
        return max(samples[0], float(np.median(samples)))


def load_cat(cat):
    paths = sorted(glob.glob(str(SRC / 'osm' / f'{cat}__*.json')))
    seen = {}
    for p in paths:
        for e in read_json(Path(p), {}).get('elements', []):
            seen.setdefault((e.get('type'), e.get('id')), e)
    return list(seen.values())


def load_extra(pattern):
    seen = {}
    for p in sorted(glob.glob(str(pattern))):
        for e in read_json(Path(p), {}).get('elements', []):
            seen.setdefault((e.get('type'), e.get('id')), e)
    return list(seen.values())


def road_output():
    cats = ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service',
            'unclassified', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'pedestrian', 'footway')
    idx = {n: i for i, n in enumerate(cats)}
    feats, seen = [], set()
    # 分区 Overpass 失败时，合入本项目早期窄范围研究缓存中的高速、环线和主干路。
    road_sources = []
    for cat in ('roads_main', 'roads_core', 'roads_detail'):
        road_sources.extend(load_cat(cat))
    for pattern in ('osm_motorways.json', 'osm_ring_roads.json', 'osm_main_roads_named.json', 'osm_bridges_wei.json'):
        road_sources.extend(load_extra(str(SRC / 'airports_research' / pattern)))
    for el in road_sources:
        tags = el.get('tags', {})
        hw = tags.get('highway')
        if hw not in idx or el.get('type') != 'way':
            continue
        key = (el.get('type'), el.get('id'))
        if key in seen:
            continue
        seen.add(key)
        coords = raw_coords(el.get('geometry'))
        if len(coords) < 2:
            continue
        try:
            from shapely.geometry import LineString
            ls = LineString(as_world(coords)).simplify(1.25 if hw in cats[:6] else 0.7, preserve_topology=False)
            p = flat(list(ls.coords))
        except Exception:
            p = flat(as_world(coords))
        if len(p) < 4:
            continue
        lanes = max(1, min(12, round(numeric(tags.get('lanes'), {'motorway': 4, 'trunk': 3, 'primary': 3, 'secondary': 2}.get(hw, 1)))))
        default_width = {'motorway': 30, 'trunk': 25, 'primary': 19, 'secondary': 14, 'tertiary': 10,
                         'residential': 7, 'service': 5, 'unclassified': 7, 'motorway_link': 11,
                         'trunk_link': 10, 'primary_link': 9, 'secondary_link': 8,
                         'pedestrian': 5, 'footway': 2.6}.get(hw, 8)
        width = numeric(tags.get('width'), numeric(tags.get('lanes'), 0) * 3.4 or default_width)
        feats.append({'c': idx[hw], 'n': name_of(tags), 'w': round(max(1.5, min(50, width)), 1), 'l': lanes,
                      'o': int(tags.get('oneway') in ('yes', '1', '-1')), 'b': int(tags.get('bridge') not in (None, 'no')),
                      't': int(tags.get('tunnel') not in (None, 'no')), 'y': round(numeric(tags.get('layer'))), 'p': p})
    write_json('roads.json', {'classes': cats, 'features': feats})
    return len(feats)


def rail_output():
    feats = []
    rail_sources = load_cat('rail')
    rail_sources += load_extra(str(SRC / 'airports_research' / 'osm_rail.json'))
    for el in rail_sources:
        if el.get('type') != 'way':
            continue
        tags = el.get('tags', {})
        railway = tags.get('railway')
        if railway not in ('rail', 'subway', 'light_rail', 'tram', 'narrow_gauge', 'construction', 'monorail'):
            continue
        coords = raw_coords(el.get('geometry'))
        if len(coords) < 2:
            continue
        feats.append({'c': {'rail': 0, 'subway': 1, 'light_rail': 2, 'tram': 2, 'narrow_gauge': 0, 'construction': 0, 'monorail': 2}[railway],
                      'n': name_of(tags) or tags.get('ref', ''), 'w': 5.5 if railway != 'subway' else 4.2,
                      'l': 2 if tags.get('tracks') == '2' else 1, 'o': 0, 'b': int(tags.get('bridge') not in (None, 'no')),
                      't': int(tags.get('tunnel') not in (None, 'no')), 'y': round(numeric(tags.get('layer'))), 'p': flat(as_world(coords))})
    write_json('rail.json', {'classes': ['rail', 'subway', 'light_rail'], 'features': feats})
    return len(feats)


WATER_LINE_WAYS = {'river': 'river', 'canal': 'canal', 'stream': 'canal'}


def water_area_kind(tags, name):
    """水面（面状）要素分类；返回 None 表示不是水面或不该当作水面渲染。

    只有 natural=water / water=* / waterway=riverbank / landuse=reservoir|basin 的闭合面或多边形关系才是水面；
    waterway=river|stream|canal|ditch|drain|dam|weir 等都是线或构筑物，只能进 lines 或丢弃。
    """
    wt = (tags.get('water') or '').lower()
    nat = tags.get('natural')
    lu = tags.get('landuse')
    is_area = nat == 'water' or bool(wt) or tags.get('waterway') == 'riverbank' or lu in ('reservoir', 'basin')
    if not is_area or nat in ('wetland', 'mud', 'sand', 'shingle', 'beach') or tags.get('wetland'):
        return None
    if tags.get('waterway') in ('dam', 'weir', 'lock_gate', 'dock') and nat != 'water':
        return None
    if wt in ('fountain', 'swimming_pool', 'wetland'):
        return None
    if tags.get('intermittent') == 'yes' and wt not in ('river', 'lake', 'reservoir', 'oxbow'):
        return None   # 季节性干涸的景观池、调蓄池，卫星上多数时候是空池
    if tags.get('waterway') == 'riverbank' or wt in ('river', 'riverbank', 'stream', 'rapids'):
        return 'river'
    if wt in ('canal', 'ditch', 'drain'):
        return 'canal'
    if wt == 'moat' or '护城河' in name:
        return 'moat'
    if wt == 'reservoir' or lu == 'reservoir' or re.search(r'水库$', name):
        return 'reservoir'
    if wt in ('basin', 'wastewater', 'lagoon', 'reflecting_pool', 'stream_pool') or lu == 'basin':
        return 'basin'
    if wt in ('pond', 'fishpond'):
        return 'pond'
    if wt in ('lake', 'oxbow'):
        return 'lake'
    if re.search(r'[河江]$', name) or re.search(r'[河江](（[^）]*）)?$', name):
        return 'river'
    if re.search(r'渠$', name):
        return 'canal'
    return 'lake?'   # natural=water 无细分：按面积在后面定成 lake 或 pond


def main_world_box():
    from shapely.geometry import box
    w, s, e, n = geo.BOUNDS['MAIN']
    x0, z0 = geo.project(w, n)
    x1, z1 = geo.project(e, s)
    return box(x0, z0, x1, z1)


def clip_polygons(polys, clip_box):
    for p in polys:
        clipped = p if clip_box.contains(p) else p.intersection(clip_box)
        for g in getattr(clipped, 'geoms', [clipped]):
            if g.geom_type == 'Polygon' and not g.is_empty:
                yield g


def split_by_grid(wpoly, cell=2400.0, min_piece=45000.0):
    """长河道面按世界网格切段，每段单独取水位（渭河在 MAIN 内落差约 40 m，单一水位会一段埋进地里一段悬空）。

    小碎片并入共享边界最长的相邻段，避免 DEM 平整时漏掉窄碎片。
    """
    from shapely.geometry import box
    minx, minz, maxx, maxz = wpoly.bounds
    if max(maxx - minx, maxz - minz) <= cell * 1.25:
        return [wpoly]
    pieces = []
    for gx in range(math.floor(minx / cell), math.floor(maxx / cell) + 1):
        for gz in range(math.floor(minz / cell), math.floor(maxz / cell) + 1):
            try:
                part = wpoly.intersection(box(gx * cell, gz * cell, (gx + 1) * cell, (gz + 1) * cell))
            except Exception:
                continue
            for g in getattr(part, 'geoms', [part]):
                if g.geom_type == 'Polygon' and g.area > 1.0:
                    pieces.append(g)
    if not pieces:
        return [wpoly]
    changed = True
    while changed and len(pieces) > 1:
        changed = False
        pieces.sort(key=lambda p: p.area)
        small = pieces[0]
        if small.area >= min_piece:
            break
        best, best_len = None, 0.0
        for q in pieces[1:]:
            try:
                l = small.boundary.intersection(q.boundary).length
            except Exception:
                l = 0.0
            if l > best_len:
                best, best_len = q, l
        if best is None:
            # 孤立碎片（与其它段不相连）：足够大就保留，否则丢弃。
            pieces.pop(0)
            if small.area >= 2000:
                pieces.append(small)
                if all(p.area >= min_piece or p is small for p in pieces):
                    break
            changed = True
            continue
        merged = small.union(best)
        pieces.remove(best)
        pieces.pop(0)
        pieces.extend(g for g in getattr(merged, 'geoms', [merged]) if g.geom_type == 'Polygon')
        changed = True
    return pieces


def water_output():
    from shapely.geometry import LineString
    from shapely.ops import unary_union
    els = load_cat('water')
    # 河网、渭河及城区湖泊取自本项目缓存，避免主请求失败后水体缺失。
    extras = load_extra(str(SRC / 'airports_research' / 'osm_weihe.json'))
    extras += load_extra(str(SRC / 'dem' / 'osm' / 'water_*.json'))
    extras += load_extra(str(SRC / 'landmarks_historic' / 'osm' / 'qujiang.json'))
    els += extras
    dem = DemSampler()
    if not dem.ok:
        print('[water] 警告：找不到 dem_main.png/meta.json，水位退回常数')
    main_box = main_world_box()
    polys, lines, seen = [], [], set()
    shapes = []   # (wpoly, name, kind)
    line_src = []
    stats = defaultdict(int)
    for el in els:
        tags = el.get('tags', {})
        name = name_of(tags)
        key = (el.get('type'), el.get('id'))
        if key in seen:
            continue
        seen.add(key)
        if el.get('type') == 'way' and tags.get('waterway') in WATER_LINE_WAYS:
            line_src.append(el)
        k = water_area_kind(tags, name)
        if k is None:
            if tags.get('waterway') and tags.get('waterway') not in WATER_LINE_WAYS:
                stats['skip_waterway_' + tags['waterway']] += 1
            continue
        tol = 4.0 if k == 'river' else (0.6 if k == 'moat' else 1.2)
        # 契约：水系只覆盖 MAIN（dem_main 之外没有细地形，水位无从取）。
        for wpoly in clip_polygons(world_shapes(el, tolerance=tol, min_area=60), main_box):
            area = wpoly.area
            kind = k
            if kind == 'lake?':
                # 无细分的 natural=water：狭长的大面（周长²/4π面积 > 14）是河道面，否则按面积分湖/塘。
                elong = wpoly.length ** 2 / (4 * math.pi * max(area, 1.0))
                if elong > 14 and area > 20000:
                    kind = 'river'
                else:
                    kind = 'lake' if (name and area > 8000) or area > 40000 else 'pond'
            c = wpoly.representative_point()
            distance = math.hypot(c.x, c.y)
            if kind == 'moat':
                min_area = 150
            elif kind == 'river':
                min_area = 800 if distance < 35000 else 8000
            elif kind in ('lake', 'reservoir'):
                min_area = 400 if name and distance < 20000 else (1500 if distance < 35000 else 10000)
            elif kind == 'canal':
                min_area = 600 if distance < 20000 else (4000 if distance < 35000 else 15000)
            else:
                min_area = 600 if distance < 12000 else (3000 if distance < 30000 else 15000)
            if area < min_area:
                stats['skip_small'] += 1
                continue
            shapes.append((wpoly, name, kind))

    # 同一水体在不同来源里以不同 id 重复（例如湖面同时被河道面覆盖）：湖/库/塘面优先，河道面让位。
    other_union = unary_union([s for s, _, k in shapes if k != 'river']) if shapes else None
    for wpoly, name, kind in shapes:
        pieces = [wpoly]
        if kind == 'river':
            pieces = split_by_grid(wpoly)
        for piece in pieces:
            if kind == 'river' and other_union is not None and not other_union.is_empty:
                try:
                    if piece.intersects(other_union):
                        diff = piece.difference(other_union)
                        sub = [g for g in getattr(diff, 'geoms', [diff]) if g.geom_type == 'Polygon' and g.area > 300]
                    else:
                        sub = [piece]
                except Exception:
                    sub = [piece]
            else:
                sub = [piece]
            for g in sub:
                outer, holes = shape_rings(g, min_hole_area=40)
                if not outer:
                    continue
                if dem.ok:
                    # 河道取分位高一点：DEM 河道平整后是沿程平滑的下包络面，分段内最高处也要露出水面。
                    h = dem.level(g, 90 if kind == 'river' else 70) + 0.3
                else:
                    h = 364.5 if name == '渭河' else 388.0
                polys.append({'n': name or ('河道' if kind == 'river' else ''), 'k': kind, 'outer': outer, 'holes': holes,
                              'h': round(h, 1), 'a': round(g.area)})
                stats['poly_' + kind] += 1

    # 河流中心线：有面状水面的河段不再画线（前端把“渭河”线强制放宽到 ≥520 m，会把整条中心线画成宽水带），
    # 长线按 ~1.2 km 切段，方便前端按段取地形高度。
    cover = unary_union([s for s, _, _ in shapes]).buffer(12) if shapes else None
    default_w = {'river': 16, 'canal': 8, 'stream': 4}
    for el in line_src:
        tags = el.get('tags', {})
        name = name_of(tags)
        ww = tags.get('waterway')
        if tags.get('tunnel') not in (None, 'no') or tags.get('location') == 'underground':
            stats['line_skip_tunnel'] += 1
            continue
        coords = raw_coords(el.get('geometry'))
        if len(coords) < 2:
            continue
        width = numeric(tags.get('width'), 0)
        if not (1.5 <= width <= 300):
            width = default_w[ww] * (1.5 if ww == 'river' and name else 1.0)
        try:
            line = LineString(as_world(coords))
            if not line.intersects(main_box):
                continue
            line = line.intersection(main_box)
            if cover is not None and line.intersects(cover):
                line = line.difference(cover)
        except Exception:
            continue
        for part in getattr(line, 'geoms', [line]):
            if part.geom_type != 'LineString' or part.length < max(40.0, width * 3):
                continue
            if cover is not None and part.length < 1500:
                # 河面多边形之间的短残段：多是中心线与岸线略有错位（两端都贴着水面），不再单独画成水带。
                from shapely.geometry import Point
                a, b = Point(part.coords[0]), Point(part.coords[-1])
                if a.distance(cover) < 30 and b.distance(cover) < 30:
                    stats['line_skip_gap'] += 1
                    continue
            part = part.simplify(1.5, preserve_topology=False)
            n_chunks = max(1, math.ceil(part.length / 1200.0))
            for ci in range(n_chunks):
                from shapely.ops import substring
                seg = substring(part, ci / n_chunks, (ci + 1) / n_chunks, normalized=True)
                pts = list(seg.coords)
                if len(pts) < 2:
                    continue
                item = {'n': name, 'k': WATER_LINE_WAYS[ww], 'w': round(width, 1), 'p': flat(pts)}
                if dem.ok:
                    item['h'] = round(min(dem.at(x, z) for x, z in pts[:: max(1, len(pts) // 12)] + [pts[-1]]) + 0.2, 1)
                lines.append(item)
                stats['line_' + ww] += 1
    # 城墙护城河由历史城墙中心线生成外侧水道，在前端精确贴合城墙路径。
    write_json('water.json', {'polys': polys, 'lines': lines})
    print('[water] 统计', dict(sorted(stats.items())))
    return len(polys), len(lines)


def landuse_output():
    normalize = {
        'park': 'park', 'garden': 'park', 'forest': 'forest', 'wood': 'forest', 'grass': 'grass', 'grassland': 'grass',
        'residential': 'residential', 'commercial': 'commercial', 'retail': 'commercial', 'industrial': 'industrial',
        'farmland': 'farmland', 'orchard': 'orchard', 'university': 'university', 'cemetery': 'cemetery',
        'military': 'military', 'construction': 'construction', 'square': 'square', 'nature_reserve': 'park',
        'recreation_ground': 'park', 'village_green': 'grass', 'meadow': 'grass', 'scrub': 'forest',
        'school': 'university', 'college': 'university', 'hospital': 'university', 'kindergarten': 'university',
        'grave_yard': 'cemetery', 'greenfield': 'construction',
    }
    polys, seen = [], set()
    elements = load_cat('landuse')
    elements += load_extra(str(SRC / 'landmarks_historic' / 'osm' / 'qujiang.json'))
    elements += load_extra(str(SRC / 'landmarks_historic' / 'osm' / 'others.json'))

    def landuse_tolerance(x, z, area):
        distance = math.hypot(x, z)
        return 0.8 if distance < 8000 else (2.8 if distance < 18000 else (6.5 if distance < 30000 else 16.0))

    for el in elements:
        tags = el.get('tags', {})
        raw = tags.get('landuse') or tags.get('leisure') or tags.get('natural') or tags.get('place') or tags.get('amenity')
        kind = normalize.get(raw)
        if not kind:
            continue
        key = (el.get('type'), el.get('id'))
        if key in seen:
            continue
        seen.add(key)
        for outer, holes, area in world_polygons(el, tolerance=landuse_tolerance, min_area=180):
            cx = sum(outer[::2]) / max(1, len(outer) // 2)
            cz = sum(outer[1::2]) / max(1, len(outer) // 2)
            distance = math.hypot(cx, cz)
            if kind in ('forest', 'orchard', 'farmland', 'grass'):
                min_feature_area = 1200 if distance < 10000 else (5000 if distance < 20000 else (18000 if distance < 35000 else 100000))
            elif kind in ('residential', 'commercial', 'industrial', 'construction'):
                min_feature_area = 250 if distance < 10000 else (900 if distance < 20000 else (4000 if distance < 35000 else 15000))
            else:
                min_feature_area = 180 if distance < 25000 else 1500
            if area < min_feature_area:
                continue
            polys.append({'k': kind, 'n': name_of(tags), 'outer': outer, 'holes': holes})
    write_json('landuse.json', {'polys': polys})
    return len(polys)


def kind_of_building(tags):
    raw = (tags.get('building') or tags.get('building:part') or '').lower()
    if any(x in raw for x in ('apartments', 'residential', 'house', 'detached', 'semidetached', 'dormitory', 'terrace')):
        return 1
    if any(x in raw for x in ('commercial', 'office', 'retail', 'supermarket', 'mall', 'hotel')) or tags.get('office'):
        return 2 if 'hotel' not in raw else 8
    if any(x in raw for x in ('industrial', 'warehouse', 'manufacture', 'hangar', 'farm')):
        return 3
    if any(x in raw for x in ('government', 'civic', 'public', 'museum', 'temple', 'church', 'mosque', 'cathedral')) or tags.get('historic'):
        return 5 if tags.get('historic') or any(x in raw for x in ('temple', 'church', 'mosque')) else 4
    if any(x in raw for x in ('school', 'university', 'college', 'hospital', 'kindergarten')) or tags.get('amenity') in ('school', 'hospital', 'university'):
        return 7
    if any(x in raw for x in ('train_station', 'transportation', 'terminal', 'airport')):
        return 6
    return 0


def building_height(tags, area):
    h = numeric(tags.get('height'), 0)
    measured = h > 0
    if not h:
        levels = numeric(tags.get('building:levels') or tags.get('levels'), 0)
        if levels:
            h = max(3.2, levels * 3.15 + 1.2)
            measured = True
        else:
            raw = (tags.get('building') or '').lower()
            if area > 20000:
                h = 12 if any(x in raw for x in ('industrial', 'warehouse', 'hangar')) else 18
            elif area > 3000:
                h = 17 if any(x in raw for x in ('commercial', 'retail', 'office', 'hotel', 'mall')) else 10
            elif area > 700:
                h = 13 if any(x in raw for x in ('commercial', 'retail', 'office', 'hotel')) else 9
            elif area > 120:
                h = 7.2 if area < 450 else 9.6
            else:
                h = 5.8
    h += numeric(tags.get('roof:height'), 0)
    return max(3.3, min(330, h)), measured


def building_elements():
    by_id = {}
    for cat in ('buildings',):
        for e in load_cat(cat):
            by_id[(e.get('type'), e.get('id'))] = e
    # 机场地面设施与历史景区的地标建筑来自独立窄框查询。
    for pattern in (str(SRC / 'airports_research' / 'osm_xiy_buildings.json'),
                    str(SRC / 'landmarks_historic' / 'osm' / 'qujiang.json'),
                    str(SRC / 'landmarks_historic' / 'osm' / 'others.json'),
                    str(SRC / 'landmarks_modern' / 'osm_tall_named_*.json')):
        for e in load_extra(pattern):
            if e.get('tags', {}).get('building') or e.get('tags', {}).get('building:part'):
                by_id.setdefault((e.get('type'), e.get('id')), e)
    return list(by_id.values())


def skyline_output():
    els = load_extra(str(SRC / 'landmarks_modern' / 'osm_tall_named_*.json'))
    feats, seen = [], set()
    for el in els:
        tags = el.get('tags', {})
        if not (tags.get('building') or tags.get('building:part')) or not name_of(tags):
            continue
        key = (el.get('type'), el.get('id'))
        if key in seen:
            continue
        seen.add(key)
        for outer, holes, area in world_polygons(el, tolerance=0.8, min_area=45):
            n = len(outer) // 2
            from shapely.geometry import Polygon
            poly = Polygon([(outer[i], outer[i + 1]) for i in range(0, len(outer), 2)])
            x, z = poly.centroid.x, poly.centroid.y
            if math.hypot(x, z) > 35000:
                continue
            h, _ = building_height(tags, area)
            levels = numeric(tags.get('building:levels'), 0)
            if h < 44 and levels < 14 and area < 2200:
                continue
            feats.append({'n': name_of(tags), 'x': round(x, 1), 'z': round(z, 1), 'h': round(max(h, levels * 3.1), 1),
                          'levels': round(levels or max(3, h / 3.2)), 'outer': outer, 'area': round(area, 1), 'kind': kind_of_building(tags)})
    # 名称与坐标相同的关系/way 多边形只保留最细的一个。
    feats.sort(key=lambda f: (-f['h'], -f['area']))
    dedup, kept = set(), []
    for f in feats:
        key = (f['n'], round(f['x'] / 12), round(f['z'] / 12))
        if key in dedup:
            continue
        dedup.add(key); kept.append(f)
    write_json('skyline.json', {'features': kept})
    return len(kept)


def buildings_output():
    items, names = [], {}
    try:
        from shapely.geometry import Polygon
    except ImportError:
        write_json('buildings_names.json', {})
        return 0
    skyline = read_json(OUT / 'skyline.json', {}).get('features', [])
    skyline_grid = defaultdict(list)
    for f in skyline:
        skyline_grid[(f['n'], math.floor(f['x'] / 40), math.floor(f['z'] / 40))].append((f['x'], f['z']))

    def has_skyline(name, x, z):
        if not name:
            return False
        gx, gz = math.floor(x / 40), math.floor(z / 40)
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if any(math.hypot(px - x, pz - z) < 30 for px, pz in skyline_grid.get((name, gx + dx, gz + dz), [])):
                    return True
        return False

    for el in building_elements():
        tags = el.get('tags', {})
        if not (tags.get('building') or tags.get('building:part')):
            continue
        if el.get('type') == 'way':
            rings = [raw_coords(el.get('geometry'))]
        else:
            rings = [raw_coords(m.get('geometry')) for m in el.get('members', []) if m.get('type') == 'way' and m.get('role') in ('', 'outer')]
        for ring in rings:
            if len(ring) < 4:
                continue
            try:
                poly = Polygon(as_world(ring))
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty or poly.area < 12:
                    continue
                # CORE 保留细轮廓；外围按视距简化，并移除小型附属棚屋。
                cx, cz = poly.centroid.x, poly.centroid.y
                dist = math.hypot(cx, cz)
                core = -11800 < cx < 11800 and -10300 < cz < 10000
                if not core and poly.area < 32:
                    continue
                tol = 0.5 if core else (1.5 if dist < 32000 else 3.0)
                poly = poly.simplify(tol, preserve_topology=True)
                coords = [(float(x), float(z)) for x, z in list(poly.exterior.coords)[:-1]]
                if len(coords) < 3 or len(coords) > 240:
                    continue
                # 文件用 int16 分米相对质心存储，超过范围的极大厂房再简化后复查。
                anchor = poly.centroid
                offs = [(round((x - anchor.x) * 10), round((z - anchor.y) * 10)) for x, z in coords]
                if any(abs(x) > 32767 or abs(z) > 32767 for x, z in offs):
                    poly = poly.simplify(8.0, preserve_topology=True)
                    anchor = poly.centroid
                    coords = [(float(x), float(z)) for x, z in list(poly.exterior.coords)[:-1]]
                    offs = [(max(-32767, min(32767, round((x - anchor.x) * 10))), max(-32767, min(32767, round((z - anchor.y) * 10)))) for x, z in coords]
                height, measured = building_height(tags, float(poly.area))
                kind = kind_of_building(tags)
                name = name_of(tags)
                flags = int(measured) | (int(bool(name)) << 1) | (int(height >= 75) << 2) | (int(has_skyline(name, anchor.x, anchor.y)) << 3)
                items.append({'x': round(anchor.x, 1), 'z': round(anchor.y, 1), 'offs': offs,
                              'height': round(height * 10), 'min': round(numeric(tags.get('min_height')) * 10),
                              'kind': kind, 'flags': flags, 'name': name})
            except Exception:
                continue
    n = len(items)
    total_verts = sum(len(x['offs']) for x in items)
    path = OUT / 'buildings.bin'
    with path.open('wb') as f:
        f.write(b'XBLD' + struct.pack('<III', 1, n, total_verts))
        for field in ('x', 'z'):
            f.write(struct.pack(f'<{n}f', *(x[field] for x in items)))
        start = 0
        starts, counts = [], []
        for item in items:
            starts.append(start); counts.append(len(item['offs'])); start += len(item['offs'])
        f.write(struct.pack(f'<{n}I', *starts))
        f.write(struct.pack(f'<{n}H', *counts))
        f.write(struct.pack(f'<{n}H', *(x['height'] for x in items)))
        f.write(struct.pack(f'<{n}H', *(x['min'] for x in items)))
        f.write(bytes(x['kind'] for x in items))
        f.write(bytes(x['flags'] for x in items))
        f.write(struct.pack(f'<{total_verts * 2}h', *(v for item in items for pair in item['offs'] for v in pair)))
    for i, item in enumerate(items):
        if item['name']:
            names[str(i)] = item['name']
    write_json('buildings_names.json', names)
    print(f'[buildings] {n:,} 栋，{total_verts:,} 个外环顶点，{path.stat().st_size / 1e6:.2f} MB，命名 {len(names):,}')
    return n


def pois_output():
    source = load_cat('pois') + load_extra(str(SRC / 'landmarks_historic' / 'osm' / '*.json'))
    seen, out = set(), []
    for el in source:
        tags = el.get('tags', {})
        name = name_of(tags)
        if not name:
            continue
        key = (el.get('type'), el.get('id'))
        if key in seen:
            continue
        seen.add(key)
        p = tag_world(el)
        if p is None:
            geom = raw_coords(el.get('geometry'))
            if not geom:
                # 面/线名称取质心点，避免把首点误当成建筑中心。
                poly = polygons_from_element(el)
                if poly:
                    from shapely.ops import transform
                    q = transform(lambda x, y, z=None: geo.project(x, y), poly[0]).representative_point()
                    p = (q.x, q.y)
                else:
                    continue
            else:
                from shapely.geometry import LineString
                q = LineString(as_world(geom)).interpolate(0.5, normalized=True)
                p = (q.x, q.y)
        if math.hypot(p[0], p[1]) > 38000:
            continue
        k = (tags.get('shop') and 'shop') or (tags.get('tourism') and 'hotel' if tags.get('tourism') == 'hotel' else tags.get('tourism')) or tags.get('amenity') or tags.get('historic') or tags.get('railway') or 'landmark'
        out.append({'n': name, 'k': str(k), 'x': round(p[0], 1), 'z': round(p[1], 1)})
        if len(out) >= 20000:
            break
    write_json('pois.json', {'pois': out})
    return len(out)


def airport_output():
    srcs = load_cat('aeroway')
    srcs += load_extra(str(SRC / 'airports_research' / 'osm_xiy_aeroway.json'))
    srcs += load_extra(str(SRC / 'airports_research' / 'osm_yanliang_aeroway.json'))
    srcs += load_extra(str(SRC / 'airports_research' / 'osm_main_aerodromes.json'))
    srcs += load_extra(str(SRC / 'airports_research' / 'osm_xiy_misc.json'))
    srcs += load_extra(str(SRC / 'airports_research' / 'osm_xiy_buildings.json'))
    srcs += load_extra(str(SRC / 'airports_research' / 'osm_t5_rel.json'))
    seen, aerodromes, runways, taxiways, aprons, terminals, gates, helipads = set(), [], [], [], [], [], [], []
    for el in srcs:
        tags = el.get('tags', {})
        key = (el.get('type'), el.get('id'))
        if key in seen:
            continue
        seen.add(key)
        name = name_of(tags)
        aw = tags.get('aeroway')
        ps = world_polygons(el, tolerance=1.5, min_area=90)
        ls = lines_from_element(el)
        if aw in ('aerodrome', 'heliport') and ps:
            for outer, holes, area in ps:
                aerodromes.append({'n': name or '机场', 'iata': tags.get('iata', ''), 'icao': tags.get('icao', ''), 'outer': outer})
        elif aw == 'runway' and ls:
            p = flat(as_world(ls[0])); length = 0
            for i in range(2, len(p), 2): length += math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])
            runways.append({'ref': tags.get('ref', ''), 'w': numeric(tags.get('width'), 45), 'len': round(length), 'p': p})
        elif aw == 'taxiway' and ls:
            taxiways.append({'ref': tags.get('ref', ''), 'w': numeric(tags.get('width'), 22), 'p': flat(as_world(ls[0]))})
        elif aw in ('apron', 'apron_markings') and ps:
            for outer, holes, area in ps:
                aprons.append({'outer': outer})
        elif (aw == 'terminal' or tags.get('building') or tags.get('building:part')) and ps:
            for outer, holes, area in ps:
                if aw == 'terminal' or area > 1200 or re.search(r'航站|航站楼|T[1-5]|terminal|候机', name, re.I):
                    terminals.append({'n': name or tags.get('ref', '航站楼'), 'outer': outer, 'h': numeric(tags.get('height'), 26 if area < 12000 else 36)})
        elif aw == 'gate' and tag_world(el):
            x, z = tag_world(el)
            out_gate = {'ref': tags.get('ref', ''), 'x': round(x, 1), 'z': round(z, 1)}
            # 门位临时缓存，循环之后再写入统一结构。
            if out_gate not in gates:
                gates.append(out_gate)
        elif aw == 'helipad' and (ps or tag_world(el)):
            if ps:
                outer = ps[0][0]; cx = sum(outer[::2]) / (len(outer) / 2); cz = sum(outer[1::2]) / (len(outer) / 2)
            else:
                cx, cz = tag_world(el)
            helipads.append({'n': name, 'x': round(cx, 1), 'z': round(cz, 1)})
    # 机场地名与代码补正为常用中文展示名；机场面几何优先来自 OSM aerodrome 边界。
    for a in aerodromes:
        if '咸阳' in a['n'] or a.get('iata') == 'XIY':
            a['n'], a['iata'], a['icao'] = '西安咸阳国际机场', 'XIY', a.get('icao') or 'ZLXY'
    out = {'aerodromes': aerodromes, 'runways': runways, 'taxiways': taxiways,
           'aprons': aprons, 'terminals': terminals, 'gates': gates, 'helipads': helipads}
    write_json('aeroway.json', out)
    return len(aerodromes), len(runways), len(taxiways), len(terminals)


def landmarks_output():
    wall = read_json(SRC / 'landmarks_historic' / 'wall_centerline.json', {})
    gates = read_json(SRC / 'landmarks_historic' / 'wall_gates.json', {}).get('gates', [])
    mamian = read_json(SRC / 'landmarks_historic' / 'wall_mamian.json', {}).get('mamian', [])
    out = {'wall': wall.get('raw_midline', []), 'gates': gates, 'mamian': mamian}
    write_json('landmarks.json', out)
    # 机场高分辨率影像只用于本地离线兜底；主体街区由按视角加载的在线影像服务提供。
    mosaic_path = SRC / 'airports_research' / 'mosaic_xiy_z16.jpg'
    mosaic_meta = read_json(SRC / 'airports_research' / 'mosaic_xiy_z16.json', {})
    imagery = []
    if mosaic_path.exists() and mosaic_meta.get('bounds'):
        from PIL import Image
        target = OUT / 'img_xiy.jpg'
        with Image.open(mosaic_path) as im:
            im.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
            im.convert('RGB').save(target, 'JPEG', quality=84, optimize=True, progressive=True)
        imagery.append({'file': 'img_xiy.jpg', 'w': im.width, 'h': im.height,
                        'bounds': mosaic_meta['bounds'], 'mpp': 2.0, 'priority': 2})
    return out, imagery


def write_json(name, obj):
    path = OUT / name
    with path.open('w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print(f'[out] {name}: {path.stat().st_size / 1e6:.2f} MB')


VECTOR_STEPS = {
    'roads': lambda: print('[roads]', road_output(), 'segments'),
    'rail': lambda: print('[rail]', rail_output(), 'segments'),
    'water': lambda: print('[water]', water_output()),
    'landuse': lambda: print('[landuse]', landuse_output(), 'polygons'),
    'pois': lambda: print('[pois]', pois_output(), 'named objects'),
}


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--only', default='', help='只重建这些矢量文件（逗号分隔）：' + ','.join(VECTOR_STEPS)
                    + '；指定后不写 buildings.bin / meta.json 等其它产物')
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    start = time.time()
    if args.only:
        for step in [s.strip() for s in args.only.split(',') if s.strip()]:
            if step not in VECTOR_STEPS:
                raise SystemExit(f'未知步骤 {step}，可选：{",".join(VECTOR_STEPS)}')
            VECTOR_STEPS[step]()
        print(f'[done] {time.time() - start:.1f}s')
        return
    landmarks, imagery = landmarks_output()
    print('[roads]', road_output(), 'segments')
    print('[rail]', rail_output(), 'segments')
    print('[water]', water_output())
    print('[landuse]', landuse_output(), 'polygons')
    print('[pois]', pois_output(), 'named objects')
    print('[airports]', airport_output())
    print('[skyline]', skyline_output(), 'named towers')
    print('[buildings]', buildings_output(), 'buildings')
    meta_path = OUT / 'meta.json'
    meta = read_json(meta_path, {'origin': {'lat': geo.LAT0, 'lon': geo.LON0}, 'k': geo.K, 'dem': [], 'sources': []})
    meta['imagery'] = imagery
    if 'online' not in meta:
        meta['online'] = {'maxZoom': 18}
    meta['sources'] = list(dict.fromkeys(meta.get('sources', []) + [
        '© OpenStreetMap contributors — https://www.openstreetmap.org/copyright',
        'FABDEM V1-2 — University of Bristol; CC BY-NC-SA 4.0',
        'Esri World Imagery — Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    ]))
    meta['generated'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    with meta_path.open('w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f'[done] {time.time() - start:.1f}s')


if __name__ == '__main__':
    main()
