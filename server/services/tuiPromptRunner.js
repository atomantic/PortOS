/**
 * One-shot TUI prompt runner.
 *
 * Spawns a TUI binary (Claude Code, Codex, Antigravity, etc.) in a PTY, waits for
 * the prompt cursor to become input-ready, bracketed-pastes the prompt + Enter,
 * watches for the model response to complete via sustained output-idle, then
 * strips ANSI and returns the captured text. Persists a run record under
 * `data/runs/<runId>/` so /runs can replay TUI invocations alongside CLI/API.
 *
 * Distinct from `server/services/agentTuiSpawning.js` — that path wraps
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

import { spawn as ptySpawn } from 'node-pty';

import { join, resolve } from 'path';
import { ensureDir, PATHS, tryReadFile } from '../lib/fileUtils.js';
import { createStreamingAnsiStripper, stripAnsi } from '../lib/ansiStrip.js';
import {
  createImmediateFallbackSignalDetector,
  createTerminalModelErrorDetector,
  createTerminalRequestTimeoutDetector,
} from '../lib/aiToolkit/errorDetection.js';
import { getRunsPath, finalizeRunRecord, failRunRecord, emitRunStarted, registerActiveRun, unregisterActiveRun, consumeRunStopRequested, resolveRunCwd } from './runner.js';
import { registerExternalSession, unregisterExternalSession, isExternalSessionAttached, pasteToSession } from './shell.js';
import { isHostShuttingDown } from '../lib/hostShutdown.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import {
  DEFAULT_TUI_PROMPT_DELAY_MS,
  PASTE_MARKER_POLL_MS,
  countPasteMarkers,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  scheduleSubmitEnters,
  SELF_CLEARING_RESUBMIT_POLL_MS,
  PASTE_DEADLINE_MS,
  TUI_INPUT_READY_DEADLINE_MS,
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  OUTPUT_BUFFER_CAP,
  OUTPUT_BUFFER_HEADROOM,
  RAW_BUFFER_CAP,
  RAW_BUFFER_HEADROOM,
  buildTuiInvocation,
  createInputReadyTracker,
  detectMissingTuiBinary,
  createSelfClearingSignalGate,
  SUBMIT_KEY,
} from '../lib/tuiHandshake.js';
import { buildCliChildEnv } from '../lib/cliChildEnv.js';
import { isCodexCommand } from '../lib/codex.js';
import { isClaudeCommand } from '../lib/providerModels.js';

// One-shot defaults that don't apply to the long-running agent path:
//   - hard run cap (5 min vs unbounded for agents)
//   - response-complete idle threshold (8s vs 180s for agents — agents wait
//     out tool calls + /simplify + /do:pr, we're just waiting for the model
//     to stop talking)
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_ONE_SHOT_IDLE_MS = 8000;

// A one-shot prompt must return one machine-consumed answer. Codex's general
// interactive TUI inherits the user's multi-agent feature flag, which can turn
// that bounded request into agent fan-out + wait loops that consume the entire
// timeout before the fallback provider repeats the work. Long-running CoS
// agents use agentTuiSpawning.js and keep their configured collaboration
// posture; only this synchronous prompt runner pins the feature off.
function buildOneShotTuiArgs(command, args) {
  if (!isCodexCommand(command)) return args;
  const alreadyDisabled = args.some((arg, index) => (
    arg === '--disable=multi_agent'
    || (arg === '--disable' && args[index + 1] === 'multi_agent')
    || (arg === '-c' && args[index + 1] === 'features.multi_agent=false')
  ));
  return alreadyDisabled ? args : [...args, '--disable', 'multi_agent'];
}

// Wide PTY so TUI doesn't wrap responses at narrow widths, which makes
// downstream parsing harder.
const PTY_COLS = 200;
const PTY_ROWS = 50;

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
export async function executeTuiRun({ runId, provider, prompt, workspacePath, onData, onComplete, onReady, timeout, idleMs, label, guard = false, reportFailure = true }) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('executeTuiRun: provider is required');
  }
  if (typeof prompt !== 'string' || !prompt) {
    throw new Error('executeTuiRun: prompt must be a non-empty string');
  }

  const invocation = buildTuiInvocation(provider, provider.defaultModel);
  const { command } = invocation;
  const args = buildOneShotTuiArgs(command, invocation.args);
  const promptDelayMs = provider.tuiPromptDelayMs ?? DEFAULT_TUI_PROMPT_DELAY_MS;
  const idleThresholdMs = idleMs ?? provider.tuiOneShotIdleMs ?? DEFAULT_ONE_SHOT_IDLE_MS;
  const totalTimeoutMs = timeout ?? provider.timeout ?? DEFAULT_TIMEOUT_MS;
  // Codex is explicitly instructed to write the machine-consumed answer to a
  // response file. Its PTY may stop repainting for many seconds or minutes
  // while the model is still reasoning; treating that quiet screen as a final
  // inline answer kills the live request and returns terminal chrome such as
  // "[Pasted Content …]" to JSON parsers. Wait for the authoritative file,
  // natural process exit, explicit cancellation, or the configured hard cap.
  const requiresResponseFileForIdleCompletion = isCodexCommand(command);
  // Mirror runner.js#executeCliRun's runs-path resolution so TUI runs land
  // under the runner-config dataDir (not always PATHS.runs) — otherwise a
  // non-default dataDir would split metadata + output across two trees.
  const runDir = join(getRunsPath(), runId);
  await ensureDir(runDir);

  // Who this run is, for a finalize that finds no `createRun` metadata on disk
  // to merge into. Mirrors `emitRunStarted`'s naming so the started and failed
  // events describe the same run — they used to disagree, and the failure event
  // was the anonymous one.
  const runIdentity = {
    providerId: provider.id,
    providerName: provider.name || provider.id,
    model: provider.defaultModel,
  };

  // Logs the effective cwd, and rejects a workspace that was requested but is
  // missing on disk instead of silently spawning in the PortOS root (#3180).
  // Sequenced after ensureDir so finalizeRunRecord has a run dir to write into.
  const { cwd: workingDir, failure } = await resolveRunCwd({
    runId, workspacePath, label: `TUI run ${runId}`, onData, onComplete, identity: runIdentity, reportFailure,
  });
  if (failure) return failure;

  // TUI screens redraw their banner, input chrome, and status bar on every
  // keystroke — scraping the PTY stream for the model's reply is
  // fundamentally lossy (box-drawing chars, "5%" cost meters, "bypass
  // permissions on" hints, etc. all bleed into the captured text). Ask the
  // model to write its final response to a file we'll read back instead.
  //
  // `resolve()` is load-bearing: `runnerConfig.dataDir` defaults to the
  // relative `'./data'`, and the TUI's cwd (`workingDir`) is frequently a
  // different directory (universe/loop workspaces, target-app paths). A
  // relative path embedded in the prompt would tell the LLM to write into
  // its own cwd while the server reads from process.cwd() — different
  // files, fallback every time.
  const responseFilePath = resolve(runDir, 'tui-response.txt');
  const wrappedPrompt = `IMPORTANT — Output to file:
When you have completed the task below, write your COMPLETE final response (and nothing else — no commentary, preamble, or wrapper text) to this exact absolute path using your file-writing tool:

    ${responseFilePath}

Only the contents of that file will be used as your response, so do not print the response inline. Once the file is written, you can finish.

----- TASK -----

${prompt}`;

  console.log(`📟 Executing TUI: ${command} ${args.join(' ')} (${wrappedPrompt.length} chars via paste, response→${responseFilePath})`);

  // Markers already present in the (wrapped) prompt itself — a transcript-analysis
  // task can echo `[Pasted text #N]` back into the post-paste stream. The fast
  // path must wait for the TUI's OWN marker (the count to EXCEED this), so an
  // echoed marker doesn't fire the submit-Enter mid-reflow (issue #1229 review).
  // STRIP first so a pasted RAW transcript's cursor-positioned marker (counts as 0
  // unstripped) is counted the same way the stripped post-paste buffer is.
  const promptMarkerCount = countPasteMarkers(stripAnsi(wrappedPrompt));

  // Shared composition (provider.envVars + OpenCode models map + PWD pin +
  // CLAUDECODE strip) — see buildCliChildEnv. The PWD pin matters here because
  // this PTY runs the CLI directly, so there is no login shell to rewrite PWD
  // for us. TERM/COLORTERM go in `extra` so they override any provider setting —
  // the PTY is always a truecolor xterm regardless of provider config. No
  // `guard`: this is a Run Prompt TUI, not an autonomous agent.
  const childEnv = buildCliChildEnv({
    provider,
    cwd: workingDir,
    guard,
    extra: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  // A PTY has no shell to print "command not found": node-pty forks, `execvp`
  // fails in the child, and the child exits 1 with an EMPTY screen. So the
  // output-driven `detectMissingTuiBinary` probe further down can never fire on
  // this path, and the run finalized as a bare `TUI exited with code 1` — no
  // provider, no cause, nothing to act on. Resolve against the CHILD's PATH
  // (`childEnv`, since a provider may override PATH with only its own bin dir)
  // and report the real reason with the 127 that probe already uses.
  if (!findCommandOnPath(command, { env: childEnv, cwd: workingDir })) {
    return failRunRecord({
      runId,
      error: `TUI command not found: ${command}`,
      exitCode: 127,
      startTime: Date.now(),
      onData,
      onComplete,
      identity: runIdentity,
      reportFailure,
    });
  }

  let ptyProcess;
  try {
    ptyProcess = ptySpawn(command, args, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: workingDir,
      env: childEnv,
    });
  } catch (err) {
    throw new Error(`Failed to spawn TUI '${command}': ${err.message}`);
  }

  // Subscribe to exit IMMEDIATELY after spawn. A CLI can fail before its first
  // paint (bad local config, an early runtime crash, etc.); the rest of this
  // function registers the run, Shell view, and completion machinery before it
  // used to attach onExit. node-pty does not replay an already-delivered exit,
  // so that small window stranded the run until its hard timeout. Queue the
  // one exit event until finish() and the timers below are ready, then replay it
  // through the ordinary exit path. This is a startup/lifecycle guard, not an
  // output-idle timeout: a live but quiet model remains untouched.
  let dispatchPtyExit = null;
  let pendingPtyExit = null;
  ptyProcess.onExit((event) => {
    if (dispatchPtyExit) {
      dispatchPtyExit(event);
      return;
    }
    pendingPtyExit = pendingPtyExit || event;
  });

  // Register in the same active-runs map the patched stopRun/isRunActive
  // consult, so /runs UI can stop a hung TUI run. Without this, stopRun is a
  // no-op for TUI and isRunActive returns false — the PTY keeps spending
  // tokens with no way to cancel from the UI. Mirrors executeCliRun's
  // registration of its ChildProcess; node-pty's IPty exposes the same
  // .kill(signal?) interface so the patched stopRun works unchanged.
  registerActiveRun(runId, ptyProcess);

  // Fire the toolkit's `onRunStarted` hook now that the PTY is alive — the
  // CLI/API paths fire it inside the toolkit's executeCliRun/executeApiRun,
  // but the TUI path doesn't go through those. Without this hook, /runs and
  // any SSE-based "active run" UI never see TUI runs as in-flight.
  emitRunStarted({ runId, provider, model: provider.defaultModel });

  // Surface this one-shot run as an interactive session in the Shell UI so the
  // user can watch its live output and step in — answer a question, correct it,
  // or interrupt it (it bypasses services/shell.js for *spawning*, but
  // registering the already-live PTY for *viewing/driving* doesn't re-introduce
  // the cap/login-shell concerns the spawn bypass avoids).
  const viewLabel = (typeof label === 'string' && label)
    ? label
    : `${command} · ${provider.defaultModel || 'tui'}`;
  registerExternalSession(runId, ptyProcess, {
    label: viewLabel,
    command: `${command} ${args.join(' ')}`.trim(),
    cwd: workingDir,
    kind: 'tui-run',
  });
  try {
    onReady?.({
      runId,
      providerId: provider.id,
      providerName: provider.name || provider.id,
      model: provider.defaultModel,
      providerType: provider.type,
      shellReady: true,
    });
  } catch (err) {
    console.error(`❌ TUI ready hook failed: ${err.message}`);
  }

  const startTime = Date.now();
  let outputBuffer = '';
  let rawBuffer = '';
  let promptSentAt = null;
  // ANSI-stripped post-paste accumulator for paste-marker detection. The marker
  // renders with absolute-column cursor moves between glyphs, so it only matches
  // after stripping — testing the raw stream never matched and left the fast
  // path dead (issue #1229). Lives only during the paste→Enter window; nulled
  // when detection resolves or the run finalizes.
  let postPasteStripped = null;
  let firstOutputAt = null;
  let lastOutputAt = startTime;
  let firstResponseAt = null;
  let finalized = false;
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();
  // One-shot-only: a terminal model-id rejection (Bedrock 400 / Anthropic 404)
  // leaves the TUI idle at an unanswered prompt, so without this the run idles to
  // a false success and the error screen is scraped as the "response". Scoped here
  // (not in the shared fallback detector) so it can't kill a long-running agent
  // that merely echoes the error line — see errorDetection.js for the rationale.
  const detectTerminalModelError = createTerminalModelErrorDetector();
  // Claude Code can exhaust all of its own request retries and then exit 0 with
  // only `⎿ Request timed out` on screen. This one-shot-only detector lets the
  // central runner fall back instead of parsing that terminal as creative output.
  const detectTerminalRequestTimeout = createTerminalRequestTimeoutDetector();
  // True once outputBuffer overflowed OUTPUT_BUFFER_HEADROOM and the head was
  // dropped. We warn once and surface it in the run record so /runs can flag
  // responses where the fallback path may have lost the start.
  let outputBufferTruncated = false;

  const streamingStrip = createStreamingAnsiStripper();
  // This PTY spawns the TUI directly, so the TUI's first paste-mode ON is the
  // positive ready signal. Claude gets that positive gate; other providers
  // retain their existing idle/deadline behavior.
  const inputReady = createInputReadyTracker({ directLaunch: true });
  const requiresInputReady = isClaudeCommand(command);
  // Keep local one-shot flags alongside the tracker's terminal acknowledgements
  // so a failed/delayed PTY write cannot cause repeated selector navigation.
  let trustAccepted = false;
  let hookReviewDeclined = false;

  // The wrapped prompt directs the model to write its COMPLETE response to
  // `responseFilePath` and then finish. That file appearing is the model's
  // explicit "done" signal — more reliable than output-idle and, unlike idle,
  // authoritative even while a human watches (the task is finished; there's
  // nothing left to intervene in). Returns true once the file has non-empty
  // content whose length held steady across two consecutive polls (~1s apart),
  // so a half-flushed write isn't read as complete. `lastResponseLen = -1`
  // means "not yet seen / reset"; a real reading seeds it and the next equal
  // reading confirms stability.
  let lastResponseLen = -1;
  const responseFileSettled = async () => {
    const txt = await tryReadFile(responseFilePath);
    if (typeof txt !== 'string' || !txt.trim()) { lastResponseLen = -1; return false; }
    if (txt.length === lastResponseLen) return true;
    lastResponseLen = txt.length;
    return false;
  };
  // Stability doesn't apply once nothing can still be writing (hard timeout with
  // the TUI wedged, or the PTY already gone): non-empty content is the whole
  // answer by then.
  const responseFileHasContent = async () => {
    const txt = await tryReadFile(responseFilePath);
    return typeof txt === 'string' && !!txt.trim();
  };

  let readyTimer = null;
  let pasteEnterTimer = null;
  let submitEnterTimer = null;
  let idleWatchTimer = null;
  let responseFileWatchTimer = null;
  let hardTimeoutTimer = null;
  // Holds the wait-it-out window for a provider signal carrying a `graceMs`
  // (agy's account-eligibility banner). Unlike the long-running agent path this
  // needs its OWN timer: `idleWatchTimer` is created lazily on the first
  // post-prompt chunk and may not exist yet when the banner paints.
  let selfClearingTimer = null;
  // Re-sends the prompt on a cadence while that window is open (the banner is a
  // REJECTION, not a spinner — see resubmitAfterSignal).
  let selfClearingResubmitTimer = null;
  const selfClearingGate = createSelfClearingSignalGate();
  // The deadline and its retry poll are armed together and always die together —
  // on recovery, at expiry, and on any finish.
  const stopSelfClearingTimers = () => {
    if (selfClearingTimer) { clearTimeout(selfClearingTimer); selfClearingTimer = null; }
    if (selfClearingResubmitTimer) { clearInterval(selfClearingResubmitTimer); selfClearingResubmitTimer = null; }
  };

  const cleanupTimers = () => {
    // Stop the post-paste accumulator from growing on any chunk that lands
    // between finalize and the PTY kill (onData here has no finalized guard).
    postPasteStripped = null;
    if (readyTimer) { clearInterval(readyTimer); readyTimer = null; }
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    if (submitEnterTimer) { clearInterval(submitEnterTimer); submitEnterTimer = null; }
    if (idleWatchTimer) { clearInterval(idleWatchTimer); idleWatchTimer = null; }
    if (responseFileWatchTimer) { clearInterval(responseFileWatchTimer); responseFileWatchTimer = null; }
    if (hardTimeoutTimer) { clearTimeout(hardTimeoutTimer); hardTimeoutTimer = null; }
    stopSelfClearingTimers();
  };

  return new Promise((resolve) => {
    const finish = async ({ success, exitCode = 0, error = null, reason = 'completed', canceled = false }) => {
      if (finalized) return;
      finalized = true;
      // Tracks whether the normal-path onComplete was reached, so the catch
      // below re-surfaces failure ONLY when a step BEFORE onComplete threw —
      // never re-invoking onComplete when onComplete itself was the throw
      // source (that would violate the once-only completion contract).
      let onCompleteInvoked = false;
      // finish() is invoked fire-and-forget from PTY/timer callbacks outside the
      // request lifecycle (onData, onExit, sendPrompt's write-catch,
      // responseFileWatchTimer, hardTimeoutTimer) — none of them await or
      // .catch() this call. try/finally guarantees `resolve` below always fires
      // exactly once even if a step throws (including the caller-supplied
      // `onComplete` callback), so executeTuiRun's Promise can never hang forever.
      try {
        cleanupTimers();
        unregisterActiveRun(runId);
        // Drop the live Shell view the moment the run ends (notifies any attached
        // viewer via shell:exit). Idempotent — safe even if no viewer ever
        // attached. Runs before the kill below so the session disappears from the
        // list immediately rather than waiting on PTY teardown.
        unregisterExternalSession(runId, { exitCode });

        // Kill the PTY if still alive — one-shot runs don't leave a session
        // behind for the user to interact with.
        try { if (ptyProcess && !ptyProcess.killed) ptyProcess.kill(); } catch { /* already gone */ }

        // Prefer the response file the TUI was directed to write; fall back
        // to the ANSI-stripped screen scrape when the file is missing/empty
        // or the run didn't succeed. Logic lives in `resolveTuiResponseText`
        // so it can be unit-tested without a live PTY.
        const { text: responseText, usedResponseFile } = await resolveTuiResponseText({
          success, responseFilePath, outputBuffer, wrappedPrompt,
        });

        // Delegate run-record finalization (output.txt + metadata.json merge
        // + onRunCompleted/onRunFailed hooks + toolkit error analysis) to the
        // shared runner helper. `completionReason` lands in `extras` so it
        // gets persisted to metadata.json BEFORE the write (was previously
        // set post-write and never made it to disk → /runs replay missed it).
        const metadata = await finalizeRunRecord({
          runId, output: responseText, exitCode, success, error, startTime,
          identity: runIdentity,
          reportFailure,
          extras: {
            completionReason: reason,
            usedResponseFile,
            outputTruncated: outputBufferTruncated,
            ...(canceled ? { canceled: true } : {}),
          },
        }).catch((err) => {
          console.error(`❌ TUI run ${runId} finalize failed: ${err.message}`);
          return {
            exitCode, success, error: error || err.message,
            duration: Date.now() - startTime, completionReason: reason,
            ...(canceled ? { canceled: true } : {}),
          };
        });
        onCompleteInvoked = true;
        onComplete?.({ ...metadata, text: responseText, usedResponseFile, outputTruncated: outputBufferTruncated });
      } catch (err) {
        console.error(`❌ TUI run ${runId} finish() failed: ${err?.message || err}`);
        // Ensure the original PTY is torn down even when a cleanup step BEFORE
        // the kill above threw (e.g. unregisterExternalSession). Otherwise the
        // failure we report below rejects executeProviderRunOnce and spins up a
        // fallback provider while the original PTY keeps running — two live runs
        // for one request. Idempotent: no-op if the kill above already fired.
        try { if (ptyProcess && !ptyProcess.killed) ptyProcess.kill(); } catch { /* already gone */ }
        // A step BEFORE onComplete threw, so the caller's onComplete-driven
        // settle never fired. executeProviderRunOnce (promptRunner.js) settles
        // its OUTER Promise only via onComplete (→ safeReject) or the returned
        // promise rejecting — and our try/finally always resolves (never
        // rejects), so `.catch(safeReject)` won't fire either. Without this,
        // resolving the inner promise leaves the central-prompt/pipeline caller
        // pending forever — the exact hang this patch exists to prevent. Deliver
        // failure metadata so onComplete → safeReject settles the caller. Skip
        // this when onComplete itself was the throw source (onCompleteInvoked) —
        // re-invoking it would break the once-only completion contract and could
        // emit a contradictory success-then-failure. Guard the callback so a
        // throw here doesn't escape finish() (un-awaited → unhandled rejection)
        // and still fall through to resolve().
        if (!onCompleteInvoked) {
          try {
            onComplete?.({
              runId, success: false, exitCode, error: `finish() failed: ${err?.message || err}`,
              duration: Date.now() - startTime, completionReason: reason,
              ...(canceled ? { canceled: true } : {}),
            });
          } catch (cbErr) {
            console.error(`❌ TUI run ${runId} onComplete threw during finish() error handling: ${cbErr?.message || cbErr}`);
          }
        }
      } finally {
        resolve();
      }
    };

    // A fallback signal means "this provider can't finish the job" — but the
    // model may have ALREADY finished it. responseFileWatchTimer only finalizes
    // after two 1s polls agree on the file size, so there is a ≥1s window where
    // the response file is complete on disk and the run hasn't finalized. A
    // signal painting inside that window used to finish({ success: false }),
    // and since resolveTuiResponseText only reads the file when `success` is
    // true, the finished response was discarded, the ANSI-stripped error screen
    // was returned in its place, and a fallback tier re-ran an expensive stage
    // (#3715). Check for a usable response file first — the same salvage net the
    // hard-timeout path already has. While the PTY is alive the file must be
    // size-stable (it could still be mid-write); once the process has exited
    // nothing can still be writing, so non-empty is enough.
    const finishWithFallbackSignal = async (signal, { processExited = false } = {}) => {
      const salvaged = processExited
        ? await responseFileHasContent()
        : await responseFileSettled();
      if (finalized) return;
      if (salvaged) {
        console.log(`📄 TUI run ${runId} salvaged its completed response file despite a fallback signal: ${signal.message}`);
        await finish({ success: true, exitCode: 0, reason: 'fallback-signal-response-file' });
        return;
      }
      await finish({
        success: false,
        exitCode: signal.exitCode ?? 1,
        error: signal.message || 'Provider requires fallback',
        reason: 'fallback-signal',
      });
    };

    ptyProcess.onData((data) => {
      // One clock reading for the whole chunk — the grace-window bookkeeping
      // below and the idle/response timestamps at the end all want the same
      // instant, and this runs on every PTY chunk of every run.
      const now = Date.now();
      const text = data.toString();
      rawBuffer += text;
      if (rawBuffer.length > RAW_BUFFER_HEADROOM) rawBuffer = rawBuffer.slice(-RAW_BUFFER_CAP);

      const stripped = streamingStrip(text);
      // The readiness tracker needs both streams: bracketed-paste transitions
      // survive only in raw output, while startup dialog text is ANSI-stripped.
      inputReady.observe(text, stripped);
      if (stripped) {
        if (postPasteStripped !== null) postPasteStripped += stripped;
        outputBuffer += stripped;
        if (outputBuffer.length > OUTPUT_BUFFER_HEADROOM) {
          outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_CAP);
          if (!outputBufferTruncated) {
            outputBufferTruncated = true;
            console.warn(`⚠️ TUI run ${runId} output buffer exceeded ${Math.round(OUTPUT_BUFFER_HEADROOM / 1024 / 1024)}MB — head dropped (response file is the authoritative path; fallback may be incomplete)`);
          }
        }
        onData?.(stripped);

        // While a grace window is open, every chunk is evidence about whether the
        // provider came back; the gate closes itself the moment it is, which also
        // lifts the idle suppression below instead of holding it to the deadline.
        // The clock is load-bearing — it lets the gate discount the echo of a
        // prompt IT just re-pasted (see SELF_CLEARING_RESUBMIT_ECHO_MS).
        if (selfClearingGate.observe(stripped, now)) {
          stopSelfClearingTimers();
          console.log(`✅ TUI run ${runId} provider signal cleared — generating again`);
        }

        const fallbackSignal = detectImmediateFallbackSignal(stripped)
          || detectTerminalModelError(stripped)
          || detectTerminalRequestTimeout(stripped);
        // Branch on the SIGNAL's own grace window, never on gate state: the
        // detector buffers ~512 chars, so a banner keeps matching for many chunks
        // after it has scrolled off. Reading gate state here would let one of
        // those stale matches fall through to an immediate kill the moment the
        // gate closed. A graceful signal can only ever arm a window (or be
        // ignored, when one is already open or the provider already recovered).
        if (fallbackSignal?.graceMs > 0) {
          if (selfClearingGate.arm(fallbackSignal, now)) {
            console.log(`⏳ TUI run ${runId} holding for a self-clearing provider signal (${Math.round(fallbackSignal.graceMs / 1000)}s): ${fallbackSignal.message}`);
            // The wait is ACTIVE — see resubmitAfterSignal. This only ASKS on a
            // sub-multiple of the cadence; the gate decides when an attempt is
            // actually due (SELF_CLEARING_RESUBMIT_POLL_MS). Stopped on recovery
            // above, at expiry below, and by cleanupTimers on any finish.
            selfClearingResubmitTimer = setInterval(resubmitAfterSignal, SELF_CLEARING_RESUBMIT_POLL_MS);
            selfClearingTimer = setTimeout(() => {
              selfClearingTimer = null;
              stopSelfClearingTimers();
              // No clock argument: this timer IS this window's deadline, and it
              // is one-shot — a deadline re-check that came up a millisecond
              // short would strand the gate armed with nothing left to retry it.
              const expired = selfClearingGate.takeExpired();
              if (finalized || !expired) return;
              finishWithFallbackSignal(expired).catch((err) => {
                console.error(`❌ TUI run ${runId} deferred fallback-signal handling failed: ${err?.message || err}`);
              });
            }, fallbackSignal.graceMs);
          }
        } else if (fallbackSignal) {
          // Fire-and-forget like every other finish() call from this PTY
          // callback; finish() itself never rejects and the salvage read can't
          // throw, so the catch is belt-and-braces for a callback boundary.
          finishWithFallbackSignal(fallbackSignal).catch((err) => {
            console.error(`❌ TUI run ${runId} fallback-signal handling failed: ${err?.message || err}`);
          });
          return;
        }
      }

      lastOutputAt = now;
      if (firstOutputAt === null) firstOutputAt = now;
      if (promptSentAt && firstResponseAt === null && now > promptSentAt) {
        firstResponseAt = now;
        // Defer the idle-watch timer until the first response chunk so we
        // don't run a 1Hz no-op throughout the 5-30s spawn + paste window.
        // Significant on parallel fan-out paths (arc planner).
        idleWatchTimer = setInterval(() => {
          if (finalized) return;
          // Idle-completion is the FALLBACK for runs that print their answer
          // inline instead of writing the response file (the authoritative
          // done-signal, handled by responseFileWatchTimer from paste onward).
          // Don't auto-complete a run a human is actively watching in the Shell
          // page — they may be reading the output or about to type a correction
          // or an answer the model is waiting on. The run then ends only on
          // natural process exit or an explicit Stop. Unattended pipeline runs
          // keep the snappy idle threshold for throughput.
          if (isExternalSessionAttached(runId)) return;
          // A run waiting out a provider handshake is silent by design, and the
          // only thing on screen is the banner. Idle-completing here would
          // finalize SUCCESS and scrape that error screen as the answer — the
          // bogus-response failure this file guards against elsewhere. Bounded
          // twice over: the gate closes on the first sign of generation, and its
          // own timer resolves the deadline regardless.
          if (selfClearingGate.armed) return;
          const idle = Date.now() - lastOutputAt;
          if (idle >= idleThresholdMs) {
            if (requiresResponseFileForIdleCompletion) return;
            // NOTE: unlike the long-running agent path, the one-shot runner does
            // NOT gate non-Codex providers on a work-activity signal.
            // Idle-complete is their inline-output fallback when a model prints
            // its answer instead of writing the response file; that output may
            // legitimately carry no `(Ns ·` working counter. Codex is held to
            // the response-file contract above because its quiet reasoning
            // stretches are otherwise indistinguishable from completion.
            finish({ success: true, exitCode: 0, reason: 'idle-complete' });
          }
        }, 1000);
      }

      // Early-fail probe — without this guard a typo'd provider.command
      // would idle until the hard timeout (5 min default).
      if (!promptSentAt && detectMissingTuiBinary(stripped, command)) {
        finish({
          success: false,
          exitCode: 127,
          error: `TUI command not found: ${command}`,
          reason: 'command-not-found'
        });
      }
    });

    const handlePtyExit = ({ exitCode, signal }) => {
      const killed = !!signal;
      // pm2 tree-kills descendants during a PortOS restart, while /runs Stop
      // kills this registered PTY through runner.stopRun. Both are intentional
      // interruptions, not provider failures: never scan the story transcript
      // for a bogus quota marker, bench the provider, or launch a fallback.
      const stopRequested = consumeRunStopRequested(runId);
      const hostInterrupted = killed && isHostShuttingDown();
      const canceled = killed && (stopRequested || hostInterrupted);
      const finalExitCode = typeof exitCode === 'number' ? exitCode : (killed ? 130 : 0);
      const success = !killed && finalExitCode === 0;
      // The terminal-timeout detector holds a candidate banner until a real line
      // terminator proves the line is finished (#3715). Process exit IS that
      // proof — no further byte can turn `⎿ Request timed out` into a
      // `· Retrying …` banner — so flush the held candidate here rather than
      // letting a clean exit 0 scrape the error screen as model output (the
      // exact failure the detector was added for).
      const heldTimeout = success ? detectTerminalRequestTimeout(null, { endOfStream: true }) : null;
      if (heldTimeout) {
        finishWithFallbackSignal(heldTimeout, { processExited: true }).catch((err) => {
          console.error(`❌ TUI run ${runId} exit-time timeout handling failed: ${err?.message || err}`);
        });
        return;
      }
      // Always set an explicit error string when finishing as failure. The
      // toolkit's errorDetection (if enabled) will fill in `error` inside
      // finalizeRunRecord, but if it's absent we'd persist `success: false`
      // with no error and the central handler would reject with a generic
      // "TUI execution failed". Include the exit code + a tail of the
      // captured output so failures are actionable from /runs without
      // re-running.
      let error = null;
      if (hostInterrupted) {
        error = `TUI interrupted by PortOS shutdown (signal ${signal})`;
      } else if (stopRequested) {
        error = `TUI canceled (signal ${signal})`;
      } else if (killed) {
        error = `TUI killed (signal ${signal})`;
      } else if (!success) {
        const tail = outputBuffer.slice(-200).trim();
        error = tail
          ? `TUI exited with code ${finalExitCode}: ${tail}`
          : `TUI exited with code ${finalExitCode}`;
      }
      finish({
        success,
        exitCode: finalExitCode,
        error,
        reason: hostInterrupted ? 'host-shutdown' : (stopRequested ? 'canceled' : (killed ? 'killed' : 'exit')),
        canceled,
      });
    };

    const sendPrompt = (reason) => {
      if (finalized || promptSentAt) return;
      promptSentAt = Date.now();
      // Start capturing stripped post-paste output BEFORE the paste write so the
      // marker watcher sees every response chunk.
      postPasteStripped = '';
      try {
        ptyProcess.write(`\x1b[200~${wrappedPrompt}\x1b[201~`);
      } catch (err) {
        finish({ success: false, exitCode: 1, error: `Failed to write prompt: ${err.message}`, reason: 'write-failed' });
        return;
      }
      console.log(`📟 Pasted prompt into TUI ${command} (${reason})`);

      // Watch for the response file from paste onward — it's the model's
      // authoritative "done" signal and must complete the run INDEPENDENTLY of
      // whether any post-paste PTY output ever arrives. A model that writes the
      // file silently (no streamed output to arm idleWatchTimer) would otherwise
      // hang until the hard-timeout salvage. Runs unconditionally, even while a
      // human watches: once the file exists the task is finished, so there's
      // nothing left to intervene in. (Idle/attach gating lives only on
      // idleWatchTimer, the inline-output fallback.)
      responseFileWatchTimer = setInterval(async () => {
        if (finalized) return;
        if (await responseFileSettled()) {
          finish({ success: true, exitCode: 0, reason: 'response-file' });
        }
      }, 1000);

      const pasteSentAt = Date.now();
      pasteEnterTimer = setInterval(() => {
        if (finalized) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; postPasteStripped = null; return; }
        const elapsed = Date.now() - pasteSentAt;
        const markerSeen = countPasteMarkers(postPasteStripped) > promptMarkerCount;
        if ((markerSeen && elapsed >= PASTE_TO_ENTER_MIN_DELAY_MS)
          || elapsed >= PASTE_TO_ENTER_FALLBACK_MS) {
          clearInterval(pasteEnterTimer);
          pasteEnterTimer = null;
          postPasteStripped = null;
          // Submit with repeated Enters — a single `\r` can be swallowed while
          // the TUI is still reflowing a large paste, stranding the prompt
          // unsent. Tracked in submitEnterTimer so finish()'s cleanupTimers()
          // cancels pending retries if the run ends first.
          submitEnterTimer = scheduleSubmitEnters(
            () => { try { ptyProcess.write(SUBMIT_KEY); } catch { /* PTY may have already exited */ } },
            () => finalized
          );
        }
      }, PASTE_MARKER_POLL_MS);
    };

    const dismissStartupDialog = (keys, dialog) => {
      try {
        ptyProcess.write(keys);
        return true;
      } catch (err) {
        finish({
          success: false,
          exitCode: 1,
          error: `Failed to dismiss ${dialog}: ${err.message}`,
          reason: 'startup-dialog-write-failed',
        }).catch((finishErr) => {
          console.error(`❌ TUI run ${runId} ${dialog} dismissal failed: ${finishErr?.message || finishErr}`);
        });
        return false;
      }
    };

    /**
     * Re-deliver the prompt while a self-clearing provider signal's window is
     * open. Mirrors `resubmitAfterSignal` on the long-running agent path — see
     * that copy (and SELF_CLEARING_RESUBMIT_INTERVAL_MS) for why a passive wait
     * cannot clear agy's eligibility banner: it is the REJECTION of the
     * submission, so the prompt is gone, the composer is empty, and nothing will
     * generate until something re-asks.
     */
    const resubmitAfterSignal = () => {
      // A banner during startup has nothing to re-send — the ready watch below
      // still owns first delivery.
      if (finalized || !promptSentAt) return;
      const attempt = selfClearingGate.takeResubmit(Date.now());
      if (!attempt) return;
      // Overwriting a live handle would leak the previous attempt's Enter
      // interval past cleanupTimers. `pasteToSession` returns false once the PTY
      // has been unregistered, which is also the "don't bother" answer here —
      // the deadline timer still owns the fail-over.
      if (submitEnterTimer) clearInterval(submitEnterTimer);
      const submitted = pasteToSession(runId, wrappedPrompt, {
        label: `[tuiRun ${runId}] provider-handshake resubmit`,
      });
      submitEnterTimer = submitted || null;
      // Only claim the re-submission that actually went out — `false` here means
      // the PTY is already gone, and a log line saying otherwise would send a
      // post-mortem looking for a paste the provider never received.
      if (submitted) {
        console.log(`🔁 TUI run ${runId} re-submitted its prompt while the provider handshake is open (attempt ${attempt})`);
      }
    };

    // Ready watch — known startup dialogs (folder trust, external imports,
    // Codex's hook review) are dismissed for EVERY provider before anything is
    // sent, since each of them swallows a paste. Claude then waits for its
    // positive input-ready signal; other providers retain the idle/deadline
    // fallback for delivery.
    readyTimer = setInterval(() => {
      if (finalized || promptSentAt) {
        clearInterval(readyTimer);
        readyTimer = null;
        return;
      }
      const now = Date.now();
      const elapsed = now - startTime;
      // Both dismissals below rewind the idle clock and clear `firstOutputAt`:
      // the idle path further down reads silence as readiness, and a dialog is
      // quietest right after it paints, so otherwise the keystroke and an idle
      // paste go out inside the same window and the prompt lands in a menu that
      // has not repainted. Requiring fresh output-then-silence after the
      // keystroke makes delivery wait for what the dismissal reveals;
      // PASTE_DEADLINE_MS still backstops a dismissal the TUI ignores entirely.

      // A managed-app worktree nested below PortOS can make Claude discover the
      // parent PortOS CLAUDE.md and offer to import its external AGENTS.md.
      // Decline option 1 rather than crossing that repository boundary. The
      // target checkout's own instructions remain available after option 2.
      if (inputReady.needsExternalImportsChoice) {
        if (dismissStartupDialog('\x1b[B\r', 'external-imports prompt')) {
          inputReady.ackExternalImportsChoice();
        }
        lastOutputAt = now;
        firstOutputAt = null;
        return;
      }

      // Codex's hook-review selector precedes its composer. An unattended run
      // must not grant hooks permission to execute outside the sandbox, so take
      // the explicit "Continue without trusting" option before ordinary
      // readiness/fallback delivery can paste into the selector.
      if (inputReady.needsHookReview && !hookReviewDeclined) {
        hookReviewDeclined = true;
        if (dismissStartupDialog('\x1b[B\x1b[B\r', 'hook-review prompt')) {
          inputReady.ackHookReview();
        }
        lastOutputAt = now;
        firstOutputAt = null;
        return;
      }
      // The first-run folder-trust gate, like the hook-review selector above,
      // must be answered for EVERY provider rather than only the input-ready
      // ones: codex takes the idle/deadline path below, and its trust dialog
      // paints and then goes silent — which that path reads as "ready" and
      // pastes into, losing the prompt and every retry with it (agent-671af38f).
      // Wait for the options to paint before acting. Claude Code versions do
      // not agree on their order: when "No, exit" is highlighted, select the
      // next option before submitting. `trustAccepted` keeps this to one input.
      if (inputReady.needsTrust && inputReady.trustChoiceReady && !trustAccepted) {
        trustAccepted = true;
        const trustInput = `${inputReady.trustSelectionKey}${SUBMIT_KEY}`;
        if (dismissStartupDialog(trustInput, 'folder-trust prompt')) inputReady.ackTrustChoice();
        lastOutputAt = now;
        firstOutputAt = null;
        return;
      }
      if (inputReady.needsTrust && !inputReady.trustChoiceReady) {
        const trustDeadlineMs = requiresInputReady ? TUI_INPUT_READY_DEADLINE_MS : PASTE_DEADLINE_MS;
        if (elapsed >= trustDeadlineMs) {
          clearInterval(readyTimer);
          readyTimer = null;
          finish({
            success: false,
            exitCode: 1,
            error: `${command} presented a folder-trust prompt whose affirmative choice PortOS could not identify, so no prompt was sent.`,
            reason: 'tui-trust-choice-unrecognized',
          });
        }
        return;
      }
      if (requiresInputReady) {
        if (inputReady.needsAutoModeChoice) {
          // Select "No, keep don't ask" so a one-shot run never rewrites the
          // user's global Claude permission default as a startup side effect.
          if (dismissStartupDialog('\x1b[B\r', 'auto-mode prompt')) {
            // The offer paints over an already-live composer, so this re-arms
            // that verified paste-mode signal. Returning still leaves a full
            // ready-poll interval for Ink to redraw before any paste can start.
            inputReady.ackAutoModeChoice();
          }
          return;
        }
        if (inputReady.ready && elapsed >= promptDelayMs) {
          sendPrompt('input-ready');
          return;
        }
        if (elapsed >= TUI_INPUT_READY_DEADLINE_MS) {
          clearInterval(readyTimer);
          readyTimer = null;
          finish({
            success: false,
            exitCode: 1,
            error: `${command} did not present an input prompt within ${Math.round(TUI_INPUT_READY_DEADLINE_MS / 1000)}s, so no prompt was sent.`,
            reason: 'tui-not-ready',
          }).catch((err) => {
            console.error(`❌ TUI run ${runId} input-readiness failure could not finalize: ${err?.message || err}`);
          });
        }
        return;
      }
      if (elapsed >= PASTE_DEADLINE_MS) {
        sendPrompt('fallback');
        return;
      }
      if (elapsed < promptDelayMs) return;
      if (firstOutputAt === null) return;
      if (now - lastOutputAt < READY_IDLE_THRESHOLD_MS) return;
      sendPrompt('ready');
    }, READY_POLL_INTERVAL_MS);

    // (idleWatchTimer is created inside onData once firstResponseAt is set.)

    // Hard timeout — covers stuck-banner, no-response, and runaway-response
    // cases, and is the honest backstop that bounds a run a viewer left open on
    // a backgrounded tab (idle-completion is paused while watched, but this is
    // not — a run can't exceed its configured max time). Provider-configurable
    // via `timeout`; defaults to 5 min.
    hardTimeoutTimer = setTimeout(async () => {
      if (finalized) return;
      // Salvage net: if the model already wrote its response file, the run truly
      // finished — the TUI just never exited — so the timeout is a false failure.
      // Complete as success with the written result instead of discarding it and
      // triggering a pointless fallback retry. (The response-file watcher above
      // normally catches this within ~2s; this covers the boundary case where the
      // file lands right at the deadline or the watcher hadn't confirmed yet.)
      if (await responseFileHasContent()) {
        finish({ success: true, exitCode: 0, reason: 'timeout-response-file' });
        return;
      }
      finish({
        success: false,
        exitCode: 124,
        error: `TUI run timed out after ${totalTimeoutMs}ms`,
        reason: 'timeout'
      });
    }, totalTimeoutMs);

    // The exit bridge was attached immediately after spawn. Hand it the fully
    // initialized lifecycle only after every cleanup-owned timer exists, then
    // replay an exit that arrived during setup. Assign before reading the
    // pending slot so an exit racing this handoff is delivered exactly once.
    dispatchPtyExit = handlePtyExit;
    if (pendingPtyExit) {
      const earlyExit = pendingPtyExit;
      pendingPtyExit = null;
      handlePtyExit(earlyExit);
    }
  });
}

