/**
 * One-shot TUI prompt runner.
 *
 * Spawns a TUI binary (Claude Code, Codex, Gemini, etc.) in a PTY, waits for
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
 *   - shellService caps total sessions at 5, which the central handler can
 *     exceed easily (arc planner fans out parallel calls).
 *   - shellService wraps a login shell around the TUI; pasting `${cmd}\n`
 *     into a zsh prompt is slower and noisier than spawning the TUI directly.
 *
 * Completion detection is intentionally minimal: idle-after-response, with a
 * hard timeout fallback. Per-binary input-prompt regexes were considered but
 * are fragile across versions and screen sizes; the idle threshold (~8s)
 * works universally and matches how a human knows the TUI finished — output
 * stopped scrolling.
 */

import { spawn as ptySpawn } from 'node-pty';

import { join, resolve } from 'path';
import { ensureDir, PATHS, tryReadFile } from './fileUtils.js';
import { createStreamingAnsiStripper } from './ansiStrip.js';
import { getRunsPath, finalizeRunRecord, emitRunStarted, registerActiveRun, unregisterActiveRun } from '../services/runner.js';
import {
  DEFAULT_TUI_PROMPT_DELAY_MS,
  PASTE_MARKER_POLL_MS,
  PASTE_MARKER_PATTERN,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  PASTE_DEADLINE_MS,
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  OUTPUT_BUFFER_CAP,
  OUTPUT_BUFFER_HEADROOM,
  RAW_BUFFER_CAP,
  RAW_BUFFER_HEADROOM,
  buildTuiInvocation,
  detectMissingTuiBinary,
} from './tuiHandshake.js';

// One-shot defaults that don't apply to the long-running agent path:
//   - hard run cap (5 min vs unbounded for agents)
//   - response-complete idle threshold (8s vs 180s for agents — agents wait
//     out tool calls + /simplify + /do:pr, we're just waiting for the model
//     to stop talking)
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_ONE_SHOT_IDLE_MS = 8000;

// Wide PTY so TUI doesn't wrap responses at narrow widths, which makes
// downstream parsing harder.
const PTY_COLS = 200;
const PTY_ROWS = 50;

/**
 * Run a single prompt through a TUI provider. Mirrors the signature of
 * `executeCliRun` / `executeApiRun` so the central handler treats all three
 * branches uniformly (positional, NOT an options object).
 *
 * Caller (typically `runPromptThroughProvider`) owns the run record:
 *   - `createRun` (toolkit) writes the initial metadata.json + prompt.txt
 *   - this function writes output.txt and finalizes metadata.json on exit
 *     via `runner.js#finalizeRunRecord`, so /runs shows TUI runs with the
 *     same success/exitCode/duration shape as CLI runs.
 *
 * @param {string} runId — pre-created run id (from createRun).
 * @param {object} provider — { id, type: 'tui', command, args, envVars,
 *   tuiPromptDelayMs?, tuiOneShotIdleMs?, timeout?, defaultModel? }. The
 *   model passed to `--model` is taken from `provider.defaultModel`; per-
 *   call overrides are applied by the central handler via a provider clone
 *   before this function is reached.
 * @param {string} prompt — full text to paste into the TUI.
 * @param {string} cwd — working directory for the spawned TUI.
 * @param {(chunk: string) => void} [onData] — incremental ANSI-stripped
 *   output stream.
 * @param {(meta: object) => void} [onComplete] — fired after exit with
 *   `{ exitCode, duration, success, error?, model? }`. Promise resolves
 *   AFTER this fires.
 * @param {number} [timeout] — hard cap on a single run (ms). Falls back to
 *   `provider.timeout`, then `DEFAULT_TIMEOUT_MS`.
 * @returns {Promise<void>}
 */
