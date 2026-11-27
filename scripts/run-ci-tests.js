#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { formatErrorAnnotation, formatWarningAnnotation, writeStepOutput } from './lib/githubOutput.js';
import { browserShardSlice } from './lib/browserSuites.js';
import { browserProfileAcceptedVerdicts, browserTestProfileFiles, BROWSER_FIDELITY_ONLY_FILES } from './lib/browserTestProfiles.js';
import {
  clearVitestDependencies, createToolVersionResolver, currentCommit, findVitestDependenciesFile,
  memoSummaryLine, memoUnrecordedLines, passedTestFiles, planTestMemo, prepareMemoRun, pruneTestMemo, readVitestDependencies, recordTestMemo, seedVitestDependencies, sliceTestCandidates, writeSelectionFile,
} from './lib/testMemoRunner.js';
import { loadFactsCache, saveFactsCache } from './lib/testMemo/factsCache.js';
import { hasMemoEntries, memoDirs, resolveMemoDir } from './lib/testMemoStore.js';
import { SERVED_FILES_ENV, readServedFiles } from './lib/browserServedFiles.js';
import { browserOwnerExcludes, TEST_SCOPES, workspaceOf } from './lib/workspaceTests.js';
import { resolveDbTestFiles } from './lib/dbTestFiles.js';
import { CI_GUARD_BUDGET_MS, describeGuardDurations, guardDurations, overBudgetGuards, readGuardLoads } from './lib/guardBudget.js';
import { getAlwaysRunTests, PROMPT_STAGE_GUARD } from './lib/ciPlanRules.js';
import { isClientBrowserSuite } from './lib/importReach.js';
import { browserProfileArgs, spawnNpm, toRunnerPath } from './lib/ciNpmRunner.js';

export { extractCrashedTestFile, hasOtherTestFailures, planCrashRetry, repoRelativeFromCrashPath, runNpm, spawnNpm, toRunnerPath } from './lib/ciNpmRunner.js';
export { recordVitestDuration, structuredFailureDiagnostics } from './lib/ciTestDiagnosticsFormat.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function requiresSourceFiles(mode, repoSources) {
  return mode === 'related' && repoSources.length === 0;
}

/**
 * This runner's slice of the job matrix. `CI_SHARD` is `<index>/<count>`
 * (ci.yml); a single shard is no shard, so the one-runner invocation stays
 * identical to a local `npm run test:ci`. The slice is taken by the runner
 * itself (scripts/lib/testMemoRunner.js serverShardSlice), never by Vitest:
 * each shard subtracts a different memo state, and a `--shard` applied after
 * that subtraction could leave a file to no shard at all.
 */
export function parseShard(shard) {
  if (!shard) return null;
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (!match) throw new Error(`CI_SHARD must look like <index>/<count>, got "${shard}"`);
  return match[2] === '1' ? null : { index: Number(match[1]), count: Number(match[2]) };
}

let deadlineExpired = false;
export const DEADLINE_ENV = 'PORTOS_CI_TEST_DEADLINE_MINUTES';

/**
 * One wall-clock deadline for the whole launcher invocation, read from the
 * environment (#18636). The step timeout alone did not end a hung Windows run
 * and the log was lost; the process that owns the child's pipes can still
 * print the evidence. Returns null when unset or not a positive number.
 *
 * @returns {{ signal: AbortSignal, minutes: number } | null}
 */
export function launcherDeadline(env = process.env) {
  const minutes = Number(env[DEADLINE_ENV]);
  if (!(minutes > 0) || !Number.isFinite(minutes)) return null;
  return { signal: AbortSignal.timeout(Math.round(minutes * 60_000)), minutes };
}

/**
 * Reports the guards in `files` that ran over CI_GUARD_BUDGET_MS: each
 * structural guard runner's checks, and every other guard file whole.
 * With `enforce` (the scheduled hosted run) an over-budget guard returns 1,
 * naming each one; otherwise it is a warning annotation and returns 0. A guard
 * with no reading (it crashed, or ran nothing) is left to the test status,
 * which already fails that run.
 */
