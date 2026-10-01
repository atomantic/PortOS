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
 * Locate a RIFF/WAVE buffer's `fmt ` and `data` chunks. Scans the whole
 * sub-chunk list (the two are not guaranteed to be adjacent or first) and
 * clamps `data` to the bytes actually present — a truncated stream can carry a
 * larger declared size than the buffer holds. Null for anything not RIFF/WAVE.
 */
function findWavChunks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) fmt = { offset: body, size };
    else if (id === 'data') data = { offset: body, size: Math.min(size, buffer.length - body) };
    // Chunks are word-aligned: an odd size carries a trailing pad byte.
    offset = body + size + (size % 2);
  }
  return { fmt, data };
}

/**
 * Compute the playback duration (ms) of a PCM WAV buffer by reading its
 * canonical RIFF header — `data` chunk size ÷ `fmt ` byte rate. Used by the
 * narration timeline (karaoke-style highlight sync) where the client needs a
 * per-segment duration without decoding the audio itself, and to validate an
 * uploaded code-engine take (a non-WAV body measures 0).
 *
 * Pure + defensive: returns 0 for anything that isn't a parseable WAV so a
 * malformed buffer degrades to "unknown length" instead of throwing into the
 * synth path.
 */
export function wavDurationMs(buffer) {
  const chunks = findWavChunks(buffer);
  if (!chunks?.fmt || !chunks.data) return 0;
  const byteRate = buffer.readUInt32LE(chunks.fmt.offset + 8);
  if (!byteRate || !chunks.data.size) return 0;
  return Math.round((chunks.data.size / byteRate) * 1000);
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Sample decoder for one (format, bit depth) pair, normalized to [-1, 1]; null when unsupported. */
function sampleReader(format, bits) {
  if (format === WAVE_FORMAT_PCM && bits === 16) return (buf, at) => buf.readInt16LE(at) / 32768;
  if (format === WAVE_FORMAT_PCM && bits === 24) return (buf, at) => buf.readIntLE(at, 3) / 8388608;
  if (format === WAVE_FORMAT_PCM && bits === 32) return (buf, at) => buf.readInt32LE(at) / 2147483648;
  if (format === WAVE_FORMAT_IEEE_FLOAT && bits === 32) return (buf, at) => buf.readFloatLE(at);
  if (format === WAVE_FORMAT_IEEE_FLOAT && bits === 64) return (buf, at) => buf.readDoubleLE(at);
  return null;
}

/**
 * Decode a rendered WAV and measure what is actually in it, so a native
 * renderer's output is judged by its samples rather than by the score it was
 * asked to play: `{ channels, sampleRate, bitsPerSample, float, frames,
 * durationMs, peak, rms, nonFinite }`. `peak`/`rms` are over every finite
 * sample, normalized to full scale; `nonFinite` counts NaN/Infinity samples (a
 * float render can carry them). Accepts PCM 16/24/32-bit and IEEE float 32/64,
 * including WAVE_FORMAT_EXTENSIBLE. Null for anything else — never throws.
 */
export function measureWavAudio(buffer) {
  const chunks = findWavChunks(buffer);
  if (!chunks?.fmt || !chunks.data) return null;
  const { offset } = chunks.fmt;
  let format = buffer.readUInt16LE(offset);
  const channels = buffer.readUInt16LE(offset + 2);
  const sampleRate = buffer.readUInt32LE(offset + 4);
  const blockAlign = buffer.readUInt16LE(offset + 12);
  const bitsPerSample = buffer.readUInt16LE(offset + 14);
  // EXTENSIBLE carries the real format as the first two bytes of its subformat GUID.
  if (format === WAVE_FORMAT_EXTENSIBLE && chunks.fmt.size >= 40 && offset + 26 <= buffer.length) {
    format = buffer.readUInt16LE(offset + 24);
  }
  const read = sampleReader(format, bitsPerSample);
  const bytesPerSample = bitsPerSample / 8;
  if (!read || !channels || !sampleRate || blockAlign !== channels * bytesPerSample) return null;
  const frames = Math.floor(chunks.data.size / blockAlign);
  let peak = 0;
  let sumSquares = 0;
  let finite = 0;
  let nonFinite = 0;
  const end = chunks.data.offset + frames * blockAlign;
  for (let at = chunks.data.offset; at < end; at += bytesPerSample) {
    const sample = read(buffer, at);
    if (!Number.isFinite(sample)) { nonFinite += 1; continue; }
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    sumSquares += sample * sample;
    finite += 1;
  }
  return {
    channels,
    sampleRate,
    bitsPerSample,
    float: format === WAVE_FORMAT_IEEE_FLOAT,
    frames,
    durationMs: Math.round((frames / sampleRate) * 1000),
    peak,
    rms: finite ? Math.sqrt(sumSquares / finite) : 0,
    nonFinite,
  };
}
