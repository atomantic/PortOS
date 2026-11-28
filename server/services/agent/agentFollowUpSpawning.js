/**
 * Queues and resumes the coordinator that reviews or merges an agent pull request.
 */

import { emitLog } from '../cos/cosEvents.js';
import { addTask, updateTask, getTaskById } from '../cos/cosTaskStore.js';
import { isTruthyMeta } from './agentState.js';
import { isFalsyMeta } from '../../lib/metadataFlags.js';
import { ServerError } from '../../lib/errorHandler.js';
import { CODE_REVIEWERS_PAGE_BREADCRUMB } from '../../lib/navManifest.js';
import { detectForgeCli, parsePullRequestUrl } from '../../lib/gitForge.js';
import { normalizeForkHead } from '../../lib/forkHead.js';
import { PR_COMPLETIONS, prHeldForOperator } from '../../lib/prDisposition.js';
import { DEFAULT_REVIEWER, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, MODEL_SELECTABLE_REVIEWERS, EFFORT_SELECTABLE_REVIEWERS, isProviderReviewer, normalizeReviewers, normalizeReviewUsernames, normalizeOptionalReviewers, normalizeReviewerMaxRounds, prioritizeToolFreeReviewers } from '../../lib/reviewerConfig.js';
import { readClaimOwnershipAgents } from '../cos/cosClaimOwnership.js';
import { MAX_TOTAL_SPAWNS } from '../../lib/cos/cosTaskMetadata.js';

/**
 * The follow-up's reviewer roster before the forge identity preflight.
 * Self-review empties it HERE rather than at each caller: "the agent reviews it
 * itself" and "these reviewers review it" are mutually exclusive, and the
 * non-obvious half is the usernames — a single `@login` inherited from the Code
 * Review Defaults keeps the roster non-empty and quietly puts the run back on
 * the delegated path the caller opted out of.
 *
 * An EXPLICITLY empty reviewer list means "no review was requested" and must
 * stay empty — normalizeReviewers' `[copilot]` default would otherwise resurrect
 * a reviewer. CLI-based reviewers work on any forge because the agent invokes the
 * CLI directly; copilot is dropped on a non-GitHub forge. GitHub reviewer
 * usernames and the non-blocking (`~opt`) marker set are forge-agnostic and are
 * NOT stripped there — a username reviewer alone can drive the loop.
 */
function resolveReviewRoster({ reviewers, usernames, optionalReviewers, selfReview, isNonGithubForge }) {
  if (selfReview) return { reviewers: [], usernames: [], optionalReviewers: [] };
  const reviewerList = Array.isArray(reviewers) && reviewers.length === 0 ? [] : normalizeReviewers({ reviewers });
  return {
    reviewers: prioritizeToolFreeReviewers(isNonGithubForge ? reviewerList.filter(r => r !== DEFAULT_REVIEWER) : reviewerList),
    usernames: normalizeReviewUsernames(usernames),
    optionalReviewers: normalizeOptionalReviewers(optionalReviewers) || [],
  };
}

function throwRequiredReviewerFault(entries, summary, code) {
  const detail = entries.map((e) => `@${e.token}: ${e.reason}`).join('; ');
  throw new ServerError(`${summary} — ${detail}. Fix it in ${CODE_REVIEWERS_PAGE_BREADCRUMB}.`, {
    status: 409, code, context: { reviewers: entries.map((e) => e.token) },
  });
}

/**
 * Target-forge identity preflight (#13115). A handle the forge verifiably does
 * not have (or the PR's own author) would fail every PR-side request. A REQUIRED
 * one fails closed — the run must not merge without the review the operator
 * demanded; an OPTIONAL one is left out of this run's emitted roster and recorded
 * in `faults`, never reported clean. Lookups that merely fail (auth/transport)
 * are inconclusive and change nothing. The saved roster is never rewritten.
 */
