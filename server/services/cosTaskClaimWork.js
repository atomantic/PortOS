/**
 * CoS Claim-Work Task Builders
 *
 * The one-off, user-triggered prompt builders behind the managed-app buttons:
 *  - `buildClaimWorkTask` — the Issues-tab / `/do:next` "claim the next work item"
 *    button, routed by the app's configured work tracker.
 *  - `buildJiraTicketTask` — the sprint-board per-card "play" button.
 *  - `buildIssueReplanTask` — the Issues-tab Replan button.
 *  - `resolveClaimWorkMetadata` / `resolveClaimAuthorFilter` /
 *    `resolveAppClaimReviewers` — the configured-claim resolution those builders
 *    share, also read by the work-item picker route, the claim-reviewer lookup
 *    route, and the development watchdog so each previews exactly what a claim
 *    run will use.
 *
 * Split out of `cosTaskGenerator.js` (the periodic scheduling engine) because
 * none of these run inside `evaluateTasks`, yet the routes and the watchdog had
 * to import the whole scheduler graph to reach them. Nothing here imports the
 * generator back; `taskSchedule.js` is imported lazily, as the generator does.
 */

import { sanitizeTaskMetadata, resolveClaimReviewerConfig, reviewerConfigMetadata, hasReviewerOverride } from '../lib/validation.js';
import { applyAppPlaceholders } from '../lib/appPromptPlaceholders.js';
import { PR_COMPLETIONS } from '../lib/prDisposition.js';
import { ServerError } from '../lib/errorHandler.js';
import { getAppTaskTypeOverrides } from './apps.js';
import { getCodeReviewDefaults } from './codeReview.js';
import {
  appendClaimOverrideContext,
  appendPrefetchedIssueContext,
  appendReviewerEffortBlock,
  appendTargetWorkItemBlock,
  buildLocalReviewerInstructions,
  buildIssueReplanPrompt,
  normalizeWorkItemRef,
} from './cosTaskPrompts.js';
import {
  resolveIssueAuthorFilterBlock,
  resolveIssueCandidateListBlock,
  resolveIssueExcludeLabelsBlock,
  resolveSwarmBlock,
} from './cosTaskPreStepBlocks.js';

// `normalizeClaimReviewers` moved to server/lib/reviewerConfig.js (#4770, #5702): the
// prompt builder needs the same copilot guard when it re-resolves reviewers off
// a persisted claim task, and a service-level definition would have meant a
// second copy there.

/**
 * Resolve an app's configured claim metadata the same way the scheduled
 * router does: global schedule metadata, then per-app overrides on top (managed
 * agent fields stripped, both passes sanitized/value-constrained). This is what
 * carries the user's `issueAuthorFilter`, reviewer, and swarm choices into the
 * prompt. Shared by `buildClaimWorkTask` and the work-item picker route, so the
 * items offered are scanned with the SAME author filter the claim agent will use.
 *
 * @returns {Promise<{ metadata: object, interval: object }>}
 */
export async function resolveClaimWorkMetadata(app, taskType = 'claim-work') {
  const taskSchedule = await import('./taskSchedule.js');
  // Independent reads (schedule config + per-app overrides) — the merge below
  // needs both, but neither depends on the other.
  const [interval, appOverrides] = await Promise.all([
    taskSchedule.getTaskInterval(taskType),
    getAppTaskTypeOverrides(app.id)
  ]);
  const metadata = {};
  const sanitizedGlobalMeta = sanitizeTaskMetadata(interval.taskMetadata);
  if (sanitizedGlobalMeta) Object.assign(metadata, sanitizedGlobalMeta);
  const strippedAppOverride = taskSchedule.stripManagedAgentOptionsFromOverride(
    taskType, appOverrides[taskType]?.taskMetadata
  );
  const sanitizedAppMeta = sanitizeTaskMetadata(strippedAppOverride);
  if (sanitizedAppMeta) Object.assign(metadata, sanitizedAppMeta);
  return { metadata, interval };
}

/**
 * The author filter a claim run will actually apply: explicit option >
 * configured `claim-work` metadata > `'self'` (the slashdo `/do:next --self`
 * security boundary — only claim issues you filed).
 */
export function resolveClaimAuthorFilter(explicit, metadata) {
  return explicit ?? metadata?.issueAuthorFilter ?? 'self';
}

