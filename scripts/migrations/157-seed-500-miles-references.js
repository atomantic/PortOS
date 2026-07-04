/**
 * Backfill the TikTok reference performances onto the built-in "500 Miles" for
 * installs that already have the song but no reference material.
 *
 * Background:
 *   `server/services/rounds.js#SEED_ROUNDS` ships "500 Miles" with three TikTok
 *   reference videos (SEED_500_MILES_REFERENCES) — added in 6b7b81c27 and
 *   26cd58e8b (2026-06-07). Fresh installs seed them directly. An install whose
 *   `data/rounds.json` was seeded BEFORE that date already has its own
 *   `seed-500-miles` record on disk, which predates the `references` field
 *   entirely — unlike `score` (migration 073) and `scoreParts` (migrations
 *   076/086), nothing ever backfilled `references` onto it.
 *
 *   This migration adds the shipped references ONLY when the record has none
 *   (absent or empty array), so a user who already added their own reference
 *   material is never clobbered. The references come from the single shipped
 *   source (no drift). The user can also pull the latest bundled content any
 *   time via "Refresh from template".
 *
 *   Fresh installs (no file) are a clean no-op. Re-runs detect references are
 *   present and skip.
 *
 *   NOTE: unlike migration 076 (which targeted the pre-rename `data/songs.json`
 *   / `songs` key), this migration runs after migration 120's Songs→Rounds
 *   rename, so it targets the CURRENT `data/rounds.json` / `rounds` key.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { SEED_500_MILES_REFERENCES } from '../../server/services/rounds.js';

const ROUND_ID = 'seed-500-miles';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'rounds.json');
    if (!(await fileExists(path))) {
      console.log('📦 migration 157: no data/rounds.json — fresh install seeds the references directly.');
      return { updated: 0, reason: 'no-file' };
    }

    const raw = await readFile(path, 'utf-8');
    let doc;
    try { doc = JSON.parse(raw); } catch (err) {
      console.warn(`⚠️ migration 157: data/rounds.json is unparseable (${err.message}); skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.rounds)) {
      return { updated: 0, reason: 'unexpected-shape' };
    }

    const round = doc.rounds.find((r) => r && r.id === ROUND_ID);
    if (!round) {
      console.log('📦 migration 157: built-in 500 Miles not present; nothing to backfill.');
      return { updated: 0, reason: 'round-absent' };
    }
    if (Array.isArray(round.references) && round.references.length > 0) {
      console.log('📦 migration 157: 500 Miles already has reference material; leaving it untouched.');
      return { updated: 0, reason: 'already-applied' };
    }

    // Deep-clone the shipped references so the persisted record can't share
    // references with the in-memory seed (defensive — the seed is reused across
    // reads).
    round.references = SEED_500_MILES_REFERENCES.map((r) => ({ ...r }));
    round.updatedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
    console.log(`📦 migration 157: seeded ${round.references.length} reference video(s) onto built-in 500 Miles.`);
    return { updated: 1 };
  },
};
