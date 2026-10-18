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
 * SAME runners (`run-ci-lint.js`, `run-ci-tests.js`), so a green pregate means those Linux
 * jobs are green for the same reasons — never a second, drifting opinion about
 * which tests matter.
 *
 *   node scripts/pregate.js [--base <ref>] [--full] [--skip-lint] [--plan-only]
 *
 *   --base <ref>  compare against <ref> instead of the remote default branch
 *   --full        actually run the complete suite when the plan demands it
 *                 (without this, a full plan runs the always-run guards only)
 *   --skip-lint   skip linting in both client and server workspaces
 *   --plan-only   print the plan and the stages, run nothing
 *
 * What it deliberately does NOT cover, because each needs a resource this
 * checkout does not have: the DB suites (a provisioned `portos_test` —
 * `npm run setup:db:test && npm run test:db`), the Windows job (a Windows
 * runner), and the client build / boot smoke. The summary names the ones the
 * plan flagged so they are a decision rather than a surprise.
 */

import { spawn, spawnSync } from 'child_process';
import { writeSync } from 'fs';
import { constants } from 'os';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ALWAYS_RUN_TESTS, structuralTestsFor } from './ci-test-plan.js';
import { assertNodeVersion } from './checkNodeVersion.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { needsBrowserFidelity } from './lib/browserFidelity.js';
import { dependencyConsistencyProblems } from './lib/workspaceDependencies.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Suites the plan can request that this machine cannot honestly run.
 *
 * Keyed by the plan field, valued by what the operator would have to run
 * instead. Reported rather than silently dropped: a pregate that stayed quiet
 * about a DB-risk diff would read as "CI is covered" while the one suite that
 * can destroy real data went unmentioned.
 */
export const UNCOVERED_SUITES = Object.freeze({
  db: 'npm run setup:db:test && npm run test:db (never against the real `portos` database)',
  windows: 'a Windows runner — no local equivalent; CI is the only proof',
  build: 'npm run build',
  smoke: 'npm run smoke',
});

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
 * The ordered stages to run for a plan, each a spawnable command.
 *
 * Pure, so the plan -> stage mapping is testable without spawning Vitest.
 * The hidden-content scan always runs first, even if lint/tests select no work.
 */
export function resolvePlanStages(plan, { skipLint = false, baseSha } = {}) {
  const stages = [{
    name: 'hidden-content scan',
    script: 'scan-diff-hidden-content.js',
    args: ['--base', baseSha, '--worktree'],
    env: {},
  }];

  if (!skipLint && plan.lint.mode !== 'skip') {
    stages.push({
      name: 'client/server lint',
      script: 'run-ci-lint.js',
      args: [],
      env: { CI_LINT_MODE: plan.lint.mode, CI_LINT_FILES: JSON.stringify(plan.lint.files) },
    });
  }

  ['server', 'client'].forEach((scope) => {
    const scoped = plan[scope];
    if (scoped.mode === 'skip') return;
    stages.push({
      name: `${scope} tests`,
      script: 'run-ci-tests.js',
      args: [scope],
      env: {
        CI_TEST_MODE: scoped.mode,
        CI_TEST_FILES: JSON.stringify(scoped.files),
        CI_TEST_SOURCES: JSON.stringify(scoped.sources),
        // Same base the planner just used. The import-growth guard fails
        // closed without it; omitting it here would make pregate compare
        // against a different ref than CI.
        ...(baseSha ? { CI_BASE_SHA: baseSha } : {}),
      },
    });
  });

  return stages;
}

/**
 * Replace a full-suite plan with the always-run guards.
 *
 * A full plan is CI's answer to "this diff could break anything", which is
 * correct there and unusable here — the complete suite is far longer than
 * anyone runs before a push, so the honest local default is the subset that
 * catches always-run and diff-selected structural guards, plus a line saying
 * what was dropped. `--full` opts back in.
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

  --base <ref>  compare against <ref> instead of the remote default branch
  --full        run the complete suite when the plan demands it
  --skip-lint   skip linting in both client and server workspaces
  --plan-only   print the plan and stages without running them
  -h, --help    display this usage`;

/** Parse argv before doing any Git inspection or starting a child process. */
export function parseArgs(argv) {
  const options = { base: null, full: false, skipLint: false, planOnly: false, help: false };
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
      default: throw new Error(`Unknown option: ${flag}.`);
    }
  }
  return options;
}

