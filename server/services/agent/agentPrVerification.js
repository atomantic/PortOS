
import { PR_COMPLETIONS, PR_MISSING_CATEGORY, } from '../../lib/prDisposition.js';
import { execGit } from '../../lib/execGit.js';
import { resolveTaskHookType, } from '../taskTypeHooks.js';
import { issueNumberFromRef } from '../issueReconcile.js';
import { getMergeRequestState, findMergeRequestForBranch } from '../gitlab.js';
import { getPullRequestState, findPullRequestForBranch } from '../github.js';

/**
 * Error categories for the two ways a PR-shaped run can finish without a PR
 * (#3358). Distinct from each other AND from a generic failure, because the
 * remedies are opposite: `pr-missing` is the agent's miss, `forge-unreachable`
 * is the machine's — the run may have been perfect and simply had no way to
 * reach the forge. `forge-unreachable` is registered in
 * `taskLearning/store.js#ENVIRONMENTAL_ERROR_CATEGORIES` so a firewalled `gh`
 * can't drag a task type's measured success rate down (or auto-park it).
 */
export { PR_MISSING_CATEGORY };
export const FORGE_UNREACHABLE_CATEGORY = 'forge-unreachable';
export const ISSUE_TRAILER_MISSING_CATEGORY = 'issue-trailer-missing';

function hasIssueClosingTrailer(body, issueNumber) {
  return new RegExp(`\\b(clos(e|es|ed)|fix(e[sd])?|resolv(e|es|ed))\\s+#${issueNumber}\\b`, 'i').test(body);
}

function hasIssuePartialTrailer(body, issueNumber) {
  return new RegExp(`\\b(refs?|part of)\\s+#${issueNumber}\\b`, 'i').test(body);
}

/**
 * Does the agent's own completion summary declare that this task's work
 * already landed through a DIFFERENT change request — the stand-down a retry
 * reaches when a parallel claim merged the same issue first?
 *
 * The resume briefing (`buildResumeSection`) tells a retry exactly this: "If a
 * PR is already **merged**, the work is done — go straight to your completion
 * step and report that." Without a finalize outcome that HONORS the report, a
 * correct stand-down fails as `pr-missing` (non-actionable), the task retries,
 * the next agent reads the same guidance, reaches the same conclusion, and
 * fails again — a loop no retry can break (task-mupxru13, three identical
 * failures).
 *
 * Mirrors `mergeGateContract.js`'s `summaryStatesLeaveOpen`: the agent's own
 * words are read as a DECISION, but never trusted alone — the caller must
 * verify the named change request is actually merged before this excuses a
 * missing PR. Two signals, not one:
 *   - "already merged/landed/completed" language tied to the work, AND
 *   - a change-request reference (PR/MR #N or a forge URL) the caller can ask
 *     the forge about.
 *
 * @param {string|null|undefined} summary - the run's completion summary text
 * @returns {boolean}
 */
const LANDED_ELSEWHERE_DECLARATION = /\b(?:already|previously)\s+(?:been\s+)?(?:merged|landed|completed|shipped|fixed|implemented)\b/i;
const CHANGE_REQUEST_REFERENCE = /\b(?:pr|pull request|mr|merge request)\s*#(\d+)\b|\b(?:pr|mr)\/(\d+)\b|(?:\/(?:pull|merge_requests)\/(\d+))/i;

function summaryDeclaresWorkLanded(summary) {
  if (typeof summary !== 'string' || !summary.trim()) return false;
  return LANDED_ELSEWHERE_DECLARATION.test(summary) && CHANGE_REQUEST_REFERENCE.test(summary);
}

/**
 * The change-request identifiers a landed-elsewhere summary names, in the
 * order the patterns found them — `#N` first, then a URL path. Returns [] when
 * the summary names none, which is the caller's signal that nothing can be
 * verified (and the miss must stand).
 *
 * @param {string|null|undefined} summary
 * @returns {string[]} forge-native references (bare numbers) to probe
 */
function landedChangeRequestRefs(summary) {
  if (typeof summary !== 'string' || !summary.trim()) return [];
  const refs = [];
  const push = (n) => {
    const id = Number(n);
    if (Number.isSafeInteger(id) && id > 0 && !refs.includes(String(id))) refs.push(String(id));
  };
  for (const m of summary.matchAll(new RegExp(CHANGE_REQUEST_REFERENCE.source, 'gi'))) {
    push(m[1] ?? m[2] ?? m[3]);
  }
  return refs;
}

