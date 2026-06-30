/**
 * Bump the Claude CLI/TUI provider defaults from the `claude-sonnet-4-6`
 * medium tier to `claude-sonnet-5`.
 *
 * The prior seeded shape (from migration 058 / the data.reference + scaffold
 * + aiToolkit defaults) used `claude-sonnet-4-6` as the medium model:
 *   claude-code / claude-code-tui
 *     models:       ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8']
 *     mediumModel:  'claude-sonnet-4-6'
 *   claude-code-bedrock / claude-code-tui-bedrock
 *     models:       ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-4-6',
 *                    'global.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8[1m]']
 *     mediumModel:  'us.anthropic.claude-sonnet-4-6'
 *
 * The new default swaps the sonnet tier to `claude-sonnet-5` (bedrock:
 * `us.anthropic.claude-sonnet-5`). Existing installs only pick this up if a
 * migration rewrites their providers.json — `setup-data.js` merges *missing*
 * provider entries but never updates existing ones.
 *
 * Conservative, matching migration 032/058's policy:
 *   - Only rewrite `models` when it matches the prior seeded trio/quartet
 *     EXACTLY (order-sensitive). A user who curated their own list is left
 *     alone.
 *   - When a rewrite happens, swap the old sonnet id → new sonnet id wherever
 *     it appears (models array + any tier pointer). Tier pointers at the other
 *     still-current models (haiku, opus) are preserved.
 *   - Also handle the "already-new-models but stale sonnet-4-6 pointer" case:
 *     an install whose models already list the new sonnet (fresh seed via the
 *     sonnet-5 data.reference) but still has a tier pointer left on the
 *     now-absent sonnet-4-6 gets that orphan pointer repaired.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

const POINTER_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];

// Per-provider migration spec: the retired sonnet id, its replacement, and the
// exact prior-seeded `models` array (only an exact match is rewritten).
const TARGETS = [
  {
    id: 'claude-code',
    oldSonnet: 'claude-sonnet-4-6',
    newSonnet: 'claude-sonnet-5',
    oldModels: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'],
    newModels: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'],
  },
  {
    id: 'claude-code-tui',
    oldSonnet: 'claude-sonnet-4-6',
    newSonnet: 'claude-sonnet-5',
    oldModels: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'],
    newModels: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'],
  },
  {
    id: 'claude-code-bedrock',
    oldSonnet: 'us.anthropic.claude-sonnet-4-6',
    newSonnet: 'us.anthropic.claude-sonnet-5',
    oldModels: ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-4-6', 'global.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8[1m]'],
    newModels: ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-5', 'global.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8[1m]'],
  },
  {
    id: 'claude-code-tui-bedrock',
    oldSonnet: 'us.anthropic.claude-sonnet-4-6',
    newSonnet: 'us.anthropic.claude-sonnet-5',
    oldModels: ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-4-6', 'global.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8[1m]'],
    newModels: ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-5', 'global.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8[1m]'],
  },
];

// Order-sensitive equality. Reordering the seeded list is treated as
// customization (skipped) — mirrors migration 032/058's "left alone" promise.
const sameArray = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
};

// Swap any pointer that still references the retired sonnet id to the new one.
// Pointers at still-current models (haiku, opus) are untouched. Mutates in
// place; returns true if any pointer changed.
const swapSonnetPointers = (provider, oldSonnet, newSonnet) => {
  let changed = false;
  for (const key of POINTER_KEYS) {
    if (provider[key] === oldSonnet) {
      provider[key] = newSonnet;
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

    for (const target of TARGETS) {
      const provider = providers[target.id];
      if (!provider) continue;

      if (sameArray(provider.models, target.oldModels)) {
        // Legacy sonnet-4-6 list → rewrite models + swap sonnet pointers.
        provider.models = [...target.newModels];
        swapSonnetPointers(provider, target.oldSonnet, target.newSonnet);
        touched.push({ id: target.id, mediumModel: provider.mediumModel });
        continue;
      }

      if (sameArray(provider.models, target.newModels)) {
        // Models already current — only act if a tier pointer is still
        // orphaned at the now-absent sonnet-4-6.
        if (swapSonnetPointers(provider, target.oldSonnet, target.newSonnet)) {
          touched.push({ id: target.id, mediumModel: provider.mediumModel });
        } else {
          alreadyCurrent.push(target.id);
        }
        continue;
      }

      customized.push(target.id);
    }

    if (touched.length === 0) {
      const notes = [];
      if (alreadyCurrent.length > 0) notes.push(`already current: ${alreadyCurrent.join(', ')}`);
      if (customized.length > 0) notes.push(`customized: ${customized.join(', ')}`);
      console.log(`✅ ${PROVIDERS_REL_PATH}: no Claude CLI/TUI changes needed${notes.length ? ` (${notes.join('; ')})` : ''}`);
      return;
    }

    await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    const summary = touched.map((t) => `${t.id} (medium: ${t.mediumModel})`).join(', ');
    console.log(`📝 ${PROVIDERS_REL_PATH}: updated ${summary} → sonnet tier claude-sonnet-5`);
  },
};
