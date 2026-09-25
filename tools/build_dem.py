#!/usr/bin/env python
"""地形 DEM 管线：产出 public/data/dem_main.png、dem_outer.png（Terrarium 编码，Web Mercator 对齐）。

见 docs/CONTRACT.md 3.1 / 3.2。流程：
 1. 下载 AWS Terrarium 高程瓦片（MAIN z12，OUTER z11）→ 作为兜底 / 空洞填补 / 对比基准。
 2. 下载 FABDEM v1-2（Forests And Buildings removed Copernicus DEM, 1″≈30 m）。原始 zip 2.7 GB，
    这里只用 HTTP Range 从远端 zip 中抽取需要的 4 块 1°×1° GeoTIFF（N33/N34 × E108/E109，共约 110 MB）。
    FABDEM 不可用时退化为 Terrarium（DSM），并对平原区做更强的形态学去建筑。
 3. 在 1″ 经纬度工作网格上：
    a) 平原区（开运算后海拔 < 700 m 且 1 km 内起伏 < 30 m）做形态学开运算（窗口约 200 m）+ 高斯平滑，
       去掉残余建筑/高架/城墙等窄凸起；黄土塬边坡、河谷（凹地形）与秦岭山体不受影响（开运算保坡、不填凹）。
    b) OSM 水体面（渭河/灞河/泾河等河道面、湖泊水库）做水面平整：湖泊取多边形内低分位数为单一水位；
       河道取沿程平滑的下包络水位（横向平、纵向缓降）。窄水体（护城河等平均宽度 < 50 m）不处理。
 4. 重采样到 Web Mercator 均匀网格（像素中心 x = x0 + (i+0.5)*(x1-x0)/w），Terrarium 编码写 PNG。
 5. 生成阴影地形预览图 data-src/dem/preview_*.png，并打印核对点高程。

用法：
  .venv-tools/bin/python tools/build_dem.py            # 自动（优先 FABDEM）
  .venv-tools/bin/python tools/build_dem.py --source terrarium   # 强制只用 Terrarium + 形态学滤波
"""
import argparse
import datetime
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import geo  # noqa: E402
import tilecache  # noqa: E402

ROOT = os.path.dirname(TOOLS)
SRC = os.path.join(ROOT, 'data-src', 'dem')
OUT = os.path.join(ROOT, 'public', 'data')
META = os.path.join(OUT, 'meta.json')

FABDEM_URL = 'https://data.bris.ac.uk/datasets/s5hqmjcdj8yo2ibzi9b4ew3sn/N30E100-N40E110_FABDEM_V1-2.zip'
FABDEM_TILES = ['N34E108', 'N34E109', 'N33E108', 'N33E109']
FABDEM_MAX_BYTES = 3 * 1024 ** 3
TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

AS = 3600  # 工作网格：1 角秒（与 FABDEM 像素中心对齐：像素中心位于整角秒）
# 工作网格范围（OUTER 外扩约 0.03°）
LON_LEFT = 108.27
LON_RIGHT = 109.73
LAT_TOP = 34.93
LAT_BOT = 33.62
NCOL = int(round((LON_RIGHT - LON_LEFT) * AS)) + 1
NROW = int(round((LAT_TOP - LAT_BOT) * AS)) + 1
# 工作网格在西安纬度的像素尺寸（米）
PX_M_Y = 6371008.8 * math.pi / 180 / AS                      # ≈30.9 m
PX_M_X = PX_M_Y * math.cos(math.radians(geo.LAT0))            # ≈25.6 m

SRC_FABDEM = ('FABDEM v1-2 (Hawker et al. 2022, University of Bristol & Fathom; CC BY-NC-SA 4.0), '
              'derived from Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018')
SRC_TERRARIUM = 'Terrain Tiles (Mapzen / AWS Open Data, Terrarium): SRTM, ETOPO1 and others'


# ----------------------------------------------------------------------------- 工具函数

def log(*a):
    print(*a, flush=True)


def bilinear_sep(A, ri, ci):
    """可分离双线性采样：ri(行, 长 H)、ci(列, 长 W) 为 A 的浮点下标，返回 H×W。越界夹到边缘。"""
    H, W = A.shape
    ri = np.clip(np.asarray(ri, np.float64), 0, H - 1)
    ci = np.clip(np.asarray(ci, np.float64), 0, W - 1)
    r0 = np.minimum(np.floor(ri).astype(np.int64), H - 2)
    c0 = np.minimum(np.floor(ci).astype(np.int64), W - 2)
    fr = (ri - r0).astype(np.float32)[:, None]
    fc = (ci - c0).astype(np.float32)[None, :]
    top = A[r0][:, c0] * (1 - fc) + A[r0][:, c0 + 1] * fc
    bot = A[r0 + 1][:, c0] * (1 - fc) + A[r0 + 1][:, c0 + 1] * fc
    return (top * (1 - fr) + bot * fr).astype(np.float32)