async function preflightReviewerRoster({ usernames, optionalReviewers, isNonGithubForge, parsedPr }) {
  const unchanged = { usernames, optionalReviewers, faults: [] };
  if (!usernames.length && !optionalReviewers.length) return unchanged;
  const { preflightReviewerIdentities, preflightReviewerPrAuthor } = await import('../reviewerIdentity.js');
  const preflight = await preflightReviewerIdentities({
    usernames, optionalReviewers, forge: isNonGithubForge ? 'gitlab' : 'github', host: parsedPr?.host,
  });
  if (preflight.requiredMissing.length) {
    throwRequiredReviewerFault(preflight.requiredMissing, 'Required reviewer not found on the target forge', 'REVIEWER_IDENTITY_NOT_FOUND');
  }
  const eligibility = isNonGithubForge ? { required: [], optional: [] } : await preflightReviewerPrAuthor({ usernames, optionalReviewers, pr: parsedPr });
  if (eligibility.required.length) {
    throwRequiredReviewerFault(eligibility.required, 'Required reviewer configuration fault', 'REVIEWER_IS_PR_AUTHOR');
  }
  const optionalFaults = [...preflight.optionalMissing, ...eligibility.optional];
  if (!optionalFaults.length) return unchanged;
  const dropped = new Set(optionalFaults.map((e) => e.token.toLowerCase()));
  const faults = optionalFaults.map(({ token, reason }) => ({ token, reason }));
  console.log(`🚫 Optional reviewer(s) unavailable for this run: ${faults.map((f) => `@${f.token}`).join(', ')}`);
  return {
    usernames: usernames.filter((u) => !dropped.has(u.toLowerCase())),
    optionalReviewers: optionalReviewers.filter((r) => !dropped.has(r.replace(/^@/, '').toLowerCase())),
    faults,
  };
}

/**
 * One place that names the follow-up mode, so the title, the log line, and the
 * warning can't drift apart as the follow-up kinds evolve.
 */
function describeFollowUpKind({ mergeOnly, selfReviewMerge, reviewers, usernames }) {
  if (!mergeOnly) return { title: 'Review Loop', label: 'review-loop', reviewers: [...reviewers, ...usernames.map(u => `@${u}`)].join(', ') };
  if (selfReviewMerge) return { title: 'Self-Review & Merge', label: 'self-review-merge', reviewers: 'self-review, no delegated reviewer' };
  return { title: 'Merge', label: 'merge', reviewers: 'merge on green CI, no review' };
}

/**
 * The source task's provider/model/effort pins, for a follow-up that runs a
 * coding harness (it fixes checks, resolves conflicts, drives reviewer CLIs). An
 * install whose ACTIVE provider is api-only would permanently reject an unpinned
 * follow-up for lacking a harness — and the PR it was spawned to land would sit
 * open forever. Only what is actually pinned is copied; an unpinned source task
 * still resolves through the normal active-provider path.
 *
 * The model pin rides ONLY with its provider: a bare `model` would be treated as
 * explicit against whatever provider resolution later picks, handing e.g. a
 * Claude model id to Codex. Effort is provider-agnostic, so it travels alone.
 */
function inheritProviderPins(sourceMeta) {
  const pins = {};
  const provider = sourceMeta.provider || sourceMeta.providerId || null;
  if (provider) {
    pins.provider = provider;
    pins.providerId = provider;
    if (sourceMeta.model) pins.model = sourceMeta.model;
  }
  if (sourceMeta.effort) pins.effort = sourceMeta.effort;
  if (sourceMeta.executionOptions != null) pins.executionOptions = sourceMeta.executionOptions;
  return pins;
}

