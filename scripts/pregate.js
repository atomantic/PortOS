#!/usr/bin/env node

/**
 * Run the checks CI will run on this branch — locally, before pushing.
 *
 * CI already decides what to run from the diff (`scripts/ci-test-plan.js`),
 * but nothing could ask it that question outside Actions, so the recurring
 * failures were the ones no local command covers: an import-budget overshoot
 * that only appears after a rebase, a server->client import-purity violation,
 * a doubled catalog row from a union merge, a tree-wide guard that no changed
 * file imports. Each cost a push, a ~20-minute CI round, and a diagnosis from
 * a log. They are all static and take seconds to answer here.
 *
 * This runs CI's hidden-content scan and hands the SAME planner's plan to the
 * SAME runners (`run-ci-lint.js`, `run-ci-tests.js`, the client build, the
 * boot smoke, the browser suites and the serial `portos_test` suite), so a
 * green pregate means the Linux jobs are green for the same reasons — never
 * a second, drifting opinion about which tests matter. Stages run in CI's
 * dependency order, with the DB suite last and alone: it is serial and its
 * per-case budgets assume no concurrent suite (docs/CONTRIBUTING.md).
 *
 *   node scripts/pregate.js [--base <ref>] [--full] [--skip-lint] [--plan-only]
 *                           [--skip-db] [--skip-browser] [--skip-build] [--skip-smoke]
 *
 *   --base <ref>    compare against <ref> instead of the remote default branch
 *   --full          actually run the complete suite when the plan demands it
 *                   (without this, a full plan runs the always-run guards only
 *                   and reports the resource suites as not run)
 *   --skip-lint     skip linting in both client and server workspaces
 *   --skip-db, --skip-browser, --skip-build, --skip-smoke
 *                   leave that suite to CI; it is reported as not run
 *   --plan-only     print the plan and the stages, run nothing
 *
 * A resource suite whose prerequisite this machine lacks (no reachable test
 * Postgres; no Chrome, ffmpeg or client bundler) is reported the same way, with
 * the remedy, and the run continues. The summary and the receipt both name
 * every suite that was NOT run, so a green result never claims a suite it
 * skipped. The Windows job and the Linux worker-containment job (bubblewrap
 * namespaces) are the suites only CI can prove.
 *
 * The receipt (`.cache/pregate/report.json`, see scripts/lib/pregateReport.js)
 * records the plan, each stage's outcome and duration, the skipped suites, the
 * base and HEAD commits, and the hash of the exact working tree validated —
 * untracked and uncommitted files included — so a later attestation can match
 * it to the commit that ships. Attesting is deliberately NOT a flag here:
 * pregate runs before the commit and the push, and a commit status can only
 * be posted on a pushed commit, so `node scripts/pregate-attest.js` is its
 * own step after `git push` (docs/GITHUB_ACTIONS.md "Pregate attestation").
 */

import { spawn, spawnSync } from 'child_process';
import { writeSync } from 'fs';
import { constants } from 'os';
import { setTimeout as delay } from 'timers/promises';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { prepareWindowsSafeSpawn, resolveWindowsExecutable } from '../server/lib/aiToolkit/internal/windowsSafeSpawn.js';
import { ALWAYS_RUN_TESTS, structuralTestsFor } from './ci-test-plan.js';
import { assertNodeVersion } from './checkNodeVersion.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { needsBrowserFidelity } from './lib/browserFidelity.js';
import { buildPregateReport, PREGATE_REPORT_PATH, validatedTreeHash, writePregateReport } from './lib/pregateReport.js';
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
  db: 'needs a reachable test Postgres: npm run setup:db:test && npm run test:db (never against the real `portos` database)',
  browser: 'needs Chrome, ffmpeg and the client bundler; run `npm run pregate --full` once they are installed',
  build: 'npm run build && npm run test --prefix client -- ApiExplorer.bundle',
  smoke: 'npm run smoke',
  windows: 'CI is the only proof',
  linuxContainment: 'a Linux host with bubblewrap: PORTOS_REQUIRE_LINUX_CONTAINMENT=1 npm test --prefix server -- --run <LINUX_CONTAINMENT_TESTS>',
  supercolliderLive: 'a native amd64/arm64 Linux Docker engine: npm run setup:supercollider -- --yes, then PORTOS_SUPERCOLLIDER_LIVE=1 npx vitest run services/superColliderRender.live.test.js from server/',
});

