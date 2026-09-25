#!/usr/bin/env python3
"""重建全部城市建筑：public/data/buildings.bin（v2）+ buildings_names.json。

数据与流程（可重复运行，中间结果缓存在 data-src/buildings_v2/）
------------------------------------------------------------------
1. 轮廓
   - CMAB 西安（data-src/heights/cmab_xian.npz，2022 屋顶轮廓，覆盖 108.55–109.09E, 33.9–34.42N）为主；
     清洗非法坐标（x≈-1e7）、多部件拆分、make_valid。
   - 对齐：tools/buildings_v2_align.py 用 Esri z17 影像目视 + 与 OSM 互相关检查，CMAB 与影像/OSM 无系统偏移
     （各窗口 ±10 m 内随机、中位 ≈5 m，量级等于屋顶/底座投影差），因此 **不做平移**（ALIGN_SHIFT=0）。
   - OSM（Geofabrik PBF 全量提取，tools/extract_osm_buildings_main.py）：CMAB 覆盖区内只补 CMAB 没有的楼
     （被 CMAB 覆盖 < 20% 的 OSM 楼）；覆盖区外（咸阳机场、阎良、渭北……）全部用 OSM。
   - 去掉面积 < 15 m²；Douglas-Peucker 0.4 m；城墙中心线 ≤ 12 m 的长条“建筑”删除。
2. 高度（核心问题）
   - **CMAB 自带高度 pred_h_r / Floor 在西安这份数据里与真值完全不相关**（与 OSM 实测楼 R≈-0.02，
     与 CNBH-10m 栅格 R≈0.05，街区平均也不相关），无法“标定”，因此只把 CMAB 当作轮廓 + 功能 + 年代来源。
   - 高度 = OSM 实测（height / building:levels×3.2）> skyline.json 已调研地标 > 模型预测。
   - 模型：以 OSM 实测楼为标签的梯度提升回归（log 高度），特征 = CNBH-10m 轮廓内分位数、3D-GloBFP 逐栋高度、
     GHSL、轮廓形态（面积/长宽比/紧凑度）、日照间距（南北向最近楼距离）、周边覆盖率与邻域 CNBH、CMAB 功能/年代等；
     空间分组 5 折交叉验证得到袋外预测，再用保序回归把袋外预测映射回真值（去掉“回归均值”造成的高层压缩）。
   - 最后按层高取整（住宅 3.0 m/层，其余 3.6~4.2 m）。
3. kind 与 style
   - kind：OSM 标签（最大重叠匹配）优先，否则 CMAB 功能（居住/商服/办公/工业/公服）。
   - style（v2 新增）：bits0-3 年代（CMAB Age），bits4-7 功能细分（高层塔楼/多层板楼/别墅低层/城中村/办公/商业/工业/公共）。
4. 输出：见 docs/CONTRACT.md 3.4（v2）。

用法：.venv-tools/bin/python tools/build_buildings_v2.py [--refresh]    （--refresh 忽略中间缓存）
"""
from __future__ import annotations

import json
import math
import os
import re
import struct
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import geo  # noqa: E402

ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'data-src')
CACHE = os.path.join(SRC, 'buildings_v2')
OUT = os.path.join(ROOT, 'public', 'data')
CMAB_NPZ = os.path.join(SRC, 'heights', 'cmab_xian.npz')
OSM_MAIN = os.path.join(CACHE, 'osm_buildings_main.json')
GLOBFP = [os.path.join(SRC, 'heights', 'raw', 'globfp', 'g2184', '2184_108.75_33.75_110.0_35.0_shaanxiCN'),
          os.path.join(SRC, 'heights', 'raw', 'globfp', 'g2183', '2183_107.5_33.75_108.75_35.0_gansuCN_shaanxiCN')]
CNBH = os.path.join(SRC, 'heights', 'cnbh_main.npy')
GHSL = os.path.join(SRC, 'heights', 'ghsl_main.npy')
WALL = os.path.join(SRC, 'landmarks_historic', 'wall_centerline.json')
SKYLINE = os.path.join(OUT, 'skyline.json')

ALIGN_SHIFT = (0.0, 0.0)   # CMAB→影像平移（米）；对齐检查结论为 0，见模块说明
MIN_AREA = 15.0
DP_TOL = 0.4
LEVEL_H = 3.2              # CONTRACT 3.4：building:levels × 3.2 m
REFRESH = '--refresh' in sys.argv

KIND_NAMES = ['通用', '住宅', '商业/办公', '工业', '公共/政府', '历史/宗教', '交通', '学校/医院', '酒店']
STYLE_FUNC_NAMES = ['未知', '居住高层塔楼', '居住多层板楼', '别墅/低层', '城中村自建房', '办公', '商业综合体', '工业厂房', '公共']
STYLE_AGE_NAMES = ['未知', '1990前', '1990s', '2000s', '2010s', '2020+']


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def project_arr(lon, lat):
    lon = np.asarray(lon, np.float64)
    lat = np.asarray(lat, np.float64)
    mx = geo.R * np.radians(lon)
    my = geo.R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    return (mx - geo.MX0) * geo.K, -(my - geo.MY0) * geo.K


def unproject_arr(x, z):
    mx = np.asarray(x) / geo.K + geo.MX0
    my = -np.asarray(z) / geo.K + geo.MY0
    return np.degrees(mx / geo.R), np.degrees(2 * np.arctan(np.exp(my / geo.R)) - np.pi / 2)


def num(v):
    if v is None:
        return None
    m = re.match(r'^\s*([0-9]+(?:\.[0-9]+)?)\s*(m|米|meters?)?\s*$', str(v).replace(',', '.'))
    return float(m.group(1)) if m else None


def name_of(tags):
    return (tags.get('name:zh-Hans') or tags.get('name:zh') or tags.get('name') or '').strip()


