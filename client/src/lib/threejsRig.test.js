import { describe, expect, it } from 'vitest';
import { summarizeThreejsArticulation } from './threejsRig';

const spec = () => ({
  articulation: {
    joints: [
      { id: 'rootJoint', partId: 'torso', parentJointId: null, pivotSocket: null },
      { id: 'armJoint', partId: 'arm', parentJointId: 'rootJoint', pivotSocket: 'shoulder' },
    ],
    attachmentPartIds: ['pack'],
  },
});

describe('summarizeThreejsArticulation', () => {
  it('summarizes a usable graph and indexes the joints by the part they drive', () => {
    const summary = summarizeThreejsArticulation(spec());
    expect(summary.articulationReady).toBe(true);
    expect(summary.jointCount).toBe(2);
    expect(summary.socketCount).toBe(1);
    expect(summary.attachmentCount).toBe(1);
    expect(summary.jointsByPartId.arm.id).toBe('armJoint');
  });

  // Legacy records and static subjects both arrive with no key at all — that is
  // a static assembly, not a crash and not a pass.
  it('reads a spec with no articulation, and a missing spec, as static', () => {
    for (const value of [null, undefined, {}, { articulation: null }]) {
      const summary = summarizeThreejsArticulation(value);
      expect(summary.articulationReady).toBe(false);
      expect(summary.jointCount).toBe(0);
      expect(summary.socketCount).toBe(0);
      expect(summary.attachmentCount).toBe(0);
    }
  });

  it('matches the server rule: a lone root, or a child joint with no pivot, is not ready', () => {
    const lonely = spec();
    lonely.articulation.joints = [lonely.articulation.joints[0]];
    expect(summarizeThreejsArticulation(lonely).articulationReady).toBe(false);

    const unpivoted = spec();
    unpivoted.articulation.joints[1].pivotSocket = null;
    expect(summarizeThreejsArticulation(unpivoted).articulationReady).toBe(false);
  });

  // Part ids are provider-authored; a plain object would resolve `toString` to
  // an inherited function and the preview would label a part that has no joint.
  it('keeps the joint index null-prototype', () => {
    const summary = summarizeThreejsArticulation(spec());
    expect(summary.jointsByPartId.toString).toBeUndefined();
    expect(Object.getPrototypeOf(summary.jointsByPartId)).toBeNull();
  });
});
