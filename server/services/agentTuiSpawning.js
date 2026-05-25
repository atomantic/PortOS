/**
 * Agent TUI Spawning
 *
 * Runs CoS agents inside an interactive PTY-backed shell session. This is for
 * providers whose useful interface is a terminal UI rather than a headless CLI
 * or HTTP API.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { appendFile, readFile, rm, open, stat as fsStat, writeFile } from 'fs/promises';
import * as shellService from './shell.js';
import { emitLog } from './cosEvents.js';
import { appendAgentOutputLines, updateAgent } from './cosAgents.js';
import { registerSpawnedAgent, unregisterSpawnedAgent } from './agents.js';
import { analyzeAgentFailure } from './agentErrorAnalysis.js';
import { finalizeAgent, releaseAgentLane } from './agentLifecycle.js';
import { activeAgents, userTerminatedAgents } from './agentState.js';
import { PATHS } from '../lib/fileUtils.js';
import { resolveCliModel } from '../lib/providerModels.js';
import { createStreamingAnsiStripper } from '../lib/ansiStrip.js';
import {
  DEFAULT_TUI_PROMPT_DELAY_MS,
  DEFAULT_TUI_IDLE_TIMEOUT_MS,
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  PASTE_MARKER_POLL_MS,
  PASTE_MARKER_PATTERN,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  PASTE_DEADLINE_MS,
  OUTPUT_BUFFER_CAP,
  OUTPUT_BUFFER_HEADROOM,
  RAW_SPOOL_MAX_BYTES,
  inferTuiCommand,
  applyCommandDefaults,
} from '../lib/tuiHandshake.js';

// Agent-specific timing/lifecycle constants (not shared with the one-shot
// runner — agents stay alive much longer and write a sentinel file when done).
const DEFAULT_TUI_MIN_RUNTIME_MS = 15000;
// Tail-read window for raw.txt at failure analysis. analyzeAgentFailure only
// inspects the last ~200 lines, so reading the whole file (which has no upper
// bound for long-running agents) would reintroduce the OOM risk the disk
// spool was meant to avoid. 1MB easily contains the last 200 lines of any
// realistic PTY stream while keeping peak finalize memory bounded.
const RAW_TAIL_ANALYSIS_BYTES = 1024 * 1024;

// RAW_SPOOL_MAX_BYTES lives in tuiHandshake.js so the test suite can shrink
// the cap via the same vi.mock pattern that overrides the output-buffer
// thresholds — saves the truncation test from having to push hundreds of MB
// through the spawner. A misbehaving (or compromised) TUI agent could in
// principle emit MB/sec forever and fill the volume; realistic agents idle
// out at 180s and emit <10MB total. At this threshold the spool is truncated
// (rewritten with the current batch) so the most-recent data remains, which
// is what readFileTail at finalize needs anyway. Warn fires once per agent
// run; the `rawSpoolTruncated` metadata flag persists in the agent record
// so the operator can spot the affected runs after the fact.

/**
 * Read at most `maxBytes` from the end of a file. Returns null when the file
 * doesn't exist or can't be opened; an empty string for a zero-byte file.
 * Used to bound the memory footprint of failure-analysis reads against the
 * uncapped raw PTY spool. Non-throwing — any failure surfaces as null so
 * the caller's failure-analysis path can fall back to outputBuffer instead
 * of aborting `finish()` before finalizeAgent runs.
 */
