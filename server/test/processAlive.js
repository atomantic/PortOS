import { readFileSync } from 'node:fs';

// Liveness probe for tests that assert a child was killed. `process.kill(pid, 0)`
// succeeds for a ZOMBIE — a dead child nobody has reaped yet. Where PID 1 is not
// an init that reaps orphans (a container or microVM whose entrypoint is the
// app), a killed grandchild stays a zombie forever, so a bare signal-0 probe
// reports "still alive" for a process that is in fact gone. Treat state `Z`
// (Linux /proc) as dead; elsewhere fall back to the signal-0 answer.
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces/parens, so
    // the state letter is the first token after the LAST ')'.
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true;
  }
}