function guardBudgetStatus(files, results, loads, { enforce }) {
  const watched = new Set(files);
  const timed = guardDurations(results.filter(({ file }) => watched.has(file)), loads);
  if (enforce) {
    for (const [name, ms] of Object.entries(timed)) {
      console.log(`⏱️ Guard timing ${name.replace(/[\r\n]/g, ' ')} ${ms.toFixed(1)}ms`);
    }
  }
  const slowest = Object.entries(timed).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([file, durationMs]) => ({ file, durationMs }));
  if (slowest.length > 0) console.log(`⏱️ Guards, slowest of ${Object.keys(timed).length}: ${describeGuardDurations(slowest)} (budget ${(CI_GUARD_BUDGET_MS / 1000).toFixed(1)}s).`);
  const over = overBudgetGuards(timed, CI_GUARD_BUDGET_MS);
  if (over.length === 0) return 0;
  const title = 'Guard over its time budget';
  const detail = `${describeGuardDurations(over)} over the ${(CI_GUARD_BUDGET_MS / 1000).toFixed(1)}s per-guard budget. Speed the check up (read the tree through scripts/lib/guardCorpus.js, which lists and reads it once per runner) rather than raising the budget.`;
  if (!enforce) {
    console.log(`⚠️ ${title}, reported only on this run (the scheduled hosted run enforces it): ${detail}`);
    console.log(formatWarningAnnotation(title, detail));
    return 0;
  }
  console.error(`❌ ${title}: ${detail}`);
  console.error(formatErrorAnnotation(title, detail));
  return 1;
}

/**
 * Whether this run will launch the real browser, so CI warms Chrome's install
 * into the page cache only then (#17750). The client shards used to read ~450 MiB
 * on every push, including memo hits and happy-dom-only runs. The cross-workspace
 * browser job (`PORTOS_CI_BROWSER_OWNER=browser`) launches it for any suite it runs.
 */
export function shouldWarmTestChrome({ scope, run, env = process.env }) {
  if (!env.CI || run.length === 0) return false;
  return env.PORTOS_CI_BROWSER_OWNER === 'browser' || (scope === 'client' && run.some(isClientBrowserSuite));
}

// The script is best-effort by contract (never fails the job); a spawn error is ignored the same way.
function warmTestChrome() {
  spawnSync('bash', [join(repoRoot, 'scripts', 'ci-warm-test-chrome.sh')], { stdio: 'inherit' });
}

