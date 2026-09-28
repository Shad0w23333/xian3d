#!/usr/bin/env python3
"""坐标审计：landmarks2026 推测坐标 / 合成轮廓、手工精建（sky-data*.js）落位，与 Overture 同名轮廓、place、pois 交叉核对。

检查内容
  1. research/refs/landmarks2026/*.json 中 coord_source 为 estimated（或 overture_place：可能混有 GCJ-02）的条目，
     以及 build_landmarks2026.py 生成时轮廓为 synth（按调研尺寸合成矩形）的条目：
       - Overture building 同名轮廓（名称归一后互相包含）→ 质心、面积、OSM 记录号、与现坐标距离
       - Overture place 同名点：若两点相差约“GCJ 偏移”（西安约东 450 m、南 150 m），偏移那一点判为 GCJ-02，
         取与 OSM 轮廓重合的那一点
       - pois.json 同名点
     并显示 build_landmarks2026.py 覆盖表 COORD_FIX 当前生效的坐标。
  2. 手工精建（src/arch/sky-data.js、sky-data2.js，用 node 导出规格）：与 Overture 同名轮廓质心、最大重叠轮廓比较，
     偏差 > 30 m 的列出。

用法：python tools/check_coords.py [--json 输出路径]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import audit_common as AC  # noqa: E402
from geo import project  # noqa: E402

ROOT = HERE.parent
REF = ROOT / 'research' / 'refs' / 'landmarks2026'
LISTS = ('towers', 'malls', 'venues', 'heritage', 'sunken', 'universities')
SEARCH_R = 6000.0

# 手工精建的检索名（规格 name 不便检索时）
CURATED_ALIAS = {
    'ifc': ['国瑞', 'IFC'], 'glA': ['绿地中心A', '绿地中心-A'], 'glB': ['绿地中心B', '绿地中心-B'],
    'mkT': ['迈科中心'], 'hyatt': ['君悦'], 'ty1': ['体育之窗'], 'ty2': ['体育之窗'], 'yc': ['延长石油'],
    'hsA': ['禾盛京广中心-A', '京广中心A'], 'hsB': ['禾盛京广中心-B', '京广中心B'], 'xinxi': ['信息大厦'],
    'rongmin': ['荣民金融中心', '荣民中心'], 'igc2': ['环球贸易中心', '环贸晶樽'], 'ehb': ['EHB', '赛高城市广场'],
    'ihg': ['洲际'], 'meridien': ['艾美'], 'icc': ['欧亚国际'], 'xuhuiA': ['旭辉中心'], 'xuhuiB': ['旭辉中心'],
    'zhixuan': ['智选假日'], 'wygjT': ['未央国际'], 'wygjzx': ['未央国际中心'], 'saige': ['赛格'], 'mixc': ['万象城'],
    'kaiyuan': ['开元商城'], 'dmgwd': ['大明宫万达', '万达广场'], 'xidigang': ['熙地港'], 'darongcheng': ['大融城'],
    'jinjiang': ['锦江国际', '凯宾斯基'], 'wHotel': ['W酒店'], 'wOfficeA': ['万众国际'], 'wOfficeB': ['万众国际'],
}
GENERIC = re.compile(r'^(?:[a-z]?\d*[#号]?(?:楼|座|栋)?|[a-z]座|主楼|塔楼|商场|酒店|写字楼|办公楼|公寓|大厦|中心|广场)$')


def variants(name, aliases=()):
    """检索用名称变体：整名、去括号、括号内、去“1号楼/主塔/A座”等尾缀"""
    out = []
    for n in [name, *aliases]:
        n = str(n or '')
        out.append(n)
        out += re.findall(r'[（(]([^）)]+)[）)]', n)
        base = re.sub(r'[（(][^）)]*[）)]', '', n)
        out.append(base)
        out.append(re.sub(r'(\d+#?号?楼|[A-Za-z]座|主塔|北塔|南塔|超高层\d?|万豪酒店楼|\s)+$', '', base))
    seen, res = set(), []
    for v in out:
        k = AC.norm(v)
        if len(k) >= 3 and k not in seen and not GENERIC.match(k):
            seen.add(k)
            res.append(k)
    return res


def name_hit(k, cand):
    c = AC.norm(cand)
    if not c or GENERIC.match(c):
        return False
    return c == k or (len(c) >= 3 and k in c) or (len(c) >= 4 and c in k)


class Index:
    def __init__(self):
        import shapely
        print('读取 Overture 建筑 / place / pois …', flush=True)
        O = AC.load_overture_buildings(only_named_or_measured=True)
        named = np.array([bool(n) for n in O['name']])
        self.og = O['geom'][named]
        self.on = [n for n, k in zip(O['name'], named) if k]
        self.orid = [r for r, k in zip(O['rid'], named) if k]
        self.oc = shapely.get_coordinates(shapely.centroid(self.og))
        self.oa = shapely.area(self.og)
        Oall = AC.load_overture_buildings()
        self.ag = Oall['geom']
        self.aa = shapely.area(self.ag)
        self.atree = shapely.STRtree(self.ag)
        self.arid = Oall['rid']
        self.aname = Oall['name']
        self.P = AC.load_places()
        self.pois = AC.load_pois()

    def by_name(self, keys, x, z, r=SEARCH_R):
        res = []
        for i, n in enumerate(self.on):
            if any(name_hit(k, n) for k in keys):
                d = math.hypot(self.oc[i][0] - x, self.oc[i][1] - z)
                if d < r:
                    res.append(dict(src='overture_bld', name=n, x=round(float(self.oc[i][0]), 1), z=round(float(self.oc[i][1]), 1),
                                    area=round(float(self.oa[i])), rid=self.orid[i], d=round(d)))
        for i, n in enumerate(self.P['name']):
            if any(name_hit(k, n) for k in keys):
                px, pz = self.P['xy'][i]
                d = math.hypot(px - x, pz - z)
                if d < r:
                    res.append(dict(src='place', name=n, x=round(float(px), 1), z=round(float(pz), 1), ds=self.P['ds'][i], d=round(d)))
        for p in self.pois:
            if any(name_hit(k, p['n']) for k in keys):
                d = math.hypot(p['x'] - x, p['z'] - z)
                if d < r:
                    res.append(dict(src='poi', name=p['n'], x=p['x'], z=p['z'], d=round(d)))
        # GCJ 判别：place 点若恰为其他候选点 + GCJ 偏移 → 标为 gcj
        for a in res:
            if a['src'] != 'place':
                continue
            for b in res:
                if b is not a and AC.is_gcj_twin((b['x'], b['z']), (a['x'], a['z'])):
                    a['gcj'] = True
                    break
        # 轮廓包含 place/poi 点的（重合）
        import shapely
        for a in res:
            if a['src'] in ('place', 'poi'):
                hit = self.atree.query(shapely.Point(a['x'], a['z']), predicate='within')
                a['in_bld'] = bool(len(hit))
        return sorted(res, key=lambda q: q['d'])

    def overlap(self, poly):
        """与精建轮廓重叠最大的 Overture 轮廓：(下标, 交并比)"""
        import shapely
        idx = self.atree.query(poly, predicate='intersects')
        best = (None, 0.0)
        for i in idx:
            inter = shapely.area(shapely.intersection(poly, self.ag[i]))
            iou = inter / (poly.area + self.aa[i] - inter)
            if iou > best[1]:
                best = (int(i), float(iou))
        return best


def curated_specs():
    """用 node 导出手工精建规格（key、name、h、质心、轮廓）"""
    js = r"""
