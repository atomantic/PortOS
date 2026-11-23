import { buildAutoMergeHandoffInstructions, MANAGED_WORKTREE_CLEANUP_CONTRACT } from '../../lib/mergeGateContract.js';
import { forgeDispatchLabels } from '../../lib/dispatchLabels.js';
import { RECONCILE_AGENT_ID_PLACEHOLDER } from '../../lib/claimContinuation.js';
import { agentApiCurl } from '../../lib/agent/agentApiToken.js';
import { localApiBaseUrl } from '../../lib/networkExposure.js';
import { getIssueDispatchHint } from '../github.js';
import { issueNumberFromRef } from '../issueReconcile.js';
import { ledgerPath, recordVerdictInstruction } from '../supersededLedger.js';

/** An action is ON unless the config explicitly set it to false (opt-out). */
export const actionOn = (actions, key) => actions?.[key] !== false;

/**
 * Which in-flight branches have an enabled action? Pure — drives both the
 * drain gate (dispatch nothing when empty → park) and the prompt payload.
 * @param {object[]} inFlight - reconcile()'s inFlight entries (with `state`)
 * @param {object} actions - the per-app action toggles
 */
export function filterActionable(inFlight, actions) {
  return inFlight.filter((b) => {
    if (b.openPr?.isDraft) return false;
    if (b.state === 'ABANDONED_WIP') return actionOn(actions, 'finishAbandoned');
    if (b.state === 'NEEDS_PR') return actionOn(actions, 'openPr');
    if (b.state === 'CONFLICTED') return actionOn(actions, 'resolveConflicts');
    if (b.state === 'IN_REVIEW') return actionOn(actions, 'resolveConflicts') || actionOn(actions, 'autoMerge');
    return false;
  });
}