/**
 * Spawn an internal follow-up task that drives the ordered multi-reviewer
 * review-and-fix loop on the just-created PR until the configured reviewer chain
 * is satisfied, then merges the PR. This is what makes the user-facing "review
 * loop" actually loop — the original agent only opens the PR (and at most
 * pre-requests Copilot when it leads) and exits; without this follow-up the loop
 * ends after one iteration and the PR is never merged.
 *
 * `reviewers` is the ordered list (e.g. `[codex, antigravity, copilot]`); the follow-up
 * runs each in order — invoking the CLI reviewers itself and requesting Copilot at
 * its turn — honoring `reviewStopMode` (`all`/`on-findings`/`on-clean`). Copilot is GitHub-only, so it is stripped here on non-GitHub
 * forges. `usernames` are arbitrary GitHub reviewer usernames the follow-up
 * requests as PR reviewers to gate the merge — forge-agnostic, so never stripped.
 *
 * `prCompletion` is resolved before this function is called. It selects review
 * then merge versus merge on green directly; `leave-open` is intentional and
 * returns without creating a follow-up.
 *
 * The follow-up task uses an isolated worktree attached to the existing PR branch
 * through its canonical `reviewLoopPRBranch`, so it can fix-and-push without
 * trampling concurrent agents. `forkHead` is where that branch lives when the PR
 * came from a FORK — such a head has no `origin/<branch>` for the attach to
 * resolve, so without it the follow-up is queued and then blocked at workspace
 * prep for exactly the PRs external contributors open (#6064). Persisted beside
 * the branch name and threaded back out by `agentWorkspacePrep`; a same-repo PR
 * passes null and nothing changes.
 *
 * `dispatch` decides WHO starts the task:
 *   `'queue'`     (default) — the autonomous lane. The task is persisted and the
 *                 ordinary `tasks:changed` dequeue picks it up, which is correct
 *                 for a follow-up spawned by cleanup/prWatcher: the run that
 *                 produced the PR was itself autonomous, so its continuation
 *                 belongs under the CoS auto-run gate and daily action budget.
 *   `'immediate'` — an explicit human action (the app PR page's "Resolve &
 *                 merge"). The dequeue's Priority-2 tier only spawns
 *                 auto-approved system tasks while CoS auto-run is in `execute`
 *                 and under budget, so a queued follow-up would sit `pending`
 *                 until the user pressed Run now on the task page — the whole
 *                 point of the button was not having to. This suppresses the
 *                 automatic dequeue and force-spawns the task instead (same path
 *                 as that Run now button), reporting the outcome as `dispatch`.
 *
 * `selfReview` says the follow-up agent is the reviewer: it EMPTIES the roster
 * (reviewers, usernames and the `~opt` set alike) and then marks the resulting
 * no-roster run as one that still owes the change a review. That distinction is
 * the whole point — an empty roster has always meant "nothing reviews this, just
 * land it on green CI", and that stays what it means without this flag.
 * Deliberately ignored on a `merge-on-green` run, where the caller asked for no
 * review at all rather than for an undelegated one.
 *
 * Returns the follow-up task, or — when an equivalent follow-up was already
 * queued — that existing task with `duplicate: true`. `dispatch: 'immediate'`
 * additionally stamps `dispatch: { started, reason }` so the caller can say
 * whether an agent actually started or the task is still waiting (no slots,
 * daemon stopped, …) rather than guessing.
 */
function narrowReviewerPins(effectiveReviewers, pins, roster) {
  const out = Object.fromEntries(effectiveReviewers
    .filter(r => (roster.includes(r) || isProviderReviewer(r)) && pins?.[r])
    .map(r => [r, pins[r]]));
  return Object.keys(out).length ? out : null;
}

