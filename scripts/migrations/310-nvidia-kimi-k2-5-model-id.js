/**
 * Repair NVIDIA Kimi K2.5's model id.
 *
 * NVIDIA publishes K2.5 as `moonshotai/kimi-k2.5`; the original PortOS seed
 * replaced the dot with a hyphen, so every default/medium-tier request named a
 * resource that does not exist. Replace only that exact invalid id, preserving
 * every other model or tier choice the user may have customized. Fallback pins
 * on other providers are repaired when they explicitly target NVIDIA Kimi.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const PROVIDERS_REL_PATH = 'data/providers.json';
const PROVIDER_ID = 'nvidia-kimi';
const OLD_MODEL = 'moonshotai/kimi-k2-5';
const NEW_MODEL = 'moonshotai/kimi-k2.5';
const MODEL_POINTERS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];

const repairModelList = (provider) => {
  if (!Array.isArray(provider?.models) || !provider.models.includes(OLD_MODEL)) return false;
  provider.models = [...new Set(provider.models.map((model) => model === OLD_MODEL ? NEW_MODEL : model))];
  return true;
};

const repairModelPointers = (provider) => {
  let changed = false;
  for (const field of MODEL_POINTERS) {
    if (provider?.[field] !== OLD_MODEL) continue;
    provider[field] = NEW_MODEL;
    changed = true;
  }
  return changed;
};

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) return { ok: false, reason: doc.reason, updated: 0 };

    let updated = 0;
    const nvidiaKimi = doc.providers[PROVIDER_ID];
    if (nvidiaKimi && typeof nvidiaKimi === 'object') {
      const listChanged = repairModelList(nvidiaKimi);
      const pointersChanged = repairModelPointers(nvidiaKimi);
      if (listChanged || pointersChanged) updated += 1;
    }

    for (const provider of Object.values(doc.providers)) {
      if (!provider || typeof provider !== 'object') continue;
      if (provider.fallbackProvider !== PROVIDER_ID || provider.fallbackModel !== OLD_MODEL) continue;
      provider.fallbackModel = NEW_MODEL;
      updated += 1;
    }

    if (!updated) return { ok: true, reason: 'already-current', updated: 0 };
    await writeJsonAtomic(doc.path, doc.config);
    console.log(`📝 ${PROVIDERS_REL_PATH}: repaired ${updated} NVIDIA Kimi K2.5 model reference${updated === 1 ? '' : 's'}`);
    return { ok: true, reason: 'updated', updated };
  },
};
