/**
 * generateVideoHelpers — extracted, unit-testable pieces of the (formerly
 * ~508-line) generateVideo() orchestrator in local.js (issue #1153).
 *
 * Kept as a sibling module rather than inlined so the line-parsing state
 * machine and the success-path finalize can be tested in isolation without
 * spawning a real python child. generateVideo() wires these into its spawn
 * closure; the functions here own no module-level state.
 */

import { existsSync, statSync } from 'fs';
import { broadcastSse } from '../../lib/sseUtils.js';
import { generateThumbnail, optimizeForStreaming } from '../../lib/ffmpeg.js';
import { formatBytes } from '../../lib/fileUtils.js';
import { videoGenEvents } from './events.js';

/**
 * Parse byte size values from strings, returning bytes as a number.
 * Handles formats like: "1.5G", "500MB", "1.5GiB", "1.00G/2.00G"
 * Returns null if no parseable byte value found.
 * @param {string} str
 * @returns {{ downloaded: number|null, total: number|null }}
 */
export function parseByteProgress(str) {
  // Pattern matches: 1.5G, 500MB, 2.00GiB, etc.
  // Group 1: number (with optional decimal)
  // Group 2: unit (B, K, KB, KiB, M, MB, MiB, G, GB, GiB, T, TB, TiB)
  const bytePattern = /(\d+(?:\.\d+)?)\s*(B|Ki?B?|Mi?B?|Gi?B?|Ti?B?)(?![a-zA-Z])/gi;
  const matches = [...str.matchAll(bytePattern)];
  if (matches.length === 0) return { downloaded: null, total: null };

  const parseUnit = (val, unit) => {
    const num = parseFloat(val);
    const u = unit.toUpperCase().replace(/I?B$/, '');
    switch (u) {
      case '': case 'B': return num;
      case 'K': return num * 1024;
      case 'M': return num * 1024 ** 2;
      case 'G': return num * 1024 ** 3;
      case 'T': return num * 1024 ** 4;
      default: return num;
    }
  };

  // If we have two matches in "X/Y" format, first is downloaded, second is total
  if (matches.length >= 2) {
    return {
      downloaded: parseUnit(matches[0][1], matches[0][2]),
      total: parseUnit(matches[1][1], matches[1][2]),
    };
  }
  // Single match — treat as total (or downloaded, context-dependent)
  return {
    downloaded: null,
    total: parseUnit(matches[0][1], matches[0][2]),
  };
}

// Re-export formatBytes from fileUtils for consumers of this module
export { formatBytes };

/**
 * Format a download progress message with optional byte counts.
 * @param {string} rawText - Original text after DOWNLOAD: prefix
 * @param {{ downloaded: number|null, total: number|null }} byteInfo
 * @returns {string}
 */
export function formatDownloadMessage(rawText, byteInfo) {
  const { downloaded, total } = byteInfo;
  if (total != null && total > 0) {
    const totalStr = formatBytes(total);
    if (downloaded != null && downloaded > 0) {
      const downloadedStr = formatBytes(downloaded);
      return `Downloading model · first run · ${downloadedStr} / ${totalStr}`;
    }
    return `Downloading model · first run · ${totalStr}`;
  }
  // Fall back to raw text if no byte info parsed
  return `Downloading model... ${rawText}`;
}

/**
 * Boundary markers `scripts/generate_ltx2.py` prints on stderr around the Gemma
 * prompt encode (`install_prompt_encode_markers`). Matched EXACTLY, never by
 * prefix — `STAGE:encode-prompt-done` starts with `STAGE:encode-prompt`, so a
 * `startsWith` test would read the end of the encode as its beginning.
 */
export const PROMPT_ENCODE_BEGIN_MARKER = 'STAGE:encode-prompt';
export const PROMPT_ENCODE_END_MARKER = 'STAGE:encode-prompt-done';

