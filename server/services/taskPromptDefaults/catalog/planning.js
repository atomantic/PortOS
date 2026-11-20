import { ISSUE_QUALITY_GUIDANCE } from '../../../lib/dispatchLabels.js';

const SCHEDULED_ISSUE_QUALITY_GATE = `## Scheduled issue-quality gate

${ISSUE_QUALITY_GUIDANCE}

Apply this gate to every new issue created by the scheduled replan, including
items migrated from PLAN.md or GOALS.md and opportunity-scan suggestions. A
proposal is valid only when it is useful to do now. A refactor is valid when current evidence shows it pays off now; a deferred possibility is not an issue.
Return/drop it and let a later audit rediscover it when the evidence changes.`;

export const prompts = {
  'feature-completeness': `[Improvement: {appName}] Incomplete-feature audit

Find what {appName} offers, documents, or half-built that does not actually work
end to end — and decide, for each, whether to finish it, hide it, or remove it.

Repository: {repoPath}

{modeInstructions}

Other audits look for code that is broken or dead. This one looks for work that
was started and never finished: a control that is permanently disabled, a path
that ends in "not implemented", a setting that saves and changes nothing. Every
other lens reads these as intentional, so they survive run after run.

## Hunt for

- **Stubs reachable from the interface** — a handler, service, or adapter that
  returns "not implemented", a 501, a placeholder or hardcoded result, or throws
  a to-do error, on a path a user can trigger. Trace from the visible control to
  the stub. A stub nothing reaches is dead code, not yours.
- **Controls that can never work** — a button, tab, menu entry, or option that
  is permanently disabled, labeled "coming soon" or "not available yet", or
  wired to a no-op handler.
- **Promises the code does not keep** — interface text, help copy, or
  documentation describing behavior the implementation lacks or does
  differently ("restarts the process" where the code only stages a patch).
- **Settings that change nothing** — a value the interface saves that no runtime
  path reads, or a runtime option with a real effect that no interface or
  documented configuration can set.
- **Capabilities with no entry point** — an endpoint, job, or repair routine that
  does user-meaningful work but has no caller, interface, schedule, or
  documented invocation, so the work it exists for never happens.
- **Events nobody hears** — a server event announcing something the user should
  see (an approval is needed, a sync needs a login, health turned critical) with
  no client listener, so the user learns only on a manual reload.
- **Plans that disagree with the code** — a plan or tracker item marked done or
  in progress whose acceptance criteria the code does not meet, or one still
  marked pending for work that has shipped.
- **Deferred work with no live tracker item** — a to-do comment, disabled
  feature, or "not supported yet" message that cites no tracker reference, or
  one that does not exist, is closed, or belongs to another project.

## Decide, do not defer

Every finding ends in a decision, not a question:

- **Finish** — name the missing piece, the files it touches, and how to verify
  it. Prefer this when the remaining work is small or the feature is documented.
- **Hide until it works** — stop offering the control, option, or account type,
  and file the finishing work. Prefer this when finishing is large and the
  current surface misleads users today.
- **Remove** — delete the stub and every surface that offers it, when the
  feature is no longer wanted.

## Not yours

Code with no caller and no user meaning belongs to the simplification work.
Controls that were finished and now fail belong to the UI-bug work. Wording
belongs to the copy work. A workflow that starts but cannot be resumed or
cancelled belongs to the workflow-recovery work.

## The bar

Show the path: the entry point (control, document, setting) with
\`file:LINE\`, the place the work stops with \`file:LINE\`, and what the user
experiences. Static evidence is enough here — a stub, a hardcoded disabled
flag, or a setting nothing reads is proven by reading the code; it does not need
a live reproduction. Never quote a user's records when describing what is
offered.`,

  'feature-ideas': `[Improvement: {appName}] Implement Next Planned Feature

Your goal is to implement the next planned item from PLAN.md, or brainstorm a new feature if no plan exists.

Repository: {repoPath}
{planConstraint}
## Phase 1 — Find the Next Task

1. Read PLAN.md from {repoPath}
2. Skim \`git log\` (last 50 commits) and recent releases (\`gh release list\`, then \`gh release view <tag>\`) to understand what has already shipped — do NOT re-implement completed features
3. If the **Item Constraint** block above named a specific \`[plan-id]\`, find the matching \`- [ ]\` line and use that — do NOT pick a different one, do NOT brainstorm. If the line is missing, has been checked, or carries \`<!-- NEEDS_INPUT -->\`, exit cleanly without commits or PR.
4. Otherwise, if PLAN.md does not exist, is empty, or has no unchecked items (\`- [ ]\`), go to **Phase 4 — Brainstorm**.
5. Otherwise, find the first unchecked item (\`- [ ]\`) that does NOT have a \`<!-- NEEDS_INPUT -->\` annotation.
6. If all unchecked items have \`<!-- NEEDS_INPUT -->\`, go to **Phase 4 — Brainstorm**.

## Phase 2 — Evaluate Feasibility

7. Read relevant source files to understand the scope of the item
8. Determine: can this be implemented without user clarification?
   - Consider: are requirements clear? Are there ambiguous design choices? Does it depend on external decisions?

## Phase 3a — Implement (if feasible)

9. Implement the feature:
   - Write clean, tested code following existing patterns
   - Run tests to ensure nothing is broken
10. **Review your changed code for reuse, quality, and efficiency** (DRY, dead code, naming, simpler equivalents, missed edge cases) and fix any findings. Claude Code can run \`/simplify\` for this pass; on other CLIs, do the equivalent diff review by hand.
11. Check the PLAN.md item: change \`- [ ]\` to \`- [x]\`. **Preserve the \`[plan-id]\` slug verbatim** — only the box character flips, never the ID. Reference the slug in the commit message (e.g. \`feat([plan-id]): …\`).
12. Commit with a clear description referencing the PLAN.md item

## Phase 3b — Request Clarification (if not feasible)

9. Create a file named \`.plan-questions.md\` in the repository root with this format:
   \`\`\`
   # Plan Question: <short title summarizing the PLAN.md item>

   ## PLAN.md Item
   <the exact text of the unchecked item, including its [plan-id]>

   ## Questions
   - <question 1>
   - <question 2>
   \`\`\`
10. **Move the unchecked item to the bottom of PLAN.md and annotate it with \` <!-- NEEDS_INPUT -->\`** — remove the line from its current position and append it at the end of the file with the annotation, **preserving its \`[plan-id]\` slug**. This keeps the queue moving so the next \`feature-ideas\` run picks up a different actionable item instead of repeatedly tripping on this one.
11. Commit both changes (the new \`.plan-questions.md\` file and the PLAN.md move) with message \`chore: flag PLAN.md item needing user input\`. Then proceed to the **Completion** section below so the clarification PR is opened for the user to review — do NOT leave the worktree orphaned.

## Phase 4 — Brainstorm a New Feature

When PLAN.md is missing, empty, or fully completed, brainstorm and implement a new feature:

1. **Establish the product direction from the repository's own documents**, in
   this order of precedence. Make a best effort rather than assuming a missing
   document means the app has no direction:
   - Read \`PRD.md\` from the root of {repoPath} if it exists. Treat its
     requirements, acceptance criteria, success metrics, constraints, and
     non-goals as the primary statement of what the app should do.
   - Read \`GOALS.md\` from the root of {repoPath} if it exists. Use it for
     strategic context alongside the PRD, or as the primary statement of
     desired direction when there is no PRD.
   - If neither exists, fall back to the root \`README.md\`, \`docs/README.md\`,
     relevant guides, architecture notes, and ADRs. Extract stated users,
     problems, workflows, constraints, and success signals rather than
     inventing a product direction.
   - If PRD.md and GOALS.md conflict, follow the PRD's concrete requirements
     and success criteria, and name the tension in your commit message.
2. Skim the last 50 \`git log\` entries and recent releases (\`gh release list\`, \`gh release view <tag>\`) to avoid re-implementing completed features
3. Read REJECTED.md from {repoPath} (if it exists) to understand previously rejected ideas — do NOT re-propose an idea matching a rejected entry
4. Check the repo's recently closed-unmerged PRs (\`gh pr list --state closed --search "is:unmerged" --limit 20\`, or the forge's equivalent) — a brainstormed feature whose PR the user closed WITHOUT merging was rejected; treat those ideas as rejected too
5. Review the codebase structure, recent git log, and any README or docs to understand the app
6. Identify ONE small, high-impact feature that:
   - Aligns with PRD.md requirements and success criteria when available; otherwise with GOALS.md or the documentation gathered in step 1
   - Is NOT already shipped per recent releases (\`gh release view\`) or \`git log\` (avoid re-implementing shipped features)
   - Does NOT match a REJECTED.md entry or a closed-unmerged automation PR (rejected ideas stay rejected)
   - Saves user time, improves UX, or makes the app more useful
   - Is self-contained and completable in one session
   - Does NOT duplicate existing functionality
7. Implement the feature:
   - Write clean, tested code following existing patterns
   - Run tests to ensure nothing is broken
8. **Review your changed code for reuse, quality, and efficiency** (DRY, dead code, naming, simpler equivalents, missed edge cases) and fix any findings. Claude Code can run \`/simplify\` for this pass; on other CLIs, do the equivalent diff review by hand.
9. Add the feature as a checked item in PLAN.md (create the file if needed) **with a slug ID** derived from the feature title (lowercase kebab-case, ≤50 chars, unique against every existing \`[slug]\` in PLAN.md):
   \`\`\`
   - [x] [<slug-of-feature>] <description of the feature you implemented>
   \`\`\`
10. Commit with a clear description of the feature and rationale`,

  'plan-feature': `[Improvement: {appName}] Feature Planning — brainstorm one feature and file its plan

You are the planning-only sibling of the \`feature-ideas\` task. Your job is to
research {appName}, pick ONE feature worth building, and file a decision-complete
plan for it into the app's task tracker. You do NOT implement anything.

**Read-only on source.** You do NOT edit application code, and you do NOT create
branches or PRs. Your deliverable is ONE tracker item (described under "Where to
record the plan" below) carrying a plan another agent — or a human — can pick up
and execute cold. The plan is the product.

Repository: {repoPath}

## Where to record the plan

{trackerInstructions}

## What to do

1. **Inventory so you don't duplicate.** Start with any **Preloaded task data**
   appended below. When an Open issues or Open pull requests section is
   present, that section is a current snapshot collected immediately before
   dispatch, so do NOT list it again. Follow the "Inventory" step under "Where
   to record the plan" for any corresponding section that is absent, says it
   could not be collected, or when you need a full issue body. De-duplicate
   against existing items by the feature need and approach; the tracker block
   defines how to identify and record each item. Then skim
   the last 50 \`git log\` entries plus recent releases (\`gh release list\` / \`gh release view\`): an idea
   that is already an open tracker item, in an open PR, or recently shipped work
   is NOT a candidate.

2. **Build a product brief from the preloaded repository documents.** For each
   Product requirements or Project goals section that is present, PortOS
   searched the repository immediately before dispatch. Use the most specific
   available source of intent, and do NOT search for or re-read a file when its
   section has complete content. If a section is absent, unavailable,
   unreadable, or truncated, search for and read the source directly before
   relying on it. Make a best effort rather than assuming a missing document
   means the app has no direction:

   - If the Product requirements section contains a \`PRD.md\`, use it first.
     Treat its requirements, acceptance
     criteria, success metrics, constraints, and non-goals as the primary
     evaluation for what the feature should accomplish.
   - If the Project goals section contains a \`GOALS.md\`, use it for strategic context and to supplement
     the PRD. If there is no PRD, use GOALS.md as the primary statement of
     desired direction.
   - If neither exists, start with the root \`README.md\`, \`docs/README.md\`
     (if present), relevant guides, architecture notes, ADRs, design documents,
     and other product documentation in the repository. In all cases, inspect
     the relevant documentation for feature-specific context and fill gaps
     from it. Extract stated users, problems, workflows, constraints, and
     success signals rather than inventing a product direction.
   - If PRD.md and GOALS.md conflict, follow the PRD's concrete requirements
     and success criteria; use GOALS.md as strategic context and call out any
     material tension in the filed plan.
   - Read the repository's \`AGENTS.md\` or \`CLAUDE.md\` files as implementation
     constraints, not as a substitute for product intent. When documentation
     is sparse, validate the inferred need against the current source, tests,
     and recent history and name the evidence in the plan.
   - Use the preloaded Closed unmerged pull requests section — a feature whose
     PR the user closed WITHOUT merging was rejected; treat those ideas as
     rejected too. Query the forge if that section is absent or says it was
     unavailable.
   - Review the codebase structure and relevant source files so the plan names
     real files rather than imagined ones.

3. **Identify ONE small, high-impact feature** that:

   - Aligns with PRD.md requirements and success criteria when available;
     otherwise aligns with GOALS.md or the repository documentation gathered
     in step 2
   - Is NOT already shipped, planned, or filed (per step 1)
   - Does NOT duplicate existing functionality or repeat a closed-unmerged
     automation PR
   - Saves user time, improves UX, or makes the app more useful
   - Is self-contained and completable in one session by the agent that claims it

4. **Write the decision-complete plan.** Every design choice is DECIDED, not
   raised as a question — make the call and state it. The filed item must carry:

   - **A short, human-readable title** naming the feature. Do not invent an
     issue ID or add a slug/category/severity tag to a forge title; follow the
     selected tracker's ID convention from its instructions.
   - **Motivation** — which documented requirement, success criterion, goal, or
     evidenced user need this serves, 1–2 sentences.
   - **Approach** — the design you have decided on: the behavior to build, the
     existing patterns in {appName} it follows, and the concrete files/components
     it would touch (describe them; do NOT write the code).
   - **\`Scope: small | medium | large\`** — an honest estimate for one session.
   - **Acceptance criteria** — checkboxes another agent can verify cold, without
     asking anyone anything.
   - **Non-goals** — what this feature deliberately does NOT cover, so the
     implementing agent doesn't expand scope.

5. **Redact before you publish.** The filed item is world-readable the moment it
   lands. Never paste a secret, credential, token, hostname, IP address, or
   absolute path containing a username into the title or body.

6. **Record exactly ONE plan item** using the "Record" mechanics under "Where
   to record the plan" above. If the feature hinges on a genuine product
   judgment the user owns (not a design detail you can decide), file it anyway
   as a **Maybe — needs human call** item with the \`**Decision needed:**\` line
   the tracker instructions describe — do not skip filing.

7. **Finalize** per the "Finalize" step under "Where to record the plan" above.
   No source edits, no branches, no PRs.

8. Your final assistant message must be a 2–3 sentence summary of: the feature
   you planned, where you filed it (issue number/key or tracker ID), and the one
   design call you made that a reviewer is most likely to question.`,

  'do-replan': `[Improvement: {appName}] Replan — Audit PLAN.md

Run the project's \`/do:replan\` slashdo command for {appName} in autonomous (non-interactive) mode.

Repository: {repoPath}

The full \`/do:replan\` command body follows. Apply it to {repoPath} exactly as written, then commit any changes. Default mode is autonomous — do NOT prompt the user; run \`--interactive\` only if the user has explicitly asked for it (they have not).

Scope: this task operates against the managed app's repository, NOT PortOS. All edits must land in {repoPath} (PLAN.md, GOALS.md, docs/, the changelog) — never write to PortOS itself.

${SCHEDULED_ISSUE_QUALITY_GATE}

---

{slashdoReplan}`,
};
