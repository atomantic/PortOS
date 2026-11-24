/**
 * Upgrade sentinel-only Antigravity tier pins to concrete Gemini 4 Neon /
 * Gemini 3.8 Flash defaults and populate ultraModel when unset, whenever
 * the target models exist in the provider's catalog.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const TARGET_IDS = ['antigravity-cli', 'antigravity-tui'];
const SENTINEL = 'antigravity-configured-default';
const TIER_DEFAULTS = {
  defaultModel: 'gemini-4-neon-medium',
  lightModel: 'gemini-3.8-flash-medium',
  mediumModel: 'gemini-4-neon-medium',
  heavyModel: 'gemini-4-neon-high',
  ultraModel: 'gemini-4-neon-xhigh',
};

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log('📄 data/providers.json not present — skipping (fresh install seeds from data.reference)');
      else console.log(`⚠️ data/providers.json: ${doc.reason}, skipping Antigravity Neon tier upgrade`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    const { config, providers, path } = doc;
    const touched = [];

    for (const id of TARGET_IDS) {
      if (!Object.hasOwn(providers, id)) continue;
      const provider = providers[id];
      if (!provider || !Array.isArray(provider.models)) continue;
      const available = new Set(provider.models);
      let changed = false;

      for (const [field, target] of Object.entries(TIER_DEFAULTS)) {
        if (!available.has(target)) continue;
        const current = provider[field];
        const shouldUpgrade = current === SENTINEL || (field === 'ultraModel' && (current == null || current === ''));
        if (!shouldUpgrade) continue;
        provider[field] = target;
        changed = true;
      }

      if (changed) touched.push(id);
    }

    if (touched.length === 0) {
      console.log('✅ data/providers.json: Antigravity tier pins already current — no change');
      return { ok: true, reason: 'already-current', updated: 0 };
    }

    await writeJsonAtomic(path, config);
    console.log(`📝 data/providers.json: upgraded Antigravity tier pins on ${touched.join(', ')}`);
    return { ok: true, reason: 'updated', updated: touched.length };
  },
};
