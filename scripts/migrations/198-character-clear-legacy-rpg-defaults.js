/**
 * Clear the legacy generic RPG identity from an existing character.json.
 *
 * Background:
 *   The Character page used to seed `createDefaultCharacter()` with
 *   `name: 'Adventurer'`, `class: 'Developer'` — a generic D&D adventurer. The
 *   human-centered reframe (#2677, epic #2672) changes the seed to empty strings
 *   so a fresh install renders the "Your name" / "Add a title" placeholders and
 *   never presents a generic adventurer.
 *
 *   That seed change is prospective only: an install created before #2677 still
 *   has `name: 'Adventurer'` / `class: 'Developer'` persisted, so it would keep
 *   showing the old identity forever. This migration converges those installs on
 *   the new behavior by clearing the fields to '' — but ONLY when they exactly
 *   match the old shipped defaults, so a user who deliberately typed either word
 *   (or has already personalized their name/title) is left untouched.
 *
 * Approach:
 *   - Per-field, exact-match only: `name === 'Adventurer'` → '' and
 *     `class === 'Developer'` → '' independently. Any other value is a
 *     deliberate choice and is preserved.
 *   - Rewrites the file only when something actually changed — a no-op by
 *     construction on the common case (already personalized, or already blank),
 *     and on a fresh post-#2677 install (blank seed) there is nothing to match.
 *   - Preserves every other field and stamps `updatedAt` when it does change.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const CHARACTER_REL = 'data/character.json';

const LEGACY_DEFAULT_NAME = 'Adventurer';
const LEGACY_DEFAULT_CLASS = 'Developer';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, CHARACTER_REL);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log('✅ Character: no character.json — nothing to clear');
      return { cleared: false, reason: 'no-file' };
    }

    let character;
    try {
      character = JSON.parse(raw);
    } catch {
      // A corrupt character.json is not this migration's problem to fix, and
      // rewriting it would risk destroying recoverable data.
      console.warn('⚠️ Character: character.json is not valid JSON — skipping');
      return { cleared: false, reason: 'unparseable' };
    }
    if (character == null || typeof character !== 'object' || Array.isArray(character)) {
      console.warn('⚠️ Character: character.json is not an object — skipping');
      return { cleared: false, reason: 'unexpected-shape' };
    }

    const next = { ...character };
    let changed = false;
    if (next.name === LEGACY_DEFAULT_NAME) { next.name = ''; changed = true; }
    if (next.class === LEGACY_DEFAULT_CLASS) { next.class = ''; changed = true; }

    if (!changed) {
      console.log('✅ Character: no legacy RPG defaults to clear — no changes');
      return { cleared: false };
    }

    next.updatedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(next, null, 2) + '\n');
    console.log('🧹 Character: cleared legacy "Adventurer" / "Developer" defaults');
    return { cleared: true };
  },
};
