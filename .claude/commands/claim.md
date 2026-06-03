---
description: Claim the next unclaimed PLAN.md item (or GitHub issue with --issues) by its ID, do the work in an isolated worktree, ship a PR, and clean up.
argument-hint: "[<slug|#issue>] [--issues] [--review-with=<copilot|codex|agy|claude>[,…]] [--no-review]"
---

# Claim — Pick the next PLAN.md item (or GitHub issue) and ship it

Claim the next unclaimed `- [ ]` item from PLAN.md via the slug-ID system — or, with `--issues`, the next open GitHub issue filed by the repo creator — work it in an isolated worktree, run review, open a PR, merge, and clean up.

**Two work sources.** This command reads its work queue from one of two places, selected by the `--issues` flag:

| Source | Selected by | Work unit | Branch | "Done" action | New discovered work goes to |
|---|---|---|---|---|---|
| **PLAN.md** (default) | no `--issues` flag | a `- [ ]` line with a `[<slug>]` ID | `claim/<slug>` | remove the line from PLAN.md + log to `.changelog/NEXT.md` | a new PLAN.md item (only if genuinely large) |
| **GitHub issues** | `--issues` flag | an open issue **filed by the repo creator** | `claim/issue-<num>` | close the issue with a completion comment | a new **GitHub issue** (only if genuinely large) — never PLAN.md |

The two sources never mix in one run. In issues mode, treat `issue-<num>` as the "slug" everywhere the PLAN.md flow says `<slug>` — the worktree (`claim-issue-<num>`), branch (`claim/issue-<num>`), commit/PR-title prefix (`[issue-<num>]`), and in-flight scan all work unchanged because `issue-<num>` is a `/`-segment in the branch name just like a PLAN slug.

**Cross-machine claim marker (issues mode).** A PLAN.md slug becomes a claim the moment the `claim/<slug>` branch exists, but that branch is only *local* until Phase 6 pushes it — so on its own it does NOT protect against a `/claim --issues` running on a **different machine** (a common setup: one user, several federated machines). To close that gap, issues mode marks the claim on GitHub itself, immediately in Phase 2, by **assigning the issue to `@me`** (and adding an `in-progress` label for human visibility). The assignee is visible to every machine the instant it's set, and Phase 1's in-flight scan already treats an assigned issue as taken — so the marker and the reader are two halves of the same mechanism. This is best-effort, not a distributed lock (two machines that pick in the same sub-second window can still collide); it narrows the race to the moment of claiming rather than the whole implementation. Releasing an abandoned claim (Phase 3 skip / Phase 7 abort) removes the assignee so the issue returns to the queue; a successfully merged issue is closed (Phase 6/7) and so is no longer a candidate regardless of assignee.

**How the claim works.** Every PLAN.md checkbox carries a `[<slug>]` ID (see [lib/slashdo/lib/plan-id-format.md](../../lib/slashdo/lib/plan-id-format.md)). A slug is "in flight" when it appears as a `/`-separated segment in any local or remote branch (`git branch -a`) or any open PR head ref (`gh pr list --state open`). This command picks the first `- [ ]` whose slug is NOT in flight and creates a `claim/<slug>` branch — that branch name becomes the claim, visible to every other agent and human running this command.

**Arguments.** Parse `$ARGUMENTS` by splitting on whitespace — tokens starting with `--` are flags, the first remaining non-flag token is the slug. A flag that takes a value accepts **either** form: glued with `=` (`--review-with=codex`) **or** as the next whitespace-separated token (`--review-with codex`) — in the space form, consume the following token as the flag's value (and don't mistake it for the slug). Order is free: `auth-bug --review-with=codex`, `--review-with codex auth-bug`, and `--review-with=codex auth-bug` are all equivalent.

