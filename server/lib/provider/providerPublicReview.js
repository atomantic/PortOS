/** Select and enforce vendor recipes for public-content and read-only code review. */
import { isProcessProvider, providerLabel } from './providerTypes.js';
import {
  publicReviewPostureForProfile,
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
  PUBLIC_REVIEW_POSTURES,
} from '../agent/agentExecutionProfiles.js';
import { PROVIDER_VENDORS, matchesProvider, assertExecutionOptionHarness } from './providerVendorRegistry.js';

/**
 * The vendor recipe enforcing `posture` for `provider`, or null when this
 * install has no maintained recipe for that pairing.
 *
 * Eligibility is DECLARED by the vendor row, never named by the caller: a
 * pipeline stage asks for a posture and every enabled provider whose vendor
 * declares it is a legal choice. That is what lets an install with only grok
 * (or only a local Claude wrapper) configure the same stages an install with
 * codex configures. A row's matcher must positively identify the binary —
 * claude's `matchCommand` is unconditionally true (it is the historical
 * fallback row), so an unknown command must never inherit its argv.
 */
export function publicReviewRecipe(provider, posture) {
  if (!PUBLIC_REVIEW_POSTURES.includes(posture)) return null;
  for (const vendor of PROVIDER_VENDORS) {
    const recipe = vendor.publicReview?.[posture];
    if ((recipe?.spawnArgs || recipe?.tuiSpawnArgs) && recipe.matchProvider(provider)) return recipe;
  }
  return null;
}

/**
 * `buildCliSpawnConfig` (agentCliSpawning.js): full `{ command, args,
 * stdinMode, streamFormat? }` shape per vendor. Requires `spawnArgs` to be
 * defined on the matched row — `gemini-legacy` deliberately has none, so a
 * gemini-cli provider here falls through to `claude`'s row, exactly as it did
 * before this registry existed (see file header).
 */
export function buildVendorSpawnConfig(provider, ctx) {
  assertExecutionOptionHarness(provider, PROVIDER_VENDORS.find((v) => matchesProvider(v, provider))?.id);
  const posture = publicReviewPostureForProfile(ctx?.safetyProfile);
  if (posture) {
    const recipe = publicReviewRecipe(provider, posture);
    if (!supportsPublicReviewPosture(provider, posture)) {
      throw new Error(`Provider '${providerLabel(provider)}' has no enforced ${posture} public-review posture`);
    }
    // An interactive spawn has no headless fallback tier: the ordinary
    // `spawnArgs` of a vendor without a TUI-capable recipe emits that vendor's
    // HEADLESS argv (`--print`, `exec`, `run`), which in a PTY neither accepts
    // a pasted prompt nor enforces anything. Fail closed rather than open a
    // session whose posture is decorative. Callers decide TUI-vs-headless from
    // `supportsTuiPublicReviewPosture`, so reaching this is a routing bug.
    if (ctx?.tui) {
      if (!recipe?.tuiSpawnArgs) {
        throw new Error(`Provider '${providerLabel(provider)}' has no attachable ${posture} public-review recipe`);
      }
      return recipe.tuiSpawnArgs(provider, ctx);
    }
    return recipe.spawnArgs(provider, ctx);
  }
  const vendor = PROVIDER_VENDORS.find((v) => v.spawnArgs && matchesProvider(v, provider));
  return vendor.spawnArgs(provider, ctx);
}

/**
 * Every public-review posture this provider can actually be configured for,
 * in `PUBLIC_REVIEW_POSTURES` order. This is the value the schedule UI reads to
 * offer a stage's eligible providers, so it must stay derived from the vendor
 * rows rather than from a hardcoded list of vendor names.
 *
 * API/custom providers have no maintained recipe: a generic read-only prompt
 * is not enforcement, so they fail closed. A TUI record IS eligible — the
 * stage spawns its binary through the vendor's enforced recipe, headless unless
 * that recipe also supplies `tuiSpawnArgs` (see `isProcessProvider` and
 * `supportsTuiPublicReviewPosture`).
 */
export function publicReviewPosturesForProvider(provider) {
  return PUBLIC_REVIEW_POSTURES.filter((posture) => supportsPublicReviewPosture(provider, posture));
}

/**
 * The subset of `publicReviewPosturesForProvider` backed by a vendor-enforced
 * recipe; the schedule UI uses the difference to say which actions-stage
 * choices are OS-sandboxed and which rely on the worktree alone.
 */
export function enforcedPublicReviewPosturesForProvider(provider) {
  return PUBLIC_REVIEW_POSTURES.filter((posture) => enforcesPublicReviewPosture(provider, posture));
}

// A row that supplies the HEADLESS argv is an enforcement; one that supplies
// only an attachable invocation (OpenCode's actions row) is not — the stage
// still falls through to the vendor's ordinary argv and the schedule UI keeps
// reporting that choice as worktree-only rather than OS-sandboxed.
const enforcesPublicReviewPosture = (provider, posture) => (
  isProcessProvider(provider) && Boolean(publicReviewRecipe(provider, posture)?.spawnArgs)
);

/**
 * Vendor ids that declare a maintained recipe for `posture`, for naming what a
 * user could install when nothing on their machine qualifies. Derived from the
 * rows so the suggestion cannot go stale when a vendor gains or loses a recipe.
 */
