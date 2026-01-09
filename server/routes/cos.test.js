import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cosRoutes from './cos.js';

// Mock the cos service
vi.mock('../services/cos.js', () => ({
  getStatus: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getAllTasks: vi.fn(),
  getUserTasks: vi.fn(),
  getCosTasks: vi.fn(),
  reorderTasks: vi.fn(),
  addTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  approveTask: vi.fn(),
  evaluateTasks: vi.fn(),
  getHealthStatus: vi.fn(),
  runHealthCheck: vi.fn(),
  cleanupZombieAgents: vi.fn(),
  getAgents: vi.fn(),
  getAgent: vi.fn(),
  terminateAgent: vi.fn(),
  killAgent: vi.fn(),
  getAgentProcessStats: vi.fn(),
  deleteAgent: vi.fn(),
  clearCompletedAgents: vi.fn(),
  listReports: vi.fn(),
  getTodayReport: vi.fn(),
  getReport: vi.fn(),
  generateReport: vi.fn(),
  listScripts: vi.fn(),
  getScript: vi.fn()
}));

// Mock the taskWatcher service
vi.mock('../services/taskWatcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  refreshTasks: vi.fn(),
  getWatcherStatus: vi.fn()
}));

// Mock the appActivity service
vi.mock('../services/appActivity.js', () => ({
  loadAppActivity: vi.fn(),
  getAppActivityById: vi.fn(),
  clearAppCooldown: vi.fn()
}));

// Import mocked modules
import * as cos from '../services/cos.js';
import * as taskWatcher from '../services/taskWatcher.js';
import * as appActivity from '../services/appActivity.js';

