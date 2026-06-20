import { describe, it, expect } from 'vitest';
import { findAxisReversals, findShotTypeMonotony, sceneShotWarnings } from './shotContinuity.js';

// The two detectors are byte-for-byte mirrors of
// server/lib/editorial/shotContinuity.js (exhaustively tested there). These are
// parity smoke tests; the focus is the client-only sceneShotWarnings composer.
describe('findAxisReversals (client mirror)', () => {
  it('flags a continuity-linked left↔right pair', () => {
    const scene = {
      shots: [
        { id: 'a', screenDirection: 'left' },
        { id: 'b', screenDirection: 'right', continuityFromShotId: 'a' },
      ],
    };
    expect(findAxisReversals(scene)).toHaveLength(1);
  });

  it('treats neutral as no axis', () => {
    const scene = {
      shots: [
        { id: 'a', screenDirection: 'neutral' },
        { id: 'b', screenDirection: 'right', continuityFromShotId: 'a' },
      ],
    };
    expect(findAxisReversals(scene)).toEqual([]);
  });
});

describe('findShotTypeMonotony (client mirror)', () => {
  it('flags 3 classified shots all one framing', () => {
    const scene = { shots: [{ shotType: 'medium' }, { shotType: 'medium' }, { shotType: 'medium' }] };
    expect(findShotTypeMonotony(scene)).toMatchObject({ shotType: 'medium', classifiedCount: 3 });
  });

  it('does not flag when framings vary', () => {
    const scene = { shots: [{ shotType: 'wide' }, { shotType: 'medium' }, { shotType: 'close' }] };
    expect(findShotTypeMonotony(scene)).toBeNull();
  });
});

describe('sceneShotWarnings', () => {
  it('returns an axis-reversal warning for a flipped continuity pair', () => {
    const scene = {
      shots: [
        { id: 'a', screenDirection: 'left' },
        { id: 'b', screenDirection: 'right', continuityFromShotId: 'a' },
      ],
    };
    const w = sceneShotWarnings(scene);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('axis-reversal');
    expect(w[0].severity).toBe('medium');
    expect(w[0].message).toContain('180° axis jump');
    expect(w[0].message).toContain('screen-left');
    expect(w[0].message).toContain('screen-right');
  });

  it('returns a monotony warning for a single-framing scene', () => {
    const scene = { shots: [{ shotType: 'close' }, { shotType: 'close' }, { shotType: 'close' }] };
    const w = sceneShotWarnings(scene);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('monotony');
    expect(w[0].message).toContain('Shot-type monotony');
    expect(w[0].message).toContain('close');
  });

  it('returns both kinds when both hazards are present', () => {
    const scene = {
      shots: [
        { id: 'a', shotType: 'medium', screenDirection: 'left' },
        { id: 'b', shotType: 'medium', screenDirection: 'right', continuityFromShotId: 'a' },
        { id: 'c', shotType: 'medium' },
      ],
    };
    const kinds = sceneShotWarnings(scene).map((w) => w.kind).sort();
    expect(kinds).toEqual(['axis-reversal', 'monotony']);
  });

  it('returns no warnings for a clean scene', () => {
    const scene = {
      shots: [
        { id: 'a', shotType: 'wide', screenDirection: 'left' },
        { id: 'b', shotType: 'close', screenDirection: 'left', continuityFromShotId: 'a' },
      ],
    };
    expect(sceneShotWarnings(scene)).toEqual([]);
  });

  it('respects flagAxisReversal: false (suppresses the axis warning)', () => {
    const scene = {
      shots: [
        { id: 'a', screenDirection: 'left' },
        { id: 'b', screenDirection: 'right', continuityFromShotId: 'a' },
      ],
    };
    expect(sceneShotWarnings(scene, { flagAxisReversal: false })).toEqual([]);
  });

  it('handles a non-array shots field without throwing', () => {
    expect(sceneShotWarnings({ shots: null })).toEqual([]);
    expect(sceneShotWarnings({})).toEqual([]);
    expect(sceneShotWarnings(null)).toEqual([]);
  });
});
