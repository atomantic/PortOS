/**
 * Conventions for NEW migrations — files numbered at or above `GUARDED_FROM`.
 * Applied migrations are frozen (other installs have already run them), so
 * everything below that number is left exactly as shipped, duplicated helpers
 * and all; the guard only stops the next migration from repeating the shape.
 *
 * Rules:
 *
 *   1. No local copy of a `_lib.js` helper (#12050). `readJson` was declared
 *      35 times, `applyToLayout` 9, `pickGridEntry` 6, `rectsOverlap` /
 *      `collidesWith` 5 each before `_lib.js` exported them. A declaration
 *      whose name matches a `_lib.js` export — or one of the local spellings
 *      in `LOCAL_ALIASES` — must import the export instead.
 *
 *   2. No import from `server/services` (#12049). A migration is a frozen
 *      snapshot of a transform: an install upgrading across many versions runs
 *      it months later, and a transform that calls into live service code
 *      then does whatever today's service does, not what the migration did
 *      when it shipped. Seventy-odd applied migrations import services and
 *      stay as they are; a new one uses `_lib.js` primitives, `server/lib`
 *      pure helpers, or a frozen copy of the transform.
 *
 *   3. The purge marker stays statically visible. `run-migrations.js` reads
 *      `purge: true` from source text (`sourceDeclaresPurge`) so a fresh
 *      install's first boot does not import every pending module up front;
 *      every shipped migration's module must agree with that probe.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as lib from './_lib.js';
import { sourceDeclaresPurge } from '../run-migrations.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');

// First migration number the conventions apply to. Raise it only when a
// migration below it is retired from the tree — never to exempt a new one.
export const GUARDED_FROM = 429;

const LIB_EXPORTS = new Set(Object.keys(lib));

// Local names applied migrations used for a helper `_lib.js` now exports
// under another name.
const LOCAL_ALIASES = {
  readJson: 'readJsonOrNull',
  readJsonFile: 'readJsonOrNull',
  readJsonSafe: 'readJsonOrNull',
  writeJson: 'writeJsonAtomic',
  writeJsonFile: 'writeJsonAtomic',
  atomicWriteJson: 'writeJsonAtomic',
  writeText: 'writeTextAtomic',
  writeAtomic: 'writeTextAtomic',
};

const DECLARATION = /^\s*(?:export\s+)?(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** `{ name, use }` for every top-level or nested declaration that shadows a `_lib.js` helper. */
const redeclaredLibHelpers = (source) => [...stripComments(source).matchAll(DECLARATION)]
  .map(([, name]) => name)
  .filter((name) => LIB_EXPORTS.has(name) || name in LOCAL_ALIASES)
  .map((name) => ({ name, use: LOCAL_ALIASES[name] ?? name }));

// Static `from '…/server/services/…'` and dynamic `import('…/server/services/…')`.
const SERVICE_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*)['"][^'"]*\/server\/services\//;

const importsServerServices = (source) => SERVICE_IMPORT.test(stripComments(source));

const migrationNumber = (file) => Number.parseInt(file.slice(0, 3), 10);

const migrationFiles = () => readdirSync(HERE)
  .filter((file) => /^\d{3}-.*\.js$/.test(file) && !file.endsWith('.test.js'))
  .sort();

const guardedSources = () => migrationFiles()
  .filter((file) => migrationNumber(file) >= GUARDED_FROM)
  .map((file) => [file, readFileSync(resolve(HERE, file), 'utf8')]);

describe('new-migration conventions', () => {
  it('starts guarding no later than the next migration number', () => {
    const head = Math.max(...migrationFiles().map(migrationNumber));
    expect(GUARDED_FROM).toBeLessThanOrEqual(head + 1);
  });

  it('no guarded migration declares its own copy of a _lib.js helper', () => {
    const offenders = guardedSources()
      .flatMap(([file, source]) => redeclaredLibHelpers(source).map(({ name, use }) => `${file}: ${name} — import ${use} from ./_lib.js`));
    expect(offenders).toEqual([]);
  });

  it('no guarded migration imports from server/services', () => {
    const offenders = guardedSources()
      .filter(([, source]) => importsServerServices(source))
      .map(([file]) => `${file}: imports server/services — use _lib.js, server/lib, or a frozen copy of the transform`);
    expect(offenders).toEqual([]);
  });

  it('every shipped migration agrees with the static purge probe', async () => {
    // Only modules that mention purge at all can disagree; importing those
    // few keeps the drift check cheap while still covering every purge
    // migration and every near-miss spelling.
    const candidates = migrationFiles()
      .map((file) => [file, readFileSync(resolve(HERE, file), 'utf8')])
      .filter(([, source]) => /purge/i.test(source));
    expect(candidates.length).toBeGreaterThan(0);
    for (const [file, source] of candidates) {
      const mod = await import(pathToFileURL(resolve(HERE, file)).href);
      const migration = mod?.default && typeof mod.default.up === 'function' ? mod.default : mod;
      expect({ file, purge: sourceDeclaresPurge(source) }).toEqual({ file, purge: migration?.purge === true });
    }
  });

  describe('service import matching', () => {
    it('flags static and dynamic imports from server/services', () => {
      expect(importsServerServices("import { listUniverses } from '../../server/services/universeBuilder.js';")).toBe(true);
      expect(importsServerServices("const { x } = await import('../../server/services/universeCanon.js');")).toBe(true);
    });

    it('passes _lib.js, server/lib and a comment that only mentions the path', () => {
      const source = [
        "import { readJsonOrNull } from './_lib.js';",
        "import { atomicWrite } from '../../server/lib/fileUtils.js';",
        '// a frozen copy of server/services/universeCanon.js#backfill, not an import',
      ].join('\n');
      expect(importsServerServices(source)).toBe(false);
    });
  });

  describe('helper redeclaration matching', () => {
    it('flags the local readJson spelling and points at readJsonOrNull', () => {
      const source = [
        "import { readFile } from 'fs/promises';",
        'async function readJson(path) {',
        "  const raw = await readFile(path, 'utf-8').catch(() => null);",
        '  return raw == null ? null : JSON.parse(raw);',
        '}',
      ].join('\n');
      expect(redeclaredLibHelpers(source)).toEqual([{ name: 'readJson', use: 'readJsonOrNull' }]);
    });

    it('flags dashboard-grid helpers whichever declaration form they take', () => {
      const source = [
        'const rectsOverlap = (a, b) => a.x < b.x + b.w;',
        'export function collidesWith(grid, candidate) { return false; }',
        'function pickGridEntry(grid, widgetId, slot) { return slot; }',
        'function applyToLayout(layout) { return false; }',
      ].join('\n');
      expect(redeclaredLibHelpers(source).map(({ name }) => name))
        .toEqual(['rectsOverlap', 'collidesWith', 'pickGridEntry', 'applyToLayout']);
    });

    it('passes a migration that imports the helpers and declares only its own data', () => {
      const source = [
        "import { readJsonOrNull, writeJsonAtomic, applyToLayout } from './_lib.js';",
        "const SEEDS = [{ widgetId: 'example', cell: { w: 4, h: 4 } }];",
        '// a local readJson would be flagged here',
        'export default { async up({ rootDir }) { const doc = await readJsonOrNull(rootDir); return doc; } };',
      ].join('\n');
      expect(redeclaredLibHelpers(source)).toEqual([]);
    });
  });
});
