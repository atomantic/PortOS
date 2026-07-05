/**
 * Shared sentinel and helpers for provider model resolution.
 * Mirrors the constants in client/src/utils/providers.js — keep in sync.
 */

export const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';

export const isCodexConfiguredDefault = (model) => model === CODEX_CONFIGURED_DEFAULT;

/**
 * Returns the model string to pass to a CLI's --model flag, or null if the
 * caller should omit --model entirely (Codex sentinel case — the CLI will use
 * whatever model is configured in ~/.codex/config.toml).
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
export const resolveCliModel = (model) => isCodexConfiguredDefault(model) ? null : (model || null);

/**
 * True when a provider command points at the OpenCode binary — matching the bare
 * `opencode` on PATH OR an absolute/relative path to it (`/opt/homebrew/bin/opencode`,
 * common when the service PATH can't resolve the CLI), with an optional Windows `.exe`
 * suffix. The OpenCode arg-builder branches key on this rather than `command === 'opencode'`
 * so a path-configured provider isn't misrouted into the Claude-style invocation. Only
 * `.exe` is stripped (not `.cmd`/`.bat`), matching the runner allowlist and the
 * `shell: false` spawn path — a batch shim isn't directly spawnable.
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isOpencodeCommand(command) {
  if (typeof command !== 'string' || command === '') return false;
  const base = command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  return base === 'opencode';
}

/**
 * OpenCode addresses models as `provider/model` (e.g. `ollama/qwen2.5:7b`). The
 * OpenCode Ollama provider declares its local daemon under the config-provider
 * key `ollama` (via OPENCODE_CONFIG_CONTENT), so the bare Ollama model id stored
 * in `defaultModel` must be namespaced with `ollama/` before it's passed to
 * `opencode run -m` / `opencode --model`. Idempotent — an id that already starts
 * with `ollama/` is returned untouched, and a `/`-bearing Ollama id
 * (`hf.co/user/model:tag`) is namespaced as `ollama/hf.co/...` since OpenCode
 * splits provider/model on the FIRST slash only.
 *
 * Gated on the `ollamaBacked` marker, NOT just `command === 'opencode'`: a
 * user-configured OpenCode provider pointed at a different backend stores an
 * already-qualified id (`openai/gpt-4o`, `anthropic/claude-sonnet`), and blindly
 * prefixing `ollama/` would route it to the wrong backend. No-op for
 * non-Ollama-backed / non-OpenCode providers and empty models.
 * @param {{command?:string, ollamaBacked?:boolean}} provider
 * @param {string|null|undefined} model
 * @returns {string|null|undefined}
 */
export function prefixOpencodeModel(provider, model) {
  if (!isOpencodeCommand(provider?.command) || provider?.ollamaBacked !== true || !model) return model;
  const id = String(model);
  return id.startsWith('ollama/') ? id : `ollama/${id}`;
}

/**
 * Canonical OpenCode config for the local Ollama daemon. Declares Ollama as an
 * openai-compatible provider under the config-provider key `ollama` (matching
 * `prefixOpencodeModel`'s `ollama/` namespace) and auto-approves tools
 * (`permission: "allow"` — the OpenCode equivalent of claude's
 * `--dangerously-skip-permissions`, appropriate for PortOS's single-user
 * trusted box). Used as the base when a provider has no stored
 * `OPENCODE_CONFIG_CONTENT` or it fails to parse. Kept in lockstep with the
 * seeds (`providers.sample.json`, `data.reference/providers.json`) and the
 * provider migrations (149/152/164).
 */
const DEFAULT_OPENCODE_OLLAMA_PROVIDER = {
  npm: '@ai-sdk/openai-compatible',
  name: 'Ollama (local)',
  options: { baseURL: 'http://localhost:11434/v1' },
};

// Strip a leading `ollama/` namespace from a model id so it can key the
// OpenCode config `models` map (which lives UNDER the `ollama` provider, so the
// keys are bare ids). Idempotent for an already-bare id. A `/`-bearing Ollama id
// (`hf.co/user/model:tag`) namespaced as `ollama/hf.co/...` strips back to the
// correct bare key since only the leading namespace is removed.
const stripOllamaPrefix = (id) =>
  typeof id === 'string' && id.startsWith('ollama/') ? id.slice('ollama/'.length) : id;

