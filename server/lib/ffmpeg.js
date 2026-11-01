/**
 * Shared ffmpeg helpers used by both videoGen and videoTimeline services.
 *
 * Keeps a single ffmpeg-binary discovery path and the streaming/thumbnail
 * primitives in one place so the two services can't drift on quoting,
 * caching, or rename-safety semantics.
 */

import { execFile, spawn } from './childProcess.js';
import { existsSync, statSync } from 'fs';
import { unlink, rename, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve as resolvePath, sep as PATH_SEP, dirname } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { ensureDir, PATHS } from './fileUtils.js';
import { safeChildProcessOptions, whichFirst } from './processEnv.js';

const execFileAsync = promisify(execFile);
const isWindows = () => process.platform === 'win32';
const IS_WIN = process.platform === 'win32';

// Validate that a sidecar/history-supplied filename is a safe basename under
// the expected directory — guards against tampered history entries with
// path-traversal segments (`../etc/passwd`) leaking into ffmpeg or unlink.
export const safeUnder = (root, name) => {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const rootResolved = resolvePath(root) + PATH_SEP;
  const fullPath = resolvePath(join(root, name));
  return fullPath.startsWith(rootResolved) ? fullPath : null;
};

// Cached encoder capabilities keyed by normalized binary path:
// Map<string, { identityKey: string, encoders: Set<string> }>
const encoderCapabilityCache = new Map();

let cachedFfmpegPath;
let testPlatformCandidates = null;

/** Test hook: override platform candidate paths for isolated testing. */
export const __setPlatformCandidatesForTest = (candidates) => {
  testPlatformCandidates = Array.isArray(candidates) ? [...candidates] : null;
};

/**
 * Reset ffmpeg discovery and capability caches.
 * Allows newly-installed binaries or in-place upgrades to be recognized without server restart.
 */
export const resetFfmpegCache = () => {
  cachedFfmpegPath = undefined;
  cachedFfprobePath = undefined;
  encoderCapabilityCache.clear();
  testPlatformCandidates = null;
};
export const __resetFfmpegCache = resetFfmpegCache;
export const _probeEncoderCapability = (...args) => probeEncoderCapability(...args);
export const _enumerateFfmpegCandidates = () => enumerateFfmpegCandidates();

/**
 * Probe a candidate ffmpeg executable for supported encoders.
 * Distinguishes supported, unsupported, and inconclusive results.
 * Caches successful capability evidence against binary identity (path + mtimeMs + size + ino).
 * Inconclusive results (probe failure / timeout) are NEVER cached.
 *
 * @param {string} bin
 * @param {string} requiredEncoder
 * @returns {Promise<{ supported: boolean, inconclusive: boolean, timedOut?: boolean, reason?: string, fromCache?: boolean }>}
 */
async function probeEncoderCapability(bin, requiredEncoder, { timeoutMs = 5000 } = {}) {
  if (!bin || typeof bin !== 'string') {
    return { supported: false, inconclusive: false, reason: 'invalid binary' };
  }
  const win = isWindows();
  const binKey = win ? resolvePath(bin).toLowerCase() : resolvePath(bin);

  let st;
  try {
    st = statSync(bin);
  } catch (err) {
    return { supported: false, inconclusive: false, reason: `binary inaccessible: ${err.message}` };
  }

  const identityKey = `${binKey}:${st.mtimeMs}:${st.size}:${st.ino}`;
  const cached = encoderCapabilityCache.get(binKey);
  if (cached && cached.identityKey === identityKey) {
    const supported = cached.encoders.has(requiredEncoder.toLowerCase());
    return { supported, inconclusive: false, fromCache: true };
  }

  let stdout;
  try {
    const res = await execFileAsync(bin, ['-hide_banner', '-encoders'], safeChildProcessOptions({
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }));
    stdout = String(res?.stdout || '');
  } catch (err) {
    const isTimeout = Boolean(err.killed || err.code === 'ETIMEDOUT' || /timed\s*out/i.test(String(err.message || '')));
    return {
      supported: false,
      inconclusive: true,
      timedOut: isTimeout,
      reason: isTimeout ? 'probe timed out' : `probe failed: ${err.message}`,
      fromCache: false,
    };
  }

  const encoders = new Set();
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*[a-zA-Z.]{6}\s+([a-zA-Z0-9_-]+)/);
    if (match) {
      encoders.add(match[1].toLowerCase());
    }
  }

  // Cache successful capability evidence against binary identity
  encoderCapabilityCache.set(binKey, { identityKey, encoders });

  const supported = encoders.has(requiredEncoder.toLowerCase());
  return { supported, inconclusive: false, fromCache: false };
}

/**
 * Enumerate potential ffmpeg candidates in existing precedence order:
 * 1. Fixed platform candidate paths (Windows or POSIX)
 * 2. PATH resolution via whichFirst('ffmpeg')
 * 3. Any additional candidates in PATH directories
 * Deduplicated by normalized path.
 */
async function enumerateFfmpegCandidates() {
  if (testPlatformCandidates) return [...testPlatformCandidates];
  const win = isWindows();
  const platformCandidates = win
    ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
    : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

  const candidates = [];
  const seen = new Set();

  const addCandidate = (p) => {
    if (!p || typeof p !== 'string') return;
    const key = win ? resolvePath(p).toLowerCase() : resolvePath(p);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(p);
    }
  };

  for (const c of platformCandidates) addCandidate(c);

  const whichHit = await whichFirst('ffmpeg').catch(() => null);
  if (whichHit) addCandidate(whichHit);

  const pathVal = process.env.PATH || '';
  const delimiter = win ? ';' : ':';
  const dirs = pathVal.split(delimiter).filter(Boolean);
  const exeName = win ? 'ffmpeg.exe' : 'ffmpeg';
  for (const rawDir of dirs) {
    const dir = rawDir.replace(/^"(.*)"$/, '$1');
    addCandidate(join(dir, exeName));
  }

  return candidates;
}

/**
 * Discover an ffmpeg binary on the host.
 *
 * When `requiredEncoder` is omitted:
 * Chooses the first existing platform candidate, falling back to PATH.
 * Free for decoding, audio and copy-only callers without imposing codec requirements.
 *
 * When `requiredEncoder` is specified:
 * Probes candidates in precedence order and selects the first one whose encoder listing
 * contains the requested codec.
 * If no candidate satisfies the requirement, yields an actionable prerequisite error:
 * - 'ffmpeg not found on PATH' if no ffmpeg binary exists
 * - 'ffmpeg build does not support required encoder: <codec>' if inspected binaries lack the codec
 * - 'ffmpeg encoder capability probe timed out' / 'probe failed' if an inconclusive probe occurred
 *
 * @param {{ requiredEncoder?: string }} [options]
 * @returns {Promise<string|null>}
 */
export const findFfmpeg = async ({ requiredEncoder, timeoutMs = 5000, candidates: customCandidates } = {}) => {
  const candidatesList = customCandidates || (testPlatformCandidates ? [...testPlatformCandidates] : null);
  const win = isWindows();
  const platformCandidates = testPlatformCandidates || (win
    ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
    : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);

  if (!requiredEncoder) {
    if (candidatesList) {
      for (const p of candidatesList) {
        if (existsSync(p)) return p;
      }
      return null;
    }

    if (cachedFfmpegPath && existsSync(cachedFfmpegPath)) {
      let hasHigherPriority = false;
      const cachedKey = win ? resolvePath(cachedFfmpegPath).toLowerCase() : resolvePath(cachedFfmpegPath);
      for (const p of platformCandidates) {
        const pKey = win ? resolvePath(p).toLowerCase() : resolvePath(p);
        if (pKey === cachedKey) break;
        if (existsSync(p)) {
          hasHigherPriority = true;
          cachedFfmpegPath = p;
          return p;
        }
      }
      if (!hasHigherPriority) return cachedFfmpegPath;
    }

    for (const p of platformCandidates) {
      if (existsSync(p)) {
        cachedFfmpegPath = p;
        return p;
      }
    }

    const found = await whichFirst('ffmpeg').catch(() => null);
    if (found && existsSync(found)) {
      cachedFfmpegPath = found;
      return found;
    }

    const pathVal = process.env.PATH || '';
    const delimiter = win ? ';' : ':';
    const dirs = pathVal.split(delimiter).filter(Boolean);
    const exeName = win ? 'ffmpeg.exe' : 'ffmpeg';
    for (const rawDir of dirs) {
      const dir = rawDir.replace(/^"(.*)"$/, '$1');
      const candidate = join(dir, exeName);
      if (existsSync(candidate)) {
        cachedFfmpegPath = candidate;
        return candidate;
      }
    }

    cachedFfmpegPath = undefined;
    return null;
  }

  const reqEnc = String(requiredEncoder).trim();
  const candidates = candidatesList || await enumerateFfmpegCandidates();

  let inconclusiveFailure = null;
  let existingCandidateCount = 0;
  const inspected = [];

  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    existingCandidateCount++;
    inspected.push(bin);

    const probe = await probeEncoderCapability(bin, reqEnc, { timeoutMs });
    if (probe.supported) {
      return bin;
    }
    if (probe.inconclusive && !inconclusiveFailure) {
      inconclusiveFailure = probe;
    }
  }

  if (existingCandidateCount === 0) {
    throw Object.assign(new Error('ffmpeg not found on PATH'), { code: 'FFMPEG_MISSING' });
  }

  if (inconclusiveFailure) {
    const msg = inconclusiveFailure.timedOut
      ? 'ffmpeg encoder capability probe timed out'
      : `ffmpeg encoder capability probe failed: ${inconclusiveFailure.reason}`;
    throw Object.assign(new Error(msg), {
      code: inconclusiveFailure.timedOut ? 'FFMPEG_PROBE_TIMED_OUT' : 'FFMPEG_PROBE_FAILED',
      details: inconclusiveFailure,
    });
  }

  throw Object.assign(new Error(`ffmpeg build does not support required encoder: ${reqEnc}`), {
    code: 'FFMPEG_CODEC_MISSING',
    inspected,
  });
};

