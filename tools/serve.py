#!/usr/bin/env python3
"""零依赖静态服务器（支持 HTTP Range；/tiles/ 映射到仓库根目录 tiles/ 离线影像包）。用法：python3 tools/serve.py [目录=dist] [端口=4173]"""
import http.server
import os
import re
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILES = os.path.join(ROOT, 'tiles')


class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, p):
        # /tiles/ 映射到仓库根目录 tiles/（离线影像包，不复制进 dist）
        q = p.split('?', 1)[0].split('#', 1)[0]
        if q.startswith('/tiles/'):
            return os.path.join(TILES, os.path.normpath(q[7:]).lstrip('/\\'))
        return super().translate_path(p)

    def send_head(self):
        path = self.translate_path(self.path)
        rng = self.headers.get('Range')
        if not rng or os.path.isdir(path) or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r'bytes=(\d*)-(\d*)$', rng)
        size = os.path.getsize(path)
        if not m:
            return super().send_head()
        a, b = m.groups()
        start = size - int(b) if a == '' else int(a)
        end = size - 1 if (a == '' or b == '') else min(int(b), size - 1)
        if start > end or start >= size:
            self.send_error(416)
            return None
        f = open(path, 'rb')
        f.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        self._remain = end - start + 1
        return f

    def copyfile(self, src, dst):
        n = getattr(self, '_remain', None)
        if n is None:
            return super().copyfile(src, dst)
        while n > 0:
            buf = src.read(min(65536, n))
            if not buf:
                break
            dst.write(buf)
            n -= len(buf)


if __name__ == '__main__':
    d = sys.argv[1] if len(sys.argv) > 1 else 'dist'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 4173
    os.chdir(d)
    print(f'服务已启动：http://localhost:{port}/ （目录 {d}，支持 Range）')
    http.server.ThreadingHTTPServer(('', port), H).serve_forever()