// A branch is only worth finishing if its work is still NEEDED. Anything that
// sat while the default branch moved may hold a feature that was since solved a
// different way there — merging it then REGRESSES the default branch instead of
// adding to it, and it is the one failure a "verify the work is complete" gate
// cannot catch, because the work IS complete; it is just no longer wanted.
//
// The tell is never `git status` or the branch's own changelog entry — both read
// as healthy WIP. It is the collision set: the files this branch touches that the
// default branch has also changed since they diverged. So the deterministic pass
// hands the agent that list, and this gate makes reading it step one, BEFORE any
// commit, rebase, or conflict resolution. Resolving a conflict is the trap —
// mechanically reconcilable and semantically wrong, it launders a regression into
// a merge that looks intentional.
//
// Precedent: a branch 101 commits behind held "merge a task's PR on green CI when
// no reviewer is configured", whose collision files (agentWorktreeCleanup.js,
// the CoS constants) had meanwhile grown a strictly richer three-way completion
// policy on the default branch. Its tests passed and its changelog entry read
// fine; only the collision files showed it had been superseded.
const supersessionGate = ({ collisionPaths = [], behind } = {}) => {
  const drift = typeof behind === 'number' && behind > 0
    ? `This branch is ${behind} commit(s) behind the default branch.`
    : 'This branch may have drifted from the default branch.';
  if (!collisionPaths.length) {
    return `${drift} Nothing it touches has changed on the default branch since it diverged, so supersession is unlikely — but if a rebase does surface a conflict, treat it as the signal below rather than something to mechanically resolve.`;
  }
  // The full set already has its own line in the prompt block; the prose needs
  // only enough to make the instruction concrete. Collisions are ranked
  // signal-first, so the head of the list is the part worth naming inline.
  const shown = collisionPaths.slice(0, 6);
  const more = collisionPaths.length > shown.length ? ` (+${collisionPaths.length - shown.length} more, listed above)` : '';
  return [
    `${drift} **Before anything else, check the work is still needed.**`,
    `The default branch has ALSO changed these files since this branch diverged: ${shown.map((p) => `\`${p}\``).join(', ')}${more}.`,
    'For each, read the default branch\'s current version and compare it to what this branch does there. You are looking for one thing: has the default branch already solved this branch\'s problem, by any means? A differently-named function, a policy object where this branch has a boolean, a scheduled tick where this branch has a watcher — all count. It does not need to look like this branch\'s approach to have replaced it.',
    'If it HAS been solved there, this branch is SUPERSEDED: stop, do not commit, rebase, resolve, or merge anything, and report it as superseded naming the file(s) and what on the default branch replaced it. Merging it would undo work already shipped. Say so plainly rather than resolving the conflict — a conflict you can resolve is exactly how a regression gets in looking deliberate.',
    recordVerdictInstruction(ledgerPath()),
    'Recording the verdict is the handoff to this scheduled task\'s deterministic cleanup pass. It backs up the branch commits, tracked diff, and untracked files, then removes the worktree and branch in the completion cleanup pass (without waiting for another scheduled run). Do not describe the surviving branch as work a human must clean up, and do not write the verdict anywhere except the absolute ledger path above — a ledger inside the abandoned worktree is invisible to the running PortOS instance and leaves the branch stranded.',
    'Only once you have confirmed the work is still needed, continue.'
  ].join(' ');
};

// Verify before publication without rewriting a branch just because the base
// advanced. Conflicts, enforced policy and concrete integration risk still need
// recovery followed by fresh validation on the resulting head.
const verifyGate = 'Fetch the default branch for comparison before opening or updating a PR; inspect semantic overlap and supersession. Rebase only for actual conflicts, an enforced up-to-date branch policy, or evidenced integration risk. Base movement alone does not require a rebase or another CI run; this overrides mandatory base-sync instructions in delegated slashdo workflows. Run the test suites for the workspaces the diff touches (`cd server && npm test`, `cd client && npm test`) plus lint, and read the result. After changing the head, rerun affected validation and required reviews/checks. If anything fails, fix it on the branch and re-run; if you cannot get it green, stop and report which suite fails and why. Never push a branch whose tests you have not seen pass.';

// A measured backlog and durable server receipt can transfer pending CI.
// Immediate merges still require the current-head CI and ownership gates.
// `pr` is the PR's number when the branch already has one, else the `<num>`
// placeholder the agent fills in after opening it.
// Exported so the per-agent repo-state audit (services/agent/agentRepoStateVerification.js)
// hands a recovery agent the SAME merge procedure, rather than re-authoring a
// `gh pr merge` line that loses these caveats.
export const driveToMerge = (pr, { mergeHandoff = false } = {}) => [
  buildAutoMergeHandoffInstructions(pr, { mergeHandoff }),
  'Opening (or approving) the PR is NOT the end state — a green PR left open is still an unfinished branch that this task will simply re-drive on its next run.',
  'A conflict-free branch with passing current-head required checks and satisfied configured reviews may merge behind the default branch. Base movement alone does not require rebasing or restarting CI.',
  `Wait for CI in-session by re-polling \`gh pr checks ${pr} --required\` every 30s so the run stays observable while CI is pending. \`no required checks reported\` right after the PR opens is late registration of an aggregator check, not an empty requirement set: read the branch rulesets (\`gh api --paginate repos/<owner>/<repo>/rules/branches/<base>\`) and classic protection before concluding nothing is required, and keep re-polling while either requires a check. Retain ownership while CI is pending unless the server accepts an exact-head backlog handoff; elapsed waiting time alone is not completion.`,
  'If a required check FAILS, fix it on the branch, push, and re-poll (max 3 rounds); if it is still red after that, leave the PR open and report exactly which check failed.',
  'Record the exact local branch head whose checks and configured reviews passed as <verified-head>; immediately before merging, repeat the ownership/policy Recheck and require the forge PR head to equal that same head. If either changed, stop and revalidate. Every merge attempt, including a method retry, must retain --match-head-commit <verified-head>.',
  `Once every required check is green AND the PR is MERGEABLE, merge without implicit local teardown: \`gh pr merge ${pr} --merge --match-head-commit <verified-head>\`. On a disallowed method retry with \`gh pr merge ${pr} --squash --match-head-commit <verified-head>\`, then \`gh pr merge ${pr} --rebase --match-head-commit <verified-head>\`. Never \`--auto\`: a queued merge outlives this run.`,
  MANAGED_WORKTREE_CLEANUP_CONTRACT,
].join(' ');

/**
 * Per-state instruction to the coordinator/sub-agent.
 * @param {string} state
 * @param {object} actions - per-app action toggles
 * @param {{ prNumber?: number, worktreePath?: string, collisionPaths?: string[], behind?: number }} [ctx]
 *   the branch's open PR number (when it has one), its worktree path
 *   (ABANDONED_WIP needs it — the uncommitted work only exists there, never in
 *   the primary checkout), and the drift facts feeding the supersession gate
 */
