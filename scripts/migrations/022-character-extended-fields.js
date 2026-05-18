/**
 * Extend universe canon characters with novelist + graphic-novelist depth:
 *   - identity: pronouns, age, coreTheme, speechAccent, visualNotes
 *   - visual:   silhouetteNotes, postureNotes, specialTraits, visualIdentity
 *   - narrative: motivations, likes, dislikes, mannerisms, relationships, skills
 *   - lists:     stats[], colorPalette[], props[], expressions[], handGestures[]
 *   - operational: referenceSheetImageRef (filename in data/image-refs/)
 *
 * Why this migration is record-only:
 *   `sanitizeCharacter` in server/lib/storyBible.js already fills every new
 *   field with a default ('' / []) on next read of an old record, so no on-disk
 *   rewrite is required for the schema extension to take effect. The migration
 *   exists so the version pin is explicit (so a future reader of the applied
 *   list sees where the extension landed) AND so the shipped reference-sheet
 *   template asset is present on existing installs — `scripts/setup-data.js`
 *   auto-copies the file on next start, but the migration provides a deterministic
 *   guarantee for the no-restart upgrade path (`npm run migrations` alone).
 *
 * Side effect: copies `data.sample/templates/character-reference-sheet.png`
 * into `data/templates/character-reference-sheet.png` when missing.
 */

import { existsSync, mkdirSync, cpSync } from 'fs';
import { join } from 'path';

export async function up({ rootDir }) {
  const sampleTemplate = join(rootDir, 'data.sample', 'templates', 'character-reference-sheet.png');
  const targetDir = join(rootDir, 'data', 'templates');
  const targetTemplate = join(targetDir, 'character-reference-sheet.png');

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
    console.log(`📁 Created ${targetDir}`);
  }
  if (!existsSync(targetTemplate)) {
    if (!existsSync(sampleTemplate)) {
      // setup-data.js's auto-copy of missing files runs alongside the
      // migrations on every start, so a one-off missing-shipped-asset case
      // is harmless — log + continue rather than failing the whole run.
      console.warn(`⚠️ Character reference sheet template missing at ${sampleTemplate} — skipping copy. Run \`npm run install:all\` to provision.`);
    } else {
      cpSync(sampleTemplate, targetTemplate);
      console.log(`📄 Copied character-reference-sheet.png → data/templates/`);
    }
  }
  // No universe-builder.json rewrite — sanitizer fills the new fields on
  // next read. This keeps the migration idempotent and tiny.
}

export default { up };
