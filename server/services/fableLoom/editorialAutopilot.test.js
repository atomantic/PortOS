import { beforeEach, describe, expect, it, vi } from 'vitest';

const getLoomMock = vi.hoisted(() => vi.fn(async (id) => ({ id })));
const remediateMock = vi.hoisted(() => vi.fn());
const playtestMock = vi.hoisted(() => vi.fn());

vi.mock('./records.js', () => ({ getLoom: getLoomMock }));
vi.mock('./editorial.js', () => ({
  evaluateAndRemediateFableLoom: remediateMock,
  reviewFableLoomPlaythroughs: playtestMock,
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
  remediateMock.mockReset();
  playtestMock.mockReset();
});

describe('FableLoom editorial autopilot', () => {
  it('completes after one editor/reviewer round when every gate passes', async () => {
    remediateMock.mockResolvedValueOnce(remediation(true));
    playtestMock.mockResolvedValueOnce(playtest({ passed: true }));

    const started = await startFableLoomEditorialAutopilot('loom-example', {
      maxRounds: 3, providerId: 'writer', model: 'large', effort: 'high',
    });
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({ status: 'completed', round: 1, maxRounds: 3 });
    expect(finished.rounds).toHaveLength(1);
    expect(remediateMock).toHaveBeenCalledWith('loom-example', {
      providerId: 'writer', model: 'large', effort: 'high', guidance: '',
    });
    expect(playtestMock).toHaveBeenCalledWith('loom-example', {
      providerId: 'writer', model: 'large', effort: 'high', aiReview: true,
    });
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

    const started = await startFableLoomEditorialAutopilot('loom-example', { maxRounds: 1 });
    const finished = await waitForTerminal(started.id);

    expect(finished).toMatchObject({ status: 'paused', pauseReason: 'round-limit', round: 1 });
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
