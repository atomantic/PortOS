/**
 * Anchoring rules for USER-entered backup exclude patterns. CLIENT MIRROR of the
 * backup-exclude block in `server/lib/sharedSchemas.js` (#7241); keep the logic in sync.
 *
 * Excludes are rsync FILTER syntax: a pattern is anchored to the transfer root only when it starts with `/`, otherwise it matches at EVERY depth (`cache/` would also drop nested per-run caches), surfacing only at restore. Anchoring happens at READ time (`computeEffectiveExcludes`); stored settings stay as typed, so nothing needs migrating. The Backup tab uses these so the chip shown is the filter rsync receives.
 */

/** Longest pattern accepted, measured on the ANCHORED form handed to rsync (bounding raw input would let 256 chars pass then anchor to 257). */
export const EXCLUDE_PATTERN_MAX_LENGTH = 256;

// Already anchored (`/…`) or deliberately any-depth (`*…`, covers `**`) is left alone.
const isAnchoredOrWildcardLed = (pattern) => pattern.startsWith('/') || pattern.startsWith('*');

/**
 * Normalize ONE user-entered pattern to what rsync is handed; the single definition of a legal pattern (`isSafeExcludePattern` derives from it so the settings boundary and read-time normalizer can't disagree).
 * @param {unknown} pattern
 * @returns {string|null} the anchored pattern, or null when blank, non-string or unsafe.
 */
export function anchorUserExclude(pattern) {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  // NUL truncates the rsync argument; any `..` segment walks out of the data root.
  if (!trimmed || trimmed.includes('\0')) return null;
  if (trimmed.split('/').includes('..')) return null;
  const anchored = isAnchoredOrWildcardLed(trimmed) ? trimmed : `/${trimmed}`;
  return anchored.length <= EXCLUDE_PATTERN_MAX_LENGTH ? anchored : null;
}

export const isSafeExcludePattern = (pattern) => anchorUserExclude(pattern) !== null;

/** Normalize a whole user list, dropping blank/unsafe entries and anchoring/whitespace duplicates. */
export function anchorUserExcludes(patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  return [...new Set(list.map(anchorUserExclude).filter(Boolean))];
}
