/**
 * Friendly universe-tag transforms for catalog ingredients backfilled from
 * universe canon.
 *
 * Pure transform that rewrites legacy machine universe tags (`from-universe`, `universe:<id>`) on
 * backfilled catalog ingredients into friendly universe-NAME tags, preserving user tags + the
 * structured `catalog_ingredient_refs` link. Used by the boot-time repair and the bible→catalog
 * backfill.
 *
 * The original bible→catalog backfill stamped MACHINE tags (`from-universe` plus
 * `universe:<universeId>`) that leak an internal id into the tag taxonomy. The
 * structured link is durable in `catalog_ingredient_refs`, so the tag need not carry
 * the id. These helpers swap them for the friendly universe NAME tag while preserving
 * user tags; used by the boot-time repair (`server/scripts/repairUniverseTags.js`) and
 * the backfill (`server/scripts/migrateBibleToCatalog.js`).
 *
 * Pure + dependency-free so they unit-test without a DB.
 */


export const LEGACY_UNIVERSE_MARKER_TAG = 'from-universe';

export const LEGACY_UNIVERSE_ID_TAG_PREFIX = 'universe:';

/** True for `from-universe` or any `universe:<anything>` (prefix match; case-insensitive). */
export function isLegacyUniverseTag(tag) {
  if (typeof tag !== 'string') return false;
  const t = tag.trim().toLowerCase();
  if (t === LEGACY_UNIVERSE_MARKER_TAG) return true;
  return t.startsWith(LEGACY_UNIVERSE_ID_TAG_PREFIX);
}

/** The id from a legacy `universe:<id>` tag, or null (the bare marker carries no id). */
export function universeIdFromLegacyTag(tag) {
  if (typeof tag !== 'string') return null;
  const t = tag.trim();
  if (!t.toLowerCase().startsWith(LEGACY_UNIVERSE_ID_TAG_PREFIX)) return null;
  const id = t.slice(LEGACY_UNIVERSE_ID_TAG_PREFIX.length).trim();
  return id || null;
}

/**
 * Compute the friendly tag set for an ingredient's tags: strips legacy machine tags,
 * appends the universe NAME (via `nameForId`) per distinct id, and preserves user tags in
 * order, de-duplicated by `canonicalKey` against kept tags and added names.
 *
 * Returns `{ tags, changed, unresolved }`. `changed` is false when nothing was rewritten
 * (callers skip a no-op write); `unresolved` means a `universe:<id>` tag is still
 * carried because its name did not resolve.
 *
 * @param {string[]} tags          existing ingredient tags
 * @param {(id:string)=>string|null|undefined} nameForId   universe id → name
 * @param {(label:string)=>string} canonicalKey            tag dedup key fn
 */
export function friendlifyUniverseTags(tags, nameForId, canonicalKey) {
  const input = Array.isArray(tags) ? tags : [];

  // GATE on the `from-universe` marker, which the backfill always stamped alongside
  // `universe:<id>`. Without it `universe:<anything>` is a legitimate USER tag
  // (e.g. `universe:marvel`), so leave the row untouched.
  const hasMarker = input.some((t) => typeof t === 'string'
    && t.trim().toLowerCase() === LEGACY_UNIVERSE_MARKER_TAG);
  if (!hasMarker) return { tags: input, changed: false, unresolved: false };

  const kept = [];
  let sawMarker = false;
  const idTags = []; // { id, original } in encounter order, first-seen-per-id

  const seenId = new Set();
  for (const tag of input) {
    if (isLegacyUniverseTag(tag)) {
      const id = universeIdFromLegacyTag(tag);
      if (!id) { sawMarker = true; continue; }   // the `from-universe` marker
      if (!seenId.has(id)) { seenId.add(id); idTags.push({ id, original: tag }); }
      continue;
    }
    kept.push(tag);
  }

  // An unresolvable name KEEPS the `universe:<id>` tag so a later run can still
  // friendlify it; dropping it would lose the id permanently.
  const names = [];
  const unresolvedIdTags = [];
  for (const { id, original } of idTags) {
    const name = nameForId(id);
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
    else unresolvedIdTags.push(original);
  }

  const seen = new Set(kept.map((t) => canonicalKey(t)));
  const addedNames = [];
  for (const name of names) {
    const key = canonicalKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    addedNames.push(name);
  }

  // Keep the marker only while an id is unresolved, so the row stays flagged for retry.
  const keepMarker = sawMarker && unresolvedIdTags.length > 0;
  const result = [
    ...kept,
    ...addedNames,
    ...unresolvedIdTags,
    ...(keepMarker ? [LEGACY_UNIVERSE_MARKER_TAG] : []),
  ];

  // `changed` only when a name was added or a legacy tag removed; an all-unresolved row
  // is left untouched so the next run retries without a no-op write.
  const removedLegacy = (idTags.length - unresolvedIdTags.length) > 0 || (sawMarker && !keepMarker);
  const changed = addedNames.length > 0 || removedLegacy;
  // The repair driver uses `unresolved` to withhold its completion marker so a later boot retries.
  return { tags: result, changed, unresolved: unresolvedIdTags.length > 0 };
}
