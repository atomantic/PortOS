/**
 * Focused local pregate selection: structural guards, edited tests and nearby
 * suites discovered from imports or file literals. The CLI owns stage execution.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAlwaysRunTests, structuralTestsFor, TOOLING_TESTS } from '../ci-test-plan.js';
import { EXCLUSIVE_TESTS } from '../vitestCiPool.js';
import { BROWSER_SUITES } from './browserSuites.js';
import { isGateToolingTest } from './ciPlanRules.js';
import { resolveDbTestFiles } from './dbTestFiles.js';
import { guardRunnerFor, isGuardTest } from './guardScanners.js';
import { moduleSpecifiers, resolveModuleCandidates } from './moduleGraph.js';
import { toRepoPath } from './workspaceTests.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Replace a full-suite plan with the always-run guards.
 *
 * A full plan is CI's answer to "this diff could break anything", which is
 * correct there and unusable here — the complete suite is far longer than
 * anyone runs before a push, so the honest local default is the subset that
 * catches always-run and diff-selected structural guards, plus a line saying
 * what was dropped. The resource flags stay as the planner set them so the
 * summary can still name what CI will run; `--full` opts back in.
 */
export function downgradeFullPlan(plan, trackedFiles, changedFiles = []) {
  const tracked = new Set(trackedFiles);
  const structuralGuards = structuralTestsFor(changedFiles, tracked);
  const serverStructuralGuards = structuralGuards.filter((path) => !path.startsWith('client/'));
  const clientStructuralGuards = structuralGuards.filter((path) => path.startsWith('client/'));
  // Client tree guards join the local gate by their suffix, the same name the
  // planner selects them by, so there is no second list (guards under hooks/ included).
  // Selected like CI (ciPlanRules): only when the plan is full or a client source changed.
  const touchesClient = plan.full || changedFiles.some((path) => /^client\/src\/.*\.jsx?$/.test(path));
  const clientGuards = touchesClient
    ? trackedFiles.filter((path) => path.startsWith('client/src/') && isGuardTest(path))
    : [];
  return {
    ...plan,
    full: false,
    server: {
      mode: 'files',
      files: [...new Set([...getAlwaysRunTests(trackedFiles).filter((path) => tracked.has(path)), ...serverStructuralGuards])],
      sources: [],
    },
    client: {
      mode: clientGuards.length > 0 || clientStructuralGuards.length > 0 ? 'files' : 'skip',
      files: [...new Set([...clientGuards, ...clientStructuralGuards])],
      sources: [],
    },
    // A scoped plan already lints only its changed files; only a full plan lints everything.
    lint: plan.full ? { mode: 'full', files: [] } : plan.lint,
  };
}

/** Suites one changed source may add through a differently named import or mock, per hop. */
export const RELATED_SUITE_CAP = 25;

/** Suites the second hop may add to one run, across every changed source (#16863). */
export const SECOND_HOP_RUN_CAP = 60;

// Suites that cost tens of seconds each (nested runners, real git, the planner's own matrix):
// the Vitest pool already runs them one at a time, and the planner selects the tooling ones
// for a diff under their owner paths. A transitive edge is too weak a reason to pay for them here.
const HEAVY_SUITES = new Set([...TOOLING_TESTS, ...EXCLUSIVE_TESTS.map(path => toRepoPath('server', path))]);

const MODULE_FILE = /\.[cm]?[jt]sx?$/;
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseName = path => path.slice(path.lastIndexOf('/') + 1).replace(MODULE_FILE, '');

// Overlap file reads without queuing an open for every file in the checkout.
const FOCUSED_READ_LIMIT = 32;

async function scanTexts(files, readText, visit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(files.length, FOCUSED_READ_LIMIT) }, async () => {
    while (next < files.length) {
      const file = files[next++];
      const text = await readText(file);
      if (text != null) visit(file, text);
    }
  });
  await Promise.all(workers);
}

/**
 * Text a file must contain to import `target`: its base name, or for a directory
 * index (`dir/index.js`) the directory name or a bare `'.'`/`'..'` specifier,
 * because `import './dir'` never spells "index".
 */
function importNeedles(target) {
  const name = baseName(target);
  if (name !== 'index') return [escapeRegExp(name)];
  const dir = target.split('/').slice(-2, -1)[0];
  return [escapeRegExp(name), ...(dir ? [escapeRegExp(dir)] : []), '[\'"`]\\.{1,2}[\'"`]'];
}

/**
 * Which of `files` reference each of `targets` through a relative import,
 * `import()` or `vi.mock` specifier that resolves to it, read through the
 * shared module graph's extractor and resolver (`scripts/lib/moduleGraph.js`).
 * A file the tokenizer cannot read counts as a referrer of every target it
 * spells, so an unknown edge set widens the local run instead of hiding a suite.
 *
 * @returns {Map<string, string[]>} target -> sorted, de-duplicated referrers
 */
