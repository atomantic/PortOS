/**
 * `logFailureWithStack(prefix, error, logger)` logs a failure message plus its stack so
 * fire-and-forget errors keep their source location.
 *
 * `logFailureWithStack(prefix, error, logger = console.error)` — logs `${prefix}: ${message}` plus
 * `error.stack` as a second argument, so a fire-and-forget failure (boot init, a scheduled event
 * handler) keeps its source location instead of collapsing to one message-only line (#6934, #7549).
 */

/**
 * Keep a fire-and-forget failure actionable. The message is useful for a quick
 * scan; the stack identifies the source location when the moment of failure is
 * the only time it's reproducible (#6934).
 *
 * @param {string} prefix - Short description of what failed
 * @param {Error|unknown} error - The caught error
 * @param {(...args: unknown[]) => void} [logger] - Defaults to console.error
 */
export function logFailureWithStack(prefix, error, logger = console.error) {
  const message = error?.message ?? String(error);
  logger(`${prefix}: ${message}`, error?.stack || '');
}