function buildFollowUpTaskPayload({
  followUpTaskId, originalAgentId, originalTask, prUrl, prBranch, forkHead, parsedPr,
  prCompletion, kind, effectiveReviewers, effectiveUsernames, effectiveOptionalReviewers,
  reviewerIdentityFaults, effectiveReviewerMaxRounds, reviewStopMode, reviewerModels,
  reviewerEfforts, mergeOnly, selfReviewMerge, leaveOpen, reviewTarget, reviewLoopForkTarget,
}) {
  // Reviewer-keyed model and reasoning-effort maps, narrowed to the selectable
  // reviewers actually in this loop's list (empty -> null so the prompt builder's
  // "nothing configured" path is unambiguous).
  const narrowedReviewerModels = narrowReviewerPins(effectiveReviewers, reviewerModels, MODEL_SELECTABLE_REVIEWERS);
  const narrowedReviewerEfforts = narrowReviewerPins(effectiveReviewers, reviewerEfforts, EFFORT_SELECTABLE_REVIEWERS);
  const providerPins = inheritProviderPins(originalTask?.metadata || {});

  // Routing key, and the one field here that turns a serialization slip into a
  // dead PR: a follow-up whose `app` doesn't resolve is BLOCKED by
  // prepareAgentWorkspace before it starts, so the PR it exists to land sits
  // open forever. Left undefined (not `null`) for a PortOS-local task, so the
  // stored form drops the key instead of keeping an explicit null app.
  const appId = originalTask?.metadata?.app;
  const sourceTaskDesc = originalTask?.description || 'CoS automated task';
  const firstLine = sourceTaskDesc.split(/[\r\n]/).find(l => l.trim()) || sourceTaskDesc;
  const followUpTitle = `[${kind.title}] ${firstLine.trim().substring(0, 80)} (${prUrl})`;

  return {
    id: followUpTaskId,
    status: 'pending',
    priority: (originalTask?.priority || 'MEDIUM').toUpperCase(),
    priorityValue: 2,
    description: followUpTitle,
    metadata: {
      app: appId,
      ...providerPins,
      // useWorktree is required so the follow-up runs in isolation. Its canonical
      // reviewLoopPRBranch below tells the shared resolver which PR branch to attach.
      useWorktree: true,
      // openPR/reviewLoop must stay false so cleanup doesn't try to create another PR
      // or request another initial review (the agent itself drives the loop)
      openPR: false,
      reviewLoop: false,
      simplify: false,
      // Marker flags consumed by the agent prompt + completion handler
      reviewLoopFollowUp: true,
      ...(reviewTarget ? { cleanupReviewTarget: reviewTarget, resumeWorktreePath: reviewTarget.worktreePath } : {}),
      prCompletion,
      // Per-task merge choices (auto-merge, auto-approve, admin merge) outlive the PR-opening run; unset re-reads the app.
      ...Object.fromEntries(['useAutoMerge', 'autoApprovePR', 'adminMerge']
        .filter((key) => isTruthyMeta(originalTask?.metadata?.[key]) || isFalsyMeta(originalTask?.metadata?.[key]))
        .map((key) => [key, isTruthyMeta(originalTask.metadata[key])])),
      // Merge-only run: no reviewers, the prompt is a CI-gate-and-merge procedure.
      reviewLoopMergeOnly: mergeOnly,
      // …and, on that same path, whether the agent owes the change its OWN
      // review first. Read by `buildMergeFollowUpSection`, which is why it sits
      // beside the flag that selects that section rather than in the roster keys
      // below — there is no roster in this mode.
      reviewLoopSelfReview: selfReviewMerge,
      // Review, but do NOT merge — the PR is a human's to land (JIRA hand-off).
      reviewLoopLeaveOpen: leaveOpen,
      reviewLoopPRUrl: prUrl,
      reviewLoopPRBranch: prBranch,
      // Fork coordinates for that branch, or null for a same-repo head. The
      // shared reader is `resolveTaskForkHead`, so this key is the generic
      // `forkHead` rather than a review-loop-specific one.
      forkHead: normalizeForkHead(forkHead),
      reviewLoopForkTarget,
      reviewLoopPRNumber: parsedPr?.number ?? null,
      reviewLoopPRHost: parsedPr?.host ?? null,
      reviewLoopPROwner: parsedPr?.owner ?? null,
      reviewLoopPRRepo: parsedPr?.repo ?? null,
      reviewLoopReviewers: effectiveReviewers,
      // Arbitrary GitHub reviewer usernames the follow-up requests as PR reviewers
      // and gates the merge on (appended to `--review-with` as `@user`).
      reviewLoopReviewerUsernames: effectiveUsernames,
      reviewLoopOptionalReviewers: effectiveOptionalReviewers,
      ...(reviewerIdentityFaults.length ? { reviewLoopReviewerIdentityFaults: reviewerIdentityFaults } : {}),
      // Per-reviewer `~max=<n>` caps, keyed by emitted token. Empty object = no
      // caps (leaves slashdo's per-loop built-in default in place); an absent key
      // is NOT `0`, which slashdo reads as "loop until clean".
      reviewLoopReviewerMaxRounds: effectiveReviewerMaxRounds,
      reviewLoopStopMode: reviewStopMode,
      // Public PR/MR diffs are untrusted input. Review subprocesses stay
      // advisory/read-only; the follow-up agent independently applies fixes.
      reviewLoopReviewerApplies: false,
      reviewLoopReviewerModels: narrowedReviewerModels,
      reviewLoopReviewerEfforts: narrowedReviewerEfforts,
      // Back-compat: older installs' prompt builder reads only the codex-scalar key.
      // Mirror the (already-narrowed) codex entry so a follow-up task persisted by this
      // version still threads a codex model after a downgrade. Remove once no supported
      // peer reads it.
      reviewLoopCodexModel: narrowedReviewerModels?.codex || null,
      sourceTaskId: originalTask?.id || null,
      sourceAgentId: originalAgentId || null,
      // This follow-up may legitimately exit with zero new commits when every
      // reviewer comes back clean — completion handling must not treat a
      // zero-commit exit as a failure.
      readOnly: false,
    },
    autoApproved: true,
    section: 'pending',
  };
}

