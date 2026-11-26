#!/usr/bin/env node

/**
 * Lightweight local pre-push validation: lint/format, structural invariants
 * and directly owned tests. Hosted CI keeps its broad impact plan.
 * `--full` opts into that CI plan locally, including selected resource suites.
 * `--guards-only` runs just the structural checks.
 * Receipts describe the exact tree and coverage; focused results are local evidence only and never replace
 * CI suites. Cancellation still settles every owned stage process group.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCiTestPlan } from './ci-test-plan.js';
import { assertNodeVersion } from './checkNodeVersion.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { downgradeFullPlan, focusedLocalPlan } from './lib/pregateFocusedPlan.js';
import { checkPregateDependencies, collectPregateInputs, repoState, worktreeStatus } from './lib/pregateGitState.js';
import { installOwnerCancellation, pregateWorkerEnv } from './lib/pregateProcessGroup.js';
import { createWorkingTreeHasher, finalizePregateReceipt, PREGATE_REPORT_PATH } from './lib/pregateReport.js';
import { announceUncovered, describeBrowserSelection, describeStageCommand, planPregateStages, runPregateStages } from './lib/pregateStages.js';

export { downgradeFullPlan, focusedLocalPlan, RELATED_SUITE_CAP, SECOND_HOP_RUN_CAP } from './lib/pregateFocusedPlan.js';
export { collectPregateInputs } from './lib/pregateGitState.js';
export { pregateWorkerEnv, stageSpawnEnv, sweepStageGroup } from './lib/pregateProcessGroup.js';
export { describeBrowserSelection, describeStageCommand, resolvePlanStages, suiteSelected, uncoveredSuites, UNCOVERED_SUITES, workflowLintSelected } from './lib/pregateStages.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

async function resolveInitialPlan({ options, baseSha, changedFiles, indexFiles, workingTreeFiles }) {
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

  const guardPlan = downgradeFullPlan(plan, downgraded ? presentFiles : trackedFiles, changedFiles);
  const structuralFiles = new Set([...guardPlan.server.files, ...guardPlan.client.files]);
  if (options.guardsOnly) plan = { ...guardPlan, lint: { mode: 'skip', files: [] } };
  if (downgraded) {
    plan = await focusedLocalPlan(plan, presentFiles, changedFiles, undefined, { basePlan: { ...guardPlan } });
    console.log('ℹ️ Local validation: lint, structural guards and focused tests only. Hosted CI owns broad coverage; pass --full for the complete CI plan locally.');
  }

  describeBrowserSelection(plan.browser.files).forEach((line) => { console.log(line); });

  return { plan, guardPlan, structuralFiles, downgraded };
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

  const { plan, guardPlan, structuralFiles, downgraded } = await resolveInitialPlan({
    options, baseSha, changedFiles, indexFiles, workingTreeFiles,
  });
  const stagePlanOptions = { options, downgraded, baseSha, baseRef, guardPlan };
  if (options.planOnly) {
    // Prerequisites are probed at run time; here every selected suite is a stage.
    const { uncovered, stages } = planPregateStages(plan, stagePlanOptions);
    announceUncovered(uncovered, downgraded);
    stages.forEach((stage) => {
      console.log(`• ${stage.name}: ${describeStageCommand(stage)}`);
    });
    process.exit(0);
  }

  if (!checkPregateDependencies(REPO_ROOT, repo, changedFiles)) process.exit(1);
  const { PORTOS_PREGATE_MAX_WORKERS: maxWorkers } = pregateWorkerEnv(process.env, dirname(repo.commonDir));

  const initialStages = planPregateStages(plan, stagePlanOptions);
  const startedAt = new Date().toISOString();
  const owner = installOwnerCancellation();
  if (tree !== null) console.log(`🌳 Validating working tree ${tree.slice(0, 12)} at HEAD ${headSha.slice(0, 9)}.`);

  const stageRun = await runPregateStages(plan, stagePlanOptions, initialStages, {
    owner, structuralFiles, initialHashError, repoRoot: REPO_ROOT,
  });
  const { results, uncovered } = stageRun;
  const { failure, exitCode } = finalizePregateReceipt(REPO_ROOT, plan, stageRun, {
    options, repo, tree, hashWorkingTree, initiallyClean, initialHashError,
    downgraded, maxWorkers, startedAt, owner,
  });

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
