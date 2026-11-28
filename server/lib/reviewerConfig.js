/**
 * Review-loop configuration, reviewer CLI and prompt contracts, and slashdo argv construction.
 */
import { isPlainObject } from './objects.js';
import { CODE_REVIEWERS_PAGE_BREADCRUMB } from './navManifest.js';
import { isTruthyMeta } from './metadataFlags.js';
import { EFFORT_LEVELS, buildEffortArgs, foldCursorEffortIntoModel, splitAntigravityModel } from './provider/providerModels.js';
import { providersForReviewer } from './reviewerProviderMatchers.js';
import { PR_COMPLETIONS } from './prDisposition.js';
import { activeReviewerGroupIndex } from './reviewerHealth.js';
import {
  BRACKET_MODEL_REVIEWERS,
  DEFAULT_REVIEWER,
  DEFAULT_REVIEWERS,
  DEFAULT_REVIEW_STOP_MODE,
  EFFORT_SELECTABLE_REVIEWERS,
  LOCAL_LLM_REVIEWERS,
  MAX_REVIEWER_MAX_ROUNDS,
  MAX_REVIEWER_MODEL_LENGTH,
  MODEL_SELECTABLE_REVIEWERS,
  PORTOS_ONLY_REVIEWERS,
  REVIEWER_ALIASES,
  REVIEWER_MODEL_FORBIDDEN_RE,
  isApplyCapableReviewer,
  isProviderReviewer,
  isReviewer,
  normalizeReviewUsernames,
  normalizeReviewerList,
  normalizeReviewers,
  resolveProviderReviewerSlug,
  reviewerCliBinary,
  reviewerEffortLevels,
} from './reviewerVocabulary.js';

export {
  APPLY_CAPABLE_REVIEWERS,
  BRACKET_MODEL_REVIEWERS,
  DEFAULT_REVIEWER,
  DEFAULT_REVIEWERS,
  DEFAULT_REVIEW_STOP_MODE,
  EFFORT_SELECTABLE_REVIEWERS,
  LOCAL_LLM_EFFORT_LEVELS,
  LOCAL_LLM_REVIEWERS,
  MAX_REVIEWER_MAX_ROUNDS,
  MAX_REVIEWER_MODEL_LENGTH,
  MAX_REVIEW_USERNAMES,
  MODEL_CAPABLE_CLI_REVIEWERS,
  MODEL_SELECTABLE_REVIEWERS,
  PORTOS_ONLY_REVIEWERS,
  REVIEWER_ALIASES,
  REVIEWER_CLI_BINARIES,
  REVIEWER_EFFORT_LEVELS,
  REVIEWER_LIST_OVERRIDE_KEYS,
  REVIEWER_OVERRIDE_KEYS,
  REVIEWER_VALUES,
  REVIEW_STOP_MODES,
  hasReviewerOverride,
  isApplyCapableReviewer,
  isProviderReviewer,
  isReviewer,
  normalizeReviewUsernames,
  normalizeReviewerList,
  normalizeReviewers,
  resolveProviderReviewerSlug,
  reviewerCliBinary,
  reviewerEffortLevels,
} from './reviewerVocabulary.js';
export { isReviewerConfigFault } from './reviewerHealth.js';

// Legacy name: identifies bridge-dispatched reviewers, not an enforced tool policy.
export const isToolFreeReviewer = (value) => LOCAL_LLM_REVIEWERS.includes(value) || isProviderReviewer(value);

/**
 * What an agent does with a review that could not return a verdict: say so in the run summary, and
 * leave the PR/MR thread alone. A comment announcing "the review was unavailable, so this is left
 * open" is noise on a PR a human still has to read — it restates the absence of a review they can
 * already see, and every reopened thread costs them a notification.
 */
export const REVIEW_UNAVAILABLE_REPORTING_NOTE = 'Report the pending review in your run summary — do NOT post a PR/MR comment saying the review was unavailable or inconclusive.';

/**
 * How a claim run waits on a forge reviewer (`@login`). That reviewer is often a person, so a few
 * minutes of polling is not a wait: the run would give up long before they look.
 */
export const FORGE_REVIEWER_WAIT_NOTE = 'An `@<login>` is often a person, not a bot: after requesting the review, wait for it with blocking polls of at most 9 minutes each (check once a minute inside, counting only a review that login submitted on the current head commit), and keep repeating them for up to 4 hours per round. Do not end the run, skip the reviewer, or treat it as clean while that wait runs. Each review is a round: fix every comment, push, reply to and resolve its threads, then re-request their review. Only their approval of the current head satisfies them; changes requested or comments start the next round. No review after 4 hours is unsatisfied, not clean.';

/**
 * What an agent does when EVERY configured reviewer returned a config fault: distinguish it from
 * clean in the run summary, so the operator sees "no reviewer reviewed this branch" rather than a
 * silent success. One exported sentence for the same reason as
 * `REVIEW_UNAVAILABLE_REPORTING_NOTE`: the rule reaches prompt sites and run-summary builders, and
 * spelled out at each one it drifts.
 */
export const ZERO_REVIEWER_COVERAGE_NOTE = `No reviewer reviewed this branch — every configured reviewer returned a configuration fault. The review loop is currently a no-op. Check ${CODE_REVIEWERS_PAGE_BREADCRUMB} for the setting that fixes each reviewer.`;

/**
 * Vendors PortOS can spawn that are deliberately NOT reviewers, each mapped to the reason. The
 * shared roster claims to cover every spawnable vendor; this is the other half of that claim, and
 * `reviewerConfig.test.js` fails on a `PROVIDER_VENDORS` id that appears in neither — so a future
 * vendor is either offered as a reviewer or has its exclusion written down, instead of being
 * silently missing from ten hand-maintained lists.
 */
export const NON_REVIEWER_VENDORS = Object.freeze({
  'gemini-legacy': 'a retired row kept only so an old stored config still resolves — Gemini CLI was migrated to Antigravity and ships no binary of its own',
  hermes: 'a reviewer reads untrusted diff text, which needs a no-tool posture, and Hermes has no switch that disables its tools (--toolsets only enables sets), so no enforced public-review recipe exists for it',
  openchamber: "a reviewer is a one-shot critique of a diff, and OpenChamber's only prompt path creates a persistent session inside a running workspace runtime the user owns — a review round would leave a session behind per reviewer per PR, and cannot run at all when that runtime is down",
});

// The `--model` flag a CLI reviewer's binary actually spells. Only a reviewer that deviates from
// `--model` appears; `reviewerModelFlag` supplies the default for the rest.
const REVIEWER_MODEL_FLAGS = { opencode: '-m' };

/**
 * The flag a CLI reviewer's pinned model must be passed with (`--model` unless that reviewer's
 * binary spells it differently). Accepts the `gemini` alias.
 * @param {string} reviewer - reviewer slug
 * @returns {string}
 */
