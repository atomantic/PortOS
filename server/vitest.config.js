import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { applyRunnerSelection, vitestCaptureProjects, vitestCiPool, vitestRunnerSelection } from '../scripts/vitestCiPool.js';
import { bootstrapVitestTempRoot } from '../scripts/lib/vitestTempRoot.js';
import { VITEST_WATCH_OPTIONS } from '../scripts/lib/vitestWatch.js';
import { SERVER_TEST_EXCLUDE, SERVER_TEST_INCLUDE, browserOwnerExcludes } from '../scripts/lib/workspaceTests.js';

// `npm run test:fast` is the Windows-safe way to set the flag (a
// `VITEST_FAST=1 vitest` script is parsed as an executable name on cmd.exe).
if (process.env.npm_lifecycle_event === 'test:fast') {
  process.env.VITEST_FAST = '1';
}

// Reimports reuse the enclosing run root; capture projects share its one owner.
const RUN_TEMP_ROOT = bootstrapVitestTempRoot();

// The suite REQUIRES NODE_ENV=test: it selects the file storage backend so no suite
// touches the real Postgres. Vitest only DEFAULTS NODE_ENV, and PM2 runs PortOS
// with development, so a test run from a PortOS-spawned shell would inherit it
// and aim suites at the live database (#4554).
// Forcing it here keeps every entry point correct and Windows-safe (cmd.exe parses
// 'NODE_ENV=test vitest' as an executable name, hence VITEST_FAST is set here too).
process.env.NODE_ENV = 'test';

// Disable Node's module compile cache tree-wide (`NODE_COMPILE_CACHE`, or npm/npx
// calling `module.enableCompileCache()`): it writes to `TMPDIR/node-compile-cache`
// and turned up in the run-scoped temp root (#9051), and per-call-site isolation
// can't rule out the next child. Honored since Node v22.1; engines require newer.
process.env.NODE_DISABLE_COMPILE_CACHE = '1';

// The CI runner's explicit selection (closure-related files, minus the ones
// the test memo already verified) arrives as a file, not as CLI selectors.
const runnerSelection = vitestRunnerSelection();

