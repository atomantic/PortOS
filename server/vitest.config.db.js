import { defineConfig } from 'vitest/config';

/**
 * The DB-backed test files, relative to this config's root (server/). Exported
 * as the single source of truth: this config's `include` uses it, and the drift
 * guard in lib/db.guards.test.js imports it to assert no checkHealth()-gated
 * suite is left out. `**\/db.test.js` auto-covers the adapter round-trips; the
 * rest are listed explicitly.
 */
export const DB_TEST_INCLUDE = [
  '**/db.test.js',
  'services/catalogDB.test.js',
  'services/catalogDB.facets.db.test.js',
  'services/privacyVault.db.test.js',
  'services/catalogCanonProjection.test.js',
  'services/catalogRefResolver.test.js',
  'services/creativeDirector/projectsDB.test.js',
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
 * Adding a new DB-backed test? If it's named `*.db.test.js` it's auto-included.
 * Otherwise add it to `include` below — db.guards.test.js fails if a checkHealth
 * consumer is left out.
 */
export default defineConfig({
  test: {
    testTimeout: 15000,
    globals: true,
    setupFiles: ['./vitest.setup.js'],
    // One file at a time — these suites assume exclusive access to their tables.
    fileParallelism: false,
    env: {
      PGDATABASE: process.env.PGTESTDATABASE || 'portos_test',
    },
    include: DB_TEST_INCLUDE,
    exclude: [
      '**/node_modules/**',
      '../lib/slashdo/**',
    ],
  },
});
