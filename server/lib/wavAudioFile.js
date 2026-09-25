/**
 * Land a synthesized 16-bit WAV on disk as game/library-ready audio:
 * `<dir>/<basename>.ogg` (Vorbis via the system ffmpeg) or, when ffmpeg is
 * missing or the encode fails, `<dir>/<basename>.wav`. Shared by the offline
 * renderers of LLM-authored music (chiptune scores, drawn wave sketches).
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
