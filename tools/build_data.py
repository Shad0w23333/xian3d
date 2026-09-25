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


ROAD_CLASSES = ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service',
                'unclassified', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'pedestrian', 'footway')
ROAD_ALIAS = {'living_street': 'residential', 'road': 'unclassified'}
# 单车道宽（米）：高速/快速路 3.75，城市主次干道 3.5，支路 3.25，其余 3.0（JTG B01 / CJJ 37 常用值）
ROAD_LANE_W = {'motorway': 3.75, 'trunk': 3.75, 'primary': 3.5, 'secondary': 3.5, 'tertiary': 3.25,
               'motorway_link': 3.75, 'trunk_link': 3.75, 'primary_link': 3.5, 'secondary_link': 3.5,
               'residential': 3.0, 'unclassified': 3.0, 'service': 3.0}
# 缺 lanes 标签时的车道数：单向 way（双幅路的一幅）与双向 way 分开估
ROAD_LANES_ONEWAY = {'motorway': 3, 'trunk': 3, 'primary': 3, 'secondary': 2, 'tertiary': 2, 'motorway_link': 1,
                     'trunk_link': 1, 'primary_link': 1, 'secondary_link': 1, 'residential': 1, 'unclassified': 1,
                     'service': 1}
ROAD_LANES_TWOWAY = {'motorway': 6, 'trunk': 6, 'primary': 4, 'secondary': 4, 'tertiary': 2, 'motorway_link': 2,
                     'trunk_link': 2, 'primary_link': 2, 'secondary_link': 2, 'residential': 2, 'unclassified': 2,
                     'service': 1}
# 车道以外的路面（路肩、路缘带、中央分隔带的铺装部分）
ROAD_EXTRA_ONEWAY = {'motorway': 3.75, 'trunk': 2.5, 'primary': 1.0, 'secondary': 0.8, 'tertiary': 0.5,
                     'motorway_link': 2.5, 'trunk_link': 2.0, 'primary_link': 1.0, 'secondary_link': 0.8}
ROAD_EXTRA_TWOWAY = {'motorway': 9.5, 'trunk': 6.0, 'primary': 2.5, 'secondary': 1.5, 'tertiary': 1.0,
                     'motorway_link': 4.0, 'trunk_link': 3.0, 'primary_link': 1.5, 'secondary_link': 1.0,
                     'residential': 0.5, 'unclassified': 0.5}


def road_lanes_width(hw, tags):
    """返回 (车道数, 路面宽 m)。一个 OSM way 若单行（双幅路的一幅）只算这一幅的宽度。"""
    oneway = tags.get('oneway') in ('yes', '1', '-1', 'true') or tags.get('junction') in ('roundabout', 'circular')
    if hw in ('motorway', 'motorway_link') and tags.get('oneway') not in ('no', '0', 'false', 'reversible'):
        oneway = True   # OSM 约定：高速默认单行
    lanes = numeric(tags.get('lanes'), 0)
    if not (1 <= lanes <= 12):
        fw, bw = numeric(tags.get('lanes:forward'), 0), numeric(tags.get('lanes:backward'), 0)
        lanes = fw + bw if fw + bw >= 1 else 0
    if not (1 <= lanes <= 12):
        lanes = (ROAD_LANES_ONEWAY if oneway else ROAD_LANES_TWOWAY).get(hw, 1)
    lanes = int(round(lanes))
    width_tag = numeric(tags.get('width') or tags.get('est_width'), 0)
    if hw == 'footway':
        return 1, round(width_tag if 1.0 <= width_tag <= 12 else 2.5, 1)
    if hw == 'pedestrian':
        return 1, round(width_tag if 2.0 <= width_tag <= 60 else 6.0, 1)
    lane_w = ROAD_LANE_W.get(hw, 3.0)
    extra = (ROAD_EXTRA_ONEWAY if oneway else ROAD_EXTRA_TWOWAY).get(hw, 0.5)
    width = lanes * lane_w + extra
    # width 标签：只接受与车道数大致相符的值（OSM 里常见把整条道路红线宽标在单幅上的误标）
    if 2.5 <= width_tag <= 60 and 0.6 * width <= width_tag <= 2.2 * width:
        width = width_tag
    if hw == 'service':
        width = min(width, 6.0)
    return lanes, round(max(2.5, min(45.0, width)), 1)


