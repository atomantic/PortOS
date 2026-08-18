import { describe, expect, it } from 'vitest';
import { summarizeThreejsAnimation } from './threejsModelAnimation.js';

const clip = (overrides = {}) => ({
  id: 'deploy',
  name: 'Deploy',
  role: 'deploy',
  durationSeconds: 3,
  loop: false,
  sequences: [
    {
      id: 'lift',
      name: 'Lift',
      partId: 'panel',
      startSeconds: 0,
      endSeconds: 1,
      easing: 'easeOut',
      channels: { position: { from: [0, 0, 0], to: [0, 1, 0] } },
      cueId: 'latch',
    },
    {
      id: 'swing',
      name: 'Swing',
      partId: 'arm',
      startSeconds: 1,
      endSeconds: 2,
      easing: 'linear',
      channels: { rotationDegrees: { from: [0, 0, 0], to: [0, 90, 0] } },
      cueId: 'latch',
    },
  ],
  ...overrides,
});

describe('summarizeThreejsAnimation', () => {
  it('reports a spec with no animation key as a static assembly, never as evaluated-and-empty', () => {
    for (const spec of [null, undefined, {}, { animation: null }]) {
      expect(summarizeThreejsAnimation(spec)).toMatchObject({
        animated: false,
        clipCount: 0,
        sequenceCount: 0,
        movingPartCount: 0,
        longestClipSeconds: 0,
      });
    }
  });

  it('counts clips, sequences, distinct moving parts, and the longest authored window', () => {
    const summary = summarizeThreejsAnimation({
      animation: {
        cues: [{ id: 'latch', label: 'Latch', kind: 'latch' }],
        clips: [clip(), clip({ id: 'retract', name: 'Retract', role: 'retract', durationSeconds: 5 })],
      },
    });
    expect(summary).toMatchObject({
      animated: true,
      clipCount: 2,
      cueCount: 1,
      sequenceCount: 4,
      // Two parts across four sequences — the same part in two clips is one part.
      movingPartCount: 2,
      longestClipSeconds: 5,
    });
    expect(summary.clips[0]).toEqual({
      id: 'deploy',
      name: 'Deploy',
      role: 'deploy',
      durationSeconds: 3,
      sequenceCount: 2,
      // One cue fired by two sequences is one sound the host has to supply.
      cueCount: 1,
    });
  });

  it('reports the authored duration, not the last sequence end, so a held final pose counts', () => {
    const summary = summarizeThreejsAnimation({ animation: { clips: [clip({ durationSeconds: 8 })] } });
    expect(summary.longestClipSeconds).toBe(8);
  });

  it('defaults a clip that arrived without a role rather than printing undefined', () => {
    const summary = summarizeThreejsAnimation({ animation: { clips: [clip({ role: undefined })] } });
    expect(summary.clips[0].role).toBe('custom');
  });
});
