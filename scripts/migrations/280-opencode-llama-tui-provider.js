/**
 * Ship enabled OpenCode llama TUI provider preset to existing installs.
 *
 * Provides a TUI coding-agent harness for local llama.cpp / llama-server
 * instances, including speculative decoding with DFlash 2.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Later default changes
 * require a new migration.
 */

import { makeProviderSeedMigration } from './_lib.js';

const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"llama":{"npm":"@ai-sdk/openai-compatible","name":"llama.cpp (local)","options":{"baseURL":"http://127.0.0.1:8080/v1"}}}}';

const OPENCODE_LLAMA_TUI = {
  id: 'opencode-llama-tui',
  name: 'OpenCode llama TUI',
  type: 'tui',
  command: 'opencode',
  args: [],
  endpoint: 'http://127.0.0.1:8080/v1',
  models: ['dflash', 'qwen3.8-27b-dflash2', 'Muse-Glimmer-30B-DFlash2'],
  defaultModel: 'dflash',
  llamaBacked: true,
  timeout: 600000,
  enabled: true,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'OpenCode llama TUI',
  defs: [OPENCODE_LLAMA_TUI],
});