/** Wait asynchronously so owner signals can be attributed during a stage. */
function runStage(stage) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', stage.script), ...stage.args], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...pregateWorkerEnv(process.env), ...stage.env },
      // A separate group lets cancellation reach only this stage's descendants.
      detached: process.platform !== 'win32',
    });
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        // Flush before restoring the signal's default termination behavior.
        writeSync(2, `❌ Pregate incomplete: stage="${stage.name}" owner_pid=${process.pid} child_pid=${child.pid ?? 'unavailable'} received_signal=${signal}.\n`);
        cleanup();
        try {
          if (process.platform === 'win32') child.kill(signal);
          else if (child.pid) process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') writeSync(2, `❌ Stage cancellation failed: ${error.code ?? 'unknown'}.\n`);
        }
        process.kill(process.pid, signal);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    child.once('error', (error) => {
      cleanup();
      resolve({ error });
    });
    child.once('close', (status, signal) => {
      cleanup();
      resolve({ status, signal, pid: child.pid });
    });
  });
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
  };
  console.log(`📋 ${raw.changed_files.length} changed file(s) — ${plan.reason}.`);

  if (plan.full && !options.full) {
    plan = downgradeFullPlan(plan, git(['ls-files']).split('\n').filter(Boolean), changedFiles);
    console.log('⚠️ CI will run the FULL suite for this diff — running always-run and diff-selected structural guards only. Pass --full to run everything.');
  }

  const stages = resolvePlanStages(plan, { skipLint: options.skipLint, baseSha });
  const uncovered = Object.keys(UNCOVERED_SUITES).filter((key) => plan[key]);
  uncovered.forEach((key) => {
    console.log(`ℹ️ CI will also run: ${key} — not covered here; run ${UNCOVERED_SUITES[key]}`);
  });

  describeBrowserSelection(plan.browser?.files ?? []).forEach((line) => console.log(line));

  if (options.planOnly) {
    stages.forEach((stage) => {
      console.log(`• ${stage.name}: ${stage.script} ${stage.args.join(' ')}`);
    });
    process.exit(0);
  }

  const dependencyProblems = dependencyConsistencyProblems(REPO_ROOT);
  if (dependencyProblems.length > 0) {
    console.error('❌ Dependency consistency preflight failed; lint/tests have not run.');
    for (const { label, linked, owner, issues } of dependencyProblems) {
      console.error(`  ${label} (${linked ? 'linked' : 'owned'} node_modules):\n${issues.map(issue => `    ${issue}`).join('\n')}`);
      console.error(linked
        ? `    Reconcile dependencies in the owning source checkout (${owner}), or validate in a separate clone with its own locked installs. Never run npm install/ci through worktree links.`
        : `    Reconcile this checkout's dependencies from its committed lockfiles (npm ci in the owning workspace), then rerun pregate.`);
    }
    process.exit(1);
  }
  console.log('✅ Dependency consistency preflight passed (installed package versions match workspace locks).');

  for (const stage of stages) {
    console.log(`▶️ ${stage.name}`);
    const result = await runStage(stage);
    if (result.error) {
      console.error(`❌ ${stage.name} could not start: ${result.error.message}`);
      process.exit(1);
    }
    if (result.signal) {
      console.error(`❌ Pregate incomplete: stage="${stage.name}" owner_pid=${process.pid} child_pid=${result.pid} child_signal=${result.signal}.`);
      process.exit(constants.signals[result.signal] ? 128 + constants.signals[result.signal] : 1);
    }
    if (result.status !== 0) {
      console.error(`❌ ${stage.name} failed — fix it before pushing (CI would fail the same way).`);
      process.exit(result.status ?? 1);
    }
  }

  const caveat = uncovered.length > 0 ? ` (${uncovered.join(', ')} still only provable in CI)` : '';
  console.log(`✅ Pregate passed: ${stages.map((stage) => stage.name).join(', ')}${caveat}.`);
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch((error) => {
    console.error(`❌ Pregate incomplete: ${error.message}`);
    process.exitCode = 1;
  });
}
