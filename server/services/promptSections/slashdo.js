/**
 * Slashdo invocation expansion for agent prompts.
 */

import { loadSlashdoFile, loadSlashdoBundle, writeResolvedSlashdoBody } from '../../lib/slashdoLoader.js';
import { resolveSlashdoInvocation, buildSlashdoSection, unreachableReviewerIncludes, parseExplicitReviewWith, SLASHDO_REVIEWER_INCLUDE_NAMES, SLASHDO_INLINE_BUDGET_CHARS } from '../../lib/slashdoInvocation.js';
import { currentTaskTypeName } from '../../lib/scheduledTaskTypes.js';
import { DEFAULT_REVIEWER, resolveReviewerConfig, buildReviewerEffortNote, buildReviewersCsv } from '../../lib/reviewerConfig.js';

import { isTruthyMeta } from '../../lib/metadataFlags.js';
/**
 * The ONE reviewer contract a slashdo invocation runs under, resolved before the body
 * is pruned, a `--review-with` is pinned, or effort instructions are emitted (#6261).
 *
 * Sources in slashdo's own precedence (`lib/review-config-defaults.md`):
 * 1. **An explicit `--review-with` in `slashdoArgs`**, passed through verbatim, so it
 *    is what the run WILL use: prune for exactly it and pin nothing.
 * 2. **Task metadata + Code Review Defaults** via `resolveReviewerConfig`, owning every
 *    invocation that names no flag.
 *
 * Deriving `skipIncludes` from (2) while (1) rides the invocation made the prompt
 * request one reviewer, omit its loop and instruct another (`none` was silently
 * overridden by an inherited default).
 *
 * An explicit flag PortOS cannot safely read (`{ unresolved: true }`: open quote,
 * shell expansion, slug or suffix outside the grammar) prunes and pins NOTHING: a fat
 * prompt costs tokens, a missing loop costs the run.
 *
 * Does NOT touch the completion workflow's own reviewer resolution (a separate
 * `/do:pr` invocation with its own arguments).
 *
 * @param {Object} task - the CoS task (reads `metadata.slashdoArgs` + reviewer pins)
 * @param {Object} [opts]
 * @param {Object|null} [opts.codeReviewDefaults]
 * @param {string[]|null} [opts.defaultReviewers]
 * @returns {{skipIncludes: string[], reviewWith: string, reviewerEffortNote: string,
 *   explicitReviewWith: boolean}}
 */
function resolveSlashdoReviewContract(task, { codeReviewDefaults = null, defaultReviewers = null } = {}) {
  const explicit = parseExplicitReviewWith(task.metadata?.slashdoArgs);
  if (explicit) {
    // The explicit flag owns reviewers, models, efforts and suffixes: no pin or effort prose.
    const skipIncludes = explicit.unresolved
      ? []
      : explicit.none
        // `none` sets REVIEW_AGENTS=[] with no fallback: every reviewer loop is unreachable.
        ? [...SLASHDO_REVIEWER_INCLUDE_NAMES]
        : unreachableReviewerIncludes({ reviewers: explicit.reviewers, usernames: explicit.usernames });
    return { skipIncludes, reviewWith: '', reviewerEffortNote: '', explicitReviewWith: skipIncludes.length > 0 };
  }

  // Same three helpers as the inline `/do:pr` completion path (`taskReviewers` /
  // `taskReviewerUsernames` / `taskOptionalReviewers`), so we prune for the reviewers
  // the rest of the prompt resolves (hand-rolling dropped the legacy `reviewer` string
  // and `optionalReviewers`).
  const {
    reviewers: resolvedReviewers,
    usernames: resolvedUsernames,
    optionalReviewers: resolvedOptional,
    reviewerMaxRounds: resolvedMaxRounds,
    reviewerModels: resolvedModels,
    reviewerEfforts: resolvedEfforts,
    reviewerCatalogs
  } = resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers);

  // A lone `copilot` with no usernames is ambiguous on older task records (what an
  // unconfigured install used to produce) unless something names it explicitly;
  // otherwise treat it as unconfigured and prune nothing (pinning
  // `--review-with copilot` without Copilot review is the #2507 stall). Marking it
  // OPTIONAL or giving it a `~max=<n>` cap is such naming, since dropping either would
  // turn a non-blocking review blocking or spend unbudgeted rounds.
  // `buildReviewWithArgs` makes the same exemption; keep the two in step. No `~effort=`
  // clause: copilot has no effort ladder (`normalizeReviewerEfforts` drops the pin).
  const taskPinnedReviewer = (Array.isArray(task.metadata?.reviewers) && task.metadata.reviewers.length > 0)
    || (typeof task.metadata?.reviewer === 'string' && !!task.metadata.reviewer);
  const optionalDefaultReviewer = resolvedOptional.some(t => t.toLowerCase() === DEFAULT_REVIEWER);
  const cappedDefaultReviewer = Object.keys(resolvedMaxRounds)
    .some(t => t.toLowerCase() === DEFAULT_REVIEWER);
  const isBareDefault = resolvedReviewers.length === 1
    && resolvedReviewers[0] === DEFAULT_REVIEWER
    && !resolvedUsernames.length
    && !taskPinnedReviewer
    && !optionalDefaultReviewer
    && !cappedDefaultReviewer;
  const skipIncludes = isBareDefault
    ? []
    : unreachableReviewerIncludes({ reviewers: resolvedReviewers, usernames: resolvedUsernames });

  const reviewWith = skipIncludes.length
    ? buildReviewersCsv(resolvedReviewers, resolvedUsernames, resolvedOptional, resolvedMaxRounds, resolvedModels, resolvedEfforts, [], reviewerCatalogs)
    : '';
  // Gated on the PIN, not on pruning: an emitted `reviewWith` already carries
  // `~effort=<level>` per token; unpinned, the note is the pin's only route to the
  // spawned CLI (the later `/do:pr` step is a different invocation).
  const reviewerEffortNote = buildReviewerEffortNote(resolvedReviewers, resolvedEfforts, { reviewWith, reviewerModels: resolvedModels, reviewerCatalogs });
  return { skipIncludes, reviewWith, reviewerEffortNote, explicitReviewWith: false };
}

