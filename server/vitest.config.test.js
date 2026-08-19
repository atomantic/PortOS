/**
 * Regression guard for #4554 — the server suite MUST run with NODE_ENV=test.
 *
 * That single variable is what makes every store facade pick the file backend
 * instead of the developer's live Postgres. Vitest supplies `NODE_ENV=test`
 * only when the variable is UNSET, and PortOS itself runs under PM2 with
 * `NODE_ENV=development` (`ecosystem.config.cjs`) — so a commit fired from a
 * PortOS-spawned shell ran `.githooks/pre-commit` -> `npm test --prefix server`
 * with `development` inherited, and hundreds of suites aimed at the real
 * database. Measured on the reproduction: 457 failures across 43 files under
 * `NODE_ENV=development`, versus 1 under `NODE_ENV=test`.
 *
 * The configs therefore FORCE the value rather than defaulting it. These cases
 * assert the forcing, not the defaulting — the bypass probe is the stubbed
 * `development` value each one starts from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('./vitest.config.db.js');
  // Restores the pre-stub value even though the config under test reassigns
  // process.env.NODE_ENV directly.
  vi.unstubAllEnvs();
});

/** Assert the just-loaded config both forced the value and pinned it for workers. */
async function expectForces(configPath) {
  vi.stubEnv('NODE_ENV', 'development');
  expect(process.env.NODE_ENV).toBe('development'); // bypass probe: the stub took

  const config = (await import(configPath)).default;

  expect(process.env.NODE_ENV).toBe('test');
  expect(config.test.env.NODE_ENV).toBe('test');
}

describe('vitest.config.js', () => {
  it('forces NODE_ENV=test on its own, not via the db config it imports', async () => {
    // It pulls DB_TEST_INCLUDE from vitest.config.db.js, and THAT module forces
    // NODE_ENV at its own top level — so without stubbing the import out, this
    // case would still pass with vitest.config.js's assignment deleted.
    vi.doMock('./vitest.config.db.js', () => ({ DB_TEST_INCLUDE: [] }));
    await expectForces('./vitest.config.js');
  });
});

describe('vitest.config.db.js', () => {
  it('forces NODE_ENV=test when loaded directly by npm run test:db', async () => {
    await expectForces('./vitest.config.db.js');
  });
});
