"""OSM 原始要素下载（Overpass，分块 + 缓存 + 重试退避 + 失败自动四分）。

输出：data-src/osm/<类别>__<块名>.json（Overpass 原始 JSON，`out tags geom` / `out tags center`）
      data-src/osm/manifest.json（每个类别的块清单与状态）

用法：
  .venv-tools/bin/python tools/fetch_osm.py                # 下载全部类别（已缓存的块跳过）
  .venv-tools/bin/python tools/fetch_osm.py buildings pois # 只下载指定类别
  .venv-tools/bin/python tools/fetch_osm.py --force water  # 强制重下
  环境变量 OSM_WORKERS=并发数（默认 2，Overpass 每 IP 约 2~4 个槽位，别开大）

类别（与 docs/CONTRACT.md 3.4~3.9 对应）：
  roads_main    MAIN   motorway..tertiary 及 *_link
  roads_core    CORE   residential / unclassified / living_street / pedestrian / road
  roads_detail  城墙内 + 大唐不夜城/曲江   service / footway / pedestrian / path / steps / cycleway
  rail          MAIN   rail / subway / light_rail / 在建 / 窄轨 等 + 车站点
  rail_routes   MAIN   route=subway|light_rail|train 关系（仅成员 id，用于给轨道段补线路名）
  water         MAIN   natural=water / water=* / waterway=* / landuse=reservoir|basin（way + multipolygon relation）
  landuse       MAIN   landuse=* / leisure=* / natural=wood|grassland|scrub|... / amenity=university|school|... / place=square
  aeroway       MAIN   aeroway=*（节点/路/关系）
  buildings     MAIN   building=* / building:part=*（way + relation），自适应分块
  pois          CORE   带 name 的 shop/amenity/tourism/office/historic/leisure/healthcare/railway 站点/地铁出入口
"""
import json
import os
import re
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from geo import BOUNDS  # noqa: E402

OUT = os.path.join(ROOT, 'data-src', 'osm')
os.makedirs(OUT, exist_ok=True)
LOG = os.path.join(OUT, 'fetch.log')

UA = 'xian3d-osm-pipeline/1.0 (offline 3D city model of Xi\'an; python-requests)'
ENDPOINTS = [
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]

# 城墙内（略外扩到环城公园外沿）与 大唐不夜城/曲江（大雁塔—曲江池—芙蓉园）
WALL_BOX = (108.915, 34.243, 108.972, 34.284)
BUYECHENG_BOX = (108.945, 34.188, 108.995, 34.228)

HW_MAIN = '^(motorway|trunk|primary|secondary|tertiary)(_link)?$'
HW_CORE = '^(residential|unclassified|living_street|pedestrian|road)$'
HW_DETAIL = '^(service|footway|pedestrian|path|steps|cycleway|living_street|track)$'

