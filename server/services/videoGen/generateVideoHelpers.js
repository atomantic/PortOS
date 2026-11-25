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
import { join } from 'path';
import { broadcastSse } from '../../lib/sseUtils.js';
import {
  generateThumbnail, optimizeForStreaming, probeFrameCount, probeVideoDuration,
} from '../../lib/ffmpeg.js';
import { formatBytes, PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { FINISHED_OUTPUT_ADMISSION_MS } from '../../lib/backupPublicationWait.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { renderTimingFields } from '../../lib/renderTiming.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { videoGenEvents } from './events.js';
import { extendMasterPath } from './extendMaster.js';

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
 * Boundary markers `scripts/ml/generate_ltx2.py` prints on stderr around the Gemma
 * prompt encode (`install_prompt_encode_markers`). Matched EXACTLY, never by
 * prefix — `STAGE:encode-prompt-done` starts with `STAGE:encode-prompt`, so a
 * `startsWith` test would read the end of the encode as its beginning.
 */
export const PROMPT_ENCODE_BEGIN_MARKER = 'STAGE:encode-prompt';
export const PROMPT_ENCODE_END_MARKER = 'STAGE:encode-prompt-done';

/**
 * A render status line goes out on BOTH wires, always: the videoGen job's own SSE stream, and
 * `videoGenEvents` for the mediaJobQueue dispatcher to forward to the page's stream (cloud lanes that
 * broadcast on one alone left the Video Gen page blank until completion). `frame` carries the message
 * and phase (and byte counts for a download line).
 */
function publishRenderStatus(job, jobId, frame) {
  broadcastSse(job, { type: 'status', ...frame });
  videoGenEvents.emit('status', { generationId: jobId, ...frame });
}

/**
 * Build the stdout/stderr line handler for one generation. Parses the python child's
 * STATUS:/STAGE:/DOWNLOAD:/tqdm protocol into SSE frames + queue-dispatcher events. Returns
 * `handleLine(raw)`: true when the line was recognized progress/noise to suppress from raw logging.
 *
 * @param {object} ctx
 * @param {object} ctx.job - the in-flight job record (broadcastSse target)
 * @param {string} ctx.jobId
 * @param {RegExp} ctx.pythonNoiseRe - lines to silently drop (PYTHON_NOISE_RE)
 */
export function makeVideoGenLineHandler({ job, jobId, pythonNoiseRe }) {
  // Phase tracking (download vs inference) so tqdm byte-count bars read as "Downloading model".
  let currentPhase = 'starting';
  let isDownloading = false;
  // History-calibrated wall-clock estimate for this render (#3801), stamped on
  // the job by generateVideo. Repeated on every progress frame so a client that
  // subscribed mid-render still learns it, and so the estimate can't be lost to
  // a missed `started` event. Omitted entirely when there is no estimate — an
  // absent key, never `etaMs: 0`, which a UI would render as "done".
  const etaField = () => (Number.isFinite(job?.etaMs) ? { etaMs: job.etaMs } : {});
  // Carries the phase the last STAGE: marker put us in — a bare STATUS line is
  // often the ONLY thing a runner emits for minutes at a time, so without the
  // phase it can only be shown as undifferentiated text.
  const emitStatus = (message, extra = {}) => publishRenderStatus(job, jobId, { message, phase: currentPhase, ...extra });

  return (raw) => {
    const line = raw.trim();
    if (!line) return true;
    if (pythonNoiseRe.test(line)) return true;
    // Runtime fingerprint emitted once at child startup (RUNTIME:<json> — see
    // scripts/ml/_runner_common.py emit_runtime_fingerprint). Stamp it onto the
    // job so finalizeGeneratedVideo can persist it on the history record, and
    // log a single self-documenting line so a render that produced garbled
    // output can be tied to a specific ltx/mlx/torch + chip + OS stack.
    if (line.startsWith(RUNTIME_LINE_PREFIX)) {
      const fp = parseRuntimeFingerprintLine(line);
      // Malformed fingerprint line — fall through to raw-logging so the
      // broken payload is visible rather than silently swallowed.
      if (!fp) return false;
      job.runtime = fp;
      console.log(`🏷️ runtime [${jobId.slice(0, 8)}] ${formatRuntimeFingerprint(fp) || '?'}`);
      return true;
    }
    // What the runner ACTUALLY applied of a requested speed profile
    // (SPEEDPROFILE:<json> — see scripts/ml/generate_ltx2.py). PortOS asks for a
    // schedule declaratively, but only the child can see whether the pinned
    // pipeline accepts `enable_teacache` and whether the distilled adapter is
    // in the pack; `degraded` names every lever it could not apply. Stamped on
    // the job so finalizeGeneratedVideo persists it, which is what keeps a
    // half-applied profile from reading back as a full speed claim.
    if (line.startsWith('SPEEDPROFILE:')) {
      try {
        const applied = JSON.parse(line.slice('SPEEDPROFILE:'.length));
        job.speedProfile = applied;
        const degraded = Array.isArray(applied?.degraded) ? applied.degraded : [];
        console.log(`⚡ speed profile [${jobId.slice(0, 8)}] ${applied?.id || '?'}${degraded.length ? ` — degraded: ${degraded.join(', ')}` : ''}`);
        return true;
      } catch {
        // Malformed payload — fall through to raw-logging so the broken line
        // is visible rather than silently swallowed (same as RUNTIME: above).
        return false;
      }
    }
    // What the runner ACTUALLY decoded with (DRAFTDECODE:<json> — see
    // scripts/ml/generate_minimax_h3.py). PortOS gates the substitution
    // declaratively, but only the child can see whether the pinned decoder
    // module tree accepts the asset's tensors; a load that fails there falls
    // back to the model's own decoder and reports `applied: false` with a
    // reason. Stamped on the job so finalizeGeneratedVideo persists it, which is
    // what keeps a full decode from reading back as a draft one.
    if (line.startsWith('DRAFTDECODE:')) {
      try {
        const applied = JSON.parse(line.slice('DRAFTDECODE:'.length));
        job.draftDecode = applied;
        console.log(`🩻 draft decode [${jobId.slice(0, 8)}] ${applied?.id || '?'} — ${applied?.applied ? 'applied' : `fell back to the full decoder (${applied?.reason || 'unknown'})`}`);
        return true;
      } catch {
        // Malformed payload — fall through to raw-logging so the broken line
        // is visible rather than silently swallowed (same as RUNTIME: above).
        return false;
      }
    }
    // What the runner ACTUALLY resolved for block streaming (STREAMPOLICY:<json>
    // — see scripts/ml/generate_ltx2.py#resolve_streaming_policy /
    // report_streaming_policy). `meta.streamingMode` on the history record is
    // the REQUEST; this is the outcome — whether the pinned pipeline even had
    // the parameter, whether physical memory put 'auto' over the streaming
    // threshold, and (when active) the render's peak MLX memory, so a claim
    // that a smaller machine can now render a given model is backed by a
    // number from an actual render. Stamped on the job so finalizeGeneratedVideo
    // persists it.
    if (line.startsWith('STREAMPOLICY:')) {
      try {
        const applied = JSON.parse(line.slice('STREAMPOLICY:'.length));
        job.streamingPolicy = applied;
        console.log(`📦 block streaming [${jobId.slice(0, 8)}] ${applied?.pipeline || '?'} — ${applied?.active ? `streaming${applied?.peakMb != null ? ` (peak ${applied.peakMb} MB)` : ''}` : `resident${applied?.reason ? ` (${applied.reason})` : ''}`}`);
        return true;
      } catch {
        // Malformed payload — fall through to raw-logging so the broken line
        // is visible rather than silently swallowed (same as RUNTIME: above).
        return false;
      }
    }
    if (line.startsWith(LORA_STRATEGY_LINE_PREFIX)) {
      const report = parseLoraStrategyLine(line);
      // Malformed payload — fall through to raw-logging (same as RUNTIME: above).
      if (!report) return false;
      job.loraStrategy = report;
      console.log(`🧩 LoRA strategy [${jobId.slice(0, 8)}] ${report.adapters.map((a) => `${a?.name || '?'}=${a?.strategy || '?'}`).join(', ')}`);
      return true;
    }
    // Heartbeat for the queue's idle watchdog (see imageGen/local.js).
    videoGenEvents.emit('activity', { generationId: jobId });
    if (line.startsWith('STATUS:')) {
      // Mirrored to videoGenEvents by emitStatus so the mediaJobQueue SSE
      // dispatcher forwards it to the client. Without that, only STAGE:
      // progress reaches the UI and long pre-render phases ("Loading
      // pipeline…", "Generating I2V…") display nothing.
      emitStatus(line.slice(7));
      return true;
    }
    if (line.startsWith('STAGE:')) {
      // Gemma prompt-encode boundary (scripts/ml/generate_ltx2.py). Stamped on the
      // job as a three-state phase — absent = this runner never reports one,
      // 'active' = encoding right now, 'done' = finished — so a later SIGABRT can
      // be attributed to the encode without conflating "never reported" with
      // "finished". Compared exactly: the '-done' marker is a prefix extension of
      // the begin marker. Used only to name the phase in the recovery status.
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
      // Normalize tag case because BYOV helpers are not required to agree on
      // capitalization.
      const tag = (parts[2] || '').toLowerCase();
      if (tag === 'heartbeat') {
        // Surface as a status message; the activity emit above already
        // resets the queue watchdog.
        emitStatus(`${parts[1]}: heartbeat ${parts[3] || ''}`);
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
        videoGenEvents.emit('progress', { generationId: jobId, progress: step / total, step, totalSteps: total, message: label || undefined, phase: currentPhase, ...etaField() });
        return true;
      }
      // Bare phase marker (e.g. STAGE:load-pipeline, STAGE:from-pretrained) —
      // surface as a status line. No progress %, no division-by-undefined.
      emitStatus(parts.slice(1).join(':'));
      return true;
    }
    if (line.startsWith('DOWNLOAD:')) {
      isDownloading = true;
      currentPhase = 'download';
      const rawText = line.slice(9);
      const byteInfo = parseByteProgress(rawText);
      // Include downloadedBytes/totalBytes for clients that want numeric progress.
      const bytes = {};
      if (byteInfo.downloaded != null) bytes.downloadedBytes = byteInfo.downloaded;
      if (byteInfo.total != null) bytes.totalBytes = byteInfo.total;
      emitStatus(formatDownloadMessage(rawText, byteInfo), bytes);
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
      videoGenEvents.emit('progress', { generationId: jobId, progress: pct, phase: currentPhase, ...etaField() });
      return true;
    }
    return false;
  };
}

/**
 * Version marker stamped on every history record written by this (finish-aware) writer. It is the
 * POSITIVE signal that the record's conditioning inventory is trustworthy: a legacy record (pre-#3696)
 * carries no `conditioning`, indistinguishable from "used none". The client's Finish gate must
 * require this marker so legacy records degrade to "not finishable".
 */
export const RENDER_INPUTS_VERSION = 1;

/**
 * Inventory the conditioning inputs one render actually used, as a sorted list of kind strings. An
 * empty array means the render was driven by prompt + seed + dials alone, i.e. reproducible from the
 * history record (the precondition for Finish, #3696). Records KINDS, not paths: staging paths are
 * machine-specific and history is user-facing. Pure; tolerates missing/`null` fields.
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

// The one-line protocol every helper script announces its stack on at startup
// (`scripts/ml/_runner_common.py emit_runtime_fingerprint`). Parsed here for the
// render path and the upscale job alike, so a payload-shape change has one
// consumer to update.
export const RUNTIME_LINE_PREFIX = 'RUNTIME:';

/**
 * The fingerprint object carried by a `RUNTIME:<json>` line, or null when the
 * line is not one or its payload is malformed — the caller decides whether a
 * broken payload is logged raw or dropped.
 * @param {string} line - one trimmed child-output line
 * @returns {object|null}
 */
export function parseRuntimeFingerprintLine(line) {
  if (typeof line !== 'string' || !line.startsWith(RUNTIME_LINE_PREFIX)) return null;
  try {
    const fp = JSON.parse(line.slice(RUNTIME_LINE_PREFIX.length));
    return fp && typeof fp === 'object' ? fp : null;
  } catch {
    return null;
  }
}

// How each LoRA adapter was applied (#12262): `scripts/ml/ltx_runtime_lora.py
// AdapterReport.emit`. A quantized pack can apply a delta at inference or merge
// and re-quantize it (which can erase most of it), so the record keeps the
// outcome beside the request. Shared by the render path and the upscale job.
export const LORA_STRATEGY_LINE_PREFIX = 'LORASTRATEGY:';

/**
 * The `{ adapters: [...] }` payload of a `LORASTRATEGY:<json>` line, or null
 * when the line is not one or its payload is malformed.
 * @param {string} line - one trimmed child-output line
 * @returns {{ adapters: object[] }|null}
 */
export function parseLoraStrategyLine(line) {
  if (typeof line !== 'string' || !line.startsWith(LORA_STRATEGY_LINE_PREFIX)) return null;
  try {
    const report = JSON.parse(line.slice(LORA_STRATEGY_LINE_PREFIX.length));
    return Array.isArray(report?.adapters) ? report : null;
  } catch {
    return null;
  }
}

/**
 * Render a runtime fingerprint (the helper script's `RUNTIME:` payload or the Node-side
 * `hostRuntimeFingerprint()` block) as one line:
 * `ltx2 | mlx 0.22.0, torch 2.5.1 | Apple M4 Max | macOS-15.4-arm64`. Pure; returns '' when nothing
 * is known.
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
// A common Apple Silicon abort is the macOS Metal command-buffer watchdog killing an over-long GPU
// buffer (`kIOGPUCommandBufferCallbackErrorImpactingInteractivity`), which MLX surfaces as SIGABRT
// (exit -6), not a Python assertion. A bare `Killed by signal SIGABRT` sends users hunting a model bug
// when the fix is less work per buffer, but only captured stderr can prove it (see abortCause); a bare
// SIGABRT is reported as an unexplained native abort. SIGBUS/SIGSEGV are the other native-crash
// arrivals. SIGKILL stays the OOM message.
//
// Keys are the signal NAMES Node reports on `close` (spawnDetached decodes 128+signum).
//
// The LoRA-trainer mitigation ("let the display sleep") is NOT offered: generateVideo holds a
// `caffeinate -dis` assertion for the child's lifetime, so display sleep is impossible by
// construction. Running headless still works, so that is what we point at.
const nativeCrashCause = (signal) => `Render crashed (${signal}) — a native fault inside the MLX/Metal layer, not a PortOS-level error. Retry with a lower resolution/frame count; if it repeats on the same model, reinstall that runtime from Settings → Video (a mismatched mlx / mlx-metal pair in the venv is the usual cause).`;

const SIGNAL_DEATH_CAUSES = Object.freeze({
  SIGKILL: 'Process killed (likely out of memory — try a smaller model or resolution)',
  // SIGABRT is evidence-dependent — see abortCause.
  SIGBUS: nativeCrashCause('SIGBUS'),
  SIGSEGV: nativeCrashCause('SIGSEGV'),
});

const WATCHDOG_ABORT_CAUSE = 'Render aborted (SIGABRT) — the macOS Metal command-buffer watchdog killed an over-long GPU command buffer (kIOGPUCommandBufferCallbackErrorImpactingInteractivity), not a bug in the model or PortOS. Lower the resolution and/or frame count so each command buffer does less work, and quit other GPU-heavy apps so the render is not competing for the GPU with WindowServer compositing (driving this machine headless over SSH avoids that contention entirely).';
const OOM_ABORT_CAUSE = 'Render aborted (SIGABRT) — Metal reported the GPU ran out of memory. Try a smaller model, resolution or frame count.';
const VICTIM_ABORT_CAUSE = 'Render aborted (SIGABRT) — Metal reported this render was an innocent victim of another process wedging the GPU. Retry once other GPU-heavy apps are closed.';
const ASSERTION_ABORT_CAUSE = 'Render aborted (SIGABRT) — the native layer hit a failed assertion. See the runtime log for the assertion text.';
const UNEXPLAINED_ABORT_CAUSE = 'Render aborted (SIGABRT) — a native abort with no diagnostic line captured, so the cause is unknown. Check the runtime log; retrying at a lower resolution/frame count may help.';
const NATIVE_ASSERTION_RE = /\bassertion\b.*\bfailed\b|\bfailed\b.*\bassertion\b|__assert_rtn|Assertion`/i;

// Classify from the child's ORIGINAL stderr, before any explanatory text exists, so an enum name
// quoted in our own advice can never act as proof. Same regexes that gate retry eligibility.
function abortCause(stderr, { platform, arch, mlxRuntime }) {
  const text = typeof stderr === 'string' ? stderr : '';
  if (/kIOGPUCommandBufferCallbackErrorOutOfMemory/i.test(text)) return OOM_ABORT_CAUSE;
  if (/kIOGPUCommandBufferCallbackErrorInnocentVictim/i.test(text)) return VICTIM_ABORT_CAUSE;
  if (METAL_WATCHDOG_RE.test(text) && isAppleSilicon({ platform, arch }) && mlxRuntime) return WATCHDOG_ABORT_CAUSE;
  if (NATIVE_ASSERTION_RE.test(text)) return ASSERTION_ABORT_CAUSE;
  return UNEXPLAINED_ABORT_CAUSE;
}

/**
 * Failure reason for a render child that exited on a signal. Pure. Unmapped signals keep the
 * `Killed by signal <SIG>` wording. SIGABRT is explained only from captured evidence: the Metal
 * watchdog is named solely for a recognised timeout/interactivity signature on an Apple-silicon MLX
 * runtime; otherwise OOM, innocent-victim, assertion or a generic unexplained abort. The resolved
 * runtime fingerprint is appended when known.
 *
 * @param {string|null} signal - signal name from `proc.on('close', (code, signal))`
 * @param {object} [opts]
 * @param {object|null} [opts.fingerprint] - runtime fingerprint (see `pickDeathFingerprint` in runtimes.js)
 * @param {string} [opts.stderr] - captured stderr tail of the dead child (original evidence)
 * @param {boolean} [opts.mlxRuntime] - whether the render ran on an MLX runtime
 * @returns {string|null} reason, or null when the child did not die on a signal
 */
export function describeSignalDeath(signal, { fingerprint = null, stderr = '', mlxRuntime = false, platform = process.platform, arch = process.arch } = {}) {
  if (!signal) return null;
  const cause = signal === 'SIGABRT'
    ? abortCause(stderr, { platform, arch, mlxRuntime })
    : SIGNAL_DEATH_CAUSES[signal] || `Killed by signal ${signal}`;
  const fp = formatRuntimeFingerprint(fingerprint);
  return fp ? `${cause} [runtime: ${fp}]` : cause;
}

// The Metal watchdog reports WHY it killed a buffer via a `kIOGPUCommandBufferCallbackError*` enum
// name. Two mean "this buffer ran too long", which a smaller prompt-encode buffer fixes:
//   - ...ErrorTimeout                — the classic signature
//   - ...ErrorImpactingInteractivity — newer Apple silicon / macOS report this instead
// MLX also surfaces the timeout in prose ("Caused GPU Timeout Error"), accepted too.
const METAL_WATCHDOG_RE = /kIOGPUCommandBufferCallbackError(?:Timeout|ImpactingInteractivity)|Caused GPU Timeout Error/i;
// Two must NOT arm it: an out-of-memory abort (a shorter prompt does not fix it and a retry burns
// another model load), and an innocent victim (another process wedged the GPU). Either name anywhere
// in the captured text vetoes the retry even alongside a timeout, where the timeout is a symptom.
const METAL_WATCHDOG_VETO_RE = /kIOGPUCommandBufferCallbackError(?:OutOfMemory|InnocentVictim)/i;

/**
 * Whether a render child died to the Metal watchdog WHILE the Gemma prompt encoder was running. Pure.
 *
 * `promptEncodePhase` is a three-state sentinel:
 *   - `null`     — no encode boundary reported (every runtime except the LTX-2 MLX helper), so an
 *                  unreported phase is never mistaken for a live encode.
 *   - `'active'` — the encode began and never finished: the ONLY qualifying state.
 *   - `'done'`   — the encode finished; a later abort is a denoise/decode failure a shorter prompt
 *                  cannot fix.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.signal] - signal name from `proc.on('close')`
 * @param {string} [opts.stderr] - captured stderr tail from the dead child
 * @param {'active'|'done'|null} [opts.promptEncodePhase]
 * @returns {boolean}
 */
export function isPromptEncodingMetalWatchdog({ signal = null, stderr = '', promptEncodePhase = null } = {}) {
  // The Metal layer's C++ exception is turned into SIGABRT by terminate(); never a clean non-zero exit.
  if (signal !== 'SIGABRT') return false;
  if (promptEncodePhase !== 'active') return false;
  const text = typeof stderr === 'string' ? stderr : '';
  if (METAL_WATCHDOG_VETO_RE.test(text)) return false;
  return METAL_WATCHDOG_RE.test(text);
}

/**
 * Per-command-buffer caps MLX reads at startup (`MLX_MAX_OPS_PER_BUFFER` /
 * `MLX_MAX_MB_PER_BUFFER`). Smaller values only move command-buffer boundaries —
 * same kernels, same output, slightly slower — so each buffer finishes inside the
 * macOS GPU watchdog window. Applied reactively on a retry, never by default.
 */
export const METAL_BUFFER_RETRY_ENV = Object.freeze({
  MLX_MAX_OPS_PER_BUFFER: '4',
  MLX_MAX_MB_PER_BUFFER: '16',
});

/**
 * Decide whether a render may be relaunched once with tiny MLX command buffers after a Metal watchdog
 * abort ANYWHERE in the render, including the Gemma prompt encoder. The prompt token sequence is never
 * shortened to recover: the encoder keeps only the LAST max_length tokens, so that would silently drop
 * the start of an accepted prompt. Pure — returns the plan. Apple-silicon MLX only; OutOfMemory /
 * InnocentVictim aborts never qualify. One retry per job.
 *
 * @returns {{ env: Record<string, string> }|null}
 */
export function planMetalBufferRetry({ signal = null, stderr = '', retriesUsed = 0, platform = process.platform, arch = process.arch, mlxRuntime = false } = {}) {
  if (!isAppleSilicon({ platform, arch }) || !mlxRuntime) return null;
  if (!Number.isInteger(retriesUsed) || retriesUsed > 0) return null;
  if (signal !== 'SIGABRT') return null;
  const text = typeof stderr === 'string' ? stderr : '';
  if (METAL_WATCHDOG_VETO_RE.test(text) || !METAL_WATCHDOG_RE.test(text)) return null;
  return { env: { ...METAL_BUFFER_RETRY_ENV } };
}

/**
 * Whether a PortOS-fired completion-watchdog SIGKILL should be treated as success: the watchdog only
 * guards a post-completion teardown hang, so it is a SUCCESS when a real, non-empty output is on disk.
 */
export function isWatchdogSuccess({ completionWatchdogFired, signal, outputPath }) {
  return completionWatchdogFired && signal === 'SIGKILL'
    && existsSync(outputPath) && statSync(outputPath).size > 0;
}

// ── verified post-completion native teardown abort (#6501) ──
//
// The MiniMax H3 MLX runner can finish, mux the clip and print the `emit_result` completion contract
// (scripts/ml/_minimax_h3_common.py), THEN abort inside native interpreter teardown. The clip is complete;
// unrecognized, it is absent from history and counts toward the media queue's repeated-failure hold.
//
// This is the narrowest possible recovery, NOT a general "the file looks fine" rule: an ordinary
// nonzero exit, missing module, idle timeout, user cancel, truncated clip and pre-completion crash all
// keep failing.

/**
 * The single runtime this recovery covers. `minimax_h3_cuda` and `minimax_h3_ref2va` lack the MLX
 * teardown fault and are excluded by construction, not by an allowlist that could drift open.
 */
export const POST_COMPLETION_ABORT_RUNTIME = 'minimax_h3';

/**
 * Signals that can carry a native-interpreter teardown abort. SIGABRT only: a bare nonzero exit is an
 * ordinary failure, SIGKILL belongs to the completion watchdog/OOM killer, and SIGSEGV/SIGBUS are real
 * native crashes that can happen mid-render.
 */
const NATIVE_TEARDOWN_SIGNALS = new Set(['SIGABRT']);

/**
 * The cheap synchronous gate: does this child's death even LOOK like the H3 MLX teardown abort?
 * Runs before the async ffprobe verification so an ordinary failure never pays for a probe.
 * `childKilled` is `proc.killed` (PortOS asked it to die: cancel or watchdog); a death we caused is
 * never a spontaneous teardown abort, whatever signal it landed on.
 *
 * @param {object} opts
 * @param {string} [opts.runtime] - the render model's runtime id
 * @param {string|null} [opts.signal] - the signal from the child's 'close'
 * @param {boolean} [opts.childKilled] - `proc.killed`
 * @param {string} [opts.platform] - `process.platform` of the host
 * @returns {boolean}
 */
export function isNativeTeardownAbort({ runtime = null, signal = null, childKilled = false, platform = process.platform } = {}) {
  // MLX is Apple-Silicon only; another host reporting it is a misconfiguration.
  if (platform !== 'darwin') return false;
  if (runtime !== POST_COMPLETION_ABORT_RUNTIME) return false;
  if (childKilled) return false;
  return NATIVE_TEARDOWN_SIGNALS.has(signal);
}

// Whole-second mtime filesystems can stamp a file written just after spawn with the prior second;
// one second of slack absorbs that while a stale earlier output is minutes old.
const OUTPUT_MTIME_SLACK_MS = 1000;

// The muxer can round a stream's length by a frame or two and container duration with audio is not
// exactly frames/fps. Both tolerances stay tight: the probe exists to reject a TRUNCATED clip.
const frameTolerance = (expectedFrames) => Math.max(2, Math.ceil(expectedFrames * 0.02));
const durationToleranceSeconds = (expectedSeconds) => Math.max(0.25, expectedSeconds * 0.05);

/**
 * Verify that a post-completion abort really did leave the requested render on disk. Every check
 * must pass; each returns the reason it did not so the caller can log why the abort stayed a failure.
 *
 * In order of cost:
 *   1. This child reported EVERY expected output by exact path (collected per child, so a stray
 *      sentence, unrelated path or previous child's result cannot satisfy it).
 *   2. The request is measurable (start time, frames, rate); missing any is a refusal, never a pass.
 *   3. Each file exists, is non-empty, and was written AFTER this render started.
 *   4. ffprobe reads a frame count and duration consistent with the request. A probe that could not
 *      answer (`null`) refuses recovery; it never collapses into "consistent".
 *
 * @param {object} ctx
 * @param {string[]} ctx.outputPaths - every file this render was asked to write
 * @param {Set<string>} ctx.completedOutputs - paths THIS child reported done
 * @param {number} ctx.startedAtMs - Date.now() stamped just before the spawn
 * @param {number} ctx.expectedFrames - frames the request asked for
 * @param {number} ctx.fps - frame rate the request asked for
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function verifyPostCompletionOutputs({ outputPaths, completedOutputs, startedAtMs, expectedFrames, fps }) {
  if (!Array.isArray(outputPaths) || outputPaths.length === 0) {
    return { ok: false, reason: 'the render declared no expected output' };
  }
  const reported = completedOutputs instanceof Set ? completedOutputs : new Set();
  const unreported = outputPaths.filter((path) => !reported.has(path)).length;
  if (unreported > 0) {
    return { ok: false, reason: `${unreported}/${outputPaths.length} expected outputs were never reported complete by this child` };
  }
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
    return { ok: false, reason: 'the render start time was not recorded' };
  }
  if (!Number.isFinite(expectedFrames) || expectedFrames <= 0 || !Number.isFinite(fps) || fps <= 0) {
    return { ok: false, reason: 'the requested frame count or frame rate is unknown' };
  }
  const expectedSeconds = expectedFrames / fps;
  for (const [index, outputPath] of outputPaths.entries()) {
    const label = outputPaths.length > 1 ? `output ${index + 1}/${outputPaths.length}` : 'the output';
    if (!existsSync(outputPath)) return { ok: false, reason: `${label} is not on disk` };
    let stats;
    // The file can be unlinked between the existsSync above and this stat
    // (cleanup, an external move), and this runs from a child 'close' handler
    // where an uncaught throw would take the process with it.
    try {
      stats = statSync(outputPath);
    } catch (err) {
      return { ok: false, reason: `${label} could not be read: ${err.message}` };
    }
    if (!(stats?.size > 0)) return { ok: false, reason: `${label} is empty` };
    if (!Number.isFinite(stats.mtimeMs) || stats.mtimeMs < startedAtMs - OUTPUT_MTIME_SLACK_MS) {
      return { ok: false, reason: `${label} predates this render` };
    }
    const frames = await probeFrameCount(outputPath);
    if (!Number.isFinite(frames)) return { ok: false, reason: `${label} could not be probed for frames` };
    if (Math.abs(frames - expectedFrames) > frameTolerance(expectedFrames)) {
      return { ok: false, reason: `${label} carries ${frames} frames, not the ${expectedFrames} requested` };
    }
    const seconds = await probeVideoDuration(outputPath);
    if (!Number.isFinite(seconds)) return { ok: false, reason: `${label} could not be probed for duration` };
    if (Math.abs(seconds - expectedSeconds) > durationToleranceSeconds(expectedSeconds)) {
      return { ok: false, reason: `${label} runs ${seconds.toFixed(2)}s, not the ${expectedSeconds.toFixed(2)}s requested` };
    }
  }
  return { ok: true };
}

/**
 * Hold a freshly spawned render child's terminal event until its real handlers are wired (#4617).
 *
 * `spawnDetached` defers its first emission to a `setImmediate`, but generateVideo must first hand the
 * accelerator claim to the child's PID (real file I/O). A child dying in that window emits with nobody
 * listening: a lost 'close' leaves the job `running` forever holding the claim, and a lost 'error'
 * THROWS (no listener), taking the server down outside the request lifecycle.
 *
 * Attach in the SAME tick the spawn resolved. It returns a `take()` that detaches these listeners and
 * hands back the first terminal event seen, or `null` while the child is alive; call it immediately
 * before the real listeners go on, with no await between. Leaving it attached is also valid for an
 * abandoned child: a harmless sink that keeps an 'error' from going unhandled.
 */
export function bufferChildExit(proc, { bufferOutput = false } = {}) {
  let buffered = null;
  const output = [];
  const onClose = (code, signal) => { buffered = buffered || { type: 'close', code, signal }; };
  const onError = (error) => { buffered = buffered || { type: 'error', error }; };
  const onStdout = (chunk) => output.push({ stream: 'stdout', chunk });
  const onStderr = (chunk) => output.push({ stream: 'stderr', chunk });
  onStdout.__earlyBuffer = true;
  onStderr.__earlyBuffer = true;
  proc.on('close', onClose);
  proc.on('error', onError);
  if (bufferOutput) {
    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
  }
  return () => {
    proc.off?.('close', onClose);
    proc.off?.('error', onError);
    if (bufferOutput) {
      proc.stdout?.off?.('data', onStdout);
      proc.stderr?.off?.('data', onStderr);
    }
    if (!buffered && output.length === 0) return null;
    return output.length ? { ...(buffered || { type: 'output' }), output } : buffered;
  };
}

// Only fresh, unreferenced outputs belong here; callers keep the publication latch so a later
// notification failure never sends committed bytes to cleanup.
export async function discardUnpublishedVideo({ jobId, outputPath }) {
  return withBackupAssetPublication(async () => {
    const results = await Promise.allSettled([
      outputPath, `${outputPath}.fs.mp4`, join(PATHS.videoThumbnails, `${jobId}.jpg`),
      extendMasterPath(outputPath),
    ].filter(Boolean).map(path => unlinkGuarded(path)));
    const failed = results.find(result => result.status === 'rejected' && result.reason?.code !== 'ENOENT');
    if (failed) throw failed.reason;
  });
}

/**
 * Success path of generateVideo's `close` handler: faststart-optimize the output, generate a
 * thumbnail, prepend the history entry, emit `complete` SSE + `completed` queue event. Mutates
 * `job.status`. Returns the thumbnail name.
 *
 * @param {object} ctx
 * @param {object} ctx.job
 * @param {string} ctx.jobId
 * @param {string} ctx.outputPath
 * @param {string} ctx.filename
 * @param {object} ctx.meta - the history-entry metadata built up-front
 * @param {number} ctx.actualSeed
 * @param {(mutator: (h: Array) => Array) => Promise<Array>} ctx.mutateHistory - serialized read-modify-write on the shared history file (mutateVideoHistory)
 * @param {boolean} [ctx.terminal=true] - False persists a batch member without completing its queue job.
 * @param {object} [ctx.publication] - Caller latch; committed is set before notifications.
 * @param {number} [ctx.startedAtMs] - Date.now() captured just before the child
 *   spawned. Defaults to `job.renderStartedAtMs`, which generateVideo stamps.
 */
export async function finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta, actualSeed, mutateHistory, startedAtMs = job?.renderStartedAtMs, terminal = true, publication = {} }) {
  // The render already exists, so a backup cut holding admission is a pause, not a failure; heartbeat
  // so the queue watchdog never reaps a finished clip as idle.
  const waitForBackup = () => {
    const message = 'Waiting for the backup to finish before saving the video';
    videoGenEvents.emit('activity', { generationId: jobId });
    broadcastSse(job, { type: 'status', message });
    videoGenEvents.emit('status', { generationId: jobId, message });
  };
  const thumbnail = await withBackupAssetPublication(async () => {
    try {
      await optimizeForStreaming(outputPath);
      const thumbnail = await generateThumbnail(outputPath, jobId);
      // ffmpeg may leave a partial poster even when it returns no thumbnail.
      if (!thumbnail) await unlinkGuarded(join(PATHS.videoThumbnails, `${jobId}.jpg`)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      // Serialized append through the shared history tail so a concurrent writer can't clobber this
      // record from a stale array.
      //
      // Persist the runtime fingerprint from the child's startup RUNTIME: line (set on `job` by
      // makeVideoGenLineHandler); absent when the runtime emitted none (the bare `mlx_video.generate_av`).
      //
      // Wall-clock render timing (#3801) calibrates videoGen/eta.js. Stamped ONLY when we observed the
      // spawn instant: an entry with no `renderMs` is an absent sentinel the estimator skips, so the
      // spread is conditional (a zero sample would drag estimates toward "instant"). It spans spawn →
      // output finalized, including the thumbnail/faststart tail above.
      const timing = renderTimingFields(startedAtMs);
      await mutateHistory((history) => {
        history.unshift({
          ...meta,
          thumbnail,
          ...timing,
          ...(job.runtime ? { runtime: job.runtime } : {}),
          ...(job.metalBufferPolicy ? { metalBufferPolicy: job.metalBufferPolicy } : {}),
          // What the speed profile actually resolved to at render time (#4875).
          // `meta.speedProfileId` above is the REQUEST; this is the outcome, so a
          // render whose TeaCache or distilled adapter was unavailable reads back
          // as degraded instead of as a full speed claim. Absent on every quality
          // render and on runners that don't report one.
          ...(job.speedProfile ? { speedProfileApplied: job.speedProfile } : {}),
          // Whether the draft decoder actually decoded this clip (#5423).
          // `meta.draftDecode` above is the REQUEST that survived every server-side
          // gate; this is the outcome, so a render whose decoder failed to load
          // reads back as a full decode instead of claiming a draft one. Absent on
          // every full-decode render and on runners that don't report one.
          ...(job.draftDecode ? { draftDecodeApplied: job.draftDecode } : {}),
          // What block streaming actually resolved to at render time (#6499).
          // `meta.streamingMode` above is the REQUEST; this is the outcome —
          // whether the pinned pipeline had the parameter, the RAM-based 'auto'
          // decision, and (when active) the render's peak MLX memory. Absent on
          // a resident-by-default render and on runners that don't report one.
          ...(job.streamingPolicy ? { streamingPolicyApplied: job.streamingPolicy } : {}),
          // How each LoRA adapter was actually applied (#12262) — at inference
          // beside the packed weights or fused into float ones, resident or
          // block-streamed (#12327). Absent on adapter-free renders.
          ...(job.loraStrategy ? { loraStrategyApplied: job.loraStrategy } : {}),
        });
        return history;
      });
      publication.committed = true;
      return thumbnail;
    } catch (error) {
      await discardUnpublishedVideo({ jobId, outputPath });
      throw error;
    }
  }, { timeoutMs: FINISHED_OUTPUT_ADMISSION_MS, onWait: waitForBackup });
  if (terminal) job.status = 'complete';
  console.log(`✅ Video generated [${jobId.slice(0, 8)}]: ${filename}`);
  if (terminal) {
    broadcastSse(job, { type: 'complete', result: { filename, seed: actualSeed, thumbnail, path: `/data/videos/${filename}` } });
    // A storyboard-guided clip's kept first frame rides along so its Music Video take can file it (grok.js).
    videoGenEvents.emit('completed', { generationId: jobId, filename, path: `/data/videos/${filename}`, thumbnail,
      ...(meta?.firstFrameFile ? { firstFrameFile: meta.firstFrameFile } : {}) });
  }
  return thumbnail;
}

/**
 * The three phases a render owned by an external provider API (Grok, fal.ai,
 * reactor.inc) actually passes through as far as THIS machine can see. The
 * provider holds the weights and runs the sampler, so none of the local
 * `STAGE:` vocabulary applies; the client's `videoRenderPhase.js` maps these
 * ids onto its short provider step ladder.
 */
export const CLOUD_RENDER_PHASE = Object.freeze({
  /** Handing the job over: runtime prep, auth, the submit call, the provider's own queue. */
  SUBMIT: 'submit',
  /** The provider is rendering. */
  RENDER: 'render',
  /** Pulling the finished clip back onto this machine. */
  FETCH: 'fetch',
});

/**
 * Publish a cloud-lane status line (publishRenderStatus above owns the two
 * wires it lands on) plus the heartbeat the queue watchdog reads.
 *
 * The `activity` heartbeat fires on EVERY call, unconditionally: it is what
 * keeps the queue watchdog from reaping a provider render that is slow rather
 * than stuck, and these lanes call this on every stdout chunk (grok) and every
 * poll tick (fal) precisely because that IS the evidence of life. The line
 * itself is only re-published when it changed — the same prose repeated every
 * two seconds tells the user nothing and churns the queue's debounced persist.
 */
export function emitCloudRenderStatus(job, jobId, phase, message) {
  videoGenEvents.emit('activity', { generationId: jobId });
  const line = `${phase}:${message}`;
  if (job.cloudStatusLine === line) return;
  job.cloudStatusLine = line;
  publishRenderStatus(job, jobId, { message, phase });
}
