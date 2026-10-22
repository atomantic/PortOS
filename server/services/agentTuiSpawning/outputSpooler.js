import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
/**
 * Agent TUI output spooler
 *
 * Owns the two batched write pipelines a TUI agent spawn needs:
 *
 *  1. Parsed status lines → the in-memory `outputBuffer` (capped) AND the
 *     append-only `output.txt` + agent state stream (via appendAgentOutputLines).
 *  2. Raw PTY bytes → the append-only `raw.txt` disk spool (no ANSI strip, no
 *     line semantics) that `analyzeAgentFailure` reads on failure.
 *
 * Parsed status uses a 250ms window; raw recovery output uses a 1s window.
 * Each publication durably registers and releases admission journals, whose
 * synchronous flushes block the server loop even though the append is async.
 * Raw output is not the live shell stream; batching it more coarsely reduces
 * that overhead, while finalization still drains immediately.
 */

import { appendFile, writeFile } from 'fs/promises';
import { appendAgentOutputLines, updateAgent } from '../cosAgentLifecycle.js';
import { OUTPUT_BUFFER_CAP, OUTPUT_BUFFER_HEADROOM, RAW_SPOOL_MAX_BYTES } from '../../lib/tuiHandshake.js';

// Status updates stay responsive; raw recovery output can tolerate a longer
// batching window. Neither timer delays an explicit final drain.
const OUTPUT_FLUSH_INTERVAL_MS = 250;
const RAW_FLUSH_INTERVAL_MS = 1000;

/**
 * Create a per-run transcript write failure reporter. Logs the first failure
 * per (agentId, fileLabel) and updates agent metadata to flag the transcript
 * as incomplete, deduplicating multiple errors from a failing disk.
 *
 * @param {object} opts
 * @param {string} opts.agentId  Agent id (used in logs and metadata updates).
 * @param {(fileLabel: string) => boolean} [opts.isDrained]  True once the
 *   final drain for that file's pipeline finished. An ENOENT after that point
 *   is a straggler flush landing in a run directory the completion path has
 *   already archived or removed — the transcript was fully written by the
 *   drain, so it is neither flagged nor sent to stderr. ENOENT on a pipeline
 *   that has not drained is still a fault: the directory vanished under a
 *   live run.
 * @returns {object} Reporter with `report(fileLabel, err)` method.
 */
export function createTranscriptWriteReporter({ agentId, isDrained = () => false }) {
  const reportedFailures = new Set();

  return {
    report(fileLabel, err) {
      const failureKey = `${fileLabel}`;
      if (reportedFailures.has(failureKey)) {
        // Already reported this failure — skip duplicate logging
        return;
      }
      reportedFailures.add(failureKey);

      if (err.code === 'ENOENT' && isDrained(fileLabel)) {
        console.log(`⏭️ agent ${agentId} ${fileLabel} late write skipped after the final drain (ENOENT) — run directory already archived`);
        return;
      }

      // Log the first failure with error code and message
      console.error(`❌ agent ${agentId} ${fileLabel} write failed (${err.code || 'error'}): ${err.message}`);

      // Update agent metadata to flag transcript as incomplete
      return updateAgent(agentId, { metadata: { transcriptWriteFailed: { file: fileLabel, code: err.code || 'unknown' } } })
        .catch(metaErr => console.error(`❌ agent ${agentId} transcriptWriteFailed metadata write failed: ${metaErr.message}`));
    },
  };
}

// RAW_SPOOL_MAX_BYTES lives in tuiHandshake.js so the test suite can shrink the
// cap via the same vi.mock pattern that overrides the output-buffer thresholds
// — saves the truncation test from having to push hundreds of MB through the
// spawner. A misbehaving (or compromised) TUI agent could in principle emit
// MB/sec forever and fill the volume; realistic agents idle out at 180s and
// emit <10MB total. At this threshold the spool is truncated (rewritten with
// the current batch) so the most-recent data remains, which is what the
// tail-read at finalize needs anyway. Warn fires once per agent run; the
// `rawSpoolTruncated` metadata flag persists in the agent record so the
// operator can spot the affected runs after the fact.

/**
 * Create the per-agent output spooler. Returns the small surface the spawner
 * drives: append a parsed line, push a raw PTY chunk, drain both pipelines at
 * finalize, and read the capped in-memory buffer for failure-analysis fallback.
 *
 * @param {object} opts
 * @param {string} opts.agentId  Agent id (used for warn logs + metadata writes).
 * @param {string} opts.outputFile  Absolute path to output.txt.
 * @param {string} opts.rawFile  Absolute path to raw.txt.
 */
