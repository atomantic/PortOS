import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import learningRoutes from './cosLearningRoutes.js';

vi.mock('../services/taskLearning.js', () => ({
  getLearningInsights: vi.fn(),
  getAllTaskDurations: vi.fn(),
  backfillFromHistory: vi.fn(),
  getSkippedTaskTypes: vi.fn(),
  resetTaskTypeLearning: vi.fn(),
  getRoutingAccuracy: vi.fn(),
  getPerformanceSummary: vi.fn(),
  getLearningSummary: vi.fn(),
  getRecentInsights: vi.fn(),
  recordLearningInsight: vi.fn(),
  getPromptImprovementRecommendations: vi.fn(),
  getConfidenceLevels: vi.fn(),
  getDismissedRecommendations: vi.fn(),
  dismissRecommendation: vi.fn(),
  restoreRecommendation: vi.fn(),
  clearDismissedRecommendations: vi.fn()
}));

vi.mock('../services/taskLearning/store.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadLearningData: vi.fn(),
  loadDismissedRecommendations: vi.fn()
}));
vi.mock('../services/cos/cosAgentFeedback.js', () => ({ getFeedbackStats: vi.fn() }));
vi.mock('../services/reviewerVerdicts.js', () => ({ getReviewerVerdictStats: vi.fn() }));

vi.mock('../services/weeklyDigest.js', () => ({
  getWeeklyDigest: vi.fn(),
  listWeeklyDigests: vi.fn(),
  getCurrentWeekProgress: vi.fn(),
  generateWeeklyDigest: vi.fn()
}));

vi.mock('../services/cos/cosState.js', () => ({
  loadState: vi.fn().mockResolvedValue({ config: { confidenceAutoApproval: {} } })
}));

import * as taskLearning from '../services/taskLearning.js';
import * as weeklyDigest from '../services/weeklyDigest.js';

import { loadLearningData, loadDismissedRecommendations } from '../services/taskLearning/store.js';
import { getFeedbackStats } from '../services/cos/cosAgentFeedback.js';
import { loadState } from '../services/cos/cosState.js';
import { getReviewerVerdictStats } from '../services/reviewerVerdicts.js';