# 每个类别：范围、初始分块 (列数, 行数)、查询体（{bb} 为 south,west,north,east）、输出语句、超时
CATS = {
    'roads_main': dict(area='MAIN', grid=(12, 10), timeout=210, out='out tags geom;',
                       body='way["highway"~"%s"]({bb});' % HW_MAIN),
    'roads_core': dict(area='CORE', grid=(4, 4), timeout=210, out='out tags geom;',
                       body='way["highway"~"%s"]({bb});' % HW_CORE),
    'roads_detail': dict(areas={'wall': WALL_BOX, 'buyecheng': BUYECHENG_BOX}, timeout=300, out='out tags geom;',
                         body='way["highway"~"%s"]({bb});' % HW_DETAIL),
    'rail': dict(area='MAIN', grid=(2, 2), timeout=300, out='out tags geom;',
                 body='(way["railway"~"^(rail|subway|light_rail|narrow_gauge|monorail|tram|construction|preserved|disused)$"]({bb});'
                      'node["railway"~"^(station|halt|stop|subway_entrance)$"]({bb});'
                      'node["public_transport"="station"]({bb}););'),
    'rail_routes': dict(area='MAIN', grid=(1, 1), timeout=300, out='out body;',
                        body='rel["route"~"^(subway|light_rail|train|railway|tram|monorail)$"]({bb});'),
    'water': dict(area='MAIN', grid=(8, 8), timeout=240, out='out tags geom;',
                  body='(way["natural"="water"]({bb});rel["natural"="water"]({bb});'
                       'way["water"]({bb});rel["water"]({bb});'
                       'way["waterway"~"^(river|riverbank|canal|stream|drain|ditch|dock|dam|weir)$"]({bb});'
                       'rel["waterway"~"^(riverbank|dock)$"]({bb});'
                       'way["landuse"~"^(reservoir|basin)$"]({bb});rel["landuse"~"^(reservoir|basin)$"]({bb});'
                       'way["natural"~"^(wetland|bay)$"]({bb});rel["natural"~"^(wetland|bay)$"]({bb}););'),
    'landuse': dict(area='MAIN', grid=(8, 8), timeout=240, out='out tags geom;',
                    body='(way["landuse"]({bb});rel["landuse"]({bb});'
                         'way["leisure"~"^(park|garden|pitch|golf_course|nature_reserve|recreation_ground|stadium|sports_centre|common|playground|track)$"]({bb});'
                         'rel["leisure"~"^(park|garden|golf_course|nature_reserve|recreation_ground|stadium|sports_centre|common)$"]({bb});'
                         'way["natural"~"^(wood|grassland|scrub|heath|wetland|sand|bare_rock|scree)$"]({bb});'
                         'rel["natural"~"^(wood|grassland|scrub|heath|wetland|sand)$"]({bb});'
                         'way["amenity"~"^(university|college|school|hospital|grave_yard|kindergarten)$"]({bb});'
                         'rel["amenity"~"^(university|college|school|hospital|grave_yard)$"]({bb});'
                         'way["place"="square"]({bb});way["highway"="pedestrian"]["area"="yes"]({bb});'
                         'way["tourism"~"^(zoo|theme_park|attraction)$"]["name"]({bb});rel["tourism"~"^(zoo|theme_park)$"]({bb});'
                         'way["historic"~"^(archaeological_site|tomb|castle|city_gate)$"]["name"]({bb});'
                         'rel["historic"~"^(archaeological_site|tomb)$"]({bb}););'),
    'aeroway': dict(area='MAIN', grid=(1, 1), timeout=300, out='out tags geom;',
                    body='(nwr["aeroway"]({bb});nwr["military"="airfield"]({bb}););'),
    'buildings': dict(regions=[
                          # 细节区按约 3 km 瓦片抓取，避免整区建筑量触发 Overpass 超时。
                          ('bell', (108.922, 34.248, 108.958, 34.274), 1, 1),
                          ('wall_east', (108.958, 34.248, 108.986, 34.274), 1, 1),
                          ('wall_north', (108.922, 34.274, 108.960, 34.294), 1, 1),
                          ('wall_south', (108.920, 34.222, 108.958, 34.248), 1, 1),
                          ('datang', (108.947, 34.197, 108.983, 34.225), 1, 1),
                          ('hightech', (108.846, 34.202, 108.882, 34.230), 1, 1),
                          ('weiyang', (108.924, 34.321, 108.960, 34.349), 1, 1),
                          ('xianyang', (108.680, 34.300, 108.718, 34.330), 1, 1),
                          ('yanliang', (109.200, 34.630, 109.238, 34.658), 1, 1),
                      ], timeout=180, out='out tags geom;',
                      body='(way["building"]({bb});rel["building"]({bb});'
                           'way["building:part"]({bb});rel["building:part"]({bb}););'),
    'pois': dict(area='CORE', grid=(2, 2), timeout=300, out='out tags center;',
                 body='(nwr["name"][~"^(shop|amenity|tourism|office|historic|leisure|healthcare|craft|club)$"~"."]({bb});'
                      'nwr["name"]["railway"~"^(station|halt|subway_entrance|stop)$"]({bb});'
                      'nwr["name"]["public_transport"~"^(station|stop_area)$"]({bb});'
                      'nwr["name"]["building"~"^(commercial|office|retail|hotel|hospital|school|university|train_station|church|temple|mosque|government|public|civic)$"]({bb});'
                      'nwr["name"]["man_made"~"^(tower|lighthouse)$"]({bb}););'),
}

