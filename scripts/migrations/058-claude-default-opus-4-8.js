/**
 * Bump the Claude CLI/TUI provider defaults from the opus-4-7 trio to the
 * opus-4-8 trio.
 *
 * The prior seeded shape (from migration 032 / the data.reference + scaffold
 * + aiToolkit defaults) was the undated trio:
 *   models:       ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7']
 *   defaultModel: 'claude-opus-4-7'
 *   heavyModel:   'claude-opus-4-7'
 *   light/medium: 'claude-haiku-4-5' / 'claude-sonnet-4-6'
 *
 * The new default swaps the opus tier to `claude-opus-4-8`. Existing installs
 * only pick this up if a migration rewrites their providers.json —
 * `setup-data.js` merges *missing* provider entries but never updates
 * existing ones.
 *
 * Conservative, matching migration 032's policy:
 *   - Only rewrite when `models` matches the opus-4-7 trio EXACTLY
 *     (order-sensitive). A user who curated their own list is left alone.
 *   - When a rewrite happens, swap `claude-opus-4-7` → `claude-opus-4-8`
 *     wherever it appears (models array + any tier pointer). Tier pointers
 *     at still-current models (haiku-4-5, sonnet-4-6) are preserved.
 *   - Also handle the "already-new-models but stale opus-4-7 pointer" case:
 *     an install whose models already list opus-4-8 (fresh seed via 4-8
 *     data.reference) but still has a tier pointer left at the now-absent
 *     opus-4-7 gets that orphan pointer repaired to opus-4-8.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

const OLD_OPUS = 'claude-opus-4-7';
const NEW_OPUS = 'claude-opus-4-8';

const OLD_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', OLD_OPUS];
const NEW_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', NEW_OPUS];

const TARGET_IDS = ['claude-code', 'claude-code-tui'];
const POINTER_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];

// Order-sensitive equality. Reordering the seeded list is treated as
// customization (skipped) — mirrors migration 032's "left alone" promise.
const sameArray = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
};

// Swap any pointer that still references the retired opus-4-7 to opus-4-8.
// Pointers at still-current models (haiku-4-5, sonnet-4-6) are untouched.
// Mutates in place; returns true if any pointer changed.
const swapOpusPointers = (provider) => {
  let changed = false;
  for (const key of POINTER_KEYS) {
    if (provider[key] === OLD_OPUS) {
      provider[key] = NEW_OPUS;
      changed = true;
    }
  }
  return changed;
};

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds from data.reference with the new defaults)`);
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

      if (sameArray(provider.models, OLD_MODELS)) {
        // Legacy opus-4-7 trio → rewrite models + swap opus pointers.
        provider.models = [...NEW_MODELS];
        swapOpusPointers(provider);
        touched.push({ id, defaultModel: provider.defaultModel });
        continue;
      }

      if (sameArray(provider.models, NEW_MODELS)) {
        // Models already current — only act if a tier pointer is still
        // orphaned at the now-absent opus-4-7.
        if (swapOpusPointers(provider)) {
          touched.push({ id, defaultModel: provider.defaultModel });
        } else {
          alreadyCurrent.push(id);
        }
        continue;
      }

      customized.push(id);
    }

    if (touched.length === 0) {
      const notes = [];
      if (alreadyCurrent.length > 0) notes.push(`already current: ${alreadyCurrent.join(', ')}`);
      if (customized.length > 0) notes.push(`customized: ${customized.join(', ')}`);
      console.log(`✅ ${PROVIDERS_REL_PATH}: no Claude CLI/TUI changes needed${notes.length ? ` (${notes.join('; ')})` : ''}`);
      return;
    }

    await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    const summary = touched.map((t) => `${t.id} (default: ${t.defaultModel})`).join(', ');
    console.log(`📝 ${PROVIDERS_REL_PATH}: updated ${summary} → models claude-haiku-4-5 / claude-sonnet-4-6 / ${NEW_OPUS}`);
  },
};
