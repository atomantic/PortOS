/**
 * Agent TUI session controller
 *
 * The live state machine behind one TUI agent run: session phase, prompt
 * delivery and its retry ladder, the completion-sentinel watcher, the
 * provider-signal / idle / nudge gates, and the ONE teardown path every ending
 * shares.
 *
 * Extracted from `agentTuiSpawning.js` (#8021) so a change to one provider's
 * readiness behaviour no longer means reasoning through sentinel completion,
 * PTY teardown, merge-gate handling and the idle/retry timers in the same
 * closure. `agentTuiSpawning.js` stays the public adapter: it builds the launch
 * shape, opens the PTY, and hands this controller the seams below.
 *
 * Everything that touches another SERVICE is injected, never imported — that is
 * what keeps this module a leaf (no edge back into `agentLifecycle.js` or the
 * rest of the spawn cluster) and what makes the state machine drivable in a
 * test without a live PTY:
 *
 *   `spooler`       output spooling (parsed lines + raw PTY bytes)
 *   `session`       PTY/session I/O, keyed by the sessionId this controller owns
 *   `persistence`   agent-record writes, the run ledger, the active-run entry
 *   `sentinel`      `.agent-done` presence / read / removal / watch
 *   `finalization`  the shared finalize sequence, failure analysis, cleanup
 *   `probeMergeGatePr`  the forge lookup behind the Merge Gate contract check
 *
 * The pure predicates it keeps as direct imports (handshake gates, ANSI
 * stripping, error detectors, the merge-gate decision table) are leaves with no
 * path back into this cluster.
 */

import { readFile } from 'fs/promises';
import { emitLog } from '../cosEvents.js';
import { HOST_SHUTDOWN_REASON } from '../../lib/hostShutdown.js';
import { missingSentinelLogMessage, parseSentinelPayload } from '../../lib/agentSentinel.js';
import { SENTINEL_COMPLETION_MARKER } from '../../lib/agentOutputMarkers.js';
import { prClaimWasVerified } from '../../lib/prDisposition.js';
import { resolveMergeGateVerdict, buildMergeGateReprompt } from '../../lib/mergeGateContract.js';
import { createStreamingAnsiStripper, stripAnsi } from '../../lib/ansiStrip.js';
import { createImmediateFallbackSignalDetector, createLocalRuntimeOomDetector } from '../../lib/aiToolkit/errorDetection.js';
import { isAntigravityCommand } from '../../lib/antigravity.js';
import { isCodexCommand } from '../../lib/codex.js';
import { isClaudeCommand } from '../../lib/providerModels.js';
import {
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  PASTE_MARKER_POLL_MS,
  countPasteMarkers,
  createSelfClearingSignalGate,
  createOomNudgeGate,
  createRetryStallGate,
  createToolPermissionGate,
  TOOL_PERMISSION_DECLINE_MAX,
  TOOL_PERMISSION_NUDGE_TEXT,
  OOM_NUDGE_MAX_ATTEMPTS,
  OOM_NUDGE_TEXT,
  createStallNudgeGate,
  STALL_NUDGE_MAX_ATTEMPTS,
  STALL_NUDGE_TEXT,
  STALL_NUDGE_MAX_TOTAL,
  createMcpBootTracker,
  MCP_BOOT_PASTE_DEADLINE_MS,
  MCP_BOOT_PASTE_RETRY_DELAY_MS,
  createInputReadyTracker,
  createStartupDialogAnswers,
  answerStartupDialogs,
  AGY_INPUT_READY_PATTERN,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  PASTE_COMMIT_PATIENCE_MS,
  CODEX_COMPOSER_READY_PATTERN,
  POST_PASTE_BUFFER_CAP,
  scheduleSubmitEnters,
  PASTE_DEADLINE_MS,
  TUI_INPUT_READY_DEADLINE_MS,
  PASTE_VERIFY_POLL_MS,
  PASTE_VERIFY_WINDOW_MS,
  PASTE_RETRY_MAX_ATTEMPTS,
  PASTE_RETRY_BASE_DELAY_MS,
  extractVerifiablePromptPrefix,
  isPasteConfirmed,
  isPasteCommitted,
  SUBMIT_KEY,
  detectMissingTuiBinary,
} from '../../lib/tuiHandshake.js';

// Agent-specific timing/lifecycle constants (not shared with the one-shot
// runner — agents stay alive much longer and write a sentinel file when done).
const PROVIDER_SIGNAL_POLL_MS = 5000;

