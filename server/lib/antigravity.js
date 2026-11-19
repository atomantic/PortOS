/**
 * Antigravity (`agy`) CLI provider helpers: id and sentinel constants plus `isAntigravityCommand` and
 * `isAntigravityCliProvider` predicates.
 */

import { buildEffortArgs, commandBasename, extractBakedModel, hasModelFlag, resolveCliEffort, resolveCliModel, splitAntigravityModel, stripBrokenModelFlags } from './provider/providerModels.js';

export const ANTIGRAVITY_CLI_ID = 'antigravity-cli';
export const ANTIGRAVITY_TUI_ID = 'antigravity-tui';
export const LEGACY_GEMINI_CLI_ID = 'gemini-cli';
export const LEGACY_GEMINI_TUI_ID = 'gemini-tui';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';
// Exported so cosValidation's REVIEWER_CLI_BINARIES maps the `antigravity` slug to this
// string instead of retyping it.
export const ANTIGRAVITY_COMMAND = 'agy';

// Match by normalized binary basename so a path- or `.exe`-configured provider is still
// recognized; exact-string matching would let prepareCliPrompt fall through to stdin
// delivery, losing the prompt and leaving the trailing `--print` marker dangling.
export function isAntigravityCommand(command) {
  const base = commandBasename(command);
  return base === ANTIGRAVITY_COMMAND || base === 'antigravity';
}

export function isAntigravityCliProvider(provider) {
  return provider?.id === ANTIGRAVITY_CLI_ID || isAntigravityCommand(provider?.command);
}

// `agy models` prints one row per model on stdout (the "Fetching available models…"
// banner goes to stderr). Older builds print a bare id per line; newer ones print
// `<id>\t<Label>`. Both are accepted because other installs run older builds. The label
// is anchored on a TAB, not "first whitespace token": a prose line ("Available models")
// would otherwise surrender a regex-valid first word and be persisted as a model id.
//
// The id charset matches `sharedSchemas.js#cloudModelIdString`; restated rather than
// imported because the schema graph is wider than this parser needs and several
// mocked suites cannot absorb it.
const MODEL_ID_CHARS = '[A-Za-z0-9][A-Za-z0-9._:/-]*';
const ANTIGRAVITY_MODEL_ID = new RegExp(`^${MODEL_ID_CHARS}$`);
const ANTIGRAVITY_MODEL_LINE = new RegExp(`^(${MODEL_ID_CHARS})(?:\\t.*)?$`);

/**
 * Defense-in-depth id check for spawn sites whose `--model` value the route schema didn't bound.
 * @param {unknown} id
 */
export function isAntigravityModelId(id) {
  return typeof id === 'string' && ANTIGRAVITY_MODEL_ID.test(id);
}

/**
 * Parse ids out of `agy models` output, dropping prose and the configured-default
 * sentinel (which callers re-prepend). Mirrored in
 * `server/lib/aiToolkit/internal/antigravity.js` (cannot import out) — keep in sync.
 *
 * @param {string} stdout - raw stdout from `agy models`
 * @returns {string[]} deduped ids, in the order the binary listed them
 */
