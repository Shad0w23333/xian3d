"""现代地标调研：从 Overpass 抓取有名称/有高度/高层的建筑（分块、重试、退避）。
输出 data-src/landmarks_modern/osm_tall_named_<i>.json（原始 Overpass JSON，out geom）。
"""
import json, os, sys, time
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data-src', 'landmarks_modern')
os.makedirs(OUT, exist_ok=True)
URLS = ['https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://maps.mail.ru/osm/tools/overpass/api/interpreter']
UA = {'User-Agent': 'xian3d-research/0.1 (landmark survey; contact samgp0720 via github)'}

# 研究范围 108.72-109.12, 34.15-34.42，按 0.1 x 0.09 分块
W, S, E, N = 108.72, 34.15, 109.12, 34.42
DX, DY = 0.10, 0.09

LEV = r'^([2-9][0-9]|1[2-9])$'  # >=12 层


def q(bbox):
    s, w, n, e = bbox
    b = f'({s},{w},{n},{e})'
    return f"""[out:json][timeout:180];
(
  way["building"]["name"]{b};
  relation["building"]["name"]{b};
  way["building"]["height"]{b};
  relation["building"]["height"]{b};
  way["building"]["building:levels"~"{LEV}"]{b};
  relation["building"]["building:levels"~"{LEV}"]{b};
  way["building:part"]["height"]{b};
  way["building:part"]["building:levels"~"{LEV}"]{b};
  way["man_made"="tower"]{b};
  node["man_made"="tower"]["name"]{b};
  way["building"="train_station"]{b};
  way["building"]["building"~"stadium|grandstand|transportation"]{b};
  way["leisure"="stadium"]{b};
);
out geom tags;"""


def fetch(query):
    for attempt in range(8):
        url = URLS[attempt % len(URLS)]
        try:
            r = requests.post(url, data={'data': query}, headers=UA, timeout=240)
            if r.status_code == 200:
                return r.json()
            print('HTTP', r.status_code, url, r.text[:200], file=sys.stderr)
        except Exception as ex:  # noqa
            print('ERR', url, ex, file=sys.stderr)
        time.sleep(min(60, 5 * 2 ** attempt))
    raise RuntimeError('overpass failed')


def main():
    i = 0
    x = W
    while x < E - 1e-9:
        y = S
        while y < N - 1e-9:
            path = os.path.join(OUT, f'osm_tall_named_{i:02d}.json')
            bbox = (round(y, 4), round(x, 4), round(min(y + DY, N), 4), round(min(x + DX, E), 4))
            if not os.path.exists(path):
                d = fetch(q(bbox))
                d['_bbox'] = bbox
                json.dump(d, open(path, 'w'), ensure_ascii=False)
                print(i, bbox, len(d.get('elements', [])), flush=True)
                time.sleep(3)
            i += 1
            y += DY
        x += DX


if __name__ == '__main__':
    main()
