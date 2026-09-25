"""把建筑高度原始数据裁剪到 MAIN 范围并转换成 height_source.py 用的紧凑缓存。

输入（见 research/heights.md 的下载说明）：
  data-src/heights/raw/cnbh/CNBH10m_X109Y35.tif, CNBH10m_X109Y33.tif   CNBH-10m（UTM 49N，10 m）
  data-src/heights/raw/ghsl/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_4326_3ss_V1_0_R6_C29.tif  GHS-BUILT-H ANBH（3″≈100 m）
  data-src/heights/raw/cmab/cmab_xian20221010.rar（从 CMAB 主城市包里按字节区间抠出来的西安 shapefile）
输出：
  data-src/heights/cnbh_main.npy + cnbh_main.json      uint16 分米，0 = 无建筑
  data-src/heights/ghsl_main.npy + ghsl_main.json      uint16 分米，0 = 无建筑
  data-src/heights/cmab_xian.npz                        建筑轮廓（世界坐标 float32）+ 高度/层数/功能/年代

用法：.venv-tools/bin/python tools/heights_prepare.py [cnbh] [ghsl] [cmab]
"""
import json
import math
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HDIR = os.path.join(ROOT, 'data-src', 'heights')
RAW = os.path.join(HDIR, 'raw')
W, S, E, N = geo.BOUNDS['MAIN']
MARGIN_DEG = 0.01


def _zarr(fn):
    import tifffile
    import zarr
    return zarr.open(tifffile.imread(fn, aszarr=True), mode='r')


def _geotags(fn):
    import tifffile
    with tifffile.TiffFile(fn) as t:
        p = t.pages[0]
        sx, sy, _ = p.tags['ModelPixelScaleTag'].value
        tp = p.tags['ModelTiepointTag'].value
        return p.shape, sx, sy, tp[3], tp[4]


# ---------------------------------------------------------------- CNBH-10m
def prep_cnbh():
    from pyproj import Transformer
    tr = Transformer.from_crs('EPSG:4326', 'EPSG:32649', always_xy=True)
    lons = np.linspace(W - MARGIN_DEG, E + MARGIN_DEG, 200)
    lats = np.linspace(S - MARGIN_DEG, N + MARGIN_DEG, 200)
    LL = np.array([(lo, la) for lo in lons for la in (lats[0], lats[-1])] +
                  [(lo, la) for la in lats for lo in (lons[0], lons[-1])])
    ex, ny = tr.transform(LL[:, 0], LL[:, 1])
    x0 = math.floor(ex.min() / 10) * 10
    x1 = math.ceil(ex.max() / 10) * 10
    y0 = math.floor(ny.min() / 10) * 10   # 南
    y1 = math.ceil(ny.max() / 10) * 10    # 北
    wpx = int((x1 - x0) / 10)
    hpx = int((y1 - y0) / 10)
    out = np.zeros((hpx, wpx), np.uint16)
    print('CNBH 网格', wpx, hpx, 'UTM', x0, y1)
    for name in ('CNBH10m_X109Y35.tif', 'CNBH10m_X109Y33.tif'):
        fn = os.path.join(RAW, 'cnbh', name)
        shape, sx, sy, tx, ty = _geotags(fn)
        assert sx == 10 and sy == 10
        # 源像素 (r,c) 左上角 = (tx + c*10, ty - r*10)
        c0 = int(round((x0 - tx) / 10)); r0 = int(round((ty - y1) / 10))
        # 与源的交集
        sc0 = max(c0, 0); sr0 = max(r0, 0)
        sc1 = min(c0 + wpx, shape[1]); sr1 = min(r0 + hpx, shape[0])
        if sc1 <= sc0 or sr1 <= sr0:
            continue
        a = _zarr(fn)[sr0:sr1, sc0:sc1]
        a = np.where(np.isfinite(a) & (a > 0), np.clip(a * 10 + 0.5, 1, 65535), 0).astype(np.uint16)
        dst = out[sr0 - r0:sr1 - r0, sc0 - c0:sc1 - c0]
        np.maximum(dst, a, out=dst)
        print(' ', name, '贡献', (a > 0).sum(), '个建筑像素')
    np.save(os.path.join(HDIR, 'cnbh_main.npy'), out)
    json.dump({'crs': 'EPSG:32649', 'x0': x0, 'y1': y1, 'px': 10.0, 'w': wpx, 'h': hpx,
               'unit': 'dm', 'nodata': 0,
               'note': '行 0 = 北边；像素 (r,c) 覆盖 x∈[x0+10c, x0+10c+10), y∈(y1-10r-10, y1-10r]'},
              open(os.path.join(HDIR, 'cnbh_main.json'), 'w'), ensure_ascii=False, indent=1)
    nz = out[out > 0] / 10
    print('CNBH 建筑像素', nz.size, '高度分位 50/90/99/max', np.percentile(nz, [50, 90, 99]), nz.max())


