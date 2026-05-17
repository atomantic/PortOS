/**
 * Add `{{worldCanonText}}` context block to the arc-resolve and
 * volume-verify prompt templates so the LLM sees named universe canon
 * (characters/places/objects) alongside the existing exploratory
 * `worldCategoriesText`.
 *
 * Updates (per ACCEPTED_OLD_MD5 below):
 *   - data/prompts/stages/pipeline-arc-resolve.md
 *   - data/prompts/stages/pipeline-volume-verify.md
 *
 * Why:
 *   Phase A retired the default `characters` category; characters now live in
 *   `universe.characters[]` (canon). Without this template change, arc-level
 *   prompts that grounded continuity findings in entity names lost the
 *   character roster entirely. See PLAN.md → Phase B + the
 *   "arcPlanner prompt context — include canon" backlog item it folded in.
 *
 * Strategy — unmodified-only update, mirrors migration 003:
 *   - If the on-disk file matches the prior shipped MD5 (either the pre-005
 *     hash or the currently-shipped hash), replace with the data.sample
 *     version that includes {{worldCanonText}}.
 *   - If diverged (user customized), warn and skip.
 *
 * Idempotent: a re-run on the new hash is a no-op.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

// Hashes the file may have on disk pre-migration (per-file array — most
// recent shipped hash first, then older). Any match is treated as
// "unmodified by user → safe to replace."
const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': [
    'a8677bbe1eb38f871fb152a5b0fec7c6', // current (pre-Phase B) shipped
    '87bc5c01f1a8a97b681727a38b05edc6', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
  'pipeline-volume-verify.md': [
    '03f3c874cb80e1c98abcf03168fa7a92', // current (pre-Phase B) shipped
    'c6ea28e972ad6e229bafb2d602b4dda3', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
};

// New shipped hashes — what data.sample carries post-migration.
const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md':    '2651dc3947adc75c02c4f394135f2703',
  'pipeline-volume-verify.md':  '56ad31371452a6fdf68597512f8c0d35',
};

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    const sampleDir = join(rootDir, 'data.sample', 'prompts', 'stages');

    let updated = 0;
    let alreadyCurrent = 0;
    let skipped = 0;

    for (const filename of Object.keys(ACCEPTED_OLD_MD5)) {
      const dataPath = join(stagesDir, filename);
      const samplePath = join(sampleDir, filename);

      const existing = await readFile(dataPath, 'utf-8').catch((err) => {
        if (err.code !== 'ENOENT') throw err;
        return null;
      });

      if (existing === null) {
        // setup-data.js will copy it on next run; nothing for us to do.
        console.log(`📄 arc-prompt ${filename}: not present in data/, will be created by setup-data.js`);
        continue;
      }

      const existingMd5 = md5(existing);

      if (existingMd5 === NEW_SHIPPED_MD5[filename]) {
        alreadyCurrent++;
        continue;
      }

      const acceptedOld = ACCEPTED_OLD_MD5[filename];
      if (!acceptedOld.includes(existingMd5)) {
        console.warn(
          `⚠️  arc-prompt ${filename} has been customized — skipping auto-update.\n` +
          `   To pick up {{worldCanonText}} manually, diff:\n` +
          `     data.sample/prompts/stages/${filename}\n` +
          `   against your current:\n` +
          `     data/prompts/stages/${filename}\n` +
          `   and add the new "World canon" block above the categories block.`,
        );
        skipped++;
        continue;
      }

      const sampleContent = await readFile(samplePath, 'utf-8');
      await writeFile(dataPath, sampleContent);
      console.log(`✅ updated arc-prompt: ${filename}`);
      updated++;
    }

    if (updated > 0) {
      console.log(`📝 arc-prompt canon-context migration: ${updated} updated, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
    } else if (skipped > 0) {
      console.log(`📝 arc-prompt canon-context migration: all files either current or customized (${skipped} skipped)`);
    } else {
      console.log(`📝 arc-prompt canon-context migration: all files already up to date`);
    }

    if (skipped > 0) {
      console.warn(
        `\n⚠️  ${skipped} arc prompt(s) could not be auto-updated because they were customized.\n` +
        `   The {{worldCanonText}} block will not render character names in arc-verify/resolve\n` +
        `   until the files are merged manually. See data.sample/prompts/stages/.`,
      );
    }
  },
};
