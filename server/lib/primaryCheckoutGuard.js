/**
 * Primary-checkout branch-jack detector (#3680).
 *
 * Detect-and-report only: `git reset --hard` discards commits, so recovery stays a human decision.
 * Movement alone is not the signal; only commits the upstream lacks (compared by patch-id, not SHA)
 * or a checkout parked on another branch count, and commits the agent did not author are
 * `unattributed` (warned, not failed). Every function is non-throwing: it runs on the
 * agent-completion path outside the request lifecycle, and an unreadable checkout means no drift.
 */

import { execGit } from './execGit.js';

/**
 * The completion reason a drifted run is recorded under. Registered in
 * `COMPLETION_REASON_ANALYSES` (agentErrorAnalysis.js) so the analyzer has a verdict for it
 * instead of falling through to a keyword sweep of the transcript.
 */
export const PRIMARY_CHECKOUT_MUTATED_REASON = 'primary-checkout-mutated';

/**
 * The taxonomy token the drift is classified under. Reuses the pre-existing `git-error` category
 * rather than minting a new one, so every downstream consumer (auto-fix tiers, learning buckets,
 * the failure ledger) keeps classifying it with no new token to teach them.
 */
export const PRIMARY_CHECKOUT_MUTATED_CATEGORY = 'git-error';

/**
 * What a human has to do before this task may run again. Lives here so the finalize-path analysis
 * and the `COMPLETION_REASON_ANALYSES` registration can't drift apart on it.
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
 * Read a checkout's current branch + HEAD SHA. Returns null when the path is absent, is not a
 * repo, has no commits yet, or git could not be run.
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
 * How many commits `head` is ahead of `baseHead`. Returns null (not 0) when the range can't be
 * resolved — a rewritten/pruned baseline commit, or a git that timed out — so the prose can say
 * "moved" without asserting a count it doesn't have.
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
 * The branch's upstream tracking ref (`origin/main`), resolved to an IMMUTABLE SHA — or null when
 * it has none configured, or git could not be run. Pinning to a SHA (rather than returning the
 * symbolic `origin/main`) means the count and the later `git cherry` walk compare against the same
 * history even if a concurrent fetch moves the tracking ref between calls — this guard runs
 * against a shared checkout that other actors are actively moving.
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
 * The SYMBOLIC name of that same upstream (`origin/main`) — what the recovery prose has to quote,
 * because a branch does NOT necessarily track a remote branch of its own name. Null when there is
 * no upstream or git could not be run.
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
 * "No upstream" is not "nothing is pushed". A human on the shared primary running `git checkout -b
 * my-feature` has a branch with no upstream sitting on top of the whole of `origin/main`, and
 * treating that as "no comparison available" makes the guard read every commit since the baseline
 * as stranded.
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
    // `origin/HEAD` is a symref; name the branch it points at, since the ref goes into a `reset
    // --hard` command a human types later and `origin/HEAD` reads as a footgun even where it
    // resolves.
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
 * Resolve the agent's own worktree branch to an IMMUTABLE commit SHA — trying the local branch
 * first, then its `origin/<branch>` remote-tracking form (the agent may have pushed and had its
 * local ref pruned). Returns the SHA (not the ref name) so the count and the `git cherry` walk pin
 * to the same commit even if the shared branch ref is moved or pruned between the two calls.
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
 * Merge commits are excluded by `git cherry` itself, matching the `noMerges` counts. This is the
 * sha-based `upstream..head` count made patch-id-precise.
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
 * The commits in `limit..head` that DO have a patch-equivalent somewhere in `of`'s history — the
 * `-` lines of `git cherry -v <of> <head> <limit>`. The mirror of `listStrandedByPatch`, used on
 * the attribution side to ask "is this commit a rebased/cherry-picked copy of one on the agent's
 * branch?".
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
 * Is `descendant` STRICTLY ahead of `ancestor` — reachable from it, and not the same commit?
 * Non-throwing; an unresolvable comparison returns false, which the caller treats as "no reason to
 * skip the attribution checks".
 */
async function isStrictlyAhead(checkoutPath, ancestor, descendant) {
  if (!ancestor || !descendant || ancestor === descendant) return false;
  return isAncestorOrSame(checkoutPath, ancestor, descendant);
}

