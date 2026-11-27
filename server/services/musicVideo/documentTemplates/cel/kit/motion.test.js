import { describe, expect, it } from 'vitest';
import { len, sub } from './core.js';
import { ik2, solve } from './skeleton.js';
import { walkPose } from './walk.js';
import { buildFigure } from './figure.js';

const distance = (a, b) => len(sub(a, b));

describe('cel motion kit', () => {
  // Uniquely catches collapsed IK limbs when an authored target and pole align on an axis.
  it('keeps bone lengths when targets are reachable, coincident or beyond reach', () => {
    for (const target of [[0.3, -0.5, 0.2], [0, 0, 0], [2, 0, 0]]) {
      const { mid, end } = ik2([0, 0, 0], target, 0.435, 0.415, [1, 0, 0]);
      expect(distance([0, 0, 0], mid)).toBeCloseTo(0.435, 8);
      expect(distance(mid, end)).toBeCloseTo(0.415, 8);
    }
  });

  // Uniquely catches a planted foot sliding with root travel while its drawing is held on twos.
  it('holds the planted authored foot while the root moves, with seek-order-independent cloth', () => {
    const held = 0.35;
    const first = walkPose(held, held), next = walkPose(held + 0.02, held);
    expect(next.pose.pos[2]).toBeGreaterThan(first.pose.pos[2]);
    expect(next.pose.legL.foot).toEqual(first.pose.legL.foot);
    const make = (walk) => buildFigure(solve(walk.pose), undefined, { skirtLag: walk.skirtLag, hairSway: walk.hairSway });
    const before = make(first);
    make(walkPose(10, 10));
    expect(make(first)).toEqual(before);
    expect(before.parts.dress.rings.flat(2).every(Number.isFinite)).toBe(true);
  });
});
