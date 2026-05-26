// Canonical Writers Room reference data: length targets, book-length
// estimates, and craft principles. The Guide page renders directly from these
// arrays, and forthcoming editor features (word-count gauges, the emotional-
// roadmap evaluator) read the same source so targets never drift between the
// docs and the tools that enforce them.
//
// Character ranges follow the conventional English estimate of ~5–6 characters
// per word (≈5 letters + 1 space). Min chars use 5×words, max chars use 6×words;
// the literary-category rows below preserve the exact figures from the editorial
// brief and the book table preserves its 5.5–6× page-based estimate.
//
// Page counts assume the conventional ~250–300 words per printed page: min
// pages use 300 wpp (denser, fewer pages), max pages use 250 wpp (looser, more
// pages), each ceil-rounded to a whole page. Chapter ranges derive from the
// conventional ~3,000–5,000 words per chapter: min chapters use 5,000 wpc
// (longer chapters, fewer of them), max chapters use 3,000 wpc (shorter
// chapters, more of them), each ceil-rounded to a whole chapter. Forms read in
// one sitting (microfiction, flash, short story) carry `min`/`max` of `null`
// on `chapters` along with a "single sitting" label so consumers render a
// single uniform shape without a special-case branch.

// Literary length ladder — microfiction through novel. `words`/`chars`/`pages`/
// `chapters` all carry `{ min, max, label }` with a human label for display;
// `min`/`max` may be `null` to express open-ended or not-applicable bounds (an
// open-ended top band, a single-sitting form with no chapter target). `core`
// marks the four categories from the original brief; novella/novel complete the
// ladder for context.
export const WRITING_LENGTH_TARGETS = [
  {
    id: 'microfiction',
    label: 'Microfiction',
    core: true,
    words: { min: null, max: 500, label: '≤500 words' },
    chars: { min: null, max: 3000, label: '≤2,500–3,000 chars' },
    pages: { min: null, max: 2, label: '≤2 pages' },
    chapters: { min: null, max: null, label: 'Single sitting · no chapters' },
    note: 'A single sharp image or turn. Every word load-bearing; no room for sub-plots.',
  },
  {
    id: 'flash-fiction',
    label: 'Flash Fiction',
    core: true,
    words: { min: 750, max: 1000, label: '750–1,000 words' },
    chars: { min: 3750, max: 6000, label: '3,750–6,000 chars' },
    pages: { min: 3, max: 4, label: '3–4 pages' },
    chapters: { min: null, max: null, label: 'Single sitting · no chapters' },
    note: 'One scene, one decisive moment. Implies the world rather than building it.',
  },
  {
    id: 'short-story',
    label: 'Standard Short Story',
    core: true,
    words: { min: 1500, max: 7500, label: '1,500–7,500 words' },
    chars: { min: 7500, max: 45000, label: '7,500–45,000 chars' },
    pages: { min: 5, max: 30, label: '5–30 pages' },
    chapters: { min: null, max: null, label: 'Single sitting · no chapters' },
    note: 'Room for a complete arc with a small cast. The default short-form target.',
  },
  {
    id: 'novelette',
    label: 'Novelette / Long Short Story',
    core: true,
    words: { min: 7500, max: 17500, label: '7,500–17,500 words' },
    chars: { min: 37500, max: 105000, label: '37,500–105,000 chars' },
    pages: { min: 25, max: 70, label: '25–70 pages' },
    chapters: { min: 2, max: 6, label: '2–6 chapters' },
    note: 'Subplots and a fuller secondary cast become viable. Longer than most magazines buy.',
  },
  {
    id: 'novella',
    label: 'Novella',
    core: false,
    words: { min: 17500, max: 40000, label: '17,500–40,000 words' },
    chars: { min: 87500, max: 240000, label: '87,500–240,000 chars' },
    pages: { min: 59, max: 160, label: '59–160 pages' },
    chapters: { min: 4, max: 14, label: '4–14 chapters' },
    note: 'A single dominant throughline with depth — too long for a magazine, too short for a typical print novel.',
  },
  {
    id: 'novel',
    label: 'Novel',
    core: false,
    words: { min: 40000, max: 120000, label: '40,000–120,000 words' },
    chars: { min: 200000, max: 720000, label: '200,000–720,000 chars' },
    pages: { min: 134, max: 480, label: '134–480 pages' },
    chapters: { min: 8, max: 40, label: '8–40 chapters' },
    note: 'Multiple arcs and a full cast. Genre sets the sweet spot (≈70k YA, ≈100k+ epic fantasy).',
  },
];

// Page-based book-length estimate. A printed page holds ~250–300 words depending
// on trim size, font, margins, and genre — these are planning estimates, not
// guarantees. `words`/`chars` carry `{ min, max }` absolute counts plus a label.
export const BOOK_LENGTH_ESTIMATES = [
  {
    id: 'book-200',
    label: '200 pages',
    wordsPerPage: '250–300 words/page',
    words: { min: 50000, max: 60000, label: '50,000–60,000 words' },
    chars: { min: 275000, max: 360000, label: '275,000–360,000 chars' },
  },
  {
    id: 'book-300',
    label: '300 pages',
    wordsPerPage: '250–300 words/page',
    words: { min: 75000, max: 90000, label: '75,000–90,000 words' },
    chars: { min: 412500, max: 540000, label: '412,500–540,000 chars' },
  },
];