const vfrSyncProbes = new Map();
const CURRENT_VFR_ARGS = Object.freeze(['-fps_mode', 'vfr']);
const LEGACY_VFR_ARGS = Object.freeze(['-vsync', 'vfr']);

// fps_mode replaced the global vsync option in 5.1; 9 removes vsync. Probe
// capabilities rather than imposing a new version floor on older installs.
// Like the setparams probe below, an inconclusive result stays uncached.
export const vfrSyncArgs = async (bin) => {
  if (vfrSyncProbes.has(bin)) return vfrSyncProbes.get(bin);
  const probe = execFileAsync(bin, ['-hide_banner', '-h', 'full'], safeChildProcessOptions({
    timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  })).then(({ stdout }) => {
    const listing = String(stdout || '');
    if (/^\s*-fps_mode(?:\s|\[|$)/m.test(listing)) return CURRENT_VFR_ARGS;
    if (/^\s*-vsync(?:\s|$)/m.test(listing)) return LEGACY_VFR_ARGS;
    vfrSyncProbes.delete(bin);
    return CURRENT_VFR_ARGS;
  }, () => {
    vfrSyncProbes.delete(bin);
    return CURRENT_VFR_ARGS;
  });
  vfrSyncProbes.set(bin, probe);
  return probe;
};

/**
 * Spawn an ffmpeg child process and resolve with a structured result.
 * Collapses three sibling implementations (audioMux mux, optimizeForStreaming
 * faststart remux, upscaleVideo2x) onto one primitive so the spawn → stderr-
 * tail → close → SIGTERM-on-abort behavior stays in sync.
 *
 * - `bin`: absolute ffmpeg path (call `findFfmpeg()` upstream — keeps the
 *   discovery cache hot and lets the caller decide what to do when ffmpeg
 *   is missing). Required.
 * - `args`: argv passed to spawn. Required.
 * - `signal`: optional `AbortSignal`. When the signal fires we SIGTERM the
 *   child; the close handler reports `{ ok:false, reason: 'cancelled (SIGTERM)' }`.
 *   The abort listener is removed in a `finally`-shaped path so a long-lived
 *   signal (one per render queue, used across many calls) doesn't accumulate
 *   listeners on every successful ffmpeg run.
 * - `stderrTailBytes`: cap on the stderr buffer. `0` → `stdio: 'ignore'` (no
 *   stderr captured, matches the historical optimize/upscale behavior).
 *   Default `2000` mirrors audioMux's prior cap.
 *
 * - `returnStderr`: when true a successful result also carries the captured
 *   stderr tail as `stderr` (loudness measurement reads its JSON from there).
 *
 * - `timeoutMs`: optional wall-clock ceiling for a stalled ffmpeg (unreadable
 *   input, evicted cloud file, dead network mount). On expiry the child gets
 *   SIGTERM, then SIGKILL after `FFMPEG_KILL_GRACE_MS`, and the result is
 *   `{ ok: false, reason: 'timed out after <n>s' }`. No default: long encodes
 *   rely on their caller `signal` instead. The `signal` abort path escalates
 *   to SIGKILL the same way.
 *
 * Returns `{ ok: true }` on exit code 0, otherwise `{ ok: false, reason }`
 * where `reason` is a short human-readable string suitable for logging or
 * surfacing in a UI error. Spawn errors are translated into `reason: 'spawn
 * failed: …'` so callers don't need a separate `.on('error', …)` handler.
 */
export const FFMPEG_KILL_GRACE_MS = 5000;
// Ceilings for bounded work: one frame/poster, and a single full-file pass.
export const FFMPEG_FRAME_TIMEOUT_MS = 2 * 60 * 1000;
export const FFMPEG_SCAN_TIMEOUT_MS = 15 * 60 * 1000;

export function runFfmpegProcess({ bin, args, signal, timeoutMs, stderrTailBytes = 2000, returnStderr = false, env, onStdout } = {}) {
  if (!bin || typeof bin !== 'string') {
    return Promise.resolve({ ok: false, reason: 'invalid ffmpeg binary' });
  }
  if (!Array.isArray(args)) {
    return Promise.resolve({ ok: false, reason: 'invalid ffmpeg args' });
  }
  return new Promise((resolve) => {
    const stdio = ['ignore', onStdout ? 'pipe' : 'ignore', stderrTailBytes > 0 ? 'pipe' : 'ignore'];
    const proc = spawn(bin, args, safeChildProcessOptions({ stdio, ...(env ? { env } : {}) }));
    if (onStdout) proc.stdout.on('data', onStdout);
    let stderrTail = '';
    if (stderrTailBytes > 0 && proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderrTail += chunk.toString();
        if (stderrTail.length > stderrTailBytes) {
          stderrTail = stderrTail.slice(-stderrTailBytes);
        }
      });
    }
    // `{ once: true }` auto-removes the listener when it fires. We still call
    // removeEventListener on normal completion so a signal reused across many
    // ffmpeg calls (one per render queue) doesn't accumulate dozens of unfired
    // listeners — the leak the audioMux audit flagged.
    let closed = false;
    let timedOut = false;
    let timeoutTimer = null;
    let killTimer = null;
    // SIGTERM first; a child wedged in uninterruptible IO may ignore it, so
    // follow with SIGKILL unless it has closed by then.
    const terminate = () => {
      proc.kill('SIGTERM');
      if (killTimer) return;
      killTimer = setTimeout(() => { if (!closed) proc.kill('SIGKILL'); }, FFMPEG_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const clearTimers = () => {
      closed = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
      timeoutTimer.unref?.();
    }
    let onAbort = null;
    if (signal) {
      onAbort = terminate;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) terminate();
    }
    const cleanupSignal = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    proc.on('error', (err) => {
      clearTimers();
      cleanupSignal();
      resolve({ ok: false, reason: `spawn failed: ${err.message}` });
    });
    proc.on('close', (code, sig) => {
      clearTimers();
      cleanupSignal();
      if (timedOut) {
        resolve({ ok: false, reason: `timed out after ${Math.round(timeoutMs / 1000)}s` });
        return;
      }
      if (sig === 'SIGTERM' || sig === 'SIGKILL') {
        resolve({ ok: false, reason: `cancelled (${sig})` });
        return;
      }
      if (code !== 0) {
        const tail = stderrTail.split(/\r?\n/).slice(-4).join(' | ');
        resolve({ ok: false, reason: tail ? `ffmpeg exit ${code}: ${tail}` : `ffmpeg exit ${code}` });
        return;
      }
      resolve(returnStderr ? { ok: true, stderr: stderrTail } : { ok: true });
    });
  });
}

// ffprobe sits next to ffmpeg in standard distributions — derive the path
// from the cached ffmpeg discovery so we don't shell out twice.
let cachedFfprobePath;
export const findFfprobe = async () => {
  if (cachedFfprobePath !== undefined) return cachedFfprobePath;
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) { cachedFfprobePath = null; return null; }
  // Derive ffprobe from ffmpeg's directory rather than regex-replacing the
  // basename. A case-sensitive replace would silently miss `FFMPEG.EXE` on
  // Windows and let callers spawn ffmpeg as if it were ffprobe (audio
  // probing then always reports "no audio"). dirname-based join sidesteps
  // the casing question entirely.
  const probe = join(dirname(ffmpeg), isWindows() ? 'ffprobe.exe' : 'ffprobe');
  if (existsSync(probe)) { cachedFfprobePath = probe; return probe; }
  cachedFfprobePath = await whichFirst('ffprobe');
  return cachedFfprobePath;
};