/**
 * Build the stdout/stderr line handler for one generation. Parses the
 * python child's STATUS:/STAGE:/DOWNLOAD:/tqdm protocol into SSE frames
 * (`broadcastSse`) + queue-dispatcher events (`videoGenEvents`).
 *
 * Returns a `handleLine(raw)` fn: true when the line was a recognized
 * progress/status/noise line the caller should suppress from raw logging,
 * false for an unhandled line worth raw-logging.
 *
 * @param {object} ctx
 * @param {object} ctx.job - the in-flight job record (broadcastSse target)
 * @param {string} ctx.jobId
 * @param {RegExp} ctx.pythonNoiseRe - lines to silently drop (PYTHON_NOISE_RE)
 */
export function makeVideoGenLineHandler({ job, jobId, pythonNoiseRe }) {
  // Phase tracking — download vs inference, so tqdm bars with byte counts can
  // be formatted as "Downloading model · first run · X.X GB" during downloads.
  let currentPhase = 'starting';
  let isDownloading = false;
  // History-calibrated wall-clock estimate for this render (#3801), stamped on
  // the job by generateVideo. Repeated on every progress frame so a client that
  // subscribed mid-render still learns it, and so the estimate can't be lost to
  // a missed `started` event. Omitted entirely when there is no estimate — an
  // absent key, never `etaMs: 0`, which a UI would render as "done".
  const etaField = () => (Number.isFinite(job?.etaMs) ? { etaMs: job.etaMs } : {});

  return (raw) => {
    const line = raw.trim();
    if (!line) return true;
    if (pythonNoiseRe.test(line)) return true;
    // Runtime fingerprint emitted once at child startup (RUNTIME:<json> — see
    // scripts/_runner_common.py emit_runtime_fingerprint). Stamp it onto the
    // job so finalizeGeneratedVideo can persist it on the history record, and
    // log a single self-documenting line so a render that produced garbled
    // output can be tied to a specific ltx/mlx/torch + chip + OS stack.
    if (line.startsWith('RUNTIME:')) {
      try {
        const fp = JSON.parse(line.slice('RUNTIME:'.length));
        job.runtime = fp;
        console.log(`🏷️ runtime [${jobId.slice(0, 8)}] ${formatRuntimeFingerprint(fp) || '?'}`);
        return true;
      } catch {
        // Malformed fingerprint line — fall through to raw-logging so the
        // broken payload is visible rather than silently swallowed.
        return false;
      }
    }
    // Heartbeat for the queue's idle watchdog (see imageGen/local.js).
    videoGenEvents.emit('activity', { generationId: jobId });
    if (line.startsWith('STATUS:')) {
      const message = line.slice(7);
      broadcastSse(job, { type: 'status', message });
      // Mirror status to videoGenEvents so the mediaJobQueue SSE dispatcher
      // forwards it to the client. Without this, only STAGE: progress
      // reaches the UI and long pre-render phases ("Loading pipeline…",
      // "Generating I2V…") display nothing.
      videoGenEvents.emit('status', { generationId: jobId, message });
      return true;
    }
    if (line.startsWith('STAGE:')) {
      // Gemma prompt-encode boundary (scripts/generate_ltx2.py). Stamped on the
      // job as a three-state phase — absent = this runner never reports one,
      // 'active' = encoding right now, 'done' = finished — so a later SIGABRT can
      // be attributed to the encode without conflating "never reported" with
      // "finished". Compared exactly: the '-done' marker is a prefix extension of
      // the begin marker. See planPromptEncodingRetry.
      if (line === PROMPT_ENCODE_BEGIN_MARKER) job.promptEncodePhase = 'active';
      else if (line === PROMPT_ENCODE_END_MARKER) job.promptEncodePhase = 'done';
      const parts = line.split(':');
      // Track phase for tqdm bar formatting — STAGE:download* sets download mode,
      // other phases (inference, encode, decode, etc.) clear it.
      const stage = (parts[1] || '').toLowerCase();
      currentPhase = stage;
      isDownloading = stage.startsWith('download');
      // Three STAGE: shapes ship today:
      //   STAGE:<stage>:step:<cur>:<total>:<msg>  — explicit progress (parts[2]='step')
      //   STAGE:<stage>:heartbeat:<N>s            — idle-watchdog ping (parts[2]='heartbeat')
      //   STAGE:<stage>                           — terse phase marker (no extra fields)
      // The legacy "treat every STAGE: as step:" parse mangled heartbeat
      // lines: parts[3]='20s' → parseInt=20, parts[4]=undefined → total=1, so
      // a download-clip heartbeat broadcast progress=20.0 (= 2000%) to the UI.
      // Normalize tag case — generate_ltx2.py emits `STEP:` (uppercase),
      // generate_hunyuan.py emits `step:` and `heartbeat:` (lowercase).
      const tag = (parts[2] || '').toLowerCase();
      if (tag === 'heartbeat') {
        // Surface as a status message; the activity emit above already
        // resets the queue watchdog. Mirror to videoGenEvents so the
        // mediaJobQueue SSE dispatcher forwards it to the client.
        const message = `${parts[1]}: heartbeat ${parts[3] || ''}`;
        broadcastSse(job, { type: 'status', message });
        videoGenEvents.emit('status', { generationId: jobId, message });
        return true;
      }
      if (tag === 'step') {
        const step = parseInt(parts[3], 10) || 0;
        const total = parseInt(parts[4], 10) || 1;
        const label = parts.slice(5).join(':');
        broadcastSse(job, { type: 'progress', progress: step / total, message: label, phase: currentPhase });
        // Pass the python-side label as `message` so the dispatcher surfaces
        // it to the client instead of falling back to the synthesized
        // "Rendering step X/Y" (which hides useful labels like "Loading
        // model" emitted at stage boundaries).
        videoGenEvents.emit('progress', { generationId: jobId, progress: step / total, step, totalSteps: total, message: label || undefined, ...etaField() });
        return true;
      }
      // Bare phase marker (e.g. STAGE:load-pipeline, STAGE:from-pretrained) —
      // surface as a status line. No progress %, no division-by-undefined.
      // Mirror to videoGenEvents for client forwarding.
      const message = parts.slice(1).join(':');
      broadcastSse(job, { type: 'status', message });
      videoGenEvents.emit('status', { generationId: jobId, message });
      return true;
    }
    if (line.startsWith('DOWNLOAD:')) {
      isDownloading = true;
      currentPhase = 'download';
      const rawText = line.slice(9);
      const byteInfo = parseByteProgress(rawText);
      const message = formatDownloadMessage(rawText, byteInfo);
      // Include downloadedBytes/totalBytes fields for clients that want numeric progress
      const frame = { type: 'status', message, phase: currentPhase };
      if (byteInfo.downloaded != null) frame.downloadedBytes = byteInfo.downloaded;
      if (byteInfo.total != null) frame.totalBytes = byteInfo.total;
      broadcastSse(job, frame);
      videoGenEvents.emit('status', { generationId: jobId, message, ...byteInfo });
      return true;
    }
    const m = line.match(/(\d+)%\|/);
    if (m) {
      const pct = parseInt(m[1], 10) / 100;
      // Check for byte sizes in tqdm bars (e.g., "50%|█████     | 1.00G/2.00G")
      // which appear during HF downloads. Format nicely during download phase.
      const byteInfo = parseByteProgress(line);
      let displayMessage = line;
      const frame = { type: 'progress', progress: pct, phase: currentPhase };
      if (isDownloading && (byteInfo.downloaded != null || byteInfo.total != null)) {
        displayMessage = formatDownloadMessage(line, byteInfo);
        if (byteInfo.downloaded != null) frame.downloadedBytes = byteInfo.downloaded;
        if (byteInfo.total != null) frame.totalBytes = byteInfo.total;
      }
      frame.message = displayMessage;
      broadcastSse(job, frame);
      // Omit `message` on the queue-dispatcher emit: the raw tqdm bar
      // (`60%|██████    | 6/10 [00:30<00:20, ...]`) is terminal noise that
      // would clobber the last meaningful STATUS/STAGE line on every
      // percent update. Client renders the percentage separately.
      videoGenEvents.emit('progress', { generationId: jobId, progress: pct, ...etaField() });
      return true;
    }
    return false;
  };
}