export async function executeTuiRun(runId, provider, prompt, cwd, onData, onComplete, timeout) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('executeTuiRun: provider is required');
  }
  if (typeof prompt !== 'string' || !prompt) {
    throw new Error('executeTuiRun: prompt must be a non-empty string');
  }

  const { command, args } = buildTuiInvocation(provider, provider.defaultModel);
  const promptDelayMs = provider.tuiPromptDelayMs ?? DEFAULT_TUI_PROMPT_DELAY_MS;
  const idleThresholdMs = provider.tuiOneShotIdleMs ?? DEFAULT_ONE_SHOT_IDLE_MS;
  const totalTimeoutMs = timeout ?? provider.timeout ?? DEFAULT_TIMEOUT_MS;
  const workingDir = (typeof cwd === 'string' && cwd) ? cwd : PATHS.root;

  // Mirror runner.js#executeCliRun's runs-path resolution so TUI runs land
  // under the runner-config dataDir (not always PATHS.runs) — otherwise a
  // non-default dataDir would split metadata + output across two trees.
  const runDir = join(getRunsPath(), runId);
  await ensureDir(runDir);

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

  // CLAUDECODE is set when PortOS itself runs inside Claude Code; passing it
  // through to a spawned Claude Code TUI would make the child think it's
  // nested. Other AI spawn paths (runner.js, agentCliSpawning.js) strip it
  // for the same reason.
  const childEnv = { ...process.env, ...(provider.envVars || {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete childEnv.CLAUDECODE;

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

  const startTime = Date.now();
  let outputBuffer = '';
  let rawBuffer = '';
  let promptSentAt = null;
  let firstOutputAt = null;
  let lastOutputAt = startTime;
  let firstResponseAt = null;
  let finalized = false;

  const streamingStrip = createStreamingAnsiStripper();
  let readyTimer = null;
  let pasteEnterTimer = null;
  let idleWatchTimer = null;
  let hardTimeoutTimer = null;

  const cleanupTimers = () => {
    if (readyTimer) { clearInterval(readyTimer); readyTimer = null; }
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    if (idleWatchTimer) { clearInterval(idleWatchTimer); idleWatchTimer = null; }
    if (hardTimeoutTimer) { clearTimeout(hardTimeoutTimer); hardTimeoutTimer = null; }
  };

  return new Promise((resolve) => {
    const finish = async ({ success, exitCode = 0, error = null, reason = 'completed' }) => {
      if (finalized) return;
      finalized = true;
      cleanupTimers();
      unregisterActiveRun(runId);

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
        extras: { completionReason: reason, usedResponseFile },
      }).catch((err) => {
        console.error(`❌ TUI run ${runId} finalize failed: ${err.message}`);
        return {
          exitCode, success, error: error || err.message,
          duration: Date.now() - startTime, completionReason: reason,
        };
      });
      onComplete?.({ ...metadata, text: responseText, usedResponseFile });
      resolve();
    };

    ptyProcess.onData((data) => {
      const text = data.toString();
      rawBuffer += text;
      if (rawBuffer.length > RAW_BUFFER_HEADROOM) rawBuffer = rawBuffer.slice(-RAW_BUFFER_CAP);

      const stripped = streamingStrip(text);
      if (stripped) {
        outputBuffer += stripped;
        if (outputBuffer.length > OUTPUT_BUFFER_HEADROOM) {
          outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_CAP);
        }
        onData?.(stripped);
      }

      const now = Date.now();
      lastOutputAt = now;
      if (firstOutputAt === null) firstOutputAt = now;
      if (promptSentAt && firstResponseAt === null && now > promptSentAt) {
        firstResponseAt = now;
        // Defer the idle-watch timer until the first response chunk so we
        // don't run a 1Hz no-op throughout the 5-30s spawn + paste window.
        // Significant on parallel fan-out paths (arc planner).
        idleWatchTimer = setInterval(() => {
          if (finalized) return;
          const idle = Date.now() - lastOutputAt;
          if (idle >= idleThresholdMs) {
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

    ptyProcess.onExit(({ exitCode, signal }) => {
      const killed = !!signal;
      const finalExitCode = typeof exitCode === 'number' ? exitCode : (killed ? 130 : 0);
      const success = !killed && finalExitCode === 0;
      // Always set an explicit error string when finishing as failure. The
      // toolkit's errorDetection (if enabled) will fill in `error` inside
      // finalizeRunRecord, but if it's absent we'd persist `success: false`
      // with no error and the central handler would reject with a generic
      // "TUI execution failed". Include the exit code + a tail of the
      // captured output so failures are actionable from /runs without
      // re-running.
      let error = null;
      if (killed) {
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
        reason: killed ? 'killed' : 'exit'
      });
    });

    const sendPrompt = (reason) => {
      if (finalized || promptSentAt) return;
      promptSentAt = Date.now();
      const rawLenBeforePaste = rawBuffer.length;
      try {
        ptyProcess.write(`\x1b[200~${wrappedPrompt}\x1b[201~`);
      } catch (err) {
        finish({ success: false, exitCode: 1, error: `Failed to write prompt: ${err.message}`, reason: 'write-failed' });
        return;
      }
      console.log(`📟 Pasted prompt into TUI ${command} (${reason})`);

      const pasteSentAt = Date.now();
      pasteEnterTimer = setInterval(() => {
        if (finalized) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; return; }
        const elapsed = Date.now() - pasteSentAt;
        const postPaste = rawBuffer.slice(rawLenBeforePaste);
        const markerSeen = PASTE_MARKER_PATTERN.test(postPaste);
        if ((markerSeen && elapsed >= PASTE_TO_ENTER_MIN_DELAY_MS)
          || elapsed >= PASTE_TO_ENTER_FALLBACK_MS) {
          clearInterval(pasteEnterTimer);
          pasteEnterTimer = null;
          try { ptyProcess.write('\r'); } catch { /* PTY may have already exited */ }
        }
      }, PASTE_MARKER_POLL_MS);
    };

    // Ready watch — paste only once the TUI banner finishes repainting AND
    // we've had at least promptDelayMs of runtime. Falls back to forcing
    // the paste after PASTE_DEADLINE_MS so a silent provider still gets
    // the prompt.
    readyTimer = setInterval(() => {
      if (finalized || promptSentAt) {
        clearInterval(readyTimer);
        readyTimer = null;
        return;
      }
      const now = Date.now();
      const elapsed = now - startTime;
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
    // cases. Provider-configurable via `timeout`; defaults to 5 min.
    hardTimeoutTimer = setTimeout(() => {
      if (finalized) return;
      finish({
        success: false,
        exitCode: 124,
        error: `TUI run timed out after ${totalTimeoutMs}ms`,
        reason: 'timeout'
      });
    }, totalTimeoutMs);
  });
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
 * over up to 1MB of text.
 */
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
