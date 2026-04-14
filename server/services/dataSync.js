/**
 * Data Sync Service
 *
 * Snapshot-based sync for JSON file data between PortOS peer instances.
 * Supports per-category sync with entity-level merge and LWW conflict resolution.
 * No data is ever lost — unique records from both sides are kept (union semantics).
 */

import crypto from 'crypto';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';

// --- Category Definitions ---

const GOALS_FILE = join(PATHS.digitalTwin, 'goals.json');
const CHARACTER_FILE = join(PATHS.data, 'character.json');
const IDENTITY_FILE = join(PATHS.digitalTwin, 'identity.json');
const CHRONOTYPE_FILE = join(PATHS.digitalTwin, 'chronotype.json');
const LONGEVITY_FILE = join(PATHS.digitalTwin, 'longevity.json');
const FEEDBACK_FILE = join(PATHS.digitalTwin, 'feedback.json');
const MEATSPACE_DIR = PATHS.meatspace;

const MEATSPACE_FILES = {
  'daily-log.json': { arrayKey: 'entries', idField: 'date' },
  'blood-tests.json': { arrayKey: 'tests', idField: 'date' },
  'epigenetic-tests.json': { arrayKey: 'tests', idField: 'date' },
  'eyes.json': { arrayKey: 'exams', idField: 'date' },
  'config.json': { type: 'object-lww' }
};

// --- Checksum Helper ---