async function readFileTail(path, maxBytes) {
  const st = await fsStat(path).catch(() => null);
  if (!st) return null;
  if (st.size === 0) return '';
  const start = Math.max(0, st.size - maxBytes);
  const length = st.size - start;
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(length);
    // Honour bytesRead — the file can shrink between stat and read, or the
    // OS can return a short read; decoding the whole `buf` would otherwise
    // append NULs to the returned string. Read failures surface as null so
    // callers can distinguish "empty file" ('') from "read error" (null) —
    // a `bytesRead: 0` fallback would conflate the two.
    const readResult = await fh.read(buf, 0, length, start).catch(() => null);
    if (readResult === null) return null;
    return buf.toString('utf8', 0, readResult.bytesRead);
  } finally {
    await fh.close().catch(() => {});
  }
}
// Debounce window for batching parsed output to disk + state. A chatty TUI can
// emit hundreds of lines/sec; without batching, each line triggers a full
// state load+save (see appendAgentOutput) and a small appendFile, which slows
// the PTY event loop and thrashes the filesystem. 250ms is invisible to the
// live tail but cuts I/O by 1-2 orders of magnitude.
const OUTPUT_FLUSH_INTERVAL_MS = 250;
// Sentinel-file polling. TUI agents write `.agent-done` in their workspace
// when they've finished /simplify + /do:pr (or /do:push) — we poll for it
// here so the agent gets cleanly finalized as soon as the work is done,
// without waiting on the much longer idle timeout fallback.
const DONE_SENTINEL_NAME = '.agent-done';
const DONE_POLL_INTERVAL_MS = 2000;

