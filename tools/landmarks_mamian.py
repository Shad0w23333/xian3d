"""从 OSM 城墙外环提取马面（敌台）位置与尺寸（历史地标调研用）。

外环相对中心线的外向距离 > THR 的连续段视为外凸体：
  凸出 8~20 m 且沿墙长 12~35 m → 马面；更大的 → 瓮城/角台（另行处理）。
输出 data-src/landmarks_historic/wall_mamian.json
"""
import json
import os
import sys

import numpy as np
from shapely.geometry import Polygon, Point, LineString

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from landmarks_wall import load  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data-src', 'landmarks_historic')


def main():
    cl = json.load(open(os.path.join(SRC, 'wall_centerline.json')))
    poly = np.array(cl['polygon'])
    nw = np.array(cl['corners']['NW'])
    i0 = int(np.argmin(np.hypot(*(poly - nw).T)))
    ring = np.vstack([poly[i0:], poly[:i0], poly[i0:i0 + 1]])
    line = LineString(ring)
    C = Polygon(poly)
    els, po, pi = load()
    o = po.exterior
    step = 1.0
    samples = []
    for t in np.arange(0, o.length, step):
        p = o.interpolate(t)
        dist = line.distance(p) * (1 if not C.contains(p) else -1)
        samples.append((p.x, p.y, dist, line.project(p)))
    s = np.array(samples)
    # 墙外皮基线（到中心线距离）的中位数
    base = np.median(s[(s[:, 2] > 0) & (s[:, 2] < 14), 2])
    THR = base + 5.0
    out = s[:, 2] > THR
    # 连续段
    segs = []
    i = 0
    n = len(s)
    while i < n:
        if out[i]:
            j = i
            while j + 1 < n and out[j + 1]:
                j += 1
            segs.append((i, j))
            i = j + 1
        else:
            i += 1
    # 环首尾合并
    if segs and segs[0][0] == 0 and segs[-1][1] == n - 1:
        a = segs.pop(0); b = segs.pop()
        segs.append((b[0], a[1] + n))
    mam, big = [], []
    for a, b in segs:
        idx = np.arange(a, b + 1) % n
        seg = s[idx]
        ch = seg[:, 3]
        # 处理跨越起点
        if ch.max() - ch.min() > line.length / 2:
            ch = np.where(ch < line.length / 2, ch + line.length, ch)
        width = ch.max() - ch.min()
        proj = seg[:, 2].max() - base
        c = (ch.max() + ch.min()) / 2 % line.length
        q = line.interpolate(c)
        rec = {'chainage_m': round(float(c), 1), 'center_on_centerline': [round(q.x, 1), round(q.y, 1)],
               'width_along_wall_m': round(float(width), 1), 'projection_beyond_face_m': round(float(proj), 1)}
        if 8 <= width <= 40 and 5 <= proj <= 22:
            mam.append(rec)
        else:
            big.append(rec)
    mam.sort(key=lambda r: r['chainage_m'])
    ch = np.array([m['chainage_m'] for m in mam])
    gaps = np.diff(ch)
    res = {'outer_face_offset_from_centerline_m': round(float(base), 1),
           'count': len(mam), 'spacing_m_p25_p50_p75': np.percentile(gaps, [25, 50, 75]).round(1).tolist(),
           'width_m_p50': float(np.median([m['width_along_wall_m'] for m in mam])),
           'projection_m_p50': float(np.median([m['projection_beyond_face_m'] for m in mam])),
           'mamian': mam, 'other_protrusions': big}
    json.dump(res, open(os.path.join(SRC, 'wall_mamian.json'), 'w'), ensure_ascii=False, indent=1)
    print({k: v for k, v in res.items() if k not in ('mamian', 'other_protrusions')})
    for b in big:
        print('big', b)


if __name__ == '__main__':
    main()