export function desiredEndState(state, actions, { prNumber, worktreePath, collisionPaths, behind, mergeHandoff = false } = {}) {
  const pr = prNumber ? String(prNumber) : '<num>';
  const stillNeeded = supersessionGate({ collisionPaths, behind });
  if (state === 'ABANDONED_WIP') {
    // The branch has NO commits of its own — the entire deliverable is the
    // uncommitted tree. So the first move is to READ it, and the loudest rule is
    // "don't commit a half-finished tree": an agent that died mid-edit can leave
    // a syntactically-broken file, and committing that is strictly worse than
    // leaving it for a human, since it converts recoverable scratch state into
    // branch history.
    const where = worktreePath ? `\`${worktreePath}\`` : 'the branch\'s worktree';
    const assess = `This branch has no commits of its own — its work is sitting UNCOMMITTED in ${where}, the worktree of a CoS agent that is no longer running (it exited, crashed, or was reaped before committing). Nothing is lost, but nothing lands either until you finish it. Working INSIDE that worktree, run \`git status\` and \`git diff\` (plus inspect every untracked file) and read the WHOLE change set before touching anything. Recover the intended deliverable from the task/issue context, the diff, and its tests; then finish incomplete code, remove stubs/TODOs/placeholders, repair half-renamed symbols, and run the touched workspaces' test suites. Do not merely inventory unfinished work and leave it for another run.`;
    const bail = 'If the work is still needed but you genuinely cannot finish it because required intent, credentials, or an external dependency is unavailable, preserve it and report the concrete blocker. That is the exceptional blocked outcome, not the default for an incomplete diff.';
    const commit = 'If it IS finished, commit it on this branch (a message that states what changed and why — never a bare "wip"), then ship it with `/do:pr --no-merge` (by hand, if slash commands are unavailable: self-review the diff, `git push -u origin <branch>`, then `gh pr create` with a Summary + Test plan).';
    if (!actionOn(actions, 'autoMerge')) {
      return `${stillNeeded} ${assess} ${bail} ${commit} ${verifyGate} Do NOT merge (auto-merge is disabled) — stop once the PR is open and report its URL.`;
    }
    return `${stillNeeded} ${assess} ${bail} ${commit} ${verifyGate} ${driveToMerge(pr, { mergeHandoff })}`;
  }
  if (state === 'NEEDS_PR') {
    const verify = `${stillNeeded} Verify the branch's work is complete and ready (tests pass, no stubs/TODO markers). If it is incomplete, finish it on this branch and verify the completed behavior; do not merely report it for another run, and do not open a half-baked PR. Preserve it without shipping only when required intent, credentials, or an external dependency makes completion genuinely impossible, and report that concrete blocker.`;
    // `--no-merge` is passed explicitly on BOTH paths — not to disable merging,
    // but to keep the merge decision here rather than inside slashdo. Under
    // `--merge`, /do:pr first tries GitHub-native auto-merge and reports the PR
    // as "queued", ending the run with CI still pending — the same unattended
    // exit this whole change exists to close. So /do:pr runs its reviewer loop
    // and opens the PR; the merge gate below is what finishes the branch. The
    // flag is also stated explicitly so this machine's saved slashdo defaults
    // (which may set `merge: true`) can't decide it either way.
    const openPr = '`/do:pr --no-merge` — its reviewer loop runs, and the PR is left for the gate below rather than queued for auto-merge (by hand, if slash commands aren\'t available in your context: self-review the diff and fix what you find, `git push -u origin <branch>`, then `gh pr create` with a Summary + Test plan)';
    if (!actionOn(actions, 'autoMerge')) {
      return `${verify} If ready, ship it with ${openPr}. ${verifyGate} Do NOT merge (auto-merge is disabled) — stop once the PR is open and report its URL.`;
    }
    return `${verify} If ready, ship it with ${openPr}. ${verifyGate} ${driveToMerge(pr, { mergeHandoff })}`;
  }
  if (state === 'CONFLICTED') {
    // The conflict IS the supersession signal here — this PR has already been
    // told by GitHub that it collides with the default branch, so "resolve the
    // conflicts" without first asking whether the work is still wanted is
    // precisely how a superseded branch gets merged looking deliberate.
    const resolve = `${stillNeeded} If it is still needed: rebase the branch onto the default branch, resolve all conflicts, run the tests, and push. ${verifyGate}`;
    if (!actionOn(actions, 'autoMerge')) {
      return `${resolve} Do NOT merge (auto-merge is disabled) — stop once the conflicts are resolved and pushed, and report the PR's URL.`;
    }
    return `${resolve} ${driveToMerge(pr, { mergeHandoff })}`;
  }
  // IN_REVIEW
  const canMerge = actionOn(actions, 'autoMerge');
  // Existing PRs have already passed through whatever review workflow the repo
  // uses. Reconciliation must not request or assume a particular reviewer; its
  // merge gate is the forge's live CI and mergeability state.
  return `Drive the open PR toward green: inspect any existing review feedback and address it.${canMerge
    ? ` Merge ONLY when CI is green and the PR is MERGEABLE. ${driveToMerge(pr, { mergeHandoff })}`
    : ' Do NOT merge (auto-merge is disabled) — stop once the PR is green and ready for the user to merge.'}`;
}

