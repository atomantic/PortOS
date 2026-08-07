/**
 * Ship the "OpenCode Ollama" CLI provider to existing installs.
 *
 * Background: issue-1802. Anthropic-format tool-calling (what the `claude` CLI
 * expects) is a poor fit for Ollama models trained against the OpenAI tool
 * schema — they emit JSON tool-call text that the harness never executes, so a
 * Claude-Ollama agent "runs" but silently fails to edit files. OpenCode speaks
 * the OpenAI-compatible protocol natively, so the SAME local models reliably
 * apply file changes. This provider runs `opencode run` against a local Ollama
 * daemon (declared inline via OPENCODE_CONFIG_CONTENT) so api-only / local-model
 * users get working headless tool execution.
 *
 * Only the headless CLI variant ships: the interactive TUI completion path drives
 * the slashdo `/do:pr` / `/do:push` handoff that OpenCode can't execute, so a TUI
 * variant is deferred to its own follow-up.
 *
 * `setup-data.js` merges *missing* provider entries from data.reference, but only
 * when an install actually re-runs setup. This migration delivers the provider on
 * a plain server restart too, and is the canonical path for deployed installs to
 * pick it up. Purely additive: a brand-new id, so there's no rename or pinned-id
 * rewrite to do (contrast migration 146, which renamed clawed-ollama). Adds the
 * provider only when missing — idempotent; an existing key is left untouched.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Frozen here as the
 * historical record this migration installs; later default changes ride their
 * own migrations rather than mutating this one.
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