# =====================================================================================
# 1. 轮廓
# =====================================================================================
def load_cmab():
    """返回 dict：geoms(shapely 数组, 世界坐标), src_idx(CMAB 行号), func, age。"""
    import shapely
    c = np.load(CMAB_NPZ)
    A = {k: c[k] for k in c.files}   # npz 每取一次键都会重新解压，先全部取出
    x = A['x'].astype(np.float64) + ALIGN_SHIFT[0]
    z = A['z'].astype(np.float64) + ALIGN_SHIFT[1]
    po, ppo = A['part_off'], A['poly_part_off']
    n = len(ppo) - 1
    bad_v = ~np.isfinite(x) | ~np.isfinite(z) | (np.abs(x) > 2e5) | (np.abs(z) > 2e5)
    bad_cum = np.r_[0, np.cumsum(bad_v)]
    single_rings, single_idx = [], []
    multi = []
    n_bad = 0
    for i in range(n):
        p0, p1 = ppo[i], ppo[i + 1]
        rings = []
        for j in range(p0, p1):
            a, b = po[j], po[j + 1]
            if b - a < 4:
                continue
            if bad_cum[b] - bad_cum[a] > 0:
                n_bad += 1
                continue
            rings.append((a, b))
        if not rings:
            continue
        if len(rings) == 1:
            single_rings.append(rings[0])
            single_idx.append(i)
        else:
            multi.append((i, rings))
    lens = np.array([b - a for a, b in single_rings])
    ci = np.concatenate([np.arange(a, b) for a, b in single_rings])
    geoms = shapely.from_ragged_array(shapely.GeometryType.POLYGON, np.c_[x[ci], z[ci]],
                                      (np.r_[0, np.cumsum(lens)], np.arange(len(single_rings) + 1)))
    out_g = list(geoms)
    out_i = list(single_idx)
    # 多部件：面积最大者为外环，落在外环里的为内环（忽略），其余作为独立建筑
    for i, rings in multi:
        polys = [shapely.make_valid(shapely.Polygon(np.c_[x[a:b], z[a:b]])) for a, b in rings]
        polys = sorted([p for p in polys if not p.is_empty], key=lambda p: -p.area)
        outers = []
        for p in polys:
            if any(o.contains(p.representative_point()) for o in outers):
                continue
            outers.append(p)
        for o in outers:
            out_g.append(o)
            out_i.append(i)
    geoms = shapely.make_valid(np.array(out_g, dtype=object))
    src = np.array(out_i)
    geoms, src = explode_polys(geoms, src)
    h_nan = int((~np.isfinite(A['h'][src])).sum())
    log(f'CMAB：{n} 条记录 → {len(geoms)} 个多边形（非法坐标环 {n_bad}，高度 NaN {h_nan} 条保留轮廓）')
    fnames = [str(s) for s in A['func_names']]
    return dict(geoms=geoms, src=src, func=A['func'][src], func_names=fnames, age=A['age'][src].astype(np.int32),
                h_cmab=A['h'][src].astype(np.float64), floor_cmab=A['floor'][src].astype(np.float64))


def explode_polys(geoms, src):
    """把 make_valid 产生的 MultiPolygon / GeometryCollection 拆成 Polygon，丢弃线/点。"""
    import shapely
    parts, idx = shapely.get_parts(geoms, return_index=True)
    t = shapely.get_type_id(parts)
    # GeometryCollection 里可能还有 MultiPolygon：再拆一层
    if (t == 6).any() or (t == 7).any():
        p2, i2 = shapely.get_parts(parts, return_index=True)
        parts, idx = p2, idx[i2]
        t = shapely.get_type_id(parts)
    keep = t == 3
    return parts[keep], src[idx[keep]]


def osm_polys(e):
    if e['type'] == 'way':
        gs = [e.get('geometry') or []]
    else:
        gs = [m.get('geometry') or [] for m in e.get('members', []) if m.get('role', 'outer') in ('outer', '')]
    out = []
    for g in gs:
        if len(g) < 4:
            continue
        ll = np.array([(p['lon'], p['lat']) for p in g], np.float64)
        out.append(np.c_[project_arr(ll[:, 0], ll[:, 1])])
    return out


def load_osm():
    """OSM building / building:part（PBF 全量 + 若干 Overpass 窄框补充）。"""
    import glob
    import shapely
    if not os.path.exists(OSM_MAIN):
        import extract_osm_buildings_main
        extract_osm_buildings_main.main()
    els = {}
    for e in json.load(open(OSM_MAIN, encoding='utf-8'))['elements']:
        els[(e['type'], e['id'])] = e
    extra = [os.path.join(SRC, 'airports_research', 'osm_xiy_buildings.json'),
             os.path.join(SRC, 'landmarks_historic', 'osm', 'qujiang.json'),
             os.path.join(SRC, 'landmarks_historic', 'osm', 'others.json')] + \
        sorted(glob.glob(os.path.join(SRC, 'landmarks_modern', 'osm_tall_named_*.json')))
    n_extra = 0
    for fn in extra:
        try:
            d = json.load(open(fn, encoding='utf-8'))
        except Exception:  # noqa: BLE001
            continue
        for e in d.get('elements', []):
            t = e.get('tags', {})
            if not (t.get('building') or t.get('building:part')):
                continue
            if (e['type'], e['id']) not in els:
                els[(e['type'], e['id'])] = e
                n_extra += 1
    geoms, tags, ids = [], [], []
    for (tp, i), e in els.items():
        for ring in osm_polys(e):
            try:
                p = shapely.make_valid(shapely.Polygon(ring))
            except Exception:  # noqa: BLE001
                continue
            if p.is_empty:
                continue
            geoms.append(p)
            tags.append(e.get('tags', {}))
            ids.append(f'{tp[0]}{i}')
    geoms = np.array(geoms, dtype=object)
    src = np.arange(len(geoms))
    geoms, src = explode_polys(geoms, src)
    tags = [tags[i] for i in src]
    ids = [ids[i] for i in src]
    log(f'OSM：{len(els)} 要素（Overpass 补充 {n_extra}）→ {len(geoms)} 个多边形')
    return dict(geoms=geoms, tags=tags, ids=ids)


def osm_height(tags):
    """OSM 实测高度（米）或 None。"""
    h = num(tags.get('height'))
    if h is not None and not (2.0 <= h <= 400.0):
        h = None
    if h is None:
        lv = num(tags.get('building:levels'))
        if lv is not None and 1 <= lv <= 80:
            h = lv * LEVEL_H
    return h


