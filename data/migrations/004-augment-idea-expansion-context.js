/**
 * Augment `pipeline-idea-expansion.md` with arc / volume / neighbor-issue
 * context blocks. The beat-sheet expander now sees the whole-series arc, the
 * parent volume's logline / synopsis / endingHook, the immediately-prior
 * issue's beats (or synopsis when un-expanded), and the immediately-next
 * issue's beats / synopsis — same shape a human editor has open while
 * writing beats.
 *
 * Strategy mirrors migration 003: replace the installed file only when its
 * hash still matches the previous shipped version (= the migration-003 NEW
 * hash). Customized files are skipped with a manual-merge warning.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

// The version shipped after migration 003 — the only state this migration
// is willing to auto-update from.
const OLD_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': '41facefbc0c0549d456bef9111f95ab9',
};

// The version shipped with this migration — used to detect "already applied"
// on re-runs.
const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': '1ee44cf95851ff8debf18729ebcd40b4',
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
        console.log(`📄 pipeline stage prompt ${filename}: not present in data/, will be created by setup-data.js`);
        continue;
      }

      const existingMd5 = md5(existing);

      if (existingMd5 === NEW_SHIPPED_MD5[filename]) {
        alreadyCurrent++;
        continue;
      }

      if (existingMd5 !== OLD_SHIPPED_MD5[filename]) {
        console.warn(
          `⚠️  pipeline stage prompt ${filename} has been customized — skipping auto-update.\n` +
          `   To pick up the new arc / volume / neighbor-issue context blocks, diff:\n` +
          `     data.sample/prompts/stages/${filename}\n` +
          `   against your current:\n` +
          `     data/prompts/stages/${filename}\n` +
          `   and merge the {{#arc}}, {{#volume}}, {{#priorIssue}}, {{#nextIssue}},\n` +
          `   {{#priorVolume}}, {{#arcRole}}, and {{#positionInVolume}} sections.`,
        );
        skipped++;
        continue;
      }

      const sampleContent = await readFile(samplePath, 'utf-8');
      await writeFile(dataPath, sampleContent);
      console.log(`✅ updated pipeline stage prompt: ${filename}`);
      updated++;
    }

    if (updated > 0) {
      console.log(`📝 idea-expansion context migration: ${updated} updated, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
    } else if (skipped > 0) {
      console.log(`📝 idea-expansion context migration: file customized (${skipped} skipped)`);
    } else {
      console.log(`📝 idea-expansion context migration: already up to date`);
    }
  },
};
