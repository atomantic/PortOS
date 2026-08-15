/**
 * Agent TUI Spawning
 *
 * Runs CoS agents inside an interactive PTY-backed shell session. This is for
 * providers whose useful interface is a terminal UI rather than a headless CLI
 * or HTTP API.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import * as shellService from './shell.js';
import { emitLog } from './cosEvents.js';
import { updateAgent } from './cosAgentLifecycle.js';
import { createOutputSpooler } from './agentTuiSpawning/outputSpooler.js';
import { captureWorktreeDiff, worktreeHasWorkEvidence, resolveErrorAnalysis } from './agentTuiSpawning/finalizeHelpers.js';
import { finalizeAgent, releaseAgentLane } from './agentFinalization.js';
import { activeAgents, userTerminatedAgents, pausedAgents, isFalsyMeta, registerSpawnedAgent, unregisterSpawnedAgent } from './agentState.js';
import { isProgrammaticIoTaskType, resolveTaskHookType } from './taskTypeHooks.js';
import { PATHS } from '../lib/fileUtils.js';
import { doneSentinelName, doneSentinelPath as resolveDoneSentinelPath, parseSentinelPayload } from '../lib/agentSentinel.js';
import { shouldAbandonForHostShutdown, HOST_SHUTDOWN_REASON } from '../lib/hostShutdown.js';
import { SENTINEL_COMPLETION_MARKER } from '../lib/agentOutputMarkers.js';
import { PR_CREATION, prClaimWasVerified, resolvePrCompletion, resolvePrCreation } from '../lib/prDisposition.js';
import { canTypeSlashCommands, agentOwnsPrWorkflow } from '../lib/slashdoInvocation.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { normalizeReviewers } from '../lib/validation.js';
import * as git from './git.js';
import { resolveReviewLoopOptions } from './codeReview.js';
import { spawnTuiSessionViaRunner } from './cosRunnerClient.js';
import { shellQuote } from '../lib/shellQuote.js';
import { isClaudeCommand, applyLeanClaudeArgs, providerSuppliesGithubToken } from '../lib/providerModels.js';
import { createStreamingAnsiStripper, stripAnsi } from '../lib/ansiStrip.js';
import { createImmediateFallbackSignalDetector } from '../lib/aiToolkit/errorDetection.js';
import { isMachineOnline } from '../lib/connectivity.js';
import { isAntigravityCommand } from '../lib/antigravity.js';
import { detectForgeCli } from '../lib/gitForge.js';
import {
  DEFAULT_TUI_PROMPT_DELAY_MS,
  DEFAULT_TUI_IDLE_TIMEOUT_MS,
  DEFAULT_TUI_MAX_RUNTIME_MS,
  MAX_RUNTIME_WRAP_UP_GRACE_MS,
  buildWrapUpProdMessage,
  MERGE_QUEUE_IDLE_TIMEOUT_MS,
  REVIEW_LOOP_IDLE_TIMEOUT_MS,
  BACKGROUND_SHELL_IDLE_TIMEOUT_MS,
  decideIdleReap,
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  PASTE_MARKER_POLL_MS,
  countPasteMarkers,
  createWorkActivityTracker,
  createSelfClearingSignalGate,
  createMergeQueueTracker,
  createReviewLoopTracker,
  createBackgroundShellTracker,
  createMcpBootTracker,
  MCP_BOOT_PASTE_DEADLINE_MS,
  MCP_BOOT_PASTE_RETRY_DELAY_MS,
  createInputReadyTracker,
  AGY_INPUT_READY_PATTERN,
  rendersWorkCounter,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  scheduleSubmitEnters,
  PASTE_DEADLINE_MS,
  TUI_INPUT_READY_DEADLINE_MS,
  inferTuiCommand,
  applyCommandDefaults,
  PASTE_VERIFY_POLL_MS,
  PASTE_VERIFY_WINDOW_MS,
  PASTE_RETRY_MAX_ATTEMPTS,
  PASTE_RETRY_BASE_DELAY_MS,
  extractVerifiablePromptPrefix,
  isPasteConfirmed,
} from '../lib/tuiHandshake.js';
import { injectTuiModelAndEffort } from '../lib/providerVendors.js';
import { agentGuardEnv } from '../lib/agentGuard/index.js';
import { composeProviderEnv } from '../lib/cliChildEnv.js';
import { execFile } from '../lib/childProcess.js';

// Agent-specific timing/lifecycle constants (not shared with the one-shot
// runner — agents stay alive much longer and write a sentinel file when done).
const DEFAULT_TUI_MIN_RUNTIME_MS = 15000;
// Grace window after the last input written to the session (human paste via
// the Shell page, or our own auto-paste) before the idle reaper is allowed to
// fire again. Covers a large bracketed paste sitting in a silent reflow/commit
// window with no PTY output yet — comfortably above the paste-to-enter
// handshake windows in tuiHandshake.js (PASTE_DEADLINE_MS=10s) without
// meaningfully weakening the idle-reap protection once input truly stops.
const PASTE_INPUT_GRACE_MS = 15000;

// Connectivity gate for the idle reaper. When the machine loses internet, a
// live TUI goes silent (it can't reach the model) in a way that's
// indistinguishable from a hung or finished agent to the idle timer — so an
// outage would reap an agent that's only blocked on the network. We keep a
// cheap reachability reading fresh only in the LEAD window right before the
// idle deadline and DEFER the reap while offline. `RECHECK_MS` throttles probes
// to at most one per interval; `LEAD_MS` is how far before the (possibly
// extended) reap deadline probing begins — so a healthy, chatty agent is never
// probed and a drifting one has a confirmed reading in hand at its reap tick,
// without probing for the whole window. This does NOT weaken the hung-agent
// safety net: a stuck agent on a healthy connection still reaps on schedule,
// and the max-runtime backstop still bounds an agent kept alive through a long
// outage.
const CONNECTIVITY_RECHECK_MS = 10000;
const CONNECTIVITY_PROBE_LEAD_MS = 20000;

// Throttle for the PR-follow-up deliverable check (see refreshFollowUpPrState).
// Far slacker than the connectivity probe because it shells out to `gh` over the
// network and the answer it is waiting for — "the PR flipped to MERGED" — only
// ever changes once per run. Polling starts only after the session has already
// been silent for its BASE idle window, so a busy follow-up never hits the forge.
const PR_STATE_RECHECK_MS = 30000;

// Output buffering/spooling (createOutputSpooler) and failure-analysis /
// worktree-inspection helpers (readFileTail, worktreeHasChanges, commitsSince,
// worktreeHasWorkEvidence, captureWorktreeDiff, resolveErrorAnalysis,
// RAW_TAIL_ANALYSIS_BYTES) live in
// ./agentTuiSpawning/ so spawnTuiAgent stays a thin orchestrator.

// Sentinel-file polling. TUI agents write `.agent-done` in their workspace
// when they've finished /simplify + /do:pr (or /do:push) — we poll for it
// here so the agent gets cleanly finalized as soon as the work is done,
// without waiting on the much longer idle timeout fallback.
// The filename is per agent instance — see doneSentinelName in ../lib/agentSentinel.js.
const DONE_POLL_INTERVAL_MS = 2000;

/**
 * Thin wrapper around `shellService.createShellSession` for the agent TUI
 * path. Centralizes the agent-side defaults (kind, label, initialCommand)
 * and pairs the returned session id with its underlying pty process so
 * callers don't have to make a second `getSessionProcess` call inline.
 *
 * Returns `{ sessionId, ptyProcess, pid }`. When the shell service fails
 * to create the session, `sessionId` is null and the caller is expected
 * to bail out via its `finish` path.
 */
export async function createAgentTuiSession({
  agentId,
  taskId,
  provider,
  model,
  tuiConfig,
  cwd,
  forgeTokenEnv = {},
  doneSentinelPath = null,
  useDurableRunner = false,
  onData,
  onExit,
  onInitialCommandSent,
}) {
  const env = { ...composeProviderEnv({ before: forgeTokenEnv, provider, model }), ...agentGuardEnv() };
  if (useDurableRunner) {
    // The runner launches the TUI command directly (there is no intermediate
    // login-shell readiness probe), so output can arrive before the spawn HTTP
    // response. Open the readiness gate before handing off to avoid discarding
    // the TUI's first bracketed-paste/input-ready signals.
    onInitialCommandSent?.();
    const session = await spawnTuiSessionViaRunner({
      agentId,
      taskId,
      command: tuiConfig.command,
      args: tuiConfig.args,
      workspacePath: cwd,
      envVars: env,
      doneSentinelPath,
      onData,
      onExit,
    });
    shellService.registerExternalSession(session.sessionId, session.ptyProcess, {
      cwd,
      kind: 'agent-tui',
      agentId,
      label: `${provider.name} ${agentId}`,
      command: tuiConfig.commandLine,
    });
    return session;
  }

  const sessionId = shellService.createShellSession(null, {
    cwd,
    kind: 'agent-tui',
    agentId,
    label: `${provider.name} ${agentId}`,
    command: tuiConfig.commandLine,
    initialCommand: tuiConfig.commandLine,
    // Wait until the shell can actually RUN commands before injecting the CLI
    // command — a fixed delay races a heavy interactive shell and the launched
    // TUI can fall straight back to a half-loaded prompt (see shell.js
    // waitForPromptReady, which proves readiness with a round-trip probe).
    waitForPromptReady: true,
    // Fires when the CLI command is actually injected. We start observing
    // claude's input-readiness only after this so the readiness probe's own
    // shell activity can't prematurely open the paste gate.
    onInitialCommandSent,
    // A DELTA, not a full env — buildSafeEnv inside createShellSession supplies
    // the base and shell.js does the PWD pin. composeProviderEnv owns the layer
    // order (forgeTokenEnv before provider.envVars so an explicit provider
    // GH_TOKEN still wins; the OpenCode declared-models map after it, overriding
    // the static config). forgeTokenEnv has to be threaded in explicitly because
    // buildSafeEnv strips GH_TOKEN from the inherited env (resolveForgeTokenEnv).
    //
    // agentGuardEnv() is spread last so the pm2 shim wins over any provider PATH.
    // It reads PATH from process.env rather than the composed env — correct here
    // and NOT what buildCliChildEnv's `guard` does, because this is an overlay
    // whose real base env is assembled downstream. Only AI agent sessions get
    // the shim; the user's own Shell page does not.
    env,
    onData,
    onExit,
  });

  if (!sessionId) {
    return { sessionId: null, ptyProcess: null, pid: null };
  }

  const ptyProcess = shellService.getSessionProcess(sessionId);
  return { sessionId, ptyProcess, pid: ptyProcess?.pid || null };
}

// Best-effort liveness probe for the launched TUI command. The TUI runs e.g.
// `claude` as a CHILD of a persistent PTY shell (see createShellSession writing
// initialCommand), so when that command exits at startup the PTY itself stays
// open — the shell just returns to its prompt — and the spawner's onExit never
// fires. "The shell PID has no live child process" therefore means the launched
// command has already exited. Resolves true (assume alive) when the probe can't
// run, so a flaky/absent `ps` never blocks an otherwise-healthy paste.
function shellHasLiveChild(shellPid) {
  if (!shellPid) return Promise.resolve(true);
  return new Promise((resolve) => {
    // `-Ao ppid=` is POSIX (all processes, ppid column only, no header) and
    // works on both macOS (BSD ps) and Linux (procps).
    execFile('ps', ['-Ao', 'ppid='], { timeout: 2000 }, (err, stdout) => {
      if (err) { resolve(true); return; }
      resolve(stdout.split('\n').some((line) => parseInt(line, 10) === shellPid));
    });
  });
}

export function buildTuiSpawnConfig(provider, model, { systemPromptFile = null, effort = null } = {}) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])]);
  // Model+effort injection (including the antigravity-validates-the-pair special
  // case) is shared with tuiHandshake.js#buildTuiInvocation via
  // providerVendors.js#injectTuiModelAndEffort, so the two spawn paths can't
  // drift — they already had once, on cursor, before #3618.
  let args = injectTuiModelAndEffort(command, baseArgs, provider, model, effort);
  // Lean mode for Ollama-backed claude sessions (no-op otherwise) — must come
  // before the system-prompt flag so `--bare` is present when the contract
  // file rides along.
  args = applyLeanClaudeArgs(provider, args, command);
  if (systemPromptFile && isClaudeCommand(command)) {
    args = [...args, '--append-system-prompt-file', systemPromptFile];
  }

  return {
    command,
    args,
    commandLine: [command, ...args].map(shellQuote).join(' '),
    promptDelayMs: provider?.tuiPromptDelayMs || DEFAULT_TUI_PROMPT_DELAY_MS,
    idleTimeoutMs: provider?.tuiIdleTimeoutMs || DEFAULT_TUI_IDLE_TIMEOUT_MS,
    maxRuntimeMs: provider?.tuiMaxRuntimeMs || DEFAULT_TUI_MAX_RUNTIME_MS
  };
}

