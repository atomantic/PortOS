/**
 * Shared scaffolding for hash-driven prompt-replace migrations.
 *
 * Migrations 023 and 025 use `makePromptReplaceMigration` to collapse each
 * migration onto ~50 lines (hash table + label + customized-skip hint).
 * 003, 006, 019 are inline copies of the same pattern — candidates for a
 * back-port pass; see PLAN.md `[backport-pre-023-migrations-to-_lib]`.
 *
 * The runner (`scripts/run-migrations.js`) explicitly skips `_`-prefixed
 * files so this module is never imported as a migration.
 */

import { readFile, writeFile } from 'fs/promises';
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
 * hash. Files missing from `data/` are no-ops — `setup-data.js` creates them.
 */
export async function applyPromptReplaceMigration({
  rootDir,
  accepted,
  current,
  label,
  customizedHint,
}) {
  const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
  const sampleDir = join(rootDir, 'data.sample', 'prompts', 'stages');

  let updated = 0;
  let alreadyCurrent = 0;
  let skipped = 0;

  for (const filename of Object.keys(accepted)) {
    const dataPath = join(stagesDir, filename);
    const samplePath = join(sampleDir, filename);

    const existing = await readFile(dataPath, 'utf-8').catch((err) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });

    if (existing === null) {
      console.log(`📄 ${label} ${filename}: not present in data/, will be created by setup-data.js`);
      continue;
    }

    const existingMd5 = md5(existing);

    if (existingMd5 === current[filename]) {
      alreadyCurrent++;
      continue;
    }

    const acceptedOld = accepted[filename];
    if (!acceptedOld.includes(existingMd5)) {
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

  return { updated, alreadyCurrent, skipped };
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
}) {
  const applyMigration = (opts = {}) =>
    applyPromptReplaceMigration({
      accepted,
      current,
      label,
      customizedHint,
      ...opts,
    });

  const up = async ({ rootDir }) => {
    const { updated, alreadyCurrent, skipped } = await applyMigration({ rootDir });

    if (updated > 0) {
      console.log(`📝 ${label} migration: ${updated} updated, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
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
