import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

vi.mock('child_process', () => ({
  exec: vi.fn()
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn()
}));

const { exec } = await import('child_process');
const { readFile } = await import('fs/promises');
const { getMemoryStats, _resetMemoryStatsCache } = await import('./memoryStats.js');

const mockExec = (stdout) => {
  exec.mockImplementation((_cmd, _opts, cb) => cb(null, { stdout, stderr: '' }));
};

describe('getMemoryStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMemoryStatsCache();
  });

  it('on macOS, returns "Memory Used" matching Activity Monitor (anonymous - purgeable + wired + compressor)', async () => {
    if (process.platform !== 'darwin') return;

    // Numbers chosen so the math is verifiable: with 16KB pages,
    // anonymous=1000, purgeable=100, wired=200, compressor_occupied=300 →
    // used = (1000 - 100 + 200 + 300) × 16KB = 1400 × 16384 = 22,937,600 bytes
    mockExec(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  10.
Pages active:                               500.
Pages inactive:                             400.
Pages speculative:                           50.
Pages wired down:                           200.
Pages purgeable:                            100.
Anonymous pages:                           1000.
Pages occupied by compressor:               300.
`);

    const stats = await getMemoryStats();
    expect(stats.source).toBe('vm_stat');
    expect(stats.total).toBe(os.totalmem());
    expect(stats.used).toBe(1400 * 16384);
    expect(stats.free).toBe(stats.total - stats.used);
  });

  it('clamps used to total when vm_stat numbers add up to more than physical memory (compressor over-counts on swap-heavy systems)', async () => {
    if (process.platform !== 'darwin') return;

    // Force usedPages × pageSize > totalmem — should clamp.
    const huge = Math.ceil(os.totalmem() / 16384) + 1000;
    mockExec(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages wired down:                           ${huge}.
Anonymous pages:                            0.
Pages purgeable:                            0.
Pages occupied by compressor:               0.
`);

    const stats = await getMemoryStats();
    expect(stats.used).toBeLessThanOrEqual(stats.total);
    expect(stats.free).toBeGreaterThanOrEqual(0);
  });

  it('falls back to os.freemem when vm_stat fails on macOS', async () => {
    if (process.platform !== 'darwin') return;

    exec.mockImplementation((_cmd, _opts, cb) => cb(new Error('vm_stat not found')));
    const stats = await getMemoryStats();
    expect(stats.source).toBe('os');
    expect(stats.total).toBe(os.totalmem());
  });

  it('caches the result and skips the subprocess on rapid repeat calls', async () => {
    if (process.platform !== 'darwin') return;

    mockExec(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages wired down:                           100.
Anonymous pages:                            500.
Pages purgeable:                              0.
Pages occupied by compressor:                50.
`);

    await getMemoryStats();
    await getMemoryStats();
    await getMemoryStats();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
