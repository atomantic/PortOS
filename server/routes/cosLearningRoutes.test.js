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
  getAdaptiveCooldownMultiplier: vi.fn(),
  getRoutingAccuracy: vi.fn(),
  getPerformanceSummary: vi.fn(),
  getLearningSummary: vi.fn(),
  getRecentInsights: vi.fn(),
  recordLearningInsight: vi.fn(),
  getAllPromptRecommendations: vi.fn(),
  getPromptImprovementRecommendations: vi.fn(),
  recalculateModelTierMetrics: vi.fn(),
  recalculateDurationStats: vi.fn(),
  getConfidenceLevels: vi.fn(),
  getTaskTypeConfidence: vi.fn()
}));

vi.mock('../services/weeklyDigest.js', () => ({
  getWeeklyDigest: vi.fn(),
  listWeeklyDigests: vi.fn(),
  getCurrentWeekProgress: vi.fn(),
  generateTextSummary: vi.fn(),
  generateWeeklyDigest: vi.fn(),
  compareWeeks: vi.fn()
}));

vi.mock('../services/cosState.js', () => ({
  loadState: vi.fn().mockResolvedValue({ config: { confidenceAutoApproval: {} } })
}));

import * as taskLearning from '../services/taskLearning.js';
import * as weeklyDigest from '../services/weeklyDigest.js';

describe('CoS Learning Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cos', learningRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/cos/learning', () => {
    it('should return learning insights', async () => {
      taskLearning.getLearningInsights.mockResolvedValue({ taskTypes: {}, skippedTypes: [] });

      const response = await request(app).get('/api/cos/learning');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('taskTypes');
    });
  });

  describe('GET /api/cos/learning/durations', () => {
    it('should return task durations', async () => {
      taskLearning.getAllTaskDurations.mockResolvedValue({ 'app-improve': { avg: 300 } });

      const response = await request(app).get('/api/cos/learning/durations');

      expect(response.status).toBe(200);
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
      expect(response.body.reset).toBe(true);
    });

    it('should return 404 if task type not found', async () => {
      taskLearning.resetTaskTypeLearning.mockResolvedValue({ reset: false });

      const response = await request(app).post('/api/cos/learning/reset/unknown');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/learning/cooldown/:taskType', () => {
    it('should return cooldown info', async () => {
      taskLearning.getAdaptiveCooldownMultiplier.mockResolvedValue({ multiplier: 1.5, reason: 'low success' });

      const response = await request(app).get('/api/cos/learning/cooldown/deploy');

      expect(response.status).toBe(200);
      expect(response.body.taskType).toBe('deploy');
      expect(response.body.multiplier).toBe(1.5);
    });
  });

  describe('GET /api/cos/learning/routing', () => {
    it('should return routing accuracy', async () => {
      taskLearning.getRoutingAccuracy.mockResolvedValue({ accuracy: 0.85 });

      const response = await request(app).get('/api/cos/learning/routing');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/cos/learning/performance', () => {
    it('should return performance summary', async () => {
      taskLearning.getPerformanceSummary.mockResolvedValue({ overall: 0.75 });

      const response = await request(app).get('/api/cos/learning/performance');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/cos/learning/summary', () => {
    it('should return learning health summary', async () => {
      taskLearning.getLearningSummary.mockResolvedValue({ healthy: true });

      const response = await request(app).get('/api/cos/learning/summary');

      expect(response.status).toBe(200);
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

  describe('GET /api/cos/learning/recommendations', () => {
    it('should return prompt recommendations with summary', async () => {
      taskLearning.getAllPromptRecommendations.mockResolvedValue([
        { status: 'critical', taskType: 'deploy' },
        { status: 'good', taskType: 'review' }
      ]);

      const response = await request(app).get('/api/cos/learning/recommendations');

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(2);
      expect(response.body.summary.critical).toBe(1);
      expect(response.body.summary.good).toBe(1);
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

  describe('POST /api/cos/learning/recalculate-model-tiers', () => {
    it('should recalculate model tier metrics', async () => {
      taskLearning.recalculateModelTierMetrics.mockResolvedValue({ recalculated: 5 });

      const response = await request(app).post('/api/cos/learning/recalculate-model-tiers');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/cos/learning/recalculate-durations', () => {
    it('should recalculate duration stats', async () => {
      taskLearning.recalculateDurationStats.mockResolvedValue({ recalculated: 3 });

      const response = await request(app).post('/api/cos/learning/recalculate-durations');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/cos/learning/confidence', () => {
    it('should return confidence levels', async () => {
      taskLearning.getConfidenceLevels.mockResolvedValue({ levels: {} });

      const response = await request(app).get('/api/cos/learning/confidence');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/cos/learning/confidence/:taskType', () => {
    it('should return confidence for specific task type', async () => {
      taskLearning.getTaskTypeConfidence.mockResolvedValue({ level: 'high', score: 0.9 });

      const response = await request(app).get('/api/cos/learning/confidence/review');

      expect(response.status).toBe(200);
    });
  });

  // ============================================================
  // Weekly Digest Routes
  // ============================================================

  describe('GET /api/cos/digest', () => {
    it('should return current week digest', async () => {
      weeklyDigest.getWeeklyDigest.mockResolvedValue({ weekId: '2026-W14', stats: {} });

      const response = await request(app).get('/api/cos/digest');

      expect(response.status).toBe(200);
      expect(response.body.weekId).toBe('2026-W14');
    });
  });

  describe('GET /api/cos/digest/list', () => {
    it('should list weekly digests', async () => {
      weeklyDigest.listWeeklyDigests.mockResolvedValue(['2026-W14', '2026-W13']);

      const response = await request(app).get('/api/cos/digest/list');

      expect(response.status).toBe(200);
      expect(response.body.digests).toHaveLength(2);
    });
  });

  describe('GET /api/cos/digest/progress', () => {
    it('should return current week progress', async () => {
      weeklyDigest.getCurrentWeekProgress.mockResolvedValue({ completed: 5, total: 10 });

      const response = await request(app).get('/api/cos/digest/progress');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/cos/digest/text', () => {
    it('should return text summary', async () => {
      weeklyDigest.generateTextSummary.mockResolvedValue('Weekly summary text');

      const response = await request(app).get('/api/cos/digest/text');

      expect(response.status).toBe(200);
      expect(response.text).toContain('Weekly summary text');
    });
  });

  describe('GET /api/cos/digest/:weekId', () => {
    it('should return digest for specific week', async () => {
      weeklyDigest.getWeeklyDigest.mockResolvedValue({ weekId: '2026-W13', stats: {} });

      const response = await request(app).get('/api/cos/digest/2026-W13');

      expect(response.status).toBe(200);
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

  describe('GET /api/cos/digest/compare', () => {
    it('should return 400 when week params are missing', async () => {
      const response = await request(app).get('/api/cos/digest/compare');
      expect(response.status).toBe(400);
    });

    it('should return comparison for two weeks', async () => {
      weeklyDigest.compareWeeks.mockResolvedValue({ week1: '2026-W01', week2: '2026-W02', changes: [] });
      const response = await request(app).get('/api/cos/digest/compare?week1=2026-W01&week2=2026-W02');
      expect(response.status).toBe(200);
      expect(weeklyDigest.compareWeeks).toHaveBeenCalledWith('2026-W01', '2026-W02');
    });

    it('should return 404 when weeks not found', async () => {
      weeklyDigest.compareWeeks.mockResolvedValue(null);
      const response = await request(app).get('/api/cos/digest/compare?week1=2026-W01&week2=2026-W02');
      expect(response.status).toBe(404);
    });
  });
});
