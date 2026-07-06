# Branch & PR Reconciler — Design Spec

**Date:** 2026-07-06
**Status:** Approved (brainstorm) — pending implementation plan
**Branch:** `feat/branch-pr-reconciler`

## Problem

CoS agents, `/do:next` swarms, and human `/claim` sessions routinely leave the
repo in an unfinished state on a given machine:

- Local branches whose PRs already merged (remote branch deleted) but whose
  local branch **and worktree still linger**.
- Pushed branches with **no PR opened** yet.
- Open PRs stuck on **merge conflicts**.
- Open PRs that are green and ready but **never got merged**.

Today the user manually prompts Claude to "look at the open PRs and branches and
finish the work." This spec automates that as a scheduled, opt-in CoS automation.

### Concrete grounding (this machine, 2026-07-06)

| Local branch | Upstream | Worktree | State |
|---|---|---|---|
| `next/issue-2190` | `[gone]` (remote deleted) | `next-issue-2190` | PR merged, orphaned → clean up |
| `next/issue-2196` | `[gone]` (remote deleted) | `next-issue-2196` | PR merged, orphaned → clean up |
| `next/issue-2199` | present, PR #2206 open, `MERGEABLE` | `next-issue-2199` | In-flight → drive to merge |

These are the acceptance test cases for the first run.

## The peer-safety guarantee (core constraint)

PortOS runs on **multiple federated machines**, all pushing branches and opening
PRs to the same `atomantic/PortOS` GitHub repo, all authored by the same GitHub
user (`atomantic`). The reconciler must **only touch work that originated on the
machine it runs on** and never a peer's in-flight branch/PR.

**Discriminator: local-branch existence.** The reconciler enumerates only
`refs/heads/` (local branches) in *this* clone. A branch created on a peer exists
here only as a remote-tracking ref (`origin/next/issue-XXXX`), never as a local
`refs/heads/` entry — so it is structurally invisible to the reconciler. A PR is
in-scope **iff** its `headRefName` matches a local branch in this clone.

- Author filtering is deliberately **not** used — every machine is `atomantic`,
  so author cannot distinguish machines; local-branch existence can.
- No new machine-identity plumbing is required. (`data/instances.json` `self.instanceId`
  and CoS `agent.metadata.instanceId` may be recorded for corroboration/logging,
  but are **not** the gate — human `/do:next` / `/claim` branches carry no CoS
  agent record, and must still be reconciled.)

**Always excluded:** `main`, `release`, and the resolved default branch.

## Architecture — two-tier hybrid

### Tier 1 — deterministic triage (no LLM), runs every invocation

`server/services/branchReconcile.js` — a pure classifier plus the deterministic
cleanup step.

1. **Enumerate** local branches (`git for-each-ref refs/heads/`) and worktrees
   (`git.getWorktreeBranches`), excluding protected branches.
2. **Classify** each branch into one state (below), using `git.js`
   (`isBranchMergedInto`, upstream tracking) and a single `gh pr list --state open
   --json number,headRefName,mergeable,isDraft` call, correlating PRs to branches
   by `headRefName`.
3. **Act** deterministically only on the unambiguously-safe `MERGED/ORPHANED`
   state. Everything requiring judgment is handed to Tier 2.

**Classification state machine:**

| State | Signal | Handling |
|---|---|---|
| `MERGED` | `isBranchMergedInto(default)` == true | **Tier 1 deterministic cleanup** |
| `NEEDS_PR` | pushed (upstream set, not gone), not merged, no open PR | Tier 2 → verify-ready → `do:pr` |
| `CONFLICTED` | open PR, `mergeable == CONFLICTING` | Tier 2 → resolve/rebase/push |
| `IN_REVIEW` | open PR, `mergeable == MERGEABLE`, not fully green | Tier 2 → drive review loop |
| `READY` | open PR, `MERGEABLE` + CI green + latest Copilot review "0 comments" | Tier 2 → merge + cleanup |
| `WIP` | local-only (no upstream), OR worktree dirty | **Skip + report** — never force-PR unfinished work |

**Cleanup safety gates** (all must hold before deleting a branch/worktree):
- `isBranchMergedInto(defaultBranch)` is **true**. `[gone]` upstream is a *hint*,
  never sufficient proof (a remote branch can be deleted without merging).
- The branch's worktree (if any) is **clean** (no uncommitted changes).
- The branch is not currently checked out in the primary worktree.

Cleanup = `git worktree remove` (with `--force` only after confirming clean; see
the known `/claim` symlinked-`node_modules` gotcha requiring `--force` + `git
worktree prune`) then `git branch -d` (never `-D`).

`git branch -d`'s built-in refusal to delete an unmerged branch is a second
backstop. Note this correctness depends on the repo's **merge-commit** strategy
(this repo rejects squash merges): a squash-merged branch would read as unmerged
and be safely skipped rather than incorrectly deleted — acceptable, since the
worst case is "leaves a branch behind," never "deletes unmerged work."

### Tier 2 — one coordinator CoS agent orchestrating sub-agents

