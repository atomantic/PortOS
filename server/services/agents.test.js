import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing agents.js
vi.mock('child_process', () => ({
  exec: vi.fn()
}));

// Mock util.promisify so execAsync uses our mocked exec
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    promisify: (fn) => {
      // Return a wrapper that calls the mocked fn as a promise
      return (...args) =>
        new Promise((resolve, reject) => {
          fn(...args, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
    }
  };
});

// Mock subAgentSpawner so killProcess CoS delegation doesn't import real code
vi.mock('./subAgentSpawner.js', () => ({
  killAgent: vi.fn().mockResolvedValue({ success: true })
}));

import { exec } from 'child_process';
import {
  registerSpawnedAgent,
  unregisterSpawnedAgent,
  getRunningAgents,
  killProcess,
  getProcessInfo
} from './agents.js';

// Helper to simulate exec callback.
// By default, returns stdout unconditionally. Tests that care about which pattern
// triggered the exec call should pass a conditional function:
//   mockExecWith((cmd) => cmd.includes('claude') ? '<claude line>' : '')
function mockExecWith(stdoutOrFn) {
  exec.mockImplementation((_cmd, _opts, cb) => {
    // handle both (cmd, cb) and (cmd, opts, cb) forms
    const callback = typeof _opts === 'function' ? _opts : cb;
    const stdout = typeof stdoutOrFn === 'function' ? stdoutOrFn(_cmd) : stdoutOrFn;
    callback(null, { stdout });
  });
}

