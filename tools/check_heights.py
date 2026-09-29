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
SKY_FIX += [
    dict(n='陕西电信广场', h=180, levels=36,
         why='CTBUH 180 m/36F（2004 年竣工，即“陕西省电信网管大厦”，高新路与科技路十字西南角）；OSM 160 m/50 层为旧值'),
    dict(n='君悦酒店(迈科中心店)', h=161, levels=34, why='CTBUH 161 m/34F（OSM 155.35；开发商口径 165）'),
    dict(n='陕西永利国际金融中心', cond={'area_lt': 3000, 'z_lt': 7560}, rename='天朗·秦商国际中心 1号楼', h=217, levels=50,
         why='锦业一路以北这块 87×31 m 轮廓（OSM w1387164542）是秦商国际中心 1 号楼地块，被错标成“永利 212 m”；永利实际在锦业一路以南'
             '（地址“锦业一路与丈八一路十字西南角”、CTBUH 坐标，research/refs/dossiers/gaoxin.json）；按秦商 CTBUH 217 m/50F'),
]

# ───────────── 逐栋档案（research/refs/dossiers/*.json）给出的高度：直接改 buildings.bin ─────────────
# ovt：Overture building id（可给前缀，多个）；ll/xz：点位（取包含该点的楼，或 r 米内锚点最近、面积 ≥ 300 m² 的楼）
# 层数换算：办公/酒店/公建 3.6 m/层、商场 4.5 m/层、写字楼“近百米”项目 4.2 m/层（均在 why 中写明）
POINT_FIX = [
    dict(n='交通银行陕西省分行大楼', ovt=['12eda0bf'], h=74.4, why='高楼迷网友仰角实测不含塔尖 74.4 m（非官方）；OSM height=20 偏低'),
    dict(n='皇城大厦（皇城海航酒店）', ll=(108.9503, 34.2644), r=30, h=70.4,
         why='16 层；网友实测屋顶平台 70.4 m（塔尖 82.9 m 不计）；位置为影像目视（±30 m）'),
    dict(n='西安钟楼饭店', ovt=['5a869da7'], h=25.2, why='7 层（新浪 2022 实拍“一共是七层”），7×3.6 m'),
    dict(n='陕西省人民政府办公大楼', ovt=['f85d1586'], h=43.2, why='照片计数约 12 层（非来源值），12×3.6 m'),
    dict(n='西安金花豪生国际大酒店', ovt=['7cae1c50'], h=75.6, why='21 层（携程/百科摘要），21×3.6 m'),
    dict(n='银泰城（小寨店）', ovt=['57401636'], h=45.0, why='地上 10 层（商场 4.5 m/层）'),
    dict(n='陕西奥罗国际大酒店', ovt=['d5f6ad4f'], h=74.1, why='网友实测北侧方塔 74.1 m（南侧弧面 70.5 m），非官方'),
    dict(n='华侨城·长安国际中心 四塔', ovt=['a873ff83', '3bccb574', '863b36ab', '87701acc'], h=92.4,
         why='永宁门外西南 2×2 四塔，项目 22 层（“近百米”），22×4.2 m；原 buildings.bin 为 26–56 m 推断值'),
    dict(n='中国国际丝路中心大厦（现状核心筒）', ll=(108.768209, 34.258591), r=25, h=300.0,
         why='2024-03 官方回复：核心筒 61 层约 300 m、外框 40 余层；bin 此处为 71 m 局部块'),
    dict(n='苏陕国际金融中心 塔1', xz=(9827.4, -5754.8), r=25, h=132.7, why='拆降至 32 层，153.4 m×32/37 ≈ 132.7 m；位置为 ML 候选轮廓'),
    dict(n='苏陕国际金融中心 塔2', xz=(9916.4, -5718.8), r=25, h=132.7, why='同塔1'),
    dict(n='陕铁大厦', ll=(108.968439, 34.157468), r=25, h=99.8, why='99.8 m/23F（招商稿）；东长安街×神舟四路西北角候选轮廓'),
]

