/**
 * Add `{{worldCanonText}}` context block to the four arc/volume prompt
 * templates that receive linked-world context so the LLM sees named
 * universe canon (characters/places/objects) alongside the existing
 * exploratory `worldCategoriesText`.
 *
 * Updates (per ACCEPTED_OLD_MD5 below):
 *   - data/prompts/stages/pipeline-arc-overview.md
 *   - data/prompts/stages/pipeline-arc-verify.md
 *   - data/prompts/stages/pipeline-arc-resolve.md
 *   - data/prompts/stages/pipeline-volume-verify.md
 *
 * Why:
 *   Phase A retired the default `characters` category; characters now live in
 *   `universe.characters[]` (canon). Without this template change, arc-level
 *   prompts that grounded continuity findings in entity names lost the
 *   character roster entirely. arcPlanner exposes `worldCanonText` to every
 *   arc context now, but a context field without a template reference is
 *   silently ignored — so every prompt that gets the field must render it.
 *   See PLAN.md → Phase B + the "arcPlanner prompt context — include canon"
 *   backlog item it folded in.
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
// Exported so the test suite can import these tables and detect drift without
// maintaining local copies that can silently fall out of sync.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-overview.md': [
    'd34d72b8e49ba303d38607845dd87f1c', // current (pre-Phase B) shipped
    '6a3ecab43d1f46b7ef9aab6c69ea0326', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
  'pipeline-arc-verify.md': [
    'ff56d8387162017e08d5d0491060ddd6', // current (pre-Phase B) shipped
    '52e31abc93e3105176236fcaa5d1575a', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
  'pipeline-arc-resolve.md': [
    'a8677bbe1eb38f871fb152a5b0fec7c6', // current (pre-Phase B) shipped
    '87bc5c01f1a8a97b681727a38b05edc6', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
  'pipeline-volume-verify.md': [
    '03f3c874cb80e1c98abcf03168fa7a92', // current (pre-Phase B) shipped
    'c6ea28e972ad6e229bafb2d602b4dda3', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
};

// New shipped hashes — tracks the LIVE `data.sample` hash, not strictly the
// post-019 commit-time hash. Later migrations that further evolve any of
// these files (e.g. migration 023 amended `pipeline-arc-resolve.md`) must
// also bump the corresponding entry here so that:
//   - fresh installs whose `data/` was seeded from the latest sample report
//     `alreadyCurrent` instead of a misleading "customized" warning, and
//   - the drift-catch test below stays in lock-step with the live sample.
// Each entry comment records who last advanced it.
// Exported so the test suite can import and assert against these tables
// directly rather than maintaining local copies.
export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-overview.md':   '0a1f6ffa6908522e3690c5e9e53a6ee0', // post-019
  'pipeline-arc-verify.md':     '36aa70cdfc25d7549573a4d556e7702c', // post-019
  'pipeline-arc-resolve.md':    '5b340885c6e8f8afc63424d6b5bc7eb7', // post-023 (episode-synopsis anchor)
  'pipeline-volume-verify.md':  '49458d36700cb94e34806d536ffe2940', // post-019
};

// Pure core — exposed for unit tests so the OLD→NEW upgrade branch can be
// exercised with synthetic hash tables instead of pinning to a git commit.
export async function applyMigration({ rootDir, accepted = ACCEPTED_OLD_MD5, current = NEW_SHIPPED_MD5 }) {
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
      // setup-data.js will copy it on next run; nothing for us to do.
      console.log(`📄 arc-prompt ${filename}: not present in data/, will be created by setup-data.js`);
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
        `⚠️  arc-prompt ${filename} has been customized — skipping auto-update.\n` +
        `   To pick up {{worldCanonText}} manually, diff:\n` +
        `     data.sample/prompts/stages/${filename}\n` +
        `   against your current:\n` +
        `     data/prompts/stages/${filename}\n` +
        `   and add the new "World canon" block in the same position as in the sample template.`,
      );
      skipped++;
      continue;
    }

    const sampleContent = await readFile(samplePath, 'utf-8');
    await writeFile(dataPath, sampleContent);
    console.log(`✅ updated arc-prompt: ${filename}`);
    updated++;
  }

  return { updated, alreadyCurrent, skipped };
}

export default {
  async up({ rootDir }) {
    const { updated, alreadyCurrent, skipped } = await applyMigration({ rootDir });

    if (updated > 0) {
      console.log(`📝 arc-prompt canon-context migration: ${updated} updated, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
    } else if (skipped > 0) {
      console.log(`📝 arc-prompt canon-context migration: all files either current or customized (${skipped} skipped)`);
    } else {
      console.log(`📝 arc-prompt canon-context migration: all files already up to date`);
    }

    if (skipped > 0) {
      console.warn(
        `\n⚠️  ${skipped} arc/volume prompt(s) could not be auto-updated because they were customized.\n` +
        `   The {{worldCanonText}} block will not render character names in arc-overview/\n` +
        `   arc-verify/arc-resolve/volume-verify until the files are merged manually. See\n` +
        `   data.sample/prompts/stages/.`,
      );
    }
  },
};
