import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listUserActions: vi.fn() }));
vi.mock('./userActions.js', () => ({
  listUserActions: (...args) => mocks.listUserActions(...args),
}));

import { USER_ACTION_REVIEW_LOOKBACK_DAYS, buildTaskInput } from './userActionReviewHooks.js';

describe('user-action-review buildTaskInput hook', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips the dispatch when the last 7 days of the ledger are empty', async () => {
    mocks.listUserActions.mockResolvedValueOnce([]);
    await expect(buildTaskInput()).resolves.toEqual({ skip: { reason: 'no-user-actions' } });
    const filters = mocks.listUserActions.mock.calls[0][0];
    expect(filters.limit).toBe(1);
    const lookbackMs = Date.now() - Date.parse(filters.from);
    expect(lookbackMs).toBeGreaterThan((USER_ACTION_REVIEW_LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000);
    expect(lookbackMs).toBeLessThanOrEqual(USER_ACTION_REVIEW_LOOKBACK_DAYS * 24 * 60 * 60 * 1000 + 60_000);
  });

  it('dispatches normally (no prompt override) when events exist', async () => {
    mocks.listUserActions.mockResolvedValueOnce([{ id: 'evt-1', type: 'settings.update' }]);
    await expect(buildTaskInput({ app: { id: null, name: 'PortOS' } })).resolves.toEqual({});
  });

  it('skips any per-app dispatch — the review is install-wide only', async () => {
    // A per-app cadence override would otherwise queue one identical
    // global-ledger review PER managed app.
    await expect(buildTaskInput({ app: { id: 'app-1', name: 'Acme App' } }))
      .resolves.toEqual({ skip: { reason: 'install-wide-only' } });
    expect(mocks.listUserActions).not.toHaveBeenCalled();
  });
});