/**
 * The branch a finished agent's workspace is sitting on, or null when the
 * workspace is gone / not a repo / detached. Read at finalize time, while the
 * worktree still exists (cleanup runs after finalizeAgent in every spawn path).
 */
export async function resolveWorkspaceBranch(workspacePath) {
  if (!workspacePath) return null;
  const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspacePath, { ignoreExitCode: true })
    .catch(() => null);
  const branch = (result?.stdout || '').trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

/**
 * How many commits the finished branch holds that its base does not — or `null`
 * when we could not work it out.
 *
 * The `null` sentinel matters: it is the difference between "we looked and the
 * agent committed nothing" and "we could not look". Only a confirmed `0` is
 * allowed to excuse a missing PR (see `verifyPrClaim`); an unreadable count
 * leaves the miss standing rather than inventing an excuse for it.
 *
 * Compares against `origin/<default>` in preference to the local branch. A
 * worktree's local `main` is routinely STALE — it is whatever the primary
 * checkout last pulled, which can sit well behind the commit the worktree was
 * actually branched from. Counting against it reports the merge commits the
 * agent inherited as commits the agent authored, which is precisely backwards
 * for a check that exists to recognize "this agent wrote nothing".
 */
async function countCommitsAhead(workspacePath) {
  const { getDefaultBranch } = await import('../git/status.js');
  // `allowRemote: false` — finalize must not block on a network round-trip to
  // answer a bookkeeping question; the local fallbacks resolve main/master fine.
  const defaultBranch = await getDefaultBranch(workspacePath, { allowRemote: false }).catch(() => null);
  if (!defaultBranch) return null;

  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  const hasRemote = await execGit(['rev-parse', '--verify', '--quiet', remoteRef], workspacePath, { ignoreExitCode: true })
    .then(r => !!(r?.stdout || '').trim())
    .catch(() => false);

  const base = hasRemote ? `origin/${defaultBranch}` : defaultBranch;
  const result = await execGit(['rev-list', '--count', `${base}..HEAD`], workspacePath, { ignoreExitCode: true })
    .catch(() => null);
  const count = Number.parseInt((result?.stdout || '').trim(), 10);
  return Number.isInteger(count) ? count : null;
}

/**
 * The named outcomes a PR-claim check can reach (#7522).
 *
 * The public `verifyPrClaim` result is deliberately sparse — `ok`, an optional
 * `branch`, an optional `category`. That shape is compact to return and
 * expensive to READ: `ok: true` means "do not downgrade the run", not
 * "verified"; a string `branch` doubles as evidence provenance; and
 * `inconclusive` is set by some non-answers but not others. Every caller that
 * wanted a different question answered — may this appear on the ledger? may
 * cleanup skip creating a PR? — had to re-derive it from that field soup, and
 * each correction (#4540, #5074) had to be applied in several places at once.
 *
 * So the check produces ONE of these named outcomes and the projections below
 * decide what each one authorizes. `check-threw` is produced at the catch
 * boundary in `finalizeAgent`, not here — a check that never ran is an outcome
 * too, and naming it keeps "the forge said nothing" from looking like "the forge
 * said yes".
 */
export const PR_OBSERVATION = Object.freeze({
  /** Nothing to verify: the agent did not own PR creation, the run already failed, or there is no workspace. */
  SKIPPED: 'skipped',
  /** The check threw. Not a verdict — the reported outcome stands. */
  CHECK_THREW: 'check-threw',
  /** Detached HEAD / non-repo workspace: no branch to ask a forge about. */
  BRANCH_UNAVAILABLE: 'branch-unavailable',
  /** The forge holds a change request for the branch, with an acceptable trailer. */
  VERIFIED_CLAIM: 'verified-claim',
  /** The forge holds no change request AND the branch is PROVEN to hold no commits. */
  EMPTY_BRANCH: 'empty-branch',
  /** The forge holds no change request for a branch that does (or may) hold commits. */
  MISSING_PR: 'missing-pr',
  /**
   * The forge holds no change request for this branch, but the run's own
   * completion summary declares the work already landed via a change request
   * PortOS VERIFIED is merged — a parallel claim shipped the same issue first
   * and this run correctly stood down rather than opening a duplicate.
   */
  WORK_LANDED_ELSEWHERE: 'work-landed-elsewhere',
  /** The change request exists but does not close the issue its branch names. */
  INVALID_TRAILER: 'invalid-trailer',
  INVALID_DISPOSITION: 'invalid-disposition',
  /** We could not ask, or could not read the answer. Says nothing about the PR. */
  FORGE_UNAVAILABLE: 'forge-unavailable',
});

