/**
 * The ONE completion-contract decision for an agent prompt.
 *
 * A task's completion contract — what its deliverable is, and therefore
 * whether it may commit, push, open a PR, write a sentinel, or simply reply —
 * used to be re-derived by five separate flag ladders in
 * `agentPromptBuilder.js`, each over the same flags in a different order with
 * a different subset of arms. The ordering contract between them was held by
 * prose comments, and two of them had drifted: an `api`-provider task with a
 * tool-free or read-only posture rendered a prompt whose `## Instructions`
 * step 4 told it to commit while `## Git Hygiene` told it there was no git at
 * all (#6616).
 *
 * `resolveCompletionMode` is that decision, made once. Call sites branch on
 * the returned key and never re-test the flags themselves, so a new completion
 * mode is added HERE and rendered per site — it can no longer be added to four
 * ladders out of five.
 *
 * A mode is the *contract*, not the *host*: several sites legitimately render
 * two modes the same way (the light path emits one TUI completion section for
 * both TUI modes, and the full path emits nothing for the modes whose contract
 * it carries in another section). That is a rendering choice each site owns.
 */

/**
 * Does PortOS land this run's branch ITSELF? True under the worktree-without-PR
 * posture (`useWorktree: true`, `openPR: false`): once the agent exits,
 * `agentWorktreeCleanup.js` merges the worktree branch into the source checkout
 * and deletes it (`removeWorktree` with `merge: true`). Nothing on that path
 * reads a remote copy of the branch, so a push has no consumer — and because
 * the local branch is deleted the moment the merge lands, a pushed copy becomes
 * an orphan that the post-completion audit (`agentRepoStateVerification.js`)
 * reports as "remote branch was never deleted" and hands to a recovery agent.
 * The `/do:push` completion step this posture used to get produced exactly
 * that, run after run (every module-hygiene audit on 2026-09-06/07, and user
 * tasks with the same posture before them — each followed by a recovery agent
 * that then pushed the merged commit straight to the default branch). So under
 * this posture the contract is commit-only, on every path that can type slashdo.
 *
 * The other worktree contracts (discard, claim flow, PR follow-up, no-code) are
 * decided BEFORE this question is asked — callers apply their precedence first,
 * the way `buildCompletionGuidelineBullet` does.
 *
 * @param {object} params
 * @param {object|null} params.worktreeInfo
 * @param {boolean} params.willOpenPR
 * @returns {boolean}
 */
export function portosMergesBranchOnExit({ worktreeInfo, willOpenPR }) {
  return Boolean(worktreeInfo) && !willOpenPR;
}

export const COMPLETION_MODES = Object.freeze({
  /** No tools at all — the reply itself is the deliverable. */
  TOOL_FREE: 'tool-free',
  /** Sandboxed stage whose output is the JSON payload in the sentinel. */
  SENTINEL_PAYLOAD: 'sentinel-payload',
  /** Deliverable is an API call or command performed during the run. */
  ACTION_OUTPUT: 'action-output',
  /** Reasoning-only worktree, thrown away on exit; sentinel is the output. */
  DISCARD_WORKTREE: 'discard-worktree',
  /** Self-managed claim flow — it owns its own PR/review/merge/cleanup. */
  CLAIM_FLOW: 'claim-flow',
  /** Reads and reports; must not modify the repository at all. */
  READ_ONLY: 'read-only',
  /** Pushes fixes straight to an existing PR branch; opens no new PR. */
  REVIEW_LOOP_FOLLOW_UP: 'review-loop-follow-up',
  /** TUI host that cannot type a `/do:*` command — commit, then hand off. */
  TUI_SLASHDO_FREE: 'tui-slashdo-free',
  /** TUI host that drives its own `/do:pr` | `/do:push` completion workflow. */
  TUI: 'tui',
  /** Worktree with no PR: commit only, PortOS merges the branch back. */
  PORTOS_MERGES: 'portos-merges',
  /** Worktree with a PR: commit only, the system pushes and opens it. */
  WORKTREE_NO_PUSH: 'worktree-no-push',
  /** Plain checkout: commit and push. */
  COMMIT_AND_PUSH: 'commit-and-push',
});

