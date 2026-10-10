import fs from 'node:fs';
import path from 'node:path';

// Keep keys relative to public/data so nested files use the same names as fetch.
export function readStandaloneData(dataDir, { skip = new Set(), onFile = () => {} } = {}) {
  if (!fs.lstatSync(dataDir).isDirectory()) throw new Error(`Not a data directory: ${dataDir}`);
  const embed = Object.create(null);
  let total = 0;
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const key = prefix + name;
      if (name.startsWith('.') || skip.has(key)) continue;
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        visit(file, key + '/');
      } else if (stat.isFile()) {
        const buf = fs.readFileSync(file);
        embed[key] = buf.toString('base64');
        total += buf.length;
        onFile(key, buf.length);
      } else {
        throw new Error(`Cannot embed non-regular data entry (including symbolic links): ${key}`);
      }
    }
  }
  visit(dataDir);
  return { embed, total };
}
