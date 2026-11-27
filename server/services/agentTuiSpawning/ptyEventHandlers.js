/** Process PTY output and exits, and respond to provider signals for one TUI run. */
import { emitLog } from '../cos/cosEvents.js';
import { LIFECYCLE_LINES } from '../../lib/agent/agentOutputMarkers.js';
import { createStreamingAnsiStripper } from '../../lib/ansiStrip.js';
import {
  createContentRefusalDetector,
  createClaudeSessionLimitBannerDetector,
  createImmediateFallbackSignalDetector,
  createLocalRuntimeOomDetector,
  createTruncatedResponseDetector,
  createModelAtCapacityDetector,
} from '../../lib/aiToolkit/errorDetection.js';
import { isAntigravityCommand } from '../../lib/antigravity.js';
import { isClaudeCommand } from '../../lib/provider/providerModels.js';
import { isFalsyMeta } from '../../lib/metadataFlags.js';
import { createCodexModelRejectionGate } from './codexModelRejection.js';
import {
  createSelfClearingSignalGate,
  createOomNudgeGate,
  createRetryStallGate,
  createToolPermissionGate,
  TOOL_PERMISSION_DECLINE_MAX,
  TOOL_PERMISSION_NUDGE_TEXT,
  OOM_NUDGE_MAX_ATTEMPTS,
  OOM_NUDGE_TEXT,
  createTruncationNudgeGate,
  createModelCapacityNudgeGate,
  CAPACITY_NUDGE_MAX_ATTEMPTS,
  CAPACITY_NUDGE_TEXT,
  TRUNCATION_NUDGE_MAX_ATTEMPTS,
  TRUNCATION_NUDGE_TEXT,
  createStallNudgeGate,
  createAgyResumeGate,
  AGY_RESUME_MAX_ATTEMPTS,
  STALL_NUDGE_MAX_ATTEMPTS,
  STALL_NUDGE_TEXT,
  STALL_NUDGE_MAX_TOTAL,
  shapeHasLoginShell,
  AGY_INPUT_READY_PATTERN,
  CLAUDE_LOW_PRIORITY_RESUBMIT_DELAY_MS,
  SUBMIT_KEY,
  detectMissingTuiBinary,
} from '../../lib/tuiHandshake.js';

const PROVIDER_SIGNAL_POLL_MS = 5000;