export function reviewerModelFlag(reviewer) {
  const slug = typeof reviewer === 'string' ? reviewer.trim().toLowerCase() : '';
  return REVIEWER_MODEL_FLAGS[REVIEWER_ALIASES[slug] ?? slug] || '--model';
}

/**
 * Is this reviewer a CLI the agent spawns itself? Derived by EXCLUSION rather than from
 * REVIEWER_CLI_BINARIES so a newly added CLI reviewer still drives the review loop before anyone
 * remembers to map its binary (the map's coverage is pinned separately by reviewerConfig.test.js).
 * @param {string} reviewer - reviewer slug
 * @returns {boolean}
 */
export function isCliReviewer(reviewer) {
  return reviewer !== DEFAULT_REVIEWER && !isToolFreeReviewer(reviewer);
}

/**
 * Render a reviewer slug for an agent prompt as the command it must actually run, keeping the slug
 * visible so the text still lines up with the configured reviewer list and slashdo's
 * `--review-with` token. `antigravity` → `` `agy` (the `antigravity` reviewer)``; every other
 * reviewer, whose binary equals its slug, → `` `codex` `` with no redundant restatement.
 * @param {string} reviewer - reviewer slug
 * @returns {string} markdown fragment
 */
export function describeReviewerCli(reviewer) {
  if (typeof reviewer !== 'string' || !reviewer) return '';
  const binary = reviewerCliBinary(reviewer);
  if (!binary || binary === reviewer) return `\`${reviewer}\``;
  return `\`${binary}\` (the \`${reviewer}\` reviewer)`;
}

/**
 * Resolve reviewer usernames with task-over-default precedence: a task-level list (even explicitly
 * empty) overrides the Code Review Defaults; only fall back to the defaults when the task didn't
 * pin its own. Mirrors how `normalizeReviewers`'s fallback param works for the keyed reviewers.
 */
export function resolveReviewUsernames(metadataUsernames, defaultUsernames) {
  return Array.isArray(metadataUsernames)
    ? normalizeReviewUsernames(metadataUsernames)
    : normalizeReviewUsernames(defaultUsernames);
}

/**
 * Normalize ONE raw reviewer identity to the exact token `--review-with` emits: a keyed slug from
 * `REVIEWER_VALUES` (aliasing `gemini` → `antigravity`) or an `@<username>`. Returns null for
 * anything else.
 */
function normalizeReviewerToken(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('@')) {
    const [user] = normalizeReviewUsernames([trimmed]);
    return user ? `@${user}` : null;
  }
  const slug = REVIEWER_ALIASES[trimmed] ?? trimmed;
  return isReviewer(slug) ? slug : null;
}

/**
 * This is the escape hatch for a valuable-but-flaky reviewer (a local Ollama model that often
 * returns nothing) that would otherwise strand every PR on an `inconclusive` aggregate. Each entry
 * mirrors an *emitted* `--review-with` token so the builder's membership test is a plain lookup: a
 * keyed slug from `REVIEWER_VALUES` (`ollama`, `lmstudio`, …) or an `@<username>`.
 */
