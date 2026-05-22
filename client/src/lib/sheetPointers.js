// Client mirror of the sheet-pointer storage helpers from
// `server/lib/storyBible.js`. The server is authoritative — when the storage
// shape changes (legacy `referenceSheetImageRef` field vs `referenceSheets`
// map slots), update both sides verbatim.

export const LEGACY_SHEET_VARIANT_ID = 'standard';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function readSheetPointer(character, variant) {
  if (!character) return null;
  if (variant === LEGACY_SHEET_VARIANT_ID) return character.referenceSheetImageRef || null;
  if (!isPlainObject(character.referenceSheets)) return null;
  return character.referenceSheets[variant] || null;
}

export function listSheetPointers(character) {
  if (!character) return [];
  const out = [];
  if (character.referenceSheetImageRef) {
    out.push({ variant: LEGACY_SHEET_VARIANT_ID, filename: character.referenceSheetImageRef });
  }
  if (isPlainObject(character.referenceSheets)) {
    for (const [variant, filename] of Object.entries(character.referenceSheets)) {
      if (filename) out.push({ variant, filename });
    }
  }
  return out;
}

// Returns the same character reference when the slot already holds the target
// value, so React subscribers downstream of `setUniverse` can short-circuit
// the re-render — a duplicate SSE 'completed' under StrictMode dev double-mount
// (or a poll-then-server-stamp race) would otherwise churn the canon list.
export function applySheetPointer(character, variant, filename) {
  if (!character) return character;
  const v = variant || LEGACY_SHEET_VARIANT_ID;
  if (v === LEGACY_SHEET_VARIANT_ID) {
    const next = filename || null;
    if ((character.referenceSheetImageRef || null) === next) return character;
    return { ...character, referenceSheetImageRef: next };
  }
  const existing = isPlainObject(character.referenceSheets) ? character.referenceSheets : {};
  if (filename) {
    if (existing[v] === filename) return character;
    return { ...character, referenceSheets: { ...existing, [v]: filename } };
  }
  if (!(v in existing)) return character;
  const { [v]: _dropped, ...rest } = existing;
  return { ...character, referenceSheets: rest };
}