// Run ffprobe with the given args and return its trimmed stdout, or '' when
// ffprobe is unavailable or the call fails. Collapses the shared discover →
// spawn → catch-default → trim boilerplate behind the three ffprobe-based
// probes below (duration, frame count, audio-stream presence) so they can't
// drift on the env/timeout/error-handling contract.
const runFfprobe = async (args, timeout = 5000) => {
  const ffprobe = await findFfprobe();
  if (!ffprobe) return '';
  const { stdout } = await execFileAsync(ffprobe, args, safeChildProcessOptions({ timeout })).catch(() => ({ stdout: '' }));
  return (stdout || '').trim();
};

// Probe whether a media file carries at least one audio stream. Referencing
// `[0:a]` in a filter_complex graph against a silent video (AI-gen clips are
// silent today) aborts the whole ffmpeg run, so callers that want to preserve
// a clip's own soundtrack (e.g. LTX-2 audio-to-video) must gate the `[0:a]`
// input on this probe. Returns false when ffprobe is unavailable so callers
// default to the safe "no clip audio" path rather than emitting a graph that
// can't build.
export const hasAudioStream = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) return false;
  const stdout = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    videoPath,
  ]);
  return stdout.length > 0;
};

// Unlike the permissive helper above, distinguish a silent video from a
// failed probe when a caller must verify that a soundtrack was preserved.
export const probeVideoAudioPresence = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) return null;
  const ffprobe = await findFfprobe();
  if (!ffprobe) return null;
  const result = await execFileAsync(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index',
    '-of', 'default=nokey=1:noprint_wrappers=1', videoPath,
  ], safeChildProcessOptions({ timeout: 5000 })).catch(() => null);
  if (!result) return null;
  const output = (result.stdout || '').trim();
  return output === '' ? false : /^\d+$/.test(output) ? true : null;
};

// Single-video thumbnail extraction. Seeks to mid-clip rather than frame 0
// because LTX-2 renders fade IN from black: the first ~0.5s is near-zero
// brightness, so a frame-0 thumbnail looks like a "broken black" tile
// even when the clip itself is fine. Mid-clip is reliably the visual peak.
//
// Strategy: probe duration via ffprobe and seek to duration/2 (capped at
// 2.5s — the canonical mid-point of a 5s 24fps LTX clip). When ffprobe is
// unavailable or returns a tiny duration we fall back to a fixed -ss 1.0
// rather than frame 0, since 1s is still past the LTX fade-in on every
// useful clip length. `-ss` BEFORE `-i` is the fast-seek path (keyframe
// step), which is fine for thumbnails — exact-frame accuracy isn't needed.
//
// Returns the basename on success, null when ffmpeg is missing or fails —
// callers should treat null as "no thumbnail" rather than aborting the
// parent operation.
// Probe a media file's duration in seconds via ffprobe. The implementation is
// container-level and works for audio-only files too. Returns null when ffprobe
// is unavailable or the file has no parseable duration — callers must treat null
// as "unknown" rather than 0. The historical `probeVideoDuration` export name is
// retained because cue placement already consumes it.
const probeDurationSeconds = async (videoPath) => {
  const stdout = await runFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    videoPath,
  ]);
  const n = parseFloat(stdout);
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const probeVideoDuration = probeDurationSeconds;

export const generateThumbnail = async (videoPath, jobId, { atSec } = {}) => {
  await ensureDir(PATHS.videoThumbnails);
  const thumbFilename = `${jobId}.jpg`;
  const thumbPath = join(PATHS.videoThumbnails, thumbFilename);
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  const duration = await probeDurationSeconds(videoPath);
  // Cap at 2.5s — the midpoint of a 5s 24fps LTX clip (121 frames). For
  // longer clips (Extend mode, 10s+) 2.5s is still past the LTX fade-in
  // and not at an unreliable boundary. For short clips (<2s) seek to the
  // actual midpoint. Fall back to 1s when ffprobe is unavailable.
  const stream = Number.isFinite(atSec) && duration ? await probeVideoStreamInfo(videoPath) : null;
  const lastFrameSec = duration ? Math.max(0, duration - (stream?.fps > 0 ? 1 / stream.fps : 0.001)) : atSec;
  const seekSec = Number.isFinite(atSec)
    ? Math.max(0, Math.min(atSec, lastFrameSec))
    : duration ? Math.min(2.5, Math.max(0.5, duration / 2)) : 1.0;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-ss', seekSec.toFixed(Number.isFinite(atSec) ? 6 : 2), '-i', videoPath, '-vframes', '1', '-q:v', '5', '-y', thumbPath],
    stderrTailBytes: 0,
    timeoutMs: FFMPEG_FRAME_TIMEOUT_MS,
  });
  if (!result.ok && result.reason?.startsWith('spawn failed: ')) {
    console.log(`⚠️ ffmpeg thumbnail failed to spawn: ${result.reason.slice('spawn failed: '.length)}`);
  }
  return result.ok ? thumbFilename : null;
};

// Probe the video's total frame count. Tries the fast metadata path first
// (`stream=nb_frames`) and falls back to an actual frame count
// (`-count_frames stream=nb_read_frames`) for containers that don't expose
// nb_frames in their header. Returns null when both paths fail or the
// reported count is unusable.
export const probeFrameCount = async (videoPath) => {
  const run = async (countFrames) => {
    const stdout = await runFfprobe([
      '-v', 'error',
      ...(countFrames ? ['-count_frames'] : []),
      '-select_streams', 'v:0',
      '-show_entries', `stream=${countFrames ? 'nb_read_frames' : 'nb_frames'}`,
      '-of', 'default=nokey=1:noprint_wrappers=1',
      videoPath,
    ], 15000);
    const n = parseInt(stdout, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return (await run(false)) ?? (await run(true));
};

// Probe the video stream geometry in ONE ffprobe call: pixel dimensions, the
// average frame rate, and the header frame count. Callers that need a frame
// count they can trust on any container should still fall back to
// `probeFrameCount` (which pays for a decode pass when the header lacks
// nb_frames) — this returns `frameCount: null` rather than guessing.
//
// Every field is independently nullable: an unreadable axis is "unknown", never
// 0, so a caller cannot read a failed probe as a real measurement.
export const probeVideoStreamInfo = async (videoPath) => {
  const empty = { width: null, height: null, fps: null, frameCount: null };
  if (typeof videoPath !== 'string' || !videoPath) return empty;
  // Keyed output (`nokey=0`), NOT positional: ffprobe prints requested entries in
  // its own internal field order rather than the order they were asked for, so
  // destructuring the lines would silently swap two fields the day that order
  // changes. Reading `key=value` costs nothing and cannot mis-bind.
  const stdout = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames',
    '-of', 'default=noprint_wrappers=1',
    videoPath,
  ]);
  const fields = new Map(stdout.split(/\r?\n/).map((line) => {
    const at = line.indexOf('=');
    return at === -1 ? null : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }).filter(Boolean));
  const width = fields.get('width');
  const height = fields.get('height');
  const frameRate = fields.get('avg_frame_rate');
  const frames = fields.get('nb_frames');
  const positiveInt = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // ffprobe reports avg_frame_rate as a rational ("24000/1001"), and "0/0" for
  // a stream it could not measure.
  const parseRate = (value) => {
    if (!value) return null;
    const [num, den] = value.split('/');
    const n = parseFloat(num);
    const d = den === undefined ? 1 : parseFloat(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) return null;
    return n / d;
  };
  return {
    width: positiveInt(width),
    height: positiveInt(height),
    fps: parseRate(frameRate),
    frameCount: positiveInt(frames),
  };
};

// Pixel aspect is distinct from raster dimensions. Null means ffprobe could
// not establish it; callers that require exact display geometry can refuse.
export const probeVideoPixelAspect = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) return null;
  const stdout = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=sample_aspect_ratio', '-of', 'default=nokey=1:noprint_wrappers=1', videoPath]);
  const match = /^\s*(\d+):(\d+)\s*$/.exec(stdout);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null;
  return { numerator, denominator };
};

export const probeSquareVideoPixels = async videoPath => {
  const aspect = await probeVideoPixelAspect(videoPath);
  return aspect ? aspect.numerator === aspect.denominator : null;
};

