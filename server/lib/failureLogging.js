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
