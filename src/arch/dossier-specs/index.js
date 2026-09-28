// 逐栋档案 spec 汇总：本目录下每个 <片区>.js 文件 export default 一个 spec 数组，这里自动收集（Vite import.meta.glob），
// 新增片区文件不用改本文件（多个代理并行写不同片区时不会互相冲突）。
// 同一 id 出现多次时以文件名排序靠后的为准，并在控制台警告。字段说明见 docs/DOSSIER_KIT.md。
const MODS = import.meta.glob(['./*.js', '!./index.js'], { eager: true, import: 'default' });

export const DOSSIER_SPECS = (() => {
  const byId = new Map();
  for (const file of Object.keys(MODS).sort()) {
    const list = MODS[file];
    if (!Array.isArray(list)) {
      console.warn('[dossier] 忽略', file, '：export default 不是数组');
      continue;
    }
    for (const s of list) {
      if (!s || !s.id) {
        console.warn('[dossier] 忽略缺 id 的 spec', file, s?.name);
        continue;
      }
      if (byId.has(s.id)) console.warn('[dossier] spec id 重复，后者覆盖前者：', s.id, file);
      byId.set(s.id, { ...s, file: file.slice(2) });
    }
  }
  return [...byId.values()];
})();
