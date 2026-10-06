#!/usr/bin/env python3
"""逐栋档案轮廓：按 research/refs/dossiers/*.json 里出现的全部 Overture 建筑 id，从 data-src/overture/building.parquet
抽取轮廓，投影为世界坐标（x 东、z 南，原点钟楼，tools/geo.py project），简化后写 public/data/dossier_fp.json。

输出（dossier-kit.js 的 fp:'<id>' 从这里取）：
  {
    "<overture_id>": [x0,z0,x1,z1,...],        # 外环，CCW（G.area>0，与 src/arch/sky-geom.js 一致），不闭合，0.1 m 精度
    ...,
    "_holes": {"<overture_id>": [[x,z,...], ...]},   # 有内院/天井的轮廓的内环（同样 CCW 存放，用时由 buildPodium 自行翻转）
    "_alias": {"<8 位前缀>": "<完整 id>"},             # 档案正文里以 8 位前缀提到的轮廓（如“Overture 另有独立轮廓 60562511”）
    "_meta":  {"<overture_id>": {"n": 名称, "src": "OSM w123@1 / ML", "h": 高度, "f": 层数, "a": 面积m², "c": [x,z]}}
  }
id 的来源：① 各档案条目（及 massing 分体）里的 overture_id 字段（"a / b" 这类写法按 UUID 正则拆开）；
          ② 档案正文任意位置出现的完整 UUID；③ 正文里 “Overture/轮廓/ML/候选…” 附近的 8 位十六进制前缀（在 parquet 中唯一匹配才收录）；
          ④ src/arch/dossier-specs/*.js 里引用的完整 UUID（spec 可以用档案之外、卫星核对过的分体轮廓，如塔楼单独的 OSM 轮廓）。
多面体（MultiPolygon）取面积最大的一块；简化容差默认 0.5 m（--tol），保证简化后面积变化 < 3%，否则退回 0.2 m。

用法（仓库根目录）：
  python3 tools/build_dossier_fp.py [--dossiers 目录] [--parquet 路径] [--tol 0.5] [--show id前缀 ...]
worktree 里没有 data-src/ 或档案时，自动回退到主仓库 /home/user/xian3d 下的同名路径。
"""
import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import shapely
from shapely.geometry import Polygon

ROOT = Path(__file__).resolve().parents[1]
MAIN = Path('/home/user/xian3d')  # 主仓库（worktree 缺数据时回退）
sys.path.insert(0, str(ROOT / 'tools'))
from geo import project  # noqa: E402

UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
# 8 位前缀：前后不接十六进制/连字符；前面 40 字内要有“Overture/轮廓/ML/候选/OSM”等字样，避免把图片 URL 里的哈希当成 id
PREFIX = re.compile(r'(?<![0-9a-zA-Z-])([0-9a-f]{8})(?![0-9a-zA-Z-])')
PREFIX_CTX = re.compile(r'Overture|overture|轮廓|ML|候选|zenodo|名称轮廓')


def in_url(txt, i):
    """位置 i 的匹配是否在一个 URL 里（照片/新闻链接中的哈希不是轮廓引用）"""
    if i > 0 and txt[i - 1] == '/':
        return True
    pre = txt[max(0, i - 120):i]
    k = pre.rfind('http')
    return k >= 0 and not re.search(r'[\s\'",]', pre[k:])


FILES = ['core_south', 'gaoxin', 'north', 'east_west', 'public', 'residential', 'landmarks2']


def first_existing(*cands):
    for c in cands:
        if c and Path(c).exists():
            return Path(c)
    return None


def collect_ids(ddir):
    """返回 (完整 id → 出处列表, 前缀 → 出处列表)"""
    full, pref = {}, {}

    def note(d, k, where):
        d.setdefault(k, [])
        if where not in d[k]:
            d[k].append(where)

    def walk(o, where):
        if isinstance(o, dict):
            nm = o.get('name') or where
            for k, v in o.items():
                if k == 'overture_id' and isinstance(v, str):
                    for u in UUID.findall(v):
                        note(full, u, nm)
                walk(v, nm)
        elif isinstance(o, list):
            for x in o:
                walk(x, where)

    for f in FILES:
        p = ddir / f'{f}.json'
        if not p.exists():
            print('缺少档案', p)
            continue
        txt = p.read_text(encoding='utf-8')
        walk(json.loads(txt), f)
        for m in UUID.finditer(txt):
            if not in_url(txt, m.start()):
                note(full, m.group(0), f + '（正文）')
        for m in PREFIX.finditer(txt):
            ctx = txt[max(0, m.start() - 40):m.start()]
            if PREFIX_CTX.search(ctx):
                note(pref, m.group(1), f + '（正文前缀）')
    for f in FILES:  # 各片区 notes 里的前缀引用
        p = ddir / f'{f}_notes.md'
        if p.exists():
            txt = p.read_text(encoding='utf-8')
            for m in UUID.finditer(txt):
                if not in_url(txt, m.start()):
                    note(full, m.group(0), f + '_notes')
            for m in PREFIX.finditer(txt):
                ctx = txt[max(0, m.start() - 40):m.start()]
                if PREFIX_CTX.search(ctx):
                    note(pref, m.group(1), f + '_notes（前缀）')
    # ④ spec 文件里引用的 id（fp:'<uuid>'）
    sdir = ROOT / 'src/arch/dossier-specs'
    for p in sorted(sdir.glob('*.js')) if sdir.exists() else []:
        txt = p.read_text(encoding='utf-8')
        for m in UUID.finditer(txt):
            if not in_url(txt, m.start()):
                note(full, m.group(0), 'spec:' + p.name)
        for m in re.finditer(r"fp:\s*'([0-9a-f]{8})'", txt):
            note(pref, m.group(1), 'spec:' + p.name)
    return full, pref


