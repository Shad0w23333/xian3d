#!/usr/bin/env python3
"""离线高清卫星影像金字塔：多源瓦片下载（断点续传）→ GCJ 纠偏 → 打包成少量 .xtp 大文件（前端 HTTP Range 读取）。

仅供个人本地使用：各图源均有服务条款，不要公开发布打包结果（tiles/ 已加入 .gitignore）。

子命令：
  python tools/imagery_pack.py plan   [--plan default]                 # 估算各片区瓦片数与体积
  python tools/imagery_pack.py compare --lon 108.9423 --lat 34.2610 --z 19   # 各源同一位置对比图 → research/imagery_compare/
  python tools/imagery_pack.py bench --source google,esri_clarity,tianditu,amap --tk XXX   # 各片区抽样打分（清晰度/积雪/缺图率）
  python tools/imagery_pack.py all --source google,esri_clarity,tianditu --pick sharp --plan ultra  # 逐块择优 + 核心区 z20
  python tools/imagery_pack.py download --source google[,esri] [--plan default] [--workers 16]
  python tools/imagery_pack.py pack --source google[,esri] [--plan default]  # → tiles/*.xtp + index.json
  python tools/imagery_pack.py all --source google,esri                # download + pack

源（--source 可逗号分隔：前者缺图时用后者补；加 --pick sharp 则按 8×8 瓦片块自动挑最清晰的源）：
  google        Google 卫星（WGS-84，西安城区 z19~z20，通常最清晰）
  esri          Esri World Imagery（WGS-84，z19；部分区域年份较旧/有积雪）
  esri_clarity  Esri Clarity（同源未经锐化压缩的版本，常比 esri 清楚）
  wayback       Esri Wayback 指定期（--wayback 期号；默认 latest：第一次查到的最新一期会固定在缓存里一直沿用，
                续传/单独 pack 不会换期换目录；--wayback refresh 改用当前最新一期；可挑无雪的新一期）
  bing          Bing 航拍（WGS-84，z19）
  tianditu      天地图卫星（国家地理信息公共服务平台，免费，需“服务器端”Key：--tk 或环境变量 TIANDITU_TK；CGCS2000≈WGS-84，
                只到 z18，更高层级按缺图处理、不请求）
  amap          高德卫星（GCJ-02，下载后逐瓦片纠偏回 WGS-84；z18 以上仅部分区域）
  tencent       腾讯卫星（GCJ-02，自动纠偏）
  jl1           吉林一号“共生地球”年度影像（0.5~0.75 m，免费注册；--jl1-mk 影像图层 mk、--jl1-tk 令牌，
                URL 模板以其控制台为准，可用 --url 覆盖）
  custom        任意 XYZ 模板：--url 'https://host/{z}/{x}/{y}.jpg'（占位符 {z} {x} {y} {-y}(TMS) {q}(quadkey) {s}），GCJ 源加 --gcj；
                模板含 {s} 时须用 --subs 指定子域取值（如 abc / 1234）
缓存：data-src/tiles_hd/<源>/<z>/<x>/<y>.jpg；缺图记为 .miss（--retry-miss 清除所选源的 .miss 后重试）。
  出错不等于缺图：网络错误/超时/5xx 只让该瓦片这次失败（重跑续传）；Key 无效/超配额/被封禁时连续多张失败即本次停用该源；
  某源只是不提供某层级（如 z19 起回 400）时只在本次运行跳过该层级，其他候选源照常补上。
  目录名随参数变化，避免新旧参数混用：wayback_<期号>、custom_<URL 哈希>、jl1_<哈希>；GCJ 源纠偏后的瓦片在 <源>_wgs/，
  纠偏前原图在 <源>_raw/（如 amap_raw/）；--pick sharp 的结果在 best_<候选源哈希>/（内含 _meta.json 记录候选源与实际采用源）。
"""
import argparse
import contextlib
import hashlib
import io
import json
import math
import os
import random
import re
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data-src' / 'tiles_hd'
OUT = ROOT / 'tiles'   # 不放 public/（否则 vite build 会复制进 dist）；开发/预览/启动脚本服务器挂到 /tiles/

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/126.0 Safari/537.36')

# Esri 系（esri / esri_clarity / wayback）URL 带 blankTile=false：无数据时回 404（记 .miss），而不是 200 +“Map data not yet available”灰底文字图。
# 不再按像素猜占位图：积雪/云/水泥坪等真实影像同样“低饱和、灰度集中”，误判会把好瓦片永久记成缺图。
# maxz：该源已知的最大层级，更高层级直接按缺图处理、不发请求（天地图影像只到 z18，超出时回 400/异常报告，不是 404）
SOURCES = {
    'google': {'url': 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', 'subs': '0123', 'gcj': False,
               'referer': 'https://www.google.com/maps', 'attr': 'Google 卫星'},
    'esri': {'url': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false',
             'subs': None, 'gcj': False, 'attr': 'Esri World Imagery'},
    'bing': {'url': 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=14500', 'subs': '0123', 'gcj': False,
             'attr': 'Microsoft Bing'},
    'amap': {'url': 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', 'subs': '1234',
             'gcj': True, 'attr': '高德卫星（已纠偏）'},
    'esri_clarity': {'url': 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false',
                     'subs': None, 'gcj': False, 'attr': 'Esri World Imagery (Clarity)'},
    'wayback': {'url': 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{wb}/{z}/{y}/{x}?blankTile=false',
                'subs': None, 'gcj': False, 'attr': 'Esri World Imagery Wayback'},
    'tianditu': {'url': 'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default'
                        '&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}',
                 'subs': '01234567', 'gcj': False, 'maxz': 18, 'attr': '天地图（国家地理信息公共服务平台）'},
    'tencent': {'url': 'https://p{s}.map.gtimg.com/sateTiles/{z}/{x16}/{ty16}/{x}_{ty}.jpg', 'subs': '0123', 'gcj': True,
                'attr': '腾讯地图卫星（已纠偏）'},
    'jl1': {'url': 'https://api.jl1mall.com/getMap/{z}/{x}/{-y}?mk={mk}&tk={tk1}', 'subs': None, 'gcj': False,
            'attr': '吉林一号（长光卫星 共生地球）'},
    'custom': {'url': '', 'subs': None, 'gcj': False, 'attr': '自定义影像源'},
    'best': {'url': '', 'subs': None, 'gcj': False, 'attr': '多源择优'},
}
CFG = {'tk': os.environ.get('TIANDITU_TK', ''), 'wb': '', 'mk': os.environ.get('JL1_MK', ''), 'tk1': os.environ.get('JL1_TK', ''),
       'best': ''}

