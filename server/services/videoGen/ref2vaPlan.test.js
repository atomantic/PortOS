import { describe, expect, it } from 'vitest';
import { MAX_REF2VA_AUDIO_SECONDS, planRef2vaAudioSegments } from './ref2vaPlan.js';

describe('planRef2vaAudioSegments', () => {
  it('splits arbitrary audio into legal Ref2VA conditioning windows', () => {
    expect(planRef2vaAudioSegments(41.041281)).toEqual([
      {
        index: 0, startSeconds: 0, durationSeconds: 15,
        referenceStartSeconds: 0, referenceDurationSeconds: 15, trimStartSeconds: 0,
      },
      {
        index: 1, startSeconds: 15, durationSeconds: 12,
        referenceStartSeconds: 12, referenceDurationSeconds: 15, trimStartSeconds: 3,
      },
      {
        index: 2, startSeconds: 27, durationSeconds: 12,
        referenceStartSeconds: 24, referenceDurationSeconds: 15, trimStartSeconds: 3,
      },
      {
        index: 3, startSeconds: 39, durationSeconds: 2.041280999999998,
        referenceStartSeconds: 36, referenceDurationSeconds: 5.041280999999998, trimStartSeconds: 3,
      },
    ]);
  });

  it('uses source audio before a requested offset as the first seam warm-up', () => {
    const segments = planRef2vaAudioSegments(40, { startSeconds: 12 });
    expect(segments).toEqual([
      {
        index: 0, startSeconds: 12, durationSeconds: 12,
        referenceStartSeconds: 9, referenceDurationSeconds: MAX_REF2VA_AUDIO_SECONDS, trimStartSeconds: 3,
      },
      {
        index: 1, startSeconds: 24, durationSeconds: 12,
        referenceStartSeconds: 21, referenceDurationSeconds: MAX_REF2VA_AUDIO_SECONDS, trimStartSeconds: 3,
      },
      {
        index: 2, startSeconds: 36, durationSeconds: 4,
        referenceStartSeconds: 33, referenceDurationSeconds: 7, trimStartSeconds: 3,
      },
    ]);
  });

  it('can disable warm-up while retaining the legal reference cap', () => {
    expect(planRef2vaAudioSegments(16, { seamWarmupSeconds: 0 })).toEqual([
      {
        index: 0, startSeconds: 0, durationSeconds: 15,
        referenceStartSeconds: 0, referenceDurationSeconds: 15, trimStartSeconds: 0,
      },
      {
        index: 1, startSeconds: 15, durationSeconds: 1,
        referenceStartSeconds: 15, referenceDurationSeconds: 1, trimStartSeconds: 0,
      },
    ]);
  });

  it.each([0, -1, Number.NaN])('rejects invalid duration %s', (duration) => {
    expect(() => planRef2vaAudioSegments(duration)).toThrow('durationSeconds must be positive');
  });
});
