# Unreleased Changes

## Client linting

- Client linting now uses ESLint 10 with the maintained ESLint React rule set, preserving PortOS's key React correctness checks without relying on the unmaintained `eslint-plugin-react` compatibility range.

## Sprites

- Sprite turnaround and directional-reference candidates now request a square canvas from image generation and explicitly treat the locked turnaround as the source of truth for accessory side and occlusion. This prevents arbitrary Codex ImageGen candidate aspect ratios and reduces mirrored hip-bag drift before an anchor is locked.

## CoS agent failure reporting

- Failed agent runs are classified far more accurately. A terminal-UI agent's transcript is a repainted *screen*, not a log — it can run to hundreds of kilobytes while containing barely any line breaks — so the analyzer's "look at the recent output" window was quietly reading the entire session. Any keyword anywhere in it, including commands the agent itself typed, decided the verdict: one run reaped for going idle was reported as "Context length exceeded", which blocked its task and auto-filed an investigation for a problem that never happened.
- When the system already knows why a run ended — the idle watchdog fired, the runtime budget ran out, the provider CLI wasn't installed — that is now what gets reported. Only a genuine provider or system error in the transcript can override it.
- Failure snippets shown on an agent's record are now short, readable excerpts centered on the actual error instead of raw terminal escape codes. One failed run had been writing an 816KB blob of control characters into its own record.

## Agent Operations — `/do:next` run settings

- **`/do:next` on a managed app now asks before it runs.** Clicking it on an app's Overview opens a settings drawer instead of queuing immediately: let the agent pick the next eligible item as before, or **pick a specific one** from a live list of that app's claimable work — PLAN.md items, GitHub or GitLab issues, or current-sprint JIRA tickets, whichever the app's Work Tracker resolves to. A picked item is pinned into the claim prompt, which still honors every safety check (already assigned, blocked, in flight, an epic → exit cleanly).
- The same drawer sets the run's **provider, model, and thinking effort**, whether to **simplify** before committing, and the **review-loop reviewers** (plus GitHub reviewer usernames and optional/non-blocking marks) that gate the PR merge. Leave everything untouched and you get exactly the run the old one-click button queued, using the app's configured claim-work defaults.
- The item list is scanned with the same author filter the run will use, so it can never advertise work the agent would then skip; the filter is adjustable inline for GitHub/GitLab. An unreachable tracker now says so, instead of reporting "nothing to do."

## Universe canon corrective reference images

