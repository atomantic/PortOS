/**
 * Ship disabled NVIDIA NIM API and OpenCode presets to existing installs.
 *
 * NVIDIA NIM (`https://integrate.api.nvidia.com/v1`) is an OpenAI-compatible
 * hosted gateway, the third row of `server/lib/providerGateways.js` after
 * OrcaRouter and OpenRouter. The existing `nvidia-kimi` API record stays a
 * Kimi-only catalog on the same host; these three records are the general
 * free-endpoint catalog (currently Gemma 4 31B IT and Laguna XS 2.1) plus the
 * OpenCode CLI/TUI harness wrappers that front it.
 *
 * OpenCode is the optimal coding harness for this backend: it already speaks
 * OpenAI-compatible gateways, prefixes `vendor/model` ids at spawn, and
 * inherits the sibling API key. Direct API covers PortOS text generation
 * without a file harness. This migration is additive and never contacts NIM
 * or changes the active provider.
 *
 * The wrappers carry the generic `gatewayBacked: 'nvidia-nim'` marker rather
 * than a per-gateway boolean — the legacy `orcarouterBacked` shape stays
 * readable forever for records written before the registry existed, but nothing
 * new is written in it.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Later default changes
 * require a new migration.
 */

import { makeProviderSeedMigration } from './_lib.js';

const NIM_ENDPOINT = 'https://integrate.api.nvidia.com/v1';
const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"nvidia-nim":{"npm":"@ai-sdk/openai-compatible","name":"NVIDIA NIM","options":{"baseURL":"https://integrate.api.nvidia.com/v1"}}}}';

const GEMMA = 'google/gemma-4-31b-it';
const LAGUNA = 'poolside/laguna-xs-2.1';
const NIM_MODELS = [GEMMA, LAGUNA];

const NVIDIA_NIM_API = {
  id: 'nvidia-nim',
  name: 'NVIDIA NIM',
  type: 'api',
  endpoint: NIM_ENDPOINT,
  apiKey: '',
  models: NIM_MODELS,
  defaultModel: LAGUNA,
  lightModel: GEMMA,
  mediumModel: LAGUNA,
  heavyModel: LAGUNA,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

const OPENCODE_NVIDIA_NIM_CLI = {
  id: 'opencode-nvidia-nim',
  name: 'OpenCode NVIDIA NIM',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  endpoint: NIM_ENDPOINT,
  models: NIM_MODELS,
  defaultModel: LAGUNA,
  gatewayBacked: 'nvidia-nim',
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  headlessArgs: [],
};

const OPENCODE_NVIDIA_NIM_TUI = {
  id: 'opencode-nvidia-nim-tui',
  name: 'OpenCode NVIDIA NIM TUI',
  type: 'tui',
  command: 'opencode',
  args: [],
  endpoint: NIM_ENDPOINT,
  models: NIM_MODELS,
  defaultModel: LAGUNA,
  gatewayBacked: 'nvidia-nim',
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'NVIDIA NIM',
  defs: [NVIDIA_NIM_API, OPENCODE_NVIDIA_NIM_CLI, OPENCODE_NVIDIA_NIM_TUI],
});
