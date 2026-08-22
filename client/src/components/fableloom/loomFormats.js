/**
 * Client mirror of the loom scene formats (`server/services/fableLoom/formats.js`).
 *
 * The server owns the prompt contracts; the client owns only the labels and the
 * option order, so the index form's select, the settings drawer's select, and
 * the index card's badge all read the same list. Keep the ids in step with
 * `LOOM_FORMATS` server-side — a format the server rejects would fail the
 * PATCH at the door.
 */

export const LOOM_FORMATS = [
  { id: 'prose', label: 'Narrated prose', hint: 'Second-person interactive fiction — flowing paragraphs.' },
  { id: 'teleplay', label: 'Teleplay', hint: 'Sluglines, action lines, and character cues, in screenplay format.' },
];

export const loomFormatLabel = (id) => LOOM_FORMATS.find((f) => f.id === id)?.label || LOOM_FORMATS[0].label;
export const loomFormatHint = (id) => LOOM_FORMATS.find((f) => f.id === id)?.hint || LOOM_FORMATS[0].hint;

/** The one format predicate — display, editor typography, and badges share it. */
export const isTeleplayFormat = (id) => id === 'teleplay';

/**
 * Does this scene still need rewriting into `format`? Mirrors the server's own
 * filter (`needsReformat` in `server/services/fableLoom/weave.js`): a scene is
 * pending when it HAS prose and that prose isn't already stamped with the
 * target format. Title-only placeholders are never sent — there is no beat in
 * them to preserve, so the model would invent one.
 */
export const sceneNeedsReformat = (node, format) =>
  !!node?.prose?.trim() && node.format !== format;

/**
 * The episodes a rewrite still has work in, with their pending scene counts.
 * The rewrite is one request per episode, so this is the walk the drawer makes
 * and the denominator of its progress line.
 */
export const episodesNeedingReformat = (loom, format) => (loom?.episodes || [])
  .map((episode) => ({
    episode,
    sceneCount: episode.nodes.filter((n) => sceneNeedsReformat(n, format)).length,
  }))
  .filter((e) => e.sceneCount > 0);
