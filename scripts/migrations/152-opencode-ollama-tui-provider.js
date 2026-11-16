/**
 * Ship the "OpenCode Ollama TUI" provider to existing installs (issue-1814, follow-up to issue-1802 / migration 149, which shipped only the headless CLI variant).
 *
 * The TUI was held back because the CoS TUI-task completion path assumed slashdo (`/do:pr` / `/do:push`), which OpenCode can't execute; issue-1814 made `buildTuiCompletionSection` provider-aware (a slashdo-free TUI gets a plain `git` / `gh` commit→push→PR→sentinel workflow), so it can now complete an automated task.
 * `setup-data.js` merges missing providers only when an install re-runs setup; this delivers the provider on a plain server restart too. Purely additive (a brand-new id), idempotent, an existing key is left untouched.
 * Kept in lockstep with data.reference/providers.json and server/lib/aiToolkit/defaults/providers.sample.json; frozen here as the historical record, later default changes ride their own migrations.
 */

import { makeProviderSeedMigration } from './_lib.js';

// Inline OpenCode config: declare the local Ollama daemon as an openai-compatible
// provider and auto-approve tools (the OpenCode equivalent of claude's
// --dangerously-skip-permissions — appropriate for PortOS's single-user trusted
// box). Identical to the CLI variant's config (migration 149) — the TUI and CLI
// providers point at the same daemon. OPENCODE_CONFIG_CONTENT has the highest
// config precedence in OpenCode.
const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"ollama":{"npm":"@ai-sdk/openai-compatible","name":"Ollama (local)","options":{"baseURL":"http://localhost:11434/v1"}}}}';

const OPENCODE_OLLAMA_TUI = {
  id: 'opencode-ollama-tui',
  name: 'OpenCode Ollama TUI (local model)',
  type: 'tui',
  command: 'opencode',
  // The TUI spawner appends `--model ollama/<id>`; no `run` subcommand and no
  // permission flag (OPENCODE_CONFIG_CONTENT already sets permission:"allow").
  args: [],
  models: [],
  defaultModel: null,
  ollamaBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'OpenCode Ollama TUI',
  defs: [OPENCODE_OLLAMA_TUI],
});
