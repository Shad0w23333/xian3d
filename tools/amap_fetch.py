#!/usr/bin/env python3
"""高德开放平台 Web 服务 API → 更新 POI（店名/地名/类别）与道路（补缺失路段、补路名）。

OSM 在西安的 POI 只有约 9 千条且陈旧；高德同范围有十几万条。本脚本只调用官方 Web 服务接口（需要你自己的 Key），
不抓取高德矢量/栅格瓦片。请遵守高德服务条款（数据仅供个人本地使用，不要公开发布生成的数据文件），注意每日配额。

准备：https://console.amap.com/dev/key/app 创建应用 → 添加 Key，服务平台选“Web服务”。
  export AMAP_KEY=你的Key

用法：
  python tools/amap_fetch.py poi   [--bbox 108.84,34.17,109.08,34.40] [--max-requests 4000]   # 多边形 POI 搜索（可多次运行续传）
  python tools/amap_fetch.py roads [--bbox ...]                                             # 交通态势·矩形区域道路（带路名/等级）
  python tools/amap_fetch.py status                                                        # 已缓存请求数与 POI 数
  python tools/amap_fetch.py merge                                                         # 合并进 public/data/pois.json、roads.json
缓存：data-src/amap/（每个请求一个 JSON，断点续传；原始数据文件会备份为 *.before_amap.json）
坐标：高德为 GCJ-02，合并时逆变换回 WGS-84（迭代法，误差 < 0.5 m）再投影到世界坐标。
"""
import argparse
import hashlib
import json
import math
import os
import shutil
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geo import project  # noqa: E402
from imagery_pack import wgs2gcj  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data-src' / 'amap'
DATA = ROOT / 'public' / 'data'
API = 'https://restapi.amap.com'
DEFAULT_BBOX = (108.84, 34.17, 109.08, 34.40)  # CORE + 未央/浐灞北扩
# 大类（6 位类型码的前 2 位 + 0000）：餐饮 购物 生活服务 体育休闲 医疗 住宿 风景名胜 商务住宅 政府机构 科教文化 交通设施 金融 汽车服务
TYPES = '050000|060000|070000|080000|090000|100000|110000|120000|130000|140000|150000|160000|010000'
MAX_PER_CELL = 200  # 单次查询可翻页取回的上限（超过则四分细分）


def gcj2wgs(lon, lat):
    """GCJ-02 → WGS-84（迭代逆变换）"""
    x, y = lon, lat
    for _ in range(6):
        gx, gy = wgs2gcj(x, y)
        x, y = x - (gx - lon), y - (gy - lat)
    return x, y


class Client:
    def __init__(self, key, qps=3.0, max_requests=4000):
        import requests
        self.s = requests.Session()
        self.key = key
        self.dt = 1.0 / qps
        self.last = 0.0
        self.left = max_requests
        self.sent = 0

    def get(self, path, params):
        """带磁盘缓存的 GET；返回 JSON。配额用尽抛 SystemExit（已缓存的结果保留，下次续传）"""
        q = dict(params)
        h = hashlib.md5((path + json.dumps(q, sort_keys=True)).encode()).hexdigest()
        f = CACHE / 'req' / h[:2] / (h + '.json')
        if f.exists():
            return json.loads(f.read_text('utf-8'))
        if self.left <= 0:
            raise SystemExit(f'本次运行已达 --max-requests 上限（实发 {self.sent} 次），重新运行即可续传。')
        wait = self.last + self.dt - time.time()
        if wait > 0:
            time.sleep(wait)
        for k in range(4):
            try:
                r = self.s.get(API + path, params={**q, 'key': self.key}, timeout=20)
                self.last = time.time()
                j = r.json()
                break
            except Exception as e:  # 网络错误：退避重试
                if k == 3:
                    raise
                time.sleep(2 * (k + 1))
        self.left -= 1
        self.sent += 1
        st = str(j.get('status', j.get('errcode', '')))
        info = j.get('info') or j.get('errmsg') or ''
        if st not in ('1', '0') or (st == '0' and info not in ('OK', '')):
            if 'DAILY_QUERY_OVER_LIMIT' in info or 'ACCESS_TOO_FREQUENT' in info or 'CUQPS' in info or 'OVER_LIMIT' in info:
                raise SystemExit(f'高德配额/频率限制：{info}（已缓存的请求保留，明天或降低 --qps 后续传）')
            if 'INVALID_USER_KEY' in info or 'USERKEY' in info or 'SERVICE_NOT_AVAILABLE' in info:
                raise SystemExit(f'Key 无效或未开通 Web 服务：{info}')
        if str(j.get('status')) == '1' or j.get('infocode') == '10000':
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(j, ensure_ascii=False), 'utf-8')
        return j


