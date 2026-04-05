import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import insightRoutes from './cosInsightRoutes.js';

vi.mock('../services/cos.js', () => ({
  getAllTasks: vi.fn(),
  runHealthCheck: vi.fn(),
  getTodayActivity: vi.fn(),
  getRecentTasks: vi.fn()
}));

vi.mock('../services/taskLearning.js', () => ({
  getLearningInsights: vi.fn(),
  estimateQueueCompletion: vi.fn()
}));

vi.mock('../services/autonomousJobs.js', () => ({
  getJobStats: vi.fn()
}));

vi.mock('../services/productivity.js', () => ({
  getProductivityInsights: vi.fn(),
  getProductivitySummary: vi.fn(),
  recalculateProductivity: vi.fn(),
  getDailyTrends: vi.fn(),
  getActivityCalendar: vi.fn(),
  getOptimalTimeInfo: vi.fn(),
  getVelocityMetrics: vi.fn(),
  getWeekComparison: vi.fn()
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

vi.mock('../services/notifications.js', () => ({
  getNotifications: vi.fn().mockResolvedValue([])
}));

import * as cos from '../services/cos.js';
import * as taskLearning from '../services/taskLearning.js';
import * as autonomousJobs from '../services/autonomousJobs.js';
import * as productivity from '../services/productivity.js';
import * as goalProgress from '../services/goalProgress.js';
import * as decisionLog from '../services/decisionLog.js';

describe('CoS Insight Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cos', insightRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/cos/productivity', () => {
    it('should return productivity insights', async () => {
      productivity.getProductivityInsights.mockResolvedValue({ streaks: {}, efficiency: 0.8 });

      const response = await request(app).get('/api/cos/productivity');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('efficiency');
    });
  });

  describe('GET /api/cos/productivity/summary', () => {
    it('should return productivity summary', async () => {
      productivity.getProductivitySummary.mockResolvedValue({ currentStreak: 5 });

      const response = await request(app).get('/api/cos/productivity/summary');

      expect(response.status).toBe(200);
      expect(response.body.currentStreak).toBe(5);
    });
  });

  describe('POST /api/cos/productivity/recalculate', () => {
    it('should recalculate productivity', async () => {
      productivity.recalculateProductivity.mockResolvedValue({ recalculated: true });

      const response = await request(app).post('/api/cos/productivity/recalculate');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/cos/productivity/trends', () => {
    it('should return daily trends with default days', async () => {
      productivity.getDailyTrends.mockResolvedValue([{ date: '2026-04-01', completed: 3 }]);

      const response = await request(app).get('/api/cos/productivity/trends');

      expect(response.status).toBe(200);
      expect(productivity.getDailyTrends).toHaveBeenCalledWith(30);
    });

    it('should respect custom days', async () => {
      productivity.getDailyTrends.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/productivity/trends?days=7');

      expect(response.status).toBe(200);
      expect(productivity.getDailyTrends).toHaveBeenCalledWith(7);
    });
  });

  describe('GET /api/cos/productivity/calendar', () => {
    it('should return activity calendar with default weeks', async () => {
      productivity.getActivityCalendar.mockResolvedValue({ weeks: [] });

      const response = await request(app).get('/api/cos/productivity/calendar');

      expect(response.status).toBe(200);
      expect(productivity.getActivityCalendar).toHaveBeenCalledWith(12);
    });
  });

  describe('GET /api/cos/actionable-insights', () => {
    it('should return actionable insights sorted by priority', async () => {
      cos.getAllTasks.mockResolvedValue({
        user: { grouped: { pending: [{ id: 't1', description: 'Task' }], blocked: [] } },
        cos: { awaitingApproval: [{ id: 'a1', description: 'Approve me' }], grouped: { pending: [], blocked: [] } }
      });
      taskLearning.getLearningInsights.mockResolvedValue({ skippedTypes: [] });
      cos.runHealthCheck.mockResolvedValue({ issues: [] });
      productivity.getOptimalTimeInfo.mockResolvedValue({ hasData: false });

      const response = await request(app).get('/api/cos/actionable-insights');

      expect(response.status).toBe(200);
      expect(response.body.hasActionableItems).toBe(true);
      expect(response.body.insights.length).toBeGreaterThan(0);
      expect(response.body.insights[0].type).toBe('approval');
    });

    it('should handle errors gracefully in parallel calls', async () => {
      cos.getAllTasks.mockRejectedValue(new Error('fail'));
      taskLearning.getLearningInsights.mockRejectedValue(new Error('fail'));
      cos.runHealthCheck.mockRejectedValue(new Error('fail'));
      productivity.getOptimalTimeInfo.mockRejectedValue(new Error('fail'));

      const response = await request(app).get('/api/cos/actionable-insights');

      expect(response.status).toBe(200);
      expect(response.body.insights).toEqual([]);
    });
  });

  describe('GET /api/cos/recent-tasks', () => {
    it('should return recent tasks with default limit', async () => {
      cos.getRecentTasks.mockResolvedValue([{ id: 't1' }]);

      const response = await request(app).get('/api/cos/recent-tasks');

      expect(response.status).toBe(200);
      expect(cos.getRecentTasks).toHaveBeenCalledWith(10);
    });

    it('should respect custom limit', async () => {
      cos.getRecentTasks.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/recent-tasks?limit=5');

      expect(response.status).toBe(200);
      expect(cos.getRecentTasks).toHaveBeenCalledWith(5);
    });
  });

  describe('GET /api/cos/quick-summary', () => {
    it('should return combined dashboard summary', async () => {
      cos.getTodayActivity.mockResolvedValue({
        stats: { completed: 3, succeeded: 2, failed: 1, running: 0, successRate: 67 },
        time: { combined: '2h 30m' },
        isRunning: true,
        isPaused: false,
        lastEvaluation: Date.now(),
        accomplishments: ['Fixed bug']
      });
      productivity.getProductivitySummary.mockResolvedValue({
        currentStreak: 5, longestStreak: 10, weeklyStreak: 3, lastActive: Date.now()
      });
      cos.getAllTasks.mockResolvedValue({
        user: { grouped: { pending: [] } },
        cos: { awaitingApproval: [], grouped: { pending: [] } }
      });
      autonomousJobs.getJobStats.mockResolvedValue({ nextDue: null });
      productivity.getVelocityMetrics.mockResolvedValue({
        velocity: 120, velocityLabel: 'Above average', avgPerDay: 3, historicalDays: 30
      });
      productivity.getWeekComparison.mockResolvedValue({ delta: 2 });
      productivity.getOptimalTimeInfo.mockResolvedValue({ hasData: false });
      taskLearning.estimateQueueCompletion.mockResolvedValue({ eta: null });

      const response = await request(app).get('/api/cos/quick-summary');

      expect(response.status).toBe(200);
      expect(response.body.today.completed).toBe(3);
      expect(response.body.streak.current).toBe(5);
      expect(response.body.velocity.percentage).toBe(120);
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