def ring_ccw(xy):
    a = np.asarray(xy, float)
    sa = 0.5 * np.sum(a[:, 0] * np.roll(a[:, 1], -1) - a[:, 1] * np.roll(a[:, 0], -1))
    return a[::-1] if sa < 0 else a


def to_world(pg, tol):
    """经纬度 Polygon → 世界坐标 Polygon（简化后）"""
    ext = [project(x, y) for x, y in pg.exterior.coords]
    holes = [[project(x, y) for x, y in h.coords] for h in pg.interiors]
    wp = Polygon(ext, holes)
    if not wp.is_valid:
        wp = wp.buffer(0)
        if wp.geom_type != 'Polygon':
            wp = max(wp.geoms, key=lambda g: g.area)
    s = wp.simplify(tol, preserve_topology=True)
    if s.is_empty or abs(s.area - wp.area) > 0.03 * wp.area:
        s = wp.simplify(0.2, preserve_topology=True)
    return s, wp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dossiers', default=None)
    ap.add_argument('--parquet', default=None)
    ap.add_argument('--out', default=str(ROOT / 'public/data/dossier_fp.json'))
    ap.add_argument('--tol', type=float, default=0.5)
    ap.add_argument('--show', nargs='*', default=[], help='打印这些 id（或前缀）的世界坐标轮廓')
    a = ap.parse_args()
    ddir = a.dossiers and Path(a.dossiers)
    if not ddir:
        ddir = first_existing(ROOT / 'research/refs/dossiers/core_south.json', MAIN / 'research/refs/dossiers/core_south.json').parent
    pqp = first_existing(a.parquet, ROOT / 'data-src/overture/building.parquet', MAIN / 'data-src/overture/building.parquet')
    print('档案目录', ddir)
    print('Overture', pqp)
    full, pref = collect_ids(ddir)
    print(f'档案中完整 id {len(full)} 个，8 位前缀引用 {len(pref)} 个')

    t = pq.read_table(pqp, columns=['id'])
    ids = t.column('id')
    want = pa.array(sorted(full))
    mask_full = pc.is_in(ids, value_set=want)
    head8 = pc.utf8_slice_codeunits(ids, 0, 8)
    mask_pref = pc.is_in(head8, value_set=pa.array(sorted(pref))) if pref else pa.array([False] * len(ids))
    rows = np.nonzero(np.asarray(pc.or_(mask_full, mask_pref)))[0]
    del t, head8
    sub = pq.read_table(pqp, columns=['id', 'names', 'sources', 'height', 'num_floors', 'geometry']).take(pa.array(rows))
    sub_ids = sub.column('id').to_pylist()

    # 前缀 → 唯一完整 id
    alias = {}
    by_pref = {}
    for u in sub_ids:
        by_pref.setdefault(u[:8], []).append(u)
    for p in pref:
        c = by_pref.get(p, [])
        if len(c) == 1:
            alias[p] = c[0]
        elif len(c) > 1:
            print(f'  前缀 {p} 不唯一（{len(c)} 个），跳过')
    keep = set(full) | set(alias.values())

    out, holes, meta = {}, {}, {}
    geoms = sub.column('geometry')
    for i, u in enumerate(sub_ids):
        if u not in keep:
            continue
        g = shapely.from_wkb(geoms[i].as_py())
        pg = g if g.geom_type == 'Polygon' else max(g.geoms, key=lambda q: q.area)
        s, wp = to_world(pg, a.tol)
        ring = ring_ccw(np.array(s.exterior.coords)[:-1])
        out[u] = np.round(ring, 1).flatten().tolist()
        hs = [np.round(ring_ccw(np.array(h.coords)[:-1]), 1).flatten().tolist() for h in s.interiors]
        if hs:
            holes[u] = hs
        nm = sub.column('names')[i].as_py() or {}
        src = (sub.column('sources')[i].as_py() or [{}])[0]
        ds = src.get('dataset', '')
        meta[u] = {
            'n': nm.get('primary'),
            'src': ('OSM ' + (src.get('record_id') or '')) if ds == 'OpenStreetMap' else ('ML' if 'Microsoft' in ds or 'Google' in ds else ds),
            'h': sub.column('height')[i].as_py(), 'f': sub.column('num_floors')[i].as_py(),
            'a': round(wp.area), 'c': [round(wp.centroid.x, 1), round(wp.centroid.y, 1)],
        }
    # 正文里的 UUID 很多是照片 URL 里的哈希（房天下等），找不到属正常；只报 overture_id 字段 / spec 里引用却找不到的
    miss = sorted(u for u in set(full) - set(out) if any('（正文）' not in w and '_notes' not in w for w in full[u]))
    print(f'写出轮廓 {len(out)} 个（含前缀解析 {len(alias)} 个）；overture_id 字段 / spec 引用但 parquet 中找不到的 {len(miss)} 个')
    for u in miss[:60]:
        print('  缺', u, '←', '、'.join(full[u][:2]))
    res = dict(sorted(out.items()))
    res['_holes'] = holes
    res['_alias'] = dict(sorted(alias.items()))
    res['_meta'] = dict(sorted(meta.items()))
    Path(a.out).write_text(json.dumps(res, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print('→', a.out, f'{Path(a.out).stat().st_size / 1024:.0f} KB')
    for q in a.show:
        for u in out:
            if u.startswith(q) or alias.get(q) == u:
                print(u, meta[u])
                r = out[u]
                print('  ', [(r[k], r[k + 1]) for k in range(0, len(r), 2)])


if __name__ == '__main__':
    main()
