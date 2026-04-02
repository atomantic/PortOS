/**
 * CoS Productivity, Insights, Goal Progress, and Decision Log Routes
 */

import { Router } from 'express';
import * as cos from '../services/cos.js';
import * as taskLearning from '../services/taskLearning.js';
import * as autonomousJobs from '../services/autonomousJobs.js';
import * as productivity from '../services/productivity.js';
import * as goalProgress from '../services/goalProgress.js';
import * as decisionLog from '../services/decisionLog.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/cos/productivity - Get productivity insights and streaks
router.get('/productivity', asyncHandler(async (req, res) => {
  const insights = await productivity.getProductivityInsights();
  res.json(insights);
}));

// GET /api/cos/productivity/summary - Get quick summary for dashboard
router.get('/productivity/summary', asyncHandler(async (req, res) => {
  const summary = await productivity.getProductivitySummary();
  res.json(summary);
}));

// POST /api/cos/productivity/recalculate - Force recalculation from history
router.post('/productivity/recalculate', asyncHandler(async (req, res) => {
  const data = await productivity.recalculateProductivity();
  res.json({ success: true, data });
}));

// GET /api/cos/productivity/trends - Get daily task completion trends for charting
router.get('/productivity/trends', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const trends = await productivity.getDailyTrends(days);
  res.json(trends);
}));

// GET /api/cos/productivity/calendar - Get activity calendar for GitHub-style heatmap
router.get('/productivity/calendar', asyncHandler(async (req, res) => {
  const weeks = parseInt(req.query.weeks, 10) || 12;
  const calendar = await productivity.getActivityCalendar(weeks);
  res.json(calendar);
}));

