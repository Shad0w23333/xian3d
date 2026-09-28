"""高度/坐标审计共用的数据加载（tools/check_heights.py、tools/check_coords.py）。

- buildings.bin → shapely 多边形数组（世界坐标）
- Overture 2026-09 building.parquet → 投影到世界坐标的多边形 + height / num_floors / 名称 / OSM 记录号
- Overture place.parquet → 世界坐标点 + 名称（注意：少数来源为 GCJ-02，见 gcj_twin）
- pois.json、skyline.json
全部坐标为世界坐标（tools/geo.py：原点钟楼，X 东、Z 南）。
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bldbin  # noqa: E402
import geo  # noqa: E402

ROOT = HERE.parent
DATA = ROOT / 'public' / 'data'
OVT = ROOT / 'data-src' / 'overture'


def proj_arr(c):
    """经纬度数组 (N,2) → 世界坐标 (N,2)，与 geo.project 一致（向量化）"""
    c = np.asarray(c, np.float64)
    x = (np.radians(c[:, 0]) * geo.R - geo.MX0) * geo.K
    z = -(geo.R * np.log(np.tan(np.pi / 4 + np.radians(c[:, 1]) / 2)) - geo.MY0) * geo.K
    return np.c_[x, z]


def norm(n):
    """名称归一：去空白/标点/括号，小写"""
    return re.sub(r'[\s·・\-—_()（）\[\]【】,，.。"“”]', '', str(n or '')).lower()


def load_bin(path=DATA / 'buildings.bin'):
    """返回 (B, polys)：B 为 bldbin.read() 结构，polys 为 shapely Polygon 数组"""
    import shapely
    B = bldbin.read(str(path))
    n = B['n']
    idx = np.repeat(np.arange(n), B['cnt'].astype(int))
    xy = B['offs'].astype(np.float64) / 10 + np.c_[B['ax'][idx], B['az'][idx]]
    polys = shapely.polygons(shapely.linearrings(xy, indices=idx))
    return B, polys


def load_overture_buildings(only_named_or_measured=False):
    """Overture 建筑（世界坐标）。返回 dict(geom, h, fl, name, cls, rid)"""
    import pyarrow.parquet as pq
    import shapely
    t = pq.read_table(OVT / 'building.parquet', columns=['id', 'names', 'height', 'num_floors', 'geometry', 'sources', 'class'])
    h = np.array([np.nan if v is None else float(v) for v in t.column('height').to_pylist()])
    fl = np.array([np.nan if v is None else float(v) for v in t.column('num_floors').to_pylist()])
    names = [(v or {}).get('primary') or '' for v in t.column('names').to_pylist()]
    keep = np.ones(len(h), bool)
    if only_named_or_measured:
        keep = np.isfinite(h) | np.isfinite(fl) | np.array([bool(s) for s in names])
    ki = np.nonzero(keep)[0]
    g = shapely.from_wkb(t.column('geometry').to_numpy(zero_copy_only=False)[ki])
    g = shapely.make_valid(shapely.transform(g, proj_arr))
    srcs = t.column('sources').to_pylist()
    cls = t.column('class').to_pylist()
    rid = []
    for i in ki:
        r = ''
        for s in srcs[i] or []:
            if s.get('dataset') == 'OpenStreetMap':
                r = s.get('record_id') or ''
                break
        rid.append(r)
    ids = t.column('id').to_pylist()
    return dict(geom=g, h=h[ki], fl=fl[ki], name=[names[i] for i in ki], cls=[cls[i] for i in ki], rid=rid, id=[ids[i] for i in ki])


def load_places():
    """Overture place：世界坐标点 + 名称 + 来源数据集"""
    import pyarrow.parquet as pq
    import shapely
    t = pq.read_table(OVT / 'place.parquet', columns=['names', 'geometry', 'sources', 'basic_category'])
    g = shapely.from_wkb(t.column('geometry').to_numpy(zero_copy_only=False))
    ll = shapely.get_coordinates(g)
    xy = proj_arr(ll)
    names = [(v or {}).get('primary') or '' for v in t.column('names').to_pylist()]
    ds = [','.join(sorted({s.get('dataset') or '' for s in (v or [])})) for v in t.column('sources').to_pylist()]
    return dict(xy=xy, ll=ll, name=names, ds=ds, cat=t.column('basic_category').to_pylist())


def load_pois():
    d = json.loads((DATA / 'pois.json').read_text('utf-8'))['pois']
    return d


def load_skyline():
    return json.loads((DATA / 'skyline.json').read_text('utf-8'))


def gcj_offset_world(x, z):
    """该处 WGS→GCJ 的偏移（世界坐标米，dx 东、dz 南）"""
    from imagery_pack import wgs2gcj
    lon, lat = geo.unproject(x, z)
    glon, glat = wgs2gcj(lon, lat)
    gx, gz = geo.project(glon, glat)
    return gx - x, gz - z


def is_gcj_twin(a, b, tol=60.0):
    """b 是否为 a 的 GCJ-02 偏移版（b ≈ a + GCJ 偏移，西安约东 450 m、南 150 m）"""
    dx, dz = gcj_offset_world(*a)
    return math.hypot(b[0] - a[0] - dx, b[1] - a[1] - dz) < tol


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])
