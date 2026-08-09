import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../../lib/mockPathsDataRoot.js';

// Same hermetic setup as selfImprove.test.js — the observer pulls the pipeline
// graph in transitively; stub the peer fan-out and the spend/LLM edges.
vi.mock('../../instances.js', () => mockNoPeers());
vi.mock('../../sharing/peerSync.js', () => mockNoPeerSync());

const addTask = vi.fn(async (task) => ({ id: 'sys-1', ...task }));
vi.mock('../../cosTaskStore.js', () => ({ addTask: (...a) => addTask(...a) }));

let budgetStatus = { withinBudget: true, exceeded: null };
const recordDomainUsage = vi.fn(async () => {});
vi.mock('../../domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(async () => budgetStatus),
  recordDomainUsage: (...a) => recordDomainUsage(...a),
}));

let llmContent = null;
const runStagedLLM = vi.fn(async () => ({ content: llmContent }));
vi.mock('../../../lib/stageRunner.js', () => ({ runStagedLLM: (...a) => runStagedLLM(...a) }));

vi.mock('../../settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../series.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSeries: vi.fn(async (id) => ({ id, name: 'Example Series', targetFormat: 'comic' })),
  updateSeries: vi.fn(async () => null),
}));
vi.mock('../editorial/checkRunner.js', () => ({
  buildEditorialCheckPlan: vi.fn(async () => ({ checks: [{ id: 'info-dumping', kind: 'llm' }] })),
}));

const {
  freshSignals, shouldObserveStep, shouldObserveTerminal, isDispatchable,
  buildObserverTask, runObserverPass, summarizeObserver,
  OBSERVER_MIN_CONFIDENCE, OBSERVER_MAX_MIDRUN_PASSES, OBSERVER_AREAS,
} = await import('./observer.js');
const { shapeDiagnosis, SELF_IMPROVE_AREAS, isAutomationSignal } = await import('./diagnosisCore.js');
const { noteSignal, SIGNAL_FRAME_TYPES } = await import('./state.js');
const { PORTOS_APP_ID } = await import('../../../lib/appIdentity.js');

// Minimal run record shaped like the orchestrator's, with the observer knobs.
const makeRun = (over = {}) => ({
  runId: 'run-1',
  mode: 'execute',
  options: { observer: true, ...(over.options || {}) },
  signals: over.signals || [],
  signalsDropped: 0,
  runState: {
    editorialCheckErroredIds: new Set(),
    scriptCraftGapIssues: new Set(),
    observerCursor: 0,
    observerPassesRun: 0,
    observerFindings: [],
    ...(over.runState || {}),
  },
});

const goodDiagnosis = {
  verdict: 'pipeline',
  confidence: 0.9,
  area: 'editorial-check',
  title: 'Add a beat-level pleasantries check before the script stage',
  problem: 'Dialogue pleasantries are only caught after full scripts are generated.',
  evidence: ['child:retry kind=text'],
  proposedChange: 'Run the dialogue-pleasantries check at the beat altitude, before textStages.',
  risks: 'Beat sheets are terser than scripts; the check may need a lower finding cap.',
};

beforeEach(() => {
  addTask.mockClear();
  recordDomainUsage.mockClear();
  runStagedLLM.mockClear();
  budgetStatus = { withinBudget: true, exceeded: null };
  llmContent = { ...goodDiagnosis };
});

describe('signal retention for observer-only runs', () => {
  it('retains signals when only the observer opted in', () => {
    const run = makeRun();
    expect(noteSignal(run, { type: 'child:retry' })).toBe(true);
    expect(run.signals).toHaveLength(1);
  });
});

describe('trigger/retention alignment', () => {
  it('every frame type that can trigger a pass is also retained by noteSignal', () => {
    // A trigger type missing from the retention set would never fire — the
    // frame is dropped before the observer can see it — with no error anywhere.
    const triggerTypes = ['child:retry', 'child:escalate', 'step:skip', 'gap:filed', 'check:complete'];
    for (const type of triggerTypes) expect(SIGNAL_FRAME_TYPES.has(type)).toBe(true);
    expect(isAutomationSignal({ type: 'check:complete', error: 'boom' })).toBe(true);
    expect(isAutomationSignal({ type: 'check:complete' })).toBe(false);
  });
});