// Paste + submit-Enter + max-runtime retry machinery for spawnTuiAgent's
// prompt delivery. Separated from spawnTuiAgent so retries don't re-run the
// liveness guard or re-set the outer promptSentAt (see `sendPrompt` below) —
// the cluster spawnTuiAgent's own comments already described as one cohesive
// concern. Owns the paste-attempt counter, the post-paste accumulator, the
// paste-marker/verify timers, the submit-Enter backstop timer, the
// max-runtime wall-clock timer, and the wrap-up grace window it opens instead
// of reaping immediately.
//
// `isFinalized`/`markPromptSent`/`markPromptSubmitted` are accessors into
// spawnTuiAgent's own `finalized`/`promptSentAt`/`promptSubmittedAt` — those
// are read by handleData and the idle reaper well outside this cluster, so
// they stay owned by spawnTuiAgent and are threaded through rather than
// duplicated here. `finish`/`finishStartupFailure`/`appendLine`/
// `sentinelPresent` are likewise spawnTuiAgent's own closures, passed in
// rather than re-implemented.
function createPasteRetryController({
  agentId,
  sessionId,
  pid,
  useDurableRunner,
  prompt,
  tuiConfig,
  cwd,
  agentDir,
  mcpBoot,
  appendLine,
  sentinelPresent,
  isFinalized,
  markPromptSent,
  markPromptSubmitted,
  finish,
  finishStartupFailure,
}) {
  // Markers already present in the prompt text itself (a transcript-analysis task
  // can echo `[Pasted text #N]` back). The paste-commit fast path must wait for
  // the TUI's OWN marker — i.e. the count to EXCEED this — so an echoed marker
  // doesn't fire the submit-Enters mid-reflow (issue #1229 review). STRIP the
  // prompt first: a pasted RAW transcript may carry the cursor-positioned marker
  // form (`[Pasted\x1b[11Gtext…`), which counts as 0 unstripped but echoes back as
  // the stripped `[Pastedtext#…]` (count 1) — so we must count the prompt the same
  // way the post-paste buffer is counted, or the gate undercounts and fires early.
  const promptMarkerCount = countPasteMarkers(stripAnsi(prompt));
  // Extract a verifiable prefix from the prompt for paste verification (issue #2192).
  // Computed once up front so retry attempts use the same verification target.
  const verifiablePrefix = extractVerifiablePromptPrefix(prompt);

  // Bounded post-paste accumulator. Lives only while pasteEnterTimer is
  // running (a few seconds at most), so the in-memory cost is bounded by
  // however much the TUI emits during the paste-marker window — typically
  // a few KB. Set to '' when sendPrompt fires; nulled when paste detection
  // resolves or the agent finalizes.
  let postPasteBuffer = null;
  let pasteEnterTimer = null;
  let pasteVerifyTimer = null;
  let submitEnterTimer = null;
  // Absolute wall-clock backstop — armed once the prompt is SUBMITTED, cleared
  // by cancel(). Unlike the idle reaper (which resets on every PTY repaint and
  // so never fires for a busy-but-stuck agent whose working counter keeps
  // ticking), this bounds the total run so a hung provider/CLI can't run
  // unbounded. See DEFAULT_TUI_MAX_RUNTIME_MS for the incident.
  let maxRuntimeTimer = null;
  // Deadline for the wrap-up grace window the max-runtime ceiling opens instead of
  // reaping immediately (see MAX_RUNTIME_WRAP_UP_GRACE_MS). Cleared by cancel()
  // alongside every other timer.
  let wrapUpTimer = null;
  let pasteAttempt = 0;
  // Wall-clock of the FIRST paste attempt — the anchor for the MCP-boot-aware
  // retry deadline (retries are time-bounded, not attempt-count-bounded, while
  // codex is still booting its MCP servers).
  let firstPasteStartedAt = null;
  // Guards re-entry the way the outer promptSentAt used to before this state
  // moved here — sendPrompt is this controller's only setter for it now.
  let sent = false;

  /**
   * Re-deliver the prompt while a self-clearing provider signal's grace window
   * is open (agy's account-eligibility banner).
   *
   * The banner is the REJECTION of the submission, not a spinner over an
   * in-flight one: agy discards the prompt, empties its composer and returns to
   * its idle footer, so nothing will generate until something re-asks — which is
   * also what the banner instructs ("try again shortly"). Re-pasting the WHOLE
   * prompt is correct precisely because the composer is empty.
   *
   * Lives here rather than in spawnTuiAgent because this controller owns
   * `submitEnterTimer`; leaving the handle in one scope and the re-delivery in
   * another is how you leak an Enter interval past finish(). Nothing here
   * re-runs paste VERIFICATION: the prompt already rendered once (its rejection
   * is why we're here), and routing back through `attemptPaste` would spend the
   * startup paste-retry budget and let a verification hiccup mid-handshake
   * finalize the run as `paste-not-rendered`.
   *
   * @returns {boolean} whether the paste actually went out (false once the
   *   session is gone — the caller must not claim a re-submission that didn't
   *   happen).
   */
  const resubmit = () => {
    if (isFinalized() || !sessionId) return false;
    // Overwriting a live handle would leak the previous attempt's Enter interval
    // past cancel(); pasteToSession returns a fresh one, or false once the
    // session is gone — which is also the "don't bother" answer, since the
    // grace window's deadline still owns the fail-over.
    if (submitEnterTimer) clearInterval(submitEnterTimer);
    const handle = shellService.pasteToSession(sessionId, prompt, {
      label: '[cosAgents] provider-handshake resubmit',
    });
    submitEnterTimer = handle || null;
    return !!handle;
  };

  // Reap the run as a max-runtime failure. Shared by the wrap-up grace window's
  // expiry and its own "session already died" branch so both produce the same
  // record: uncommitted work captured for post-mortem, then a
  // needs-manual-finish error (same recovery guidance as the merge-queue /
  // review-loop idle-timeout paths — a stuck orchestrator may have left
  // PRs/worktrees behind).
  const finishMaxRuntimeFailure = (detail, reason = 'max-runtime-timeout') => {
    captureWorktreeDiff(cwd, agentDir).catch(() => {});
    finish({
      success: false,
      exitCode: 124,
      error: `TUI agent exceeded its max runtime of ${Math.round(tuiConfig.maxRuntimeMs / 60000)}min — ${detail} check for open or merged-but-uncleaned PRs and finish them manually.`,
      reason,
    }).catch(err => {
      emitLog('error', `Failed to finalize TUI agent ${agentId} at max-runtime: ${err.message}`, { agentId });
    });
  };

  // Max-runtime wrap-up grace: prod the agent to land its sentinel, then watch
  // for it before reaping (see MAX_RUNTIME_WRAP_UP_GRACE_MS). The prod goes in
  // over the same bracketed-paste + delayed-Enter channel `sendBtwToAgent` uses,
  // so from the agent's side it is indistinguishable from the user typing it.
  //
  // Success here finalizes through the ordinary sentinel path — we do NOT call
  // finish() ourselves on the happy path, because the 2s doneSentinelTimer is
  // still running and owns that transition; racing it would just be a second
  // caller into the same `finalized` guard. This poll exists to bound the WAIT
  // and to reap when the prod doesn't work.
  const startWrapUpGrace = () => {
    if (isFinalized() || wrapUpTimer) return;
    // A dead session can't be prodded — nothing will ever write the sentinel, so
    // skip the grace window entirely rather than idling out the full 5min.
    if (!sessionId || !shellService.getSession(sessionId)) {
      finishMaxRuntimeFailure('the TUI session was already gone, so it could not be asked to wrap up;');
      return;
    }
    const graceMin = Math.round(MAX_RUNTIME_WRAP_UP_GRACE_MS / 60000);
    appendLine(`⏳ Max runtime reached — asking the agent to wrap up and write its sentinel (${graceMin}min grace)`);
    emitLog('warn', `TUI agent ${agentId} hit max runtime — prodding it to wrap up with ${graceMin}min of grace before reaping`, { agentId, phase: 'wrap-up' });
    updateAgent(agentId, { metadata: { phase: 'wrap-up' } }).catch(err => {
      emitLog('warn', `Failed to mark TUI agent ${agentId} as wrapping up: ${err.message}`, { agentId });
    });

    // Clear any prior submit-Enter interval first: hours after submission the
    // prompt's own is long finished, but overwriting a live handle would leak
    // it past finish().
    if (submitEnterTimer) clearInterval(submitEnterTimer);
    submitEnterTimer = shellService.pasteToSession(
      sessionId,
      // The agent's OWN sentinel name — the bare `.agent-done` is a path no
      // poller is watching.
      buildWrapUpProdMessage(MAX_RUNTIME_WRAP_UP_GRACE_MS, doneSentinelName(agentId)),
      { label: '[cosAgents] max-runtime wrap-up' },
    );

    // A single deadline, NOT a poll: the 2s doneSentinelTimer is already watching
    // this exact path at this exact cadence and owns the success transition (and
    // cancel() clears this handle), so polling here would just double the
    // existsSync syscalls for 5 minutes to learn something the other timer acts on
    // first. All this needs to do is fire once at the end of the window.
    wrapUpTimer = setTimeout(() => {
      try {
        wrapUpTimer = null;
        if (isFinalized()) return;
        // The sentinel landed right at the boundary — the prod worked after all.
        // Let the sentinel path finalize it as the success it is.
        if (sentinelPresent()) return;
        finishMaxRuntimeFailure(
          `it did not wrap up within ${graceMin}min of being asked, so the provider/CLI likely hung (a stalled request keeps the working counter repainting so the idle reaper never fires);`,
          'max-runtime-no-wrap-up',
        );
      } catch (err) {
        // setTimeout callback: an uncaught throw here would crash the process.
        console.error(`❌ wrapUpTimer callback failed: ${err.message}`);
      }
    }, MAX_RUNTIME_WRAP_UP_GRACE_MS);
  };

  const sendPrompt = async (reason) => {
    if (isFinalized() || sent) return;
    sent = true;
    markPromptSent();
    // Liveness guard: the TUI command runs as a child of the persistent PTY
    // shell, so if it exited at startup (e.g. claude failing to enter
    // interactive mode) the PTY stays open and onExit never fires. Pasting now
    // would dump the bracketed-paste prompt into the bare shell — the wedged
    // `^[[200~ …` session. If the shell has no live child, the command is gone:
    // fail loudly with whatever it printed instead of pasting into the shell.
    //
    // Runner mode has no launch shell — the TUI IS the PTY process — so "does
    // this pid have a live child?" is the wrong question (claude may have zero
    // children at paste time) and a TUI exit kills the PTY, firing onExit. Skip
    // the probe there.
    if (!useDurableRunner && !(await shellHasLiveChild(pid))) {
      if (isFinalized()) return; // a real onExit may have finalized during the probe await
      await finishStartupFailure(
        'tui-exited-early',
        `${tuiConfig.command} exited at startup before the TUI was ready, so no prompt was sent.`,
      );
      return;
    }
    // Start the paste attempt — may be retried if verification fails (issue #2192).
    attemptPaste(reason);
  };

  // Actually perform a paste attempt. Separated from sendPrompt so retries don't
  // re-run the liveness guard or re-set promptSentAt. Increments pasteAttempt on
  // each call; clears any pending timers from the previous attempt first.
  const attemptPaste = (reason) => {
    pasteAttempt += 1;
    const attemptNum = pasteAttempt;
    if (firstPasteStartedAt === null) firstPasteStartedAt = Date.now();
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    if (pasteVerifyTimer) { clearInterval(pasteVerifyTimer); pasteVerifyTimer = null; }
    // Start capturing post-paste output. Set BEFORE writing the paste so
    // every chunk that arrives in response gets appended. Cleared the moment
    // detection resolves (marker seen or fallback elapsed) so the accumulator
    // never lives beyond the paste-marker window.
    postPasteBuffer = '';
    shellService.writeToSession(sessionId, `\x1b[200~${prompt}\x1b[201~`);
    const attemptSuffix = attemptNum > 1 ? ` [attempt ${attemptNum}/${PASTE_RETRY_MAX_ATTEMPTS}]` : '';
    appendLine(`📟 Prompt pasted into TUI session ${sessionId.slice(0, 8)} (${reason})${attemptSuffix}`);

    // Submit the pasted prompt with repeated Enters — a single `\r` can be
    // swallowed while the TUI is still reflowing a large paste, stranding the
    // prompt unsent (the "I had to hit Enter myself" bug). Tracked in
    // submitEnterTimer so cancel() can cancel pending retries if the agent ends.
    const submitEnter = () => {
      // Mark submission so work-activity observation begins only now — after the
      // Enter is written, past the prompt-echo window (issue #1229 review).
      markPromptSubmitted();
      submitEnterTimer = scheduleSubmitEnters(
        () => shellService.writeToSession(sessionId, '\r'),
        () => isFinalized()
      );
      // Arm the absolute wall-clock backstop from submission (once — a paste
      // retry re-enters submitEnter but must not stack timers). The idle reaper
      // can't bound a busy-but-stuck agent because Claude Code's working counter
      // keeps repainting through a stalled provider retry, resetting lastOutputAt
      // forever; this timer is the honest ceiling regardless of PTY chatter.
      if (!maxRuntimeTimer) {
        maxRuntimeTimer = setTimeout(() => {
          try {
            if (isFinalized()) return;
            // Salvage net: if the agent already wrote its .agent-done sentinel the
            // run truly finished (the TUI just never idled/exited), so complete as
            // success — mirrors the one-shot runner's response-file salvage. The
            // 2s doneSentinelTimer normally catches this first; this covers the
            // boundary where it lands right at the deadline.
            if (sentinelPresent()) {
              finish({ success: true, exitCode: 0, reason: 'max-runtime-sentinel' }).catch(err => {
                emitLog('error', `Failed to finalize TUI agent ${agentId} at max-runtime salvage: ${err.message}`, { agentId });
              });
              return;
            }
            // No sentinel yet — but a wall-clock deadline lands wherever it lands,
            // including on an agent seconds from writing one (see
            // MAX_RUNTIME_WRAP_UP_GRACE_MS for the measured 30s miss). PROD it to
            // wrap up and keep watching for the sentinel through the grace window
            // before reaping. Only then does this become a real failure.
            startWrapUpGrace();
          } catch (err) {
            // setTimeout callback: an uncaught throw here (e.g. a PTY write racing
            // a dead session) would crash the whole process, killing every other
            // in-flight agent, not just this one.
            console.error(`❌ maxRuntimeTimer callback failed: ${err.message}`);
          }
        }, tuiConfig.maxRuntimeMs);
      }
    };

    // Confirms the TUI actually received the paste before we submit. The
    // paste-commit MARKER ([Pasted text #N]) is authoritative — Claude Code
    // collapses a multi-line paste into that chip and HIDES the body text, so a
    // literal text check false-negatives on every multi-line prompt (real
    // incident 2026-07-05: agent-656efa6e et al. failed `paste-not-rendered`
    // despite the marker being present). Literal-text verification is only the
    // fallback for the markerless path — see isPasteConfirmed.
    const pasteConfirmed = (buffer) =>
      isPasteConfirmed(buffer, { verifiablePrefix, promptMarkerCount });

    // Markerless AND the prompt text never rendered → the paste was swallowed by
    // a still-initializing TUI (issue #2192). Retry, then fail.
    //
    // Budget is boot-aware: once codex's MCP-boot banner has been seen (mcpBoot
    // active), the boot can legitimately run for tens of seconds — up to ~2min
    // for a node_repl/npx server — during which EVERY paste is swallowed. Switch
    // from the fixed 3-attempt/exponential-backoff budget to a TIME budget
    // (MCP_BOOT_PASTE_DEADLINE_MS from the first paste) with a fixed cadence, so
    // retries outlast the boot and the paste finally lands once the input box is
    // live (incident 2026-07-10, agent-c5a26b40). No MCP boot → unchanged.
    const retryOrFailPaste = () => {
      if (isFinalized()) return;
      const bootActive = mcpBoot.active;
      const withinBudget = bootActive
        ? (Date.now() - firstPasteStartedAt) < MCP_BOOT_PASTE_DEADLINE_MS
        : attemptNum < PASTE_RETRY_MAX_ATTEMPTS;
      if (withinBudget) {
        const retryDelayMs = bootActive
          ? MCP_BOOT_PASTE_RETRY_DELAY_MS
          : PASTE_RETRY_BASE_DELAY_MS * Math.pow(2, attemptNum - 1);
        const bootNote = bootActive
          ? ` (waiting for ${tuiConfig.command} MCP servers to finish booting)`
          : '';
        appendLine(`⚠️ Paste verification failed — prompt text not found in buffer, retrying in ${retryDelayMs}ms${bootNote}`);
        setTimeout(() => {
          if (isFinalized()) return;
          attemptPaste(reason);
        }, retryDelayMs);
        return;
      }
      // Budget exhausted — fail the agent, naming the MCP-boot cause when that's
      // what kept the paste from landing so the operator knows to check their
      // codex config rather than chasing a phantom paste-timing bug.
      const bootSecs = Math.round(MCP_BOOT_PASTE_DEADLINE_MS / 1000);
      const summary = bootActive
        ? `${tuiConfig.command} did not finish booting its MCP servers within ${bootSecs}s, so the prompt was never delivered. A slow or hung MCP server in your ~/.codex config (e.g. playwright via npx, or a node_repl) blocks codex from accepting input — disable or fix it, or remove it for headless runs.`
        : `${tuiConfig.command} was still initializing and the paste was silently swallowed. The prompt never appeared in the TUI buffer after ${PASTE_RETRY_MAX_ATTEMPTS} attempts.`;
      appendLine(
        bootActive
          ? `❌ Paste never landed after ${bootSecs}s of waiting for MCP servers to boot — prompt never rendered`
          : `❌ Paste verification failed after ${PASTE_RETRY_MAX_ATTEMPTS} attempts — prompt never rendered`,
      );
      finishStartupFailure('paste-not-rendered', summary)
        .catch(err => emitLog('error', `TUI agent ${agentId} finishStartupFailure(paste-not-rendered) failed: ${err?.message || err}`, { agentId }));
    };

    const pasteSentAt = Date.now();
    pasteEnterTimer = setInterval(() => {
      if (isFinalized()) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        postPasteBuffer = null;
        return;
      }
      const elapsed = Date.now() - pasteSentAt;
      const markerSeen = countPasteMarkers(postPasteBuffer) > promptMarkerCount;
      // Submit when EITHER the paste-commit marker appears (preferred) or
      // the fallback window elapses (covers small prompts that don't render
      // the marker).
      if ((markerSeen && elapsed >= PASTE_TO_ENTER_MIN_DELAY_MS)
        || elapsed >= PASTE_TO_ENTER_FALLBACK_MS) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        // Capture the buffer before clearing, then confirm the paste (issue #2192).
        const commitBuffer = postPasteBuffer || '';
        postPasteBuffer = null;
        // Marker present (or text already visible, or nothing to verify) → the
        // paste landed; submit now. Trusting the marker here is what fixes the
        // multi-line-collapse false negative — Claude hides the pasted body text.
        if (pasteConfirmed(commitBuffer)) {
          submitEnter();
          return;
        }
        // Markerless AND text not visible yet: give the prompt a short window to
        // render (a late marker also counts as confirmed) before declaring it
        // swallowed. Resume accumulation for the verification window.
        let verifyBuffer = commitBuffer;
        const verifyStartedAt = Date.now();
        postPasteBuffer = commitBuffer;
        pasteVerifyTimer = setInterval(() => {
          if (isFinalized()) {
            clearInterval(pasteVerifyTimer);
            pasteVerifyTimer = null;
            postPasteBuffer = null;
            return;
          }
          verifyBuffer = postPasteBuffer || verifyBuffer;
          const verifyElapsed = Date.now() - verifyStartedAt;
          const confirmed = pasteConfirmed(verifyBuffer);
          // Submit once confirmed, or give up and retry/fail when the window expires.
          if (confirmed || verifyElapsed >= PASTE_VERIFY_WINDOW_MS) {
            clearInterval(pasteVerifyTimer);
            pasteVerifyTimer = null;
            postPasteBuffer = null;
            if (confirmed) submitEnter();
            else retryOrFailPaste();
          }
        }, PASTE_VERIFY_POLL_MS);
      }
    }, PASTE_MARKER_POLL_MS);
  };

  // handleData's own hook: accumulates PTY output into postPasteBuffer while a
  // paste attempt is awaiting its marker/verification window (see
  // postPasteBuffer above). A no-op the rest of the time.
  const ingestChunk = (stripped) => {
    if (postPasteBuffer !== null && stripped) postPasteBuffer += stripped;
  };

  // Stop everything this controller armed. Safe to call unconditionally (a run
  // that ends before any paste was attempted just clears nulls) — see
  // stopRunMachinery's own comment for why every teardown site must go through
  // one chokepoint.
  const cancel = () => {
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    if (pasteVerifyTimer) { clearInterval(pasteVerifyTimer); pasteVerifyTimer = null; }
    if (submitEnterTimer) { clearInterval(submitEnterTimer); submitEnterTimer = null; }
    if (maxRuntimeTimer) { clearTimeout(maxRuntimeTimer); maxRuntimeTimer = null; }
    if (wrapUpTimer) { clearTimeout(wrapUpTimer); wrapUpTimer = null; }
    postPasteBuffer = null;
  };

  return { sendPrompt, resubmit, ingestChunk, cancel };
}