export function normalizeOptionalReviewers(list) {
  if (!Array.isArray(list)) return undefined;
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const token = normalizeReviewerToken(raw);
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

/**
 * Resolve optional (non-blocking) reviewers with task-over-default precedence: a task-level list
 * (even explicitly empty) overrides the Code Review Defaults; only fall back to the defaults when
 * the task didn't pin its own. Mirrors `resolveReviewUsernames`.
 */
export function resolveOptionalReviewers(metadataOptional, defaultOptional, { taskReviewers } = {}) {
  const defaults = normalizeOptionalReviewers(defaultOptional) || [];
  if (!Array.isArray(metadataOptional)) return defaults;
  const own = normalizeOptionalReviewers(metadataOptional) || [];
  if (!Array.isArray(taskReviewers)) return own;
  const pinned = optionalReviewerSet(taskReviewers);
  const ownSet = new Set(own.map(token => token.toLowerCase()));
  return [...own, ...defaults.filter(token => !pinned.has(token.toLowerCase()) && !ownSet.has(token.toLowerCase()))];
}

/**
 * The reviewer tokens a task's own metadata pins — its `reviewers` list (or legacy `reviewer`)
 * plus `@<login>` for an explicit `usernames` list. Everything else in the resolved roster was
 * inherited from the Code Review Defaults.
 */
export function taskPinnedReviewerTokens(metadata) {
  const raw = isPlainObject(metadata) ? metadata : {};
  const reviewers = Array.isArray(raw.reviewers) ? raw.reviewers
    : (typeof raw.reviewer === 'string' && raw.reviewer ? [raw.reviewer] : []);
  const usernames = Array.isArray(raw.usernames) ? normalizeReviewUsernames(raw.usernames).map(user => `@${user}`) : [];
  return [...reviewers, ...usernames];
}

/**
 * True when `reviewer` is one the user marked `~opt` (non-blocking). Both sides go through
 * `normalizeReviewerToken` first, so this answers the same question `buildReviewWithArgs` answers
 * when it decides whether to append `~opt` — an alias on one side (`gemini` vs `antigravity`)
 * can't make the emitted flag and the merge gate disagree about the same configuration.
 */
export function isOptionalReviewer(reviewer, optionalReviewers) {
  const token = normalizeReviewerToken(reviewer);
  return token !== null && optionalReviewerSet(optionalReviewers).has(token.toLowerCase());
}

/**
 * True when at least one of `reviewers` is NOT marked optional — i.e. some reviewer's verdict
 * genuinely gates the merge. The inverse ("every configured reviewer is `~opt`") is what the gates
 * read: a phase with no binding reviewer can never record `review-blocked`, and the completion
 * workflow tells such a run not to invent a blocker from a reviewer that returned nothing.
 */
export function hasRequiredReviewer(reviewers, optionalReviewers) {
  const optional = optionalReviewerSet(optionalReviewers);
  return (Array.isArray(reviewers) ? reviewers : []).some(reviewer => {
    const token = normalizeReviewerToken(reviewer);
    return token === null || !optional.has(token.toLowerCase());
  });
}

/**
 * Factory for the token-keyed per-reviewer PIN normalizers (`~max=<n>` caps, model ids, reasoning
 * efforts). All three share one contract and only differ in how they validate a single value, so
 * the contract lives here once: - Non-object input → `undefined`, so an omitted field isn't
 * persisted as an empty override (an explicitly empty `{}` IS kept — it's a real "clear the
 * defaults for this task" choice). - Keys are normalized to the exact token `--review-with` emits
 * (`normalizeReviewerToken`), so the maps can't disagree about what a reviewer is called; unknown
 * tokens are dropped. - First spelling wins for two names of one reviewer (`gemini`/`antigravity`,
 * `@Bot`/`@bot`) — mirrors `normalizeOptionalReviewers`' dedupe. - A value `normalizeOne` rejects
 * is DROPPED, never coerced — for every pin kind, "absent" and "a falsy value" mean different
 * things downstream.
 * @param {(value: unknown, token: string) => unknown} normalizeOne - returns the
 *   validated value, or a falsy value to drop the entry.
 */
function keyedReviewerPinNormalizer(normalizeOne) {
  return (map) => {
    if (!isPlainObject(map)) return undefined;
    const out = Object.create(null);
    for (const [rawKey, rawValue] of Object.entries(map)) {
      const token = normalizeReviewerToken(rawKey);
      if (!token) continue;
      const value = normalizeOne(rawValue, token);
      if (!value && value !== 0) continue;
      if (Object.hasOwn(out, token)) continue;
      out[token] = value;
    }
    return { ...out };
  };
}

/**
 * Factory for the matching task-over-default resolvers: a task-level map — even an explicitly
 * empty one — overrides the Code Review Defaults; only an absent/malformed one falls back. Mirrors
 * `resolveOptionalReviewers`.
 * @param {(map: unknown) => Object|undefined} normalizeMap - the normalizer this
 *   pin kind was built with.
 */
function keyedReviewerPinResolver(normalizeMap) {
  return (metadataMap, defaultMap) => (isPlainObject(metadataMap)
    ? (normalizeMap(metadataMap) || {})
    : (normalizeMap(defaultMap) || {}));
}

/**
 * Per-reviewer iteration caps — slashdo's `~max=<n>` suffix (v3.25.0). Caps how many review → fix
 * → re-review cycles ONE reviewer runs before it stops, so a slow local model can be included in a
 * chain without paying for its otherwise hardcoded 3 rounds (`--review-with
 * claude~max=2,ollama~max=1,codex~max=3`).
 */
export const normalizeReviewerMaxRounds = keyedReviewerPinNormalizer((rawValue) => (
  // Only a genuine non-negative integer is a cap. A string "2", null, NaN, or 1.5 is not — and
  // must NOT fall through to 0, which slashdo reads as "unlimited".
  (Number.isInteger(rawValue) && rawValue >= 0 && rawValue <= MAX_REVIEWER_MAX_ROUNDS)
    ? rawValue
    : undefined
));

/**
 * Resolve per-reviewer iteration caps with task-over-default precedence: a task-level map (even
 * explicitly empty) overrides the Code Review Defaults; only fall back to the defaults when the
 * task didn't pin its own. Mirrors `resolveOptionalReviewers`.
 */
export const resolveReviewerMaxRounds = keyedReviewerPinResolver(normalizeReviewerMaxRounds);

/**
 * Validate ONE reviewer model id — the single definition shared by the token-keyed map normalizer,
 * the `<reviewer>Model` settings scalars, and the defaults→map adapter, so a pin can't be accepted
 * by one path and dropped by another (which would show the user a stored pin that never reaches a
 * reviewer). Returns the trimmed id, or `undefined` when it isn't usable: a non-string, a
 * blank/whitespace-only value (absent ≠ `''` — a `--model ` with no id would break the
 * invocation), an over-long one, one carrying a structural delimiter, or one naming a reviewer
 * that takes no model.
 */
export function normalizeReviewerModel(raw, reviewer = null) {
  if (reviewer !== null && !MODEL_SELECTABLE_REVIEWERS.includes(reviewer) && !isProviderReviewer(reviewer)) return undefined;
  if (typeof raw !== 'string') return undefined;
  const model = raw.trim();
  if (!model || model.length > MAX_REVIEWER_MODEL_LENGTH) return undefined;
  if (REVIEWER_MODEL_FORBIDDEN_RE.test(model)) return undefined;
  return model;
}

/**
 * Per-reviewer model pins — the model id ONE reviewer runs with, keyed by the same emitted
 * `--review-with` token as `normalizeOptionalReviewers` / `normalizeReviewerMaxRounds` (e.g. `{
 * codex: 'gpt-5.6-sol', ollama: 'qwen2.5:7b' }`).
 */
export const normalizeReviewerModels = keyedReviewerPinNormalizer(normalizeReviewerModel);

/**
 * Resolve per-reviewer model pins with task-over-default precedence: a task-level map (even
 * explicitly empty) overrides the Code Review Defaults; only fall back to the defaults when the
 * task didn't pin its own. Mirrors `resolveReviewerMaxRounds`.
 */
export const resolveReviewerModels = keyedReviewerPinResolver(normalizeReviewerModels);

/**
 * Fold the Code Review Defaults' per-reviewer model SCALARS (`codexModel` / `claudeModel` /
 * `lmstudioModel` / `ollamaModel`) into the token-keyed map shape the resolvers and the picker UI
 * both speak. The scalars are the persisted settings encoding and stay that way — they cross
 * installs, and rewriting them to a map would need a migration for zero gain.
 */
export function reviewerModelsFromDefaults(defaults) {
  const out = Object.fromEntries(Object.entries(normalizeReviewerModels(defaults?.providerModels) || {}).filter(([key]) => isProviderReviewer(key)));
  for (const r of MODEL_SELECTABLE_REVIEWERS) {
    // Re-checked here, not trusted: settings.json is hand-editable, and a value stored before the
    // scalars were validated must not surface as a pin the token builders would then drop.
    const model = normalizeReviewerModel(defaults?.[`${r}Model`], r);
    if (model) out[r] = model;
  }
  return out;
}

/**
 * Validate ONE reviewer effort — the single definition shared by the token-keyed map normalizer
 * and the `<reviewer>Effort` settings scalars, so a level can't be accepted by one path and
 * dropped by another. `reviewer` is REQUIRED — this is the tight branch by design.
 * @param {string} raw - raw effort value
 * @param {string} reviewer - reviewer slug
 * @param {string|null|undefined} [model] - optional pinned model id
 * @returns {string|undefined}
 */
export function normalizeReviewerEffort(raw, reviewer, model = null, catalog = []) {
  if (typeof raw !== 'string') return undefined;
  const effort = raw.trim().toLowerCase();
  if (!effort) return undefined;
  // Provider identities are dynamic; their model-specific ladder is resolved from the provider
  // catalog at selection/execution, while storage accepts known tiers.
  const levels = isProviderReviewer(reviewer) ? EFFORT_LEVELS : reviewerEffortLevels(reviewer, model, catalog);
  return levels?.includes(effort) ? effort : undefined;
}

/**
 * Per-reviewer reasoning-effort pins — how hard ONE reviewer thinks, keyed by the same emitted
 * `--review-with` token as `normalizeReviewerModels` (e.g. `{ codex: 'high', ollama: 'low' }`).
 */
export function normalizeReviewerEfforts(map, models = {}, catalogs = {}) {
  const normalizedModels = normalizeReviewerModels(models) || {};
  return keyedReviewerPinNormalizer((value, reviewer) => normalizeReviewerEffort(value, reviewer, normalizedModels[reviewer], catalogs[reviewer]))(map);
}

// Storage has no provider I/O. Retain the known agy tier until execution can validate the
// model/catalog pair; the unknown/default runtime ladder stays narrow.
export function normalizeStoredReviewerEffort(value, reviewer) {
  if ((REVIEWER_ALIASES[reviewer] || reviewer) === 'antigravity' && typeof value === 'string' && value.trim().toLowerCase() === 'xhigh') return 'xhigh';
  return normalizeReviewerEffort(value, reviewer);
}
export const normalizeStoredReviewerEfforts = keyedReviewerPinNormalizer(normalizeStoredReviewerEffort);

export function reviewerCatalogsFromProviders(providers = []) {
  return { antigravity: [...new Set(providersForReviewer('antigravity', providers).flatMap(provider => provider.models || []))] };
}

/**
 * Resolve per-reviewer effort pins with task-over-default precedence: a task-level map (even
 * explicitly empty) overrides the Code Review Defaults; only fall back to the defaults when the
 * task didn't pin its own. Mirrors `resolveReviewerModels`.
 */
export const resolveReviewerEfforts = keyedReviewerPinResolver(normalizeReviewerEfforts);

/**
 * Resolve a task's whole reviewer configuration against the Code Review Defaults in one call — the
 * reviewer list plus every per-reviewer pin, each with the same task-over-default precedence its
 * own resolver defines. The prompt builder resolves this set at three separate spawn paths (the
 * review follow-up, the claim prompt, and the light/cleanup prompt).
 */
export function resolveReviewerConfig(metadata, codeReviewDefaults, defaultReviewers) {
  return {
    reviewers: resolveReviewerGroup(metadata, codeReviewDefaults, defaultReviewers),
    usernames: resolveReviewUsernames(metadata?.usernames, codeReviewDefaults?.usernames),
    optionalReviewers: resolveOptionalReviewers(metadata?.optionalReviewers, codeReviewDefaults?.optionalReviewers, { taskReviewers: taskPinnedReviewerTokens(metadata) }),
    reviewerMaxRounds: resolveReviewerMaxRounds(metadata?.reviewerMaxRounds, codeReviewDefaults?.reviewerMaxRounds),
    reviewerCatalogs: codeReviewDefaults?.reviewerCatalogs || {},
    ...resolveReviewerPins(metadata, codeReviewDefaults)
  };
}

/**
 * `resolveReviewerConfig` plus the two run flags the prompt builders need — the complete reviewer
 * configuration as ONE frozen value, so a prompt builder takes `reviewPolicy` instead of eight
 * parameters and a ninth knob is added here, not at every call site. - `forgeReviewerUsernames` —
 * the forge logins (`@user` review tokens) requested as PR/MR reviewers; the bare `usernames` of
 * `resolveReviewerConfig`. - `reviewStopMode` — task over Code Review Defaults over
 * `DEFAULT_REVIEW_STOP_MODE`. - `reviewerApplies` — the `--reviewer-applies` flag.
 * @param {Object|undefined} metadata - task metadata
 * @param {Object|null|undefined} codeReviewDefaults
 * @param {string[]|null|undefined} defaultReviewers
 * @param {Object} [opts]
 * @param {boolean} [opts.crossesPublicForge=false] - the run opens a PR/MR or is a
 *   review-loop follow-up over one
 */
export function resolveReviewPolicy(metadata, codeReviewDefaults, defaultReviewers, { crossesPublicForge = false } = {}) {
  const { usernames, ...config } = resolveReviewerConfig(metadata, codeReviewDefaults, defaultReviewers);
  const configuredReviewerApplies = metadata?.reviewerApplies != null
    ? isTruthyMeta(metadata.reviewerApplies)
    : (codeReviewDefaults?.reviewerApplies === true);
  return Object.freeze({
    ...config,
    forgeReviewerUsernames: usernames,
    reviewStopMode: metadata?.reviewStopMode || codeReviewDefaults?.stopMode || DEFAULT_REVIEW_STOP_MODE,
    reviewerApplies: crossesPublicForge ? false : configuredReviewerApplies
  });
}

/** The reviewer a claim flow falls back to when its resolved list is unusable. */
const CLAIM_REVIEWER_FALLBACK = ['codex'];

/**
 * An empty result falls back to `codex` rather than to `DEFAULT_REVIEWERS` (which is `copilot`,
 * the very thing being removed) — unless `usernames` names forge reviewers, which the run requests
 * and waits on itself.
 */
export function claimSafeReviewers(reviewers, usernames = []) {
  const kept = (Array.isArray(reviewers) ? reviewers : []).filter((reviewer) => reviewer !== 'copilot');
  // A forge reviewer the run requests and waits on is a reviewer it can invoke.
  if (!kept.length && normalizeReviewUsernames(usernames).length) return [];
  return kept.length ? kept : [...CLAIM_REVIEWER_FALLBACK];
}

/** Keep bridge-dispatched providers and local models ahead of standalone/forge reviewers. */
export function prioritizeToolFreeReviewers(reviewers) {
  const normalized = Array.isArray(reviewers) ? reviewers : [];
  return [
    ...normalized.filter((reviewer) => isToolFreeReviewer(reviewer)),
    ...normalized.filter((reviewer) => !isToolFreeReviewer(reviewer)),
  ];
}

/**
 * `resolveReviewerConfig` plus the claim flow's copilot guard and the emitted `--review-with`
 * token list — the ONE resolver a claim prompt's reviewer text and a claim task's persisted
 * `reviewers` metadata both go through, so the two cannot name different reviewers. The generators
 * resolve their list before a task record exists (they read schedule metadata + Code Review
 * Defaults); the prompt builder resolves it from the persisted task metadata at spawn time.
 */
export function resolveClaimReviewerConfig(metadata, codeReviewDefaults, defaultReviewers, providers = []) {
  if (metadata?.prCompletion === PR_COMPLETIONS.MERGE_ON_GREEN) {
    return {
      reviewers: [],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      reviewerModels: {},
      reviewerEfforts: {},
      csv: ''
    };
  }
  const config = resolveReviewerConfig(metadata, { ...codeReviewDefaults, reviewerCatalogs: providers.length ? reviewerCatalogsFromProviders(providers) : codeReviewDefaults?.reviewerCatalogs }, defaultReviewers);
  const reviewers = claimSafeReviewers(config.reviewers, config.usernames);
  return {
    ...config,
    reviewers,
    csv: buildReviewersCsv(reviewers, config.usernames, config.optionalReviewers, config.reviewerMaxRounds, config.reviewerModels, config.reviewerEfforts, providers, config.reviewerCatalogs)
  };
}

/**
 * Resolve the model and effort pins TOGETHER — `{ reviewerModels, reviewerEfforts }` with
 * task-over-default precedence, already reconciled into a pair the reviewer's CLI accepts
 * (`pairReviewerModelsAndEfforts`). The two are never legitimately resolved apart: an
 * `antigravity` model id can carry its effort as a suffix, so whoever resolves the models must
 * also be holding the efforts to hand the suffix to.
 * @param {Object} [pins] - task metadata (or explicit options) carrying
 *   `reviewerModels` / `reviewerEfforts` maps; an absent map falls back to the
 *   Code Review Defaults, an explicitly empty one overrides them.
 * @param {Object} [codeReviewDefaults] - the `<reviewer>Model` / `<reviewer>Effort` scalars
 * @returns {{reviewerModels: Object<string,string>, reviewerEfforts: Object<string,string>}}
 */
export function resolveReviewerPins(pins, codeReviewDefaults) {
  return pairReviewerModelsAndEfforts(
    resolveReviewerModels(pins?.reviewerModels, reviewerModelsFromDefaults(codeReviewDefaults)),
    isPlainObject(pins?.reviewerEfforts) ? pins.reviewerEfforts : reviewerEffortsFromDefaults(codeReviewDefaults),
    codeReviewDefaults?.reviewerCatalogs || {}
  );
}

/**
 * Reconcile the resolved model and effort pins into a pair the reviewer's CLI will actually
 * accept, and return them as `{ reviewerModels, reviewerEfforts }`. Only `antigravity` needs
 * reconciling.
 * @param {Object<string,string>} [reviewerModels]
 * @param {Object<string,string>} [reviewerEfforts]
 * @returns {{reviewerModels: Object<string,string>, reviewerEfforts: Object<string,string>}}
 */
export function pairReviewerModelsAndEfforts(reviewerModels, reviewerEfforts, catalogs = {}) {
  const models = { ...(reviewerModels || {}) };
  const efforts = { ...(reviewerEfforts || {}) };
  const { base, effort } = splitAntigravityModel(models.antigravity);
  if (effort && base) {
    models.antigravity = base;
    if (!normalizeReviewerEffort(efforts.antigravity, 'antigravity', base, catalogs.antigravity)) efforts.antigravity = effort;
  }
  return { reviewerModels: models, reviewerEfforts: normalizeReviewerEfforts(efforts, models, catalogs) || {} };
}

/**
 * Every token-keyed per-reviewer pin, as `[metadataKey, normalizeMap]`. The three pins share one
 * persist contract, so the two places that copy them out of caller input — `sanitizeTaskMetadata`
 * here and `addTask` in `cosTaskStore.js` — iterate this table instead of hand-copying a block per
 * pin.
 */
export const KEYED_REVIEWER_PINS = [
  ['reviewerMaxRounds', normalizeReviewerMaxRounds],
  ['reviewerModels', normalizeReviewerModels],
  ['reviewerEfforts', normalizeStoredReviewerEfforts]
];

/**
 * Fold the Code Review Defaults' per-reviewer effort SCALARS (`codexEffort` / `claudeEffort` /
 * `antigravityEffort` / `lmstudioEffort` / `ollamaEffort`) into the token-keyed map shape the
 * resolvers and the picker UI both speak — the effort twin of `reviewerModelsFromDefaults`, and
 * the one adapter between the two shapes. Configured providers use the additive `providerEfforts`
 * map.
 */
export function reviewerEffortsFromDefaults(defaults) {
  const out = Object.fromEntries(Object.entries(normalizeReviewerEfforts(defaults?.providerEfforts) || {}).filter(([key]) => isProviderReviewer(key)));
  for (const r of EFFORT_SELECTABLE_REVIEWERS) {
    // Re-checked, not trusted: settings.json is hand-editable, and a stale level is rejected;
    // catalog-dependent tiers are checked at execution resolution.
    const effort = normalizeStoredReviewerEffort(defaults?.[`${r}Effort`], r);
    if (effort) out[r] = effort;
  }
  return out;
}

/**
 * The argv fragment a CLI reviewer takes for a reasoning-effort override — `['--effort', 'high']`
 * for claude/agy, `['-c', 'model_reasoning_effort=high']` for codex, `[]` for everything else.
 * Delegates to `buildEffortArgs` so the flag shape has exactly one home (the spawn builders use
 * the same one).
 * @param {string} reviewer - reviewer slug
 * @param {string|null|undefined} effort
 * @param {string|null|undefined} [model] - optional pinned model id
 * @returns {string[]}
 */
export function reviewerEffortArgs(reviewer, effort, model = null, catalog = []) {
  const binary = reviewerCliBinary(reviewer);
  if (!binary) return [];
  const level = normalizeReviewerEffort(effort, reviewer, model, catalog);
  if (!level) return [];
  return buildEffortArgs(level, { id: reviewer, command: binary, models: catalog }, [], model);
}

/**
 * The id a CLI reviewer's `--model` flag should carry, or `null` when there is no model to pin.
 * The twin of `reviewerEffortArgs`: together they are the whole invocation a pinned reviewer
 * needs, and the ONLY place that knows which of the two carries a cursor effort.
 * @param {string} reviewer - reviewer slug
 * @param {string|null|undefined} model - the pinned model id
 * @param {string|null|undefined} [effort] - the pinned effort (cursor only)
 * @returns {string|null}
 */
export function reviewerModelArg(reviewer, model, effort) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id) return null;
  const slug = typeof reviewer === 'string' ? reviewer.trim().toLowerCase() : '';
  if ((REVIEWER_ALIASES[slug] ?? slug) !== 'cursor') return id;
  const level = normalizeReviewerEffort(effort, 'cursor');
  return level ? foldCursorEffortIntoModel(id, level) : id;
}

