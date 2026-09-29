#!/usr/bin/env python3
"""西安地铁地下网络数据：public/data/rail.json（OSM 地铁线，含 layer）+ public/data/pois.json（地铁出入口）
+ research/refs/landmarks2026/metro.json（可选：官方线路色、逐站清单、换乘）+ data-src/amap/metro.json（可选：高德线路与车站）
→ public/data/metro.json

输出（世界坐标，米）：
  lines:    [{num, name, color, paths:[[x,z,d, x,z,d, ...]]}]   d = 轨面在地面以下的深度（米，0 表示地面/高架段，不做隧道）
  stations: [{n, x, z, lines:[{num, x, z, dx, dz, d}], exits:[[x,z,'A'], ...]}]
用法：python tools/build_metro.py
"""
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geo import project  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public/data/metro.json'
# 西安地铁线路标识色（官方 VI；research/refs/landmarks2026/metro.json 有核实值时以其为准）
COLORS = {
    1: '#0071BC', 2: '#E60012', 3: '#AE4BAF', 4: '#00A29A', 5: '#9AC31C', 6: '#2A3C8E', 8: '#E9A019',
    9: '#F18D00', 10: '#7B68AE', 11: '#A4343A', 12: '#00833E', 14: '#6BC4E8', 15: '#C9A063', 16: '#E4007F',
}
CN = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
DEPTH0 = 14.0   # 单层地下线轨面埋深
DEPTH_K = 3.5   # OSM layer 每低一层再深 3.5 m（换乘站上下错层；最深约 28 m）


def line_num(n):
    m = re.search(r'地铁(\d+|[一二三四五六七八九十]+)号线', n or '')
    if not m or re.search(r'联络|出入段|车辆段|停车场|试车', n):
        return None
    v = m.group(1)
    return int(v) if v.isdigit() else CN.get(v)


def as_num(v):
    m = re.search(r'\d+', str(v))
    return int(m.group()) if m else None


def chain(segs):
    """线段（顶点列表）按端点（1 m 网格）串成尽量长的路径；完全重复的要素去掉"""
    seen, uniq = set(), []
    for s in segs:
        k = (round(s[0][0]), round(s[0][1]), round(s[-1][0]), round(s[-1][1]), len(s))
        kr = (k[2], k[3], k[0], k[1], k[4])
        if k in seen or kr in seen:
            continue
        seen.add(k)
        uniq.append(s)
    key = lambda p: (round(p[0]), round(p[1]))
    ends = defaultdict(list)
    for i, s in enumerate(uniq):
        ends[key(s[0])].append(i)
        ends[key(s[-1])].append(i)
    used = [False] * len(uniq)
    out = []

    def extend(path):
        while True:
            k = key(path[-1])
            nxt = [j for j in ends[k] if not used[j]]
            if len(nxt) != 1 or len(ends[k]) != 2:
                return path
            j = nxt[0]
            used[j] = True
            s = uniq[j]
            path += (s if key(s[0]) == k else s[::-1])[1:]

    # 先从端点度 ≠ 2 的地方开始，保证路径最长
    order = sorted(range(len(uniq)), key=lambda i: (len(ends[key(uniq[i][0])]) == 2) + (len(ends[key(uniq[i][-1])]) == 2))
    for i in order:
        if used[i]:
            continue
        used[i] = True
        p = extend(list(uniq[i]))
        p = extend(p[::-1])
        out.append(p)
    return out


def near_on(path, x, z):
    best = (1e18, 0, 0, 0, 1, 0)
    for i in range(len(path) - 1):
        ax, az, ad = path[i]
        bx, bz, bd = path[i + 1]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz or 1e-9
        t = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / L2))
        px, pz = ax + dx * t, az + dz * t
        d = math.hypot(px - x, pz - z)
        if d < best[0]:
            L = math.sqrt(L2)
            best = (d, px, pz, dx / L, dz / L, ad + (bd - ad) * t)
    return best


