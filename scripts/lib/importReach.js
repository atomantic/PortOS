/**
 * Dynamic-aware import reach: how many test files `vitest related` selects for
 * a changed source (#12285).
 *
 * `importGrowth.js` measures static closures because that is what a worker
 * pays to instantiate. Selection is a different graph: Vitest's related walk
 * follows `transformed.dynamicDeps` as well, so a lazy `import()` that keeps a
 * subtree out of every static closure still links the two modules for CI
 * selection. A change anywhere inside a dynamically connected cluster selects
 * every suite that reaches the cluster. This module reports both numbers per
 * source so a plan's selection size is attributable.
 *
 * The scan is textual, like `staticImportGraph.js`: a literal `import('…')`
 * outside a comment-only line is an edge. A specifier inside a string or a
 * trailing comment can add an extra edge (reach over-reports, never under).
 * Computed specifiers are not edges — Vite cannot follow them either.
 *
 * Builtins only: `scripts/ci-test-plan.js` imports this before `npm ci`.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, posix } from 'path';
import { staticImportSpecifiersFromSource } from '../../server/lib/staticImportGraph.js';
import { isDirectlyInvoked } from './directInvocation.js';
import { globToRegExp, toWorkspacePath, workspaceTestGlobs } from './workspaceTests.js';

const MODULE_SOURCE_RE = /\.[cm]?[jt]sx?$/i;
const RESOLVE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])([^'"`]+?)\1\s*[,)]/g;
// `*` opens a comment continuation only when followed by space, `/` or EOL; `*gen() {}` is code.
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*(?:[\s/]|$))/;
const LEADING_BLOCK_COMMENT_RE = /^\s*\/\*.*?\*\//;
const OPEN_BLOCK_COMMENT_RE = /^\s*\/\*/;

/** `{ static, dynamic }` relative and bare specifiers, in source order. */
export function importSpecifiersFromSource(src) {
  const code = src.split('\n')
    .map((line) => line.replace(LEADING_BLOCK_COMMENT_RE, ''))
    .filter((line) => !COMMENT_LINE_RE.test(line) && !OPEN_BLOCK_COMMENT_RE.test(line))
    .join('\n');
  const dynamic = [];
  for (const match of code.matchAll(DYNAMIC_IMPORT_RE)) {
    if (!match[2].includes('${')) dynamic.push(match[2]);
  }
  return { static: staticImportSpecifiersFromSource(code), dynamic };
}

function resolveSpecifier(fromRel, spec, known) {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec.split(/[?#]/)[0]));
  if (base === '..' || base.startsWith('../')) return null;
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`)];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/**
 * Resolved repo-relative edges for every module in `files`.
 * `readText(rel)` returns the source or null. An edge that is both static and
 * dynamic is recorded as static.
 *
 * @returns {Map<string, { static: Set<string>, dynamic: Set<string> }>}
 */
export function buildImportGraph(files, readText) {
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    if (!MODULE_SOURCE_RE.test(file)) continue;
    const text = readText(file);
    if (text == null) continue;
    const specs = importSpecifiersFromSource(text);
    const edges = { static: new Set(), dynamic: new Set() };
    for (const spec of specs.static) {
      const target = resolveSpecifier(file, spec, known);
      if (target && target !== file) edges.static.add(target);
    }
    for (const spec of specs.dynamic) {
      const target = resolveSpecifier(file, spec, known);
      if (target && target !== file && !edges.static.has(target)) edges.dynamic.add(target);
    }
    graph.set(file, edges);
  }
  return graph;
}

function reverseEdges(graph, dynamic) {
  const reverse = new Map();
  for (const [from, edges] of graph) {
    const targets = dynamic ? [...edges.static, ...edges.dynamic] : edges.static;
    for (const to of targets) {
      if (!reverse.has(to)) reverse.set(to, []);
      reverse.get(to).push(from);
    }
  }
  return reverse;
}

function reachFrom(reverse, source, isTest) {
  const seen = new Set([source]);
  const stack = [source];
  const tests = new Set();
  while (stack.length) {
    const file = stack.pop();
    if (isTest(file)) tests.add(file);
    for (const importer of reverse.get(file) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      stack.push(importer);
    }
  }
  return tests;
}

/**
 * Per-source reach: test files whose static closure contains the source, and
 * test files `vitest related` selects for it (static plus dynamic edges).
 * `union` is the dynamic-aware selection for all sources together.
 */
export function importReachReport(graph, sources, isTest) {
  const staticReverse = reverseEdges(graph, false);
  const dynamicReverse = reverseEdges(graph, true);
  const union = new Set();
  const rows = sources.map((source) => {
    const staticTests = reachFrom(staticReverse, source, isTest);
    const dynamicTests = reachFrom(dynamicReverse, source, isTest);
    for (const test of dynamicTests) union.add(test);
    return { source, staticReach: staticTests.size, dynamicReach: dynamicTests.size };
  });
  return { rows, selected: union.size };
}

/** Test files the server Vitest runner collects, as a repo-relative predicate. */
export function serverRunnerTestPredicate() {
  const { include, exclude } = workspaceTestGlobs('server', { env: {} });
  const includes = include.map(globToRegExp);
  const excludes = exclude.map(globToRegExp);
  return (repoRel) => {
    if (repoRel.startsWith('client/')) return false;
    const rel = toWorkspacePath('server', repoRel);
    return includes.some((re) => re.test(rel)) && !excludes.some((re) => re.test(rel));
  };
}

/**
 * One-line summary for the CI plan: the widest changed source first, so a
 * selection of hundreds of suites names the module that pulled them in.
 */
export function formatReachSummary(report, { limit = 3 } = {}) {
  if (!report || report.rows.length === 0) return '';
  const rows = [...report.rows].sort((a, b) => b.dynamicReach - a.dynamicReach || a.source.localeCompare(b.source));
  const shown = rows.slice(0, limit)
    .map((row) => `${row.source} ${row.dynamicReach} (static ${row.staticReach})`);
  const more = rows.length > limit ? `, +${rows.length - limit} more` : '';
  return `dynamic-aware fan-out ${report.selected} suite(s): ${shown.join(', ')}${more}`;
}

/** Tracked (plus given untracked) module files and a disk reader rooted at `cwd`. */
export function measureRepoImportReach({ cwd, files, sources, isTest = serverRunnerTestPredicate() }) {
  const paths = files ?? execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const modules = paths.filter((rel) => MODULE_SOURCE_RE.test(rel) && !rel.includes('node_modules/'));
  const graph = buildImportGraph(modules, (rel) => {
    const abs = join(cwd, ...rel.split('/'));
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  });
  return importReachReport(graph, sources.filter((source) => graph.has(source)), isTest);
}

function main() {
  const sources = process.argv.slice(2);
  if (sources.length === 0) {
    console.error('Usage: node scripts/lib/importReach.js <repo-relative source> [...]');
    process.exit(2);
  }
  const report = measureRepoImportReach({ cwd: process.cwd(), sources });
  for (const source of sources) {
    const row = report.rows.find((candidate) => candidate.source === source);
    console.log(row
      ? `${source}  static reach ${row.staticReach}, dynamic-aware reach ${row.dynamicReach}`
      : `${source}  not a tracked module`);
  }
  console.log(`Selected together: ${report.selected} suite(s)`);
}

if (isDirectlyInvoked(import.meta.url)) main();
