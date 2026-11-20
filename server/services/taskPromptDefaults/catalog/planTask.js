import { MANAGED_WORKTREE_CLEANUP_CONTRACT, buildManagedGithubMergeScript } from '../../../lib/mergeGateContract.js';
import { REQUIRED_CI_LATE_REGISTRATION_NOTE, REQUIRED_REVIEW_PUBLICATION_RULE } from './guidance.js';
import { REVIEW_UNAVAILABLE_REPORTING_NOTE, FORGE_REVIEWER_WAIT_NOTE } from '../../../lib/reviewerConfig.js';

// Shared by the scheduled 'plan-task' and the manual 'plan-task-claim' prompts:
// they differ only in Phase 6 (the claim flow adds the local review loop).
const PLAN_TASK_PHASES_1_TO_5 = `[Plan Task: {appName}] Claim and ship next PLAN.md item

Pick the next available unclaimed PLAN.md item by its \`[<slug>]\` ID, **create your own worktree at \`claim/<slug>\`**, implement, ship a PR, and clean up. Mirrors the \`/claim\` slash command — same in-flight scan, same branch naming, same no-local-merge cleanup. **YOU pick the item in Phase 1 — the scheduler does not reserve one for you.** Picking at execution time and immediately creating the \`claim/<slug>\` branch **narrows** the window for two concurrent runs to collide on the same slug — it does NOT eliminate it: two runs can still complete Phase 1 before either creates a branch, then race at \`git worktree add\`. That race is handled in Phase 2 — the loser re-picks the next item. (A dispatch-time pre-pick is strictly worse: it commits both runs to the same slug long before any branch exists.) Do NOT modify files in the source repo directly; ALL editing happens inside the worktree you create.

**How claiming works.** Every PLAN.md checkbox carries a \`[<slug>]\` ID. A slug is "in flight" when it appears as the slug-position segment in either a \`claim/<slug>\` ref (the human/TUI pattern) or a \`cos/<task>/<slug>/<agent>\` ref (the CoS sub-agent pattern) — across local branches, remote branches, or open PR head refs. The \`claim/<slug>\` branch you create IS the claim, visible to every other agent and to the human running \`/claim\` in a TUI.

## Phase 1 — Pick the target slug

Run steps 1–5 in order.

1. Read PLAN.md from the repo root.
2. **If any \`- [ ]\` line lacks an \`[<slug>]\` ID, stop and exit cleanly** — \`do-replan\` populates IDs in one pass; without IDs, this task has nothing to claim.
3. Build the in-flight set. Collect every ref from these sources:
   \`\`\`bash
   git fetch --prune 2>/dev/null
   git branch -a --no-color --format='%(refname:short)'
   gh pr list --state open --json headRefName -q '.[].headRefName' 2>/dev/null
   \`\`\`
   For each ref, extract the slug **only when the ref matches one of these documented patterns** (after stripping any leading remote prefix like \`origin/\` or \`upstream/\`):
   - \`claim/<slug>\` — the slug is everything after \`claim/\`.
   - \`cos/<task>/<slug>/<agent>\` — the slug is the third \`/\`-separated segment.

   A slug is "in flight" iff it appears in a ref matching one of those patterns AND is present in PLAN.md. **Do NOT** flag a slug just because the bare word appears as some other segment of a ref — that would falsely flag any slug literally named \`main\`, \`fix\`, \`feature\`, \`release\`, \`dev\`, etc. against virtually every branch in the repo.
4. **Pick the target slug:** walk PLAN.md top-to-bottom and pick the FIRST \`- [ ]\` line where ALL of the following are true:
   - The slug is NOT in the in-flight set.
   - The immediately-preceding line does NOT start with \`> ⚠️ DRIFT:\`.
   - The line does NOT carry the \`<!-- NEEDS_INPUT -->\` annotation.
5. **If no eligible item exists**, exit cleanly — that's a healthy plan state, not a failure. Brainstorming is handled by the \`feature-ideas\` task; do NOT add new items here.

Capture the exact text of the selected item (without the leading \`- [ ]\`) verbatim, **including its \`[<slug>]\` ID** — the changelog entry will reuse both.

## Phase 2 — Claim (worktree)

Create the worktree on a branch named \`claim/<slug>\`. This branch name is the claim — once created and pushed, no other agent or \`/claim\` session will pick the same slug. Do all editing inside the worktree, NEVER in the source repo's working tree (which may have the user's in-flight work).

\`\`\`bash
SLUG=<picked-slug>
WORKTREE="{worktreesRoot}/claim-{appSlug}-\${SLUG}"
mkdir -p {worktreesRoot}
git fetch origin main
git worktree add --no-track -b "claim/\${SLUG}" "\${WORKTREE}" origin/main
# Link the source checkout's node_modules so tests run in the worktree (never npm install there):
node "{portosRoot}/scripts/link-worktree-deps.js" "{repoPath}" "\${WORKTREE}"
cd "\${WORKTREE}"
\`\`\`

**If the worktree-creation command fails because the claim/<slug> branch already exists** (a concurrent run won the branch-creation race, or a remote claim/<slug> is now visible), do NOT force or reuse it — that branch IS another run's claim. Treat the slug as in-flight, return to Phase 1, and pick the next eligible item; if nothing else is eligible, exit cleanly.

Stash the worktree path; you'll need it for Phase 7 cleanup.

## Phase 3 — Verify still valid

Before writing any code, sanity-check that executing the item won't regress newer work. **If ANY of these are true, jump to Phase 3b** (clarification path, not implementation):

- The picked line is preceded by a \`> ⚠️ DRIFT:\` blockquote (you should already have filtered it; double-check).
- The item description references a function, file, or component that no longer exists. Run \`grep -rn\` for the named identifiers — if they're gone, the item is stale.
- The item depends on a predecessor that hasn't shipped (e.g. "Phase B work" when Phase B isn't done).
- The work would require touching files outside the inferred scope (>5 unrelated files), suggesting the item is bigger than originally estimated.

Otherwise: **ambiguity is not a reason to jump to Phase 3b — decide.** If the item merely leaves a design choice unstated or is open to more than one reasonable reading, pick the most reasonable interpretation, note the approach you chose in the commit/PR, and proceed to Phase 4. Jump to Phase 3b ONLY when proceeding would be destructive/irreversible, or genuinely requires the human — specific hardware/credentials you don't have, or a judgment only they can make (the same narrow bar as a \`blocked\` item). The user would rather iterate on top of a shipped best-guess than have the item parked waiting on a decision they didn't ask to make.

## Phase 3b — Request Clarification (alternative exit from Phase 3)

Done from INSIDE the worktree (you've already created \`claim/<slug>\` in Phase 2):

1. Create \`.plan-questions.md\` in the worktree:
   \`\`\`
   # Plan Question: <short title summarizing the PLAN.md item>

   ## PLAN.md Item
   <the exact text of the unchecked item, including its [<slug>]>

   ## Questions
   - <question 1>
   - <question 2>
   \`\`\`
2. **Move the unchecked item to the bottom of PLAN.md and annotate it with \` <!-- NEEDS_INPUT -->\`** — remove from its current position and append at the end with the annotation, **preserving the \`[<slug>]\` ID**. This keeps the queue moving so the next \`plan-task\` run picks a different actionable item.
3. Commit, push the branch (\`git push -u origin claim/<slug>\`), and open a PR with \`gh pr create\` so the user can see the questions. **Do NOT merge** — the user resolves \`.plan-questions.md\` first.
4. Preserve the exact checkout, local branch and remote branch for the clarification handoff. This PR is intentionally unmerged: do not remove or unlock its worktree, delete refs, or invoke merged retirement. Report the retained path and unresolved questions.

After Phase 3b runs, **exit** — do NOT proceed to Phase 4. The implementing path resumes only when the user reopens the slug post-clarification.

## Phase 4 — Implement

Write the code, tests, and any docs the item requires. Follow the repo conventions in AGENTS.md / CLAUDE.md (no try/catch in route handlers, functional programming, Zod validation, Tailwind tokens, reactive UI updates).

Run the relevant test suite as you go.

**Commit messages reference the slug** so the work is grep-able across the changelog, branches, and PR titles:

\`\`\`
<type>([<slug>]): <one-line description>

<optional body>
\`\`\`

Use \`feat:\` / \`fix:\` / \`refactor:\` / \`chore:\` / etc. (The bracketed-scope form \`([<slug>])\` is intentional and matches the project's existing convention — grep \`git log --oneline\` for prior examples. The brackets carry the PLAN.md \`[<slug>]\` ID syntax through to commits, branches, and PRs so a single slug grep finds the whole trail.)

## Phase 5 — Update PLAN.md and the changelog

**Remove the item from PLAN.md outright.** The audit trail for shipped work lives in \`git log\` and the project's changelog (however that repo keeps it) — do NOT archive to a \`DONE.md\`, that file has been retired. Do NOT leave a checked \`- [x]\` behind in PLAN.md.

1. Remove the picked \`- [ ]\` line from PLAN.md entirely. If removing it leaves a heading empty, leave the heading alone — section curation is \`do-replan\`'s job.
2. Record the shipped item in the repo's changelog, **following the convention that repo documents** — read its \`AGENTS.md\` (or \`CLAUDE.md\`) and changelog README (e.g. \`.changelog/README.md\`) BEFORE writing anything. Some repos collect per-branch fragments in a directory (e.g. \`.changelog/next/\`) via a helper script rather than appending to one shared file, precisely so parallel agents don't conflict on every merge. When such a convention is documented, use it — run the documented command and remember the fragment file it created as \`CHANGELOG_FILE\`.

   Only when no convention is documented, detect a changelog file (in this order — pick the first match) and append an entry there:
   - \`.changelog/NEXT.md\` (staged-release file)
   - \`CHANGELOG.md\` at repo root with an \`## Unreleased\` or \`## [Unreleased]\` heading
   - any other \`changelog\`-shaped file the repo already maintains (look at recent \`git log\` for examples of where prior entries landed)

   Either way, mirror the prose style of recent entries; lead with the slug in brackets so \`git log --grep='<slug>'\` and changelog greps line up:

   \`\`\`markdown
   - **[<slug>] <Title from the PLAN.md line>** — <1–3 sentences on what shipped, key files touched, any caveats>
   \`\`\`

   Remember the exact path you wrote to as \`CHANGELOG_FILE\` — you'll stage it in step 3. If the repo has no changelog at all, skip this step and leave \`CHANGELOG_FILE\` unset; the commit message + \`git log\` becomes the audit trail.

3. Stage PLAN.md plus the changelog file you actually edited (if any) and commit. **Do NOT use a glob or a swallow-on-failure fallback** — staging the exact file you edited is what keeps the audit trail honest:

   \`\`\`bash
   git add PLAN.md
   [ -n "$CHANGELOG_FILE" ] && git add "$CHANGELOG_FILE"
   git commit -m "docs([<slug>]): remove from PLAN.md and log to changelog"
   \`\`\``;