// What a stream copy needs two clips to share before their video can be joined
// without a decode: codec, profile/level, pixel format and the colour tags the
// decoder reads off the stream. Joined into one comparable string, or null when
// the probe could not read the stream. Equal strings are necessary, not
// sufficient — callers still verify the joined result.
export const probeVideoCodecSignature = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) return null;
  const stdout = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,level,pix_fmt,color_range,color_space,color_transfer,color_primaries,field_order',
    '-of', 'default=noprint_wrappers=1',
    videoPath,
  ]);
  const lines = stdout.split(/\r?\n/).filter(Boolean).sort();
  return lines.some((line) => line.startsWith('codec_name=')) ? lines.join('|') : null;
};

// Per-frame MD5 of a clip's first video stream, in decode-output order — the
// ground truth for "these frames are bit-identical". Null when the clip cannot
// be fully decoded (any decode error fails the run), so a caller can never read
// a broken join as a matching one.
export const videoFrameHashes = async (videoPath) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg || typeof videoPath !== 'string' || !videoPath) return null;
  const hashPath = join(tmpdir(), `framemd5-${randomUUID()}.txt`);
  try {
    const run = await runFfmpegProcess({
      bin: ffmpeg,
      args: ['-v', 'error', '-xerror', '-i', videoPath, '-map', '0:v:0', '-f', 'framemd5', '-y', hashPath],
      timeoutMs: FFMPEG_SCAN_TIMEOUT_MS,
    });
    if (!run.ok) return null;
    const rows = (await readFile(hashPath, 'utf8')).split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    const hashes = rows.map((row) => row.split(',').pop().trim());
    return hashes.length ? hashes : null;
  } catch {
    return null;
  } finally {
    await unlink(hashPath).catch(() => {});
  }
};

// Identity of the soundtrack a clip plays: the MD5 of its decoded first audio
// stream. Decoded rather than hashed as packets so a lossless remux (faststart)
// keeps it, while any change to the samples — a replaced or re-muxed soundtrack,
// even at the same length — does not. Null when the clip has no readable audio.
export const audioFingerprint = async (mediaPath) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg || typeof mediaPath !== 'string' || !mediaPath) return null;
  const { stdout } = await execFileAsync(
    ffmpeg,
    ['-v', 'error', '-i', mediaPath, '-map', '0:a:0', '-vn', '-f', 'md5', '-'],
    safeChildProcessOptions({ timeout: 60000 }),
  ).catch(() => ({ stdout: '' }));
  return /^MD5=([0-9a-f]{32})/m.exec(stdout || '')?.[1] ?? null;
};

const MASTER_FINGERPRINT_TAG = 'portos_clip_audio_md5';

/** Copy a lossless audio master to `outPath`, stamping the clip-audio fingerprint it was mixed for. */
export const sealAudioMaster = async ({ inPath, outPath, fingerprint }) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };
  return runFfmpegProcess({
    bin: ffmpeg,
    args: ['-i', inPath, '-map', '0:a:0', '-c:a', 'copy', '-metadata', `${MASTER_FINGERPRINT_TAG}=${fingerprint}`, '-y', outPath],
  });
};

/** The clip-audio fingerprint a master was sealed with, or null when absent or unreadable. */
export const readAudioMasterFingerprint = async (masterPath) => {
  const stdout = await runFfprobe(['-v', 'error', '-show_entries', 'format_tags', '-of', 'default=noprint_wrappers=1', masterPath]);
  const line = stdout.split(/\r?\n/).find((row) => row.toLowerCase().startsWith(`tag:${MASTER_FINGERPRINT_TAG}=`));
  return line ? line.slice(line.indexOf('=') + 1).trim() || null : null;
};

// The playable geometry of a finished clip — `{ width, height, fps, numFrames,
// durationSec }` — or null when any axis cannot be measured. For entries whose
// producer never recorded a frame count (hosted Grok/fal/reactor renders), so a
// consumer that trims by numFrames/fps measures the file instead of guessing.
export const probeVideoGeometry = async (videoPath) => {
  const [stream, durationSec] = await Promise.all([probeVideoStreamInfo(videoPath), probeDurationSeconds(videoPath)]);
  if (!stream.width || !stream.height || !stream.fps || !durationSec) return null;
  return {
    width: stream.width,
    height: stream.height,
    fps: stream.fps,
    numFrames: stream.frameCount || Math.round(durationSec * stream.fps),
    durationSec,
  };
};

// Sanity-check that a rendered video file is actually playable: the file
// exists on disk, has non-zero bytes, and ffprobe can decode at least one
// video frame from it. Returns `{ ok: true }` on success and
// `{ ok: false, reason }` with a short human-readable cause on failure.
//
// Used by the `autoAcceptScenes` path in the Creative Director scene
// runner to avoid marking a black/zero-frame render as accepted just
// because the renderer process exited 0. Falls back to "ok" when ffprobe
// is unavailable so machines without ffmpeg installed still complete the
// auto-accept flow (the file-exists/size>0 checks still run).
export const verifyVideoPlayable = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) {
    return { ok: false, reason: 'invalid video path' };
  }
  if (!existsSync(videoPath)) {
    return { ok: false, reason: `video file missing: ${videoPath}` };
  }
  // statSync is wrapped because the file can be unlinked or made
  // inaccessible between the existsSync check above and the stat call (a
  // TOCTOU race during cleanup or external file moves). We want a clean
  // structured `{ ok: false, reason }` instead of an unhandled throw that
  // would surface as a 500.
  let size = 0;
  try {
    size = statSync(videoPath).size;
  } catch (err) {
    return { ok: false, reason: `video file unreadable: ${err.message}` };
  }
  if (!size || size <= 0) {
    return { ok: false, reason: 'video file is empty (0 bytes)' };
  }
  const ffprobe = await findFfprobe();
  if (!ffprobe) return { ok: true };
  const frames = await probeFrameCount(videoPath);
  if (!frames || frames < 1) {
    return { ok: false, reason: 'ffprobe could not read any video frames' };
  }
  return { ok: true };
};

// Extract `count` evenly-spaced frames across the video for the cognitive
// evaluator. Saved as `<jobId>-f1.jpg ... -f<count>.jpg` in
// `data/video-thumbnails/`. Returns the array of basenames in timeline order
// on success, or `[]` on any failure — callers should fall back to the
// single-frame thumbnail rather than aborting.
//
// Why this exists: i2v scenes whose intent develops mid-or-late (archway
// appears at 60%, light bloom at 80%) get rejected by the evaluator when it
// only sees frame 0. Sampling 5 frames lets the agent judge intent across
// the entire timeline rather than just the opening pose.
export const extractEvaluationFrames = async (videoPath, jobId, count = 5) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return [];

  const totalFrames = await probeFrameCount(videoPath);
  if (!totalFrames) return [];

  await ensureDir(PATHS.videoThumbnails);

  const frameIndices = totalFrames <= count
    ? Array.from({ length: totalFrames }, (_, i) => i)
    : (() => {
        const last = totalFrames - 1;
        // Quartile sampling (start, 25%, 50%, 75%, end). Generalizes to any
        // `count` ≥ 2 — for count=5 this matches the spec exactly.
        const positions = [];
        if (count === 1) return [0];
        for (let i = 0; i < count; i++) {
          positions.push(Math.round((i * last) / (count - 1)));
        }
        // Dedup in case rounding collapses adjacent indices on tiny clips.
        return Array.from(new Set(positions));
      })();

  // Filter expression: select frames matching any of the target indices.
  // Single-quoting the expression lets ffmpeg's filter parser treat the
  // commas inside `eq(n,X)` as expression args rather than filter-chain
  // separators. VFR sync prevents the image2 muxer from padding output
  // to maintain input fps (which would re-emit each match repeatedly).
  const selectExpr = frameIndices.map((i) => `eq(n,${i})`).join('+');
  const outPattern = join(PATHS.videoThumbnails, `${jobId}-f%d.jpg`);

  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-i', videoPath, '-vf', `select='${selectExpr}'`, ...await vfrSyncArgs(ffmpeg), '-q:v', '5', '-y', outPattern],
    stderrTailBytes: 0,
    timeoutMs: FFMPEG_SCAN_TIMEOUT_MS,
  });
  if (!result.ok && result.reason?.startsWith('spawn failed: ')) {
    console.log(`⚠️ ffmpeg multi-frame extract failed to spawn: ${result.reason.slice('spawn failed: '.length)}`);
  }
  if (!result.ok) return [];
  // ffmpeg's image2 muxer numbers output starting at 1 in match order, so
  // the basenames map 1:1 to our frameIndices in timeline order.
  return frameIndices.map((_, i) => `${jobId}-f${i + 1}.jpg`);
};

