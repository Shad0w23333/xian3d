#!/usr/bin/env python3
"""从 Overture Maps（AWS S3 公共桶，每月发布）按范围抓取最新的道路/建筑/地点，保存为 GeoParquet 缓存。

Overture 交通网（transportation/segment）来自 OpenStreetMap 最新快照，建筑（buildings/building）融合 OSM、
Microsoft、Google 等来源 —— 比本地 Geofabrik 快照更新，用来更新过时片区。

用法：
  python tools/fetch_overture.py --theme transportation --type segment --bbox 108.84,34.17,109.06,34.40
  python tools/fetch_overture.py --theme buildings --type building --bbox ...
输出：data-src/overture/<type>.parquet
"""
import argparse
import os
import sys
import time
from urllib.parse import urlparse

import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import pyarrow.parquet as pq

BUCKET = 'overturemaps-us-west-2'
RELEASE = '2026-09-23.1'


def s3fs():
    kw = dict(anonymous=True, region='us-west-2')
    px = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    if px:
        u = urlparse(px)
        kw['proxy_options'] = {'scheme': u.scheme or 'http', 'host': u.hostname, 'port': u.port or 80}
    return pafs.S3FileSystem(**kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--theme', required=True)
    ap.add_argument('--type', required=True)
    ap.add_argument('--bbox', default='108.84,34.17,109.06,34.40', help='w,s,e,n')
    ap.add_argument('--release', default=RELEASE)
    ap.add_argument('--out')
    ap.add_argument('--columns', default='')
    a = ap.parse_args()
    w, s, e, n = map(float, a.bbox.split(','))
    path = f'{BUCKET}/release/{a.release}/theme={a.theme}/type={a.type}/'
    dset = ds.dataset(path, filesystem=s3fs(), format='parquet')
    flt = ((pc.field('bbox', 'xmin') < e) & (pc.field('bbox', 'xmax') > w) &
           (pc.field('bbox', 'ymin') < n) & (pc.field('bbox', 'ymax') > s))
    cols = [c for c in a.columns.split(',') if c] or None
    t0 = time.time()
    tables = []
    rows = 0
    for i, frag in enumerate(dset.get_fragments()):
        # 先用行组统计裁剪（只下载覆盖范围的行组）
        sub = frag.subset(flt)
        if not sub.row_groups:
            continue
        tb = sub.to_table(filter=flt, columns=cols)
        if tb.num_rows:
            tables.append(tb)
            rows += tb.num_rows
        print(f'  片段 {i} 行组 {len(sub.row_groups)} → {tb.num_rows}（累计 {rows}，{time.time() - t0:.0f}s）', file=sys.stderr)
    import pyarrow as pa
    out = a.out or f'data-src/overture/{a.type}.parquet'
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if tables:
        pq.write_table(pa.concat_tables(tables, promote_options='permissive'), out, compression='zstd')
    print(f'完成：{rows} 行 → {out}（{time.time() - t0:.0f}s）')


if __name__ == '__main__':
    main()
