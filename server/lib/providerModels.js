/**
 * Shared sentinel and helpers for provider model resolution.
 * Mirrors the constants in client/src/utils/providers.js — keep in sync.
 */

import { gatewayIdForProvider, isGatewayNamespace } from './providerGateways.js';

export const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';
// Grok Build CLI/TUI: PortOS does not select a model — the local `grok` binary
// uses its own latest default. Stored as a sentinel so pickers hide the model
// dropdown (same UX as Codex / Antigravity).
export const GROK_CONFIGURED_DEFAULT = 'grok-configured-default';
// Kimi Code CLI/TUI: same posture as Grok/Antigravity — PortOS does not select a
// model; the local `kimi` binary uses its own configured default. Stored as a
// sentinel so pickers hide the model dropdown.
export const KIMI_CONFIGURED_DEFAULT = 'kimi-configured-default';

const CONFIGURED_DEFAULT_SENTINELS = new Set([
  CODEX_CONFIGURED_DEFAULT,
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  GROK_CONFIGURED_DEFAULT,
  KIMI_CONFIGURED_DEFAULT,
]);

export const isCodexConfiguredDefault = (model) => model === CODEX_CONFIGURED_DEFAULT;

/** True for any provider "use CLI's own default" sentinel (Codex / Antigravity / Grok Build). */
export const isConfiguredDefaultModel = (model) => CONFIGURED_DEFAULT_SENTINELS.has(model);

/**
 * Normalize a provider `command` to its lowercase binary basename, stripping any
 * directory prefix and a Windows `.exe` suffix — e.g. `/opt/homebrew/bin/Grok.exe`
 * → `grok`. Returns `''` for empty/non-string input. The shared primitive behind
 * `isClaudeCommand`/`isOpencodeCommand`/`isGrokCommand` so the split/pop/case/.exe
 * rule lives in exactly one place. (Only `.exe` is stripped, matching the runner's
 * `shell:false` spawn path — a `.cmd`/`.bat` shim isn't directly spawnable.)
 * @param {string|null|undefined} command
 * @returns {string}
 */
