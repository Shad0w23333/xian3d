#!/usr/bin/env python3
"""从 Geofabrik 陕西 PBF 提取 MAIN 范围内全部 building / building:part（供 build_buildings_v2.py 使用）。

data-src/osm/buildings__geofabrik.json 只含若干小框（BUILDING_ZONES），不够覆盖 CMAB 区外的咸阳/机场/阎良/渭北，
所以这里单独再扫一遍 PBF，输出 data-src/buildings_v2/osm_buildings_main.json（Overpass 风格 elements）。
用法：.venv-tools/bin/python tools/extract_osm_buildings_main.py
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import geo  # noqa: E402

PBF = ROOT / 'data-src' / 'geofabrik' / 'shaanxi-latest.osm.pbf'
OUT = ROOT / 'data-src' / 'buildings_v2' / 'osm_buildings_main.json'
W, S, E, N = geo.BOUNDS['MAIN']


def main():
    import osmium
    t0 = time.time()
    out = []
    proc = osmium.FileProcessor(str(PBF)).with_locations('sparse_mem_array').with_areas()
    for obj in proc:
        if obj.is_node():
            continue
        tags = {t.k: t.v for t in obj.tags}
        if not (tags.get('building') or tags.get('building:part')):
            continue
        if obj.is_way():
            coords = [(float(n.lon), float(n.lat)) for n in obj.nodes if n.location.valid()]
            if len(coords) < 4 or coords[0] != coords[-1]:
                continue
            cx = sum(p[0] for p in coords) / len(coords)
            cy = sum(p[1] for p in coords) / len(coords)
            if not (W <= cx <= E and S <= cy <= N):
                continue
            out.append({'type': 'way', 'id': int(obj.id), 'tags': tags,
                        'geometry': [{'lon': round(a, 7), 'lat': round(b, 7)} for a, b in coords]})
        elif obj.is_area():
            if obj.from_way():
                continue
            members = []
            allc = []
            for outer in obj.outer_rings():
                oc = [(float(n.lon), float(n.lat)) for n in outer if n.location.valid()]
                if len(oc) < 4:
                    continue
                allc += oc
                members.append({'type': 'way', 'role': 'outer',
                                'geometry': [{'lon': round(a, 7), 'lat': round(b, 7)} for a, b in oc]})
                for inner in obj.inner_rings(outer):
                    ic = [(float(n.lon), float(n.lat)) for n in inner if n.location.valid()]
                    if len(ic) >= 4:
                        members.append({'type': 'way', 'role': 'inner',
                                        'geometry': [{'lon': round(a, 7), 'lat': round(b, 7)} for a, b in ic]})
            if not members:
                continue
            cx = sum(p[0] for p in allc) / len(allc)
            cy = sum(p[1] for p in allc) / len(allc)
            if not (W <= cx <= E and S <= cy <= N):
                continue
            out.append({'type': 'relation', 'id': int(obj.orig_id()), 'tags': tags, 'members': members})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix('.part')
    with tmp.open('w', encoding='utf-8') as f:
        json.dump({'elements': out, '_source': 'Geofabrik shaanxi-latest.osm.pbf, MAIN bbox, building|building:part'},
                  f, ensure_ascii=False, separators=(',', ':'))
    tmp.replace(OUT)
    print(f'[osm-buildings] {len(out):,} 要素 -> {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)，{time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
