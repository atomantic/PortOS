import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { bootstrapVitestTempRoot } from '../scripts/lib/vitestTempRoot.js';
import { VITEST_WATCH_OPTIONS } from '../scripts/lib/vitestWatch.js';
import { CLIENT_TEST_EXCLUDE, CLIENT_TEST_INCLUDE } from '../scripts/lib/workspaceTests.js';

import { applyRunnerSelection, vitestCaptureProjects, vitestCiPool, vitestRunnerSelection } from '../scripts/vitestCiPool.js';
import { TEST_TIMEOUT_MS } from './src/test/timeouts.js';

const RUN_TEMP_ROOT = bootstrapVitestTempRoot();

const config = defineConfig({
  server: { watch: VITEST_WATCH_OPTIONS },
  // Anchor to the config, even when --root or the caller cwd differs.
  cacheDir: fileURLToPath(new URL('./.cache/vitest', import.meta.url)),
  plugins: [react()],
  resolve: {
    // Share Three.js without bypassing its package exports with a directory alias.
    dedupe: ['three'],
  },
  test: {
    // Vitest 5's module cache is separate from Vite cacheDir; dependencies may be shared by worktrees.
    fsModuleCachePath: fileURLToPath(new URL('./.cache/vitest/modules', import.meta.url)),
    globalSetup: [fileURLToPath(new URL('../scripts/vitestTempRootSetup.js', import.meta.url))],
    env: {
      TMPDIR: RUN_TEMP_ROOT,
      TMP: RUN_TEMP_ROOT,
      TEMP: RUN_TEMP_ROOT,
      MAC_CHROMIUM_TMPDIR: RUN_TEMP_ROOT,
      // Keeps spawned npm from writing debug logs into the developer's ~/.npm/_logs.
      npm_config_logs_max: '0',
      NODE_DISABLE_COMPILE_CACHE: '1',
      // The runner's selection is for THIS Vitest process only: a suite that
      // spawns a nested Vitest on a fixture must not inherit it.
      PORTOS_CI_TEST_SELECTION: '',
      // Same for the memo store: a nested Vitest must point at its own directory or stay off.
      PORTOS_TEST_MEMO_DIR: '',
    },
    // Four DOM workers exhausted Testing Library's async budget on the public
    // runner before ChiefOfStaff's config panel settled. Keep the proven
    // two-worker client cap; the Node/server runner uses all four CPUs.
    ...vitestCiPool({ maxWorkers: 2 }),
    // Both derived from the Testing Library async budget rather than written as
    // literals — an inner `waitFor` bound that reaches its enclosing budget can
    // never report its own failure. `hookTimeout` is set for the same reason as
    // `testTimeout`: a beforeEach that renders and waits is bounded by it, and
    // leaving it at vitest's fixed 10s default would silently break the ordering
    // the moment the async budget moved. See src/test/timeouts.js.
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    // happy-dom, not jsdom (#6144): building the DOM was the client suite's
    // largest CI phase, and happy-dom cuts it by roughly two thirds for the same
    // 10k assertions. Files that need no DOM at all still opt out entirely with a
    // `// @vitest-environment node` pragma — see docs/GITHUB_ACTIONS.md.
    environment: 'happy-dom',
    // Vitest 5 clears mock call history before every test by default
    // (`clearMocks`); see the longer note in server/vitest.config.js. Accepted
    // rather than pinned back to the vitest 4 default — implementations set by
    // a `vi.mock` factory survive, only `mock.calls` resets, and the suite is
    // green under it.
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    // Shared with the CI runner, which enumerates the same set before Vitest
    // starts (scripts/lib/workspaceTests.js). The exclude is Vitest's own
    // default, spelled out so a runner selection can extend it.
    include: [...CLIENT_TEST_INCLUDE],
    exclude: [...CLIENT_TEST_EXCLUDE],
  },
});

// The CI runner's explicit selection (closure-related files, minus the ones
// the test memo already verified) arrives as a file, not as CLI selectors.
const runnerSelection = vitestRunnerSelection();
config.test = applyRunnerSelection(config.test, runnerSelection);
// Real nested runners retain the client budget, but get quiet startup after
// parallel DOM/scanner work. The root still owns one shared run temp root.
config.test.projects = vitestCaptureProjects(config.test, {
  cacheDir: config.cacheDir,
  selection: runnerSelection,
  exclusiveTests: ['src/test/workspaceCaches.test.js'],
}).map(project => ({ ...project, plugins: config.plugins, resolve: config.resolve, server: config.server }));
export default config;
