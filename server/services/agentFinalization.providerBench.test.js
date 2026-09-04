/**
 * Tests for the provider-sidelining finalizeAgent does on a failed run.
 *
 * The bug this covers: an `agy` (Antigravity) TUI agent that hits the
 * "We're finishing verifying your account eligibility" banner fails in ~3s —
 * correctly — but nothing marked the provider unavailable, so the very next
 * dequeued task resolved onto the same provider and died on the same banner.
 * A run of queued tasks would all fail in sequence. The eligibility signal now
 * carries `benchMs`, and finalizeAgent honors it via the generic
 * `markProviderUnavailable` marker so `resolveAgentProviderAndModel` routes the
 * retry to a fallback until the deadline auto-recovers the provider.
 *
 * Every case here builds its `errorAnalysis` by running a real transcript through
 * `detectImmediateFallbackSignal` / `analyzeAgentFailure` rather than hand-stamping
 * `{ category, origin }`. A hand-stamped origin is how a real regression shipped
 * green (#3635): the detector was rewritten so Claude Code's genuine usage-limit
 * banners classified as `output-scan`, the gate stopped benching, and this suite
 * never noticed because it had asserted against a shape it had written itself.
 */

// The goal-fidelity gate (#5994) reaches a local model at completion. Pinned OFF
// here so these tests exercise the path they are about without depending on the
// developer's own reviewer settings — and so a machine that HAS a local reviewer
// configured never has its suite dispatch a real review request.
vi.mock('./codeReview.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGoalFidelityConfig: vi.fn(async () => null),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn(async () => ({ stdout: 'main\n', stderr: '', exitCode: 0 })),
}));
vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn(async () => ({ status: 'found', number: 1, url: 'u' })),
  ensureForgeReachable: vi.fn(async () => ({ ok: true, status: 'ok' })),
}));
vi.mock('./gitlab.js', () => ({ findMergeRequestForBranch: vi.fn() }));
vi.mock('./git.js', () => ({ resolveForgeForRepo: vi.fn(async () => ({ cli: 'gh' })) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => null),
  getAgentRecord: vi.fn(async () => null),
  updateAgent: vi.fn(async () => null),
  completeAgent: vi.fn(async () => null),
}));
vi.mock('./cos.js', () => ({ updateTask: vi.fn(async () => ({})) }));

const getActiveProviderMock = vi.fn(async () => null);
vi.mock('./providers.js', () => ({ getActiveProvider: (...a) => getActiveProviderMock(...a) }));

const markProviderUnavailableMock = vi.fn(async () => null);
const markProviderUsageLimitMock = vi.fn(async () => null);
vi.mock('./providerStatus.js', () => ({
  markProviderUsageLimit: (...a) => markProviderUsageLimitMock(...a),
  markProviderRateLimited: vi.fn(async () => null),
  markProviderUnavailable: (...a) => markProviderUnavailableMock(...a),
}));

vi.mock('./executionLanes.js', () => ({ release: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({ completeExecution: vi.fn(), errorExecution: vi.fn() }));
// Partial mock: the two finalize-path helpers are stubbed, but `analyzeAgentFailure`
// passes through to the REAL detector so the banner tests below exercise what ships.
vi.mock('./agentErrorAnalysis.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveFailedTaskUpdate: vi.fn(async () => ({ status: 'pending', metadata: {} })),
  resolveTypeFailureSignal: vi.fn(() => ({ record: 'skip' })),
}));
vi.mock('../lib/gitCommitProbe.js', () => ({
  committedDuringRun: vi.fn(async () => false),
}));
vi.mock('./agentRunTracking.js', () => ({
  createAgentRun: vi.fn(),
  completeAgentRun: vi.fn(async () => null),
}));
vi.mock('./taskTypeHooks.js', () => ({
  canRunTaskOutputHookWithoutPayload: vi.fn(() => false),
  isProgrammaticIoTaskType: vi.fn(() => false),
  resolveTaskHookType: vi.fn(() => null),
  declaresNoCommitCriterion: vi.fn(() => false),
  getTaskOutputHook: vi.fn(async () => null),
  getTaskOutputPayloadPredicate: vi.fn(async () => null),
}));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractSimplifySummaries: vi.fn(() => null) }));

import { finalizeAgent } from './agentFinalization.js';
// The real detector and the real cooldown table supply the analysis shape and
// the window, so the assertions below can't drift from what actually ships.
import { detectImmediateFallbackSignal } from '../lib/aiToolkit/errorDetection.js';
import { analyzeAgentFailure } from './agentErrorAnalysis.js';
import { COOLDOWN_MS_BY_CATEGORY } from '../lib/providerCooldown.js';

