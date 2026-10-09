import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readStandaloneData } from './standalone-data.mjs';
import { loadBytes, loadJSON } from '../src/core/data.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xian3d-standalone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

test('nested data retains paths and byte contents; hidden and skipped entries stay excluded', (t) => {
  const dir = fixture(t);
  write(dir, 'pois.json', '{"source":"base"}');
  write(dir, 'local/pois.json', '{"source":"local"}');
  write(dir, 'local/deeper/tile.bin', Buffer.from([0, 128, 255]));
  write(dir, 'local/skip.json', 'skip nested file');
  write(dir, 'ignored/nested.json', 'skip directory');
  write(dir, 'img_core.jpg', 'skip root file');
  write(dir, '.hidden/file.json', 'hidden directory');
  write(dir, 'local/.secret', 'hidden file');
  const { embed, total } = readStandaloneData(dir, {
    skip: new Set(['img_core.jpg', 'local/skip.json', 'ignored']),
  });
  assert.deepEqual(Object.keys(embed).sort(), ['local/deeper/tile.bin', 'local/pois.json', 'pois.json']);
  assert.deepEqual(Buffer.from(embed['local/deeper/tile.bin'], 'base64'), Buffer.from([0, 128, 255]));
  assert.equal(Buffer.from(embed['pois.json'], 'base64').toString(), '{"source":"base"}');
  assert.equal(Buffer.from(embed['local/pois.json'], 'base64').toString(), '{"source":"local"}');
  assert.equal(total, fs.statSync(path.join(dir, 'pois.json')).size
    + fs.statSync(path.join(dir, 'local/pois.json')).size + 3);
});

test('file and directory symlinks fail instead of embedding external data', (t) => {
  const outside = fixture(t);
  write(outside, 'external.json', 'must not embed');
  for (const target of ['external.json', '.']) {
    const dir = fixture(t);
    fs.symlinkSync(path.join(outside, target), path.join(dir, 'linked'));
    assert.throws(() => readStandaloneData(dir), /non-regular.*symbolic links.*linked/);
  }
});

test('offline loading uses local overrides and nested assets without a network request', async (t) => {
  const dir = fixture(t);
  write(dir, 'pois.json', '{"source":"base"}');
  write(dir, 'local/pois.json', '{"source":"local"}');
  write(dir, 'roads.json', '{"source":"base roads"}');
  write(dir, 'local/meta.json', '{"source":"not an override"}');
  write(dir, 'meta.json', '{"source":"base meta"}');
  write(dir, 'local/deeper/tile.bin', Buffer.from([0, 128, 255]));
  const savedWindow = globalThis.window;
  const savedFetch = globalThis.fetch;
  t.after(() => {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    globalThis.fetch = savedFetch;
  });
  globalThis.window = { __XIAN3D_EMBED__: readStandaloneData(dir).embed };
  globalThis.fetch = async () => { throw new Error('offline data requested the network'); };
  assert.deepEqual(await loadJSON('pois.json'), { source: 'local' });
  assert.deepEqual(await loadJSON('roads.json'), { source: 'base roads' });
  assert.deepEqual(await loadJSON('meta.json'), { source: 'base meta' });
  assert.deepEqual(await loadJSON('local/pois.json'), { source: 'local' });
  assert.deepEqual(await loadBytes('local/deeper/tile.bin'), new Uint8Array([0, 128, 255]));
});
