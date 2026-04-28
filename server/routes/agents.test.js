import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/agents.js', () => ({
  getRunningAgents: vi.fn(),
  killProcess: vi.fn(),
  getProcessInfo: vi.fn()
}));

import { getRunningAgents, killProcess, getProcessInfo } from '../services/agents.js';
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

    it('returns an empty array when no agents are running', async () => {
      getRunningAgents.mockResolvedValue([]);
      const res = await request(buildApp()).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/agents/:pid', () => {
    it('returns process info for an existing pid', async () => {
      getProcessInfo.mockResolvedValue({ pid: 1234, cpu: 12.3, memory: 45.6 });
      const res = await request(buildApp()).get('/api/agents/1234');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ pid: 1234, cpu: 12.3, memory: 45.6 });
      expect(getProcessInfo).toHaveBeenCalledWith(1234);
    });

    it('returns 404 when the pid is not found', async () => {
      getProcessInfo.mockResolvedValue(null);
      const res = await request(buildApp()).get('/api/agents/9999');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(res.body.error).toMatch(/process not found/i);
    });

    it('coerces the pid param to an integer before service lookup', async () => {
      getProcessInfo.mockResolvedValue({ pid: 42 });
      await request(buildApp()).get('/api/agents/42abc');
      expect(getProcessInfo).toHaveBeenCalledWith(42);
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

    it('propagates a service error to the centralized error middleware', async () => {
      killProcess.mockRejectedValue(new Error('Invalid PID provided'));
      const res = await request(buildApp()).delete('/api/agents/-1');
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/invalid pid/i);
    });
  });
});
