#!/usr/bin/env python3
"""CMAB 轮廓 ↔ Esri 卫星影像 / OSM 建筑的对齐检查（build_buildings_v2.py 的前置步骤 1）。

1. 目视：每个检查点下载 Esri World Imagery z17 瓦片拼图，叠加 CMAB 轮廓（红）与 OSM 建筑（青），
   输出 data-src/buildings_v2/align_<site>.jpg。
2. 定量：在若干 2 km 窗口内把 CMAB 与 OSM 建筑按 1 m 栅格化，做互相关求平移 (dx, dz)，
   结果写 data-src/buildings_v2/align_offsets.json（build_buildings_v2.py 读取后统一平移 CMAB）。
用法：.venv-tools/bin/python tools/buildings_v2_align.py [--shift dx dz]   （--shift 只影响叠加图，便于目视验证）
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import geo  # noqa: E402
import tilecache  # noqa: E402

ROOT = os.path.dirname(HERE)
OUTD = os.path.join(ROOT, 'data-src', 'buildings_v2')
TILED = os.path.join(OUTD, 'tiles')
ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

# 目视检查点（经纬度中心, 半宽 m）
SITES = {
    'belltower': (108.94234, 34.26101, 380),
    'southgate': (108.94260, 34.25185, 380),
    'bigpagoda': (108.95940, 34.21980, 420),
    'gaoxin_cbd': None,   # 用世界坐标给
    'qujiang': (108.9760, 34.2050, 450),
    'residential_n': (108.9400, 34.3300, 450),
}
SITES_WORLD = {'gaoxin_cbd': (-6050.0, 7350.0, 480)}


def load_cmab_rings():
    c = np.load(os.path.join(ROOT, 'data-src', 'heights', 'cmab_xian.npz'))
    x, z, po, ppo, h = c['x'], c['z'], c['part_off'], c['poly_part_off'], c['h']   # npz 每次取键都会重新解压，先取出
    rings, hs = [], []
    for i in range(len(ppo) - 1):
        a, b = po[ppo[i]], po[ppo[i] + 1]
        rx, rz = x[a:b], z[a:b]
        if b - a < 4 or np.abs(rx).max() > 2e5 or np.abs(rz).max() > 2e5:
            continue
        rings.append(np.c_[rx, rz].astype(np.float64))
        hs.append(h[i])
    return rings, np.array(hs)


def load_osm_rings():
    fn = os.path.join(OUTD, 'osm_buildings_main.json')
    if not os.path.exists(fn):
        fn = os.path.join(ROOT, 'data-src', 'heights', 'raw', 'osm', 'osm_box_all.json')
    d = json.load(open(fn))
    rings = []
    for e in d['elements']:
        if e['type'] == 'way':
            g = [e.get('geometry') or []]
        else:
            g = [m['geometry'] for m in e.get('members', []) if m.get('role') == 'outer']
        for gg in g:
            if len(gg) < 4:
                continue
            ll = np.array([(p['lon'], p['lat']) for p in gg])
            mx = geo.R * np.radians(ll[:, 0])
            my = geo.R * np.log(np.tan(np.pi / 4 + np.radians(ll[:, 1]) / 2))
            rings.append(np.c_[(mx - geo.MX0) * geo.K, -(my - geo.MY0) * geo.K])
    return rings


def mosaic(cx, cz, half, z=17):
    """返回 (PIL 图, world->pixel 函数)。"""
    lon0, lat0 = geo.unproject(cx - half, cz - half)   # 西北
    lon1, lat1 = geo.unproject(cx + half, cz + half)   # 东南
    fx0, fy0 = geo.lonlat_to_tile(lon0, lat0, z)
    fx1, fy1 = geo.lonlat_to_tile(lon1, lat1, z)
    tx0, tx1, ty0, ty1 = int(fx0), int(fx1), int(fy0), int(fy1)
    jobs = []
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            jobs.append((ESRI.format(z=z, x=tx, y=ty), os.path.join(TILED, str(z), str(tx), f'{ty}.jpg')))
    tilecache.fetch_many(jobs, label=f'z{z}')
    W = (tx1 - tx0 + 1) * 256
    H = (ty1 - ty0 + 1) * 256
    img = Image.new('RGB', (W, H))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            p = os.path.join(TILED, str(z), str(tx), f'{ty}.jpg')
            try:
                img.paste(Image.open(p).convert('RGB'), ((tx - tx0) * 256, (ty - ty0) * 256))
            except Exception:  # noqa: BLE001
                pass
    mx0, _, _, my1 = geo.tile_merc_bounds(z, tx0, ty0)
    res = 2 * math.pi * geo.R / (2 ** z) / 256   # 墨卡托米/像素

    def w2p(wx, wz):
        mx = np.asarray(wx) / geo.K + geo.MX0
        my = -np.asarray(wz) / geo.K + geo.MY0
        return (mx - mx0) / res, (my1 - my) / res
    # 裁到窗口
    px0, py0 = w2p(cx - half, cz - half)
    px1, py1 = w2p(cx + half, cz + half)
    box = tuple(int(round(v)) for v in (px0, py0, px1, py1))
    img = img.crop(box)

    def w2p_c(wx, wz):
        a, b = w2p(wx, wz)
        return a - box[0], b - box[1]
    return img, w2p_c


def overlay(name, cx, cz, half, cmab, osm, shift=(0.0, 0.0)):
    img, w2p = mosaic(cx, cz, half)
    img = img.convert('RGBA')
    lay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    bb = (cx - half - 50, cz - half - 50, cx + half + 50, cz + half + 50)

    def inside(r):
        return r[:, 0].max() > bb[0] and r[:, 0].min() < bb[2] and r[:, 1].max() > bb[1] and r[:, 1].min() < bb[3]
    for r in osm:
        if inside(r):
            px, py = w2p(r[:, 0], r[:, 1])
            d.line(list(zip(px, py)) + [(px[0], py[0])], fill=(0, 255, 255, 230), width=1)
    for r in cmab:
        if inside(r):
            px, py = w2p(r[:, 0] + shift[0], r[:, 1] + shift[1])
            d.line(list(zip(px, py)) + [(px[0], py[0])], fill=(255, 40, 40, 255), width=2)
    out = Image.alpha_composite(img, lay).convert('RGB')
    d2 = ImageDraw.Draw(out)
    d2.rectangle((0, 0, 330, 18), fill=(0, 0, 0))
    d2.text((4, 3), f'{name}  red=CMAB  cyan=OSM  shift={shift}', fill=(255, 255, 255))
    fn = os.path.join(OUTD, f'align_{name}.jpg')
    out.save(fn, quality=88)
    print('写出', fn, out.size)


def raster(rings, x0, z0, n, res=1.0):
    from PIL import Image as Im
    im = Im.new('L', (n, n), 0)
    d = ImageDraw.Draw(im)
    for r in rings:
        px = (r[:, 0] - x0) / res
        pz = (r[:, 1] - z0) / res
        if px.max() < 0 or pz.max() < 0 or px.min() > n or pz.min() > n:
            continue
        d.polygon(list(zip(px, pz)), fill=1)
    return np.asarray(im, np.float32)


def xcorr_offset(cmab, osm, cx, cz, half=1000, maxs=40):
    """返回使 CMAB 平移 (dx,dz) 后与 OSM 重叠最大的平移量及峰值质量。"""
    n = int(2 * half)
    x0, z0 = cx - half, cz - half
    A = raster(cmab, x0, z0, n)
    B = raster(osm, x0, z0, n)
    if A.sum() < 2000 or B.sum() < 2000:
        return None
    Am, Bm = A - A.mean(), B - B.mean()
    F = np.fft.rfft2(Bm) * np.conj(np.fft.rfft2(Am))
    cc = np.fft.irfft2(F, s=A.shape)
    cc = np.fft.fftshift(cc)
    c0 = n // 2
    win = cc[c0 - maxs:c0 + maxs + 1, c0 - maxs:c0 + maxs + 1]
    iz, ix = np.unravel_index(np.argmax(win), win.shape)
    dz, dx = iz - maxs, ix - maxs
    # 亚像素：抛物线
    def sub(a, b, c):
        den = a - 2 * b + c
        return 0.0 if den == 0 else 0.5 * (a - c) / den
    if 0 < ix < win.shape[1] - 1:
        dx += sub(win[iz, ix - 1], win[iz, ix], win[iz, ix + 1])
    if 0 < iz < win.shape[0] - 1:
        dz += sub(win[iz - 1, ix], win[iz, ix], win[iz + 1, ix])
    inter0 = (A * B).sum()
    iou0 = inter0 / max(1.0, (A + B - A * B).sum())
    return dict(dx=float(dx), dz=float(dz), peak=float(win.max() / max(1e-9, win.mean())),
                iou0=float(iou0), cmab_px=int(A.sum()), osm_px=int(B.sum()))


def main():
    shift = (0.0, 0.0)
    if '--shift' in sys.argv:
        i = sys.argv.index('--shift')
        shift = (float(sys.argv[i + 1]), float(sys.argv[i + 2]))
    os.makedirs(OUTD, exist_ok=True)
    cmab, _ = load_cmab_rings()
    osm = load_osm_rings()
    print('CMAB 环', len(cmab), 'OSM 环', len(osm))
    sites = {}
    for k, v in SITES.items():
        if v is not None:
            x, z = geo.project(v[0], v[1])
            sites[k] = (x, z, v[2])
    sites.update(SITES_WORLD)
    if '--no-img' not in sys.argv:
        for k, (x, z, h) in sites.items():
            overlay(k, x, z, h, cmab, osm, shift)
    # 定量互相关：城内/各方向若干 2 km 窗口
    wins = {'wall': (0, -500), 'gaoxin': (-6000, 6500), 'qujiang': (3000, 5500), 'north': (-300, -7000),
            'east': (6000, -500), 'west': (-7000, -500), 'south': (-1000, 9000), 'xianyang': (-22000, -3500),
            'weiyang': (-500, -11000), 'changan': (-2000, 17000)}
    res = {}
    for k, (x, z) in wins.items():
        r = xcorr_offset(cmab, osm, x, z)
        res[k] = r
        print(f'  {k:10s}', r)
    good = [r for r in res.values() if r and r['osm_px'] > 30000 and r['peak'] > 3]
    if good:
        med = (float(np.median([r['dx'] for r in good])), float(np.median([r['dz'] for r in good])))
    else:
        med = (0.0, 0.0)
    print('中位偏移（CMAB→OSM）', med)
    json.dump({'windows': res, 'median_shift_cmab_to_osm': med}, open(os.path.join(OUTD, 'align_offsets.json'), 'w'),
              ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