// GET /api/cos/actionable-insights - Get prioritized action items requiring user attention
// Surfaces the most important things to address right now across all CoS subsystems
router.get('/actionable-insights', asyncHandler(async (req, res) => {
  const [tasksData, learningSummary, healthCheck, notificationsModule, optimalTimeInfo] = await Promise.all([
    cos.getAllTasks().catch(err => { console.error(`❌ Failed to load tasks: ${err.message}`); return { user: null, cos: null }; }),
    taskLearning.getLearningInsights().catch(err => { console.error(`❌ Failed to load learning insights: ${err.message}`); return null; }),
    cos.runHealthCheck().catch(err => { console.error(`❌ Failed to run health check: ${err.message}`); return { issues: [] }; }),
    import('../services/notifications.js').catch(err => { console.error(`❌ Failed to load notifications: ${err.message}`); return null; }),
    productivity.getOptimalTimeInfo().catch(() => ({ hasData: false }))
  ]);

  const notificationsData = notificationsModule ? await notificationsModule.getNotifications({ unreadOnly: true, limit: 10 }).catch(() => []) : [];

  const insights = [];

  // 1. Pending approvals (highest priority)
  const pendingApprovals = tasksData.cos?.awaitingApproval || [];
  if (pendingApprovals.length > 0) {
    insights.push({
      type: 'approval',
      priority: 'high',
      icon: 'AlertCircle',
      title: `${pendingApprovals.length} task${pendingApprovals.length > 1 ? 's' : ''} awaiting approval`,
      description: ((d) => d ? d.substring(0, 80) + (d.length > 80 ? '...' : '') : '')(pendingApprovals[0]?.description ?? ''),
      action: { label: 'Review', route: '/cos/tasks' },
      count: pendingApprovals.length
    });
  }

  // 2. Blocked tasks
  const blockedUser = tasksData.user?.grouped?.blocked || [];
  const blockedCos = tasksData.cos?.grouped?.blocked || [];
  const blockedCount = blockedUser.length + blockedCos.length;
  if (blockedCount > 0) {
    const firstBlocked = blockedUser[0] || blockedCos[0];
    const toBlockedTask = (taskType) => (t) => ({ id: t.id, description: t.description?.substring(0, 80) || 'Unknown task', blocker: t.metadata?.blocker || null, taskType });
    const blockedTasks = [...blockedUser.map(toBlockedTask('user')), ...blockedCos.map(toBlockedTask('internal'))];
    insights.push({
      type: 'blocked',
      priority: 'high',
      icon: 'XCircle',
      title: `${blockedCount} blocked task${blockedCount > 1 ? 's' : ''}`,
      description: firstBlocked?.metadata?.blocker || firstBlocked?.description?.substring(0, 80) || 'Task is blocked',
      action: { label: 'Unblock', route: '/cos/tasks' },
      count: blockedCount,
      tasks: blockedTasks
    });
  }

  // 3. Health issues
  const healthIssues = healthCheck?.issues || [];
  if (healthIssues.length > 0) {
    const criticalIssues = healthIssues.filter(i => i.severity === 'critical');
    insights.push({
      type: 'health',
      priority: criticalIssues.length > 0 ? 'critical' : 'medium',
      icon: 'AlertTriangle',
      title: `${healthIssues.length} system health issue${healthIssues.length > 1 ? 's' : ''}`,
      description: healthIssues[0]?.message || 'System health issue detected',
      action: { label: 'Check Health', route: '/cos/health' },
      count: healthIssues.length
    });
  }

  // 4. Learning failures (skipped task types)
  const skippedTypes = learningSummary?.skippedTypes || [];
  if (skippedTypes.length > 0) {
    insights.push({
      type: 'learning',
      priority: 'low',
      icon: 'Brain',
      title: `${skippedTypes.length} task type${skippedTypes.length > 1 ? 's' : ''} auto-skipped`,
      description: `Due to low success rates: ${skippedTypes.slice(0, 2).map(t => t.type).join(', ')}`,
      action: { label: 'View Learning', route: '/cos/learning' },
      count: skippedTypes.length
    });
  }

  // 5. Unread notifications (briefings, reviews, etc.)
  const briefingNotifs = notificationsData.filter(n => n.type === 'briefing_ready');
  if (briefingNotifs.length > 0) {
    insights.push({
      type: 'briefing',
      priority: 'low',
      icon: 'Newspaper',
      title: 'New briefing available',
      description: 'Your daily briefing is ready for review',
      action: { label: 'Read Briefing', route: '/cos/briefing' },
      count: 1
    });
  }

  // 6. Pending user tasks (informational)
  const pendingUserTasks = tasksData.user?.grouped?.pending || [];
  if (pendingUserTasks.length > 0 && insights.length < 4) {
    insights.push({
      type: 'tasks',
      priority: 'info',
      icon: 'ListTodo',
      title: `${pendingUserTasks.length} pending task${pendingUserTasks.length > 1 ? 's' : ''}`,
      description: pendingUserTasks[0]?.description?.substring(0, 80) || 'Pending tasks available',
      action: { label: 'View Tasks', route: '/cos/tasks' },
      count: pendingUserTasks.length
    });
  }

  // 7. Peak productivity time (proactive suggestion)
  // Show when it's a peak hour AND there are pending tasks to work on
  const totalPendingTasks = pendingUserTasks.length + (tasksData.cos?.grouped?.pending?.length || 0);
  if (optimalTimeInfo?.hasData && optimalTimeInfo.isOptimal && totalPendingTasks > 0 && insights.length < 5) {
    insights.push({
      type: 'peak-time',
      priority: 'low',
      icon: 'Zap',
      title: 'Peak productivity hour',
      description: `This hour has a ${optimalTimeInfo.currentSuccessRate || optimalTimeInfo.peakSuccessRate}% success rate — good time to tackle tasks`,
      action: { label: 'Start Task', route: '/cos/tasks' }
    });
  }

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  insights.sort((a, b) => (priorityOrder[a.priority] || 5) - (priorityOrder[b.priority] || 5));

  res.json({
    insights: insights.slice(0, 5), // Max 5 insights
    hasActionableItems: insights.some(i => ['critical', 'high'].includes(i.priority)),
    totalCount: insights.length
  });
}));