def terrarium_decode(rgb):
    rgb = rgb.astype(np.float32)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def terrarium_encode(h):
    q = np.round((h.astype(np.float64) + 32768) * 256).astype(np.int64)
    q = np.clip(q, 0, 256 ** 3 - 1)
    return np.stack([(q >> 16) & 255, (q >> 8) & 255, q & 255], axis=-1).astype(np.uint8)


def work_rc(lon, lat):
    """经纬度 -> 工作网格浮点 (行, 列)。"""
    return (LAT_TOP - np.asarray(lat)) * AS, (np.asarray(lon) - LON_LEFT) * AS


# ----------------------------------------------------------------------------- 1. Terrarium

class MercMosaic:
    """Web Mercator 瓦片拼接出的高程图（像素中心对齐）。"""

    def __init__(self, z, tx0, tx1, ty0, ty1, arr):
        self.z, self.tx0, self.tx1, self.ty0, self.ty1, self.a = z, tx0, tx1, ty0, ty1, arr

    def rc(self, lon, lat):
        n = 256 * 2 ** self.z
        px = (np.asarray(lon, np.float64) + 180) / 360 * n
        lr = np.radians(np.asarray(lat, np.float64))
        py = (1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / math.pi) / 2 * n
        return py - self.ty0 * 256 - 0.5, px - self.tx0 * 256 - 0.5

    def covers(self, lon, lat):
        r, c = self.rc(lon, lat)
        return (r >= 0) & (r <= self.a.shape[0] - 1) & (c >= 0) & (c <= self.a.shape[1] - 1)


