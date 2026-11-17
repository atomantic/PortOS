/** Offer GPT-6.2 on existing Codex presets without changing saved tier choices. */
import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const MODELS = ['gpt-6.2-astra', 'gpt-6.2-sol'];

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) return { ok: false, reason: doc.reason, updated: 0 };
    const { config, providers, path } = doc;
    let updated = 0;
    for (const id of ['codex', 'codex-tui']) {
      const provider = providers[id];
      if (!Array.isArray(provider?.models)) continue;
      const missing = MODELS.filter(model => !provider.models.includes(model));
      if (!missing.length) continue;
      provider.models = [...missing, ...provider.models];
      updated++;
    }
    if (updated) await writeJsonAtomic(path, config);
    return { ok: true, reason: updated ? 'updated' : 'already-current', updated };
  },
};
