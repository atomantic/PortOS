/**
 * One-shot TUI prompt runner.
 *
 * Spawns a TUI binary (Claude Code, Codex, Antigravity, etc.) in a PTY, waits for
 * the prompt cursor to become input-ready, bracketed-pastes the prompt + Enter,
 * watches for the model response to complete via sustained output-idle, then
 * strips ANSI and returns the captured text. Persists a run record under
 * `data/runs/<runId>/` so /runs can replay TUI invocations alongside CLI/API.
 *
 * Distinct from `server/services/agent/agentTuiSpawning.js` — that path wraps
 * long-running CoS agents (worktree, /simplify, /do:pr, .agent-done sentinel).
 * This is the synchronous "send prompt, get text back" variant the central
 * promptRunner needs when `provider.type === 'tui'`.
 *
 * Spawning bypasses `services/shell.js` deliberately:
 *   - shellService caps interactive sessions, which the central handler can
 *     exceed easily (arc planner fans out parallel calls). We still *register*
 *     the spawned PTY as an external view afterward (see below) — that path is
 *     exempt from the cap, so surfacing the run doesn't re-introduce the limit.
 *   - shellService wraps a login shell around the TUI; pasting `${cmd}\n`
 *     into a zsh prompt is slower and noisier than spawning the TUI directly.
 *
 * Completion detection, in priority order: the model's response-file write
 * is the authoritative "done" signal (the wrapped prompt directs it to write
 * its full answer to `tui-response.txt` and then finish) — checked
 * unconditionally, even while a human watches. Output-idle is the fallback for
 * TUIs that print inline instead of writing the file (paused while watched, so
 * a viewer isn't snapped shut mid-read). Codex is excluded from that fallback:
 * its status chrome can go silent for long stretches during real reasoning,
 * and the required response file is the only safe completion signal. The hard
 * timeout is the backstop, and salvages an already-written file before failing.
 * Per-binary input-prompt
 * regexes were considered for idle but are fragile across versions and screen
 * sizes; for non-Codex TUIs, the idle threshold (~8s) remains the pragmatic
 * inline-output fallback.
 */

import { maintenance } from '../lib/maintenanceAdmission.js';
import { createStreamingAnsiStripper, stripAnsi } from '../lib/ansiStrip.js';
import { createContentRefusalDetector } from '../lib/aiToolkit/errorDetection.js';
import { createPasteSubmitDriver } from '../lib/tuiPasteSubmitDriver.js';
import { isCodexCommand } from '../lib/codex.js';
import {
  countPasteMarkers, createPromptSubmissionGate, detectMissingTuiBinary, OUTPUT_BUFFER_CAP, OUTPUT_BUFFER_HEADROOM,
} from '../lib/tuiHandshake.js';
import { finalizeRunRecord } from './runner.js';
import { pasteToSession } from './shell.js';
import { prepareInvocation } from './tuiPromptRunner/prepareInvocation.js';
import { runTuiSession, finishTuiExit } from './tuiPromptRunner/sessionLifecycle.js';
import { createResponseWatcher } from './tuiPromptRunner/responseWatcher.js';
import { createStartupWatcher } from './tuiPromptRunner/startupWatcher.js';
import { createProviderRecovery } from './tuiPromptRunner/providerRecovery.js';
import { createTuiFinalizer } from './tuiPromptRunner/finalizeTuiRun.js';

export { cleanTuiResponse, resolveTuiResponseText } from './tuiPromptRunner/finalizeTuiRun.js';

const UNSUBMITTED_PROMPT_POLL_MS = 1000;
// A one-shot answer can be short, quick and free of in-flight chrome (OpenCode).
// The agent path's 30s echo window would read it as an ignored submit and hold
// idle completion for the whole Enter budget. An ignored Enter repaints nothing,
// so output this long after PortOS's last keystroke means the turn ran.
const ONE_SHOT_PROMPT_WORK_EVIDENCE_MS = 2500;

