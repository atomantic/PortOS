import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { atomicWrite, setAtomicWriteDurabilityForTests } = await import('./fileCore.js');

afterEach(() => {
  vi.unstubAllEnvs();
  setAtomicWriteDurabilityForTests(true);
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