# 公共建筑（research/refs/dossiers/public.json 有层数的）：只抬高轮廓内最高的 N 栋（主楼），不降低、不动裙房
# ovt：Overture id 前缀；top：从高到低依次赋给轮廓内最高的几栋（层数 × 层高，层高写在 why 中）
PUBLIC_FLOORS = [
    dict(n='西京医院（空军军医大学第一附属医院）', ovt=['25b169f2'], top=[80.0, 76.0],
         why='北楼 20 层、南楼 19 层、裙楼 5 层（中联西北院通稿），医院按 4.0 m/层；CMAB 仅 12.6–19.9 m'),
    dict(n='交大一附院（雁塔西路）外科大楼', ovt=['3622261a'], top=[52.0], why='外科大楼 13 层（健康界 2023-10-27），4.0 m/层'),
    dict(n='西安市第三医院 住院楼', ovt=['37c17aee'], top=[52.0], why='西院住院楼 13 层（north.json 转引卫健委摘要），4.0 m/层'),
    dict(n='西安交大钱学森图书馆 南楼', ovt=['cafc0ed6'], top=[46.2], why='南楼 II 段地上 11 层（交大官网/地方志办），4.2 m/层'),
    dict(n='长安大学渭水校区逸夫图书馆', ovt=['42e588d3'], top=[52.0], why='主体地上 13 层（长安大学官网），4.0 m/层'),
    dict(n='陕西省图书馆（长安北路主馆）', ovt=['928a0ecd'], top=[42.0], why='主楼地上 10 层（zh.wikipedia），4.2 m/层；CMAB 16 m'),
]
RES_FLOOR_H = 3.0      # 住宅层高（2.9–3.0 m）
ESTATES = OUTDIR / 'estate_floors.json'   # 由 research/refs/dossiers/residential.json 生成（--dossiers 重新生成）

