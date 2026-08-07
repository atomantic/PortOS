/**
 * Ship the Moonshot AI "Kimi Code" process-provider pair (CLI + TUI) to existing installs.
 *
 * Background: issue-2815. Moonshot AI's Kimi Code (MoonshotAI/kimi-cli, MIT) ships
 * a `kimi` binary that runs as a harness-capable coding agent. PortOS adds two
 * process-provider entries: `kimi-cli` (headless one-shot via `kimi --print`) and
 * `kimi-tui` (interactive PTY). The plain HTTP API entry already exists separately
 * as `nvidia-kimi`. The CLI/TUI argv conventions live in server/lib/kimi.js (kimi
 * reads its prompt as the `--prompt <value>` argv, not raw stdin; `--print` implies
 * `--afk` so headless runs auto-approve).
 *
 * `setup-data.js` merges *missing* provider entries from data.reference, but only
 * when an install re-runs setup. This migration delivers the providers on a plain
 * server restart too, and is the canonical path for deployed installs to pick them
 * up. Purely additive: brand-new ids, so there's no rename or pinned-id rewrite —
 * existing keys are left untouched (idempotent).
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Frozen here as the
 * historical record this migration installs; later default changes ride their own
 * migrations rather than mutating this one.
 */

import { makeProviderSeedMigration } from './_lib.js';

const KIMI_CLI = {
  id: 'kimi-cli',
  name: 'Kimi Code CLI',
  type: 'cli',
  command: 'kimi',
  args: ['--print'],
  models: ['kimi-configured-default'],
  defaultModel: 'kimi-configured-default',
  lightModel: 'kimi-configured-default',
  mediumModel: 'kimi-configured-default',
  heavyModel: 'kimi-configured-default',
  contextWindow: 256000,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

const KIMI_TUI = {
  id: 'kimi-tui',
  name: 'Kimi Code TUI',
  type: 'tui',
  command: 'kimi',
  args: ['--yolo'],
  models: ['kimi-configured-default'],
  defaultModel: 'kimi-configured-default',
  lightModel: 'kimi-configured-default',
  mediumModel: 'kimi-configured-default',
  heavyModel: 'kimi-configured-default',
  contextWindow: 256000,
  timeout: 600000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'Kimi',
  defs: [KIMI_CLI, KIMI_TUI],
});
