/**
 * Self-Improvement Service
 *
 * Automated system for analyzing PortOS UI and codebase,
 * generating improvement tasks for the CoS to execute.
 *
 * Uses Playwright MCP or direct Playwright to:
 * - Navigate to all known routes
 * - Capture accessibility snapshots
 * - Check mobile responsiveness
 * - Capture console/network errors
 * - Generate improvement tasks
 */

import { cosEvents, getConfig } from './cos.js';

// Known routes to analyze
const ROUTES = [
  { path: '/', name: 'Dashboard', critical: true },
  { path: '/apps', name: 'Apps', critical: true },
  { path: '/cos', name: 'Chief of Staff', critical: true },
  { path: '/cos/tasks', name: 'CoS Tasks', critical: true },
  { path: '/cos/agents', name: 'CoS Agents', critical: true },
  { path: '/cos/health', name: 'CoS Health', critical: false },
  { path: '/cos/config', name: 'CoS Config', critical: false },
  { path: '/cos/memory', name: 'CoS Memory', critical: false },
  { path: '/devtools', name: 'DevTools', critical: true },
  { path: '/devtools/history', name: 'DevTools History', critical: true },
  { path: '/devtools/runner', name: 'DevTools Runner', critical: true },
  { path: '/providers', name: 'AI Providers', critical: true },
  { path: '/usage', name: 'Usage Metrics', critical: false },
  { path: '/prompts', name: 'Prompts', critical: false },
  { path: '/logs', name: 'Logs', critical: false }
];

// Viewport sizes for responsive testing
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 }
];

// Analysis task types
const ANALYSIS_TYPES = {
  UI_BUGS: 'ui-bugs',
  MOBILE_RESPONSIVE: 'mobile-responsive',
  ACCESSIBILITY: 'accessibility',
  CONSOLE_ERRORS: 'console-errors',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  CODE_QUALITY: 'code-quality',
  COS_ENHANCEMENT: 'cos-enhancement',
  TEST_COVERAGE: 'test-coverage',
  DOCUMENTATION: 'documentation',
  FEATURE_IDEAS: 'feature-ideas',
  DEPENDENCY_UPDATES: 'dependency-updates'
};

/**
 * Emit log event for CoS UI
 */
function emitLog(level, message, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  };
  console.log(`${level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️'} [SelfImprovement] ${message}`);
  cosEvents.emit('log', logEntry);
}

/**
 * Run a full self-improvement cycle
 * This is called when CoS is idle and wants to improve itself
 */
export async function runSelfImprovementCycle() {
  const config = await getConfig();

  if (!config.selfImprovementEnabled) {
    emitLog('debug', 'Self-improvement is disabled');
    return null;
  }

  emitLog('info', 'Starting self-improvement cycle');

  // Rotate through analysis types
  const analysisTypes = Object.values(ANALYSIS_TYPES);
  const lastAnalysis = config.lastSelfImprovementType || '';
  const currentIndex = analysisTypes.indexOf(lastAnalysis);
  const nextType = analysisTypes[(currentIndex + 1) % analysisTypes.length];

  emitLog('info', `Running ${nextType} analysis`);

  // Generate the task based on type
  const task = await generateSelfImprovementTask(nextType);

  return task;
}

/**
 * Generate a self-improvement task based on analysis type
 */