// Craft principles the editor surfaces as advice today and will increasingly
// enforce as analysis passes ship. Each group is one card on the Guide page.
export const WRITING_PRINCIPLES = [
  {
    id: 'structure',
    title: 'Structure & Pacing',
    summary: 'Give the reader a shape to fall into.',
    rules: [
      'Open in motion — start the scene as late as possible and end it as early as you can.',
      'Every scene should change something: a value shifts, a question is answered, a new one opens.',
      'Vary rhythm — follow a long, dense passage with a short, sharp one so tension has somewhere to land.',
      'Plant before you pay off. A reveal only lands if its setup was visible (but not obvious) earlier.',
    ],
  },
  {
    id: 'character',
    title: 'Character & Voice',
    summary: 'Readers follow people, not plots.',
    rules: [
      'Give the protagonist a want (external goal) and a need (internal lack) that pull against each other.',
      'Reveal character through choice under pressure, not through narrated description.',
      'Keep each character’s voice distinct enough that dialogue is attributable without tags.',
      'Let secondary characters want things too — a cast of mirrors flattens the page.',
    ],
  },
  {
    id: 'prose',
    title: 'Prose & Clarity',
    summary: 'The sentence is the unit of trust.',
    rules: [
      'Show through concrete, sensory detail; tell only to compress time or summarize the known.',
      'Prefer strong verbs and specific nouns over adverb-and-adjective stacks.',
      'Cut filter words (felt, saw, noticed, realized) that put distance between reader and experience.',
      'Stay in one point of view per scene unless a break is deliberate and signposted.',
    ],
  },
  {
    id: 'revision',
    title: 'Revision Discipline',
    summary: 'Drafts are for discovery; revision is for the reader.',
    rules: [
      'First draft for yourself, second draft for the story, third draft for the reader.',
      'Read aloud — the ear catches clumsy rhythm and repetition the eye skims past.',
      'Kill your darlings: if a beautiful line doesn’t serve the scene, it serves your ego.',
      'Track length against the target band for the form; over-length usually means an unearned subplot.',
    ],
  },
];

// Analysis passes the editor performs or will perform. The emotional-roadmap
// evaluator is the headline forthcoming feature called out in the brief; listing
// these here keeps the Guide honest about what is live vs. planned.
export const PLANNED_ANALYSES = [
  {
    id: 'emotional-roadmap',
    title: 'Emotional Roadmap',
    status: 'planned',
    summary:
      'Evaluate the story beat by beat to chart the emotional journey the reader will experience — where tension rises and falls, where the highs and lows land, and whether the curve delivers a satisfying arc rather than a flat line.',
  },
  {
    id: 'length-check',
    title: 'Length & Form Fit',
    status: 'planned',
    summary:
      'Compare the live word/character count against the target band for the chosen form and flag a work that is drifting under- or over-length for its category.',
  },
];

// Resolve a word count to its literary-ladder category. The ladder is ordered
// ascending by upper bound, and the brief's bands have gaps (≤500 then 750–1000
// then 1,500–7,500…), so we match on the first band whose `max` the count fits
// under rather than requiring `min ≤ count ≤ max` — a 600-word draft rounds up
// to flash instead of falling into a gap.
//
// Boundary handling: the conventional literary ladder shares boundary values
// between adjacent bands (a 7,500-word piece is the floor of "novelette" and the
// ceiling of "short story"; likewise 17,500 and 40,000). The display labels keep
// the conventional inclusive ranges, but classification must be deterministic, so
// at a shared boundary the HIGHER band wins (7,500 → novelette, 17,500 → novella,
// 40,000 → novel). We implement that by treating a band's `max` as exclusive when
// it equals the next band's `min`; otherwise the `max` is inclusive (so the gap
// rounding above still works — 600 ≤ flash.max 1000 with no overlap to skip).
//
// Returns null only for invalid input; anything above every band is a (large)
// novel. Future word-count gauges call this to label a draft.
export function classifyByWordCount(wordCount) {
  if (typeof wordCount !== 'number' || !Number.isFinite(wordCount) || wordCount < 0) return null;
  for (let i = 0; i < WRITING_LENGTH_TARGETS.length; i++) {
    const target = WRITING_LENGTH_TARGETS[i];
    const max = target.words.max;
    if (max == null) return target; // open-ended top band
    const next = WRITING_LENGTH_TARGETS[i + 1];
    // At a shared boundary (this.max === next.min) the higher band owns the
    // boundary value, so treat max as exclusive there; otherwise inclusive.
    const boundaryBelongsToNext = next != null && next.words.min === max;
    if (boundaryBelongsToNext ? wordCount < max : wordCount <= max) return target;
  }
  return WRITING_LENGTH_TARGETS[WRITING_LENGTH_TARGETS.length - 1];
}
