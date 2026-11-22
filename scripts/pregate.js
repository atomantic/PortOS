#!/usr/bin/env node

/**
 * Lightweight local pre-push validation: lint/format, structural invariants
 * and directly owned tests. Hosted CI keeps its broad impact plan.
 * `--full` opts into that CI plan locally, including selected resource suites.
 * `--guards-only` runs just the structural checks.
 * Receipts describe the exact tree and coverage; focused results are local evidence only and never replace
 * CI suites. Cancellation still settles every owned stage process group.
 */

import { spawn, spawnSync } from 'child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeSync } from 'fs';
import { readFile } from 'node:fs/promises';
import { constants, homedir, tmpdir } from 'os';
import { setTimeout as delay } from 'timers/promises';
import { execFileSync } from 'child_process';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { prepareWindowsSafeSpawn, resolveWindowsExecutable } from '../server/lib/aiToolkit/internal/windowsSafeSpawn.js';
import { buildCiTestPlan, getAlwaysRunTests, FULL_SUITE_SHARDS, structuralTestsFor, TOOLING_TESTS } from './ci-test-plan.js';
import { EXCLUSIVE_TESTS } from './vitestCiPool.js';
import { toRepoPath } from './lib/workspaceTests.js';
import { guardRunnerFor, isGuardTest } from './lib/guardScanners.js';
import { assertNodeVersion } from './checkNodeVersion.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { needsBrowserFidelity } from './lib/browserFidelity.js';
import { BROWSER_SUITES } from './lib/browserSuites.js';
import { resolveDbTestFiles } from './lib/dbTestFiles.js';
import { moduleSpecifiers, resolveModuleCandidates } from './lib/moduleGraph.js';
import { cosWorkerBudget, readMaxConcurrentAgents } from './lib/cosWorkerBudget.js';
import { ACTIONLINT_VERSION, probeActionlint, selectWorkflowFiles } from './lib/actionlint.js';
import { CI_GUARD_BUDGET_MS, GUARD_BUDGET_MS, describeGuardDurations, overBudgetGuards, readGuardDurations } from './lib/guardBudget.js';
import { buildPregateReport, createWorkingTreeHasher, PREGATE_REPORT_PATH, writePregateReport } from './lib/pregateReport.js';
import { dependencyConsistencyProblems } from './lib/workspaceDependencies.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN32 = process.platform === 'win32';

/**
 * Suites CI runs that a local run may have to leave to CI, each valued by what
 * the operator can do about it. Reported rather than silently dropped: a
 * pregate that stayed quiet about a DB-risk diff would read as "CI is covered"
 * while the one suite that can destroy real data went unmentioned.
 */
export const UNCOVERED_SUITES = Object.freeze({
  actionlint: `set ACTIONLINT_BIN to a pinned actionlint ${ACTIONLINT_VERSION} binary (the rhysd/actionlint v${ACTIONLINT_VERSION} release, checked against its checksums file) and put shellcheck on PATH; CI runs the same check`,
  db: 'needs a reachable test Postgres: npm run setup:db:test && npm run test:db (never against the real `portos` database)',
  browser: 'needs Chrome, ffmpeg and the client bundler; run `npm run pregate -- --full` once they are installed',
  build: 'npm run build',
  smoke: 'npm run smoke',
  windows: 'CI is the only proof',
  linuxContainment: 'a Linux host with bubblewrap: PORTOS_REQUIRE_LINUX_CONTAINMENT=1 npm test --prefix server -- --run <LINUX_CONTAINMENT_TESTS>',
  supercolliderLive: 'a native amd64/arm64 Linux Docker engine: npm run setup:supercollider -- --yes, then PORTOS_SUPERCOLLIDER_LIVE=1 npx vitest run services/superColliderRender.live.test.js from server/',
  dockerContainmentLive: 'a local Docker engine with Linux containers and npm registry access: PORTOS_DOCKER_CONTAINMENT_LIVE=1 npx vitest run services/dockerContainment.live.test.js from server/',
  macosNative: 'a Mac: npm test --prefix server -- --run lib/windowsAgentProcess.darwin.test.js',
});

/** Remedy when a prerequisite probe ran but failed (timeout, teardown): nothing indicates a missing install. */
const PROBE_FAILED_REMEDY = 'the prerequisite probe itself failed, which does not show anything is missing; rerun `npm run pregate`, and if it repeats diagnose Chrome startup/teardown before reinstalling anything';

/** Does the plan select this suite at all? `browser` is a file list, the rest flags. */
export function suiteSelected(plan, suite) {
  return suite === 'browser' ? (plan.browser?.files?.length ?? 0) > 0 : Boolean(plan[suite]);
}

/** Does the plan lint any workflow file? A full plan lints them all. */
export function workflowLintSelected(plan) {
  return plan.lint.mode === 'full' || (plan.lint.mode === 'files' && selectWorkflowFiles(plan.lint.files).length > 0);
}

/**
 * Every known CI suite omitted here, with the reason.
 *
 * Pure. A `--skip-*` flag outranks a downgraded full plan, which outranks a
 * failed prerequisite probe (`prerequisites[suite].ok === false`), so the
 * reason names the operator's own choice first. Windows and the Linux
 * containment job are always here when selected: neither has a local runner.
 */
