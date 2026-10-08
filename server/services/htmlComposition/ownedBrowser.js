import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { browserExecutablePath } from '../../lib/browserConfig.js';

// Chrome helpers (crashpad, GPU) can still be writing into the profile for a
// moment after the browser's close event, so a recursive rm may lose the race
// with ENOTEMPTY/EBUSY. Retry until the directory is really gone, so a resolved
// close always means the profile no longer exists.
const TRANSIENT_RM = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE']);
async function removeProfile(profile, attempts = 20, delayMs = 50) {
  for (let attempt = 1; ; attempt++) {
    try { return await rm(profile, { recursive: true, force: true }); }
    catch (error) {
      if (attempt >= attempts || !TRANSIENT_RM.has(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Only this child/profile belong to the render. Never discover processes by
// name, attach to a user profile, or restart the managed browsing service.
export async function launchCompositionBrowser({ signal, startupMs = 20000, shutdownMs = 5000 } = {}) {
  signal?.throwIfAborted();
  const { loadConfig } = await import('../browserService.js');
  const executable = browserExecutablePath(await loadConfig());
  signal?.throwIfAborted();
  const profile = await mkdtemp(join(tmpdir(), 'portos-composition-browser-'));
  let proc;
  let exited = false;
  let closed = false;
  let spawned = false;
  let closing;
  let profileCleanup;
  let terminationStarted;
  const termination = { term: 'not-attempted', kill: 'not-attempted', error: 'none' };
  const safeSignalError = error => ['EPERM', 'ESRCH', 'EINVAL', 'ENOSYS'].includes(error?.code) ? error.code : 'other';
  const cleanupProfile = () => profileCleanup ??= removeProfile(profile);
  let closeResolve;
  const childClosed = new Promise(resolve => { closeResolve = resolve; });
  const onExit = () => {
    exited = true;
    // Chrome helpers may retain inherited stderr after the browser exits.
    // Release our pipe without signaling unrelated or discovered processes.
    proc?.stderr?.destroy();
  };
  const onClose = () => {
    closed = true;
    // A deadline can reject close() before the OS reports exit. Retain ownership
    // until the eventual close event and remove only this child's profile then.
    cleanupProfile().catch(error => console.error(`❌ Composition browser profile cleanup failed (${safeSignalError(error)})`));
    closeResolve();
  };
  // Child 'error' may also be emitted by kill(). Keep a listener until close.
  const onError = error => {
    termination.error = safeSignalError(error);
    if (!spawned && !proc?.pid) { onExit(); onClose(); }
  };
  const close = () => closing ??= (async () => {
    signal?.removeEventListener('abort', abort);
    let escalation;
    let deadline;
    try {
      if (proc && !closed) {
        terminationStarted = performance.now();
        const tracked = {
          get exitCode() { return proc.exitCode; },
          get signalCode() { return proc.signalCode; },
          kill(signal) {
            const key = signal === 'SIGTERM' ? 'term' : 'kill';
            termination[key] = 'attempted';
            try {
              const accepted = proc.kill(signal);
              termination[key] = accepted ? 'accepted' : 'refused';
              return accepted;
            } catch (error) {
              termination.error = safeSignalError(error);
              termination[key] = 'threw';
              throw error;
            }
          },
        };
        if (!exited) escalation = killWithEscalation(tracked, {
          label: 'Composition browser', delayMs: Math.min(1000, shutdownMs / 2),
          stillRunning: () => !exited,
        });
        await Promise.race([childClosed, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`Composition browser cleanup exceeded its deadline (exit=${exited}, stdioClosed=${Boolean(proc.stderr?.destroyed)}, term=${termination.term}, kill=${termination.kill}, signalError=${termination.error}, elapsedMs=${Math.round(performance.now() - terminationStarted)})`)), shutdownMs);
        })]);
      }
    } finally {
      clearTimeout(escalation);
      clearTimeout(deadline);
      // Wait for the process and our pipe to close before removing its profile.
      if (!proc || closed) {
        proc?.removeListener('error', onError);
        await cleanupProfile();
      }
    }
  })();
  const abort = () => { close().catch(() => {}); };
  try {
    signal?.throwIfAborted();
    proc = spawn(executable, [
      '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--mute-audio', '--disable-background-networking', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank',
    ], safeChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
    proc.once('spawn', () => { spawned = true; });
    proc.once('exit', onExit);
    proc.once('close', onClose);
    proc.on('error', onError);
    const webSocketDebuggerUrl = await new Promise((resolve, reject) => {
      let tail = '';
      const timer = setTimeout(() => finish(new Error('Composition browser startup exceeded its deadline')), startupMs);
      const finish = (error, endpoint) => {
        clearTimeout(timer);
        proc.stderr.removeListener('data', onData);
        proc.removeListener('error', fail);
        proc.removeListener('exit', stopped);
        signal?.removeEventListener('abort', canceled);
        error ? reject(error) : resolve(endpoint);
      };
      const fail = error => finish(new Error(`Composition browser failed to start (${error.code || 'spawn error'})`));
      const stopped = () => finish(new Error('Composition browser exited during startup'));
      const canceled = () => finish(signal.reason ?? new Error('Render canceled'));
      const onData = bytes => {
        tail = (tail + bytes.toString()).slice(-8192);
        // No paths or browser output are copied into errors. An endpoint must
        // be loopback and come from this child's complete DevTools line.
        const match = tail.match(/(?:^|\n)DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)\r?\n/);
        if (match) finish(null, match[1]);
      };
      proc.stderr.on('data', onData);
      proc.once('error', fail);
      proc.once('exit', stopped);
      signal?.addEventListener('abort', canceled, { once: true });
      if (signal?.aborted) canceled();
      else if (exited) stopped();
    });
    // Drain subsequent diagnostics without retaining private output or letting
    // Chrome block on a full stderr pipe during a song-length capture.
    proc.stderr.resume();
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    return { webSocketDebuggerUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}
