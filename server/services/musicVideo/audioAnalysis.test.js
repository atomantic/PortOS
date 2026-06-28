import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  analyzePcm,
  analyzeAudioFile,
  decodeAudioToPcm,
  ANALYSIS_SAMPLE_RATE,
} from './audioAnalysis.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';

/**
 * Synthesize a mono click track: a short decaying 1kHz burst on every beat at
 * the given BPM, over a quiet noise floor. This is the deterministic fixture
 * the Phase 0 spike (#1760) is proven against — a known tempo with sharp
 * onsets that the envelope/autocorrelation pipeline must recover.
 */
function clickTrack({ bpm, durationSec, sampleRate = ANALYSIS_SAMPLE_RATE, offsetSec = 0 }) {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  // Tiny deterministic noise floor so onset detection isn't fed perfect silence
  // between hits (a pathological all-zero input is covered by its own test).
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let i = 0; i < n; i++) out[i] = rand() * 0.001;

  const periodSec = 60 / bpm;
  const burstSec = 0.04;
  const burstLen = Math.round(burstSec * sampleRate);
  for (let t = offsetSec; t < durationSec; t += periodSec) {
    const start = Math.round(t * sampleRate);
    for (let k = 0; k < burstLen && start + k < n; k++) {
      const env = Math.exp(-k / (burstLen / 4)); // exponential decay
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

describe('analyzePcm', () => {
  it('recovers a 120 BPM click track within tolerance', () => {
    const samples = clickTrack({ bpm: 120, durationSec: 16 });
    const result = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(118);
    expect(result.bpm).toBeLessThan(122);
    // 16s at 120 BPM (0.5s/beat) → ~32 beats; allow ±2 for edge framing.
    expect(result.beats.length).toBeGreaterThanOrEqual(30);
    expect(result.beats.length).toBeLessThanOrEqual(34);
    // Beats are monotonically increasing and within the track.
    for (let i = 1; i < result.beats.length; i++) {
      expect(result.beats[i]).toBeGreaterThan(result.beats[i - 1]);
    }
    expect(result.beats[result.beats.length - 1]).toBeLessThanOrEqual(result.durationSec);
    // Adjacent beat spacing ≈ 0.5s.
    const gap = result.beats[5] - result.beats[4];
    expect(gap).toBeGreaterThan(0.45);
    expect(gap).toBeLessThan(0.55);
  });

  it('recovers a 90 BPM click track within tolerance', () => {
    const samples = clickTrack({ bpm: 90, durationSec: 20 });
    const result = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(88);
    expect(result.bpm).toBeLessThan(92);
  });

  it.each([140, 160, 180])('recovers a high-BPM (%i) click track without half-tempo error', (bpm) => {
    // High tempos whose beat period falls between onset frames are prone to a
    // half-tempo octave error (the 2× lag scores higher than the smeared
    // fundamental). The detected tempo must stay near the true BPM, not ~half.
    const samples = clickTrack({ bpm, durationSec: 18 });
    const result = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(bpm - 3);
    expect(result.bpm).toBeLessThan(bpm + 3);
  });

  it('emits 4/4 downbeats as a quarter of the beats', () => {
    const samples = clickTrack({ bpm: 120, durationSec: 16 });
    const { beats, downbeats } = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(downbeats.length).toBeGreaterThan(0);
    // ~1 downbeat per 4 beats.
    expect(downbeats.length).toBeCloseTo(beats.length / 4, 0);
    // Every downbeat is an actual beat.
    for (const d of downbeats) expect(beats).toContain(d);
  });

  it('returns contiguous sections spanning the whole track', () => {
    const samples = clickTrack({ bpm: 120, durationSec: 40 });
    const { sections, durationSec } = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(sections.length).toBeGreaterThanOrEqual(1);
    expect(sections[0].startSec).toBe(0);
    expect(sections[sections.length - 1].endSec).toBeCloseTo(durationSec, 1);
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].startSec).toBeCloseTo(sections[i - 1].endSec, 3);
      expect(sections[i].label).toBeTruthy();
    }
  });

  it('does not shatter a long flat/structureless track into spurious sections', () => {
    // A 40s sustained tone at constant amplitude has no energy novelty, so it
    // must yield a single section — not the maximum evenly-spaced boundaries.
    const n = ANALYSIS_SAMPLE_RATE * 40;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / ANALYSIS_SAMPLE_RATE);
    const { sections } = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(sections.length).toBe(1);
    expect(sections[0].startSec).toBe(0);
  });

  it('reports no tempo for silence but still spans sections', () => {
    const samples = new Float32Array(ANALYSIS_SAMPLE_RATE * 12); // 12s of zeros
    const result = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(result.bpm).toBeNull();
    expect(result.beats).toEqual([]);
    expect(result.downbeats).toEqual([]);
    expect(result.durationSec).toBeCloseTo(12, 1);
    expect(result.sections.length).toBeGreaterThanOrEqual(1);
  });

  it('handles too-short input without throwing', () => {
    const result = analyzePcm(new Float32Array(100), ANALYSIS_SAMPLE_RATE);
    expect(result.bpm).toBeNull();
    expect(result.beats).toEqual([]);
  });
});

describe('analyzeAudioFile (ffmpeg decode round-trip)', () => {
  let ffmpeg;
  let dir;
  beforeAll(async () => {
    ffmpeg = await findFfmpeg();
    if (ffmpeg) dir = await mkdtemp(join(tmpdir(), 'mv-audio-'));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('decodes a WAV and recovers its tempo (skipped without ffmpeg)', async () => {
    if (!ffmpeg) {
      console.log('⏭️  ffmpeg not found — skipping decode round-trip');
      return;
    }
    const samples = clickTrack({ bpm: 128, durationSec: 16 });
    const wavPath = join(dir, 'click-128.wav');
    await writeFile(wavPath, encodeWav(samples, ANALYSIS_SAMPLE_RATE));

    const decoded = await decodeAudioToPcm(wavPath);
    expect(decoded).not.toBeNull();
    expect(decoded.sampleRate).toBe(ANALYSIS_SAMPLE_RATE);
    expect(decoded.samples.length).toBeGreaterThan(ANALYSIS_SAMPLE_RATE * 15);

    const result = await analyzeAudioFile(wavPath);
    expect(result).not.toBeNull();
    expect(result.bpm).toBeGreaterThan(126);
    expect(result.bpm).toBeLessThan(130);
  });

  it('returns null for a missing/garbage path', async () => {
    expect(await decodeAudioToPcm('/nonexistent/path/nope.wav')).toBeNull();
    expect(await analyzeAudioFile('')).toBeNull();
  });
});
