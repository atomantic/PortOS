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

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cosEvents, emitLog } from './cos.js';
import { readJSONFile } from '../lib/fileUtils.js';
import { getAdaptiveCooldownMultiplier } from './taskLearning.js';
import { isTaskTypeEnabledForApp, getAppTaskTypeInterval, getActiveApps, getAppTaskTypeOverrides } from './apps.js';
import { PORTOS_UI_URL } from '../lib/ports.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data/cos');
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

// Time constants in milliseconds
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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
// Unified DEFAULT_TASK_PROMPTS (14 task types)
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

4. Update PLAN.md or similar if present:
   - Mark completed milestones
   - Document architectural decisions

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

  'feature-ideas': `[Improvement: {appName}] Feature Review and Development

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

IMPORTANT: Always use \`git pull --rebase --autostash\` before pushing (dev branch gets auto-bumped by CI). Never use \`git push\` alone.`
};

// Unified default interval settings for all 14 task types
export const SELF_IMPROVEMENT_TASK_TYPES = [
  'security', 'code-quality', 'test-coverage', 'performance',
  'accessibility', 'console-errors', 'dependency-updates', 'documentation',
  'ui-bugs', 'mobile-responsive', 'feature-ideas', 'error-handling',
  'typing', 'release-check'
];

const DEFAULT_TASK_INTERVALS = {
  'security':            { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'code-quality':        { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null },
  'test-coverage':       { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'performance':         { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'accessibility':       { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null },
  'console-errors':      { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null },
  'dependency-updates':  { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null },
  'documentation':       { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null },
  'ui-bugs':             { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null },
  'mobile-responsive':   { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null },
  'feature-ideas':       { type: INTERVAL_TYPES.DAILY, enabled: false, providerId: null, model: null, prompt: null },
  'error-handling':      { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, prompt: null },
  'typing':              { type: INTERVAL_TYPES.ONCE, enabled: false, providerId: null, model: null, prompt: null },
  'release-check':       { type: INTERVAL_TYPES.ON_DEMAND, enabled: false, providerId: null, model: null, prompt: null }
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

async function ensureDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
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
  await ensureDir();

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

  // v2: merge with defaults to ensure all task types have settings
  const schedule = {
    ...DEFAULT_SCHEDULE,
    ...loaded,
    tasks: {
      ...DEFAULT_TASK_INTERVALS,
      ...loaded.tasks
    },
    executions: loaded.executions || {},
    templates: loaded.templates || []
  };

  // Populate prompts from defaults if they don't exist
  let needsSave = false;
  for (const [taskType, config] of Object.entries(schedule.tasks)) {
    if (!config.prompt && DEFAULT_TASK_PROMPTS[taskType]) {
      config.prompt = DEFAULT_TASK_PROMPTS[taskType];
      needsSave = true;
    }
  }

  if (needsSave) {
    await saveSchedule(schedule);
  }

  return schedule;
}

async function saveSchedule(schedule) {
  await ensureDir();
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

  // Check per-app override
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

    // Build per-app overrides map and count enabled apps
    const appOverrides = {};
    let enabledAppCount = 0;
    const allOverrides = await Promise.all(activeApps.map(app => getAppTaskTypeOverrides(app.id)));
    for (let i = 0; i < activeApps.length; i++) {
      const override = allOverrides[i][taskType];
      if (override) {
        appOverrides[activeApps[i].id] = {
          enabled: override.enabled !== false,
          interval: override.interval || null
        };
      }
      if (!override || override.enabled !== false) {
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
    'feature-ideas': 'Brainstorm and implement features',
    'accessibility': 'Accessibility audit',
    'dependency-updates': 'Update dependencies',
    'release-check': 'Check dev for release readiness',
    'error-handling': 'Improve error handling',
    'typing': 'Improve TypeScript types'
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
