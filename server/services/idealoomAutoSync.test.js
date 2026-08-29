import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./idealoomLists.js', () => ({ getSettings: vi.fn() }));
vi.mock('./idealoomObsidian.js', () => ({ exportToObsidian: vi.fn() }));

import * as lists from './idealoomLists.js';
import * as exchange from './idealoomObsidian.js';
import { AUTO_SYNC_DEBOUNCE_MS, flushAutoSync, scheduleAutoSync } from './idealoomAutoSync.js';

const LIST_ID = 'f1c2d3e4-5678-4abc-9def-0123456789ab';
const OTHER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const clean = () => ({ imported: 0, exported: 1, skipped: 0, conflicted: 0, missing: 0, malformed: 0, unavailable: 0, failed: 0 });

// Real time is never awaited here: the debounce is driven with fake timers so
// the contract is tested without a production sleep in the suite.
const settle = async () => {
  await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
  await flushAutoSync();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  lists.getSettings.mockResolvedValue({ enabled: true, autoSync: true, obsidianVaultId: 'vault-1' });
  exchange.exportToObsidian.mockResolvedValue(clean());
});

afterEach(async () => {
  await flushAutoSync();
  vi.useRealTimers();
});

describe('IdeaLoom automatic sync', () => {
  it('debounces a burst of edits into one export per list', async () => {
    scheduleAutoSync(LIST_ID);
    scheduleAutoSync(LIST_ID);
    scheduleAutoSync(OTHER_ID);
    expect(exchange.exportToObsidian).not.toHaveBeenCalled();

    await settle();

    expect(exchange.exportToObsidian).toHaveBeenCalledTimes(2);
    expect(exchange.exportToObsidian).toHaveBeenCalledWith({ listId: LIST_ID });
    expect(exchange.exportToObsidian).toHaveBeenCalledWith({ listId: OTHER_ID });
  });

  it('never asks the exchange to recreate a deleted note', async () => {
    scheduleAutoSync(LIST_ID);
    await settle();

    // recreateMissing is absent, so the export defaults to fail-closed and a
    // note the user deleted comes back as `missing` rather than reappearing.
    expect(exchange.exportToObsidian).toHaveBeenCalledWith({ listId: LIST_ID });
    expect(exchange.exportToObsidian.mock.calls[0][0]).not.toHaveProperty('recreateMissing');
  });

  it.each([
    ['auto-sync off', { enabled: true, autoSync: false, obsidianVaultId: 'vault-1' }],
    ['integration disabled', { enabled: false, autoSync: true, obsidianVaultId: 'vault-1' }],
    ['no vault configured', { enabled: true, autoSync: true, obsidianVaultId: null }],
  ])('writes nothing when %s', async (_label, settings) => {
    lists.getSettings.mockResolvedValue(settings);

    scheduleAutoSync(LIST_ID);
    await settle();

    expect(exchange.exportToObsidian).not.toHaveBeenCalled();
  });

  it('re-reads the toggles at fire time, so turning auto-sync off cancels queued work', async () => {
    scheduleAutoSync(LIST_ID);
    lists.getSettings.mockResolvedValue({ enabled: true, autoSync: false, obsidianVaultId: 'vault-1' });

    await settle();

    expect(exchange.exportToObsidian).not.toHaveBeenCalled();
  });

  it('keeps running after a failed export instead of crashing the process', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    exchange.exportToObsidian.mockRejectedValueOnce(new Error('vault offline'));

    scheduleAutoSync(LIST_ID);
    await settle();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('vault offline'));

    exchange.exportToObsidian.mockResolvedValue(clean());
    scheduleAutoSync(OTHER_ID);
    await settle();
    expect(exchange.exportToObsidian).toHaveBeenLastCalledWith({ listId: OTHER_ID });
    consoleError.mockRestore();
  });

  it('warns rather than silently swallowing an unresolved outcome', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exchange.exportToObsidian.mockResolvedValue({ ...clean(), exported: 0, conflicted: 1 });

    scheduleAutoSync(LIST_ID);
    await settle();

    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining(LIST_ID));
    consoleWarn.mockRestore();
  });
});
