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

export const isMemoryLinkType = (value) => MEMORY_LINK_TYPES.includes(value);

/** Only `related` gets a reverse row. */
export const isSymmetricMemoryLinkType = (type) => type === DEFAULT_MEMORY_LINK_TYPE;

/** Absent (null/undefined) means the legacy default; anything else must be a known type. */
export const normalizeMemoryLinkType = (value) => (value == null ? DEFAULT_MEMORY_LINK_TYPE : value);
