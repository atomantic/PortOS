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
 *   --skip-lint   skip the client lint stage
 *   --plan-only   print the plan and the stages, run nothing
 *
 * What it deliberately does NOT cover, because each needs a resource this
 * checkout does not have: the DB suites (a provisioned `portos_test` —
 * `npm run setup:db:test && npm run test:db`), the Windows job (a Windows
 * runner), and the client build / boot smoke. The summary names the ones the
 * plan flagged so they are a decision rather than a surprise.
 */

import { spawnSync } from 'child_process';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ALWAYS_RUN_TESTS } from './ci-test-plan.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

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
      name: 'client lint',
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
 * catches the tree-wide guards, plus a line saying what was dropped. `--full`
 * opts back in.
 */
export function downgradeFullPlan(plan, trackedFiles) {
  const tracked = new Set(trackedFiles);
  return {
    ...plan,
    full: false,
    server: { mode: 'files', files: ALWAYS_RUN_TESTS.filter((path) => tracked.has(path)), sources: [] },
    client: { mode: 'skip', files: [], sources: [] },
    lint: { mode: 'full', files: [] },
  };
}

const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

const gitPaths = (args, cwd = REPO_ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

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

/** Parse argv into the flags documented in the header. */
export function parseArgs(argv) {
  const baseIndex = argv.indexOf('--base');
  return {
    base: baseIndex === -1 ? null : argv[baseIndex + 1],
    full: argv.includes('--full'),
    skipLint: argv.includes('--skip-lint'),
    planOnly: argv.includes('--plan-only'),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
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
    db: raw.db,
    windows: raw.windows,
    build: raw.build,
    smoke: raw.smoke,
  };
  console.log(`📋 ${raw.changed_files.length} changed file(s) — ${plan.reason}.`);

  if (plan.full && !options.full) {
    plan = downgradeFullPlan(plan, git(['ls-files']).split('\n').filter(Boolean));
    console.log('⚠️ CI will run the FULL suite for this diff — running the always-run guards only. Pass --full to run everything.');
  }

  const stages = resolvePlanStages(plan, { skipLint: options.skipLint, baseSha });
  const uncovered = Object.keys(UNCOVERED_SUITES).filter((key) => plan[key]);
  uncovered.forEach((key) => console.log(`ℹ️ CI will also run: ${key} — not covered here; run ${UNCOVERED_SUITES[key]}`));

  if (options.planOnly) {
    stages.forEach((stage) => console.log(`• ${stage.name}: ${stage.script} ${stage.args.join(' ')}`));
    process.exit(0);
  }

  for (const stage of stages) {
    console.log(`▶️ ${stage.name}`);
    const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', stage.script), ...stage.args], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...stage.env },
    });
    if (result.error) {
      console.error(`❌ ${stage.name} could not start: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`❌ ${stage.name} failed — fix it before pushing (CI would fail the same way).`);
      process.exit(result.status ?? 1);
    }
  }

  const caveat = uncovered.length > 0 ? ` (${uncovered.join(', ')} still only provable in CI)` : '';
  console.log(`✅ Pregate passed: ${stages.map((stage) => stage.name).join(', ')}${caveat}.`);
}

if (isDirectlyInvoked(import.meta.url)) main();