def wgs_bbox_to_gcj(b):
    w, s, e, n = b
    (w2, s2), (e2, n2) = wgs2gcj(w, s), wgs2gcj(e, n)
    return w2, s2, e2, n2


# ───────────────────────── POI ─────────────────────────
def poi_cell(cli, w, s, e, n, out, depth=0):
    poly = f'{w:.6f},{n:.6f}|{e:.6f},{s:.6f}'
    base = {'polygon': poly, 'types': TYPES, 'page_size': 25, 'show_fields': 'business'}
    j = cli.get('/v5/place/polygon', {**base, 'page_num': 1})
    cnt = int(j.get('count') or 0)
    pois = list(j.get('pois') or [])
    if (cnt >= MAX_PER_CELL or len(pois) == 25 and cnt == 0) and (e - w) > 0.0015 and depth < 8:
        mx, my = (w + e) / 2, (s + n) / 2
        for (a, b, c, d) in ((w, my, mx, n), (mx, my, e, n), (w, s, mx, my), (mx, s, e, my)):
            poi_cell(cli, a, b, c, d, out, depth + 1)
        return
    page = 1
    while len(pois) < cnt and page * 25 < MAX_PER_CELL:
        page += 1
        jj = cli.get('/v5/place/polygon', {**base, 'page_num': page})
        got = jj.get('pois') or []
        if not got:
            break
        pois += got
    for p in pois:
        out[p.get('id') or (p.get('name', '') + p.get('location', ''))] = p


def cmd_poi(cli, bbox, cell):
    # 记录抓取范围（合并时只替换这个范围内的 OSM POI）
    mf = CACHE / 'meta.json'
    meta = json.loads(mf.read_text('utf-8')) if mf.exists() else {'boxes': []}
    if list(bbox) not in meta['boxes']:
        meta['boxes'].append(list(bbox))
    mf.parent.mkdir(parents=True, exist_ok=True)
    mf.write_text(json.dumps(meta), 'utf-8')
    w, s, e, n = wgs_bbox_to_gcj(bbox)
    out = {}
    nx, ny = math.ceil((e - w) / cell), math.ceil((n - s) / cell)
    print(f'POI：{nx}×{ny} 个初始网格（{cell}°），四叉细分直到每格 < {MAX_PER_CELL} 条')
    try:
        for i in range(nx):
            for k in range(ny):
                poi_cell(cli, w + i * cell, s + k * cell, min(e, w + (i + 1) * cell), min(n, s + (k + 1) * cell), out)
            print(f'  列 {i + 1}/{nx}：累计 {len(out)} 条，本次实发请求 {cli.sent}', flush=True)
    finally:
        save_pois(out)


def save_pois(out):
    f = CACHE / 'pois.json'
    old = json.loads(f.read_text('utf-8')) if f.exists() else {}
    old.update(out)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(old, ensure_ascii=False), 'utf-8')
    print(f'已保存 {len(old)} 条 POI → {f}')