export function uncoveredSuites(plan, { options = {}, downgraded = false, prerequisites = {} } = {}) {
  const flags = { db: options.skipDb, browser: options.skipBrowser, build: options.skipBuild, smoke: options.skipSmoke };
  const uncovered = [];
  for (const suite of ['build', 'smoke', 'browser', 'db']) {
    if (!suiteSelected(plan, suite)) continue;
    let reason = null;
    if (flags[suite]) reason = `skipped by --skip-${suite}`;
    else if (downgraded) reason = 'local focused mode; hosted CI determines coverage (opt in locally with --full)';
    else if (prerequisites[suite]?.ok === false) {
      const { reason: detail, category } = prerequisites[suite];
      const probeOnly = category === 'probe-failed';
      reason = probeOnly ? `probe failed: ${detail}` : `prerequisite missing: ${detail}`;
      // Only the probe-failed category swaps the remedy: a genuinely absent tool keeps its install advice.
      uncovered.push({ suite, reason, ...(category ? { category } : {}), remedy: probeOnly ? PROBE_FAILED_REMEDY : UNCOVERED_SUITES[suite] });
      continue;
    }
    if (reason) uncovered.push({ suite, reason, remedy: UNCOVERED_SUITES[suite] });
  }
  if (workflowLintSelected(plan) && !options.skipLint && prerequisites.actionlint?.ok === false) {
    uncovered.push({ suite: 'actionlint', reason: `prerequisite missing: ${prerequisites.actionlint.reason}`, remedy: UNCOVERED_SUITES.actionlint });
  }
  if (suiteSelected(plan, 'windows')) {
    uncovered.push({ suite: 'windows', reason: 'a Windows runner has no local equivalent', remedy: UNCOVERED_SUITES.windows });
  }
  if (suiteSelected(plan, 'linuxContainment')) {
    uncovered.push({ suite: 'linuxContainment', reason: 'needs a Linux host with bubblewrap namespaces', remedy: UNCOVERED_SUITES.linuxContainment });
  }
  if (suiteSelected(plan, 'supercolliderLive')) {
    uncovered.push({ suite: 'supercolliderLive', reason: 'needs a native Linux Docker engine on amd64 and arm64', remedy: UNCOVERED_SUITES.supercolliderLive });
  }
  if (suiteSelected(plan, 'dockerContainmentLive')) {
    uncovered.push({ suite: 'dockerContainmentLive', reason: 'needs a real Docker engine and pulls the pinned Node image', remedy: UNCOVERED_SUITES.dockerContainmentLive });
  }
  if (suiteSelected(plan, 'macosNative')) {
    uncovered.push({ suite: 'macosNative', reason: 'a dedicated macOS CI job; the focused local stages do not select it', remedy: UNCOVERED_SUITES.macosNative });
  }
  for (const { source, count, hop = 1 } of plan.relatedOverflow ?? []) {
    const reason = hop === 'text'
      ? `${count} suite(s) reading ${source} as text beyond the ${RELATED_SUITE_CAP}-per-file cap`
      : hop === 2
      ? `${count} suite(s) two imports away from ${source} beyond the ${RELATED_SUITE_CAP}-per-source and ${SECOND_HOP_RUN_CAP}-per-run caps`
      : `${count} suite(s) referencing ${source} beyond the ${RELATED_SUITE_CAP}-suite cap`;
    uncovered.push({ suite: 'related tests', reason, remedy: 'run the referencing suites directly with `server/node_modules/.bin/vitest run <files>`; CI runs them' });
  }
  return uncovered;
}

/**
 * Plan lines for the cross-workspace browser selection CI consumes
 * (`browser_files`). PRs run the smoke profile; the `[fidelity]` cases run in
 * hosted CI on nightly, release and dispatched runs, and locally on request.
 */
export function describeBrowserSelection(files) {
  if (files.length === 0) return ['ℹ️ Browser suites: none selected.'];
  const lines = [`ℹ️ Browser suites: ${files.length} selected (${files.join(', ')}).`];
  if (needsBrowserFidelity(files)) {
    lines.push('ℹ️ Fidelity cases are selected: CI runs them nightly and on the release PR,'
      + ' not on this PR. To check them now, run `node scripts/browser-fidelity.js --pr NUMBER`.');
  }
  return lines;
}

/** Local pregate worker budget per Vitest workspace; see scripts/vitestCiPool.js. */
/**
 * Env for a stage child: one worker budget, from the CoS max-concurrent-agents
 * setting (scripts/lib/cosWorkerBudget.js), shared by every Vitest workspace.
 */
let derivedWorkerBudget;
export function pregateWorkerEnv(env, primaryCheckout) {
  derivedWorkerBudget ??= String(cosWorkerBudget({ agents: readMaxConcurrentAgents(primaryCheckout) }));
  return { ...env, PORTOS_PREGATE_MAX_WORKERS: env.PORTOS_PREGATE_MAX_WORKERS || derivedWorkerBudget };
}

/**
 * The child environment for one stage. A stage value of `undefined` REMOVES
 * the variable (the DB stages drop `TEST_DB_OK` this way), which is the only
 * way an inherited escape hatch can be kept away from a runner.
 *
 * `ownsGroup` (POSIX, where each stage gets its own process group) tells
 * run-ci-tests.js to keep npm and Vitest in that group instead of detaching
 * them, so cancelling the stage group reaches every test process (#12641).
 */
