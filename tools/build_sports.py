#!/usr/bin/env python3
"""运动场地（操场跑道、足球场、篮球场、网球场……）→ public/data/sports.json（compounds 模块用）

来源：data-src/osm/landuse__geofabrik.json（tools/fetch_geofabrik.py 从 Geofabrik 陕西 PBF 提取，含 leisure=* 面）
  · leisure=track（闭合环 → 跑道外轮廓；首尾相距 < 12 m 的开放线也按闭合处理）
  · leisure=pitch（sport=soccer/basketball/tennis/volleyball/badminton/…；无 sport 的按面积推断）
  · leisure=stadium / sports_centre 不画（体育场馆建筑由通用建筑模块画）
只保留 MAIN 区域内的要素，坐标投影成世界坐标（与 tools/geo.py / src/core/geo.js 一致，保留 1 位小数）。

输出：{"version":1, "source":"© OpenStreetMap contributors", "tracks":[{"p":[x,z,...]}], "pitches":[{"s":"soccer","p":[...]}]}
用法：python tools/build_sports.py
"""
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import geo  # noqa: E402

SRC = ROOT / 'data-src' / 'osm' / 'landuse__geofabrik.json'
OUT = ROOT / 'public' / 'data' / 'sports.json'

SPORT_MAP = {
    'soccer': 'soccer', 'football': 'soccer', 'basketball': 'basketball', 'tennis': 'tennis',
    'volleyball': 'volleyball', 'badminton': 'badminton', 'table_tennis': 'table_tennis', 'multi': 'multi',
    'running': 'soccer', 'athletics': 'soccer', 'handball': 'basketball', 'baseball': 'soccer',
}


def area(p):
    a = 0.0
    n = len(p) // 2
    for i in range(n):
        j = (i + 1) % n
        a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]
    return abs(a) / 2


def main():
    d = json.load(open(SRC))
    W, S, E, N = geo.BOUNDS['MAIN']
    tracks, pitches = [], []
    for e in d['elements']:
        if e.get('type') != 'way':
            continue
        t = e.get('tags', {})
        lei = t.get('leisure')
        if lei not in ('track', 'pitch'):
            continue
        g = e.get('geometry')
        if not g or len(g) < 4:
            continue
        lon = sum(q['lon'] for q in g) / len(g)
        lat = sum(q['lat'] for q in g) / len(g)
        if not (W < lon < E and S < lat < N):
            continue
        pts = [geo.project(q['lon'], q['lat']) for q in g]
        closed = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < (12 if lei == 'track' else 1)
        if not closed:
            continue
        if math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 0.05:
            pts = pts[:-1]
        flat = [round(v, 1) for xz in pts for v in xz]
        A = area(flat)
        if lei == 'track':
            if A < 1500:
                continue
            tracks.append({'p': flat, 'n': t.get('name', '')})
        else:
            sp = (t.get('sport') or '').split(';')[0]
            s = SPORT_MAP.get(sp)
            if s is None:
                if sp:
                    continue  # 射击、彩弹等不画
                # 无 sport：大面积按足球场（学校操场），小面积按篮球场（硬地球场）
                s = 'soccer' if A > 2500 else 'basketball' if A > 250 else None
                if s is None:
                    continue
            if A < 120 or A > 40000:
                continue
            pitches.append({'s': s, 'p': flat})
    out = {'version': 1, 'source': '© OpenStreetMap contributors (leisure=track/pitch)', 'tracks': tracks, 'pitches': pitches}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    from collections import Counter
    print(f'tracks {len(tracks)}  pitches {len(pitches)} {dict(Counter(p["s"] for p in pitches))}  → {OUT} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
