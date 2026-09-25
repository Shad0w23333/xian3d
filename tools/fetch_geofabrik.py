#!/usr/bin/env python3
"""从 Geofabrik 陕西省 OSM 区域包提取西安场景所需要素。

Overpass 限流或超时期间的可靠替代入口。PBF 保存在 data-src/geofabrik/，
解析后的分类缓存写入 data-src/osm/，build_data.py 会自动加载。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import geo  # noqa: E402

PBF_URL = 'https://download.geofabrik.de/asia/china/shaanxi-latest.osm.pbf'
PBF_PATH = ROOT / 'data-src' / 'geofabrik' / 'shaanxi-latest.osm.pbf'
OUT = ROOT / 'data-src' / 'osm'
UA = 'xian3d-osm-pipeline/1.0 (OpenStreetMap extract processing)'

MAIN = geo.BOUNDS['MAIN']
CORE = geo.BOUNDS['CORE']
WALL = (108.915, 34.243, 108.972, 34.284)
DATANG = (108.945, 34.188, 108.995, 34.228)
BUILDING_ZONES = [
    (108.922, 34.248, 108.958, 34.274),  # 钟楼与城墙西中段
    (108.958, 34.248, 108.986, 34.274),  # 城墙东段
    (108.922, 34.274, 108.960, 34.294),  # 北门与大明宫南缘
    (108.920, 34.222, 108.958, 34.248),  # 小雁塔与南城墙
    (108.947, 34.197, 108.983, 34.225),  # 大雁塔与不夜城
    (108.846, 34.202, 108.882, 34.230),  # 高新区商务核心
    (108.924, 34.321, 108.960, 34.349),  # 未央国际商圈
    (108.680, 34.300, 108.718, 34.330),  # 咸阳市区
    (109.200, 34.630, 109.238, 34.658),  # 阎良机场
    (108.720, 34.430, 108.790, 34.475),  # 咸阳机场航站区
]

ROAD_MAIN = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'}
ROAD_CORE = {'residential', 'unclassified', 'living_street', 'pedestrian', 'road'}
ROAD_DETAIL = {'service', 'footway', 'path', 'steps', 'cycleway', 'track'}
RAIL = {'rail', 'subway', 'light_rail', 'tram', 'narrow_gauge', 'construction', 'monorail', 'preserved', 'disused'}
WATERWAY = {'river', 'riverbank', 'canal', 'stream', 'ditch', 'drain', 'dock', 'dam', 'weir'}
LANDUSE = {'landuse', 'leisure', 'natural', 'place', 'amenity', 'tourism', 'historic'}
POI_KEYS = {'shop', 'amenity', 'tourism', 'office', 'historic', 'leisure', 'healthcare', 'craft', 'club', 'railway', 'public_transport', 'man_made'}


def log(*values):
    print(*values, flush=True)


def download():
    PBF_PATH.parent.mkdir(parents=True, exist_ok=True)
    if PBF_PATH.exists() and PBF_PATH.stat().st_size > 70_000_000:
        log(f'[pbf] 已缓存 {PBF_PATH.stat().st_size / 1e6:.1f} MB')
        return
    tmp = PBF_PATH.with_suffix(PBF_PATH.suffix + '.part')
    with requests.get(PBF_URL, headers={'User-Agent': UA}, stream=True, timeout=(30, 180)) as response:
        response.raise_for_status()
        total = int(response.headers.get('Content-Length', 0))
        if total and total > 512_000_000:
            raise RuntimeError(f'下载文件超过预期上限：{total:,} bytes')
        received, last_log = 0, time.time()
        with tmp.open('wb') as file:
            for block in response.iter_content(1024 * 1024):
                if not block:
                    continue
                file.write(block)
                received += len(block)
                if time.time() - last_log > 3:
                    log(f'[pbf] {received / 1e6:.1f}/{total / 1e6:.1f} MB' if total else f'[pbf] {received / 1e6:.1f} MB')
                    last_log = time.time()
    if total and received != total:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f'PBF 下载不完整：{received} / {total}')
    tmp.replace(PBF_PATH)
    log(f'[pbf] 下载完成 {received / 1e6:.1f} MB')


def box_intersects(coords, bbox):
    if not coords:
        return False
    w, s, e, n = bbox
    xs = [p[0] for p in coords]
    ys = [p[1] for p in coords]
    return max(xs) >= w and min(xs) <= e and max(ys) >= s and min(ys) <= n


def in_any_box(coords, boxes):
    if not coords:
        return False
    cx = sum(p[0] for p in coords) / len(coords)
    cy = sum(p[1] for p in coords) / len(coords)
    return any(w <= cx <= e and s <= cy <= n for w, s, e, n in boxes)


def tags_of(obj):
    return {tag.k: tag.v for tag in obj.tags}


def copy_way_nodes(way):
    coords = []
    for node in way.nodes:
        if node.location.valid():
            coords.append((float(node.lon), float(node.lat)))
    return coords


def tag_center(coords):
    if not coords:
        return None
    return {'lon': sum(p[0] for p in coords) / len(coords), 'lat': sum(p[1] for p in coords) / len(coords)}


def element(kind, osm_id, tags, coords, center=False):
    out = {'type': kind, 'id': int(osm_id), 'tags': tags,
           'geometry': [{'lon': lon, 'lat': lat} for lon, lat in coords]}
    if center:
        out['center'] = tag_center(coords)
    return out


class Extractor:
    def __init__(self):
        self.data = {key: [] for key in ('roads_main', 'roads_core', 'roads_detail', 'rail', 'water', 'landuse', 'aeroway', 'buildings', 'pois')}
        self.seen = {key: set() for key in self.data}
        self.counts = {key: 0 for key in self.data}
        self.ways_seen = 0
        self.ways_tagged = 0
        self.ways_with_locations = 0

    def add(self, category, obj):
        key = (obj['type'], obj['id'])
        if key in self.seen[category]:
            return
        self.seen[category].add(key)
        self.data[category].append(obj)

    def accept(self, tags, feature, kind, coords=None):
        coords = coords or feature.get('geometry', [])
        highway = tags.get('highway')
        if kind == 'way' and highway:
            if highway in ROAD_MAIN and box_intersects(coords, MAIN):
                self.add('roads_main', feature)
            if highway in ROAD_CORE and box_intersects(coords, CORE):
                self.add('roads_core', feature)
            if highway in ROAD_DETAIL and (box_intersects(coords, WALL) or box_intersects(coords, DATANG)):
                self.add('roads_detail', feature)

        railway = tags.get('railway')
        if kind == 'way' and railway in RAIL and box_intersects(coords, MAIN):
            self.add('rail', feature)

        is_water = (tags.get('natural') == 'water' or 'water' in tags or tags.get('waterway') in WATERWAY
                    or tags.get('landuse') in {'reservoir', 'basin'})
        if is_water and box_intersects(coords, MAIN):
            self.add('water', feature)

        is_landuse = any(key in tags for key in LANDUSE)
        if is_landuse and box_intersects(coords, MAIN):
            self.add('landuse', feature)

        is_airfield = bool(tags.get('aeroway') or tags.get('military') == 'airfield')
        if is_airfield and box_intersects(coords, MAIN):
            if tags.get('military') == 'airfield' and not tags.get('aeroway'):
                tags = dict(tags, aeroway='aerodrome')
                feature = dict(feature, tags=tags)
            self.add('aeroway', feature)

        is_building = bool(tags.get('building') or tags.get('building:part'))
        if is_building and in_any_box(coords, BUILDING_ZONES):
            self.add('buildings', feature)

        if tags.get('name') and any(key in tags for key in POI_KEYS) and box_intersects(coords, MAIN):
            self.add('pois', feature)

    def node(self, node):
        if not node.location.valid():
            return
        lon, lat = float(node.lon), float(node.lat)
        tags = tags_of(node)
        if not box_intersects([(lon, lat)], MAIN):
            return
        if tags.get('name') and any(key in tags for key in POI_KEYS):
            self.add('pois', {'type': 'node', 'id': int(node.id), 'tags': tags, 'lon': lon, 'lat': lat})
        if tags.get('aeroway') and tags['aeroway'] in {'gate', 'helipad'}:
            self.add('aeroway', {'type': 'node', 'id': int(node.id), 'tags': tags, 'lon': lon, 'lat': lat})
        if tags.get('railway') in {'station', 'halt', 'stop', 'subway_entrance'}:
            self.add('rail', {'type': 'node', 'id': int(node.id), 'tags': tags, 'lon': lon, 'lat': lat})

    def way(self, way):
        self.ways_seen += 1
        tags = tags_of(way)
        if not tags:
            return
        if any(key in tags for key in ('highway', 'railway', 'natural', 'water', 'waterway', 'landuse', 'leisure', 'aeroway', 'building', 'building:part')):
            self.ways_tagged += 1
        coords = copy_way_nodes(way)
        if len(coords) < 2:
            return
        self.ways_with_locations += 1
        feature = element('way', way.id, tags, coords, center=(len(coords) >= 4 and coords[0] == coords[-1]))
        self.accept(tags, feature, 'way', coords)

    def area(self, area):
        # 闭合 way 已由 way() 保存；relation area 保留 outer/inner 环，供面要素精确还原。
        if area.from_way():
            return
        tags = tags_of(area)
        if not tags:
            return
        members = []
        all_coords = []
        for outer in area.outer_rings():
            outer_coords = [(float(node.lon), float(node.lat)) for node in outer if node.location.valid()]
            if len(outer_coords) >= 4:
                all_coords.extend(outer_coords)
                members.append({'type': 'way', 'role': 'outer',
                                'geometry': [{'lon': lon, 'lat': lat} for lon, lat in outer_coords]})
                for inner in area.inner_rings(outer):
                    inner_coords = [(float(node.lon), float(node.lat)) for node in inner if node.location.valid()]
                    if len(inner_coords) >= 4:
                        all_coords.extend(inner_coords)
                        members.append({'type': 'way', 'role': 'inner',
                                        'geometry': [{'lon': lon, 'lat': lat} for lon, lat in inner_coords]})
        if not members:
            return
        feature = {'type': 'relation', 'id': int(area.orig_id()), 'tags': tags, 'members': members}
        if len(all_coords) >= 4 and box_intersects(all_coords, MAIN):
            feature['center'] = tag_center(all_coords)
        self.accept(tags, feature, 'area', all_coords)

    def write(self):
        OUT.mkdir(parents=True, exist_ok=True)
        for category, features in self.data.items():
            path = OUT / f'{category}__geofabrik.json'
            payload = {'elements': features, '_source': 'Geofabrik Shaanxi extract, OSM data timestamp per upstream extract'}
            tmp = path.with_suffix(path.suffix + '.part')
            with tmp.open('w', encoding='utf-8') as file:
                json.dump(payload, file, ensure_ascii=False, separators=(',', ':'))
            tmp.replace(path)
            self.counts[category] = len(features)
            log(f'[osm] {category}: {len(features):,} 要素，{path.stat().st_size / 1e6:.2f} MB')


def main():
    try:
        import osmium
    except ImportError as exc:
        raise SystemExit('缺少 pyosmium，请先运行 python -m pip install -r requirements-data.txt') from exc
    download()
    t0 = time.time()
    extractor = Extractor()
    log('[osm] 用 pyosmium 读取陕西省 PBF，重建 WAY/RELATION 面几何并筛选西安范围……')
    processor = osmium.FileProcessor(str(PBF_PATH)).with_locations('sparse_mem_array').with_areas()
    seen = 0
    for obj in processor:
        seen += 1
        if seen % 500_000 == 0:
            log(f'[osm] 已读 {seen:,} 个对象；ways {extractor.ways_seen:,}/有标签 {extractor.ways_tagged:,}/有坐标 {extractor.ways_with_locations:,}；'
                + '，'.join(f'{key} {len(value):,}' for key, value in extractor.data.items()))
        if obj.is_node():
            extractor.node(obj)
        elif obj.is_way():
            extractor.way(obj)
        elif obj.is_area():
            extractor.area(obj)
    extractor.write()
    log(f'[done] 提取完成，用时 {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
