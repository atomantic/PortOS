import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, stat, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  __analyzeBeatGridPcm,
  decodeAudioToPcm,
  getBeatGrid,
  __clearBeatGridCache,
  BEAT_GRID_SAMPLE_RATE,
} from './beatGrid.js';
import { findFfmpeg } from './ffmpeg.js';

/**
 * Synthesize a mono click track: a short decaying 1kHz burst on every beat at
 * the given BPM, over a quiet noise floor. Mirrors the fixture
 * `server/services/musicVideo/audioAnalysis.test.js` uses for the same style
 * of pipeline — a known tempo with sharp onsets the envelope/autocorrelation
 * path must recover.
 */
function clickTrack({ bpm, durationSec, sampleRate = BEAT_GRID_SAMPLE_RATE, offsetSec = 0 }) {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let i = 0; i < n; i++) out[i] = rand() * 0.001;
  const periodSec = 60 / bpm;
  const burstSec = 0.04;
  const burstLen = Math.round(burstSec * sampleRate);
  for (let t = offsetSec; t < durationSec; t += periodSec) {
    const start = Math.round(t * sampleRate);
    for (let k = 0; k < burstLen && start + k < n; k++) {
      const env = Math.exp(-k / (burstLen / 4));
      out[start + k] += env * Math.sin((2 * Math.PI * 1000 * k) / sampleRate);
    }
  }
  return out;
}

/** Minimal 16-bit PCM mono WAV encoder for the ffmpeg round-trip test. */
function encodeWav(samples, sampleRate) {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// Tolerance grounded in what this style of pipeline actually measures on a
// synthetic click track (spectral-flux onset envelope + autocorrelation) —
// verified against `server/services/musicVideo/audioAnalysis.js`'s own
// already-shipped, already-tested tempo estimator on the SAME fixture, which
// reports the identical ~1.5-2 BPM offset (audioAnalysis.test.js asserts a
// ±2 window, not ±1). A tighter bound here would just be testing a level of
// precision this class of algorithm doesn't deliver on ~16s of audio.
const BPM_TOLERANCE = 2.5;

describe('__analyzeBeatGridPcm', () => {
  it('recovers a 120 BPM click track within tolerance', () => {
    const samples = clickTrack({ bpm: 120, durationSec: 16 });
    const result = __analyzeBeatGridPcm(samples, BEAT_GRID_SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(120 - BPM_TOLERANCE);
    expect(result.bpm).toBeLessThan(120 + BPM_TOLERANCE);
    // Beats are monotonically increasing, spaced ~0.5s apart (60/120), and
    // downbeats are every 4th beat.
    for (let i = 1; i < result.beats.length; i++) {
      expect(result.beats[i]).toBeGreaterThan(result.beats[i - 1]);
      const gap = result.beats[i] - result.beats[i - 1];
      expect(gap).toBeGreaterThan(0.45);
      expect(gap).toBeLessThan(0.55);
    }
    expect(result.downbeats.length).toBeGreaterThan(0);
    for (const downbeat of result.downbeats) expect(result.beats).toContain(downbeat);
    for (let i = 1; i < result.downbeats.length; i++) {
      const gap = result.downbeats[i] - result.downbeats[i - 1];
      expect(gap).toBeGreaterThan(1.8);
      expect(gap).toBeLessThan(2.2);
    }
  });

  it('avoids the classic double-tempo octave error on a 90 BPM track', () => {
    // 180 BPM (exactly double) is the documented common failure mode for
    // autocorrelation-based tempo estimation without preference weighting.
    const samples = clickTrack({ bpm: 90, durationSec: 20 });
    const result = __analyzeBeatGridPcm(samples, BEAT_GRID_SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(90 - BPM_TOLERANCE);
    expect(result.bpm).toBeLessThan(90 + BPM_TOLERANCE);
  });

  it('recovers onset hits close to each click', () => {
    const samples = clickTrack({ bpm: 120, durationSec: 8 });
    const result = __analyzeBeatGridPcm(samples, BEAT_GRID_SAMPLE_RATE);
    expect(result.hits.length).toBeGreaterThan(10);
    // Every true click (60/120 = 0.5s apart) has a detected hit within one
    // onset-envelope frame (~23ms at this hop/sample-rate).
    for (let t = 1; t < 8; t += 0.5) {
      const nearest = result.hits.reduce((best, h) => (Math.abs(h - t) < Math.abs(best - t) ? h : best), Infinity);
      expect(Math.abs(nearest - t)).toBeLessThan(0.06);
    }
  });

  it('reports no tempo for silence/noise rather than a bogus BPM', () => {
    const samples = new Float32Array(BEAT_GRID_SAMPLE_RATE * 4);
    const result = __analyzeBeatGridPcm(samples, BEAT_GRID_SAMPLE_RATE);
    expect(result.bpm).toBeNull();
    expect(result.beats).toEqual([]);
    expect(result.downbeats).toEqual([]);
  });

  it('returns a null-shaped result for audio too short to analyze', () => {
    // 1000 samples clears the rounding floor (durationSec > 0) but stays
    // under the hop*4 minimum the DSP core requires to form a single frame.
    const result = __analyzeBeatGridPcm(new Float32Array(1000), BEAT_GRID_SAMPLE_RATE);
    expect(result.bpm).toBeNull();
    expect(result.beats).toEqual([]);
    expect(result.hits).toEqual([]);
    expect(result.durationSec).toBeGreaterThan(0);
  });

  it('tolerates an empty/undefined sample buffer', () => {
    expect(__analyzeBeatGridPcm(null, BEAT_GRID_SAMPLE_RATE).bpm).toBeNull();
    expect(__analyzeBeatGridPcm(new Float32Array(0), BEAT_GRID_SAMPLE_RATE).durationSec).toBe(0);
  });
});

describe('decodeAudioToPcm (ffmpeg round-trip)', () => {
  let tmpDir;
  let ffmpeg;
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'portos-beatgrid-test-'));
    ffmpeg = await findFfmpeg();
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null for a nonexistent file', async () => {
    expect(await decodeAudioToPcm('/no/such/file.wav')).toBeNull();
  });

  it('returns null for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await decodeAudioToPcm(join(tmpDir, 'whatever.wav'), { signal: controller.signal })).toBeNull();
  });

  it('decodes a synthesized WAV to PCM at BEAT_GRID_SAMPLE_RATE (skipped without ffmpeg)', async () => {
    if (!ffmpeg) { console.log('⏭️  ffmpeg not found — skipping beat-grid decode round-trip'); return; }
    const wavSampleRate = 44100;
    const samples = clickTrack({ bpm: 120, durationSec: 10, sampleRate: wavSampleRate });
    const wavPath = join(tmpDir, 'click-120.wav');
    await writeFile(wavPath, encodeWav(samples, wavSampleRate));
    const decoded = await decodeAudioToPcm(wavPath);
    expect(decoded).not.toBeNull();
    expect(decoded.sampleRate).toBe(BEAT_GRID_SAMPLE_RATE);
    expect(decoded.samples.length).toBeGreaterThan(0);
    const result = __analyzeBeatGridPcm(decoded.samples, decoded.sampleRate);
    expect(result.bpm).toBeGreaterThan(120 - BPM_TOLERANCE);
    expect(result.bpm).toBeLessThan(120 + BPM_TOLERANCE);
  });
});