def load_terrarium(bbox, z):
    tx0, tx1, ty0, ty1 = tilecache.tile_range(bbox, z)
    d = os.path.join(SRC, 'terrarium')
    jobs = []
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            jobs.append((TERRARIUM_URL.format(z=z, x=tx, y=ty), os.path.join(d, str(z), str(tx), f'{ty}.png')))
    tilecache.fetch_many(jobs, label=f'terrarium z{z}')
    arr = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            p = os.path.join(d, str(z), str(tx), f'{ty}.png')
            rgb = np.asarray(Image.open(p).convert('RGB'))
            arr[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = terrarium_decode(rgb)
    log(f'[terrarium z{z}] 拼接 {arr.shape[1]}×{arr.shape[0]}，范围 {arr.min():.0f}~{arr.max():.0f} m')
    return MercMosaic(z, tx0, tx1, ty0, ty1, arr)


def terrarium_on_workgrid(m_main, m_outer):
    lons = LON_LEFT + np.arange(NCOL) / AS
    lats = LAT_TOP - np.arange(NROW) / AS
    out = None
    for m in (m_outer, m_main):  # 后者覆盖前者
        r, _ = m.rc(np.full(NROW, geo.LON0), lats)
        _, c = m.rc(lons, np.full(NCOL, geo.LAT0))
        v = bilinear_sep(m.a, r, c)
        ok = ((r >= 0) & (r <= m.a.shape[0] - 1))[:, None] & ((c >= 0) & (c <= m.a.shape[1] - 1))[None, :]
        out = v if out is None else np.where(ok, v, out)
    return out


# ----------------------------------------------------------------------------- 2. FABDEM

def fetch_fabdem():
    d = os.path.join(SRC, 'fabdem')
    os.makedirs(d, exist_ok=True)
    names = [f'{t}_FABDEM_V1-2.tif' for t in FABDEM_TILES]
    if all(os.path.exists(os.path.join(d, n)) and os.path.getsize(os.path.join(d, n)) > 1e6 for n in names):
        log('[fabdem] 4 块已缓存')
        return [os.path.join(d, n) for n in names]
    import requests
    h = requests.head(FABDEM_URL, headers={'User-Agent': tilecache.UA}, timeout=60, allow_redirects=True)
    size = int(h.headers.get('Content-Length', '0'))
    log(f'[fabdem] HEAD {h.status_code} 大小 {size / 1e9:.2f} GB，Accept-Ranges={h.headers.get("Accept-Ranges")}')
    if h.status_code != 200 or size <= 0 or size > FABDEM_MAX_BYTES:
        raise RuntimeError('FABDEM 不可用或超过 3 GB')
    try:
        from remotezip import RemoteZip
        with RemoteZip(FABDEM_URL, headers={'User-Agent': tilecache.UA}) as z:
            for n in names:
                if os.path.exists(os.path.join(d, n)) and os.path.getsize(os.path.join(d, n)) > 1e6:
                    continue
                t = time.time()
                z.extract(n, d)
                log(f'[fabdem] 抽取 {n} {os.path.getsize(os.path.join(d, n)) / 1e6:.1f} MB {time.time() - t:.0f}s')
    except ImportError:
        # 无 remotezip：整包下载（≤3 GB）再解压
        import zipfile
        zp = os.path.join(d, 'fabdem.zip')
        tilecache.fetch(FABDEM_URL, zp, timeout=3600)
        with zipfile.ZipFile(zp) as z:
            for n in names:
                z.extract(n, d)
    return [os.path.join(d, n) for n in names]


def fabdem_on_workgrid(paths):
    import tifffile
    out = np.full((NROW, NCOL), np.nan, np.float32)
    for p in paths:
        with tifffile.TiffFile(p) as t:
            pg = t.pages[0]
            a = pg.asarray().astype(np.float32)
            sx, sy, _ = pg.tags['ModelPixelScaleTag'].value
            _, _, _, lon0, lat0, _ = pg.tags['ModelTiepointTag'].value
            geokeys = pg.tags['GeoKeyDirectoryTag'].value
            nod = pg.tags.get('GDAL_NODATA')
            nodata = float(nod.value) if nod is not None else -9999.0
        # GTRasterTypeGeoKey(1025)：1=PixelIsArea（tiepoint 为像素角点），2=PixelIsPoint（tiepoint 为像素中心）
        kv = {geokeys[i]: geokeys[i + 3] for i in range(4, len(geokeys), 4)}
        if kv.get(1025, 1) == 1:
            lon0 += sx / 2
            lat0 -= sy / 2
        assert abs(sx * AS - 1) < 1e-6 and abs(sy * AS - 1) < 1e-6, '非 1 角秒 FABDEM'
        a[a <= nodata + 1] = np.nan
        r_off = int(round((LAT_TOP - lat0) * AS))
        c_off = int(round((lon0 - LON_LEFT) * AS))
        # 源 [0,h) 对应目标 [r_off, r_off+h)
        tr0, tr1 = max(0, r_off), min(NROW, r_off + a.shape[0])
        tc0, tc1 = max(0, c_off), min(NCOL, c_off + a.shape[1])
        if tr0 >= tr1 or tc0 >= tc1:
            continue
        blk = a[tr0 - r_off:tr1 - r_off, tc0 - c_off:tc1 - c_off]
        tgt = out[tr0:tr1, tc0:tc1]
        np.copyto(tgt, blk, where=~np.isnan(blk))
        log(f'[fabdem] {os.path.basename(p)} -> 行 {tr0}:{tr1} 列 {tc0}:{tc1}')
    return out


# ----------------------------------------------------------------------------- 3a. 去建筑（形态学）

def dsm_filter(F, window_m=200.0, max_elev=700.0, relief_max=30.0, smooth_m=35.0):
    """平原区形态学开运算 + 高斯平滑。返回 (滤波后, 平原权重)。"""
    ry = max(1, int(round(window_m / 2 / PX_M_Y)))
    rx = max(1, int(round(window_m / 2 / PX_M_X)))
    yy, xx = np.ogrid[-ry:ry + 1, -rx:rx + 1]
    fp = (yy / (ry + 0.5)) ** 2 + (xx / (rx + 0.5)) ** 2 <= 1.0
    t = time.time()
    O = ndi.grey_opening(F, footprint=fp)
    ky, kx = int(round(1000 / PX_M_Y)) | 1, int(round(1000 / PX_M_X)) | 1
    relief = ndi.maximum_filter(O, size=(ky, kx)) - ndi.minimum_filter(O, size=(ky, kx))
    plain = ((O < max_elev) & (relief < relief_max)).astype(np.float32)
    # 权重羽化（~250 m），避免平原/山地交界出现台阶
    w = np.clip(ndi.gaussian_filter(plain, sigma=(250 / PX_M_Y, 250 / PX_M_X)) * 1.5 - 0.25, 0, 1)
    w = np.minimum(w, plain + ndi.gaussian_filter(plain, sigma=(120 / PX_M_Y, 120 / PX_M_X)))
    w = np.clip(w, 0, 1)
    S = ndi.gaussian_filter(O, sigma=(smooth_m / PX_M_Y, smooth_m / PX_M_X))
    out = F * (1 - w) + S * w
    log(f'[dsm] 开运算窗口 {2 * ry + 1}×{2 * rx + 1} px（≈{window_m:.0f} m），平原占比 {plain.mean() * 100:.1f}%，'
        f'削去量 p50/p99/max = {np.percentile(F - out, 50):.2f}/{np.percentile(F - out, 99):.2f}/{(F - out).max():.1f} m，'
        f'{time.time() - t:.1f}s')
    return out.astype(np.float32), w


# ----------------------------------------------------------------------------- 3b. 水面平整

def overpass_water():
    """分块取 OUTER 内 OSM 水体面，缓存到 data-src/dem/osm/。返回 [(tags, shapely 多边形(经纬度))...]。"""
    # 已经由本项目的矢量管线生成水系时，优先复用完整本地几何，避免重复请求 Overpass。
    # build_data.py 会把 OSM 的水面关系投影进统一米制坐标；这里反投影回经纬度供 DEM 掩膜使用。
    vector_path = os.path.join(OUT, 'water.json')
    if os.path.exists(vector_path):
        from shapely.geometry import Polygon, LineString
        with open(vector_path, encoding='utf-8') as f:
            water_data = json.load(f)

        def lonlat_ring(values):
            return [geo.unproject(values[i], values[i + 1]) for i in range(0, len(values) - 1, 2)]

        local = []
        for feature in water_data.get('polys', []):
            outer = feature.get('outer', [])
            if len(outer) < 6:
                continue
            holes = [lonlat_ring(ring) for ring in feature.get('holes', []) if len(ring) >= 6]
            try:
                poly = Polygon(lonlat_ring(outer), holes)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty:
                    continue
                kind = feature.get('k')
                tags = {'name': feature.get('n', '')}
                if kind == 'river':
                    tags['waterway'] = 'riverbank'
                elif kind == 'reservoir':
                    tags['water'] = 'reservoir'
                else:
                    tags['natural'] = 'water'
                local.append((tags, poly))
            except Exception:
                continue
        for feature in water_data.get('lines', []):
            points = feature.get('p', [])
            if len(points) < 4:
                continue
            try:
                width = max(float(feature.get('w') or 18), 520 if feature.get('n') == '渭河' else 18)
                world = LineString([(points[i], points[i + 1]) for i in range(0, len(points) - 1, 2)]).buffer(width / 2)
                geoms = getattr(world, 'geoms', [world])
                for shape in geoms:
                    if shape.geom_type != 'Polygon':
                        continue
                    tags = {'name': feature.get('n', ''), 'waterway': 'riverbank'}
                    poly = Polygon(lonlat_ring([v for xy in shape.exterior.coords for v in xy]))
                    if not poly.is_empty:
                        local.append((tags, poly))
            except Exception:
                continue
        if local:
            log(f'[water] 复用本地矢量水面 {len(local)} 个')
            return local

    import requests
    from shapely.geometry import Polygon, LineString
    from shapely.ops import polygonize, unary_union
    d = os.path.join(SRC, 'osm')
    os.makedirs(d, exist_ok=True)
    w, s, e, n = geo.BOUNDS['OUTER']
    nx, ny = 2, 2
    elements = {}
    for iy in range(ny):
        for ix in range(nx):
            bb = (s + (n - s) * iy / ny, w + (e - w) * ix / nx, s + (n - s) * (iy + 1) / ny, w + (e - w) * (ix + 1) / nx)
            p = os.path.join(d, f'water_{iy}_{ix}.json')
            if not (os.path.exists(p) and os.path.getsize(p) > 100):
                bbs = ','.join(f'{v:.4f}' for v in bb)
                q = f"""[out:json][timeout:240];
(
  way["natural"="water"]({bbs});
  relation["natural"="water"]({bbs});
  way["waterway"="riverbank"]({bbs});
  relation["waterway"="riverbank"]({bbs});
  way["landuse"="reservoir"]({bbs});
  relation["landuse"="reservoir"]({bbs});
);
out geom;"""
                for a in range(8):
                    try:
                        r = requests.post(OVERPASS_URL, data={'data': q}, headers={'User-Agent': tilecache.UA}, timeout=300)
                        if r.status_code == 200 and r.content.strip().startswith(b'{'):
                            js = r.json()
                            if 'remark' in js and 'error' in js['remark'].lower():
                                raise RuntimeError(js['remark'])
                            with open(p, 'w', encoding='utf-8') as f:
                                json.dump(js, f)
                            break
                        raise RuntimeError(f'HTTP {r.status_code}')
                    except Exception as ex:  # noqa: BLE001
                        wait = min(120, 10 * 2 ** a)
                        log(f'[osm] 块 {iy},{ix} 第 {a + 1} 次失败：{ex}，{wait}s 后重试')
                        time.sleep(wait)
                else:
                    raise RuntimeError('Overpass 多次失败')
            with open(p, encoding='utf-8') as f:
                for el in json.load(f).get('elements', []):
                    elements[(el['type'], el['id'])] = el
    polys = []
    for (typ, _id), el in elements.items():
        tags = el.get('tags', {})
        try:
            if typ == 'way':
                g = el.get('geometry') or []
                if len(g) < 4 or (g[0]['lat'], g[0]['lon']) != (g[-1]['lat'], g[-1]['lon']):
                    continue
                poly = Polygon([(q['lon'], q['lat']) for q in g])
            else:
                outer, inner = [], []
                for m in el.get('members', []):
                    if m.get('type') != 'way' or not m.get('geometry'):
                        continue
                    ls = LineString([(q['lon'], q['lat']) for q in m['geometry']])
                    (inner if m.get('role') == 'inner' else outer).append(ls)
                po = list(polygonize(unary_union(outer))) if outer else []
                if not po:
                    continue
                poly = unary_union(po)
                if inner:
                    pi = list(polygonize(unary_union(inner)))
                    if pi:
                        poly = poly.difference(unary_union(pi))
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty:
                continue
            polys.append((tags, poly))
        except Exception:  # noqa: BLE001
            continue
    log(f'[osm] 水体面 {len(polys)} 个（元素 {len(elements)}）')
    return polys


def _world_metrics(poly):
    from shapely.ops import transform
    pw = transform(lambda x, y, z=None: geo_project_arr(x, y), poly)
    return pw.area, pw.length


def geo_project_arr(lon, lat):
    lon = np.asarray(lon, np.float64)
    lat = np.asarray(lat, np.float64)
    x = (geo.R * np.radians(lon) - geo.MX0) * geo.K
    z = -(geo.R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) - geo.MY0) * geo.K
    return x, z