async function referrersOf(targets, files, readText) {
  if (!targets.length) return new Map();
  const referrers = new Map(targets.map(target => [target, new Set()]));
  const known = new Set(targets);
  // Cheap prefilter: a resolved specifier always spells one of the target's needles.
  const needles = new Map(targets.map(target => [target, new RegExp(importNeedles(target).join('|'))]));
  const spelled = new RegExp([...new Set(targets.flatMap(importNeedles))].join('|'));
  await scanTexts(files, readText, (file, text) => {
    if (!spelled.test(text)) return;
    let specs;
    try {
      specs = moduleSpecifiers(text, file);
    } catch {
      for (const [target, needle] of needles) if (target !== file && needle.test(text)) referrers.get(target).add(file);
      return;
    }
    for (const spec of [...specs.statics, ...specs.deferred, ...specs.mocked]) {
      for (const target of resolveModuleCandidates(file, spec, known)) {
        if (target !== file) referrers.get(target).add(file);
      }
    }
  });
  return new Map([...referrers].map(([target, set]) => [target, [...set].sort()]));
}

/**
 * Which of `files` spell each changed non-module file as a quoted string literal, which is how a
 * test reads it (`readFileSync(join(ROOT, 'package.json'))`) without importing it. A test that
 * spells the full repo-relative path matches. A bare base name matches only when it cannot be
 * confused with another file: always for a repo-root file (its base name is its path), otherwise
 * only while at most RELATED_SUITE_CAP suites spell it, so a nested `server/package.json`
 * edit is not answered by every suite that mentions `'package.json'`. Tests that spell the
 * full path or more of the changed files come first when the cap bites.
 *
 * @returns {Map<string, string[]>} changed file -> ranked, de-duplicated readers
 */
async function textReaders(changed, files, readText) {
  const quoted = name => new RegExp(`['"\`](?:\\.{0,2}/)?${escapeRegExp(name)}['"\`]`);
  const spells = new Map();
  for (const path of changed) {
    const byPath = quoted(path);
    const byName = quoted(path.slice(path.lastIndexOf('/') + 1));
    spells.set(path, { byPath, byName, root: !path.includes('/'), full: new Set(), name: new Set() });
  }
  await scanTexts(files, readText, (file, text) => {
    for (const entry of spells.values()) {
      if (entry.byPath.test(text)) entry.full.add(file);
      else if (entry.byName.test(text)) entry.name.add(file);
    }
  });
  const weight = new Map();
  for (const { full, name } of spells.values()) for (const file of [...full, ...name]) weight.set(file, (weight.get(file) ?? 0) + 1);
  const order = (a, b) => (weight.get(b) - weight.get(a)) || (a < b ? -1 : a > b ? 1 : 0);
  return new Map([...spells].map(([path, { root, full, name }]) => {
    const byName = root || name.size <= RELATED_SUITE_CAP ? [...name] : [];
    return [path, [...[...full].sort(order), ...byName.sort(order)]];
  }));
}

/**
 * Local selection owns the edited tests, same-stem siblings, and tests within
 * two import hops of a changed source (#16863). Hop one is a test whose
 * relative import, `import()` or `vi.mock` specifier resolves to the source (a
 * route suite mocking the service it fronts); hop two is a test that references
 * a non-test module that does (a prompt-assembly suite reaching a prompt
 * section through the builder that imports it). A changed non-module file
 * (JSON, a shell or PowerShell script, a doc) has no import edge, so a third
 * selector adds suites that spell its path, or an unambiguous name, as a quoted
 * string literal (`textReaders`). Deeper reach and broader integration coverage
 * remain with hosted CI, which walks the whole graph.
 *
 * Caps keep the local gate short: each hop adds at most RELATED_SUITE_CAP
 * suites per changed source (the text selector per changed file), and the second hop at most SECOND_HOP_RUN_CAP per
 * run, nearest hop first (hop one is never displaced) and never a HEAVY_SUITES
 * member. Whatever a cap leaves out is recorded in `relatedOverflow` and
 * reported as skipped. A supplied basePlan is the caller-owned copy to augment.
 */
