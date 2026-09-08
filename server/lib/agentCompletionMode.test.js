import { describe, it, expect } from 'vitest';
import { COMPLETION_MODES, portosMergesBranchOnExit, resolveCompletionMode } from './agentCompletionMode.js';

// The rule ORDER is the whole contract this module holds — it used to live in
// prose comments across five ladders, two of which had silently drifted out of
// agreement (#6616). Each case below names the specific precedence a
// reordering would break, not just "the resolver returns a string".
describe('resolveCompletionMode', () => {
  const wt = { worktreePath: '/wt', branchName: 'b' };

  it('gives a tool-free stage its own contract even when it also looks like a no-code discard task', () => {
    // The production shape: a public-review gate sets noCodeOutput AND
    // discardWorktree alongside its profile. Any other arm would send a model
    // with no tools chasing a sentinel, an API call, or a commit.
    expect(resolveCompletionMode({
      toolFreeReasoning: true, sentinelPayloadOutput: false, noCodeOutput: true,
      discardWorktree: true, isTui: true, worktreeInfo: wt,
    })).toBe(COMPLETION_MODES.TOOL_FREE);
  });

  it('sends a sandboxed review stage to the sentinel payload, not the API-action contract', () => {
    // Stage 3 sets noCodeOutput too, but its deliverable is the JSON payload in
    // the sentinel. Ordering ACTION_OUTPUT first told it to "deliver your result
    // the way the task describes", which is how a run reports nothing.
    expect(resolveCompletionMode({
      sentinelPayloadOutput: true, noCodeOutput: true, discardWorktree: true,
    })).toBe(COMPLETION_MODES.SENTINEL_PAYLOAD);
  });

  it('lets the deliverable\'s destination outrank the worktree\'s disposal', () => {
    // noCodeOutput says WHERE the result goes; discardWorktree says what happens
    // to the checkout. A task doing external work during the run must not be
    // told the sentinel is its output channel — the cleanup throws it away.
    expect(resolveCompletionMode({ noCodeOutput: true, discardWorktree: true }))
      .toBe(COMPLETION_MODES.ACTION_OUTPUT);
  });

  it('keeps a TUI run in a merge-back worktree on the TUI contract', () => {
    // The deliberate deviation from the Git Hygiene ladder's order. Resolving
    // this to PORTOS_MERGES drops the wording that tells a TUI host to run the
    // Completion Workflow and write the sentinel — it would just be told to
    // commit, and PortOS would wait forever for a sentinel nobody writes.
    expect(resolveCompletionMode({ isTui: true, worktreeInfo: wt, willOpenPR: false }))
      .toBe(COMPLETION_MODES.TUI);
    // …and a non-TUI host in the same worktree still gets the commit-only one.
    expect(resolveCompletionMode({ isTui: false, worktreeInfo: wt, willOpenPR: false }))
      .toBe(COMPLETION_MODES.PORTOS_MERGES);
  });

  it('separates a TUI host that cannot type a slash command from one that can', () => {
    expect(resolveCompletionMode({ isTui: true, canRunSlashCommands: false, worktreeInfo: wt, willOpenPR: true }))
      .toBe(COMPLETION_MODES.TUI_SLASHDO_FREE);
    // Absent evidence, a host is assumed able — only a demonstrably slashdo-free
    // one takes the manual commit + handoff contract.
    expect(resolveCompletionMode({ isTui: true, worktreeInfo: wt, willOpenPR: true }))
      .toBe(COMPLETION_MODES.TUI);
  });

  it('falls through the worktree postures to a plain commit and push', () => {
    expect(resolveCompletionMode({ worktreeInfo: wt, willOpenPR: true })).toBe(COMPLETION_MODES.WORKTREE_NO_PUSH);
    expect(resolveCompletionMode({ worktreeInfo: null, willOpenPR: false })).toBe(COMPLETION_MODES.COMMIT_AND_PUSH);
    expect(resolveCompletionMode()).toBe(COMPLETION_MODES.COMMIT_AND_PUSH);
  });

  it('takes an explicit portosMergesBranch over the worktree/PR derivation', () => {
    // The prompt builders pass the value they already computed; a caller that
    // passes neither still gets the derived answer.
    expect(resolveCompletionMode({ portosMergesBranch: true, worktreeInfo: null, willOpenPR: true }))
      .toBe(COMPLETION_MODES.PORTOS_MERGES);
  });

  // A mode nothing can return is a rule that was never written — exactly the
  // failure that left step 4 with no tool-free and no read-only arm.
  it('can return every declared mode', () => {
    const reachable = new Set([
      resolveCompletionMode({ toolFreeReasoning: true }),
      resolveCompletionMode({ sentinelPayloadOutput: true }),
      resolveCompletionMode({ noCodeOutput: true }),
      resolveCompletionMode({ discardWorktree: true }),
      resolveCompletionMode({ claimFlow: true }),
      resolveCompletionMode({ isReadOnly: true }),
      resolveCompletionMode({ isReviewLoopFollowUp: true }),
      resolveCompletionMode({ isTui: true, canRunSlashCommands: false }),
      resolveCompletionMode({ isTui: true }),
      resolveCompletionMode({ worktreeInfo: wt, willOpenPR: false }),
      resolveCompletionMode({ worktreeInfo: wt, willOpenPR: true }),
      resolveCompletionMode({}),
    ]);
    expect([...reachable].sort()).toEqual(Object.values(COMPLETION_MODES).sort());
  });
});

describe('portosMergesBranchOnExit', () => {
  it('is true only for a worktree that opens no PR', () => {
    expect(portosMergesBranchOnExit({ worktreeInfo: { worktreePath: '/wt' }, willOpenPR: false })).toBe(true);
    expect(portosMergesBranchOnExit({ worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true })).toBe(false);
    expect(portosMergesBranchOnExit({ worktreeInfo: null, willOpenPR: false })).toBe(false);
  });
});
