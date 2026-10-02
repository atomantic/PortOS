/**
 * Vitest worker caps for GitHub Actions. Standard Linux runners for public
 * repositories are 4 vCPU / 16GB; uncapped forks oversubscribe those cores
 * during transform and swap.
 * Local `npm test` stays unbounded so a developer machine can use every core.
 *
 * fileParallelism stays at Vitest's default (true): four workers stay busy on
 * independent files. The DB suite already serializes files because those
 * tests share one Postgres.
 *
 * Vitest 5 exposes `maxWorkers` only — there is no `minWorkers` / `minThreads`.
 */
export function vitestCiPool({ maxWorkers = 4 } = {}) {
  if (!process.env.CI) return {};
  return { maxWorkers };
}

// Keep these public Chrome/ffmpeg contracts in the full/CI runner, but give
// their captures a quiet group after parallel unit work (#9394).
export const EXCLUSIVE_CAPTURE_TESTS = [
  'services/htmlComposition/index.test.js',
  'services/musicVideo/documentRender.browser.test.js',
  'routes/musicVideoProductionReview.browser.test.js',
];

// Cutover's real subprocess proof has a four-second test budget. A retained
// concurrent-run failure spent 3.746 seconds on startup/module import alone
// (#9368). Isolate that resource-sensitive contract without changing its
// deadline, process-incarnation checks, or fail-closed negative controls.
const EXCLUSIVE_TESTS = [
  ...EXCLUSIVE_CAPTURE_TESTS,
  'services/databaseMaintenanceCutover.test.js',
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
