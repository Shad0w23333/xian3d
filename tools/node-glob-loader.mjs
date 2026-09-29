// Node 模块加载钩子：把 Vite 的 import.meta.glob([...], { eager: true, import: 'default' }) 在 Node 里展开，
// 让无浏览器的检查工具（tools/arch_env.mjs 及其使用者）也能加载 src/arch/dossier-specs/index.js 这类按目录汇总的模块。
// 只支持同目录的 './*.js' 与 '!./xxx.js' 排除写法（目前工程里只有这一种用法）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function load(url, context, next) {
  const r = await next(url, context);
  if (!url.startsWith('file:') || !url.endsWith('.js') || r.format === 'builtin') return r;
  const src = r.source == null ? fs.readFileSync(fileURLToPath(url), 'utf8') : String(r.source);
  if (!src.includes('import.meta.glob(')) return r;
  const dir = path.dirname(fileURLToPath(url));
  const out = src.replace(/import\.meta\.glob\(\s*\[([^\]]*)\]\s*,\s*\{[^}]*\}\s*\)/g, (m, pats) => {
    const list = [...pats.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    const inc = list.filter((p) => !p.startsWith('!'));
    const exc = new Set(list.filter((p) => p.startsWith('!')).map((p) => p.slice(1)));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => './' + f)
      .filter((f) => !exc.has(f) && inc.some((p) => p === f || p === './*.js')).sort();
    return `Object.fromEntries(await Promise.all(${JSON.stringify(files)}.map(async (f) => [f, (await import(new URL(f, import.meta.url))).default])))`;
  });
  return { ...r, format: 'module', source: out, shortCircuit: true };
}