export function commandBasename(command) {
  if (typeof command !== 'string' || command === '') return '';
  return command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

/**
 * True when argv contains any of `flags`, in either separated (`--flag`) or
 * joined (`--flag=value`) form. The generic scan behind the per-vendor argv
 * builders (`grok.js`, `kimi.js`, `cursor.js`), which each carried a private
 * byte-identical copy until the third one made it a rule. Lives here next to
 * its siblings `hasModelFlag` / `hasEffortFlag` / `hasCodexUpdateCheckConfig`,
 * so a fix to the matching rule is one edit rather than an N-file sweep.
 * Non-string argv entries are skipped.
 * @param {unknown[]} args
 * @param {string[]} flags
 * @returns {boolean}
 */
export function argvHasFlag(args = [], flags = []) {
  return args.some((a) => typeof a === 'string' && flags.some((f) => a === f || a.startsWith(`${f}=`)));
}

/**
 * Returns the model string to pass to a CLI's --model flag, or null if the
 * caller should omit --model entirely (configured-default sentinels — the CLI
 * uses its own default: Codex via ~/.codex/config.toml, Antigravity/Grok Build
 * via the binary's built-in latest model).
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
export const resolveCliModel = (model) => isConfiguredDefaultModel(model) ? null : (model || null);

// ---------------------------------------------------------------------------
// Reasoning-effort levels — Claude Code (`--effort <level>`), Antigravity
// (`--effort <level>`) and Codex (`-c model_reasoning_effort=<level>`) all
// accept a per-invocation override of how hard the model thinks. Value sets
// verified against claude CLI v2.1.x (`--help`), current Codex CLI config
// values (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, plus
// model-gated `ultra`) and agy
// (`--help`: "Reasoning effort for the current CLI session (low|medium|high)"). Mirrored in
// client/src/utils/providers.js — keep in sync
// (`providerModels.mirror.test.js` fails when the two copies drift).
//
// Codex Ultra adds automatic task delegation on the models that advertise it.
// Keep it model-gated: older Codex models and Luna top out at `max`.
//
// `none` is a real codex variant but is deliberately NOT offered: it means "do
// not reason at all", which no PortOS effort control should be able to select.
// ---------------------------------------------------------------------------

export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const CODEX_EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const CODEX_ULTRA_EFFORT_LEVELS = Object.freeze([...CODEX_EFFORT_LEVELS, 'ultra']);
export const ANTIGRAVITY_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);
// OpenCode forwards this narrow OpenAI-compatible ladder as `reasoningEffort`
// to whichever local backend it is wired to (Ollama, llama.cpp, MTPLX,
// OrcaRouter). Keep it separate from vendor-CLI-only levels.
export const OPENCODE_LOCAL_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);
// Cursor Agent's ladder. Cursor has NO `--effort` flag — the level is a
// parameter of the model id itself (`gpt-5[effort=max]`), folded in by
// `foldCursorEffortIntoModel` — so `buildEffortArgs` deliberately emits nothing
// for cursor while this ladder still drives every picker. The tier NAMES are
// slashdo's documented `~effort=<level>` set (`low|medium|high|xhigh|max`), which
// is what `--review-with cursor[gpt-5]~effort=max` parses; keeping them
// identical is the point, since the same pin has to survive a round trip
// through slashdo.
export const CURSOR_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
// Grok Build CLI. `--reasoning-effort <EFFORT>` (aliased `--effort`, which is what
// `buildEffortArgs` emits). The ladder is grok's own, read off its rejection
// message rather than guessed: `grok --reasoning-effort bogus` answers
// `use one of: xhigh, high, medium, low` — so there is no `max`/`minimal` here,
// and `resolveCliEffort` clamps a stored `max`/`ultra` down to `xhigh`.
export const GROK_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

/** Union of every accepted effort value across effort-capable CLIs, low→high. */
export const EFFORT_LEVELS = Object.freeze([...new Set([
  ...CODEX_ULTRA_EFFORT_LEVELS,
  ...CLAUDE_EFFORT_LEVELS,
  ...ANTIGRAVITY_EFFORT_LEVELS,
  ...CURSOR_EFFORT_LEVELS,
])]);

const CODEX_ULTRA_MODELS = new Set(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra']);

const codexEffortLevelsForModel = (model) => CODEX_ULTRA_MODELS.has(String(model || '').trim().toLowerCase())
  ? CODEX_ULTRA_EFFORT_LEVELS
  : CODEX_EFFORT_LEVELS;

// ---------------------------------------------------------------------------
// Antigravity base-model ↔ effort-suffix split.
//
// `agy models` enumerates the effort tiers as separate model ids
// (`gemini-3.6-flash-low|-medium|-high`), which forces the user to pick their
// reasoning effort *inside* the model dropdown. agy also accepts the BASE id
// with a separate `--effort` flag (`--model gemini-3.6-flash --effort high`) —
// verified against the real binary — so PortOS lists base models and carries
// effort as its own control.
//
// agy validates the PAIR, though: `--model gemini-3.1-pro --effort medium`
// errors with `gemini-3.1-pro has no "medium" effort (available: low, high)`.
// So the tiers a base model offers are derived from the provider's own model
// catalog rather than assumed to be the full low/medium/high ladder.
// Mirrored in client/src/utils/providers.js — keep in lockstep.
// ---------------------------------------------------------------------------

const ANTIGRAVITY_EFFORT_SUFFIX_RE = new RegExp(`-(${ANTIGRAVITY_EFFORT_LEVELS.join('|')})$`);

/**
 * Split an Antigravity model id into its base id and baked-in effort tier —
 * `gemini-3.6-flash-high` → `{ base: 'gemini-3.6-flash', effort: 'high' }`.
 * Ids with no effort suffix (`claude-sonnet-4-6`), configured-default sentinels,
 * and non-strings come back as `{ base: <input>, effort: null }`.
 * @param {string|null|undefined} id
 * @returns {{base: string|null|undefined, effort: string|null}}
 */
export function splitAntigravityModel(id) {
  if (typeof id !== 'string' || id === '' || isConfiguredDefaultModel(id)) {
    return { base: id, effort: null };
  }
  const match = ANTIGRAVITY_EFFORT_SUFFIX_RE.exec(id);
  return match
    ? { base: id.slice(0, -match[0].length), effort: match[1] }
    : { base: id, effort: null };
}

/**
 * The user-selectable view of an Antigravity model list: effort suffixes
 * stripped, duplicates collapsed, original order preserved. Configured-default
 * sentinels and non-string entries (`{ id, name }` objects some pickers pass)
 * ride through untouched so callers can hand this any `provider.models`.
 * @param {unknown[]} models
 * @returns {unknown[]}
 */
export function antigravityBaseModels(models) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(models) ? models : []) {
    if (typeof entry !== 'string') {
      out.push(entry);
      continue;
    }
    const { base } = splitAntigravityModel(entry);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

/**
 * The effort tiers an Antigravity base model actually offers, read off the
 * provider's own model catalog:
 *   - `['low','high']` — the suffixed variants present for that base.
 *   - `[]`             — the base is in the catalog with no suffixed variants
 *                        (`claude-sonnet-4-6`): agy has no effort knob for it.
 *   - `null`           — the model is UNKNOWN (blank, the configured-default
 *                        sentinel, or an empty catalog), so the caller should
 *                        fall back to the full ladder rather than assume none.
 *                        The sentinel case matters: it is the shipped agy
 *                        `defaultModel`, and reporting `[]` for it would hide
 *                        the effort control on every freshly-opened picker.
 * @param {string|null|undefined} model - base or suffixed model id
 * @param {unknown[]} models - the provider's model list
 * @returns {readonly string[]|null}
 */
export function antigravityModelEffortLevels(model, models) {
  const list = (Array.isArray(models) ? models : []).filter(m => typeof m === 'string');
  if (list.length === 0) return null;
  if (isConfiguredDefaultModel(model)) return null;
  const { base } = splitAntigravityModel(model);
  if (typeof base !== 'string' || base === '') return null;
  return Object.freeze(ANTIGRAVITY_EFFORT_LEVELS.filter(level => list.includes(`${base}-${level}`)));
}

/**
 * True when a provider is codex-flavored — the shipped `codex`/`codex-tui`
 * provider ids or any provider whose launch command basename is `codex`
 * (path/exe tolerant). The single home for the codex signature, same posture
 * as `isClaudeCommand`/`isOpencodeCommand`.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isCodexProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'codex' || id === 'codex-tui' || commandBasename(provider?.command) === 'codex';
}

/**
 * True when a provider is Grok-Build-flavored — the shipped `grok-cli`/`grok-tui`
 * ids or any provider whose launch command basename is `grok`. Same posture as
 * `isCodexProvider`, and deliberately defined here rather than imported from
 * `grok.js`: that module imports THIS one, so importing back would cycle.
 *
 * The bare `grok` id is the HTTP API provider, which has no CLI to pass a flag
 * to — it is excluded so it gets no effort ladder.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isGrokProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'grok-cli' || id === 'grok-tui' || commandBasename(provider?.command) === 'grok';
}

/**
 * True when a provider is Claude-Code-flavored — a `claude-code*` provider id or
 * any provider whose launch command basename is `claude` (path/exe tolerant).
 *
 * Unlike `isClaudeCommand`, a BLANK command does not count: this identifies a
 * provider positively, and callers that gate a Claude-only capability on it must
 * not treat "unknown" as Claude. Same posture as `effortLevelsForProvider`, which
 * this replaces the inline copy of.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isClaudeProvider(provider) {
  if (!provider) return false;
  return String(provider.id || '').toLowerCase().startsWith('claude-code')
    || commandBasename(provider.command) === 'claude';
}

/**
 * True when a provider is OpenCode-flavored — the shipped `opencode`/`opencode-tui`
 * ids or any provider whose launch command basename is `opencode`. The
 * provider-shaped companion to `isOpencodeCommand`, same posture as
 * `isCodexProvider`.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isOpencodeProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'opencode' || id === 'opencode-tui' || isOpencodeCommand(provider?.command);
}

/**
 * True when a provider is Kimi-Code-flavored — the shipped `kimi-cli`/`kimi-tui`
 * ids or any provider whose launch command basename is `kimi` (path/exe tolerant).
 * The single home for the kimi signature, same posture as `isCodexProvider`.
 * Mirrored in client/src/utils/providers.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isKimiProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'kimi-cli' || id === 'kimi-tui' || commandBasename(provider?.command) === 'kimi';
}

/**
 * True when a provider is Antigravity-flavored — the shipped
 * `antigravity-cli`/`antigravity-tui` ids or any provider whose launch command
 * basename is `agy`/`antigravity` (path/exe tolerant). The provider-shaped
 * companion to `isAntigravityCommand` in antigravity.js; lives here (rather
 * than there) so `effortLevelsForProvider` can key on it without this
 * dependency-light module importing a sibling. Mirrored in
 * client/src/utils/providers.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isAntigravityProvider(provider) {
  if (!provider) return false;
  const id = String(provider.id || '').toLowerCase();
  if (id === 'antigravity-cli' || id === 'antigravity-tui') return true;
  const base = commandBasename(provider.command);
  return base === 'agy' || base === 'antigravity';
}

/**
 * True when a provider is Cursor-Agent-flavored — the shipped `cursor-cli` /
 * `cursor-tui` ids or any provider whose launch command basename is
 * `cursor-agent` (path/exe tolerant). The provider-shaped companion to
 * `isCursorCommand` in cursor.js; lives here (rather than there) for the same
 * reason `isAntigravityProvider` does — so `effortLevelsForProvider` and
 * `buildEffortArgs` can key on it without this dependency-light module importing
 * a sibling vendor file that already imports IT.
 *
 * Deliberately never matches a bare `cursor` command: that is Cursor's GUI
 * editor launcher, not the agent binary (see cursor.js).
 * Mirrored in client/src/utils/providers.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isCursorProvider(provider) {
  if (!provider) return false;
  const id = String(provider.id || '').toLowerCase();
  return id === 'cursor-cli' || id === 'cursor-tui' || commandBasename(provider.command) === 'cursor-agent';
}

/**
 * Fold a reasoning-effort level into a Cursor model id using Cursor's own
 * model-variant syntax, because `cursor-agent` has NO `--effort` flag and exits
 * non-zero when passed one. Three cases, matching slashdo's fold in
 * `lib/local-agent-review-loop.md` exactly (the same pin has to mean the same
 * invocation whether PortOS or slashdo builds it):
 *
 *   - `gpt-5` + `max`                       → `gpt-5[effort=max]`
 *   - `claude-opus-4-7[thinking=true]` + `high` → `claude-opus-4-7[thinking=true,effort=high]`
 *   - a model that ALREADY names `effort=`  → returned unchanged (the explicit
 *     variant the user typed wins over the ladder pin)
 *
 * Returns the model unchanged when there is no effort, and `null` when there is
 * no model — an effort with nothing to attach to is dropped rather than emitted
 * as a flag Cursor would reject.
 * @param {string|null|undefined} model
 * @param {string|null|undefined} effort
 * @returns {string|null}
 */
export function foldCursorEffortIntoModel(model, effort) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id) return null;
  const level = typeof effort === 'string' ? effort.trim() : '';
  if (!level) return id;
  if (id.includes('effort=')) return id;
  if (id.endsWith(']')) return `${id.slice(0, -1)},effort=${level}]`;
  return `${id}[effort=${level}]`;
}

