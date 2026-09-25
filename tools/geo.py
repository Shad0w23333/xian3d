"""西安 3D 统一投影（与 src/core/geo.js 完全一致）。见 docs/CONTRACT.md 第 1 节。"""
import math

LAT0 = 34.2610119
LON0 = 108.9423419
R = 6378137.0
K = math.cos(math.radians(LAT0))

BOUNDS = {
    'OUTER': (108.30, 33.65, 109.70, 34.90),   # (west, south, east, north)
    'MAIN':  (108.60, 33.95, 109.40, 34.72),
    'CORE':  (108.84, 34.17, 109.06, 34.35),
}


def merc_x(lon):
    return R * math.radians(lon)


def merc_y(lat):
    return R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


MX0 = merc_x(LON0)
MY0 = merc_y(LAT0)


def project(lon, lat):
    """经纬度 -> 世界坐标 (x 东, z 南)。"""
    return ((merc_x(lon) - MX0) * K, -(merc_y(lat) - MY0) * K)


def unproject(x, z):
    mx = x / K + MX0
    my = -z / K + MY0
    lon = math.degrees(mx / R)
    lat = math.degrees(2 * math.atan(math.exp(my / R)) - math.pi / 2)
    return lon, lat


def merc_to_world(mx, my):
    return ((mx - MX0) * K, -(my - MY0) * K)


def tile_merc_bounds(z, x, y):
    """Web Mercator 瓦片 (z,x,y) 的墨卡托米坐标边界 (mx0, my0_south, mx1, my1_north)。"""
    n = 2 ** z
    size = 2 * math.pi * R / n
    mx0 = -math.pi * R + x * size
    my1 = math.pi * R - y * size
    return mx0, my1 - size, mx0 + size, my1


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    lr = math.radians(lat)
    y = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n
    return x, y


if __name__ == '__main__':
    print('K =', K)
    print('钟楼', project(LON0, LAT0))
    print('大雁塔', project(108.9642, 34.2197))
    print('往返', unproject(*project(109.1, 34.5)))
