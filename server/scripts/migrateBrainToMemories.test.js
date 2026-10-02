import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { syncAllBrainData } = vi.hoisted(() => ({ syncAllBrainData: vi.fn() }));
vi.mock('../services/brainMemoryBridge.js', () => ({ syncAllBrainData }));

describe('Brain migration CLI mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    syncAllBrainData.mockReset().mockResolvedValue({ synced: 3, skipped: 0, errors: 0 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { args: [], dryRun: true, mode: 'default preview' },
    { args: ['--execute'], dryRun: false, mode: 'explicit execute' },
  ])('forwards $mode to the bridge', async ({ args, dryRun }) => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'migrateBrainToMemories.js', ...args]);

    await import('./migrateBrainToMemories.js');
    await vi.runAllTimersAsync();

    expect(syncAllBrainData).toHaveBeenCalledExactlyOnceWith({ dryRun });
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
