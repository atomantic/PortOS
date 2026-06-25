/**
 * Backfill the four built-in traditional rounds — Hey Ho Nobody Home, Ah Poor
 * Bird, Rose Rose Rose Red, and Zum Gali Gali — for installs that seeded
 * data/songs.json before these rounds shipped.
 *
 * Background:
 *   server/services/rounds.js#SEED_ROUNDS now ships four rounds in addition to
 *   "500 Miles". New seeds only reach an install on its FIRST read of songs (when
 *   the file is seeded). An install that already persisted data/songs.json keeps
 *   its old records and never sees the new seeds — this migration prepends any of
 *   the four that are absent (matched by id), once.
 *
 *   Fresh installs need nothing here: SEED_ROUNDS already includes the rounds, so
 *   a missing file is a clean no-op. Re-runs detect the rounds present and skip.
 *   A record the user already owns under one of these ids is never clobbered — we
 *   only add a round when its id is missing.
 *
 *   The records come straight from SEED_ROUNDS (filtered by id and run through the
 *   service's own sanitizer) rather than a hand-copied duplicate, so this
 *   migration can never drift from the shipped seed.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { SEED_ROUNDS, sanitizeRound } from '../../server/services/rounds.js';

export const ROUND_IDS = [
  'seed-hey-ho-nobody-home',
  'seed-ah-poor-bird',
  'seed-rose-rose-rose-red',
  'seed-zum-gali-gali',
];

// The shipped round records in canonical on-disk shape — exactly what a fresh
// seed write produces (listRounds persists SEED_ROUNDS.map(sanitizeRound)).
export const ROUND_SEEDS = ROUND_IDS
  .map((id) => SEED_ROUNDS.find((s) => s.id === id))
  .map(sanitizeRound);

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'songs.json');
    if (!(await fileExists(path))) {
      console.log('📦 migration 074: no data/songs.json — fresh install seeds the rounds directly.');
      return { updated: 0, reason: 'no-file' };
    }

    const raw = await readFile(path, 'utf-8');
    let doc;
    try { doc = JSON.parse(raw); } catch (err) {
      console.warn(`⚠️ migration 074: data/songs.json is unparseable (${err.message}); skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.songs)) {
      return { updated: 0, reason: 'unexpected-shape' };
    }

    const present = new Set(doc.songs.map((s) => s && s.id));
    const missing = ROUND_SEEDS.filter((round) => !present.has(round.id));
    if (missing.length === 0) {
      console.log('📦 migration 074: all four rounds already present; nothing to add.');
      return { updated: 0, reason: 'already-present' };
    }

    // Prepend so the new built-ins surface at the top of the user's list.
    doc.songs = [...missing, ...doc.songs];
    await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
    console.log(`📦 migration 074: added ${missing.length} built-in round(s): ${missing.map((s) => s.title).join(', ')}.`);
    return { updated: missing.length };
  },
};