def _draw_poly(draw, poly, val_ext, val_hole):
    geoms = getattr(poly, 'geoms', [poly])
    for g in geoms:
        if g.geom_type != 'Polygon':
            continue
        r, c = work_rc(*np.asarray(g.exterior.coords).T)
        draw.polygon(list(zip((c + 0.5).tolist(), (r + 0.5).tolist())), fill=val_ext)
        for h in g.interiors:
            r, c = work_rc(*np.asarray(h.coords).T)
            draw.polygon(list(zip((c + 0.5).tolist(), (r + 0.5).tolist())), fill=val_hole)


RIVER_TAGS = {'river', 'canal', 'stream', 'riverbank', 'oxbow', 'ditch', 'drain'}


def flatten_water(F, polys, min_area=30000.0, min_width=50.0):
    """返回 (平整后 F, 河道掩膜, 湖泊标签图, 统计信息)。"""
    lakes, rivers = [], []
    for tags, poly in polys:
        area, perim = _world_metrics(poly)
        if area < min_area or perim <= 0:
            continue
        width = 2 * area / perim
        if width < min_width:
            continue
        elong = perim ** 2 / (4 * math.pi * area)
        is_river = (tags.get('water') in RIVER_TAGS or tags.get('waterway') == 'riverbank' or elong > 14)
        rec = {'name': tags.get('name:zh') or tags.get('name') or '', 'area': area, 'width': width, 'poly': poly,
               'tags': tags}
        (rivers if is_river else lakes).append(rec)
    log(f'[water] 参与平整：河道面 {len(rivers)} 个，湖库面 {len(lakes)} 个（面积≥{min_area / 1e4:.0f} 公顷且平均宽≥{min_width:.0f} m）')

    # ---- 河道：沿程平滑的下包络水位
    im = Image.new('L', (NCOL, NROW), 0)
    dr = ImageDraw.Draw(im)
    for rec in rivers:
        _draw_poly(dr, rec['poly'], 1, 0)
    rmask = np.asarray(im, bool)
    # 渭河名单（仅用于统计输出）
    imw = Image.new('L', (NCOL, NROW), 0)
    drw = ImageDraw.Draw(imw)
    for rec in rivers:
        if '渭河' in rec['name']:
            _draw_poly(drw, rec['poly'], 1, 0)
    weimask = np.asarray(imw, bool)

    out = F.copy()
    stats = {}
    if rmask.any():
        sig = (900 / PX_M_Y, 900 / PX_M_X)
        m = rmask.astype(np.float32)
        den = ndi.gaussian_filter(m, sig)
        h = np.where(rmask, F, 0).astype(np.float32)
        L = ndi.gaussian_filter(h * m, sig) / np.maximum(den, 1e-6)
        for _ in range(5):  # 迭代压向下包络：高于当前水位的沙洲/桥梁/堤不参与
            h2 = np.where(rmask, np.minimum(F, L + 0.3), 0)
            L = ndi.gaussian_filter(h2 * m, sig) / np.maximum(den, 1e-6)
        rdil = ndi.binary_dilation(rmask, iterations=1)
        ok = rdil & (den > 1e-4)
        out[ok] = L[ok]
        stats['river_px'] = int(rmask.sum())
        if weimask.any():
            wl = L[weimask]
            stats['weihe'] = [float(np.percentile(wl, 2)), float(np.median(wl)), float(np.percentile(wl, 98))]
            log(f'[water] 渭河水面 p2/中位/p98 = {stats["weihe"][0]:.1f}/{stats["weihe"][1]:.1f}/{stats["weihe"][2]:.1f} m')
    else:
        rdil = rmask

    # ---- 湖库：单一水位（多边形内 15% 分位数，先内缩 1 像素避开岸坡）
    lakes.sort(key=lambda r: -r['area'])
    lab = Image.new('I', (NCOL, NROW), 0)
    dl = ImageDraw.Draw(lab)
    for i, rec in enumerate(lakes, 1):
        _draw_poly(dl, rec['poly'], i, 0)
    lab = np.asarray(lab, np.int32)
    objs = ndi.find_objects(lab)
    nlake = 0
    for i, sl in enumerate(objs, 1):
        if sl is None:
            continue
        sl2 = tuple(slice(max(0, s.start - 2), min(dim, s.stop + 2)) for s, dim in zip(sl, lab.shape))
        mk = lab[sl2] == i
        core = ndi.binary_erosion(mk, iterations=1)
        vals = F[sl2][core if core.sum() >= 4 else mk]
        if vals.size == 0:
            continue
        level = float(np.percentile(vals, 15))
        dil = ndi.binary_dilation(mk, iterations=1) & ~rdil[sl2]
        blk = out[sl2]
        blk[dil] = level
        lakes[i - 1]['level'] = level
        nlake += 1
    named = [(r['name'], round(r['level'], 1)) for r in lakes[:12] if r.get('name') and 'level' in r]
    log(f'[water] 湖库平整 {nlake} 个，前几个：{named}')
    stats['lakes'] = nlake
    return out.astype(np.float32), rmask, weimask, stats


