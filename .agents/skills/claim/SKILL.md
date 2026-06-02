---
name: claim
description: Claim the next unclaimed PLAN.md item by its [slug] ID, do the work in an isolated worktree, ship a PR, merge it, and clean up. Use when the user asks Codex to claim work, run claim, pick the next PLAN.md item, or implement a specific PLAN.md slug.
argument-hint: "[<slug>] [--review-with=<copilot|codex|gemini|claude>] [--no-review]"
---

# Claim Skill — Pick the next PLAN.md item and ship it

Claim the next unclaimed `- [ ]` item from PLAN.md via the slug-ID system, work it in an isolated worktree, run review, open a PR, merge, and clean up.

**Invocation.** Codex can run this as `$claim`, `$claim <slug>`, `$claim --review-with=codex`, or `$claim --no-review`. If the user says "claim" in natural language, treat the remaining user text as the same argument string.

**How the claim works.** Every PLAN.md checkbox carries a `[<slug>]` ID (see [lib/slashdo/lib/plan-id-format.md](../../../lib/slashdo/lib/plan-id-format.md)). A slug is "in flight" when it appears as a `/`-separated segment in any local or remote branch (`git branch -a`) or any open PR head ref (`gh pr list --state open`). This skill picks the first `- [ ]` whose slug is NOT in flight and creates a `claim/<slug>` branch — that branch name becomes the claim, visible to every other agent and human running this skill.

**Arguments.** Parse the user-provided arguments after `$claim` (or after the natural-language "claim" request) by splitting on whitespace — tokens starting with `--` are flags, the first remaining token is the slug. Either order works (`auth-bug --review-with=codex` and `--review-with=codex auth-bug` are equivalent).