// The one H.264 encode profile every re-encoding path here shares. Visually
// lossless to most viewers and plays everywhere — but the reason it's a
// constant rather than three inlined copies is that clips encoded by DIFFERENT
// paths get concatenated together (a chained render's trimmed chunks join its
// untrimmed ones), and a mismatch there shows up as one segment being graded
// differently from its neighbours. Callers append their own `-c:a`.
export const H264_ENCODE_ARGS = Object.freeze([
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
]);
export const AAC_ENCODE_ARGS = Object.freeze(['-c:a', 'aac', '-b:a', '192k']);

// Loudness mastering for audio PortOS itself produces (#10249): the platform
// target a social feed normalizes toward, and the true-peak ceiling that keeps
// the AAC encode from clipping.
export const MASTER_LOUDNESS = Object.freeze({ targetLufs: -14, truePeakDb: -1.5, lra: 11 });
// Below this integrated loudness a soundtrack is treated as silent.
export const SILENT_LUFS = -50;

// loudnorm aims half a dB under the ceiling: the AAC encode that follows can
// overshoot its input's true peak by a tenth of a dB or so.
const AAC_HEADROOM_DB = 0.5;
const loudnormTarget = `I=${MASTER_LOUDNESS.targetLufs}:TP=${MASTER_LOUDNESS.truePeakDb - AAC_HEADROOM_DB}:LRA=${MASTER_LOUDNESS.lra}`;
const roundDb = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
// loudnorm prints numbers as strings and "-inf" for silence.
const parseDb = (v) => (/-\s*inf/i.test(String(v)) ? -Infinity : /inf/i.test(String(v)) ? Infinity : Number(v));

/**
 * Read the JSON block `loudnorm=print_format=json` writes to stderr. Returns
 * the unrounded measurement, or null when no block is present.
 */
function parseLoudnormJson(stderr) {
  const block = String(stderr ?? '').match(/\{[^{}]*"input_i"[^{}]*\}/g)?.pop();
  if (!block) return null;
  let raw;
  try { raw = JSON.parse(block); } catch { return null; }
  return {
    integratedLufs: parseDb(raw.input_i), truePeakDb: parseDb(raw.input_tp), loudnessRange: parseDb(raw.input_lra),
    thresholdDb: parseDb(raw.input_thresh), offsetDb: parseDb(raw.target_offset),
  };
}

/**
 * Measurement pass: run `inputArgs` (ffmpeg input options plus `-i`) through
 * an optional `prefilter` and loudnorm in analysis mode, discarding the audio.
 * Resolves `{ ok: true, measured }` (values rounded to 0.1 for reporting;
 * `raw` keeps full precision for the apply pass) or `{ ok: false, reason }`.
 */
async function measureLoudness({ bin, inputArgs, prefilter = '', durationSec, signal, run = runFfmpegProcess }) {
  const filter = [prefilter, `loudnorm=${loudnormTarget}:print_format=json`].filter(Boolean).join(',');
  const result = await run({
    bin, signal, returnStderr: true, stderrTailBytes: 8000,
    args: ['-hide_banner', '-nostats', ...inputArgs, '-vn', '-af', filter, ...(durationSec ? ['-t', String(durationSec)] : []), '-f', 'null', '-'],
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  const raw = parseLoudnormJson(result.stderr);
  if (!raw) return { ok: false, reason: 'loudness measurement produced no result' };
  return { ok: true, raw, measured: { integratedLufs: roundDb(raw.integratedLufs), truePeakDb: roundDb(raw.truePeakDb), loudnessRange: roundDb(raw.loudnessRange) } };
}

/** Apply pass: loudnorm in linear mode fed the numbers the measurement pass found. */
function loudnormApplyFilter(raw) {
  const n = (v) => Math.round(v * 100) / 100;
  return `loudnorm=${loudnormTarget}:measured_I=${n(raw.integratedLufs)}:measured_TP=${n(raw.truePeakDb)}:measured_LRA=${n(raw.loudnessRange)}:measured_thresh=${n(raw.thresholdDb)}:offset=${n(raw.offsetDb)}:linear=true,aresample=48000`;
}

/**
 * Measure-then-apply for one audio source. Resolves `{ filter, before }`:
 * `filter` is the linear loudnorm to splice into the encode's `-af`, `before`
 * the rounded pre-master numbers. Throws, naming the cause, when the source
 * cannot be measured or is silent.
 */
export async function planLoudnessMaster(options) {
  const result = await measureLoudness(options);
  if (!result.ok) throw new Error(`Audio mastering could not measure the soundtrack: ${result.reason}`);
  if (!(result.raw.integratedLufs > SILENT_LUFS)) {
    throw new Error(`Soundtrack is silent: measured ${Number.isFinite(result.raw.integratedLufs) ? `${result.measured.integratedLufs} LUFS` : 'no signal'} (below ${SILENT_LUFS} LUFS)`);
  }
  return { filter: loudnormApplyFilter(result.raw), before: result.measured };
}

/**
 * Measure a finished render's audio and report it beside the pre-master
 * numbers. Throws when the file has no measurable (or only silent) audio.
 */
export async function reportMasteredLoudness({ bin, outputPath, before, signal, run }) {
  const result = await measureLoudness({ bin, inputArgs: ['-i', outputPath], signal, run });
  if (!result.ok) throw new Error(`Rendered video has no measurable audio: ${result.reason}`);
  if (!(result.raw.integratedLufs > SILENT_LUFS)) throw new Error(`Rendered soundtrack is silent: measured ${result.measured.integratedLufs} LUFS`);
  return { ...result.measured, masteredFrom: { integratedLufs: before.integratedLufs, truePeakDb: before.truePeakDb }, targetLufs: MASTER_LOUDNESS.targetLufs };
}

// A clip cut from mid-song (a social cut) starts and stops on a hard edge; a
// short fade in and a longer fade out keep it from clicking. Returned as an
// `-af` chain fragment (leading comma) so callers append it to their trim.
export const edgeFadeFilter = (durationSec, { inSec = 0.08, outSec = 0.6 } = {}) => {
  const out = Math.min(outSec, Math.max(0, durationSec / 2));
  const fadeIn = Math.min(inSec, Math.max(0, durationSec / 2));
  return `,afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${Math.max(0, durationSec - out).toFixed(3)}:d=${out}`;
};

// BT.709 color tagging for every re-encode this module writes.
//
// Untagged H.264 makes each player guess a color space, and the common guess
// for HD content differs from the one for SD — so a stitched clip that carries
// no tags decodes washed-out (or over-saturated) depending on where it's
// opened. The renders these helpers re-encode are BT.709 in practice; the fix
// is to SAY so on the output.
//
// It takes both halves to stick. The container flags below write the tags into
// the MP4's `colr` atom, but from ffmpeg 8 the encoder reads its color
// properties off the FRAMES coming down the filter graph — and those inherit
// the (usually unspecified) values of the decoded input, silently overriding
// the flags. `setparams` stamps the frame properties themselves, so the
// encoder and the container agree.
export const BT709_TAG_FILTER = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709';
export const BT709_CONTAINER_ARGS = Object.freeze([
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
]);

// `null` = not probed yet; `true`/`false` = the answer this ffmpeg build gave.
// A probe that couldn't run (no binary, `-filters` failed) is NOT an answer and
// is deliberately left uncached, so a later call still gets a real result
// instead of a permanent "unsupported" from one transient failure.
let setparamsAvailable = null;

// Test seam — resets the capability cache between cases.
export const __resetSetparamsProbe = () => { setparamsAvailable = null; };

// Does this ffmpeg build carry the `setparams` filter? It landed in ffmpeg 4.3;
// older builds (still common in distro packages) parse it as an unknown filter
// and abort the whole run, which would turn a color-tagging nicety into a
// failed render. Probe once per process — the binary can't change under us.
export const supportsSetparamsFilter = async () => {
  if (setparamsAvailable !== null) return setparamsAvailable;
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return false;
  const listing = await execFileAsync(ffmpeg, ['-hide_banner', '-filters'], safeChildProcessOptions({
    maxBuffer: 4 * 1024 * 1024,
  })).then((r) => String(r.stdout || ''), () => null);
  if (listing === null) return false;
  setparamsAvailable = /(^|\s)setparams(\s|$)/m.test(listing);
  if (!setparamsAvailable) {
    console.log('⚠️ ffmpeg has no setparams filter — BT.709 tags will ride the container flags only');
  }
  return setparamsAvailable;
};

// The filter string to append to a re-encode's video chain, or `null` when this
// ffmpeg build can't take it. Callers still spread `BT709_CONTAINER_ARGS`
// unconditionally — those flags are accepted by every build worth supporting.
export const bt709TagFilter = async () => (await supportsSetparamsFilter() ? BT709_TAG_FILTER : null);

// Append a filter to a comma-separated ffmpeg filter chain, tolerating both an
// empty chain and a `null` filter (the unsupported-build case).
const appendFilter = (chain, filter) => {
  if (!filter) return chain;
  return chain ? `${chain},${filter}` : filter;
};

// Move a freshly-encoded temp file over the file it replaces.
//
// POSIX rename atomically replaces an existing destination in one syscall. On
// Windows, fs.rename fails when the destination already exists — but a simple
// unlink-first would destroy the original if the subsequent rename failed
// (locked file, AV scan, transient permissions). Move the original aside to a
// .bak first, install the new file, and restore the backup on failure. If the
// restore itself fails, retain that original and signal uncertain publication
// state so backup admission cannot accept the temporarily missing target.
//
// Extracted because three callers here (`trimVideoFromFrame`, `upscaleVideo2x`,
// `optimizeForStreaming`) need this identical rollback, and a data-loss-
// sensitive path with three copies is one that eventually gets fixed in only
// two of them. Exported for the same reason: `pipeline/audioMux.js` replaces
// the stitched episode in place from four more entry points, and its own bare
// `rename` was exactly the copy that never got fixed (#7237). `label` names
// the operation for the failure message.
//
// Returns `{ ok: true, outPath }` or `{ ok: false, reason }`. A failed rollback
// throws explicitly uncertain publication state and retains the original backup.
export const installEncodedVideo = async (tmpPath, targetPath, label) => {
  let backupPath = null;
  try {
    if (IS_WIN) {
      const candidate = `${targetPath}.bak.${randomUUID()}`;
      await rename(targetPath, candidate).then(() => { backupPath = candidate; }).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
    }
    await rename(tmpPath, targetPath);
    if (backupPath) await unlink(backupPath).catch(() => {});
    return { ok: true, outPath: targetPath };
  } catch (err) {
    if (backupPath) {
      try { await rename(backupPath, targetPath); }
      catch (rollbackError) {
        throw Object.assign(new AggregateError([err, rollbackError], `Failed to restore ${label} video; original retained at ${backupPath}`), {
          backupPublicationUncertain: true, recoveryPath: backupPath,
        });
      }
    }
    await unlink(tmpPath).catch(() => {});
    return { ok: false, reason: `Failed to install ${label} video: ${err.message}` };
  }
};

// Keep frames [startFrame, end) of a clip, dropping everything before it.
//
// Both halves of the chained-render context window need exactly this cut: the
// tail window handed to LTX-2's extend pipeline is "keep the last N frames"
// (startFrame = total - N), and trimming the echoed context back off an extend
// render is "keep everything after the echo" (startFrame = prefix length). See
// `lib/videoContinuity.js` for how those indices are derived.
//
// Frame-exact by construction: the `trim` filter cuts on a frame INDEX rather
// than a timestamp, so the seam can't drift by a frame the way an `-ss` seek
// can — and a one-frame drift here is a visible stutter or a repeated frame in
// the stitched clip. `atrim` cuts the audio at the matching timestamp so LTX's
// jointly-generated soundtrack stays in sync; a silent clip takes `-an`
// instead, because referencing a missing audio stream aborts the whole run.
//
// Re-encodes (a frame-index cut can't be stream-copied — the new first frame
// is almost never a keyframe). Callers that then concat the result must
// re-encode at concat time too rather than relying on `-c copy`.
//
// `outPath` may be the input path: the encode goes to a sibling temp file and
// is renamed into place, so a failure leaves the original untouched.
//
// Returns `{ ok: true, outPath }` or `{ ok: false, reason }`.
export const trimVideoFromFrame = async (videoPath, outPath, { startFrame, fps } = {}) => {
  if (typeof videoPath !== 'string' || !videoPath) return { ok: false, reason: 'invalid video path' };
  if (typeof outPath !== 'string' || !outPath) return { ok: false, reason: 'invalid output path' };
  if (!existsSync(videoPath)) return { ok: false, reason: 'video file missing' };
  const start = Math.max(0, Math.floor(Number(startFrame) || 0));
  const rate = Number(fps);
  if (!Number.isFinite(rate) || rate <= 0) return { ok: false, reason: `invalid fps: ${fps}` };
  let ffmpeg;
  try {
    ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };

  const inPlace = resolvePath(videoPath) === resolvePath(outPath);
  const encodePath = inPlace ? `${videoPath}.trim.mp4` : outPath;
  if (!inPlace) await ensureDir(dirname(outPath));

  const audio = await hasAudioStream(videoPath);
  const colorFilter = await bt709TagFilter();
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-i', videoPath,
      '-vf', appendFilter(`trim=start_frame=${start},setpts=PTS-STARTPTS`, colorFilter),
      ...(audio
        // atrim takes seconds; the frame index converts exactly because the
        // clips this runs on are CFR renders straight out of the model.
        ? ['-af', `atrim=start=${(start / rate).toFixed(6)},asetpts=PTS-STARTPTS`, ...AAC_ENCODE_ARGS]
        : ['-an']),
      ...H264_ENCODE_ARGS,
      ...BT709_CONTAINER_ARGS,
      '-movflags', '+faststart',
      '-y', encodePath,
    ],
  });
  if (!result.ok) {
    await unlink(encodePath).catch(() => {});
    return { ok: false, reason: `ffmpeg trim failed: ${result.reason}` };
  }
  if (!inPlace) return { ok: true, outPath };
  return installEncodedVideo(encodePath, videoPath, 'trimmed');
};

