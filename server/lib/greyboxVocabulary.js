/**
 * Greybox constants both sides of the wire agree on, kept DEPENDENCY-FREE so
 * the client imports them directly (`greyboxScene.js` pulls in zod, which the
 * client CI job does not install).
 */

/** Maximum authored instruction length, shared with request validation. */
export const GREYBOX_INSTRUCTION_MAX = 4000;

export const GREYBOX_ASPECTS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '21:9']);

/** Media role on a place's reference image that a saved shot's capture carries. */
export const GREYBOX_SHOT_ROLE_PREFIX = 'greybox-shot:';

/** A saved shot id fits inside the 64-character media role it is tagged with. */
export const GREYBOX_SHOT_ID_MAX = 64 - GREYBOX_SHOT_ROLE_PREFIX.length;
export const GREYBOX_SHOT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Figure placement instructions stay separate from the director's authored text. */
export function greyboxFigurePromptLines(scene, shot) {
  return (shot?.figures || []).map((figure) => {
    const anchor = scene.anchors.find((a) => a.id === figure.anchorId);
    return anchor ? `${anchor.label} stands at the "${anchor.id}" mark${figure.pose ? `, ${figure.pose}` : ''}` : null;
  }).filter(Boolean);
}
