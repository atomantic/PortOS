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

const CONFIGS = ['./vitest.config.js', './vitest.config.db.js'];

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  // Restores the pre-stub value even though the config under test reassigns
  // process.env.NODE_ENV directly.
  vi.unstubAllEnvs();
});

describe.each(CONFIGS)('%s', (configPath) => {
  it('overrides an inherited non-test NODE_ENV when the config loads', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(process.env.NODE_ENV).toBe('development'); // bypass probe: really unset

    await import(configPath);

    expect(process.env.NODE_ENV).toBe('test');
  });

  it('pins NODE_ENV=test for the worker processes too', async () => {
    const config = (await import(configPath)).default;
    expect(config.test.env.NODE_ENV).toBe('test');
  });
});