- [issue-3103] Any Cast, Place, or Object entry in a Universe's bible can now take a corrective reference image: upload or pick a photo/render that shows what it should actually look like, and a vision model compares it against the entry's current description and proposes a correction. Reviewing and applying it both fixes the description and pins the image as that entry's reference image, so future renders for it are visually anchored to the correction instead of starting from scratch each time.
- Reference-image pinning (the star toggle on a canon entry's thumbnail) now feeds every future render of that entry, not just its thumbnail — if you'd already pinned a reference image before this update, its next render will be visually anchored to that image too.

## Universe art references

- **[issue-3099] Adding or removing an art reference no longer flickers back when you navigate away and return mid-save** — if you changed a universe's art references and switched to another universe and back before the change finished saving, a slower page refresh could briefly restore the pre-change list on screen, making the next add or remove operate on the wrong set. The saved change now always wins over the older refresh it raced.

## CoS quick task templates

- [issue-3089] The Quick Templates row on the CoS task form now launches real workflows instead of sentence fragments. The eight generic stubs ("Fix the bug where", "Refactor", "Add tests for") only seeded text you had to finish typing anyway; they're replaced by the bundled slashdo workflows an agent can run end to end — Plan a Task, Ship Next Issue, Replan Backlog, Review Changes, Cut a Release, DevSecOps Audit, Prune Dependencies, and Safety Scan.
- Each template also carries the run shape its workflow implies, so picking one sets the worktree/PR/simplify toggles correctly: these workflows either write no code at all or manage their own worktrees and PRs, and wrapping another PortOS worktree around one would nest it. You can still override any toggle afterward, and a template that doesn't specify a toggle leaves your current setting alone.
- The workflow is invoked correctly no matter which agent runs it. Because the provider dropdown defaults to Auto, the template stores the workflow's name rather than a literal `/do:` string — at launch, a Claude Code agent gets `/do:plan-task`, OpenCode gets `/do-plan-task`, and Codex/Grok/Antigravity agents get it named as an Agent Skill. The workflow's full procedure travels with the task in every case, so it also works when the agent is running against one of your other apps rather than PortOS itself, where those slash commands aren't installed.
- Applying a template no longer clears the target application you'd already selected — which had also silently reset that app's worktree and PR defaults.
- `/do:plan-task` and `/do:config` are now available as project slash commands in this repo; they were the only two bundled commands missing a link.

## CoS branch reconciliation

- **Branch Reconciliation now checks whether a branch's work is still wanted before it finishes it.** A branch that sat while the default branch moved may hold a feature that was solved there a different way in the meantime — merging it then undoes what already shipped. Nothing about the branch reveals this: its tests pass, its changelog entry reads fine, and the merge conflict it produces is perfectly resolvable. So each branch handed to the agent now arrives with how far behind it is and, more importantly, the list of files the default branch has *also* changed since that branch diverged. Reading those is step one, before any commit or conflict resolution, and if the default branch already solves that branch's problem the agent reports it as superseded and leaves the branch completely alone rather than merging a regression.
- The reconciliation agent is now told outright that a conflict it can resolve is not evidence the work is still needed — that is the specific path by which a superseded branch gets merged looking deliberate.
- Every branch is rebased onto the default branch *before* its pull request opens, so the PR is conflict-free rather than needing a merge patched up afterward, and the touched workspaces' test suites must be seen passing after that rebase before anything is pushed. A rebase onto a moved default branch can break code that passed on the old one.
- **Work an agent left uncommitted is no longer invisible.** When a CoS agent exits before committing — it finished, crashed, or hit the idle reaper — the whole deliverable stays uncommitted in its worktree while its branch still points at the commit it started from. Branch Reconciliation read that branch as "already merged," correctly refused to delete a worktree with unsaved changes, and reported nothing further, so every run announced "no branches in flight" while real work sat there. Three such branches had accumulated on one install. These are now surfaced as in-flight and handed to the reconciliation agent, which reads the uncommitted changes, commits and ships them if the work is finished, and reports what's missing if it isn't — and never deletes them either way.
- A worktree whose agent is still running is untouched, as before. So is a human `/claim` worktree, a locked worktree, and anything outside the machine-owned `agent-*` namespace. If the running-agent list can't be determined, every worktree stays protected rather than being assumed abandoned.
- The new behavior can be turned off per app with the `finishAbandoned` action toggle, alongside the existing cleanup/PR/conflict/merge toggles.
- When Branch Reconciliation parks with nothing to do, the log now says whether branches were held back by a protection guard or skipped because one of those toggles is off, instead of a bare "nothing in-flight."
- **A branch the reconciler picks up is now driven all the way to merged, not just to "PR opened."** When the task verified a branch was ready and opened its pull request, it reported success and exited within a minute — while CI was still running. The pull request then sat green and mergeable until the next scheduled run noticed it again. The agent now waits out the check run in-session, fixes what goes red, and merges once every required check passes and the pull request is mergeable.
- The reconciler's blanket "never merge unreviewed work" rule read as a veto on the merge step it was supposed to perform, so it has been replaced by the explicit gate each branch already carries (required CI green, mergeable, and the review it names). Merging still only ever happens through `gh pr merge` on a branch the task was handed.
- Waiting for a Copilot review on an in-review pull request is now time-boxed to 10 minutes — on a repository without Copilot review enabled, the old unbounded wait could strand a green pull request open indefinitely.
- The merge itself is no longer pinned to a merge commit: on a repository that disallows one, the agent retries with squash and then rebase instead of stranding the branch. It also merges from the repository root and tears the worktree down before deleting the branch, so the cleanup can't fail on a branch that's still checked out.

## Video generation

- **[issue-3100] New Control mode for local video generation** — feed a control clip (a depth pass, a pose track, edges) alongside your prompt and the render follows its structure and motion instead of inventing them. The reference can be a fresh upload or any prior render from your history, and a strength slider dials how tightly the output tracks it. A half-res preview toggle skips the refinement pass so you can check whether a control clip fits before committing to a full render. Requires an LTX-2 model; the ~654 MB Control weight downloads with progress from the mode panel and is covered by the existing model verify/repair buttons.

## Layered Intelligence

- **[issue-3085] The self-improvement loop can now see whether its approved proposals actually get delivered, not just whether its agent runs finish.** The `cosMetrics` block it reasons over reported per-task-type run success — "did the agent's task complete?" — and nothing about delivery, so a 90% run rate sat there looking healthy beside a pipeline that had landed none of ten approved proposals. That same block now carries a `delivery` figure (approved, delivered, and the current delivery rate) plus a per-scope breakdown, so the two numbers are read side by side. The rate is reported as unknown rather than 0% until something has actually been approved — a loop with no track record shouldn't read as a loop that fails everything.