# ----------------------------------------------------------------------------- 4. 重采样到 Mercator 网格

def world_bounds(bbox):
    w, s, e, n = bbox
    x0, z0 = geo.project(w, n)
    x1, z1 = geo.project(e, s)
    return {'x0': round(x0, 1), 'x1': round(x1, 1), 'z0': round(z0, 1), 'z1': round(z1, 1)}


def resample(F, b, w, h):
    """F: 工作网格；b: 世界坐标 bounds；输出 h×w（像素中心对齐 Mercator）。按降采样倍数做高斯预滤波。"""
    xs = b['x0'] + (np.arange(w) + 0.5) * (b['x1'] - b['x0']) / w
    zs = b['z0'] + (np.arange(h) + 0.5) * (b['z1'] - b['z0']) / h
    lons = np.array([geo.unproject(x, 0)[0] for x in xs])
    lats = np.array([geo.unproject(0, z)[1] for z in zs])
    dx = (b['x1'] - b['x0']) / w
    dz = (b['z1'] - b['z0']) / h
    ratio_x = dx / PX_M_X
    ratio_y = dz / PX_M_Y
    sig = (max(0.0, 0.45 * ratio_y - 0.25), max(0.0, 0.45 * ratio_x - 0.25))
    G = ndi.gaussian_filter(F, sig) if max(sig) > 0.05 else F
    r, c = work_rc(lons, lats)
    return bilinear_sep(G, r, c), lons, lats, (dx, dz)


