/**
 * Provider-fallback recovery handlers, registered at boot by `initAutoFixer()`.
 *
 * `promptRunner.js` tells the auto-fixer when a fallback cascade starts,
 * recovers, gives up or must escalate. It used to `import('./autoFixer.js')`
 * for that, which kept the CoS stack out of its static closure but not out of
 * CI selection: `vitest related` follows lazy imports, so every suite reaching
 * promptRunner.js joined the CoS cluster's selection (#12285). This leaf
 * breaks that edge. With nothing registered (a process or suite that never
 * initialized the auto-fixer) the notifications are skipped, which is also
 * what the auto-fixer's own deferred tasks need: none exist without it.
 */
let handlers = null;

/**
 * @param {{ noteFallbackStarted: Function, noteFallbackFailed: Function,
 *   noteFallbackHandled: Function, escalateProviderFailure: Function }} next
 * @returns {() => void} unregister (only if still the registered set)
 */
export function registerProviderRecoveryHandlers(next) {
  handlers = next;
  return () => {
    if (handlers === next) handlers = null;
  };
}

export function getProviderRecoveryHandlers() {
  return handlers;
}
