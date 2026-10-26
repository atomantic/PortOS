import { existsSync, rmSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { checkWorkspaceCacheIsolation } from './lib/workspaceCacheFixture.js';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./lib/vitestTempRootFixture.js', async original => ({
  ...await original(), runFixtureToCompletion: run,
}));
afterEach(() => run.mockReset());

it('settles both publishers and retains their host when only the second close is unconfirmed', async () => {
  let host;
  let settleSecond;
  run.mockResolvedValueOnce({ error: Object.assign(new Error('cancelled'), { name: 'AbortError' }) });
  run.mockImplementationOnce(() => new Promise(resolve => { settleSecond = resolve; }));
  const pending = checkWorkspaceCacheIsolation('server', 'vitest.config.js', 'vitest', expect, undefined, {
    onHost: value => { host = value; },
  });
  try {
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0].options.env.PORTOS_PREGATE_MAX_WORKERS).toBe('1');
    await Promise.resolve();
    expect(existsSync(host)).toBe(true);
    settleSecond({ error: Object.assign(new Error('unconfirmed'), { code: 'FIXTURE_CLOSE_UNCONFIRMED' }) });
    await expect(pending).rejects.toMatchObject({ code: 'FIXTURE_CLOSE_UNCONFIRMED' });
    expect(existsSync(host)).toBe(true);
  } finally {
    // These mocked publishers created no child processes.
    rmSync(host, { recursive: true, force: true });
  }
});