/**
 * The effort levels a provider's CLI accepts, or null when the provider has no
 * effort control (opencode, grok, kimi, HTTP API providers). Keyed on the
 * launch command basename (plus the shipped provider ids) so path-configured or
 * renamed claude/codex/agy providers still qualify — same detection posture as
 * `isClaudeCommand`/`isOpencodeCommand`. A blank command does NOT default to
 * Claude here (unlike `isClaudeCommand`): effort is an opt-in enhancement, and
 * only a provider we can positively identify should advertise levels.
 *
 * `model` narrows the Antigravity ladder to the tiers that base model actually
 * offers (agy rejects `gemini-3.1-pro --effort medium`), read off
 * `provider.models`. Omit it — or leave the catalog empty — to get the full
 * low/medium/high ladder. Returns null for an Antigravity model the catalog
 * says has no tiers at all (`claude-sonnet-4-6`), so no `--effort` is emitted.
 *
 * A ladder here does NOT imply an `--effort` flag: cursor advertises levels but
 * carries them inside `--model` (`foldCursorEffortIntoModel`), so
 * `buildEffortArgs` returns `[]` for it. Ask this function "can the user pick a
 * level?", and `buildEffortArgs` "what argv does that level become?".
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null} [model]
 * @returns {readonly string[]|null}
 */