describe('CoS Learning Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cos', learningRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/cos/learning/dashboard', () => {
    const task = { completed: 8, succeeded: 1, failed: 7, successRate: 13, avgDurationMs: 60000, totalDurationMs: 480000 };
    const dismissals = {
      'example-old': { dismissedAt: '2026-01-01T00:00:00Z' },
      'example-new': { dismissedAt: '2026-01-02T00:00:00Z' }
    };

    beforeEach(() => {
      loadLearningData.mockResolvedValue({
        totals: task,
        byTaskType: { deploy: task },
        byModelTier: {},
        errorPatterns: {},
        routingAccuracy: { deploy: { light: { succeeded: 1, failed: 7 } } },
      });
      loadDismissedRecommendations.mockResolvedValue(dismissals);
      loadState.mockResolvedValue({ config: { confidenceAutoApproval: { highThreshold: 95 } } });
      getFeedbackStats.mockResolvedValue({ total: 1, positive: 1 });
      getReviewerVerdictStats.mockResolvedValue({ runs: 1, reports: 1 });
    });

    it('projects the complete dashboard from one learning read and one dismissal read', async () => {
      const response = await request(app).get('/api/cos/learning/dashboard');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        learning: expect.objectContaining({ totals: expect.objectContaining({ completed: 8, successRate: 13 }), recommendations: expect.any(Array) }),
        performance: expect.objectContaining({ needsAttention: [expect.objectContaining({ taskType: 'deploy' })] }),
        skipped: expect.objectContaining({ advisoryOnly: true, skippedCount: 1, skippedTypes: [expect.objectContaining({ taskType: 'deploy' })] }),
        durations: expect.objectContaining({ deploy: expect.objectContaining({ avgDurationMs: 60000 }), _overall: expect.any(Object) }),
        routing: expect.objectContaining({ matrix: [expect.objectContaining({ taskType: 'deploy' })] }),
        confidence: expect.objectContaining({ thresholds: expect.objectContaining({ highThreshold: 95 }), summary: expect.objectContaining({ low: 1 }) }),
        feedback: { total: 1, positive: 1 },
        dismissed: [
          { id: 'example-new', ...dismissals['example-new'] },
          { id: 'example-old', ...dismissals['example-old'] },
        ],
        reviewerVerdicts: { runs: 1, reports: 1 },
      });
      expect(loadLearningData).toHaveBeenCalledTimes(1);
      expect(loadDismissedRecommendations).toHaveBeenCalledTimes(1);
      expect(loadState).toHaveBeenCalledTimes(1);
      expect(getFeedbackStats).toHaveBeenCalledTimes(1);
      expect(getReviewerVerdictStats).toHaveBeenCalledTimes(1);
    });

    it('returns an explicit unavailable verdict section while preserving other analytics', async () => {
      getReviewerVerdictStats.mockRejectedValueOnce(new Error('Synthetic archive read failure'));

      const response = await request(app).get('/api/cos/learning/dashboard');

      expect(response.status).toBe(200);
      expect(response.body.reviewerVerdicts).toBeNull();
      expect(response.body.learning.totals.completed).toBe(8);
      expect(response.body.feedback.total).toBe(1);
    });
  });

  describe('POST /api/cos/learning/backfill', () => {
    it('should backfill learning data', async () => {
      taskLearning.backfillFromHistory.mockResolvedValue(15);

      const response = await request(app).post('/api/cos/learning/backfill');

      expect(response.status).toBe(200);
      expect(response.body.backfilledCount).toBe(15);
    });
  });

  describe('GET /api/cos/learning/skipped', () => {
    it('should return skipped task types', async () => {
      taskLearning.getSkippedTaskTypes.mockResolvedValue([{ type: 'deploy', rate: 0.2 }]);

      const response = await request(app).get('/api/cos/learning/skipped');

      expect(response.status).toBe(200);
      expect(response.body.skippedCount).toBe(1);
      expect(response.body.lowSuccessCount).toBe(1);
      expect(response.body.advisoryOnly).toBe(true);
      expect(response.body.message).toContain('does not pause scheduling');
    });

    it('should return message when no types skipped', async () => {
      taskLearning.getSkippedTaskTypes.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/learning/skipped');

      expect(response.status).toBe(200);
      expect(response.body.skippedCount).toBe(0);
      expect(response.body.message).toContain('No task types');
    });
  });

  describe('POST /api/cos/learning/reset/:taskType', () => {
    it('should reset learning data for task type', async () => {
      taskLearning.resetTaskTypeLearning.mockResolvedValue({ reset: true });

      const response = await request(app).post('/api/cos/learning/reset/deploy');

      expect(response.status).toBe(200);
      expect(taskLearning.resetTaskTypeLearning.mock.calls[0][0]).toBe('deploy');
    });

    it('should return 404 if task type not found', async () => {
      taskLearning.resetTaskTypeLearning.mockResolvedValue({ reset: false });

      const response = await request(app).post('/api/cos/learning/reset/unknown');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/learning/insights', () => {
    it('should return recent insights with default limit', async () => {
      taskLearning.getRecentInsights.mockResolvedValue([{ message: 'insight 1' }]);

      const response = await request(app).get('/api/cos/learning/insights');

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(1);
      expect(taskLearning.getRecentInsights).toHaveBeenCalledWith(10);
    });

    it('should respect custom limit', async () => {
      taskLearning.getRecentInsights.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/learning/insights?limit=5');

      expect(response.status).toBe(200);
      expect(taskLearning.getRecentInsights).toHaveBeenCalledWith(5);
    });
  });

  describe('POST /api/cos/learning/insights', () => {
    it('should record a learning insight', async () => {
      taskLearning.recordLearningInsight.mockResolvedValue({ id: 'i1', message: 'test' });

      const response = await request(app)
        .post('/api/cos/learning/insights')
        .send({ message: 'test insight', type: 'discovery' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 if message is missing', async () => {
      const response = await request(app)
        .post('/api/cos/learning/insights')
        .send({ type: 'observation' });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/cos/learning/recommendations/:taskType', () => {
    it('should return recommendations for specific task type', async () => {
      taskLearning.getPromptImprovementRecommendations.mockResolvedValue({ suggestions: [] });

      const response = await request(app).get('/api/cos/learning/recommendations/deploy');

      expect(response.status).toBe(200);
      expect(taskLearning.getPromptImprovementRecommendations).toHaveBeenCalledWith('deploy');
    });
  });

  describe('GET /api/cos/learning/recommendations/dismissed', () => {
    it('should return dismissed recommendations list', async () => {
      taskLearning.getDismissedRecommendations.mockResolvedValue([
        { id: 'error-pattern:unknown', dismissedAt: '2026-05-07T00:00:00.000Z', snapshot: { kind: 'count', value: 74 } }
      ]);

      const response = await request(app).get('/api/cos/learning/recommendations/dismissed');

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(1);
    });

    it('should not be intercepted by the :taskType handler', async () => {
      taskLearning.getDismissedRecommendations.mockResolvedValue([]);

      await request(app).get('/api/cos/learning/recommendations/dismissed');

      expect(taskLearning.getDismissedRecommendations).toHaveBeenCalled();
      expect(taskLearning.getPromptImprovementRecommendations).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/cos/learning/recommendations/dismiss', () => {
    it('should dismiss a recommendation by id and snapshot', async () => {
      taskLearning.dismissRecommendation.mockResolvedValue({ id: 'error-pattern:unknown', dismissed: true });

      const response = await request(app)
        .post('/api/cos/learning/recommendations/dismiss')
        .send({ id: 'error-pattern:unknown', snapshot: { kind: 'count', value: 74 } });

      expect(response.status).toBe(200);
      expect(response.body.dismissed).toBe(true);
      expect(taskLearning.dismissRecommendation).toHaveBeenCalledWith('error-pattern:unknown', { kind: 'count', value: 74 });
    });

    it('should return 400 when id is missing', async () => {
      const response = await request(app)
        .post('/api/cos/learning/recommendations/dismiss')
        .send({});

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/cos/learning/recommendations/restore', () => {
    it('should restore a dismissed recommendation', async () => {
      taskLearning.restoreRecommendation.mockResolvedValue({ id: 'error-pattern:unknown', restored: true });

      const response = await request(app)
        .post('/api/cos/learning/recommendations/restore')
        .send({ id: 'error-pattern:unknown' });

      expect(response.status).toBe(200);
      expect(taskLearning.restoreRecommendation.mock.calls[0][0]).toBe('error-pattern:unknown');
    });

    it('should return 400 when id is missing', async () => {
      const response = await request(app)
        .post('/api/cos/learning/recommendations/restore')
        .send({});

      expect(response.status).toBe(400);
    });
  });

  // ============================================================
  // Weekly Digest Routes
  // ============================================================

  describe('GET /api/cos/digest/list', () => {
    it('should list weekly digests', async () => {
      weeklyDigest.listWeeklyDigests.mockResolvedValue(['2026-W14', '2026-W13']);

      const response = await request(app).get('/api/cos/digest/list');

      expect(response.status).toBe(200);
      expect(response.body.digests).toHaveLength(2);
    });
  });

  describe('GET /api/cos/digest/:weekId', () => {
    it('should return digest for specific week', async () => {
      weeklyDigest.getWeeklyDigest.mockResolvedValue({ weekId: '2026-W13', stats: {} });

      const response = await request(app).get('/api/cos/digest/2026-W13');

      expect(response.status).toBe(200);
      expect(weeklyDigest.getWeeklyDigest.mock.calls[0][0]).toBe('2026-W13');
    });

    it('should return 400 for invalid weekId format', async () => {
      const response = await request(app).get('/api/cos/digest/bad-format');

      expect(response.status).toBe(400);
    });

    it('should return 404 if digest not found', async () => {
      weeklyDigest.getWeeklyDigest.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/digest/2020-W01');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/digest/generate', () => {
    it('should force generate digest', async () => {
      weeklyDigest.generateWeeklyDigest.mockResolvedValue({ weekId: '2026-W14' });

      const response = await request(app)
        .post('/api/cos/digest/generate')
        .send({ weekId: '2026-W14' });

      expect(response.status).toBe(200);
      expect(weeklyDigest.generateWeeklyDigest.mock.calls[0][0]).toBe('2026-W14');
    });

    it('rejects a weekId that is not an ISO week id before it can name a file', async () => {
      weeklyDigest.generateWeeklyDigest.mockClear();

      const response = await request(app)
        .post('/api/cos/digest/generate')
        .send({ weekId: '../../brain/memory' });

      expect(response.status).toBe(400);
      expect(weeklyDigest.generateWeeklyDigest).not.toHaveBeenCalled();
    });

    it('should generate for current week if weekId not provided', async () => {
      weeklyDigest.generateWeeklyDigest.mockResolvedValue({ weekId: '2026-W14' });

      const response = await request(app)
        .post('/api/cos/digest/generate')
        .send({});

      expect(response.status).toBe(200);
      expect(weeklyDigest.generateWeeklyDigest).toHaveBeenCalledWith(null);
    });
  });

});
