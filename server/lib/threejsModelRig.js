/**
 * Rig-readiness report for an already-validated Three.js scene spec.
 *
 * PortOS generates static assemblies. It does not skin a mesh, bind a bind pose,
 * or export a skeleton, and the honest thing to publish is therefore not "this
 * model is animation-ready" but "this model declares an articulation graph a
 * later rig/export path could attach to — or it does not, and here is why".
 *
 * `threejsSculptSpecSchema` already proves the graph is well FORMED: one root,
 * no cycles or forward references, joints pointed at real parts, pivots pointed
 * at real sockets. What it cannot say is whether the graph is USEFUL — a single
 * root joint, or child joints with no pivot axis, validate cleanly and rig into
 * nothing. That judgement lives here, and it reports rather than rejects: a spec
 * that falls short is still a good model, it is just a static one.
 */

import { listSpecNames } from './threejsModel.js';

// One joint is a root and nothing else — a graph with nothing to rotate against
// it describes a static assembly with extra words.
const MIN_USEFUL_JOINTS = 2;

const jointLabel = (joint) => joint.id;

/**
 * @param {object|null} spec a spec that has already passed a sculpt-spec schema
 * @returns {{articulationReady: boolean, reasons: string[], jointCount: number,
 *   socketCount: number, attachmentCount: number, rootJointId: string|null,
 *   subjectType: string|null}}
 */
export function evaluateThreejsRigReadiness(spec) {
  const subjectType = spec?.subjectType || null;
  const articulation = spec?.articulation || null;
  const joints = Array.isArray(articulation?.joints) ? articulation.joints : [];
  const attachmentCount = Array.isArray(articulation?.attachmentPartIds)
    ? articulation.attachmentPartIds.length
    : 0;
  const rootJoint = joints.find((joint) => !joint.parentJointId) || null;
  // Distinct sockets, not joint count: two joints naming the same pivot is one
  // usable axis, and reporting two would overstate what the model can be rigged
  // against.
  const socketCount = new Set(joints.map((joint) => joint.pivotSocket).filter(Boolean)).size;
  const reasons = [];

  if (!articulation) {
    reasons.push(subjectType === 'character' || subjectType === 'hybrid'
      ? 'The spec declares no articulation graph, so this character is a static assembly — its parts have a hierarchy but no joints, pivots, or bind pose.'
      : 'This subject was generated as a static assembly and declares no articulation graph.');
  } else {
    if (joints.length < MIN_USEFUL_JOINTS) {
      reasons.push(`Only ${joints.length} joint is declared, which is a root and nothing to move against it.`);
    }
    // A root's pivot is the model origin; a child joint without one has no axis
    // to rotate about, so the graph names moving parts it cannot actually move.
    const unpivoted = joints.filter((joint) => joint.parentJointId && !joint.pivotSocket);
    if (unpivoted.length > 0) {
      reasons.push(`${unpivoted.length} of ${joints.length} joints name no pivot socket, so they have no axis to rotate about (${listSpecNames(unpivoted.map(jointLabel))}).`);
    }
  }

  return {
    articulationReady: reasons.length === 0,
    reasons,
    jointCount: joints.length,
    socketCount,
    attachmentCount,
    rootJointId: rootJoint?.id || null,
    subjectType,
  };
}
