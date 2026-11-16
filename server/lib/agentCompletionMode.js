/**
 * The ONE completion-contract decision for an agent prompt: what a task's deliverable is, and so whether it may
 * commit, push, open a PR, write a sentinel or just reply.
 *
 * Call sites branch on the key `resolveCompletionMode` returns and never re-test flags themselves; a new mode is
 * added HERE and rendered per site. A mode is the *contract*, not the *host*: sites may render two modes the same
 * way.
 */

/**
 * Does PortOS land this run's branch ITSELF? True under worktree-without-PR (`useWorktree: true`, `openPR: false`):
 * `agentWorktreeCleanup.js` merges the worktree branch into the source checkout and deletes it, so a push has no
 * consumer and the pushed copy would be an orphan that `agentRepoStateVerification.js` reports as an undeleted remote
 * branch and hands to a recovery agent. Under this posture the contract is commit-only on every path that can type
 * slashdo. Other worktree contracts (discard, claim flow, PR follow-up, no-code) are decided BEFORE this question;
 * callers apply their precedence first, as `buildCompletionGuidelineBullet` does.
 *
 * @param {object} params
 * @param {object|null} params.worktreeInfo
 * @param {boolean} params.willOpenPR
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
  /** Task owns scoped code delivery in an external scratch repository. */
  EXTERNAL_REPOSITORY: 'external-repository',
  /** Reasoning-only worktree, thrown away on exit; sentinel is the output. */
  DISCARD_WORKTREE: 'discard-worktree',
  /** Self-managed claim flow — it owns its own PR/review/merge/cleanup. */
  CLAIM_FLOW: 'claim-flow',
  /** Reads and reports; must not modify the repository at all. */
  READ_ONLY: 'read-only',
  /** Pushes fixes straight to an existing PR branch; opens no new PR. */
  REVIEW_LOOP_FOLLOW_UP: 'review-loop-follow-up',
  /** The bundled release workflow owns delivery and final verification. */
  RELEASE_FLOW: 'release-flow',
  /** Better audits own their worktrees and verified PR delivery. */
  AUDIT_FLOW: 'audit-flow',
  /** Reconciliation owns delivery of named branches, never the coordinator checkout. */
  RECONCILE_FLOW: 'reconcile-flow',
  /** Recovery owns preservation and reconciliation of the actual app checkout. */
  CHECKOUT_RECOVERY: 'checkout-recovery',
  /** TUI host that cannot type a `/do:*` command — commit, then hand off. */
  TUI_SLASHDO_FREE: 'tui-slashdo-free',
  /** TUI host that drives its own `/do:pr` | `/do:push` completion workflow. */
  TUI: 'tui',
  /** Worktree with no PR: commit only, PortOS merges the branch back. */
  PORTOS_MERGES: 'portos-merges',
  /** Worktree with a PR: commit only; `/do:pr` when the host can type it, otherwise the system pushes and opens it. */
  WORKTREE_NO_PUSH: 'worktree-no-push',
  /** Plain checkout: commit and push. */
  COMMIT_AND_PUSH: 'commit-and-push',
});

/**
 * Ordered rules, first match wins; the ORDER is the contract, so it is data rather than control flow.
 *
 * `SENTINEL_PAYLOAD` precedes `ACTION_OUTPUT` because a sandboxed review stage sets both `noCodeOutput` and a restricted
 * profile and its output is the sentinel payload. `TUI` sits ahead of `PORTOS_MERGES` (so `PORTOS_MERGES` implies a
 * non-TUI host): the other order would drop the TUI wording that tells it to run the Completion Workflow and write the
 * sentinel. Sites that must still say "commit only" for a TUI host in a merge-back worktree key off
 * `tuiCompletionCommand === null`.
 */
const COMPLETION_MODE_RULES = Object.freeze([
  [COMPLETION_MODES.TOOL_FREE, (f) => f.toolFreeReasoning],
  [COMPLETION_MODES.SENTINEL_PAYLOAD, (f) => f.sentinelPayloadOutput],
  [COMPLETION_MODES.EXTERNAL_REPOSITORY, (f) => f.externalRepositoryOutput && !f.isReadOnly && !f.discardWorktree],
  [COMPLETION_MODES.ACTION_OUTPUT, (f) => f.noCodeOutput],
  [COMPLETION_MODES.DISCARD_WORKTREE, (f) => f.discardWorktree],
  [COMPLETION_MODES.CLAIM_FLOW, (f) => f.claimFlow],
  [COMPLETION_MODES.READ_ONLY, (f) => f.isReadOnly],
  [COMPLETION_MODES.REVIEW_LOOP_FOLLOW_UP, (f) => f.isReviewLoopFollowUp],
  [COMPLETION_MODES.RELEASE_FLOW, (f) => f.slashdoCommand === 'release'],
  [COMPLETION_MODES.AUDIT_FLOW, (f) => ['better', 'better-swift'].includes(f.slashdoCommand)],
  [COMPLETION_MODES.CHECKOUT_RECOVERY, (f) => f.taskHookType === 'app-checkout-recovery'],
  [COMPLETION_MODES.RECONCILE_FLOW, (f) => f.taskHookType === 'branch-reconcile'],
  [COMPLETION_MODES.TUI_SLASHDO_FREE, (f) => f.isTui && !f.canRunSlashCommands],
  [COMPLETION_MODES.TUI, (f) => f.isTui],
  [COMPLETION_MODES.PORTOS_MERGES, (f) => f.portosMergesBranch],
  [COMPLETION_MODES.WORKTREE_NO_PUSH, (f) => f.worktreeInfo && f.willOpenPR],
]);

/**
 * Resolve a task's completion contract to a single {@link COMPLETION_MODES} key. `canRunSlashCommands` defaults to
 * `true` (only a TUI host that demonstrably cannot type `/do:*` takes the slashdo-free contract); `portosMergesBranch`
 * defaults to `portosMergesBranchOnExit({ worktreeInfo, willOpenPR })`.
 *
 * @param {Object} flags
 * @param {boolean} [flags.toolFreeReasoning]
 * @param {boolean} [flags.sentinelPayloadOutput]
 * @param {boolean} [flags.externalRepositoryOutput]
 * @param {boolean} [flags.noCodeOutput]
 * @param {boolean} [flags.discardWorktree]
 * @param {boolean} [flags.claimFlow]
 * @param {boolean} [flags.isReadOnly]
 * @param {boolean} [flags.isReviewLoopFollowUp]
 * @param {string} [flags.taskHookType] - Canonical task identity from resolveTaskHookType.
 * @param {string} [flags.slashdoCommand]
 * @param {boolean} [flags.isTui]
 * @param {boolean} [flags.canRunSlashCommands] - Defaults to `true`.
 * @param {boolean} [flags.portosMergesBranch] - Defaults to `portosMergesBranchOnExit({ worktreeInfo, willOpenPR })`.
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
