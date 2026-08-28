import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const getActivities = vi.fn(() => Promise.resolve([]));
const getCalendarAccounts = vi.fn(() => Promise.resolve([]));
const scheduleGoalTimeBlocks = vi.fn(() => Promise.resolve({}));
const removeGoalSchedule = vi.fn(() => Promise.resolve({}));
const rescheduleGoalTimeBlocks = vi.fn(() => Promise.resolve({}));
const checkInGoal = vi.fn(() => Promise.resolve({ id: 'check-in-1' }));
const updateGoalProgress = vi.fn(() => Promise.resolve({}));
const updateGoal = vi.fn(() => Promise.resolve({}));
const addGoalProgress = vi.fn(() => Promise.resolve({}));
const addGoalTodo = vi.fn(() => Promise.resolve({}));
const generateGoalPhases = vi.fn(() => Promise.resolve([]));
const decomposeGoal = vi.fn(() => Promise.resolve([]));
const addGoalMilestone = vi.fn(() => Promise.resolve({}));
const completeGoalMilestone = vi.fn(() => Promise.resolve({}));
const completeMilestoneTask = vi.fn(() => Promise.resolve({}));

vi.mock('../services/api', () => ({
  getActivities: (...args) => getActivities(...args),
  getCalendarAccounts: (...args) => getCalendarAccounts(...args),
  scheduleGoalTimeBlocks: (...args) => scheduleGoalTimeBlocks(...args),
  removeGoalSchedule: (...args) => removeGoalSchedule(...args),
  rescheduleGoalTimeBlocks: (...args) => rescheduleGoalTimeBlocks(...args),
  checkInGoal: (...args) => checkInGoal(...args),
  updateGoalProgress: (...args) => updateGoalProgress(...args),
  updateGoal: (...args) => updateGoal(...args),
  addGoalProgress: (...args) => addGoalProgress(...args),
  addGoalTodo: (...args) => addGoalTodo(...args),
  generateGoalPhases: (...args) => generateGoalPhases(...args),
  decomposeGoal: (...args) => decomposeGoal(...args),
  addGoalMilestone: (...args) => addGoalMilestone(...args),
  completeGoalMilestone: (...args) => completeGoalMilestone(...args),
  completeMilestoneTask: (...args) => completeMilestoneTask(...args)
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

describe('useGoalDetail saveEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateGoal.mockResolvedValue({});
  });

  it('gates duplicate saves while the update is in flight', async () => {
    let release;
    updateGoal.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const { result } = renderGoalDetail();
    act(() => { result.current.startEdit(); });
    let first;
    act(() => { first = result.current.saveEdit(); });
    expect(result.current.saving).toBe(true);
    await act(async () => { await result.current.saveEdit(); });
    expect(updateGoal).toHaveBeenCalledTimes(1);
    await act(async () => { release({}); await first; });
    expect(result.current.saving).toBe(false);
  });

  it('keeps edit mode and form data when saving fails', async () => {
    updateGoal.mockRejectedValue(new Error('server exploded'));
    const { result, onRefresh } = renderGoalDetail();
    act(() => { result.current.startEdit(); });
    const originalForm = result.current.form;
    await act(async () => { await result.current.saveEdit(); });
    expect(result.current.saving).toBe(false);
    expect(result.current.editing).toBe(true);
    expect(result.current.form).toEqual(originalForm);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

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

describe('useGoalDetail creation actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivities.mockResolvedValue([]);
    getCalendarAccounts.mockResolvedValue([]);
    addGoalProgress.mockResolvedValue({});
    addGoalTodo.mockResolvedValue({});
  });

  it('gates duplicate progress submissions and refreshes after success', async () => {
    let release;
    addGoalProgress.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const { result, onRefresh } = renderGoalDetail();
    act(() => { result.current.setProgressForm({ date: '2026-08-27', note: 'Shipped it', durationMinutes: '' }); });
    let first;
    act(() => { first = result.current.handleAddProgress(); });
    expect(result.current.progressSubmitting).toBe(true);
    await act(async () => { await result.current.handleAddProgress(); });
    expect(addGoalProgress).toHaveBeenCalledTimes(1);
    await act(async () => { release({}); await first; });
    expect(result.current.progressSubmitting).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('preserves progress input and skips refresh after failure', async () => {
    addGoalProgress.mockRejectedValue(new Error('server exploded'));
    const { result, onRefresh } = renderGoalDetail();
    act(() => { result.current.setProgressForm({ date: '2026-08-27', note: 'Retry me', durationMinutes: '5' }); });
    await act(async () => { await result.current.handleAddProgress(); });
    expect(result.current.progressForm.note).toBe('Retry me');
    expect(result.current.progressSubmitting).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('gates duplicate todo submissions and preserves input after failure', async () => {
    let release;
    addGoalTodo.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const { result } = renderGoalDetail();
    act(() => { result.current.setNewTodoTitle('Follow up'); });
    let first;
    act(() => { first = result.current.handleAddTodo(); });
    expect(result.current.todoSubmitting).toBe(true);
    await act(async () => { await result.current.handleAddTodo(); });
    expect(addGoalTodo).toHaveBeenCalledTimes(1);
    await act(async () => { release({}); await first; });
    expect(result.current.todoSubmitting).toBe(false);
  });
});

// Issue #5201: a failed generate/decompose left the previous proposal on screen
// once the "Generating..."/"Decomposing..." label reset, reading as if the new
// request had succeeded and returned the same result again.
describe('useGoalDetail handleGeneratePhases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivities.mockResolvedValue([]);
    getCalendarAccounts.mockResolvedValue([]);
    generateGoalPhases.mockResolvedValue([{ title: 'Phase 1', order: 0 }]);
  });

  it('sets the proposal and clears generatingPhases on success', async () => {
    const { result } = renderGoalDetail();

    await act(async () => { await result.current.handleGeneratePhases(); });

    expect(generateGoalPhases).toHaveBeenCalledWith(GOAL.id);
    expect(result.current.proposedPhases).toEqual([{ title: 'Phase 1', order: 0 }]);
    expect(result.current.generatingPhases).toBe(false);
  });

  it('clears a stale proposal and generatingPhases when the request rejects', async () => {
    generateGoalPhases.mockResolvedValueOnce([{ title: 'Old phase', order: 0 }]);
    const { result } = renderGoalDetail();
    await act(async () => { await result.current.handleGeneratePhases(); });
    expect(result.current.proposedPhases).toEqual([{ title: 'Old phase', order: 0 }]);

    generateGoalPhases.mockRejectedValueOnce(new Error('server exploded'));
    await act(async () => { await result.current.handleGeneratePhases(); });

    expect(result.current.proposedPhases).toBeNull();
    expect(result.current.generatingPhases).toBe(false);
  });

  // A bare `.catch()` never gets attached when the call throws before handing back
  // a promise, so the reset would be skipped and the button would latch forever.
  it('clears generatingPhases when the api call throws synchronously', async () => {
    generateGoalPhases.mockImplementation(() => { throw new Error('threw before returning a promise'); });
    const { result } = renderGoalDetail();

    await act(async () => { await result.current.handleGeneratePhases(); });

    expect(result.current.generatingPhases).toBe(false);
    expect(result.current.proposedPhases).toBeNull();
  });

  it('does not surface a rejection to the caller as an unhandled promise', async () => {
    generateGoalPhases.mockRejectedValue(new Error('server exploded'));
    const { result } = renderGoalDetail();

    await act(async () => {
      await expect(result.current.handleGeneratePhases()).resolves.toBeUndefined();
    });
  });
});

describe('useGoalDetail handleDecompose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivities.mockResolvedValue([]);
    getCalendarAccounts.mockResolvedValue([]);
    decomposeGoal.mockResolvedValue([{ title: 'Milestone 1', order: 0 }]);
  });

  it('sets the proposal (stamped with a client key) and clears decomposing on success', async () => {
    const { result } = renderGoalDetail();

    await act(async () => { await result.current.handleDecompose(); });

    expect(decomposeGoal).toHaveBeenCalledWith(GOAL.id);
    expect(result.current.proposedDecomposition).toEqual([{ title: 'Milestone 1', order: 0, _key: 'prop-0' }]);
    expect(result.current.decomposing).toBe(false);
  });

  it('clears a stale proposal and decomposing when the request rejects', async () => {
    decomposeGoal.mockResolvedValueOnce([{ title: 'Old milestone', order: 0 }]);
    const { result } = renderGoalDetail();
    await act(async () => { await result.current.handleDecompose(); });
    expect(result.current.proposedDecomposition).not.toBeNull();

    decomposeGoal.mockRejectedValueOnce(new Error('server exploded'));
    await act(async () => { await result.current.handleDecompose(); });

    expect(result.current.proposedDecomposition).toBeNull();
    expect(result.current.decomposing).toBe(false);
  });

  // A bare `.catch()` never gets attached when the call throws before handing back
  // a promise, so the reset would be skipped and the button would latch forever.
  it('clears decomposing when the api call throws synchronously', async () => {
    decomposeGoal.mockImplementation(() => { throw new Error('threw before returning a promise'); });
    const { result } = renderGoalDetail();

    await act(async () => { await result.current.handleDecompose(); });

    expect(result.current.decomposing).toBe(false);
    expect(result.current.proposedDecomposition).toBeNull();
  });

  it('does not surface a rejection to the caller as an unhandled promise', async () => {
    decomposeGoal.mockRejectedValue(new Error('server exploded'));
    const { result } = renderGoalDetail();

    await act(async () => {
      await expect(result.current.handleDecompose()).resolves.toBeUndefined();
    });
  });
});

