/**
 * Ship disabled OpenCode LM Studio provider presets to existing installs.
 *
 * LM Studio was the one local backend PortOS already managed (`lmStudioManager.js`,
 * the `lmstudio` API record, its Models → LLMs tab) that no coding harness could
 * be pointed at: the OpenCode wrappers key on a `*Backed` marker, and there was
 * no `lmstudioBacked`. These two presets are what makes the new marker reachable
 * — a headless `cli` twin and the attachable `tui` that CoS agent tasks run in.
 *
 * Both presets are DISABLED and this migration installs nothing: it does not
 * start LM Studio, download a model, or contact the endpoint. `models` ships
 * EMPTY and `defaultModel` null — LM Studio serves whatever the operator has
 * downloaded, so the list is filled by an explicit refresh (the `lmstudio` row
 * in `server/lib/aiToolkit/internal/modelFetchers.js`), never guessed here.
 *
 * No API preset: `lmstudio` already exists as one. And no `numCtx` pin, unlike
 * the Ollama presets — LM Studio fixes a model's context window when the
 * instance is LOADED, so a stored window would be a value nothing reads (see the
 * `lmstudio` row in `server/lib/localProviderRuntime.js` for why PortOS does no
 * pre-spawn preparation for this backend).
 *
 * An install that already owns one of these ids is left untouched, so a user who
 * renamed or disabled the row keeps their record.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. These frozen literals are
 * the historical upgrade payload; later default changes require a new migration
 * rather than rewriting this record.
 */

import { makeProviderSeedMigration } from './_lib.js';

const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"lmstudio":{"npm":"@ai-sdk/openai-compatible","name":"LM Studio (local)","options":{"baseURL":"http://localhost:1234/v1"}}}}';

const OPENCODE_LMSTUDIO_CLI = {
  id: 'opencode-lmstudio',
  name: 'OpenCode LM Studio (local model)',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  models: [],
  defaultModel: null,
  lmstudioBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  headlessArgs: [],
};

const OPENCODE_LMSTUDIO_TUI = {
  id: 'opencode-lmstudio-tui',
  name: 'OpenCode LM Studio TUI (local model)',
  type: 'tui',
  command: 'opencode',
  args: [],
  models: [],
  defaultModel: null,
  lmstudioBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
};

export default makeProviderSeedMigration({
  label: 'OpenCode LM Studio (local model)',
  defs: [OPENCODE_LMSTUDIO_CLI, OPENCODE_LMSTUDIO_TUI],
});