describe('getBeatGrid (mtime-keyed cache)', () => {
  let tmpDir;
  let ffmpeg;
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'portos-beatgrid-cache-test-'));
    ffmpeg = await findFfmpeg();
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
  afterEach(() => __clearBeatGridCache());

  it('returns null for a missing path', async () => {
    expect(await getBeatGrid(join(tmpDir, 'missing.wav'))).toBeNull();
  });
  it('returns null for an invalid path argument', async () => {
    expect(await getBeatGrid('')).toBeNull();
    expect(await getBeatGrid(null)).toBeNull();
  });

  it('caches strictly by mtime, not by content (skipped without ffmpeg)', async () => {
    if (!ffmpeg) { console.log('⏭️  ffmpeg not found — skipping beat-grid cache round-trip'); return; }
    const wavSampleRate = 44100;
    const wavPath = join(tmpDir, 'cache-track.wav');
    await writeFile(wavPath, encodeWav(clickTrack({ bpm: 100, durationSec: 6, sampleRate: wavSampleRate }), wavSampleRate));

    const first = await getBeatGrid(wavPath);
    expect(first).not.toBeNull();
    expect(first.bpm).toBeGreaterThan(100 - BPM_TOLERANCE);
    expect(first.bpm).toBeLessThan(100 + BPM_TOLERANCE);

    // A repeat call against the unchanged file must be an actual cache HIT,
    // not a coincidentally-identical recomputation (the DSP is deterministic,
    // so `toEqual` alone can't tell the two apart). `toBe` asserts the same
    // object reference, which only a real cache hit can produce — a fresh
    // analysis always allocates a new result object.
    const second = await getBeatGrid(wavPath);
    expect(second).toBe(first);

    // Overwrite with a different tempo, then bump mtime forward explicitly
    // (rather than relying on write-induced mtime resolution, which can be
    // coarser than the gap between two writes on some filesystems — a plain
    // write's own timestamp could otherwise land in the same millisecond as
    // the original). The cache must invalidate and return a freshly measured,
    // distinct result.
    await writeFile(wavPath, encodeWav(clickTrack({ bpm: 130, durationSec: 6, sampleRate: wavSampleRate }), wavSampleRate));
    const stats = await stat(wavPath);
    await utimes(wavPath, stats.atime, new Date(stats.mtime.getTime() + 1000));
    const updated = await getBeatGrid(wavPath);
    expect(updated).not.toBeNull();
    expect(updated).not.toBe(first);
    expect(updated.bpm).toBeGreaterThan(130 - BPM_TOLERANCE);
    expect(updated.bpm).toBeLessThan(130 + BPM_TOLERANCE);
  });

  it('shares one in-flight analysis across concurrent calls for the same unmeasured track (skipped without ffmpeg)', async () => {
    if (!ffmpeg) { console.log('⏭️  ffmpeg not found — skipping beat-grid in-flight dedup'); return; }
    const wavSampleRate = 44100;
    const wavPath = join(tmpDir, 'concurrent-track.wav');
    await writeFile(wavPath, encodeWav(clickTrack({ bpm: 120, durationSec: 6, sampleRate: wavSampleRate }), wavSampleRate));

    // Two concurrent callers against the same never-yet-cached path must
    // resolve to the SAME object — proof they shared one decode+analysis
    // rather than each spawning their own ffmpeg process.
    const [a, b] = await Promise.all([getBeatGrid(wavPath), getBeatGrid(wavPath)]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });
});
