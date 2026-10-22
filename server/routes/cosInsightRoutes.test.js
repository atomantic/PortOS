import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import insightRoutes from './cosInsightRoutes.js';

vi.mock('../services/cosTaskStore.js', () => ({
  getAllTasks: vi.fn()
}));
vi.mock('../services/cosAgentLifecycle.js', () => ({
  getAgents: vi.fn(async () => [])
}));
vi.mock('../services/cosHealthMonitor.js', () => ({
  runHealthCheck: vi.fn(),
  getHealthStatus: vi.fn()
}));
vi.mock('../services/cosAgentFeedback.js', () => ({
  getPendingAgentFeedbackCount: vi.fn()
}));
vi.mock('../services/cosReports.js', () => ({
  getTodayActivity: vi.fn(),
  getRecentTasks: vi.fn()
}));

vi.mock('../services/taskLearning.js', () => ({
  getLearningInsights: vi.fn()
}));

vi.mock('../services/cosActivityCalendar.js', () => ({
  getActivityCalendar: vi.fn()
}));

vi.mock('../services/goalProgress.js', () => ({
  getGoalProgress: vi.fn(),
  getGoalProgressSummary: vi.fn()
}));

vi.mock('../services/decisionLog.js', () => ({
  getRecentDecisions: vi.fn(),
  getDecisionSummary: vi.fn(),
  getDecisionPatterns: vi.fn()
}));

const detectIdleLeftoverBranches = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../services/userActionDetectors.js', () => ({ detectIdleLeftoverBranches }));

vi.mock('../services/notifications.js', () => ({
  getNotifications: vi.fn().mockResolvedValue([])
}));

import { getAgents } from '../services/cosAgentLifecycle.js';
import { getAllTasks } from '../services/cosTaskStore.js';
import { getHealthStatus, runHealthCheck } from '../services/cosHealthMonitor.js';
import { getPendingAgentFeedbackCount } from '../services/cosAgentFeedback.js';
import { getRecentTasks, getTodayActivity } from '../services/cosReports.js';
import * as taskLearning from '../services/taskLearning.js';
import { getActivityCalendar } from '../services/cosActivityCalendar.js';
import * as goalProgress from '../services/goalProgress.js';
import * as decisionLog from '../services/decisionLog.js';
import * as notifications from '../services/notifications.js';

