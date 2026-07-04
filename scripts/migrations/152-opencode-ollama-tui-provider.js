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

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

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

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds OpenCode Ollama TUI from data.reference)`);
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

    for (const def of [OPENCODE_OLLAMA_TUI]) {
      if (!providers[def.id]) {
        providers[def.id] = { ...def, envVars: { ...def.envVars } };
        changed = true;
        console.log(`📝 ${PROVIDERS_REL_PATH}: added ${def.id} provider`);
      }
    }

    if (changed) {
      await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    } else {
      console.log(`✅ ${PROVIDERS_REL_PATH}: OpenCode Ollama TUI provider already present — no change`);
    }
  },
};