/**
 * Build the `OPENCODE_CONFIG_CONTENT` value dynamically at spawn time for an
 * OpenCode Ollama provider. The shipped seed declares the Ollama provider but no
 * `models` map, and OpenCode (>=1.17) rejects any `--model ollama/<id>` whose
 * `<id>` isn't declared in `provider.ollama.models` ("Model ollama/… is not
 * valid"). This injects that map from the provider's configured models plus the
 * model actually being run, so the `--model` the spawner passes is always
 * accepted.
 *
 * Pure. Returns `null` for a non-OpenCode command (caller keeps existing env
 * untouched). The base structure is parsed from the provider's stored
 * `OPENCODE_CONFIG_CONTENT` (so a user's custom baseURL/permission survives),
 * falling back to the canonical default when absent or unparseable.
 *
 * @param {{command?:string, models?:string[], defaultModel?:string|null, envVars?:object}} provider
 * @param {string|null} [model] - the model being run this invocation (may differ from defaultModel)
 * @returns {string|null} JSON string for OPENCODE_CONFIG_CONTENT, or null if not an OpenCode provider
 */
export function buildOpencodeConfigContent(provider, model = null) {
  if (!isOpencodeCommand(provider?.command)) return null;

  const stored = provider?.envVars?.OPENCODE_CONFIG_CONTENT;
  let config = null;
  if (typeof stored === 'string' && stored.length > 0) {
    try {
      config = JSON.parse(stored);
    } catch {
      config = null; // fall through to the canonical default below
    }
  }
  if (!config || typeof config !== 'object') {
    config = { permission: 'allow', provider: {} };
  }
  if (!config.provider || typeof config.provider !== 'object') {
    config.provider = {};
  }
  if (!config.provider.ollama || typeof config.provider.ollama !== 'object') {
    config.provider.ollama = { ...DEFAULT_OPENCODE_OLLAMA_PROVIDER };
  }

  // Union of every model this provider might address: its configured list, its
  // default, and the model being run right now. Deduped, prefix-stripped.
  const ids = [...(Array.isArray(provider?.models) ? provider.models : []), provider?.defaultModel, model]
    .filter((m) => typeof m === 'string' && m.length > 0)
    .map(stripOllamaPrefix)
    .filter((m) => typeof m === 'string' && m.length > 0);
  const unique = [...new Set(ids)];

  if (unique.length > 0) {
    config.provider.ollama.models = Object.fromEntries(
      unique.map((id) => [id, { name: id, tool_call: true }]),
    );
  }

  return JSON.stringify(config);
}

/**
 * Return the spawn env vars for a provider, overriding `OPENCODE_CONFIG_CONTENT`
 * with a dynamically-built config (declared models map) for OpenCode Ollama
 * providers. A drop-in replacement for `...provider.envVars` at spawn sites —
 * returns the provider's own envVars unchanged for every non-OpenCode provider.
 *
 * @param {object} provider
 * @param {string|null} [model]
 * @returns {object} env vars object (never undefined)
 */
export function withOpencodeConfigEnv(provider, model = null) {
  const base = provider?.envVars || {};
  const content = buildOpencodeConfigContent(provider, model);
  if (content == null) return base;
  return { ...base, OPENCODE_CONFIG_CONTENT: content };
}

/**
 * Claude Code on AWS Bedrock wants region-prefixed model ids
 * (`global.anthropic.claude-opus-4-8`, `us.anthropic.claude-opus-4-1-...-v1:0`).
 * When `CLAUDE_CODE_USE_BEDROCK` is set on the box, passing a bare
 * `claude --model claude-opus-4-8` is rejected ("provided model identifier is
 * invalid") — which is exactly how a bare-id `claude-code` provider config
 * breaks autopilot/pipeline runs on a Bedrock host. The helpers below map a
 * bare id to its Bedrock form just-in-time at CLI-argv build time; the stored
 * provider config stays bare (so a box can move in/out of Bedrock mode freely).
 */

// Family → the env var Claude Code reads for that tier's resolved model. A
// Bedrock wrapper sets these to the exact region-prefixed id it wants, so when
// present they are preferred over a blind prefix-rewrite.
const BEDROCK_FAMILY_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