/**
 * The reviewer bundle a claim will run: an explicit option wins per field, then
 * the app's configured `claim-work` metadata, then the Code Review Defaults. One
 * resolver for the whole bundle (list + usernames + `~opt` set + the three keyed
 * pins), so the CSV the prompt names and the `reviewers` the task PERSISTS cannot
 * disagree. Local-LLM reviewers stay in the operative list; the claim prompt's
 * appended Local Reviewer Procedure tells the agent how to invoke PortOS's review
 * service rather than silently replacing the user's configured reviewer.
 *
 * Shared with `resolveAppClaimReviewers` (and through it the claim-reviewer
 * lookup route) precisely so a change to this precedence reaches the preview the
 * UI shows and the run it previews at the same time — the two drifting apart is
 * the whole defect that lookup exists to close.
 */
function claimReviewersFrom(metadata, codeReviewDefaults, explicit = {}) {
  const { reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, prCompletion } = explicit;
  return resolveClaimReviewerConfig({
    ...metadata,
    ...(prCompletion !== undefined ? { prCompletion } : {}),
    reviewers: reviewers !== undefined ? (Array.isArray(reviewers) ? reviewers : [reviewers]) : metadata?.reviewers,
    usernames: usernames ?? metadata?.usernames,
    optionalReviewers: optionalReviewers ?? metadata?.optionalReviewers,
    reviewerMaxRounds: reviewerMaxRounds ?? metadata?.reviewerMaxRounds,
    reviewerModels: reviewerModels ?? metadata?.reviewerModels,
    reviewerEfforts: reviewerEfforts ?? metadata?.reviewerEfforts
  }, codeReviewDefaults, codeReviewDefaults?.reviewers);
}

/**
 * What a `/do:next` claim would resolve for `app` right now, without queuing one:
 * the reviewer bundle plus `overridden`, which says whether the claim-work task
 * metadata supplied any of the list (so the UI can send the user to the override
 * rather than to the Code Reviewers panel that isn't in play).
 *
 * Reads the same two layers `buildClaimWorkTask` does and hands them to the same
 * `claimReviewersFrom`, so the preview cannot report a chain the run won't use.
 */
export async function resolveAppClaimReviewers(app) {
  // Independent reads — the resolver needs both, but neither depends on the other.
  const [{ metadata }, codeReviewDefaults] = await Promise.all([
    resolveClaimWorkMetadata(app),
    // A settings read failure means "no configured defaults", never a failed
    // lookup: the task metadata layer wins over them anyway.
    getCodeReviewDefaults().catch(() => null)
  ]);
  const prCompletion = metadata?.prCompletion || app?.defaultPrCompletion || PR_COMPLETIONS.REVIEW_THEN_MERGE;
  return {
    ...claimReviewersFrom(metadata, codeReviewDefaults, { prCompletion }),
    prCompletion,
    overridden: hasReviewerOverride(metadata) || !!metadata?.prCompletion
  };
}

/**
 * Build a one-off "claim the next work item" task for `app`, routed by the app's
 * configured workTracker — the manual (Slashdo `/do:next` button) counterpart to
 * the scheduled `claim-work` router in cosTaskGenerator.js. Resolves the tracker, delegates to the
 * matching claim prompt body (plan-task / claim-issue / claim-issue-gitlab /
 * claim-issue-jira), substitutes the standard placeholders, and surfaces the
 * delegated flow's worktree/PR posture. `claimFlow` separately marks that the
 * prompt owns its worktree + MR/PR lifecycle; false/false remains the correct
 * CoS provisioning posture because a nested CoS worktree would conflict with
 * the claim branch.
 *
 * `issueAuthorFilter` and the reviewer options default to the app's *configured*
 * `claim-work` behavior (global schedule metadata → per-app override → Code
 * Review Defaults), exactly as the scheduled `claim-work` router resolves them —
 * so clicking the button honors `issueAuthorFilter: 'any'` and non-Copilot
 * reviewers instead of silently forcing owner-only + Copilot. A direct
 * `claim-work` prompt customization likewise overrides the tracker-specific body
 * (matching the scheduled router's `promptKeyForBody` selection). Explicit
 * options still win when a caller passes them.
 *
 * `target` pins the run to ONE work item (the drawer's "pick a specific item"
 * mode) by appending the tracker-appropriate constraint block, overriding the
 * prompt's own Phase 1 pick while keeping every claim safety check. A matching
 * `issueContext` from the managed-app Issues tab is appended for forge targets
 * so the agent can use the already-fetched title/body without retrieving it a
 * second time.
 *
 * @returns {Promise<{ tracker, source, promptTaskType, prompt, taskMetadata, target }>}
 */
