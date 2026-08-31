import { beforeEach, describe, expect, it, vi } from 'vitest';

const addTask = vi.hoisted(() => vi.fn(async () => ({ id: 'sys-example' })));
const getDomainBudgetStatus = vi.hoisted(() => vi.fn(async () => ({ withinBudget: true })));
const recordDomainUsage = vi.hoisted(() => vi.fn(async () => {}));
const runStagedLLM = vi.hoisted(() => vi.fn());

vi.mock('../cosTaskStore.js', () => ({ addTask: (...args) => addTask(...args) }));
vi.mock('../domainUsage.js', () => ({
  getDomainBudgetStatus: (...args) => getDomainBudgetStatus(...args),
  recordDomainUsage: (...args) => recordDomainUsage(...args),
}));
vi.mock('../stageRunner.js', () => ({ runStagedLLM: (...args) => runStagedLLM(...args) }));

const {
  FABLELOOM_EDITORIAL_SELF_IMPROVE_MIN_CONFIDENCE,
  buildFableLoomEditorialSelfImproveTask,
  buildFableLoomEditorialTelemetry,
  runFableLoomEditorialSelfImprove,
  shouldDiagnoseFableLoomEditorial,
} = await import('./editorialSelfImprove.js');
const { PORTOS_APP_ID } = await import('../../lib/appIdentity.js');

const goodDiagnosis = {
  verdict: 'pipeline',
  confidence: 0.9,
  area: 'prompt',
  title: 'Make remediation return applicable transition edits',
  problem: 'The remediation stage reports findings but repeatedly produces no applicable patch.',
  evidence: ['round 2 remediation.changed=false while evaluationFindingCount=3'],
  proposedChange: 'Tighten the remediation prompt output contract around existing transition ids.',
  risks: 'Preserve graph membership and reject unknown ids.',
};

const makeRun = (overrides = {}) => ({
  selfImproveEnabled: true,
  cancelRequested: false,
  currentStep: 'playthrough-review',
  round: 2,
  maxRounds: 3,
  maxPaths: 64,
  route: { providerId: 'writer', model: 'large', effort: 'high' },
  rounds: [{
    round: 1,
    changed: false,
    changes: [],
    before: { graphErrors: 1, outlineErrors: 0 },
    after: { graphErrors: 1, outlineErrors: 0 },
    evaluation: {
      summary: 'PRIVATE STORY SUMMARY',
      findings: [{ problem: 'PRIVATE STORY FINDING' }],
    },
    diagnostics: {
      passed: false,
      findings: [{ problem: 'PRIVATE DIAGNOSTIC FINDING' }],
    },
    deterministic: {
      passed: true,
      complete: true,
      stats: { variationCount: 3, transitionCount: 6, visitedTransitionCount: 6 },
    },
    review: {
      passed: false,
      qualityScore: 6.5,
      summary: 'PRIVATE REVIEW SUMMARY',
      findings: [{ severity: 'medium', category: 'choice', problem: 'PRIVATE REVIEW FINDING' }],
    },
    passed: false,
  }],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  getDomainBudgetStatus.mockResolvedValue({ withinBudget: true });
  runStagedLLM.mockResolvedValue({ content: { ...goodDiagnosis } });
});

