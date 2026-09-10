/**
 * Universe bible field size limits — shared between server (sanitizer,
 * pipeline) and client (form inputs). A universe bible field that must
 * carry distinct economies, jurisdictions, travel rules, route logistics,
 * and several sites can legitimately need well beyond 8k; these remain
 * runaway-payload guards, not instructions to crush readable prose.
 */

export const LOGLINE_MAX = 500;
export const PREMISE_MAX = 20000;
export const STYLE_NOTES_MAX = 4000;
export const INFLUENCE_ENTRY_MAX = 120;
export const INFLUENCES_PER_LIST_MAX = 30;
export const STYLE_REFERENCES_MAX = 20;

export const LOCKABLE_FIELDS = Object.freeze([
  'starterPrompt',
  'logline',
  'premise',
  'styleNotes',
  'influencesEmbrace',
  'influencesAvoid',
]);
