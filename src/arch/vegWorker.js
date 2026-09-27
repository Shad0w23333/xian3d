// 城市植被种植 Worker：在后台线程生成全部树木/绿篱位置（见 vegPlant.js）
import { plantVegetation, transferList } from './vegPlant.js';

self.onmessage = (e) => {
  try {
    const r = plantVegetation(e.data);
    self.postMessage({ ok: true, r }, transferList(r));
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
};
