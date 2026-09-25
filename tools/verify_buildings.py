#!/usr/bin/env python3
"""解析并检查 public/data/buildings.bin（v1/v2），打印统计并画按高度着色的俯视图。

输出
  data-src/osm/buildings_v2_preview.png        全城俯视（按高度着色）
  data-src/osm/buildings_v2_gaoxin.png         高新 CBD 局部放大
  data-src/osm/buildings_v2_qujiang.png        曲江 / 大雁塔局部放大
  data-src/osm/buildings_v2_wall.png           城墙内局部放大
用法：.venv-tools/bin/python tools/verify_buildings.py [path/to/buildings.bin]
"""
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

KIND_NAMES = ['通用', '住宅', '商业/办公', '工业', '公共/政府', '历史/宗教', '交通', '学校/医院', '酒店']
STYLE_FUNC_NAMES = ['未知', '居住高层塔楼', '居住多层板楼', '别墅/低层', '城中村自建房', '办公', '商业综合体', '工业厂房', '公共']
STYLE_AGE_NAMES = ['未知', '1990前', '1990s', '2000s', '2010s', '2020+']
OUTD = os.path.join(ROOT, 'data-src', 'osm')


def parse(path):
    buf = open(path, 'rb').read()
    assert buf[:4] == b'XBLD', '魔数错误'
    ver, n, total = struct.unpack_from('<III', buf, 4)
    o = 16

    def take(dt, cnt):
        nonlocal o
        a = np.frombuffer(buf, dt, cnt, o)
        o += a.nbytes
        return a
    d = {'version': ver, 'count': n, 'total': total}
    d['ax'] = take('<f4', n)
    d['az'] = take('<f4', n)
    d['start'] = take('<u4', n)
    d['cnt'] = take('<u2', n)
    d['h'] = take('<u2', n) / 10.0
    d['minh'] = take('<u2', n) / 10.0
    d['kind'] = take('u1', n)
    d['flags'] = take('u1', n)
    d['style'] = take('u1', n) if ver >= 2 else np.zeros(n, np.uint8)
    o = (o + 3) & ~3
    d['offs'] = take('<i2', total * 2).reshape(-1, 2)
    assert o == len(buf), f'文件长度不符：解析到 {o}，实际 {len(buf)}'
    # 结构检查
    assert np.all(d['start'][1:] == d['start'][:-1] + d['cnt'][:-1].astype(np.uint32)), 'vertStart 不连续'
    assert int(d['start'][-1]) + int(d['cnt'][-1]) == total, 'totalVerts 不符'
    return d


def ring(d, i):
    s, c = int(d['start'][i]), int(d['cnt'][i])
    o = d['offs'][s:s + c].astype(np.float64) / 10.0
    return np.c_[d['ax'][i] + o[:, 0], d['az'][i] + o[:, 1]]


def check_orientation(d, sample=20000):
    rng = np.random.default_rng(0)
    idx = rng.choice(d['count'], min(sample, d['count']), replace=False)
    neg = 0
    small = 0
    for i in idx:
        s, c = int(d['start'][i]), int(d['cnt'][i])
        o = d['offs'][s:s + c].astype(np.float64)
        a = 0.5 * (np.dot(o[:, 0], np.roll(o[:, 1], -1)) - np.dot(o[:, 1], np.roll(o[:, 0], -1))) / 100
        neg += a <= 0
        small += abs(a) < 15
    return neg, small, len(idx)


def color_for(h):
    """高度 → 颜色（低：灰蓝，中：绿黄，高：橙红，超高：品红）。"""
    stops = [(0, (70, 90, 120)), (10, (90, 140, 170)), (20, (80, 180, 120)), (35, (200, 210, 70)),
             (60, (250, 160, 40)), (90, (240, 70, 40)), (150, (230, 30, 160)), (250, (255, 255, 255))]
    for (h0, c0), (h1, c1) in zip(stops[:-1], stops[1:]):
        if h <= h1:
            t = (h - h0) / (h1 - h0)
            return tuple(int(a + (b - a) * max(0, min(1, t))) for a, b in zip(c0, c1))
    return stops[-1][1]


