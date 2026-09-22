/**
 * Primary-checkout branch-jack detector (#3680).
 *
 * A CoS agent spawned with a worktree must only ever write inside that
 * worktree. On 2026-08-09 one didn't: running `/do:pr` from its worktree it
 * applied its three commits onto the PRIMARY checkout's local `main`, where
 * they sat unpushed and unreviewed. `main` is unprotected on this repo, so a
 * later `git push` from the primary would have landed them without a PR.
 *
 * The chosen remedy is DETECT-AND-REPORT, not prevention and not auto-repair:
 *
 *   - Prevention (making the primary read-only for the duration of a run) would
 *     break the many legitimate flows that read and write the primary checkout.
 *   - Auto-repair means `git reset --hard`, which DISCARDS commits. That stays a
 *     human decision, so the failure message states the recovery command instead
 *     of running it — and notes that the same work also exists on the agent's
 *     own branch, which is what makes the reset safe.
 *
 * Movement alone is NOT the signal. The primary checkout legitimately moves
 * during a run — a `git pull` on `main`, another PortOS flow fast-forwarding it
 * to commits that already merged upstream. Reporting those as branch-jacks fired
 * a false failure whose recovery prose ("commits PortOS never reviewed", `reset
 * --hard origin/main`) was actively wrong: the commits WERE `origin/main`. So the
 * guard reports only what a branch-jack actually leaves behind — commits the
 * branch's upstream does not have, or the checkout parked on a different branch.
 * A branch with no upstream to compare against falls back to the remote's default
 * branch, and a checkout with no remote at all can't be cleared, so it still
 * reports (an unpushed commit is unreviewed by definition). See #4717 below.
 *
 * "The upstream does not have it" is a question about CONTENT, not SHAs (#3744).
 * This repo rebase-merges PRs, so a commit that merged upstream carries a
 * DIFFERENT sha there than the copy a local `git merge --ff-only <branch>` put on
 * the primary. Comparing shas alone reads that copy as unpushed, and the
 * patch-id attribution below then blames whichever agent's branch also carries
 * the same upstream commit — which, after a `/do:pr` rebase, is most of them.
 * That is how a run whose PR had already MERGED was failed for branch-jacking a
 * commit it did not author and that was never stranded. So the upstream
 * exclusion asks `git cherry`, matching the patch-id precision already used on
 * the attribution side; the two must agree, or the mismatch itself manufactures
 * failures.
 *
 * They did not agree, and it did (#4098). Attribution asked its patch-id question
 * over the whole `upstream..head` window instead of over the stranded set the
 * exclusion had just computed. Once an agent's PR MERGES, its branch is an ancestor
 * of the upstream, so `git cherry <agentBranch> …` marks every commit whose patch is
 * anywhere in upstream history — including the primary's own local copies of merged
 * work, which the exclusion had already cleared. A human's unpushed WIP branch was
 * failed as a branch-jack on two such commits, with recovery prose pointing at an
 * `origin/<branch>` that does not exist (the branch tracked `origin/main`), while the
 * accurate reset would have discarded 41 of the human's commits. Attribution now
 * intersects with the stranded set, which is also what makes the patch test sound
 * without a freshness filter: a stranded commit has no patch-equivalent upstream, so
 * a patch-equivalent on the agent's branch can only be the agent's own commit.
 *
 * Movement that survives the checks above is still not enough to FAIL the run.
 * The primary checkout is a shared global resource — a concurrent coding-on-main
 * agent, the human's own terminal, `update.sh`'s `git pull --rebase --autostash`,
 * or any background flow can strand commits on it — so before blaming the run,
 * the guard asks whether THIS agent could have produced them (#3703). When a run
 * strands commits, they are attributed to the agent's own worktree branch by
 * PATCH-ID (`git cherry`, not raw SHA, so a cherry-picked or rebased copy still
 * matches). Stranded commits the agent demonstrably did not author — a read-only
 * reasoner that never branched, commits with no patch-equivalent on the agent's
 * branch, or commits the agent merely REBASED ONTO (#3725: `/do:pr` rebases on
 * `main` before pushing, so any run that outlives a concurrent commit to `main`
 * inherits it into its branch's base) — are carried as `{ drifted: false, unattributed: true }`:
 * warn-logged (unreviewed commits on `main` are worth surfacing) but not failed.
 * The asymmetry is deliberate — a missed branch-jack still leaves a warn log and
 * recoverable commits, while a false failure escalates to a human and dents the
 * task type's success rate.
 *
 * A checkout left on the WRONG BRANCH with nothing local-only strands no commit to
 * attribute, and for a long time that exempted it from the gate entirely: it failed
 * the run outright, because there was supposedly "nothing to blame on anyone"
 * (#4231). That inverted the gate — the shape carrying the LEAST evidence of a
 * branch-jack was the only one never asked to prove authorship. The primary is
 * shared, and a human running `git checkout -b my-feature` in it is ordinary work,
 * so it failed every agent alive at that moment, with prose that contradicted
 * itself: "No commits were stranded" as the recovery for "A worktree agent
 * committed to the primary". With nothing stranded the only signal left is
 * WHICH branch it landed on, so the agent's OWN worktree branch still fails (a
 * shape only the agent produces) and every other branch is `unattributed` —
 * worth surfacing, since the next spawn baselines against it, but not a failure.
 *
 * All of the above rests on there BEING an upstream to compare against, and the
 * no-upstream fallback quietly kept the pre-#4098 behavior (#4717). A branch with no
 * upstream is not a branch with nothing pushed: `git checkout -b my-feature` off
 * `origin/main` leaves the whole of `main` underneath it. Reading that as "no
 * comparison available" makes every commit since the baseline a stranded candidate,
 * which stays harmless only while the baseline is ITSELF at `origin/main` — the
 * `^runBase` exclusion then covers the shared history by accident. A primary parked
 * on `release` broke that accident: the baseline sat 28 commits behind `main`, the
 * human cut an unpushed feature branch off `main` mid-run, and the guard reported 39
 * stranded commits. Attribution then matched, because the agent had branched from
 * `main` and its PR had MERGED — so `main`'s own history was, commit for commit,
 * also on the agent's branch. A run whose work was merged and reviewed was failed
 * for the contents of `main`. The fix is to stop treating "this branch has no
 * upstream" as "nothing here is pushed": the frontier falls back to the remote's
 * default branch (`resolveRemoteDefaultRef`), which can only ever CLEAR content,
 * since every commit it reaches is on the remote by definition. Only a checkout with
 * no remote at all still has no frontier, and there an unpushed commit really is
 * unreviewed by definition.
 *
 * Two halves, deliberately split so they can sit on opposite ends of a run:
 * `capturePrimaryCheckoutState` stamps a baseline at spawn time (onto the agent
 * metadata, in `agentLifecycle.js`), and `detectPrimaryCheckoutDrift` re-reads it
 * in the shared finalize path (`agentFinalization.js`) — the one chokepoint all
 * three spawn modes (TUI, direct CLI, runner) already funnel through, so the
 * guard is not TUI-only without triplicating it.
 *
 * Every function here is NON-THROWING, for the same reason `gitCommitProbe.js`
 * is: it runs on the agent-completion path, outside the Express request
 * lifecycle, where a rejection has nothing to bubble to. An unreadable or
 * missing checkout, or a wedged git, degrades to "no drift observed" — the guard
 * never manufactures a failure out of a check that could not run.
 */