/**
 * Version marker stamped on every history record written by this (finish-aware)
 * writer — see `describeRenderConditioning`. It is the POSITIVE signal that the
 * record's conditioning inventory is trustworthy: a legacy record written
 * before #3696 carries no `renderInputsVersion` and no `conditioning`, which is
 * indistinguishable from "this render used no conditioning" if you only look at
 * the absence. Consumers (the client's Finish gate) must require this marker,
 * so legacy/incomplete records degrade to "not finishable" instead of being
 * wrongly assumed reproducible.
 */
export const RENDER_INPUTS_VERSION = 1;

/**
 * Inventory the conditioning inputs one render actually used, as a stable,
 * sorted list of kind strings. An empty array means the render was driven by
 * nothing but the prompt + seed + dials — i.e. fully reproducible from what the
 * history record already stores, which is the precondition for Finish (#3696).
 *
 * Deliberately records KINDS, not paths: staging/temp upload paths are
 * machine-specific and short-lived, and history is user-facing (the same reason
 * IC references are stamped by basename). Recording the fact of conditioning is
 * enough to answer "can this be re-rendered from the record alone?" — which is
 * the only question this feeds.
 *
 * Pure. Tolerates missing/`null` fields (the common text-to-video call).
 */
export function describeRenderConditioning({
  sourceImagePath = null,
  lastImagePath = null,
  keyframes = null,
  extendFromVideoPath = null,
  audioFilePath = null,
  icReferencePaths = null,
} = {}) {
  const kinds = [];
  if (sourceImagePath) kinds.push('image');
  if (lastImagePath) kinds.push('lastImage');
  if (Array.isArray(keyframes) && keyframes.length > 0) kinds.push('keyframes');
  if (extendFromVideoPath) kinds.push('extend');
  if (audioFilePath) kinds.push('audio');
  if (Array.isArray(icReferencePaths) && icReferencePaths.length > 0) kinds.push('icReference');
  return kinds.sort();
}

