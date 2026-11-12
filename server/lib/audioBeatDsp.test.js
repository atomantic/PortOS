import { describe, it, expect } from 'vitest';
import { trackBeatGrid, pickDownbeats } from './audioBeatDsp.js';

describe('trackBeatGrid silent-span continuity', () => {
  it('retains earlier beats while coasting through a long silent outro', () => {
    // Exercise the DP directly: a long sparse envelope exposes score decay
    // without allocating a correspondingly huge PCM buffer or running FFTs.
    const onset = new Float32Array(120_000);
    const fps = 43;
    const periodFrames = 14.5;
    const clicks = Array.from({ length: 5 }, (_, i) => Math.round(10 + i * periodFrames));
    for (const frame of clicks) onset[frame] = 1;
    const result = trackBeatGrid(onset, fps, { bpm: 60 * fps / periodFrames, confidence: 0.5, window: null });
    for (const frame of clicks) {
      expect(Math.min(...result.beats.map((beat) => Math.abs(beat - frame / fps)))).toBeLessThanOrEqual(1 / fps);
    }
    expect(result.beats.at(-1)).toBeGreaterThan((onset.length - 2 * periodFrames) / fps);
  });
});

describe('downbeat structural phase', () => {
  const fps = 100;
  const beats = Array.from({ length: 128 }, (_, i) => 0.2 + i * 0.5);
  const envelope = (loudPhase) => {
    const onset = new Float32Array(6500);
    beats.forEach((t, i) => { onset[Math.round(t * fps)] = i % 4 === loudPhase ? 3 : 1; });
    return onset;
  };
  const sections = [0, 16, 32, 48].map((startSec, i) => ({ startSec: startSec + 0.2, energy: i % 2 ? 1 : 0.3 }));

  it('puts a loud beat-3 backbeat on beat 1 when energy changes agree there', () => {
    const result = pickDownbeats(beats, envelope(2), fps, { sections });
    expect(result).toEqual({ source: 'structure', downbeats: beats.filter((_, i) => i % 4 === 0) });
  });

  it('retains a four-on-the-floor phase that already agrees with the sections', () => {
    const onset = envelope(-1);
    const original = pickDownbeats(beats, onset, fps);
    expect(pickDownbeats(beats, onset, fps, { sections })).toEqual(original);
    expect(original.source).toBe('onsets');
    expect(original.downbeats[0]).toBe(beats[0]);
  });

  it('keeps the onset phase without structure or with weak/conflicting sections', () => {
    const onset = envelope(2);
    const original = pickDownbeats(beats, onset, fps);
    expect(original).toEqual({ source: 'onsets', downbeats: beats.filter((_, i) => i % 4 === 2) });
    expect(pickDownbeats(beats, onset, fps, { sections: sections.slice(0, 2) })).toEqual(original);
    expect(pickDownbeats(beats, onset, fps, {
      sections: sections.map((s, i) => ({ ...s, startSec: s.startSec + i % 2 })),
    })).toEqual(original);
  });

  it('uses a sustained low-band entry after a quiet intro, but ignores an isolated thump', () => {
    const values = Array.from({ length: 650 }, (_, i) => i < 42 ? 0 : 0.5);
    const features = {
      envelopes: { fps: 10, low: values, rms: values },
      onsets: { low: [4.2, 4.7, 5.2, 5.7, 6.2] },
    };
    const onset = envelope(2);
    const result = pickDownbeats(beats, onset, fps, { features });
    expect(result).toEqual({ source: 'structure', downbeats: beats.filter((_, i) => i % 4 === 0) });
    expect(pickDownbeats(beats, onset, fps, { features: { ...features, onsets: { low: [4.2] } } }))
      .toEqual(pickDownbeats(beats, onset, fps));
    expect(pickDownbeats(beats, onset, fps, {
      features: { ...features, envelopes: { ...features.envelopes, rms: values.map(() => 0.5) } },
    })).toEqual(pickDownbeats(beats, onset, fps));
  });

  it('compares centred structure times with centred beats at the quarter-beat tolerance', () => {
    const offset = 0.023;
    const onset = envelope(2);
    expect(pickDownbeats(beats, onset, fps, {
      sections: sections.map((s) => ({ ...s, startSec: s.startSec + offset + 0.12 })), timeOffsetSec: offset,
    }).source).toBe('structure');
    expect(pickDownbeats(beats, onset, fps, {
      sections: sections.map((s) => ({ ...s, startSec: s.startSec + offset + 0.13 })), timeOffsetSec: offset,
    }).source).toBe('onsets');
  });
});
