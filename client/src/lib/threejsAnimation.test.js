// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  collectThreejsCues,
  evaluateThreejsClipPose,
  getThreejsClipDuration,
  listThreejsClips,
  listThreejsCues,
  resolveThreejsClip,
} from './threejsAnimation';

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
      easing: 'linear',
      channels: { position: { from: [0, 0, 0], to: [0, 2, 0] } },
      cueId: 'latch',
    },
    {
      id: 'swing',
      name: 'Swing',
      partId: 'panel',
      startSeconds: 2,
      endSeconds: 3,
      easing: 'linear',
      channels: { position: { from: [0, 2, 0], to: [0, 2, 4] } },
      cueId: null,
    },
  ],
  ...overrides,
});

const spec = (overrides = {}) => ({
  name: 'Example model',
  animation: {
    cues: [{ id: 'latch', label: 'Latch lets go', kind: 'latch' }],
    clips: [clip(), clip({ id: 'retract', name: 'Retract' })],
  },
  ...overrides,
});

const poseOf = (target, time, partId = 'panel') => evaluateThreejsClipPose(target, time).pose[partId];

describe('clip lookup', () => {
  it('reads a spec with no animation key as a static assembly', () => {
    expect(listThreejsClips(null)).toEqual([]);
    expect(listThreejsClips({ name: 'x' })).toEqual([]);
    expect(listThreejsCues({ name: 'x' })).toEqual([]);
    expect(resolveThreejsClip({ name: 'x' }, 'deploy')).toBeNull();
  });

  it('falls back to the first clip for an unknown or absent id', () => {
    expect(resolveThreejsClip(spec(), 'retract').id).toBe('retract');
    expect(resolveThreejsClip(spec(), 'noSuchClip').id).toBe('deploy');
    expect(resolveThreejsClip(spec(), null).id).toBe('deploy');
  });

  it('reads a duration only from a real number', () => {
    expect(getThreejsClipDuration(clip())).toBe(3);
    expect(getThreejsClipDuration(null)).toBe(0);
    expect(getThreejsClipDuration({ durationSeconds: 'soon' })).toBe(0);
  });
});