def osm_kind(tags):
    raw = (tags.get('building') or tags.get('building:part') or '').lower()
    amen = tags.get('amenity', '')
    if tags.get('tourism') == 'hotel' or 'hotel' in raw:
        return 8
    if tags.get('historic') or any(x in raw for x in ('temple', 'church', 'mosque', 'pagoda', 'shrine', 'cathedral')):
        return 5
    if any(x in raw for x in ('school', 'university', 'college', 'hospital', 'kindergarten', 'dormitory')) or \
            amen in ('school', 'hospital', 'university', 'college', 'kindergarten', 'clinic'):
        return 7
    if any(x in raw for x in ('train_station', 'transportation', 'terminal', 'airport', 'hangar')) or tags.get('aeroway'):
        return 6
    if any(x in raw for x in ('apartments', 'residential', 'house', 'detached', 'semidetached', 'terrace', 'villa', 'bungalow')):
        return 1
    if any(x in raw for x in ('commercial', 'office', 'retail', 'supermarket', 'mall', 'kiosk')) or tags.get('office') or tags.get('shop'):
        return 2
    if any(x in raw for x in ('industrial', 'warehouse', 'manufacture', 'factory', 'storage_tank', 'farm_auxiliary')):
        return 3
    if any(x in raw for x in ('government', 'civic', 'public', 'museum', 'stadium', 'sports_hall', 'fire_station', 'police')):
        return 4
    return 0


def wall_strip_mask(geoms):
    """城墙中心线 ≤ 12 m 且长条形 → True（删除）。"""
    import shapely
    d = json.load(open(WALL, encoding='utf-8'))
    ring = shapely.LinearRing(d['polygon'])
    dist = shapely.distance(shapely.centroid(geoms), ring)
    cand = np.nonzero(dist <= 40)[0]
    out = np.zeros(len(geoms), bool)
    if len(cand) == 0:
        return out
    band = ring.buffer(12.0)
    g = geoms[cand]
    rect = shapely.oriented_envelope(g)
    L, Wd = rect_dims(rect)
    aspect = L / np.maximum(Wd, 0.1)
    frac = shapely.area(shapely.intersection(g, band)) / np.maximum(shapely.area(g), 1e-6)
    # 长条：长宽比 ≥ 3，或极长（≥ 60 m）且宽 ≤ 22 m；并且大部分落在中心线 ±12 m 带内
    strip = ((aspect >= 3.0) | ((L >= 60) & (Wd <= 22))) & (frac >= 0.6) & (dist[cand] <= 12)
    out[cand[strip]] = True
    return out


def rect_dims(rect):
    import shapely
    c = shapely.get_coordinates(shapely.get_exterior_ring(rect))
    n = shapely.get_num_coordinates(shapely.get_exterior_ring(rect))
    off = np.r_[0, np.cumsum(n)]
    a = np.hypot(c[off[:-1] + 1, 0] - c[off[:-1], 0], c[off[:-1] + 1, 1] - c[off[:-1], 1])
    b = np.hypot(c[off[:-1] + 2, 0] - c[off[:-1] + 1, 0], c[off[:-1] + 2, 1] - c[off[:-1] + 1, 1])
    return np.maximum(a, b), np.minimum(a, b)


def build_footprints(cm, osm):
    """合并 CMAB + OSM，返回统一的建筑表（dict of arrays / lists）。"""
    import shapely
    cg = cm['geoms']
    carea = shapely.area(cg)
    ctree = shapely.STRtree(cg)
    og = osm['geoms']
    oarea = shapely.area(og)
    is_part = np.array([bool(t.get('building:part')) and not t.get('building') for t in osm['tags']])
    # ---- CMAB 覆盖区：有 CMAB 楼的 500 m 网格（再膨胀 1 格）
    cc = shapely.get_coordinates(shapely.centroid(cg))
    cov = set()
    for gx, gz in zip(np.floor(cc[:, 0] / 500).astype(int), np.floor(cc[:, 1] / 500).astype(int)):
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                cov.add((gx + dx, gz + dz))
    oc = shapely.get_coordinates(shapely.centroid(og))
    in_cov = np.array([(int(math.floor(a / 500)), int(math.floor(b / 500))) in cov for a, b in oc])
    # ---- OSM ↔ CMAB 重叠
    pairs = ctree.query(og, predicate='intersects')    # (2, m): [osm_idx, cmab_idx]
    oi, ci = pairs
    inter = shapely.area(shapely.intersection(og[oi], cg[ci]))
    cover_o = np.bincount(oi, inter, minlength=len(og)) / np.maximum(oarea, 1e-6)
    # CMAB 每栋的最佳 OSM 匹配（名称/kind/实测高度）：重叠占两者较小者 ≥ 30%，取重叠最大
    rel = inter / np.maximum(np.minimum(oarea[oi], carea[ci]), 1e-6)
    ok = rel >= 0.3
    # building:part 不参与名称/kind 匹配，但参与高度（取最高的 part）
    osm_h = np.array([osm_height(t) or np.nan for t in osm['tags']])
    osm_name = [name_of(t) for t in osm['tags']]
    best_osm = np.full(len(cg), -1)
    best_ov = np.zeros(len(cg))
    hmax_part = np.full(len(cg), np.nan)
    for a, b, v, r in zip(oi[ok], ci[ok], inter[ok], rel[ok]):
        if is_part[a]:
            if np.isfinite(osm_h[a]) and r >= 0.5:
                hmax_part[b] = np.fmax(hmax_part[b], osm_h[a])
            continue
        if v > best_ov[b]:
            best_ov[b] = v
            best_osm[b] = a
    # 一个大 OSM 轮廓（如整个商场）对应多个 CMAB 楼时，名称只给重叠最大的那一栋
    name_owner = {}
    for b in np.nonzero(best_osm >= 0)[0]:
        a = best_osm[b]
        if osm_name[a] and (a not in name_owner or best_ov[b] > best_ov[name_owner[a]]):
            name_owner[a] = b
    # 实测高度只有当 OSM 轮廓与 CMAB 楼基本是同一栋时才传递（双向重叠 ≥ 50%）
    m_h = np.full(len(cg), np.nan)
    for b in np.nonzero(best_osm >= 0)[0]:
        a = best_osm[b]
        if np.isfinite(osm_h[a]) and best_ov[b] >= 0.5 * min(oarea[a], carea[b]) and \
                best_ov[b] >= 0.35 * max(oarea[a], carea[b]):
            m_h[b] = osm_h[a]
    m_h = np.where(np.isfinite(hmax_part) & ~np.isfinite(m_h), hmax_part, m_h)
    # ---- OSM 补充楼：非 part；覆盖区外全部；覆盖区内仅当被 CMAB 覆盖 < 20%
    add = (~is_part) & ((~in_cov) | (cover_o < 0.2)) & (oarea >= MIN_AREA)
    log(f'OSM 补充：覆盖区外 {int(((~is_part) & ~in_cov & (oarea >= MIN_AREA)).sum())}，'
        f'覆盖区内 CMAB 缺失 {int(((~is_part) & in_cov & (cover_o < 0.2) & (oarea >= MIN_AREA)).sum())}')
    ai = np.nonzero(add)[0]
    n_c = len(cg)
    geoms = np.concatenate([cg, og[ai]])
    src = np.r_[np.zeros(n_c, np.int8), np.ones(len(ai), np.int8)]
    kind = np.zeros(len(geoms), np.int16)
    names = [''] * len(geoms)
    meas = np.full(len(geoms), np.nan)
    tags_all = [None] * len(geoms)
    for b in range(n_c):
        a = best_osm[b]
        if a >= 0:
            kind[b] = osm_kind(osm['tags'][a])
            tags_all[b] = osm['tags'][a]
            if name_owner.get(a) == b:
                names[b] = osm_name[a]
    meas[:n_c] = m_h
    for j, a in enumerate(ai):
        t = osm['tags'][a]
        kind[n_c + j] = osm_kind(t)
        names[n_c + j] = osm_name[a]
        meas[n_c + j] = osm_h[a]
        tags_all[n_c + j] = t
    min_h = np.zeros(len(geoms))
    for j, a in enumerate(ai):
        mh = num(osm['tags'][a].get('min_height'))
        if mh:
            min_h[n_c + j] = mh
    func = np.r_[cm['func'].astype(np.int16), np.full(len(ai), -1, np.int16)]
    age = np.r_[cm['age'], np.zeros(len(ai), np.int32)]
    for j, a in enumerate(ai):
        sd = str(osm['tags'][a].get('start_date', ''))
        m = re.match(r'^(\d{4})', sd)
        if m:
            age[n_c + j] = int(m.group(1))
    for b in range(n_c):
        t = tags_all[b]
        if t:
            m = re.match(r'^(\d{4})', str(t.get('start_date', '')))
            if m:
                age[b] = int(m.group(1))
    return dict(geoms=geoms, src=src, kind=kind, names=names, meas=meas, min_h=min_h, func=func,
                func_names=cm['func_names'], age=age, tags=tags_all, in_cov=np.r_[np.ones(n_c, bool), in_cov[ai]])