export async function spawnTuiAgent({
  agentId,
  task,
  prompt,
  workspacePath,
  model,
  provider,
  runId,
  tuiConfig,
  agentDir,
  executionId,
  laneName,
  cleanupWorktreeFn,
  isTruthyMetaFn,
  leanMode = false,
  useDurableRunner = false,
  checkOnlineFn = isMachineOnline,
}) {
  const outputFile = join(agentDir, 'output.txt');
  // Raw PTY bytes spool to disk continuously rather than accumulate in-memory.
  // A chatty TUI (token-tick repaints, status lines) emits hundreds of chunks
  // /sec; a per-run in-memory buffer would grow without bound on long agents
  // and the join-into-single-string at finalize would double peak RAM. The
  // disk file is appended in 250ms-debounced batches (same pattern as
  // `flushPendingLines` for parsed output — see CLAUDE.md "High-frequency
  // state writes must batch"), and `analyzeAgentFailure` reads the file on
  // failure so it gets the full PTY stream regardless of run length.
  const rawFile = join(agentDir, 'raw.txt');
  const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : PATHS.root;
  // The agent writes `.agent-done` in its workspace to signal completion (see
  // the sentinel watcher below) and then stops — it does NOT run `/quit` (that
  // is a UI command the agent can't invoke). The 2s poll is the primary
  // finalize path; finish() also ingests the sentinel directly so the summary
  // is captured even if some other path (idle/exit) finalizes first. Computed
  // up front so both the watcher AND finish() can read it (see ingestDoneSentinel).
  // Resolved from the shared helper, so this is byte-identical to the path the
  // prompt told the agent to write (see resolveSentinelPath).
  const doneSentinelPath = resolveDoneSentinelPath(workspacePath, agentId);
  const promptPreview = prompt.replace(/\s+/g, ' ').slice(0, 100);
  const commandName = tuiConfig.command.split('/').pop();

  let finalized = false;
  let immediateFallbackAnalysis = null;
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();
  // Holds the wait-it-out window for a provider signal carrying a `graceMs`
  // (agy's account-eligibility banner). The idle timer below both resolves its
  // deadline, drives the re-submission cadence, and defers to `.armed` for idle
  // suppression.
  const selfClearingGate = createSelfClearingSignalGate();
  // Guards ingestDoneSentinel to a single read. finish() is its only caller and
  // is itself guarded by `finalized`, so this is defensive — it pins the
  // read-at-most-once invariant at the helper.
  let sentinelIngested = false;
  let hasStartedWorking = false;
  let promptSentAt = null;
  // When the submit-Enter is first written (NOT when the paste starts). Work-
  // activity observation keys on this so the prompt ECHO — which renders during
  // the paste→Enter window, before this is set — is never scanned for the working
  // counter (issue #1229 review: a pasted transcript could otherwise echo counters
  // that fake work before the prompt is actually submitted).
  let promptSubmittedAt = null;
  // Tracks evidence the model is actively processing the SUBMITTED prompt — the
  // TUI's elapsed working counter advancing through ≥2 distinct values (see
  // createWorkActivityTracker; echo-proof, unlike word-matching the prompt text).
  // Distinct from `hasStartedWorking`, which flips on ANY post-spawn PTY output
  // including pure banner/status-line chrome. `tracker.active` is what gates the
  // fallback idle-complete path from finalizing a never-submitted prompt as
  // success (issue #1229).
  const workActivity = createWorkActivityTracker();
  // Latches once the agent enters a `/do:next --swarm` Phase C serialized merge
  // queue, whose per-PR CI re-runs produce minutes of silent output. While
  // latched, the idle reaper uses the extended MERGE_QUEUE_IDLE_TIMEOUT_MS so a
  // still-working orchestrator isn't reaped mid-merge (issue #2074).
  const mergeQueue = createMergeQueueTracker();
  // Latches once the agent enters a do:release/do:pr/do:rpr multi-reviewer
  // loop, whose external reviewer passes (codex reading a large diff, a
  // Copilot cloud review, a human @<login> review) can go silent in the TUI
  // for well over the default idle window. While latched, the idle reaper
  // uses the extended REVIEW_LOOP_IDLE_TIMEOUT_MS so a still-waiting release
  // isn't reaped as a false `idle-complete` success before it reaches the
  // merge gate (issue observed on agent-61508f36, PR #2084).
  const reviewLoop = createReviewLoopTracker();
  // Latches once the TUI reports background shell commands still in flight.
  // `/do:pr`'s self-review gate backgrounds each reviewer and waits to be
  // re-invoked, and between completions the model returns to the prompt and the
  // TUI emits NOTHING — a legitimate wait the default 3-minute window reaps as
  // if the session were dead. The review-loop tracker above does not cover it:
  // it keys on the multi-reviewer LOOP's banners, which only print when
  // `configReviewLoop` is on (task-mslczmtr ran with it off and lost three
  // consecutive attempts this way). See the BACKGROUND_SHELL_IDLE_TIMEOUT_MS
  // declaration for the full incident.
  const backgroundShell = createBackgroundShellTracker();
  // Latches once codex prints its MCP-server boot banner during startup. A user
  // with heavyweight interactive MCP servers in ~/.codex/config.toml (playwright
  // via npx, a node_repl with startup_timeout_sec=120) makes codex spend tens of
  // seconds — up to ~2min — booting them before its input box accepts a paste,
  // far longer than the default 3-attempt paste-retry window. While latched, the
  // paste-retry loop below extends its budget to MCP_BOOT_PASTE_DEADLINE_MS so a
  // slow boot completes and the paste finally lands, instead of being killed
  // `paste-not-rendered` mid-boot (incident 2026-07-10, agent-c5a26b40).
  //
  // Gated to codex ONLY (isCodexSession below). The extended budget and the
  // failure message ("check your ~/.codex config") are codex-specific, and the
  // claude path never blind-pastes during its own MCP boot — it waits for
  // claude's positive input-ready signal first (createInputReadyTracker) — so it
  // can't hit this failure mode. Observing every provider would let an unrelated
  // TUI whose startup text happened to contain "starting mcp servers" inherit
  // codex's 150s budget and its misleading codex-config guidance, breaking the
  // "non-codex TUIs are unchanged" contract (codex review [P2]).
  const isCodexSession = commandName.toLowerCase().includes('codex');
  const mcpBoot = createMcpBootTracker();
  // Tracks claude's interactive input-readiness (footer chrome) and its first-run
  // folder-trust gate. Gates the prompt paste for the claude TUI so we never
  // paste into a startup banner, a trust menu, or a returned shell prompt.
  // agy enables bracketed paste on alt-screen entry, before its composer (and
  // before its trust gate) exists, so it needs the extra composer-footer gate.
  // The durable runner pty.spawns the TUI directly (no launch shell), so the
  // tracker must not wait for a shell paste-mode OFF that will never come.
  const inputReady = createInputReadyTracker({
    ...(isAntigravityCommand(tuiConfig.command) ? { readyTextPattern: AGY_INPUT_READY_PATTERN } : {}),
    directLaunch: useDurableRunner,
  });
  let trustAccepted = false;
  let autoModeDeclined = false;
  // True once shell.js actually injects the `claude` command (after its
  // round-trip readiness probe). The probe runs its OWN shell command first,
  // which toggles bracketed-paste mode and would otherwise advance the
  // input-ready tracker (sawCommandRun + pasteModeOn) while still at the bare
  // shell prompt — pasting the prompt into claude's startup banner. Gating
  // observation on this discards every pre-command toggle.
  let commandInjected = false;
  let firstOutputAt = null;
  let lastOutputAt = Date.now();
  let sessionId = null;

  // Idle-reaper connectivity gate (see CONNECTIVITY_* constants). `online`
  // starts optimistically true so the happy path reaps on schedule without
  // waiting on a probe; it only ever flips to false once a probe confirms an
  // outage, at which point the idle reaper defers. Probing is started by the
  // idle timer only in the LEAD window before the reap deadline (not the whole
  // idle window), so a confirmed reading is in hand at the reap tick and a busy
  // agent is never probed.
  const connectivity = { online: true, checking: false, lastCheckAt: 0, loggedOffline: false };
  const refreshConnectivity = () => {
    if (connectivity.checking) return;
    if (Date.now() - connectivity.lastCheckAt < CONNECTIVITY_RECHECK_MS) return;
    connectivity.checking = true;
    connectivity.lastCheckAt = Date.now();
    Promise.resolve()
      .then(() => checkOnlineFn())
      .then((online) => {
        if (finalized) return;
        // A probe that RESOLVES `false` is the only thing that flips us offline;
        // any other resolved value maps to online. A probe that THROWS is
        // swallowed by the `.catch` below and leaves the last reading untouched
        // — a failed-to-run probe is never proof of an outage by itself.
        const nowOnline = online !== false;
        // Reconnect grace: on the offline→online transition, give the CLI a
        // fresh idle window to notice the network is back and resume before the
        // reaper can fire — otherwise we'd reap in the gap before it repaints.
        if (nowOnline && connectivity.online === false) lastOutputAt = Date.now();
        connectivity.online = nowOnline;
      })
      .catch(() => {})
      .finally(() => { connectivity.checking = false; });
  };

  // PR-follow-up deliverable gate. A follow-up run spawned by
  // `spawnReviewLoopFollowUp` exists to land ONE pull request — it makes no
  // commit, is told to "Exit" when the PR reads MERGED, and (on Antigravity,
  // which routinely skips the sentinel) then just sits at its prompt. Every
  // signal the idle reaper otherwise has is a proxy that gets this run WRONG:
  // its prompt quotes `gh pr checks` / `gh pr merge` / `--delete-branch`, so the
  // TUI's echo latches the merge-queue tracker before any work happens, and the
  // finished run is reaped 15 minutes later as `merge-queue-idle-timeout` — a
  // needs-manual-finish FAILURE naming a PR that is already merged, retried to
  // `Max retries exceeded` and a HIGH orphaned-PR notification (sys-rl-msr1j1a5
  // / PR #3909, 2026-08-13). So ask the forge the actual question instead.
  //
  // `merged` starts false and only a `known` MERGED answer flips it: a gh we
  // could not run (firewalled, offline) is NOT evidence of anything and must
  // leave the pre-existing verdicts untouched. GitHub only — `gh pr view`
  // against a GitLab MR or an unresolved host answers nothing, so those follow-ups keep prior behavior.
  const prFollowUpRef = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp)
    && detectForgeCli(task.metadata?.reviewLoopPRHost) === 'gh'
    ? (task.metadata?.reviewLoopPRUrl || task.metadata?.reviewLoopPRNumber || null)
    : null;
  const followUpPr = { merged: false, checking: false, lastCheckAt: 0 };
  const refreshFollowUpPrState = () => {
    if (!prFollowUpRef || followUpPr.merged || followUpPr.checking) return;
    if (Date.now() - followUpPr.lastCheckAt < PR_STATE_RECHECK_MS) return;
    followUpPr.checking = true;
    followUpPr.lastCheckAt = Date.now();
    // Dynamic import, matching agentFinalization's forge-lookup call site: it
    // keeps `github.js` (and its settings/data-file dependencies) out of the
    // module graph of every suite that mocks this spawner.
    import('./github.js')
      .then(({ getPullRequestState }) => getPullRequestState(prFollowUpRef, { cwd }))
      .then((res) => {
        if (finalized) return;
        if (res?.status === 'known' && res.state === 'MERGED') {
          followUpPr.merged = true;
          emitLog('info', `TUI agent ${agentId} follow-up PR reads MERGED — finalizing on the deliverable rather than the idle window`, { agentId });
        }
      })
      .catch(() => {})
      .finally(() => { followUpPr.checking = false; });
  };

  // The paste-attempt / max-runtime / wrap-up-grace machinery (postPasteBuffer,
  // pasteEnterTimer, pasteVerifyTimer, submitEnterTimer, maxRuntimeTimer,
  // wrapUpTimer) lives in createPasteRetryController rather than this closure
  // — see its own comment for why that cluster is separated out.
  // `pasteController` is created once sessionId/pid are known (below) and torn
  // down from stopRunMachinery via `pasteController?.cancel()`.
  let pasteController = null;

  const streamingStrip = createStreamingAnsiStripper();

  // Output buffering + raw PTY spooling (parsed-line → output.txt/state,
  // raw bytes → raw.txt, both debounced) live in the extracted spooler so
  // this function stays orchestration. `appendLine` records a status line,
  // `pushRaw` queues a raw chunk, `drainLines`/`drainRaw` flush at finalize,
  // and `getOutputBuffer` reads the capped buffer for failure-analysis fallback.
  const spooler = createOutputSpooler({ agentId, outputFile, rawFile });
  const { appendLine, pushRaw, flushRaw, drainLines, drainRaw, getOutputBuffer } = spooler;

  // Read the `.agent-done` sentinel (if present) and append its markdown task
  // summary line-by-line into the agent's output so downstream consumers
  // (extractFinalSummary, persistSimplifySummaries, completion hooks, the agent
  // card, output.txt) get the resolution. Called only from finish() (the single
  // finalize chokepoint); idempotent via `sentinelIngested` so it reads at most
  // once. Capped at 4 KB so an agent that pasted the whole diff into the
  // sentinel can't blow up the record.
  // Has the agent written its completion sentinel? One predicate for every path
  // that asks (the 2s watcher, the max-runtime salvage, the wrap-up grace poll,
  // and ingestDoneSentinel) so "the run finished" can't mean subtly different
  // things in four places.
  const sentinelPresent = () => !!doneSentinelPath && existsSync(doneSentinelPath);

  const ingestDoneSentinel = async () => {
    if (sentinelIngested) return;
    if (!sentinelPresent()) return;
    sentinelIngested = true;
    const contents = await readFile(doneSentinelPath, 'utf8').catch(err => {
      console.error(`❌ ingestDoneSentinel readFile failed: ${err.message}`);
      return '';
    });
    // A programmatic-I/O task type writes a JSON `{ summary, payload }` sentinel;
    // append only the human `summary` to the agent output (the structured
    // `payload` is consumed separately by the task type's processTaskOutput hook,
    // read mode-agnostically in finalizeAgent). A legacy plain-markdown sentinel
    // parses back as its own text, so this is a no-op change for existing types.
    const { summary } = parseSentinelPayload(contents);
    if (!summary) return;
    // Shared constant, not a literal: `extractAgentSummary` anchors the PR-body
    // extraction on this exact line to tell the agent's summary apart from the
    // lifecycle telemetry above it. Reword it here only, and the noise returns.
    appendLine(SENTINEL_COMPLETION_MARKER);
    const truncated = summary.length > 4096 ? `${summary.slice(0, 4096)}\n…[truncated]` : summary;
    for (const line of truncated.split('\n')) appendLine(line);
  };

  /**
   * Stop everything this run armed, and hand back the agent record so the
   * caller doesn't need a second map lookup.
   *
   * Shared by the two paths that end a run — `finish()` (records an outcome) and
   * `abandonForHostShutdown()` (records none). Every timer here is created inside
   * this closure, so a teardown site that falls behind leaks an interval holding
   * the closure and the PTY handle alive; this file has already grown two new
   * timers since it was written (maxRuntime + wrapUp), which is exactly the drift
   * a single teardown prevents.
   */
  const stopRunMachinery = () => {
    const agentData = activeAgents.get(agentId);
    if (agentData?.idleTimer) clearInterval(agentData.idleTimer);
    if (agentData?.promptTimer) clearInterval(agentData.promptTimer);
    if (agentData?.doneSentinelTimer) clearInterval(agentData.doneSentinelTimer);
    // Cancels the paste-attempt/max-runtime/wrap-up timers and releases the
    // post-paste accumulator even when the run ends mid-paste-window — see
    // createPasteRetryController's own cancel() for why each is safe to clear
    // unconditionally (a run that ends from elsewhere — shell-exit,
    // command-not-found, user termination, a host restart — never gets a
    // chance to let its own cleanup path run).
    pasteController?.cancel();
    return agentData;
  };

  const finish = async ({ success, exitCode = 0, error = null, reason = 'completed' }) => {
    if (finalized) return;
    // PortOS is going down. Whatever path got here — the PTY exiting under
    // TreeKill, the idle reaper, a paste that failed because the shell died —
    // the cause is the host restart, not the agent, so there is no outcome to
    // record. Abandoning instead of finalizing is what keeps an interrupted run
    // from being written down as completed AND keeps its worktree (which
    // finalize's cleanup would delete) intact for the resume (#3202).
    //
    // Three exceptions keep their normal path. An agent that already wrote its
    // `.agent-done` sentinel has given a valid completion signal. A run the user
    // terminated must reach finalizeAgent to be recorded `user-terminated` —
    // abandoning it would leave the record `running` with no such mark, and boot
    // recovery's user-terminated skip would miss it and resurrect the run. And a
    // run the user paused already has its own don't-finalize branch below, which
    // owns the paused bookkeeping (pid unregister, activeAgents delete).
    if (shouldAbandonForHostShutdown({
      sentinelPresent: sentinelPresent(),
      terminatedByUser: userTerminatedAgents.has(agentId),
      paused: pausedAgents.has(agentId),
    })) {
      await abandonForHostShutdown();
      return;
    }
    finalized = true;

    const agentData = stopRunMachinery();

    // Ingest the .agent-done sentinel BEFORE draining, so its markdown summary
    // lands in outputBuffer/output.txt regardless of WHICH path finalized the
    // agent. The completion workflow writes the sentinel and stops; the 2s
    // doneSentinelTimer poll is what normally calls finish(). Reading it here
    // (not just in the poll) keeps the resolution captured even when a
    // different path (idle-complete, shell-exit) finalizes first. Idempotent
    // via `sentinelIngested`.
    await ingestDoneSentinel();

    // Drain pending parsed lines AND raw chunks before the final state
    // writes so completion events don't beat the last output batch to disk.
    await drainLines();
    await drainRaw();

    if (pausedAgents.has(agentId)) {
      pausedAgents.delete(agentId);
      const pausedAgentData = activeAgents.get(agentId);
      if (pausedAgentData?.pid) unregisterSpawnedAgent(pausedAgentData.pid);
      activeAgents.delete(agentId);
      return;
    }

    const duration = Date.now() - (agentData?.startedAt || Date.now());
    const terminatedByUser = userTerminatedAgents.has(agentId);
    if (terminatedByUser) userTerminatedAgents.delete(agentId);

    const finalSuccess = terminatedByUser ? false : success;
    const finalError = terminatedByUser ? 'Agent terminated by user' : error;

    // Release the lane + complete execution tracking BEFORE the
    // potentially-slow error-analysis / completeAgent / processAgentCompletion
    // chain — neither call blocks on I/O, but lanes serialize related work
    // and we don't want them held longer than necessary.
    releaseAgentLane({
      agentId,
      success: finalSuccess,
      duration,
      exitCode,
      executionId: agentData?.executionId || executionId,
      laneName: agentData?.laneName || laneName,
      errorExecutionMessage: finalError || `TUI agent ended: ${reason}`,
    });

    // output.txt has already been incrementally appended via the spooler;
    // do NOT writeFile() it from the output buffer at finalize — the buffer is
    // capped at OUTPUT_BUFFER_CAP and would silently truncate the on-disk
    // record for long runs. The append-only stream is the authoritative copy.
    //
    // For failure analysis: resolveErrorAnalysis reads only the tail of the raw
    // PTY spool (the analyzer strips ANSI and windows it to the last ~200 lines /
    // 16K chars) and falls back to the capped output buffer if the spool is
    // missing/unreadable. Successful runs skip the read entirely. raw.txt stays
    // in agentDir alongside output.txt as the persistent record of the agent's
    // full PTY transcript.
    const errorAnalysis = await resolveErrorAnalysis({
      finalSuccess,
      rawFile,
      fallbackText: getOutputBuffer(),
      task,
      model,
      immediateFallbackAnalysis,
      // The finalize path's own verdict outranks a keyword sweep of the
      // transcript when the analyzer recognizes it (COMPLETION_REASON_ANALYSES).
      completionReason: reason,
      completionError: finalError,
    });

    // Every TUI that is a real coding harness drives its own push → PR → review
    // → merge, whether or not it can type `/do:pr` (#3733) — a Claude TUI runs
    // the slashdo command, codex/antigravity/grok/OpenCode run the plain
    // `git`/`gh` equivalent from the same prompt. Only a lean `--bare` session
    // still hands the lifecycle back to PortOS. Derived from the same predicate
    // the prompt builder used so neither side can believe the other owns the PR.
    const taskOpenPR = isTruthyMetaFn(task.metadata?.openPR);
    const taskReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
    const agentOwnsPR = taskOpenPR && agentOwnsPrWorkflow({ providerType: PROVIDER_TYPES.TUI, leanMode });
    // …but PR-claim verification (#3358) stays keyed on the SLASH-command
    // predicate. A run PortOS still backstops (it re-checks the forge at cleanup
    // and opens the PR itself when the agent skipped it) must not be failed here
    // for a PR that is about to exist — finalize runs before that net.
    const prClaimExpected = taskOpenPR && canTypeSlashCommands({
      providerId: provider?.id,
      providerCommand: provider?.command,
      leanMode,
    });
    // Whether finalize's check ACTUALLY produced a forge answer, filled in from
    // its return below. Deliberately not `prClaimExpected`: finalize substitutes
    // `{ok:true}` for a user-terminated run and for a check that threw, and a
    // throw from finalize itself skips the assignment entirely — in all three
    // cases nothing was verified, so cleanup must ask rather than stand down.
    let prClaimVerified = false;

    // try/finally so a throw from finalizeAgent (e.g. processAgentCompletion
    // hook crash) still runs the local cleanup — sentinel removal, worktree
    // cleanup, pid unregister, activeAgents delete, session kill. Without
    // this, a memory-extraction crash would strand the worktree and the
    // shell session on disk.
    // The verdict finalizeAgent actually persisted. A PR-claim downgrade (#3358)
    // must reach cleanup too — cleaning up as a success removes the worktree and
    // deletes the local branch, destroying the state the retry needs. Left at
    // `finalSuccess` if finalize threw before returning (the pre-existing
    // best-effort posture).
    let cleanupSuccess = finalSuccess;
    try {
      const finalized = await finalizeAgent({
        agentId,
        task,
        runId,
        providerId: provider?.id,
        success: finalSuccess,
        exitCode,
        duration,
        outputBuffer: getOutputBuffer(),
        errorAnalysis,
        terminatedByUser,
        isTruthyMetaFn,
        error: finalError || undefined,
        completionReason: reason,
        workspacePath,
        prExpected: prClaimExpected,
        // The run window the commit criterion is evaluated against (#3637).
        startedAt: agentData?.startedAt ?? null,
      });
      if (finalized && typeof finalized.success === 'boolean') cleanupSuccess = finalized.success;
      prClaimVerified = prClaimWasVerified(finalized?.prVerdict);
    } finally {
      // This run's sentinel only — a sibling agent sharing this workspace owns
      // its own file and may still be running.
      if (doneSentinelPath) await rm(doneSentinelPath).catch(() => {});

      const prCreation = resolvePrCreation({ taskOpenPR, agentOwnsPr: agentOwnsPR, prClaimVerified });
      // Only the two modes that can still open a PR (and thus spawn a follow-up
      // that needs these) pay for the resolve. `never` — the dominant path, an
      // agent that opened and landed its own PR — discards them.
      const reviewOptions = prCreation !== PR_CREATION.NEVER
        ? await resolveReviewLoopOptions(task.metadata, { normalize: normalizeReviewers, isTruthyMeta: isTruthyMetaFn })
          .catch(err => {
            emitLog('warn', `TUI review options unavailable for ${agentId}: ${err.message}`, { agentId });
            return {};
          })
        : {};
      await cleanupWorktreeFn(agentId, cleanupSuccess, {
        prCreation,
        prCompletion: resolvePrCompletion(task.metadata),
        ...reviewOptions,
        skipMerge: taskReviewLoopFollowUp || agentOwnsPR,
        description: task.description,
        agentOutput: getOutputBuffer(),
        originalTask: task
      }).catch(err => emitLog('warn', `TUI worktree cleanup failed for ${agentId}: ${err.message}`, { agentId }));

      // Release the retry hold: flip the failed task back to `pending` carrying a
      // pointer at whatever the run left behind — the branch (or whole worktree)
      // `cleanupWorktreeFn` just preserved because the run failed with commits on
      // it. Without the pointer the retry starts clean and redoes work already
      // sitting on disk (#3368); without the hold that release replaces, the retry
      // could be dequeued before the pointer landed (#3373). Imported lazily for the
      // same reason `cleanupWorktreeFn` is injected: pulling the cleanup graph in at
      // module top level races this file's own init in the agentLifecycle cycle.
      await import('./agentWorktreeCleanup.js')
        .then(({ releaseRetryHold }) => releaseRetryHold({ agentId, task, success: cleanupSuccess }))
        .catch(err => emitLog('warn', `TUI retry-hold release failed for ${agentId}: ${err.message}`, { agentId }));

      if (agentData?.pid) unregisterSpawnedAgent(agentData.pid);
      activeAgents.delete(agentId);
      if (sessionId && shellService.getSession(sessionId)) shellService.killSession(sessionId);
    }
  };

  /**
   * Abandon the run because PortOS itself is going down (#3202).
   *
   * Deliberately NOT `finish()`: finalizing here would record an outcome for a
   * run that never reached one, and its cleanup path removes the `.agent-done`
   * sentinel and hands the worktree to `cleanupWorktreeFn` — destroying exactly
   * the state a resume needs. So this only stops the machinery and flushes what
   * was captured; the agent record stays `running` and the worktree stays on
   * disk. The next boot's orphan sweep reads the host-shutdown marker, sees this
   * agent named in it, and requeues the task as *interrupted* — resumable, and
   * without charging it orphan-retry budget.
   *
   * Sets `finalized` so every other path (idle reaper, sentinel poll, paste
   * retry) becomes a no-op for the rest of this process's life.
   */
  const abandonForHostShutdown = async () => {
    // No `finalized` guard: finish() — the only caller — already returned if it
    // was set, and this sets it below.
    finalized = true;
    stopRunMachinery();

    appendLine('🛑 PortOS restarted while this agent was running — the run was interrupted, not completed. Its worktree is preserved and the task will resume.');
    emitLog('warn', `TUI agent ${agentId} interrupted by a PortOS host restart — preserved for resume`, { agentId, phase: 'interrupted' });
    // Concurrent, not sequential: nothing awaits this function (it runs off the
    // PTY-exit handler, racing the shutdown handler's own process.exit), so the
    // shorter the critical path the more of the transcript actually lands. The
    // three targets are independent — output.txt + the state record, raw.txt, and
    // the metadata patch — and the two that share the state lock still serialize
    // on it. `phase` is a breadcrumb only: the record stays `running` on purpose,
    // because boot recovery owns the transition.
    await Promise.all([
      drainLines().catch(() => {}),
      drainRaw().catch(() => {}),
      updateAgent(agentId, { metadata: { phase: 'interrupted', interruptedBy: HOST_SHUTDOWN_REASON } })
        .catch(err => emitLog('warn', `Could not mark TUI agent ${agentId} interrupted: ${err.message}`, { agentId })),
    ]);
    // NOTE: the activeAgents entry is intentionally left in place — the shutdown
    // handler reads that map to name the agents in the host-shutdown marker, and
    // there is no reason to shrink it on the way out.
  };

  // The single fail-over verdict, reached from two places: a signal with no grace
  // window (immediate) and a grace window that expired without recovery. Sharing
  // it keeps the deferred path provably identical to the immediate one.
  //
  // `immediateFallbackAnalysis` is set HERE and not at arm time on purpose — it is
  // read at finalize by resolveErrorAnalysis, so stamping it when the window opens
  // would tag a run that went on to RECOVER with the banner as its error.
  const failOverToFallback = (analysis) => {
    immediateFallbackAnalysis = analysis;
    appendLine(`⚡ Provider fallback signal: ${analysis.message}`);
    return finish({
      success: false,
      exitCode: 1,
      error: analysis.message || 'Provider requires fallback',
      reason: 'fallback-signal'
    });
  };

  /**
   * Re-deliver the prompt while a self-clearing provider signal's window is open.
   *
   * agy's eligibility banner is the REJECTION of a submission, not a spinner over
   * an in-flight one: the prompt is discarded, the composer goes back to empty
   * and the session sits at its idle footer indefinitely. So the window can only
   * clear if something re-asks — hence a plain re-paste + submit, which is also
   * literally what the banner instructs ("Please try again shortly").
   *
   * Re-pasting the WHOLE prompt is correct precisely because the composer is
   * empty; the gate's 20s cadence keeps this well clear of the reflow that
   * follows the rejected paste. Nothing here re-runs paste VERIFICATION: this
   * prompt already rendered once (its rejection is why we're here), and routing
   * back through `attemptPaste` would spend the startup paste-retry budget and
   * let a verification hiccup mid-handshake finalize the run as
   * `paste-not-rendered`.
   */
  const resubmitAfterSignal = () => {
    // A banner that paints during startup (before the prompt was ever submitted)
    // has nothing to re-send — the ordinary paste path still owns first delivery.
    if (finalized || !promptSubmittedAt) return;
    const attempt = selfClearingGate.takeResubmit(Date.now());
    if (!attempt) return;
    // Only claim the re-submission that actually went out — a false return means
    // the session is already gone, and a transcript line saying otherwise would
    // send a post-mortem looking for a paste the provider never received.
    if (pasteController?.resubmit()) {
      appendLine(`🔁 Provider handshake still open — re-submitted the prompt (attempt ${attempt})`);
    }
  };

  const handleData = async (data) => {
    // EventEmitter listeners run outside the request lifecycle — a rejection
    // here on Node ≥15 will kill the process unless we catch locally. The
    // outer try/catch routes failures through emitLog (best-effort log, no
    // re-throw) and leaves the agent run intact.
    // See skill: nodejs-async-event-listener-unhandled-rejection.
    try {
      // node-pty can deliver chunks between finalize starting and the shell
      // session being killed in finalize's finally block. Once finalized, drop
      // them — appending to the spool, growing the post-paste accumulator, or
      // mutating timing state is all pointless after finish has settled.
      if (finalized) return;
      // node-pty surfaces output as already-decoded UTF-8 strings via
      // shellService's onData hook (StringDecoder handles multi-byte
      // boundaries internally), so `data` is a string here in normal use.
      // The String(...) coerces defensively in case a future caller wires
      // a Buffer-emitting encoding.
      const text = typeof data === 'string' ? data : String(data);
      const stripped = streamingStrip(text);
      pushRaw(text);
      // Accumulate the ANSI-STRIPPED chunk (not the raw text): the paste marker
      // is rendered with absolute-column cursor moves between glyphs, so it only
      // matches after stripping (see countPasteMarkers). Appending raw text here
      // — as this did before #1229 — left the marker unmatchable and the fast
      // path dead.
      pasteController?.ingestChunk(stripped);
      // Observe claude's input-readiness / folder-trust chrome (before the
      // paste). Raw `text` carries the bracketed-paste-mode toggles; `stripped`
      // carries the visible footer/trust text. Only AFTER the CLI command is
      // injected — earlier toggles belong to shell startup and the readiness
      // probe, not to claude.
      if (!promptSentAt && commandInjected) inputReady.observe(text, stripped);
      // Latch codex's MCP-server boot banner during startup (codex sessions only;
      // before the prompt is submitted, so codex's own boot chrome — not the
      // echoed prompt — is what trips it). Gates the extended, boot-aware
      // paste-retry budget below. Observing until promptSubmittedAt (set only on a
      // CONFIRMED paste) means a banner that arrives AFTER an early swallowed paste
      // still latches — the swallowed paste never sets promptSubmittedAt.
      if (isCodexSession && !promptSubmittedAt && stripped && !mcpBoot.active) mcpBoot.observe(stripped);
      const now = Date.now();
      // Once the prompt is SUBMITTED (Enter sent — not merely pasted), watch for
      // proof the model is actually working. Keying on promptSubmittedAt (not
      // promptSentAt) excludes the prompt echo rendered during the paste→Enter
      // window. The TUI repaints chrome continuously even with an unsent prompt,
      // so we can't trust mere PTY activity — only the working counter advancing
      // across wall-clock time confirms real work (a static echo's counters all
      // arrive together and fail the time-span). Gates idle-complete (#1229).
      if (promptSubmittedAt && stripped && !workActivity.active) workActivity.observe(stripped, now);
      // Detect entry into the swarm Phase C merge queue so the idle reaper can
      // extend its grace window across the silent per-PR CI waits (issue #2074).
      // Latches once — observe only until active, then announce the transition.
      if (promptSubmittedAt && stripped && !mergeQueue.active && mergeQueue.observe(stripped)) {
        emitLog('info', `TUI agent ${agentId} entered merge queue — idle reaper extended to ${Math.round(MERGE_QUEUE_IDLE_TIMEOUT_MS / 60000)}min`, { agentId, phase: 'merge-queue' });
        await updateAgent(agentId, { metadata: { phase: 'merge-queue' } });
      }
      // Detect entry into a do:release/do:pr/do:rpr multi-reviewer loop so the
      // idle reaper can extend its grace across a slow reviewer's silent
      // working stretch (see reviewLoop declaration above for the incident).
      if (promptSubmittedAt && stripped && !reviewLoop.active && reviewLoop.observe(stripped)) {
        emitLog('info', `TUI agent ${agentId} entered review loop — idle reaper extended to ${Math.round(REVIEW_LOOP_IDLE_TIMEOUT_MS / 60000)}min`, { agentId, phase: 'review-loop' });
        await updateAgent(agentId, { metadata: { phase: 'review-loop' } });
      }
      // Detect outstanding background shell commands so the idle reaper can
      // extend its grace across the fully-silent stretch while the agent waits
      // to be re-invoked on their completion (see backgroundShell declaration).
      // Deliberately does NOT set `metadata.phase` — unlike merge-queue and
      // review-loop, "has background work" is not a phase of the run, and
      // overwriting the phase here would clobber a more specific one.
      if (promptSubmittedAt && stripped && !backgroundShell.active && backgroundShell.observe(stripped)) {
        emitLog('info', `TUI agent ${agentId} has background shells outstanding — idle reaper extended to ${Math.round(BACKGROUND_SHELL_IDLE_TIMEOUT_MS / 60000)}min`, { agentId });
      }
      lastOutputAt = now;
      if (firstOutputAt === null) firstOutputAt = lastOutputAt;

      if (!hasStartedWorking) {
        hasStartedWorking = true;
        await updateAgent(agentId, { metadata: { phase: 'working' } });
        emitLog('info', `TUI agent ${agentId} working...`, { agentId, phase: 'working' });
      }

      // The TUI is a *screen*, not a log: every progress tick repaints the
      // status line (`thinking with…`, token counters, footer) and gets
      // re-captured if we parse it line-by-line. The attached shell session
      // shows the live TUI faithfully — see-the-shell is the user-facing
      // path. We still spool the raw stream to raw.txt for error analysis
      // on failure, and we detect early "command not found" so a missing
      // binary fails fast instead of idling.
      //
      // While a grace window is open, every chunk is evidence about whether the
      // provider came back; the gate closes itself the moment it is. The clock
      // is load-bearing — it lets the gate discount the echo of a prompt IT just
      // re-pasted (see SELF_CLEARING_RESUBMIT_ECHO_MS).
      if (selfClearingGate.observe(stripped, now)) {
        appendLine(`✅ Provider signal cleared — ${tuiConfig.command} is generating again; continuing the run`);
      }

      const fallbackSignal = detectImmediateFallbackSignal(stripped);
      // Branch on the SIGNAL's own grace window, never on gate state: the
      // detector buffers ~512 chars, so a banner keeps matching for many chunks
      // after it has scrolled off. Reading gate state here would let one of those
      // stale matches fall through to an immediate kill the moment the gate
      // closed. A graceful signal can only ever arm a window (or be ignored,
      // when one is already open or the provider already recovered).
      if (fallbackSignal?.graceMs > 0) {
        if (selfClearingGate.arm(fallbackSignal, now)) {
          appendLine(`⏳ Provider signal (self-clearing): ${fallbackSignal.message} — holding the session up to ${Math.round(fallbackSignal.graceMs / 1000)}s for it to clear`);
        }
      } else if (fallbackSignal) {
        await failOverToFallback(fallbackSignal);
        return;
      }

      if (!promptSentAt) {
        const lowerStripped = stripped.toLowerCase();
        if (lowerStripped.includes('command not found') && lowerStripped.includes(commandName.toLowerCase())) {
          // finish() uses try/finally internally: finalizeAgent errors re-throw after
          // cleanup, so finish() can reject. The outer try/catch in handleData already
          // handles any such rejection via emitLog — no additional .catch() needed here.
          await finish({
            success: false,
            exitCode: 127,
            error: `TUI command not found: ${tuiConfig.command}`,
            reason: 'command-not-found'
          });
        }
      }
    } catch (err) {
      emitLog('error', `TUI agent ${agentId} handleData failed: ${err?.message || err}`, { agentId });
    }
  };

  const handleExit = async ({ exitCode, killed, signal = null }) => {
    if (finalized) return;
    // A host restart reaches here as a plain PTY exit (pm2's TreeKill walks
    // portos-server's descendants), which the `success` reading below would
    // record as a completed run. finish() intercepts that case — see its
    // host-shutdown guard (#3202).
    const code = typeof exitCode === 'number' ? exitCode : killed ? 130 : 0;
    // A signal-terminated shell reports the wait-status exit code — 0 for a
    // plain SIGTERM/SIGHUP — so `code === 0` alone cannot mean "finished
    // normally". Treat any signal as an abnormal end. This is the backstop for
    // the case the host-shutdown guard can't cover: a SIGKILL'd or crashed
    // portos-server never runs its shutdown handler, so the flag is never set,
    // yet the agent's PTY still dies with us (#3202).
    const signaled = !!signal;
    const outcome = killed
      ? { error: 'TUI shell session was killed', reason: 'shell-killed' }
      : signaled
        ? { error: `TUI shell session was terminated by signal ${signal} — the run was cut short, not completed`, reason: 'shell-signaled' }
        : { error: null, reason: 'shell-exit' };
    await finish({ success: code === 0 && !killed && !signaled, exitCode: code, ...outcome });
  };

  // Repo-owner-pinned GH_TOKEN for the agent's own `gh pr create` (see
  // resolveForgeTokenEnv). Resolved here since createAgentTuiSession is sync.
  // Skip when the provider supplies its own GH_TOKEN/GITHUB_TOKEN so its explicit
  // credential wins.
  const forgeTokenEnv = providerSuppliesGithubToken(provider)
    ? {}
    : await git.resolveForgeTokenEnv(cwd);

  // A spawn failure here (a runner 400 for a command missing from its allowlist,
  // an unreachable runner, a PTY that won't open) used to propagate raw out of
  // spawnTuiAgent. The caller in subAgentSpawner only logs it, so the agent
  // record stayed `initializing` with the real error nowhere but the server log
  // until the zombie reaper finalized it ~a minute later as the generic "Agent
  // process terminated unexpectedly". Finalize it here instead, carrying the
  // spawn error into the record. Runs outside the Express request lifecycle, so
  // there is no middleware to bubble to.
  //
  // The REASON splits on which half failed. A durable-runner throw is a
  // runner-hop failure (a `fetch failed` mid-restart, or a runner refusal) —
  // no process ever existed, so it is `spawn-rejected` (non-actionable →
  // retry), mirroring the direct-CLI runner path's deliberate split in
  // agentLifecycle.js and the registration in COMPLETION_REASON_ANALYSES. A
  // LOCAL PTY that won't open keeps the actionable `spawn-error`: that is a
  // real host/config problem a retry cannot repair.
  let session;
  try {
    session = await createAgentTuiSession({
      agentId,
      taskId: task.id,
      provider,
      model,
      tuiConfig,
      cwd,
      forgeTokenEnv,
      doneSentinelPath,
      useDurableRunner,
      onData: handleData,
      onExit: handleExit,
      onInitialCommandSent: () => { commandInjected = true; },
    });
  } catch (err) {
    const message = err?.message || String(err);
    appendLine(`❌ Failed to start ${provider.name || provider.id} TUI: ${message}`);
    await finish({
      success: false,
      exitCode: 1,
      error: `Failed to start TUI session: ${message}`,
      reason: useDurableRunner ? 'spawn-rejected' : 'spawn-error',
    });
    return null;
  }
  sessionId = session.sessionId;

  if (!sessionId) {
    await finish({ success: false, exitCode: 1, error: 'Failed to create TUI shell session', reason: 'spawn-error' });
    return null;
  }

  const { ptyProcess, pid } = session;
  if (pid) {
    registerSpawnedAgent(pid, {
      fullCommand: tuiConfig.commandLine,
      agentId,
      taskId: task.id,
      model,
      workspacePath,
      prompt: (task.description || '').substring(0, 500)
    });
  }

  // Send the bracketed-paste prompt only after the TUI has finished its initial
  // repaint and gone quiet — pasting during the banner/loading screen is the
  // failure mode that left the input empty. The `\r` is split from the paste
  // write because a fixed delay races Claude Code's paste-commit on large
  // prompts; instead we poll Claude Code's raw output for its
  // `[Pasted text #N +M lines]` marker, then wait an extra
  // PASTE_TO_ENTER_MIN_DELAY_MS before submitting. A fallback timer fires
  // the Enter unconditionally if the marker never appears (very small
  // prompts won't trigger the marker). All timers are tracked so finish()
  // can cancel pending writes if the agent ends mid-handshake.
  const startedAt = Date.now();

  // Finalize a startup failure WITHOUT pasting — surfacing whatever the CLI
  // printed (raw.txt tail) so the real cause is visible instead of a wedged
  // shell. Shared by the liveness guard (command exited) and the readiness cap
  // (claude never showed its input prompt).
  const finishStartupFailure = async (reason, summary) => {
    if (finalized) return;
    // Flush any debounced raw-PTY chunks first so the captured tail includes
    // the CLI's most recent output (e.g. claude's final error before exiting),
    // not just whatever happened to be on disk before the last 250ms window.
    await flushRaw().catch(() => {});
    const raw = await readFile(rawFile, 'utf8').catch(() => '');
    const tail = raw
      ? stripAnsi(raw).split('\n').map((s) => s.trimEnd()).filter(Boolean).slice(-12).join('\n')
      : '';
    appendLine(`❌ ${summary}`);
    await finish({
      success: false,
      exitCode: 1,
      error: `${summary}${tail ? `\nCaptured output:\n${tail}` : ' No output was captured.'}`,
      reason,
    });
  };

  // Owns the paste-attempt counter, the post-paste accumulator, the paste
  // timers and the max-runtime/wrap-up machinery — see
  // createPasteRetryController's own comment for why that cluster lives
  // outside this closure. `isFinalized`/`markPromptSent`/`markPromptSubmitted`
  // are accessors into THIS closure's `finalized`/`promptSentAt`/
  // `promptSubmittedAt`, which handleData and the idle reaper below still read
  // directly.
  pasteController = createPasteRetryController({
    agentId,
    sessionId,
    pid,
    useDurableRunner,
    prompt,
    tuiConfig,
    cwd,
    agentDir,
    mcpBoot,
    appendLine,
    sentinelPresent,
    isFinalized: () => finalized,
    markPromptSent: () => { promptSentAt = Date.now(); },
    markPromptSubmitted: () => { if (promptSubmittedAt === null) promptSubmittedAt = Date.now(); },
    finish,
    finishStartupFailure,
  });

  // Claude Code renders a startup banner and (in unfamiliar folders) a
  // folder-trust gate before its input box exists, and the old "saw output then
  // went idle" heuristic fired during those lulls — pasting the prompt into the
  // banner / trust menu / a returned shell. For claude we instead gate on its
  // POSITIVE input-ready footer (see createInputReadyTracker), auto-confirm the
  // trust gate, and NEVER blind-paste: if the prompt never appears we surface a
  // failure. Other TUI providers keep the original idle heuristic + deadline.
  //
  // Antigravity (agy) gets the SAME positive gate (issue #2705), but agy alone
  // needs a second signal on top of paste mode: unlike claude it enables
  // bracketed paste on ALT-SCREEN ENTRY, ~200ms after launch, while it is still
  // signing in and before its trust gate has even painted. Gating on paste mode
  // alone therefore raced agy's sign-in round trip — when that outran the 2.5s
  // prompt delay the prompt was pasted into the still-pending trust gate, which
  // swallowed it and all three retries (`paste-not-rendered`). agy's composer
  // footer (AGY_INPUT_READY_PATTERN) renders only after the trust gate is
  // resolved, so requiring it orders the two correctly. agy DOES have a
  // first-run folder-trust gate ("Do you trust the contents of this project?")
  // and `--dangerously-skip-permissions` does NOT bypass it — the auto-confirm
  // branch below is load-bearing, matching its "Yes, I trust this folder" option
  // via TUI_TRUST_PROMPT_PATTERN. If agy ever fails to signal ready, the
  // requireInputReady path fails fast with a surfaced startup error instead of
  // silently idle-reaping.
  const requireInputReady = isClaudeCommand(tuiConfig.command) || isAntigravityCommand(tuiConfig.command);
  // sendPrompt / finishStartupFailure are async and dispatched fire-and-forget
  // from the interval below. A setInterval callback can't await, and an
  // unhandled rejection there (e.g. a finalizeAgent throw inside finish())
  // would crash the process — the callback-boundary hazard CLAUDE.md calls out.
  // Wrap each floating call so a rejection is logged, not thrown.
  const safeSendPrompt = (reason) => pasteController.sendPrompt(reason).catch((err) =>
    emitLog('error', `TUI agent ${agentId} sendPrompt(${reason}) failed: ${err?.message || err}`, { agentId }));
  const safeFinishStartupFailure = (reason, summary) => finishStartupFailure(reason, summary).catch((err) =>
    emitLog('error', `TUI agent ${agentId} finishStartupFailure(${reason}) failed: ${err?.message || err}`, { agentId }));
  const promptTimer = setInterval(() => {
    if (finalized || promptSentAt) {
      clearInterval(promptTimer);
      return;
    }
    const now = Date.now();
    const elapsed = now - startedAt;

    if (requireInputReady) {
      // Auto-confirm the first-run "trust this folder?" gate (claude's and agy's
      // both default to "Yes, I trust") so claims can run in fresh worktrees.
      // Send Enter once.
      if (inputReady.needsTrust && !trustAccepted) {
        trustAccepted = true;
        shellService.writeToSession(sessionId, '\r');
        appendLine(`📟 Auto-confirmed ${tuiConfig.command} folder-trust prompt for session ${sessionId.slice(0, 8)}`);
        return;
      }
      // Decline claude's "make auto mode your default permission mode?" offer
      // (v2.1.233+). Unlike the trust gate this one paints AFTER the composer is
      // live, so it swallows the paste and every retry unless it is cleared
      // first — see TUI_AUTO_MODE_PROMPT_PATTERN. Arrow-down + Enter rather than
      // the digit `2`: it lands on "No, keep don't ask" under both of Ink's
      // selection models (digit-immediate-select and navigate-then-confirm),
      // whereas a bare `\r` would accept the highlighted option 1 and rewrite the
      // user's global permission default.
      if (inputReady.needsAutoModeChoice && !autoModeDeclined) {
        autoModeDeclined = true;
        shellService.writeToSession(sessionId, '\x1b[B\r');
        inputReady.ackAutoModeChoice();
        appendLine(`📟 Declined ${tuiConfig.command} auto-mode default offer for session ${sessionId.slice(0, 8)}`);
        return;
      }
      if (inputReady.ready && elapsed >= tuiConfig.promptDelayMs) {
        safeSendPrompt('input-ready');
        clearInterval(promptTimer);
        return;
      }
      // Never blind-paste for claude: if the input prompt never showed within
      // the cap, finalize a startup failure with the captured output.
      if (elapsed >= TUI_INPUT_READY_DEADLINE_MS) {
        clearInterval(promptTimer);
        safeFinishStartupFailure(
          'tui-not-ready',
          `${tuiConfig.command} did not present an input prompt within ${Math.round(TUI_INPUT_READY_DEADLINE_MS / 1000)}s, so no prompt was sent.`,
        );
      }
      return;
    }

    if (elapsed >= PASTE_DEADLINE_MS) {
      safeSendPrompt('fallback');
      clearInterval(promptTimer);
      return;
    }
    if (elapsed < tuiConfig.promptDelayMs) return;
    if (firstOutputAt === null) return;
    if (now - lastOutputAt < READY_IDLE_THRESHOLD_MS) return;
    safeSendPrompt('ready');
    clearInterval(promptTimer);
  }, READY_POLL_INTERVAL_MS);

  const idleTimer = setInterval(() => {
    if (finalized) return;
    // Resolve an expired grace window. Checked BEFORE the promptSentAt gate
    // below: the banner can paint during startup too, and a run stalled there
    // would otherwise hold the window forever.
    const expired = selfClearingGate.takeExpired(Date.now());
    if (expired) {
      // setInterval can't await, and an unhandled rejection here would crash the
      // process (the callback-boundary hazard CLAUDE.md calls out).
      failOverToFallback(expired).catch((err) =>
        emitLog('error', `TUI agent ${agentId} deferred fallback finish failed: ${err?.message || err}`, { agentId }));
      return;
    }
    // A session waiting out a provider handshake is silent by definition — but it
    // is NOT idle, and letting the reaper finalize it would be far worse than the
    // premature kill this window replaced: with no `.agent-done` sentinel the
    // idle path reports `idle-complete` SUCCESS for a run that never produced a
    // token. Safely bounded — the window carries its own deadline, resolved just
    // above, which fires strictly before any idle window it outlasts.
    //
    // The wait is ACTIVE: re-send the prompt on the gate's cadence, because the
    // banner is the provider REJECTING this submission (see resubmitAfterSignal).
    if (selfClearingGate.armed) {
      resubmitAfterSignal();
      return;
    }
    if (!promptSentAt) return;
    // Don't reap a session that just received real input — a human pasting
    // into the Shell page, or our own auto-paste. A big bracketed paste can
    // sit in a silent reflow/commit window with no PTY output yet, which
    // looks identical to "idle" to this timer otherwise (same class of bug
    // as #2074/#2084, but for a live paste instead of a merge-queue/
    // review-loop wait). Gated on INPUT RECENCY, not "is a socket attached" —
    // a regular (non-external) Shell session keeps its socket bound after the
    // viewer navigates away (only external one-shot runs get released via
    // `shell:release-views`), so "attached" would permanently suppress
    // idle-complete for any agent glanced at once in the Shell UI. Recency
    // naturally expires once nobody is actually interacting.
    if (sessionId) {
      const lastInputAt = shellService.getLastInputAt(sessionId);
      if (lastInputAt && Date.now() - lastInputAt < PASTE_INPUT_GRACE_MS) return;
    }
    const runtime = Date.now() - promptSentAt;
    const idle = Date.now() - lastOutputAt;
    if (runtime < DEFAULT_TUI_MIN_RUNTIME_MS) return;
    // We track post-paste activity via lastOutputAt instead of parsed-line
    // counts because per-line PTY capture is intentionally disabled for TUI
    // agents — see handleData.
    if (lastOutputAt <= promptSentAt) return;
    // While the agent is in a swarm Phase C serialized merge queue, per-PR CI
    // re-runs go silent for minutes at a time; extend the idle grace so a
    // still-working orchestrator isn't reaped mid-merge (issue #2074). The
    // extended window still bounds a genuinely-dead orchestrator's reap.
    // Which verdict this tick warrants — the whole branch matrix, as a pure
    // function so it can be unit-tested against the real implementation instead
    // of a drifting inline copy. This body just executes what it returns.
    const decision = decideIdleReap({
      idle,
      baseIdleTimeoutMs: tuiConfig.idleTimeoutMs,
      mergeQueueActive: mergeQueue.active,
      reviewLoopActive: reviewLoop.active,
      backgroundShellActive: backgroundShell.active,
      prFollowUpMerged: followUpPr.merged,
      workActive: workActivity.active,
      rendersCounter: rendersWorkCounter(commandName),
    });
    const { effectiveIdleTimeoutMs } = decision;
    // Past the BASE idle window a PR follow-up asks the forge whether its one
    // deliverable already landed (throttled, non-blocking — the reading is read
    // synchronously by the NEXT tick's decision). Keyed on the base window, not
    // the extended one, precisely because the extended one is the bug: a merge
    // follow-up latches the merge-queue grace off its own echoed prompt.
    if (idle >= tuiConfig.idleTimeoutMs) refreshFollowUpPrState();
    // Once within the LEAD window of the (possibly extended) reap deadline, keep
    // a reachability reading fresh (throttled, non-blocking) so the gate below
    // can read it synchronously and won't reap an agent that's only silent
    // because the machine lost internet. Gating on the effective deadline (not a
    // fixed lead off the base window) keeps a long merge-queue/review-loop idle
    // from probing for its whole 15-min window.
    if (idle >= effectiveIdleTimeoutMs - CONNECTIVITY_PROBE_LEAD_MS) refreshConnectivity();
    if (decision.action === 'reap') {
      // The follow-up's PR is MERGED and the session has gone quiet: the
      // deliverable is provably in hand, so finalize on it. Deliberately ahead
      // of the offline defer below — that gate exists because silence is
      // ambiguous, and this verdict does not rest on silence.
      if (decision.reason === 'pr-follow-up-merged') {
        finish({ success: true, exitCode: 0, reason: 'pr-follow-up-merged' }).catch(err => {
          emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
        });
        return;
      }
      // An internet outage silences a live TUI exactly like a hung or finished
      // agent looks to this timer. If a recent probe says we're offline, DEFER
      // the reap — the agent is only blocked on the network and resumes when it
      // returns. (The max-runtime backstop still bounds a very long outage.)
      if (!connectivity.online) {
        if (!connectivity.loggedOffline) {
          emitLog('info', `📡 TUI agent ${agentId} idle past its window but the machine appears offline — deferring reap until connectivity returns`, { agentId });
          connectivity.loggedOffline = true;
        }
        return;
      }
      connectivity.loggedOffline = false;
      // Reaped AFTER the extended merge-queue grace elapsed: the orchestrator
      // almost certainly died mid-merge with PRs opened/merged-but-uncleaned.
      // Surface it as a needs-manual-finish FAILURE rather than the silent
      // `status: completed` that hid the half-done merge queue (issue #2074).
      if (decision.reason === 'merge-queue-idle-timeout') {
        finish({
          success: false,
          exitCode: 1,
          error: `TUI agent idled out after ${Math.round(effectiveIdleTimeoutMs / 60000)}min in the merge queue — it likely died mid-merge; check for open or merged-but-uncleaned PRs and finish them manually.`,
          reason: 'merge-queue-idle-timeout',
        }).catch(err => {
          emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
        });
        return;
      }
      // Reaped AFTER the extended review-loop grace elapsed: a reviewer
      // (copilot/codex/agy/claude/ollama/@<login>) likely hung, or the wait
      // simply exceeded budget. Surface it as a needs-manual-finish FAILURE
      // rather than the silent `status: completed` that let PR #2084 sit
      // open+unmerged for hours while agent-61508f36 looked "done".
      if (decision.reason === 'review-loop-idle-timeout') {
        finish({
          success: false,
          exitCode: 1,
          error: `TUI agent idled out after ${Math.round(effectiveIdleTimeoutMs / 60000)}min waiting inside the multi-reviewer loop — a reviewer may have hung or the wait exceeded budget; check the PR's review/merge state and finish manually.`,
          reason: 'review-loop-idle-timeout',
        }).catch(err => {
          emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
        });
        return;
      }
      // Distinguish a real (sentinel-less) completion from a never-submitted
      // prompt that just idled out. `lastOutputAt > promptSentAt` only proves
      // the TUI repainted SOMETHING — banner/status chrome churns even with the
      // prompt sitting unsent. The #1229 failure mode (prompt never submitted,
      // zero work done) must be recorded as a FAILURE so the orchestrator doesn't
      // treat a no-op run as done — but the work-counter signal exists ONLY on
      // Claude Code / Codex. On a provider that never renders the counter
      // (Antigravity/Gemini), its absence proves nothing, so we must preserve the
      // original permissive idle-complete=success there (else every sentinel-less
      // completion on those providers would falsely fail). So: downgrade to
      // failure only when the provider DOES render the counter and we never saw
      // it advance.
      //
      // Issue #2191 extension: even when workActivity.active is true, the model
      // may have "worked" (made tool calls, printed output) without actually
      // writing any files — e.g. rambled, made invalid tool calls, or hit an
      // error. Check the worktree for evidence of actual changes: if the
      // worktree is clean (no git status changes), mark as failed so the
      // orchestrator doesn't treat a no-op as done. Capture the diff into the
      // agent archive dir before cleanup so post-mortems can see what (if
      // anything) was left behind.
      if (decision.reason === 'idle-no-activity') {
        // Capture any uncommitted changes for post-mortem analysis
        captureWorktreeDiff(cwd, agentDir).catch(() => {});
        finish({
          success: false,
          exitCode: 1,
          error: 'TUI agent idled out with no sign of work — the prompt likely never submitted (no working indicator ever appeared after submit).',
          reason: 'idle-no-activity',
        }).catch(err => {
          emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
        });
      } else {
        // Gate idle-complete success on evidence of work in the worktree.
        // An agent that shows activity counters but makes no file changes
        // (rambled, invalid tool calls, hit an error) should fail, not succeed.
        //
        // "Evidence of work" is a dirty tree OR a commit made during the run,
        // not a dirty tree alone — see worktreeHasWorkEvidence for why.
        //
        // ...UNLESS the task declares its work product isn't files (#3102).
        // `worktreeChangesExpected: false` marks a task type whose deliverable
        // lands OUTSIDE the repo — a reference-watch run against a GitHub/GitLab/
        // JIRA work tracker files issues and, per its prompt, edits no application
        // code, so a clean tree is the SUCCESS shape and this gate would fail a run
        // that did its whole job. Absent/`true` keeps every code-editing task type
        // on today's behavior; the `workActivity.active` signal above still
        // distinguishes "prompt never submitted" → idle-no-activity either way.
        const worktreeChangesExpected = !isFalsyMeta(task?.metadata?.worktreeChangesExpected);
        // A PROGRAMMATIC-I/O run answers a DIFFERENT question, not a relaxed
        // version of this one. Its deliverable is the structured `.agent-done`
        // payload an output hook consumes — a layered-intelligence run reasons
        // over the app's goals and returns JSON that a deterministic step files as
        // one tracker issue — and its prompt FORBIDS touching the repo, so
        // worktree evidence measures nothing about it. Asking anyway blamed the
        // run for exactly the thing it was told not to do ("zero file changes"),
        // while the honest question is right there: did the payload land?
        // Usually it hasn't — the sentinel watcher below finalizes within
        // DONE_POLL_INTERVAL_MS of `.agent-done` appearing, so a run that reached
        // the reaper is normally one whose payload never materialized (the model
        // printed its JSON into the TUI instead of writing the file, #3640).
        // `sentinelPresent()` and not `false` because the two timers CAN land on
        // the same tick, and this one is registered first: an agent that wrote its
        // sentinel in the last idle window would otherwise be failed for a clean
        // tree by the interval that happened to run before the watcher.
        //
        // Deliberately NOT folded into `worktreeChangesExpected`: exempting it
        // from the gate would score that same run a PASS with no proposal filed,
        // trading a misleading failure for a silent one.
        const programmaticIo = isProgrammaticIoTaskType(resolveTaskHookType(task));
        (async () => {
          const delivered = programmaticIo
            ? sentinelPresent()
            : !worktreeChangesExpected || await worktreeHasWorkEvidence(cwd, startedAt);
          // Capture any uncommitted changes for post-mortem analysis regardless
          // of outcome — the diff is useful even on success for debugging, and is
          // a no-op on a clean tree.
          await captureWorktreeDiff(cwd, agentDir).catch(() => {});
          if (!delivered) {
            finish({
              success: false,
              exitCode: 1,
              error: programmaticIo
                ? 'TUI agent idled out without writing its .agent-done payload — this task type delivers structured output, not file changes, and nothing was left for the output hook to consume.'
                : 'TUI agent idled out with zero uncommitted file changes and no new commits — the model may have processed but produced no work.',
              reason: programmaticIo ? 'idle-no-deliverable' : 'idle-no-changes',
            }).catch(err => {
              emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
            });
          } else {
            finish({ success: true, exitCode: 0, reason: 'idle-complete' }).catch(err => {
              emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
            });
          }
        })().catch(err => {
          emitLog('error', `TUI agent ${agentId} idle-complete check failed: ${err.message}`, { agentId });
          // Fall back to success if the check itself failed (don't block on git)
          finish({ success: true, exitCode: 0, reason: 'idle-complete' }).catch(() => {});
        });
      }
    }
  }, 5000);

  // Sentinel-file watcher. The agent's prompt instructs it to write
  // .agent-done in the workspace after running /simplify + /do:pr and then
  // stop (it does NOT `/quit` — that is a UI command it can't invoke). This
  // poll is the PRIMARY finalize path: it fires finish() within DONE_POLL_
  // INTERVAL_MS of the sentinel appearing, and finish()'s own cleanup kills
  // the still-running TUI session. The actual sentinel READ happens in finish()
  // (via ingestDoneSentinel) so the resolution is captured no matter which path
  // finalizes. Idle-complete is the fallback for a non-complying agent that
  // never writes the sentinel.
  const doneSentinelTimer = doneSentinelPath ? setInterval(() => {
    try {
      if (finalized) return;
      if (!sentinelPresent()) return;
      clearInterval(doneSentinelTimer);
      finish({ success: true, exitCode: 0, reason: 'agent-signaled-done' }).catch(err => {
        emitLog('error', `Failed to finalize TUI agent ${agentId} after sentinel: ${err.message}`, { agentId });
      });
    } catch (err) {
      console.error(`❌ doneSentinelTimer interval callback failed: ${err.message}`);
    }
  }, DONE_POLL_INTERVAL_MS) : null;

  activeAgents.set(agentId, {
    process: ptyProcess || { kill: () => shellService.killSession(sessionId) },
    taskId: task.id,
    startedAt: Date.now(),
    runId,
    pid,
    providerId: provider.id,
    executionId,
    laneName,
    tuiSessionId: sessionId,
    idleTimer,
    promptTimer,
    doneSentinelTimer
  });

  // Identify which TUI binary this session is running so consumers can gate
  // features that aren't universal — e.g. only Claude Code supports
  // bracketed-paste injection of post-spawn BTW messages; codex/gemini/lm-studio
  // TUIs don't.
  const tuiKind = commandName.toLowerCase();
  await updateAgent(agentId, {
    pid,
    metadata: {
      phase: 'working',
      executionMode: useDurableRunner ? 'runner-tui' : 'tui',
      tuiSessionId: sessionId,
      tuiCommand: tuiConfig.commandLine,
      tuiKind,
      tuiIdleTimeoutMs: tuiConfig.idleTimeoutMs,
      tuiMaxRuntimeMs: tuiConfig.maxRuntimeMs
    }
  });

  appendLine(`📟 TUI session started: ${sessionId.slice(0, 8)} (${tuiConfig.commandLine})`);
  appendLine(`💡 Open the Shell tab for live TUI output — this panel only logs lifecycle events.`);
  return agentId;
}
