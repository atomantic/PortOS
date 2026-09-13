import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosTaskStore.js', () => ({
  addTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

const { addTask, getTaskById, updateTask } = await import('./cosTaskStore.js');
const {
  PREFLIGHT_CARD_STALE_MS,
  finishPreflightCard,
  finishPreflightDispatch,
  isPreflightCard,
  isStalePreflightCard,
  preflightCardId,
  preflightReporter,
  recordPreflightOutcome,
  reportPreflightStep,
  startPreflightCard,
} = await import('./preflightTaskCard.js');

const cardFor = (preflight) => ({ id: preflightCardId('demand-1'), metadata: { preflight } });

beforeEach(() => {
  vi.clearAllMocks();
  addTask.mockResolvedValue({ id: preflightCardId('demand-1') });
  updateTask.mockResolvedValue({ id: preflightCardId('demand-1') });
});

describe('preflightTaskCard', () => {
  it('opens the card in_progress so no spawn engine can admit a task with no prompt', async () => {
    await startPreflightCard({ requestId: 'demand-1', taskType: 'pr-reviewer', appId: 'portos', appName: 'PortOS', targetPullRequest: 42 });
    const [task, taskType, options] = addTask.mock.calls[0];
    expect(task.status).toBe('in_progress');
    expect(taskType).toBe('internal');
    expect(options).toMatchObject({ raw: true, suppressDequeue: true });
    // The PR/MR row finds the run its button started through these three keys.
    expect(task.metadata).toMatchObject({ app: 'portos', analysisType: 'pr-reviewer', targetPullRequest: 42 });
    expect(task.description).toContain('PortOS');
    expect(task.metadata.preflight.steps[0]).toMatchObject({ key: 'queued', status: 'active' });
  });

  it('writes nothing when there is no card — an automated run carries no reporter branch', async () => {
    getTaskById.mockResolvedValue(null);
    await reportPreflightStep('preflight-missing', 'security-scan');
    await finishPreflightCard('preflight-missing', { outcome: 'handed-off' });
    expect(updateTask).not.toHaveBeenCalled();
    const readsBefore = getTaskById.mock.calls.length;
    await preflightReporter(null)('security-scan');
    expect(getTaskById.mock.calls.length).toBe(readsBefore);
  });

  it('persists the advanced step and re-headlines the card', async () => {
    const { createPreflightState } = await import('../lib/preflightPlan.js');
    getTaskById.mockResolvedValue(cardFor(createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer', appName: 'PortOS' })));
    await reportPreflightStep(preflightCardId('demand-1'), 'security-scan', { detail: '2 screened' });
    const [, updates] = updateTask.mock.calls[0];
    expect(updates.description).toContain('hidden Unicode');
    expect(updates.metadata.preflight.steps.find(step => step.key === 'security-scan')).toMatchObject({ status: 'active', detail: '2 screened' });
  });

  it('stamps preflightFailure on a failed close, the key the PR row paints from', async () => {
    const { createPreflightState } = await import('../lib/preflightPlan.js');
    getTaskById.mockResolvedValue(cardFor(createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer' })));
    await finishPreflightCard(preflightCardId('demand-1'), { outcome: 'failed', reason: 'security-guard-unavailable', note: 'Repair the guard.' });
    const [, updates] = updateTask.mock.calls[0];
    expect(updates.status).toBe('completed');
    expect(updates.metadata).toMatchObject({ preflightFailure: 'security-guard-unavailable', note: 'Repair the guard.' });
  });

  it('writes once for a second close, so a generic sweep cannot re-stamp a card', async () => {
    const { createPreflightState, finalizePreflight } = await import('../lib/preflightPlan.js');
    const closed = finalizePreflight(createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer' }), { outcome: 'handed-off', resultTaskId: 't-1' });
    getTaskById.mockResolvedValue(cardFor(closed));
    expect(await finishPreflightCard(preflightCardId('demand-1'), { outcome: 'nothing-to-do' })).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('mints a terminal card for a run that never opened one, so one failure is one record', async () => {
    getTaskById.mockResolvedValue(null);
    await recordPreflightOutcome({
      requestId: 'demand-1', taskType: 'pr-reviewer', appId: 'portos', appName: 'PortOS', targetPullRequest: 42,
      outcome: 'failed', reason: 'security-guard-unavailable', note: 'Repair the guard.',
    });
    const [task, taskType, options] = addTask.mock.calls[0];
    expect(task.id).toBe('preflight-demand-1');
    expect(task.status).toBe('completed');
    expect(taskType).toBe('internal');
    expect(options).toMatchObject({ raw: true, suppressDequeue: true });
    expect(task.metadata).toMatchObject({
      app: 'portos', analysisType: 'pr-reviewer', targetPullRequest: 42,
      preflightFailure: 'security-guard-unavailable', note: 'Repair the guard.',
    });
    expect(task.metadata.preflight.phase).toBe('failed');
  });

  it('closes the existing card instead of minting a second record', async () => {
    const { createPreflightState } = await import('../lib/preflightPlan.js');
    getTaskById.mockResolvedValue(cardFor(createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer' })));
    await recordPreflightOutcome({ requestId: 'demand-1', taskType: 'pr-reviewer', outcome: 'failed', reason: 'security-guard-unavailable' });
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('marks dispatch and hands off in a SINGLE write, so the card never renders a half-done frame', async () => {
    const { createPreflightState } = await import('../lib/preflightPlan.js');
    getTaskById.mockResolvedValue(cardFor(createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer' })));
    await finishPreflightDispatch(preflightCardId('demand-1'), 'app-improve-1');
    // One read-modify-write: a second one would re-read the card it just wrote
    // and emit a second tasks:changed showing a dispatched-but-unfinished card.
    expect(updateTask).toHaveBeenCalledTimes(1);
    const [, closed] = updateTask.mock.calls[0];
    expect(closed.status).toBe('completed');
    expect(closed.metadata.preflight.outcome).toBe('handed-off');
    expect(closed.metadata.preflightResultTaskId).toBe('app-improve-1');
    // The dispatch step is DONE in that same write — a handed-off card whose
    // last step never ran renders as a run that skipped it.
    expect(closed.metadata.preflight.steps.find(step => step.key === 'dispatch').status).toBe('done');
  });

  it('closes as nothing-to-do when the run produced no task, rather than naming an agent that never started', async () => {
    const { createPreflightState } = await import('../lib/preflightPlan.js');
    getTaskById.mockResolvedValue(cardFor(createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer' })));
    await finishPreflightDispatch(preflightCardId('demand-1'), null);
    const [, closed] = updateTask.mock.calls.at(-1);
    expect(closed.metadata.preflight.outcome).toBe('nothing-to-do');
    expect(closed.metadata.preflightResultTaskId).toBeUndefined();
    expect(closed.metadata.preflight.steps.find(step => step.key === 'dispatch').status).toBe('skipped');
  });

  it('reads nothing for an uncarded run, so an automated origin pays no task lookup', async () => {
    await finishPreflightDispatch(null, 'app-improve-1');
    expect(getTaskById).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('treats a card as stale only once nothing could still be running it', async () => {
    const { createPreflightState } = await import('../lib/preflightPlan.js');
    const fresh = cardFor(createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer' }));
    expect(isPreflightCard(fresh)).toBe(true);
    expect(isPreflightCard({ metadata: {} })).toBe(false);
    expect(isStalePreflightCard(fresh)).toBe(false);
    // A multi-minute security scan is live work; only a restart leaves one older than the grace.
    expect(isStalePreflightCard(fresh, Date.now() + PREFLIGHT_CARD_STALE_MS + 1)).toBe(true);
    expect(isStalePreflightCard(cardFor({ requestId: 'd', steps: [], updatedAt: 'nonsense' }))).toBe(true);
  });
});
