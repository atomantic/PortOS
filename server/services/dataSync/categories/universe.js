/** Projects universe snapshots with peer-specific coverage and applies them through the universe store. */

import { mergeUniversesFromSync, listUniverses } from '../../universeBuilder.js';
import { sanitizeStateForWire } from '../../../lib/syncWire.js';
import { computeChecksum, toExcludeSet } from '../snapshotHelpers.js';

export async function getUniverseSnapshot({ exclude } = {}) {
  // listUniverses() loads via the collection store — every per-record JSON
  // under `data/universes/<id>/index.json` plus the sanitizer pass. Same
  // input shape sanitizeStateForWire expects (it reads `state.universes`).
  const universes = await listUniverses({ includeDeleted: true });
  // Drop records the requesting peer already receives per-record via the
  // push pipeline (its INBOUND coverage). The filter runs on the RAW records
  // by `id` BEFORE sanitize so a subscribed-but-deleted record's tombstone is
  // also excluded here (the push pipeline carries that tombstone). Everything
  // un-subscribed — including tombstones for records whose sub was torn down
  // (ephemeralize-then-delete) — still rides the snapshot. This is the single
  // mechanism that fixes BOTH the partial-subscription gap (Item A) and the
  // stranded-tombstone stall (Item B).
  const excludeSet = toExcludeSet(exclude);
  const scoped = excludeSet.size > 0
    ? universes.filter((u) => !excludeSet.has(u?.id))
    : universes;
  const { data } = sanitizeStateForWire('universe', { universes: scoped });
  return { data, checksum: computeChecksum(data) };
}

export async function applyUniverseRemote(remoteData, source, meta = {}) {
  if (!remoteData) return { applied: false, count: 0 };
  // Routes through `mergeUniversesFromSync` so the read-modify-write runs
  // INSIDE `queueUniverseWrite` (serialized against every other writer:
  // create / update / promote-variation / handleSave) and each incoming
  // remote record passes through `sanitizeTemplate` for schema-version
  // backfill — older peers landing pre-v4 records get them migrated on the
  // way in instead of polluting disk with un-backfilled state.
  // `senderSchemaVersions` gates the moodBoardId omitted-vs-cleared
  // disambiguation (#4188) — see mergeUniversesFromSync.
  const result = await mergeUniversesFromSync(remoteData.universes || [], {
    source,
    senderSchemaVersions: meta.senderSchemaVersions || null,
  });
  if (result.applied) {
    console.log(`🔄 Universe sync: merged ${result.count} universe(s)`);
  }
  return result;
}