/**
 * Prose instruction carrying the per-reviewer effort pins into a prompt whose agent spawns the
 * reviewer CLI ITSELF — the claim flows (which run each configured reviewer by hand, no
 * `--review-with` anywhere in the prompt) and a slashdo invocation that pins no reviewer list.
 * **Not for an invocation that pins `--review-with`.** slashdo's entry grammar is
 * `<agent>[<model>](~opt|~max=<n>|~effort=<level>)*`, and `markSuffixes` emits that `~effort=`
 * suffix, so the pin already reaches the CLI the loop spawns.
 * @param {string[]} reviewers - the reviewer slugs the invocation emits
 * @param {Object<string, string>} [reviewerEfforts] - token-keyed effort pins
 * @param {Object} [options]
 * @param {string} [options.reviewWith] - the `--review-with` text this prompt
 *   emits, if any. A `~effort=` in it means slashdo already carries the pin.
 * @param {Object<string, string>} [options.reviewerModels] - token-keyed model
 *   pins, used for model-specific effort validation and Cursor rendering
 * @param {Object<string, string[]>} [options.reviewerCatalogs] - advertised model ids
 * @returns {string} a single sentence, or '' when nothing is left to say
 */
export function buildReviewerEffortNote(reviewers, reviewerEfforts = {}, { reviewWith = '', reviewerModels = {}, reviewerCatalogs = {} } = {}) {
  if (typeof reviewWith === 'string' && reviewWith.includes('~effort=')) return '';
  const efforts = normalizeReviewerEfforts(reviewerEfforts, reviewerModels, reviewerCatalogs) || {};
  const models = normalizeReviewerModels(reviewerModels) || {};
  const entries = (Array.isArray(reviewers) ? reviewers : [])
    .map((r) => {
      // No binary, nothing to name: `lmstudio`/`ollama` reach their backend over HTTP, and
      // copilot/@username aren't commands at all. Checked FIRST so no branch below can render a
      // `null` command into a prompt.
      const binary = reviewerCliBinary(r);
      if (!binary) return null;
      const args = reviewerEffortArgs(r, efforts[r], models[r], reviewerCatalogs[r]);
      if (args.length) return `\`${binary} ${args.join(' ')}\``;
      // No effort ARGV, but the reviewer may still carry the level inside --model (cursor). Gated
      // on the effort pin so this stays an effort note: a model-only pin is not this sentence's
      // business.
      if (!normalizeReviewerEffort(efforts[r], r)) return null;
      const model = reviewerModelArg(r, models[r], efforts[r]);
      return model ? `\`${binary} ${reviewerModelFlag(r)} ${model}\`` : null;
    })
    .filter(Boolean);
  if (!entries.length) return '';
  return `Invoke each reviewer CLI at its pinned reasoning effort: ${entries.join(', ')}. Pass the flag yourself when you spawn the reviewer — nothing else in this prompt applies it (a \`~effort=<level>\` suffix in a reviewer list is slashdo's own grammar, which only its \`--review-with\` parses).`;
}