- **`<slug>`** — claim THAT specific item instead of auto-picking. Useful for cherry-picking out-of-order work. The slug must already exist in PLAN.md as a `- [ ]` line; this command never assigns new IDs (that's `$do-replan`'s job).
- **`--review-with=<copilot|codex|gemini|claude>`** — pick which reviewer runs the post-PR review loop in Phase 6. **No default — when omitted, the agent decides in Phase 6 whether the diff warrants an external review at all** (a 3-line value swap doesn't; a multi-file feature change does). Pass this flag explicitly to force a review regardless of the agent's judgment. `copilot` drives the GitHub Copilot review-and-fix loop via `$do-pr`; `codex`/`gemini`/`claude` skip Copilot and run an iterative CLI-based review against the PR diff. Record the parsed value as `REVIEWER` (or `auto` when omitted) and reference it in Phase 6.
- **`--no-review`** — explicit opt-out from BOTH `/simplify` and the external review pass. Use when you want the agent to just ship without deliberation (e.g. a doc-only revert). Mutually exclusive with `--review-with`.

## Phase 1: Pick

1. Read `PLAN.md` from the repo root.
2. **If any `- [ ]` line lacks an `[<slug>]` ID, stop and run `$do-replan` first** — Phase 0 of `$do-replan` populates IDs in one pass, after which `$claim` can find work to claim.
3. Build the in-flight set:
   ```bash
   git fetch --prune 2>/dev/null
   git branch -a --no-color --format='%(refname:short)'
   gh pr list --state open --json headRefName -q '.[].headRefName' 2>/dev/null
   ```
   For every ref in the combined output, split on `/` and collect any segment that exactly matches a slug present in PLAN.md. That's the in-flight set.
4. **Pick the target slug:**
   - **With argument**: the first non-flag argument is the slug. Verify it exists in PLAN.md as a `- [ ]` line and is NOT in flight. If either check fails, print why and stop.
   - **Without argument**: walk PLAN.md top-to-bottom and pick the FIRST `- [ ]` line where ALL of the following are true:
     - The slug is NOT in the in-flight set.
     - The immediately-preceding line does NOT start with `> ⚠️ DRIFT:` (drift-flagged items need a human-driven replan/examine/delete decision via `$do-replan --interactive`, not a fresh implementation).
     - The line does NOT carry the `<!-- NEEDS_INPUT -->` annotation (those are waiting on a user clarification PR).
5. **If no eligible item exists**, print why (all in flight / all drifted / all NEEDS_INPUT / nothing unchecked) and stop. Do NOT brainstorm new work — that's the `feature-ideas` scheduled task's job.

## Phase 2: Claim (worktree) — REQUIRED, NOT OPTIONAL

> `$claim` always uses a worktree so the user can fire off a *second* `$claim` in another tab without the two claims fighting over the main repo's working tree. **A `$claim` without a worktree is a broken claim — it blocks every subsequent claim until cleaned up.**
>
> **Hard rules:**
> - ❌ NEVER run `git checkout -b claim/<slug>` in the main repo. That's the failure mode this phase exists to prevent.
> - ❌ NEVER run `git switch -c claim/<slug>` in the main repo. Same reason.
> - ✅ ALWAYS use `git worktree add` with an explicit absolute path.
> - ✅ ALWAYS `cd` into the worktree and verify with `pwd` before Phase 4. The bash-tool "avoid `cd`" guidance does not apply here — the user has explicitly requested a working-directory change by invoking `$claim`.

Create the worktree on a branch named `claim/<slug>` (the `claim/` prefix is the convention for human-driven TUI sessions; CoS sub-agents use `cos/<task>/<slug>/<agent>`). Both forms place the slug as a `/`-segment, so any agent's in-flight scan sees both.

Run all of these in **a single Bash invocation** so the shell variables stay in scope, and substitute `<picked-slug>` with the real slug from Phase 1:

```bash
SLUG="<picked-slug>" && \
REPO_ROOT="/Users/adameivy/github.com/atomantic/PortOS" && \
WORKTREE="${REPO_ROOT}/data/cos/worktrees/claim-${SLUG}" && \
mkdir -p "${REPO_ROOT}/data/cos/worktrees" && \
cd "${REPO_ROOT}" && \
git fetch origin main && \
git worktree add -b "claim/${SLUG}" "${WORKTREE}" origin/main && \
cd "${WORKTREE}" && \
pwd
```

**Verify the output of `pwd` is exactly `${WORKTREE}`** (i.e. `/Users/adameivy/github.com/atomantic/PortOS/data/cos/worktrees/claim-<slug>`). If `pwd` prints the main repo path instead, the worktree creation or `cd` failed — STOP, report the error to the user, and do not proceed to Phase 3.

**Re-anchor every subsequent Bash call.** Working directory persists between Bash tool calls, but a stray `cd` elsewhere or a fresh shell can drop you back at the main repo silently. Start each later Bash call in this flow with either `cd "${WORKTREE}"` (re-export the variable if needed) or use absolute paths under the worktree. Re-run `pwd` if you're ever unsure.

Stash the absolute worktree path; you'll need it for Phase 7 cleanup.

## Phase 3: Verify still valid

Before writing any code, sanity-check that executing the item as worded won't regress newer work. **Ask the user before proceeding if ANY of these are true:**

- The picked line has a `> ⚠️ DRIFT:` blockquote (you should already have filtered this out, but double-check).
- `git blame -L <line>,<line> -- PLAN.md` on the picked line shows it was added in the last 24 hours AND the diff that added it conflicts with another commit on `main` since. (Drift Agent 5 catches most of this on the prior `$do-replan`, but a fresh-since-replan write is your responsibility.)
- The item description references a function, file, or component that no longer exists or has been heavily rewritten. Run `grep -rn` for the named identifiers — if you can't find them, the item is stale and needs a human-driven re-spec.
- The item depends on a predecessor that hasn't shipped (e.g. "Phase B work" when Phase B isn't done).
- The work would require touching files outside the inferred scope (>5 unrelated files), suggesting the item is bigger than originally estimated.

If you ask the user and they confirm "proceed", continue. If they say "skip", remove the worktree+branch (Phase 7 cleanup) and re-run Phase 1 to pick the next item.

## Phase 4: Implement

Write the code, tests, and any docs the item requires. Follow the repo conventions in [CLAUDE.md](../../../CLAUDE.md) — most importantly:
- No try/catch in route handlers (errors bubble to centralized middleware)
- Functional programming, hooks in React
- Zod validation on all route inputs
- Tailwind design tokens, mobile responsive
- Reactive UI updates (no full refetch after mutations)

