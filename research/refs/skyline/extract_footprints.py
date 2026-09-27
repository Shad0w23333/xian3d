#!/usr/bin/env python3
"""skyline 地标轮廓烘焙：从 skyline.json / OSM 高楼抓取缓存 / buildings.bin 取多边形 → src/arch/sky-footprints.js
（烘焙坐标而不是下标：buildings.bin 可能被其他代理重建）。
用法：python3 research/refs/skyline/extract_footprints.py
"""
import json, struct, math
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[3]
import sys; sys.path.insert(0, str(ROOT / 'tools')); import geo

def area(p):
    x = np.array(p[0::2]); z = np.array(p[1::2])
    return 0.5 * (np.dot(x, np.roll(z, -1)) - np.dot(z, np.roll(x, -1)))

def ccw(p):
    if area(p) < 0:
        pts = [(p[i], p[i + 1]) for i in range(0, len(p), 2)][::-1]
        p = [c for xy in pts for c in xy]
    return p

def simplify(p, tol=0.4):
    # 去重复点 + 共线点
    pts = [(p[i], p[i + 1]) for i in range(0, len(p), 2)]
    if len(pts) > 1 and math.dist(pts[0], pts[-1]) < 0.05: pts = pts[:-1]
    out = []
    for q in pts:
        if not out or math.dist(out[-1], q) > 0.3: out.append(q)
    changed = True
    while changed and len(out) > 3:
        changed = False
        for i in range(len(out)):
            a, b, c = out[i - 1], out[i], out[(i + 1) % len(out)]
            ab = (b[0] - a[0], b[1] - a[1]); ac = (c[0] - a[0], c[1] - a[1])
            L = math.hypot(*ac) or 1
            if abs(ab[0] * ac[1] - ab[1] * ac[0]) / L < tol:
                out.pop(i); changed = True; break
    return [round(v, 1) for q in out for v in q]

res = {}
# 1) skyline.json 按名称
sky = json.load(open(ROOT / 'public/data/skyline.json'))['features']
for key, name in [('ifc', 'IFC国瑞·西安金融中心'), ('glA', '绿地中心-A座'), ('glB', '绿地中心-B座'), ('ztzx', '中铁西安中心'),
                  ('hsA', '禾盛京广中心-A座'), ('hsB', '禾盛京广中心-B座'), ('dxgc', '陕西电信广场')]:
    f = next(f for f in sky if f.get('n') == name)
    res[key] = ccw(simplify(f['outer']))
# 2) OSM 高楼抓取缓存 按 way id
ways = {1546339320: 'mkT', 1221942315: 'mkP', 985455592: 'hyatt', 1387164542: 'yongli', 772926961: 'yongwei',
        985094940: 'tyP', 969143238: 'ycP', 1284311588: 'xinxi'}
for i in range(5):
    fn = ROOT / f'data-src/landmarks_modern/osm_tall_named_0{i}.json'
    for e in json.load(open(fn))['elements']:
        if e['type'] == 'way' and e['id'] in ways and e.get('geometry'):
            p = [c for q in e['geometry'] for c in geo.project(q['lon'], q['lat'])]
            res[ways[e['id']]] = ccw(simplify(p))
for e in json.load(open(ROOT / 'data-src/osm/buildings__geofabrik.json'))['elements']:
    if e['type'] == 'way' and e['id'] in ways and ways[e['id']] not in res and e.get('geometry'):
        p = [c for q in e['geometry'] for c in geo.project(q['lon'], q['lat'])]
        res[ways[e['id']]] = ccw(simplify(p))
