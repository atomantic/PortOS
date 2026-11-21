/**
 * The repository's one JS module graph for test selection: specifier extraction, relative resolution and closures.
 *
 * `scripts/ci-test-plan.js` (DB, browser, client and gated-job closures plus
 * the dynamic-aware reach report in `importReach.js`) and `scripts/pregate.js`
 * (`referrersOf`) both read edges from here, so a specifier shape or resolver
 * fix cannot land in only one selector (#16998).
 *
 * - Extraction is the tokenizer in `sourceTokens.js`: comments, quoted
 *   fixtures and template text cannot fake an edge, and two declarations on
 *   one line are both found (a line-anchored regex saw only the first).
 * - Resolution follows the loader's completion order but keeps every
 *   candidate that exists when extensions collide, rather than guessing a
 *   bundler's precedence. A relative specifier that names no known file is
 *   unresolved; a bare specifier is a package and never an edge.
 * - A computed `import(expr)` is inconclusive unless `BOUNDED_DYNAMIC_IMPORTS`
 *   enumerates its targets; callers fail closed on an inconclusive closure.
 *
 * Builtins only: the planner imports this before `npm ci`. A graph owns its
 * caches for one collection; never retain one across collections, because
 * local pregate must see the next edit.
 */

import { posix } from 'path';
import { GUARD_CHECK_DIRS } from './guardScanners.js';
import { moduleImports } from './sourceTokens.js';

export const MODULE_SOURCE_RE = /\.[cm]?[jt]sx?$/i;
const TYPESCRIPT_RE = /\.[cm]?ts$/i;
const RESOLVE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];

// Numbered migrations only: `_helpers`, fixtures and guard tests share the
// directories but are never loaded by the runners.
const MIGRATION_FILE_RE = /\/\d+-[^/]*\.js$/;

/**
 * Computed `import(expr)` sites whose target set is fixed and enumerable. A
 * `directory` site contributes every known module under the directory that
 * matches `pattern`; an `external` site loads a package or an untracked
 * submodule, which no tracked-file edge can represent. Any other computed
 * import is inconclusive, so adding an unbounded site to a listed file means
 * extending this table deliberately.
 */
export const BOUNDED_DYNAMIC_IMPORTS = Object.freeze({
  'scripts/run-migrations.js': { directory: 'scripts/migrations/', pattern: MIGRATION_FILE_RE },
  'server/scripts/run-db-migrations.js': { directory: 'server/scripts/db-migrations/', pattern: MIGRATION_FILE_RE },
  'server/services/eidoverseControllerRegistry.js': {
    directory: 'server/services/eidoverseControllerDefinitions/', pattern: /\.controller\.js$/,
  },
  'server/lib/slashdoLoader.js': { external: true },
  'server/services/greyboxCapturePage.js': { external: true },
  // Each structural guard runner loads exactly the check modules in its directory (#16996).
  ...Object.fromEntries(GUARD_CHECK_DIRS.map(({ dir, runner }) => [runner, { directory: `${dir}/`, pattern: /\/[^/]+\.test\.jsx?$/ }])),
});

