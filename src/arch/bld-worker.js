// 通用建筑几何 Worker：解析 buildings.bin、生成远景合批几何与按需近景小块（见 bld-gen.js）
import { createGenerator } from './bld-gen.js';

const gen = createGenerator();
self.onmessage = (e) => {
  let r;
  try {
    r = gen.handle(e.data);
  } catch (err) {
    r = { msg: { type: 'error', req: e.data && e.data.type, key: e.data && e.data.key, message: String((err && err.stack) || err) } };
  }
  self.postMessage(r.msg, r.transfer || []);
};
