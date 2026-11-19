/**
 * Output pipeline for a headless direct-CLI agent run: stdout/stderr handling, transcript persistence and immediate-fallback detection.
 *
 * Extracted from `spawnDirectly` (agentCliSpawning.js) so the buffers they all
 * share live in one closure with a small surface, instead of ~20 mutable locals
 * inside the spawn function. Owns the display buffer, the 512KB raw stream-json
 * buffer, the ANSI strippers, the stream-json / codex-stderr parsers, the
 * serialized `output.txt` writes, the debounced state batcher and the
 * usage-limit "stop the provider now" detector. It never spawns or finalizes:
 * the caller feeds it `data` chunks and, on `close`, calls `finish()` and reads
 * `snapshot()`.
 */

import { join } from 'path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { isPrivateSecurityTask } from '../../lib/privateSecurityPolicy.js';
import { emitLog } from '../cos/cosEvents.js';
import { updateAgent, createAgentOutputBatcher, appendAgentOutputLines } from '../cos/cosAgentLifecycle.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { writeFileGuarded } from '../../lib/fileUtils.js';
import { createCodexStderrFormatter } from '../../lib/codexCliOutput.js';
import { isKnownCliStderrNoise } from '../../lib/cliStderrNoise.js';
import { createStreamingAnsiStripper } from '../../lib/ansiStrip.js';
import { createImmediateFallbackSignalDetector } from '../../lib/aiToolkit/errorDetection.js';
import { createTranscriptWriteReporter } from '../agentTuiSpawning/outputSpooler.js';
import { createStreamJsonParser } from '../../lib/streamJsonParser.js';

const RAW_STREAM_BUFFER_CAP = 512 * 1024;

/**
 * Serialized transcript persistence shared by every output path: the
 * `output.txt` write chain, the debounced state batcher and the ordered
 * enqueue that keeps interleaved stdout/stderr chunks in arrival order.
 * `readBuffer` returns the display buffer and its revision at call time.
 */
function createTranscriptSink({ agentId, task, outputFile, readBuffer }) {
  let persistedOutputRevision = -1;
  let persistedOutputLength = 0;
  let transcriptFileWriteTail = Promise.resolve();
  let transcriptWriteTail = Promise.resolve();
  const transcriptWriteReporter = createTranscriptWriteReporter({ agentId });

  const persistTranscript = (bytes, revision) => {
    // Serialize timer/manual drains. Only a successful write establishes the
    // prefix that the next snapshot can extend; an append may fail partway.
    const write = transcriptFileWriteTail.then(async () => {
      const append = persistedOutputRevision === revision && persistedOutputLength <= bytes.length;
      const delta = append ? bytes.slice(persistedOutputLength) : bytes;
      if (append && !delta) return;
      await writeFileGuarded(outputFile, delta, { flag: append ? 'a' : 'w' });
      persistedOutputRevision = revision;
      persistedOutputLength = bytes.length;
    }).catch(err => {
      // Rewrite the next snapshot after any failure: retrying an uncertain
      // append could duplicate bytes, while skipping it could lose output.
      persistedOutputRevision = -1;
      maintenance.markResourceUnsettled('agent', agentId);
      return transcriptWriteReporter.report('output.txt', err);
    });
    transcriptFileWriteTail = write;
    return write;
  };

  // Debounced state-write batcher for streamed output. stdout/stderr `data`
  // events fire per chunk (and stream-json yields many lines per chunk), so a
  // per-line/per-chunk appendAgentOutput would round-trip a full state
  // load+save each time. The batcher coalesces a ~250ms window; the close/error
  // handlers `await outputBatcher.flush()` so the final transcript and state
  // lines persist as one admitted batch before the agent is finalized.
  // Findings stay in the local transcript/report, never the shared agent stream.
  const outputBatcher = createAgentOutputBatcher(agentId, { flushBatch: batch => {
    // Capture bytes at the same instant as this batch, before waiting for the
    // cut. Chunks received during I/O belong to the next flush, not this pair.
    const { bytes, revision } = readBuffer();
    return withBackupAssetPublication(() => Promise.all([
      persistTranscript(bytes, revision),
      isPrivateSecurityTask(task) ? undefined : appendAgentOutputLines(agentId, batch)
        .catch(err => transcriptWriteReporter.report('state', err)),
    ]));
  } });

  // Serialize stdout/stderr buffer updates before their shared debounced file
  // and state flush, so interleaved setup awaits cannot reorder the transcript
  // (#2384). Fallback detection stays OUTSIDE this chain — it runs synchronously
  // in the raw listener before the enqueue, so a blocked earlier write can never
  // delay killing the provider on a usage-limit signal. The close/error handlers
  // `await drainWrites()` before finalize so the tail lands first.
  // Mirrors shell.js `hookQueue` and pipeline/issuesShared.js `queueSeriesIssuesWrite`.
  const enqueueTranscriptWrite = (fn) => {
    transcriptWriteTail = transcriptWriteTail.then(fn).catch((err) => {
      // Runs in a child-process callback — a rejection here would escape as an
      // unhandled rejection and crash Node. output.txt is best-effort; log+swallow.
      console.error(`❌ agentCli transcript write failed for ${agentId}: ${err.message}`);
    });
    return transcriptWriteTail;
  };
  const drainWrites = () => transcriptWriteTail;

  /** Drain queued writes, then the batcher and the file tail (error path: nothing more is parsed). */
  const flushOutput = async () => {
    await drainWrites();
    await outputBatcher.flush();
    await transcriptFileWriteTail;
  };

  /** Final persistence: flush pending batches, then rewrite output.txt with the finished buffer. */
  const writeFinalTranscript = (finalBuffer) => withBackupAssetPublication(async () => {
    await outputBatcher.flush();
    await transcriptFileWriteTail;
    await writeFileGuarded(outputFile, finalBuffer).catch((err) => {
      maintenance.markResourceUnsettled('agent', agentId);
      return transcriptWriteReporter.report('output.txt', err);
    });
  });

  return { outputBatcher, enqueueTranscriptWrite, drainWrites, flushOutput, writeFinalTranscript };
}

