/**
 * Make the pipeline arc + season + verify + resolve prompts Vonnegut-shape
 * aware. Adds `{{{shapeGuidance}}}` (the rendered curve + per-position
 * guidance) and, where applicable, `{{shapePosition}}` / `{{volumeShapePosition}}`
 * (the per-volume placement on the picked curve) to:
 *
 *   pipeline-arc-overview        — propose-or-honor block + `shape` in JSON output
 *   pipeline-season-episodes     — per-season curve placement, episode pacing rule
 *   pipeline-arc-verify          — new "story-shape adherence" check
 *   pipeline-volume-verify       — per-volume placement + volume-internal adherence check
 *   pipeline-arc-resolve         — preserve picked shape during auto-resolve
 *
 * Strategy mirrors migration 003: replace the installed file only when its
 * hash still matches the previous shipped version. Customized files are
 * skipped with a manual-merge warning.
 *
 * `pipeline-arc-resolve.md` was never previously in data.sample/ (it shipped
 * in `27ef3c27` but only landed in `data/`). The OLD hash here is the
 * stable content of that pre-sample-installed copy; users who never received
 * it will get the new file copied in by setup-data.js on the next run.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

const OLD_SHIPPED_MD5 = {
  'pipeline-arc-overview.md':    '6a3ecab43d1f46b7ef9aab6c69ea0326',
  'pipeline-arc-verify.md':      '52e31abc93e3105176236fcaa5d1575a',
  'pipeline-volume-verify.md':   'c6ea28e972ad6e229bafb2d602b4dda3',
  'pipeline-season-episodes.md': 'c4928e2a5f833358116b29d2d669888d',
  'pipeline-arc-resolve.md':     '87bc5c01f1a8a97b681727a38b05edc6',
};

const NEW_SHIPPED_MD5 = {
  'pipeline-arc-overview.md':    'd34d72b8e49ba303d38607845dd87f1c',
  'pipeline-arc-verify.md':      'ff56d8387162017e08d5d0491060ddd6',
  'pipeline-volume-verify.md':   '03f3c874cb80e1c98abcf03168fa7a92',
  'pipeline-season-episodes.md': '50c68a29c3ebc275db3095d06bd87100',
  'pipeline-arc-resolve.md':     'a8677bbe1eb38f871fb152a5b0fec7c6',
};

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    const sampleDir = join(rootDir, 'data.sample', 'prompts', 'stages');

    let updated = 0;
    let alreadyCurrent = 0;
    let skipped = 0;
    let created = 0;

    for (const filename of Object.keys(OLD_SHIPPED_MD5)) {
      const dataPath   = join(stagesDir, filename);
      const samplePath = join(sampleDir, filename);

      const existing = await readFile(dataPath, 'utf-8').catch((err) => {
        if (err.code !== 'ENOENT') throw err;
        return null;
      });

      if (existing === null) {
        // File missing from data/ — copy from sample so the shape-aware
        // prompt is in place on next server boot. setup-data.js would do this
        // too on its next pass, but running it here keeps the migration
        // self-contained for the case where it executes before setup-data.
        const sampleContent = await readFile(samplePath, 'utf-8').catch(() => null);
        if (sampleContent != null) {
          await writeFile(dataPath, sampleContent);
          console.log(`📄 created shape-aware prompt: ${filename}`);
          created++;
        }
        continue;
      }

      const existingMd5 = md5(existing);

      if (existingMd5 === NEW_SHIPPED_MD5[filename]) {
        alreadyCurrent++;
        continue;
      }

      if (existingMd5 !== OLD_SHIPPED_MD5[filename]) {
        console.warn(
          `⚠️  pipeline stage prompt ${filename} has been customized — skipping shape-aware auto-update.\n` +
          `   To apply the Vonnegut shape variables manually, diff:\n` +
          `     data.sample/prompts/stages/${filename}\n` +
          `   against your current:\n` +
          `     data/prompts/stages/${filename}\n` +
          `   and merge the {{{shapeGuidance}}} block (and {{shapePosition}} / {{volumeShapePosition}} where applicable).`,
        );
        skipped++;
        continue;
      }

      const sampleContent = await readFile(samplePath, 'utf-8');
      await writeFile(dataPath, sampleContent);
      console.log(`✅ updated pipeline stage prompt: ${filename}`);
      updated++;
    }

    const total = updated + alreadyCurrent + skipped + created;
    console.log(
      `📝 shape-aware prompt migration: ${updated} updated, ${created} created, ` +
      `${alreadyCurrent} already current, ${skipped} skipped (customized) — ${total} files checked`,
    );

    if (skipped > 0) {
      console.warn(
        `\n⚠️  ${skipped} prompt(s) could not be auto-updated because they were customized.\n` +
        `   Shape-aware features will work for un-customized prompts; the customized\n` +
        `   ones will continue using their existing templates (without the\n` +
        `   {{{shapeGuidance}}} block) until you merge manually.`,
      );
    }
  },
};
