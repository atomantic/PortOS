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
 * Client mirror of `resolveThreejsAttachments` in `server/lib/threejsModel.js`.
 *
 * A spec declares carried parts in two forms — the original anchor-less
 * `attachmentPartIds` and the anchored `attachments` — and both mean the same
 * thing, so the counts are derived from one merged list. An anchored entry wins
 * over a bare id for the same part.
 *
 * @param {object|null} articulation a spec's `articulation` object, or null
 * @returns {Array<{partId: string, anchored: boolean}>}
 */
function resolveAttachments(articulation) {
  const entries = new Map();
  const bareIds = Array.isArray(articulation?.attachmentPartIds) ? articulation.attachmentPartIds : [];
  for (const partId of bareIds) {
    if (typeof partId !== 'string' || entries.has(partId)) continue;
    entries.set(partId, { partId, anchored: false });
  }
  const anchored = Array.isArray(articulation?.attachments) ? articulation.attachments : [];
  for (const attachment of anchored) {
    if (typeof attachment?.partId !== 'string') continue;
    entries.set(attachment.partId, {
      partId: attachment.partId,
      anchored: Boolean(attachment.anchorPartId) || Boolean(attachment.anchorSocket),
    });
  }
  return [...entries.values()];
}

/**
 * @param {object|null} spec a validated sculpt spec, or null
 * @returns {{articulationReady: boolean, jointCount: number, socketCount: number,
 *   attachmentCount: number, anchoredAttachmentCount: number,
 *   unanchoredAttachmentCount: number, jointsByPartId: object}}
 */
export function summarizeThreejsArticulation(spec) {
  const joints = Array.isArray(spec?.articulation?.joints) ? spec.articulation.joints : [];
  const attachments = resolveAttachments(spec?.articulation);
  const unanchoredAttachmentCount = attachments.filter((attachment) => !attachment.anchored).length;
  // Null-prototype: part ids are provider-authored and the id schema accepts
  // `toString`, so a bare lookup on a plain object can hand back a function.
  const jointsByPartId = Object.create(null);
  for (const joint of joints) jointsByPartId[joint.partId] = joint;
  const unpivoted = joints.filter((joint) => joint.parentJointId && !joint.pivotSocket);
  return {
    // An attachment that names nothing to hang from is a declaration with no
    // relationship in it, so — same rule the server applies — it keeps the graph
    // out of "ready" rather than being credited toward it.
    articulationReady: joints.length >= MIN_USEFUL_JOINTS
      && unpivoted.length === 0
      && unanchoredAttachmentCount === 0,
    jointCount: joints.length,
    socketCount: new Set(joints.map((joint) => joint.pivotSocket).filter(Boolean)).size,
    attachmentCount: attachments.length,
    anchoredAttachmentCount: attachments.length - unanchoredAttachmentCount,
    unanchoredAttachmentCount,
    jointsByPartId,
  };
}
