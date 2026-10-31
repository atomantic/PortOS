import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../domainUsage.js', () => ({ recordDomainUsage: vi.fn(async () => {}) }));
vi.mock('../../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../issues.js', () => ({ listIssues: vi.fn(), getIssue: vi.fn(), updateStageWithLatest: vi.fn() }));
vi.mock('../pipelineJudge.js', () => ({ judgeIssue: vi.fn(), getIssueJudge: vi.fn(async () => null), getSeriesJudge: vi.fn() }));
vi.mock('../editorial/checkRunner.js', () => ({ runEditorialChecks: vi.fn(async () => ({ findings: [], runId: 'run-1' })) }));
vi.mock('../manuscriptReview.js', () => ({ seedReviewFromFindings: vi.fn(async () => {}), getReview: vi.fn() }));
vi.mock('../applyCuts.js', () => ({ applyCuts: vi.fn(), filterSafeCutComments: vi.fn(comments => comments) }));
vi.mock('../editorial/comparativeRank.js', () => ({
  eligibleIssues: vi.fn(issues => issues.filter(issue => issue.drafted)),
  getComparativeRank: vi.fn(async () => null),
}));
vi.mock('./session.js', () => ({
  broadcast: vi.fn(),
  budgetPause: vi.fn(async () => null),
  providerOverrideOpts: vi.fn(() => ({})),
  roleLlm: vi.fn(() => ({ providerOverride: 'provider-a', modelOverride: 'model-a', effortOverride: null })),
}));

import { recordDomainUsage } from '../../domainUsage.js';
import { listIssues, getIssue, updateStageWithLatest } from '../issues.js';
import { judgeIssue, getSeriesJudge } from '../pipelineJudge.js';
import { getReview } from '../manuscriptReview.js';
import { applyCuts } from '../applyCuts.js';
import { getComparativeRank } from '../editorial/comparativeRank.js';
import { broadcast, budgetPause } from './session.js';
import { runRevisionCycle } from './revisionSteps.js';

const SERIES = 'series-0000000001';
const ORIGINAL = 'The original prose, before any cut.';
const CUT = 'The prose, after the cut.';

let stage;
const record = () => ({
  runState: { revisionCyclesRun: 0, revisionScoreHistory: [] },
  options: { revisionMinCycles: 1, revisionMaxCycles: 5, revisionPlateauDelta: 0.3 },
});
const events = type => broadcast.mock.calls.map(([, payload]) => payload).filter(payload => payload.type === type);

beforeEach(() => {
  vi.clearAllMocks();
  stage = { input: 'brief', output: ORIGINAL, lastRunId: 'run-0' };
  judgeIssue.mockReset().mockResolvedValue({ status: 'complete', qualityScore: 6 });
  budgetPause.mockReset().mockResolvedValue(null);
  getComparativeRank.mockReset().mockResolvedValue(null);
  listIssues.mockResolvedValue([
    { id: 'issue-a-000000', number: 1, drafted: true },
    { id: 'issue-b-000000', number: 2, drafted: true },
  ]);
  getIssue.mockImplementation(async id => ({ id, number: 1, title: 'Example', stages: { prose: { ...stage } } }));
  updateStageWithLatest.mockImplementation(async (_id, _stageId, patch) => { Object.assign(stage, patch(stage)); });
  getSeriesJudge.mockResolvedValue({
    scores: [
      { issueId: 'issue-a-000000', judged: true, qualityScore: 6, stageId: 'prose' },
      { issueId: 'issue-b-000000', judged: true, qualityScore: 8, stageId: 'prose' },
    ],
    weakest: [{ issueId: 'issue-a-000000' }],
  });
  getReview.mockImplementation(async () => ({ comments: [{ issueId: 'issue-a-000000', type: 'REDUNDANT' }] }));
  applyCuts.mockImplementation(async () => { stage.output = CUT; return { applied: 1 }; });
});

