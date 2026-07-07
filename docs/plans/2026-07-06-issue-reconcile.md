# Issue Reconcile — kill zombie issues, self-heal partial ships

**Date:** 2026-07-06
**Status:** approved → implementing
**Related:** #2220 (closed, follow-up #2241), #2179, #2175 (released); epic tie-in with the branch-reconcile CoS task (#2237/#2240)

## Problem

An issue that is only PARTIALLY completed by a merged PR becomes a **zombie**:
`OPEN` + `in-progress` label + assignee, with its PR already merged. The claim
queue treats `in-progress` as "claimed and being worked" and skips it, so the
remaining scope is never re-claimed and never completed.

Root cause — the completion flow has no "partial completion" state:

1. **`/do:next` Phase 7** (`taskPromptDefaults/prompts.js`) is *binary*: it verifies
   the issue auto-closed via a `Closes #NUM` trailer, and if still open closes it +
   removes `in-progress`. There is no branch for "I shipped part of the scope." The
   only pre-ship escape (`needs-input`, `:558`) releases *without shipping*.
2. **Branch reconciler** (`branchReconcile.js`) is entirely branch-centric — after it
   merges an `IN_REVIEW` PR it deletes the branch/worktree but **never touches the
   linked issue's label or state**.

So a sensible partial ship with `Refs #NUM` (not `Closes`) merged via the
reconciler/swarm path → zombie. Live examples: #2220, #2179, #2175.

## Design

Agent-judged **hybrid** partial-ship policy, applied in two places.

### Part A — teach the completion flow "partial ship" (future direct claims)

`claim-issue`, `claim-issue-gitlab`, `claim-issue-jira` Phase 5/7:

- Phase 5: the PR body uses `Closes #NUM` only when the PR fully satisfies the
  issue; a partial ship uses `Refs #NUM` + a "Remaining" section.
- Phase 7: after merge, decide *did this PR fully satisfy the issue?*
  - **Yes** → existing close + remove `in-progress`.
  - **No, remainder is a clean separable chunk** → close original (comment:
    shipped ✓ / moved to #NEW), file a scoped follow-up (`plan` + inherited area
    labels, `Refs #orig`).
  - **No, remainder is a continuation of the same scope** → keep open, post
    `Done ✓ / Remaining ▢` comment, remove `in-progress` + assignee → re-claimable.

Prompt-version discipline (CLAUDE.md "Distribution model"): bump `PROMPT_VERSIONS`
for all three keys, append the outgoing bodies verbatim to
`PREVIOUS_DEFAULT_PROMPTS`, regenerate `integrity.snapshot.json`.

### Part B — new `issue-reconcile` per-app CoS task (self-heal + reconciler path)

Mirrors the `branch-reconcile` shape:

- **`server/services/issueReconcile.js`** (pure classifier + `gh` gatherers, unit-tested):
  scan open + `in-progress` issues; classify each `ZOMBIE` iff a linked **merged**
  PR references it (head ref encodes `issue-<num>`, or body mentions `#<num>`) **and**
  there is no **live** claim (no open PR / local / remote / `cos/*/issue-<num>/*`
  branch for it) **and** no active CoS agent. Emit a `zombieSignature` convergence
  guard so the perpetual drain parks instead of looping.
- **`cosTaskGenerator.js`**: deterministic pre-step + dispatch block parallel to the
  branch-reconcile block — zombies → dispatch a coordinator agent that reads each
  issue+PR and applies the SAME hybrid decision; none → park on `recheckCron`.
- **Registration**: `SELF_IMPROVEMENT_TASK_TYPES`, `DEFAULT_TASK_INTERVALS`
  (PERPETUAL, disabled, `recheckCron: '0 4 * * *'`, `taskMetadata.autoClose: true`),
  `MANAGED_AGENT_OPTIONS` (lock `useWorktree`/`openPR` off — the coordinator works
  over `gh`, no worktree), the task-description map, `PROMPT_VERSIONS`
  (`issue-reconcile: 1`), `ALLOWED_TASK_METADATA_KEYS` (`autoClose`), and the new
  coordinator prompt body.
- **Disabled by default** → no migration needed (new opt-in task).
- **`autoClose` toggle** (default ON): when OFF the coordinator never closes an
  issue, only comments + unlabels — a safety valve for users who prefer one thread
  per feature.

**Peer safety** (differs from branch-reconcile, which is local-ref-only): issue
state is shared GitHub state across federated peers (void/null/NaN/undefined).
Close/unlabel are idempotent; the one real race is *filing a duplicate follow-up
from two machines*, so the coordinator dedupes by searching for an existing
follow-up (`Refs #orig` marker) before filing. v1 pre-step is `gh`-only and parks
on non-GitHub apps; GitLab/JIRA siblings are deferred (see PLAN.md).

## Part C — heal the three current zombies (done)

- **#2220** — separable remainder → **closed**, follow-up **#2241** filed.
- **#2179**, **#2175** — continuation → kept open, `Done/Remaining` comment,
  `in-progress` + assignee removed.
