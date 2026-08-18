import { defineConfig } from 'vitest/config';
import { vitestCiPool } from '../scripts/vitestCiPool.js';
import { DB_TEST_INCLUDE } from './vitest.config.db.js';

// `npm run test:fast` is the Windows-safe way to set the flag (a
// `VITEST_FAST=1 vitest` script is parsed as an executable name on cmd.exe).
if (process.env.npm_lifecycle_event === 'test:fast') {
  process.env.VITEST_FAST = '1';
}

// The suite REQUIRES NODE_ENV=test: it is what selects the file storage backend
// (memoryBackend.js and every store facade) so no suite talks to the real
// Postgres. Vitest only DEFAULTS NODE_ENV to 'test' when it is unset, and PortOS
// runs under PM2 with NODE_ENV=development — so any commit made from a
// PortOS-spawned shell fires .githooks/pre-commit -> 'npm test --prefix server'
// with NODE_ENV=development inherited, and hundreds of suites then aim at the
// developer's live database (#4554). Forcing it here, rather than prefixing the
// npm script, keeps every entry point correct — 'npm test --prefix server', a
// bare 'npx vitest run', an IDE runner, the git hook — and stays Windows-safe
// (cmd.exe parses 'NODE_ENV=test vitest' as an executable name, which is why
// VITEST_FAST is set here too).
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    ...vitestCiPool(),
    // Workers get their own process.env — set it there as well as above.
    env: { NODE_ENV: 'test' },
    testTimeout: process.platform === 'win32' ? 30000 : 10000,
    // hookTimeout tracks testTimeout for the same reason: Windows fs + module
    // resolution is markedly slower, and vitest's 10s DEFAULT applies to hooks
    // even when testTimeout has been raised. The image-gen route suites
    // (clean/watermark/multipart) do a heavy dynamic `import('./imageGen.js')`
    // plus sharp fixture encoding in beforeAll — comfortably under 10s when run
    // alone, but over it on a contended Windows worker during a full-suite run,
    // where they failed with "Hook timed out in 10000ms" and ZERO failing
    // assertions. That is a runner budget, not a product defect.
    hookTimeout: process.platform === 'win32' ? 30000 : 10000,
    // Print worker console output directly instead of forwarding it to the main
    // thread over RPC. This codebase logs heavily from fire-and-forget callbacks
    // (the documented `.catch(() => console.log(...))` pattern, PTY/timer hooks,
    // periodic sync/sweep loops) — a log can resolve AFTER its test returns, and
    // when that late log raced vitest's worker teardown the run failed with
    // "EnvironmentTeardownError: Closing rpc while onUserConsoleLog was pending"
    // (all assertions passing). Bypassing the RPC console-intercept removes that
    // path entirely. Tests that assert on console use vi.spyOn (unaffected).
    disableConsoleIntercept: true,
    // The client owns its own test runner (`client/vitest.config.js`, jsdom,
    // `cd client && npm test`) which already covers every `client/src/**` test
    // — including the pure helper tests (e.g. normalize.js sidecar resolution).
    // So this server runner covers only server, scripts/migrations, and lib
    // tests; it intentionally does NOT glob the client tree (its default node
    // environment has no DOM, so DOM-dependent client tests would fail here).
    // The scripts/migrations glob lets each one-shot migration be verified
    // against synthetic fixtures.
    include: [
      '**/*.test.js',
      '../scripts/**/*.test.js',
      '../lib/**/*.test.js',
      // The standalone autofixer package ships pure, node-builtin-only helpers
      // (sandbox.js isolation/promotion primitives) whose adversarial tests run
      // under this node runner.
      '../autofixer/**/*.test.js',
    ],
    // The slashdo submodule ships its own node:test suites; vitest can't
    // parse them and the broad `../lib/**` glob would otherwise pick them up
    // as "no test suite found" failures that break --bail=1 CI runs.
    // DB-backed suites run only in `vitest.config.db.js`, against portos_test.
    // Keeping them in this file made ordinary Linux and Windows jobs import 29
    // files solely to skip their 275 assertions when no test DB was configured.
    // The DB job is the authoritative runner, so excluding the same canonical
    // list here removes duplicate setup without reducing coverage.
    //
    // Heavy disk/git/Sharp integration suites. `npm run test:fast`
    // (VITEST_FAST=1) drops them so a unit-only loop stays cheap; `npm test`
    // and CI keep the full run. The git-guard files are NOT listed here —
    // their real-git describes honor SKIP_HEAVY_INTEGRATION, and the leftover
    // pure-logic cases still run under --fast.
    exclude: [
      '**/node_modules/**',
      '../lib/slashdo/**',
      ...DB_TEST_INCLUDE,
      ...(process.env.VITEST_FAST ? [
        'services/worktreeReap.test.js',
        'services/sprites/atlas.test.js',
        'services/sprites/walk.test.js',
        'lib/gitTestRepo.test.js',
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
    globals: true,
    // Global setup: mocks getPeers → [] so test-created records never fan out
    // to live sync peers.  Per-suite vi.mock('./instances.js', …) overrides win.
    setupFiles: ['./vitest.setup.js'],
  }
});
