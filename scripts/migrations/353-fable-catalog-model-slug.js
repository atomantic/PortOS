/**
 * Rename `claude-fable-5-1` to `claude-fable-5.1` in an install's comparison
 * catalog.
 *
 * The Fable 5.1 max-effort row was minted before the dotted slug existed, so a
 * catalog synced from Artificial Analysis carried the model under two names:
 * `claude-fable-5-1` for max and `claude-fable-5.1` for low/medium/high/xhigh.
 * The chart groups its reasoning curve by model, so max plotted as its own
 * one-point series and the curve stopped at xhigh.
 *
 * The observation *id* stays frozen — it is the merge key `importModelComparison`
 * uses, and that merge rejects an id whose identity fields changed (409). So an
 * install still holding the old spelling would fail its next sync against the
 * corrected identity table in `server/services/artificialAnalysis.js`; this
 * rewrites the stored row to match before that can happen.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OLD_MODEL = 'claude-fable-5-1';
const NEW_MODEL = 'claude-fable-5.1';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data/model-comparison.json');
    const raw = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!raw) return { success: true, skipped: 'no catalog' };

    const catalog = JSON.parse(raw);
    if (!Array.isArray(catalog.observations)) return { success: true, skipped: 'no observations' };

    let renamed = 0;
    for (const row of catalog.observations) {
      if (row?.model !== OLD_MODEL) continue;
      row.model = NEW_MODEL;
      renamed += 1;
    }
    if (!renamed) return { success: true, skipped: 'already normalized' };

    await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
    return { success: true, renamed };
  },
};