// Paste + submit-Enter retry machinery for the controller's prompt delivery.
// Separated so retries don't re-run the liveness guard or re-set the outer
// promptSentAt (see `sendPrompt` below) — the cluster the spawner's own
// comments already described as one cohesive concern. Owns the paste-attempt
// counter, the post-paste accumulator, the paste-marker/verify timers, and the
// submit-Enter backstop timer.
//
// `isFinalized`/`markPromptSent`/`markPromptSubmitted` are accessors into the
// controller's own `sessionPhase`/`promptSentAt`/`promptSubmittedAt` — those are
// read by handleData and the provider-signal timer well outside this cluster, so
// they stay owned by the controller and are threaded through rather than
// duplicated here. `finishStartupFailure`/`appendLine` are likewise the
// controller's own closures, passed in rather than re-implemented.
function createPasteRetryController({
  agentId,
  sessionLabel,
  write,
  paste,
  hasLiveChild,
  directLaunch,
  prompt,
  tuiConfig,
  mcpBoot,
  isCodexSession,
  appendLine,
  isFinalized,
  markPromptSent,
  markPromptSubmitted,
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
  const pasteConfirmed = (buffer) =>
    isPasteConfirmed(buffer, { verifiablePrefix, promptMarkerCount });
  // Same evidence, minus isPasteConfirmed's "nothing to verify against" pass —
  // the commit-wait below must keep WAITING while a prompt too short to carry a
  // verifiable prefix has not visibly landed, not treat it as already committed.
  //
  // Memoized on buffer identity because the marker poll re-asks every
  // PASTE_MARKER_POLL_MS for up to PASTE_COMMIT_PATIENCE_MS — ~300 ticks — while
  // a booting codex is silent, and the predicate is three full-buffer regex
  // scans plus two whitespace-stripped copies of it. `postPasteBuffer` is only
  // ever rebound when output actually arrives, so an idle tick is a pointer
  // compare.
  let lastCommitBuffer = null;
  let lastCommitVerdict = false;
  const pasteCommitted = (buffer) => {
    if (buffer !== lastCommitBuffer) {
      lastCommitBuffer = buffer;
      lastCommitVerdict = isPasteCommitted(buffer, { verifiablePrefix, promptMarkerCount });
    }
    return lastCommitVerdict;
  };

  // Bounded post-paste accumulator. Lives from an attempt through its marker /
  // verification windows and any bounded retry backoff, so delayed TUI output
  // can still confirm the paste. Set to '' when an attempt fires; nulled when
  // paste detection resolves, the next attempt replaces it, or the run ends.
  let postPasteBuffer = null;
  let pasteEnterTimer = null;
  let pasteVerifyTimer = null;
  let pasteRetryTimer = null;
  let submitEnterTimer = null;
  let pasteAttempt = 0;
  // Wall-clock of the FIRST paste attempt — the anchor for the MCP-boot-aware
  // retry deadline (retries are time-bounded, not attempt-count-bounded, while
  // codex is still booting its MCP servers).
  let firstPasteStartedAt = null;
  // Guards re-entry the way the outer promptSentAt used to before this state
  // moved here — sendPrompt is this controller's only setter for it now.
  let sent = false;

  /**
   * Re-deliver text into the live session: the whole prompt while a
   * self-clearing provider signal's grace window is open (agy's
   * account-eligibility banner), or the short `continue` nudge that recovers a
   * turn a local-GPU OOM killed (see createOomNudgeGate).
   *
   * The banner is the REJECTION of the submission, not a spinner over an
   * in-flight one: agy discards the prompt, empties its composer and returns to
   * its idle footer, so nothing will generate until something re-asks — which is
   * also what the banner instructs ("try again shortly"). Re-pasting the WHOLE
   * prompt is correct precisely because the composer is empty.
   *
   * Lives here rather than in the controller because this cluster owns
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
  const resubmit = ({ text = prompt, label = 'provider-handshake resubmit' } = {}) => {
    if (isFinalized()) return false;
    // Overwriting a live handle would leak the previous attempt's Enter interval
    // past cancel(); paste returns a fresh one, or false once the session is
    // gone — which is also the "don't bother" answer, since the grace window's
    // deadline still owns the fail-over.
    if (submitEnterTimer) clearInterval(submitEnterTimer);
    const handle = paste(text, { label: `[cosAgents] ${label}` });
    submitEnterTimer = handle || null;
    return !!handle;
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
    // A direct launch — runner mode, or a public-content stage spawned as its
    // own PTY (#6159) — has no launch shell: the TUI IS the PTY process. "Does
    // this pid have a live child?" is then the wrong question (claude may have
    // zero children at paste time) and a TUI exit kills the PTY, firing onExit.
    // Skip the probe there.
    if (!directLaunch && !(await hasLiveChild())) {
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

  const submitPaste = () => {
    if (pasteRetryTimer) {
      clearTimeout(pasteRetryTimer);
      pasteRetryTimer = null;
    }
    markPromptSubmitted();
    submitEnterTimer = scheduleSubmitEnters(
      () => write(SUBMIT_KEY),
      () => isFinalized()
    );
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
    if (pasteRetryTimer) { clearTimeout(pasteRetryTimer); pasteRetryTimer = null; }
    // Start capturing post-paste output. Set BEFORE writing the paste so
    // every chunk that arrives in response gets appended. A failed verification
    // deliberately keeps it through retry backoff so late output is not lost.
    postPasteBuffer = '';
    write(`\x1b[200~${prompt}\x1b[201~`);
    const attemptSuffix = attemptNum > 1 ? ` [attempt ${attemptNum}/${PASTE_RETRY_MAX_ATTEMPTS}]` : '';
    appendLine(`📟 Prompt pasted into TUI session ${sessionLabel} (${reason})${attemptSuffix}`);

    // Confirms the TUI actually received the paste before we submit. The
    // paste-commit marker is authoritative — Claude Code and OpenCode can
    // collapse a multi-line paste into a chip and HIDE the body text, so a
    // literal text check false-negatives on multi-line prompts (real incident
    // 2026-07-05: agent-656efa6e et al. failed `paste-not-rendered` despite
    // Claude's marker being present). Literal-text verification is only the
    // fallback for the markerless path — see isPasteConfirmed.
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
        // Keep the failed attempt's buffer live during the backoff. A busy TUI
        // can paint its authoritative paste marker only after the verification
        // window closes; dropping output in this gap made Codex stack duplicate
        // prompt chips, then falsely report that none had rendered.
        pasteRetryTimer = setTimeout(() => {
          pasteRetryTimer = null;
          if (isFinalized()) return;
          if (pasteConfirmed(postPasteBuffer || '')) {
            postPasteBuffer = null;
            submitPaste();
            return;
          }
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
    // How long THIS attempt waits for the TUI to commit the paste before
    // handing over to the verify/retry budget. Read live rather than captured:
    // codex's MCP-boot banner can latch after the paste went out, and a
    // swallowing codex must not spend the patient window — see
    // PASTE_COMMIT_PATIENCE_MS.
    const commitWaitMs = () => (isCodexSession && attemptNum <= 1 && !mcpBoot.active
      ? PASTE_COMMIT_PATIENCE_MS
      : PASTE_TO_ENTER_FALLBACK_MS);
    pasteEnterTimer = setInterval(() => {
      if (isFinalized()) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        postPasteBuffer = null;
        return;
      }
      const elapsed = Date.now() - pasteSentAt;
      // Submit when EITHER the TUI's paste commit shows up (preferred) or the
      // commit-wait window elapses (covers small prompts that don't render the
      // marker). Waiting on the full commit evidence rather than the marker
      // alone is what lets codex's patient first attempt (PASTE_COMMIT_PATIENCE_MS)
      // exit in ~200ms when the composer was live all along.
      if ((pasteCommitted(postPasteBuffer || '') && elapsed >= PASTE_TO_ENTER_MIN_DELAY_MS)
        || elapsed >= commitWaitMs()) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        // Capture the buffer before clearing, then confirm the paste (issue #2192).
        const commitBuffer = postPasteBuffer || '';
        postPasteBuffer = null;
        // Marker present (or text already visible, or nothing to verify) → the
        // paste landed; submit now. Trusting the marker here is what fixes the
        // multi-line-collapse false negative — Claude hides the pasted body text.
        // pasteConfirmed is a superset of the pasteCommitted exit above, so only
        // the commitWaitMs timeout can fall through to the verification window.
        if (pasteConfirmed(commitBuffer)) {
          submitPaste();
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
            if (confirmed) {
              postPasteBuffer = null;
              submitPaste();
            } else {
              // Preserve the buffer through retry backoff so a delayed marker
              // can still confirm this paste instead of triggering a duplicate.
              postPasteBuffer = verifyBuffer;
              retryOrFailPaste();
            }
          }
        }, PASTE_VERIFY_POLL_MS);
      }
    }, PASTE_MARKER_POLL_MS);
  };

  // handleData's own hook: accumulates PTY output while a paste attempt is
  // awaiting its marker, verification, or retry backoff (see postPasteBuffer
  // above). A no-op the rest of the time.
  const ingestChunk = (stripped) => {
    if (postPasteBuffer === null || !stripped) return;
    // Tail-bounded: see POST_PASTE_BUFFER_CAP for why a few screens is all the
    // commit predicates can use.
    postPasteBuffer = (postPasteBuffer + stripped).slice(-POST_PASTE_BUFFER_CAP);
    // The retry backoff used to be a blind spot: output was discarded after
    // verification failed and before the next attempt began. A late marker or
    // prompt echo still proves the existing paste landed, so submit it now and
    // cancel the duplicate retry.
    if (pasteRetryTimer && pasteConfirmed(postPasteBuffer)) {
      clearTimeout(pasteRetryTimer);
      pasteRetryTimer = null;
      postPasteBuffer = null;
      submitPaste();
    }
  };

  // Stop everything this controller armed. Safe to call unconditionally (a run
  // that ends before any paste was attempted just clears nulls) — see
  // stopRunMachinery's own comment for why every teardown site must go through
  // one chokepoint.
  const cancel = () => {
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    if (pasteVerifyTimer) { clearInterval(pasteVerifyTimer); pasteVerifyTimer = null; }
    if (pasteRetryTimer) { clearTimeout(pasteRetryTimer); pasteRetryTimer = null; }
    if (submitEnterTimer) { clearInterval(submitEnterTimer); submitEnterTimer = null; }
    postPasteBuffer = null;
  };

  return { sendPrompt, resubmit, ingestChunk, cancel };
}

/**
 * Create the live session controller for one TUI agent run.
 *
 * Created BEFORE the PTY exists, because `handleData`/`handleExit` are what the
 * launcher needs to open it. `attachSession()` is the second half: once a
 * session id is known it arms prompt delivery, the provider-signal gates and
 * the sentinel watcher. A run that never gets that far (a spawn throw) still
 * finalizes correctly through `finish()`.
 *
 * @returns {{
 *   handleData: (data: unknown) => Promise<void>,
 *   handleExit: (event: object) => Promise<void>,
 *   markCommandInjected: () => void,
 *   isTerminal: () => boolean,
 *   finish: (outcome: object) => Promise<void>,
 *   attachSession: (session: { sessionId: string, pid: number|null }) => void,
 * }}
 */
export function createTuiSessionController({
  agentId,
  task,
  runId,
  model,
  provider,
  prompt,
  tuiConfig,
  cwd,
  rawFile,
  executionId,
  laneName,
  isTruthyMetaFn,
  directLaunch,
  prOwnership,
  mergeGateIsOwed,
  spooler,
  session,
  persistence,
  sentinel,
  finalization,
  probeMergeGatePr,
}) {
  const { appendLine, pushRaw, flushRaw, drainLines, drainRaw, getOutputBuffer } = spooler;
  // The login shell prints "command not found" for the binary it was asked to
  // run — the SPAWNED one, which for a credential-bootstrap provider is the
  // bootstrap CLI, not the harness `tuiConfig.command` names.
  const commandName = tuiConfig.spawnCommand.split('/').pop();

  /**
   * Where this session is in its lifecycle — the one value every path that
   * ends a run reads and writes.
   *
   *   'running'   — live; finish() accepts a trigger.
   *   'finishing' — a finish() call is mid-decision. The merge-gate contract
   *                 check (#5876) adds awaits before that call can say whether
   *                 it finalizes at all, so this is set SYNCHRONOUSLY to park a
   *                 second trigger arriving in that window. Goes back to
   *                 'running' if the call decides not to finalize after all.
   *   'finalized' — an outcome was recorded.
   *   'abandoned' — PortOS went down mid-run (#3202): no outcome recorded, the
   *                 worktree preserved for the resume.
   *
   * Named `sessionPhase`, not `phase`, because `abandonForHostShutdown` also
   * writes a `phase: 'interrupted'` breadcrumb into the agent RECORD's
   * metadata a few lines from where it sets this — two different phases with
   * two different vocabularies, and collapsing their names is the mistake this
   * value exists to undo.
   */
  let sessionPhase = 'running';
  /**
   * Both end states are terminal: the run is over, and the sentinel watcher,
   * the PTY data handler, the prompt and provider-signal timers and the paste
   * controller must all become no-ops for the rest of this process's life. An
   * abandoned run is no less over than a finalized one — it just has no
   * outcome — so both stop everything.
   */
  const isTerminal = () => sessionPhase === 'finalized' || sessionPhase === 'abandoned';
  // A finish() call's args, parked because the session was already 'finishing'
  // when it arrived — replayed if the call that was deciding ends up NOT
  // finalizing (see finish()'s own comments on both).
  let pendingFinish = null;
  // Caps the merge-gate re-prompt (#5876) at once per run — a local closure
  // counter is enough: the check only ever runs from this same live process,
  // and a fresh spawn (a real retry) starts a fresh closure with its own flag.
  let mergeGateReprompted = false;
  let immediateFallbackAnalysis = null;
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();
  // Holds the wait-it-out window for a provider signal carrying a `graceMs`
  // (agy's account-eligibility banner). The provider-signal timer below resolves
  // its deadline and drives the re-submission cadence.
  const selfClearingGate = createSelfClearingSignalGate();
  // A local-GPU OOM kills the turn but leaves the TUI session holding the whole
  // conversation, so it is nudged to carry on rather than re-prompted — see
  // createOomNudgeGate for why this is a separate mechanism from the gate above.
  const detectLocalRuntimeOom = createLocalRuntimeOomDetector();
  const oomNudgeGate = createOomNudgeGate();
  // A request the TUI keeps retrying and the provider never answers. Every
  // reaper reads such a session as busy (the retry ladder repaints the screen),
  // so without this the run holds its lane until the max-runtime ceiling — see
  // createRetryStallGate.
  const retryStallGate = createRetryStallGate();
  // A tool-permission dialog nobody is present to answer. Declined on sight —
  // the launch posture already decided the run's scope — then nudged along
  // once the session goes quiet. See createToolPermissionGate.
  const toolPermissionGate = createToolPermissionGate();
  // The stall no detector can see, because nothing is on screen: a turn that
  // ended with the task unfinished. Reads pure silence. See createStallNudgeGate.
  const stallNudgeGate = createStallNudgeGate();
  // Guards ingestDoneSentinel to a single read. finish() is its only caller and
  // is itself guarded by `sessionPhase`, so this is defensive — it pins the
  // read-at-most-once invariant at the helper.
  let sentinelIngested = false;
  let hasStartedWorking = false;
  // Guards the once-per-run `run.output` boundary (#4540). Kept separate from
  // `firstOutputAt` / `hasStartedWorking`: both of those are also set by paths
  // with no real output behind them, and a run that never spoke is exactly the
  // run this boundary must not vouch for.
  let firstOutputRecorded = false;
  /**
   * Record the run's first observed output, once. Called from the live PTY
   * stream and from the exit-tail fallback — a durable runner can deliver a
   * short-lived agent's entire output as `outputTail` on `tui:exit`, and that
   * output is no less real for having lost the race with process exit.
   *
   * Not awaited: the live caller is on the hot output path, and
   * `appendRunEvent` is a serialized queue that never rejects — blocking a
   * terminal repaint on a telemetry write would be the wrong trade. The
   * explicit key makes the append idempotent however the two callers race.
   */
  const recordFirstOutput = (source) => {
    if (firstOutputRecorded) return;
    firstOutputRecorded = true;
    persistence.appendRunEvent({
      kind: 'run.output',
      runId,
      agentId,
      taskId: task.id,
      eventId: `output:${agentId}:${runId || 'no-run'}:first`,
      data: { source },
    });
  };
  let promptSentAt = null;
  // When the submit-Enter is first written (NOT when the paste starts). Provider
  // signal handling keys on this so a startup banner is not treated as a signal
  // from a submitted prompt.
  let promptSubmittedAt = null;
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
  //
  // One verdict for the session, through the shared predicate: it also gates the
  // patient first paste (PASTE_COMMIT_PATIENCE_MS), and the two codex-only paste
  // mechanisms must agree on what codex is. It keys on `command` (the harness),
  // not `spawnCommand` — a credential-bootstrap wrap makes the latter the
  // bootstrap CLI.
  const isCodexSession = isCodexCommand(tuiConfig.command);
  // Latches once codex's composer placeholder paints — the positive "the input
  // box exists" signal the idle heuristic lacks. See
  // CODEX_COMPOSER_READY_PATTERN; consumed by the idle paste branch below.
  let codexComposerReady = false;
  const mcpBoot = createMcpBootTracker();
  // Tracks claude's interactive input-readiness (footer chrome) and its first-run
  // folder-trust gate. Gates the prompt paste for the claude TUI so we never
  // paste into a startup banner, a trust menu, or a returned shell prompt.
  // agy enables bracketed paste on alt-screen entry, before its composer (and
  // before its trust gate) exists, so it needs the extra composer-footer gate.
  // A direct launch pty.spawns the TUI itself (no launch shell), so the tracker
  // must not wait for a shell paste-mode OFF that will never come.
  const inputReady = createInputReadyTracker({
    ...(isAntigravityCommand(tuiConfig.command) ? { readyTextPattern: AGY_INPUT_READY_PATTERN } : {}),
    directLaunch,
  });
  // Which of the TUI's startup dialogs this session has already answered. One
  // record instead of four sibling booleans; the arms themselves live in
  // answerStartupDialogs, so a provider's next dialog is a row there rather than
  // a fifth flag here.
  const dialogAnswers = createStartupDialogAnswers();
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
  // The runner's `tui:output` socket messages are live telemetry. An OpenCode
  // CLI that prints one startup error and exits can race that delivery, while
  // its `tui:exit` arrives reliably enough to finish the session. Track whether
  // we received any ordinary chunk so the runner-provided exit tail is spooled
  // only as a recovery path, never duplicated into raw.txt.
  let receivedTuiOutput = false;

  // The paste-attempt / submit-Enter machinery (postPasteBuffer, pasteEnterTimer,
  // pasteVerifyTimer, submitEnterTimer) lives in createPasteRetryController
  // rather than this closure — see its own comment for why that cluster is
  // separated out. Created by attachSession() once sessionId/pid are known, and
  // torn down from stopRunMachinery via `pasteController?.cancel()`.
  let pasteController = null;
  // The two intervals and the sentinel watcher this run arms, owned HERE rather
  // than parked on the active-run record: `stopRunMachinery` is the only place
  // that clears them, and reading them back off a map entry made a missing entry
  // silently equivalent to "nothing to stop".
  let promptTimer = null;
  let providerSignalTimer = null;
  let doneSentinelWatcher = null;

  const streamingStrip = createStreamingAnsiStripper();

  // Has the agent written its completion sentinel? One predicate for the 2s
  // watcher and ingestDoneSentinel so "the run finished" can't mean subtly
  // different things in two places.
  const sentinelPresent = () => sentinel.exists();

  // Read the `.agent-done` sentinel (if present) and append its markdown task
  // summary line-by-line into the agent's output so downstream consumers
  // (extractFinalSummary, persistSimplifySummaries, completion hooks, the agent
  // card, output.txt) get the resolution. Called only from finish() (the single
  // finalize chokepoint); idempotent via `sentinelIngested` so it reads at most
  // once. Capped at 4 KB so an agent that pasted the whole diff into the
  // sentinel can't blow up the record.
  //
  // Returns the sentinel's `summary` text (or null on a second call / no
  // sentinel / an empty summary) — the merge-gate contract check below reads
  // this same return value rather than re-reading the file a second time.
  const ingestDoneSentinel = async () => {
    if (sentinelIngested) return null;
    if (!sentinelPresent()) return null;
    sentinelIngested = true;
    const contents = await sentinel.read().catch(err => {
      console.error(`❌ ingestDoneSentinel readFile failed: ${err.message}`);
      return '';
    });
    // A programmatic-I/O task type writes a JSON `{ summary, payload }` sentinel;
    // append only the human `summary` to the agent output (the structured
    // `payload` is consumed separately by the task type's processTaskOutput hook,
    // read mode-agnostically in finalizeAgent). A legacy plain-markdown sentinel
    // parses back as its own text, so this is a no-op change for existing types.
    const { summary } = parseSentinelPayload(contents);
    if (!summary) return null;
    // Shared constant, not a literal: `extractAgentSummary` anchors the PR-body
    // extraction on this exact line to tell the agent's summary apart from the
    // lifecycle telemetry above it. Reword it here only, and the noise returns.
    appendLine(SENTINEL_COMPLETION_MARKER);
    const truncated = summary.length > 4096 ? `${summary.slice(0, 4096)}\n…[truncated]` : summary;
    for (const line of truncated.split('\n')) appendLine(line);
    return summary;
  };

  // Sentinel-file watcher. The agent's prompt instructs it to write
  // .agent-done in the workspace after running /simplify + /do:pr and then
  // stop (it does NOT `/quit` — that is a UI command it can't invoke). This
  // watcher is the PRIMARY finalize path: it fires finish() shortly after the
  // sentinel appears, and finish()'s own cleanup kills the still-running TUI
  // session. The actual sentinel READ happens in finish() (via
  // ingestDoneSentinel) so the resolution is captured no matter which path
  // finalizes. A normal shell exit or explicit provider failure handles
  // agents that do not write the sentinel.
  //
  // `sentinel.watch` is one-shot (it detects, closes itself, then calls back) —
  // so a run whose merge-gate check re-prompts and deletes the sentinel to
  // await a SECOND completion needs a brand-new watcher, not a re-trigger of
  // this one. Factored out so both call sites build the exact same watcher.
  const armSentinelWatcher = () => sentinel.watch(async () => {
    if (isTerminal()) return;
    await finish({ success: true, exitCode: 0, reason: 'agent-signaled-done' });
  });

  /**
   * Merge Gate contract check (#5876) — runs on a successful sentinel, before
   * ANY teardown, for a run whose own task shape said it owed a merge. Asks
   * the forge whether the PR this run opened actually landed and, if it is
   * still open with no blocker stated in the agent's own summary, re-pastes
   * one corrective nudge into the still-attached session instead of paying
   * for a cold recovery agent (`agentRepoStateVerification.js`) to do the
   * same merge later. See mergeGateContract.js for the decision table.
   *
   * @returns {Promise<boolean>} true when a re-prompt went out — the caller
   *   must NOT finalize this call; false means finalize normally.
   */
  const checkMergeGateCompliance = async (summary) => {
    if (!mergeGateIsOwed || mergeGateReprompted) return false;
    const prProbe = await probeMergeGatePr();
    const verdict = resolveMergeGateVerdict({ prProbe, summary });
    if (verdict !== 'needs-reprompt') return false;
    if (!pasteController?.resubmit({ text: buildMergeGateReprompt(prProbe.prUrl || '<PR_URL>'), label: 'merge-gate contract nudge' })) {
      // Session is already gone — nothing to nudge; fall through to finalize.
      return false;
    }
    mergeGateReprompted = true;
    // Reopen the completion window: a fresh `.agent-done` write after the
    // nudge must be re-ingested (not silently skipped by the once-only guard)
    // and needs a brand-new watcher — the original already closed itself on
    // its first (this) detection.
    sentinelIngested = false;
    await sentinel.remove();
    doneSentinelWatcher = armSentinelWatcher();
    appendLine(`🔁 Merge Gate not finished (PR still OPEN, no blocker stated) — re-prompted the session (1 nudge only)`);
    emitLog('warn', `🔁 Merge-gate contract nudge sent for ${agentId} — PR still OPEN with no stated blocker`, { agentId });
    return true;
  };

  /**
   * Stop everything this run armed, and hand back the agent record so the
   * caller doesn't need a second map lookup.
   *
   * Shared by the two paths that end a run — `finish()` (records an outcome) and
   * `abandonForHostShutdown()` (records none). Every timer here is created inside
   * this closure, so a teardown site that falls behind leaks an interval holding
   * the closure and the PTY handle alive, which is exactly the drift a single
   * teardown prevents.
   */
  const stopRunMachinery = () => {
    if (providerSignalTimer) { clearInterval(providerSignalTimer); providerSignalTimer = null; }
    if (promptTimer) { clearInterval(promptTimer); promptTimer = null; }
    doneSentinelWatcher?.();
    doneSentinelWatcher = null;
    // Cancels the paste-attempt timers and releases the post-paste accumulator
    // even when the run ends mid-paste-window — see
    // createPasteRetryController's own cancel() for why each is safe to clear
    // unconditionally (a run that ends from elsewhere — shell-exit,
    // command-not-found, user termination, a host restart — never gets a
    // chance to let its own cleanup path run).
    pasteController?.cancel();
    return persistence.readRunRecord();
  };

  /**
   * Everything this run held, released in one place: its own `.agent-done`
   * sentinel, the shared completion dispatch, the pid registration, the
   * active-run entry, and the PTY session.
   *
   * Called from `finish()`'s `finally`, so it must run even when `finalizeAgent`
   * threw — a memory-extraction crash would otherwise strand the worktree and
   * the shell session on disk.
   */
  const releaseRunResources = async ({ agentData, cleanupSuccess, prClaimVerified, noChangesToShip }) => {
    // Pipeline progression → worktree cleanup with the PR disposition →
    // sentinel removal → retry-hold release, in the one owner every completion
    // path shares. Caught so a throw there cannot skip the in-memory teardown
    // below — this runs off a PTY exit, outside any request lifecycle.
    await finalization.runCompletionCleanup({
      agentId,
      task,
      success: cleanupSuccess,
      prOwnership,
      prClaimVerified,
      noChangesToShip,
      outputBuffer: getOutputBuffer(),
    }).catch(err => emitLog('warn', `TUI completion cleanup failed for ${agentId}: ${err.message}`, { agentId }));

    persistence.releaseRunRecord(agentData?.pid ?? null);
    if (sessionId && session.isAlive(sessionId)) session.kill(sessionId);
  };

  const finish = async ({ success, exitCode = 0, error = null, reason = 'completed' }) => {
    // A terminal check alone used to be the whole re-entrancy guard, safe
    // because it was set SYNCHRONOUSLY as this function's first act. The
    // merge-gate check below needs `ingestDoneSentinel`'s summary before it can
    // decide whether to finalize at all, which pushes the terminal transition
    // past several awaits — wide enough for a second trigger (the shell exiting
    // right after the sentinel appears) to also pass the gate before the first
    // call sets it, double-firing `finalizeAgent`. 'finishing' closes that
    // window synchronously while staying NON-terminal, which is what
    // `pasteController.resubmit()` depends on: a re-prompt must still be
    // possible while this call is deciding.
    //
    // A trigger parked here while the first call is mid-decision is not
    // discarded: it's the one call that could carry news the first call
    // doesn't have (the shell exiting right in this window), so it's replayed
    // once that call settles on "not finalizing after all" — see below.
    if (isTerminal()) return;
    if (sessionPhase === 'finishing') {
      pendingFinish = { success, exitCode, error, reason };
      return;
    }
    sessionPhase = 'finishing';
    // PortOS is going down. Whatever path got here — the PTY exiting under
    // TreeKill, a provider-signal failure, a paste that failed because the shell died —
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
    // owns the paused bookkeeping (pid unregister, active-run delete).
    if (finalization.shouldAbandonRun({ agentId, sentinelPresent: sentinelPresent() })) {
      await abandonForHostShutdown();
      return;
    }

    // Ingest the .agent-done sentinel BEFORE any teardown decision, so its
    // markdown summary lands in outputBuffer/output.txt regardless of WHICH
    // path finalized the agent, AND so the merge-gate contract check right
    // below reads the same text without a second file read. The completion
    // workflow writes the sentinel and stops; the 2s doneSentinelWatcher is
    // what normally calls finish(). Idempotent via `sentinelIngested`.
    const sentinelSummary = await ingestDoneSentinel();

    // Merge Gate contract check (#5876): only for a run that actually
    // succeeded AND signaled that success via a real `.agent-done` summary —
    // an ordinary clean exit with no sentinel (or one with an empty summary)
    // is not the "the agent believes its Merge Gate is done" signal this
    // reads; re-prompting THAT would paste into a shell whose TUI child may
    // already be gone, parking the run on a nudge that can never land.
    // Returns true (and this call does NOT finalize) exactly once, when the
    // run owed a merge, the PR is open, and the summary names no blocker —
    // see mergeGateContract.js for the full decision table.
    if (success && sentinelSummary !== null && await checkMergeGateCompliance(sentinelSummary)) {
      // Not finalizing — reopen the re-entrancy gate for the next completion
      // signal the re-prompt is expected to produce. A trigger that arrived
      // WHILE this call was deciding (parked by the 'finishing' guard above)
      // is the only thing that could tell us the session actually died during
      // that window, so replay it now rather than losing it — otherwise the
      // run would sit waiting for a nudge with nothing left alive to receive it.
      sessionPhase = 'running';
      if (pendingFinish) {
        const replay = pendingFinish;
        pendingFinish = null;
        return finish(replay);
      }
      return;
    }

    sessionPhase = 'finalized';

    const agentData = stopRunMachinery();

    // Drain pending parsed lines AND raw chunks before the final state
    // writes so completion events don't beat the last output batch to disk.
    await drainLines();
    await drainRaw();

    // The teardown both in-process spawners share: paused early return, then
    // the host-shutdown abandon gate, the user-termination consume, the final
    // success/error derivation, and the lane release — done before the
    // potentially-slow error-analysis / completeAgent / processAgentCompletion
    // chain, since lanes serialize related work. See agentRunFinalize.js.
    //
    // The abandon gate is consulted a second time here on purpose: the gate at
    // the top of finish() ran before ingestDoneSentinel and the merge-gate probe,
    // which can take seconds, and a host restart that begins in that window is
    // still an interruption rather than an outcome (#3202).
    const duration = Date.now() - (agentData?.startedAt || Date.now());
    // Read ONCE: the shared finalize decides the run's outcome from it and the
    // diagnostic below reports on it, and two reads could disagree about the
    // same run.
    const wroteSentinel = sentinelPresent();
    const finalizeOutcome = finalization.finalizeRunCommon({
      agentId,
      agentData,
      success,
      error,
      exitCode,
      duration,
      executionId,
      laneName,
      sentinelPresent: wroteSentinel,
      errorExecutionFallback: `TUI agent ended: ${reason}`,
    });

    if (finalizeOutcome.outcome === 'paused') return;

    if (finalizeOutcome.outcome === 'abandoned') {
      await abandonForHostShutdown();
      return;
    }

    const { finalSuccess, finalError, terminatedByUser } = finalizeOutcome;

    // Name the path the run was supposed to write when it ends without one.
    // The sentinel is the PRIMARY finalize path for a TUI, so reaching here
    // without it means the run either died or talked itself out of the write —
    // and the second shape is otherwise silent, leaving an ordinary "TUI agent
    // ended" line and nothing an operator can grep for (#7405; the prompt-side
    // contract is SENTINEL_WRITE_PERMISSION_NOTE). Deliberately NOT gated on
    // `finalSuccess`: a run that stalls on a question is reaped as a failure,
    // which is exactly the case this exists to name. Placed after the shared
    // finalize, so the paused and host-abandoned paths have already returned
    // and only a user kill — a legitimate no-sentinel exit — needs excluding.
    // A CLI run is out of scope: it signals completion by exiting, so the same
    // warn in `agentRunFinalize` would fire on every headless run.
    // A merge-gate nudge DELETES the sentinel this run already wrote, so
    // "never wrote one" would be a false reading of that path — and the
    // remedy it points at is the opposite one (the nudge never landed).
    if (sentinel.path && !terminatedByUser && !wroteSentinel) {
      emitLog('warn', missingSentinelLogMessage({
        agentId,
        reason,
        sentinelPath: sentinel.path,
        mergeGateReprompted,
      }), { agentId });
    }

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
    const errorAnalysis = await finalization.resolveErrorAnalysis({
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

    // `prOwnership` was resolved once, up front, by the adapter, so the
    // merge-gate contract check above and the completion dispatch below read the
    // same answer (#3733); see `resolvePrOwnership` for why finalize's
    // `prClaimExpected` and cleanup's `agentOpensOwnPr` are two predicates (#3358).
    //
    // Whether finalize's check ACTUALLY produced a forge answer, filled in from
    // its return below. Deliberately not `prClaimExpected`: finalize substitutes
    // `{ok:true}` for a user-terminated run and for a check that threw, and a
    // throw from finalize itself skips the assignment entirely — in all three
    // cases nothing was verified, so cleanup must ask rather than stand down.
    let prClaimVerified = false;
    let noChangesToShip = false;

    // try/finally so a throw from finalizeAgent (e.g. processAgentCompletion
    // hook crash) still runs the local cleanup — sentinel removal, the shared
    // completion dispatch (pipeline, worktree, retry hold), pid unregister,
    // active-run delete, session kill. Without this, a memory-extraction
    // crash would strand the worktree and the shell session on disk.
    // The verdict finalizeAgent actually persisted. A PR-claim downgrade (#3358)
    // must reach cleanup too — cleaning up as a success removes the worktree and
    // deletes the local branch, destroying the state the retry needs. Left at
    // `finalSuccess` if finalize threw before returning (the pre-existing
    // best-effort posture).
    let cleanupSuccess = finalSuccess;
    try {
      const finalizeVerdict = await finalization.finalizeAgent({
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
        workspacePath: cwd,
        prExpected: prOwnership.prClaimExpected,
        // The run window the commit criterion is evaluated against (#3637).
        startedAt: agentData?.startedAt ?? null,
      });
      if (finalizeVerdict && typeof finalizeVerdict.success === 'boolean') cleanupSuccess = finalizeVerdict.success;
      prClaimVerified = prClaimWasVerified(finalizeVerdict?.prVerdict);
      noChangesToShip = finalizeVerdict?.prVerdict?.noChangesToShip === true;
    } finally {
      await releaseRunResources({ agentData, cleanupSuccess, prClaimVerified, noChangesToShip });
    }
  };

  /**
   * Abandon the run because PortOS itself is going down (#3202).
   *
   * Deliberately NOT `finish()`: finalizing here would record an outcome for a
   * run that never reached one, and its cleanup path removes the `.agent-done`
   * sentinel and hands the worktree to `cleanupAgentWorktree` — destroying exactly
   * the state a resume needs. So this only stops the machinery and flushes what
   * was captured; the agent record stays `running` and the worktree stays on
   * disk. The next boot's orphan sweep reads the host-shutdown marker, sees this
   * agent named in it, and requeues the task as *interrupted* — resumable, and
   * without charging it orphan-retry budget.
   *
   * Moves the session to the terminal 'abandoned' phase so every other path
   * (provider-signal timer, sentinel watcher, paste retry) becomes a no-op for
   * the rest of this process's life — a full stop, under the name that says no
   * outcome was recorded.
   */
  const abandonForHostShutdown = async () => {
    // No terminal guard: finish() — the only caller — already returned if the
    // session had reached one, and this sets it below.
    sessionPhase = 'abandoned';
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
      persistence.updateAgent(agentId, { metadata: { phase: 'interrupted', interruptedBy: HOST_SHUTDOWN_REASON } })
        .catch(err => emitLog('warn', `Could not mark TUI agent ${agentId} interrupted: ${err.message}`, { agentId })),
    ]);
    // NOTE: the active-run entry is intentionally left in place — the shutdown
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
    if (isTerminal() || !promptSubmittedAt) return;
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
      // session being killed in finalize's finally block. Once the run has
      // reached a terminal phase, drop them — appending to the spool, growing
      // the post-paste accumulator, or mutating timing state is all pointless
      // after finish has settled.
      if (isTerminal()) return;
      // node-pty surfaces output as already-decoded UTF-8 strings via
      // shellService's onData hook (StringDecoder handles multi-byte
      // boundaries internally), so `data` is a string here in normal use.
      // The String(...) coerces defensively in case a future caller wires
      // a Buffer-emitting encoding.
      const text = typeof data === 'string' ? data : String(data);
      if (text) receivedTuiOutput = true;
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
      // Same window as the MCP-boot latch, and for the same reason: only codex's
      // own startup chrome (never the echoed prompt) may trip it.
      if (isCodexSession && !codexComposerReady && !promptSentAt && commandInjected && stripped
        && CODEX_COMPOSER_READY_PATTERN.test(stripped)) codexComposerReady = true;
      const now = Date.now();
      // Startup-idle detection (the promptTimer's non-inputReady branch below)
      // reads lastOutputAt/firstOutputAt to decide the TUI has gone quiet and is
      // ready for the prompt paste. Gate them on commandInjected for the same
      // reason inputReady.observe is gated above: the shell-level readiness
      // probe (posix printf / PowerShell Write-Output) round-trips its own
      // marker through this same onData hook BEFORE the real CLI command is
      // injected, so counting it would seed the idle clock from probe echo
      // instead of the CLI's own output — falsely satisfying "quiet" while a
      // still-loading CLI (e.g. PowerShell's heavier startup) hasn't painted
      // anything yet, and pasting the prompt into it.
      if (commandInjected) {
        lastOutputAt = now;
        if (firstOutputAt === null) firstOutputAt = lastOutputAt;
      }
      recordFirstOutput('tui-pty');

      if (!hasStartedWorking) {
        hasStartedWorking = true;
        await persistence.updateAgent(agentId, { metadata: { phase: 'working' } });
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

      // A local inference runtime that ran out of GPU memory. The turn is dead
      // but the session is intact, so this arms a nudge instead of killing the
      // run — the provider-signal timer sends it once the session has actually
      // gone quiet. Gated on promptSubmittedAt for the same reason
      // resubmitAfterSignal is: before the prompt is in, there is no turn to
      // resume and the ordinary paste path still owns first delivery.
      const oomSignal = promptSubmittedAt ? detectLocalRuntimeOom(stripped) : null;
      if (oomSignal) {
        const armed = oomNudgeGate.arm(oomSignal, now);
        if (armed === 'armed') {
          appendLine('⏳ Local runtime out of GPU memory — will nudge the session to continue if it goes quiet');
        } else if (armed === 'exhausted') {
          // Nudged its way through OOM_NUDGE_MAX_ATTEMPTS and it came back
          // again: the conversation no longer fits this device, and it only
          // grows from here. Hand the task to a fallback provider.
          await failOverToFallback(oomSignal);
          return;
        }
      }

      // Same gating as the OOM nudge above: before the prompt is in there is no
      // request of ours for the provider to be retrying. Acted on by the
      // provider-signal timer, on its own poll, like the other gates.
      if (promptSubmittedAt) retryStallGate.observe(stripped, now);

      // The permission dialog is Claude Code chrome. Watching another vendor's
      // session for it would only ever match an ECHO — a Codex or agy agent
      // investigating a stalled run cats its raw.txt straight into this stream
      // — and answer a dialog that is not there with keystrokes into a working
      // composer.
      const permissionDialog = promptSubmittedAt && isClaudeCommand(tuiConfig.command)
        ? toolPermissionGate.observe(stripped, now)
        : null;
      if (permissionDialog === 'exhausted') {
        await finish({
          success: false,
          exitCode: 1,
          error: `${tuiConfig.command} kept asking for tool permissions an unattended run cannot grant (${TOOL_PERMISSION_DECLINE_MAX} dialogs declined) — the model keeps reaching outside the run's allowed scope`,
          reason: 'permission-prompt-loop',
        });
        return;
      }
      if (permissionDialog) {
        // "No" is the last option and option 1 is highlighted: arrow down to it,
        // then Enter — lands under both of Ink's selection models, whereas a bare
        // digit is immediate-select in some builds and ignored in others.
        session.write(sessionId, `${'\x1b[B'.repeat(Math.max(0, permissionDialog.noOption - 1))}${SUBMIT_KEY}`);
        appendLine(`🚫 Declined ${tuiConfig.command} permission prompt for ${permissionDialog.toolCall || 'a tool call'} — an unattended run never widens its scope (${permissionDialog.count}/${TOOL_PERMISSION_DECLINE_MAX})`);
      }

      if (!promptSentAt) {
        // Only the login-shell path can reach this: it is the shell PRINTING
        // "command not found". A direct PTY resolves the executable before it
        // spawns (createAgentTuiSession), because there is no shell to print it.
        if (detectMissingTuiBinary(stripped, commandName)) {
          // finish() uses try/finally internally: finalizeAgent errors re-throw after
          // cleanup, so finish() can reject. The outer try/catch in handleData already
          // handles any such rejection via emitLog — no additional .catch() needed here.
          await finish({
            success: false,
            exitCode: 127,
            error: `TUI command not found: ${tuiConfig.spawnCommand}`,
            reason: 'command-not-found'
          });
        }
      }
    } catch (err) {
      emitLog('error', `TUI agent ${agentId} handleData failed: ${err?.message || err}`, { agentId });
    }
  };

  const handleExit = async ({ exitCode, killed, signal = null, outputTail = '' }) => {
    if (isTerminal()) return;
    // A durable runner can retain a startup error even when its matching
    // `tui:output` socket event lost the race with process exit. Preserve its
    // bounded tail before finish() drains raw.txt for error analysis. Cap again
    // at this trust boundary so a malformed runner event cannot grow the spool.
    if (!receivedTuiOutput && typeof outputTail === 'string' && outputTail) {
      receivedTuiOutput = true;
      pushRaw(outputTail.slice(-16 * 1024));
      recordFirstOutput('tui-exit-tail');
    }
    // A host restart reaches here as a plain PTY exit (pm2's TreeKill walks
    // portos-server's descendants), which the `success` reading below would
    // record as a completed run. finish() intercepts that case — see its
    // host-shutdown guard (#3202).
    const code = typeof exitCode === 'number' ? exitCode : killed ? 130 : 0;
    // A signal-terminated process reports the wait-status exit code — 0 for a
    // plain SIGTERM/SIGHUP — so `code === 0` alone cannot mean "finished
    // normally". Treat any signal as an abnormal end. This is the backstop for
    // the case the host-shutdown guard can't cover: a SIGKILL'd or crashed
    // portos-server never runs its shutdown handler, so the flag is never set,
    // yet the agent's PTY still dies with us (#3202).
    //
    // The reading holds for BOTH session shapes. A login shell carried its
    // hosted CLI's status out via the run-then-exit wrapper; a direct PTY
    // (#6159) simply IS the CLI, so the code and signal are the CLI's own.
    // Reason codes stay `shell-*`: that is what COMPLETION_REASON_ANALYSES
    // registers.
    const signaled = !!signal;
    const outcome = killed
      ? { error: 'TUI session was killed', reason: 'shell-killed' }
      : signaled
        ? { error: `TUI session was terminated by signal ${signal} — the run was cut short, not completed`, reason: 'shell-signaled' }
        : { error: null, reason: 'shell-exit' };
    await finish({ success: code === 0 && !killed && !signaled, exitCode: code, ...outcome });
  };

  // Finalize a startup failure WITHOUT pasting — surfacing whatever the CLI
  // printed (raw.txt tail) so the real cause is visible instead of a wedged
  // shell. Shared by the liveness guard (command exited) and the readiness cap
  // (claude never showed its input prompt).
  const finishStartupFailure = async (reason, summary) => {
    if (isTerminal()) return;
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

  /**
   * Arm prompt delivery and the run's two polling timers against a live PTY.
   *
   * Called once, by the adapter, after `createAgentTuiSession` returns. Split
   * from construction because `handleData`/`handleExit` are what OPEN the
   * session: a run can fail (and must finalize) before there is any session id
   * to attach.
   */
  const attachSession = ({ sessionId: liveSessionId, pid }) => {
    sessionId = liveSessionId;
    // Send the bracketed-paste prompt only after the TUI has finished its initial
    // repaint and gone quiet — pasting during the banner/loading screen is the
    // failure mode that left the input empty. The `\r` is split from the paste
    // write because a fixed delay races Claude Code's paste-commit on large
    // prompts; instead we poll Claude Code's raw output for its
    // provider paste-commit marker, then wait an extra
    // PASTE_TO_ENTER_MIN_DELAY_MS before submitting. A fallback timer fires
    // the Enter unconditionally if the marker never appears (very small
    // prompts won't trigger the marker). All timers are tracked so finish()
    // can cancel pending writes if the agent ends mid-handshake.
    const sessionStartedAt = Date.now();
    const sessionLabel = sessionId.slice(0, 8);

    // Owns the paste-attempt counter, the post-paste accumulator, and the paste
    // timers — see createPasteRetryController's own comment for why that cluster
    // lives outside this closure. `isFinalized`/`markPromptSent`/
    // `markPromptSubmitted` are accessors into THIS closure's `sessionPhase`/
    // `promptSentAt`/`promptSubmittedAt`, which handleData and the
    // provider-signal timer below still read directly. `isFinalized` is the
    // controller's own name for "the run is over", which is what BOTH terminal
    // phases mean.
    pasteController = createPasteRetryController({
      agentId,
      sessionLabel,
      write: (keys) => session.write(sessionId, keys),
      paste: (text, options) => (sessionId ? session.paste(sessionId, text, options) : false),
      hasLiveChild: () => session.hasLiveChild(pid),
      directLaunch,
      prompt,
      tuiConfig,
      mcpBoot,
      isCodexSession,
      appendLine,
      isFinalized: isTerminal,
      markPromptSent: () => { promptSentAt = Date.now(); },
      markPromptSubmitted: () => { if (promptSubmittedAt === null) promptSubmittedAt = Date.now(); },
      finishStartupFailure,
    });

    // Claude Code renders a startup banner and (in unfamiliar folders) a
    // folder-trust gate before its input box exists, and the old "saw output then
    // went quiet" heuristic fired during those lulls — pasting the prompt into the
    // banner / trust menu / a returned shell. For claude we instead gate on its
    // POSITIVE input-ready footer (see createInputReadyTracker), auto-confirm the
    // trust gate, and NEVER blind-paste: if the prompt never appears we surface a
    // failure. Other TUI providers keep the original startup readiness deadline.
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
    // silently failing at startup.
    const requireInputReady = isClaudeCommand(tuiConfig.command) || isAntigravityCommand(tuiConfig.command);
    // sendPrompt / finishStartupFailure are async and dispatched fire-and-forget
    // from the interval below. A setInterval callback can't await, and an
    // unhandled rejection there (e.g. a finalizeAgent throw inside finish())
    // would crash the process — the callback-boundary hazard AGENTS.md calls out.
    // Wrap each floating call so a rejection is logged, not thrown.
    const safeSendPrompt = (reason) => pasteController.sendPrompt(reason).catch((err) =>
      emitLog('error', `TUI agent ${agentId} sendPrompt(${reason}) failed: ${err?.message || err}`, { agentId }));
    const safeFinishStartupFailure = (reason, summary) => finishStartupFailure(reason, summary).catch((err) =>
      emitLog('error', `TUI agent ${agentId} finishStartupFailure(${reason}) failed: ${err?.message || err}`, { agentId }));
    // The one PTY writer the startup-dialog answers go through, bound once
    // rather than rebuilt on every 300ms poll tick.
    const writeToTuiSession = (keys) => session.write(sessionId, keys);
    promptTimer = setInterval(() => {
      if (isTerminal() || promptSentAt) {
        clearInterval(promptTimer);
        promptTimer = null;
        return;
      }
      const now = Date.now();
      const elapsed = now - sessionStartedAt;

      // Answer whatever startup dialog the TUI is showing — one per tick, in the
      // order answerStartupDialogs declares (external imports, hook review,
      // folder trust). These run for EVERY provider, not only the positive
      // input-ready ones below, because codex takes the idle/deadline paste path
      // and a dialog is at its quietest right after it paints.
      //
      // Answering rewinds the idle clock (`lastOutputAt`) AND clears
      // `firstOutputAt`, which re-arms the idle path's "has it printed anything?"
      // gate. Without that, the dismissal keystroke and an idle paste can go out
      // inside the same window, landing the prompt in a menu that has not
      // repainted. Demanding fresh output-then-silence AFTER the keystroke makes
      // the paste wait for whatever the dismissal reveals; if the TUI ignores the
      // keystroke entirely, PASTE_DEADLINE_MS still backstops delivery.
      const answeredBeforeComposer = answerStartupDialogs({
        inputReady,
        answers: dialogAnswers,
        stage: 'before-composer',
        command: tuiConfig.command,
        write: writeToTuiSession,
      });
      if (answeredBeforeComposer) {
        lastOutputAt = now;
        firstOutputAt = null;
        appendLine(`📟 ${answeredBeforeComposer.message} for session ${sessionLabel}`);
        return;
      }

      // A recognized trust heading with unknown choices is not an input prompt.
      // Never fall through to either positive-readiness or idle delivery and paste
      // the task into it. Fail explicitly at the provider's normal readiness cap
      // so a future wording change is diagnosable without accepting an unknown
      // highlighted default (which may be "No, exit").
      if (inputReady.needsTrust && !inputReady.trustChoiceReady) {
        const trustDeadlineMs = requireInputReady ? TUI_INPUT_READY_DEADLINE_MS : PASTE_DEADLINE_MS;
        if (elapsed >= trustDeadlineMs) {
          clearInterval(promptTimer);
          promptTimer = null;
          safeFinishStartupFailure(
            'tui-trust-choice-unrecognized',
            `${tuiConfig.command} presented a folder-trust prompt whose affirmative choice PortOS could not identify, so no prompt was sent.`,
          );
        }
        return;
      }

      if (requireInputReady) {
        // Claude's auto-mode offer paints AFTER the composer is live, so it only
        // reaches the positive input-ready providers — and unlike a dialog that
        // paints before the composer, no idle rewind is needed here: this path
        // gates on `inputReady.ready`, which the offer itself suppresses until
        // it is acked.
        const answeredAtComposer = answerStartupDialogs({
          inputReady,
          answers: dialogAnswers,
          stage: 'after-composer',
          command: tuiConfig.command,
          write: writeToTuiSession,
        });
        if (answeredAtComposer) {
          appendLine(`📟 ${answeredAtComposer.message} for session ${sessionLabel}`);
          return;
        }
        if (inputReady.ready && elapsed >= tuiConfig.promptDelayMs) {
          safeSendPrompt('input-ready');
          clearInterval(promptTimer);
          promptTimer = null;
          return;
        }
        // Never blind-paste for claude: if the input prompt never showed within
        // the cap, finalize a startup failure with the captured output.
        if (elapsed >= TUI_INPUT_READY_DEADLINE_MS) {
          clearInterval(promptTimer);
          promptTimer = null;
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
        promptTimer = null;
        return;
      }
      if (elapsed < tuiConfig.promptDelayMs) return;
      if (firstOutputAt === null) return;
      if (now - lastOutputAt < READY_IDLE_THRESHOLD_MS) return;
      // Codex goes quiet for seconds mid-boot with no composer painted, and the
      // idle heuristic alone reads that lull as ready — pasting into nothing.
      // Hold the idle path until its composer placeholder has actually rendered;
      // the PASTE_DEADLINE_MS fallback above still delivers if it never does, so
      // this can only delay a paste, never cancel one.
      if (isCodexSession && !codexComposerReady) return;
      safeSendPrompt('ready');
      clearInterval(promptTimer);
      promptTimer = null;
    }, READY_POLL_INTERVAL_MS);

    // Provider-handshake retry timer. It is deliberately not an idle watchdog:
    // a CoS TUI may remain silent for as long as the provider needs.
    providerSignalTimer = setInterval(() => {
      if (isTerminal()) return;
      // One clock for every gate on this tick. They all measure the same silence,
      // so reading the wall four times only invites them to disagree about it.
      const now = Date.now();
      const expired = selfClearingGate.takeExpired(now);
      if (expired) {
        // setInterval can't await, and an unhandled rejection here would crash the
        // process (the callback-boundary hazard AGENTS.md calls out).
        failOverToFallback(expired).catch((err) =>
          emitLog('error', `TUI agent ${agentId} deferred fallback finish failed: ${err?.message || err}`, { agentId }));
        return;
      }
      if (selfClearingGate.armed) {
        resubmitAfterSignal();
        return;
      }
      const stall = retryStallGate.takeStall();
      if (stall) {
        failOverToFallback(stall).catch((err) =>
          emitLog('error', `TUI agent ${agentId} retry-stall fallback finish failed: ${err?.message || err}`, { agentId }));
        return;
      }
      // A declined permission dialog ends the turn; once the session is quiet,
      // tell it why and send it back to work.
      const declined = toolPermissionGate.takeNudge(now, lastOutputAt);
      if (declined) {
        if (pasteController?.resubmit({ text: TOOL_PERMISSION_NUDGE_TEXT, label: 'declined-permission nudge' })) {
          appendLine(`🔁 Nudged the session to continue after declined permission prompt ${declined}`);
        }
        return;
      }
      // Nudge a session a local-GPU OOM parked. Rides this timer rather than one
      // of its own so the nudge cadence and the fail-over verdict stay on the same
      // clock — and so there is one fewer interval to leak past finish().
      const nudge = oomNudgeGate.takeNudge(now, lastOutputAt);
      if (nudge) {
        if (pasteController?.resubmit({ text: OOM_NUDGE_TEXT, label: 'local-runtime OOM nudge' })) {
          appendLine(`🔁 Local runtime OOM — nudged the session to continue (attempt ${nudge}/${OOM_NUDGE_MAX_ATTEMPTS})`);
        }
        return;
      }
      // Last, and only once no gate above has a say: every one of them describes a
      // session stalled for a KNOWN reason, and their own silence tests would be
      // pre-empted by a nudge sent on plain quiet.
      //
      // `sessionPhase`, not `isTerminal()`: a finish() parked on the merge-gate
      // contract check (a `gh` PR probe) sits in 'finishing' for as long as that
      // network call takes, non-terminal the whole time, and it may yet paste a
      // nudge of its own. And `promptSubmittedAt`, because before the prompt is
      // in the promptTimer owns delivery — silence there is startup, not a stall.
      if (sessionPhase !== 'running' || !promptSubmittedAt) return;
      const stalled = stallNudgeGate.takeNudge(now, lastOutputAt);
      if (!stalled) return;
      // Read the sentinel here rather than on every tick: its watcher polls on its
      // own clock, so a run can be done-but-not-yet-finalized at this instant, and
      // this is the only moment the answer is acted on.
      if (sentinelPresent()) return;
      if (stalled === 'exhausted') {
        // Every nudge in the streak was ignored (wedged below its composer), or the
        // run spent its lifetime budget answering nudges without ever finishing
        // (a model looping on "continue"). Either way more nudges won't help. There is no ceiling left to reap it, so say
        // so loudly and badge the card — an agent nobody can see is stuck is the
        // condition this gate exists to end, and only a human can end this one.
        appendLine(`🛑 Session still idle after ${stallNudgeGate.nudgesSent} nudges — it is not finishing; open the Shell tab to take it over`);
        emitLog('warn', `🛑 TUI agent ${agentId} is wedged — still idle after ${stallNudgeGate.nudgesSent} stall nudges`, { agentId });
        persistence.updateAgent(agentId, { metadata: { phase: 'stalled' } }).catch((err) =>
          emitLog('error', `TUI agent ${agentId} stalled-phase update failed: ${err?.message || err}`, { agentId }));
        // Re-arm the onData handler's one-shot "phase: working" write, so a
        // session that wakes up later (a provider call that finally returned)
        // clears the badge on its next chunk instead of wearing it to the end.
        hasStartedWorking = false;
        return;
      }
      if (pasteController?.resubmit({ text: STALL_NUDGE_TEXT, label: 'stalled-session nudge' })) {
        appendLine(`🔁 Session idle with the task unfinished — nudged it to continue (attempt ${stalled}/${STALL_NUDGE_MAX_ATTEMPTS}, ${stallNudgeGate.nudgesSent}/${STALL_NUDGE_MAX_TOTAL} this run)`);
      }
    }, PROVIDER_SIGNAL_POLL_MS);

    doneSentinelWatcher = armSentinelWatcher();
  };

  return {
    handleData,
    handleExit,
    markCommandInjected: () => { commandInjected = true; },
    isTerminal,
    finish,
    attachSession,
  };
}