def clean_footprints(F):
    """面积、城墙长条、DP 简化、朝向。"""
    import shapely
    g = F['geoms']
    g = shapely.simplify(g, DP_TOL, preserve_topology=True)
    g = shapely.make_valid(g)
    idx = np.arange(len(g))
    g, idx = explode_polys(g, idx)
    # 同一栋被拆成多块时，只保留面积最大的块（小碎块多为 make_valid 产物）
    area = shapely.area(g)
    order = np.lexsort((-area, idx))
    first = np.r_[True, idx[order][1:] != idx[order][:-1]]
    keep = order[first]
    g, idx = g[keep], idx[keep]
    g = shapely.orient_polygons(g, exterior_cw=False) if hasattr(shapely, 'orient_polygons') else \
        np.array([shapely.geometry.polygon.orient(p, 1.0) for p in g], dtype=object)
    g = shapely.polygons(shapely.get_exterior_ring(g))   # 只保留外环
    area = shapely.area(g)
    ok = area >= MIN_AREA
    wall = wall_strip_mask(g)
    log(f'清洗：面积<{MIN_AREA:g}m² 删除 {int((~ok).sum())}，城墙长条删除 {int((wall & ok).sum())}')
    keep = ok & ~wall
    g, idx = g[keep], idx[keep]
    out = {k: (v[idx] if isinstance(v, np.ndarray) else [v[i] for i in idx]) for k, v in F.items()
           if k not in ('geoms', 'func_names')}
    out['geoms'] = g
    out['func_names'] = F['func_names']
    return out