import { execGit } from './execGit.js';

/**
 * The completion reason a drifted run is recorded under. Registered in
 * `COMPLETION_REASON_ANALYSES` (agentErrorAnalysis.js) so the analyzer has a
 * verdict for it instead of falling through to a keyword sweep of the
 * transcript.
 */
export const PRIMARY_CHECKOUT_MUTATED_REASON = 'primary-checkout-mutated';

/**
 * The taxonomy token the drift is classified under. Reuses the pre-existing
 * `git-error` category rather than minting a new one, so every downstream
 * consumer (auto-fix tiers, learning buckets, the failure ledger) keeps
 * classifying it with no new token to teach them. Deliberately NOT in
 * `ENVIRONMENTAL_ERROR_CATEGORIES`: this is the run's own misbehavior, and it
 * should dent the task type's measured success rate.
 */
export const PRIMARY_CHECKOUT_MUTATED_CATEGORY = 'git-error';

/**
 * What a human has to do before this task may run again. Lives here so the
 * finalize-path analysis and the `COMPLETION_REASON_ANALYSES` registration can't
 * drift apart on it. A retry cannot repair a mutated checkout, so this
 * deliberately escalates rather than blind-retrying.
 */
export const PRIMARY_CHECKOUT_MUTATED_ESCALATION =
  'A worktree agent committed to the primary checkout. Confirm the commits are preserved (agent branch / open PR), restore the primary, then approve the retry.';

/** Bound on every git call here — this sits on finalize; nothing may wedge it. */
const GIT_TIMEOUT_MS = 10_000;

/** First line of a probe-shaped execGit result, or null. */
function firstLine(result) {
  if (!result || result.exitCode !== 0) return null;
  const value = (result.stdout || '').trim();
  return value || null;
}

/**
 * Read a checkout's current branch + HEAD SHA. Returns null when the path is
 * absent, is not a repo, has no commits yet, or git could not be run.
 *
 * A DETACHED head reports its branch as the literal `HEAD` and is kept as-is
 * (rather than nulled, the way `resolveWorkspaceBranch` does it) — this value is
 * only ever compared against a later reading of itself, and "detached, then on a
 * branch" is exactly the kind of movement worth reporting.
 *
 * @param {string} checkoutPath
 * @returns {Promise<{path: string, branch: string, head: string}|null>}
 */
export async function capturePrimaryCheckoutState(checkoutPath) {
  if (!checkoutPath || typeof checkoutPath !== 'string') return null;
  const options = { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS };
  const [branchResult, headResult] = await Promise.all([
    execGit(['rev-parse', '--abbrev-ref', 'HEAD'], checkoutPath, options).catch(() => null),
    execGit(['rev-parse', 'HEAD'], checkoutPath, options).catch(() => null),
  ]);
  const branch = firstLine(branchResult);
  const head = firstLine(headResult);
  if (!branch || !head) return null;
  return { path: checkoutPath, branch, head };
}