/**
 * True when the box is in Claude-Code-on-Bedrock mode. Treats the documented
 * `CLAUDE_CODE_USE_BEDROCK=1` plus the usual truthy spellings as enabled;
 * `0`/`false`/`no`/empty/unset are off.
 */
export const isBedrockEnabled = (env = process.env) => {
  const v = env?.CLAUDE_CODE_USE_BEDROCK;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no';
};

/**
 * True when an id already carries a Bedrock region prefix
 * (`global.anthropic.…`, `us.anthropic.…`, `eu.anthropic.…`, `apac.anthropic.…`)
 * or the bare `anthropic.…` form. Such ids are left untouched.
 */
export const hasBedrockRegionPrefix = (id) =>
  typeof id === 'string' && (/^[a-z]+\.anthropic\./i.test(id) || /^anthropic\./i.test(id));

const detectClaudeFamily = (id) => {
  if (typeof id !== 'string') return null;
  const lower = id.toLowerCase();
  return Object.keys(BEDROCK_FAMILY_ENV).find((fam) => lower.includes(fam)) || null;
};

/**
 * Map a bare Claude model id to its Bedrock form when (and only when) Bedrock
 * mode is on. Pure — no logging, no env mutation.
 *
 *  - No-op when Bedrock mode is off, the id is empty/non-string, or it already
 *    carries a region/`anthropic.` prefix.
 *  - No-op for any id that doesn't contain `claude` (codex `gpt-5`, gemini, a
 *    custom local alias like `my-sonnet-lora`, etc.) — only Claude ids are
 *    Bedrock-mappable, so applying this at a shared argv chokepoint can't
 *    corrupt another vendor's model.
 *  - Prefers the matching `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` env value when it
 *    is itself a region-prefixed Bedrock id (the wrapper's exact choice); else
 *    falls back to a `global.anthropic.<id>` prefix-rewrite.
 *
 * @param {string|null|undefined} id
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null|undefined} the mapped id (or the input unchanged)
 */
export function toBedrockModelId(id, env = process.env) {
  if (!isBedrockEnabled(env)) return id;
  if (typeof id !== 'string' || !id) return id;
  if (hasBedrockRegionPrefix(id)) return id;
  if (!/claude/i.test(id)) return id; // not a Claude id — leave alone
  const family = detectClaudeFamily(id);
  if (family) {
    const override = env?.[BEDROCK_FAMILY_ENV[family]];
    if (hasBedrockRegionPrefix(override)) return override;
  }
  return `global.anthropic.${id}`;
}

// Dedup so the auto-correction notice prints once per (provider, model) per
// process rather than on every run.
const _warnedBareBedrockModels = new Set();

/**
 * One-time (per process, per provider+model) notice that a stored Claude-Code
 * model id reads non-Bedrock while the box is in Bedrock mode and is being
 * auto-corrected for this run. Surfaces via the emoji-prefixed console.error
 * path so the config stays self-explanatory.
 */
export function warnBareBedrockModel(providerId, originalId, mappedId) {
  const key = `${providerId || 'claude-code'}::${originalId}`;
  if (_warnedBareBedrockModels.has(key)) return;
  _warnedBareBedrockModels.add(key);
  console.error(
    `⚠️ Provider '${providerId || 'claude-code'}' model '${originalId}' is bare but CLAUDE_CODE_USE_BEDROCK is set — auto-correcting to Bedrock id '${mappedId}' for this run (stored config unchanged; set a global.anthropic.* / us.anthropic.* model to silence).`,
  );
}

/**
 * Side-effecting convenience used at CLI-argv build time: map a bare Claude id
 * to its Bedrock form and emit the one-time auto-correction notice when the map
 * actually changed the id. Returns the id to pass to `--model`.
 */
export function resolveBedrockCliModel(id, { env = process.env, providerId } = {}) {
  const mapped = toBedrockModelId(id, env);
  if (mapped !== id) warnBareBedrockModel(providerId, id, mapped);
  return mapped;
}

/**
 * Strip the sentinel from a model list — the user-selectable view.
 * @param {string[]} models
 * @returns {string[]}
 */
