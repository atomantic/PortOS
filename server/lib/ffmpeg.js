/**
 * Shared ffmpeg helpers used by both videoGen and videoTimeline services.
 *
 * Keeps a single ffmpeg-binary discovery path and the streaming/thumbnail
 * primitives in one place so the two services can't drift on quoting,
 * caching, or rename-safety semantics.
 */

import { execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import { unlink, rename } from 'fs/promises';
import { join, resolve as resolvePath, sep as PATH_SEP, dirname } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { ensureDir, PATHS } from './fileUtils.js';

const execFileAsync = promisify(execFile);
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

// ffmpeg discovery is async (which/where takes ~10ms+) and the result is
// stable for the process lifetime — cache the first hit so subsequent calls
// don't re-shell-out and don't block the event loop.
let cachedFfmpegPath;
export const findFfmpeg = async () => {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;
  const candidates = IS_WIN
    ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
    : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const p of candidates) {
    if (existsSync(p)) { cachedFfmpegPath = p; return p; }
  }
  const cmd = IS_WIN ? 'where' : 'which';
  const { stdout } = await execFileAsync(cmd, ['ffmpeg'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
  cachedFfmpegPath = stdout.trim().split(/\r?\n/)[0] || null;
  return cachedFfmpegPath;
};

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
  const probe = join(dirname(ffmpeg), IS_WIN ? 'ffprobe.exe' : 'ffprobe');
  if (existsSync(probe)) { cachedFfprobePath = probe; return probe; }
  const cmd = IS_WIN ? 'where' : 'which';
  const { stdout } = await execFileAsync(cmd, ['ffprobe'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
  cachedFfprobePath = stdout.trim().split(/\r?\n/)[0] || null;
  return cachedFfprobePath;
};

// Single-video thumbnail extraction at frame 1. Returns the basename on
// success, null when ffmpeg is missing or fails — callers should treat null
// as "no thumbnail" rather than aborting the parent operation.
export const generateThumbnail = async (videoPath, jobId) => {
  await ensureDir(PATHS.videoThumbnails);
  const thumbFilename = `${jobId}.jpg`;
  const thumbPath = join(PATHS.videoThumbnails, thumbFilename);
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ['-i', videoPath, '-vframes', '1', '-q:v', '5', '-y', thumbPath], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0 ? thumbFilename : null));
    proc.on('error', (err) => {
      console.log(`⚠️ ffmpeg thumbnail failed to spawn: ${err.message}`);
      resolve(null);
    });
  });
};

// Probe the video's total frame count. Tries the fast metadata path first
// (`stream=nb_frames`) and falls back to an actual frame count
// (`-count_frames stream=nb_read_frames`) for containers that don't expose
// nb_frames in their header. Returns null when both paths fail or the
// reported count is unusable.
const probeFrameCount = async (videoPath) => {
  const ffprobe = await findFfprobe();
  if (!ffprobe) return null;
  const run = async (countFrames) => {
    const args = [
      '-v', 'error',
      ...(countFrames ? ['-count_frames'] : []),
      '-select_streams', 'v:0',
      '-show_entries', `stream=${countFrames ? 'nb_read_frames' : 'nb_frames'}`,
      '-of', 'default=nokey=1:noprint_wrappers=1',
      videoPath,
    ];
    const { stdout } = await execFileAsync(ffprobe, args, { timeout: 15000 }).catch(() => ({ stdout: '' }));
    const n = parseInt((stdout || '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return (await run(false)) ?? (await run(true));
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
  // separators. `-vsync vfr` prevents the image2 muxer from padding output
  // to maintain input fps (which would re-emit each match repeatedly).
  const selectExpr = frameIndices.map((i) => `eq(n,${i})`).join('+');
  const outPattern = join(PATHS.videoThumbnails, `${jobId}-f%d.jpg`);

  const ok = await new Promise((resolve) => {
    const proc = spawn(ffmpeg, [
      '-i', videoPath,
      '-vf', `select='${selectExpr}'`,
      '-vsync', 'vfr',
      '-q:v', '5',
      '-y',
      outPattern,
    ], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', (err) => {
      console.log(`⚠️ ffmpeg multi-frame extract failed to spawn: ${err.message}`);
      resolve(false);
    });
  });

  if (!ok) return [];
  // ffmpeg's image2 muxer numbers output starting at 1 in match order, so
  // the basenames map 1:1 to our frameIndices in timeline order.
  return frameIndices.map((_, i) => `${jobId}-f${i + 1}.jpg`);
};

// MP4s with the moov atom at the END require browsers to download the entire
// file before they can render the first-frame poster on preload="metadata".
// Remux with -movflags +faststart to move moov to the front. Stream copy —
// no re-encoding.
export const optimizeForStreaming = async (videoPath) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return;
  const tmpPath = `${videoPath}.fs.mp4`;
  const ok = await new Promise((resolve) => {
    const proc = spawn(ffmpeg, ['-i', videoPath, '-c', 'copy', '-movflags', '+faststart', '-y', tmpPath], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
  if (!ok) { await unlink(tmpPath).catch(() => {}); return; }
  // POSIX rename atomically replaces an existing dest in one syscall. On
  // Windows, fs.rename fails when the destination already exists — but a
  // simple unlink-first would destroy the rendered video if the subsequent
  // rename failed (locked file, AV scan, transient permissions). Move the
  // original aside to a .bak first, then install the optimized file, and
  // restore the backup on any failure so the worst case is "faststart
  // skipped", not "rendered video lost".
  let backupPath = null;
  try {
    if (IS_WIN) {
      backupPath = `${videoPath}.bak.${randomUUID()}`;
      await rename(videoPath, backupPath).catch((err) => {
        if (err?.code === 'ENOENT') { backupPath = null; return; }
        throw err;
      });
    }
    await rename(tmpPath, videoPath);
    if (backupPath) await unlink(backupPath).catch(() => {});
  } catch (err) {
    if (backupPath) await rename(backupPath, videoPath).catch(() => {});
    await unlink(tmpPath).catch(() => {});
    console.log(`⚠️ Failed to install streaming-optimized video at ${videoPath}: ${err.message}`);
  }
};
