import {
  SELF_CLEARING_RESUBMIT_INTERVAL_MS,
  OOM_NUDGE_SETTLE_MS,
  OOM_NUDGE_ARM_WINDOW_MS,
  OOM_NUDGE_COOLDOWN_MS,
  CAPACITY_NUDGE_SETTLE_MS,
  CAPACITY_NUDGE_ARM_WINDOW_MS,
  CAPACITY_NUDGE_COOLDOWN_MS,
  STALL_NUDGE_IDLE_MS,
  RETRY_STALL_MS,
  PROMPT_WORK_EVIDENCE_MS,
} from '../../test/fixtures/tuiTiming.js';
import {
  flushMicrotasks,
  sessionCallbacks,
  SESSION_ID,
  defaultTuiConfig,
  runSpawn,
  warnSpy,
  claudeTuiConfig,
  agyTuiConfig,
  CODEX_COMPOSER,
  pasteCount,
  PASTE_OFF,
  PASTE_ON,
  AGY_COMPOSER_FOOTER,
  SIGNAL_POLL_MS,
  installTuiRuntimeHooks,
} from './agentTuiSpawning.test.fixture.js';
import { describe, it, expect, vi } from 'vitest';
import { spawnTuiSessionViaRunner } from '../cos/cosRunnerClient.js';
import * as shellService from '../shell.js';
import * as agentLifecycle from './agentFinalization.js';
import * as cosAgentLifecycle from '../cos/cosAgentLifecycle.js';
import { activeAgents, userTerminatedAgents } from './agentState.js';
import {
  OOM_NUDGE_MAX_ATTEMPTS,
  OOM_NUDGE_TEXT,
  TRUNCATION_NUDGE_MAX_ATTEMPTS,
  TRUNCATION_NUDGE_TEXT,
  CAPACITY_NUDGE_MAX_ATTEMPTS,
  CAPACITY_NUDGE_TEXT,
  STALL_NUDGE_MAX_ATTEMPTS,
  STALL_NUDGE_TEXT,
  TOOL_PERMISSION_NUDGE_TEXT,
} from '../../lib/tuiHandshake.js';

