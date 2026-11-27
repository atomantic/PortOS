/**
 * Session-controller teardown contract (#8021).
 *
 * The spawner's own suite (`../agent/agentTuiSpawning.test.js`) drives every public
 * spawn/completion path through a live PTY double, and that stays the primary
 * boundary. What it CANNOT reach is the one invariant the extraction changed:
 * the controller now owns its two intervals and its sentinel watcher in its own
 * closure, instead of parking them on the `activeAgents` record and reading them
 * back at teardown.
 *
 * That old shape had a hole with no seam to aim a test at — a run whose record
 * was absent (or not yet written, since the watcher was armed BEFORE the map
 * write) tore down nothing, leaving two live intervals and an fs watcher holding
 * the closure and the PTY handle for the life of the process. Driving the
 * controller with fakes is the only way to state "teardown is complete even with
 * no run record", and it is also what proves the seams are real: every
 * collaborator below is a plain object, so nothing here loads the spawn cluster.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STALL_NUDGE_IDLE_MS, STALL_NUDGE_TEXT } from '../../lib/tuiHandshake.js';

vi.mock('../cos/cosEvents.js', () => ({ emitLog: vi.fn() }));

import { emitLog } from '../cos/cosEvents.js';

const { createTuiSessionController } = await import('./sessionController.js');

const TASK = { id: 'task-8021', description: 'extract the session controller' };
const TUI_CONFIG = {
  command: 'codex',
  spawnCommand: '/usr/local/bin/codex',
  spawnArgs: [],
  commandLine: 'codex',
  promptDelayMs: 2500,
};

/**
 * Build a controller whose every seam is a spy, plus the handles a test needs to
 * assert on. `sentinelSummary` non-null makes the run look like it wrote a real
 * `.agent-done`, which is what opens the merge-gate branch.
 */
function makeController({
  mergeGateIsOwed = false,
  sentinelSummary = null,
  prProbe = null,
  provider = { id: 'codex-tui', name: 'Codex' },
  tuiConfig = TUI_CONFIG,
  prompt = 'do the work',
  securityScanGrant = null,
  sentinelRead = async () => sentinelSummary ?? '',
  spoolerOverrides = {},
} = {}) {
  // A DISTINCT closer per arm: the merge-gate case below has to tell the
  // re-armed watcher apart from the one it replaced, which one shared spy
  // cannot do.
  const closers = [];
  const watch = vi.fn(() => {
    const close = vi.fn();
    closers.push(close);
    return close;
  });
  const seams = {
    closers,
    watch,
    updateAgent: vi.fn().mockResolvedValue(undefined),
    releaseRunRecord: vi.fn(),
    runCompletionCleanup: vi.fn().mockResolvedValue({}),
    finalizeAgent: vi.fn().mockResolvedValue({ success: true }),
    remove: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    paste: vi.fn(() => ({ /* a live submit-Enter interval handle */ })),
    kill: vi.fn(),
    markUnsettled: vi.fn(),
    shouldAbandonRun: vi.fn(() => false),
    probeMergeGatePr: vi.fn().mockResolvedValue(prProbe),
    resolveErrorAnalysis: vi.fn(async ({ immediateFallbackAnalysis }) => immediateFallbackAnalysis),
  };
  const controller = createTuiSessionController({
    agentId: 'agent-8021',
    task: TASK,
    runId: 'run-1',
    model: 'gpt-5-codex',
    provider,
    securityScanGrant,
    prompt,
    tuiConfig,
    cwd: '/tmp/workspace',
    rawFile: '/tmp/workspace/raw.txt',
    launchShape: 'direct',
    prOwnership: { prOpenedBy: 'agent-inline', prClaimExpected: true, taskOpenPR: true },
    mergeGateIsOwed,
    spooler: {
      appendLine: vi.fn(),
      pushRaw: vi.fn(),
      flushRaw: vi.fn().mockResolvedValue(undefined),
      drainLines: vi.fn().mockResolvedValue(undefined),
      drainRaw: vi.fn().mockResolvedValue(undefined),
      getOutputBuffer: () => '',
      ...spoolerOverrides,
    },
    session: {
      write: seams.write,
      paste: (_sessionId, text, options) => seams.paste(text, options),
      isAlive: () => true,
      kill: seams.kill,
      hasLiveChild: async () => true,
    },
    persistence: {
      markUnsettled: seams.markUnsettled,
      updateAgent: seams.updateAgent,
      appendRunEvent: vi.fn(),
      // THE CASE UNDER TEST: no active-run entry for this agent.
      readRunRecord: () => undefined,
      releaseRunRecord: seams.releaseRunRecord,
    },
    sentinel: {
      path: '/tmp/workspace/.agent-done-agent-8021',
      exists: () => sentinelSummary !== null,
      read: sentinelRead,
      remove: seams.remove,
      watch,
    },
    finalization: {
      finalizeAgent: seams.finalizeAgent,
      finalizeRunCommon: ({ success, error }) => ({ outcome: success ? 'completed' : 'failed', finalSuccess: success, finalError: error, terminatedByUser: false }),
      shouldAbandonRun: seams.shouldAbandonRun,
      resolveErrorAnalysis: seams.resolveErrorAnalysis,
      runCompletionCleanup: seams.runCompletionCleanup,
    },
    probeMergeGatePr: seams.probeMergeGatePr,
  });
  return { controller, ...seams };
}

