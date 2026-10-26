/**
 * Greybox constants both sides of the wire agree on, kept DEPENDENCY-FREE so
 * the client imports them directly (`greyboxScene.js` pulls in zod, which the
 * client CI job does not install).
 */

export const GREYBOX_ASPECTS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '21:9']);

/** Media role on a place's reference image that a saved shot's capture carries. */
export const GREYBOX_SHOT_ROLE_PREFIX = 'greybox-shot:';
