import { promisify } from 'node:util';
import { execFile } from '../../lib/childProcess.js';

const execFileAsync = promisify(execFile);

// Only numeric identity/state are read: command lines can contain private data.
async function liveMembers(pgid, timeout) {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], {
    timeout, maxBuffer: 4 * 1024 * 1024,
  });
  const rows = stdout.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error('Composition browser group observation failed');
    return { pid: Number(match[1]), group: Number(match[2]), state: match[3] };
  });
  if (!rows.some(row => row.pid === process.pid)) throw new Error('Composition browser group observation incomplete');
  return rows.filter(row => row.group === pgid && !row.state.startsWith('Z'));
}

const safeSignal = signal => ['SIGTERM', 'SIGKILL'].includes(signal) ? signal : 'other';
const safePhase = phase => ['shutdown', 'drain'].includes(phase) ? phase : 'other';
const safeCode = code => ['EPERM', 'EACCES', 'EINVAL', 'ENOSYS'].includes(code) ? code : 'other';

export function signalBrowserProcessGroup(pgid, signal, state, phase) {
  if (state.error !== 'none') return;
  const key = signal === 'SIGTERM' ? 'term' : 'kill';
  try {
    process.kill(-pgid, signal);
    state[key] = 'accepted';
  } catch (error) {
    state[key] = error?.code === 'ESRCH' ? 'absent' : 'threw';
    if (error?.code !== 'ESRCH') {
      state.error = safeCode(error?.code);
      state.failedSignal = signal;
      state.failedPhase = phase;
    }
  }
}

// Only a group tied to the retained direct child's observed exit is eligible.
// Zombies cannot write; a live leader at the departed PID means reuse and must
// not be signaled. The caller may still hold an open stdio handle whose `close`
// event is delayed by descendants, so `exit` is the required reaping boundary.
export async function drainBrowserProcessGroup(pgid, deadline, graceMs, state = { error: 'none' }) {
  const failure = message => {
    const code = state.error === 'none' ? 'none' : safeCode(state.error);
    const signal = state.error === 'none' ? 'none' : safeSignal(state.failedSignal);
    const phase = state.error === 'none' ? 'none' : safePhase(state.failedPhase);
    return Object.assign(new Error(`${message} (groupSignalError=${code}, groupFailedSignal=${signal}, groupFailedPhase=${phase})`), { code });
  };
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    throw failure('Composition browser group identity unavailable');
  }
  let termAt;
  let killed = false;
  while (true) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw failure('Composition browser group cleanup exceeded its deadline');
    let members;
    try { members = await liveMembers(pgid, remaining); }
    catch { throw failure('Composition browser group observation failed'); }
    if (!members.length) {
      if (state.error !== 'none') {
        const signal = safeSignal(state.failedSignal);
        const phase = safePhase(state.failedPhase);
        console.warn(`⚠️ Composition browser group quiesced after signal failure (code=${safeCode(state.error)}, signal=${signal}, phase=${phase})`);
      }
      return;
    }
    if (members.some(row => row.pid === pgid)) throw failure('Composition browser group identity changed');
    const signal = termAt === undefined ? 'SIGTERM'
      : !killed && performance.now() - termAt >= graceMs ? 'SIGKILL' : null;
    if (signal && state.error === 'none') {
      signalBrowserProcessGroup(pgid, signal, state, 'drain');
      if (termAt === undefined) termAt = performance.now();
      else killed = true;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now()))));
  }
}