# Overture 高度黑名单（名称 → 依据）：不参与修正
OVT_BLACKLIST = {
    '西安公路研究院': 'height=800 为错标',
    '主题楼': 'height=225/45F（108.9253,34.2196 一带学校建筑），查无此超高层，疑为错标（research towers_notes §4）',
    '陕西永利国际金融中心': 'w1387164542 上的 height=212/46F 属于永利，但该轮廓（锦业一路以北）实为秦商国际中心 1 号楼地块（错标，gaoxin 档案）',
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
            if f.get('n') != fx['n'] and not (fx.get('rename') and f.get('n') == fx['rename'] and f.get('n_osm') == fx['n']):
                continue
            c = fx.get('cond') or {}
            if 'area_gt' in c and not (f.get('area', 0) > c['area_gt']):
                continue
            if 'area_lt' in c and not (f.get('area', 0) < c['area_lt']):
                continue
            if 'z_lt' in c and not (f['z'] < c['z_lt']):
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
            if fx.get('rename') and f['n'] != fx['rename']:
                f['n_osm'] = f['n']
                f['n'] = fx['rename']
            rec.append(dict(n=f.get('n_osm', f['n']) + (f' → 改名“{f["n"]}”' if f.get('n_osm') else ''), x=f['x'], z=f['z'], area=f.get('area'),
                            before=old, after=(f['h'], f['levels']), why=fx['why']))
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


def build_estate_table(dossiers):
    """residential.json（房天下成交记录的“总层数”）→ 精简表 research/audit/estate_floors.json：
    每个小区 名称 / 世界坐标 / landuse 多边形名 / 高层(≥12)与小高层(8–11)真实层数集合 / 置信度"""
    src = Path(dossiers) / 'residential.json'
    if not src.exists():
        return None
    out = []
    for it in json.loads(src.read_text('utf-8')):
        ld = it.get('local_data') or {}
        fl = sorted({int(f) for f in (ld.get('fang_transaction_floors') or []) if f})
        cs = str(it.get('coord_source') or '')
        lu = [q.strip() for m in re.findall(r'landuse_polygon_centroid\(([^;)]*)', cs) for q in re.split(r'[、,，]', m) if q.strip()]
        xz = it.get('world_xz')
        if not xz:
            continue
        out.append(dict(name=it['name'], x=xz[0], z=xz[1], landuse=lu, confidence=it.get('confidence'),
                        high=[f for f in fl if f >= 12], mid=[f for f in fl if 8 <= f <= 11], year=it.get('year')))
    doc = dict(source='research/refs/dossiers/residential.json（房天下成交记录“总层数”，2026-09-28 调研）', estates=out)
    ESTATES.parent.mkdir(parents=True, exist_ok=True)
    ESTATES.write_text(json.dumps(doc, ensure_ascii=False, indent=1), 'utf-8')
    return doc


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
    ap.add_argument('--dossiers', default=str(ROOT / 'research' / 'refs' / 'dossiers'),
                    help='逐栋档案目录；有 residential.json 时重新生成 research/audit/estate_floors.json')
    args = ap.parse_args()
    if build_estate_table(args.dossiers):
        log(f'由 {args.dossiers}/residential.json 重新生成 {ESTATES}')
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
    # 逐栋档案
    pf_rec = []
    ref_dos = np.full(n, np.nan)
    dos_name = {}
    Ofull = AC.load_overture_buildings(only_named_or_measured=False) if any('ovt' in q for q in POINT_FIX) else None
    btree = shapely.STRtree(P)
    for q in POINT_FIX:
        hit = []
        if 'ovt' in q:
            ks = [k for k, oid in enumerate(Ofull['id']) if any(str(oid).startswith(pfx) for pfx in q['ovt'])]
            for k in ks:
                g = Ofull['geom'][k]
                best, bi = None, 0.0
                got = False
                for j in btree.query(g, predicate='intersects'):
                    inter = shapely.area(shapely.intersection(P[j], g))
                    if inter >= 0.5 * area[j] and inter >= 0.1 * g.area:
                        hit.append(int(j))
                        got = True
                    elif inter > bi:
                        best, bi = int(j), inter
                # 兜底：CMAB 轮廓相对 OSM 错位（屋顶/底座投影差）时，取重叠最大、面积相近、质心 30 m 内的那一栋
                if not got and best is not None and bi >= 0.15 * g.area and 0.5 <= area[best] / g.area <= 2.0 \
                        and shapely.distance(shapely.centroid(P[best]), g.centroid) < 30:
                    hit.append(best)
        else:
            x, z = q['xz'] if 'xz' in q else AC.geo.project(*q['ll'])
            pt = shapely.Point(x, z)
            hit = [int(j) for j in btree.query(pt, predicate='within')]
            if not hit:
                d = np.hypot(B['ax'] - x, B['az'] - z)
                cand = np.nonzero((d < q.get('r', 25)) & (area >= 300))[0]
                if len(cand):
                    hit = [int(cand[np.argmin(d[cand])])]
        for j in hit:
            ref_dos[j] = q['h']
            dos_name[j] = q['n']
        pf_rec.append(dict(n=q['n'], h=q['h'], bins=[(j, float(h0[j])) for j in hit], why=q['why']))
    m = np.isfinite(ref_dos)
    h1[m] = ref_dos[m]
    src[m] = 'dossier'
    log(f'逐栋档案 POINT_FIX {len(POINT_FIX)} 条，命中 {int(m.sum())} 栋：' + '；'.join(f"{r['n']}×{len(r['bins'])}" for r in pf_rec))
    trusted = np.isin(src, ['public', 'overture', 'skyline', 'dossier']) | measured0

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

    # —— 小区真实层数（房天下成交记录）：CMAB 分档（高度÷3 m）内按高度名次做分位映射到真实层数集合 ——
    est_rec = []
    if ESTATES.exists():
        L_lu = json.loads((AC.DATA / 'landuse.json').read_text('utf-8'))['polys']
        lu = [(shapely.make_valid(shapely.Polygon(np.array(q['outer']).reshape(-1, 2))), q.get('n') or '')
              for q in L_lu if q['k'] == 'residential' and len(q['outer']) >= 6]
        cen = shapely.centroid(P)
        ctree = shapely.STRtree(cen)
        for e in json.loads(ESTATES.read_text('utf-8'))['estates']:
            if e.get('confidence') == 'low' or not (e['high'] or e['mid']):
                continue
            keys = {AC.norm(e['name'])} | {AC.norm(q) for q in e.get('landuse') or []}
            polys = [pg for pg, nm in lu if nm and AC.norm(nm) in keys]
            if not polys:
                pt = shapely.Point(e['x'], e['z'])
                polys = [pg for pg, nm in lu if pg.contains(pt)]
            if not polys:
                est_rec.append(dict(n=e['name'], note='无 landuse 多边形，跳过'))
                continue
            U = shapely.union_all(polys)
            inside = [int(j) for j in ctree.query(U, predicate='contains')]
            cand = [j for j in inside if kind[j] in (0, 1) and src[j] == 'orig' and not measured0[j] and area[j] >= 120]
            ch = {}
            for tier, lo, hi, vals in (('high', 12, 99, e['high']), ('mid', 8, 11, e['mid'])):
                mem = [j for j in cand if lo <= round(h0[j] / 3.0) <= hi]
                if not vals or not mem:
                    continue
                vals = sorted(vals)
                hs = np.array([h0[j] for j in mem])
                # 同高并列取平均名次
                order = np.argsort(hs, kind='stable')
                ranks = np.empty(len(mem))
                ranks[order] = np.arange(len(mem))
                for v in np.unique(hs):
                    ranks[hs == v] = ranks[hs == v].mean()
                for j, rk in zip(mem, ranks):
                    q = (rk + 0.5) / len(mem)
                    f = vals[min(int(q * len(vals)), len(vals) - 1)]
                    nh = f * RES_FLOOR_H
                    # 只抬高不降低：成交记录只是抽样（层数集合不含频次），用来纠正 CMAB/模型的封顶与压低，不据此把楼压矮
                    if nh - h1[j] >= 1.0:
                        ch[j] = (float(h1[j]), nh)
                        h1[j] = nh
                        src[j] = 'estate'
            if ch:
                b = np.array([v[0] for v in ch.values()])
                a = np.array([v[1] for v in ch.values()])
                est_rec.append(dict(n=e['name'], changed=len(ch), before_max=float(b.max()), after_max=float(a.max()),
                                    before_med=float(np.median(b)), after_med=float(np.median(a)), high=e['high'], mid=e['mid']))
            elif e['high'] and not any(round(h0[j] / 3.0) >= 12 for j in inside):
                est_rec.append(dict(n=e['name'], note=f'成交记录有 {max(e["high"])} 层，但 CMAB 该小区内没有高层轮廓（影像早于建成/漏提），高度无法修，需轮廓数据'))
        n_est = sum(r.get('changed', 0) for r in est_rec)
        log(f'小区真实层数：{sum(1 for r in est_rec if r.get("changed"))} 个小区、{n_est} 栋改高；'
            f'{sum(1 for r in est_rec if "note" in r)} 个小区无法修（见报告）')
    # —— 公共建筑层数：只抬高主楼 ——
    pubf_rec = []
    if PUBLIC_FLOORS:
        Ofull = Ofull if Ofull is not None else AC.load_overture_buildings(only_named_or_measured=False)
        for q in PUBLIC_FLOORS:
            ks = [k for k, oid in enumerate(Ofull['id']) if any(str(oid).startswith(pfx) for pfx in q['ovt'])]
            mem = []
            for k in ks:
                g = Ofull['geom'][k]
                for j in btree.query(g, predicate='intersects'):
                    if shapely.area(shapely.intersection(P[j], g)) >= 0.5 * area[j] and area[j] >= 200:
                        mem.append(int(j))
            mem = sorted(set(mem), key=lambda j: (-h1[j], -area[j]))
            done = []
            for j, v in zip(mem, q['top']):
                if v > h1[j]:
                    done.append((j, float(h1[j]), v))
                    h1[j] = v
                    src[j] = 'public_floors'
            pubf_rec.append(dict(n=q['n'], bins=done, why=q['why'], found=len(mem)))
        log('公共建筑层数：' + '；'.join(f"{r['n']}×{len(r['bins'])}" for r in pubf_rec))
    h1 = np.round(h1, 1)

    # —— 6. 统计（修正前 / 后）——
    ref_best = np.where(np.isfinite(ref_dos), ref_dos, np.where(np.isfinite(ref_pub), ref_pub, np.where(np.isfinite(ref_ov), ref_ov, ref_sk)))
    rows = {}
    for lab, ref in (('公开资料', ref_pub), ('逐栋档案', ref_dos), ('Overture', ref_ov), ('skyline.json', ref_sk), ('最可信来源', ref_best)):
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
    md += ['', '## 逐栋档案（research/refs/dossiers）直接给定的高度（POINT_FIX）', '']
    for r in pf_rec:
        md.append(f"- **{r['n']}** → {r['h']} m：" + ('、'.join(f'#{j}（原 {hb:.1f} m）' for j, hb in r['bins']) or '未命中 buildings.bin（另由 landmarks2026 建模）')
                  + f"。{r['why']}")
    md += ['', '## 小区真实层数（房天下成交记录“总层数”，research/audit/estate_floors.json）', '',
           f'方法：小区 landuse 多边形内、无实测的住宅/通用楼，按 CMAB 高度÷3 m 分档（高层 ≥12、小高层 8–11），档内按高度名次做分位映射到'
           f'成交记录中该档的真实层数集合，高度 = 层数 × {RES_FLOOR_H} m；只抬高不降低（成交记录是抽样、不含频次）；多层/低层不动。', '',
           '| 小区 | 改高栋数 | 修前最高/中位 m | 修后最高/中位 m | 成交记录高层层数 |', '|---|---|---|---|---|']
    for r in est_rec:
        if r.get('changed'):
            md.append(f"| {r['n']} | {r['changed']} | {r['before_max']:.1f} / {r['before_med']:.1f} | {r['after_max']:.1f} / {r['after_med']:.1f} | {r['high']} |")
    md += [''] + [f"- {r['n']}：{r['note']}" for r in est_rec if 'note' in r]
    md += ['', '## 公共建筑层数（public.json，只抬高主楼）', '']
    for r in pubf_rec:
        md.append(f"- **{r['n']}**：" + ('、'.join(f'#{j} {a:.1f}→{b:.1f} m' for j, a, b in r['bins']) or f'无需改（轮廓内 {r["found"]} 栋已不低于资料）')
                  + f"。{r['why']}")
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
               'sibling': '同型楼实测', 'sibling_snap': '同型楼组内中位', 'dossier': '逐栋档案：' + dos_name.get(int(i), ''),
               'estate': '小区成交记录层数', 'public_floors': '公共建筑层数'}.get(src[i], src[i])
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
    meas = np.isin(src, ['public', 'overture', 'skyline', 'sibling', 'dossier', 'estate', 'public_floors'])
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
