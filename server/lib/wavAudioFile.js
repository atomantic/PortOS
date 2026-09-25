/**
 * Land a synthesized 16-bit WAV on disk as game/library-ready audio:
 * `<dir>/<basename>.ogg` (Vorbis via the system ffmpeg) or, when ffmpeg is
 * missing or the encode fails, `<dir>/<basename>.wav`. Shared by the offline
 * renderers of LLM-authored music (chiptune scores, drawn wave sketches) and
 * the Music Designer code engine's browser-recorded takes.
 */

import { join } from 'path';
import { atomicWrite, unlinkGuarded } from './fileUtils.js';
import { findFfmpeg, runFfmpegProcess } from './ffmpeg.js';

/** Write `wav` (a WAV Buffer) into `dir`; resolves to the filename used. */
export async function writeWavAudioFile(wav, dir, basename) {
  const wavPath = join(dir, `${basename}.wav`);
  const oggPath = join(dir, `${basename}.ogg`);
  await atomicWrite(wavPath, wav); // ensureDir + temp-rename
  const bin = await findFfmpeg();
  if (!bin) {
    // WAV fallback: drop any stale <basename>.ogg from an earlier
    // ffmpeg-equipped write, or a consumer still referencing it would play the
    // old audio while the source says otherwise.
    await unlinkGuarded(oggPath).catch(() => {});
    return `${basename}.wav`;
  }
  const result = await runFfmpegProcess({ bin, args: ['-y', '-i', wavPath, '-c:a', 'libvorbis', '-q:a', '5', oggPath] });
  if (!result.ok) {
    console.error(`❌ OGG encode failed (keeping WAV): ${result.reason}`);
    await unlinkGuarded(oggPath).catch(() => {}); // stale or partial encode output
    return `${basename}.wav`;
  }
  await unlinkGuarded(wavPath).catch(() => {});
  return `${basename}.ogg`;
}

/**
 * Compute the playback duration (ms) of a PCM WAV buffer by reading its
 * canonical RIFF header — `data` chunk size ÷ `fmt ` byte rate. Used by the
 * narration timeline (karaoke-style highlight sync) where the client needs a
 * per-segment duration without decoding the audio itself, and to validate an
 * uploaded code-engine take (a non-WAV body measures 0).
 *
 * Pure + defensive: scans the sub-chunk list (the `fmt ` and `data` chunks
 * aren't guaranteed to be adjacent or first), and returns 0 for anything that
 * isn't a parseable WAV so a malformed buffer degrades to "unknown length"
 * instead of throwing into the synth path.
 */
export function wavDurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 0;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(body + 8);
    } else if (id === 'data') {
      // Clamp to the bytes actually present — a truncated stream can carry a
      // larger declared size than the buffer holds.
      dataSize = Math.min(size, buffer.length - body);
    }
    // Chunks are word-aligned: an odd size carries a trailing pad byte.
    offset = body + size + (size % 2);
  }
  if (!byteRate || !dataSize) return 0;
  return Math.round((dataSize / byteRate) * 1000);
}