export function parseAntigravityModelList(stdout) {
  const ids = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = ANTIGRAVITY_MODEL_LINE.exec(line.trim());
    if (match && match[1] !== ANTIGRAVITY_CONFIGURED_DEFAULT) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

// `agy --print`/`-p`/`--prompt` takes the prompt as the flag's VALUE and does NOT read
// stdin, so `--print <prompt>` must be the FINAL pair in the argv;
// prepareAntigravityPrompt relocates the flag to the end at spawn time.
export const ANTIGRAVITY_PRINT_FLAGS = ['--print', '-p', '--prompt'];

/**
 * Append `--model` / `--effort` to an agy argv for a per-run override when the provider
 * args don't already pin one (see `resolveAntigravityModelAndEffort`). Deliberately NOT
 * Bedrock-mapped: agy serves `claude-*` ids through Google's own gateway.
 */
function appendAntigravityModelAndEffort(args, overrides = {}) {
  // `hasModelFlag` reports a value-less flag as "not a pin", so a dangling `--model`
  // must go or agy would see two.
  const out = stripBrokenModelFlags(args);
  const { model, effort, base, provider } = resolveAntigravityModelAndEffort(out, overrides);
  if (model) out.push('--model', model);
  out.push(...buildEffortArgs(effort, provider, out, base));
  return out;
}

/**
 * Pair an agy `--model` with an `--effort`, honoring a user-baked `--model` pin.
 *
 * `model` may be a BASE id (`gemini-3.6-flash`) or a legacy effort-suffixed id
 * (`gemini-3.6-flash-high`, still persisted on older installs and federated peers). A
 * suffixed id is split so the base goes to `--model` and its baked tier becomes the
 * `--effort`; an explicitly selected `effort` wins over the baked one.
 *
 * `models` narrows the effort ladder to tiers the base offers, because agy validates the
 * PAIR (it rejects `--model gemini-3.1-pro --effort medium`). An unresolvable effort leaves
 * the model id untouched so a suffix carrying the only usable tier isn't stripped.
 *
 * When the saved argv already pins `--model`, that pin wins (same gate as
 * `buildCliArgs`) and `model` comes back null. The effort ladder is read off the PINNED
 * id and only an explicitly selected `effort` applies.
 *
 * @param {string[]} args - the argv built so far (post `stripBrokenModelFlags`)
 * @param {{model?:string|null, effort?:string|null, models?:unknown[]|null}} [overrides]
 * @returns {{model: string|null, effort: string|null, base: string|null, provider: object}}
 *   `model` is the id to inject (null = don't), `provider` the synthetic agy
 *   provider to hand `buildEffortArgs`.
 */
export function resolveAntigravityModelAndEffort(args = [], { model = null, effort = null, models = null } = {}) {
  const provider = { id: ANTIGRAVITY_CLI_ID, command: 'agy', models };
  const pinned = hasModelFlag(args);
  const requested = resolveCliModel(model);
  const { base, effort: bakedEffort } = splitAntigravityModel(pinned ? extractBakedModel(args) : requested);
  const effectiveEffort = resolveCliEffort(pinned ? effort : (effort || bakedEffort), provider, base);
  return {
    model: pinned ? null : (effectiveEffort ? base : requested),
    effort: effectiveEffort,
    base,
    provider,
  };
}

/**
 * @param {string[]} [args] - the provider's saved argv
 * @param {{model?:string|null, effort?:string|null, models?:unknown[]|null}} [overrides] - per-run selections
 */
export function ensureAntigravityPrintArgs(args = [], overrides = {}) {
  // PortOS always supplies the prompt itself, so a baked print flag never carries a
  // prompt value worth preserving; one trailing marker is re-added below.
  const stripped = stripAntigravityUnsupportedArgs(args).filter((arg) => !ANTIGRAVITY_PRINT_FLAGS.includes(arg));
  const out = appendAntigravityModelAndEffort(stripped, overrides);
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  // Print flag LAST: any flag left after a bare --print would be consumed by agy as the
  // prompt text. Callers may still append extraArgs after this, so "last" holds only at
  // build time; prepareAntigravityPrompt re-anchors the pair at spawn time.
  out.push('--print');
  return out;
}

const NOOP_CLEANUP = () => {};

/**
 * Spawn-time prompt delivery: re-anchor the print flag at the END of the argv with the
 * prompt as its VALUE. Same `{ args, useStdin, cleanup }` shape as
 * grok.js#prepareGrokPromptFile (see prepareCliPrompt).
 *
 * The flag is MOVED, not spliced in place, because runCliProviderPrompt appends extraArgs
 * after the trailing marker (they'd become stray positionals). EVERY print flag is lifted
 * since extraArgs are never stripped; the last flag SPELLING wins.
 *
 * @param {string[]} args - argv as built by ensureAntigravityPrintArgs
 * @param {string} prompt - the full prompt text
 * @returns {{ args: string[], useStdin: false, cleanup: () => void }}
 */
export function prepareAntigravityPrompt(args = [], prompt = '') {
  let flag = '--print';
  const out = [];
  for (const arg of args) {
    if (ANTIGRAVITY_PRINT_FLAGS.includes(arg)) flag = arg;
    else out.push(arg);
  }
  out.push(flag, prompt);
  return { args: out, useStdin: false, cleanup: NOOP_CLEANUP };
}

// TUI mode launches the interactive REPL (NO --print) and delivers the prompt by
// bracketed-paste, so --dangerously-skip-permissions stays a real boolean flag.
// Do NOT add --print here.
/**
 * Takes NO per-run model/effort overrides, unlike its `--print` sibling: the TUI paths
 * inject those via `resolveAntigravityModelAndEffort` + `buildEffortArgs` after this
 * normalizer runs (it is reached via the provider-agnostic `applyCommandDefaults`). It
 * still drops a dangling `--model` so that later append can't produce two.
 * @param {string[]} [args] - the provider's saved argv
 */
export function ensureAntigravityTuiArgs(args = []) {
  const out = stripBrokenModelFlags(stripAntigravityUnsupportedArgs(args));
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  return out;
}

// `--yolo`, `-m`, `--output-format` and `-o` are legacy Gemini-CLI flags agy rejects.
// The LONG `--model` is deliberately kept: it is a real user pin, and `hasModelFlag`
// sees it, which suppresses PortOS's own injected `--model`.
export function stripAntigravityUnsupportedArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yolo') continue;
    if (arg === '-m' || arg === '--output-format' || arg === '-o') {
      i += 1;
      continue;
    }
    if (
      typeof arg === 'string'
      && (arg.startsWith('-m=') || arg.startsWith('--output-format=') || arg.startsWith('-o='))
    ) {
      continue;
    }
    out.push(arg);
  }
  return out;
}
