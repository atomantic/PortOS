/**
 * Session-controller teardown contract (#8021).
 *
 * The spawner's own suite (`../agentTuiSpawning.test.js`) drives every public
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

vi.mock('../cosEvents.js', () => ({ emitLog: vi.fn() }));

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
  sentinelRead = async () => sentinelSummary ?? '',
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
    releaseRunRecord: vi.fn(),
    runCompletionCleanup: vi.fn().mockResolvedValue({}),
    finalizeAgent: vi.fn().mockResolvedValue({ success: true }),
    remove: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    paste: vi.fn(() => ({ /* a live submit-Enter interval handle */ })),
    kill: vi.fn(),
    resolveErrorAnalysis: vi.fn(async ({ immediateFallbackAnalysis }) => immediateFallbackAnalysis),
  };
  const controller = createTuiSessionController({
    agentId: 'agent-8021',
    task: TASK,
    runId: 'run-1',
    model: 'gpt-5-codex',
    provider,
    prompt,
    tuiConfig,
    cwd: '/tmp/workspace',
    rawFile: '/tmp/workspace/raw.txt',
    executionId: 'exec-1',
    laneName: 'lane-1',
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
    },
    session: {
      write: seams.write,
      paste: (_sessionId, text, options) => seams.paste(text, options),
      isAlive: () => true,
      kill: seams.kill,
      hasLiveChild: async () => true,
    },
    persistence: {
      updateAgent: vi.fn().mockResolvedValue(undefined),
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
      shouldAbandonRun: () => false,
      resolveErrorAnalysis: seams.resolveErrorAnalysis,
      runCompletionCleanup: seams.runCompletionCleanup,
    },
    probeMergeGatePr: async () => prProbe,
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