describe('TUI session controller — teardown owns its own machinery (#8021)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('clears both polling intervals and the sentinel watcher even with no active-run record', async () => {
    const { controller, closers, releaseRunRecord } = makeController();

    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    // The prompt timer and the provider-signal timer, both armed by attachSession.
    expect(vi.getTimerCount()).toBe(2);

    await controller.handleExit({ exitCode: 0, killed: false });

    expect(controller.isTerminal()).toBe(true);
    expect(vi.getTimerCount(), 'every interval this run armed must be cleared').toBe(0);
    expect(closers).toHaveLength(1);
    expect(closers[0]).toHaveBeenCalledTimes(1);
    // A run with no record still releases: `unregisterSpawnedAgent` is skipped
    // (no pid to unregister) but the map entry is deleted unconditionally.
    expect(releaseRunRecord).toHaveBeenCalledWith(null);
  });

  it('does not finish until post-release retirement settles, after stopping its own writer', async () => {
    const { controller, releaseRunRecord, kill } = makeController();
    let release;
    releaseRunRecord.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    let settled = false;
    const finishing = controller.handleExit({ exitCode: 0, killed: false }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(kill).toHaveBeenCalledWith('session-abcdef12');
    expect(releaseRunRecord).toHaveBeenCalledOnce();
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(releaseRunRecord.mock.invocationCallOrder[0]);
    expect(settled).toBe(false);
    release();
    await finishing;
    expect(controller.isTerminal()).toBe(true);
  });

  it.each([
    ['drainLines', 'parsed output'],
    ['drainRaw', 'raw PTY spool'],
  ])('still finalizes, releases the lane and kills the session when %s rejects (BACKUP_SNAPSHOT_BUSY)', async (drainName, label) => {
    const busy = Object.assign(new Error('backup snapshot busy'), { code: 'BACKUP_SNAPSHOT_BUSY' });
    const { controller, finalizeAgent, releaseRunRecord, kill, markUnsettled } = makeController({
      spoolerOverrides: { [drainName]: vi.fn().mockRejectedValue(busy) },
    });

    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    await controller.handleExit({ exitCode: 0, killed: false });

    expect(controller.isTerminal()).toBe(true);
    expect(finalizeAgent).toHaveBeenCalledTimes(1);
    expect(finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-8021', success: true }));
    expect(releaseRunRecord).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('session-abcdef12');
    expect(markUnsettled).toHaveBeenCalled();
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining(`${label} drain failed`), { agentId: 'agent-8021' });
  });

  it.each([
    ['the host shutdown check throws', 'shouldAbandonRun'],
    ['the merge-gate probe rejects', 'probeMergeGatePr'],
    ['the merge-gate sentinel removal rejects', 'remove'],
  ])('finalizes once and releases the run when %s', async (_case, seam) => {
    const subject = makeController({
      mergeGateIsOwed: true,
      sentinelSummary: 'Shipped the extraction. PR is open.',
      prProbe: { prState: 'OPEN', prUrl: 'https://example.com/pr/1', readable: true },
    });
    const failure = new Error('completion decision failed');
    if (seam === 'shouldAbandonRun') subject[seam].mockImplementationOnce(() => { throw failure; });
    else subject[seam].mockRejectedValueOnce(failure);
    const { controller, closers, watch, finalizeAgent, runCompletionCleanup, kill, releaseRunRecord } = subject;
    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });

    await controller.finish({ success: true, reason: 'agent-signaled-done' });
    await controller.handleExit({ exitCode: 0, killed: false });

    expect(controller.isTerminal()).toBe(true);
    expect(finalizeAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ success: true }));
    expect(runCompletionCleanup).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('session-abcdef12');
    expect(releaseRunRecord).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledOnce();
    expect(closers[0]).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finalizes the failed run and releases it when error analysis rejects', async () => {
    const { controller, finalizeAgent, runCompletionCleanup, resolveErrorAnalysis, kill, releaseRunRecord } = makeController();
    resolveErrorAnalysis.mockRejectedValueOnce(new Error('analysis failed'));
    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });

    await controller.handleExit({ exitCode: 1, killed: false });

    expect(finalizeAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ success: false, errorAnalysis: null }));
    expect(runCompletionCleanup).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('session-abcdef12');
    expect(releaseRunRecord).toHaveBeenCalledOnce();
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('analysis failed'), { agentId: 'agent-8021' });
  });

  it('detects a split PTY banner in arrival order while the working phase write is pending', async () => {
    const { controller, updateAgent, finalizeAgent } = makeController();
    const workingWrite = Promise.withResolvers();
    updateAgent.mockReturnValueOnce(workingWrite.promise);
    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });

    const firstChunk = controller.handleData('Now using extra ');
    try {
      await controller.handleData('usage\n');
      expect(updateAgent).toHaveBeenCalledWith('agent-8021', { metadata: { phase: 'working' } });
      expect(finalizeAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        success: false, completionReason: 'fallback-signal',
      }));
    } finally {
      workingWrite.reject(new Error('working phase write failed'));
      await firstChunk;
      await controller.handleExit({ exitCode: 0, killed: false });
    }
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('working phase write failed'), { agentId: 'agent-8021' });
  });

  it.each([
    ['proven empty branch', { success: true, branchProvenEmpty: true }, true, true],
    ['no proof of an empty branch', { success: true }, true, false],
    ['downgraded success', { success: false }, false, false],
  ])('passes the finalize verdict to cleanup for %s', async (_case, verdict, success, branchProvenEmpty) => {
    const { controller, finalizeAgent, runCompletionCleanup } = makeController();
    finalizeAgent.mockResolvedValueOnce(verdict);

    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    await controller.handleExit({ exitCode: 0, killed: false });

    expect(finalizeAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ success: true }));
    expect(runCompletionCleanup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentId: 'agent-8021', success, branchProvenEmpty,
    }));
  });

  it('holds error analysis and completion until the raw PTY spool drain settles', async () => {
    let releaseDrain;
    const drainRaw = vi.fn(() => new Promise((resolve) => { releaseDrain = resolve; }));
    const { controller, finalizeAgent, resolveErrorAnalysis } = makeController({ spoolerOverrides: { drainRaw } });

    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    const exited = controller.handleExit({ exitCode: 0, killed: false });
    await vi.advanceTimersByTimeAsync(0);

    // completeAgent (inside finalizeAgent) archives the run directory; it must
    // not start while raw.txt still has queued bytes.
    expect(drainRaw).toHaveBeenCalledTimes(1);
    expect(resolveErrorAnalysis).not.toHaveBeenCalled();
    expect(finalizeAgent).not.toHaveBeenCalled();

    releaseDrain();
    await exited;
    expect(finalizeAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps the run alive when a completion sentinel read fails, then retries it', async () => {
    let reads = 0;
    const { controller, closers, finalizeAgent, watch } = makeController({
      sentinelSummary: 'Recovered completion.',
      sentinelRead: async () => {
        reads += 1;
        if (reads === 1) throw new Error('sentinel is still being written');
        return 'Recovered completion.';
      },
    });

    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    await controller.finish({ success: true, exitCode: 0, reason: 'agent-signaled-done' });

    expect(finalizeAgent).not.toHaveBeenCalled();
    expect(controller.isTerminal()).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(closers[0]).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(2);

    await controller.finish({ success: true, exitCode: 0, reason: 'agent-signaled-done' });
    expect(finalizeAgent).toHaveBeenCalledTimes(1);
    expect(controller.isTerminal()).toBe(true);
  });

  it('tears down the watcher the merge-gate nudge re-armed, not the one it replaced', async () => {
    const { controller, watch, closers, remove, paste, finalizeAgent } = makeController({
      mergeGateIsOwed: true,
      sentinelSummary: 'Shipped the extraction. PR is open.',
      prProbe: { prState: 'OPEN', prUrl: 'https://example.com/pr/1', readable: true },
    });

    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    expect(watch).toHaveBeenCalledTimes(1);

    // The sentinel fired: the run owed a merge, the PR is still OPEN and the
    // summary names no blocker, so this finish() nudges instead of finalizing.
    await controller.finish({ success: true, exitCode: 0, reason: 'agent-signaled-done' });
    expect(paste).toHaveBeenCalledTimes(1);
    expect(remove, 'the nudge must delete the sentinel it already consumed').toHaveBeenCalledTimes(1);
    expect(watch, 'a one-shot watcher that already fired needs replacing').toHaveBeenCalledTimes(2);
    expect(finalizeAgent, 'the nudged run is not finalized yet').not.toHaveBeenCalled();
    expect(controller.isTerminal()).toBe(false);

    // The session dies without a second sentinel. The RE-ARMED watcher is the
    // one still live, and it is the one teardown has to close.
    await controller.handleExit({ exitCode: 1, killed: false });

    expect(finalizeAgent).toHaveBeenCalledTimes(1);
    // The first watcher is one-shot: it already fired and closed itself, so
    // teardown must close the SECOND one and only that one.
    expect(closers[0], 'the replaced watcher already closed itself').not.toHaveBeenCalled();
    expect(closers[1]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });


  it('binds failure analysis to the raw byte boundary after the submission Enter', async () => {
    const prompt = 'A failing guard leaves the PR open with its failing test named.';
    const { controller, resolveErrorAnalysis, write } = makeController({
      tuiConfig: { ...TUI_CONFIG, command: 'claude', spawnCommand: 'claude', promptDelayMs: 250 }, prompt,
    });
    controller.attachSession({ sessionId: 'session-test', pid: 4242 });
    controller.markCommandInjected();
    await controller.handleData('\x1b[?2004h');
    await vi.advanceTimersByTimeAsync(300);
    await controller.handleData(prompt);
    await vi.advanceTimersByTimeAsync(300);
    expect(write).toHaveBeenCalledWith('session-test', '\r', { promptSubmission: true });
    const emitted = '\nActual tool output 🌟\ntest failed';
    await controller.handleData(emitted);
    await controller.handleExit({ exitCode: 1, killed: false });
    expect(resolveErrorAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      completionReason: 'shell-exit',
      promptProvenance: { submitted: true, suppliedPrompt: prompt, bytesSinceSubmission: Buffer.byteLength(emitted) },
    }));
  });

  it('sends Claude low-priority once after an opted-in session-limit banner', async () => {
    const { controller, write, paste, finalizeAgent } = makeController({
      provider: {
        id: 'claude-code-tui',
        name: 'Claude Code TUI',
        type: 'tui',
        command: 'claude',
        lowPriorityOnUsageLimit: true,
      },
      tuiConfig: { ...TUI_CONFIG, command: 'claude', spawnCommand: '/usr/local/bin/claude', promptDelayMs: 250 },
      prompt: 'A sufficiently long prompt for this controller test',
    });

    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    controller.markCommandInjected();
    await controller.handleData('\x1b[?2004h');
    await vi.advanceTimersByTimeAsync(300);
    await controller.handleData('A sufficiently long prompt for this controller test');
    await vi.advanceTimersByTimeAsync(300);
    expect(write).toHaveBeenCalledWith('session-abcdef12', '\r', { promptSubmission: true });

    const banner = "\n⏺ You've hit your session limit · resets 6:00 PM";
    await controller.handleData(banner);
    await controller.handleData(banner);

    expect(write).toHaveBeenCalledWith('session-abcdef12', '/low-priority\r');
    expect(write.mock.calls.filter(([, keys]) => keys === '/low-priority\r')).toHaveLength(1);
    expect(finalizeAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1600);
    expect(paste).toHaveBeenCalledWith('A sufficiently long prompt for this controller test', expect.objectContaining({
      label: expect.stringContaining('Claude low-priority continuation'),
    }));

    await controller.handleData(banner);
    expect(finalizeAgent).toHaveBeenCalledTimes(1);
  });

  it('does not send Claude low-priority without the provider opt-in', async () => {
    const { controller, write, finalizeAgent } = makeController({
      provider: { id: 'claude-code-tui', name: 'Claude Code TUI', type: 'tui', command: 'claude' },
      tuiConfig: { ...TUI_CONFIG, command: 'claude', spawnCommand: '/usr/local/bin/claude', promptDelayMs: 250 },
      prompt: 'A sufficiently long prompt for this controller test',
    });

    controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    controller.markCommandInjected();
    await controller.handleData('\x1b[?2004h');
    await vi.advanceTimersByTimeAsync(300);
    await controller.handleData('A sufficiently long prompt for this controller test');
    await vi.advanceTimersByTimeAsync(300);
    await controller.handleData("\n⏺ You've hit your session limit · resets 6:00 PM");

    expect(write).not.toHaveBeenCalledWith('session-abcdef12', '/low-priority\r');
    expect(finalizeAgent).toHaveBeenCalledTimes(1);
  });
});