/**
 * Stable signature of an actionable set — used by the perpetual drain to detect
 * PROGRESS between dispatches. A productive coordinator run advances branches
 * through states (NEEDS_PR → IN_REVIEW → merged/cleaned) or removes them, all of
 * which change this signature; a run that leaves the SAME branches in the SAME
 * states (a `NEEDS_PR` branch the agent judged "not ready", an `IN_REVIEW` PR
 * blocked on human review / red CI) produces an identical signature, which the
 * generator treats as "no progress → park" instead of re-dispatching an
 * identical coordinator back-to-back. Order-independent (sorted).
 *
 * Deliberately does NOT include `openPr.mergeable`. GitHub computes mergeability
 * asynchronously and answers `UNKNOWN` until it lands, so that field flaps
 * UNKNOWN → MERGEABLE → UNKNOWN across consecutive reads of a completely static
 * PR — which this guard would read as PROGRESS and re-dispatch on forever. It also
 * carries no information the signature loses: `CONFLICTING` is what makes
 * `classifyBranch` return CONFLICTED, so every real mergeability transition
 * already shows up in `state`.
 *
 * @param {object[]} actionable - post-filterActionable branches
 * @returns {string}
 */
export function actionableSignature(actionable) {
  return actionable
    .map((b) => `${b.branch}:${b.state}:${b.openPr?.number ?? 'none'}${b.tip ? `:${b.tip}` : ''}`)
    .sort()
    .join('|');
}

/**
 * Select the deterministic prefix a single coordinator should receive. The
 * reconciler has already prioritized the full set, so slicing here preserves
 * that ordering and lets the next drain dispatch pick up the remainder after
 * this batch makes progress. Absent/invalid limits retain the legacy all-at-once
 * behavior for hand-authored task records that predate the setting.
 * @param {object[]} inFlight
 * @param {number} branchesPerAgent
 * @returns {object[]}
 */
export function limitBranchesForAgent(inFlight, branchesPerAgent) {
  if (!Array.isArray(inFlight)) return [];
  if (!Number.isInteger(branchesPerAgent) || branchesPerAgent < 1) return inFlight;
  return inFlight.slice(0, branchesPerAgent);
}

/**
 * The recommended `model:`/`effort:` line for one issue-derived branch, or ''
 * when the branch is not issue-derived, the issue carries neither label, or
 * the forge read fails. A failed read must never block or reshape
 * reconciliation: `getIssueDispatchHint` already collapses every failure mode
 * to `status: 'unavailable'` and never rejects, but the `.catch` here holds
 * that guarantee even if a future forge implementation (or a test double)
 * throws instead — this call site is the one place the "never block" rule
 * actually has to hold, so it doesn't trust the callee alone to keep it.
 * @param {string} branchName
 * @param {string} [repoPath] - repo dir gh resolves the remote from
 * @returns {Promise<string>}
 */
async function dispatchHintLineForBranch(branchName, repoPath) {
  const issueNumber = issueNumberFromRef(branchName);
  if (!issueNumber) return '';
  const hint = await getIssueDispatchHint(issueNumber, { cwd: repoPath }).catch(() => ({ status: 'unavailable', model: null, effort: null }));
  if (hint.status !== 'known' || (!hint.model && !hint.effort)) return '';
  // Rendered from the shared vocabulary rather than hand-spelled, so this line
  // cannot drift from the tiers/levels a filer writes. Canonical GitHub spelling:
  // getIssueDispatchHint is gh-only, and this is prose for a coordinator prompt,
  // not a label being applied to a forge.
  const parts = forgeDispatchLabels({ model: hint.model, effort: hint.effort });
  return `- Recommended dispatch (issue #${issueNumber}'s labels): ${parts.join(', ')} — run this branch's work at that capability/effort.`;
}

/**
 * Render the actionable in-flight branch set into the coordinator prompt body
 * (injected as `{inFlightBranches}`). Async because each issue-derived branch
 * gets one forge read for its issue's `model:`/`effort:` labels — see
 * `dispatchHintLineForBranch`.
 * @param {object[]} inFlight - actionable branches (post-filterActionable)
 * @param {{ defaultBranch:string, actions:object, branchesPerAgent?:number, repoPath?:string, appId?:string }} ctx
 *   `appId` adds each branch's pre-mutation ownership recheck command.
 * @returns {Promise<string>}
 */
