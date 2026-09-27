// WGS-84 → GCJ-02（“火星坐标”）换算。高德/腾讯等国内底图瓦片按 GCJ-02 绘制，
// 本工程的世界坐标是 WGS-84，所以取国内影像时需要把请求范围平移到 GCJ-02 再拼接。
const A = 6378245.0;
const EE = 0.00669342162296594323;

function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}
function tLon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}

/** WGS-84 经纬度 → GCJ-02 经纬度 */
export function wgs2gcj(lon, lat) {
  let dLat = tLat(lon - 105, lat - 35);
  let dLon = tLon(lon - 105, lat - 35);
  const rl = (lat / 180) * Math.PI;
  let m = Math.sin(rl);
  m = 1 - EE * m * m;
  const s = Math.sqrt(m);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (m * s)) * Math.PI);
  dLon = (dLon * 180) / ((A / s) * Math.cos(rl) * Math.PI);
  return { lon: lon + dLon, lat: lat + dLat };
}
