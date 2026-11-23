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
 * Edges come from the shared module graph (`moduleGraph.js`), the one the
 * planner's DB and browser closures and pregate's local selection read: a
 * literal `import('…')` is an edge, a computed one is not (Vite cannot follow
 * it either), and comments or quoted fixtures never add one.
 *
 * Builtins only: `scripts/ci-test-plan.js` imports this before `npm ci`.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { MODULE_SOURCE_RE, createModuleGraph, resolveModuleCandidates } from './moduleGraph.js';
import { isDirectlyInvoked } from './directInvocation.js';
import { globToRegExp, toWorkspacePath, workspaceTestGlobs } from './workspaceTests.js';

/**
 * Resolved repo-relative edges for every module of `graph` (`createModuleGraph`).
 * A module that cannot be read or tokenized has no entry and is listed in
 * `uninspected` instead, because its edges are unknown. An edge that is both
 * static and dynamic is recorded as static.
 *
 * @returns {{ edges: Map<string, { static: Set<string>, dynamic: Set<string> }>, uninspected: string[] }}
 */
export function importEdges(graph) {
  const edges = new Map();
  const uninspected = [];
  for (const file of graph.files) {
    if (!MODULE_SOURCE_RE.test(file)) continue;
    let deferred;
    let statics;
    try {
      ({ deferred } = graph.specifiersOf(file));
      statics = graph.staticDependencies(file).dependencies;
    } catch {
      uninspected.push(file);
      continue;
    }
    const staticTargets = new Set(statics.filter((target) => target !== file));
    const dynamicTargets = new Set(deferred.flatMap((spec) => resolveModuleCandidates(file, spec, graph.known))
      .filter((target) => target !== file && !staticTargets.has(target)));
    edges.set(file, { static: staticTargets, dynamic: dynamicTargets });
  }
  return { edges, uninspected };
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

const runnerTestPredicate = (workspace, ownsPath) => {
  const { include, exclude } = workspaceTestGlobs(workspace, { env: {} });
  const includes = include.map(globToRegExp);
  const excludes = exclude.map(globToRegExp);
  return (repoRel) => {
    if (!ownsPath(repoRel)) return false;
    const rel = toWorkspacePath(workspace, repoRel);
    return includes.some((re) => re.test(rel)) && !excludes.some((re) => re.test(rel));
  };
};

/** Test files the server Vitest runner collects, as a repo-relative predicate. */
export const serverRunnerTestPredicate = () => runnerTestPredicate('server', (path) => !path.startsWith('client/'));

/** Test files the client Vitest runner collects (`client/src` only), as a repo-relative predicate. */
export const clientRunnerTestPredicate = () => runnerTestPredicate('client', (path) => path.startsWith('client/'));

/** A real-Chromium suite the client runner collects (`client/**\/*.browser.test.js`). */
export const isClientBrowserSuite = (path) => /^client\/.+\.browser\.test\.[cm]?[jt]sx?$/.test(path);

// A client fixture names what it renders as `/src/…` inside the virtual
// fixture module and `optimizeDeps.entries`: strings no import edge follows.
const RENDERED_ENTRY_RE = /['"`]\/?(src\/[^'"`\s?#]+\.(?:[cm]?[jt]sx?|css))/g;

/** True when `path` is an input every client fixture's render shares (`BROWSER_SERVED_SHARED_INPUTS`, a direct file of `client/`). */
const sharesEveryRender = (path, shared) => /^client\/[^./][^/]*$/.test(path)
  || shared.some((input) => path === input || path.startsWith(`${input}/`));

/** Every file reachable from `entries` over `edges` (static and dynamic). */
const closureOver = (edges, entries) => {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const out = edges.get(file);
    if (out) stack.push(...out.static, ...out.dynamic);
  }
  return seen;
};

/**
 * The client real-Chromium suites a change reaches (#17616), for shard
 * sizing: each such suite costs a Chrome launch and a cold Vite graph, tens
 * of seconds where a happy-dom suite costs under one. A suite is reached
 * when a changed file is in its own static or dynamic import closure (the
 * fixture harness), in the closure of what its fixture renders (the `/src/…`
 * entries it names, followed over the same edges, CSS imports included), or
 * is an input every render shares (`sharedInputs`: the global stylesheet,
 * theme tokens, `client/`'s own configuration and manifests) or a module one
 * of those imports. An unreadable module may hide any edge, so every suite
 * counts then.
 *
 * @returns {{ selected: number, suites: string[] }}
 */
export function clientBrowserSuiteReach({ graph, changedFiles, sharedInputs = [], read }) {
  const suites = graph.files.filter(isClientBrowserSuite);
  if (suites.length === 0 || changedFiles.length === 0) return { selected: 0, suites: [] };
  if (changedFiles.some((path) => sharesEveryRender(path, sharedInputs))) return { selected: suites.length, suites };
  const { edges, uninspected } = importEdges(graph);
  if (uninspected.length > 0) return { selected: suites.length, suites };
  const changed = new Set(changedFiles);
  const shared = closureOver(edges, graph.files.filter((path) => sharesEveryRender(path, sharedInputs)));
  if (changedFiles.some((path) => shared.has(path))) return { selected: suites.length, suites };
  const closureHits = (entries) => [...closureOver(edges, entries)].some((file) => changed.has(file));
  const reached = suites.filter((suite) => {
    let text = '';
    try { text = read(suite) ?? ''; } catch { /* an unreadable suite renders nothing this walk can see */ }
    const rendered = [...text.matchAll(RENDERED_ENTRY_RE)].map(([, rel]) => `client/${rel}`).filter((rel) => graph.known.has(rel));
    return closureHits([suite, ...rendered]);
  });
  return { selected: reached.length, suites: reached };
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
  const unknown = report.uninspected?.length
    ? `; reach unknown: ${report.uninspected[0]}${report.uninspected.length > 1 ? ` and ${report.uninspected.length - 1} more` : ''} could not be read`
    : '';
  return `dynamic-aware fan-out ${report.selected} suite(s): ${shown.join(', ')}${more}${unknown}`;
}

/**
 * Reach of `sources` over a module graph. A collection passes its own
 * `graph` (`createModuleGraph`) so the planner tokenizes each file once;
 * otherwise the tracked files of `cwd` (or the given `files`) are read
 * directly, an absent file counting as unreadable. A module that cannot be
 * inspected may hide any number of edges, so `selected` then assumes every
 * test the graph holds and `uninspected` names the modules.
 */
export function measureRepoImportReach({ cwd, files, sources, isTest = serverRunnerTestPredicate(), graph }) {
  const moduleGraph = graph ?? createModuleGraph(
    files ?? execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean),
    (rel) => {
      const abs = join(cwd, ...rel.split('/'));
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    },
  );
  const { edges, uninspected } = importEdges(moduleGraph);
  const report = importReachReport(edges, sources.filter((source) => edges.has(source)), isTest);
  if (uninspected.length === 0) return report;
  return { ...report, selected: Math.max(report.selected, moduleGraph.files.filter(isTest).length), uninspected };
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
