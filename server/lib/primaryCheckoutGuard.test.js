/**
 * Branch-jack detector tests (#3680).
 *
 * Run against REAL git repositories in a temp dir rather than a mocked
 * `execGit`: the whole value of this module is that it reads git state
 * correctly, and a mock that returns whatever the test author expected `git
 * rev-parse` to print proves nothing about that.
 *
 * Sandboxes come from `gitTestRepo.js` (one template per worker, then copied).
 * `VITEST_FAST=1` skips the real-git describes and keeps the prose helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { execGit } from './execGit.js';
import {
  makeGitSandbox,
  attachBareOrigin,
  destroyGitSandbox,
  resetGitSandbox,
  SKIP_HEAVY_INTEGRATION,
} from './gitTestRepo.js';
import {
  capturePrimaryCheckoutState,
  detectPrimaryCheckoutDrift,
  formatDriftMessage,
  formatDriftRecovery,
  PRIMARY_CHECKOUT_MUTATED_CATEGORY,
  PRIMARY_CHECKOUT_MUTATED_REASON,
} from './primaryCheckoutGuard.js';

let repo;
let scratch;

async function commit(subject) {
  await writeFile(join(repo, `${subject.replace(/\W+/g, '-')}.txt`), subject);
  await execGit(['add', '-A'], repo);
  await execGit(['commit', '-m', subject], repo);
}

/**
 * Give `repo` a real upstream to compare against — the guard now clears movement
 * only when the branch carries nothing its upstream lacks, so the benign cases
 * are untestable without one. A bare clone on disk keeps this real git (no
 * network, no mocked `rev-parse`).
 */
async function addOrigin() {
  await attachBareOrigin(scratch, repo);
}

/**
 * Assert `branch` really has no upstream. The #4717 cases only exercise the
 * default-branch frontier when there is nothing to fall back FROM, and a stray
 * `branch.autoSetupMerge` would silently route them down the ordinary path and
 * keep passing for the wrong reason.
 */
async function expectNoUpstream(branch) {
  const result = await execGit(
    ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
    repo,
    { ignoreExitCode: true },
  );
  expect(result.exitCode).not.toBe(0);
}

/** Land a commit on the remote and fast-forward `repo` onto it, as a pull would. */
async function pullFromOrigin(subject) {
  const clone = join(scratch, `contributor-${subject.replace(/\W+/g, '-')}`);
  await execGit(['clone', join(scratch, 'origin.git'), clone], scratch);
  await execGit(['config', 'user.email', 'other@example.com'], clone);
  await execGit(['config', 'user.name', 'Other Contributor'], clone);
  await writeFile(join(clone, `${subject.replace(/\W+/g, '-')}.txt`), subject);
  await execGit(['add', '-A'], clone);
  await execGit(['commit', '-m', subject], clone);
  await execGit(['push', 'origin', 'main'], clone);
  await execGit(['pull', '--ff-only'], repo);
}

/**
 * One real sandbox per `describe`, reset in place between tests instead of
 * `fs.cp`-ing a fresh copy and recursively deleting it every time (#5902) —
 * the sandbox itself is already a cheap `cp` of a per-worker template
 * (`gitTestRepo.js`), so the remaining cost on a slow filesystem (Windows)
 * is that copy-and-delete cycle repeating once per test.
 */
