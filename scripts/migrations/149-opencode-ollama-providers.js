/**
 * Ship the "OpenCode Ollama" CLI provider to existing installs (issue-1802).
 *
 * Anthropic-format tool-calling (what the `claude` CLI expects) is a poor fit for Ollama models trained on the OpenAI tool schema (they emit JSON tool-call text the harness never executes, so a Claude-Ollama agent silently fails to edit files); OpenCode speaks the OpenAI-compatible protocol natively, so this provider runs `opencode run` against a local Ollama daemon (declared inline via OPENCODE_CONFIG_CONTENT).
 * Only the headless CLI variant ships: the interactive TUI path drives the slashdo `/do:pr` / `/do:push` handoff OpenCode can't execute (deferred to a follow-up).
 *
 * `setup-data.js` merges missing providers only when an install re-runs setup; this delivers the provider on a plain server restart too. Purely additive (a brand-new id, no rename like migration 146), idempotent, an existing key is left untouched.
 * Kept in lockstep with data.reference/providers.json and server/lib/aiToolkit/defaults/providers.sample.json; frozen here as the historical record, later default changes ride their own migrations.
 */

import { makeProviderSeedMigration } from './_lib.js';

// Inline OpenCode config: declare the local Ollama daemon as an
// openai-compatible provider and auto-approve tools (the OpenCode equivalent of
// claude's --dangerously-skip-permissions — appropriate for PortOS's single-user
// trusted box). Stored as a single env-var string; OPENCODE_CONFIG_CONTENT has
// the highest config precedence in OpenCode.
const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"ollama":{"npm":"@ai-sdk/openai-compatible","name":"Ollama (local)","options":{"baseURL":"http://localhost:11434/v1"}}}}';

const OPENCODE_OLLAMA_CLI = {
  id: 'opencode-ollama',
  name: 'OpenCode Ollama (local model)',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  models: [],
  defaultModel: null,
  ollamaBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  headlessArgs: [],
};

export default makeProviderSeedMigration({
  label: 'OpenCode Ollama',
  defs: [OPENCODE_OLLAMA_CLI],
});
