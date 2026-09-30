/**
 * Window fingerprints against real ffmpeg (#9266): a lossy re-encode of the
 * same master must compare as the same audio, and a changed stretch must not.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg } from './ffmpeg.js';
import { compareWindowFingerprint, computeRmsEnvelope, windowFingerprint } from './audioFingerprint.js';

const ffmpeg = await findFfmpeg();
const RATE = 48000;
const SONG_SEC = 10;
const dir = await mkdtemp(join(tmpdir(), 'portos-audio-fp-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

// A "sung" line: a 220 Hz tone whose loudness steps every 250 ms through a
// fixed pattern, so the window has a real envelope shape to correlate.
// `silence` blanks [startSec, endSec) — the changed bar of a new mix.
function songWav({ silence = null, steady = false } = {}) {
  const samples = SONG_SEC * RATE;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  const levels = [0.05, 0.4, 0.15, 0.7, 0.25, 0.02, 0.5, 0.1];
  for (let i = 0; i < samples; i++) {
    const t = i / RATE;
    const muted = silence && t >= silence.startSec && t < silence.endSec;
    const amp = muted ? 0 : steady ? 0.3 : levels[Math.floor(t * 4) % levels.length];
    buf.writeInt16LE(Math.round(amp * 30000 * Math.sin(2 * Math.PI * 220 * t)), 44 + i * 2);
  }
  return buf;
}

const WINDOW = { startSec: 2.225, endSec: 7.275 };

describe.skipIf(!ffmpeg)('audio window fingerprints', () => {
  it('matches a lossy re-encode of the same window and rejects a changed one', async () => {
    const master = join(dir, 'master.wav');
    await writeFile(master, songWav());
    const fp = windowFingerprint(await computeRmsEnvelope(master), WINDOW);
    // Frames on the song's own 100 Hz grid, fully inside the window.
    expect(fp).toMatchObject({ version: 1, rateHz: 100, startFrame: 223 });
    expect(Buffer.from(fp.db, 'base64')).toHaveLength(727 - 223);

    // The same master through AAC — codec noise, no content change.
    const reencoded = join(dir, 'master.m4a');
    execFileSync(ffmpeg, ['-v', 'error', '-i', master, '-c:a', 'aac', '-b:a', '128k', '-y', reencoded]);
    const aac = compareWindowFingerprint(fp, await computeRmsEnvelope(reencoded));
    expect(aac.same).toBe(true);
    expect(aac.correlation).toBeGreaterThan(0.98);

    // A new mix whose change sits outside the window keeps the window; one
    // that blanks a second inside it does not.
    const outside = join(dir, 'outside.wav');
    await writeFile(outside, songWav({ silence: { startSec: 8, endSec: 9 } }));
    expect(compareWindowFingerprint(fp, await computeRmsEnvelope(outside)).same).toBe(true);
    const inside = join(dir, 'inside.wav');
    await writeFile(inside, songWav({ silence: { startSec: 4, endSec: 5 } }));
    expect(compareWindowFingerprint(fp, await computeRmsEnvelope(inside)).same).toBe(false);
  }, 30_000);

  it('catches a short local change in a window with no loudness shape to correlate', async () => {
    const master = join(dir, 'steady.wav');
    await writeFile(master, songWav({ steady: true }));
    const fp = windowFingerprint(await computeRmsEnvelope(master), { startSec: 0, endSec: SONG_SEC });
    const reencoded = join(dir, 'steady.m4a');
    execFileSync(ffmpeg, ['-v', 'error', '-i', master, '-c:a', 'aac', '-b:a', '128k', '-y', reencoded]);
    expect(compareWindowFingerprint(fp, await computeRmsEnvelope(reencoded)).same).toBe(true);
    // A quarter second blanked moves the window mean under 1.5 dB, but not unnoticed.
    const dropped = join(dir, 'steady-dropped.wav');
    await writeFile(dropped, songWav({ steady: true, silence: { startSec: 4, endSec: 4.27 } }));
    const verdict = compareWindowFingerprint(fp, await computeRmsEnvelope(dropped));
    expect(verdict.meanDeltaDb).toBeLessThan(1.5);
    expect(verdict.same).toBe(false);
  }, 30_000);

  it('keeps a dense, low-shape window whose re-encode only jitters each frame by about 1 dB', () => {
    // A compressed chorus: ±3 dB of loudness shape around -18 dBFS for 5 s.
    const frames = 505;
    const base = new Int8Array(frames);
    for (let i = 0; i < frames; i++) base[i] = Math.round(-18 + 3 * Math.sin(i / 7) + 1.5 * Math.sin(i / 2.3));
    const fp = windowFingerprint(base, { startSec: 0, endSec: frames / 100 });
    // A re-encode: every frame off by -1, 0 or +1 dB in a fixed pseudo-random pattern.
    const jittered = Int8Array.from(base, (v, i) => v + [-1, 0, 1, 1, 0, -1, 0][(i * 5) % 7]);
    const verdict = compareWindowFingerprint(fp, jittered);
    expect(verdict.correlation).toBeLessThan(0.98);
    expect(verdict.same).toBe(true);
    // The same window with a bar dropped 12 dB is still a change.
    const edited = Int8Array.from(base, (v, i) => (i >= 200 && i < 260 ? v - 12 : v));
    expect(compareWindowFingerprint(fp, edited).same).toBe(false);
  });

  it('treats a song that no longer reaches the window, or an unreadable fingerprint, as changed', async () => {
    const master = join(dir, 'short-master.wav');
    await writeFile(master, songWav());
    const envelope = await computeRmsEnvelope(master);
    expect(windowFingerprint(envelope, { startSec: 8, endSec: 12 })).toBeNull();
    const fp = windowFingerprint(envelope, WINDOW);
    expect(compareWindowFingerprint(fp, envelope.slice(0, 500)).same).toBe(false);
    expect(compareWindowFingerprint({ ...fp, version: 99 }, envelope).same).toBe(false);
    expect(compareWindowFingerprint(null, envelope).same).toBe(false);
  }, 30_000);
});
