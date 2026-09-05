/**
 * Ship the disabled LM Studio harness presets to existing installs.
 *
 * LM Studio was the one local backend PortOS already manages end to end — its
 * own manager, an `lmstudio` API record, a Models → LLMs tab — that no coding
 * harness could be pointed at, because every wrapper resolves its backend from a
 * `*Backed` marker and there was no `lmstudioBacked` (#6309). These three
 * presets are what make the new marker reachable: the OpenCode `cli` twin, the
 * attachable OpenCode `tui` that CoS agent tasks run in, and the Codex wrapper
 * that rides codex's native `--oss --local-provider lmstudio` (migration 346 did
 * the same for Ollama and left this row for the marker).
 *
 * All three are DISABLED and this migration installs nothing: it does not start
 * LM Studio, download a model, or contact the endpoint (AGENTS.md, "No
 * cold-bootstrap LLM calls"). `models` ships EMPTY and `defaultModel` null — LM
 * Studio serves whatever the operator downloaded, so the list is filled by an
 * explicit refresh (the `lmstudio` row in
 * `server/lib/aiToolkit/internal/modelFetchers.js`), never guessed here.
 *
 * No API preset: `lmstudio` already exists as one.
 *
 * Two things about these records are load-bearing:
 *
 *   1. **`numCtx` is a DECLARATION here, not an instruction.** On the Ollama
 *      presets PortOS enforces it by reloading the daemon
 *      (`ensureOllamaAgentContext`). LM Studio fixes a model's window when the
 *      INSTANCE is loaded, and the only lever PortOS holds
 *      (`lmStudioManager.loadModelWithArgs`) unloads whatever the user has
 *      resident and cold-loads the weights again — too costly to pay on every
 *      agent spawn, and it would evict a model the operator loaded in the app.
 *      So the field is still worth pinning, because the prompt budget reads it
 *      (`stageRunner.js`, `providerStatus.js`), but the operator adjusts it to
 *      match the instance they actually loaded rather than PortOS applying it.
 *   2. **`lmstudioBacked: true`, not a codex-specific flag** on the Codex row —
 *      the same axis the OpenCode wrappers ride, so `localRuntimeNamespace` and
 *      `codexOssLocalProvider` pick it up with no new call site.
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

// The window PortOS budgets prompts against, and the one an operator should
// load the LM Studio instance with. Deliberately smaller than the Codex Ollama
// preset's 131072: PortOS cannot reload LM Studio at this window, so the shipped
// number has to be one a default install plausibly already has rather than one
// PortOS would go make true.
const NUM_CTX = 32768;

const OPENCODE_LMSTUDIO_CLI = {
  id: 'opencode-lmstudio',
  name: 'OpenCode LM Studio (local model)',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  models: [],
  defaultModel: null,
  lmstudioBacked: true,
  numCtx: NUM_CTX,
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
  numCtx: NUM_CTX,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
};

const CODEX_LMSTUDIO = {
  id: 'codex-lmstudio',
  name: 'Codex LM Studio (local model)',
  type: 'cli',
  command: 'codex',
  args: [],
  // Codex reaches the daemon through its own `--local-provider lmstudio`
  // resolution, so this endpoint is what PortOS's readiness probe checks, not a
  // value handed to the CLI.
  endpoint: 'http://localhost:1234/v1',
  models: [],
  defaultModel: null,
  lmstudioBacked: true,
  numCtx: NUM_CTX,
  timeout: 600000,
  enabled: false,
  // No `textTransport`: the codex app-server transport is the ChatGPT
  // subscription path, while a local-backed record runs the ordinary
  // `codex exec` argv — which is what carries the `--oss` flags.
  envVars: {},
  secretEnvVars: [],
  headlessArgs: [],
};

export default makeProviderSeedMigration({
  label: 'LM Studio harness wrappers',
  defs: [OPENCODE_LMSTUDIO_CLI, OPENCODE_LMSTUDIO_TUI, CODEX_LMSTUDIO],
});
