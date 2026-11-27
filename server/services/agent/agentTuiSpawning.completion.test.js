import { STALL_NUDGE_IDLE_MS } from '../../test/fixtures/tuiTiming.js';
import {
  appendRunEvent,
  flushMicrotasks,
  sessionCallbacks,
  runSpawn,
  CODEX_COMPOSER,
  installTuiRuntimeHooks,
} from './agentTuiSpawning.test.fixture.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import { runSpawnerCompletionCleanup } from './agentCompletionCleanup.js';
import { spawnTuiSessionViaRunner, RUNNER_SPAWN_REFUSED, RUNNER_SPAWN_AMBIGUOUS } from '../cos/cosRunnerClient.js';
import * as shellService from '../shell.js';
import * as agentLifecycle from './agentFinalization.js';
import * as cosAgentLifecycle from '../cos/cosAgentLifecycle.js';
import { probePrForBranch } from '../prProbe.js';
import { activeAgents, userTerminatedAgents, pausedAgents, consumePausedAgentExit } from './agentState.js';
import { STALL_NUDGE_MAX_ATTEMPTS } from '../../lib/tuiHandshake.js';
import { markHostShuttingDown, resetHostShutdownFlagForTests } from '../../lib/hostShutdown.js';
import { emitLog } from '../cos/cosEvents.js';