/**
 * Is `ancestor` still reachable from `descendant` (or the same commit)? Non-throwing; an
 * unresolvable comparison returns false, so an unreadable history reports the baseline as
 * rewritten rather than quoting a commit count derived from it.
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
 * Excluding BOTH ends of that window is essential. Only a commit that is new this run AND unpushed
 * can be the agent's branch-jack.
 */
async function isDriftAttributableToAgent(checkoutPath, { runBase, upstream, driftedHead, agentBranch, strandedShas = null, baselineRewritten = false }) {
  const agentSha = await resolveAgentBranchSha(checkoutPath, agentBranch);
  if (!agentSha) return false;
  // The agent's branch is BUILT ON TOP OF the drifted head, so the stranded commits are part of
  // the branch's BASE — put there by whoever moved the primary first, then inherited when the
  // agent branched from (or rebased onto) the moved `main`. `/do:pr` rebases onto `main` before
  // pushing, so EVERY agent that outlives a concurrent commit to `main` ends in this shape; the
  // reachability check below only asks "is this commit on the agent's branch?", and would read
  // that inherited base as proof of authorship.
  if (await isStrictlyAhead(checkoutPath, driftedHead, agentSha)) return false;

  // Attribution then only ever asks about THOSE commits. That restriction is what keeps a MERGED
  // agent branch from indicting the whole of `main`.
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

  // Fallback: no patch-level stranded set (no upstream to compare against, or the walk failed).
  // Approximate it with the sha window below.
  const strandedExcludes = upstream ? [upstream] : [];
  const strandedTotal = await countCommitsAhead(checkoutPath, runBase, driftedHead, { noMerges: true, excludes: strandedExcludes });
  if (!strandedTotal) return false;
  // Literal branch-jack: a candidate commit also on the agent's branch by SHA (a fast-forward of
  // the agent's own commit onto the primary). `git cherry` omits these, so detect them by
  // reachability: if excluding the agent's branch drops the count, some candidate commit is the
  // agent's.
  const strandedNotOnAgent = await countCommitsAhead(checkoutPath, runBase, driftedHead, { noMerges: true, excludes: [...strandedExcludes, agentSha] });
  // A failed count is null; `null < n` coerces to `0 < n` and would falsely attribute (a false
  // failure), so treat an unresolvable count as "cannot determine" and fail open.
  if (strandedNotOnAgent === null) return false;
  if (strandedNotOnAgent < strandedTotal) return true;
  // Patch-equivalent branch-jack: a cherry-picked / rebased copy (different SHA, missed by the
  // reachability check). `git cherry <upstream> <head> <limit>` marks such a commit `-`.
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
 * Re-read the baseline and report whether the primary checkout moved during the run. Outcomes,
 * never collapsed: - `{ drifted: false }` — it didn't move, OR there was nothing to check, OR the
 * checkout could not be read (nothing was verified, so nothing is claimed). - `{ drifted: false,
 * fastForwarded: true, … }` — HEAD moved on the SAME branch but every commit is already on that
 * branch's upstream.
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
  // Unreadable now (deleted, mid-rebase, git wedged): we verified nothing, so we report nothing
  // rather than inventing a failure.
  if (!current) return { drifted: false };
  if (current.branch === baseline.branch && current.head === baseline.head) return { drifted: false };

  // Pin the upstream to a SHA and count everything against `current.head` (the SHA captured
  // above), never the live `current.branch` — a concurrent commit or fetch on the shared checkout
  // must not make the two counts and the cherry walk read different histories. See
  // `resolveRemoteDefaultRef`.
  const ownUpstream = await resolveUpstreamSha(baseline.path, current.branch);
  const fallbackUpstream = ownUpstream ? null : await resolveRemoteDefaultRef(baseline.path);
  const upstream = ownUpstream || fallbackUpstream?.sha || null;
  const [commitCount, unpushedCount] = await Promise.all([
    countCommitsAhead(baseline.path, baseline.head, current.head),
    // Commits the branch carries that its upstream does not — the only commits a branch-jack
    // actually strands. Null (not 0) when there is no upstream to compare against, so "verified
    // clean" never masquerades as "could not check".
    upstream ? countCommitsAhead(baseline.path, upstream, current.head) : Promise.resolve(null),
  ]);

  // Skipped when the sha count already cleared the checkout: it can only agree.
  const strandedByPatch = unpushedCount === 0
    ? []
    : await listStrandedByPatch(baseline.path, { runBase: baseline.head, upstream, driftedHead: current.head });

  // Same branch, nothing local-only: the checkout was pulled forward onto commits that are already
  // upstream (reviewed, merged, pushed). Nothing was stranded, so there is nothing for a human to
  // recover.
  if (current.branch === baseline.branch && (unpushedCount === 0 || strandedByPatch?.length === 0)) {
    return { drifted: false, fastForwarded: true, baseline, current, commitCount };
  }

  // Did the baseline commit survive the run? A `git pull --rebase` on the primary REWRITES the
  // local commits it replays, orphaning the sha stamped at spawn — at which point `commitCount`
  // counts the whole post-fork history rather than the run's movement, and the prose ("16 new
  // commits") badly overstates what moved.
  const baselineRewritten = !(await isAncestorOrSame(baseline.path, baseline.head, current.head));
  const driftFacts = { baseline, current, commitCount, baselineRewritten };
  const message = formatDriftMessage(driftFacts);
  const unattributedMessage = async () => withCommitSubject(
    formatDriftMessage({ ...driftFacts, attributed: false }),
    await commitSubject(baseline.path, current.head),
  );

  // Attribution runs whenever there is (or should be) a stranded commit — a resolvable positive
  // count, OR an UNRESOLVABLE count (`null`: a pruned baseline or a wedged git), which must fail
  // OPEN rather than manufacture a failure out of a check that could not run. Prefer the
  // patch-level verdict when there is one; a resolved empty set means nothing is stranded even
  // where the sha count disagrees.
  const strandedCount = strandedByPatch
    ? strandedByPatch.length
    : (unpushedCount === null ? commitCount : unpushedCount);

  // The primary is a shared checkout, and a human running `git checkout -b my-feature` in it is
  // ordinary work — so every agent alive at that moment was failed, with a recovery note that
  // contradicted its own escalation ("No commits were stranded" under "A worktree agent committed
  // to the primary"). agent-8249579a was recorded `success: false` this way while its PR was
  // merging. With nothing stranded there is no commit to attribute by patch-id, so the one signal
  // left is WHICH branch the checkout landed on.
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
      upstreamRef: (await resolveUpstreamRef(baseline.path, current.branch)) || fallbackUpstream?.ref || null,
      upstreamIsRemoteDefault: !ownUpstream && Boolean(fallbackUpstream),
    }),
  };
}

