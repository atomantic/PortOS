import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../../lib/mockPathsDataRoot.js';

// selfImprove pulls the pipeline graph in transitively (session → autoRunner →
// …); stub the peer fan-out the way the other autopilot suites do so this stays
// hermetic. Postgres is never touched — nothing here loads a series.
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
// Keep the REAL series module (the pipeline graph re-exports constants from it)
// and override only the reads this module makes.
vi.mock('../series.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSeries: vi.fn(async (id) => ({ id, name: 'Example Series', targetFormat: 'comic' })),
  updateSeries: vi.fn(async () => null),
}));
vi.mock('../editorial/checkRunner.js', () => ({
  buildEditorialCheckPlan: vi.fn(async () => ({ checks: [{ id: 'info-dumping', kind: 'llm' }] })),
}));

const {
  shouldDiagnose, shapeDiagnosis, isFilable, buildSelfImproveTask, runSelfImproveDiagnosis,
  SELF_IMPROVE_MIN_CONFIDENCE,
} = await import('./selfImprove.js');
const { isSignalFrame, noteSignal, summarizeSignals, MAX_SIGNALS } = await import('./state.js');
const { PORTOS_APP_ID } = await import('../../../lib/appIdentity.js');

// Minimal run record shaped like the orchestrator's, with the knobs each test needs.
const makeRun = (over = {}) => ({
  runId: 'run-1',
  mode: 'execute',
  options: { selfImprove: true, ...(over.options || {}) },
  signals: over.signals || [],
  signalsDropped: 0,
  runState: {
    editorialCheckErroredIds: new Set(),
    scriptCraftGapIssues: new Set(),
    ...(over.runState || {}),
  },
});

