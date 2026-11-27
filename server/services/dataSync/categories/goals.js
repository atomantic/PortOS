/** Projects and applies the federated goals snapshot, including metadata and tombstones. */

import { join } from 'path';
import { isDeepStrictEqual } from 'util';
import { readJSONFile, PATHS } from '../../../lib/fileUtils.js';
import { canonicalStringify } from '../../../lib/objects.js';
import { parseTsMs } from '../../../lib/lwwTimestamp.js';
import { mergeTombstones } from '../../../lib/tombstones.js';
import { GOAL_TOMBSTONES_KEY, reconcileGoalTombstones } from '../../identity/goalTombstones.js';
import { editGoals } from '../../identity/store.js';
import { mergeArraysByKey } from '../mergeByKey.js';
import { computeChecksum } from '../snapshotHelpers.js';

export const GOALS_FILE = join(PATHS.digitalTwin, 'goals.json');

export async function getGoalsSnapshot() {
  const data = await readJSONFile(GOALS_FILE, { goals: [] }, { strict: true });
  return { data, checksum: computeChecksum(data) };
}

const GOALS_METADATA_FIELDS = ['birthDate', 'lifeExpectancy', 'timeHorizons'];

/**
 * Freshness of a goals document for the metadata LWW. The document's own
 * `updatedAt` is the clock — `setBirthDate` and every goal write stamp it — so a
 * birth-date edit that never touches a child goal still orders correctly. The
 * newest goal `updatedAt` stands in only for a legacy document with no usable
 * document clock. `null` = no usable clock at all (never wins).
 */
function goalsDocumentClockMs(doc) {
  const docMs = parseTsMs(doc?.updatedAt);
  if (docMs !== null) return docMs;
  let newest = null;
  for (const goal of Array.isArray(doc?.goals) ? doc.goals : []) {
    const ms = parseTsMs(goal?.updatedAt);
    if (ms !== null && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

// Goals merge by union, so a delete is only representable as a tombstone (#9816):
// `deleteGoal` leaves `{ id, deletedAt }` in the goals document, the list unions in
// both directions (a legacy peer that omits it leaves ours untouched), and any
// goal copy the union covers is dropped here, children reparented. See
// identity/goalTombstones.js for the restoration rule and resurrection horizon.
export async function applyGoalsRemote(remoteData) {
  return editGoals(local => {
    const localGoals = local.goals || [];
    const { merged: tombstones } = mergeTombstones(
      local[GOAL_TOMBSTONES_KEY],
      remoteData[GOAL_TOMBSTONES_KEY],
      { keyField: 'id' },
    );
    // A tombstoned remote copy is filtered BEFORE the union so it neither counts
    // as a change nor as proof the remote document is fresher.
    const remoteGoals = reconcileGoalTombstones(remoteData.goals || [], tombstones).goals;
    // Merge goals array by ID with LWW on updatedAt
    const { merged: unionGoals } = mergeArraysByKey(localGoals, remoteGoals, 'id', 'updatedAt');
    const { goals: mergedGoals, tombstones: liveTombstones } = reconcileGoalTombstones(unionGoals, tombstones);
    const goalsChanged = canonicalStringify(mergedGoals) !== canonicalStringify(localGoals);
    const tombstonesChanged = canonicalStringify(liveTombstones) !== canonicalStringify(local[GOAL_TOMBSTONES_KEY] ?? []);

    // Top-level metadata (birthDate, lifeExpectancy, timeHorizons) is LWW on the document
    // clock, independent of the goal-array merge: a metadata-only edit changes no goal.
    // A tie keeps local, so a replay of the same snapshot is a no-op. The legacy child-clock
    // fallback reads the tombstone-filtered remote goals, so a deleted copy is no proof of
    // a fresher document.
    const remoteClock = goalsDocumentClockMs({ ...remoteData, goals: remoteGoals });
    const localClock = goalsDocumentClockMs(local);
    const remoteWins = remoteClock !== null && (localClock === null || remoteClock > localClock);

    const winning = {};
    if (remoteWins) {
      for (const field of GOALS_METADATA_FIELDS) winning[field] = Object.hasOwn(remoteData, field) && remoteData[field] !== undefined ? remoteData[field] : local[field];
      // Carry the winning clock itself — restamping on receipt would out-date the peer's
      // next edit, and leaving ours would let the same snapshot win again.
      if (parseTsMs(remoteData.updatedAt) !== null) winning.updatedAt = remoteData.updatedAt;
    }
    const metaChanged = Object.entries(winning).some(([field, value]) => !isDeepStrictEqual(value, local[field]));

    if (goalsChanged || tombstonesChanged || metaChanged) {
      Object.assign(local, winning, { goals: mergedGoals });
      // A legacy document stays free of the field until something is tombstoned.
      if (liveTombstones.length > 0) local[GOAL_TOMBSTONES_KEY] = liveTombstones;
      else delete local[GOAL_TOMBSTONES_KEY];
      console.log(`🔄 Goals sync: merged ${mergedGoals.length} goals`);
      return { applied: true, count: mergedGoals.length };
    }
    return { applied: false, count: 0 };
  }, { localOnly: true });
}
