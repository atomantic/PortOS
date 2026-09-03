/**
 * Ship disabled OpenCode Zen presets to existing installs.
 *
 * Every shipped OpenCode preset until now fronted something ELSE — a local
 * Ollama/vLLM/SGLang daemon, or a hosted gateway (OrcaRouter, OpenRouter). None
 * of them ran OpenCode on the models OpenCode itself ships with, so an install
 * that had the CLI on PATH still had no provider that used it out of the box.
 *
 * These three close that gap:
 *   - `opencode-zen`     — the OpenCode Zen HTTP API (an OpenAI-compatible
 *                          endpoint), for direct PortOS calls.
 *   - `opencode-zen-cli` — headless `opencode run` on the harness's own catalog.
 *   - `opencode-zen-tui` — the same, driven through the TUI.
 *
 * The two wrappers deliberately carry NO `gatewayBacked` / `*Backed` marker:
 * that absence is what tells `getOpencodeLocalProviderNamespace` there is no
 * custom provider entry to declare, so OpenCode resolves `opencode/*` models
 * through its own built-in provider and its own stored credential. It is also
 * what makes them the targets of the Harnesses page's model refresh — see
 * `usesHarnessCatalog` in `server/services/harnesses.js`.
 *
 * The seeded model list is OpenCode Zen's free tier, so a fresh install has
 * something runnable before any key is stored; Models → Harnesses → Refresh
 * models replaces it with whatever `opencode models` reports for the account
 * actually signed in.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Later default changes
 * require a new migration.
 */

import { makeProviderSeedMigration } from './_lib.js';

// The API record's wire address. The CLI/TUI wrappers deliberately carry NO
// `endpoint`, matching every other harness-native record (`grok-cli`, `codex`,
// `cursor-cli`, `claude-code`): they declare no OpenCode provider entry, so
// nothing would read one, and a field that looks load-bearing and isn't is
// worse than an absent one. Only a gateway-backed wrapper mirrors its
// gateway's `baseURL` there.
const ZEN_ENDPOINT = 'https://opencode.ai/zen/v1';

// The unattended posture every seeded OpenCode record declares. It is the WHOLE
// config for these two: with no namespace there is no provider entry to declare
// and no key to inject, and `buildOpencodeEnvVars` preserves this as the base
// while pinning `small_model` to the model the run was dispatched with.
const OPENCODE_CONFIG_CONTENT = '{"permission":"allow"}';

// The harness's own namespaced spelling — exactly what `opencode models` prints
// and what `opencode --model` takes. These records declare no OpenCode provider
// entry, so nothing prefixes the id at spawn time and it must be stored whole.
const CLI_MODELS = [
  'opencode/big-pickle',
  'opencode/ling-3.0-flash-fin-free',
  'opencode/mimo-v2.5-free',
  'opencode/muse-spark-1.2-contributor-free',
  'opencode/muse-spark-1.3-contributor-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free',
];
const CLI_DEFAULT = 'opencode/big-pickle';

// The HTTP API takes BARE ids — there is no OpenCode namespace on the wire.
const API_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'gpt-5.6-sol',
  'gpt-5.5',
  'grok-4.6',
  'kimi-k3',
  'qwen3.6-plus',
  'big-pickle',
  'deepseek-v4-flash-free',
];

const OPENCODE_ZEN_API = {
  id: 'opencode-zen',
  name: 'OpenCode Zen',
  type: 'api',
  endpoint: ZEN_ENDPOINT,
  apiKey: '',
  models: API_MODELS,
  defaultModel: 'claude-sonnet-5',
  lightModel: 'claude-haiku-4-5',
  mediumModel: 'claude-sonnet-5',
  heavyModel: 'claude-opus-5',
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

const OPENCODE_ZEN_CLI = {
  id: 'opencode-zen-cli',
  name: 'OpenCode Zen CLI',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  models: CLI_MODELS,
  defaultModel: CLI_DEFAULT,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  // Named, not stored: OpenCode holds its own Zen credential after
  // `opencode auth login`, and an install that would rather hand it over
  // explicitly fills this in from the provider editor.
  secretEnvVars: ['OPENCODE_API_KEY'],
  headlessArgs: [],
};

const OPENCODE_ZEN_TUI = {
  id: 'opencode-zen-tui',
  name: 'OpenCode Zen TUI',
  type: 'tui',
  command: 'opencode',
  args: [],
  models: CLI_MODELS,
  defaultModel: CLI_DEFAULT,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: ['OPENCODE_API_KEY'],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'OpenCode Zen',
  defs: [OPENCODE_ZEN_API, OPENCODE_ZEN_CLI, OPENCODE_ZEN_TUI],
});