_log_lock = threading.Lock()


def log(msg):
    line = time.strftime('%H:%M:%S ') + msg
    with _log_lock:
        print(line, flush=True)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')


def fmt_bb(b):
    w, s, e, n = b
    return f'{s:.5f},{w:.5f},{n:.5f},{e:.5f}'


def split_grid(b, nx, ny):
    w, s, e, n = b
    dx = (e - w) / nx
    dy = (n - s) / ny
    cells = []
    for j in range(ny):
        for i in range(nx):
            cells.append((f'r{j}c{i}', (w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy)))
    return cells


def quarter(name, b):
    w, s, e, n = b
    mx, my = (w + e) / 2, (s + n) / 2
    return [(name + 'a', (w, s, mx, my)), (name + 'b', (mx, s, e, my)),
            (name + 'c', (w, my, mx, n)), (name + 'd', (mx, my, e, n))]


class TooBig(Exception):
    pass


_ep_state = {'idx': 0}
_ep_lock = threading.Lock()


def wait_slot(ep):
    """查询 /api/status，若无空槽位则按提示时间等待（仅对 overpass-api.de 系有效）。"""
    if 'overpass-api.de' not in ep:
        return
    try:
        r = requests.get(ep.replace('/interpreter', '/status'), headers={'User-Agent': UA}, timeout=20)
        t = r.text
        if re.search(r'(\d+) slots? available now', t):
            return
        waits = [int(x) for x in re.findall(r'in (\d+) seconds', t)]
        if waits:
            w = min(waits) + 2
            log(f'  等待槽位 {w}s')
            time.sleep(min(w, 120))
    except Exception:
        pass


def overpass(query, timeout, label):
    """执行一次查询：多端点轮换，429/504/busy 退避重试。区块过大（超时/内存）抛 TooBig 由调用方四分。"""
    delay = 10
    too_big_hits = 0
    for attempt in range(12):
        with _ep_lock:
            ep = ENDPOINTS[_ep_state['idx'] % len(ENDPOINTS)]
        wait_slot(ep)
        try:
            r = requests.post(ep, data={'data': query}, headers={'User-Agent': UA}, timeout=timeout + 120)
            code = r.status_code
            txt = r.text if code != 200 else None
            if code == 200:
                try:
                    js = r.json()
                except ValueError:
                    body = r.text[:400]
                    if 'timed out' in body or 'out of memory' in body:
                        too_big_hits += 1
                        if too_big_hits >= 2:
                            raise TooBig(body)
                    raise RuntimeError('非 JSON 响应: ' + re.sub(r'\s+', ' ', body)[:200])
                remark = js.get('remark', '')
                if remark and ('runtime error' in remark or 'timed out' in remark):
                    if 'timed out' in remark or 'out of memory' in remark or 'memory' in remark:
                        too_big_hits += 1
                        if too_big_hits >= 2:
                            raise TooBig(remark)
                    raise RuntimeError('remark: ' + remark[:200])
                return js
            if code in (429, 503, 502, 504):
                if code in (502, 504):
                    too_big_hits += 1
                    if too_big_hits >= 2:
                        raise TooBig(f'HTTP {code}')
                raise RuntimeError(f'HTTP {code}')
            if code == 400:
                raise SystemExit(f'查询语法错误 {label}: {txt[:600]}')
            raise RuntimeError(f'HTTP {code}: {(txt or "")[:200]}')
        except TooBig:
            raise
        except SystemExit:
            raise
        except Exception as ex:  # 网络错误、忙、限流
            message = str(ex).lower()
            if 'timeout' in message or 'timed out' in message or 'http 502' in message or 'http 504' in message:
                too_big_hits += 1
                if too_big_hits >= 2:
                    raise TooBig(str(ex))
            log(f'  [{label}] 第{attempt + 1}次失败 @{ep.split("/")[2]}: {str(ex)[:160]}；{delay}s 后重试')
            with _ep_lock:
                _ep_state['idx'] += 1  # 换端点
            time.sleep(delay)
            delay = min(delay * 1.6, 180)
    raise RuntimeError(f'{label} 多次重试仍失败')