# ----------------------------------------------------------------------------- 5. 预览

def hillshade(Hm, dx, dz, az=315.0, alt=45.0, exag=1.0):
    gy, gx = np.gradient(Hm.astype(np.float64) * exag, dz, dx)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    azr, altr = math.radians(360 - az + 90), math.radians(alt)
    hs = np.sin(altr) * np.cos(slope) + np.cos(altr) * np.sin(slope) * np.cos(azr - aspect)
    return np.clip(hs, 0, 1)


def sample_dem_png(path, b, lon, lat):
    im = np.asarray(Image.open(path).convert('RGB'))
    Hm = terrarium_decode(im)
    h, w = Hm.shape
    x, z = geo.project(lon, lat)
    i = (x - b['x0']) / (b['x1'] - b['x0']) * w - 0.5
    j = (z - b['z0']) / (b['z1'] - b['z0']) * h - 0.5
    return float(bilinear_sep(Hm, [j], [i])[0, 0])


def make_previews(main_png, mb, T_main_grid, stats):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib import colors
    plt.rcParams['font.sans-serif'] = ['PingFang SC', 'Heiti SC', 'Arial Unicode MS', 'STHeiti', 'DejaVu Sans']
    plt.rcParams['axes.unicode_minus'] = False

    Hm = terrarium_decode(np.asarray(Image.open(main_png).convert('RGB')))
    h, w = Hm.shape
    dx = (mb['x1'] - mb['x0']) / w
    dz = (mb['z1'] - mb['z0']) / h
    hs = hillshade(Hm, dx, dz, exag=2.0)
    norm = colors.Normalize(vmin=340, vmax=1600)
    cm = plt.get_cmap('terrain')(norm(Hm))[..., :3]
    rgb = cm * (0.35 + 0.65 * hs[..., None])

    pts = [('钟楼', 108.9423419, 34.2610119), ('大雁塔', 108.9642, 34.2197), ('咸阳机场', 108.752, 34.447),
           ('草滩渭河', 108.935, 34.402), ('咸阳渭河', 108.705, 34.325), ('翠华山', 109.004, 34.012),
           ('白鹿原', 109.17, 34.20), ('临潼骊山', 109.23, 34.35)]
    ext = (mb['x0'] / 1000, mb['x1'] / 1000, mb['z1'] / 1000, mb['z0'] / 1000)
    fig, ax = plt.subplots(figsize=(13, 15), dpi=110)
    ax.imshow(rgb, extent=ext, interpolation='bilinear')
    for name, lon, lat in pts:
        x, z = geo.project(lon, lat)
        v = sample_dem_png(main_png, mb, lon, lat)
        ax.plot(x / 1000, z / 1000, 'o', ms=5, mec='k', mfc='red')
        ax.annotate(f'{name} {v:.0f}m', (x / 1000, z / 1000), xytext=(6, 4), textcoords='offset points', fontsize=11,
                    color='k', bbox=dict(boxstyle='round,pad=0.2', fc='white', alpha=0.8, lw=0))
    ax.invert_yaxis()
    ax.set_xlabel('世界 X / km（东）')
    ax.set_ylabel('世界 Z / km（南）')
    wh = stats.get('weihe')
    ax.set_title(f'dem_main 阴影地形（垂直×2）  渭河水面 {wh[0]:.0f}~{wh[2]:.0f} m' if wh else 'dem_main 阴影地形')
    sm = plt.cm.ScalarMappable(norm=norm, cmap='terrain')
    fig.colorbar(sm, ax=ax, fraction=0.03, pad=0.01, label='海拔 m')
    fig.tight_layout()
    p1 = os.path.join(SRC, 'preview_main.png')
    fig.savefig(p1)
    plt.close(fig)

    # 城区近景：强垂直夸张，检查建筑鼓包；与 Terrarium(DSM) 对比
    cb = geo.BOUNDS['CORE']
    cx0, cz0 = geo.project(cb[0], cb[3])
    cx1, cz1 = geo.project(cb[2], cb[1])
    i0, i1 = int((cx0 - mb['x0']) / dx), int((cx1 - mb['x0']) / dx)
    j0, j1 = int((cz0 - mb['z0']) / dz), int((cz1 - mb['z0']) / dz)
    sub = Hm[j0:j1, i0:i1]
    Tsub = T_main_grid[j0:j1, i0:i1] if T_main_grid is not None else None
    fig, axs = plt.subplots(1, 2 if Tsub is not None else 1, figsize=(20, 11), dpi=100)
    axs = np.atleast_1d(axs)
    e2 = (cx0 / 1000, cx1 / 1000, cz1 / 1000, cz0 / 1000)
    for ax, arr, title in zip(axs, [sub, Tsub], ['本管线 DTM（垂直×8）', 'Terrarium 原始 DSM（垂直×8）']):
        if arr is None:
            continue
        hs2 = hillshade(arr, dx, dz, exag=8.0)
        n2 = colors.Normalize(vmin=np.percentile(sub, 1), vmax=np.percentile(sub, 99.5))
        c2 = plt.get_cmap('gist_earth')(n2(arr))[..., :3] * (0.3 + 0.7 * hs2[..., None])
        ax.imshow(np.clip(c2, 0, 1), extent=e2)
        ax.invert_yaxis()
        ax.set_title(title)
        for name, lon, lat in pts[:2]:
            x, z = geo.project(lon, lat)
            ax.plot(x / 1000, z / 1000, 'o', ms=5, mec='k', mfc='red')
            ax.annotate(name, (x / 1000, z / 1000), xytext=(5, 3), textcoords='offset points', fontsize=11)
    fig.tight_layout()
    p2 = os.path.join(SRC, 'preview_core.png')
    fig.savefig(p2)
    plt.close(fig)
    log(f'[preview] {p1}\n[preview] {p2}')


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', choices=['auto', 'fabdem', 'terrarium'], default='auto')
    ap.add_argument('--main-size', type=int, default=2048)
    ap.add_argument('--outer-size', type=int, default=1024)
    ap.add_argument('--window', type=float, default=None, help='开运算窗口（米），默认 FABDEM 150 / Terrarium 200')
    ap.add_argument('--no-water', action='store_true')
    ap.add_argument('--no-preview', action='store_true')
    args = ap.parse_args()
    os.makedirs(SRC, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    log(f'工作网格 {NCOL}×{NROW}（1″，{PX_M_X:.1f}×{PX_M_Y:.1f} m）')

    # 1. Terrarium
    m_main = load_terrarium(geo.BOUNDS['MAIN'], 12)
    m_outer = load_terrarium(geo.BOUNDS['OUTER'], 11)
    T = terrarium_on_workgrid(m_main, m_outer)

    # 2. FABDEM
    source = 'terrarium'
    F = None
    if args.source in ('auto', 'fabdem'):
        try:
            F = fabdem_on_workgrid(fetch_fabdem())
            nan = np.isnan(F)
            if nan.mean() > 0.2:
                raise RuntimeError(f'FABDEM 覆盖不足（空洞 {nan.mean() * 100:.1f}%）')
            if nan.any():
                log(f'[fabdem] 空洞 {nan.sum()} 像素，用 Terrarium 填补')
                F[nan] = T[nan]
            source = 'fabdem'
            cr0, cc0 = work_rc(geo.BOUNDS['CORE'][0], geo.BOUNDS['CORE'][3])
            cr1, cc1 = work_rc(geo.BOUNDS['CORE'][2], geo.BOUNDS['CORE'][1])
            d = (T - F)[int(cr0):int(cr1), int(cc0):int(cc1)]
            log(f'[对比] CORE 内 Terrarium(DSM) − FABDEM：中位 {np.median(d):.2f} m，p90 {np.percentile(d, 90):.2f} m，'
                f'p99 {np.percentile(d, 99):.2f} m')
        except Exception as e:  # noqa: BLE001
            if args.source == 'fabdem':
                raise
            log(f'[fabdem] 不可用，退化为 Terrarium：{e}')
            F = None
    if F is None:
        F = T.copy()

    # 3a. 去建筑
    window = args.window or (150.0 if source == 'fabdem' else 200.0)
    F, wplain = dsm_filter(F, window_m=window)

    # 3b. 水面
    stats = {}
    if not args.no_water:
        try:
            polys = overpass_water()
            F, rmask, weimask, stats = flatten_water(F, polys)
        except Exception as e:  # noqa: BLE001
            log(f'[water] 水面平整失败（跳过）：{e}')

    # 4. 输出
    entries = []
    T_main_out = None
    for name, key, size in [('dem_main.png', 'MAIN', args.main_size), ('dem_outer.png', 'OUTER', args.outer_size)]:
        bbox = geo.BOUNDS[key]
        b = world_bounds(bbox)
        Hm, lons, lats, (dx, dz) = resample(F, b, size, size)
        png = os.path.join(OUT, name)
        Image.fromarray(terrarium_encode(Hm), 'RGB').save(png, optimize=True)
        chk = terrarium_decode(np.asarray(Image.open(png).convert('RGB')))
        assert np.abs(chk - Hm).max() < 0.01
        log(f'[out] {name} {size}×{size} {os.path.getsize(png) / 1e6:.2f} MB，{dx:.1f}×{dz:.1f} m/px，'
            f'高程 {Hm.min():.1f}~{Hm.max():.1f} m')
        entries.append({'file': name, 'w': size, 'h': size, 'bounds': b, 'lonlat': list(bbox),
                        'mpp': [round(dx, 2), round(dz, 2)], 'encoding': 'terrarium',
                        'min': round(float(Hm.min()), 1), 'max': round(float(Hm.max()), 1)})
        if key == 'MAIN':
            T_main_out, _, _, _ = resample(T, b, size, size)

    src_list = ['© OpenStreetMap contributors']
    src_list += [SRC_FABDEM, SRC_TERRARIUM] if source == 'fabdem' else [SRC_TERRARIUM]
    tilecache.update_meta(META, {
        'origin': {'lat': geo.LAT0, 'lon': geo.LON0},
        'k': geo.K,
        'generated': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'dem': entries,
        'demInfo': {
            'source': source,
            'dtm': 'FABDEM（已去建筑/森林）+ 平原区形态学开运算' if source == 'fabdem' else 'Terrarium DSM + 平原区形态学开运算去建筑',
            'openingWindowM': window,
            'water': '大水体（OSM 河道面/湖库面，平均宽≥50 m）已平整到水面高度；河道沿程平滑下降',
            'weihe': [round(v, 1) for v in stats.get('weihe', [])],
        },
    }, merge_sources=src_list, drop_source_prefixes=('FABDEM', 'Terrain Tiles'))

    # 5. 核对
    mb = entries[0]['bounds']
    mp = os.path.join(OUT, 'dem_main.png')
    log('[核对] 钟楼 {:.1f} m（期望 400~410）'.format(sample_dem_png(mp, mb, 108.9423419, 34.2610119)))
    prof = [(lat, sample_dem_png(mp, mb, 108.95, lat)) for lat in np.arange(34.12, 33.949, -0.01)]
    log('[核对] 秦岭北麓剖面 lon=108.95：' + ', '.join(f'{lat:.2f}:{v:.0f}' for lat, v in prof))
    if not args.no_preview:
        make_previews(mp, mb, T_main_out, stats)
    log(f'完成，用时 {time.time() - t0:.0f}s，数据源 {source}')


if __name__ == '__main__':
    main()
