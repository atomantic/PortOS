/** POSIX group leader: acquire the journal entry before starting the fixed CLI. */
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from '../../scripts/lib/directInvocation.js';
import { spawn } from '../lib/childProcess.js';
import { safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { getProviderRuntime, spawnRuntimeInstaller } from './providerRuntimeInstaller.js';

const script = fileURLToPath(import.meta.url);
const MAX_INPUT = 32 * 1024;
const AUTH_TIMEOUT_MS = 15_000;

/** The payload is private server-owned evidence, never a request-supplied command. */
export function spawnHarnessActionSupervisor(input, { spawnImpl = spawn } = {}) {
  const payload = JSON.stringify(input);
  const child = spawnImpl(process.execPath, [script], safeChildProcessOptions({
    env: safeChildProcessEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], shell: false,
  }));
  // A spawn failure can close stdin before the JSON is delivered. The child's
  // error/close handlers, installed by the caller, own the visible failure.
  child.stdin.on('error', () => {});
  try { child.stdin.end(payload); } catch (error) { child.stdin.destroy(error); }
  return child;
}

async function matches(runtime, proof) {
  const { matchesHarnessUpdateTicket } = await import('./harnessUpdateReference.js');
  return matchesHarnessUpdateTicket(runtime, proof);
}

function permissionFromParent(ownerId, signal) {
  return new Promise((resolve, reject) => {
    if (!process.connected || typeof process.send !== 'function') return reject(new Error('Harness action parent is unavailable.'));
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onMessage = message => done(message?.type === 'harness-action-go' && message.ownerId === ownerId
      ? null : new Error('Harness action permission changed.'));
    const onDisconnect = () => done(new Error('Harness action parent disconnected.'));
    const onAbort = () => done(new Error('Harness action cancelled.'));
    const timer = setTimeout(() => done(new Error('Harness action permission expired.')), AUTH_TIMEOUT_MS);
    process.once('message', onMessage);
    process.once('disconnect', onDisconnect);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    try { process.send({ type: 'harness-action-ready', ownerId }, error => { if (error) done(error); }); }
    catch (error) { done(error); }
  });
}

function waitForDrainPermission(ownerId, signal) {
  return new Promise((resolve, reject) => {
    if (!process.connected || typeof process.send !== 'function') return reject(new Error('Harness action parent is unavailable.'));
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true;
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onMessage = message => done(message?.type === 'harness-action-finish' && message.ownerId === ownerId
      ? null : new Error('Harness action settlement permission changed.'));
    const onDisconnect = () => done(new Error('Harness action parent disconnected.'));
    const onAbort = () => done(new Error('Harness action cancelled.'));
    process.once('message', onMessage);
    process.once('disconnect', onDisconnect);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    try { process.send({ type: 'harness-action-draining', ownerId }, error => { if (error) done(error); }); }
    catch (error) { done(error); }
  });
}

/** Keep the group leader alive during cancellation so escalation cannot hit a reused PID. */
export function installHarnessActionShutdown({ graceMs = 5000 } = {}) {
  let stopping = false;
  const controller = new AbortController();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    controller.abort(new Error('Harness action cancelled.'));
    try { process.kill(-process.pid, 'SIGTERM'); } catch { /* already gone */ }
    // This referenced timer keeps the original group leader alive until the
    // force signal, including when the direct vendor process exits first.
    setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { /* already gone */ } }, graceMs);
  };
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
  // The owner's death closes its output pipes. An unhandled EPIPE must not
  // kill the group leader before its bounded teardown timer can run.
  process.stdout.on('error', stop);
  process.stderr.on('error', stop);
  const close = () => {
    if (stopping) return;
    process.off('SIGTERM', stop);
    process.off('disconnect', stop);
    process.stdout.off('error', stop);
    process.stderr.off('error', stop);
    if (process.connected) process.disconnect();
  };
  return { signal: controller.signal, close };
}

export async function runHarnessActionSupervisor(input, { admission = maintenance, runtimeFor = getProviderRuntime,
  matchesReview = matches, authorize = permissionFromParent, drain = waitForDrainPermission, launch = spawnRuntimeInstaller,
  out = process.stdout, err = process.stderr, supervisorPid = process.pid, signal } = {}) {
  signal?.throwIfAborted();
  const row = runtimeFor(input?.runtime);
  const owner = admission.harnessActions.operation();
  if (!row || !owner || owner.id !== input?.ownerId || owner.runtime !== row.id || owner.action !== input?.action) throw new Error('Harness action ownership is unavailable.');
  if (input.reviewed && !await matchesReview(row, input.reviewed)) throw new Error('The reviewed executable or ticket changed.');
  signal?.throwIfAborted();
  admission.harnessActions.enter(owner.id, supervisorPid);
  await authorize(owner.id, signal);
  signal?.throwIfAborted();
  // The first check may have taken time and the ticket may have expired. The
  // second check immediately precedes the final journal observation and spawn.
  if (input.reviewed && !await matchesReview(row, input.reviewed)) throw new Error('The reviewed executable or ticket changed.');
  signal?.throwIfAborted();
  admission.harnessActions.verify(owner.id, supervisorPid);
  signal?.throwIfAborted();
  const child = launch(row.id, { action: owner.action, detached: false,
    ...(input.reviewed ? { verifiedCommand: input.reviewed.identity.path } : {}) });
  if (!child) throw new Error('The harness action is unavailable.');
  let outputFailed = false;
  child.stdout.on('error', () => { outputFailed = true; });
  child.stderr.on('error', () => { outputFailed = true; });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(err, { end: false });
  const code = await new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('close', code => resolve(Number.isInteger(code) ? code : 1));
  });
  // Keep the original group leader available for safe cancellation until the
  // parent has observed that no other members remain in this group.
  await drain(owner.id, signal);
  return outputFailed ? 1 : code;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) throw new Error('Harness action input is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

if (isDirectlyInvoked(import.meta.url)) {
  const shutdown = installHarnessActionShutdown();
  readInput().then(input => runHarnessActionSupervisor(input, { signal: shutdown.signal })).then(code => { process.exitCode = code; }).catch(() => {
    // Spawn failures can include an account-specific executable path. The
    // parent reports the failure without exposing internal path evidence.
    if (!shutdown.signal.aborted) console.error('❌ Harness action could not start or complete.');
    process.exitCode = 1;
  }).finally(shutdown.close);
}