const PLAN_TASK_CLEANUP = `## Phase 7 — Clean up (post-merge ONLY)

This phase runs only after the PR was merged via Phase 6. If you exited via Phase 3b instead, you retained the checkout for clarification — do NOT also run Phase 7.

${MANAGED_WORKTREE_CLEANUP_CONTRACT}

**Do NOT \`git pull\` from inside this phase** (no \`--rebase\`, no \`--autostash\`, no plain \`pull\`). The agent's work is already integrated on GitHub via \`gh pr merge\`; pulling locally provides no functional benefit and risks rebasing the user's in-progress branch / shuffling their uncommitted changes through stash if the source repo HEAD happens to be on a tracking feature branch when the agent runs. Leave the user's working tree alone.

_(Phase 3b is defined above, right after Phase 3 — see the "alternative exit from Phase 3" section.)_`;

export const prompts = {
  'plan-task': `${PLAN_TASK_PHASES_1_TO_5}

## Phase 6 — Open the PR and ship

1. Push the branch: \`git push -u origin claim/<slug>\`.
2. Open the PR with \`gh pr create\` — title MUST encode the slug: \`<type>([<slug>]): <description>\`. Body should summarize what shipped + test plan.
3. **Wait for required CI before merging.** Run \`gh pr checks <num> --required --watch --fail-fast\` — REQUIRED checks only, so optional jobs cannot stall the merge. ${REQUIRED_CI_LATE_REGISTRATION_NOTE} If a required check stays red, comment on the PR naming the failure, remove only the worktree, and leave the branch and PR for reconciliation.
4. **Merge immediately via \`gh pr merge\`** — NEVER a local merge and NEVER \`--auto\`. Select merge, squash or rebase only from verified allowed repository methods. An unreadable state or unconfirmed mutation stops this phase; no write is retried with another method:
   \`\`\`bash
${buildManagedGithubMergeScript()}
   \`\`\`
   The exact comparison must succeed. Investigate and retry on \`OPEN\`; \`CLOSED\` is not success. Do not enter Phase 7 until remote state is exactly \`MERGED\`.

${PLAN_TASK_CLEANUP}`,

  // plan-task-claim: the manual /do:next PLAN claim owns the complete claim
  // lifecycle (local review + verified merge), unlike the scheduled plan-task
  // default above, which intentionally omits the review loop. Kept as its own
  // key -- not read off the retired plan-task history --
  // so it can be revised without editing a preserved historical body the
  // integrity snapshot pins (issue #6479). Never persisted to a schedule; see
  // UNPERSISTED_PROMPT_KEYS in taskPromptDefaults.test.js.
  'plan-task-claim': `${PLAN_TASK_PHASES_1_TO_5}

## Phase 6 — Review locally, then open the PR and ship

${REQUIRED_REVIEW_PUBLICATION_RULE}

The configured reviewers for this task, in order, are \`{reviewers}\`. Split them by where they can run, preserving order: **LOCAL reviewers** — every token that is NOT an \`@<login>\` (\`claude\` / \`codex\` / \`antigravity\` (CLI binary: \`agy\`) / \`grok\` / \`cursor\` invoke a local-CLI critique; \`lmstudio\` / \`ollama\` use the appended Local Reviewer Procedure) read the working tree and need no PR, so they run BEFORE the PR is opened. **PR-SIDE reviewers** — every \`@<login>\` token, plus any review bot the repo requests automatically on open — review cloud-side, so they can only run once the PR exists. Open the PR only when the branch is already review-clean (or a reviewer's \`~max\` budget is spent with its findings fixed or rejected/tracked and disclosed, or a required reviewer is recorded as review-blocked) and all that remains is CI plus those PR-side reviewers.

1. **Self-review your diff for reuse, quality, and efficiency** (DRY, dead code, naming, simpler equivalents, missed edge cases) and fix findings in the same diff — BEFORE opening the PR, not retroactively. Claude Code runs this as the three-agent \`/simplify\` pass; on other CLIs, do the equivalent review by hand.
2. **Run each LOCAL reviewer in order against the BRANCH diff, not a PR diff.** No PR exists yet, so use the CLI's own base-diff mode or \`git diff origin/main...HEAD\` (substitute the repo's default branch when it isn't \`main\`); local LLM reviewers go through the appended endpoint procedure. Apply the fixes, run the tests, and commit them — capped at that reviewer's \`~max=<n>\` budget from the reviewer list (3 rounds when it carries none; the Review round caps note below restates configured budgets) — then advance. A missing CLI, quota/provider or transport failure, timeout, malformed response, empty response, or no-verdict result from a REQUIRED reviewer is unavailable, not clean: do NOT substitute your own self-review; record \`REVIEW_STATUS=review-blocked\` in the worktree-private status file and continue to step 3 when the code and tests are otherwise shippable. An optional reviewer (~opt) is non-blocking: a provider error, quota limit, timeout, or missing verdict from an optional reviewer must NEVER record REVIEW_STATUS=review-blocked (leave REVIEW_STATUS=clean) and does not prevent merge. A spent reviewer budget with findings still open is NOT a stop: fix each accepted finding or reject/track it with concrete rationale, then open the PR and disclose in its body the rounds each reviewer ran, the revision it last reviewed and what remained — never an invented approval. Only fixes that leave the build/tests red mean do NOT open a PR — leave the branch and worktree in place, report the reviewer and the failure, and stop. Reviewer unavailability alone is review-blocked, so it does not take this stop path.
3. Push the branch: \`git push -u origin claim/<slug>\`, then confirm \`git log --oneline @{u}..HEAD\` is empty so every review fix from step 2 is in the PR's diff.
4. Open the PR with \`gh pr create\` — title MUST encode the slug: \`<type>([<slug>]): <description>\`. Body should summarize what shipped + test plan.
4a. Read the review status back — shell variables do not survive between calls, so run \`REVIEW_STATUS_FILE="$(git rev-parse --git-path portos-review-status)"\` and source it. If \`REVIEW_STATUS=review-blocked\` from a required reviewer, preserve the claim branch, leave the PR open, and stop before the PR-side review, CI, or merge steps. ${REVIEW_UNAVAILABLE_REPORTING_NOTE} If all configured reviewers were optional (~opt), REVIEW_STATUS must not block the merge.
5. **Satisfy the PR-SIDE reviewers and CI before merging.** Request each \`@<login>\` (\`gh pr edit <num> --add-reviewer <login>\`, drop the \`@\`) and address the findings — push fixes, capped at each reviewer's \`~max=<n>\` budget (3 rounds when it carries none); their approval gates the merge. ${FORGE_REVIEWER_WAIT_NOTE} Wait out any auto-requested review bot the same way, then let required CI finish (\`gh pr checks <num> --required --watch --fail-fast\` — REQUIRED checks only, so an optional job can't stall the merge). ${REQUIRED_CI_LATE_REGISTRATION_NOTE} If a required reviewer stays unsatisfied (an optional reviewer whose budget is spent is not unsatisfied) or a required check stays red, comment on the PR naming the failure, remove only the worktree, and leave the branch and PR for reconciliation.

6. **Merge immediately via \`gh pr merge\`** — NEVER a local merge and NEVER \`--auto\`. Select merge, squash or rebase only from verified allowed repository methods. An unreadable state or unconfirmed mutation stops this phase; no write is retried with another method:
   \`\`\`bash
${buildManagedGithubMergeScript()}
   \`\`\`
   The exact comparison must succeed. Investigate and retry on \`OPEN\`; \`CLOSED\` is not success. Do not enter Phase 7 until remote state is exactly \`MERGED\`.

${PLAN_TASK_CLEANUP}`,
};