const m = await import('./src/arch/sky-data.js'); const m2 = await import('./src/arch/sky-data2.js'); const G = await import('./src/arch/sky-geom.js');
const out = [];
const push = (t, kind) => { const p = G.ccw(t.pts); const c = G.centroid(p); out.push({ key: t.key, name: t.name || '', h: t.h, kind, x: c.x, z: c.z, pts: p }); };
for (const t of m.towerSpecs()) if (!m2.SUPERSEDED.has(t.key)) push(t, 'tower');
for (const t of m2.towerSpecs2()) push(t, 'tower');
for (const t of m.mallSpecs()) if (!m2.SUPERSEDED.has(t.key)) push(t, 'mall');
for (const t of m2.mallSpecs2()) push(t, 'mall');
for (const t of m2.SPECIAL2.w.towers) push(t, 'tower');
console.log(JSON.stringify(out));
"""
    r = subprocess.run(['node', '--input-type=module', '-e', js], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def audit_curated(ix, lim=30.0):
    import shapely
    rows = []
    for s in curated_specs():
        poly = shapely.Polygon(np.array(s['pts']).reshape(-1, 2))
        keys = variants(s['name'], CURATED_ALIAS.get(s['key'], []))
        cands = [c for c in ix.by_name(keys, s['x'], s['z'], 1500) if c['src'] == 'overture_bld' and c['area'] > 300]
        j, iou = ix.overlap(poly)
        row = dict(key=s['key'], name=s['name'], h=s['h'], x=round(s['x'], 1), z=round(s['z'], 1), area=round(poly.area),
                   iou=round(iou, 2), iou_rid=ix.arid[j] if j is not None else '', iou_name=ix.aname[j] if j is not None else '')
        if cands:
            # 同名轮廓里有包含精建质心的（塔楼落在综合体整体轮廓内）→ 视为落位正确
            P0 = shapely.Point(s['x'], s['z'])
            inside = [c for c in cands if any(ix.og[k].contains(P0) for k in range(len(ix.on))
                                              if ix.orid[k] == c['rid'] and ix.on[k] == c['name'])]
            c = inside[0] if inside else cands[0]
            row.update(match=c['name'], mx=c['x'], mz=c['z'], marea=c['area'], mrid=c['rid'], d=c['d'], inside=bool(inside))
        rows.append(row)
    return rows


def audit_landmarks(ix):
    import build_landmarks2026 as BL
    built = json.loads((AC.DATA / 'landmarks2026.json').read_text('utf-8'))
    src_by_name = {}
    for sec in ('towers', 'malls'):
        for s in built.get(sec, []):
            src_by_name[s['name']] = s.get('src')
    rows = []
    for lst in LISTS:
        for it in BL.load_list(lst):
            name = it.get('name')
            if lst == 'universities':
                name = (it.get('name') or '') + (('·' + it['campus']) if it.get('campus') and it['campus'] not in (it.get('name') or '') else '')
            cs = str(it.get('coord_source') or '')
            src = src_by_name.get(name)
            if not ('estimated' in cs or cs.startswith('overture_place') or src == 'synth'):
                continue
            lon, lat = BL.num(it.get('lon')), BL.num(it.get('lat'))
            if lon is None or lat is None:
                continue
            x, z = project(lon, lat)
            fix = BL.OVERRIDE.get(name)
            keys = variants(name, it.get('aliases') or [])
            cands = ix.by_name(keys, x, z)
            row = dict(list=lst, name=name, cs=cs, src=src, x=round(x, 1), z=round(z, 1), cands=cands[:8])
            if fix:
                fx = fz = None
                if 'xz' in fix:
                    fx, fz = fix['xz']
                elif 'lon' in fix:
                    fx, fz = project(fix['lon'], fix['lat'])
                elif fix.get('rid'):
                    j = [k for k, r in enumerate(ix.arid) if r.split('@')[0] == fix['rid']]
                    if j:
                        c = ix.ag[j[0]].centroid
                        fx, fz = c.x, c.y
                row['fix'] = dict(x=None if fx is None else round(fx, 1), z=None if fz is None else round(fz, 1),
                                  moved=None if fx is None else round(math.hypot(fx - x, fz - z)), h=fix.get('h'),
                                  skip=bool(fix.get('skip')), note=fix.get('note', ''))
            rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--json', default=str(ROOT / 'research' / 'audit' / 'coords_audit.json'))
    ap.add_argument('--brief', action='store_true', help='只打印汇总')
    args = ap.parse_args()
    ix = Index()
    cur = audit_curated(ix)
    print('\n== 手工精建落位（与 Overture 同名轮廓质心偏差 d、与最大重叠轮廓交并比 iou）==')
    bad = 0
    for r in cur:
        flag = ''
        if r.get('d', 0) > 30 and r['iou'] < 0.5 and not r.get('inside'):
            flag = '  <<< 偏差 > 30 m'
            bad += 1
        if not args.brief or flag:
            print(f"  {r['key']:10s} {r['name'][:18]:18s} h={r['h']:<7} ({r['x']:.0f},{r['z']:.0f}) iou={r['iou']:.2f} "
                  f"同名={r.get('match', '-')}({r.get('mx', '')},{r.get('mz', '')}) d={r.get('d', '-')} {r.get('mrid', '')}{flag}")
    print(f'  偏差 > 30 m 且与现有轮廓不重合：{bad} 个')
    lm = audit_landmarks(ix)
    print(f'\n== landmarks2026 推测坐标 / 合成轮廓：{len(lm)} 条 ==')
    for r in lm:
        fx = r.get('fix')
        fxs = ''
        if fx:
            fxs = '  → 覆盖' + (f"({fx['x']:.0f},{fx['z']:.0f}) 移动 {fx['moved']} m" if fx['x'] is not None else '')
            fxs += (f" 高度 {fx['h']} m" if fx['h'] else '') + (' 跳过' if fx['skip'] else '') + f"：{fx['note'][:60]}"
        print(f"- [{r['list']}] {r['name']}  cs={r['cs'][:30]} src={r['src']} 现({r['x']:.0f},{r['z']:.0f})" + fxs)
        if not args.brief:
            for c in r['cands']:
                tag = ' GCJ' if c.get('gcj') else ''
                tag += ' 落在轮廓内' if c.get('in_bld') else ''
                print(f"      {c['src']:12s} {c['name'][:24]:24s} ({c['x']:.0f},{c['z']:.0f}) d={c['d']} "
                      f"{c.get('area', '')} {c.get('rid', '')}{c.get('ds', '')}{tag}")
    nfix = sum(1 for r in lm if r.get('fix'))
    print(f'  其中已有覆盖坐标：{nfix} 条')
    out = Path(args.json)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({'curated': cur, 'landmarks': lm}, ensure_ascii=False, indent=1), 'utf-8')
    print('写出', out)


if __name__ == '__main__':
    main()