# ───────────────────────── 道路（交通态势·矩形） ─────────────────────────
def cmd_roads(cli, bbox, cell=0.02):
    """矩形对角线 ≤ 10 km；每格查询两次：level=4（高速~主干）与 level=6（全部，含一般/无名道路）"""
    w, s, e, n = wgs_bbox_to_gcj(bbox)
    roads = {}
    nx, ny = math.ceil((e - w) / cell), math.ceil((n - s) / cell)
    print(f'道路：{nx}×{ny} 格 × 2 次请求')
    for i in range(nx):
        for k in range(ny):
            rect = f'{w + i * cell:.6f},{s + k * cell:.6f};{min(e, w + (i + 1) * cell):.6f},{min(n, s + (k + 1) * cell):.6f}'
            for level in (4, 6):
                j = cli.get('/v3/traffic/status/rectangle', {'rectangle': rect, 'level': level, 'extensions': 'all'})
                for r in ((j.get('trafficinfo') or {}).get('roads') or []):
                    pl = r.get('polyline')
                    if not pl:
                        continue
                    key = (r.get('name') or '') + '|' + pl[:60]
                    it = roads.setdefault(key, {'n': r.get('name') or '', 'pl': pl, 'dir': r.get('direction') or '', 'lv': level})
                    it['lv'] = min(it['lv'], level)
        print(f'  列 {i + 1}/{nx}：累计 {len(roads)} 段，本次实发请求 {cli.sent}', flush=True)
    f = CACHE / 'roads.json'
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(list(roads.values()), ensure_ascii=False), 'utf-8')
    print(f'已保存 {len(roads)} 段 → {f}')


# ───────────────────────── 合并 ─────────────────────────
def poi_kind(tc, name):
    """高德 6 位类型码 → 本项目 POI 类别（与 OSM amenity/shop 取值一致，招牌模块据此选样式）和重要度"""
    t2, t4 = tc[:2], tc[:4]
    big = any(k in name for k in ('万达', '万象', '大悦城', '购物中心', '广场', '百货', '奥莱', '天街', '吾悦', '赛格', '王府井', '开元', 'SKP', '熙地港', '大融城'))
    M = {
        '0501': ('restaurant', 1), '0502': ('restaurant', 1), '0503': ('fast_food', 1), '0504': ('restaurant', 0),
        '0505': ('cafe', 1), '0506': ('cafe', 0), '0507': ('ice_cream', 0), '0508': ('bakery', 0), '0509': ('cafe', 0),
        '0601': ('mall', 3 if big else 2), '0602': ('convenience', 0), '0604': ('supermarket', 1), '0607': ('marketplace', 1),
        '0611': ('clothes', 0), '0612': ('shop', 0), '0614': ('shop', 0),
        '0703': ('shop', 0), '0705': ('post_office', 0), '0710': ('shop', 0),
        '0803': ('karaoke_box', 0), '0805': ('cinema', 1), '0801': ('sports_centre', 1),
        '0901': ('hospital', 2), '0902': ('hospital', 1), '0903': ('clinic', 0), '0906': ('pharmacy', 0),
        '1001': ('hotel', 2 if any(k in name for k in ('酒店', '饭店')) else 1), '1002': ('motel', 0),
        '1101': ('park', 1), '1102': ('attraction', 2),
        '1202': ('landmark', 1), '1203': ('residential', 0), '1201': ('landmark', 1),
        '1301': ('townhall', 1), '1305': ('police', 0),
        '1401': ('museum', 2), '1403': ('gallery', 1), '1404': ('library', 1), '1405': ('museum', 1), '1408': ('exhibition_centre', 2),
        '1412': ('school', 1), '1502': ('station', 3), '1504': ('bus_station', 1), '1505': ('station', 2), '1509': ('parking', 0),
        '1601': ('bank', 1), '1602': ('bank', 0), '1603': ('atm', 0), '0101': ('fuel', 0), '0111': ('charging_station', 0),
    }
    if tc.startswith('141201'):
        return 'university', 2
    if tc.startswith('141204'):
        return 'kindergarten', 0
    if tc.startswith('150501'):
        return 'subway_entrance', 0
    if t4 in M:
        return M[t4]
    return {'05': ('restaurant', 0), '06': ('shop', 0), '07': ('shop', 0), '08': ('leisure', 0), '09': ('clinic', 0), '10': ('hotel', 0),
            '11': ('attraction', 1), '12': ('landmark', 0), '13': ('townhall', 0), '14': ('school', 0), '15': ('transport', 0),
            '16': ('bank', 0), '01': ('fuel', 0)}.get(t2, ('landmark', 0))


