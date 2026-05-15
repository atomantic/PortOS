/**
 * Update five pipeline stage prompt templates that were updated in the
 * "length profile" feature (feat/pipeline-genconfig-length-cover).
 *
 * The prompts now carry `{{lengthTargets.*}}` variables so the idea, prose,
 * comic-script, and TV-script stages scale their beat counts, word targets,
 * and page/minute targets with the per-issue length profile picker instead of
 * using the old hardcoded numbers.
 *
 * Strategy — "unmodified-only" update:
 *   Each file is compared against the MD5 of the version that shipped before
 *   this feature landed (the "old shipped" hash). If the file on disk still
 *   matches that hash, the user hasn't customized it and we replace it with
 *   the current data.sample version. If the hash diverges (customized), we
 *   skip and warn so the user can merge manually.
 *
 * Idempotent — a re-run that finds the current data.sample hash on disk
 * is a no-op.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

// MD5 hashes of the version shipped BEFORE the length-profile feature.
// Computed from git show <merge-base>:data.sample/prompts/stages/<file>.
// If the live file matches one of these, the user hasn't customized it.
const OLD_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': 'aee25112b2c596f643b17c559b772c22',
  'pipeline-prose.md':          'bfea5aeeb471aae9749baee765b473a7',
  'pipeline-comic-script.md':   '40e5fdc1a1e68a7419b7dad936366c1a',
  'pipeline-tv-script.md':      '3f6fecc25573ed054b47db392250034a',
  'pipeline-season-episodes.md':'6e349ad26bed8a0ccb042571f03f03eb',
};

// MD5 hashes of the updated versions in data.sample (what this migration
// copies in). Used to detect "already up to date" on re-runs.
const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': '41facefbc0c0549d456bef9111f95ab9',
  'pipeline-prose.md':          '30ac30ec2b9d3e2a9eb869c181732cc6',
  'pipeline-comic-script.md':   'beab031951859ca13579cdb9c4dbe769',
  'pipeline-tv-script.md':      '376f779f4687b598f1c92ca4e770fd5a',
  'pipeline-season-episodes.md':'c4928e2a5f833358116b29d2d669888d',
};

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    const sampleDir = join(rootDir, 'data.sample', 'prompts', 'stages');

    let updated = 0;
    let alreadyCurrent = 0;
    let skipped = 0;

    for (const filename of Object.keys(OLD_SHIPPED_MD5)) {
      const dataPath   = join(stagesDir, filename);
      const samplePath = join(sampleDir, filename);

      const existing = await readFile(dataPath, 'utf-8').catch((err) => {
        if (err.code !== 'ENOENT') throw err;
        return null;
      });

      if (existing === null) {
        // File missing from data/ — setup-data.js will copy it on next run;
        // nothing for this migration to do.
        console.log(`📄 pipeline stage prompt ${filename}: not present in data/, will be created by setup-data.js`);
        continue;
      }

      const existingMd5 = md5(existing);

      if (existingMd5 === NEW_SHIPPED_MD5[filename]) {
        // Already at the new version — idempotent no-op.
        alreadyCurrent++;
        continue;
      }

      if (existingMd5 !== OLD_SHIPPED_MD5[filename]) {
        // Diverged from the old shipped version — user has customized this file.
        // Warn and skip to avoid clobbering their edits.
        console.warn(
          `⚠️  pipeline stage prompt ${filename} has been customized — skipping auto-update.\n` +
          `   To apply the length-profile variables manually, diff:\n` +
          `     data.sample/prompts/stages/${filename}\n` +
          `   against your current:\n` +
          `     data/prompts/stages/${filename}\n` +
          `   and merge the {{lengthTargets.*}} template variables.`,
        );
        skipped++;
        continue;
      }

      // File matches the old shipped version — safe to replace.
      const sampleContent = await readFile(samplePath, 'utf-8');
      await writeFile(dataPath, sampleContent);
      console.log(`✅ updated pipeline stage prompt: ${filename}`);
      updated++;
    }

    if (updated > 0) {
      console.log(`📝 pipeline stage prompt migration: ${updated} updated, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
    } else if (skipped > 0) {
      console.log(`📝 pipeline stage prompt migration: all files either current or customized (${skipped} skipped)`);
    } else {
      console.log(`📝 pipeline stage prompt migration: all files already up to date`);
    }

    if (skipped > 0) {
      console.warn(
        `\n⚠️  ${skipped} prompt(s) could not be auto-updated because they were customized.\n` +
        `   The length profile picker UI will work, but those prompts won't use\n` +
        `   {{lengthTargets.*}} variables until you merge them manually.\n` +
        `   See data.sample/prompts/stages/ for the updated templates.`,
      );
    }
  },
};
