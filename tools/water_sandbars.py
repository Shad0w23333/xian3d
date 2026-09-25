#!/usr/bin/env python3
"""按 Esri World Imagery 识别宽河道面里的沙洲 / 裸露河滩，写 data-src/vector_check/sandbars.json。

OSM 的渭河、灞河等 natural=water + water=river 面是两岸之间的整条河槽，中间常有几百米长的沙洲；
整块画成水面会让河道显得比卫星影像宽很多。本工具：
  1. 取 build_data.water_shapes() 里的河道面（平均宽 ≥ 60 m、面积 ≥ 3 ha），按 2.4 km 网格分块；
  2. 每块拼 z15 影像（≈4 m/px，缓存 data-src/vector_check/tiles/，并发 ≤ 8），面内亮度做 Otsu 双峰分割；
     双峰明显（亮暗均值差 ≥ 32、阈值 ≥ 100）时，亮类中亮度 ≥ 150 且偏暖（R−G > 4）的像元 = 沙洲/河滩；
  3. 形态学开闭运算去噪，丢掉 < 5000 m² 的碎斑，矢量化并简化，存经纬度多边形。
build_data.py water_output 读取该缓存，从河道面扣除（沙洲处露出影像底图）。缓存不存在时不扣。

用法：.venv-tools/bin/python tools/water_sandbars.py [--zoom 15] [--preview]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import geo  # noqa: E402
import build_data as bd  # noqa: E402
import vector_check as vc  # noqa: E402

OUT = ROOT / 'data-src' / 'vector_check' / 'sandbars.json'
PREVIEW = ROOT / 'research' / 'vector_check'


def otsu(values):
    hist, edges = np.histogram(values, bins=128, range=(0, 256))
    hist = hist.astype(np.float64)
    centers = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * centers)
    mt = m0[-1]
    with np.errstate(divide='ignore', invalid='ignore'):
        mu0 = m0 / w0
        mu1 = (mt - m0) / w1
        between = w0 * w1 * (mu0 - mu1) ** 2
    between[~np.isfinite(between)] = 0
    i = int(np.argmax(between))
    return float(edges[i + 1]), float(mu0[i]), float(mu1[i]), float(w1[i] / max(1.0, w0[-1]))


def piece_mosaic(poly, z, pad=20.0):
    minx, minz, maxx, maxz = poly.bounds
    w, n = geo.unproject(minx - pad, minz - pad)
    e, s = geo.unproject(maxx + pad, maxz + pad)
    return vc.mosaic(w, s, e, n, z)


def mask_from_poly(poly, wb, W, H):
    im = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(im)
    sx, sz = W / (wb[2] - wb[0]), H / (wb[3] - wb[1])

    def px(coords):
        return [((x - wb[0]) * sx - 0.5, (zz - wb[1]) * sz - 0.5) for x, zz in coords]
    d.polygon(px(poly.exterior.coords), fill=1)
    for hole in poly.interiors:
        d.polygon(px(hole.coords), fill=0)
    return np.asarray(im, bool)


def vectorize(mask, wb):
    """二值栅格 → shapely（世界坐标）：逐行游程合成矩形再合并。"""
    from shapely.geometry import box
    from shapely.ops import unary_union
    H, W = mask.shape
    dx, dz = (wb[2] - wb[0]) / W, (wb[3] - wb[1]) / H
    boxes = []
    for j in range(H):
        row = mask[j]
        if not row.any():
            continue
        d = np.diff(np.concatenate(([0], row.astype(np.int8), [0])))
        starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
        z0, z1 = wb[1] + j * dz, wb[1] + (j + 1) * dz
        for a, b in zip(starts, ends):
            boxes.append(box(wb[0] + a * dx, z0, wb[0] + b * dx, z1))
    if not boxes:
        return None
    return unary_union(boxes)


def classify_piece(poly, whole, z, min_bar=5000.0, context=1000.0):
    """poly：本分块；whole：整条河道面。阈值在分块外扩 context 米范围内的整段河面上统计，
    相邻分块的阈值因此基本一致，不会在网格线上出现“一边扣一边不扣”的直边。"""
    img, wb = piece_mosaic(poly, z, pad=context)
    a = np.asarray(img).astype(np.float32)
    H, W = a.shape[:2]
    inside = mask_from_poly(poly, wb, W, H)
    if inside.sum() < 300:
        return None, None
    from shapely.geometry import box
    ctx_poly = whole.intersection(box(wb[0], wb[1], wb[2], wb[3]))
    ctx = np.zeros_like(inside)
    for g in getattr(ctx_poly, 'geoms', [ctx_poly]):
        if g.geom_type == 'Polygon' and not g.is_empty:
            ctx |= mask_from_poly(g, wb, W, H)
    ctx |= inside
    lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    lum = ndi.uniform_filter(lum, 3)   # 抑制单像素闪光
    vals = lum[ctx]
    t, m0, m1, frac = otsu(vals)
    info = {'t': round(t), 'dark': round(m0), 'bright': round(m1), 'frac': round(frac, 3)}
    if not (m1 - m0 >= 32 and t >= 100 and 0.02 <= frac <= 0.8):
        return None, info
    # 绝对条件：沙洲是亮（≥150）且偏暖（R 比 G 高）的米黄/灰白色；
    # 影像拼接缝两侧的浅绿色水面、浑浊水亮度也会高于暗水，但不够亮或偏绿，不能算沙洲。
    warm = ndi.uniform_filter(a[..., 0] - a[..., 1], 3)
    sand = (lum > max(t, 150.0)) & (warm > 4) & inside
    px_m = (wb[2] - wb[0]) / W
    r = max(1, round(8 / px_m))
    st = ndi.generate_binary_structure(2, 1)
    sand = ndi.binary_opening(sand, st, iterations=r)
    sand = ndi.binary_closing(sand, st, iterations=r)
    sand &= inside
    lab, n = ndi.label(sand)
    if n == 0:
        return None, info
    sizes = ndi.sum(sand, lab, range(1, n + 1)) * px_m * px_m
    keep = np.zeros(n + 1, bool)
    keep[1:] = sizes >= min_bar
    sand = keep[lab]
    # 沙洲内部的小水坑一并算沙洲（< 2000 m² 的洞填上）
    holes = ndi.binary_fill_holes(sand) & ~sand
    hl, hn = ndi.label(holes)
    if hn:
        hs = ndi.sum(holes, hl, range(1, hn + 1)) * px_m * px_m
        fill = np.zeros(hn + 1, bool)
        fill[1:] = hs < 2000
        sand |= fill[hl]
    if not sand.any():
        return None, info
    geom = vectorize(sand, wb)
    if geom is None:
        return None, info
    geom = geom.simplify(px_m * 1.2, preserve_topology=True).buffer(0)
    geom = geom.intersection(poly)
    info['sand_m2'] = round(geom.area)
    return geom, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zoom', type=int, default=15)
    ap.add_argument('--min-width', type=float, default=60.0)
    ap.add_argument('--preview', action='store_true')
    args = ap.parse_args()
    t0 = time.time()
    shapes, _ = bd.water_shapes()
    rivers = []
    for poly, name, kind in shapes:
        if kind != 'river' or poly.area < 30000:
            continue
        width = 2 * poly.area / max(poly.length, 1.0)
        if width < args.min_width:
            continue
        for piece in bd.split_by_grid(poly):
            rivers.append((piece, name, poly))
    print(f'[sandbar] 河道分块 {len(rivers)} 个')
    results, total = [], 0.0
    stats = {'pieces': len(rivers), 'bimodal': 0}

    def work(item):
        piece, name, whole = item
        try:
            return item, classify_piece(piece, whole, args.zoom)
        except Exception as e:  # noqa: BLE001
            return item, (None, {'error': str(e)})

    with ThreadPoolExecutor(max_workers=1) as ex:   # 每块内部拼图已 8 并发，外层串行保证总并发 ≤ 8
        for (piece, name, _), (geom, info) in ex.map(work, rivers):
            if geom is None or geom.is_empty:
                continue
            stats['bimodal'] += 1
            for g in getattr(geom, 'geoms', [geom]):
                if g.geom_type != 'Polygon' or g.area < 3000:
                    continue
                rings = []
                for ring in [g.exterior, *g.interiors]:
                    rings.append([[round(v, 7) for v in geo.unproject(x, zz)] for x, zz in ring.coords])
                results.append({'n': name, 'a': round(g.area), 'rings': rings})
                total += g.area
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({'zoom': args.zoom, 'source': 'Esri World Imagery 亮度 Otsu 分割',
                               'generated': time.strftime('%Y-%m-%dT%H:%M:%S'), 'stats': stats,
                               'sandbars': results}, ensure_ascii=False))
    print(f'[sandbar] 沙洲 {len(results)} 块，合计 {total / 1e6:.2f} km²，双峰分块 {stats["bimodal"]}/{stats["pieces"]}，'
          f'{time.time() - t0:.0f}s → {OUT}')


if __name__ == '__main__':
    main()
