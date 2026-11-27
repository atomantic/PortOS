/** Probe an individual PID without signaling it or confusing it with a process group. */
import { readFileSync } from 'node:fs';

// Node's process.kill accepts only signed 32-bit PIDs.
export const isProbeablePid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff;

// A zombie under a PID 1 that never waits for children still holds a PID slot.
export const isLinuxZombieState = state => state === 'Z' || state === 'X';

export function readLinuxProcessStat(pid) {
  if (!isProbeablePid(pid)) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command in parentheses can contain spaces and closing parentheses.
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd === -1) return null;
    const [state, , group] = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return { state, group: Number(group) };
  } catch {
    return null;
  }
}

function probePid(pid, { kill = process.kill, ignoreLinuxZombies = false } = {}) {
  if (!isProbeablePid(pid)) return 'invalid';
  try {
    kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    return error?.code === 'EPERM' ? 'alive' : 'unknown';
  }
  if (ignoreLinuxZombies && process.platform === 'linux' && isLinuxZombieState(readLinuxProcessStat(pid)?.state)) {
    return 'dead';
  }
  return 'alive';
}

export function isPidAlive(pid, options) {
  return probePid(pid, options) === 'alive';
}

// A PID with an inconclusive probe may still be active. Keep its ownership
// until absence is confirmed, or a caller explicitly allows Linux zombies.
export function isPidPossiblyAlive(pid, options) {
  const status = probePid(pid, options);
  return status === 'alive' || status === 'unknown';
}

export function isPidConfirmedDead(pid, options) {
  return probePid(pid, options) === 'dead';
}
