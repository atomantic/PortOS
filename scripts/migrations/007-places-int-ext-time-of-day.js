/**
 * Augment `writers-room-places.md` with `intExt` + `timeOfDay` fields in the
 * extraction schema. Adds two new bullet items in the field list and two new
 * keys in the JSON output contract so downstream scene-prompt composition
 * gets first-class lighting/composition cues.
 *
 * Strategy mirrors migration 004: replace the installed file only when its
 * hash still matches the previously-shipped version. Customized files are
 * skipped with a manual-merge warning.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

const OLD_SHIPPED_MD5 = {
  'writers-room-places.md': '7f1f80eb63d67a21161994cde115045e',
};

const NEW_SHIPPED_MD5 = {
  'writers-room-places.md': '24a33628cc94d80fa5ca60831d973daf',
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
        console.log(`📄 writers-room places prompt ${filename}: not present in data/, will be created by setup-data.js`);
        continue;
      }

      const existingMd5 = md5(existing);

      if (existingMd5 === NEW_SHIPPED_MD5[filename]) {
        alreadyCurrent++;
        continue;
      }

      if (existingMd5 !== OLD_SHIPPED_MD5[filename]) {
        console.warn(
          `⚠️  places extraction prompt ${filename} has been customized — skipping auto-update.\n` +
          `   To pick up the new intExt / timeOfDay fields, diff:\n` +
          `     data.sample/prompts/stages/${filename}\n` +
          `   against your current:\n` +
          `     data/prompts/stages/${filename}\n` +
          `   and add the two new field bullets + two new JSON keys.`,
        );
        skipped++;
        continue;
      }

      const sampleContent = await readFile(samplePath, 'utf-8');
      await writeFile(dataPath, sampleContent);
      console.log(`✅ updated places extraction prompt: ${filename}`);
      updated++;
    }

    if (updated > 0) {
      console.log(`📝 places int-ext/time-of-day migration: ${updated} updated, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
    } else if (skipped > 0) {
      console.log(`📝 places int-ext/time-of-day migration: file customized (${skipped} skipped)`);
    } else {
      console.log(`📝 places int-ext/time-of-day migration: already up to date`);
    }
  },
};
