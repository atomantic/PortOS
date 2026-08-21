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