/**
 * Prose budget for a prompt whose agent runs each reviewer by hand (the claim flows). The
 * `~max=<n>` suffix in `{reviewers}` is slashdo grammar that nothing parses there, so a configured
 * cap only binds when it is spelled out.
 * @param {string[]} reviewers - the reviewer tokens the prompt names
 * @param {Object<string, number>} [reviewerMaxRounds] - token-keyed caps
 * @param {string[]} [usernames] - forge reviewer logins; their caps are keyed `@login`
 *   and sit outside `reviewers`, so omitting them leaves a capped login at the default
 * @returns {string} a paragraph, or '' when no named reviewer carries a cap
 */
export function buildReviewerMaxRoundsNote(reviewers, reviewerMaxRounds = {}, usernames = []) {
  const lookup = reviewerMaxRoundsLookup(reviewerMaxRounds);
  const tokens = [...(Array.isArray(reviewers) ? reviewers : []), ...(Array.isArray(usernames) ? usernames : []).map((u) => `@${u}`)];
  const entries = [...new Set(tokens)]
    .filter((token) => lookup.has(String(token).toLowerCase()))
    .map((token) => {
      const max = lookup.get(String(token).toLowerCase());
      return `\`${token}\` → ${max === 0 ? 'loop until clean (no cap)' : `${max} round${max === 1 ? '' : 's'}`}`;
    });
  if (!entries.length) return '';
  return `**Review round caps (\`~max=<n>\` in the reviewer list):** these budgets replace any default round limit stated in the phases above, per reviewer: ${entries.join(', ')}. A round is one call to that reviewer plus the fixes it prompts; never call a reviewer more often than its budget, and a reviewer without a listed cap keeps the default stated above. When a budget is spent, stop calling that reviewer and advance — that is not a failure and not a reason to run another cycle. If findings remain at that point, fix each accepted one in the branch, or reject/track it with concrete rationale (a filed issue or a note in the PR body), and record in the PR body how many rounds each reviewer ran, the revision it last reviewed and what remained, without implying approval it did not give. An exhausted OPTIONAL reviewer budget never blocks opening the PR; hosting-provider required checks and reviews alone decide merge eligibility.`;
}

