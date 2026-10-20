import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scanJsonWriteback, reconcileJsonWriteback, mayReadJsonFile } from './test/jsonWritebackScan.js';
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
  const candidates = sourceFiles(root).flatMap(file => {
    const source = readFileSync(join(root, file), 'utf8');
    if (!mayReadJsonFile(source)) return [];
    return scanJsonWriteback(source).candidates.map(path => `${file} :: ${path}`);
  });
  const result = reconcileJsonWriteback(candidates, JSON_WRITEBACK_EXCEPTIONS);
  expect(result, 'Use strict reads or document the actual lifecycle in test/jsonWritebackExceptions.js; remove stale entries.').toEqual({ unclassified: [], stale: [] });
  expect(new Set(JSON_WRITEBACK_EXCEPTIONS.map(entry => entry.key)).size).toBe(JSON_WRITEBACK_EXCEPTIONS.length);
  expect(JSON_WRITEBACK_EXCEPTIONS.every(entry => entry.reason.trim().length > 0)).toBe(true);
}, 15_000);

describe('syntax scanner regression contracts', () => {
  it('skips only sources that cannot reference a JSON read helper', () => {
    expect(mayReadJsonFile('atomicWrite(A, {});')).toBe(false);
    const sources = [
      "import { readJSONFile as read } from './fileUtils.js'; read(A, {}); atomicWrite(A, {});",
      "import { readJSONFileStrict as read } from './fileUtils.js'; read(A, {}); atomicWrite(A, {});",
      String.raw`import { readJSON\u0046ile as read } from './fileUtils.js'; read(A, {}); atomicWrite(A, {});`,
    ];
    for (const source of sources) {
      expect(mayReadJsonFile(source)).toBe(true);
      expect(scanJsonWriteback(source)).toEqual(source.includes('Strict')
        ? { candidates: [], strict: ['A'] } : { candidates: ['A'], strict: [] });
    }
    // The standalone scanner must still parse irrelevant modules and reject
    // invalid syntax; the optimization belongs solely at the tree caller.
    expect(() => scanJsonWriteback('const =')).toThrow();
  });
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

  it('treats a raw read whose bytes reach safeJSONParse as a non-strict read (#12440)', () => {
    const source = `
      import { tryReadFile as slurp, atomicWrite } from './fileUtils.js';
      async function loadA() { const raw = await tryReadFile(A); return safeJSONParse(raw ?? '{}', {}); }
      async function loadB() { return safeJSONParse(await readFile(B, 'utf-8'), {}); }
      async function loadC() { const raw = await slurp(C).catch(() => null); return safeJSONParse(raw, null); }
      async function loadD() { const { ok, value } = await tryReadFileStrict(D); return ok ? safeJSONParse(value, null) : null; }
      async function loadE() { const text = await readFile(E, 'utf-8'); return text.split('\\n'); }
      async function loadF() { const raw = await tryReadFile(F); return helper(() => safeJSONParse(raw, null)); }
      function unrelated() { const raw = 1; return safeJSONParse(raw, null); }
      async function loadG() { const raw = await tryReadFile(G); return raw; }
      async function loadH() { const raw = await tryReadFile(H); return [raw].map(function (raw) { return safeJSONParse(raw, null); }); }
      async function loadJ() { const raw = await tryReadFile(J); { const raw = ''; } return safeJSONParse(raw, null); }
      function parseK() { return safeJSONParse(raw, null); }
      const raw = await tryReadFile(K);
      async function loadL() { const raw = await tryReadFile(L); return safeJSONParse(other.raw, null); }
      async function loadI() { const raw = await tryReadFile(I); return [1].map((raw) => safeJSONParse(raw, null)); }
      await atomicWrite(A, 1); await atomicWrite(B, 1); await atomicWrite(C, 1); await atomicWrite(D, 1);
      await atomicWrite(E, 1); await atomicWrite(F, 1); await atomicWrite(G, 1);
      await atomicWrite(H, 1); await atomicWrite(I, 1); await atomicWrite(J, 1);
      await atomicWrite(K, 1); await atomicWrite(L, 1);
    `;
    // A: variable, B: inline, C: aliased import, F: closure, J: an inner block's
    // `raw` ends with the block, K: a closure declared before the binding it captures. D is a strict read,
    // E, G and L (a `.raw` property) never reach a parse, and neither unrelated()'s `raw`
    // nor a shadowing parameter (H, I) borrows the outer binding.
    expect(scanJsonWriteback(source)).toEqual({ candidates: ['A', 'B', 'C', 'F', 'J', 'K'], strict: [] });
    expect(mayReadJsonFile('tryReadFile(P); safeJSONParse(raw, {});')).toBe(true);
    expect(scanJsonWriteback("const raw = await tryReadFile(P); safeJSONParse(raw, {}); atomicWrite(P, {});").candidates).toEqual(['P']);
  });

  it('keeps literal contents and dynamic template expressions distinct and fails on invalid syntax', () => {
    expect(scanJsonWriteback('readJSONFile("a b", {}); atomicWrite("ab", {});').candidates).toEqual([]);
    expect(scanJsonWriteback('readJSONFile(`row-${id}`, {}); atomicWrite(`row-${other}`, {});').candidates).toEqual([]);
    expect(() => scanJsonWriteback('readJSONFile(')).toThrow();
  });
});