/**
 * What each outcome AUTHORIZES — the three policies that used to be re-derived
 * from field shapes at every consumer.
 *
 * - `completionOk` — may the run stand as the agent reported it? A thrown check
 *   and every non-verification say yes; an UNREACHABLE forge says no, because a
 *   run that may have shipped nothing must not be filed as complete on the
 *   strength of a probe that never landed. It retries as environmental.
 * - `observed` — did anything actually look? `skipped`/`check-threw` did not, so
 *   their public verdict carries no `branch` key at all, which is what
 *   `prClaimWasVerified` keys on.
 * - `namesBranch` — does this outcome name the branch it looked at? The auxiliary
 *   no-change proof may only substitute where this is false: an outcome that
 *   named its branch already carries the strongest evidence available about that
 *   branch — including a forge failure ABOUT it, which a second, weaker probe
 *   must not paper over.
 * - `recordable` — may a `run.pr-verified` ledger entry be appended? A forge that
 *   could not be reached is excluded for the same reason a throw is: recording
 *   `verified: false` would put "this run shipped no PR" on the permanent record
 *   for a run that may well have shipped one (#4540).
 */
export const PR_OBSERVATION_POLICY = Object.freeze({
  [PR_OBSERVATION.SKIPPED]: Object.freeze({ completionOk: true, observed: false, namesBranch: false, recordable: false, category: null }),
  [PR_OBSERVATION.CHECK_THREW]: Object.freeze({ completionOk: true, observed: false, namesBranch: false, recordable: false, category: null }),
  [PR_OBSERVATION.BRANCH_UNAVAILABLE]: Object.freeze({ completionOk: true, observed: true, namesBranch: false, recordable: false, category: null }),
  [PR_OBSERVATION.VERIFIED_CLAIM]: Object.freeze({ completionOk: true, observed: true, namesBranch: true, recordable: true, category: null }),
  [PR_OBSERVATION.EMPTY_BRANCH]: Object.freeze({ completionOk: true, observed: true, namesBranch: true, recordable: true, category: null }),
  [PR_OBSERVATION.MISSING_PR]: Object.freeze({ completionOk: false, observed: true, namesBranch: true, recordable: true, category: PR_MISSING_CATEGORY }),
  // `work-landed-elsewhere` is a VERIFIED terminal state, not an excuse: the
  // agent's summary named a merged change request and the forge confirmed it,
  // so the run stands as reported. `recordable` so the ledger carries the
  // stand-down (verified: true) rather than silently omitting the transition.
  [PR_OBSERVATION.WORK_LANDED_ELSEWHERE]: Object.freeze({ completionOk: true, observed: true, namesBranch: true, recordable: true, category: null }),
  [PR_OBSERVATION.INVALID_DISPOSITION]: Object.freeze({ completionOk: false, observed: true, namesBranch: true, recordable: true, category: 'pr-disposition' }),
  [PR_OBSERVATION.INVALID_TRAILER]: Object.freeze({ completionOk: false, observed: true, namesBranch: true, recordable: true, category: ISSUE_TRAILER_MISSING_CATEGORY }),
  [PR_OBSERVATION.FORGE_UNAVAILABLE]: Object.freeze({ completionOk: false, observed: true, namesBranch: true, recordable: false, category: FORGE_UNREACHABLE_CATEGORY }),
});

/**
 * One observation record. `inconclusive` is a FACT the producer knows (it could
 * not reach an unambiguous answer), not a policy — `missing-pr` carries it only
 * when the commit count was unreadable, which is exactly the case where the miss
 * stands but the learning verdict must stay undeclared.
 */
export const prObservation = (outcome, fields = {}) => ({
  outcome,
  branch: null,
  message: null,
  advisory: null,
  commitsAhead: null,
  inconclusive: false,
  ...fields,
});

