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

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

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

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds Kimi from data.reference)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    if (!config || typeof config !== 'object' || !config.providers || typeof config.providers !== 'object') {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: unexpected shape, skipping`);
      return;
    }

    const providers = config.providers;
    let changed = false;

    for (const def of [KIMI_CLI, KIMI_TUI]) {
      if (!providers[def.id]) {
        // structuredClone fully detaches the frozen shipped def (nested arrays/
        // objects included) so a later mutation of the install can't corrupt it.
        providers[def.id] = structuredClone(def);
        changed = true;
        console.log(`📝 ${PROVIDERS_REL_PATH}: added ${def.id} provider`);
      }
    }

    if (changed) {
      await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    } else {
      console.log(`✅ ${PROVIDERS_REL_PATH}: Kimi providers already present — no change`);
    }
  },
};
