"""buildings.bin（v2）读写工具。格式见 docs/CONTRACT.md 3.4（v2 在 flags 后多一个 uint8 style 数组）。"""
import struct

import numpy as np


def read(path='public/data/buildings.bin'):
    b = open(path, 'rb').read()
    assert b[:4] == b'XBLD'
    ver, n, total = struct.unpack('<III', b[4:16])
    o = 16

    def take(dt, cnt):
        nonlocal o
        a = np.frombuffer(b, dt, cnt, o)
        o += a.nbytes
        return a.copy()
    ax, az = take('<f4', n), take('<f4', n)
    start, cnt = take('<u4', n), take('<u2', n)
    hd, md = take('<u2', n), take('<u2', n)
    kind, flags = take('u1', n), take('u1', n)
    style = take('u1', n) if ver >= 2 else np.zeros(n, np.uint8)
    o += (-o) % 4
    offs = take('<i2', total * 2).reshape(-1, 2)
    return dict(version=ver, n=n, ax=ax, az=az, start=start, cnt=cnt, h=hd / 10.0, minh=md / 10.0,
                kind=kind, flags=flags, style=style, offs=offs)


def ring(B, i):
    s, c = int(B['start'][i]), int(B['cnt'][i])
    d = B['offs'][s:s + c].astype(np.float64) / 10.0
    return d + [B['ax'][i], B['az'][i]]


def write(B, path, keep=None):
    """B 同 read() 返回结构；keep 为保留的下标（None=全部）。ring 数据取自 B['rings']（若存在）否则取原 offs。"""
    n0 = B['n']
    idx = np.arange(n0) if keep is None else np.asarray(keep)
    rings = [B['rings'][i] if 'rings' in B else ring(B, i) for i in idx]
    ax = np.array([B['ax'][i] for i in idx], np.float32)
    az = np.array([B['az'][i] for i in idx], np.float32)
    offs, counts = [], []
    for k, r in enumerate(rings):
        d = np.round((np.asarray(r) - [ax[k], az[k]]) * 10).astype(np.int64)
        offs.append(d.astype(np.int16))
        counts.append(len(d))
    counts = np.array(counts, np.uint32)
    starts = np.r_[0, np.cumsum(counts)[:-1]].astype(np.uint32)
    total = int(counts.sum())
    hd = np.clip(np.round(B['h'][idx] * 10), 30, 65535).astype('<u2')
    md = np.clip(np.round(B['minh'][idx] * 10), 0, 65535).astype('<u2')
    parts = [b'XBLD', struct.pack('<III', 2, len(idx), total), ax.astype('<f4').tobytes(), az.astype('<f4').tobytes(),
             starts.astype('<u4').tobytes(), counts.astype('<u2').tobytes(), hd.tobytes(), md.tobytes(),
             B['kind'][idx].astype('u1').tobytes(), B['flags'][idx].astype('u1').tobytes(), B['style'][idx].astype('u1').tobytes()]
    body = b''.join(parts)
    body += b'\0' * ((-len(body)) % 4)
    body += np.concatenate(offs).astype('<i2').tobytes()
    open(path, 'wb').write(body)
