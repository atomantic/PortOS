/**
 * Refresh stored quota-burn audit prompts to the current shared contract.
 *
 * Picking a preset COPIES its text into the job's own `params.prompt`, and that
 * snapshot carries no version marker, so a contract revision reaches existing
 * jobs only through a migration. Migration 294 supplied one, but matched a
 * stored prompt byte-for-byte against a single reconstructed prior render —
 * which a job seeded two revisions ago can never equal. Every real job on the
 * install that motivated this migration was therefore counted "user-edited" and
 * left running a contract that predated the dispatch-label guidance entirely,
 * so an entire backlog of filed issues arrived with no `model:`/`effort:` labels
 * for the dispatcher to route on.
 *
 * `upgradeStoredAuditPrompt` replaces that rule with one that survives any
 * number of contract revisions: match the MISSION half (what to audit — stable),
 * replace the CONTRACT half (how to audit — the part that keeps changing), and
 * refuse when the stored contract has lost the sentences every shipped render
 * carried, which is how a user's own procedure is recognized and left alone.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileCore.js';
import { upgradeStoredAuditPrompt } from '../../server/lib/quotaBurnPresets.js';

const QUOTA_BURN_PATH = join('data', 'cos', 'quota-burn.json');

/**
 * Absent → `null` (nothing to migrate). Unparseable → THROW.
 *
 * Swallowing a parse error would return the same `null` as "this install has no
 * burn plan", the migration would report 0 updates, and the runner would record
 * 305 as applied — so once the user repaired their JSON, the refresh that is the
 * whole point of this migration would never run again. Failing loudly on a
 * corrupt file is the only outcome that stays recoverable.
 */
async function readJson(path) {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${QUOTA_BURN_PATH} is not valid JSON (${err.message}) — repair it and re-run migrations`);
  }
}

export default {
  async up({ rootDir }) {
    const fullPath = join(rootDir, QUOTA_BURN_PATH);
    const config = await readJson(fullPath);
    if (!config?.families) return { updated: 0 };

    let updated = 0;
    let skipped = 0;

    for (const [familyId, family] of Object.entries(config.families)) {
      for (const job of family?.jobs || []) {
        const stored = job?.params?.prompt;
        if (typeof stored !== 'string') continue;
        const upgraded = upgradeStoredAuditPrompt(stored);
        if (!upgraded) {
          skipped += 1;
          continue;
        }
        job.params.prompt = upgraded;
        updated += 1;
        console.log(`📝 ${QUOTA_BURN_PATH}: refreshed ${familyId}/${job.id || 'job'} audit contract`);
      }
    }

    // atomicWrite (temp file + rename), not writeFile: a truncating rewrite
    // interrupted mid-flight leaves a half-written quota-burn.json, and the
    // repaired-JSON path above would then never re-run because the runner has
    // already recorded 305 as applied. The trailing newline matches what the
    // store itself writes, so this never shows as a spurious diff.
    if (updated) await atomicWrite(fullPath, `${JSON.stringify(config, null, 2)}\n`);
    if (skipped) console.log(`✋ ${QUOTA_BURN_PATH}: left ${skipped} custom or already-current prompt(s) untouched`);
    return { updated, skipped };
  },
};