describe('evaluateThreejsClipPose', () => {
  it('poses nothing for a static assembly, so every part renders as authored', () => {
    const result = evaluateThreejsClipPose(null, 1.5);
    expect(Object.keys(result.pose)).toEqual([]);
    expect(result.activeSequenceIds).toEqual([]);
  });

  it('is deterministic at both boundaries of a window', () => {
    expect(poseOf(clip(), 0).position).toEqual([0, 0, 0]);
    expect(poseOf(clip(), 1).position).toEqual([0, 2, 0]);
    expect(poseOf(clip(), 0.5).position).toEqual([0, 1, 0]);
  });

  it('holds the previous window\'s end value in the gap between two sequences', () => {
    // Between 1s and 2s nothing is driving the part: it must hold where the
    // first sequence left it, not snap back to the authored pose or jump ahead
    // to the second sequence's start value.
    expect(poseOf(clip(), 1.5).position).toEqual([0, 2, 0]);
    expect(poseOf(clip(), 1.999).position).toEqual([0, 2, 0]);
  });

  it('holds the last window\'s end value past the end of the clip', () => {
    expect(poseOf(clip(), 3).position).toEqual([0, 2, 4]);
    expect(poseOf(clip(), 99).position).toEqual([0, 2, 4]);
  });

  it('evaluates identically whichever order the sequences are declared in', () => {
    const reversed = clip({ sequences: [...clip().sequences].reverse() });
    for (const time of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
      expect(poseOf(reversed, time)).toEqual(poseOf(clip(), time));
    }
  });

  it('hands a shared instant to the window that has just begun', () => {
    const chained = clip({
      sequences: [
        { ...clip().sequences[0] },
        // A deliberately discontinuous handover, so the assertion can tell WHICH
        // window owns the shared instant: the first ends at [0,2,0] and the
        // second begins at [0,5,0].
        {
          ...clip().sequences[1],
          startSeconds: 1,
          endSeconds: 2,
          channels: { position: { from: [0, 5, 0], to: [0, 5, 4] } },
        },
      ],
    });
    expect(poseOf(chained, 0.999).position).toEqual([0, 1.998, 0]);
    // At 1s the first window is finished and the second starts — the second's
    // `from` is what plays next, so it owns the instant.
    expect(poseOf(chained, 1).position).toEqual([0, 5, 0]);
    expect(poseOf(chained, 1.5).position).toEqual([0, 5, 2]);
  });

  it('applies the named easing curve rather than always interpolating linearly', () => {
    const eased = clip({ sequences: [{ ...clip().sequences[0], easing: 'easeIn' }] });
    expect(poseOf(eased, 0.5).position).toEqual([0, 0.5, 0]);
    const unknown = clip({ sequences: [{ ...clip().sequences[0], easing: 'elasticOut' }] });
    // An easing name this build does not implement falls back to linear rather
    // than producing NaN.
    expect(poseOf(unknown, 0.5).position).toEqual([0, 1, 0]);
  });

  it('steps visibility at the end of its window instead of interpolating a boolean', () => {
    const hides = clip({
      sequences: [{
        id: 'hide',
        name: 'Hide',
        partId: 'panel',
        startSeconds: 0,
        endSeconds: 1,
        easing: 'linear',
        channels: { visible: { from: true, to: false } },
        cueId: null,
      }],
    });
    expect(poseOf(hides, 0).visible).toBe(true);
    expect(poseOf(hides, 0.99).visible).toBe(true);
    expect(poseOf(hides, 1).visible).toBe(false);
    expect(poseOf(hides, 2).visible).toBe(false);
  });

  it('interpolates scalar channels and reports which sequences are live', () => {
    const fades = clip({
      sequences: [{
        ...clip().sequences[0],
        channels: { opacity: { from: 1, to: 0 }, position: { from: [0, 0, 0], to: [0, 2, 0] } },
      }],
    });
    const result = evaluateThreejsClipPose(fades, 0.25);
    expect(result.pose.panel.opacity).toBeCloseTo(0.75, 6);
    expect(result.activeSequenceIds).toEqual(['lift']);
    expect(result.activePartIds).toEqual(['panel']);
    expect(evaluateThreejsClipPose(fades, 2).activeSequenceIds).toEqual([]);
  });

  it('keeps parts no sequence drives out of the pose entirely', () => {
    expect(evaluateThreejsClipPose(clip(), 0.5).pose.somethingElse).toBeUndefined();
  });

  it('resolves a part id that shadows an Object prototype member', () => {
    const shady = clip({ sequences: [{ ...clip().sequences[0], partId: 'toString' }] });
    expect(evaluateThreejsClipPose(shady, 1).pose.toString).toEqual({ position: [0, 2, 0] });
  });

  it('reads a non-finite time as the start of the clip rather than producing NaN', () => {
    expect(poseOf(clip(), Number.NaN).position).toEqual([0, 0, 0]);
    expect(poseOf(clip(), undefined).position).toEqual([0, 0, 0]);
  });
});

describe('collectThreejsCues', () => {
  it('fires a cue once, on the frame that crosses its start', () => {
    expect(collectThreejsCues(clip(), 0, 0.016)).toEqual([
      { cueId: 'latch', sequenceId: 'lift', partId: 'panel', atSeconds: 0 },
    ]);
    // The next frame must not fire it again — consecutive half-open intervals
    // tile the timeline with no duplicate and no gap.
    expect(collectThreejsCues(clip(), 0.016, 0.032)).toEqual([]);
  });

  it('returns nothing for an interval that does not move forward, which is what a scrub passes', () => {
    expect(collectThreejsCues(clip(), 1, 1)).toEqual([]);
    expect(collectThreejsCues(clip(), 1, 0)).toEqual([]);
  });

  it('ignores sequences that declare no cue', () => {
    expect(collectThreejsCues(clip(), 1.9, 2.1)).toEqual([]);
  });

  it('returns crossed cues in time order for a long frame', () => {
    const busy = clip({
      sequences: [
        { ...clip().sequences[0], startSeconds: 0.5, endSeconds: 1, cueId: 'latch' },
        { ...clip().sequences[1], startSeconds: 0.1, endSeconds: 0.4, cueId: 'thud' },
      ],
    });
    expect(collectThreejsCues(busy, 0, 2).map((entry) => entry.cueId)).toEqual(['thud', 'latch']);
  });

  it('returns nothing for a static assembly', () => {
    expect(collectThreejsCues(null, 0, 1)).toEqual([]);
  });
});
