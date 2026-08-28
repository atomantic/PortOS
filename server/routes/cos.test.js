import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { ServerError } from '../lib/errorHandler.js';
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

// Lifecycle transitions moved off `cos.js` onto the agentOrchestrator facade (#3450).
vi.mock('../services/agentOrchestrator.js', () => ({
  requestAgentTermination: vi.fn(),
  pauseAgent: vi.fn(),
  resumeAgent: vi.fn(),
  killAgent: vi.fn(),
  getAgentProcessStats: vi.fn()
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
  getAppById: vi.fn(),
  getAppWorkTracker: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
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
import * as agentOrchestrator from '../services/agentOrchestrator.js';
import * as taskWatcher from '../services/taskWatcher.js';
import * as appActivity from '../services/appActivity.js';
import * as claudeChangelog from '../services/claudeChangelog.js';
import { enhanceTaskPrompt } from '../services/taskEnhancer.js';
import { loadSlashdoCommand } from '../services/subAgentSpawner.js';
import { buildClaimWorkTask } from '../services/cosTaskGenerator.js';
import { getAppById, getAppWorkTracker } from '../services/apps.js';
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

    it('accepts the investigation auto-approval setting', async () => {
      const updates = { autoApproveInvestigations: true };
      cos.updateConfig.mockResolvedValue(updates);

      const response = await request(app)
        .put('/api/cos/config')
        .send(updates);

      expect(response.status).toBe(200);
      expect(cos.updateConfig).toHaveBeenCalledWith(updates);
    });

    it('validates the persistent mind wake cadence', async () => {
      const updates = { persistentMindProfile: { wakeIntervalMinutes: 60 } };
      cos.updateConfig.mockResolvedValue(updates);

      const accepted = await request(app).put('/api/cos/config').send(updates);
      const rejected = await request(app).put('/api/cos/config').send({
        persistentMindProfile: { wakeIntervalMinutes: 4 },
      });

      expect(accepted.status).toBe(200);
      expect(cos.updateConfig).toHaveBeenCalledWith(updates);
      expect(rejected.status).toBe(400);
    });

    it.each([
      ['autonomyLevel', 'manager'],
      ['comprehensiveAppImprovement', true],
      ['immediateExecution', true],
    ])('accepts but ignores the retired %s config field for older clients', async (field, value) => {
      cos.updateConfig.mockResolvedValue({ maxConcurrentAgents: 5 });
      const response = await request(app)
        .put('/api/cos/config')
        .send({ [field]: value, maxConcurrentAgents: 5 });

      expect(response.status).toBe(200);
      expect(cos.updateConfig).toHaveBeenCalledWith({ maxConcurrentAgents: 5 });
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
    it('should return state-resident agents without waiting for zombie cleanup', async () => {
      let releaseCleanup;
      cos.cleanupZombieAgents.mockReturnValue(new Promise((resolve) => { releaseCleanup = resolve; }));
      cos.getAgents.mockResolvedValue([
        { id: 'agent-001', status: 'running' },
        { id: 'agent-002', status: 'completed' }
      ]);

      const response = await request(app).get('/api/cos/agents');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(cos.cleanupZombieAgents).toHaveBeenCalled();
      releaseCleanup({ cleaned: [], count: 0 });
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
      agentOrchestrator.requestAgentTermination.mockResolvedValue({ success: true, agentId: 'agent-001' });

      const response = await request(app).post('/api/cos/agents/agent-001/terminate');

      expect(response.status).toBe(200);
      expect(agentOrchestrator.requestAgentTermination).toHaveBeenCalledWith('agent-001');
    });
  });

  describe('POST /api/cos/agents/:id/pause', () => {
    it('should pause agent with reason', async () => {
      agentOrchestrator.pauseAgent.mockResolvedValue({ success: true, agentId: 'agent-001', pausedAt: '2026-05-25T12:00:00.000Z' });

      const response = await request(app)
        .post('/api/cos/agents/agent-001/pause')
        .send({ reason: 'billing window' });

      expect(response.status).toBe(200);
      expect(agentOrchestrator.pauseAgent).toHaveBeenCalledWith('agent-001', 'billing window');
    });

    it('should return 404 if agent not found', async () => {
      agentOrchestrator.pauseAgent.mockRejectedValue(
        new ServerError('Agent not found or not running', { status: 404, code: 'NOT_FOUND' }),
      );

      const response = await request(app).post('/api/cos/agents/agent-999/pause');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/agents/:id/resume', () => {
    it('forwards the dialog overrides to resumeAgent', async () => {
      agentOrchestrator.resumeAgent.mockResolvedValue({ success: true, agentId: 'agent-001', taskId: 'task-abc', mode: 'requeued' });

      const response = await request(app)
        .post('/api/cos/agents/agent-001/resume')
        .send({ context: 'try the other approach', provider: 'claude', effort: 'high' });

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('requeued');
      expect(agentOrchestrator.resumeAgent).toHaveBeenCalledWith(
        'agent-001',
        expect.objectContaining({ context: 'try the other approach', provider: 'claude', effort: 'high' }),
      );
    });

    it('accepts an empty body — an untouched dialog resumes exactly as paused', async () => {
      agentOrchestrator.resumeAgent.mockResolvedValue({ success: true, agentId: 'agent-001', taskId: 'task-abc', mode: 'requeued' });

      const response = await request(app).post('/api/cos/agents/agent-001/resume');

      expect(response.status).toBe(200);
      expect(agentOrchestrator.resumeAgent).toHaveBeenCalledWith('agent-001', {});
    });

    it('returns 409 when the agent is not paused', async () => {
      agentOrchestrator.resumeAgent.mockRejectedValue(
        new ServerError('Agent agent-001 is running, not paused', { status: 409, code: 'AGENT_NOT_PAUSED' }),
      );

      const response = await request(app).post('/api/cos/agents/agent-001/resume');

      expect(response.status).toBe(409);
    });

    it('rejects a malformed effort rather than passing it to the resumed run', async () => {
      const response = await request(app)
        .post('/api/cos/agents/agent-001/resume')
        .send({ effort: 'turbo' });

      expect(response.status).toBe(400);
      expect(agentOrchestrator.resumeAgent).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/cos/agents/:id/kill', () => {
    it('should force kill agent', async () => {
      agentOrchestrator.killAgent.mockResolvedValue({ success: true, agentId: 'agent-001', signal: 'SIGKILL' });

      const response = await request(app).post('/api/cos/agents/agent-001/kill');

      expect(response.status).toBe(200);
      expect(agentOrchestrator.killAgent).toHaveBeenCalledWith('agent-001');
    });

    it('should return 404 if agent not found', async () => {
      agentOrchestrator.killAgent.mockRejectedValue(
        new ServerError('Agent not found or not running', { status: 404, code: 'NOT_FOUND' }),
      );

      const response = await request(app).post('/api/cos/agents/agent-999/kill');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/agents/:id/stats', () => {
    it('should return agent process stats', async () => {
      agentOrchestrator.getAgentProcessStats.mockResolvedValue({
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
      agentOrchestrator.getAgentProcessStats.mockResolvedValue(null);

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
      cos.deleteAgent.mockRejectedValue(new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' }));

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

    it('should reject malformed dates before reading the report', async () => {
      const response = await request(app).get('/api/cos/reports/not-a-date');

      expect(response.status).toBe(400);
      expect(cos.getReport).not.toHaveBeenCalled();
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
    // The catalog's full launchable set (#3114) — `push`/`better-swift` used to
    // exist only in this route's registry and `plan-task`/`depfree`/`scan` only in
    // the quick templates; both surfaces now read one list.
    it.each([
      'plan-task',
      'push',
      'review',
      'replan',
      'release',
      'better',
      'depfree',
      'scan'
    ])('should create a task from slashdo command %s', async (command) => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', type: 'web', repoPath: '/repo' });
      cos.addTask.mockResolvedValue({ id: `task-sd-${command}`, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command, app: 'my-app' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(`task-sd-${command}`);
      // The route persists the BARE command and lets the prompt builder render
      // the invocation + inline the body once the provider is known — it no
      // longer eagerly loads the body or hardcodes `/do:` into the description
      // (both assumed a Claude host that can type slash commands).
      const [taskData] = cos.addTask.mock.calls.at(-1);
      expect(taskData.slashdoCommand).toBe(command);
      expect(taskData.context).toBeUndefined();
      expect(taskData.description).not.toContain('/do:');
      // The app's display NAME, not its id slug — matching the `next` branch.
      expect(taskData.description).toContain('MyApp');
      expect(loadSlashdoCommand).not.toHaveBeenCalled();
    });

    it('rejects plan-task for an app whose tracker cannot file forge issues', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', type: 'web', repoPath: '/repo' });
      getAppWorkTracker.mockResolvedValueOnce({ resolved: 'jira' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'plan-task', app: 'my-app' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('UNSUPPORTED_PLAN_ONLY_TRACKER');
      expect(cos.addTask).not.toHaveBeenCalled();
    });

    // #3636: the catalog posture's `worktreeChangesExpected` must reach the task,
    // or the TUI idle reaper scores a report-shaped run's clean tree as
    // `idle-no-changes` — exactly the failure the commit-probe widening left
    // behind for plan-task / replan / review / scan.
    it.each([
      ['plan-task', false],
      ['replan', false],
      ['review', false],
      ['scan', false],
      ['push', true],
      ['release', true],
      ['better', true],
      ['depfree', true]
    ])('threads the catalog deliverable posture — %s ⇒ worktreeChangesExpected %s', async (command, expected) => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', type: 'web', repoPath: '/repo' });
      cos.addTask.mockResolvedValue({ id: `task-wce-${command}`, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command, app: 'my-app' });

      expect(response.status).toBe(200);
      expect(cos.addTask.mock.calls.at(-1)[0].worktreeChangesExpected).toBe(expected);
    });

    it('queues the SwiftUI audit for a Swift app', async () => {
      getAppById.mockResolvedValue({ id: 'my-ios', name: 'MyPhone', type: 'ios-native', repoPath: '/repo' });
      cos.addTask.mockResolvedValue({ id: 'task-sd-swift', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'better-swift', app: 'my-ios' });

      expect(response.status).toBe(200);
      expect(cos.addTask.mock.calls.at(-1)[0].slashdoCommand).toBe('better-swift');
    });

    // The panel only offers the applicable one of better / better-swift, but the
    // API must not trust that — a mismatched audit burns an agent run on a
    // workflow that can't apply to the app's stack.
    it.each([
      ['better-swift', 'web'],
      ['better', 'ios-native']
    ])('rejects %s against an app of type %s', async (command, type) => {
      getAppById.mockResolvedValue({ id: 'a', name: 'App', type, repoPath: '/repo' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command, app: 'a' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('WORKFLOW_APP_TYPE_MISMATCH');
      expect(cos.addTask).not.toHaveBeenCalled();
    });

    it('404s an unknown app for every command, not just next', async () => {
      getAppById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'push', app: 'ghost-app' });

      expect(response.status).toBe(404);
      expect(cos.addTask).not.toHaveBeenCalled();
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
      expect(buildClaimWorkTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'my-app' }), expect.any(Object));
      // The raw do:next body must NOT be inlined for the next command.
      expect(loadSlashdoCommand).not.toHaveBeenCalledWith('next');
      const [taskData] = cos.addTask.mock.calls.at(-1);
      // The claim body is the agent PROMPT, not the one-line human note (#4153).
      expect(taskData.prompt).toBe('CLAIM ISSUE PROMPT');
      expect(taskData.context).toBeUndefined();
      expect(taskData.description).toContain('GitHub Issues');
      // `next` is the one genuinely special command: its claim prompt IS the
      // task prompt, so it must NOT also carry a slashdoCommand (which would make the
      // prompt builder append the whole /do:next body on top of the claim prompt).
      expect(taskData.slashdoCommand).toBeUndefined();
      expect(taskData.description).not.toContain('/do:');
      expect(taskData.claimFlow).toBe(true);
    });

    // The claim prompt names its reviewers as prose and emits no flag, so the
    // ONLY way a later consumer (the prompt builder's reviewer pin) can know who
    // the prompt named is the task record. #4770: the resolved bundle rides out
    // of buildClaimWorkTask on taskMetadata and must reach addTask intact.
    it('persists the reviewer bundle the claim prompt resolved onto the task', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', repoPath: '/repo' });
      buildClaimWorkTask.mockResolvedValue({
        tracker: 'github',
        source: 'config',
        promptTaskType: 'claim-issue',
        prompt: 'CLAIM ISSUE PROMPT',
        taskMetadata: {
          useWorktree: false,
          openPR: false,
          claimFlow: true,
          reviewers: ['codex', 'claude'],
          usernames: ['alice'],
          optionalReviewers: [],
          reviewerMaxRounds: { codex: 2 },
          reviewerModels: {},
          reviewerEfforts: { codex: 'high' },
          swarmCount: 6
        }
      });
      cos.addTask.mockResolvedValue({ id: 'task-sd-next-reviewers', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app' });

      expect(response.status).toBe(200);
      const [taskData] = cos.addTask.mock.calls.at(-1);
      expect(taskData).toMatchObject({
        reviewers: ['codex', 'claude'],
        usernames: ['alice'],
        optionalReviewers: [],
        reviewerMaxRounds: { codex: 2 },
        reviewerModels: {},
        reviewerEfforts: { codex: 'high' },
        swarmCount: 6,
        claimFlow: true
      });
      // `reviewLoop` stays off — the claim prompt owns its own review sequence.
      expect(taskData.reviewLoop).toBe(false);
    });

    // `next` is commit-shaped in the catalog, but the claim flow resolves the
    // app's actual work tracker — a forge tracker files its outcome outside the
    // repo, so its `worktreeChangesExpected` must override the catalog default
    // rather than be masked by it (#3636).
    it('lets the claim flow work-tracker posture override the catalog default for next', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', repoPath: '/repo' });
      buildClaimWorkTask.mockResolvedValue({
        tracker: 'github',
        source: 'config',
        promptTaskType: 'claim-issue',
        prompt: 'CLAIM ISSUE PROMPT',
        taskMetadata: { useWorktree: false, openPR: false, worktreeChangesExpected: false }
      });
      cos.addTask.mockResolvedValue({ id: 'task-sd-next-wce', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app' });

      expect(response.status).toBe(200);
      expect(cos.addTask.mock.calls.at(-1)[0].worktreeChangesExpected).toBe(false);
    });

    // …and when the claim flow says nothing, the catalog's commit-shaped default
    // stands, so a `/do:next` that shipped a PR still needs its commit evidence.
    it('falls back to the catalog commit-shaped default when the claim flow omits the key', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', repoPath: '/repo' });
      buildClaimWorkTask.mockResolvedValue({
        tracker: 'plan',
        source: 'config',
        promptTaskType: 'claim-work',
        prompt: 'CLAIM PLAN PROMPT',
        taskMetadata: { useWorktree: false, openPR: false }
      });
      cos.addTask.mockResolvedValue({ id: 'task-sd-next-default', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app' });

      expect(response.status).toBe(200);
      expect(cos.addTask.mock.calls.at(-1)[0].worktreeChangesExpected).toBe(true);
    });

    it('threads the run drawer settings — target/author-filter/reviewers into the claim prompt, provider/model/effort/simplify onto the task', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', repoPath: '/repo' });
      buildClaimWorkTask.mockResolvedValue({
        tracker: 'github',
        source: 'config',
        promptTaskType: 'claim-issue',
        prompt: 'CLAIM ISSUE PROMPT',
        taskMetadata: { useWorktree: false, openPR: false },
        target: '412'
      });
      cos.addTask.mockResolvedValue({ id: 'task-sd-target', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({
          command: 'next', app: 'my-app', target: '#412', issueAuthorFilter: 'any',
          issueContext: {
            number: 412,
            title: 'Add telemetry',
            body: 'Capture the request timing in the health endpoint.',
            url: 'https://github.com/acme/widget/issues/412'
          },
          overrideContext: 'Prefer the smallest safe fix and include a regression test.',
          reviewers: ['claude', 'codex'], usernames: ['alice'], optionalReviewers: ['codex'],
          reviewerMaxRounds: { codex: 2, ollama: 1 },
          provider: 'claude-cli', model: 'claude-opus-5', effort: 'high', simplify: true
        });

      expect(response.status).toBe(200);
      expect(buildClaimWorkTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'my-app' }),
        {
          target: '#412',
          issueContext: {
            number: 412,
            title: 'Add telemetry',
            body: 'Capture the request timing in the health endpoint.',
            url: 'https://github.com/acme/widget/issues/412'
          },
          overrideContext: 'Prefer the smallest safe fix and include a regression test.',
          issueAuthorFilter: 'any',
          reviewers: ['claude', 'codex'],
          usernames: ['alice'],
          optionalReviewers: ['codex'],
          // Per-reviewer `~max=<n>` caps ride along; `ollama` isn't in the list
          // but stays in the map (the emitter only marks tokens it emits).
          reviewerMaxRounds: { codex: 2, ollama: 1 }
        }
      );
      const [taskData] = cos.addTask.mock.calls.at(-1);
      expect(taskData.provider).toBe('claude-cli');
      expect(taskData.model).toBe('claude-opus-5');
      expect(taskData.effort).toBe('high');
      expect(taskData.claimTarget).toBe('412');
      expect(taskData.simplify).toBe(true);
      // The claim prompt owns its own review sequence — no CoS loop on top.
      expect(taskData.reviewLoop).toBe(false);
      // The pinned item shows in the queue description so the row is self-explaining.
      expect(taskData.description).toContain('412');
    });

    it('rejects an out-of-vocabulary issueAuthorFilter', async () => {
      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app', issueAuthorFilter: 'everyone' });

      expect(response.status).toBe(400);
      expect(buildClaimWorkTask).not.toHaveBeenCalled();
    });

    it('rejects an oversized prefetched issue body at the route boundary', async () => {
      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({
          command: 'next',
          app: 'my-app',
          target: '412',
          issueContext: { number: 412, body: 'x'.repeat(12_001) }
        });

      expect(response.status).toBe(400);
      expect(buildClaimWorkTask).not.toHaveBeenCalled();
    });

    it('rejects oversized claim override context at the route boundary', async () => {
      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app', overrideContext: 'x'.repeat(4_001) });

      expect(response.status).toBe(400);
      expect(buildClaimWorkTask).not.toHaveBeenCalled();
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
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', type: 'web', repoPath: '/repo' });
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
      expect(taskData.prompt).toContain('Work MyApp at /repo (app my-app); reviewers: claude.');
      expect(taskData.prompt).not.toMatch(/\{appName\}|\{repoPath\}|\{appId\}|\{reviewers\}/);
      expect(taskData.prompt).toContain('Target Ticket Constraint');
      expect(taskData.prompt).toContain('PROJ-123');
      expect(taskData.description).toContain('PROJ-123');
      // claim-issue-jira self-manages its worktree + PR.
      expect(taskData.useWorktree).toBe(false);
      expect(taskData.openPR).toBe(false);
      expect(taskData.claimFlow).toBe(true);
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
      expect(taskData.prompt).toContain('PROJ-7');
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
      cos.submitAgentFeedback.mockRejectedValue(new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' }));

      const response = await request(app)
        .post('/api/cos/agents/agent-999/feedback')
        .send({ rating: 'negative' });

      expect(response.status).toBe(404);
    });

    it('should return 400 (INVALID_STATE) when the agent is not completed', async () => {
      cos.submitAgentFeedback.mockRejectedValue(new ServerError('Can only submit feedback for completed agents', { status: 400, code: 'INVALID_STATE' }));

      const response = await request(app)
        .post('/api/cos/agents/agent-001/feedback')
        .send({ rating: 'positive' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_STATE');
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
      cos.sendBtwToAgent.mockRejectedValue(new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' }));

      const response = await request(app)
        .post('/api/cos/agents/agent-999/btw')
        .send({ message: 'hello' });

      expect(response.status).toBe(404);
    });

    it('should return 400 (INVALID_STATE) when BTW is unsupported for the agent', async () => {
      cos.sendBtwToAgent.mockRejectedValue(new ServerError('Agent is not running', { status: 400, code: 'INVALID_STATE' }));

      const response = await request(app)
        .post('/api/cos/agents/agent-001/btw')
        .send({ message: 'hello' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_STATE');
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

    it('should reject a date that is not a bare YYYY-MM-DD day', async () => {
      // A full ISO timestamp matches no date bucket and no completedAt prefix,
      // so it would write an all-zero report under an unreadable filename.
      const response = await request(app)
        .post('/api/cos/reports/generate')
        .send({ date: '2026-02-25T00:00:00.000Z' });

      expect(response.status).toBe(400);
      expect(cos.generateReport).not.toHaveBeenCalled();
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

    it('should reject malformed dates before reading the briefing', async () => {
      const response = await request(app).get('/api/cos/briefings/not-a-date');

      expect(response.status).toBe(400);
      expect(cos.getBriefing).not.toHaveBeenCalled();
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
