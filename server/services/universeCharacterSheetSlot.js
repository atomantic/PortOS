/**
 * Character reference-sheet "latest pending render" slot map.
 * `${universeId}:${characterId} → jobId` of the most recently started
 * render; supersede-aware stamping in onSheetComplete relies on slot
 * identity. Extracted from universeCharacterSheet.js so universeBuilder.js
 * can clear slots on delete without an import cycle.
 */

const _latestPendingByCharacter = new Map();

const pendingKey = (universeId, characterId) => `${universeId}:${characterId}`;

export function claimPendingSheetSlot(universeId, characterId, jobId) {
  _latestPendingByCharacter.set(pendingKey(universeId, characterId), jobId);
}

export function getPendingSheetSlot(universeId, characterId) {
  return _latestPendingByCharacter.get(pendingKey(universeId, characterId));
}

// Conditional release — only deletes when the slot still belongs to the
// caller's jobId. Used by render-completion / render-failure paths where a
// newer render may have already claimed the slot in parallel.
export function releasePendingSheetSlot(universeId, characterId, jobId) {
  const key = pendingKey(universeId, characterId);
  if (_latestPendingByCharacter.get(key) === jobId) {
    _latestPendingByCharacter.delete(key);
  }
}

// Unconditional release for a single character — used by delete paths where
// the character is going away regardless of what render is in flight. Any
// pending render's onSheetComplete will see the empty slot, treat itself as
// superseded, and skip stamping a now-orphaned pointer.
export function clearPendingSheetSlot(universeId, characterId) {
  return _latestPendingByCharacter.delete(pendingKey(universeId, characterId));
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
