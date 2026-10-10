// 小区草坪纯计算的 Worker 池：genChunk 把一个块里各小区的 125 m 小方块提交进来（可提前预取后面排队的块），
// Worker 算出出图指令，主线程轮到该小方块时回放（compound-gen.js replayLawns）。结果与主线程直接算逐位相同；
// Worker 不可用或出错时 genChunk 退回主线程计算。
import LawnWorker from './compound-worker.js?worker&inline';
import { packBoxGrid } from './compound-plan.js';

const SUB = 125; // 与 compound-gen.js genCompound 的草坪小方块一致
const INFLIGHT = 2; // 每个 Worker 同时在算的小方块数上限（其余在主线程排队，可撤销）
// 草坪纯计算用到的小区字段（compound-gen.js lawnOps）
const FIELDS = ['id', 'pid', 'mode', 'cs', 'sn', 'ox', 'oz', 'U0', 'U1', 'V0', 'V1', 'rf', 'holes', 'bb', 'lanes', 'parks', 'paths', 'aprons', 'pads', 'osmSlots', 'fields', 'ring', 'gates'];

/** 小区 c 在块 [x0,x1)×[z0,z1) 内要算的草坪小方块左下角（顺序与 genCompound 相同） */
export function lawnSubs(c, x0, z0, x1, z1) {
  const out = [];
  for (let sx = x0; sx < x1; sx += SUB)
    for (let sz = z0; sz < z1; sz += SUB) {
      if (sx + SUB < c.bb[0] || sx > c.bb[2] || sz + SUB < c.bb[1] || sz > c.bb[3]) continue;
      out.push(sx, sz);
    }
  return out;
}

/** 让建筑的排除区（与 Exclusions.test(x, z, 'buildings') 的筛选一致，h = 0） */
function exList(EX) {
  const out = [];
  for (const it of EX.items) if (it.flags.buildings && !(it.flags.maxHeight != null && 0 > it.flags.maxHeight)) out.push({ p: it.p, bb: it.bb });
  return out;
}

export class LawnPool {
  /** S：compounds 共享状态（index 等）；EX：ctx.exclusions；n：Worker 数 */
  static create(S, EX, n = 2) {
    if (typeof Worker === 'undefined' || !EX || !EX.items) return null;
    const I = S.index;
    if (!I || !I.B || !I.bgrid || !I.rgrid || !I.rsegs) return null;
    let pool = null;
    try {
      pool = new LawnPool(S, EX, n);
    } catch (e) {
      console.warn('[compounds] 草坪 Worker 启动失败，改在主线程计算', e && e.message);
      if (pool) pool.dispose();
      return null;
    }
    return pool;
  }

  constructor(S, EX, n) {
    this.S = S;
    this.EX = EX;
    this.broken = false;
    this.seq = 0;
    this.pending = []; // 未派出的小方块
    this.chunks = new Map(); // 块键 → Map(小区 → 小方块句柄数组)
    this.ws = [];
    const I = S.index, B = I.B;
    const rs = new Float64Array(I.rsegs.length * 8);
    for (let i = 0; i < I.rsegs.length; i++) {
      const r = I.rsegs[i];
      for (let k = 0; k < 8; k++) rs[i * 8 + k] = r[k];
    }
    const init = {
      t: 'init',
      B: { ax: B.ax, az: B.az, vs: B.vs, vc: B.vc, hd: B.hd, offs: B.offs },
      bgrid: packBoxGrid(I.bgrid),
      rgrid: packBoxGrid(I.rgrid),
      rsegs: rs,
      sports: (I.sports || []).map((f) => ({ p: f.p })),
      ex: exList(EX),
    };
    this.exN = EX.items.length;
    for (let i = 0; i < n; i++) {
      const w = new LawnWorker();
      const st = { w, busy: new Map(), has: new Set() };
      w.onmessage = (e) => this._done(st, e.data);
      w.onerror = (e) => this._fail(st, (e && e.message) || 'worker error');
      w.postMessage(init);
      this.ws.push(st);
    }
  }

