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

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

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

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds Grok from data.reference)`);
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

    for (const def of [GROK_API, GROK_CLI, GROK_TUI]) {
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
      console.log(`✅ ${PROVIDERS_REL_PATH}: Grok providers already present — no change`);
    }
  },
};
