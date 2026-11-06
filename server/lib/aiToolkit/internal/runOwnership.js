import { randomUUID } from 'node:crypto';

// Shared by host and toolkit executors; importing a runner does not mint an ID.
let owner;
export const getRunOwner = () => owner ??= Object.freeze({
  id: randomUUID(),
  pid: process.pid,
  startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
});

export const runOwnership = (kind) => ({
  executionOwner: getRunOwner(),
  executionKind: kind,
  // Undefined child identity is deliberately unrecoverable if boot interrupts spawn.
  executionChild: kind === 'api' ? null : { pending: true },
});

export const runChildIdentity = (pid) => ({ pid, startedAt: new Date().toISOString() });
