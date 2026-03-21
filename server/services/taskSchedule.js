/**
 * Task Schedule Service (v2 - Unified)
 *
 * Manages configurable intervals for improvement tasks across all apps (including PortOS).
 * All task types live in a single `tasks` object — no more selfImprovement/appImprovement split.
 *
 * Interval types:
 * - 'rotation': Run as part of normal rotation (default)
 * - 'daily': Run once per day
 * - 'weekly': Run once per week
 * - 'once': Run once per app/globally then stop
 * - 'on-demand': Only run when manually triggered
 * - 'custom': Custom interval in milliseconds
 */

import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents, emitLog } from './cos.js';
import { DAY, ensureDir, HOUR, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { getAdaptiveCooldownMultiplier } from './taskLearning.js';
import { isTaskTypeEnabledForApp, getAppTaskTypeInterval, getActiveApps, getAppTaskTypeOverrides } from './apps.js';
import { PORTOS_UI_URL } from '../lib/ports.js';

const DATA_DIR = PATHS.cos;
const SCHEDULE_FILE = join(DATA_DIR, 'task-schedule.json');

// Interval type constants
export const INTERVAL_TYPES = {
  ROTATION: 'rotation',      // Default: runs in normal task rotation
  DAILY: 'daily',            // Runs once per day
  WEEKLY: 'weekly',          // Runs once per week
  ONCE: 'once',              // Runs once per app or globally
  ON_DEMAND: 'on-demand',    // Only runs when manually triggered
  CUSTOM: 'custom'           // Custom interval in milliseconds
};

const WEEK = 7 * DAY;

/**
 * Get learning-adjusted interval for a task type
 */
async function getPerformanceAdjustedInterval(taskType, baseIntervalMs) {
  const taskTypeKey = `task:${taskType}`;

  const cooldownInfo = await getAdaptiveCooldownMultiplier(taskTypeKey).catch(() => ({
    multiplier: 1.0,
    reason: 'error-fallback',
    skip: false,
    successRate: null,
    completed: 0
  }));

  if (cooldownInfo.reason === 'insufficient-data' || cooldownInfo.reason === 'error-fallback') {
    // Also check legacy keys for migration period
    const legacyKeys = [`self-improve:${taskType}`, `app-improve:${taskType}`];
    for (const key of legacyKeys) {
      const legacyInfo = await getAdaptiveCooldownMultiplier(key).catch(() => null);
      if (legacyInfo && legacyInfo.reason !== 'insufficient-data' && legacyInfo.reason !== 'error-fallback') {
        const adjustedIntervalMs = Math.round(baseIntervalMs * legacyInfo.multiplier);
        return {
          adjustedIntervalMs,
          multiplier: legacyInfo.multiplier,
          reason: legacyInfo.reason,
          successRate: legacyInfo.successRate,
          dataPoints: legacyInfo.completed,
          skip: legacyInfo.skip,
          adjusted: legacyInfo.multiplier !== 1.0,
          recommendation: legacyInfo.recommendation
        };
      }
    }

    return {
      adjustedIntervalMs: baseIntervalMs,
      multiplier: 1.0,
      reason: cooldownInfo.reason,
      successRate: null,
      dataPoints: cooldownInfo.completed || 0,
      adjusted: false
    };
  }

  const adjustedIntervalMs = Math.round(baseIntervalMs * cooldownInfo.multiplier);

  if (cooldownInfo.multiplier !== 1.0) {
    const direction = cooldownInfo.multiplier < 1 ? 'decreased' : 'increased';
    const percentage = Math.abs(Math.round((1 - cooldownInfo.multiplier) * 100));
    emitLog('debug', `Learning: ${taskType} interval ${direction} by ${percentage}% (${cooldownInfo.successRate}% success rate)`, {
      taskType,
      multiplier: cooldownInfo.multiplier,
      successRate: cooldownInfo.successRate,
      dataPoints: cooldownInfo.completed
    }, '📊 TaskSchedule');
  }

  return {
    adjustedIntervalMs,
    multiplier: cooldownInfo.multiplier,
    reason: cooldownInfo.reason,
    successRate: cooldownInfo.successRate,
    dataPoints: cooldownInfo.completed,
    skip: cooldownInfo.skip,
    adjusted: cooldownInfo.multiplier !== 1.0,
    recommendation: cooldownInfo.recommendation
  };
}

// ============================================================
// Unified DEFAULT_TASK_PROMPTS (17 task types)
// All prompts use {appName} and {repoPath} template variables
// ============================================================

const DEFAULT_TASK_PROMPTS = {
  'security': `[Improvement: {appName}] Security Audit

Analyze the {appName} codebase for security vulnerabilities:

Repository: {repoPath}

1. Review routes/controllers for:
   - Command injection in exec/spawn calls
   - Path traversal in file operations
   - Missing input validation
   - XSS vulnerabilities
   - SQL/NoSQL injection

2. Review services for:
   - Unsafe eval() or Function()
   - Hardcoded credentials
   - Insecure dependencies

3. Review client code for:
   - XSS vulnerabilities
   - Sensitive data in localStorage
   - CSRF protection

4. Check authentication and authorization where applicable

Fix any vulnerabilities found and commit with security advisory notes.`,

  'code-quality': `[Improvement: {appName}] Code Quality Review

Analyze {appName} for maintainability improvements:

Repository: {repoPath}

1. Find DRY violations - similar code in multiple places
2. Identify functions >50 lines that should be split
3. Look for missing error handling
4. Find dead code and unused imports
5. Check for console.log that should be removed
6. Look for TODO/FIXME that need addressing
7. Identify magic numbers that should be constants

Focus on the main source directories. Refactor issues found and commit improvements.`,

  'test-coverage': `[Improvement: {appName}] Improve Test Coverage

Analyze and improve test coverage for {appName}:

Repository: {repoPath}

1. Check existing tests and identify untested critical paths
2. Look for:
   - API routes without tests
   - Services with complex logic
   - Error handling paths
   - Edge cases

3. Add tests following existing patterns in the project
4. Ensure tests:
   - Use appropriate mocks
   - Test edge cases
   - Follow naming conventions

5. Run tests to verify all pass
6. Commit test additions with clear message describing coverage`,

  'performance': `[Improvement: {appName}] Performance Analysis

Analyze {appName} for performance issues:

Repository: {repoPath}

1. Review components/views for:
   - Unnecessary re-renders
   - Missing memoization
   - Large files that should be split

2. Review backend for:
   - N+1 query patterns
   - Missing caching opportunities
   - Inefficient file operations
   - Slow API endpoints

3. Review build/bundle for:
   - Missing code splitting
   - Large dependencies that could be optimized

4. Check for:
   - Memory leaks
   - Unnecessary broadcasts/events

Optimize and commit improvements.`,

  'accessibility': `[Improvement: {appName}] Accessibility Audit

Audit {appName} for accessibility issues:

Repository: {repoPath}

If the app has a web UI:
1. Navigate to the app's UI
2. Check for:
   - Missing ARIA labels
   - Missing alt text on images
   - Insufficient color contrast
   - Keyboard navigation issues
   - Focus indicators
   - Semantic HTML usage

3. Fix accessibility issues in components
4. Add appropriate aria-* attributes
5. Test and commit changes`,

  'console-errors': `[Improvement: {appName}] Console Error Investigation

Find and fix console errors in {appName}:

Repository: {repoPath}

1. If the app has a UI, check browser console for errors
2. Check server logs for errors
3. For each error:
   - Identify the source file and line
   - Understand the root cause
   - Implement a fix

4. Test fixes and commit changes`,

  'dependency-updates': `[Improvement: {appName}] Dependency Updates

Check {appName} dependencies for updates and security vulnerabilities:

Repository: {repoPath}

1. Run npm audit (or equivalent package manager)
2. Check for outdated packages
3. Review CRITICAL and HIGH severity vulnerabilities
4. For each vulnerability:
   - Assess actual risk
   - Check if update available
   - Test updates don't break functionality

5. Update dependencies carefully:
   - Patch versions first (safest)
   - Then minor versions
   - Major versions need careful review

6. After updating:
   - Run tests
   - Verify the app starts correctly

7. Commit with clear changelog

IMPORTANT: Only update one major version bump at a time.`,

  'documentation': `[Improvement: {appName}] Update Documentation

Review and improve {appName} documentation:

Repository: {repoPath}

1. Check README.md:
   - Installation instructions current?
   - Quick start guide clear?
   - Feature overview complete?

2. Review inline documentation:
   - Add JSDoc to exported functions
   - Document complex algorithms
   - Explain non-obvious code

3. Check for docs/ folder:
   - Are all features documented?
   - Is information current?
   - Add missing guides if needed

4. Update PLAN.md and DONE.md if present:
   - Move completed milestones from PLAN.md to DONE.md
   - Keep PLAN.md focused on next actions and future work

Commit documentation improvements.`,

  'ui-bugs': `[Improvement: {appName}] UI Bug Analysis

Use Playwright MCP (browser_navigate, browser_snapshot, browser_console_messages) to analyze the app UI:

1. Navigate to the app's UI
2. Check each main route
3. For each route:
   - Take a browser_snapshot to see the page structure
   - Check browser_console_messages for JavaScript errors
   - Look for broken UI elements, missing data, failed requests
4. Fix any bugs found in the components or API routes
5. Run tests and commit changes`,

  'mobile-responsive': `[Improvement: {appName}] Mobile Responsiveness Analysis

Use Playwright MCP to test the app at different viewport sizes:

1. browser_resize to mobile (375x812), then navigate to the app UI
2. Take browser_snapshot and analyze for:
   - Text overflow or truncation
   - Buttons too small to tap (< 44px)
   - Horizontal scrolling issues
   - Elements overlapping
   - Navigation usability
3. Repeat at tablet (768x1024) and desktop (1440x900)
4. Fix CSS responsive classes as needed
5. Test fixes and commit changes`,

  'feature-ideas': `[Improvement: {appName}] Implement Next Planned Feature

You are working in a git worktree on a feature branch. Your goal is to implement the next planned item from PLAN.md, or brainstorm a new feature if no plan exists.

Repository: {repoPath}

## Phase 1 — Find the Next Task

1. Read PLAN.md from {repoPath}
2. Read DONE.md from {repoPath} (if it exists) to understand what has already been implemented
3. If PLAN.md does not exist, is empty, or has no unchecked items (\`- [ ]\`), go to **Phase 4 — Brainstorm**.
4. Find the first unchecked item (\`- [ ]\`) that does NOT have a \`<!-- NEEDS_INPUT -->\` annotation
5. If all unchecked items have \`<!-- NEEDS_INPUT -->\`, go to **Phase 4 — Brainstorm**.

## Phase 2 — Evaluate Feasibility

6. Read relevant source files to understand the scope of the item
7. Determine: can this be implemented without user clarification?
   - Consider: are requirements clear? Are there ambiguous design choices? Does it depend on external decisions?

## Phase 3a — Implement (if feasible)

8. Implement the feature:
   - Write clean, tested code following existing patterns
   - Run tests to ensure nothing is broken
9. Run \`/simplify\` to review changed code for reuse, quality, and efficiency. Fix any issues found.
10. Check the PLAN.md item: change \`- [ ]\` to \`- [x]\`
11. Commit with a clear description referencing the PLAN.md item

## Phase 3b — Request Clarification (if not feasible)

8. Create a file named \`.plan-questions.md\` in the repository root with this format:
   \`\`\`
   # Plan Question: <short title summarizing the PLAN.md item>

   ## PLAN.md Item
   <the exact text of the unchecked item>

   ## Questions
   - <question 1>
   - <question 2>
   \`\`\`
9. Annotate the PLAN.md item by appending \` <!-- NEEDS_INPUT -->\` to its line
10. Commit both changes with message "chore: flag PLAN.md item needing user input"
11. Do NOT open a PR — stop here

## Phase 4 — Brainstorm a New Feature

When PLAN.md is missing, empty, or fully completed, brainstorm and implement a new feature:

1. Read GOALS.md from {repoPath} for context on the app's goals and priorities.
   If no GOALS.md exists, focus on general improvements.
2. Read DONE.md from {repoPath} (if it exists) to avoid re-implementing completed features
3. Review the codebase structure, recent git log, and any README or docs to understand the app
4. Identify ONE small, high-impact feature that:
   - Aligns with GOALS.md priorities (if available)
   - Is NOT already in DONE.md (avoid re-implementing shipped features)
   - Saves user time, improves UX, or makes the app more useful
   - Is self-contained and completable in one session
   - Does NOT duplicate existing functionality
5. Implement the feature:
   - Write clean, tested code following existing patterns
   - Run tests to ensure nothing is broken
6. Run \`/simplify\` to review changed code for reuse, quality, and efficiency. Fix any issues found.
7. Add the feature as a checked item in PLAN.md (create the file if needed):
   \`\`\`
   - [x] <description of the feature you implemented>
   \`\`\`
8. Commit with a clear description of the feature and rationale`,

  'error-handling': `[Improvement: {appName}] Improve Error Handling

Enhance error handling in {appName}:

Repository: {repoPath}

1. Review code for:
   - Missing try-catch blocks where needed
   - Silent failures (empty catch blocks)
   - Errors that should be logged
   - User-facing error messages

2. Add error handling for:
   - Network requests
   - File operations
   - Database queries
   - External API calls

3. Ensure errors are:
   - Logged appropriately
   - Have clear messages
   - Include relevant context
   - Don't expose sensitive data

4. Test error paths and commit improvements`,

  'typing': `[Improvement: {appName}] TypeScript Type Improvements

Improve TypeScript types in {appName}:

Repository: {repoPath}

1. Review TypeScript files for:
   - 'any' types that should be specific
   - Missing type annotations
   - Type assertions that could be avoided
   - Missing interfaces/types for objects

2. Add types for:
   - Function parameters and returns
   - Component props
   - API responses
   - Configuration objects

3. Ensure:
   - Types are properly exported
   - No implicit any
   - Types are reusable

4. Run type checking and commit improvements`,

  'release-check': `[Improvement: {appName}] Release Check — dev → main

Check if the dev branch has accumulated enough work for a release, and if so, create a PR to main, wait for Copilot code review, iterate on feedback until clean, and merge.

NOTE: The repo has a GitHub ruleset that automatically requests a Copilot code review on every push to a PR targeting main. You do NOT need to manually request reviews — just create/push the PR and wait.

## Step 1: Evaluate Readiness

Read the current changelog and version:
- \`cat .changelog/v*.x.md\` (the one with literal "x", not a resolved version)
- \`node -p "require('./package.json').version"\`

Count substantive entries (lines starting with "###" or "- **" under Features, Fixes, Improvements sections). If fewer than 2 substantive entries exist, stop and report: "Not enough work accumulated for a release." Do NOT create a PR.

## Step 2: Verify Clean State

Run these checks (stop if any fail):
1. \`git fetch origin\` and ensure dev is up to date: \`git status -uno\` should show "Your branch is up to date"
2. \`cd server && npm test\` — all tests must pass
3. \`cd client && npm run build\` — build must succeed

## Step 3: Create or Find PR

Check for existing PR: \`gh pr list --base main --head dev --state open --json number,url\`

If a PR exists, use it. If not, create one:
\`\`\`bash
gh pr create --base main --head dev --title "Release $(node -p \\"require('./package.json').version\\")" --body "$(cat .changelog/v*.x.md | head -60)"
\`\`\`

Capture the PR number and URL.

## Step 4: Wait for Copilot Review

Copilot review is triggered automatically on push. Poll every 15 seconds until the review appears:
\`\`\`bash
gh api repos/atomantic/PortOS/pulls/PR_NUM/reviews --jq '.[] | select(.user.login == "copilot-pull-request-reviewer") | .state'
\`\`\`

Wait until you see APPROVED or CHANGES_REQUESTED. Timeout after 5 minutes of polling.

## Step 5: Address Feedback Loop (max 5 iterations)

### 5a. Fetch unresolved review threads

Use gh api graphql (JSON input to avoid shell escaping issues with GraphQL variables):

\`\`\`bash
echo '{"query":"query{repository(owner:\\"atomantic\\",name:\\"PortOS\\"){pullRequest(number:PR_NUM){reviewThreads(first:100){nodes{id,isResolved,comments(first:10){nodes{body,path,line,author{login}}}}}}}}"}' | gh api graphql --input -
\`\`\`

### 5b. If no unresolved threads: skip to Step 6 (Merge).

### 5c. If unresolved threads exist, evaluate each one:

For each comment, read the referenced file and critically evaluate the suggestion:
- **If the suggestion is valid and improves the code**: apply the fix
- **If the suggestion is a false positive, overly pedantic, or would make the code worse**: do NOT change the code

Either way, resolve every thread — the goal is zero unresolved threads before merge.

After evaluating all threads:
- If any code changes were made: run \`cd server && npm test\` to verify, then commit and push:
  \`git add <files> && git commit -m "fix: address Copilot review feedback"\`
  \`git pull --rebase --autostash && git push\`

### 5d. Resolve ALL threads via GraphQL mutation (both fixed and dismissed):

For each thread, use the thread node id from 5a:
\`\`\`bash
echo '{"query":"mutation{resolveReviewThread(input:{threadId:\\"THREAD_NODE_ID\\"}){thread{isResolved}}}"}' | gh api graphql --input -
\`\`\`

### 5e. Wait for new Copilot review if code was pushed (repeat Step 4)

If you pushed changes in 5c, the push automatically triggers a new Copilot review. Poll for it, then loop back to 5a. If no code changes were made (all threads were false positives), skip straight to Step 6.

If after 5 iterations there are still unresolved threads, stop and report what remains.

## Step 6: Merge

Only merge when Copilot's most recent review has NO unresolved threads:
\`\`\`bash
gh pr merge PR_NUM --merge
\`\`\`

If merge fails (e.g., branch protections), try: \`gh pr merge PR_NUM --merge --admin\`

## Step 7: Report

Summarize:
- Version released
- Key changes (from changelog)
- Number of review iterations needed
- Any unresolved issues

IMPORTANT: Always use \`git pull --rebase --autostash\` before pushing (dev branch gets auto-bumped by CI). Never use \`git push\` alone.`,

  'jira-sprint-manager': `[Improvement: {appName}] JIRA Sprint Manager

Triage and implement JIRA tickets for {appName}:

Repository: {repoPath}

## Phase 1 — Triage

1. Call GET /api/apps to find the app config for {appName} (match by name or repoPath)
2. Get the app's JIRA config: jira.instanceId and jira.projectKey
3. Call GET /api/jira/instances/:instanceId/my-sprint-tickets/:projectKey to get tickets assigned to me in current sprint
4. For each ticket, evaluate what needs to be done next:
   a) Needs clarification or better requirements? Create a Review Hub todo via POST /api/review/todo with title "[TICKET-KEY] Needs clarification" and description listing the questions
   b) Blocked or needs discussion? Create a Review Hub todo with title "[TICKET-KEY] Blocked" and description explaining the blockers
   c) Well-defined and ready to work? Mark it as a candidate for implementation
5. Prioritize tickets marked as HIGH or Blocker

Do NOT comment on JIRA tickets directly — all action items go to the Review Hub so the user can review them in one place.

## Phase 2 — Implement

6. From the triage results, select the highest priority ticket in "To Do" or "Ready" status that is well-defined
7. For the selected ticket:
   - Implement the ticket requirements in {repoPath}
   - Commit changes and push the branch
   - Create a merge request using gh CLI or glab CLI (detect from git remote)
   - Transition the ticket to "In Review" status
   - Add a comment to JIRA with the MR link
8. If no tickets are ready to implement, skip Phase 2

## Phase 3 — Report

9. Generate a summary report covering triage actions taken and implementation work completed`,

  'branch-cleanup': `[Improvement: {appName}] Branch Cleanup — Delete Merged Branches

Clean up stale branches in {appName} that have already been merged into the default branch.

Repository: {repoPath}

## Phase 1 — Identify Merged Branches

1. cd into {repoPath}
2. Run \`git fetch origin --prune\` to sync remote refs and remove stale tracking references
3. Detect the default branch: \`git branch --list\` — look for main, then master
4. List all local branches: \`git branch --format='%(refname:short)'\`
5. List merged branches: \`git branch --merged <defaultBranch> --format='%(refname:short)'\`
6. Filter out protected branches that must NEVER be deleted:
   - main, master (default branches)
   - release (release branch)
   - dev, develop (development branches)
   - The currently checked-out branch

## Phase 2 — Delete Merged Local Branches

7. For each merged branch that is NOT protected:
   - Delete locally: \`git branch -d <branch>\`
   - Log the branch name and result

## Phase 3 — Clean Up Merged Remote Branches

8. List remote branches merged into the default branch: \`git branch -r --merged origin/<defaultBranch> --format='%(refname:short)'\`
9. Filter out protected remote branches (origin/main, origin/master, origin/release, origin/dev, origin/develop, origin/HEAD)
10. For each merged remote branch:
    - Delete remotely: \`git push origin --delete <branch>\`
    - Log the branch name and result

## Phase 4 — Checkout Default Branch

11. Checkout the default branch so the repo is not left on a stale feature branch: \`git checkout <defaultBranch>\`

## Phase 5 — Report

12. Summarize:
    - Total branches found (local and remote)
    - Branches deleted (local and remote)
    - Branches skipped (protected or unmerged)
    - Any errors encountered

IMPORTANT: Never delete unmerged branches. Only delete branches fully merged into the default branch. Use \`git branch -d\` (not -D) for local branches to ensure safety.`,

  'pr-reviewer': `[Improvement: {appName}] PR Review — Check Open PRs

Review open pull requests / merge requests on {appName} from other contributors and post code reviews on any that lack a review since the last commit.

Repository: {repoPath}

## Phase 0 — Prerequisites

0. Ensure slash-do is installed by running \`command -v slash-do\`. If not found, install it with \`npm install -g slash-do@latest\`.

## Phase 1 — Discover PRs

1. cd into {repoPath}
2. Detect SCM provider from git remote URL:
   - Contains "github.com" -> use \`gh\` CLI
   - Contains "gitlab" -> use \`glab\` CLI
3. List open PRs/MRs authored by others (not by atomantic):
   - GitHub: \`gh pr list --state open --json number,author,headRefName,updatedAt,title\`
   - GitLab: \`glab mr list --state opened -F json\`

## Phase 2 — Check Review Status

4. For each PR/MR from other contributors:
   - GitHub: \`gh pr view <number> --json reviews,commits\` — check if I have a review newer than the latest commit
   - GitLab: \`glab mr view <iid> -F json\` — check notes/approvals vs last commit date
5. Skip PRs where I already have a review posted after the most recent commit push

## Phase 3 — Review

6. For each PR/MR needing review:
   - cd into {repoPath}
   - Run \`/do:review\` to perform a deep code review of the changed files
   - Post the review:
     - GitHub: \`gh pr review <number> --comment --body "<review>"\`
     - GitLab: \`glab mr note <iid> --message "<review>"\`

## Phase 4 — Report

7. Summarize: apps checked, PRs reviewed (with links), PRs skipped (already reviewed)`
};

// Prompt versions — bump when a default prompt changes so existing instances auto-upgrade.
// Only non-customized prompts (promptCustomized !== true) are upgraded.
const PROMPT_VERSIONS = {
  'feature-ideas': 5   // v5: read DONE.md to avoid re-implementing completed features
};

// Known previous default prompts for legacy migration.
// When a schedule has no promptVersion, we check if the stored prompt matches
// any known previous default. If so, it's safe to auto-upgrade (not user-customized).
const PREVIOUS_DEFAULT_PROMPTS = {
  'feature-ideas': [
    // v1 default prompt
    `[Improvement: {appName}] Feature Review and Development

Evaluate existing features and consider new ones to make {appName} more useful:

Repository: {repoPath}

1. Read GOALS.md from {repoPath} for context on the app's goals and priorities.
   If no GOALS.md exists, focus on general improvements.
2. Review recent completed tasks and user feedback to understand patterns
3. Assess current features:
   - Are existing features working well toward our goals?
   - Are there features that could be improved or refined?
   - Are there features that are underperforming or causing friction?

4. Choose ONE action to take (in order of preference):
   a) IMPROVE an existing feature that isn't meeting its potential
   b) ADD a new high-impact feature
   c) ARCHIVE a feature that is not helping our goals

5. Implement it:
   - Write clean, tested code
   - Follow existing patterns
   - Update relevant documentation

6. Commit with a clear description of the change and rationale

Think critically about what we have before adding more.`,
    // v2 default prompt
    `[Improvement: {appName}] Implement a Feature Idea

You are working in a git worktree on a feature branch. Your goal is to implement ONE feature and open a PR.

Repository: {repoPath}

## Research Phase

1. Read GOALS.md from {repoPath} for context on the app's goals and priorities.
   If no GOALS.md exists, focus on general improvements.
2. Read PLAN.md from {repoPath} for the current roadmap and planned work.
3. Search for existing feature idea documents:
   - Check .planning/ directory for feature specs, research docs, or FEATURES.md
   - Check for any TODO.md, IDEAS.md, or similar feature tracking files
4. Review recent completed tasks and user feedback to understand patterns
5. Review recent git log to see what's been implemented recently

## Selection Phase

6. Choose ONE feature to implement that:
   - Aligns with GOALS.md priorities
   - Is NOT already planned in PLAN.md (avoid duplicating roadmap work)
   - Is NOT already documented in existing feature idea files
   - Is a small, self-contained improvement (completable in one session)
   - Saves user time, improves the developer experience, or makes the app more useful

## Implementation Phase

7. Implement the feature:
   - Write clean, tested code
   - Follow existing patterns in the codebase
   - Run tests to ensure nothing is broken

8. Run \`/simplify\` to review changed code for reuse, quality, and efficiency. Fix any issues found.

9. Commit with a clear description of the feature and rationale`,
    // v3 default prompt
    `[Improvement: {appName}] Implement Next Planned Feature

You are working in a git worktree on a feature branch. Your goal is to implement the next planned item from PLAN.md.

Repository: {repoPath}

## Phase 1 — Find the Next Task

1. Read PLAN.md from {repoPath}
2. Find the first unchecked item (\`- [ ]\`) that does NOT have a \`<!-- NEEDS_INPUT -->\` annotation
3. If no unchecked items exist, stop and report: "PLAN.md has no remaining items."

## Phase 2 — Evaluate Feasibility

4. Read relevant source files to understand the scope of the item
5. Determine: can this be implemented without user clarification?
   - Consider: are requirements clear? Are there ambiguous design choices? Does it depend on external decisions?

## Phase 3a — Implement (if feasible)

6. Implement the feature:
   - Write clean, tested code following existing patterns
   - Run tests to ensure nothing is broken
7. Run \`/simplify\` to review changed code for reuse, quality, and efficiency. Fix any issues found.
8. Check the PLAN.md item: change \`- [ ]\` to \`- [x]\`
9. Commit with a clear description referencing the PLAN.md item

## Phase 3b — Request Clarification (if not feasible)

6. Create a file named \`.plan-questions.md\` in the repository root with this format:
   \`\`\`
   # Plan Question: <short title summarizing the PLAN.md item>

   ## PLAN.md Item
   <the exact text of the unchecked item>

   ## Questions
   - <question 1>
   - <question 2>
   \`\`\`
7. Annotate the PLAN.md item by appending \` <!-- NEEDS_INPUT -->\` to its line
8. Commit both changes with message "chore: flag PLAN.md item needing user input"
9. Do NOT open a PR — stop here`,
    // v4 default prompt (before DONE.md support)
    `[Improvement: {appName}] Implement Next Planned Feature

You are working in a git worktree on a feature branch. Your goal is to implement the next planned item from PLAN.md, or brainstorm a new feature if no plan exists.

Repository: {repoPath}

## Phase 1 — Find the Next Task

1. Read PLAN.md from {repoPath}
2. If PLAN.md does not exist, is empty, or has no unchecked items (\`- [ ]\`), go to **Phase 4 — Brainstorm**.
3. Find the first unchecked item (\`- [ ]\`) that does NOT have a \`<!-- NEEDS_INPUT -->\` annotation
4. If all unchecked items have \`<!-- NEEDS_INPUT -->\`, go to **Phase 4 — Brainstorm**.

## Phase 2 — Evaluate Feasibility

5. Read relevant source files to understand the scope of the item
6. Determine: can this be implemented without user clarification?
   - Consider: are requirements clear? Are there ambiguous design choices? Does it depend on external decisions?

## Phase 3a — Implement (if feasible)

7. Implement the feature:
   - Write clean, tested code following existing patterns
   - Run tests to ensure nothing is broken
8. Run \`/simplify\` to review changed code for reuse, quality, and efficiency. Fix any issues found.
9. Check the PLAN.md item: change \`- [ ]\` to \`- [x]\`
10. Commit with a clear description referencing the PLAN.md item

## Phase 3b — Request Clarification (if not feasible)

7. Create a file named \`.plan-questions.md\` in the repository root with this format:
   \`\`\`
   # Plan Question: <short title summarizing the PLAN.md item>

   ## PLAN.md Item
   <the exact text of the unchecked item>

   ## Questions
   - <question 1>
   - <question 2>
   \`\`\`
8. Annotate the PLAN.md item by appending \` <!-- NEEDS_INPUT -->\` to its line
9. Commit both changes with message "chore: flag PLAN.md item needing user input"
10. Do NOT open a PR — stop here

## Phase 4 — Brainstorm a New Feature

When PLAN.md is missing, empty, or fully completed, brainstorm and implement a new feature:

1. Read GOALS.md from {repoPath} for context on the app's goals and priorities.
   If no GOALS.md exists, focus on general improvements.
2. Review the codebase structure, recent git log, and any README or docs to understand the app
3. Identify ONE small, high-impact feature that:
   - Aligns with GOALS.md priorities (if available)
   - Saves user time, improves UX, or makes the app more useful
   - Is self-contained and completable in one session
   - Does NOT duplicate existing functionality
4. Implement the feature:
   - Write clean, tested code following existing patterns
   - Run tests to ensure nothing is broken
5. Run \`/simplify\` to review changed code for reuse, quality, and efficiency. Fix any issues found.
6. Add the feature as a checked item in PLAN.md (create the file if needed):
   \`\`\`
   - [x] <description of the feature you implemented>
   \`\`\`
7. Commit with a clear description of the feature and rationale`
  ]
};

// Unified default interval settings for all 17 task types
export const SELF_IMPROVEMENT_TASK_TYPES = [
  'security', 'code-quality', 'test-coverage', 'performance',
  'accessibility', 'branch-cleanup', 'console-errors', 'dependency-updates', 'documentation',
  'ui-bugs', 'mobile-responsive', 'feature-ideas', 'error-handling',
  'typing', 'release-check', 'pr-reviewer', 'jira-sprint-manager'
];

const DEFAULT_TASK_INTERVALS = {
  'security':            { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'code-quality':        { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null },
  'test-coverage':       { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'performance':         { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'accessibility':       { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null },
  'branch-cleanup':      { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'console-errors':      { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null },
  'dependency-updates':  { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'documentation':       { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null },
  'ui-bugs':             { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null },
  'mobile-responsive':   { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null },
  'feature-ideas':       { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, simplify: true } },
  'error-handling':      { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null },
  'typing':              { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null },
  'release-check':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null },
  'pr-reviewer':         { type: INTERVAL_TYPES.CUSTOM, intervalMs: 7200000, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null },
  'jira-sprint-manager': { type: INTERVAL_TYPES.DAILY, enabled: false, weekdaysOnly: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: true, openPR: true, simplify: true } }
};

/**
 * Default schedule data structure (v2 - unified)
 */
const DEFAULT_SCHEDULE = {
  version: 2,
  lastUpdated: null,

  // Unified task intervals (applies to all apps including PortOS)
  tasks: {
    ...DEFAULT_TASK_INTERVALS
  },

  // Track last execution times
  // Format: 'task:security': { lastRun: timestamp, count: number, perApp: {} }
  executions: {},

  // On-demand task templates that can be triggered manually
  templates: []
};

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await ensureDir(DATA_DIR);
  }
}

/**
 * Migrate v1 schedule (selfImprovement + appImprovement) to v2 (unified tasks)
 */
function migrateScheduleV1toV2(schedule) {
  emitLog('info', 'Migrating task schedule from v1 to v2 (unified)', {}, '📅 TaskSchedule');

  const migrated = {
    version: 2,
    lastUpdated: new Date().toISOString(),
    tasks: { ...DEFAULT_TASK_INTERVALS },
    executions: {},
    templates: schedule.templates || [],
    onDemandRequests: schedule.onDemandRequests || []
  };

  // Merge selfImprovement settings into tasks (excluding cos-enhancement)
  if (schedule.selfImprovement) {
    for (const [taskType, config] of Object.entries(schedule.selfImprovement)) {
      if (taskType === 'cos-enhancement') continue; // Removed
      // security stays as 'security' (was already named this in selfImprovement)
      if (migrated.tasks[taskType]) {
        migrated.tasks[taskType] = { ...migrated.tasks[taskType], ...config };
      }
    }
  }

  // Merge appImprovement settings into tasks
  if (schedule.appImprovement) {
    for (const [taskType, config] of Object.entries(schedule.appImprovement)) {
      // Rename security-audit → security
      const unifiedType = taskType === 'security-audit' ? 'security' : taskType;
      if (migrated.tasks[unifiedType]) {
        // If selfImprovement already set a non-default config, prefer it for overlapping types
        // unless appImprovement has a different non-default config
        const existing = migrated.tasks[unifiedType];
        const isExistingDefault = existing.type === DEFAULT_TASK_INTERVALS[unifiedType]?.type;
        const isNewDifferent = config.type !== (taskType === 'security-audit'
          ? INTERVAL_TYPES.WEEKLY : DEFAULT_TASK_INTERVALS[unifiedType]?.type);
        if (isExistingDefault || isNewDifferent) {
          migrated.tasks[unifiedType] = { ...existing, ...config };
        }
      }
    }
  }

  // Migrate execution keys: self-improve:X → task:X, app-improve:X → task:X
  if (schedule.executions) {
    for (const [key, data] of Object.entries(schedule.executions)) {
      let newKey = key;
      if (key.startsWith('self-improve:')) {
        const taskType = key.replace('self-improve:', '');
        if (taskType === 'cos-enhancement') continue; // Removed
        newKey = `task:${taskType}`;
      } else if (key.startsWith('app-improve:')) {
        let taskType = key.replace('app-improve:', '');
        if (taskType === 'security-audit') taskType = 'security';
        newKey = `task:${taskType}`;
      }

      if (migrated.executions[newKey]) {
        // Merge: combine counts, keep latest lastRun, merge perApp
        const existing = migrated.executions[newKey];
        existing.count = (existing.count || 0) + (data.count || 0);
        if (data.lastRun && (!existing.lastRun || new Date(data.lastRun) > new Date(existing.lastRun))) {
          existing.lastRun = data.lastRun;
        }
        if (data.perApp) {
          existing.perApp = { ...existing.perApp, ...data.perApp };
        }
      } else {
        migrated.executions[newKey] = { ...data };
      }
    }
  }

  // Populate prompts from defaults if missing
  for (const [taskType, config] of Object.entries(migrated.tasks)) {
    if (!config.prompt && DEFAULT_TASK_PROMPTS[taskType]) {
      config.prompt = DEFAULT_TASK_PROMPTS[taskType];
    }
  }

  return migrated;
}

/**
 * Load schedule data (auto-migrates from v1 if needed)
 */
export async function loadSchedule() {
  await ensureDataDir();

  const loaded = await readJSONFile(SCHEDULE_FILE, null);
  if (!loaded) {
    return { ...DEFAULT_SCHEDULE };
  }

  // Auto-migrate v1 → v2
  if (!loaded.version || loaded.version === 1) {
    const migrated = migrateScheduleV1toV2(loaded);
    await saveSchedule(migrated);
    return migrated;
  }

  // v2: merge each task config with its default to backfill new fields
  // Deep-merge taskMetadata so new default keys are inherited unless explicitly overridden
  const mergedTasks = {};
  for (const taskType of Object.keys(DEFAULT_TASK_INTERVALS)) {
    const defaultTask = DEFAULT_TASK_INTERVALS[taskType];
    const loadedTask = loaded.tasks?.[taskType] || {};
    const merged = { ...defaultTask, ...loadedTask };
    // Deep-merge taskMetadata: preserve explicit null (clears metadata), otherwise merge defaults with stored
    // Only spread if loadedTask.taskMetadata is a plain object to avoid corrupting config
    if (defaultTask.taskMetadata && loadedTask.taskMetadata !== null) {
      const storedMeta = loadedTask.taskMetadata;
      const isPlainObject = storedMeta && typeof storedMeta === 'object' && !Array.isArray(storedMeta);
      merged.taskMetadata = { ...defaultTask.taskMetadata, ...(isPlainObject ? storedMeta : {}) };
    }
    mergedTasks[taskType] = merged;
  }
  // Preserve any extra task types from loaded that aren't in defaults
  for (const taskType of Object.keys(loaded.tasks || {})) {
    if (!mergedTasks[taskType]) {
      mergedTasks[taskType] = loaded.tasks[taskType];
    }
  }

  const schedule = {
    ...DEFAULT_SCHEDULE,
    ...loaded,
    tasks: mergedTasks,
    executions: loaded.executions || {},
    templates: loaded.templates || []
  };

  // Populate prompts from defaults if missing, and auto-upgrade stale defaults
  let needsSave = false;
  for (const [taskType, config] of Object.entries(schedule.tasks)) {
    if (!config.prompt && DEFAULT_TASK_PROMPTS[taskType]) {
      // No prompt set — initialize with current default and version
      config.prompt = DEFAULT_TASK_PROMPTS[taskType];
      config.promptVersion = PROMPT_VERSIONS[taskType] || 1;
      needsSave = true;
    } else {
      // Legacy migration: infer customization when promptVersion is missing
      if (
        config.prompt &&
        config.promptVersion === undefined &&
        DEFAULT_TASK_PROMPTS[taskType]
      ) {
        if (config.prompt === DEFAULT_TASK_PROMPTS[taskType]) {
          // Matches current default — assign current version (no upgrade needed)
          config.promptVersion = PROMPT_VERSIONS[taskType] || 1;
          needsSave = true;
        } else if ((PREVIOUS_DEFAULT_PROMPTS[taskType] || []).includes(config.prompt)) {
          // Matches a known previous default — assign version 1 so auto-upgrade triggers
          config.promptVersion = 1;
          needsSave = true;
        } else {
          // Prompt differs from all known defaults — treat as user-customized
          config.promptCustomized = true;
          config.promptVersion = PROMPT_VERSIONS[taskType] || 1;
          needsSave = true;
        }
      }

      if (PROMPT_VERSIONS[taskType] && !config.promptCustomized) {
        // Auto-upgrade non-customized prompts when code version is newer
        const storedVersion = config.promptVersion || 1;
        if (storedVersion < PROMPT_VERSIONS[taskType]) {
          emitLog('info', `Upgrading ${taskType} prompt v${storedVersion} → v${PROMPT_VERSIONS[taskType]}`, { taskType }, '📅 TaskSchedule');
          config.prompt = DEFAULT_TASK_PROMPTS[taskType];
          config.promptVersion = PROMPT_VERSIONS[taskType];
          needsSave = true;
        }
      }
    }
  }

  if (needsSave) {
    await saveSchedule(schedule);
  }

  return schedule;
}

async function saveSchedule(schedule) {
  await ensureDataDir();
  schedule.lastUpdated = new Date().toISOString();
  await writeFile(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
}

// ============================================================
// Unified getters/setters (replace split self/app functions)
// ============================================================

export async function getTaskInterval(taskType) {
  const schedule = await loadSchedule();
  return schedule.tasks[taskType] || { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null };
}

export async function updateTaskInterval(taskType, settings) {
  const schedule = await loadSchedule();

  if (!schedule.tasks[taskType]) {
    schedule.tasks[taskType] = { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null };
  }

  // Normalize empty/whitespace prompts to null (treated as "use default")
  if ('prompt' in settings && typeof settings.prompt === 'string' && !settings.prompt.trim()) {
    settings.prompt = null;
  }
  // If user is setting a custom prompt, mark it so auto-upgrade won't overwrite it.
  // If user clears the prompt (null), remove the customized flag to resume defaults.
  if ('prompt' in settings) {
    settings.promptCustomized = settings.prompt != null;
  }

  schedule.tasks[taskType] = {
    ...schedule.tasks[taskType],
    ...settings
  };

  await saveSchedule(schedule);
  emitLog('info', `Updated task interval for ${taskType}`, { taskType, settings }, '📅 TaskSchedule');
  cosEvents.emit('schedule:changed', { taskType, settings });

  return schedule.tasks[taskType];
}

/**
 * Record a task execution
 */
export async function recordExecution(taskType, appId = null) {
  const schedule = await loadSchedule();
  const key = taskType.startsWith('task:') ? taskType : `task:${taskType}`;

  if (!schedule.executions[key]) {
    schedule.executions[key] = {
      lastRun: null,
      count: 0,
      perApp: {}
    };
  }

  schedule.executions[key].lastRun = new Date().toISOString();
  schedule.executions[key].count = (schedule.executions[key].count || 0) + 1;

  if (appId) {
    if (!schedule.executions[key].perApp[appId]) {
      schedule.executions[key].perApp[appId] = {
        lastRun: null,
        count: 0
      };
    }
    schedule.executions[key].perApp[appId].lastRun = new Date().toISOString();
    schedule.executions[key].perApp[appId].count++;
  }

  await saveSchedule(schedule);
  return schedule.executions[key];
}

export async function getExecutionHistory(taskType) {
  const schedule = await loadSchedule();
  const key = taskType.startsWith('task:') ? taskType : `task:${taskType}`;
  return schedule.executions[key] || { lastRun: null, count: 0, perApp: {} };
}

/**
 * Check if a task type should run for a specific app (or globally)
 */
export async function shouldRunTask(taskType, appId = null) {
  const schedule = await loadSchedule();
  const interval = schedule.tasks[taskType];

  if (!interval || !interval.enabled) {
    return { shouldRun: false, reason: 'disabled' };
  }

  // Weekday-only tasks skip weekends
  if (interval.weekdaysOnly) {
    const day = new Date().getDay();
    if (day === 0 || day === 6) {
      return { shouldRun: false, reason: 'weekday-only' };
    }
  }

  if (appId) {
    const enabledForApp = await isTaskTypeEnabledForApp(appId, taskType);
    if (!enabledForApp) {
      return { shouldRun: false, reason: 'disabled-for-app' };
    }
  }

  // Determine effective interval type: per-app override takes precedence
  const perAppInterval = appId ? await getAppTaskTypeInterval(appId, taskType) : null;
  const effectiveType = perAppInterval || interval.type;

  const key = `task:${taskType}`;
  const execution = schedule.executions[key] || { lastRun: null, count: 0, perApp: {} };

  // For per-app tracking, use app-specific execution data
  const appExecution = appId
    ? (execution.perApp[appId] || { lastRun: null, count: 0 })
    : execution;

  const now = Date.now();
  const lastRun = appExecution.lastRun ? new Date(appExecution.lastRun).getTime() : 0;
  const timeSinceLastRun = now - lastRun;

  const buildResult = (shouldRun, reason, baseIntervalMs, extra = {}) => {
    const result = { shouldRun, reason, ...extra };
    if (extra.learningAdjustment?.adjusted) {
      result.learningApplied = true;
      result.successRate = extra.learningAdjustment.successRate;
      result.adjustmentMultiplier = extra.learningAdjustment.multiplier;
      result.dataPoints = extra.learningAdjustment.dataPoints;
    }
    return result;
  };

  switch (effectiveType) {
    case INTERVAL_TYPES.ROTATION:
      return { shouldRun: true, reason: 'rotation' };

    case INTERVAL_TYPES.DAILY: {
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, DAY);
      const adjustedInterval = learningAdjustment.adjustedIntervalMs;

      if (timeSinceLastRun >= adjustedInterval) {
        return buildResult(true, learningAdjustment.adjusted ? 'daily-due-adjusted' : 'daily-due', DAY, { learningAdjustment });
      }
      return buildResult(false, learningAdjustment.adjusted ? 'daily-cooldown-adjusted' : 'daily-cooldown', DAY, {
        learningAdjustment,
        nextRunIn: adjustedInterval - timeSinceLastRun,
        nextRunAt: new Date(lastRun + adjustedInterval).toISOString(),
        baseIntervalMs: DAY,
        adjustedIntervalMs: adjustedInterval
      });
    }

    case INTERVAL_TYPES.WEEKLY: {
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, WEEK);
      const adjustedInterval = learningAdjustment.adjustedIntervalMs;

      if (timeSinceLastRun >= adjustedInterval) {
        return buildResult(true, learningAdjustment.adjusted ? 'weekly-due-adjusted' : 'weekly-due', WEEK, { learningAdjustment });
      }
      return buildResult(false, learningAdjustment.adjusted ? 'weekly-cooldown-adjusted' : 'weekly-cooldown', WEEK, {
        learningAdjustment,
        nextRunIn: adjustedInterval - timeSinceLastRun,
        nextRunAt: new Date(lastRun + adjustedInterval).toISOString(),
        baseIntervalMs: WEEK,
        adjustedIntervalMs: adjustedInterval
      });
    }

    case INTERVAL_TYPES.ONCE:
      if (appExecution.count === 0) {
        return { shouldRun: true, reason: 'once-first-run' };
      }
      return { shouldRun: false, reason: 'once-completed', completedAt: appExecution.lastRun };

    case INTERVAL_TYPES.ON_DEMAND:
      return { shouldRun: false, reason: 'on-demand-only' };

    case INTERVAL_TYPES.CUSTOM: {
      const baseInterval = interval.intervalMs || DAY;
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, baseInterval);
      const adjustedInterval = learningAdjustment.adjustedIntervalMs;

      if (timeSinceLastRun >= adjustedInterval) {
        return buildResult(true, learningAdjustment.adjusted ? 'custom-due-adjusted' : 'custom-due', baseInterval, { learningAdjustment });
      }
      return buildResult(false, learningAdjustment.adjusted ? 'custom-cooldown-adjusted' : 'custom-cooldown', baseInterval, {
        learningAdjustment,
        nextRunIn: adjustedInterval - timeSinceLastRun,
        nextRunAt: new Date(lastRun + adjustedInterval).toISOString(),
        baseIntervalMs: baseInterval,
        adjustedIntervalMs: adjustedInterval
      });
    }

    default:
      return { shouldRun: true, reason: 'unknown-default-rotation' };
  }
}