function computeChecksum(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

// --- Merge Helpers ---

/**
 * Merge two arrays of records by a key field. LWW by timestampField when both
 * sides have the same record. Records unique to either side are kept (union).
 */
function mergeArraysByKey(localArr, remoteArr, idField, timestampField) {
  const localMap = new Map();
  for (const item of localArr) {
    localMap.set(item[idField], item);
  }

  let changed = false;
  for (const remoteItem of remoteArr) {
    const key = remoteItem[idField];
    const localItem = localMap.get(key);

    if (!localItem) {
      // New record from remote — add it
      localMap.set(key, remoteItem);
      changed = true;
    } else if (timestampField) {
      // Both have it — LWW
      const localTs = localItem[timestampField] || '';
      const remoteTs = remoteItem[timestampField] || '';
      if (remoteTs > localTs) {
        localMap.set(key, remoteItem);
        changed = true;
      }
    }
  }

  return { merged: Array.from(localMap.values()), changed };
}

/**
 * LWW merge for single objects. Remote wins if its updatedAt is newer.
 */
function mergeObjectLWW(local, remote, timestampField = 'updatedAt') {
  if (!local) return { merged: remote, changed: true };
  if (!remote) return { merged: local, changed: false };
  const localTs = local[timestampField] || '';
  const remoteTs = remote[timestampField] || '';
  if (remoteTs > localTs) {
    return { merged: remote, changed: true };
  }
  return { merged: local, changed: false };
}

/**
 * Deep merge for derived files (longevity, chronotype) where timestamps
 * are unreliable (regenerated on derivation). Merges nested marker objects
 * as unions, keeps non-default scalar values, and uses LWW as final tiebreaker.
 */
function mergeDeepUnion(local, remote, timestampField = 'derivedAt') {
  if (!local) return { merged: remote, changed: true };
  if (!remote) return { merged: local, changed: false };

  const merged = { ...local };
  let changed = false;

  for (const [key, remoteVal] of Object.entries(remote)) {
    const localVal = local[key];

    // Skip timestamp fields — set after merge
    if (key === timestampField) continue;

    // Nested objects (markers): union keys, local wins per-key conflicts
    if (remoteVal && typeof remoteVal === 'object' && !Array.isArray(remoteVal)
        && localVal && typeof localVal === 'object' && !Array.isArray(localVal)) {
      const mergedObj = { ...localVal };
      for (const [k, v] of Object.entries(remoteVal)) {
        if (!(k in mergedObj)) {
          mergedObj[k] = v;
          changed = true;
        }
      }
      merged[key] = mergedObj;
      continue;
    }

    // Missing locally — take remote
    if (localVal === undefined || localVal === null) {
      merged[key] = remoteVal;
      changed = true;
      continue;
    }

    // Remote has non-default value, local has default — take remote
    if (localVal === 0 && remoteVal !== 0) {
      merged[key] = remoteVal;
      changed = true;
    }
  }

  // Use the newer timestamp
  const localTs = local[timestampField] || '';
  const remoteTs = remote[timestampField] || '';
  merged[timestampField] = remoteTs > localTs ? remoteTs : localTs;

  return { merged, changed };
}

// --- Category: Goals ---

async function getGoalsSnapshot() {
  const data = await readJSONFile(GOALS_FILE, { goals: [] });
  return { data, checksum: computeChecksum(data) };
}

async function applyGoalsRemote(remoteData) {
  const local = await readJSONFile(GOALS_FILE, { goals: [] });

  // Merge goals array by ID with LWW on updatedAt
  const { merged: mergedGoals, changed: goalsChanged } = mergeArraysByKey(
    local.goals || [],
    remoteData.goals || [],
    'id',
    'updatedAt'
  );

  // Merge top-level metadata (birthDate, lifeExpectancy, timeHorizons) via LWW
  // Use the most recent goal's updatedAt as proxy for file freshness
  const localMaxTs = (local.goals || []).reduce((max, g) => Math.max(max, new Date(g.updatedAt || 0).getTime()), 0);
  const remoteMaxTs = (remoteData.goals || []).reduce((max, g) => Math.max(max, new Date(g.updatedAt || 0).getTime()), 0);
  const metaSource = remoteMaxTs > localMaxTs ? remoteData : local;

  const merged = {
    ...local,
    birthDate: metaSource.birthDate ?? local.birthDate,
    lifeExpectancy: metaSource.lifeExpectancy ?? local.lifeExpectancy,
    timeHorizons: metaSource.timeHorizons ?? local.timeHorizons,
    goals: mergedGoals
  };

  if (goalsChanged || remoteMaxTs > localMaxTs) {
    await ensureDir(PATHS.digitalTwin);
    await writeFile(GOALS_FILE, JSON.stringify(merged, null, 2));
    console.log(`🔄 Goals sync: merged ${mergedGoals.length} goals`);
    return { applied: true, count: mergedGoals.length };
  }
  return { applied: false, count: 0 };
}

// --- Category: Character ---

async function getCharacterSnapshot() {
  const data = await readJSONFile(CHARACTER_FILE, null);
  if (!data) return { data: null, checksum: 'empty' };
  return { data, checksum: computeChecksum(data) };
}

async function applyCharacterRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };

  const local = await readJSONFile(CHARACTER_FILE, null);
  if (!local) {
    // No local character — accept remote entirely
    await ensureDir(PATHS.data);
    await writeFile(CHARACTER_FILE, JSON.stringify(remoteData, null, 2));
    console.log(`🔄 Character sync: accepted remote character`);
    return { applied: true, count: 1 };
  }

  // Merge events by ID (union — never lose events)
  const { merged: mergedEvents, changed: eventsChanged } = mergeArraysByKey(
    local.events || [],
    remoteData.events || [],
    'id',
    'timestamp'
  );

  // Sort events chronologically
  mergedEvents.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  // Merge synced ticket/task arrays (union by value)
  const mergedTickets = [...new Set([...(local.syncedJiraTickets || []), ...(remoteData.syncedJiraTickets || [])])];
  const mergedTasks = [...new Set([...(local.syncedTaskIds || []), ...(remoteData.syncedTaskIds || [])])];

  // Scalar fields: take from whichever is more recent
  const localTs = local.updatedAt || '';
  const remoteTs = remoteData.updatedAt || '';
  const scalarSource = remoteTs > localTs ? remoteData : local;

  const merged = {
    ...local,
    name: scalarSource.name ?? local.name,
    class: scalarSource.class ?? local.class,
    avatarPath: scalarSource.avatarPath ?? local.avatarPath,
    xp: Math.max(local.xp || 0, remoteData.xp || 0),
    hp: scalarSource.hp,
    maxHp: scalarSource.maxHp,
    level: Math.max(local.level || 1, remoteData.level || 1),
    events: mergedEvents,
    syncedJiraTickets: mergedTickets,
    syncedTaskIds: mergedTasks,
    updatedAt: remoteTs > localTs ? remoteTs : localTs
  };

  if (eventsChanged || remoteTs > localTs) {
    await ensureDir(PATHS.data);
    await writeFile(CHARACTER_FILE, JSON.stringify(merged, null, 2));
    console.log(`🔄 Character sync: merged ${mergedEvents.length} events`);
    return { applied: true, count: mergedEvents.length };
  }
  return { applied: false, count: 0 };
}

