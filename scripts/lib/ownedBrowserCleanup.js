import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, normalize } from 'node:path';

/** Test-only owned Playwright lifecycle shared by the server and client fixtures. */
const timeoutError = ms => Object.assign(new Error(`timed out after ${ms}ms`), { name: 'TimeoutError' });

export const browserCleanupDeadline = (promise, ms, onTimeout) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

// Read only the profile named by this retained child. Never enumerate or remove
// directories, and never include its path or raw filesystem errors in evidence.
const observeOwnedBrowserProfile = (child) => {
  const args = child?.spawnargs ?? [];
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-data-dir') paths.push(args[++i]);
    else if (args[i].startsWith('--user-data-dir=')) paths.push(args[i].slice('--user-data-dir='.length));
  }
  const path = paths[0];
  if (paths.length !== 1 || !path || !isAbsolute(path) || normalize(path) !== path
    || !/^playwright_chromiumdev_profile-[\w-]+$/.test(basename(path))) return () => 'unavailable';
  try {
    if (realpathSync(dirname(path)) !== realpathSync(tmpdir())) return () => 'unavailable';
  } catch { return () => 'unavailable'; }
  return () => {
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) return 'absent';
      return stat.isDirectory() && !stat.isSymbolicLink() ? 'present' : 'changed';
    } catch { return 'unavailable'; }
  };
};

/**
 * Spend the unchanged cleanup budget on graceful close (30%), then Playwright's
 * owned kill (60%). A signal is never success: require exit and settlement of
 * Playwright's close/cleanup promise. Client callers also require profile absence
 * because Playwright can swallow removal errors. Server callers already verify
 * and remove their captured profile separately.
 */
export const reapOwnedBrowser = async (server, budgetMs, { requireProfileRemoval = false } = {}) => {
  const child = server.process();
  const profileState = observeOwnedBrowserProfile(child);
  const exitStatus = () => child?.exitCode ?? child?.signalCode ?? null;
  const pipes = () => [...new Set([...(child?.stdio ?? []), child?.stdout, child?.stderr])].filter(Boolean);
  const phases = [];
  const settlement = { close: 'not-started', kill: 'not-started' };
  let directKill = 'not-needed';
  let closeObserved = false;
  const onClose = () => { closeObserved = true; };
  // Node emits exit before close if a helper retains inherited pipes. Release
  // only this exited child's streams so Playwright's close/cleanup can settle.
  const releaseExitedPipes = () => {
    if (exitStatus() === null) return;
    for (const pipe of pipes()) pipe.destroy?.();
  };
  const snapshot = () => {
    const streams = pipes();
    const closed = streams.filter(pipe => pipe.closed === true).length;
    const destroyed = streams.filter(pipe => pipe.destroyed === true).length;
    return `owner=${child ? 'retained' : 'missing'} exit=${exitStatus() === null ? 'unconfirmed' : 'confirmed'}`
      + ` childClose=${closeObserved ? 'observed' : 'unobserved'} pipes=${streams.length}/${destroyed}-destroyed/${closed}-closed`
      + ` closePromise=${settlement.close} killPromise=${settlement.kill} profile=${profileState()} directKill=${directKill}`;
  };
  const run = async (phase, ms) => {
    const started = Date.now();
    settlement[phase] = 'pending';
    const work = Promise.resolve().then(() => server[phase]()).then(() => {
      settlement[phase] = 'fulfilled';
      if (exitStatus() === null) return 'returned without an exit status';
      if (requireProfileRemoval && profileState() !== 'absent') return 'returned without confirmed profile removal';
      return null;
    }, () => {
      settlement[phase] = 'rejected';
      return 'failed'; // Provider errors can contain profile paths and host identifiers.
    });
    // Playwright signals a process group and swallows dispatch errors before
    // waiting for cleanup. If that path has not established exit halfway
    // through its share, signal only the retained ChildProcess handle. Never
    // search for PIDs or infer success from either signal's return value.
    let fallback;
    if (phase === 'kill' && typeof child?.kill === 'function') {
      fallback = setTimeout(() => {
        if (exitStatus() !== null || settlement.kill !== 'pending') return;
        try { directKill = child.kill('SIGKILL') ? 'sent' : 'refused'; }
        catch { directKill = 'failed'; }
      }, Math.floor(ms / 2));
    }
    const failure = await browserCleanupDeadline(work, ms, () => timeoutError(ms))
      .catch(() => `stalled after ${ms}ms`)
      .finally(() => clearTimeout(fallback));
    phases.push(`${phase} elapsed=${Date.now() - started}ms ${snapshot()}`);
    return failure;
  };
  child?.once?.('exit', releaseExitedPipes);
  child?.once?.('close', onClose);
  try {
    releaseExitedPipes();
    const closeFailure = await run('close', Math.floor(budgetMs * 0.3));
    if (!closeFailure) return phases.join('; ');
    const killFailure = await run('kill', Math.floor(budgetMs * 0.6));
    if (!killFailure) return phases.join('; ');
    const state = exitStatus() !== null ? ' (process exited)' : killFailure.endsWith('exit status') ? '' : ' (no exit status)';
    throw new Error(`browser close ${closeFailure}, then its kill ${killFailure}${state}; cleanup phases: ${phases.join('; ')}`);
  } finally {
    child?.removeListener?.('exit', releaseExitedPipes);
    child?.removeListener?.('close', onClose);
  }
};
