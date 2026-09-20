/**
 * Ship disabled OpenCode vLLM provider presets to existing installs.
 *
 * The [syv-ai/qwen38-27b-rtx3090](https://github.com/syv-ai/qwen38-27b-rtx3090)
 * stack serves Qwen3.8-27B with DFlash 2 drafting and prefix caching from a
 * patched vLLM container on a single RTX 3090. It is an OpenAI-compatible
 * daemon, so PortOS fronts it exactly the way it fronts MTPLX and llama-server:
 * two OpenCode wrappers — a headless `cli` twin and the attachable `tui` that
 * CoS agent tasks actually run in.
 *
 * No API preset. The container is started behind a `VLLM_API_KEY` the operator
 * generates per install, and a text-only preset would add a third record to
 * paste it into for no capability the two coding harnesses do not already
 * provide.
 *
 * Both presets are DISABLED, and this migration installs nothing: it does not
 * clone the compose project, pull the ~9.5 GB image, download weights, start a
 * container, or contact the endpoint. The stack holds the whole GPU, so an
 * install that also runs local image/video generation must not have it come up
 * on its own. An install that already owns one of these ids is left untouched.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. These frozen literals
 * are the historical upgrade payload; later default changes require a new
 * migration rather than rewriting this record.
 */

import { makeProviderSeedMigration } from './_lib.js';

const ENDPOINT = 'http://127.0.0.1:18020/v1';

const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"vllm":{"npm":"@ai-sdk/openai-compatible","name":"vLLM Qwen3.8-27B (local)","options":{"baseURL":"http://127.0.0.1:18020/v1"}}}}';

const OPENCODE_VLLM_CLI = {
  id: 'opencode-vllm',
  name: 'OpenCode vLLM (Qwen3.8-27B)',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  endpoint: ENDPOINT,
  // Blank, not absent: the operator pastes the compose stack's VLLM_API_KEY
  // here, and the spawner copies it onto the OpenCode provider's
  // `options.apiKey`.
  apiKey: '',
  models: ['qwen3.8-27b'],
  defaultModel: 'qwen3.8-27b',
  vllmBacked: true,
  thinking: false,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  headlessArgs: [],
};

const OPENCODE_VLLM_TUI = {
  id: 'opencode-vllm-tui',
  name: 'OpenCode vLLM TUI (Qwen3.8-27B)',
  type: 'tui',
  command: 'opencode',
  args: [],
  endpoint: ENDPOINT,
  apiKey: '',
  models: ['qwen3.8-27b'],
  defaultModel: 'qwen3.8-27b',
  vllmBacked: true,
  thinking: false,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'OpenCode vLLM (Qwen3.8-27B)',
  defs: [OPENCODE_VLLM_CLI, OPENCODE_VLLM_TUI],
});
