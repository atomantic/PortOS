/**
 * Task Schedule Service
 *
 * Manages configurable intervals for self-improvement and managed app tasks.
 * Allows setting per-task-type intervals like:
 * - Run accessibility audits once per week
 * - Run feature-ideas brainstorm daily
 * - Run security audits once per app
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
 *
 * Applies adaptive multipliers based on historical task performance:
 * - High success (>90%): Run 30% more often (multiplier 0.7)
 * - Good success (75-89%): Run 15% more often (multiplier 0.85)
 * - Moderate success (50-74%): Normal interval (multiplier 1.0)
 * - Low success (30-49%): Run 50% less often (multiplier 1.5)
 * - Very low (<30% with 5+ attempts): Run 100% less often (multiplier 2.0)
 *
 * This makes CoS more efficient by focusing on high-performing tasks
 * while reducing wasted cycles on consistently failing ones.
 *
 * @param {string} taskType - Task type (e.g., 'ui-bugs', 'security')
 * @param {string} category - 'selfImprovement' or 'appImprovement'
 * @param {number} baseIntervalMs - Base interval in milliseconds
 * @returns {Object} Adjusted interval info
 */
async function getPerformanceAdjustedInterval(taskType, category, baseIntervalMs) {
  const taskTypeKey = category === 'selfImprovement'
    ? `self-improve:${taskType}`
    : `app-improve:${taskType}`;

  const cooldownInfo = await getAdaptiveCooldownMultiplier(taskTypeKey).catch(() => ({
    multiplier: 1.0,
    reason: 'error-fallback',
    skip: false,
    successRate: null,
    completed: 0
  }));

  // Don't adjust if insufficient data
  if (cooldownInfo.reason === 'insufficient-data' || cooldownInfo.reason === 'error-fallback') {
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

  // Log significant adjustments
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

// Default prompts for self-improvement task types
const DEFAULT_SELF_IMPROVEMENT_PROMPTS = {
  'ui-bugs': `[Self-Improvement] UI Bug Analysis

Use Playwright MCP (browser_navigate, browser_snapshot, browser_console_messages) to analyze PortOS UI:

1. Navigate to http://localhost:5555/
2. Check each main route: /, /apps, /cos, /cos/tasks, /cos/agents, /devtools, /devtools/history, /providers, /usage
3. For each route:
   - Take a browser_snapshot to see the page structure
   - Check browser_console_messages for JavaScript errors
   - Look for broken UI elements, missing data, failed requests
4. Fix any bugs found in the React components or API routes
5. Run tests and commit changes`,

  'mobile-responsive': `[Self-Improvement] Mobile Responsiveness Analysis

Use Playwright MCP to test PortOS at different viewport sizes:

1. browser_resize to mobile (375x812), then navigate to http://localhost:5555/
2. Take browser_snapshot and analyze for:
   - Text overflow or truncation
   - Buttons too small to tap (< 44px)
   - Horizontal scrolling issues
   - Elements overlapping
   - Navigation usability
3. Repeat at tablet (768x1024) and desktop (1440x900)
4. Fix Tailwind CSS responsive classes (sm:, md:, lg:) as needed
5. Test fixes and commit changes

Focus on these routes: /cos, /cos/tasks, /devtools, /providers`,

  'security': `[Self-Improvement] Security Audit

Analyze PortOS codebase for security vulnerabilities:

1. Review server/routes/*.js for:
   - Command injection in exec/spawn calls
   - Path traversal in file operations
   - Missing input validation
   - XSS in rendered content

2. Review server/services/*.js for:
   - Unsafe eval() or Function()
   - Hardcoded credentials
   - SQL/NoSQL injection

3. Review client/src/ for:
   - XSS vulnerabilities in React
   - Sensitive data in localStorage
   - CSRF protection

4. Check server/lib/commandAllowlist.js is comprehensive

Fix any vulnerabilities and commit with security advisory notes.`,

  'code-quality': `[Self-Improvement] Code Quality Review

Analyze PortOS codebase for maintainability:

1. Find DRY violations - similar code in multiple places
2. Identify functions >50 lines that should be split
3. Look for missing error handling
4. Find dead code and unused imports
5. Check for console.log that should be removed
6. Look for TODO/FIXME that need addressing

Focus on:
- server/services/*.js
- client/src/pages/*.jsx
- client/src/components/*.jsx

Refactor issues found and commit improvements.`,

  'console-errors': `[Self-Improvement] Console Error Investigation

Use Playwright MCP to find and fix console errors:

1. Navigate to http://localhost:5555/
2. Call browser_console_messages with level: "error"
3. Visit each route and capture errors:
   - /, /apps, /cos, /cos/tasks, /cos/agents
   - /devtools, /devtools/history, /devtools/runner
   - /providers, /usage, /prompts

4. For each error:
   - Identify the source file and line
   - Understand the root cause
   - Implement a fix

5. Test fixes and commit changes`,

  'performance': `[Self-Improvement] Performance Analysis

Analyze PortOS for performance issues:

1. Review React components for:
   - Unnecessary re-renders
   - Missing useMemo/useCallback
   - Large component files that should be split

2. Review server code for:
   - N+1 query patterns
   - Missing caching opportunities
   - Inefficient file operations

3. Review client bundle for:
   - Missing code splitting
   - Large dependencies that could be tree-shaken

4. Check Socket.IO for:
   - Event handler memory leaks
   - Unnecessary broadcasts

Optimize and commit improvements.`,

  'cos-enhancement': `[Self-Improvement] Enhance CoS Capabilities

Review the CoS system and add new capabilities:

1. Read data/COS-GOALS.md to understand the mission and goals
2. Review server/services/cos.js for improvement opportunities:
   - Better task prioritization logic
   - Smarter model selection
   - More informative status messages
   - Better error recovery

3. Review the self-improvement task prompts:
   - Are they comprehensive enough?
   - Do they lead to quality fixes?
   - What new analysis types could be added?

4. Consider adding:
   - New MCP server integrations
   - Better metrics tracking
   - Learning from completed tasks
   - Smarter cooldown logic

5. Implement ONE meaningful enhancement and commit it

Focus on making CoS more autonomous and effective.`,

  'test-coverage': `[Self-Improvement] Improve Test Coverage

Analyze and improve test coverage for PortOS:

1. Check existing tests in server/tests/ and client/tests/
2. Identify untested critical paths:
   - API routes without tests
   - Services with complex logic
   - Error handling paths

3. Add tests for:
   - CoS task evaluation logic
   - Agent spawning and lifecycle
   - Socket.IO event handlers
   - API endpoints

4. Ensure tests:
   - Follow existing patterns
   - Use appropriate mocks
   - Test edge cases

5. Run npm test to verify all tests pass
6. Commit test additions with clear message describing what's covered`,

  'documentation': `[Self-Improvement] Update Documentation

Review and improve PortOS documentation:

1. Update PLAN.md:
   - Mark completed milestones
   - Add any new features implemented
   - Document architectural decisions

2. Check docs/ folder:
   - Are all features documented?
   - Is the information current?
   - Add any missing guides

3. Review code comments:
   - Add JSDoc to exported functions
   - Document complex algorithms
   - Explain non-obvious code

4. Update README.md if needed:
   - Installation instructions
   - Quick start guide
   - Feature overview

5. Consider adding:
   - Architecture diagrams
   - API documentation
   - Troubleshooting guide

Commit documentation improvements.`,

  'feature-ideas': `[Self-Improvement] Brainstorm and Implement Feature

Think about ways to make PortOS more useful:

1. Read data/COS-GOALS.md for context on user goals
2. Review recent completed tasks to understand patterns
3. Consider these areas:
   - User task management improvements
   - Better progress visualization
   - New automation capabilities
   - Enhanced monitoring features

4. Choose ONE small, high-impact feature to implement:
   - Something that saves user time
   - Improves the developer experience
   - Makes CoS more helpful

5. Implement it:
   - Write clean, tested code
   - Follow existing patterns
   - Update relevant documentation

6. Commit with a clear description of the new feature

Think creatively but implement practically.`,

  'accessibility': `[Self-Improvement] Accessibility Audit

Use Playwright MCP to audit PortOS accessibility:

1. Navigate to http://localhost:5555/
2. Use browser_snapshot to get accessibility tree
3. Check each main route for:
   - Missing ARIA labels
   - Missing alt text on images
   - Insufficient color contrast
   - Keyboard navigation issues
   - Focus indicators

4. Fix accessibility issues in React components
5. Add appropriate aria-* attributes
6. Test and commit changes`,

  'dependency-updates': `[Self-Improvement] Dependency Updates and Security Audit

Check PortOS dependencies for updates and security vulnerabilities:

1. Run npm audit in both server/ and client/ directories
2. Check for outdated packages with npm outdated
3. Review CRITICAL and HIGH severity vulnerabilities
4. For each vulnerability:
   - Assess the actual risk (is the vulnerable code path used?)
   - Check if an update is available
   - Test that updates don't break functionality

5. Update dependencies carefully:
   - Update patch versions first (safest)
   - Then minor versions
   - Major versions need more careful review

6. After updating:
   - Run npm test in server/
   - Run npm run build in client/
   - Verify the app starts correctly

7. Commit with clear changelog of what was updated and why`
};

// Default interval settings for self-improvement task types
const DEFAULT_SELF_IMPROVEMENT_INTERVALS = {
  'ui-bugs': { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null, prompt: null },
  'mobile-responsive': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'security': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'code-quality': { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null, prompt: null },
  'console-errors': { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null, prompt: null },
  'performance': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'cos-enhancement': { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null, prompt: null },
  'test-coverage': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'documentation': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'feature-ideas': { type: INTERVAL_TYPES.DAILY, enabled: true, providerId: null, model: null, prompt: null },
  'accessibility': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'dependency-updates': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null }
};

// Default prompts for app improvement task types (templates with {appName} and {repoPath} variables)
const DEFAULT_APP_IMPROVEMENT_PROMPTS = {
  'security-audit': `[App Improvement: {appName}] Security Audit

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

4. Check authentication and authorization:
   - Secure password handling
   - Token management
   - Access control

Fix any vulnerabilities found and commit with security advisory notes.`,

  'code-quality': `[App Improvement: {appName}] Code Quality Review

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

  'test-coverage': `[App Improvement: {appName}] Improve Test Coverage

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

  'performance': `[App Improvement: {appName}] Performance Analysis

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

  'accessibility': `[App Improvement: {appName}] Accessibility Audit

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

  'console-errors': `[App Improvement: {appName}] Console Error Investigation

Find and fix console errors in {appName}:

Repository: {repoPath}

1. If the app has a UI, check browser console for errors
2. Check server logs for errors
3. For each error:
   - Identify the source file and line
   - Understand the root cause
   - Implement a fix

4. Test fixes and commit changes`,

  'dependency-updates': `[App Improvement: {appName}] Dependency Updates

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

  'documentation': `[App Improvement: {appName}] Update Documentation

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

  'error-handling': `[App Improvement: {appName}] Improve Error Handling

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

  'typing': `[App Improvement: {appName}] TypeScript Type Improvements

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

4. Run type checking and commit improvements`
};

// Default interval settings for managed app improvement task types
const DEFAULT_APP_IMPROVEMENT_INTERVALS = {
  'security-audit': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'code-quality': { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null, prompt: null },
  'test-coverage': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'performance': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'accessibility': { type: INTERVAL_TYPES.ONCE, enabled: true, providerId: null, model: null, prompt: null },
  'console-errors': { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null, prompt: null },
  'dependency-updates': { type: INTERVAL_TYPES.WEEKLY, enabled: true, providerId: null, model: null, prompt: null },
  'documentation': { type: INTERVAL_TYPES.ONCE, enabled: true, providerId: null, model: null, prompt: null },
  'error-handling': { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null, prompt: null },
  'typing': { type: INTERVAL_TYPES.ONCE, enabled: true, providerId: null, model: null, prompt: null }
};

/**
 * Default schedule data structure
 */
const DEFAULT_SCHEDULE = {
  version: 1,
  lastUpdated: null,

  // Self-improvement task intervals (for PortOS)
  selfImprovement: {
    ...DEFAULT_SELF_IMPROVEMENT_INTERVALS
  },

  // Managed app task intervals
  appImprovement: {
    ...DEFAULT_APP_IMPROVEMENT_INTERVALS
  },

  // Track last execution times
  executions: {
    // Format: 'self-improve:ui-bugs': { lastRun: timestamp, count: number, perApp: {} }
  },

  // On-demand task templates that can be triggered manually
  templates: []
};

/**
 * Ensure data directory exists
 */
async function ensureDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

/**
 * Load schedule data
 */
export async function loadSchedule() {
  await ensureDir();

  const loaded = await readJSONFile(SCHEDULE_FILE, null);
  if (!loaded) {
    return { ...DEFAULT_SCHEDULE };
  }

  // Merge with defaults to ensure all task types have settings
  const schedule = {
    ...DEFAULT_SCHEDULE,
    ...loaded,
    selfImprovement: {
      ...DEFAULT_SELF_IMPROVEMENT_INTERVALS,
      ...loaded.selfImprovement
    },
    appImprovement: {
      ...DEFAULT_APP_IMPROVEMENT_INTERVALS,
      ...loaded.appImprovement
    },
    executions: loaded.executions || {},
    templates: loaded.templates || []
  };

  // Populate prompts from defaults if they don't exist
  let needsSave = false;
  for (const [taskType, config] of Object.entries(schedule.selfImprovement)) {
    if (!config.prompt && DEFAULT_SELF_IMPROVEMENT_PROMPTS[taskType]) {
      config.prompt = DEFAULT_SELF_IMPROVEMENT_PROMPTS[taskType];
      needsSave = true;
    }
  }

  for (const [taskType, config] of Object.entries(schedule.appImprovement)) {
    if (!config.prompt && DEFAULT_APP_IMPROVEMENT_PROMPTS[taskType]) {
      config.prompt = DEFAULT_APP_IMPROVEMENT_PROMPTS[taskType];
      needsSave = true;
    }
  }

  // Save if we populated any prompts
  if (needsSave) {
    await saveSchedule(schedule);
  }

  return schedule;
}

/**
 * Save schedule data
 */
async function saveSchedule(schedule) {
  await ensureDir();
  schedule.lastUpdated = new Date().toISOString();
  await writeFile(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
}

/**
 * Get interval for a self-improvement task type
 */
export async function getSelfImprovementInterval(taskType) {
  const schedule = await loadSchedule();
  return schedule.selfImprovement[taskType] || { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null };
}

/**
 * Get interval for an app improvement task type
 */
export async function getAppImprovementInterval(taskType) {
  const schedule = await loadSchedule();
  return schedule.appImprovement[taskType] || { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null };
}

/**
 * Update self-improvement interval for a task type
 */
export async function updateSelfImprovementInterval(taskType, settings) {
  const schedule = await loadSchedule();

  if (!schedule.selfImprovement[taskType]) {
    schedule.selfImprovement[taskType] = { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null };
  }

  schedule.selfImprovement[taskType] = {
    ...schedule.selfImprovement[taskType],
    ...settings
  };

  await saveSchedule(schedule);
  emitLog('info', `Updated self-improvement interval for ${taskType}`, { taskType, settings }, '📅 TaskSchedule');
  cosEvents.emit('schedule:changed', { category: 'selfImprovement', taskType, settings });

  return schedule.selfImprovement[taskType];
}

/**
 * Update app improvement interval for a task type
 */
export async function updateAppImprovementInterval(taskType, settings) {
  const schedule = await loadSchedule();

  if (!schedule.appImprovement[taskType]) {
    schedule.appImprovement[taskType] = { type: INTERVAL_TYPES.ROTATION, enabled: true, providerId: null, model: null };
  }

  schedule.appImprovement[taskType] = {
    ...schedule.appImprovement[taskType],
    ...settings
  };

  await saveSchedule(schedule);
  emitLog('info', `Updated app improvement interval for ${taskType}`, { taskType, settings }, '📅 TaskSchedule');
  cosEvents.emit('schedule:changed', { category: 'appImprovement', taskType, settings });

  return schedule.appImprovement[taskType];
}

/**
 * Record a task execution
 */
export async function recordExecution(taskType, appId = null) {
  const schedule = await loadSchedule();
  const key = taskType;

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

/**
 * Get execution history for a task type
 */
export async function getExecutionHistory(taskType) {
  const schedule = await loadSchedule();
  return schedule.executions[taskType] || { lastRun: null, count: 0, perApp: {} };
}

/**
 * Check if a self-improvement task type should run based on its interval
 *
 * Enhanced with learning-based interval adjustment:
 * - High-performing tasks (>90% success) run more frequently
 * - Low-performing tasks (<50% success) run less frequently
 * - Very low performers (<30% with 5+ attempts) are significantly delayed
 *
 * The adjustment applies to daily, weekly, and custom intervals.
 * Rotation tasks are not adjusted (they run in sequence regardless).
 */
export async function shouldRunSelfImprovementTask(taskType) {
  const schedule = await loadSchedule();
  const interval = schedule.selfImprovement[taskType];

  if (!interval || !interval.enabled) {
    return { shouldRun: false, reason: 'disabled' };
  }

  const execution = schedule.executions[`self-improve:${taskType}`] || { lastRun: null, count: 0 };
  const now = Date.now();
  const lastRun = execution.lastRun ? new Date(execution.lastRun).getTime() : 0;
  const timeSinceLastRun = now - lastRun;

  // Helper to build result with learning info
  const buildResult = (shouldRun, reason, baseIntervalMs, extra = {}) => {
    const result = { shouldRun, reason, ...extra };

    // Add learning adjustment info if we adjusted the interval
    if (extra.learningAdjustment && extra.learningAdjustment.adjusted) {
      result.learningApplied = true;
      result.successRate = extra.learningAdjustment.successRate;
      result.adjustmentMultiplier = extra.learningAdjustment.multiplier;
      result.dataPoints = extra.learningAdjustment.dataPoints;
    }

    return result;
  };

  switch (interval.type) {
    case INTERVAL_TYPES.ROTATION:
      // Rotation tasks always eligible (learning adjustment happens in getNextSelfImprovementTaskType)
      return { shouldRun: true, reason: 'rotation' };

    case INTERVAL_TYPES.DAILY: {
      // Apply learning-based interval adjustment
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, 'selfImprovement', DAY);
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
      // Apply learning-based interval adjustment
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, 'selfImprovement', WEEK);
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
      if (execution.count === 0) {
        return { shouldRun: true, reason: 'once-first-run' };
      }
      return { shouldRun: false, reason: 'once-completed', completedAt: execution.lastRun };

    case INTERVAL_TYPES.ON_DEMAND:
      return { shouldRun: false, reason: 'on-demand-only' };

    case INTERVAL_TYPES.CUSTOM: {
      const baseInterval = interval.intervalMs || DAY;
      // Apply learning-based interval adjustment
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, 'selfImprovement', baseInterval);
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
 * Check if an app improvement task type should run for a specific app
 *
 * Enhanced with learning-based interval adjustment (same as self-improvement).
 */
export async function shouldRunAppImprovementTask(taskType, appId) {
  const schedule = await loadSchedule();
  const interval = schedule.appImprovement[taskType];

  if (!interval || !interval.enabled) {
    return { shouldRun: false, reason: 'disabled' };
  }

  const key = `app-improve:${taskType}`;
  const execution = schedule.executions[key] || { lastRun: null, count: 0, perApp: {} };
  const appExecution = execution.perApp[appId] || { lastRun: null, count: 0 };
  const now = Date.now();
  const lastRun = appExecution.lastRun ? new Date(appExecution.lastRun).getTime() : 0;
  const timeSinceLastRun = now - lastRun;

  // Helper to build result with learning info
  const buildResult = (shouldRun, reason, baseIntervalMs, extra = {}) => {
    const result = { shouldRun, reason, ...extra };
    if (extra.learningAdjustment && extra.learningAdjustment.adjusted) {
      result.learningApplied = true;
      result.successRate = extra.learningAdjustment.successRate;
      result.adjustmentMultiplier = extra.learningAdjustment.multiplier;
      result.dataPoints = extra.learningAdjustment.dataPoints;
    }
    return result;
  };

  switch (interval.type) {
    case INTERVAL_TYPES.ROTATION:
      return { shouldRun: true, reason: 'rotation' };

    case INTERVAL_TYPES.DAILY: {
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, 'appImprovement', DAY);
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
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, 'appImprovement', WEEK);
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
      const learningAdjustment = await getPerformanceAdjustedInterval(taskType, 'appImprovement', baseInterval);
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
 * Get all enabled self-improvement task types that are due to run
 */
export async function getDueSelfImprovementTasks() {
  const schedule = await loadSchedule();
  const due = [];

  for (const [taskType, interval] of Object.entries(schedule.selfImprovement)) {
    if (!interval.enabled) continue;

    const check = await shouldRunSelfImprovementTask(taskType);
    if (check.shouldRun) {
      due.push({ taskType, reason: check.reason, interval });
    }
  }

  return due;
}

/**
 * Get all enabled app improvement task types that are due to run for a specific app
 */
export async function getDueAppImprovementTasks(appId) {
  const schedule = await loadSchedule();
  const due = [];

  for (const [taskType, interval] of Object.entries(schedule.appImprovement)) {
    if (!interval.enabled) continue;

    const check = await shouldRunAppImprovementTask(taskType, appId);
    if (check.shouldRun) {
      due.push({ taskType, reason: check.reason, interval });
    }
  }

  return due;
}

/**
 * Get the next task type to run based on schedule priority
 * Prioritizes: daily tasks due > weekly tasks due > rotation tasks
 */
export async function getNextSelfImprovementTaskType(lastType) {
  const schedule = await loadSchedule();
  const taskTypes = Object.keys(schedule.selfImprovement);

  // First, check for daily/weekly tasks that are due
  const dueTasks = await getDueSelfImprovementTasks();

  // Prioritize daily tasks first, then weekly
  const dailyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.DAILY);
  if (dailyDue.length > 0) {
    return { taskType: dailyDue[0].taskType, reason: 'daily-priority' };
  }

  const weeklyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.WEEKLY);
  if (weeklyDue.length > 0) {
    return { taskType: weeklyDue[0].taskType, reason: 'weekly-priority' };
  }

  // Fall back to rotation among enabled rotation tasks
  const rotationTasks = taskTypes.filter(t =>
    schedule.selfImprovement[t].enabled &&
    schedule.selfImprovement[t].type === INTERVAL_TYPES.ROTATION
  );

  if (rotationTasks.length === 0) {
    return null;
  }

  // Get next in rotation
  const currentIndex = rotationTasks.indexOf(lastType);
  const nextIndex = (currentIndex + 1) % rotationTasks.length;

  return { taskType: rotationTasks[nextIndex], reason: 'rotation' };
}

/**
 * Get the next app improvement task type to run for a specific app
 */
export async function getNextAppImprovementTaskType(appId, lastType) {
  const schedule = await loadSchedule();
  const taskTypes = Object.keys(schedule.appImprovement);

  // First, check for daily/weekly tasks that are due
  const dueTasks = await getDueAppImprovementTasks(appId);

  // Prioritize daily tasks first, then weekly, then once
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

  // Fall back to rotation
  const rotationTasks = taskTypes.filter(t =>
    schedule.appImprovement[t].enabled &&
    schedule.appImprovement[t].type === INTERVAL_TYPES.ROTATION
  );

  if (rotationTasks.length === 0) {
    return null;
  }

  const currentIndex = rotationTasks.indexOf(lastType);
  const nextIndex = (currentIndex + 1) % rotationTasks.length;

  return { taskType: rotationTasks[nextIndex], reason: 'rotation' };
}

/**
 * Add a template task that can be triggered on-demand
 */
export async function addTemplateTask(template) {
  const schedule = await loadSchedule();

  const newTemplate = {
    id: `template-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    name: template.name,
    description: template.description,
    category: template.category || 'custom', // 'selfImprovement', 'appImprovement', 'custom'
    taskType: template.taskType,
    priority: template.priority || 'MEDIUM',
    metadata: template.metadata || {}
  };

  schedule.templates.push(newTemplate);
  await saveSchedule(schedule);

  emitLog('info', `Added template task: ${newTemplate.name}`, { templateId: newTemplate.id }, '📅 TaskSchedule');
  return newTemplate;
}