/**
 * Render a runtime fingerprint (either the `RUNTIME:` payload a helper script
 * emits — `{ runtime, versions, chip, os, python }` — or the Node-side
 * `hostRuntimeFingerprint()` block) as one human-readable line:
 * `ltx2 | mlx 0.22.0, torch 2.5.1 | Apple M4 Max | macOS-15.4-arm64`.
 * Shared by the startup log line and by signal-death failure messages so a
 * crash report self-documents the exact stack it crashed on. Pure; tolerates a
 * missing/partial payload (returns '' when nothing is known).
 * @param {object|null|undefined} fp
 * @returns {string}
 */
export function formatRuntimeFingerprint(fp) {
  if (!fp || typeof fp !== 'object') return '';
  const versions = fp.versions && typeof fp.versions === 'object' ? fp.versions : {};
  const vers = Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(', ');
  return [fp.runtime, vers, fp.chip, fp.os].filter(Boolean).join(' | ');
}

// Signal → actionable cause for a render child that died on a signal.
//
// Apple Silicon reality drives this map. The dominant real-world render abort is
// the macOS Metal command-buffer watchdog killing an over-long GPU command
// buffer (`kIOGPUCommandBufferCallbackErrorImpactingInteractivity`), which the
// MLX/Metal layer surfaces as SIGABRT (exit -6) — NOT as a Python-level
// assertion. Reporting that as a bare `Killed by signal SIGABRT` (or as a
// "C-level assertion failed" hint, the mistake upstream made) sends users
// hunting a model/PortOS bug when the fix is to shrink the work per command
// buffer. SIGBUS/SIGSEGV are the other native-crash arrivals from the same
// layer. SIGKILL stays the OOM message it has always been.
//
// Keys are the signal NAMES Node reports on `close` (spawnDetached decodes the
// supervisor's 128+signum status back into the same names).
//
// NOTE on the SIGABRT advice: the LoRA-trainer mitigation for this same watchdog
// is "let the display sleep" (docs/TROUBLESHOOTING.md), but that is NOT offered
// here — generateVideo holds a `caffeinate -dis` assertion for the child's whole
// lifetime, so display sleep is impossible during a render by construction.
// Telling the user to do something the render itself prevents would be worse
// than saying nothing. Running the machine headless still works (caffeinate
// can't wake a display that isn't attached), so that's what we point at.
const nativeCrashCause = (signal) => `Render crashed (${signal}) — a native fault inside the MLX/Metal layer, not a PortOS-level error. Retry with a lower resolution/frame count; if it repeats on the same model, reinstall that runtime from Settings → Video (a mismatched mlx / mlx-metal pair in the venv is the usual cause).`;

