/**
 * Backfill the OpenCode Ollama providers' inline config with a declared
 * `models` map (issue-2190).
 *
 * Background: the OpenCode Ollama providers (`opencode-ollama`,
 * `opencode-ollama-tui`, shipped by migrations 149/152) declare the Ollama
 * daemon in `OPENCODE_CONFIG_CONTENT` but omit a `models` map. OpenCode
 * (>=1.17) rejects any `--model ollama/<id>` whose `<id>` isn't declared under
 * `provider.ollama.models` ("Model ollama/… is not valid") — so every run
 * silently produced zero output.
 *
 * The primary fix builds `OPENCODE_CONFIG_CONTENT` dynamically at spawn time
 * (`withOpencodeConfigEnv` in `server/lib/providerModels.js`), folding in the
 * provider's configured models + the model being run. This migration keeps the
 * STORED config honest/consistent for installs that already configured models
 * (e.g. a `defaultModel` or a populated `models[]`): it injects the matching
 * `models` map so the persisted config no longer lies about which models are
 * valid. When a provider has no models configured yet, the stored config is
 * left untouched — the dynamic spawn build supplies the map at runtime.
 *
 * Purely a config rewrite; providers, active provider, and every other field
 * stay untouched. Idempotent: re-running with the map already present is a
 * no-op. Frozen historical record — later default changes ride their own
 * migrations rather than mutating this one.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';
const TARGET_IDS = ['opencode-ollama', 'opencode-ollama-tui'];

// Strip a leading `ollama/` namespace so a model id keys the config `models`
// map (which lives under the `ollama` provider — keys are bare ids). Mirrors
// stripOllamaPrefix in server/lib/providerModels.js.
const stripOllamaPrefix = (id) =>
  typeof id === 'string' && id.startsWith('ollama/') ? id.slice('ollama/'.length) : id;

// Collect the unique, prefix-stripped model ids a provider might address.
function collectModelIds(provider) {
  const ids = [...(Array.isArray(provider?.models) ? provider.models : []), provider?.defaultModel]
    .filter((m) => typeof m === 'string' && m.length > 0)
    .map(stripOllamaPrefix)
    .filter((m) => typeof m === 'string' && m.length > 0);
  return [...new Set(ids)];
}

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install builds OpenCode config dynamically at spawn)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    if (!config || typeof config !== 'object' || !config.providers || typeof config.providers !== 'object') {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: unexpected shape, skipping`);
      return;
    }

    let changed = false;

    for (const id of TARGET_IDS) {
      const provider = config.providers[id];
      if (!provider || typeof provider !== 'object') continue;

      const stored = provider.envVars?.OPENCODE_CONFIG_CONTENT;
      if (typeof stored !== 'string' || stored.length === 0) continue;

      const ids = collectModelIds(provider);
      if (ids.length === 0) {
        console.log(`ℹ️ ${PROVIDERS_REL_PATH}: ${id} has no models configured — leaving stored config (dynamic spawn build supplies the map)`);
        continue;
      }

      let cfg;
      try {
        cfg = JSON.parse(stored);
      } catch {
        console.log(`⚠️ ${PROVIDERS_REL_PATH}: ${id} OPENCODE_CONFIG_CONTENT is not valid JSON — skipping`);
        continue;
      }
      if (!cfg || typeof cfg !== 'object') continue;
      if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {};
      if (!cfg.provider.ollama || typeof cfg.provider.ollama !== 'object') {
        cfg.provider.ollama = { npm: '@ai-sdk/openai-compatible', name: 'Ollama (local)', options: { baseURL: 'http://localhost:11434/v1' } };
      }

      const modelsMap = Object.fromEntries(ids.map((m) => [m, { name: m, tool_call: true }]));
      const nextContent = JSON.stringify({ ...cfg, provider: { ...cfg.provider, ollama: { ...cfg.provider.ollama, models: modelsMap } } });

      if (nextContent !== stored) {
        provider.envVars.OPENCODE_CONFIG_CONTENT = nextContent;
        changed = true;
        console.log(`📝 ${PROVIDERS_REL_PATH}: ${id} — declared ${ids.length} model(s) in OPENCODE_CONFIG_CONTENT`);
      }
    }

    if (changed) {
      await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    } else {
      console.log(`✅ ${PROVIDERS_REL_PATH}: OpenCode Ollama config models map already up to date — no change`);
    }
  },
};