export function stageSpawnEnv(baseEnv, stageEnv, { ownsGroup = !IS_WIN32 } = {}) {
  const env = { ...pregateWorkerEnv(baseEnv), ...(ownsGroup ? { PORTOS_CI_TEST_SUPERVISED_GROUP: '1' } : {}) };
  for (const [name, value] of Object.entries(stageEnv)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** Human spelling of a stage's command for plan output and the receipt. */
export function describeStageCommand(stage) {
  return stage.npm ? `npm ${stage.npm.join(' ')}` : `node scripts/${stage.script}${stage.args.length ? ` ${stage.args.join(' ')}` : ''}`;
}

/**
 * The ordered stages to run for a plan, each a spawnable command.
 *
 * Pure, so the plan -> stage mapping is testable without spawning anything.
 * The hidden-content scan always runs first, even if lint/tests select no
 * work. The shared structural guards follow it, then CI's dependency order:
 * lint, unit tests, the client build and its bundle pin, the boot smoke, the browser suites, and the DB suite
 * last and alone. `skip` holds the suites that stay with CI
 * (see `uncoveredSuites`); `databaseEnv` is the pinned `portos_test`
 * environment from scripts/lib/pregateResources.js.
 */
export function resolvePlanStages(plan, { skipLint = false, baseSha, baseRef, skip = {}, databaseEnv = {}, guardPlan = null } = {}) {
  const base = { ...(baseSha ? { CI_BASE_SHA: baseSha } : {}), PORTOS_PREGATE_BASE_REF: baseRef ?? '' };
  const stages = [{
    name: 'hidden-content scan',
    suite: 'scan',
    script: 'scan-diff-hidden-content.js',
    args: ['--base', baseSha, '--worktree'],
    env: {},
  }];

  const guardedFiles = { server: new Set(), client: new Set() };
  // Single owner of each unit scope's env: guards, scoped runs and every full
  // shard share it, so a re-run can never drift into a different memo key.
  // CI_SHARD is cleared so an inherited value can only slice a stage that
  // sets it below.
  const scopeEnv = { server: { PORTOS_CI_BROWSER_OWNER: 'unit', PORTOS_TEST_QUIET: '1', CI_SHARD: undefined }, client: { CI_SHARD: undefined } };
  if (guardPlan) {
    for (const scope of ['server', 'client']) {
      const selected = plan[scope];
      const files = selected.mode === 'skip' ? [] : guardPlan[scope].files
        .filter(file => selected.mode === 'full' || selected.files.includes(file));
      if (files.length === 0) continue;
      files.forEach(file => guardedFiles[scope].add(file));
      stages.push({
        name: `${scope} structural guards`, suite: scope, guard: true, files,
        script: 'run-ci-tests.js', args: [scope],
        env: { ...scopeEnv[scope], ...base, CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify(files), CI_TEST_SOURCES: '[]' },
      });
    }
  }

  if (!skipLint && plan.lint.mode !== 'skip') {
    stages.push({
      name: 'client/server lint',
      suite: 'lint',
      script: 'run-ci-lint.js',
      args: [],
      env: { CI_LINT_MODE: plan.lint.mode, CI_LINT_FILES: JSON.stringify(plan.lint.files) },
    });
  }

  if (!skipLint && !skip.actionlint && workflowLintSelected(plan)) {
    stages.push({
      name: 'workflow lint (actionlint)',
      suite: 'actionlint',
      script: 'run-actionlint.js',
      args: [],
      env: { CI_LINT_MODE: plan.lint.mode, CI_LINT_FILES: JSON.stringify(plan.lint.files) },
    });
  }

  // Same env the Linux unit jobs set: the registered browser suites belong to
  // the browser stage below, and passing output stays signal-dense.
  ['server', 'client'].forEach((scope) => {
    const scoped = plan[scope];
    if (scoped.mode === 'skip') return;
    // Exact local file plans already ran these guards above. Do not depend on
    // the memo to suppress a second invocation of tree-scanning tests. Broad
    // related/full plans retain their original selection and CI semantics.
    const files = scoped.mode === 'files'
      ? scoped.files.filter(file => !guardedFiles[scope].has(file))
      : scoped.files;
    if (scoped.mode === 'files' && files.length === 0 && scoped.sources.length === 0) return;
    const stage = {
      name: `${scope} tests`,
      suite: scope,
      script: 'run-ci-tests.js',
      args: [scope],
      env: {
        ...scopeEnv[scope],
        CI_TEST_MODE: scoped.mode,
        CI_TEST_FILES: JSON.stringify(files),
        CI_TEST_SOURCES: JSON.stringify(scoped.sources),
        // Same base the planner just used. The import-growth guard fails
        // closed without it; omitting it here would make pregate compare
        // against a different ref than CI.
        ...base,
      },
    };
    // A full plan runs CI's documented shard split one shard at a time so a
    // late failure keeps the earlier shards' official memo entries. Sequential
    // stages also keep one writer per workspace's Vitest dependency record.
    const count = scoped.mode === 'full' ? FULL_SUITE_SHARDS[scope] : 1;
    if (count <= 1) {
      stages.push(stage);
      return;
    }
    for (let index = 1; index <= count; index += 1) {
      stages.push({ ...stage, name: `${stage.name} (shard ${index}/${count})`, env: { ...stage.env, CI_SHARD: `${index}/${count}` } });
    }
  });

  if (plan.build && !skip.build) {
    stages.push({ name: 'client build', suite: 'build', npm: ['run', 'build', '--prefix', 'client'], args: [], env: {} });
  }

  if (plan.smoke && !skip.smoke) {
    stages.push({ name: 'boot smoke', suite: 'smoke', script: 'smoke-boot.js', args: [], env: {} });
  }

  if (suiteSelected(plan, 'browser') && !skip.browser) {
    stages.push({
      name: 'browser suites',
      suite: 'browser',
      script: 'run-ci-tests.js',
      args: ['server'],
      env: {
        CI_TEST_MODE: 'files',
        CI_TEST_FILES: JSON.stringify(plan.browser.files),
        CI_TEST_SOURCES: '[]',
        // PRs run the smoke profile; the guards fail closed instead of skipping.
        PORTOS_BROWSER_TEST_PROFILE: 'smoke',
        PORTOS_REQUIRE_BROWSER_SUITES: '1',
        PORTOS_TEST_QUIET: '1',
        CI_SHARD: undefined,
        ...base,
      },
    });
  }

  if (plan.db && !skip.db) {
    stages.push(
      { name: 'DB provision (portos_test)', suite: 'db', npm: ['run', 'setup:db:test', '--prefix', 'server'], args: [], env: databaseEnv },
      { name: 'DB suite (portos_test)', suite: 'db', npm: ['run', 'test:db:ci', '--prefix', 'server'], args: [], env: databaseEnv },
    );
  }

  return stages;
}

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
  const clientGuards = trackedFiles.filter((path) => path.startsWith('client/src/') && isGuardTest(path));
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
    lint: { mode: 'full', files: [] },
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
 * reported as skipped.
 */
export async function focusedLocalPlan(plan, trackedFiles, changedFiles, readText = readRepoText) {
  const local = downgradeFullPlan(plan, trackedFiles, changedFiles);
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
  // suite selected for an import never counts against it.
  if (changedData.length) {
    const candidates = candidateTests().filter(test => !HEAVY_SUITES.has(test));
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

const git = (args, cwd = REPO_ROOT, input) => execFileSync('git', args, {
  cwd, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
});
const gitPaths = (args, cwd, input) => git(args, cwd, input).split('\0').filter(Boolean);

/** Read HEAD, unmerged entries and all uncommitted paths from one porcelain walk. */
function worktreeStatus(cwd = REPO_ROOT) {
  const entries = gitPaths(['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '--no-renames',
    '--untracked-files=all', '--ignore-submodules=none', '-z'], cwd);
  const files = new Set();
  const conflicts = [];
  const indexAdds = new Set();
  const indexDeletes = new Set();
  let head;
  for (const entry of entries) {
    if (entry.startsWith('# branch.oid ')) head = entry.slice('# branch.oid '.length);
    else if (entry.startsWith('? ')) files.add(entry.slice(2));
    else if (entry.startsWith('1 ')) {
      const [, indexStatus, headMode, path] = /^1 (\S)\S \S+ (\S+) (?:\S+ ){4}([\s\S]+)$/.exec(entry);
      files.add(path);
      if (indexStatus === 'D') indexDeletes.add(path);
      // A zero HEAD mode also covers intent-to-add, which has index status '.'.
      else if (headMode === '000000') indexAdds.add(path);
    }
    else if (entry.startsWith('u ')) conflicts.push(entry.replace(/^u (?:\S+ ){9}/, ''));
  }
  return { head, files: [...files].sort(), conflicts: conflicts.sort(), indexAdds, indexDeletes };
}

/** Read the committed path inventory and the branch diff in one Git process. */
export function collectPregateInputs(baseSha, headTree, { cwd = REPO_ROOT, status = worktreeStatus(cwd) } = {}) {
  const emptyTree = createHash(headTree.length === 40 ? 'sha1' : 'sha256').update('tree 0\0').digest('hex');
  // In stdin mode Git echoes the tree pair, then prefixes the commit diff
  // with its SHA, even when that diff is empty (--always).
  const inventoryHeader = `${emptyTree} ${headTree}\n`;
  const output = git(['diff-tree', '--stdin', '--name-status', '-r', '-z', '--always',
    '--no-renames', '--ignore-submodules=none'], cwd, `${inventoryHeader}${status.head} ${baseSha}\n`);
  if (!output.startsWith(inventoryHeader)) throw new Error('Missing path inventory from git diff-tree.');
  const entries = output.slice(inventoryHeader.length).split('\0').filter(Boolean);
  const tracked = new Set(status.indexAdds);
  const changed = new Set(status.files);
  let branchDiff = false;
  for (let i = 0; i < entries.length;) {
    const marker = entries[i++];
    if (marker === status.head && !branchDiff) {
      branchDiff = true;
      continue;
    }
    const path = entries[i++];
    if (!path || !/^[ADMT]$/.test(marker)) throw new Error('Unexpected path inventory from git diff-tree.');
    if (branchDiff) changed.add(path);
    else if (!status.indexDeletes.has(path)) tracked.add(path);
  }
  if (!branchDiff) throw new Error('Missing branch diff from git diff-tree.');
  return {
    changedFiles: [...changed].sort(),
    trackedFiles: [...tracked].sort(),
    workingTreeFiles: status.files,
  };
}

/** Resolve repository and ref metadata together. origin/HEAD may be unset in a worktree or fork. */
function repoState(base) {
  const args = ['rev-parse', '--path-format=absolute', '--git-path', 'index', '--git-common-dir', '--git-dir', 'HEAD', 'HEAD^{tree}'];
  const defaultRef = 'refs/remotes/origin/HEAD';
  args.push('--revs-only', `${base || defaultRef}...HEAD`);
  if (!base) args.push('--symbolic-full-name', defaultRef);
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const [indexPath, commonDir, gitDir, head, tree, ...refs] = (result.stdout ?? '').trimEnd().split('\n');
  const remoteDefault = refs.find(ref => ref.startsWith('refs/remotes/'));
  // Some Git versions return a nonzero status for the optional trailing ref.
  // Trust the mandatory fields only if the command actually resolved them.
  const validObjects = [head, tree].every(id => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id ?? ''));
  if (!indexPath || !commonDir || !gitDir || !validObjects || result.error || result.signal
    || (result.status !== 0 && result.status !== 128)) {
    throw new Error('Cannot resolve the Git worktree, index and HEAD tree for pregate.');
  }
  const baseRef = base || remoteDefault?.replace(/^refs\/remotes\//, '') || 'origin/main';
  const mergeBases = refs.filter(ref => ref.startsWith('^')).map(ref => ref.slice(1));
  // The three-dot range reports all merge bases. Keep Git's usual choice on
  // criss-cross histories and the origin/main fallback when origin/HEAD is unset.
  const baseSha = mergeBases.length === 1 ? mergeBases[0] : resolveMergeBase(baseRef, head);
  return { indexPath, commonDir, gitDir, head, tree, baseRef, baseSha };
}

function resolveMergeBase(baseRef, headSha) {
  const result = spawnSync('git', ['merge-base', baseRef, headSha], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`❌ Cannot resolve a merge base with ${baseRef} — fetch it first (git fetch origin).`);
    process.exit(2);
  }
  return result.stdout.trim();
}

export const USAGE = `Usage: node scripts/pregate.js [--base <ref>] [--full] [--skip-lint] [--plan-only]
                              [--skip-db] [--skip-browser] [--skip-build] [--skip-smoke]

  --guards-only  run only always-run and diff-selected structural guards
  --base <ref>    compare against <ref> instead of the remote default branch
  --full          opt into CI-selected broad suites locally
  --skip-lint     skip linting in both client and server workspaces
  --skip-db       leave the portos_test DB suite to CI (reported as not run)
  --skip-browser  leave the cross-workspace browser suites to CI (reported as not run)
  --skip-build    leave the client build and its bundle pin to CI (reported as not run)
  --skip-smoke    leave the server boot smoke to CI (reported as not run)
  --plan-only     print the plan and stages without running them
  -h, --help      display this usage`;

const SKIP_FLAGS = { '--skip-db': 'skipDb', '--skip-browser': 'skipBrowser', '--skip-build': 'skipBuild', '--skip-smoke': 'skipSmoke' };

/** Parse argv before doing any Git inspection or starting a child process. */
export function parseArgs(argv) {
  const options = {
    base: null, full: false, skipLint: false, planOnly: false, help: false, guardsOnly: false,
    skipDb: false, skipBrowser: false, skipBuild: false, skipSmoke: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--guards-only': options.guardsOnly = true; break;
      case '--base': {
        const value = argv[index + 1];
        if (!value || value.startsWith('-')) throw new Error('--base requires a value.');
        if (options.base === null) options.base = value;
        index += 1;
        break;
      }
      case '--full': options.full = true; break;
      case '--skip-lint': options.skipLint = true; break;
      case '--plan-only': options.planOnly = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default:
        if (SKIP_FLAGS[flag]) { options[SKIP_FLAGS[flag]] = true; break; }
        throw new Error(`Unknown option: ${flag}.`);
    }
  }
  if (options.guardsOnly && (options.full || options.skipLint || options.skipDb || options.skipBrowser || options.skipBuild || options.skipSmoke)) {
    throw new Error('--guards-only cannot be combined with --full or --skip-* options.');
  }
  return options;
}

/** Spawn target for a stage: a repo script under node, or npm itself. */
function stageSpawn(stage, env) {
  if (!stage.npm) return { command: process.execPath, args: [join(REPO_ROOT, 'scripts', stage.script), ...stage.args] };
  // A bare `npm` is a `.cmd` shim on Windows; resolve and wrap it the way every
  // other npm spawn in this tree does (server/lib/bufferedSpawn.js).
  return prepareWindowsSafeSpawn(resolveWindowsExecutable('npm', IS_WIN32, env) || 'npm', stage.npm, IS_WIN32);
}

/** How long a cancelled stage may wind down before its whole group is killed. Exceeds run-ci-tests.js's own 2s npm escalation. */
const STAGE_CANCEL_GRACE_MS = 5000;
/** Bound on proving a killed stage group empty; past it the cancellation is reported unverified. */
const STAGE_SETTLE_MS = 5000;

/**
 * Owner signal handling for the whole stage loop. A Ctrl-C reaches pregate
 * twice — from the terminal's process group and again forwarded by `npm run`.
 * A handler that removed itself on the first restored the default action, so
 * the duplicate killed pregate before it signalled the stage group and the
 * detached runner kept testing (#12641). These handlers stay installed,
 * absorb duplicates, and are released only after every owned group settled.
 */
function installOwnerCancellation() {
  const owner = { signal: null, onSignal: null };
  const handlers = ['SIGINT', 'SIGTERM'].map((signal) => {
    const handler = () => {
      if (owner.signal) return;
      owner.signal = signal;
      owner.onSignal?.(signal);
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  owner.release = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  return owner;
}

function signalStage(child, signal) {
  try {
    if (IS_WIN32) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') writeSync(2, `❌ Stage cancellation failed: ${error.code ?? 'unknown'}.\n`);
  }
}

const within = (promise, ms) => {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Stop a stage and everything in its process group before pregate finishes:
 * forward the owner's signal, give the stage its grace to report, kill the
 * group if it is still running, then kill any member that outlived the
 * leader until the group no longer exists. Resolves `{ settled, reason? }`.
 */
async function cancelStage(stage, child, closed, signal) {
  writeSync(2, `❌ Pregate incomplete: stage="${stage.name}" owner_pid=${process.pid} child_pid=${child.pid ?? 'unavailable'} received_signal=${signal}.\n`);
  if (!child.pid) return { settled: true };
  signalStage(child, signal);
  if (!await within(closed, STAGE_CANCEL_GRACE_MS)) {
    writeSync(2, `⚠️ Stage "${stage.name}" outlived its ${STAGE_CANCEL_GRACE_MS / 1000}s cancellation grace; killing its process group.\n`);
    signalStage(child, 'SIGKILL');
    if (!await within(closed, STAGE_SETTLE_MS)) return { settled: false, reason: 'stage process did not exit after SIGKILL' };
  }
  return IS_WIN32 ? { settled: true } : sweepStageGroup(child.pid);
}

/** Bounded diagnostic only: ps is never evidence that an owned group is absent. */
function describeStageGroup(pgid, timeoutMs) {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], {
    encoding: 'utf8', timeout: Math.min(1000, timeoutMs), maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return `unavailable (${result.error?.code ?? result.status ?? result.signal ?? 'unknown'})`;
  const members = result.stdout.split('\n').map(line => line.trim().split(/\s+/))
    .filter(([, group]) => Number(group) === pgid);
  // No command lines, arguments, identities, or unrelated processes in evidence.
  return members.slice(0, 16).map(([pid, , state]) => `${pid}:${state}`).join(',')
    + (members.length > 16 ? ',…' : '') || 'none observed';
}

/**
 * Kill whatever outlived a stage leader. Only ESRCH for the exact owned group
 * proves settlement. Darwin can return EPERM for an existing zombie-only
 * group (XNU killpg1 filters SZOMB); wait for reaping with read-only probes,
 * within the original deadline, rather than mistaking refusal for permission
 * trouble or treating zombies/ps output as proof of absence.
 */
export async function sweepStageGroup(pgid, {
  kill = process.kill, now = Date.now, wait = delay, inspect = describeStageGroup,
} = {}) {
  const deadline = now() + STAGE_SETTLE_MS;
  const membership = () => inspect(pgid, Math.max(1, deadline - now()));
  for (let attempt = 0; ; attempt += 1) {
    try {
      kill(-pgid, 'SIGKILL');
    } catch (error) {
      if (error.code === 'ESRCH') return { settled: true, lingered: attempt > 0 };
      const refusal = `group kill failed (${error.code ?? 'unknown'})`;
      if (error.code !== 'EPERM') return { settled: false, reason: `${refusal}; pgid=${pgid}; members=${membership()}` };
      let members;
      let lingered = attempt > 0;
      for (;;) {
        let probe = 'present';
        try {
          kill(-pgid, 0);
        } catch (probeError) {
          if (probeError.code === 'ESRCH') return { settled: true, lingered };
          probe = probeError.code ?? 'unknown';
        }
        lingered = true;
        members ??= membership();
        if (!['present', 'EPERM'].includes(probe) || now() >= deadline) {
          return { settled: false, reason: `${refusal}; pgid=${pgid}; probe=${probe}; members=${members}` };
        }
        await wait(Math.min(25, Math.max(0, deadline - now())));
      }
    }
    if (now() >= deadline) return { settled: false, reason: 'group members remained after SIGKILL' };
    await wait(25);
  }
}

/** Run one stage; an owner signal during it resolves only after the stage group settled. */
async function runStage(stage, owner) {
  const env = stageSpawnEnv(process.env, stage.env);
  const { command, args } = stageSpawn(stage, env);
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
    // A separate group lets cancellation reach only this stage's descendants.
    detached: !IS_WIN32,
  });
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  let cancellation = null;
  let interrupted = null;
  owner.onSignal = (signal) => {
    interrupted = signal;
    cancellation = cancelStage(stage, child, closed, signal);
  };
  const outcome = await closed;
  owner.onSignal = null;
  if (cancellation) return { ...outcome, pid: child.pid, interrupted, ...await cancellation };
  if (IS_WIN32 || !child.pid) return { ...outcome, pid: child.pid };
  const sweep = await sweepStageGroup(child.pid);
  if (sweep.lingered) writeSync(2, `⚠️ Stage "${stage.name}" exited before its process group settled; verified group exit.\n`);
  return { ...outcome, pid: child.pid, ...(sweep.settled ? {} : { unsettled: sweep.reason }) };
}

const formatDuration = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`);

function announceUncovered(uncovered, focused) {
  const prefix = focused ? 'Hosted CI may also run' : 'CI will also run';
  uncovered.forEach(({ suite, reason, remedy }) => {
    console.log(`ℹ️ ${prefix}: ${suite} — not run here (${reason}); ${remedy}`);
  });
}

/** Probe what the selected resource suites need; a failed probe keeps that suite with CI. */
async function probeResourceSuites(plan, { options, downgraded }) {
  const prerequisites = {};
  let databaseEnv = {};
  const wants = (suite, flag) => suiteSelected(plan, suite) && !flag && !downgraded;
  const wantsDb = wants('db', options.skipDb);
  const wantsBrowser = wants('browser', options.skipBrowser);
  if (!wantsDb && !wantsBrowser) return { prerequisites, databaseEnv };
  // Reaches `pg`, `playwright-core` and server modules: loaded only when needed.
  const resources = await import('./lib/pregateResources.js');
  if (wantsDb) {
    databaseEnv = resources.resolveTestDatabaseStageEnv(REPO_ROOT, process.env);
    prerequisites.db = await resources.probeTestDatabase(databaseEnv, { repoRoot: REPO_ROOT });
    if (prerequisites.db.ok) {
      console.log(`🗄️ Test database ${prerequisites.db.endpoint} ${prerequisites.db.provision ? 'will be provisioned' : 'is reachable'}.`);
    } else {
      console.warn(`⏭️ Test database ${prerequisites.db.endpoint}: ${prerequisites.db.reason}.`);
    }
  }
  if (wantsBrowser) {
    prerequisites.browser = await resources.probeBrowserPrerequisites(plan.browser.files, { repoRoot: REPO_ROOT });
    if (!prerequisites.browser.ok) console.warn(`⏭️ Browser suites: ${prerequisites.browser.reason}.`);
  }
  return { prerequisites, databaseEnv };
}

/**
 * Map a runStage outcome onto the stage record: marks `result` failed (with its
 * signal or exit code) and returns the failure line and process exit code, or
 * null when the stage passed. Exit codes are 128 + signal for cancellation and
 * child signals, otherwise the stage status (1 when unavailable).
 */
function stageOutcomeVerdict(result, outcome) {
  if (outcome.interrupted) {
    result.status = 'failed';
    result.signal = outcome.interrupted;
    return {
      failure: outcome.settled
        ? `❌ Pregate incomplete: stage="${result.name}" cancelled by ${outcome.interrupted}; its process group has exited.`
        : `❌ Pregate incomplete: stage="${result.name}" cancelled by ${outcome.interrupted}; owned process group settlement unverified (${outcome.reason}).`,
      exitCode: 128 + constants.signals[outcome.interrupted],
    };
  }
  if (outcome.unsettled) {
    result.status = 'failed';
    return { failure: `❌ ${result.name} left processes in its group that could not be stopped (${outcome.unsettled}).`, exitCode: 1 };
  }
  if (outcome.error) {
    result.status = 'failed';
    return { failure: `❌ ${result.name} could not start: ${outcome.error.message}`, exitCode: 1 };
  }
  if (outcome.signal) {
    result.status = 'failed';
    result.signal = outcome.signal;
    return {
      failure: `❌ Pregate incomplete: stage="${result.name}" owner_pid=${process.pid} child_pid=${outcome.pid} child_signal=${outcome.signal}.`,
      exitCode: constants.signals[outcome.signal] ? 128 + constants.signals[outcome.signal] : 1,
    };
  }
  if (outcome.status !== 0) {
    result.status = 'failed';
    result.exitCode = outcome.status;
    return {
      failure: `❌ ${result.name} failed after ${formatDuration(result.durationMs)} — fix it before pushing (CI would fail the same way).`,
      exitCode: outcome.status ?? 1,
    };
  }
  return null;
}

/**
 * Name the guards of a passed stage over the per-guard target: each structural
 * guard runner's checks, and every other guard file whole (scripts/lib/guardBudget.js).
 * Report only: local wall time measures this host's contention as much as the
 * guard, so the scheduled hosted run enforces the budget on its uniform runner (#16551, #16810).
 */
function reportSlowGuards(result) {
  const over = overBudgetGuards(result.guardDurations);
  if (over.length > 0) {
    console.log(`🐢 ${result.name} over the ${formatDuration(GUARD_BUDGET_MS)} per-guard target: ${describeGuardDurations(over)} (the scheduled hosted run fails a guard over ${formatDuration(CI_GUARD_BUDGET_MS)}; PR and push runs only warn).`);
  }
}

/**
 * A fresh `git worktree add` checkout has no node_modules. Creating the
 * symlinks is non-destructive (the linker never replaces a real dependency
 * directory) and is exactly what the diagnostic used to ask the agent to type,
 * so do it once and re-check. Never runs npm; stale versions stay diagnostics.
 */
function autoLinkWorktreeDependencies(problems, { commonDir, gitDir }) {
  if (!problems.some(({ linked, directoryAvailable }) => !linked || !directoryAvailable)) return problems;
  if (commonDir === gitDir) return problems;
  const primaryCheckout = resolve(commonDir, '..');
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'link-worktree-deps.js'), primaryCheckout, REPO_ROOT], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.log(`⚠️ Worktree dependency auto-link did not complete: ${(result.stderr || result.error?.message || '').trim()}`);
    return problems;
  }
  console.log('🔗 Linked worktree dependencies from the primary checkout');
  return dependencyConsistencyProblems(REPO_ROOT);
}

/** Print each dependency-consistency problem with the re-link or reconcile hint that fits its checkout. */
function reportDependencyProblems(problems, { commonDir, gitDir }, warnOnly) {
  const primaryCheckout = commonDir === gitDir ? null : resolve(commonDir, '..');
  const print = warnOnly ? console.log : console.error;

  print(warnOnly
    ? '⚠️ Linked dependency version drift; continuing with the installed versions because the diff has no npm manifest or lockfile changes.'
    : '❌ Dependency consistency preflight failed; lint/tests have not run.');
  for (const { label, linked, owner, directoryAvailable, issues } of problems) {
    print(`  ${label} (${linked ? 'linked' : 'owned'} node_modules):\n${issues.map(issue => `    ${issue}`).join('\n')}`);
    if (primaryCheckout && (!linked || !directoryAvailable)) {
      print(`    Worktree dependency dir is missing or unlinked for ${label}. Re-link with: node scripts/link-worktree-deps.js ${primaryCheckout} ${REPO_ROOT}`);
    } else {
      const home = homedir();
      const displayOwner = owner === home ? '~' : owner.startsWith(`${home}${sep}`) ? `~${owner.slice(home.length)}` : owner;
      print(linked
        ? `    Reconcile dependencies in the owning source checkout (${JSON.stringify(displayOwner)}), with a full development install (npm ci --include=dev), or validate in a separate clone with its own locked installs. Never run npm install/ci through worktree links.`
        : `    Reconcile this checkout's dependencies from its committed lockfiles (npm ci --include=dev in the owning workspace), then rerun pregate.`);
    }
  }
}

/** Run the CI planner against the changed files and return its raw step outputs; exits 2 when it fails. */
function runCiTestPlan(baseSha, changedFiles) {
  const planned = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'ci-test-plan.js')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // The planner writes step outputs when Actions' env is present; stripping
    // it keeps a local run from appending to a stale $GITHUB_OUTPUT file.
    env: {
      ...process.env,
      CI_BASE_SHA: baseSha,
      CI_CHANGED_FILES: JSON.stringify(changedFiles),
      CI_FORCE_FULL: 'false',
      CI_BASE_REF: '',
      GITHUB_OUTPUT: '',
      GITHUB_STEP_SUMMARY: '',
    },
  });
  if (planned.status !== 0) {
    console.error(`❌ ci-test-plan.js failed: ${planned.stderr || planned.error?.message || 'unknown error'}`);
    process.exit(2);
  }
  return JSON.parse(planned.stdout);
}