export async function focusedLocalPlan(plan, trackedFiles, changedFiles, readText = readRepoText, { basePlan } = {}) {
  const local = basePlan ?? downgradeFullPlan(plan, trackedFiles, changedFiles);
  const tracked = new Set(trackedFiles);
  const tests = trackedFiles.filter(path => /\.test\.[cm]?[jt]sx?$/.test(path));
  const resourceTests = new Set([...BROWSER_SUITES, ...resolveDbTestFiles(tests)]);
  const unitTests = new Set(tests.filter(path => !resourceTests.has(path) && !/(?:\.(?:db|browser|live)\.test\.|\/db\.test\.)/.test(path)));
  const focused = new Set();
  const changedSources = [];
  const changedData = [];
  for (const path of changedFiles) {
    if (unitTests.has(path)) focused.add(path);
    if (!MODULE_FILE.test(path)) {
      if (tracked.has(path)) changedData.push(path);
      continue;
    }
    if (/\.test\./.test(path)) continue;
    if (tracked.has(path)) changedSources.push(path);
    const stem = path.replace(MODULE_FILE, '');
    for (const suffix of ['.test.js', '.test.jsx', '.test.ts', '.test.tsx', '.test.mjs', '.test.cjs']) {
      const test = `${stem}${suffix}`;
      if (unitTests.has(test)) focused.add(test);
    }
  }
  const relatedOverflow = [];
  const testTexts = new Map();
  const readWithTestMemo = path => {
    // Only test files are scanned again by later passes.
    if (!unitTests.has(path)) return readText(path);
    if (!testTexts.has(path)) testTexts.set(path, readText(path));
    return testTexts.get(path);
  };
  const addCapped = (source, tests, hop, budget = RELATED_SUITE_CAP) => {
    const fresh = tests.filter(test => !focused.has(test));
    const take = fresh.slice(0, Math.min(RELATED_SUITE_CAP, budget));
    take.forEach(test => { focused.add(test); });
    if (fresh.length > take.length) relatedOverflow.push({ source, count: fresh.length - take.length, hop });
    return take.length;
  };
  const candidateTests = () => [...unitTests].filter(path => !focused.has(path));
  if (changedSources.length) {
    // Direct test references and intermediary modules share one read pass.
    const changed = new Set(changedSources);
    const modules = trackedFiles.filter(path => MODULE_FILE.test(path) && !/\.test\./.test(path) && !changed.has(path));
    const firstHop = await referrersOf(changedSources, [...candidateTests(), ...modules], readWithTestMemo);
    const importerSources = new Map();
    for (const [source, referrers] of firstHop) {
      const tests = [];
      for (const file of referrers) {
        if (unitTests.has(file)) tests.push(file);
        else importerSources.set(file, [...(importerSources.get(file) ?? []), source]);
      }
      addCapped(source, tests, 1);
    }

    // Hop two: tests that reference a non-test module importing a changed source.
    const viaImporter = await referrersOf([...importerSources.keys()].sort(), candidateTests().filter(test => !HEAVY_SUITES.has(test)), readWithTestMemo);
    // An importer's own suite (same stem) is its owner, so it outranks the rest when a cap bites.
    const secondHop = new Map(changedSources.map(source => [source, new Map()]));
    for (const [importer, tests] of viaImporter) {
      const stem = `${importer.replace(MODULE_FILE, '')}.`;
      for (const source of importerSources.get(importer)) {
        for (const test of tests) secondHop.get(source).set(test, Math.min(secondHop.get(source).get(test) ?? 1, test.startsWith(stem) ? 0 : 1));
      }
    }
    let budget = SECOND_HOP_RUN_CAP;
    for (const [source, ranked] of secondHop) {
      const ordered = [...ranked].sort(([a, rankA], [b, rankB]) => rankA - rankB || (a < b ? -1 : a > b ? 1 : 0)).map(([test]) => test);
      budget -= addCapped(source, ordered, 2, budget);
    }
  }
  // Text selector: tests that read a changed non-module file leave no import edge, so they are
  // found by the file's spelled path or name instead (#16866). Runs after the import hops, so a
  // suite selected for an import never counts against it. Planner fixtures
  // can name changed paths without reading them.
  if (changedData.length) {
    const candidates = candidateTests().filter(test => !HEAVY_SUITES.has(test) && !isGateToolingTest(test));
    const found = await textReaders(changedData, candidates, readWithTestMemo);
    for (const [source, tests] of found) addCapped(source, tests, 'text');
  }
  // A structural guard check runs only inside its runner (#16996): the Vitest configs
  // exclude its directory, so a changed or source-reading check selects the runner.
  const runnable = [...focused].map(path => guardRunnerFor(path) ?? path).filter(path => tracked.has(path));
  for (const scope of ['server', 'client']) {
    const files = [...new Set([...local[scope].files, ...runnable.filter(path => scope === 'client' ? path.startsWith('client/') : !path.startsWith('client/'))])];
    local[scope] = { mode: files.length ? 'files' : 'skip', files, sources: [] };
  }
  local.relatedOverflow = relatedOverflow;
  return local;
}

async function readRepoText(path) {
  try {
    return await readFile(join(REPO_ROOT, path), 'utf8');
  } catch {
    return null;
  }
}