export function publicReviewCapableVendorIds(posture) {
  return PROVIDER_VENDORS.filter((vendor) => vendor.publicReview?.[posture]?.spawnArgs).map((vendor) => vendor.id);
}

/**
 * Whether `provider` may run a stage with this posture.
 *
 * The no-tool gate requires a maintained recipe: only an enforced argv can
 * hold a model tool-free. Actions require a maintained enforcement recipe too:
 * a disposable worktree cannot stop malware reading host files or networking.
 * API providers have no binary to spawn and fail closed for these CLI profiles.
 */
export function supportsPublicReviewPosture(provider, posture) {
  return enforcesPublicReviewPosture(provider, posture);
}

/**
 * The spawn-time gate for a public-content stage, as a block or `null`.
 *
 * Takes the POSTURE (what the stage requires), not a boolean, because the
 * caller's posture is `null` for every ordinary task — and `null` has no
 * recipe, so asking `supportsPublicReviewPosture` about it answers "false"
 * for work that was never public-content at all. Deciding here keeps the
 * "no posture requested" case explicit instead of a caller-side `&&` that a
 * refactor can drop (it was, in #5830: every ordinary agent task blocked with
 * "has no enforced null public-content review mode").
 *
 * @returns {{ reason: string, category: string }|null}
 */
export function publicReviewProviderBlock(provider, posture) {
  if (!posture) return null;
  if (supportsPublicReviewPosture(provider, posture)) return null;
  return {
    reason: `Provider '${providerLabel(provider)}' has no enforced ${posture} public-content review mode`,
    category: posture === PUBLIC_REVIEW_ACTIONS_POSTURE
      ? 'public-review-actions-provider-unsupported'
      : 'public-review-provider-unsupported',
  };
}

/** Whether a provider can run a tool-free public-content stage. */
export function supportsPublicReviewProvider(provider) {
  return supportsPublicReviewPosture(provider, PUBLIC_REVIEW_NO_TOOL_POSTURE);
}

/**
 * How a CLI code reviewer is held to reading, strongest first — or null when
 * the vendor maintains no enforced reviewer mode:
 *
 * - `no-tool`   — the vendor's no-tool public-review recipe (claude, grok, …).
 * - `read-only` — an enforced mode that may read but never write (codex's
 *                 OS-level read-only sandbox).
 *
 * Only code review consults the read-only tier; a no-tool pipeline stage still
 * requires the no-tool recipe. Antigravity has neither: live runs showed both
 * its `--mode plan` and its terminal `--sandbox` still write files, so it
 * must not be listed here as read-only.
 */
export function codeReviewTier(provider) {
  if (supportsPublicReviewProvider(provider)) return PUBLIC_REVIEW_NO_TOOL_POSTURE;
  return readOnlyReviewRecipe(provider) ? 'read-only' : null;
}

function readOnlyReviewRecipe(provider) {
  if (!isProcessProvider(provider)) return null;
  return PROVIDER_VENDORS.find((vendor) => vendor.readOnlyReview?.matchProvider(provider))?.readOnlyReview || null;
}

/**
 * Headless argv for the tier `codeReviewTier` names (`ctx` as for
 * `buildVendorSpawnConfig`), or null when the vendor has no enforced reviewer
 * mode and the caller must fall back to its ordinary argv.
 */
export function buildCodeReviewSpawnConfig(provider, ctx) {
  if (!supportsPublicReviewProvider(provider)) return readOnlyReviewRecipe(provider)?.spawnArgs(provider, ctx) || null;
  const config = buildVendorSpawnConfig(provider, ctx);
  const reshape = PROVIDER_VENDORS.find((vendor) => vendor.codeReviewSpawnConfig && matchesProvider(vendor, provider))?.codeReviewSpawnConfig;
  return reshape ? reshape(config) : config;
}

/** Whether a provider can run the sandboxed final public-review stage. */
export function supportsPublicReviewActionsProvider(provider) {
  return supportsPublicReviewPosture(provider, PUBLIC_REVIEW_ACTIONS_POSTURE);
}

/**
 * Whether `provider` may run a `posture` stage as an ATTACHABLE PTY session
 * rather than headless.
 *
 * Deliberately much narrower than `supportsPublicReviewPosture`: that one lets
 * the actions stage fall through to a vendor's ordinary headless recipe when it
 * declares none, which is fine for a `--print` child and useless in a PTY. An
 * interactive session requires a recipe that has been reviewed for it and
 * supplies `tuiSpawnArgs` — the argv a PTY can drive (for Claude the headless
 * argv minus the flags that only work under `--print`; for OpenCode a
 * different entry point entirely).
 *
 * `no-tool` is structurally excluded: an interactive session for a reasoner
 * with no tools buys nothing and widens the boundary for free, so no row
 * declares it and this returns false for that posture by construction.
 */
export function supportsTuiPublicReviewPosture(provider, posture) {
  return enforcesPublicReviewPosture(provider, posture) && Boolean(publicReviewRecipe(provider, posture)?.tuiSpawnArgs);
}

/** Whether the sandboxed final public-review stage can attach a PTY here. */
export function supportsTuiPublicReviewActionsProvider(provider) {
  return supportsTuiPublicReviewPosture(provider, PUBLIC_REVIEW_ACTIONS_POSTURE);
}