# 片区计划：(名称, (西, 南, 东, 北), 最小层级, 最大层级)
PLANS = {
    'default': [
        ('全域', (108.60, 33.95, 109.40, 34.72), 11, 15),
        ('城区', (108.80, 34.15, 109.12, 34.42), 16, 17),
        ('城墙内', (108.918, 34.244, 108.968, 34.282), 18, 19),
        ('大雁塔·曲江', (108.945, 34.183, 109.002, 34.232), 18, 19),
        ('小寨·电视塔', (108.925, 34.195, 108.965, 34.230), 18, 19),
        ('高新CBD', (108.855, 34.180, 108.905, 34.225), 18, 19),
        ('未央商圈', (108.920, 34.318, 108.972, 34.352), 18, 19),
        ('浐灞', (108.992, 34.318, 109.045, 34.372), 18, 19),
        ('奥体·北站', (108.925, 34.365, 109.035, 34.395), 18, 18),
        ('咸阳机场', (108.725, 34.415, 108.785, 34.460), 18, 18),
    ],
    # 轻量：全域 z11-14 + 城区 z15-17 + 城墙内/曲江 z18（约 1/5 体积）
    'lite': [
        ('全域', (108.60, 33.95, 109.40, 34.72), 11, 14),
        ('城区', (108.80, 34.15, 109.12, 34.42), 15, 17),
        ('城墙内', (108.918, 34.244, 108.968, 34.282), 18, 18),
        ('大雁塔·曲江', (108.945, 34.183, 109.002, 34.232), 18, 18),
    ],
}
# ultra：default 基础上，核心片区加 z20（Google 在西安城区有 z20，约 0.12 m/px；体积约再增加 2~3 GB）
PLANS['ultra'] = PLANS['default'] + [
    ('城墙内 z20', (108.918, 34.244, 108.968, 34.282), 20, 20),
    ('大雁塔·不夜城 z20', (108.952, 34.195, 108.975, 34.225), 20, 20),
    ('未央路口 z20', (108.935, 34.332, 108.955, 34.348), 20, 20),
    ('浐灞半岛 z20', (109.004, 34.326, 109.025, 34.345), 20, 20),
    ('曲江池·W z20', (108.975, 34.192, 108.992, 34.212), 20, 20),
]
# 打包分组（层级段 → 文件）
BANDS = [(11, 15), (16, 17), (18, 18), (19, 20)]


# ───────────────────────── 瓦片数学 ─────────────────────────
def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    lr = math.radians(lat)
    y = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n
    return x, y


def tile_nw(z, x, y):
    n = 2 ** z
    lon = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def tiles_in(bbox, z):
    w, s, e, n = bbox
    x0, y0 = lonlat_to_tile(w, n, z)
    x1, y1 = lonlat_to_tile(e, s, z)
    for x in range(int(x0), int(x1) + 1):
        for y in range(int(y0), int(y1) + 1):
            yield x, y


def plan_tiles(plan):
    seen = set()
    for _, bbox, z0, z1 in PLANS[plan]:
        for z in range(z0, z1 + 1):
            for x, y in tiles_in(bbox, z):
                seen.add((z, x, y))
    return sorted(seen)


def quadkey(z, x, y):
    q = ''
    for i in range(z, 0, -1):
        d = 0
        m = 1 << (i - 1)
        if x & m:
            d += 1
        if y & m:
            d += 2
        q += str(d)
    return q


# ───────────────────────── GCJ-02（与 src/core/gcj.js 相同） ─────────────────────────
_A = 6378245.0
_EE = 0.00669342162296594323


def _tlat(x, y):
    r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    r += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    r += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return r


def _tlon(x, y):
    r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    r += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    r += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return r


def wgs2gcj(lon, lat):
    dlat = _tlat(lon - 105.0, lat - 35.0)
    dlon = _tlon(lon - 105.0, lat - 35.0)
    rl = lat / 180.0 * math.pi
    magic = 1 - _EE * math.sin(rl) ** 2
    sm = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sm) * math.pi)
    dlon = (dlon * 180.0) / (_A / sm * math.cos(rl) * math.pi)
    return lon + dlon, lat + dlat


# ───────────────────────── 下载 ─────────────────────────
_local = threading.local()


def session():
    if not hasattr(_local, 's'):
        import requests
        s = requests.Session()
        s.headers['User-Agent'] = UA
        _local.s = s
    return _local.s


class FetchError(RuntimeError):
    """一张瓦片（已含逐张重试）最终失败。kind 决定是否计入熔断：
      net   网络错误/超时/5xx/408/数据不完整：多半是暂时的，不计入（断网几十秒不能把整个源停掉，重跑续传即可）
      deny  401/403/407/418/429（重试后仍是）：Key 无效/超配额/被封禁/持续限流，同一源连续 DEAD_AFTER 张即本次停用
      bad   其他 4xx、返回的不是图片：可能是 Key/配额问题，也可能只是该源不提供这一层级，按层级计数，
            触发时先试探该源取到过图的层级来区分（见 _fail）"""

    def __init__(self, msg, kind='net'):
        super().__init__(msg)
        self.kind = kind


class SourceError(FetchError):
    """图源级错误：返回的不是图片（Key 无效/超配额/被拦截的错误页）、URL 模板有误、或该源已被本次运行停用。
    不退避重试、不记 .miss（否则重跑也不会再取）。"""

    def __init__(self, msg, kind='bad'):
        super().__init__(msg, kind)


class Interrupted(RuntimeError):
    """Ctrl-C 后让工作线程尽快退出"""


_stop = threading.Event()
DEAD_AFTER = 12   # 连续这么多张瓦片明确被拒（deny 按源、bad 按层级计）→ 停用该源 / 跳过该层级，不再逐张请求、空等退避
_health = {}      # 源 -> {'n': {层级或 '*': 连续失败张数}, 'dead': 停用原因, 'off': {层级: 跳过原因}, 'probing': 正在试探的层级}
_health_lock = threading.Lock()


def _sleep(sec):
    if _stop.wait(sec):
        raise Interrupted('已中断')


def _h(src):
    """（持 _health_lock 调用）"""
    return _health.setdefault(src, {'n': {}, 'dead': None, 'off': {}, 'probing': set()})


def _ok(src, z):
    """该源在 z 层级正常应答（取到图或服务器明确缺图）：清零连续失败计数"""
    with _health_lock:
        n = _h(src)['n']
        if n:
            n.pop(z, None)
            n.pop('*', None)


def _image_levels(src):
    """该源取到过图的层级（看磁盘缓存：本次下载的也都已落盘）。只在熔断判断时调用。"""
    d = cache_dir(src)
    if not d.is_dir():
        return set()
    return {int(p.name) for p in d.iterdir() if p.name.isdigit() and next(p.glob('*/*.jpg'), None)}