export async function buildClaimWorkTask(app, {
  issueAuthorFilter,
  reviewers,
  usernames,
  optionalReviewers,
  reviewerMaxRounds,
  reviewerModels,
  reviewerEfforts,
  prCompletion,
  target,
  issueContext,
  overrideContext
} = {}) {
  const { resolveAppWorkTracker, trackerToClaimTaskType } = await import('../lib/workTracker.js');
  const { getTaskPrompt } = await import('./taskPromptService.js');
  const taskSchedule = await import('./taskSchedule.js');

  // The tracker probe (a `git` shell-out), the configured claim-work metadata,
  // and the Code Review Defaults are mutually independent — only the prompt-body
  // read below depends on them, so overlap the three.
  const [wt, { metadata, interval }, codeReviewDefaults] = await Promise.all([
    resolveAppWorkTracker(app),
    resolveClaimWorkMetadata(app),
    getCodeReviewDefaults().catch(() => null)
  ]);
  const promptTaskType = trackerToClaimTaskType(wt.resolved) || 'plan-task';

  // Honor a direct claim-work prompt customization if the user set one;
  // otherwise delegate to the resolved tracker's prompt body. Mirrors the
  // scheduled router's `promptKeyForBody` selection — a custom claim-work prompt
  // overrides the tracker-specific body for both paths.
  const template = await getTaskPrompt(
    interval.prompt ? 'claim-work' : promptTaskType,
    { claimFlow: true }
  );

  const resolvedAuthorFilter = resolveClaimAuthorFilter(issueAuthorFilter, metadata);
  const effectivePrCompletion = prCompletion ?? metadata?.prCompletion ?? app?.defaultPrCompletion;

  const claimReviewers = claimReviewersFrom(metadata, codeReviewDefaults, {
    reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts,
    ...(effectivePrCompletion !== undefined ? { prCompletion: effectivePrCompletion } : {})
  });
  const {
    reviewers: reviewersList,
    reviewerModels: promptReviewerModels,
    reviewerEfforts: promptReviewerEfforts,
    csv: reviewersCsv
  } = claimReviewers;
  const issueAuthorFilterBlock = resolveIssueAuthorFilterBlock(promptTaskType, resolvedAuthorFilter);
  const issueExcludeLabelsBlock = resolveIssueExcludeLabelsBlock(metadata.issueExcludeLabels);
  // Swarm mode (`/do:next --swarm`) is prepended (not an in-template
  // placeholder) so it stays an opt-in orchestration wrapper that needs no
  // prompt-default version bump; empty when swarmCount is off or the tracker
  // isn't a forge issue tracker. {reviewers} inside the block is substituted by
  // the same replacer below. A pinned target claims exactly one item, so the
  // swarm wrapper (claim N in parallel) is suppressed — the two are exclusive.
  const targetRef = normalizeWorkItemRef(target);
  const swarmBlock = targetRef ? '' : resolveSwarmBlock(promptTaskType, metadata.swarmCount);

  const prompt = applyAppPlaceholders(`${swarmBlock}${template}`, app)
    // Function-form replacers so literal `$`/`$1` in the substituted text isn't
    // interpreted as a backreference (see the scheduler's same-pattern note).
    .replace(/\{reviewers\}/g, () => reviewersCsv || 'none')
    .replace(/\{issueAuthorFilter\}/g, () => issueAuthorFilterBlock)
    .replace(/\{issueCandidateList\}/g, () => resolveIssueCandidateListBlock(promptTaskType, resolvedAuthorFilter))
    .replace(/\{issueExcludeLabels\}/g, () => issueExcludeLabelsBlock)
    + appendTargetWorkItemBlock(promptTaskType, targetRef, issueExcludeLabelsBlock)
    + appendPrefetchedIssueContext(promptTaskType, targetRef, issueContext)
    + appendClaimOverrideContext(overrideContext)
    + appendReviewerEffortBlock(reviewersList, promptReviewerEfforts, promptReviewerModels)
    + buildLocalReviewerInstructions(reviewersList, promptReviewerModels, promptReviewerEfforts, {
      claimCommentGate: promptTaskType === 'claim-issue',
      enforceIsolation: promptTaskType.startsWith('claim-issue'),
    });

  // Mirror the scheduler: inherit the delegated flow's isolation posture so the
  // JIRA route runs in a CoS-managed worktree rather than the live checkout.
  // The resolved reviewer bundle rides along so the prompt builder's
  // `resolveReviewerConfig(task.metadata, …)` reads back the list this prompt
  // names — the reviewer pin is emitted once from there (#4770).
  const delegatedMeta = taskSchedule.DEFAULT_TASK_INTERVALS[promptTaskType]?.taskMetadata || {};
  const taskMetadata = { ...reviewerConfigMetadata(claimReviewers), claimFlow: true };
  if (effectivePrCompletion) taskMetadata.prCompletion = effectivePrCompletion;
  // The manual `/do:next` path persists this non-raw task through addTask's
  // metadata allowlist before agentLifecycle sees it. Carry the same count that
  // rendered the swarm block so Codex can size its session to root + workers.
  // A pinned target suppresses swarmBlock above and therefore must not retain a
  // stale configured count.
  if (swarmBlock) taskMetadata.swarmCount = metadata.swarmCount;
  if ('useWorktree' in delegatedMeta) taskMetadata.useWorktree = delegatedMeta.useWorktree;
  if ('openPR' in delegatedMeta) taskMetadata.openPR = delegatedMeta.openPR;

  return { tracker: wt.resolved, source: wt.source, promptTaskType, prompt, taskMetadata, target: targetRef };
}

