/**
 * Antigravity (`agy`) CLI provider helpers: id and sentinel constants plus `isAntigravityCommand` and
 * `isAntigravityCliProvider` predicates.
 */

import {
  ANTIGRAVITY_CLI_ID,
  ANTIGRAVITY_COMMAND,
  ANTIGRAVITY_PRINT_FLAGS,
  stripAntigravityUnsupportedArgs,
} from './aiToolkit/internal/antigravity.js';
import { buildEffortArgs, extractBakedModel, hasModelFlag, resolveCliEffort, resolveCliModel, splitAntigravityModel, stripBrokenModelFlags } from './provider/providerModels.js';

export {
  ANTIGRAVITY_CLI_ID,
  ANTIGRAVITY_COMMAND,
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  ANTIGRAVITY_PRINT_FLAGS,
  ANTIGRAVITY_TUI_ID,
  LEGACY_GEMINI_CLI_ID,
  LEGACY_GEMINI_TUI_ID,
  isAntigravityCliProvider,
  isAntigravityCommand,
  isAntigravityModelId,
  parseAntigravityModelList,
  stripAntigravityUnsupportedArgs,
} from './aiToolkit/internal/antigravity.js';

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
  const provider = { id: ANTIGRAVITY_CLI_ID, command: ANTIGRAVITY_COMMAND, models };
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