# 3) buildings.bin
b = open(ROOT / 'public/data/buildings.bin', 'rb').read()
_, ver, cnt, tv = struct.unpack_from('<4sIII', b, 0); o = 16
ax = np.frombuffer(b, np.float32, cnt, o); o += 4 * cnt
az = np.frombuffer(b, np.float32, cnt, o); o += 4 * cnt
vs = np.frombuffer(b, np.uint32, cnt, o); o += 4 * cnt
vc = np.frombuffer(b, np.uint16, cnt, o); o += 2 * cnt
hd = np.frombuffer(b, np.uint16, cnt, o); o += 2 * cnt
o += 2 * cnt + cnt + cnt + (cnt if ver >= 2 else 0); o = (o + 3) & ~3
offs = np.frombuffer(b, np.int16, tv * 2, o)
names = json.load(open(ROOT / 'public/data/buildings_names.json'))
def bpoly(i):
    s = vs[i]; n = vc[i]; p = offs[s * 2:(s + n) * 2].astype(float) / 10
    p[0::2] += ax[i]; p[1::2] += az[i]; return list(p)
def inpoly(x, z, p):
    c = False; n = len(p) // 2
    for i in range(n):
        j = (i - 1) % n; xi, zi, xj, zj = p[2*i], p[2*i+1], p[2*j], p[2*j+1]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi: c = not c
    return c
def bin_at(x, z, name=None, r=200):
    idx = np.nonzero((np.abs(ax - x) < r) & (np.abs(az - z) < r))[0]
    best = None
    for i in idx:
        p = bpoly(i)
        if name and name in names.get(str(i), ''):
            d = math.hypot(ax[i] - x, az[i] - z)
            if best is None or d < best[0]: best = (d, i)
        elif not name and inpoly(x, z, p):
            a = abs(area(p))
            if best is None or a > best[0]: best = (a, i)
    return best[1] if best else None
for key, x, z, name in [('xidigang', -147, -8804, 'CityOn熙地港'), ('darongcheng', 185, -8837, '大融城'), ('wygjT', -82, -8622, '未央国际'),
                        ('wygjS1', -67, -8553, None), ('wygjS2', -100, -8586, None), ('saige', 126, 3975, '赛格国际购物中心'),
                        ('kaiyuan', 95, 80, None), ('dmgwd', 2400, -6150, '大明宫万达'), ('tvbase', -55, 7056, None),
                        ('crA', 174, 6971, 'A座'), ('crB', 174, 7142, 'B座'), ('crC', 234, 7214, 'C座'), ('crD', 234, 6904, 'D座'),
                        ('mixc', 221, 7078, '西安万象城')]:
    i = bin_at(x, z, name)
    if i is None: print('未找到', key); continue
    res[key] = ccw(simplify(bpoly(i))); print(key, i, names.get(str(i), ''), hd[i] / 10)
# 4) 区域批量：行政中心低层（bin 高度 < 30 m）、会展展馆（面积 > 6000）
def region(x0, x1, z0, z1, amin, hmax=999):
    out = []
    for i in np.nonzero((ax >= x0) & (ax <= x1) & (az >= z0) & (az <= z1))[0]:
        p = bpoly(i)
        if abs(area(p)) >= amin and hd[i] / 10 < hmax: out.append(ccw(simplify(p, 0.8)))
    return out
res['gov'] = region(340, 1250, -9360, -9010, 400, 30)
res['expo'] = [p for p in region(8300, 9060, -9160, -8400, 6000) if not (8600 < np.mean(p[0::2]) < 9000 and np.mean(p[1::2]) > -8460)]
out = ROOT / 'src/arch/sky-footprints.js'
out.write_text('// 自动生成（research/refs/skyline/extract_footprints.py）：skyline 地标轮廓，世界坐标 [x,z,...]，外环 CCW\n'
               '// 来源：OSM（skyline.json / 高楼抓取缓存 / buildings.bin 中 OSM+CMAB 轮廓）\nexport const FP = ' +
               json.dumps(res, ensure_ascii=False, separators=(',', ':')) + ';\n')
print('写出', out, {k: (len(v) if isinstance(v[0], list) else len(v) // 2) for k, v in res.items()})