/**
 * @param {object} params
 * @param {string} params.agentId
 * @param {object} params.task
 * @param {string} [params.runId]
 * @param {object} params.provider
 * @param {object} params.cliConfig - `{ streamFormat }` decides stream-json vs plain stdout
 * @param {string} params.prompt - the codex stderr formatter hides the echoed prompt
 * @param {string} params.agentDir - directory holding `output.txt`
 * @param {() => boolean} params.isProcessStopped - already killed? then a fallback signal is ignored
 * @param {() => void} params.stopProcess - kill the provider process tree on a fallback signal
 */
export function createCliOutputPipeline({ agentId, task, runId, provider, cliConfig, prompt, agentDir, isProcessStopped, stopProcess }) {
  let outputBuffer = '';
  let outputRevision = 0;
  let rawStreamBuffer = ''; // Raw stdout for stream-json (used for error analysis)
  let hasStartedWorking = false;
  // Deliberately NOT `hasStartedWorking`: that flag also flips on a 3s
  // initialization timeout with no output behind it, so reusing it would file a
  // `run.output` for a run that has produced nothing — the exact case (a
  // provider that never spoke) the ledger is supposed to make visible.
  let firstOutputRecorded = false;
  let immediateFallbackAnalysis = null;

  const outputFile = join(agentDir, 'output.txt');
  const isStreamJson = cliConfig.streamFormat === 'stream-json';
  const streamParser = isStreamJson ? createStreamJsonParser() : null;
  const codexStderrFormatter = provider.id === 'codex' ? createCodexStderrFormatter(prompt) : null;
  // A headless CLI still colors its progress output: `opencode run` emits bare
  // `\x1B[0m` resets around its status line. Those bytes reached output.txt and
  // the live tail verbatim, and the browser drops only the ESC itself — so the
  // card rendered `[stderr] [0m` and a working agent was indistinguishable from
  // a wedged one. Strip per stream (each stripper is stateful, buffering an
  // escape split across two `data` chunks) BEFORE the fallback-signal detector,
  // which matches on provider text that color codes would otherwise break up.
  // A stream-json stdout is NDJSON, which escapes an ESC into its six-character
  // JSON form and never carries the raw byte — so the busiest stdout stream in
  // the system skips the scan entirely.
  const stripStdoutAnsi = isStreamJson ? (text) => text : createStreamingAnsiStripper();
  const stripStderrAnsi = createStreamingAnsiStripper();
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();

  /**
   * Record the run's first observed output, once (#4540) — never per chunk. A
   * per-chunk event would make the ledger a copy of the output it deliberately
   * redacts and would exhaust the retention bound in minutes. What the one event
   * buys is time-to-first-output: a run that stalled after speaking and a run
   * that never spoke at all are indistinguishable in the mutable record.
   *
   * Called from BOTH streams. Several providers say everything they have to say
   * on stderr (codex's whole progress feed is stderr), and that output lands in
   * the same transcript — a stdout-only recorder would file those runs as silent.
   * The explicit key keeps the append idempotent however the two callers race.
   */
  const recordFirstOutput = (source, chars) => {
    if (firstOutputRecorded) return;
    firstOutputRecorded = true;
    return appendRunEvent({
      kind: 'run.output',
      runId,
      agentId,
      taskId: task.id,
      eventId: `output:${agentId}:${runId || 'no-run'}:first`,
      data: { source, firstChunkChars: chars },
    });
  };

  const sink = createTranscriptSink({
    agentId, task, outputFile,
    readBuffer: () => ({ bytes: outputBuffer, revision: outputRevision }),
  });
  const { outputBatcher, enqueueTranscriptWrite, drainWrites, flushOutput, writeFinalTranscript } = sink;

  const stopForImmediateFallbackSignal = (text) => {
    if (immediateFallbackAnalysis || isProcessStopped()) return;
    const analysis = detectImmediateFallbackSignal(text);
    if (!analysis) return;
    immediateFallbackAnalysis = analysis;
    emitLog('warn', `Agent ${agentId} detected provider fallback signal (${analysis.category}); stopping ${provider.name || provider.id}`, {
      agentId,
      taskId: task.id,
      providerId: provider.id,
      category: analysis.category
    });
    stopProcess();
  };

  /** Flip initializing -> working once; `message` is the log line for whichever trigger got there first. */
  const markWorking = async (message) => {
    if (hasStartedWorking) return;
    hasStartedWorking = true;
    await updateAgent(agentId, { metadata: { phase: 'working' } });
    emitLog('info', message, { agentId, phase: 'working' });
  };

  const appendLines = (lines) => {
    for (const line of lines) outputBuffer += line + '\n';
    outputBatcher.push(lines);
  };

  const onStdout = (data) => {
    try {
      const raw = data.toString();
      const text = stripStdoutAnsi(raw);
      // Detect fallback signals SYNCHRONOUSLY, before enqueuing any transcript
      // mutation — a blocked earlier write must never delay killing the provider
      // on a usage-limit signal (#2384).
      stopForImmediateFallbackSignal(text);
      // Serialize the transcript body so two `data` events can't interleave their
      // awaits and reorder output.txt / the batched live tail.
      enqueueTranscriptWrite(async () => {
        // Raw length, not stripped: a chunk that was ONLY color codes is still
        // proof the child is alive, and reporting 0 would read as "no output yet".
        await recordFirstOutput('cli-stdout', raw.length);
        await markWorking(`Agent ${agentId} working...`);

        if (streamParser) {
          // Parse stream-json and emit extracted text lines (cap buffer at 512KB for error analysis)
          rawStreamBuffer += text;
          if (rawStreamBuffer.length > RAW_STREAM_BUFFER_CAP) {
            rawStreamBuffer = rawStreamBuffer.slice(-RAW_STREAM_BUFFER_CAP);
          }
          appendLines(streamParser.processChunk(text));
        } else {
          // Non-stream providers: emit stdout as-is once decolored. A chunk that
          // was purely terminal control has nothing left to show. Unlike stderr
          // below, whitespace is NOT dropped here — a blank line is legitimate
          // formatting when it isn't wearing an `[stderr]` tag.
          if (!text) return;
          outputBuffer += text;
          outputBatcher.push(text);
        }
      });
    } catch (err) {
      console.error(`❌ agentCli stdout handler failed: ${err.message}`);
    }
  };

  const onStderr = (data) => {
    try {
      const raw = data.toString();
      const text = stripStderrAnsi(raw);
      // Synchronous fallback detection before the serialized write (see stdout).
      stopForImmediateFallbackSignal(`[stderr] ${text}`);
      enqueueTranscriptWrite(async () => {
        await recordFirstOutput('cli-stderr', raw.length);
        // Codex stderr: show thinking + tool names, skip config dump and command output
        if (codexStderrFormatter) {
          appendLines(codexStderrFormatter.processChunk(text));
          return;
        }
        // A chunk that decolors down to whitespace was pure terminal control
        // (`opencode run` emits a bare reset per progress redraw). Tagging it
        // `[stderr]` would add one blank noise line to the tail per redraw.
        const trimmed = text.trim();
        if (!trimmed || isKnownCliStderrNoise(trimmed)) return;
        outputBuffer += `[stderr] ${text}`;
        outputBatcher.push(`[stderr] ${text}`);
      });
    } catch (err) {
      console.error(`❌ agentCli stderr handler failed: ${err.message}`);
    }
  };

  /**
   * Close-time sequence: drain queued writes (no new `data` events fire after
   * 'close', so one drain is enough), flush the parsers' tails, then persist the
   * final transcript. Runs before any early return so a paused agent's
   * output.txt is complete for the resume modal.
   */
  const finish = async () => {
    await drainWrites();
    if (streamParser) {
      for (const line of streamParser.flush()) {
        outputBuffer += line + '\n';
        outputBatcher.push(line);
      }
      // Use the parsed final result for the output file if available
      const finalResult = streamParser.getFinalResult();
      if (finalResult) {
        outputBuffer = finalResult;
        outputRevision++;
      }
    }
    if (codexStderrFormatter) {
      for (const line of codexStderrFormatter.flush()) {
        outputBuffer += line + '\n';
        outputBatcher.push(line);
      }
    }
    await writeFinalTranscript(outputBuffer);
  };

  return {
    onStdout,
    onStderr,
    markWorking,
    push: (lineOrLines) => outputBatcher.push(lineOrLines),
    flushBatcher: () => outputBatcher.flush(),
    flushOutput,
    finish,
    /** Read-only view; call again after `finish()` for the final values. */
    snapshot: () => ({
      outputBuffer,
      rawStreamBuffer,
      immediateFallbackAnalysis,
      finalSummary: streamParser?.getCompletionResult() ?? null,
    }),
  };
}