/** Map the planner's printed plan (githubPlanOutput() keys) into the plan shape the stages consume. */
function pregatePlanFromRaw(raw) {
  return {
    full: raw.full,
    reason: raw.reason,
    server: { mode: raw.server_mode, files: raw.server_files, sources: raw.server_sources },
    client: { mode: raw.client_mode, files: raw.client_files, sources: raw.client_sources },
    lint: { mode: raw.lint_mode, files: raw.lint_files },
    browser: { files: raw.browser_files },
    db: raw.db,
    windows: raw.windows,
    build: raw.build,
    smoke: raw.smoke,
    linuxContainment: raw.linux_containment,
    supercolliderLive: raw.supercollider_live,
    dockerContainmentLive: raw.docker_containment_live,
    macosNative: raw.macos_native,
    suiteReasons: raw.suite_reasons,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }

  assertNodeVersion();

  const status = worktreeStatus();
  if (status.conflicts.length > 0) {
    console.error(`❌ Cannot run pregate with unresolved Git conflicts:\n${status.conflicts.map((path) => `  ${path}`).join('\n')}`);
    process.exit(1);
  }

  const repo = repoState(options.base);
  const { baseRef, baseSha, head: headSha, indexPath } = repo;
  if (headSha !== status.head) throw new Error('HEAD moved while pregate was planning; rerun on the resulting tree.');
  console.log(`🔎 Planning against ${baseRef} (${baseSha.slice(0, 9)}).`);

  const { changedFiles, trackedFiles: indexFiles, workingTreeFiles } = collectPregateInputs(baseSha, repo.tree, { status });
  if (workingTreeFiles.length > 0) {
    console.log(`📝 Included ${workingTreeFiles.length} uncommitted changed file(s) in this plan.`);
  }
  // A clean status already proves the committed tree. Snapshot dirty input
  // before selection reads so a mid-plan edit also invalidates the receipt.
  const initiallyClean = workingTreeFiles.length === 0;
  const hashWorkingTree = createWorkingTreeHasher(REPO_ROOT, { indexPath });
  let tree = initiallyClean ? repo.tree : null;
  let initialHashError;
  if (!initiallyClean && !options.planOnly) {
    try {
      tree = hashWorkingTree();
    } catch (error) {
      // Let the hidden-content scan give the more specific diagnostic for
      // unreadable input, such as a nested repo with no checked-out HEAD.
      initialHashError = error.message;
    }
  }

  const changedOnDisk = new Set(workingTreeFiles);
  const trackedFiles = indexFiles.filter(path => !changedOnDisk.has(path) || existsSync(join(REPO_ROOT, path)));
  const presentFiles = [...new Set([...trackedFiles, ...workingTreeFiles.filter(path => existsSync(join(REPO_ROOT, path)))])].sort();
  const downgraded = !options.full && !options.guardsOnly;
  // The pure planner supplies direct resource risk and suite ownership for the
  // focused summary. The hosted reach/closure/input walks belong to --full.
  let plan;
  if (options.full) {
    plan = pregatePlanFromRaw(runCiTestPlan(baseSha, changedFiles));
  } else if (options.guardsOnly) {
    plan = { reason: 'structural guards', browser: { files: [] } };
  } else {
    const { browserFiles, ...summary } = buildCiTestPlan(changedFiles, {
      trackedFiles: presentFiles,
      linuxContainmentInputs: [],
      supercolliderLiveInputs: [],
      dockerContainmentLiveInputs: [],
    });
    plan = { ...summary, browser: { files: browserFiles } };
  }
  console.log(`📋 ${changedFiles.length} changed file(s) — ${plan.reason}.`);

  const guardPlan = downgradeFullPlan(plan, trackedFiles, changedFiles);
  if (options.guardsOnly) plan = { ...guardPlan, lint: { mode: 'skip', files: [] } };
  if (downgraded) {
    plan = await focusedLocalPlan(plan, presentFiles, changedFiles);
    console.log('ℹ️ Local validation: lint, structural guards and focused tests only. Hosted CI owns broad coverage; pass --full for the complete CI plan locally.');
  }

  describeBrowserSelection(plan.browser.files).forEach((line) => { console.log(line); });

  /** Stages for the suites that stay here, after the uncovered ones are announced. */
  const planStages = (prerequisites, databaseEnv) => {
    // actionlint is a local tool probe, not a resource suite: it needs no Chrome or DB.
    const tools = { actionlint: workflowLintSelected(plan) ? probeActionlint() : null, ...prerequisites };
    const uncovered = uncoveredSuites(plan, { options, downgraded, prerequisites: tools });
    const skip = Object.fromEntries(uncovered.map(({ suite }) => [suite, true]));
    const stages = resolvePlanStages(plan, { skipLint: options.skipLint, baseSha, baseRef, skip, databaseEnv,
      guardPlan: options.guardsOnly ? null : guardPlan });
    return { uncovered, stages: options.guardsOnly
      ? stages.filter(stage => stage.suite === 'server' || stage.suite === 'client')
        .map(stage => ({ ...stage, env: { ...stage.env, PORTOS_TEST_MEMO: 'off' } }))
      : stages };
  };

  if (options.planOnly) {
    // Prerequisites are probed at run time; here every selected suite is a stage.
    const { uncovered, stages } = planStages({}, {});
    announceUncovered(uncovered, downgraded);
    stages.forEach((stage) => {
      console.log(`• ${stage.name}: ${describeStageCommand(stage)}`);
    });
    process.exit(0);
  }

  const dependencyProblems = autoLinkWorktreeDependencies(dependencyConsistencyProblems(REPO_ROOT), repo);
  if (dependencyProblems.length > 0) {
    const dependencyFilesChanged = changedFiles.some(path => /(?:^|\/)(?:package(?:-lock)?|npm-shrinkwrap)\.json$/.test(path));
    const warnOnly = repo.commonDir !== repo.gitDir && !dependencyFilesChanged
      && dependencyProblems.every(({ linked, versionMismatchOnly }) => linked && versionMismatchOnly);
    reportDependencyProblems(dependencyProblems, repo, warnOnly);
    if (!warnOnly) process.exit(1);
  } else {
    console.log('✅ Dependency consistency preflight passed (installed package versions match workspace locks).');
  }
  const { PORTOS_PREGATE_MAX_WORKERS: maxWorkers } = pregateWorkerEnv(process.env, dirname(repo.commonDir));

  let { uncovered, stages } = planStages({}, {});

  const startedAt = new Date().toISOString();
  const owner = installOwnerCancellation();
  if (tree !== null) console.log(`🌳 Validating working tree ${tree.slice(0, 12)} at HEAD ${headSha.slice(0, 9)}.`);

  const stageResult = (stage) => ({ ...stage, command: describeStageCommand(stage), status: 'not-run', durationMs: 0 });
  const results = stages.map(stageResult);
  let exitCode = 0;
  let failure = null;
  let probed = false;
  for (let index = 0; index < results.length; index += 1) {
    if (failure || owner.signal) break;
    let result = results[index];
    if (initialHashError && result.suite !== 'scan') break;
    // Even prerequisite probes may start Chrome. Defer them until every early
    // guard has passed, retaining not-run resource stages on an early failure.
    if (!probed && !result.guard && result.suite !== 'scan') {
      const { prerequisites, databaseEnv } = await probeResourceSuites(plan, { options, downgraded });
      ({ uncovered, stages } = planStages(prerequisites, databaseEnv));
      announceUncovered(uncovered, downgraded);
      results.splice(index, results.length - index, ...stages.slice(index).map(stageResult));
      probed = true;
      result = results[index];
      if (!result || owner.signal) break;
    }
    console.log(`▶️ ${result.name}`);
    const durationsDir = result.guard ? mkdtempSync(join(tmpdir(), 'portos-pregate-durations-')) : null;
    const durationsPath = durationsDir && join(durationsDir, 'durations.json');
    if (durationsPath) result.env = { ...result.env, PORTOS_PREGATE_DURATIONS_PATH: durationsPath };
    const started = Date.now();
    const outcome = await runStage(result, owner);
    result.durationMs = Date.now() - started;
    if (durationsDir) {
      result.guardDurations = readGuardDurations(durationsPath);
      rmSync(durationsDir, { recursive: true, force: true });
    }
    const verdict = stageOutcomeVerdict(result, outcome);
    if (verdict) {
      ({ failure, exitCode } = verdict);
    } else {
      if (result.guard) reportSlowGuards(result);
      result.status = 'passed';
      result.exitCode = 0;
      console.log(`✔️ ${result.name} passed in ${formatDuration(result.durationMs)}.`);
    }
  }

  // A signal after the last stage ran (e.g. during its group sweep) leaves the
  // completed run's receipt; it is reported below and still ends the process.
  if (owner.signal && !failure && results.some((stage) => stage.status === 'not-run')) {
    writeSync(2, `❌ Pregate incomplete: owner_pid=${process.pid} received_signal=${owner.signal} between stages.\n`);
    failure = `❌ Pregate incomplete: cancelled by ${owner.signal} before every stage ran.`;
    exitCode = 128 + constants.signals[owner.signal];
  }

  let treeAfterRun = null;
  try {
    if (initialHashError) throw new Error(initialHashError);
    const after = initiallyClean ? worktreeStatus() : null;
    treeAfterRun = after?.head === headSha && after.files.length === 0 && after.conflicts.length === 0
      ? repo.tree
      : hashWorkingTree();
  } catch (error) {
    failure ??= `❌ Cannot hash the working tree for the receipt: ${error.message}`;
    if (exitCode === 0) exitCode = 2;
  }
  const report = buildPregateReport({
    plan,
    options: { base: baseRef, full: options.full, skipLint: options.skipLint, skipDb: options.skipDb, skipBrowser: options.skipBrowser, skipBuild: options.skipBuild, skipSmoke: options.skipSmoke },
    base: { ref: baseRef, sha: baseSha },
    head: { sha: headSha },
    tree,
    treeAfterRun,
    stages: results,
    skipped: uncovered,
    downgraded,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, maxWorkers },
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  if (!options.guardsOnly) writePregateReport(REPO_ROOT, report);
  // Synchronous: a piped stderr is written asynchronously, and the self-signal
  // below would drop these lines before they flush.
  if (tree !== null && !report.treeStable && !failure) {
    failure = `❌ The working tree changed while pregate ran (${tree.slice(0, 12)} → ${treeAfterRun?.slice(0, 12) ?? 'unhashable'}); rerun on the resulting tree.`;
    exitCode = 1;
  }
  if (failure) writeSync(2, `${failure}\n${options.guardsOnly ? '' : `📄 Receipt: ${PREGATE_REPORT_PATH}\n`}`);
  else if (owner.signal) writeSync(2, `⚠️ Received ${owner.signal} after every stage passed; the receipt records that completed run.\n`);

  owner.release();
  // Every owned group has settled and the receipt is written; end the way the
  // caller's signal asked.
  if (owner.signal) process.kill(process.pid, owner.signal);
  if (failure) process.exit(exitCode);

  const ran = results.map((stage) => stage.name).join(', ');
  console.log(`✅ Pregate passed: ${ran}.`);
  if (uncovered.length > 0) {
    console.log(`⚠️ Not run here (${downgraded ? 'hosted CI determines coverage' : 'CI still proves them'}): ${uncovered.map(({ suite, reason }) => `${suite} (${reason})`).join(', ')}.`);
  }
  if (!options.guardsOnly) console.log(`📄 Receipt: ${PREGATE_REPORT_PATH}`);
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch((error) => {
    console.error(`❌ Pregate incomplete: ${error.message}`);
    process.exitCode = 1;
  });
}