/**
 * Get all template tasks
 */
export async function getTemplateTasks() {
  const schedule = await loadSchedule();
  return schedule.templates;
}

/**
 * Delete a template task
 */
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

/**
 * Trigger an on-demand task by task type
 * Creates an immediate task entry for the specified type
 */
export async function triggerOnDemandTask(taskType, category = 'selfImprovement', appId = null) {
  // This marks the task as requested for immediate execution
  // The task generation will pick it up on the next evaluation
  const schedule = await loadSchedule();

  if (!schedule.onDemandRequests) {
    schedule.onDemandRequests = [];
  }

  const request = {
    id: `demand-${Date.now().toString(36)}`,
    taskType,
    category,
    appId,
    requestedAt: new Date().toISOString()
  };

  schedule.onDemandRequests.push(request);
  await saveSchedule(schedule);

  emitLog('info', `On-demand task requested: ${taskType}`, { category, appId }, '📅 TaskSchedule');
  cosEvents.emit('task:on-demand-requested', request);

  return request;
}

/**
 * Get pending on-demand task requests
 */
export async function getOnDemandRequests() {
  const schedule = await loadSchedule();
  return schedule.onDemandRequests || [];
}

/**
 * Clear an on-demand request (after it's been processed)
 */
export async function clearOnDemandRequest(requestId) {
  const schedule = await loadSchedule();

  if (!schedule.onDemandRequests) return null;

  const index = schedule.onDemandRequests.findIndex(r => r.id === requestId);
  if (index === -1) return null;

  const cleared = schedule.onDemandRequests.splice(index, 1)[0];
  await saveSchedule(schedule);

  return cleared;
}

