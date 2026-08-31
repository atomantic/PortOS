import { beforeEach, describe, expect, it, vi } from 'vitest';

const getLoomMock = vi.hoisted(() => vi.fn(async (id) => ({ id })));
const mutateLoomMock = vi.hoisted(() => vi.fn(async (id, mutator) => mutator({
  id,
  productionStatus: {
    editorialApprovedAt: null,
    editorialApprovalSource: null,
    deliveryApprovedAt: null,
  },
})));
const remediateMock = vi.hoisted(() => vi.fn());
const playtestMock = vi.hoisted(() => vi.fn());
const selfImproveMock = vi.hoisted(() => vi.fn(async () => ({
  verdict: 'pipeline', area: 'prompt', title: 'Tighten the remediation contract',
  taskId: 'sys-example', filed: true, duplicate: false,
})));

vi.mock('./records.js', () => ({ getLoom: getLoomMock, mutateLoom: mutateLoomMock }));
vi.mock('./editorial.js', () => ({
  evaluateAndRemediateFableLoom: remediateMock,
  reviewFableLoomPlaythroughs: playtestMock,
}));
vi.mock('./editorialSelfImprove.js', () => ({
  shouldDiagnoseFableLoomEditorial: (run, outcome) => (
    run?.selfImproveEnabled === true && ['paused', 'failed'].includes(outcome)
  ),
  runFableLoomEditorialSelfImprove: (...args) => selfImproveMock(...args),
}));

const {
  _resetFableLoomEditorialAutopilots,
  cancelFableLoomEditorialAutopilot,
  getFableLoomEditorialAutopilot,
  publicFableLoomEditorialAutopilot,
  startFableLoomEditorialAutopilot,
} = await import('./editorialAutopilot.js');

const remediation = (changed = true) => ({
  changed,
  changes: changed ? ['Repaired one beat.'] : [],
  before: { outlineErrors: changed ? 1 : 0 },
  after: { outlineErrors: 0 },
  evaluation: { summary: 'Focused editorial pass.', strengths: [], findings: [] },
});

const playtest = ({ passed, findings = [], diagnosticFindings = [] }) => ({
  passed,
  deterministic: {
    passed: true,
    complete: true,
    stats: { variationCount: 2, visitedTransitionCount: 4, transitionCount: 4 },
    episodes: [{ episodeId: 'episode-example', issues: [] }],
  },
  diagnostics: {
    passed: diagnosticFindings.length === 0,
    stats: { outlineErrors: diagnosticFindings.length },
    findings: diagnosticFindings,
  },
  review: {
    passed,
    qualityScore: passed ? 8.5 : 7.2,
    summary: passed ? 'Every route holds.' : 'One consequence still disappears.',
    strengths: [],
    findings,
  },
});

const waitForTerminal = async (runId) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = getFableLoomEditorialAutopilot(runId);
    if (['completed', 'paused', 'failed', 'canceled'].includes(run?.status)) return run;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Editorial autopilot did not settle');
};

beforeEach(() => {
  _resetFableLoomEditorialAutopilots();
  getLoomMock.mockClear().mockImplementation(async (id) => ({ id }));
  mutateLoomMock.mockClear();
  remediateMock.mockReset();
  playtestMock.mockReset();
  selfImproveMock.mockClear();
});

