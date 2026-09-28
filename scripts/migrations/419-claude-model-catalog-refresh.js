/**
 * Refresh Claude Code CLI/TUI model list with the latest fetched Claude model catalog.
 *
 * `setup-data.js` merges missing provider entries but never updates existing
 * ones, so an install keeps its prior model list until this runs.
 *
 * Policy:
 *   - Move `models` to the refreshed 11-model catalog when the record's
 *     `models` still matches a prior shipped list exactly.
 *   - Update `lightModel` from `claude-haiku-4-5` to `claude-haiku-4-5-20251001`
 *     on shipped records.
 *   - On curated lists, additively insert missing current models (like
 *     `claude-sonnet-5-5`) without disturbing existing pins.
 *
 * Bedrock records are out of scope: they use regional AWS Bedrock model IDs.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const TARGET_IDS = ['claude-code', 'claude-code-tui'];

export const SHIPPED_NEW = [
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
];

export const SHIPPED_PREVIOUS = [
  ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5'],
  ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
];

const sameArray = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log('📄 data/providers.json not present — skipping (fresh install seeds catalog from data.reference)');
      else console.warn(`⚠️ data/providers.json: ${doc.reason}, skipping Claude model refresh`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    const { config, providers, path } = doc;
    const touched = [];
    for (const id of TARGET_IDS) {
      const provider = providers[id];
      if (!provider || !Array.isArray(provider.models)) continue;
      if (sameArray(provider.models, SHIPPED_NEW)) continue;

      const isShipped = SHIPPED_PREVIOUS.some((prev) => sameArray(provider.models, prev));
      let changed = false;

      if (isShipped) {
        provider.models = [...SHIPPED_NEW];
        if (provider.lightModel === 'claude-haiku-4-5') {
          provider.lightModel = 'claude-haiku-4-5-20251001';
        }
        changed = true;
      } else {
        // Curated list: additively insert missing current models (e.g. claude-sonnet-5-5)
        if (!provider.models.includes('claude-sonnet-5-5')) {
          const at = provider.models.indexOf('claude-sonnet-5');
          if (at !== -1) {
            provider.models.splice(at, 0, 'claude-sonnet-5-5');
          } else {
            provider.models.push('claude-sonnet-5-5');
          }
          changed = true;
        }
      }
      if (changed) touched.push(id);
    }

    if (touched.length === 0) {
      console.log('✅ data/providers.json: Claude Code model set already current — no change');
      return { ok: true, reason: 'already-current', updated: 0 };
    }
    await writeJsonAtomic(path, config);
    console.log(`📝 data/providers.json: refreshed ${touched.join(', ')} models`);
    return { ok: true, reason: 'updated', updated: touched.length };
  },
};
