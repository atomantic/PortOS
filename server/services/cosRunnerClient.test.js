import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Capture the mock socket at creation time so clearAllMocks() doesn't lose it.
// The socket's `on()` stores listener references so we can invoke them later.
let capturedSocket = null;
const capturedSocketListeners = {}; // event → handler fn (survives clearAllMocks)

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const socketOn = (event, fn) => { capturedSocketListeners[event] = fn; };
    capturedSocket = {
      on: vi.fn(socketOn),
      emit: vi.fn(),
      connected: true,
      disconnect: vi.fn()
    };
    return capturedSocket;
  })
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
  isRunnerReachable,
  getRunnerHealth,
  spawnAgentViaRunner,
  getActiveAgentsFromRunner,
  terminateAgentViaRunner,
  killAgentViaRunner,
  getAgentStatsFromRunner,
  terminateAllAgentsViaRunner,
  getAgentOutputFromRunner,
  spawnTuiSessionViaRunner,
  connectTuiSessionViaRunner,
} from './cosRunnerClient.js';

// The client reads the body via text() and tolerantly JSON.parses it, so a
// non-JSON runner response (e.g. an HTML 500 page) becomes a synthesized
// { error: <raw text> } instead of crashing with "Unexpected token <".
// A string `data` is treated as a raw (possibly non-JSON) body; an object is
// serialized to JSON the way the real runner would respond.
const mockResponse = (ok, data) => ({
  ok,
  text: vi.fn().mockResolvedValue(typeof data === 'string' ? data : JSON.stringify(data))
});

describe('cosRunnerClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // initCosRunnerConnection
  // ===========================================================================
  describe('initCosRunnerConnection', () => {
    // The attempt budget is UNBOUNDED on purpose: the runner is a separate PM2
    // app the user can stop for as long as they like, and this socket is the
    // only transport for agent output/completion events. A finite budget (this
    // was 10 attempts at 1s) permanently gave up on a runner that came back a
    // minute later. The delay cap keeps a long outage to one probe every 10s.
    it('should create a socket connection that reconnects indefinitely with capped backoff', () => {
      initCosRunnerConnection();
      expect(io).toHaveBeenCalledWith(
        expect.stringContaining('5558'),
        expect.objectContaining({
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 10000
        })
      );
    });
  });

  // ===========================================================================
  // onCosRunnerEvent
  // ===========================================================================
  describe('onCosRunnerEvent', () => {
    // Ensure initCosRunnerConnection has been called so capturedSocketListeners is populated,
    // even when this describe block runs in isolation without the initCosRunnerConnection tests.
    beforeAll(() => {
      initCosRunnerConnection();
    });

    it('handler is invoked with payload when the socket emits agent:output', () => {
      // capturedSocketListeners stores dispatch fns registered during initCosRunnerConnection.
      // These are plain function references that survive vi.clearAllMocks().
      const handler = vi.fn();
      onCosRunnerEvent('agent:output', handler);

      const payload = { agentId: 'agent-1', line: 'hello from agent' };
      const dispatch = capturedSocketListeners['agent:output'];
      expect(dispatch).toBeDefined();
      dispatch(payload);

      expect(handler).toHaveBeenCalledWith(payload);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('multiple handlers for same event all receive the payload', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      onCosRunnerEvent('agent:completed', h1);
      onCosRunnerEvent('agent:completed', h2);

      const payload = { agentId: 'agent-2', exitCode: 0 };
      const dispatch = capturedSocketListeners['agent:completed'];
      expect(dispatch).toBeDefined();
      dispatch(payload);

      expect(h1).toHaveBeenCalledWith(payload);
      expect(h2).toHaveBeenCalledWith(payload);
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
  // isRunnerReachable — the spawn-path liveness gate
  // ===========================================================================
  describe('isRunnerReachable', () => {
    // This is asked on every dispatch, and during an outage on every dequeue
    // trigger. The socket this module already owns holds the answer, so the
    // steady-state cost must be zero I/O.
    it('reads the socket instead of probing once the connection exists', async () => {
      initCosRunnerConnection();

      await expect(isRunnerReachable()).resolves.toBe(true);
      expect(fetchWithTimeout).not.toHaveBeenCalled();

      capturedSocket.connected = false;
      await expect(isRunnerReachable()).resolves.toBe(false);
      expect(fetchWithTimeout).not.toHaveBeenCalled();

      capturedSocket.connected = true;
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

    it('surfaces a non-JSON error body instead of crashing on "Unexpected token <"', async () => {
      // Simulates the runner returning an HTML 500 page (e.g. PM2 restarting it
      // mid-request) rather than JSON. Parsing it as JSON used to throw.
      fetchWithTimeout.mockResolvedValue(
        mockResponse(false, '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>')
      );
      await expect(spawnAgentViaRunner({ agentId: 'a1' }))
        .rejects.toThrow('502 Bad Gateway');
    });

    it('falls back to the default message when an error body is empty', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(false, ''));
      await expect(spawnAgentViaRunner({ agentId: 'a1' }))
        .rejects.toThrow('Failed to spawn agent');
    });

    it('does not crash on a non-JSON success body', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, 'not json'));
      const result = await spawnAgentViaRunner({ agentId: 'a1' });
      expect(result).toEqual({ error: 'not json' });
    });
  });

  describe('runner-owned TUI relay', () => {
    it('spawns a durable PTY and relays output, input, resize, and exit', async () => {
      fetchWithTimeout.mockResolvedValue(mockResponse(true, {
        sessionId: 'agent-tui-1',
        pid: 4321,
      }));
      const session = await spawnTuiSessionViaRunner({
        agentId: 'agent-tui-1',
        taskId: 'task-1',
        command: 'codex',
        args: [],
        workspacePath: '/tmp/example-workspace',
      });
      const onData = vi.fn();
      const onExit = vi.fn();
      session.ptyProcess.onData(onData);
      session.ptyProcess.onExit(onExit);

      capturedSocketListeners['tui:output']({ sessionId: session.sessionId, data: 'working' });
      session.ptyProcess.write('hello');
      session.ptyProcess.resize(120, 40);
      capturedSocketListeners['tui:exit']({
        sessionId: session.sessionId,
        exitCode: 0,
        signal: 0,
        outputTail: 'immediate startup error',
      });

      expect(onData).toHaveBeenCalledWith('working');
      expect(onExit).toHaveBeenCalledWith({
        exitCode: 0,
        signal: 0,
        outputTail: 'immediate startup error',
      });
      expect(capturedSocket.emit).toHaveBeenCalledWith('tui:input', {
        sessionId: 'agent-tui-1',
        data: 'hello',
      });
      expect(capturedSocket.emit).toHaveBeenCalledWith('tui:resize', {
        sessionId: 'agent-tui-1',
        cols: 120,
        rows: 40,
      });
      expect(JSON.parse(fetchWithTimeout.mock.calls[0][1].body)).toMatchObject({
        agentId: 'agent-tui-1',
        sessionId: 'agent-tui-1',
      });
    });

    it('rebuilds a relay for a TUI discovered after server restart', () => {
      const session = connectTuiSessionViaRunner({ sessionId: 'recovered-tui', pid: 9876 });
      const onData = vi.fn();
      session.ptyProcess.onData(onData);

      capturedSocketListeners['tui:output']({ sessionId: 'recovered-tui', data: 'still alive' });

      expect(session.pid).toBe(9876);
      expect(onData).toHaveBeenCalledWith('still alive');
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
});
