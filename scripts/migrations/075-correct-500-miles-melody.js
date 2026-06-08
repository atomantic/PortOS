/**
 * Correct the built-in "500 Miles" sheet-music melody to the proper G-major
 * transcription (Hedy West lead sheet) for installs that hold the earlier,
 * incorrect C-major backfill.
 *
 * Background:
 *   The first sheet-music score shipped for "500 Miles" was a placeholder in
 *   C major with the wrong notes (migration 073 backfilled it onto pre-feature
 *   installs). The seed has since been corrected to the real melody in G major.
 *   A fresh install seeds the correct score directly; migration 073 now backfills
 *   the correct score onto installs that never had one. But an install that
 *   already persisted the OLD C-major score keeps it — neither path touches it.
 *
 *   This migration upgrades that record: if `seed-500-miles.score` still matches
 *   the OLD shipped C-major score (line-ending–normalized), replace it with the
 *   corrected G-major score and update the key to "G major". A user who edited
 *   their score is never clobbered — only the exact old shipped version is
 *   upgraded. The user can also pull the latest bundled content any time via the
 *   song's "Refresh from template" button.
 *
 *   Fresh installs (no file) are a clean no-op. Re-runs detect the corrected
 *   score is already present (no longer matches OLD) and skip.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { SCORE_500_MILES as NEW_SCORE } from './073-seed-500-miles-score.js';

const SONG_ID = 'seed-500-miles';

// The OLD shipped score — the C-major placeholder migration 073 originally
// backfilled. Kept here (not imported) precisely because 073's constant has been
// updated to the corrected G-major score; this is the fingerprint of the version
// we upgrade FROM.
const OLD_SCORE = [
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

// Normalize line endings before comparing so a Windows checkout (CRLF) still
// matches the LF-joined shipped string.
const norm = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'songs.json');
    if (!(await fileExists(path))) {
      console.log('📦 migration 075: no data/songs.json — fresh install seeds the correct melody directly.');
      return { updated: 0, reason: 'no-file' };
    }

    const raw = await readFile(path, 'utf-8');
    let doc;
    try { doc = JSON.parse(raw); } catch (err) {
      console.warn(`⚠️ migration 075: data/songs.json is unparseable (${err.message}); skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.songs)) {
      return { updated: 0, reason: 'unexpected-shape' };
    }

    const song = doc.songs.find((s) => s && s.id === SONG_ID);
    if (!song) {
      console.log('📦 migration 075: built-in 500 Miles not present; nothing to correct.');
      return { updated: 0, reason: 'song-absent' };
    }
    if (norm(song.score) !== norm(OLD_SCORE)) {
      console.log('📦 migration 075: 500 Miles score is not the old C-major placeholder (corrected or customized); leaving it untouched.');
      return { updated: 0, reason: 'not-old-score' };
    }

    song.score = NEW_SCORE;
    // Bring the key field in line with the corrected score's key signature.
    song.key = 'G major';
    song.updatedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
    console.log('📦 migration 075: corrected built-in 500 Miles melody to G major.');
    return { updated: 1 };
  },
};
