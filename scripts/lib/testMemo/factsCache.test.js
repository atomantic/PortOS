/**
 * The persistent facts cache (#17617): a warm analyzer reuses parsed file
 * facts only when extraction would return exactly the same, so every key is
 * identical with and without it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { staticEdges } from '../sourceTokens.js';
import { mergeMemoStore } from '../testMemoStore.js';
import { computeTestMemoKeys } from '../testMemo.js';
import { tokenizeModule, matchBrackets } from './tokens.js';
import { FACTS_CODE, createFactsCache, encodeExact, factsCodeVersion, loadFactsCache, saveFactsCache } from './factsCache.js';

const REPO = join(import.meta.dirname, '..', '..', '..');

function memoryFs(files) {
  const names = Object.keys(files);
  return {
    read: (rel) => (rel in files ? Buffer.from(files[rel]) : null),
    kind: (rel) => (rel in files ? 'file' : rel === '' || names.some((name) => name.startsWith(`${rel}/`)) ? 'dir' : null),
    list: (rel) => [...new Set(names.filter((name) => rel === '' || name.startsWith(`${rel}/`))
      .map((name) => name.slice(rel === '' ? 0 : rel.length + 1).split('/')[0]))],
  };
}

const TREE = {
  'server/vitest.config.js': 'export default {};\n',
  'server/vitest.setup.js': 'export const setup = true;\n',
  'scripts/vitestCiPool.js': 'export const vitestCiPool = () => ({});\n',
  'server/package.json': '{"name":"server"}',
  'server/package-lock.json': '{}',
  'server/node_modules/vitest/package.json': '{"name":"vitest","version":"5.0.4"}',
  'server/lib/names.js': "export const FIXTURE = 'a.txt';\n",
  'server/lib/a.txt': 'a\n',
  'server/lib/b.txt': 'b\n',
  'server/lib/lazy.js': 'export const lazy = 1;\n',
  'server/lib/reader.test.js': [
    "import { it } from 'vitest';",
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { FIXTURE } from './names.js';",
    "const load = () => import('./lazy.js');",
    'const text = readFileSync(join(__dirname, FIXTURE), \'utf8\');',
    "it('reads', () => {});",
  ].join('\n'),
};
const TEST = 'server/lib/reader.test.js';
const keysOf = (files, factsCache = null) => {
  const info = computeTestMemoKeys([TEST], { fs: memoryFs(files), workspace: 'server', env: {}, platform: 'linux', arch: 'x64', nodeVersion: '24.1.0', factsCache }).get(TEST);
  return { floor: info.floor.key, inputs: [...info.inputs].sort(), closure: [...info.closure].sort() };
};
/** A cache as the next run would load it: through its saved form. */
const reloaded = (cache) => createFactsCache({ entries: JSON.parse(JSON.stringify(cache.toJSON())).entries, version: cache.version });

