#!/usr/bin/env python3
"""高德开放平台 Web 服务 API → 更新 POI（店名/地名/类别）与道路（补缺失路段、补路名）。

OSM 在西安的 POI 只有约 9 千条且陈旧；高德同范围有十几万条。本脚本只调用官方 Web 服务接口（需要你自己的 Key），
不抓取高德矢量/栅格瓦片。请遵守高德服务条款（数据仅供个人本地使用，不要公开发布生成的数据文件），注意每日配额。

准备：https://console.amap.com/dev/key/app 创建应用 → 添加 Key，服务平台选“Web服务”。
  在仓库根目录 .env 里写一行 AMAP_KEY=你的Key（.env 不入库），或 export AMAP_KEY=你的Key

用法：
  python tools/amap_fetch.py poi   [--bbox 108.84,34.17,109.08,34.40] [--max-requests 4000]   # 多边形 POI 搜索（可多次运行续传）
  python tools/amap_fetch.py roads [--bbox ...]                                             # 交通态势·矩形区域道路（带路名/等级）
  python tools/amap_fetch.py status                                                        # 已缓存请求数、POI 数、已完成网格数
  python tools/amap_fetch.py metro                                                         # 地铁全部线路折线 + 车站（公交路线查询）
  python tools/amap_fetch.py district                                                      # 西安各区县边界 + 街道/镇名
  python tools/amap_fetch.py place                                                         # 按 research/refs/landmarks2026 清单逐个定位地标
  python tools/amap_fetch.py all                                                           # 以上全部 + poi + roads（一次跑完，配额内续传）
  python tools/amap_fetch.py merge                                                         # 合并进 public/data/pois.json、roads.json
缓存：data-src/amap/（每个请求一个 JSON，断点续传；原始数据文件会备份为 *.before_amap.json）
续传：meta.json 只记录“整格抓完且无失败请求”的初始网格；merge 只在这些网格里用高德 POI 替换 OSM POI
      （高德 POI 也只取这些网格里的），未抓完的地方保留 OSM（多天抓取中途 merge 不会挖空，也不会两套并存）。
坐标：高德为 GCJ-02，合并时逆变换回 WGS-84（迭代法，误差 < 0.5 m）再投影到世界坐标。
"""
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
import time
import zlib
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geo import project  # noqa: E402
from imagery_pack import wgs2gcj  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data-src' / 'amap'
DATA = ROOT / 'public' / 'data'
API = 'https://restapi.amap.com'
DEFAULT_BBOX = (108.84, 34.17, 109.08, 34.40)  # CORE + 未央/浐灞北扩
# 类型：餐饮 购物 生活服务 体育休闲 医疗 住宿 风景名胜 政府机构 科教文化 金融 汽车服务，
# 商务住宅只要产业园区/楼宇（1203 住宅区 merge 时本就丢弃），交通设施只要火车站/长途汽车站/地铁站（含出入口）——
# 公交车站 1507、停车场 1509 数量极大、不做招牌也不是地标，只会白耗翻页请求。中类代码会带上其下所有小类。
TYPES = ('050000|060000|070000|080000|090000|100000|110000|120100|120200|130000|140000|'
         '150200|150400|150500|160000|010000')
# v5 多边形搜索：count 只是“本页条数”（不是总数），以“满页”判断是否还有更多
PAGE = 25            # v5 page_size 上限
SPLIT_PAGES = 8      # 一格超过 8 页（200 条）就四分细分
MAX_PAGE = 100       # v5 page_num 上限
MIN_CELL = 0.0003    # 细分后的最小网格边长（度，约 30 m）；到此仍多于 200 条就逐页翻到第 100 页

# 高德 Web 服务错误码（infocode）分类
QUOTA_CODES = {'10003', '10010', '10029', '10044', '10045', '40000', '40002', '40003'}      # 日配额/套餐用尽
FATAL_CODES = {'10001', '10002', '10005', '10006', '10007', '10008', '10009', '10011', '10012', '10013',
               '10026', '10041', '20000', '20001', '20002', '20011'}                        # Key/权限/参数：每个请求都会失败
RATE_CODES = {'10004', '10014', '10019', '10020', '10021'}                                  # QPS/频率限制：退避重试
BUSY_CODES = {'10015', '10016', '10017', '20003'}                                           # 网关超时/服务忙/未知：重试（另加 3xxxx 引擎错误）


class AmapCellError(Exception):
    """单个请求多次重试仍失败（服务忙、引擎错误、未知错误码）：记为失败格，不能当成“这里没有数据”"""


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
        self.fails = 0   # 连续失败请求数（系统性错误时及早停下，不要把整个范围都记成“失败格”）

    def _http(self, path, q):
        """一次 HTTP 请求（网络错误退避重试）；每次实发都计入 --max-requests 配额"""
        for k in range(4):
            if self.left <= 0:
                raise SystemExit(f'本次运行已达 --max-requests 上限（实发 {self.sent} 次），重新运行即可续传。')
            wait = self.last + self.dt - time.time()
            if wait > 0:
                time.sleep(wait)
            self.left -= 1
            self.sent += 1
            try:
                r = self.s.get(API + path, params={**q, 'key': self.key}, timeout=20)
                self.last = time.time()
                return r.json()
            except Exception:  # 网络错误 / 非 JSON 响应：退避重试
                self.last = time.time()
                if k == 3:
                    raise
                time.sleep(2 * (k + 1))

    def get(self, path, params):
        """带磁盘缓存的 GET；只有 status=1 的成功响应才返回（并缓存）。
        配额用尽、Key/权限/参数错误、持续限流 → SystemExit（已缓存的结果保留，下次续传）；
        服务忙/引擎错误等重试后仍失败 → AmapCellError（调用方记为失败格）。"""
        q = dict(params)
        h = hashlib.md5((path + json.dumps(q, sort_keys=True)).encode()).hexdigest()
        f = CACHE / 'req' / h[:2] / (h + '.json')
        if f.exists():
            return json.loads(f.read_text('utf-8'))
        code = info = ''
        rate = False
        for attempt in range(6):
            j = self._http(path, q)
            if not isinstance(j, dict):
                j = {'status': '0', 'info': f'非预期响应 {str(j)[:60]}', 'infocode': ''}
            if str(j.get('status')) == '1':
                self.fails = 0
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(json.dumps(j, ensure_ascii=False), 'utf-8')
                return j
            code = str(j.get('infocode') or j.get('errcode') or '')
            info = str(j.get('info') or j.get('errmsg') or '')
            if code in QUOTA_CODES or 'DAILY_QUERY_OVER_LIMIT' in info or 'QUOTA_PLAN_RUN_OUT' in info:
                raise SystemExit(f'高德配额用尽：{code} {info}（已缓存的请求保留，明天或换 Key 后重新运行续传）')
            if code in FATAL_CODES or 'INVALID_USER_KEY' in info or 'INSUFFICIENT_PRIVILEGES' in info:
                hint = '（Key 未开通该服务的权限：控制台确认服务平台为“Web服务”）' if code == '10012' else ''
                raise SystemExit(f'高德返回错误 {code} {info}{hint}：{path} {q}')
            rate = code in RATE_CODES or 'QPS' in info or 'ACCESS_TOO_FREQUENT' in info
            busy = code in BUSY_CODES or code.startswith('3')
            if not (rate or busy) or attempt == 5:
                break
            if rate:
                self.dt = min(self.dt * 1.25, 5.0)   # 被限流：本次运行后续请求放慢
            time.sleep((10.0 if code == '10004' else 2.0) * (attempt + 1))
        if rate:
            raise SystemExit(f'高德持续限流 {code} {info}：请降低 --qps 后重新运行（已缓存的请求保留）')
        self.fails += 1
        if self.fails >= 20:
            raise SystemExit(f'连续 {self.fails} 个请求失败（最近一次 {code} {info}），停止运行；请检查参数/Key 后重新运行')
        raise AmapCellError(f'{code} {info}'.strip() or '未知错误')


def wgs_bbox_to_gcj(b):
    """WGS 矩形 → 覆盖它的 GCJ 矩形（四个角都转换后取外包，偏移随位置变化，只转两个角可能漏边）"""
    w, s, e, n = b
    cs = [wgs2gcj(lon, lat) for lon, lat in ((w, s), (w, n), (e, s), (e, n))]
    return min(c[0] for c in cs), min(c[1] for c in cs), max(c[0] for c in cs), max(c[1] for c in cs)


# ───────────────────────── POI ─────────────────────────
def _poi_key(p):
    return p.get('id') or (str(p.get('name', '')) + str(p.get('location', '')))


