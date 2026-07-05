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
        const vers = fp.versions && typeof fp.versions === 'object'
          ? Object.entries(fp.versions).map(([k, v]) => `${k} ${v}`).join(', ')
          : '';
        console.log(`🏷️ runtime [${jobId.slice(0, 8)}] ${fp.runtime || '?'}${vers ? ` | ${vers}` : ''}${fp.chip ? ` | ${fp.chip}` : ''}${fp.os ? ` | ${fp.os}` : ''}`);
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
        videoGenEvents.emit('progress', { generationId: jobId, progress: step / total, step, totalSteps: total, message: label || undefined });
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
      videoGenEvents.emit('progress', { generationId: jobId, progress: pct });
      return true;
    }
    return false;
  };
}

/**
 * Whether a watchdog-triggered SIGKILL should be treated as success: the
 * render emitted its completion marker (so the watchdog armed + fired) and
 * the output file is actually on disk and non-empty. A marker without a real
 * output (malformed runtime) still fails loudly.
 */
export function isWatchdogSuccess({ completionWatchdogFired, signal, outputPath }) {
  return completionWatchdogFired && signal === 'SIGKILL'
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
 */
export async function finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta, actualSeed, mutateHistory }) {
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
  await mutateHistory((history) => {
    history.unshift({ ...meta, thumbnail, ...(job.runtime ? { runtime: job.runtime } : {}) });
    return history;
  });
  console.log(`✅ Video generated [${jobId.slice(0, 8)}]: ${filename}`);
  broadcastSse(job, { type: 'complete', result: { filename, seed: actualSeed, thumbnail, path: `/data/videos/${filename}` } });
  videoGenEvents.emit('completed', { generationId: jobId, filename, path: `/data/videos/${filename}`, thumbnail });
  return thumbnail;
}
