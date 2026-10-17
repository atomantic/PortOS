// Autofixer stays independent of the server's process/dependency graph.
export const COMMAND_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 1_000;

/** Observe one direct CLI child. Abort/timeout never implies its daemon stopped. */
export function waitForChild(child, { timeoutMs = COMMAND_TIMEOUT_MS, signal, capture = true } = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopping = false;
    let timedOut = false;
    let timer;
    let cleanupTimer;
    const onStdout = data => { stdout += data.toString(); };
    const onStderr = data => { stderr += data.toString(); };
    const onError = error => { if (!stopping) finish(-1, error); };
    const onClose = code => finish(code);
    const finish = (code, error, cleanupConfirmed = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', stop);
      child.removeListener('close', onClose);
      // Retain the error sink if an unconfirmed child emits a late error.
      if (cleanupConfirmed) child.removeListener('error', onError);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      if (!cleanupConfirmed) {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
      }
      resolve({ code: stopping ? -1 : code, stdout, stderr, error, timedOut, aborted: signal?.aborted === true, cleanupConfirmed });
    };
    const kill = value => {
      try { child.kill(value); }
      catch (error) { console.error(`❌ Autofixer CLI ${value} failed: ${error.message}`); }
    };
    const stop = () => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      cleanupTimer = setTimeout(() => {
        cleanupTimer = setTimeout(() => finish(-1, undefined, false), KILL_GRACE_MS);
        kill('SIGKILL');
      }, KILL_GRACE_MS);
      // These are direct CLI children, never a shell or the managed service.
      kill('SIGTERM');
    };
    if (capture) {
      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
    }
    child.on('close', onClose);
    child.on('error', onError);
    if (timeoutMs !== null) timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}