/**
 * Get all enabled task types that are due to run (optionally for a specific app)
 */
export async function getDueTasks(appId = null) {
  const schedule = await loadSchedule();
  const due = [];

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;

    const check = await shouldRunTask(taskType, appId);
    if (check.shouldRun) {
      due.push({ taskType, reason: check.reason, interval });
    }
  }

  return due;
}

/**
 * Get the next task type to run (optionally for a specific app)
 */
export async function getNextTaskType(appId = null, lastType = '') {
  const schedule = await loadSchedule();
  const taskTypes = Object.keys(schedule.tasks);

  // First, check for daily/weekly/once tasks that are due
  const dueTasks = await getDueTasks(appId);

  const dailyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.DAILY);
  if (dailyDue.length > 0) {
    return { taskType: dailyDue[0].taskType, reason: 'daily-priority' };
  }

  const weeklyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.WEEKLY);
  if (weeklyDue.length > 0) {
    return { taskType: weeklyDue[0].taskType, reason: 'weekly-priority' };
  }

  const onceDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.ONCE);
  if (onceDue.length > 0) {
    return { taskType: onceDue[0].taskType, reason: 'once-first-run' };
  }

  // Fall back to rotation among enabled rotation tasks
  const rotationTasks = taskTypes.filter(t =>
    schedule.tasks[t].enabled &&
    schedule.tasks[t].type === INTERVAL_TYPES.ROTATION
  );

  if (rotationTasks.length === 0) {
    return null;
  }

  const currentIndex = rotationTasks.indexOf(lastType);
  const nextIndex = (currentIndex + 1) % rotationTasks.length;

  return { taskType: rotationTasks[nextIndex], reason: 'rotation' };
}