export function effortLevelsForProvider(provider, model = null) {
  if (!provider) return null;
  if (isOpencodeProvider(provider) && getOpencodeLocalProviderNamespace(provider)) return OPENCODE_LOCAL_EFFORT_LEVELS;
  if (isCodexProvider(provider)) return codexEffortLevelsForModel(model);
  if (isAntigravityProvider(provider)) {
    const perModel = model ? antigravityModelEffortLevels(model, provider.models) : null;
    if (perModel === null) return ANTIGRAVITY_EFFORT_LEVELS;
    return perModel.length ? perModel : null;
  }
  if (isCursorProvider(provider)) return CURSOR_EFFORT_LEVELS;
  if (isGrokProvider(provider)) return GROK_EFFORT_LEVELS;
  if (isClaudeProvider(provider)) return CLAUDE_EFFORT_LEVELS;
  return null;
}

// Every effort value any CLI accepts, ordered weakest→strongest. The clamp
// below walks this so an effort saved against one provider survives a switch to
// a provider with a narrower ladder (agy tops out at `high`; claude has no
// `minimal`/`ultra`) instead of vanishing.
const EFFORT_RANK = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * Resolve a stored effort override to the value the provider's CLI actually
 * accepts, or null when the flag should be omitted entirely (no override set,
 * provider has no effort control, or the value isn't a known effort at all).
 * An out-of-range value is clamped to the nearest supported level at or below
 * it (`ultra`→`max` on claude and Codex models without Ultra,
 * `xhigh`/`max`/`ultra`→`high` on agy), falling back to the provider's weakest
 * level when nothing sits below it (`minimal`→`low`) — rather than being
 * dropped.
 * @param {string|null|undefined} effort
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null} [model] - narrows the Antigravity ladder (see effortLevelsForProvider)
 * @returns {string|null}
 */
export function resolveCliEffort(effort, provider, model = null) {
  if (!effort) return null;
  const levels = effortLevelsForProvider(provider, model);
  if (!levels) return null;
  if (levels.includes(effort)) return effort;
  const requested = EFFORT_RANK.indexOf(effort);
  if (requested === -1) return null; // not an effort value at all
  const supported = levels.map(l => EFFORT_RANK.indexOf(l)).filter(i => i !== -1).sort((a, b) => a - b);
  if (supported.length === 0) return null;
  const below = supported.filter(i => i < requested);
  return EFFORT_RANK[below.length ? below[below.length - 1] : supported[0]];
}

