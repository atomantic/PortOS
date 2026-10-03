import { defineConfig } from 'vitest/config';
import { DB_TEST_INCLUDE } from '../scripts/lib/dbTestFiles.js';

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
export default defineConfig({
  test: {
    testTimeout: process.platform === 'win32' ? 30000 : 15000,
    // Explicit 'vitest' imports only, matching vitest.config.js (#9049).
    globals: false,
    setupFiles: ['./vitest.setup.js'],
    // One file at a time — these suites assume exclusive access to their tables.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      PGDATABASE: process.env.PGTESTDATABASE || 'portos_test',
    },
    include: DB_TEST_INCLUDE,
    exclude: [
      '**/node_modules/**',
      '../lib/slashdo/**',
    ],
  },
});
