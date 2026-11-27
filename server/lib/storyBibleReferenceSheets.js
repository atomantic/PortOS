/** Preserve and prune server-stamped character reference sheets at the filesystem boundary. */

import { resolveImageRef } from './fileUtils.js';
import { applySheetPointerToCharacter, listSheetPointers } from './sheetPointers.js';
import { isPlainObject } from './objects.js';

/** Merge `prev`'s server-stamped sheet pointers into `patchChar`, keeping
 *  cur's value for every slot whose underlying file still exists on disk.
 *  Run by the `updateUniverse` literal-patch preservation guard so a stale
 *  client snapshot can't clobber a render-completion stamp that landed
 *  between GET and PATCH. Per-key for the map: each `referenceSheets[k]`
 *  is considered independently so a freshly-stamped 'blueprint' survives
 *  even when the patch carries an older `referenceSheets` (or omits it).
 *
 *  `resolveExists(filename) → boolean` is injected so this helper stays
 *  pure with respect to the FS — callers wire `resolveImageRef(..., { mustExist: true })`
 *  in. Returns a new character object; callers should treat it as
 *  immutable-by-convention. */
export function mergePreservedSheetPointers(prev, patchChar, resolveExists) {
  if (!prev || !patchChar) return patchChar;
  // Intent has no file yet and must survive even if a prior sheet was deleted.
  const out = { ...patchChar, referenceSheetRequests: prev.referenceSheetRequests ?? {} };

  if (prev.referenceSheetImageRef && resolveExists(prev.referenceSheetImageRef)) {
    out.referenceSheetImageRef = prev.referenceSheetImageRef;
  }

  const prevMap = isPlainObject(prev.referenceSheets) ? prev.referenceSheets : null;
  if (prevMap) {
    const patchMap = isPlainObject(patchChar.referenceSheets) ? patchChar.referenceSheets : {};
    // Preserved keys win over the patch — same one-way precedence as the
    // legacy field. Unresolvable cur values fall through so a deleted-then-
    // PATCHed slot can clear.
    const merged = { ...patchMap };
    for (const [variant, filename] of Object.entries(prevMap)) {
      if (filename && resolveExists(filename)) merged[variant] = filename;
    }
    out.referenceSheets = merged;
  }

  return out;
}

/**
 * Walk a character list and null out any reference-sheet pointer whose
 * underlying file no longer exists in PATHS.imageRefs. Returns a NEW list
 * (cheap shallow copy per character) so callers can persist the cleaned
 * state. Pure with respect to the sanitizer — no FS I/O during sanitize,
 * just here at the "GET universe / verify before render" boundary.
 *
 * CONVENTION: call from BOTH the GET universe route AND `updateUniverse`'s
 * write path. GET alone is not sufficient — without the write-time call,
 * stale values stay on disk and a later PATCH that omits `characters`
 * (e.g. rename) resurfaces the stale filename in the response.
 *
 * Memoizes `resolveImageRef` per call so a 50-character × 5-variant cast
 * doesn't fan out into 250 redundant sync `statSync`s — every distinct
 * filename costs one stat, not one stat per slot it appears in.
 */
export function pruneStaleReferenceSheets(characters) {
  if (!Array.isArray(characters)) return characters;
  const resolvedCache = new Map();
  const fileExists = (name) => {
    if (resolvedCache.has(name)) return resolvedCache.get(name);
    const ok = !!resolveImageRef(name, { mustExist: true });
    resolvedCache.set(name, ok);
    return ok;
  };
  let changed = false;
  const out = characters.map((c) => {
    if (!c) return c;
    let next = c;
    for (const { variant, filename } of listSheetPointers(c)) {
      if (fileExists(filename)) continue;
      next = applySheetPointerToCharacter(next, variant, null);
      changed = true;
    }
    return next;
  });
  return changed ? out : characters;
}
