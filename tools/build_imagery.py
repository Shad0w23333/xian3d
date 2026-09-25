#!/usr/bin/env python
"""卫星影像降级底图（离线 / 首帧用）：产出 public/data/img_*.jpg 并合并更新 meta.json 的 imagery。

见 docs/CONTRACT.md 3.1 / 3.3。流程：
 1. 按层计算覆盖区域的 Web Mercator 瓦片范围（瓦片对齐外扩），下载 Esri World Imagery
    瓦片到 data-src/tiles/{z}/{x}/{y}.jpg（tilecache：并发 ≤ 8、重试、原子写、已缓存跳过）。
 2. 按瓦片网格拼接成大图；缺失/损坏瓦片用上级瓦片放大补齐（最多上溯 4 级）。
 3. 整张拼图缩放到目标尺寸（LANCZOS），bounds = 瓦片对齐外扩后的真实 Web Mercator 边界
    （换算成世界坐标，x0<x1 西→东，z0<z1 北→南）。像素网格与瓦片边界严格对齐：
    像素 (i, j) 中心 = (x0 + (i+0.5)*(x1-x0)/w, z0 + (j+0.5)*(z1-z0)/h)。
 4. JPEG q≈82（progressive + optimize），超过 8 MB 自动降质量。
 5. 读原 meta.json，只替换 imagery 数组（保留 dem/demInfo/sources/online 等其它字段；
    保留他人产出的条目如 img_xiy.jpg，并统一 priority：outer 0、main 1、core 2、wall/qujiang/xiy 3）。

用法：
  .venv-tools/bin/python tools/build_imagery.py                 # 全部层
  .venv-tools/bin/python tools/build_imagery.py wall qujiang    # 只做指定层（meta 仍按全部已存在文件合并）
  .venv-tools/bin/python tools/build_imagery.py --meta-only     # 不下载不重编码，只按现有 jpg 重写 meta.imagery
  .venv-tools/bin/python tools/build_imagery.py --dry-run       # 只打印瓦片范围
"""
import argparse
import io
import json
import math
import os
import sys
import time

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import geo  # noqa: E402
import tilecache  # noqa: E402

Image.MAX_IMAGE_PIXELS = None

URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
TILE_DIR = os.path.join(ROOT, 'data-src', 'tiles')
OUT = os.path.join(ROOT, 'public', 'data')
META = os.path.join(OUT, 'meta.json')
MAX_BYTES = 8 * 1024 * 1024
QUALITY = 82
ESRI_SOURCE = 'Esri World Imagery — Esri, Maxar, Earthstar Geographics, and the GIS User Community'

# 与 CONTRACT.md 3.3 表格一致
LAYERS = [
    {'name': 'outer', 'file': 'img_outer.jpg', 'bbox': geo.BOUNDS['OUTER'], 'z': 11, 'size': (2048, 2048), 'priority': 0},
    {'name': 'main', 'file': 'img_main.jpg', 'bbox': geo.BOUNDS['MAIN'], 'z': 13, 'size': (4096, 4096), 'priority': 1},
    {'name': 'core', 'file': 'img_core.jpg', 'bbox': geo.BOUNDS['CORE'], 'z': 15, 'size': (4096, 4096), 'priority': 2},
    {'name': 'wall', 'file': 'img_wall.jpg', 'bbox': (108.922, 34.247, 108.966, 34.279), 'z': 17, 'size': (2048, 2048), 'priority': 3},
    {'name': 'qujiang', 'file': 'img_qujiang.jpg', 'bbox': (108.950, 34.192, 108.990, 34.226), 'z': 17, 'size': (2048, 2048), 'priority': 3},
]
# 他人产出、本脚本只在 meta 中统一 priority 的条目
FOREIGN_PRIORITY = {'img_xiy.jpg': 3}


def tile_path(z, x, y):
    return os.path.join(TILE_DIR, str(z), str(x), f'{y}.jpg')


def validate_image_bytes(data):
    if len(data) < 100 or not (data[:3] == b'\xff\xd8\xff' or data[:8] == b'\x89PNG\r\n\x1a\n'):
        raise RuntimeError(f'不是图片（{len(data)} B）')


