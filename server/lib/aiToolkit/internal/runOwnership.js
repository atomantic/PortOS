import { randomUUID } from 'node:crypto';

// One identity per server process, shared by the host and toolkit executors.
export const RUN_OWNER = Object.freeze({
  id: randomUUID(),
  pid: process.pid,
  startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
});

export const runOwnership = (kind) => ({
  executionOwner: RUN_OWNER,
  executionKind: kind,
  // Undefined child identity is deliberately unrecoverable if boot interrupts spawn.
  executionChild: kind === 'api' ? null : { pending: true },
});

export const runChildIdentity = (pid) => ({ pid, startedAt: new Date().toISOString() });