/**
 * Pick the TUI response text — preferring the file the model was directed
 * to write, falling back to the cleaned screen scrape.
 *
 * Returns `{ text, usedResponseFile }`. `usedResponseFile` is true when the
 * file existed and had non-empty trimmed content; false in every other
 * case (file missing, empty, whitespace-only, or run did not succeed).
 *
 * Extracted out of `executeTuiRun.finish` so the file-read + fallback
 * decision is testable without spawning a PTY.
 */
export async function resolveTuiResponseText({ success, responseFilePath, outputBuffer, wrappedPrompt }) {
  if (success) {
    const fileText = await tryReadFile(responseFilePath);
    if (typeof fileText === 'string' && fileText.trim()) {
      return { text: fileText.trim(), usedResponseFile: true };
    }
  }
  return { text: cleanTuiResponse(outputBuffer, wrappedPrompt), usedResponseFile: false };
}

/**
 * Best-effort response cleanup for an already-ANSI-stripped TUI buffer.
 *
 * The TUI buffer is a screen, not a log — it contains banner art, the
 * pasted prompt echoed back, status lines ("thinking...", token counters),
 * box-drawing characters around the input prompt, and the model's response
 * interleaved with all of it. Reliable carve-out would need per-binary
 * scrapers; this helper just drops the obvious bits (paste marker + echoed
 * prompt) and leaves downstream consumers (`extractJson`,
 * `extractCodexAssistant`) to find structured content in the rest.
 *
 * Input is assumed pre-stripped of ANSI codes (the central handler streams
 * each chunk through `createStreamingAnsiStripper` during accumulation, so
 * `outputBuffer` is already clean). Don't strip again — it's a wasted scan
 * over up to `OUTPUT_BUFFER_CAP` bytes of text.
 */
export function cleanTuiResponse(strippedText, prompt) {
  if (typeof strippedText !== 'string' || !strippedText) return '';
  let text = strippedText.replace(/\[Pasted text #\d+[^\]]*\]/g, '');
  // split-join over the prompt is safe because the prompt is fixed text —
  // no regex escaping needed. Guard on length>16 so a degenerate empty/
  // tiny prompt doesn't accidentally erase model output.
  if (typeof prompt === 'string' && prompt.length > 16) {
    text = text.split(prompt).join('');
  }
  return text.trim();
}