def poi_cell(cli, w, s, e, n, out, stat, depth=0):
    """抓一个 GCJ 矩形里的全部 POI。v5 的 count 只是本页条数，不能当总数用：
    第 1 页不满 → 这一格就这么多；满页 → 探第 9 页：有数据（> 200 条）且还能细分就四分递归，
    否则逐页翻到短页为止（不能再分的最小格最多翻到第 100 页，仍满页则打印截断警告）。
    请求失败（AmapCellError）记入 stat['failed']，不当成空格。"""
    poly = f'{w:.6f},{n:.6f}|{e:.6f},{s:.6f}'
    base = {'polygon': poly, 'types': TYPES, 'page_size': PAGE, 'show_fields': 'business'}

    def page(k):
        ps = cli.get('/v5/place/polygon', {**base, 'page_num': k}).get('pois') or []
        for p in ps:
            out[_poi_key(p)] = p
        return ps

    try:
        if len(page(1)) < PAGE:
            return
        can_split = min(e - w, n - s) / 2 >= MIN_CELL and depth < 12
        if can_split and page(SPLIT_PAGES + 1):
            mx, my = (w + e) / 2, (s + n) / 2
            for (a, b, c, d) in ((w, my, mx, n), (mx, my, e, n), (w, s, mx, my), (mx, s, e, my)):
                poi_cell(cli, a, b, c, d, out, stat, depth + 1)
            return
        last = SPLIT_PAGES if can_split else MAX_PAGE
        for k in range(2, last + 1):
            if len(page(k)) < PAGE:
                return
        if not can_split:
            stat['truncated'] += 1
            print(f'  ！网格 {poly} 翻到第 {MAX_PAGE} 页仍满页，超出部分取不到（已截断）', flush=True)
    except AmapCellError as ex:
        stat['failed'].append(poly)
        print(f'  ！网格 {poly} 请求失败：{ex}（不计入已完成范围，重新运行会重试）', flush=True)


def cmd_poi(cli, bbox, cell):
    mf = CACHE / 'meta.json'
    meta = json.loads(mf.read_text('utf-8')) if mf.exists() else {}
    meta.setdefault('boxes', [])
    if list(bbox) not in meta['boxes']:
        meta['boxes'].append(list(bbox))   # 只作记录；merge 以 done（整格抓完的初始网格，GCJ 边界）为准
    done = {tuple(c) for c in meta.get('done', [])}
    out = {}

    def flush(quiet):
        # 先存 POI 再存 done：done 里的格子，其 POI 一定已经落盘
        save_pois(out, quiet)
        meta['done'] = sorted(done)
        mf.parent.mkdir(parents=True, exist_ok=True)
        mf.write_text(json.dumps(meta), 'utf-8')

    w, s, e, n = wgs_bbox_to_gcj(bbox)
    stat = {'failed': [], 'truncated': 0}
    nx, ny = math.ceil((e - w) / cell), math.ceil((n - s) / cell)
    print(f'POI：{nx}×{ny} 个初始网格（{cell}°），多于 {SPLIT_PAGES * PAGE} 条的格子四叉细分（最小 {MIN_CELL}°）')
    try:
        for i in range(nx):
            for k in range(ny):
                c = (w + i * cell, s + k * cell, min(e, w + (i + 1) * cell), min(n, s + (k + 1) * cell))
                nf = len(stat['failed'])
                poi_cell(cli, *c, out, stat)
                if len(stat['failed']) == nf:
                    done.add(tuple(round(v, 6) for v in c))
            flush(True)
            print(f'  列 {i + 1}/{nx}：累计 {len(out)} 条，本次实发请求 {cli.sent}', flush=True)
    finally:
        flush(False)
    if stat['truncated']:
        print(f'注意：{stat["truncated"]} 个最小网格超过 {MAX_PAGE * PAGE} 条被截断')
    if stat['failed']:
        raise SystemExit(f'{len(stat["failed"])} 个网格请求失败（未计入已完成范围，merge 时那里保留 OSM POI），重新运行 poi 即可补抓')


def save_pois(out, quiet=False):
    f = CACHE / 'pois.json'
    old = json.loads(f.read_text('utf-8')) if f.exists() else {}
    old.update(out)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(old, ensure_ascii=False), 'utf-8')
    if not quiet:
        print(f'已保存 {len(old)} 条 POI → {f}')


# ───────────────────────── 道路（交通态势·矩形） ─────────────────────────
def cmd_roads(cli, bbox, cell=0.02):
    """矩形对角线 ≤ 10 km；每格查询两次：level=4（高速~主干）与 level=6（全部，含一般/无名道路）。
    交通态势的 roads[] 每条是一个行车方向（direction/angle），双向路会以两条（折线互逆）出现，merge 时再配对。"""
    w, s, e, n = wgs_bbox_to_gcj(bbox)
    roads, failed = {}, []
    nx, ny = math.ceil((e - w) / cell), math.ceil((n - s) / cell)
    print(f'道路：{nx}×{ny} 格 × 2 次请求')
    f = CACHE / 'roads.json'
    try:
        for i in range(nx):
            for k in range(ny):
                rect = f'{w + i * cell:.6f},{s + k * cell:.6f};{min(e, w + (i + 1) * cell):.6f},{min(n, s + (k + 1) * cell):.6f}'
                for level in (4, 6):
                    try:
                        j = cli.get('/v3/traffic/status/rectangle', {'rectangle': rect, 'level': level, 'extensions': 'all'})
                    except AmapCellError as ex:
                        failed.append(f'{rect} level={level}')
                        print(f'  ！{rect} level={level} 请求失败：{ex}', flush=True)
                        continue
                    for r in ((j.get('trafficinfo') or {}).get('roads') or []):
                        pl = r.get('polyline')
                        if not pl or not isinstance(pl, str):
                            continue
                        name = r.get('name') if isinstance(r.get('name'), str) else ''
                        ang = r.get('angle')
                        key = name + '|' + pl[:60]
                        it = roads.setdefault(key, {'n': name, 'pl': pl,
                                                    'dir': r.get('direction') if isinstance(r.get('direction'), str) else '',
                                                    'ang': ang if isinstance(ang, (str, int, float)) else '', 'lv': level})
                        it['lv'] = min(it['lv'], level)
            print(f'  列 {i + 1}/{nx}：累计 {len(roads)} 段，本次实发请求 {cli.sent}', flush=True)
    finally:
        # 中途停下也写出已取到的部分（成功响应都在请求缓存里，重新运行会从缓存重建并补齐）
        if roads:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(list(roads.values()), ensure_ascii=False), 'utf-8')
            print(f'已保存 {len(roads)} 段 → {f}')
    if failed:
        raise SystemExit(f'{len(failed)} 个道路请求失败，roads.json 缺这些格子；重新运行 roads 即可补抓')


# ───────────────────────── 合并 ─────────────────────────
# 与 src/modules/signage.js 的 SIGN_KINDS / bucketPOIs 保持一致（这些类别才会生成招牌）
SIGN_KINDS = {'shop', 'restaurant', 'fast_food', 'cafe', 'bank', 'atm', 'hotel', 'motel', 'hostel', 'guest_house', 'pharmacy',
              'post_office', 'clinic', 'dentist', 'ice_cream', 'bar', 'pub', 'karaoke_box', 'cinema', 'marketplace', 'food_court',
              'nightclub', 'internet_cafe', 'theatre', 'mall', 'supermarket', 'bakery', 'doctors'}
BRAND_RE = re.compile(r'银行|中国移动|中国联通|中国电信|邮政|酒店|宾馆|饭店')
ROOF_NAME_RE = re.compile(r'大厦|酒店|饭店|宾馆|大酒店|国际|中心|银行|商城|百货|广场|SKP|万达|赛格|开元|金花|王府井|集团|书城|图书大厦')
NAME_SKIP_RE = re.compile(r'小区|公寓|住宅|宿舍|家属|号楼|栋|单元|幢|期$|工地|围挡')
# poi_kind 有意输出、但招牌模块不渲染的类别（标注/停站等用）；出现此外的类别说明映射表与前端脱节
NON_SIGN_KINDS = {'station', 'landmark', 'school', 'university', 'kindergarten', 'hospital', 'park', 'attraction', 'museum',
                  'gallery', 'library', 'exhibition_centre', 'arts_centre', 'research_institute', 'townhall', 'police',
                  'bus_station', 'fuel', 'charging_station', 'sports_centre', 'leisure', 'transport', 'driver_training'}
