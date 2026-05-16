/**
 * Pipeline audio mux — second-pass overlay of pipeline-stage audio onto the
 * already-stitched episode video.
 *
 * Phase 4d v1 covers **background-music bedding**: stripping the timeline's
 * silent track and laying the user-picked music file underneath the video at
 * a configurable gain. The music loops to fill the video length and is cut
 * to match the video duration. VO line muxing (4d.2) lands on top of this
 * same module — the helper signature already accepts `voLines` for that.
 *
 * Failure handling: this is a value-add overlay, not a correctness gate. If
 * the mux pass throws (ffmpeg missing, malformed audio, etc.), callers
 * should log and leave the silent video in place — graceful degradation
 * beats blocking the whole stitch on an optional cosmetic step.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { rename, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { statMusicTrack } from './musicLibrary.js';

// 0.5 ≈ -6 dB — quiet enough to sit under dialogue once VO mixing lands
// (4d.2), but not so quiet the user wonders if it's there.
const DEFAULT_MUSIC_GAIN = 0.5;

/**
 * Resolve a library music filename to its absolute path on disk, or null
 * when the file is missing / the filename fails validation. Graceful
 * degradation: callers should fall through to the silent video.
 */
export async function resolveMusicTrackPath(trackFilename) {
  const entry = await statMusicTrack(trackFilename).catch(() => null);
  return entry ? join(PATHS.music, entry.filename) : null;
}

/**
 * Mix a music bed onto `inputVideoPath`, replacing the file in place.
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on failure.
 * `musicGain` is a linear amplitude (1.0 = full volume); default ~-6 dB.
 */
export async function muxMusicBed(inputVideoPath, { musicPath, musicGain = DEFAULT_MUSIC_GAIN, signal } = {}) {
  if (!inputVideoPath || !existsSync(inputVideoPath)) {
    return { ok: false, reason: 'input video missing' };
  }
  if (!musicPath || !existsSync(musicPath)) {
    return { ok: false, reason: 'music track missing' };
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not on PATH' };

  // UUID suffix keeps parallel mux passes against the same file from
  // racing on the temp output — single-instance today, but the cost of
  // the UUID is one stack alloc.
  const tmpOut = `${inputVideoPath}.muxing.${randomUUID()}.mp4`;
  const args = [
    '-i', inputVideoPath,
    '-stream_loop', '-1',
    '-i', musicPath,
    '-filter_complex', `[1:a]volume=${Number(musicGain).toFixed(3)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[bed]`,
    '-map', '0:v',
    '-map', '[bed]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-y',
    tmpOut,
  ];

  const result = await runFfmpeg(ffmpeg, args, { signal });
  if (!result.ok) {
    await unlink(tmpOut).catch(() => {});
    return result;
  }
  // Rename only after ffmpeg confirms success — a crashed mux pass leaves
  // the silent original intact rather than a half-written video.
  await rename(tmpOut, inputVideoPath);
  return { ok: true };
}

function runFfmpeg(bin, args, { signal } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    const STDERR_TAIL_MAX = 2000;
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > STDERR_TAIL_MAX) {
        stderrTail = stderrTail.slice(-STDERR_TAIL_MAX);
      }
    });
    proc.on('error', (err) => resolve({ ok: false, reason: `spawn failed: ${err.message}` }));
    proc.on('close', (code, sig) => {
      if (sig === 'SIGTERM' || sig === 'SIGKILL') {
        resolve({ ok: false, reason: `cancelled (${sig})` });
        return;
      }
      if (code !== 0) {
        const tail = stderrTail.split(/\r?\n/).slice(-4).join(' | ');
        resolve({ ok: false, reason: `ffmpeg exit ${code}: ${tail}` });
        return;
      }
      resolve({ ok: true });
    });
    if (signal) {
      signal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true });
    }
  });
}

export { DEFAULT_MUSIC_GAIN };
