import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/agentRepoStateVerification.js', () => ({ recheckAgentCleanup: vi.fn() }));
vi.mock('../services/cosAgentArchive.js', () => ({}));
vi.mock('../services/cosAgentFeedback.js', () => ({}));
vi.mock('../services/cosAgentIndex.js', () => ({}));
vi.mock('../services/cosAgentLifecycle.js', () => ({}));
vi.mock('../services/cosHealthMonitor.js', () => ({}));
vi.mock('../services/cosTaskStore.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));

import { recheckAgentCleanup } from '../services/agentRepoStateVerification.js';
import router from './cosAgentRoutes.js';

const call = body => new Promise(resolve => {
  const req = { app: { get: () => null }, method: 'POST', url: '/agents/agent-1/recheck-cleanup', body, headers: {} };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { resolve({ status: this.statusCode, body: value }); } };
  router.handle(req, res, error => resolve({ status: error?.status || 404, error }));
});

beforeEach(() => vi.resetAllMocks());

describe('manual cleanup recheck route', () => {
  it('passes only the selected agent and task to the cleanup service', async () => {
    recheckAgentCleanup.mockResolvedValue({ ok: true, verified: false, reasons: ['cleanup-review-required'] });
    expect(await call({ taskId: 'task-1' })).toEqual({ status: 200, body: { ok: true, verified: false, reasons: ['cleanup-review-required'] } });
    expect(recheckAgentCleanup).toHaveBeenCalledWith('agent-1', 'task-1');
  });

  it('rejects forged fields and reports stale or active ownership', async () => {
    expect((await call({ taskId: 'task-1', path: '/another-worktree' })).status).toBe(400);
    expect(recheckAgentCleanup).not.toHaveBeenCalled();
    recheckAgentCleanup.mockResolvedValue({ ok: false, reason: 'cleanup-owner-changed' });
    expect((await call({ taskId: 'task-1' })).status).toBe(409);
    recheckAgentCleanup.mockResolvedValue({ ok: false, reason: 'cleanup-already-running' });
    expect((await call({ taskId: 'task-1' })).status).toBe(409);
  });
});
