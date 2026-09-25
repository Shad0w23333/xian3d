// 西安 3D 统一投影（与 tools/geo.py 完全一致），见 docs/CONTRACT.md 第 1 节。
export const LAT0 = 34.2610119;
export const LON0 = 108.9423419;
export const R = 6378137;
export const K = Math.cos((LAT0 * Math.PI) / 180);

export const BOUNDS = {
  OUTER: [108.3, 33.65, 109.7, 34.9],
  MAIN: [108.6, 33.95, 109.4, 34.72],
  CORE: [108.84, 34.17, 109.06, 34.35],
};

export const mercX = (lon) => (R * lon * Math.PI) / 180;
export const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

const MX0 = mercX(LON0);
const MY0 = mercY(LAT0);

/** 经纬度 -> 世界坐标 {x 东, z 南} */
export function project(lon, lat) {
  return { x: (mercX(lon) - MX0) * K, z: -(mercY(lat) - MY0) * K };
}

/** 世界坐标 -> 经纬度 */
export function unproject(x, z) {
  const mx = x / K + MX0;
  const my = -z / K + MY0;
  return {
    lon: (mx / R) * (180 / Math.PI),
    lat: (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI),
  };
}

/** 墨卡托米 -> 世界坐标 */
export const mercToWorld = (mx, my) => ({ x: (mx - MX0) * K, z: -(my - MY0) * K });

/** Web Mercator 瓦片的世界坐标边界 {x0,x1,z0(北),z1(南)} */
export function tileWorldBounds(z, x, y) {
  const n = 2 ** z;
  const size = (2 * Math.PI * R) / n;
  const mx0 = -Math.PI * R + x * size;
  const myN = Math.PI * R - y * size;
  const a = mercToWorld(mx0, myN);
  const b = mercToWorld(mx0 + size, myN - size);
  return { x0: a.x, z0: a.z, x1: b.x, z1: b.z };
}

/** 经纬度 -> 瓦片浮点坐标 */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const lr = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n,
  };
}

/** 世界坐标 -> 瓦片浮点坐标 */
export function worldToTile(x, z, zoom) {
  const mx = x / K + MX0;
  const my = -z / K + MY0;
  const n = 2 ** zoom;
  const size = (2 * Math.PI * R) / n;
  return { x: (mx + Math.PI * R) / size, y: (Math.PI * R - my) / size };
}

/** 经纬度数组包围盒 [w,s,e,n] -> 世界坐标包围盒 */
export function lonLatBoxToWorld([w, s, e, n]) {
  const a = project(w, n);
  const b = project(e, s);
  return { x0: a.x, z0: a.z, x1: b.x, z1: b.z };
}