const SIGNAL_DEATH_CAUSES = Object.freeze({
  SIGKILL: 'Process killed (likely out of memory — try a smaller model or resolution)',
  SIGABRT: 'Render aborted (SIGABRT) — on Apple Silicon this is almost always the macOS Metal command-buffer watchdog killing an over-long GPU command buffer (kIOGPUCommandBufferCallbackErrorImpactingInteractivity), not a bug in the model or PortOS. Lower the resolution and/or frame count so each command buffer does less work, and quit other GPU-heavy apps so the render is not competing for the GPU with WindowServer compositing (driving this machine headless over SSH avoids that contention entirely).',
  SIGBUS: nativeCrashCause('SIGBUS'),
  SIGSEGV: nativeCrashCause('SIGSEGV'),
});

/**
 * Failure reason for a render child that exited on a signal. Pure.
 *
 * Unmapped signals keep the historical `Killed by signal <SIG>` wording so a
 * novel signal is still reported verbatim rather than mis-attributed. The
 * resolved runtime fingerprint is appended when known, so the report names the
 * mlx / mlx-metal / chip / macOS stack that died without the user having to go
 * look it up (matching what RuntimeFingerprint.jsx surfaces on the page).
 *
 * @param {string|null} signal - signal name from `proc.on('close', (code, signal))`
 * @param {object} [opts]
 * @param {object|null} [opts.fingerprint] - runtime fingerprint (see `pickDeathFingerprint` in runtimes.js)
 * @returns {string|null} reason, or null when the child did not die on a signal
 */
export function describeSignalDeath(signal, { fingerprint = null } = {}) {
  if (!signal) return null;
  const cause = SIGNAL_DEATH_CAUSES[signal] || `Killed by signal ${signal}`;
  const fp = formatRuntimeFingerprint(fingerprint);
  return fp ? `${cause} [runtime: ${fp}]` : cause;
}

/**
 * Gemma prompt-encode sequence length. `LTX2_GEMMA_MAX_LENGTH` is read by
 * ltx-2-mlx at encode time (`utils/blocks.py#PromptEncoder.encode`) and defaults
 * to 1024 there; the retry halves it so the encoder's attention matrices are a
 * quarter the size and each Metal command buffer finishes well inside the
 * watchdog window. Halving (rather than a deeper cut) keeps a long prompt's
 * tail intact — the tokenizer truncates from the LEFT, so a smaller budget
 * silently drops the START of the prompt, which is where the subject usually
 * is.
 */
export const DEFAULT_GEMMA_MAX_LENGTH = 1024;
export const RETRY_GEMMA_MAX_LENGTH = 512;

