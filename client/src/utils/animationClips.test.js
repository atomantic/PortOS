import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { inPlaceClipName, withInPlaceClips } from './animationClips.js';

const ROOT = ['Walking', 'Running', 'WalkJump'];
const SUFFIX = ' (in place)';

// Build a minimal AnimationClip with a root-translation position track plus a
// joint-rotation (quaternion) track, so we can assert only the position track
// is stripped from the in-place variant.
function makeClip(name) {
  const posTrack = new THREE.VectorKeyframeTrack('Body.position', [0, 1], [0, 0, 0, 0, 0, 2]);
  const quatTrack = new THREE.QuaternionKeyframeTrack('Leg.quaternion', [0, 1], [0, 0, 0, 1, 0, 1, 0, 0]);
  return new THREE.AnimationClip(name, 1, [posTrack, quatTrack]);
}

describe('inPlaceClipName', () => {
  it('routes root-motion clips to the suffixed variant, leaves others unchanged', () => {
    expect(inPlaceClipName('Running', ROOT, SUFFIX)).toBe('Running (in place)');
    expect(inPlaceClipName('Punch', ROOT, SUFFIX)).toBe('Punch');
  });
});

describe('withInPlaceClips', () => {
  it('returns [] for a non-array input', () => {
    expect(withInPlaceClips(undefined, ROOT, SUFFIX)).toEqual([]);
  });

  it('appends an in-place variant per root-motion clip, keeps originals', () => {
    const clips = [makeClip('Running'), makeClip('Punch')];
    const out = withInPlaceClips(clips, ROOT, SUFFIX);
    const names = out.map((c) => c.name);
    // Both originals survive, plus one variant for the root-motion clip only.
    expect(names).toContain('Running');
    expect(names).toContain('Punch');
    expect(names).toContain('Running (in place)');
    expect(names).not.toContain('Punch (in place)');
    expect(out.length).toBe(3);
  });

  it('strips only the .position tracks from the variant (treadmill), leaving joint tracks', () => {
    const [variant] = withInPlaceClips([makeClip('Running')], ROOT, SUFFIX).filter((c) => c.name.endsWith(SUFFIX));
    const trackNames = variant.tracks.map((t) => t.name);
    expect(trackNames).toContain('Leg.quaternion');
    expect(trackNames).not.toContain('Body.position');
  });

  it('does not mutate the original clip', () => {
    const original = makeClip('Running');
    const before = original.tracks.length;
    withInPlaceClips([original], ROOT, SUFFIX);
    expect(original.name).toBe('Running');
    expect(original.tracks.length).toBe(before);
  });
});
