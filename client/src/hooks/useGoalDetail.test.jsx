import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const getActivities = vi.fn(() => Promise.resolve([]));
const getCalendarAccounts = vi.fn(() => Promise.resolve([]));
const scheduleGoalTimeBlocks = vi.fn(() => Promise.resolve({}));
const removeGoalSchedule = vi.fn(() => Promise.resolve({}));
const rescheduleGoalTimeBlocks = vi.fn(() => Promise.resolve({}));

vi.mock('../services/api', () => ({
  getActivities: (...args) => getActivities(...args),
  getCalendarAccounts: (...args) => getCalendarAccounts(...args),
  scheduleGoalTimeBlocks: (...args) => scheduleGoalTimeBlocks(...args),
  removeGoalSchedule: (...args) => removeGoalSchedule(...args),
  rescheduleGoalTimeBlocks: (...args) => rescheduleGoalTimeBlocks(...args)
}));

const { useGoalDetail } = await import('./useGoalDetail');

const GOAL = { id: 'goal-1', title: 'Example Goal', horizon: 'quarter', category: 'health' };

const renderGoalDetail = (onRefresh = vi.fn()) => ({
  onRefresh,
  ...renderHook(() => useGoalDetail({ goal: GOAL, allGoals: [GOAL], onClose: vi.fn(), onRefresh }))
});

// Each row is [handler name, the mocked api fn it must call].
const SCHEDULING_ACTIONS = [
  ['handleSchedule', () => scheduleGoalTimeBlocks],
  ['handleRemoveSchedule', () => removeGoalSchedule],
  ['handleReschedule', () => rescheduleGoalTimeBlocks]
];

describe('useGoalDetail scheduling actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivities.mockResolvedValue([]);
    getCalendarAccounts.mockResolvedValue([]);
    scheduleGoalTimeBlocks.mockResolvedValue({});
    removeGoalSchedule.mockResolvedValue({});
    rescheduleGoalTimeBlocks.mockResolvedValue({});
  });

  it.each(SCHEDULING_ACTIONS)('%s calls its endpoint with the goal id and clears busy on success', async (handler, apiFn) => {
    const { result, onRefresh } = renderGoalDetail();

    await act(async () => { await result.current[handler](); });

    expect(apiFn()).toHaveBeenCalledWith(GOAL.id);
    expect(result.current.schedulingBusy).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it.each(SCHEDULING_ACTIONS)('%s flips schedulingBusy true while the request is in flight', async (handler, apiFn) => {
    let release;
    apiFn().mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { result } = renderGoalDetail();

    let pending;
    act(() => { pending = result.current[handler](); });
    expect(result.current.schedulingBusy).toBe(true);

    await act(async () => { release({}); await pending; });
    expect(result.current.schedulingBusy).toBe(false);
  });

  // Issue #3517: a rejected request used to abort before setSchedulingBusy(false),
  // latching every scheduling button on "Scheduling..." until a full page reload.
  it.each(SCHEDULING_ACTIONS)('%s clears schedulingBusy when the request rejects', async (handler, apiFn) => {
    apiFn().mockRejectedValue(new Error('server exploded'));
    const { result, onRefresh } = renderGoalDetail();

    await act(async () => { await result.current[handler](); });

    expect(result.current.schedulingBusy).toBe(false);
    // The panel still refreshes so a partially-written schedule shows real state.
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it.each(SCHEDULING_ACTIONS)('%s can be retried after a failure', async (handler, apiFn) => {
    apiFn().mockRejectedValueOnce(new Error('server exploded'));
    const { result } = renderGoalDetail();

    await act(async () => { await result.current[handler](); });
    expect(result.current.schedulingBusy).toBe(false);

    // The retry is the click that was impossible while the flag stayed latched.
    await act(async () => { await result.current[handler](); });
    expect(apiFn()).toHaveBeenCalledTimes(2);
    expect(result.current.schedulingBusy).toBe(false);
  });

  it('does not surface a rejection to the caller as an unhandled promise', async () => {
    scheduleGoalTimeBlocks.mockRejectedValue(new Error('server exploded'));
    const { result } = renderGoalDetail();

    await act(async () => {
      await expect(result.current.handleSchedule()).resolves.toBeUndefined();
    });
  });
});
