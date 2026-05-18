/**
 * Add an "Anchor every edit in the per-episode `synopsis` entries" bullet at
 * the top of the `pipeline-arc-resolve.md` "How to resolve" list.
 *
 * Why:
 *   `buildResolveContext` already feeds episode-level `synopsis` strings into
 *   `seasonsTreeJson` (via `buildVerifyContext`), but none of the prior
 *   numbered guidance steps told the LLM to use them. The auto-resolve pass
 *   could rewrite a volume's `synopsis` in a way that contradicted the
 *   per-episode `synopsis` entries underneath. This bullet pins the LLM to
 *   treat episode synopses as ground truth when adjusting volume framing.
 *
 *   The pre-resolve verify prompt (`pipeline-arc-verify.md`) already calls
 *   out episode-level evidence explicitly ("Did a character die in episode 4
 *   but get dialogue in episode 7?"). Resolve inherited the same data path
 *   but not the same instruction shape — see PLAN.md
 *   `[resolve-issues-inherits-verify-gaps-verify-the]`.
 *
 * Strategy — unmodified-only update, mirrors migrations 003 / 019:
 *   - If the on-disk file matches the prior shipped MD5 (the post-019
 *     hash that {{worldCanonText}} introduced), replace with the
 *     data.sample version that includes the new anchor bullet.
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

// Hashes the file may have on disk pre-migration. Most recent shipped first,
// then older. Any match is "unmodified by user → safe to replace."
// Exported so the test suite can import them and detect drift without
// maintaining local copies.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': [
    '8e348f3d1894382889f9f0ee7d5c6792', // post-019 (worldCanonText) shipped — current pre-023
    'a8677bbe1eb38f871fb152a5b0fec7c6', // pre-019 (pre-canon), still in setup-data.js OLD list
    '87bc5c01f1a8a97b681727a38b05edc6', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
};

// New shipped hash — what data.sample carries post-migration.
export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '5b340885c6e8f8afc63424d6b5bc7eb7',
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
      console.log(`📄 resolve-prompt ${filename}: not present in data/, will be created by setup-data.js`);
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
        `⚠️  resolve-prompt ${filename} has been customized — skipping auto-update.\n` +
        `   To pick up the new "anchor in per-episode synopses" guidance manually, diff:\n` +
        `     data.sample/prompts/stages/${filename}\n` +
        `   against your current:\n` +
        `     data/prompts/stages/${filename}\n` +
        `   and add the new bullet 1 in the "How to resolve" list.`,
      );
      skipped++;
      continue;
    }

    const sampleContent = await readFile(samplePath, 'utf-8');
    await writeFile(dataPath, sampleContent);
    console.log(`✅ updated resolve-prompt: ${filename}`);
    updated++;
  }

  return { updated, alreadyCurrent, skipped };
}

export default {
  async up({ rootDir }) {
    const { updated, alreadyCurrent, skipped } = await applyMigration({ rootDir });

    if (updated > 0) {
      console.log(`📝 resolve-prompt episode-anchor migration: ${updated} updated, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
    } else if (skipped > 0) {
      console.log(`📝 resolve-prompt episode-anchor migration: all files either current or customized (${skipped} skipped)`);
    } else {
      console.log(`📝 resolve-prompt episode-anchor migration: all files already up to date`);
    }

    if (skipped > 0) {
      console.warn(
        `\n⚠️  ${skipped} resolve prompt could not be auto-updated because it was customized.\n` +
        `   The auto-resolve pass will keep working but won't be explicitly told to anchor\n` +
        `   volume-synopsis edits in the per-episode \`synopsis\` entries from\n` +
        `   \`seasonsTreeJson.episodes[].synopsis\`. See data.sample/prompts/stages/.`,
      );
    }
  },
};