def road_flags(tags):
    """(桥 b, 隧道 t, 层 y)。缺 layer 时按 OSM 约定：桥默认 1、隧道默认 -1。"""
    bridge = tags.get('bridge') not in (None, 'no', 'false', '0') or tags.get('man_made') == 'bridge'
    tunnel_v = tags.get('tunnel')
    # building_passage（穿楼门洞）、covered（风雨廊）是地面道路，不按隧道处理
    tunnel = tunnel_v not in (None, 'no', 'false', '0', 'building_passage', 'covered')
    layer_raw = tags.get('layer')
    layer = round(numeric(layer_raw, 0)) if layer_raw not in (None, '') else (1 if bridge else (-1 if tunnel else 0))
    if bridge and layer <= 0:
        layer = 1
    if tunnel and layer >= 0:
        layer = -1
    return int(bridge), int(tunnel), max(-5, min(5, layer))


def road_output():
    cats = ROAD_CLASSES
    idx = {n: i for i, n in enumerate(cats)}
    feats, seen = [], set()
    stats = defaultdict(int)
    # Geofabrik 陕西提取是同一时间点的完整快照，优先；Overpass 分区缓存与早期窄范围研究缓存
    # （部分是几个月前的快照，同一道路被拆分后 way id 已变）只补 Geofabrik 里没有的路段。
    primary_src, backup_src = [], []
    for cat in ('roads_main', 'roads_core', 'roads_detail'):
        for p in sorted(glob.glob(str(SRC / 'osm' / f'{cat}__*.json'))):
            (primary_src if p.endswith('__geofabrik.json') else backup_src).append(p)
    for pattern in ('osm_motorways.json', 'osm_ring_roads.json', 'osm_main_roads_named.json', 'osm_bridges_wei.json'):
        backup_src.append(str(SRC / 'airports_research' / pattern))

    def seg_keys(coords):
        return {tuple(sorted(((round(a[0], 5), round(a[1], 5)), (round(b[0], 5), round(b[1], 5)))))
                for a, b in zip(coords, coords[1:])}

    covered = set()
    for group, paths in (('geofabrik', primary_src), ('backup', backup_src)):
        for path in paths:
            for el in (read_json(Path(path), {}) or {}).get('elements', []):
                tags = el.get('tags', {})
                hw = ROAD_ALIAS.get(tags.get('highway'), tags.get('highway'))
                if hw not in idx or el.get('type') != 'way':
                    continue
                key = (el.get('type'), el.get('id'))
                if key in seen:
                    continue
                seen.add(key)
                if tags.get('area') == 'yes':
                    # 步行广场/人行道面（大雁塔南广场一带有 2800 多块）是面，不能沿周长画成道路带
                    stats['skip_area'] += 1
                    continue
                coords = raw_coords(el.get('geometry'))
                if len(coords) < 2:
                    continue
                keys = seg_keys(coords)
                if group == 'backup' and keys and len(keys & covered) > 0.3 * len(keys):
                    stats['skip_overlap_' + group] += 1
                    continue
                covered |= keys
                if tags.get('oneway') == '-1':
                    coords = coords[::-1]   # 统一成 o=1 时沿折线正向通行
                try:
                    from shapely.geometry import LineString
                    ls = LineString(as_world(coords)).simplify(1.25 if hw in cats[:6] else 0.7, preserve_topology=False)
                    p = flat(list(ls.coords))
                except Exception:
                    p = flat(as_world(coords))
                if len(p) < 4:
                    continue
                lanes, width = road_lanes_width(hw, tags)
                b, t, y = road_flags(tags)
                oneway = int(tags.get('oneway') in ('yes', '1', '-1', 'true') or tags.get('junction') == 'roundabout'
                             or (hw in ('motorway', 'motorway_link') and tags.get('oneway') not in ('no', '0', 'false', 'reversible')))
                feats.append({'c': idx[hw], 'n': name_of(tags), 'w': width, 'l': lanes, 'o': oneway,
                              'b': b, 't': t, 'y': y, 'p': p})
                stats['from_' + group] += 1
    write_json('roads.json', {'classes': cats, 'features': feats})
    print('[roads] 统计', dict(sorted(stats.items())))
    return len(feats)


