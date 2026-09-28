#!/usr/bin/env python3
"""建筑高度审计与修正：buildings.bin / skyline.json 对照 Overture 2026-09、OSM、公开资料。

背景
  buildings.bin 的高度 = OSM 实测（height / levels×3.2，约 1000 栋）> skyline.json > 回归模型预测（CMAB 轮廓 + 栅格特征），
  模型输出经保序回归后上限约 86–90 m，超高层被系统性压低；OSM/Overture 里又夹着脏数据（“西安公路研究院”103 层 330 m、
  Overture 800 m，“主题楼”225 m/45F 等），整片综合体轮廓（塔楼 + 裙房）被整体拉到塔楼高度。

可信度优先级（高 → 低）
  1. 公开资料：手工精建塔楼（src/arch/sky-data*.js，高度已与 research/refs/landmarks2026/towers.json 核对）
     与 landmarks2026 中轮廓为同名/含点匹配、坐标非推测的塔楼
  2. Overture 2026-09 实测：height，缺省时 num_floors × 3.1 m（剔除脏值：> 400 m、> 80 层、黑名单、整片大轮廓的塔楼高）
  3. skyline.json（OSM height / levels×层高，先按 SKY_FIX 修正）
  4. 原值（CMAB 轮廓 + 模型预测）
  另加三条规则：
  - 综合体整片轮廓：面积 > 8000 m² 却取了塔楼高度（> 60 m）→ 取裙房高
  - 大面积低可信高值：无实测、面积 > 8000 m²、高于同类实测楼 90 分位 → 压到该分位
  - 同型楼（同一住宅地块内轮廓面积/长宽相差 ≤ 6%）：组内有实测 → 无实测的取实测中位；
    组内全是模型值且离散（极差 > 30%）→ 统一取组内中位（先用实测楼验证“同型同高”成立才启用）

用法
  python tools/check_heights.py           # 只审计：打印统计，写 research/audit/heights_report.md、heights_changes.json
  python tools/check_heights.py --fix     # 审计并写回：skyline.json（SKY_FIX）+ buildings.bin 高度/flags（只改这两个字段，
                                          #   按字节原位改写，轮廓/锚点/顺序不动）。首次运行备份到 data-src/backup/。
  可重复运行：目标高度只取决于外部来源，已修过的文件再跑结果不变；并行工作改了轮廓后直接重跑 --fix 即可。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import struct
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import audit_common as AC  # noqa: E402

ROOT = HERE.parent
BIN = AC.DATA / 'buildings.bin'
SKY = AC.DATA / 'skyline.json'
BACKUP = ROOT / 'data-src' / 'backup'
OUTDIR = ROOT / 'research' / 'audit'
FLOOR_H = 3.1          # Overture 只有层数时的层高（米）

# ───────────── skyline.json 修正表（名称 → 条件 + 新值 + 依据） ─────────────
# cond：可选 {'area_gt': x} 只修面积大于 x 的同名要素；h='bin' 表示改用 buildings.bin 该轮廓内的通用高度（降为通用建筑）
SKY_FIX = [
    dict(n='西安公路研究院', h='bin', levels=None,
         why='OSM 103 层/330 m、Overture 800 m 均为错标；公开资料无高层（百度百科/官网均无超高层描述），CMAB 轮廓为 12.6 m 级多层，'
             '降为通用建筑（skyline 模块不再按塔楼生成）'),
    dict(n='IFC国瑞·西安金融中心', h=350, levels=75,
         why='公开报道 350 m/75F（搜狐/新浪 2025-12 投用报道；Overture 2026-09 OSM height=350）；旧 OSM 抽取为 330'),
    dict(n='迈科中心', cond={'area_gt': 10000}, h=26, levels=6,
         why='该要素是 22503 m² 的整片综合体轮廓（塔楼 + 裙房），却带塔楼高 216 m；塔楼另有独立轮廓，整片取裙房 26 m（sky-data mkP）'),
    dict(n='延长石油科研中心', cond={'area_gt': 10000}, h=36, levels=None,
         why='13466 m² 的整片轮廓（西端塔楼 + 东侧裙楼，236×62 m），不能整体 217 m；塔楼由 sky-data 精建，整片取裙楼 36 m；'
             '原 levels=68 与公开资料 46F 不符'),
]
# Overture 高度黑名单（名称 → 依据）：不参与修正
OVT_BLACKLIST = {
    '西安公路研究院': 'height=800 为错标',
    '主题楼': 'height=225/45F（108.9253,34.2196 一带学校建筑），查无此超高层，疑为错标（research towers_notes §4）',
}
# 综合体整片轮廓阈值
BIG_AREA = 8000.0
# 同型楼判定
SIB_TOL = 0.06
SIB_MIN_H = 24.0


def log(*a):
    print(*a, flush=True)


# ───────────────────────── 数据 ─────────────────────────
def mrr_dims(polys):
    import shapely
    r = shapely.minimum_rotated_rectangle(polys)
    c = shapely.get_coordinates(shapely.get_exterior_ring(r)).reshape(len(polys), 5, 2)
    a = np.hypot(*(c[:, 1] - c[:, 0]).T)
    b = np.hypot(*(c[:, 2] - c[:, 1]).T)
    return np.maximum(a, b), np.minimum(a, b)


def match_best(P, Q, fb=0.5, fq=0.25):
    """每个 P[i] 找交集最大的 Q[j]，要求 交集 ≥ fb×P 面积 且 ≥ fq×Q 面积。返回 (j 数组, -1 表示无)"""
    import shapely
    tree = shapely.STRtree(Q)
    pi, qi = tree.query(P, predicate='intersects')
    best = np.full(len(P), -1)
    if len(pi) == 0:
        return best
    inter = shapely.area(shapely.intersection(P[pi], Q[qi]))
    ap, aq = shapely.area(P)[pi], shapely.area(Q)[qi]
    ok = (inter >= fb * ap) & (inter >= fq * aq)
    bi = np.full(len(P), -1.0)
    for p, q, v in zip(pi[ok], qi[ok], inter[ok]):
        if v > bi[p]:
            bi[p] = v
            best[p] = q
    return best


def load_overture_measured():
    O = AC.load_overture_buildings(only_named_or_measured=True)
    m = np.isfinite(O['h']) | np.isfinite(O['fl'])
    idx = np.nonzero(m)[0]
    import shapely
    g = O['geom'][idx]
    # 多部件取最大块
    g = np.array([max(x.geoms, key=lambda q: q.area) if x.geom_type in ('MultiPolygon', 'GeometryCollection') and hasattr(x, 'geoms') else x for x in g], dtype=object)
    g = np.array([x if x.geom_type == 'Polygon' else shapely.Polygon() for x in g], dtype=object)
    return dict(geom=g, h=O['h'][idx], fl=O['fl'][idx], name=[O['name'][i] for i in idx], rid=[O['rid'][i] for i in idx],
                cls=[O['cls'][i] for i in idx])


def overture_value(O):
    """Overture 每条的可用高度与判定：返回 (val, reason)；val=nan 表示不可用"""
    import shapely
    area = shapely.area(O['geom'])
    val = np.full(len(area), np.nan)
    why = [''] * len(area)
    for i in range(len(area)):
        h, fl, n = O['h'][i], O['fl'][i], O['name'][i]
        if n in OVT_BLACKLIST:
            why[i] = '黑名单：' + OVT_BLACKLIST[n]
            continue
        if (np.isfinite(h) and h > 400) or (np.isfinite(fl) and fl > 80):
            why[i] = '超限（>400 m 或 >80 层）'
            continue
        if np.isfinite(h) and np.isfinite(fl) and fl > 0 and h / fl < 2.0:
            why[i] = f'height={h:g} 与 {fl:g} 层矛盾，改用层数×{FLOOR_H}'
            h = np.nan
        if np.isfinite(h) and h < 2.5:
            why[i] = f'height={h:g} 过小（错标）'
            continue
        v = h if np.isfinite(h) else fl * FLOOR_H
        if area[i] > BIG_AREA and v > 60:
            why[i] = f'整片大轮廓（{area[i]:.0f} m²）带塔楼高'
            continue
        if np.isfinite(h) and np.isfinite(fl) and fl > 0 and not (2.4 <= h / fl <= 6.5):
            why[i] = f'层高异常 {h / fl:.1f} m/层（仍用 height）'
        elif not why[i] and np.isfinite(h) and np.isfinite(fl):
            why[i] = ''
        val[i] = v
    return val, why, area


def apply_sky_fix(sky, B, P):
    """按 SKY_FIX 修 skyline.json（原地修改 sky dict），返回修改记录"""
    import shapely
    tree = shapely.STRtree(P)
    rec = []
    for f in sky['features']:
        for fx in SKY_FIX:
            if f.get('n') != fx['n']:
                continue
            c = fx.get('cond') or {}
            if 'area_gt' in c and not (f.get('area', 0) > c['area_gt']):
                continue
            old = (f.get('h_osm', f['h']), f.get('levels_osm', f.get('levels')))
            if fx['h'] == 'bin' and f.get('hsrc') == 'fix':
                nh = f['h']          # 已修过：保持（重复运行结果不变）
            elif fx['h'] == 'bin':
                poly = shapely.Polygon(np.array(f['outer']).reshape(-1, 2))
                idx = tree.query(poly, predicate='intersects')
                hs = [B['h'][j] for j in idx if shapely.area(shapely.intersection(P[j], poly)) > 0.2 * shapely.area(P[j])
                      and B['h'][j] < 100]
                nh = round(float(np.median(hs)), 1) if hs else 18.0
            else:
                nh = fx['h']
            if f.get('hsrc') != 'fix':
                f['h_osm'], f['levels_osm'] = f['h'], f.get('levels')   # 保留原始 OSM 值备查
            f['h'] = nh
            f['levels'] = fx.get('levels', f.get('levels'))
            f['hsrc'] = 'fix'
            rec.append(dict(n=f['n'], x=f['x'], z=f['z'], area=f.get('area'), before=old, after=(f['h'], f['levels']), why=fx['why']))
    return rec


def curated_public():
    """手工精建塔楼（公开资料高度）与 landmarks2026 可信塔楼：[(name, poly, h, src)]"""
    import shapely
    import check_coords as CC
    out = []
    for s in CC.curated_specs():
        if s['kind'] != 'tower':
            continue
        h = {'陕西信息大厦': 228.0}.get(s['name'], s['h'])  # 信息大厦规格 h=188 为主体，另加 40 m 金字塔顶 + 塔尖
        out.append((s['name'], shapely.Polygon(np.array(s['pts']).reshape(-1, 2)), float(h), 'sky-data'))
    lm = json.loads((AC.DATA / 'landmarks2026.json').read_text('utf-8'))
    towers = {t['name']: t for t in json.loads((ROOT / 'research/refs/landmarks2026/towers.json').read_text('utf-8'))}
    for t in lm.get('towers', []):
        it = towers.get(t['name'])
        if not it or t.get('src') not in ('name', 'contains') or 'estimated' in str(it.get('coord_source')) or t.get('onPodium'):
            continue
        if not str(it.get('status', '')).startswith(('completed', 'topped')):
            continue
        if re.search(r'估计|估算|推测|估 ?~', str(it.get('height_note') or '')):
            continue   # 调研高度本身是估计值：不算公开资料
        out.append((t['name'], shapely.Polygon(np.array(t['pts']).reshape(-1, 2)), float(t['h']), 'landmarks2026'))
    return out


def estates(P):
    """每栋所在的住宅用地多边形下标（landuse residential），不在任何地块内 = -1"""
    import shapely
    L = json.loads((AC.DATA / 'landuse.json').read_text('utf-8'))['polys']
    polys = [shapely.Polygon(np.array(p['outer']).reshape(-1, 2)) for p in L if p['k'] == 'residential' and len(p['outer']) >= 6]
    polys = np.array([p if p.is_valid else p.buffer(0) for p in polys], dtype=object)
    cen = shapely.centroid(P)
    tree = shapely.STRtree(polys)
    ci, pi = tree.query(cen, predicate='within')
    est = np.full(len(P), -1)
    est[ci] = pi
    return est


# ───────────────────────── 统计 ─────────────────────────
def err_stats(h, ref, mask):
    m = mask & np.isfinite(ref)
    if not m.any():
        return dict(n=0)
    e = h[m] - ref[m]
    rel = np.abs(e) / np.maximum(ref[m], 1)
    return dict(n=int(m.sum()), mae=round(float(np.abs(e).mean()), 1), median_abs=round(float(np.median(np.abs(e))), 1),
                bias=round(float(np.median(e)), 1), within10=round(float((rel <= 0.10).mean()) * 100, 1),
                off_gt30=int((rel > 0.30).sum()))


def hist(h):
    edges = [0, 12, 24, 50, 80, 86.5, 100, 150, 200, 500]
    c = np.histogram(h, edges)[0]
    return {f'{edges[i]}-{edges[i + 1]}': int(c[i]) for i in range(len(c))}


# ───────────────────────── 主流程 ─────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--fix', action='store_true', help='写回 skyline.json 与 buildings.bin')
    ap.add_argument('--out', default=str(OUTDIR))
    args = ap.parse_args()
    import shapely
    t0 = time.time()
    B, P = AC.load_bin(BIN)
    n = B['n']
    names = json.loads((AC.DATA / 'buildings_names.json').read_text('utf-8'))
    area = shapely.area(P)
    h0 = B['h'].astype(np.float64).copy()
    flags0 = B['flags'].copy()
    # 可重复运行：备份（首次 --fix 前的原文件）与当前文件轮廓完全一致时，以备份的原始高度/flags 为起点
    bk = BACKUP / (BIN.name + '.before_heights')
    if bk.exists():
        B0 = AC.bldbin.read(str(bk))
        if B0['n'] == n and np.array_equal(B0['offs'], B['offs']) and np.array_equal(B0['ax'], B['ax']):
            h0 = B0['h'].astype(np.float64).copy()
            flags0 = B0['flags'].copy()
            log(f'以备份 {bk.name} 的原始高度为起点（轮廓一致）')
        else:
            log(f'备份 {bk.name} 与当前轮廓不一致（轮廓已被其他工作更新）：以当前文件为起点')
    log(f'buildings.bin：{n} 栋，高度 p50/p90/p99/max = {np.percentile(h0, [50, 90, 99]).round(1)} / {h0.max():.0f}')

    # —— 1. skyline.json 修正 ——
    sky = AC.load_skyline()
    sky_rec = apply_sky_fix(sky, B, P)
    log(f'skyline.json：SKY_FIX 命中 {len(sky_rec)} 条')

    # —— 2. 各来源的参考高度 ——
    O = load_overture_measured()
    ov_val, ov_why, ov_area = overture_value(O)
    j_ov = match_best(P, O['geom'])
    ref_ov = np.where(j_ov >= 0, ov_val[np.maximum(j_ov, 0)], np.nan)
    log(f'Overture 有高度/层数 {len(ov_val)} 条（可用 {int(np.isfinite(ov_val).sum())}），与 bin 对上 {int((j_ov >= 0).sum())} 栋')

    sk_polys, sk_h = [], []
    for f in sky['features']:
        if len(f.get('outer') or []) >= 6:
            sk_polys.append(shapely.make_valid(shapely.Polygon(np.array(f['outer']).reshape(-1, 2))))
            lv = f.get('levels') or 0
            sk_h.append(np.nan if (lv > 80 or f['h'] > 400) else float(f['h']))
    sk_polys = np.array([p if p.geom_type == 'Polygon' else max(getattr(p, 'geoms', [shapely.Polygon()]), key=lambda q: q.area) for p in sk_polys], dtype=object)
    sk_h = np.array(sk_h)
    j_sk = match_best(P, sk_polys, 0.5, 0.35)
    ref_sk = np.where(j_sk >= 0, sk_h[np.maximum(j_sk, 0)], np.nan)

    pub = curated_public()
    pub_polys = np.array([p for _, p, _, _ in pub], dtype=object)
    j_pub = match_best(P, pub_polys, 0.5, 0.2)
    ref_pub = np.where(j_pub >= 0, np.array([h for _, _, h, _ in pub])[np.maximum(j_pub, 0)], np.nan)
    log(f'公开资料塔楼 {len(pub)} 栋（sky-data {sum(1 for q in pub if q[3] == "sky-data")}），与 bin 对上 {int((j_pub >= 0).sum())} 栋')

    measured0 = (flags0 & 1) > 0

    # —— 3. 审计：修正前的异常 ——
    kind = B['kind']
    anomalies = defaultdict(list)

    def bname(i):
        return names.get(str(i), '')
    for i in np.nonzero((kind == 1) & (h0 > 150))[0]:
        anomalies['住宅 > 150 m'].append(int(i))
    for i in np.nonzero(np.isfinite(ref_ov) & (np.abs(h0 - ref_ov) > np.maximum(8, 0.25 * ref_ov)))[0]:
        anomalies['与 Overture 高度/层数×3.1 不符（>25% 且 >8 m）'].append(int(i))
    for i in np.nonzero(np.isfinite(ref_sk) & (np.abs(h0 - ref_sk) > np.maximum(8, 0.25 * ref_sk)))[0]:
        anomalies['与 skyline.json 不符（>25% 且 >8 m）'].append(int(i))
    capped = (~measured0) & (h0 >= 78) & (h0 <= 90.5)
    better = np.fmax(np.fmax(ref_pub, ref_ov), ref_sk)
    for i in np.nonzero(capped & (better > 95))[0]:
        anomalies['CMAB/模型封顶 ≤ 90 m，但公开资料/Overture/skyline 更高'].append(int(i))
    for i in np.nonzero((h0 < 60) & (better > 95))[0]:
        anomalies['超高层只剩裙房高（< 60 m），可信来源 > 95 m'].append(int(i))
    for i in np.nonzero((area > BIG_AREA) & (h0 > 60))[0]:
        anomalies['整片大轮廓（> 8000 m²）高于 60 m'].append(int(i))
    lvl_bad = [(O['name'][k], O['h'][k], O['fl'][k]) for k in range(len(ov_val))
               if np.isfinite(O['h'][k]) and np.isfinite(O['fl'][k]) and O['fl'][k] > 0 and not (2.4 <= O['h'][k] / O['fl'][k] <= 6.5)]

    # —— 4. 同型楼验证与分组 ——
    est = estates(P)
    L, W = mrr_dims(P)
    tall = np.nonzero((h0 >= SIB_MIN_H) | np.isfinite(ref_ov) | np.isfinite(ref_sk))[0]
    tall = tall[est[tall] >= 0]
    groups = defaultdict(list)
    for i in tall:
        groups[(int(est[i]), int(kind[i]))].append(int(i))
    parent = {}

    def find(a):
        while parent.get(a, a) != a:
            parent[a] = parent.get(parent[a], parent[a])
            a = parent[a]
        return a
    for g in groups.values():
        if len(g) < 2:
            continue
        for a_ in range(len(g)):
            i = g[a_]
            for b_ in range(a_ + 1, len(g)):
                j = g[b_]
                if abs(area[i] - area[j]) <= SIB_TOL * max(area[i], area[j]) and abs(L[i] - L[j]) <= SIB_TOL * max(L[i], L[j]) \
                        and abs(W[i] - W[j]) <= SIB_TOL * max(W[i], W[j]):
                    ri, rj = find(i), find(j)
                    if ri != rj:
                        parent[ri] = rj
    sib = defaultdict(list)
    for i in tall:
        sib[find(int(i))].append(int(i))
    sib = [v for v in sib.values() if len(v) >= 2]

    # 验证“同型同高”：组内两栋都有实测（修正前 bin 实测或 Overture/skyline 可用值）的楼对
    truth0 = np.where(np.isfinite(ref_ov), ref_ov, np.where(np.isfinite(ref_sk), ref_sk, np.where(measured0, h0, np.nan)))
    agree = tot = 0
    for g in sib:
        v = [truth0[i] for i in g if np.isfinite(truth0[i])]
        for a_ in range(len(v)):
            for b_ in range(a_ + 1, len(v)):
                tot += 1
                agree += abs(v[a_] - v[b_]) <= 0.1 * max(v[a_], v[b_])
    sib_ok = tot >= 30 and agree / tot >= 0.75
    log(f'同型楼组 {len(sib)} 个；实测楼对验证 同高(±10%) {agree}/{tot} = {agree / max(tot, 1) * 100:.0f}% → {"启用" if sib_ok else "不启用"}组内统一')
    noisy = [g for g in sib if all(not np.isfinite(truth0[i]) for i in g) and len(g) >= 3
             and (max(h0[i] for i in g) - min(h0[i] for i in g)) > 0.3 * np.median([h0[i] for i in g])]
    for g in noisy:
        anomalies['同一小区同型楼忽高忽低（全为模型值，极差 > 30%）'].append(g)

    # —— 5. 目标高度（优先级）——
    h1 = h0.copy()
    src = np.array(['orig'] * n, dtype=object)
    m = np.isfinite(ref_sk) & (np.abs(ref_sk - h0) > 0.5)
    h1[m] = ref_sk[m]
    src[np.isfinite(ref_sk)] = 'skyline'
    m = np.isfinite(ref_ov)
    h1[m] = ref_ov[m]
    src[m] = 'overture'
    m = np.isfinite(ref_pub)
    h1[m] = ref_pub[m]
    src[m] = 'public'
    trusted = np.isin(src, ['public', 'overture', 'skyline']) | measured0

    # 综合体整片轮廓带塔楼高（高度来自实测标签，即塔楼高被标在整片轮廓上）：取裙房高（skyline 修正值 ≤ 60 m 时用之，缺省 30 m）；
    # 无实测的模型值走下面的“大面积”规则
    for i in np.nonzero((area > BIG_AREA) & (h1 > 60) & (src != 'public') & trusted)[0]:
        h1[i] = 30.0 if not (np.isfinite(ref_sk[i]) and ref_sk[i] <= 60) else ref_sk[i]
        src[i] = 'podium'
    # 大面积低可信高值：压到同类实测大楼 90 分位
    big_meas = trusted & (area > BIG_AREA) & (src != 'podium')
    cap = float(np.clip(np.percentile(h1[big_meas], 90), 30, 45)) if big_meas.sum() >= 10 else 36.0
    big_res = []
    for i in np.nonzero((~trusted) & (area > BIG_AREA) & (h1 > max(45.0, cap)))[0]:
        if kind[i] == 1:
            big_res.append(int(i))   # 住宅整片（多栋被合并成一个轮廓）：压低也不对，留给轮廓工作处理，只报告
            continue
        h1[i] = cap
        src[i] = 'bigcap'
    for i in big_res:
        anomalies['住宅整片大轮廓（多栋合并，> 8000 m² 且 > 45 m，未改高度，需轮廓修正）'].append(i)
    log(f'大面积（>{BIG_AREA:.0f} m²）实测楼 {int(big_meas.sum())} 栋，90 分位 → 上限 {cap:.1f} m')
    # 同型楼
    n_sib_prop = n_sib_snap = 0
    if sib_ok:
        for g in sib:
            meas = [h1[i] for i in g if trusted[i] or src[i] in ('public', 'overture', 'skyline')]
            if meas:
                med = float(np.median(meas))
                for i in g:
                    if not trusted[i] and src[i] == 'orig' and abs(h1[i] - med) > 0.1 * med:
                        h1[i] = med
                        src[i] = 'sibling'
                        n_sib_prop += 1
            elif len(g) >= 3:
                v = np.array([h1[i] for i in g])
                if v.max() - v.min() > 0.3 * np.median(v):
                    med = float(np.median(v))
                    for i in g:
                        if abs(h1[i] - med) > 0.05 * med:
                            h1[i] = med
                            src[i] = 'sibling_snap'
                            n_sib_snap += 1
    h1 = np.round(h1, 1)

    # —— 6. 统计（修正前 / 后）——
    ref_best = np.where(np.isfinite(ref_pub), ref_pub, np.where(np.isfinite(ref_ov), ref_ov, ref_sk))
    rows = {}
    for lab, ref in (('公开资料', ref_pub), ('Overture', ref_ov), ('skyline.json', ref_sk), ('最可信来源', ref_best)):
        rows[lab] = (err_stats(h0, ref, np.ones(n, bool)), err_stats(h1, ref, np.ones(n, bool)))
    changed = np.nonzero(np.abs(h1 - h0) >= 0.5)[0]
    by_src = Counter(src[i] for i in changed)
    log(f'将修改 {len(changed)} 栋：{dict(by_src)}；同型楼 传播 {n_sib_prop}、归一 {n_sib_snap}')
    for lab, (a, b) in rows.items():
        log(f'  {lab:8s} 前 {a}\n  {"":8s} 后 {b}')

    # —— 7. 报告 ——
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    big_changes = sorted([int(i) for i in changed if abs(h1[i] - h0[i]) >= 10], key=lambda i: -abs(h1[i] - h0[i]))
    chg = [dict(i=int(i), name=bname(i), x=round(float(B['ax'][i]), 1), z=round(float(B['az'][i]), 1), area=round(float(area[i])),
                kind=int(kind[i]), before=float(h0[i]), after=float(h1[i]), src=src[i],
                ovt=None if not np.isfinite(ref_ov[i]) else float(ref_ov[i]),
                ovt_name=O['name'][j_ov[i]] if j_ov[i] >= 0 else '', ovt_rid=O['rid'][j_ov[i]] if j_ov[i] >= 0 else '',
                sky=None if not np.isfinite(ref_sk[i]) else float(ref_sk[i]),
                pub=pub[j_pub[i]][0] if j_pub[i] >= 0 else '') for i in changed]
    (out / 'heights_changes.json').write_text(json.dumps(dict(
        generated=time.strftime("%Y-%m-%d %H:%M"), sky_fix=sky_rec, changes=chg,
        anomalies={k: [[int(j) for j in it] if isinstance(it, list) else int(it) for it in v] for k, v in anomalies.items()},
        stats={k: dict(before=a, after=b) for k, (a, b) in rows.items()},
        hist_before=hist(h0), hist_after=hist(h1)), ensure_ascii=False, indent=1), 'utf-8')

    md = ['# 建筑高度审计报告（tools/check_heights.py 自动生成）', '',
          f'- 生成：{time.strftime("%Y-%m-%d %H:%M")}；buildings.bin {n} 栋；Overture 2026-09 有高度/层数 {len(ov_val)} 条（可用 {int(np.isfinite(ov_val).sum())}）；'
          f'skyline.json {len(sky["features"])} 条；公开资料塔楼 {len(pub)} 栋',
          '- 优先级：公开资料 > Overture 实测（height，缺省 num_floors×3.1 m）> skyline.json（OSM）> CMAB/模型', '',
          '## 与各来源的偏差（修正前 → 修正后）', '',
          '| 参照 | 栋数 | 平均绝对误差 m | 中位偏差 m | ±10% 内 | 偏差 >30% 栋数 |', '|---|---|---|---|---|---|']
    for lab, (a, b) in rows.items():
        if a.get('n'):
            md.append(f'| {lab} | {a["n"]} | {a["mae"]} → {b["mae"]} | {a["bias"]} → {b["bias"]} | {a["within10"]}% → {b["within10"]}% | {a["off_gt30"]} → {b["off_gt30"]} |')
    # 模型预测值（修正前无实测）与本次新增的实测对比：检验“封顶”是否系统性偏低
    newm = (~measured0) & np.isfinite(np.where(np.isfinite(ref_pub), ref_pub, ref_ov))
    truth_new = np.where(np.isfinite(ref_pub), ref_pub, ref_ov)
    md += ['', '## 模型预测值 vs 本次新增实测（修正前无实测、现有公开资料/Overture 值的楼）', '',
           '| 模型值区间 m | 栋数 | 实测中位 m | 实测 25–75% m |', '|---|---|---|---|']
    for lo, hi in ((0, 12), (12, 24), (24, 50), (50, 78), (78, 91), (91, 400)):
        mm = newm & (h0 >= lo) & (h0 < hi)
        if mm.any():
            q = np.percentile(truth_new[mm], [25, 50, 75])
            md.append(f'| {lo}–{hi} | {int(mm.sum())} | {q[1]:.1f} | {q[0]:.1f}–{q[2]:.1f} |')
    ncap = int((newm & (h0 >= 78) & (h0 < 91)).sum())
    ncap_all = int(((~measured0) & (h0 >= 78) & (h0 < 91)).sum())
    md += ['', f'说明：模型封顶段（78–91 m）共 {ncap_all} 栋，其中只有 {ncap} 栋有新实测，样本不足以支撑整体上调（整体上调会把同样被封顶的'
           f' 60–80 m 住宅一起拉高）；被严重低估的主要是“只剩裙房/多层高度的超高层”（模型值 < 78 m 而实测 ≫ 100 m），'
           '只能逐栋用公开资料/实测修正（见下文），其余超高层由 skyline 模块按调研清单精建覆盖。']
    md += ['', '## 高度分布（栋）', '', '| 区间 m | 修正前 | 修正后 |', '|---|---|---|']
    hb, ha = hist(h0), hist(h1)
    for k in hb:
        md.append(f'| {k} | {hb[k]} | {ha[k]} |')
    md += ['', f'## 修改汇总：{len(changed)} 栋', '', '| 来源 | 栋数 |', '|---|---|']
    for k, v in by_src.most_common():
        md.append(f'| {k} | {v} |')
    md += ['', f'同型楼验证：实测楼对“同型同高（±10%）” {agree}/{tot}（{agree / max(tot, 1) * 100:.0f}%），'
           f'{"≥ 75%，启用" if sib_ok else "< 75% 或样本不足，不启用"}组内统一；传播 {n_sib_prop} 栋、离散组归一 {n_sib_snap} 栋；'
           f'大面积无实测上限 {cap:.1f} m。', '', '## skyline.json 修正（SKY_FIX）', '']
    for r in sky_rec:
        md.append(f'- **{r["n"]}**（{r["x"]:.0f},{r["z"]:.0f}，{r["area"]:.0f} m²）：{r["before"][0]} m/{r["before"][1]} 层 → {r["after"][0]} m/{r["after"][1]} 层。{r["why"]}')
    md += ['', '## 修正前的异常', '']
    for k, v in anomalies.items():
        md.append(f'### {k}：{len(v)}')
        for it in v[:25]:
            if isinstance(it, list):
                md.append(f'- 组 {len(it)} 栋（{B["ax"][it[0]]:.0f},{B["az"][it[0]]:.0f}）：' + '、'.join(f'{h0[i]:.0f}' for i in it[:12]) + ' m')
            else:
                i = it
                md.append(f'- #{i} {bname(i)}（{B["ax"][i]:.0f},{B["az"][i]:.0f}，{area[i]:.0f} m²，kind {kind[i]}）{h0[i]:.1f} m；'
                          f'Overture {ref_ov[i] if np.isfinite(ref_ov[i]) else "-"}，skyline {ref_sk[i] if np.isfinite(ref_sk[i]) else "-"}，'
                          f'公开 {ref_pub[i] if np.isfinite(ref_pub[i]) else "-"} → {h1[i]:.1f}（{src[i]}）')
        if len(v) > 25:
            md.append(f'- …… 共 {len(v)} 条（完整下标见 heights_changes.json 的 anomalies）')
        md.append('')
    md += [f'### Overture 自身层高异常（height/num_floors 不在 2.4–6.5 m）：{len(lvl_bad)}', '']
    md += [f'- {nm or "(无名)"}：{hh} m / {int(ff)} 层 = {hh / ff:.1f} m/层' for nm, hh, ff in lvl_bad[:30]]
    md += ['', '### Overture 未采用的值', '']
    for k in range(len(ov_val)):
        if not np.isfinite(ov_val[k]) and ov_why[k]:
            md.append(f'- {O["name"][k] or "(无名)"} {O["rid"][k]}：height {O["h"][k]}，层数 {O["fl"][k]}——{ov_why[k]}')
    md += ['', '## 变化 ≥ 10 m 的建筑（前 80）', '', '| # | 名称 | 位置 | 面积 m² | 前 m | 后 m | 依据 |', '|---|---|---|---|---|---|---|']
    for i in big_changes[:80]:
        why = {'public': '公开资料：' + (pub[j_pub[i]][0] if j_pub[i] >= 0 else ''),
               'overture': f'Overture {O["rid"][j_ov[i]] if j_ov[i] >= 0 else ""} {O["name"][j_ov[i]] if j_ov[i] >= 0 else ""}',
               'skyline': 'skyline.json', 'podium': '整片综合体轮廓→裙房高', 'bigcap': '大面积无实测上限',
               'sibling': '同型楼实测', 'sibling_snap': '同型楼组内中位'}.get(src[i], src[i])
        md.append(f'| {i} | {bname(i)} | {B["ax"][i]:.0f},{B["az"][i]:.0f} | {area[i]:.0f} | {h0[i]:.1f} | {h1[i]:.1f} | {why} |')
    (out / 'heights_report.md').write_text('\n'.join(md) + '\n', 'utf-8')
    log(f'写出 {out / "heights_report.md"}、heights_changes.json（{time.time() - t0:.0f}s）')

    if not args.fix:
        log('（审计模式，未写回；加 --fix 写回）')
        return
    # —— 8. 写回 ——
    BACKUP.mkdir(parents=True, exist_ok=True)
    for f in (BIN, SKY):
        bk = BACKUP / (f.name + '.before_heights')
        if not bk.exists():
            shutil.copy2(f, bk)
            log(f'备份 {f.name} → {bk}')
    SKY.write_text(json.dumps(sky, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    # buildings.bin：按字节原位改写 heightDm / minHeightDm / flags
    raw = bytearray(BIN.read_bytes())
    ver, cnt, _ = struct.unpack('<III', raw[4:16])
    assert cnt == n
    o_h = 16 + 4 * n * 2 + 4 * n + 2 * n
    o_m = o_h + 2 * n
    o_f = o_m + 2 * n + n
    hd = np.clip(np.round(h1 * 10), 30, 65535).astype('<u2')
    md_ = np.frombuffer(bytes(raw[o_m:o_m + 2 * n]), '<u2').copy()
    md_ = np.minimum(md_, np.maximum(hd.astype(np.int64) - 10, 0)).astype('<u2')
    fl = flags0.copy()
    meas = np.isin(src, ['public', 'overture', 'skyline', 'sibling'])
    fl[meas] |= 1
    fl = np.where(hd >= 1000, fl | 4, fl & ~np.uint8(4)).astype(np.uint8)
    fl[np.isfinite(ref_sk)] |= 8
    raw[o_h:o_h + 2 * n] = hd.tobytes()
    raw[o_m:o_m + 2 * n] = md_.tobytes()
    raw[o_f:o_f + n] = fl.tobytes()
    tmp = BIN.with_suffix('.bin.part')
    tmp.write_bytes(bytes(raw))
    tmp.replace(BIN)
    B2 = AC.bldbin.read(str(BIN))
    assert np.array_equal(B2['offs'], B['offs']) and np.array_equal(B2['ax'], B['ax']), '轮廓被改动！'
    log(f'写回 {BIN}（{len(changed)} 栋高度）与 {SKY}（{len(sky_rec)} 条）')


if __name__ == '__main__':
    main()
