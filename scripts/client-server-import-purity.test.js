/**
 * Guard: every `server/lib` module the CLIENT imports stays browser-safe.
 *
 * PortOS shares pure logic between the two runtimes by importing the server
 * leaf from the client (`client/src/lib/README.md`), not by copying it. That
 * only works while the imported module — and everything it transitively pulls —
 * reaches no Node built-in and nothing outside `server/lib`. The failure mode is
 * silent at edit time and loud at build time: adding a `crypto` import to a
 * module three edges away from `Layout.jsx` breaks `npm run build --prefix
 * client` for a reason the diff does not name.
 *
 * So this walks the real import graph from every `server/lib` module named by a
 * client import specifier and fails on the first impure edge, pointing at the
 * chain that introduced it. It scans the tracked tree, so nothing imports it and
 * CI's import-graph selection cannot reach it — it rides `ALWAYS_RUN_TESTS`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_LIB = join(REPO_ROOT, 'server', 'lib');

/**
 * True when an absolute path sits inside `server/lib`. Asked through `relative`
 * rather than a `startsWith(\`${SERVER_LIB}/\`)` prefix test, which is a
 * separator bug: `resolve` hands back backslashes on Windows, so the prefix
 * never matched there and every in-tree import read as "outside server/lib".
 */
export const withinServerLib = (target, root = SERVER_LIB) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Every `from '…'` / `import '…'` specifier in one module's source. */
const specifiersIn = (source) => [
  ...source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g),
  ...source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
].map((match) => match[1]);

/** The `server/lib/*` modules a client source file imports (specifiers only, not prose). */
export const clientImportedServerLibModules = (source) => [
  ...source.matchAll(/from\s*['"](?:\.\.\/)+server\/lib\/([\w./-]+\.js)['"]/g),
].map((match) => match[1]);

const trackedClientSources = execFileSync(
  'git',
  ['ls-files', 'client/src/*.js', 'client/src/*.jsx', 'client/src/**/*.js', 'client/src/**/*.jsx'],
  { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
).split('\n').filter(Boolean);

const entryModules = [...new Set(trackedClientSources.flatMap((rel) => (
  clientImportedServerLibModules(readFileSync(join(REPO_ROOT, rel), 'utf8'))
    .map((mod) => join(SERVER_LIB, mod))
)))];

/**
 * Walk the graph from `entries`, returning one violation per impure edge:
 * `{ chain, specifier, reason }`. A relative specifier that escapes
 * `server/lib` and any bare specifier (a Node built-in, or an npm package the
 * client bundle has no reason to be handed) both count.
 */
function impureEdges(entries) {
  const violations = [];
  const seen = new Set();
  const queue = entries.map((file) => ({ file, chain: [relative(REPO_ROOT, file)] }));
  while (queue.length) {
    const { file, chain } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) {
      violations.push({ chain, specifier: file, reason: 'module does not exist' });
      continue;
    }
    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        violations.push({ chain, specifier, reason: 'non-relative import (Node built-in or npm package)' });
        continue;
      }
      const target = resolve(dirname(file), specifier);
      if (!withinServerLib(target)) {
        violations.push({ chain, specifier, reason: 'resolves outside server/lib' });
        continue;
      }
      queue.push({ file: target, chain: [...chain, relative(REPO_ROOT, target)] });
    }
  }
  return violations;
}

describe('server/lib modules imported by the client stay pure (#6364)', () => {
  it('finds the client→server import edges to walk', () => {
    // Fails loudly if the glob or the specifier pattern stops matching, rather
    // than reporting a vacuous pass over zero entry points.
    expect(entryModules.length).toBeGreaterThan(10);
  });

  it('detects the shapes it guards, and leaves a pure leaf alone (bypass probe)', () => {
    expect(clientImportedServerLibModules("import { a } from '../../../server/lib/x.js';")).toEqual(['x.js']);
    expect(clientImportedServerLibModules("import { a } from '../../../server/lib/editorial/y.js';")).toEqual(['editorial/y.js']);
    // Prose mentioning the path is not an import.
    expect(clientImportedServerLibModules('// mirrors server/lib/x.js')).toEqual([]);
    // Containment is asked with `relative`, so it holds under both separators —
    // a prefix test on `${SERVER_LIB}/` passed on POSIX and rejected every
    // in-tree import on Windows, where `resolve` returns backslashes.
    expect(withinServerLib(join(SERVER_LIB, 'textUtils.js'))).toBe(true);
    expect(withinServerLib(join(SERVER_LIB, 'editorial', 'shotContinuity.js'))).toBe(true);
    expect(withinServerLib(join(SERVER_LIB, '..', 'services', 'auth.js'))).toBe(false);
    expect(withinServerLib(SERVER_LIB)).toBe(false);
    expect(specifiersIn("import { readFile } from 'fs';")).toEqual(['fs']);
    expect(specifiersIn("export { a } from './b.js';")).toEqual(['./b.js']);
    expect(specifiersIn("import './side-effect.js';")).toEqual(['./side-effect.js']);
    // A comment naming a module is not an import specifier.
    expect(specifiersIn('// loaded from ./b.js when needed')).toEqual([]);
  });

  it('walks every reachable module and finds no Node-only or out-of-tree import', () => {
    const violations = impureEdges(entryModules);
    expect(
      violations.map((v) => `${v.chain.join(' → ')} imports '${v.specifier}' (${v.reason})`),
      'The client imports these server/lib modules, so they must be browser-safe. Split the '
      + 'impure part into its own leaf and import the pure half from both sides — see the '
      + '"One pure module, one definition" rule in client/src/lib/README.md.',
    ).toEqual([]);
  });
});
