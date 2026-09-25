"""城门位置：OSM historic=city_gate 节点投影到城墙中心线上（历史地标调研用）。

输出 data-src/landmarks_historic/wall_gates.json：每门 {id,name,osm_node,osm_node_world,world(中心线上),side,chainage_m,offset_m}
chainage 从西北角沿中心线顺序（北墙西→东，东墙北→南，南墙东→西，西墙南→北）计。
可用环境变量/手工修正表 FIX 覆盖（经卫星图目视核对后填写）。
"""
import json
import os
import sys

import numpy as np
from shapely.geometry import Polygon, Point, LineString

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import project, unproject  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data-src', 'landmarks_historic')

IDS = {'永宁门': 'yongning', '安远门': 'anyuan', '长乐门': 'changle', '安定门': 'anding', '含光门': 'hanguang',
       '朱雀门': 'zhuque', '勿幕门': 'wumu', '文昌门': 'wenchang', '和平门': 'heping', '建国门': 'jianguo',
       '朝阳门': 'chaoyang', '中山门': 'zhongshan', '尚俭门': 'shangjian', '尚勤门': 'shangqin', '解放门': 'jiefang',
       '尚德门': 'shangde', '尚武门': 'shangwu', '玉祥门': 'yuxiang'}

# 目视核对后的修正：name -> (x, z) 世界坐标（门洞中心，置于中心线上）；为空表示直接用 OSM 节点投影
FIX = json.load(open(os.path.join(SRC, 'gate_fix.json'))) if os.path.exists(os.path.join(SRC, 'gate_fix.json')) else {}


def main():
    cl = json.load(open(os.path.join(SRC, 'wall_centerline.json')))
    poly = np.array(cl['polygon'])
    # 从西北角开始
    nw = np.array(cl['corners']['NW'])
    i0 = int(np.argmin(np.hypot(*(poly - nw).T)))
    ring = np.vstack([poly[i0:], poly[:i0], poly[i0:i0 + 1]])
    line = LineString(ring)
    d = json.load(open(os.path.join(SRC, 'osm', 'wall.json')))
    gates = []
    corners_ch = {k: line.project(Point(v)) for k, v in cl['corners'].items()}
    for e in d['elements']:
        t = e.get('tags', {})
        if e['type'] == 'node' and t.get('historic') == 'city_gate' and t.get('name') in IDS:
            nx, nz = project(e['lon'], e['lat'])
            if t['name'] in FIX:
                px, pz = FIX[t['name']]
                p = Point(px, pz)
                ch = line.project(p)
                q = line.interpolate(ch)
            else:
                ch = line.project(Point(nx, nz))
                q = line.interpolate(ch)
            # 所在边
            if ch <= corners_ch['NE']:
                side = 'N'
            elif ch <= corners_ch['SE']:
                side = 'E'
            elif ch <= corners_ch['SW']:
                side = 'S'
            else:
                side = 'W'
            # 局部切向
            a = line.interpolate(max(ch - 15, 0)); b = line.interpolate(min(ch + 15, line.length))
            tan = np.array([b.x - a.x, b.y - a.y]); tan /= np.hypot(*tan)
            lon, lat = unproject(q.x, q.y)
            gates.append({'id': IDS[t['name']], 'name': t['name'], 'osm_node': e['id'],
                          'osm_node_world': [round(nx, 1), round(nz, 1)],
                          'lonlat': [round(lon, 7), round(lat, 7)],
                          'world': {'x': round(q.x, 1), 'z': round(q.y, 1)},
                          'side': side, 'chainage_from_NW_m': round(ch, 1),
                          'wall_tangent': [round(float(tan[0]), 4), round(float(tan[1]), 4)],
                          'osm_start_date': t.get('start_date'),
                          'osm_node_offset_m': round(Point(nx, nz).distance(q), 1)})
    gates.sort(key=lambda g: g['chainage_from_NW_m'])
    json.dump({'gates': gates, 'corners_chainage': {k: round(v, 1) for k, v in corners_ch.items()},
               'perimeter': round(line.length, 1)}, open(os.path.join(SRC, 'wall_gates.json'), 'w'), ensure_ascii=False, indent=1)
    for g in gates:
        print(g['side'], g['chainage_from_NW_m'], g['name'], g['world'], 'osm偏', g['osm_node_offset_m'])
    print(len(gates), corners_ch)


if __name__ == '__main__':
    main()