- **`<slug>` / `#<issue>`** — claim THAT specific item instead of auto-picking. Useful for cherry-picking out-of-order work. In PLAN.md mode the token is a slug that must already exist in PLAN.md as a `- [ ]` line (this command never assigns new IDs — that's `/do:replan`'s job). In `--issues` mode the token is an issue number, written either bare (`123`) or with a leading `#` (`#123`); strip the `#` when parsing. The issue must be open and filed by the repo creator (see `--issues` below).
- **`--issues`** — switch the work source from PLAN.md to **GitHub issues**. Auto-pick walks open issues *filed by the repo creator* (the repository owner — resolve with `gh repo view --json owner -q .owner.login`) oldest-first and claims the first one not already in flight. In this mode PLAN.md is never read or edited, and any major issue discovered during code review is filed as a **new GitHub issue** rather than appended to PLAN.md. Mutually compatible with `--review-with` / `--no-review`.
- **`--review-with=<reviewer>[,<reviewer>…]`** — name which reviewer(s) run the post-PR review loop in Phase 6, where each `<reviewer>` is `copilot|codex|agy|claude` (the `agy` slug also accepts the aliases `gemini` and `antigravity`, which normalize to `agy` — the Antigravity CLI's binary, successor to the Gemini CLI). Comma-separate to request several (e.g. `--review-with=claude,codex` runs both review loops and converges when all agree). This flag expresses a **preference, not an absolute mandate**: it says "if a review runs, use these reviewer(s)" and leans strongly toward actually reviewing — but the agent may still skip `/simplify` and/or trim the external pass (down to a single reviewer, or skip it entirely) when the diff is *genuinely trivial* (a literal value swap, a typo/comment fix, a PLAN-only edit, a doc-only revert). Always state any skip/trim and why. **No default — when omitted, the agent decides from scratch in Phase 6 whether the diff warrants `/simplify` and/or an external review at all** (a 3-line value swap doesn't; a multi-file feature change does). `copilot` drives the GitHub Copilot review-and-fix loop via `/do:pr`; `codex`/`agy`/`claude` skip Copilot and run an iterative CLI-based review against the PR diff. Record the parsed value as `REVIEWER` (a list of reviewer names, with any `gemini`/`antigravity` normalized to `agy`; or `auto` when omitted) and reference it in Phase 6.
- **`--no-review`** — explicit opt-out from BOTH `/simplify` and the external review pass. Use when you want the agent to just ship without deliberation (e.g. a doc-only revert). Mutually exclusive with `--review-with`.

## Phase 1: Pick

The in-flight scan is identical in both modes — build it first:

```bash
git fetch --prune 2>/dev/null
git branch -a --no-color --format='%(refname:short)'
gh pr list --state open --json headRefName -q '.[].headRefName' 2>/dev/null
```

For every ref in the combined output, split on `/` and collect every segment — that's the raw in-flight set. In PLAN.md mode you intersect it with the slugs present in PLAN.md; in issues mode you look for `issue-<num>` segments.

### Phase 1 — PLAN.md mode (default, no `--issues`)

1. Read `PLAN.md` from the repo root.
2. **If any `- [ ]` line lacks an `[<slug>]` ID, stop and run `/do:replan` first** — Phase 0 of `/do:replan` populates IDs in one pass, after which `/claim` can find work to claim.
3. From the raw in-flight set above, keep the segments that exactly match a slug present in PLAN.md. That's the in-flight set.
4. **Pick the target slug:**
   - **With argument**: `$ARGUMENTS` (the non-flag token) is the slug. Verify it exists in PLAN.md as a `- [ ]` line and is NOT in flight. If either check fails, print why and stop.
   - **Without argument**: walk PLAN.md top-to-bottom and pick the FIRST `- [ ]` line where ALL of the following are true:
     - The slug is NOT in the in-flight set.
     - The immediately-preceding line does NOT start with `> ⚠️ DRIFT:` (drift-flagged items need a human-driven replan/examine/delete decision via `/do:replan --interactive`, not a fresh implementation).
     - The line does NOT carry the `<!-- NEEDS_INPUT -->` annotation (those are waiting on a user clarification PR).
5. **If no eligible item exists**, print why (all in flight / all drifted / all NEEDS_INPUT / nothing unchecked) and stop. Do NOT brainstorm new work — that's the `feature-ideas` scheduled task's job.

### Phase 1 — issues mode (`--issues`)

1. **Resolve the repo creator** — only issues filed by the repository owner are candidates:
   ```bash
   CREATOR="$(gh repo view --json owner -q .owner.login)"
   ```
   (`gh repo view` reads the `origin` remote; for fork users this is their own login, which is correct — they own the issues on their fork. If you specifically want upstream issues, pass the upstream explicitly: `gh repo view atomantic/PortOS --json owner -q .owner.login`.)
2. **List candidate issues** — open, authored by the creator, no pull-requests (PRs are also issues to the API; `--json` on `gh issue list` already excludes them), oldest-first:
   ```bash
   gh issue list --state open --author "$CREATOR" --limit 100 \
     --json number,title,assignees,labels,createdAt \
     -q 'sort_by(.createdAt) | .[]'
   ```
