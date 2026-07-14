import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
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
  getAgentDates: vi.fn(),
  getAgentsByDate: vi.fn(),
  getAgent: vi.fn(),
  terminateAgent: vi.fn(),
  pauseAgent: vi.fn(),
  killAgent: vi.fn(),
  getAgentProcessStats: vi.fn(),
  deleteAgent: vi.fn(),
  clearCompletedAgents: vi.fn(),
  submitAgentFeedback: vi.fn(),
  sendBtwToAgent: vi.fn(),
  getFeedbackStats: vi.fn(),
  listReports: vi.fn(),
  getTodayReport: vi.fn(),
  getReport: vi.fn(),
  generateReport: vi.fn(),
  listBriefings: vi.fn(),
  getLatestBriefing: vi.fn(),
  getBriefing: vi.fn(),
  listScripts: vi.fn(),
  getScript: vi.fn(),
  forceSpawnTask: vi.fn(),
  getTodayActivity: vi.fn(),
  getWhileAwayActivity: vi.fn(),
  getRecentTasks: vi.fn()
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

// Mock the claudeChangelog service
vi.mock('../services/claudeChangelog.js', () => ({
  checkChangelog: vi.fn(),
  getCachedChangelog: vi.fn()
}));

// Mock the taskEnhancer service
vi.mock('../services/taskEnhancer.js', () => ({
  enhanceTaskPrompt: vi.fn()
}));

// Mock the subAgentSpawner service
vi.mock('../services/subAgentSpawner.js', () => ({
  loadSlashdoCommand: vi.fn()
}));

// The `/do:next` slashdo route resolves the app's Work Tracker via
// buildClaimWorkTask + getAppById instead of inlining the raw command body.
// buildClaimWorkTask is stubbed (the slashdo tests drive it directly), but the
// real buildJiraTicketTask runs so the `/tasks/jira-ticket` route still exercises
// the extracted prompt assembly — it resolves getTaskPrompt/getCodeReviewDefaults,
// which are mocked below, so the route-level assertions stay verbatim.
vi.mock('../services/cosTaskGenerator.js', async (importActual) => ({
  ...(await importActual()),
  buildClaimWorkTask: vi.fn()
}));
vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn()
}));

// The per-ticket `/tasks/jira-ticket` route loads the claim-issue-jira prompt
// body and resolves reviewers from the Code Review Defaults.
vi.mock('../services/taskPromptService.js', () => ({
  getTaskPrompt: vi.fn()
}));
vi.mock('../services/codeReview.js', () => ({
  getCodeReviewDefaults: vi.fn()
}));