// --- Category: Digital Twin ---

const DIGITAL_TWIN_FILES = {
  identity: { path: IDENTITY_FILE, timestampField: 'updatedAt', merge: 'lww' },
  chronotype: { path: CHRONOTYPE_FILE, timestampField: 'derivedAt', merge: 'deepUnion' },
  longevity: { path: LONGEVITY_FILE, timestampField: 'derivedAt', merge: 'deepUnion' },
  feedback: { path: FEEDBACK_FILE, timestampField: 'updatedAt', merge: 'lww' }
};

async function getDigitalTwinSnapshot() {
  const result = {};
  for (const [key, { path }] of Object.entries(DIGITAL_TWIN_FILES)) {
    result[key] = await readJSONFile(path, null);
  }
  return { data: result, checksum: computeChecksum(result) };
}

async function applyDigitalTwinRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };
  await ensureDir(PATHS.digitalTwin);

  let totalApplied = 0;
  for (const [key, { path, timestampField, merge }] of Object.entries(DIGITAL_TWIN_FILES)) {
    const remoteFile = remoteData[key];
    if (!remoteFile) continue;

    const local = await readJSONFile(path, null);
    const mergeFn = merge === 'deepUnion' ? mergeDeepUnion : mergeObjectLWW;
    const { merged, changed } = mergeFn(local, remoteFile, timestampField);
    if (changed) {
      await writeFile(path, JSON.stringify(merged, null, 2));
      totalApplied++;
    }
  }

  if (totalApplied > 0) {
    console.log(`🔄 Digital twin sync: updated ${totalApplied} files`);
  }
  return { applied: totalApplied > 0, count: totalApplied };
}

// --- Category: Meatspace ---

async function getMeatspaceSnapshot() {
  const result = {};
  for (const [filename] of Object.entries(MEATSPACE_FILES)) {
    const filePath = join(MEATSPACE_DIR, filename);
    result[filename] = await readJSONFile(filePath, null);
  }
  return { data: result, checksum: computeChecksum(result) };
}

async function applyMeatspaceRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };
  await ensureDir(MEATSPACE_DIR);

  let totalApplied = 0;
  for (const [filename, config] of Object.entries(MEATSPACE_FILES)) {
    const remoteFile = remoteData[filename];
    if (!remoteFile) continue;

    const filePath = join(MEATSPACE_DIR, filename);
    const local = await readJSONFile(filePath, null);

    if (config.type === 'object-lww') {
      const { merged, changed } = mergeObjectLWW(local, remoteFile, 'updatedAt');
      if (changed) {
        await writeFile(filePath, JSON.stringify(merged, null, 2));
        totalApplied++;
      }
    } else {
      // Array merge
      const localArr = local?.[config.arrayKey] || [];
      const remoteArr = remoteFile[config.arrayKey] || [];
      const { merged, changed } = mergeArraysByKey(localArr, remoteArr, config.idField, null);

      if (changed) {
        // Sort by idField (usually date)
        merged.sort((a, b) => (a[config.idField] || '').localeCompare(b[config.idField] || ''));
        const mergedFile = { ...(local || {}), [config.arrayKey]: merged };
        await writeFile(filePath, JSON.stringify(mergedFile, null, 2));
        totalApplied++;
      }
    }
  }

  if (totalApplied > 0) {
    console.log(`🔄 Meatspace sync: updated ${totalApplied} files`);
  }
  return { applied: totalApplied > 0, count: totalApplied };
}

// --- Public API ---

const CATEGORIES = {
  goals: { getSnapshot: getGoalsSnapshot, applyRemote: applyGoalsRemote },
  character: { getSnapshot: getCharacterSnapshot, applyRemote: applyCharacterRemote },
  digitalTwin: { getSnapshot: getDigitalTwinSnapshot, applyRemote: applyDigitalTwinRemote },
  meatspace: { getSnapshot: getMeatspaceSnapshot, applyRemote: applyMeatspaceRemote }
};

export function getSupportedCategories() {
  return Object.keys(CATEGORIES);
}

export async function getChecksum(category) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  const snapshot = await cat.getSnapshot();
  return { checksum: snapshot.checksum };
}

export async function getSnapshot(category) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  return cat.getSnapshot();
}

export async function applyRemote(category, remoteData) {
  const cat = CATEGORIES[category];
  if (!cat) return { applied: false, count: 0 };
  return cat.applyRemote(remoteData);
}