/**
 * How many commits `head` is ahead of `baseHead`. Returns null (not 0) when the
 * range can't be resolved — a rewritten/pruned baseline commit, or a git that
 * timed out — so the prose can say "moved" without asserting a count it doesn't
 * have.
 */
async function countCommitsAhead(checkoutPath, baseHead, head, { noMerges = false, excludes = [] } = {}) {
  const args = ['rev-list', '--count'];
  if (noMerges) args.push('--no-merges');
  args.push(head, `^${baseHead}`, ...excludes.map(ref => `^${ref}`));
  const result = await execGit(
    args,
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  const value = firstLine(result);
  const count = value === null ? NaN : parseInt(value, 10);
  return Number.isFinite(count) ? count : null;
}

/**
 * The branch's upstream tracking ref (`origin/main`), resolved to an IMMUTABLE
 * SHA — or null when it has none configured, or git could not be run. Pinning to
 * a SHA (rather than returning the symbolic `origin/main`) means the count and the
 * later `git cherry` walk compare against the same history even if a concurrent
 * fetch moves the tracking ref between calls — this guard runs against a shared
 * checkout that other actors are actively moving. Both failure modes collapse to
 * null on purpose: the caller treats "no comparison available" identically.
 */
async function resolveUpstreamSha(checkoutPath, branch) {
  const result = await execGit(
    ['rev-parse', `${branch}@{upstream}`],
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  return firstLine(result);
}

/**
 * The SYMBOLIC name of that same upstream (`origin/main`) — what the recovery prose
 * has to quote, because a branch does NOT necessarily track a remote branch of its
 * own name. A local WIP branch cut from `main` with `branch.autoSetupMerge` on
 * tracks `origin/main`, so the prose's old hardcoded `origin/<branch>` named a ref
 * that does not exist (#4098): the "recovery" command errors out, and the reader who
 * corrects it to the real upstream discards every local commit on the branch.
 * Null when there is no upstream or git could not be run.
 */
async function resolveUpstreamRef(checkoutPath, branch) {
  const result = await execGit(
    ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  return firstLine(result);
}

/**
 * The remote's DEFAULT-BRANCH tracking ref as `{ ref, sha }` — the pushed frontier
 * to fall back on when `current.branch` has no upstream of its own (#4717).
 *
 * "No upstream" is not "nothing is pushed". A human on the shared primary running
 * `git checkout -b my-feature` has a branch with no upstream sitting on top of the
 * whole of `origin/main`, and treating that as "no comparison available" makes the
 * guard read every commit since the baseline as stranded. That is survivable while
 * the baseline is itself at `origin/main` — `^runBase` then excludes the shared
 * history anyway — and it is exactly what broke when the baseline was NOT: a primary
 * parked on `release` (behind `main`) was read as stranding 39 commits, 28 of which
 * were ordinary merged `main` history. Every one of those was also on the agent's
 * branch, because the agent branched from `main` and its PR had since merged, so
 * attribution matched and the run was failed for `main`'s own history. This is the
 * #4098 shape reached through the no-upstream fallback that #4098 did not touch.
 *
 * `origin/HEAD` first (the remote's own answer), then the conventional names. All
 * three are remote-tracking refs, so anything they reach is by definition pushed —
 * the frontier only ever CLEARS content, never invents a stranded commit. A repo
 * with no remote at all resolves to null and keeps the pre-existing behavior: an
 * unpushed commit is unreviewed by definition, so the guard still attributes it
 * against the run baseline.
 *
 * NON-THROWING, like the rest of the module.
 */
export async function resolveRemoteDefaultRef(checkoutPath) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const result = await execGit(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      checkoutPath,
      { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
    ).catch(() => null);
    const sha = firstLine(result);
    if (!sha) continue;
    // `origin/HEAD` is a symref; name the branch it points at, since the ref goes
    // into a `reset --hard` command a human types later and `origin/HEAD` reads as
    // a footgun even where it resolves.
    if (ref !== 'origin/HEAD') return { ref, sha };
    return { ref: (await resolveSymbolicRemoteHead(checkoutPath)) || ref, sha };
  }
  return null;
}

/** `origin/HEAD`'s target in `origin/<branch>` form, or null. Non-throwing. */
async function resolveSymbolicRemoteHead(checkoutPath) {
  const result = await execGit(
    ['rev-parse', '--abbrev-ref', 'origin/HEAD'],
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  return firstLine(result);
}

/**
 * Resolve the agent's own worktree branch to an IMMUTABLE commit SHA — trying the
 * local branch first, then its `origin/<branch>` remote-tracking form (the agent
 * may have pushed and had its local ref pruned). Returns the SHA (not the ref
 * name) so the count and the `git cherry` walk pin to the same commit even if the
 * shared branch ref is moved or pruned between the two calls. Returns null when
 * neither resolves, the name is empty, or git could not be run — every one of
 * which the caller treats as "cannot attribute, so do not blame".
 */
async function resolveAgentBranchSha(checkoutPath, agentBranch) {
  if (!agentBranch || typeof agentBranch !== 'string') return null;
  for (const ref of [agentBranch, `refs/remotes/origin/${agentBranch}`]) {
    const result = await execGit(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      checkoutPath,
      { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
    ).catch(() => null);
    const sha = firstLine(result);
    if (sha) return sha;
  }
  return null;
}

/**
 * The commits `driftedHead` carries that the upstream lacks BY CONTENT (#3744) —
 * `git cherry <upstream> <driftedHead> <runBase>`, keeping only the `+` lines
 * (no patch-equivalent upstream). Merge commits are excluded by `git cherry`
 * itself, matching the `noMerges` counts.
 *
 * This is the sha-based `upstream..head` count made patch-id-precise. It matters
 * because PortOS rebase-merges PRs: the merged commit's sha upstream differs
 * from the copy on the primary, so a sha comparison reports "unpushed" for
 * content that is fully pushed and reviewed.
 *
 * The `runBase` limit keeps a PRE-run unpushed commit out of the set (it is not
 * this run's doing). A limit that no longer exists in the history — the baseline
 * commit rewritten by a mid-run `git pull --rebase` on the primary — widens the
 * walk rather than breaking it, and the patch-equivalence filter still drops
 * every rewritten copy, since a rebase preserves patch-ids.
 *
 * Returns null when there is no upstream to compare against, or `git cherry`
 * could not run — both of which the caller must treat as "no patch-level verdict
 * available" and fall back to the sha counts, never as "verified clean".
 * NON-THROWING.
 */
async function listStrandedByPatch(checkoutPath, { runBase, upstream, driftedHead }) {
  if (!upstream) return null;
  const result = await execGit(
    ['cherry', upstream, driftedHead, runBase],
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return (result.stdout || '')
    .split('\n')
    .filter(line => line.startsWith('+ '))
    .map(line => line.slice(2).trim())
    .filter(Boolean);
}

/**
 * The commits in `limit..head` that DO have a patch-equivalent somewhere in `of`'s
 * history — the `-` lines of `git cherry -v <of> <head> <limit>`. The mirror of
 * `listStrandedByPatch`, used on the attribution side to ask "is this commit a
 * rebased/cherry-picked copy of one on the agent's branch?".
 *
 * Returns null when the walk could not run, which every caller must treat as "no
 * verdict available" and never as "nothing matched". NON-THROWING.
 */
async function listPatchEquivalentShas(checkoutPath, { of, head, limit }) {
  const result = await execGit(
    ['cherry', '-v', of, head, limit],
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return (result.stdout || '')
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.split(' ')[1])
    .filter(Boolean);
}

/**
 * Is `descendant` STRICTLY ahead of `ancestor` — reachable from it, and not the same
 * commit? Non-throwing; an unresolvable comparison returns false, which the caller
 * treats as "no reason to skip the attribution checks".
 */
async function isStrictlyAhead(checkoutPath, ancestor, descendant) {
  if (!ancestor || !descendant || ancestor === descendant) return false;
  return isAncestorOrSame(checkoutPath, ancestor, descendant);
}

/**
 * Is `ancestor` still reachable from `descendant` (or the same commit)? Used to ask
 * whether the spawn-time baseline survived the run — a mid-run `git pull --rebase`
 * on the primary rewrites its local commits and orphans that sha. Non-throwing; an
 * unresolvable comparison returns false, so an unreadable history reports the
 * baseline as rewritten rather than quoting a commit count derived from it.
 */
async function isAncestorOrSame(checkoutPath, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  const result = await execGit(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  return Boolean(result && result.exitCode === 0);
}

/**
 * Was the drift plausibly THIS agent's doing (#3703)? Looks only at the commits
 * that could actually be this run's branch-jack — reachable from the drifted head,
 * created AFTER spawn (not reachable from `runBase`, the checkout's HEAD at spawn)
 * AND still unpushed (not reachable from the branch's `upstream`) — and asks whether
 * any of them is the agent's own, by SHA or by PATCH-ID (so a cherry-picked / rebased
 * copy still matches — a raw-SHA check would miss the case the #3680 incident could
 * have produced).
 *
 * Excluding BOTH ends of that window is essential. A commit the agent merely inherited
 * from the primary at spawn, and a shared upstream commit a pull brought onto the
 * primary during the run, are each already on the agent's branch — `git cherry` omits
 * them (same SHA) — yet either would otherwise be counted as stranded and silently
 * re-blame the agent for a drift another actor caused: the exact #3703 regression.
 * Only a commit that is new this run AND unpushed can be the agent's branch-jack.
 *
 * Returns true when AT LEAST ONE such commit is the agent's own. Every uncertain
 * outcome — no branch name, a branch that does not resolve, or a failed git call —
 * returns FALSE (unattributed), failing open by design: a missed branch-jack still
 * leaves a warn log and recoverable commits, while a false failure escalates to a
 * human and dents the task type's success rate. NON-THROWING, like the rest of the
 * module.
 *
 * `strandedShas` — the caller's patch-level stranded set — is what makes the second
 * half of that window trustworthy, and its absence is what made #4098 fail a run
 * whose PR had merged. See the comment on the preferred path below.
 */
async function isDriftAttributableToAgent(checkoutPath, { runBase, upstream, driftedHead, agentBranch, strandedShas = null, baselineRewritten = false }) {
  const agentSha = await resolveAgentBranchSha(checkoutPath, agentBranch);
  if (!agentSha) return false;
  // The agent's branch is BUILT ON TOP OF the drifted head, so the stranded commits are
  // part of the branch's BASE — put there by whoever moved the primary first, then
  // inherited when the agent branched from (or rebased onto) the moved `main`. `/do:pr`
  // rebases onto `main` before pushing, so EVERY agent that outlives a concurrent commit
  // to `main` ends in this shape; the reachability check below only asks "is this commit
  // on the agent's branch?", and would read that inherited base as proof of authorship.
  // The causal arrow runs primary → agent here, which is a rebase, not a branch-jack.
  //
  // A real jack leaves the primary AT a commit the agent authored — its branch tip, or a
  // patch-equivalent copy on a divergent history — never strictly BEHIND its own branch,
  // so the #3680 incident shape still fails this test and is still caught. The residual
  // miss (an agent that jacks and then keeps committing to its branch) is the documented
  // fail-open trade in the module header, and its commits are on a pushed branch anyway.
  if (await isStrictlyAhead(checkoutPath, driftedHead, agentSha)) return false;

  // Preferred path (#4098): the caller already resolved WHICH commits are stranded,
  // by patch-id — the set that excludes, by content, everything the upstream has.
  // Attribution then only ever asks about THOSE commits.
  //
  // That restriction is what keeps a MERGED agent branch from indicting the whole of
  // `main`. Once the agent's PR lands, its branch is an ancestor of the upstream, so
  // `git cherry <agentSha> …` marks `-` every commit in the window whose patch is
  // anywhere in upstream history — including the primary's own local copies of
  // already-merged work, which are nobody's branch-jack. The observed run failed on
  // exactly that: two commits the stranded set had ALREADY cleared as upstream
  // content were matched against the agent's merged branch and read as its own. The
  // module header says the two sides must agree; intersecting them is how.
  //
  // Restricted this way, the patch test is sound with no freshness filter: a stranded
  // commit has NO patch-equivalent upstream, so a patch-equivalent on the agent's
  // branch can only be one of the agent's OWN commits.
  if (Array.isArray(strandedShas)) {
    if (strandedShas.length === 0) return false;
    // Literal branch-jack: the agent's branch carries a stranded commit outright.
    for (const sha of strandedShas) {
      if (await isAncestorOrSame(checkoutPath, sha, agentSha)) return true;
    }
    // Patch-equivalent branch-jack: a cherry-picked / rebased copy, different sha.
    const equivalents = await listPatchEquivalentShas(checkoutPath, {
      of: agentSha,
      head: driftedHead,
      limit: upstream || runBase,
    });
    if (!equivalents) return false;
    const stranded = new Set(strandedShas);
    return equivalents.some(sha => stranded.has(sha));
  }

  // Fallback: no patch-level stranded set (no upstream to compare against, or the
  // walk failed). Approximate it with the sha window below.
  // Candidate branch-jack commits (set S): new this run (`^runBase`) AND unpushed
  // (`^upstream`, when there is an upstream to compare against), non-merge only — a
  // merge commit reaches the primary via a human's `git merge` / non-ff pull, never a
  // `/do:pr` branch-jack.
  const strandedExcludes = upstream ? [upstream] : [];
  const strandedTotal = await countCommitsAhead(checkoutPath, runBase, driftedHead, { noMerges: true, excludes: strandedExcludes });
  if (!strandedTotal) return false;
  // Literal branch-jack: a candidate commit also on the agent's branch by SHA (a
  // fast-forward of the agent's own commit onto the primary). `git cherry` omits these,
  // so detect them by reachability: if excluding the agent's branch drops the count,
  // some candidate commit is the agent's.
  const strandedNotOnAgent = await countCommitsAhead(checkoutPath, runBase, driftedHead, { noMerges: true, excludes: [...strandedExcludes, agentSha] });
  // A failed count is null; `null < n` coerces to `0 < n` and would falsely attribute
  // (a false failure), so treat an unresolvable count as "cannot determine" and fail open.
  if (strandedNotOnAgent === null) return false;
  if (strandedNotOnAgent < strandedTotal) return true;
  // Patch-equivalent branch-jack: a cherry-picked / rebased copy (different SHA, missed
  // by the reachability check). `git cherry <upstream> <head> <limit>` marks such a
  // commit `-`. Walk unpushed commits (limit = upstream), then keep only a `-` commit
  // that is new this run — a pre-run copy is a prior run's problem, not this one's.
  //
  // That "new this run" test is reachability against `runBase`, so a mid-run `git pull
  // --rebase` on the primary breaks it: the replayed commits get new shas, the baseline
  // is orphaned, and NOTHING on the current history is an ancestor of it — every `-`
  // commit then reads as fresh, whenever it was really made. An unanswerable check must
  // fail open (the module's contract), not answer "yes" by default.
  if (baselineRewritten) return false;
  const equivalentShas = await listPatchEquivalentShas(checkoutPath, {
    of: agentSha,
    head: driftedHead,
    limit: upstream || runBase,
  });
  if (!equivalentShas) return false;
  for (const sha of equivalentShas) {
    const ancestor = await execGit(
      ['merge-base', '--is-ancestor', sha, runBase],
      checkoutPath,
      { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
    ).catch(() => null);
    // exitCode 1 → sha is NOT an ancestor of runBase → created during the run.
    if (ancestor && ancestor.exitCode === 1) return true;
  }
  return false;
}

/** Short SHA for human-readable prose. */
const short = sha => String(sha || '').slice(0, 9);

/**
 * Re-read the baseline and report whether the primary checkout moved during the
 * run.
 *
 * Outcomes, never collapsed:
 *   - `{ drifted: false }` — it didn't move, OR there was nothing to check, OR
 *     the checkout could not be read (nothing was verified, so nothing is
 *     claimed).
 *   - `{ drifted: false, fastForwarded: true, … }` — HEAD moved on the SAME
 *     branch but every commit is already on that branch's upstream. That is a
 *     `git pull`, not a branch-jack; carried as a distinct shape (rather than a
 *     bare `false`) so a caller can log what it observed.
 *   - `{ drifted: false, unattributed: true, … }` — commits WERE stranded, but
 *     none are patch-equivalent to a commit on the agent's own branch, so this
 *     run demonstrably did not put them there (a concurrent actor did). Carries
 *     the `message` so the caller can warn-log the unreviewed commits without
 *     failing the run. See the module header on the fail-open asymmetry.
 *   - `{ drifted: true, … }` — the checkout ended on a different branch, or it
 *     carries commits the upstream does not have AND those commits are
 *     attributable to the agent's own branch by patch-id.
 *
 * @param {{path: string, branch: string, head: string}|null} baseline stamped by
 *   `capturePrimaryCheckoutState` at spawn time
 * @param {{ agentBranch?: string|null }} [options] the agent's own worktree
 *   branch, used both to ATTRIBUTE the stranded commits by patch-id and, once
 *   attributed, named in the recovery prose because it is where the same commits
 *   almost certainly also live
 */
export async function detectPrimaryCheckoutDrift(baseline, { agentBranch = null } = {}) {
  if (!baseline?.path || !baseline?.branch || !baseline?.head) return { drifted: false };
  const current = await capturePrimaryCheckoutState(baseline.path);
  // Unreadable now (deleted, mid-rebase, git wedged): we verified nothing, so we
  // report nothing rather than inventing a failure.
  if (!current) return { drifted: false };
  if (current.branch === baseline.branch && current.head === baseline.head) return { drifted: false };

  // Pin the upstream to a SHA and count everything against `current.head` (the SHA
  // captured above), never the live `current.branch` — a concurrent commit or
  // fetch on the shared checkout must not make the two counts and the cherry walk
  // read different histories.
  //
  // A branch with no upstream of its own falls back to the remote's default branch
  // (#4717): a freshly-cut local branch is not "nothing is pushed", and reading it
  // that way strands the whole of `main` whenever the baseline sits behind `main`.
  // See `resolveRemoteDefaultRef`. Null only when the checkout has no remote at all.
  const ownUpstream = await resolveUpstreamSha(baseline.path, current.branch);
  const fallbackUpstream = ownUpstream ? null : await resolveRemoteDefaultRef(baseline.path);
  const upstream = ownUpstream || fallbackUpstream?.sha || null;
  const [commitCount, unpushedCount] = await Promise.all([
    countCommitsAhead(baseline.path, baseline.head, current.head),
    // Commits the branch carries that its upstream does not — the only commits a
    // branch-jack actually strands. Null (not 0) when there is no upstream to
    // compare against, so "verified clean" never masquerades as "could not check".
    upstream ? countCommitsAhead(baseline.path, upstream, current.head) : Promise.resolve(null),
  ]);

  // The same question asked by patch-id rather than by sha (#3744) — null when
  // there is no upstream or the walk failed, which must NOT read as "clean".
  // Skipped when the sha count already cleared the checkout: it can only agree.
  const strandedByPatch = unpushedCount === 0
    ? []
    : await listStrandedByPatch(baseline.path, { runBase: baseline.head, upstream, driftedHead: current.head });

  // Same branch, nothing local-only: the checkout was pulled forward onto commits
  // that are already upstream (reviewed, merged, pushed). Nothing was stranded, so
  // there is nothing for a human to recover. An empty patch-level set clears it
  // just as a zero sha count does — a rebase-merged copy is upstream content
  // wearing a local sha, and telling a human to `reset --hard` over it is the
  // false alarm this guard exists to avoid.
  if (current.branch === baseline.branch && (unpushedCount === 0 || strandedByPatch?.length === 0)) {
    return { drifted: false, fastForwarded: true, baseline, current, commitCount };
  }

  // Did the baseline commit survive the run? A `git pull --rebase` on the primary
  // REWRITES the local commits it replays, orphaning the sha stamped at spawn — at
  // which point `commitCount` counts the whole post-fork history rather than the
  // run's movement, and the prose ("16 new commits") badly overstates what moved.
  // Say so instead of quoting a number that no longer means what it says.
  const baselineRewritten = !(await isAncestorOrSame(baseline.path, baseline.head, current.head));
  const driftFacts = { baseline, current, commitCount, baselineRewritten };
  const message = formatDriftMessage(driftFacts);
  const unattributedMessage = async () => withCommitSubject(
    formatDriftMessage({ ...driftFacts, attributed: false }),
    await commitSubject(baseline.path, current.head),
  );

  // Second gate (#3703): stranded commits are only a failure if THIS agent could
  // have produced them. Attribution runs whenever there is (or should be) a
  // stranded commit — a resolvable positive count, OR an UNRESOLVABLE count
  // (`null`: a pruned baseline or a wedged git), which must fail OPEN rather than
  // manufacture a failure out of a check that could not run.
  // Prefer the patch-level verdict when there is one; a resolved empty set means
  // nothing is stranded even where the sha count disagrees. Null falls back to the
  // sha count, and a null THERE falls back to the movement count, which is
  // unresolvable-and-therefore-fail-open below.
  const strandedCount = strandedByPatch
    ? strandedByPatch.length
    : (unpushedCount === null ? commitCount : unpushedCount);

  // A BARE BRANCH SWITCH — the checkout is parked on a different branch and
  // stranded exactly nothing (#4231). This used to skip attribution entirely and
  // fail the run on the theory that there was "nothing to blame on anyone", which
  // inverted the gate: the shape with the LEAST evidence of a branch-jack was the
  // only one that never had to prove authorship. The primary is a shared checkout,
  // and a human running `git checkout -b my-feature` in it is ordinary work — so
  // every agent alive at that moment was failed, with a recovery note that
  // contradicted its own escalation ("No commits were stranded" under "A worktree
  // agent committed to the primary"). agent-8249579a was recorded
  // `success: false` this way while its PR was merging.
  //
  // With nothing stranded there is no commit to attribute by patch-id, so the one
  // signal left is WHICH branch the checkout landed on. The agent's OWN worktree
  // branch is a shape only the agent produces, and it stays a failure. Any other
  // branch is somebody else's business: warn-logged as `unattributed` (the primary
  // being off `main` still matters — the next spawn baselines against it) but never
  // a failure, per the fail-open asymmetry in the module header.
  if (strandedCount === 0 && current.branch !== agentBranch) {
    return { drifted: false, unattributed: true, baseline, current, commitCount, unpushedCount, message: await unattributedMessage() };
  }
  if (strandedCount === null || strandedCount > 0) {
    const attributed = await isDriftAttributableToAgent(baseline.path, {
      runBase: baseline.head,
      upstream,
      driftedHead: current.head,
      agentBranch,
      strandedShas: strandedByPatch,
      baselineRewritten,
    });
    if (!attributed) {
      return { drifted: false, unattributed: true, baseline, current, commitCount, unpushedCount, message: await unattributedMessage() };
    }
  }

  return {
    drifted: true,
    reason: PRIMARY_CHECKOUT_MUTATED_REASON,
    category: PRIMARY_CHECKOUT_MUTATED_CATEGORY,
    baseline,
    current,
    commitCount,
    unpushedCount,
    message,
    suggestedFix: formatDriftRecovery({
      current,
      baseline,
      commitCount,
      unpushedCount,
      strandedCount,
      agentBranch,
      // Symbolic, not the pinned sha: this goes into a command a human runs later.
      // Must name the ref the stranded set was actually computed against, or the
      // reader inspects a different range than the one the count came from — which
      // for a branch with no upstream meant quoting an `origin/<branch>` that does
      // not exist and whose `reset --hard` errors out (the #4098 lesson, reached
      // through the fallback path).
      upstreamRef: (await resolveUpstreamRef(baseline.path, current.branch)) || fallbackUpstream?.ref || null,
      upstreamIsRemoteDefault: !ownUpstream && Boolean(fallbackUpstream),
    }),
  };
}

/**
 * Human-readable "what moved". Pure.
 *
 * `attributed: false` is the unattributed outcome: the checkout moved, and this
 * run's branch does not contain the new commits. The lead must not accuse the
 * worktree agent — the caller is about to say the movement was someone else's.
 */
export function formatDriftMessage({ baseline, current, commitCount, baselineRewritten = false, attributed = true }) {
  const branchPart = current.branch === baseline.branch
    ? `branch ${current.branch}`
    : `branch ${baseline.branch} → ${current.branch}`;
  const countPart = commitCount === null
    ? 'commit count unresolved'
    : baselineRewritten
      // The baseline is off the current history (a rebase replayed it under a new
      // sha), so the count spans the fork point, not the run. Label it as such
      // rather than passing it off as "N new commits".
      ? `baseline rewritten by a rebase; ${commitCount} commit${commitCount === 1 ? '' : 's'} since the abandoned baseline`
      : `${commitCount} new commit${commitCount === 1 ? '' : 's'}`;
  const lead = attributed
    ? `Worktree agent mutated the primary checkout ${baseline.path}`
    : `Primary checkout ${baseline.path} moved during a worktree run`;
  return `${lead}: ${branchPart}, HEAD ${short(baseline.head)} → ${short(current.head)} (${countPart})`;
}

/** One-line subject of `sha`, or '' when git cannot name it. Never throws. */
async function commitSubject(repoPath, sha) {
  if (!repoPath || !sha) return '';
  const result = await execGit(
    ['log', '-1', '--format=%s', sha],
    repoPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  const subject = firstLine(result);
  if (!subject) return '';
  const oneLine = subject.replace(/[\r\n"]/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

function withCommitSubject(message, subject) {
  return subject ? `${message} — "${subject}"` : message;
}

/**
 * The recovery advice. Names the exact commands and is explicit that the reset
 * discards commits — PortOS deliberately does not run it (see the module header).
 *
 * Two shapes, because the two failures need different commands: a checkout left
 * on the WRONG BRANCH with nothing local-only just needs checking back out (no
 * reset, nothing to discard, no reason to scare the reader with `--hard`), while
 * stranded commits need the inspect-then-reset flow. Pure.
 *
 * `upstreamRef` is the branch's ACTUAL upstream (`git rev-parse --abbrev-ref
 * <branch>@{upstream}`), not an assumption that it is `origin/<branch>`; see
 * `resolveUpstreamRef`. It falls back to `origin/<branch>` only when the caller could
 * not resolve one, which is the pre-#4098 wording.
 *
 * `upstreamIsRemoteDefault` says that ref is the REMOTE'S DEFAULT BRANCH standing in
 * for a branch that has no upstream (#4717), not something the branch tracks — the
 * reset is just as wide either way, but telling a reader their branch "tracks"
 * `origin/main` when it tracks nothing sends them to `git branch -u` to undo a
 * setting that was never there.
 */
export function formatDriftRecovery({ current, baseline = null, commitCount, unpushedCount = null, strandedCount = null, agentBranch, upstreamRef = null, upstreamIsRemoteDefault = false }) {
  if (unpushedCount === 0 && baseline?.branch && baseline.branch !== current.branch) {
    return [
      `A worktree-isolated agent left the PRIMARY checkout on its own worktree branch \`${current.branch}\` instead of \`${baseline.branch}\`.`,
      `No commits were stranded — \`${current.branch}\` carries nothing its upstream lacks — so restore it with \`git -C ${current.path} checkout ${baseline.branch}\`.`,
    ].join(' ');
  }
  const alsoOn = agentBranch
    ? `The same commits were almost certainly pushed on the agent's own branch \`${agentBranch}\` too, so check there (and for an open PR) before discarding anything.`
    : 'Check the agent\'s own branch (and for an open PR) for the same commits before discarding anything.';
  // The actionable number is what the upstream is MISSING, not how far HEAD moved
  // — a pull that also carried the agent's commit moves HEAD further than the
  // damage goes. `strandedCount` is the caller's patch-level tally when it has
  // one; the sha counts are the fallback.
  const stranded = strandedCount === null
    ? (unpushedCount === null ? commitCount : unpushedCount)
    : strandedCount;
  const countPhrase = stranded === null ? 'commits' : `${stranded} commit${stranded === 1 ? '' : 's'}`;
  const resetTarget = upstreamRef || `origin/${current.branch}`;
  // A branch tracking something other than its own remote counterpart (a local WIP
  // branch cut from `main` tracks `origin/main`) rewinds ONTO THAT — which is most of
  // the branch, not just the drift. Say so where the reader is about to type it.
  const trackingCaveat = upstreamRef && upstreamRef !== `origin/${current.branch}`
    ? upstreamIsRemoteDefault
      ? ` Note that \`${current.branch}\` has no upstream of its own, so \`${upstreamRef}\` is the remote's default branch standing in for one — that reset rewinds onto \`${upstreamRef}\` and drops every local commit on the branch, not only the agent's.`
      : ` Note that \`${current.branch}\` tracks \`${upstreamRef}\` rather than a remote branch of its own, so that reset rewinds it onto \`${upstreamRef}\` and drops every local commit on it, not only the agent's.`
    : '';
  return [
    `A worktree-isolated agent committed to the PRIMARY checkout instead of its worktree, leaving \`${current.branch}\` carrying ${countPhrase} PortOS never reviewed.`,
    alsoOn,
    `Inspect them with \`git -C ${current.path} log --oneline ${resetTarget}..${current.branch}\`, and once you have confirmed the content is upstream (or preserved on the agent branch) restore the checkout with \`git -C ${current.path} reset --hard ${resetTarget}\`.`,
    `That reset DISCARDS those commits, so PortOS will not run it for you.${trackingCaveat}`,
  ].join(' ');
}