function parseLauncherInput(cliArgs, env) {
  const preplannedPath = env.PORTOS_CI_PREPLANNED_RUN;
  delete env.PORTOS_CI_PREPLANNED_RUN;
  const checkRemaining = cliArgs.includes('--check-remaining');
  const checkCtc = cliArgs.includes('--check-ctc');
  const positionalArgs = cliArgs.filter(arg => arg !== '--check-remaining' && arg !== '--check-ctc');
  const scope = positionalArgs[0];
  if (positionalArgs.length !== 1 || !Object.hasOwn(TEST_SCOPES, scope) || (checkCtc && (scope !== 'server' || checkRemaining))) {
    console.error('Usage: node scripts/run-ci-tests.js <server|client|db> [--check-remaining] or server --check-ctc');
    process.exit(2);
  }
  const workspace = workspaceOf(scope);
  const { script } = TEST_SCOPES[scope];

  // Pregate's guard stage asks for per-file wall times for this runner only.
  const durationsPath = env.PORTOS_PREGATE_DURATIONS_PATH;
  delete env.PORTOS_PREGATE_DURATIONS_PATH;
  // Set by ci.yml's Linux server job only; a nested runner a test spawns must not inherit it.
  const enforceGuardBudget = env.CI_GUARD_BUDGET === 'enforce';
  delete env.CI_GUARD_BUDGET;
  // Same inheritance rule: a nested launcher a test spawns must not arm its own copy. The signal is created
  // once here so every pass and the crash retry spend the same budget.
  const deadline = launcherDeadline(env);
  delete env[DEADLINE_ENV];
  if (deadline) {
    deadline.signal.addEventListener('abort', () => {
      deadlineExpired = true;
      console.error(`⏱️ Test launcher deadline of ${deadline.minutes} minute(s) (${DEADLINE_ENV}) expired; ending the test process tree.`);
    }, { once: true });
  }
  const mode = env.CI_TEST_MODE || 'full';
  const inputFiles = JSON.parse(env.CI_TEST_FILES || '[]');
  // Explicit planner selectors must respect the same browser and DB ownership as
  // workspace discovery and Vitest.
  const browserExcludes = new Set(scope === 'server'
    ? browserOwnerExcludes({ env }).map(path => `server/${path}`) : []);
  const dbExcludes = new Set(scope === 'server'
    ? resolveDbTestFiles(inputFiles) : []);
  const profile = env.PORTOS_BROWSER_TEST_PROFILE;
  const profileFiles = profile !== undefined ? browserTestProfileFiles(profile, inputFiles) : inputFiles;
  const repoFiles = profileFiles.filter(path => !browserExcludes.has(path) && !dbExcludes.has(path));
  const repoSources = JSON.parse(env.CI_TEST_SOURCES || '[]');
  const selectedFiles = repoFiles.map((path) => toRunnerPath(workspace, path));

  if (!['full', 'files', 'related'].includes(mode)) {
    console.error(`Unsupported CI test mode: ${mode}`);
    process.exit(2);
  }

  if (requiresSourceFiles(mode, repoSources)) {
    console.error('CI_TEST_SOURCES must name at least one changed source file in related-test mode.');
    process.exit(2);
  }

  const browserJob = env.PORTOS_CI_BROWSER_OWNER === 'browser';
  const beforeAudioSetup = browserJob && checkRemaining && env.PORTOS_CI_BEFORE_AUDIO_SETUP === '1';
  const supportsPreplannedRun = scope === 'db' && mode === 'full'
    || browserJob && scope === 'server' && mode === 'files';
  if (preplannedPath && (!supportsPreplannedRun || checkCtc)) {
    throw new Error('Preplanned runs require the DB full suite or the browser files job.');
  }

  let emptySelectionMessage = null;
  if (mode === 'files' && selectedFiles.length === 0) {
    const deferredOnly = profile === 'smoke' && inputFiles.length > 0
      && inputFiles.every(file => BROWSER_FIDELITY_ONLY_FILES.includes(file));
    if (profile !== undefined && !deferredOnly) throw Error('Browser profile selected no executable cases.');
    emptySelectionMessage = `No ${scope} tests selected.${deferredOnly ? ' Fidelity-only inputs require separate evidence.' : ''}`;
  }

  const shardName = env.CI_SHARD;
  const shard = emptySelectionMessage === null ? parseShard(shardName) : null;
  const label = mode === 'full' ? (shard ? `full suite shard ${shardName}` : 'full suite')
    : mode === 'files' ? 'selected tests' : 'related and contract tests';
  return { scope, workspace, script, mode, repoFiles, repoSources, checkCtc, checkRemaining, browserJob,
    beforeAudioSetup, preplannedPath, profile, shard, shardName, label, deadline, durationsPath,
    enforceGuardBudget, emptySelectionMessage };
}

function readPreplannedRun(path, selection, toolVersion) {
  const { run, ffmpeg } = JSON.parse(readFileSync(path, 'utf8')) ?? {};
  const { owned } = sliceTestCandidates(selection);
  const allowed = new Set(owned);
  if (!Array.isArray(run) || new Set(run).size !== run.length || run.some(test => !allowed.has(test))
    || (ffmpeg !== undefined && ffmpeg !== null && typeof ffmpeg !== 'string')) {
    throw new Error(`Invalid preplanned ${selection.scope === 'db' ? 'DB' : 'browser'} test selection for this shard.`);
  }
  // Setup can replace ffmpeg. A previous hit can turn into a miss as well as
  // a miss becoming a hit, so replan with the installed version in either case.
  return ffmpeg === undefined || ffmpeg === toolVersion('ffmpeg') ? run : null;
}

