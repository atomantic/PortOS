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
    isTruthyMetaFn: () => false,
    directLaunch: true,
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
      read: async () => sentinelSummary ?? '',
      remove: seams.remove,
      watch,
    },
    finalization: {
      finalizeAgent: seams.finalizeAgent,
      finalizeRunCommon: () => ({ outcome: 'completed', finalSuccess: true, finalError: null, terminatedByUser: false }),
      shouldAbandonRun: () => false,
      resolveErrorAnalysis: vi.fn().mockResolvedValue(null),
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
    const { controller, write } = makeController({
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
    await controller.handleExit({ exitCode: 1, killed: false });
  });

  it('does not send Claude low-priority without the provider opt-in', async () => {
    const { controller, write } = makeController({
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
    await controller.handleExit({ exitCode: 1, killed: false });
  });
});