/**
 * Verify that a change request the agent's summary named is actually MERGED.
 *
 * The declaration alone is not evidence — an agent that shipped nothing can
 * write "already merged in PR #7" just as easily as one that checked. So the
 * stand-down is honored only when the forge CONFIRMS a named change request is
 * merged. Fail-safe polarity throughout: an unreachable forge or an unreadable
 * state is `null` (could not verify), never "verified", and the caller leaves
 * the miss standing rather than taking the agent's word for it.
 *
 * Probes every reference the summary names and accepts the FIRST merged one —
 * a stand-down summary typically names the parallel claim's PR plus the issue's
 * other landed work, and any one merged change request establishes that this
 * run's task outcome exists on the default branch.
 *
 * @param {string[]} refs - forge-native change-request numbers, from `landedChangeRequestRefs`
 * @param {{ cli: 'gh'|'glab', env: object|null }} forge - the resolved forge for this repo
 * @param {string} workspacePath
 * @returns {Promise<{ ref: string, state: string }|null>} null when no named change request could be verified merged
 */
async function verifyLandedChangeRequest(refs, forge, workspacePath) {
  for (const ref of refs) {
    if (forge.cli === 'glab') {
      const view = await getMergeRequestState(ref, workspacePath).catch(() => ({ status: 'unavailable', state: null }));
      if (view.status === 'known' && view.state === 'MERGED') return { ref, state: view.state };
    } else {
      const view = await getPullRequestState(ref, { cwd: workspacePath, env: forge.env || null })
        .catch(() => ({ status: 'unavailable', state: null }));
      if (view.status === 'known' && view.state === 'MERGED') return { ref, state: view.state };
    }
  }
  return null;
}

/**
 * Project an observation onto the historical `verifyPrClaim` result shape.
 *
 * Kept sparse on purpose: `category` stays ABSENT on a passing verdict and
 * `commitsAhead`/`inconclusive` appear only where a consumer reads them, so
 * every existing caller, persisted payload and test sees exactly what it saw
 * before this indirection existed.
 */
async function hasUncommittedLockfileDeliverable(task, workspacePath) {
  if (resolveTaskHookType(task) !== 'dependency-updates') return false;
  const { readWorktreeStatus, classifyWorktreeDirt } = await import('../worktreeManager.js');
  const status = await readWorktreeStatus(workspacePath).catch(() => null);
  if (status === null) return false;
  // A managed app does not ignore PortOS's per-run `.agent-done-<agentId>` sentinel
  // (only PortOS's own .gitignore does), so it reads as untracked dirt here and
  // turned every clean no-op dependency-updates run into `pr-missing`.
  const withoutSentinel = status.split("\n").filter(line => !/^\?\? "?\.agent-done(?:-[^/]*)?"?$/.test(line)).join("\n");
  return classifyWorktreeDirt(withoutSentinel, { preserveLockfiles: true }).hasRealChanges;
}

export function prVerdictFromObservation(observation) {
  const policy = PR_OBSERVATION_POLICY[observation.outcome];
  const verdict = { ok: policy.completionOk };
  // Nothing looked, so there is nothing to report — not even a null branch,
  // which would read as "we asked and could not name one".
  if (!policy.observed) return verdict;
  verdict.branch = observation.branch;
  if (policy.category) verdict.category = policy.category;
  if (observation.message) verdict.message = observation.message;
  if (observation.advisory) verdict.advisory = observation.advisory;
  if (observation.outcome === PR_OBSERVATION.EMPTY_BRANCH) verdict.branchProvenEmpty = true;
  if (observation.outcome === PR_OBSERVATION.MISSING_PR) {
    // Both facts ride the miss unconditionally: `commitsAhead` feeds the
    // suggested fix, and an explicit `inconclusive: false` is what tells the
    // learning verdict this miss was measured rather than guessed at.
    verdict.commitsAhead = observation.commitsAhead;
    verdict.inconclusive = observation.inconclusive;
  } else if (observation.inconclusive) {
    verdict.inconclusive = true;
  }
  return verdict;
}

