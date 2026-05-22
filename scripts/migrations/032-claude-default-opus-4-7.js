/**
 * Update Claude CLI/TUI provider defaults to the current model lineup.
 *
 * Two prior seeded shapes existed for `claude-code` / `claude-code-tui`:
 *   1. The data.sample 4-item dated list — `claude-haiku-4-5-20251001`,
 *      `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101`,
 *      `claude-opus-4-6` (defaultModel: `claude-opus-4-6`).
 *   2. The scaffold-route 3-item dated list — `claude-haiku-4-5-20251001`,
 *      `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101`
 *      (defaultModel: `claude-sonnet-4-5-20250929`).
 *
 * The current default is the undated trio (`claude-haiku-4-5`,
 * `claude-sonnet-4-6`, `claude-opus-4-7`) with `claude-opus-4-7` as the
 * defaultModel. Existing installs only pick this up if a migration rewrites
 * their providers.json — `setup-data.js` merges *missing* provider entries
 * but never updates existing ones.
 *
 * Conservative: only rewrites a provider when its `models` array matches one
 * of the known legacy seeded shapes EXACTLY (order-sensitive). A user who
 * curated their own model list (added a private endpoint, dropped sonnet,
 * reordered the list, etc.) is left alone. The tier pointers
 * (`defaultModel`/`lightModel`/`mediumModel`/`heavyModel`) are upgraded *only*
 * when the current pointer is one of the retired ids — so a user who matched
 * the list but pinned a still-current model (e.g. `claude-sonnet-4-6`) keeps
 * their pin. Because the retired-id map covers every member of every legacy
 * shape, no tier pointer can be left referencing a model that's no longer in
 * `provider.models` after the rewrite (which would otherwise break dropdowns).
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

const PRIOR_MODELS_DATA_SAMPLE = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
];
const PRIOR_MODELS_SCAFFOLD = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
];
const PRIOR_MODELS_SHAPES = [PRIOR_MODELS_DATA_SAMPLE, PRIOR_MODELS_SCAFFOLD];
const NEW_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];

// Map of every retired Claude model id → its successor in the new trio. Any
// tier pointer (`defaultModel`/`lightModel`/`mediumModel`/`heavyModel`) that
// references a retired id gets upgraded to its successor. Pointers at still-
// current ids (e.g. `claude-sonnet-4-6`) are NOT in this map, so a hand-pin
// to a current model is always preserved. Because this covers every retired
// id, no tier pointer can be left referencing a model that's no longer in
// `provider.models` after the rewrite — keeping dropdowns/pickers consistent.
const RETIRED_TO_SUCCESSOR = {
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
  'claude-opus-4-5-20251101': 'claude-opus-4-7',
  'claude-opus-4-6': 'claude-opus-4-7',
};

const TIER_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];

const TARGET_IDS = ['claude-code', 'claude-code-tui'];

// Order-sensitive equality. Reordering the legacy seeded list is treated as
// customization (skipped) — being maximally conservative matches the header
// comment's "left alone" promise and avoids overwriting user intent.
const sameArray = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
};

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds from data.sample with the new defaults)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    const providers = config?.providers;
    if (!providers || typeof providers !== 'object') {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: no providers map — skipping`);
      return;
    }

    const touched = [];
    const alreadyCurrent = [];
    const customized = [];

    for (const id of TARGET_IDS) {
      const provider = providers[id];
      if (!provider) continue;

      if (sameArray(provider.models, NEW_MODELS)) {
        alreadyCurrent.push(id);
        continue;
      }
      if (!PRIOR_MODELS_SHAPES.some((shape) => sameArray(provider.models, shape))) {
        customized.push(id);
        continue;
      }

      provider.models = [...NEW_MODELS];
      for (const key of TIER_KEYS) {
        const successor = RETIRED_TO_SUCCESSOR[provider[key]];
        if (successor) {
          provider[key] = successor;
        }
      }
      touched.push(id);
    }

    if (touched.length === 0) {
      const notes = [];
      if (alreadyCurrent.length > 0) notes.push(`already current: ${alreadyCurrent.join(', ')}`);
      if (customized.length > 0) notes.push(`customized: ${customized.join(', ')}`);
      console.log(`✅ ${PROVIDERS_REL_PATH}: no Claude CLI/TUI changes needed${notes.length ? ` (${notes.join('; ')})` : ''}`);
      return;
    }

    await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`📝 ${PROVIDERS_REL_PATH}: updated ${touched.join(', ')} to claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-7 (default: claude-opus-4-7)`);
  },
};
