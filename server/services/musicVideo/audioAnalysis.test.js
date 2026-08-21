import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  analyzePcm,
  analyzeAudioFile,
  decodeAudioToPcm,
  buildManualAnalysis,
  buildManualAnalysisFromCached,
  snapSectionsToGrid,
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

// A deliberately hostile song shape for the detector: a long broadband,
// beatless intro followed by a shorter regular pulse. This mirrors recordings
// whose rhythm only becomes obvious after an ambient/rubato opening.
function lateClickTrack({ bpm, introSec, rhythmicSec, sampleRate = ANALYSIS_SAMPLE_RATE }) {
  const out = new Float32Array(Math.round((introSec + rhythmicSec) * sampleRate));
  let seed = 7;
  for (let i = 0; i < introSec * sampleRate; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.15;
  }
  const burstLen = Math.round(0.025 * sampleRate);
  for (let t = introSec; t < introSec + rhythmicSec; t += 60 / bpm) {
    const start = Math.round(t * sampleRate);
    for (let k = 0; k < burstLen && start + k < out.length; k++) {
      out[start + k] += 0.8
        * Math.exp(-k / (burstLen / 5))
        * Math.sin((2 * Math.PI * 1200 * k) / sampleRate);
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

  it('finds a stable tempo after a long beatless intro', () => {
    const samples = lateClickTrack({ bpm: 108, introSec: 45, rhythmicSec: 30 });
    const result = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(105);
    expect(result.bpm).toBeLessThan(111);
    expect(result.beats.length).toBeGreaterThan(100);
    expect(result.tempoSource).toMatch(/^(full|windowed)$/);
    expect(result.tempoConfidence).toBeGreaterThanOrEqual(0.3);
  });

  it('returns a bounded compact waveform for timeline visualization', () => {
    const result = analyzePcm(clickTrack({ bpm: 120, durationSec: 16 }), ANALYSIS_SAMPLE_RATE);
    expect(result.waveform.length).toBeGreaterThan(100);
    expect(result.waveform.length).toBeLessThanOrEqual(512);
    expect(Math.max(...result.waveform)).toBe(1);
    expect(result.waveform.every((level) => level >= 0 && level <= 1)).toBe(true);
  });

  // Tempo is reliable only UP TO an octave (autocorrelation peaks at every
  // multiple of the true period) — a deliberate Phase 0 limitation (#1760).
  // This matches the detected BPM against the true BPM allowing a power-of-2
  // factor in either direction.
  const matchesUpToOctave = (detected, trueBpm, tol = 4) => {
    if (detected == null) return false;
    for (let k = -2; k <= 2; k++) {
      if (Math.abs(detected * 2 ** k - trueBpm) <= tol) return true;
    }
    return false;
  };

  it.each([140, 160, 180])('recovers a high-BPM (%i) click track up to octave', (bpm) => {
    const samples = clickTrack({ bpm, durationSec: 18 });
    const result = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(matchesUpToOctave(result.bpm, bpm)).toBe(true);
  });

  it.each([20, 30, 60])('keeps a mid-tempo 90 BPM track at song length (%is) from doubling', (durationSec) => {
    // The common case: a real-length mid-tempo track must not read as ~180. It
    // resolves at the true octave here (the octave caveat above mainly bites the
    // higher tempos whose half-period lands inside the search range).
    const samples = clickTrack({ bpm: 90, durationSec });
    const result = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(86);
    expect(result.bpm).toBeLessThan(94);
  });

  it('emits 4/4 downbeats as a quarter of the beats', () => {
    const samples = clickTrack({ bpm: 120, durationSec: 16 });
    const { beats, downbeats } = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(downbeats.length).toBeGreaterThan(0);
    // ~1 downbeat per 4 beats (floor..ceil tolerates the partial final bar).
    expect(downbeats.length).toBeGreaterThanOrEqual(Math.floor(beats.length / 4));
    expect(downbeats.length).toBeLessThanOrEqual(Math.ceil(beats.length / 4));
    // Every downbeat is an actual beat, spaced exactly 4 beats apart.
    const idx = downbeats.map((d) => beats.indexOf(d));
    expect(idx.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBe(4);
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
    // Every section carries a normalized 0..1 energy (#1915), and the loudest is 1.
    for (const s of sections) {
      expect(typeof s.energy).toBe('number');
      expect(s.energy).toBeGreaterThan(0);
      expect(s.energy).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...sections.map((s) => s.energy))).toBe(1);
  });

  it('assigns higher energy to a louder section than a quiet one (#1915)', () => {
    // A quiet first half and a loud second half: the energy jump forces a
    // section boundary, and the loud section must read a higher energy.
    const samples = clickTrack({ bpm: 120, durationSec: 40 });
    const half = Math.round(samples.length / 2);
    for (let i = 0; i < half; i++) samples[i] *= 0.15;
    const { sections } = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    const quiet = sections[0];
    const loud = sections[sections.length - 1];
    expect(loud.energy).toBeGreaterThan(quiet.energy);
  });

  it('reports energy 1 for the single fallback section of a short track', () => {
    const { sections } = analyzePcm(clickTrack({ bpm: 120, durationSec: 4 }), ANALYSIS_SAMPLE_RATE);
    expect(sections).toHaveLength(1);
    expect(sections[0].energy).toBe(1);
  });

  it('reports no tempo and one section for a sustained pure tone', () => {
    // A 40s steady tone has no beats. Frame windowing must suppress the
    // spectral-leakage ripple so it reports neither a bogus tempo nor spurious
    // sections (without windowing it returned ~112 BPM and multiple sections).
    const n = ANALYSIS_SAMPLE_RATE * 40;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / ANALYSIS_SAMPLE_RATE);
    const { bpm, beats, sections } = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(bpm).toBeNull();
    expect(beats).toEqual([]);
    expect(sections.length).toBe(1);
    expect(sections[0].startSec).toBe(0);
  });

  it('reports no tempo for structureless white noise', () => {
    // White noise has a strongest autocorrelation lag but no real periodicity;
    // the significance gate must reject it rather than inventing a tempo.
    const n = ANALYSIS_SAMPLE_RATE * 20;
    const samples = new Float32Array(n);
    let seed = 7;
    for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; samples[i] = (seed / 0x7fffffff) * 2 - 1; }
    const { bpm, beats } = analyzePcm(samples, ANALYSIS_SAMPLE_RATE);
    expect(bpm).toBeNull();
    expect(beats).toEqual([]);
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

describe('buildManualAnalysis (manual-tempo fallback)', () => {
  it('builds an even beat grid from the given BPM and offset', () => {
    // Structureless input (analyzePcm would report bpm: null on this) — the
    // manual path must still produce a full beat grid since it never runs the
    // autocorrelation estimator.
    const samples = new Float32Array(ANALYSIS_SAMPLE_RATE * 16);
    const result = buildManualAnalysis(samples, ANALYSIS_SAMPLE_RATE, { bpm: 120, offsetSec: 0.5 });
    expect(result.bpm).toBe(120);
    expect(result.beats[0]).toBeCloseTo(0.5, 3);
    expect(result.beats[1] - result.beats[0]).toBeCloseTo(0.5, 3); // 60/120s
    expect(result.beats[result.beats.length - 1]).toBeLessThanOrEqual(result.durationSec);
  });

  it('picks downbeats as every 4th beat starting at the offset', () => {
    const samples = new Float32Array(ANALYSIS_SAMPLE_RATE * 16);
    const { beats, downbeats } = buildManualAnalysis(samples, ANALYSIS_SAMPLE_RATE, { bpm: 100, offsetSec: 0 });
    const idx = downbeats.map((d) => beats.indexOf(d));
    expect(idx[0]).toBe(0);
    for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBe(4);
  });

  it('still derives sections from real energy segmentation, not the manual BPM', () => {
    const samples = clickTrack({ bpm: 120, durationSec: 40 });
    const half = Math.round(samples.length / 2);
    for (let i = 0; i < half; i++) samples[i] *= 0.15;
    const { sections } = buildManualAnalysis(samples, ANALYSIS_SAMPLE_RATE, { bpm: 90, offsetSec: 0 });
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[sections.length - 1].energy).toBeGreaterThan(sections[0].energy);
  });

  it('handles too-short input without throwing', () => {
    const result = buildManualAnalysis(new Float32Array(100), ANALYSIS_SAMPLE_RATE, { bpm: 120 });
    expect(result.bpm).toBe(120);
    expect(result.sections.length).toBe(1);
  });
});

describe('buildManualAnalysisFromCached (no-decode manual-tempo fast path)', () => {
  it('builds a beat grid from a cached durationSec without touching PCM', () => {
    const cached = {
      sections: [{ label: 'Section 1', startSec: 0, endSec: 16, energy: 1 }],
      waveform: [0.1, 0.8],
      durationSec: 16,
    };
    const result = buildManualAnalysisFromCached(cached, { bpm: 120, offsetSec: 0.5 });
    expect(result.bpm).toBe(120);
    expect(result.durationSec).toBe(16);
    expect(result.beats[0]).toBeCloseTo(0.5, 3);
    expect(result.beats[1] - result.beats[0]).toBeCloseTo(0.5, 3);
    expect(result.beats[result.beats.length - 1]).toBeLessThanOrEqual(16);
    expect(result.waveform).toEqual(cached.waveform);
    expect(result.tempoSource).toBe('manual');
  });

  it('passes the cached sections through unchanged (does not re-segment)', () => {
    const sections = [{ label: 'Section 1', startSec: 0, endSec: 10, energy: 0.4 }, { label: 'Section 2', startSec: 10, endSec: 20, energy: 1 }];
    const result = buildManualAnalysisFromCached({ sections, durationSec: 20 }, { bpm: 90 });
    expect(result.sections).toBe(sections);
  });

  it('matches buildManualAnalysis\'s beat/downbeat output for the same inputs', () => {
    const samples = new Float32Array(ANALYSIS_SAMPLE_RATE * 16);
    const fromPcm = buildManualAnalysis(samples, ANALYSIS_SAMPLE_RATE, { bpm: 128, offsetSec: 0.1 });
    const fromCached = buildManualAnalysisFromCached(
      { sections: fromPcm.sections, durationSec: fromPcm.durationSec },
      { bpm: 128, offsetSec: 0.1 },
    );
    expect(fromCached.beats).toEqual(fromPcm.beats);
    expect(fromCached.downbeats).toEqual(fromPcm.downbeats);
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

// 120 BPM grid: a beat every 0.5s, a downbeat (4/4) every 2s.
function grid120({ durationSec = 40 } = {}) {
  const beats = [];
  for (let t = 0; t <= durationSec + 1e-9; t += 0.5) beats.push(Number(t.toFixed(3)));
  return { beats, downbeats: beats.filter((_, i) => i % 4 === 0) };
}

const spans = (sections) => sections.map((s) => [s.startSec, s.endSec]);

describe('snapSectionsToGrid', () => {
  const { beats, downbeats } = grid120();

  it('snaps an internal boundary to the nearest downbeat and marks both scenes aligned', () => {
    // 18.2 sits 0.2s past the 18.0 downbeat — inside the derived tolerance
    // (half a 0.5s beat period = 0.25s), and closer than the 18.5 beat.
    const result = snapSectionsToGrid(
      [{ startSec: 0, endSec: 18.2 }, { startSec: 18.2, endSec: 30 }],
      { beats, downbeats },
    );
    expect(spans(result.sections)).toEqual([[0, 18], [18, 30]]);
    expect(result.beatAligned).toEqual([true, true]);
  });

  it('falls back to the nearest beat when the nearest downbeat is out of tolerance', () => {
    // 10.3 → downbeat 10.0 is 0.3s away (> 0.25s tolerance); beat 10.5 is 0.2s.
    const result = snapSectionsToGrid(
      [{ startSec: 0, endSec: 10.3 }, { startSec: 10.3, endSec: 30 }],
      { beats, downbeats },
    );
    expect(spans(result.sections)).toEqual([[0, 10.5], [10.5, 30]]);
    expect(result.beatAligned).toEqual([true, true]);
  });

  it('leaves an edge untouched and reports it unaligned when nothing is within tolerance', () => {
    const result = snapSectionsToGrid(
      [{ startSec: 0, endSec: 10.3 }, { startSec: 10.3, endSec: 30 }],
      { beats, downbeats, toleranceSec: 0.05 },
    );
    expect(spans(result.sections)).toEqual([[0, 10.3], [10.3, 30]]);
    expect(result.beatAligned).toEqual([false, false]);
  });

  it('reports an already-on-grid edge as aligned even though nothing moved', () => {
    const result = snapSectionsToGrid(
      [{ startSec: 0, endSec: 12 }, { startSec: 12, endSec: 30 }],
      { beats, downbeats, toleranceSec: 0 },
    );
    expect(spans(result.sections)).toEqual([[0, 12], [12, 30]]);
    expect(result.beatAligned).toEqual([true, true]);
  });

  it('keeps the planned spans honored when the track has no usable tempo', () => {
    // With no grid there is no live snap to hand the span back to — dropping the
    // flag would make render.js#beatSnapClips fall through to each clip's RAW
    // source duration (a 6s clip for a 20s section), throwing away the plan.
    const sections = [{ startSec: 0, endSec: 10.3 }, { startSec: 10.3, endSec: 30 }];
    const result = snapSectionsToGrid(sections, { beats: [], downbeats: [] });
    expect(spans(result.sections)).toEqual([[0, 10.3], [10.3, 30]]);
    expect(result.beatAligned).toEqual([true, true]);
  });

  it('refuses a snap that would push a section below the minimum scene length', () => {
    const result = snapSectionsToGrid(
      [{ startSec: 0, endSec: 10.3 }, { startSec: 10.3, endSec: 30 }],
      { beats, downbeats, minSceneSec: 20 },
    );
    expect(spans(result.sections)).toEqual([[0, 10.3], [10.3, 30]]);
    expect(result.beatAligned).toEqual([false, false]);
  });

  it('never moves the first start or the final end, and keeps the timeline contiguous', () => {
    const result = snapSectionsToGrid(
      [
        { startSec: 0, endSec: 9.4 },
        { startSec: 9.4, endSec: 20.1 },
        { startSec: 20.1, endSec: 29.3 },
      ],
      { beats, downbeats },
    );
    const out = result.sections;
    expect(out[0].startSec).toBe(0);
    expect(out[out.length - 1].endSec).toBe(29.3);
    for (let i = 1; i < out.length; i++) expect(out[i].startSec).toBe(out[i - 1].endSec);
    for (const s of out) expect(s.endSec).toBeGreaterThan(s.startSec);
  });

  it('preserves non-span section fields and does not mutate the input', () => {
    const sections = [{ label: 'Intro', energy: 0.2, startSec: 0, endSec: 10.3 }, { label: 'Drop', energy: 1, startSec: 10.3, endSec: 30 }];
    const result = snapSectionsToGrid(sections, { beats, downbeats });
    expect(sections[0].endSec).toBe(10.3);
    expect(result.sections[0]).toMatchObject({ label: 'Intro', energy: 0.2 });
    expect(result.sections[1]).toMatchObject({ label: 'Drop', energy: 1 });
  });

  it('leaves a single section untouched — both its edges are track anchors', () => {
    const result = snapSectionsToGrid([{ startSec: 0, endSec: 30.4 }], { beats, downbeats });
    expect(spans(result.sections)).toEqual([[0, 30.4]]);
    expect(result.beatAligned).toEqual([true]);
  });

  it('returns empty for an empty or non-array section list', () => {
    expect(snapSectionsToGrid([], { beats, downbeats })).toEqual({ sections: [], beatAligned: [] });
    expect(snapSectionsToGrid(null, { beats, downbeats })).toEqual({ sections: [], beatAligned: [] });
  });

  it('leaves a non-contiguous boundary alone rather than inventing a shared edge', () => {
    const result = snapSectionsToGrid(
      [{ startSec: 0, endSec: 10.3 }, { startSec: 14.3, endSec: 30 }],
      { beats, downbeats },
    );
    expect(spans(result.sections)).toEqual([[0, 10.3], [14.3, 30]]);
    expect(result.beatAligned).toEqual([false, false]);
  });

  it('derives its tolerance from the tempo, so a slow grid may move an edge further than a fast one', () => {
    const gridAt = (bpm) => {
      const out = [];
      for (let t = 0; t <= 40; t += 60 / bpm) out.push(Number(t.toFixed(3)));
      return out;
    };
    // The furthest a full grid can ever move an edge is half a beat period, so
    // sweeping candidate edges across a beat exposes the tempo-relative bound:
    // ~0.43s at 70 BPM vs ~0.17s at 180 BPM. A fixed constant would give both
    // grids the same ceiling.
    const worstMove = (beats) => {
      let worst = 0;
      for (let edge = 9; edge <= 11; edge = Number((edge + 0.01).toFixed(2))) {
        const { sections } = snapSectionsToGrid(
          [{ startSec: 0, endSec: edge }, { startSec: edge, endSec: 30 }], { beats, downbeats: [] },
        );
        worst = Math.max(worst, Math.abs(sections[0].endSec - edge));
      }
      return worst;
    };
    expect(worstMove(gridAt(70))).toBeGreaterThan(worstMove(gridAt(180)) + 0.2);
  });

  it('never collapses or inverts a boundary, even with minSceneSec: 0', () => {
    // Two adjacent boundaries whose nearest beat is the SAME 10.5s point: the
    // section between them must survive rather than being snapped to zero width.
    const result = snapSectionsToGrid(
      [{ startSec: 0, endSec: 10.3 }, { startSec: 10.3, endSec: 10.4 }, { startSec: 10.4, endSec: 30 }],
      { beats, downbeats, minSceneSec: 0 },
    );
    const out = result.sections;
    for (let i = 1; i < out.length; i++) expect(out[i].startSec).toBe(out[i - 1].endSec);
    for (const s of out) expect(s.endSec).toBeGreaterThan(s.startSec);
  });

  it('snaps a downbeats-only grid (no beats) using the implied 4/4 beat period', () => {
    const result = snapSectionsToGrid(
      [{ startSec: 0, endSec: 18.2 }, { startSec: 18.2, endSec: 30 }],
      { beats: [], downbeats },
    );
    expect(spans(result.sections)).toEqual([[0, 18], [18, 30]]);
    expect(result.beatAligned).toEqual([true, true]);
  });
});