// Cut `[startSec, endSec)` of a clip into a new file (a music-video sequence
// take split onto its scenes, #14241). Re-encodes for the same reason as
// trimVideoFromFrame. Returns `{ ok: true, outPath }` or `{ ok: false, reason }`.
export const cutVideoSegment = async (videoPath, outPath, { startSec, endSec } = {}) => {
  if (typeof videoPath !== 'string' || !videoPath) return { ok: false, reason: 'invalid video path' };
  if (typeof outPath !== 'string' || !outPath || resolvePath(videoPath) === resolvePath(outPath)) return { ok: false, reason: 'invalid output path' };
  if (!existsSync(videoPath)) return { ok: false, reason: 'video file missing' };
  const start = Number(startSec);
  const end = Number(endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return { ok: false, reason: `invalid span ${startSec}-${endSec}` };
  let ffmpeg;
  try {
    ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };
  await ensureDir(dirname(outPath));
  const audio = await hasAudioStream(videoPath);
  const colorFilter = await bt709TagFilter();
  const span = `start=${start.toFixed(6)}:end=${end.toFixed(6)}`;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-i', videoPath,
      '-vf', appendFilter(`trim=${span},setpts=PTS-STARTPTS`, colorFilter),
      ...(audio ? ['-af', `atrim=${span},asetpts=PTS-STARTPTS`, ...AAC_ENCODE_ARGS] : ['-an']),
      ...H264_ENCODE_ARGS,
      ...BT709_CONTAINER_ARGS,
      '-movflags', '+faststart',
      '-y', outPath,
    ],
  });
  if (!result.ok) {
    await unlink(outPath).catch(() => {});
    return { ok: false, reason: `ffmpeg cut failed: ${result.reason}` };
  }
  return { ok: true, outPath };
};

