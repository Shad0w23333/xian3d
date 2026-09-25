"""把 OSM 机场要素叠加到卫星拼图上做目视核对（输出到 scratch 或 research/refs）。
用法: python tools/airports_overlay.py <mosaic.json> <out.jpg> [x0 z0 x1 z1 世界坐标裁剪] [--scale s] [--no-overlay]
"""
import json, os, sys
from PIL import Image, ImageDraw
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from geo import project  # noqa
Image.MAX_IMAGE_PIXELS = None

args = [a for a in sys.argv[1:] if not a.startswith('--')]
scale = 1.0
for a in sys.argv[1:]:
    if a.startswith('--scale='):
        scale = float(a.split('=')[1])
overlay = '--no-overlay' not in sys.argv
meta = json.load(open(args[0]))
im = Image.open(meta['file']).convert('RGB')
b = meta['bounds']
sx = meta['w'] / (b['x1'] - b['x0'])
sz = meta['h'] / (b['z1'] - b['z0'])
if len(args) >= 6:
    cx0, cz0, cx1, cz1 = map(float, args[2:6])
else:
    cx0, cz0, cx1, cz1 = b['x0'], b['z0'], b['x1'], b['z1']
px0, pz0 = int((cx0 - b['x0']) * sx), int((cz0 - b['z0']) * sz)
px1, pz1 = int((cx1 - b['x0']) * sx), int((cz1 - b['z0']) * sz)
im = im.crop((px0, pz0, px1, pz1))
if scale != 1.0:
    im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
dr = ImageDraw.Draw(im)


def P(x, z):
    return ((x - b['x0']) * sx - px0) * scale, ((z - b['z0']) * sz - pz0) * scale


if overlay:
    for fn in ('osm_xiy_aeroway.json', 'osm_yanliang_aeroway.json'):
        p = os.path.join(ROOT, 'data-src', 'airports_research', fn)
        if not os.path.exists(p):
            continue
        for e in json.load(open(p))['elements']:
            t = e.get('tags', {})
            a = t.get('aeroway')
            if e['type'] == 'way' and 'geometry' in e:
                pts = [P(*project(q['lon'], q['lat'])) for q in e['geometry']]
                col = {'runway': (255, 40, 40), 'taxiway': (255, 220, 0), 'apron': (0, 200, 255),
                       'terminal': (255, 0, 255), 'hangar': (0, 255, 0), 'stopway': (255, 128, 0),
                       'aerodrome': (255, 255, 255), 'jet_bridge': (0, 255, 128)}.get(a)
                if col and len(pts) > 1:
                    wdt = 3 if a in ('runway', 'terminal', 'aerodrome') else 1
                    dr.line(pts, fill=col, width=wdt)
                    if a == 'runway':
                        dr.text(pts[0], t.get('ref', ''), fill=(255, 255, 0))
    extra = os.path.join(ROOT, 'data-src', 'airports_research', 'overlay_extra.json')
    if os.path.exists(extra):
        for f in json.load(open(extra)):
            pts = [P(f['p'][i], f['p'][i + 1]) for i in range(0, len(f['p']), 2)]
            dr.line(pts, fill=tuple(f.get('c', [0, 255, 255])), width=f.get('w', 2))
            if f.get('n'):
                dr.text(pts[0], f['n'], fill=(255, 255, 255))
im.save(args[1], quality=85)
print(args[1], im.size)
