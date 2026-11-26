/** Manuscript importer content types and character limits shared by validation, orchestration and intake. */

export const IMPORTER_CONTENT_TYPES = Object.freeze([
  'short-story', 'novel', 'screenplay', 'comic-script',
]);

// The active provider context window can impose a lower operational limit.
export const IMPORTER_SOURCE_CHAR_LIMIT = 5_000_000;

// The classifier reads only enough of the opening to identify structural markers.
export const CLASSIFY_SOURCE_HEAD_CHARS = 4_000;
