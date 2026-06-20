/**
 * Backfill the canonic voice stacks (Voice 2 / 3 / 4 — the round sung against
 * itself) onto the four built-in traditional rounds for installs that seeded the
 * rounds before they carried a voice stack.
 *
 * Background:
 *   `server/services/rounds.js#SEED_ROUNDS` now ships each round (Hey Ho Nobody
 *   Home, Ah Poor Bird, Rose Rose Rose Red, Zum Gali Gali) with its canonic voice
 *   stack (SEED_ROUND_SCORE_PARTS) — the melody entering a fixed number of bars
 *   late per voice. This is what gives every round (not just 500 Miles) the
 *   layered MIDI player + piano-roll view in the editor.
 *
 *   Fresh installs seed the parts directly. An install that already persisted
 *   data/songs.json keeps its existing round records — which have no `scoreParts`.
 *   This migration adds the shipped parts to a round ONLY when it has none, so a
 *   user who hand-wrote or AI-derived their own parts is never clobbered. The
 *   parts come from the single shipped source (no drift); the user can also pull
 *   the latest bundled content any time via "Refresh from template".
 *
 *   Fresh installs (no file) are a clean no-op. Re-runs detect parts present and
 *   skip. Mirrors migration 076 (the same backfill for 500 Miles).
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { SEED_ROUND_SCORE_PARTS } from '../../server/services/rounds.js';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'songs.json');
    if (!(await fileExists(path))) {
      console.log('📦 migration 086: no data/songs.json — fresh install seeds the round parts directly.');
      return { updated: 0, reason: 'no-file' };
    }

    const raw = await readFile(path, 'utf-8');
    let doc;
    try { doc = JSON.parse(raw); } catch (err) {
      console.warn(`⚠️ migration 086: data/songs.json is unparseable (${err.message}); skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.songs)) {
      return { updated: 0, reason: 'unexpected-shape' };
    }

    const now = new Date().toISOString();
    const filled = [];
    for (const [id, parts] of Object.entries(SEED_ROUND_SCORE_PARTS)) {
      const song = doc.songs.find((s) => s && s.id === id);
      if (!song) continue;                                              // round absent (user deleted it)
      if (Array.isArray(song.scoreParts) && song.scoreParts.length > 0) continue; // user/AI parts — leave alone
      // Deep-clone the shipped parts so the persisted record can't share
      // references with the in-memory seed (defensive — the seed is reused).
      song.scoreParts = parts.map((p) => ({ ...p }));
      song.updatedAt = now;
      filled.push(`${song.title || id} (${song.scoreParts.length})`);
    }

    if (filled.length === 0) {
      console.log('📦 migration 086: no rounds needed voice parts; nothing to backfill.');
      return { updated: 0, reason: 'already-applied' };
    }

    await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
    console.log(`📦 migration 086: seeded canonic voice parts onto ${filled.length} round(s): ${filled.join(', ')}.`);
    return { updated: filled.length };
  },
};
