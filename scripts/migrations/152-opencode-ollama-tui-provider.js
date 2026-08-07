/**
 * Ship the "OpenCode Ollama TUI" provider to existing installs.
 *
 * Background: issue-1814 (follow-up to issue-1802, which shipped only the headless
 * CLI variant via migration 149). The CLI variant completes through the graceful
 * CLI light path; the TUI was held back because the CoS TUI-task completion path
 * assumed slashdo (`/do:pr` / `/do:push`), which OpenCode can't execute. issue-1814
 * makes `buildTuiCompletionSection` provider-aware (a slashdo-free TUI gets a plain
 * `git` / `gh` commit→push→PR→sentinel workflow), so the OpenCode TUI can now
 * complete an automated task — hence shipping the provider here.
 *
 * `setup-data.js` merges *missing* provider entries from data.reference, but only
 * when an install actually re-runs setup. This migration delivers the provider on
 * a plain server restart too, and is the canonical path for deployed installs to
 * pick it up. Purely additive: a brand-new id, so there's no rename or pinned-id
 * rewrite to do. Adds the provider only when missing — idempotent; an existing key
 * is left untouched.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Frozen here as the
 * historical record this migration installs; later default changes ride their own
 * migrations rather than mutating this one.
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
