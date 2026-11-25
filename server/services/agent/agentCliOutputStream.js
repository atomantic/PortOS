/**
 * Output pipeline for a headless direct-CLI agent run: stdout/stderr handling, transcript persistence and immediate-fallback detection.
 *
 * Extracted from `spawnDirectly` (agentCliSpawning.js) so the buffers they all
 * share live in one closure with a small surface, instead of ~20 mutable locals
 * inside the spawn function. Owns the display buffer, the serialized
 * `output.txt` writes, the debounced state batcher and the stop-the-provider
 * reaction to a usage-limit signal; the chunk parsing itself (ANSI stripping,
 * stream-json, codex stderr, the raw stream buffer, signal detection) is the
 * shared `lib/cliAgentOutputParser.js`, which the cos-runner also uses. It never
 * spawns or finalizes: the caller feeds it `data` chunks and, on `close`, calls
 * `finish()` and reads `snapshot()`.
 */

import { join } from 'path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { isPrivateSecurityTask } from '../../lib/privateSecurityPolicy.js';
import { emitLog } from '../cos/cosEvents.js';
import { updateAgent, createAgentOutputBatcher, appendAgentOutputLines } from '../cos/cosAgentLifecycle.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { writeFileGuarded } from '../../lib/fileUtils.js';
import { createTranscriptWriteReporter } from '../agentTuiSpawning/outputSpooler.js';
import { createCliAgentOutputParser } from '../../lib/cliAgentOutputParser.js';

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
 * @param {object} params.cliConfig - `{ command, args, streamFormat }`: the format decides stream-json vs plain stdout, the command selects the codex stderr formatter
 * @param {string} params.prompt - the codex stderr formatter hides the echoed prompt
 * @param {string} params.agentDir - directory holding `output.txt`
 * @param {() => boolean} params.isProcessStopped - already killed? then a fallback signal is ignored
 * @param {() => void} params.stopProcess - kill the provider process tree on a fallback signal
 */
export function createCliOutputPipeline({ agentId, task, runId, provider, cliConfig, prompt, agentDir, isProcessStopped, stopProcess }) {
  let outputBuffer = '';
  let outputRevision = 0;
  let hasStartedWorking = false;
  // Deliberately NOT `hasStartedWorking`: that flag also flips on a 3s
  // initialization timeout with no output behind it, so reusing it would file a
  // `run.output` for a run that has produced nothing — the exact case (a
  // provider that never spoke) the ledger is supposed to make visible.
  let firstOutputRecorded = false;
  let immediateFallbackAnalysis = null;
  let finalSummary = null;

  const outputFile = join(agentDir, 'output.txt');
  const parser = createCliAgentOutputParser({
    command: cliConfig.command, args: cliConfig.args, streamFormat: cliConfig.streamFormat, prompt,
  });

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

  const stopForImmediateFallbackSignal = (analysis) => {
    if (!analysis || immediateFallbackAnalysis || isProcessStopped()) return;
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

  // Appends one parser result to the transcript: `lines` get a newline each, `text` is verbatim.
  const appendParsed = ({ lines, text }) => {
    if (lines.length) appendLines(lines);
    if (text) {
      outputBuffer += text;
      outputBatcher.push(text);
    }
  };

  const onStdout = (data) => {
    try {
      const raw = data.toString();
      const parsed = parser.stdout(raw);
      // React to fallback signals SYNCHRONOUSLY, before enqueuing any transcript
      // mutation — a blocked earlier write must never delay killing the provider
      // on a usage-limit signal (#2384).
      stopForImmediateFallbackSignal(parsed.fallbackSignal);
      // Serialize the transcript body so two `data` events can't interleave their
      // awaits and reorder output.txt / the batched live tail.
      enqueueTranscriptWrite(async () => {
        // Raw length, not stripped: a chunk that was ONLY color codes is still
        // proof the child is alive, and reporting 0 would read as "no output yet".
        await recordFirstOutput('cli-stdout', raw.length);
        await markWorking(`Agent ${agentId} working...`);
        appendParsed(parsed);
      });
    } catch (err) {
      console.error(`❌ agentCli stdout handler failed: ${err.message}`);
    }
  };

  const onStderr = (data) => {
    try {
      const raw = data.toString();
      const parsed = parser.stderr(raw);
      // Synchronous fallback reaction before the serialized write (see stdout).
      stopForImmediateFallbackSignal(parsed.fallbackSignal);
      enqueueTranscriptWrite(async () => {
        await recordFirstOutput('cli-stderr', raw.length);
        appendParsed(parsed);
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
    const flushed = parser.flush();
    for (const line of flushed.lines) {
      outputBuffer += line + '\n';
      outputBatcher.push(line);
    }
    // Use the parsed final result for the output file if available
    if (flushed.finalResult) {
      outputBuffer = flushed.finalResult;
      outputRevision++;
    }
    finalSummary = flushed.completionResult;
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
      rawStreamBuffer: parser.rawStream(),
      immediateFallbackAnalysis,
      finalSummary,
    }),
  };
}