// Build the ffmpeg argv that concatenates a list of clips where SOME of them
// must drop a leading run of frames first (`startFrame > 0`).
//
// Why a filter graph rather than trimming the files and running the concat
// demuxer over them: a frame-index trim can't be stream-copied, so cutting
// each clip in place costs one full encode per clip — and it also knocks the
// trimmed clips out of codec lockstep with the untrimmed ones, forcing the
// concat itself to re-encode too. Doing the cut inside the concat's own graph
// collapses all of that into the single timeline encode that was going to
// happen anyway, and leaves the source clips byte-identical on disk.
//
// Mirrors the shape `services/videoTimeline/local.js` renders projects with —
// including the belt-and-suspenders normalization. `scale`+`pad`+`setsar` and
// `fps=` on the video leg, `aresample`+`aformat` on the audio leg, are what
// keep ffmpeg from aborting the whole run with "Input link parameters do not
// match" when the inputs disagree even slightly. `width`/`height`/`fps` are
// each applied only when they resolve to a usable number, so a caller that
// doesn't know a canonical value simply gets no normalization for it rather
// than an `undefined` in the graph.
//
// `withAudio` must be true only when EVERY input carries an audio stream
// (`hasAudioStream`): `concat=a=1` needs an audio leg from each input, and
// referencing `[k:a]` on a silent clip aborts the run. A mixed set takes the
// video-only graph, which is what a chain of silent AI renders wants anyway.
//
// `colorTagFilter` is the `setparams` string from `bt709TagFilter()` (or `null`
// on an ffmpeg build without the filter). It stays a PARAMETER rather than
// being probed in here so this builder remains pure and synchronously testable
// — the caller is already async and does the probe once. The container flags
// need no probe and are always emitted.
export const buildTrimConcatArgs = ({ inputs, outPath, width, height, fps, withAudio = false, colorTagFilter = null }) => {
  const clips = Array.isArray(inputs) ? inputs : [];
  if (clips.length < 2) return null;
  const canonW = Number(width);
  const canonH = Number(height);
  const rate = Number(fps);
  const hasDims = Number.isFinite(canonW) && canonW > 0 && Number.isFinite(canonH) && canonH > 0;
  const hasRate = Number.isFinite(rate) && rate > 0;
  // An audio leg on a trimmed input needs `atrim`'s start TIMESTAMP, which
  // only exists if we know the frame rate. Without one, drop the audio rather
  // than emit a graph whose audio and video are offset from each other.
  const trimsAudio = clips.some((c) => Math.floor(Number(c?.startFrame) || 0) > 0);
  const audio = Boolean(withAudio) && (hasRate || !trimsAudio);

  const filters = [];
  const concatStreams = [];
  clips.forEach((clip, i) => {
    const startFrame = Math.max(0, Math.floor(Number(clip?.startFrame) || 0));
    // `trim` leads the chain on purpose. `start_frame` is an index into the
    // frames the filter SEES, so cutting before `fps=` resamples keeps it an
    // index into the source — which is what the caller measured with
    // `probeFrameCount`. It also means the discarded frames never get scaled
    // or padded, which on a windowed chain is roughly half of every chunk.
    const video = [
      ...(startFrame > 0 ? [`trim=start_frame=${startFrame}`] : []),
      'setpts=PTS-STARTPTS',
      ...(hasDims ? [`scale=${canonW}:${canonH}:force_original_aspect_ratio=decrease,pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2,setsar=1`] : []),
      ...(hasRate ? [`fps=${rate}`] : []),
    ];
    filters.push(`[${i}:v]${video.join(',')}[v${i}]`);
    if (audio) {
      const track = [
        // The frame index converts exactly because these are CFR renders.
        ...(startFrame > 0 ? [`atrim=start=${(startFrame / rate).toFixed(6)}`] : []),
        'asetpts=PTS-STARTPTS',
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
      ];
      filters.push(`[${i}:a]${track.join(',')}[a${i}]`);
    }
    concatStreams.push(audio ? `[v${i}][a${i}]` : `[v${i}]`);
  });
  // Tag on the way OUT of the concat rather than per input: one stamp on the
  // joined stream is what the encoder reads, and stamping each leg would repeat
  // the filter N times for the same result. With an audio leg the concat emits
  // two pads, so the tag can't simply trail the concat — give the video pad its
  // own label and hang the filter off that in both shapes, so there is one code
  // path instead of two.
  // Only a real filter STRING earns the extra link — anything else would splice
  // `[cv]undefined[outv]` into the graph and fail the whole encode, which is a
  // far worse outcome than the untagged output it was meant to improve on.
  const tag = typeof colorTagFilter === 'string' && colorTagFilter ? colorTagFilter : null;
  const videoPad = tag ? '[cv]' : '[outv]';
  filters.push(`${concatStreams.join('')}concat=n=${clips.length}:v=1:a=${audio ? 1 : 0}${videoPad}${audio ? '[outa]' : ''}`);
  if (tag) filters.push(`[cv]${tag}[outv]`);

  return [
    ...clips.flatMap((clip) => ['-i', clip.path]),
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    ...(audio ? ['-map', '[outa]'] : []),
    ...H264_ENCODE_ARGS,
    ...BT709_CONTAINER_ARGS,
    ...(audio ? AAC_ENCODE_ARGS : ['-an']),
    '-movflags', '+faststart',
    '-y', outPath,
  ];
};

// Lossless audio master kept beside an Extend output (see
// `services/videoGen/extendSplice.js`): FLAC at 24-bit, 48 kHz, so the next
// round's source span is decoded from PCM instead of from a prior AAC encode.
const MASTER_AUDIO_ARGS = Object.freeze(['-c:a', 'flac', '-sample_fmt', 's32']);

// The audio half of an Extend splice, shared by the re-encode and stream-copy
// builders. `sourceIdx` is the input carrying the source span's audio (the
// source clip, or its lossless master), `generatedIdx` the render's.
//
// The source span comes from `sourceIdx`, the new span from the render, joined by
// a short LINEAR crossfade (`crossfadeSec`) so the seam doesn't click. The source
// leg runs `crossfadeSec` past the seam so the overlap is source-vs-generated at
// the SAME timeline position, which keeps the output exactly as long as the render.
// Returns the filter chains plus whether a `[outm]` master pad was emitted.
const extendSpliceAudioFilters = ({ audio, sourceIdx, generatedIdx, keep, rate, crossfadeSec, withMaster }) => {
  if (audio !== 'splice' && audio !== 'generated') return [];
  const canonAudio = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const seamSec = keep / rate;
  const fade = Math.max(0.001, Number(crossfadeSec) || 0);
  const mixed = audio === 'splice'
    ? [
      // apad guards a source track that ends before the seam + overlap, which
      // acrossfade would otherwise reject as shorter than the fade.
      `[${sourceIdx}:a]atrim=end=${(seamSec + fade).toFixed(6)},asetpts=PTS-STARTPTS,${canonAudio},apad=whole_dur=${(seamSec + fade).toFixed(6)}[a0]`,
      `[${generatedIdx}:a]atrim=start=${seamSec.toFixed(6)},asetpts=PTS-STARTPTS,${canonAudio}[a1]`,
      `[a0][a1]acrossfade=d=${fade.toFixed(6)}:c1=tri:c2=tri`,
    ]
    : [`[${generatedIdx}:a]asetpts=PTS-STARTPTS,${canonAudio}`];
  // One decoded mix feeds both outputs, so the delivered AAC is encoded once
  // from the same samples the master keeps.
  const last = `${mixed.pop()}${withMaster ? ',asplit=2[outa][outm]' : '[outa]'}`;
  return [...mixed, last];
};

const validExtendSplice = ({ keepFrames, newStartFrame, fps, width, height }) => {
  const keep = Math.floor(Number(keepFrames));
  const start = Math.floor(Number(newStartFrame));
  const rate = Number(fps);
  const canonW = Number(width);
  const canonH = Number(height);
  const ok = Number.isFinite(keep) && keep > 0 && Number.isFinite(start) && start > 0
    && Number.isFinite(rate) && rate > 0 && Number.isFinite(canonW) && canonW > 0
    && Number.isFinite(canonH) && canonH > 0;
  return ok ? { keep, start, rate, canonW, canonH } : null;
};

const extendNormalizeFilter = ({ canonW, canonH, rate }) =>
  `scale=${canonW}:${canonH}:force_original_aspect_ratio=decrease,pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rate}`;

// The two outputs every Extend builder shares: the delivered mp4 (video codec
// args vary by builder) and, when `masterOutPath` is given, the lossless master.
const extendOutputs = ({ audio, videoLabel, videoCodecArgs, outPath, masterOutPath }) => [
  '-map', videoLabel,
  ...(audio === 'none' ? [] : ['-map', '[outa]']),
  ...videoCodecArgs,
  ...(audio === 'none' ? ['-an'] : AAC_ENCODE_ARGS),
  '-movflags', '+faststart',
  '-y', outPath,
  ...(masterOutPath && audio !== 'none' ? ['-map', '[outm]', ...MASTER_AUDIO_ARGS, '-y', masterOutPath] : []),
];

