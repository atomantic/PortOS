/** Observe startup readiness and deliver the prompt to the attached TUI session. */
import { emitLog } from '../cos/cosEvents.js';
import { LIFECYCLE_LINES } from '../../lib/agent/agentOutputMarkers.js';
import { stripAnsi } from '../../lib/ansiStrip.js';
import { isAntigravityCommand } from '../../lib/antigravity.js';
import { isClaudeCommand, isOpencodeCommand } from '../../lib/provider/providerModels.js';
import { createPasteSubmitDriver } from '../../lib/tuiPasteSubmitDriver.js';
import {
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  countPasteMarkers,
  createPromptSubmissionGate,
  createMcpBootTracker,
  createInputReadyTracker,
  shapeHasLoginShell,
  createStartupDialogAnswers,
  answerStartupDialogs,
  describeTrustGateFailure,
  AGY_INPUT_READY_PATTERN,
  OPENCODE_INPUT_READY_PATTERN,
  CODEX_COMPOSER_READY_PATTERN,
  PASTE_DEADLINE_MS,
  TUI_INPUT_READY_DEADLINE_MS,
} from '../../lib/tuiHandshake.js';

// Prompt delivery for the controller: the startup liveness guard, then the
// shared paste-and-submit driver (lib/tuiPasteSubmitDriver.js), which owns the
// paste / commit-wait / verify / retry / settle / submit-Enter timers for this
// path and the one-shot prompt runner alike (#16105).
function createPasteController({
  agentId,
  sessionLabel,
  write,
  paste,
  hasLiveChild,
  launchShape,
  prompt,
  tuiConfig,
  mcpBoot,
  isCodexSession,
  appendLine,
  isFinalized,
  markPromptSent,
  markPromptSubmitted,
  promptGate,
  getLastOutputAt,
  finishStartupFailure,
}) {
  const driver = createPasteSubmitDriver({
    prompt,
    command: tuiConfig.command,
    write,
    paste: (text, { label }) => paste(text, { label: `[cosAgents] ${label}` }),
    isFinalized,
    onFail: finishStartupFailure,
    onSubmitted: markPromptSubmitted,
    promptGate,
    getLastOutputAt,
    settleRule: isCodexSession ? 'codex' : 'default',
    mcpBoot,
    logError: (message) => emitLog('error', `TUI agent ${agentId}: ${message}`, { agentId }),
    onEvent: (event) => {
      if (event.type === 'pasted') {
        const attemptSuffix = event.attempt > 1 ? ` [attempt ${event.attempt}]` : '';
        appendLine(LIFECYCLE_LINES.promptPasted({ session: sessionLabel, reason: event.reason, attemptSuffix }));
      } else if (event.type === 'paste-retrying') {
        const bootNote = event.mcpBootActive ? ` (waiting for ${tuiConfig.command} MCP servers to finish booting)` : '';
        appendLine(LIFECYCLE_LINES.pasteRetrying({ delayMs: event.delayMs, bootNote }));
      } else if (event.type === 'paste-not-rendered') {
        appendLine(event.mcpBootActive
          ? LIFECYCLE_LINES.pasteNeverLandedMcpBoot({ seconds: event.seconds })
          : LIFECYCLE_LINES.pasteNeverRendered({ attempts: event.attempts }));
      } else if (event.type === 'unsubmitted-enter') {
        appendLine(LIFECYCLE_LINES.unsubmittedPromptEntered({ attempt: event.attempt, max: event.max }));
      }
    },
  });
  let sent = false;

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
    // A launch shape with a login shell has an intermediate shell; without one
    // (runner or direct), the TUI IS the PTY process and "does this pid have a
    // live child?" is the wrong question (the TUI may have zero children at
    // paste time). A TUI exit kills the PTY in those shapes, firing onExit.
    // Skip the probe when there is no shell to host the TUI.
    if (shapeHasLoginShell(launchShape) && !(await hasLiveChild())) {
      if (isFinalized()) return; // a real onExit may have finalized during the probe await
      await finishStartupFailure(
        'tui-exited-early',
        `${tuiConfig.command} exited at startup before the TUI was ready, so no prompt was sent.`,
      );
      return;
    }
    driver.start(reason);
  };

  return {
    sendPrompt,
    resubmit: driver.resubmit,
    ingestChunk: driver.ingest,
    pressUnsubmittedEnter: driver.pressUnsubmittedEnter,
    cancel: driver.cancel,
  };
}

