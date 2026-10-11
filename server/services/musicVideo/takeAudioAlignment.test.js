/**
 * Performance-take alignment against real ffmpeg (#11210): a provider clip
 * whose soundtrack is the submitted window behind leading padding gets its
 * edit points moved by that padding; a clip without matching audio keeps the
 * planned points.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = mkdtempSync(join(tmpdir(), 'mv-take-align-'));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, music: join(ROOT, 'music') } };
});

const { findFfmpeg, runFfmpegProcess } = await import('../../lib/ffmpeg.js');
const { alignPerformanceInstruction } = await import('./takeAudioAlignment.js');
const ffmpeg = await findFfmpeg();

const RATE = 48000;
const SONG_SEC = 12;
// A sung line: a tone whose loudness jumps at irregular 60–180 ms steps, so
// one stretch of the song never resembles another a fraction of a second off.
function songSamples() {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const samples = new Int16Array(SONG_SEC * RATE);
  let amp = 0;
  let next = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i >= next) { amp = random() < 0.2 ? 0 : 0.05 + random() * 0.6; next = i + Math.round((0.06 + random() * 0.12) * RATE); }
    samples[i] = Math.round(amp * 30000 * Math.sin(2 * Math.PI * 220 * i / RATE));
  }
  return samples;
}

function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(v, 44 + i * 2));
  return buf;
}

const song = songSamples();
const SONG = join(ROOT, 'music', 'song.wav');
const WINDOW = { startSec: 2.003, endSec: 6.203, durationSec: 4.2 };
const instruction = () => ({
  shotMode: 'performance',
  audio: { conditioning: { source: 'master', filename: 'song.wav' } },
  audioWindow: { ...WINDOW },
  edit: { inSec: 0, outSec: 4.2, targetSec: 4.2 },
});

// A 5.05 s provider clip whose audio is `[from, from + 4.2)` of the song after `padSec` of silence.
async function clip(name, { padSec = 0, from = WINDOW.startSec, audio = true }) {
  const out = join(ROOT, name);
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24:duration=5.05'];
  if (audio) {
    const track = new Int16Array(Math.round(5.05 * RATE));
    const start = Math.round(from * RATE);
    track.set(song.subarray(start, start + Math.round(4.2 * RATE)), Math.round(padSec * RATE));
    writeFileSync(`${out}.wav`, wav(track));
    args.push('-i', `${out}.wav`, '-c:a', 'aac');
  }
  args.push('-pix_fmt', 'yuv420p', out);
  const made = await runFfmpegProcess({ bin: ffmpeg, args });
  expect(made.ok).toBe(true);
  return out;
}

describe.skipIf(!ffmpeg)('alignPerformanceInstruction', () => {
  beforeAll(() => {
    mkdirSync(join(ROOT, 'music'), { recursive: true });
    writeFileSync(SONG, wav(song));
  });
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  it('moves the edit points past the clip\'s leading padding and records what it replaced', async () => {
    const aligned = await alignPerformanceInstruction(instruction(), await clip('padded.mp4', { padSec: 0.42 }));
    expect(aligned.alignment).toMatchObject({ method: 'rms-envelope-xcorr', planned: { inSec: 0, outSec: 4.2 } });
    expect(aligned.alignment.correlation).toBeGreaterThan(0.9);
    expect(aligned.alignment.offsetSec).toBeCloseTo(0.42, 1);
    expect(aligned.edit.inSec).toBe(aligned.alignment.offsetSec);
    expect(aligned.edit.outSec).toBeCloseTo(4.2 + aligned.alignment.offsetSec, 6);
    expect(aligned.edit.targetSec).toBe(4.2);
  });

  it('keeps the planned points for a clip in sync, without audio, or with other audio', async () => {
    const inSync = await alignPerformanceInstruction(instruction(), await clip('sync.mp4', { padSec: 0 }));
    expect(inSync.edit).toMatchObject({ inSec: 0, outSec: 4.2 });
    expect(inSync.alignment.offsetSec).toBe(0);
    expect(await alignPerformanceInstruction(instruction(), await clip('silent.mp4', { audio: false }))).toEqual(instruction());
    expect(await alignPerformanceInstruction(instruction(), await clip('other.mp4', { padSec: 0.3, from: 7.5 }))).toEqual(instruction());
  });
});
