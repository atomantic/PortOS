/**
 * pipeline-extract-scenes.md grew a per-scene `shots[]` decomposition so the
 * storyboard pipeline can render shot-level start frames + drive episode-video
 * clip grouping with continuity chaining. Existing installs need the updated
 * prompt to actually emit shots from the LLM.
 *
 * Strategy mirrors migration 003: replace the file iff the on-disk hash still
 * matches the version shipped before this feature. Customized files are
 * skipped with a warning so manual edits aren't clobbered.
 *
 * Idempotent — a re-run that finds the new shipped hash on disk is a no-op.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

const OLD_SHIPPED_MD5 = {
  'pipeline-extract-scenes.md': '59fa5ee305ce53d91eb15224d8b546d3',
};

const NEW_SHIPPED_MD5 = {
  'pipeline-extract-scenes.md': 'c51fb208568d0d903eb43b437478b0ba',
};

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    const sampleDir = join(rootDir, 'data.sample', 'prompts', 'stages');

    let updated = 0;
    let alreadyCurrent = 0;
    let skipped = 0;

    for (const filename of Object.keys(OLD_SHIPPED_MD5)) {
      const dataPath = join(stagesDir, filename);
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
          `   Manually merge the shots[] additions from:\n` +
          `     data.sample/prompts/stages/${filename}\n` +
          `   into your current:\n` +
          `     data/prompts/stages/${filename}`,
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
      console.log(`📝 extract-scenes shots migration: ${updated} updated, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
    } else if (skipped > 0) {
      console.log(`📝 extract-scenes shots migration: ${skipped} customized (skipped)`);
    } else {
      console.log('📝 extract-scenes shots migration: already up to date');
    }

    if (skipped > 0) {
      console.warn(
        `\n⚠️  ${skipped} prompt(s) could not be auto-updated. Storyboard shot extraction\n` +
        `   will not produce shots[] until the prompt is updated manually.\n`,
      );
    }
  },
};