describe('spawnTuiAgent runtime', () => {
  installTuiRuntimeHooks();

  // ── Antigravity account-eligibility banner: a WAIT, not a verdict ───────────
  // The banner paints while agy's `loadCodeAssist` handshake is still retrying;
  // the CLI's own log shows the session authenticated fine and generating
  // normally once it settles. Killing on sight cost every agy CoS run from
  // 2026-08-07 on (5/5, each dead 3–5s in). So the signal now arms a
  // grace window (the signal's own `graceMs`) instead of finalizing immediately.
  const ELIGIBILITY_BANNER =
    "We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly.";

  // Drive agy to a submitted prompt, which is where the banner really appears
  // (agent-09824620: composer up, paste lands, THEN the banner paints). Starting
  // from a bare spawn instead would let the 45s tui-not-ready deadline finalize
  // the run before the grace window is ever reached, masking what's under test.
  const driveAgyToSubmittedPrompt = async () => {
    runSpawn({ tuiConfig: agyTuiConfig });
    await flushMicrotasks();
    // Shell turns paste mode off to run the command, agy turns it back on at
    // alt-screen entry, then its composer footer says the input box is live.
    await sessionCallbacks.onData(Buffer.from(`${PASTE_OFF}Antigravity CLI 1.1.12\n`));
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from(`${PASTE_ON}Welcome to the Antigravity CLI.\n Signing in...\n`));
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from(`>\n${AGY_COMPOSER_FOOTER}Gemini 3.6 Flash · high`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
    // Echo the prompt back the way a real TUI renders it into the input buffer,
    // so paste verification passes and the submit Enter goes out (issue #2192).
    await sessionCallbacks.onData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(4000); // past PASTE_TO_ENTER_FALLBACK_MS (3500ms)
    await flushMicrotasks();
  };

  it('holds the session open when Antigravity reports that account eligibility is still being verified', async () => {
    await driveAgyToSubmittedPrompt();

    await sessionCallbacks.onData(Buffer.from(ELIGIBILITY_BANNER));
    await flushMicrotasks();
    // The old behavior finalized here, within a second of the banner.
    await vi.advanceTimersByTimeAsync(30000);
    await flushMicrotasks();

    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  // The banner is the REJECTION of the submission — agy discards the prompt and
  // drops back to an empty, idle composer (agent-1f08178b's raw.txt, and a live
  // session confirmed parked there). Nothing is in flight, so a PASSIVE window
  // can never see the generation chrome it waits for: its only reachable outcome
  // is expiry, making it a pause bolted in front of the same fail-over. Re-asking
  // is the only way out, and what the banner itself instructs.
  it('re-submits the prompt while the eligibility window is open, and stops once agy answers', async () => {
    await driveAgyToSubmittedPrompt();

    await sessionCallbacks.onData(Buffer.from(ELIGIBILITY_BANNER));
    await sessionCallbacks.onData(Buffer.from('> ? for shortcuts'));
    await flushMicrotasks();
    expect(shellService.pasteToSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SELF_CLEARING_RESUBMIT_INTERVAL_MS + 5000);
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledWith(
      SESSION_ID,
      'do the thing',
      expect.objectContaining({ label: expect.stringContaining('handshake') }),
    );

    // The retry lands: agy paints its in-flight chrome, which closes the window
    // and must stop the re-asking too.
    await sessionCallbacks.onData(Buffer.from('Generating...\nesc to cancel'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3 * SELF_CLEARING_RESUBMIT_INTERVAL_MS);
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
    // The run belongs to the ordinary reaper again, not to the fail-over.
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalledWith(
      expect.objectContaining({ completionReason: 'fallback-signal' })
    );
  });

  it('resumes the run when the eligibility banner clears and agy starts generating', async () => {
    await driveAgyToSubmittedPrompt();

    await sessionCallbacks.onData(Buffer.from(ELIGIBILITY_BANNER));
    await flushMicrotasks();
    // agy settles its handshake and paints its in-flight chrome.
    await sessionCallbacks.onData(Buffer.from('Generating...\nesc to cancel'));
    await flushMicrotasks();

    // Past the grace deadline — the run must NOT be failed over to a fallback.
    await vi.advanceTimersByTimeAsync(70000);
    await flushMicrotasks();

    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalledWith(
      expect.objectContaining({ completionReason: 'fallback-signal' })
    );
  });

  it('falls back once the eligibility banner outlasts its grace window with no generation', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    await driveAgyToSubmittedPrompt();

    await sessionCallbacks.onData(Buffer.from(ELIGIBILITY_BANNER));
    await flushMicrotasks();
    // Only idle composer chrome repaints — no sign of life.
    await sessionCallbacks.onData(Buffer.from('> ? for shortcuts'));
    await flushMicrotasks();

    // Past the full grace window — every re-submission inside it went unanswered
    // too, so the fail-over is the correct verdict.
    await vi.advanceTimersByTimeAsync(130000);
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        completionReason: 'fallback-signal',
        error: expect.stringContaining('account eligibility')
      })
    );
  });

  // ── Local-runtime GPU OOM: a nudge, not a verdict ──────────────────────────
  // MLX/MTPLX kills a turn the server had already accepted, so unlike agy's
  // banner the session still holds the whole conversation and the prompt must
  // NOT be re-sent — a one-word `continue` resumes it, which is exactly what a
  // human typed to rescue agent-011d0c27 on 2026-08-22.
  const OOM_BOX = '│  {"message":"[METAL] Command buffer execution failed: Insufficient Memory\n'
    + '│  (00000008: kIOGPUCommandBufferCallbackErrorOutOfMemory).","type":"server_error"}';

  // Long enough for the arm's silence test AND the 5s provider-signal poll that
  // acts on it.
  const PAST_SETTLE_MS = OOM_NUDGE_SETTLE_MS + 10000;

  it('nudges a session a local-GPU OOM left parked, without re-sending the prompt', async () => {
    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    await sessionCallbacks.onData(Buffer.from(OOM_BOX));
    await flushMicrotasks();
    // The error box is still repainting — nudging into that lands on chrome,
    // not on an idle composer.
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();
    expect(shellService.pasteToSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS);
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledWith(
      SESSION_ID,
      OOM_NUDGE_TEXT,
      expect.objectContaining({ label: expect.stringContaining('OOM') }),
    );
    // Exactly one nudge, and the run is left alone to carry on.
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  it('leaves a session that kept working after the OOM alone', async () => {
    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    await sessionCallbacks.onData(Buffer.from(OOM_BOX));
    await flushMicrotasks();
    // The TUI never goes quiet — it recovered on its own — so the arm has to
    // expire rather than wait around to fire into the next quiet stretch.
    for (let elapsed = 0; elapsed <= OOM_NUDGE_ARM_WINDOW_MS; elapsed += 5000) {
      await sessionCallbacks.onData(Buffer.from('still working\n'));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5000);
      await flushMicrotasks();
    }
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS);
    await flushMicrotasks();

    expect(shellService.pasteToSession).not.toHaveBeenCalled();
  });

  it('falls back once the OOM outlasts every nudge', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    for (let i = 0; i < OOM_NUDGE_MAX_ATTEMPTS; i += 1) {
      await sessionCallbacks.onData(Buffer.from(OOM_BOX));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS);
      await flushMicrotasks();
      // Clear the dedupe cooldown so the next box reads as a NEW OOM rather
      // than a repaint of the one just nudged.
      await vi.advanceTimersByTimeAsync(OOM_NUDGE_COOLDOWN_MS);
      await flushMicrotasks();
    }
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(OOM_NUDGE_MAX_ATTEMPTS);

    // The budget is spent and it OOM'd again: the conversation no longer fits
    // this device, so the task goes to a fallback provider.
    await sessionCallbacks.onData(Buffer.from(OOM_BOX));
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        completionReason: 'fallback-signal',
        error: expect.stringContaining('GPU memory'),
      })
    );
  });

  // ── Truncated response: a nudge, not a verdict ─────────────────────────────
  // pi's TUI halts the whole session on `Response was truncated before
  // completion.` — the turn is dead, the session holds the whole conversation,
  // and the only resume is somebody typing `continue` and pressing Enter.
  // Unattended, nothing ever does. Same shape as the OOM gate above, so the
  // same three behaviors are pinned: nudge without re-sending the prompt,
  // leave a session that carried on alone, fail over once the truncations
  // outlast every nudge.
  const TRUNCATION_BANNER = 'Response was truncated before completion.';

  it('nudges a session a truncated response halted, without re-sending the prompt', async () => {
    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    await sessionCallbacks.onData(Buffer.from(TRUNCATION_BANNER));
    await flushMicrotasks();
    // The banner is still repainting — nudging into that lands on chrome,
    // not on an idle composer.
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();
    expect(shellService.pasteToSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS);
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledWith(
      SESSION_ID,
      TRUNCATION_NUDGE_TEXT,
      expect.objectContaining({ label: expect.stringContaining('truncated-response') }),
    );
    // Exactly one nudge, and the run is left alone to carry on.
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  it('leaves a session that kept working after the truncation alone', async () => {
    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    await sessionCallbacks.onData(Buffer.from(TRUNCATION_BANNER));
    await flushMicrotasks();
    // The TUI never goes quiet — it recovered on its own — so the arm has to
    // expire rather than wait around to fire into the next quiet stretch.
    for (let elapsed = 0; elapsed <= OOM_NUDGE_ARM_WINDOW_MS; elapsed += 5000) {
      await sessionCallbacks.onData(Buffer.from('still working\n'));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5000);
      await flushMicrotasks();
    }
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS);
    await flushMicrotasks();

    expect(shellService.pasteToSession).not.toHaveBeenCalled();
  });

  it('falls back once the truncations outlast every nudge', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    for (let i = 0; i < TRUNCATION_NUDGE_MAX_ATTEMPTS; i += 1) {
      await sessionCallbacks.onData(Buffer.from(TRUNCATION_BANNER));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS);
      await flushMicrotasks();
      // Clear the dedupe cooldown so the next banner reads as a NEW truncation
      // rather than a repaint of the one just nudged.
      await vi.advanceTimersByTimeAsync(OOM_NUDGE_COOLDOWN_MS);
      await flushMicrotasks();
    }
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(TRUNCATION_NUDGE_MAX_ATTEMPTS);

    // The budget is spent and it truncated again: this provider is not going
    // to finish the response, so the task goes to a fallback provider.
    await sessionCallbacks.onData(Buffer.from(TRUNCATION_BANNER));
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        completionReason: 'fallback-signal',
        error: expect.stringContaining('cut the response off'),
      })
    );
  });

  // ── Model at capacity: a nudge after a long quiet, then fail over ──────────
  // Codex halts the turn on `Selected model is at capacity.` and waits at the
  // composer. Provider load clears in minutes, so the settle window is far
  // longer than the OOM one; the same three behaviors are pinned.
  const CAPACITY_BANNER = 'Selected model is at capacity. Please try a different model.';

  const PAST_CAPACITY_SETTLE_MS = CAPACITY_NUDGE_SETTLE_MS + 10000;

  it('nudges a session a model-at-capacity rejection parked, without re-sending the prompt', async () => {
    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    await sessionCallbacks.onData(Buffer.from(CAPACITY_BANNER));
    await flushMicrotasks();
    // Well past the OOM settle window, still inside the capacity one.
    await vi.advanceTimersByTimeAsync(OOM_NUDGE_SETTLE_MS + 10000);
    await flushMicrotasks();
    expect(shellService.pasteToSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAST_CAPACITY_SETTLE_MS);
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledWith(
      SESSION_ID,
      CAPACITY_NUDGE_TEXT,
      expect.objectContaining({ label: expect.stringContaining('model-capacity') }),
    );
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  it('leaves a session that kept working after the capacity rejection alone', async () => {
    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    await sessionCallbacks.onData(Buffer.from(CAPACITY_BANNER));
    await flushMicrotasks();
    for (let elapsed = 0; elapsed <= CAPACITY_NUDGE_ARM_WINDOW_MS; elapsed += 5000) {
      await sessionCallbacks.onData(Buffer.from('still working\n'));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5000);
      await flushMicrotasks();
    }
    await vi.advanceTimersByTimeAsync(PAST_CAPACITY_SETTLE_MS);
    await flushMicrotasks();

    expect(shellService.pasteToSession).not.toHaveBeenCalled();
  });

  it('falls back once the capacity rejections outlast every nudge', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    for (let i = 0; i < CAPACITY_NUDGE_MAX_ATTEMPTS; i += 1) {
      await sessionCallbacks.onData(Buffer.from(CAPACITY_BANNER));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(PAST_CAPACITY_SETTLE_MS);
      await flushMicrotasks();
      // Clear the dedupe cooldown so the next banner reads as a NEW rejection.
      await vi.advanceTimersByTimeAsync(CAPACITY_NUDGE_COOLDOWN_MS);
      await flushMicrotasks();
    }
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(CAPACITY_NUDGE_MAX_ATTEMPTS);

    await sessionCallbacks.onData(Buffer.from(CAPACITY_BANNER));
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        completionReason: 'fallback-signal',
      })
    );
  });

  // ── Retry stall: the provider keeps failing the same request ───────────────
  // agent-e057cca7 (2026-09-04): a Stage 3 prefill the harness cancelled every
  // ~6 minutes and re-sent verbatim. The screen repaints on every attempt, so
  // every reaper saw a busy session and the run held its lane until the
  // max-runtime ceiling.
  it('fails over a session whose retry banner keeps advancing past the stall window', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    await driveAgyToSubmittedPrompt();

    const retryCycleMs = RETRY_STALL_MS / 2 + 60_000;
    for (const attempt of [1, 2]) {
      await sessionCallbacks.onData(Buffer.from(`API error · Retrying in 0s · attempt ${attempt}/10\n`));
      await flushMicrotasks();
      // The retried request is in flight: the title bar flickers, nothing else
      // paints. Two attempts alone are not a verdict, however long they span.
      await vi.advanceTimersByTimeAsync(retryCycleMs);
      await flushMicrotasks();
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
    }

    await sessionCallbacks.onData(Buffer.from('API error · Retrying in 0s · attempt 3/10\n'));
    await flushMicrotasks();
    // Acted on by the 5s provider-signal poll, like the other gates.
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        completionReason: 'fallback-signal',
        error: expect.stringContaining('retried it 3 times'),
      })
    );
  });

  // ── Tool-permission dialog: decline, then nudge ───────────────────────────
  // agent-e057cca7 (2026-09-04): under the sandboxed acceptEdits recipe a local
  // model asked to Read an absolute path outside the worktree, and the dialog
  // sat unanswered for the rest of the run.
  it('declines a tool-permission dialog and nudges the session once it goes quiet', async () => {
    // A claude session: the dialog is Claude Code chrome, and the spawner only
    // watches claude sessions for it.
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from(`${PASTE_OFF}Claude Code v2.1.260\n`));
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
    await sessionCallbacks.onData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(4000);
    await flushMicrotasks();
    vi.mocked(shellService.writeToSession).mockClear();
    vi.mocked(shellService.pasteToSession).mockClear();

    await sessionCallbacks.onData(Buffer.from(' Read(/data.reference/providers.json) Doyouwanttoproceed? ❯1. Yes 2. Yes,allowreadingfrom/data.referenceduringthissession 3. No Esc to cancel · Tab to amend '));
    await flushMicrotasks();
    // Option 1 is highlighted; "No" is option 3: down, down, Enter.
    expect(shellService.writeToSession).toHaveBeenCalledWith(SESSION_ID, '\x1b[B\x1b[B\r');

    // The decline ends the turn; once the session is quiet the nudge goes out.
    await vi.advanceTimersByTimeAsync(OOM_NUDGE_SETTLE_MS + 10000);
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledWith(
      SESSION_ID,
      TOOL_PERMISSION_NUDGE_TEXT,
      expect.objectContaining({ label: expect.stringContaining('permission') }),
    );
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  it.each([
    { maxCostUsd: 'unlimited', timeLimitSeconds: 'unlimited', nudges: false },
    { maxCostUsd: 2, timeLimitSeconds: 180, nudges: true },
  ])('honors a trusted $timeLimitSeconds scanner grant through a quiet outer audit', async ({ nudges, ...limits }) => {
    runSpawn({ securityScanGrant: { model: 'example-model', effort: 'medium', auth: 'chatgpt', ...limits } });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('Codex booting...\n' + CODEX_COMPOSER));
    await vi.advanceTimersByTimeAsync(2000);
    expect(pasteCount()).toBe(1);
    await sessionCallbacks.onData(Buffer.from('do the thing\n'));
    await vi.advanceTimersByTimeAsync(4000);
    // Both scanner work and the later source/fix/test phase can be silent.
    await sessionCallbacks.onData(Buffer.from('Reviewing source and validating fixes.\n'));
    vi.mocked(shellService.pasteToSession).mockClear();
    vi.mocked(shellService.writeToSession).mockClear();
    await vi.advanceTimersByTimeAsync(nudges ? STALL_NUDGE_IDLE_MS + SIGNAL_POLL_MS : 2 * 60 * 60 * 1000);
    if (nudges) {
      expect(shellService.pasteToSession).toHaveBeenCalledWith(SESSION_ID, STALL_NUDGE_TEXT, expect.anything());
    } else {
      expect(shellService.pasteToSession).not.toHaveBeenCalled();
      expect(shellService.writeToSession).not.toHaveBeenCalled();
      expect(cosAgentLifecycle.updateAgent).not.toHaveBeenCalledWith('agent-1', { metadata: { phase: 'stalled' } });
    }
    expect(shellService.killSession).not.toHaveBeenCalled();
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
    await sessionCallbacks.onExit({ exitCode: 1, killed: false });
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledOnce();
  });

  // A schedule can turn the stall nudge off (taskMetadata.stallNudge: false) for a
  // task whose long quiet stretch is a wait it owns. do-release ships that way:
  // agent-0f4189d3 parked on its release PR's background CI watch, took the nudge
  // as "wrap up" and wrote INCOMPLETE with the PR still open.
  it.each([
    { stallNudge: false, nudges: false },
    { stallNudge: 'false', nudges: false },
    { stallNudge: true, nudges: true },
    { stallNudge: undefined, nudges: true },
  ])('honors taskMetadata.stallNudge=$stallNudge once the prompt has started a turn', async ({ stallNudge, nudges }) => {
    runSpawn({ task: { id: 'task-1', description: 'do the thing', metadata: stallNudge === undefined ? {} : { stallNudge } } });
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('Codex booting...\n' + CODEX_COMPOSER));
    await vi.advanceTimersByTimeAsync(2000);
    expect(pasteCount()).toBe(1);
    await sessionCallbacks.onData(Buffer.from('do the thing\n'));
    await vi.advanceTimersByTimeAsync(4000);
    // Output well after the submit is the run's own work, not an echo — the
    // prompt has started a turn, which is when the opt-out takes over.
    await vi.advanceTimersByTimeAsync(PROMPT_WORK_EVIDENCE_MS);
    await sessionCallbacks.onData(Buffer.from('Opened the release PR; waiting on its CI in the background.\n'));
    vi.mocked(shellService.pasteToSession).mockClear();
    await vi.advanceTimersByTimeAsync(nudges ? STALL_NUDGE_IDLE_MS + SIGNAL_POLL_MS : 2 * 60 * 60 * 1000);
    if (nudges) {
      expect(shellService.pasteToSession).toHaveBeenCalledWith(SESSION_ID, STALL_NUDGE_TEXT, expect.anything());
    } else {
      expect(shellService.pasteToSession).not.toHaveBeenCalled();
      expect(cosAgentLifecycle.updateAgent).not.toHaveBeenCalledWith('agent-1', { metadata: { phase: 'stalled' } });
    }
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  // ── Stalled session: the turn just ended, with the task unfinished ─────────
  // agent-bb3061af (2026-09-17): the run finished its /simplify pass, printed
  // "Next: /do:pr", ended its turn and sat at an idle composer. Nothing was on
  // screen for a detector to match and — since the wall-clock ceiling was
  // removed — nothing would ever have touched it again. A human opened the Shell
  // tab and typed "continue", and it finished.
  it('dispatches bounded completion and issue-disposition guidance to a stalled session', async () => {
    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    // A short lull is ordinary: a slow tool call paints nothing.
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_IDLE_MS - 60_000);
    await flushMicrotasks();
    expect(shellService.pasteToSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000 + SIGNAL_POLL_MS);
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringContaining('Continue the task from where you stopped.'),
      expect.objectContaining({ label: expect.stringContaining("stalled") }),
    );
    // Assert what the recovery boundary actually sends, independently of the
    // shared constant, so reverting it to a generic "continue" is caught here.
    const recoveryText = vi.mocked(shellService.pasteToSession).mock.calls[0][1];
    // A session parked on its own background CI watch must keep driving it,
    // not read the nudge as permission to write INCOMPLETE and quit.
    expect(recoveryText).toContain('a pending or failed check is a step to handle, not a reason to stop');
    expect(recoveryText).toContain('Write the completion sentinel once the task is done');
    expect(recoveryText).not.toContain('Finish what you can');
    expect(recoveryText).toContain('File GitHub issues for anything that is too big for this session.');
    expect(recoveryText).toContain('original task scope, permissions, and safety limits');
    expect(recoveryText).toContain('do not bypass a refusal or permission block');
    expect(recoveryText).toContain('owning repository\'s issue-filing instructions');
    expect(recoveryText).toContain('search for duplicates and reuse an existing issue');
    expect(recoveryText).toContain('redacted evidence, affected paths, a chosen next step, and acceptance criteria');
    expect(recoveryText).toContain('If issue filing is not authorized, unavailable, or fails');
    expect(recoveryText).toContain('report the filing blocker and ready-to-file details as an INCOMPLETE disposition');
    expect(recoveryText).toContain('do not claim it was filed');
    expect(recoveryText).toContain('exact sentinel path and format from your existing completion instructions');
    expect(recoveryText).toContain('writing the sentinel does not itself mean the task succeeded');
    // A nudge, never a verdict: the run carries on.
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  it("leaves a working session alone however long the run lasts", async () => {
    await driveAgyToSubmittedPrompt();
    vi.mocked(shellService.pasteToSession).mockClear();

    // Claude Code repaints its working counter about once a second for as long
    // as any call is in flight. A run that keeps printing is never nudged.
    for (let elapsed = 0; elapsed < STALL_NUDGE_IDLE_MS + 60_000; elapsed += 60_000) {
      await sessionCallbacks.onData(Buffer.from("· Thinking… (42s · esc to interrupt)\n"));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();
    }
    expect(shellService.pasteToSession).not.toHaveBeenCalled();
  });

  it("badges a session that ignored every nudge instead of giving up silently", async () => {
    await driveAgyToSubmittedPrompt();
    // A run that worked and then stopped; one that never started is failed
    // instead (see the never-started case below).
    await vi.advanceTimersByTimeAsync(PROMPT_WORK_EVIDENCE_MS);
    await sessionCallbacks.onData(Buffer.from('Reading the repository…\n'));
    await flushMicrotasks();
    vi.mocked(shellService.pasteToSession).mockClear();

    // A session wedged below its composer never echoes the paste, so nothing
    // rewinds the idle clock — the budget is the only thing that stops it.
    // One window per nudge, plus one for the exhaustion verdict — and a spare,
    // because each nudge lands on the first 5s tick AFTER its threshold, so the
    // windows drift later as they stack.
    await vi.advanceTimersByTimeAsync(STALL_NUDGE_IDLE_MS * (STALL_NUDGE_MAX_ATTEMPTS + 2));
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(STALL_NUDGE_MAX_ATTEMPTS);
    // There is no runtime ceiling left to reap it, so the run keeps its lane —
    // which is only tolerable because the card now says it needs a human.
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
    expect(cosAgentLifecycle.updateAgent).toHaveBeenCalledWith(
      'agent-1',
      { metadata: { phase: 'stalled' } },
    );
  });

  // ── 2. Command-not-found path ────────────────────────────────────────────────
  it('command-not-found: finalizeAgent called with success:false, exitCode 127, completionReason=command-not-found', async () => {
    const spawnPromise = runSpawn();
    await flushMicrotasks();

    // Feed "command not found" output BEFORE the prompt timer fires (promptSentAt === null).
    // commandName is derived from tuiConfig.command = 'codex' via .split('/').pop().
    await sessionCallbacks.onData(Buffer.from('bash: codex: command not found\n'));
    await flushMicrotasks();

    await spawnPromise;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        exitCode: 127,
        completionReason: 'command-not-found',
      })
    );
  });

  // A credential-bootstrap provider types `token-cli run codex …` into the
  // login shell, so the shell's "command not found" names the BOOTSTRAP binary.
  // Keying the probe on the harness (`tuiConfig.command`) would miss it and the
  // run would hang to the wall-clock backstop instead of exiting 127.
  it('command-not-found: detects a missing credential-bootstrap binary by the spawned command, not the harness', async () => {
    const spawnPromise = runSpawn({
      tuiConfig: { ...defaultTuiConfig, spawnCommand: 'token-cli', spawnArgs: ['run', 'codex'], commandLine: 'token-cli run codex' },
    });
    await flushMicrotasks();

    await sessionCallbacks.onData(Buffer.from('zsh: command not found: token-cli\n'));
    await flushMicrotasks();

    await spawnPromise;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        exitCode: 127,
        completionReason: 'command-not-found',
        error: 'TUI command not found: token-cli',
      })
    );
  });

  // ── 3. Shell-exit path with non-zero exit code ───────────────────────────────
  it('shell-exit: finalizeAgent called with success:false and exitCode 1 when shell exits non-zero', async () => {
    const spawnPromise = runSpawn();
    await flushMicrotasks();

    await sessionCallbacks.onExit({ exitCode: 1, killed: false });
    await flushMicrotasks();

    await spawnPromise;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        exitCode: 1,
        completionReason: 'shell-exit',
      })
    );
  });

  it('spools the runner exit tail when an immediate exit beat live TUI output', async () => {
    const { appendFile } = await import('fs/promises');
    const spawnPromise = runSpawn({ useDurableRunner: true });
    await flushMicrotasks();

    await sessionCallbacks.onExit({
      exitCode: 1,
      killed: false,
      outputTail: 'OpenCode startup error: configured model is unavailable',
    });
    await flushMicrotasks();
    await spawnPromise;

    const rawTail = vi.mocked(appendFile).mock.calls.find(
      ([path, contents]) => typeof path === 'string' && path.endsWith('raw.txt') && String(contents).includes('OpenCode startup error'),
    );
    expect(rawTail).toBeDefined();
  });

  it('does not revive an agent when the durable runner exits before its spawn response', async () => {
    let resolveRunnerSession;
    let exitPromise;
    const session = {
      sessionId: SESSION_ID,
      pid: 4321,
      ptyProcess: { pid: 4321, kill: vi.fn() },
    };
    vi.mocked(spawnTuiSessionViaRunner).mockImplementationOnce((options) => {
      sessionCallbacks.onData = options.onData;
      sessionCallbacks.onExit = options.onExit;
      // The socket relay registers this callback before its POST resolves, so
      // a CLI that exits immediately can finalize while the response is held.
      exitPromise = options.onExit({ exitCode: 1, killed: false, outputTail: 'startup failed' });
      return new Promise((resolve) => { resolveRunnerSession = resolve; });
    });

    const spawnPromise = runSpawn({ useDurableRunner: true });
    await flushMicrotasks();
    resolveRunnerSession(session);

    await spawnPromise;
    await exitPromise;

    expect(activeAgents.has('agent-1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(shellService.registerExternalSession, 'a PTY that already exited is not registered').not.toHaveBeenCalled();
    expect(cosAgentLifecycle.updateAgent).not.toHaveBeenCalled();
  });

  // ── 4. Killed / user-terminated path ────────────────────────────────────────
  it('user-terminated: finalizeAgent receives terminatedByUser:true + error=Agent terminated by user', async () => {
    // Mark agent as user-terminated before the exit fires
    userTerminatedAgents.add('agent-1');

    const spawnPromise = runSpawn();
    await flushMicrotasks();

    await sessionCallbacks.onExit({ exitCode: 0, killed: true });
    await flushMicrotasks();

    await spawnPromise;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        terminatedByUser: true,
        error: 'Agent terminated by user',
      })
    );
  });

  // ── 5. Spawn-error path (createShellSession returns null) ────────────────────
  it('spawn-error: function returns null and finalizeAgent reports spawn-error when session creation fails', async () => {
    vi.mocked(shellService.createShellSession).mockReturnValue(null);

    const result = await runSpawn();

    expect(result).toBeNull();
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        error: 'Failed to create TUI shell session',
        completionReason: 'spawn-error',
      })
    );
  });

  // ── 6. Raw PTY stream spools to disk (no in-memory cap, no in-memory warn) ─
  // Raw chunks are written to raw.txt via the debounced flush pipeline so
  // memory stays bounded regardless of run length. analyzeAgentFailure
  // reads the file on failure. No "raw PTY buffer exceeded" warn and no
  // rawBufferTruncated metadata flag — those were signals of the OLD
  // in-memory cap. Disk-side truncation has its own warn / flag covered
  // separately by test 8b.
  it('raw PTY bytes spool to raw.txt without the old in-memory truncation signals', async () => {
    const { appendFile } = await import('fs/promises');
    runSpawn();
    await flushMicrotasks();

    // Small chunks that stay under the mocked 100-byte raw-spool cap so this
    // test exercises the normal appendFile path. The disk-safety-valve path
    // (writeFile when over cap) is covered by test 8b.
    await sessionCallbacks.onData(Buffer.from('hello '));
    await flushMicrotasks();
    await sessionCallbacks.onData(Buffer.from('world\n'));
    await flushMicrotasks();

    // Fire the one-second debounced raw flush.
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const inMemTruncWarns = warnSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('raw PTY buffer exceeded')
    );
    expect(inMemTruncWarns).toHaveLength(0);

    const inMemTruncMetaCalls = vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.filter(
      ([_id, payload]) => payload?.metadata?.rawBufferTruncated === true
    );
    expect(inMemTruncMetaCalls).toHaveLength(0);

    // raw.txt got the chunks via the batched appendFile flush.
    const rawAppendCalls = vi.mocked(appendFile).mock.calls.filter(
      ([path]) => typeof path === 'string' && path.endsWith('raw.txt')
    );
    expect(rawAppendCalls.length).toBeGreaterThan(0);
  });

  // ── 7. Output-buffer truncation warning + metadata flag ─────────────────────
  // outputBuffer is filled via appendLine, which fires on initial spawn
  // (session-started + open-shell-tab) plus the prompt-pasted notice. With
  // the mocked 1-byte HEADROOM the first spawn line trips the cap, so the
  // wiring is exercised on every spawn — but only ONCE per run regardless
  // of how many subsequent lines arrive.
  it('outputBuffer overflow: warns once and writes outputBufferTruncated:true to agent metadata', async () => {
    runSpawn();
    await flushMicrotasks();

    const truncWarns = warnSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('parsed-output buffer exceeded')
    );
    expect(truncWarns).toHaveLength(1);

    const truncMetaCalls = vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.filter(
      ([_id, payload]) => payload?.metadata?.outputBufferTruncated === true
    );
    expect(truncMetaCalls).toHaveLength(1);
    expect(truncMetaCalls[0][0]).toBe('agent-1');
  });

  // ── 8. Failure-path tail-read of raw.txt ────────────────────────────────────
  // analyzeAgentFailure needs the recent PTY tail; finalize MUST read it from
  // raw.txt via readFileTail (NOT readFile, which would load the whole spool).
  // This test wires stat to report a >1MB spool and asserts the tail-read
  // pattern: stat → open → read at offset (size - RAW_TAIL_ANALYSIS_BYTES).
  it('failure finalize: reads only the tail of raw.txt for analyzeAgentFailure', async () => {
    const fsPromises = await import('fs/promises');
    const RAW_TAIL_BYTES = 1024 * 1024;
    const SPOOL_SIZE = 5 * 1024 * 1024;   // 5MB on disk

    vi.mocked(fsPromises.stat).mockResolvedValueOnce({ size: SPOOL_SIZE });
    const readMock = vi.fn().mockResolvedValue({ bytesRead: RAW_TAIL_BYTES });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fsPromises.open).mockResolvedValueOnce({ read: readMock, close: closeMock });

    const spawnPromise = runSpawn();
    await flushMicrotasks();

    // Trigger a failure finalize via the shell-exit path.
    await sessionCallbacks.onExit({ exitCode: 1, killed: false });
    await flushMicrotasks();
    await spawnPromise;

    const statCalls = vi.mocked(fsPromises.stat).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(statCalls.length).toBeGreaterThan(0);

    const openCalls = vi.mocked(fsPromises.open).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(openCalls.length).toBeGreaterThan(0);

    // read() must be called with offset = size - tailBytes (5MB - 1MB = 4MB)
    // so analyzeAgentFailure sees only the most-recent 1MB, not the full spool.
    expect(readMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      RAW_TAIL_BYTES,
      SPOOL_SIZE - RAW_TAIL_BYTES
    );
    expect(closeMock).toHaveBeenCalled();
  });

  // ── 8b. Disk safety valve ───────────────────────────────────────────────────
  // The raw spool truncates rather than appends once it crosses
  // RAW_SPOOL_MAX_BYTES so a runaway agent can't fill the volume. The mock
  // above shrinks the cap to 100 bytes so we can trip it with two ~80-byte
  // chunks instead of pushing hundreds of MB through the spawner. The wiring
  // under test (Buffer.byteLength count, writeFile vs appendFile dispatch,
  // once-per-run warn + metadata flag) is identical at any cap.
  it('raw spool: truncates instead of appending once it crosses the cap', async () => {
    const fsPromises = await import('fs/promises');
    runSpawn();
    await flushMicrotasks();

    // First chunk (80 bytes) fits under the 100-byte cap → appendFile.
    await sessionCallbacks.onData(Buffer.alloc(80, 0x61));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // Second chunk (80 bytes) would push total to 160 > 100 → writeFile.
    await sessionCallbacks.onData(Buffer.alloc(80, 0x62));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const writeFileRawCalls = vi.mocked(fsPromises.writeFile).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(writeFileRawCalls.length).toBeGreaterThan(0);

    const truncWarns = warnSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('raw PTY spool reached')
    );
    expect(truncWarns).toHaveLength(1);

    const truncMetaCalls = vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.filter(
      ([_id, payload]) => payload?.metadata?.rawSpoolTruncated === true
    );
    expect(truncMetaCalls).toHaveLength(1);
    expect(truncMetaCalls[0][0]).toBe('agent-1');
  });
});
