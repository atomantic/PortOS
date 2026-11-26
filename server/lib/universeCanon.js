/** Canonical entity kinds and their persisted story-bible and universe keys. */

export const BIBLE_KIND = Object.freeze({
  CHARACTER: 'character',
  PLACE: 'place',
  OBJECT: 'object',
});

// Canonical pluralization: pipeline series.<field>, evaluator analysis kind,
// extractor LLM envelope key — all the same string, consolidated here.
export const BIBLE_FIELD = Object.freeze({
  [BIBLE_KIND.CHARACTER]: 'characters',
  [BIBLE_KIND.PLACE]: 'places',
  [BIBLE_KIND.OBJECT]: 'objects',
});

// Ordered list of the persisted record's bible-array keys — used by
// store-walkers (e.g. imageRef purge across all kinds) so a future kind
// added here flows through without touching every walker.
export const BIBLE_KEYS = Object.freeze(Object.values(BIBLE_FIELD));

// Frozen list of kind values — for route/Zod kind validation, lock-toggle
// dispatch, and any caller that needs to enumerate kinds.
export const BIBLE_KINDS = Object.freeze(Object.values(BIBLE_KIND));