describe('test memo facts cache', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('names the whole static import closure of the extraction code', () => {
    const closure = new Set();
    const pending = ['scripts/lib/testMemo/fileFacts.js'];
    while (pending.length) {
      const rel = pending.pop();
      if (closure.has(rel)) continue;
      closure.add(rel);
      const tokens = tokenizeModule(readFileSync(join(REPO, rel), 'utf8'), rel);
      for (const spec of staticEdges(tokens, matchBrackets(tokens))) {
        if (spec.startsWith('.')) pending.push(posix.normalize(posix.join(posix.dirname(rel), spec)));
      }
    }
    expect([...closure].sort()).toEqual([...FACTS_CODE].sort());
    expect(factsCodeVersion()).toMatch(/^[0-9a-f]{64}$/);
    // Any byte of the extraction code moves the version.
    const real = (rel) => readFileSync(join(REPO, rel));
    expect(factsCodeVersion((rel) => (rel === FACTS_CODE[0] ? Buffer.concat([real(rel), Buffer.from('\n')]) : real(rel)))).not.toBe(factsCodeVersion(real));
    expect(factsCodeVersion(() => { throw new Error('unreadable'); })).toBeNull();
  });

  it('round-trips only what decodes to exactly the same value', () => {
    for (const value of [new Set(['a']), new Map([['k', new Set([1])]]), /x\/y/gi, { $set: 'literal key' }, { nested: [{ a: null, b: false }] }, null, 'text']) {
      expect(encodeExact(value)).not.toBeUndefined();
    }
    for (const value of [{ a: undefined }, [undefined], Number.NaN, () => 1, new Date(0), Object.create({ inherited: 1 })]) {
      expect(encodeExact(value)).toBeUndefined();
    }
  });

  it('gives the keys extraction gives, cold and warm, and reuses every parsed file', () => {
    const plain = keysOf(TREE);
    const cold = createFactsCache({ version: 'v1' });
    expect(keysOf(TREE, cold)).toEqual(plain);
    expect(cold.stats().hits).toBe(0);
    const parsed = cold.stats().misses;
    expect(parsed).toBeGreaterThan(3);
    const warm = reloaded(cold);
    expect(keysOf(TREE, warm)).toEqual(plain);
    expect(warm.stats()).toMatchObject({ hits: parsed, misses: 0 });
    expect(plain.inputs).toContain('server/lib/a.txt');
  });

  it('re-extracts a file whose bytes, or a constant it imported, changed', () => {
    const warm = createFactsCache({ version: 'v1' });
    keysOf(TREE, warm);
    // The test file is byte-identical, but the constant it reads through changed:
    // the recorded lookup answers differently, so its facts are extracted again.
    const renamed = { ...TREE, 'server/lib/names.js': "export const FIXTURE = 'b.txt';\n" };
    const again = reloaded(warm);
    const changed = keysOf(renamed, again);
    expect(changed).toEqual(keysOf(renamed));
    expect(changed.inputs).toContain('server/lib/b.txt');
    expect(changed.inputs).not.toContain('server/lib/a.txt');
    // names.js (new bytes) and the reader (a changed lookup) miss; the rest is reused.
    expect(again.stats().misses).toBe(2);

    const edited = { ...TREE, [TEST]: `${TREE[TEST]}\n// edited\n` };
    const third = reloaded(warm);
    expect(keysOf(edited, third)).toEqual(keysOf(edited));
    expect(third.stats().misses).toBe(1);

    // Another extraction code version reuses nothing; a null version disables the cache.
    const other = createFactsCache({ entries: warm.toJSON().entries, version: 'v2' });
    keysOf(TREE, other);
    expect(other.stats().hits).toBe(0);
    const off = createFactsCache({ version: null });
    expect(keysOf(TREE, off)).toEqual(keysOf(TREE));
    expect(off.stats()).toEqual({ hits: 0, misses: 0, entries: 0 });
  });

  it('persists per workspace, reads the first directory with the current version, ages out unused entries, and merges into a store without one', () => {
    dir = mkdtempSync(join(tmpdir(), 'portos-facts-cache-'));
    const [first, second, merged] = ['first', 'second', 'merged'].map((name) => join(dir, name));
    const now = Date.parse('2026-11-23T12:00:00.000Z');
    const cache = createFactsCache({ version: 'v1', now });
    keysOf(TREE, cache);
    expect(saveFactsCache(second, 'server', cache)).toBe(true);
    expect(saveFactsCache(first, 'server', createFactsCache({ version: 'v0', now }))).toBe(true);
    // `first` holds another version, so the read falls through to `second`.
    const loaded = loadFactsCache([first, second], 'server', { version: 'v1', now });
    expect(keysOf(TREE, loaded)).toEqual(keysOf(TREE));
    expect(loaded.stats().misses).toBe(0);
    expect(loadFactsCache([first, second], 'client', { version: 'v1', now }).toJSON().entries).toEqual({});
    expect(saveFactsCache(null, 'server', cache)).toBe(false);

    // An entry no run used within the age limit is dropped on the next save.
    const later = loadFactsCache(second, 'server', { version: 'v1', now: now + 15 * 24 * 60 * 60 * 1000 });
    expect(Object.keys(later.toJSON().entries)).toEqual([]);
    const soon = loadFactsCache(second, 'server', { version: 'v1', now: now + 60_000 });
    expect(Object.keys(soon.toJSON().entries)).toHaveLength(cache.stats().entries);

    // A trusted run's merged store starts from a lineage's facts.
    mergeMemoStore(merged, second);
    expect(loadFactsCache(merged, 'server', { version: 'v1', now }).toJSON().entries).toEqual(cache.toJSON().entries);
  });
});
