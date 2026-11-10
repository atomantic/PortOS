/**
 * Add Claude Fable 5.2 to the Claude Code CLI/TUI model lists.
 *
 * `setup-data.js` never updates existing provider records, so installs keep
 * their prior list until this runs. Insert `claude-fable-5-2` ahead of
 * `claude-fable-5-1` (or after `claude-opus-5-5` when 5.1 is absent) without
 * disturbing user curation, and move `ultraModel` only when it is still the
 * shipped Fable 5.1 default.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const TARGET_IDS = ['claude-code', 'claude-code-tui'];
const NEW_ID = 'claude-fable-5-2';
const PREVIOUS_ULTRA = 'claude-fable-5-1';

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log('📄 data/providers.json not present — skipping (fresh install seeds catalog from data.reference)');
      else console.warn(`⚠️ data/providers.json: ${doc.reason}, skipping Fable 5.2 add`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    const { config, providers, path } = doc;
    const touched = [];
    for (const id of TARGET_IDS) {
      const provider = providers[id];
      if (!provider || !Array.isArray(provider.models)) continue;
      let changed = false;
      if (!provider.models.includes(NEW_ID)) {
        const fable51 = provider.models.indexOf(PREVIOUS_ULTRA);
        const opus55 = provider.models.indexOf('claude-opus-5-5');
        const at = fable51 !== -1 ? fable51 : opus55 !== -1 ? opus55 + 1 : 0;
        provider.models.splice(at, 0, NEW_ID);
        changed = true;
      }
      if (provider.ultraModel === PREVIOUS_ULTRA) {
        provider.ultraModel = NEW_ID;
        changed = true;
      }
      if (changed) touched.push(id);
    }

    if (touched.length === 0) {
      console.log('✅ data/providers.json: Claude Fable 5.2 already present — no change');
      return { ok: true, reason: 'already-current', updated: 0 };
    }
    await writeJsonAtomic(path, config);
    console.log(`📝 data/providers.json: added Claude Fable 5.2 to ${touched.join(', ')}`);
    return { ok: true, reason: 'updated', updated: touched.length };
  },
};
