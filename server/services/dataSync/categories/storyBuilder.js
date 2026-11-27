/** Projects and merges the Story Builder sessions the user opted in to federate. */

import { listSyncableSessionsForWire, mergeStorySessionsFromSync } from '../../storyBuilder.js';
import { computeChecksum } from '../snapshotHelpers.js';

// Optional cross-machine resumable Story Builder sessions (#730). Sessions are
// LOCAL-ONLY by default and excluded from sync; only a session with
// `sync: true` participates. `listSyncableSessionsForWire` enforces that
// (returning ONLY sync-enabled sessions, wire-sanitized + sorted by id), so a
// local-only session can NEVER appear in the snapshot or its checksum — two
// peers that disagree only on local-only sessions still compute the same
// checksum and never churn. The merge is union-by-id, LWW on `updatedAt`, and
// refuses to flip a local session's sync mode (see mergeStorySessionsFromSync).
//
// No exclude-set / `{forPeerId}` scoping: sessions have no per-record push
// subscription (they ride the snapshot only), so there's nothing to exclude.

export async function getStoryBuilderSnapshot() {
  const sessions = await listSyncableSessionsForWire();
  const data = { sessions };
  return { data, checksum: computeChecksum(data) };
}

export async function applyStoryBuilderRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };
  const incoming = Array.isArray(remoteData.sessions) ? remoteData.sessions : [];
  if (incoming.length === 0) return { applied: false, count: 0 };
  return mergeStorySessionsFromSync(incoming);
}
