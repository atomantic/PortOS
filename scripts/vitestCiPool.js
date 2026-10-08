/**
 * Vitest worker caps for GitHub Actions. Standard Linux runners for public
 * repositories are 4 vCPU / 16GB; uncapped forks oversubscribe those cores
 * during transform and swap.
 * Local `npm test` stays unbounded so a developer machine can use every core.
 * That is not the supported full-suite result: an unbounded run oversubscribes
 * a loaded machine and resource-heavy cases hit their existing budgets.
 * `PORTOS_PREGATE_MAX_WORKERS=4 npm test` is the supported full local
 * validation (same cap as CI). A focused file run is evidence for that file
 * only. See docs/CONTRIBUTING.md.
 * `npm run pregate` exports PORTOS_PREGATE_MAX_WORKERS so several concurrent
 * worktree gates share one host budget (#9773). The value can only LOWER a
 * workspace's cap, never raise it past the proven one.
 *
 * fileParallelism stays at Vitest's default (true): four workers stay busy on
 * independent files. The DB suite already serializes files because those
 * tests share one Postgres.
 *
 * `PORTOS_CI_MAX_WORKERS` (CI only) lowers the cap for one job, e.g. Windows.
 *
 * Vitest 5 exposes `maxWorkers` only — there is no `minWorkers` / `minThreads`.
 */
export function vitestCiPool({ maxWorkers = 4 } = {}) {
  if (process.env.CI) {
    // The Windows server job lowers the cap (#10114): one process per test file
    // exhausts Windows process-creation resources on the runner (0xC0000142).
    // Like the pregate budget, it can only lower the proven cap.
    const raw = process.env.PORTOS_CI_MAX_WORKERS;
    const ci = /^[1-9]\d*$/.test(raw ?? '') ? Number(raw) : null;
    return { maxWorkers: ci === null ? maxWorkers : Math.min(maxWorkers, ci) };
  }
  const raw = process.env.PORTOS_PREGATE_MAX_WORKERS;
  const pregate = /^[1-9]\d*$/.test(raw ?? '') ? Number(raw) : null;
  return pregate === null ? {} : { maxWorkers: Math.min(maxWorkers, pregate) };
}

// Keep these public Chrome/ffmpeg contracts in the full/CI runner, but give
// their captures a quiet group after parallel unit work (#9394).
export const EXCLUSIVE_CAPTURE_TESTS = [
  'services/htmlComposition/index.test.js',
  'services/musicVideo/documentRender.browser.test.js',
  'services/musicVideo/documentTemplates/shared/toonWorld.browser.test.js',
  'routes/musicVideoProductionReview.browser.test.js',
  'routes/musicVideoRichAuthoring.browser.test.js',
];

// Cutover's real subprocess proof has a four-second test budget. A retained
// concurrent-run failure spent 3.746 seconds on startup/module import alone
// (#9368). Isolate that resource-sensitive contract without changing its
// deadline, process-incarnation checks, or fail-closed negative controls.
// Resource-heavy contracts that pass on a quiet worker and time out when an
// unbounded local run spends their budget on CPU contention (#10356). They run
// one at a time after the parallel group. Isolation does not raise their
// timeouts or drop their assertions.
const EXCLUSIVE_TESTS = [
  ...EXCLUSIVE_CAPTURE_TESTS,
  'services/databaseMaintenanceCutover.test.js',
  'services/creativeDirector/videoAssembly.test.js',
  'services/musicVideo/publishKit.test.js',
  'services/musicVideo/sharingCopy.test.js',
  'scripts/run-local-code-review.test.js',
  'lib/workTracker.trackerInstructions.test.js',
  '../scripts/ci-test-plan.test.js',
  '../scripts/writersRoomPromotionCleanup.test.js',
];

export function vitestCaptureProjects(test) {
  const { include, exclude, ...shared } = test;
  // Vite concatenates inherited include arrays: extending the broad root
  // glob would also run EVERY unit file in the capture project. Copy shared
  // worker settings explicitly and leave run-wide ownership at the root.
  delete shared.coverage;
  delete shared.globalSetup;
  return [
    {
      extends: false,
      test: {
        ...shared,
        name: 'parallel',
        include,
        exclude: [...exclude, ...EXCLUSIVE_TESTS],
        sequence: { groupOrder: 0 },
      },
    },
    {
      extends: false,
      test: {
        ...shared,
        name: 'capture',
        include: EXCLUSIVE_TESTS,
        exclude,
        fileParallelism: false,
        sequence: { groupOrder: 1 },
      },
    },
  ];
}
