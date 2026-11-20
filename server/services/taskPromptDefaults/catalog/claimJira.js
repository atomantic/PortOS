/** Jira claims use sprint tickets and transition to In Review after publishing on the repository's forge. */
import { CONTRIBUTION_SECURITY_POLICY } from '../../../lib/contributionSecurityPolicy.js';
import { EPIC_DECOMPOSED_LABEL } from '../../../lib/dispatchLabels.js';
import { FORGE_REVIEWER_WAIT_NOTE, REVIEW_UNAVAILABLE_REPORTING_NOTE } from '../../../lib/reviewerConfig.js';
import { ISSUE_REVALIDATION_GUIDANCE } from './guidance.js';

export const JIRA_CLAIM = {
  preparation: `[Claim Issue: {appName}] Claim and ship the next ready JIRA ticket

**Security-model eligibility — before claiming, assigning a volunteer, or implementing:**
${CONTRIBUTION_SECURITY_POLICY}
Compare the live issue and comments against the repository's trusted security model before any claim or assignment. A label, benign abuse score, or contributor request is not authorization. Skip incompatible or uncertain requests without implementing or assigning them; report the reason in the completion summary.

${ISSUE_REVALIDATION_GUIDANCE}

Pick the next ready JIRA ticket assigned to me in the current sprint, move it to **In Progress**, **create your own worktree at \`claim/<KEY>\`**, implement it, open a merge/pull request that references the ticket, move the ticket to **In Review**, and clean up. This is the \`/claim --issues\` flow for JIRA: same self-managed worktree and no-local-merge cleanup, but the work source is the app's **JIRA** project (via the PortOS JIRA API) and the ticket *status* — not an assignee/label — is the claim. **YOU pick the ticket in Phase 1.** Do NOT modify files in the source repo directly; ALL editing happens inside the worktree you create.

All PortOS API calls below are relative to this base URL: {portosApiUrl}

**How claiming works.** A ticket is "in flight" when (a) a \`claim/<KEY>\` or \`cos/<task>/<KEY>/<agent>\` ref exists across local branches, remote branches, or open MR/PR source refs, OR (b) its JIRA status is anything other than a not-started status (so "In Progress", "In Review", "Done", etc. are already taken). Moving the ticket to **In Progress** + the \`claim/<KEY>\` branch ARE the claim, visible to every other agent and to the human looking at the sprint board.

## Phase 1 — Pick the target ticket

Run steps 1–5 in order.

1. Resolve the app's JIRA config: GET {portosApiUrl}/api/apps and find the app whose \`id\` is \`{appId}\`. Read \`jira.enabled\`, \`jira.instanceId\`, and \`jira.projectKey\`. If \`jira.enabled\` is not true or either id is missing, exit cleanly — this task only works against JIRA-configured apps.
2. Fetch my current-sprint tickets: GET {portosApiUrl}/api/jira/instances/<instanceId>/my-sprint-tickets/<projectKey>. This returns the tickets assigned to me in the active sprint.
3. Build the in-flight set from git refs:
   \`\`\`bash
   cd {repoPath}
   git fetch --prune 2>/dev/null
   git branch -a --no-color --format='%(refname:short)'
   \`\`\`
   For each ref (after stripping any leading \`origin/\` / \`upstream/\` prefix), extract the ticket KEY **only when the ref matches** \`claim/<KEY>\` (the segment after \`claim/\`) or \`cos/<task>/<KEY>/<agent>\` (the \`<KEY>\` third segment). A KEY looks like \`PROJ-1234\`.
4. **Pick the target ticket:** walk the sprint tickets in TWO passes (within each pass, prefer higher priority — Blocker/Highest/High — then oldest). First pass, consider only NON-epic tickets and take the first that satisfies every rule below — atomic work always outranks an epic, whatever their relative priority. Only if that pass finds nothing do you make a second pass for an undecomposed epic (same rules), and an epic you pick goes to **Phase 1b**, not Phase 2. A single pass would enter a decomposition the moment an epic happened to outrank claimable work, which is exactly backwards. The rules:
   - Its status is a not-started status (e.g. "To Do", "Open", "Backlog", "Selected for Development", "Ready"). Skip tickets already "In Progress", "In Review", "Done", or any closed/resolved status — those are claimed or finished.
   - Its KEY is NOT in the in-flight set from step 3.
   - It has enough of a summary/description to act on. A ticket that merely leaves a design choice unstated is still eligible — you'll decide the reading in Phase 3, not skip it here. Skip only a ticket with essentially no actionable content (bare title, no description or acceptance criteria).
   - It is NOT an ALREADY-DECOMPOSED tracking **Epic**. An epic is recognized by issue type "Epic" or a title ending in "(epic)"; it counts as decomposed once it ALSO carries the \`${EPIC_DECOMPOSED_LABEL}\` label (the sprint fetch returns each ticket's \`labels\`). Skip a decomposed epic — its child slices are ordinary claimable tickets, so claiming the parent would duplicate them. An UNdecomposed epic is eligible only in the second pass above, and goes to **Phase 1b**.
5. **If no eligible ticket exists**, exit cleanly — an empty actionable queue is a healthy state, not a failure. **But an open, undecomposed epic is NOT an empty queue**: never report "no work available" while one is unclaimed. Splitting it is the work — go to Phase 1b. If a ticket is in the sprint but too vague or blocked to start, create a Review Hub todo (POST {portosApiUrl}/api/review/todo with title "[<KEY>] Needs clarification" or "[<KEY>] Blocked" and a description of what's missing) instead of claiming it.

Capture the ticket KEY as \`KEY\`, its summary, and its full description — you'll reuse them in the branch, the MR/PR, and the commit trailer.

## Phase 1b — Decompose an epic (only when Phase 1 landed on one)

You reach this phase two ways: Phase 1 found no eligible atomic ticket and fell through to an undecomposed epic, or the user pinned this run to an epic. **Never end a run reporting "nothing to do" while an undecomposed epic is open** — turning it into shippable slices IS this round's work, and it is what refills the sprint queue for every later run.

Capture the epic's key as \`EPIC\`. This phase writes ONLY to JIRA — no worktree, no branch, no MR/PR, no edits in the source repo. A split leaves the epic's own STATUS untouched (it is a container, not work in progress); the exceptions are step 3's busy-children park and all-children-done closure.

1. Read it in full: GET {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<EPIC> — the response carries \`labels\`, \`description\`, \`status\`, and \`issueType\`.
2. **Find the children it already has** — an epic a human (or an earlier run) already split must never be re-split: GET {portosApiUrl}/api/jira/instances/<instanceId>/epics/<EPIC>/children. Union that with every \`<KEY>\` the epic's own \`description\` checklist references. **A failed lookup is NOT an empty result**: if that request errors, stop and report — treating it as "no children" would re-split an epic that is already decomposed.
3. **If children already exist, do NOT file more.**
   - **Some child still in a not-started status** → the epic is already decomposed. Make sure it carries the \`${EPIC_DECOMPOSED_LABEL}\` label and that its description checklist lists every child (steps 5–6), then set \`KEY\` to the FIRST such child that passes Phase 1 step 4's eligibility rules and continue at **Phase 2** with that child.
   - **No eligible unfinished child** → If every remaining child is in flight, in progress, blocked, or otherwise ineligible, **park the epic**: preserve its description and append a \`Blocked by <KEY>[, <KEY>…]\` line naming **every unfinished child**, comment with the same blockers, and transition the epic to **Blocked/On Hold** if supported. If no held status exists, create a Review Hub todo naming those blockers and leave the epic **In Progress** so it is not immediately re-picked. Verify the writes and report the unblock condition (all named children Done/Closed); stop without creating a claim worktree. That queue is busy, not empty.
   - **Every child Done/Closed** → the epic's work is finished. Comment naming the children that delivered it (POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<EPIC>/comments), transition the epic to **Done/Closed**, and return to Phase 1 to look for other work.
   - **Labeled \`${EPIC_DECOMPOSED_LABEL}\` but NO children exist** → an earlier split claimed the epic and died before filing anything. Treat it as undecomposed and continue at step 4; the marker is already in place, so nothing needs re-claiming.
4. **Otherwise, plan the split.** Read the code the epic actually names before slicing — a split that never met the repo is worthless. Produce 2–8 slices, each independently shippable in ONE MR/PR, valuable on its own, and written with concrete scope + acceptance criteria + the files/areas involved. Slice by user-visible behavior or subsystem; never one-ticket-per-file, and never invent scope the epic doesn't ask for. Decide the boundaries yourself — an ambiguous epic is decided, not deferred (same rule as Phase 3). Only an epic so vague that no split survives contact with the code is a park case: create a Review Hub todo ("[<EPIC>] Needs clarification"), transition the epic to a Blocked/On Hold status if the workflow has one, and exit.
5. **Claim the epic, THEN file the slices.** Stamp the marker before the first create — the label IS this phase's claim (Phase 1 skips a \`${EPIC_DECOMPOSED_LABEL}\` epic). Like every other marker in this flow it **narrows** the collision window without eliminating it, so re-run step 2's child query immediately before the first create and abandon the split if children now exist. Marking last instead of first would leave the epic actionable forever whenever that final write failed, and let a crashed run be re-split from scratch on the next tick:
   \`\`\`
   POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<EPIC>/labels
   {"labels": ["${EPIC_DECOMPOSED_LABEL}"]}
   \`\`\`
   Then comment on the epic saying how you sliced it, and resolve the sprint to file the slices INTO: GET {portosApiUrl}/api/jira/instances/<instanceId>/boards/<boardId>/sprints (\`jira.boardId\` on the app config) and take the active sprint's \`id\`. **If \`jira.boardId\` is not configured, or that call returns no active sprint, do NOT abandon the split** — file the slices without \`sprintId\`, flag every one of them as **not sprinted** in step 6's checklist, and say so in your Phase 7 report, so a human can drop them into a sprint. File each slice, in the order you want them worked:
   \`\`\`
   POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets
   {"projectKey": "<projectKey>", "summary": "<specific, human-readable>",
    "description": "<what + why + acceptance criteria + files/areas>\\n\\nPart of <EPIC>",
    "epicKey": "<EPIC>", "assignee": "currentUser", "sprintId": <activeSprintId>}
   \`\`\`
   **The \`assignee\` + \`sprintId\` pair is what makes a slice claimable at all** — Phase 1's candidate query is "assigned to me AND in an open sprint", so a child missing either one is invisible to every later run and the remaining work is stranded. \`assignee: "currentUser"\` resolves the authenticated account server-side. The response's \`sprint\` field is the sentinel to check: \`{"assigned": true}\` means it landed, while \`{"assigned": false, "error": "…"}\` means the ticket EXISTS but is not in the sprint. On \`assigned: false\`, retry once (POST {portosApiUrl}/api/jira/instances/<instanceId>/sprints/<sprintId>/issues with \`{"issueKeys": ["<KEY>"]}\`); if it still fails, mark that slice in the epic's checklist as **not sprinted** and say so in your Phase 7 report — never leave it silently stranded. Say \`Part of <EPIC>\` in the description and set \`epicKey\`; JIRA has no \`Closes\` auto-close, so the epic is closed by step 3's all-children-done branch on a later run. Add the equivalent hyphenated dispatch labels (\`model-light|model-medium|model-heavy\`, \`effort-low|effort-medium|effort-high|effort-xhigh|effort-max\`) and contributor labels (\`good-first-issue\`, \`help-wanted\`) only where that slice genuinely justifies them.
6. **Write the checklist back to the epic** so the next run can follow it — keep the original description (step 1 returned it) and append a \`## Decomposed into\` list naming every child, flagging any that could not be sprinted:
   \`\`\`
   PUT {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<EPIC>
   {"description": "<original description>\\n\\n## Decomposed into\\n\\n- [ ] <KEY-a> — <title>\\n- [ ] <KEY-b> — <title> (NOT SPRINTED — needs a human to add it)"}
   \`\`\`
   The marker from step 5 is what stops the next run from splitting the same epic again; this checklist is what lets a claim aimed at the epic resolve the next available child. Leave the epic in its current status — it moves to Done when its last child closes.
7. **Then claim the first slice you filed** — set \`KEY\` to it and continue at **Phase 2**, shipping that ONE slice normally. If claiming it fails because another run won the race, exit cleanly: the decomposition alone is a successful round, and the next claim run picks up the next linked child.

## Phase 2 — Claim (In Progress + worktree)

First move the ticket to **In Progress** (this is the claim, and it must happen BEFORE you start coding), then create the worktree. Transition names vary per project workflow, so resolve the id dynamically:

1. GET {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>/transitions to list available transitions.
2. Pick the transition whose target status best matches "In Progress" (e.g. "In Progress", "Start Progress", "Start Work"); match case-insensitively. If none clearly matches, pick the transition that moves the ticket out of the To Do / Backlog column.
3. POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>/transition with body {"transitionId": "<id>"}. If this fails (the status is unreachable), the ticket may have been claimed concurrently — return to Phase 1 and pick the next eligible ticket.

Then create the worktree on a branch named \`claim/<KEY>\`. Do all editing inside the worktree, NEVER in the source repo's working tree:

\`\`\`bash
KEY=<picked-key>
DEFAULT_BRANCH="$(git -C {repoPath} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
DEFAULT_BRANCH="\${DEFAULT_BRANCH:-main}"
WORKTREE="{worktreesRoot}/claim-{appSlug}-\${KEY}"
mkdir -p "{worktreesRoot}"
git -C {repoPath} fetch origin "\${DEFAULT_BRANCH}"
git -C {repoPath} worktree add --no-track -b "claim/\${KEY}" "\${WORKTREE}" "origin/\${DEFAULT_BRANCH}"
# Link the source checkout's node_modules so tests run in the worktree (never npm install there):
node "{portosRoot}/scripts/link-worktree-deps.js" "{repoPath}" "\${WORKTREE}"
cd "\${WORKTREE}"
\`\`\`

**If \`git worktree add\` fails because the \`claim/<KEY>\` branch already exists** (a concurrent run won the race), do NOT force or reuse it — that branch IS another run's claim. Move the ticket back to its prior status if you transitioned it, treat the ticket as in-flight, return to Phase 1, and pick the next eligible ticket. Stash \`WORKTREE\` — you'll need it for Phase 6 cleanup.

## Phase 3 — Verify still valid

Re-read the ticket (GET {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>) before writing any code. **Every exit from this phase must leave a CONVERGING status on the ticket — Done/Closed, or a held status backed by a Review Hub todo.** Transitioning back to a not-started status is NOT an exit: Phase 1's not-started-only filter makes the ticket immediately re-eligible again, so the next pass re-picks it and burns another no-op run — every pass, forever.

- **Already fixed, superseded, or duplicated by another ticket** — a comment says so, or the change it asks for is already on the default branch. Post a ticket comment naming the PR/MR, commit, or ticket that already delivered it (POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>/comments), transition the ticket to **Done/Closed**, remove the worktree, and return to Phase 1. **Evidence gate: if you cannot name the PR/MR, commit, or ticket that delivered it, this branch does NOT apply** — closing on a hunch destroys live work, which is far worse than one wasted pass. Treat the ticket as real work and continue to Phase 4.
- **Stale reference** — the ticket names a function, file, or component that no longer exists (\`grep -rn\` the named identifiers; if they're gone, it's stale). Post a ticket comment naming what you searched for and what you found instead, create a Review Hub todo (POST {portosApiUrl}/api/review/todo with title "[<KEY>] Stale reference" and what a human must re-scope), and transition the ticket to a **Blocked/On Hold status if the workflow has one — NOT back to a not-started status**; if the workflow has no held status, leave it **In Progress** so Phase 1's filter excludes it. Then remove the worktree and return to Phase 1.

(A too-large scope is NOT in this list — it has its own park path below.)

**A genuinely too-large ticket gets SPLIT, not parked.** If the work is bigger than one coherent claim — it would touch files far outside the ticket's scope (>5 unrelated files) — and you can't carve a valuable standalone slice to ship first, promote it to an epic and decompose it: file the slices and rewrite the parent exactly as **Phase 1b** steps 4–6 describe (each slice carrying \`Part of <KEY>\` and \`epicKey: "<KEY>"\`). **Mark it on BOTH axes** — the queue skips a parent only when it is epic-shaped AND marked, so a ticket left carrying only \`${EPIC_DECOMPOSED_LABEL}\` stays claimable and gets re-split every pass. Add the marker label (POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>/labels with \`{"labels": ["${EPIC_DECOMPOSED_LABEL}"]}\`) and make it epic-shaped: change its issue type to Epic if the project allows it, otherwise append " (epic)" to the summary (PUT {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>) — the title convention marks an epic on a project where the type can't change. Confirm both landed by re-reading the ticket. Then transition it back to a not-started status so the sprint board shows the parent as unstarted (the marker, not the status, is what keeps Phase 1 off it), remove the worktree, and continue at Phase 2 with the first slice you filed. Splitting an omnibus ticket is work you do, not a hand-off.

Park instead ONLY when the ticket is too vague to slice against the code at all: create a Review Hub todo (POST {portosApiUrl}/api/review/todo with title "[<KEY>] Needs clarification" and what a human must resolve), transition the ticket to a **Blocked/On Hold status if the workflow has one — NOT back to a not-started status**, which would re-queue it under Phase 1 (ticket selection never consults Review Hub todos, so a not-started ticket is immediately re-eligible and the run would re-park it every pass); if the workflow has no held status, leave it **In Progress**. Then remove the worktree and exit.

**Ambiguity is NOT a release trigger — decide, don't defer.** If the ticket is merely open to more than one reasonable reading, or leaves a design choice unstated, do NOT bail to a "Needs clarification" todo. Pick the most reasonable interpretation, record the approach you chose in a ticket comment (POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>/comments) so the decision is on the record, and implement it. The user would rather iterate on top of a shipped best-guess than have the ticket parked waiting on a decision they didn't ask to make. Reserve the "Needs clarification" todo for cases where proceeding would be **destructive or irreversible**, or genuinely requires the human: specific hardware/credentials you don't have, or a judgment only they can make. In those cases only, create the todo (POST {portosApiUrl}/api/review/todo with title "[<KEY>] Needs clarification" and what a human must resolve), transition the ticket to a **Blocked/On Hold status if the workflow has one — NOT back to a not-started status** (which would re-queue it under Phase 1, since ticket selection never consults Review Hub todos); if the workflow has no held status, leave it **In Progress** so Phase 1's not-started-only filter excludes it. Then remove the worktree and **exit — do NOT proceed to Phase 4**.

Do NOT leave an *unexplained* ticket in "In Progress" with no branch — that is the zombie to avoid. A deliberate park above is different: it always carries a Review Hub todo saying why (and a Blocked/On Hold status where the workflow supports one), so it reads as intentionally held, not abandoned.`,
  implementation: `Write the code, tests, and any docs the ticket requires. Follow the repo conventions in AGENTS.md / CLAUDE.md (no try/catch in route handlers, functional programming, Zod validation, Tailwind tokens, reactive UI updates). Run the relevant test suite as you go.`,
  backbone: `small supporting helpers, refactors, and tests the fix depends on belong here, not a follow-up. Only defer genuinely-large adjacent work.`,
  review: `The audit trail is the merged MR/PR + \`git log\`. Detect the forge from the git origin and use the matching CLI (\`gh\` for GitHub, \`glab\` for GitLab).

The configured reviewers for this task, in order, are \`{reviewers}\`. Split them by where they can run, preserving order: **LOCAL reviewers** — every token that is NOT an \`@<login>\` (\`claude\` / \`codex\` / \`antigravity\` (CLI binary: \`agy\`) / \`grok\` / \`cursor\` invoke a local-CLI critique; \`lmstudio\` / \`ollama\` use the appended Local Reviewer Procedure) read the working tree and need no MR/PR, so they run in steps 1–2 below, BEFORE it is opened. **PR-SIDE reviewers** — every \`@<login>\` token, plus any review bot the repo requests automatically on open — review cloud-side and run in Phase 6, once the MR/PR exists.

1. **Write the changelog entry now, not after the reviewers run** — every commit the reviewers are about to read must already be on the branch, or the MR/PR carries work nobody reviewed. If the repo maintains a changelog, record a one-line entry **following the convention that repo documents** — read its \`AGENTS.md\` (or \`CLAUDE.md\`) and changelog README (e.g. \`.changelog/README.md\`) first. Some repos collect per-branch fragments in a directory (e.g. \`.changelog/next/\`) via a helper script rather than appending to one shared file, precisely so parallel agents don't conflict on every merge; use that flow when it's documented. Fall back to appending to the unreleased section (\`.changelog/NEXT.md\`, or \`## Unreleased\` in \`CHANGELOG.md\`) in the repo's existing prose style only when no convention is documented. Otherwise skip it.
2. **Self-review your diff for reuse, quality, and efficiency** (DRY, dead code, naming, simpler equivalents, missed edge cases) and fix the findings in the same diff. Claude Code runs this as the three-agent \`/simplify\` pass; on other CLIs, do the equivalent by hand.
3. **Run each LOCAL reviewer in the listed order against the BRANCH diff, not an MR/PR diff.** Nothing is open yet, so use the CLI's own base-diff mode or \`git diff "origin/\${DEFAULT_BRANCH}...HEAD"\`; local LLM reviewers go through the appended endpoint procedure. Apply the findings, run the tests, and commit the fixes — capped at that reviewer's \`~max=<n>\` budget from the reviewer list (3 rounds when it carries none; the Review round caps note below restates configured budgets) — then advance. A missing CLI, quota/provider or transport failure, timeout, malformed response, empty response, or no-verdict result from a REQUIRED reviewer is unavailable, not clean: do NOT substitute your own self-review; record REVIEW_STATUS=review-blocked in the worktree-private status file and continue to Phase 6 when the code and tests are otherwise shippable. An optional reviewer (~opt) is non-blocking: a provider error, quota limit, timeout, or missing verdict from an optional reviewer must NEVER record REVIEW_STATUS=review-blocked (leave REVIEW_STATUS=clean) and does not prevent merge. If accepted findings are neither fixed nor rejected/tracked with rationale (a spent reviewer budget alone is not a stop; disclose the partial review in the PR body), fixes leave the build/tests red, a review fix is unpushed, or the review/status state cannot be persisted, do NOT open one — leave the branch and worktree in place, comment the failure on the ticket (POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>/comments), and stop. Reviewer unavailability alone is REVIEW_STATUS=review-blocked, so it does not take this stop path.`,
  publication: `4. Push the branch: \`git push -u origin "claim/\${KEY}"\`, then confirm \`git log --oneline @{u}..HEAD\` is empty so every review fix from step 3 is in the MR/PR's diff.
5. Open the MR/PR. Reference the JIRA \`KEY\` in the title and description (there is NO \`Closes\` auto-close for JIRA). Summarize what shipped + a short test plan.
   - GitHub: \`gh pr create --fill --head "claim/\${KEY}"\` (then edit the body to mention \`KEY\` if \`--fill\` didn't).
   - GitLab: \`glab mr create --fill --source-branch "claim/\${KEY}" --target-branch "\${DEFAULT_BRANCH}" --yes\`.
   Capture the MR/PR URL as \`PR_URL\`.
5a. Read the Phase 5 status back (REVIEW_STATUS_FILE="$(git rev-parse --git-path portos-review-status)", then source it). If REVIEW_STATUS=review-blocked from a required reviewer after the MR/PR opens, leave it unmerged, preserve the branch, and continue the required In Review transition and ticket-link steps; the MR/PR remains open for the human handoff. ${REVIEW_UNAVAILABLE_REPORTING_NOTE} If all configured reviewers were optional (~opt), REVIEW_STATUS must not block the merge.
6. **Move the ticket to "In Review" — REQUIRED, not optional. Do not finish while it is still "In Progress":**
   - GET {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>/transitions again (transitions change once In Progress).
   - Pick the transition whose target status best matches "In Review" (e.g. "In Review", "Code Review", "Review", "Ready for Review"); match case-insensitively.
   - POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>/transition with body {"transitionId": "<id>"}.
7. Add the MR/PR link to the ticket: POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets/<KEY>/comments with body {"comment": "Implementation complete. MR/PR: \${PR_URL}\\n\\nReady for code review."}. **If you shipped only PART of the ticket's scope** (a valuable slice with real work remaining), make the comment a \`Done ✓ / Remaining ▢\` summary so the remaining scope is not lost when a human lands the MR/PR; when that remainder is a clean, separable chunk, ALSO file a new follow-up ticket for it (POST {portosApiUrl}/api/jira/instances/<instanceId>/tickets with a summary + a description referencing \`KEY\`, plus equivalent labels \`model-light|model-medium|model-heavy\`, \`effort-low|effort-medium|effort-high|effort-xhigh|effort-max\`, \`good-first-issue\`, \`help-wanted\` when independently justified) so it re-enters the sprint queue. If a transition in step 6 failed (status unreachable), say so in this comment AND in the Phase 7 summary — do not silently drop it.

## Phase 6 — PR-side review and clean up

The local reviewers already ran in Phase 5, so only the reviewers that need an open MR/PR remain.

1. **Satisfy the PR-SIDE reviewers.** For each \`@<login>\` from the Phase 5 split, request the review on the open MR/PR (GitHub: \`gh pr edit <pr-number> --add-reviewer <login>\`, dropping the \`@\`; GitLab: \`glab mr update <MR_IID> --reviewer <login>\`) and address the findings — push fixes, capped at that reviewer's \`~max=<n>\` budget from the reviewer list (3 rounds when it carries none; the Review round caps note below restates configured budgets). ${FORGE_REVIEWER_WAIT_NOTE} Wait out any auto-requested review bot the same way. A missing reviewer, timeout, or unresolvable finding is UNSATISFIED, not clean: comment on the MR/PR naming the failure and stop. With no \`@<login>\` configured and no bot review appearing, this step is a no-op.
2. **Leave the MR/PR open for a human to land.** Unlike the GitHub/GitLab issue flows, this flow does NOT auto-merge — the ticket is "In Review" and a human reviews + merges. After the reviewers finish, preserve the exact worktree, local \`claim/<KEY>\` branch and open MR/PR for the intentional human handoff. Do not invoke merged retirement while it remains unmerged. **Do NOT \`git merge\`, \`gh pr merge\`, \`glab mr merge\`, or \`git pull\`** — landing the change and moving the ticket to Done is the human's call.

## Phase 7 — Report

Generate a short summary: the ticket KEY + summary worked, the MR/PR URL, the ticket's FINAL JIRA status (confirm it is "In Review"), reviewers run, and any status transition that failed and why.`,
};