3. **Determine in-flight issues.** An issue number `N` is in flight if EITHER:
   - `issue-N` appears in the raw in-flight set (a `claim/issue-N` branch or PR head exists), OR
   - the issue already has an assignee (someone — human or agent, on this machine or another — has taken it via the Phase 2 marker below). This assignee check is the cross-machine half of the claim mechanism: a local-only `claim/issue-N` branch on a sibling machine is invisible here, but its assignee is not — so an already-assigned issue must be treated as taken even when no matching branch/PR shows up in the fetch.
4. **Pick the target issue:**
   - **With argument**: the non-flag token is the issue number (strip a leading `#`). Verify it is open, authored by `$CREATOR`, and NOT in flight. If any check fails, print why and stop. (If the user explicitly named an in-flight issue, that's an error — don't silently re-claim it.)
   - **Without argument**: pick the FIRST (oldest) candidate issue that is NOT in flight and does NOT carry a blocking label (`blocked`, `needs-input`, `wontfix`, `discussion`, or any label the repo uses to park issues — skip these and note the skip).
5. **Stash `ISSUE_NUM=<num>` and set `SLUG="issue-${ISSUE_NUM}"`** — every later phase uses `SLUG` for the worktree/branch/commit/PR machinery (unchanged) and `ISSUE_NUM` for the `gh issue` calls (close, cross-reference).
6. **If no eligible issue exists**, print why (none authored by creator / all in flight / all assigned / all blocked-labelled) and stop. Do NOT open new issues here — that only happens for work *discovered while implementing* (Phase 4/6).

## Phase 2: Claim (worktree) — REQUIRED, NOT OPTIONAL

> `/claim` always uses a worktree so the user can fire off a *second* `/claim` in another tab without the two claims fighting over the main repo's working tree. **A `/claim` without a worktree is a broken claim — it blocks every subsequent claim until cleaned up.**
>
> **Hard rules:**
> - ❌ NEVER run `git checkout -b claim/<slug>` in the main repo. That's the failure mode this phase exists to prevent.
> - ❌ NEVER run `git switch -c claim/<slug>` in the main repo. Same reason.
> - ✅ ALWAYS use `git worktree add` with an explicit absolute path.
> - ✅ ALWAYS `cd` into the worktree and verify with `pwd` before Phase 4. The bash-tool "avoid `cd`" guidance does not apply here — the user has explicitly requested a working-directory change by invoking `/claim`.

Create the worktree on a branch named `claim/<slug>` (the `claim/` prefix is the convention for human-driven TUI sessions; CoS sub-agents use `cos/<task>/<slug>/<agent>`). Both forms place the slug as a `/`-segment, so any agent's in-flight scan sees both. **In issues mode `<slug>` is `issue-<num>`** (e.g. branch `claim/issue-123`, worktree `claim-issue-123`) — nothing else in this phase changes.

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

### Phase 2 — mark the issue in progress (issues mode only)

Immediately after the worktree is verified, claim the issue **on GitHub** so a `/claim --issues` on any other machine sees it as taken (the Phase 1 assignee check is the reader for this marker). Do this before writing any code — it's the cross-machine half of the claim and the window you're narrowing is "picked but not yet marked":

```bash
# Required: assign to yourself — this is the signal Phase 1 reads on every machine.
gh issue edit "$ISSUE_NUM" --add-assignee @me

# Optional human-visibility: add an `in-progress` label, creating it if the repo lacks one.
gh label create in-progress --color FFA500 --description "Claimed and being worked" 2>/dev/null || true
gh issue edit "$ISSUE_NUM" --add-label in-progress 2>/dev/null || true
```

The assignee is the load-bearing marker; the label is a convenience for the GitHub UI and may be skipped if `gh label`/`gh issue edit --add-label` is unavailable (the `|| true` keeps a label failure from aborting the claim). **If a step in this phase fails such that you must stop (e.g. worktree creation failed, or `--add-assignee` reported the issue was assigned out from under you by a sibling machine in the race window), release the marker before stopping** — `gh issue edit "$ISSUE_NUM" --remove-assignee @me --remove-label in-progress 2>/dev/null || true` — so a half-claimed issue doesn't get stranded as permanently "taken."

## Phase 3: Verify still valid

Before writing any code, sanity-check that executing the item as worded won't regress newer work. **Ask the user before proceeding if ANY of these are true:**