def _fail(src, t, e):
    """记录一张瓦片的最终失败。连续失败达到 DEAD_AFTER 时判定：
    deny → 停用整个源；bad → 若该源在别的层级取到过图，就试探离得最近的那一层对应瓦片：
      正常且本层级从没取到过图 → 该源不提供此层级，本次运行跳过（按缺图处理、不记 .miss，下次运行重新判断），其他候选源照常补；
      试探也被拒 → 停用整个源（Key/配额/封禁）；试探是网络错误，或本层级取到过图 → 暂不下结论，计数清零。"""
    kind = getattr(e, 'kind', 'net')
    if kind == 'net':
        return
    z = t[0]
    key = '*' if kind == 'deny' else z
    with _health_lock:
        h = _h(src)
        if h['dead'] or z in h['off'] or z in h['probing']:
            return
        h['n'][key] = h['n'].get(key, 0) + 1
        if h['n'][key] < DEAD_AFTER:
            return
        why = f'{src}：{"" if kind == "deny" else f"z{z} "}连续 {h["n"][key]} 张瓦片失败（最近：{e}）'
        if kind == 'deny':
            h['dead'] = why + '，本次运行停用该源'
            print('  【停用】', h['dead'], flush=True)
            return
        h['probing'].add(z)
        off = set(h['off'])
    verdict, note = None, ''   # 试探途中被中断等：不下结论
    try:
        levels = _image_levels(src)
        others = sorted(levels - off - {z}, key=lambda g: (abs(g - z), -g))
        if not others:
            verdict, note = 'dead', '，该源在其他层级也没取到过图'
        else:
            g = others[0]
            d = z - g
            p = (g, t[1] >> d, t[2] >> d) if d > 0 else (g, t[1] << -d, t[2] << -d)
            try:
                _download(src, *p, 2)
                verdict = 'keep' if z in levels else 'off'
                note = f'；而 z{g} 应答正常'
            except FetchError as pe:
                verdict = 'keep' if pe.kind == 'net' else 'dead'
                note = f'；试探 z{g} 也失败：{pe}'
    finally:
        with _health_lock:
            h['probing'].discard(z)
            h['n'].pop(z, None)
            if verdict == 'dead' and not h['dead']:
                h['dead'] = why + note + '，本次运行停用该源'
                print('  【停用】', h['dead'], flush=True)
            elif verdict == 'off':
                h['off'][z] = why + note + f' → 视为该源不提供 z{z}：本次运行按缺图处理（不记 .miss，下次运行重新判断）'
                print('  【跳过层级】', h['off'][z], flush=True)


def dead_reason(src):
    """该源（或其 GCJ 原图源）已被停用时返回原因，否则 None"""
    with _health_lock:
        for k in (src, src + '_raw'):
            if k in _health and _health[k]['dead']:
                return _health[k]['dead']
    return None


def level_off(src, z):
    """该源（或其 GCJ 原图源）在本次运行中被判定不提供 z 层级、或超出其最大层级时为真：按缺图处理"""
    if z > SOURCES[src].get('maxz', 99):
        return True
    with _health_lock:
        return any(k in _health and z in _health[k]['off'] for k in (src, src + '_raw'))


def _levels_off():
    with _health_lock:
        return sum(len(h['off']) for h in _health.values())


def _report_dead():
    with _health_lock:
        dead = [h['dead'] for h in _health.values() if h['dead']]
        off = [w for h in _health.values() for w in h['off'].values()]
    for why in off:
        print('  本次跳过：', why)
    for why in dead:
        print('  已停用：', why)
    if dead:
        print('  （修正 Key / 等配额恢复或解封后重新运行即可续传；也可从 --source 去掉该源）')


_inflight = {}   # 缓存路径 -> [锁, 引用数]
_inflight_lock = threading.Lock()


@contextlib.contextmanager
def _path_lock(key):
    """同一缓存路径同一时刻只允许一个线程下载（相邻 GCJ 瓦片共用原图，避免重复请求与临时文件互相覆盖）"""
    with _inflight_lock:
        ent = _inflight.get(key)
        if ent is None:
            ent = _inflight[key] = [threading.Lock(), 0]
        ent[1] += 1
    try:
        with ent[0]:
            yield
    finally:
        with _inflight_lock:
            ent[1] -= 1
            if not ent[1]:
                _inflight.pop(key, None)


