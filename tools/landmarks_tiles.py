"""历史地标调研：Esri World Imagery 瓦片拼图 + 世界坐标叠加绘制（目视核对用）。

from landmarks_tiles import mosaic
img, wb = mosaic(lon0, lat0, lon1, lat1, z)   # wb = (x0, z0, x1, z1) 世界坐标边界
to_px = lambda x, z: ((x - wb[0]) / (wb[2] - wb[0]) * img.width, (z - wb[1]) / (wb[3] - wb[1]) * img.height)
"""
import io
import math
import os
import time

import requests
from PIL import Image

from geo import lonlat_to_tile, tile_merc_bounds, merc_to_world

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'data-src', 'landmarks_historic', 'tiles')
URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
UA = {'User-Agent': 'xian3d-research/1.0'}
_sess = requests.Session()


def tile(z, x, y):
    p = os.path.join(CACHE, str(z), str(x), f'{y}.jpg')
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return Image.open(p).convert('RGB')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    for i in range(6):
        try:
            r = _sess.get(URL.format(z=z, x=x, y=y), headers=UA, timeout=30)
            if r.status_code == 200:
                with open(p, 'wb') as f:
                    f.write(r.content)
                return Image.open(io.BytesIO(r.content)).convert('RGB')
        except Exception:
            pass
        time.sleep(2 * (i + 1))
    return Image.new('RGB', (256, 256), (255, 0, 255))


def mosaic(lon0, lat0, lon1, lat1, z):
    fx0, fy0 = lonlat_to_tile(lon0, lat1, z)   # 西北
    fx1, fy1 = lonlat_to_tile(lon1, lat0, z)   # 东南
    tx0, ty0, tx1, ty1 = int(fx0), int(fy0), int(fx1), int(fy1)
    img = Image.new('RGB', ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            img.paste(tile(z, tx, ty), ((tx - tx0) * 256, (ty - ty0) * 256))
    mx0, _, _, my1 = tile_merc_bounds(z, tx0, ty0)
    _, my0, mx1, _ = tile_merc_bounds(z, tx1, ty1)
    x0, z0 = merc_to_world(mx0, my1)
    x1, z1 = merc_to_world(mx1, my0)
    return img, (x0, z0, x1, z1)


def world_crop(img, wb, cx, cz, half):
    """按世界坐标中心/半宽裁剪，返回 (子图, 子图世界边界)。"""
    sx = img.width / (wb[2] - wb[0])
    sz = img.height / (wb[3] - wb[1])
    l = int((cx - half - wb[0]) * sx); r = int((cx + half - wb[0]) * sx)
    t = int((cz - half - wb[1]) * sz); b = int((cz + half - wb[1]) * sz)
    sub = img.crop((l, t, r, b))
    return sub, (wb[0] + l / sx, wb[1] + t / sz, wb[0] + r / sx, wb[1] + b / sz)