- **(PLAN.md mode)** The picked line has a `> ⚠️ DRIFT:` blockquote (you should already have filtered this out, but double-check).
- **(PLAN.md mode)** `git blame -L <line>,<line> -- PLAN.md` on the picked line shows it was added in the last 24 hours AND the diff that added it conflicts with another commit on `main` since. (Drift Agent 5 catches most of this on the prior `/do:replan`, but a fresh-since-replan write is your responsibility.)
- **(issues mode)** Read the full issue body and comments — `gh issue view <num> --comments` — before assuming the title captures the ask. If the latest comment supersedes the original request, the issue is already resolved, or the creator asked for clarification that hasn't been answered, ask the user rather than implementing the stale title.
- **(issues mode)** The issue references a function, file, or component that no longer exists or has been heavily rewritten (same staleness check as below), OR the issue is a pure discussion/question with no actionable change — those need a human decision, not an implementation.
- The item description references a function, file, or component that no longer exists or has been heavily rewritten. Run `grep -rn` for the named identifiers — if you can't find them, the item is stale and needs a human-driven re-spec.
- The item depends on a predecessor that hasn't shipped (e.g. "Phase B work" when Phase B isn't done).
- The work would require touching files outside the inferred scope (>5 unrelated files), suggesting the item is bigger than originally estimated.

If you ask the user and they confirm "proceed", continue. If they say "skip", remove the worktree+branch (Phase 7 cleanup) and re-run Phase 1 to pick the next item. **In issues mode, also release the in-progress marker** so the abandoned issue returns to the queue for the next picker (here or on another machine):

```bash
gh issue edit "$ISSUE_NUM" --remove-assignee @me --remove-label in-progress 2>/dev/null || true
```

## Phase 4: Implement

Write the code, tests, and any docs the item requires. Follow the repo conventions in [CLAUDE.md](../../CLAUDE.md) — most importantly:
- No try/catch in route handlers (errors bubble to centralized middleware)
- Functional programming, hooks in React
- Zod validation on all route inputs
- Tailwind design tokens, mobile responsive
- Reactive UI updates (no full refetch after mutations)

Run the relevant test suite as you go (`cd server && npm test -- <area>` for focused runs).

**Roll discovered backbone work INTO this PR — don't defer it.** While implementing (or during the Phase 6 review), you'll often discover a supporting improvement: a helper to extract, a shared abstraction the change should sit on, a small refactor that makes the fix cleaner or pins it with a test. **Default to doing that work in this same PR**, not to filing a new PLAN item. A discovered improvement that *supports* the current item is part of shipping it well — fold it in, test it, mention it in the PR body.

