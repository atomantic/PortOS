/** Plan pregate stages, probe selected prerequisites, and run stages in dependency order. */
import { mkdtempSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FULL_SUITE_SHARDS } from './ciPlanOutput.js';
import { getAlwaysRunTests, PROMPT_STAGE_GUARD } from './ciPlanRules.js';
import { isGuardTest } from './guardScanners.js';
import { needsBrowserFidelity } from './browserFidelity.js';
import { ACTIONLINT_VERSION, probeActionlint, selectWorkflowFiles } from './actionlint.js';
import { CI_GUARD_BUDGET_MS, GUARD_BUDGET_MS, describeGuardDurations, overBudgetGuards, readGuardDurations } from './guardBudget.js';
import { RELATED_SUITE_CAP, SECOND_HOP_RUN_CAP } from './pregateFocusedPlan.js';
import { runStage } from './pregateProcessGroup.js';

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
    uncovered.push({ suite: 'related tests', reason, remedy: 'run the referencing suites directly with `server/node_modules/.bin/vitest run --configLoader runner <files>`; CI runs them' });
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

/** Human spelling of a stage's command for plan output and the receipt. */
export function describeStageCommand(stage) {
  return stage.npm ? `npm ${stage.npm.join(' ')}` : `node scripts/${stage.script}${stage.args.length ? ` ${stage.args.join(' ')}` : ''}`;
}

/**
 * The ordered stages to run for a plan, each a spawnable command.
 *
 * Pure, so the plan -> stage mapping is testable without spawning anything.
 * The hidden-content scan always runs first, even if lint/tests select no
 * work. In full mode the shared structural guards follow it, then CI's dependency order:
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
      files,
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

const formatDuration = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`);

export function announceUncovered(uncovered, focused) {
  const prefix = focused ? 'Hosted CI may also run' : 'CI will also run';
  uncovered.forEach(({ suite, reason, remedy }) => {
    console.log(`ℹ️ ${prefix}: ${suite} — not run here (${reason}); ${remedy}`);
  });
}

/** Probe what the selected resource suites need; a failed probe keeps that suite with CI. */
async function probeResourceSuites(plan, { options, downgraded }, repoRoot) {
  const prerequisites = {};
  let databaseEnv = {};
  const wants = (suite, flag) => suiteSelected(plan, suite) && !flag && !downgraded;
  const wantsDb = wants('db', options.skipDb);
  const wantsBrowser = wants('browser', options.skipBrowser);
  if (!wantsDb && !wantsBrowser) return { prerequisites, databaseEnv };
  // Reaches `pg`, `playwright-core` and server modules: loaded only when needed.
  const resources = await import('./pregateResources.js');
  if (wantsDb) {
    databaseEnv = resources.resolveTestDatabaseStageEnv(repoRoot, process.env);
    prerequisites.db = await resources.probeTestDatabase(databaseEnv, { repoRoot });
    if (prerequisites.db.ok) {
      console.log(`🗄️ Test database ${prerequisites.db.endpoint} ${prerequisites.db.provision ? 'will be provisioned' : 'is reachable'}.`);
    } else {
      console.warn(`⏭️ Test database ${prerequisites.db.endpoint}: ${prerequisites.db.reason}.`);
    }
  }
  if (wantsBrowser) {
    prerequisites.browser = await resources.probeBrowserPrerequisites(plan.browser.files, { repoRoot });
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
    const scheduledBudgetGuards = new Set([
      ...getAlwaysRunTests(),
      PROMPT_STAGE_GUARD,
    ]);
    const isScheduled = ({ file }) => scheduledBudgetGuards.has(file.split(' > ', 1)[0]);
    const scheduled = over.filter(isScheduled);
    const localOnly = over.filter(row => !isScheduled(row));
    if (scheduled.length > 0) {
      console.log(`🐢 ${result.name} scheduled-budget guards over the ${formatDuration(GUARD_BUDGET_MS)} local per-guard target: ${describeGuardDurations(scheduled)} (the scheduled hosted run enforces a ${formatDuration(CI_GUARD_BUDGET_MS)} budget for these guards).`);
    }
    if (localOnly.length > 0) {
      console.log(`🐢 ${result.name} other guards over the ${formatDuration(GUARD_BUDGET_MS)} local per-guard target: ${describeGuardDurations(localOnly)} (these timings are local diagnostics; the scheduled hosted guard budget does not apply).`);
    }
  }
}

