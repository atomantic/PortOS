/**
 * Update Antigravity (agy) CLI and TUI model catalog to include Gemini 3.7 models.
 *
 * Adds gemini-3.7-flash-high, gemini-3.7-flash-medium, gemini-3.7-flash-low to
 * the shipped Antigravity model catalog.
 *
 * Existing installs whose models list matches the prior seeded catalog or is
 * sentinel-only are updated to the new catalog. User-customized model lists are
 * left alone.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const PROVIDERS_REL_PATH = 'data/providers.json';
const TARGET_IDS = ['antigravity-cli', 'antigravity-tui'];
const SENTINEL = 'antigravity-configured-default';

const OLD_MODELS = [
  SENTINEL,
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

const NEW_MODELS = [
  SENTINEL,
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

const sameArray = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds from data.reference with the new defaults)`);
      else if (doc.reason === 'unreadable') console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${doc.err.message})`);
      else console.log(`⚠️ ${PROVIDERS_REL_PATH}: no providers map — skipping`);
      return;
    }

    const { config, providers, path: providersPath } = doc;
    let changed = false;

    for (const id of TARGET_IDS) {
      if (!Object.hasOwn(providers, id)) continue;
      const provider = providers[id];
      if (!provider || typeof provider !== 'object') continue;

      const isSentinelOnly = Array.isArray(provider.models)
        && provider.models.length === 1
        && provider.models[0] === SENTINEL;

      if (sameArray(provider.models, OLD_MODELS) || isSentinelOnly) {
        provider.models = [...NEW_MODELS];
        changed = true;
        console.log(`📝 ${PROVIDERS_REL_PATH}: updated ${id} models with Gemini 3.7 catalog`);
      } else if (sameArray(provider.models, NEW_MODELS)) {
        console.log(`✅ ${PROVIDERS_REL_PATH}: ${id} already has Gemini 3.7 models`);
      } else {
        console.log(`ℹ️ ${PROVIDERS_REL_PATH}: ${id} has custom models list — leaving intact`);
      }
    }

    if (changed) {
      await writeJsonAtomic(providersPath, config);
    }
  },
};
