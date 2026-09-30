#!/usr/bin/env python3
"""小区楼栋层数分配：research/refs/dossiers/residential.json（房天下成交记录“总层数”及出现次数）→ 逐栋层数。
由 tools/check_heights.py 调用（也可单独运行，只打印分配结果、不写 buildings.bin）。

依据与方法
  · 每个小区的房天下成交记录与在售房源（每条带“总层数”，如“中楼层/33层”“中层（共 33 层）”）按层数计数 c_f；
    同一栋楼的户数 ≈ 层数 × 每层户数，
    所以“楼栋数占比”按 w_f = c_f / f 估计（高楼户多、成交多，除以层数还原成楼栋比例）。
  · 层数分档：L 多层 4–7、M 小高层 8–11、H 高层 ≥12（≤3 层的别墅/配套不动）。某档记录 ≥ 3 条且 ≥ 3%、或占全部记录 ≥ 10%
    才算“该小区有这一档”。
  · 楼栋归档：小区 landuse 多边形内、CMAB 功能为住宅/未知、面积 ≥ 150 m²（按高层档分配的 ≥ 250 m²）、没有实测高度的楼，
    按原始 CMAB 高度（备份 data-src/backup/buildings.bin.before_heights，按轮廓质心 1.5 m 内且面积差 ≤ 5% 对应）÷ 3 m 估层 e：
      e 4–7 → L 档；e 8–11 → M 档；e ≥ 12 → H 档。
    档位回退（只在证据指向同一方向时）：
      M 档楼但小区没有小高层成交、有高层成交 → 按 H 档（CMAB 系统性低估高层，见 residential_notes §4）；
      H 档楼（e ≤ 14）但小区没有高层成交、有小高层成交 → 按 M 档；
      e 8–9 的楼、小区成交记录 ≥ 15 条且全部 ≤ 7 层（纯多层老小区）→ 按 L 档（CMAB 高估）；同类小区里面积 < 400 m² 的小轮廓
      不论 CMAB 估几层也按 L 档（例：紫薇苑·欧洲世家别墅区里 150–220 m² 的轮廓被估成 12–26 层，影像上是别墅）；
      小区两档都有，但按记录估的小高层楼栋数不到 CMAB 8–11 层轮廓数的一半（CMAB 把高层成批低估成 8–11 层）→ M、H 合并一档；
      其余档位无成交依据的楼（例如纯高层小区里 CMAB 只有 4–7 层的轮廓：可能是配套，也可能是被低估的高楼）一律不动，
      除非卫星核对确认是高层：档案 floors_check.sat_high_xz 列出轮廓内一点（世界坐标），或 floors_check.sat_all_high
      （整个小区影像上全是高层：面积在 min_area–max_area、不在 exclude_xz 排除点上的轮廓），这些楼（CMAB 估 ≥4 层、
      分配结果 <18 层或未分配）取该小区 ≥18 层记录的加权中位层数（Esri 倾斜影像上看得出“是不是高层”，看不出具体几层，所以不参与名次）。
  · 点位模式（floors_check.mode = 'point'）：小区在一整片无名大地块里、范围不确定时，取房天下点位 radius 米内、
    档位相容的最近 max_bld 栋（房天下楼栋总数）。用已有多边形的小区回测：按点位取的楼约 90% 落在真实多边形内。
  · 档内对应：档内楼按原始 CMAB 高度排序，同高的楼视为同一型（同高同层）；层数值按 w_f 累积分位，
    每组同高楼取其分位区间中点落在的那个层数。即“CMAB 越高 → 真实层数越高”，基本只用名次；
    唯一用到 CMAB 绝对值的是下限：不把楼压到原始估层的 0.6 倍以下（取该档中不低于下限的最小层数，没有就不动）。
  · 高度 = 层数 × 3.0 m（住宅层高 2.9–3.0 m；渲染端 bld-gen.js 按 高度÷3 m 还原层数，首层/女儿墙在其内分配）。
    可升可降（例如成交记录全是 6/7 层的老小区，CMAB 估成 4–5 层的楼抬到 6/7 层）。
  · 置信度 low、成交记录 < 6 条的小区不用；多边形找不到的小区跳过并报告。
  · 2026-09-30 复核补充：
    - 高层档面积门槛按“碎块组”合计面积判断（间距 < 0.6 m 或同一 Overture/OSM 轮廓内的候选楼并组），同一栋楼被 CMAB 切成
      两块时不再一半抬高、一半留在原值；组内原始高度与主楼差 ≤ 10 m 的碎块取主楼层数。
    - 高层档形状检查（名次分配与卫星核对都适用；只查面积 > 1500 m² 或长边 > 110 m 的大轮廓）：充满度 < 0.6、往内收缩 4 m 后分裂成多块、或面积超过所在 OSM 轮廓 1.5 倍的
      合并/伪轮廓不抬高，列入报告（shape_rejected）等待轮廓重切。
    - 轮廓 ≥ 50% 落在学校/幼儿园（university）、商业、工业地块里的楼不参与分配（小区里的幼儿园、商业楼不按住宅抬）。
    - 点位模式另外排除：质心落在其他有名住宅地块或学校/商业/工业地块里的楼、buildings_names 里有名字且名字与本小区无关的楼。

可重复运行：分配只取决于档案与原始 CMAB 高度（备份），与 buildings.bin 当前高度无关。
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

FLOOR_H = 3.0
MIN_AREA = 150.0
MIN_AREA_H = 250.0     # 按高层档分配的最小轮廓面积（西安高层住宅单栋占地一般 ≥ 300 m²）；按“同一栋楼的碎块组”合计面积判断
JOIN_D = 0.6           # 碎块并组：轮廓间距 < 0.6 m，或质心落在同一个 Overture/OSM 轮廓（≤ 5000 m²）里
JOIN_DH = 12.5         # 并组的小碎块与组内主楼原始 CMAB 高度差 ≤ 12.5 m（约 4 层）时取主楼层数（同一栋楼被 CMAB 切开的两半）
JOIN_HK = 0.6          # 原始高度不到组内主楼 0.6 倍的小碎块不借组面积（多为贴建的低层门厅/裙房）
H_BIG_AREA, H_BIG_LEN = 1500.0, 110.0   # 高层档形状检查只针对大轮廓（面积 > 1500 m² 或长边 > 110 m；普通蝶形/工字形塔楼不查）
H_FILL_MIN = 0.6       # 高层档形状检查：充满度（面积 ÷ 最小外接矩形）下限
H_SPLIT_D = 4.0        # 高层档形状检查：往内收缩 4 m 后分裂成多块的，多为跨楼合并轮廓
H_OSM_RATIO = 1.5      # 高层档形状检查：面积超过所在 OSM 轮廓 1.5 倍的，多为连同阴影/邻楼的合并轮廓
NONRES_K = ('university', 'commercial', 'industrial')   # 轮廓 ≥ 50% 落在这些地块（学校/幼儿园、商业、工业）里的楼不参与分配
TIERS = ('L', 'M', 'H')
TIER_RANGE = {'L': (4, 7), 'M': (8, 11), 'H': (12, 99)}
TIER_CN = {'L': '多层 4–7', 'M': '小高层 8–11', 'H': '高层 ≥12'}
DOSSIER = ROOT / 'research' / 'refs' / 'dossiers' / 'residential.json'
BACKUPS = [ROOT / 'data-src' / 'backup' / 'buildings.bin.before_heights', ROOT / 'data-src' / 'backup' / 'buildings.bin.before_estates']


def tier_of_floor(f):
    for t in TIERS:
        lo, hi = TIER_RANGE[t]
        if lo <= f <= hi:
            return t
    return None


def floor_counts(it):
    """档案条目 → {层数: 记录条数}（房天下成交记录 + 在售房源，各自一条房源一条记录）；
    只有层数集合（无频次）时每个值记 1 条（权重弱）"""
    ld = it.get('local_data') or {}
    out = Counter()
    for key in ('fang_transaction_floor_counts', 'fang_listing_floor_counts'):
        for k, v in (ld.get(key) or {}).items():
            if int(k) > 0:
                out[int(k)] += int(v)
    if out:
        return dict(out)
    return {int(f): 1 for f in (ld.get('fang_transaction_floors') or []) if f}


def tier_values(cnt):
    """{tier: [(层数, 权重 w=c/f), ...]}，只保留“有这一档”的档"""
    tot = sum(cnt.values())
    out = {}
    for t in TIERS:
        vs = {f: c for f, c in cnt.items() if tier_of_floor(f) == t}
        n = sum(vs.values())
        if vs and ((n >= 3 and n >= 0.03 * tot) or n >= 0.1 * tot):
            out[t] = sorted((f, c / f) for f, c in vs.items())
    return out


def lu_names(it):
    cs = str(it.get('coord_source') or '')
    return [q.strip() for m in re.findall(r'landuse_polygon_centroid\(([^;)]*)', cs) for q in re.split(r'[、,，]', m)
            if q.strip() and not q.strip().startswith('未命名')]


def base_heights(B, P, log=print):
    """原始 CMAB 高度与 flags：依次在备份文件里按轮廓（质心 1.5 m 内、面积差 ≤ 5%）找对应楼；找不到用当前值。
    返回 (h, flags, got)"""
    import shapely
    import bldbin
    h = B['h'].astype(np.float64).copy()
    fl = B['flags'].copy()
    got = np.zeros(B['n'], bool)
    ca, aa = shapely.centroid(P), shapely.area(P)
    for bk in BACKUPS:
        if not bk.exists():
            continue
        K = bldbin.read(str(bk))
        idx = np.repeat(np.arange(K['n']), K['cnt'].astype(int))
        xy = K['offs'].astype(np.float64) / 10 + np.c_[K['ax'][idx], K['az'][idx]]
        PK = shapely.polygons(shapely.linearrings(xy, indices=idx))
        ck, ak = shapely.centroid(PK), shapely.area(PK)
        todo = np.nonzero(~got)[0]
        ia, ik = shapely.STRtree(ck).query(ca[todo], predicate='dwithin', distance=1.5)
        ia = todo[ia]
        d = shapely.distance(ca[ia], ck[ik])
        ok = np.abs(aa[ia] - ak[ik]) <= 0.05 * np.maximum(aa[ia], ak[ik])
        best = {}
        for a, k, dd, o in zip(ia, ik, d, ok):
            if o and (a not in best or dd < best[a][1]):
                best[a] = (k, dd)
        for a, (k, _) in best.items():
            h[a] = K['h'][k]
            fl[a] = K['flags'][k]
            got[a] = True
        log(f'原始高度：{bk.name} 对上 {len(best)} 栋')
    return h, fl, got


def point_mode(it):
    return (it.get('floors_check') or {}).get('mode') == 'point'


def estate_polys(it, lu):
    """小区范围：档案里写明的 landuse 多边形名称；没有名称的取包含档案坐标的住宅地块。
    点位模式（floors_check.mode = 'point'：小区在一整片无名大地块里，范围不确定）不取多边形"""
    import shapely
    if point_mode(it):
        return []
    names = set(lu_names(it)) | {it['name']}
    polys = [g for g, nm in lu if nm and nm in names]
    if not polys:
        pt = shapely.Point(*it['world_xz'])
        polys = [g for g, nm in lu if g.contains(pt)]
    return polys


def point_members(it, P, cen, cand_ok):
    """点位模式：房天下点位半径 r 内、档位相容的楼，按距离取最近的 n 栋（n = 房天下楼栋总数）"""
    fc = it['floors_check']
    x, z = it['world_xz']
    d = np.hypot(cen[:, 0] - x, cen[:, 1] - z)
    idx = [int(j) for j in np.argsort(d) if d[j] <= fc.get('radius', 60) and cand_ok(int(j))]
    return idx[:int(fc.get('max_bld', 1))]


GENERIC_NAME = re.compile(r'^[0-9A-Za-z#\-－—·、\s]*(号楼|号|栋|幢|座|楼|单元|区|期)?[0-9A-Za-z#\-\s]*$')


def load_overture(ovt=None):
    """Overture 轮廓（含 OSM 描绘）：碎块并组、OSM 面积比检查用。返回 (geom, is_osm, STRtree)"""
    import shapely
    if ovt is None:
        import audit_common as AC
        ovt = AC.load_overture_buildings(only_named_or_measured=False)
    g = np.array([q if q.geom_type == 'Polygon' else max(getattr(q, 'geoms', [shapely.Polygon()]), key=lambda x: x.area) for q in ovt['geom']], dtype=object)
    return g, np.array([bool(r) for r in ovt['rid']]), shapely.STRtree(g)


def shape_bad(Pj, aj, osm_area):
    """高层档形状检查（只查大轮廓）：返回不合格原因（空串 = 通过）"""
    import shapely
    mrr = shapely.minimum_rotated_rectangle(Pj)
    xy = shapely.get_coordinates(mrr)
    Lmax = max(np.hypot(*(xy[1] - xy[0])), np.hypot(*(xy[2] - xy[1])))
    if aj <= H_BIG_AREA and Lmax <= H_BIG_LEN:
        return ''
    fill = aj / max(shapely.area(mrr), 1e-6)
    if fill < H_FILL_MIN:
        return f'充满度 {fill:.2f} < {H_FILL_MIN}'
    core = shapely.buffer(Pj, -H_SPLIT_D, join_style='mitre')
    parts = [q for q in getattr(core, 'geoms', [core]) if not q.is_empty and q.area > 1.0]
    if len(parts) >= 2:
        return f'内缩 {H_SPLIT_D:.0f} m 后分裂成 {len(parts)} 块'
    if osm_area and aj > H_OSM_RATIO * osm_area:
        return f'面积 {aj:.0f} m² 是所在 OSM 轮廓 {osm_area:.0f} m² 的 {aj / osm_area:.1f} 倍'
    return ''


def assign(B, P, h_base, eligible, dossier=DOSSIER, log=print, ovt=None, names=None):
    """返回 (asg, rep)：asg {楼下标: (层数, 小区名, 档位, 说明)}；rep 每个小区的分配摘要。
    ovt：audit_common.load_overture_buildings() 的结果（可选，缺省时自己读）；names：buildings_names.json（可选）"""
    import shapely
    L = json.loads((ROOT / 'public' / 'data' / 'landuse.json').read_text('utf-8'))['polys']
    lu = [(shapely.make_valid(shapely.Polygon(np.array(q['outer']).reshape(-1, 2))), q.get('n') or '')
          for q in L if q['k'] == 'residential' and len(q['outer']) >= 6]
    nonres = [shapely.make_valid(shapely.Polygon(np.array(q['outer']).reshape(-1, 2)))
              for q in L if q['k'] in NONRES_K and len(q['outer']) >= 6]
    nonres_tree = shapely.STRtree(nonres)
    lu_tree = shapely.STRtree([g for g, _ in lu])
    if names is None:
        names = json.loads((ROOT / 'public' / 'data' / 'buildings_names.json').read_text('utf-8'))
    og, osm, otree = load_overture(ovt)
    oarea = shapely.area(og)
    area = shapely.area(P)
    nonres_cache = {}

    def in_nonres(j):
        """轮廓 ≥ 50% 落在学校/幼儿园、商业、工业地块里"""
        if j not in nonres_cache:
            hit = nonres_tree.query(P[j], predicate='intersects')
            a = sum(shapely.area(shapely.intersection(P[j], nonres[k])) for k in hit) if len(hit) else 0.0
            nonres_cache[j] = a >= 0.5 * area[j]
        return nonres_cache[j]

    def outline_of(j, only_osm=False):
        """质心所在的 Overture（或只取 OSM）轮廓下标（≤ 5000 m² 中最小的），没有返回 -1"""
        hit = [int(k) for k in otree.query(cen_g[j], predicate='within') if oarea[k] <= 5000 and (osm[k] or not only_osm)]
        return min(hit, key=lambda k: oarea[k]) if hit else -1
    cen_g = shapely.centroid(P)
    cen = shapely.get_coordinates(cen_g)
    ctree = shapely.STRtree(cen_g)
    ptree = shapely.STRtree(P)
    kind = B['kind']
    asg, rep = {}, []
    owner = {}
    items = json.loads(Path(dossier).read_text('utf-8'))
    # 先处理有多边形的小区，再处理点位模式（点位模式只取尚未被其他小区占用的楼）
    items = [it for it in items if not point_mode(it)] + [it for it in items if point_mode(it)]
    for it in items:
        cnt = floor_counts(it)
        nrec = sum(cnt.values())
        r = dict(n=it['name'], nrec=nrec, counts=dict(sorted(cnt.items())))
        if it.get('confidence') == 'low' or not it.get('world_xz'):
            r['note'] = '置信度 low 或无坐标，不用'
            rep.append(r)
            continue
        if nrec < 6 and not (it.get('local_data') or {}).get('fang_transaction_floors'):
            r['note'] = f'成交记录只有 {nrec} 条，不用'
            rep.append(r)
            continue
        tv = tier_values(cnt)
        r['tiers'] = {t: [f for f, _ in v] for t, v in tv.items()}
        # 纯多层小区：成交记录 ≥ 15 条且全部 ≤ 7 层
        pure_mid = 'L' in tv and nrec >= 15 and max(cnt) <= 7
        polys = estate_polys(it, lu)

        # floors_check.exclude_xz：人工核对排除的楼（轮廓内一点，世界坐标；如点位模式取到的相邻小区楼）
        fc = it.get('floors_check') or {}
        excl = [shapely.Point(x, z) for x, z in fc.get('exclude_xz') or []]

        def ok(j):
            return bool(eligible[j]) and kind[j] in (0, 1) and area[j] >= MIN_AREA and j not in owner and not in_nonres(j) \
                and not any(P[j].contains(q) for q in excl)
        if point_mode(it):
            my_names = set(lu_names(it)) | {it['name']}
            key = re.sub(r'[（(].*?[)）]|[·•\s]', '', it['name'])

            def foreign(j):
                """点位模式：质心落在别的有名住宅地块里，或 buildings_names 里有与本小区无关的名字"""
                for k in lu_tree.query(cen_g[j], predicate='within'):
                    nm = lu[int(k)][1]
                    if nm and nm not in my_names:
                        return True
                nm = names.get(str(j)) or ''
                return bool(nm) and key not in nm and not GENERIC_NAME.match(nm)

            # 档位相容：只取原始 CMAB 估层落在小区成交档位（含 M→H 回退）里的楼
            def ok_pt(j):
                if not ok(j) or foreign(j):
                    return False
                e = int(round(h_base[j] / FLOOR_H))
                t = 'L' if 4 <= e <= 7 else 'M' if 8 <= e <= 11 else 'H' if e >= 12 else None
                return t in tv or (t == 'M' and 'H' in tv)
            cand = point_members(it, P, cen, ok_pt)
            polys = ['point']
        elif not polys:
            r['note'] = '本地 landuse 无多边形，范围无法确定，跳过'
            rep.append(r)
            continue
        else:
            U = shapely.union_all(polys)
            inside = [int(j) for j in ctree.query(U, predicate='contains')]
            cand = [j for j in inside if ok(j)]
        est = {j: int(round(h_base[j] / FLOOR_H)) for j in cand}
        groups = defaultdict(list)
        # 卫星核对（Esri 影像目视：倾斜影像可见立面与长阴影）确认为高层、但 CMAB 严重低估的轮廓：
        #   floors_check.sat_high_xz：逐栋列出轮廓内一点（世界坐标）；
        #   floors_check.sat_all_high：{min_area, max_area, exclude_xz}——整个小区在影像上全是高层，面积在范围内、未被排除
        #     （会所/幼儿园/底商/学校等列在 exclude_xz）的轮廓，凡原始 CMAB 估 ≥4 层、而分配结果 <18 层或未分配的，都按高层
        sat = set()
        if 'H' in tv:
            for x, z in fc.get('sat_high_xz') or []:
                pt = shapely.Point(x, z)
                sat.update(j for j in cand if P[j].contains(pt))
        sat_all = fc.get('sat_all_high') if 'H' in tv else None
        # 高层档形状检查（合并/伪轮廓不抬高，列入报告）
        shape_rej = {}

        def h_shape_ok(j):
            if j not in shape_rej:
                ko = outline_of(j, only_osm=True)
                shape_rej[j] = shape_bad(P[j], area[j], oarea[ko] if ko >= 0 else 0.0)
            return not shape_rej[j]
        # 碎块并组（同一栋楼被 CMAB 切成几块）：间距 < JOIN_D，或质心在同一个 Overture/OSM 轮廓里
        par = {j: j for j in cand}

        def root(j):
            while par[j] != j:
                par[j] = par[par[j]]
                j = par[j]
            return j
        cset = set(cand)
        for j in cand:
            for k in ptree.query(P[j], predicate='dwithin', distance=JOIN_D):
                k = int(k)
                if k in cset and k != j and shapely.distance(P[j], P[k]) < JOIN_D:
                    par[root(k)] = root(j)
        by_ol = defaultdict(list)
        for j in cand:
            o = outline_of(j)
            if o >= 0:
                by_ol[o].append(j)
        for mem in by_ol.values():
            for k in mem[1:]:
                par[root(k)] = root(mem[0])
        tier_of = {}
        for j in cand:
            e = est[j]
            if j in sat:
                if not h_shape_ok(j):
                    sat.discard(j)      # 卫星核对也要过形状检查（跨楼合并轮廓整体抬高会形成一堵高墙）
                continue            # 不参与名次（CMAB 高度不可信），下面取高层档加权中位层数
            t = 'L' if 4 <= e <= 7 else 'M' if 8 <= e <= 11 else 'H' if e >= 12 else None
            if t is None:
                continue
            how = ''
            if t not in tv:
                if t == 'M' and 'H' in tv:
                    t, how = 'H', 'CMAB 估 8–11 层、小区无小高层成交 → 按高层'
                elif t == 'H' and e <= 14 and 'M' in tv and 'H' not in tv:
                    t, how = 'M', 'CMAB 估 12–14 层、小区无高层成交 → 按小高层'
                elif t == 'M' and e <= 9 and pure_mid:
                    t, how = 'L', 'CMAB 估 8–9 层、小区成交记录全部 ≤7 层（≥15 条）→ 按多层'
                elif pure_mid and area[j] < 400:
                    t, how = 'L', f'小轮廓（{area[j]:.0f} m²）CMAB 估 {e} 层、小区成交记录全部 ≤7 层（≥15 条）→ 按多层（别墅/多层区里的高层估值多为错估）'
                else:
                    continue
            tier_of[j] = (t, how)
        # 高层档：碎块组合计面积 < 250 m²（塔楼切碎的小块或伪轮廓，细高得不合常理）不按高层抬；形状不合格的不抬
        grp_area, grp_main = defaultdict(float), {}
        for j, (t, _) in tier_of.items():
            if t == 'H':
                grp_area[root(j)] += area[j]
                if area[j] >= MIN_AREA_H and (root(j) not in grp_main or area[j] > area[grp_main[root(j)]]):
                    grp_main[root(j)] = j
        for j, (t, how) in tier_of.items():
            if t == 'H':
                m = grp_main.get(root(j))
                if area[j] < MIN_AREA_H and (grp_area[root(j)] < MIN_AREA_H or (m is not None and h_base[j] < JOIN_HK * h_base[m])):
                    continue
                if not h_shape_ok(j):
                    continue
                if area[j] < MIN_AREA_H:
                    how = (how + '；' if how else '') + f'碎块 {area[j]:.0f} m²，与相邻轮廓并组合计 {grp_area[root(j)]:.0f} m²'
            groups[t].append((j, how))
        # 小高层档“CMAB 轮廓过多”：按成交/在售记录估的小高层楼栋占比 × (M+H 轮廓数) 不到 CMAB 小高层轮廓数的一半时，
        # 说明 CMAB 把大批高层低估成了 8–11 层（例如华著中城：记录里 11 层只占 1%，CMAB 却有 20 栋“9 层”，卫星上全是 30+ 层板楼），
        # 这时 M、H 两档合并成一档按名次对应（同高同层）
        vals_for = dict(tv)
        if groups.get('M') and 'M' in tv and 'H' in tv:
            wm = sum(x for _, x in tv['M'])
            wh = sum(x for _, x in tv['H'])
            nm_, nh_ = len(groups['M']), len(groups.get('H', []))
            if wm / (wm + wh) * (nm_ + nh_) < 0.5 * nm_:
                groups['H'] = groups.get('H', []) + [(j, f'小高层记录只够约 {wm / (wm + wh) * (nm_ + nh_):.0f} 栋、CMAB 却有 {nm_} 栋 8–11 层 → 与高层合并按名次')
                                                     for j, _ in groups['M']]
                del groups['M']
                vals_for['H'] = sorted(tv['M'] + tv['H'])
                r['pooled_MH'] = True
        ch = {}
        for t, mem in groups.items():
            vals = vals_for[t]
            w = np.array([x for _, x in vals])
            cw = np.cumsum(w) / w.sum()
            fl = [f for f, _ in vals]
            mem.sort(key=lambda q: (h_base[q[0]], q[0]))
            hs = np.array([round(float(h_base[j]), 1) for j, _ in mem])
            n = len(mem)
            k = 0
            while k < n:
                k2 = k
                while k2 + 1 < n and hs[k2 + 1] == hs[k]:
                    k2 += 1
                qm = (k + k2 + 1) / 2 / n          # 同高组的分位区间中点
                f0 = fl[int(np.searchsorted(cw, qm - 1e-9))] if qm < 1 else fl[-1]
                for j, how in mem[k:k2 + 1]:
                    # 下限：不把楼压到原始 CMAB 估层的 0.6 倍以下（CMAB 会低估高层，但很少把楼高估一倍以上）；
                    # 名次落到的层数太低时取该档中不低于下限的最小层数，档内没有这样的层数就不动（多半不是本小区的住宅楼）
                    f = f0
                    if f < 0.6 * est[j] and not (pure_mid and t == 'L'):   # 纯多层小区的降档是有意的，不受下限约束
                        ok_v = [v for v in fl if v >= 0.6 * est[j]]
                        if not ok_v:
                            continue
                        f = ok_v[0]
                        how = (how + '；' if how else '') + f'名次对应 {f0} 层低于原始估层 {est[j]} 的 0.6 倍 → 取 {f} 层'
                    asg[j] = (f, it['name'], t, how)
                    owner[j] = it['name']
                    ch[j] = (float(h_base[j]), f)
                k = k2 + 1
        # 并组的小碎块：与组内主楼（≥ 250 m² 中最大者）原始高度差 ≤ 10 m 的取主楼层数（同一栋楼的两半）
        main_of = {}
        for j, _ in groups.get('H', []):
            if j in ch and area[j] >= MIN_AREA_H:
                r0 = root(j)
                if r0 not in main_of or area[j] > area[main_of[r0]]:
                    main_of[r0] = j
        for j, how in groups.get('H', []):
            m = main_of.get(root(j))
            if j in ch and m is not None and m != j and area[j] < MIN_AREA_H and abs(h_base[j] - h_base[m]) <= JOIN_DH and asg[j][0] != asg[m][0]:
                asg[j] = (asg[m][0], it['name'], 'H', (how + '；' if how else '') + f'与主楼原始高度差 {abs(h_base[j] - h_base[m]):.1f} m → 取主楼 {asg[m][0]} 层')
                ch[j] = (float(h_base[j]), asg[m][0])
        if sat_all:
            exc = [shapely.Point(x, z) for x, z in sat_all.get('exclude_xz') or []]
            lo_a, hi_a = sat_all.get('min_area', 300), sat_all.get('max_area', 2500)
            for j in cand:
                if est[j] >= 4 and lo_a <= area[j] <= hi_a and not any(P[j].contains(q) for q in exc) \
                        and (j not in asg or asg[j][0] < 18) and h_shape_ok(j):
                    sat.add(j)
        if sat:
            vals = [q for q in tv['H'] if q[0] >= 18] or tv['H']
            cw = np.cumsum([x for _, x in vals]) / sum(x for _, x in vals)
            f = vals[int(np.searchsorted(cw, 0.5 - 1e-9))][0]
            for t in list(groups):
                groups[t] = [q for q in groups[t] if q[0] not in sat]
            for j in sorted(sat):
                asg[j] = (f, it['name'], 'H', '卫星核对为高层（CMAB 低估），取 ≥18 层记录的加权中位层数')
                owner[j] = it['name']
                ch[j] = (float(h_base[j]), f)
                groups['H'].append((j, 'sat'))
            r['sat_high'] = len(sat)
        r['assigned'] = len(ch)
        r['by_tier'] = {t: dict(Counter(asg[j][0] for j, _ in mem if j in ch)) for t, mem in groups.items()}
        r['skipped_low'] = sum(1 for j in cand if est[j] <= 3)
        r['untouched'] = sum(1 for j in cand if j not in ch and est[j] >= 4)
        r['polys'] = len(polys)
        rej = [j for j in cand if shape_rej.get(j)]
        if rej:
            r['shape_rejected'] = [dict(i=int(j), x=round(float(cen[j][0]), 1), z=round(float(cen[j][1]), 1), a=round(float(area[j])),
                                        h=round(float(h_base[j]), 1), why=shape_rej[j]) for j in rej]
        rep.append(r)
    return asg, rep


def main():
    import audit_common as AC
    B, P = AC.load_bin(AC.DATA / 'buildings.bin')
    hb, fb, _ = base_heights(B, P)
    elig = (fb & 1) == 0
    asg, rep = assign(B, P, hb, elig)
    for r in rep:
        print(r['n'], r.get('note') or f"{r.get('assigned')} 栋 {r.get('by_tier')} 未动 {r.get('untouched')}")
    print('合计', len(asg))


if __name__ == '__main__':
    main()
