/** Track detached POSIX process groups for server shutdown. */

/**
 * pids of children spawned into their own process group. Detaching moves them out of the server's
 * group, so a group-aimed shutdown signal no longer reaches them; shutdown sweeps this set.
 */
const detachedGroupPids = new Set();

/**
 * Remember a detached child's process group until it closes; returns the child untouched, and does
 * nothing when the spawn was not detached.
 *
 * Cleared on `close`, NOT `exit`: `exit` fires when the wrapper is reaped, while `close` waits for
 * stdio the orphaned harness still holds. A pgid cannot be recycled while its group has a member.
 *
 * @template T
 * @param {T & {pid?: number, once?: Function}} child
 * @param {boolean} processGroup - whether this child was spawned in its own process group
 * @returns {T} the same child, for call-site chaining
 */
export function trackDetachedGroup(child, processGroup) {
  if (!processGroup || !child?.pid || typeof child.once !== 'function') return child;
  const { pid } = child;
  detachedGroupPids.add(pid);
  const forget = () => detachedGroupPids.delete(pid);
  child.once('close', forget);
  child.once('error', forget);
  return child;
}

/**
 * SIGTERM every live detached process group. Best-effort and synchronous (runs in the shutdown
 * window): an already-dead group (ESRCH) is not a fault and nothing may escape a signal handler.
 *
 * @param {NodeJS.Signals} [signal]
 * @param {(label: string, err: Error) => void} [logFailure]
 * @returns {number} how many groups were signalled
 */
export function signalDetachedGroups(signal = 'SIGTERM', logFailure = null) {
  let signalled = 0;
  for (const pid of detachedGroupPids) {
    try { process.kill(-pid, signal); signalled += 1; }
    catch (err) { if (err?.code !== 'ESRCH') logFailure?.(`⚠️ Group ${signal} for pid ${pid}`, err); }
  }
  return signalled;
}

/** Test-only: drop every tracked group without signalling it. */
export function resetDetachedGroupsForTests() {
  detachedGroupPids.clear();
}