async function generateSelfImprovementTask(analysisType) {
  const taskDescriptions = {
    [ANALYSIS_TYPES.UI_BUGS]: `Analyze PortOS UI at http://localhost:5555 for bugs and issues

Use Playwright MCP to:
1. Navigate to each main route (/, /apps, /cos, /devtools, /providers, /usage)
2. Capture browser snapshots and console messages
3. Look for JavaScript errors, failed requests, broken UI elements
4. Fix any bugs found and commit the changes

Model: claude-opus-4-5-20251101`,

    [ANALYSIS_TYPES.MOBILE_RESPONSIVE]: `Analyze PortOS UI for mobile responsiveness issues

Use Playwright MCP to:
1. Navigate to http://localhost:5555 and its sub-routes
2. Test at mobile (375px), tablet (768px), and desktop (1440px) viewports
3. Capture snapshots at each viewport size
4. Identify layout issues, overflow, touch targets, font sizes
5. Fix responsiveness issues in the Tailwind CSS classes
6. Commit fixes with clear descriptions

Model: claude-opus-4-5-20251101`,

    [ANALYSIS_TYPES.SECURITY]: `Security audit of PortOS codebase

Analyze the following for security vulnerabilities:
1. server/routes/*.js - Check all API endpoints for injection vulnerabilities
2. server/services/*.js - Check for command injection, path traversal
3. server/lib/commandAllowlist.js - Verify allowlist is comprehensive
4. client/src/services/api.js - Check for XSS, CSRF protection
5. Check for hardcoded secrets, unsafe eval, missing validation

Fix any issues found with secure alternatives and commit changes.

Model: claude-opus-4-5-20251101`,

    [ANALYSIS_TYPES.CODE_QUALITY]: `Code quality review of PortOS

Analyze the codebase for:
1. DRY violations - Find and consolidate duplicated code
2. Large functions (>50 lines) that should be split
3. Missing error handling
4. Dead code and unused imports
5. Inconsistent patterns between files
6. TODO/FIXME comments that need addressing

Focus on server/ and client/src/ directories.
Make improvements and commit with clear messages.

Model: claude-opus-4-5-20251101`,

    [ANALYSIS_TYPES.ACCESSIBILITY]: `Accessibility audit of PortOS UI

Use Playwright MCP to:
1. Navigate to http://localhost:5555 and sub-routes
2. Capture accessibility snapshots
3. Check for missing ARIA labels, alt text, keyboard navigation
4. Verify color contrast ratios
5. Test screen reader compatibility

Fix accessibility issues and commit changes.

Model: claude-opus-4-5-20251101`,

    [ANALYSIS_TYPES.CONSOLE_ERRORS]: `Check PortOS for console errors and warnings

Use Playwright MCP to:
1. Navigate to http://localhost:5555
2. Open each main route and interact with key features
3. Capture all console messages (errors, warnings)
4. Identify the source of each error
5. Fix the underlying issues in the code
6. Commit fixes with clear descriptions

Model: claude-opus-4-5-20251101`,

    [ANALYSIS_TYPES.PERFORMANCE]: `Performance analysis of PortOS

Analyze for performance issues:
1. Check component re-renders in React DevTools patterns
2. Look for N+1 query patterns in API calls
3. Identify large bundle sizes or missing code splitting
4. Check for memory leaks in useEffect hooks
5. Analyze Socket.IO event handling efficiency

Optimize and commit improvements.

Model: claude-opus-4-5-20251101`
  };

  const description = taskDescriptions[analysisType] || taskDescriptions[ANALYSIS_TYPES.CODE_QUALITY];

  const task = {
    id: `self-improve-${analysisType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: 'MEDIUM',
    priorityValue: 2,
    description: `[Self-Improvement] ${description}`,
    metadata: {
      analysisType,
      autoGenerated: true,
      selfImprovement: true,
      model: 'claude-opus-4-5-20251101'
    },
    taskType: 'internal',
    autoApproved: true,
    model: 'claude-opus-4-5-20251101'
  };

  emitLog('info', `Generated self-improvement task: ${analysisType}`, { taskId: task.id });
  return task;
}

/**
 * Get the next self-improvement task type based on rotation
 */
export function getNextImprovementType(lastType) {
  const types = Object.values(ANALYSIS_TYPES);
  const currentIndex = types.indexOf(lastType);
  return types[(currentIndex + 1) % types.length];
}

/**
 * Export analysis types for configuration
 */
export { ANALYSIS_TYPES, ROUTES, VIEWPORTS };
