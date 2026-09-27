"""从 OSM 机场研究数据生成 src/arch/airport-data.js（停机位、引导线、等待点、塔台、机库、风向标、PAPI）。
用法: python3 tools/airports_data.py
"""
import json, math, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from geo import project  # noqa

D = json.load(open(os.path.join(ROOT, 'data-src/airports_research/osm_xiy_aeroway.json')))
B = json.load(open(os.path.join(ROOT, 'data-src/airports_research/osm_xiy_buildings.json')))
A = json.load(open(os.path.join(ROOT, 'public/data/aeroway.json')))
P = lambda q: project(q['lon'], q['lat'])

TERM_NAMES = {'1号航站楼', '2号航站楼', '3号航站楼', '5号航站楼', '国际指廊', '南一指廊', '南二指廊', '南三指廊'}
terms = [t['outer'] for t in A['terminals'] if t.get('n') in TERM_NAMES]
edges = []
for o in terms:
    n = len(o) // 2
    for i in range(n):
        j = (i + 1) % n
        edges.append((o[2 * i], o[2 * i + 1], o[2 * j], o[2 * j + 1]))

def ray_hit(x, z, dx, dz, maxd=90):
    best = None
    for ax, az, bx, bz in edges:
        ex, ez = bx - ax, bz - az
        den = dx * ez - dz * ex
        if abs(den) < 1e-9: continue
        t = ((ax - x) * ez - (az - z) * ex) / den
        u = ((ax - x) * dz - (az - z) * dx) / den
        if 0 <= u <= 1 and 0 < t < maxd and (best is None or t < best): best = t
    return best

taxi = []
for e in D['elements']:
    t = e.get('tags', {})
    if t.get('aeroway') == 'taxiway' and 'geometry' in e:
        pts = [P(q) for q in e['geometry']]
        for i in range(1, len(pts)): taxi.append((*pts[i - 1], *pts[i]))

def dseg(x, z):
    best = 1e9
    for ax, az, bx, bz in taxi:
        dx, dz = bx - ax, bz - az; l2 = dx * dx + dz * dz + 1e-9
        t = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / l2))
        best = min(best, math.hypot(ax + dx * t - x, az + dz * t - z))
    return best

stands, leadin = [], []
for e in D['elements']:
    t = e.get('tags', {})
    if t.get('aeroway') != 'parking_position' or e['type'] != 'way': continue
    pts = [P(q) for q in e['geometry']]
    if len(pts) < 2: continue
    if dseg(*pts[0]) > dseg(*pts[-1]): pts = pts[::-1]
    stop = pts[-1]; k = len(pts) - 2
    while k > 0 and math.hypot(stop[0] - pts[k][0], stop[1] - pts[k][1]) < 25: k -= 1
    prev = pts[k]
    dx, dz = stop[0] - prev[0], stop[1] - prev[1]; l = math.hypot(dx, dz) or 1
    dx, dz = dx / l, dz / l
    hit = ray_hit(stop[0], stop[1], dx, dz)
    stands.append([stop[0], stop[1], math.atan2(dx, dz), hit or 0])
    leadin.append([round(v, 1) for p in pts for v in p])

# 去重 + 间距 -> 机型等级
out = []
for s in stands:
    if any(math.hypot(s[0] - o[0], s[1] - o[1]) < 25 for o in out): continue
    out.append(s)
for s in out:
    nd = min((math.hypot(s[0] - o[0], s[1] - o[1]) for o in out if o is not s), default=99)
    s.append(nd)
ST = []
for x, z, h, hit, nd in out:
    cls = 2 if nd >= 62 else (1 if nd >= 50 else 0)  # 0 窄体 1 中型宽体 2 大型宽体
    ST += [round(x, 1), round(z, 1), round(h, 4), cls, round(hit, 1)]

hold = []
for e in D['elements']:
    t = e.get('tags', {})
    if t.get('aeroway') == 'holding_position': hold += [round(v, 1) for v in P(e)]
sock, papi = [], []
for e in D['elements']:
    t = e.get('tags', {})
    if t.get('aeroway') == 'windsock': sock += [round(v, 1) for v in P(e)]
    if t.get('navigationaid') == 'papi': papi += [round(v, 1) for v in P(e)]
hang, tower = [], None
for e in B['elements']:
    t = e.get('tags', {})
    if 'geometry' not in e: continue
    pts = [P(q) for q in e['geometry']]
    if pts[0] == pts[-1]: pts = pts[:-1]
    flat = [round(v, 1) for p in pts for v in p]
    if t.get('aeroway') == 'hangar': hang.append(flat)
    if t.get('tower:type') == 'aircraft_control':
        cx = sum(p[0] for p in pts) / len(pts); cz = sum(p[1] for p in pts) / len(pts)
        r = max(math.hypot(p[0] - cx, p[1] - cz) for p in pts)
        tower = [round(cx, 1), round(cz, 1), round(r, 1)]

js = '// 自动生成：tools/airports_data.py（OSM © OpenStreetMap contributors, ODbL）\n'
js += '// STANDS: [x, z, 机头朝向 atan2(dx,dz), 机型等级 0窄/1中宽/2大宽, 机头到航站楼立面距离(0=远机位)] * n\n'
js += 'export const STANDS = ' + json.dumps(ST, separators=(',', ':')) + ';\n'
js += 'export const LEADIN = ' + json.dumps(leadin, separators=(',', ':')) + ';\n'
js += 'export const HOLDS = ' + json.dumps(hold) + ';\n'
js += 'export const WINDSOCKS = ' + json.dumps(sock) + ';\n'
js += 'export const PAPI = ' + json.dumps(papi) + ';\n'
js += 'export const HANGARS = ' + json.dumps(hang, separators=(',', ':')) + ';\n'
js += 'export const TOWER = ' + json.dumps(tower) + ';\n'
open(os.path.join(ROOT, 'src/arch/airport-data.js'), 'w').write(js)
print('stands', len(out), 'contact', sum(1 for s in out if s[3] > 0), 'cls', [sum(1 for i in range(3, len(ST), 5) if ST[i] == c) for c in range(3)], 'tower', tower, 'hangars', len(hang), 'bytes', len(js))