export async function spawnReviewLoopFollowUp({ originalAgentId, originalTask, prUrl, prBranch, forkHead = null, sourceWorkspace, prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE, reviewers = DEFAULT_REVIEWERS, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerModels = null, reviewerEfforts = null, leaveOpen = false, selfReview = false, dispatch = 'queue', reviewTarget = null }) {
  if (!prUrl || !prBranch) return null;
  if (prCompletion === PR_COMPLETIONS.LEAVE_OPEN) return null;

  if (reviewTarget) {
    const { validateCleanupReviewTarget } = await import('../cos/cosMergeHandoff.js');
    if (reviewTarget.prUrl !== prUrl || reviewTarget.branch !== prBranch
      || reviewTarget.ownerTaskId !== originalTask?.id || reviewTarget.ownerId !== originalAgentId) return { blocked: 'Review recovery identity changed' };
    const refused = await validateCleanupReviewTarget({ target: reviewTarget, workspacePath: sourceWorkspace });
    if (refused) return { blocked: refused };
  }

  // Recovery belongs to the same durable task. A fresh sys-rl task resets the
  // spawn budget on every CI/conflict handoff and recursively nests its title.
  // The id hint also recovers receipts written before the marker was retained.
  if (isTruthyMeta(originalTask?.metadata?.reviewLoopFollowUp) || originalTask?.id?.startsWith('sys-rl-')) {
    return resumeReviewLoopCoordinator(originalTask.id, prUrl, prBranch, reviewTarget);
  }

  const parsedPr = parsePullRequestUrl(prUrl);
  // Copilot is GitHub-only. Classify with the shared detector rather than
  // `host !== 'github.com'` — a GitHub Enterprise host still has Copilot, and
  // misreading it as non-GitHub would strip the only reviewer and silently
  // downgrade the run to merge-only.
  const isNonGithubForge = !!parsedPr?.host && detectForgeCli(parsedPr.host) !== 'gh';
  const roster = resolveReviewRoster({ reviewers, usernames, optionalReviewers, selfReview, isNonGithubForge });
  const effectiveReviewers = roster.reviewers;
  const { usernames: effectiveUsernames, optionalReviewers: effectiveOptionalReviewers, faults: reviewerIdentityFaults } = await preflightReviewerRoster({
    usernames: roster.usernames, optionalReviewers: roster.optionalReviewers, isNonGithubForge, parsedPr,
  });
  // Per-reviewer iteration caps (`~max=<n>`) — forge-agnostic, threaded verbatim
  // so the follow-up's `--review-with` carries the same budgets. Entries for
  // reviewers that were stripped are inert (the emitter only marks tokens it
  // actually emits), so no narrowing is needed here.
  const effectiveReviewerMaxRounds = normalizeReviewerMaxRounds(reviewerMaxRounds) || {};
  // A review WAS asked for, but nothing is left to perform it — a legacy review
  // loop whose GitHub-only reviewer vanished on another forge (which retains its
  // prior merge-only fallback rather than leaving an orphaned PR), or a caller
  // that deliberately resolved no roster. Named rather than inlined into
  // `mergeOnly`, because the self-review branch below is exactly this case and
  // re-deriving it by conjunction reads as a condition that might contradict it.
  const noRosterMerge = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE
    && effectiveReviewers.length === 0 && effectiveUsernames.length === 0;
  // Merge-on-green deliberately skips every reviewer.
  const mergeOnly = prCompletion === PR_COMPLETIONS.MERGE_ON_GREEN || noRosterMerge;
  // The follow-up reviews the change ITSELF before the CI gate. Only meaningful
  // on the no-roster path — with reviewers configured the review loop already
  // runs — and never on a `merge-on-green` run, where the caller asked for no
  // review at all rather than for an undelegated one.
  const selfReviewMerge = selfReview && noRosterMerge;
  // ...and with nothing to review AND nothing to merge there is no follow-up at
  // all (a JIRA-tracked task whose reviewers were all stripped). The caller
  // normally catches this; the guard keeps the invariant local to this function.
  if (mergeOnly && leaveOpen) return null;

  const kind = describeFollowUpKind({ mergeOnly, selfReviewMerge, reviewers: effectiveReviewers, usernames: effectiveUsernames });
  const reviewLoopForkTarget = forkHead && !leaveOpen
    ? await (await import('../forkReviewMergeTarget.js')).captureForkReviewMergeTarget({ prUrl, prBranch, forkHead, sourceWorkspace })
    : null;

  const followUpTaskId = `sys-rl-${Date.now().toString(36)}`;
  const followUpTask = buildFollowUpTaskPayload({
    followUpTaskId, originalAgentId, originalTask, prUrl, prBranch, forkHead, parsedPr,
    prCompletion, kind, effectiveReviewers, effectiveUsernames, effectiveOptionalReviewers,
    reviewerIdentityFaults, effectiveReviewerMaxRounds, reviewStopMode, reviewerModels,
    reviewerEfforts, mergeOnly, selfReviewMerge, leaveOpen, reviewTarget, reviewLoopForkTarget,
  });

  // An immediate dispatch owns the spawn, so the automatic dequeue is suppressed:
  // otherwise it races this force-spawn for the same task and whichever loses
  // reports a bogus failure for a run that did start (see the `suppressDequeue`
  // contract on cos.js's `tasks:changed` listener).
  const immediate = dispatch === 'immediate';
  const persisted = await addTask(followUpTask, 'internal', { raw: true, suppressDequeue: immediate });

  // A duplicate rejection persisted NOTHING under `followUpTaskId` — an equivalent
  // follow-up is already queued under a different id. Return THAT record so a
  // caller reports (and force-spawns) the task that actually exists instead of the
  // id we just minted, which `forceSpawnTask` would answer with "Task not found".
  if (persisted?.duplicate) {
    emitLog('info', `🔁 ${kind.label} follow-up for PR ${prUrl} matched already-queued task ${persisted.id}`, {
      taskId: persisted.id, prUrl, prBranch, sourceAgentId: originalAgentId, sourceTaskId: originalTask?.id
    });
    return persisted;
  }

  emitLog('info', `🔁 Spawned ${kind.label} follow-up task ${followUpTaskId} (${kind.reviewers}) for PR ${prUrl}`, {
    taskId: followUpTaskId, prUrl, prBranch, sourceAgentId: originalAgentId, sourceTaskId: originalTask?.id
  });
  if (!immediate) return followUpTask;

  // A throw here would 500 an explicit user request whose task IS already
  // persisted — report it the same way a refusal is reported instead.
  const spawn = await import('../cos/cos.js')
    .then(({ forceSpawnTask }) => forceSpawnTask(followUpTaskId))
    .catch(err => ({ error: err.message }));
  if (spawn?.error) {
    // The task stays `pending` and keeps its place in the queue — say why it has
    // not started rather than letting the caller claim an agent is running.
    emitLog('warn', `⏳ ${kind.label} follow-up ${followUpTaskId} queued but not started — ${spawn.error}`, {
      taskId: followUpTaskId, prUrl
    });
    return { ...followUpTask, dispatch: { started: false, reason: spawn.error } };
  }
  emitLog('info', `⚡ Started ${kind.label} follow-up ${followUpTaskId} immediately for PR ${prUrl}`, {
    taskId: followUpTaskId, prUrl
  });
  return { ...followUpTask, dispatch: { started: true, reason: null } };
}