describe('spawnTuiAgent runtime', () => {
  installTuiRuntimeHooks();

  // ── 9. Success-path skips the tail read ─────────────────────────────────────
  // Successful finalize must not touch raw.txt — that's what makes the
  // disk-spool's bounded-memory guarantee hold for healthy long runs.
  it('success finalize: skips raw.txt tail read entirely', async () => {
    const fsPromises = await import('fs/promises');

    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    const spawnPromise = runSpawn();
    await flushMicrotasks();

    // Drive the prompt far enough to exercise normal post-submit output, then
    // use the ordinary shell-exit completion path.
    await sessionCallbacks.onData(Buffer.from('Codex booting...\n' + CODEX_COMPOSER));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    // Emit the prompt echo so paste verification passes (issue #2192).
    await sessionCallbacks.onData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600); // submit-Enter fires → promptSubmittedAt set
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('(1s · thinking with high effort)\n'));
    await vi.advanceTimersByTimeAsync(800);
    await sessionCallbacks.onData(Buffer.from('(2s · thinking with high effort)\n'));
    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await spawnPromise;
    vi.useRealTimers();
    await completeDone;

    // No raw.txt stat / open should fire on the success path. (The mock
    // for fs.promises.stat / open was reset between tests by clearAllMocks,
    // so any calls here are from this run.)
    const statCalls = vi.mocked(fsPromises.stat).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(statCalls).toHaveLength(0);

    const openCalls = vi.mocked(fsPromises.open).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(openCalls).toHaveLength(0);
  });

  // ── 10. Completion-sentinel ingestion on the shell-exit path ─────────────────
  // The completion workflow has the agent write `.agent-done` and then stop
  // (it does NOT `/quit`). Normally the doneSentinelWatcher finalizes the
  // agent, but the TUI process can also exit on its own (or be killed) before
  // the watcher fires — when that shell-exit path wins the race, finish() MUST
  // still ingest the sentinel so its markdown resolution lands in outputBuffer /
  // output.txt and shows up in the completed-agent details view. Regression
  // guard for the lost-resolution bug where the summary only got ingested by
  // the watcher path.
  it('shell-exit after sentinel write: ingests .agent-done summary into the persisted output (process exit beats the watcher)', async () => {
    const { appendFile } = await import('fs/promises');
    const sentinel = '## Summary\nImplemented the fix.\n\n## PR\nhttps://example.com/pr/42';
    vi.mocked(existsSync).mockReturnValue(true);
    // The agent writes the run-scoped sentinel name the prompt gave it.
    vi.mocked(readFile).mockImplementation(async (p) =>
      typeof p === 'string' && p.endsWith('.agent-done-agent-1') ? sentinel : ''
    );

    const spawnPromise = runSpawn({ workspacePath: '/tmp/ws' });
    await flushMicrotasks();

    // Simulate the TUI process exiting cleanly from /quit — NOT the poll.
    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await flushMicrotasks();

    await spawnPromise;

    await vi.waitFor(() => expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1));

    // The completed-agent details view reads output.txt (getAgent) and the
    // in-state output stream (live view / fallback). Both must carry the
    // sentinel resolution — assert on the persistence paths, not outputBuffer,
    // since the test mocks OUTPUT_BUFFER_CAP down to 1 byte.
    const flushedLines = vi.mocked(cosAgentLifecycle.appendAgentOutputLines).mock.calls
      .flatMap(([, lines]) => lines);
    expect(flushedLines).toContain('✅ Agent signaled completion');
    expect(flushedLines.some(l => l.includes('Implemented the fix.'))).toBe(true);
    expect(flushedLines.some(l => l.includes('https://example.com/pr/42'))).toBe(true);

    const outputTxtWrites = vi.mocked(appendFile).mock.calls
      .filter(([p]) => typeof p === 'string' && p.endsWith('output.txt'))
      .map(([, data]) => String(data))
      .join('');
    expect(outputTxtWrites).toContain('Implemented the fix.');
    expect(outputTxtWrites).toContain('https://example.com/pr/42');
  });

  it('finalizes a one-character-truncated sentinel and stops the idle nudge loop', async () => {
    const truncatedName = '.agent-done-agent-ded2dcc';
    const sentinel = '## Summary\nRecovered after a terminal path truncation.';
    vi.mocked(existsSync).mockImplementation((filePath) =>
      filePath === '/tmp/ws' || (typeof filePath === 'string' && filePath.endsWith(truncatedName))
    );
    vi.mocked(readFile).mockImplementation(async (filePath) =>
      typeof filePath === 'string' && filePath.endsWith(truncatedName) ? sentinel : ''
    );

    const spawnPromise = runSpawn({ agentId: 'agent-ded2dccb', workspacePath: '/tmp/ws' });
    await flushMicrotasks();
    await sessionCallbacks.onExit({ exitCode: 0, killed: false });
    await spawnPromise;
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-ded2dccb',
        success: true,
        completionReason: 'agent-signaled-done',
      }),
    );

    const pasteCount = vi.mocked(shellService.pasteToSession).mock.calls.length;
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_IDLE_MS * (STALL_NUDGE_MAX_ATTEMPTS + 1));
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(pasteCount);
  });

  // ── 11. A PortOS host restart is an interruption, never a completion ─────────
  //
  // Reported in #3202: `pm2 restart portos-server` TreeKills the agent's PTY.
  // node-pty reports that as exit code 0, so `success: code === 0 && !killed`
  // recorded a run that had produced nothing as SUCCESSFUL — and worse, finalize
  // handed the worktree to cleanup, destroying the state a resume needs. Both
  // halves are asserted here.
  describe('host restart (#3202)', () => {
    afterEach(() => resetHostShutdownFlagForTests());

    it('abandons instead of finalizing when the PTY dies during shutdown', async () => {
      const spawnPromise = runSpawn();
      await flushMicrotasks();

      markHostShuttingDown();
      // Exactly what pm2's TreeKill looks like from node-pty: a clean exit code.
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await flushMicrotasks();
      await spawnPromise;

      // No outcome recorded, and — critically — the worktree is left alone.
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
      expect(runSpawnerCompletionCleanup).not.toHaveBeenCalled();
      // The record stays `running`; only the phase label is refined, so boot
      // recovery still sees it as an agent to reconcile from the marker.
      expect(vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.some(
        ([, patch]) => patch?.metadata?.phase === 'interrupted' && patch?.metadata?.interruptedBy === 'host-shutdown'
      )).toBe(true);
    });

    // An abandoned run is as over as a finalized one — it just has no outcome
    // — so nothing may record one afterwards. The shutdown flag is cleared
    // before the second trigger so the abandoned session itself, not the flag,
    // is the only thing between that trigger and finalizeAgent.
    it('stays abandoned: a trigger arriving after the abandon records no outcome and runs no cleanup', async () => {
      const spawnPromise = runSpawn();
      await flushMicrotasks();

      markHostShuttingDown();
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await flushMicrotasks();
      await spawnPromise;
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

      resetHostShutdownFlagForTests();
      await sessionCallbacks.onExit({ exitCode: 1, killed: true });
      await flushMicrotasks();

      // Still no outcome — and still no completion cleanup, so the worktree
      // the resume needs is untouched.
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
      expect(runSpawnerCompletionCleanup).not.toHaveBeenCalled();
    });

    it('still finalizes as success when the agent had already written its sentinel', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockImplementation(async (p) =>
        typeof p === 'string' && p.endsWith('.agent-done') ? '## Summary\nDone.' : ''
      );

      const spawnPromise = runSpawn({ workspacePath: '/tmp/ws' });
      await flushMicrotasks();

      markHostShuttingDown();
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await flushMicrotasks();
      await spawnPromise;

      await vi.waitFor(() => expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-1', success: true })
      ));
    });

    // The backstop for a SIGKILL'd or crashed portos-server, which never runs its
    // shutdown handler — so the in-process flag is never set, and the only
    // evidence left is node-pty's `signal`.
    it('records a signal-terminated PTY as a failure even with exit code 0', async () => {
      const spawnPromise = runSpawn();
      await flushMicrotasks();

      await sessionCallbacks.onExit({ exitCode: 0, killed: false, signal: 15 });
      await flushMicrotasks();
      await spawnPromise;

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'shell-signaled',
          error: expect.stringContaining('signal 15'),
        })
      );
    });

    // Guard against over-correcting: a TUI that genuinely exits 0 on its own,
    // outside a shutdown and with no signal, keeps its prior success semantics.
    it('leaves an ordinary clean exit alone', async () => {
      const spawnPromise = runSpawn();
      await flushMicrotasks();

      await sessionCallbacks.onExit({ exitCode: 0, killed: false, signal: null });
      await flushMicrotasks();
      await spawnPromise;

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, completionReason: 'shell-exit' })
      );
    });
  });

  // A session that never spawns at all. The runner rejects the spawn (e.g. its
  // command allowlist doesn't carry the provider's CLI), createAgentTuiSession
  // throws, and before this was handled the throw propagated out of
  // spawnTuiAgent to a caller that only logs — leaving the agent record stuck in
  // `initializing` until the zombie reaper finalized it a minute later with a
  // generic message, so the real cause never reached the user.
  //
  // The reason splits on the runner hop — see spawnTuiAgent's catch. Note a
  // refused/mid-restart runner surfaces from undici as a bare
  // TypeError('fetch failed').
  describe('spawn failure', () => {
    it.each([
      ['a runner refusal', new Error('Command not allowed: grok. Permitted commands: claude, codex'), 'Command not allowed: grok'],
      ['an unreachable runner', new TypeError('fetch failed'), 'fetch failed'],
    ])('finalizes %s as spawn-rejected instead of throwing', async (_label, rejection, expectedFragment) => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(rejection);

      // Resolves, does not reject.
      await expect(runSpawn({ useDurableRunner: true })).resolves.toBeNull();

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'spawn-rejected',
          error: expect.stringContaining(expectedFragment),
        })
      );
    });

    it('classifies a runner executable preflight failure as command-not-found', async () => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(
        new Error('Command executable unavailable: opencode did not pass the CoS Runner capability check. Reinstall it or update the provider command.'),
      );

      await expect(runSpawn({ useDurableRunner: true })).resolves.toBeNull();

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'command-not-found',
          error: expect.stringContaining('did not pass the CoS Runner capability check'),
        })
      );
    });

    // The runner's two PTY diagnoses split on RETRY POLICY, and the split is the
    // whole point of naming them separately. A PTY layer that cannot fork is
    // broken for every task until a human reinstalls, so it must block once
    // instead of retry-storming the fleet; a reaped worktree is cleared by the
    // very next attempt, which provisions a fresh one, so it must NOT block.
    // Collapsing them (an earlier revision matched both prefixes) parks work a
    // retry would have fixed.
    it('blocks on an unusable PTY layer as runner-pty-unavailable', async () => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(
        new Error('CoS Runner PTY unavailable: node-pty cannot fork any process, so this is not specific to the requested command. Repair it with `node scripts/ensure-deps.js`.'),
      );

      await expect(runSpawn({ useDurableRunner: true })).resolves.toBeNull();

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'runner-pty-unavailable',
          error: expect.stringContaining('node scripts/ensure-deps.js'),
        })
      );
    });

    it('leaves a reaped workspace retryable as spawn-rejected', async () => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(
        new Error('CoS Runner workspace missing: the workspace for this spawn does not exist. Its worktree was probably removed before the agent launched.'),
      );

      await expect(runSpawn({ useDurableRunner: true })).resolves.toBeNull();

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'spawn-rejected',
          error: expect.stringContaining('worktree was probably removed'),
        })
      );
    });

    // The ledger has to carry the outcome it actually knows (#4615). A runner
    // that ANSWERED with a refusal and a transport failure that answered
    // nothing are different facts, and a diagnostic that reads the second as
    // the first sends the reader after a rejection that never happened.
    const handoffs = () => appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'run.handoff');

    it('records a refused handoff as accepted:false', async () => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(
        Object.assign(new Error('Command not allowed: grok'), { spawnOutcome: RUNNER_SPAWN_REFUSED, status: 400 }),
      );

      await runSpawn({ useDurableRunner: true });

      expect(handoffs()).toEqual([expect.objectContaining({
        eventId: 'handoff:agent-1:run-1:rejected',
        data: expect.objectContaining({ to: 'none', accepted: false, outcome: RUNNER_SPAWN_REFUSED, kind: 'tui' }),
      })]);
    });

    it('records an ambiguous handoff as accepted:null with the transport reason', async () => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), { spawnOutcome: RUNNER_SPAWN_AMBIGUOUS }),
      );

      await runSpawn({ useDurableRunner: true });

      expect(handoffs()).toEqual([expect.objectContaining({
        eventId: 'handoff:agent-1:run-1:unconfirmed',
        data: expect.objectContaining({
          to: 'none',
          accepted: null,
          outcome: RUNNER_SPAWN_AMBIGUOUS,
          kind: 'tui',
          reason: 'fetch failed',
        }),
      })]);
    });

    it('records an adopted PTY as an accepted handoff and keeps the run alive', async () => {
      // The spawn rpc re-attached the relay to a PTY the runner already had, so
      // this is a live run — it must not be finalized as a failed spawn.
      const spawnDefault = vi.mocked(spawnTuiSessionViaRunner).getMockImplementation();
      vi.mocked(spawnTuiSessionViaRunner).mockImplementationOnce(async (options) => ({
        ...(await spawnDefault(options)),
        adopted: true,
        adoptedReason: 'fetch failed',
      }));

      const spawnPromise = runSpawn({ useDurableRunner: true });
      await flushMicrotasks();

      expect(handoffs()).toEqual([expect.objectContaining({
        eventId: 'handoff:agent-1:run-1:cos-runner',
        data: expect.objectContaining({
          to: 'cos-runner',
          accepted: true,
          adopted: true,
          outcome: RUNNER_SPAWN_AMBIGUOUS,
          reason: 'fetch failed',
        }),
      })]);
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

      await sessionCallbacks.onExit({ exitCode: 0, killed: false, signal: null });
      await flushMicrotasks();
      await spawnPromise;
    });

    it('keeps the actionable spawn-error when the local PTY path throws', async () => {
      vi.mocked(shellService.createShellSession).mockImplementationOnce(() => {
        throw new Error('posix_spawnp failed');
      });

      await expect(runSpawn({ useDurableRunner: false })).resolves.toBeNull();

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'spawn-error',
          error: 'Failed to start TUI session: posix_spawnp failed',
        })
      );
    });

  });

  // ── Merge Gate contract check (#5876) ────────────────────────────────────
  // A run that owns its own PR lifecycle (`openPR: true`, a TUI/CLI provider,
  // not leaned/handed-to-a-human) is told to merge its own PR before exiting.
  // These tests drive `finish()` via the shell-exit path (same as the
  // completion-sentinel suite above) with a `.agent-done` sentinel already on
  // disk, and assert on the re-prompt delivery (`shellService.pasteToSession`)
  // and on whether `finalizeAgent` — the point of no return — was reached.
  describe('merge-gate contract check (#5876)', () => {
    const openPrTask = { id: 'task-1', description: 'ship the fix', metadata: { openPR: true } };

    // Stateful (not a blanket `true`): `watchForFile`'s `detect()` also runs
    // SYNCHRONOUSLY at watcher-creation time, so if the sentinel already
    // "existed" when spawnTuiAgent creates its initial watcher, that watcher
    // self-fires before the test ever drives an explicit trigger — and a
    // re-prompt's `rm(doneSentinelPath)` needs to actually clear presence for
    // the re-armed watcher's OWN creation-time check to stay quiet too.
    // `withSentinel` therefore only wires the mocks; every test flips
    // `sentinelExists = true` itself, only once its trigger is ready to fire.
    let sentinelExists = false;
    const withSentinel = (summary) => {
      vi.mocked(existsSync).mockImplementation(() => sentinelExists);
      vi.mocked(readFile).mockImplementation(async (p) =>
        (typeof p === 'string' && p.endsWith('.agent-done-agent-1') && sentinelExists) ? summary : ''
      );
      vi.mocked(rm).mockImplementation(async () => { sentinelExists = false; });
    };

    // The merge-gate check adds real await hops (ingestDoneSentinel's readFile,
    // git.getBranch, probePrForBranch) before finish() reaches finalizeAgent —
    // more than the module-level `flushMicrotasks`'s fixed 3 hops reliably
    // drains. Loop it rather than deepen the shared helper for every caller.
    const settle = async () => {
      for (let i = 0; i < 8; i += 1) await flushMicrotasks();
    };

    // The sentinel watcher's fallback poll, past the 5000ms tick AND the 50ms
    // settle delay `watchForFile` applies after a `detect()`. A nudge is only
    // ever decided on this trigger: a PTY exit means nobody is left to read it.
    const fireSentinelWatcher = async () => {
      await vi.advanceTimersByTimeAsync(5100);
      await settle();
    };

    beforeEach(() => { sentinelExists = false; });

    it('leaves a read-only run with an open PR to PortOS without a merge re-prompt', async () => {
      vi.mocked(probePrForBranch).mockResolvedValue({
        prState: 'OPEN', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true,
      });
      withSentinel('## Summary\nFinished the analysis.');
      const spawnPromise = runSpawn({
        task: { ...openPrTask, metadata: { openPR: true, readOnly: true } },
      });
      await flushMicrotasks();
      sentinelExists = true;
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await settle();
      await spawnPromise;
      expect(probePrForBranch).not.toHaveBeenCalled();
      expect(shellService.pasteToSession).not.toHaveBeenCalled();
      expect(runSpawnerCompletionCleanup).toHaveBeenCalledWith(expect.objectContaining({
        prOwnership: expect.objectContaining({ taskOpenPR: true, prOpenedBy: 'portos', agentOpensOwnPr: false }),
      }));
    });

    it('re-prompts exactly once when the PR is open and the summary names no blocker, then finalizes on the RE-ARMED watcher even if still open', async () => {
      vi.mocked(shellService.pasteToSession).mockReturnValue(999);
      vi.mocked(probePrForBranch).mockResolvedValue({
        prState: 'OPEN', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true,
      });
      withSentinel('## Summary\nShipped the fix and opened the PR.');

      const spawnPromise = runSpawn({ task: openPrTask, workspacePath: '/tmp/ws' });
      await flushMicrotasks(); // initial watcher arms while quiet — must not self-fire

      sentinelExists = true; // the agent writes .agent-done
      await fireSentinelWatcher();

      // Round 1: nudged, not finalized. The reprompt path deletes the
      // sentinel (`rm` flips `sentinelExists` false, see withSentinel) and
      // arms a brand-new watcher — the original is one-shot and already
      // closed itself on this same detection.
      expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
      expect(shellService.pasteToSession.mock.calls[0][1]).toContain('still OPEN');
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

      // Round 2: the agent writes a fresh sentinel (still OPEN, still no
      // blocker) and the RE-ARMED watcher's fallback poll picks it up —
      // proving the re-arm itself works, not just a second exit event.
      sentinelExists = true;
      await fireSentinelWatcher();
      await spawnPromise;

      // One nudge per run: round 2 finalizes instead of nudging again.
      expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
    });

    it('never nudges a clean exit that carries no real .agent-done summary, even for a run that owed a merge', async () => {
      // success:true with nothing on disk — an ordinary quit, not the agent
      // signaling its Merge Gate is done. Must fall straight through to a
      // normal finalize, never probe the forge or paste into the session.
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readFile).mockResolvedValue('');

      const spawnPromise = runSpawn({ task: openPrTask, workspacePath: '/tmp/ws' });
      await flushMicrotasks(); // initial watcher arms while quiet — must not self-fire

      sentinelExists = true; // the agent writes .agent-done
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await settle();
      await spawnPromise;

      expect(probePrForBranch).not.toHaveBeenCalled();
      expect(shellService.pasteToSession).not.toHaveBeenCalled();
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
    });

    it('falls through to a normal finalize when the session is already gone (resubmit fails)', async () => {
      // pasteToSession returns nothing → resubmit() reports it couldn't nudge.
      // `clearAllMocks()` doesn't reset a return value set by an earlier test
      // (only call history), so this is explicit rather than relying on the
      // vi.fn() factory default.
      vi.mocked(shellService.pasteToSession).mockReturnValue(undefined);
      vi.mocked(probePrForBranch).mockResolvedValue({
        prState: 'OPEN', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true,
      });
      withSentinel('## Summary\nShipped the fix and opened the PR.');

      const spawnPromise = runSpawn({ task: openPrTask, workspacePath: '/tmp/ws' });
      await flushMicrotasks(); // initial watcher arms while quiet — must not self-fire

      sentinelExists = true; // the agent writes .agent-done
      await fireSentinelWatcher();
      await spawnPromise;

      expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
    });

    // #11861: a runner proxy accepts a paste after its PTY died, so a truthy
    // paste cannot prove the nudge reached anyone. When the exit is what
    // decides, the run finalizes; the open PR takes the post-finalize path.
    it('finalizes without nudging when a PTY exit is the deciding trigger, even if the paste would succeed', async () => {
      vi.mocked(shellService.pasteToSession).mockReturnValue(999);
      vi.mocked(probePrForBranch).mockResolvedValue({
        prState: 'OPEN', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true,
      });
      withSentinel('## Summary\nShipped the fix and opened the PR.');

      const spawnPromise = runSpawn({ task: openPrTask, workspacePath: '/tmp/ws' });
      await flushMicrotasks(); // initial watcher arms while quiet — must not self-fire

      sentinelExists = true; // the agent writes .agent-done, then exits first
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await settle();
      await spawnPromise;

      expect(shellService.pasteToSession).not.toHaveBeenCalled();
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('replays a finish() trigger dropped while the merge-gate check was deciding, instead of losing it', async () => {
      vi.mocked(shellService.pasteToSession).mockReturnValue(999);
      vi.mocked(probePrForBranch).mockResolvedValue({
        prState: 'OPEN', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true,
      });
      withSentinel('## Summary\nShipped the fix and opened the PR.');

      const spawnPromise = runSpawn({ task: openPrTask, workspacePath: '/tmp/ws' });
      await flushMicrotasks(); // initial watcher arms while quiet — must not self-fire

      // Hold the forge probe so the second trigger lands mid-decision.
      let releaseProbe;
      vi.mocked(probePrForBranch).mockImplementationOnce(() => new Promise((resolve) => {
        releaseProbe = () => resolve({
          prState: 'OPEN', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true,
        });
      }));

      sentinelExists = true; // the agent writes .agent-done
      // The sentinel watcher starts the merge-gate decision; a kill signal
      // racing in while it decides is parked by the `finishing` guard. It must
      // be replayed — not lost — once the first settles on "not finalizing
      // after all", or the run would sit forever waiting for a nudge into a
      // session that already died.
      await fireSentinelWatcher();
      expect(releaseProbe).toBeTypeOf('function');
      const exited = sessionCallbacks.onExit({ exitCode: 1, killed: true });
      releaseProbe();
      await settle();
      await exited;
      await spawnPromise;

      expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ success: false })
      );
    });

    // The nudge's reset to 'running' has to reopen the finish gate for EVERY
    // trigger — not only the parked replay above, and not only the re-armed
    // sentinel watcher. After a nudge the session is live again, and the next
    // thing to happen may be the PTY simply dying with no new sentinel at all.
    // Swallow that and the run holds its lane to the max-runtime ceiling with
    // no outcome recorded.
    it('finalizes a plain PTY exit arriving after the merge-gate nudge, and ignores anything after that', async () => {
      vi.mocked(shellService.pasteToSession).mockReturnValue(999);
      vi.mocked(probePrForBranch).mockResolvedValue({
        prState: 'OPEN', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true,
      });
      withSentinel('## Summary\nShipped the fix and opened the PR.');

      const spawnPromise = runSpawn({ task: openPrTask, workspacePath: '/tmp/ws' });
      await flushMicrotasks(); // initial watcher arms while quiet — must not self-fire

      sentinelExists = true; // the agent writes .agent-done
      await fireSentinelWatcher();
      expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

      // The nudge deleted the sentinel, so this exit carries no completion
      // signal of its own: nothing but the session phase decides whether it
      // is heard.
      await sessionCallbacks.onExit({ exitCode: 1, killed: true });
      await settle();
      await spawnPromise;

      expect(shellService.pasteToSession).toHaveBeenCalledTimes(1); // one nudge per run
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({ success: false }));

      // ...and now the run really is over — a late trigger finalizes nothing.
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await settle();
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
    });

    it('finalizes on the first sentinel with no re-prompt when the PR is already merged', async () => {
      vi.mocked(probePrForBranch).mockResolvedValue({
        prState: 'MERGED', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true,
      });
      withSentinel('## Summary\nMerged the PR.');

      const spawnPromise = runSpawn({ task: openPrTask, workspacePath: '/tmp/ws' });
      await flushMicrotasks(); // initial watcher arms while quiet — must not self-fire

      sentinelExists = true; // the agent writes .agent-done
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await settle();
      await spawnPromise;

      expect(shellService.pasteToSession).not.toHaveBeenCalled();
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
    });

    it('finalizes on the first sentinel with no re-prompt when the summary states it is deliberately leaving the PR open', async () => {
      vi.mocked(probePrForBranch).mockResolvedValue({
        prState: 'OPEN', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true,
      });
      withSentinel('## Summary\nA required check is still red after two fix attempts — leaving the PR open for a human.');

      const spawnPromise = runSpawn({ task: openPrTask, workspacePath: '/tmp/ws' });
      await flushMicrotasks(); // initial watcher arms while quiet — must not self-fire

      sentinelExists = true; // the agent writes .agent-done
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await settle();
      await spawnPromise;

      expect(shellService.pasteToSession).not.toHaveBeenCalled();
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
    });

    it('finalizes on the first sentinel with no re-prompt when the forge lookup is unreadable', async () => {
      vi.mocked(probePrForBranch).mockResolvedValue({
        prState: null, prUrl: null, prNumber: null, cli: null, readable: false,
      });
      withSentinel('## Summary\nShipped the fix and opened the PR.');

      const spawnPromise = runSpawn({ task: openPrTask, workspacePath: '/tmp/ws' });
      await flushMicrotasks(); // initial watcher arms while quiet — must not self-fire

      sentinelExists = true; // the agent writes .agent-done
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await settle();
      await spawnPromise;

      expect(shellService.pasteToSession).not.toHaveBeenCalled();
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
    });

    it('never probes the forge or re-prompts for a run that never asked for a PR', async () => {
      withSentinel('## Summary\nDid the audit, no PR needed.');

      const spawnPromise = runSpawn({
        task: { id: 'task-1', description: 'audit only', metadata: {} },
        workspacePath: '/tmp/ws',
      });
      await flushMicrotasks();

      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await settle();
      await spawnPromise;

      expect(probePrForBranch).not.toHaveBeenCalled();
      expect(shellService.pasteToSession).not.toHaveBeenCalled();
      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);
    });
  });

  // ── Shared finalize-sequence contract (#6619) ────────────────────────────────
  //
  // `finish()` and the CLI close handler used to hold two hand-mirrored copies of
  // this teardown, kept in sync by prose comments and running their two gates in
  // OPPOSITE order. These three tests are the oracle for the invariants that
  // mirroring protected — the same three, asserted the same way, live in
  // agentCliSpawning.test.js. They pin the lane/registry/marker effects that this
  // suite's finalizeAgent-argument assertions do not observe.
  describe('shared finalize sequence (#6619)', () => {
    afterEach(() => {
      pausedAgents.clear();
      userTerminatedAgents.clear();
      resetHostShutdownFlagForTests();
    });

    // A paused run was already settled by markAgentPaused, so the paused gate
    // must win over the host-shutdown gate.
    it('paused run exiting during host shutdown takes the paused path, writing no interrupted marker', async () => {
      const spawnPromise = runSpawn();
      await flushMicrotasks();

      pausedAgents.set('agent-1', true);
      markHostShuttingDown();
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await flushMicrotasks();
      await spawnPromise;

      expect(consumePausedAgentExit).toHaveBeenCalledWith('agent-1');
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
      expect(activeAgents.has('agent-1')).toBe(false);
      expect(vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.some(
        ([, patch]) => patch?.metadata?.phase === 'interrupted'
      )).toBe(false);
    });

    // The PTY can win the race and report exit 0 after the user killed it.
    // Recording that as a success leaves the task blocked with a "successful"
    // run attached.
    it('user-terminated run that exits 0 finalizes as failure with the terminated error', async () => {
      userTerminatedAgents.add('agent-1');

      const spawnPromise = runSpawn();
      await flushMicrotasks();

      await sessionCallbacks.onExit({ exitCode: 0, killed: true });
      await flushMicrotasks();
      await spawnPromise;

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
        terminatedByUser: true,
        success: false,
        error: 'Agent terminated by user',
      }));
      // Consumed, so a later resume of the same agent id is not misread as a kill.
      expect(userTerminatedAgents.has('agent-1')).toBe(false);
    });

    // pm2's TreeKill took the PTY down with portos-server. The run has no
    // outcome: leave the record `running` for the next boot's orphan sweep.
    it('run interrupted by host shutdown with no sentinel is abandoned without finalizing', async () => {
      const spawnPromise = runSpawn();
      await flushMicrotasks();

      markHostShuttingDown();
      await sessionCallbacks.onExit({ exitCode: 0, killed: false });
      await flushMicrotasks();
      await spawnPromise;

      expect(vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.some(
        ([, patch]) => patch?.metadata?.phase === 'interrupted' && patch?.metadata?.interruptedBy === 'host-shutdown'
      )).toBe(true);
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
      // A restart the operator caused, preserved for resume, is the normal path: info, never warn.
      expect(emitLog).toHaveBeenCalledWith('info', expect.stringContaining('interrupted by a PortOS host restart'), expect.any(Object));
      expect(emitLog).not.toHaveBeenCalledWith('warn', expect.stringContaining('interrupted by a PortOS host restart'), expect.anything());
    });
  });
});