describe('Codex terminal model-access rejection (#9319)', () => {
  const rejection = '\n■ Unexpected status 400 Bad Request: ' + JSON.stringify({
    error: {
      message: "The 'example-model' model is not supported when using Codex with a ChatGPT account.",
      type: 'invalid_request_error', param: null, code: null,
    },
  }) + '\n';
  const ended = '─ Worked for 1s ─────────────────\n';
  const composer = '› Ask Codex to do anything\n  ? for shortcuts\n';

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const submitted = async (options) => {
    const subject = makeController(options);
    subject.controller.attachSession({ sessionId: 'session-abcdef12', pid: 4242 });
    subject.controller.markCommandInjected();
    await subject.controller.handleData(composer);
    await vi.advanceTimersByTimeAsync(3000);
    await subject.controller.handleData('do the work\n');
    await vi.advanceTimersByTimeAsync(4000);
    subject.write.mockClear();
    return subject;
  };

  it('stops all recovery when a trusted scanner refusal arrives before the outer TUI exits', async () => {
    const { controller, ...seams } = await submitted({ securityScanGrant: { model: 'example-model', effort: 'medium', auth: 'chatgpt', maxCostUsd: 'unlimited', timeLimitSeconds: 'unlimited' } });
    seams.write.mockClear();
    seams.paste.mockClear();
    await controller.refuseScanner();
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_IDLE_MS + 10000);
    expect(seams.write).not.toHaveBeenCalled();
    expect(seams.paste).not.toHaveBeenCalled();
    expect(seams.finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({ success: false,
      executionInterruption: { category: 'content-refusal', source: 'security-scanner' },
      errorAnalysis: expect.objectContaining({ requiresFallback: false }) }));
  });

  it('latches a policy refusal while persistence is pending, outranking a concurrent success without nudges', async () => {
    const { controller, updateAgent, paste, write, finalizeAgent, kill } = await submitted();
    let rejectWrite;
    updateAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
    const refusing = controller.handleData('\x1b[12;1Hⓘ This content can’t be shown');
    // Let the serialized onData queue reach its metadata write.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await controller.finish({ success: true, reason: 'agent-signaled-done' });
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_IDLE_MS + 10000);
    rejectWrite(new Error('synthetic persistence failure'));
    await refusing;
    expect(paste).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(finalizeAgent).toHaveBeenCalledTimes(1);
    expect(finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
      success: false, completionReason: 'content-refusal',
      errorAnalysis: expect.objectContaining({ category: 'content-refusal', requiresFallback: false }),
      executionInterruption: expect.objectContaining({ category: 'content-refusal', source: 'provider' }),
    }));
    expect(kill).toHaveBeenCalledTimes(1);
    expect(controller.isTerminal()).toBe(true);
  });

  it('settles a chunked structured rejection, finalizes once, and tears down without continuing', async () => {
    const { controller, paste, write, finalizeAgent, resolveErrorAnalysis, kill, closers } = await submitted();
    // A first-request rejection has no work separator: Codex's terminal ■
    // error cell itself is emitted only after on_error finalizes the turn.
    const details = ', url: https://example.com/responses, cf-ray: example-ray, request id: example-request\n';
    for (const chunk of [rejection.slice(0, 90), rejection.slice(90).trimEnd(), details, composer]) {
      await controller.handleData(chunk);
    }
    await vi.advanceTimersByTimeAsync(4000);
    expect(finalizeAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(resolveErrorAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      immediateFallbackAnalysis: expect.objectContaining({ category: 'model-not-supported', actionable: true, origin: 'provider' }),
    }));
    expect(finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
      success: false, exitCode: 1, completionReason: 'model-access-rejected',
      errorAnalysis: expect.objectContaining({ category: 'model-not-supported' }),
    }));
    expect(paste).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(controller.isTerminal()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(closers[0]).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
    await controller.handleExit({ exitCode: 1 });
    await controller.handleData(rejection + ended + composer);
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_IDLE_MS * 2);
    expect(finalizeAgent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no terminal error-turn gutter', rejection.replace('■ ', '') + composer],
    ['no fresh empty composer', rejection + ended],
    ['stale composer from before the error', composer + rejection],
    ['transient HTTP failure', rejection.replace('400 Bad Request', '500 Internal Server Error') + ended + composer],
    ['quoted prose', '> ' + rejection.trimStart() + ended + composer],
    ['productive tool output after a fixture', rejection + ended + composer + '• Running tests (1s • esc to interrupt)\n'],
    ['recovered assistant output', rejection + ended + composer + 'The tests passed; committing the fix.\n'],
  ])('preserves ordinary continuation for %s', async (_name, output) => {
    const { controller, paste, finalizeAgent } = await submitted();
    await controller.handleData(output);
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_IDLE_MS + 10000);
    expect(finalizeAgent).not.toHaveBeenCalled();
    expect(paste).toHaveBeenCalledWith(STALL_NUDGE_TEXT, expect.any(Object));
    await controller.handleExit({ exitCode: 0 });
  });

  it('discards a corroborated fixture when productive output resumes in a later chunk', async () => {
    const { controller, finalizeAgent } = await submitted();
    await controller.handleData(rejection + ended + composer);
    await vi.advanceTimersByTimeAsync(2000);
    await controller.handleData('• Working (2s • esc to interrupt)\n');
    await vi.advanceTimersByTimeAsync(10000);
    expect(finalizeAgent).not.toHaveBeenCalled();
    await controller.handleExit({ exitCode: 0 });
  });
});


