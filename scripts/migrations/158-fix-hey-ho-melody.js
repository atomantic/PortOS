/**
 * Fix the built-in "Hey Ho Nobody Home" melody for installs that seeded it with
 * the old mis-transcription (issue #2105).
 *
 * Background:
 *   The shipped `seed-hey-ho-nobody-home` score was accidentally centered on G
 *   with a major third (phrase 2 climbed to B-natural over a G tonic), which
 *   contradicted its own metadata ("D Dorian") and — because the round anchors
 *   the D-minor quodlibet with Ah Poor Bird and Rose Rose Rose Red — sounded a
 *   B-against-F tritone when the three were stacked in RoundStack. The seed now
 *   ships the correct D-centered, all-naturals melody (`HEY_HO_MELODY`), and its
 *   canon voices rebuild from it via `canonVoice()`.
 *
 *   Fresh installs seed the corrected melody directly. An install whose
 *   `data/rounds.json` already holds the old `seed-hey-ho-nobody-home` record
 *   keeps the wrong score/scoreParts on disk. This migration replaces them with
 *   the shipped versions ONLY when the stored `score` still exactly matches the
 *   old shipped string — a user who customized their score is never clobbered
 *   (they can pull the shipped version any time via "Refresh from template").
 *   The `notation` text is corrected independently, gated on its own old-string
 *   match, so a customized score with the stock notation still gets the truthful
 *   description.
 *
 *   Fresh installs (no file) are a clean no-op. Re-runs detect the corrected
 *   score/notation and skip.
 *
 *   Runs after migration 120's Songs→Rounds rename, so it targets the CURRENT
 *   `data/rounds.json` / `rounds` key.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { SEED_ROUNDS } from '../../server/services/rounds.js';

const ROUND_ID = 'seed-hey-ho-nobody-home';

// The NEW shipped content — read from the single source of truth in rounds.js
// (identity, not a copy) so this migration and the seed can never drift. The
// migration test asserts these come from SEED_ROUNDS.
const NEW_SEED = SEED_ROUNDS.find((r) => r.id === ROUND_ID);
export const NEW_HEY_HO_SCORE = NEW_SEED.score;
export const NEW_HEY_HO_SCORE_PARTS = NEW_SEED.scoreParts;
export const NEW_HEY_HO_NOTATION = NEW_SEED.notation;

// The OLD shipped melody — frozen exactly as SEED_ROUNDS shipped it BEFORE issue
// #2105 (G-centered, B-natural major third). Hard-coded on purpose: this is the
// fingerprint that tells "still the untouched shipped score" apart from a user
// customization. Do NOT regenerate it from rounds.js — that would defeat the
// point (it must NOT track the corrected melody).
export const OLD_HEY_HO_SCORE = [
  'clef: treble',
  'key: C',
  'time: 4/4',
  'tempo: 76',
  '',
  '| G4h(Hey) D4h(ho) | G4q(no-) G4e(bo-) G4e(dy) D4h(home) |',
  '| G4q(Meat) G4q(nor) A4q(drink) A4q(nor) | B4e(mon-) B4e(ey) B4e(have) B4e(I) A4h(none) |',
  '| D5q(Still) C5q(I) D5q(will) C5q(be) | B4h(mer-) A4h(ry) |',
].join('\n');

// The OLD shipped notation — frozen exactly as it read before #2105 (the false
// "B natural" + unverified Campin attribution). Gates the notation correction.
export const OLD_HEY_HO_NOTATION =
  'A round in up to six voices (Ravenscroft\'s Pammelia, 1609). New voices enter one two-bar phrase behind the last. Scored in D with no key signature — D Dorian, B natural. Melody after Jack Campin\'s D-minor round transcription.';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'rounds.json');
    if (!(await fileExists(path))) {
      console.log('📦 migration 158: no data/rounds.json — fresh install seeds the corrected melody directly.');
      return { updated: 0, reason: 'no-file' };
    }

    const raw = await readFile(path, 'utf-8');
    let doc;
    try { doc = JSON.parse(raw); } catch (err) {
      console.warn(`⚠️ migration 158: data/rounds.json is unparseable (${err.message}); skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.rounds)) {
      return { updated: 0, reason: 'unexpected-shape' };
    }

    const round = doc.rounds.find((r) => r && r.id === ROUND_ID);
    if (!round) {
      console.log('📦 migration 158: built-in Hey Ho Nobody Home not present; nothing to fix.');
      return { updated: 0, reason: 'round-absent' };
    }

    let fixedScore = false;
    let fixedNotation = false;

    // Replace score + scoreParts only when the stored score is still the exact
    // old shipped string. Deep-clone the scoreParts so the persisted record can't
    // share array/object identity with the in-memory seed.
    if (round.score === OLD_HEY_HO_SCORE) {
      round.score = NEW_HEY_HO_SCORE;
      round.scoreParts = NEW_HEY_HO_SCORE_PARTS.map((p) => ({ ...p }));
      fixedScore = true;
    }

    // Correct the notation independently — a customized score with the stock
    // notation still deserves the truthful text.
    if (round.notation === OLD_HEY_HO_NOTATION) {
      round.notation = NEW_HEY_HO_NOTATION;
      fixedNotation = true;
    }

    if (!fixedScore && !fixedNotation) {
      console.log('📦 migration 158: Hey Ho score/notation already corrected or customized; leaving it untouched.');
      return { updated: 0, reason: 'already-applied' };
    }

    round.updatedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
    console.log(`📦 migration 158: fixed Hey Ho Nobody Home (score: ${fixedScore}, notation: ${fixedNotation}).`);
    return { updated: 1, fixedScore, fixedNotation };
  },
};