// ============================================================
// Templates
// ============================================================

export async function addTemplateTask(template) {
  const schedule = await loadSchedule();

  const newTemplate = {
    id: `template-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    name: template.name,
    description: template.description,
    category: template.category || 'custom',
    taskType: template.taskType,
    priority: template.priority || 'MEDIUM',
    metadata: template.metadata || {}
  };

  schedule.templates.push(newTemplate);
  await saveSchedule(schedule);

  emitLog('info', `Added template task: ${newTemplate.name}`, { templateId: newTemplate.id }, '📅 TaskSchedule');
  return newTemplate;
}

export async function getTemplateTasks() {
  const schedule = await loadSchedule();
  return schedule.templates;
}

export async function deleteTemplateTask(templateId) {
  const schedule = await loadSchedule();
  const index = schedule.templates.findIndex(t => t.id === templateId);

  if (index === -1) {
    return { error: 'Template not found' };
  }

  const deleted = schedule.templates.splice(index, 1)[0];
  await saveSchedule(schedule);

  emitLog('info', `Deleted template task: ${deleted.name}`, { templateId }, '📅 TaskSchedule');
  return { success: true, deleted };
}

// ============================================================
// On-Demand Requests
// ============================================================

export async function triggerOnDemandTask(taskType, appId = null) {
  const schedule = await loadSchedule();

  if (!schedule.onDemandRequests) {
    schedule.onDemandRequests = [];
  }

  const request = {
    id: `demand-${Date.now().toString(36)}`,
    taskType,
    appId,
    requestedAt: new Date().toISOString()
  };

  schedule.onDemandRequests.push(request);
  await saveSchedule(schedule);

  emitLog('info', `On-demand task requested: ${taskType}`, { appId }, '📅 TaskSchedule');
  cosEvents.emit('task:on-demand-requested', request);

  return request;
}

export async function getOnDemandRequests() {
  const schedule = await loadSchedule();
  return schedule.onDemandRequests || [];
}

export async function clearOnDemandRequest(requestId) {
  const schedule = await loadSchedule();

  if (!schedule.onDemandRequests) return null;

  const index = schedule.onDemandRequests.findIndex(r => r.id === requestId);
  if (index === -1) return null;

  const cleared = schedule.onDemandRequests.splice(index, 1)[0];
  await saveSchedule(schedule);

  return cleared;
}

// ============================================================
// Schedule Status
// ============================================================

export async function getScheduleStatus() {
  const schedule = await loadSchedule();
  const status = {
    lastUpdated: schedule.lastUpdated,
    tasks: {},
    templates: schedule.templates,
    onDemandRequests: schedule.onDemandRequests || [],
    learningAdjustmentsActive: 0
  };

  // Fetch active apps once for per-app override aggregation
  const activeApps = await getActiveApps().catch(() => []);
  const totalAppCount = activeApps.length;

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0, perApp: {} };

    // Get learning adjustment info
    const baseInterval = interval.type === 'daily' ? DAY : interval.type === 'weekly' ? WEEK : (interval.intervalMs || DAY);
    const learningInfo = await getPerformanceAdjustedInterval(taskType, baseInterval);

    // Check global shouldRun status
    const check = await shouldRunTask(taskType);

    const isEnabledForApp = (override) => override?.enabled === true;
    const appOverrides = {};
    let enabledAppCount = 0;
    const allOverrides = await Promise.all(activeApps.map(app => getAppTaskTypeOverrides(app.id)));
    for (let i = 0; i < activeApps.length; i++) {
      const override = allOverrides[i][taskType];
      if (override) {
        appOverrides[activeApps[i].id] = {
          enabled: isEnabledForApp(override),
          interval: override.interval || null,
          ...(override.taskMetadata && { taskMetadata: override.taskMetadata })
        };
      }
      if (isEnabledForApp(override)) {
        enabledAppCount++;
      }
    }

    status.tasks[taskType] = {
      ...interval,
      lastRun: execution.lastRun,
      runCount: execution.count,
      globalLastRun: execution.lastRun,
      globalRunCount: execution.count,
      perAppCount: Object.keys(execution.perApp).length,
      appOverrides,
      enabledAppCount,
      totalAppCount,
      status: check,
      learningAdjusted: learningInfo.adjusted,
      learningMultiplier: learningInfo.multiplier,
      successRate: learningInfo.successRate,
      dataPoints: learningInfo.dataPoints,
      adjustedIntervalMs: learningInfo.adjustedIntervalMs,
      recommendation: learningInfo.recommendation
    };

    if (learningInfo.adjusted) {
      status.learningAdjustmentsActive++;
    }
  }

  return status;
}

/**
 * Reset execution history for a task type
 */
export async function resetExecutionHistory(taskType, appId = null) {
  const schedule = await loadSchedule();
  const key = `task:${taskType}`;

  if (!schedule.executions[key]) {
    return { error: 'No execution history found' };
  }

  if (appId) {
    if (schedule.executions[key].perApp?.[appId]) {
      delete schedule.executions[key].perApp[appId];
    }
  } else {
    delete schedule.executions[key];
  }

  await saveSchedule(schedule);
  emitLog('info', `Reset execution history for ${taskType}`, { appId }, '📅 TaskSchedule');

  return { success: true, taskType, appId };
}

// ============================================================
// Prompt getters
// ============================================================

export function getDefaultPrompt(taskType) {
  return DEFAULT_TASK_PROMPTS[taskType] || null;
}

export async function getTaskPrompt(taskType) {
  const interval = await getTaskInterval(taskType);
  return interval.prompt || DEFAULT_TASK_PROMPTS[taskType] || `[Improvement] ${taskType} analysis

Repository: {repoPath}

Perform ${taskType} analysis on {appName}.
Analyze the codebase and make improvements. Commit changes with clear descriptions.`;
}

// ============================================================
// Upcoming Tasks Preview
// ============================================================

export async function getUpcomingTasks(limit = 10) {
  const schedule = await loadSchedule();
  const now = Date.now();
  const upcoming = [];

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;
    if (interval.type === INTERVAL_TYPES.ON_DEMAND) continue;

    const check = await shouldRunTask(taskType);
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0 };

    let eligibleAt = now;
    let taskStatus = 'ready';

    if (check.shouldRun) {
      eligibleAt = now;
      taskStatus = 'ready';
    } else if (check.nextRunAt) {
      eligibleAt = new Date(check.nextRunAt).getTime();
      taskStatus = 'scheduled';
    } else if (interval.type === INTERVAL_TYPES.ONCE && execution.count > 0) {
      taskStatus = 'completed';
      eligibleAt = Infinity;
    }

    if (taskStatus === 'completed') continue;

    upcoming.push({
      taskType,
      intervalType: interval.type,
      status: taskStatus,
      eligibleAt,
      eligibleIn: eligibleAt - now,
      eligibleInFormatted: formatTimeRemaining(eligibleAt - now),
      lastRun: execution.lastRun,
      lastRunFormatted: execution.lastRun ? formatRelativeTime(new Date(execution.lastRun).getTime()) : 'never',
      runCount: execution.count,
      successRate: check.successRate ?? null,
      learningAdjusted: check.learningApplied || false,
      adjustmentMultiplier: check.adjustmentMultiplier || 1.0,
      description: getTaskTypeDescription(taskType)
    });
  }

  upcoming.sort((a, b) => {
    if (a.status === 'ready' && b.status !== 'ready') return -1;
    if (b.status === 'ready' && a.status !== 'ready') return 1;
    return a.eligibleAt - b.eligibleAt;
  });

  return upcoming.slice(0, limit);
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return '< 1m';
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

function getTaskTypeDescription(taskType) {
  const descriptions = {
    'ui-bugs': 'Find and fix UI bugs',
    'mobile-responsive': 'Check mobile responsiveness',
    'security': 'Security vulnerability audit',
    'code-quality': 'Code quality improvements',
    'console-errors': 'Fix console errors',
    'performance': 'Performance optimization',
    'test-coverage': 'Improve test coverage',
    'documentation': 'Update documentation',
    'feature-ideas': 'Implement next planned feature or brainstorm new one',
    'accessibility': 'Accessibility audit',
    'branch-cleanup': 'Clean up merged branches',
    'dependency-updates': 'Update dependencies',
    'release-check': 'Check dev for release readiness',
    'error-handling': 'Improve error handling',
    'typing': 'Improve TypeScript types',
    'pr-reviewer': 'Review open PRs from contributors',
    'jira-sprint-manager': 'Triage and implement JIRA sprint tickets'
  };
  return descriptions[taskType] || taskType.replace(/-/g, ' ');
}

// ============================================================
// Backward-compatible exports (delegate to unified functions)
// ============================================================

export async function getSelfImprovementInterval(taskType) {
  return getTaskInterval(taskType);
}

export async function getAppImprovementInterval(taskType) {
  return getTaskInterval(taskType);
}

export async function updateSelfImprovementInterval(taskType, settings) {
  return updateTaskInterval(taskType, settings);
}

export async function updateAppImprovementInterval(taskType, settings) {
  return updateTaskInterval(taskType, settings);
}

export async function shouldRunSelfImprovementTask(taskType) {
  return shouldRunTask(taskType);
}

export async function shouldRunAppImprovementTask(taskType, appId) {
  return shouldRunTask(taskType, appId);
}

export async function getDueSelfImprovementTasks() {
  return getDueTasks();
}

export async function getDueAppImprovementTasks(appId) {
  return getDueTasks(appId);
}

export async function getNextSelfImprovementTaskType(lastType) {
  return getNextTaskType(null, lastType);
}

export async function getNextAppImprovementTaskType(appId, lastType) {
  return getNextTaskType(appId, lastType);
}

export function getDefaultSelfImprovementPrompt(taskType) {
  return getDefaultPrompt(taskType);
}

export function getDefaultAppImprovementPrompt(taskType) {
  return getDefaultPrompt(taskType);
}

export async function getSelfImprovementPrompt(taskType) {
  return getTaskPrompt(taskType);
}

export async function getAppImprovementPrompt(taskType) {
  return getTaskPrompt(taskType);
}
