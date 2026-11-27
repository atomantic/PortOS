/** Projects the character compatibility snapshot and delegates merges to its writer. */

import * as characterService from '../../character.js';
import { computeChecksum } from '../snapshotHelpers.js';

export async function getCharacterSnapshot() {
  // Use the wire projection (persisted record + a backward-compatible `level`) so pre-#2673
  // peers still get a usable integer level even though `level` is no longer persisted (#2673).
  const data = await characterService.getWireCharacter();
  if (!data) return { data: null, checksum: 'empty' };
  return { data, checksum: computeChecksum(data) };
}

// Merge + persist live in the Character service so they share its mutation queue with local
// edits (#9817); reading local state here and writing it back would race them.
export async function applyCharacterRemote(remoteData) {
  return characterService.applyRemoteSnapshot(remoteData);
}