function useGitSandbox() {
  let sandbox;
  beforeAll(async () => {
    sandbox = await makeGitSandbox({ prefix: 'portos-branch-jack-' });
    sandbox.initialHead = (await execGit(['rev-parse', 'HEAD'], sandbox.repo)).stdout.trim();
  });
  beforeEach(async () => {
    await resetGitSandbox(sandbox);
    ({ scratch, repo } = sandbox);
  });
  afterAll(async () => {
    await destroyGitSandbox(sandbox.scratch);
  });
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('capturePrimaryCheckoutState', () => {
  useGitSandbox();

  it('reads the current branch and HEAD', async () => {
    const state = await capturePrimaryCheckoutState(repo);
    expect(state.path).toBe(repo);
    expect(state.branch).toBe('main');
    expect(state.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns null for a missing path, a non-repo, and a non-string', async () => {
    expect(await capturePrimaryCheckoutState(join(scratch, 'nope'))).toBeNull();
    expect(await capturePrimaryCheckoutState(scratch)).toBeNull();
    expect(await capturePrimaryCheckoutState(null)).toBeNull();
    expect(await capturePrimaryCheckoutState('')).toBeNull();
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('detectPrimaryCheckoutDrift', () => {
  useGitSandbox();

  it('reports no drift when the primary checkout is untouched', async () => {
    const baseline = await capturePrimaryCheckoutState(repo);
    // Simulate the run happening entirely elsewhere: nothing touches `repo`.
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'claim/issue-1' });
    expect(verdict).toEqual({ drifted: false });
  });

  it('detects commits landed on the primary checkout when they are the agent\'s own', async () => {
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    // The agent made its two commits on its OWN worktree branch...
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('branch jacked one');
    await commit('branch jacked two');
    const agentTip = (await capturePrimaryCheckoutState(repo)).head;
    // ...and a stray `/do:pr` from the worktree applied patch-equivalent copies
    // onto the PRIMARY's main (cherry-pick → different SHAs, so only the patch-id
    // gate attributes them — a raw-SHA check would miss this).
    await execGit(['checkout', 'main'], repo);
    await execGit(['cherry-pick', `${baseline.head}..${agentTip}`], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    expect(verdict.reason).toBe(PRIMARY_CHECKOUT_MUTATED_REASON);
    expect(verdict.category).toBe(PRIMARY_CHECKOUT_MUTATED_CATEGORY);
    expect(verdict.commitCount).toBe(2);
    // The message names the drifted branch and the commit count...
    expect(verdict.message).toContain('main');
    expect(verdict.message).toContain('2 new commits');
    // ...and the fix names the agent branch plus the exact recovery command.
    expect(verdict.suggestedFix).toContain(agentBranch);
    expect(verdict.suggestedFix).toContain(`git -C ${repo} reset --hard origin/main`);
  });

  it('does NOT blame the agent for a stranded commit it did not author (unattributed)', async () => {
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    // The agent's own branch carries an UNRELATED commit of its own...
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('the agent\'s actual work');
    await execGit(['checkout', 'main'], repo);
    // ...while a different actor stranded a commit on the primary's main.
    await commit('someone else\'s commit');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    // Stranded, but no patch-equivalent on the agent branch → surfaced, not failed.
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.unpushedCount).toBe(1);
    expect(verdict.message).toContain('main');
    expect(verdict.suggestedFix).toBeUndefined();
  });

  it('does not let a stranded MERGE commit inflate attribution into a false positive', async () => {
    // A human `git merge` / non-ff pull strands `merge + N` commits on the primary,
    // but `git cherry` only ever walks the N non-merge commits. Counting the merge
    // among the stranded set would make `stranded > foreign` true on arithmetic
    // alone and re-blame the agent for a merge it never made.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    // The agent has a genuine commit of its own (passes the own-commits gate)...
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('the agent\'s own work');
    // ...while a foreign branch is merged into the primary's main (non-ff → a merge
    // commit), none of it patch-equivalent to the agent's commit.
    await execGit(['checkout', 'main'], repo);
    await execGit(['checkout', '-b', 'a-foreign-branch'], repo);
    await commit('a foreign commit');
    await execGit(['checkout', 'main'], repo);
    await execGit(['merge', '--no-ff', '-m', 'Merge a-foreign-branch', 'a-foreign-branch'], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
  });

  it('does not blame an agent that inherited the primary\'s pre-run unpushed commit (#3703 regression)', async () => {
    // The primary already carried an unpushed commit at spawn, and the agent branch
    // was cut from that HEAD (so it "inherits" that commit) while the agent committed
    // NOTHING. A foreign actor then strands its own commit during the run. Anchoring
    // attribution at the branch upstream would count the inherited commit as stranded
    // yet omit it from the foreign tally (same SHA) — flipping stranded > foreign and
    // failing a read-only agent. Anchoring at the run baseline excludes it.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    await commit('primary local unpushed commit'); // on main, ahead of origin/main
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['branch', agentBranch], repo); // agent branch at the inherited HEAD, no own commits
    await commit('a foreign actor\'s commit'); // strands during the run

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    // Both the inherited and the foreign commit are unpushed, but neither is the agent's.
    expect(verdict.unpushedCount).toBe(2);
  });

  it('does not blame the agent for a shared upstream commit a pull brought in mid-run (#3703 regression)', async () => {
    // The primary was BEHIND origin at spawn; the agent branch was cut from the newer
    // origin (so it carries the shared commit R); during the run the primary pulls R and
    // a foreign actor also strands F. R is on both the upstream and the agent branch, so
    // `git cherry` omits it — anchoring only at the run baseline would still count it and
    // blame the agent. Excluding upstream commits leaves F alone, which isn't the agent's.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const contributor = join(scratch, 'contributor-shared');
    await execGit(['clone', join(scratch, 'origin.git'), contributor], scratch);
    await execGit(['config', 'user.email', 'other@example.com'], contributor);
    await execGit(['config', 'user.name', 'Other Contributor'], contributor);
    await writeFile(join(contributor, 'shared-R.txt'), 'shared upstream R');
    await execGit(['add', '-A'], contributor);
    await execGit(['commit', '-m', 'shared upstream R'], contributor);
    await execGit(['push', 'origin', 'main'], contributor);
    await execGit(['fetch', 'origin'], repo);
    await execGit(['branch', agentBranch, 'origin/main'], repo); // agent branch carries R
    const baseline = await capturePrimaryCheckoutState(repo); // primary still BEHIND, at the initial commit
    await execGit(['merge', '--ff-only', 'origin/main'], repo); // the run pulls R onto the primary
    await commit('a foreign actor commit'); // ...and a foreign commit strands alongside it

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
  });

  it('does not blame an agent that REBASED onto a commit another actor put on main (#3725)', async () => {
    // Observed on agent-c925dbfb: a foreign actor committed F to the primary's main
    // mid-run; the agent then rebased its worktree branch onto the moved main (what
    // `/do:pr` does before pushing) and added its own commit on top. F is now reachable
    // from the agent's branch tip, so excluding that tip drops the stranded count to
    // zero and the reachability check reads the INHERITED BASE as proof of authorship.
    // The agent built on F; it did not put F there.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    // A foreign actor strands F on the primary's main during the run...
    await commit('a foreign actor\'s commit F');
    const drifted = (await capturePrimaryCheckoutState(repo)).head;
    // ...and the agent's branch is cut from the moved main (equivalently: rebased onto
    // it) and carries its own work on top.
    await execGit(['checkout', '-b', agentBranch, drifted], repo);
    await commit('the agent\'s actual work');
    await execGit(['checkout', 'main'], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.unpushedCount).toBe(1);
    expect(verdict.suggestedFix).toBeUndefined();
  });

  it('still catches a jack whose commits sit at the agent branch tip (#3725 must not over-clear)', async () => {
    // The #3680 shape: the agent's own commits were applied to main, leaving the primary
    // AT the agent's branch tip — not strictly behind it. The rebase escape hatch above
    // keys on STRICTLY ahead, so this must remain a failure.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('the agent\'s own work');
    const agentTip = (await capturePrimaryCheckoutState(repo)).head;
    // A stray `/do:pr` fast-forwards the PRIMARY's main onto the agent's commit.
    await execGit(['checkout', 'main'], repo);
    await execGit(['merge', '--ff-only', agentTip], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    expect(verdict.reason).toBe(PRIMARY_CHECKOUT_MUTATED_REASON);
  });

  it('clears a commit whose content merged upstream under a REBASED sha (#3744)', async () => {
    // The observed false failure on agent-347b0ca0, whose PR had already MERGED.
    // PortOS rebase-merges PRs, so the merged commit's sha on origin/main differs
    // from the copy a local `merge --ff-only` put on the primary. The sha-only
    // upstream exclusion read that copy as unpushed, and the patch-id attribution
    // then matched it against the agent's branch — which carried the same upstream
    // commit only because `/do:pr` rebased onto it. Nothing was ever stranded.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    // A commit that will merge upstream, sitting on a sibling branch for now.
    await execGit(['checkout', '-b', 'sibling-work'], repo);
    await commit('a commit that merges via PR');
    const sharedCommit = (await capturePrimaryCheckoutState(repo)).head;
    // The agent's branch carries its own patch-equivalent copy of that commit (what
    // a `/do:pr` rebase leaves behind) plus its own real work.
    await execGit(['checkout', '-b', agentBranch, 'main'], repo);
    await execGit(['cherry-pick', sharedCommit], repo);
    // The copy's own sha — identical to `sharedCommit` only when the cherry-pick
    // landed inside the same committer-timestamp second. `sibling-work` is never
    // pushed, so this branch is the ONLY route by which the patch reaches origin;
    // the contributor below must cherry-pick this sha, not `sharedCommit`, or the
    // clone hits `fatal: bad object` whenever the two straddle a second boundary.
    const agentCopy = (await capturePrimaryCheckoutState(repo)).head;
    await commit('the agent\'s actual work');
    await execGit(['push', 'origin', agentBranch], repo);
    await execGit(['checkout', 'main'], repo);

    const baseline = await capturePrimaryCheckoutState(repo);
    // Mid-run: the primary fast-forwards onto the sibling branch's copy...
    await execGit(['merge', '--ff-only', 'sibling-work'], repo);
    // ...and the PR rebase-merges upstream, landing a THIRD sha with the same patch.
    const contributor = join(scratch, 'contributor-rebase-merge');
    await execGit(['clone', join(scratch, 'origin.git'), contributor], scratch);
    await execGit(['config', 'user.email', 'other@example.com'], contributor);
    await execGit(['config', 'user.name', 'Other Contributor'], contributor);
    await execGit(['cherry-pick', agentCopy], contributor);
    await execGit(['push', 'origin', 'main'], contributor);
    await execGit(['fetch', 'origin'], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    // Its content is upstream, so there is nothing to recover and nothing to blame.
    expect(verdict.drifted).toBe(false);
    expect(verdict.fastForwarded).toBe(true);
    expect(verdict.suggestedFix).toBeUndefined();
    // The sha comparison alone still calls it unpushed — which is exactly why the
    // patch-level verdict has to be the one that decides.
    expect(await execGit(['rev-list', '--count', 'main', '^origin/main'], repo)
      .then(r => Number(r.stdout.trim()))).toBe(1);
  });

  it('still reports a genuinely unpushed commit that no upstream copy clears (#3744 must not over-clear)', async () => {
    // The guard rail on the test above: patch-equivalence may only clear a commit
    // the upstream ACTUALLY has. An agent's own commit that never merged has no
    // copy on origin/main, so it stays a failure.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('never merged anywhere');
    const agentTip = (await capturePrimaryCheckoutState(repo)).head;
    await execGit(['checkout', 'main'], repo);
    await execGit(['cherry-pick', agentTip], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    expect(verdict.reason).toBe(PRIMARY_CHECKOUT_MUTATED_REASON);
    expect(verdict.suggestedFix).toContain('1 commit ');
  });

  /**
   * Put `repo`'s current HEAD content upstream under a DIFFERENT sha, the way a
   * rebase-merged PR does: push it to a scratch remote branch, then have a
   * contributor cherry-pick that onto `main` and push. Leaves `repo` fetched.
   */
  async function mergeHeadUpstreamRebased(label) {
    const slug = label.replace(/\W+/g, '-');
    await execGit(['push', 'origin', `HEAD:refs/heads/pr-${slug}`], repo);
    const contributor = join(scratch, `contributor-${slug}`);
    await execGit(['clone', join(scratch, 'origin.git'), contributor], scratch);
    await execGit(['config', 'user.email', 'other@example.com'], contributor);
    await execGit(['config', 'user.name', 'Other Contributor'], contributor);
    await execGit(['cherry-pick', `origin/pr-${slug}`], contributor);
    await execGit(['push', 'origin', 'main'], contributor);
    await execGit(['fetch', 'origin'], repo);
  }

  it('does not blame an agent whose branch MERGED for the primary\'s own upstream copies (#4098)', async () => {
    // The observed false failure. The primary sat on a human's local WIP branch that
    // TRACKS `origin/main` (no remote branch of its own), carrying commits that are
    // unpushed by design. The agent's PR then merged, which makes its branch an
    // ancestor of `origin/main` — at which point "patch-equivalent to the agent's
    // branch" is indistinguishable from "patch-equivalent to anything in main's
    // history", and the primary's own local copy of already-merged work reads as the
    // agent's branch-jack. Attribution has to ask only about the STRANDED commits,
    // which by construction have no patch-equivalent upstream.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    await execGit(['checkout', '-b', 'fix/wip', '--track', 'origin/main'], repo);
    await commit('human wip, never pushed');

    const baseline = await capturePrimaryCheckoutState(repo);
    // During the run the human commits work that ALSO lands upstream via a PR (rebase
    // -merged, so origin/main carries a patch-equivalent under a different sha)...
    await commit('human work that also lands upstream');
    await mergeHeadUpstreamRebased('lands-upstream');
    // ...and a commit that lands nowhere, which is the only genuinely stranded one.
    await commit('human work that stays local');
    // The agent's own PR merged too, so its branch is now an ancestor of origin/main.
    await execGit(['branch', agentBranch, 'origin/main'], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.suggestedFix).toBeUndefined();
  });

  it('does not read a rewritten baseline as proof every patch-equivalent commit is new (#4098)', async () => {
    // The fallback path (no upstream to compare against) keeps a pre-run copy out of
    // the attributed set by asking "is this commit an ancestor of the run baseline?".
    // A mid-run rewrite on the primary — `pull --rebase`, an amend, an interactive
    // rebase — orphans that baseline, so NOTHING on the current history is an ancestor
    // of it and the filter answers "created during the run" for every commit, whenever
    // it was really made. The run is surfaced (warn-logged) rather than failed, per the
    // module's fail-open contract for a check that could not run.
    const agentBranch = 'cos/task-x/agent-y';
    // A PRE-RUN copy of the agent branch's work already sits on the primary's main.
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('the agent\'s work');
    const agentTip = (await capturePrimaryCheckoutState(repo)).head;
    await execGit(['checkout', 'main'], repo);
    await execGit(['cherry-pick', agentTip], repo);
    const baseline = await capturePrimaryCheckoutState(repo);
    // Mid-run the human rewords that commit, rewriting its sha (same patch) and
    // orphaning the baseline stamped at spawn.
    await execGit(['commit', '--amend', '-m', 'reworded by the human mid-run'], repo);
    expect(await execGit(['merge-base', '--is-ancestor', baseline.head, 'HEAD'], repo,
      { ignoreExitCode: true }).then(r => r.exitCode)).not.toBe(0);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
  });

  it('names the branch\'s REAL upstream in the recovery command, not origin/<branch> (#4098)', async () => {
    // `fix/wip` tracks `origin/main` and has no remote branch of its own, so the old
    // hardcoded `origin/fix/wip` named a ref that does not exist — the "recovery"
    // command errors out, and correcting it to the real upstream discards the human's
    // unpushed commits along with the agent's.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    await execGit(['checkout', '-b', 'fix/wip', '--track', 'origin/main'], repo);
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('the agent\'s own work');
    const agentTip = (await capturePrimaryCheckoutState(repo)).head;
    await execGit(['checkout', 'fix/wip'], repo);
    await execGit(['cherry-pick', agentTip], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    expect(verdict.suggestedFix).toContain(`git -C ${repo} reset --hard origin/main`);
    expect(verdict.suggestedFix).not.toContain('origin/fix/wip');
    // ...and it warns that the reset rewinds onto a ref that is not this branch.
    expect(verdict.suggestedFix).toContain('tracks `origin/main`');
  });

  it('does not quote a commit count spanning a baseline a mid-run rebase rewrote (#3744)', async () => {
    // `git pull --rebase` on the primary replays its local commits under new shas,
    // orphaning the baseline stamped at spawn. `rev-list ^baseline` then counts the
    // whole post-fork history — the incident reported "16 new commits" for a run
    // that stranded none. The prose must not pass that number off as movement.
    await addOrigin();
    await commit('primary local unpushed one');
    await commit('primary local unpushed two');
    const baseline = await capturePrimaryCheckoutState(repo);
    // A contributor lands upstream, and the primary pulls --rebase over it, which
    // rewrites BOTH local commits and orphans `baseline.head`.
    const contributor = join(scratch, 'contributor-rebased-baseline');
    await execGit(['clone', join(scratch, 'origin.git'), contributor], scratch);
    await execGit(['config', 'user.email', 'other@example.com'], contributor);
    await execGit(['config', 'user.name', 'Other Contributor'], contributor);
    await writeFile(join(contributor, 'landed-upstream.txt'), 'landed upstream');
    await execGit(['add', '-A'], contributor);
    await execGit(['commit', '-m', 'landed upstream'], contributor);
    await execGit(['push', 'origin', 'main'], contributor);
    await execGit(['pull', '--rebase'], repo);
    expect(await execGit(['merge-base', '--is-ancestor', baseline.head, 'HEAD'], repo,
      { ignoreExitCode: true }).then(r => r.exitCode)).not.toBe(0);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'cos/task-x/agent-y' });
    expect(verdict.message).toContain('baseline rewritten by a rebase');
    expect(verdict.message).not.toMatch(/\d+ new commits/);
  });

  it('never attributes a branch-jack to a read-only reasoner that never branched (Case A)', async () => {
    const baseline = await capturePrimaryCheckoutState(repo);
    // A 24-file commit lands on main mid-run, authored by another actor.
    await commit('a big commit from elsewhere');

    // The reasoner carried no worktree branch at all — it is structurally
    // impossible for it to have authored the commit, so it must not be blamed.
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: null });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.commitCount).toBe(1);
  });

  it('never attributes when the agent branch has zero commits of its own', async () => {
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    // Branch exists but points at the same commit as origin/main — no own commits.
    await execGit(['branch', agentBranch, 'origin/main'], repo);
    const baseline = await capturePrimaryCheckoutState(repo);
    await commit('a commit from another actor');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
  });

  it('degrades to unattributed when the agent branch cannot be resolved', async () => {
    await addOrigin();
    const baseline = await capturePrimaryCheckoutState(repo);
    await commit('stranded by an unknown actor');

    // A branch name that resolves to nothing is uncertainty, not proof — fail open.
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'cos/never-created' });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
  });

  it('detects a branch switch onto the agent\'s OWN worktree branch, advising checkout not reset', async () => {
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    await execGit(['push', 'origin', `main:${agentBranch}`], repo);
    const baseline = await capturePrimaryCheckoutState(repo);
    // Only the agent parks the shared primary on the agent's own branch, so this
    // stays a failure even though nothing was stranded to recover — and the
    // recovery is the benign `git checkout`, with nothing to discard.
    await execGit(['checkout', '-b', agentBranch, '--track', `origin/${agentBranch}`], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    expect(verdict.commitCount).toBe(0);
    expect(verdict.unpushedCount).toBe(0);
    expect(verdict.message).toContain(`main → ${agentBranch}`);
    expect(verdict.suggestedFix).toContain(`git -C ${repo} checkout main`);
    expect(verdict.suggestedFix).not.toContain('reset --hard');
  });

  it('does not fail a run for a branch switch it did not make (#4231)', async () => {
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    await execGit(['branch', agentBranch, 'origin/main'], repo);
    const baseline = await capturePrimaryCheckoutState(repo);
    // The HUMAN starts a feature branch in the shared primary mid-run and pushes
    // it, so nothing at all is stranded. This used to skip attribution ENTIRELY
    // and record the run `success: false` with an escalation to a human, under a
    // recovery note that contradicted it ("No commits were stranded").
    await execGit(['checkout', '-b', 'my-feature'], repo);
    await commit('the human\'s own work');
    await execGit(['push', '-u', 'origin', 'my-feature'], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.unpushedCount).toBe(0);
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    // Still surfaced: the next spawn baselines against wherever the primary is.
    expect(verdict.message).toContain('main → my-feature');
    expect(verdict.suggestedFix).toBeUndefined();
  });

  it('does not fail a run for an UNPUSHED branch the human started mid-run (#4231)', async () => {
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    await execGit(['branch', agentBranch, 'origin/main'], repo);
    const baseline = await capturePrimaryCheckoutState(repo);
    // Same shape, no upstream on the new branch — the human's commit IS stranded,
    // but it is not patch-equivalent to anything on the agent's branch.
    await execGit(['checkout', '-b', 'my-feature'], repo);
    await commit('the human\'s own work');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
  });

  it('does not fail a run for a branch switch when it carried no branch at all (#4231)', async () => {
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['checkout', '-b', 'someone-elses-branch'], repo);

    // A read-only reasoner never branched, so it cannot have moved the checkout.
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: null });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.commitCount).toBe(0);
    expect(verdict.message).toContain('main → someone-elses-branch');
  });

  it('clears a plain pull: HEAD moved but every commit is already upstream', async () => {
    await addOrigin();
    const baseline = await capturePrimaryCheckoutState(repo);
    await pullFromOrigin('landed via a merged PR');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'cos/task-x/agent-y' });
    // The false failure this guard used to raise (#3702 follow-up): the commit is
    // origin/main's, so `reset --hard origin/main` would have been a no-op the
    // user was told to consider.
    expect(verdict.drifted).toBe(false);
    expect(verdict.fastForwarded).toBe(true);
    expect(verdict.commitCount).toBe(1);
    expect(verdict.message).toBeUndefined();
  });

  it('still reports the agent\'s own commit when a pull landed alongside it', async () => {
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    // The agent's real commit lives on its own branch...
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('branch jacked');
    const agentTip = (await capturePrimaryCheckoutState(repo)).head;
    await execGit(['checkout', 'main'], repo);
    // ...a pull brought an unrelated merged commit onto main...
    await pullFromOrigin('landed via a merged PR');
    // ...and the agent's own commit was (wrongly) applied to main too.
    await execGit(['cherry-pick', agentTip], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    // HEAD moved 2, but only 1 is stranded — the recovery prose quotes the
    // stranded count, not the movement.
    expect(verdict.commitCount).toBe(2);
    expect(verdict.unpushedCount).toBe(1);
    expect(verdict.suggestedFix).toContain('1 commit ');
    expect(verdict.suggestedFix).toContain(`git -C ${repo} reset --hard origin/main`);
  });

  it('reports an attributed commit on a branch with no upstream to clear it against', async () => {
    // No `origin` at all: an unpushed commit is unreviewed by definition, so the
    // guard must not go quiet just because it cannot compare against an upstream —
    // it attributes against the run baseline instead. The commit IS the agent's.
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('branch jacked, nowhere to push');
    await execGit(['checkout', 'main'], repo);
    await execGit(['merge', '--ff-only', agentBranch], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    expect(verdict.unpushedCount).toBeNull();
    expect(verdict.commitCount).toBe(1);
  });

  it('does not blame a MERGED agent for main\'s history when the baseline sits behind main (#4717)', async () => {
    // The production shape, exactly: the primary was parked on `release` (behind
    // `main`) at spawn, the agent branched from `main` and its PR MERGED during the
    // run, and the human then cut an UNPUSHED feature branch off `main` in the
    // shared primary. With no upstream on that branch the guard used to have no
    // pushed frontier, so every commit since the `release` baseline read as
    // stranded — and all of `main` is on a merged agent's branch, so attribution
    // matched and the run was failed for the contents of `main`.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    // `release` lags `main` by a commit that IS pushed and reviewed.
    await execGit(['branch', 'release', 'origin/main'], repo);
    await pullFromOrigin('shipped on main after release was cut');
    await execGit(['checkout', 'release'], repo);
    const baseline = await capturePrimaryCheckoutState(repo);
    expect(baseline.branch).toBe('release');

    // The agent's branch carries `main` (its PR merged), so it is an ANCESTOR of
    // the primary's head — the shape that reads as maximal proof of authorship.
    await execGit(['branch', agentBranch, 'origin/main'], repo);
    // The human's mid-run feature branch: cut from the LOCAL `main` and never
    // pushed, so it has no upstream. `--no-track` pins that regardless of the
    // running machine's `branch.autoSetupMerge`; production got there by cutting
    // from a local branch, which does not auto-track under the default config.
    await execGit(['checkout', 'main'], repo);
    await execGit(['checkout', '--no-track', '-b', 'my-feature'], repo);
    await commit('the human\'s own work');
    await expectNoUpstream('my-feature');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.message).toContain('release → my-feature');
  });

  it('still catches a real jack onto a no-upstream branch cut from main (#4717 must not over-clear)', async () => {
    // Same no-upstream branch and the same lagging baseline, but this time the
    // stranded commit is the AGENT'S. The default-branch frontier only clears
    // content the remote already has, so it must not clear this one.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    await execGit(['branch', 'release', 'origin/main'], repo);
    await pullFromOrigin('shipped on main after release was cut');
    await execGit(['checkout', 'release'], repo);
    const baseline = await capturePrimaryCheckoutState(repo);

    await execGit(['checkout', '--no-track', '-b', agentBranch, 'main'], repo);
    await commit('the agent\'s real work');
    const agentTip = (await capturePrimaryCheckoutState(repo)).head;
    await execGit(['checkout', 'main'], repo);
    await execGit(['checkout', '--no-track', '-b', 'my-feature'], repo);
    await execGit(['cherry-pick', agentTip], repo);
    await expectNoUpstream('my-feature');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    // The frontier cleared `main`'s own commit, so only the jacked one is stranded.
    expect(verdict.suggestedFix).toContain('1 commit ');
    // And the reset target is a ref that EXISTS, not `origin/my-feature` (#4098).
    expect(verdict.suggestedFix).toContain(`git -C ${repo} reset --hard origin/main`);
    expect(verdict.suggestedFix).toContain('has no upstream of its own');
  });

  it('reports no drift when there is nothing to check', async () => {
    expect(await detectPrimaryCheckoutDrift(null)).toEqual({ drifted: false });
    expect(await detectPrimaryCheckoutDrift({ path: repo })).toEqual({ drifted: false });
    // A checkout that vanished mid-run verified nothing, so it must not
    // manufacture a failure.
    const baseline = await capturePrimaryCheckoutState(repo);
    await rm(repo, { recursive: true, force: true });
    expect(await detectPrimaryCheckoutDrift(baseline)).toEqual({ drifted: false });
  });

  it('fails OPEN (unattributed, not a failure) when the stranded count is unresolvable', async () => {
    // A pruned/rewritten baseline commit or a wedged git leaves the stranded count
    // null — a check that could not run. Attribution cannot confirm the agent
    // authored anything, so the guard surfaces the movement without manufacturing a
    // failure out of it (the module's fail-open contract).
    const baseline = { path: repo, branch: 'main', head: 'f'.repeat(40) };
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'cos/task-x/agent-y' });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.commitCount).toBeNull();
    expect(verdict.message).toContain('commit count unresolved');
  });
});

describe('prose helpers', () => {
  const baseline = { path: '/example/repo', branch: 'main', head: 'a'.repeat(40) };
  const current = { path: '/example/repo', branch: 'main', head: 'b'.repeat(40) };

  it('singularizes a one-commit drift', () => {
    expect(formatDriftMessage({ baseline, current, commitCount: 1 })).toContain('(1 new commit)');
    expect(formatDriftRecovery({ current, commitCount: 1, agentBranch: null })).toContain('1 commit ');
  });

  it('falls back to origin/<branch> only when no upstream was resolved', () => {
    expect(formatDriftRecovery({ current, commitCount: 1, agentBranch: null }))
      .toContain('reset --hard origin/main');
    expect(formatDriftRecovery({ current, commitCount: 1, agentBranch: null, upstreamRef: 'upstream/trunk' }))
      .toContain('reset --hard upstream/trunk');
  });

  it('never tells the user PortOS already fixed it', () => {
    const fix = formatDriftRecovery({ current, commitCount: 3, agentBranch: 'claim/issue-3680' });
    expect(fix).toContain('DISCARDS');
    expect(fix).toContain('PortOS will not run it for you');
  });
});