def rail_output():
    """铁路/地铁/轻轨。Geofabrik 优先，早期研究缓存只补缺；在建线（railway=construction）不输出。"""
    from shapely.geometry import LineString
    cls = {'rail': 0, 'narrow_gauge': 0, 'subway': 1, 'light_rail': 2, 'tram': 2, 'monorail': 2}
    feats, seen, covered = [], set(), set()
    stats = defaultdict(int)
    groups = (('geofabrik', load_cat('rail')), ('backup', load_extra(str(SRC / 'airports_research' / 'osm_rail.json'))))
    for group, elements in groups:
        for el in elements:
            if el.get('type') != 'way':
                continue
            key = (el.get('type'), el.get('id'))
            if key in seen:
                continue
            seen.add(key)
            tags = el.get('tags', {})
            railway = tags.get('railway')
            if railway not in cls:
                stats['skip_' + str(railway)] += 1
                continue
            coords = raw_coords(el.get('geometry'))
            if len(coords) < 2:
                continue
            keys = {tuple(sorted(((round(a[0], 5), round(a[1], 5)), (round(b[0], 5), round(b[1], 5)))))
                    for a, b in zip(coords, coords[1:])}
            if group == 'backup' and len(keys & covered) > 0.3 * len(keys):
                stats['skip_overlap_backup'] += 1
                continue
            covered |= keys
            b, t, y = road_flags(tags)
            if tags.get('location') == 'underground' and not t:
                t, y = 1, min(y, -1)
            tracks = int(max(1, min(8, numeric(tags.get('tracks'), 1))))
            width = (3.8 if railway == 'subway' else 4.0) + (tracks - 1) * 4.5
            try:
                p = flat(list(LineString(as_world(coords)).simplify(0.8, preserve_topology=False).coords))
            except Exception:
                p = flat(as_world(coords))
            if len(p) < 4:
                continue
            feats.append({'c': cls[railway], 'n': name_of(tags) or tags.get('ref', ''), 'w': round(width, 1),
                          'l': tracks, 'o': 0, 'b': b, 't': t, 'y': y, 'p': p})
            stats[f'{group}_{railway}'] += 1
    write_json('rail.json', {'classes': ['rail', 'subway', 'light_rail'], 'features': feats})
    print('[rail] 统计', dict(sorted(stats.items())))
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


def water_elements():
    els = load_cat('water')
    # 河网、渭河及城区湖泊取自本项目缓存，避免主请求失败后水体缺失。
    els += load_extra(str(SRC / 'airports_research' / 'osm_weihe.json'))
    els += load_extra(str(SRC / 'dem' / 'osm' / 'water_*.json'))
    els += load_extra(str(SRC / 'landmarks_historic' / 'osm' / 'qujiang.json'))
    return els


def water_shapes(stats=None):
    """OSM 水面要素 → [(世界坐标 Polygon, 名称, 类别)]（已裁到 MAIN、去重），以及河流中心线 way 列表。"""
    from shapely.ops import unary_union
    stats = stats if stats is not None else defaultdict(int)
    main_box = main_world_box()
    shapes, line_src, seen = [], [], set()
    for el in water_elements():
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

    # 同一水体在不同来源里以不同 id 重复，或塘面叠在湖面上：两层水面水位不同会互相穿插闪烁。
    # 非河道面按面积从大到小去重（大半被已收面覆盖的丢弃，小部分重叠的扣掉）；河道面在输出时让位给湖/库/塘面。
    kept = []
    for wpoly, name, kind in sorted([s for s in shapes if s[2] != 'river'], key=lambda s: -s[0].area):
        overlap = [g for g, _, _ in kept if g.intersects(wpoly)]
        if overlap:
            inter = unary_union(overlap)
            ov = wpoly.intersection(inter).area
            if ov > 0.5 * wpoly.area:
                stats['skip_duplicate'] += 1
                continue
            if ov > 1.0:
                diff = wpoly.difference(inter)
                kept.extend((g, name, kind) for g in getattr(diff, 'geoms', [diff])
                            if g.geom_type == 'Polygon' and g.area > 60)
                continue
        kept.append((wpoly, name, kind))
    rivers = [s for s in shapes if s[2] == 'river']
    return kept + rivers, line_src


