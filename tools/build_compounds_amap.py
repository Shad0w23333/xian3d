#!/usr/bin/env python3
"""高德住宅小区（tools/amap_fetch.py 第三遍 poi3 → data-src/amap/compounds.json）→ public/data/local/compounds_amap.json

供 compounds 模块（src/modules/compounds.js）使用：小区真实名称 + 出入口坐标。规划时（src/arch/compound-plan.js）
把小区 POI 点落在哪个住宅用地多边形里就归哪个小区，大门放到出入口（navi.entr_location）最近的围墙边，门头写高德小区名。

坐标：高德为 GCJ-02，用 tools/amap_fetch.py 的 gcj2wgs（迭代逆变换，误差 < 0.5 m）转回 WGS-84，再用 tools/geo.py 投影到世界坐标（米，保留 1 位小数）。
类型：120300 住宅区（泛）、120301 别墅、120302 住宅小区、120303 宿舍。宿舍多是小区里的单栋楼，不单独开门（只在没有其他名称时作小区名）。
数据仅供个人本地使用（高德服务条款），输出写 public/data/local/（与其他高德衍生数据同目录）。

用法：python tools/build_compounds_amap.py [--src data-src/amap/compounds.json] [--out public/data/local/compounds_amap.json]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geo import project  # noqa: E402
from amap_fetch import gcj2wgs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
KIND = {'120300': 'res', '120301': 'villa', '120302': 'estate', '120303': 'dorm'}


def parse_ll(s):
    if not s or not isinstance(s, str) or ',' not in s:
        return None
    try:
        lon, lat = (float(v) for v in s.split(',')[:2])
    except ValueError:
        return None
    if not (100 < lon < 120 and 25 < lat < 45):
        return None
    return lon, lat


def world(ll):
    lon, lat = gcj2wgs(*ll)
    x, z = project(lon, lat)
    return round(x, 1), round(z, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=str(ROOT / 'data-src' / 'amap' / 'compounds.json'))
    ap.add_argument('--out', default=str(ROOT / 'public' / 'data' / 'local' / 'compounds_amap.json'))
    a = ap.parse_args()
    src = json.loads(Path(a.src).read_text(encoding='utf-8'))
    pois = list(src.values()) if isinstance(src, dict) else list(src)
    items, seen = [], set()
    n_entr = 0
    for p in pois:
        name = (p.get('name') or '').strip()
        tc = str(p.get('typecode') or '').split('|')[0]
        loc = parse_ll(p.get('location'))
        if not name or not loc or not tc.startswith('1203'):
            continue
        key = (name, p.get('location'))
        if key in seen:
            continue
        seen.add(key)
        x, z = world(loc)
        it = {'id': p.get('id') or '', 'n': name, 'k': KIND.get(tc, 'res'), 'x': x, 'z': z}
        entr = parse_ll((p.get('navi') or {}).get('entr_location'))
        if entr:
            it['ex'], it['ez'] = world(entr)
            n_entr += 1
        if p.get('parent'):
            it['parent'] = p['parent']
        items.append(it)
    items.sort(key=lambda it: (it['z'], it['x']))
    out = {'v': 1, 'src': 'amap poi3 (120300)', 'crs': 'world (WGS-84 projected, see docs/CONTRACT.md)', 'items': items}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    kinds = {}
    for it in items:
        kinds[it['k']] = kinds.get(it['k'], 0) + 1
    print(f'高德小区 {len(items)} 条（出入口 {n_entr}；{kinds}）→ {a.out}')


if __name__ == '__main__':
    main()