def clean_name(n):
    return n.strip()


def merge_pois(core_cap=20000):
    f = CACHE / 'pois.json'
    if not f.exists():
        print('没有高德 POI 缓存，跳过（先运行 poi）')
        return
    A = json.loads(f.read_text('utf-8'))
    src = DATA / 'pois.json'
    bak = ROOT / 'data-src' / 'pois.before_amap.json'
    if not bak.exists():
        shutil.copy(src, bak)
    osm = json.loads(bak.read_text('utf-8'))['pois']
    out, seen = [], set()
    kinds = Counter()
    for p in A.values():
        try:
            lon, lat = map(float, p['location'].split(','))
        except Exception:
            continue
        wl, wa = gcj2wgs(lon, lat)
        x, z = project(wl, wa)
        name = clean_name(p.get('name') or '')
        if not name:
            continue
        k, imp = poi_kind(str(p.get('typecode') or '').split('|')[0], name)
        if k == 'residential':
            continue  # 小区名不做招牌（数量极大）
        key = (name, round(x / 30), round(z / 30))
        if key in seen:
            continue
        seen.add(key)
        out.append({'n': name, 'k': k, 'x': round(x, 1), 'z': round(z, 1), 'i': imp, 'src': 'amap'})
        kinds[k] += 1
    # 保留高德范围外的 OSM POI，以及范围内高德没有的地标类（城门、遗址、雕塑等）
    mf = CACHE / 'meta.json'
    boxes = json.loads(mf.read_text('utf-8'))['boxes'] if mf.exists() else [list(DEFAULT_BBOX)]
    wboxes = []
    for (bw, bs, be, bn) in boxes:
        (ax, az), (bx, bz) = project(bw, bn), project(be, bs)
        wboxes.append((ax, bx, az, bz))
    names = {p['n'] for p in out}
    keepk = {'city_gate', 'archaeological_site', 'artwork', 'memorial', 'monument', 'ruins', 'tomb', 'place_of_worship', 'landmark'}
    for p in osm:
        inside = any(x0 <= p['x'] <= x1 and z0 <= p['z'] <= z1 for (x0, x1, z0, z1) in wboxes)
        if not inside or (p['k'] in keepk and p['n'] not in names):
            out.append(p)
    # 核心区条数上限：按重要度保留
    core = [p for p in out if -10300 < p['x'] < 11000 and -10200 < p['z'] < 11000]
    if len(core) > core_cap:
        core.sort(key=lambda p: (-p['i'], 0 if p.get('src') == 'amap' else 1))
        drop = {id(p) for p in core[core_cap:] if p['i'] == 0}
        out = [p for p in out if id(p) not in drop]
    for p in out:
        p.pop('src', None)
    with open(src, 'w', encoding='utf-8') as fp:
        json.dump({'pois': out}, fp, ensure_ascii=False, separators=(',', ':'))
    print(f'pois.json：OSM {len(osm)} → 合并后 {len(out)} 条（高德类别 {kinds.most_common(12)}）')


