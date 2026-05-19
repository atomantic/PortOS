---
description: Claim the next unclaimed PLAN.md item by its [slug] ID, do the work in an isolated worktree, ship a PR, and clean up.
argument-hint: "[<slug>]"
---

# Claim — Pick the next PLAN.md item and ship it

Claim the next unclaimed `- [ ]` item from PLAN.md via the slug-ID system, work it in an isolated worktree, run review, open a PR, merge, and clean up.

**How the claim works.** Every PLAN.md checkbox carries a `[<slug>]` ID (see [lib/slashdo/lib/plan-id-format.md](../../lib/slashdo/lib/plan-id-format.md)). A slug is "in flight" when it appears as a `/`-separated segment in any local or remote branch (`git branch -a`) or any open PR head ref (`gh pr list --state open`). This command picks the first `- [ ]` whose slug is NOT in flight and creates a `claim/<slug>` branch — that branch name becomes the claim, visible to every other agent and human running this command.

**Argument.** If you pass `$ARGUMENTS` as a slug, claim THAT specific item instead of auto-picking — useful for cherry-picking out-of-order work. The slug must already exist in PLAN.md as a `- [ ]` line; this command never assigns new IDs (that's `/do:replan`'s job).

## Phase 1: Pick

1. Read `PLAN.md` and `DONE.md` from the repo root.
2. **If any `- [ ]` line lacks an `[<slug>]` ID, stop and run `/do:replan` first** — Phase 0 of `/do:replan` populates IDs in one pass, after which `/claim` can find work to claim.
3. Build the in-flight set:
   ```bash
   git fetch --prune 2>/dev/null
   git branch -a --no-color --format='%(refname:short)'
   gh pr list --state open --json headRefName -q '.[].headRefName' 2>/dev/null
   ```
   For every ref in the combined output, split on `/` and collect any segment that exactly matches a slug present in PLAN.md. That's the in-flight set.
4. **Pick the target slug:**
   - **With argument**: `$ARGUMENTS` is the slug. Verify it exists in PLAN.md as a `- [ ]` line and is NOT in flight. If either check fails, print why and stop.
   - **Without argument**: walk PLAN.md top-to-bottom and pick the FIRST `- [ ]` line where ALL of the following are true:
     - The slug is NOT in the in-flight set.
     - The immediately-preceding line does NOT start with `> ⚠️ DRIFT:` (drift-flagged items need a human-driven replan/examine/delete decision via `/do:replan --interactive`, not a fresh implementation).
     - The line does NOT carry the `<!-- NEEDS_INPUT -->` annotation (those are waiting on a user clarification PR).
5. **If no eligible item exists**, print why (all in flight / all drifted / all NEEDS_INPUT / nothing unchecked) and stop. Do NOT brainstorm new work — that's the `feature-ideas` scheduled task's job.

## Phase 2: Claim (worktree)

Create the worktree on a branch named `claim/<slug>` (the `claim/` prefix is the convention for human-driven TUI sessions; CoS sub-agents use `cos/<task>/<slug>/<agent>`). Both forms place the slug as a `/`-segment, so any agent's in-flight scan sees both.

```bash
SLUG=<picked-slug>
WORKTREE="data/cos/worktrees/claim-${SLUG}"
git fetch origin main
git worktree add -b "claim/${SLUG}" "${WORKTREE}" origin/main
cd "${WORKTREE}"
```

If `data/cos/worktrees/` doesn't exist, create it (`mkdir -p`). Stash the worktree path; you'll need it for cleanup.

## Phase 3: Verify still valid

Before writing any code, sanity-check that executing the item as worded won't regress newer work. **Ask the user before proceeding if ANY of these are true:**

- The picked line has a `> ⚠️ DRIFT:` blockquote (you should already have filtered this out, but double-check).
- `git blame -L <line>,<line> -- PLAN.md` on the picked line shows it was added in the last 24 hours AND the diff that added it conflicts with another commit on `main` since. (Drift Agent 5 catches most of this on the prior `/do:replan`, but a fresh-since-replan write is your responsibility.)
- The item description references a function, file, or component that no longer exists or has been heavily rewritten. Run `grep -rn` for the named identifiers — if you can't find them, the item is stale and needs a human-driven re-spec.
- The item depends on a predecessor that hasn't shipped (e.g. "Phase B work" when Phase B isn't done).
- The work would require touching files outside the inferred scope (>5 unrelated files), suggesting the item is bigger than originally estimated.

If you ask the user and they confirm "proceed", continue. If they say "skip", remove the worktree+branch (Phase 7 cleanup) and re-run Phase 1 to pick the next item.

