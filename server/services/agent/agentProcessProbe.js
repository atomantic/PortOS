/**
 * Checks agent process liveness and resource use across direct and runner-hosted agents.
 */

import { isPidAlive as probePid } from '../../lib/processLiveness.js';
import { activeAgents, runnerAgents, useRunner } from './agentState.js';
import { exec } from '../../lib/childProcess.js';

/**
 * Parse a single CSV row as emitted by `tasklist /FO CSV /NH`.
 * Handles quoted fields (quotes are stripped; commas inside quotes are not splits).
 * Returns an array of unquoted field strings.
 */
function parseTasklistCsvRow(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { fields.push(cur); cur = ''; continue; }
    cur += ch;
  }
  fields.push(cur);
  return fields;
}

/**
 * Get process stats for an agent (CPU, memory usage).
 */
export async function getAgentProcessStats(agentId) {
  const agent = activeAgents.get(agentId);
  if (agent) {
    // TUI agents may have a null pid until the PTY child is fully attached;
    // ps/tasklist with a non-numeric pid produces misleading "dead" output.
    if (!Number.isFinite(agent.pid)) {
      return { active: true, agentId, pid: null, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'unknown' };
    }

    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const psCmd = process.platform === 'win32'
      ? `tasklist /FI "PID eq ${agent.pid}" /FO CSV /NH`
      : `ps -p ${agent.pid} -o pid=,pcpu=,rss=,state=`;
    const result = await execAsync(psCmd).catch(() => ({ stdout: '' }));
    const line = result.stdout.trim();

    if (!line) {
      return { active: false, pid: agent.pid, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'dead' };
    }

    if (process.platform === 'win32') {
      // tasklist /FO CSV /NH columns: Image Name, PID, Session Name, Session#, Memory Usage
      // Memory Usage looks like: 82,156 K (comma as thousands separator, space before K)
      // CPU is not available from basic tasklist; use 0 as an honest default.
      const fields = parseTasklistCsvRow(line);
      if (fields.length >= 5) {
        const pid = parseInt(fields[1], 10);
        const memoryKb = parseInt(fields[4].replace(/,/g, '').replace(/\s*K$/i, '').trim(), 10) || 0;
        return {
          active: true,
          agentId,
          pid,
          cpu: 0,
          memoryKb,
          memoryMb: Math.round(memoryKb / 1024 * 10) / 10,
          state: 'running'
        };
      }
    } else {
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length >= 3) {
        return {
          active: true,
          agentId,
          pid: parseInt(parts[0], 10),
          cpu: parseFloat(parts[1]) || 0,
          memoryKb: parseInt(parts[2], 10) || 0,
          memoryMb: Math.round((parseInt(parts[2], 10) || 0) / 1024 * 10) / 10,
          state: parts[3] || 'unknown'
        };
      }
    }

    return { active: true, agentId, pid: agent.pid, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'unknown' };
  }

  if (runnerAgents.has(agentId) || useRunner) {
    const { getAgentStatsFromRunner } = await import('../cos/cosRunnerClient.js');
    return await getAgentStatsFromRunner(agentId);
  }

  return null;
}

/**
 * Check if a process is running by PID.
 */
export async function isPidAlive(pid) {
  return probePid(pid);
}