describe('shouldObserveStep', () => {
  it('requires the opt-in and execute mode', () => {
    expect(shouldObserveStep(makeRun({ options: { observer: false }, signals: [{ type: 'child:retry' }] }))).toBe(false);
    const dry = makeRun({ signals: [{ type: 'child:retry' }] });
    dry.mode = 'dry-run';
    expect(shouldObserveStep(dry)).toBe(false);
  });

  it('spends nothing after a clean step', () => {
    expect(shouldObserveStep(makeRun())).toBe(false);
    // Loop-progress frames are the system working, not a mid-run trigger.
    expect(shouldObserveStep(makeRun({ signals: [{ type: 'verify:round', blocking: 3 }] }))).toBe(false);
    // A skipped (not errored) check is usually benign.
    expect(shouldObserveStep(makeRun({ signals: [{ type: 'check:complete', checkId: 'c', skipped: true }] }))).toBe(false);
  });

  it('fires on the frames that say the automation misbehaved', () => {
    for (const s of [
      { type: 'child:retry' }, { type: 'child:escalate' }, { type: 'step:skip' },
      { type: 'gap:filed' }, { type: 'check:complete', checkId: 'c', error: 'boom' },
    ]) {
      expect(shouldObserveStep(makeRun({ signals: [s] }))).toBe(true);
    }
  });

  it('only reads signals past the cursor, and stops at the pass cap', () => {
    const consumed = makeRun({
      signals: [{ type: 'child:retry' }],
      runState: { observerCursor: 1 },
    });
    expect(freshSignals(consumed)).toEqual([]);
    expect(shouldObserveStep(consumed)).toBe(false);

    const capped = makeRun({
      signals: [{ type: 'child:retry' }],
      runState: { observerPassesRun: OBSERVER_MAX_MIDRUN_PASSES },
    });
    expect(shouldObserveStep(capped)).toBe(false);
  });
});

describe('shouldObserveTerminal', () => {
  it('mirrors the post-mortem gate: pause/error always, cancel never, clean done never', () => {
    expect(shouldObserveTerminal(makeRun(), 'paused')).toBe(true);
    expect(shouldObserveTerminal(makeRun(), 'error')).toBe(true);
    expect(shouldObserveTerminal(makeRun(), 'canceled')).toBe(false);
    expect(shouldObserveTerminal(makeRun(), 'done')).toBe(false);
    expect(shouldObserveTerminal(makeRun({ signals: [{ type: 'child:retry' }] }), 'done')).toBe(true);
    expect(shouldObserveTerminal(makeRun({ options: { observer: false } }), 'error')).toBe(false);
  });
});

describe('isDispatchable', () => {
  it('holds a HIGHER confidence bar than the human-reviewed post-mortem', () => {
    expect(isDispatchable(shapeDiagnosis(goodDiagnosis, OBSERVER_AREAS))).toBe(true);
    expect(isDispatchable(shapeDiagnosis({ ...goodDiagnosis, confidence: OBSERVER_MIN_CONFIDENCE - 0.01 }, OBSERVER_AREAS))).toBe(false);
    expect(isDispatchable(shapeDiagnosis({ ...goodDiagnosis, verdict: 'content' }, OBSERVER_AREAS))).toBe(false);
    expect(isDispatchable(shapeDiagnosis({ ...goodDiagnosis, proposedChange: '' }, OBSERVER_AREAS))).toBe(false);
  });

  it('accepts the observer-only ui area', () => {
    const shaped = shapeDiagnosis({ ...goodDiagnosis, area: 'ui' }, OBSERVER_AREAS);
    expect(shaped.area).toBe('ui');
    expect(isDispatchable(shaped)).toBe(true);
    expect(OBSERVER_AREAS).toEqual([...SELF_IMPROVE_AREAS, 'ui']);
  });
});