/** Remedy when a prerequisite probe ran but failed (timeout, teardown): nothing indicates a missing install. */
const PROBE_FAILED_REMEDY = 'the prerequisite probe itself failed, which does not show anything is missing; rerun `npm run pregate`, and if it repeats diagnose Chrome startup/teardown before reinstalling anything';

/** Does the plan select this suite at all? `browser` is a file list, the rest flags. */
export function suiteSelected(plan, suite) {
  return suite === 'browser' ? (plan.browser?.files?.length ?? 0) > 0 : Boolean(plan[suite]);
}

/**
 * Every suite CI would run that this run does not, with the reason.
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
    else if (downgraded) reason = 'full plan downgraded; pass --full to run it';
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
  if (suiteSelected(plan, 'windows')) {
    uncovered.push({ suite: 'windows', reason: 'a Windows runner has no local equivalent', remedy: UNCOVERED_SUITES.windows });
  }
  if (suiteSelected(plan, 'linuxContainment')) {
    uncovered.push({ suite: 'linuxContainment', reason: 'needs a Linux host with bubblewrap namespaces', remedy: UNCOVERED_SUITES.linuxContainment });
  }
  if (suiteSelected(plan, 'supercolliderLive')) {
    uncovered.push({ suite: 'supercolliderLive', reason: 'needs a native Linux Docker engine on amd64 and arm64', remedy: UNCOVERED_SUITES.supercolliderLive });
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
export const PREGATE_DEFAULT_MAX_WORKERS = '4';

/**
 * Env for a stage child: bound Vitest workers unless the operator chose a
 * budget. Direct `npm test` never passes through here, so it stays unbounded.
 */
