/**
 * Backfill the sheet-music `score` field on the built-in "500 Miles" song for
 * installs that seeded it before the Sheet music feature existed.
 *
 * Background:
 *   `server/services/songs.js#SEED_SONGS` now ships a `score` (the verse melody
 *   in the PortOS lead-sheet DSL), but that only reaches installs on their FIRST
 *   read of songs (when the file is seeded). An install that already persisted
 *   `data/songs.json` keeps its old `seed-500-miles` record, which has no score.
 *   This migration adds the shipped score to that record IF it has none — a
 *   user who already wrote their own score is never clobbered. The user can also
 *   pull the latest bundled content any time via the song's "Refresh from
 *   template" button (refreshSongFromTemplate), which carries the score too.
 *
 *   Fresh installs need nothing here: SEED_SONGS already includes the score, so
 *   a missing file is a clean no-op. Re-runs detect the score is present and skip.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';

const SONG_ID = 'seed-500-miles';

// The shipped verse melody — kept identical to SEED_SONGS[seed-500-miles].score
// in server/services/songs.js (the migration test asserts they match, so a drift
// fails CI rather than silently shipping two different scores).
export const SCORE_500_MILES = [
  'clef: treble',
  'key: C',
  'time: 4/4',
  'tempo: 68',
  '',
  '| [C] E4q(If) G4q(you) G4q(miss) G4q(the) | [Am] A4h(train) G4q(I\'m) E4q(on) |',
  '| [F] F4q(You) A4q(will) A4q(know) A4q(that) | [C] G4h(I) E4q(am) C4q(gone) |',
  '| [F] F4q(You) A4q(can) A4q(hear) A4q(the) | [C] G4q(whis-) E4q(tle) C4h(blow) |',
  '| [G] D4q(A) F4q(hun-) G4q(dred) rq | [C] C4w(miles) |',
].join('\n');

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'songs.json');
    if (!(await fileExists(path))) {
      console.log('📦 migration 073: no data/songs.json — fresh install seeds the score directly.');
      return { updated: 0, reason: 'no-file' };
    }

    const raw = await readFile(path, 'utf-8');
    let doc;
    try { doc = JSON.parse(raw); } catch (err) {
      console.warn(`⚠️ migration 073: data/songs.json is unparseable (${err.message}); skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.songs)) {
      return { updated: 0, reason: 'unexpected-shape' };
    }

    const song = doc.songs.find((s) => s && s.id === SONG_ID);
    if (!song) {
      console.log('📦 migration 073: built-in 500 Miles not present; nothing to backfill.');
      return { updated: 0, reason: 'song-absent' };
    }
    if (typeof song.score === 'string' && song.score.trim()) {
      console.log('📦 migration 073: 500 Miles already has a score; leaving it untouched.');
      return { updated: 0, reason: 'already-applied' };
    }

    song.score = SCORE_500_MILES;
    song.updatedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
    console.log('📦 migration 073: seeded sheet-music score onto built-in 500 Miles.');
    return { updated: 1 };
  },
};