describe('Codex paste output settles before submission', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps one late paste intact and waits for its last output before Enter', async () => {
    const { controller, write } = makeController();
    controller.attachSession({ sessionId: 'session-paste-settle', pid: 4242 });
    controller.markCommandInjected();
    await controller.handleData('› Ask Codex to do anything\n');
    await vi.advanceTimersByTimeAsync(3000);
    const pastes = () => write.mock.calls.filter(([, keys]) => keys.startsWith('\x1b[200~'));
    const enters = () => write.mock.calls.filter(([, keys]) => keys === '\r');
    expect(pastes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    // A cold start can render the first chip long after the paste write. More
    // input still follows it; an Enter here belongs to Codex's paste burst.
    await controller.handleData('[Pasted Content 30000 chars]');
    for (let chunk = 0; chunk < 8; chunk += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await controller.handleData(' remaining prompt text');
      expect(enters()).toHaveLength(0);
    }
    await vi.advanceTimersByTimeAsync(199);
    expect(enters()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(enters()).toHaveLength(1);
    expect(pastes()).toHaveLength(1);
    expect(pastes()[0][1]).toBe('\x1b[200~do the work\x1b[201~');
    await controller.handleExit({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(enters()).toHaveLength(1);
  });

  it('finalizes a deferred Enter write failure without escaping the timer callback', async () => {
    const { controller, write, finalizeAgent } = makeController();
    controller.attachSession({ sessionId: 'session-paste-write-failure', pid: 4242 });
    controller.markCommandInjected();
    await controller.handleData('› Ask Codex to do anything\n');
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(8050);
    write.mockImplementation((_sessionId, keys) => {
      if (keys === '\r') throw new Error('PTY closed');
    });
    await controller.handleData('[Pasted Content 30000 chars]');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
      success: false, completionReason: 'prompt-submit-failed',
      error: expect.stringContaining('Could not submit the pasted prompt: PTY closed'),
    })));
  });

  it('bounds continuous paste output with explicit non-submission and no duplicate paste', async () => {
    const { controller, write, finalizeAgent } = makeController();
    controller.attachSession({ sessionId: 'session-paste-never-settles', pid: 4242 });
    controller.markCommandInjected();
    await controller.handleData('› Ask Codex to do anything\n');
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(8050);
    await controller.handleData('[Pasted Content 30000 chars]');
    for (let chunk = 0; chunk < 460; chunk += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await controller.handleData(' continuing redraw');
    }
    await vi.waitFor(() => expect(finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
      success: false, completionReason: 'prompt-not-submitted',
      error: expect.stringContaining('no submission Enter was sent'),
    })));
    expect(write.mock.calls.filter(([, keys]) => keys === '\r')).toHaveLength(0);
    expect(write.mock.calls.filter(([, keys]) => keys.startsWith('\x1b[200~'))).toHaveLength(1);
  });

  it('cancels a pending settled submission when the PTY exits', async () => {
    const { controller, write } = makeController();
    controller.attachSession({ sessionId: 'session-paste-exit', pid: 4242 });
    controller.markCommandInjected();
    await controller.handleData('› Ask Codex to do anything\n');
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(8050);
    await controller.handleData('[Pasted Content 30000 chars]');
    await vi.advanceTimersByTimeAsync(50);
    await controller.handleExit({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(write.mock.calls.filter(([, keys]) => keys === '\r')).toHaveLength(0);
  });
});
