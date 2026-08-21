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
  classifyRunnerSpawnFailure,
  RUNNER_SPAWN_REFUSED,
  RUNNER_SPAWN_AMBIGUOUS,
} from './cosRunnerClient.js';

// The client reads the body via text() and tolerantly JSON.parses it, so a
// non-JSON runner response (e.g. an HTML 500 page) becomes a synthesized
// { error: <raw text> } instead of crashing with "Unexpected token <".
// A string `data` is treated as a raw (possibly non-JSON) body; an object is
// serialized to JSON the way the real runner would respond.
const mockResponse = (ok, data, status = ok ? 200 : 500) => ({
  ok,
  status,
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

  // ===========================================================================
  // Spawn failure discrimination + ambiguous-spawn reconcile (#4615)
  // ===========================================================================
  describe('spawn failures: refusal vs. lost acknowledgement', () => {
    // Route by URL so a spawn POST and the /agents reconcile probe can answer
    // differently within one call.
    const routeFetch = ({ spawn, agents }) => {
      fetchWithTimeout.mockImplementation((url) => {
        if (String(url).includes('/agents')) {
          return typeof agents === 'function' ? agents() : Promise.resolve(mockResponse(true, agents ?? []));
        }
        return typeof spawn === 'function' ? spawn() : Promise.resolve(spawn);
      });
    };
    const transportFailure = () => Promise.reject(new TypeError('fetch failed'));
    const liveCliAgent = { id: 'a1', taskId: 'task-1', pid: 4242, kind: 'cli' };

    it('marks an explicit non-2xx answer as a REFUSAL, carrying the runner status', async () => {
      routeFetch({ spawn: mockResponse(false, { error: 'Command not allowed: grok' }, 400) });

      const err = await spawnAgentViaRunner({ agentId: 'a1' }).catch(e => e);

      expect(err.message).toContain('Command not allowed: grok');
      expect(classifyRunnerSpawnFailure(err)).toBe(RUNNER_SPAWN_REFUSED);
      expect(err.status).toBe(400);
    });

    it('reads a 5xx as AMBIGUOUS — the runner forks the child before its final state write', async () => {
      // `POST /spawn` registers and spawns, THEN persists state and answers. An
      // internal error after that point is answered with a process already
      // running, so a 5xx is no more a refusal than a dropped socket is.
      routeFetch({ spawn: mockResponse(false, { error: 'state write failed' }, 500), agents: [liveCliAgent] });

      const result = await spawnAgentViaRunner({ agentId: 'a1' });

      expect(result).toEqual({ pid: 4242, adopted: true, adoptedReason: 'state write failed' });
    });

    it('still fails a 5xx the runner cannot back with a live agent', async () => {
      routeFetch({ spawn: mockResponse(false, { error: 'state write failed' }, 500), agents: [] });

      const err = await spawnAgentViaRunner({ agentId: 'a1' }).catch(e => e);

      expect(err.message).toBe('state write failed');
      expect(classifyRunnerSpawnFailure(err)).toBe(RUNNER_SPAWN_AMBIGUOUS);
    });

    it('marks a transport failure as AMBIGUOUS, not a refusal', async () => {
      // No answer at all: the runner may have accepted, forked the child, and
      // lost only the acknowledgement. Recording this as a refusal is what
      // strands a live agent with nothing on the server tracking it.
      routeFetch({ spawn: transportFailure, agents: [] });

      const err = await spawnAgentViaRunner({ agentId: 'a1' }).catch(e => e);

      expect(err.message).toContain('fetch failed');
      expect(classifyRunnerSpawnFailure(err)).toBe(RUNNER_SPAWN_AMBIGUOUS);
    });

    it('reads an unlabeled error as ambiguous — only a non-2xx proves a refusal', () => {
      expect(classifyRunnerSpawnFailure(new Error('something else'))).toBe(RUNNER_SPAWN_AMBIGUOUS);
      expect(classifyRunnerSpawnFailure(null)).toBe(RUNNER_SPAWN_AMBIGUOUS);
    });

    it('adopts the live agent when the runner turns out to have it', async () => {
      routeFetch({ spawn: transportFailure, agents: [liveCliAgent] });

      const result = await spawnAgentViaRunner({ agentId: 'a1' });

      expect(result).toEqual({ pid: 4242, adopted: true, adoptedReason: expect.stringContaining('fetch failed') });
    });

    it('rethrows the transport failure when the runner does not have the agent', async () => {
      routeFetch({ spawn: transportFailure, agents: [{ id: 'someone-else', kind: 'cli' }] });

      const err = await spawnAgentViaRunner({ agentId: 'a1' }).catch(e => e);

      expect(err.message).toContain('fetch failed');
      expect(classifyRunnerSpawnFailure(err)).toBe(RUNNER_SPAWN_AMBIGUOUS);
    });

    it('rethrows when the reconcile probe itself cannot be answered', async () => {
      // An unanswerable question is not evidence the agent is alive.
      routeFetch({ spawn: transportFailure, agents: () => Promise.reject(new Error('runner down')) });

      await expect(spawnAgentViaRunner({ agentId: 'a1' })).rejects.toThrow('fetch failed');
    });

    it('does not adopt a TUI record for a CLI spawn of the same id', async () => {
      routeFetch({ spawn: transportFailure, agents: [{ id: 'a1', kind: 'tui', sessionId: 'a1', pid: 9 }] });

      await expect(spawnAgentViaRunner({ agentId: 'a1' })).rejects.toThrow('fetch failed');
    });

    it('never reconciles a refusal — the runner answered, so there is nothing to adopt', async () => {
      routeFetch({ spawn: mockResponse(false, { error: 'Command not allowed: grok' }, 400), agents: [liveCliAgent] });

      await expect(spawnAgentViaRunner({ agentId: 'a1' })).rejects.toThrow('Command not allowed');
      expect(fetchWithTimeout.mock.calls.some(([url]) => String(url).includes('/agents'))).toBe(false);
    });

    it('re-attaches the original TUI handlers to a PTY the runner already had', async () => {
      routeFetch({
        spawn: transportFailure,
        agents: [{ id: 'agent-tui-2', kind: 'tui', sessionId: 'agent-tui-2', pid: 7777 }],
      });
      const onData = vi.fn();

      const session = await spawnTuiSessionViaRunner({
        agentId: 'agent-tui-2',
        taskId: 'task-1',
        command: 'codex',
        args: [],
        onData,
      });

      expect(session).toMatchObject({ sessionId: 'agent-tui-2', pid: 7777, adopted: true });
      // The relay the lost acknowledgement would have discarded is still live:
      // the handler registered before the spawn still receives runner output.
      capturedSocketListeners['tui:output']({ sessionId: 'agent-tui-2', data: 'still working' });
      expect(onData).toHaveBeenCalledWith('still working');
    });

    it('drops the TUI relay when the runner does not have the PTY', async () => {
      routeFetch({ spawn: transportFailure, agents: [] });
      const onData = vi.fn();

      await expect(spawnTuiSessionViaRunner({ agentId: 'agent-tui-3', onData })).rejects.toThrow('fetch failed');

      // Nothing left holding the handlers — a later event for that id is a no-op.
      capturedSocketListeners['tui:output']({ sessionId: 'agent-tui-3', data: 'ghost' });
      expect(onData).not.toHaveBeenCalled();
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
