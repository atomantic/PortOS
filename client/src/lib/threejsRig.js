/**
 * Client mirror of `server/lib/threejsModelRig.js`'s readiness rule, plus the
 * joint lookup the preview needs to label a picked part.
 *
 * The server writes an authoritative report onto the record at generation time.
 * The preview is handed a bare `spec` (and a record generated before the report
 * shipped has none at all), so it derives the same verdict from the spec rather
 * than inventing a second, looser one — a preview that says "articulation-ready"
 * while the detail panel says "static" is worse than either answer alone.
 *
 * Keep the thresholds here and in the server module in step.
 */

const MIN_USEFUL_JOINTS = 2;

/**
 * @param {object|null} spec a validated sculpt spec, or null
 * @returns {{articulationReady: boolean, jointCount: number, socketCount: number,
 *   attachmentCount: number, jointsByPartId: object}}
 */
export function summarizeThreejsArticulation(spec) {
  const joints = Array.isArray(spec?.articulation?.joints) ? spec.articulation.joints : [];
  const attachments = Array.isArray(spec?.articulation?.attachmentPartIds)
    ? spec.articulation.attachmentPartIds
    : [];
  // Null-prototype: part ids are provider-authored and the id schema accepts
  // `toString`, so a bare lookup on a plain object can hand back a function.
  const jointsByPartId = Object.create(null);
  for (const joint of joints) jointsByPartId[joint.partId] = joint;
  const unpivoted = joints.filter((joint) => joint.parentJointId && !joint.pivotSocket);
  return {
    articulationReady: joints.length >= MIN_USEFUL_JOINTS && unpivoted.length === 0,
    jointCount: joints.length,
    socketCount: new Set(joints.map((joint) => joint.pivotSocket).filter(Boolean)).size,
    attachmentCount: attachments.length,
    jointsByPartId,
  };
}