export function createPromptDelivery({
  agentId, prompt, tuiConfig, model, launchShape, session, run, isCodexSession,
  appendLine, isTerminal, finishStartupFailure, recordSubmission,
}) {
  // A prompt whose paste landed but whose submit Enter was ignored: pressed
  // again where it sits, and a run that never started is failed rather than
  // parked. See createPromptSubmissionGate.
  const promptGate = createPromptSubmissionGate({ promptMarkerCount: countPasteMarkers(stripAnsi(prompt)) });
  let promptSentAt = null;
  // When the submit-Enter is first written (NOT when the paste starts). Provider
  // signal handling keys on this so a startup banner is not treated as a signal
  // from a submitted prompt.
  let promptSubmittedAt = null;
  const isOpencodeSession = isOpencodeCommand(tuiConfig.command);
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
  // OpenCode also enables paste mode before the composer. Require its
  // placeholder and a settled repaint so terminal queries cannot trigger paste.
  // Runner/direct shapes pty.spawn the TUI itself (no launch shell), so the
  // tracker must not wait for a shell paste-mode OFF that will never come.
  const inputReady = createInputReadyTracker({
    ...(isOpencodeSession ? { readyTextPattern: OPENCODE_INPUT_READY_PATTERN } : {}),
    ...(isAntigravityCommand(tuiConfig.command) ? { readyTextPattern: AGY_INPUT_READY_PATTERN } : {}),
    launchShape,
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
  let pasteController = null;
  let promptTimer = null;

  const observeStartupChunk = (text, stripped) => {
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
  };

  const recordOutput = (stripped, now) => {
    promptGate.observe(stripped, now);
    // Exclude the shell readiness probe's own echo before command injection.
    if (commandInjected) {
      lastOutputAt = now;
      if (firstOutputAt === null) firstOutputAt = now;
    }
  };

  const attach = (pid) => {
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
    const sessionLabel = run.sessionId.slice(0, 8);

    // `isFinalized` is the controller's own name for "the run is over", which
    // is what BOTH terminal phases mean.
    pasteController = createPasteController({
      agentId,
      sessionLabel,
      write: (keys, options) => options
        ? session.write(run.sessionId, keys, options)
        : session.write(run.sessionId, keys),
      paste: (text, options) => (run.sessionId ? session.paste(run.sessionId, text, options) : false),
      hasLiveChild: () => session.hasLiveChild(pid),
      launchShape,
      prompt,
      tuiConfig,
      mcpBoot,
      isCodexSession,
      appendLine,
      isFinalized: () => isTerminal() || !!run.terminalRefusal,
      markPromptSent: () => { promptSentAt = Date.now(); },
      markPromptSubmitted: () => {
        if (promptSubmittedAt !== null) return;
        promptSubmittedAt = Date.now();
        recordSubmission();
      },
      promptGate,
      getLastOutputAt: () => lastOutputAt,
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
    const requireInputReady = isClaudeCommand(tuiConfig.command) || isAntigravityCommand(tuiConfig.command) || isOpencodeSession;
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
    const writeToTuiSession = (keys) => session.write(run.sessionId, keys);
    promptTimer = setInterval(() => {
      if (isTerminal() || promptSentAt) {
        clearInterval(promptTimer);
        promptTimer = null;
        return;
      }
      const now = Date.now();
      const elapsed = now - sessionStartedAt;

      // OpenCode answers an unresolvable model with a toast and then paints its
      // composer for a replacement model. Composer readiness would pass, so stop
      // here: the prompt must never reach a model this task did not select.
      const opencodeRejection = isOpencodeSession ? inputReady.opencodeModelRejection : null;
      if (opencodeRejection) {
        clearInterval(promptTimer);
        promptTimer = null;
        run.immediateFallbackAnalysis = { ...opencodeRejection, configuredModel: model };
        safeFinishStartupFailure('opencode-model-rejected', opencodeRejection.message);
        return;
      }

      // Answer whatever startup dialog the TUI is showing — one per tick, in the
      // order answerStartupDialogs declares (external imports, hook review,
      // folder trust, OpenCode updates). These run for EVERY provider, not only the positive
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
        appendLine(LIFECYCLE_LINES.startupDialogAnswered({ message: answeredBeforeComposer.message, session: sessionLabel }));
        return;
      }

      // A trust gate still up (choices unknown, or waiting to settle/confirm a
      // highlight move) is not an input prompt. Never fall through to either
      // positive-readiness or idle delivery and paste the task into it. Fail
      // explicitly at the provider's normal readiness cap so a wording change or
      // a selector that will not hold the trust choice is diagnosable without
      // accepting an unknown highlighted default (which may be "No, exit").
      if (inputReady.needsTrust) {
        const trustDeadlineMs = requireInputReady ? TUI_INPUT_READY_DEADLINE_MS : PASTE_DEADLINE_MS;
        if (elapsed >= trustDeadlineMs) {
          clearInterval(promptTimer);
          promptTimer = null;
          const failure = describeTrustGateFailure(inputReady, tuiConfig.command);
          safeFinishStartupFailure(failure.reason, failure.error);
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
          appendLine(LIFECYCLE_LINES.startupDialogAnswered({ message: answeredAtComposer.message, session: sessionLabel }));
          return;
        }
        if (inputReady.ready && elapsed >= tuiConfig.promptDelayMs
          && (!isOpencodeSession || (firstOutputAt !== null && now - lastOutputAt >= READY_IDLE_THRESHOLD_MS))) {
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
  };

  return {
    attach,
    observeStartupChunk,
    recordOutput,
    markCommandInjected: () => { commandInjected = true; },
    resubmit: options => pasteController?.resubmit(options),
    pressUnsubmittedEnter: now => pasteController?.pressUnsubmittedEnter(now),
    cancelPaste: () => pasteController?.cancel(),
    get lastOutputAt() { return lastOutputAt; },
    get promptSentAt() { return promptSentAt; },
    get promptSubmittedAt() { return promptSubmittedAt; },
    get hasWorked() { return promptGate.worked; },
    stopTimer() {
      if (promptTimer) { clearInterval(promptTimer); promptTimer = null; }
    },
  };
}
