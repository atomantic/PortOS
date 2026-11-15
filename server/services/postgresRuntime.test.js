import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing, getPostgresRuntimeStatus } from './postgresRuntime.js';

const LINES = [
  { major: '9.6', latestMinor: '24', eolDate: '2021-11-11', supported: false },
  { major: '17', latestMinor: '12', eolDate: '2029-11-08', supported: true },
];
const ok = (body) => vi.fn(async () => ({ ok: true, json: async () => body }));
const native = { PGPORT: '5432', PORTOS_NATIVE_PGPORT: '5432' };

describe('getPostgresRuntimeStatus', () => {
  beforeEach(() => __testing.resetReleaseCache());

  it('pairs the running server with its major line and caches the release index', async () => {
    const fetchImpl = ok(LINES);
    const status = await getPostgresRuntimeStatus({ env: native, readVersion: async () => '17.11 (Homebrew)', fetchImpl });
    expect(status).toEqual({ version: '17.11', major: 17, build: 'Homebrew', mode: 'native',
      line: { latestMinor: '12', eolDate: '2029-11-08', supported: true }, releasesError: null });
    await getPostgresRuntimeStatus({ env: native, readVersion: async () => '17.12', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await getPostgresRuntimeStatus({ fresh: true, env: native, readVersion: async () => '17.12', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports the Docker endpoint and a failed release index without losing the version', async () => {
    const status = await getPostgresRuntimeStatus({
      env: { PGPORT: '5561', PORTOS_NATIVE_PGPORT: '5432' },
      readVersion: async () => '17.12 (Debian 17.12-1.pgdg12+1)',
      fetchImpl: vi.fn(async () => ({ ok: false, status: 503 })),
    });
    expect(status).toMatchObject({ version: '17.12', major: 17, mode: 'docker', line: null, releasesError: expect.stringContaining('HTTP 503') });
  });
});
