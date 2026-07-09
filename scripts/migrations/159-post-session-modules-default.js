/**
 * Upgrade the legacy POST `sessionModules` default (issue #2100).
 *
 * Background:
 *   `sessionModules` in `data/meatspace/post-config.json` was always persisted
 *   (updatePostConfig writes the whole merged config), but nothing ever read it
 *   to compose a session — so every saved config carried the old default value
 *   `['mental-math']`. Issue #2100 wires it into the launcher's Full POST / Quick
 *   composition, which means that stale `['mental-math']` would suddenly restrict
 *   those installs to math-only, silently dropping the cognitive drills they were
 *   getting before.
 *
 *   This migration rewrites the exact legacy value `['mental-math']` to the new
 *   balanced default `['mental-math', 'cognitive']`. It runs once, on the same
 *   update that ships the new config selector — so no user could yet have
 *   *deliberately* chosen `['mental-math']`, and the upgrade can't clobber a real
 *   choice. Any other value (already the new default, or a user selection made
 *   after this ships) is left untouched, and a missing file is a clean no-op
 *   (fresh installs seed the new default on first write).
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const REL_PATH = 'data/meatspace/post-config.json';

// The exact legacy default this migration upgrades, and its replacement. Kept
// as literals (not imported from the service) so the migration is frozen to the
// value it shipped for — a later default change must not retroactively alter
// what this one-time migration rewrites.
export const LEGACY_SESSION_MODULES = ['mental-math'];
export const NEW_SESSION_MODULES = ['mental-math', 'cognitive'];

const isLegacy = (mods) =>
  Array.isArray(mods) && mods.length === 1 && mods[0] === 'mental-math';

export default {
  async up({ rootDir }) {
    const configPath = join(rootDir, REL_PATH);
    const raw = await readFile(configPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${REL_PATH} not present — skipping (fresh installs seed the new default on first write)`);
      return { updated: 0, reason: 'no-file' };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${REL_PATH}: invalid JSON, skipping (${err.message})`);
      return { updated: 0, reason: 'invalid-json' };
    }

    if (!isLegacy(data?.sessionModules)) {
      console.log(`✅ ${REL_PATH}: sessionModules already upgraded or customized — no changes`);
      return { updated: 0, reason: 'not-legacy' };
    }

    data.sessionModules = [...NEW_SESSION_MODULES];
    await writeFile(configPath, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`📝 ${REL_PATH}: upgraded legacy sessionModules ['mental-math'] → ['mental-math','cognitive']`);
    return { updated: 1 };
  },
};
