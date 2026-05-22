/**
 * Update Claude CLI/TUI provider defaults to the current model lineup.
 *
 * The previously-seeded model list for `claude-code` and `claude-code-tui`
 * pinned dated identifiers (`claude-haiku-4-5-20251001`,
 * `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101`, `claude-opus-4-6`).
 * The current default is the undated trio (`claude-haiku-4-5`,
 * `claude-sonnet-4-6`, `claude-opus-4-7`) with `claude-opus-4-7` as the
 * defaultModel. Existing installs only pick this up if a migration rewrites
 * their providers.json — `setup-data.js` merges *missing* provider entries
 * but never updates existing ones.
 *
 * Conservative: only rewrites a provider when its `models` array is the
 * exact list this migration knows how to retire. A user who curated their
 * own model list (added a private endpoint, dropped sonnet, etc.) is left
 * alone. The tier pointers (`defaultModel`/`lightModel`/`mediumModel`/
 * `heavyModel`) are upgraded *only* when both the list-shape match holds
 * AND the current pointer is one of the retired ids — so a user who
 * matched the list but hand-pinned a model we no longer ship still keeps
 * their pin.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

const PRIOR_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
];
const NEW_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];

const TIER_REWRITES = {
  defaultModel: { from: ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6'], to: 'claude-opus-4-7' },
  lightModel:   { from: ['claude-haiku-4-5-20251001'], to: 'claude-haiku-4-5' },
  mediumModel:  { from: ['claude-sonnet-4-5-20250929'], to: 'claude-sonnet-4-6' },
  heavyModel:   { from: ['claude-opus-4-6', 'claude-opus-4-5-20251101'], to: 'claude-opus-4-7' },
};

const TARGET_IDS = ['claude-code', 'claude-code-tui'];

const sameMembers = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
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

      if (sameMembers(provider.models, NEW_MODELS)) {
        alreadyCurrent.push(id);
        continue;
      }
      if (!sameMembers(provider.models, PRIOR_MODELS)) {
        customized.push(id);
        continue;
      }

      provider.models = [...NEW_MODELS];
      for (const [key, { from, to }] of Object.entries(TIER_REWRITES)) {
        if (from.includes(provider[key])) {
          provider[key] = to;
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
