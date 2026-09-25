"""机场与交通调研：Overpass 原始数据抓取（带缓存、重试、退避）。
输出到 data-src/airports_research/osm_*.json
用法: .venv-tools/bin/python tools/airports_overpass.py [名称...]
"""
import json, os, sys, time
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data-src', 'airports_research')
os.makedirs(OUT, exist_ok=True)
UA = 'xian3d-research/0.1 (3D city model; contact samgp0720 at gmail)'
ENDPOINTS = ['https://overpass-api.de/api/interpreter',
             'https://overpass.private.coffee/api/interpreter',
             'https://maps.mail.ru/osm/tools/overpass/api/interpreter']

XIY = '34.40,108.70,34.48,108.82'
MAIN = '33.95,108.60,34.72,109.40'
YL = '34.60,109.18,34.68,109.30'
WEI = '34.28,108.60,34.62,109.40'

Q = {
    # 咸阳机场范围内全部 aeroway 要素 + 相关建筑/车站/塔
    'xiy_aeroway': f'[out:json][timeout:180];(nwr["aeroway"]({XIY}););out tags geom;',
    'xiy_misc': f'''[out:json][timeout:180];(
      nwr["building"]["name"]({XIY});
      nwr["building"~"terminal|hangar|transportation|parking|control_tower"]({XIY});
      nwr["man_made"~"tower|mast"]({XIY});
      nwr["railway"~"station|halt|stop"]({XIY});
      nwr["public_transport"="station"]({XIY});
      nwr["amenity"="parking"]({XIY});
      nwr["railway"~"rail|subway|light_rail"]({XIY});
      way["highway"~"motorway|trunk|primary|secondary|motorway_link|trunk_link|primary_link"]({XIY});
      nwr["landuse"~"construction|military"]({XIY});
    );out tags geom;''',
    # MAIN 内所有机场/直升机场/简易跑道
    'main_aerodromes': f'''[out:json][timeout:180];(
      nwr["aeroway"~"aerodrome|heliport|helipad|airstrip|runway"]({MAIN});
      nwr["military"="airfield"]({MAIN});
      nwr["name"~"机场"]({MAIN});
    );out tags geom;''',
    'yanliang_aeroway': f'''[out:json][timeout:180];(
      nwr["aeroway"]({YL});
      nwr["building"~"hangar"]({YL});
      nwr["building"]["name"]({YL});
    );out tags geom;''',
    # 交通骨架：二环/三环/绕城 + 高快速路
    'ring_roads': f'''[out:json][timeout:240];(
      way["highway"]["name"~"二环|三环|绕城|环城"]({MAIN});
      way["highway"]["ref"~"G3001|G30|G5|G65|G70|G108|G210|G312|S1|S2"]({MAIN});
    );out tags geom;''',
    'motorways': f'''[out:json][timeout:240];(
      way["highway"~"^(motorway|trunk)$"]({MAIN});
    );out tags geom;''',
    'interchanges': f'''[out:json][timeout:180];(
      node["highway"="motorway_junction"]({MAIN});
      nwr["name"~"立交|互通"]({MAIN});
    );out tags center;''',
    'main_roads_named': f'''[out:json][timeout:240];(
      way["highway"~"^(primary|secondary|trunk)$"]["name"~"^(长安(南|北|中)?路|未央路|南大街|北大街|东大街|西大街|科技路|锦业路|南二环|北二环|东二环|西二环|朱雀大街|含光路|太白(南|北)?路|雁塔(南|北)?路|凤城|丈八|高新路|唐延路|明光路|文景路|长乐(东|西|中)?路|劳动(南|北)?路|大庆路|咸宁(东|西|中)?路|西影路|曲江池|芙蓉|雁翔路|纬二街|东大街|环城(南|北|东|西)路)"]({MAIN});
    );out tags geom;''',
    'rail': f'''[out:json][timeout:240];(
      way["railway"~"^(rail|light_rail|subway|construction)$"]({MAIN});
    );out tags geom;''',
    'metro_routes': f'''[out:json][timeout:240];(
      relation["route"~"subway|light_rail"]({MAIN});
    );out tags;''',
    'stations': f'''[out:json][timeout:180];(
      nwr["railway"="station"]({MAIN});
    );out tags center;''',
    'weihe': f'''[out:json][timeout:240];(
      way["waterway"="river"]["name"~"渭河"]({WEI});
      relation["waterway"="river"]["name"~"渭河"]({WEI});
    );out tags geom;''',
    'bridges_wei': f'''[out:json][timeout:240];(
      way["bridge"]["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|motorway_link|trunk_link|primary_link)$"]({WEI});
      way["bridge"]["railway"~"^(rail|light_rail|subway)$"]({WEI});
      nwr["man_made"="bridge"]({WEI});
    );out tags geom;''',
    'xiguan': '''[out:json][timeout:120];(
      nwr["name"~"西关机场|西关|机场"](34.22,108.84,34.32,108.92);
      nwr["aeroway"](34.22,108.84,34.32,108.92);
      nwr["historic"](34.22,108.84,34.32,108.92);
    );out tags center;''',
}


def fetch(name, q):
    path = os.path.join(OUT, f'osm_{name}.json')
    if os.path.exists(path) and os.path.getsize(path) > 100:
        print('缓存', name)
        return
    delay = 5
    for attempt in range(8):
        ep = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            r = requests.post(ep, data={'data': q}, headers={'User-Agent': UA}, timeout=300)
            if r.status_code == 200 and r.text.lstrip().startswith('{'):
                d = r.json()
                if d.get('remark') and 'error' in d.get('remark', '').lower():
                    raise RuntimeError(d['remark'][:200])
                with open(path, 'w') as f:
                    json.dump(d, f, ensure_ascii=False)
                print('完成', name, len(d.get('elements', [])), ep)
                return
            print('失败', name, ep, r.status_code, r.text[:150].replace('\n', ' '))
        except Exception as e:
            print('异常', name, ep, e)
        time.sleep(delay)
        delay = min(delay * 2, 90)
    print('放弃', name)


if __name__ == '__main__':
    names = [n for n in (sys.argv[1:] or list(Q)) if n in Q]
    for n in names:
        fetch(n, Q[n])
        time.sleep(2)

# 追加：T5 多边形关系完整几何 + 东航站区建筑
Q2 = {
    't5_rel': '[out:json][timeout:120];rel(17337522);out geom;',
    'xiy_buildings': f'[out:json][timeout:180];(way["building"]({XIY});rel["building"]({XIY}););out tags geom;',
}
if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'q2':
    for n, q in Q2.items():
        fetch(n, q)
        time.sleep(2)
