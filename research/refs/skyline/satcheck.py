#!/usr/bin/env python3
"""skyline 卫星核对：Esri 影像 + buildings.bin 轮廓 + 100 m 网格（世界坐标）。
用法：.venv-tools/bin/python research/refs/skyline/satcheck.py 名称 cx cz 半宽 [zoom]
"""
import sys, struct, json, math
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools'))
import geo, vector_check as vc
from PIL import Image, ImageDraw

name, cx, cz, hw = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
zoom = int(sys.argv[5]) if len(sys.argv) > 5 else 18
w, n = geo.unproject(cx - hw, cz - hw)
e, s = geo.unproject(cx + hw, cz + hw)
img, wb = vc.mosaic(w, s, e, n, zoom)
if max(img.size) > 1600:
    k = 1600 / max(img.size); img = img.resize((int(img.width * k), int(img.height * k)))
W, H = img.size
px = lambda x, z: ((x - wb[0]) / (wb[2] - wb[0]) * W, (z - wb[1]) / (wb[3] - wb[1]) * H)
d = ImageDraw.Draw(img)
b = open(ROOT / 'public/data/buildings.bin', 'rb').read()
_, ver, cnt, tv = struct.unpack_from('<4sIII', b, 0); o = 16
ax = np.frombuffer(b, np.float32, cnt, o); o += 4 * cnt
az = np.frombuffer(b, np.float32, cnt, o); o += 4 * cnt
vs = np.frombuffer(b, np.uint32, cnt, o); o += 4 * cnt
vcn = np.frombuffer(b, np.uint16, cnt, o); o += 2 * cnt
hd = np.frombuffer(b, np.uint16, cnt, o); o += 4 * cnt
o += 2 * cnt + (cnt if ver >= 2 else 0); o = (o + 3) & ~3
offs = np.frombuffer(b, np.int16, tv * 2, o)
sel = np.nonzero((np.abs(ax - cx) < hw + 150) & (np.abs(az - cz) < hw + 150))[0]
for i in sel:
    s0 = vs[i]; nn = vcn[i]
    p = offs[s0 * 2:(s0 + nn) * 2].astype(float) / 10
    pts = [px(p[j] + ax[i], p[j + 1] + az[i]) for j in range(0, len(p), 2)]
    d.polygon(pts, outline=(255, 40, 40))
fnt = vc.font(16)
sk = json.load(open(ROOT / 'public/data/skyline.json'))['features']
for f in sk:
    if abs(f['x'] - cx) > hw + 100 or abs(f['z'] - cz) > hw + 100: continue
    o = f['outer']; pts = [px(o[j], o[j + 1]) for j in range(0, len(o), 2)]
    d.polygon(pts, outline=(0, 255, 255)); a, c = px(f['x'], f['z'])
    d.text((a, c), f"{f.get('n','')} {f['h']}", fill=(0, 255, 255), font=vc.font(13))
g0 = math.floor((cx - hw) / 100) * 100
for gx in range(int(g0), int(cx + hw) + 1, 100):
    x, _ = px(gx, 0); d.line([(x, 0), (x, 8)], fill=(255, 255, 0)); d.text((x + 2, 2), str(gx), fill=(255, 255, 0), font=fnt)
g0 = math.floor((cz - hw) / 100) * 100
for gz in range(int(g0), int(cz + hw) + 1, 100):
    _, y = px(0, gz); d.line([(0, y), (8, y)], fill=(255, 255, 0)); d.text((2, y + 2), str(gz), fill=(255, 255, 0), font=fnt)
for extra in sys.argv[6:]:
    x, z = map(float, extra.split(','))
    a, c = px(x, z); d.ellipse([a - 6, c - 6, a + 6, c + 6], outline=(0, 255, 255), width=2)
out = ROOT / 'research/refs/skyline/sat' / f'{name}.jpg'
img.save(out, quality=85); print(out, img.size, 'mpp', (wb[2] - wb[0]) / W)
