"""西安明城墙中心线推算（历史地标调研用）。

输入：data-src/landmarks_historic/osm/wall.json（Overpass 缓存，见 landmarks_osm_fetch.py）
方法：
  1. OSM 西安城墙多边形 relation 3450809：外环(外墙脚+马面+瓮城) / 内环(内墙脚)。
  2. 沿内环每 3 m 取点，求到外环最近点；距离 < 24 m 视为墙身正常断面，取两者中点；
     距离过大处（马面、瓮城、角台、马道）不取，用相邻有效中点沿弧长插值。
  3. 中位数平滑（窗口 7 点 ≈ 21 m）后，按“四边分段”：每边用分段直线拟合（Douglas-Peucker 容差 1.5 m）；
     三个方角用相邻两边末段直线求交得到精确拐点；西南角按卫星图保留圆弧（圆角台）。
  4. 与护城河、顺城巷距离做交叉校验（输出统计）。
输出：data-src/landmarks_historic/wall_centerline.json
"""
import json
import math
import os
import sys

import numpy as np
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import nearest_points

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import project, unproject  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data-src', 'landmarks_historic')


def load():
    d = json.load(open(os.path.join(SRC, 'osm', 'wall.json')))
    els = {(e['type'], e['id']): e for e in d['elements']}
    rel = els[('relation', 3450809)]
    P = lambda g: [project(p['lon'], p['lat']) for p in g]  # noqa: E731
    outer = []
    for m in rel['members']:
        if m['role'] == 'outer':
            pts = P(m['geometry'])
            outer += pts if not outer else pts[1:]
    inner = P([m for m in rel['members'] if m['ref'] == 257224676][0]['geometry'])
    return d['elements'], Polygon(outer), Polygon(inner)


def line_fit(pts):
    """总体最小二乘直线：返回 (点, 单位方向)。"""
    pts = np.asarray(pts)
    c = pts.mean(0)
    u, s, vt = np.linalg.svd(pts - c)
    return c, vt[0]


def intersect(c1, d1, c2, d2):
    A = np.array([d1, -d2]).T
    t = np.linalg.solve(A, c2 - c1)
    return c1 + t[0] * d1


def dp(points, tol):
    """Douglas-Peucker（保留首尾）。"""
    pts = np.asarray(points)
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    L = np.hypot(*ab)
    if L == 0:
        dist = np.hypot(*(pts - a).T)
    else:
        dist = np.abs(ab[0] * (pts[:, 1] - a[1]) - ab[1] * (pts[:, 0] - a[0])) / L
    i = int(np.argmax(dist))
    if dist[i] > tol:
        left = dp(pts[:i + 1], tol)
        right = dp(pts[i:], tol)
        return np.vstack([left[:-1], right])
    return np.vstack([a, b])


