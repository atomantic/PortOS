/**
 * Static ES-module import scanning — one parser for every import-graph guard.
 *
 * Several suites assert structural properties of the module graph rather than
 * runtime behavior: `agentImportCycles.test.js` proves the agent-lifecycle
 * cluster is acyclic, and `spriteAnimationTracks.test.js` proves the
 * request-validation graph never reaches the native image dependencies
 * (sharp/ffmpeg). Both need the same thing — "which modules does this file
 * statically import?" — and both had their own copy of the regex pair and the
 * `exec` drain loop, which is exactly how a guard rots: a fix to one parser
 * (multi-line import lists, `export * from`, a new specifier shape) lands in
 * one copy while the other keeps silently under-reporting. `buildStaticImportGraph`
 * and `findImportCycles` live here for the same reason — `agentImportCycles` and
 * `twinImportCycles` both walk `server/services` for rings.
 *
 * **Static imports only.** `await import('./x.js')` is deferred to call time,
 * so it can neither produce a load-time cycle nor drag a native dependency into
 * a module's initialization graph — matching on it would report false
 * positives. The line-anchored patterns also mean a specifier mentioned inside
 * a comment is not matched, because a comment line never starts with
 * `import`/`export`.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';

// `import … from 'x'` / `export … from 'x'` (line-anchored, non-greedy up to
// the `from`), and bare `import 'x'` side-effect imports.
const STATIC_FROM = /^\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/gm;
const STATIC_BARE = /^\s*import\s*['"]([^'"]+)['"]/gm;

/**
 * Every module specifier `file` statically imports, in source order, verbatim
 * (relative specifiers keep their `./` / `../` prefix; bare package specifiers
 * come through as written). Duplicates are preserved — callers that want a set
 * build one.
 */
export function staticImportSpecifiers(file) {
  const src = readFileSync(file, 'utf-8');
  const out = [];
  for (const re of [STATIC_FROM, STATIC_BARE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(src)) !== null) out.push(match[1]);
  }
  return out;
}

/**
 * Walk the static import graph from `entry`, following relative specifiers that
 * resolve to a file on disk.
 *
 * @returns {{files: Set<string>, packages: Set<string>}} `files` — absolute
 *   paths of every module reachable from `entry` (including `entry` itself);
 *   `packages` — every BARE specifier hit anywhere in that closure, which is
 *   what a "this graph must not reach <dependency>" guard asserts against.
 *
 * A relative specifier that does not resolve to an existing path (an
 * extensionless import, a directory index) is skipped rather than throwing —
 * these guards assert a negative ("nothing here reaches sharp"), so a resolver
 * gap must not be able to make the walk *look* clean. Pair every such guard
 * with a positive control that pins a known-reaching entry point.
 */
export function staticImportClosure(entry) {
  const files = new Set();
  const packages = new Set();
  const walk = (file) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of staticImportSpecifiers(file)) {
      if (!spec.startsWith('.')) { packages.add(spec); continue; }
      const next = resolve(dirname(file), spec);
      if (existsSync(next)) walk(next);
    }
  };
  walk(entry);
  return { files, packages };
}

/**
 * True when `specifier` names `pkg` or a subpath of it (`sharp` matches both
 * `sharp` and `sharp/lib/x`), so a dependency guard can't be sidestepped by
 * importing a deep path.
 */
export function specifierMatchesPackage(specifier, pkg) {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/**
 * Every non-test `.js` file under `rootDir`, keyed by its path relative to that
 * directory (`identity.js`, `identity/goals.js`). The walk recurses: scanning
 * only top-level files leaves a hole big enough to drive a cycle back through,
 * because a subdirectory module can import back up.
 */
function listModuleFiles(rootDir, dir = rootDir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listModuleFiles(rootDir, join(dir, entry.name), rel));
    else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) out.push(rel);
  }
  return out;
}

/**
 * The STATIC import graph of every non-test module under `rootDir`, as
 * `Map<relPath, relPath[]>`. Specifiers are resolved relative to the importing
 * file and re-keyed against `rootDir`, so `./x.js` from a subdirectory and
 * `../x.js` from a sibling land on the same node; anything resolving outside
 * `rootDir` is dropped, because these guards ask about one directory's internal
 * shape. Static edges only — see the module header for why `import()` is out.
 */
export function buildStaticImportGraph(rootDir) {
  const files = listModuleFiles(rootDir);
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const abs = join(rootDir, file);
    const deps = new Set();
    for (const spec of staticImportSpecifiers(abs)) {
      if (!spec.startsWith('.')) continue;
      const rel = relative(rootDir, resolve(dirname(abs), spec)).split(sep).join('/');
      if (known.has(rel)) deps.add(rel);
    }
    graph.set(file, [...deps]);
  }
  return graph;
}

/**
 * Every static import cycle in `graph`, each rendered as `a.js -> b.js -> a.js`
 * so a failure message names the whole ring rather than one edge. Depth-first
 * with an on-stack marker: a dep already on the stack closes a cycle, and the
 * slice from its first appearance is that cycle.
 */
export function findImportCycles(graph) {
  const cycles = new Set();
  const stack = [];
  const state = new Map(); // 1 = on stack, 2 = done
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (state.get(dep) === 1) {
        cycles.add(stack.slice(stack.indexOf(dep)).concat(dep).join(' -> '));
      } else if (!state.has(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return [...cycles];
}