# 高德 6 位类型码前 4 位 → 本项目类别（与 OSM 管线一致：商店一律 'shop'）与重要度。
# 重要度与 build_data.poi_importance 对齐：有名称的店铺/餐饮/银行/诊所/药店/邮局/旅馆等普通设施 = 1，
# ATM、充电站这类附属设施 = 0（OSM 的 amenity=atm 也是 0）；否则 cap_core 按重要度取舍时店铺会整类被挤掉
POI_KIND_MAP = {
    '0501': ('restaurant', 1), '0502': ('restaurant', 1), '0503': ('fast_food', 1), '0504': ('restaurant', 1),
    '0505': ('cafe', 1), '0506': ('cafe', 1), '0507': ('ice_cream', 1), '0508': ('bakery', 1), '0509': ('cafe', 1),
    '0602': ('shop', 1), '0604': ('supermarket', 1), '0607': ('marketplace', 1),   # 0602 便利店
    '0611': ('shop', 1), '0612': ('shop', 1), '0614': ('shop', 1),                  # 0611 服装鞋帽 0612 专卖 0614 化妆品
    '0703': ('shop', 1), '0704': ('post_office', 1), '0705': ('shop', 1), '0710': ('shop', 1),   # 0704 邮局 0705 物流速递
    '0801': ('sports_centre', 1), '0803': ('karaoke_box', 1), '0805': ('leisure', 1), '0806': ('cinema', 1),  # 0805 休闲场所 0806 影剧院
    '0901': ('hospital', 2), '0902': ('hospital', 1), '0903': ('clinic', 1), '0906': ('pharmacy', 1),
    '1002': ('motel', 1),
    '1101': ('park', 1), '1102': ('attraction', 2),
    '1201': ('landmark', 1), '1202': ('landmark', 1),
    '1301': ('townhall', 1), '1305': ('police', 1),
    '1401': ('museum', 2), '1402': ('exhibition_centre', 1), '1403': ('exhibition_centre', 2), '1404': ('gallery', 1),
    '1405': ('library', 1), '1406': ('museum', 1), '1407': ('museum', 1), '1408': ('arts_centre', 1),   # 1406 科技馆 1407 天文馆 1408 文化宫
    '1409': ('landmark', 0), '1410': ('arts_centre', 0), '1411': ('landmark', 1), '1412': ('school', 1),  # 档案馆 文艺团体 传媒机构
    '1413': ('research_institute', 1), '1415': ('driver_training', 1),
    '1504': ('bus_station', 1), '1505': ('station', 2),
    '1601': ('bank', 1), '1602': ('bank', 1), '1603': ('atm', 0),
    '0101': ('fuel', 1), '0111': ('charging_station', 0),
    '0104': ('shop', 1), '0108': ('shop', 1),   # 0104 汽车养护/装饰 0108 汽车配件（OSM 的 shop=car_repair/car_parts 同为 'shop'）
}
POI_KIND_T2 = {'05': ('restaurant', 1), '06': ('shop', 1), '07': ('shop', 1), '08': ('leisure', 1), '09': ('clinic', 1),
               '10': ('hotel', 1), '11': ('attraction', 1), '12': ('landmark', 0), '13': ('townhall', 1), '14': ('school', 1),
               '15': ('transport', 0), '16': ('bank', 1), '01': ('fuel', 1)}
# 国铁大站（与 build_data.POI_FAMOUS / 现有 pois.json 的 i=3 车站一致）：traffic.js 只让国铁/高铁在 i>=3 的车站停车
MAJOR_STATION_RE = re.compile(r'^(西安(北|东|南|西)?|阿房宫|咸阳(西)?|引镇)站$')
PAREN_RE = re.compile(r'[（(][^）)]*[）)]')


def strip_paren(n):
    return PAREN_RE.sub('', n).strip()


def poi_kind(tc, name):
    """高德 6 位类型码 → (本项目 POI 类别, 重要度)。类别与 OSM amenity/shop 取值一致（商店统一为 'shop'），
    招牌模块据此选样式。返回 (None, 0) 表示不收：住宅小区、公交车站、停车场、火车站内部设施与货运站。"""
    t2, t4 = tc[:2], tc[:4]
    if t4 in ('1203', '1507', '1509'):
        return None, 0   # 小区名不做招牌（数量极大）；公交站、停车场不是地标（build_data 同样去掉公交站台）
    if t4 == '1502':
        # 只有 150200 是车站本身；候车室/进出站口/站台/售票/改签/货运站等子类都不是客运停靠站
        base = strip_paren(name) or name
        if tc[:6] != '150200' or re.search(r'进站|出站|检票|候车|售票|取票|站台|停车|[-－—]', base):
            return None, 0
        return 'station', (3 if MAJOR_STATION_RE.match(base if base.endswith('站') else base + '站') else 1)
    big = any(k in name for k in ('万达', '万象', '大悦城', '购物中心', '广场', '百货', '奥莱', '天街', '吾悦', '赛格', '王府井', '开元', 'SKP', '熙地港', '大融城'))
    if t4 == '0601':
        return 'mall', (3 if big else 2)
    if t4 == '1001':
        # 100101 奢华酒店、100102 五星级 → 2（OSM 同样只给五星/大体量酒店 2）；名称带“酒店”的快捷酒店很多，不能都进必留档
        return 'hotel', (2 if tc[:6] in ('100101', '100102') else 1)
    if tc.startswith('100201'):
        return 'hostel', 1   # 青年旅舍
    if tc.startswith('080602') or tc.startswith('080603'):
        return 'theatre', 1   # 音乐厅、剧场
    if tc.startswith('141201'):
        return 'university', 2
    if tc.startswith('141204'):
        return 'kindergarten', 0
    if tc.startswith('150501'):
        return 'subway_entrance', 0
    if t4 in POI_KIND_MAP:
        return POI_KIND_MAP[t4]
    return POI_KIND_T2.get(t2, ('landmark', 0))


def clean_name(n):
    return n.strip() if isinstance(n, str) else ''


def metro_exit_name(name):
    """高德地铁出入口名（“钟楼(地铁站)A口”“钟楼地铁站C口(西北口)”）→ 招牌模块 planMetro 解析的“钟楼-A口”；
    认不出出口编号的返回空串（planMetro 也做不了雨棚）"""
    s = re.sub(r'[（(]地铁站[)）]', '', name)
    s = strip_paren(s)
    m = re.match(r'^(?:地铁)?(?:\d+号线)?(.+?)(?:地铁站)?\s*[-－—]?\s*([A-Za-z]\d{0,2})\s*(?:出入)?口$', s)
    return f'{m[1].strip()}-{m[2].upper()}口' if m and m[1].strip() else ''


def poi_name(k, name):
    """写入 pois.json 的名称。分店后缀“(赛格国际购物中心店)”会让招牌模块把普通店铺当商场（MALL_RE 用原名匹配），
    显示时 signText 本来也会去掉括号，所以商场以外的类别直接去掉括号部分。"""
    if k == 'subway_entrance':
        return metro_exit_name(name)
    if k == 'station':
        b = strip_paren(name) or name        # “钟楼(地铁站)” → “钟楼站”（与 build_data 的车站命名一致）
        return b if b.endswith('站') else b + '站'
    if k == 'mall':
        return name
    return strip_paren(name) or name


def sign_rendered(p):
    """招牌模块（signage.bucketPOIs）是否会用到这个 POI"""
    k, n = p['k'], p['n']
    if k == 'subway_entrance' or k in SIGN_KINDS:
        return True
    return k == 'landmark' and bool(BRAND_RE.search(n) or (ROOF_NAME_RE.search(n) and not NAME_SKIP_RE.search(n)))


CAP_NONSIGN_W = 0.5   # cap_core：前端暂不渲染的类别（学校、园区、派出所……）按招牌类别一半的比例保留


def cap_core(out, core_cap):
    """核心区条数上限（CONTRACT：CORE 内 ≤ core_cap）。i>=2、车站、地铁口始终保留；其余按类别分层、统一比例抽稀：
    每个类别保留 ⌊r·w·n⌋ 条（n 为该类条数；招牌类别 w=1，其它 w=CAP_NONSIGN_W；r 二分求出，使总数正好填满配额），
    类别内按重要度 → 名称+坐标的稳定哈希取前若干条。不再按重要度整档填满——那样一个档（例如全部餐厅）
    就能吃掉整个配额，便利店、药店、服装店会被整类删光；哈希抽稀在空间上均匀，不会因抓取顺序把东半城整片删光。"""
    def in_core(p):
        return -10300 < p['x'] < 11000 and -10200 < p['z'] < 11000
    core = [p for p in out if in_core(p)]
    if len(core) <= core_cap:
        return out

    def fixed(p):
        return p['i'] >= 2 or p['k'] in ('subway_entrance', 'station')
    keep = [p for p in core if fixed(p)]
    quota = core_cap - len(keep)
    if quota < 0:
        print(f'警告：核心区必留的 POI（i>=2/车站/地铁口）已有 {len(keep)} 条，超过上限 {core_cap}')
        quota = 0
    groups = defaultdict(list)
    for p in core:
        if not fixed(p):
            groups[(p['k'], sign_rendered(p))].append(p)
    if not groups:
        return out
    wt = {g: 1.0 if g[1] else CAP_NONSIGN_W for g in groups}

    def take(r):
        return {g: min(len(v), int(r * wt[g] * len(v))) for g, v in groups.items()}
    lo, hi = 0.0, 1.0 / min(wt.values())   # r=hi 时每类都全留（总数 > quota，否则前面已返回）
    for _ in range(60):
        mid = (lo + hi) / 2
        if sum(take(mid).values()) <= quota:
            lo = mid
        else:
            hi = mid
    n = take(lo)
    # 取整剩下的名额按小数部分从大到小各补一条
    left = quota - sum(n.values())
    for g in sorted((g for g in groups if n[g] < len(groups[g])), key=lambda g: -(lo * wt[g] * len(groups[g]) % 1))[:max(0, left)]:
        n[g] += 1
    drop = set()
    for g, v in groups.items():
        v.sort(key=lambda p: (-p['i'], zlib.crc32(f"{p['n']}|{p['x']}|{p['z']}".encode())))
        drop.update(id(p) for p in v[n[g]:])
    return [p for p in out if id(p) not in drop]


