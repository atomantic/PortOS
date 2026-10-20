import { beforeEach, describe, expect, it, vi } from 'vitest';

const schedule = vi.fn();
const cancel = vi.fn();
const listAccounts = vi.fn();
const getAccount = vi.fn();
const listTerritories = vi.fn();
const syncAccount = vi.fn();
vi.mock('./eventScheduler.js', () => ({ schedule, cancel }));
vi.mock('./stackerNews.js', () => ({ listAccounts, getAccount, listTerritories, syncAccount }));
const { reconcileStackerNewsSchedulers, stopStackerNewsSchedulers } = await import('./stackerNewsScheduler.js');

describe('Stacker News scheduler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only arms explicitly enabled monitoring accounts and does not sync at registration', async () => {
    listAccounts.mockResolvedValue([
      { id: 'enabled', enabled: true, monitoringEnabled: true, monitoringIntervalMinutes: 15 },
      { id: 'quiet', enabled: true, monitoringEnabled: false, monitoringIntervalMinutes: 15 },
    ]);
    listTerritories.mockImplementation(async (id) => id === 'enabled' ? [{ monitoringEnabled: null }] : [{ monitoringEnabled: null }]);
    await expect(reconcileStackerNewsSchedulers()).resolves.toBe(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({ id: 'stacker-news-sync:enabled', type: 'interval', intervalMs: 900_000 });
    expect(syncAccount).not.toHaveBeenCalled();
    stopStackerNewsSchedulers();
  });

  it('never arms account-only monitoring without an effectively monitored territory', async () => {
    listAccounts.mockResolvedValue([{ id: 'dormant', enabled: true, monitoringEnabled: true, monitoringIntervalMinutes: 15 }]);
    for (const territories of [[], [{ monitoringEnabled: false }]]) {
      listTerritories.mockResolvedValue(territories);
      await expect(reconcileStackerNewsSchedulers()).resolves.toBe(0);
    }
    expect(schedule).not.toHaveBeenCalled();
    expect(syncAccount).not.toHaveBeenCalled();
    stopStackerNewsSchedulers();
  });

  it('arms a territory-level opt-in and rechecks the effective setting before syncing', async () => {
    const account = { id: 'territory-opt-in', enabled: true, monitoringEnabled: false, monitoringIntervalMinutes: 30 };
    listAccounts.mockResolvedValue([account]);
    listTerritories.mockResolvedValue([{ monitoringEnabled: true }]);
    getAccount.mockResolvedValue(account);
    await expect(reconcileStackerNewsSchedulers()).resolves.toBe(1);
    const handler = schedule.mock.calls[0][0].handler;
    await handler();
    expect(syncAccount).toHaveBeenCalledWith('territory-opt-in');
    listTerritories.mockResolvedValue([{ monitoringEnabled: false }]);
    await handler();
    expect(syncAccount).toHaveBeenCalledTimes(1);
    stopStackerNewsSchedulers();
  });
});
