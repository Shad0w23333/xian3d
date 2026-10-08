#!/usr/bin/env python3
"""OSM 地面停车场（amenity=parking，排除地下/立体/屋顶）→ public/data/parking.json（世界坐标多边形）。
用法：.venv-tools/bin/python tools/build_parking.py   （读 data-src/geofabrik/shaanxi-latest.osm.pbf）
"""
import json
import os
import sys

import osmium

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import geo
W, S, E, N = 108.62, 34.02, 109.30, 34.52
out = []
class H(osmium.SimpleHandler):
    def area(self, a):
        t = a.tags
        if t.get('amenity') != 'parking':
            return
        if t.get('parking') in ('underground', 'multi-storey', 'rooftop'):
            return
        for ring in a.outer_rings():
            pts = [(n.lon, n.lat) for n in ring]
            if not pts:
                continue
            lon = sum(p[0] for p in pts) / len(pts); lat = sum(p[1] for p in pts) / len(pts)
            if not (W < lon < E and S < lat < N):
                continue
            flat = []
            for lo, la in pts[:-1]:
                x, z = geo.project(lo, la); flat += [round(x, 1), round(z, 1)]
            out.append({'p': flat, 'n': t.get('name', ''), 'cap': t.get('capacity', ''), 'surf': t.get('surface', '')})
h = H()
h.apply_file('data-src/geofabrik/shaanxi-latest.osm.pbf', locations=True)
json.dump({'version': 1, 'source': 'OpenStreetMap amenity=parking（Geofabrik shaanxi-latest）', 'lots': out}, open('public/data/parking.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(out), '个地面停车场 → public/data/parking.json')