// Build the argv that joins the ORIGINAL source of a native extend render to the
// model's new frames: input 0 is the source clip (kept for frames
// `[0, keepFrames)`), input 1 is the render (kept from `newStartFrame` on).
// Lets a plain Extend deliver the source as shot instead of the model's VAE
// decode of it; `lib/videoContinuity.js#planExtendSplice` supplies the indices.
//
// Video is one single encode of source + new — never a per-round compounding of
// the model's own decode. Geometry and rate normalize to the RENDER's, which is
// what the extension was generated at. Audio follows the same split (see
// `extendSpliceAudioFilters`).
//
// `audio` is 'splice' (both inputs have a track), 'generated' (only the render
// has one — the source region has nothing to keep, so the render's track stands)
// or 'none'. `sourceAudioPath` (optional) is a lossless master standing in for
// the source clip's own track as the source span's audio; `masterOutPath`
// (optional, must end in an audio extension like `.flac`) also writes this
// output's mix as a lossless master. Pure, like buildTrimConcatArgs: the caller
// probes and passes `colorTagFilter` from `bt709TagFilter()`.
export const buildExtendSpliceArgs = ({
  sourcePath, generatedPath, outPath, keepFrames, newStartFrame, width, height, fps,
  audio = 'none', crossfadeSec = 0.04, colorTagFilter = null, sourceAudioPath = null, masterOutPath = null,
}) => {
  if (!sourcePath || !generatedPath || !outPath) return null;
  const geometry = validExtendSplice({ keepFrames, newStartFrame, fps, width, height });
  if (!geometry) return null;
  const { keep, start, rate } = geometry;

  const normalize = extendNormalizeFilter(geometry);
  const tag = typeof colorTagFilter === 'string' && colorTagFilter ? colorTagFilter : null;
  const withMaster = !!masterOutPath && audio !== 'none';
  const filters = [
    `[0:v]trim=end_frame=${keep},setpts=PTS-STARTPTS,${normalize}[v0]`,
    `[1:v]trim=start_frame=${start},setpts=PTS-STARTPTS,${normalize}[v1]`,
    `[v0][v1]concat=n=2:v=1:a=0${tag ? '[cv]' : '[outv]'}`,
    ...(tag ? [`[cv]${tag}[outv]`] : []),
    ...extendSpliceAudioFilters({ audio, sourceIdx: sourceAudioPath ? 2 : 0, generatedIdx: 1, keep, rate, crossfadeSec, withMaster }),
  ];

  return [
    '-i', sourcePath, '-i', generatedPath,
    ...(sourceAudioPath && audio === 'splice' ? ['-i', sourceAudioPath] : []),
    '-filter_complex', filters.join(';'),
    ...extendOutputs({
      audio, videoLabel: '[outv]', outPath, masterOutPath,
      videoCodecArgs: [...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS],
    }),
  ];
};

// Stream-copy counterpart of buildExtendSpliceArgs, in two steps so the source's
// frames stay bit-identical (the re-encode path rewrites them every round).
//
// 1. `buildExtendNewSpanArgs` encodes ONLY the render's new span (frames from
//    `newStartFrame`) as a silent mp4 with the shared H.264 profile — a fresh
//    GOP, so it starts on a keyframe by construction.
// 2. `buildExtendCopyArgs` joins the source (copied, never decoded) to that span
//    through the concat demuxer's `listPath`, pinning the source entry to
//    `keepFrames / fps` so the seam lands on the frame boundary, not on the
//    source file's (audio-padded) container duration. Audio is the same
//    crossfaded mix as the re-encode path.
//
// The caller proves the result (frame count and per-frame hashes) before it
// replaces anything — stream copy is only valid when both halves carry
// compatible codec parameters, which the encode cannot promise on its own.
export const buildExtendNewSpanArgs = ({ generatedPath, outPath, newStartFrame, width, height, fps, colorTagFilter = null }) => {
  if (!generatedPath || !outPath) return null;
  const geometry = validExtendSplice({ keepFrames: 1, newStartFrame, fps, width, height });
  if (!geometry) return null;
  const tag = typeof colorTagFilter === 'string' && colorTagFilter ? colorTagFilter : null;
  return [
    '-i', generatedPath,
    '-filter_complex', `[0:v]trim=start_frame=${geometry.start},setpts=PTS-STARTPTS,${extendNormalizeFilter(geometry)}${tag ? `,${tag}` : ''}[outv]`,
    '-map', '[outv]',
    ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS, '-an',
    '-movflags', '+faststart',
    '-y', outPath,
  ];
};

// One concat-demuxer list entry; single quotes inside a path are escaped per the
// demuxer's own quoting rules.
const concatEntry = (path) => `file '${String(path).replace(/'/g, "'\\''")}'`;

/** Body of the concat-demuxer list for `buildExtendCopyArgs`. */
export const buildExtendConcatList = ({ sourcePath, newSpanPath, keepFrames, fps }) =>
  `${[concatEntry(sourcePath), `duration ${(Number(keepFrames) / Number(fps)).toFixed(6)}`, concatEntry(newSpanPath)].join('\n')}\n`;

export const buildExtendCopyArgs = ({
  listPath, generatedPath, outPath, keepFrames, fps, audio = 'none', crossfadeSec = 0.04,
  sourceAudioPath = null, masterOutPath = null,
}) => {
  const keep = Math.floor(Number(keepFrames));
  const rate = Number(fps);
  if (!listPath || !generatedPath || !outPath) return null;
  if (!Number.isFinite(keep) || keep <= 0 || !Number.isFinite(rate) || rate <= 0) return null;
  // The concat input only carries the source's VIDEO, so a spliced mix names the
  // clip (or its master) that supplies the source span's audio explicitly.
  if (audio === 'splice' && !sourceAudioPath) return null;
  const withMaster = !!masterOutPath && audio !== 'none';
  const filters = extendSpliceAudioFilters({ audio, sourceIdx: 2, generatedIdx: 1, keep, rate, crossfadeSec, withMaster });
  return [
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-i', generatedPath,
    ...(audio === 'splice' ? ['-i', sourceAudioPath] : []),
    ...(filters.length ? ['-filter_complex', filters.join(';')] : []),
    ...extendOutputs({ audio, videoLabel: '0:v:0', outPath, masterOutPath, videoCodecArgs: ['-c:v', 'copy'] }),
  ];
};

// 2× Lanczos upscale of an MP4 in place. Doubles width and height while
// preserving the exact aspect ratio and the audio track. Used as a quick
// post-render export option for LTX renders that come out at sub-720p
// (e.g. 768×512, 640×384) so they read crisply on bigger screens without
// re-running the model. `+faststart` is preserved on the output.
//
// Returns `{ ok: true, outPath }` on success and `{ ok: false, reason }`
// on any failure — callers decide whether to surface the error.
//
// Encoding choice: H.264 yuv420p CRF 18 (visually lossless to most
// viewers, plays everywhere). The audio track is stream-copied so the
// LTX-2 audio bed survives untouched. ffmpeg's lanczos scaler is the
// classical "good default" for upscale — sharper than bicubic, no
// ringing artifacts on smooth gradients.
//
// Concurrency contract: `optimizeForStreaming` and `upscaleVideo2x` both
// rewrite the same file via a sibling tmp + atomic rename. Don't run them
// concurrently against the same path; the queue worker that produces a
// rendered clip already serializes both.
export const upscaleVideo2x = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) {
    return { ok: false, reason: 'invalid video path' };
  }
  if (!existsSync(videoPath)) {
    return { ok: false, reason: 'video file missing' };
  }
  let ffmpeg;
  try {
    ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };
  // -2 keeps the dimension on an even multiple (libx264 requires even
  // dimensions); pairing iw*2:-2 with the lanczos flag gives a clean
  // exact 2× width and the matching height. Avoiding `iw*2:ih*2` because
  // any user-supplied source with an odd dimension would otherwise fail.
  const tmpPath = `${videoPath}.up2x.mp4`;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-i', videoPath,
      '-vf', appendFilter('scale=iw*2:-2:flags=lanczos', await bt709TagFilter()),
      ...H264_ENCODE_ARGS,
      ...BT709_CONTAINER_ARGS,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y', tmpPath,
    ],
  });
  if (!result.ok) {
    await unlink(tmpPath).catch(() => {});
    return { ok: false, reason: 'ffmpeg upscale failed' };
  }
  return installEncodedVideo(tmpPath, videoPath, 'upscaled');
};

// MP4s with the moov atom at the END require browsers to download the entire
// file before they can render the first-frame poster on preload="metadata".
// Remux with -movflags +faststart to move moov to the front. Stream copy —
// no re-encoding.
export const optimizeForStreaming = async (videoPath) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return;
  const tmpPath = `${videoPath}.fs.mp4`;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-i', videoPath, '-c', 'copy', '-movflags', '+faststart', '-y', tmpPath],
  });
  if (!result.ok) { await unlink(tmpPath).catch(() => {}); return; }
  // Best-effort: faststart is a nicety, so a failed install is logged and
  // swallowed rather than surfaced — the original clip is already restored.
  const installed = await installEncodedVideo(tmpPath, videoPath, 'streaming-optimized');
  if (!installed.ok) console.log(`⚠️ ${installed.reason} (at ${videoPath})`);
};

// null means inspection failed; {} means the file was inspected and had no tags.
export async function probeMediaTags(mediaPath) {
  const stdout = await runFfprobe([
    '-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', mediaPath,
  ]);
  if (!stdout) return null;
  try {
    const result = JSON.parse(stdout);
    return Object.assign({}, ...(result.streams || []).map(stream => stream.tags || {}), result.format?.tags || {});
  } catch {
    return null;
  }
}
