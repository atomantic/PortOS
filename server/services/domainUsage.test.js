import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory file store so the ledger reads/writes hit no real disk.
let store = new Map();
let mockConfig = {};

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { cos: '/tmp/portos-test-cos' },
  atomicWrite: vi.fn(async (path, data) => { store.set(path, structuredClone(data)); }),
  readJSONFile: vi.fn(async (path, def = null) => (store.has(path) ? structuredClone(store.get(path)) : def))
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => ({ config: mockConfig }))
}));

const {
  USAGE_FILE,
  todayKey,
  recordDomainUsage,
  getDomainUsageToday,
  getAllDomainUsageToday,
  getDomainBudgetStatus
} = await import('./domainUsage.js');

beforeEach(() => {
  store = new Map();
  mockConfig = {};
});

describe('recordDomainUsage + getDomainUsageToday', () => {
  it('accumulates actions and ms for a domain', async () => {
    await recordDomainUsage('cos', { actions: 1, ms: 1000 });
    await recordDomainUsage('cos', { actions: 2, ms: 500 });
    expect(await getDomainUsageToday('cos')).toEqual({ actions: 3, ms: 1500 });
  });

  it('keeps domains independent', async () => {
    await recordDomainUsage('brain', { actions: 5 });
    await recordDomainUsage('messages', { actions: 2 });
    expect(await getDomainUsageToday('brain')).toEqual({ actions: 5, ms: 0 });
    expect(await getDomainUsageToday('messages')).toEqual({ actions: 2, ms: 0 });
    expect(await getDomainUsageToday('cos')).toEqual({ actions: 0, ms: 0 });
  });

  it('ignores unknown domains and empty deltas', async () => {
    await recordDomainUsage('bogus', { actions: 9 });
    await recordDomainUsage('cos', { actions: 0, ms: 0 });
    await recordDomainUsage('cos', {});
    expect(store.has(USAGE_FILE)).toBe(false);
  });

  it('resets the ledger when the stored date is not today', async () => {
    store.set(USAGE_FILE, {
      date: '2000-01-01',
      usage: { brain: { actions: 99, ms: 99 }, memory: { actions: 1, ms: 1 }, cos: { actions: 1, ms: 1 }, messages: { actions: 1, ms: 1 } }
    });
    // First read after a stale day shows zero...
    expect(await getDomainUsageToday('brain')).toEqual({ actions: 0, ms: 0 });
    // ...and a record stamps today's date with only the new delta.
    await recordDomainUsage('brain', { actions: 3 });
    const ledger = await getAllDomainUsageToday();
    expect(ledger.date).toBe(todayKey());
    expect(ledger.usage.brain).toEqual({ actions: 3, ms: 0 });
  });

  it('backfills missing domains and coerces bad tallies in a hand-edited file', async () => {
    store.set(USAGE_FILE, { date: todayKey(), usage: { brain: { actions: 'x', ms: null } } });
    expect(await getDomainUsageToday('brain')).toEqual({ actions: 0, ms: 0 });
    expect(await getDomainUsageToday('cos')).toEqual({ actions: 0, ms: 0 });
  });
});

describe('getDomainBudgetStatus', () => {
  it('is within budget (no ledger read) when the domain has no caps', async () => {
    mockConfig = {};
    const status = await getDomainBudgetStatus('cos');
    expect(status.withinBudget).toBe(true);
    expect(status.exceeded).toBeNull();
  });

  it('reports within budget while under the actions cap', async () => {
    mockConfig = { domainBudgets: { cos: { maxActionsPerDay: 3 } } };
    await recordDomainUsage('cos', { actions: 2 });
    const status = await getDomainBudgetStatus('cos');
    expect(status.withinBudget).toBe(true);
    expect(status.usage.actions).toBe(2);
  });

  it('reports exceeded once the actions cap is reached', async () => {
    mockConfig = { domainBudgets: { cos: { maxActionsPerDay: 3 } } };
    await recordDomainUsage('cos', { actions: 3 });
    const status = await getDomainBudgetStatus('cos');
    expect(status.withinBudget).toBe(false);
    expect(status.exceeded).toBe('actions');
  });

  it('reports exceeded once the minutes cap is reached', async () => {
    mockConfig = { domainBudgets: { cos: { maxMinutesPerDay: 5 } } };
    await recordDomainUsage('cos', { ms: 5 * 60_000 });
    const status = await getDomainBudgetStatus('cos');
    expect(status.withinBudget).toBe(false);
    expect(status.exceeded).toBe('minutes');
  });
});