## Phase 4: Implement

Write the code, tests, and any docs the item requires. Follow the repo conventions in [CLAUDE.md](../../CLAUDE.md) — most importantly:
- No try/catch in route handlers (errors bubble to centralized middleware)
- Functional programming, hooks in React
- Zod validation on all route inputs
- Tailwind design tokens, mobile responsive
- Reactive UI updates (no full refetch after mutations)

Run the relevant test suite as you go (`cd server && npm test -- <area>` for focused runs).

**Commit messages.** Reference the slug in the subject line so the work is grep-able across DONE.md, branches, and PR titles:

```
feat([<slug>]): <one-line description>

<optional body>
```

Use `feat:` / `fix:` / `refactor:` / `chore:` / etc. per conventional commit prefixes — PortOS uses these throughout.

## Phase 5: Update PLAN.md and DONE.md

**Move the item out of PLAN.md and into DONE.md.** Do NOT leave a checked `- [x]` behind in PLAN.md — that's only the convention for items intentionally left as a design log (rejected items, shipped items with rich completion notes, etc.).

1. Remove the picked `- [ ]` line from PLAN.md entirely. If removing it leaves a heading empty, leave the heading alone — section curation is `/do:replan`'s job.
2. Append to DONE.md under today's date heading (`## YYYY-MM-DD`). Insert today's heading directly below the top-of-file preamble if it doesn't exist yet.
3. Entry shape — **slug lifted verbatim from PLAN.md, never re-derived from the description**:

   ```markdown
   - **[<slug>] <Title from the PLAN.md line>** — <1–3 sentences on what shipped, key files touched, any caveats>
   ```

   The slug is immutable (per [lib/slashdo/lib/plan-id-format.md](../../lib/slashdo/lib/plan-id-format.md)). The bold-wrapped title format makes the slug greppable across DONE.md and lets the next `/do:replan` Phase 0 collision scan parse the line deterministically.

Stage both files (`git add PLAN.md DONE.md`) and commit:

```bash
git commit -m "docs([<slug>]): archive to DONE.md"
```

## Phase 6: Review and ship

1. **`/simplify`** — run the three-agent reuse/quality/efficiency review against your own diff and fix findings in the same diff (per the `feedback_simplify_after_significant_work` memory). Do this BEFORE opening the PR, not retroactively.
2. **`/do:pr`** — this command already runs `/do:review` as its local-review gate AND drives the Copilot review-and-fix loop. Do NOT run `/do:review` separately first — `/do:pr` does it. Trust the loop.
3. When `/do:pr` reports the PR is clean (zero unresolved Copilot comments, or you've judged the remaining findings to be nitpicks not worth another round), the PR is ready to merge.
4. **Encode the slug in the PR title** for grep-ability — `/do:pr` doesn't do this automatically:
   ```bash
   gh pr edit <num> --title "feat([<slug>]): <description>"
   ```
   (Skip this step if `/do:pr` already produced a title that includes the slug.)
5. **Merge:**
   ```bash
   gh pr merge <num> --merge --delete-branch
   ```
   `--delete-branch` removes the remote `claim/<slug>` branch. If you want a squash or rebase merge instead, use `--squash` or `--rebase`.

## Phase 7: Clean up

From the **source repo** (not the worktree — `cd` back to `/Users/adameivy/github.com/atomantic/PortOS` first):

```bash
git worktree remove "${WORKTREE}"
git branch -d "claim/${SLUG}"   # safe-delete; -D only if you know there's unmerged work
git pull --rebase --autostash    # pull the merge commit into local main
```

Print a one-line summary:

```
Shipped [<slug>] <Title>. PR #<num>. Worktree + branch cleaned.
```

## Notes

- **Concurrency model.** PortOS is single-user / single-instance — the worry isn't strangers stomping each other, it's *your own parallel agents* (CoS sub-agents, a second TUI session) picking the same item. The branch+PR scan in Phase 1 catches both.
- **CoS sub-agent coexistence.** CoS scheduled `feature-ideas` and `plan-task` jobs use the branch pattern `cos/<task>/<slug>/<agent>`. The `claim/<slug>` pattern from this command is visible to CoS's `findInProgressIds` scan (and vice versa), so they coexist without locking out each other.
- **Empty pick is not a failure mode.** If every `- [ ]` is in flight, drifted, or NEEDS_INPUT, that's a healthy plan — exit clean and let the user know.
- **No new PLAN.md items.** This command never adds work; it only consumes. New items come from `/do:replan` (Phase 3 suggestions), `feature-ideas` brainstorm (when the plan is empty), or human edits.