/**
 * Ask the forge whether a run that PROMISED a pull request actually produced
 * one (#3358), and name the outcome.
 *
 * The failure this closes: an agent that owns its own `/do:pr` step commits,
 * pushes over SSH (unaffected by an outbound block on `gh`), fails to create the
 * PR, writes its `.agent-done` sentinel anyway, and PortOS records "Completed
 * successfully" against a branch no one will ever review. Nothing else in the
 * completion path asks the forge whether the PR exists — `agentWorktreeCleanup`
 * only composes advisory prose SUGGESTING `gh pr list --head <branch>`.
 *
 * Only runs when `prExpected` — i.e. the AGENT owned PR creation. When PortOS
 * owns it (slashdo-free TUIs, runner mode) the PR is created by
 * `cleanupAgentWorktree` AFTER finalize, so checking here would report every
 * correct run as missing.
 *
 * Forge-aware: a GitLab repo is asked via `glab mr list`, mirroring the `gh`/
 * `glab` split `createPR` already makes. Asking `gh` about a GitLab remote
 * would fail and record every correct MR run as `forge-unreachable`.
 *
 * @returns {Promise<{ outcome: string, branch: string|null, message: string|null, advisory: string|null, commitsAhead: number|null, inconclusive: boolean }>}
 */
export async function observePrClaim({ task, workspacePath, success, prExpected, agentSummary = null }) {
  // Only a run that CLAIMED success has a claim to verify; a failed run is
  // already recorded as failed.
  if (!prExpected || !success || !workspacePath) return prObservation(PR_OBSERVATION.SKIPPED);
  const branch = await resolveWorkspaceBranch(workspacePath);
  // No branch to ask about (detached HEAD, non-repo workspace). Nothing was
  // verified — say nothing rather than invent a failure.
  if (!branch) return prObservation(PR_OBSERVATION.BRANCH_UNAVAILABLE, { inconclusive: true });

  const { resolveForgeForRepo } = await import('../forgeAuth.js');
  // `env` carries the repo-owner-pinned `GH_TOKEN` the agent's own `gh pr create`
  // used. Dropping it would query as whatever ambient account `gh` happens to be
  // on, which on a multi-login host may not even see the PR — reading as
  // "no PR" for a run that opened one.
  const forge = await resolveForgeForRepo(workspacePath).catch(() => null);
  if (!forge) return prObservation(PR_OBSERVATION.FORGE_UNAVAILABLE, {
    branch, message: 'Could not resolve the repository forge account', inconclusive: true,
  });
  const { cli, env } = forge;
  const draft = task?.metadata?.prCompletion === PR_COMPLETIONS.DRAFT;
  const found = cli === 'glab'
    ? await findMergeRequestForBranch(branch, workspacePath, ...(draft ? [{ includeDraft: true }] : []))
    : await findPullRequestForBranch(branch, { cwd: workspacePath, env: env || null, ...(draft ? { includeDraft: true } : {}) });

  const noun = cli === 'glab' ? 'merge request' : 'pull request';
  const titleNoun = `${noun[0].toUpperCase()}${noun.slice(1)}`;
  if (found.status === 'found') {
    if (draft && (found.isDraft !== true || !['OPEN', 'opened'].includes(found.detail))) {
      return prObservation(PR_OBSERVATION.INVALID_DISPOSITION, { branch,
        message: `This run requires an open draft ${noun}; the forge did not confirm that disposition for ${branch}` });
    }
    const issueNumber = issueNumberFromRef(branch);
    if (issueNumber === null) return prObservation(PR_OBSERVATION.VERIFIED_CLAIM, { branch, url: found.url });
    if (typeof found.body !== 'string') {
      // An unreadable body cannot distinguish a missing trailer from a present
      // one, so it is a forge failure, never the agent's.
      return prObservation(PR_OBSERVATION.FORGE_UNAVAILABLE, {
        branch,
        message: `Could not read the ${noun} body for branch ${branch} to verify issue #${issueNumber}`,
        inconclusive: true,
      });
    }
    if (hasIssueClosingTrailer(found.body, issueNumber)) return prObservation(PR_OBSERVATION.VERIFIED_CLAIM, { branch, url: found.url });
    if (hasIssuePartialTrailer(found.body, issueNumber)) {
      return prObservation(PR_OBSERVATION.VERIFIED_CLAIM, {
        branch, url: found.url,
        advisory: `${titleNoun} for branch ${branch} partially ships issue #${issueNumber}; reconcile the remaining scope after merge.`,
      });
    }
    return prObservation(PR_OBSERVATION.INVALID_TRAILER, {
      branch,
      message: `${titleNoun} for branch ${branch} does not contain a closing trailer for issue #${issueNumber}`,
    });
  }
  if (found.status === 'none') {
    // "No PR" is only a MISS if there was something to open one for. An agent
    // that investigated its task, found the defect already fixed on main, and
    // stopped without touching a file leaves a branch with zero commits — and
    // `gh pr create` on a zero-commit branch does not fail because the agent
    // slipped, it fails because there is no diff. Recording that as `pr-missing`
    // failed a correct run and, being non-actionable, re-ran the whole
    // investigation twice more to reach the same conclusion (agent-446c4f47).
    //
    // Deliberately gated on an EXPLICIT 0: an unreadable count is not evidence
    // of an empty branch, so it leaves the miss standing.
    const ahead = await countCommitsAhead(workspacePath).catch(() => null);
    // A dependency-updates run can leave its deliverable (a lockfile-only change)
    // uncommitted; cleanup preserves it, so the empty branch is not "already current".
    if (ahead === 0 && await hasUncommittedLockfileDeliverable(task, workspacePath)) {
      return prObservation(PR_OBSERVATION.MISSING_PR, { branch, commitsAhead: 0, inconclusive: false });
    }
    if (ahead === 0) return prObservation(PR_OBSERVATION.EMPTY_BRANCH, { branch });
    // The stand-down a parallel claim produces: the branch holds this run's
    // (now redundant) commits, the forge holds no change request for it, and
    // the agent's own summary says the work already landed elsewhere. The
    // resume briefing TELLS a retry to conclude exactly this — honor the report
    // only when the forge confirms a change request the summary names is
    // actually merged; the agent's word alone never excuses a miss.
    if (summaryDeclaresWorkLanded(agentSummary)) {
      const landed = await verifyLandedChangeRequest(
        landedChangeRequestRefs(agentSummary), { cli, env }, workspacePath
      ).catch(() => null);
      if (landed) {
        return prObservation(PR_OBSERVATION.WORK_LANDED_ELSEWHERE, {
          branch,
          advisory: `Work for this task already landed via ${noun} #${landed.ref} — this run stood down rather than opening a duplicate`,
        });
      }
    }
    return prObservation(PR_OBSERVATION.MISSING_PR, {
      branch,
      commitsAhead: ahead,
      inconclusive: ahead === null,
      message: `Agent reported success but no ${noun} exists for branch ${branch}`,
    });
  }
  return prObservation(PR_OBSERVATION.FORGE_UNAVAILABLE, {
    branch,
    message: `Could not confirm a ${noun} for branch ${branch} — the forge is unreachable${found.detail ? ` (${String(found.detail).split('\n')[0].slice(0, 120)})` : ''}`,
    inconclusive: true,
  });
}