def _sha1(path):
    return hashlib.sha1(path.read_bytes()).hexdigest() if path.exists() else ''


def merge_base(src, bak, tag):
    """merge 的底稿 data-src/*.before_amap.json。public/data 下的文件若已不是上次 merge 写出的
    （build_data.py / roads_update.py 重新生成过），就用它刷新底稿——否则会用旧底稿把新数据覆盖掉。"""
    stf = CACHE / 'merge_state.json'
    st = json.loads(stf.read_text('utf-8')) if stf.exists() else {}
    cur = _sha1(src)
    if not bak.exists():
        bak.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, bak)
    elif st.get(tag) and cur != st[tag] and cur != _sha1(bak):
        print(f'{src.name} 在上次 merge 之后被重新生成，用它刷新底稿 {bak.name}')
        shutil.copy(src, bak)
    elif not st.get(tag) and cur != _sha1(bak):
        print(f'注意：没有上次 merge 的记录，沿用已有底稿 {bak}（若 {src.name} 是新生成的，请先删掉该底稿）')


def merge_done(tag, src):
    stf = CACHE / 'merge_state.json'
    st = json.loads(stf.read_text('utf-8')) if stf.exists() else {}
    st[tag] = _sha1(src)
    stf.parent.mkdir(parents=True, exist_ok=True)
    stf.write_text(json.dumps(st), 'utf-8')


def amap_done_region():
    """已整格抓完的初始网格（GCJ）→ 世界坐标下的并集多边形；没有记录时返回 None"""
    import shapely
    mf = CACHE / 'meta.json'
    meta = json.loads(mf.read_text('utf-8')) if mf.exists() else {}
    cells = meta.get('done') or []
    if not cells:
        print('警告：meta.json 没有“已完成网格”记录（旧版脚本抓的，或还没抓完任何网格）——本次不合并高德 POI，OSM POI 全部保留。'
              '请重新运行 poi：请求类型已改，旧版脚本缓存的请求用不上，需要重新抓取（会消耗配额，可用 --max-requests 分多天续传）')
        return None
    polys = [shapely.Polygon([project(*gcj2wgs(lon, lat)) for lon, lat in ((w, s), (e, s), (e, n), (w, n))])
             for (w, s, e, n) in cells]
    region = shapely.unary_union(polys)
    boxes = meta.get('boxes') or []
    if boxes:
        req = shapely.unary_union([shapely.Polygon([project(lon, lat) for lon, lat in ((w, s), (e, s), (e, n), (w, n))])
                                   for (w, s, e, n) in boxes])
        frac = region.intersection(req).area / max(req.area, 1e-9)
        if frac < 0.999:
            print(f'警告：高德 POI 只完成了请求范围的 {frac:.0%}，未完成处保留 OSM POI（继续运行 poi 续传后再 merge）')
    return region


def merge_pois(core_cap=20000):
    f = CACHE / 'pois.json'
    if not f.exists():
        print('没有高德 POI 缓存，跳过（先运行 poi）')
        return
    import numpy as np
    import shapely
    A = json.loads(f.read_text('utf-8'))
    src = DATA / 'pois.json'
    bak = ROOT / 'data-src' / 'pois.before_amap.json'
    merge_base(src, bak, 'pois')
    osm = json.loads(bak.read_text('utf-8'))['pois']
    out, seen = [], set()
    kinds = Counter()
    near = defaultdict(list)   # (类别, 名称) → 已收坐标：车站、地铁口同名近距离只留一个
    radius = {'subway_entrance': lambda i: 60, 'station': lambda i: 800 if i >= 3 else 150}
    # OSM 车站一律保留（换乘站 OSM 每条线一个点，traffic.js 靠它在各条线上停车）；高德同名车站在近处已有 OSM 点时不再加，
    # 否则同一站会停两次
    osm_st = defaultdict(list)
    for p in osm:
        if p['k'] == 'station':
            osm_st[p['n']].append((p['x'], p['z']))
    # 只在“整格抓完”的网格里用高德替换 OSM；高德 POI 也只收这些网格里的——未抓完/请求失败的格子里
    # OSM POI 全部保留，若再加进高德的就会两套并存（名称略有差异的去重不掉，招牌成双）
    region = amap_done_region()
    cand = []
    for p in A.values():
        try:
            lon, lat = map(float, p['location'].split(','))
        except Exception:
            continue
        raw = clean_name(p.get('name'))
        if not raw:
            continue
        k, imp = poi_kind(str(p.get('typecode') or '').split('|')[0], raw)
        if k is None:
            continue
        name = poi_name(k, raw)
        if not name:
            continue
        cand.append((name, k, imp, *project(*gcj2wgs(lon, lat))))
    if region is not None and cand:
        shapely.prepare(region)
        in_done = shapely.contains_xy(region, np.array([c[3] for c in cand]), np.array([c[4] for c in cand]))
    else:
        in_done = np.zeros(len(cand), bool)
    n_out = int(len(cand) - in_done.sum())
    for (name, k, imp, x, z), ok in zip(cand, in_done):
        if not ok:
            continue
        key = (name, round(x / 30), round(z / 30))
        if key in seen:
            continue
        if k in radius:
            r = radius[k](imp)
            if any(math.hypot(qx - x, qz - z) < r for qx, qz in near[(k, name)]):
                continue
            if k == 'station' and any(math.hypot(qx - x, qz - z) < max(r, 400) for qx, qz in osm_st.get(name, ())):
                continue
            near[(k, name)].append((x, z))
        seen.add(key)
        out.append({'n': name, 'k': k, 'x': round(x, 1), 'z': round(z, 1), 'i': imp})
        kinds[k] += 1
    if n_out and region is not None:
        print(f'高德 POI {n_out} 条不在已完成网格内（未抓完/请求失败的格子），本次不收，那里保留 OSM POI')
    odd = sorted(k for k in kinds if k not in SIGN_KINDS and k not in NON_SIGN_KINDS and k != 'subway_entrance')
    if odd:
        print(f'警告：高德映射出前端未知的类别 {odd}（招牌模块不会渲染，检查 POI_KIND_MAP）')
    # 已完成网格内：高德没有的地标类（城门、遗址、雕塑等）照样保留；
    # 地铁口按位置/名称与高德去重（高德缺的出口保留），车站见上
    xs = np.array([p['x'] for p in osm], float)
    zs = np.array([p['z'] for p in osm], float)
    inside = shapely.contains_xy(region, xs, zs) if region is not None and len(osm) else np.zeros(len(osm), bool)
    names = {p['n'] for p in out}
    ent = defaultdict(list)
    for p in out:
        if p['k'] == 'subway_entrance':
            ent[(round(p['x'] / 200), round(p['z'] / 200))].append((p['x'], p['z'], p['n']))

    def amap_ent(x, z, r, name=None):
        gx, gz = round(x / 200), round(z / 200)
        return any(math.hypot(qx - x, qz - z) < r and (name is None or qn == name)
                   for dx in (-1, 0, 1) for dz in (-1, 0, 1) for qx, qz, qn in ent.get((gx + dx, gz + dz), ()))
    keepk = {'city_gate', 'archaeological_site', 'artwork', 'memorial', 'monument', 'ruins', 'tomb', 'place_of_worship', 'landmark'}
    n_rep = 0
    for p, ins in zip(osm, inside):
        k, x, z = p['k'], p['x'], p['z']
        if k == 'station':
            drop = False
        elif (p['n'], round(x / 30), round(z / 30)) in seen:
            drop = True    # 高德已有同名同地
        elif k == 'subway_entrance':
            drop = amap_ent(x, z, 25) or amap_ent(x, z, 150, p['n'])
        elif ins:
            drop = not (k in keepk and p['n'] not in names)
        else:
            drop = False
        if drop:
            n_rep += 1
            continue
        out.append(p)
    out = cap_core(out, core_cap)
    with open(src, 'w', encoding='utf-8') as fp:
        json.dump({'pois': out}, fp, ensure_ascii=False, separators=(',', ':'))
    merge_done('pois', src)
    print(f'pois.json：OSM {len(osm)}（被高德替换 {n_rep}）→ 合并后 {len(out)} 条（高德类别 {kinds.most_common(12)}）')


