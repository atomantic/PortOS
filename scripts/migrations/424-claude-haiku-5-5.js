/**
 * Add Claude Haiku 5.5 to the Claude Code CLI/TUI model lists.
 *
 * `setup-data.js` never updates existing provider records, so installs keep
 * their prior list until this runs. Insert `claude-haiku-5-5` after
 * `claude-sonnet-5-5` (or at the front when absent) without disturbing user
 * curation, and move `lightModel` only when it is still the shipped Haiku 4.5
 * default.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const TARGET_IDS = ['claude-code', 'claude-code-tui'];
const NEW_ID = 'claude-haiku-5-5';
const PREVIOUS_LIGHT = new Set(['claude-haiku-4-5', 'claude-haiku-4-5-20251001']);

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log('📄 data/providers.json not present — skipping (fresh install seeds catalog from data.reference)');
      else console.warn(`⚠️ data/providers.json: ${doc.reason}, skipping Haiku 5.5 add`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    const { config, providers, path } = doc;
    const touched = [];
    for (const id of TARGET_IDS) {
      const provider = providers[id];
      if (!provider || !Array.isArray(provider.models)) continue;
      let changed = false;
      if (!provider.models.includes(NEW_ID)) {
        const at = provider.models.indexOf('claude-sonnet-5-5');
        provider.models.splice(at === -1 ? 0 : at + 1, 0, NEW_ID);
        changed = true;
      }
      if (PREVIOUS_LIGHT.has(provider.lightModel)) {
        provider.lightModel = NEW_ID;
        changed = true;
      }
      if (changed) touched.push(id);
    }

    if (touched.length === 0) {
      console.log('✅ data/providers.json: Claude Haiku 5.5 already present — no change');
      return { ok: true, reason: 'already-current', updated: 0 };
    }
    await writeJsonAtomic(path, config);
    console.log(`📝 data/providers.json: added Claude Haiku 5.5 to ${touched.join(', ')}`);
    return { ok: true, reason: 'updated', updated: touched.length };
  },
};
