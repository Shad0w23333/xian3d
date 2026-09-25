"""历史地标调研：在 Esri 卫星图上叠加世界坐标折线/点，生成目视核对图。

用法（库）：render(cx, cz, half, z, layers, out)
layers = [(points[[x,z],...], (r,g,b), width, closed), ...]；点标记 layers 元素为 ('pt', x, z, color, label)
"""
from PIL import Image, ImageDraw, ImageFont
from geo import unproject
from landmarks_tiles import mosaic, world_crop


def render(cx, cz, half, z, layers, out, scale=1.0, grid=None):
    lon0, lat1 = unproject(cx - half - 5, cz - half - 5)
    lon1, lat0 = unproject(cx + half + 5, cz + half + 5)
    img, wb = mosaic(lon0, lat0, lon1, lat1, z)
    img, wb = world_crop(img, wb, cx, cz, half)
    d = ImageDraw.Draw(img)
    W, H = img.size

    def px(x, zz):
        return ((x - wb[0]) / (wb[2] - wb[0]) * W, (zz - wb[1]) / (wb[3] - wb[1]) * H)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/STHeiti Medium.ttc', 16)
    except Exception:
        font = ImageFont.load_default()
    if grid:
        import math
        gx = math.floor(wb[0] / grid) * grid
        while gx < wb[2]:
            d.line([px(gx, wb[1]), px(gx, wb[3])], fill=(255, 255, 255), width=1)
            d.text(px(gx + 1, wb[1] + 1), f'{gx:.0f}', fill=(255, 255, 0), font=font)
            gx += grid
        gz = math.floor(wb[1] / grid) * grid
        while gz < wb[3]:
            d.line([px(wb[0], gz), px(wb[2], gz)], fill=(255, 255, 255), width=1)
            d.text(px(wb[0] + 1, gz + 1), f'{gz:.0f}', fill=(255, 255, 0), font=font)
            gz += grid
    for L in layers:
        if L[0] == 'pt':
            _, x, zz, col, lab = L
            X, Y = px(x, zz)
            d.ellipse([X - 5, Y - 5, X + 5, Y + 5], outline=col, width=2)
            if lab:
                d.text((X + 7, Y - 8), lab, fill=col, font=font)
        else:
            pts, col, w, closed = L
            P = [px(x, zz) for x, zz in pts]
            if closed:
                P = P + [P[0]]
            if len(P) > 1:
                d.line(P, fill=col, width=w)
    if scale != 1.0:
        img = img.resize((int(W * scale), int(H * scale)))
    img.save(out, quality=88)
    return wb
