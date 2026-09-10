/**
 * Shared display constants for the Manuscript editor (page + section + card +
 * preview). Pure data — co-located with the manuscript components.
 */

export const STAGE_LABEL = { comicScript: 'comic script', teleplay: 'teleplay', prose: 'prose', idea: 'outline' };

// Format switcher: the three manuscript formats the editor can span the full
// story in. Order mirrors the server's MANUSCRIPT_STAGES precedence.
export const MANUSCRIPT_TYPES = [
  { id: 'comicScript', label: 'Comic' },
  { id: 'teleplay', label: 'Teleplay' },
  { id: 'prose', label: 'Prose' },
];

export const SEVERITY_TONE = {
  high: 'bg-port-error/15 text-port-error border-port-error/40',
  medium: 'bg-port-warning/15 text-port-warning border-port-warning/40',
  low: 'bg-gray-600/20 text-gray-300 border-port-border',
};

// In-text underline color per severity (the Grammarly-style mark). Kept separate
// from SEVERITY_TONE (which is the badge pill styling) so the underline reads as
// a decoration rather than a filled block.
export const SEVERITY_UNDERLINE = {
  high: 'border-port-error',
  medium: 'border-port-warning',
  low: 'border-gray-500',
};

// Re-export the server-owned browser-safe leaf so category chips cannot drift
// from the categories declared by built-in editorial checks.
export { FINDING_CATEGORY_LABELS as CATEGORY_LABEL } from '../../../../../server/lib/editorial/findingCategories.js';

// Per-check finding sub-classifications (#1626). A finding's optional `subtype`
// names *why* it was flagged within its category — currently only
// `dialogue.on-the-nose` sets one (exposition / emotion-tell / relationship-report)
// so writers get specific, actionable feedback. An unmapped subtype renders its
// raw value; a `null` subtype renders no badge.
export const SUBTYPE_LABEL = {
  exposition: 'Exposition',
  'emotion-tell': 'Emotion-tell',
  'relationship-report': 'Relationship-report',
};

// Resolve a subtype to its display label. Use this (not a bare
// `SUBTYPE_LABEL[subtype] || subtype`) so a hand-edited / older-peer record whose
// subtype is a prototype key (`__proto__`, `constructor`, `toString`) can't return
// an inherited Object.prototype member — a truthy non-string that the `|| subtype`
// fallback wouldn't catch and that React then throws on as a non-element child.
export const subtypeLabel = (subtype) =>
  (Object.hasOwn(SUBTYPE_LABEL, subtype) ? SUBTYPE_LABEL[subtype] : null) || subtype;

// Approximate a textarea's height to its content so the manuscript reads as one
// continuous scroll (lets jump-to-anchor scroll the page, not an inner box).
export const rowsFor = (text) => Math.min(400, Math.max(8, (text || '').split('\n').length + 1));