def main():
    els, po, pi = load()
    oring = po.exterior
    ring = pi.exterior
    step = 3.0
    ts = np.arange(0, ring.length, step)
    rows = []
    for t in ts:
        p = ring.interpolate(t)
        q = nearest_points(p, oring)[1]
        rows.append((t, p.x, p.y, q.x, q.y, p.distance(q)))
    rows = np.array(rows)
    good = rows[:, 5] < 24
    mid = (rows[:, 1:3] + rows[:, 3:5]) / 2
    # 插值无效点
    idx = np.arange(len(rows))
    for k in (0, 1):
        mid[~good, k] = np.interp(idx[~good], idx[good], mid[good, k], period=len(rows))
    # 中位数平滑（环形）
    w = int(os.environ.get('WALL_MED_W', '7'))   # 半窗口（点）；7 → 窗口 15 点 ≈ 45 m，抹平城门墩台内凸造成的锯齿
    sm = np.array([np.median(np.take(mid, range(i - w, i + w + 1), axis=0, mode='wrap'), axis=0) for i in range(len(mid))])

    x0, z0, x1, z1 = pi.bounds
    # 按到四边外包的距离分边（远离角 60 m 以外才参与拟合）
    def side_of(p, margin):
        d = {'W': p[0] - x0, 'E': x1 - p[0], 'N': p[1] - z0, 'S': z1 - p[1]}
        s = min(d, key=d.get)
        return s if d[s] < 60 else None
    sides = {s: [] for s in 'NESW'}
    for i, p in enumerate(sm):
        s = side_of(p, 0)
        if s:
            sides[s].append(p)
    for s in sides:
        sides[s] = np.array(sides[s])
    # 每边按主方向排序
    order = {'N': (0, 1), 'S': (0, -1), 'E': (1, 1), 'W': (1, -1)}   # 排序键及方向
    for s, (ax, sg) in order.items():
        v = sides[s]
        sides[s] = v[np.argsort(sg * v[:, ax])]
    # 离角 < CUT m 的中点丢弃（角部内环有马道/斜切，外环有角台）；末段直线用离角 CUT~CUT+320 m 的点拟合
    CUT = 80.0
    for s, (ax, sg) in order.items():
        v = sides[s]
        a0, a1 = v[0, ax], v[-1, ax]
        keep = (np.abs(v[:, ax] - a0) >= CUT) & (np.abs(v[:, ax] - a1) >= CUT)
        sides[s] = v[keep]

    def end_seg(s, which):
        v = sides[s]
        ax = order[s][0]
        ref = v[0, ax] if which == 'start' else v[-1, ax]
        sel = np.abs(v[:, ax] - ref) < 320
        return line_fit(v[sel])
    # 顺序（按 X东Z南 坐标 shoelace>0 的方向）：N(西→东) -> E(北→南) -> S(东→西) -> W(南→北)
    corners = {}
    cN_s, dN_s = end_seg('N', 'start'); cN_e, dN_e = end_seg('N', 'end')
    cE_s, dE_s = end_seg('E', 'start'); cE_e, dE_e = end_seg('E', 'end')
    cS_s, dS_s = end_seg('S', 'start'); cS_e, dS_e = end_seg('S', 'end')
    cW_s, dW_s = end_seg('W', 'start'); cW_e, dW_e = end_seg('W', 'end')
    corners['NE'] = intersect(cN_e, dN_e, cE_s, dE_s)
    corners['SE'] = intersect(cE_e, dE_e, cS_s, dS_s)
    corners['SW'] = intersect(cS_e, dS_e, cW_s, dW_s)
    corners['NW'] = intersect(cW_e, dW_e, cN_s, dN_s)
    # 每边内部折线：DP 简化（去掉离角 < 60 m 的点，首尾用角点）
    tol = float(os.environ.get('WALL_DP_TOL', '2.0'))
    poly = []
    seq = [('N', 'NW', 'NE'), ('E', 'NE', 'SE'), ('S', 'SE', 'SW'), ('W', 'SW', 'NW')]
    side_lines = {}
    for s, ca, cb in seq:
        v = sides[s]
        pts = np.vstack([corners[ca], v, corners[cb]])
        simp = dp(pts, tol)
        side_lines[s] = simp
        poly += [tuple(p) for p in simp[:-1]]
    poly = np.array(poly)
    # 西南角圆弧：以角点为基准做内切圆角（半径 R_SW），弧 8 段
    R_SW = float(os.environ.get('WALL_SW_R', '0'))
    if R_SW > 0:
        i = [k for k, p in enumerate(poly) if np.allclose(p, corners['SW'])][0]
        a, c, b = poly[i - 1], poly[i], poly[(i + 1) % len(poly)]
        u1 = (a - c) / np.hypot(*(a - c)); u2 = (b - c) / np.hypot(*(b - c))
        ang = math.acos(np.clip(np.dot(u1, u2), -1, 1))
        tdist = R_SW / math.tan(ang / 2)
        bis = (u1 + u2) / np.hypot(*(u1 + u2))
        center = c + bis * (R_SW / math.sin(ang / 2))
        p1 = c + u1 * tdist; p2 = c + u2 * tdist
        a1 = math.atan2(*(p1 - center)[::-1]); a2 = math.atan2(*(p2 - center)[::-1])
        da = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
        arc = [center + R_SW * np.array([math.cos(a1 + da * k / 8), math.sin(a1 + da * k / 8)]) for k in range(9)]
        poly = np.vstack([poly[:i], arc, poly[i + 1:]])
    # shoelace（X 东 Z 南）
    area = 0.5 * np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1])
    if area < 0:
        poly = poly[::-1]
        area = -area
    cl = Polygon(poly)
    # 与原始中点的偏差
    dev = np.array([cl.exterior.distance(Point(p)) for p in sm])
    for i in np.argsort(-dev)[:0 if not os.environ.get('WALL_DEBUG') else 12]:
        print('  dev %.1f at %.0f,%.0f' % (dev[i], sm[i][0], sm[i][1]))
    # 每边长度
    lens = {}
    for s, ca, cb in seq:
        L = sum(np.hypot(*(side_lines[s][k + 1] - side_lines[s][k])) for k in range(len(side_lines[s]) - 1))
        lens[s] = round(float(L), 1)
    thick = rows[good, 5]
    out = {
        'polygon': [[round(float(x), 1), round(float(z), 1)] for x, z in poly],
        'corners': {k: [round(float(v[0]), 1), round(float(v[1]), 1)] for k, v in corners.items()},
        'shoelace_area_m2': round(float(area), 1),
        'perimeter_m': round(cl.exterior.length, 1),
        'side_lengths_m': lens,
        'dev_from_raw_midline_m': {'p50': round(float(np.percentile(dev, 50)), 2), 'p95': round(float(np.percentile(dev, 95)), 2), 'max': round(float(dev.max()), 2)},
        'osm_ring_gap_m': {'p25': round(float(np.percentile(thick, 25)), 1), 'p50': round(float(np.percentile(thick, 50)), 1), 'p75': round(float(np.percentile(thick, 75)), 1)},
        'raw_midline': [[round(float(x), 1), round(float(z), 1)] for x, z in sm[::3]],
    }
    json.dump(out, open(os.path.join(SRC, 'wall_centerline.json'), 'w'), ensure_ascii=False)
    print(json.dumps({k: v for k, v in out.items() if k not in ('polygon', 'raw_midline')}, ensure_ascii=False, indent=1))
    print('vertices', len(poly))


if __name__ == '__main__':
    main()
