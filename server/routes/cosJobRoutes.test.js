import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import jobRoutes from './cosJobRoutes.js';

vi.mock('../services/cos.js', () => ({
  addTask: vi.fn()
}));

vi.mock('../services/autonomousJobs.js', () => ({
  getAllJobs: vi.fn(),
  getJobStats: vi.fn(),
  getDueJobs: vi.fn(),
  INTERVAL_OPTIONS: ['hourly', 'daily', 'weekly'],
  getAllowedCommands: vi.fn(),
  getJob: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  toggleJob: vi.fn(),
  deleteJob: vi.fn(),
  isShellJob: vi.fn(),
  isScriptJob: vi.fn(),
  executeShellJob: vi.fn(),
  executeScriptJob: vi.fn(),
  generateTaskFromJob: vi.fn()
}));

vi.mock('../services/jobGates.js', () => ({
  checkJobGate: vi.fn(),
  hasGate: vi.fn(),
  getRegisteredGates: vi.fn()
}));

vi.mock('../services/eventScheduler.js', () => ({
  parseCronToNextRun: vi.fn()
}));

import * as cos from '../services/cos.js';
import * as autonomousJobs from '../services/autonomousJobs.js';
import { checkJobGate, hasGate, getRegisteredGates } from '../services/jobGates.js';
import { parseCronToNextRun } from '../services/eventScheduler.js';

