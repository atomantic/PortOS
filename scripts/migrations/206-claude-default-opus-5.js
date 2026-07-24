/**
 * Bump the Claude CLI/TUI (+ Bedrock) provider defaults from the
 * `claude-opus-4-8` opus tier to `claude-opus-5`.
 *
 * The prior seeded shape (from migration 153 / the data.reference + scaffold
 * + aiToolkit defaults) used `claude-opus-4-8` as the opus tier:
 *   claude-code / claude-code-tui
 *     models:  ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8']
 *     default/heavy: 'claude-opus-4-8'
 *   claude-code-bedrock / claude-code-tui-bedrock
 *     models:  ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-5',
 *               'global.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8[1m]']
 *     default/heavy: 'global.anthropic.claude-opus-4-8[1m]'
 *
 * The new default swaps the opus tier to `claude-opus-5` (bedrock:
 * `global.anthropic.claude-opus-5`). The Bedrock `[1m]` long-context variant is
 * kept and mapped like-for-like — a user pinned to `…opus-4-8[1m]` lands on
 * `…opus-5[1m]`, and one pinned to the plain id lands on the plain id — so the
 * migration never silently changes which context tier a Bedrock box requests.
 *
 * Existing installs only pick this up if a migration rewrites their
 * providers.json — `setup-data.js` merges *missing* provider entries but never
 * updates existing ones.
 *
 * Conservative, matching migration 058/153's policy:
 *   - Only rewrite `models` when it matches the prior seeded trio/quartet
 *     EXACTLY (order-sensitive). A user who curated their own list is left
 *     alone.
 *   - When a rewrite happens, swap every retired opus id → its replacement
 *     wherever it appears (models array + any tier pointer). Tier pointers at
 *     still-current models (haiku, sonnet) are preserved.
 *   - Also handle the "already-new-models but stale opus-4-8 pointer" case:
 *     an install whose models already list opus-5 (fresh seed via the opus-5
 *     data.reference) but still has a tier pointer left on the now-absent
 *     opus-4-8 gets that orphan pointer repaired.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

const POINTER_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];

// Retired opus id → its replacement. Bedrock maps like-for-like so the `[1m]`
// long-context pin survives the bump instead of silently dropping to the
// standard-context id (or vice versa).
const BARE_SPEC = {
  oldModels: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'],
  opusMap: { 'claude-opus-4-8': 'claude-opus-5' },
};
const BEDROCK_SPEC = {
  oldModels: [
    'us.anthropic.claude-haiku-4-5',
    'us.anthropic.claude-sonnet-5',
    'global.anthropic.claude-opus-4-8',
    'global.anthropic.claude-opus-4-8[1m]',
  ],
  opusMap: {
    'global.anthropic.claude-opus-4-8': 'global.anthropic.claude-opus-5',
    'global.anthropic.claude-opus-4-8[1m]': 'global.anthropic.claude-opus-5[1m]',
  },
};

// The four seeded provider ids and which spec each follows. The bedrock TUI/CLI
// pair and the bare TUI/CLI pair each ship identical model lists.
const TARGETS = {
  'claude-code': BARE_SPEC,
  'claude-code-tui': BARE_SPEC,
  'claude-code-bedrock': BEDROCK_SPEC,
  'claude-code-tui-bedrock': BEDROCK_SPEC,
};

// The post-bump `models` array is fully derived from the prior seeded list plus
// the id map, so the two can't drift apart in this file.
const newModelsFor = (spec) => spec.oldModels.map((m) => spec.opusMap[m] ?? m);

// Order-sensitive equality. Reordering the seeded list is treated as
// customization (skipped) — mirrors migration 058/153's "left alone" promise.
const sameArray = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
};

// Swap any pointer that still references a retired opus id to its mapped
// replacement. Pointers at still-current models (haiku, sonnet) are untouched.
// Mutates in place; returns true if any pointer changed.
const swapOpusPointers = (provider, opusMap) => {
  let changed = false;
  for (const key of POINTER_KEYS) {
    // `Object.hasOwn` before the lookup: a bare `opusMap[provider[key]]` would
    // inherit an Object.prototype member for a pointer literally named
    // `constructor`/`toString`. Unreachable via the UI or any seed, but the
    // guard costs nothing and keeps the map lookup honest.
    const mapped = Object.hasOwn(opusMap, provider[key]) ? opusMap[provider[key]] : null;
    if (mapped) {
      provider[key] = mapped;
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

    for (const [id, spec] of Object.entries(TARGETS)) {
      const provider = providers[id];
      if (!provider) continue;

      const newModels = newModelsFor(spec);

      if (sameArray(provider.models, spec.oldModels)) {
        // Legacy opus-4-8 list → rewrite models + swap opus pointers.
        provider.models = newModels;
        swapOpusPointers(provider, spec.opusMap);
        touched.push({ id, defaultModel: provider.defaultModel });
        continue;
      }

      if (sameArray(provider.models, newModels)) {
        // Models already current — only act if a tier pointer is still
        // orphaned at a now-absent opus-4-8 id.
        if (swapOpusPointers(provider, spec.opusMap)) {
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
    console.log(`📝 ${PROVIDERS_REL_PATH}: updated ${summary} → opus tier claude-opus-5`);
  },
};