/**
 * Fold a slashdo-backed task's invocation + procedure into its description (#3089).
 *
 * The task persists only the BARE command (`metadata.slashdoCommand`); the concrete
 * shape (`/do:x`, `/do-x`, or an Agent Skill) is knowable only once a provider is
 * picked. The body travels with the prompt for every provider because the repo-local
 * `.claude/commands/do/` symlinks don't exist in managed-app workspaces.
 *
 * File-tool hosts receive the deferred bundle (entrypoint + files read per phase);
 * API providers an eager body; oversized bodies without references a file pointer.
 *
 * Pruning is sound only if the run uses the reviewers pruned FOR, so body, pin and
 * effort note all come from ONE contract (`resolveSlashdoReviewContract`).
 *
 * Applied to the description (on a COPY) rather than a new template slot: a
 * `{{slashdoSection}}` placeholder would be dropped by installs whose customized
 * template predates it.
 *
 * @returns {Promise<Object>} the task, or a copy carrying the invocation
 */
export async function applySlashdoInvocation(task, {
  providerId = null, providerCommand = null, leanMode = false, hasFileTools = false,
  defaultReviewers = null, codeReviewDefaults = null,
} = {}) {
  // Older queued release tasks lost this key in metadata sanitization; tasks
  // queued before the release-check → do-release rename still carry the old type.
  const taskType = task.metadata?.analysisType || task.metadata?.taskAnalysisType;
  const command = task.metadata?.slashdoCommand || (currentTaskTypeName(taskType) === 'do-release' ? 'release' : null);
  const resolved = resolveSlashdoInvocation({
    command,
    args: task.metadata?.slashdoArgs || '',
    providerId,
    providerCommand,
    leanMode,
  });
  if (!resolved) return task;

  const {
    skipIncludes, reviewWith, reviewerEffortNote, explicitReviewWith,
  } = resolveSlashdoReviewContract(task, { codeReviewDefaults, defaultReviewers });

  const options = { stripFrontmatter: true, skipIncludes };
  const bundle = hasFileTools ? await loadSlashdoBundle(command, options) : null;
  let body = hasFileTools ? bundle?.body : await loadSlashdoFile(command, options);
  if (!body) console.log(`⚠️ Slashdo command body unavailable, sending invocation only: ${command}`);
  const hasDeferredFiles = !!bundle && Object.keys(bundle.files).length > 0;
  const overBudget = !!body && body.length > SLASHDO_INLINE_BUDGET_CHARS;
  if (overBudget && !hasFileTools) {
    console.warn(`⚠️ Inlining ${Math.round(body.length / 1000)}KB slashdo body for API provider (no file tools): ${command}`);
  }
  // A deferred body needs a stable filesystem base for relative reads; if staging
  // fails, reload eagerly (inlining would strand its references elsewhere).
  const bodyPath = (hasFileTools && (overBudget || hasDeferredFiles))
    ? await writeResolvedSlashdoBody(command, body, { files: bundle.files }).catch(async (err) => {
        console.warn(`⚠️ Could not stage slashdo body for ${command}, inlining instead: ${err.message}`);
        body = await loadSlashdoFile(command, options);
        if (!body) throw new Error(`Slashdo fallback body unavailable: ${command}`);
        return null;
      })
    : null;

  // Plan-only supplies destination/approval flags as slashdo args, so preserve
  // the task description bridge that those flags would otherwise suppress.
  const includeTaskContext = isTruthyMeta(task.metadata?.planOnly);
  const section = buildSlashdoSection(resolved, body, {
    bodyPath,
    reviewWith,
    reviewerEffortNote,
    includeTaskContext,
    explicitReviewWith,
  });
  return { ...task, metadata: { ...task.metadata, slashdoCommand: command }, description: `${task.description}\n\n${section}` };
}