function planLauncherMemo({
  scope, mode, repoFiles, repoSources, shard, profile, browserJob, preplannedPath, checkRemaining, beforeAudioSetup,
}, { memoDir, readOnlyMemo }) {
  // PRs may reuse parsed facts within a job. Only trusted runs may update
  // the memo directory that Actions restores and publishes across jobs.
  const scratchFacts = readOnlyMemo && preplannedPath && process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, 'portos-facts-cache') : null;
  const factsDir = [scratchFacts, ...memoDirs(memoDir)].filter(Boolean);
  const caseFilter = browserProfileArgs();
  const acceptVerdictsFrom = profile !== undefined ? browserProfileAcceptedVerdicts(profile) : [];
  const toolVersion = createToolVersionResolver({ verifyAudioPair: browserJob });
  const analysisOptions = { scope, repoRoot, memoDir, caseFilter, toolVersion,
    ...(browserJob ? { requireToolVersions: true, freshToolVersion: createToolVersionResolver({ verifyAudioPair: true }) } : {}) };
  const selection = { scope, mode, repoFiles, repoRoot, shard,
    ...(browserJob ? { shardSlice: (files, shard) => browserShardSlice(files, shard, profile) } : {}) };
  let plan;
  const recheck = browserJob && checkRemaining && !beforeAudioSetup;
  if (preplannedPath && (!checkRemaining || recheck)) {
    const run = readPreplannedRun(preplannedPath, selection, toolVersion);
    if (run !== null) {
      console.log(`Using the preplanned selection of ${run.length} ${browserJob ? 'browser' : 'DB'} test files.`);
      plan = checkRemaining ? { run } : prepareMemoRun(run, { ...analysisOptions, memoDir: readOnlyMemo ? null : memoDir });
    }
  }
  let ffmpeg;
  if (!plan) {
    const beforeToolSetup = beforeAudioSetup || scope === 'db' && checkRemaining;
    const provisionableTool = beforeToolSetup && hasMemoEntries(memoDir) ? 'ffmpeg' : undefined;
    plan = planTestMemo({ ...analysisOptions, ...selection, repoSources, acceptVerdictsFrom,
      planBeforeClientSetup: browserJob && checkRemaining,
      provisionableTool, factsCache: memoDir ? loadFactsCache(factsDir, scope) : null });
    if (memoDir) {
      console.log(memoSummaryLine(plan));
      if (process.env.PORTOS_TEST_MEMO_VERBOSE === '1') {
        for (const { test, via, from } of plan.skipped) console.log(`🧠   skipped ${test} (${via} key${from ? `, ${from} verdict` : ''})`);
      }
    }
    if (preplannedPath && beforeToolSetup && (plan.unsettled > 0
      || plan.skipped.some(({ test, via }) => plan.verdicts.get(test)[via].tools?.has('ffmpeg')))) {
      ffmpeg = toolVersion('ffmpeg');
    }
  }
  if (plan.factsCache && (!readOnlyMemo || scratchFacts)) saveFactsCache(factsDir, scope, plan.factsCache);
  if (preplannedPath && checkRemaining) writeFileSync(preplannedPath, JSON.stringify({ run: plan.run, ffmpeg }));
  return { plan, caseFilter };
}

function buildExecutionPasses(runFiles, label, enforceGuardBudget) {
  // The scheduled run budgets the always-run guard pass and the prompt-stage
  // scan separately. The scan parses the server tree and competes for CPU
  // with the other scanners even when isolated from the broad test shard.
  const alwaysRun = new Set(getAlwaysRunTests());
  const guardRun = runFiles.filter(test => alwaysRun.has(test));
  const promptStageRun = runFiles.includes(PROMPT_STAGE_GUARD) ? [PROMPT_STAGE_GUARD] : [];
  return enforceGuardBudget
    ? [
      [guardRun, `${label}: always-run guards`, guardRun],
      [promptStageRun, `${label}: prompt-stage guard`, promptStageRun],
      [runFiles.filter(test => !alwaysRun.has(test) && test !== PROMPT_STAGE_GUARD), label, []],
    ]
    : [[runFiles, label, guardRun]];
}

