/** Test-only owned Playwright lifecycle shared by the server and client fixtures. */
const timeoutError = ms => Object.assign(new Error(`timed out after ${ms}ms`), { name: 'TimeoutError' });

export const browserCleanupDeadline = (promise, ms, onTimeout) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

// Resolves to null once the work succeeds within `ms`, or else to why it did not.
const failureWithin = (work, ms) => browserCleanupDeadline(
  Promise.resolve().then(work).then(() => null, error => `failed: ${error.message}`),
  ms, () => timeoutError(ms),
).catch(() => `stalled after ${ms}ms`);

/**
 * Closes a browser server the fixture launched, inside `budgetMs`: a graceful
 * close for 30% of it, then the server's own kill for 60%, which signals only
 * the process Playwright spawned (and its process group) and resolves once
 * that process closed and its profile was removed. Each step counts only with
 * the child's exit status in hand, never because a signal was sent; when
 * neither produces one, the close rejects, saying whether the process had
 * exited — the kill then waits on Playwright's own stdio and profile cleanup.
 */
export const reapOwnedBrowser = async (server, budgetMs) => {
  const child = server.process();
  const exitStatus = () => child?.exitCode ?? child?.signalCode ?? null;
  // Node emits 'exit' before 'close' when a browser helper retains inherited
  // pipes. Playwright waits for 'close' before removing its profile, and both
  // server.close() and server.kill() await that cleanup. Release only this
  // exited child's streams so its close/cleanup can actually settle.
  const releaseExitedPipes = () => {
    if (exitStatus() === null) return;
    const pipes = new Set([...(child?.stdio ?? []), child?.stdout, child?.stderr]);
    for (const pipe of pipes) pipe?.destroy?.();
  };
  child?.once?.('exit', releaseExitedPipes);
  try {
    releaseExitedPipes(); // Exit may have occurred before fixture teardown.
    const confirmed = failure => failure ?? (exitStatus() === null ? 'returned without an exit status' : null);
    const closeFailure = confirmed(await failureWithin(() => server.close(), Math.floor(budgetMs * 0.3)));
    if (!closeFailure) return;
    const killFailure = confirmed(await failureWithin(() => server.kill(), Math.floor(budgetMs * 0.6)));
    if (!killFailure) return;
    const exit = exitStatus();
    const state = exit !== null ? ` (process exited with ${exit})` : killFailure.endsWith('exit status') ? '' : ' (no exit status)';
    throw new Error(`browser close ${closeFailure}, then its kill ${killFailure}${state}`);
  } finally {
    child?.removeListener?.('exit', releaseExitedPipes);
  }
};