// Browser suites resolve vite and its plugins through resolveClientBundler or
// the client's require, i.e. packages outside the tracked-file graph.
const CLIENT_BUNDLER_IMPORT_RE = /\bresolveClientBundler\b|\brequireClient\.resolve\(/;

/**
 * Module specifiers `src` names: `{ statics, deferred, mocked, computed }`.
 * `deferred` holds literal `import()` targets, `mocked` the literal
 * `vi.mock`-family targets, and `computed` is true when any `import()` takes a
 * non-literal argument. Throws when the source cannot be tokenized; a caller
 * treats that as an unknown edge set.
 */
export function moduleSpecifiers(src, file = '') {
  return moduleImports(src, { jsx: !TYPESCRIPT_RE.test(file) });
}

/**
 * Every member of `known` a relative `spec` written in `fromRel` can name:
 * the exact path, the path with a module extension, or a directory index.
 * Empty for a bare (package) specifier or a miss. Query and hash suffixes
 * (`?raw`, `#x`) are dropped and a backslash separates segments, as in
 * Node's file-URL resolution.
 */
export function resolveModuleCandidates(fromRel, spec, known) {
  if (!spec.startsWith('.')) return [];
  const path = posix.normalize(posix.join(posix.dirname(fromRel), spec.replaceAll('\\', '/').split(/[?#]/)[0]));
  if (path === '..' || path.startsWith('../')) return [];
  return [path, ...RESOLVE_EXTENSIONS.map((extension) => `${path}${extension}`),
    ...RESOLVE_EXTENSIONS.map((extension) => `${path}/index${extension}`)].filter((candidate) => known.has(candidate));
}

/**
 * A lazily evaluated graph over the repo-relative `files`. `readText(rel)`
 * returns the source, or null/throws when it cannot be read.
 *
 * - `specifiersOf(file)`: the cached `moduleSpecifiers` result; throws for an
 *   unreadable or untokenizable file.
 * - `staticDependencies(file)` / `testDependencies(file)`: `{ dependencies,
 *   inconclusive }`. The test view adds literal and bounded computed
 *   `import()` targets to the static ones, which is what a test can load.
 * - `closure(entries, dependenciesFor)`: sorted members reachable from
 *   `entries` (themselves included), or null when any member is unreadable or
 *   any edge is inconclusive, so a partial walk can never look complete.
 */
export function createModuleGraph(files, readText) {
  const known = new Set(files);
  const sources = new Map();
  const specifiers = new Map();
  const staticEdges = new Map();
  const testEdges = new Map();

  const read = (file) => {
    if (!sources.has(file)) {
      try {
        const text = readText(file);
        sources.set(file, text == null ? { error: new Error(`Cannot read ${file}`) } : { text });
      } catch (error) {
        sources.set(file, { error });
      }
    }
    const source = sources.get(file);
    if (source.error) throw source.error;
    return source.text;
  };
  const specifiersOf = (file) => {
    if (!specifiers.has(file)) specifiers.set(file, moduleSpecifiers(read(file), file));
    return specifiers.get(file);
  };
  const resolveAll = (file, list) => {
    const dependencies = [];
    let inconclusive = false;
    for (const spec of list) {
      if (!spec.startsWith('.')) continue;
      const candidates = resolveModuleCandidates(file, spec, known);
      if (candidates.length === 0) inconclusive = true;
      dependencies.push(...candidates);
    }
    return { dependencies, inconclusive };
  };
  const boundedComputedImports = (file) => {
    const site = BOUNDED_DYNAMIC_IMPORTS[file];
    if (site?.directory) {
      return files.filter((path) => path.startsWith(site.directory) && site.pattern.test(path));
    }
    if (site?.external || CLIENT_BUNDLER_IMPORT_RE.test(read(file))) return [];
    return null;
  };
  const staticDependencies = (file) => {
    if (!staticEdges.has(file)) staticEdges.set(file, resolveAll(file, specifiersOf(file).statics));
    return staticEdges.get(file);
  };
  const testDependencies = (file) => {
    if (!testEdges.has(file)) {
      const { deferred, computed } = specifiersOf(file);
      const statics = staticDependencies(file);
      const dynamic = resolveAll(file, deferred);
      const bounded = computed ? boundedComputedImports(file) : null;
      testEdges.set(file, {
        dependencies: [...statics.dependencies, ...dynamic.dependencies, ...(bounded ?? [])],
        inconclusive: (computed && !bounded) || statics.inconclusive || dynamic.inconclusive,
      });
    }
    return testEdges.get(file);
  };
  const closure = (entries, dependenciesFor) => {
    const pending = [...entries];
    const seen = new Set();
    let inconclusive = false;
    try {
      for (let index = 0; index < pending.length; index++) {
        const file = pending[index];
        if (seen.has(file)) continue;
        seen.add(file);
        if (!MODULE_SOURCE_RE.test(file)) continue;
        const edges = dependenciesFor(file);
        if (edges.inconclusive) inconclusive = true;
        pending.push(...edges.dependencies);
      }
    } catch {
      return null;
    }
    return inconclusive ? null : [...seen].sort();
  };

  return { files, known, specifiersOf, staticDependencies, testDependencies, closure };
}
