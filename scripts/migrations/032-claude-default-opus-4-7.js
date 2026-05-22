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
 * reordered the list, etc.) is left alone.
 *
 * Tier-pointer policy when a rewrite does happen:
 *   - `defaultModel`: if it's one of the previously *seeded* defaults
 *     (`claude-opus-4-6` from data.sample, `claude-sonnet-4-5-20250929`
 *     from the scaffold route), upgrade to the policy default
 *     `claude-opus-4-7`. If it's some *other* retired id (a user pinned
 *     haiku-/opus-4-5-dated as default), fall back to the per-model
 *     successor — preserving their tier intent (e.g. keep a haiku pin
 *     small/fast as `claude-haiku-4-5`). A pin to a still-current model
 *     (e.g. `claude-sonnet-4-6`) is always preserved.
 *   - `lightModel`/`mediumModel`/`heavyModel`: use the per-model successor
 *     map (haiku→haiku, sonnet→sonnet, opus→opus). Still-current pins
 *     are preserved.
 *
 * There's a third "seeded" shape — the aiToolkit fallback defaults that
 * shipped before this PR also had the new-trio `models` list but kept
 * `defaultModel: claude-sonnet-4-6` (with the canonical aiToolkit tier
 * fingerprint light=haiku-4-5 / medium=sonnet-4-6 / heavy=opus-4-7). An
 * install that picked up that shape would look "already current" by
 * `models` alone but still have the old default. We detect that exact
 * fingerprint and upgrade just `defaultModel` to `claude-opus-4-7`. A
 * user who hand-pinned `claude-sonnet-4-6` *without* the canonical
 * aiToolkit tier fingerprint is preserved.
 *
 * Because the retired-id map covers every member of every legacy shape, no
 * tier pointer can be left referencing a model that's no longer in
 * `provider.models` after the rewrite (which would otherwise break dropdowns).
 * As a final safety net, any pointer that still doesn't resolve to a member
 * of the new `provider.models` (e.g. a user pinned `defaultModel` to a
 * hand-typed/future/foreign id while the models list happened to match a
 * legacy shape) is reset to its per-tier fallback (light=haiku-4-5,
 * medium=sonnet-4-6, heavy/default=opus-4-7) so tier intent is preserved
 * and the provider stays usable.
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

// Map of every retired Claude model id → its successor in the new trio.
// Used by tier pointers (`lightModel`/`mediumModel`/`heavyModel`) — when a
// pointer references a retired id, it's upgraded to the same-tier successor
// (keeps a haiku-pinned light slot as haiku-4-5, etc.). Pointers at still-
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

// `defaultModel` follows a different policy than the tier pointers: when the
// existing default is one of the previously *seeded* defaults (data.sample's
// `claude-opus-4-6` or scaffold's `claude-sonnet-4-5-20250929`), upgrade to
// the policy default `claude-opus-4-7` — this is the migration's stated
// goal. For any *other* retired-id default (a user who actively pinned
// haiku-/opus-4-5-dated as their default), fall back to the per-model
// successor to preserve their tier intent (keep a haiku pin small/fast).
const SEEDED_DEFAULTS = new Set(['claude-opus-4-6', 'claude-sonnet-4-5-20250929']);
const POLICY_DEFAULT = 'claude-opus-4-7';

// Canonical aiToolkit fallback shape (models = new trio already; only the
// defaultModel is stale at `claude-sonnet-4-6`). Matching the full tier-
// pointer fingerprint avoids false positives on a hand-pinned sonnet-4-6
// — but a user who explicitly set every field to exactly the aiToolkit
// pattern *will* get bumped to opus-4-7. There's no further signal we can
// use to distinguish "I want the aiToolkit defaults" from "I want this
// exact shape", and the PR's stated goal is opus-4-7 across the board, so
// the bump is intentional.
const AITOOLKIT_SEEDED_FINGERPRINT = {
  defaultModel: 'claude-sonnet-4-6',
  lightModel: 'claude-haiku-4-5',
  mediumModel: 'claude-sonnet-4-6',
  heavyModel: 'claude-opus-4-7',
};

// When a pointer can't be resolved (orphan: not retired, not current, not
// in new models), reset to the per-tier default from the new trio. Keeps
// tier intent (a "light" slot stays small/fast even when the original pin
// was foreign). `defaultModel` falls back to POLICY_DEFAULT (opus-4-7).
const TIER_FALLBACK = {
  defaultModel: 'claude-opus-4-7',
  lightModel: 'claude-haiku-4-5',
  mediumModel: 'claude-sonnet-4-6',
  heavyModel: 'claude-opus-4-7',
};

const TIER_POINTER_KEYS = ['lightModel', 'mediumModel', 'heavyModel'];

const matchesAiToolkitSeededShape = (provider) =>
  Object.entries(AITOOLKIT_SEEDED_FINGERPRINT).every(([k, v]) => provider[k] === v);

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
        // Models already current — check for the aiToolkit-seeded shape that
        // shipped the new trio but kept defaultModel at claude-sonnet-4-6.
        if (matchesAiToolkitSeededShape(provider)) {
          provider.defaultModel = POLICY_DEFAULT;
          touched.push({ id, defaultModel: provider.defaultModel });
        } else {
          alreadyCurrent.push(id);
        }
        continue;
      }
      if (!PRIOR_MODELS_SHAPES.some((shape) => sameArray(provider.models, shape))) {
        customized.push(id);
        continue;
      }

      provider.models = [...NEW_MODELS];
      // defaultModel: seeded defaults → policy default; other retired ids → per-model successor.
      if (SEEDED_DEFAULTS.has(provider.defaultModel)) {
        provider.defaultModel = POLICY_DEFAULT;
      } else if (RETIRED_TO_SUCCESSOR[provider.defaultModel]) {
        provider.defaultModel = RETIRED_TO_SUCCESSOR[provider.defaultModel];
      }
      for (const key of TIER_POINTER_KEYS) {
        const successor = RETIRED_TO_SUCCESSOR[provider[key]];
        if (successor) {
          provider[key] = successor;
        }
      }
      // Orphan safety net: if a user customized a pointer to a value not in
      // any of our maps (e.g. a hand-typed id, a model from a different
      // provider, a future model id) and the legacy models list happened to
      // match, the pointer could still reference a model not in NEW_MODELS.
      // UI selectors (e.g. ProviderModelSelector) only render options from
      // provider.models, so an orphan pointer becomes an empty selection.
      // Reset orphans to the per-tier fallback so tier intent is preserved
      // (light slot stays haiku, medium stays sonnet, heavy/default → opus).
      for (const key of ['defaultModel', ...TIER_POINTER_KEYS]) {
        if (provider[key] != null && !provider.models.includes(provider[key])) {
          provider[key] = TIER_FALLBACK[key];
        }
      }
      touched.push({ id, defaultModel: provider.defaultModel });
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
    console.log(`📝 ${PROVIDERS_REL_PATH}: updated ${summary} → models claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-7`);
  },
};