def _atomic_write(path, data):
    """先写同目录唯一临时文件再 os.replace：被杀/磁盘满时不会在最终路径留下截断的 .jpg（缓存只凭 exists() 判断）"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'{path.name}.{os.getpid()}.{threading.get_ident()}.part')
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _looks_image(b):
    """按魔数判断是否图片（JPEG / PNG / GIF / WebP）"""
    return (b[:3] == b'\xff\xd8\xff' or b[:8] == b'\x89PNG\r\n\x1a\n' or b[:6] in (b'GIF87a', b'GIF89a')
            or (b[:4] == b'RIFF' and b[8:12] == b'WEBP'))


def _image_ok(b):
    """是图片且未截断：JPEG 尾部有 EOI、PNG 有 IEND 即通过；否则用 PIL 完整解码确认"""
    if not b or not _looks_image(b):
        return False
    if (b[:3] == b'\xff\xd8\xff' and b'\xff\xd9' in b[-64:]) or (b[:4] == b'\x89PNG' and b'IEND' in b[-16:]):
        return True
    try:
        from PIL import Image
        Image.open(io.BytesIO(b)).load()
        return True
    except ImportError:
        return True  # 没装 Pillow 时只做魔数检查
    except Exception:
        return False


def _snippet(b, n=160):
    """错误响应正文摘要（图片不打印）"""
    if not b or _looks_image(b):
        return ''
    return ' ' + b[:n].decode('utf-8', 'replace').replace('\n', ' ').strip()


def _hash(s):
    return hashlib.sha1(s.encode('utf-8')).hexdigest()[:8]


def cache_dir(src):
    """源的缓存目录。影响瓦片内容的参数（wayback 期号、custom/jl1 模板与图层、GCJ 纠偏算法、择优候选源）
    都体现在目录名里，换参数不会复用旧瓦片/旧 .miss，也不会把两种结果混在一个目录。"""
    raw = src.endswith('_raw')
    base = src[:-4] if raw else src
    S = SOURCES[base]
    if base == 'wayback':
        name = 'wayback_' + (re.sub(r'[^0-9A-Za-z_-]', '_', CFG['wb']) or 'unset')
    elif base in ('custom', 'jl1'):
        # 令牌类参数不计入（令牌轮换不影响影像）；jl1 的图层 mk 计入
        url = re.sub(r'(?i)([?&](?:tk|token|key|apikey|api_key|access_token)=)[^&]*', r'\1', S['url'])
        name = f'{base}_' + _hash(f"{url}|{S['gcj']}|{CFG['mk'] if base == 'jl1' else ''}")
    elif base == 'best':
        if not CFG['best']:
            raise RuntimeError('best 源缓存未确定：须先按候选源设置 CFG["best"]（见 best_key）')
        name = 'best_' + CFG['best']
    else:
        name = base
    if raw:
        name += '_raw'
    elif S['gcj']:
        name += '_wgs'   # 纠偏后的瓦片（整像素平移版；旧版双线性结果在 <源>/ 下，不再使用）
    return CACHE / name


def best_key(sources, block=3):
    """--pick sharp 结果目录的键：候选源（含其参数化缓存目录名）与分块大小"""
    return _hash(','.join(cache_dir(s).name for s in sources) + f'|b{block}')


def _best_meta():
    try:
        return json.loads((cache_dir('best') / '_meta.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def src_url(src, z, x, y):
    S = SOURCES[src]
    u = S['url']
    if S['subs']:
        u = u.replace('{s}', S['subs'][(x + y) % len(S['subs'])])
    ty = (1 << z) - 1 - y  # TMS 行号（y 自下而上）
    rep = {'{z}': z, '{x}': x, '{y}': y, '{-y}': ty, '{ty}': ty, '{x16}': x >> 4, '{ty16}': ty >> 4,
           '{tk}': CFG['tk'], '{wb}': CFG['wb'], '{mk}': CFG['mk'], '{tk1}': CFG['tk1']}
    for k, v in rep.items():
        u = u.replace(k, str(v))
    u = u.replace('{q}', quadkey(z, x, y))
    m = re.search(r'\{[^{}]*\}', u)
    if m:  # 未替换的占位符（如 {s} 未给 --subs）：立即报错，不要逐张重试
        raise SourceError(f'{src} URL 模板含未识别的占位符 {m.group(0)}：{u}', 'deny')
    return u


def is_placeholder(src, data, headers):
    """仅用于已确认是图片的正文"""
    if len(data) < 1500:
        return True
    return src == 'bing' and headers.get('X-VE-Tile-Info', '').lower() == 'no-tile'


def _out_of_range(b):
    """OGC/WMTS 异常报告明确说瓦片超出范围（TileOutOfRange，或 TILEMATRIX/TILEROW/TILECOL 参数无效）：这是缺图，不是错误"""
    head = b[:4096]
    if re.search(rb'TileOutOfRange', head, re.I):
        return True
    return bool(re.search(rb'InvalidParameterValue', head)
                and re.search(rb'locator\s*=\s*["\']tile(?:matrix|row|col)["\']', head, re.I))


def _cached(src, f, miss):
    """读磁盘缓存：返回 bytes；已记缺图返回 None；无缓存（或缓存损坏，已清理）返回 False"""
    try:
        b = f.read_bytes()
    except FileNotFoundError:
        b = None
    if b is not None:
        if _image_ok(b):
            return b
        f.unlink(missing_ok=True)   # 截断/非图片（旧版把错误页当瓦片存下的）：删掉重下
    return None if miss.exists() else False


def _download(src, z, x, y, retries):
    """下载一张瓦片：返回图片 bytes；服务器明确缺图返回 None；失败抛 FetchError（kind 见其说明）"""
    S = SOURCES[src]
    hdr = {'Referer': S['referer']} if S.get('referer') else {}
    url = src_url(src, z, x, y)
    last, kind = None, 'net'
    for k in range(retries):
        if _stop.is_set():
            raise Interrupted('已中断')
        wait = 1.5 * (k + 1) ** 2 + random.random()
        try:
            r = session().get(url, headers=hdr, timeout=20)
            body = r.content
            code = r.status_code
            if code in (404, 204) or (code == 200 and not body) or (code != 200 and _out_of_range(body)):
                return None
            if code == 200:
                if not _looks_image(body):
                    if _out_of_range(body):
                        return None
                    # 天地图/吉林一号/自定义源在 Key 无效、超配额或被拦截时常返回 200 + XML/HTML/JSON：不是缺图，不能记 .miss
                    raise SourceError(f'{src} {z}/{x}/{y}: 服务返回的不是图片（Key 无效/超出配额/被拦截/不提供该层级？'
                                      f'Content-Type {r.headers.get("Content-Type", "?")}）：' + _snippet(body))
                if not _image_ok(body):
                    last, kind = f'图片数据不完整（{len(body)} B）', 'net'
                elif is_placeholder(src, body, r.headers):
                    return None
                else:
                    return body
            else:
                last = f'HTTP {code}' + _snippet(body)
                if code in (401, 403, 407, 418, 429):   # 鉴权/封禁/限流：退避重试，仍失败计入熔断
                    kind = 'deny'
                    wait += 5 + 10 * k
                elif 400 <= code < 500 and code != 408:   # 其他 4xx：重试也一样，不空等
                    raise FetchError(f'{src} {z}/{x}/{y}: {last}', 'bad')
                else:   # 5xx / 408：服务端临时问题
                    kind = 'net'
        except FetchError:
            raise
        except Exception as e:  # 网络错误：退避重试
            last, kind = str(e), 'net'
        if k < retries - 1:   # 最后一次失败后不再空等
            _sleep(wait)
    raise FetchError(f'{src} {z}/{x}/{y}: {last}', kind)


def fetch_raw(src, z, x, y, retries=4):
    """返回 bytes；缺图返回 None（含超出该源最大层级、本次运行已判定该源不提供此层级）；失败抛异常。结果缓存到磁盘。"""
    if z > SOURCES[src].get('maxz', 99):
        return None   # 已知不提供的层级：不发请求、不记 .miss
    d = cache_dir(src) / str(z) / str(x)
    f = d / f'{y}.jpg'
    miss = d / f'{y}.miss'
    b = _cached(src, f, miss)
    if b is not False:
        return b
    with _path_lock(str(f)):
        b = _cached(src, f, miss)   # 等锁期间别的线程可能已下好
        if b is not False:
            return b
        if level_off(src, z):
            return None
        why = dead_reason(src)
        if why:
            raise SourceError(why)
        try:
            b = _download(src, z, x, y, retries)
            if b is None:
                d.mkdir(parents=True, exist_ok=True)
                miss.touch()
            else:
                _atomic_write(f, b)
        except Interrupted:
            raise
        except Exception as e:
            _fail(src, (z, x, y), e)
            raise
        _ok(src, z)
        return b


def fetch_wgs(src, z, x, y):
    """返回 WGS-84 网格对齐的瓦片 JPEG bytes（GCJ 源在此纠偏拼接）；缺图返回 None。"""
    if not SOURCES[src]['gcj']:
        return fetch_raw(src, z, x, y)
    out = cache_dir(src) / str(z) / str(x) / f'{y}.jpg'
    miss = out.with_suffix('.miss')
    b = _cached(src, out, miss)
    if b is not False:
        return b
    if level_off(src, z):
        return None
    from PIL import Image
    lonW, latN = tile_nw(z, x, y)
    lonC, latC = tile_nw(z, x + 0.5, y + 0.5)
    gl, gb = wgs2gcj(lonC, latC)
    tx, ty = lonlat_to_tile(lonW + (gl - lonC), latN + (gb - latC), z)
    ix, iy = int(math.floor(tx)), int(math.floor(ty))
    fx, fy = tx - ix, ty - iy
    canvas = Image.new('RGB', (512, 512))
    for dx in (0, 1):
        for dy in (0, 1):
            raw = fetch_raw(src + '_raw', z, ix + dx, iy + dy)
            if raw is None:
                if not level_off(src, z):   # 本次运行跳过的层级不记 .miss（下次运行重新判断）
                    out.parent.mkdir(parents=True, exist_ok=True)
                    miss.touch()
                return None
            try:
                im = Image.open(io.BytesIO(raw)).convert('RGB')
            except (OSError, ValueError, SyntaxError) as e:   # 原图缓存损坏：删掉，下次重下
                p = cache_dir(src + '_raw') / str(z) / str(ix + dx) / f'{iy + dy}.jpg'
                p.unlink(missing_ok=True)
                raise RuntimeError(f'{p} 无法解码，已删除待重下：{e}')
            canvas.paste(im, (dx * 256, dy * 256))
    # 整像素平移裁剪：双线性亚像素重采样会明显发虚（拉普拉斯清晰度约降一半，--pick sharp 会因此系统性压低 GCJ 源），
    # 而单一中心偏移本身在瓦片边角就有约 0.2~0.6 px 误差，取整只多出 ≤0.5 px
    ox, oy = round(fx * 256), round(fy * 256)
    tile = canvas.crop((ox, oy, ox + 256, oy + 256))
    buf = io.BytesIO()
    tile.save(buf, 'JPEG', quality=88, optimize=True)
    _atomic_write(out, buf.getvalue())
    return buf.getvalue()


def _raw_variants():
    for k in list(SOURCES):
        if SOURCES[k]['gcj'] and not k.endswith('_raw'):
            SOURCES[k + '_raw'] = dict(SOURCES[k], gcj=False)


_raw_variants()


def _run_pool(workers, fn, items, on_result):
    """线程池执行。Ctrl-C 或任务抛异常时取消排队任务、让在跑的任务尽快退出
    （ThreadPoolExecutor 的 with 退出默认 wait=True 且不取消，会默默把整个队列跑完）。"""
    _stop.clear()
    ex = ThreadPoolExecutor(workers)
    try:
        for fu in as_completed([ex.submit(fn, it) for it in items]):
            on_result(fu.result())
    except BaseException as e:
        _stop.set()
        ex.shutdown(wait=False, cancel_futures=True)
        if isinstance(e, KeyboardInterrupt):
            print('\n已中断：排队中的瓦片已取消；已完成的都在缓存里，重新运行同一命令即可断点续传。', flush=True)
        raise
    ex.shutdown(wait=True)


def _maxz_note(sources, tiles):
    zmax = max((t[0] for t in tiles), default=0)
    for s in sources:
        mz = SOURCES[s].get('maxz')
        if mz is not None and zmax > mz:
            rng = f'z{zmax}' if zmax == mz + 1 else f'z{mz + 1}~z{zmax}'
            print(f'  {s} 只到 z{mz}：{rng} 对它按缺图处理（不请求），由其他源提供')


def download(sources, plan, workers):
    tiles = plan_tiles(plan)
    print(f'计划 {plan}：{len(tiles)} 张瓦片，源 {sources}')
    _maxz_note(sources, tiles)
    done = fail = got = 0
    t0 = time.time()

    def job(t):
        for s in sources:
            try:
                b = fetch_wgs(s, *t)
            except Exception as e:
                return ('err', str(e), t)
            if b:
                return ('ok', s, t)
        return ('miss', None, t)

    errs, failed = [], []

    def on_result(res):
        nonlocal done, got, fail
        st, info, t = res
        done += 1
        if st == 'ok':
            got += 1
        elif st == 'err':
            fail += 1
            failed.append(t)
            if len(errs) < 20:
                errs.append(info)
        if done % 500 == 0 or done == len(tiles):
            el = time.time() - t0
            print(f'  {done}/{len(tiles)}  成功 {got}  失败 {fail}  {done / max(el, 1e-3):.1f} 张/秒', flush=True)

    n_off = _levels_off()
    _run_pool(workers, job, tiles, on_result)
    if failed and _levels_off() > n_off:
        # 判定“该源不提供某层级”之前，那一层级已有几张因它出错而没回退到后面的源；不补这一轮的话，
        # 每次重跑都是这几张先撞上错误，永远补不上
        retry = failed[:]
        failed.clear()
        errs.clear()
        done -= len(retry)
        fail -= len(retry)
        print(f'  有层级被判定为该源不提供（见上），重试此前出错的 {len(retry)} 张…', flush=True)
        _run_pool(workers, job, retry, on_result)
    for e in errs:
        print('  错误：', e)
    _report_dead()
    if fail:
        print(f'有 {fail} 张因网络/服务错误未完成，重新运行本命令即可断点续传。')


# ───────────────────────── 清晰度评分与择优 ─────────────────────────
def tile_score(data):
    """清晰度 = 灰度拉普拉斯方差（越大越清楚）；积雪/云（高亮低饱和）占比高时降分；返回 (score, 雪云比例)"""
    import numpy as np
    from PIL import Image
    im = Image.open(io.BytesIO(data)).convert('RGB').resize((256, 256))
    a = np.asarray(im, np.float32)
    g = a.mean(axis=2)
    lap = g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    sharp = float(lap.var())
    mx, mn = a.max(axis=2), a.min(axis=2)
    snow = float(((mx > 215) & ((mx - mn) < 28)).mean())
    return sharp * (1 - min(0.8, snow * 1.5)), snow


def _bad_cached(src, t, e):
    """缓存瓦片无法解码：删掉（下次重下），返回按“出错”处理的异常"""
    p = cache_dir(src) / str(t[0]) / str(t[1]) / f'{t[2]}.jpg'
    p.unlink(missing_ok=True)
    return RuntimeError(f'{p} 无法解码，已删除待重下：{e}')


def _score(src, t, b):
    """tile_score；解码失败按出错处理，而不是让整个任务崩掉"""
    try:
        return tile_score(b)
    except (OSError, ValueError, SyntaxError) as e:   # UnidentifiedImageError / image file is truncated 都是 OSError
        raise _bad_cached(src, t, e)


def _check_decodes(src, t, b):
    from PIL import Image
    try:
        Image.open(io.BytesIO(b)).load()
    except (OSError, ValueError, SyntaxError) as e:
        raise _bad_cached(src, t, e)


def download_pick(sources, plan, workers, block=3):
    """按 2^block × 2^block 瓦片块择优：每块抽样 4 张给各源打分，整块用得分最高的源（避免逐瓦片拼色）。结果写入 best 源缓存。
    某源出错（网络/限流/Key 问题）≠ 缺图：该块（或该瓦片）本次不写，重跑时重新择优，避免被永久降级到次优源。
    只有“能提供这一块”的候选源才会这样挡住它：超出最大层级、或本次被判定不提供该层级的源按缺图处理，不参与排名也不挡；
    已停用的源若抽样瓦片都在缓存里，照常参与排名，只有需要联网取的样本才会让本块留空。"""
    CFG['best'] = best_key(sources, block)
    bdir = cache_dir('best')
    meta = _best_meta()
    used_all = set(meta.get('used', []))
    used_lock = threading.Lock()
    meta.update(sources=sources, dirs=[cache_dir(s).name for s in sources], block=block, used=sorted(used_all))
    _atomic_write(bdir / '_meta.json', json.dumps(meta, ensure_ascii=False, indent=1).encode('utf-8'))
    tiles = plan_tiles(plan)
    groups = {}
    for t in tiles:
        groups.setdefault((t[0], t[1] >> block, t[2] >> block), []).append(t)
    print(f'计划 {plan}：{len(tiles)} 张瓦片，{len(groups)} 块，候选源 {sources}（逐块择优）→ {bdir}')
    _maxz_note(sources, tiles)
    stat = {s: 0 for s in sources}
    done = nmiss = nerr = 0
    errs = {}   # 源 -> 首个错误
    t0 = time.time()

    def best_path(t):
        return bdir / str(t[0]) / str(t[1]) / f'{t[2]}.jpg'

    def job(key):
        """返回 (块键, 各源写入张数, 块内瓦片数, 缺图数, 出错数, 首个错误)"""
        ts = groups[key]
        todo = [t for t in ts if not best_path(t).exists()]
        if not todo:
            return key, {}, len(ts), 0, 0, None
        if _stop.is_set():
            raise Interrupted('已中断')
        rnd = random.Random(hash(key))
        sample = rnd.sample(ts, min(4, len(ts)))
        scores = {}
        # 已停用的源先抽样：样本没缓存时立刻出错，就不必再取其他源
        for s_ in sorted(sources, key=lambda s: dead_reason(s) is None):
            sc, n, serr = 0.0, 0, None
            for t in sample:   # 出错后仍把本源样本过完：损坏的缓存样本一轮就全部清掉，重跑即可重下
                try:
                    b = fetch_wgs(s_, *t)
                    if b:
                        sc += _score(s_, t, b)[0]
                        n += 1
                except Interrupted:
                    raise
                except Exception as e:
                    serr = serr or (s_, str(e))
            if serr:
                # 抽样出错 ≠ 缺图：本块这次不择优、不写，重跑时再来（超出最大层级/本次跳过的层级返回缺图，不会走到这里）
                return key, {}, len(ts), 0, len(todo), serr
            if n:
                mean, cov = sc / n, n / len(sample)
                scores[s_] = mean * cov * cov   # 覆盖率平方扣分：有意偏向整块都有图的源，减少块内回退拼色
        order = sorted(scores, key=lambda k: -scores[k]) + [s_ for s_ in sources if s_ not in scores]
        used, nm, ne, err = {}, 0, 0, None
        for t in todo:
            if _stop.is_set():
                raise Interrupted('已中断')
            for s_ in order:
                try:
                    b = fetch_wgs(s_, *t)
                    if b:
                        _check_decodes(s_, t, b)   # 不把解不开的字节写进 best（会原样打进包）
                except Interrupted:
                    raise
                except Exception as e:
                    # 排名更高的源出错：不回退到次优源（写入后重跑也不会再改），留空待重跑
                    ne += 1
                    err = err or (s_, str(e))
                    break
                if b:
                    _atomic_write(best_path(t), b)
                    used[s_] = used.get(s_, 0) + 1
                    with used_lock:   # 写入即记录（块中途被中断也不漏记署名）
                        used_all.add(s_)
                    break
            else:
                nm += 1   # 各源都确实缺图
        return key, used, len(ts), nm, ne, err

    failed = {}   # 有瓦片出错的块 -> (块内瓦片数, 缺图数, 出错数)

    def on_result(res):
        nonlocal done, nmiss, nerr
        key, used, n, nm, ne, err = res
        for s_, c in used.items():
            stat[s_] += c
        done += n
        nmiss += nm
        nerr += ne
        if ne:
            failed[key] = (n, nm, ne)
        if err and err[0] not in errs:
            errs[err[0]] = err[1]
        if done % 1000 < n or done == len(tiles):
            print(f'  {done}/{len(tiles)}  缺图 {nmiss}  出错 {nerr}  {done / max(time.time() - t0, 1e-3):.1f} 张/秒  本次写入：{stat}', flush=True)

    try:
        n_off = _levels_off()
        _run_pool(workers, job, list(groups), on_result)
        if failed and _levels_off() > n_off:
            # 判定“某源不提供某层级”之前，那一层级已有几块被它的错误挡住；不补这一轮的话，每次重跑都是这几块先撞上错误
            retry = list(failed)
            for n, nm, ne in failed.values():
                done -= n
                nmiss -= nm
                nerr -= ne
            failed.clear()
            errs.clear()
            print(f'  有层级被判定为该源不提供（见上），重新择优此前出错的 {len(retry)} 块…', flush=True)
            _run_pool(workers, job, retry, on_result)
    finally:   # 记录实际采用过的源（打包时据此写署名）
        with used_lock:
            meta['used'] = [s for s in sources if s in used_all] + sorted(used_all - set(sources))
        _atomic_write(bdir / '_meta.json', json.dumps(meta, ensure_ascii=False, indent=1).encode('utf-8'))
    print('本次各源写入瓦片数：', stat)
    for s_, e in errs.items():
        print(f'  {s_} 首个错误：{e}')
    _report_dead()
    if nmiss:
        print(f'有 {nmiss} 张各候选源都缺图。')
    if nerr:
        print(f'有 {nerr} 张因网络/服务错误暂未择优写入（未回退到次优源），问题解决后重新运行即可续传。')


def cmd_bench(sources, plan, n=10):
    """各片区在其最高层级随机抽样，比较各源：可用率、清晰度、雪/云比例"""
    rnd = random.Random(7)
    errs = {}   # 源 -> 首个错误
    print(f'{"片区":12s} {"层级":4s} ' + ' '.join(f'{s:>22s}' for s in sources))
    for name, bbox, z0, z1 in PLANS[plan]:
        ts = list(tiles_in(bbox, z1))
        sample = rnd.sample(ts, min(n, len(ts)))
        cells = []
        for s_ in sources:
            ok, bad, sc, sn = 0, 0, 0.0, 0.0
            for (x, y) in sample:
                try:
                    b = fetch_wgs(s_, z1, x, y)
                    if b:
                        a, w = _score(s_, (z1, x, y), b)
                        ok += 1
                        sc += a
                        sn += w
                except Exception as e:
                    bad += 1
                    errs.setdefault(s_, str(e))
            if ok:
                cells.append(f'{ok}/{len(sample)} 清晰{sc / ok:7.0f} 雪{sn / ok:4.0%}' + (f' 错{bad}' if bad else ''))
            else:
                cells.append(f'   —— 出错 {bad} 张（见下）' if bad else '   —— 无图')
        print(f'{name:12s} z{z1:<3d} ' + ' '.join(f'{c:>22s}' for c in cells), flush=True)
    print('清晰度为灰度拉普拉斯方差（越大越清楚，同片区横向比较）；雪 = 高亮低饱和像素比例（积雪/云/过曝）。')
    for s_, e in errs.items():
        print(f'  {s_} 首个错误：{e}')
    _report_dead()


# ───────────────────────── 打包 ─────────────────────────
def _attribution(sources):
    """署名：best 展开为实际采用过的提供方（best_*/_meta.json 记录），而不是笼统的“多源择优”"""
    names = []
    for s in sources:
        if s == 'best':
            meta = _best_meta()
            names += [k for k in (meta.get('used') or meta.get('sources') or ['best']) if k in SOURCES]
        else:
            names.append(s)
    names = list(dict.fromkeys(names))
    tail = '（逐块择优；离线瓦片包，仅供个人本地使用）' if 'best' in sources else '（离线瓦片包，仅供个人本地使用）'
    return '影像：' + ' / '.join(SOURCES[s]['attr'] for s in names) + tail


def _dir_hint(name):
    """缓存目录名 → 给用户看的提示（wayback_<期号> 附上对应的 --wayback 参数）"""
    return f'{name}（--wayback {name[8:]}）' if name.startswith('wayback_') else name


def pack(sources, plan):
    tiles = plan_tiles(plan)
    dirs = {s: cache_dir(s) for s in sources}
    if 'best' in dirs and not dirs['best'].exists():
        cands = []
        for p in sorted(CACHE.glob('best_*')):
            try:
                m = json.loads((p / '_meta.json').read_text('utf-8'))
                ds = m.get('dirs') or []
                cands.append(f'  {p.name}: --source ' + ','.join(m['sources'])
                             + ''.join(f' --wayback {d[8:]}' for d in ds if d.startswith('wayback_'))
                             + (f'（缓存目录：{", ".join(ds)}）' if ds else ''))
            except (OSError, ValueError, KeyError, TypeError):
                pass
        sys.exit(f'没有与当前参数对应的择优结果 {dirs["best"]}：打包时 --source（以及 --wayback / --url / --jl1-mk）'
                 '须与 download --pick sharp 时一致。' + ('\n已有的择优结果：\n' + '\n'.join(cands) if cands else ''))
    for s, d in dirs.items():
        if s != 'best' and not d.is_dir():
            alt = [_dir_hint(p.name) for p in sorted(CACHE.glob(f'{s}_*'))
                   if s in ('wayback', 'custom', 'jl1') and p.is_dir() and not p.name.endswith('_raw')]
            print(f'  注意：{s} 没有缓存目录 {d.name}/（下载时没用到该源，或参数与下载时不同）'
                  + (f'；已有：{", ".join(alt)}' if alt else '') + '，该源不参与打包')
    OUT.mkdir(parents=True, exist_ok=True)
    staged, bad = [], 0   # [临时文件, 目标文件, 文件名, 张数, 计划张数, z0, z1]：全部写好再替换，没有瓦片时不动已有的包
    try:
        for z0, z1 in BANDS:
            sel = [t for t in tiles if z0 <= t[0] <= z1]
            if not sel:
                continue
            name = f'xian_z{z0}-{z1}.xtp' if z0 != z1 else f'xian_z{z0}.xtp'
            path = OUT / name
            tmp = path.with_suffix('.part')
            staged.append([tmp, path, name, 0, len(sel), z0, z1])
            index = []
            with open(tmp, 'wb') as f:
                f.write(b'\0' * 32)
                off = 32
                for (z, x, y) in sel:
                    data = None
                    for s in sources:
                        p = dirs[s] / str(z) / str(x) / f'{y}.jpg'
                        if p.exists():
                            data = p.read_bytes()
                            if _image_ok(data):
                                break
                            # 截断/非图片：不打进包，删掉让下次 download 重取；继续用后面的源
                            bad += 1
                            data = None
                            p.unlink(missing_ok=True)
                    if not data:
                        continue
                    f.write(data)
                    index.append((z, x, y, off, len(data)))
                    off += len(data)
                index_off = off
                for z, x, y, o, n in index:
                    f.write(struct.pack('<IIQI', (z << 24) | x, y, o, n))
                f.seek(0)
                f.write(b'XTP1' + struct.pack('<III', 1, len(index), 1) + struct.pack('<QQ', index_off, 32))
            staged[-1][3] = len(index)
        if not any(st[3] for st in staged):
            sys.exit(f'缓存里没有可打包的瓦片（源 {sources}，缓存目录 {", ".join(_dir_hint(d.name) for d in dirs.values())}）：'
                     f'未改动 {OUT}。请先 download，或检查 --source / --wayback 等参数是否与下载时一致。')
    except BaseException:
        for st in staged:
            st[0].unlink(missing_ok=True)
        raise
    manifest = {'version': 1, 'generated': time.strftime('%Y-%m-%dT%H:%M:%S'), 'plan': plan,
                'attribution': _attribution(sources),
                'packs': []}
    for tmp, path, name, cnt, nsel, z0, z1 in staged:
        if not cnt:
            tmp.unlink(missing_ok=True)
            print(f'  {name}: 0/{nsel} 张，缓存里没有这一层级段的瓦片：不生成、不列入清单')
            continue
        os.replace(tmp, path)
        print(f'  {name}: {cnt}/{nsel} 张，{path.stat().st_size / 1e6:.0f} MB')
        manifest['packs'].append({'file': name, 'minZ': z0, 'maxZ': z1, 'count': cnt})
    _atomic_write(OUT / 'index.json', json.dumps(manifest, ensure_ascii=False, indent=1).encode('utf-8'))
    if bad:
        print(f'  有 {bad} 个缓存瓦片损坏/非图片，已跳过并删除；重新运行 download 可补齐后再打包。')
    print(f'完成 → {OUT}/index.json（前端自动启用“本地离线高清”影像；?pack=0 可关闭）')


# ───────────────────────── 规划与对比 ─────────────────────────
def cmd_plan(plan):
    total = 0
    for name, bbox, z0, z1 in PLANS[plan]:
        n = sum(len(list(tiles_in(bbox, z))) for z in range(z0, z1 + 1))
        total += n
        print(f'  {name:8s} z{z0}-{z1}: {n:7d} 张')
    uniq = len(plan_tiles(plan))
    print(f'合计（去重）{uniq} 张，按 25 KB/张估约 {uniq * 25 / 1024:.0f} MB')


def cmd_compare(lon, lat, z, sources):
    from PIL import Image, ImageDraw
    x, y = lonlat_to_tile(lon, lat, z)
    x, y = int(x), int(y)
    ims = []
    for s in sources:
        try:
            b = fetch_wgs(s, z, x, y)
            im = Image.open(io.BytesIO(b)).convert('RGB') if b else Image.new('RGB', (256, 256), (80, 0, 0))
        except Exception as e:
            print(s, e)
            im = Image.new('RGB', (256, 256), (0, 0, 80))
        ims.append((s, im))
    sheet = Image.new('RGB', (256 * len(ims), 276), (20, 20, 20))
    dr = ImageDraw.Draw(sheet)
    for i, (s, im) in enumerate(ims):
        sheet.paste(im, (i * 256, 20))
        dr.text((i * 256 + 6, 4), f'{s} z{z}', fill=(255, 255, 255))
    d = ROOT / 'research' / 'imagery_compare'
    d.mkdir(parents=True, exist_ok=True)
    p = d / f'cmp_{lon:.4f}_{lat:.4f}_z{z}.png'
    sheet.save(p)
    print('对比图 →', p)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['plan', 'compare', 'bench', 'download', 'pack', 'all'])
    ap.add_argument('--source', default='google,esri')
    ap.add_argument('--plan', default='default', choices=list(PLANS))
    ap.add_argument('--pick', choices=['first', 'sharp'], default='first', help='first：按顺序回退；sharp：逐块择优（输出为 best 源）')
    ap.add_argument('--workers', type=int, default=12)
    ap.add_argument('--lon', type=float, default=108.9423)
    ap.add_argument('--lat', type=float, default=34.2610)
    ap.add_argument('--z', type=int, default=19)
    ap.add_argument('--tk', default=CFG['tk'], help='天地图 Key（服务器端），也可用环境变量 TIANDITU_TK')
    ap.add_argument('--wayback', default='latest',
                    help='Esri Wayback 期号；latest（默认）= 第一次查到的最新一期，固定下来一直沿用；refresh = 改用当前最新一期')
    ap.add_argument('--jl1-mk', default=CFG['mk'])
    ap.add_argument('--jl1-tk', default=CFG['tk1'])
    ap.add_argument('--url', default='', help='custom 源的 XYZ 模板（也可覆盖 jl1 模板）')
    ap.add_argument('--subs', default='', help='--url 模板中 {s} 的取值，逐字符轮换，如 abc 或 1234')
    ap.add_argument('--gcj', action='store_true', help='custom 源为 GCJ-02 坐标')
    ap.add_argument('--retry-miss', action='store_true', help='先删除所选源缓存里的 .miss 缺图标记，再重试这些瓦片')
    a = ap.parse_args()
    CFG.update(tk=a.tk, mk=a.jl1_mk, tk1=a.jl1_tk)
    if a.url:
        key = 'jl1' if 'jl1' in a.source and 'custom' not in a.source else 'custom'
        if '{s}' in a.url and not a.subs:
            sys.exit('--url 模板含 {s} 子域占位符：请用 --subs 指定取值（如 abc 或 1234，以该服务实际子域为准）')
        SOURCES[key].update(url=a.url, gcj=a.gcj, subs=a.subs or None)
        _raw_variants()   # 须在设置 subs 之后：GCJ 原图源 <源>_raw 复制这些字段
    sources = [s.strip() for s in a.source.split(',') if s.strip()]
    for s in sources:
        if s not in SOURCES or s.endswith('_raw'):
            sys.exit(f'未知源 {s}，可选：' + ' '.join(k for k in SOURCES if not k.endswith('_raw')))
    if 'tianditu' in sources and not CFG['tk']:
        sys.exit('天地图需要 Key：在 https://console.tianditu.gov.cn 免费申请“服务器端”Key，然后加 --tk 或设环境变量 TIANDITU_TK')
    if 'jl1' in sources and not (CFG['mk'] and CFG['tk1']):
        sys.exit('吉林一号需要在“共生地球/吉林一号网”注册后获取影像图层 mk 与令牌 tk：--jl1-mk ... --jl1-tk ...')
    if 'custom' in sources and not SOURCES['custom']['url']:
        sys.exit('custom 源需要 --url 模板')
    if 'best' in sources:
        sys.exit('best 是 --pick sharp 的输出：请用 --pick sharp 并给出与下载时相同的候选 --source')
    if 'wayback' in sources:
        CFG['wb'] = wayback_release(a.wayback)
    for s in sources:
        try:
            src_url(s, 18, 0, 0)   # 模板占位符检查：有未替换的直接退出，而不是逐张重试
        except SourceError as e:
            sys.exit(str(e))
    if a.pick == 'sharp':
        CFG['best'] = best_key(sources)
    if a.retry_miss:
        n = 0
        for s in sources:
            for d in [cache_dir(s)] + ([cache_dir(s + '_raw')] if SOURCES[s]['gcj'] else []):
                for p in d.rglob('*.miss'):
                    p.unlink(missing_ok=True)
                    n += 1
        print(f'已清除 {n} 个 .miss 缺图标记')
    if a.cmd == 'plan':
        cmd_plan(a.plan)
    elif a.cmd == 'compare':
        cmd_compare(a.lon, a.lat, a.z, sources if a.source != 'google,esri' else ['google', 'esri', 'esri_clarity', 'bing', 'amap', 'tencent'])
    elif a.cmd == 'bench':
        cmd_bench(sources, a.plan)
    elif a.cmd == 'download':
        (download_pick if a.pick == 'sharp' else download)(sources, a.plan, a.workers)
    elif a.cmd == 'pack':
        pack(['best'] if a.pick == 'sharp' else sources, a.plan)
    else:
        (download_pick if a.pick == 'sharp' else download)(sources, a.plan, a.workers)
        pack(['best'] if a.pick == 'sharp' else sources, a.plan)


def wayback_release(want):
    """Esri Wayback 期号（release 编号）。缓存目录 wayback_<期号>/ 与择优结果目录都随期号变化，所以 latest 不能每次都重新查：
    第一次查到的最新一期固定在 CACHE/wayback_latest.json，之后 latest 一直沿用它——续传下载、隔几周单独 pack 都落在同一期、
    同一目录，Esri 发布新一期也不会悄悄换到空目录（从头下载 / 打出空包）。refresh：重新查最新一期并更新固定值；其他值按期号用。"""
    if want not in ('latest', 'refresh'):
        return want
    pin = CACHE / 'wayback_latest.json'
    if want == 'latest':
        try:
            p = json.loads(pin.read_text(encoding='utf-8'))
            print(f'Esri Wayback：沿用固定的一期 {p.get("title", "")}（期号 {p["release"]}；改用当前最新一期加 --wayback refresh）')
            return str(p['release'])
        except (OSError, ValueError, KeyError, TypeError):
            pass
    try:
        r = session().get('https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json', timeout=30)
        rel, item = max(r.json().items(), key=lambda kv: kv[1].get('itemTitle', ''))
    except Exception as e:
        sys.exit(f'查询 Esri Wayback 期号列表失败（{e}）：可用 --wayback <期号> 直接指定')
    rel = str(rel)
    _atomic_write(pin, json.dumps({'release': rel, 'title': item.get('itemTitle', ''), 'pinned': time.strftime('%Y-%m-%d')},
                                  ensure_ascii=False).encode('utf-8'))
    print(f'Esri Wayback 最新一期：{item.get("itemTitle", "")}（期号 {rel}），已固定，之后 --wayback latest 都用这一期')
    return rel


if __name__ == '__main__':
    main()
