/**
 * Ship the "Claude Ollama" provider pair (CLI + TUI) to existing installs, and
 * rename the earlier "Clawed Ollama" sample to "Claude Ollama".
 *
 * Background: issue-1776 (commit b2c0a4931) added a `clawed-ollama` sample —
 * a `claude` CLI pre-wired to a local Ollama daemon so api-only users can run
 * file-writing CoS agent tasks on a local model. But it was added ONLY to the
 * aiToolkit sample file, never to `data.reference/providers.json`, so the
 * `setup-data.js` merge (which only knows about data.reference) never delivered
 * it on `./update.sh` — existing installs never saw it. The name was also a pun
 * users found confusing; the canonical name is now "Claude Ollama".
 *
 * This migration:
 *   1. Promotes an existing `clawed-ollama` provider to `claude-ollama`,
 *      preserving the user's customizations (enabled flag, refreshed model
 *      list, edited envVars, etc.). The user's config wins even if the fresh
 *      `claude-ollama` default was already merged in by setup-data this run.
 *      Default-name "Clawed Ollama (local model)" → "Claude Ollama (local model)".
 *   2. Rewrites `activeProvider` + any `fallbackProvider` references pointing at
 *      the retired `clawed-ollama` id.
 *   3. Adds the shipped `claude-ollama` (cli) and `claude-ollama-tui` (tui)
 *      providers when missing — so a plain server restart delivers them even
 *      without a setup-data merge, and so installs that never had clawed get
 *      both variants. Idempotent: existing keys are left untouched.
 *
 * `setup-data.js` merges *missing* provider entries but never renames or updates
 * existing ones, so deployed installs need this migration to pick up the rename.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

const OLD_ID = 'clawed-ollama';
const NEW_ID = 'claude-ollama';
const TUI_ID = 'claude-ollama-tui';

const OLD_DEFAULT_NAME = 'Clawed Ollama (local model)';
const NEW_DEFAULT_NAME = 'Claude Ollama (local model)';

// Shipped definitions — kept in lockstep with data.reference/providers.json and
// server/lib/aiToolkit/defaults/providers.sample.json. Frozen here as the
// historical record this migration installs; later default changes ride their
// own migrations rather than mutating this one.
const CLAUDE_OLLAMA_CLI = {
  id: NEW_ID,
  name: NEW_DEFAULT_NAME,
  type: 'cli',
  command: 'claude',
  args: ['--print'],
  models: [],
  defaultModel: null,
  ollamaBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: {
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_SMALL_FAST_MODEL: 'qwen2.5:7b',
  },
  secretEnvVars: [],
  headlessArgs: ['--no-session-persistence', '--disable-slash-commands', '--tools', ''],
};

const CLAUDE_OLLAMA_TUI = {
  id: TUI_ID,
  name: 'Claude Ollama TUI (local model)',
  type: 'tui',
  command: 'claude',
  args: ['--dangerously-skip-permissions'],
  models: [],
  defaultModel: null,
  ollamaBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: {
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_SMALL_FAST_MODEL: 'qwen2.5:7b',
  },
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
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds Claude Ollama from data.reference)`);
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

    // 1. Promote an existing clawed-ollama to claude-ollama, preserving the
    //    user's config (it wins over any fresh default merged in this run).
    const clawed = providers[OLD_ID];
    if (clawed) {
      const promoted = { ...clawed, id: NEW_ID };
      if (promoted.name === OLD_DEFAULT_NAME) promoted.name = NEW_DEFAULT_NAME;
      providers[NEW_ID] = promoted;
      delete providers[OLD_ID];

      if (config.activeProvider === OLD_ID) config.activeProvider = NEW_ID;
      for (const p of Object.values(providers)) {
        if (p && p.fallbackProvider === OLD_ID) p.fallbackProvider = NEW_ID;
      }
      changed = true;
      console.log(`📝 ${PROVIDERS_REL_PATH}: renamed ${OLD_ID} → ${NEW_ID} (preserving your settings)`);
    }

    // 2. Add the shipped CLI + TUI providers when missing (idempotent).
    for (const def of [CLAUDE_OLLAMA_CLI, CLAUDE_OLLAMA_TUI]) {
      if (!providers[def.id]) {
        providers[def.id] = { ...def };
        changed = true;
        console.log(`📝 ${PROVIDERS_REL_PATH}: added ${def.id} provider`);
      }
    }

    if (!changed) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: Claude Ollama providers already present — no change`);
      return;
    }

    await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
  },
};
