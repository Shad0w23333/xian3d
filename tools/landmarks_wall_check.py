"""城墙中心线目视核对：四角 + 城门 z19/z18 叠加图，拼成联系表。"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from landmarks_viewcheck import render  # noqa: E402
from landmarks_wall import load  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data-src', 'landmarks_historic')
OUT = os.path.join(SRC, 'check')
os.makedirs(OUT, exist_ok=True)


def sheet(files, out, cols=2, size=480, titles=None):
    rows = (len(files) + cols - 1) // cols
    W = Image.new('RGB', (cols * (size + 6), rows * (size + 6)), (0, 0, 0))
    font = ImageFont.truetype('/System/Library/Fonts/STHeiti Medium.ttc', 22)
    for i, f in enumerate(files):
        im = Image.open(f).resize((size, size))
        if titles:
            ImageDraw.Draw(im).text((8, size - 34), titles[i], fill=(255, 80, 255), font=font)
        W.paste(im, ((i % cols) * (size + 6), (i // cols) * (size + 6)))
    W.save(out, quality=86)


def main(which):
    cl = json.load(open(os.path.join(SRC, 'wall_centerline.json')))
    els, po, pi = load()
    poly = cl['polygon']
    L = [(list(po.exterior.coords), (255, 0, 0), 1, False), (list(pi.exterior.coords), (0, 255, 0), 1, False),
         (cl['raw_midline'], (0, 200, 255), 1, True), (poly, (255, 255, 0), 2, True)]
    for p in poly:
        L.append(('pt', p[0], p[1], (255, 255, 0), ''))
    if which == 'corners':
        files = []
        for k, (x, z) in cl['corners'].items():
            f = os.path.join(OUT, f'corner_{k}.jpg')
            render(x, z, 70, 19, L, f, grid=20)
            files.append(f)
        sheet(files, os.path.join(OUT, 'sheet_corners.jpg'), titles=list(cl['corners']))
    elif which == 'gates':
        gates = json.load(open(os.path.join(SRC, 'wall_gates.json')))['gates']
        files, titles = [], []
        for g in gates:
            f = os.path.join(OUT, f'gate_{g["id"]}.jpg')
            LL = L + [('pt', g['world']['x'], g['world']['z'], (255, 0, 255), g['name']),
                      ('pt', g['osm_node_world'][0], g['osm_node_world'][1], (0, 255, 255), 'osm')]
            render(g['world']['x'], g['world']['z'], g.get('check_half', 70), 18, LL, f, grid=20)
            files.append(f); titles.append(g['name'])
        for i in range(0, len(files), 4):
            sheet(files[i:i + 4], os.path.join(OUT, f'sheet_gates_{i // 4}.jpg'), titles=titles[i:i + 4])


if __name__ == '__main__':
    main(sys.argv[1])
