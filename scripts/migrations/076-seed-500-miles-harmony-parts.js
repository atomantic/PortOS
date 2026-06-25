/**
 * Backfill the worked-example harmony stack (Bass, Mid Harmony I/II, High Harmony
 * I/II) onto the built-in "500 Miles" for installs that already have the song but
 * no sheet-music parts.
 *
 * Background:
 *   `server/services/rounds.js#SEED_ROUNDS` now ships "500 Miles" with a full
 *   chord-tone harmony stack (SEED_500_MILES_SCORE_PARTS) as the worked example
 *   for the AI-derive feature. Fresh installs seed it directly. An install that
 *   already persisted `data/songs.json` keeps its existing `seed-500-miles`
 *   record — which has no `scoreParts` (or its own).
 *
 *   This migration adds the shipped parts ONLY when the record has none, so a
 *   user who already derived or hand-wrote their own parts is never clobbered.
 *   The parts come from the single shipped source (no drift). The user can also
 *   pull the latest bundled content any time via "Refresh from template".
 *
 *   Fresh installs (no file) are a clean no-op. Re-runs detect parts are present
 *   and skip.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { SEED_500_MILES_SCORE_PARTS } from '../../server/services/rounds.js';

const SONG_ID = 'seed-500-miles';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'songs.json');
    if (!(await fileExists(path))) {
      console.log('📦 migration 076: no data/songs.json — fresh install seeds the harmony parts directly.');
      return { updated: 0, reason: 'no-file' };
    }

    const raw = await readFile(path, 'utf-8');
    let doc;
    try { doc = JSON.parse(raw); } catch (err) {
      console.warn(`⚠️ migration 076: data/songs.json is unparseable (${err.message}); skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.songs)) {
      return { updated: 0, reason: 'unexpected-shape' };
    }

    const song = doc.songs.find((s) => s && s.id === SONG_ID);
    if (!song) {
      console.log('📦 migration 076: built-in 500 Miles not present; nothing to backfill.');
      return { updated: 0, reason: 'song-absent' };
    }
    if (Array.isArray(song.scoreParts) && song.scoreParts.length > 0) {
      console.log('📦 migration 076: 500 Miles already has sheet-music parts; leaving them untouched.');
      return { updated: 0, reason: 'already-applied' };
    }

    // Deep-clone the shipped parts so the persisted record can't share references
    // with the in-memory seed (defensive — the seed is reused across reads).
    song.scoreParts = SEED_500_MILES_SCORE_PARTS.map((p) => ({ ...p }));
    song.updatedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
    console.log(`📦 migration 076: seeded ${song.scoreParts.length} harmony parts onto built-in 500 Miles.`);
    return { updated: 1 };
  },
};