# —— 道路合并参数 ——
ROAD_STEP = 5.0       # 沿线采样间距 m
ROAD_COVER = 10.0     # 采样点 10 m 内有与之大致平行（|cos| > ROAD_PAR）的 OSM 车行道 → 视为已有
ROAD_PAR = 0.7        # 夹角 < 45° 才算“同一条路”；相交穿过的道路（含桥下、隧道上方、高速）不算覆盖
ROAD_CROSS_COS = 0.94  # 覆盖段内 OSM 路与高德线夹角 ≥ 20°（|cos| 中位数 < 0.94）→ 是斜穿而不是重合
ROAD_GAP = 150.0      # 斜穿造成的、两侧都未覆盖的短覆盖段（≤ 150 m，可含双幅路/立交多条）回填，路不在交叉处断开
ROAD_PAIR = 6.0       # 两条高德线相距 < 6 m：反向 → 同一条双向路的两个方向；同向 → 重复
ROAD_MIN_RUN = 30.0   # 新增路段最短 30 m
ROAD_SNAP = 15.0      # 新增路段端点吸附到 15 m 内的已有道路（共用顶点，roads_net 才会生成路口）
ROAD_JOIN_REUSE = 3.0  # 吸附/平交点 3 m 内已有顶点就复用该顶点
ROAD_NAME_COS = 0.95  # 补路名：只数与 OSM 路段平行（夹角 < 18°）的采样
ROAD_NAME_SHARE = 0.5  # 补路名：该路名（按 5 m 位置去重）覆盖 OSM 路段长度的 ≥ 50%
ROAD_NAME_MIN = 30.0  # 且 ≥ 30 m；短于 30 m 的路口连接段不补名（它在高德里的对应线 < 20 m 已被丢弃，没有自己的“无名”票）
ROAD_NONVEH = {'footway', 'pedestrian'}
ROAD_NAME_CLS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified'}
# 高速/快速路及其匝道：与普通道路立体交叉，不共用节点（否则 traffic_net 会让车在高速上直接拐进小路）
ROAD_HIGH = {'motorway', 'trunk', 'motorway_link', 'trunk_link'}
_DIRV = {'东': (1, 0), '西': (-1, 0), '南': (0, 1), '北': (0, -1)}


def travel_heading(r):
    """交通态势 roads[] 一条的行车方向（世界坐标向量；x 东、z 南），只用来判断折线要不要反转。
    优先用 direction 文本“从东向西”（含义明确）；没有再用 angle（以正东为 0°、逆时针为正 → (cos, -sin)）；都没有返回 None"""
    m = re.match(r'^从?(.+?)向(.+)$', r.get('dir') or '')
    if m:
        def v(t):
            return sum(_DIRV[c][0] for c in t if c in _DIRV), sum(_DIRV[c][1] for c in t if c in _DIRV)
        (ax, az), (bx, bz) = v(m[1]), v(m[2])
        if (bx - ax, bz - az) != (0, 0):
            return bx - ax, bz - az
    try:
        a = math.radians(float(r.get('ang')))
        return math.cos(a), -math.sin(a)
    except (TypeError, ValueError):
        return None


def amap_road_class(name, lv):
    """高德路名 + 等级（lv=4：高速/快速/主干，6：其余）→ 本项目道路类别"""
    if '辅路' in name:
        return 'secondary'     # “西安绕城高速辅路”“南二环辅路”是地面辅道，不是高速/快速路
    if '高速' in name:
        return 'motorway'
    if lv <= 4 and re.search(r'快速|绕城|[二三四]环', name):
        return 'trunk'         # “环城南路”等环城路是主干道，不按快速路
    if lv <= 4:
        return 'primary'
    return 'tertiary' if name else 'residential'


def _split_runs(d, st, k0, k1, min_run):
    """一段连续需要新增的采样 [k0,k1]：按单/双向状态切子段，短于 min_run 的子段并入较长的邻段；
    返回 [(起点里程, 终点里程, 状态)]，相邻子段在两采样中点处首尾相接。"""
    subs = []
    a = k0
    for k in range(k0 + 1, k1 + 2):
        if k == k1 + 1 or st[k] != st[a]:
            subs.append([a, k - 1, int(st[a])])
            a = k

    def lo(s):
        return d[s[0]] if s[0] == k0 else (d[s[0] - 1] + d[s[0]]) / 2

    def hi(s):
        return d[s[1]] if s[1] == k1 else (d[s[1]] + d[s[1] + 1]) / 2
    while len(subs) > 1:
        j = min(range(len(subs)), key=lambda t: hi(subs[t]) - lo(subs[t]))
        if hi(subs[j]) - lo(subs[j]) >= min_run:
            break
        nb = [t for t in (j - 1, j + 1) if 0 <= t < len(subs)]
        t = max(nb, key=lambda q: hi(subs[q]) - lo(subs[q]))
        subs[t] = [min(subs[t][0], subs[j][0]), max(subs[t][1], subs[j][1]), subs[t][2]]
        del subs[j]
        m = []
        for s in subs:   # 合并后相邻同状态的子段连起来
            if m and m[-1][2] == s[2]:
                m[-1][1] = s[1]
            else:
                m.append(s)
        subs = m
    return [(lo(s), hi(s), s[2]) for s in subs]


def _nearest_on(coords, P):
    """折线 coords（[[x,z],...]）上离 P 最近的点：(距离, 线段序号, 点)"""
    best = (1e18, 0, None)
    for i in range(len(coords) - 1):
        ax, az = coords[i]
        bx, bz = coords[i + 1]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz
        t = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, ((P[0] - ax) * dx + (P[1] - az) * dz) / L2))
        qx, qz = ax + t * dx, az + t * dz
        dd = math.hypot(P[0] - qx, P[1] - qz)
        if dd < best[0]:
            best = (dd, i, (qx, qz))
    return best


def _vertex_on(coords, P, reuse=ROAD_JOIN_REUSE):
    """让折线 coords（就地修改）在离 P 最近处有一个顶点：该处 reuse 米内已有顶点就用它，否则把垂足（取 0.1 m）插进去。
    返回 (顶点, 顶点序号, 是否新插入)"""
    _, seg, Q = _nearest_on(coords, P)
    vi = min((seg, seg + 1), key=lambda j: math.hypot(coords[j][0] - Q[0], coords[j][1] - Q[1]))
    if math.hypot(coords[vi][0] - Q[0], coords[vi][1] - Q[1]) < reuse:
        return list(coords[vi]), vi, False
    V = [round(Q[0], 1), round(Q[1], 1)]
    coords.insert(seg + 1, V)
    return list(V), seg + 1, True


def _ensure_vertex(coords, V):
    """V（离折线 coords 几米以内）若还不是它的顶点，就插进离 V 最近的线段；返回是否插入"""
    if any(abs(c[0] - V[0]) < 0.05 and abs(c[1] - V[1]) < 0.05 for c in coords):
        return False
    _, seg, _ = _nearest_on(coords, V)
    coords.insert(seg + 1, list(V))
    return True


