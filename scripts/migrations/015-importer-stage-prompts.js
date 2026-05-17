/**
 * Seed the three Create-Suite Importer stage prompts AND their
 * corresponding `prompts/stage-config.json` entries into existing installs.
 *
 * `scripts/setup-data.js`'s `ensureSampleContent` copies missing prompt
 * files on next run, so the .md copy is technically a no-op breadcrumb on
 * fresh installs. The stage-config entries however are merged via
 * `JSON_MERGE_TARGETS` in setup-data — but only on fresh setup. Existing
 * installs that upgrade by running migrations alone (without re-running
 * setup-data) need the merge applied here, otherwise `prompts.getStage()`
 * won't know about the importer stages, the configured `model: "heavy"`
 * tier won't be applied, and the importer LLM calls will silently fall
 * back to whatever the active provider's default model is.
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const FILENAMES = [
  'importer-canon-extract.md',
  'importer-arc-extract.md',
  'importer-issue-proposal.md',
];

const STAGE_KEYS = [
  'importer-canon-extract',
  'importer-arc-extract',
  'importer-issue-proposal',
];

export default {
  async up({ rootDir }) {
    let copied = 0;
    let present = 0;
    let skipped = 0;
    // Ensure the destination directory exists — sparse installs that
    // never ran setup-data for the prompts subtree would otherwise hit
    // ENOENT on every copy below and end up with a wall of warnings
    // and no prompts seeded.
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });
    for (const filename of FILENAMES) {
      const dataPath = join(stagesDir, filename);
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

    // Stage-config: merge importer entries into the installed config, or
    // create the file from scratch (with just the importer entries) when
    // the install has none. Without this fallback the migration would
    // leave a sparse install in a half-seeded state — .md files copied
    // above but no stage-config entries, so `getStage()` can't resolve
    // them and the importer LLM calls fail or fall back to a wrong tier.
    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.sample', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  importer-stage-prompts: data.sample stage-config.json missing — cannot resolve importer entries; skipping config write');
      return;
    }
    try {
      const sample = JSON.parse(await readFile(sampleConfigPath, 'utf8'));
      const installedExists = await access(installedConfigPath, constants.F_OK).then(() => true, () => false);
      const installed = installedExists
        ? JSON.parse(await readFile(installedConfigPath, 'utf8'))
        : { stages: {} };
      installed.stages = installed.stages || {};
      let added = 0;
      let preserved = 0;
      for (const key of STAGE_KEYS) {
        if (installed.stages[key]) { preserved++; continue; }
        if (!sample?.stages?.[key]) {
          console.warn(`⚠️  importer-stage-prompts: sample stage-config missing ${key} — skipping`);
          continue;
        }
        installed.stages[key] = sample.stages[key];
        added++;
      }
      if (added > 0) {
        await mkdir(dirname(installedConfigPath), { recursive: true });
        await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
      }
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 importer stage-config (${action}): ${added} added, ${preserved} already present`);
    } catch (err) {
      console.warn(`⚠️  importer-stage-prompts: stage-config merge failed: ${err.message}`);
    }
  },
};
