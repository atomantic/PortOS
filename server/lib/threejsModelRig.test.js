import { describe, expect, it } from 'vitest';
import { evaluateThreejsRigReadiness } from './threejsModelRig.js';

const spec = (overrides = {}) => ({
  subjectType: 'character',
  articulation: {
    joints: [
      { id: 'rootJoint', partId: 'torso', parentJointId: null, pivotSocket: null },
      { id: 'armJoint', partId: 'arm', parentJointId: 'rootJoint', pivotSocket: 'shoulder' },
    ],
    attachmentPartIds: [],
    attachments: [{ partId: 'pack', anchorPartId: 'torso', anchorSocket: null, maxOffset: 0.25 }],
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
      anchoredAttachmentCount: 1,
      unanchoredAttachmentCount: 0,
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

  // The declaration this whole field exists for: a part named as carried, with
  // nothing naming what carries it, is a relationship the graph does not hold.
  it('reports a declared attachment that names nothing to hang from', () => {
    const unanchored = spec();
    unanchored.articulation.attachments = [];
    unanchored.articulation.attachmentPartIds = ['pack'];
    const report = evaluateThreejsRigReadiness(unanchored);
    expect(report.articulationReady).toBe(false);
    expect(report.attachmentCount).toBe(1);
    expect(report.anchoredAttachmentCount).toBe(0);
    expect(report.unanchoredAttachmentCount).toBe(1);
    expect(report.reasons[0]).toContain('name nothing to hang from');
    expect(report.reasons[0]).toContain('pack');
  });

  it('accepts a socket anchor as an anchor, so a part on a named pivot still counts', () => {
    const socketAnchored = spec();
    socketAnchored.articulation.attachments = [{ partId: 'pack', anchorPartId: null, anchorSocket: 'shoulder', maxOffset: 0.25 }];
    const report = evaluateThreejsRigReadiness(socketAnchored);
    expect(report.articulationReady).toBe(true);
    expect(report.anchoredAttachmentCount).toBe(1);
  });

  // The two forms name the same part, so it is one attachment — and the anchored
  // entry is the one the author meant.
  it('merges a part declared in both attachment forms into one anchored entry', () => {
    const both = spec();
    both.articulation.attachmentPartIds = ['pack'];
    const report = evaluateThreejsRigReadiness(both);
    expect(report.attachmentCount).toBe(1);
    expect(report.anchoredAttachmentCount).toBe(1);
    expect(report.unanchoredAttachmentCount).toBe(0);
  });

  it('degrades to a not-ready static report for a missing spec instead of throwing', () => {
    const report = evaluateThreejsRigReadiness(null);
    expect(report.articulationReady).toBe(false);
    expect(report.subjectType).toBeNull();
    expect(report.jointCount).toBe(0);
  });
});