const config = defineConfig({
  server: { watch: VITEST_WATCH_OPTIONS },
  // Anchor to the config, even when --root or the caller cwd differs.
  cacheDir: fileURLToPath(new URL('./.cache/vitest', import.meta.url)),
  test: {
    // Vitest 5's module cache is separate from Vite cacheDir; dependencies may be shared by worktrees.
    fsModuleCachePath: fileURLToPath(new URL('./.cache/vitest/modules', import.meta.url)),
    // Environment teardown also owns collection-only/skipped suite fixtures.
    environment: fileURLToPath(new URL('./test/mediaRegistryEnvironment.js', import.meta.url)),
    ...vitestCiPool(),
    // Workers get their own process.env — set it there as well as above.
    env: {
      NODE_ENV: 'test',
      NODE_DISABLE_COMPILE_CACHE: '1',
      // Throwaway data roots need no crash-durability fsyncs (#16864); see fileCore.js.
      PORTOS_TEST_FAST_WRITES: '1',
      TMPDIR: RUN_TEMP_ROOT,
      TMP: RUN_TEMP_ROOT,
      TEMP: RUN_TEMP_ROOT,
      MAC_CHROMIUM_TMPDIR: RUN_TEMP_ROOT,
      // Keeps spawned npm from writing debug logs into the developer's ~/.npm/_logs.
      npm_config_logs_max: '0',
      // The runner's selection is for THIS Vitest process only: a suite that
      // spawns a nested Vitest on a fixture must not inherit it.
      PORTOS_CI_TEST_SELECTION: '',
      // Same for the memo store: a nested Vitest must point at its own directory or stay off.
      PORTOS_TEST_MEMO_DIR: '',
    },
    // 30s on every platform (#7951). Transform + import dominate tracked time, so a
    // test whose body is one `await import()` of a large graph is timed almost
    // entirely on module loading (cosToolRegistry.js ~35s under full-suite load,
    // vs ~445ms in a quiet node process). At 10s those failed with ZERO failing
    // assertions, moving run to run with machine load. The heaviest unconditional
    // loads are already hoisted to file scope (pinned in `lib/importScoping.test.js`);
    // this covers the tail of deliberate in-test `await import()`s (fresh instance
    // after `vi.resetModules()`, a mock installed first, branch-gated loads).
    testTimeout: 30000,
    // hookTimeout tracks testTimeout and must be set explicitly: vitest's 10s
    // default applies to hooks even when testTimeout is raised (the image-gen route
    // suites' heavy `import()` in beforeAll timed out on contended workers, #7951).
    hookTimeout: 30000,
    // Print worker console output directly rather than over RPC: a log from a
    // fire-and-forget callback can resolve after its test returns and race worker
    // teardown ("EnvironmentTeardownError: Closing rpc while onUserConsoleLog was
    // pending"). Tests asserting on console use vi.spyOn (unaffected).
    disableConsoleIntercept: true,
    // The client owns its runner (`client/vitest.config.js`, jsdom); this node runner
    // covers server, scripts/migrations and lib tests and does NOT glob the client tree.
    // The Autofixer's adversarial tests run here, and
    // docs/deps-doc.test.js lives next to the document it guards. The globs are
    // shared with the CI runner (scripts/lib/workspaceTests.js).
    include: [...SERVER_TEST_INCLUDE],
    // The slashdo submodule ships node:test suites vitest can't parse, which the
    // broad `../lib/**` glob would report as failures under --bail=1.
    // DB-backed suites run only in `vitest.config.db.js` against portos_test; the
    // DB job is authoritative, so excluding them here removes duplicate setup.
    //
    // Heavy disk/git/Sharp integration suites, dropped by `npm run test:fast`
    // (VITEST_FAST=1). The git-guard files are NOT listed: their real-git
    // describes honor SKIP_HEAVY_INTEGRATION.
    exclude: [
      ...SERVER_TEST_EXCLUDE,
      ...browserOwnerExcludes(),
      ...(process.env.VITEST_FAST ? [
        'services/worktreeReap.test.js',
        'services/sprites/atlas.test.js',
        'services/sprites/walk.test.js',
        'lib/gitTestRepo.test.js',
        // Real-Chrome-and-ffmpeg gated renders (#9033): minutes of capture/encode each.
        'services/htmlComposition/index.test.js',
        'services/musicVideo/compositionRender.test.js',
      ] : []),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['lib/**/*.js', 'routes/**/*.js', 'services/**/*.js'],
      exclude: [
        '**/*.test.js',
        '**/index.js',
        '**/cos-runner/**'
      ],
      thresholds: {
        lines: 30,
        functions: 30,
        branches: 30,
        statements: 30
      }
    },
    // Vitest 5 clears mock call history before every test (`clearMocks`); accepted
    // as per-test isolation. It is `.mockClear()`: implementations from `vi.mock`
    // factories or `mockReturnValue` survive, so `not.toHaveBeenCalled()` proves
    // only that the CURRENT test didn't call it. Assert cross-test claims in-test.
    //
    // Vitest APIs are NOT injected as globals: every suite imports from 'vitest',
    // so a missing import fails in every run, not only outside this config (#9049).
    globals: false,
    // Mocks getPeers → [] so test-created records never fan out to live peers.
    setupFiles: ['./vitest.setup.js'],
    // Runs once in the main process before workers start and after the run; removes
    // what is left in RUN_TEMP_ROOT (#9032).
    globalSetup: [fileURLToPath(new URL('../scripts/vitestTempRootSetup.js', import.meta.url))],
  }
});

// Both projects share the safety env, setup files and time budgets. The
// root globalSetup owns one temp root across BOTH groups; project teardown
// must not remove it while another group still needs it.
config.test = applyRunnerSelection(config.test, runnerSelection);
config.test.projects = vitestCaptureProjects(config.test, { cacheDir: config.cacheDir, selection: runnerSelection });
export default config;