def merge_roads():
    f = CACHE / 'roads.json'
    if not f.exists():
        print('没有高德道路缓存，跳过（先运行 roads）')
        return
    import numpy as np
    import shapely
    from shapely.ops import substring
    from shapely.strtree import STRtree
    from build_data import ROAD_LANE_W, ROAD_LANES_TWOWAY, ROAD_EXTRA_TWOWAY, ROAD_LANES_ONEWAY, ROAD_EXTRA_ONEWAY
    src = DATA / 'roads.json'
    bak = ROOT / 'data-src' / 'roads.before_amap.json'
    merge_base(src, bak, 'roads')
    R = json.loads(bak.read_text('utf-8'))
    cls = R['classes']
    ci = {c: i for i, c in enumerate(cls)}
    feats = R['features']
    ex = [np.array(ft['p'], float).reshape(-1, 2) for ft in feats]
    osm_ls = [shapely.LineString(p) for p in ex]
    veh = [i for i, ft in enumerate(feats) if cls[ft['c']] not in ROAD_NONVEH and len(ex[i]) >= 2]
    VG = np.array([osm_ls[i] for i in veh], dtype=object)
    tveh = STRtree(VG)
    # 补路名只看原本无名的路段（不含匝道、服务道路）
    nm = [i for i, ft in enumerate(feats) if cls[ft['c']] in ROAD_NAME_CLS and not ft.get('n') and len(ex[i]) >= 2]
    NG = np.array([osm_ls[i] for i in nm], dtype=object)
    tnm = STRtree(NG)

    # 1) 投影、按行车方向定向（折线顺序 = 行车方向）
    lines = []
    for r in json.loads(f.read_text('utf-8')):
        pts = []
        for s in str(r.get('pl') or '').split(';'):
            try:
                lon, lat = map(float, s.split(','))
            except ValueError:
                continue
            q = project(*gcj2wgs(lon, lat))
            if not pts or math.hypot(q[0] - pts[-1][0], q[1] - pts[-1][1]) > 0.05:
                pts.append(q)
        if len(pts) < 2:
            continue
        ls = shapely.LineString(pts)
        if ls.length < 20:
            continue
        h = travel_heading(r)
        if h:
            vx, vz = pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]
            if math.hypot(vx, vz) > 1 and vx * h[0] + vz * h[1] < 0:
                ls = shapely.LineString(pts[::-1])
        n, lv = r.get('n') or '', r.get('lv', 6)
        lines.append({'ls': ls, 'n': n, 'lv': lv, 'c': amap_road_class(n, lv)})
    # 等级高、有名、长的优先：配对/去重时由排在前面的那条负责输出
    lines.sort(key=lambda a: (a['lv'], 0 if a['n'] else 1, -a['ls'].length))
    G = np.array([a['ls'] for a in lines], dtype=object)
    if not len(G):
        print('高德道路缓存为空，跳过')
        return
    Ls = shapely.length(G)

    # 2) 所有线统一采样：点、切向
    cnt = np.maximum(2, np.ceil(Ls / ROAD_STEP).astype(int) + 1)
    off = np.concatenate([[0], np.cumsum(cnt)])
    lid = np.repeat(np.arange(len(G)), cnt)
    dist = np.concatenate([np.linspace(0, L, c) for L, c in zip(Ls, cnt)])
    GL = Ls[lid]

    def tangents(geoms, d, L):
        a = shapely.get_coordinates(shapely.line_interpolate_point(geoms, np.clip(d - 1, 0, L)))
        b = shapely.get_coordinates(shapely.line_interpolate_point(geoms, np.clip(d + 1, 0, L)))
        v = b - a
        return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)
    pts = shapely.line_interpolate_point(G[lid], dist)
    tan = tangents(G[lid], dist, GL)
    N = len(pts)

    # 3) 已被 OSM 车行道覆盖的采样点：10 m 内有与之大致平行（夹角 < 45°）的 OSM 车行道（含桥梁/隧道/高速——同一条路）。
    #    只看距离的话，高德线与任何道路相交处都会被切断：桥下、隧道上方、高速两侧各留一个断头
    cov = np.zeros(N, bool)
    cs = cf = np.zeros(0, np.int64)
    cc = np.zeros(0)
    if len(veh):
        si, fj = tveh.query(pts, predicate='dwithin', distance=ROAD_COVER)
        if len(si):
            og = VG[fj]
            c = np.abs(np.sum(tan[si] * tangents(og, shapely.line_locate_point(og, pts[si]), shapely.length(og)), axis=1))
            m = c > ROAD_PAR
            o = np.argsort(si[m], kind='stable')
            cs, cf, cc = si[m][o], fj[m][o], c[m][o]
            cov[cs] = True

    # 3b) 斜穿（夹角 20°~45°）其它道路时，“覆盖”只是交叉处的一小段：两侧都未覆盖、不长于 ROAD_GAP、
    #     且段内每条覆盖它的 OSM 路都与之斜交（不是重合）→ 回填为未覆盖，新路在交叉处连续不断开
    #     （普通地面道路在第 8 步做成平交路口；桥梁、隧道、高速是立体交叉，不连）
    first = np.zeros(N, bool)
    first[off[:-1]] = True
    last = np.zeros(N, bool)
    last[off[1:] - 1] = True
    prev = np.concatenate([[False], cov[:-1]])
    nxt = np.concatenate([cov[1:], [False]])
    gaps = 0
    for s0, e0 in zip(np.nonzero(cov & (first | ~prev))[0], np.nonzero(cov & (last | ~nxt))[0]):
        if first[s0] or last[e0] or dist[e0] - dist[s0] > ROAD_GAP:
            continue
        a0, a1 = np.searchsorted(cs, s0), np.searchsorted(cs, e0, 'right')
        fs, cv = cf[a0:a1], cc[a0:a1]
        if all(np.median(cv[fs == j]) < ROAD_CROSS_COS for j in np.unique(fs)):
            cov[s0:e0 + 1] = False
            gaps += 1

    # 4) 高德线之间：反向（双向路的另一方向）/ 同向（相邻格、不同 level 查询的重复）。
    #    只认几乎平行（夹角 < 20°）的：两条不同的新路斜交时，交叉处不能被当成重复删掉（否则后一条断成两截）
    opp = np.zeros(N, bool)
    skip = np.zeros(N, bool)
    si, lj = STRtree(G).query(pts, predicate='dwithin', distance=ROAD_PAIR)
    m = lj != lid[si]
    si, lj = si[m], lj[m]
    if len(si):
        dj = shapely.line_locate_point(G[lj], pts[si])
        dot = np.sum(tan[si] * tangents(G[lj], dj, Ls[lj]), axis=1)
        earlier = lj < lid[si]
        opp[si[dot < -ROAD_CROSS_COS]] = True
        skip[si[earlier & (np.abs(dot) > ROAD_CROSS_COS)]] = True

    # 5) 补路名：无名 OSM 路段沿线每 5 m 一格计票，每格只算离它最近的那条平行高德线（无名高德线投“无名”票；
    #    双向路的两条方向线落在同一格，不重复计）。某路名覆盖该路段长度 ≥ 50%（且 ≥ 30 m）才采用——
    #    只在路口处与有名干道并行几十米的无名路、在高德里本身也无名的路都不会被改名
    named = 0
    sel = np.nonzero(cov)[0]
    if len(sel) and len(nm):
        qi, fj = tnm.query(pts[sel], predicate='dwithin', distance=ROAD_COVER)
        if len(qi):
            s_idx = sel[qi]
            og = NG[fj]
            od = shapely.line_locate_point(og, pts[s_idx])
            al = np.abs(np.sum(tan[s_idx] * tangents(og, od, shapely.length(og)), axis=1)) > ROAD_NAME_COS
            s_idx, fj, od = s_idx[al], fj[al], od[al]
            dd = shapely.distance(og[al], pts[s_idx])
            key = fj.astype(np.int64) * (1 << 24) + (od // ROAD_STEP).astype(np.int64)
            o = np.lexsort((dd, key))
            key, s_idx, fj = key[o], s_idx[o], fj[o]
            win = np.ones(len(key), bool)
            win[1:] = key[1:] != key[:-1]
            votes = defaultdict(Counter)
            for j, li in zip(fj[win].tolist(), lid[s_idx[win]].tolist()):
                votes[j][lines[li]['n']] += 1
            NL = shapely.length(NG)
            for j, c in votes.items():
                cand = [(h, n) for n, h in c.items() if n]
                if not cand:
                    continue
                h, name = max(cand)
                if h * ROAD_STEP >= max(ROAD_NAME_SHARE * NL[j], ROAD_NAME_MIN) and NL[j] >= ROAD_NAME_MIN:
                    feats[nm[j]]['n'] = name
                    named += 1

    # 6) 未覆盖的连续采样 → 新路段：与反向线配对处为双向（o=0，整幅宽），其余为单向（o=1，折线 = 行车方向）
    state = np.where(cov | skip, 0, np.where(opp, 2, 1))
    new = []
    for i, a in enumerate(lines):
        st = state[off[i]:off[i + 1]]
        d = dist[off[i]:off[i + 1]]
        k = 0
        while k < len(st):
            if st[k] == 0:
                k += 1
                continue
            k1 = k
            while k1 + 1 < len(st) and st[k1 + 1] != 0:
                k1 += 1
            for d0, d1, s in _split_runs(d, st, k, k1, ROAD_MIN_RUN):
                if d1 - d0 < ROAD_MIN_RUN:
                    continue
                g = substring(a['ls'], d0, d1).simplify(1.0)
                q = np.round(np.array(g.coords), 1).tolist()
                q = [c for j, c in enumerate(q) if j == 0 or c != q[j - 1]]
                if len(q) >= 2:
                    new.append({'q': q, 'two': s == 2, 'n': a['n'], 'c': a['c']})
            k = k1 + 1

    # 7) 端点吸附：先吸到 OSM 地面车行道，再吸到其它新增路段；吸附点不是已有顶点就插入目标折线。
    #    只接能平交的道路：桥梁、隧道、高架不接；普通道路不接高速/快速路及其匝道（高速类新路也只接高速类）
    ground = [i for i in veh if not feats[i].get('b') and not feats[i].get('t') and not feats[i].get('y')]
    ghigh = {i: cls[feats[i]['c']] in ROAD_HIGH for i in ground}
    osm_q = {i: ex[i].tolist() for i in ground}
    touched = set()
    joined = set()
    snapped = 0
    cand = [osm_ls[i] for i in ground] + [shapely.LineString(nf['q']) for nf in new]
    tcand = STRtree(cand) if cand else None
    for phase in ('osm', 'new'):
        for kf, nf in enumerate(new):
            hi = nf['c'] in ROAD_HIGH
            for end in (0, -1):
                if (kf, end) in joined or tcand is None:
                    continue
                P = nf['q'][end]
                best = None
                for c in tcand.query(shapely.Point(P), predicate='dwithin', distance=ROAD_SNAP + 15):
                    if phase == 'osm':
                        if c >= len(ground) or ghigh[ground[c]] != hi:
                            continue
                        tgt, coords = ('osm', ground[c]), osm_q[ground[c]]
                    else:
                        k2 = c - len(ground)
                        if c < len(ground) or k2 == kf or (new[k2]['c'] in ROAD_HIGH) != hi:
                            continue
                        tgt, coords = ('new', k2), new[k2]['q']
                    dd = _nearest_on(coords, P)[0]
                    if dd <= ROAD_SNAP and (best is None or dd < best[0]):
                        best = (dd, tgt, coords)
                if best is None:
                    continue
                _, tgt, coords = best
                V, vi, ins = _vertex_on(coords, P)
                if ins and tgt[0] == 'osm':
                    touched.add(tgt[1])
                if not ins and tgt[0] == 'new' and vi in (0, len(coords) - 1):
                    joined.add((tgt[1], 0 if vi == 0 else -1))
                q = nf['q']
                q[end] = list(V)
                nb = 1 if end == 0 else -2   # 吸附后与相邻顶点重合/过近就去掉相邻顶点
                if len(q) > 2 and math.hypot(q[nb][0] - V[0], q[nb][1] - V[1]) < 1.0:
                    del q[nb]
                joined.add((kf, end))
                snapped += 1

    # 8) 平交路口：普通新增路段与普通地面道路、与其它普通新增路段相交处插入一个共用顶点（交点 3 m 内已有顶点则复用），
    #    roads_net / traffic_net 靠共用顶点生成路口。高速/快速路及匝道、桥梁、隧道、高架是立体交叉，不连
    def vkeys(q):
        return {(round(v[0], 1), round(v[1], 1)) for v in q}
    crossed = 0
    low_g = [i for i in ground if not ghigh[i]]
    low_n = [k for k, nf in enumerate(new) if nf['c'] not in ROAD_HIGH and len(nf['q']) >= 2]
    t_og = STRtree([osm_ls[i] for i in low_g]) if low_g else None
    t_nw = STRtree([shapely.LineString(new[k]['q']) for k in low_n]) if low_n else None
    for kf in low_n:
        P = new[kf]['q']
        if len(P) < 2:
            continue
        g = shapely.LineString(P)
        tg = [('osm', low_g[c]) for c in t_og.query(g, predicate='dwithin', distance=1.0)] if t_og is not None else []
        tg += [('new', low_n[c]) for c in t_nw.query(g, predicate='dwithin', distance=1.0) if low_n[c] > kf]
        for kind, j in tg:
            Q = osm_q[j] if kind == 'osm' else new[j]['q']
            if len(Q) < 2:
                continue
            X = shapely.intersection(shapely.LineString(P), shapely.LineString(Q))
            xs = [(pt.x, pt.y) for pt in shapely.get_parts(X) if pt.geom_type == 'Point']
            if not xs:
                continue
            shared = vkeys(P) & vkeys(Q)
            for x in xs:
                # 已经共用顶点的（端点吸附过来的）、贴着本段端点的（端点由第 7 步处理）不再重复加
                if any(math.hypot(x[0] - v[0], x[1] - v[1]) < ROAD_JOIN_REUSE for v in shared):
                    continue
                if min(math.hypot(x[0] - P[e][0], x[1] - P[e][1]) for e in (0, -1)) < ROAD_JOIN_REUSE:
                    continue
                V, _, ins = _vertex_on(Q, x)
                _ensure_vertex(P, V)
                if ins and kind == 'osm':
                    touched.add(j)
                shared.add((round(V[0], 1), round(V[1], 1)))
                crossed += 1
    for i in touched:
        feats[i]['p'] = [v for c in osm_q[i] for v in c]

    added = two = 0
    km = 0.0
    for nf in new:
        q = [c for j, c in enumerate(nf['q']) if j == 0 or c != nf['q'][j - 1]]
        if len(q) < 2:
            continue
        c = nf['c']
        if nf['two']:
            lanes = ROAD_LANES_TWOWAY.get(c, 2)
            w = lanes * ROAD_LANE_W.get(c, 3.0) + ROAD_EXTRA_TWOWAY.get(c, 0.5)
        else:
            lanes = ROAD_LANES_ONEWAY.get(c, 1)
            w = lanes * ROAD_LANE_W.get(c, 3.0) + ROAD_EXTRA_ONEWAY.get(c, 0.5)
        feats.append({'c': ci[c], 'n': nf['n'], 'w': round(max(3.0, w), 1), 'l': lanes, 'o': 0 if nf['two'] else 1,
                      'b': 0, 't': 0, 'y': 0, 'p': [v for xy in q for v in xy]})
        added += 1
        two += nf['two']
        km += shapely.LineString(q).length / 1000
    with open(src, 'w', encoding='utf-8') as fp:
        json.dump(R, fp, ensure_ascii=False, separators=(',', ':'))
    merge_done('roads', src)
    print(f'roads.json：新增高德路段 {added} 段 {km:.1f} km（双向 {two}、单向 {added - two}），端点吸附 {snapped} 处、'
          f'平交路口 {crossed} 处（向 {len(touched)} 条已有道路插入节点），斜穿处不断开 {gaps} 处，为原无名路段补路名 {named} 段')


# ───────────────────────── 深度接入：地铁 / 行政区划 / 商圈 / 地标定位 ─────────────────────────
METRO_LINES = [f'{n}号线' for n in range(1, 21)] + ['机场线', '西户线']
CITY = '029'   # 西安 citycode


def _parse_polyline(s):
    """高德 polyline 'lon,lat;lon,lat;…'（GCJ）→ [(wgs_lon, wgs_lat)]"""
    out = []
    for pt in (s or '').split(';'):
        if ',' in pt:
            lon, lat = map(float, pt.split(','))
            out.append(gcj2wgs(lon, lat))
    return out


def cmd_metro(cli):
    """公交路线关键字查询（v3/bus/linename，extensions=all）逐条查西安地铁 1~20 号线：线路折线 + 全部车站。
    只保留 type 含“地铁/轻轨”、名称含查询线号的结果；每条线取两个方向里站点最多的一条。"""
    out = {}
    for ln in METRO_LINES:
        kw = ln if ln.endswith('西户线') else f'西安地铁{ln}'
        try:
            j = cli.get('/v3/bus/linename', {'keywords': kw, 'city': CITY, 'extensions': 'all', 'offset': 10, 'page': 1})
        except AmapCellError as ex:
            print(f'  ！{kw} 查询失败：{ex}')
            continue
        best = None
        for b in j.get('buslines') or []:
            if not re.search('地铁|轻轨|城际|市域', str(b.get('type', ''))) or not re.search(rf'(?<!\d){re.escape(ln)}', str(b.get('name', ''))):
                continue
            if best is None or len(b.get('busstops') or []) > len(best.get('busstops') or []):
                best = b
        if not best:
            print(f'  {kw}：无结果（未开通或名称不同）')
            continue
        out[ln] = {
            'name': re.sub(r'\(.*?\)|（.*?）', '', best['name']).strip(),
            'full': best['name'], 'id': best.get('id'), 'type': best.get('type'),
            'start': best.get('start_stop'), 'end': best.get('end_stop'),
            'length_km': float(best.get('distance') or 0),
            'polyline': best.get('polyline'),
            'stops': [{'name': s['name'], 'location': s['location'], 'seq': int(s.get('sequence') or 0)}
                      for s in best.get('busstops') or []],
        }
        print(f'  {out[ln]["name"]}：{len(out[ln]["stops"])} 站，{out[ln]["length_km"]:.1f} km')
    f = CACHE / 'metro.json'
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(out, ensure_ascii=False), 'utf-8')
    print(f'已保存 {len(out)} 条地铁线路 → {f}')