// Codex's config key (set via `-c <key>=<value>`) that carries the reasoning
// effort. Named for the same reason as CODEX_UPDATE_CHECK_KEY below: the string
// is matched in one place, emitted in another, and read back by the error
// analyzer when a config rejection has to be blamed on PortOS or on the user.
export const CODEX_EFFORT_KEY = 'model_reasoning_effort';

// Every spelling of the effort flag a provider CLI accepts as a VALUE-taking
// argument. `--reasoning-effort` is grok's canonical long form (`--effort` is its
// documented alias, and the alias is what buildEffortArgs emits) — it has to be
// recognized here or a user who baked `--reasoning-effort high` into their
// provider args gets a SECOND, injected `--effort <level>` appended. Grok's
// parser accepts the duplicate and takes the last one, so their explicit pin
// would be silently overridden — the exact opposite of the contract below.
const EFFORT_FLAG_NAMES = Object.freeze(['--effort', '--reasoning-effort']);

/**
 * True when the user has already baked an effort override into the provider's
 * args — claude/agy/grok's `--effort <level>` / `--effort=<level>`, grok's
 * `--reasoning-effort` long form, or a codex `-c model_reasoning_effort=…`
 * config pair. Mirrors `hasModelFlag`: a baked pin wins and the
 * runner-injected effort is suppressed.
 * @param {unknown[]} args
 * @returns {boolean}
 */
export function hasEffortFlag(args) {
  if (!Array.isArray(args)) return false;
  return args.some((a, i) => {
    if (typeof a !== 'string') return false;
    for (const flag of EFFORT_FLAG_NAMES) {
      if (a.startsWith(`${flag}=`) && a.length > flag.length + 1) return true;
      if (a === flag) {
        const next = args[i + 1];
        if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return true;
      }
    }
    return a.startsWith(`${CODEX_EFFORT_KEY}=`);
  });
}

/**
 * The argv fragment that applies an effort override to an effort-capable CLI:
 * `['--effort', <level>]` for claude and agy, `['-c', 'model_reasoning_effort=<level>']`
 * for codex, `[]` when the flag should be omitted (no override, provider has no
 * effort control, or a user-baked pin already sits in `existingArgs`). The one
 * home for both the detection AND the arg shape, so the two can't drift — spawn
 * builders just spread the result.
 *
 * **Cursor always gets `[]`, even though it HAS a ladder.** `cursor-agent`
 * exposes no `--effort` flag and exits non-zero when handed one; its effort is a
 * model-variant parameter, so cursor spawn builders fold the level into
 * `--model` with `foldCursorEffortIntoModel` instead of spreading this.
 * @param {string|null|undefined} effort
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {unknown[]} [existingArgs]
 * @param {string|null} [model] - narrows the Antigravity ladder (see effortLevelsForProvider)
 * @returns {string[]}
 */
export function buildEffortArgs(effort, provider, existingArgs = [], model = null) {
  const effectiveEffort = resolveCliEffort(effort, provider, model);
  if (!effectiveEffort || hasEffortFlag(existingArgs)) return [];
  if (isCursorProvider(provider)) return []; // rides `--model`, not a flag — see above
  return isCodexProvider(provider)
    ? ['-c', `${CODEX_EFFORT_KEY}=${effectiveEffort}`]
    : ['--effort', effectiveEffort];
}

// Codex's config key (set via `-c <key>=<value>`) that gates its startup
// update check. Kept as a named constant so a codex-side rename is a one-line
// edit rather than a four-builder grep.
export const CODEX_UPDATE_CHECK_KEY = 'check_for_update_on_startup';
export const CODEX_AGENT_THREADS_KEY = 'agents.max_concurrent_threads_per_session';

/**
 * Give a Codex swarm enough session threads for its root orchestrator plus
 * every configured worker. The CLI counts the root against this limit, so a
 * six-worker claim run needs seven threads rather than six.
 *
 * Callers deliberately supply this only for cloud-backed Codex agents. Local
 * inference stays bounded by its runtime-specific concurrency posture instead
 * of turning one CoS task into an unbounded fan-out against a single GPU.
 *
 * @param {unknown} maxConcurrentThreads
 * @returns {string[]}
 */
export function buildCodexAgentThreadArgs(maxConcurrentThreads) {
  const limit = Number(maxConcurrentThreads);
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  return ['-c', `${CODEX_AGENT_THREADS_KEY}=${limit}`];
}

/**
 * True when the codex argv already pins the startup-update-check config, so a
 * caller-supplied value wins over the injected default. Null-safe. Recognizes
 * every codex override syntax for the key: the separate-arg value element of
 * `-c <key>=<v>` / `--config <key>=<v>` (which arrives as a standalone
 * `<key>=<v>` token), AND the joined forms `--config=<key>=<v>` / `-c=<key>=<v>`
 * (a single token). Missing the joined form would inject a second, conflicting
 * `-c <key>=false` that silently overrides the user's explicit value.
 * @param {unknown[]} args
 * @returns {boolean}
 */
