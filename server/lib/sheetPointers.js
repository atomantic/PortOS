/** Browser-safe persisted reference-sheet layout shared by canon consumers. */
import { isPlainObject } from './objects.js';

// Standard sheets retain their legacy field; other variants use map slots.
export const LEGACY_SHEET_VARIANT_ID = 'standard';

/** Read the persisted reference-sheet filename for a variant. Returns the
 *  string filename or null. The single read-side helper every consumer
 *  (client + server) should use so storage-shape changes stay local. */
export function readSheetPointer(character, variant) {
  if (!character) return null;
  if (variant === LEGACY_SHEET_VARIANT_ID) return character.referenceSheetImageRef || null;
  const sheets = character.referenceSheets;
  if (!isPlainObject(sheets)) return null;
  return sheets[variant] || null;
}

/** Enumerate every reference-sheet pointer a character holds — yields one
 *  `{ variant, filename }` per non-empty slot. The single iteration-side
 *  helper for prune / purge / exporter / asset-collector. */
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

/** Apply (or clear, when `filename` is null) a variant's pointer on a
 *  character, returning a NEW character object — OR the same reference when
 *  the slot already holds the target value, so callers downstream of an
 *  `updateUniverse` mutator (and React subscribers on the client mirror)
 *  can short-circuit no-op writes/renders. Writes the legacy variant to
 *  `referenceSheetImageRef`; every other variant lands in / leaves from
 *  `referenceSheets[variant]`. */
export function applySheetPointerToCharacter(character, variant, filename) {
  if (!character) return character;
  if (variant === LEGACY_SHEET_VARIANT_ID) {
    const next = filename || null;
    if ((character.referenceSheetImageRef || null) === next) return character;
    return { ...character, referenceSheetImageRef: next };
  }
  const existing = isPlainObject(character.referenceSheets) ? character.referenceSheets : {};
  if (filename) {
    if (existing[variant] === filename) return character;
    return { ...character, referenceSheets: { ...existing, [variant]: filename } };
  }
  if (!(variant in existing)) return character;
  const { [variant]: _dropped, ...rest } = existing;
  return { ...character, referenceSheets: rest };
}

/** Browser writes historically default an omitted variant to standard. */
export const applySheetPointer = (character, variant, filename) => (
  applySheetPointerToCharacter(character, variant || LEGACY_SHEET_VARIANT_ID, filename)
);
