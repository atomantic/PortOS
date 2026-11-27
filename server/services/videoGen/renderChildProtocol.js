/** Reads one render child’s progress, diagnostics and ordered output records, and supervises post-completion hangs. */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { createVideoDiagnosticTail } from '../../lib/videoFailure.js';
import { createLineReader } from '../../lib/streamLines.js';
import { videoGenEvents } from './events.js';
import { broadcastSse, PYTHON_NOISE_RE } from '../../lib/sseUtils.js';
import { makeVideoGenLineHandler, finalizeGeneratedVideo } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { videoJobState } from './jobState.js';

const MODULE_NOT_FOUND_RE = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/;
const STDERR_TAIL_LINES = 40;

const COMPLETION_WATCHDOG_GRACE_MS = (() => {
  const raw = parseInt(process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 40000;
})();

const MUXING_DONE_RE = /\[Decoding video \+ audio \+ muxing\]\s+done in/i;

export function attachRenderChildProtocol(proc, { job, jobId, batch, meta }, {
  expectedOutputPaths, publications, collectMemoryEvidence,
}) {
  // Panel-side completion watchdog. Armed once we see the render's completion
  // marker on stdout; SIGKILLs the child if it hasn't exited after the grace
  // window. clearCompletionWatchdog() runs in every terminal path ('close',
  // 'error') so the timer can't outlive this child or fire against a recycled
  // PID. Armed at most once per child (re-seeing the marker is a no-op).
  let completionWatchdog = null;
  // Set when the watchdog itself fires the SIGKILL. The 'close' handler reads
  // it so it can treat that kill as success (the render already wrote its file —
  // we only killed a post-completion teardown hang) rather than reporting the
  // generic "killed, likely OOM" failure.
  let completionWatchdogFired = false;
  // Which of `expectedOutputPaths` THIS child reported finished, by exact
  // path. Minted per child rather than stamped on `job` — `job` outlives a
  // prompt-encode relaunch, and the dead child's completion claim must never
  // vouch for its replacement's output (#6501).
  const completedOutputs = new Set();
  const clearCompletionWatchdog = () => {
    if (completionWatchdog) {
      clearTimeout(completionWatchdog);
      completionWatchdog = null;
    }
  };
  const armCompletionWatchdog = () => {
    if (completionWatchdog) return;
    completionWatchdog = setTimeout(() => {
      // Runs outside the Express request lifecycle — an uncaught throw here
      // would crash the Node process, so guard the whole body.
      try {
        completionWatchdog = null;
        // proc.killed covers a manual-cancel SIGTERM that hasn't reached close
        // yet (killWithEscalation sets it before exitCode/signalCode populate).
        if (videoJobState.activeProcess !== proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return;
        console.log(`⚠️ video child reported completion but never exited — SIGKILL [${jobId.slice(0, 8)}]`);
        completionWatchdogFired = true;
        proc.kill('SIGKILL');
      } catch (err) {
        console.error(`❌ completion watchdog failed [${jobId.slice(0, 8)}]: ${err.message}`);
      }
    }, COMPLETION_WATCHDOG_GRACE_MS);
    // Don't let the watchdog timer keep the event loop alive on its own.
    if (typeof completionWatchdog.unref === 'function') completionWatchdog.unref();
  };

  let missingPyModule = null;
  // Rolling tail of this child's stderr. The Metal abort text is the only
  // evidence of WHY the watchdog fired and it is not a protocol line, so
  // nothing else on the path retains it. Bounded so a chatty runtime cannot
  // grow it without limit; the abort banner is the last thing printed before
  // the process dies, so the tail always holds it.
  const stderrTail = [];
  const diagnostics = createVideoDiagnosticTail();
  const recordStderrTail = (raw) => {
    stderrTail.push(raw.slice(-2048));
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
  };

  // The python child's STATUS:/STAGE:/DOWNLOAD:/tqdm → SSE-frame parser lives
  // in generateVideoHelpers.js so it can be unit-tested without a real child.
  // Returns true for a recognized progress/status/noise line (suppress raw
  // logging), false for an unhandled line worth raw-logging.
  const handleLine = makeVideoGenLineHandler({ job, jobId, pythonNoiseRe: PYTHON_NOISE_RE });
  const batchResults = [];
  let outputTail = Promise.resolve();
  let batchError = null;
  let receivedOutputs = 0;
  const stopFailedBatch = (err) => {
    batchError ||= err;
    try { proc.kill('SIGTERM'); } catch (killError) {
      console.error(`❌ Video batch could not stop [${jobId.slice(0, 8)}]: ${killError.message}`);
    }
  };
  const acceptBatchOutput = (parsed) => {
    const item = batch[receivedOutputs];
    const itemFilename = item?.filename;
    const itemPath = itemFilename && join(PATHS.videos, itemFilename);
    if (!item || parsed.batch_index !== item.index || parsed.seed !== item.seed || parsed.video_path !== itemPath) {
      stopFailedBatch(new Error('Video batch returned an unexpected output or seed.'));
      return;
    }
    receivedOutputs += 1;
    completedOutputs.add(itemPath);
    publications.get(itemPath).started = true;
    outputTail = outputTail.then(async () => {
      const thumbnail = await finalizeGeneratedVideo({
        job, jobId: item.id, outputPath: itemPath, filename: itemFilename,
        meta: { ...meta, id: item.id, filename: itemFilename, seed: item.seed, batchIndex: item.index },
        actualSeed: item.seed, mutateHistory: mutateVideoHistory,
        // Batch timings include shared startup and cannot train single-render ETAs.
        startedAtMs: null, terminal: false,
        publication: publications.get(itemPath),
      });
      batchResults.push({ filename: itemFilename, seed: item.seed, thumbnail, path: `/data/videos/${itemFilename}` });
      const message = `Saved ${batchResults.length}/${batch.length} videos`;
      broadcastSse(job, { type: 'status', message });
      videoGenEvents.emit('status', { generationId: jobId, message });
    }).catch(stopFailedBatch);
    if (receivedOutputs === batch.length) armCompletionWatchdog();
  };

  // Per-stream line readers carry the partial trailing line across chunk
  // boundaries and decode through a StringDecoder, so a marker (or multibyte
  // char) split across a pipe chunk can't tear an event — and the final
  // unterminated line is emitted on 'close' via flush().
  const stdoutReader = createLineReader((raw) => {
    const line = raw.trim();
    if (!line) return;
    // mlx_video emits one JSON line on stdout when finished — capture it
    // for the result metadata; otherwise raw-log so we can debug failures.
    try {
      const parsed = JSON.parse(line);
      if (parsed.video_path && batch) {
        acceptBatchOutput(parsed);
        return;
      }
      if (parsed.video_path) {
        job.resultJson = parsed;
        // Completion evidence only when the child names the exact file THIS
        // job asked for. An unrelated path still arms the watchdog (the child
        // is clearly past its render) but proves nothing about our output.
        if (expectedOutputPaths.includes(parsed.video_path)) completedOutputs.add(parsed.video_path);
        // The result JSON is the strongest "work is done" signal — arm the
        // watchdog so a post-completion teardown hang can't wedge the job.
        armCompletionWatchdog();
      }
      return;
    } catch { /* not JSON */ }
    // Some runtimes don't print the result JSON but do log the final
    // decode+mux line right before they should exit — treat it the same way.
    if (!batch && MUXING_DONE_RE.test(line)) armCompletionWatchdog();
    console.log(`🐍-out [${jobId.slice(0, 8)}] ${line}`);
  });
  const stderrReader = createLineReader((raw) => {
    if (collectMemoryEvidence(raw)) return;
    recordStderrTail(raw);
    // Record the root-cause module only — downstream imports in the same
    // traceback raise the same error against later names.
    if (!missingPyModule) {
      const m = raw.match(MODULE_NOT_FOUND_RE);
      if (m) missingPyModule = m[1];
    }
    if (!handleLine(raw)) console.log(`🐍 [${jobId.slice(0, 8)}] ${raw.trim()}`);
  }, { splitRe: /[\n\r]+/ });

  proc.stdout.on('data', (chunk) => {
    diagnostics.push('stdout', chunk);
    stdoutReader.push(chunk);
  });

  proc.stderr.on('data', (chunk) => {
    diagnostics.push('stderr', chunk);
    stderrReader.push(chunk);
  });

  return {
    batchResults, completedOutputs, diagnostics, stderrTail,
    get missingPyModule() { return missingPyModule; },
    get completionWatchdogFired() { return completionWatchdogFired; },
    get batchError() { return batchError; },
    get outputTail() { return outputTail; },
    clearCompletionWatchdog,
    flush() {
      stdoutReader.flush();
      stderrReader.flush();
      clearCompletionWatchdog();
    },
  };
}
