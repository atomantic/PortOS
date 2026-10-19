import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { applyRunnerSelection, vitestRunnerSelection } from '../scripts/vitestCiPool.js';
import { DB_TEST_INCLUDE } from '../scripts/lib/dbTestFiles.js';
import { bootstrapVitestTempRoot } from '../scripts/lib/vitestTempRoot.js';

// This independent runner owns the same fixture/browser scratch as npm test.
const RUN_TEMP_ROOT = bootstrapVitestTempRoot();

// Same reason as vitest.config.js: an inherited NODE_ENV (PM2 exports
// 'development') is NOT overridden by vitest's own default, and the DB guards
// in lib/db.js key on it. Force it so `npm run test:db` behaves identically
// wherever it is launched from (#4554).
process.env.NODE_ENV = 'test';

// Compatibility export for the existing DB inventory guard.
export { DB_TEST_INCLUDE } from '../scripts/lib/dbTestFiles.js';

/**
 * DB-backed test config — runs ONLY the suites that talk to a real Postgres
 * (the `*.db.test.js` adapter round-trips + a few catalog/migration suites),
 * against the throwaway `portos_test` database.
 *
 * Why a separate config:
 *  - These suites `DELETE FROM` / truncate whole tables in setup. The default
 *    runner parallelizes test FILES, so two of them hitting the same table in
 *    one shared database would clobber each other. `fileParallelism: false`
 *    runs them one file at a time — correct, and they're fast.
 *  - `env.PGDATABASE = portos_test` points them at the test DB. isTestDatabase()
 *    recognizes the `_test` suffix, so checkHealth() lets them connect and run
 *    (against the real `portos` DB they would skip — that's the safety guard).
 *
 * The default `vitest.config.js` excludes the same inventory, so `npm test`
 * never runs them; `npm run test:db` does, after `npm run setup:db:test`.
 *
 * Adding a new DB-backed test? Add it to `DB_TEST_INCLUDE` in scripts/lib/dbTestFiles.js — the
 * `*.db.test.js` naming convention is documentation, not a glob match, so a new
 * suite silently never runs until it's listed. db.guards.test.js fails if a
 * checkHealth consumer is left out.
 */
const config = defineConfig({
  // Anchor to the config, even when --root or the caller cwd differs.
  cacheDir: fileURLToPath(new URL('./.cache/vitest-db', import.meta.url)),
  test: {
    // Environment teardown also owns collection-only/skipped suite fixtures.
    environment: fileURLToPath(new URL('./test/mediaRegistryEnvironment.js', import.meta.url)),
    testTimeout: process.platform === 'win32' ? 30000 : 15000,
    // Explicit 'vitest' imports only, matching vitest.config.js (#9049).
    globals: false,
    globalSetup: [fileURLToPath(new URL('../scripts/vitestTempRootSetup.js', import.meta.url))],
    setupFiles: ['./vitest.setup.js'],
    // One file at a time — these suites assume exclusive access to their tables.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      PGDATABASE: process.env.PGTESTDATABASE || 'portos_test',
      NODE_DISABLE_COMPILE_CACHE: '1',
      TMPDIR: RUN_TEMP_ROOT,
      TMP: RUN_TEMP_ROOT,
      TEMP: RUN_TEMP_ROOT,
      MAC_CHROMIUM_TMPDIR: RUN_TEMP_ROOT,
      // Keeps spawned npm from writing debug logs into the developer's ~/.npm/_logs.
      npm_config_logs_max: '0',
      // The runner's selection and memo directory are for THIS Vitest process only.
      PORTOS_CI_TEST_SELECTION: '',
      PORTOS_TEST_MEMO_DIR: '',
    },
    include: DB_TEST_INCLUDE,
    exclude: [
      '**/node_modules/**',
      '../lib/slashdo/**',
    ],
  },
});

// The CI runner's explicit selection (files the test memo has not verified) arrives as a file.
config.test = applyRunnerSelection(config.test, vitestRunnerSelection());
export default config;