export function createOutputSpooler({ agentId, outputFile, rawFile }) {
  let outputBuffer = '';
  let lastLine = '';
  // True once outputBuffer crossed its HEADROOM and the head was dropped.
  // Mirrors `outputBufferTruncated` in `tuiPromptRunner.js`: warn once per
  // buffer and surface via agent metadata so the agent record distinguishes
  // a long-run-with-overflow from a clean short run.
  let outputBufferTruncated = false;

  let pendingLines = [];
  let flushTimer = null;
  let flushing = null;
  let pendingRawChunks = [];
  let rawFlushTimer = null;
  let rawFlushing = null;
  let rawBytesWritten = 0;
  let rawSpoolTruncationWarned = false;
  // A drain owns its pipeline until it returns: the debounce timer must not
  // launch a second concurrent flush, or the drain can see an empty queue and
  // resolve while that other flush's append is still in flight — the completion
  // path would then archive the run directory under the pending write.
  let linesDraining = false;
  let rawDraining = false;
  // Set once a drain has written everything queued; see the reporter's isDrained.
  let linesDrained = false;
  let rawDrained = false;

  const reporter = createTranscriptWriteReporter({
    agentId,
    isDrained: (fileLabel) => (fileLabel === 'raw.txt' ? rawDrained : linesDrained),
  });

  const flushPendingLines = () => withBackupAssetPublication(async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pendingLines.length === 0) return;
    const batch = pendingLines;
    pendingLines = [];
    await Promise.all([
      appendAgentOutputLines(agentId, batch).catch((err) => reporter.report('state', err)),
      appendFile(outputFile, batch.map(l => `${l}\n`).join('')).catch((err) => reporter.report('output.txt', err))
    ]);
  });

  const scheduleFlush = () => {
    if (flushTimer || flushing || linesDraining) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushing = flushPendingLines().catch(err => reporter.report('state', err)).finally(() => {
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
  // 1s debounce window AND while an appendFile is in-flight (the next
  // scheduleRawFlush is gated by rawFlushing); join() runs once per flush
  // tick, so peak in-memory raw data is bounded by one debounce-plus-IO
  // window of TUI output (typically hundreds of KB on a chatty agent).
  const flushPendingRawChunks = () => withBackupAssetPublication(async () => {
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
        console.warn(`⚠️ TUI agent ${agentId} raw PTY spool reached ${Math.round(RAW_SPOOL_MAX_BYTES / 1024 / 1024)}MB — truncating spool (oldest bytes dropped; tail-read still reflects most recent)`);
        // Publish the warning before dropping bytes; if this fails, preserve
        // the previous spool and retry the warning on the next flush. Reported,
        // never thrown: drainRaw runs inside finish(), where a rejection would
        // abandon the run's teardown.
        const published = await updateAgent(agentId, { metadata: { rawSpoolTruncated: true } })
          .then(() => true)
          .catch(async (err) => {
            await reporter.report('state', err);
            return false;
          });
        if (!published) return;
        rawSpoolTruncationWarned = true;
      }
      // Only update the byte counter on successful write — a failed write
      // would otherwise inflate rawBytesWritten and make subsequent flush
      // decisions race the actual on-disk state.
      const wrote = await writeFile(rawFile, writeBuf).then(() => true).catch(async (err) => {
        await reporter.report('raw.txt', err);
        return false;
      });
      if (wrote) rawBytesWritten = writeBytes;
      return;
    }
    const wrote = await appendFile(rawFile, batch).then(() => true).catch(async (err) => {
      await reporter.report('raw.txt', err);
      return false;
    });
    if (wrote) rawBytesWritten += batchBytes;
  });

  const scheduleRawFlush = () => {
    if (rawFlushTimer || rawFlushing || rawDraining) return;
    rawFlushTimer = setTimeout(() => {
      rawFlushTimer = null;
      rawFlushing = flushPendingRawChunks().catch(err => reporter.report('raw.txt', err)).finally(() => {
        rawFlushing = null;
        // Same re-schedule guard as scheduleFlush: chunks that arrived
        // during the in-flight appendFile would otherwise sit until
        // finalize if the producer goes quiet immediately after.
        if (pendingRawChunks.length > 0) scheduleRawFlush();
      });
    }, RAW_FLUSH_INTERVAL_MS);
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

  // Queue a raw PTY chunk for the debounced raw.txt spool.
  const pushRaw = (text) => {
    pendingRawChunks.push(text);
    scheduleRawFlush();
  };

  // Drain a pipeline to empty: stop its timer, wait out the in-flight flush,
  // then flush until nothing is queued. The drain is the only writer while it
  // runs (scheduleFlush/scheduleRawFlush stand down on the draining flag), and
  // the flag drops in `finally` so a rejected drain (e.g. BACKUP_SNAPSHOT_BUSY)
  // does not wedge later flushes.
  const drainPipeline = async ({ setDraining, getTimer, clearTimer, getInFlight, flush, hasPending }) => {
    setDraining(true);
    try {
      for (;;) {
        if (getTimer()) clearTimer();
        const inFlight = getInFlight();
        if (!inFlight) break;
        await inFlight.catch(() => {});
      }
      do { await flush(); } while (hasPending());
    } finally {
      setDraining(false);
    }
  };

  // Drain the parsed-line pipeline. Called at finalize (order matters — see
  // drainRaw) so completion events don't beat the last batch to disk.
  const drainLines = async () => {
    await drainPipeline({
      setDraining: (v) => { linesDraining = v; },
      getTimer: () => flushTimer,
      clearTimer: () => { clearTimeout(flushTimer); flushTimer = null; },
      getInFlight: () => flushing,
      flush: flushPendingLines,
      hasPending: () => pendingLines.length > 0,
    });
    linesDrained = true;
  };

  // Drain the raw-chunk pipeline. Same shape as drainLines.
  const drainRaw = async () => {
    await drainPipeline({
      setDraining: (v) => { rawDraining = v; },
      getTimer: () => rawFlushTimer,
      clearTimer: () => { clearTimeout(rawFlushTimer); rawFlushTimer = null; },
      getInFlight: () => rawFlushing,
      flush: flushPendingRawChunks,
      hasPending: () => pendingRawChunks.length > 0,
    });
    rawDrained = true;
  };

  return {
    appendLine,
    pushRaw,
    // Flush only the raw pipeline immediately (no in-flight await) — used by the
    // startup-failure path so the captured raw.txt tail includes the CLI's most
    // recent output before it's read back.
    flushRaw: flushPendingRawChunks,
    drainLines,
    drainRaw,
    getOutputBuffer: () => outputBuffer,
  };
}
