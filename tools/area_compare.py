#!/usr/bin/env python3
"""片区对比图：内置底图 + 现有建筑（buildings.bin，按高度着色）+ Overture/OSM 最新建筑轮廓 + 现有道路 vs Overture 道路。
用法：python tools/area_compare.py <名称> <lon> <lat> [半径米=500]  → research/vector_check/cmp_<名称>.png"""
import json
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pyarrow.parquet as pq
import shapely
from PIL import Image

sys.path.insert(0, 'tools')
import bldbin
from geo import project

Image.MAX_IMAGE_PIXELS = None
name, lon, lat = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
R = float(sys.argv[4]) if len(sys.argv) > 4 else 500
cx, cz = project(lon, lat)
x0, x1, z0, z1 = cx - R, cx + R, cz - R, cz + R

fig, axs = plt.subplots(1, 2, figsize=(22, 11))
meta = json.load(open('public/data/meta.json'))
imgs = sorted(meta['imagery'], key=lambda m: m.get('priority', 0))
for ax in axs:
    for m in imgs:
        b = m['bounds']
        if b['x0'] <= x0 and b['x1'] >= x1 and b['z0'] <= z0 and b['z1'] >= z1:
            best = m
    b = best['bounds']
    im = Image.open('public/data/' + best['file'])
    W, H = im.size
    px0 = int((x0 - b['x0']) / (b['x1'] - b['x0']) * W); px1 = int((x1 - b['x0']) / (b['x1'] - b['x0']) * W)
    pz0 = int((z0 - b['z0']) / (b['z1'] - b['z0']) * H); pz1 = int((z1 - b['z0']) / (b['z1'] - b['z0']) * H)
    crop = im.crop((px0, pz0, px1, pz1))
    ax.imshow(crop, extent=(x0, x1, z1, z0), alpha=0.75)
    ax.set_xlim(x0, x1); ax.set_ylim(z1, z0); ax.set_aspect('equal')

# 左：现有建筑 + 现有道路
B = bldbin.read()
sel = np.where((B['ax'] > x0 - 100) & (B['ax'] < x1 + 100) & (B['az'] > z0 - 100) & (B['az'] < z1 + 100))[0]
cm = plt.get_cmap('turbo')
for i in sel:
    r = bldbin.ring(B, i)
    h = B['h'][i]
    axs[0].fill(r[:, 0], r[:, 1], color=cm(min(h / 150, 1)), alpha=0.55, lw=0.4, ec='k')
    if h >= 40:
        axs[0].text(B['ax'][i], B['az'][i], f'{h:.0f}', fontsize=6, ha='center')
RD = json.load(open('public/data/roads.json'))
for f in RD['features']:
    p = np.array(f['p']).reshape(-1, 2)
    if ((p[:, 0] > x0) & (p[:, 0] < x1) & (p[:, 1] > z0) & (p[:, 1] < z1)).any():
        axs[0].plot(p[:, 0], p[:, 1], color='yellow' if f['c'] < 5 else 'white', lw=max(0.5, f['w'] / 8))
axs[0].set_title(f'{name} CURRENT buildings.bin {len(sel)} (color=height, label>=40m) + roads.json')

# 右：Overture 建筑 + 道路
w, s = __import__('geo').unproject(x0, z1)
e, n = __import__('geo').unproject(x1, z0)
tb = pq.read_table('data-src/overture/building.parquet', columns=['geometry', 'bbox', 'sources', 'num_floors', 'height', 'names'])
bb = tb.column('bbox').to_pylist()
keep = [k for k, q in enumerate(bb) if q['xmax'] > w and q['xmin'] < e and q['ymax'] > s and q['ymin'] < n]
sub = tb.take(keep).to_pylist()
cnt = 0
for r in sub:
    g = shapely.from_wkb(r['geometry'])
    polys = [g] if g.geom_type == 'Polygon' else list(getattr(g, 'geoms', []))
    osm = r['sources'][0]['dataset'] == 'OpenStreetMap'
    for pg in polys:
        c = np.array([project(a, b_) for a, b_ in pg.exterior.coords])
        axs[1].fill(c[:, 0], c[:, 1], color='orange' if osm else 'cyan', alpha=0.4, lw=0.5, ec='k')
        cnt += 1
    lab = r['num_floors'] or r['height']
    nm = (r['names'] or {}).get('primary')
    if lab:
        c = pg.centroid
        x, z = project(c.x, c.y)
        axs[1].text(x, z, str(lab or ''), fontsize=6, ha='center')
ts = pq.read_table('data-src/overture/segment.parquet', columns=['geometry', 'bbox', 'class', 'subtype', 'names'])
bb = ts.column('bbox').to_pylist()
keep = [k for k, q in enumerate(bb) if q['xmax'] > w and q['xmin'] < e and q['ymax'] > s and q['ymin'] < n]
MAJ = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}
for r in ts.take(keep).to_pylist():
    if r['subtype'] != 'road':
        continue
    g = shapely.from_wkb(r['geometry'])
    c = np.array([project(a, b_) for a, b_ in g.coords])
    axs[1].plot(c[:, 0], c[:, 1], color='yellow' if r['class'] in MAJ else ('white' if r['class'] in ('residential', 'unclassified', 'living_street') else 'violet'), lw=1.2 if r['class'] in MAJ else 0.7)
axs[1].set_title(f'{name} OVERTURE 2026-09 buildings {cnt} (orange=OSM cyan=ML) + roads (label=floors)')
plt.tight_layout()
out = f'research/vector_check/cmp_{name}.png'
plt.savefig(out, dpi=70)
print(out)