async function executeTestPasses(passes, {
  scope, workspace, script, enforceGuardBudget, deadline, durationsPath,
}, { recordDependencies, caseFilter, runFiles }) {
  const extraArgs = recordDependencies ? ['--experimental.recordDependencies'] : [];
  // What each real-Chromium fixture's Vite server served, for the records written below (#17616).
  let servedDir = null;
  if (extraArgs.length) {
    clearVitestDependencies(repoRoot, scope);
    // Vitest records nothing for a case-filtered run unless each file already has a record to merge into.
    if (caseFilter.length) seedVitestDependencies(repoRoot, scope, runFiles);
    servedDir = mkdtempSync(join(tmpdir(), 'portos-served-files-'));
    process.env[SERVED_FILES_ENV] = servedDir;
  }
  let served = new Map();
  const passed = [];
  const results = [];
  // Each structural guard runner logs its checks' load times here (registerGuardChecks).
  const loads = [];
  let interrupted = false;
  const onResult = (result) => {
    if (result.interrupted) interrupted = true;
    for (const { file, durationMs, checks } of result.fileResults ?? []) {
      results.push({ file: relative(repoRoot, file).split(sep).join('/'), durationMs, checks });
    }
    passed.push(...passedTestFiles(result.fileResults ?? [], {
      repoRoot, namePattern: process.env.PORTOS_BROWSER_TEST_PROFILE !== undefined, status: result.status, runReport: result.runReport,
    }));
  };
  let status = 0;
  try {
    for (const [include, passLabel, budgetWatched] of passes) {
      if (interrupted) break;
      if (include.length === 0) continue;
      const selection = writeSelectionFile({ scope, include, exclude: [] });
      process.env.PORTOS_CI_TEST_SELECTION = selection.path;
      const loadLog = join(selection.dir, 'guard-loads.jsonl');
      process.env.PORTOS_GUARD_LOAD_LOG = loadLog;
      try {
        status = (await spawnNpm(workspace, script, extraArgs, passLabel, { name: scope, onResult, signal: deadline?.signal })) || status;
      } finally {
        loads.push(...readGuardLoads(loadLog));
        rmSync(selection.dir, { recursive: true, force: true });
      }
      if (budgetWatched.length > 0) status = guardBudgetStatus(budgetWatched, results, loads, { enforce: enforceGuardBudget }) || status;
    }
  } finally {
    delete process.env.PORTOS_GUARD_LOAD_LOG;
    delete process.env[SERVED_FILES_ENV];
    if (servedDir) {
      served = readServedFiles(servedDir, repoRoot);
      rmSync(servedDir, { recursive: true, force: true });
    }
    if (durationsPath) writeFileSync(durationsPath, JSON.stringify(guardDurations(results, loads)));
  }
  return { status, passed, served };
}

function finalizeTestMemo({ scope, plan, browserJob, memoDir, readOnlyMemo }, { status, passed, served }) {
  // A run that may save its store bounds it first (the cache save follows a green step).
  const pruneMemo = () => {
    if (!memoDir || readOnlyMemo) return;
    const pruned = pruneTestMemo({ memoDir, repoRoot, trustedCi: Boolean(process.env.CI) });
    if (pruned) console.log(`🧠 Test memo: pruned ${pruned.removedEntries} entries and ${pruned.removedRecords} records; kept ${pruned.entries} entries and ${pruned.records} records.`);
  };
  if (!memoDir || passed.length === 0) {
    if (status === 0) pruneMemo();
    return;
  }
  // PR jobs restore trusted memos, but ci.yml never saves their new entries.
  // Avoid expensive post-success closure hashing/writes that cannot be reused
  // and can consume the Windows step deadline after every test already passed.
  if (readOnlyMemo) {
    console.log('🧠 Test memo: read-only for pull requests; no cache publication.');
    return;
  }
  const { written, unrecorded } = recordTestMemo({
    scope, repoRoot, memoDir, plan, passed: [...new Set(passed)],
    dependencies: readVitestDependencies(findVitestDependenciesFile(repoRoot, scope), scope),
    served,
    source: process.env.CI ? 'ci' : 'local', commit: currentCommit(repoRoot),
  });
  console.log(`🧠 Test memo: recorded ${written} green entries for ${new Set(passed).size} passed files.`);
  if (browserJob && status === 0 && written > 0) writeStepOutput('memo-written', 'true');
  // A passed file that stores nothing re-runs on every trusted run; say which and why.
  for (const line of memoUnrecordedLines(unrecorded)) console.log(line);
  if (status === 0) pruneMemo();
}