describe('CoS Job Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cos', jobRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/cos/jobs', () => {
    it('should return all jobs with gates and stats', async () => {
      autonomousJobs.getAllJobs.mockResolvedValue([{ id: 'j1', name: 'Review' }]);
      autonomousJobs.getJobStats.mockResolvedValue({ total: 1 });
      hasGate.mockReturnValue(false);
      getRegisteredGates.mockReturnValue([]);

      const response = await request(app).get('/api/cos/jobs');

      expect(response.status).toBe(200);
      expect(response.body.jobs).toHaveLength(1);
      expect(response.body.jobs[0].hasGate).toBe(false);
      expect(response.body.stats).toHaveProperty('total');
    });
  });

  describe('GET /api/cos/jobs/due', () => {
    it('should return due jobs', async () => {
      autonomousJobs.getDueJobs.mockResolvedValue([{ id: 'j1' }]);

      const response = await request(app).get('/api/cos/jobs/due');

      expect(response.status).toBe(200);
      expect(response.body.due).toHaveLength(1);
    });
  });

  describe('GET /api/cos/jobs/intervals', () => {
    it('should return available intervals', async () => {
      const response = await request(app).get('/api/cos/jobs/intervals');

      expect(response.status).toBe(200);
      expect(response.body.intervals).toContain('daily');
    });
  });

  describe('GET /api/cos/jobs/allowed-commands', () => {
    it('should return allowed commands', async () => {
      autonomousJobs.getAllowedCommands.mockReturnValue(['git', 'npm']);

      const response = await request(app).get('/api/cos/jobs/allowed-commands');

      expect(response.status).toBe(200);
      expect(response.body.commands).toEqual(['git', 'npm']);
    });
  });

  describe('GET /api/cos/jobs/gates', () => {
    it('should return all gate results', async () => {
      getRegisteredGates.mockReturnValue(['j1']);
      checkJobGate.mockResolvedValue({ shouldRun: true, reason: 'approved' });

      const response = await request(app).get('/api/cos/jobs/gates');

      expect(response.status).toBe(200);
      expect(response.body.gates).toHaveLength(1);
      expect(response.body.gates[0].shouldRun).toBe(true);
    });
  });

  describe('POST /api/cos/jobs/:id/gate-check', () => {
    it('should check job gate', async () => {
      checkJobGate.mockResolvedValue({ shouldRun: false, reason: 'not today' });
      hasGate.mockReturnValue(true);

      const response = await request(app).post('/api/cos/jobs/j1/gate-check');

      expect(response.status).toBe(200);
      expect(response.body.hasGate).toBe(true);
      expect(response.body.shouldRun).toBe(false);
    });
  });

  describe('GET /api/cos/jobs/:id', () => {
    it('should return a single job', async () => {
      autonomousJobs.getJob.mockResolvedValue({ id: 'j1', name: 'Review' });

      const response = await request(app).get('/api/cos/jobs/j1');

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Review');
    });

    it('should return 404 if job not found', async () => {
      autonomousJobs.getJob.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/jobs/j999');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/jobs', () => {
    it('should create an agent job', async () => {
      autonomousJobs.createJob.mockResolvedValue({ id: 'j1', name: 'Review' });

      const response = await request(app)
        .post('/api/cos/jobs')
        .send({ name: 'Review', type: 'agent', promptTemplate: 'Review code' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 if name is missing', async () => {
      const response = await request(app)
        .post('/api/cos/jobs')
        .send({ type: 'agent', promptTemplate: 'test' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid job type', async () => {
      const response = await request(app)
        .post('/api/cos/jobs')
        .send({ name: 'Test', type: 'invalid' });

      expect(response.status).toBe(400);
    });

    it('should return 400 if shell job missing command', async () => {
      const response = await request(app)
        .post('/api/cos/jobs')
        .send({ name: 'Shell Job', type: 'shell' });

      expect(response.status).toBe(400);
    });

    it('should return 400 if agent job missing promptTemplate', async () => {
      const response = await request(app)
        .post('/api/cos/jobs')
        .send({ name: 'Agent Job', type: 'agent' });

      expect(response.status).toBe(400);
    });

    it('should validate cron expression', async () => {
      parseCronToNextRun.mockReturnValue(new Date());
      autonomousJobs.createJob.mockResolvedValue({ id: 'j1' });

      const response = await request(app)
        .post('/api/cos/jobs')
        .send({ name: 'Cron Job', promptTemplate: 'test', cronExpression: '0 9 * * 1' });

      expect(response.status).toBe(200);
    });

    it('should return 400 for invalid cron expression format', async () => {
      const response = await request(app)
        .post('/api/cos/jobs')
        .send({ name: 'Bad Cron', promptTemplate: 'test', cronExpression: 'invalid' });

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/cos/jobs/:id', () => {
    it('should update a job', async () => {
      autonomousJobs.updateJob.mockResolvedValue({ id: 'j1', name: 'Updated' });

      const response = await request(app)
        .put('/api/cos/jobs/j1')
        .send({ name: 'Updated' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 404 if job not found', async () => {
      autonomousJobs.updateJob.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/cos/jobs/j999')
        .send({ name: 'Fail' });

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/jobs/:id/toggle', () => {
    it('should toggle job enabled state', async () => {
      autonomousJobs.toggleJob.mockResolvedValue({ id: 'j1', enabled: false });

      const response = await request(app).post('/api/cos/jobs/j1/toggle');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 404 if job not found', async () => {
      autonomousJobs.toggleJob.mockResolvedValue(null);

      const response = await request(app).post('/api/cos/jobs/j999/toggle');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/jobs/:id/trigger', () => {
    it('should trigger a shell job', async () => {
      autonomousJobs.getJob.mockResolvedValue({ id: 'j1', type: 'shell' });
      autonomousJobs.isShellJob.mockReturnValue(true);
      autonomousJobs.executeShellJob.mockResolvedValue({ success: true, output: 'ok' });

      const response = await request(app).post('/api/cos/jobs/j1/trigger');

      expect(response.status).toBe(200);
      expect(response.body.type).toBe('shell');
    });

    it('should trigger a script job', async () => {
      autonomousJobs.getJob.mockResolvedValue({ id: 'j1', type: 'script' });
      autonomousJobs.isShellJob.mockReturnValue(false);
      autonomousJobs.isScriptJob.mockReturnValue(true);
      autonomousJobs.executeScriptJob.mockResolvedValue({ success: true });

      const response = await request(app).post('/api/cos/jobs/j1/trigger');

      expect(response.status).toBe(200);
      expect(response.body.type).toBe('script');
    });

    it('should trigger an agent job', async () => {
      autonomousJobs.getJob.mockResolvedValue({ id: 'j1', type: 'agent', name: 'Review' });
      autonomousJobs.isShellJob.mockReturnValue(false);
      autonomousJobs.isScriptJob.mockReturnValue(false);
      autonomousJobs.generateTaskFromJob.mockResolvedValue({ description: 'Review', priority: 'MEDIUM' });
      cos.addTask.mockResolvedValue({ id: 'task-1' });

      const response = await request(app).post('/api/cos/jobs/j1/trigger');

      expect(response.status).toBe(200);
      expect(response.body.type).toBe('agent');
      expect(response.body.taskId).toBe('task-1');
    });

    it('should return 404 if job not found', async () => {
      autonomousJobs.getJob.mockResolvedValue(null);

      const response = await request(app).post('/api/cos/jobs/j999/trigger');

      expect(response.status).toBe(404);
    });

    it('should handle failed agent task queuing', async () => {
      autonomousJobs.getJob.mockResolvedValue({ id: 'j1', type: 'agent', name: 'Review' });
      autonomousJobs.isShellJob.mockReturnValue(false);
      autonomousJobs.isScriptJob.mockReturnValue(false);
      autonomousJobs.generateTaskFromJob.mockResolvedValue({ description: 'Review', priority: 'MEDIUM' });
      cos.addTask.mockResolvedValue(null);

      const response = await request(app).post('/api/cos/jobs/j1/trigger');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
    });
  });

  describe('DELETE /api/cos/jobs/:id', () => {
    it('should delete a job', async () => {
      autonomousJobs.deleteJob.mockResolvedValue(true);

      const response = await request(app).delete('/api/cos/jobs/j1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 404 if job not found', async () => {
      autonomousJobs.deleteJob.mockResolvedValue(false);

      const response = await request(app).delete('/api/cos/jobs/j999');

      expect(response.status).toBe(404);
    });
  });
});
