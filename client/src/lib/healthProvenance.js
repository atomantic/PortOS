// Provenance taxonomy for health / longevity insights — the trust model behind
// the source-style chips on MeatSpace, genome, death-clock, and longevity views.
// It mirrors the spirit of Ask's source chips: every number on screen declares
// how it was derived, so a modeled projection never reads as a measured fact.
//
// Pure data only (no React / lucide) so it stays unit-testable and reusable. The
// `ProvenanceChip` component maps each level's `tone` to a color and `id` to an
// icon — keep presentation concerns there, not here.
//
// Levels (most → least grounded in the user's own measured data):
//   data-backed  — read straight off measured/imported records
//   inferred     — modeled from those records via population research
//   experimental — emerging methods, promising but not yet clinical standard
//   speculative  — forward-looking projection, not a measurement

export const PROVENANCE_LEVELS = {
  'data-backed': {
    id: 'data-backed',
    label: 'Data-backed',
    tone: 'success',
    description:
      'Read directly from data you measured or imported — a value on record, not a model output.',
    whatWouldChange:
      'New lab results, device readings, or corrected entries update this directly.',
  },
  inferred: {
    id: 'inferred',
    label: 'Inferred',
    tone: 'accent',
    description:
      'Modeled from your data using population research and statistical associations.',
    whatWouldChange:
      'Refining the inputs it draws on — genome, lifestyle, body metrics — shifts the estimate.',
  },
  experimental: {
    id: 'experimental',
    label: 'Experimental',
    tone: 'warning',
    description:
      'Derived from emerging methods that are promising but not yet clinically standard.',
    whatWouldChange:
      'As the underlying science matures and you re-test, confidence in this improves.',
  },
  speculative: {
    id: 'speculative',
    label: 'Speculative',
    tone: 'muted',
    description:
      'A forward-looking projection built on assumptions about the future, not a measurement.',
    whatWouldChange:
      'Future breakthroughs and changes in your trajectory can move this substantially.',
  },
};

export const PROVENANCE_LEVEL_IDS = Object.keys(PROVENANCE_LEVELS);

const FALLBACK_LEVEL = PROVENANCE_LEVELS.inferred;

// Resolve a level id (case- and separator-tolerant: "Data Backed", "data_backed",
// "DATA-BACKED" all match) to its metadata. An unknown/missing id degrades to
// `inferred` so a typo renders a sensible chip instead of crashing the view.
export function getProvenanceLevel(level) {
  if (!level || typeof level !== 'string') return FALLBACK_LEVEL;
  const key = level.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return PROVENANCE_LEVELS[key] ?? FALLBACK_LEVEL;
}