def _font(sz):
    for p in ('/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc',
              '/System/Library/Fonts/Hiragino Sans GB.ttc'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:  # noqa: BLE001
                pass
    return ImageFont.load_default()


def legend(img, title):
    dr = ImageDraw.Draw(img)
    f = _font(16)
    dr.rectangle((0, 0, 560, 50), fill=(0, 0, 0))
    dr.text((8, 4), title, fill=(255, 255, 255), font=f)
    x = 8
    for hv in (5, 10, 20, 35, 60, 90, 150, 250):
        dr.rectangle((x, 28, x + 22, 44), fill=color_for(hv))
        dr.text((x + 25, 27), f'{hv}', fill=(255, 255, 255), font=_font(13))
        x += 62
    dr.text((x, 27), 'm', fill=(255, 255, 255), font=_font(13))


def render(d, bbox, res, path, title, order_by_height=True, scale_small=1.0):
    x0, z0, x1, z1 = bbox
    W, H = int((x1 - x0) / res), int((z1 - z0) / res)
    img = Image.new('RGB', (W, H), (18, 18, 22))
    dr = ImageDraw.Draw(img)
    sel = np.nonzero((d['ax'] > x0 - 300) & (d['ax'] < x1 + 300) & (d['az'] > z0 - 300) & (d['az'] < z1 + 300))[0]
    if order_by_height:
        sel = sel[np.argsort(d['h'][sel])]
    for i in sel:
        r = ring(d, i)
        pts = [((x - x0) / res, (z - z0) / res) for x, z in r]
        if len(pts) >= 3:
            dr.polygon(pts, fill=color_for(d['h'][i]))
    legend(img, title)
    img.save(path)
    print('写出', path, img.size)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'public', 'data', 'buildings.bin')
    d = parse(path)
    n = d['count']
    names = json.load(open(os.path.join(os.path.dirname(path), 'buildings_names.json'), encoding='utf-8'))
    h = d['h']
    print(f'文件 {path}：{os.path.getsize(path) / 1e6:.2f} MB，version={d["version"]}，建筑 {n}，顶点 {d["total"]}'
          f'（平均 {d["total"] / n:.1f}/栋），命名 {len(names)}')
    neg, small, m = check_orientation(d)
    print(f'抽样 {m} 栋：非 CCW {neg}，面积<15m² {small}；顶点数 min/max = {d["cnt"].min()}/{d["cnt"].max()}')
    nm_bad = [k for k in names if not (0 <= int(k) < n) or not (d['flags'][int(k)] & 2)]
    print('名称表索引/flag bit1 不一致：', len(nm_bad))
    q = [1, 5, 10, 25, 50, 75, 90, 95, 99, 99.9]
    print('高度分位（m）：', ' '.join(f'p{p}={v:.1f}' for p, v in zip(q, np.percentile(h, q))), f'max={h.max():.1f}')
    print(f'>30 m {int((h > 30).sum())}，>60 m {int((h > 60).sum())}，>80 m {int((h > 80).sum())}，'
          f'>100 m {int((h > 100).sum())}，>150 m {int((h > 150).sum())}，>200 m {int((h > 200).sum())}')
    bins = [0, 6, 10, 15, 20, 30, 45, 60, 80, 100, 150, 400]
    hist, _ = np.histogram(h, bins)
    print('高度直方：', ' '.join(f'[{a},{b}):{c}' for a, b, c in zip(bins[:-1], bins[1:], hist)))
    fl = d['flags']
    print(f'flags：实测 {int((fl & 1).sum())}，有名 {int((fl & 2).sum() > 0 and (fl & 2).astype(bool).sum())}，'
          f'高层地标(bit2) {int((fl & 4).astype(bool).sum())}，skyline 渲染(bit3) {int((fl & 8).astype(bool).sum())}')
    print('kind：', ' '.join(f'{KIND_NAMES[k]}={c}' for k, c in zip(*np.unique(d['kind'], return_counts=True))))
    sf = d['style'] >> 4
    sa = d['style'] & 15
    print('style 功能：', ' '.join(f'{STYLE_FUNC_NAMES[k]}={c}' for k, c in zip(*np.unique(sf, return_counts=True))))
    print('style 年代：', ' '.join(f'{STYLE_AGE_NAMES[k]}={c}' for k, c in zip(*np.unique(sa, return_counts=True))))
    for k in range(9):
        m = sf == k
        if m.sum():
            print(f'  {STYLE_FUNC_NAMES[k]:8s} 高度 p10/p50/p90 = {np.percentile(h[m], [10, 50, 90]).round(1)}')
    # 分区核对
    ax, az = d['ax'], d['az']
    wall = (ax > -1990) & (ax < 2225) & (az > -1860) & (az < 848)
    r = np.hypot(ax, az)
    zones = {'城墙内': wall, '城墙外~二环(r<4.5km)': ~wall & (r < 4500), '二环~三环(4.5–10km)': (r >= 4500) & (r < 10000),
             '三环外(10–20km)': (r >= 10000) & (r < 20000), '外围(>20km)': r >= 20000,
             '高新CBD(-7000..-5000,6500..8000)': (ax > -7000) & (ax < -5000) & (az > 6500) & (az < 8000),
             '曲江(1500..4500,4000..7500)': (ax > 1500) & (ax < 4500) & (az > 4000) & (az < 7500)}
    for k, m in zones.items():
        if m.sum():
            hh = h[m]
            print(f'  {k:28s} n={int(m.sum()):6d}  p50={np.median(hh):5.1f}  p90={np.percentile(hh, 90):5.1f}  '
                  f'≤7层(≤24m) {100 * (hh <= 24).mean():4.1f}%  ≥60m {int((hh >= 60).sum())}  ≥100m {int((hh >= 100).sum())}  max={hh.max():.0f}')
    # 最高 25 栋
    top = np.argsort(-h)[:25]
    print('最高 25 栋：')
    for i in top:
        print(f'   {h[i]:6.1f} m  ({ax[i]:8.1f},{az[i]:8.1f})  {names.get(str(i), "")}  kind={KIND_NAMES[d["kind"][i]]}  flags={d["flags"][i]}')
    os.makedirs(OUTD, exist_ok=True)
    render(d, (-24000, -20000, 16000, 18000), 20.0, os.path.join(OUTD, 'buildings_v2_preview.png'), '西安建筑高度（俯视，20 m/px）')
    render(d, (-7600, 5600, -4400, 8800), 2.0, os.path.join(OUTD, 'buildings_v2_gaoxin.png'), '高新 CBD（2 m/px）')
    render(d, (600, 3600, 4400, 7400), 2.0, os.path.join(OUTD, 'buildings_v2_qujiang.png'), '曲江 / 大雁塔（2 m/px）')
    render(d, (-2200, -2000, 2400, 1000), 2.5, os.path.join(OUTD, 'buildings_v2_wall.png'), '城墙内（2.5 m/px）')


if __name__ == '__main__':
    main()