export async function formatInFlightForPrompt(inFlight, { defaultBranch, actions, branchesPerAgent, repoPath, appId, detachedWorktrees = [], mergeHandoff = false } = {}) {
  // One gh round-trip per issue-derived branch — resolved in parallel (not
  // inline in the loop below) so N branches cost one round-trip's latency,
  // not N of them in series.
  const dispatchLines = await Promise.all(inFlight.map((b) => dispatchHintLineForBranch(b.branch, repoPath)));
  const lines = [`Default branch: \`${defaultBranch}\`. Branches to reconcile (${inFlight.length}):`, ''];
  if (Number.isInteger(branchesPerAgent) && branchesPerAgent > 0) {
    lines.splice(1, 0, `This coordinator run is limited to up to ${branchesPerAgent} branch(es); finish every branch listed below before reporting done.`);
  }
  // This list is a scan from before dispatch; a claim run can take a branch
  // after it. Each branch's own recheck runs right before its first mutation (#10089).
  if (appId && inFlight.length) {
    lines.splice(lines.length - 1, 0, '', 'Ownership recheck: immediately before the FIRST edit, commit, rebase, push, merge, PR change, move or removal on a branch below (and again before its merge), run that branch\'s "Recheck" command and require a parsed JSON response with admitted:true. On admitted:false, an HTTP/auth/transport error or unreadable JSON, leave that branch and its checkout untouched and report it as held by a live owner with the returned reason — a live claim run owns it now. A successful Recheck also reserves that branch for this run until it ends, so no claim run can take it mid-mutation.');
  }
  inFlight.forEach((b, i) => {
    const pr = b.openPr ? ` — PR #${b.openPr.number} (${b.openPr.mergeable})${b.openPr.url ? ` ${b.openPr.url}` : ''}` : ' — no PR';
    lines.push(`### \`${b.branch}\` [${b.state}]${pr}`);
    if (b.worktreePath) lines.push(`- Worktree: \`${b.worktreePath}\`${b.state === 'ABANDONED_WIP' ? ' (holds UNCOMMITTED work — read it before doing anything)' : ''}`);
    if (appId) {
      // `{agentId}` is filled at spawn (`injectReconcileAgentId`): the run has no id yet.
      const payload = JSON.stringify({
        action: 'check', appId, branch: b.branch, ...(b.worktreePath ? { worktreePath: b.worktreePath } : {}),
        agentId: RECONCILE_AGENT_ID_PLACEHOLDER,
      });
      lines.push(`- Recheck: \`${agentApiCurl({ apiBase: localApiBaseUrl(), path: '/api/cos/claim-ownership', payload })}\``);
    }
    // A never-pushed NEEDS_PR branch reads identically to a pushed one in this
    // block, and the difference decides whether the push needs `-u`. State it
    // rather than making the agent infer it from a missing PR link.
    if (b.hasUpstream === false && b.state === 'NEEDS_PR') {
      lines.push('- Never pushed: no upstream on `origin` — the push that opens the PR must create one (`git push -u origin <branch>`).');
    }
    if (typeof b.behind === 'number') {
      lines.push(`- Drift: ${b.behind} commit(s) behind \`${defaultBranch}\`${typeof b.ahead === 'number' ? `, ${b.ahead} ahead` : ''}`);
    }
    // Listed as their own line, not just inside the prose instruction, so the
    // agent can act on the set directly (open these files) without re-deriving it.
    if (b.collisionPaths?.length) {
      lines.push(`- Also changed on \`${defaultBranch}\` since this branch diverged (**read these first — they are where supersession shows up**): ${b.collisionPaths.map((p) => `\`${p}\``).join(', ')}`);
    }
    if (dispatchLines[i]) lines.push(dispatchLines[i]);
    lines.push(`- Do: ${desiredEndState(b.state, actions, {
      prNumber: b.openPr?.number,
      worktreePath: b.worktreePath,
      collisionPaths: b.collisionPaths,
      behind: b.behind,
      mergeHandoff
    })}`);
    lines.push('');
  });
  // Detached trees outside the managed roots are never removed by the deterministic
  // pass. An inventory observation never grants the coordinator removal authority.
  const unmanaged = detachedWorktrees.filter((d) => !d.managed);
  if (unmanaged.length) {
    lines.push(`Detached worktrees at commits already on \`${defaultBranch}\`, outside PortOS's managed roots (${unmanaged.length}):`, '');
    for (const d of unmanaged) {
      lines.push(`### Detached worktree \`${d.path}\``);
      lines.push('- Do: retain this unmanaged checkout and report worktree-unmanaged-location. Do not unlock, alter or remove it; this review batch grants no cleanup authority for unrelated checkouts.', '');
    }
  }
  return lines.join('\n');
}
