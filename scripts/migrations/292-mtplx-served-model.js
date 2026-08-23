/**
 * Align the shipped MTPLX provider presets with the model id emitted by the
 * managed MTPLX server.
 *
 * MTPLX serves one checkpoint under its generated model id. The old provider
 * seed used the friendly alias `mtplx`, which made readiness report a mismatch
 * and caused OpenCode to request a model the endpoint did not advertise. Only
 * the untouched sentinel configuration is migrated; a user who selected a
 * different checkpoint or model list keeps that choice.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const OLD_MODEL = 'mtplx';
const NEW_MODEL = 'mtplx-qwen38-27b-optimized-speed';
const PROVIDER_IDS = ['mtplx', 'opencode-mtplx', 'opencode-mtplx-tui'];

const isUntouchedSentinel = (provider) =>
  Array.isArray(provider?.models)
  && provider.models.length === 1
  && provider.models[0] === OLD_MODEL
  && provider.defaultModel === OLD_MODEL;

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) return { ok: false, reason: doc.reason, updated: 0 };

    let updated = 0;
    for (const id of PROVIDER_IDS) {
      const provider = doc.providers[id];
      if (!isUntouchedSentinel(provider)) continue;
      provider.models = [NEW_MODEL];
      provider.defaultModel = NEW_MODEL;
      updated += 1;
    }

    if (!updated) return { ok: true, reason: 'already-current-or-custom', updated: 0 };
    await writeJsonAtomic(doc.path, doc.config);
    console.log(`📝 ${doc.path}: aligned ${updated} MTPLX provider model preset${updated === 1 ? '' : 's'} with the served model`);
    return { ok: true, reason: 'updated', updated };
  },
};