describe('CoS Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cos', cosRoutes);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('GET /api/cos', () => {
    it('should return CoS status', async () => {
      const mockStatus = {
        running: true,
        paused: false,
        activeAgents: 2,
        config: {},
        stats: {}
      };
      cos.getStatus.mockResolvedValue(mockStatus);

      const response = await request(app).get('/api/cos');

      expect(response.status).toBe(200);
      expect(response.body.running).toBe(true);
      expect(response.body.activeAgents).toBe(2);
    });
  });

  describe('POST /api/cos/start', () => {
    it('should start CoS daemon', async () => {
      cos.start.mockResolvedValue({ success: true });
      taskWatcher.startWatching.mockResolvedValue();

      const response = await request(app).post('/api/cos/start');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(cos.start).toHaveBeenCalled();
      expect(taskWatcher.startWatching).toHaveBeenCalled();
    });
  });

  describe('POST /api/cos/stop', () => {
    it('should stop CoS daemon', async () => {
      cos.stop.mockResolvedValue({ success: true });
      taskWatcher.stopWatching.mockResolvedValue();

      const response = await request(app).post('/api/cos/stop');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(cos.stop).toHaveBeenCalled();
      expect(taskWatcher.stopWatching).toHaveBeenCalled();
    });
  });

  describe('POST /api/cos/pause', () => {
    it('should pause CoS daemon with reason', async () => {
      cos.pause.mockResolvedValue({ success: true, pausedAt: '2024-01-15T10:00:00Z' });

      const response = await request(app)
        .post('/api/cos/pause')
        .send({ reason: 'User requested pause' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(cos.pause).toHaveBeenCalledWith('User requested pause');
    });
  });

  describe('POST /api/cos/resume', () => {
    it('should resume CoS daemon', async () => {
      cos.resume.mockResolvedValue({ success: true });

      const response = await request(app).post('/api/cos/resume');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/cos/config', () => {
    it('should return configuration', async () => {
      const mockConfig = {
        maxConcurrentAgents: 3,
        evaluationIntervalMs: 60000
      };
      cos.getConfig.mockResolvedValue(mockConfig);

      const response = await request(app).get('/api/cos/config');

      expect(response.status).toBe(200);
      expect(response.body.maxConcurrentAgents).toBe(3);
    });
  });

  describe('PUT /api/cos/config', () => {
    it('should update configuration', async () => {
      const updates = { maxConcurrentAgents: 5 };
      cos.updateConfig.mockResolvedValue({ ...updates });

      const response = await request(app)
        .put('/api/cos/config')
        .send(updates);

      expect(response.status).toBe(200);
      expect(cos.updateConfig).toHaveBeenCalledWith(updates);
    });
  });

  describe('GET /api/cos/tasks', () => {
    it('should return all tasks', async () => {
      const mockTasks = {
        user: { tasks: [], grouped: {} },
        cos: { tasks: [], grouped: {} }
      };
      cos.getAllTasks.mockResolvedValue(mockTasks);

      const response = await request(app).get('/api/cos/tasks');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('user');
      expect(response.body).toHaveProperty('cos');
    });
  });

  describe('POST /api/cos/tasks', () => {
    it('should add a new task', async () => {
      const taskData = {
        description: 'Test task',
        priority: 'HIGH'
      };
      cos.addTask.mockResolvedValue({
        id: 'task-001',
        ...taskData,
        status: 'pending'
      });

      const response = await request(app)
        .post('/api/cos/tasks')
        .send(taskData);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('task-001');
      expect(cos.addTask).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Test task' }),
        'user'
      );
    });

    it('should return 400 if description is missing', async () => {
      const response = await request(app)
        .post('/api/cos/tasks')
        .send({ priority: 'HIGH' });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/cos/tasks/reorder', () => {
    it('should reorder tasks', async () => {
      const taskIds = ['task-002', 'task-001', 'task-003'];
      cos.reorderTasks.mockResolvedValue({ success: true, order: taskIds });

      const response = await request(app)
        .post('/api/cos/tasks/reorder')
        .send({ taskIds });

      expect(response.status).toBe(200);
      expect(cos.reorderTasks).toHaveBeenCalledWith(taskIds);
    });

    it('should return 400 if taskIds is missing', async () => {
      const response = await request(app)
        .post('/api/cos/tasks/reorder')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 400 if taskIds is not an array', async () => {
      const response = await request(app)
        .post('/api/cos/tasks/reorder')
        .send({ taskIds: 'not-an-array' });

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/cos/tasks/:id', () => {
    it('should update a task', async () => {
      const updates = { status: 'completed' };
      cos.updateTask.mockResolvedValue({ id: 'task-001', ...updates });

      const response = await request(app)
        .put('/api/cos/tasks/task-001')
        .send(updates);

      expect(response.status).toBe(200);
      expect(cos.updateTask).toHaveBeenCalledWith('task-001', expect.objectContaining({ status: 'completed' }), 'user');
    });

    it('should return 404 if task not found', async () => {
      cos.updateTask.mockResolvedValue({ error: 'Task not found' });

      const response = await request(app)
        .put('/api/cos/tasks/task-999')
        .send({ status: 'completed' });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/cos/tasks/:id', () => {
    it('should delete a task', async () => {
      cos.deleteTask.mockResolvedValue({ success: true, taskId: 'task-001' });

      const response = await request(app).delete('/api/cos/tasks/task-001');

      expect(response.status).toBe(200);
      expect(cos.deleteTask).toHaveBeenCalledWith('task-001', 'user');
    });

    it('should return 404 if task not found', async () => {
      cos.deleteTask.mockResolvedValue({ error: 'Task not found' });

      const response = await request(app).delete('/api/cos/tasks/task-999');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/tasks/:id/approve', () => {
    it('should approve a task', async () => {
      cos.approveTask.mockResolvedValue({ id: 'sys-001', autoApproved: true });

      const response = await request(app).post('/api/cos/tasks/sys-001/approve');

      expect(response.status).toBe(200);
      expect(cos.approveTask).toHaveBeenCalledWith('sys-001');
    });

    it('should return 400 if task does not require approval', async () => {
      cos.approveTask.mockResolvedValue({ error: 'Task does not require approval' });

      const response = await request(app).post('/api/cos/tasks/task-001/approve');

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/cos/evaluate', () => {
    it('should trigger task evaluation', async () => {
      cos.evaluateTasks.mockResolvedValue();

      const response = await request(app).post('/api/cos/evaluate');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(cos.evaluateTasks).toHaveBeenCalled();
    });
  });

  describe('GET /api/cos/agents', () => {
    it('should return all agents after cleaning zombies', async () => {
      cos.cleanupZombieAgents.mockResolvedValue({ cleaned: [], count: 0 });
      cos.getAgents.mockResolvedValue([
        { id: 'agent-001', status: 'running' },
        { id: 'agent-002', status: 'completed' }
      ]);

      const response = await request(app).get('/api/cos/agents');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(cos.cleanupZombieAgents).toHaveBeenCalled();
    });
  });

  describe('GET /api/cos/agents/:id', () => {
    it('should return agent by ID', async () => {
      cos.getAgent.mockResolvedValue({ id: 'agent-001', status: 'running' });

      const response = await request(app).get('/api/cos/agents/agent-001');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('agent-001');
    });

    it('should return 404 if agent not found', async () => {
      cos.getAgent.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/agents/agent-999');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/agents/:id/terminate', () => {
    it('should terminate agent', async () => {
      cos.terminateAgent.mockResolvedValue({ success: true, agentId: 'agent-001' });

      const response = await request(app).post('/api/cos/agents/agent-001/terminate');

      expect(response.status).toBe(200);
      expect(cos.terminateAgent).toHaveBeenCalledWith('agent-001');
    });
  });

  describe('POST /api/cos/agents/:id/kill', () => {
    it('should force kill agent', async () => {
      cos.killAgent.mockResolvedValue({ success: true, agentId: 'agent-001', signal: 'SIGKILL' });

      const response = await request(app).post('/api/cos/agents/agent-001/kill');

      expect(response.status).toBe(200);
      expect(cos.killAgent).toHaveBeenCalledWith('agent-001');
    });

    it('should return 404 if agent not found', async () => {
      cos.killAgent.mockResolvedValue({ error: 'Agent not found or not running' });

      const response = await request(app).post('/api/cos/agents/agent-999/kill');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/agents/:id/stats', () => {
    it('should return agent process stats', async () => {
      cos.getAgentProcessStats.mockResolvedValue({
        active: true,
        pid: 12345,
        cpu: 5.2,
        memoryMb: 128
      });

      const response = await request(app).get('/api/cos/agents/agent-001/stats');

      expect(response.status).toBe(200);
      expect(response.body.active).toBe(true);
    });

    it('should return active:false if no stats available', async () => {
      cos.getAgentProcessStats.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/agents/agent-999/stats');

      expect(response.status).toBe(200);
      expect(response.body.active).toBe(false);
    });
  });

  describe('DELETE /api/cos/agents/:id', () => {
    it('should delete an agent', async () => {
      cos.deleteAgent.mockResolvedValue({ success: true, agentId: 'agent-001' });

      const response = await request(app).delete('/api/cos/agents/agent-001');

      expect(response.status).toBe(200);
      expect(cos.deleteAgent).toHaveBeenCalledWith('agent-001');
    });

    it('should return 404 if agent not found', async () => {
      cos.deleteAgent.mockResolvedValue({ error: 'Agent not found' });

      const response = await request(app).delete('/api/cos/agents/agent-999');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/health', () => {
    it('should return health status', async () => {
      cos.getHealthStatus.mockResolvedValue({
        lastCheck: '2024-01-15T10:00:00Z',
        issues: []
      });

      const response = await request(app).get('/api/cos/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('lastCheck');
    });
  });

  describe('POST /api/cos/health/check', () => {
    it('should force health check', async () => {
      cos.runHealthCheck.mockResolvedValue({
        metrics: {},
        issues: []
      });

      const response = await request(app).post('/api/cos/health/check');

      expect(response.status).toBe(200);
      expect(cos.runHealthCheck).toHaveBeenCalled();
    });
  });

  describe('GET /api/cos/reports', () => {
    it('should list all reports', async () => {
      cos.listReports.mockResolvedValue(['2024-01-15', '2024-01-14']);

      const response = await request(app).get('/api/cos/reports');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
    });
  });

  describe('GET /api/cos/reports/today', () => {
    it('should return today report', async () => {
      cos.getTodayReport.mockResolvedValue({
        date: '2024-01-15',
        summary: { tasksCompleted: 5 }
      });

      const response = await request(app).get('/api/cos/reports/today');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('summary');
    });
  });

  describe('GET /api/cos/reports/:date', () => {
    it('should return report by date', async () => {
      cos.getReport.mockResolvedValue({
        date: '2024-01-14',
        summary: {}
      });

      const response = await request(app).get('/api/cos/reports/2024-01-14');

      expect(response.status).toBe(200);
    });

    it('should return 404 if report not found', async () => {
      cos.getReport.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/reports/1999-01-01');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/watcher', () => {
    it('should return watcher status', async () => {
      taskWatcher.getWatcherStatus.mockReturnValue({
        watching: true,
        files: ['TASKS.md']
      });

      const response = await request(app).get('/api/cos/watcher');

      expect(response.status).toBe(200);
      expect(response.body.watching).toBe(true);
    });
  });

  describe('GET /api/cos/app-activity', () => {
    it('should return app activity data', async () => {
      appActivity.loadAppActivity.mockResolvedValue({
        'app-001': { lastReview: '2024-01-15T10:00:00Z' }
      });

      const response = await request(app).get('/api/cos/app-activity');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/cos/app-activity/:appId', () => {
    it('should return activity for specific app', async () => {
      appActivity.getAppActivityById.mockResolvedValue({
        lastReview: '2024-01-15T10:00:00Z'
      });

      const response = await request(app).get('/api/cos/app-activity/app-001');

      expect(response.status).toBe(200);
      expect(response.body.appId).toBe('app-001');
    });

    it('should return message if no activity', async () => {
      appActivity.getAppActivityById.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/app-activity/app-999');

      expect(response.status).toBe(200);
      expect(response.body.activity).toBeNull();
      expect(response.body.message).toBeDefined();
    });
  });

  describe('POST /api/cos/app-activity/:appId/clear-cooldown', () => {
    it('should clear cooldown for app', async () => {
      appActivity.clearAppCooldown.mockResolvedValue({ cooldownCleared: true });

      const response = await request(app).post('/api/cos/app-activity/app-001/clear-cooldown');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(appActivity.clearAppCooldown).toHaveBeenCalledWith('app-001');
    });
  });
});
