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
import { join, resolve as resolvePath, sep as PATH_SEP } from 'path';
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
  const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/, IS_WIN ? 'ffprobe.exe' : 'ffprobe');
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
