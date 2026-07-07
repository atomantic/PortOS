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

## Part D — forge siblings (#2249)

- **GitLab (shipped #2249).** `issueReconcile.js` is now forge-aware: it resolves
  the forge from the app's git `origin` host inside `reconcile()` (github.* →
  GitHub via `gh`, gitlab.* → GitLab via `glab`, anything else → null/skip) and
  delegates to a per-forge state gatherer. Both gatherers normalize into ONE common
  issue shape (`{ number, title, url, labels, assignees }`) + change shape
  (`{ number, headRefName, body, url }`), so the pure classifier, ref matchers, and
  `zombieSignature` are shared — no forge branching in the classify/merge logic.
  GitLab maps `iid`→number, MR `source_branch`→head ref (carries `claim/issue-<iid>`),
  MR `description`→body (carries `Refs #<iid>`). Routing decision: **one task type**,
  not three — `issue-reconcile` resolves the forge internally (the `claim-work`
  router splits by tracker only because each tracker has a distinct multi-phase
  claim *prompt*; here the coordinator prompt is shared and just gets the forge +
  gh/glab command table injected via `{zombieIssues}`). Coordinator prompt bumped to
  v2 (forge-aware gh/glab commands); v1 preserved in `PREVIOUS_DEFAULT_PROMPTS`.
  `glab` exec helper added at `server/services/gitlab.js` (mirrors `execGh`, cwd-aware).
- **Deferred (both forges).** The merged/open PR/MR list queries degrade to `[]`
  on failure while only the in-progress ISSUE list is load-bearing (null → skip).
  This is the intentional v1 GitHub contract, preserved for GitLab parity — but it
  means a transient MR-list failure could momentarily misclassify (an issue with a
  live open MR whose list call failed looks like a zombie; a real zombie whose
  merged-list failed looks stalled). Low-impact because the coordinator
  re-verifies each zombie live before acting AND the convergence signature only
  drives, never destroys — but promoting open/merged list failures to
  transient-null (skip, don't misclassify) is a worthwhile cross-forge hardening.
  Not done here to keep the two forges behaviorally identical to the reviewed v1.
- **JIRA (shipped #2259).** The JIRA "zombie" analog is status-based, not
  label-based (a ticket left *In Review* with remaining scope + no live claim; JIRA
  has no `in-progress` label to release), and heals through the PortOS JIRA API
  (`my-sprint-tickets` + ticket status → record remaining scope + ticket
  transitions + `POST /api/jira/instances/:id/tickets`) rather than a forge CLI.
  Implemented by normalizing JIRA sprint tickets into the SAME common issue shape
  the forge gatherers produce (KEY → `number`, status carried for the convergence
  signature) so the pure classifier / signature stay shared: an **In-Progress**-
  category ticket whose status name matches *In Review* → ZOMBIE, a plain
  In-Progress → STALLED, **To Do** (not started) / **Done** (terminal) → excluded
  so the scan converges. The live-claim guard scans `claim/<KEY>` / `cos/…/<KEY>/…`
  refs (local AND remote) by ticket KEY — an MR still open under review keeps its
  branch, reading LIVE; a merged-and-deleted branch reads as a zombie. Routing
  mirrors `resolveAppWorkTracker`: JIRA is NEVER auto-selected from the git host —
  it's chosen only when the app's resolved `workTracker` is `'jira'` with enabled
  `jira.instanceId`/`projectKey`, threaded into `reconcile()` as a `jira` option
  (a JIRA-specific gatherer branch, not an origin-host lookup). Added a strict
  `fetchMyCurrentSprintTickets` (the existing `getMyCurrentSprintTickets` swallows
  errors to `[]` for the UI; the reconcile scan needs the throw so a transient
  failure skips-without-parking instead of being misread as an empty sprint).
  Coordinator prompt bumped to v3 (adds the JIRA arm — transitions + `POST
  tickets`); v2 preserved in `PREVIOUS_DEFAULT_PROMPTS`.

## Part C — heal the three current zombies (done)

- **#2220** — separable remainder → **closed**, follow-up **#2241** filed.
- **#2179**, **#2175** — continuation → kept open, `Done/Remaining` comment,
  `in-progress` + assignee removed.
