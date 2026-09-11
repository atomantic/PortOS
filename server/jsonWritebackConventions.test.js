import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scanJsonWriteback, reconcileJsonWriteback } from './test/jsonWritebackScan.js';
import { JSON_WRITEBACK_EXCEPTIONS } from './test/jsonWritebackExceptions.js';

function sourceFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(join(directory, entry.name), `${relative}/`);
    return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [relative] : [];
  });
}

// Regression: a newly introduced fallback cannot silently become a write-back
// base. Existing exceptions must disappear when their source pair disappears.
it('classifies every same-path non-strict service read/write pair with no stale exceptions', () => {
  const root = fileURLToPath(new URL('./services/', import.meta.url));
  const candidates = sourceFiles(root).flatMap(file =>
    scanJsonWriteback(readFileSync(join(root, file), 'utf8')).candidates.map(path => `${file} :: ${path}`));
  const result = reconcileJsonWriteback(candidates, JSON_WRITEBACK_EXCEPTIONS);
  expect(result, 'Use strict reads or document the actual lifecycle in test/jsonWritebackExceptions.js; remove stale entries.').toEqual({ unclassified: [], stale: [] });
  expect(new Set(JSON_WRITEBACK_EXCEPTIONS.map(entry => entry.key)).size).toBe(JSON_WRITEBACK_EXCEPTIONS.length);
  expect(JSON_WRITEBACK_EXCEPTIONS.every(entry => entry.reason.trim().length > 0)).toBe(true);
});

describe('syntax scanner regression contracts', () => {
  it('finds new pairs with nested arguments, comments and quote/whitespace differences', () => {
    const source = `
      import { readJSONFile as read, atomicWrite as write } from './fileUtils.js';
      const value = await read(join(root, nameFor(id, { suffix: '.json' })),
        defaults({ nested: [1, 2] }), { logError: false });
      await write(join( root, nameFor( id, { suffix: ".json" } )), value);
      // readJSONFile(FAKE, {}); atomicWrite(FAKE, {});
      const text = 'readJSONFile(FAKE, {}); atomicWrite(FAKE, {})';
      readJSONFile(OTHER, {}); atomicWrite(DIFFERENT, {});
    `;
    const { candidates } = scanJsonWriteback(source);
    expect(candidates).toEqual(['join ( root , nameFor ( id , { suffix : ".json" } ) )']);
    expect(scanJsonWriteback(`// shifted source\n\n${source}`).candidates).toEqual(candidates);
    expect(reconcileJsonWriteback(candidates, [])).toEqual({ unclassified: candidates, stale: [] });
    expect(reconcileJsonWriteback([], [{ key: candidates[0], reason: 'Removed cache' }])).toEqual({ unclassified: [], stale: candidates });
  });

  it('only exempts strict reads whose actual options prove strictness', () => {
    const { candidates, strict } = scanJsonWriteback(`
      readJSONFile(A, { strict: true }); atomicWrite(A, {});
      readJSONFile(B, {}, { strict: true }); atomicWrite(B, {});
      readJSONFileStrict(C, {}); atomicWrite(C, {});
      readJSONFile(D, {}, { strict: true, ...options }); atomicWrite(D, {});
      readJSONFile(E, {}, { ...options, strict: true }); atomicWrite(E, {});
      readJSONFile(F, {}, { strict: true, strict: false }); atomicWrite(F, {});
      readJSONFile(G, {}, { strict }); atomicWrite(G, {});
      readJSONFile(H, {}, { strict: true, [key]: false }); atomicWrite(H, {});
      readJSONFile(I, {}, { strict: false, 'strict': true }); atomicWrite(I, {});
      readJSONFile(J, {}, { nested: { strict: true } }); atomicWrite(J, {});
      readJSONFile(K, {}, { strict: true }); readJSONFile(K, {}); atomicWrite(K, {});
    `);
    expect(candidates).toEqual(['A', 'D', 'F', 'G', 'H', 'J', 'K']);
    expect(strict).toEqual(['B', 'C', 'E', 'I', 'K']);
  });

  it('keeps literal contents and dynamic template expressions distinct and fails on invalid syntax', () => {
    expect(scanJsonWriteback('readJSONFile("a b", {}); atomicWrite("ab", {});').candidates).toEqual([]);
    expect(scanJsonWriteback('readJSONFile(`row-${id}`, {}); atomicWrite(`row-${other}`, {});').candidates).toEqual([]);
    expect(() => scanJsonWriteback('readJSONFile(')).toThrow();
  });
});