async function main() {
  const input = parseLauncherInput(process.argv.slice(2), process.env);
  const { scope, workspace, script, mode, repoFiles, checkCtc, checkRemaining, beforeAudioSetup,
    preplannedPath, shard, shardName, label, deadline, enforceGuardBudget, browserJob, emptySelectionMessage } = input;
  if (emptySelectionMessage !== null) {
    console.log(emptySelectionMessage);
    if (checkRemaining) {
      if (preplannedPath) writeFileSync(preplannedPath, JSON.stringify({ run: [] }));
      writeStepOutput('remaining', '0');
    }
    if (checkCtc) writeStepOutput('required', 'false');
    process.exitCode = 0;
    return;
  }
  if (checkCtc) {
    // Related mode can reach beyond CI_TEST_FILES. Use its full candidate
    // inventory, which the runner partitions before checking related reach.
    const { owned } = sliceTestCandidates({ scope, mode, repoFiles, repoRoot, shard });
    writeStepOutput('required', String(owned.includes('scripts/ml/align_lyrics_ctc.test.js')));
    return;
  }
  // process.exitCode, not process.exit(): the runner streams the child's
  // output through this process's own stdout/stderr, and process.exit() can
  // terminate before those writes (and this function's own diagnostic lines)
  // finish flushing. Setting exitCode lets Node drain normally once main()
  // returns.
  const memoDir = resolveMemoDir();
  const readOnlyMemo = process.env.GITHUB_EVENT_NAME === 'pull_request';
  if (mode === 'full' && !memoDir && !shard && !checkRemaining && !preplannedPath) {
    process.exitCode = await spawnNpm(workspace, script, [], label, { name: scope, signal: deadline?.signal });
    return;
  }

  const { plan, caseFilter } = planLauncherMemo(input, { memoDir, readOnlyMemo });
  const noTestsMessage = `No ${scope} tests left to run${shard ? ' in this shard' : ''}.`;
  if (checkRemaining) {
    console.log(plan.run.length === 0
      ? noTestsMessage
      : `Remaining ${scope} tests${shard ? ` (shard ${shardName})` : ''}: ${plan.run.length}.`);
    writeStepOutput('remaining', String(plan.run.length));
    // Only a potentially empty shard needs a separate check before client setup.
    if (beforeAudioSetup && plan.unsettled > 0 && plan.unsettled === plan.run.length) {
      console.log('Recheck after audio setup: all remaining memo verdicts may depend on ffmpeg.');
      writeStepOutput('recheck', 'true');
    }
    process.exitCode = 0;
    return;
  }

  const memo = { scope, plan, browserJob, memoDir, readOnlyMemo };
  if (plan.run.length === 0) {
    console.log(noTestsMessage);
    finalizeTestMemo(memo, { status: 0, passed: [] });
    process.exitCode = 0;
    return;
  }
  if (shouldWarmTestChrome({ scope, run: plan.run })) warmTestChrome();
  const passes = buildExecutionPasses(plan.run, label, enforceGuardBudget);
  const execution = await executeTestPasses(passes, input, {
    recordDependencies: Boolean(memoDir) && !readOnlyMemo,
    caseFilter,
    runFiles: plan.run,
  });
  process.exitCode = execution.status;
  finalizeTestMemo(memo, execution);
}

if (isDirectlyInvoked(import.meta.url)) {
  await main();
  // After an expired deadline a detached descendant may still hold a handle (cleanup unverified), which would keep
  // this process alive and the step hanging. Exit once the diagnostics written above have flushed.
  if (deadlineExpired) {
    const code = process.exitCode || 1;
    process.stderr.write('', () => process.stdout.write('', () => process.exit(code)));
  }
}
