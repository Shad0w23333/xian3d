#!/usr/bin/env python3
"""高德“楼宇 / 商场 / 宾馆 / 医院 / 学校楼”POI → 通用建筑名称（buildings_names.json 的补充）。

用途：楼顶字（signage.bucketNamed：≥30 m、名称含大厦/中心/广场/酒店…的楼）、建筑功能分类（bld-class 按名称判断
写字楼/商场/酒店/医院/学校）、小区名（estates.js 按“XX小区-3号楼”前缀聚合）。
规则：
  · 取高德缓存 data-src/amap/pois.json 里 typecode 前缀在 KEEP 里的 POI（GCJ → WGS → 世界坐标）；
  · 落在某栋通用建筑轮廓内（或离轮廓 ≤ 6 m 且只有这一栋）才挂名；多个 POI 落在同一栋时取类型优先级高、名称短的；
  · 只给原来没有名称的楼补名（OSM/CMAB 已有的名字不动）；名称去掉括号里的分店/方位注释；
  · 写 public/data/local/buildings_names.json（前端 data.js 优先读取），仓库里的 public/data/buildings_names.json 不动。
用法：.venv-tools/bin/python tools/amap_buildings.py   （高德 poi 抓取后、或 buildings.bin 重建后重跑）
"""
from __future__ import annotations

import json
import math
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bldbin  # noqa: E402
from geo import project  # noqa: E402
from amap_fetch import gcj2wgs  # noqa: E402

ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'public', 'data')
# 类型前缀 → 优先级（大者优先）
KEEP = {'120201': 9, '120203': 7, '120200': 6,                  # 商务写字楼 / 商住两用 / 楼宇（泛）
        '060101': 8, '060102': 8, '060100': 8,                    # 购物中心 / 普通商场
        '100101': 7, '100102': 7, '100103': 6, '100104': 6, '100105': 5,  # 星级宾馆（不含旅馆、招待所、公寓、民宿）
        '090101': 6, '090100': 6,                                 # 综合医院（三甲 / 泛）
        '130101': 5, '130102': 5, '130103': 5, '130104': 5, '130105': 5, '130106': 4,  # 各级政府机关
        '141201': 3, '141202': 3, '141203': 3, '140100': 6, '140200': 5, '140300': 5, '140400': 5}  # 学校、博物馆、展览馆、会展中心、美术馆
PAREN = re.compile(r'[（(][^）)]*[）)]')
BAD = re.compile(r'停车场|出入口|入口|东门|西门|南门|北门|[A-Za-z0-9]+口$|-[A-Za-z0-9]+$|附近|对面|旁|口腔|诊所|门诊|卫生服务|居委会|居民委员会|'
                 r'社区|服务站|民宿|招待所|公寓|宿舍|驿站|网点|营业厅|办事处|分理处|自助|充电|快递|菜鸟|丰巢')


def prio(tc):
    for k in (tc[:6],):
        if k in KEEP:
            return KEEP[k]
    return 0


def main():
    A = json.load(open(os.path.join(ROOT, 'data-src', 'amap', 'pois.json'), encoding='utf-8'))
    names0 = json.load(open(os.path.join(DATA, 'buildings_names.json'), encoding='utf-8'))
    B = bldbin.read(os.path.join(DATA, 'buildings.bin'))
    n = B['n']
    ax, az, h, flags = B['ax'], B['az'], B['h'], B['flags']
    G = 40.0
    grid = {}
    for i in range(n):
        if flags[i] & 128:
            continue
        grid.setdefault((int(ax[i] // G), int(az[i] // G)), []).append(i)
    rings = {}

    def ring(i):
        r = rings.get(i)
        if r is None:
            r = rings[i] = bldbin.ring(B, i)
        return r

    def pip(x, z, r):
        c = False
        for k in range(len(r)):
            x1, z1 = r[k]
            x2, z2 = r[k - 1]
            if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1:
                c = not c
        return c

    def edist(x, z, r):
        d = 1e9
        for k in range(len(r)):
            x1, z1 = r[k - 1]
            x2, z2 = r[k]
            dx, dz = x2 - x1, z2 - z1
            L2 = dx * dx + dz * dz or 1e-9
            t = max(0.0, min(1.0, ((x - x1) * dx + (z - z1) * dz) / L2))
            d = min(d, math.hypot(x1 + dx * t - x, z1 + dz * t - z))
        return d

    best = {}
    stat = {'cand': 0, 'inside': 0, 'near': 0, 'none': 0}
    for p in A.values():
        tc = str(p.get('typecode') or '').split('|')[0]
        pr = prio(tc)
        if not pr:
            continue
        nm = PAREN.sub('', str(p.get('name') or '')).strip()
        if len(nm) < 2 or BAD.search(nm):
            continue
        try:
            lon, lat = map(float, p['location'].split(','))
        except Exception:
            continue
        x, z = project(*gcj2wgs(lon, lat))
        stat['cand'] += 1
        cx, cz = int(x // G), int(z // G)
        cands = []
        for i in range(cx - 2, cx + 3):
            for j in range(cz - 2, cz + 3):
                cands.extend(grid.get((i, j), ()))
        hit = -1
        for b in cands:
            r = ring(b)
            if r[:, 0].min() - 1 <= x <= r[:, 0].max() + 1 and r[:, 1].min() - 1 <= z <= r[:, 1].max() + 1 and pip(x, z, r):
                hit = b
                break
        if hit >= 0:
            stat['inside'] += 1
        else:
            near = [(edist(x, z, ring(b)), b) for b in cands]
            near = sorted(d for d in near if d[0] <= 6)
            if len(near) == 1 or (len(near) > 1 and near[1][0] - near[0][0] > 4):
                hit = near[0][1]
                stat['near'] += 1
            else:
                stat['none'] += 1
                continue
        key = str(hit)
        if names0.get(key):
            continue
        # 写字楼、酒店名只挂到像样的楼上（≥ 15 m）；医院、学校、机关不限高
        if pr >= 7 and h[hit] < 15 and not tc.startswith('0601'):
            continue
        cur = best.get(key)
        if cur is None or (pr, -len(nm)) > (cur[0], -len(cur[1])):
            best[key] = (pr, nm)
    out = dict(names0)
    for k, (_, nm) in best.items():
        out[k] = nm
    os.makedirs(os.path.join(DATA, 'local'), exist_ok=True)
    dst = os.path.join(DATA, 'local', 'buildings_names.json')
    with open(dst, 'w', encoding='utf-8') as fp:
        json.dump(out, fp, ensure_ascii=False, separators=(',', ':'))
    print(f'候选 {stat["cand"]}（落在楼内 {stat["inside"]}、贴墙 {stat["near"]}、找不到楼 {stat["none"]}）；'
          f'新增楼名 {len(best)}（原有 {len(names0)} → {len(out)}）→ {dst}')
    ex = list(best.values())[:25]
    print('示例：', '、'.join(nm for _, nm in ex))


if __name__ == '__main__':
    main()