def merge_roads():
    f = CACHE / 'roads.json'
    if not f.exists():
        print('没有高德道路缓存，跳过（先运行 roads）')
        return
    import numpy as np
    import shapely
    from shapely.strtree import STRtree
    from build_data import ROAD_LANE_W, ROAD_LANES_TWOWAY, ROAD_EXTRA_TWOWAY
    src = DATA / 'roads.json'
    bak = ROOT / 'data-src' / 'roads.before_amap.json'
    if not bak.exists():
        shutil.copy(src, bak)
    R = json.loads(bak.read_text('utf-8'))
    cls = R['classes']
    ci = {c: i for i, c in enumerate(cls)}
    ex = [np.array(ft['p'], float).reshape(-1, 2) for ft in R['features']]
    tex = STRtree([shapely.LineString(p) for p in ex])
    A = json.loads(f.read_text('utf-8'))
    added = named = 0
    for r in A:
        pts = []
        for s in r['pl'].split(';'):
            try:
                lon, lat = map(float, s.split(','))
            except ValueError:
                continue
            pts.append(project(*gcj2wgs(lon, lat)))
        if len(pts) < 2:
            continue
        p = np.array(pts)
        ls = shapely.LineString(p)
        if ls.length < 20:
            continue
        smp = [ls.interpolate(d) for d in np.arange(5, ls.length, 10)] or [ls.interpolate(0.5, normalized=True)]
        idx, dist = tex.query_nearest(smp, max_distance=30, return_distance=True, all_matches=False)
        d = np.full(len(smp), 1e9)
        d[idx[0]] = dist
        cov = (d < 10).mean()
        name = r['n']
        if cov >= 0.5:
            # 已有路段：补路名（高德路名更全更新）
            if name:
                hit = Counter(idx[1][dist < 10]).most_common(1)
                if hit:
                    ft = R['features'][hit[0][0]]
                    if not ft.get('n'):
                        ft['n'] = name
                        named += 1
            continue
        lv = r.get('lv', 6)
        if '高速' in name:
            c = 'motorway'
        elif lv <= 4 and any(k in name for k in ('快速', '绕城', '环')):
            c = 'trunk'
        elif lv <= 4:
            c = 'primary'
        elif name:
            c = 'tertiary'
        else:
            c = 'residential'
        lanes = ROAD_LANES_TWOWAY.get(c, 2) // (2 if r.get('dir') else 1) or 1
        w = lanes * ROAD_LANE_W.get(c, 3.0) + ROAD_EXTRA_TWOWAY.get(c, 0.5) / 2
        q = np.round(np.array(ls.simplify(1.0).coords), 1)
        R['features'].append({'c': ci[c], 'n': name, 'w': round(max(3.0, w), 1), 'l': lanes, 'o': 0, 'b': 0, 't': 0, 'y': 0,
                              'p': q.flatten().tolist()})
        added += 1
    with open(src, 'w', encoding='utf-8') as fp:
        json.dump(R, fp, ensure_ascii=False, separators=(',', ':'))
    print(f'roads.json：新增高德路段 {added} 段，为原无名路段补路名 {named} 段')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['poi', 'roads', 'status', 'merge'])
    ap.add_argument('--key', default=os.environ.get('AMAP_KEY', ''))
    ap.add_argument('--bbox', default=','.join(map(str, DEFAULT_BBOX)), help='WGS-84 西,南,东,北')
    ap.add_argument('--cell', type=float, default=0.01, help='POI 初始网格（度）')
    ap.add_argument('--qps', type=float, default=3.0)
    ap.add_argument('--max-requests', type=int, default=4000, help='本次运行最多实发请求数（配额保护，可多天续传）')
    ap.add_argument('--core-cap', type=int, default=20000, help='合并后核心区 POI 上限（按重要度保留）')
    a = ap.parse_args()
    bbox = tuple(map(float, a.bbox.split(',')))
    if a.cmd == 'status':
        n = sum(1 for _ in (CACHE / 'req').rglob('*.json')) if (CACHE / 'req').exists() else 0
        p = CACHE / 'pois.json'
        print(f'已缓存请求 {n} 个；POI {len(json.loads(p.read_text("utf-8"))) if p.exists() else 0} 条；道路缓存 {"有" if (CACHE / "roads.json").exists() else "无"}')
        return
    if a.cmd == 'merge':
        merge_pois(a.core_cap)
        merge_roads()
        return
    if not a.key:
        sys.exit('需要高德 Web 服务 Key：--key 或环境变量 AMAP_KEY（控制台 https://console.amap.com/dev/key/app ，服务平台选“Web服务”）')
    cli = Client(a.key, a.qps, a.max_requests)
    if a.cmd == 'poi':
        cmd_poi(cli, bbox, a.cell)
    else:
        cmd_roads(cli, bbox)


if __name__ == '__main__':
    main()
