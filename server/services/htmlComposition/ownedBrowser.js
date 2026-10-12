import { existsSync } from 'node:fs';
import { mkdtemp, rm, access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { browserExecutablePath } from '../../lib/browserConfig.js';
import { isVitestRunner } from '../../lib/runtimeEnv.js';
import { PREVIEW_HOST_RESOLVER_SOCKETS, previewIsolationPlan } from '../../lib/generatedPreviewSandbox.js';
import { createCdpPipeTransport } from './cdpPipe.js';

// Chrome refuses to run as root with its sandbox on. Only a Vitest worker
// running as root (a root dev/CI container) drops it, matching the test-owned
// Chrome launches in testBrowserCleanup.js; production keeps the sandbox.
const sandboxArgs = () => (isVitestRunner() && process.getuid?.() === 0 ? ['--no-sandbox'] : []);

// Raw browser output can hold private paths, so a startup failure names a
// recognized cause instead of copying stderr.
const ROOT_SANDBOX_REFUSAL = /Running as root without --no-sandbox is not supported/;

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

// The preview browser must not inherit API tokens or the database password.
// HOME and PATH stay so Chrome can start; the seatbelt or network namespace
// still denies IP egress.
function previewBrowserEnv() {
  const env = { USER: 'portos-preview' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function readPreviewIsolationSupport() {
  const executable = async (path) => access(path, constants.X_OK).then(() => true, () => false);
  return {
    platform: process.platform,
    seatbeltAvailable: process.platform === 'darwin' && await executable('/usr/bin/sandbox-exec'),
    bubblewrapAvailable: process.platform === 'linux' && await executable('/usr/bin/bwrap'),
    hostResolverSockets: PREVIEW_HOST_RESOLVER_SOCKETS.filter((path) => existsSync(path)),
  };
}

function isolationUnavailable(reason) {
  const error = new Error(reason || 'Generated preview isolation is unavailable on this host');
  error.code = 'PREVIEW_ISOLATION_UNAVAILABLE';
  error.status = 503;
  return error;
}

// Only this child/profile belong to the render. Never discover processes by
// name, attach to a user profile, or restart the managed browsing service.
// `isolation: 'legacy'` keeps the render browser's loopback DevTools port.
// Generated previews pass `'required'` and talk CDP over pipes so loopback IP
// can be denied too. `'off'` exists for the egress negative control.
export async function launchCompositionBrowser({
  signal, startupMs = 20000, shutdownMs = 5000, isolation = 'legacy', support,
} = {}) {
  signal?.throwIfAborted();
  const piped = isolation !== 'legacy';
  const { loadConfig } = await import('../browserService.js');
  const executable = browserExecutablePath(await loadConfig());
  signal?.throwIfAborted();
  if (isolation === 'required' || isolation === 'os') {
    const facts = support || await readPreviewIsolationSupport();
    const probe = previewIsolationPlan({ ...facts, executable, profileDir: '/tmp/portos-preview', isolation });
    if (!probe.supported) throw isolationUnavailable(probe.reason);
  } else if (isolation !== 'legacy' && isolation !== 'off') {
    throw isolationUnavailable('Unknown preview isolation mode');
  }
  const profile = await mkdtemp(join(tmpdir(), 'portos-composition-browser-'));
  let proc;
  let transport;
  let startupPipeError;
  let rejectStartupPipe;
  // Own pipe errors across the startup-to-CDP handoff. The CDP client also
  // subscribes, so this listener must not consume or replace its error path.
  const onPipeError = error => { startupPipeError ??= error; rejectStartupPipe?.(error); };
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
    if (piped) {
      proc?.stdio?.[3]?.destroy();
      proc?.stdio?.[4]?.destroy();
    }
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
  const signalChild = (name) => {
    // sandbox-exec / bwrap wait on Chrome. Signal the group, then the wrapper,
    // so a helper cannot keep the profile open after close.
    if (piped && proc?.pid) {
      try { process.kill(-proc.pid, name); } catch { /* the wrapper kill below still runs */ }
    }
    return proc.kill(name);
  };
  const close = () => closing ??= (async () => {
    signal?.removeEventListener('abort', abort);
    let escalation;
    let deadline;
    try {
      transport?.terminate();
      transport?.removeListener('error', onPipeError);
      if (proc && !closed) {
        terminationStarted = performance.now();
        const tracked = {
          get exitCode() { return proc.exitCode; },
          get signalCode() { return proc.signalCode; },
          kill(name) {
            const key = name === 'SIGTERM' ? 'term' : 'kill';
            termination[key] = 'attempted';
            try {
              const accepted = signalChild(name);
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
    const facts = piped ? (support || await readPreviewIsolationSupport()) : null;
    // Chrome cannot stack its process sandbox inside Seatbelt or bubblewrap:
    // sandbox_init fails with EPERM and the renderer, network, and GPU
    // processes crash. The outer jail is the egress boundary, so only those
    // launches pass --no-sandbox. Legacy renders keep Chrome's sandbox.
    const jailed = isolation === 'required' || isolation === 'os';
    const plan = piped ? previewIsolationPlan({
      ...facts, executable, profileDir: profile, dropSandbox: sandboxArgs().length > 0 || jailed, isolation,
    }) : null;
    if (piped && (isolation === 'required' || isolation === 'os') && !plan.supported) throw isolationUnavailable(plan.reason);
    const command = piped ? plan.command : executable;
    const args = piped ? plan.args : [
      '--headless=new', ...sandboxArgs(), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--mute-audio', '--disable-background-networking', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank',
    ];
    proc = spawn(command, args, piped
      ? { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: previewBrowserEnv(), detached: true }
      : safeChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
    proc.once('spawn', () => { spawned = true; });
    proc.once('exit', onExit);
    proc.once('close', onClose);
    proc.on('error', onError);
    if (piped) {
      transport = createCdpPipeTransport(proc);
      transport.on('error', onPipeError);
    }
    const ready = await new Promise((resolve, reject) => {
      let tail = '';
      const timer = setTimeout(() => finish(new Error('Composition browser startup exceeded its deadline')), startupMs);
      const finish = (error, value) => {
        rejectStartupPipe = null;
        clearTimeout(timer);
        proc.stderr?.removeListener('data', onData);
        transport?.removeListener('message', onHandshake);
        proc.removeListener('error', fail);
        proc.removeListener('exit', stopped);
        signal?.removeEventListener('abort', canceled);
        error ? reject(error) : resolve(value);
      };
      const fail = error => finish(new Error(`Composition browser failed to start (${error.code || 'spawn error'})`));
      const stopped = () => {
        const status = proc.signalCode ? `signal ${proc.signalCode}` : `code ${proc.exitCode ?? 'unknown'}`;
        const cause = ROOT_SANDBOX_REFUSAL.test(tail) ? ': Chrome refuses to run as root with its sandbox enabled' : '';
        finish(new Error(`Composition browser exited during startup (${status})${cause}`));
      };
      const canceled = () => finish(signal.reason ?? new Error('Render canceled'));
      const onData = bytes => {
        tail = (tail + bytes.toString()).slice(-8192);
        if (piped) return;
        // No paths or raw browser output are copied into errors. An endpoint must
        // be loopback and come from this child's complete DevTools line.
        const match = tail.match(/(?:^|\n)DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)\r?\n/);
        if (match) finish(null, match[1]);
      };
      const onHandshake = (bytes) => {
        let message;
        try { message = JSON.parse(bytes.toString()); } catch { return; }
        if (message.id !== 0) return;
        if (message.error) finish(new Error('Composition browser did not answer its startup handshake'));
        else finish(null, message.result || {});
      };
      proc.stderr?.on('data', onData);
      proc.once('error', fail);
      proc.once('exit', stopped);
      signal?.addEventListener('abort', canceled, { once: true });
      if (piped) {
        rejectStartupPipe = () => finish(new Error('Composition browser failed to start (pipe)'));
        transport.on('message', onHandshake);
        transport.send(JSON.stringify({ id: 0, method: 'Browser.getVersion' }), (error) => {
          if (error) finish(new Error('Composition browser failed to start (pipe)'));
        });
      }
      if (signal?.aborted) canceled();
      else if (exited) stopped();
    });
    // Drain subsequent diagnostics without retaining private output or letting
    // Chrome block on a full stderr pipe during a song-length capture.
    proc.stderr?.resume();
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    if (startupPipeError) throw new Error('Composition browser failed to start (pipe)');
    if (piped) return { transport, close, mechanism: plan.mechanism };
    return { webSocketDebuggerUrl: ready, close };
  } catch (error) {
    await close();
    throw error;
  }
}
