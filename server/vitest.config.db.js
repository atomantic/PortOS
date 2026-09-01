import { defineConfig } from 'vitest/config';

// Same reason as vitest.config.js: an inherited NODE_ENV (PM2 exports
// 'development') is NOT overridden by vitest's own default, and the DB guards
// in lib/db.js key on it. Force it so `npm run test:db` behaves identically
// wherever it is launched from (#4554).
process.env.NODE_ENV = 'test';

/**
 * The DB-backed test files, relative to this config's root (server/). Exported
 * as the single source of truth: this config's `include` uses it, and the drift
 * guard in lib/db.guards.test.js imports it to assert no checkHealth()-gated
 * suite is left out. `**\/db.test.js` only matches a file named exactly
 * `db.test.js` — a `<name>.db.test.js` suite is NOT auto-included and must be
 * listed explicitly below (the drift guard fails the build if you forget).
 */
export const DB_TEST_INCLUDE = [
  '**/db.test.js',
  'services/catalogDB.test.js',
  'services/catalogDB.facets.db.test.js',
  'services/humanActivity.db.test.js',
  'services/postRunDb.db.test.js',
  'services/userActions.db.test.js',
  'services/memoryDB.db.test.js',
  'services/privacySubjects.db.test.js',
  'services/privacyVault.db.test.js',
  'services/privacyOrgs.db.test.js',
  'services/privacyChanges.db.test.js',
  'services/privacyBrokers.db.test.js',
  'services/privacyOptOut.db.test.js',
  'services/catalogCanonProjection.test.js',
  'services/catalogRefResolver.test.js',
  'services/creativeDirector/projectsDB.test.js',
  'services/musicVideo/projectsDB.test.js',
  'routes/catalog.test.js',
  'scripts/run-db-migrations.test.js',
];

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
 * The default `vitest.config.js` ALSO matches these files, but there they skip
 * (PGDATABASE is unset → resolves to non-test `portos`). So `npm test` never
 * runs them; `npm run test:db` does, after `npm run setup:db:test`.
 *
 * Adding a new DB-backed test? Add it to `DB_TEST_INCLUDE` above — the
 * `*.db.test.js` naming convention is documentation, not a glob match, so a new
 * suite silently never runs until it's listed. db.guards.test.js fails if a
 * checkHealth consumer is left out.
 */
export default defineConfig({
  test: {
    testTimeout: process.platform === 'win32' ? 30000 : 15000,
    globals: true,
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