# =====================================================================================
# 2. 特征
# =====================================================================================
def raster_stats(geoms, res=2.5, tile=4000.0):
    """轮廓内 CNBH-10m 统计：max / p90 / p50 / 非零占比 / 像素数。"""
    import shapely
    from PIL import Image, ImageDraw
    from pyproj import Transformer
    cn = np.load(CNBH, mmap_mode='r')
    meta = json.load(open(CNBH.replace('.npy', '.json')))
    tr = Transformer.from_crs('EPSG:4326', 'EPSG:32649', always_xy=True)
    b = shapely.bounds(geoms)
    tx0 = np.floor(b[:, 0] / tile).astype(int)
    tx1 = np.floor(b[:, 2] / tile).astype(int)
    tz0 = np.floor(b[:, 1] / tile).astype(int)
    tz1 = np.floor(b[:, 3] / tile).astype(int)
    tiles = {}
    for i in range(len(geoms)):
        for tx in range(tx0[i], tx1[i] + 1):
            for tz in range(tz0[i], tz1[i] + 1):
                tiles.setdefault((tx, tz), []).append(i)
    coords = shapely.get_coordinates(shapely.get_exterior_ring(geoms))
    ncoord = shapely.get_num_coordinates(shapely.get_exterior_ring(geoms))
    coff = np.r_[0, np.cumsum(ncoord)]
    labs, vals = [], []
    npx = int(tile / res)
    for (tx, tz), members in tiles.items():
        X0, Z0 = tx * tile, tz * tile
        img = Image.new('I', (npx, npx), 0)
        d = ImageDraw.Draw(img)
        for i in members:
            c = coords[coff[i]:coff[i + 1]]
            d.polygon([((x - X0) / res, (z - Z0) / res) for x, z in c], fill=int(i + 1))
        L = np.asarray(img)
        m = L > 0
        if not m.any():
            continue
        jj, ii = np.nonzero(m)
        wx = X0 + (ii + 0.5) * res
        wz = Z0 + (jj + 0.5) * res
        # 世界坐标 → UTM：瓦片内用仿射近似（4 km 内误差 < 0.1 m）
        px = np.array([X0, X0 + tile, X0])
        pz = np.array([Z0, Z0, Z0 + tile])
        lon, lat = unproject_arr(px, pz)
        ex, ny = tr.transform(lon, lat)
        ax = (ex[1] - ex[0]) / tile, (ex[2] - ex[0]) / tile
        ay = (ny[1] - ny[0]) / tile, (ny[2] - ny[0]) / tile
        E = ex[0] + ax[0] * (wx - X0) + ax[1] * (wz - Z0)
        Nn = ny[0] + ay[0] * (wx - X0) + ay[1] * (wz - Z0)
        col = ((E - meta['x0']) / meta['px']).astype(np.int64)
        row = ((meta['y1'] - Nn) / meta['px']).astype(np.int64)
        okk = (col >= 0) & (col < meta['w']) & (row >= 0) & (row < meta['h'])
        v = np.zeros(len(col), np.float32)
        v[okk] = cn[row[okk], col[okk]] / 10.0
        labs.append(L[m] - 1)
        vals.append(v)
    labs = np.concatenate(labs)
    vals = np.concatenate(vals)
    n = len(geoms)
    cnt = np.bincount(labs, minlength=n)
    nz = np.bincount(labs, vals > 0, minlength=n)
    order = np.lexsort((vals, labs))
    ls, vs = labs[order], vals[order]
    start = np.searchsorted(ls, np.arange(n))
    end = np.searchsorted(ls, np.arange(n), side='right')
    mx = np.zeros(n)
    p90 = np.zeros(n)
    p50 = np.zeros(n)
    has = end > start
    mx[has] = vs[end[has] - 1]
    p90[has] = vs[start[has] + ((end[has] - start[has] - 1) * 0.9).astype(int)]
    p50[has] = vs[start[has] + ((end[has] - start[has] - 1) * 0.5).astype(int)]
    # 没有像素中心落入的极小楼：取质心所在像素
    miss = np.nonzero(~has)[0]
    if len(miss):
        c = shapely.get_coordinates(shapely.centroid(geoms[miss]))
        lon, lat = unproject_arr(c[:, 0], c[:, 1])
        ex, ny = tr.transform(lon, lat)
        col = ((ex - meta['x0']) / meta['px']).astype(np.int64).clip(0, meta['w'] - 1)
        row = ((meta['y1'] - ny) / meta['px']).astype(np.int64).clip(0, meta['h'] - 1)
        v = cn[row, col] / 10.0
        mx[miss] = p90[miss] = p50[miss] = v
        nz[miss] = (v > 0).astype(int)
        cnt[miss] = 1
    return dict(cn_max=mx, cn_p90=p90, cn_p50=p50, cn_frac=nz / np.maximum(cnt, 1))


def ghsl_at(geoms):
    import shapely
    g = np.load(GHSL)
    m = json.load(open(GHSL.replace('.npy', '.json')))
    c = shapely.get_coordinates(shapely.centroid(geoms))
    lon, lat = unproject_arr(c[:, 0], c[:, 1])
    col = ((lon - m['lon0']) / m['dlon']).astype(int).clip(0, m['w'] - 1)
    row = ((m['lat1'] - lat) / m['dlat']).astype(int).clip(0, m['h'] - 1)
    return g[row, col] / 10.0


def load_globfp(bbox):
    """3D-GloBFP（Che et al. 2024, ESSD；CC BY 4.0）逐栋高度，返回 (geoms, H)。"""
    import shapely
    W, S, E, N = bbox
    all_g, all_h = [], []
    for fn in GLOBFP:
        if not os.path.exists(fn + '.shp'):
            log('缺少 3D-GloBFP', fn)
            continue
        shp = open(fn + '.shp', 'rb').read()
        shx = np.frombuffer(open(fn + '.shx', 'rb').read()[100:], dtype='>i4').reshape(-1, 2)
        offs = shx[:, 0].astype(np.int64) * 2
        raw = np.frombuffer(shp, dtype=np.uint8)
        bb = raw[(offs + 12)[:, None] + np.arange(32)[None, :]].copy().view('<f8').reshape(-1, 4)
        sel = np.nonzero((bb[:, 2] >= W) & (bb[:, 0] <= E) & (bb[:, 3] >= S) & (bb[:, 1] <= N))[0]
        rings, keep = [], []
        for i in sel:
            o = offs[i] + 8
            st, = struct.unpack_from('<i', shp, o)
            if st == 0:
                continue
            npart, npt = struct.unpack_from('<2i', shp, o + 36)
            parts = struct.unpack_from(f'<{npart}i', shp, o + 44)
            pts = np.frombuffer(shp, '<f8', count=npt * 2, offset=o + 44 + 4 * npart).reshape(-1, 2)
            e = parts[1] if npart > 1 else npt
            if e >= 4:
                rings.append(pts[:e])
                keep.append(i)
        if not keep:
            continue
        d = open(fn + '.dbf', 'rb')
        h = d.read(32)
        nrec = struct.unpack('<I', h[4:8])[0]
        hl = struct.unpack('<H', h[8:10])[0]
        rl = struct.unpack('<H', h[10:12])[0]
        mm = np.memmap(fn + '.dbf', dtype=np.uint8, mode='r', offset=hl, shape=(nrec, rl))
        col = np.asarray(mm[np.array(keep, np.int64), 1:25]).copy().view('S24').ravel()
        H = np.array([float(s) if s.strip() else np.nan for s in col])
        lens = np.array([len(r) for r in rings])
        ll = np.concatenate(rings)
        x, z = project_arr(ll[:, 0], ll[:, 1])
        G = shapely.from_ragged_array(shapely.GeometryType.POLYGON, np.c_[x, z],
                                      (np.r_[0, np.cumsum(lens)], np.arange(len(rings) + 1)))
        all_g.append(G)
        all_h.append(H)
    if not all_g:
        return None, None
    G = shapely.make_valid(np.concatenate(all_g))
    return G, np.concatenate(all_h)


