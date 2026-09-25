"""历史/文旅地标调研：从 Overpass 拉取原始 OSM 数据（缓存到 data-src/landmarks_historic/osm/）。

用法: .venv-tools/bin/python tools/landmarks_osm_fetch.py [名称...]
"""
import json
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data-src', 'landmarks_historic', 'osm')
os.makedirs(OUT, exist_ok=True)
URLS = ['https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter']
UA = {'User-Agent': 'xian3d-research/1.0 (landmark modelling; contact samgp0720 at gmail)'}

WALL_BB = '34.240,108.915,34.285,108.972'
QJ_BB = '34.180,108.940,34.235,108.995'

QUERIES = {
    # 城墙环：城墙、护城河、顺城巷、环城路、城门、角楼、钟鼓楼
    'wall': f"""[out:json][timeout:180];
(
  nwr["barrier"="city_wall"]({WALL_BB});
  nwr["historic"]({WALL_BB});
  nwr["barrier"="city_gate"]({WALL_BB});
  way["waterway"]({WALL_BB});
  nwr["natural"="water"]({WALL_BB});
  way["highway"]["name"~"顺城|环城"]({WALL_BB});
  nwr["name"~"门|角楼|城墙|钟楼|鼓楼|箭楼|闸楼|瓮城|城楼"]({WALL_BB});
  nwr["tourism"]["name"]({WALL_BB});
  nwr["leisure"="park"]({WALL_BB});
  nwr["place"="square"]({WALL_BB});
  way["highway"="pedestrian"]({WALL_BB});
  nwr["man_made"]({WALL_BB});
  way["building"]["name"]({WALL_BB});
  way["building:part"]({WALL_BB});
);
out body geom;""",
    # 曲江/大雁塔/不夜城
    'qujiang': f"""[out:json][timeout:180];
(
  nwr["historic"]({QJ_BB});
  nwr["tourism"]({QJ_BB});
  nwr["amenity"~"place_of_worship|theatre|arts_centre|cinema|fountain|restaurant"]["name"]({QJ_BB});
  way["building"]({QJ_BB});
  way["building:part"]({QJ_BB});
  way["highway"~"pedestrian|footway|living_street"]({QJ_BB});
  way["highway"]["name"]({QJ_BB});
  nwr["leisure"]({QJ_BB});
  nwr["natural"="water"]({QJ_BB});
  way["waterway"]({QJ_BB});
  nwr["place"="square"]({QJ_BB});
  nwr["landuse"]["name"]({QJ_BB});
  nwr["man_made"]({QJ_BB});
  nwr["shop"]["name"]({QJ_BB});
);
out body geom;""",
    # 其他历史地标（名称检索，CORE 范围）
    'others': """[out:json][timeout:180];
(
  nwr["name"~"小雁塔|荐福寺|青龙寺|大明宫|丹凤门|含元殿|兴庆宫|沉香亭|花萼相辉楼|勤政务本楼|碑林|大唐西市|未央宫|汉长安城|广仁寺|清真大寺|化觉|北院门|回民|陕西历史博物馆|大兴善寺|卧龙寺|西安博物院|城隍庙|高家大院|于右任|八路军"](34.17,108.84,34.35,109.06);
);
out body geom;""",
}


def run(name, q):
    path = os.path.join(OUT, name + '.json')
    if os.path.exists(path) and os.path.getsize(path) > 100:
        print('cached', name)
        return
    delay = 5
    for attempt in range(8):
        url = URLS[attempt % len(URLS)]
        try:
            r = requests.post(url, data={'data': q}, headers=UA, timeout=300)
            if r.status_code == 200 and r.text.lstrip().startswith('{'):
                js = r.json()
                with open(path, 'w') as f:
                    json.dump(js, f, ensure_ascii=False)
                print(name, len(js.get('elements', [])), 'elements from', url)
                return
            print(name, 'HTTP', r.status_code, r.text[:200])
        except Exception as e:  # noqa
            print(name, 'err', e)
        time.sleep(delay)
        delay = min(delay * 2, 120)
    raise SystemExit('failed ' + name)


if __name__ == '__main__':
    names = sys.argv[1:] or list(QUERIES)
    for n in names:
        run(n, QUERIES[n])
