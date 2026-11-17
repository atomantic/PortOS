/**
 * Ship the Cerebras API provider to existing installs (issue-2701).
 *
 * Cerebras exposes an OpenAI-compatible chat API (https://api.cerebras.ai/v1) with a plain API key, so the toolkit's generic `executeApiRun` drives it with no runner changes (pure configuration); `api.cerebras.ai` is allowlisted in aiToolkit/endpointGuard.js so the key may be attached outbound.
 * `setup-data.js` merges missing providers only when an install re-runs setup; this delivers the provider on a plain server restart too. Purely additive (a brand-new id): an existing `cerebras` key is left untouched, preserving a user's stored apiKey and refreshed model list.
 * Seeded with only `gpt-oss-120b`: as of 2026-07-16 it is Cerebras's sole *production* model (the rest, `zai-glm-4.7` and `gemma-4-31b`, are preview and removable "on short notice", so pinning one would strand installs on a dead model). All four tiers point at it (as the grok-cli/grok-tui single-model entries do);
 * "Refresh models" repopulates the live list from GET /v1/models once the user adds a key, and `enabled: false` keeps the provider inert until then (no cold-bootstrap LLM calls).
 * Kept in lockstep with data.reference/providers.json and server/lib/aiToolkit/defaults/providers.sample.json; frozen here as the historical record, later default changes ride their own migrations.
 */

import { makeProviderSeedMigration } from './_lib.js';

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

export default makeProviderSeedMigration({
  label: 'Cerebras',
  defs: [CEREBRAS_API],
});
