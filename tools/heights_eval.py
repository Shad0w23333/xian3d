"""用 OSM 实测高度（height / building:levels）评估 CMAB / CNBH / GHSL，并拟合单调标定表。

步骤
  1. 读 data-src/heights/raw/osm/osm_tagged_heights.json（Overpass：MAIN 内带 height 或 building:levels 的建筑）
  2. 对每栋楼查三个数据集的原始值，逐栋落盘 data-src/heights/eval_rows.csv
  3. 打印误差统计（按真实高度分档）；用 5 折交叉验证评估“标定后”的误差
  4. 用全部样本拟合标定表写 data-src/heights/calib.json（height_source.load() 会读取）

用法：.venv-tools/bin/python tools/heights_eval.py [--no-calib]
"""
import csv
import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import height_source as hs  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HDIR = os.path.join(ROOT, 'data-src', 'heights')
LEVEL_H = 3.2   # 与 CONTRACT 3.4 一致：levels×3.2


def parse_height(v):
    if v is None:
        return None
    m = re.match(r'^\s*([0-9]+(?:\.[0-9]+)?)\s*(m|米|meters?)?\s*$', v)
    return float(m.group(1)) if m else None


def parse_levels(v):
    if v is None:
        return None
    m = re.match(r'^\s*([0-9]+)(?:\.0)?\s*$', v)
    return int(m.group(1)) if m else None


def osm_rings():
    d = json.load(open(os.path.join(HDIR, 'raw', 'osm', 'osm_tagged_heights.json')))
    out = []
    for e in d['elements']:
        t = e.get('tags', {})
        if 'building' not in t:
            continue   # 只评估 building，不评估 building:part
        ring = None
        if e['type'] == 'way' and e.get('geometry'):
            ring = [(p['lon'], p['lat']) for p in e['geometry']]
        elif e['type'] == 'relation':
            for m in e.get('members', []):
                if m.get('role') == 'outer' and m.get('geometry'):
                    ring = [(p['lon'], p['lat']) for p in m['geometry']]
                    break
        if not ring or len(ring) < 4:
            continue
        h = parse_height(t.get('height'))
        lv = parse_levels(t.get('building:levels'))
        if h is None and lv is None:
            continue
        if h is not None and (h < 2 or h > 400):
            h = None
        if lv is not None and (lv < 1 or lv > 100):
            lv = None
        if h is None and lv is None:
            continue
        truth = h if h is not None else lv * LEVEL_H
        out.append(dict(id=f"{e['type'][0]}{e['id']}", ring=ring, truth=truth,
                        src='height' if h is not None else 'levels', levels=lv or 0,
                        name=t.get('name', ''), building=t.get('building', '')))
    return out