describe('FableLoom editorial self-improvement', () => {
  it('diagnoses only opted-in paused or failed runs', () => {
    const run = makeRun();
    expect(shouldDiagnoseFableLoomEditorial(run, 'paused')).toBe(true);
    expect(shouldDiagnoseFableLoomEditorial(run, 'failed')).toBe(true);
    expect(shouldDiagnoseFableLoomEditorial(run, 'completed')).toBe(false);
    expect(shouldDiagnoseFableLoomEditorial(run, 'canceled')).toBe(false);
    expect(shouldDiagnoseFableLoomEditorial({ ...run, selfImproveEnabled: false }, 'paused')).toBe(false);
  });

  it('reduces the run to counters and sanitized status tokens without story data', () => {
    const telemetry = buildFableLoomEditorialTelemetry(makeRun(), {
      outcome: 'paused',
      reason: 'round limit with private words',
      sourceStep: 'playthrough review',
      errorCode: '<repo-root>/project',
    });
    const encoded = JSON.stringify(telemetry);

    expect(telemetry).toMatchObject({
      outcome: 'paused',
      reason: 'none',
      sourceStep: 'unknown',
      errorCode: 'none',
      rounds: [{
        remediation: { changed: false, evaluationFindingCount: 1 },
        playthrough: {
          diagnosticFindingCount: 1,
          reviewFindingCount: 1,
          findingCategories: { choice: 1 },
        },
      }],
    });
    expect(encoded).not.toContain('PRIVATE');
  });

  it('queues one approval-gated PortOS task for a confident automation verdict', async () => {
    const run = makeRun();
    const summary = await runFableLoomEditorialSelfImprove(run, {
      outcome: 'paused', reason: 'plateau', sourceStep: 'playthrough-review',
    });

    expect(runStagedLLM).toHaveBeenCalledWith(
      'fableloom-editorial-self-improve',
      expect.objectContaining({
        outcome: 'paused', outcomeReason: 'plateau', currentStep: 'playthrough-review',
        telemetryJson: expect.any(String),
      }),
      {
        providerDefault: 'writer',
        returnsJson: true, source: 'fableloom-editorial-self-improve',
      },
    );
    expect(recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1 });
    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({
      app: PORTOS_APP_ID,
      approvalRequired: true,
      useWorktree: true,
      openPR: true,
      prCompletion: 'review-then-merge',
    }), 'internal');
    expect(summary).toEqual({
      verdict: 'pipeline', area: 'prompt', title: goodDiagnosis.title,
      taskId: 'sys-example', filed: true, duplicate: false,
    });
  });

  it('skips spent budgets and low-confidence or content diagnoses', async () => {
    getDomainBudgetStatus.mockResolvedValueOnce({ withinBudget: false });
    await expect(runFableLoomEditorialSelfImprove(makeRun(), { outcome: 'paused' })).resolves.toBeNull();
    expect(runStagedLLM).not.toHaveBeenCalled();

    runStagedLLM.mockResolvedValueOnce({
      content: { ...goodDiagnosis, confidence: FABLELOOM_EDITORIAL_SELF_IMPROVE_MIN_CONFIDENCE - 0.01 },
    });
    await expect(runFableLoomEditorialSelfImprove(makeRun(), { outcome: 'failed' })).resolves.toBeNull();

    runStagedLLM.mockResolvedValueOnce({ content: { ...goodDiagnosis, verdict: 'content' } });
    await expect(runFableLoomEditorialSelfImprove(makeRun(), { outcome: 'paused' })).resolves.toBeNull();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not file new work when cancellation arrives during diagnosis', async () => {
    const run = makeRun();
    runStagedLLM.mockImplementationOnce(async () => {
      run.cancelRequested = true;
      return { content: { ...goodDiagnosis } };
    });

    await expect(runFableLoomEditorialSelfImprove(run, { outcome: 'paused' })).resolves.toBeNull();
    expect(recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1 });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('keeps the task headline stable per defect and excludes run identity', () => {
    const telemetry = buildFableLoomEditorialTelemetry(makeRun(), {
      outcome: 'paused', reason: 'plateau', sourceStep: 'playthrough-review',
    });
    const task = buildFableLoomEditorialSelfImproveTask({ diagnosis: goodDiagnosis, telemetry });

    expect(task.description).not.toContain('\n');
    expect(task.description).toContain('prompt/make-remediation-return-applicable-transition');
    expect(task.context).not.toContain('loom-');
    expect(task.context).not.toContain('episode-');
    expect(task.context).toContain(goodDiagnosis.proposedChange);
  });
});