/**
 * Get full schedule status for UI display
 *
 * Enhanced to include learning-based interval adjustments.
 */
export async function getScheduleStatus() {
  const schedule = await loadSchedule();
  const status = {
    lastUpdated: schedule.lastUpdated,
    selfImprovement: {},
    appImprovement: {},
    templates: schedule.templates,
    onDemandRequests: schedule.onDemandRequests || [],
    learningAdjustmentsActive: 0 // Count of task types with active learning adjustments
  };

  // Add execution status to each self-improvement task type
  for (const [taskType, interval] of Object.entries(schedule.selfImprovement)) {
    const check = await shouldRunSelfImprovementTask(taskType);
    const execution = schedule.executions[`self-improve:${taskType}`] || { lastRun: null, count: 0 };

    // Get learning adjustment info
    const baseInterval = interval.type === 'daily' ? DAY : interval.type === 'weekly' ? WEEK : (interval.intervalMs || DAY);
    const learningInfo = await getPerformanceAdjustedInterval(taskType, 'selfImprovement', baseInterval);

    status.selfImprovement[taskType] = {
      ...interval,
      lastRun: execution.lastRun,
      runCount: execution.count,
      status: check,
      // Learning adjustment fields
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

  // Add execution status to each app improvement task type
  for (const [taskType, interval] of Object.entries(schedule.appImprovement)) {
    const execution = schedule.executions[`app-improve:${taskType}`] || { lastRun: null, count: 0, perApp: {} };

    // Get learning adjustment info
    const baseInterval = interval.type === 'daily' ? DAY : interval.type === 'weekly' ? WEEK : (interval.intervalMs || DAY);
    const learningInfo = await getPerformanceAdjustedInterval(taskType, 'appImprovement', baseInterval);

    status.appImprovement[taskType] = {
      ...interval,
      globalLastRun: execution.lastRun,
      globalRunCount: execution.count,
      perAppCount: Object.keys(execution.perApp).length,
      // Learning adjustment fields
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
 * Reset execution history for a task type (useful for re-running 'once' tasks)
 */
export async function resetExecutionHistory(taskType, category = 'selfImprovement', appId = null) {
  const schedule = await loadSchedule();
  const key = category === 'selfImprovement' ? `self-improve:${taskType}` : `app-improve:${taskType}`;

  if (!schedule.executions[key]) {
    return { error: 'No execution history found' };
  }

  if (appId) {
    // Reset only for specific app
    if (schedule.executions[key].perApp && schedule.executions[key].perApp[appId]) {
      delete schedule.executions[key].perApp[appId];
    }
  } else {
    // Reset entire history for this task type
    delete schedule.executions[key];
  }

  await saveSchedule(schedule);
  emitLog('info', `Reset execution history for ${taskType}`, { category, appId }, '📅 TaskSchedule');

  return { success: true, taskType, appId };
}

/**
 * Get default prompt for a self-improvement task type
 */
export function getDefaultSelfImprovementPrompt(taskType) {
  return DEFAULT_SELF_IMPROVEMENT_PROMPTS[taskType] || null;
}

/**
 * Get default prompt for an app improvement task type (with template variables)
 */
export function getDefaultAppImprovementPrompt(taskType) {
  return DEFAULT_APP_IMPROVEMENT_PROMPTS[taskType] || null;
}

/**
 * Get the prompt for a self-improvement task type
 */
export async function getSelfImprovementPrompt(taskType) {
  const interval = await getSelfImprovementInterval(taskType);
  return interval.prompt || `[Self-Improvement] ${taskType} analysis`;
}

/**
 * Get the prompt for an app improvement task type
 */
export async function getAppImprovementPrompt(taskType) {
  const interval = await getAppImprovementInterval(taskType);
  return interval.prompt || `[App Improvement] ${taskType} analysis

Repository: {repoPath}

Perform ${taskType} analysis on {appName}.
Analyze the codebase and make improvements. Commit changes with clear descriptions.`;
}

/**
 * Get upcoming tasks preview - what tasks will run next
 * Returns a list of tasks sorted by when they'll be eligible to run
 * @param {number} limit - Maximum number of upcoming tasks to return
 * @returns {Array} Upcoming tasks with timing info
 */
export async function getUpcomingTasks(limit = 10) {
  const schedule = await loadSchedule();
  const now = Date.now();
  const upcoming = [];

  // Process self-improvement tasks
  for (const [taskType, interval] of Object.entries(schedule.selfImprovement)) {
    if (!interval.enabled) continue;
    if (interval.type === INTERVAL_TYPES.ON_DEMAND) continue;

    const check = await shouldRunSelfImprovementTask(taskType);
    const execution = schedule.executions[`self-improve:${taskType}`] || { lastRun: null, count: 0 };
    const lastRun = execution.lastRun ? new Date(execution.lastRun).getTime() : 0;

    // Calculate when task becomes eligible
    let eligibleAt = now;
    let status = 'ready';

    if (check.shouldRun) {
      eligibleAt = now;
      status = 'ready';
    } else if (check.nextRunAt) {
      eligibleAt = new Date(check.nextRunAt).getTime();
      status = 'scheduled';
    } else if (interval.type === INTERVAL_TYPES.ONCE && execution.count > 0) {
      status = 'completed';
      eligibleAt = Infinity;
    }

    if (status === 'completed') continue;

    upcoming.push({
      taskType,
      category: 'selfImprovement',
      intervalType: interval.type,
      status,
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

  // Sort by eligibility time (ready tasks first, then by time until eligible)
  upcoming.sort((a, b) => {
    if (a.status === 'ready' && b.status !== 'ready') return -1;
    if (b.status === 'ready' && a.status !== 'ready') return 1;
    return a.eligibleAt - b.eligibleAt;
  });

  return upcoming.slice(0, limit);
}

/**
 * Format time remaining in human-readable form
 */
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

/**
 * Format relative time (e.g., "2h ago")
 */
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

/**
 * Get human-readable description for task type
 */
function getTaskTypeDescription(taskType) {
  const descriptions = {
    'ui-bugs': 'Find and fix UI bugs',
    'mobile-responsive': 'Check mobile responsiveness',
    'security': 'Security vulnerability audit',
    'code-quality': 'Code quality improvements',
    'console-errors': 'Fix console errors',
    'performance': 'Performance optimization',
    'cos-enhancement': 'Enhance CoS capabilities',
    'test-coverage': 'Improve test coverage',
    'documentation': 'Update documentation',
    'feature-ideas': 'Brainstorm and implement features',
    'accessibility': 'Accessibility audit',
    'dependency-updates': 'Update dependencies'
  };
  return descriptions[taskType] || taskType.replace(/-/g, ' ');
}
