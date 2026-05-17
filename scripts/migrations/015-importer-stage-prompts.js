/**
 * Seed the three Create-Suite Importer stage prompts into existing installs.
 *
 * `scripts/setup-data.js`'s `ensureSampleContent` already copies missing
 * files on next run, so this migration is technically a no-op breadcrumb on
 * fresh installs. It exists so older installs that don't restart through
 * setup-data still pick up the prompts the first time `npm run migrations`
 * runs after upgrading. Each file is copied only when missing — never
 * overwrites a user-customized prompt.
 */

import { access, copyFile, constants } from 'fs/promises';
import { join } from 'path';

const FILENAMES = [
  'importer-canon-extract.md',
  'importer-arc-extract.md',
  'importer-issue-proposal.md',
];

export default {
  async up({ rootDir }) {
    let copied = 0;
    let present = 0;
    let skipped = 0;
    for (const filename of FILENAMES) {
      const dataPath = join(rootDir, 'data', 'prompts', 'stages', filename);
      const samplePath = join(rootDir, 'data.sample', 'prompts', 'stages', filename);

      const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
      if (exists) { present++; continue; }

      // Validate the source exists before copy — if `data.sample/` was
      // trimmed in a later release or this migration runs against a sparse
      // checkout, we'd otherwise abort the whole migration batch mid-loop.
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  importer-stage-prompts: sample missing for ${filename} — skipping`);
        skipped++;
        continue;
      }

      try {
        await copyFile(samplePath, dataPath);
        copied++;
        console.log(`✅ seeded ${filename}`);
      } catch (err) {
        // Don't abort the batch — log and keep going so the other prompts
        // still land. The operator sees exactly which one failed.
        console.warn(`⚠️  importer-stage-prompts: copy failed for ${filename}: ${err.message}`);
        skipped++;
      }
    }
    console.log(`📝 importer prompts: ${copied} copied, ${present} already present, ${skipped} skipped`);
  },
};