/** Human-readable "what moved". Pure. */
export function formatDriftMessage({ baseline, current, commitCount, baselineRewritten = false, attributed = true }) {
  const branchPart = current.branch === baseline.branch
    ? `branch ${current.branch}`
    : `branch ${baseline.branch} → ${current.branch}`;
  const countPart = commitCount === null
    ? 'commit count unresolved'
    : baselineRewritten
      // The baseline is off the current history (a rebase replayed it under a new sha), so the
      // count spans the fork point, not the run. Label it as such rather than passing it off as "N
      // new commits".
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
 * The recovery advice. Names the exact commands and is explicit that the reset discards commits —
 * PortOS deliberately does not run it (see the module header).
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
  // The actionable number is what the upstream is MISSING, not how far HEAD moved — a pull that
  // also carried the agent's commit moves HEAD further than the damage goes. `strandedCount` is
  // the caller's patch-level tally when it has one; the sha counts are the fallback.
  const stranded = strandedCount === null
    ? (unpushedCount === null ? commitCount : unpushedCount)
    : strandedCount;
  const countPhrase = stranded === null ? 'commits' : `${stranded} commit${stranded === 1 ? '' : 's'}`;
  const resetTarget = upstreamRef || `origin/${current.branch}`;
  // A branch tracking something other than its own remote counterpart (a local WIP branch cut from
  // `main` tracks `origin/main`) rewinds ONTO THAT — which is most of the branch, not just the
  // drift. Say so where the reader is about to type it.
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