describe('CoS Insight Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cos', insightRoutes);
    vi.clearAllMocks();
    getPendingAgentFeedbackCount.mockResolvedValue(0);
    // clearAllMocks keeps implementations, so a per-test override would leak
    // into later tests — restore the default empty notification list here.
    notifications.getNotifications.mockResolvedValue([]);
  });

  describe('GET /api/cos/activity-calendar', () => {
    it('defaults to 12 weeks', async () => {
      getActivityCalendar.mockResolvedValue({ weeks: [], maxTasks: 1, summary: {} });

      const response = await request(app).get('/api/cos/activity-calendar');

      expect(response.status).toBe(200);
      expect(getActivityCalendar).toHaveBeenCalledWith(12);
    });

    it('respects a custom week count', async () => {
      getActivityCalendar.mockResolvedValue({ weeks: [], maxTasks: 1, summary: {} });

      const response = await request(app).get('/api/cos/activity-calendar?weeks=4');

      expect(response.status).toBe(200);
      expect(getActivityCalendar).toHaveBeenCalledWith(4);
    });

    // The grid materializes one object per day, so an unbounded week count
    // would build millions of them and exhaust memory.
    it.each([
      ['?weeks=999999', 260],
      ['?weeks=-5', 1],
    ])('clamps %s to %i weeks', async (query, expected) => {
      getActivityCalendar.mockResolvedValue({ weeks: [], maxTasks: 1, summary: {} });

      const response = await request(app).get(`/api/cos/activity-calendar${query}`);

      expect(response.status).toBe(200);
      expect(getActivityCalendar).toHaveBeenCalledWith(expected);
    });
  });

  describe('GET /api/cos/actionable-insights', () => {
    it('refreshes event-driven insights from persisted health without running process repair', async () => {
      getAllTasks.mockResolvedValue({ user: null, cos: null });
      taskLearning.getLearningInsights.mockResolvedValue(null);
      getHealthStatus.mockResolvedValue({ issues: [] });
      const response = await request(app).get('/api/cos/actionable-insights?cachedHealth=1');
      expect(response.status).toBe(200);
      expect(getHealthStatus).toHaveBeenCalledTimes(1);
      expect(runHealthCheck).not.toHaveBeenCalled();
      expect(response.body.insights).toEqual([]);
      expect(response.body.unavailableSources).toEqual([]);
    });

    it('should return actionable insights sorted by priority', async () => {
      getAllTasks.mockResolvedValue({
        user: { grouped: { pending: [{ id: 't1', description: 'Task' }], blocked: [] } },
        cos: { awaitingApproval: [{ id: 'a1', description: 'Approve me' }], grouped: { pending: [], blocked: [] } }
      });
      taskLearning.getLearningInsights.mockResolvedValue({ skippedTypes: [] });
      runHealthCheck.mockResolvedValue({ issues: [] });
      getPendingAgentFeedbackCount.mockResolvedValue(2);

      const response = await request(app).get('/api/cos/actionable-insights');

      expect(response.status).toBe(200);
      expect(response.body.hasActionableItems).toBe(true);
      expect(response.body.insights.length).toBeGreaterThan(0);
      expect(response.body.insights[0].type).toBe('approval');
      expect(response.body.insights[0]).toMatchObject({
        action: { label: 'Approve' },
        tasks: [{ id: 'a1', description: 'Approve me' }],
      });
      expect(response.body.insights).toContainEqual(expect.objectContaining({
        type: 'agent-feedback',
        count: 2,
        action: { label: 'Review runs', route: '/cos/agents?feedback=needs-feedback' }
      }));
    });

    it('surfaces leftover idle branches as a Run Now insight card', async () => {
      getAllTasks.mockResolvedValue({
        user: { grouped: { pending: [], blocked: [] } },
        cos: { awaitingApproval: [], grouped: { pending: [], blocked: [] } }
      });
      taskLearning.getLearningInsights.mockResolvedValue({ skippedTypes: [] });
      runHealthCheck.mockResolvedValue({ issues: [] });
      getPendingAgentFeedbackCount.mockResolvedValue(0);
      detectIdleLeftoverBranches.mockResolvedValueOnce([{
        appId: 'app-acme', appName: 'Acme', leftoverCount: 3, states: { NEEDS_PR: 3 },
        branches: ['claim/one'], lastUserReconcileAt: null, agentsIdle: true,
      }]);

      const response = await request(app).get('/api/cos/actionable-insights');

      expect(response.status).toBe(200);
      expect(response.body.insights).toContainEqual(expect.objectContaining({
        type: 'leftover-branches',
        priority: 'medium',
        icon: 'AlertTriangle',
        title: '3 leftover branches on Acme, agents idle. Run branch-reconcile?',
        // The deep link opens the branch-reconcile task itself, not the bare page.
        action: { label: 'Run Now', route: '/cos/schedule?task=branch-reconcile' },
        apps: [{
          appId: 'app-acme', appName: 'Acme', leftoverCount: 3,
          states: { NEEDS_PR: 3 }, branches: ['claim/one'], lastUserReconcileAt: null,
        }],
        count: 3,
      }));
    });

    // A bare cross-app total ("20 branches across 6 apps") left the operator with
    // no way to know which app to run branch-reconcile for — the card now names
    // every app and carries the per-app rows the banner runs from.
    it('names each app holding leftover branches in the multi-app card', async () => {
      getAllTasks.mockResolvedValue({
        user: { grouped: { pending: [], blocked: [] } },
        cos: { awaitingApproval: [], grouped: { pending: [], blocked: [] } }
      });
      taskLearning.getLearningInsights.mockResolvedValue({ skippedTypes: [] });
      runHealthCheck.mockResolvedValue({ issues: [] });
      getPendingAgentFeedbackCount.mockResolvedValue(0);
      detectIdleLeftoverBranches.mockResolvedValueOnce([
        { appId: 'app-acme', appName: 'Acme', leftoverCount: 4, states: { NEEDS_PR: 4 }, branches: [], lastUserReconcileAt: null, agentsIdle: true },
        { appId: 'app-beta', appName: 'Beta', leftoverCount: 1, states: { WIP: 1 }, branches: [], lastUserReconcileAt: '2026-08-28T10:00:00.000Z', agentsIdle: true },
      ]);

      const response = await request(app).get('/api/cos/actionable-insights');

      const insight = response.body.insights.find(i => i.type === 'leftover-branches');
      expect(insight.title).toBe('5 leftover branches across 2 apps, agents idle. Run branch-reconcile?');
      expect(insight.description).toBe('Acme (4) · Beta (1)');
      expect(insight.apps.map(app => app.appId)).toEqual(['app-acme', 'app-beta']);
    });

    // The health insight filtered on a `severity` field runHealthCheck never
    // writes, so a PM2 process that failed to auto-restart banner'd at the same
    // muted `medium` priority as a memory warning.
    it('raises the health insight to critical for an error-type issue', async () => {
      getAllTasks.mockResolvedValue({ user: null, cos: null });
      taskLearning.getLearningInsights.mockResolvedValue({ skippedTypes: [] });
      getPendingAgentFeedbackCount.mockResolvedValue(0);
      runHealthCheck.mockResolvedValue({
        issues: [
          { type: 'warning', category: 'memory', message: 'High memory usage in: example-app (900MB)' },
          { type: 'error', category: 'processes', message: 'example-app failed to auto-restart' }
        ]
      });

      const response = await request(app).get('/api/cos/actionable-insights');

      expect(response.status).toBe(200);
      expect(response.body.insights).toContainEqual(expect.objectContaining({
        type: 'health',
        priority: 'critical',
        count: 2,
        // …and it describes the error, not the warning that happened to sort first.
        description: 'example-app failed to auto-restart',
        action: { label: 'Check Health', route: '/cos/health' }
      }));
    });

    it('keeps a warning-only health check at medium priority', async () => {
      getAllTasks.mockResolvedValue({ user: null, cos: null });
      taskLearning.getLearningInsights.mockResolvedValue({ skippedTypes: [] });
      getPendingAgentFeedbackCount.mockResolvedValue(0);
      runHealthCheck.mockResolvedValue({
        issues: [{ type: 'warning', category: 'memory', message: 'High memory usage in: example-app (900MB)' }]
      });

      const response = await request(app).get('/api/cos/actionable-insights');

      expect(response.status).toBe(200);
      expect(response.body.insights).toContainEqual(expect.objectContaining({
        type: 'health',
        priority: 'medium',
        description: 'High memory usage in: example-app (900MB)'
      }));
    });

    // The priority sort used `priorityOrder[p] || 5`, and `critical` ranks 0 —
    // so `0 || 5` demoted the single most urgent insight below every other
    // priority. It sorted LAST and, once six insights were open, fell off the
    // `slice(0, 5)` entirely. Only reachable now that a health issue can
    // actually be `critical`.
    it('sorts a critical insight first and keeps it within the top-5 slice', async () => {
      getAllTasks.mockResolvedValue({
        user: { grouped: { pending: [], blocked: [{ id: 'b1', description: 'Blocked task' }] } },
        cos: { awaitingApproval: [{ id: 'a1', description: 'Approve me' }], grouped: { pending: [], blocked: [] } }
      });
      taskLearning.getLearningInsights.mockResolvedValue({ skippedTypes: [{ type: 'flaky' }] });
      getPendingAgentFeedbackCount.mockResolvedValue(2);
      notifications.getNotifications.mockResolvedValue([{ type: 'briefing_ready' }]);
      runHealthCheck.mockResolvedValue({
        issues: [{ type: 'error', category: 'processes', message: 'example-app failed to auto-restart' }]
      });

      const response = await request(app).get('/api/cos/actionable-insights');

      expect(response.status).toBe(200);
      // Six insights were built, so a demoted critical would have been sliced off.
      expect(response.body.totalCount).toBe(6);
      expect(response.body.insights[0]).toMatchObject({ type: 'health', priority: 'critical' });
      expect(response.body.insights.map(i => i.priority)).toEqual(['critical', 'high', 'high', 'medium', 'low']);
    });

    it('keeps health observation failure visible when parallel calls fail', async () => {
      getAllTasks.mockRejectedValue(new Error('fail'));
      taskLearning.getLearningInsights.mockRejectedValue(new Error('fail'));
      runHealthCheck.mockRejectedValue(new Error('fail'));

      const response = await request(app).get('/api/cos/actionable-insights');

      expect(response.status).toBe(200);
      expect(response.body.insights).toEqual([expect.objectContaining({ type: 'health-unavailable', priority: 'high' })]);
      expect(response.body.hasActionableItems).toBe(true);
      expect(response.body.totalCount).toBe(1);
      expect(response.body.unavailableSources).toEqual([{ source: 'health', code: 'HEALTH_UNAVAILABLE' }]);
    });

    it.each(['', '?cachedHealth=1'])('retains other insights while health is unavailable on %s', async query => {
      getAllTasks.mockResolvedValue({ user: null, cos: { awaitingApproval: [{ id: 'a1', description: 'Example approval' }] } });
      taskLearning.getLearningInsights.mockResolvedValue(null);
      runHealthCheck.mockRejectedValue(new Error('private failure details'));
      getHealthStatus.mockRejectedValue(new Error('private failure details'));

      const response = await request(app).get(`/api/cos/actionable-insights${query}`);

      expect(response.status).toBe(200);
      expect(response.body.insights.map(i => i.type)).toEqual(['approval', 'health-unavailable']);
      expect(response.body.unavailableSources).toEqual([{ source: 'health', code: 'HEALTH_UNAVAILABLE' }]);
      expect(JSON.stringify(response.body)).not.toContain('private failure details');
      if (query) expect(runHealthCheck).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/cos/recent-tasks', () => {
    it('should return recent tasks with default limit', async () => {
      getRecentTasks.mockResolvedValue([{ id: 't1' }]);

      const response = await request(app).get('/api/cos/recent-tasks');

      expect(response.status).toBe(200);
      expect(getRecentTasks).toHaveBeenCalledWith(10);
    });

    it('should respect custom limit', async () => {
      getRecentTasks.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/recent-tasks?limit=5');

      expect(response.status).toBe(200);
      expect(getRecentTasks).toHaveBeenCalledWith(5);
    });
  });

  describe('GET /api/cos/quick-summary', () => {
    it('should return combined dashboard summary', async () => {
      getTodayActivity.mockResolvedValue({
        stats: { completed: 3, succeeded: 2, failed: 1, running: 0, successRate: 67 },
        time: { combined: '2h 30m' },
        isRunning: true,
        isPaused: false,
        lastEvaluation: Date.now(),
        accomplishments: ['Fixed bug']
      });
      getAllTasks.mockResolvedValue({
        user: { grouped: { pending: [] } },
        cos: { awaitingApproval: [], grouped: { pending: [] } }
      });
      const response = await request(app).get('/api/cos/quick-summary');

      expect(response.status).toBe(200);
      expect(response.body.today.completed).toBe(3);
      expect(response.body).not.toHaveProperty('streak');
      expect(response.body).not.toHaveProperty('nextJob');
      expect(response.body).not.toHaveProperty('weekComparison');
      expect(response.body).not.toHaveProperty('optimalTime');
      expect(response.body.today).not.toHaveProperty('accomplishments');
      expect(response.body.queue).not.toHaveProperty('estimate');
      expect(response.body).not.toHaveProperty('velocity');
    });

    it('does not count a task its agent is already running as queued', async () => {
      // The dashboard widget renders this payload's queue total beside its own
      // "N agents running" line, so the one task being worked read as BOTH.
      getTodayActivity.mockResolvedValue({
        stats: { completed: 0, succeeded: 0, failed: 0, running: 1, successRate: 0 },
        time: { combined: '0s' },
        isRunning: true,
        isPaused: false,
        lastEvaluation: Date.now()
      });
      getAllTasks.mockResolvedValue({
        user: { grouped: { pending: [{ id: 'user/42', status: 'pending' }] } },
        cos: { awaitingApproval: [], grouped: { pending: [] } }
      });
      getAgents.mockResolvedValue([{ id: 'agent-1', taskId: 'user/42', status: 'running', startedAt: new Date().toISOString() }]);

      const response = await request(app).get('/api/cos/quick-summary');

      expect(response.status).toBe(200);
      expect(response.body.queue).toMatchObject({ pendingUserTasks: 0, total: 0 });
      expect(response.body.today.running).toBe(1);
    });
  });

  describe('GET /api/cos/goal-progress', () => {
    it('should return goal progress', async () => {
      goalProgress.getGoalProgress.mockResolvedValue({ goals: [], overall: 0.5 });

      const response = await request(app).get('/api/cos/goal-progress');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('overall');
    });
  });

  describe('GET /api/cos/goal-progress/summary', () => {
    it('should return goal progress summary', async () => {
      goalProgress.getGoalProgressSummary.mockResolvedValue({ topGoals: [] });

      const response = await request(app).get('/api/cos/goal-progress/summary');

      expect(response.status).toBe(200);
    });
  });

  // ============================================================
  // Decision Log Routes
  // ============================================================

  describe('GET /api/cos/decisions', () => {
    it('should return recent decisions with default limit', async () => {
      decisionLog.getRecentDecisions.mockResolvedValue([{ id: 'd1', type: 'approval' }]);

      const response = await request(app).get('/api/cos/decisions');

      expect(response.status).toBe(200);
      expect(response.body.decisions).toHaveLength(1);
      expect(decisionLog.getRecentDecisions).toHaveBeenCalledWith(20, null);
    });

    it('should respect custom limit and type', async () => {
      decisionLog.getRecentDecisions.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/decisions?limit=5&type=routing');

      expect(response.status).toBe(200);
      expect(decisionLog.getRecentDecisions).toHaveBeenCalledWith(5, 'routing');
    });
  });

  describe('GET /api/cos/decisions/summary', () => {
    it('should return decision summary', async () => {
      decisionLog.getDecisionSummary.mockResolvedValue({ total: 50, byType: {} });

      const response = await request(app).get('/api/cos/decisions/summary');

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(50);
    });
  });

  describe('GET /api/cos/decisions/patterns', () => {
    it('should return decision patterns', async () => {
      decisionLog.getDecisionPatterns.mockResolvedValue({ patterns: [] });

      const response = await request(app).get('/api/cos/decisions/patterns');

      expect(response.status).toBe(200);
    });
  });
});
