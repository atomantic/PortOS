/**
 * Per-track animation targets (#2985) — the pure precedence chain, the
 * sibling-preserving merge, and drift detection. The service-level wiring
 * (queue-time enforcement, PUT /walk/target, lazy write-back) is covered by
 * walk.test.js; this file pins the rules those depend on.
 */

import { describe, it, expect } from 'vitest';
import {
  WALK_TRACK, resolveAnimationTarget, withTrackTarget, targetDrift, describeTargetSource,
} from './animationTargets.js';

describe('resolveAnimationTarget precedence', () => {
  it('falls back to the documented defaults when nothing is pinned or packaged', () => {
    expect(resolveAnimationTarget()).toMatchObject({
      track: WALK_TRACK, frameCount: 12, fps: 10, source: 'default', frameCountLocked: false,
    });
  });

  it('derives from the FIRST packaged direction, mirroring the compiler\'s first-wins rule', () => {
    expect(resolveAnimationTarget({
      packagedCycles: [
        { direction: 'south', frameCount: 8, fps: 12 },
        { direction: 'east', frameCount: 16, fps: 6 },
      ],
    })).toMatchObject({ frameCount: 8, fps: 12, source: 'derived' });
  });

  it('prefers an explicit set pin over the derived geometry', () => {
    expect(resolveAnimationTarget({
      animationTargets: { walk: { frameCount: 14, fps: 8, source: 'set' } },
      packagedCycles: [{ direction: 'south', frameCount: 8, fps: 12 }],
    })).toMatchObject({ frameCount: 14, fps: 8, source: 'set' });
  });

  it('reports an auto-pinned block as "derived", not as a user-chosen target', () => {
    // The lazy write-back stamps `source: 'derived'` so a value PortOS inferred
    // never masquerades in the UI as one the user deliberately picked.
    expect(resolveAnimationTarget({
      animationTargets: { walk: { frameCount: 8, fps: 12, source: 'derived' } },
    })).toMatchObject({ frameCount: 8, fps: 12, source: 'derived' });
  });

  it('treats a legacy pin with no source field as a user-set target', () => {
    expect(resolveAnimationTarget({
      animationTargets: { walk: { frameCount: 14, fps: 8 } },
    })).toMatchObject({ source: 'set' });
  });

  it('lets the app contract beat every other rung and marks the knob locked', () => {
    expect(resolveAnimationTarget({
      runtimeContract: { walkFrameCount: 16 },
      animationTargets: { walk: { frameCount: 14, fps: 8, source: 'set' } },
      packagedCycles: [{ direction: 'south', frameCount: 8, fps: 12 }],
    })).toMatchObject({
      // The contract pins only the frame count today — fps still falls through
      // to the set pin, but the target as a whole reports as app-authored.
      frameCount: 16, fps: 8, source: 'app', frameCountLocked: true, fpsLocked: false,
    });
  });

  it('honors a contract that also pins fps', () => {
    expect(resolveAnimationTarget({
      runtimeContract: { walkFrameCount: 16, walkFps: 24 },
    })).toMatchObject({ frameCount: 16, fps: 24, fpsLocked: true });
  });

  it('ignores out-of-range and non-integer values at every rung instead of clamping them', () => {
    // A hand-edited record must not silently pin something the packer would
    // quietly rewrite — the rung is skipped, not coerced.
    expect(resolveAnimationTarget({
      runtimeContract: { walkFrameCount: 99 },
      animationTargets: { walk: { frameCount: 2, fps: 'fast' } },
      packagedCycles: [{ direction: 'south', frameCount: 12.5, fps: 0 }],
    })).toMatchObject({ frameCount: 12, fps: 10, source: 'default', frameCountLocked: false });
  });

  it('ignores an unrelated track\'s pin when resolving walk', () => {
    expect(resolveAnimationTarget({
      animationTargets: { scanner: { frameCount: 6, fps: 4 } },
    })).toMatchObject({ frameCount: 12, fps: 10, source: 'default' });
  });
});

describe('withTrackTarget', () => {
  it('preserves an unrecognized sibling track key on write', () => {
    // Forward-compat: a newer PortOS (or a peer) may have written a track this
    // build knows nothing about — a naive overwrite would silently drop it.
    const merged = withTrackTarget(
      { scanner: { frameCount: 4, fps: 6, source: 'set' } },
      WALK_TRACK,
      { frameCount: 12, fps: 10, source: 'set' },
    );
    expect(merged).toEqual({
      scanner: { frameCount: 4, fps: 6, source: 'set' },
      walk: { frameCount: 12, fps: 10, source: 'set' },
    });
  });

  it('tolerates a missing or malformed map', () => {
    expect(withTrackTarget(null, WALK_TRACK, { frameCount: 12, fps: 10, source: 'set' }))
      .toEqual({ walk: { frameCount: 12, fps: 10, source: 'set' } });
    expect(withTrackTarget(['nope'], WALK_TRACK, { frameCount: 12, fps: 10, source: 'set' }))
      .toEqual({ walk: { frameCount: 12, fps: 10, source: 'set' } });
  });
});

describe('targetDrift', () => {
  const target = { frameCount: 12, fps: 10 };

  it('reports only the directions that disagree, and which knob disagrees', () => {
    expect(targetDrift(target, [
      { direction: 'south', frameCount: 12, fps: 10 },
      { direction: 'east', frameCount: 8, fps: 10 },
      { direction: 'west', frameCount: 12, fps: 24 },
    ])).toEqual([
      {
        direction: 'east', frameCount: 8, fps: 10, frameCountDrifts: true, fpsDrifts: false,
      },
      {
        direction: 'west', frameCount: 12, fps: 24, frameCountDrifts: false, fpsDrifts: true,
      },
    ]);
  });

  it('does not call a direction with no declared geometry "drifted"', () => {
    expect(targetDrift(target, [{ direction: 'south' }])).toEqual([]);
  });
});

describe('describeTargetSource', () => {
  it('names the winning rung in the user\'s words', () => {
    expect(describeTargetSource({ source: 'app' }, 'example-game')).toBe('locked by example-game');
    expect(describeTargetSource({ source: 'app' })).toBe('locked by the bound app');
    expect(describeTargetSource({ source: 'set' })).toBe('set target');
    expect(describeTargetSource({ source: 'derived' })).toBe('from the first approved direction');
    expect(describeTargetSource({ source: 'default' })).toBe('default');
  });
});
