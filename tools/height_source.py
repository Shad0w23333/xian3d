"""西安 OSM 建筑的高度来源（数据集查询 + 无数据启发式）。

对外接口
--------
load()                                   预加载数据（首次调用 ~1-2 s，之后常驻内存）
building_height(ring_lonlat, area_m2)    -> (height_m | None, source)
heuristic_height(area_m2, perimeter_m, kind, district_hint, lon, lat) -> meters
district_of(lon, lat)                    -> 'wall' | 'ring2' | 'ring3' | 'suburb' | 'county'（供 district_hint 用）

数据（详见 research/heights.md）
--------------------------------
1. CMAB 西安（Zhang et al. 2025, Sci. Data；CC BY 4.0）：逐栋屋顶轮廓 + 高度/层数，WGS84，
   2022-10 影像。覆盖西安—咸阳主城 108.55–109.09E, 33.9–34.42N。矢量数据，用最大重叠匹配。
2. CNBH-10m（Wu et al. 2023, RSE；CC BY 4.0）：2020 年 10 m 建筑高度栅格，覆盖全 MAIN。
3. GHS-BUILT-H ANBH 2018（JRC R2023A；CC BY 4.0）：3″≈100 m 平均净建筑高度，兜底。

三个数据集对高层都有严重低估（机器学习回归的“均值回归”），因此查询结果都经过
用 OSM 实测高度（height / building:levels）标定的单调映射（CALIB，见 tools/heights_eval.py），
再和面积/形状先验结合（见 building_height 内注释）。
返回的 source 字符串：'cmab' / 'cnbh' / 'ghsl'（均已标定）；None 表示无可用数据，请回退到 heuristic_height。

缓存：tools/heights_prepare.py 把原始数据裁剪为 data-src/heights/{cnbh_main.npy, ghsl_main.npy, cmab_xian.npz}；
若缓存不存在，load() 会自动调用它（需要 raw/ 下的原始文件）。
"""
import json
import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import geo  # noqa: E402

ROOT = os.path.dirname(_HERE)
HDIR = os.path.join(ROOT, 'data-src', 'heights')

# ---------------------------------------------------------------------------
# 标定表：数据集原始值 -> 更接近真实的高度（分段线性，单调）。
# 由 tools/heights_eval.py 用 OSM 实测楼（height / levels）拟合后写入 data-src/heights/calib.json；
# 这里是缺省值（没有 calib.json 时使用）。
DEFAULT_CALIB = {
    'cmab': [[0, 0], [200, 200]],
    'cnbh': [[0, 0], [200, 200]],
    'ghsl': [[0, 0], [200, 200]],
}

_S = {}  # 已加载的数据


# ---------------------------------------------------------------- 工具
def project_arr(lon, lat):
    """geo.project 的向量化版本（公式完全相同）。"""
    lon = np.asarray(lon, np.float64)
    lat = np.asarray(lat, np.float64)
    mx = geo.R * np.radians(lon)
    my = geo.R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    return (mx - geo.MX0) * geo.K, -(my - geo.MY0) * geo.K


def _poly_area_perim(x, z):
    a = 0.5 * (np.dot(x, np.roll(z, -1)) - np.dot(z, np.roll(x, -1)))
    p = np.hypot(np.diff(np.r_[x, x[0]]), np.diff(np.r_[z, z[0]])).sum()
    return abs(a), p


def _interp(table, v):
    t = np.asarray(table, np.float64)
    return float(np.interp(v, t[:, 0], t[:, 1]))


