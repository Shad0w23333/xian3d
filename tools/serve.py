#!/usr/bin/env python3
"""零依赖静态服务器（支持 HTTP Range；/tiles/ 映射到仓库根目录 tiles/ 离线影像包）。
用法：python3 tools/serve.py [目录=dist] [端口=4173] [监听地址=127.0.0.1，局域网访问用 0.0.0.0]"""
import http.server
import os
import re
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILES = os.path.join(ROOT, 'tiles')


class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, p):
        # /tiles/ 映射到仓库根目录 tiles/（离线影像包，不复制进 dist）。
        # 复用标准库的安全拼接（URL 解码、丢弃 ../盘符/含分隔符的段），只把根目录临时换成 TILES，
        # 防止 /tiles/../../etc/passwd 或 Windows 上 /tiles/C:/Windows/win.ini 读到目录外的文件
        q = p.split('?', 1)[0].split('#', 1)[0]
        if q.startswith('/tiles/'):
            d = self.directory
            self.directory = TILES
            try:
                return super().translate_path(p[6:])
            finally:
                self.directory = d
        return super().translate_path(p)

    def send_head(self):
        self._remain = None
        path = self.translate_path(self.path)
        rng = self.headers.get('Range')
        if not rng or os.path.isdir(path) or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r'bytes=(\d*)-(\d*)$', rng)
        # 不是单一区间或 "bytes=-"（首尾都空）：忽略 Range，按整文件返回
        if not m or m.groups() == ('', ''):
            return super().send_head()
        try:
            size = os.path.getsize(path)
            a, b = m.groups()
            # 后缀区间 bytes=-N：N 超过文件长度时返回整个文件（RFC 9110），不能 seek 到负位置
            start = max(0, size - int(b)) if a == '' else int(a)
            end = size - 1 if (a == '' or b == '') else min(int(b), size - 1)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return None
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, 'File not found')
            return None
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
    # 默认只监听本机（影像包仅供个人本地使用）；需要局域网访问时显式传 0.0.0.0
    host = sys.argv[3] if len(sys.argv) > 3 else '127.0.0.1'
    os.chdir(d)
    print(f'服务已启动：http://localhost:{port}/ （目录 {d}，支持 Range；监听 {host}）')
    http.server.ThreadingHTTPServer((host, port), H).serve_forever()