def layer_geometry(layer):
    """瓦片对齐外扩后的范围：tiles、真实墨卡托边界、世界坐标 bounds、经纬度 [w,s,e,n]。"""
    z = layer['z']
    tx0, tx1, ty0, ty1 = tilecache.tile_range(layer['bbox'], z)
    mx0, _, _, my1 = geo.tile_merc_bounds(z, tx0, ty0)   # 西北角瓦片
    _, my0, mx1, _ = geo.tile_merc_bounds(z, tx1, ty1)   # 东南角瓦片
    x0, z0 = geo.merc_to_world(mx0, my1)                 # 西北
    x1, z1 = geo.merc_to_world(mx1, my0)                 # 东南
    w_lon, n_lat = geo.unproject(x0, z0)
    e_lon, s_lat = geo.unproject(x1, z1)
    return {
        'tiles': (tx0, ty0, tx1, ty1),
        'nx': tx1 - tx0 + 1, 'ny': ty1 - ty0 + 1,
        'bounds': {'x0': x0, 'x1': x1, 'z0': z0, 'z1': z1},
        'lonlat': [w_lon, s_lat, e_lon, n_lat],
    }


def load_tile(z, x, y, depth=0, stats=None):
    """返回 256×256 RGB 瓦片；缺失/损坏时用上级瓦片对应象限放大补齐。"""
    p = tile_path(z, x, y)
    if not (os.path.exists(p) and os.path.getsize(p) > 0) and depth > 0:
        try:
            tilecache.fetch(URL.format(z=z, x=x, y=y), p, validate=validate_image_bytes)
        except Exception as e:  # noqa: BLE001
            print(f'  [warn] 上级瓦片 {z}/{x}/{y} 下载失败: {e}', flush=True)
    if os.path.exists(p) and os.path.getsize(p) > 0:
        try:
            with Image.open(p) as im:
                im = im.convert('RGB')
                if im.size != (256, 256):
                    im = im.resize((256, 256), Image.Resampling.LANCZOS)
                return im
        except Exception as e:  # noqa: BLE001
            print(f'  [warn] 瓦片 {z}/{x}/{y} 解码失败（{e}），删除缓存', flush=True)
            try:
                os.remove(p)
            except OSError:
                pass
    if depth >= 4 or z <= 1:
        if stats is not None:
            stats['blank'] += 1
        return Image.new('RGB', (256, 256), (128, 124, 112))
    if stats is not None and depth == 0:
        stats['fallback'] += 1
    parent = load_tile(z - 1, x >> 1, y >> 1, depth + 1, stats)
    qx, qy = (x & 1) * 128, (y & 1) * 128
    return parent.crop((qx, qy, qx + 128, qy + 128)).resize((256, 256), Image.Resampling.BICUBIC)


def build_mosaic(layer, g):
    z = layer['z']
    tx0, ty0, tx1, ty1 = g['tiles']
    jobs = [(URL.format(z=z, x=x, y=y), tile_path(z, x, y))
            for x in range(tx0, tx1 + 1) for y in range(ty0, ty1 + 1)]
    res = tilecache.fetch_many(jobs, label=f'{layer["name"]} z{z}', validate=validate_image_bytes)
    missing = sum(1 for s in res.values() if s in ('missing', 'error'))
    stats = {'fallback': 0, 'blank': 0, 'flat': 0}
    W, H = g['nx'] * 256, g['ny'] * 256
    mosaic = Image.new('RGB', (W, H))
    for x in range(tx0, tx1 + 1):
        for y in range(ty0, ty1 + 1):
            t = load_tile(z, x, y, 0, stats)
            # 疑似 “Map data not yet available” 占位图：整块几乎纯色
            ext = t.convert('L').getextrema()
            if ext[1] - ext[0] < 6:
                stats['flat'] += 1
            mosaic.paste(t, ((x - tx0) * 256, (y - ty0) * 256))
    print(f'[{layer["name"]}] 拼图 {W}×{H}（{g["nx"]}×{g["ny"]} 瓦片），缺失 {missing}，'
          f'上级补齐 {stats["fallback"]}，空白 {stats["blank"]}，疑似纯色 {stats["flat"]}', flush=True)
    return mosaic, stats


def save_jpeg(im, path):
    """q≈82 写 JPEG；超过 8 MB 逐步降质量。返回 (quality, bytes)。"""
    q = QUALITY
    while True:
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=q, optimize=True, progressive=True)
        data = buf.getvalue()
        if len(data) <= MAX_BYTES or q <= 60:
            break
        print(f'  {os.path.basename(path)} q={q} → {len(data) / 1e6:.2f} MB 超限，降质量', flush=True)
        q -= 4
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)
    return q, len(data)


