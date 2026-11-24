/**
 * Coverage guard for the Data Manager's CATEGORIES map (issue #3285).
 *
 * An unclassified `data/` directory doesn't merely render as "Unknown category"
 * — `categoryMeta()` also falls back to `archivable: false, deletable: false`,
 * so the row loses its Archive/Purge affordances entirely. That is how the
 * single largest directory on disk ended up being the one thing the cleanup
 * page refused to act on.
 *
 * This test enumerates the top-level `data/` directories the codebase can
 * create and fails when one of them has no CATEGORIES entry. Discovery is
 * derived, never hand-maintained, so a new data dir can't regress silently:
 *
 *   1. `PATHS` in lib/fileUtils.js — every value under `PATHS.data`.
 *   2. `DEFAULT_EXCLUDES` in services/backup/excludes.js (re-exported by services/backup.js) — anchored rsync filter paths.
 *   3. Source scan of server/ + scripts/ for the ways a data dir is spelled
 *      outside PATHS: `dataPath('name')`, `join(PATHS.data, 'name')`,
 *      `` `${PATHS.data}/name` ``, `join(root, 'data', 'name')`, and the
 *      collection-store idiom `join(PATHS.data, TYPE)` with a const name.
 *   4. `data.reference/` — dirs seeded into `data/` on first install.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join, relative, sep } from 'path';
import { PATHS } from '../../../lib/fileUtils.js';
import { DEFAULT_EXCLUDES } from '../../../services/backup.js';
import { CATEGORIES } from '../../../services/dataManager.js';
import { readText } from '../../../../scripts/lib/guardCorpus.js';

// A path segment that is a file, not a directory (`settings.json`, `TASKS.md`).
const isFileSegment = (segment) => segment.includes('.');

// Every spelling of "a path under data/" that appears in the codebase. Missing
// one means a whole family of directories escapes the guard — `dataPath('x')`
// was the gap that let `data/spotify` and `data/youtube` slip through.
const DATA_DIR_PATTERNS = [
  /\bdataPath\(\s*'([a-z0-9._-]+)'/g,
  /PATHS\.data,\s*'([a-z0-9._-]+)'/g,
  /\$\{PATHS\.data\}\/([a-z0-9._-]+)/g,
  /\b(?:join|resolve)\(\s*[^,;]+,\s*'data',\s*'([a-z0-9._-]+)'/g
];

// `join(PATHS.data, TYPE)` — the collection-store idiom, where the directory
// name is a module constant rather than an inline literal. Capture the
// identifier, then resolve it against its declaration in the same file.
const INDIRECT_DATA_DIR_PATTERN = /PATHS\.data,\s*([A-Z][A-Z0-9_]*)\s*\)/g;

function resolveConstant(source, identifier) {
  const declaration = new RegExp(`\\bconst\\s+${identifier}\\s*=\\s*'([a-z0-9._-]+)'`);
  return source.match(declaration)?.[1] ?? null;
}

// Parallel test workers create and delete temp dirs under server/test/fixtures
// while this walk runs, so a directory listed a moment ago may be gone (ENOENT).
function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function walkJsFiles(dir, out = []) {
  for (const entry of listDir(dir)) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, out);
    else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

/** @returns {Map<string, string>} data dir name → where it was discovered */
function discoverDataDirs() {
  const found = new Map();
  const add = (name, source) => {
    if (!name || isFileSegment(name) || found.has(name)) return;
    found.set(name, source);
  };

  const dataRoot = PATHS.data + sep;
  for (const [key, value] of Object.entries(PATHS)) {
    if (typeof value !== 'string' || !value.startsWith(dataRoot)) continue;
    add(value.slice(dataRoot.length).split(sep)[0], `PATHS.${key}`);
  }

  for (const { path } of DEFAULT_EXCLUDES) {
    add(path.replace(/^\//, '').split('/')[0], 'backup.js DEFAULT_EXCLUDES');
  }

  for (const dir of ['server', 'scripts']) {
    for (const file of walkJsFiles(join(PATHS.root, dir))) {
      const source = readText(file);
      for (const pattern of DATA_DIR_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          add(match[1], relative(PATHS.root, file));
        }
      }
      for (const match of source.matchAll(INDIRECT_DATA_DIR_PATTERN)) {
        add(resolveConstant(source, match[1]), relative(PATHS.root, file));
      }
    }
  }

  for (const entry of readdirSync(join(PATHS.root, 'data.reference'), { withFileTypes: true })) {
    if (entry.isDirectory()) add(entry.name, 'data.reference/');
  }

  return found;
}

describe('dataManager CATEGORIES coverage (#3285)', () => {
  it('discovers literal data paths without treating domain-name arrays as paths', () => {
    const source = `
      const a = join(rootDir, 'data', 'example-one');
      const b = path.resolve(
        tmpdir(),
        'data', 'example-two'
      );
      const districts = ['agents', 'data', 'federation'];
    `;
    expect(DATA_DIR_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1])))
      .toEqual(['example-one', 'example-two']);
  });

  it('classifies every top-level data/ directory the codebase can create', () => {
    const discovered = discoverDataDirs();
    expect(discovered.size).toBeGreaterThan(20); // discovery itself must not silently break

    const unclassified = [...discovered]
      .filter(([name]) => !CATEGORIES[name])
      .map(([name, source]) => `${name} (from ${source})`);

    expect(unclassified, 'Add a CATEGORIES entry in server/services/dataManager.js for each of these').toEqual([]);
  });
});
