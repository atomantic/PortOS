import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { atomicWrite, setAtomicWriteDurabilityForTests } = await import('./fileCore.js');

afterEach(() => {
  vi.unstubAllEnvs();
  setAtomicWriteDurabilityForTests(true);
});

describe('worker default durability (#16864)', () => {
  const flushOptionOnFreshLoad = async (fastWrites) => {
    vi.resetModules();
    vi.stubEnv('PORTOS_TEST_FAST_WRITES', fastWrites);
    const writeFile = vi.fn(async () => { throw new Error('stop before rename'); });
    vi.doMock('fs/promises', async (importOriginal) => ({ ...(await importOriginal()), writeFile }));
    const fresh = await import('./fileCore.js');
    const dir = mkdtempSync(join(tmpdir(), 'portos-durability-default-'));
    try {
      await expect(fresh.atomicWrite(join(dir, 'store.json'), 'x')).rejects.toThrow('stop before rename');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.doUnmock('fs/promises');
      vi.resetModules();
    }
    return writeFile.mock.calls[0][2].flush;
  };

  it('starts non-durable when the Vitest config sets PORTOS_TEST_FAST_WRITES', async () => {
    expect(await flushOptionOnFreshLoad('1')).toBe(false);
  });

  it('starts durable when the config leaves the switch unset, as the DB suites do', async () => {
    expect(await flushOptionOnFreshLoad('')).toBe(true);
  });
});

describe('setAtomicWriteDurabilityForTests', () => {
  it('still publishes the whole payload when the fsyncs are skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-durability-'));
    try {
      setAtomicWriteDurabilityForTests(false);
      await atomicWrite(join(dir, 'store.json'), { rows: [1, 2, 3] });
      expect(JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'))).toEqual({ rows: [1, 2, 3] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to disable durability outside a Vitest worker', () => {
    vi.stubEnv('VITEST', undefined);
    expect(() => setAtomicWriteDurabilityForTests(false)).toThrow(/only available under Vitest/);
  });
});