def globfp_match(geoms):
    import shapely
    b = shapely.bounds(geoms)
    lo0, la0 = unproject_arr(b[:, 0].min() - 100, b[:, 3].max() + 100)   # 西南角（z 最大 = 最南）
    lo1, la1 = unproject_arr(b[:, 2].max() + 100, b[:, 1].min() - 100)   # 东北角
    G, H = load_globfp((float(lo0), float(la0), float(lo1), float(la1)))
    n = len(geoms)
    if G is None:
        return dict(gf_h=np.full(n, np.nan), gf_max=np.full(n, np.nan), gf_cover=np.zeros(n))
    log(f'3D-GloBFP：{len(G)} 栋')
    tree = shapely.STRtree(G)
    gi, fi = tree.query(geoms, predicate='intersects')   # [geoms_idx, G_idx]
    inter = shapely.area(shapely.intersection(geoms[gi], G[fi]))
    a_self = shapely.area(geoms)
    a_g = shapely.area(G)
    ok = inter >= 0.3 * np.minimum(a_self[gi], a_g[fi])
    gi, fi, inter = gi[ok], fi[ok], inter[ok]
    hh = H[fi]
    cover = np.bincount(gi, inter, minlength=n) / np.maximum(a_self, 1e-6)
    gmax = np.full(n, np.nan)
    np.fmax.at(gmax, gi, hh)
    # 按重叠面积加权的 80 分位
    order = np.lexsort((hh, gi))
    gi_s, hh_s, w_s = gi[order], hh[order], inter[order]
    start = np.searchsorted(gi_s, np.arange(n))
    end = np.searchsorted(gi_s, np.arange(n), side='right')
    cw = np.cumsum(w_s)
    gh = np.full(n, np.nan)
    for i in np.nonzero(end > start)[0]:
        s, e = start[i], end[i]
        base = cw[s - 1] if s > 0 else 0.0
        c = (cw[s:e] - base) / (cw[e - 1] - base)
        gh[i] = hh_s[s + min(np.searchsorted(c, 0.8), e - s - 1)]
    return dict(gf_h=gh, gf_max=gmax, gf_cover=np.minimum(cover, 2.0))


def neighborhood(geoms, cn_max):
    """日照间距（南北向最近楼净距）、周边覆盖率、邻域 CNBH 等。"""
    import shapely
    from scipy.spatial import cKDTree
    b = shapely.bounds(geoms)
    area = shapely.area(geoms)
    cxz = shapely.get_coordinates(shapely.centroid(geoms))
    n = len(geoms)
    tree = shapely.STRtree(geoms)
    feats = {}
    for name, sgn in (('gap_n', -1), ('gap_s', 1)):
        w = b[:, 2] - b[:, 0]
        x0 = b[:, 0] + 0.2 * w
        x1 = b[:, 2] - 0.2 * w
        if sgn < 0:   # 北侧：z 更小
            boxes = shapely.box(x0, b[:, 1] - 200, x1, b[:, 1] - 0.5)
        else:
            boxes = shapely.box(x0, b[:, 3] + 0.5, x1, b[:, 3] + 200)
        qi, oj = tree.query(boxes)
        okk = qi != oj
        qi, oj = qi[okk], oj[okk]
        if sgn < 0:
            gap = b[qi, 1] - b[oj, 3]
        else:
            gap = b[oj, 1] - b[qi, 3]
        gap = np.where(gap < 0, 0, gap)
        g = np.full(n, 200.0)
        np.fmin.at(g, qi, gap)
        feats[name] = g
    kd = cKDTree(cxz)
    for r in (60.0, 150.0):
        lst = kd.query_ball_point(cxz, r)
        cov = np.array([area[l].sum() for l in lst]) / (math.pi * r * r)
        feats[f'cov{int(r)}'] = cov
        feats[f'cnt{int(r)}'] = np.array([len(l) for l in lst], np.float64)
        if r == 150.0:
            feats['nb_cn'] = np.array([np.median(cn_max[l]) for l in lst])
            feats['nb_area'] = np.array([np.median(area[l]) for l in lst])
            feats['nb_cn90'] = np.array([np.percentile(cn_max[l], 90) for l in lst])
    return feats


def morphology(geoms):
    import shapely
    area = shapely.area(geoms)
    per = shapely.length(geoms)
    L, Wd = rect_dims(shapely.oriented_envelope(geoms))
    c = shapely.get_coordinates(shapely.centroid(geoms))
    wall = (c[:, 0] > -1995) & (c[:, 0] < 2230) & (c[:, 1] > -1865) & (c[:, 1] < 850)
    return dict(area=area, log_area=np.log(area), perim=per, compact=4 * math.pi * area / np.maximum(per, 1) ** 2,
                length=L, width=Wd, aspect=L / np.maximum(Wd, 0.5), fill=area / np.maximum(L * Wd, 1e-6),
                dist_c=np.hypot(c[:, 0], c[:, 1]), cx=c[:, 0], cz=c[:, 1], in_wall=wall.astype(float))


def compute_features(F):
    t0 = time.time()
    feats = morphology(F['geoms'])
    log('形态特征', f'{time.time() - t0:.0f}s')
    feats.update(raster_stats(F['geoms']))
    log('CNBH 轮廓统计', f'{time.time() - t0:.0f}s')
    feats['ghsl'] = ghsl_at(F['geoms'])
    feats.update(globfp_match(F['geoms']))
    log('3D-GloBFP 匹配', f'{time.time() - t0:.0f}s')
    feats.update(neighborhood(F['geoms'], feats['cn_max']))
    log('邻域特征', f'{time.time() - t0:.0f}s')
    return feats


