/**
 * Ship the Cerebras API provider to existing installs.
 *
 * Background: issue-2701. Cerebras exposes an OpenAI-compatible chat API
 * (https://api.cerebras.ai/v1) authenticated with a plain API key, so the
 * toolkit's generic `executeApiRun` drives it with no runner changes — the
 * provider is pure configuration. `api.cerebras.ai` is allowlisted in
 * aiToolkit/internal/endpointGuard.js so the key may be attached outbound.
 *
 * `setup-data.js` merges *missing* provider entries from data.reference, but
 * only when an install re-runs setup. This migration delivers the provider on a
 * plain server restart too, and is the canonical path for deployed installs to
 * pick it up. Purely additive: a brand-new id, so there's no rename or
 * pinned-id rewrite — an existing `cerebras` key is left untouched (idempotent),
 * which also preserves a user's stored apiKey and refreshed model list.
 *
 * Seeded with only `gpt-oss-120b`: as of 2026-07-16 it is Cerebras's sole
 * *production* model — the rest of the catalog (`zai-glm-4.7`, `gemma-4-31b`)
 * is flagged preview and documented as removable "on short notice", so pinning
 * a preview id into a shipped seed would strand installs on a dead model. All
 * four tiers therefore point at the one production model (same shape as the
 * grok-cli/grok-tui single-model entries); "Refresh models" repopulates the
 * live list from GET /v1/models once the user adds a key. `enabled: false`
 * keeps the provider inert until then (no cold-bootstrap LLM calls).
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Frozen here as the
 * historical record this migration installs; later default changes ride their
 * own migrations rather than mutating this one.
 */

import { readFile } from 'fs/promises';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

const CEREBRAS_API = {
  id: 'cerebras',
  name: 'Cerebras',
  type: 'api',
  endpoint: 'https://api.cerebras.ai/v1',
  apiKey: '',
  models: ['gpt-oss-120b'],
  defaultModel: 'gpt-oss-120b',
  lightModel: 'gpt-oss-120b',
  mediumModel: 'gpt-oss-120b',
  heavyModel: 'gpt-oss-120b',
  fallbackProvider: null,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds Cerebras from data.reference)`);
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

    if (config.providers[CEREBRAS_API.id]) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: Cerebras provider already present — no change`);
      return;
    }

    // structuredClone fully detaches the frozen shipped def (nested arrays/
    // objects included) so a later mutation of the install can't corrupt it.
    config.providers[CEREBRAS_API.id] = structuredClone(CEREBRAS_API);
    console.log(`📝 ${PROVIDERS_REL_PATH}: added ${CEREBRAS_API.id} provider`);
    await atomicWrite(providersPath, `${JSON.stringify(config, null, 2)}\n`);
  },
};
