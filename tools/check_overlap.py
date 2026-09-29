#!/usr/bin/env python3
"""建筑穿模/重叠诊断的分析部分（由 tools/check_overlap.mjs 调用，也可单独对已有 dump.json 运行）。

输入 dump.json（页面导出）：通用建筑 skip/底高/轮廓地形采样、skyline 渲染清单、排除区（带注册模块）。
轮廓：通用建筑直接读 public/data/buildings.bin；回民街逐户轮廓读 public/data/huimin.json；道路读 public/data/roads.json。

统计：
  a) overlap —— 两栋渲染建筑轮廓相交（部分相交，交叠面积 > AREA_MIN，且竖向区间有重叠），按来源对分类；
               另含“渲染建筑 × 其他片区模块精建区（排除区）”
  b) road    —— 建筑轮廓压在道路面（中心线按路宽/2 缓冲；隧道与被排除区隐藏的路段不算）
  c) dup     —— 重复生成：较小者 ≥ DUP_RATIO 落在另一栋内（不含“塔楼坐裙房”：较小者整体在内且高出 ≥ 15 m）；
               另含“同名异位”：两套来源的塔楼名称相同/近似、高度相近、相距 < 250 m（各建一份但位置不同）
  d) float / bury —— 底高与轮廓下地形差 > 2 m（悬空：底高 - 地形最低；埋地：地形最高 - 底高；
               坡地上平底楼以最低点为底，上坡侧埋入属正常；另列“严重埋地”：上坡侧露出地面不足 2 m（楼顶低于或贴着轮廓下最高地面）

用法：python tools/check_overlap.py dump.json [--out report.json] [--top 20] [--bin 旧 buildings.bin --names 旧名称表]
"""
import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bldbin  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
AREA_MIN = 4.0      # 相交面积阈值（m²）
DUP_RATIO = 0.5     # 较小者被覆盖比例 ≥ 此值视为重复生成
ROAD_MIN = 4.0      # 压路面积阈值（m²）
FLOAT_MIN = 2.0     # 悬空/埋地阈值（m）
# 参与“压路”判定的道路等级（机动车道路；service/pedestrian/footway 另计为次要）
MAJOR = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'}


# 渲染路面宽（与 src/arch/roads_net.js 的 CLASS_CFG.minW / 车道宽规则一致，不含人行道）
MIN_W = {'motorway': 7.5, 'trunk': 7, 'primary': 7, 'secondary': 6.5, 'tertiary': 6, 'residential': 5, 'service': 3.5,
         'unclassified': 5, 'motorway_link': 4.5, 'trunk_link': 4.5, 'primary_link': 4.5, 'secondary_link': 4,
         'pedestrian': 4, 'footway': 2}
RANK8 = {'motorway', 'trunk', 'primary'}


def road_half_width(f, cls):
    c = cls[f['c']]
    W = float(f.get('w') or 0) or MIN_W.get(c, 5)
    if c not in ('pedestrian', 'footway'):
        lanes = max(1, min(8, int(f.get('l') or 1)))
        W = max(W, MIN_W.get(c, 5), lanes * (3.4 if c in RANK8 else 3.1))
    return min(W, 42) / 2


# —— 同名/近名塔楼（与 src/modules/skyline.js 的 sameTower 相同规则）——
def norm_name(n):
    return re.sub(r'[\s·・\-—_()（）]', '', str(n or '')).lower()


def lcs(a, b):
    best = ''
    for i in range(len(a)):
        j = i + len(best) + 1
        while j <= len(a) and a[i:j] in b:
            best = a[i:j]
            j += 1
    return best


DESIG = re.compile(r'^[a-z0-9#＃一二三四五六七八九十东西南北]{1,3}(座|号楼|号|栋|塔|楼)?$')


def same_tower(a, b):
    if math.hypot(a['x'] - b['x'], a['z'] - b['z']) > 250 or abs(a['h'] - b['h']) > 0.06 * max(a['h'], b['h']):
        return False
    if a['n'] == b['n']:
        return True
    if not a['soft'] and not b['soft']:
        return False
    core = lcs(a['n'], b['n'])
    if len(core) < 4:
        return False
    ra, rb = a['n'].replace(core, '', 1), b['n'].replace(core, '', 1)
    return not (DESIG.match(ra) and DESIG.match(rb) and ra != rb)


