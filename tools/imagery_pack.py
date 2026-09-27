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
  wayback       Esri Wayback 指定期（--wayback latest 或期号；可挑无雪的新一期）
  bing          Bing 航拍（WGS-84，z19）
  tianditu      天地图卫星（国家地理信息公共服务平台，免费，需“服务器端”Key：--tk 或环境变量 TIANDITU_TK；CGCS2000≈WGS-84，z18）
  amap          高德卫星（GCJ-02，下载后逐瓦片纠偏回 WGS-84；z18 以上仅部分区域）
  tencent       腾讯卫星（GCJ-02，自动纠偏）
  jl1           吉林一号“共生地球”年度影像（0.5~0.75 m，免费注册；--jl1-mk 影像图层 mk、--jl1-tk 令牌，
                URL 模板以其控制台为准，可用 --url 覆盖）
  custom        任意 XYZ 模板：--url 'https://host/{z}/{x}/{y}.jpg'（占位符 {z} {x} {y} {-y}(TMS) {q}(quadkey) {s}），GCJ 源加 --gcj
缓存：data-src/tiles_hd/<源>/<z>/<x>/<y>.jpg（纠偏前的高德原图在 data-src/tiles_hd/amap_raw/）；缺图记为 .miss。
"""
import argparse
import io
import json
import math
import os
import random
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

SOURCES = {
    'google': {'url': 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', 'subs': '0123', 'gcj': False,
               'referer': 'https://www.google.com/maps', 'attr': 'Google 卫星'},
    'esri': {'url': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
             'subs': None, 'gcj': False, 'attr': 'Esri World Imagery'},
    'bing': {'url': 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=14500', 'subs': '0123', 'gcj': False,
             'attr': 'Microsoft Bing'},
    'amap': {'url': 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', 'subs': '1234',
             'gcj': True, 'attr': '高德卫星（已纠偏）'},
    'esri_clarity': {'url': 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                     'subs': None, 'gcj': False, 'attr': 'Esri World Imagery (Clarity)'},
    'wayback': {'url': 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{wb}/{z}/{y}/{x}',
                'subs': None, 'gcj': False, 'attr': 'Esri World Imagery Wayback'},
    'tianditu': {'url': 'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default'
                        '&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}',
                 'subs': '01234567', 'gcj': False, 'attr': '天地图（国家地理信息公共服务平台）'},
    'tencent': {'url': 'https://p{s}.map.gtimg.com/sateTiles/{z}/{x16}/{ty16}/{x}_{ty}.jpg', 'subs': '0123', 'gcj': True,
                'attr': '腾讯地图卫星（已纠偏）'},
    'jl1': {'url': 'https://api.jl1mall.com/getMap/{z}/{x}/{-y}?mk={mk}&tk={tk1}', 'subs': None, 'gcj': False,
            'attr': '吉林一号（长光卫星 共生地球）'},
    'custom': {'url': '', 'subs': None, 'gcj': False, 'attr': '自定义影像源'},
    'best': {'url': '', 'subs': None, 'gcj': False, 'attr': '多源择优'},
}
CFG = {'tk': os.environ.get('TIANDITU_TK', ''), 'wb': '', 'mk': os.environ.get('JL1_MK', ''), 'tk1': os.environ.get('JL1_TK', '')}

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
    return u.replace('{q}', quadkey(z, x, y))


def is_placeholder(src, data, headers):
    if len(data) < 1500:
        return True
    if src == 'bing' and headers.get('X-VE-Tile-Info', '').lower() == 'no-tile':
        return True
    return False


def fetch_raw(src, z, x, y, retries=4):
    """返回 bytes；缺图返回 None；网络错误抛异常。结果缓存到磁盘。"""
    d = CACHE / src / str(z) / str(x)
    f = d / f'{y}.jpg'
    miss = d / f'{y}.miss'
    if f.exists():
        return f.read_bytes()
    if miss.exists():
        return None
    S = SOURCES[src]
    hdr = {'Referer': S['referer']} if S.get('referer') else {}
    last = None
    for k in range(retries):
        try:
            r = session().get(src_url(src, z, x, y), headers=hdr, timeout=20)
            if r.status_code in (404, 204) or (r.status_code == 200 and is_placeholder(src, r.content, r.headers)):
                d.mkdir(parents=True, exist_ok=True)
                miss.touch()
                return None
            if r.status_code == 200 and r.content[:1] == b'<':
                # 天地图等在 Key 无效/超限时返回 XML/HTML 错误页
                raise RuntimeError('服务返回错误页（Key 无效或超出配额？）：' + r.content[:160].decode('utf-8', 'replace'))
            if r.status_code == 200:
                d.mkdir(parents=True, exist_ok=True)
                tmp = f.with_suffix('.part')
                tmp.write_bytes(r.content)
                os.replace(tmp, f)
                return r.content
            last = f'HTTP {r.status_code}'
            if r.status_code in (403, 429):
                time.sleep(5 + 10 * k)
        except Exception as e:  # 网络错误：退避重试
            last = str(e)
        time.sleep(1.5 * (k + 1) ** 2 + random.random())
    raise RuntimeError(f'{src} {z}/{x}/{y}: {last}')


def fetch_wgs(src, z, x, y):
    """返回 WGS-84 网格对齐的瓦片 JPEG bytes（GCJ 源在此纠偏拼接）；缺图返回 None。"""
    if not SOURCES[src]['gcj']:
        return fetch_raw(src, z, x, y)
    out = CACHE / src / str(z) / str(x) / f'{y}.jpg'
    miss = out.with_suffix('.miss')
    if out.exists():
        return out.read_bytes()
    if miss.exists():
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
                out.parent.mkdir(parents=True, exist_ok=True)
                miss.touch()
                return None
            canvas.paste(Image.open(io.BytesIO(raw)).convert('RGB'), (dx * 256, dy * 256))
    # 亚像素平移裁剪（双线性）
    tile = canvas.transform((256, 256), Image.AFFINE, (1, 0, fx * 256, 0, 1, fy * 256), resample=Image.BILINEAR)
    buf = io.BytesIO()
    tile.save(buf, 'JPEG', quality=88, optimize=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(buf.getvalue())
    return buf.getvalue()


def _raw_variants():
    for k in list(SOURCES):
        if SOURCES[k]['gcj'] and not k.endswith('_raw'):
            SOURCES[k + '_raw'] = dict(SOURCES[k], gcj=False)


_raw_variants()


def download(sources, plan, workers):
    tiles = plan_tiles(plan)
    print(f'计划 {plan}：{len(tiles)} 张瓦片，源 {sources}')
    done = fail = got = 0
    t0 = time.time()
    lock = threading.Lock()

    def job(t):
        for s in sources:
            try:
                b = fetch_wgs(s, *t)
            except Exception as e:
                return ('err', str(e))
            if b:
                return ('ok', s)
        return ('miss', None)

    errs = []
    with ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(job, t) for t in tiles]
        for fu in as_completed(futs):
            st, info = fu.result()
            with lock:
                done += 1
                if st == 'ok':
                    got += 1
                elif st == 'err':
                    fail += 1
                    if len(errs) < 20:
                        errs.append(info)
                if done % 500 == 0 or done == len(tiles):
                    el = time.time() - t0
                    print(f'  {done}/{len(tiles)}  成功 {got}  失败 {fail}  {done / max(el, 1e-3):.1f} 张/秒', flush=True)
    for e in errs:
        print('  错误：', e)
    if fail:
        print(f'有 {fail} 张因网络错误未完成，重新运行本命令即可断点续传。')


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


def download_pick(sources, plan, workers, block=3):
    """按 2^block × 2^block 瓦片块择优：每块抽样 4 张给各源打分，整块用得分最高的源（避免逐瓦片拼色）。结果写入 best 源缓存。"""
    tiles = plan_tiles(plan)
    groups = {}
    for t in tiles:
        groups.setdefault((t[0], t[1] >> block, t[2] >> block), []).append(t)
    print(f'计划 {plan}：{len(tiles)} 张瓦片，{len(groups)} 块，候选源 {sources}（逐块择优）')
    stat = {s: 0 for s in sources}
    done = fail = 0
    lock = threading.Lock()
    t0 = time.time()

    def job(key):
        ts = groups[key]
        rnd = random.Random(hash(key))
        sample = rnd.sample(ts, min(4, len(ts)))
        scores = {}
        for s_ in sources:
            sc, n = 0.0, 0
            for t in sample:
                try:
                    b = fetch_wgs(s_, *t)
                except Exception:
                    b = None
                if b:
                    sc += tile_score(b)[0]
                    n += 1
            if n:
                scores[s_] = sc / len(sample) * (n / len(sample))  # 缺图按比例扣分
        order = sorted(scores, key=lambda k: -scores[k]) + [s_ for s_ in sources if s_ not in scores]
        nf = 0
        for t in ts:
            out = CACHE / 'best' / str(t[0]) / str(t[1]) / f'{t[2]}.jpg'
            if out.exists():
                continue
            for s_ in order:
                try:
                    b = fetch_wgs(s_, *t)
                except Exception:
                    b = None
                if b:
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(b)
                    break
            else:
                nf += 1
        return (order[0] if scores else None), len(ts), nf

    with ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(job, k) for k in groups]
        for fu in as_completed(futs):
            best, n, nf = fu.result()
            with lock:
                if best:
                    stat[best] += n
                done += n
                fail += nf
                if done % 1000 < n or done == len(tiles):
                    print(f'  {done}/{len(tiles)}  未取到 {fail}  {done / max(time.time() - t0, 1e-3):.1f} 张/秒  采用：{stat}', flush=True)
    print('各源采用瓦片数：', stat)
    if fail:
        print(f'有 {fail} 张未取到（缺图或网络错误），重新运行可续传。')


def cmd_bench(sources, plan, n=10):
    """各片区在其最高层级随机抽样，比较各源：可用率、清晰度、雪/云比例"""
    rnd = random.Random(7)
    print(f'{"片区":12s} {"层级":4s} ' + ' '.join(f'{s:>22s}' for s in sources))
    for name, bbox, z0, z1 in PLANS[plan]:
        ts = list(tiles_in(bbox, z1))
        sample = rnd.sample(ts, min(n, len(ts)))
        cells = []
        for s_ in sources:
            ok, sc, sn = 0, 0.0, 0.0
            for (x, y) in sample:
                try:
                    b = fetch_wgs(s_, z1, x, y)
                except Exception as e:
                    b = None
                    err = str(e)[:60]
                if b:
                    a, w = tile_score(b)
                    ok += 1
                    sc += a
                    sn += w
            cells.append(f'{ok}/{len(sample)} 清晰{sc / max(ok, 1):7.0f} 雪{sn / max(ok, 1):4.0%}' if ok else '   —— 无图/出错')
        print(f'{name:12s} z{z1:<3d} ' + ' '.join(f'{c:>22s}' for c in cells), flush=True)
    print('清晰度为灰度拉普拉斯方差（越大越清楚，同片区横向比较）；雪 = 高亮低饱和像素比例（积雪/云/过曝）。')


# ───────────────────────── 打包 ─────────────────────────
def pack(sources, plan):
    tiles = plan_tiles(plan)
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {'version': 1, 'generated': time.strftime('%Y-%m-%dT%H:%M:%S'), 'plan': plan,
                'attribution': '影像：' + ' / '.join(SOURCES[s]['attr'] for s in sources) + '（离线瓦片包，仅供个人本地使用）',
                'packs': []}
    for z0, z1 in BANDS:
        sel = [t for t in tiles if z0 <= t[0] <= z1]
        if not sel:
            continue
        name = f'xian_z{z0}-{z1}.xtp' if z0 != z1 else f'xian_z{z0}.xtp'
        path = OUT / name
        tmp = path.with_suffix('.part')
        index = []
        with open(tmp, 'wb') as f:
            f.write(b'\0' * 32)
            off = 32
            for (z, x, y) in sel:
                data = None
                for s in sources:
                    p = CACHE / s / str(z) / str(x) / f'{y}.jpg'
                    if p.exists():
                        data = p.read_bytes()
                        break
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
        os.replace(tmp, path)
        mb = path.stat().st_size / 1e6
        print(f'  {name}: {len(index)}/{len(sel)} 张，{mb:.0f} MB')
        if index:
            manifest['packs'].append({'file': name, 'minZ': z0, 'maxZ': z1, 'count': len(index)})
    with open(OUT / 'index.json', 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
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
    ap.add_argument('--wayback', default='latest', help='Esri Wayback 期号或 latest')
    ap.add_argument('--jl1-mk', default=CFG['mk'])
    ap.add_argument('--jl1-tk', default=CFG['tk1'])
    ap.add_argument('--url', default='', help='custom 源的 XYZ 模板（也可覆盖 jl1 模板）')
    ap.add_argument('--gcj', action='store_true', help='custom 源为 GCJ-02 坐标')
    a = ap.parse_args()
    CFG.update(tk=a.tk, mk=a.jl1_mk, tk1=a.jl1_tk)
    if a.url:
        key = 'jl1' if 'jl1' in a.source and 'custom' not in a.source else 'custom'
        SOURCES[key].update(url=a.url, gcj=a.gcj)
        _raw_variants()
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
    if 'wayback' in sources:
        CFG['wb'] = wayback_release(a.wayback)
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
    """Esri Wayback：取最新一期（或指定期号）的 release 编号"""
    if want != 'latest':
        return want
    r = session().get('https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json', timeout=30)
    cfg = r.json()
    best = max(cfg.items(), key=lambda kv: kv[1].get('itemTitle', ''))
    print('Esri Wayback 最新一期：', best[1].get('itemTitle'), '期号', best[0])
    return best[0]


if __name__ == '__main__':
    main()
