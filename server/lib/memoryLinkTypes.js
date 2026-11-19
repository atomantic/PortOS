/**
 * Closed vocabulary for CoS memory links (`memory_links.link_type`).
 *
 * `related` is symmetric (stored as a reverse pair, the pre-typed behavior);
 * every other type is directed source -> target and stored as one row.
 */

export const DEFAULT_MEMORY_LINK_TYPE = 'related';

export const MEMORY_LINK_TYPES = Object.freeze([
  'related',
  'supersedes',
  'contradicts',
  'derived-from',
  'applies-to'
]);

/** Only `related` gets a reverse row. */
export const isSymmetricMemoryLinkType = (type) => type === DEFAULT_MEMORY_LINK_TYPE;
