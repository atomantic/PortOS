/**
 * Client mirror of `server/lib/threejsModelRig.js`'s readiness rule (keep the thresholds in step), plus the joint lookup the preview needs to label a picked part.
 *
 * `summarizeThreejsArticulation(spec)` → `{ articulationReady, jointCount, socketCount, attachmentCount, anchoredAttachmentCount, unanchoredAttachmentCount, jointsByPartId }`, used by the Three.js Models preview, which is handed a bare spec rather than the record's stored report (and none at all for a model generated before rig readiness shipped), so it derives the same verdict rather than a second, looser one.
 * A spec with no `articulation` key is a static assembly; a graph is ready only when it carries more than a lone root, every child joint names a pivot socket, and every declared attachment names what it hangs from (the anchored `attachments` and the older anchor-less `attachmentPartIds` merge into one count). `jointsByPartId` is null-prototype so a provider-authored part id can't resolve to an inherited function.
 */

const MIN_USEFUL_JOINTS = 2;

/**
 * Client mirror of `resolveThreejsAttachments` in `server/lib/threejsModel.js`. A spec declares carried parts as the anchor-less `attachmentPartIds` or the anchored `attachments` (same meaning), so counts come from one merged list in which an anchored entry wins over a bare id for the same part.
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