// GET /api/cos/recent-tasks - Get recent completed tasks for dashboard widget
router.get('/recent-tasks', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  const recentTasks = await cos.getRecentTasks(limit);
  res.json(recentTasks);
}));

// GET /api/cos/quick-summary - Get at-a-glance dashboard summary
// Combines today's activity, streak status, next job, and pending approvals into one efficient call
router.get('/quick-summary', asyncHandler(async (req, res) => {
  const [todayActivity, productivityData, tasksData, jobStats, velocityData, weekData, optimalTime] = await Promise.all([
    cos.getTodayActivity(),
    productivity.getProductivitySummary(),
    cos.getAllTasks(),
    autonomousJobs.getJobStats(),
    productivity.getVelocityMetrics(),
    productivity.getWeekComparison(),
    productivity.getOptimalTimeInfo()
  ]);

  // Count pending approvals from system tasks
  const pendingApprovals = tasksData.cos?.awaitingApproval?.length || 0;

  // Count pending user tasks
  const pendingUserTasks = tasksData.user?.grouped?.pending?.length || 0;

  // Combine all pending tasks for queue estimate
  const allPendingTasks = [
    ...(tasksData.user?.grouped?.pending || []),
    ...(tasksData.cos?.grouped?.pending || [])
  ];

  // Get queue completion estimate
  const queueEstimate = await taskLearning.estimateQueueCompletion(
    allPendingTasks,
    todayActivity.stats.running
  );

  res.json({
    today: {
      completed: todayActivity.stats.completed,
      succeeded: todayActivity.stats.succeeded,
      failed: todayActivity.stats.failed,
      running: todayActivity.stats.running,
      successRate: todayActivity.stats.successRate,
      timeWorked: todayActivity.time.combined,
      accomplishments: todayActivity.accomplishments || []
    },
    streak: {
      current: productivityData.currentStreak,
      longest: productivityData.longestStreak,
      weekly: productivityData.weeklyStreak,
      lastActive: productivityData.lastActive
    },
    velocity: {
      percentage: velocityData.velocity,
      label: velocityData.velocityLabel,
      avgPerDay: velocityData.avgPerDay,
      historicalDays: velocityData.historicalDays
    },
    nextJob: jobStats.nextDue,
    queue: {
      pendingApprovals,
      pendingUserTasks,
      total: pendingApprovals + pendingUserTasks,
      estimate: queueEstimate
    },
    status: {
      running: todayActivity.isRunning,
      paused: todayActivity.isPaused,
      lastEvaluation: todayActivity.lastEvaluation
    },
    weekComparison: weekData,
    optimalTime
  });
}));

// GET /api/cos/goal-progress - Get progress toward user goals
// Maps completed tasks to goal categories from GOALS.md
router.get('/goal-progress', asyncHandler(async (req, res) => {
  const progress = await goalProgress.getGoalProgress();
  res.json(progress);
}));

// GET /api/cos/goal-progress/summary - Get compact goal progress for dashboard
router.get('/goal-progress/summary', asyncHandler(async (req, res) => {
  const summary = await goalProgress.getGoalProgressSummary();
  res.json(summary);
}));

// ============================================================
// Decision Log Routes
// ============================================================

// GET /api/cos/decisions - Get recent decisions
router.get('/decisions', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  const type = req.query.type || null;
  const decisions = await decisionLog.getRecentDecisions(limit, type);
  res.json({ decisions });
}));

// GET /api/cos/decisions/summary - Get decision summary for dashboard
router.get('/decisions/summary', asyncHandler(async (req, res) => {
  const summary = await decisionLog.getDecisionSummary();
  res.json(summary);
}));

// GET /api/cos/decisions/patterns - Get decision patterns/insights
router.get('/decisions/patterns', asyncHandler(async (req, res) => {
  const patterns = await decisionLog.getDecisionPatterns();
  res.json(patterns);
}));

export default router;