describe('buildObserverTask', () => {
  const build = (over = {}) => buildObserverTask({
    diagnosis: shapeDiagnosis(goodDiagnosis, OBSERVER_AREAS),
    seriesId: 'series-1',
    seriesName: 'Example Series',
    phase: 'after the textStages step',
    outcome: null,
    outcomeReason: null,
    counts: { 'child:retry': 2 },
    ...over,
  });

  it('targets PortOS, worktree-isolated, PR-opening, review-loop-then-merge', () => {
    const task = build();
    expect(task.app).toBe(PORTOS_APP_ID);
    expect(task.useWorktree).toBe(true);
    expect(task.openPR).toBe(true);
    expect(task.prCompletion).toBe('review-then-merge');
    expect(task.simplify).toBe(true);
  });

  it('is auto-approved — the one deliberate divergence from the post-mortem task', () => {
    expect(build().approvalRequired).toBe(false);
  });

  it('keeps the one-line description dedup key stable per defect, not per series', () => {
    const a = build();
    expect(a.description).not.toContain('\n');
    const b = build({ seriesId: 'series-2', seriesName: 'Another Series' });
    expect(b.description).toBe(a.description);
    const otherDefect = build({ diagnosis: shapeDiagnosis({ ...goodDiagnosis, title: 'Reverse outline is never refreshed' }, OBSERVER_AREAS) });
    expect(otherDefect.description).not.toBe(a.description);
    // Distinct from the self-improve dedup key so an observer task and a
    // post-mortem task about different diagnoses can't collide.
    expect(a.description).toMatch(/^Pipeline orchestrator improvement /);
  });

  it('warns the agent that its PR merges unattended', () => {
    expect(build().context).toContain('auto-approved');
    expect(build().context).toContain(goodDiagnosis.proposedChange);
  });
});

describe('runObserverPass (mid-run)', () => {
  it('spends nothing on a clean step and leaves the cursor alone', async () => {
    const run = makeRun();
    const out = await runObserverPass('series-1', run, { phase: 'step', stepKind: 'textStages' });
    expect(out).toBeNull();
    expect(runStagedLLM).not.toHaveBeenCalled();
    expect(run.runState.observerPassesRun).toBe(0);
  });

  it('spends nothing when the daily budget is exhausted, and latches mid-run passes off', async () => {
    budgetStatus = { withinBudget: false, exceeded: 'actions' };
    const run = makeRun({ signals: [{ type: 'child:retry' }] });
    const out = await runObserverPass('series-1', run, { phase: 'step', stepKind: 'textStages' });
    expect(out).toBeNull();
    expect(runStagedLLM).not.toHaveBeenCalled();
    // The untaken trigger frame must not re-poll the usage file on every
    // remaining step — the run is latched off for mid-run passes…
    expect(run.runState.observerBudgetExhausted).toBe(true);
    expect(shouldObserveStep(run)).toBe(false);
    // …but the terminal pass re-checks once (the budget may have rolled over).
    expect(shouldObserveTerminal(run, 'paused')).toBe(true);
  });

  it('dispatches an auto-approved task, bills one action and consumes the window', async () => {
    const run = makeRun({ signals: [{ type: 'child:retry', kind: 'text' }] });
    const out = await runObserverPass('series-1', run, { phase: 'step', stepKind: 'textStages' });
    expect(runStagedLLM).toHaveBeenCalledWith('pipeline-observer', expect.any(Object), expect.objectContaining({ returnsJson: true }));
    expect(recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1 });
    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({ app: PORTOS_APP_ID, approvalRequired: false }), 'internal');
    expect(out).toMatchObject({ area: 'editorial-check', filed: true, taskId: 'sys-1' });
    // The window is consumed — the same frames are never billed twice.
    expect(run.runState.observerCursor).toBe(1);
    expect(run.runState.observerPassesRun).toBe(1);
    expect(run.runState.observerFindings).toHaveLength(1);
  });

  it('consumes the window even when the verdict files nothing', async () => {
    llmContent = { ...goodDiagnosis, verdict: 'none' };
    const run = makeRun({ signals: [{ type: 'child:retry' }] });
    const out = await runObserverPass('series-1', run, { phase: 'step', stepKind: 'textStages' });
    expect(out).toBeNull();
    expect(addTask).not.toHaveBeenCalled();
    expect(run.runState.observerCursor).toBe(1);
    expect(run.runState.observerPassesRun).toBe(1);
  });

  it('drops a verdict below the raised confidence bar', async () => {
    // Filable for the post-mortem (>= 0.6) but NOT dispatchable unattended.
    llmContent = { ...goodDiagnosis, confidence: 0.65 };
    const run = makeRun({ signals: [{ type: 'child:retry' }] });
    const out = await runObserverPass('series-1', run, { phase: 'step', stepKind: 'textStages' });
    expect(out).toBeNull();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('reports a duplicate as tracked, not newly dispatched', async () => {
    addTask.mockResolvedValueOnce({ id: 'sys-earlier', duplicate: true });
    const run = makeRun({ signals: [{ type: 'child:retry' }] });
    const out = await runObserverPass('series-1', run, { phase: 'step', stepKind: 'textStages' });
    expect(out).toMatchObject({ filed: false, duplicate: true, taskId: 'sys-earlier' });
  });

  it('sends no manuscript content to the diagnosis stage', async () => {
    const run = makeRun({ signals: [{ type: 'child:escalate', kind: 'text' }] });
    await runObserverPass('series-1', run, { phase: 'step', stepKind: 'textStages' });
    const [, vars] = runStagedLLM.mock.calls[0];
    // Only run telemetry + configuration — the brief is read by an agent that
    // opens (and merges) a public PR.
    expect(Object.keys(vars).sort()).toEqual([
      'craftGapIssues', 'droppedSignals', 'enabledChecks', 'erroredChecks', 'gateConfigJson',
      'outcome', 'outcomeReason', 'phase', 'priorFilings', 'seriesName', 'signalCountsJson',
      'signalsJson', 'stepSequence', 'targetFormat',
    ]);
  });

  it('names prior filings so a later pass proposes the NEXT fix', async () => {
    const run = makeRun({
      signals: [{ type: 'child:retry' }],
      runState: { observerFindings: [{ area: 'runner', title: 'Retry budget is never applied' }] },
    });
    await runObserverPass('series-1', run, { phase: 'step', stepKind: 'textStages' });
    const [, vars] = runStagedLLM.mock.calls[0];
    expect(vars.priorFilings).toContain('Retry budget is never applied');
  });
});

