#!/usr/bin/env python3
"""外围新区高层住宅楼高修正（审查 g9 P0：长安区韦曲、郭杜成片 25~33 层住宅被建成 4~12 层）。

CMAB 在这些楼上没有有效高度（统一 14.47 m 缺省值），3D-GloBFP 与回归模型也偏低。CNBH-10m 把高层压得很低
（已知 33 层的楼只有 31~32 m），但排序信号可靠。用长安区 98 栋 OSM 已知高度的楼核对（data-src/heights/eval_rows.csv）：校外的高层住宅 CNBH90 在 25~32，
实际 64~105 m；韦曲一带影子长约 200 m 的三十层塔楼 CNBH 只有 25~28。校园内 11 层家属楼、教学楼 CNBH 也有 24~29，
所以高校用地内不改。规则：CNBH90（楼质心 40 m 半径内 90% 分位）≥ 25 → 3.0 × CNBH90，限 70~100 m（约 23~33 层）。
只改：区域内、现高 < 40 m、点式住宅轮廓（面积 150~1500 m²、长宽比 ≤ 2.2、kind 为居住或未知）、不在高校用地内、
没有真实高度来源（离 eval_rows 已知高度楼 > 15 m）的楼。只上调，不下调；重复运行结果不变。

用法：.venv-tools/bin/python tools/cnbh_boost.py [--region changan] [--dry]
      改写 public/data/buildings.bin 后要再跑 tools/buildings_patch.py（约定）。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bldbin  # noqa: E402
import geo  # noqa: E402

ROOT = os.path.dirname(HERE)
BIN = os.path.join(ROOT, 'public', 'data', 'buildings.bin')
HD = os.path.join(ROOT, 'data-src', 'heights')
REGIONS = {'changan': (108.80, 34.08, 109.02, 34.19)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--region', default='changan')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    from pyproj import Transformer
    tr = Transformer.from_crs('EPSG:4326', 'EPSG:32649', always_xy=True)
    cn = np.load(os.path.join(HD, 'cnbh_main.npy'), mmap_mode='r')
    cm = json.load(open(os.path.join(HD, 'cnbh_main.json')))
    lo0, la0, lo1, la1 = REGIONS[a.region]
    X0, Z1 = geo.project(lo0, la0)
    X1, Z0 = geo.project(lo1, la1)
    B = bldbin.read(BIN)
    ax, az, h, kind, flags = B['ax'], B['az'], B['h'], B['kind'], B['flags']
    sel = np.where((ax > X0) & (ax < X1) & (az > Z0) & (az < Z1) & ((flags & 128) == 0) & (h < 40))[0]
    # 有真实高度来源的楼不动
    known = []
    for r in csv.DictReader(open(os.path.join(HD, 'eval_rows.csv'), encoding='utf-8')):
        lon, lat = float(r['lon']), float(r['lat'])
        if lo0 - 0.01 < lon < lo1 + 0.01 and la0 - 0.01 < lat < la1 + 0.01:
            known.append(geo.project(lon, lat))
    known = np.array(known) if known else np.zeros((0, 2))
    # 高校用地（landuse university）内不改：校园里 11 层家属楼、教学楼的 CNBH 也在 24~29（已知高度表），会被误抬
    lu = json.load(open(os.path.join(ROOT, 'public', 'data', 'landuse.json')))
    campus = []
    for p in lu['polys']:
        if p['k'] != 'university':
            continue
        o = np.asarray(p['outer'], dtype=np.float64).reshape(-1, 2)
        if o[:, 0].max() < X0 or o[:, 0].min() > X1 or o[:, 1].max() < Z0 or o[:, 1].min() > Z1:
            continue
        campus.append((o, o[:, 0].min(), o[:, 0].max(), o[:, 1].min(), o[:, 1].max()))

    def in_campus(x, z):
        for o, a0, a1, b0, b1 in campus:
            if not (a0 <= x <= a1 and b0 <= z <= b1):
                continue
            c = False
            for k in range(len(o)):
                x1, z1 = o[k]
                x2, z2 = o[k - 1]
                if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1:
                    c = not c
            if c:
                return True
        return False

    changes = []
    for i in sel:
        if kind[i] not in (0, 1):
            continue
        if in_campus(float(ax[i]), float(az[i])):
            continue
        r = bldbin.ring(B, i)
        area = abs(np.sum(r[:, 0] * np.roll(r[:, 1], -1) - np.roll(r[:, 0], -1) * r[:, 1])) / 2
        if not (150 <= area <= 1500):
            continue
        c = r - r.mean(0)
        ev = np.linalg.eigvalsh(np.cov(c.T))
        if math.sqrt(max(ev) / max(1e-6, min(ev))) > 2.2:
            continue
        if len(known) and np.min(np.hypot(known[:, 0] - ax[i], known[:, 1] - az[i])) < 15:
            continue
        # 质心 40 m 半径内的 CNBH 像素（UTM 10 m 栅格）：CMAB 轮廓相对影像/CNBH 有十几米偏移、高层还常碎成几块
        lon, lat = geo.unproject(float(ax[i]), float(az[i]))
        ux, uy = tr.transform(lon, lat)
        cc, rr = int((ux - cm['x0']) // 10), int((cm['y1'] - uy) // 10)
        w = np.asarray(cn[max(0, rr - 4):rr + 5, max(0, cc - 4):cc + 5], dtype=np.float32) / 10
        nz = w[w > 0]
        if nz.size < 3:
            continue
        p90 = float(np.percentile(nz, 90))
        if p90 < 25:
            continue
        t = min(100.0, max(70.0, 3.0 * p90))
        if t > h[i] * 1.3:
            changes.append((int(i), float(h[i]), round(t, 1), round(p90, 1)))
    print(f'区域 {a.region}：候选 {len(sel)}，上调 {len(changes)} 栋')
    if changes:
        nw = np.array([c[2] for c in changes])
        print(f'  新高 ≥70 m {int((nw >= 70).sum())} 栋，45~60 m {int(((nw >= 45) & (nw < 60)).sum())} 栋')
    json.dump([{'i': c[0], 'old': c[1], 'new': c[2], 'cnbh90': c[3]} for c in changes],
              open(os.path.join(ROOT, 'shots', f'cnbh_boost_{a.region}.json'), 'w'), ensure_ascii=False)
    if a.dry or not changes:
        return
    hh = B['h'].copy()
    for i, _, t, _ in changes:
        hh[i] = t
    B['h'] = hh
    bldbin.write(B, BIN)
    print('已写回', BIN)


if __name__ == '__main__':
    main()
