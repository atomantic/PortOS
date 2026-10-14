import { promisify } from 'util';
import { execFile } from '../lib/childProcess.js';

const exec = promisify(execFile);

async function snapshot() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,pgid=,stat=,lstart=,command='], { timeout: 1000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), state: match[3], startedAt: Date.parse(match[4]), command: match[5] }] : [];
  });
}

async function hasMarker(pid, marker) {
  // Read only the already selected group member; never return or log its env.
  const { stdout } = await exec('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 1000, maxBuffer: 1024 * 1024 });
  return stdout.split(/\s+/).includes(`PORTOS_SECURITY_SCAN_OWNER=${marker}`);
}

/** Revalidate ownership before EACH recovery signal; never trust a stale PID. */
export async function cleanupSecurityScanGroup(owner, { processes = snapshot, marked = hasMarker,
  signal = (pid, value) => process.kill(-pid, value), signalName = 'SIGKILL' } = {}) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 1 || !/^[a-f0-9-]{36}$/.test(owner.marker || '')) return false;
  if (process.platform === 'win32') return false;
  const members = (await processes()).filter(p => p.pgid === owner.pid && !p.state.startsWith('Z'));
  if (!members.length) return true;
  const leader = members.find(p => p.pid === owner.pid);
  const timeMatches = leader && leader.startedAt >= owner.startedAt - 2000 && leader.startedAt <= owner.startedAt + 2000;
  // The leader's private output directory is a per-attempt nonce. If it has
  // exited, descendants must still carry the inherited launch marker. A reused
  // group or an ambiguous observation is left untouched and shown unconfirmed.
  const proven = leader ? timeMatches && leader.command.includes(owner.outputDir)
    : (await Promise.all(members.map(p => marked(p.pid, owner.marker).catch(() => false)))).every(Boolean);
  if (!proven) return false;
  try { signal(owner.pid, signalName); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  // A sent signal is not evidence of cleanup. Confirm quiescence separately.
  const deadline = Date.now() + 1000;
  do {
    const remaining = (await processes()).filter(p => p.pgid === owner.pid && !p.state.startsWith('Z'));
    if (!remaining.length) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}