export function pregateWorkerEnv(env) {
  return { ...env, PORTOS_PREGATE_MAX_WORKERS: env.PORTOS_PREGATE_MAX_WORKERS || PREGATE_DEFAULT_MAX_WORKERS };
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
 * work, and the shipped prompt-history guard (CI's `prompt-history` job: one
 * git-history read, seconds locally) follows it when selected. Order after
 * that follows CI's own dependency order: lint, unit tests, the client build
 * and its bundle pin, the boot smoke, the browser suites, and the DB suite
 * last and alone. `skip` holds the suites that stay with CI
 * (see `uncoveredSuites`); `databaseEnv` is the pinned `portos_test`
 * environment from scripts/lib/pregateResources.js.
 */
export function resolvePlanStages(plan, { skipLint = false, baseSha, skip = {}, databaseEnv = {} } = {}) {
  const base = baseSha ? { CI_BASE_SHA: baseSha } : {};
  const stages = [{
    name: 'hidden-content scan',
    suite: 'scan',
    script: 'scan-diff-hidden-content.js',
    args: ['--base', baseSha, '--worktree'],
    env: {},
  }];

  if (plan.promptHistory) {
    stages.push({ name: 'shipped prompt history', suite: 'prompt-history', script: 'migrations/check-shipped-prompt-history.js', args: [], env: {} });
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

  // Same env the Linux unit jobs set: the registered browser suites belong to
  // the browser stage below, and passing output stays signal-dense.
  const scopeEnv = { server: { PORTOS_CI_BROWSER_OWNER: 'unit', PORTOS_TEST_QUIET: '1' }, client: {} };
  ['server', 'client'].forEach((scope) => {
    const scoped = plan[scope];
    if (scoped.mode === 'skip') return;
    stages.push({
      name: `${scope} tests`,
      suite: scope,
      script: 'run-ci-tests.js',
      args: [scope],
      env: {
        ...scopeEnv[scope],
        CI_TEST_MODE: scoped.mode,
        CI_TEST_FILES: JSON.stringify(scoped.files),
        CI_TEST_SOURCES: JSON.stringify(scoped.sources),
        // Same base the planner just used. The import-growth guard fails
        // closed without it; omitting it here would make pregate compare
        // against a different ref than CI.
        ...base,
      },
    });
  });

  if (plan.build && !skip.build) {
    stages.push(
      { name: 'client build', suite: 'build', npm: ['run', 'build', '--prefix', 'client'], args: [], env: {} },
      // The Scalar-removal pin only sees dist/ after a real build.
      { name: 'API Explorer bundle pin', suite: 'build', npm: ['run', 'test', '--prefix', 'client', '--', 'ApiExplorer.bundle'], args: [], env: {} },
    );
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
  // Discover convention guards so new client scanners join the local gate
  // without a second hand-maintained list (including guards under hooks/).
  const clientGuards = trackedFiles.filter((path) => /^client\/src\/.*Conventions\.test\.js$/.test(path));
  return {
    ...plan,
    full: false,
    server: {
      mode: 'files',
      files: [...new Set([...ALWAYS_RUN_TESTS.filter((path) => tracked.has(path)), ...serverStructuralGuards])],
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

const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

const gitPaths = (args, cwd = REPO_ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

/** Unmerged index paths, including every conflict stage and unusual path name. */
export function unmergedIndexPaths(output) {
  const paths = [];
  for (const entry of output.split('\0').filter(Boolean)) {
    // `git ls-files -u -z` emits `<mode> <object> <stage>\t<path>\0`.
    const separator = entry.indexOf('\t');
    if (separator !== -1) paths.push(entry.slice(separator + 1));
  }
  return [...new Set(paths)].sort();
}

/** Paths represented by NUL-delimited `git status --porcelain=v1` output. */
export function statusPaths(output) {
  const entries = output.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/.test(status)) index += 1;
  }
  return paths;
}

/** The committed diff plus every staged, unstaged, deleted, or untracked path. */
export function collectPregateChangedFiles(baseSha, { cwd = REPO_ROOT } = {}) {
  const committed = gitPaths(['diff', '-z', '--name-only', '--diff-filter=ACMRD', `${baseSha}...HEAD`], cwd);
  const status = execFileSync(
    'git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd, encoding: 'utf8' },
  );
  const workingTree = statusPaths(status);
  return {
    changedFiles: [...new Set([...committed, ...workingTree])].sort(),
    workingTreeFiles: [...new Set(workingTree)].sort(),
  };
}

/** The remote default branch (`origin/main` unless this fork says otherwise). */
function defaultBaseRef() {
  const head = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  const resolved = head.status === 0 ? head.stdout.trim() : '';
  return resolved || 'origin/main';
}

export const USAGE = `Usage: node scripts/pregate.js [--base <ref>] [--full] [--skip-lint] [--plan-only]
                              [--skip-db] [--skip-browser] [--skip-build] [--skip-smoke]

  --base <ref>    compare against <ref> instead of the remote default branch
  --full          run the complete suite when the plan demands it
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
    base: null, full: false, skipLint: false, planOnly: false, help: false,
    skipDb: false, skipBrowser: false, skipBuild: false, skipSmoke: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
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

/**
 * Kill whatever is still in a stage's process group once its leader exited:
 * a descendant that ignored a signal or outlived its launcher keeps running
 * (and writing to inherited descriptors) into the next stage or past pregate.
 * ESRCH is the proof the group is empty. POSIX only. Resolves
 * `{ settled, lingered?, reason? }`.
 */
async function sweepStageGroup(pgid) {
  const deadline = Date.now() + STAGE_SETTLE_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch (error) {
      return error.code === 'ESRCH'
        ? { settled: true, lingered: attempt > 0 }
        : { settled: false, reason: `group kill failed (${error.code ?? 'unknown'})` };
    }
    if (Date.now() >= deadline) return { settled: false, reason: 'group members remained after SIGKILL' };
    await delay(25);
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
  if (sweep.lingered) writeSync(2, `⚠️ Stage "${stage.name}" exited with processes still running in its group; killed them.\n`);
  return { ...outcome, pid: child.pid, ...(sweep.settled ? {} : { unsettled: sweep.reason }) };
}

const formatDuration = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`);

function announceUncovered(uncovered) {
  uncovered.forEach(({ suite, reason, remedy }) => {
    console.log(`ℹ️ CI will also run: ${suite} — not run here (${reason}); ${remedy}`);
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

  const unmerged = spawnSync('git', ['ls-files', '-u', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (unmerged.status !== 0) {
    console.error(`❌ Cannot inspect the Git index for unresolved conflicts: ${unmerged.stderr || 'git ls-files failed'}`);
    process.exit(2);
  }
  const conflictPaths = unmergedIndexPaths(unmerged.stdout);
  if (conflictPaths.length > 0) {
    console.error(`❌ Cannot run pregate with unresolved Git conflicts:\n${conflictPaths.map((path) => `  ${path}`).join('\n')}`);
    process.exit(1);
  }

  const baseRef = options.base || defaultBaseRef();

  const mergeBase = spawnSync('git', ['merge-base', baseRef, 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (mergeBase.status !== 0) {
    console.error(`❌ Cannot resolve a merge base with ${baseRef} — fetch it first (git fetch origin).`);
    process.exit(2);
  }
  const baseSha = mergeBase.stdout.trim();
  console.log(`🔎 Planning against ${baseRef} (${baseSha.slice(0, 9)}).`);

  const { changedFiles, workingTreeFiles } = collectPregateChangedFiles(baseSha);
  if (workingTreeFiles.length > 0) {
    console.log(`📝 Included ${workingTreeFiles.length} uncommitted changed file(s) in this plan.`);
  }

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

  const raw = JSON.parse(planned.stdout);
  let plan = {
    full: raw.full,
    reason: raw.reason,
    server: { mode: raw.server_mode, files: JSON.parse(raw.server_files), sources: JSON.parse(raw.server_sources) },
    client: { mode: raw.client_mode, files: JSON.parse(raw.client_files), sources: JSON.parse(raw.client_sources) },
    lint: { mode: raw.lint_mode, files: JSON.parse(raw.lint_files) },
    browser: { files: JSON.parse(raw.browser_files ?? '[]') },
    db: raw.db,
    windows: raw.windows,
    build: raw.build,
    smoke: raw.smoke,
    promptHistory: raw.prompt_history,
    linuxContainment: raw.linux_containment,
    supercolliderLive: raw.supercollider_live,
    suiteReasons: JSON.parse(raw.suite_reasons ?? '{}'),
  };
  console.log(`📋 ${raw.changed_files.length} changed file(s) — ${plan.reason}.`);

  const downgraded = plan.full && !options.full;
  if (downgraded) {
    plan = downgradeFullPlan(plan, git(['ls-files']).split('\n').filter(Boolean), changedFiles);
    console.log('⚠️ CI will run the FULL suite for this diff — running always-run and diff-selected structural guards only. Pass --full to run everything, including the build, smoke, browser and DB suites.');
  }

  describeBrowserSelection(plan.browser.files).forEach((line) => console.log(line));

  /** Stages for the suites that stay here, after the uncovered ones are announced. */
  const planStages = (prerequisites, databaseEnv) => {
    const uncovered = uncoveredSuites(plan, { options, downgraded, prerequisites });
    announceUncovered(uncovered);
    const skip = Object.fromEntries(uncovered.map(({ suite }) => [suite, true]));
    return { uncovered, stages: resolvePlanStages(plan, { skipLint: options.skipLint, baseSha, skip, databaseEnv }) };
  };

  if (options.planOnly) {
    // Prerequisites are probed at run time; here every selected suite is a stage.
    planStages({}, {}).stages.forEach((stage) => {
      console.log(`• ${stage.name}: ${describeStageCommand(stage)}`);
    });
    process.exit(0);
  }

  const dependencyProblems = dependencyConsistencyProblems(REPO_ROOT);
  if (dependencyProblems.length > 0) {
    const gitCommonDir = git(['rev-parse', '--git-common-dir']);
    const gitDir = git(['rev-parse', '--git-dir']);
    const isLinkedWorktree = resolve(REPO_ROOT, gitCommonDir) !== resolve(REPO_ROOT, gitDir);
    const primaryCheckout = isLinkedWorktree ? resolve(REPO_ROOT, gitCommonDir, '..') : null;

    console.error('❌ Dependency consistency preflight failed; lint/tests have not run.');
    for (const { label, linked, owner, issues } of dependencyProblems) {
      console.error(`  ${label} (${linked ? 'linked' : 'owned'} node_modules):\n${issues.map(issue => `    ${issue}`).join('\n')}`);
      if (isLinkedWorktree && (!linked || issues.some(i => i.includes('missing') || i.includes('unreadable')))) {
        console.error(`    Worktree dependency dir is missing or unlinked for ${label}. Re-link with: node scripts/link-worktree-deps.js ${primaryCheckout || '<primary-checkout>'} ${REPO_ROOT}`);
      } else {
        console.error(linked
          ? `    Reconcile dependencies in the owning source checkout (${owner}), with a full development install (npm ci --include=dev), or validate in a separate clone with its own locked installs. Never run npm install/ci through worktree links.`
          : `    Reconcile this checkout's dependencies from its committed lockfiles (npm ci --include=dev in the owning workspace), then rerun pregate.`);
      }
    }
    process.exit(1);
  }
  console.log('✅ Dependency consistency preflight passed (installed package versions match workspace locks).');

  const { prerequisites, databaseEnv } = await probeResourceSuites(plan, { options, downgraded });
  const { uncovered, stages } = planStages(prerequisites, databaseEnv);

  const headSha = git(['rev-parse', 'HEAD']);
  // The receipt hashes the tree the stages validate. It is taken once the
  // hidden-content scan has passed: that scan is what proves every untracked
  // path is readable (an uncommitted nested repository fails both, and the
  // scan's diagnosis is the one the operator should read).
  let tree = null;
  const hashTree = () => {
    if (tree !== null) return;
    tree = validatedTreeHash(REPO_ROOT);
    console.log(`🌳 Validating working tree ${tree.slice(0, 12)} at HEAD ${headSha.slice(0, 9)}.`);
  };

  const startedAt = new Date().toISOString();
  const results = stages.map((stage) => ({ ...stage, command: describeStageCommand(stage), status: 'not-run', durationMs: 0 }));
  let exitCode = 0;
  let failure = null;
  const owner = installOwnerCancellation();
  for (const result of results) {
    if (failure || owner.signal) break;
    if (result.suite !== 'scan') {
      try {
        hashTree();
      } catch (error) {
        failure = `❌ Cannot hash the working tree for the receipt: ${error.message}`;
        exitCode = 2;
        break;
      }
    }
    console.log(`▶️ ${result.name}`);
    const started = Date.now();
    const outcome = await runStage(result, owner);
    result.durationMs = Date.now() - started;
    if (outcome.interrupted) {
      result.status = 'failed';
      result.signal = outcome.interrupted;
      failure = outcome.settled
        ? `❌ Pregate incomplete: stage="${result.name}" cancelled by ${outcome.interrupted}; its process group has exited.`
        : `❌ Pregate incomplete: stage="${result.name}" cancelled by ${outcome.interrupted}; owned process group settlement unverified (${outcome.reason}).`;
      exitCode = 128 + constants.signals[outcome.interrupted];
    } else if (outcome.unsettled) {
      result.status = 'failed';
      failure = `❌ ${result.name} left processes in its group that could not be stopped (${outcome.unsettled}).`;
      exitCode = 1;
    } else if (outcome.error) {
      result.status = 'failed';
      failure = `❌ ${result.name} could not start: ${outcome.error.message}`;
      exitCode = 1;
    } else if (outcome.signal) {
      result.status = 'failed';
      result.signal = outcome.signal;
      failure = `❌ Pregate incomplete: stage="${result.name}" owner_pid=${process.pid} child_pid=${outcome.pid} child_signal=${outcome.signal}.`;
      exitCode = constants.signals[outcome.signal] ? 128 + constants.signals[outcome.signal] : 1;
    } else if (outcome.status !== 0) {
      result.status = 'failed';
      result.exitCode = outcome.status;
      failure = `❌ ${result.name} failed after ${formatDuration(result.durationMs)} — fix it before pushing (CI would fail the same way).`;
      exitCode = outcome.status ?? 1;
    } else {
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
    if (!failure) hashTree();
    if (tree !== null) treeAfterRun = validatedTreeHash(REPO_ROOT);
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
    runtime: { node: process.version, platform: process.platform, arch: process.arch, maxWorkers: pregateWorkerEnv(process.env).PORTOS_PREGATE_MAX_WORKERS },
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  writePregateReport(REPO_ROOT, report);
  // Synchronous: a piped stderr is written asynchronously, and the self-signal
  // below would drop these lines before they flush.
  if (tree !== null && !report.treeStable) {
    writeSync(2, `⚠️ The working tree changed while pregate ran (${tree.slice(0, 12)} → ${treeAfterRun?.slice(0, 12) ?? 'unhashable'}); the receipt covers the tree it started with.\n`);
  }
  if (failure) writeSync(2, `${failure}\n📄 Receipt: ${PREGATE_REPORT_PATH}\n`);
  else if (owner.signal) writeSync(2, `⚠️ Received ${owner.signal} after every stage passed; the receipt records that completed run.\n`);

  owner.release();
  // Every owned group has settled and the receipt is written; end the way the
  // caller's signal asked.
  if (owner.signal) process.kill(process.pid, owner.signal);
  if (failure) process.exit(exitCode);

  const ran = results.map((stage) => stage.name).join(', ');
  console.log(`✅ Pregate passed: ${ran}.`);
  if (uncovered.length > 0) {
    console.log(`⚠️ Not run here (CI still proves them): ${uncovered.map(({ suite, reason }) => `${suite} (${reason})`).join(', ')}.`);
  }
  console.log(`📄 Receipt: ${PREGATE_REPORT_PATH}`);
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch((error) => {
    console.error(`❌ Pregate incomplete: ${error.message}`);
    process.exitCode = 1;
  });
}
