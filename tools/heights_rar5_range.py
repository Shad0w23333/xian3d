import sys, struct, requests, time, json
URL = sys.argv[1]
S = requests.Session(); S.headers['User-Agent'] = 'xian3d-research/1.0'
def get(a, b):
    for k in range(6):
        try:
            r = S.get(URL, headers={'Range': f'bytes={a}-{b}'}, timeout=60)
            if r.status_code in (200, 206): return r.content
        except Exception as e:
            print('retry', e, file=sys.stderr)
        time.sleep(2 * (k + 1))
    raise RuntimeError('fail')
def vint(b, i):
    v = 0; s = 0
    while True:
        c = b[i]; i += 1
        v |= (c & 0x7f) << s; s += 7
        if not c & 0x80: return v, i
off = 8
entries = []
while True:
    h = get(off, off + 4095)
    i = 4
    hsize, i = vint(h, i)
    hstart = i
    htype, i = vint(h, i)
    hflags, i = vint(h, i)
    extra = data = 0
    if hflags & 1: extra, i = vint(h, i)
    if hflags & 2: data, i = vint(h, i)
    name = None
    if htype in (2, 3):
        fflags, i = vint(h, i); usize, i = vint(h, i); attr, i = vint(h, i)
        if fflags & 2: i += 4
        if fflags & 4: i += 4
        comp, i = vint(h, i); hos, i = vint(h, i); nl, i = vint(h, i)
        name = h[i:i + nl].decode('utf8', 'replace')
        entries.append(dict(type=htype, name=name, off=off, hdr_end=hstart + hsize + off, data=data, usize=usize, comp=comp, flags=hflags))
        print(htype, name, off, data, usize, hex(comp), flush=True)
    else:
        print('hdr type', htype, off, data, flush=True)
    if htype == 5: break
    off = off + hstart + hsize + data
json.dump(entries, open(sys.argv[2], 'w'), ensure_ascii=False, indent=0)