/**
 * Run a single prompt through a TUI provider. Mirrors the signature of
 * `executeCliRun` / `executeApiRun` so the central handler treats all three
 * branches uniformly (a single options object).
 *
 * Caller (typically `runPromptThroughProvider`) owns the run record:
 *   - `createRun` (toolkit) writes the initial metadata.json + prompt.txt
 *   - this function writes output.txt and finalizes metadata.json on exit
 *     via `runner.js#finalizeRunRecord`, so /runs shows TUI runs with the
 *     same success/exitCode/duration shape as CLI runs.
 *
 * @param {object} options
 * @param {string} options.runId — pre-created run id (from createRun).
 * @param {object} options.provider — { id, type: 'tui', command, args, envVars,
 *   tuiPromptDelayMs?, tuiOneShotIdleMs?, timeout?, defaultModel? }. The
 *   model passed to `--model` is taken from `provider.defaultModel`; per-
 *   call overrides are applied by the central handler via a provider clone
 *   before this function is reached.
 * @param {string} options.prompt — full text to paste into the TUI.
 * @param {string} options.workspacePath — working directory for the spawned TUI.
 * @param {(chunk: string) => void} [options.onData] — incremental ANSI-stripped
 *   output stream.
 * @param {(meta: object) => void} [options.onComplete] — fired after exit with
 *   `{ exitCode, duration, success, error?, model? }`. Promise resolves
 *   AFTER this fires.
 * @param {number} [options.timeout] — hard cap on a single run (ms). Falls back to
 *   `provider.timeout`, then `DEFAULT_TIMEOUT_MS`.
 * @param {number} [options.idleMs] — response-complete idle threshold (ms) for
 *   THIS call, overriding `provider.tuiOneShotIdleMs` and the 8s default. The
 *   default suits a chatty text reply that goes quiet within seconds; a task
 *   that streams sparse output during a long operation (e.g. a multi-minute
 *   grok `image_to_video` render) needs a larger value so a mid-work lull isn't
 *   mistaken for completion. Pair with a larger `timeout`.
 * @param {string} [options.label] — human label for the live Shell view (the
 *   run `source`, e.g. `'pipeline-manuscript-completeness'`). Surfaced in the
 *   Shell page's session tab; falls back to `command · model` when absent.
 * @param {boolean} [options.guard=false] — prepend the PM2 guard shim for an
 *   autonomous task that must not be able to kill the shared PortOS daemon.
 * @param {boolean} [options.reportFailure=true] — fire the host's `onRunFailed`
 *   hook when the run fails. Pass `false` for a deliberate PROBE of a provider
 *   (the local-model benchmark): its failure is the caller's measurement, which
 *   it reports itself, not a provider incident for the autofixer to escalate.
 * @returns {Promise<void>}
 */
export async function executeTuiRun(options) {
  const permit = maintenance.admit('tui-run', options.runId, { continuation: true });
  const lifecycle = { spawned: false, exited: false, cleaned: false,
    settle() { if (this.cleaned && (!this.spawned || this.exited)) return permit.finish(); } };
  try { return await permit.run(() => executeAdmittedTuiRun(options, lifecycle)); }
  catch (err) {
    if (err.code === 'EXECUTION_OPTIONS_UNSUPPORTED') {
      await finalizeRunRecord({ runId: options.runId, output: '', exitCode: 1, success: false, error: err.message, startTime: Date.now(), reportFailure: false });
    }
    if (lifecycle.spawned) permit.markUnsettled(); throw err; }
  finally { lifecycle.cleaned = true; await lifecycle.settle(); }
}

async function executeAdmittedTuiRun(options, maintenanceLifecycle) {
  const invocation = await prepareInvocation(options);
  if ('failure' in invocation) return invocation.failure;
  return runTuiSession(options, invocation, maintenanceLifecycle, watchTuiSession);
}