# ---------------------------------------------------------------- GHS-BUILT-H
def prep_ghsl():
    fn = os.path.join(RAW, 'ghsl', 'GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_4326_3ss_V1_0_R6_C29.tif')
    shape, sx, sy, tx, ty = _geotags(fn)
    c0 = int(math.floor((W - MARGIN_DEG - tx) / sx)); c1 = int(math.ceil((E + MARGIN_DEG - tx) / sx))
    r0 = int(math.floor((ty - (N + MARGIN_DEG)) / sy)); r1 = int(math.ceil((ty - (S - MARGIN_DEG)) / sy))
    a = _zarr(fn)[r0:r1, c0:c1]
    out = np.where(np.isfinite(a) & (a > 0), np.clip(a * 10 + 0.5, 1, 65535), 0).astype(np.uint16)
    np.save(os.path.join(HDIR, 'ghsl_main.npy'), out)
    json.dump({'crs': 'EPSG:4326', 'lon0': tx + c0 * sx, 'lat1': ty - r0 * sy, 'dlon': sx, 'dlat': sy,
               'w': out.shape[1], 'h': out.shape[0], 'unit': 'dm', 'nodata': 0,
               'var': 'ANBH 平均净建筑高度（建成区内建筑的平均高度），2018'},
              open(os.path.join(HDIR, 'ghsl_main.json'), 'w'), ensure_ascii=False, indent=1)
    nz = out[out > 0] / 10
    print('GHSL', out.shape, '非零', nz.size, '分位 50/90/99/max', np.percentile(nz, [50, 90, 99]), nz.max())


# ---------------------------------------------------------------- CMAB
FUNC = {'居住': 1, '商业': 2, '商服': 2, '办公': 2, '工业': 3, '公服': 4, '公共服务': 4, '文化': 5,
        '教育': 7, '医疗': 7, '交通': 6}


def _read_dbf(fn, want):
    with open(fn, 'rb') as f:
        h = f.read(32)
        n = struct.unpack('<I', h[4:8])[0]
        hl = struct.unpack('<H', h[8:10])[0]
        rl = struct.unpack('<H', h[10:12])[0]
        fields = []
        pos = 1
        while True:
            d = f.read(32)
            if d[0] == 0x0D:
                break
            name = d[:11].split(b'\0')[0].decode('latin1')
            ln = d[16]
            fields.append((name, pos, ln))
            pos += ln
        idx = {nm: (p, ln) for nm, p, ln in fields}
        cols = {k: [] for k in want}
        f.seek(hl)
        chunk = 4096
        done = 0
        while done < n:
            m = min(chunk, n - done)
            buf = f.read(rl * m)
            arr = np.frombuffer(buf, dtype=f'S{rl}')
            for k in want:
                p, ln = idx[k]
                cols[k].extend(r[p:p + ln].strip() for r in arr)
            done += m
    return n, cols


def _read_shp(fn):
    """返回 (part_xy float64 [M,2], part_off int64 [P+1], poly_part_off int64 [N+1])。"""
    data = open(fn, 'rb').read()
    pos = 100
    xy = []
    part_off = [0]
    poly_part_off = [0]
    total = 0
    while pos < len(data):
        clen = struct.unpack('>i', data[pos + 4:pos + 8])[0] * 2
        rec = data[pos + 8:pos + 8 + clen]
        pos += 8 + clen
        st = struct.unpack('<i', rec[:4])[0]
        if st == 0:
            poly_part_off.append(poly_part_off[-1])
            continue
        assert st in (5, 15, 25), st
        nparts, npts = struct.unpack('<2i', rec[36:44])
        parts = list(struct.unpack(f'<{nparts}i', rec[44:44 + 4 * nparts])) + [npts]
        pts = np.frombuffer(rec, '<f8', count=npts * 2, offset=44 + 4 * nparts).reshape(-1, 2)
        xy.append(pts)
        for k in range(nparts):
            total += parts[k + 1] - parts[k]
            part_off.append(total)
        poly_part_off.append(poly_part_off[-1] + nparts)
    return np.concatenate(xy), np.array(part_off, np.int64), np.array(poly_part_off, np.int64)


