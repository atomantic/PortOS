/**
 * Repair `fallbackModel` pins that still name a retired Claude model id.
 *
 * Migrations 058 / 153 / 206 each bumped the seeded Claude model tier and
 * remapped the four tier pointers (`defaultModel`, `lightModel`,
 * `mediumModel`, `heavyModel`) on the four Claude providers. None of them
 * touched `fallbackModel` — and `fallbackModel` is the one pointer that lives
 * on a DIFFERENT provider than the models it names: it is set on the primary
 * (e.g. `codex-tui`) but resolved against that primary's `fallbackProvider`
 * (e.g. `claude-code-tui-bedrock`). So a bump that rewrote the Claude
 * provider's own list left every pin aimed at it dangling:
 *
 *     codex      → claude-code-tui        / claude-opus-4-8          (retired by 206)
 *     codex-tui  → claude-code-tui-bedrock / global.anthropic.claude-opus-4-8
 *
 * A dangling pin is not inert. It is spent at exactly the moment the primary
 * has already failed and the cascade is down to its last deterministic retry
 * (promptRunner Tier 3), where it is baked into the spawned `--model` flag —
 * so the recovery attempt is issued against a model the fallback provider no
 * longer serves.
 *
 * Repair rule — deliberately self-validating, so this can run over a curated
 * config without second-guessing the user. A pin is rewritten only when BOTH:
 *   1. the fallback provider does NOT list the pinned id (it's genuinely dead
 *      there — a pin that still resolves is left exactly as-is, even if it
 *      names an older generation the user chose on purpose), AND
 *   2. the mapped replacement IS listed by that provider (we can name a
 *      concrete working substitute rather than guessing).
 * Anything else is left alone for `usableFallbackModel` to handle at runtime
 * (it drops an unresolvable pin to the provider's own default).
 *
 * Providers with no enumerable `models` list (local backends that discover
 * models at runtime) are skipped by rule 2 — there is nothing to validate
 * against.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

// Retired id → current replacement, across every Claude tier bump that shipped
// without a `fallbackModel` remap. Chains are pre-resolved to their CURRENT
// endpoint (opus-4-7 → opus-4-8 → opus-5 collapses to opus-4-7 → opus-5) so a
// pin left behind by an older bump lands on today's id in one pass.
const RETIRED_MODEL_MAP = {
  // 058 → 206 (opus tier, bare ids)
  'claude-opus-4-7': 'claude-opus-5',
  'claude-opus-4-8': 'claude-opus-5',
  // 206 (opus tier, Bedrock inference profiles — `[1m]` maps like-for-like so
  // a long-context pin never silently drops to standard context)
  'global.anthropic.claude-opus-4-7': 'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-4-7[1m]': 'global.anthropic.claude-opus-5[1m]',
  'global.anthropic.claude-opus-4-8': 'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-4-8[1m]': 'global.anthropic.claude-opus-5[1m]',
  // 153 (sonnet tier)
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'us.anthropic.claude-sonnet-4-6': 'us.anthropic.claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6': 'global.anthropic.claude-sonnet-5',
};

// `Object.hasOwn` before the lookup so a pin literally named `constructor` /
// `toString` can't inherit an Object.prototype member as its "replacement".
const replacementFor = (modelId) => (
  Object.hasOwn(RETIRED_MODEL_MAP, modelId) ? RETIRED_MODEL_MAP[modelId] : null
);

const lists = (provider, modelId) => (
  Array.isArray(provider?.models) && provider.models.includes(modelId)
);

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh installs seed no fallbackModel pins)`);
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

    for (const [id, provider] of Object.entries(providers)) {
      if (!provider || typeof provider !== 'object') continue;
      const pinned = provider.fallbackModel;
      if (!pinned || typeof pinned !== 'string') continue;

      // The pin is resolved against the fallback PROVIDER, not this one — so
      // that is the model list it has to survive.
      const target = providers[provider.fallbackProvider];
      if (!target) continue;

      if (lists(target, pinned)) continue; // still resolves — leave it alone

      const replacement = replacementFor(pinned);
      if (!replacement || !lists(target, replacement)) continue;

      provider.fallbackModel = replacement;
      touched.push({ id, target: provider.fallbackProvider, from: pinned, to: replacement });
    }

    if (touched.length === 0) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: no stale fallbackModel pins`);
      return;
    }

    await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    const summary = touched.map((t) => `${t.id} → ${t.target}: ${t.from} → ${t.to}`).join(', ');
    console.log(`📝 ${PROVIDERS_REL_PATH}: repaired ${touched.length} stale fallbackModel pin(s) — ${summary}`);
  },
};