def compute_rows():
    import shapely
    hs.load()
    rows = []
    for b in osm_rings():
        ll = np.asarray(b['ring'], np.float64)
        if np.allclose(ll[0], ll[-1]):
            ll = ll[:-1]
        x, z = hs.project_arr(ll[:, 0], ll[:, 1])
        area, perim = hs._poly_area_perim(x, z)
        poly = shapely.make_valid(shapely.Polygon(np.c_[x, z]))
        r = hs.cmab_lookup(poly, max(area, 1.0))
        c90 = hs.cnbh_sample(ll[:, 0], ll[:, 1], 90)
        c50 = hs.cnbh_sample(ll[:, 0], ll[:, 1], 50)
        cmx = hs.cnbh_sample(ll[:, 0], ll[:, 1], 100)
        g = hs.ghsl_sample(ll[:, 0], ll[:, 1], 90)
        lon, lat = ll[:, 0].mean(), ll[:, 1].mean()
        rows.append(dict(
            id=b['id'], name=b['name'], building=b['building'], truth=round(b['truth'], 2), tsrc=b['src'],
            levels=b['levels'], lon=round(lon, 6), lat=round(lat, 6), area=round(area, 1), perim=round(perim, 1),
            district=hs.district_of(lon, lat),
            cmab=round(r[0], 2) if r else '', cmab_cover=round(r[1], 3) if r else '', cmab_n=r[2] if r else 0,
            cnbh90=round(c90[0], 2) if c90 else '', cnbh50=round(c50[0], 2) if c50 else '',
            cnbhmax=round(cmx[0], 2) if cmx else '', cnbh_frac=round(c90[1], 3) if c90 else '',
            ghsl=round(g[0], 2) if g else '',
            heur=round(hs.heuristic_height(area, perim, b['building'], hs.district_of(lon, lat), lon, lat), 2),
        ))
    with open(os.path.join(HDIR, 'eval_rows.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return rows


def load_rows():
    rows = list(csv.DictReader(open(os.path.join(HDIR, 'eval_rows.csv'))))
    for r in rows:
        for k in ('truth', 'area', 'perim', 'cmab', 'cmab_cover', 'cnbh90', 'cnbh50', 'cnbhmax', 'cnbh_frac',
                  'ghsl', 'heur', 'lon', 'lat'):
            r[k] = float(r[k]) if r.get(k, '') not in ('', None) else np.nan
        r['levels'] = int(r['levels'])
    return rows


BINS = [(0, 12), (12, 24), (24, 50), (50, 100), (100, 1000)]


def stats(truth, pred, label):
    ok = np.isfinite(truth) & np.isfinite(pred)
    t, p = truth[ok], pred[ok]
    if len(t) < 3:
        print(f'  {label:<26} n={len(t)}')
        return
    e = p - t
    r = np.corrcoef(t, p)[0, 1]
    s = f'  {label:<26} n={len(t):4d} 偏差={e.mean():+6.1f} MAE={np.abs(e).mean():5.1f} RMSE={np.sqrt((e**2).mean()):5.1f} R={r:.2f} |'
    for lo, hi in BINS:
        m = (t >= lo) & (t < hi)
        if m.sum() >= 3:
            s += f' {lo}-{hi}:{e[m].mean():+.0f}({m.sum()})'
    print(s)


def fit_monotone(x, y, knots):
    """分段线性单调映射：在 knots 处取 y 的中位数（按 x 分箱），再做累积最大保证单调。"""
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    pts = [[0.0, 0.0]]
    for i in range(len(knots) - 1):
        m = (x >= knots[i]) & (x < knots[i + 1])
        if m.sum() >= 8:
            pts.append([float(np.median(x[m])), float(np.median(y[m]))])
    # 单调化
    ys = np.maximum.accumulate(np.array([p[1] for p in pts]))
    pts = [[p[0], float(v)] for p, v in zip(pts, ys)]
    # 外推：最后一段按斜率 1 延长到 400
    lx, ly = pts[-1]
    pts.append([400.0, ly + (400.0 - lx)])
    return pts


def main():
    rows = compute_rows() if '--reuse' not in sys.argv else load_rows()
    if '--reuse' not in sys.argv:
        rows = load_rows()
    T = np.array([r['truth'] for r in rows])
    src = np.array([r['tsrc'] for r in rows])
    print('样本', len(rows), 'height 标签', (src == 'height').sum(), 'levels 标签', (src == 'levels').sum())
    for sel_name, sel in [('全部', np.ones(len(rows), bool)), ('仅 height 标签', src == 'height')]:
        print('==', sel_name)
        for k in ('cmab', 'cnbh90', 'cnbh50', 'cnbhmax', 'ghsl', 'heur'):
            stats(T[sel], np.array([r[k] for r in rows])[sel], k)
    # 覆盖率
    for k in ('cmab', 'cnbh90', 'ghsl'):
        v = np.array([r[k] for r in rows])
        print(f'  {k} 命中率 {np.isfinite(v).mean():.2f}')

    if '--no-calib' in sys.argv:
        return
    knots = {'cmab': [0, 6, 9, 12, 15, 18, 22, 26, 30, 36, 45, 60, 400],
             'cnbh': [0, 6, 9, 12, 15, 18, 21, 24, 27, 30, 400],
             'ghsl': [0, 6, 9, 12, 15, 18, 21, 25, 30, 400]}
    cols = {'cmab': 'cmab', 'cnbh': 'cnbh90', 'ghsl': 'ghsl'}
    # 5 折交叉验证
    rng = np.random.default_rng(0)
    fold = rng.integers(0, 5, len(rows))
    print('== 5 折交叉验证（标定后）')
    for key, col in cols.items():
        X = np.array([r[col] for r in rows])
        pred = np.full(len(rows), np.nan)
        for f in range(5):
            tab = fit_monotone(X[fold != f], T[fold != f], knots[key])
            m = (fold == f) & np.isfinite(X)
            pred[m] = np.interp(X[m], [p[0] for p in tab], [p[1] for p in tab])
        stats(T, pred, key + ' 标定(CV)')
    calib = {k: fit_monotone(np.array([r[c] for r in rows]), T, knots[k]) for k, c in cols.items()}
    json.dump(calib, open(os.path.join(HDIR, 'calib.json'), 'w'), indent=1)
    print('calib.json 已写入')
    for k, v in calib.items():
        print(' ', k, [[round(a, 1), round(b, 1)] for a, b in v])


if __name__ == '__main__':
    main()