def prep_cmab():
    rar = os.path.join(RAW, 'cmab', 'cmab_xian20221010.rar')
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(['unar', '-q', '-f', '-o', td, rar], check=True)
        base = None
        for dp, _, fs in os.walk(td):
            for f in fs:
                if f.endswith('.shp'):
                    base = os.path.join(dp, f[:-4])
        print('CMAB', base)
        xy, part_off, poly_part_off = _read_shp(base + '.shp')
        n, cols = _read_dbf(base + '.dbf', ['pred_h_r', 'pred_h_lef', 'Floor', 'type_2023', 'predict',
                                            'Age', 'Shape_A', 'XzCity_Nm', 'XzCity_Nmx'])
    assert n == len(poly_part_off) - 1, (n, len(poly_part_off))
    # Pseudo-Mercator -> 世界坐标（契约投影就是缩放过的 Web Mercator）
    wx = ((xy[:, 0] - geo.MX0) * geo.K).astype(np.float32)
    wz = (-(xy[:, 1] - geo.MY0) * geo.K).astype(np.float32)

    def fnum(v):
        try:
            return float(v)
        except ValueError:
            return np.nan
    h = np.array([fnum(v) for v in cols['pred_h_r']], np.float32)
    hl = np.array([fnum(v) for v in cols['pred_h_lef']], np.float32)
    fl = np.array([fnum(v) for v in cols['Floor']], np.float32)
    area = np.array([fnum(v) for v in cols['Shape_A']], np.float32)
    age = np.array([int(fnum(v)) if v.strip().isdigit() else 0 for v in cols['Age']], np.int16)
    func_names = sorted(set(v.decode('utf8', 'replace') for v in cols['predict']) |
                        set(v.decode('utf8', 'replace') for v in cols['type_2023']))
    fmap = {nm: i for i, nm in enumerate(func_names)}
    func = np.array([fmap[v.decode('utf8', 'replace')] for v in cols['predict']], np.uint8)
    func23 = np.array([fmap[v.decode('utf8', 'replace')] for v in cols['type_2023']], np.uint8)
    dist_names = sorted(set((a.decode('utf8', 'replace') + '/' + b.decode('utf8', 'replace'))
                            for a, b in zip(cols['XzCity_Nm'], cols['XzCity_Nmx'])))
    dmap = {nm: i for i, nm in enumerate(dist_names)}
    dist = np.array([dmap[a.decode('utf8', 'replace') + '/' + b.decode('utf8', 'replace')]
                     for a, b in zip(cols['XzCity_Nm'], cols['XzCity_Nmx'])], np.uint8)
    # 每个建筑的外包框（世界坐标）
    npoly = n
    bb = np.zeros((npoly, 4), np.float32)
    for i in range(npoly):
        a0 = part_off[poly_part_off[i]]
        a1 = part_off[poly_part_off[i + 1]]
        if a1 <= a0:
            bb[i] = np.nan
            continue
        bb[i] = (wx[a0:a1].min(), wz[a0:a1].min(), wx[a0:a1].max(), wz[a0:a1].max())
    np.savez_compressed(os.path.join(HDIR, 'cmab_xian.npz'),
                        x=wx, z=wz, part_off=part_off, poly_part_off=poly_part_off, bbox=bb,
                        h=h, h_raw=hl, floor=fl, area=area, age=age, func=func, func23=func23, dist=dist,
                        func_names=np.array(func_names), dist_names=np.array(dist_names))
    ok = np.isfinite(h)
    print('CMAB 建筑', npoly, '有高度', ok.sum(), '高度分位 50/90/99/max',
          np.percentile(h[ok], [50, 90, 99]), h[ok].max())
    print('功能类别', func_names)
    print('区县', dist_names)
    x0, z0, x1, z1 = np.nanmin(bb[:, 0]), np.nanmin(bb[:, 1]), np.nanmax(bb[:, 2]), np.nanmax(bb[:, 3])
    print('覆盖（经纬度）', geo.unproject(x0, z1), geo.unproject(x1, z0))


def main(which=None):
    which = which or ['cnbh', 'ghsl', 'cmab']
    os.makedirs(HDIR, exist_ok=True)
    for w in which:
        globals()['prep_' + w]()


if __name__ == '__main__':
    main(sys.argv[1:])