// The macOS Metal command-buffer watchdog reports WHY it killed a buffer via a
// `kIOGPUCommandBufferCallbackError*` enum name in the abort text. Two of those
// mean "this buffer ran too long for the compositor to stay responsive", which
// is the failure a smaller prompt-encode buffer actually fixes:
//   - ...ErrorTimeout                — the classic signature
//   - ...ErrorImpactingInteractivity — what newer Apple silicon / macOS report
//     instead, and the reason a Timeout-only match never armed the retry there.
// MLX also surfaces the timeout case in prose ("Caused GPU Timeout Error"), so
// that phrasing is accepted too.
const METAL_WATCHDOG_RE = /kIOGPUCommandBufferCallbackError(?:Timeout|ImpactingInteractivity)|Caused GPU Timeout Error/i;
// ...and two that must NOT arm it. An out-of-memory abort is not a watchdog
// timeout — a shorter prompt does not fix it, and retrying burns another model
// load on a machine that is already out of headroom. An innocent victim was
// killed because SOME OTHER process wedged the GPU, so this render's prompt
// length is irrelevant. Either name anywhere in the captured text vetoes the
// retry, even alongside a timeout: a mixed abort is exactly the case where the
// timeout is a downstream symptom rather than the cause.
const METAL_WATCHDOG_VETO_RE = /kIOGPUCommandBufferCallbackError(?:OutOfMemory|InnocentVictim)/i;

/**
 * Whether a render child died to the macOS Metal command-buffer watchdog WHILE
 * the Gemma prompt encoder was running. Pure.
 *
 * `promptEncodePhase` is a three-state sentinel, and all three states are
 * distinct on purpose:
 *   - `null`     — the runner never reported an encode boundary. Every runtime
 *                  other than the LTX-2 MLX helper is permanently here, so an
 *                  unreported phase can never be mistaken for a live encode.
 *   - `'active'` — the encode began and never finished. The ONLY qualifying
 *                  state: the child died mid-encode, before any denoise step.
 *   - `'done'`   — the encode finished. Anything that aborts after this is a
 *                  denoise/decode failure that a shorter prompt cannot fix.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.signal] - signal name from `proc.on('close')`
 * @param {string} [opts.stderr] - captured stderr tail from the dead child
 * @param {'active'|'done'|null} [opts.promptEncodePhase]
 * @returns {boolean}
 */
export function isPromptEncodingMetalWatchdog({ signal = null, stderr = '', promptEncodePhase = null } = {}) {
  // The Metal layer raises a C++ exception that terminate() turns into SIGABRT;
  // a watchdog kill never arrives as a clean non-zero exit.
  if (signal !== 'SIGABRT') return false;
  if (promptEncodePhase !== 'active') return false;
  const text = typeof stderr === 'string' ? stderr : '';
  if (METAL_WATCHDOG_VETO_RE.test(text)) return false;
  return METAL_WATCHDOG_RE.test(text);
}

/**
 * Decide whether one render may be relaunched after a prompt-encode watchdog
 * abort, and with what Gemma budget. Pure — returns the plan, never acts.
 *
 * Returns `null` for "do not retry" and `{ gemmaMaxLength }` for "relaunch this
 * same job once with that budget". Exactly one retry is ever allowed: a second
 * watchdog abort at the reduced budget is a real failure the user must see, not
 * something to keep grinding the GPU over.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.signal]
 * @param {string} [opts.stderr]
 * @param {'active'|'done'|null} [opts.promptEncodePhase]
 * @param {number} [opts.retriesUsed] - retries already spent on this job
 * @param {string} [opts.platform] - `process.platform` of the host
 * @returns {{ gemmaMaxLength: number }|null}
 */
export function planPromptEncodingRetry({ signal = null, stderr = '', promptEncodePhase = null, retriesUsed = 0, platform = process.platform } = {}) {
  // The command-buffer watchdog is a macOS construct. A Windows/CUDA render
  // that somehow produced a matching string must not be relaunched with an
  // Apple-specific mitigation.
  if (platform !== 'darwin') return null;
  if (!Number.isInteger(retriesUsed) || retriesUsed > 0) return null;
  if (!isPromptEncodingMetalWatchdog({ signal, stderr, promptEncodePhase })) return null;
  return { gemmaMaxLength: RETRY_GEMMA_MAX_LENGTH };
}

