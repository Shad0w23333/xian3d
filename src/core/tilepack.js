// 本地离线影像瓦片包（.xtp）：少量大文件 + HTTP Range 按需读取，替代在线流式影像（省带宽、可断网使用）。
// 由 tools/imagery_pack.py 生成，清单 public/tiles/index.json：
//   {"version":1, "attribution":"…", "packs":[{"file":"xian_z18-19.xtp","minZ":18,"maxZ":19,"count":12345}, …]}
// .xtp 格式（小端）：
//   头 32 B：magic "XTP1" | u32 version=1 | u32 count | u32 format(1=jpeg 2=png 3=webp) | u64 indexOffset | u64 dataOffset
//   索引（count × 20 B，按 z,x,y 升序）：u32 (z<<24 | x) | u32 y | u64 offset（相对文件头）| u32 length
//   数据：各瓦片的原始图像字节（256×256，Web Mercator / WGS-84，已完成 GCJ 纠偏）
const HEADER = 32;
const ENTRY = 20;
// 覆盖表的数值键（与索引一致 x < 2^24；z ≤ 24 时结果 < 2^53，精确）
const ckey = (z, x, y) => (z * 16777216 + x) * 16777216 + y;

async function rangeFetch(url, start, end, signal) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
  if (res.status === 200) {
    // 服务器忽略了 Range：立刻中止，避免把几百 MB 的包整个下载下来
    try { res.body && res.body.cancel(); } catch { /* 忽略 */ }
    throw new Error('服务器不支持 HTTP Range（请用 npm run dev / npm run preview 或 tools/serve.mjs 启动）');
  }
  if (res.status !== 206) throw new Error('HTTP ' + res.status);
  return res.arrayBuffer();
}

class Pack {
  constructor(url, meta) {
    this.url = url;
    this.meta = meta;
    this.map = new Map(); // "z/x/y" -> [offset, length]
    this.cover = new Map(); // ckey(z,x,y) -> 该瓦片范围内（含自身与子孙）包里最深的 zoom
  }

  async open() {
    const h = new DataView(await rangeFetch(this.url, 0, HEADER));
    const magic = String.fromCharCode(h.getUint8(0), h.getUint8(1), h.getUint8(2), h.getUint8(3));
    if (magic !== 'XTP1') throw new Error('不是 XTP 瓦片包：' + this.url);
    const count = h.getUint32(8, true);
    this.format = h.getUint32(12, true);
    const indexOffset = Number(h.getBigUint64(16, true));
    const buf = await rangeFetch(this.url, indexOffset, indexOffset + count * ENTRY);
    const d = new DataView(buf);
    let minZ = 99, maxZ = 0;
    for (let i = 0; i < count; i++) {
      const o = i * ENTRY;
      const zx = d.getUint32(o, true);
      const z = zx >>> 24, x = zx & 0xffffff, y = d.getUint32(o + 4, true);
      const off = Number(d.getBigUint64(o + 8, true));
      const len = d.getUint32(o + 16, true);
      this.map.set(`${z}/${x}/${y}`, [off, len]);
      // 向上登记到各级祖先；祖先已记录 ≥ z 时其更上层必然也 ≥ z，可提前停止
      for (let a = z, ax = x, ay = y; a >= 0; a--, ax >>>= 1, ay >>>= 1) {
        const k = ckey(a, ax, ay), v = this.cover.get(k);
        if (v !== undefined && v >= z) break;
        this.cover.set(k, z);
      }
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    this.minZ = minZ;
    this.maxZ = maxZ;
    return this;
  }
}

export class TilePack {
  constructor(base = 'tiles/') {
    this.base = base;
    this.packs = [];
    this.maxZoom = 0;
    this.attribution = '';
  }

  /** 读取清单与各包索引；没有清单返回 null（可选数据） */
  static async load(base = 'tiles/') {
    let manifest;
    try {
      const res = await fetch(base + 'index.json', { cache: 'no-cache' });
      if (!res.ok) return null;
      manifest = await res.json();
    } catch {
      return null;
    }
    const tp = new TilePack(base);
    tp.attribution = manifest.attribution || '';
    const opened = await Promise.all(
      (manifest.packs || []).map((m) =>
        new Pack(base + m.file, m).open().catch((e) => {
          console.warn('[tilepack] 打开失败', m.file, e.message);
          return null;
        })
      )
    );
    tp.packs = opened.filter(Boolean);
    if (!tp.packs.length) return null;
    tp.maxZoom = Math.max(...tp.packs.map((p) => p.maxZ));
    // 合并各包的覆盖表（取最深）
    tp.cover = tp.packs[0].cover;
    for (const p of tp.packs.slice(1)) for (const [k, v] of p.cover) if (!(tp.cover.get(k) >= v)) tp.cover.set(k, v);
    for (const p of tp.packs) p.cover = null;
    tp.count = tp.packs.reduce((s, p) => s + p.map.size, 0);
    return tp;
  }

  /** 瓦片 (z,x,y) 范围内（含自身与子孙）包里最深的 zoom；范围内没有任何包内瓦片返回 -1 */
  coverZ(z, x, y) {
    const v = this.cover.get(ckey(z, x, y));
    return v === undefined ? -1 : v;
  }

  has(z, x, y) {
    const k = `${z}/${x}/${y}`;
    return this.packs.some((p) => p.map.has(k));
  }

  /** 返回瓦片 Blob；包里没有返回 null */
  async get(z, x, y, signal) {
    const k = `${z}/${x}/${y}`;
    for (const p of this.packs) {
      const e = p.map.get(k);
      if (!e) continue;
      const buf = await rangeFetch(p.url, e[0], e[0] + e[1], signal);
      const type = p.format === 2 ? 'image/png' : p.format === 3 ? 'image/webp' : 'image/jpeg';
      return new Blob([buf], { type });
    }
    return null;
  }
}