Only defer discovered work when it is **genuinely large** — its own multi-file feature, a migration, a cross-cutting redesign, or anything that warrants its own plan/PR and review cycle. The bar for deferring is "this needs its own PR," not "this is slightly out of the original line-item's wording." When in doubt, roll it in. (This still respects CLAUDE.md's "capture deferred work" rule — that rule is about not *losing* work you decide not to do; this is about preferring to *do* the small supporting work rather than deferring it.)

**Where deferred work lands depends on the mode:**
- **PLAN.md mode** → add a NEW `- [ ]` PLAN.md item (see CLAUDE.md's "capture deferred work" rule for the format).
- **Issues mode** → file a NEW **GitHub issue** instead — never write to PLAN.md in this mode. Use a body that an implementer can pick up cold (file paths, line numbers, why it was split out, and which issue surfaced it), and reference the current issue:
  ```bash
  gh issue create \
    --title "<concise actionable title>" \
    --body "$(printf 'Discovered while working issue #%s.\n\n<context: what, where (file:line), why it needs its own PR>\n' "$ISSUE_NUM")"
  ```
  Filing under your own account is correct — Phase 1's creator-filter only constrains *which* issues `/claim` will auto-pick; it does not stop you from filing new ones. Mention the new issue number in the PR body so the trail is visible.

**Commit messages.** Reference the slug in the subject line so the work is grep-able across the changelog, branches, and PR titles:

```
feat([<slug>]): <one-line description>

<optional body>
```

Use `feat:` / `fix:` / `refactor:` / `chore:` / etc. per conventional commit prefixes — PortOS uses these throughout.

## Phase 5: Record completion + changelog

The audit trail for shipped work lives in `git log` and `.changelog/`. The changelog step is identical in both modes; how you mark the work item "done" differs.

> **Re-sync with `main` BEFORE editing tracked files — required when claims run in parallel.** Every claim touches the same hot `.changelog/NEXT.md` (and, in PLAN.md mode, the "Next Up" list). This worktree was cut from `origin/main` at claim-start (Phase 2); if you edit that **stale** snapshot, your commit will silently *re-add* lines that sibling claims removed while you were working — completed items reappear and get re-claimed as no-op work (an observed, recurring failure). Sync first, from inside the worktree:
>
> ```bash
> cd "${WORKTREE}" && git fetch origin main && git merge --no-edit origin/main
> ```
>
> **Conflict rule — deletions win.** A PLAN.md / `.changelog/NEXT.md` conflict in the "Next Up" region is expected when claims overlap. Resolve it so that **any line removed on *either* side stays removed**, and keep additions from both sides. Then `git add` the resolved files and `git commit --no-edit` to finish the merge. (A clean merge or "Already up to date" needs no action.) Only AFTER this is the working tree fresh enough to edit.

### Phase 5 — mark the work item done

- **PLAN.md mode** — **Remove the picked `- [ ]` line from PLAN.md outright.** slashdo v2.18.0 retired the DONE.md archive and PortOS follows suit. Do NOT leave a checked `- [x]` behind — that's only the convention for items intentionally kept as a design log (rejected items, items with rich completion notes the human wants preserved). If removing the line leaves a heading empty, leave the heading alone — section curation is `/do:replan`'s job.
- **Issues mode** — **Do NOT touch PLAN.md.** Close the issue via the PR instead of editing a file: put `Closes #<num>` in the PR body (Phase 6) so merging auto-closes it. If you prefer to close it explicitly after merge, do it in Phase 7 with `gh issue close <num> --comment "Shipped in PR #<PR_NUM>."`. Either way the issue must end up closed and linked to the PR — don't leave it open after merge.

### Phase 5 — changelog (both modes)

**Add an entry to `.changelog/NEXT.md`** capturing what shipped. **Read `.changelog/README.md`'s "Style Rules" section first and follow it** — these entries become public release notes, not a developer journal. Do NOT mirror the prose style of existing dev-heavy entries in `NEXT.md`; many predate the style rules. Lead with the slug in brackets so `git log` and `.changelog/` greps line up (in issues mode the slug is `issue-<num>`):

```markdown
- **[<slug>] <Short, user-facing title>** — <one sentence on the user-visible effect, two if a meaningful "why" needs to land>
```

**Write for a user of the app, not for a coder inside it.** No file paths, no module names, no function/class names, no route paths, no test counts ("85/85 tests pass"), no internal data shapes, no "Touched:" footers, no line numbers. If the change has no user-visible effect (internal refactor, test-only addition, dependency cleanup), keep the entry to one terse sentence under **Changed** describing the maintenance value — don't pad with implementation detail.

The slug is immutable (per [lib/slashdo/lib/plan-id-format.md](../../lib/slashdo/lib/plan-id-format.md)). Bracketing it makes the change findable via `git log --grep='<slug>'` and `grep -rn '<slug>' .changelog/`.

Stage and commit:

```bash
# PLAN.md mode:
git add PLAN.md .changelog/NEXT.md
git commit -m "docs([<slug>]): remove from PLAN.md and log to changelog"

# Issues mode (no PLAN.md edit):
git add .changelog/NEXT.md
git commit -m "docs([issue-<num>]): log issue #<num> to changelog"
```

## Phase 6: Review and ship

> **Issues mode — link the PR to the issue.** Whichever path opens the PR (`/do:pr` in 6.2a or the manual `gh pr create` in 6.2b), the PR body MUST contain `Closes #<num>` (or `Fixes #<num>`) so merging auto-closes the claimed issue. If you list discovered-but-deferred GitHub issues you filed in Phase 4/6, reference them with plain `#<n>` (do NOT write `Closes` for those — they're follow-ups, not resolved by this PR).
>
> **Issues mode — major code-review findings become GitHub issues, not PLAN.md items.** Any review finding you decide *not* to fix in this PR but that is substantial enough to warrant its own work (a real bug elsewhere, a missing-but-out-of-scope feature, a cross-cutting refactor) gets filed as a NEW GitHub issue (`gh issue create`, same form as Phase 4), referenced in the merge commit. Nit/style findings still just get parked verbally — don't open an issue for a naming preference.

**Decide the review intensity before doing any review work.** Three modes; pick exactly one:

| Mode | Trigger | What runs |
|---|---|---|
| **A. Requested** | `--review-with=<reviewer[,…]>` was passed | **Default:** `/simplify` + each named reviewer's loop (6.2a or 6.2b). The user asked for review, so the bar to skip is HIGH — keep both layers UNLESS the diff is *genuinely trivial* (the heuristic's clearest "skip" cases), in which case you may drop `/simplify` and/or trim the reviewer list (prefer cutting many reviewers down to one over skipping review entirely). State any skip/trim + why. |
| **B. Forced skip** | `--no-review` was passed | Neither `/simplify` nor an external reviewer runs; only the local-review gate inside `/do:pr` (or a manual `/do:review` if opening the PR by hand) — useful for trivial reverts, doc-only changes |
| **C. Judgment** | Neither flag passed (the common case) | The agent judges whether the diff merits each layer. **`/simplify` and the external review pass are independent decisions** — answer each on its own merits |

**Heuristic — when to skip a layer (modes A and C):**

| Layer | Skip when | Run when |
|---|---|---|
| **`/simplify`** | Diff is a literal value swap (e.g. `"0"` → `"1"`), a single-line typo/comment fix, a PLAN-only edit, or any change with no new code paths / abstractions / helpers — there's nothing for the reuse/quality/efficiency agents to find | New code (functions, classes, components), new abstractions, refactors that move logic between files, multi-file feature work, anything where reuse opportunities or efficiency concerns plausibly exist |
| **External reviewer** | Same as above PLUS the local-review gate (Tier 1+4 checklist in Phase 6.2) is clean AND the change is mechanically obvious (e.g. matches a published reference or follows an in-repo pattern verbatim) | New logic, security-adjacent code, schema/contract changes, route/handler additions, cross-file changes, anything where a second perspective on the *design* (not just the implementation) is worth a round-trip |

**The bar differs by mode.** In **mode C** the default is *judgment* — skip freely whenever the "skip when" column applies. In **mode A** the user explicitly asked for review, so the default is *run*: only invoke the "skip when" column for the genuinely-trivial cases, and when a diff is light-but-not-trivial prefer trimming several requested reviewers to one (rather than skipping the external pass altogether).

**State the call before acting** (both modes): "Diff is N lines across M files, all in <area>; skipping `/simplify` (no new code paths) and external review (matches published reference)." or "User requested claude,codex but the diff is a one-line value swap — running just claude, skipping `/simplify`." This makes the judgment visible to the user so they can override.

When `/simplify` is deferred but an external review will run, run `/simplify` first anyway — it's the cheaper of the two and may surface fixes that change what the reviewer sees.

1. **`/simplify`** — run by default in mode A, and in mode C when the heuristic says yes; skip only when the heuristic's "skip when" column applies (in mode A, only its genuinely-trivial cases). Fix findings in the same diff (per the `feedback_simplify_after_significant_work` memory). Do this BEFORE opening the PR, not retroactively.

2. **Open the PR and run the review loop.** First apply any mode-A trim from the heuristic above (e.g. drop a multi-reviewer request to a single reviewer, or skip entirely, for a genuinely-trivial diff) — state the trim. Then dispatch each reviewer left in `REVIEWER` to its branch below: `copilot` → 6.2a; any of `codex`/`agy`/`claude` → 6.2b; `auto` (no flag) resolves to 6.2a or 6.2c by the heuristic. **If `REVIEWER` lists several, run each its own branch and merge only once they ALL converge** (the 6.2b loop generalizes to running every requested CLI reviewer each iteration).

   ### 6.2a — `REVIEWER` includes `copilot`, OR (`REVIEWER=auto` AND heuristic says review)

   Run **`/do:pr --review-with=copilot`**. It runs `/do:review` as a local-review gate AND drives the Copilot review-and-fix loop. Do NOT run `/do:review` separately first — `/do:pr` does it. Trust the loop. When `/do:pr` reports the PR is clean (zero unresolved Copilot comments, or you've judged the remaining findings to be nitpicks not worth another round), the PR is ready to merge.

   ### 6.2c — `REVIEWER` is empty after a trivial-diff trim, OR (`REVIEWER=auto` AND heuristic says skip), OR `--no-review`

   Skip the external review pass. Still run the local-review gate yourself by invoking **`/do:pr`** with NO `--review-with` flag — that runs the Tier 1+4 checklist against the diff (the spec calls this gate "REQUIRED" and it always fires) without requesting Copilot or any CLI reviewer. State the skip rationale ("3-line value swap, matches phosphene's published matrix, no external review"; or "user requested claude,codex but the diff is a one-line value swap — trimmed to no external review") in the merge commit body so the audit trail is honest.

   ### 6.2b — `REVIEWER` includes one or more of `codex`, `agy`, `claude`

   Skip `/do:pr` entirely (it bakes in the Copilot loop). Open the PR manually, then drive an iterative CLI-based review using the chosen reviewer(s). When several CLI reviewers are requested, run each one per iteration (in parallel for the initial pass) and treat the loop as converged only when **all** of them return CLEAN.

   1. **Local review gate** — `/simplify` (step 1) already covered the reuse/quality/efficiency pass. Run `/do:review` here for the full code-review checklist before pushing. Fix anything it finds in the same diff.
   2. **Push and open the PR:**
      ```bash
      git push -u origin "claim/${SLUG}"
      gh pr create --base main --head "claim/${SLUG}" \
        --title "feat([${SLUG}]): <description>" \
        --body "<PR body>"   # issues mode: include a "Closes #<num>" line so merge auto-closes the issue
      ```
      Capture the PR number as `PR_NUM`.
   3. **Pick the CLI invocation per requested reviewer** (run each one when several are requested). **Pass the whole prompt — including the inlined diff — as the prompt ARGUMENT, never via stdin.** `agy -p` (`--print`) and `claude -p` take the prompt as the positional argument right after the flag; piping into them (`… | agy -p`, `agy -p < file`) fails with `agy --print takes the prompt as an argument, not stdin` and wastes an invocation. Build the prompt once with `PROMPT="$(cat /tmp/claim-${SLUG}-prompt.md)"` and pass `"$PROMPT"` as the argument. `codex exec` still *opens* stdin even when the prompt is an argument and will block forever waiting on it, so its row redirects `< /dev/null`:
      | reviewer | Command |
      |---|---|
      | `codex`  | `codex --sandbox danger-full-access exec "$PROMPT" < /dev/null` |
      | `agy`    | `agy --dangerously-skip-permissions -p "$PROMPT"` |
      | `claude` | `claude -p "$PROMPT" --dangerously-skip-permissions` |
   4. **Review-and-fix loop — converge to mutual agreement, no iteration cap.** Loop until the main agent AND every requested review CLI agree the PR is ready to merge. The agent (you) decides when the review is producing real value vs. nit-grade churn; each review CLI decides when nothing actionable remains for it. With multiple reviewers, gather all of their findings each iteration, dedup, and converge only when they are all CLEAN. Each iteration:
      ```bash
      # 1. Capture the latest diff
      gh pr diff "${PR_NUM}" > /tmp/claim-${SLUG}-pr.diff

      # 2. Build the review prompt — point the CLI at the code-review checklist used by
      #    /do:pr's local gate so findings match the project's convention. Include a
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

      # 3. Run the chosen CLI against the prompt — pass it as the ARGUMENT, not via stdin.
      #    (agy/claude -p read the prompt from the argument; `< file` is ignored and agy errors out.)
      PROMPT="$(cat /tmp/claim-${SLUG}-prompt.md)"
      <CLI_CMD for REVIEWER, with "$PROMPT" as the prompt argument per the table above> > /tmp/claim-${SLUG}-review.md
      ```

      **Loop-exit decision tree** (your call as the main agent):
      - Review says "CLEAN — no actionable findings" → break the loop, you AND the reviewer agree, proceed to merge.
      - Review has only nit / style / naming findings with no correctness / security / contract / scope impact → park them as follow-ups (PLAN.md mode: a new `- [ ]` item; issues mode: leave them noted in the merge commit only — don't open a GitHub issue for a nit), break the loop. Note in the merge commit that the reviewer's nits are parked.
      - Review has any PR-blocking finding (correctness bug, silent data loss, security gap, scope-creep risk) → apply the suggested fix in the worktree, commit (`fix([<slug>]): address <reviewer> review`), push, and re-loop with an updated context summary.
      - Review is now relitigating decisions you've already counter-argued or deferred (same finding raised in a prior iter and you chose not to act on it) → break the loop AND restate in the merge commit why each open finding was rejected. Don't get trapped in churn the reviewer thinks is novel.

      **When you're past the point where the reviewer is finding useful issues**, but want one last confirmation before merging, run a final pass with a context summary that lists every prior fix and explicitly asks "is the diff correctness-converged for this PR's scope, or is there anything correctness-critical left that should block merge?" — a CLEAN verdict on that prompt is your green light. The convergence handshake is the goal, not a fixed iteration count.

3. **Encode the slug in the PR title** for grep-ability if it's not already there:
   ```bash
   gh pr edit <num> --title "feat([<slug>]): <description>"
   ```
   (Skip if Phase 6.2 already produced a title that includes the slug.)
4. **Re-sync with `main`, then merge.** A long review loop can let sibling claims merge *after* your Phase-5 sync — re-sync once more so a stale PLAN.md can't resurrect their removed items at merge time. From inside the worktree:
   ```bash
   cd "${WORKTREE}" && git fetch origin main && git merge --no-edit origin/main
   # Resolve any PLAN.md / .changelog/NEXT.md conflict deletions-win (same rule as Phase 5), then:
   git push
   gh pr merge <num> --merge --delete-branch
   ```
   If the merge changed nothing, `git push` is a no-op and the PR merges as before. `--delete-branch` removes the remote `claim/<slug>` branch. If you want a squash or rebase merge instead, use `--squash` or `--rebase`.

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

**Issues mode — confirm the issue is closed, then clear the in-progress marker.** If the PR body carried `Closes #<num>`, the merge already closed it (the `Closes`/`Fixes` keyword auto-closes only on a merge to the **default branch** — PortOS merges `claim/*` into `main`, the default, so this fires; a non-default base or a missing keyword does not). Verify with `gh issue view <num> --json state -q .state` (expect `CLOSED`); if it's still `OPEN`, close it explicitly: `gh issue close <num> --comment "Shipped in PR #<num>."`. Then drop the now-stale label so a closed issue doesn't keep advertising itself as in progress:

```bash
gh issue edit "$ISSUE_NUM" --remove-label in-progress 2>/dev/null || true
```

(Leave the assignee on the closed issue — it's a useful record of who shipped it, and a closed issue is never a Phase 1 candidate regardless.)

Print a one-line summary:

```
# PLAN.md mode:
Shipped [<slug>] <Title>. PR #<num>. Worktree + branch cleaned.

# Issues mode:
Shipped issue #<num> "<Title>". PR #<PR_NUM>. Issue closed. Worktree + branch cleaned.
```

## Notes

- **Concurrency model.** PortOS is single-user / single-instance — the worry isn't strangers stomping each other, it's *your own parallel agents* (CoS sub-agents, a second TUI session) picking the same item. The branch+PR scan in Phase 1 catches both.
- **CoS sub-agent coexistence.** CoS scheduled `feature-ideas` and `plan-task` jobs use the branch pattern `cos/<task>/<slug>/<agent>`. The `claim/<slug>` pattern from this command is visible to CoS's `findInProgressIds` scan (and vice versa), so they coexist without locking out each other.
- **Empty pick is not a failure mode.** If every `- [ ]` is in flight, drifted, or NEEDS_INPUT (PLAN.md mode), or every creator-authored issue is in flight / assigned / blocked-labelled (issues mode), that's a healthy queue — exit clean and let the user know.
- **No new PLAN.md items.** This command never adds work to its *own* queue from thin air; it only consumes. New PLAN.md items come from `/do:replan` (Phase 3 suggestions), `feature-ideas` brainstorm (when the plan is empty), or human edits. The exception in both modes is *discovered* work split out of the current item (Phase 4/6): PLAN.md mode files it as a new PLAN item, issues mode files it as a new GitHub issue.
- **Issues mode — the in-progress marker is the cross-machine claim.** Phase 2 assigns the issue to `@me` (and labels it `in-progress`) the instant the worktree is verified; Phase 1 on every machine treats an assigned issue as in flight. This is what stops a `/claim --issues` on a *second machine* from grabbing an issue this machine is already working — the local `claim/issue-<num>` branch alone can't, since it isn't pushed until Phase 6. The marker is best-effort (two machines picking within the same sub-second window can still both assign), not a distributed lock; it shrinks the collision window to the moment of claiming. Abandoned claims release the marker (Phase 3/7); shipped issues close (Phase 6/7).
- **Issues mode — creator-only is a hard filter.** Auto-pick and the explicit-`#num` path both reject issues NOT authored by the repo owner (`gh repo view --json owner -q .owner.login`). This keeps `/claim --issues` from acting on community/bot-filed issues without a human triaging them first — those are surfaced by `/do:replan`, not auto-claimed.
