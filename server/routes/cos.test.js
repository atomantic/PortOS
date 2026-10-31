vi.mock('../services/appIssues.js', () => ({ prepareAppIssueClaim: vi.fn() }));
import { prepareAppIssueClaim } from '../services/appIssues.js';
vi.mock('../services/providers.js', () => ({ getProviderById: vi.fn() }));
import { getProviderById } from '../services/providers.js';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { rmSync } from 'node:fs';
import { request } from '../lib/testHelper.js';
import { ServerError } from '../lib/errorHandler.js';
import { withDeliveryActivity } from '../services/agentDeliveryActivity.js';

// The CoS task routes write operator-action rows (#5594) through the ledger's
// file backend, which resolves under PATHS.data — re-root it so this suite can
// never write into the developer's live `data/` tree (#3683/#3687). Everything
// else in fileUtils stays real. `vi.hoisted` because the router below is a
// STATIC import, so the mock factory runs during module linking.
const ledgerRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'portos-cos-routes-ledger-'));
});
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const { makePathsProxy } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(actual, { dataRoot: ledgerRoot });
});
afterAll(() => rmSync(ledgerRoot, { recursive: true, force: true }));

import cosRoutes from './cos.js';

// Mock the cos service
vi.mock('../services/cos.js', () => ({
  getStatus: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  updateConfig: vi.fn(),
  listScripts: vi.fn(),
  getScript: vi.fn(),
  forceSpawnTask: vi.fn()
}));
vi.mock('../services/cosState.js', () => ({
  getConfig: vi.fn()
}));
vi.mock('../services/cosTaskStore.js', () => ({
  getAllTasks: vi.fn(),
  getTaskView: vi.fn(),
  getUserTasks: vi.fn(),
  getCosTasks: vi.fn(),
  reorderTasks: vi.fn(),
  addTask: vi.fn(),
  updateTask: vi.fn(),
  // Read by the DELETE route so the ledger row keeps the task's description.
  getTaskById: vi.fn(async () => null),
  deleteTask: vi.fn(),
  approveTask: vi.fn()
}));
vi.mock('../services/cosTaskGenerator.js', () => ({
  evaluateTasks: vi.fn()
}));
vi.mock('../services/cosHealthMonitor.js', () => ({
  getHealthStatus: vi.fn(),
  runHealthCheck: vi.fn()
}));
vi.mock('../services/cosAgentLifecycle.js', () => ({
  cleanupZombieAgents: vi.fn(),
  getAgents: vi.fn(),
  getAgent: vi.fn(),
  getAgentRecord: vi.fn(),
  deleteAgent: vi.fn(),
  sendBtwToAgent: vi.fn()
}));
vi.mock('../services/cosAgentIndex.js', () => ({
  getAgentDates: vi.fn(),
  getAgentsByDate: vi.fn(),
  getCompletedAgentPage: vi.fn()
}));
vi.mock('../services/cosAgentFeedback.js', () => ({
  getPendingAgentFeedback: vi.fn(),
  submitAgentFeedback: vi.fn(),
  getFeedbackStats: vi.fn()
}));
vi.mock('../services/cosAgentArchive.js', () => ({
  clearCompletedAgents: vi.fn()
}));
vi.mock('../services/cosReports.js', () => ({
  listReports: vi.fn(),
  getTodayReport: vi.fn(),
  getReport: vi.fn(),
  generateReport: vi.fn(),
  listBriefings: vi.fn(),
  getLatestBriefing: vi.fn(),
  getBriefing: vi.fn(),
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
vi.mock('../services/cosTaskClaimWork.js', async (importActual) => ({
  ...(await importActual()),
  buildClaimWorkTask: vi.fn(),
  buildIssueReplanTask: vi.fn()
}));
vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn(),
  getAppWorkTracker: vi.fn(),
  // buildJiraTicketTask layers the app's claim-work metadata over the Code
  // Review Defaults (#6210), so the route exercises getAppTaskTypeOverrides
  // through it — default to no per-app override.
  getAppTaskTypeOverrides: vi.fn(async () => ({})),
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
import { addTask, approveTask, deleteTask, getTaskView, reorderTasks, updateTask } from '../services/cosTaskStore.js';
import { cleanupZombieAgents, deleteAgent, getAgent, getAgentRecord, getAgents, sendBtwToAgent } from '../services/cosAgentLifecycle.js';
import { clearCompletedAgents } from '../services/cosAgentArchive.js';
import { evaluateTasks } from '../services/cosTaskGenerator.js';
import { generateReport, getBriefing, getLatestBriefing, getReport, getTodayActivity, getTodayReport, getWhileAwayActivity, listBriefings, listReports } from '../services/cosReports.js';
import { getAgentDates, getAgentsByDate, getCompletedAgentPage } from '../services/cosAgentIndex.js';
import { getConfig } from '../services/cosState.js';
import { getFeedbackStats, getPendingAgentFeedback, submitAgentFeedback } from '../services/cosAgentFeedback.js';
import { getHealthStatus, runHealthCheck } from '../services/cosHealthMonitor.js';
import { getScript, getStatus, listScripts, pause, resume, start, stop, updateConfig } from '../services/cos.js';
import * as agentOrchestrator from '../services/agentOrchestrator.js';
import * as appActivity from '../services/appActivity.js';
import * as claudeChangelog from '../services/claudeChangelog.js';
import { enhanceTaskPrompt } from '../services/taskEnhancer.js';
import { loadSlashdoCommand } from '../services/subAgentSpawner.js';
import { buildClaimWorkTask, buildIssueReplanTask } from '../services/cosTaskClaimWork.js';
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
    // GET /tasks settles its payload against the live agent list (#spawn window).
    getAgents.mockResolvedValue([]);
    cleanupZombieAgents.mockResolvedValue({ cleaned: [], count: 0 });
    getTaskView.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } });
    getAgentRecord.mockResolvedValue(null);
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
      getStatus.mockResolvedValue(mockStatus);

      const response = await request(app).get('/api/cos');

      expect(response.status).toBe(200);
      expect(response.body.running).toBe(true);
      expect(response.body.activeAgents).toBe(2);
    });
  });

  describe('POST /api/cos/start', () => {
    it('should start CoS daemon', async () => {
      start.mockResolvedValue({ success: true });

      const response = await request(app).post('/api/cos/start');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(start).toHaveBeenCalled();
    });
  });

  describe('POST /api/cos/stop', () => {
    it('should stop CoS daemon', async () => {
      stop.mockResolvedValue({ success: true });

      const response = await request(app).post('/api/cos/stop');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(stop).toHaveBeenCalled();
    });
  });

  describe('POST /api/cos/pause', () => {
    it('should pause CoS daemon with reason', async () => {
      pause.mockResolvedValue({ success: true, pausedAt: '2024-01-15T10:00:00Z' });

      const response = await request(app)
        .post('/api/cos/pause')
        .send({ reason: 'User requested pause' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(pause).toHaveBeenCalledWith('User requested pause');
    });
  });

  describe('POST /api/cos/resume', () => {
    it('should resume CoS daemon', async () => {
      resume.mockResolvedValue({ success: true });

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
      getConfig.mockResolvedValue(mockConfig);

      const response = await request(app).get('/api/cos/config');

      expect(response.status).toBe(200);
      expect(response.body.maxConcurrentAgents).toBe(3);
    });
  });

  describe('PUT /api/cos/config', () => {
    it('should update configuration', async () => {
      const updates = { maxConcurrentAgents: 5 };
      updateConfig.mockResolvedValue({ ...updates });

      const response = await request(app)
        .put('/api/cos/config')
        .send(updates);

      expect(response.status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith(updates);
    });

    it('accepts the investigation auto-approval setting', async () => {
      const updates = { autoApproveInvestigations: true };
      updateConfig.mockResolvedValue(updates);

      const response = await request(app)
        .put('/api/cos/config')
        .send(updates);

      expect(response.status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith(updates);
    });

    it('validates machine-local maintainer intent without granting other capabilities', async () => {
      const updates = { persistentMindMaintainer: { enabled: true, appIds: ['example-app'], intervalMinutes: 60 } };
      updateConfig.mockResolvedValue(updates);
      expect((await request(app).put('/api/cos/config').send(updates)).status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith(updates);
      expect((await request(app).put('/api/cos/config').send({ persistentMindMaintainer: { intervalMinutes: 0 } })).status).toBe(400);
      expect((await request(app).put('/api/cos/config').send({ persistentMindMaintainer: { createTasks: true } })).status).toBe(400);
    });

    it('refuses a Persistent Mind provider that cannot run tool-free, for the home profile and presets', async () => {
      const providers = {
        'tui-example': { id: 'tui-example', type: 'tui', command: 'claude' },
        'codex-example': { id: 'codex-example', type: 'cli', command: 'codex' },
        'claude-example': { id: 'claude-example', type: 'cli', command: 'claude' },
        'api-example': { id: 'api-example', type: 'api' },
      };
      getProviderById.mockImplementation(async (id) => providers[id] ?? null);
      updateConfig.mockResolvedValue({});
      for (const providerId of ['tui-example', 'codex-example']) {
        const profileResponse = await request(app).put('/api/cos/config').send({ persistentMindProfile: { providerId, model: 'example-model' } });
        expect(profileResponse.status).toBe(400);
        expect(profileResponse.body.code).toBe('PROVIDER_NOT_TOOL_FREE');
        expect(profileResponse.body.error).toContain(providerId);
        const presetResponse = await request(app).put('/api/cos/config').send({
          persistentMindThinkingPresets: { presets: [{ id: 'deep', providerId, model: 'example-model' }] },
        });
        expect(presetResponse.status).toBe(400);
      }
      expect(updateConfig).not.toHaveBeenCalled();
      for (const providerId of ['claude-example', 'api-example']) {
        const accepted = await request(app).put('/api/cos/config').send({ persistentMindProfile: { providerId, model: 'example-model' } });
        expect(accepted.status).toBe(200);
      }
    });

    it('validates the persistent mind wake cadence', async () => {
      const updates = { persistentMindProfile: { wakeIntervalMinutes: 60 } };
      updateConfig.mockResolvedValue(updates);

      const accepted = await request(app).put('/api/cos/config').send(updates);
      const rejected = await request(app).put('/api/cos/config').send({
        persistentMindProfile: { wakeIntervalMinutes: 4 },
      });

      expect(accepted.status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith(updates);
      expect(rejected.status).toBe(400);
    });

    it.each([
      ['autonomyLevel', 'manager'],
      ['comprehensiveAppImprovement', true],
      ['immediateExecution', true],
      ['proactiveMode', false],
    ])('accepts but ignores the retired %s config field for older clients', async (field, value) => {
      updateConfig.mockResolvedValue({ maxConcurrentAgents: 5 });
      const response = await request(app)
        .put('/api/cos/config')
        .send({ [field]: value, maxConcurrentAgents: 5 });

      expect(response.status).toBe(200);
      expect(updateConfig).toHaveBeenCalledWith({ maxConcurrentAgents: 5 });
    });
  });

  describe('POST /api/cos/tasks', () => {
    it('should add a new task', async () => {
      const taskData = {
        description: 'Test task',
        priority: 'HIGH'
      };
      addTask.mockResolvedValue({
        id: 'task-001',
        ...taskData,
        status: 'pending'
      });

      const response = await request(app)
        .post('/api/cos/tasks')
        .send(taskData);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('task-001');
      expect(addTask).toHaveBeenCalledWith(
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
      addTask.mockResolvedValue({ id: 'task-002', ...taskData, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks')
        .send(taskData);

      expect(response.status).toBe(200);
      expect(addTask).toHaveBeenCalledWith(
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
      reorderTasks.mockResolvedValue({ success: true, order: taskIds });

      const response = await request(app)
        .post('/api/cos/tasks/reorder')
        .send({ taskIds });

      expect(response.status).toBe(200);
      expect(reorderTasks).toHaveBeenCalledWith(taskIds);
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
      updateTask.mockResolvedValue({ id: 'task-001', ...updates });

      const response = await request(app)
        .put('/api/cos/tasks/task-001')
        .send(updates);

      expect(response.status).toBe(200);
      expect(updateTask).toHaveBeenCalledWith('task-001', expect.objectContaining({ status: 'completed' }), 'user');
    });

    it('should update an internal task in the internal queue', async () => {
      updateTask.mockResolvedValue({ id: 'sys-001', model: 'gpt-5.6-terra' });

      const response = await request(app)
        .put('/api/cos/tasks/sys-001')
        .send({ model: 'gpt-5.6-terra', type: 'internal' });

      expect(response.status).toBe(200);
      expect(updateTask).toHaveBeenCalledWith(
        'sys-001',
        expect.objectContaining({ model: 'gpt-5.6-terra' }),
        'internal'
      );
    });

    it('should return 404 if task not found', async () => {
      updateTask.mockResolvedValue({ error: 'Task not found' });

      const response = await request(app)
        .put('/api/cos/tasks/task-999')
        .send({ status: 'completed' });

      expect(response.status).toBe(404);
    });

    it('should set blocker metadata when marking as blocked', async () => {
      updateTask.mockResolvedValue({ id: 'task-001', status: 'blocked' });

      const response = await request(app)
        .put('/api/cos/tasks/task-001')
        .send({ status: 'blocked', blockedReason: 'Waiting for API access' });

      expect(response.status).toBe(200);
      expect(updateTask).toHaveBeenCalledWith(
        'task-001',
        expect.objectContaining({
          status: 'blocked',
          metadata: { blocker: 'Waiting for API access' }
        }),
        'user'
      );
    });

    it('should not send metadata when changing status to pending (service handles cleanup)', async () => {
      updateTask.mockResolvedValue({ id: 'task-001', status: 'pending' });

      const response = await request(app)
        .put('/api/cos/tasks/task-001')
        .send({ status: 'pending' });

      expect(response.status).toBe(200);
      const callArgs = updateTask.mock.calls[0][1];
      expect(callArgs.status).toBe('pending');
      expect(callArgs.metadata).toBeUndefined();
    });
  });

  describe('DELETE /api/cos/tasks/:id', () => {
    it('should delete a task', async () => {
      deleteTask.mockResolvedValue({ success: true, taskId: 'task-001' });

      const response = await request(app).delete('/api/cos/tasks/task-001');

      expect(response.status).toBe(200);
      expect(deleteTask).toHaveBeenCalledWith('task-001', 'user');
    });

    it('should return 404 if task not found', async () => {
      deleteTask.mockResolvedValue({ error: 'Task not found' });

      const response = await request(app).delete('/api/cos/tasks/task-999');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/tasks/:id/approve', () => {
    it('should approve a task', async () => {
      approveTask.mockResolvedValue({ id: 'sys-001', autoApproved: true });

      const response = await request(app).post('/api/cos/tasks/sys-001/approve');

      expect(response.status).toBe(200);
      expect(approveTask).toHaveBeenCalledWith('sys-001');
    });

    it('should return 400 if task does not require approval', async () => {
      approveTask.mockResolvedValue({ error: 'Task does not require approval' });

      const response = await request(app).post('/api/cos/tasks/task-001/approve');

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/cos/evaluate', () => {
    it('should trigger task evaluation', async () => {
      evaluateTasks.mockResolvedValue();

      const response = await request(app).post('/api/cos/evaluate');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(evaluateTasks).toHaveBeenCalled();
    });
  });

  describe('GET /api/cos/agents', () => {
    it('should return state-resident agents without waiting for zombie cleanup', async () => {
      let releaseCleanup;
      cleanupZombieAgents.mockReturnValue(new Promise((resolve) => { releaseCleanup = resolve; }));
      getAgents.mockResolvedValue([
        { id: 'agent-001', status: 'running' },
        { id: 'agent-002', status: 'completed' }
      ]);

      const response = await request(app).get('/api/cos/agents');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(cleanupZombieAgents).toHaveBeenCalled();
      releaseCleanup({ cleaned: [], count: 0 });
    });
  });

  describe('GET /api/cos/agents listing projection', () => {
    it('strips the transcript and bounds a pasted-prompt description', async () => {
      const long = 'Refactor the queue. '.repeat(5000);
      getAgents.mockResolvedValue([
        { id: 'agent-001', status: 'completed', output: ['a', 'b'], metadata: { taskDescription: long, model: 'opus' } }
      ]);

      const response = await request(app).get('/api/cos/agents');

      expect(response.status).toBe(200);
      expect(response.body[0]).not.toHaveProperty('output');
      expect(response.body[0].metadata.taskDescription.length).toBeLessThan(long.length);
      expect(response.body[0].metadata.taskDescriptionTruncated).toBe(true);
      expect(response.body[0].metadata.model).toBe('opus');
    });

    it('leaves a normal description unflagged so the client never hydrates for nothing', async () => {
      getAgents.mockResolvedValue([
        { id: 'agent-001', status: 'running', metadata: { taskDescription: 'Fix the thing' } }
      ]);

      const response = await request(app).get('/api/cos/agents');

      expect(response.body[0].metadata.taskDescription).toBe('Fix the thing');
      expect(response.body[0].metadata.taskDescriptionTruncated).toBeUndefined();
    });

    it('projects release publication and synchronization milestones onto agent list items', async () => {
      const { saveReleaseSynchronization } = await import('../services/releaseSynchronizationStore.js');
      const identity = 'f'.repeat(64);
      await saveReleaseSynchronization({
        version: 1,
        identity,
        owner: { taskId: 'task-sync-agent', agentId: 'agent-sync-pub' },
        publication: { identity, status: 'verified', tag: 'v2.0.0' },
        task: { id: 'task-sync-agent' },
        obligations: {
          synchronizationPr: {
            status: 'verified',
            evidence: { prUrl: 'https://github.com/example/repo/pull/101', headSha: 'b'.repeat(40) },
          },
        },
        synchronization: { status: 'blocked', blocker: 'publisher-candidate-checkout-unverified' },
      });
      getAgents.mockResolvedValue([
        { id: 'agent-sync-pub', status: 'completed', metadata: { taskDescription: 'Publish release' } }
      ]);

      const response = await request(app).get('/api/cos/agents');
      expect(response.status).toBe(200);
      expect(response.body[0].metadata.releasePublication).toMatchObject({ status: 'verified', identity });
      expect(response.body[0].metadata.releaseSynchronization).toMatchObject({
        status: 'blocked', blocker: 'publisher-candidate-checkout-unverified',
        identity,
        prUrl: 'https://github.com/example/repo/pull/101',
      });
    });
  });

  describe('GET /api/cos/agents/history', () => {
    it('should return available date buckets', async () => {
      getAgentDates.mockResolvedValue([
        { date: '2026-02-25', count: 5 },
        { date: '2026-02-24', count: 3 }
      ]);

      const response = await request(app).get('/api/cos/agents/history');

      expect(response.status).toBe(200);
      expect(response.body.dates).toHaveLength(2);
      expect(response.body.dates[0]).toEqual({ date: '2026-02-25', count: 5 });
      expect(response.body).not.toHaveProperty('latest');
      expect(getAgentsByDate).not.toHaveBeenCalled();
    });

    it('?hydrate=1 also returns the newest bucket, so the tab needs one round trip', async () => {
      getAgentDates.mockResolvedValue([
        { date: '2026-02-25', count: 5 },
        { date: '2026-02-24', count: 3 }
      ]);
      getAgentsByDate.mockResolvedValue([
        { id: 'agent-001', status: 'completed', output: ['a'], metadata: { taskDescription: 'Short' } }
      ]);

      const response = await request(app).get('/api/cos/agents/history?hydrate=1');

      expect(response.status).toBe(200);
      expect(getAgentsByDate).toHaveBeenCalledWith('2026-02-25');
      expect(response.body.latest.date).toBe('2026-02-25');
      expect(response.body.latest.agents).toHaveLength(1);
      // The hydrated bucket goes through the same listing projection.
      expect(response.body.latest.agents[0]).not.toHaveProperty('output');
    });

    it('hydrates to null on an install with no archived runs', async () => {
      getAgentDates.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/agents/history?hydrate=1');

      expect(response.status).toBe(200);
      expect(response.body.latest).toBeNull();
      expect(getAgentsByDate).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/cos/agents/history/:date', () => {
    it('should return agents for a valid date', async () => {
      getAgentsByDate.mockResolvedValue([
        { id: 'agent-001', status: 'completed' }
      ]);

      const response = await request(app).get('/api/cos/agents/history/2026-02-25');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(getAgentsByDate).toHaveBeenCalledWith('2026-02-25');
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
      getAgent.mockResolvedValue({ id: 'agent-001', status: 'running' });

      const response = await request(app).get('/api/cos/agents/agent-001');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('agent-001');
    });

    it('should return 404 if agent not found', async () => {
      getAgent.mockResolvedValue(null);

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
      deleteAgent.mockResolvedValue({ success: true, agentId: 'agent-001' });

      const response = await request(app).delete('/api/cos/agents/agent-001');

      expect(response.status).toBe(200);
      expect(deleteAgent).toHaveBeenCalledWith('agent-001');
    });

    it('should return 404 if agent not found', async () => {
      deleteAgent.mockRejectedValue(new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' }));

      const response = await request(app).delete('/api/cos/agents/agent-999');

      expect(response.status).toBe(404);
    });

    it('should return 409 when agent is still owned by an active task cleanup hold', async () => {
      deleteAgent.mockRejectedValue(new ServerError(
        'Agent agent-001 is still owned by an active task delivery or retry cleanup hold and cannot be deleted until cleanup finishes',
        { status: 409, code: 'AGENT_CLEANUP_OWNED' },
      ));

      const response = await request(app).delete('/api/cos/agents/agent-001');

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('AGENT_CLEANUP_OWNED');
    });
  });

  describe('GET /api/cos/health', () => {
    it('should return health status', async () => {
      getHealthStatus.mockResolvedValue({
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
      runHealthCheck.mockResolvedValue({
        metrics: {},
        issues: []
      });

      const response = await request(app).post('/api/cos/health/check');

      expect(response.status).toBe(200);
      expect(runHealthCheck).toHaveBeenCalled();
    });
  });

  describe('GET /api/cos/reports', () => {
    it('should list all reports', async () => {
      listReports.mockResolvedValue(['2024-01-15', '2024-01-14']);

      const response = await request(app).get('/api/cos/reports');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
    });
  });

  describe('GET /api/cos/reports/today', () => {
    it('should return today report', async () => {
      getTodayReport.mockResolvedValue({
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
      getReport.mockResolvedValue({
        date: '2024-01-14',
        summary: {}
      });

      const response = await request(app).get('/api/cos/reports/2024-01-14');

      expect(response.status).toBe(200);
    });

    it('should return 404 if report not found', async () => {
      getReport.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/reports/1999-01-01');

      expect(response.status).toBe(404);
    });

    it('should reject malformed dates before reading the report', async () => {
      const response = await request(app).get('/api/cos/reports/not-a-date');

      expect(response.status).toBe(400);
      expect(getReport).not.toHaveBeenCalled();
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
      addTask.mockResolvedValue({ id: `task-sd-${command}`, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command, app: 'my-app' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(`task-sd-${command}`);
      // The route persists the BARE command and lets the prompt builder render
      // the invocation + inline the body once the provider is known — it no
      // longer eagerly loads the body or hardcodes `/do:` into the description
      // (both assumed a Claude host that can type slash commands).
      const [taskData] = addTask.mock.calls.at(-1);
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
      expect(addTask).not.toHaveBeenCalled();
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
      addTask.mockResolvedValue({ id: `task-wce-${command}`, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command, app: 'my-app' });

      expect(response.status).toBe(200);
      expect(addTask.mock.calls.at(-1)[0].worktreeChangesExpected).toBe(expected);
    });

    // The run drawer's removal bar reaches the bundled command as its own flag;
    // the default bar is the flag-less invocation, and no other command gets
    // the flag (its body has nothing to read it).
    it.each([
      ['depfree', 'extreme', '--extreme'],
      ['depfree', 'heavy', '--heavy'],
      ['depfree', 'default', undefined],
      ['depfree', undefined, undefined],
      ['better', 'extreme', undefined]
    ])('forwards the depfree removal bar as a command flag — %s + %s ⇒ %s', async (command, depfreeMode, slashdoArgs) => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', type: 'web', repoPath: '/repo' });
      addTask.mockResolvedValue({ id: 'task-depfree-mode', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command, app: 'my-app', ...(depfreeMode ? { depfreeMode } : {}) });

      expect(response.status).toBe(200);
      const [taskData] = addTask.mock.calls.at(-1);
      expect(taskData.slashdoArgs).toBe(slashdoArgs);
      expect(taskData.description.includes('mode)')).toBe(slashdoArgs !== undefined);
    });

    it('rejects an unknown depfree removal bar', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', type: 'web', repoPath: '/repo' });
      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'depfree', app: 'my-app', depfreeMode: 'zero' });
      expect(response.status).toBe(400);
      expect(addTask).not.toHaveBeenCalled();
    });

    it('queues the SwiftUI audit for a Swift app', async () => {
      getAppById.mockResolvedValue({ id: 'my-ios', name: 'MyPhone', type: 'ios-native', repoPath: '/repo' });
      addTask.mockResolvedValue({ id: 'task-sd-swift', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'better-swift', app: 'my-ios' });

      expect(response.status).toBe(200);
      expect(addTask.mock.calls.at(-1)[0].slashdoCommand).toBe('better-swift');
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
      expect(addTask).not.toHaveBeenCalled();
    });

    it('404s an unknown app for every command, not just next', async () => {
      getAppById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'push', app: 'ghost-app' });

      expect(response.status).toBe(404);
      expect(addTask).not.toHaveBeenCalled();
    });

    // The Issues tab's Replan button: `replan` + a pinned issue is a per-issue
    // second opinion, NOT the bundled backlog audit. The regression this guards
    // is the targeted run falling through to the plain slashdo branch, which
    // would append the whole `/do:replan` body and re-point the agent at the
    // entire backlog.
    it('routes a targeted replan through the per-issue review builder', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', type: 'web', repoPath: '/repo' });
      buildIssueReplanTask.mockResolvedValue({
        tracker: 'github',
        cli: 'gh',
        prompt: 'REPLAN ISSUE PROMPT',
        target: '42',
        taskMetadata: { useWorktree: false, openPR: false, noCodeOutput: true, worktreeChangesExpected: false }
      });
      addTask.mockResolvedValue({ id: 'task-replan-42', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'replan', app: 'my-app', target: '42', overrideContext: 'focus on the migration' });

      expect(response.status).toBe(200);
      expect(buildIssueReplanTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'my-app' }),
        expect.objectContaining({ target: '42', overrideContext: 'focus on the migration' })
      );
      const [taskData] = addTask.mock.calls.at(-1);
      expect(taskData.prompt).toBe('REPLAN ISSUE PROMPT');
      // Same reason `next` carries none: the assembled prompt IS the task prompt.
      expect(taskData.slashdoCommand).toBeUndefined();
      // Persisted under its OWN key so a replan's lifecycle events can never
      // light up the Claim button on the same row.
      expect(taskData.replanTarget).toBe('42');
      expect(taskData.claimTarget).toBeUndefined();
      expect(taskData.noCodeOutput).toBe(true);
      expect(taskData.worktreeChangesExpected).toBe(false);
      expect(taskData.description).toContain('MyApp');
      expect(taskData.description).toContain('42');
    });

    it('leaves an untargeted replan on the bundled backlog-audit workflow', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', type: 'web', repoPath: '/repo' });
      addTask.mockResolvedValue({ id: 'task-replan-all', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'replan', app: 'my-app' });

      expect(response.status).toBe(200);
      expect(buildIssueReplanTask).not.toHaveBeenCalled();
      expect(addTask.mock.calls.at(-1)[0].slashdoCommand).toBe('replan');
    });

    it('surfaces the builder\'s tracker rejection instead of queuing a run with nothing to comment on', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', type: 'web', repoPath: '/repo' });
      buildIssueReplanTask.mockRejectedValue(
        new ServerError('Replan needs a GitHub or GitLab issue tracker', { status: 400, code: 'UNSUPPORTED_REPLAN_TRACKER' })
      );

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'replan', app: 'my-app', target: '42' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('UNSUPPORTED_REPLAN_TRACKER');
      expect(addTask).not.toHaveBeenCalled();
    });

    it('does not queue a manual claim when contributor-label cleanup fails', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', repoPath: '/repo' });
      buildClaimWorkTask.mockResolvedValue({ tracker: 'github', target: '42' });
      prepareAppIssueClaim.mockRejectedValueOnce(new ServerError('Labels remain', { status: 502, code: 'CLAIM_LABELS_REMAIN' }));
      const response = await request(app).post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app', target: '42' });
      expect(response.status).toBe(502);
      expect(addTask).not.toHaveBeenCalled();
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
      addTask.mockResolvedValue({ id: 'task-sd-next', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('task-sd-next');
      expect(buildClaimWorkTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'my-app' }), expect.any(Object));
      // The raw do:next body must NOT be inlined for the next command.
      expect(loadSlashdoCommand).not.toHaveBeenCalledWith('next');
      const [taskData] = addTask.mock.calls.at(-1);
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
      expect(prepareAppIssueClaim).not.toHaveBeenCalled();
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
      addTask.mockResolvedValue({ id: 'task-sd-next-reviewers', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app' });

      expect(response.status).toBe(200);
      const [taskData] = addTask.mock.calls.at(-1);
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
      addTask.mockResolvedValue({ id: 'task-sd-next-wce', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app' });

      expect(response.status).toBe(200);
      expect(addTask.mock.calls.at(-1)[0].worktreeChangesExpected).toBe(false);
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
      addTask.mockResolvedValue({ id: 'task-sd-next-default', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({ command: 'next', app: 'my-app' });

      expect(response.status).toBe(200);
      expect(addTask.mock.calls.at(-1)[0].worktreeChangesExpected).toBe(true);
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
      addTask.mockResolvedValue({ id: 'task-sd-target', status: 'pending' });

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
      expect(prepareAppIssueClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'my-app' }), '412', 'github');
      expect(prepareAppIssueClaim.mock.invocationCallOrder[0]).toBeLessThan(addTask.mock.invocationCallOrder[0]);
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
      const [taskData] = addTask.mock.calls.at(-1);
      expect(taskData.provider).toBe('claude-cli');
      expect(taskData.model).toBe('claude-opus-5');
      expect(taskData.effort).toBe('high');
      expect(taskData.claimTarget).toBe('412');
      expect(taskData.metadata).toEqual({ prompt: 'CLAIM ISSUE PROMPT' });
      expect(taskData.simplify).toBe(true);
      // The claim prompt owns its own review sequence — no CoS loop on top.
      expect(taskData.reviewLoop).toBe(false);
      // The pinned item shows in the queue description so the row is self-explaining.
      expect(taskData.description).toContain('412');
    });

    it('threads prCompletion into buildClaimWorkTask and onto the task metadata', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', repoPath: '/repo' });
      buildClaimWorkTask.mockResolvedValue({
        tracker: 'github',
        source: 'config',
        promptTaskType: 'claim-issue',
        prompt: 'CLAIM ISSUE PROMPT',
        taskMetadata: { useWorktree: false, openPR: false, prCompletion: 'merge-on-green' },
        target: '412'
      });
      addTask.mockResolvedValue({ id: 'task-sd-mog', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/slashdo')
        .send({
          command: 'next',
          app: 'my-app',
          prCompletion: 'merge-on-green'
        });

      expect(response.status).toBe(200);
      expect(buildClaimWorkTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'my-app' }),
        expect.objectContaining({ prCompletion: 'merge-on-green' })
      );
      const [taskData] = addTask.mock.calls.at(-1);
      expect(taskData.prCompletion).toBe('merge-on-green');
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
      addTask.mockResolvedValue({ duplicate: true, status: 'pending' });

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
      addTask.mockResolvedValue({ id: 'task-jira-1', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'my-app', ticketKey: 'PROJ-123' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('task-jira-1');
      expect(getTaskPrompt).toHaveBeenCalledWith('claim-issue-jira');

      const [taskData, taskType] = addTask.mock.calls.at(-1);
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
      addTask.mockResolvedValue({ id: 'task-jira-2', status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'my-app', ticketKey: 'proj-7' });

      expect(response.status).toBe(200);
      const [taskData] = addTask.mock.calls.at(-1);
      expect(taskData.description).toContain('PROJ-7');
      expect(taskData.prompt).toContain('PROJ-7');
    });

    it('returns 404 for an unknown app', async () => {
      getAppById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'ghost', ticketKey: 'PROJ-1' });

      expect(response.status).toBe(404);
      expect(addTask).not.toHaveBeenCalled();
    });

    it('returns 400 when JIRA is not enabled for the app', async () => {
      getAppById.mockResolvedValue({ id: 'my-app', name: 'MyApp', repoPath: '/repo', jira: { enabled: false } });

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'my-app', ticketKey: 'PROJ-1' });

      expect(response.status).toBe(400);
      expect(addTask).not.toHaveBeenCalled();
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
      addTask.mockResolvedValue({ duplicate: true, status: 'pending' });

      const response = await request(app)
        .post('/api/cos/tasks/jira-ticket')
        .send({ app: 'my-app', ticketKey: 'PROJ-9' });

      expect(response.status).toBe(409);
    });
  });

  describe('POST /api/cos/tasks (duplicate)', () => {
    it('should return 409 for duplicate task', async () => {
      addTask.mockResolvedValue({ duplicate: true, status: 'running' });

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
      clearCompletedAgents.mockResolvedValue({ cleared: 3 });

      const response = await request(app).delete('/api/cos/agents/completed');

      expect(response.status).toBe(200);
      expect(response.body.cleared).toBe(3);
    });
  });

  describe('GET /api/cos/agents/feedback/pending', () => {
    it('returns the durable count and the reconciled eligible agent projection', async () => {
      getPendingAgentFeedback.mockResolvedValue({
        count: 1,
        agents: [{ id: 'agent-001', status: 'completed', metadata: { taskType: 'user' } }],
        unavailable: [{ agentId: 'agent-old', availability: 'unavailable', unavailableReason: 'deleted' }],
      });

      const response = await request(app).get('/api/cos/agents/feedback/pending');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ count: 1 });
      expect(response.body.agents).toEqual([{ id: 'agent-001', status: 'completed', metadata: { taskType: 'user' } }]);
      expect(response.body.unavailable).toEqual([{ agentId: 'agent-old', availability: 'unavailable', unavailableReason: 'deleted' }]);
    });
  });

  describe('POST /api/cos/agents/:id/feedback', () => {
    it('should submit positive feedback', async () => {
      submitAgentFeedback.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/cos/agents/agent-001/feedback')
        .send({ rating: 'positive', comment: 'Great work' });

      expect(response.status).toBe(200);
      expect(submitAgentFeedback).toHaveBeenCalledWith('agent-001', { rating: 'positive', comment: 'Great work' });
    });

    it('should return 400 for invalid rating', async () => {
      const response = await request(app)
        .post('/api/cos/agents/agent-001/feedback')
        .send({ rating: 'invalid' });

      expect(response.status).toBe(400);
    });

    it('should return 404 if agent not found', async () => {
      submitAgentFeedback.mockRejectedValue(new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' }));

      const response = await request(app)
        .post('/api/cos/agents/agent-999/feedback')
        .send({ rating: 'negative' });

      expect(response.status).toBe(404);
    });

    it('should return 400 (INVALID_STATE) when the agent is not completed', async () => {
      submitAgentFeedback.mockRejectedValue(new ServerError('Can only submit feedback for completed agents', { status: 400, code: 'INVALID_STATE' }));

      const response = await request(app)
        .post('/api/cos/agents/agent-001/feedback')
        .send({ rating: 'positive' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_STATE');
    });
  });

  describe('POST /api/cos/agents/:id/btw', () => {
    it('should send btw message to agent', async () => {
      sendBtwToAgent.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/cos/agents/agent-001/btw')
        .send({ message: 'Additional context here' });

      expect(response.status).toBe(200);
      expect(sendBtwToAgent).toHaveBeenCalledWith('agent-001', 'Additional context here');
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
      sendBtwToAgent.mockRejectedValue(new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' }));

      const response = await request(app)
        .post('/api/cos/agents/agent-999/btw')
        .send({ message: 'hello' });

      expect(response.status).toBe(404);
    });

    it('should return 400 (INVALID_STATE) when BTW is unsupported for the agent', async () => {
      sendBtwToAgent.mockRejectedValue(new ServerError('Agent is not running', { status: 400, code: 'INVALID_STATE' }));

      const response = await request(app)
        .post('/api/cos/agents/agent-001/btw')
        .send({ message: 'hello' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_STATE');
    });
  });

  describe('GET /api/cos/feedback/stats', () => {
    it('should return feedback statistics', async () => {
      getFeedbackStats.mockResolvedValue({ total: 10, positive: 7, negative: 2, neutral: 1 });

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
      generateReport.mockResolvedValue({ date: '2026-02-25', summary: {} });

      const response = await request(app)
        .post('/api/cos/reports/generate')
        .send({ date: '2026-02-25' });

      expect(response.status).toBe(200);
      expect(generateReport).toHaveBeenCalledWith('2026-02-25');
    });

    it('should reject a date that is not a bare YYYY-MM-DD day', async () => {
      // A full ISO timestamp matches no date bucket and no completedAt prefix,
      // so it would write an all-zero report under an unreadable filename.
      const response = await request(app)
        .post('/api/cos/reports/generate')
        .send({ date: '2026-02-25T00:00:00.000Z' });

      expect(response.status).toBe(400);
      expect(generateReport).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/cos/briefings', () => {
    it('should list all briefings', async () => {
      listBriefings.mockResolvedValue(['2026-02-25', '2026-02-24']);

      const response = await request(app).get('/api/cos/briefings');

      expect(response.status).toBe(200);
      expect(response.body.briefings).toHaveLength(2);
    });
  });

  describe('GET /api/cos/briefings/latest', () => {
    it('should return latest briefing', async () => {
      getLatestBriefing.mockResolvedValue({ date: '2026-02-25', content: 'Latest' });

      const response = await request(app).get('/api/cos/briefings/latest');

      expect(response.status).toBe(200);
      expect(response.body.date).toBe('2026-02-25');
    });
  });

  describe('GET /api/cos/briefings/:date', () => {
    it('should return briefing by date', async () => {
      getBriefing.mockResolvedValue({ date: '2026-02-24', content: 'Briefing' });

      const response = await request(app).get('/api/cos/briefings/2026-02-24');

      expect(response.status).toBe(200);
    });

    it('should return 404 if briefing not found', async () => {
      getBriefing.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/briefings/1999-01-01');

      expect(response.status).toBe(404);
    });

    it('should reject malformed dates before reading the briefing', async () => {
      const response = await request(app).get('/api/cos/briefings/not-a-date');

      expect(response.status).toBe(400);
      expect(getBriefing).not.toHaveBeenCalled();
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
      listScripts.mockResolvedValue([{ name: 'backup.sh' }]);

      const response = await request(app).get('/api/cos/scripts');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });
  });

  describe('GET /api/cos/scripts/:name', () => {
    it('should return script content', async () => {
      getScript.mockResolvedValue({ name: 'backup.sh', content: '#!/bin/bash' });

      const response = await request(app).get('/api/cos/scripts/backup.sh');

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('backup.sh');
    });

    it('should return 404 if script not found', async () => {
      getScript.mockResolvedValue(null);

      const response = await request(app).get('/api/cos/scripts/missing.sh');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/activity/today', () => {
    it('should return today activity summary', async () => {
      getTodayActivity.mockResolvedValue({ stats: { completed: 5 } });

      const response = await request(app).get('/api/cos/activity/today');

      expect(response.status).toBe(200);
      expect(response.body.stats.completed).toBe(5);
    });
  });

  describe('GET /api/cos/activity/while-away', () => {
    it('passes a valid ISO since through to the service', async () => {
      getWhileAwayActivity.mockResolvedValue({ stats: { completed: 3 } });
      const since = '2026-06-01T00:00:00.000Z';

      const response = await request(app).get(`/api/cos/activity/while-away?since=${encodeURIComponent(since)}`);

      expect(response.status).toBe(200);
      expect(response.body.stats.completed).toBe(3);
      expect(getWhileAwayActivity).toHaveBeenCalledWith(since);
    });

    it('tolerates a garbage since (200 + service fallback, not 400)', async () => {
      getWhileAwayActivity.mockResolvedValue({ stats: { completed: 0 } });

      const response = await request(app).get('/api/cos/activity/while-away?since=not-a-date');

      expect(response.status).toBe(200);
      // Malformed value is dropped to undefined so the service applies its
      // own 24h fallback rather than the route 400-ing the dashboard card.
      expect(getWhileAwayActivity).toHaveBeenCalledWith(undefined);
    });

    it('works with no since param', async () => {
      getWhileAwayActivity.mockResolvedValue({ stats: { completed: 1 } });

      const response = await request(app).get('/api/cos/activity/while-away');

      expect(response.status).toBe(200);
      expect(getWhileAwayActivity).toHaveBeenCalledWith(undefined);
    });
  });
describe('CoS scoped collections', () => {
  it('keeps the exact delivery cleanup owners visible, including archived system runs', async () => {
    const user = { id: 'agent-user', taskId: 'task-example', status: 'completed', output: ['transcript'] };
    const system = { id: 'agent-system', taskId: 'sys-rl-example', status: 'completed', metadata: { taskDescription: 'Finish example delivery' } };
    getAgents.mockResolvedValue([
      { id: 'agent-running', taskId: 'task-running', status: 'running' },
      { id: 'agent-paused', status: 'paused' },
      { id: 'agent-old', taskId: user.taskId, status: 'completed' },
      user,
    ]);
    const cleanupTask = agent => ({ id: agent.taskId, status: 'in_progress', metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: agent.id } });
    getTaskView.mockResolvedValue({ user: { tasks: [cleanupTask(user)] }, cos: { tasks: [cleanupTask(system)] } });
    getAgentRecord.mockResolvedValue(system);

    const response = await request(app).get('/api/cos/agents?active=1');

    expect(response.status).toBe(200);
    expect(response.body.map(agent => agent.id)).toEqual(['agent-running', 'agent-paused', user.id, system.id]);
    expect(response.body.slice(2)).toEqual([
      { id: user.id, taskId: user.taskId, status: 'completed', deliveryPending: true },
      { ...system, deliveryPending: true },
    ]);
    expect(user).not.toHaveProperty('deliveryPending');
    expect(getAgentRecord).toHaveBeenCalledExactlyOnceWith(system.id);
    expect(getAgent).not.toHaveBeenCalled();

    getTaskView.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } });
    expect((await request(app).get('/api/cos/agents?active=1')).body.map(agent => agent.id))
      .toEqual(['agent-running', 'agent-paused']);
  });

  it('does not revive finished, missing, mismatched or superseded cleanup owners', async () => {
    getAgents.mockResolvedValue([{ id: 'agent-running', taskId: 'task-running', status: 'running' }]);
    const task = (id, owner, status = 'in_progress') => ({ id, status, metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: owner } });
    getTaskView.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [
      task('task-done', 'agent-done', 'completed'),
      task('task-running', 'agent-older'),
      task('task-missing', 'agent-missing'),
      task('task-mismatch', 'agent-mismatch'),
    ] } });
    getAgentRecord.mockImplementation(async id => id === 'agent-mismatch'
      ? { id, taskId: 'other-task', status: 'completed' } : null);

    const response = await request(app).get('/api/cos/agents?active=1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 'agent-running', taskId: 'task-running', status: 'running' }]);
    expect(getAgentRecord.mock.calls.map(([id]) => id).sort()).toEqual(['agent-mismatch', 'agent-missing']);
  });

  it('reports only live in-process delivery activity and clears it when recovery fails', async () => {
    const owner = { id: 'agent-cleanup-owner', taskId: 'task-held', status: 'completed' };
    getAgents.mockResolvedValue([owner]);
    getTaskView.mockResolvedValue({ user: { tasks: [{ id: owner.taskId, status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: owner.id } }] }, cos: { tasks: [] } });
    let reject;
    const recovery = withDeliveryActivity(owner.id, 'Checking preservation', () => new Promise((_, fail) => { reject = fail; }));
    const outcome = recovery.catch(error => error.message);
    try {
      const active = await request(app).get('/api/cos/agents?active=1');
      expect(active.body[0]).toMatchObject({ status: 'completed', deliveryPending: true,
        deliveryActivity: { label: 'Checking preservation', startedAt: expect.any(String) } });
    } finally {
      reject(new Error('verification-unavailable'));
      expect(await outcome).toBe('verification-unavailable');
    }
    const waiting = await request(app).get('/api/cos/agents?active=1');
    expect(waiting.body).toEqual([{ ...owner, deliveryPending: true }]);
  });

  it('projects activity for an exact retry-cleanup owner without inventing a legacy owner', async () => {
    const owner = { id: 'agent-retry-owner', taskId: 'task-held', status: 'completed' };
    getAgents.mockResolvedValue([owner]);
    getTaskView.mockResolvedValue({ user: { tasks: [{ id: owner.taskId, status: 'in_progress',
      metadata: { retryPendingCleanup: owner.id } }, { id: 'legacy-hold', status: 'in_progress',
      metadata: { retryPendingCleanup: 'true' } }] }, cos: { tasks: [] } });
    let finish;
    const recovery = withDeliveryActivity(owner.id, 'Cleaning up before retry', () => new Promise(resolve => { finish = resolve; }));
    try {
      const response = await request(app).get('/api/cos/agents?active=1');
      expect(response.body).toEqual([expect.objectContaining({ ...owner, deliveryPending: true,
        deliveryActivity: expect.objectContaining({ label: 'Cleaning up before retry' }) })]);
      expect(getAgentRecord).not.toHaveBeenCalledWith('true');
    } finally { finish(); await recovery; }
    expect((await request(app).get('/api/cos/agents?active=1')).body).toEqual([{ ...owner, deliveryPending: true }]);
  });

  it('scopes live agents and validates completed page bounds without changing legacy lists', async () => {
    getAgents.mockResolvedValue([{ id: 'running', status: 'running' }, { id: 'done', status: 'completed' }]);
    expect((await request(app).get('/api/cos/agents?active=1')).body.map(agent => agent.id)).toEqual(['running']);
    expect((await request(app).get('/api/cos/agents')).body).toHaveLength(2);
    getCompletedAgentPage.mockResolvedValue({ items: [{ id: 'done', output: ['private transcript'], metadata: { taskSummary: 'x'.repeat(100000), simplifySummary: 'y'.repeat(100000) } }], total: 1, nextCursor: null });
    const page = await request(app).get('/api/cos/agents/completed?limit=25');
    expect(page.body).toMatchObject({ items: [{ id: 'done', metadata: { taskSummaryTruncated: true, simplifySummaryTruncated: true } }], total: 1, nextCursor: null });
    expect(page.body.items[0]).not.toHaveProperty('output');
    expect(JSON.stringify(page.body).length).toBeLessThan(5000);
    expect((await request(app).get('/api/cos/agents/completed?limit=1000')).status).toBe(400);
    expect((await request(app).get('/api/cos/agents/completed?cursor=invalid')).status).toBe(400);
  });
});

});
