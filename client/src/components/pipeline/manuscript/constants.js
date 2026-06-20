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

export const CATEGORY_LABEL = {
  'missing-content': 'Missing content',
  'arc-gap': 'Arc gap',
  // Character-arc findings (#1293/#1295): POV justification + transition beats /
  // flat-arc warnings from the arc.transitions editorial check.
  arc: 'Character arc',
  'character-gap': 'Character gap',
  // Plot-structure findings (#1310): passive protagonist, deus ex machina, idiot
  // plot, flat stakes, sagging middle, dropped subplots from plot.structure-momentum.
  plot: 'Plot structure',
  // Theme-coherence findings (#1317): stated-but-undramatized / dropped / unpaid
  // themes and emergent-theme suggestions from the theme.coherence check.
  theme: 'Theme',
  // Casting findings (#1292/#1312/#1412): roster economy / throwaway names, cast
  // representation balance, and unmodeled proper nouns used as character names.
  casting: 'Casting',
  pacing: 'Pacing',
  continuity: 'Continuity',
  style: 'Style',
  exposition: 'Exposition',
  // Comic lettering-density findings (#1313): over-stuffed balloons/panels/pages
  // from the comic.lettering-density editorial check.
  lettering: 'Lettering',
  other: 'Note',
};

// Approximate a textarea's height to its content so the manuscript reads as one
// continuous scroll (lets jump-to-anchor scroll the page, not an inner box).
export const rowsFor = (text) => Math.min(400, Math.max(8, (text || '').split('\n').length + 1));