Run the relevant test suite as you go (`cd server && npm test -- <area>` for focused runs).

**Commit messages.** Reference the slug in the subject line so the work is grep-able across the changelog, branches, and PR titles:

```
feat([<slug>]): <one-line description>

<optional body>
```

Use `feat:` / `fix:` / `refactor:` / `chore:` / etc. per conventional commit prefixes — PortOS uses these throughout.

## Phase 5: Update PLAN.md

**Remove the item from PLAN.md outright.** The audit trail for shipped work lives in `git log` and `.changelog/` — slashdo v2.18.0 retired the DONE.md archive, and PortOS follows the same convention. Do NOT leave a checked `- [x]` behind in PLAN.md — that's only the convention for items intentionally left as a design log (rejected items, items with rich completion notes the human wants preserved on the active plan, etc.).

1. Remove the picked `- [ ]` line from PLAN.md entirely. If removing it leaves a heading empty, leave the heading alone — section curation is `$do-replan`'s job.
2. **Add an entry to `.changelog/NEXT.md`** capturing what shipped. **Read `.changelog/README.md`'s "Style Rules" section first and follow it** — these entries become public release notes, not a developer journal. Do NOT mirror the prose style of existing dev-heavy entries in `NEXT.md`; many predate the style rules. Lead with the slug in brackets so `git log` and `.changelog/` greps line up:

   ```markdown
   - **[<slug>] <Short, user-facing title>** — <one sentence on the user-visible effect, two if a meaningful "why" needs to land>
   ```

   **Write for a user of the app, not for a coder inside it.** No file paths, no module names, no function/class names, no route paths, no test counts ("85/85 tests pass"), no internal data shapes, no "Touched:" footers, no line numbers. If the change has no user-visible effect (internal refactor, test-only addition, dependency cleanup), keep the entry to one terse sentence under **Changed** describing the maintenance value — don't pad with implementation detail.

   The slug is immutable (per [lib/slashdo/lib/plan-id-format.md](../../../lib/slashdo/lib/plan-id-format.md)). Bracketing it makes the change findable via `git log --grep='<slug>'` and `grep -rn '<slug>' .changelog/`.

Stage both files (`git add PLAN.md .changelog/NEXT.md`) and commit:

```bash
git commit -m "docs([<slug>]): remove from PLAN.md and log to changelog"
```

## Phase 6: Review and ship

**Decide the review intensity before doing any review work.** Three modes; pick exactly one:

In Codex sessions where `/simplify` is not available, skip only that layer and state that it was unavailable; still run the `$do-pr` or `$do-review` local-review gate called for below.

| Mode | Trigger | What runs |
|---|---|---|
| **A. Forced** | `--review-with=<reviewer>` was passed | `/simplify` + the named reviewer's loop (6.2a or 6.2b) — no judgment, the user opted in |
| **B. Forced skip** | `--no-review` was passed | Neither `/simplify` nor an external reviewer runs; only the local-review gate inside `$do-pr` (or a manual `$do-review` if opening the PR by hand) — useful for trivial reverts, doc-only changes |
| **C. Judgment** | Neither flag passed (the common case) | The agent judges whether the diff merits each layer. **`/simplify` and the external review pass are independent decisions** — answer each on its own merits |

**Heuristic for mode C — when to skip:**

| Layer | Skip when | Run when |
|---|---|---|
| **`/simplify`** | Diff is a literal value swap (e.g. `"0"` → `"1"`), a single-line typo/comment fix, a PLAN-only edit, or any change with no new code paths / abstractions / helpers — there's nothing for the reuse/quality/efficiency agents to find | New code (functions, classes, components), new abstractions, refactors that move logic between files, multi-file feature work, anything where reuse opportunities or efficiency concerns plausibly exist |
| **External reviewer** | Same as above PLUS the local-review gate (Tier 1+4 checklist in Phase 6.2) is clean AND the change is mechanically obvious (e.g. matches a published reference or follows an in-repo pattern verbatim) | New logic, security-adjacent code, schema/contract changes, route/handler additions, cross-file changes, anything where a second perspective on the *design* (not just the implementation) is worth a round-trip |