export const filterSelectableModels = (models) =>
  (models || []).filter(m => m !== CODEX_CONFIGURED_DEFAULT && m !== ANTIGRAVITY_CONFIGURED_DEFAULT);

/**
 * Detects whether the provider's stored argv already pins a model with a
 * usable value. Checks both flag forms (`--model` / `-m`) and both styles
 * (separated `--model x` and joined `--model=x`). A separated flag with no
 * value following (`['--model']` at end of argv, or `['--model', '--other']`)
 * is treated as NOT a baked-in pin — the CLI would reject the argv at
 * runtime anyway, and pretending it's a pin would also make refiners report
 * `null` (from extractBakedModel) and skip injecting our own model.
 *
 * Used to gate runner-injected `--model` flags: when the user has hard-coded
 * a model in args, the runner-injected one is suppressed and the args-baked
 * model wins.
 */
export function hasModelFlag(args) {
  if (!Array.isArray(args)) return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--model=') && a.length > '--model='.length) return true;
    if (a.startsWith('-m=') && a.length > '-m='.length) return true;
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return true;
    }
  }
  return false;
}

/**
 * True when a provider command points at the Claude Code binary — the bare
 * `claude` on PATH, an absolute/relative path to it, or an optional Windows
 * `.exe` suffix (same matching rules as `isOpencodeCommand`). An empty/null
 * command also counts as Claude: `buildCliSpawnConfig`'s default branch and
 * the TUI `inferTuiCommand` fallback both resolve a blank command to `claude`.
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isClaudeCommand(command) {
  if (command == null || command === '') return true;
  if (typeof command !== 'string') return false;
  const base = command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  return base === 'claude';
}

/**
 * True for an Ollama-backed provider that launches the Claude Code binary
 * (`claude-ollama` / `claude-ollama-tui`). These sessions run a small local
 * model that drowns in Claude Code's full personal environment — hooks,
 * plugins, MCP servers, global CLAUDE.md — so the spawners put them in lean
 * mode (see `applyLeanClaudeArgs`). Keyed on the `ollamaBacked` marker + the
 * launch command, not provider ids, so renamed/custom local providers get the
 * same treatment.
 * @param {{command?:string, ollamaBacked?:boolean}|null|undefined} provider
 * @param {string} [command] - resolved launch command when it differs from
 *   `provider.command` (the TUI path may infer it from the provider id)
 * @returns {boolean}
 */
export function isOllamaClaudeProvider(provider, command = provider?.command) {
  return provider?.ollamaBacked === true && isClaudeCommand(command);
}

/**
 * Lean-context flags for local-model Claude Code sessions:
 * - `--bare` — skip hooks, plugin sync, auto-memory, and CLAUDE.md
 *   auto-discovery (the user's personal environment derails small models).
 * - `--strict-mcp-config` — with no `--mcp-config` given, load zero MCP
 *   servers (their tool schemas alone can blow a small Ollama context).
 */
export const LEAN_CLAUDE_ARGS = ['--bare', '--strict-mcp-config'];

/**
 * Append the lean-context flags for Ollama-backed Claude providers. No-op for
 * every other provider, and idempotent when the user already baked either
 * flag into `provider.args`.
 * @param {{command?:string, ollamaBacked?:boolean, args?:string[]}} provider
 * @param {string[]} args - argv built so far
 * @param {string} [command] - resolved launch command (see isOllamaClaudeProvider)
 * @returns {string[]}
 */
export function applyLeanClaudeArgs(provider, args, command = provider?.command) {
  if (!isOllamaClaudeProvider(provider, command)) return args;
  return [...args, ...LEAN_CLAUDE_ARGS.filter(flag => !args.includes(flag))];
}

/**
 * Extract the pinned model id from provider.args when a model flag is baked
 * in. Supports separated form (`--model X` / `-m X`) and joined form
 * (`--model=X` / `-m=X`). Returns null when no model flag is present or the
 * separated form has no value following the flag.
 */
export function extractBakedModel(args) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return next;
      return null;
    }
    if (a.startsWith('--model=')) return a.slice('--model='.length) || null;
    if (a.startsWith('-m=')) return a.slice('-m='.length) || null;
  }
  return null;
}