# =====================================================================================
# 缓存
# =====================================================================================
def cached(name, fn):
    import pickle
    path = os.path.join(CACHE, f'stage_{name}.pkl')
    if os.path.exists(path) and not REFRESH:
        with open(path, 'rb') as f:
            return pickle.load(f)
    v = fn()
    os.makedirs(CACHE, exist_ok=True)
    with open(path + '.part', 'wb') as f:
        pickle.dump(v, f, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(path + '.part', path)
    return v


def stage_footprints():
    def run():
        import shapely
        cm = load_cmab()
        osm = load_osm()
        F = build_footprints(cm, osm)
        F = clean_footprints(F)
        F['wkb'] = shapely.to_wkb(F.pop('geoms'))
        return F
    F = cached('footprints', run)
    import shapely
    F = dict(F)
    F['geoms'] = shapely.from_wkb(F['wkb'])
    return F


def stage_features(F):
    return cached('features', lambda: compute_features(F))


# =====================================================================================
# 3. 地标（skyline.json）与高度模型
# =====================================================================================
def skyline_match(F):
    """与 skyline.json 已调研高楼的对应：返回 (高度, 是否由 skyline 模块渲染)。"""
    import shapely
    n = len(F['geoms'])
    h = np.full(n, np.nan)
    sky = np.zeros(n, bool)
    try:
        feats = json.load(open(SKYLINE, encoding='utf-8'))['features']
    except Exception:  # noqa: BLE001
        return h, sky
    polys, hs = [], []
    for f in feats:
        o = f.get('outer') or []
        if len(o) < 6:
            continue
        lv = f.get('levels') or 0
        hh = float(f['h'])
        if lv > 80 or hh > 400:      # 明显错误的标签（如“西安公路研究院 103 层 330 m”）
            hh = np.nan
        polys.append(shapely.make_valid(shapely.Polygon(np.array(o, np.float64).reshape(-1, 2))))
        hs.append(hh)
    if not polys:
        return h, sky
    P = np.array(polys, dtype=object)
    hs = np.array(hs)
    tree = shapely.STRtree(P)
    gi, pi = tree.query(F['geoms'], predicate='intersects')
    inter = shapely.area(shapely.intersection(F['geoms'][gi], P[pi]))
    a1 = shapely.area(F['geoms'])[gi]
    a2 = shapely.area(P)[pi]
    same = (inter >= 0.5 * np.minimum(a1, a2)) & (inter >= 0.35 * np.maximum(a1, a2))
    for g, p in zip(gi[same], pi[same]):
        sky[g] = True
        if np.isfinite(hs[p]):
            h[g] = np.fmax(h[g], hs[p])
    return h, sky


FEAT_EXCLUDE = ('cx', 'cz')


def feature_matrix(F, X):
    names = [k for k in X if k not in FEAT_EXCLUDE]
    cols = [np.asarray(X[k], np.float64) for k in names]
    cols += [np.asarray(F['func'], np.float64), np.asarray(F['kind'], np.float64),
             np.where(np.asarray(F['age']) > 0, np.asarray(F['age'], np.float64), np.nan)]
    return np.column_stack(cols), names + ['func', 'kind', 'age']


def fit_height_model(M, y, cx, cz, seed=0):
    """GBM(log 高度) + 空间分组 5 折袋外预测 + 保序回归去收缩。返回 (predict 函数, 报告 dict)。"""
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.isotonic import IsotonicRegression

    def gbm():
        return HistGradientBoostingRegressor(max_iter=300, learning_rate=0.04, max_leaf_nodes=12, min_samples_leaf=12,
                                             l2_regularization=1.0, random_state=seed)
    T = np.log(y)
    grp = (np.floor(cx / 1500) * 100000 + np.floor(cz / 1500)).astype(np.int64)
    ug = np.unique(grp)
    rng = np.random.default_rng(seed)
    fmap = dict(zip(ug, rng.integers(0, 5, len(ug))))
    fold = np.array([fmap[g] for g in grp])
    oof = np.zeros(len(T))
    for f in range(5):
        tr = fold != f
        oof[~tr] = gbm().fit(M[tr], T[tr]).predict(M[~tr])
    # 嵌套评估保序映射
    oof_iso = np.zeros(len(T))
    for f in range(5):
        tr = fold != f
        oof_iso[~tr] = IsotonicRegression(out_of_bounds='clip').fit(oof[tr], T[tr]).predict(oof[~tr])
    iso = IsotonicRegression(out_of_bounds='clip').fit(oof, T)
    model = gbm().fit(M, T)

    def predict(Mx):
        return np.exp(iso.predict(model.predict(Mx)))
    rep = {'oof_raw': np.exp(oof), 'oof_iso': np.exp(oof_iso), 'truth': y}
    return predict, rep


def report_cv(rep):
    t = rep['truth']
    for key in ('oof_raw', 'oof_iso'):
        p = rep[key]
        e = p - t
        s = f'  {key:8s} n={len(t)} R={np.corrcoef(p, t)[0, 1]:.2f} R(log)={np.corrcoef(np.log(p), np.log(t))[0, 1]:.2f} ' \
            f'MAE={np.abs(e).mean():.1f} m |'
        for lo, hi in ((0, 12), (12, 24), (24, 50), (50, 80), (80, 120), (120, 400)):
            m = (t >= lo) & (t < hi)
            if m.sum():
                s += f' 真{lo}-{hi}→中位{np.median(p[m]):.0f}({m.sum()})'
        log(s)


def estimate_heights(F, X):
    sky_h, sky = skyline_match(F)
    meas = np.asarray(F['meas'], np.float64).copy()
    meas = np.where(np.isfinite(meas), meas, sky_h)
    M, names = feature_matrix(F, X)
    lab = np.isfinite(meas) & (meas >= 2.5)
    cx, cz = np.asarray(X['cx']), np.asarray(X['cz'])
    log(f'高度模型：标签 {int(lab.sum())} 栋（OSM height/levels + skyline），特征 {len(names)} 个')
    predict, rep = fit_height_model(M[lab], meas[lab], cx[lab], cz[lab])
    report_cv(rep)
    pred = predict(M)
    h = np.where(lab, meas, pred)
    h = np.clip(h, 3.0, 400.0)
    return h, lab, sky, pred, rep


# =====================================================================================
# 4. kind / style
# =====================================================================================
FUNC_TO_KIND = {'居住': 1, '商服': 2, '办公': 2, '工业': 3, '公服': 4, '其他': 0, '': 0}


def assign_kind_style(F, X, h):
    n = len(h)
    fnames = F['func_names']
    func = np.asarray(F['func'])
    fn = np.array([fnames[f] if f >= 0 else '' for f in func])
    kind = np.asarray(F['kind'], np.int16).copy()
    fk = np.array([FUNC_TO_KIND.get(s, 0) for s in fn])
    kind = np.where(kind == 0, fk, kind)
    area = np.asarray(X['area'])
    cov60 = np.asarray(X['cov60'])
    cnt60 = np.asarray(X['cnt60'])
    aspect = np.asarray(X['aspect'])
    tags = F['tags']
    office = np.array([bool(t and (t.get('office') or 'office' in (t.get('building') or ''))) for t in tags])
    sf = np.zeros(n, np.uint8)
    resid = kind == 1
    village = (np.isin(kind, (0, 1))) & (area < 400) & (cov60 >= 0.4) & (cnt60 >= 8) & (h <= 26)
    sf[resid & (h >= 30)] = 1
    sf[resid & (h < 30) & (h >= 10)] = 2
    sf[resid & (h < 10)] = 3
    sf[resid & (h < 13) & (area < 450) & (cov60 < 0.3)] = 3
    sf[village] = 4
    k2 = kind == 2
    sf[k2 & ((fn == '办公') | office)] = 5
    sf[k2 & ~((fn == '办公') | office)] = 6
    sf[kind == 8] = 6
    sf[kind == 3] = 7
    sf[np.isin(kind, (4, 5, 6, 7))] = 8
    # 年代
    age = np.asarray(F['age'])
    sa = np.zeros(n, np.uint8)
    sa[(age > 0) & (age < 1990)] = 1
    sa[(age >= 1990) & (age < 2000)] = 2
    sa[(age >= 2000) & (age < 2010)] = 3
    sa[(age >= 2010) & (age < 2020)] = 4
    sa[age >= 2020] = 5
    style = (sa | (sf << 4)).astype(np.uint8)
    _ = aspect
    return kind.astype(np.uint8), style


# =====================================================================================
# 5. 写文件
# =====================================================================================
def write_bin(F, h, kind, style, flags, min_h, path):
    import shapely
    g = F['geoms']
    ring = shapely.get_exterior_ring(g)
    coords = shapely.get_coordinates(ring)
    ncoord = shapely.get_num_coordinates(ring)
    off = np.r_[0, np.cumsum(ncoord)]
    cen = shapely.get_coordinates(shapely.centroid(g))
    anchors = cen.astype(np.float32)
    offs_list, counts, keep = [], [], []
    for i in range(len(g)):
        c = coords[off[i]:off[i + 1] - 1]       # 去掉重复的首点
        d = np.round((c - anchors[i].astype(np.float64)) * 10).astype(np.int64)
        # 去掉取整后重复的相邻点
        dd = np.r_[True, np.any(d[1:] != d[:-1], axis=1)]
        d = d[dd]
        if len(d) >= 2 and np.all(d[0] == d[-1]):
            d = d[:-1]
        if len(d) < 3 or len(d) > 240 or np.abs(d).max() > 32767:
            continue
        # 以分米坐标重新检查朝向（shoelace > 0）与面积
        x, z = d[:, 0].astype(np.float64), d[:, 1].astype(np.float64)
        s = 0.5 * (np.dot(x, np.roll(z, -1)) - np.dot(z, np.roll(x, -1))) / 100.0
        if abs(s) < MIN_AREA * 0.9:
            continue
        if s < 0:
            d = d[::-1]
        offs_list.append(d.astype(np.int16))
        counts.append(len(d))
        keep.append(i)
    keep = np.array(keep)
    n = len(keep)
    counts = np.array(counts, np.uint32)
    starts = np.r_[0, np.cumsum(counts)[:-1]].astype(np.uint32)
    total = int(counts.sum())
    hd = np.clip(np.round(h[keep] * 10), 30, 65535).astype(np.uint16)
    md = np.clip(np.round(min_h[keep] * 10), 0, 65535).astype(np.uint16)
    md = np.minimum(md, hd - 10).clip(0).astype(np.uint16)
    parts = [b'XBLD', struct.pack('<III', 2, n, total),
             anchors[keep, 0].astype('<f4').tobytes(), anchors[keep, 1].astype('<f4').tobytes(),
             starts.astype('<u4').tobytes(), counts.astype('<u2').tobytes(),
             hd.astype('<u2').tobytes(), md.astype('<u2').tobytes(),
             kind[keep].astype(np.uint8).tobytes(), flags[keep].astype(np.uint8).tobytes(),
             style[keep].astype(np.uint8).tobytes()]
    body = b''.join(parts)
    pad = (-len(body)) % 4
    body += b'\0' * pad
    body += np.concatenate(offs_list).astype('<i2').tobytes()
    tmp = path + '.part'
    with open(tmp, 'wb') as f:
        f.write(body)
    os.replace(tmp, path)
    return keep


def main():
    t0 = time.time()
    F = stage_footprints()
    log(f'建筑轮廓 {len(F["geoms"])}（CMAB {int((F["src"] == 0).sum())}，OSM {int((F["src"] == 1).sum())}）')
    X = stage_features(F)
    h, measured, sky, pred, rep = estimate_heights(F, X)
    kind, style = assign_kind_style(F, X, h)
    names = F['names']
    has_name = np.array([bool(s) for s in names])
    flags = (measured.astype(np.uint8) | (has_name.astype(np.uint8) << 1) | ((h >= 100).astype(np.uint8) << 2)
             | (sky.astype(np.uint8) << 3))
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, 'buildings.bin')
    keep = write_bin(F, h, kind, style, flags, np.asarray(F['min_h'], np.float64), path)
    out_names = {str(j): names[i] for j, i in enumerate(keep) if names[i]}
    with open(os.path.join(OUT, 'buildings_names.json') + '.part', 'w', encoding='utf-8') as f:
        json.dump(out_names, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(os.path.join(OUT, 'buildings_names.json') + '.part', os.path.join(OUT, 'buildings_names.json'))
    hk = h[keep]
    log(f'写出 {path}：{len(keep)} 栋，{os.path.getsize(path) / 1e6:.2f} MB，命名 {len(out_names)}，'
        f'实测高度 {int(measured[keep].sum())}，高度分位 p50/p90/p99 = {np.percentile(hk, [50, 90, 99]).round(1)}，'
        f'>100 m {int((hk > 100).sum())}，用时 {time.time() - t0:.0f}s')
    # 供 verify_buildings.py / 调试使用的逐栋侧表（不进前端）
    np.savez_compressed(os.path.join(CACHE, 'buildings_v2_side.npz'), keep=keep, src=np.asarray(F['src'])[keep],
                        pred=pred[keep], measured=measured[keep], cn_max=np.asarray(X['cn_max'])[keep],
                        gf_h=np.asarray(X['gf_h'])[keep], oof_raw=rep['oof_raw'], oof_iso=rep['oof_iso'],
                        oof_truth=rep['truth'])


if __name__ == '__main__':
    main()
