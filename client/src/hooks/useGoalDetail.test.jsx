import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const getActivities = vi.fn(() => Promise.resolve([]));
const getCalendarAccounts = vi.fn(() => Promise.resolve([]));
const scheduleGoalTimeBlocks = vi.fn(() => Promise.resolve({}));
const removeGoalSchedule = vi.fn(() => Promise.resolve({}));
const rescheduleGoalTimeBlocks = vi.fn(() => Promise.resolve({}));
const checkInGoal = vi.fn(() => Promise.resolve({ id: 'check-in-1' }));
const updateGoalProgress = vi.fn(() => Promise.resolve({}));

vi.mock('../services/api', () => ({
  getActivities: (...args) => getActivities(...args),
  getCalendarAccounts: (...args) => getCalendarAccounts(...args),
  scheduleGoalTimeBlocks: (...args) => scheduleGoalTimeBlocks(...args),
  removeGoalSchedule: (...args) => removeGoalSchedule(...args),
  rescheduleGoalTimeBlocks: (...args) => rescheduleGoalTimeBlocks(...args),
  checkInGoal: (...args) => checkInGoal(...args),
  updateGoalProgress: (...args) => updateGoalProgress(...args)
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

  // A bare `.catch()` on the call would miss this: it never gets attached when the
  // action throws before handing back a promise, so the reset would be skipped and
  // the buttons would latch exactly as they did before the fix.
  it.each(SCHEDULING_ACTIONS)('%s clears schedulingBusy when the action throws synchronously', async (handler, apiFn) => {
    apiFn().mockImplementation(() => { throw new Error('threw before returning a promise'); });
    const { result, onRefresh } = renderGoalDetail();

    await act(async () => { await result.current[handler](); });

    expect(result.current.schedulingBusy).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not surface a rejection to the caller as an unhandled promise', async () => {
    scheduleGoalTimeBlocks.mockRejectedValue(new Error('server exploded'));
    const { result } = renderGoalDetail();

    await act(async () => {
      await expect(result.current.handleSchedule()).resolves.toBeUndefined();
    });
  });
});

// Issue #3518: handleCheckIn opened the accordion and refreshed unconditionally, so
// a failed check-in expanded an unchanged list with no sign anything went wrong.
describe('useGoalDetail handleCheckIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivities.mockResolvedValue([]);
    getCalendarAccounts.mockResolvedValue([]);
    checkInGoal.mockResolvedValue({ id: 'check-in-1' });
  });

  it('opens the check-ins list and refreshes when the server returns a check-in', async () => {
    const { result, onRefresh } = renderGoalDetail();

    await act(async () => { await result.current.handleCheckIn(); });

    expect(checkInGoal).toHaveBeenCalledWith(GOAL.id);
    expect(result.current.checkInsOpen).toBe(true);
    expect(result.current.checkingIn).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('flips checkingIn true while the request is in flight', async () => {
    let release;
    checkInGoal.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { result } = renderGoalDetail();

    let pending;
    act(() => { pending = result.current.handleCheckIn(); });
    expect(result.current.checkingIn).toBe(true);

    await act(async () => { release({ id: 'check-in-1' }); await pending; });
    expect(result.current.checkingIn).toBe(false);
  });

  it('leaves the check-ins list closed and skips the refresh when the request rejects', async () => {
    checkInGoal.mockRejectedValue(new Error('server exploded'));
    const { result, onRefresh } = renderGoalDetail();

    await act(async () => { await result.current.handleCheckIn(); });

    expect(result.current.checkInsOpen).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
    // The button must re-arm — the failure is recoverable by clicking again.
    expect(result.current.checkingIn).toBe(false);
  });

  // A 204/empty body is "nothing was created", not a check-in worth revealing.
  it('leaves the check-ins list closed when the server returns no check-in', async () => {
    checkInGoal.mockResolvedValue(null);
    const { result, onRefresh } = renderGoalDetail();

    await act(async () => { await result.current.handleCheckIn(); });

    expect(result.current.checkInsOpen).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(result.current.checkingIn).toBe(false);
  });

  // A bare `.catch()` never gets attached when the call throws before handing back
  // a promise, so the reset would be skipped and the button would latch forever.
  it('clears checkingIn when the api call throws synchronously', async () => {
    checkInGoal.mockImplementation(() => { throw new Error('threw before returning a promise'); });
    const { result, onRefresh } = renderGoalDetail();

    await act(async () => { await result.current.handleCheckIn(); });

    expect(result.current.checkingIn).toBe(false);
    expect(result.current.checkInsOpen).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not surface a rejection to the caller as an unhandled promise', async () => {
    checkInGoal.mockRejectedValue(new Error('server exploded'));
    const { result } = renderGoalDetail();

    await act(async () => {
      await expect(result.current.handleCheckIn()).resolves.toBeUndefined();
    });
  });

  it('can be retried after a failure', async () => {
    checkInGoal.mockRejectedValueOnce(new Error('server exploded'));
    const { result, onRefresh } = renderGoalDetail();

    await act(async () => { await result.current.handleCheckIn(); });
    expect(result.current.checkInsOpen).toBe(false);

    await act(async () => { await result.current.handleCheckIn(); });
    expect(checkInGoal).toHaveBeenCalledTimes(2);
    expect(result.current.checkInsOpen).toBe(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

// Issue #3520: the handler threw on a failed PUT, so ProgressSlider kept rendering
// the dragged percentage as if it had been saved.
describe('useGoalDetail handleProgressChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivities.mockResolvedValue([]);
    getCalendarAccounts.mockResolvedValue([]);
    updateGoalProgress.mockResolvedValue({});
  });

  it('saves the value, refreshes, and reports success', async () => {
    const { result, onRefresh } = renderGoalDetail();

    let outcome;
    await act(async () => { outcome = await result.current.handleProgressChange(85); });

    expect(updateGoalProgress).toHaveBeenCalledWith(GOAL.id, 85);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(outcome).toBe(true);
  });

  it('reports failure and skips the refresh when the request rejects', async () => {
    updateGoalProgress.mockRejectedValue(new Error('server exploded'));
    const { result, onRefresh } = renderGoalDetail();

    let outcome;
    await act(async () => { outcome = await result.current.handleProgressChange(85); });

    expect(outcome).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  // A bare `.catch()` never gets attached when the call throws before handing back a
  // promise, so the failure would surface as a rejection instead of a `false`.
  it('reports failure when the api call throws synchronously', async () => {
    updateGoalProgress.mockImplementation(() => { throw new Error('threw before returning a promise'); });
    const { result, onRefresh } = renderGoalDetail();

    let outcome;
    await act(async () => { outcome = await result.current.handleProgressChange(85); });

    expect(outcome).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not surface a rejection to the caller as an unhandled promise', async () => {
    updateGoalProgress.mockRejectedValue(new Error('server exploded'));
    const { result } = renderGoalDetail();

    await act(async () => {
      await expect(result.current.handleProgressChange(85)).resolves.toBe(false);
    });
  });
});