/**
 * Ordered rules — first match wins. The ORDER is the contract this module
 * exists to hold, so it is data rather than control flow.
 *
 * Derived from the light path's ladder, which is the one production `tui`/`cli`
 * runs actually reach, with the two arms it lacked slotted in where the full
 * path's ladders put them: `SENTINEL_PAYLOAD` ahead of `ACTION_OUTPUT` (a
 * sandboxed review stage sets both `noCodeOutput` and a restricted profile, and
 * its output is the sentinel payload, not an API action), and `PORTOS_MERGES`
 * after `TUI_SLASHDO_FREE`.
 *
 * One deliberate deviation from the Git Hygiene ladder it replaces: `TUI` sits
 * ahead of `PORTOS_MERGES` rather than behind it, so `PORTOS_MERGES` implies a
 * non-TUI host. Ordering them the other way would have resolved a TUI run in a
 * merge-back worktree to `PORTOS_MERGES` and dropped the TUI wording that tells
 * it to run the Completion Workflow and write the sentinel — wording the
 * completion-guideline bullet pins directly. The two orders are otherwise
 * indistinguishable: `isTui` is always false on the full path (every `tui`/`cli`
 * provider returns from the light path first), which is why the ladders could
 * disagree here unnoticed. Sites that must still say "commit only" for a TUI
 * host in a merge-back worktree key off `tuiCompletionCommand === null`, which
 * is exactly that combination.
 */
const COMPLETION_MODE_RULES = Object.freeze([
  [COMPLETION_MODES.TOOL_FREE, (f) => f.toolFreeReasoning],
  [COMPLETION_MODES.SENTINEL_PAYLOAD, (f) => f.sentinelPayloadOutput],
  [COMPLETION_MODES.ACTION_OUTPUT, (f) => f.noCodeOutput],
  [COMPLETION_MODES.DISCARD_WORKTREE, (f) => f.discardWorktree],
  [COMPLETION_MODES.CLAIM_FLOW, (f) => f.claimFlow],
  [COMPLETION_MODES.READ_ONLY, (f) => f.isReadOnly],
  [COMPLETION_MODES.REVIEW_LOOP_FOLLOW_UP, (f) => f.isReviewLoopFollowUp],
  [COMPLETION_MODES.TUI_SLASHDO_FREE, (f) => f.isTui && !f.canRunSlashCommands],
  [COMPLETION_MODES.TUI, (f) => f.isTui],
  [COMPLETION_MODES.PORTOS_MERGES, (f) => f.portosMergesBranch],
  [COMPLETION_MODES.WORKTREE_NO_PUSH, (f) => f.worktreeInfo && f.willOpenPR],
]);

/**
 * Resolve a task's completion contract to a single {@link COMPLETION_MODES} key.
 *
 * @param {Object} flags
 * @param {boolean} [flags.toolFreeReasoning]
 * @param {boolean} [flags.sentinelPayloadOutput]
 * @param {boolean} [flags.noCodeOutput]
 * @param {boolean} [flags.discardWorktree]
 * @param {boolean} [flags.claimFlow]
 * @param {boolean} [flags.isReadOnly]
 * @param {boolean} [flags.isReviewLoopFollowUp]
 * @param {boolean} [flags.isTui]
 * @param {boolean} [flags.canRunSlashCommands] - Defaults to `true`; only a TUI
 *   host that demonstrably cannot type `/do:*` takes the slashdo-free contract.
 * @param {boolean} [flags.portosMergesBranch] - Defaults to
 *   `portosMergesBranchOnExit({ worktreeInfo, willOpenPR })`.
 * @param {Object|null} [flags.worktreeInfo]
 * @param {boolean} [flags.willOpenPR]
 * @returns {string} one of {@link COMPLETION_MODES}
 */
export function resolveCompletionMode(flags = {}) {
  const resolved = {
    canRunSlashCommands: true,
    portosMergesBranch: portosMergesBranchOnExit({
      worktreeInfo: flags.worktreeInfo,
      willOpenPR: flags.willOpenPR,
    }),
    ...flags,
  };
  const match = COMPLETION_MODE_RULES.find(([, test]) => test(resolved));
  return match ? match[0] : COMPLETION_MODES.COMMIT_AND_PUSH;
}
