/** Builds worktree, sentinel, and task-specific completion instructions. */

import { isAuditTaskType } from '../../lib/auditCatalog.js';
import { resolveTaskHookType } from '../taskTypeHooks.js';
import { PROGRAMMATIC_OUTPUT_COMPLETION_HEADING } from '../../lib/agent/agentSentinel.js';
import { COMPLETION_MODES } from '../../lib/agent/agentCompletionMode.js';
import { PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { DEFAULT_BRANCH_HEAD_GUIDANCE } from './reviewLifecycle.js';
import { isTruthyMeta } from '../../lib/metadataFlags.js';

export const NO_CHANGE_AUDIT_GUIDANCE = 'This audit may legitimately conclude that no change is needed. First verify the data this audit owns against authoritative sources. If the audited data is current, leave the worktree clean and do not run the commit, push, PR, or review steps below; write the completion sentinel when this provider uses one, or exit without committing when it does not. If a change is needed, continue through the normal workflow below.';

function withNoChangeAuditGuidance(guidance, noChangeSuccess) {
  return noChangeSuccess && guidance
    ? `${NO_CHANGE_AUDIT_GUIDANCE}\n\n${guidance}`
    : guidance;
}

const AUDIT_FLOW_GUIDANCE = 'Follow the bundled Better audit workflow through remediation, verification, PR publication, and cleanup. You own delivery: open the category PRs and merge into the repository default branch when current-head CI and configured reviews pass. If no external reviewers are configured, complete the internal review and merge after CI passes. This launch authorizes that merge by default; honor explicit --scan-only, --no-merge, and read-only constraints. Use plain git and the forge CLI when slash commands are unavailable. Do not stop at local commits or hand publication back to PortOS. A clean audit needs no PR. If any required gate is unavailable or fails, retain the work and report INCOMPLETE with the PR or branch and first unverified checkpoint.';

const RECONCILE_FLOW_GUIDANCE = 'Follow the branch reconciliation task above for the named branches only, including its branch allowlist, author checks, review-only and superseded no-mutation rules, configured reviews, current-head CI, and merge gates. The task owns any authorized commit, push, PR creation, merge, and cleanup of those branches. There is no implicit commit, push, or merge-back of the coordinator checkout. Report each verified outcome or the retained branch and first unverified checkpoint before signaling completion.';

const CHECKOUT_RECOVERY_GUIDANCE = 'Follow the app checkout recovery task above in the actual configured checkout. You own verified backups, backup refs, preservation branches and PRs, configured reviews, current-head required CI and merge gates, stash accounting, and final checkout verification against the latest origin default branch. Preserve active work and retain backups when blocked. Publish every unique change on a named branch with an open or merged PR; never push preservation work directly to the default branch. Existing commits may be preserved and published without making a new commit. PortOS performs no implicit commit, push, or worktree merge-back for this task. Report verified outcomes and PR URLs, or INCOMPLETE with retained work and the first unverified checkpoint; keep private paths and data out of public artifacts.';

const EXTERNAL_REPOSITORY_GUIDANCE = 'Deliver only the external repository work explicitly authorized by the task, in a scratch clone outside the PortOS checkout. You may edit code, commit, push and open a PR there only as the task directs; merge only when the task explicitly authorizes it and its required checks pass. Never edit, commit, push or open a PR from the PortOS checkout. PortOS will not publish or merge this work for you. A verified no-action result (such as zero open alerts) needs no commit or PR. The absence of an existing bot PR does not block creating an authorized fix PR. Report checked evidence, PR links and any unresolved work or blocker; do not claim completion while required work remains.';

const RELEASE_FLOW_GUIDANCE = 'Follow the bundled release workflow through its final verification and report. It owns release delivery; do not stop at a prepared commit or hand publication back to PortOS. If it cannot complete, report INCOMPLETE and the first unverified checkpoint instead of claiming a successful release. When no release is needed, retain the captured candidate checkout through server verification; it needs separately verified cleanup.';

/**
 * Why a run told not to touch the repository may still write ONE file — the
 * canonical account of #7405, which every other reference in the tree points at.
 *
 * A completion sentinel is PortOS's done-signal, not a repository edit, but
 * every section that emits one also carries a "do not modify anything" rule,
 * and the agent's HOST may hand it a restricted role on top of that. A small
 * local model resolves the apparent conflict the safe way and writes nothing,
 * then asks a human an unattended run does not have: an OpenCode MTPLX TUI run
 * stalled exactly there, refusing the sentinel because "the current session is
 * a read-only file-search specialist". (The role itself is pinned away at the
 * spawn site now — `ensureOpencodeAgent` in lib/provider/providerVendors.js — so this
 * note is the belt, not the fix.) Stating the carve-out is what makes the write
 * reachable when some future host does the same thing.
 *
 * The second sentence answers the other half of that stall: the same run went
 * looking for its sentinel path in `runner-state.json` / `state.json` after
 * noticing a SIBLING run's agent id in the shared checkout's branch state, and
 * never wrote one. There is no such lookup — `doneSentinelPath(cwd, agentId)`
 * resolves the single path for both the prompt and every watcher — and a
 * worktree-less run legitimately shares its workspace with other live agents,
 * so a foreign agent id in git or state is expected and means nothing here.
 */
export const SENTINEL_WRITE_PERMISSION_NOTE = 'Writing that one file is ALWAYS permitted, whatever the task shape or your host role says — it is PortOS\'s completion signal, not a repository edit, so no read-only, do-not-modify, or restricted-session rule applies to it. Use the sentinel path exactly as printed in this section: it is this run\'s only one. Do NOT look one up in `runner-state.json`, `state.json`, a branch name, or a worktree name, and do NOT treat another agent id in this workspace as a conflict — the filename already scopes the sentinel to you.';

/**
 * The closing sentence every sentinel-emitting section shares: PortOS is
 * already watching, so the write IS the handoff and nothing follows it.
 */
const SENTINEL_WATCH_TAIL = 'PortOS watches this sentinel and finalizes the run shortly after it appears — do NOT run `/quit` and do NOT wait for anything after writing the sentinel.';

/**
 * One sentinel-emitting completion section: the mode's own notice, its write
 * instruction, the shared watch tail, and the write-permission note.
 *
 * The three sections below used to assemble this shape by hand with the tail
 * typed out three times — which is how the permission note would have become a
 * per-section splice the next mode had to remember. Composing it here keeps
 * "prints a sentinel path" and "says the write is permitted" one fact.
 */
const TASK_OUTCOME_GUIDANCE = 'Write a JSON envelope with `summary` (your markdown report), `taskOutcome: { "status": "completed" | "no-action-needed" | "blocked" | "incomplete", "reason": "specific evidence or blocker" }`, and the existing `payload` when your task requires one. Use completed only when the requested deliverable is finished; no-action-needed only when checks verified no actionable work remains for this attempt (including a selected claim issue already resolved, closed with evidence, or parked by a repository operator pending new evidence); blocked for an unmet prerequisite; incomplete for unfinished work. For a claim that needs no code or PR, use no-action-needed even when your only action was closing the issue. Record the selected issue, live issue state, and why no actionable work remains in reason and summary. The server independently verifies the bound issue and either its merged closing PR, a repository operator\'s closure, or its current `blocked` or `needs-input` label applied by a repository operator with a clean checkout fully contained in the live default branch. An operator-parked issue stays open for its documented unblock condition; completing this attempt does not resolve the underlying defect. Agent prose or an unverified label alone does not pass. Use no-action-needed for this verified stand-down, not blocked; explicit runtime, approval, and cleanup recovery remain separate. Unfinished work resumes automatically within the existing retry/spawn budget. Recovery goes inside taskOutcome: `recovery: { "mode": "cleanup" }` only when repository cleanup alone remains after verified delivery (the server owns it once this run releases ownership; never for unmerged PRs, red validation, missing deliverables or unresolved findings); status blocked with `recovery: { "mode": "runtime", "prUrl": "https://github.com/owner/repository/pull/123", "requiredCommit": "<full merged PR head or merge commit>" }` for a PortOS investigation whose merged fix must be running before verification (the server checks boot ancestry and waits for the idle update policy, keeping budgets; never restart or force an update yourself); `recovery: { "mode": "approval", "options": ["concrete option and consequence", "alternative and consequence"] }` only when proceeding needs a human safety or preference decision, explained in reason, never for routine mechanical recovery. Process exit and writing this file do not prove task achievement. Preserve unfinished work and name what remains in the reason.';

const sentinelCompletionSection = (notice, writeInstruction) =>
  [notice, '', `${writeInstruction} ${SENTINEL_WATCH_TAIL}`, '', TASK_OUTCOME_GUIDANCE, '', SENTINEL_WRITE_PERMISSION_NOTE].join('\n');

const REASONING_ONLY_BULLET = '**This is a reasoning-only task.** The worktree is discarded on exit — do NOT commit, push, merge, or open a PR. Write your result to the completion sentinel (see the Completion section) and stop.';

const DISCARD_WORKTREE_HYGIENE = '- **Do NOT commit, push, or open a PR.** This worktree is discarded on exit — your only output is the completion sentinel (see the Completion section above).';

/**
 * Build the single "## Guidelines" completion-handoff bullet for the full
 * (api) prompt path, and the `## Instructions` step 4 / `## Git Hygiene` /
 * commit-target trio that has to agree with it.
 *
 * Both take the completion mode `resolveCompletionMode` already decided — they
 * do not re-derive it. Everything else they take is RENDERING detail (which
 * `/do:*` command this host can type, whether a PR is a human's to land), never
 * a second opinion about the contract.
 *
 * Returns the bullet body WITHOUT the leading `- ` marker (caller prepends),
 * or `null` when the mode produces no text (the legacy empty-string tail).
 *
 * @param {Object} opts
 * @param {string} opts.mode - a `COMPLETION_MODES` key. `COMPLETION_MODES.TUI_SLASHDO_FREE`
 *   is what points the bullet at the manual commit + system-handoff workflow
 *   instead of a `/do:*` command.
 * @param {string|null} opts.tuiCompletionCommand - `/do:pr` or `/do:push`; `null`
 *   when PortOS merges the branch back itself and the workflow is commit-only
 *   (see `portosMergesBranchOnExit`)
 * @param {Object|null} opts.worktreeInfo
 * @param {boolean} opts.willOpenPR
 * @param {'review-then-merge'|'merge-on-green'|'leave-open'} opts.prCompletion
 * @param {boolean} [opts.noChangeSuccess] - The task may succeed after a
 *   verified clean branch instead of producing a commit/PR.
 * @returns {string|null}
 */
export function buildCompletionGuidelineBullet({
  mode, tuiCompletionCommand,
  worktreeInfo, willOpenPR, prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN,
  humanLandsPr = false, noChangeSuccess = false, whenDone = null,
}) {
  // NOTE: the TUI arms are only reachable from the full/api prompt path, where
  // `isTui` is currently always false (TUI providers route through
  // buildLightContextPrompt, which emits the live TUI completion via
  // buildTuiCompletionSection — not this bullet). They're kept host-aware and
  // directly unit-tested so the guideline stays correct if that routing changes.
  const tuiBullet = () => {
    const howTo = mode === COMPLETION_MODES.TUI_SLASHDO_FREE
      ? 'the Completion Workflow above (plain `git` commit + PortOS handoff — this provider has no slashdo commands)'
      : tuiCompletionCommand
        ? `the Completion Workflow above (\`${tuiCompletionCommand}\`)`
        : 'the Completion Workflow above (commit only — no push; PortOS merges your branch back after you exit)';
    return withNoChangeAuditGuidance(`On successful completion, YOU run ${howTo}, then write the sentinel and stop — PortOS closes the session once it sees the sentinel; do NOT run \`/quit\`.`, noChangeSuccess);
  };

  const bullets = {
    [COMPLETION_MODES.TOOL_FREE]: () => TOOL_FREE_REASONING_BULLET,
    [COMPLETION_MODES.SENTINEL_PAYLOAD]: () => REASONING_ONLY_BULLET,
    [COMPLETION_MODES.EXTERNAL_REPOSITORY]: () => EXTERNAL_REPOSITORY_GUIDANCE,
    [COMPLETION_MODES.ACTION_OUTPUT]: () => '**This task produces no code output.** Its result is the API request or command your instructions describe (a PortOS endpoint call, a filed tracker issue, …) — do NOT run `/do:push`, `/do:pr`, `/simplify`, `git commit`, `git push`, or open a PR. Write the completion sentinel (see the Completion section) and stop.',
    [COMPLETION_MODES.DISCARD_WORKTREE]: () => REASONING_ONLY_BULLET,
    [COMPLETION_MODES.CLAIM_FLOW]: () => '**This is a self-managed claim flow.** Follow the claim prompt above through its phase-specific worktree, PR/MR, review, merge or human-handoff, and cleanup steps. Do NOT stop after committing or hand the lifecycle back to PortOS.',
    [COMPLETION_MODES.AUDIT_FLOW]: () => AUDIT_FLOW_GUIDANCE,
    [COMPLETION_MODES.RECONCILE_FLOW]: () => RECONCILE_FLOW_GUIDANCE,
    [COMPLETION_MODES.CHECKOUT_RECOVERY]: () => CHECKOUT_RECOVERY_GUIDANCE,
    [COMPLETION_MODES.RELEASE_FLOW]: () => RELEASE_FLOW_GUIDANCE,
    [COMPLETION_MODES.READ_ONLY]: () => '**This is a read-only task.** Do NOT commit, push, or modify any files in the repository. Only read data and generate reports.',
    // A PR follow-up already carries its own PRIMARY OBJECTIVE section with the
    // full procedure, and its cleanup runs with `skipMerge`. The generic "your
    // branch is merged back automatically" bullet would contradict both — and a
    // merge-only run legitimately makes no commit.
    [COMPLETION_MODES.REVIEW_LOOP_FOLLOW_UP]: () => 'Follow the follow-up section above — it is the whole task. Commit and push only fixes you actually make; the deliverable is the PR\'s final state, not a commit. Do NOT open a new PR, and do NOT expect this branch to be merged back for you.',
    [COMPLETION_MODES.TUI_SLASHDO_FREE]: tuiBullet,
    [COMPLETION_MODES.TUI]: tuiBullet,
    [COMPLETION_MODES.PORTOS_MERGES]: () => withNoChangeAuditGuidance('Your worktree branch will be automatically merged back to the source branch when your task completes — do NOT open a PR.', noChangeSuccess),
    [COMPLETION_MODES.WORKTREE_NO_PUSH]: () => {
      const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
      const runsReviewLoop = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
      const reviewSuffix = policyLeavesOpen
        ? ' This task is configured to leave the PR OPEN for you to inspect — no follow-up agent will review or merge it automatically.'
        : humanLandsPr
          ? ' This task is tracked in JIRA, so the PR is left OPEN for a human to land alongside the ticket — nothing merges it automatically.' + (runsReviewLoop ? ' A follow-up agent still runs the configured reviewers against it.' : '')
        : runsReviewLoop
          ? ' For GitHub PRs, a Copilot code review will also be requested automatically (skipped on GitLab and other non-GitHub forges) — do NOT run `/do:rpr` or attempt to address review comments yourself; you will have already exited.'
          : ' No review was requested for this task, so a follow-up agent merges the PR once CI is green — do NOT try to merge it yourself; you will have already exited.';
      return withNoChangeAuditGuidance(`On successful completion, the system will push your branch and open a pull request — do NOT open a PR manually. (If the task fails, no PR is opened; the worktree is then cleaned up unless a safety check preserves it for manual recovery.)${reviewSuffix}`, noChangeSuccess);
    },
  };

  const render = bullets[mode];
  if (render) return render();
  return whenDone === null ? null : whenDone === 'commit-push'
    ? 'Commit and push your changes to the default branch (see Git Hygiene below).'
    : 'Leave your code changes uncommitted in the default branch; do not commit or push.';
}

// The modes whose contract owns or forbids commits, so the trailing
// commit-target bullet ("your PR should contain only…" / "commit directly to
// the current branch") has nothing to say. Without the tool-free and read-only
// entries a no-worktree run of either shape was pointed at the checkout's own
// default branch (#6616).
const NO_COMMIT_TARGET_MODES = new Set([
  COMPLETION_MODES.TOOL_FREE,
  COMPLETION_MODES.SENTINEL_PAYLOAD,
  COMPLETION_MODES.ACTION_OUTPUT,
  COMPLETION_MODES.EXTERNAL_REPOSITORY,
  COMPLETION_MODES.DISCARD_WORKTREE,
  COMPLETION_MODES.CLAIM_FLOW,
  COMPLETION_MODES.RECONCILE_FLOW,
  COMPLETION_MODES.CHECKOUT_RECOVERY,
  COMPLETION_MODES.RELEASE_FLOW,
  COMPLETION_MODES.AUDIT_FLOW,
  COMPLETION_MODES.READ_ONLY,
]);

/**
 * The full (api) fallback template's three completion instructions, as ONE
 * per-mode record.
 *
 * `## Instructions` step 4, the `## Git Hygiene` bullet and the commit-target
 * bullet used to be three independent ternary ladders over the same flags. They
 * drifted: step 4 tested neither `toolFreeReasoning` nor `readOnly`, so both
 * shapes rendered a prompt that told the agent to commit and, four lines later,
 * that it had no git at all (#6616). Returning them together is what makes that
 * unrepresentable — a new mode either fills all three fields or fills none.
 *
 * @param {Object} opts
 * @param {string} opts.mode - a `COMPLETION_MODES` key
 * @param {Object|null} [opts.worktreeInfo]
 * @param {boolean} [opts.willOpenPR]
 * @param {string|null} [opts.tuiCompletionCommand]
 * @returns {{ step4: string, gitHygiene: string, commitTarget: string }}
 */
export function buildFallbackCompletionInstructions({
  mode, worktreeInfo = null, willOpenPR = false, tuiCompletionCommand = null,
}) {
  const portosMergesStep4 = (where) => `Commit your changes (see ${where}) — do NOT push, PortOS merges this branch back on exit`;
  const portosMergesHygiene = '- **Commit only — do NOT push.** Stage specific files (no `git add -A`), use `feat:`/`fix:`/`breaking:` prefix in the commit message, no Co-Authored-By annotations. PortOS merges this branch back into the source checkout after you exit and deletes it, so do NOT run `git push` or `/do:push` yourself — a pushed copy would only be left behind on origin.';
  // A TUI host with no `/do:*` command to name is exactly the merge-back
  // posture (`tuiCompletionCommand` is null only when PortOS lands the branch),
  // so it gets the commit-only contract rather than "Use `null` to …".
  const tuiEntry = () => (tuiCompletionCommand
    ? {
      step4: `Commit, push, and ${willOpenPR ? 'open the PR (see Completion Workflow above)' : 'push the branch (see Completion Workflow above)'}`,
      gitHygiene: `- **Use \`${tuiCompletionCommand}\` to ${willOpenPR ? 'commit, push, and open the PR' : 'commit and push the branch'}** — see the Completion Workflow section above. Stage specific files (no \`git add -A\`), use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations.`,
    }
    : { step4: portosMergesStep4('Completion Workflow above'), gitHygiene: portosMergesHygiene });

  const entries = {
    [COMPLETION_MODES.TOOL_FREE]: () => ({
      step4: 'Answer in this reply — you have no tools to commit, push, or call an API with; the Completion section above is the whole contract',
      gitHygiene: '- **No git at all.** You have no tools; the Completion section above is the whole contract.',
    }),
    [COMPLETION_MODES.SENTINEL_PAYLOAD]: () => ({
      step4: 'Write your result to the completion sentinel in the payload format your task describes (see the Completion section above) — do NOT commit, push, or open a PR',
      gitHygiene: DISCARD_WORKTREE_HYGIENE,
    }),
    [COMPLETION_MODES.EXTERNAL_REPOSITORY]: () => ({
      step4: EXTERNAL_REPOSITORY_GUIDANCE,
      gitHygiene: `- ${EXTERNAL_REPOSITORY_GUIDANCE}`,
    }),
    [COMPLETION_MODES.ACTION_OUTPUT]: () => ({
      step4: 'Deliver your result the way the task describes (the API call or command it names) — do NOT commit, push, or open a PR; this task changes no code',
      gitHygiene: '- **Do NOT commit, push, or open a PR.** This task changes no code — its result is delivered by the API call or command described above. Without this, a no-worktree task of this shape was told to `/do:push` **directly to the branch it is standing on**, which for a task running in the app\'s live checkout is its default branch.',
    }),
    [COMPLETION_MODES.DISCARD_WORKTREE]: () => ({
      step4: 'Write your result to the completion sentinel (see the Completion section above) — do NOT commit, push, or open a PR; this worktree is discarded on exit',
      gitHygiene: DISCARD_WORKTREE_HYGIENE,
    }),
    [COMPLETION_MODES.CLAIM_FLOW]: () => ({
      step4: 'Follow the claim workflow prompt above; it owns its worktree, PR/MR, review, merge or human-handoff, and cleanup. Do not stop after committing.',
      gitHygiene: '- **Follow the claim workflow prompt above.** It owns the claim worktree and the full PR/MR lifecycle; do not stop after committing or hand push/PR/merge/cleanup back to PortOS.',
    }),
    [COMPLETION_MODES.READ_ONLY]: () => ({
      step4: 'Do NOT commit, push, or modify any files — this is a read-only task; read what you need and report your findings',
      gitHygiene: '- **Do NOT commit, push, or modify any files.** This is a read-only task — read what you need and report your findings.',
    }),
    [COMPLETION_MODES.AUDIT_FLOW]: () => ({
      step4: AUDIT_FLOW_GUIDANCE,
      gitHygiene: `- ${AUDIT_FLOW_GUIDANCE}`,
    }),
    [COMPLETION_MODES.CHECKOUT_RECOVERY]: () => ({
      step4: CHECKOUT_RECOVERY_GUIDANCE,
      gitHygiene: `- ${CHECKOUT_RECOVERY_GUIDANCE}`,
    }),
    [COMPLETION_MODES.RECONCILE_FLOW]: () => ({
      step4: RECONCILE_FLOW_GUIDANCE,
      gitHygiene: `- ${RECONCILE_FLOW_GUIDANCE}`,
    }),
    [COMPLETION_MODES.RELEASE_FLOW]: () => ({
      step4: RELEASE_FLOW_GUIDANCE,
      gitHygiene: `- ${RELEASE_FLOW_GUIDANCE}`,
    }),
    [COMPLETION_MODES.REVIEW_LOOP_FOLLOW_UP]: () => ({
      step4: 'Follow the follow-up section above — push any fixes you make to the PR branch; a run that needed no fix makes no commit and that is a success, not a miss',
      gitHygiene: '- **Push fixes straight to the PR branch you are on** (the follow-up section above is the procedure). Stage specific files, use a `fix:` prefix, no Co-Authored-By annotations. Do NOT open a new PR.',
    }),
    [COMPLETION_MODES.TUI_SLASHDO_FREE]: () => ({
      step4: 'Commit your changes (see Completion Workflow above) — do NOT push; PortOS handles the branch after it closes the session',
      gitHygiene: '- **Commit only — do NOT push.** Stage specific files, use `feat:`/`fix:`/`breaking:` prefix in the commit message, no Co-Authored-By annotations, then write the completion sentinel. PortOS will handle the branch after it closes the session.',
    }),
    [COMPLETION_MODES.TUI]: tuiEntry,
    [COMPLETION_MODES.PORTOS_MERGES]: () => ({
      step4: portosMergesStep4('Git Hygiene below'),
      gitHygiene: portosMergesHygiene,
    }),
    [COMPLETION_MODES.WORKTREE_NO_PUSH]: () => ({
      step4: 'Commit your changes (see Git Hygiene below) — do NOT push, the system handles that on exit',
      gitHygiene: '- **Commit only — do NOT push.** Stage specific files, use `feat:`/`fix:`/`breaking:` prefix in the commit message, no Co-Authored-By annotations. The system will push your branch and open the PR after you exit, so do NOT run `git push` or `/do:push` yourself.',
    }),
  };

  const entry = (entries[mode] || (() => ({
    step4: 'Commit and push your changes (see Git Hygiene below)',
    gitHygiene: '- **Commit and push using `/do:push`** — this handles changelog updates, staging specific files, writing a conventional commit message, and pushing safely. If `/do:push` is unavailable, follow its conventions manually: stage specific files, use `feat:`/`fix:`/`breaking:` prefix, no Co-Authored-By annotations, and push with `git pull --rebase && git push`.',
  })))();

  const commitTarget = NO_COMMIT_TARGET_MODES.has(mode)
    ? ''
    : worktreeInfo
      ? '- **Your PR should contain only your task\'s commits.** If you see unrelated commits in your branch history, something is wrong — do not open a PR with other agents\' work.'
      : '- **Commit directly to the current branch.** Do NOT create feature branches or PRs unless explicitly instructed.';

  return { ...entry, commitTarget };
}

// One-line worktree note for a discard (reasoning-only) task, replacing the
// "commit / push / auto-merge" guidance the normal worktree section emits. The
// worktree exists only so the reasoner can make scratch edits without touching
// the real tree — cleanup discards it with no commit/merge/PR (see
// `discardWorktree` in agentWorktreeCleanup.js).
export const DISCARD_WORKTREE_NOTE = 'Do NOT commit, push, or open a PR — this worktree is discarded on exit. Make any scratch edits that help you reason; only the completion sentinel is kept.';

/**
 * Is this worktree attached to a branch a PR already points at — i.e. the
 * review-loop follow-up, whose guidance is "push review fixes here, the PR
 * points at this branch"?
 *
 * Identified POSITIVELY, off the follow-up's own `reviewLoopFollowUp` marker,
 * rather than as "any `existingBranch` worktree". `existingBranch` means only
 * "attach to this branch" and now has two producers: the follow-up, and a retry
 * resuming a dead agent's branch (`resumedFromAgentId`), which follows the task's
 * ordinary push/PR flow and may have no PR at all. Keying on the marker means a
 * THIRD producer defaults to the ordinary flow instead of silently inheriting
 * review-fix instructions for a PR that doesn't exist.
 */
export function isPrBranchWorktree(task, worktreeInfo) {
  return worktreeInfo?.existingBranch === true && !!task?.metadata?.reviewLoopFollowUp;
}

/**
 * Is this worktree a RESUME of a previous failed agent's branch? Keyed on
 * `resumedFromAgentId`, which only the resume path stamps (see
 * agentCompletionCleanup.js).
 */
function isResumedWorktree(task, worktreeInfo) {
  return worktreeInfo?.existingBranch === true && !!task?.metadata?.resumedFromAgentId;
}

/**
 * Resume banner for a retry picking up what a PREVIOUS unfinished agent left
 * behind (`metadata.existingBranch` + `resumedFromAgentId`, stamped by
 * `recordTaskResumePointer` when a dead run's branch — or whole worktree —
 * survived cleanup).
 *
 * Without this the retry sees an ordinary worktree that just happens to have
 * work in it and redoes what is already done — the failure mode the
 * agent-d2ae0352 incident exposed (reaped 30s after its PR merged; the
 * replacement agent started the shipped work over). Telling it to read the log
 * FIRST is the whole point: the prior run may have gone as far as opening or even
 * merging a PR, in which case there is nothing left to build.
 *
 * An ADOPTED worktree (`worktreeInfo.adopted` — the shape a server restart leaves,
 * killed mid-edit before committing) additionally carries the dead run's
 * uncommitted edits and untracked files, so the banner points at `git status`
 * as the primary record rather than the commit log.
 *
 * Returns '' when this isn't a resume, so callers can interpolate unconditionally.
 */
// Selection uses durable producer metadata, never the task's free-text description.
export function buildUnnecessaryDispatchSection(task) {
  const meta = task?.metadata || {};
  if (![meta.isInvestigation, meta.reviewLoopFollowUp, meta.gitConflictResolution].some(isTruthyMeta)
    && !meta.githubNotificationResolve) return '';
  return `## Unnecessary dispatch investigation
If you verify the assigned action is already complete or no longer needed, before finishing trace why this run was dispatched: inspect the source task, producer, trigger and recovery evidence, and current target state. A failure that no longer reproduces is not a diagnosis. Prefer a bounded, authorized fix and verify it without asking for confirmation. Otherwise search the owning tracker and add redacted evidence to an existing issue or file an actionable issue. Report source-backed reasoning and the fix or issue link, or evidence of a legitimate race with no actionable defect. Do not invent a defect, repeat an already recorded investigation without new evidence, or dispatch an investigation of this investigation. Preserve ownership, cleanup obligations, budgets and the normal no-action-needed semantics.`;
}

export function buildResumeSection(task, worktreeInfo) {
  if (!isResumedWorktree(task, worktreeInfo)) return '';
  const priorAgentId = task.metadata.resumedFromAgentId;
  const carriedWork = worktreeInfo.adopted
    ? `**You are in its actual working directory** — its commits are on your branch \`${worktreeInfo.branchName}\`
AND any edits it had not committed yet are still in your working tree, exactly as it left them.`
    : `**Its commits are already on your branch** \`${worktreeInfo.branchName}\` — you are
continuing its run, not starting over.`;
  return `
## Resuming Unfinished Work — Read This First
A previous agent (\`${priorAgentId}\`) worked this same task and did NOT finish cleanly
(it hung, timed out, or was terminated — a server restart kills runs mid-edit).
${carriedWork}

Before you write any code, establish what is already done:
1. \`git status\` — anything it left uncommitted. Treat these as YOUR in-progress
   changes: review them, finish them, and commit them. Do not discard them wholesale.
2. \`git log --oneline ${worktreeInfo.baseBranch || 'origin/HEAD'}..HEAD\` — the commits it already made.
3. Check whether it already shipped: look for an open or merged PR for this branch
   — \`gh pr list --head ${worktreeInfo.branchName} --state all\` on GitHub,
   \`glab mr list --source-branch ${worktreeInfo.branchName}\` on GitLab.

Then do only what remains. If a PR is already **merged**, report that at completion.${buildUnnecessaryDispatchSection(task) ? ' First follow the unnecessary dispatch investigation contract in this prompt.' : ''} If a PR is already **open**,
finish/land that PR rather than opening a second one. Do NOT redo completed work,
and do NOT revert its commits unless they are actually wrong.
`;
}

const TOOL_FREE_REASONING_BULLET = '**You have no tools.** Do not try to run commands, read or write files, or call an API — none of that is available. Your entire deliverable is the final message of this reply: the exact JSON object described in your task instructions, and nothing after it. PortOS reads it from the transcript.';

/**
 * Completion block for a **tool-free reasoning** stage (pr-reviewer's
 * Eligibility Gate). The CLI runs with every tool removed, so the sentinel and
 * API-action contracts are impossible to satisfy; the only channel out is the
 * reply itself, which PortOS parses for the task's JSON envelope.
 */
export function buildToolFreeReasoningCompletionSection() {
  return [
    '## Completion (Tool-Free Reasoning)',
    TOOL_FREE_REASONING_BULLET,
    '',
    'Do not narrate a plan to apply the decision, and do not wait for anything after the JSON — the reply ends there.',
  ].join('\n');
}

/**
 * Completion block for a **programmatic-output** (throwaway-worktree) task: the
 * agent reasons in a worktree that is discarded on exit, so it must NOT commit,
 * push, merge, or open a PR. Its only channel out is the `.agent-done` sentinel,
 * whose exact payload shape is specified by the task instructions (a task-type
 * output hook — see `taskTypeHooks.js` / `layeredIntelligenceHooks.js`). This
 * replaces the normal `/do:push`+markdown-sentinel completion workflow, which
 * would tell the agent to push code (defeating the discard guarantee) and write
 * a markdown summary (breaking the hook's structured-JSON sentinel contract).
 */
export function buildProgrammaticOutputCompletionSection(sentinelPath) {
  return sentinelCompletionSection(
    // Shared constant: a pre-spawn task-type hook's prompt points here BY NAME.
    `## ${PROGRAMMATIC_OUTPUT_COMPLETION_HEADING}\nThis is a reasoning task, not a code change. The worktree you are in is **discarded on exit** — any commits, pushes, or PRs are thrown away and have no effect. Do NOT run \`/do:push\`, \`/do:pr\`, \`git commit\`, \`git push\`, or open a pull request.`,
    `When you have finished reasoning, write your result to \`${sentinelPath}\` in the exact payload format described in your task instructions, then stop.`
  );
}

/**
 * Completion block for a **read-only** task (e.g. reference-watch, pr-reviewer's
 * scan stage). The agent must NOT commit/push/modify source; its real output is
 * recorded elsewhere DURING the run (a tracker issue, PLAN.md, a report).
 *
 * A TUI agent still needs a `.agent-done` sentinel to signal completion — the
 * sentinel watcher in `spawnTuiAgent` is the primary finalize path and the channel
 * that ingests the run summary. Without it a read-only TUI run relies on shell
 * exit, so the resolution summary is not captured cleanly (the bug this
 * repairs). CLI/API read-only agents complete on process exit and never poll a
 * sentinel, so they get the bare notice only.
 */
export function buildReadOnlyCompletionSection({ isTui = false, sentinelPath = null } = {}) {
  const notice = '## Read-Only Task\nDo NOT commit, push, or modify any files in the repository. Read data and report findings only.';
  if (!isTui || !sentinelPath) return notice;
  return sentinelCompletionSection(
    notice,
    `When you have finished, write a JSON envelope summarizing what you found (and where you recorded it) to \`${sentinelPath}\`, then stop.`
  );
}

/**
 * Completion block for a **no-code / API-action** task (e.g. a Creative Director
 * plan/treatment/evaluate agent). The agent's deliverable is the HTTP request its
 * task instructions already describe (a PATCH to a PortOS endpoint), NOT a code
 * change — so the normal `/do:push`+PR completion workflow is wrong: there is
 * nothing to commit or push, and telling the agent to run `/do:push` just makes it
 * load that skill for no reason (and can contradict the task prompt's own
 * "on a 200 your task is complete"). A TUI agent still writes a `.agent-done`
 * sentinel so the watcher finalizes it promptly instead of waiting for a runtime
 * reaper.
 */
export function buildActionOutputCompletionSection({ isTui = false, sentinelPath = null } = {}) {
  const notice = '## Completion (No Code Output)\nThis task produces **no code change** — its result is delivered DURING the run by the API request or command your instructions describe (a PATCH to a PortOS endpoint, a filed tracker issue, …), not by a commit and not by this sentinel. Do NOT run `/do:push`, `/do:pr`, `/simplify`, `git commit`, `git push`, or open a pull request; there is nothing to push.';
  if (!isTui || !sentinelPath) return notice;
  return sentinelCompletionSection(
    notice,
    `Your task is complete once that request succeeds. Then write a short summary, including any structured report required by your task, to \`${sentinelPath}\` and stop.`
  );
}

export function buildExternalRepositoryCompletionSection({ isTui = false, sentinelPath = null } = {}) {
  const notice = `## Completion (External Repository)\n${EXTERNAL_REPOSITORY_GUIDANCE}`;
  if (!isTui || !sentinelPath) return notice;
  return sentinelCompletionSection(
    notice,
    `After verifying the outcome or identifying a blocker, write a summary with evidence, PR links and remaining work to \`${sentinelPath}\` and stop.`
  );
}

function checkoutOwnershipLines(ownership) {
  if (!ownership) return [];
  const sessions = Array.isArray(ownership.sessions) ? ownership.sessions : [];
  const commits = Array.isArray(ownership.portosCommits) ? ownership.portosCommits : [];
  return [
    '### Checkout ownership observed by PortOS',
    sessions.length
      ? `- Live interactive agent sessions with this checkout as their working directory: ${sessions.map(s => `pid ${s.pid} (status ${s.status})`).join('; ')}. Treat each as the operator's own session, not an unknown writer: do not change its work. If it blocks recovery, report blocked and name it as an interactive operator session with its status; PortOS holds recovery until it exits or the checkout settles.`
      : '- No live interactive agent session has this checkout as its working directory.',
    `- Commits whose reflog entry carries a \`portos-commit-\` action were made by PortOS itself, not by another writer${commits.length ? `: ${commits.join(', ')}` : ''}.`,
    '',
  ];
}

export function buildCheckoutRecoveryCompletionSection({ sentinelPath, ownership = null } = {}) {
  return [
    '## App Checkout Recovery Handoff',
    CHECKOUT_RECOVERY_GUIDANCE,
    '',
    ...checkoutOwnershipLines(ownership),
    'After recovery reaches its verified final outcome or a precise blocker, write the completion sentinel and stop:',
    '',
    ...buildSentinelWriteSteps(1, sentinelPath, '   ## Recovery outcome\n   <verified checkout and preservation PR outcomes, or INCOMPLETE with the first unverified checkpoint>'),
  ].join('\n');
}

export function buildReconcileFlowCompletionSection({ sentinelPath } = {}) {
  return [
    '## Branch Reconciliation Handoff',
    RECONCILE_FLOW_GUIDANCE,
    '',
    'After the scoped reconciliation reaches its final outcome, write the completion sentinel and stop:',
    '',
    ...buildSentinelWriteSteps(1, sentinelPath, '   ## Reconciliation outcome\n   <verified branch outcomes and PR URLs, or INCOMPLETE with the first unverified checkpoint>'),
  ].join('\n');
}

/** The release procedure is the deliverable; the sentinel only records its verified outcome. */
export function buildReleaseFlowCompletionSection({ isTui = false, isCli = false, sentinelPath = null } = {}) {
  const lines = ['## Release Workflow Handoff', RELEASE_FLOW_GUIDANCE];
  if (isTui && sentinelPath) {
    lines.push('', 'After the workflow reaches its documented final outcome, write that outcome to the completion sentinel and stop:', '',
      ...buildSentinelWriteSteps(1, sentinelPath, '   ## Release outcome\n   <verified release URL, no-release-needed result, or INCOMPLETE with its first unverified checkpoint>'));
  } else if (isCli && sentinelPath) {
    lines.push('', 'After the workflow reaches its final outcome, write a structured completion envelope to this run\'s sentinel and exit. Use `no-action-needed` only when the release check verified no release is needed; use `incomplete` or `blocked` for unfinished work.',
      SENTINEL_WRITE_PERMISSION_NOTE, '', '```bash', `cat > "${sentinelPath}" <<'EOF'`,
      '{"summary":"<release outcome and evidence>","taskOutcome":{"status":"<completed|no-action-needed|blocked|incomplete>","reason":"<specific evidence or blocker>"}}',
      'EOF', '```');
  }
  return lines.join('\n');
}

/** Better owns publication; write the sentinel only after recording its final outcome. */
export function buildAuditFlowCompletionSection({ isTui = false, sentinelPath = null } = {}) {
  const lines = ['## Better Workflow Handoff', AUDIT_FLOW_GUIDANCE];
  if (isTui && sentinelPath) {
    lines.push('', 'After verification and delivery, write the outcome to the completion sentinel and stop:', '',
      ...buildSentinelWriteSteps(1, sentinelPath, '   ## Audit outcome\n   <merged PR URLs, clean audit result, or INCOMPLETE with the retained branch and first unverified checkpoint>'));
  }
  return lines.join('\n');
}

/** Audit reports are a deliverable even when the run only files issues. */
export function buildAuditOutputCompletionSection(task, sentinelPath) {
  const category = resolveTaskHookType(task);
  if (!isAuditTaskType(category)) return '';
  return `## Required audit assessment handoff
Before writing the completion sentinel, prepare the validated QUALITY_AUDIT_JSON report described in the audit instructions for category "${category}".
Write your human summary AND exactly one single-line QUALITY_AUDIT_JSON: {...} report together inside the \`summary\` string of the JSON completion envelope at \`${sentinelPath}\`, then stop. The report's inner JSON "summary" field must contain plain assessment prose only, with no QUALITY_AUDIT_JSON: or AUDIT_SLICE: lines. This applies to every provider, including agents that normally finish by exiting.
The report is required even when no issues are filed or no code changes are needed. A successful issue or PR does not supply a quality assessment. A final response alone is not enough: PortOS reads the sentinel file to save the dashboard score.
Preserve the report when following the summary template above; the template's length guidance does not replace this required output. If assessment is unavailable, use sliceScore:null and explain the missing evidence rather than inventing a score.`;
}

/**
 * Worktree commit-guidance helper for the light prompt. Picks the right
 * single-sentence instruction based on whether the agent will run its own
 * push workflow (TUI or Claude Code CLI with slashdo), reuse an existing PR
 * branch (review fixes), or hand off to PortOS's post-exit push.
 *
 * `mode` is the resolver's decision (see `lib/agent/agentCompletionMode.js`); by the
 * time the TUI and existing-branch arms above have already returned, `mode`
 * being `WORKTREE_NO_PUSH` / `PORTOS_MERGES` implies a non-TUI host, so
 * `canTypeSlashCommands` alone (no separate `isTui` re-check) tells the two
 * apart from their non-slashdo equivalents.
 */
export function worktreeCommitGuidance({ isTui, mode = null, canTypeSlashCommands = false, rendersInlinePrLifecycle = false, isWorktreeOnExistingBranch, willOpenPR, discardWorktree, claimFlow = false, noChangeSuccess = false, headIsDefaultBranch = false }) {
  if (mode === COMPLETION_MODES.AUDIT_FLOW) return AUDIT_FLOW_GUIDANCE;
  if (mode === COMPLETION_MODES.RECONCILE_FLOW) return RECONCILE_FLOW_GUIDANCE;
  if (mode === COMPLETION_MODES.CHECKOUT_RECOVERY) return CHECKOUT_RECOVERY_GUIDANCE;
  if (mode === COMPLETION_MODES.RELEASE_FLOW) return RELEASE_FLOW_GUIDANCE;
  if (discardWorktree) return DISCARD_WORKTREE_NOTE;
  if (claimFlow) return 'The claim workflow in the Completion section owns the push, PR/MR, review, merge or human-handoff, and cleanup steps.';
  if (headIsDefaultBranch) return DEFAULT_BRANCH_HEAD_GUIDANCE;
  if (isTui) return withNoChangeAuditGuidance('Commit your changes to this branch — see **Completion Workflow** below.', noChangeSuccess);
  if (isWorktreeOnExistingBranch) {
    return withNoChangeAuditGuidance('Commit and **push** any review-fix commits to this branch (the PR points at it). Use `git pull --rebase` before pushing if needed.', noChangeSuccess);
  }
  if (canTypeSlashCommands && mode === COMPLETION_MODES.WORKTREE_NO_PUSH) {
    return withNoChangeAuditGuidance('Commit your changes here — the **Completion** section below drives the push and PR.', noChangeSuccess);
  }
  if (canTypeSlashCommands && mode === COMPLETION_MODES.PORTOS_MERGES) {
    // Reached in a worktree with no PR: the auto-merge posture
    // (portosMergesBranchOnExit) — nothing drives a push, so say so.
    return withNoChangeAuditGuidance('Commit your changes here — do NOT push. PortOS merges this branch back after you exit; the **Completion** section below has the exact step.', noChangeSuccess);
  }
  if (rendersInlinePrLifecycle && willOpenPR) {
    return withNoChangeAuditGuidance('Commit your changes here — the **Completion** section below drives the push, the PR, the review loop, and the merge.', noChangeSuccess);
  }
  if (willOpenPR) {
    return withNoChangeAuditGuidance('Commit your changes here. The system will push and open a PR after you exit — do NOT push or open a PR yourself.', noChangeSuccess);
  }
  return withNoChangeAuditGuidance('Commit your changes here. Your branch will be merged back automatically when the task completes.', noChangeSuccess);
}

/**
 * The `.agent-done` sentinel-write instruction block shared by
 * buildTuiCompletionSection and buildManualTuiCompletionSection: the "write a
 * short summary, then stop" instruction plus the fenced heredoc template.
 * Returns the lines to splice into the caller's completion workflow.
 */
export function buildSentinelWriteSteps(stepNumber, sentinelPath, sentinelTail) {
  return [
    `${stepNumber}. Write the structured completion JSON envelope to the completion sentinel, then stop — this sentinel is the done signal. PortOS watches it and finalizes the run shortly after it appears. Do NOT run \`/quit\` (it's a UI command, not something you can invoke) and do NOT wait for anything after writing the sentinel.`,
    '',
    `   ${TASK_OUTCOME_GUIDANCE}`,
    `   Include in the summary: ${sentinelTail.trim()}`,
    `   ${SENTINEL_WRITE_PERMISSION_NOTE}`,
    '',
    '   ```bash',
    `   cat > "${sentinelPath}" <<'EOF'`,
    '   {"summary":"## Summary\\n<what was accomplished or remains unfinished>\\n## Changes\\n<changes and verification>","taskOutcome":{"status":"<completed|no-action-needed|blocked|incomplete>","reason":"<evidence or blocker>"}}',
    '   EOF',
    '   ```'
  ];
}
