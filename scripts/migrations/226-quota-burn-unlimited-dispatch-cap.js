/**
 * Migration 226 — carry the old `maxDispatchesPerWindow: 5` default over to
 * "unlimited" (-1), the new default.
 *
 * Background:
 *   The dispatch cap is now opt-in — see "The dispatch cap is opt-in" in
 *   `docs/QUOTA-BURN.md` for why a count-based ceiling protected nothing the
 *   live-number gates don't already.
 *
 *   Changing the default alone would not reach an existing install. Every
 *   install that has ever SAVED a burn plan has the number 5 written into
 *   `data/cos/quota-burn.json` — the normalizer materializes every family key,
 *   caps included, before the store writes it, and migration 221 wrote 5
 *   explicitly for each per-app plan it folded in — so without this pass the new
 *   default reaches only installs that have never opened the page.
 *
 * What it writes:
 *   `data/cos/quota-burn.json`, with `maxDispatchesPerWindow: 5` rewritten to -1
 *   on each family that still carries exactly the old default. Any other value
 *   is a number the user chose over the default and is left alone; so is a
 *   family that already reads -1.
 *
 * Idempotent: a plan with no remaining 5s is left untouched on a second run.
 */

import { join } from 'path';
import { atomicWrite, readJSONFile } from '../../server/lib/fileUtils.js';
import { QUOTA_BURN_UNLIMITED_DISPATCHES } from '../../server/lib/quotaBurnConfig.js';

/** The default this release replaces. Only this exact value is rewritten. */
const PREVIOUS_DEFAULT_CAP = 5;

/**
 * Rewrite every family still on the old default cap. Pure — exported for the test.
 * @param {object} config raw parsed quota-burn config
 * @returns {{ config: object, lifted: string[] }} the family ids that changed
 */
export function liftDispatchCaps(config) {
  const source = config?.families;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { config, lifted: [] };

  const families = { ...source };
  const lifted = Object.keys(families).filter((id) => families[id]?.maxDispatchesPerWindow === PREVIOUS_DEFAULT_CAP);
  for (const id of lifted) {
    families[id] = { ...families[id], maxDispatchesPerWindow: QUOTA_BURN_UNLIMITED_DISPATCHES };
  }
  return { config: { ...config, families }, lifted };
}

export default {
  async up({ rootDir }) {
    // Read and write exactly as `quotaBurnStore.js` does, so an install that
    // never opens the page again is left with a byte-identical file shape.
    const configFile = join(rootDir, 'data', 'cos', 'quota-burn.json');
    const config = await readJSONFile(configFile, null, { allowArray: false });
    if (!config) {
      console.log('🔥 migration 226: no quota-burn config — the new unlimited default applies as-is');
      return { ok: true, reason: 'no-config' };
    }

    const { config: next, lifted } = liftDispatchCaps(config);
    if (!lifted.length) {
      console.log('🔥 migration 226: no family still carries the old dispatch cap of 5 — nothing to lift');
      return { ok: true, reason: 'already-lifted' };
    }

    await atomicWrite(configFile, next);
    console.log(`🔥 migration 226: lifted the dispatch cap to unlimited for ${lifted.length} quota-burn famil${lifted.length === 1 ? 'y' : 'ies'} (${lifted.join(', ')})`);
    return { ok: true, lifted };
  },
};