export function hasCodexUpdateCheckConfig(args) {
  if (!Array.isArray(args)) return false;
  const pin = `${CODEX_UPDATE_CHECK_KEY}=`;
  return args.some((a) => {
    if (typeof a !== 'string') return false;
    if (a.startsWith(pin)) return true; // standalone value of `-c`/`--config <key>=<v>`
    // Joined `--config=<key>=<v>` / `-c=<key>=<v>` — strip the flag prefix, then test.
    const joined = a.startsWith('--config=') ? a.slice(9) : a.startsWith('-c=') ? a.slice(3) : null;
    return joined !== null && joined.startsWith(pin);
  });
}

/**
 * The argv fragment that disables codex's interactive startup update check:
 * `['-c', 'check_for_update_on_startup=false']`, or `[]` when a user-baked pin
 * already sits in `existingArgs`. Codex checks GitHub for a newer release on
 * every startup and, if one exists, an interactive run renders a BLOCKING
 * "Update available! → 1. Update now" modal — a headless agent's submit-Enter
 * lands on "Update now", triggering a ~100MB `brew upgrade` it can't complete,
 * and the session dies without processing the prompt. Non-interactive `codex
 * exec` runs never render the modal but still pay the check's network cost (and
 * can trip an unattended upgrade), so every codex spawn builder spreads this.
 * The one home for both the detection and the arg shape, so they can't drift.
 * @param {unknown[]} [existingArgs]
 * @returns {string[]}
 */
export function buildCodexStartupArgs(existingArgs = []) {
  if (hasCodexUpdateCheckConfig(existingArgs)) return [];
  return ['-c', `${CODEX_UPDATE_CHECK_KEY}=false`];
}

/**
 * Every CLI config key PortOS itself injects as a `-c <key>=<value>` override.
 * Exhaustive by construction — `buildEffortArgs` and `buildCodexStartupArgs`
 * above are the only two builders that emit `-c`, and both key off the
 * constants listed here.
 *
 * Read by the `cli-config-invalid` error analyzer (`agentErrorAnalysis.js`) to
 * answer the only question that matters when a CLI refuses to start: did PortOS
 * hand it that value, or was it already sitting in the user's own config file?
 * Getting this wrong sends the user grepping PortOS source for a key PortOS
 * never emits — the 2026-08-18 `service_tier` incident, where a newer install
 * of the same CLI had written a variant the CLI on PATH rejects into the shared
 * config file.
 */
export const PORTOS_CLI_CONFIG_KEYS = Object.freeze([
  CODEX_AGENT_THREADS_KEY,
  CODEX_EFFORT_KEY,
  CODEX_UPDATE_CHECK_KEY,
]);

/**
 * True when `key` is a config key PortOS supplies via `-c` (see
 * PORTOS_CLI_CONFIG_KEYS). Null-safe; comparison is exact, so a lookalike key
 * from the user's config file is correctly reported as not-ours.
 * @param {unknown} key
 * @returns {boolean}
 */
export function isPortosSuppliedConfigKey(key) {
  return typeof key === 'string' && PORTOS_CLI_CONFIG_KEYS.includes(key.trim());
}

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
  return commandBasename(command) === 'opencode';
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
 * Gated on a local-runtime marker, NOT just `command === 'opencode'`: a
 * user-configured OpenCode provider pointed at a different backend stores an
 * already-qualified id (`openai/gpt-4o`, `anthropic/claude-sonnet`), and blindly
 * prefixing `ollama/` would route it to the wrong backend. No-op for
 * non-local / non-OpenCode providers and empty models.
 * @param {{command?:string, ollamaBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean, orcarouterBacked?:boolean}} provider
 * @param {string|null|undefined} model
 * @returns {string|null|undefined}
 */
export function prefixOpencodeModel(provider, model) {
  const namespace = getOpencodeLocalProviderNamespace(provider);
  if (!isOpencodeCommand(provider?.command) || !namespace || !model) return model;
  const id = String(model);
  if (isGatewayNamespace(namespace)) {
    // A gateway model id is ALREADY `vendor/model` (`anthropic/claude-sonnet-4`,
    // `orcarouter/auto`), and OpenCode splits provider/model on the FIRST slash
    // only — so the namespaced form is legitimately doubled
    // (`openrouter/anthropic/claude-sonnet-4`, `openrouter/openrouter/auto`).
    // Guard on the DOUBLED prefix, never the single one: a single-prefix check
    // would read OpenRouter's own auto-router id `openrouter/auto` as
    // already-namespaced and emit it unchanged, which OpenCode resolves to the
    // model `auto` — a model that does not exist.
    return id.startsWith(`${namespace}/${namespace}/`) ? id : `${namespace}/${id}`;
  }
  return id.startsWith(`${namespace}/`) ? id : `${namespace}/${id}`;
}

