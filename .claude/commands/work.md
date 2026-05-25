# Work on a Task in an Isolated Worktree

Spin up a fresh git worktree off `main` for an isolated branch, `cd` into it, and carry out the requested task there. This keeps the primary checkout (and any uncommitted edits in it) completely undisturbed.

## Task

$ARGUMENTS

## Steps

1. **Derive a slug** from the task description above:
   - Lowercase, kebab-case
   - Strip filler words (a/the/and/for/to/of)
   - Cap at ~5 words / ~40 chars
   - Example: "fix the pipeline issue tombstone bug" → `fix-pipeline-issue-tombstone`

2. **Verify `main` exists and is clean to branch from** (no need to switch to it — `git worktree add` reads any ref):
   ```bash
   git rev-parse --verify main
   ```
   If `main` is not the typical base for this repo, ask the user which base ref to use before continuing.

3. **Create the worktree off `main`** (NOT off the current HEAD — the user wants a clean branch from `main` regardless of what the current checkout is doing):
   ```bash
   git worktree add .claude/worktrees/<slug> -b worktree-<slug> main
   ```
   - Path convention: `.claude/worktrees/<slug>/` (matches existing project layout)
   - Branch name convention: `worktree-<slug>`
   - If the branch already exists, append a short suffix (`-2`, `-3`, …) to both the dir and branch until `git worktree add` succeeds.

4. **`cd` into the new worktree** for the remainder of this session:
   ```bash
   cd .claude/worktrees/<slug>
   ```
   All subsequent tool calls must run from this directory. Confirm with `pwd` and `git branch --show-current` before doing any real work.

5. **Carry out the task.** Implement, test, and commit as appropriate. The originating checkout is untouched — its uncommitted changes, branch, and HEAD are all preserved.

6. **After the task is complete**, *from inside the worktree directory*, always run, in this exact order:
   ```
   /simplify
   /do:review --with codex,gemini
   /do:pr --review-with copilot
   ```
   - `/simplify` first — review the changed code for reuse, quality, and efficiency.
   - Then `/do:review --with codex,gemini` — run the local codex + gemini reviews against the diff and address their findings *before* the PR is opened. Opening the PR first kicks Copilot into a review round against unreviewed code, which wastes Copilot cycles on issues codex/gemini would have caught locally.
   - Finally `/do:pr --review-with copilot` — commit, push the `worktree-<slug>` branch, and open the PR against `main`. Copilot is the only reviewer in the loop here because codex/gemini already ran locally.
   - Run these even if the task description didn't explicitly ask for a PR. The point of the worktree is to land the work as a reviewed PR; skipping these steps defeats the purpose.
   - Do NOT collapse these into a single `/do:pr --review-with codex,gemini,copilot` — opening the PR before the local reviews land triggers Copilot against unreviewed code.

## Guardrails

- **Do NOT** `git stash`, `git add`, `git commit`, `git checkout`, `git reset`, or `git switch` in the originating directory before creating the worktree. `git worktree add` does not require a clean working tree in the originating checkout — it only needs the ref to exist.
- **Do NOT** rebase or modify `main` itself. Only the new `worktree-<slug>` branch should change.
- **Do NOT** create the worktree from the current HEAD or current branch. The base ref is always `main` (or whatever the user confirms in step 2).
- When finished, mention the worktree path and branch name so the user knows where the work lives and can `git worktree remove` it later if desired.