/** Stages for the suites that stay here, with actions for covered prerequisites. */
export function planPregateStages(plan, { options, downgraded, baseSha, baseRef, guardPlan }, prerequisites = {}, databaseEnv = {}) {
  // actionlint is a local tool probe, not a resource suite: it needs no Chrome or DB.
  const tools = { actionlint: workflowLintSelected(plan) ? probeActionlint() : null, ...prerequisites };
  const uncovered = uncoveredSuites(plan, { options, downgraded, prerequisites: tools });
  const skip = Object.fromEntries(uncovered.map(({ suite }) => [suite, true]));
  const stages = resolvePlanStages(plan, { skipLint: options.skipLint, baseSha, baseRef, skip, databaseEnv,
    guardPlan: options.full ? guardPlan : null });
  return { uncovered, stages: options.guardsOnly
    ? stages.filter(stage => stage.suite === 'server' || stage.suite === 'client')
      .map(stage => ({ ...stage, env: { ...stage.env, PORTOS_TEST_MEMO: 'off' } }))
    : stages };
}

const stageResult = (stage) => ({ ...stage, command: describeStageCommand(stage), status: 'not-run', durationMs: 0 });

async function runStageBatch(results, { owner, structuralFiles, initialHashError, repoRoot }) {
  for (const result of results) {
    if (owner.signal || (initialHashError && result.suite !== 'scan')) break;
    console.log(`▶️ ${result.name}`);
    const timedGuards = new Set(result.files?.filter(file => structuralFiles.has(file) || isGuardTest(file)));
    const durationsDir = timedGuards.size ? mkdtempSync(join(tmpdir(), 'portos-pregate-durations-')) : null;
    const durationsPath = durationsDir && join(durationsDir, 'durations.json');
    if (durationsPath) result.env = { ...result.env, PORTOS_PREGATE_DURATIONS_PATH: durationsPath };
    const started = Date.now();
    const outcome = await runStage(result, owner, repoRoot);
    result.durationMs = Date.now() - started;
    if (durationsDir) {
      // The runner reports all test durations in mixed stages. Only charge
      // structural files and their individual runner checks to the guard budget.
      result.guardDurations = Object.fromEntries(Object.entries(readGuardDurations(durationsPath))
        .filter(([name]) => timedGuards.has(name.split(' > ', 1)[0])));
      rmSync(durationsDir, { recursive: true, force: true });
    }
    const verdict = stageOutcomeVerdict(result, outcome);
    if (verdict) return verdict;
    if (durationsDir) reportSlowGuards(result);
    result.status = 'passed';
    result.exitCode = 0;
    console.log(`✔️ ${result.name} passed in ${formatDuration(result.durationMs)}.`);
  }
  return null;
}

export async function runPregateStages(plan, stagePlanOptions, initialStages, runOptions) {
  const { owner, initialHashError, repoRoot } = runOptions;
  const { downgraded } = stagePlanOptions;
  const initialResults = initialStages.stages.map(stageResult);
  const firstDeferred = initialResults.findIndex((result) => !result.guard && result.suite !== 'scan');

  // Even prerequisite probes may start Chrome. Defer them until every early
  // guard has passed, retaining not-run resource stages on an early failure.
  const early = firstDeferred === -1 ? initialResults : initialResults.slice(0, firstDeferred);
  const earlyVerdict = await runStageBatch(early, runOptions);
  if (firstDeferred === -1 || earlyVerdict || owner.signal || initialHashError) {
    return { results: initialResults, uncovered: initialStages.uncovered, verdict: earlyVerdict };
  }

  const { prerequisites, databaseEnv } = await probeResourceSuites(plan, stagePlanOptions, repoRoot);
  const { uncovered, stages } = planPregateStages(plan, stagePlanOptions, prerequisites, databaseEnv);
  announceUncovered(uncovered, downgraded);
  const deferred = stages.slice(firstDeferred).map(stageResult);
  const verdict = await runStageBatch(deferred, runOptions);
  return { results: [...early, ...deferred], uncovered, verdict };
}
