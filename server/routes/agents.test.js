import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/agent/agents.js', () => ({
  getRunningAgents: vi.fn(),
  killProcess: vi.fn(),
  getProcessInfo: vi.fn()
}));

import { getRunningAgents, killProcess, getProcessInfo } from '../services/agent/agents.js';
import agentsRoutes from './agents.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentsRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('agents routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/agents', () => {
    it('returns the list of running agents', async () => {
      getRunningAgents.mockResolvedValue([
        { pid: 100, agentName: 'Claude', command: 'claude --foo' },
        { pid: 200, agentName: 'Codex', command: 'codex run' }
      ]);
      const res = await request(buildApp()).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].agentName).toBe('Claude');
    });
  });

  describe('GET /api/agents/:pid', () => {
    it('returns 404 when the pid is not found', async () => {
      getProcessInfo.mockResolvedValue(null);
      const res = await request(buildApp()).get('/api/agents/9999');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(res.body.error).toMatch(/process not found/i);
    });

    it('returns 400 INVALID_PARAM for malformed or non-positive pid params without calling the service', async () => {
      for (const badPid of ['42abc', '-1', '0', 'not-a-pid', '1.5']) {
        const res = await request(buildApp()).get(`/api/agents/${badPid}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_PARAM');
      }
      expect(getProcessInfo).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/agents/:pid', () => {
    it('kills the process and returns success with the parsed pid', async () => {
      killProcess.mockResolvedValue(true);
      const res = await request(buildApp()).delete('/api/agents/5555');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, pid: 5555 });
      expect(killProcess).toHaveBeenCalledWith(5555);
    });

    it('returns 400 INVALID_PARAM for malformed or non-positive pid params without killing a process', async () => {
      for (const badPid of ['42abc', '-1', '0', 'not-a-pid', '1.5']) {
        const res = await request(buildApp()).delete(`/api/agents/${badPid}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_PARAM');
      }
      expect(killProcess).not.toHaveBeenCalled();
    });

    it('propagates a service error to the centralized error middleware', async () => {
      killProcess.mockRejectedValue(new Error('Process kill failed'));
      const res = await request(buildApp()).delete('/api/agents/5555');
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/process kill failed/i);
    });
  });
});