/**
 * OpenCode's local OpenAI-compatible provider namespace, if this provider has
 * opted into one. Structural markers avoid deriving a backend from an editable
 * display name or endpoint and preserve the legacy Ollama outcome if a malformed
 * record carries both markers.
 * @param {{ollamaBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean, gatewayBacked?:string, orcarouterBacked?:boolean}|null|undefined} provider
 * @returns {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|string|null}
 */
export function getOpencodeLocalProviderNamespace(provider) {
  if (provider?.ollamaBacked === true) return 'ollama';
  if (provider?.mtplxBacked === true) return 'mtplx';
  if (provider?.llamaBacked === true) return 'llama';
  if (provider?.vllmBacked === true) return 'vllm';
  if (provider?.sglangBacked === true) return 'sglang';
  // Hosted gateways (`providerGateways.js`) come LAST so a malformed record
  // carrying both a local marker and a gateway marker keeps its legacy local
  // outcome, exactly as the old if-chain did with `orcarouterBacked`.
  return gatewayIdForProvider(provider);
}

/**
 * Claude Code on AWS Bedrock wants region-prefixed model ids
 * (`global.anthropic.claude-opus-5`, `us.anthropic.claude-opus-4-1-...-v1:0`).
 * When `CLAUDE_CODE_USE_BEDROCK` is set on the box, passing a bare
 * `claude --model claude-opus-5` is rejected ("provided model identifier is
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
 * Claude Code's first-party model ids spell a version with DASHES
 * (`claude-fable-5-1`, `claude-opus-4-8`), while the release is spoken and
 * written with a dot ("Fable 5.1"). A stored `claude-fable-5.1` therefore looks
 * right in the picker and is rejected by the CLI at spawn time — the run dies
 * with "model not found", the task blocks, and nothing about the id says why.
 *
 * This canonicalizes the dotted spelling to the dashed one, and ONLY that:
 *
 *  - the id must start with a first-party family prefix (`claude-opus-`,
 *    `claude-sonnet-`, `claude-haiku-`, `claude-fable-`), so a vendor id that
 *    merely mentions Claude (cursor's `claude-4.6-sonnet-medium`) is untouched;
 *  - only a dot BETWEEN DIGITS is rewritten, leaving any other dot alone;
 *  - a Bedrock region-prefixed id (`global.anthropic.…`) is left alone, since
 *    its prefix dots are structural.
 *
 * @param {string|null|undefined} id
 * @returns {string|null|undefined} the canonical id (or the input unchanged)
 */
export function normalizeClaudeModelId(id) {
  if (typeof id !== 'string' || !id) return id;
  if (hasBedrockRegionPrefix(id)) return id;
  if (!/^claude-(?:opus|sonnet|haiku|fable)-/i.test(id)) return id;
  return id.replace(/(\d)\.(?=\d)/g, '$1-');
}

// Dedup so the canonicalization notice prints once per (provider, model) per
// process rather than on every run, matching `warnBareBedrockModel`.
const _warnedDottedClaudeModels = new Set();

/**
 * The model string a Claude Code spawn should pass to `--model`: canonicalize a
 * dotted first-party id, then map it to its Bedrock form when the box is in
 * Bedrock mode. The single home for both corrections, called from every
 * Claude-command argv builder (`claudeCliArgs`, `claudeSpawnArgs`,
 * `resolveInjectedTuiModel`) so a fix in one is a fix in all.
 *
 * Deliberately NOT folded into `resolveBedrockCliModel`: that helper is also the
 * documented Bedrock-only mapper, and the dot rewrite is gated on the caller
 * already having resolved a Claude *Code* command — cursor and friends label
 * Anthropic models under their own dotted ids and must not be rewritten.
 *
 * @param {string|null|undefined} id
 * @param {{env?:NodeJS.ProcessEnv, providerId?:string}} [opts]
 * @returns {string|null|undefined}
 */
export function resolveClaudeCliModel(id, { env = process.env, providerId } = {}) {
  const canonical = normalizeClaudeModelId(id);
  if (canonical !== id) {
    const key = `${providerId || 'claude-code'}::${id}`;
    if (!_warnedDottedClaudeModels.has(key)) {
      _warnedDottedClaudeModels.add(key);
      console.error(
        `⚠️ Provider '${providerId || 'claude-code'}' model '${id}' spells its version with a dot — Claude Code only serves the dashed id, using '${canonical}' for this run (update the provider's model list to silence).`,
      );
    }
  }
  return resolveBedrockCliModel(canonical, { env, providerId });
}

