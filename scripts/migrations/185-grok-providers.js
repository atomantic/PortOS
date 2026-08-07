/**
 * Ship the xAI "Grok" provider trio (API + Grok Build CLI + TUI) to existing installs.
 *
 * Background: issue-2336. xAI's Grok Build exposes an OpenAI-compatible chat API
 * (https://api.x.ai/v1) plus a terminal coding agent (`grok`). PortOS adds three
 * provider entries: `grok` (api), `grok-cli` (headless one-shot), and `grok-tui`
 * (interactive PTY). The CLI/TUI argv conventions live in server/lib/grok.js
 * (grok reads its prompt from `--prompt-file`, not raw stdin).
 *
 * `setup-data.js` merges *missing* provider entries from data.reference, but only
 * when an install re-runs setup. This migration delivers the providers on a plain
 * server restart too, and is the canonical path for deployed installs to pick
 * them up. Purely additive: brand-new ids, so there's no rename or pinned-id
 * rewrite — existing keys are left untouched (idempotent).
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Frozen here as the
 * historical record this migration installs; later default changes ride their
 * own migrations rather than mutating this one.
 */

import { makeProviderSeedMigration } from './_lib.js';

const GROK_API = {
  id: 'grok',
  name: 'xAI Grok',
  type: 'api',
  endpoint: 'https://api.x.ai/v1',
  apiKey: '',
  models: ['grok-4', 'grok-3', 'grok-3-mini', 'grok-code-fast-1'],
  defaultModel: 'grok-4',
  lightModel: 'grok-3-mini',
  mediumModel: 'grok-3',
  heavyModel: 'grok-4',
  fallbackProvider: null,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

const GROK_CLI = {
  id: 'grok-cli',
  name: 'Grok Build CLI',
  type: 'cli',
  command: 'grok',
  args: [],
  models: ['grok-build'],
  defaultModel: 'grok-build',
  lightModel: 'grok-build',
  mediumModel: 'grok-build',
  heavyModel: 'grok-build',
  contextWindow: 256000,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

const GROK_TUI = {
  id: 'grok-tui',
  name: 'Grok Build TUI',
  type: 'tui',
  command: 'grok',
  args: [],
  models: ['grok-build'],
  defaultModel: 'grok-build',
  lightModel: 'grok-build',
  mediumModel: 'grok-build',
  heavyModel: 'grok-build',
  contextWindow: 256000,
  timeout: 600000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'Grok',
  defs: [GROK_API, GROK_CLI, GROK_TUI],
});