/**
 * Resolve the reviewer prompt pieces for the claim flow as buildClaimWorkTask
 * does on its default (no-explicit-option) path (including local-LLM
 * reviewers). Mirrors the scheduled claim-work resolution so the JIRA play
 * button honors the user's reviewer choice.
 *
 * Returns each piece separately because they travel differently: `csv` fills the
 * template's `{reviewers}` placeholder, `effortBlock` is appended prose (the
 * claim agent spawns each reviewer CLI itself, so no `--review-with` parser ever
 * reads the CSV's `~effort=` suffix), and `taskMetadata` is PERSISTED so the
 * prompt builder resolves the same list back off the task record (#4770).
 */
async function resolveClaimReviewerPrompt(app) {
  const [{ metadata }, codeReviewDefaults] = await Promise.all([
    resolveClaimWorkMetadata(app),
    getCodeReviewDefaults().catch(() => null)
  ]);
  // The app's configured claim-work metadata layers over the Code Review
  // Defaults through the same claimReviewersFrom the scheduled path uses —
  // resolving from the defaults alone would silently drop a pinned override.
  const effectivePrCompletion = metadata?.prCompletion ?? app?.defaultPrCompletion;
  const config = effectivePrCompletion !== undefined
    ? claimReviewersFrom(metadata, codeReviewDefaults, { prCompletion: effectivePrCompletion })
    : claimReviewersFrom(metadata, codeReviewDefaults);
  const { reviewers: list, reviewerModels, reviewerEfforts, csv } = config;
  return {
    csv,
    taskMetadata: reviewerConfigMetadata(config),
    effortBlock: appendReviewerEffortBlock(list, reviewerEfforts, reviewerModels),
    localReviewerBlock: buildLocalReviewerInstructions(list, reviewerModels, reviewerEfforts, { enforceIsolation: true }),
  };
}

/**
 * Build a one-off "implement THIS JIRA ticket" task for `app` — the per-card
 * "play" button on the app overview's sprint board (the JIRA analogue of the
 * `/do:next` claim button). Resolves the `claim-issue-jira` prompt body directly
 * (NOT via buildClaimWorkTask — an app can show a JIRA board while its general
 * Work Tracker resolves to GitHub/PLAN, so route the click to the JIRA flow
 * regardless of that setting), substitutes the standard placeholders, and appends
 * a target-ticket constraint that pins the agent to `ticketKey` while keeping
 * every claim safety check. `ticketKey` is normalized to upper-case (`PROJ-1234`).
 *
 * claim-issue-jira self-manages its worktree + MR/PR. `claimFlow` records that
 * lifecycle ownership while `useWorktree/openPR` stay `false/false` so CoS does
 * not provision a nested worktree.
 *
 * @returns {Promise<{ ticketKey: string, prompt: string, taskMetadata: { useWorktree: boolean, openPR: boolean, claimFlow: boolean } }>} —
 *   `taskMetadata` also carries the resolved reviewer bundle so the prompt
 *   builder's reviewer pin names this prompt's list (#4770).
 */