# ---------------------------------------------------------------- 加载
def load(force=False):
    if _S and not force:
        return _S
    need = ['cnbh_main.npy', 'cnbh_main.json', 'ghsl_main.npy', 'ghsl_main.json', 'cmab_xian.npz']
    if any(not os.path.exists(os.path.join(HDIR, f)) for f in need):
        import heights_prepare
        heights_prepare.main(['cnbh', 'ghsl', 'cmab'])
    import shapely
    from pyproj import Transformer

    # CNBH（UTM 49N 10 m）
    _S['cnbh'] = np.load(os.path.join(HDIR, 'cnbh_main.npy'), mmap_mode='r')
    _S['cnbh_meta'] = json.load(open(os.path.join(HDIR, 'cnbh_main.json')))
    _S['utm'] = Transformer.from_crs('EPSG:4326', 'EPSG:32649', always_xy=True)
    # GHSL
    _S['ghsl'] = np.load(os.path.join(HDIR, 'ghsl_main.npy'))
    _S['ghsl_meta'] = json.load(open(os.path.join(HDIR, 'ghsl_main.json')))
    # CMAB
    c = np.load(os.path.join(HDIR, 'cmab_xian.npz'))
    x, z = c['x'].astype(np.float64), c['z'].astype(np.float64)
    part_off, ppo = c['part_off'], c['poly_part_off']
    npoly = len(ppo) - 1
    # 只用每栋的第一个环（外环）建几何；CMAB 屋顶几乎没有内环
    first = part_off[ppo[:-1]]
    nxt = part_off[np.minimum(ppo[:-1] + 1, len(part_off) - 1)]
    lens = nxt - first
    ok = (lens >= 4) & np.isfinite(c['h']) & (np.abs(x[first]) < 2e5)
    idx = np.nonzero(ok)[0]
    coords_idx = np.concatenate([np.arange(first[i], nxt[i]) for i in idx])
    ring_off = np.r_[0, np.cumsum(lens[idx])]
    coords = np.c_[x[coords_idx], z[coords_idx]]
    rings = shapely.from_ragged_array(shapely.GeometryType.POLYGON, coords,
                                      (ring_off, np.arange(len(idx) + 1)))
    rings = shapely.make_valid(rings)
    _S['cmab_geom'] = rings
    _S['cmab_idx'] = idx
    _S['cmab_h'] = c['h'][idx].astype(np.float64)
    _S['cmab_floor'] = c['floor'][idx]
    _S['cmab_area'] = shapely.area(rings)
    _S['cmab_tree'] = shapely.STRtree(rings)
    _S['cmab_func'] = c['func'][idx]
    _S['cmab_func_names'] = list(c['func_names'])
    _S['cmab_npoly'] = npoly
    # 标定
    cp = os.path.join(HDIR, 'calib.json')
    _S['calib'] = json.load(open(cp)) if os.path.exists(cp) else DEFAULT_CALIB
    return _S


# ---------------------------------------------------------------- 各数据集原始查询
def cmab_lookup(poly, area):
    """poly: shapely 多边形（世界坐标）。返回 (原始高度, 覆盖率, 匹配数) 或 None。"""
    import shapely
    S = _S
    cand = S['cmab_tree'].query(poly, predicate='intersects')
    if len(cand) == 0:
        return None
    inter = shapely.area(shapely.intersection(poly, S['cmab_geom'][cand]))
    b = S['cmab_area'][cand]
    # 有效候选：重叠至少占两者中较小者的 30%
    good = inter >= 0.3 * np.minimum(area, b)
    if not good.any():
        return None
    inter, hh = inter[good], S['cmab_h'][cand][good]
    cover = min(1.0, inter.sum() / max(area, 1e-6))
    if cover < 0.25:
        return None
    # 按重叠面积加权的 80 分位（塔楼+裙房合成一个 OSM 轮廓时取到塔楼）
    o = np.argsort(hh)
    cw = np.cumsum(inter[o]) / inter.sum()
    h = hh[o][np.searchsorted(cw, 0.8)]
    return float(h), float(cover), int(good.sum())


def _cnbh_pixels(lon, lat):
    S = _S
    m = S['cnbh_meta']
    ex, ny = S['utm'].transform(np.asarray(lon), np.asarray(lat))
    col = (ex - m['x0']) / m['px']
    row = (m['y1'] - ny) / m['px']
    return col, row


def _points_in_poly(px, py, vx, vy):
    """射线法：点 (px,py) 数组是否在多边形 (vx,vy) 内。"""
    inside = np.zeros(px.shape, bool)
    n = len(vx)
    j = n - 1
    for i in range(n):
        xi, yi, xj, yj = vx[i], vy[i], vx[j], vy[j]
        cond = ((yi > py) != (yj > py))
        with np.errstate(divide='ignore', invalid='ignore'):
            xint = (xj - xi) * (py - yi) / (yj - yi + 1e-300) + xi
        inside ^= cond & (px < xint)
        j = i
    return inside