// Import mocked modules
import * as cos from '../services/cos.js';
import * as taskWatcher from '../services/taskWatcher.js';
import * as appActivity from '../services/appActivity.js';
import * as claudeChangelog from '../services/claudeChangelog.js';
import { enhanceTaskPrompt } from '../services/taskEnhancer.js';
import { loadSlashdoCommand } from '../services/subAgentSpawner.js';
import { buildClaimWorkTask } from '../services/cosTaskGenerator.js';
import { getAppById } from '../services/apps.js';
import { getTaskPrompt } from '../services/taskPromptService.js';
import { getCodeReviewDefaults } from '../services/codeReview.js';

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
        maxConcurrentAgents: 3
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

    it('should bound each source and add a pagination block when limit/offset are passed', async () => {
      const mockTasks = {
        user: {
          tasks: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
          grouped: { pending: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] },
          awaitingApproval: [{ id: 'u1' }],
          autoApproved: [{ id: 'u2' }],
          file: 'data/cos/user-tasks.md',
          exists: true,
          type: 'user'
        },
        cos: {
          tasks: [{ id: 'c1' }, { id: 'c2' }],
          grouped: { pending: [{ id: 'c1' }, { id: 'c2' }] },
          awaitingApproval: [],
          autoApproved: [],
          file: 'data/cos/cos-tasks.md',
          exists: true,
          type: 'internal'
        }
      };
      cos.getAllTasks.mockResolvedValue(mockTasks);

      const response = await request(app).get('/api/cos/tasks?limit=1&offset=1');

      expect(response.status).toBe(200);
      // Inner task arrays are windowed...
      expect(response.body.user.tasks).toEqual([{ id: 'u2' }]);
      expect(response.body.cos.tasks).toEqual([{ id: 'c2' }]);
      // ...scalar metadata is preserved...
      expect(response.body.user).toMatchObject({ file: 'data/cos/user-tasks.md', exists: true, type: 'user' });
      // ...and the full-set derived collections are dropped so the response is
      // genuinely bounded (not re-leaked through grouped/awaiting/auto-approved).
      expect(response.body.user).not.toHaveProperty('grouped');
      expect(response.body.user).not.toHaveProperty('awaitingApproval');
      expect(response.body.user).not.toHaveProperty('autoApproved');
      expect(response.body.cos).not.toHaveProperty('grouped');
      expect(response.body.pagination).toEqual({
        limit: 1,
        offset: 1,
        userTotal: 3,
        cosTotal: 2,
        total: 5
      });
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

    it('should accept multiple screenshots and attachment objects', async () => {
      const taskData = {
        description: 'Test task with images',
        screenshots: ['/data/screenshots/a.png', '/data/screenshots/b.png'],
        attachments: [
          { filename: 'a-123.png', originalName: 'photo-one.png', path: '/data/cos/attachments/a-123.png', size: 100, mimeType: 'image/png' },
          { filename: 'b-456.png', originalName: 'photo-two.png', path: '/data/cos/attachments/b-456.png', size: 200, mimeType: 'image/png' },
        ]
      };
      cos.addTask.mockResolvedValue({ id: 'task-002', ...taskData, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks')
        .send(taskData);

      expect(response.status).toBe(200);
      expect(cos.addTask).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshots: taskData.screenshots,
          attachments: taskData.attachments,
        }),
        'user'
      );
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

    it('should update an internal task in the internal queue', async () => {
      cos.updateTask.mockResolvedValue({ id: 'sys-001', model: 'gpt-5.6-terra' });

      const response = await request(app)
        .put('/api/cos/tasks/sys-001')
        .send({ model: 'gpt-5.6-terra', type: 'internal' });

      expect(response.status).toBe(200);
      expect(cos.updateTask).toHaveBeenCalledWith(
        'sys-001',
        expect.objectContaining({ model: 'gpt-5.6-terra' }),
        'internal'
      );
    });

    it('should return 404 if task not found', async () => {
      cos.updateTask.mockResolvedValue({ error: 'Task not found' });

      const response = await request(app)
        .put('/api/cos/tasks/task-999')
        .send({ status: 'completed' });

      expect(response.status).toBe(404);
    });

    it('should set blocker metadata when marking as blocked', async () => {
      cos.updateTask.mockResolvedValue({ id: 'task-001', status: 'blocked' });

      const response = await request(app)
        .put('/api/cos/tasks/task-001')
        .send({ status: 'blocked', blockedReason: 'Waiting for API access' });

      expect(response.status).toBe(200);
      expect(cos.updateTask).toHaveBeenCalledWith(
        'task-001',
        expect.objectContaining({
          status: 'blocked',
          metadata: { blocker: 'Waiting for API access' }
        }),
        'user'
      );
    });

    it('should not send metadata when changing status to pending (service handles cleanup)', async () => {
      cos.updateTask.mockResolvedValue({ id: 'task-001', status: 'pending' });

      const response = await request(app)
        .put('/api/cos/tasks/task-001')
        .send({ status: 'pending' });

      expect(response.status).toBe(200);
      const callArgs = cos.updateTask.mock.calls[0][1];
      expect(callArgs.status).toBe('pending');
      expect(callArgs.metadata).toBeUndefined();
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
    it('should return state-resident agents after cleaning zombies', async () => {
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

  describe('GET /api/cos/agents/history', () => {
    it('should return available date buckets', async () => {
      cos.getAgentDates.mockResolvedValue([
        { date: '2026-02-25', count: 5 },
        { date: '2026-02-24', count: 3 }
      ]);

      const response = await request(app).get('/api/cos/agents/history');

      expect(response.status).toBe(200);
      expect(response.body.dates).toHaveLength(2);
      expect(response.body.dates[0]).toEqual({ date: '2026-02-25', count: 5 });
    });
  });

  describe('GET /api/cos/agents/history/:date', () => {
    it('should return agents for a valid date', async () => {
      cos.getAgentsByDate.mockResolvedValue([
        { id: 'agent-001', status: 'completed' }
      ]);

      const response = await request(app).get('/api/cos/agents/history/2026-02-25');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(cos.getAgentsByDate).toHaveBeenCalledWith('2026-02-25');
    });

    it('should return 400 for invalid date format', async () => {
      const response = await request(app).get('/api/cos/agents/history/not-a-date');

      expect(response.status).toBe(400);
    });

    it('should return 400 for partial date format', async () => {
      const response = await request(app).get('/api/cos/agents/history/2026-02');

      expect(response.status).toBe(400);
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

  describe('POST /api/cos/agents/:id/pause', () => {
    it('should pause agent with reason', async () => {
      cos.pauseAgent.mockResolvedValue({ success: true, agentId: 'agent-001', pausedAt: '2026-05-25T12:00:00.000Z' });

      const response = await request(app)
        .post('/api/cos/agents/agent-001/pause')
        .send({ reason: 'billing window' });

      expect(response.status).toBe(200);
      expect(cos.pauseAgent).toHaveBeenCalledWith('agent-001', 'billing window');
    });

    it('should return 404 if agent not found', async () => {
      cos.pauseAgent.mockResolvedValue({ error: 'Agent not found or not running' });

      const response = await request(app).post('/api/cos/agents/agent-999/pause');

      expect(response.status).toBe(404);
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

  describe('POST /api/cos/tasks/:id/spawn', () => {
    it('should force-spawn a pending task', async () => {
      cos.forceSpawnTask.mockResolvedValue({ success: true, taskId: 'task-001' });

      const response = await request(app).post('/api/cos/tasks/task-001/spawn');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(cos.forceSpawnTask).toHaveBeenCalledWith('task-001');
    });

    it('should return 404 when task not found', async () => {
      cos.forceSpawnTask.mockResolvedValue({ error: 'Task not found' });

      const response = await request(app).post('/api/cos/tasks/bad-id/spawn');

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('should return 409 when task is not pending', async () => {
      cos.forceSpawnTask.mockResolvedValue({ error: 'Task is completed, not pending' });

      const response = await request(app).post('/api/cos/tasks/task-002/spawn');

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('TASK_NOT_PENDING');
    });

    it('should return 429 when no agent slots available', async () => {
      cos.forceSpawnTask.mockResolvedValue({ error: 'No available agent slots (3/3)' });

      const response = await request(app).post('/api/cos/tasks/task-003/spawn');

      expect(response.status).toBe(429);
      expect(response.body.code).toBe('NO_CAPACITY');
    });
  });

  // ============================================================
  // Task Routes — additional coverage
  // ============================================================

  describe('GET /api/cos/tasks/user', () => {
    it('should return user tasks', async () => {
      cos.getUserTasks.mockResolvedValue({ tasks: [{ id: 't1' }], grouped: {} });

      const response = await request(app).get('/api/cos/tasks/user');

      expect(response.status).toBe(200);
      expect(response.body.tasks).toHaveLength(1);
    });
  });

  describe('GET /api/cos/tasks/internal', () => {
    it('should return internal tasks', async () => {
      cos.getCosTasks.mockResolvedValue({ tasks: [], grouped: {} });

      const response = await request(app).get('/api/cos/tasks/internal');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('tasks');
    });
  });

  describe('POST /api/cos/tasks/refresh', () => {
    it('should force refresh tasks', async () => {
      taskWatcher.refreshTasks.mockResolvedValue({ user: [], cos: [] });

      const response = await request(app).post('/api/cos/tasks/refresh');

      expect(response.status).toBe(200);
      expect(taskWatcher.refreshTasks).toHaveBeenCalled();
    });
  });

  describe('POST /api/cos/tasks/enhance', () => {
    it('should enhance a task prompt', async () => {
      enhanceTaskPrompt.mockResolvedValue({ enhanced: 'Better description' });

      const response = await request(app)
        .post('/api/cos/tasks/enhance')
        .send({ description: 'Fix bug', context: 'app-001' });

      expect(response.status).toBe(200);
      expect(enhanceTaskPrompt).toHaveBeenCalledWith('Fix bug', 'app-001');
    });

    it('should return 400 if description is missing', async () => {
      const response = await request(app)
        .post('/api/cos/tasks/enhance')
        .send({});

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/cos/tasks/slashdo', () => {
    it.each([
      'push',
      'review',
      'replan',
      'release',
      'better',
      'better-swift'
    ])('should create a task from slashdo command %s', async (command) => {
      loadSlashdoCommand.mockResolvedValue('command content');
      cos.addTask.mockResolvedValue({ id: `task-sd-${command}`, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command, app: 'my-app' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(`task-sd-${command}`);
      expect(loadSlashdoCommand).toHaveBeenCalledWith(command);
    });

    it('routes /do:next through the app Work Tracker instead of the raw command', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', repoPath: '/repo' });
      buildClaimWorkTask.mockResolvedValue({
        tracker: 'github',
        source: 'config',
        promptTaskType: 'claim-issue',
        prompt: 'CLAIM ISSUE PROMPT',
        taskMetadata: { useWorktree: false, openPR: false }
      });
      cos.addTask.mockResolvedValue({ id: 'task-sd-next', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('task-sd-next');
      expect(buildClaimWorkTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'my-app' }));
      // The raw do:next body must NOT be inlined for the next command.
      expect(loadSlashdoCommand).not.toHaveBeenCalledWith('next');
      const [taskData] = cos.addTask.mock.calls.at(-1);
      expect(taskData.context).toBe('CLAIM ISSUE PROMPT');
      expect(taskData.description).toContain('GitHub Issues');
    });

    it('returns 404 when /do:next targets an unknown app', async () => {
      getAppById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'ghost-app' });

      expect(response.status).toBe(404);
      expect(buildClaimWorkTask).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid command', async () => {
      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'invalid', app: 'my-app' });

      expect(response.status).toBe(400);
    });

    it('should return 400 if app is missing', async () => {
      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'push' });

      expect(response.status).toBe(400);
    });

    it('should return 409 for duplicate task', async () => {
      loadSlashdoCommand.mockResolvedValue('command content');
      cos.addTask.mockResolvedValue({ duplicate: true, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'push', app: 'my-app' });

      expect(response.status).toBe(409);
    });
  });

  describe('POST /api/cos/tasks/jira-ticket', () => {
    const jiraApp = { id: 'my-app', name: 'MyApp', repoPath: '/repo', jira: { enabled: true } };
    // Template carrying every placeholder the route substitutes.
    const TEMPLATE = 'Work {appName} at {repoPath} (app {appId}); reviewers: {reviewers}.';

    it('queues a claim task pinned to the selected ticket', async () => {
      getAppById.mockResolvedValue(jiraApp);
      getTaskPrompt.mockResolvedValue(TEMPLATE);
      getCodeReviewDefaults.mockResolvedValue({ reviewers: ['claude'] });
      cos.addTask.mockResolvedValue({ id: 'task-jira-1', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'my-app', ticketKey: 'PROJ-123' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('task-jira-1');
      expect(getTaskPrompt).toHaveBeenCalledWith('claim-issue-jira');

      const [taskData, taskType] = cos.addTask.mock.calls.at(-1);
      expect(taskType).toBe('user');
      // Placeholders substituted, ticket constraint appended.
      expect(taskData.context).toContain('Work MyApp at /repo (app my-app); reviewers: claude.');
      expect(taskData.context).not.toMatch(/\{appName\}|\{repoPath\}|\{appId\}|\{reviewers\}/);
      expect(taskData.context).toContain('Target Ticket Constraint');
      expect(taskData.context).toContain('PROJ-123');
      expect(taskData.description).toContain('PROJ-123');
      // claim-issue-jira self-manages its worktree + PR.
      expect(taskData.useWorktree).toBe(false);
      expect(taskData.openPR).toBe(false);
    });

    it('uppercases the ticket key', async () => {
      getAppById.mockResolvedValue(jiraApp);
      getTaskPrompt.mockResolvedValue(TEMPLATE);
      getCodeReviewDefaults.mockResolvedValue(null);
      cos.addTask.mockResolvedValue({ id: 'task-jira-2', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'my-app', ticketKey: 'proj-7' });

      expect(response.status).toBe(200);
      const [taskData] = cos.addTask.mock.calls.at(-1);
      expect(taskData.description).toContain('PROJ-7');
      expect(taskData.context).toContain('PROJ-7');
    });

    it('returns 404 for an unknown app', async () => {
      getAppById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'ghost', ticketKey: 'PROJ-1' });

      expect(response.status).toBe(404);
      expect(cos.addTask).not.toHaveBeenCalled();
    });

    it('returns 400 when JIRA is not enabled for the app', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', repoPath: '/repo', jira: { enabled: false } });

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'my-app', ticketKey: 'PROJ-1' });

      expect(response.status).toBe(400);
      expect(cos.addTask).not.toHaveBeenCalled();
    });

    it('returns 400 for a malformed ticket key', async () => {
      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'my-app', ticketKey: 'not-a-key' });

      expect(response.status).toBe(400);
      expect(getAppById).not.toHaveBeenCalled();
    });

    it('returns 409 for a duplicate task', async () => {
      getAppById.mockResolvedValue(jiraApp);
      getTaskPrompt.mockResolvedValue(TEMPLATE);
      getCodeReviewDefaults.mockResolvedValue(null);
      cos.addTask.mockResolvedValue({ duplicate: true, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'my-app', ticketKey: 'PROJ-9' });

      expect(response.status).toBe(409);
    });
  });

  describe('POST /api/cos/tasks (duplicate)', () => {
    it('should return 409 for duplicate task', async () => {
      cos.addTask.mockResolvedValue({ duplicate: true, status: 'running' });

      const response = await request(app)
        .post('/api/cos/tasks')
        .send({ description: 'Duplicate task' });

      expect(response.status).toBe(409);
    });
  });

  // ============================================================
  // Agent Routes — additional coverage
  // ============================================================

  describe('DELETE /api/cos/agents/completed', () => {
    it('should clear completed agents', async () => {
      cos.clearCompletedAgents.mockResolvedValue({ cleared: 3 });

      const response = await request(app).delete('/api/cos/agents/completed');

      expect(response.status).toBe(200);
      expect(response.body.cleared).toBe(3);
    });
  });

  describe('POST /api/cos/agents/:id/feedback', () => {
    it('should submit positive feedback', async () => {
      cos.submitAgentFeedback.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/cos/agents/agent-001/feedback')
        .send({ rating: 'positive', comment: 'Great work' });

      expect(response.status).toBe(200);
      expect(cos.submitAgentFeedback).toHaveBeenCalledWith('agent-001', { rating: 'positive', comment: 'Great work' });
    });

    it('should return 400 for invalid rating', async () => {
      const response = await request(app)
        .post('/api/cos/agents/agent-001/feedback')
        .send({ rating: 'invalid' });

      expect(response.status).toBe(400);
    });

    it('should return 404 if agent not found', async () => {
      cos.submitAgentFeedback.mockResolvedValue({ error: 'Agent not found' });

      const response = await request(app)
        .post('/api/cos/agents/agent-999/feedback')
        .send({ rating: 'negative' });

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/agents/:id/btw', () => {
    it('should send btw message to agent', async () => {
      cos.sendBtwToAgent.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/cos/agents/agent-001/btw')
        .send({ message: 'Additional context here' });

      expect(response.status).toBe(200);
      expect(cos.sendBtwToAgent).toHaveBeenCalledWith('agent-001', 'Additional context here');
    });

    it('should return 400 for empty message', async () => {
      const response = await request(app)
        .post('/api/cos/agents/agent-001/btw')
        .send({ message: '' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for missing message', async () => {
      const response = await request(app)
        .post('/api/cos/agents/agent-001/btw')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 400 for message over 5000 chars', async () => {
      const response = await request(app)
        .post('/api/cos/agents/agent-001/btw')
        .send({ message: 'x'.repeat(5001) });

      expect(response.status).toBe(400);
    });

    it('should return 404 if agent not found', async () => {
      cos.sendBtwToAgent.mockResolvedValue({ error: 'Agent not found' });

      const response = await request(app)
        .post('/api/cos/agents/agent-999/btw')
        .send({ message: 'hello' });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/feedback/stats', () => {
    it('should return feedback statistics', async () => {
      cos.getFeedbackStats.mockResolvedValue({ total: 10, positive: 7, negative: 2, neutral: 1 });

      const response = await request(app).get('/api/cos/feedback/stats');

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(10);
    });
  });

  // ============================================================
  // Report Routes — additional coverage
  // ============================================================

  describe('POST /api/cos/reports/generate', () => {
    it('should generate a report', async () => {
      cos.generateReport.mockResolvedValue({ date: '2026-02-25', summary: {} });

      const response = await request(app)
        .post('/api/cos/reports/generate')
        .send({ date: '2026-02-25' });

      expect(response.status).toBe(200);
      expect(cos.generateReport).toHaveBeenCalledWith('2026-02-25');
    });
  });

  describe('GET /api/cos/briefings', () => {
    it('should list all briefings', async () => {
      cos.listBriefings.mockResolvedValue(['2026-02-25', '2026-02-24']);

      const response = await request(app).get('/api/cos/briefings');

      expect(response.status).toBe(200);
      expect(response.body.briefings).toHaveLength(2);
    });
  });

  describe('GET /api/cos/briefings/latest', () => {
    it('should return latest briefing', async () => {
      cos.getLatestBriefing.mockResolvedValue({ date: '2026-02-25', content: 'Latest' });

      const response = await request(app).get('/api/cos/briefings/latest');

      expect(response.status).toBe(200);
      expect(response.body.date).toBe('2026-02-25');
    });
  });

  describe('GET /api/cos/briefings/:date', () => {
    it('should return briefing by date', async () => {
      cos.getBriefing.mockResolvedValue({ date: '2026-02-24', content: 'Briefing' });

      const response = await request(app).get('/api/cos/briefings/2026-02-24');

      expect(response.status).toBe(200);
    });

    it('should return 404 if briefing not found', async () => {
      cos.getBriefing.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/briefings/1999-01-01');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/claude-changelog', () => {
    it('should return changelog', async () => {
      claudeChangelog.checkChangelog.mockResolvedValue({ entries: [], lastChecked: Date.now() });

      const response = await request(app).get('/api/cos/claude-changelog');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('entries');
    });
  });

  describe('GET /api/cos/claude-changelog/cached', () => {
    it('should return cached changelog', async () => {
      claudeChangelog.getCachedChangelog.mockResolvedValue({ entries: [], cached: true });

      const response = await request(app).get('/api/cos/claude-changelog/cached');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/cos/scripts', () => {
    it('should list scripts', async () => {
      cos.listScripts.mockResolvedValue([{ name: 'backup.sh' }]);

      const response = await request(app).get('/api/cos/scripts');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });
  });

  describe('GET /api/cos/scripts/:name', () => {
    it('should return script content', async () => {
      cos.getScript.mockResolvedValue({ name: 'backup.sh', content: '#!/bin/bash' });

      const response = await request(app).get('/api/cos/scripts/backup.sh');

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('backup.sh');
    });

    it('should return 404 if script not found', async () => {
      cos.getScript.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/scripts/missing.sh');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/activity/today', () => {
    it('should return today activity summary', async () => {
      cos.getTodayActivity.mockResolvedValue({ stats: { completed: 5 } });

      const response = await request(app).get('/api/cos/activity/today');

      expect(response.status).toBe(200);
      expect(response.body.stats.completed).toBe(5);
    });
  });

  describe('GET /api/cos/activity/while-away', () => {
    it('passes a valid ISO since through to the service', async () => {
      cos.getWhileAwayActivity.mockResolvedValue({ stats: { completed: 3 } });
      const since = '2026-06-01T00:00:00.000Z';

      const response = await request(app).get(`/api/cos/activity/while-away?since=${encodeURIComponent(since)}`);

      expect(response.status).toBe(200);
      expect(response.body.stats.completed).toBe(3);
      expect(cos.getWhileAwayActivity).toHaveBeenCalledWith(since);
    });

    it('tolerates a garbage since (200 + service fallback, not 400)', async () => {
      cos.getWhileAwayActivity.mockResolvedValue({ stats: { completed: 0 } });

      const response = await request(app).get('/api/cos/activity/while-away?since=not-a-date');

      expect(response.status).toBe(200);
      // Malformed value is dropped to undefined so the service applies its
      // own 24h fallback rather than the route 400-ing the dashboard card.
      expect(cos.getWhileAwayActivity).toHaveBeenCalledWith(undefined);
    });

    it('works with no since param', async () => {
      cos.getWhileAwayActivity.mockResolvedValue({ stats: { completed: 1 } });

      const response = await request(app).get('/api/cos/activity/while-away');

      expect(response.status).toBe(200);
      expect(cos.getWhileAwayActivity).toHaveBeenCalledWith(undefined);
    });
  });
});
