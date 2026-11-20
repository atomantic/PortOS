/**
 * A shot's clip sound over the song, mixed by real ffmpeg: with the shot's
 * fade in and fade out the clip sound rises and falls over those seconds, and
 * the song's dip under it ramps with the same fades instead of stepping.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { normalizeClipSound, clipSoundSummary } from '../../lib/musicVideo/musicVideoClipSound.js';
import { buildSongAudioMix, clipSoundDuck, clipSoundVoice } from './clipSoundMix.js';

const RATE = 8000;
// A mono 16-bit PCM WAV: silence, or a square wave at `amp` (0–1).
const wav = (seconds, amp = 0) => {
  const samples = Math.round(seconds * RATE);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(Math.round((Math.floor(i / 20) % 2 ? 1 : -1) * amp * 30000), 44 + i * 2);
  return buf;
};

const ffmpeg = await findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'portos-clip-sound-mix-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Mean level (dBFS) of `path` between `from` and `to` seconds.
async function meanDb(path, from, to) {
  const { stderr } = await runFfmpegProcess({
    bin: ffmpeg, returnStderr: true, stderrTailBytes: 20000,
    args: ['-hide_banner', '-i', path, '-af', `atrim=start=${from}:end=${to},volumedetect`, '-f', 'null', '-'],
  });
  const match = /mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
  return match ? Number(match[1]) : -Infinity;
}

async function mix(clipSound, { songAmp, clipAmp }) {
  const song = join(dir, `song-${songAmp}.wav`);
  const line = join(dir, `line-${clipAmp}.wav`);
  writeFileSync(song, wav(8, songAmp));
  writeFileSync(line, wav(4, clipAmp));
  const voice = clipSoundVoice({ sceneId: 's1', assetPath: line, offsetSec: 0, startSec: 2, durationSec: 4, clipSound });
  const built = buildSongAudioMix({ mainLabel: '[0:a]', voices: [voice], firstInputIdx: 1, durationSec: 8, outLabel: '[mixa]' });
  const out = join(dir, `mix-${Math.random().toString(36).slice(2)}.wav`);
  const result = await runFfmpegProcess({ bin: ffmpeg, args: ['-hide_banner', '-loglevel', 'error', '-i', song, ...built.inputs,
    '-filter_complex', built.filters.join(';'), '-map', '[mixa]', '-y', out] });
  expect(result.ok).toBe(true);
  return out;
}

describe('clip sound fades', () => {
  it('stores a fade only when it is set, and names it in the summary', () => {
    expect(normalizeClipSound({ volume: 1, musicLevel: 0.5 })).toEqual({ volume: 1, musicLevel: 0.5 });
    expect(normalizeClipSound({ volume: 1, musicLevel: 0.5, fadeInSec: 1.5, fadeOutSec: 0 })).toEqual({ volume: 1, musicLevel: 0.5, fadeInSec: 1.5 });
    expect(normalizeClipSound({ fadeInSec: 99, fadeOutSec: -3 })).toMatchObject({ fadeInSec: 10 });
    expect(clipSoundSummary({ startSec: 0, endSec: 4, clipSound: { volume: 1, musicLevel: 0.5, fadeInSec: 0.5, fadeOutSec: 2 } }))
      .toBe('Clip sound 100% · music 50% · fade 0.5s in, 2s out');
  });

  it('steps the song dip when the shot has no fade, as before', () => {
    const voice = clipSoundVoice({ startSec: 2, durationSec: 4, offsetSec: 0, clipSound: { volume: 1, musicLevel: 0.4 } });
    expect(voice).toMatchObject({ fadeInSec: 0.03, fadeOutSec: 0.03 });
    expect(clipSoundDuck(voice)).toBe("volume=enable='between(t,2,6)':volume=0.4");
  });

  it('keeps both fades inside a short sound', () => {
    expect(clipSoundVoice({ startSec: 0, durationSec: 2, offsetSec: 0, clipSound: { volume: 1, musicLevel: 1, fadeInSec: 3, fadeOutSec: 3 } }))
      .toMatchObject({ fadeInSec: 1, fadeOutSec: 1 });
  });

  it.skipIf(!ffmpeg)('ramps the clip sound in and out over its fades', async () => {
    const out = await mix({ volume: 1, musicLevel: 1, fadeInSec: 2, fadeOutSec: 1 }, { songAmp: 0, clipAmp: 0.5 });
    const early = await meanDb(out, 2.05, 2.4);
    const full = await meanDb(out, 4.2, 4.8);
    const late = await meanDb(out, 5.7, 5.95);
    expect(full - early).toBeGreaterThan(10);
    expect(full - late).toBeGreaterThan(6);
    expect(await meanDb(out, 6.2, 7.8)).toBeLessThan(-60);
  });

  it.skipIf(!ffmpeg)('ramps the song down under a fading clip sound instead of stepping', async () => {
    const out = await mix({ volume: 0.05, musicLevel: 0, fadeInSec: 1, fadeOutSec: 1 }, { songAmp: 0.5, clipAmp: 0 });
    const before = await meanDb(out, 0.5, 1.5);
    // Half way into the fade the song is at about half level (−6 dB), not cut to silence.
    const halfway = await meanDb(out, 2.45, 2.55);
    expect(before - halfway).toBeGreaterThan(3);
    expect(before - halfway).toBeLessThan(12);
    // Between the fades the song is all the way down.
    expect(await meanDb(out, 3.2, 4.8)).toBeLessThan(-60);
    expect(Math.abs(await meanDb(out, 6.5, 7.5) - before)).toBeLessThan(1);
  });
});
