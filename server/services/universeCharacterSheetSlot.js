/**
 * Character reference-sheet "latest pending render" slot map.
 * `${universeId}:${characterId}:${variant} → jobId` of the most recently
 * started render. The variant key isolates parallel renders on the same
 * character so a standard-style render and a blueprint-style render can't
 * supersede each other. Extracted from universeCharacterSheet.js so
 * universeBuilder.js can clear slots on delete without an import cycle.
 */

import { LEGACY_SHEET_VARIANT_ID } from '../lib/storyBible.js';

const _latestPendingByCharacter = new Map();

const pendingKey = (universeId, characterId, variant) =>
  `${universeId}:${characterId}:${variant || LEGACY_SHEET_VARIANT_ID}`;

export function claimPendingSheetSlot(universeId, characterId, jobId, variant = LEGACY_SHEET_VARIANT_ID) {
  _latestPendingByCharacter.set(pendingKey(universeId, characterId, variant), jobId);
}

export function getPendingSheetSlot(universeId, characterId, variant = LEGACY_SHEET_VARIANT_ID) {
  return _latestPendingByCharacter.get(pendingKey(universeId, characterId, variant));
}

// Conditional release — only deletes when the slot still belongs to the
// caller's jobId. Used by render-completion / render-failure paths where a
// newer render may have already claimed the slot in parallel.
export function releasePendingSheetSlot(universeId, characterId, jobId, variant = LEGACY_SHEET_VARIANT_ID) {
  const key = pendingKey(universeId, characterId, variant);
  if (_latestPendingByCharacter.get(key) === jobId) {
    _latestPendingByCharacter.delete(key);
  }
}

// Unconditional release for a single character — used by delete paths where
// the character is going away regardless of what render is in flight. Clears
// ALL variants in one call so a character delete doesn't leak blueprint
// slots when only the standard one was tracked, and vice versa. Any pending
// render's onSheetComplete will see the empty slot, treat itself as
// superseded, and skip stamping a now-orphaned pointer.
export function clearPendingSheetSlot(universeId, characterId) {
  if (!universeId || !characterId) return false;
  const prefix = `${universeId}:${characterId}:`;
  let cleared = false;
  for (const key of _latestPendingByCharacter.keys()) {
    if (key.startsWith(prefix)) {
      _latestPendingByCharacter.delete(key);
      cleared = true;
    }
  }
  return cleared;
}

// Universe-wide release — used when an entire universe is deleted. Walks
// the map once and drops every key prefixed with `${universeId}:`.
export function clearPendingSheetSlotsForUniverse(universeId) {
  if (!universeId) return 0;
  const prefix = `${universeId}:`;
  let cleared = 0;
  for (const key of _latestPendingByCharacter.keys()) {
    if (key.startsWith(prefix)) {
      _latestPendingByCharacter.delete(key);
      cleared += 1;
    }
  }
  return cleared;
}

export const __testing = {
  reset: () => _latestPendingByCharacter.clear(),
  size: () => _latestPendingByCharacter.size,
};