When in mode C, **state the call before acting**: "Diff is N lines across M files, all in <area>; skipping `/simplify` (no new code paths) and external review (matches published reference)." or "Diff adds a new schema + route handler; running `/simplify` and requesting copilot review." This makes the judgment visible to the user so they can override.

When in mode C with `/simplify` deferred but external review wanted, run `/simplify` first anyway — it's the cheaper of the two and may surface fixes that change what the reviewer sees.

1. **`/simplify`** — run iff mode A, or mode C and the heuristic says yes. Fix findings in the same diff (per the `feedback_simplify_after_significant_work` memory). Do this BEFORE opening the PR, not retroactively.

2. **Open the PR and run the review loop.** Pick the branch by `REVIEWER` (the parsed value from `--review-with`, or `auto` when not passed):

   ### 6.2a — `REVIEWER=copilot` OR (`REVIEWER=auto` AND heuristic says review)

   Run **`$do-pr --review-with=copilot`**. It runs `$do-review` as a local-review gate AND drives the Copilot review-and-fix loop. Do NOT run `$do-review` separately first — `$do-pr` does it. Trust the loop. When `$do-pr` reports the PR is clean (zero unresolved Copilot comments, or you've judged the remaining findings to be nitpicks not worth another round), the PR is ready to merge.

   ### 6.2c — `REVIEWER=auto` AND heuristic says skip, OR `--no-review`

   Skip the external review pass. Still run the local-review gate yourself by invoking **`$do-pr`** with NO `--review-with` flag — that runs the Tier 1+4 checklist against the diff (the spec calls this gate "REQUIRED" and it always fires) without requesting Copilot or any CLI reviewer. State the skip rationale ("3-line value swap, matches phosphene's published matrix, no external review") in the merge commit body so the audit trail is honest.

   ### 6.2b — `REVIEWER` is `codex`, `gemini`, or `claude`

   Skip `$do-pr` entirely (it bakes in the Copilot loop). Open the PR manually, then drive an iterative CLI-based review using the chosen reviewer.

   1. **Local review gate** — `/simplify` (step 1) already covered the reuse/quality/efficiency pass. Run `$do-review` here for the full code-review checklist before pushing. Fix anything it finds in the same diff.
   2. **Push and open the PR:**
      ```bash
      git push -u origin "claim/${SLUG}"
      gh pr create --base main --head "claim/${SLUG}" \
        --title "feat([${SLUG}]): <description>" \
        --body "<PR body>"
      ```
      Capture the PR number as `PR_NUM`.
   3. **Pick the CLI invocation for `REVIEWER`:**
      | `REVIEWER` | Command |
      |---|---|
      | `codex`  | `codex exec -` (prompt + diff via stdin) |
      | `gemini` | `gemini -p "$PROMPT"` (diff via stdin) |
      | `claude` | `claude -p - ` (prompt + diff via stdin) |
   4. **Review-and-fix loop — converge to mutual agreement, no iteration cap.** Loop until BOTH the main agent and the review CLI agree the PR is ready to merge. The agent (you) decides when the review is producing real value vs. nit-grade churn; the review CLI decides when nothing actionable remains. Each iteration:
      ```bash
      # 1. Capture the latest diff
      gh pr diff "${PR_NUM}" > /tmp/claim-${SLUG}-pr.diff

      # 2. Build the review prompt — point the CLI at the code-review checklist used by
      #    $do-pr's local gate so findings match the project's convention. Include a
      #    running summary of prior iterations' findings + fixes so the reviewer
      #    doesn't relitigate decisions you've already deferred to PLAN.md, and
      #    ask it to flag PR-blocking severity explicitly.
      cat > /tmp/claim-${SLUG}-prompt.md <<EOF
Review the following PR diff against PortOS conventions in CLAUDE.md and the checklist at lib/slashdo/lib/code-review-checklist.md. Report findings as:
- [SEVERITY] file:line — issue. Suggested fix: ... PR-blocking? (Y/N)
End with a one-line verdict: either "CLEAN — no actionable findings" or "FINDINGS — N actionable items (X PR-blocking)".

Context: iteration <N>. Prior iterations flagged + fixed:
<bulleted summary of prior findings, what got fixed, what got deferred to PLAN.md, what was counter-argued>

--- DIFF ---
$(cat /tmp/claim-${SLUG}-pr.diff)
EOF

      # 3. Run the chosen CLI against the prompt
      <CLI_CMD for REVIEWER> < /tmp/claim-${SLUG}-prompt.md > /tmp/claim-${SLUG}-review.md
      ```

      **Loop-exit decision tree** (your call as the main agent):
      - Review says "CLEAN — no actionable findings" → break the loop, you AND the reviewer agree, proceed to merge.
      - Review has only nit / style / naming findings with no correctness / security / contract / scope impact → record in PLAN.md as follow-ups, break the loop. Note in the merge commit that the reviewer's nits are parked.
      - Review has any PR-blocking finding (correctness bug, silent data loss, security gap, scope-creep risk) → apply the suggested fix in the worktree, commit (`fix([<slug>]): address <reviewer> review`), push, and re-loop with an updated context summary.
      - Review is now relitigating decisions you've already counter-argued or deferred (same finding raised in a prior iter and you chose not to act on it) → break the loop AND restate in the merge commit why each open finding was rejected. Don't get trapped in churn the reviewer thinks is novel.

      **When you're past the point where the reviewer is finding useful issues**, but want one last confirmation before merging, run a final pass with a context summary that lists every prior fix and explicitly asks "is the diff correctness-converged for this PR's scope, or is there anything correctness-critical left that should block merge?" — a CLEAN verdict on that prompt is your green light. The convergence handshake is the goal, not a fixed iteration count.

3. **Encode the slug in the PR title** for grep-ability if it's not already there:
   ```bash
   gh pr edit <num> --title "feat([<slug>]): <description>"
   ```
   (Skip if Phase 6.2 already produced a title that includes the slug.)
4. **Merge:**
   ```bash
   gh pr merge <num> --merge --delete-branch
   ```
   `--delete-branch` removes the remote `claim/<slug>` branch. If you want a squash or rebase merge instead, use `--squash` or `--rebase`.

## Phase 7: Clean up

From the **source repo** (not the worktree). Run as a single Bash invocation, re-substituting the slug and absolute worktree path you stashed in Phase 2:

```bash
SLUG="<picked-slug>" && \
REPO_ROOT="/Users/adameivy/github.com/atomantic/PortOS" && \
WORKTREE="${REPO_ROOT}/data/cos/worktrees/claim-${SLUG}" && \
cd "${REPO_ROOT}" && \
git worktree remove "${WORKTREE}" && \
git branch -d "claim/${SLUG}" && \
git pull --rebase --autostash
```

(`git branch -d` is safe-delete; only fall back to `-D` if you've confirmed there's no unmerged work. `git pull --rebase --autostash` brings the merge commit into local main.)

Print a one-line summary:

```
Shipped [<slug>] <Title>. PR #<num>. Worktree + branch cleaned.
```

## Notes

- **Concurrency model.** PortOS is single-user / single-instance — the worry isn't strangers stomping each other, it's *your own parallel agents* (CoS sub-agents, a second TUI session) picking the same item. The branch+PR scan in Phase 1 catches both.
- **CoS sub-agent coexistence.** CoS scheduled `feature-ideas` and `plan-task` jobs use the branch pattern `cos/<task>/<slug>/<agent>`. The `claim/<slug>` pattern from this command is visible to CoS's `findInProgressIds` scan (and vice versa), so they coexist without locking out each other.
- **Empty pick is not a failure mode.** If every `- [ ]` is in flight, drifted, or NEEDS_INPUT, that's a healthy plan — exit clean and let the user know.
- **No new PLAN.md items.** This command never adds work; it only consumes. New items come from `$do-replan` (Phase 3 suggestions), `feature-ideas` brainstorm (when the plan is empty), or human edits.