/**
 * Whether a PortOS-fired SIGKILL should be treated as success rather than a
 * failure. Two Node-side watchdogs can SIGKILL a render:
 *   - the completion watchdog (armed after a completion marker, guards a
 *     post-completion teardown hang), and
 *   - the pre-output idle-stall deadline (fires when a render goes silent).
 * Either kill is a SUCCESS when a real output file is already on disk and
 * non-empty — e.g. a runtime that wrote its .mp4 but never printed a
 * recognized completion marker (so the completion watchdog never armed) and
 * then hung: the idle timer kills it, but the finished video must still be
 * kept, not discarded as "no output". A kill with no output on disk (a genuine
 * pre-output stall, or a marker from a malformed runtime that wrote nothing)
 * still fails loudly. `idleStallFired` defaults false so existing callers that
 * only track the completion watchdog keep their exact prior behavior.
 */
export function isWatchdogSuccess({ completionWatchdogFired, idleStallFired = false, signal, outputPath }) {
  return (completionWatchdogFired || idleStallFired) && signal === 'SIGKILL'
    && existsSync(outputPath) && statSync(outputPath).size > 0;
}

/**
 * Success path of generateVideo's `close` handler: faststart-optimize the
 * output, generate a thumbnail, prepend the history entry, and emit the
 * `complete` SSE frame + `completed` queue event. Mutates `job.status` to
 * 'complete'. Returns the thumbnail name.
 *
 * @param {object} ctx
 * @param {object} ctx.job
 * @param {string} ctx.jobId
 * @param {string} ctx.outputPath
 * @param {string} ctx.filename
 * @param {object} ctx.meta - the history-entry metadata built up-front
 * @param {number} ctx.actualSeed
 * @param {(mutator: (h: Array) => Array) => Promise<Array>} ctx.mutateHistory - serialized read-modify-write on the shared history file (mutateVideoHistory)
 * @param {number} [ctx.startedAtMs] - Date.now() captured just before the child
 *   spawned. Defaults to `job.renderStartedAtMs`, which generateVideo stamps.
 */
export async function finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta, actualSeed, mutateHistory, startedAtMs = job?.renderStartedAtMs }) {
  job.status = 'complete';
  await optimizeForStreaming(outputPath);
  const thumbnail = await generateThumbnail(outputPath, jobId);
  // Serialized append through the shared history tail so a concurrent write
  // path (a full-video download completing, another render finalizing) can't
  // read the same stale array and clobber this record on save.
  //
  // Persist the runtime fingerprint captured from the child's startup RUNTIME:
  // line (set on `job` by makeVideoGenLineHandler) so each history record
  // self-documents the exact ltx/mlx/torch + chip + OS stack it rendered on.
  // Absent (sentinel) when the runtime didn't emit one — e.g. the bare
  // `mlx_video.generate_av` path we don't control.
  //
  // Wall-clock render timing (#3801) is what makes a future render estimable:
  // videoGen/eta.js calibrates its cost model purely from these measurements.
  // Stamped ONLY when we actually observed the spawn instant — an entry with
  // no `renderMs` is an explicit absent sentinel that the estimator skips,
  // which is why the timing spread is conditional rather than defaulted to 0
  // (a zero-duration sample would drag every estimate toward "instant").
  // The window measured is spawn → output finalized, i.e. what the user waits
  // through, including the thumbnail/faststart tail above.
  const startMs = Number(startedAtMs);
  const timing = Number.isFinite(startMs) && startMs > 0
    ? {
      renderMs: Date.now() - startMs,
      renderStartedAt: new Date(startMs).toISOString(),
      renderCompletedAt: new Date().toISOString(),
    }
    : {};
  await mutateHistory((history) => {
    history.unshift({ ...meta, thumbnail, ...timing, ...(job.runtime ? { runtime: job.runtime } : {}) });
    return history;
  });
  console.log(`✅ Video generated [${jobId.slice(0, 8)}]: ${filename}`);
  broadcastSse(job, { type: 'complete', result: { filename, seed: actualSeed, thumbnail, path: `/data/videos/${filename}` } });
  videoGenEvents.emit('completed', { generationId: jobId, filename, path: `/data/videos/${filename}`, thumbnail });
  return thumbnail;
}