def cmd_district(cli):
    """行政区划查询（v3/config/district）：西安市下辖区县边界（extensions=all 带 polyline）+ 街道/镇名与中心点"""
    top = cli.get('/v3/config/district', {'keywords': '西安市', 'subdistrict': 2, 'extensions': 'base'})
    city = next((d for d in top.get('districts') or [] if d.get('adcode') == '610100'), None)
    if not city:
        raise SystemExit('未找到西安市（adcode 610100）')
    out = []
    for d in city.get('districts') or []:
        try:
            j = cli.get('/v3/config/district', {'keywords': d['adcode'], 'subdistrict': 0, 'extensions': 'all', 'filter': d['adcode']})
        except AmapCellError as ex:
            print(f'  ！{d["name"]} 边界查询失败：{ex}')
            continue
        dd = (j.get('districts') or [{}])[0]
        out.append({'name': d['name'], 'adcode': d['adcode'], 'center': d.get('center'), 'polyline': dd.get('polyline', ''),
                    'streets': [{'name': s['name'], 'center': s.get('center'), 'level': s.get('level')}
                                for s in d.get('districts') or []]})
        print(f'  {d["name"]}：{len(out[-1]["streets"])} 个街道/镇，边界 {len(dd.get("polyline", "")) // 22} 点')
    f = CACHE / 'district.json'
    f.write_text(json.dumps(out, ensure_ascii=False), 'utf-8')
    print(f'已保存 {len(out)} 个区县 → {f}')


def place_names():
    """地标调研清单 research/refs/landmarks2026/*.json 里的全部名称（含别名）"""
    names = []
    for fp in sorted((ROOT / 'research' / 'refs' / 'landmarks2026').glob('*.json')):
        try:
            arr = json.loads(fp.read_text('utf-8'))
        except Exception:
            continue
        for it in arr if isinstance(arr, list) else arr.get('items', []):
            for n in [it.get('name')] + list(it.get('aliases') or []):
                if n and n not in names:
                    names.append(n)
    return names


