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
import { BROWSER_SUITES } from '../scripts/lib/browserSuites.js';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
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

// Root exclusions apply before full, explicit-file and related selection. Both
// projects must retain them: the capture group has its own explicit include list.
describe('browser suite CI ownership', () => {
  it.each([
    ['linux', undefined, false],
    ['linux', 'browser', false],
    ['linux', 'unit', true],
    ['win32', 'unit', false],
  ])('collects the intended contracts on %s with owner %s', async (platform, owner, excluded) => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    vi.stubEnv('PORTOS_CI_BROWSER_OWNER', owner);
    const { default: config } = await import('./vitest.config.js');
    const suites = BROWSER_SUITES.map(path => path.slice('server/'.length));
    const projects = config.test.projects.map(project => project.test);
    const capture = projects.find(project => project.name === 'capture');
    const parallel = projects.find(project => project.name === 'parallel');
    const expected = excluded ? suites : [];
    expect(config.test.exclude.filter(path => suites.includes(path))).toEqual(expected);
    expect(capture.exclude.filter(path => suites.includes(path))).toEqual(expected);
    for (const suite of suites) {
      if (excluded) expect(parallel.exclude).toContain(suite);
      else if (capture.include.includes(suite)) expect(capture.exclude).not.toContain(suite);
      else {
        expect(parallel.include).toContain('**/*.test.js');
        expect(parallel.exclude).not.toContain(suite);
      }
    }
    // This independent browser contract has no registry owner and must still run.
    const overlay = 'services/musicVideo/overlayTextService.browser.test.js';
    expect(suites).not.toContain(overlay);
    expect(config.test.exclude).not.toContain(overlay);
    expect(capture.include).toContain(overlay);
    expect(capture.exclude).not.toContain(overlay);
  });
});
