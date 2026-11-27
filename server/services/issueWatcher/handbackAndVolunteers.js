/** Assign screened volunteer claims and hand reviewed pull requests back to a contributor or remediation task. */
import { IN_PROGRESS_LABEL, dispatchLabelSpec, volunteerClaimLabels } from '../../lib/dispatchLabels.js';
import { MAX_PR_REMEDIATION_ATTEMPTS, PR_HANDBACK, resolveHandbackDisposition, resolvePullRequestWriteAccess } from '../../lib/prHandbackPolicy.js';
import { forkHeadFromGithubPr } from '../../lib/forkHead.js';
import { trimTo } from '../../lib/textUtils.js';
import { sameLogin, runGh, readCurrentIssueComment } from './forgeClient.js';
import { readState } from './state.js';
import { issueCommentKey, issueAbuseInput, abuseFingerprint } from './issueComments.js';

const IN_PROGRESS_LABEL_SPEC = dispatchLabelSpec(IN_PROGRESS_LABEL);

// One entry per PR, so this only grows with the count of external PRs that were
// reviewed and did not merge. Bounded anyway: the ledger lives in app state,
// which is read on every gather pass.
const MAX_HANDBACK_LEDGER_ENTRIES = 200;

/** True only for an affirmative, explicit request to take ownership. */
export function isIssueClaimRequest(body) {
  const value = trimTo(body, 4_000).replace(/```[\s\S]*?```/g, '').split('\n').filter((line) => !line.trimStart().startsWith('>')).join('\n');
  if (!value || /\b(?:cannot|can't|can not|won't|will not|not able to)\b/i.test(value)) return false;
  return [
    /\b(?:i\s+can|i'll|i\s+will)\s+(?:take|handle|work\s+on)\s+(?:this|it|the\s+issue)\b/i,
    /\bi(?:'d|\s+would)\s+(?:like|love|be\s+happy)\s+to\s+(?:take|handle|work\s+on)\s+(?:this|it|the\s+issue)\b/i,
    /\bassign\s+(?:this|it|the\s+issue)\s+to\s+me\b/i,
    /\bcan\s+you\s+assign\s+(?:this|it|the\s+issue)\s+to\s+me\b/i,
  ].some((pattern) => pattern.test(value));
}

/**
 * Take an unassigned issue on a volunteer's behalf, writing the shared
 * volunteer-claim forge state: set the assignee, stamp `in-progress`, and
 * retire the contributor invitations.
 *
 * The policy itself lives in `volunteerClaimLabels()` (lib/dispatchLabels.js)
 * because the claim agent's Phase 1 handoff resolves the SAME event — a human
 * comment asking for an unassigned issue — and must leave the same state, so
 * which path ran first cannot change the outcome.
 *
 * The assignee is what actually removes the issue from the autonomous claim
 * queue — `perpetualWork.js#isActionableIssue` already rejects any issue held
 * by someone other than this install's login. The label is for the humans and
 * the UI: it is what the Issues tab hides on, and it keeps a volunteer-claimed
 * issue reading the same as an agent-claimed one.
 *
 * ONE combined edit is the fast path for assign + add-label. `gh issue edit
 * --add-label` fails the WHOLE call when the repo has never defined the label,
 * so the fallback splits it — assign alone (the half that must not be lost on a
 * fork), create the label, then apply it. `--add-assignee` is idempotent, so the
 * retry is safe whether or not the combined attempt got as far as assigning. The
 * label is created without `--force` so an install that recolored it keeps its
 * color.
 *
 * The invitation release is ALWAYS a separate edit per label, never folded into
 * the combined call: `--remove-label` fails the whole call when a named label is
 * absent from the issue, which is the common case (most issues carry neither),
 * and that failure would take the assignment down with it.
 *
 * Returns whether the ASSIGNMENT landed, never whether the labels did: missing
 * labels leave stale advertising a later pass can repair, while a missing
 * assignment means the volunteer's comment still needs an answer and must go on
 * to the reasoning agent.
 */
async function assignVolunteer(ctx, issueNumber, login) {
  const edit = (...flags) => runGh(['issue', 'edit', String(issueNumber), '--repo', ctx.repoSpec, ...flags], ctx);
  const { add, remove } = volunteerClaimLabels();
  const assignFlags = ['--add-assignee', login];
  const labelFlags = add.flatMap((label) => ['--add-label', label]);
  // Serialized, not Promise.all: two concurrent edits of the same issue is a
  // race with no upside. An issue carrying neither invitation is the common
  // case, and gh reports that absence as an error — never log it as a failure.
  const releaseInvitations = async () => {
    for (const label of remove) await edit('--remove-label', label).catch(() => null);
  };

  if (await edit(...assignFlags, ...labelFlags).then(() => true, () => false)) {
    await releaseInvitations();
    return true;
  }

  const assigned = await edit(...assignFlags)
    .then(() => true)
    .catch((err) => {
      console.error(`❌ issue-watcher: could not assign issue #${issueNumber} to ${login}: ${err.message}`);
      return false;
    });
  if (!assigned) return false;
  await runGh(['label', 'create', IN_PROGRESS_LABEL_SPEC.name, '--repo', ctx.repoSpec,
    '--color', IN_PROGRESS_LABEL_SPEC.color, '--description', IN_PROGRESS_LABEL_SPEC.description], ctx)
    .catch(() => null);
  await edit(...labelFlags).catch((err) => {
    console.error(`❌ issue-watcher: could not mark issue #${issueNumber} ${IN_PROGRESS_LABEL}: ${err.message}`);
  });
  await releaseInvitations();
  return true;
}

export async function assignSafeVolunteers(ctx, comments) {
  const assignedIssues = new Set();
  const assignedCommentKeys = new Set();
  let assignments = 0;
  for (const item of comments) {
    if (!item.claimAssignable || assignedIssues.has(item.issueNumber)) continue;
    const current = await readCurrentIssueComment(ctx, item);
    if (!current || current.issueAssignees.length > 0
      || abuseFingerprint(current, issueAbuseInput(current)) !== abuseFingerprint(item, issueAbuseInput(item))) continue;
    const succeeded = await assignVolunteer(ctx, item.issueNumber, item.commentAuthor);
    if (succeeded) {
      assignedIssues.add(item.issueNumber);
      assignedCommentKeys.add(issueCommentKey(item));
      assignments += 1;
    }
  }
  return { assignments, assignedCommentKeys };
}

/**
 * Put a reviewed PR back in its opener's queue. Idempotent against the forge
 * read that produced `pr`, so a scheduled sweep that re-observes the same
 * still-unmerged PR doesn't re-issue the edit every tick.
 *
 * A failure here is logged, not propagated: the REQUEST_CHANGES review is
 * already posted and is the contributor's real signal. GitHub also refuses to
 * assign a login with no read access on the repo, which is an ordinary outcome
 * for an outside contributor rather than a coordinator error.
 */
async function assignPullRequestOpener(ctx, pr, authorLogin) {
  const login = (authorLogin || pr?.author?.login || '').trim();
  if (!login || !Number.isInteger(pr?.number)) return false;
  const assigned = (Array.isArray(pr.assignees) ? pr.assignees : [])
    .some((assignee) => sameLogin(assignee?.login, login));
  if (assigned) return true;
  return runGh(['pr', 'edit', String(pr.number), '--repo', ctx.repoSpec, '--add-assignee', login], ctx)
    .then(() => {
      console.log(`📌 issue-watcher: handed PR #${pr.number} back to @${login}`);
      return true;
    })
    .catch((err) => {
      console.error(`❌ issue-watcher: could not assign PR #${pr.number} to ${login}: ${err.message}`);
      return false;
    });
}

const handbackLedger = (state) => (Array.isArray(state?.prHandbacks) ? state.prHandbacks : [])
  .filter((entry) => Number.isInteger(entry?.number));

/**
 * Per-pass hand-back accumulator. The ledger is read once at the top of a pass
 * and written once at the end, folded into the `persistState` call the pass
 * already makes — a per-PR write would re-serialize the whole apps file for
 * each PR. `ledger` is the pass's working view, mutated in place like the
 * `approvals`/`remaining` arrays beside it so a dedup check later in the
 * same loop sees an entry made earlier in it. `written` records only the
 * entries THIS pass produced, keyed by PR number.
 *
 * The split matters: `processTaskOutput` and `processPendingApprovals` both
 * own entries in this field and can be in flight together for one app (the
 * perpetual refill in cos.js fires `buildTaskInput` on `agent:completed`,
 * before the completing task's own output hook has settled). Writing
 * `ledger` wholesale would replace the other pass's entries with a snapshot
 * taken before they existed — and a LOST entry here is not a benign
 * re-observation: it drops the same-revision dedup and the attempt budget, so
 * the next sweep spawns a second remediation agent for a PR one is already
 * working. Only `written` is applied, merged by number onto whatever the
 * write actually lands on.
 */
export function createHandbackTracker(app) {
  return { ledger: handbackLedger(readState(app)), written: new Map() };
}

/**
 * The ledger patch for a pass's own end-of-pass state write, as a function of
 * fresh state so this pass's entries merge onto a peer's instead of replacing
 * them. Returns `{}` when the pass handed nothing back.
 */
export function handbackStatePatch(tracker) {
  if (!tracker || tracker.written.size === 0) return {};
  return (state) => {
    const merged = handbackLedger(state).filter((entry) => !tracker.written.has(entry.number));
    return { prHandbacks: [...merged, ...tracker.written.values()].slice(-MAX_HANDBACK_LEDGER_ENTRIES) };
  };
}

/**
 * Decide and apply who owns a PR the coordinator reviewed but did not merge.
 *
 * The decision itself is `prHandbackPolicy.js`; everything here is the state it
 * needs. The per-PR ledger does two jobs the pure policy cannot: it stops a
 * repeated sweep from re-dispatching an agent for a revision already handled,
 * and it caps how many remediation agents one PR may consume before the work
 * goes back to its opener regardless of write access.
 */
export async function applyPullRequestHandback({
  app, ctx, pr, tracker, authorLogin, reason,
  reviewOutcome = null, notMergeReady = false, downgraded = false,
} = {}) {
  if (!app?.id || !ctx || !tracker || !Number.isInteger(pr?.number)) return PR_HANDBACK.NONE;
  const headSha = pr.headRefOid || null;
  const previous = tracker.ledger.find((entry) => entry.number === pr.number) || null;
  // Same revision, already dispatched: the outstanding agent (or the assignment
  // already made) owns it. Re-firing would queue a duplicate the moment the
  // first one completed without landing the PR.
  if (previous && headSha && previous.headSha === headSha) return PR_HANDBACK.NONE;

  const attempts = previous?.attempts || 0;
  const { canEdit, reason: writeAccess } = resolvePullRequestWriteAccess(pr);
  const disposition = resolveHandbackDisposition({
    reviewOutcome,
    notMergeReady,
    downgraded,
    canEdit,
    remediationExhausted: attempts >= MAX_PR_REMEDIATION_ATTEMPTS,
  });
  if (disposition === PR_HANDBACK.NONE) return PR_HANDBACK.NONE;

  const login = (authorLogin || pr.author?.login || '').trim();
  let applied = disposition;
  let taskId = null;
  // Only a NEW agent costs an attempt. Re-observing a PR whose agent is still
  // queued must not burn the budget that decides when the work goes back to
  // its opener.
  let spawned = false;
  if (disposition === PR_HANDBACK.REMEDIATE) {
    // Lazy: the spawner reaches the CoS task store, whose module graph is far
    // heavier than a gather pass that never hands anything back — and the
    // common disposition returns above without ever needing it.
    const { PR_REMEDIATION_SPAWN, spawnPrRemediationFollowUp } = await import('../prRemediationFollowUp.js');
    const { status, task } = await spawnPrRemediationFollowUp({
      app,
      repoFullName: ctx.repoFullName,
      pullRequest: {
        number: pr.number,
        url: pr.url,
        headSha,
        headRefName: pr.headRefName,
        authorLogin: login,
        // Where that head branch lives when the PR came from a fork — the
        // remediation worktree has no `origin/<branch>` to attach to otherwise.
        forkHead: forkHeadFromGithubPr(pr),
      },
      writeAccess,
      reason,
    });
    // `already-queued` still means an agent owns this PR, so it stays a
    // REMEDIATE: assigning the opener on top of a running agent would put the
    // PR in two queues and set a human to work against it. Only a genuine
    // queue failure leaves nobody holding the PR and falls back.
    if (status === PR_REMEDIATION_SPAWN.FAILED) applied = PR_HANDBACK.ASSIGN_OPENER;
    else {
      taskId = task?.id || null;
      spawned = status === PR_REMEDIATION_SPAWN.QUEUED;
    }
  }
  if (applied === PR_HANDBACK.ASSIGN_OPENER) await assignPullRequestOpener(ctx, pr, login);

  const entry = {
    number: pr.number,
    headSha,
    taskId: applied === PR_HANDBACK.REMEDIATE ? taskId : null,
    attempts: spawned ? attempts + 1 : attempts,
    // Observability only — nothing reads these back as inputs to the dedup or
    // attempt-budget checks above.
    disposition: applied,
    reason: reason || null,
    at: new Date().toISOString(),
  };
  tracker.ledger = [...tracker.ledger.filter((item) => item.number !== pr.number), entry]
    .slice(-MAX_HANDBACK_LEDGER_ENTRIES);
  tracker.written.set(pr.number, entry);
  return applied;
}
