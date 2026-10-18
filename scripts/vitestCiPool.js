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
import { readFileSync } from 'node:fs';

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
  // Exact SVG-filter screenshots hit the 30s CI budget alongside parallel tests.
  'lib/filmLook.browser.test.js',
  'lib/filmLookGpu.browser.test.js',
  'lib/musicVideoTitleCard.browser.test.js',
  'services/htmlComposition/index.test.js',
  'services/musicVideo/documentRender.browser.test.js',
  'services/musicVideo/documentTemplates/layered/engine.overlay.browser.test.js',
  'services/musicVideo/documentTemplates/shared/lyricType.browser.test.js',
  'services/musicVideo/documentTemplates/shared/toonWorld.browser.test.js',
  'services/musicVideo/overlayTextService.browser.test.js',
  'services/musicVideo/publish/sunoHook.browser.test.js',
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
  '../scripts/persistentMindProcessAuditCleanup.test.js',
  '../scripts/writersRoomPromotionCleanup.test.js',
];

/**
 * The runner's explicit file selection, when `scripts/run-ci-tests.js` wrote
 * one. `PORTOS_CI_TEST_SELECTION` names a JSON file
 * `{ include: string[]|null, exclude: string[] }` of workspace-relative posix
 * paths: `include` replaces the config's globs (null keeps them), `exclude`
 * is appended. A file rather than CLI selectors because a closure-selected
 * related set or a memo-trimmed full run can name thousands of files, past
 * the Windows command-line limit. A malformed file throws: a selection the
 * config cannot read must never silently widen to the whole suite.
 */
export function vitestRunnerSelection(env = process.env) {
  const path = env.PORTOS_CI_TEST_SELECTION;
  if (!path) return { include: null, exclude: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const list = (value, name) => {
    if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string' && entry.length > 0)) {
      throw new Error(`PORTOS_CI_TEST_SELECTION ${name} must be a list of workspace-relative paths`);
    }
    return value;
  };
  return {
    include: parsed.include === null || parsed.include === undefined ? null : list(parsed.include, 'include'),
    exclude: parsed.exclude === undefined ? [] : list(parsed.exclude, 'exclude'),
  };
}

/** `test` with the runner selection applied to its include/exclude globs. */
export function applyRunnerSelection(test, selection) {
  const applied = { ...test, include: selection.include ?? test.include };
  // Leave an absent `exclude` absent: setting it to [] would drop Vitest's own defaults.
  if (test.exclude !== undefined || selection.exclude.length > 0) applied.exclude = [...(test.exclude ?? []), ...selection.exclude];
  return applied;
}

export function vitestCaptureProjects(test, { cacheDir, selection = { include: null, exclude: [] } } = {}) {
  const { include, exclude, ...shared } = test;
  // An explicit selection narrows the capture group too; its fixed include
  // would otherwise run every exclusive suite on every scoped plan.
  const captureInclude = selection.include === null
    ? EXCLUSIVE_TESTS : EXCLUSIVE_TESTS.filter(file => selection.include.includes(file));
  // Vite concatenates inherited include arrays: extending the broad root
  // glob would also run EVERY unit file in the capture project. Copy shared
  // worker settings explicitly and leave run-wide ownership at the root.
  delete shared.coverage;
  delete shared.globalSetup;
  return [
    {
      extends: false,
      // These projects also opt out of Vite config inheritance.
      cacheDir,
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
      // These projects also opt out of Vite config inheritance.
      cacheDir,
      test: {
        ...shared,
        name: 'capture',
        include: captureInclude,
        exclude,
        fileParallelism: false,
        sequence: { groupOrder: 1 },
      },
    },
  ];
}