def raster_sample(arr, col, row, q):
    """在栅格 arr 上取多边形（像素坐标 col,row 的外环）内像素中心的值。
    小于 3 个像素时退化为：多边形顶点 + 质心所在像素。返回 (q 分位, 非零占比, 像素数) 或 None。"""
    H, W = arr.shape
    c0 = int(math.floor(col.min())); c1 = int(math.ceil(col.max()))
    r0 = int(math.floor(row.min())); r1 = int(math.ceil(row.max()))
    if c1 < 0 or r1 < 0 or c0 >= W or r0 >= H:
        return None
    c0 = max(c0, 0); r0 = max(r0, 0); c1 = min(c1, W - 1); r1 = min(r1, H - 1)
    cc, rr = np.meshgrid(np.arange(c0, c1 + 1), np.arange(r0, r1 + 1))
    ins = _points_in_poly(cc.ravel() + 0.5, rr.ravel() + 0.5, col, row)
    if ins.sum() >= 3:
        vals = np.asarray(arr[r0:r1 + 1, c0:c1 + 1]).ravel()[ins]
    else:
        pc = np.r_[col, col.mean()].astype(int).clip(0, W - 1)
        pr = np.r_[row, row.mean()].astype(int).clip(0, H - 1)
        key = np.unique(pr * W + pc)
        vals = np.asarray(arr[key // W, key % W])
    nz = vals[vals > 0]
    if nz.size == 0:
        return (0.0, 0.0, int(vals.size))
    return float(np.percentile(nz, q)) / 10.0, nz.size / vals.size, int(vals.size)


def cnbh_sample(lon, lat, q=90):
    col, row = _cnbh_pixels(lon, lat)
    return raster_sample(_S['cnbh'], col, row, q)


def ghsl_sample(lon, lat, q=90):
    m = _S['ghsl_meta']
    col = (np.asarray(lon) - m['lon0']) / m['dlon']
    row = (m['lat1'] - np.asarray(lat)) / m['dlat']
    return raster_sample(_S['ghsl'], col, row, q)


# ---------------------------------------------------------------- 对外：数据集高度
def building_height(ring_lonlat, area_m2=None):
    """ring_lonlat: [(lon,lat),...] 外环（首尾是否重复均可）。area_m2: 轮廓面积（None 时自己算）。
    返回 (height_m, source)；无数据时 (None, 'none')。"""
    import shapely
    if not _S:
        load()
    ll = np.asarray(ring_lonlat, np.float64)
    if len(ll) >= 2 and np.allclose(ll[0], ll[-1]):
        ll = ll[:-1]
    if len(ll) < 3:
        return None, 'none'
    x, z = project_arr(ll[:, 0], ll[:, 1])
    a_calc, perim = _poly_area_perim(x, z)
    area = float(area_m2) if area_m2 else a_calc
    cal = _S['calib']

    # 1) CMAB 逐栋矢量
    poly = shapely.make_valid(shapely.Polygon(np.c_[x, z]))
    r = cmab_lookup(poly, max(area, 1.0))
    if r is not None:
        h_raw = r[0]
        return round(_interp(cal['cmab'], h_raw), 1), 'cmab'

    # 2) CNBH 10 m 栅格：轮廓内非零像素 90 分位，且建筑像素占比 ≥ 30%
    r = cnbh_sample(ll[:, 0], ll[:, 1], 90)
    if r is not None and r[1] >= 0.3 and r[0] > 0:
        return round(_interp(cal['cnbh'], r[0]), 1), 'cnbh'

    # 3) GHS-BUILT-H 100 m 兜底
    r = ghsl_sample(ll[:, 0], ll[:, 1], 90)
    if r is not None and r[0] > 0:
        return round(_interp(cal['ghsl'], r[0]), 1), 'ghsl'
    return None, 'none'


# ---------------------------------------------------------------- 启发式
def district_of(lon, lat):
    """粗分区（基于到钟楼的距离与城墙范围，近似二环≈4.5 km、三环≈9 km 半径）。"""
    if 108.9215 <= lon <= 108.9660 and 34.2470 <= lat <= 34.2800:
        return 'wall'
    x, z = geo.project(lon, lat)
    d = math.hypot(x, z)
    if d < 5000:
        return 'ring2'
    if d < 10500:
        return 'ring3'
    if d < 20000:
        return 'suburb'
    return 'county'


def heuristic_height(area_m2, perimeter_m, kind, district_hint, lon, lat):
    """无数据时的高度估计（米）。见 research/heights.md 第 5 节。"""
    return 12.0


if __name__ == '__main__':
    pass
