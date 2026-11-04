import { commandOutput } from '../lib/commandExists.js';

/** True = only the supervisor, false = other members, null = unknown. */
export async function isSupervisorOnly(pid, { run = commandOutput } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const output = await run('/usr/bin/pgrep', ['-g', String(pid), '.'], { timeoutMs: 3000, maxBuffer: 64 * 1024 });
  if (!output || !/^\d+(?:\s+\d+)*\s*$/.test(output)) return null;
  const members = output.trim().split(/\s+/).map(Number);
  if (!members.includes(pid)) return null;
  return members.length === 1 && members[0] === pid;
}
