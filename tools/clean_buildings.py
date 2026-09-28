#!/usr/bin/env python3
"""通用建筑 buildings.bin 去重叠/去压路清理（可重复运行，原地改写 buildings.bin + buildings_names.json）。

背景：buildings.bin 由 tools/build_buildings_v2.py 合并 CMAB 屋顶轮廓与 OSM 补充楼生成，
  - CMAB 自身有重复/交叠的多边形（同一栋被识别两次、相邻屋顶互相侵入）；
  - OSM 补充楼只要求“被 CMAB 覆盖 < 20%”，覆盖区外的 OSM 楼之间、OSM 与 CMAB 边缘仍会交叠；
  - 轮廓与道路中心线（roads.json）来源不同，不少楼伸进机动车道路面。
渲染端每栋楼都是独立棱柱，交叠处就是穿模。原始数据（data-src/heights 等）不一定在手边，因此在成品上清理：

1. 去重：较小者 ≥ 50% 落在另一栋内 → 丢弃优先级低的一栋（实测高度 > 有名称 > 面积大）；
   例外：较小者整体在内且高出 ≥ 15 m（塔楼坐裙房）保留两者。
2. 裁切：其余部分交叠，按优先级（实测高度 > 更高 > 面积大）让低优先级的一栋减去高优先级邻楼（外扩 0.3 m 留缝，避免共面闪烁）；
   剩余 < 40% 或 < 15 m² 则丢弃；裁成多块时取最大块。building:part（底高 > 0）与竖向不重叠的不处理。
3. 压路：机动车道（motorway…unclassified 及匝道；隧道、桥梁除外）中心线按渲染路面宽/2（同 roads_net.js，不含人行道）缓冲，
   建筑减去路面；剩余 < 40% 则丢弃（多为已拆除/错位的旧楼）。
锚点重算为新轮廓质心，其余字段（高度、kind、flags、style）不变；名称表按新下标重排。

用法：python tools/clean_buildings.py [--dry] [--no-roads]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bldbin  # noqa: E402
from check_overlap import road_half_width  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / 'public/data/buildings.bin'
NAMES = ROOT / 'public/data/buildings_names.json'
DUP = 0.5
TOWER_DH = 15.0
GAP = 0.3
KEEP_MIN = 0.4
MIN_AREA = 15.0
ROAD_CLS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified',
            'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'}


def largest(g):
    if g.is_empty:
        return None
    if g.geom_type == 'Polygon':
        return g
    ps = [q for q in getattr(g, 'geoms', []) if q.geom_type == 'Polygon']
    return max(ps, key=lambda q: q.area) if ps else None


def clean_poly(g):
    g = largest(shapely.make_valid(g)) if not g.is_valid else g
    if g is None:
        return None
    g = Polygon(g.exterior.coords).simplify(0.2, preserve_topology=True)
    g = largest(shapely.make_valid(g)) if not g.is_valid else g
    return shapely.geometry.polygon.orient(g, 1.0) if g is not None else None


def pieces(g):
    """差集结果拆成 ≥ MIN_AREA 的多边形块（外环、CCW、简化）"""
    if g.is_empty:
        return []
    gs = [g] if g.geom_type == 'Polygon' else [q for q in getattr(g, 'geoms', []) if q.geom_type == 'Polygon']
    out = []
    for q in gs:
        q = clean_poly(q)
        if q is not None and q.area >= MIN_AREA:
            out.append(q)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--no-roads', action='store_true')
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()
    B = bldbin.read(BIN)
    names = json.loads(NAMES.read_text('utf-8'))
    N = B['n']
    polys = []
    for i in range(N):
        p = Polygon(bldbin.ring(B, i))
        if not p.is_valid:
            p = largest(shapely.make_valid(p)) or p
        polys.append(p)
    area = np.array([p.area for p in polys])
    h = np.asarray(B['h'], float)
    ground = np.asarray(B['minh'], float) <= 0.5
    meas = ((B['flags'] & 1) > 0).astype(int)
    named = np.array([str(i) in names for i in range(N)], int)
    tree = STRtree(polys)
    ii, jj = tree.query(polys, predicate='intersects')
    m = (ii != jj) & ground[ii] & ground[jj]
    nb = [[] for _ in range(N)]
    for i, j in zip(ii[m].tolist(), jj[m].tolist()):
        nb[i].append(j)

    def tower_on_podium(small, big):
        """small 整体落在 big 内且高出 ≥ 15 m：有意嵌套"""
        return h[small] >= h[big] + TOWER_DH and polys[small].difference(polys[big]).area <= 0.05 * area[small]

    # —— 1. 去重 ——
    alive = np.ones(N, bool)
    order = sorted(range(N), key=lambda i: (-meas[i], -named[i], -area[i]))
    acc = np.zeros(N, bool)
    n_dup = 0
    for i in order:
        drop = False
        for j in nb[i]:
            if not acc[j]:
                continue
            s, b = (i, j) if area[i] <= area[j] else (j, i)
            inter = polys[i].intersection(polys[j]).area
            if inter >= DUP * area[s] and not tower_on_podium(s, b):
                drop = True
                break
        if drop:
            alive[i] = False
            n_dup += 1
        else:
            acc[i] = True
    # —— 2. 裁切部分交叠（out[i] 为该楼的轮廓块列表；被切成几块时每块单独成楼） ——
    out = [[p] for p in polys]
    orig = [True] * N
    order = sorted(np.nonzero(alive)[0].tolist(), key=lambda i: (-meas[i], -h[i], -area[i]))
    done = np.zeros(N, bool)
    n_clip = n_clipdrop = 0
    for i in order:
        cut = []
        for j in nb[i]:
            if not done[j] or not alive[j]:
                continue
            if tower_on_podium(j, i) or tower_on_podium(i, j):
                continue
            cut += [q for q in out[j] if q.intersection(polys[i]).area > 1.0]
        done[i] = True
        if not cut:
            continue
        ps = pieces(polys[i].difference(shapely.union_all(cut).buffer(GAP, join_style='mitre')))
        if sum(q.area for q in ps) < max(MIN_AREA, KEEP_MIN * area[i]):
            alive[i] = False
            n_clipdrop += 1
        else:
            out[i], orig[i] = ps, False
            n_clip += 1
    # —— 3. 压路 ——
    n_road = n_roaddrop = 0
    road_drops = []
    if not a.no_roads:
        R = json.loads((ROOT / 'public/data/roads.json').read_text('utf-8'))
        keep = {k for k, c in enumerate(R['classes']) if c in ROAD_CLS}
        segs = []
        for f in R['features']:
            if f['c'] not in keep or f.get('t') or f.get('b'):
                continue
            q, hw = f['p'], road_half_width(f, R['classes'])
            for k in range(0, len(q) - 2, 2):
                segs.append(LineString([(q[k], q[k + 1]), (q[k + 2], q[k + 3])]).buffer(hw, cap_style='flat'))
        rt = STRtree(segs)
        live = np.nonzero(alive)[0]
        bi, sj = rt.query([polys[i] for i in live], predicate='intersects')
        hits = {}
        for b, s_ in zip(bi.tolist(), sj.tolist()):
            hits.setdefault(int(live[b]), []).append(s_)
        for i, ss in hits.items():
            u = shapely.union_all([segs[k] for k in ss])
            a0 = sum(q.area for q in out[i])
            ov = sum(q.intersection(u).area for q in out[i])
            if ov <= 2.0:
                continue
            ub = u.buffer(0.15)   # 留一点余量：写回时坐标取整到 0.1 m，再次运行不至于又切出细条
            ps = [r for q in out[i] for r in pieces(q.difference(ub))]
            if sum(q.area for q in ps) < max(MIN_AREA, KEEP_MIN * a0):
                alive[i] = False
                n_roaddrop += 1
                c = polys[i].centroid
                road_drops.append((round(a0), round(ov / a0, 2), round(c.x), round(c.y), names.get(str(i), f'#{i}')))
            else:
                out[i], orig[i] = ps, False
                n_road += 1
    kept = np.nonzero(alive)[0]
    n_out = sum(len(out[i]) for i in kept)
    print(f'buildings.bin：{N} 栋 → {n_out} 栋；去重丢弃 {n_dup}，交叠裁切 {n_clip}（裁后过小丢弃 {n_clipdrop}），'
          f'压路裁切 {n_road}（大部分在路面上而丢弃 {n_roaddrop}）；被切成多块而新增 {n_out - int((alive).sum())}')
    if a.report:
        for r in sorted(road_drops, reverse=True)[:25]:
            print('   压路丢弃（面积, 压路比例, x, z, 名称）', *r)
    if a.dry:
        return
    src, rings, ax, az = [], [], [], []
    for i in kept:
        if orig[i]:
            src.append(i)
            rings.append(bldbin.ring(B, i))
            ax.append(float(B['ax'][i]))
            az.append(float(B['az'][i]))
            continue
        for q in out[i]:
            c = q.centroid
            r = np.array(q.exterior.coords)[:-1]
            if np.abs(r - [c.x, c.y]).max() * 10 > 32000:   # int16 分米越界（不应发生）
                continue
            src.append(i)
            rings.append(r)
            ax.append(c.x)
            az.append(c.y)
    src = np.array(src)
    B2 = {k: (v[src] if isinstance(v, np.ndarray) and len(v) == N else v) for k, v in B.items()}
    B2.update(n=len(src), rings=rings, ax=np.array(ax), az=np.array(az))
    bldbin.write(B2, str(BIN))
    new_names, first = {}, set()
    for k, i in enumerate(src.tolist()):
        if str(i) in names and i not in first:
            new_names[str(k)] = names[str(i)]
            first.add(i)
    NAMES.write_text(json.dumps(new_names, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    print(f'写出 {BIN}（{BIN.stat().st_size / 1e6:.2f} MB）、{NAMES}（{len(new_names)} 个名称）')

if __name__ == '__main__':
    main()
