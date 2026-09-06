/**
 * Normalize dash-spelled model versions in an install's comparison catalog —
 * `claude-fable-5-1` to `claude-fable-5.1`.
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
import { join } from 'node:path';
import { atomicWrite, readJSONFileStrict } from '../../server/lib/fileUtils.js';
import { canonicalCatalogModelSlug } from '../../server/lib/comparisonModelScope.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data/model-comparison.json');
    // `ok: false` is an unreadable catalog, not an absent one — leave it alone
    // rather than rewriting a file we could not parse.
    const { ok, value: catalog } = await readJSONFileStrict(path, null);
    if (!ok) return { success: true, skipped: 'catalog unreadable' };
    if (!catalog) return { success: true, skipped: 'no catalog' };
    if (!Array.isArray(catalog.observations)) return { success: true, skipped: 'no observations' };

    // Every stored row goes through the same normalizer the sync now mints
    // with, so a legacy spelling any past sync left behind is repaired too and
    // the two can't disagree about what a model is called.
    let renamed = 0;
    for (const row of catalog.observations) {
      const canonical = canonicalCatalogModelSlug(row?.model);
      if (!canonical || canonical === row.model) continue;
      row.model = canonical;
      renamed += 1;
    }
    if (!renamed) return { success: true, skipped: 'already normalized' };

    await atomicWrite(path, catalog);
    return { success: true, renamed };
  },
};
