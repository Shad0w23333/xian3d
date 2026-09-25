#!/usr/bin/env python3
"""矢量数据质量目检：Esri World Imagery 拼图 + public/data 矢量叠加。

用法：
  .venv-tools/bin/python tools/vector_check.py [视图名 ...] [--out 目录] [--layers water,roads,landuse]
不带视图名时输出全部预设视图。瓦片缓存在 data-src/vector_check/tiles/（并发 ≤ 8，带重试）。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import geo  # noqa: E402
import tilecache  # noqa: E402

URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
CACHE = ROOT / 'data-src' / 'vector_check' / 'tiles'
OTHER_CACHES = [ROOT / 'data-src' / 'landmarks_historic' / 'tiles', ROOT / 'data-src' / 'airports_research' / 'tiles']
DATA = ROOT / 'public' / 'data'

# 名称: (west, south, east, north, zoom)
VIEWS = {
    'weihe_caotan': (108.86, 34.37, 109.02, 34.45, 15),      # 渭河草滩段（西安北）
    'weihe_xianyang': (108.66, 34.30, 108.82, 34.38, 15),    # 渭河咸阳段
    'chanba_confluence': (109.00, 34.33, 109.16, 34.47, 15), # 浐灞交汇、灞河入渭
    'chanba_wide': (108.90, 34.25, 109.25, 34.50, 13),       # 东北侧全景（原错误蓝色区域）
    'qujiangchi': (108.978, 34.197, 108.998, 34.215, 17),    # 曲江池
    'xingqing': (108.965, 34.252, 108.985, 34.265, 17),      # 兴庆湖（兴庆宫公园）
    'moat': (108.915, 34.240, 108.975, 34.285, 16),          # 城墙护城河
    'kunmingchi': (108.72, 34.18, 108.80, 34.24, 15),        # 昆明池（斗门水库）
}


def cached_tile_path(z, x, y):
    for base in [CACHE, *OTHER_CACHES]:
        p = base / str(z) / str(x) / f'{y}.jpg'
        if p.exists() and p.stat().st_size > 0:
            return p
    return CACHE / str(z) / str(x) / f'{y}.jpg'


def fetch_tile(args):
    z, x, y = args
    p = cached_tile_path(z, x, y)
    if not p.exists():
        tilecache.fetch(URL.format(z=z, x=x, y=y), str(p))
    return (z, x, y, p)


def mosaic(w, s, e, n, z):
    fx0, fy0 = geo.lonlat_to_tile(w, n, z)
    fx1, fy1 = geo.lonlat_to_tile(e, s, z)
    tx0, ty0, tx1, ty1 = int(fx0), int(fy0), int(fx1), int(fy1)
    jobs = [(z, tx, ty) for tx in range(tx0, tx1 + 1) for ty in range(ty0, ty1 + 1)]
    with ThreadPoolExecutor(max_workers=tilecache.MAX_WORKERS) as ex:
        res = list(ex.map(fetch_tile, jobs))
    img = Image.new('RGB', ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256), (255, 0, 255))
    for z_, tx, ty, p in res:
        try:
            img.paste(Image.open(p).convert('RGB'), ((tx - tx0) * 256, (ty - ty0) * 256))
        except Exception:  # noqa: BLE001
            pass
    mx0, _, _, my1 = geo.tile_merc_bounds(z, tx0, ty0)
    _, my0, mx1, _ = geo.tile_merc_bounds(z, tx1, ty1)
    x0, z0 = geo.merc_to_world(mx0, my1)
    x1, z1 = geo.merc_to_world(mx1, my0)
    # 裁到请求范围
    cx0, cz0 = geo.project(w, n)
    cx1, cz1 = geo.project(e, s)
    sx = img.width / (x1 - x0)
    sz = img.height / (z1 - z0)
    l, t = int((cx0 - x0) * sx), int((cz0 - z0) * sz)
    r, b = int((cx1 - x0) * sx), int((cz1 - z0) * sz)
    img = img.crop((l, t, r, b))
    return img, (x0 + l / sx, z0 + t / sz, x0 + r / sx, z0 + b / sz)


def font(size):
    for p in ('/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc',
              '/System/Library/Fonts/Hiragino Sans GB.ttc'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:  # noqa: BLE001
                pass
    return ImageFont.load_default()


WATER_COL = {'river': (40, 140, 255), 'lake': (0, 220, 255), 'reservoir': (0, 90, 255), 'canal': (120, 200, 255),
             'pond': (0, 255, 200), 'moat': (255, 0, 255), 'basin': (180, 120, 255)}


def draw_view(name, w, s, e, n, z, layers, out_dir, max_px=2400):
    img, wb = mosaic(w, s, e, n, z)
    scale = min(1.0, max_px / max(img.width, img.height))
    if scale < 1:
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.Resampling.LANCZOS)
    W, H = img.size
    to_px = lambda x, zz: ((x - wb[0]) / (wb[2] - wb[0]) * W, (zz - wb[1]) / (wb[3] - wb[1]) * H)
    mpp = (wb[2] - wb[0]) / W
    over = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    fnt = font(max(14, W // 90))

    def ring_px(flat_pts):
        return [to_px(flat_pts[i], flat_pts[i + 1]) for i in range(0, len(flat_pts) - 1, 2)]

    def in_view(flat_pts):
        xs, zs = flat_pts[0::2], flat_pts[1::2]
        return max(xs) >= wb[0] and min(xs) <= wb[2] and max(zs) >= wb[1] and min(zs) <= wb[3]

    stats = []
    if 'landuse' in layers:
        lu = json.loads((DATA / 'landuse.json').read_text())
        for p in lu.get('polys', []):
            if not in_view(p['outer']):
                continue
            col = {'park': (80, 220, 80), 'forest': (20, 140, 40), 'grass': (160, 230, 90)}.get(p['k'], (230, 200, 120))
            d.polygon(ring_px(p['outer']), outline=col + (230,))
    if 'water' in layers:
        wd = json.loads((DATA / 'water.json').read_text())
        for p in wd.get('polys', []):
            if not in_view(p['outer']):
                continue
            col = WATER_COL.get(p['k'], (255, 255, 0))
            d.polygon(ring_px(p['outer']), fill=col + (70,), outline=col + (255,))
            for hole in p.get('holes', []):
                if len(hole) >= 6:
                    d.line(ring_px(hole) + ring_px(hole)[:1], fill=(255, 60, 0, 255), width=2)
            stats.append((p.get('n', ''), p['k'], p.get('h')))
        for l in wd.get('lines', []):
            if not in_view(l['p']):
                continue
            pts = ring_px(l['p'])
            width = max(1, int(round(float(l.get('w') or 10) / mpp)))
            d.line(pts, fill=(255, 230, 0, 150), width=width)
            d.line(pts, fill=(255, 255, 255, 220), width=1)
    if 'roads' in layers:
        rd = json.loads((DATA / 'roads.json').read_text())
        for f in rd.get('features', []):
            if not in_view(f['p']):
                continue
            pts = ring_px(f['p'])
            col = (255, 80, 80, 90) if f.get('b') else ((120, 120, 255, 90) if f.get('t') else (255, 200, 0, 70))
            if mpp < 2.5:
                # 近景：按路面宽度画出两侧边线，便于和影像里的路面宽度对比
                from shapely.geometry import LineString
                ls = LineString([(f['p'][i], f['p'][i + 1]) for i in range(0, len(f['p']) - 1, 2)])
                poly = ls.buffer(float(f.get('w') or 8) / 2, cap_style='flat', join_style='mitre')
                for g in getattr(poly, 'geoms', [poly]):
                    ext = [to_px(x, zz) for x, zz in g.exterior.coords]
                    d.polygon(ext, fill=col, outline=(col[0], col[1], col[2], 255))
                    for hole in g.interiors:   # 闭合环路的缓冲区是环形，内部要挖掉
                        d.polygon([to_px(x, zz) for x, zz in hole.coords], fill=(0, 0, 0, 0),
                                  outline=(col[0], col[1], col[2], 255))
                d.line(pts, fill=(255, 255, 255, 160), width=1)
            else:
                width = max(1, int(round(float(f.get('w') or 8) / mpp)))
                d.line(pts, fill=col, width=width)
    img = Image.alpha_composite(img.convert('RGBA'), over).convert('RGB')
    dd = ImageDraw.Draw(img)
    # 比例尺
    bar_m = 10 ** math.floor(math.log10(W * mpp / 4))
    bar_px = bar_m / mpp
    dd.rectangle((20, H - 40, 20 + bar_px, H - 30), fill=(255, 255, 255))
    dd.text((20, H - 70), f'{bar_m:.0f} m', fill=(255, 255, 255), font=fnt)
    dd.text((20, 12), f'{name}  z{z}  {mpp:.2f} m/px  层:{",".join(layers)}', fill=(255, 255, 0), font=fnt)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f'{name}.jpg'
    img.save(path, quality=86)
    return path, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('views', nargs='*')
    ap.add_argument('--out', default=str(ROOT / 'research' / 'vector_check'))
    ap.add_argument('--layers', default='water')
    ap.add_argument('--suffix', default='')
    ap.add_argument('--bbox', default='', help='自定义 w,s,e,n,z')
    args = ap.parse_args()
    layers = [x for x in args.layers.split(',') if x]
    views = dict(VIEWS)
    if args.bbox:
        vals = [float(v) for v in args.bbox.split(',')]
        views = {'custom': (*vals[:4], int(vals[4]))}
        args.views = ['custom']
    names = args.views or list(views)
    for nm in names:
        w, s, e, n, z = views[nm]
        path, stats = draw_view(nm + args.suffix, w, s, e, n, z, layers, Path(args.out))
        print(path, len(stats), '个水面多边形')


if __name__ == '__main__':
    main()