function shellQuote(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

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
export function createAgentTuiSession({ agentId, provider, tuiConfig, cwd, onData, onExit }) {
  const sessionId = shellService.createShellSession(null, {
    cwd,
    kind: 'agent-tui',
    agentId,
    label: `${provider.name} ${agentId}`,
    command: tuiConfig.commandLine,
    initialCommand: tuiConfig.commandLine,
    env: provider.envVars || {},
    onData,
    onExit,
  });

  if (!sessionId) {
    return { sessionId: null, ptyProcess: null, pid: null };
  }

  const ptyProcess = shellService.getSessionProcess(sessionId);
  return { sessionId, ptyProcess, pid: ptyProcess?.pid || null };
}

function appendModelArgs(args, model) {
  const effectiveModel = resolveCliModel(model);
  return effectiveModel ? [...args, '--model', effectiveModel] : args;
}

export function buildTuiSpawnConfig(provider, model) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])]);
  const args = appendModelArgs(baseArgs, model);

  return {
    command,
    args,
    commandLine: [command, ...args].map(shellQuote).join(' '),
    promptDelayMs: provider?.tuiPromptDelayMs || DEFAULT_TUI_PROMPT_DELAY_MS,
    idleTimeoutMs: provider?.tuiIdleTimeoutMs || DEFAULT_TUI_IDLE_TIMEOUT_MS
  };
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
  // the sentinel watcher below). Computed up front so both the watcher AND
  // finish() can read it — finish() ingests it directly to survive the
  // /quit-exit-vs-poll race (see ingestDoneSentinel).
  const doneSentinelPath = workspacePath ? join(workspacePath, DONE_SENTINEL_NAME) : null;
  const promptPreview = prompt.replace(/\s+/g, ' ').slice(0, 100);
  const commandName = tuiConfig.command.split('/').pop();

  let outputBuffer = '';
  let finalized = false;
  // Guards ingestDoneSentinel to a single read. finish() is its only caller and
  // is itself guarded by `finalized`, so this is defensive — it pins the
  // read-at-most-once invariant at the helper.
  let sentinelIngested = false;
  let hasStartedWorking = false;
  let promptSentAt = null;
  let firstOutputAt = null;
  let lastOutputAt = Date.now();
  let lastLine = '';
  let sessionId = null;
  // True once outputBuffer crossed its HEADROOM and the head was dropped.
  // Mirrors `outputBufferTruncated` in `tuiPromptRunner.js`: warn once per
  // buffer and surface via agent metadata so the agent record distinguishes
  // a long-run-with-overflow from a clean short run.
  let outputBufferTruncated = false;

  // Bounded post-paste accumulator. Lives only while pasteEnterTimer is
  // running (a few seconds at most), so the in-memory cost is bounded by
  // however much the TUI emits during the paste-marker window — typically
  // a few KB. Set to '' when sendPrompt fires; nulled when paste detection
  // resolves or the agent finalizes.
  let postPasteBuffer = null;

  let pendingLines = [];
  let flushTimer = null;
  let flushing = null;
  let pendingRawChunks = [];
  let rawFlushTimer = null;
  let rawFlushing = null;
  let rawBytesWritten = 0;
  let rawSpoolTruncationWarned = false;
  let pasteEnterTimer = null;

  const streamingStrip = createStreamingAnsiStripper();

  const flushPendingLines = async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pendingLines.length === 0) return;
    const batch = pendingLines;
    pendingLines = [];
    await Promise.all([
      appendAgentOutputLines(agentId, batch).catch(() => {}),
      appendFile(outputFile, batch.map(l => `${l}\n`).join('')).catch(() => {})
    ]);
  };

  const scheduleFlush = () => {
    if (flushTimer || flushing) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushing = flushPendingLines().finally(() => {
        flushing = null;
        // Catch chunks that arrived during the in-flight flush — without
        // this, a producer that goes quiet right after the flush starts
        // strands its last batch in pendingLines until finalize.
        if (pendingLines.length > 0) scheduleFlush();
      });
    }, OUTPUT_FLUSH_INTERVAL_MS);
  };

  // Raw PTY flush pipeline. Parallel to flushPendingLines but appends the
  // unprocessed chunks (no ANSI strip, no line semantics) to raw.txt.
  // shellService surfaces node-pty output as already-decoded UTF-8 strings
  // (node-pty's internal StringDecoder handles multi-byte boundaries before
  // we see chunks), so queueing strings here is sufficient — no Buffer
  // bookkeeping needed. pendingRawChunks holds whatever arrives during the
  // 250ms debounce window AND while an appendFile is in-flight (the next
  // scheduleRawFlush is gated by rawFlushing); join() runs once per flush
  // tick, so peak in-memory raw data is bounded by one debounce-plus-IO
  // window of TUI output (typically hundreds of KB on a chatty agent).
  const flushPendingRawChunks = async () => {
    if (rawFlushTimer) { clearTimeout(rawFlushTimer); rawFlushTimer = null; }
    if (pendingRawChunks.length === 0) return;
    const batch = pendingRawChunks.join('');
    pendingRawChunks = [];
    // Count UTF-8 bytes actually written to disk, NOT the UTF-16 code-unit
    // length of the JS string — non-ASCII output would otherwise under-
    // report and let the spool exceed the safety cap.
    const batchBytes = Buffer.byteLength(batch, 'utf8');
    if (rawBytesWritten + batchBytes > RAW_SPOOL_MAX_BYTES) {
      // Safety valve: rewrite the file with just this batch instead of
      // appending. The tail-read at finalize wants the MOST RECENT bytes,
      // not the oldest, so truncating preserves what analyzeAgentFailure
      // actually uses while bounding disk usage at ~RAW_SPOOL_MAX_BYTES.
      // If a single debounce-window batch exceeds the cap (runaway producer
      // emitting MB/sec), slice to the trailing RAW_SPOOL_MAX_BYTES bytes
      // first — Buffer-slice to keep UTF-8 byte semantics correct (a
      // string.slice would index by UTF-16 code units and produce torn
      // multi-byte sequences at the boundary).
      let writeBuf;
      if (batchBytes > RAW_SPOOL_MAX_BYTES) {
        const buf = Buffer.from(batch, 'utf8');
        writeBuf = buf.subarray(buf.length - RAW_SPOOL_MAX_BYTES);
      } else {
        writeBuf = batch;
      }
      const writeBytes = typeof writeBuf === 'string' ? batchBytes : writeBuf.length;
      if (!rawSpoolTruncationWarned) {
        rawSpoolTruncationWarned = true;
        console.warn(`⚠️ TUI agent ${agentId} raw PTY spool reached ${Math.round(RAW_SPOOL_MAX_BYTES / 1024 / 1024)}MB — truncating spool (oldest bytes dropped; tail-read still reflects most recent)`);
        updateAgent(agentId, { metadata: { rawSpoolTruncated: true } })
          .catch(err => console.error(`❌ TUI agent ${agentId} rawSpoolTruncated metadata write failed: ${err.message}`));
      }
      // Only update the byte counter on successful write — a failed write
      // would otherwise inflate rawBytesWritten and make subsequent flush
      // decisions race the actual on-disk state.
      const wrote = await writeFile(rawFile, writeBuf).then(() => true).catch(() => false);
      if (wrote) rawBytesWritten = writeBytes;
      return;
    }
    const wrote = await appendFile(rawFile, batch).then(() => true).catch(() => false);
    if (wrote) rawBytesWritten += batchBytes;
  };

  const scheduleRawFlush = () => {
    if (rawFlushTimer || rawFlushing) return;
    rawFlushTimer = setTimeout(() => {
      rawFlushTimer = null;
      rawFlushing = flushPendingRawChunks().finally(() => {
        rawFlushing = null;
        // Same re-schedule guard as scheduleFlush: chunks that arrived
        // during the in-flight appendFile would otherwise sit until
        // finalize if the producer goes quiet immediately after.
        if (pendingRawChunks.length > 0) scheduleRawFlush();
      });
    }, OUTPUT_FLUSH_INTERVAL_MS);
  };

  // TUI agents only emit a handful of internal status lines (session-started,
  // prompt-pasted, completion) — see handleData for why per-line capture of
  // the PTY stream itself is intentionally dropped.
  const appendLine = (line) => {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine === lastLine) return;

    lastLine = cleanLine;
    outputBuffer += `${cleanLine}\n`;
    if (outputBuffer.length > OUTPUT_BUFFER_HEADROOM) {
      outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_CAP);
      if (!outputBufferTruncated) {
        outputBufferTruncated = true;
        console.warn(`⚠️ TUI agent ${agentId} parsed-output buffer exceeded ${Math.round(OUTPUT_BUFFER_HEADROOM / 1024 / 1024)}MB — head dropped (output.txt is the authoritative on-disk record)`);
        updateAgent(agentId, { metadata: { outputBufferTruncated: true } })
          .catch(err => console.error(`❌ TUI agent ${agentId} outputBufferTruncated metadata write failed: ${err.message}`));
      }
    }
    pendingLines.push(cleanLine);
    scheduleFlush();
  };

  // Read the `.agent-done` sentinel (if present) and append its markdown task
  // summary line-by-line into the agent's output so downstream consumers
  // (extractFinalSummary, persistSimplifySummaries, completion hooks, the agent
  // card, output.txt) get the resolution. Called only from finish() (the single
  // finalize chokepoint); idempotent via `sentinelIngested` so it reads at most
  // once. Capped at 4 KB so an agent that pasted the whole diff into the
  // sentinel can't blow up the record.
  const ingestDoneSentinel = async () => {
    if (sentinelIngested) return;
    if (!doneSentinelPath || !existsSync(doneSentinelPath)) return;
    sentinelIngested = true;
    const contents = await readFile(doneSentinelPath, 'utf8').catch(err => {
      console.error(`❌ ingestDoneSentinel readFile failed: ${err.message}`);
      return '';
    });
    const trimmed = contents.trim();
    if (!trimmed) return;
    appendLine(`✅ Agent signaled completion`);
    const truncated = trimmed.length > 4096 ? `${trimmed.slice(0, 4096)}\n…[truncated]` : trimmed;
    for (const line of truncated.split('\n')) appendLine(line);
  };

  const finish = async ({ success, exitCode = 0, error = null, reason = 'completed' }) => {
    if (finalized) return;
    finalized = true;

    const agentData = activeAgents.get(agentId);
    if (agentData?.idleTimer) clearInterval(agentData.idleTimer);
    if (agentData?.promptTimer) clearInterval(agentData.promptTimer);
    if (agentData?.doneSentinelTimer) clearInterval(agentData.doneSentinelTimer);
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    // Release the post-paste accumulator even when finalize fires mid-paste-
    // window. The pasteEnterTimer's own cleanup path nulls this too, but if
    // finalize comes from elsewhere (shell-exit, command-not-found, user
    // termination) the timer never gets a chance to run.
    postPasteBuffer = null;

    // Ingest the .agent-done sentinel BEFORE draining, so its markdown summary
    // lands in outputBuffer/output.txt regardless of WHICH path finalized the
    // agent. The completion workflow writes the sentinel and then runs /quit —
    // the process exits within milliseconds, so handleExit almost always wins
    // the race against the 2s doneSentinelTimer poll. Reading it here (not just
    // in the poll) is what makes the resolution show up in the completed-agent
    // details view. Idempotent via `sentinelIngested`.
    await ingestDoneSentinel();

    // Drain pending parsed lines AND raw chunks before the final state
    // writes so completion events don't beat the last output batch to disk.
    if (flushing) await flushing.catch(() => {});
    await flushPendingLines();
    if (rawFlushing) await rawFlushing.catch(() => {});
    await flushPendingRawChunks();

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

    // output.txt has already been incrementally appended via flushPendingLines;
    // do NOT writeFile() it from outputBuffer at finalize — outputBuffer is
    // capped at OUTPUT_BUFFER_CAP and would silently truncate the on-disk
    // record for long runs. The append-only stream is the authoritative copy.
    //
    // For failure analysis: read only the tail of the raw PTY spool — the
    // analyzer's window is the last ~200 lines, so reading the full file
    // (potentially many MB on long agents) would defeat the disk-spool's
    // memory-bound guarantee. Successful runs skip the read entirely.
    // raw.txt stays in agentDir alongside output.txt as the persistent
    // record of the agent's full PTY transcript.
    const rawAnalysisText = finalSuccess
      ? null
      : await readFileTail(rawFile, RAW_TAIL_ANALYSIS_BYTES);
    // `??` (not `||`) so an empty raw spool ('') stays distinguishable from
    // a read failure (null) — readFileTail's contract. A zero-byte raw.txt
    // (file was created but the PTY never emitted) lets failure analysis
    // run against ''; both a missing file AND a read error return null and
    // fall back to outputBuffer (which has the spawn-startup notices).
    const errorAnalysis = finalSuccess
      ? null
      : analyzeAgentFailure(rawAnalysisText ?? outputBuffer, task, model);

    // try/finally so a throw from finalizeAgent (e.g. processAgentCompletion
    // hook crash) still runs the local cleanup — sentinel removal, worktree
    // cleanup, pid unregister, activeAgents delete, session kill. Without
    // this, a memory-extraction crash would strand the worktree and the
    // shell session on disk.
    try {
      await finalizeAgent({
        agentId,
        task,
        runId,
        providerId: provider?.id,
        success: finalSuccess,
        exitCode,
        duration,
        outputBuffer,
        errorAnalysis,
        terminatedByUser,
        isTruthyMetaFn,
        error: finalError || undefined,
        completionReason: reason,
      });
    } finally {
      if (workspacePath) await rm(join(workspacePath, DONE_SENTINEL_NAME)).catch(() => {});

      // TUI agents run /do:pr (or /do:push) themselves before signaling via
      // .agent-done, so the system-side cleanup must NOT also push or open a
      // PR — that would double-fire. `skipMerge` is forced on so the
      // post-exit auto-merge doesn't trip over a branch the agent already
      // pushed. The worktree directory itself is still cleaned up.
      await cleanupWorktreeFn(agentId, finalSuccess, {
        openPR: false,
        requestCopilotReview: false,
        skipMerge: true,
        description: task.description,
        agentOutput: outputBuffer,
        originalTask: task
      }).catch(err => emitLog('warn', `TUI worktree cleanup failed for ${agentId}: ${err.message}`, { agentId }));

      if (agentData?.pid) unregisterSpawnedAgent(agentData.pid);
      activeAgents.delete(agentId);
      if (sessionId && shellService.getSession(sessionId)) shellService.killSession(sessionId);
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
      pendingRawChunks.push(text);
      scheduleRawFlush();
      if (postPasteBuffer !== null) postPasteBuffer += text;
      lastOutputAt = Date.now();
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
      if (!promptSentAt) {
        const lowerStripped = streamingStrip(text).toLowerCase();
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

  const handleExit = async ({ exitCode, killed }) => {
    if (finalized) return;
    const code = typeof exitCode === 'number' ? exitCode : killed ? 130 : 0;
    await finish({
      success: code === 0 && !killed,
      exitCode: code,
      error: killed ? 'TUI shell session was killed' : null,
      reason: killed ? 'shell-killed' : 'shell-exit'
    });
  };

  const session = createAgentTuiSession({
    agentId,
    provider,
    tuiConfig,
    cwd,
    onData: handleData,
    onExit: handleExit,
  });
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
  const sendPrompt = (reason) => {
    if (finalized || promptSentAt) return;
    promptSentAt = Date.now();
    // Start capturing post-paste output. Set BEFORE writing the paste so
    // every chunk that arrives in response gets appended. Cleared the moment
    // detection resolves (marker seen or fallback elapsed) so the accumulator
    // never lives beyond the paste-marker window.
    postPasteBuffer = '';
    shellService.writeToSession(sessionId, `\x1b[200~${prompt}\x1b[201~`);
    appendLine(`📟 Prompt pasted into TUI session ${sessionId.slice(0, 8)} (${reason})`);

    const submitEnter = () => {
      if (finalized) return;
      shellService.writeToSession(sessionId, '\r');
    };

    const pasteSentAt = Date.now();
    pasteEnterTimer = setInterval(() => {
      if (finalized) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        postPasteBuffer = null;
        return;
      }
      const elapsed = Date.now() - pasteSentAt;
      const markerSeen = postPasteBuffer
        ? PASTE_MARKER_PATTERN.test(postPasteBuffer)
        : false;
      // Submit when EITHER the paste-commit marker appears (preferred) or
      // the fallback window elapses (covers small prompts that don't render
      // the marker).
      if ((markerSeen && elapsed >= PASTE_TO_ENTER_MIN_DELAY_MS)
        || elapsed >= PASTE_TO_ENTER_FALLBACK_MS) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        postPasteBuffer = null;
        submitEnter();
      }
    }, PASTE_MARKER_POLL_MS);
  };

  const promptTimer = setInterval(() => {
    if (finalized || promptSentAt) {
      clearInterval(promptTimer);
      return;
    }
    const now = Date.now();
    const elapsed = now - startedAt;
    if (elapsed >= PASTE_DEADLINE_MS) {
      sendPrompt('fallback');
      clearInterval(promptTimer);
      return;
    }
    if (elapsed < tuiConfig.promptDelayMs) return;
    if (firstOutputAt === null) return;
    if (now - lastOutputAt < READY_IDLE_THRESHOLD_MS) return;
    sendPrompt('ready');
    clearInterval(promptTimer);
  }, READY_POLL_INTERVAL_MS);

  const idleTimer = setInterval(() => {
    if (!promptSentAt || finalized) return;
    const runtime = Date.now() - promptSentAt;
    const idle = Date.now() - lastOutputAt;
    if (runtime < DEFAULT_TUI_MIN_RUNTIME_MS) return;
    // We track post-paste activity via lastOutputAt instead of parsed-line
    // counts because per-line PTY capture is intentionally disabled for TUI
    // agents — see handleData.
    if (lastOutputAt <= promptSentAt) return;
    if (idle >= tuiConfig.idleTimeoutMs) {
      finish({ success: true, exitCode: 0, reason: 'idle-complete' }).catch(err => {
        emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
      });
    }
  }, 5000);

  // Sentinel-file watcher. The agent's prompt instructs it to write
  // .agent-done in the workspace after running /simplify + /do:pr. This poll
  // exists only to finalize PROMPTLY when the agent signals done WITHOUT
  // exiting its TUI (e.g. it forgot /quit, or stays alive) — otherwise we'd
  // wait out the much longer idle timeout. The actual sentinel READ happens in
  // finish() (via ingestDoneSentinel) so the resolution is captured no matter
  // which path finalizes: the far more common case is the agent writing the
  // sentinel and then running /quit, whose process exit fires finish() long
  // before this 2s poll ticks. Idle-complete is the fallback for a
  // non-complying agent.
  const doneSentinelTimer = doneSentinelPath ? setInterval(() => {
    try {
      if (finalized) return;
      if (!existsSync(doneSentinelPath)) return;
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
      executionMode: 'tui',
      tuiSessionId: sessionId,
      tuiCommand: tuiConfig.commandLine,
      tuiKind,
      tuiIdleTimeoutMs: tuiConfig.idleTimeoutMs
    }
  });

  appendLine(`📟 TUI session started: ${sessionId.slice(0, 8)} (${tuiConfig.commandLine})`);
  appendLine(`💡 Open the Shell tab for live TUI output — this panel only logs lifecycle events.`);
  return agentId;
}