function watchTuiSession(options, invocation, session) {
  const { runId, onData } = options;
  const { command, wrappedPrompt } = invocation;
  const { ptyProcess } = session;
  const startTime = Date.now();
  const state = {
    startTime, lastOutputAt: startTime, firstOutputAt: null, promptSentAt: null, promptSubmittedAt: null,
    outputBuffer: '', outputBufferTruncated: false, finalized: false,
  };
  const streamingStrip = createStreamingAnsiStripper();
  const detectContentRefusal = createContentRefusalDetector();
  // The paste chip can render and every submit Enter still be ignored, leaving
  // the prompt sitting in the composer (#12769). Shared with the agent path.
  // The marker count is taken on the STRIPPED prompt, the way it echoes back.
  const promptGate = createPromptSubmissionGate({
    promptMarkerCount: countPasteMarkers(stripAnsi(wrappedPrompt)),
    workEvidenceMs: ONE_SHOT_PROMPT_WORK_EVIDENCE_MS,
  });

  return new Promise((resolve) => {
    const finish = createTuiFinalizer({
      options, invocation, session, state, resolve,
      cleanupTimers() {
        pasteDriver.cancel();
        startup.stop();
        response.stop();
        recovery.stop();
      },
    });
    const pasteDriver = createPasteSubmitDriver({
      prompt: wrappedPrompt,
      command,
      // node-pty's write takes only the data; the promptSubmission hint is the
      // shell session layer's, which this direct PTY bypasses.
      write: (keys) => ptyProcess.write(keys),
      // pasteToSession schedules its own submit Enters and returns their
      // handle, or false once the PTY has been unregistered.
      paste: (text, { label }) => pasteToSession(runId, text, { label: `[tuiRun ${runId}] ${label}` }),
      isFinalized: () => state.finalized,
      onFail: (reason, error) => finish({ success: false, exitCode: 1, reason, error }),
      onSubmitted: () => { state.promptSubmittedAt = Date.now(); },
      promptGate,
      getLastOutputAt: () => state.lastOutputAt,
      settleRule: isCodexCommand(command) ? 'codex' : 'default',
      unsubmittedPollMs: UNSUBMITTED_PROMPT_POLL_MS,
      logError: (message) => console.error(`${message} (TUI run ${runId})`),
      onEvent: (event) => {
        if (event.type === 'pasted') {
          const attempt = event.attempt > 1 ? ` [attempt ${event.attempt}]` : '';
          console.log(`📟 Pasted prompt into TUI ${command} (${event.reason})${attempt}`);
        } else if (event.type === 'paste-retrying') {
          console.log(`⚠️ TUI run ${runId} paste not confirmed — retrying in ${event.delayMs}ms${event.mcpBootActive ? ' (MCP servers booting)' : ''}`);
        } else if (event.type === 'unsubmitted-enter') {
          console.log(`🔁 TUI run ${runId} prompt still unsubmitted in the composer — pressed Enter (attempt ${event.attempt}/${event.max})`);
        }
      },
    });
    const response = createResponseWatcher({
      runId, invocation, state, finish, blocksIdle: () => recovery.blocksIdle || promptGate.awaitingSubmit,
    });
    const recovery = createProviderRecovery({
      runId, invocation, state, ptyProcess, pasteDriver, finishWithFallbackSignal: response.finishWithFallbackSignal,
    });
    const startup = createStartupWatcher({
      runId, invocation, state, ptyProcess, finish,
      sendPrompt(reason) {
        if (state.finalized || state.promptSentAt) return;
        state.promptSentAt = Date.now();
        if (pasteDriver.start(reason)) response.watchFile();
      },
    });

    ptyProcess.onData((data) => {
      // One clock reading for the whole chunk — the grace-window bookkeeping
      // below and the idle/response timestamps at the end all want the same
      // instant, and this runs on every PTY chunk of every run.
      const now = Date.now();
      const text = data.toString();
      const stripped = streamingStrip(text);
      const refusal = isCodexCommand(command) && state.promptSubmittedAt ? detectContentRefusal(text) : null;
      if (refusal) {
        void finish({ success: false, exitCode: 1, error: refusal.message,
          reason: 'content-refusal', errorAnalysis: refusal });
        return;
      }

      // The readiness tracker needs both streams: bracketed-paste transitions
      // survive only in raw output, while startup dialog text is ANSI-stripped.
      startup.observe(text, stripped);
      if (stripped) {
        promptGate.observe(stripped, now);
        pasteDriver.ingest(stripped);
        state.outputBuffer += stripped;
        if (state.outputBuffer.length > OUTPUT_BUFFER_HEADROOM) {
          state.outputBuffer = state.outputBuffer.slice(-OUTPUT_BUFFER_CAP);
          if (!state.outputBufferTruncated) {
            state.outputBufferTruncated = true;
            console.warn(`⚠️ TUI run ${runId} output buffer exceeded ${Math.round(OUTPUT_BUFFER_HEADROOM / 1024 / 1024)}MB — head dropped (response file is the authoritative path; fallback may be incomplete)`);
          }
        }
        try { onData?.(stripped); } catch (err) {
          console.error(`❌ TUI run ${runId} output hook failed: ${err?.message || err}`);
        }

        if (recovery.observe(stripped, now)) return;
      }

      state.lastOutputAt = now;
      if (state.firstOutputAt === null) state.firstOutputAt = now;
      if (state.promptSentAt && now > state.promptSentAt) response.watchIdle();
      // Early-fail probe — without this guard a typo'd provider.command
      // would idle until the hard timeout (5 min default).
      if (!state.promptSentAt && detectMissingTuiBinary(stripped, command)) {
        finish({
          success: false,
          exitCode: 127,
          error: `TUI command not found: ${command}`,
          reason: 'command-not-found'
        });
      }
    });

    startup.start();
    response.watchDeadline();
    session.onExit((event) => finishTuiExit({
      runId, state, finish, detectTerminalRequestTimeout: recovery.detectTerminalRequestTimeout,
      finishWithFallbackSignal: response.finishWithFallbackSignal,
    }, event));
  });
}