async function resumeReviewLoopCoordinator(taskId, prUrl, prBranch, reviewTarget = null) {
  const task = await getTaskById(taskId);
  if (!task || task.taskType !== 'internal' || !isTruthyMeta(task.metadata?.reviewLoopFollowUp)
    || task.metadata.reviewLoopPRUrl !== prUrl || task.metadata.reviewLoopPRBranch !== prBranch) {
    return { id: taskId, blocked: 'Review coordinator identity could not be verified' };
  }
  if (prHeldForOperator(task)) {
    return { id: taskId, blocked: 'Review coordinator leaves this PR for its human owner' };
  }
  // Finalization can mark the task complete before its worker finishes cleanup.
  // Keep the receipt until that owner releases, including across daemon restarts.
  const agents = await readClaimOwnershipAgents();
  if (!agents) return { id: taskId, deferred: true };
  if (task.status === 'in_progress' || agents.some(agent => (agent.taskId === taskId
    || agent.metadata?.reviewLoopMergeTarget?.url === prUrl)
    && ['running', 'paused', 'orphaned', 'interrupted'].includes(agent.status))) {
    return { id: taskId, deferred: true };
  }
  if (task.status === 'pending') return { id: taskId, duplicate: true };
  if (task.status !== 'completed') return { id: taskId, blocked: `Review coordinator is ${task.status}` };
  const count = Number(task.metadata.totalSpawnCount);
  if (!Number.isInteger(count) || count < 1 || count >= MAX_TOTAL_SPAWNS) {
    return { id: taskId, blocked: 'Review coordinator retry budget exhausted or unreadable' };
  }
  const result = await updateTask(taskId, {
    status: 'pending',
    metadata: { reviewLoopRecoveryReason: 'The handed-off PR needs fresh validation, review or conflict resolution',
      ...(reviewTarget ? { cleanupReviewTarget: reviewTarget, resumeWorktreePath: reviewTarget.worktreePath } : {}) },
  }, 'internal', {
    expectedStatus: 'completed',
    expectedMetadata: Object.fromEntries([
      'totalSpawnCount', 'reviewLoopFollowUp', 'reviewLoopPRUrl', 'reviewLoopPRBranch',
      'prCompletion', 'reviewLoopLeaveOpen', 'readOnly', 'jiraTicketId', 'analysisType', 'updatedAt',
    ].map(key => [key, task.metadata[key]])),
  });
  if (result?.error) throw new Error(result.error);
  if (result?.statusChanged) return { id: taskId, deferred: true };
  emitLog('info', `🔁 Resumed review coordinator ${taskId} for PR ${prUrl} (${count}/${MAX_TOTAL_SPAWNS} runs used)`, { taskId, prUrl });
  return { id: taskId, resumed: true };
}
