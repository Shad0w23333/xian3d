"""Collect the current job's original offline build on the Mac mini."""
import os
from pathlib import Path
import runpy
import sys
import time

HOST_BIN = Path('/Users/Shared/macmini-ci/bin')
sys.path.insert(0, str(HOST_BIN))
from artifact_collector import collect_products, fresh_products_exist

PRODUCT = 'dist-standalone/西安3D-离线单文件版.html'


def collect_standalone(root, out, started_at):
    root, out = Path(root), Path(out)
    if not fresh_products_exist(root, out, [PRODUCT], started_at):
        raise SystemExit('当前 CI 未生成新的离线单文件，拒绝上传旧缓存。')
    collect_products(root, out, [PRODUCT], lambda relative, is_dir: relative)
    product = out / PRODUCT
    if not product.is_file() or not product.stat().st_size:
        raise SystemExit('离线单文件收集失败。')
    print(f'已收集离线单文件：{PRODUCT}（{product.stat().st_size} 字节）')


def main():
    helpers = runpy.run_path(str(HOST_BIN / 'collect-artifacts.py'))
    started_at = helpers['job_start'](helpers['record_path'](), time.time())
    collect_standalone(
        Path(os.environ['GITHUB_WORKSPACE']),
        Path(os.environ['RUNNER_TEMP']) / 'ci-artifacts',
        started_at,
    )


if __name__ == '__main__':
    main()