// Examples of slashdo commands that run a review loop and therefore resolve `--review-with` from a
// saved default when the invocation doesn't pin one. EXAMPLES, deliberately — the rule is stated
// over "any `/do:*` that reviews" because the real roster is larger and moves with the submodule
// (`/do:review`, `/do:better`, `/do:better-swift`, `/do:depfree`, `/do:release` all read it too).
const REVIEW_LOOP_SLASHDO_EXAMPLES_MD = ['/do:pr', '/do:next', '/do:review', '/do:rpr']
  .map(command => `\`${command}\``).join(', ');

/**
 * The reviewer slug inside an emitted `--review-with` token, without its `[<model>]` / `~<suffix>`
 * decoration — the inverse of `markSuffixes`, which is the only thing that ever builds one. Kept
 * beside its emitter, and pinned to it by a round-trip test, so a grammar change can't silently
 * mis-slug here.
 */
export const reviewerTokenSlug = (token) => String(token).split('[')[0].split('~')[0].trim().toLowerCase();

/**
 * Partition emitted `--review-with` tokens into the ones slashdo can parse and the ones PortOS
 * serves itself. slashdo's parser ABORTS the whole command on an unknown `--review-with` value, so
 * a PORTOS_ONLY_REVIEWERS slug in that flag doesn't degrade the run — it kills it, and the PR the
 * invocation existed to open never gets created.
 * @param {string[]} tokens - emitted reviewer tokens (decorated or bare)
 * @param {Array<object>} [providers] - configured provider records to resolve provider tokens
 * @returns {{flagTokens: string[], portosOnly: string[]}}
 */
export function splitSlashdoReviewerTokens(tokens, providers = []) {
  const trimmed = (Array.isArray(tokens) ? tokens : []).map(t => String(t).trim()).filter(Boolean);
  const isSlashdoToken = t => {
    if (t.startsWith('@')) return true;
    const rawSlug = reviewerTokenSlug(t);
    let effectiveSlug = rawSlug;
    if (isProviderReviewer(rawSlug)) {
      const providerId = rawSlug.slice('provider:'.length);
      const provider = Array.isArray(providers)
        ? providers.find(p => p && (p.id === providerId || `provider:${p.id}` === rawSlug))
        : null;
      effectiveSlug = resolveProviderReviewerSlug(provider, providerId);
      if (!effectiveSlug) return false;
    }
    return !PORTOS_ONLY_REVIEWERS.includes(effectiveSlug);
  };
  return {
    flagTokens: trimmed.filter(isSlashdoToken),
    portosOnly: [...new Set(trimmed.filter(t => !isSlashdoToken(t)).map(reviewerTokenSlug))],
  };
}

/**
 * Prose block pinning a claim prompt's reviewer list against slashdo's SAVED defaults. The claim
 * flows hand-run their reviewers, so the prompt names the list and emits no flag.
 * @param {string} reviewersCsv - the emitted reviewer token list
 * @returns {string} a Markdown block, or '' when there is no list to pin
 */
