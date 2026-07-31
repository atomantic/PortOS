/**
 * Give the built-in "Hey Ho Nobody Home" round its missing fourth phrase, and
 * correct its fourth lyric line (issue #3238).
 *
 * Background:
 *   The shipped round listed FOUR lyric lines but its melody carried only THREE
 *   two-bar phrases (6 bars) — the closing line had no notes at all, so the
 *   lyric sheet and the staff disagreed. Worse, the round anchors the D-minor
 *   quodlibet with Ah Poor Bird and Rose Rose Rose Red, both of which are 8
 *   bars: at 6 bars Hey Ho lapped its own documented partners every four cycles,
 *   so the round-against-round stack in RoundStack never actually stayed in
 *   phase.
 *
 *   The fourth line was also wrong. It shipped as a repeat of line 1 ("Hey, ho,
 *   nobody home.") where the line as commonly sung is "Hey, hey, ho."
 *
 *   The seed now ships an 8-bar `HEY_HO_MELODY` whose fourth phrase cadences
 *   F–E–D onto the tonic (all within the round's existing D natural-minor
 *   pentachord), the corrected lyric line, and a real fourth canon voice
 *   (`delayBars: 6`) matching how the other 8-bar rounds stack.
 *
 *   Fresh installs seed all of that directly. An install whose
 *   `data/rounds.json` already holds the 6-bar record keeps the short melody and
 *   the wrong lyric on disk. This migration replaces them with the shipped
 *   versions ONLY when the stored value still exactly matches the old shipped
 *   string — a user who customized their score or lyrics is never clobbered
 *   (they can pull the shipped version any time via "Refresh from template").
 *   Score, lyrics, and notation are each gated on their OWN old-string match, so
 *   a customized score with stock lyrics still gets the lyric correction.
 *
 *   Fresh installs (no file) are a clean no-op. Re-runs detect the corrected
 *   content and skip.
 *
 *   Runs after migration 158 (which corrected the same round's pitch content),
 *   so the "old" score fingerprint below is the POST-158 6-bar melody.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { SEED_ROUNDS } from '../../server/services/rounds.js';

const ROUND_ID = 'seed-hey-ho-nobody-home';
const SECTION_ID = 'sec-round';

// The NEW shipped content — read from the single source of truth in rounds.js
// (identity, not a copy) so this migration and the seed can never drift. The
// migration test asserts these come from SEED_ROUNDS.
const NEW_SEED = SEED_ROUNDS.find((r) => r.id === ROUND_ID);
export const NEW_HEY_HO_SCORE = NEW_SEED.score;
export const NEW_HEY_HO_SCORE_PARTS = NEW_SEED.scoreParts;
export const NEW_HEY_HO_NOTATION = NEW_SEED.notation;
export const NEW_HEY_HO_LYRICS = NEW_SEED.sections.find((s) => s.id === SECTION_ID).lyrics;

// The OLD shipped melody — frozen exactly as SEED_ROUNDS shipped it AFTER #2105
// but BEFORE #3238 (D-centered and correct, but only three phrases / 6 bars).
// Hard-coded on purpose: this is the fingerprint that tells "still the untouched
// shipped score" apart from a user customization. Do NOT regenerate it from
// rounds.js — that would defeat the point (it must NOT track the extended melody).
export const OLD_HEY_HO_SCORE_6BAR = [
  'clef: treble',
  'key: C',
  'time: 4/4',
  'tempo: 76',
  '',
  '| D4h(Hey) A3h(ho) | D4q(no-) D4e(bo-) D4e(dy) A3h(home) |',
  '| D4q(Meat) D4q(nor) E4q(drink) E4q(nor) | F4e(mon-) F4e(ey) F4e(have) F4e(I) E4h(none) |',
  '| A4q(Still) G4q(I) A4q(will) G4q(be) | F4h(mer-) E4h(ry) |',
].join('\n');

// The OLD shipped lyric block — frozen exactly as it read before #3238, with the
// fourth line repeating line 1. Gates the lyric correction.
export const OLD_HEY_HO_LYRICS =
  'Hey, ho, nobody home,\nMeat nor drink nor money have I none,\nStill I will be merry.\nHey, ho, nobody home.';

// The OLD shipped notation — frozen exactly as it read after #2105 and before
// #3238 (truthful about the key, silent about the phrase count). Gates the
// notation correction.
export const OLD_HEY_HO_NOTATION =
  'A round in up to six voices (Ravenscroft\'s Pammelia, 1609). New voices enter one two-bar phrase behind the last. Centered on D with no key signature — all naturals (D Dorian / natural minor), no B. Melody after the Wikibooks Songbook and Kodály teaching transcriptions, transposed to a D tonal center.';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'rounds.json');
    if (!(await fileExists(path))) {
      console.log('📦 migration 214: no data/rounds.json — fresh install seeds the four-phrase round directly.');
      return { updated: 0, reason: 'no-file' };
    }

    const raw = await readFile(path, 'utf-8');
    let doc;
    try { doc = JSON.parse(raw); } catch (err) {
      console.warn(`⚠️ migration 214: data/rounds.json is unparseable (${err.message}); skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.rounds)) {
      return { updated: 0, reason: 'unexpected-shape' };
    }

    const round = doc.rounds.find((r) => r && r.id === ROUND_ID);
    if (!round) {
      console.log('📦 migration 214: built-in Hey Ho Nobody Home not present; nothing to fix.');
      return { updated: 0, reason: 'round-absent' };
    }

    let fixedScore = false;
    let fixedLyrics = false;
    let fixedNotation = false;

    // Replace score + scoreParts only when the stored score is still the exact
    // 6-bar shipped string. Deep-clone the scoreParts so the persisted record
    // can't share array/object identity with the in-memory seed.
    if (round.score === OLD_HEY_HO_SCORE_6BAR) {
      round.score = NEW_HEY_HO_SCORE;
      round.scoreParts = NEW_HEY_HO_SCORE_PARTS.map((p) => ({ ...p }));
      fixedScore = true;
    }

    // Correct the fourth lyric line independently — a customized score with the
    // stock lyric block still deserves the right words.
    const section = Array.isArray(round.sections)
      ? round.sections.find((s) => s && s.id === SECTION_ID)
      : null;
    if (section && section.lyrics === OLD_HEY_HO_LYRICS) {
      section.lyrics = NEW_HEY_HO_LYRICS;
      fixedLyrics = true;
    }

    // Correct the notation independently too, gated on its own old string.
    if (round.notation === OLD_HEY_HO_NOTATION) {
      round.notation = NEW_HEY_HO_NOTATION;
      fixedNotation = true;
    }

    if (!fixedScore && !fixedLyrics && !fixedNotation) {
      console.log('📦 migration 214: Hey Ho already has its fourth phrase or is customized; leaving it untouched.');
      return { updated: 0, reason: 'already-applied' };
    }

    round.updatedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
    console.log(`📦 migration 214: extended Hey Ho Nobody Home (score: ${fixedScore}, lyrics: ${fixedLyrics}, notation: ${fixedNotation}).`);
    return { updated: 1, fixedScore, fixedLyrics, fixedNotation };
  },
};