  _fail(st, msg) {
    if (!this.broken) console.warn('[compounds] 草坪 Worker 出错，改在主线程计算', msg);
    this.broken = true;
    for (const h of st.busy.values()) { h.err = msg; h.done = true; }
    st.busy.clear();
    for (const h of this.pending) { h.err = msg; h.done = true; }
    this.pending.length = 0;
  }

  _done(st, m) {
    const h = st.busy.get(m.id);
    if (!h) return;
    st.busy.delete(m.id);
    if (m.err) {
      h.err = m.err;
      console.warn('[compounds] 草坪 Worker 计算失败，该小方块改在主线程计算', m.err);
    } else h.ops = m.ops;
    h.done = true;
    this._pump();
  }

  _pump() {
    if (this.broken) return;
    // 排除区有新增（很少见）：先把新表发给各 Worker（同一 Worker 的消息按序处理，排在之后的任务都用新表）
    if (this.EX.items.length !== this.exN) {
      this.exN = this.EX.items.length;
      const ex = exList(this.EX);
      for (const st of this.ws) st.w.postMessage({ t: 'ex', ex });
    }
    while (this.pending.length) {
      let best = null;
      for (const st of this.ws) if (st.busy.size < INFLIGHT && (!best || st.busy.size < best.busy.size)) best = st;
      if (!best) return;
      const h = this.pending.shift();
      if (h.cancelled) continue;
      const c = h.c;
      const msg = { t: 'job', id: h.id, cid: c.id, x0: h.x0, z0: h.z0, x1: h.x0 + SUB, z1: h.z0 + SUB };
      if (!best.has.has(c.id)) {
        const p = {};
        for (const k of FIELDS) p[k] = c[k];
        msg.c = p;
        best.has.add(c.id);
      }
      best.busy.set(h.id, h);
      best.w.postMessage(msg);
    }
  }

  /** 块 (ci,cj) 各小区的草坪小方块句柄（Map：小区 → 句柄数组，顺序同 lawnSubs）；没提交过就现在提交 */
  forChunk(ci, cj, x0, z0, x1, z1) {
    const key = ci + ',' + cj;
    let m = this.chunks.get(key);
    if (m) return m;
    m = new Map();
    const S = this.S;
    for (const id of S.chunkMap.get(key) || []) {
      const c = S.list[id];
      if (m.has(c)) continue;
      const subs = lawnSubs(c, x0, z0, x1, z1), hs = [];
      for (let q = 0; q < subs.length; q += 2) {
        const h = { id: ++this.seq, c, x0: subs[q], z0: subs[q + 1], done: false, ops: null, err: null, cancelled: false };
        if (this.broken) { h.err = 'pool broken'; h.done = true; }
        else this.pending.push(h);
        hs.push(h);
      }
      m.set(c, hs);
    }
    this.chunks.set(key, m);
    this._pump();
    return m;
  }

  /** 取走块的句柄（genChunk 开始生成该块时调用；之后不再缓存） */
  take(ci, cj, x0, z0, x1, z1) {
    const m = this.forChunk(ci, cj, x0, z0, x1, z1);
    this.chunks.delete(ci + ',' + cj);
    return m;
  }

  /** 只保留 keep 里的预取块，其余未派出的小方块撤销 */
  retain(keep) {
    for (const [key, m] of this.chunks) {
      if (keep.has(key)) continue;
      for (const hs of m.values()) for (const h of hs) h.cancelled = true;
      this.chunks.delete(key);
    }
    if (this.pending.some((h) => h.cancelled)) this.pending = this.pending.filter((h) => !h.cancelled);
  }

  dispose() {
    for (const st of this.ws) st.w.terminate();
    this.ws.length = 0;
    this.pending.length = 0;
    this.chunks.clear();
    this.broken = true;
  }
}