def fam(src):
    return 'lm' if src.startswith('lm') else src


def valid(p):
    if p.is_valid:
        return p
    q = shapely.make_valid(p)
    if q.geom_type == 'Polygon':
        return q
    polys = [g for g in getattr(q, 'geoms', []) if g.geom_type == 'Polygon']
    return max(polys, key=lambda g: g.area) if polys else None


def pip(x, z, p):
    """与 src/core/util.js pointInPoly 相同的射线法"""
    c = False
    n = len(p) // 2
    j = n - 1
    for i in range(n):
        xi, zi, xj, zj = p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            c = not c
        j = i
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dump')
    ap.add_argument('--out')
    ap.add_argument('--top', type=int, default=20)
    ap.add_argument('--bin', default=str(ROOT / 'public/data/buildings.bin'), help='与 dump 对应的 buildings.bin（对比修复前数据时用）')
    ap.add_argument('--names', default=str(ROOT / 'public/data/buildings_names.json'))
    a = ap.parse_args()
    D = json.loads(Path(a.dump).read_text('utf-8'))
    mods = set(D.get('modules') or [])
    items = []  # dict(src, name, key, poly, bot, top, tmin, tmax, h)

    # —— 通用建筑 ——
    if D.get('bld'):
        B = bldbin.read(a.bin)
        names = json.loads(Path(a.names).read_text('utf-8'))
        d = D['bld']
        assert d['n'] == B['n'], 'buildings.bin 与导出数据不一致（重新运行 check_overlap.mjs）'
        skip, base, ga, tmin, tmax = (np.asarray(d[k], float) for k in ('skip', 'base', 'ga', 'tmin', 'tmax'))
        for i in np.nonzero(skip == 0)[0]:
            r = bldbin.ring(B, i)
            if len(r) < 3:
                continue
            p = valid(Polygon(r))
            if p is None or p.area < 6:
                continue
            H = max(3.0, float(B['h'][i]))
            mh = float(B['minh'][i])
            bot = ga[i] + mh if mh > 0.5 else base[i] - 0.8
            items.append(dict(src='gen', name=names.get(str(i), ''), key=f'g{i}', idx=int(i), poly=p, bot=bot, top=ga[i] + H,
                              tmin=tmin[i], tmax=tmax[i], h=H, part=mh > 0.5))
    # —— skyline ——
    for s in D.get('sky') or []:
        p = valid(Polygon(np.array(s['pts'], float).reshape(-1, 2)))
        if p is None:
            continue
        items.append(dict(src=s['src'], name=s['name'], key=s['key'] or f"s{len(items)}", poly=p, bot=s['base'], top=s['base'] + s['h'],
                          tmin=s['t'][0], tmax=s['t'][1], h=s['h'], part=False))
    # —— 回民街逐户 ——
    if 'huimin' in mods:
        hm = json.loads((ROOT / 'public/data/huimin.json').read_text('utf-8'))
        for k, b in enumerate(hm['b']):
            if len(b['p']) < 6:
                continue
            p = valid(Polygon(np.array(b['p'], float).reshape(-1, 2)))
            if p is None:
                continue
            items.append(dict(src='huimin', name=b.get('sg') or '', key=f'h{k}', poly=p, bot=-1e9, top=1e9, tmin=None, tmax=None, h=b.get('h', 8), part=False))
    print(f'渲染建筑：{len(items)}（' + '、'.join(f'{k} {v}' for k, v in Counter(it["src"] for it in items).items()) + '）')

    polys = [it['poly'] for it in items]
    tree = STRtree(polys)
    ii, jj = tree.query(polys, predicate='intersects')
    m = ii < jj
    ii, jj = ii[m], jj[m]
    overlap, dup = defaultdict(list), defaultdict(list)
    for i, j in zip(ii.tolist(), jj.tolist()):
        A, Bq = items[i], items[j]
        if A['key'] == Bq['key']:
            continue
        if A['src'] == 'special' and Bq['src'] == 'special':
            continue
        if A['src'] == 'huimin' and Bq['src'] == 'huimin':
            continue
        if min(A['top'], Bq['top']) <= max(A['bot'], Bq['bot']) + 0.5:
            continue  # 竖向不重叠（building:part 叠层等）
        inter = A['poly'].intersection(Bq['poly'])
        ar = inter.area
        if ar <= AREA_MIN:
            continue
        small, big = (A, Bq) if A['poly'].area <= Bq['poly'].area else (Bq, A)
        ratio = ar / small['poly'].area
        # 塔楼坐裙房：较小者整体落在较大者内且明显更高 → 有意嵌套
        if ratio > 0.95 and small['h'] >= big['h'] + 15:
            continue
        pair = '×'.join(sorted((fam(A['src']), fam(Bq['src']))))
        c = inter.centroid
        rec = dict(area=round(ar, 1), ratio=round(ratio, 2), x=round(c.x, 1), z=round(c.y, 1),
                   a=f"{A['src']}:{A['name'] or A['key']}({A['h']:.0f}m)", b=f"{Bq['src']}:{Bq['name'] or Bq['key']}({Bq['h']:.0f}m)")
        (dup if ratio >= DUP_RATIO else overlap)[pair].append(rec)

    # —— 同一栋被两套来源按不同位置各建一份（位置不重叠，靠名称+高度识别）：skyline 的塔楼（手工/批量/通用高层） ——
    tw = []
    for k, it in enumerate(items):
        if it['src'] in ('cur', 'lm', 'lm-synth', 'osm') and it['h'] >= 34 and it['name'] and not it['name'].endswith('·裙房'):
            c = it['poly'].centroid
            tw.append(dict(k=k, x=c.x, z=c.y, h=it['h'], n=norm_name(it['name']), soft=it['src'] == 'lm-synth'))
    for a_ in range(len(tw)):
        for b_ in range(a_ + 1, len(tw)):
            A, Bq = items[tw[a_]['k']], items[tw[b_]['k']]
            if A['key'] == Bq['key'] or (A['src'] == Bq['src'] == 'osm') or not same_tower(tw[a_], tw[b_]):
                continue
            if A['poly'].intersection(Bq['poly']).area >= DUP_RATIO * min(A['poly'].area, Bq['poly'].area):
                continue  # 轮廓重合的已在上面计入
            pair = '×'.join(sorted((fam(A['src']), fam(Bq['src'])))) + '·同名异位'
            dup[pair].append(dict(area=round(min(A['poly'].area, Bq['poly'].area), 1), ratio=0, x=round(tw[a_]['x'], 1), z=round(tw[a_]['z'], 1),
                                  a=f"{A['src']}:{A['name']}({A['h']:.0f}m)", b=f"{Bq['src']}:{Bq['name']}({Bq['h']:.0f}m)@({tw[b_]['x']:.0f},{tw[b_]['z']:.0f})"))

    # —— 渲染建筑 × 其他模块精建区（排除区，buildings 标记） ——
    zones = []
    for e in D.get('excl') or []:
        f = e['flags']
        if not f.get('buildings') or e['owner'] in ('skyline', 'huimin', ''):
            continue
        p = valid(Polygon(np.array(e['p'], float).reshape(-1, 2)))
        if p is not None and p.area > 1:
            zones.append((e, p))
    if zones:
        zt = STRtree([p for _, p in zones])
        zi, zj = zt.query(polys, predicate='intersects')
        for i, k in zip(zi.tolist(), zj.tolist()):
            it, (e, zp) = items[i], zones[k]
            mh = e['flags'].get('maxHeight')
            if mh is not None and it['h'] > mh:
                continue
            if it['src'] == 'huimin':
                continue
            ar = it['poly'].intersection(zp).area
            if ar <= AREA_MIN:
                continue
            c = it['poly'].centroid
            overlap[f"{fam(it['src'])}×区:{e['owner']}"].append(dict(area=round(ar, 1), ratio=round(ar / it['poly'].area, 2), x=round(c.x, 1), z=round(c.y, 1),
                                                                   a=f"{it['src']}:{it['name'] or it['key']}({it['h']:.0f}m)", b=f"{e['owner']}:{e['name']}"))

    # —— 道路 ——
    R = json.loads((ROOT / 'public/data/roads.json').read_text('utf-8'))
    cls = R['classes']
    rex = [(e, np.array(e['p'], float)) for e in D.get('excl') or [] if e['flags'].get('roads')]
    segs, meta = [], []
    for f in R['features']:
        if f.get('t'):
            continue
        q = f['p']
        c = cls[f['c']]
        hw = road_half_width(f, cls)
        for k in range(0, len(q) - 2, 2):
            mx, mz = (q[k] + q[k + 2]) / 2, (q[k + 1] + q[k + 3]) / 2
            if rex and any(e['p'] and pip(mx, mz, e['p']) for e, _ in rex):
                continue
            segs.append(LineString([(q[k], q[k + 1]), (q[k + 2], q[k + 3])]).buffer(hw, cap_style='flat'))
            meta.append((c, f.get('n') or '', bool(f.get('b'))))
    rt = STRtree(segs)
    ri, rj = rt.query(polys, predicate='intersects')
    by = defaultdict(list)
    for i, k in zip(ri.tolist(), rj.tolist()):
        by[i].append(k)
    road = defaultdict(list)
    for i, ks in by.items():
        it = items[i]
        for tier in ('major', 'minor'):
            sel = [k for k in ks if (meta[k][0] in MAJOR) == (tier == 'major') and not meta[k][2]]
            if not sel:
                continue
            u = shapely.union_all([segs[k] for k in sel])
            ar = it['poly'].intersection(u).area
            if ar <= ROAD_MIN:
                continue
            c = it['poly'].centroid
            k0 = max(sel, key=lambda k: segs[k].intersection(it['poly']).area)
            road[f"{fam(it['src'])}·{tier}"].append(dict(area=round(ar, 1), ratio=round(ar / it['poly'].area, 2), x=round(c.x, 1), z=round(c.y, 1),
                                                         a=f"{it['src']}:{it['name'] or it['key']}({it['h']:.0f}m)", b=f"{meta[k0][0]}:{meta[k0][1]}"))

    # —— 悬空 / 埋地 ——
    flo, bur, sev = defaultdict(list), defaultdict(list), defaultdict(list)
    for it in items:
        if it['tmin'] is None or it['part'] or it['src'] == 'special':
            continue
        c = it['poly'].centroid
        g = it['bot'] - it['tmin']
        if g > FLOAT_MIN:
            flo[fam(it['src'])].append(dict(gap=round(g, 1), x=round(c.x, 1), z=round(c.y, 1), a=f"{it['src']}:{it['name'] or it['key']}({it['h']:.0f}m)"))
        b = it['tmax'] - it['bot']
        if it['top'] - it['tmax'] < FLOAT_MIN:
            sev[fam(it['src'])].append(dict(depth=round(b, 1), frac=round(b / max(it['top'] - it['bot'], 1), 2), x=round(c.x, 1), z=round(c.y, 1),
                                            a=f"{it['src']}:{it['name'] or it['key']}({it['h']:.0f}m)"))
        if b > FLOAT_MIN:
            bur[fam(it['src'])].append(dict(depth=round(b, 1), frac=round(b / max(it['h'], 1), 2), x=round(c.x, 1), z=round(c.y, 1),
                                            a=f"{it['src']}:{it['name'] or it['key']}({it['h']:.0f}m)"))

    def pack(dct, key):
        tot = sum(len(v) for v in dct.values())
        allv = sorted((r | {'cat': k} for k, v in dct.items() for r in v), key=lambda r: -r[key])
        return dict(total=tot, by={k: len(v) for k, v in sorted(dct.items(), key=lambda kv: -len(kv[1]))}, top=allv[:a.top],
                    top_by={k: sorted(v, key=lambda r: -r[key])[:5] for k, v in dct.items()})

    rep = dict(overlap=pack(overlap, 'area'), dup=pack(dup, 'area'), road=pack(road, 'area'), float=pack(flo, 'gap'), bury=pack(bur, 'depth'), bury_severe=pack(sev, 'depth'))
    for k, t in (('overlap', 'a) 轮廓相交'), ('road', 'b) 压道路'), ('dup', 'c) 重复生成'), ('float', 'd) 悬空'), ('bury', 'd) 埋地'), ('bury_severe', 'd) 严重埋地（上坡侧露出 < 2 m）')):
        r = rep[k]
        print(f"\n{t}：{r['total']}  " + '，'.join(f'{c} {n}' for c, n in r['by'].items()))
        for s in r['top'][:a.top]:
            print('   ', json.dumps(s, ensure_ascii=False))
    if a.out:
        Path(a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=1), 'utf-8')
        print('\n报告：', a.out)


if __name__ == '__main__':
    main()