describe('runRevisionCycle (#14430)', () => {
  it('converges with no-content when nothing is drafted', async () => {
    listIssues.mockResolvedValue([{ id: 'issue-a-000000', drafted: false }]);
    const run = record();
    expect(await runRevisionCycle(SERIES, run)).toEqual({});
    expect(run.runState.revisionConverged).toBe(true);
    expect(events('revision:converged')).toEqual([{ type: 'revision:converged', reason: 'no-content', cycle: 0 }]);
    expect(judgeIssue).not.toHaveBeenCalled();
  });

  it.each([
    ['a stale ranking', { status: 'complete', stale: true }, 'issue-a-000000'],
    ['a budget-stopped ranking', { status: 'complete', budgetStopped: true }, 'issue-a-000000'],
    ['a partial ranking', { status: 'partial' }, 'issue-a-000000'],
    ['a fresh complete ranking', { status: 'complete' }, 'issue-b-000000'],
  ])('revises the weakest issue from %s', async (_label, rank, expected) => {
    getComparativeRank.mockResolvedValue({ ...rank, weakest: [{ issueId: 'issue-b-000000' }] });
    await runRevisionCycle(SERIES, record());
    expect(events('revision:brief')[0].issueId).toBe(expected);
  });

  it('converges with no-weakest when neither the ranking nor the judge names one', async () => {
    getSeriesJudge.mockResolvedValue({ scores: [], weakest: [] });
    const run = record();
    expect(await runRevisionCycle(SERIES, run)).toEqual({});
    expect(events('revision:converged')).toEqual([{ type: 'revision:converged', reason: 'no-weakest', cycle: 0 }]);
    expect(applyCuts).not.toHaveBeenCalled();
  });

  it('keeps an improved revision after one billed re-judge', async () => {
    judgeIssue.mockResolvedValue({ status: 'complete', qualityScore: 7 });
    const run = record();
    await runRevisionCycle(SERIES, run);
    expect(judgeIssue).toHaveBeenCalledTimes(1);
    expect(judgeIssue).toHaveBeenCalledWith('issue-a-000000', expect.objectContaining({ stageId: 'prose', force: true, providerDefault: 'provider-a' }));
    // One action for the adversarial cuts pass, one for the re-judge.
    expect(recordDomainUsage).toHaveBeenCalledTimes(2);
    expect(stage.output).toBe(CUT);
    expect(updateStageWithLatest).not.toHaveBeenCalled();
    expect(events('revision:cycle')[0]).toMatchObject({ decision: 'keep', preScore: 6, postScore: 7, applied: 1 });
    expect(run.runState.revisionCyclesRun).toBe(1);
  });

  it('does not bill a re-judge that did not complete', async () => {
    judgeIssue.mockResolvedValue({ status: 'error' });
    await runRevisionCycle(SERIES, record());
    expect(recordDomainUsage).toHaveBeenCalledTimes(1);
    expect(events('revision:cycle')[0]).toMatchObject({ decision: 'keep', postScore: 6 });
  });

  it('reverts a regressed revision, then re-judges the restored text and bills it', async () => {
    judgeIssue.mockResolvedValueOnce({ status: 'complete', qualityScore: 5 })
      .mockResolvedValueOnce({ status: 'complete', qualityScore: 6 });
    await runRevisionCycle(SERIES, record());
    expect(stage).toMatchObject({ input: 'brief', output: ORIGINAL, status: 'edited' });
    expect(stage.lastRunId).toMatch(/^revert-/);
    expect(judgeIssue).toHaveBeenCalledTimes(2);
    expect(recordDomainUsage).toHaveBeenCalledTimes(3);
    expect(events('revision:cycle')[0]).toMatchObject({ decision: 'revert', postScore: 5 });
  });

  it('does not bill a restored-text re-judge that did not complete', async () => {
    judgeIssue.mockResolvedValueOnce({ status: 'complete', qualityScore: 5 }).mockResolvedValueOnce({ status: 'error' });
    await runRevisionCycle(SERIES, record());
    expect(recordDomainUsage).toHaveBeenCalledTimes(2);
  });

  it('leaves a concurrent human edit in place instead of reverting over it', async () => {
    judgeIssue.mockImplementationOnce(async () => { stage.output = 'A human edit.'; return { status: 'complete', qualityScore: 5 }; })
      .mockResolvedValueOnce({ status: 'complete', qualityScore: 6 });
    await runRevisionCycle(SERIES, record());
    expect(stage.output).toBe('A human edit.');
    expect(stage.status).toBeUndefined();
  });

  it('returns the budget pause before the re-judge spends', async () => {
    budgetPause.mockResolvedValueOnce(null).mockResolvedValueOnce({ pause: true, reason: 'budget' });
    const run = record();
    expect(await runRevisionCycle(SERIES, run)).toEqual({ pause: true, reason: 'budget' });
    expect(judgeIssue).not.toHaveBeenCalled();
    expect(run.runState.revisionCyclesRun).toBe(0);
  });

  it('still reverts but skips the restored-text re-judge when the budget is spent', async () => {
    budgetPause.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ pause: true });
    judgeIssue.mockResolvedValue({ status: 'complete', qualityScore: 5 });
    expect(await runRevisionCycle(SERIES, record())).toEqual({});
    expect(stage.output).toBe(ORIGINAL);
    expect(judgeIssue).toHaveBeenCalledTimes(1);
    expect(recordDomainUsage).toHaveBeenCalledTimes(2);
  });
});
