/**
 * Rename the "Songs" workbench data on disk to "Rounds".
 *
 * Background:
 *   The a cappella workbench was renamed from "Songs" to "Rounds" (its real
 *   subject is musical rounds — Hey Ho Nobody Home, the quodlibet trio, the
 *   500 Miles worked example). The full-stack rename moved the service from
 *   `server/services/songs.js` → `rounds.js` (STATE_PATH `data/songs.json` →
 *   `data/rounds.json`, top-level key `songs: []` → `rounds: []`) and the per-
 *   record `partnerSongIds` field → `partnerRoundIds`, plus the route
 *   `/api/songs` → `/api/rounds`. Existing installs already have their data in
 *   `data/songs.json`; without this migration the renamed service reads a
 *   missing `data/rounds.json` and re-seeds, stranding the user's saved rounds,
 *   recordings and training progress.
 *
 * Steps (each idempotent — a re-run after partial completion is safe):
 *   1. Rename `data/songs.json` → `data/rounds.json`.
 *   2. In that file, rename the top-level `songs` key → `rounds`.
 *   3. Rename every `partnerSongIds` field → `partnerRoundIds` (text-rewrite so
 *      the user's formatting + the rest of each record is untouched).
 *
 * Edge cases:
 *   - If both `songs.json` and `rounds.json` exist (interrupted migration, hand-
 *     rename), the rename step skips with a warning; steps 2–3 still run against
 *     `rounds.json`.
 *   - Songs are NOT federated (absent from schemaVersions.js / peerSync.js) and
 *     no other data file references a song id, so there are no cross-file foreign
 *     keys to rewrite — unlike the World→Universe rename (migration 031).
 */

import { readFile, writeFile, rename, stat } from 'fs/promises';
import { join } from 'path';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

const readText = async (path) => readFile(path, 'utf-8').catch((err) => {
  if (err.code === 'ENOENT') return null;
  throw err;
});

const readJson = async (path) => {
  const raw = await readText(path);
  if (raw == null) return null;
  return JSON.parse(raw);
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

async function renameSongsFile(dataDir) {
  const oldPath = join(dataDir, 'songs.json');
  const newPath = join(dataDir, 'rounds.json');
  const [hasOld, hasNew] = await Promise.all([fileExists(oldPath), fileExists(newPath)]);
  if (hasOld && hasNew) {
    console.warn(`⚠️  migration 120: both songs.json and rounds.json exist — leaving files alone (resolve manually)`);
    return false;
  }
  if (!hasOld) return false;
  await rename(oldPath, newPath);
  console.log(`🎵→🔁 migration 120: renamed songs.json → rounds.json`);
  return true;
}

async function renameTopLevelKey(dataDir) {
  const path = join(dataDir, 'rounds.json');
  const doc = await readJson(path);
  if (!doc || typeof doc !== 'object') return false;
  if (Array.isArray(doc.rounds)) return false; // already migrated
  if (!Array.isArray(doc.songs)) return false; // nothing to do
  const { songs, ...rest } = doc;
  await writeJson(path, { rounds: songs, ...rest });
  console.log(`🔁 migration 120: renamed top-level "songs" → "rounds" (${songs.length} entries)`);
  return true;
}

// Text-rewrite a single JSON key without re-stringifying the whole file —
// preserves the user's formatting and keeps the diff minimal. Only matches the
// `"<fromKey>":` token so substrings inside string values can't collide.
async function renameJsonField(path, fromKey, toKey, label) {
  const raw = await readText(path);
  if (raw == null) return 0;
  const pattern = new RegExp(`"${fromKey}"\\s*:`, 'g');
  const count = (raw.match(pattern) || []).length;
  if (count === 0) return 0;
  const next = raw.replace(pattern, `"${toKey}":`);
  await writeFile(path, next);
  console.log(`🔄 migration 120: renamed ${count} "${fromKey}" → "${toKey}" key(s) in ${label}`);
  return count;
}

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    await renameSongsFile(dataDir);
    await renameTopLevelKey(dataDir);
    await renameJsonField(join(dataDir, 'rounds.json'), 'partnerSongIds', 'partnerRoundIds', 'rounds.json');
  },
};