describe('agents.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // registerSpawnedAgent / unregisterSpawnedAgent — module-level Map
  // ===========================================================================
  describe('registerSpawnedAgent / unregisterSpawnedAgent', () => {
    // Clean up any PIDs registered by tests in this describe so they don't
    // leak into subsequent tests via the module-level spawnedAgentCommands Map.
    afterEach(() => {
      unregisterSpawnedAgent(12345);
      unregisterSpawnedAgent(99999);
    });

    it('registers metadata and surfaces it in getRunningAgents', async () => {
      // Provide ps output that matches the claude pattern
      mockExecWith('12345  1001  0.5  0.3  01:00  /usr/bin/claude --print\n');

      registerSpawnedAgent(12345, {
        agentId: 'agent-abc',
        taskId: 'task-xyz',
        model: 'claude-3-opus',
        workspacePath: '/tmp/ws',
        fullCommand: '/usr/bin/claude --model opus --print',
        prompt: 'do something'
      });

      const agents = await getRunningAgents();
      const found = agents.find(a => a.pid === 12345);
      expect(found).toBeDefined();
      expect(found.agentId).toBe('agent-abc');
      expect(found.taskId).toBe('task-xyz');
      expect(found.model).toBe('claude-3-opus');
      expect(found.source).toBe('cos');
      expect(found.command).toBe('/usr/bin/claude --model opus --print');
    });

    it('unregisters agent so it no longer has cos metadata', async () => {
      mockExecWith('12345  1001  0.5  0.3  01:00  /usr/bin/claude --print\n');

      registerSpawnedAgent(12345, {
        agentId: 'agent-abc',
        taskId: 'task-xyz',
        model: 'claude-3-opus',
        workspacePath: '/tmp/ws',
        fullCommand: '/usr/bin/claude --model opus',
        prompt: 'task'
      });

      unregisterSpawnedAgent(12345);

      const agents = await getRunningAgents();
      const found = agents.find(a => a.pid === 12345);
      // The mocked ps output always includes PID 12345 so found must be defined.
      // After unregistering, the process appears without CoS metadata.
      expect(found).toBeDefined();
      expect(found.agentId).toBeUndefined();
      expect(found.source).toBeUndefined();
    });

    it('killProcess delegates to CoS killAgent for a registered PID', async () => {
      // Register PID 99999 so killProcess detects it as a CoS-spawned agent
      registerSpawnedAgent(99999, {
        agentId: 'agent-ts',
        taskId: 'task-ts',
        model: 'claude-3-sonnet',
        workspacePath: '/tmp',
        fullCommand: 'claude',
        prompt: 'hello'
      });

      // killProcess for a registered PID should delegate to killAgent (mocked above)
      await killProcess(99999);

      // Verify the CoS killAgent mock was invoked with the registered agentId —
      // this proves the registry entry is live and used by killProcess.
      const { killAgent } = await import('./subAgentSpawner.js');
      expect(killAgent).toHaveBeenCalledWith('agent-ts');
    });
  });

  // ===========================================================================
  // getRunningAgents — ps output parsing
  // ===========================================================================
  describe('getRunningAgents', () => {
    it('parses pid, cpu, memory, and command from ps output for claude pattern', async () => {
      // Use a command-conditional mock: only return output when the exec command
      // actually searches for the 'claude' pattern — verifying command construction.
      mockExecWith((cmd) =>
        cmd.includes('claude') ? '42000  1  2.5  0.8  05:30  /usr/local/bin/claude --model opus\n' : ''
      );

      const agents = await getRunningAgents();
      const a = agents.find(a => a.pid === 42000);
      expect(a).toBeDefined();
      expect(a.cpu).toBe(2.5);
      expect(a.memory).toBe(0.8);
      expect(a.agentName).toBe('Claude');
      expect(a.agentType).toBe('claude');
      expect(a.command).toBe('/usr/local/bin/claude --model opus');
    });

    it('returns empty array when ps returns no output', async () => {
      mockExecWith('');

      const agents = await getRunningAgents();
      expect(agents).toEqual([]);
    });

    it('sorts agents newest-first by startTime', async () => {
      // Two claude processes: one older (10:00 elapsed), one newer (01:00 elapsed)
      mockExecWith(
        '1001  1  0.1  0.1  10:00  /usr/bin/claude --old\n' +
        '1002  1  0.1  0.1  01:00  /usr/bin/claude --new\n'
      );

      const agents = await getRunningAgents();
      const claudeAgents = agents.filter(a => a.agentType === 'claude');
      // Both mock lines must parse; assert the count so this fails on parsing regressions.
      expect(claudeAgents).toHaveLength(2);
      // Newest-first: PID 1002 (1m elapsed) started more recently than PID 1001 (10m elapsed)
      expect(claudeAgents[0].startTime).toBeGreaterThan(claudeAgents[1].startTime);
    });

    it('skips lines containing "grep" or "ps -eo"', async () => {
      mockExecWith(
        '5000  1  0.0  0.0  00:01  grep claude\n' +
        '5001  1  0.0  0.0  00:01  ps -eo pid command\n' +
        '5002  1  0.5  0.2  01:00  /usr/bin/claude --print\n'
      );

      const agents = await getRunningAgents();
      const pids = agents.map(a => a.pid);
      expect(pids).not.toContain(5000);
      expect(pids).not.toContain(5001);
      expect(pids).toContain(5002);
    });

    it('enriches process with fullCommand when registered', async () => {
      const pid = 55555;
      registerSpawnedAgent(pid, {
        agentId: 'enriched-agent',
        taskId: 'enriched-task',
        model: 'opus',
        workspacePath: '/tmp/enrich',
        fullCommand: 'claude --model opus --print /tmp/prompt.md',
        prompt: 'enrich test'
      });

      mockExecWith(`${pid}  1  1.0  0.5  02:00  claude\n`);
      const agents = await getRunningAgents();
      const found = agents.find(a => a.pid === pid);
      expect(found?.command).toBe('claude --model opus --print /tmp/prompt.md');
      unregisterSpawnedAgent(pid);
    });
  });

  // ===========================================================================
  // killProcess
  // ===========================================================================
  describe('killProcess', () => {
    it('rejects invalid (non-integer) PID', async () => {
      await expect(killProcess('abc')).rejects.toThrow('Invalid PID');
    });

    it('rejects zero PID', async () => {
      await expect(killProcess(0)).rejects.toThrow('Invalid PID');
    });

    it('rejects negative PID', async () => {
      await expect(killProcess(-5)).rejects.toThrow('Invalid PID');
    });

    it('calls kill -9 for a valid PID', async () => {
      exec.mockImplementation((_cmd, _opts, cb) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback(null, { stdout: '' });
      });

      await killProcess(12345);

      const calledWith = exec.mock.calls.find(([cmd]) => cmd.includes('kill'));
      expect(calledWith).toBeDefined();
      expect(calledWith[0]).toContain('12345');
    });
  });

  // ===========================================================================
  // getProcessInfo
  // ===========================================================================
  describe('getProcessInfo', () => {
    it('returns null for invalid PID', async () => {
      const result = await getProcessInfo('notanumber');
      expect(result).toBeNull();
    });

    it('returns null for zero PID', async () => {
      const result = await getProcessInfo(0);
      expect(result).toBeNull();
    });

    it('parses process info from ps -p output', async () => {
      exec.mockImplementation((_cmd, _opts, cb) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback(null, {
          stdout: 'PID  PPID %CPU %MEM ELAPSED COMMAND\n 9999  1001  3.2  0.5  10:30  /usr/bin/claude --print\n'
        });
      });

      const info = await getProcessInfo(9999);
      expect(info).not.toBeNull();
      expect(info.pid).toBe(9999);
      expect(info.ppid).toBe(1001);
      expect(info.cpu).toBe(3.2);
      expect(info.memory).toBe(0.5);
      expect(info.command).toBe('/usr/bin/claude --print');
    });

    it('returns null when ps output has less than 2 lines', async () => {
      exec.mockImplementation((_cmd, _opts, cb) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback(null, { stdout: 'PID PPID CPU MEM ELAPSED COMMAND\n' });
      });

      const result = await getProcessInfo(9999);
      expect(result).toBeNull();
    });
  });
});