When Tier 1 finds ≥1 branch needing judgment, the scheduler spawns **a single
coordinator CoS agent**. The coordinator receives the classified in-flight branch
list (branch, worktree path, state, desired end-state, PR number) and orchestrates
**one sub-agent per in-flight branch**, each working in that branch's **existing
worktree**. This reuses the existing CoS sub-agent spawning model
(`subAgentSpawner.js` / `agentLifecycle.js`) and per-branch worktree isolation.

Per-branch desired end-states the coordinator dispatches:

- `NEEDS_PR` → sub-agent verifies the branch's work is **complete and ready**
  (tests pass, no obvious stubs/TODO markers, changelog present); if ready, runs
  `do:pr`; if not, reports "incomplete" and leaves the branch untouched.
- `CONFLICTED` → sub-agent rebases onto the default branch, resolves conflicts,
  pushes.
- `IN_REVIEW` → sub-agent runs the review loop (request Copilot review, address
  feedback) to drive the PR toward green.
- `READY` → sub-agent (or coordinator) merges via `gh pr merge --merge
  --delete-branch` and cleans up the local branch + worktree.

**Auto-merge gate** (all required): `mergeable == MERGEABLE`, not draft, CI
`statusCheckRollup` all green, and the **latest** Copilot review reports "0
comments" (per project rule: pre-resolved threads do not count; evaluate the most
recent review only). Release-aggregation PRs exceeding Copilot's 20k-line limit
are exempted from the Copilot check and fall back to CI-green + mergeable.

**Re-entrancy guard:** a per-branch in-flight marker (branch name → active
coordinator/sub-agent id) prevents a later daily run from re-spawning work on a
branch already being reconciled. Reuses `taskConflict.js` workspace-collision
detection where a worktree path is already occupied by an active agent.

## Wiring

- **`server/services/branchReconcile.js`** — pure `classifyBranches(...)` +
  `cleanupMerged(...)` deterministic core. Unit-tested (`branchReconcile.test.js`)
  with fixtures for each state and each safety-gate rejection.
- **`server/services/branchReconcileScheduler.js`** — registers a cron job via
  `eventScheduler.schedule({ id:'branch-reconcile', type:'cron', cron, handler })`
  (canonical pattern: `backupScheduler.js`). Handler **re-reads settings every
  run** (enabled, cron, actions) so changes take effect without restart. Registered
  from the same boot path as the other schedulers.
- **Settings** — `settings.json` → `branchReconcile: { enabled, cron, actions:{
  cleanupMerged, openPr, resolveConflicts, autoMerge } }`. **`enabled: false` by
  default** (honors "no cold-bootstrap LLM calls" — enabling the automation is the
  user's explicit, knowing consent to let it spawn agents on a schedule). Default
  cron: daily (`0 3 * * *`). Zod schema `branchReconcileConfigSchema` in
  `server/lib/validation.js`, wired into `PUT /api/settings` via
  `schema.partial()` when the key is present (per settings-slice convention).
  Default shipped in `data.sample/` so `scripts/setup-data.js` seeds it.
- **Manual trigger** — `POST /api/branch-reconcile/run` → `eventScheduler.triggerNow('branch-reconcile')`
  so the user can run it on demand (needed to test 2190/2196/2199 immediately).
- **UI** — a toggle + cron + per-action checkboxes section added to the existing
  CoS scheduling settings surface (no new route/page; no new `NAV_COMMANDS`
  entry needed). Includes a "Run now" button gated on the *saved* enabled state
  (per "Run Now gates on saved state" convention) and a last-run summary.
- **Logging** — single-line emoji logs (`🔀 branch-reconcile: cleaned 2, dispatched
  1 coordinator over 1 in-flight branch`) and a structured run summary surfaced to
  the CoS activity log.

## Distribution / compatibility

- New `settings.json` key with a default shipped in `data.sample/` and merged by
  `scripts/setup-data.js` (non-destructive key-merge) — older installs pick it up
  disabled.
- Zod schema tolerant of the key being absent (older clients don't 400).
- No on-disk format migration (additive settings key only).
- No prompt-default versioning needed initially: the coordinator/sub-agent prompts
  are new (not a change to an existing shipped default). If the prompt later
  becomes user-editable, add it to `PROMPT_VERSIONS`/`PREVIOUS_DEFAULT_PROMPTS`.

## Cadence

Daily, default `0 3 * * *` (configurable). Opt-in (disabled by default).

## Out of scope / deferred

- Reconciling branches on federated **peer** machines remotely (each machine
  reconciles only its own local branches — by design).
- Un-pushed local WIP branches (reported, never auto-PR'd).
- A dedicated top-level page/route (lives under existing CoS settings).

## Acceptance test

On this machine, an on-demand run should:
1. Clean up `next/issue-2190` and `next/issue-2196` (merged → remove worktree +
   delete local branch), deterministically, no agent.
2. Dispatch a coordinator agent for `next/issue-2199` / PR #2206 (`MERGEABLE`) to
   drive it to a merge if fully green, else advance the review loop.
3. Touch no `origin/*`-only (peer) branches.