def main():
    rail = json.loads((ROOT / 'public/data/rail.json').read_text('utf-8'))
    sub = rail['classes'].index('subway')
    segs = defaultdict(list)
    for f in rail['features']:
        if f['c'] != sub:
            continue
        n = line_num(f.get('n'))
        if not n:
            continue
        y = f.get('y') or 0
        d = DEPTH0 + DEPTH_K * (-y - 1) if y < 0 else 0.0
        p = f['p']
        segs[n].append([(p[i], p[i + 1], d) for i in range(0, len(p), 2)])
    # 研究清单（官方色 / 开通线路 / 逐站）
    ref = {}
    rf = ROOT / 'research/refs/landmarks2026/metro.json'
    if rf.exists():
        for L in json.loads(rf.read_text('utf-8')).get('lines', []):
            n = as_num(L.get('num'))
            if n:
                ref[n] = L
    # 高德线路：OSM 缺的线整条补上（默认地下）
    af = ROOT / 'data-src/amap/metro.json'
    if af.exists():
        from amap_fetch import gcj2wgs
        for ln, L in json.loads(af.read_text('utf-8')).items():
            m = re.match(r'(\d+)号线', ln)
            if not m or int(m.group(1)) in segs:
                continue
            pts = []
            for pt in (L.get('polyline') or '').split(';'):
                if ',' in pt:
                    x, z = project(*gcj2wgs(*map(float, pt.split(','))))
                    pts.append((x, z, DEPTH0))
            if len(pts) >= 2:
                segs[int(m.group(1))].append(pts)
    # 调研清单里没有线号的线（西户线、西安云巴）：OSM 地铁数据里没有，按站序连线（地面/高架，d=0 不做隧道）
    extra = {}
    if rf.exists():
        k = 100
        for L in json.loads(rf.read_text('utf-8')).get('lines', []):
            if as_num(L.get('num')) or len(L.get('stations') or []) < 2:
                continue
            k += 1
            pts = [(float(st['x']), float(st['z']), 0.0) if st.get('x') is not None else (*project(float(st['lon']), float(st['lat'])), 0.0)
                   for st in L['stations']]
            segs[k] = [pts]
            ref[k] = {**L, 'num': k}
            extra[k] = re.sub(r'（.*?）', '', L.get('name') or f'线路{k}')
    lines = []
    for n in sorted(segs):
        paths = [p for p in chain(segs[n]) if len(p) >= 2]
        col = (ref.get(n) or {}).get('color') or COLORS.get(n, '#9aa4b0')
        lines.append({'num': n, 'name': extra.get(n, f'{n}号线'), 'color': col,
                      'paths': [[round(v, 1) for q in p for v in q] for p in paths]})

    # —— 车站：出入口按站名聚类 ——
    pois = json.loads((ROOT / 'public/data/pois.json').read_text('utf-8'))['pois']
    ex = defaultdict(list)
    for q in pois:
        if q.get('k') != 'subway_entrance' or not q.get('n'):
            continue
        m = re.match(r'(.+?)(?:地铁站|站)?[-－ ]?([A-Za-z]\d*)?口?$', q['n'])
        name = re.sub(r'[-－]$', '', (m.group(1) if m else q['n'])).strip()
        name = re.sub(r'(地铁站|站)$', '', name)
        lab = (m.group(2) or '') if m else ''
        ex[name].append((q['x'], q['z'], lab))
    # 研究清单里的车站（有坐标的补进来，无出入口数据的站也能生成）
    for n, L in ref.items():
        for s in L.get('stations') or []:
            nm = re.sub(r'(地铁站|站)$', '', str(s.get('name') or ''))
            if nm and nm not in ex and s.get('lon') and s.get('lat'):
                x, z = project(float(s['lon']), float(s['lat']))
                ex[nm].append((x, z, ''))
    stations = []
    all_paths = [(L['num'], [(p[i], p[i + 1], p[i + 2]) for i in range(0, len(p), 3)]) for L in lines for p in L['paths']]
    for name, es in ex.items():
        cx = sum(e[0] for e in es) / len(es)
        cz = sum(e[1] for e in es) / len(es)
        # 出入口离散太远（同名不同站）：只取离质心最近的那一簇
        es = [e for e in es if math.hypot(e[0] - cx, e[1] - cz) < 450] or es
        cx = sum(e[0] for e in es) / len(es)
        cz = sum(e[1] for e in es) / len(es)
        best = {}
        for num, p in all_paths:
            r = near_on(p, cx, cz)
            if r[0] < 260 and (num not in best or r[0] < best[num][0]):
                best[num] = r
        want = {n2 for L in ref.values() for s in L.get('stations') or []
                if re.sub(r'(地铁站|站)$', '', str(s.get('name') or '')) == name
                for k in [L['num']] + list(s.get('transfer') or []) for n2 in [as_num(k)] if n2}
        ls = []
        for num, r in sorted(best.items()):
            if want and num not in want and r[0] > 120:
                continue
            ls.append({'num': num, 'x': round(r[1], 1), 'z': round(r[2], 1), 'dx': round(r[3], 4), 'dz': round(r[4], 4), 'd': round(r[5], 1)})
        if not ls:
            continue
        stations.append({'n': name, 'x': round(cx, 1), 'z': round(cz, 1), 'lines': ls,
                         'exits': [[round(e[0], 1), round(e[1], 1), e[2]] for e in es]})
    out = {'version': 1, 'lines': lines, 'stations': stations}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    km = sum(sum(math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]) for i in range(3, len(p), 3)) for L in lines for p in L['paths']) / 1000
    print(f'写出 {OUT}：{len(lines)} 条线（{km:.0f} km 轨道中心线，含双线）、{len(stations)} 座车站、'
          f'换乘站 {sum(1 for s in stations if len(s["lines"]) > 1)} 座、出入口 {sum(len(s["exits"]) for s in stations)} 个')
    for L in lines:
        print(f'  {L["name"]} {L["color"]}：{len(L["paths"])} 段路径，车站 {sum(1 for s in stations if any(q["num"] == L["num"] for q in s["lines"]))}')


if __name__ == '__main__':
    main()