def meta_entry(layer, g, w, h, quality=None):
    b = g['bounds']
    e = {
        'file': layer['file'],
        'w': w, 'h': h,
        'bounds': {k: round(v, 3) for k, v in b.items()},
        'mpp': round((b['x1'] - b['x0']) / w, 3),      # 与前端一致：x 方向世界米/像素
        'mppZ': round((b['z1'] - b['z0']) / h, 3),
        'priority': layer['priority'],
        'zoom': layer['z'],
        'tiles': list(g['tiles']),                      # [tx0, ty0, tx1, ty1]（含端点）
        'lonlat': [round(v, 7) for v in g['lonlat']],   # 实际覆盖 [w, s, e, n]
        'source': 'Esri World Imagery',
    }
    if quality is not None:
        e['quality'] = quality
    return e


def build_layer(layer):
    t0 = time.time()
    g = layer_geometry(layer)
    mosaic, _ = build_mosaic(layer, g)
    W, H = layer['size']
    img = mosaic.resize((W, H), Image.Resampling.LANCZOS, reducing_gap=3.0)
    q, nbytes = save_jpeg(img, os.path.join(OUT, layer['file']))
    e = meta_entry(layer, g, W, H, q)
    print(f'[{layer["name"]}] → {layer["file"]} {W}×{H} q={q} {nbytes / 1e6:.2f} MB  '
          f'mpp {e["mpp"]}×{e["mppZ"]}  bounds {e["bounds"]}  ({time.time() - t0:.1f}s)', flush=True)
    return e


def entry_from_existing(layer):
    """--meta-only / 未重建层：按现有 jpg 与确定性的瓦片几何生成条目。"""
    p = os.path.join(OUT, layer['file'])
    if not os.path.exists(p):
        return None
    with Image.open(p) as im:
        w, h = im.size
    return meta_entry(layer, layer_geometry(layer), w, h)


def merge_meta(entries):
    """读原 meta.json，只替换 imagery（保留其它字段与他人产出的影像条目）。"""
    with open(META, encoding='utf-8') as f:
        meta = json.load(f)
    mine = {l['file'] for l in LAYERS}
    old_mine = {e.get('file'): e for e in meta.get('imagery') or [] if e.get('file') in mine}
    for e in entries:   # 未重编码的层沿用旧条目里记录的 JPEG 质量
        if 'quality' not in e and 'quality' in old_mine.get(e['file'], {}):
            e['quality'] = old_mine[e['file']]['quality']
    others = []
    for e in meta.get('imagery') or []:
        if e.get('file') in mine:
            continue
        e = dict(e)
        if e.get('file') in FOREIGN_PRIORITY:
            e['priority'] = FOREIGN_PRIORITY[e['file']]
        b = e.get('bounds') or {}
        if e.get('w') and all(k in b for k in ('x0', 'x1')):
            e['mpp'] = round((b['x1'] - b['x0']) / e['w'], 3)   # 原值 2.0 与实际不符，按 bounds 重算
        others.append(e)
    imagery = sorted(entries + others, key=lambda e: (e.get('priority', 0), -e.get('mpp', 0)))
    meta['imagery'] = imagery
    src = meta.get('sources')
    if isinstance(src, list) and not any(s.startswith('Esri World Imagery') for s in src):
        src.append(ESRI_SOURCE)
    tmp = META + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(tmp, META)
    print('[meta] imagery =', [(e['file'], e.get('priority')) for e in imagery], flush=True)
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('layers', nargs='*', help='只构建这些层（outer/main/core/wall/qujiang）')
    ap.add_argument('--meta-only', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    names = args.layers or [l['name'] for l in LAYERS]
    bad = set(names) - {l['name'] for l in LAYERS}
    if bad:
        ap.error(f'未知层 {bad}')

    if args.dry_run:
        for l in LAYERS:
            g = layer_geometry(l)
            print(l['name'], 'z', l['z'], 'tiles', g['tiles'], f'{g["nx"]}×{g["ny"]}', g['bounds'], g['lonlat'])
        return

    entries = []
    for l in LAYERS:
        if not args.meta_only and l['name'] in names:
            entries.append(build_layer(l))
        else:
            e = entry_from_existing(l)
            if e:
                entries.append(e)
    merge_meta(entries)


if __name__ == '__main__':
    main()
