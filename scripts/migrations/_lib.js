/**
 * Shared scaffolding for hash-driven prompt-replace migrations.
 *
 * Every prompt-replace migration from 003 onward uses
 * `makePromptReplaceMigration` to collapse onto ~50 lines (hash table + label
 * + customized-skip hint).
 *
 * The runner (`scripts/run-migrations.js`) explicitly skips `_`-prefixed
 * files so this module is never imported as a migration.
 */

import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

/**
 * Newline-normalized MD5. Both `\r\n` and bare `\r` collapse to `\n` before
 * hashing so Windows checkouts of the same template hash identically.
 */
export const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

/**
 * Core scan — exposed so tests can pass synthetic `accepted` / `current`
 * tables to exercise the OLD→NEW branch without pinning to a real shipped
 * hash.
 *
 * Per-migration opt-ins (both default `false`):
 *
 * - `createIfMissing` — when the data-side file is absent, copy the sample
 *   file in. Used by migration 005, whose `pipeline-arc-resolve.md` may not
 *   have shipped in `data.reference/` yet at the time it was authored.
 *
 * - `retireOnSampleMissing` — when the sample-side file is absent (the prompt
 *   was renamed or retired by a later commit), treat it as a soft delete:
 *   unlink the data-side file when it still matches an accepted-old hash,
 *   and warn (counting as `skipped`) when it's been customized. Without this
 *   flag, a missing sample raises an ENOENT at read time. Used by migration
 *   003 to handle the `pipeline-tv-script.md` → `pipeline-teleplay.md`
 *   rename.
 */
export async function applyPromptReplaceMigration({
  rootDir,
  accepted,
  current,
  label,
  customizedHint,
  createIfMissing = false,
  retireOnSampleMissing = false,
}) {
  const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
  const sampleDir = join(rootDir, 'data.reference', 'prompts', 'stages');

  let updated = 0;
  let alreadyCurrent = 0;
  let skipped = 0;
  let created = 0;
  let retired = 0;

  for (const filename of Object.keys(accepted)) {
    const dataPath = join(stagesDir, filename);
    const samplePath = join(sampleDir, filename);

    const existing = await readFile(dataPath, 'utf-8').catch((err) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });

    if (existing === null) {
      if (createIfMissing) {
        const sampleContent = await readFile(samplePath, 'utf-8').catch(() => null);
        if (sampleContent != null) {
          await writeFile(dataPath, sampleContent);
          console.log(`📄 created ${label}: ${filename}`);
          created++;
          continue;
        }
      }
      console.log(`📄 ${label} ${filename}: not present in data/, will be created by setup-data.js`);
      continue;
    }

    const existingMd5 = md5(existing);
    const acceptedOld = accepted[filename];
    const matchesAcceptedOld = acceptedOld.includes(existingMd5);
    const matchesCurrent = existingMd5 === current[filename];

    if (retireOnSampleMissing) {
      // Peek at the sample before any other branch: a missing sample means
      // the prompt was renamed or retired upstream, so the on-disk file is
      // obsolete regardless of which shipped version it matches. Unmodified
      // copies (either accepted-old or current hash) are unlinked; customized
      // copies warn and skip.
      const sampleExists = await readFile(samplePath, 'utf-8').then(() => true, (err) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      });
      if (!sampleExists) {
        if (matchesAcceptedOld || matchesCurrent) {
          await unlink(dataPath);
          console.log(`🗑️  ${label} ${filename} was renamed/retired upstream — removed unmodified copy from data/`);
          retired++;
        } else {
          console.warn(
            `⚠️  ${label} ${filename} was renamed/retired upstream but your local copy has been customized.\n` +
            `   Check data.reference/prompts/stages/ for the replacement file and merge any custom edits manually.`,
          );
          skipped++;
        }
        continue;
      }
    }

    if (matchesCurrent) {
      alreadyCurrent++;
      continue;
    }

    if (!matchesAcceptedOld) {
      console.warn(
        `⚠️  ${label} ${filename} has been customized — skipping auto-update.\n` +
        customizedHint(filename),
      );
      skipped++;
      continue;
    }

    const sampleContent = await readFile(samplePath, 'utf-8');
    await writeFile(dataPath, sampleContent);
    console.log(`✅ updated ${label}: ${filename}`);
    updated++;
  }

  return { updated, alreadyCurrent, skipped, created, retired };
}

/**
 * Factory: returns `{ applyMigration, up }`. `skipFooter(count)` is optional
 * — when provided, the wrapped `up()` logs it after the per-file pass if any
 * file was skipped (user-facing guidance about what the customized files miss).
 */
export function makePromptReplaceMigration({
  accepted,
  current,
  label,
  customizedHint,
  skipFooter,
  createIfMissing = false,
  retireOnSampleMissing = false,
}) {
  const applyMigration = (opts = {}) =>
    applyPromptReplaceMigration({
      accepted,
      current,
      label,
      customizedHint,
      createIfMissing,
      retireOnSampleMissing,
      ...opts,
    });

  const up = async ({ rootDir }) => {
    const { updated, alreadyCurrent, skipped, created, retired } = await applyMigration({ rootDir });

    if (updated > 0 || created > 0 || retired > 0) {
      console.log(`📝 ${label} migration: ${updated} updated, ${created} created, ${retired} retired, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
    } else if (skipped > 0) {
      console.log(`📝 ${label} migration: all files either current or customized (${skipped} skipped)`);
    } else {
      console.log(`📝 ${label} migration: all files already up to date`);
    }

    if (skipped > 0 && skipFooter) {
      console.warn('\n' + skipFooter(skipped));
    }
  };

  return { applyMigration, up };
}
