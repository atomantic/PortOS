/**
 * Backfill the sheet-music `score` field on the built-in "500 Miles" song for
 * installs that seeded it before the Sheet music feature existed.
 *
 * Background:
 *   `server/services/rounds.js#SEED_ROUNDS` now ships a `score` (the verse melody
 *   in the PortOS lead-sheet DSL), but that only reaches installs on their FIRST
 *   read of songs (when the file is seeded). An install that already persisted
 *   `data/songs.json` keeps its old `seed-500-miles` record, which has no score.
 *   This migration adds the shipped score to that record IF it has none — a
 *   user who already wrote their own score is never clobbered. The user can also
 *   pull the latest bundled content any time via the song's "Refresh from
 *   template" button (refreshRoundFromTemplate), which carries the score too.
 *
 *   Fresh installs need nothing here: SEED_ROUNDS already includes the score, so
 *   a missing file is a clean no-op. Re-runs detect the score is present and skip.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';

const SONG_ID = 'seed-500-miles';

// The shipped melody — kept identical to SEED_ROUNDS[seed-500-miles].score in
// server/services/rounds.js (the migration test asserts they match, so a drift
// fails CI rather than silently shipping two different scores). Now the full
// song (all verses + closing coda) in G major; migration 075 upgrades installs
// that still hold the earlier C-major backfill.
export const SCORE_500_MILES = [
  'clef: treble',
  'key: G',
  'time: 4/4',
  'tempo: 68',
  '',
  '| rh [G] D4q(If) D4q(you) |',
  '| [G] B4q.(miss) A4e(the) B4q.(train) A4e(I\'m) |',
  '| [Em] B4h(on) A4q(you) G4q(will) |',
  '| [C] C5q.(know) B4e(that) A4q(I) G4q(am) |',
  '| [Am7] E4h.(gone) F#4e(you) G4e(can) |',
  '| [D7] A4q.(hear) F#4e(the) A4q.(whis-) F#4e(tle) |',
  '| [G] G4h(blow) A4e(a) B4e(hun-) C5q(dred) |',
  '| [G] D5w(miles) |',
  '',
  '| [G] D5h(A) B4q(hun-) A4q(dred) |',
  '| [Em] B4q.(miles) A4e(a) B4q.(hun-) A4e(dred) |',
  '| [C] C5q.(miles) B4e(a) A4q(hun-) G4q(dred) |',
  '| [Am7] E4h.(miles) F#4e(you) G4e(can) |',
  '| [D7] A4q.(hear) F#4e(the) A4q.(whis-) F#4e(tle) |',
  '| [G] G4h(blow) A4e(a) B4e(hun-) C5q(dred) |',
  '| [G] D5w(miles) |',
  '',
  '| [G] D5h(Lord,) B4q(I\'m) A4q(one,) |',
  '| [Em] B4h(Lord,) A4q(I\'m) G4q(two,) |',
  '| [C] C5q.(Lord,) B4e(I\'m) A4q(three,) G4q(Lord,) |',
  '| [Am7] E4h.(I\'m) F#4e(four,) G4e(Lord,) |',
  '| [D7] A4q.(I\'m) F#4e(five) A4q.(hun-) F#4e(dred) |',
  '| [G] G4h(miles) A4e(a-) B4e(way) C5q(from) |',
  '| [G] D5w(home) |',
  '',
  '| [G] D5h(A-) B4q(way) A4q(from) |',
  '| [Em] B4h(home,) A4q(a-) G4q(way) |',
  '| [C] C5q.(from) B4e(home,) A4q(a-) G4q(way) |',
  '| [Am7] E4h.(from) F#4e(home,) G4e(Lord,) |',
  '| [D7] A4q.(I\'m) F#4e(five) A4q.(hun-) F#4e(dred) |',
  '| [G] G4h(miles) A4e(a-) B4e(way) C5q(from) |',
  '| [G] D5w(home) |',
  '',
  '| [G] D5h(Not) B4q(a) A4q(shirt) |',
  '| [Em] B4h(on) A4q(my) G4q(back,) |',
  '| [C] C5q.(not) B4e(a) A4q(pen-) G4q(ny) |',
  '| [Am7] E4h.(to) F#4e(my) G4e(name,) |',
  '| [D7] A4q.(Lord,) F#4e(I) A4q.(can\'t) F#4e(go) |',
  '| [G] G4h(back) A4e(home) B4e(this-) C5q(a-) |',
  '| [G] D5w(way) |',
  '',
  '| [G] D5h(This-) B4q(a-) A4q(way,) |',
  '| [Em] B4h(this-) A4q(a-) G4q(way,) |',
  '| [C] C5q.(this-) B4e(a-) A4q(way,) G4q(Lord,) |',
  '| [Am7] E4h.(I) F#4e(can\'t) G4e(go) |',
  '| [D7] A4q.(back) F#4e(home) A4q.(this-) F#4e(a-) |',
  '| [G] G4h(way) D5h |',
  '',
  '| [G] D5h(You) B4q(can) A4q(hear) |',
  '| [C] C5q.(the) B4e(whis-) A4q(tle) G4q(blow) |',
  '| [D7] A4q(a) F#4q(hun-) A4q(dred) F#4q(miles) |',
  '| [G] G4w(miles) |',
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