export function buildReviewerPinNote(reviewersCsv) {
  const csv = typeof reviewersCsv === 'string' ? reviewersCsv.trim() : '';
  if (!csv) return '';
  // A `@login` entry is always a valid slashdo reviewer; a keyed one is valid unless PortOS serves
  // it itself. Emitting a PORTOS_ONLY_REVIEWERS slug in a `--review-with` list would abort the
  // command outright, so it is dropped from the flag text and named separately with the procedure
  // that DOES run it.
  const { flagTokens, portosOnly } = splitSlashdoReviewerTokens(csv.split(','));

  return [
    '## Reviewer pin — use the reviewers PortOS configured',
    `PortOS resolved this run's reviewers from its own configuration: \`${csv}\`. That list is authoritative for every review in this run — it is the same list the phases above name. Never substitute a different reviewer set for it.`,
    flagTokens.length
      && `**A saved slashdo default must never stand in for it.** If you invoke ANY slashdo \`/do:*\` command that runs a review loop (${REVIEW_LOOP_SLASHDO_EXAMPLES_MD}, and others), pass \`--review-with ${flagTokens.join(',')}\` exactly as written: its \`[<model>]\`, \`~opt\`, \`~max=<n>\` and \`~effort=<level>\` suffixes already carry each reviewer's pins, so do not reapply them by hand. A bare invocation reads the host's saved defaults instead (\`.slashdo.json\` at the repo root, or the host CLI's \`.slashdo-config.json\`), which name a different reviewer set and can carry an auto-merge default this run never asked for.`,
    portosOnly.length
      && `PortOS runs \`${portosOnly.join('`, `')}\` itself — no slashdo slug, so never a \`--review-with\` value. That review happens through the Local Reviewer Procedure below, and leaving it out of a slashdo invocation is not permission to skip it.`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Build the set of lowercased optional-reviewer tokens for a fast membership test in the builders.
 * Tolerates the raw (unnormalized) list.
 */
function optionalReviewerSet(optionalReviewers) {
  return new Set((normalizeOptionalReviewers(optionalReviewers) || []).map(t => t.toLowerCase()));
}

/** Build a lowercased-token → cap lookup for the builders. Tolerates the raw (unnormalized) map. */
function reviewerMaxRoundsLookup(reviewerMaxRounds) {
  const normalized = normalizeReviewerMaxRounds(reviewerMaxRounds) || {};
  return new Map(Object.entries(normalized).map(([token, max]) => [token.toLowerCase(), max]));
}

/**
 * Build a lowercased-token → model-id lookup for the builders. Tolerates the raw (unnormalized)
 * map.
 */
function reviewerModelLookup(reviewerModels) {
  const normalized = normalizeReviewerModels(reviewerModels) || {};
  return new Map(Object.entries(normalized).map(([token, model]) => [token.toLowerCase(), model]));
}

/**
 * Build a lowercased-token → effort-level lookup for the builders. Tolerates the raw
 * (unnormalized) map.
 */
function reviewerEffortLookup(reviewerEfforts, reviewerModels = {}, reviewerCatalogs = {}) {
  const normalized = normalizeReviewerEfforts(reviewerEfforts, reviewerModels, reviewerCatalogs) || {};
  return new Map(Object.entries(normalized).map(([token, effort]) => [token.toLowerCase(), effort]));
}

/**
 * Render one emitted `--review-with` entry: the reviewer token, its optional `[<model>]` selector,
 * then slashdo's per-entry suffixes in canonical storage order — `~opt`, `~max=<n>`, then
 * `~effort=<level>`. Order matters. slashdo's grammar is `entry := ( <agent> [ "[" <model> "]" ] |
 * "@" <login> ) ( "~opt" | "~max=" <n> | "~effort=" <level> )*` and its parser strips the `~`
 * suffixes from the RIGHT before reading the bracket — so the bracket has to sit between the slug
 * and the suffixes.
 */
function markSuffixes(token, optSet, maxLookup, modelLookup, effortLookup, providers = []) {
  const key = token.toLowerCase();
  let emitToken = token;
  let provider = null;
  let slug = null;

  if (isProviderReviewer(token)) {
    const providerId = token.slice('provider:'.length);
    provider = Array.isArray(providers)
      ? providers.find(p => p && (p.id === providerId || `provider:${p.id}` === token))
      : null;
    slug = resolveProviderReviewerSlug(provider, providerId);
    if (slug) {
      emitToken = slug;
    }
  }

  const slugKey = slug ? slug.toLowerCase() : null;
  const max = maxLookup?.get(key) ?? (slugKey ? maxLookup?.get(slugKey) : undefined);
  const effort = effortLookup?.get(key) ?? (slugKey ? effortLookup?.get(slugKey) : undefined);
  const isOpt = optSet?.has(key) || (slugKey ? optSet?.has(slugKey) : false);

  const modelKey = slugKey || key;
  const model = BRACKET_MODEL_REVIEWERS.includes(modelKey)
    ? (modelLookup?.get(key) || (slugKey ? modelLookup?.get(slugKey) : undefined) || provider?.defaultModel || undefined)
    : undefined;

  return `${emitToken}${model ? `[${model}]` : ''}${isOpt ? '~opt' : ''}${max === undefined ? '' : `~max=${max}`}${effort ? `~effort=${effort}` : ''}`;
}

/**
 * True when the winning layer explicitly lists NO keyed (AI/CLI) reviewers and forge reviewers
 * (`@login`) remain: the user chose "review by these people or bots only", which must not fall
 * back to the install default chain.
 */
function usernameOnlyRoster(metadata, codeReviewDefaults) {
  if (!resolveReviewUsernames(metadata?.usernames, codeReviewDefaults?.usernames).length) return false;
  if (!Array.isArray(metadata?.reviewers) && typeof metadata?.reviewer === 'string' && metadata.reviewer) return false;
  const explicitEmpty = (layer) => Array.isArray(layer?.reviewers) && layer.reviewers.length === 0;
  return Array.isArray(metadata?.reviewers) ? explicitEmpty(metadata) : explicitEmpty(codeReviewDefaults);
}

/**
 * Resolve an explicit task reviewer list as its preferred tier, followed by the system Code Review
 * Defaults tiers. This lets scheduled task overrides retain their choice while inheriting a
 * configured default when that tier is paused.
 */
export function resolveReviewerGroup(metadata, codeReviewDefaults, defaultReviewers, normalize = normalizeReviewers) {
  const raw = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const source = Array.isArray(raw.reviewers)
    ? raw.reviewers
    : (typeof raw.reviewer === 'string' && raw.reviewer ? [raw.reviewer] : []);
  const taskGroup = normalizeReviewerList(source);
  if (usernameOnlyRoster(raw, codeReviewDefaults)) return [];
  if (!taskGroup.length) {
    return prioritizeToolFreeReviewers(normalize(metadata, defaultReviewers));
  }

  const configuredGroups = Array.isArray(codeReviewDefaults?.reviewerFallbackGroups)
    ? codeReviewDefaults.reviewerFallbackGroups
    : [defaultReviewers ?? codeReviewDefaults?.reviewers];
  const fallbackGroups = configuredGroups
    .map(normalizeReviewerList)
    .filter(group => group.length);
  const groups = [taskGroup, ...fallbackGroups];
  const activeGroup = groups[activeReviewerGroupIndex(groups, codeReviewDefaults?.reviewerHealth)];
  return prioritizeToolFreeReviewers(activeGroup || taskGroup);
}

/**
 * Resolve the keyed (enum) reviewer list, honoring the "username-only" case: an EXPLICITLY empty
 * keyed list with username reviewers present (e.g. copilot was stripped on a non-GitHub forge)
 * stays empty rather than falling back to the install default normalizeReviewers would apply.
 * Absent/legacy input still normalizes to the configured default.
 */
export function resolveKeyedReviewers(reviewers, hasUsernames) {
  if (Array.isArray(reviewers) && reviewers.length === 0 && hasUsernames) return [];
  return normalizeReviewers({ reviewers });
}

/**
 * Reviewers in `optionalReviewers` get slashdo's `~opt` non-blocking suffix, and reviewers
 * carrying a `reviewerMaxRounds` cap get `~max=<n>` after it. A reviewer with a `reviewerModels`
 * pin gets slashdo's `[<model>]` selector between the slug and those suffixes, and a reviewer with
 * a `reviewerEfforts` pin gets `~effort=<level>`.
 */
export function buildReviewersCsv(reviewers, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewerModels = {}, reviewerEfforts = {}, providers = [], reviewerCatalogs = reviewerCatalogsFromProviders(providers)) {
  const users = normalizeReviewUsernames(usernames);
  const keyed = Array.isArray(reviewers) && reviewers.length ? reviewers : (users.length ? [] : [...DEFAULT_REVIEWERS]);
  const optSet = optionalReviewerSet(optionalReviewers);
  const maxLookup = reviewerMaxRoundsLookup(reviewerMaxRounds);
  const modelLookup = reviewerModelLookup(reviewerModels);
  const effortLookup = reviewerEffortLookup(reviewerEfforts, reviewerModels, reviewerCatalogs);
  const combined = [...keyed, ...users.map(u => `@${u}`)];
  return combined.map(t => markSuffixes(t, optSet, maxLookup, modelLookup, effortLookup, providers)).join(',');
}

/**
 * Build the slashdo review flag string for an ordered reviewer list plus any arbitrary GitHub
 * reviewer usernames. - `--review-with a,b,@user` only when the effective list isn't the lone
 * default copilot (any username, or any non-default keyed reviewer, forces it on). Usernames are
 * appended as `@user` tokens after the keyed reviewers. - `--review-stop-on-*` only when the
 * effective list is 2+ (stop-mode is meaningless for one). - `--reviewer-applies` only when an
 * `APPLY_CAPABLE_REVIEWERS` slug (`codex`) is in the emitted list. slashdo's loop forces every
 * OTHER local reviewer (`claude`/`agy`/`grok`/`pi`/`cursor`/`opencode`) back to review-only —
 * codex is the one with a verified write-isolated profile — and the flag is a no-op on
 * `copilot`/`@login` (cloud, read-only) and `ollama` (non-agentic).
 * @param {string[]} reviewers - ordered keyed reviewer slugs
 * @param {Object} [options]
 * @param {string} [options.stopMode] - review stop mode (`all` / `on-findings` / `on-clean`)
 * @param {boolean} [options.reviewerApplies] - emit `--reviewer-applies`
 * @param {string[]} [options.usernames] - GitHub reviewer usernames (emitted as `@user`)
 * @param {string[]} [options.optionalReviewers] - reviewers that get the `~opt` suffix
 * @param {Object<string, number>} [options.reviewerMaxRounds] - per-reviewer `~max=<n>` caps
 * @param {Object<string, string>} [options.reviewerModels] - per-reviewer `[<model>]` pins
 * @param {Object<string, string>} [options.reviewerEfforts] - per-reviewer `~effort=<level>` pins
 * @param {Array<object>} [options.providers] - configured provider records to resolve provider tokens
 * @returns {string} the slashdo review flag string (possibly empty)
 */
export function buildReviewWithArgs(reviewers, {
  stopMode = DEFAULT_REVIEW_STOP_MODE,
  reviewerApplies = false,
  usernames = [],
  optionalReviewers = [],
  reviewerMaxRounds = {},
  reviewerModels = {},
  reviewerEfforts = {},
  providers = [],
  reviewerCatalogs = reviewerCatalogsFromProviders(providers),
} = {}) {
  const users = normalizeReviewUsernames(usernames);
  const keyed = resolveKeyedReviewers(reviewers, users.length > 0);
  const configured = [...keyed, ...users.map(u => `@${u}`)];
  // PortOS-only reviewers are dropped rather than emitted — see the doc comment above and
  // `splitSlashdoReviewerTokens`. The surrounding prompt still names the full reviewer list and
  // the Local Reviewer Procedure that runs them.
  const combined = splitSlashdoReviewerTokens(configured, providers).flagTokens;
  const optSet = optionalReviewerSet(optionalReviewers);
  const maxLookup = reviewerMaxRoundsLookup(reviewerMaxRounds);
  const modelLookup = reviewerModelLookup(reviewerModels);
  const effortLookup = reviewerEffortLookup(reviewerEfforts, reviewerModels, reviewerCatalogs);
  // The lone-default-copilot suppression only applies when copilot carries NO per-entry suffix — a
  // `copilot~opt` / `copilot~max=2` / `copilot~effort=high` list must still emit the flag to carry
  // that suffix. Measured against the CONFIGURED list, not the emitted one.
  const isDefaultOnly = configured.length === 1 && configured[0] === DEFAULT_REVIEWER
    && !optSet.has(DEFAULT_REVIEWER) && maxLookup.get(DEFAULT_REVIEWER) === undefined
    && effortLookup.get(DEFAULT_REVIEWER) === undefined;
  // Keyed by resolved SLUG, like every other per-reviewer lookup in this function, so a bracketed
  // or suffixed token cannot slip past the comparison.
  const hasApplyCapableReviewer = combined.some(t => {
    const raw = reviewerTokenSlug(t);
    const resolved = isProviderReviewer(raw)
      ? resolveProviderReviewerSlug(Array.isArray(providers) ? providers.find(p => p && (p.id === raw.slice(9) || `provider:${p.id}` === raw)) : null, raw.slice(9))
      : raw;
    return isApplyCapableReviewer(resolved || raw);
  });
  const parts = [];
  // Nothing slashdo can parse (a list of PortOS-only reviewers): emit no flag at all rather than a
  // bare `--review-with`.
  if (!isDefaultOnly && combined.length) parts.push(`--review-with ${combined.map(t => markSuffixes(t, optSet, maxLookup, modelLookup, effortLookup, providers)).join(',')}`);
  if (combined.length >= 2) {
    if (stopMode === 'on-findings') parts.push('--review-stop-on-findings');
    else if (stopMode === 'on-clean') parts.push('--review-stop-on-clean');
  }
  if (reviewerApplies && hasApplyCapableReviewer) parts.push('--reviewer-applies');
  return parts.join(' ');
}
