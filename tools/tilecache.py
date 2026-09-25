"""瓦片下载与本地缓存（build_dem.py / build_imagery.py 共用）。

- 并发 ≤ 8（线程池，每线程独立 requests.Session）
- 失败重试 + 指数退避；原子写入（先写 .part 再 rename）
- 已缓存且非空的文件直接跳过
"""
import os
import sys
import time
import threading
import hashlib
import json
import math
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

UA = 'xian3d-data-pipeline/1.0 (offline terrain/imagery builder; contact: local)'
MAX_WORKERS = 8

_tls = threading.local()


def _session():
    s = getattr(_tls, 's', None)
    if s is None:
        s = requests.Session()
        s.headers['User-Agent'] = UA
        _tls.s = s
    return s


def fetch(url, path, retries=7, timeout=40, validate=None):
    """下载单个文件到 path（已存在且非空则跳过）。返回 'cached' / 'ok' / 'missing'(404)。失败抛异常。"""
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return 'cached'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    last = None
    for a in range(retries):
        try:
            r = _session().get(url, timeout=timeout)
            if r.status_code == 404:
                return 'missing'
            if r.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f'HTTP {r.status_code}')
            r.raise_for_status()
            data = r.content
            if not data:
                raise RuntimeError('empty body')
            if validate is not None:
                validate(data)
            tmp = path + f'.part{threading.get_ident()}'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, path)
            return 'ok'
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(30.0, 0.8 * (2 ** a)))
    raise RuntimeError(f'下载失败 {url}: {last}')


def fetch_many(jobs, workers=MAX_WORKERS, label='tiles', validate=None):
    """jobs: [(url, path), ...]。返回 {path: status}。"""
    workers = min(workers, MAX_WORKERS)
    todo = [(u, p) for u, p in jobs if not (os.path.exists(p) and os.path.getsize(p) > 0)]
    res = {p: 'cached' for u, p in jobs}
    if not todo:
        print(f'[{label}] {len(jobs)} 个全部命中缓存', flush=True)
        return res
    print(f'[{label}] 共 {len(jobs)} 个，需下载 {len(todo)} 个（并发 {workers}）', flush=True)
    t0 = time.time()
    done = 0
    errors = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fetch, u, p, validate=validate): (u, p) for u, p in todo}
        for f in as_completed(futs):
            u, p = futs[f]
            try:
                res[p] = f.result()
            except Exception as e:  # noqa: BLE001
                errors.append((u, str(e)))
                res[p] = 'error'
            done += 1
            if done % 200 == 0 or done == len(todo):
                dt = time.time() - t0
                print(f'[{label}] {done}/{len(todo)}  {done / max(dt, 1e-6):.1f}/s', flush=True)
    if errors:
        print(f'[{label}] {len(errors)} 个失败，例如 {errors[:3]}', file=sys.stderr, flush=True)
    return res


def md5_file(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        h.update(f.read())
    return h.hexdigest()


def tile_range(bbox, z):
    """bbox=(w,s,e,n) -> 覆盖它的瓦片列/行范围 (tx0, tx1, ty0, ty1)，含端点。"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import geo
    w, s, e, n = bbox
    fx0, fy0 = geo.lonlat_to_tile(w, n, z)
    fx1, fy1 = geo.lonlat_to_tile(e, s, z)
    eps = 1e-9
    return int(math.floor(fx0 + eps)), int(math.ceil(fx1 - eps)) - 1, int(math.floor(fy0 + eps)), int(math.ceil(fy1 - eps)) - 1


def update_meta(meta_path, patch, merge_sources=None, drop_source_prefixes=()):
    """读-改-写 meta.json：保留他人写入的字段，只覆盖 patch 中的键；sources 做去重合并
    （先删掉以 drop_source_prefixes 开头的旧条目，便于本脚本更新自己的署名文字）。"""
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding='utf-8') as f:
                meta = json.load(f)
        except Exception:  # noqa: BLE001
            meta = {}
    meta.update(patch)
    if merge_sources:
        src = [s for s in (meta.get('sources') or [])
               if not any(s.startswith(p) for p in drop_source_prefixes)]
        for s in merge_sources:
            if s not in src:
                src.append(s)
        meta['sources'] = src
    tmp = meta_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(tmp, meta_path)
    return meta