/**
 * Public, backward-compatible face of `observePrClaim` — the sparse verdict
 * `agentWorktreeCleanup` and every existing test already consume.
 *
 * Four outcome families, never collapsed:
 *   - `ok: true`  — a PR exists with a valid claim trailer, or there was nothing to check
 *   - `ok: true, branchProvenEmpty: true` — the forge answered "no PR" and the
 *     branch holds no commits, so there was nothing a PR could have been opened
 *     for; the run concluded that no change was warranted
 *   - `ok: true, advisory: …` — the forge answered "no PR" for a branch that
 *     holds commits, but the run's summary declared the work already landed via
 *     a change request the forge confirmed is MERGED (a parallel claim shipped
 *     first; this run correctly stood down)
 *   - `ok: false, category: 'pr-missing'` — the forge answered "no PR" for a
 *     branch that DOES hold commits
 *   - `ok: false, category: 'forge-unreachable'` — we could not ask
 *
 * @returns {Promise<{ ok: boolean, category?: string, message?: string, advisory?: string, branch?: string|null, branchProvenEmpty?: boolean, commitsAhead?: number|null, inconclusive?: boolean }>}
 * `inconclusive: true` is set for every requested check that cannot reach an
 * unambiguous answer (no resolvable branch, unreachable forge, unreadable claim
 * body, or unreadable commit count). It is omitted for a proven empty branch and
 * a readable non-empty branch missing its PR.
 */
export async function verifyPrClaim({ task, workspacePath, success, prExpected, agentSummary = null }) {
  return prVerdictFromObservation(await observePrClaim({ task, workspacePath, success, prExpected, agentSummary }));
}