def cmd_place(cli, names):
    """关键字搜索（v5/place/text，限西安）逐个定位地标：取第一条结果的坐标、类别、所在区、商圈与父 POI"""
    f = CACHE / 'places.json'
    old = json.loads(f.read_text('utf-8')) if f.exists() else {}
    for i, n in enumerate(names):
        if n in old:
            continue
        try:
            j = cli.get('/v5/place/text', {'keywords': n, 'region': '610100', 'city_limit': 'true', 'page_size': 5,
                                           'show_fields': 'business,navi'})
        except AmapCellError as ex:
            print(f'  ！{n}：{ex}')
            continue
        ps = j.get('pois') or []
        key = strip_paren(n)
        p = next((q for q in ps if strip_paren(q.get('name', '')) == key), None) or (ps[0] if ps else None)
        old[n] = None if not p else {
            'name': p.get('name'), 'id': p.get('id'), 'location': p.get('location'), 'type': p.get('type'),
            'typecode': p.get('typecode'), 'adname': p.get('adname'), 'address': p.get('address'),
            'business_area': (p.get('business') or {}).get('business_area'), 'parent': p.get('parent'),
            'exact': strip_paren(p.get('name', '')) == key,
        }
        if (i + 1) % 20 == 0:
            f.write_text(json.dumps(old, ensure_ascii=False), 'utf-8')
            print(f'  {i + 1}/{len(names)}', flush=True)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(old, ensure_ascii=False), 'utf-8')
    hit = sum(1 for v in old.values() if v)
    print(f'已定位 {hit}/{len(old)} 个地标 → {f}')


def _xz(loc):
    lon, lat = map(float, loc.split(','))
    x, z = project(*gcj2wgs(lon, lat))
    return round(x, 1), round(z, 1)


def business_areas():
    """高德 POI（v5 show_fields=business）的 business_area 字段 → 商圈：成员 POI 位置的中位数为中心，
    外接圆半径取 80% 分位距离；成员少于 8 个的忽略（多为误标）"""
    f = CACHE / 'pois.json'
    if not f.exists():
        return []
    groups = defaultdict(list)
    for p in json.loads(f.read_text('utf-8')).values():
        ba = ((p.get('business') or {}).get('business_area') or '').strip()
        if ba and p.get('location'):
            groups[ba].append(_xz(p['location']))
    out = []
    for name, pts in groups.items():
        if len(pts) < 8:
            continue
        xs = sorted(x for x, _ in pts)
        zs = sorted(z for _, z in pts)
        cx, cz = xs[len(xs) // 2], zs[len(zs) // 2]
        ds = sorted(math.hypot(x - cx, z - cz) for x, z in pts)
        out.append({'n': name, 'x': cx, 'z': cz, 'r': round(min(2500, max(150, ds[int(len(ds) * 0.8)])), 0), 'c': len(pts)})
    out.sort(key=lambda b: -b['c'])
    return out


def merge_extra():
    """地铁 / 区划 / 商圈 / 地标定位 → public/data/amap_extra.json（世界坐标）；
    OSM 缺失的地铁线（按线号）以地下段（y=-1）追加进 rail.json，供站名/线路标识使用"""
    ex = {'source': '高德开放平台 Web 服务 API（GCJ-02 已逆变换为 WGS-84）'}
    mf = CACHE / 'metro.json'
    if mf.exists():
        lines = []
        for ln, L in json.loads(mf.read_text('utf-8')).items():
            m = re.match(r'(\d+)号线', ln)
            pts = [project(lon, lat) for lon, lat in _parse_polyline(L['polyline'])]
            lines.append({'n': L['name'], 'num': int(m.group(1)) if m else 0,
                          'p': [round(v, 1) for xy in pts for v in xy],
                          's': [{'n': re.sub(r'(地铁站|站)$', '', s['name']), 'x': _xz(s['location'])[0], 'z': _xz(s['location'])[1]}
                                for s in sorted(L['stops'], key=lambda s: s['seq'])]})
        ex['metro'] = lines
        rsrc = DATA / 'rail.json'
        rbak = ROOT / 'data-src' / 'rail.before_amap.json'
        if rsrc.exists():
            merge_base(rsrc, rbak, 'rail')
            R = json.loads(rbak.read_text('utf-8'))
            sub = R['classes'].index('subway')
            have = set()
            for ft in R['features']:
                m = re.search(r'地铁(\d+)号线', ft.get('n') or '')
                if ft['c'] == sub and m:
                    have.add(int(m.group(1)))
            add = [L for L in lines if L['num'] and L['num'] not in have and len(L['p']) >= 4]
            for L in add:
                R['features'].append({'c': sub, 'n': f'西安地铁{L["num"]}号线', 'w': 3.0, 'l': 1, 'o': 0, 'b': 0, 't': 0,
                                      'y': -1, 'p': L['p'], 'src': 'amap'})
            with open(rsrc, 'w', encoding='utf-8') as fp:
                json.dump(R, fp, ensure_ascii=False, separators=(',', ':'))
            merge_done('rail', rsrc)
            print(f'rail.json：补 OSM 缺失的地铁线 {len(add)} 条（{", ".join(L["n"] for L in add) or "无"}）')
        print(f'地铁：{len(lines)} 条线，{sum(len(L["s"]) for L in lines)} 站次')
    df = CACHE / 'district.json'
    if df.exists():
        ds = []
        for d in json.loads(df.read_text('utf-8')):
            rings = []
            for ring in (d.get('polyline') or '').split('|'):
                pts = [project(lon, lat) for lon, lat in _parse_polyline(ring)]
                # 抽稀：相邻点 < 25 m 的去掉（原始边界点极密）
                keep = []
                for x, z in pts:
                    if not keep or math.hypot(x - keep[-1][0], z - keep[-1][1]) > 25:
                        keep.append((x, z))
                if len(keep) >= 3:
                    rings.append([round(v, 1) for xy in keep for v in xy])
            c = _xz(d['center']) if d.get('center') else None
            ds.append({'n': d['name'], 'code': d['adcode'], 'c': c, 'rings': rings,
                       'st': [{'n': s['name'], 'c': _xz(s['center'])} for s in d.get('streets') or [] if s.get('center')]})
        ex['districts'] = ds
        print(f'行政区：{len(ds)} 个区县，{sum(len(d["st"]) for d in ds)} 个街道/镇')
    ba = business_areas()
    if ba:
        ex['business'] = ba
        print(f'商圈：{len(ba)} 个（按 POI 的 business_area 聚合）')
    pf = CACHE / 'places.json'
    if pf.exists():
        pl = {}
        for n, p in json.loads(pf.read_text('utf-8')).items():
            if p and p.get('location'):
                x, z = _xz(p['location'])
                pl[n] = {'x': x, 'z': z, 'a': p.get('adname'), 'b': p.get('business_area'), 't': p.get('typecode'), 'e': p.get('exact')}
        ex['places'] = pl
        print(f'地标定位：{len(pl)} 个')
    if len(ex) > 1:
        with open(DATA / 'amap_extra.json', 'w', encoding='utf-8') as fp:
            json.dump(ex, fp, ensure_ascii=False, separators=(',', ':'))
        print(f'已写出 {DATA / "amap_extra.json"}')
    else:
        print('没有地铁/区划/商圈/地标缓存，跳过 amap_extra.json（先运行 metro / district / poi / place）')


def load_dotenv():
    """仓库根目录 .env（已在 .gitignore，不入库）里的 KEY=VALUE 写进环境变量（已设置的不覆盖）。用于 AMAP_KEY。"""
    p = Path(__file__).resolve().parent.parent / '.env'
    if not p.exists():
        return
    for line in p.read_text('utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main():
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['poi', 'roads', 'metro', 'district', 'place', 'all', 'status', 'merge'])
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
        mf = CACHE / 'meta.json'
        done = len(json.loads(mf.read_text('utf-8')).get('done') or []) if mf.exists() else 0
        print(f'已缓存请求 {n} 个；POI {len(json.loads(p.read_text("utf-8"))) if p.exists() else 0} 条；'
              f'已完成初始网格 {done} 个；道路缓存 {"有" if (CACHE / "roads.json").exists() else "无"}')
        return
    if a.cmd == 'merge':
        merge_pois(a.core_cap)
        merge_roads()
        merge_extra()
        return
    if not a.key:
        sys.exit('需要高德 Web 服务 Key：--key 或环境变量 AMAP_KEY（控制台 https://console.amap.com/dev/key/app ，服务平台选“Web服务”）')
    cli = Client(a.key, a.qps, a.max_requests)
    if a.cmd in ('metro', 'all'):
        cmd_metro(cli)
    if a.cmd in ('district', 'all'):
        cmd_district(cli)
    if a.cmd in ('place', 'all'):
        cmd_place(cli, place_names())
    if a.cmd in ('poi', 'all'):
        cmd_poi(cli, bbox, a.cell)
    if a.cmd in ('roads', 'all'):
        cmd_roads(cli, bbox)


if __name__ == '__main__':
    main()