const goodDiagnosis = {
  verdict: 'pipeline',
  confidence: 0.9,
  area: 'editorial-check',
  title: 'Add a beat-level pleasantries check before the script stage',
  problem: 'Dialogue pleasantries are only caught after full scripts are generated.',
  evidence: ['verify:round scope=editorial round=2 blocking=7'],
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

describe('isSignalFrame', () => {
  it('keeps the frames that describe trouble', () => {
    expect(isSignalFrame({ type: 'child:retry' })).toBe(true);
    expect(isSignalFrame({ type: 'verify:round', blocking: 3 })).toBe(true);
    expect(isSignalFrame({ type: 'check:complete', checkId: 'c', error: 'boom' })).toBe(true);
  });

  it('drops the happy-path noise', () => {
    // A healthy check is the system working — retaining 40 of these per pass
    // would crowd the failures out of the bounded log.
    expect(isSignalFrame({ type: 'check:complete', checkId: 'c', count: 2 })).toBe(false);
    expect(isSignalFrame({ type: 'step:start', kind: 'textStages' })).toBe(false);
    expect(isSignalFrame({ type: 'step:complete', kind: 'textStages' })).toBe(false);
    // The terminals arrive as the outcome/reason arguments, not as signals.
    expect(isSignalFrame({ type: 'paused', reason: 'x' })).toBe(false);
    expect(isSignalFrame({ type: 'error', error: 'x' })).toBe(false);
    expect(isSignalFrame(null)).toBe(false);
    expect(isSignalFrame({})).toBe(false);
  });
});

describe('noteSignal', () => {
  it('no-ops on a run that did not opt in, and on a dry-run', () => {
    const optedOut = makeRun({ options: { selfImprove: false } });
    expect(noteSignal(optedOut, { type: 'child:retry' })).toBe(false);
    expect(optedOut.signals).toEqual([]);

    const dry = makeRun();
    dry.mode = 'dry-run';
    expect(noteSignal(dry, { type: 'child:retry' })).toBe(false);
    expect(dry.signals).toEqual([]);
  });

  it('retains frames up to the cap, then counts the overflow', () => {
    const run = makeRun();
    for (let i = 0; i < MAX_SIGNALS + 5; i += 1) noteSignal(run, { type: 'child:retry', i });
    expect(run.signals).toHaveLength(MAX_SIGNALS);
    expect(run.signalsDropped).toBe(5);
    expect(summarizeSignals(run)).toMatchObject({ counts: { 'child:retry': MAX_SIGNALS }, dropped: 5 });
  });
});

describe('shouldDiagnose', () => {
  it('always diagnoses a pause or an error', () => {
    expect(shouldDiagnose(makeRun(), 'paused')).toBe(true);
    expect(shouldDiagnose(makeRun(), 'error')).toBe(true);
  });

  it('never diagnoses a cancel, a dry-run, or an opted-out run', () => {
    expect(shouldDiagnose(makeRun(), 'canceled')).toBe(false);
    const dry = makeRun();
    dry.mode = 'dry-run';
    expect(shouldDiagnose(dry, 'paused')).toBe(false);
    expect(shouldDiagnose(makeRun({ options: { selfImprove: false } }), 'error')).toBe(false);
  });

  it('spends nothing on a clean `done` run', () => {
    expect(shouldDiagnose(makeRun(), 'done')).toBe(false);
  });

  it('diagnoses a `done` run that limped', () => {
    expect(shouldDiagnose(makeRun({ runState: { editorialCheckErroredIds: new Set(['x']) } }), 'done')).toBe(true);
    expect(shouldDiagnose(makeRun({ runState: { scriptCraftGapIssues: new Set(['i1']) } }), 'done')).toBe(true);
    expect(shouldDiagnose(makeRun({ signals: [{ type: 'child:retry' }] }), 'done')).toBe(true);
    expect(shouldDiagnose(makeRun({ signals: [{ type: 'step:skip', kind: 'scriptVerify' }] }), 'done')).toBe(true);
    // A retained frame that isn't itself a failure doesn't qualify.
    expect(shouldDiagnose(makeRun({ signals: [{ type: 'verify:round', blocking: 0 }] }), 'done')).toBe(false);
  });
});

describe('shapeDiagnosis', () => {
  it('bounds every field and defaults an unknown area', () => {
    const shaped = shapeDiagnosis({
      verdict: 'pipeline',
      confidence: 4,
      area: 'made-up',
      title: 'x'.repeat(500),
      evidence: Array.from({ length: 20 }, (_, i) => `e${i}`),
      proposedChange: 'do the thing',
    });
    expect(shaped.confidence).toBe(1);
    expect(shaped.area).toBe('pipeline-step');
    expect(shaped.title).toHaveLength(160);
    expect(shaped.evidence).toHaveLength(8);
    expect(shaped.problem).toBe('');
  });

  it('returns null when there is no readable verdict', () => {
    expect(shapeDiagnosis(null)).toBeNull();
    expect(shapeDiagnosis({ verdict: 'maybe' })).toBeNull();
    expect(shapeDiagnosis('nope')).toBeNull();
  });
});

describe('isFilable', () => {
  it('files only a confident pipeline verdict that says what to change', () => {
    expect(isFilable(shapeDiagnosis(goodDiagnosis))).toBe(true);
    expect(isFilable(shapeDiagnosis({ ...goodDiagnosis, verdict: 'content' }))).toBe(false);
    expect(isFilable(shapeDiagnosis({ ...goodDiagnosis, confidence: SELF_IMPROVE_MIN_CONFIDENCE - 0.01 }))).toBe(false);
    expect(isFilable(shapeDiagnosis({ ...goodDiagnosis, proposedChange: '' }))).toBe(false);
    expect(isFilable(shapeDiagnosis({ ...goodDiagnosis, title: '' }))).toBe(false);
  });
});

describe('buildSelfImproveTask', () => {
  const build = (over = {}) => buildSelfImproveTask({
    diagnosis: shapeDiagnosis(goodDiagnosis),
    seriesId: 'series-1',
    seriesName: 'Example Series',
    outcome: 'paused',
    outcomeReason: 'editorialReview: ran out of rounds',
    counts: { 'verify:round': 2 },
    ...over,
  });

  it('targets PortOS itself, worktree-isolated and PR-opening', () => {
    const task = build();
    expect(task.app).toBe(PORTOS_APP_ID);
    expect(task.useWorktree).toBe(true);
    expect(task.openPR).toBe(true);
    expect(task.prCompletion).toBe('review-then-merge');
  });

  it('keeps the dedup line stable per defect, not per series', () => {
    const firstLine = (t) => t.description.split('\n')[0];
    const a = build();
    const b = build({ seriesId: 'series-2', seriesName: 'Another Series', outcome: 'error' });
    // The defect lives in shared PortOS code — one open task should cover it
    // however many series hit it, so cosTaskStore's first-line dedup must match.
    expect(firstLine(a)).toBe(firstLine(b));
    expect(firstLine(a)).toContain('editorial-check');
    // A different area is different work and must NOT collapse onto it...
    const otherArea = build({ diagnosis: shapeDiagnosis({ ...goodDiagnosis, area: 'runner' }) });
    expect(firstLine(otherArea)).not.toBe(firstLine(a));
    // ...and neither must a DIFFERENT defect in the same area. Keying on the
    // bucket alone would cap PortOS at one open task per area forever and
    // silently discard every later diagnosis in it.
    const otherDefect = build({ diagnosis: shapeDiagnosis({ ...goodDiagnosis, title: 'Reverse outline is never refreshed before the checks' }) });
    expect(firstLine(otherDefect)).not.toBe(firstLine(a));
  });

  it('always awaits approval — an LLM diagnosis never dispatches a coding agent on its own', () => {
    expect(build().approvalRequired).toBe(true);
  });

  it('carries the run provenance in context, not the manuscript', () => {
    const ctx = JSON.parse(build().context);
    expect(ctx).toMatchObject({ source: 'series-autopilot-self-improve', seriesId: 'series-1', outcome: 'paused', area: 'editorial-check' });
    expect(ctx.evidence).toEqual(goodDiagnosis.evidence);
  });
});

describe('runSelfImproveDiagnosis', () => {
  it('spends nothing when there is no signal to diagnose', async () => {
    const out = await runSelfImproveDiagnosis('series-1', makeRun(), { outcome: 'done' });
    expect(out).toBeNull();
    expect(runStagedLLM).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('spends nothing when the daily budget is exhausted', async () => {
    budgetStatus = { withinBudget: false, exceeded: 'actions' };
    const out = await runSelfImproveDiagnosis('series-1', makeRun(), { outcome: 'paused' });
    expect(out).toBeNull();
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('files a PortOS task on a confident pipeline verdict and bills one action', async () => {
    const run = makeRun({ signals: [{ type: 'verify:round', scope: 'editorial', round: 2, blocking: 7 }] });
    const out = await runSelfImproveDiagnosis('series-1', run, { outcome: 'paused', reason: 'editorialReview: ran out of rounds' });
    expect(runStagedLLM).toHaveBeenCalledWith('pipeline-self-improve', expect.any(Object), expect.objectContaining({ returnsJson: true }));
    expect(recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1 });
    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({ app: PORTOS_APP_ID }), 'internal');
    expect(out).toMatchObject({ verdict: 'pipeline', area: 'editorial-check', filed: true, taskId: 'sys-1' });
    expect(addTask.mock.calls[0][0].approvalRequired).toBe(true);
  });

  it('reports nothing on a content verdict — the pipeline behaved', async () => {
    llmContent = { ...goodDiagnosis, verdict: 'content' };
    const out = await runSelfImproveDiagnosis('series-1', makeRun(), { outcome: 'error', reason: 'boom' });
    expect(addTask).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it('swallows an unreadable response instead of throwing', async () => {
    llmContent = 'not json at all';
    const out = await runSelfImproveDiagnosis('series-1', makeRun(), { outcome: 'error', reason: 'boom' });
    expect(addTask).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it('files nothing on a low-confidence pipeline verdict', async () => {
    llmContent = { ...goodDiagnosis, confidence: 0.4 };
    const out = await runSelfImproveDiagnosis('series-1', makeRun(), { outcome: 'paused', reason: 'x' });
    expect(addTask).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it('reports a duplicate as tracked, not newly filed', async () => {
    addTask.mockResolvedValueOnce({ id: 'sys-earlier', duplicate: true });
    const out = await runSelfImproveDiagnosis('series-1', makeRun(), { outcome: 'paused', reason: 'x' });
    expect(out).toMatchObject({ filed: false, duplicate: true, taskId: 'sys-earlier' });
  });

  it('sends no manuscript content to the diagnosis stage', async () => {
    await runSelfImproveDiagnosis('series-1', makeRun({ signals: [{ type: 'child:escalate', kind: 'text' }] }), { outcome: 'paused', reason: 'x' });
    const [, vars] = runStagedLLM.mock.calls[0];
    // Only run telemetry + configuration — the prompt is a defect report about
    // PortOS, read by an agent that opens a public PR.
    expect(Object.keys(vars).sort()).toEqual([
      'craftGapIssues', 'droppedSignals', 'enabledChecks', 'erroredChecks', 'gateConfigJson',
      'outcome', 'outcomeReason', 'seriesName', 'signalCountsJson', 'signalsJson', 'stepSequence', 'targetFormat',
    ]);
  });
});