SANDBAR_PATH = SRC / 'vector_check' / 'sandbars.json'


def load_sandbars():
    """tools/water_sandbars.py 依 Esri 影像识别的河道沙洲/裸露河滩（经纬度多边形），转世界坐标并合并。"""
    data = read_json(SANDBAR_PATH, None)
    if not data:
        return None
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    polys = []
    for item in data.get('sandbars', []):
        rings = [[geo.project(lon, lat) for lon, lat in ring] for ring in item.get('rings', [])]
        if not rings or len(rings[0]) < 3:
            continue
        p = Polygon(rings[0], [r for r in rings[1:] if len(r) >= 3])
        if not p.is_valid:
            p = p.buffer(0)
        if not p.is_empty:
            polys.append(p)
    return unary_union(polys) if polys else None


def water_output():
    from shapely.geometry import LineString, Point
    from shapely.ops import substring, unary_union
    stats = defaultdict(int)
    dem = DemSampler()
    if not dem.ok:
        print('[water] 警告：找不到 dem_main.png/meta.json，水位退回常数')
    main_box = main_world_box()
    shapes, line_src = water_shapes(stats)
    other_union = unary_union([s for s, _, k in shapes if k != 'river']) if shapes else None
    sandbars = load_sandbars()
    if sandbars is None:
        print('[water] 未找到沙洲缓存（tools/water_sandbars.py），河道面不扣沙洲')
    polys, lines = [], []
    for wpoly, name, kind in shapes:
        if kind == 'river' and sandbars is not None and wpoly.intersects(sandbars):
            # 渭河、灞河等河道面在 OSM 里是两岸之间的整个河槽，中间大片沙洲/河滩按影像扣成内环（露出影像底图）。
            before = wpoly.area
            carved = wpoly.difference(sandbars)
            if not carved.is_empty:
                stats['sandbar_m2'] += round(before - carved.area)
                wpoly = carved
        bases = [g for g in getattr(wpoly, 'geoms', [wpoly]) if g.geom_type == 'Polygon' and g.area > 300]
        for base in bases:
            pieces = split_by_grid(base) if kind == 'river' else [base]
            for piece in pieces:
                sub = [piece]
                if kind == 'river' and other_union is not None and piece.intersects(other_union):
                    try:
                        diff = piece.difference(other_union)
                        sub = [g for g in getattr(diff, 'geoms', [diff]) if g.geom_type == 'Polygon' and g.area > 300]
                    except Exception:
                        pass
                for g in sub:
                    outer, holes = shape_rings(g, min_hole_area=40)
                    if not outer:
                        continue
                    if dem.ok:
                        # 河道取分位高一点：DEM 河道平整后是沿程平滑的下包络面，分段内最高处也要露出水面。
                        h = dem.level(g, 90 if kind == 'river' else 70) + 0.3
                    else:
                        h = 364.5 if name == '渭河' else 388.0
                    polys.append({'n': name or {'river': '河道', 'moat': '护城河'}.get(kind, ''), 'k': kind, 'outer': outer,
                                  'holes': holes, 'h': round(h, 1), 'a': round(g.area)})
                    stats['poly_' + kind] += 1

    # 河流中心线：有面状水面的河段不再画线（前端把“渭河”线强制放宽到 ≥520 m，会把整条中心线画成宽水带），
    # 长线按 ~1.2 km 切段，每段附建议水位 h（前端目前按首点地形取高，h 供后续使用）。
    cover = unary_union([s for s, _, _ in shapes]).buffer(12) if shapes else None
    if cover is not None and sandbars is not None:
        cover = cover.union(sandbars.buffer(12))
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
                a, b = Point(part.coords[0]), Point(part.coords[-1])
                if a.distance(cover) < 30 and b.distance(cover) < 30:
                    stats['line_skip_gap'] += 1
                    continue
            part = part.simplify(1.5, preserve_topology=False)
            n_chunks = max(1, math.ceil(part.length / 1200.0))
            for ci in range(n_chunks):
                seg = substring(part, ci / n_chunks, (ci + 1) / n_chunks, normalized=True)
                pts = list(seg.coords)
                if len(pts) < 2:
                    continue
                item = {'n': name, 'k': WATER_LINE_WAYS[ww], 'w': round(width, 1), 'p': flat(pts)}
                if dem.ok:
                    item['h'] = round(min(dem.at(x, z) for x, z in pts[:: max(1, len(pts) // 12)] + [pts[-1]]) + 0.2, 1)
                lines.append(item)
                stats['line_' + ww] += 1
    # 城墙护城河另由 citywall 模块按城墙中心线生成贴合水道；这里保留 OSM 护城河面（k=moat）。
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
    stats = defaultdict(int)
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
        for wpoly in world_shapes(el, tolerance=landuse_tolerance, min_area=180):
            area = float(wpoly.area)
            c = wpoly.representative_point()
            distance = math.hypot(c.x, c.y)
            if kind in ('forest', 'orchard', 'farmland', 'grass'):
                min_feature_area = 1200 if distance < 10000 else (5000 if distance < 20000 else (18000 if distance < 35000 else 100000))
            elif kind in ('residential', 'commercial', 'industrial', 'construction'):
                min_feature_area = 250 if distance < 10000 else (900 if distance < 20000 else (4000 if distance < 35000 else 15000))
            else:
                min_feature_area = 180 if distance < 25000 else 1500
            if area < min_feature_area:
                continue
            outer, holes = shape_rings(wpoly, min_hole_area=60)
            if not outer:
                continue
            # a：面积（m²，扣除内环），供前端按面积筛选/分级显示
            polys.append({'k': kind, 'n': name_of(tags), 'outer': outer, 'holes': holes, 'a': round(area)})
            stats[kind] += 1
    polys.sort(key=lambda p: -p['a'])
    write_json('landuse.json', {'polys': polys})
    print('[landuse] 统计', dict(sorted(stats.items())))
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


# 全国知名地标 / 交通枢纽（OSM 上不一定带 wikidata，按名称补足 i=3）
POI_FAMOUS = re.compile(
    r'^(西安)?(钟楼|鼓楼|大雁塔|小雁塔|大慈恩寺|荐福寺|大唐不夜城|大唐芙蓉园|曲江池遗址公园|西安城墙|永宁门|安定门|长乐门|安远门|'
    r'陕西历史博物馆|西安碑林博物馆|碑林博物馆|大明宫国家遗址公园|大明宫|兴庆宫公园|回民街|北院门|大兴善寺|青龙寺|'
    r'汉长安城遗址|未央宫遗址|秦始皇帝陵博物院|秦始皇兵马俑博物馆|兵马俑|华清宫|华清池|骊山|西安博物院|半坡博物馆|'
    r'大唐西市|陕西电视塔|西安奥体中心|西安国际港务区|昆明池|斗门水库（昆明池）|汉阳陵|'
    r'西安站|西安北站|西安东站|西安南站|阿房宫站|咸阳站|咸阳西站|西安咸阳国际机场|西安咸阳国际机场T[1-5]航站楼|'
    r'赛格国际购物中心|西安赛格国际购物中心|大悦城|西安大悦城|曲江大悦城|SKP|西安SKP|西安万象城|万象城|'
    r'西安交通大学|西北工业大学|西北大学|陕西师范大学|西安电子科技大学|长安大学)$')
# 通用名只在真身附近才算地标（寺庙里也有钟楼、鼓楼）：名称 → 距钟楼原点的最大距离（米）
POI_FAMOUS_LOCAL = {'钟楼': 700, '鼓楼': 700, '西安钟楼': 700, '西安鼓楼': 700, '永宁门': 3000, '安定门': 3000,
                    '长乐门': 3000, '安远门': 3000, '回民街': 1500, '北院门': 1500}
POI_TRANSIT_JUNK = {'platform', 'stop_position', 'stop_area'}


def poi_importance(tags, name, area, dist=0.0):
    """标注重要度 0~3：3 全国知名地标/交通枢纽/大型商场，2 区级重要，1 普通有名称的店铺与设施，0 其它。"""
    wd = bool(tags.get('wikidata') or tags.get('wikipedia') or tags.get('name:en') and tags.get('wikimedia_commons'))
    tourism, historic, amenity = tags.get('tourism'), tags.get('historic'), tags.get('amenity')
    shop, leisure, railway = tags.get('shop'), tags.get('leisure'), tags.get('railway')
    station = tags.get('station')
    is_metro = railway in ('station', 'halt', 'stop') and (station in ('subway', 'light_rail', 'monorail')
                                                         or tags.get('subway') == 'yes' or tags.get('light_rail') == 'yes')
    if is_metro and not re.search(r'(西安北站|北客站|西安站|火车站)$', name):
        return 2   # 地铁站即便叫“钟楼”“大雁塔”也不是地标本身
    aliases = [name] + [a.strip() for k in ('alt_name', 'official_name', 'short_name') for a in (tags.get(k) or '').split(';')]
    if any(a and POI_FAMOUS.match(a) and dist <= POI_FAMOUS_LOCAL.get(a, 1e9) for a in aliases):
        return 3
    if tags.get('aeroway') in ('aerodrome', 'terminal'):
        return 3
    if railway in ('station', 'halt') or tags.get('public_transport') == 'station' and tags.get('train') == 'yes':
        if station in ('subway', 'light_rail', 'monorail') or tags.get('subway') == 'yes' or tags.get('light_rail') == 'yes':
            return 2                                   # 地铁/云巴站：区级导航地标
        if railway == 'halt':
            return 1
        # 国铁车站：西安站/北站/东站等大站已由名单给 3；带 wikidata 的客运站 2；其余多是三民村、青岔这类小站/货运站
        return 2 if wd or area > 30000 else 1
    if railway in ('subway_entrance', 'stop', 'platform', 'crossing', 'level_crossing', 'switch', 'buffer_stop'):
        return 0
    if shop in ('mall', 'department_store'):
        return 3 if wd or area >= 25000 else 2
    if tourism in ('attraction', 'museum', 'theme_park', 'zoo', 'aquarium', 'gallery'):
        if wd:
            return 3
        if tourism in ('museum', 'theme_park', 'zoo', 'aquarium') or area > 20000:
            return 2
        return 1                                       # 无 wikidata 的小景点（牌坊、雕塑群……）
    if historic in ('monument', 'memorial', 'city_gate', 'archaeological_site', 'castle', 'tomb', 'ruins', 'building',
                    'heritage', 'temple', 'palace', 'citywalls', 'fort'):
        if wd:
            return 3
        if historic in ('city_gate', 'palace', 'castle') or (historic in ('archaeological_site', 'tomb', 'monument')
                                                           and (area > 20000 or re.search(r'(遗址|陵|墓|碑)', name))):
            return 2
        return 1
    if amenity == 'place_of_worship':
        return 3 if wd else (2 if re.search(r'(寺|观|庙|清真大寺|教堂)$', name) else 1)
    if amenity == 'university':
        return 3 if wd else 2
    if amenity == 'bus_station':
        return 2 if re.search(r'(客运站|汽车站|客运中心|枢纽)', name) else 1
    if amenity in ('college', 'hospital', 'townhall', 'courthouse', 'library', 'theatre',
                   'arts_centre', 'conference_centre', 'exhibition_centre'):
        if amenity == 'hospital' and not re.search(r'医院', name):
            return 1
        return 3 if wd and amenity in ('library', 'theatre', 'arts_centre', 'exhibition_centre') else 2
    if leisure in ('stadium',):
        return 3 if wd else 2
    if leisure in ('park', 'nature_reserve', 'garden') and not tags.get('building'):
        return 3 if wd and area > 300000 else (2 if wd or area > 150000 else 1)
    if tags.get('man_made') == 'tower' and (wd or tags.get('tower:type') in ('communication', 'observation')):
        return 3 if wd else 2
    if tags.get('office') == 'government' or amenity == 'townhall':
        return 2 if re.search(r'(人民政府|管委会|管理委员会)$', name) else 1
    if tourism == 'hotel':
        stars = numeric(tags.get('stars'), 0)
        return 2 if wd or stars >= 5 or area > 8000 else 1
    if amenity in ('parking', 'parking_entrance', 'toilets', 'atm', 'charging_station', 'bicycle_parking', 'vending_machine',
                   'post_box', 'telephone', 'bench', 'waste_basket', 'recycling', 'shelter', 'drinking_water', 'fountain',
                   'motorcycle_parking', 'taxi', 'car_rental', 'bicycle_rental', 'loading_dock'):
        return 0
    if re.search(r'(\d+|[一二三四五六七八九十]+)(号楼|栋|单元|号门|出入口|入口|出口|[A-Z]口)$', name) or re.fullmatch(r'[A-Z]?\d*[A-Z]?口', name):
        return 0
    if shop or amenity or tourism or historic or leisure or tags.get('office') or tags.get('healthcare') or tags.get('craft') \
            or tags.get('club') or tags.get('man_made') in ('bridge', 'tower', 'lighthouse'):
        return 1
    return 0


def pois_output():
    source = load_cat('pois') + load_extra(str(SRC / 'landmarks_historic' / 'osm' / '*.json'))
    seen, out = set(), []
    stats = defaultdict(int)
    for el in source:
        tags = el.get('tags', {})
        name = name_of(tags)
        if not name or not re.search(r'[\u4e00-\u9fff]', name):
            continue   # 契约：只要带中文名称的点
        key = (el.get('type'), el.get('id'))
        if key in seen:
            continue
        seen.add(key)
        pt = tags.get('public_transport')
        if (pt in POI_TRANSIT_JUNK or tags.get('highway') == 'bus_stop') and tags.get('railway') not in ('station', 'halt'):
            stats['skip_bus_stop'] += 1   # 公交站台/停靠点：不是地标，旧版误归为 landmark（约 7000 条）
            continue
        if el.get('type') != 'node' and tags.get('railway') in ('rail', 'subway', 'light_rail', 'tram', 'construction',
                                                                'disused', 'narrow_gauge', 'monorail', 'preserved'):
            stats['skip_rail_line'] += 1  # 线路名（陇海铁路、地铁 2 号线……）在 rail.json 里，不是点
            continue
        area = 0.0
        p = None
        if el.get('type') in ('way', 'relation'):
            shapes = world_shapes(el, tolerance=2.0, min_area=1)
            if shapes:
                area = float(sum(s.area for s in shapes))
                q = max(shapes, key=lambda s: s.area).representative_point()
                p = (q.x, q.y)
        if p is None:
            p = tag_world(el)
        if p is None:
            geom = raw_coords(el.get('geometry'))
            if not geom:
                continue
            from shapely.geometry import LineString
            q = LineString(as_world(geom)).interpolate(0.5, normalized=True)
            p = (q.x, q.y)
        if math.hypot(p[0], p[1]) > 38000:
            continue
        k = (tags.get('shop') and 'shop') or (tags.get('tourism') and 'hotel' if tags.get('tourism') == 'hotel' else tags.get('tourism')) or tags.get('amenity') or tags.get('historic') or tags.get('railway') or 'landmark'
        imp = poi_importance(tags, name, area, math.hypot(p[0], p[1]))
        if tags.get('railway') in ('station', 'halt') and not name.endswith('站') and not re.search(r'[)）]$', name):
            name = name + '站'   # OSM 车站名不带“站”（西安北、萧家村），标注时和同名地标/村庄区分
        out.append({'n': name, 'k': str(k), 'x': round(p[0], 1), 'z': round(p[1], 1), 'i': imp})
    # 同名同地（车站的点+面、同一商场的多个要素）只留一个：取重要度最高的
    out.sort(key=lambda o: -o['i'])
    kept, by_name = [], defaultdict(list)
    for o in out:
        # 重要标注（整片景区/长街的多个要素）去重半径更大
        radius = {3: 800, 2: 300}.get(o['i'], 150)
        if any(math.hypot(q['x'] - o['x'], q['z'] - o['z']) < radius for q in by_name[o['n']]):
            stats['skip_duplicate'] += 1
            continue
        by_name[o['n']].append(o)
        kept.append(o)
    kept = kept[:20000]
    for o in kept:
        stats[f'i{o["i"]}'] += 1
    write_json('pois.json', {'pois': kept})
    print('[pois] 统计', dict(sorted(stats.items())))
    return len(kept)


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