describe('runObserverPass (terminal)', () => {
  it('reads the whole retained log without consuming a mid-run pass', async () => {
    const run = makeRun({
      signals: [{ type: 'child:retry' }, { type: 'step:skip' }],
      runState: { observerCursor: 2, observerPassesRun: OBSERVER_MAX_MIDRUN_PASSES },
    });
    const out = await runObserverPass('series-1', run, { phase: 'terminal', outcome: 'paused', reason: 'editorialReview: ran out of rounds' });
    expect(out).toMatchObject({ filed: true });
    const [, vars] = runStagedLLM.mock.calls[0];
    // Both frames, not the (empty) fresh window.
    expect(vars.signalsJson).toContain('child:retry');
    expect(vars.signalsJson).toContain('step:skip');
    expect(run.runState.observerPassesRun).toBe(OBSERVER_MAX_MIDRUN_PASSES);
  });

  it('never fires on a cancel', async () => {
    const out = await runObserverPass('series-1', makeRun({ signals: [{ type: 'child:retry' }] }), { phase: 'terminal', outcome: 'canceled' });
    expect(out).toBeNull();
    expect(runStagedLLM).not.toHaveBeenCalled();
  });
});

describe('summarizeObserver', () => {
  it('is null until something was dispatched, then reports passes + filings', () => {
    expect(summarizeObserver(makeRun())).toBeNull();
    const run = makeRun({
      runState: {
        observerPassesRun: 2,
        observerFindings: [{ area: 'runner', title: 'x', taskId: 'sys-1', filed: true, duplicate: false }],
      },
    });
    expect(summarizeObserver(run)).toEqual({
      passes: 2,
      filed: [{ area: 'runner', title: 'x', taskId: 'sys-1', filed: true, duplicate: false }],
    });
  });
});