export async function buildJiraTicketTask(app, ticketKey) {
  const { getTaskPrompt } = await import('./taskPromptService.js');
  // Same normalizer the `/do:next` target uses — one definition of "a valid work
  // item ref". The route's Zod key regex has already rejected junk by here, so a
  // null (unnormalizable) key can only come from a direct service caller.
  const key = normalizeWorkItemRef(ticketKey);

  // Independent reads (prompt body + claim reviewers) — fetch concurrently.
  const [template, { csv: reviewersCsv, taskMetadata: reviewerMetadata, effortBlock, localReviewerBlock }] = await Promise.all([
    getTaskPrompt('claim-issue-jira'),
    resolveClaimReviewerPrompt(app),
  ]);
  const prompt = applyAppPlaceholders(template, app)
    // Function-form replacer so a literal `$` in the reviewers CSV isn't read as
    // a backreference.
    .replace(/\{reviewers\}/g, () => reviewersCsv || 'none')
    + appendTargetWorkItemBlock('claim-issue-jira', key)
    + effortBlock
    + localReviewerBlock;

  return { ticketKey: key, prompt, taskMetadata: { ...reviewerMetadata, useWorktree: false, openPR: false, claimFlow: true } };
}


/**
 * Build a one-off "re-plan THIS issue" task — the Replan button beside Claim on
 * an app's Issues tab. A second model re-derives the plan from today's code and
 * leaves refinements, redirections, or adjustments on the tracker.
 *
 * Scoped to the forge the Issues tab actually listed (`resolveAppForgeTarget`,
 * the same resolver `listAppIssues` uses), so the comment lands on the repo the
 * user was reading rather than on whatever the checkout's origin happens to be.
 *
 * Not a claim and not `/do:replan`: nothing is implemented, nothing is assigned,
 * and the whole backlog is not audited. The deliverable is a tracker comment, so
 * the run is read-only and its clean worktree is the success shape — see
 * `buildIssueReplanPrompt` for the review contract itself.
 *
 * Throws a 400 ServerError when the app's tracker is not a forge issue tracker
 * (PLAN.md / JIRA have no issue to comment on) or when `target` is not a forge
 * issue number.
 *
 * @returns {Promise<{ tracker, prompt, taskMetadata, target }>}
 */
export async function buildIssueReplanTask(app, { target, issueContext, overrideContext } = {}) {
  const {
    resolveAppForgeTarget, forgeCliForTracker, workTrackerLabel: trackerLabel, trackerToClaimTaskType,
  } = await import('../lib/workTracker.js');

  const targetRef = normalizeWorkItemRef(target);
  if (!targetRef || !/^\d+$/.test(targetRef)) {
    throw new ServerError('Replan needs the number of the issue to review', { status: 400, code: 'REPLAN_TARGET_REQUIRED' });
  }

  const { tracker, target: forgeTarget } = await resolveAppForgeTarget(app);
  if (tracker !== 'github' && tracker !== 'gitlab') {
    throw new ServerError(
      `Replan needs a GitHub or GitLab issue tracker (${app.name} resolved to ${trackerLabel(tracker)})`,
      { status: 400, code: 'UNSUPPORTED_REPLAN_TRACKER' }
    );
  }
  const cli = forgeCliForTracker(tracker) || 'gh';

  const prompt = buildIssueReplanPrompt({
    appName: app.name,
    repoPath: app.repoPath,
    target: targetRef,
    cli,
    trackerName: trackerLabel(tracker),
    // gh takes a host-qualified spec; glab resolves the project from the
    // checkout, so it gets the plain path and no --repo flag it can't parse.
    repoFlag: (tracker === 'github' && forgeTarget?.repoSpec) ? forgeTarget.repoSpec : '',
  })
    // Reuses the claim flow's prefetched-issue block verbatim: the Issues tab has
    // already fetched this title/body, and the block's untrusted-data framing is
    // exactly what a prompt embedding someone else's issue text needs. Keyed on
    // the tracker's claim task type so its forge gate matches this run's forge.
    + appendPrefetchedIssueContext(trackerToClaimTaskType(tracker), targetRef, issueContext)
    + appendClaimOverrideContext(overrideContext);

  return {
    tracker,
    prompt,
    target: targetRef,
    // No worktree, no PR, and `noCodeOutput` because the deliverable is a forge
    // comment — that flag is what suppresses the commit/push/PR completion
    // contract, so the agent is never told to `/do:push` a run that changed
    // nothing. `worktreeChangesExpected: false` keeps its clean tree from being
    // scored as a missed deliverable (#3636).
    taskMetadata: { useWorktree: false, openPR: false, noCodeOutput: true, worktreeChangesExpected: false },
  };
}