def cache_path(cat, name):
    return os.path.join(OUT, f'{cat}__{name}.json')


def fetch_cell(cat, spec, name, bbox, force=False, depth=0):
    """下载一个块；过大则四分递归。返回写出的文件列表。"""
    path = cache_path(cat, name)
    if os.path.exists(path) and not force:
        return [path]
    # 若之前已经四分过（子块存在），直接走子块
    subs = quarter(name, bbox)
    if not force and any(os.path.exists(cache_path(cat, sn)) for sn, _ in subs):
        out = []
        for sn, sb in subs:
            out += fetch_cell(cat, spec, sn, sb, force, depth + 1)
        return out
    q = f'[out:json][timeout:{spec["timeout"]}][maxsize:1073741824];{spec["body"].replace("{bb}", fmt_bb(bbox))}{spec["out"]}'
    t0 = time.time()
    try:
        js = overpass(q, spec['timeout'], f'{cat}/{name}')
    except TooBig as ex:
        if depth >= 4:
            raise RuntimeError(f'{cat}/{name} 四分 4 层仍过大: {ex}')
        log(f'  [{cat}/{name}] 过大（{str(ex)[:80]}），四分')
        out = []
        for sn, sb in subs:
            out += fetch_cell(cat, spec, sn, sb, force, depth + 1)
        return out
    js['_bbox'] = bbox
    js['_query'] = q
    js['_fetched'] = time.strftime('%Y-%m-%dT%H:%M:%S')
    tmp = path + '.part'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(js, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)
    log(f'  [{cat}/{name}] {len(js.get("elements", []))} 要素，{os.path.getsize(path) / 1e6:.1f} MB，{time.time() - t0:.0f}s')
    return [path]


def cells_for(cat, spec):
    if 'areas' in spec:
        return list(spec['areas'].items())
    if 'regions' in spec:
        cells = []
        for region, bbox, nx, ny in spec['regions']:
            cells.extend((f'{region}_{name}', cell) for name, cell in split_grid(bbox, nx, ny))
        return cells
    return split_grid(BOUNDS[spec['area']], *spec['grid'])


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    force = '--force' in sys.argv
    cats = args or list(CATS)
    for c in cats:
        if c not in CATS:
            raise SystemExit(f'未知类别 {c}；可选：{", ".join(CATS)}')
    workers = int(os.environ.get('OSM_WORKERS', '2'))
    manifest_path = os.path.join(OUT, 'manifest.json')
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding='utf-8') as f:
            manifest = json.load(f)
    for cat in cats:
        spec = CATS[cat]
        cells = cells_for(cat, spec)
        log(f'== {cat}: {len(cells)} 块')
        files, errors = [], []
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(fetch_cell, cat, spec, n, b, force): n for n, b in cells}
            for fu in as_completed(futs):
                try:
                    files += fu.result()
                except Exception as e:  # 单块失败不影响其它块，重跑即可补齐
                    errors.append(futs[fu])
                    log(f'  !! {cat}/{futs[fu]} 失败：{e}')
        manifest[cat] = {'files': sorted(os.path.basename(p) for p in files),
                         'complete': not errors, 'failed': errors,
                         'updated': time.strftime('%Y-%m-%dT%H:%M:%S')}
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
        size = sum(os.path.getsize(os.path.join(OUT, p)) for p in manifest[cat]['files'])
        log(f'== {cat} 完成：{len(files)} 文件 {size / 1e6:.1f} MB' + (f'，失败 {errors}（重跑补齐）' if errors else ''))


def load_elements(cat):
    """供构建脚本使用：读取某类别全部缓存块，按 (type,id) 去重后返回元素列表。"""
    import glob
    seen = {}
    for p in sorted(glob.glob(os.path.join(OUT, f'{cat}__*.json'))):
        with open(p, encoding='utf-8') as f:
            js = json.load(f)
        for el in js.get('elements', []):
            seen.setdefault((el['type'], el['id']), el)
    return list(seen.values())


if __name__ == '__main__':
    main()
