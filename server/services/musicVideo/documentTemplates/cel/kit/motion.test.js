import { describe, expect, it } from 'vitest';
import { apply, col, len, rotY, sub } from './core.js';
import { DIM, ik2, solve } from './skeleton.js';
import { walkPose } from './walk.js';
import { retarget, sampleRow, walkOn } from './mocap.js';
import walk from './motion/walk.js';
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

  // Uniquely catches a shipped motion clip with incompatible row layout or a broken looping retargeter.
  it('loops the credited motion and retargets to figure bone lengths', () => {
    expect(sampleRow(walk, 0, true)).toEqual(sampleRow(walk, walk.n, true));
    for (const beat of [0, 0.3, 1, 3.4]) {
      const { sk } = walkOn(walk, beat, beat, { heading: 0.6, origin: [2, -1] });
      expect(distance(sk.legL.hip, sk.legL.knee)).toBeCloseTo(DIM.thigh, 8);
      expect(distance(sk.legL.knee, sk.legL.ankle)).toBeCloseTo(DIM.shin, 8);
      expect(distance(sk.armR.shoulder, sk.armR.elbow)).toBeCloseTo(DIM.upperArm, 8);
      expect(distance(sk.armR.elbow, sk.armR.wrist)).toBeCloseTo(DIM.foreArm, 8);
      expect(sk.headCenter.every(Number.isFinite)).toBe(true);
    }
  });

  // Catches hand orientation being replaced by the forearm despite captured wrist axes.
  it('keeps both captured hand frames when turning the motion', () => {
    const row = sampleRow(walk, 0);
    const axes = [[0, 1, 0], [1, 0, 0], [1, 0, 0], [0, 0, 1]];
    row.splice(25 * 3 + 6, 12, ...axes.flat());
    const yaw = 0.7;
    const sk = retarget(row, walk, { yaw });
    for (const [hand, y, z] of [[sk.handL, axes[0], axes[1]], [sk.handR, axes[2], axes[3]]]) {
      expect(distance(col(hand.R, 1), apply(rotY(yaw), y))).toBeLessThan(1e-8);
      expect(distance(col(hand.R, 2), apply(rotY(yaw), z))).toBeLessThan(1e-8);
    }
  });
});
