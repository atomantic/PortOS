/**
 * Anchoring rules for USER-entered backup exclude patterns.
 *
 * The backup exclude list is rsync FILTER syntax, not a glob list. rsync anchors
 * a pattern to the transfer root only when it starts with `/`; anything else
 * matches at EVERY level of the tree. So a user who types `cache/` to skip
 * `data/cache/` also drops the per-run caches nested under training runs, and
 * `raw/` reaches into sprite runs and universes. The snapshot still reports
 * success — the omission surfaces only at restore, which is exactly when it
 * cannot be fixed.
 *
 * `DEFAULT_EXCLUDES` has always been anchored by hand (and a test in
 * `backup.test.js` fails if one entry is not). This module applies the same rule
 * to the one list a user actually edits.
 *
 * Anchoring happens at READ time (`computeEffectiveExcludes`), never by
 * rewriting stored settings: the stored value stays exactly what the user typed,
 * so there is nothing to migrate and nothing is silently rewritten under them.
 *
 * CLIENT MIRROR of the backup-exclude block at the bottom of
 * `server/lib/sharedSchemas.js` — keep the logic byte-for-byte in sync. It lives
 * beside the Zod fragments there so `backupConfigSchema` and
 * `services/backup.js` share one rule without adding a module to the import
 * closure of `validation.js`, which the whole server suite reaches.
 *
 * The Backup settings tab anchors a newly added pattern and renders the
 * effective list with these, so the chip the user sees is the pattern the
 * server will hand rsync.
 */

/**
 * Longest exclude pattern accepted, measured on the ANCHORED form — the string
 * actually handed to rsync. Bounding the raw input instead would let a
 * 256-character relative pattern pass validation and then anchor to 257, so the
 * settings boundary would reject the very chip the UI had just shown as valid.
 */
export const EXCLUDE_PATTERN_MAX_LENGTH = 256;

/**
 * A pattern is left alone when it is already anchored (`/…`) or deliberately
 * any-depth (`*…`, which covers rsync's `**` spelling). Everything else gets a
 * leading `/`.
 */
const isAnchoredOrWildcardLed = (pattern) => pattern.startsWith('/') || pattern.startsWith('*');

/**
 * Normalize ONE user-entered pattern to the form rsync will be handed. This is
 * the single declaration of what a legal pattern is — `isSafeExcludePattern`
 * below is defined in terms of it, so the settings boundary can never accept
 * something the read-time normalizer would then drop, or vice versa.
 * @param {unknown} pattern
 * @returns {string|null} the anchored pattern, or null when it is blank,
 *   non-string, or unsafe (caller drops it).
 */
export function anchorUserExclude(pattern) {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  // A NUL would truncate the rsync argument; `..` in any segment (`../x`,
  // `a/../../x`, the bare `..`) walks out of the data root.
  if (!trimmed || trimmed.includes('\0')) return null;
  if (trimmed.split('/').includes('..')) return null;
  const anchored = isAnchoredOrWildcardLed(trimmed) ? trimmed : `/${trimmed}`;
  return anchored.length <= EXCLUDE_PATTERN_MAX_LENGTH ? anchored : null;
}

/**
 * Whether a stored/submitted pattern survives normalization. Shared with
 * `lib/validation.js` so the settings boundary rejects exactly what
 * `computeEffectiveExcludes` would have dropped.
 * @param {unknown} pattern
 * @returns {boolean}
 */
export const isSafeExcludePattern = (pattern) => anchorUserExclude(pattern) !== null;

/**
 * Normalize a whole user list, dropping blank/unsafe entries and duplicates
 * that only differed by anchoring or whitespace.
 * @param {unknown} patterns
 * @returns {string[]}
 */
export function anchorUserExcludes(patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  return [...new Set(list.map(anchorUserExclude).filter(Boolean))];
}