export function createPtyEventHandlers({
  agentId, task, runId, model, provider, securityScanGrant, tuiConfig, launchShape,
  session, persistence, appendLine, pushRaw, run, isCodexSession, delivery, teardown, sentinelPresent,
}) {
  const { isTerminal, isRunning, finish, finishStartupFailure } = teardown;
  // The login shell prints "command not found" for the binary it was asked to
  // run — the SPAWNED one, which for a credential-bootstrap provider is the
  // bootstrap CLI, not the harness `tuiConfig.command` names.
  const commandName = tuiConfig.spawnCommand.split('/').pop();
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();
  const detectContentRefusal = createContentRefusalDetector();
  const detectClaudeSessionLimitBanner = createClaudeSessionLimitBannerDetector();
  let claudeLowPriorityPromptResubmitted = false;
  const mayUseClaudeLowPriority = provider?.type === 'tui'
    && provider?.lowPriorityOnUsageLimit === true
    && isClaudeCommand(tuiConfig.command);
  let lowPriorityCommandAttempted = false;
  // Holds the wait-it-out window for a provider signal carrying a `graceMs`
  // (agy's account-eligibility banner). The provider-signal timer below resolves
  // its deadline and drives the re-submission cadence.
  const selfClearingGate = createSelfClearingSignalGate();
  // A local-GPU OOM kills the turn but leaves the TUI session holding the whole
  // conversation, so it is nudged to carry on rather than re-prompted — see
  // createOomNudgeGate for why this is a separate mechanism from the gate above.
  // A dead turn in an intact session is nudged (not re-prompted) once the
  // session goes quiet; a signal that outlasts its nudge budget fails over.
  // One entry per signal, in detection order: handleData arms them, the
  // provider-signal timer sends the due nudge. A new signal is one entry here.
  //   OOM: a local-GPU OOM — see createOomNudgeGate for why this is separate from
  //        the self-clearing gate above.
  //   truncation: a harness that cut the response off mid-generation (pi's TUI).
  //   capacity: a provider-side `model is at capacity` rejection (Codex); nudged
  //        only after a much longer quiet spell.
  const silenceNudgeSignals = [
    {
      detect: createLocalRuntimeOomDetector(),
      gate: createOomNudgeGate(),
      pendingLine: () => LIFECYCLE_LINES.localOomPending(),
      nudgeText: OOM_NUDGE_TEXT,
      nudgeLabel: 'local-runtime OOM nudge',
      nudgedLine: (attempt) => LIFECYCLE_LINES.localOomNudged({ attempt, max: OOM_NUDGE_MAX_ATTEMPTS }),
    },
    {
      detect: createTruncatedResponseDetector(),
      gate: createTruncationNudgeGate(),
      pendingLine: () => LIFECYCLE_LINES.truncationPending(),
      nudgeText: TRUNCATION_NUDGE_TEXT,
      nudgeLabel: 'truncated-response nudge',
      nudgedLine: (attempt) => LIFECYCLE_LINES.truncationNudged({ attempt, max: TRUNCATION_NUDGE_MAX_ATTEMPTS }),
    },
    {
      detect: createModelAtCapacityDetector(),
      gate: createModelCapacityNudgeGate(),
      pendingLine: () => LIFECYCLE_LINES.capacityPending(),
      nudgeText: CAPACITY_NUDGE_TEXT,
      nudgeLabel: 'model-capacity nudge',
      nudgedLine: (attempt) => LIFECYCLE_LINES.capacityNudged({ attempt, max: CAPACITY_NUDGE_MAX_ATTEMPTS }),
    },
  ];
  // agy quitting back to its launch shell (see createAgyResumeGate). Only a
  // login-shell launch has a shell to fall back to; runner/direct PTYs die with
  // agy and finish through handleExit instead.
  const agyResumeGate = shapeHasLoginShell(launchShape) && isAntigravityCommand(tuiConfig.command) ? createAgyResumeGate() : null;
  let agyResumeAwaitingComposer = false;
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
  const codexModelRejectionGate = isCodexSession ? createCodexModelRejectionGate() : null;
  // The runner's `tui:output` socket messages are live telemetry. An OpenCode
  // CLI that prints one startup error and exits can race that delivery, while
  // its `tui:exit` arrives reliably enough to finish the session. Track whether
  // we received any ordinary chunk so the runner-provided exit tail is spooled
  // only as a recovery path, never duplicated into raw.txt.
  let receivedTuiOutput = false;
  let providerSignalTimer = null;
  let claudeLowPriorityResubmitTimer = null;
  const streamingStrip = createStreamingAnsiStripper();

  // The single fail-over verdict, reached from two places: a signal with no grace
  // window (immediate) and a grace window that expired without recovery. Sharing
  // it keeps the deferred path provably identical to the immediate one.
  //
  // `run.immediateFallbackAnalysis` is set HERE and not at arm time on purpose — it is
  // read at finalize by resolveErrorAnalysis, so stamping it when the window opens
  // would tag a run that went on to RECOVER with the banner as its error.
  const failOverToFallback = (analysis) => {
    run.immediateFallbackAnalysis = analysis;
    appendLine(LIFECYCLE_LINES.providerFallbackSignal({ message: analysis.message }));
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
    if (isTerminal() || run.terminalRefusal || !delivery.promptSubmittedAt) return;
    const attempt = selfClearingGate.takeResubmit(Date.now());
    if (!attempt) return;
    // Only claim the re-submission that actually went out — a false return means
    // the session is already gone, and a transcript line saying otherwise would
    // send a post-mortem looking for a paste the provider never received.
    if (delivery.resubmit()) {
      appendLine(LIFECYCLE_LINES.handshakeResubmitted({ attempt }));
    }
  };

  // `/low-priority` is a hidden Claude Code TUI command, not a CLI startup
  // argument or a supported --print/SDK prompt. On an opted-in session
  // limit, enable the mode and then re-submit the rejected task. A later
  // limit after that re-submit means the mode was unavailable or exhausted.
  // A session limit always consumes the chunk: the caller returns afterwards.
  const handleClaudeSessionLimit = async (sessionLimit) => {
    if (lowPriorityCommandAttempted) {
      if (claudeLowPriorityPromptResubmitted) await failOverToFallback(sessionLimit);
      return;
    }
    if (!mayUseClaudeLowPriority) {
      await failOverToFallback(sessionLimit);
      return;
    }
    lowPriorityCommandAttempted = true;
    let submitted = false;
    try {
      submitted = session.write(run.sessionId, `/low-priority${SUBMIT_KEY}`) !== false;
    } catch (err) {
      emitLog('warn', `TUI agent ${agentId} could not send Claude low-priority command: ${err?.message || err}`, { agentId });
    }
    if (submitted) {
      appendLine(LIFECYCLE_LINES.claudeSessionLimit());
      claudeLowPriorityResubmitTimer = setTimeout(() => {
        claudeLowPriorityResubmitTimer = null;
        if (!isRunning()) return;
        let promptResubmitted = false;
        try {
          promptResubmitted = !!delivery.resubmit({ label: 'Claude low-priority continuation' });
        } catch (err) {
          emitLog('warn', `TUI agent ${agentId} could not re-submit after Claude low-priority: ${err?.message || err}`, { agentId });
        }
        if (promptResubmitted) {
          claudeLowPriorityPromptResubmitted = true;
          appendLine(LIFECYCLE_LINES.claudeLowPriorityResubmitted());
          return;
        }
        failOverToFallback({
          ...sessionLimit,
          message: 'Claude Code low-priority mode was enabled, but the task could not be re-submitted',
        }).catch((err) => emitLog('error', `TUI agent ${agentId} low-priority re-submit fallback failed: ${err?.message || err}`, { agentId }));
      }, CLAUDE_LOW_PRIORITY_RESUBMIT_DELAY_MS);
    } else {
      await failOverToFallback({
        ...sessionLimit,
        message: 'Claude Code session limit reached and /low-priority could not be sent',
      });
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
      if (isTerminal() || run.terminalRefusal) return;
      // node-pty surfaces output as already-decoded UTF-8 strings via
      // shellService's onData hook (StringDecoder handles multi-byte
      // boundaries internally), so `data` is a string here in normal use.
      // The String(...) coerces defensively in case a future caller wires
      // a Buffer-emitting encoding.
      const text = typeof data === 'string' ? data : String(data);
      if (text) receivedTuiOutput = true;
      const stripped = streamingStrip(text);
      pushRaw(text);
      delivery.observeStartupChunk(text, stripped);
      const now = Date.now();
      // A policy refusal ends this request before any recovery/nudge machinery.
      const refusal = isCodexSession && delivery.promptSubmittedAt ? detectContentRefusal(text) : null;
      if (refusal) {
        run.terminalRefusal = refusal;
        run.executionInterruption = { category: refusal.category, source: 'provider', at: new Date(now).toISOString() };
        run.immediateFallbackAnalysis = refusal;
        await persistence.updateAgent(agentId, { metadata: {
          executionInterruption: run.executionInterruption,
        } }).catch(err => emitLog('warn', `Could not persist refusal for ${agentId}: ${err.message}`, { agentId }));
        appendLine(LIFECYCLE_LINES.contentRefused());
        await finish({ success: false, exitCode: 1, error: refusal.message, reason: 'content-refusal' });
        return;
      }

      if (delivery.promptSubmittedAt) codexModelRejectionGate?.observe(stripped);
      delivery.recordOutput(stripped, now);
      recordFirstOutput('tui-pty');

      if (isClaudeCommand(tuiConfig.command) && delivery.promptSubmittedAt) {
        const sessionLimit = detectClaudeSessionLimitBanner(stripped);
        if (sessionLimit) {
          await handleClaudeSessionLimit(sessionLimit);
          return;
        }
      }

      if (!hasStartedWorking) {
        hasStartedWorking = true;
        // A later PTY callback can arrive before the write settles. Keep the
        // stream detectors below in the same synchronous turn as this chunk.
        persistence.updateAgent(agentId, { metadata: { phase: 'working' } })
          .catch(err => emitLog('warn', `Could not persist TUI working phase for ${agentId}: ${err?.message || err}`, { agentId }));
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
        appendLine(LIFECYCLE_LINES.providerSignalCleared({ command: tuiConfig.command }));
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
          appendLine(LIFECYCLE_LINES.providerSignalHolding({ message: fallbackSignal.message, seconds: Math.round(fallbackSignal.graceMs / 1000) }));
        }
      } else if (fallbackSignal) {
        await failOverToFallback(fallbackSignal);
        return;
      }

      if (agyResumeGate && delivery.promptSubmittedAt) {
        agyResumeGate.observe(stripped);
        // A relaunched agy is up once its composer footer paints; only then is the
        // completion request a message to the model rather than boot keystrokes.
        if (agyResumeAwaitingComposer && AGY_INPUT_READY_PATTERN.test(stripped)) {
          agyResumeAwaitingComposer = false;
          if (delivery.resubmit({ text: STALL_NUDGE_TEXT, label: 'agy resume nudge' })) {
            appendLine(LIFECYCLE_LINES.agyResumedNudged());
          }
        }
      }
      // Silence-nudge signals. A local inference OOM, a truncated response and a
      // model-at-capacity rejection all kill the turn but leave the session
      // intact, so each arms a nudge instead of killing the run; the
      // provider-signal timer sends it once the session has actually gone quiet.
      // Gated on delivery.promptSubmittedAt: before the prompt is in there is no turn to
      // resume and the ordinary paste path still owns first delivery. A budget
      // spent on a signal that came back again means the provider is not going to
      // recover (the conversation no longer fits, or it keeps truncating): hand
      // the task to a fallback provider.
      if (delivery.promptSubmittedAt) {
        for (const { detect, gate, pendingLine } of silenceNudgeSignals) {
          const signal = detect(stripped);
          if (!signal) continue;
          const armed = gate.arm(signal, now);
          if (armed === 'armed') {
            appendLine(pendingLine());
          } else if (armed === 'exhausted') {
            await failOverToFallback(signal);
            return;
          }
        }
      }

      // Same gating as the silence nudges above: before the prompt is in there is no
      // request of ours for the provider to be retrying. Acted on by the
      // provider-signal timer, on its own poll, like the other gates.
      if (delivery.promptSubmittedAt) retryStallGate.observe(stripped, now);

      // The permission dialog is Claude Code chrome. Watching another vendor's
      // session for it would only ever match an ECHO — a Codex or agy agent
      // investigating a stalled run cats its raw.txt straight into this stream
      // — and answer a dialog that is not there with keystrokes into a working
      // composer.
      const permissionDialog = delivery.promptSubmittedAt && isClaudeCommand(tuiConfig.command)
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
        session.write(run.sessionId, `${'\x1b[B'.repeat(Math.max(0, permissionDialog.noOption - 1))}${SUBMIT_KEY}`);
        appendLine(LIFECYCLE_LINES.permissionDeclined({ command: tuiConfig.command, toolCall: permissionDialog.toolCall || 'a tool call', count: permissionDialog.count, max: TOOL_PERMISSION_DECLINE_MAX }));
      }

      if (!delivery.promptSentAt) {
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

  const startProviderTimer = (pid) => {
    // Provider-handshake retry timer. It is deliberately not an idle watchdog:
    // a CoS TUI may remain silent for as long as the provider needs.
    providerSignalTimer = setInterval(() => {
      if (isTerminal() || run.terminalRefusal) return;
      // One clock for every gate on this tick. They all measure the same silence,
      // so reading the wall four times only invites them to disagree about it.
      const now = Date.now();
      // A completed Codex turn that rejected account model access cannot be
      // repaired by any continuation nudge. Preserve its actionable outcome
      // without changing the pinned model or authentication/billing mode.
      const modelRejection = isRunning() && delivery.promptSubmittedAt
        ? codexModelRejectionGate?.takeRejected(now, delivery.lastOutputAt)
        : null;
      if (modelRejection && !sentinelPresent()) {
        run.immediateFallbackAnalysis = { ...modelRejection, affectedModel: model, configuredModel: model };
        appendLine(LIFECYCLE_LINES.failure({ summary: modelRejection.message }));
        finish({ success: false, exitCode: 1, error: modelRejection.message, reason: 'model-access-rejected' })
          .catch(err => emitLog('error', `TUI agent ${agentId} model-access finish failed: ${err?.message || err}`, { agentId }));
        return;
      }
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
      // agy fell back to the shell it was launched from: type its own resume
      // command. Checked against the live process tree, not just the banner —
      // the banner also scrolls past in a session that is still running.
      const resumeId = agyResumeGate && isRunning() && delivery.promptSubmittedAt
        ? agyResumeGate.takeResume(now, delivery.lastOutputAt)
        : null;
      if (resumeId) {
        Promise.resolve(session.hasLiveChild(pid)).then((alive) => {
          if (alive || isTerminal()) return;
          const wrote = session.write(run.sessionId, `${tuiConfig.commandLine} --conversation=${resumeId}\r`);
          if (wrote === false) return;
          agyResumeGate.recordRelaunch();
          agyResumeAwaitingComposer = true;
          appendLine(LIFECYCLE_LINES.agyRelaunched({ conversation: resumeId.slice(0, 8), attempt: agyResumeGate.attempts, max: AGY_RESUME_MAX_ATTEMPTS }));
        }).catch((err) => emitLog('error', `TUI agent ${agentId} agy resume failed: ${err?.message || err}`, { agentId }));
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
      const declined = toolPermissionGate.takeNudge(now, delivery.lastOutputAt);
      if (declined) {
        if (delivery.resubmit({ text: TOOL_PERMISSION_NUDGE_TEXT, label: 'declined-permission nudge' })) {
          appendLine(LIFECYCLE_LINES.permissionDeclineNudged({ declined }));
        }
        return;
      }
      // Nudge a session parked by a silence-nudge signal (OOM, truncation, model
      // capacity). Rides this timer rather than one of its own so the nudge
      // cadence and the fail-over verdict stay on the same clock — and so there
      // is one fewer interval to leak past finish().
      for (const { gate, nudgeText, nudgeLabel, nudgedLine } of silenceNudgeSignals) {
        const nudge = gate.takeNudge(now, delivery.lastOutputAt);
        if (!nudge) continue;
        if (delivery.resubmit({ text: nudgeText, label: nudgeLabel })) {
          appendLine(nudgedLine(nudge));
        }
        return;
      }
      // A prompt still sitting unsubmitted gets the Enter it missed, long before
      // the stall nudge below would paste a second message on top of it.
      if (isRunning() && delivery.promptSubmittedAt && delivery.pressUnsubmittedEnter(now)) return;
      // Last, and only once no gate above has a say: every one of them describes a
      // session stalled for a KNOWN reason, and their own silence tests would be
      // pre-empted by a nudge sent on plain quiet.
      //
      // `isRunning()` also excludes in-flight decisions: a finish() parked on the merge-gate
      // contract check (a `gh` PR probe) sits in 'finishing' for as long as that
      // network call takes, non-terminal the whole time, and it may yet paste a
      // nudge of its own. And `delivery.promptSubmittedAt`, because before the prompt is
      // in the promptTimer owns delivery — silence there is startup, not a stall.
      // A no-deadline security audit may be quiet during the scan AND its later
      // validation/fix work. Silence alone must not inject another turn or badge
      // it as stalled. Explicit provider failures and terminal signals above stay active.
      if (!isRunning() || !delivery.promptSubmittedAt || securityScanGrant?.timeLimitSeconds === 'unlimited') return;
      // The task's schedule turned the nudge off (taskMetadata.stallNudge). Its
      // quiet stretches are waits it owns — do-release parks on its release PR's
      // CI — so silence there is not a stall to interrupt. Only once the prompt
      // has started a turn: before that, these nudges are what detects a prompt
      // that never ran and fails it (prompt-not-submitted) instead of holding
      // its lane forever.
      if (delivery.hasWorked && isFalsyMeta(task?.metadata?.stallNudge)) return;
      const stalled = stallNudgeGate.takeNudge(now, delivery.lastOutputAt);
      if (!stalled) return;
      // Read the sentinel here rather than on every tick: its watcher polls on its
      // own clock, so a run can be done-but-not-yet-finalized at this instant, and
      // this is the only moment the answer is acted on.
      if (sentinelPresent()) return;
      if (stalled === 'exhausted' && !delivery.hasWorked) {
        // Nothing but echoes of PortOS's own keystrokes since the submit: the
        // prompt never started a turn. Parking it would keep a live run that
        // registered as a possible claim owner (claimSelectionPending) holding
        // every claim checkout in its repository; failing it releases them and
        // requeues the task through the ordinary retry budget.
        emitLog('warn', `🛑 TUI agent ${agentId} never started its prompt — failing it after ${stallNudgeGate.nudgesSent} stall nudges`, { agentId });
        finishStartupFailure(
          'prompt-not-submitted',
          `${tuiConfig.command} never started working on the submitted prompt: the session stayed idle through ${stallNudgeGate.nudgesSent} stall nudges.`,
        ).catch(err => emitLog('error', `TUI agent ${agentId} finishStartupFailure(prompt-not-submitted) failed: ${err?.message || err}`, { agentId }));
        return;
      }
      if (stalled === 'exhausted') {
        // Every nudge in the streak was ignored (wedged below its composer), or the
        // run spent its lifetime budget answering nudges without ever finishing
        // (a model looping on "continue"). Either way more nudges won't help. There is no ceiling left to reap it, so say
        // so loudly and badge the card — an agent nobody can see is stuck is the
        // condition this gate exists to end, and only a human can end this one.
        appendLine(LIFECYCLE_LINES.stallGaveUp({ nudges: stallNudgeGate.nudgesSent }));
        emitLog('warn', `🛑 TUI agent ${agentId} is wedged — still idle after ${stallNudgeGate.nudgesSent} stall nudges`, { agentId });
        persistence.updateAgent(agentId, { metadata: { phase: 'stalled' } }).catch((err) =>
          emitLog('error', `TUI agent ${agentId} stalled-phase update failed: ${err?.message || err}`, { agentId }));
        // Re-arm the onData handler's one-shot "phase: working" write, so a
        // session that wakes up later (a provider call that finally returned)
        // clears the badge on its next chunk instead of wearing it to the end.
        hasStartedWorking = false;
        return;
      }
      if (delivery.resubmit({ text: STALL_NUDGE_TEXT, label: 'stalled-session nudge' })) {
        appendLine(LIFECYCLE_LINES.stallNudged({ attempt: stalled, max: STALL_NUDGE_MAX_ATTEMPTS, sent: stallNudgeGate.nudgesSent, total: STALL_NUDGE_MAX_TOTAL }));
      }
    }, PROVIDER_SIGNAL_POLL_MS);
  };

  return {
    handleData,
    handleExit,
    startProviderTimer,
    stopTimers() {
      if (providerSignalTimer) { clearInterval(providerSignalTimer); providerSignalTimer = null; }
      if (claudeLowPriorityResubmitTimer) { clearTimeout(claudeLowPriorityResubmitTimer); claudeLowPriorityResubmitTimer = null; }
    },
  };
}
