import { describe, expect, it } from 'vitest';
import { evaluateThreejsRigReadiness } from './threejsModelRig.js';

const spec = (overrides = {}) => ({
  subjectType: 'character',
  articulation: {
    joints: [
      { id: 'rootJoint', partId: 'torso', parentJointId: null, pivotSocket: null },
      { id: 'armJoint', partId: 'arm', parentJointId: 'rootJoint', pivotSocket: 'shoulder' },
    ],
    attachmentPartIds: ['pack'],
  },
  ...overrides,
});

describe('evaluateThreejsRigReadiness', () => {
  it('reports a usable graph as ready with its joint, pivot, and attachment counts', () => {
    expect(evaluateThreejsRigReadiness(spec())).toEqual({
      articulationReady: true,
      reasons: [],
      jointCount: 2,
      socketCount: 1,
      attachmentCount: 1,
      rootJointId: 'rootJoint',
      subjectType: 'character',
    });
  });

  // The honest half of the contract: silence is not a pass. A character with no
  // graph is static and says so, with the reason attached.
  it('reports a character with no articulation as not ready and names why', () => {
    const report = evaluateThreejsRigReadiness(spec({ articulation: undefined }));
    expect(report.articulationReady).toBe(false);
    expect(report.jointCount).toBe(0);
    expect(report.socketCount).toBe(0);
    expect(report.rootJointId).toBeNull();
    expect(report.reasons[0]).toContain('static assembly');
  });

  it('describes an object subject as a static assembly rather than a failed character', () => {
    const report = evaluateThreejsRigReadiness({ subjectType: 'object' });
    expect(report.articulationReady).toBe(false);
    expect(report.reasons).toEqual(['This subject was generated as a static assembly and declares no articulation graph.']);
  });

  it('rejects a lone root as an articulation graph', () => {
    const lonely = spec();
    lonely.articulation.joints = [lonely.articulation.joints[0]];
    const report = evaluateThreejsRigReadiness(lonely);
    expect(report.articulationReady).toBe(false);
    expect(report.reasons[0]).toContain('root and nothing to move against it');
  });

  // A child joint with no socket has no axis, so the graph names moving parts it
  // cannot move — schema-valid, and not rig-ready.
  it('reports child joints with no pivot socket, naming them', () => {
    const unpivoted = spec();
    unpivoted.articulation.joints[1].pivotSocket = null;
    const report = evaluateThreejsRigReadiness(unpivoted);
    expect(report.articulationReady).toBe(false);
    expect(report.socketCount).toBe(0);
    expect(report.reasons[0]).toContain('1 of 2 joints name no pivot socket');
    expect(report.reasons[0]).toContain('armJoint');
  });

  it('counts distinct pivot sockets rather than joints, so a shared axis is not double-counted', () => {
    const shared = spec();
    shared.articulation.joints.push({ id: 'armJoint2', partId: 'arm2', parentJointId: 'rootJoint', pivotSocket: 'shoulder' });
    const report = evaluateThreejsRigReadiness(shared);
    expect(report.jointCount).toBe(3);
    expect(report.socketCount).toBe(1);
  });

  it('degrades to a not-ready static report for a missing spec instead of throwing', () => {
    const report = evaluateThreejsRigReadiness(null);
    expect(report.articulationReady).toBe(false);
    expect(report.subjectType).toBeNull();
    expect(report.jointCount).toBe(0);
  });
});
