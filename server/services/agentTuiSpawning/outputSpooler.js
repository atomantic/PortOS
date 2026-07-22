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
 * Both pipelines debounce writes on a 250ms window (see CLAUDE.md "High-
 * frequency state writes must batch") — a chatty TUI emits hundreds of chunks
 * /sec, and per-chunk state writes would thrash the filesystem and slow the PTY
 * event loop. Extracted from spawnTuiAgent so the buffering/spooling concern is
 * self-contained and independently testable; the spawner keeps only the
 * orchestration.
 */

import { appendFile, writeFile } from 'fs/promises';
import { appendAgentOutputLines, updateAgent } from '../cosAgents.js';
import { OUTPUT_BUFFER_CAP, OUTPUT_BUFFER_HEADROOM, RAW_SPOOL_MAX_BYTES } from '../../lib/tuiHandshake.js';

// Debounce window for batching parsed output AND raw chunks to disk + state.
// 250ms is invisible to the live tail but cuts I/O by 1-2 orders of magnitude.
const OUTPUT_FLUSH_INTERVAL_MS = 250;

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

  // Queue a raw PTY chunk for the debounced raw.txt spool.
  const pushRaw = (text) => {
    pendingRawChunks.push(text);
    scheduleRawFlush();
  };

  // Drain the parsed-line pipeline: await any in-flight flush, then flush
  // whatever is still pending. Called at finalize (and mirrored order matters —
  // see drainRaw) so completion events don't beat the last batch to disk.
  const drainLines = async () => {
    if (flushing) await flushing.catch(() => {});
    await flushPendingLines();
  };

  // Drain the raw-chunk pipeline. Same shape as drainLines.
  const drainRaw = async () => {
    if (rawFlushing) await rawFlushing.catch(() => {});
    await flushPendingRawChunks();
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