describe('FableLoom editorial autopilot', () => {
  it('completes after one editor/reviewer round when every gate passes', async () => {
    remediateMock.mockResolvedValueOnce(remediation(true));
    playtestMock.mockResolvedValueOnce(playtest({ passed: true }));

    const started = await startFableLoomEditorialAutopilot('loom-example', {
      maxRounds: 3, providerId: 'writer', model: 'large', effort: 'high',
    });
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({
      status: 'completed', round: 1, maxRounds: 3, stepIndex: 2, stepCount: 6,
    });
    expect(finished.rounds).toHaveLength(1);
    expect(remediateMock).toHaveBeenCalledWith('loom-example', {
      providerId: 'writer', model: 'large', effort: 'high', guidance: '',
    });
    expect(playtestMock).toHaveBeenCalledWith('loom-example', {
      providerId: 'writer', model: 'large', effort: 'high', aiReview: true,
    });
    expect(selfImproveMock).not.toHaveBeenCalled();
    expect(mutateLoomMock).toHaveBeenCalledWith('loom-example', expect.any(Function));
    expect(await mutateLoomMock.mock.calls[0][1]({ productionStatus: {} })).toMatchObject({
      productionStatus: {
        editorialApprovedAt: expect.any(String),
        editorialApprovalSource: 'autopilot',
        deliveryApprovedAt: null,
      },
    });
  });

  it('corrects a rejected graph patch and continues the same editorial step', async () => {
    const rejectedPatch = Object.assign(new Error('The model returned an invalid transition target'), {
      code: 'AI_RESPONSE_INVALID',
    });
    remediateMock
      .mockRejectedValueOnce(rejectedPatch)
      .mockResolvedValueOnce(remediation(true));
    playtestMock.mockResolvedValueOnce(playtest({ passed: true }));

    const started = await startFableLoomEditorialAutopilot('loom-example', { maxRounds: 3 });
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({
      status: 'completed', round: 1, stepIndex: 2, responseCorrections: 1, invalidResponses: 1,
    });
    expect(remediateMock).toHaveBeenCalledTimes(2);
    expect(remediateMock.mock.calls[1][1].guidance).toContain('Validator feedback');
    expect(remediateMock.mock.calls[1][1].guidance).toContain(rejectedPatch.message);
    expect(playtestMock).toHaveBeenCalledTimes(1);
  });

  it('feeds the newest validator rejection into each bounded correction attempt', async () => {
    const first = Object.assign(new Error('Unknown transition target in the opening scene'), {
      code: 'AI_RESPONSE_INVALID',
    });
    const second = Object.assign(new Error('Replacement ending still points at a removed scene'), {
      code: 'AI_RESPONSE_INVALID',
    });
    remediateMock
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second)
      .mockResolvedValueOnce(remediation(true));
    playtestMock.mockResolvedValueOnce(playtest({ passed: true }));

    const started = await startFableLoomEditorialAutopilot('loom-example', { maxRounds: 3 });
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({
      status: 'completed', responseCorrections: 2, invalidResponses: 2,
    });
    expect(remediateMock.mock.calls[2][1].guidance).toContain(second.message);
    expect(remediateMock.mock.calls[2][1].guidance).not.toContain(first.message);
  });

  it('fails with useful remediation after exhausting invalid-response correction attempts', async () => {
    remediateMock.mockRejectedValue(Object.assign(
      new Error('The model returned an invalid transition target for a private record id'),
      { code: 'AI_RESPONSE_INVALID' },
    ));

    const started = await startFableLoomEditorialAutopilot('loom-example', { maxRounds: 3 });
    const finished = await waitForTerminal(started.id);

    expect(remediateMock).toHaveBeenCalledTimes(3);
    expect(finished).toMatchObject({
      status: 'failed', round: 1, stepIndex: 1, responseCorrections: 2, invalidResponses: 3,
    });
    expect(finished.error).toContain('graph-safe editor patch after 3 attempts');
    expect(finished.error).not.toContain('private record id');
    expect(playtestMock).not.toHaveBeenCalled();
  });

  it('pauses on a plateau after the same finding survives a no-change pass', async () => {
    const finding = {
      severity: 'medium', category: 'coherence', episodeId: 'episode-example',
      nodeId: 'ending', pathId: 'path-1', problem: 'The cost disappears after convergence.',
      suggestion: 'Carry the chosen sacrifice into the shared ending.',
    };
    remediateMock
      .mockResolvedValueOnce(remediation(true))
      .mockResolvedValueOnce(remediation(false));
    playtestMock.mockResolvedValue(playtest({ passed: false, findings: [finding] }));

    const started = await startFableLoomEditorialAutopilot('loom-example', { maxRounds: 4 });
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({ status: 'paused', pauseReason: 'plateau', round: 2 });
    expect(finished.rounds).toHaveLength(2);
    expect(remediateMock.mock.calls[1][1].guidance).toContain('Carry the chosen sacrifice');
  });

  it('honors the hard round limit when review findings remain', async () => {
    remediateMock.mockResolvedValueOnce(remediation(true));
    playtestMock.mockResolvedValueOnce(playtest({
      passed: false,
      findings: [{ severity: 'low', category: 'pacing', problem: 'The second route rushes its turn.' }],
    }));

    const started = await startFableLoomEditorialAutopilot('loom-example', {
      maxRounds: 1,
      selfImprove: true,
    });
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({
      status: 'paused',
      pauseReason: 'round-limit',
      round: 1,
      selfImproveEnabled: true,
      selfImprove: { verdict: 'pipeline', taskId: 'sys-example', filed: true },
    });
    expect(selfImproveMock).toHaveBeenCalledWith(expect.objectContaining({ id: started.id }), {
      outcome: 'paused',
      reason: 'round-limit',
      sourceStep: 'playthrough-review',
      errorCode: null,
    });
  });

  it('keeps non-correctable provider failures terminal while best-effort self-improvement diagnoses the failed step', async () => {
    const providerError = Object.assign(new Error('Provider returned an unusable patch'), {
      code: 'PROVIDER_UNAVAILABLE',
    });
    remediateMock.mockRejectedValueOnce(providerError);

    const started = await startFableLoomEditorialAutopilot('loom-example', { selfImprove: true });
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({
      status: 'failed',
      error: providerError.message,
      selfImprove: { taskId: 'sys-example' },
    });
    expect(selfImproveMock).toHaveBeenCalledWith(expect.any(Object), {
      outcome: 'failed',
      reason: 'run-error',
      sourceStep: 'evaluate-remediate',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('preserves a known failure when cancellation lands during diagnosis', async () => {
    let finishDiagnosis;
    selfImproveMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishDiagnosis = resolve;
    }));
    const providerError = Object.assign(new Error('Provider returned an unusable patch'), {
      code: 'PROVIDER_UNAVAILABLE',
    });
    remediateMock.mockRejectedValueOnce(providerError);

    const started = await startFableLoomEditorialAutopilot('loom-example', { selfImprove: true });
    await vi.waitFor(() => expect(selfImproveMock).toHaveBeenCalledTimes(1));
    expect(cancelFableLoomEditorialAutopilot(started.id).status).toBe('canceling');
    finishDiagnosis(null);
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({
      status: 'canceled',
      error: providerError.message,
      message: providerError.message,
      selfImprove: null,
    });
  });

  it('preserves a known pause when cancellation lands during diagnosis', async () => {
    let finishDiagnosis;
    selfImproveMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishDiagnosis = resolve;
    }));
    remediateMock.mockResolvedValueOnce(remediation(true));
    playtestMock.mockResolvedValueOnce(playtest({
      passed: false,
      findings: [{ severity: 'low', category: 'pacing', problem: 'One route rushes its turn.' }],
    }));

    const started = await startFableLoomEditorialAutopilot('loom-example', {
      maxRounds: 1,
      selfImprove: true,
    });
    await vi.waitFor(() => expect(selfImproveMock).toHaveBeenCalledTimes(1));
    expect(cancelFableLoomEditorialAutopilot(started.id).status).toBe('canceling');
    finishDiagnosis(null);
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({
      status: 'canceled',
      pauseReason: 'round-limit',
      message: 'Editorial autopilot reached its 1-round limit with review findings still open.',
      selfImprove: null,
    });
  });

  it('keeps diagnostics-only blockers actionable in the residual findings', async () => {
    const diagnosticFinding = {
      severity: 'high',
      category: 'structure',
      episodeId: 'episode-example',
      nodeId: null,
      pathId: null,
      problem: 'The beat outline must be revalidated.',
      suggestion: 'Repair and revalidate the complete episode beat outline.',
    };
    remediateMock.mockResolvedValueOnce(remediation(false));
    playtestMock.mockResolvedValueOnce(playtest({
      passed: false,
      diagnosticFindings: [diagnosticFinding],
    }));

    const started = await startFableLoomEditorialAutopilot('loom-example', { maxRounds: 1 });
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({
      status: 'paused',
      pauseReason: 'round-limit',
      residualFindings: [expect.objectContaining({ problem: diagnosticFinding.problem })],
    });
    expect(finished.rounds[0].diagnostics.findings).toHaveLength(1);
  });

  it('reattaches duplicate starts and cooperatively cancels after the active AI step', async () => {
    let finishRemediation;
    remediateMock.mockImplementationOnce(() => new Promise((resolve) => { finishRemediation = resolve; }));
    const started = await startFableLoomEditorialAutopilot('loom-example', { maxRounds: 3 });
    const duplicate = await startFableLoomEditorialAutopilot('loom-example', { maxRounds: 6 });

    expect(duplicate).toMatchObject({ id: started.id, alreadyRunning: true, maxRounds: 3 });
    expect(cancelFableLoomEditorialAutopilot(started.id).status).toBe('canceling');
    finishRemediation(remediation(true));
    const finished = await waitForTerminal(started.id);

    expect(finished.status).toBe('canceled');
    expect(playtestMock).not.toHaveBeenCalled();
    expect(publicFableLoomEditorialAutopilot(finished)).not.toHaveProperty('previousFindingSignature');
  });
});
