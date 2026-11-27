---
name: portos-ship
description: PortOS shipping procedure — pushing, PR model attribution label, review reuse, hosting-provider merge authority, post-merge worktree/branch teardown, releases and the release quality snapshot. Invoke before pushing a branch, opening or merging a PR, cleaning up a merged checkout, or cutting a release.
---

# Shipping PortOS changes

Moved from the root `AGENTS.md` Git Workflow section (#16087). The hard prohibitions (no `--delete-branch`, no bypass of repository protections, no `--force` server-side sync) stay in root as well, because they guard destructive actions.

## Branches and releases

- `main` is active development; merging a frozen candidate into `release` publishes. [docs/VERSIONING.md](../../../docs/VERSIONING.md#creating-a-release) is the canonical release procedure and overrides slashdo's generic recipe: pin `main` once at kickoff in an isolated candidate branch, persist its cutoff, and resume that candidate after interruption. Later merges belong to the next release; only preparation and evidenced candidate-gating fixes advance it, and live `main` is never merged or rebased into it. Promote the validated candidate, then sync the release back to `main` with a normal PR.
- [Managed release operations](release-operations.md) covers candidate and synchronization checkout commands, plus recovery of interrupted publishers and outbox checkpoints.
- Release notes live in the single `.changelog/RELEASE.md` (heading version = `package.json`, under 100 KB), overwritten per release; GitHub Releases and tags are the archive ([guide](../../../.changelog/README.md)). Don't write it during development.
- Release only within an authorized release workflow (`/do:release`), never because of commit count. `package.json` reflects the last release; don't bump it during development.
- **Release quality snapshot**: after publication, `npm run quality:snapshot` on the install with audit evidence publishes numeric local assessments (no provider calls, no private run prose) into `.quality.json` through an immediately merged PR, or commits nothing and says so. It goes to the next release; never hold the frozen candidate for it.

## Before pushing

Check branch, upstream and working-tree state, preserve unrelated changes, and commit the intended work. Fetch the workflow's intended base explicitly (a feature branch's tracking branch is not necessarily the default branch) and integrate only when needed under the merge policy below. Run pregate on the resulting commits, then push; rerun after any later rebase. Don't blindly pull with autostash.

## PR attribution labels

- **Best-effort, never verified.** Nothing reads the `implementer:` label back (#16571), so attribution is one label call at PR creation with no read-back, repair or failure report; a failed label never blocks a PR.
- **Opener**: `implementer:<model>` (`implementer::<model>` on GitLab) from the run's **PR Model Attribution** section, else the model your host's execution context verifies (`normalizePlannerId` in `server/lib/dispatchLabels.js`); omit it rather than guess from the provider, reviewer, issue labels or self-identification. A delegated opener uses its own model; a resumed PR keeps its original label.

## Reviews

**Reuse applicable reviews.** Check existing decisions and the reviewed revision before requesting a review. Failed CI or base movement alone is not a reason for another round: fix CI first, and request a fresh round only for material unreviewed changes or an explicit requirement. A main integration keeps approval only when its applicability is verified; keep the historical reviewed head, never claim a new inspection, and obey GitHub's requirements.

## Merge authority

**The hosting provider owns merge eligibility.** Use the assigned repository/PR and account; the forge's rules and normal merge API/CLI decide. Never change protections or use an admin/bypass option, and don't require any extra PortOS admission, attestation or combined-tree certificate. Pin the current PR head. Provider-confirmed `MERGED` (including auto-merge) is delivery; enabled/queued is pending and an API error is unknown. Do the documented validation and requested review, but don't recertify after the merge. Default-branch movement alone needs no rebase, new CI or review; integrate only for real conflicts, an enforced up-to-date rule, or a demonstrated integration defect.

## Merge and teardown

**Finish authorized merges and teardown before reporting success.**

- Never pass `--delete-branch` to `gh pr merge` (including fallbacks), since it can remove another linked checkout.
- Pin every attempt to the CI-verified head, and verify remote `MERGED` before cleanup. The forge is the source of truth for pushed and merged state; don't re-derive it with local archives.
- Once a PR is merged at the local tip and no active agent owns the checkout, remove the worktree (ignored, untracked and uncommitted files included) and branch directly (`git worktree remove --force` + `git branch -D`), with no retirement-review service; that authorizes discarding this checkout's own files, never another checkout or ref. An unmerged checkout keeps its work in place.
- Delete only the authorized remote ref, with an expected-head lease; an advanced ref or unmerged held checkout stays intact with a tracked handoff.
- Recheck ownership, release only this task's locks, and delete only the explicitly named local branch, never one inferred from its upstream. Preserve other owners' locks and manual handoffs, and name the owner, blocker and next step of any work left behind.
