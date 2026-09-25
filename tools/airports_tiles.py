"""机场核对用 Esri World Imagery 瓦片下载 + 拼图。
用法: python tools/airports_tiles.py <name> <z> <west> <south> <east> <north>
输出: data-src/airports_research/tiles/z{z}/{x}_{y}.jpg 与 mosaic_<name>_z{z}.jpg + .json(世界坐标 bounds)
"""
import io, json, math, os, sys, time
import concurrent.futures as cf
import requests
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from geo import lonlat_to_tile, tile_merc_bounds, merc_to_world  # noqa

OUT = os.path.join(ROOT, 'data-src', 'airports_research')
URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
UA = 'xian3d-research/0.1'


def get(z, x, y):
    d = os.path.join(OUT, 'tiles', f'z{z}')
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, f'{x}_{y}.jpg')
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return p
    for a in range(6):
        try:
            r = requests.get(URL.format(z=z, x=x, y=y), headers={'User-Agent': UA}, timeout=30)
            if r.status_code == 200 and len(r.content) > 100:
                open(p, 'wb').write(r.content)
                return p
        except Exception:
            pass
        time.sleep(1.5 * (a + 1))
    return None


def main(name, z, w, s, e, n):
    x0, y0 = lonlat_to_tile(w, n, z)
    x1, y1 = lonlat_to_tile(e, s, z)
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    jobs = [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    print('瓦片数', len(jobs))
    with cf.ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda j: get(*j), jobs))
    print('失败', sum(r is None for r in res))
    W, H = (x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256
    im = Image.new('RGB', (W, H))
    for (zz, x, y), p in zip(jobs, res):
        if p:
            im.paste(Image.open(p).convert('RGB'), ((x - x0) * 256, (y - y0) * 256))
    mx0, _, _, my1 = tile_merc_bounds(z, x0, y0)
    _, my0, mx1, _ = tile_merc_bounds(z, x1, y1)
    wx0, wz0 = merc_to_world(mx0, my1)
    wx1, wz1 = merc_to_world(mx1, my0)
    out = os.path.join(OUT, f'mosaic_{name}_z{z}.jpg')
    im.save(out, quality=88)
    meta = {'file': out, 'w': W, 'h': H, 'bounds': {'x0': wx0, 'x1': wx1, 'z0': wz0, 'z1': wz1},
            'tiles': [x0, y0, x1, y1], 'z': z}
    json.dump(meta, open(out.replace('.jpg', '.json'), 'w'), indent=1)
    print(meta)


if __name__ == '__main__':
    a = sys.argv
    main(a[1], int(a[2]), *map(float, a[3:7]))