describe('useGoalDetail milestone actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivities.mockResolvedValue([]);
    getCalendarAccounts.mockResolvedValue([]);
    addGoalMilestone.mockResolvedValue({});
    completeGoalMilestone.mockResolvedValue({});
    completeMilestoneTask.mockResolvedValue({});
  });

  it('gates duplicate milestone submissions and clears the form after success', async () => {
    let release;
    addGoalMilestone.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const { result } = renderGoalDetail();
    act(() => { result.current.setNewMilestone({ title: 'Ship it', targetDate: '' }); });

    let first;
    act(() => { first = result.current.handleAddMilestone(); });
    expect(result.current.milestoneSubmitting).toBe(true);
    await act(async () => { await result.current.handleAddMilestone(); });
    expect(addGoalMilestone).toHaveBeenCalledTimes(1);
    await act(async () => { release({}); await first; });
    expect(result.current.milestoneSubmitting).toBe(false);
    expect(result.current.newMilestone).toEqual({ title: '', targetDate: '' });
  });

  it('preserves milestone input and clears submitting after failure', async () => {
    addGoalMilestone.mockRejectedValue(new Error('server exploded'));
    const { result, onRefresh } = renderGoalDetail();
    act(() => { result.current.setNewMilestone({ title: 'Retry me', targetDate: '2026-09-01' }); });

    await act(async () => { await result.current.handleAddMilestone(); });
    expect(result.current.newMilestone).toEqual({ title: 'Retry me', targetDate: '2026-09-01' });
    expect(result.current.milestoneSubmitting).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ['completeGoalMilestone', completeGoalMilestone, 'handleCompleteMilestone'],
    ['completeMilestoneTask', completeMilestoneTask, 'handleCompleteMilestoneTask']
  ])('%s swallows rejected requests and can be retried', async (_name, apiFn, handler) => {
    apiFn.mockRejectedValueOnce(new Error('server exploded'));
    const { result, onRefresh } = renderGoalDetail();

    await act(async () => {
      await expect(handler === 'handleCompleteMilestone'
        ? result.current[handler]('milestone-1')
        : result.current[handler]('milestone-1', 'task-1')).resolves.toBeUndefined();
    });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(result.current.milestoneActions.size).toBe(0);

    await act(async () => {
      await (handler === 'handleCompleteMilestone'
        ? result.current[handler]('milestone-1')
        : result.current[handler]('milestone-1', 'task-1'));
    });
    expect(apiFn).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['completeGoalMilestone', completeGoalMilestone, 'handleCompleteMilestone'],
    ['completeMilestoneTask', completeMilestoneTask, 'handleCompleteMilestoneTask']
  ])('%s clears its action state when the API throws synchronously', async (_name, apiFn, handler) => {
    apiFn.mockImplementation(() => { throw new Error('threw before returning a promise'); });
    const { result, onRefresh } = renderGoalDetail();
    await act(async () => {
      await expect(handler === 'handleCompleteMilestone'
        ? result.current[handler]('milestone-1')
        : result.current[handler]('milestone-1', 'task-1')).resolves.toBeUndefined();
    });
    expect(result.current.milestoneActions.size).toBe(0);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
