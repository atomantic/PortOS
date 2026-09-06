/**
 * Slashdo invocation expansion for agent prompts.
 */

import { loadSlashdoFile, loadSlashdoBundle, writeResolvedSlashdoBody } from '../../lib/slashdoLoader.js';
import { resolveSlashdoInvocation, buildSlashdoSection, unreachableReviewerIncludes, parseExplicitReviewWith, SLASHDO_REVIEWER_INCLUDE_NAMES, SLASHDO_INLINE_BUDGET_CHARS } from '../../lib/slashdoInvocation.js';
import { DEFAULT_REVIEWER, resolveReviewerConfig, buildReviewerEffortNote, buildReviewersCsv } from '../../lib/validation.js';

/**
 * The ONE reviewer contract a slashdo invocation runs under — resolved before the
 * body is pruned, before a `--review-with` is pinned, and before any per-reviewer
 * effort instruction is emitted (#6261).
 *
 * There are two sources, and slashdo's own precedence
 * (`lib/review-config-defaults.md`) puts them in this order:
 *
 * 1. **An explicit `--review-with` in the task's `slashdoArgs`.** PortOS passes
 *    those arguments through verbatim, so a typed flag is what the run WILL use —
 *    above task metadata, above the install's Code Review Defaults, above
 *    slashdo's own saved defaults. Prune for exactly it, and pin nothing: the
 *    invocation already carries the value, suffixes and all.
 * 2. **Task metadata + Code Review Defaults**, via `resolveReviewerConfig`. This is
 *    the historical path, and it still owns every invocation that names no flag.
 *
 * Deriving `skipIncludes` from (2) while (1) rides the invocation is the bug this
 * function exists to make impossible: the prompt requested one reviewer, omitted
 * its loop, and instructed the agent to use another. `--review-with none` was the
 * worst case — an explicit opt-out silently overridden by an inherited default.
 *
 * An explicit flag PortOS cannot safely read (`{ unresolved: true }` — an open
 * quote or bracket, a shell expansion, a slug or suffix outside the grammar we
 * mirror) preserves the arguments and prunes and pins NOTHING. A fat prompt costs
 * tokens; a prompt missing the loop the run actually reaches costs the run.
 *
 * This deliberately does NOT touch the completion workflow's own reviewer
 * resolution further down the prompt — that is a separate `/do:pr` invocation with
 * its own arguments, and an explicit flag on THIS one says nothing about it.
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
    // The explicit flag owns reviewers, models, efforts and suffixes alike, so
    // there is no pin and no effort prose to emit — both would restate (or
    // contradict) what the invocation already says.
    const skipIncludes = explicit.unresolved
      ? []
      : explicit.none
        // `none` sets REVIEW_AGENTS=[] with no fallback, so every reviewer loop is
        // provably unreachable — the strongest form of "causes no reviewer call".
        ? [...SLASHDO_REVIEWER_INCLUDE_NAMES]
        : unreachableReviewerIncludes({ reviewers: explicit.reviewers, usernames: explicit.usernames });
    return { skipIncludes, reviewWith: '', reviewerEffortNote: '', explicitReviewWith: skipIncludes.length > 0 };
  }

  // Resolved through the SAME three helpers the inline `/do:pr` completion path
  // uses below (`taskReviewers` / `taskReviewerUsernames` / `taskOptionalReviewers`),
  // so the reviewers we prune for are exactly the ones the rest of the prompt
  // resolves. Hand-rolling `metadata.reviewers` here instead dropped the legacy
  // single `reviewer` string and the defaults' `optionalReviewers` — pruning for
  // one reviewer while the run resolved another, and pinning an optional reviewer
  // as blocking.
  const {
    reviewers: resolvedReviewers,
    usernames: resolvedUsernames,
    optionalReviewers: resolvedOptional,
    reviewerMaxRounds: resolvedMaxRounds,
    reviewerModels: resolvedModels,
    reviewerEfforts: resolvedEfforts
  } = resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers);

  // A resolved lone `copilot` with no usernames is ambiguous: it's what an
  // unconfigured install produces (`pickCodeReviewDefaults` and
  // `normalizeReviewers` both fall back to `['copilot']`), so it can't be told
  // apart from a real choice UNLESS something names it explicitly. Absent that,
  // treat it as unconfigured and prune nothing — pinning `--review-with copilot`
  // where Copilot review isn't enabled is the #2507 stall.
  //
  // Marking copilot OPTIONAL — or giving it a `~max=<n>` round cap — is such an
  // explicit naming: nothing defaults to either suffix, so both are deliberate
  // choices, and dropping one would silently turn a non-blocking review blocking
  // or spend an unbudgeted number of rounds. `buildReviewWithArgs` makes the same
  // exemption for its lone-default suppression — keep the two in step. It carries a
  // third clause for a copilot `~effort=`; there is deliberately none here, because
  // copilot has no effort ladder at all (`REVIEWER_EFFORT_LEVELS` is keyed off
  // `reviewerCliBinary`, and copilot names no binary), so `normalizeReviewerEfforts`
  // drops the pin long before either function sees it.
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
    ? buildReviewersCsv(resolvedReviewers, resolvedUsernames, resolvedOptional, resolvedMaxRounds, resolvedModels, resolvedEfforts)
    : '';
  // Gated on the PIN, not on pruning. When `reviewWith` is emitted, each token
  // carries `~effort=<level>` and slashdo's loop applies it — the note would only
  // have the agent pass the flag twice. When nothing is pinned, the workflow
  // resolves reviewers itself and the note is the pin's only route to the CLI it
  // spawns (the `/do:pr` completion step further down is a different invocation
  // entirely, and for a slashdo-backed task usually isn't reached).
  const reviewerEffortNote = buildReviewerEffortNote(resolvedReviewers, resolvedEfforts, { reviewWith, reviewerModels: resolvedModels });
  return { skipIncludes, reviewWith, reviewerEffortNote, explicitReviewWith: false };
}

/**
 * Fold a slashdo-backed task's invocation + procedure into its description (#3089).
 *
 * A task that names a bundled workflow persists only the BARE command
 * (`metadata.slashdoCommand`) because the form's provider select defaults to
 * "Auto" — the concrete shape (`/do:x`, `/do-x`, or an Agent Skill selected by
 * name) is only knowable here, once the scheduler has picked a provider.
 *
 * The command body travels with the prompt for every provider, not just the
 * skill-style ones: PortOS ships slashdo as a submodule and only surfaces it as
 * slash commands via the repo-local `.claude/commands/do/` symlinks, which don't
 * exist in the managed-app workspaces most CoS tasks run in.
 *
 * File-tool hosts receive slashdo's deferred bundle: an entrypoint and supporting
 * files read only at the relevant phase. API providers receive an eager body.
 * Oversized bodies without references still use the existing file pointer.
 *
 * Pruning is only sound if the run then uses the reviewers we pruned FOR, so the
 * body, the emitted pin, and the effort instruction all come from ONE resolved
 * reviewer contract — `resolveSlashdoReviewContract` above, which puts an explicit
 * `--review-with` in the invocation's own arguments ahead of task metadata and the
 * install defaults, exactly as slashdo does.
 *
 * Applied to the description (on a COPY — the stored task is untouched) rather
 * than emitted as its own template slot, because the briefing template renders
 * `{{task.description}}`: a new `{{slashdoSection}}` placeholder would be
 * silently dropped by every install whose customized template predates it.
 *
 * @returns {Promise<Object>} the task, or a copy carrying the invocation
 */
export async function applySlashdoInvocation(task, {
  providerId = null, providerCommand = null, leanMode = false, hasFileTools = false,
  defaultReviewers = null, codeReviewDefaults = null,
} = {}) {
  const command = task.metadata?.slashdoCommand;
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
  // Even a tiny entrypoint needs a stable filesystem base for relative reads.
  // If staging fails, reload eagerly; inlining the deferred body would strand
  // its required references in the managed app's unrelated working directory.
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
  const includeTaskContext = task.metadata?.planOnly === true || task.metadata?.planOnly === 'true';
  const section = buildSlashdoSection(resolved, body, {
    bodyPath,
    reviewWith,
    reviewerEffortNote,
    includeTaskContext,
    explicitReviewWith,
  });
  return { ...task, description: `${task.description}\n\n${section}` };
}
