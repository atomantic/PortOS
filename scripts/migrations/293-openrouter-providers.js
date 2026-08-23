/**
 * Ship disabled OpenRouter API and OpenCode presets to existing installs.
 *
 * OpenRouter is an OpenAI-compatible gateway, the second row of
 * `server/lib/providerGateways.js` after OrcaRouter (migration 278). The API
 * provider owns the key; the OpenCode wrappers keep their static config keyless
 * and resolve the sibling API key only when spawning or refreshing models. This
 * migration is additive and never contacts the gateway or changes the active
 * provider.
 *
 * The wrappers carry the generic `gatewayBacked: 'openrouter'` marker rather
 * than a per-gateway boolean — the legacy `orcarouterBacked` shape stays
 * readable forever for records written before the registry existed, but nothing
 * new is written in it.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Later default changes
 * require a new migration.
 */

import { makeProviderSeedMigration } from './_lib.js';

const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"openrouter":{"npm":"@ai-sdk/openai-compatible","name":"OpenRouter","options":{"baseURL":"https://openrouter.ai/api/v1"}}}}';

// OpenRouter's own auto-router. Namespaced for OpenCode it becomes
// `openrouter/openrouter/auto` — see `prefixOpencodeModel` on why the doubling
// is correct and why a single-prefix guard would break exactly this id.
const AUTO_MODEL = 'openrouter/auto';

const OPENROUTER_API = {
  id: 'openrouter',
  name: 'OpenRouter',
  type: 'api',
  endpoint: 'https://openrouter.ai/api/v1',
  apiKey: '',
  models: [AUTO_MODEL],
  defaultModel: AUTO_MODEL,
  lightModel: AUTO_MODEL,
  mediumModel: AUTO_MODEL,
  heavyModel: AUTO_MODEL,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

const OPENCODE_OPENROUTER_CLI = {
  id: 'opencode-openrouter',
  name: 'OpenCode OpenRouter',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  endpoint: 'https://openrouter.ai/api/v1',
  models: [AUTO_MODEL],
  defaultModel: AUTO_MODEL,
  gatewayBacked: 'openrouter',
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  headlessArgs: [],
};

const OPENCODE_OPENROUTER_TUI = {
  id: 'opencode-openrouter-tui',
  name: 'OpenCode OpenRouter TUI',
  type: 'tui',
  command: 'opencode',
  args: [],
  endpoint: 'https://openrouter.ai/api/v1',
  models: [AUTO_MODEL],
  defaultModel: AUTO_MODEL,
  gatewayBacked: 'openrouter',
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'OpenRouter',
  defs: [OPENROUTER_API, OPENCODE_OPENROUTER_CLI, OPENCODE_OPENROUTER_TUI],
});