const failedRun = (errorAnalysis, providerId = 'antigravity-tui') => finalizeAgent({
  agentId: 'agent-1',
  task: { id: 'task-1', taskType: 'internal', description: 'do a thing', metadata: {} },
  runId: 'run-1',
  providerId,
  success: false,
  exitCode: 1,
  duration: 3000,
  outputBuffer: '',
  errorAnalysis,
  terminatedByUser: false,
  isTruthyMetaFn: () => false,
  error: errorAnalysis?.message,
  completionReason: 'fallback-signal',
  workspacePath: '/w',
  prExpected: false,
});

beforeEach(() => vi.clearAllMocks());

describe('finalizeAgent provider sidelining', () => {
  it('benches the provider on the agy eligibility signal', async () => {
    const analysis = detectImmediateFallbackSignal(
      "We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly."
    );
    await failedRun(analysis);

    expect(markProviderUnavailableMock).toHaveBeenCalledWith('antigravity-tui', {
      reason: 'auth-error',
      message: analysis.message,
      waitTimeMs: COOLDOWN_MS_BY_CATEGORY['auth-error'],
    });
    // Before this fix only usage-limit/rate-limit benched, so an auth-error left
    // the provider healthy and the next dequeued task died on the same banner.
    expect(markProviderUsageLimitMock).not.toHaveBeenCalled();
  });

  // #3631, the broad half of the same gate: `detectImmediateFallbackSignal` used to
  // stamp `origin: 'provider'` unconditionally, so an agent that merely PRINTED one
  // of these banners benched a healthy provider for every subsequently dequeued
  // task. These drive the REAL detector — hand-stamping `origin` is exactly how the
  // sibling regression shipped green.
  it.each([
    ['prose quoting the banner', "The known failure mode is: We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly. — see errorDetection.js"],
    ['a grep hit over a prior run\'s transcript', "data/cos/agents/agent-1/output.txt:412:  ⎿  We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly."],
    // The extra-usage status line has no loose alternative — quoting it inline
    // does not even register as a signal, so there is nothing to bench on.
    ['a quoted extra-usage status line', 'the tail showed "Now using extra usage" in a prior run'],
  ])('does not bench when the agent merely printed the banner (%s)', async (_label, transcript) => {
    const analysis = detectImmediateFallbackSignal(transcript);
    expect(analysis?.origin ?? null).not.toBe('provider');
    await failedRun(analysis);
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
    expect(markProviderUsageLimitMock).not.toHaveBeenCalled();
  });

  it('still benches when the eligibility banner arrives as the run\'s own terminal output', async () => {
    const analysis = detectImmediateFallbackSignal(
      "starting the task…\n  ⎿  We're finishing verifying your account eligibility.\n This usually takes a moment. Please try again shortly.\r\n"
    );
    expect(analysis).toMatchObject({ category: 'auth-error', origin: 'provider' });
    await failedRun(analysis);
    expect(markProviderUnavailableMock).toHaveBeenCalledWith('antigravity-tui', expect.objectContaining({
      reason: 'auth-error',
    }));
  });

  it('still benches on the real extra-usage status line', async () => {
    const analysis = detectImmediateFallbackSignal('Now using extra usage\n');
    expect(analysis).toMatchObject({ category: 'usage-limit', origin: 'provider' });
    await failedRun(analysis, 'claude-code-tui');
    expect(markProviderUsageLimitMock).toHaveBeenCalledWith('claude-code-tui', expect.objectContaining({
      category: 'usage-limit',
    }));
  });

  // The provenance gate is only as good as what `analyzeAgentFailure` promotes to
  // `origin: 'provider'`. The case above hand-stamps that origin, which is exactly
  // how a real regression shipped green: Claude Code's actual banners classified as
  // `origin: 'output-scan'`, so a genuine 5-hour window never benched the provider
  // and every subsequent dequeue re-picked it. These drive the REAL detector.
  it.each([
    ['Claude usage limit reached. Your limit will reset at 5pm.'],
    ['5-hour limit reached · resets 3am'],
  ])('benches the provider on the real usage-limit banner %#', async (banner) => {
    const analysis = analyzeAgentFailure(
      `${banner}\nthe transcript tail continues past the banner.`,
      { id: 'task-1' },
      'claude',
      {}
    );
    expect(analysis).toMatchObject({ category: 'usage-limit', origin: 'provider', requiresFallback: true });
    await failedRun(analysis, 'claude-code-tui');
    expect(markProviderUsageLimitMock).toHaveBeenCalledWith('claude-code-tui', expect.objectContaining({
      category: 'usage-limit',
    }));
  });

  // The other half of the same gate: a generic limit phrasing a task's own output
  // can print must stay `output-scan` and leave the provider healthy.
  it('does not bench on a generic limit phrasing from the agent transcript', async () => {
    const analysis = analyzeAgentFailure(
      'Error: the daily limit for widgets was exceeded in our test fixture.\nmore output.',
      { id: 'task-1' },
      'claude',
      {}
    );
    expect(analysis).toMatchObject({ category: 'usage-limit', origin: 'output-scan' });
    await failedRun(analysis, 'claude-code-tui');
    expect(markProviderUsageLimitMock).not.toHaveBeenCalled();
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
  });

  it('leaves the usage-limit marker owning its own cooldown', async () => {
    const analysis = analyzeAgentFailure(
      'hit your usage limit · resets 6am\nthe transcript tail continues past the banner.',
      { id: 'task-1' },
      'claude',
      {}
    );
    expect(analysis).toMatchObject({ category: 'usage-limit', origin: 'provider', requiresFallback: true });
    await failedRun(analysis, 'claude-code-tui');

    // markUsageLimit parses its own window out of the provider's message, so it
    // keeps the dedicated marker rather than the flat per-category cooldown.
    expect(markProviderUsageLimitMock).toHaveBeenCalledWith('claude-code-tui', expect.objectContaining({
      category: 'usage-limit',
    }));
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
  });

  // The provenance gate (#2642): a repainted TUI transcript is a whole session
  // of text the agent itself wrote, so a loose keyword match must never bench a
  // healthy provider — only structured provider chrome does.
  // `rate-limit` and `usage-limit` are the load-bearing cases: their patterns have
  // loose alternatives (a bare "rate limit" / "quota exceeded" a failing test in
  // the agent's own workspace can print), and this gate used to key on the
  // category alone — so an agent's transcript could bench a healthy provider.
  // Each transcript below is text a task's OWN run can print.
  it.each([
    ['auth-error', 'Error: unauthorized while writing the snapshot fixture in the widget suite.\nmore output follows.'],
    ['rate-limit', 'Error: the fixture asserted a rate limit banner renders for the widget list.\nmore output follows.'],
    ['usage-limit', 'Error: quota exceeded for the fixture bucket while uploading the report artifact.\nmore output.'],
  ])(
    'does not bench an output-scan %s that merely looks provider-ish',
    async (category, transcript) => {
      const analysis = analyzeAgentFailure(transcript, { id: 'task-1' }, 'claude', {});
      expect(analysis).toMatchObject({ category, origin: 'output-scan' });
      await failedRun(analysis);
      expect(markProviderUnavailableMock).not.toHaveBeenCalled();
      expect(markProviderUsageLimitMock).not.toHaveBeenCalled();
      // No marker fired, so the lazy active-provider lookup must stay unread.
      expect(getActiveProviderMock).not.toHaveBeenCalled();
    }
  );

  it('does not bench an ordinary agent-work failure', async () => {
    const analysis = analyzeAgentFailure(
      'The suite reported a test failure in the widget list module. Review the assertions and retry.',
      { id: 'task-1' },
      'claude',
      {}
    );
    expect(analysis).toMatchObject({ category: 'test-failure', origin: 'output-scan' });
    await failedRun(analysis);
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
    expect(markProviderUsageLimitMock).not.toHaveBeenCalled();
  });

  // A bad model id is REQUEST-specific: benching would take the provider's other
  // working models offline over one wrong id. Driven through the real detector so
  // the `origin: 'provider'` half of the case is the one the classifier assigns.
  it('does not bench a provider-origin model-not-found', async () => {
    const analysis = analyzeAgentFailure(
      'API Error: 404 Not Found model: example-model-v1\nthe run stopped here without retrying.',
      { id: 'task-1' },
      'claude',
      {}
    );
    expect(analysis).toMatchObject({ category: 'model-not-found', origin: 'provider' });
    await failedRun(analysis);
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
  });

  it('does not bench when the user terminated the run', async () => {
    const analysis = detectImmediateFallbackSignal(
      "We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly."
    );
    await finalizeAgent({
      agentId: 'agent-2',
      task: { id: 'task-2', taskType: 'internal', description: 'x', metadata: {} },
      runId: 'run-2',
      providerId: 'antigravity-tui',
      success: false,
      exitCode: 130,
      duration: 10,
      outputBuffer: '',
      errorAnalysis: analysis,
      terminatedByUser: true,
      isTruthyMetaFn: () => false,
      completionReason: 'terminated',
      workspacePath: '/w',
      prExpected: false,
    });
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
  });
});

describe('finalizeAgent — Creative Director scratch cleanup (#4650)', () => {
  it('removes the per-agent scratch cwd when the CD run finishes', async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const { creativeDirectorScratchCwd } = await import('../lib/spawnCwd.js');
    const dir = creativeDirectorScratchCwd('agent-cd-fin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leftover.txt'), 'x');
    await finalizeAgent({
      agentId: 'agent-cd-fin',
      task: {
        id: 'task-cd',
        taskType: 'internal',
        description: 'CD plan',
        metadata: { creativeDirector: { projectId: 'p', kind: 'plan' }, useWorktree: false },
      },
      runId: 'run-cd',
      providerId: 'codex',
      success: true,
      exitCode: 0,
      duration: 1000,
      outputBuffer: '',
      terminatedByUser: false,
      isTruthyMetaFn: () => false,
      workspacePath: dir,
      prExpected: false,
    });
    expect(existsSync(dir)).toBe(false);
  });
});