/**
 * The model string a TUI spawn should actually pass to `--model`, given the
 * resolved launch command. The single home for a decision that used to be
 * open-coded in TWO parallel ladders — `tuiHandshake.js#buildTuiInvocation`
 * (one-shot TUI prompt runs) and `agentTuiSpawning.js#appendModelArgs` (CoS
 * agent / TUI-session spawns) — which is exactly how cursor's exemption landed
 * in one and not the other. Callers keep their own `hasModelFlag` gating; this
 * only answers "which id".
 *
 *  - OpenCode: namespace a bare Ollama id (`ollama/<id>`); never Bedrock-mapped.
 *  - Claude Code: canonicalize a dotted first-party id (`claude-fable-5.1` →
 *              `claude-fable-5-1`), then map a bare Claude id to its
 *              region-prefixed Bedrock form when the box is in Bedrock mode
 *              (no-op off Bedrock / for non-Claude ids).
 *  - Anything else: passed through verbatim.
 *
 * The Bedrock arm is deliberately OPT-IN on the launch command rather than the
 * default. Bedrock is a Claude *Code* transport, but `toBedrockModelId` gates
 * only on the model id matching `/claude/i` — so as the default it silently
 * captured any vendor that labels Anthropic models under its own ids. Cursor is
 * exactly that case (`claude-opus-5-thinking-high`), and on a Bedrock box it was
 * being rewritten to `global.anthropic.claude-opus-5-thinking-high`, an id
 * cursor's router has never heard of. Opting out per-vendor meant every future
 * vendor had to remember to; keying on `isClaudeCommand` inverts that default so
 * they don't. (`isClaudeCommand` treats a blank command as Claude, matching both
 * callers' blank→`claude` spawn fallback, so this is behavior-preserving for
 * every shipped provider.)
 *
 * @param {string} model - the already-resolved (non-sentinel) model id
 * @param {{id?:string, command?:string, ollamaBacked?:boolean, mtplxBacked?:boolean, envVars?:Record<string,string>}|null|undefined} provider
 * @param {string} [command] - resolved launch command (may differ from provider.command)
 * @returns {string}
 */
export function resolveInjectedTuiModel(model, provider, command = provider?.command) {
  if (isOpencodeCommand(command)) return prefixOpencodeModel(provider, model);
  if (!isClaudeCommand(command)) return model;
  return resolveClaudeCliModel(model, {
    env: { ...process.env, ...provider?.envVars },
    providerId: provider?.id,
  });
}

/**
 * Strip configured-default sentinels from a model list — the user-selectable view.
 * @param {string[]} models
 * @returns {string[]}
 */
export const filterSelectableModels = (models) =>
  (models || []).filter(m => !isConfiguredDefaultModel(m));

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
 * Strip dangling/empty `--model` / `-m` tokens (no value follows, or the joined
 * form has an empty value). Those would survive into the spawned argv unchanged
 * and cause the CLI to reject the invocation — see the comment on `hasModelFlag`
 * for the full reasoning (it deliberately reports such a token as NOT a pin, so
 * the injection path fires; without this strip the CLI would then see two
 * `--model` occurrences). Pinned-with-value tokens are preserved untouched so
 * user-baked model selections still win.
 * @param {unknown[]} args
 * @returns {unknown[]}
 */
export function stripBrokenModelFlags(args) {
  if (!Array.isArray(args) || args.length === 0) return [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string' && (a === '--model=' || a === '-m=')) {
      continue; // empty joined form
    }
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      const hasValue = typeof next === 'string' && next.length > 0 && !next.startsWith('-');
      if (!hasValue) continue; // dangling separated form
    }
    out.push(a);
  }
  return out;
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
  // An empty/blank command also counts as Claude: `buildCliSpawnConfig`'s default
  // branch and the TUI `inferTuiCommand` fallback both resolve a blank command to
  // `claude` — a policy that differs from the other predicates, so it stays here.
  if (command == null || command === '') return true;
  return commandBasename(command) === 'claude';
}

/**
 * True for an Ollama-backed provider that launches the Claude Code binary
 * (`claude-ollama` / `claude-ollama-tui`). These sessions run a small local
 * model that drowns in Claude Code's full personal environment — hooks,
 * plugins, MCP servers, the global ~/.claude/CLAUDE.md — so the spawners put them in lean
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
 * True when a provider explicitly configures its own GitHub credential
 * (`GH_TOKEN` or `GITHUB_TOKEN`) in `envVars`. Agent-spawn paths that would
 * otherwise inject a repo-owner-pinned `GH_TOKEN` skip that injection when this
 * returns true, so the provider's explicit credential wins — `gh` prefers
 * `GH_TOKEN` over `GITHUB_TOKEN`, so an injected `GH_TOKEN` would silently
 * shadow a provider's configured `GITHUB_TOKEN` otherwise.
 * @param {{envVars?: Record<string,unknown>}} provider
 * @returns {boolean}
 */
export function providerSuppliesGithubToken(provider) {
  const env = provider?.envVars;
  return !!env && ('GH_TOKEN' in env || 'GITHUB_TOKEN' in env);
}

/**
 * Lean-context flags for local-model Claude Code sessions:
 * - `--bare` — skip hooks, plugin sync, auto-memory, and AGENTS.md
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
