/** Vendor dispatch for interactive and headless CLI invocations. */
import { DEFAULT_TUI_COMMAND, PROVIDER_VENDORS, matchesProvider, assertExecutionOptionHarness } from './providerVendorRegistry.js';
import { prepareGrokPromptFile } from '../grok.js';
import { resolveCliModel, resolveInjectedTuiModel, hasModelFlag, buildEffortArgs } from './providerModels.js';

export { PROVIDER_VENDORS } from './providerVendorRegistry.js';
export { claudeMessagesOneShotArgs } from './providerOneShotRecipes.js';
export {
  toolFreeOneShotArgs,
  restrictedRepairArgs,
  isToolFreeOneShotProvider,
  imageReadOneShotArgs,
  canReadImagesOneShot,
  isAuthoringOneShotProvider,
  toolFreeOneShotRefusal
} from './providerOneShotArgs.js';
export {
  publicReviewRecipe,
  buildVendorSpawnConfig,
  publicReviewPosturesForProvider,
  enforcedPublicReviewPosturesForProvider,
  publicReviewCapableVendorIds,
  supportsPublicReviewPosture,
  publicReviewProviderBlock,
  supportsPublicReviewProvider,
  codeReviewTier,
  buildCodeReviewSpawnConfig,
  supportsPublicReviewActionsProvider,
  supportsTuiPublicReviewPosture,
  supportsTuiPublicReviewActionsProvider
} from './providerPublicReview.js';
export {
  isPublicReviewNoToolProfile,
  publicReviewPostureForProfile,
  PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
  PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
} from '../agent/agentExecutionProfiles.js';

/**
 * `inferTuiCommand`'s id-substring walk (tuiHandshake.js) checks a DIFFERENT
 * thing than every other dispatch site here — `provider.id` substrings, not
 * `provider.command` basenames — so it can't reuse `matchCommand`/`.find()`.
 * It still sources every returned command string from `PROVIDER_VENDORS`
 * (via `idFragment`/`inferredCommand`) so it can't independently drift; only
 * `claude` has no `idFragment` (it's the true fallback below, not matched by
 * substring).
 */
export function inferTuiCommand(id) {
  if (!id) return DEFAULT_TUI_COMMAND;
  for (const vendor of PROVIDER_VENDORS) {
    if (vendor.matchId ? vendor.matchId(id) : vendor.idFragment && id.includes(vendor.idFragment)) return vendor.inferredCommand;
  }
  return DEFAULT_TUI_COMMAND;
}

/**
 * `applyCommandDefaults` (tuiHandshake.js): interactive-session flag dispatch.
 * Public-review stages never reach this — headless OR attachable, their argv
 * comes from `buildVendorSpawnConfig`, which is where a posture is enforced.
 * (That is load-bearing for the attachable case: `ensureAntigravityTuiArgs` and
 * friends append `--dangerously-skip-permissions`-class defaults, which would
 * undo the recipe.)
 *
 * `provider` carries the record-level facts a command name cannot — the codex
 * `ignoreUserConfig` pin and its local-runtime backing. Passing it here keeps
 * BOTH TUI spawn paths on one injection point, which is the whole reason this
 * dispatcher exists (see the `injectTuiModelAndEffort` note below for what
 * happened the last time an argv rule lived in only one of them).
 */
export function applyCommandDefaults(command, args, provider = null) {
  const vendor = PROVIDER_VENDORS.find((v) => v.tuiArgs && v.matchCommand(command));
  assertExecutionOptionHarness(provider, vendor?.id);
  if (!vendor) return args;
  // `provider` is optional and only some vendors read it (codex, for the
  // `ignoreUserConfig` pin and the local-runtime backing) — a vendor that
  // ignores the second argument keeps behaving exactly as before.
  return vendor.tuiArgs(args, provider);
}

/**
 * `prepareCliPrompt` (cliProviderArgs.js): spawn-time prompt delivery.
 * `prepareGrokPromptFile` is the universal DEFAULT (not gated on grok, per its
 * own doc comment — it's a no-op for any argv that isn't its own /dev/stdin
 * sentinel, so calling it unconditionally as the fallback is safe and matches
 * the original `prepareCliPrompt` body exactly).
 *
 * `options` carries the spawn facts an argv BUILDER cannot know because they
 * are decided per run rather than per provider — today just `cwd`, which
 * OpenChamber needs as the `--dir` its control plane cannot infer (see
 * openchamber.js). Every other vendor ignores it.
 */
export function prepareCliPrompt(command, args, prompt, options = {}) {
  const vendor = PROVIDER_VENDORS.find((v) => v.preparePrompt && v.matchCommand(command));
  return vendor ? vendor.preparePrompt(args, prompt, options) : prepareGrokPromptFile(args, prompt);
}

/** `buildCliArgs` (cliProviderArgs.js): headless one-shot argv per vendor. */
export function buildVendorCliArgs(provider, baseArgs, { model, effort, toolFree = false }) {
  const vendor = PROVIDER_VENDORS.find((v) => v.cliArgs && matchesProvider(v, provider));
  assertExecutionOptionHarness(provider, vendor?.id);
  return vendor.cliArgs(baseArgs, { model, effort, provider, toolFree });
}

/**
 * Shared TUI model+effort injection — the piece that had ALREADY drifted once
 * before #3618 was filed (an antigravity Bedrock exemption landed in
 * `tuiHandshake.js#buildTuiInvocation` and was missed in
 * `agentTuiSpawning.js#appendModelArgs`). Both call sites now call this one
 * function instead of hand-duplicating the antigravity-vs-everyone-else split.
 *
 * `baseArgs` must already be the POST-`applyCommandDefaults` argv (posture
 * flags applied) — this only handles `--model`/`--effort` injection.
 */
export function injectTuiModelAndEffort(command, baseArgs, provider, model, effort) {
  const identity = { id: provider?.id, command };
  const vendor = PROVIDER_VENDORS.find((row) => row.injectTuiModel &&
    (row.matchTuiModelProvider ? row.matchTuiModelProvider(identity) : row.matchCommand(command)));
  if (vendor) return vendor.injectTuiModel(baseArgs, { provider, command, model, effort });
  const effectiveModel = resolveCliModel(model);
  const shouldInject = !!effectiveModel && !hasModelFlag(baseArgs);
  // Per-command model rewriting (OpenCode namespacing, Bedrock mapping) lives
  // in resolveInjectedTuiModel, shared across both TUI spawn paths so they
  // can't diverge again.
  const withModel = shouldInject
    ? [...baseArgs, '--model', resolveInjectedTuiModel(effectiveModel, provider, command)]
    : baseArgs;
  return [...withModel, ...buildEffortArgs(
    effort,
    { id: provider?.id, command },
    withModel,
    effectiveModel,
  )];
}

// Every command a shipped vendor row resolves to, PLUS legacy/custom commands
// with no corresponding PROVIDER_VENDORS row (no vendor file, no dispatch
// special-casing — just historically allowlisted). allowedCommands.js derives
// its Set from this so a new vendor row automatically becomes spawnable
// without a second hand-maintained list.
export const EXTRA_ALLOWED_COMMANDS = ['aider', 'copilot'];
