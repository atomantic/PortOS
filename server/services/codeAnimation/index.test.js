import { describe, expect, it } from 'vitest';
import { _deriveWaveSketchCues } from './index.js';
import { CODE_ANIMATION_LIMITS } from './prompt.js';

describe('_deriveWaveSketchCues', () => {
  it('returns empty string for null, invalid, or empty sketches', () => {
    expect(_deriveWaveSketchCues(null)).toBe('');
    expect(_deriveWaveSketchCues({})).toBe('');
    expect(_deriveWaveSketchCues({ voices: [] })).toBe('');
    expect(_deriveWaveSketchCues({ voices: [{ name: 'v', shape: 's', notes: [] }] })).toBe('');
  });

  it('derives section/onset times, strongest onsets, and sampled contour from a valid waveSketch', () => {
    const sketch = {
      version: 1,
      title: 'Neon Drift',
      durationSec: 8,
      shapes: { synth: [0, 0.5, 1, 0, -1, -0.5] },
      voices: [
        {
          name: 'bass',
          shape: 'synth',
          gain: 0.8,
          notes: [
            { t: 0, d: 2, pitch: 'C2', v: 0.9 },
            { t: 4, d: 2, pitch: 'G2', v: 1.0 },
          ],
        },
        {
          name: 'lead',
          shape: 'synth',
          gain: 0.7,
          notes: [
            { t: 1, d: 1, pitch: 'E4', v: 0.7 },
            { t: 2, d: 1, pitch: 'G4', v: 0.8 },
            { t: 5, d: 1, pitch: 'B4', v: 0.95 },
          ],
        },
      ],
      contour: [0.2, 0.4, 0.7, 0.9, 0.6, 0.3],
    };

    const cues = _deriveWaveSketchCues(sketch);
    expect(cues).toContain('Drawn waveform timing cues:');
    expect(cues).toContain('- Section/onset times: 0.0s, 1.0s, 2.0s, 4.0s, 5.0s');
    expect(cues).toContain('- Strongest onsets:');
    expect(cues).toContain('bass C2');
    expect(cues).toContain('lead B4');
    expect(cues).toContain('- Loudness contour:');
    expect(cues.length).toBeLessThanOrEqual(CODE_ANIMATION_LIMITS.audioNotesMax);
  });

  it('computes timeline energy checkpoints when contour array is absent', () => {
    const sketch = {
      version: 1,
      durationSec: 4,
      shapes: { bell: [0, 0.8, 1, 0.3, -0.3, -1, -0.8] },
      voices: [
        {
          name: 'bell',
          shape: 'bell',
          gain: 0.9,
          notes: [
            { t: 0, d: 1, hz: 440, v: 0.8 },
            { t: 2, d: 1, hz: 880, v: 0.6 },
          ],
        },
      ],
    };

    const cues = _deriveWaveSketchCues(sketch);
    expect(cues).toContain('- Loudness contour:');
    expect(cues).toContain('0.0s:');
    expect(cues).toContain('->');
  });
});
