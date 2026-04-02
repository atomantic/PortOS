import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn()
  }))
}));

vi.mock('../lib/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn()
}));

import { io } from 'socket.io-client';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import {
  initCosRunnerConnection,
  onCosRunnerEvent,
  isRunnerAvailable,
  getRunnerHealth,
  spawnAgentViaRunner,
  getActiveAgentsFromRunner,
  terminateAgentViaRunner,
  killAgentViaRunner,
  getAgentStatsFromRunner,
  terminateAllAgentsViaRunner,
  sendBtwToAgent,
  getAgentOutputFromRunner,
  executeCliRunViaRunner,
  getActiveRunsFromRunner,
  isRunActiveInRunner,
  getRunOutputFromRunner,
  stopRunViaRunner
} from './cosRunnerClient.js';

const mockResponse = (ok, data) => ({
  ok,
  json: vi.fn().mockResolvedValue(data)
});

describe('cosRunnerClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // initCosRunnerConnection
  // ===========================================================================
  describe('initCosRunnerConnection', () => {
    it('should create a socket connection with correct options', () => {
      initCosRunnerConnection();
      expect(io).toHaveBeenCalledWith(
        expect.stringContaining('5558'),
        expect.objectContaining({
          reconnection: true,
          reconnectionAttempts: 10,
          reconnectionDelay: 1000
        })
      );
    });
  });

  // ===========================================================================
  // onCosRunnerEvent
  // ===========================================================================
  describe('onCosRunnerEvent', () => {
    it('should register event handlers', () => {
      const handler = vi.fn();
      onCosRunnerEvent('agent:output', handler);
      // No assertion on internal map, just verify no throw
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // isRunnerAvailable
  // ===========================================================================
  describe('isRunnerAvailable', () => {
    it('should return true when health endpoint returns ok', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { status: 'ok' }));
      const result = await isRunnerAvailable();
      expect(result).toBe(true);
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/health'),
        {},
        10000
      );
    });

    it('should return false when health endpoint returns not ok', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      const result = await isRunnerAvailable();
      expect(result).toBe(false);
    });

    it('should return false when fetch throws', async () => {
      fetchWithTimeout.mockRejectedValue(new Error('Connection refused'));
      const result = await isRunnerAvailable();
      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // getRunnerHealth
  // ===========================================================================
  describe('getRunnerHealth', () => {
    it('should return health data when runner is available', async () => {
      const healthData = { agents: 3, uptime: 1234 };
      fetchWithTimeout.mockResolvedValue(mockResponse(true, healthData));
      const result = await getRunnerHealth();
      expect(result).toEqual({ available: true, agents: 3, uptime: 1234 });
    });

    it('should return unavailable when response is not ok', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      const result = await getRunnerHealth();
      expect(result).toEqual({ available: false, error: 'Runner not available' });
    });

    it('should return unavailable when fetch throws', async () => {
      fetchWithTimeout.mockRejectedValue(new Error('timeout'));
      const result = await getRunnerHealth();
      expect(result).toEqual({ available: false, error: 'Runner not available' });
    });
  });

  // ===========================================================================
  // spawnAgentViaRunner
  // ===========================================================================
  describe('spawnAgentViaRunner', () => {
    it('should POST spawn request and return result', async () => {
      const spawnResult = { agentId: 'a1', pid: 1234 };
      fetchWithTimeout.mockResolvedValue(mockResponse(true, spawnResult));

      const result = await spawnAgentViaRunner({
        agentId: 'a1',
        taskId: 't1',
        prompt: 'do something',
        workspacePath: '/tmp/ws',
        model: 'opus'
      });

      expect(result).toEqual(spawnResult);
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/spawn'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }),
        60000
      );

      // Verify body contains expected fields
      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody.agentId).toBe('a1');
      expect(callBody.taskId).toBe('t1');
      expect(callBody.prompt).toBe('do something');
      expect(callBody.workspacePath).toBe('/tmp/ws');
      expect(callBody.model).toBe('opus');
    });

    it('should throw on non-ok response', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, { error: 'No capacity' }));
      await expect(spawnAgentViaRunner({ agentId: 'a1' }))
        .rejects.toThrow('No capacity');
    });

    it('should use fallback error message when response has no error field', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      await expect(spawnAgentViaRunner({ agentId: 'a1' }))
        .rejects.toThrow('Failed to spawn agent');
    });

    it('should pass cliCommand and cliArgs when provided', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { agentId: 'a1' }));
      await spawnAgentViaRunner({
        agentId: 'a1',
        cliCommand: 'claude',
        cliArgs: ['--model', 'opus']
      });

      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody.cliCommand).toBe('claude');
      expect(callBody.cliArgs).toEqual(['--model', 'opus']);
    });
  });

  // ===========================================================================
  // getActiveAgentsFromRunner
  // ===========================================================================
  describe('getActiveAgentsFromRunner', () => {
    it('should return agents list', async () => {
      const agents = [{ id: 'a1' }, { id: 'a2' }];
      fetchWithTimeout.mockResolvedValue(mockResponse(true, agents));
      const result = await getActiveAgentsFromRunner();
      expect(result).toEqual(agents);
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/agents'),
        {},
        10000
      );
    });

    it('should throw on non-ok response', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      await expect(getActiveAgentsFromRunner()).rejects.toThrow('Failed to get agents');
    });
  });

  // ===========================================================================
  // terminateAgentViaRunner
  // ===========================================================================
  describe('terminateAgentViaRunner', () => {
    it('should POST terminate and return result', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { terminated: true }));
      const result = await terminateAgentViaRunner('agent-123');
      expect(result).toEqual({ terminated: true });
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/terminate/agent-123'),
        { method: 'POST' },
        30000
      );
    });

    it('should throw on failure', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, { error: 'Not found' }));
      await expect(terminateAgentViaRunner('bad-id')).rejects.toThrow('Not found');
    });
  });

  // ===========================================================================
  // killAgentViaRunner
  // ===========================================================================
  describe('killAgentViaRunner', () => {
    it('should POST kill and return result', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { killed: true }));
      const result = await killAgentViaRunner('agent-123');
      expect(result).toEqual({ killed: true });
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/kill/agent-123'),
        { method: 'POST' },
        30000
      );
    });

    it('should throw with fallback message on failure', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      await expect(killAgentViaRunner('bad-id')).rejects.toThrow('Failed to kill agent');
    });
  });

  // ===========================================================================
  // getAgentStatsFromRunner
  // ===========================================================================
  describe('getAgentStatsFromRunner', () => {
    it('should return stats for an agent', async () => {
      const stats = { cpu: 5.2, memory: 128000 };
      fetchWithTimeout.mockResolvedValue(mockResponse(true, stats));
      const result = await getAgentStatsFromRunner('agent-1');
      expect(result).toEqual(stats);
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/agents/agent-1/stats'),
        {},
        10000
      );
    });

    it('should return null on non-ok response', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      const result = await getAgentStatsFromRunner('agent-1');
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // terminateAllAgentsViaRunner
  // ===========================================================================
  describe('terminateAllAgentsViaRunner', () => {
    it('should POST terminate-all and return result', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { terminated: 3 }));
      const result = await terminateAllAgentsViaRunner();
      expect(result).toEqual({ terminated: 3 });
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/terminate-all'),
        { method: 'POST' },
        30000
      );
    });

    it('should throw on failure', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      await expect(terminateAllAgentsViaRunner()).rejects.toThrow('Failed to terminate agents');
    });
  });

  // ===========================================================================
  // sendBtwToAgent
  // ===========================================================================
  describe('sendBtwToAgent', () => {
    it('should POST BTW message and return result', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { sent: true }));
      const result = await sendBtwToAgent('agent-1', 'Hey, check this out');
      expect(result).toEqual({ sent: true });
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/btw/agent-1'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }),
        30000
      );

      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody.message).toBe('Hey, check this out');
    });

    it('should throw on failure', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, { error: 'Agent not running' }));
      await expect(sendBtwToAgent('bad-id', 'msg')).rejects.toThrow('Agent not running');
    });
  });

  // ===========================================================================
  // getAgentOutputFromRunner
  // ===========================================================================
  describe('getAgentOutputFromRunner', () => {
    it('should return agent output', async () => {
      const output = { output: 'Hello world', lines: 10 };
      fetchWithTimeout.mockResolvedValue(mockResponse(true, output));
      const result = await getAgentOutputFromRunner('agent-1');
      expect(result).toEqual(output);
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/agents/agent-1/output'),
        {},
        10000
      );
    });

    it('should throw on failure', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, { error: 'Not found' }));
      await expect(getAgentOutputFromRunner('bad-id')).rejects.toThrow('Not found');
    });
  });

  // ===========================================================================
  // executeCliRunViaRunner
  // ===========================================================================
  describe('executeCliRunViaRunner', () => {
    it('should POST run request and return result', async () => {
      const runResult = { runId: 'r1', started: true };
      fetchWithTimeout.mockResolvedValue(mockResponse(true, runResult));

      const result = await executeCliRunViaRunner({
        runId: 'r1',
        command: 'npm',
        args: ['test'],
        prompt: 'run tests',
        workspacePath: '/tmp/ws',
        timeout: 30000
      });

      expect(result).toEqual(runResult);
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/run'),
        expect.objectContaining({ method: 'POST' }),
        60000
      );

      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody.runId).toBe('r1');
      expect(callBody.command).toBe('npm');
      expect(callBody.args).toEqual(['test']);
    });

    it('should throw on failure', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, { error: 'No slots' }));
      await expect(executeCliRunViaRunner({ runId: 'r1' })).rejects.toThrow('No slots');
    });
  });

  // ===========================================================================
  // getActiveRunsFromRunner
  // ===========================================================================
  describe('getActiveRunsFromRunner', () => {
    it('should return active runs', async () => {
      const runs = [{ id: 'r1' }, { id: 'r2' }];
      fetchWithTimeout.mockResolvedValue(mockResponse(true, runs));
      const result = await getActiveRunsFromRunner();
      expect(result).toEqual(runs);
    });

    it('should throw on failure', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      await expect(getActiveRunsFromRunner()).rejects.toThrow('Failed to get runs');
    });
  });

  // ===========================================================================
  // isRunActiveInRunner
  // ===========================================================================
  describe('isRunActiveInRunner', () => {
    it('should return true when run is active', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { active: true }));
      const result = await isRunActiveInRunner('r1');
      expect(result).toBe(true);
    });

    it('should return false when run is not active', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { active: false }));
      const result = await isRunActiveInRunner('r1');
      expect(result).toBe(false);
    });

    it('should return false on non-ok response', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      const result = await isRunActiveInRunner('r1');
      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // getRunOutputFromRunner
  // ===========================================================================
  describe('getRunOutputFromRunner', () => {
    it('should return run output', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { output: 'test passed' }));
      const result = await getRunOutputFromRunner('r1');
      expect(result).toBe('test passed');
    });

    it('should return null on non-ok response', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, {}));
      const result = await getRunOutputFromRunner('r1');
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // stopRunViaRunner
  // ===========================================================================
  describe('stopRunViaRunner', () => {
    it('should POST stop and return result', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, { stopped: true }));
      const result = await stopRunViaRunner('r1');
      expect(result).toEqual({ stopped: true });
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/runs/r1/stop'),
        { method: 'POST' },
        30000
      );
    });

    it('should throw on failure', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, { error: 'Not running' }));
      await expect(stopRunViaRunner('r1')).rejects.toThrow('Not running');
    });
  });
});
