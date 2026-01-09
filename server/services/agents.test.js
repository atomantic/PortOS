import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for the agents service logic
 *
 * Note: We test the pure functions and logic patterns from agents.js
 * without spawning actual processes.
 */

// Simulate the agent service logic
describe('Agent Service Logic', () => {
  describe('Agent Pattern Matching', () => {
    const AGENT_PATTERNS = [
      { name: 'Claude', pattern: 'claude', command: 'claude' },
      { name: 'Codex', pattern: 'codex', command: 'codex' },
      { name: 'Gemini', pattern: 'gemini', command: 'gemini' },
      { name: 'Aider', pattern: 'aider', command: 'aider' },
      { name: 'Cursor', pattern: 'cursor', command: 'cursor' },
      { name: 'Copilot', pattern: 'copilot', command: 'copilot' }
    ];

    function matchAgentPattern(command) {
      const lowerCommand = command.toLowerCase();
      for (const agent of AGENT_PATTERNS) {
        if (lowerCommand.includes(agent.pattern)) {
          return agent;
        }
      }
      return null;
    }

    it('should match Claude agent process', () => {
      const result = matchAgentPattern('/usr/local/bin/claude --model opus');
      expect(result.name).toBe('Claude');
    });

    it('should match Codex agent process', () => {
      const result = matchAgentPattern('npx codex run task');
      expect(result.name).toBe('Codex');
    });

    it('should match Gemini agent process', () => {
      const result = matchAgentPattern('gemini-cli chat');
      expect(result.name).toBe('Gemini');
    });

    it('should match Aider agent process', () => {
      const result = matchAgentPattern('python -m aider');
      expect(result.name).toBe('Aider');
    });

    it('should return null for non-agent processes', () => {
      const result = matchAgentPattern('node server.js');
      expect(result).toBeNull();
    });

    it('should be case-insensitive', () => {
      const result = matchAgentPattern('CLAUDE --model sonnet');
      expect(result.name).toBe('Claude');
    });
  });

  describe('Elapsed Time Parsing', () => {
    // Unix ps etime format: [[DD-]HH:]MM:SS
    function parseElapsedTime(etime) {
      const parts = etime.split(':').map(p => parseInt(p.replace(/-/g, '')));

      if (etime.includes('-')) {
        // Days-HH:MM:SS format
        const [days, rest] = etime.split('-');
        const timeParts = rest.split(':').map(p => parseInt(p));
        const d = parseInt(days);
        const [h, m, s] = timeParts.length === 3 ? timeParts : [0, ...timeParts];
        return ((d * 24 + h) * 60 + m) * 60 * 1000 + s * 1000;
      }

      if (parts.length === 3) {
        // HH:MM:SS
        return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
      } else if (parts.length === 2) {
        // MM:SS
        return (parts[0] * 60 + parts[1]) * 1000;
      }

      return parts[0] * 1000;
    }

    it('should parse MM:SS format', () => {
      expect(parseElapsedTime('05:30')).toBe((5 * 60 + 30) * 1000);
    });

    it('should parse HH:MM:SS format', () => {
      expect(parseElapsedTime('02:15:45')).toBe((2 * 3600 + 15 * 60 + 45) * 1000);
    });

    it('should parse days-HH:MM:SS format', () => {
      expect(parseElapsedTime('1-02:30:00')).toBe((26 * 3600 + 30 * 60) * 1000);
    });

    it('should parse single digit seconds', () => {
      expect(parseElapsedTime('00:05')).toBe(5 * 1000);
    });

    it('should handle zero time', () => {
      expect(parseElapsedTime('00:00')).toBe(0);
    });
  });

  describe('Runtime Formatting', () => {
    function formatRuntime(ms) {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (days > 0) return `${days}d ${hours % 24}h`;
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    }

    it('should format seconds', () => {
      expect(formatRuntime(45 * 1000)).toBe('45s');
    });

    it('should format minutes and seconds', () => {
      expect(formatRuntime((5 * 60 + 30) * 1000)).toBe('5m 30s');
    });

    it('should format hours and minutes', () => {
      expect(formatRuntime((2 * 3600 + 15 * 60) * 1000)).toBe('2h 15m');
    });

    it('should format days and hours', () => {
      expect(formatRuntime((26 * 3600) * 1000)).toBe('1d 2h');
    });

    it('should handle zero', () => {
      expect(formatRuntime(0)).toBe('0s');
    });
  });

  describe('Spawned Agent Registry', () => {
    let registry;

    beforeEach(() => {
      registry = new Map();
    });

    function registerAgent(pid, data) {
      registry.set(pid, {
        ...data,
        registeredAt: Date.now()
      });
    }

    function unregisterAgent(pid) {
      registry.delete(pid);
    }

    function getAgentData(pid) {
      return registry.get(pid);
    }

    it('should register agent with data', () => {
      registerAgent(12345, {
        agentId: 'agent-001',
        taskId: 'task-001',
        model: 'opus'
      });

      const data = getAgentData(12345);
      expect(data.agentId).toBe('agent-001');
      expect(data.taskId).toBe('task-001');
      expect(data.model).toBe('opus');
      expect(data.registeredAt).toBeDefined();
    });

    it('should unregister agent', () => {
      registerAgent(12345, { agentId: 'agent-001' });
      unregisterAgent(12345);

      expect(getAgentData(12345)).toBeUndefined();
    });

    it('should allow multiple agents', () => {
      registerAgent(111, { agentId: 'agent-001' });
      registerAgent(222, { agentId: 'agent-002' });
      registerAgent(333, { agentId: 'agent-003' });

      expect(registry.size).toBe(3);
    });

    it('should overwrite existing agent with same PID', () => {
      registerAgent(12345, { agentId: 'old-agent' });
      registerAgent(12345, { agentId: 'new-agent' });

      const data = getAgentData(12345);
      expect(data.agentId).toBe('new-agent');
    });
  });

  describe('Process Info Parsing (Unix)', () => {
    function parseProcessLine(line) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;

      const pid = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const etime = parts[4];
      const command = parts.slice(5).join(' ');

      return {
        pid,
        ppid,
        cpu,
        memory: mem,
        etime,
        command
      };
    }

    it('should parse standard ps output line', () => {
      const line = '12345  1001  2.5  0.3  05:30  /usr/bin/claude --model opus';
      const result = parseProcessLine(line);

      expect(result.pid).toBe(12345);
      expect(result.ppid).toBe(1001);
      expect(result.cpu).toBe(2.5);
      expect(result.memory).toBe(0.3);
      expect(result.etime).toBe('05:30');
      expect(result.command).toBe('/usr/bin/claude --model opus');
    });

    it('should handle commands with spaces', () => {
      const line = '12345  1001  0.0  0.1  00:30  node /path/to/script.js --flag value';
      const result = parseProcessLine(line);

      expect(result.command).toBe('node /path/to/script.js --flag value');
    });

    it('should return null for short lines', () => {
      const line = '12345  1001';
      const result = parseProcessLine(line);

      expect(result).toBeNull();
    });
  });

  describe('Process Filtering', () => {
    const mockProcesses = [
      { pid: 1, command: '/usr/bin/claude --model opus' },
      { pid: 2, command: 'grep claude' },
      { pid: 3, command: 'ps -eo pid,command' },
      { pid: 4, command: 'node claude-helper.js' },
      { pid: 5, command: '/bin/aider --edit' }
    ];

    function filterAgentProcesses(processes) {
      return processes.filter(proc => {
        // Skip grep and ps processes
        if (proc.command.includes('grep') || proc.command.includes('ps -eo')) {
          return false;
        }
        return true;
      });
    }

    it('should filter out grep processes', () => {
      const filtered = filterAgentProcesses(mockProcesses);

      expect(filtered.find(p => p.command.includes('grep'))).toBeUndefined();
    });

    it('should filter out ps processes', () => {
      const filtered = filterAgentProcesses(mockProcesses);

      expect(filtered.find(p => p.command.includes('ps -eo'))).toBeUndefined();
    });

    it('should keep actual agent processes', () => {
      const filtered = filterAgentProcesses(mockProcesses);

      expect(filtered.find(p => p.pid === 1)).toBeDefined();
      expect(filtered.find(p => p.pid === 5)).toBeDefined();
    });
  });

  describe('Agent Sorting', () => {
    const mockAgents = [
      { pid: 1, startTime: 1000 },
      { pid: 2, startTime: 3000 },
      { pid: 3, startTime: 2000 }
    ];

    function sortByStartTime(agents) {
      return [...agents].sort((a, b) => b.startTime - a.startTime);
    }

    it('should sort agents by start time (newest first)', () => {
      const sorted = sortByStartTime(mockAgents);

      expect(sorted[0].pid).toBe(2);
      expect(sorted[1].pid).toBe(3);
      expect(sorted[2].pid).toBe(1);
    });

    it('should not mutate original array', () => {
      const original = [...mockAgents];
      sortByStartTime(mockAgents);

      expect(mockAgents[0].pid).toBe(original[0].pid);
    });
  });

  describe('Process Info Enrichment', () => {
    function enrichProcess(proc, spawnedData) {
      if (!spawnedData) return proc;

      return {
        ...proc,
        command: spawnedData.fullCommand || proc.command,
        agentId: spawnedData.agentId,
        taskId: spawnedData.taskId,
        model: spawnedData.model,
        workspacePath: spawnedData.workspacePath,
        source: 'cos'
      };
    }

    it('should add spawned data to process', () => {
      const proc = { pid: 12345, command: 'claude' };
      const spawnedData = {
        fullCommand: 'claude --model opus --print',
        agentId: 'agent-001',
        taskId: 'task-001',
        model: 'opus'
      };

      const enriched = enrichProcess(proc, spawnedData);

      expect(enriched.agentId).toBe('agent-001');
      expect(enriched.taskId).toBe('task-001');
      expect(enriched.model).toBe('opus');
      expect(enriched.source).toBe('cos');
    });

    it('should override command with full command', () => {
      const proc = { pid: 12345, command: 'claude' };
      const spawnedData = { fullCommand: 'claude --model opus --print' };

      const enriched = enrichProcess(proc, spawnedData);

      expect(enriched.command).toBe('claude --model opus --print');
    });

    it('should return original process if no spawned data', () => {
      const proc = { pid: 12345, command: 'claude' };

      const enriched = enrichProcess(proc, null);

      expect(enriched).toEqual(proc);
    });
  });
});
