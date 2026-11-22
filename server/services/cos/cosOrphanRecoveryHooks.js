/**
 * Orphaned-agent recovery handlers the CoS daemon calls, registered at boot by
 * `registerBootHooks()` (`services/bootHooks.js`).
 *
 * `agent/agentManagement.js` statically imports `cos.js`, so `cos.js` used to
 * reach back up with a lazy `import('../agent/agentManagement.js')`. That kept
 * the static closure acyclic but not CI selection: `vitest related` follows lazy
 * imports, so the edge held both hubs in one cycle (#12285, #17499). This leaf
 * breaks it and must import nothing. A suite exercising the daemon registers
 * doubles here instead of mocking agentManagement.js.
 */
let handlers = null;

/**
 * @param {{ cleanupOrphanedAgents: () => Promise<number>, handleOrphanedTask: Function }} next
 */
export function registerCosOrphanRecoveryHandlers(next) {
  handlers = next;
}

/**
 * The registered handlers. Throws rather than skipping: orphan recovery is what
 * keeps a dead agent from holding its task forever, so a process that reaches
 * the daemon without boot registration is a wiring defect, not a no-op.
 */
export function requireCosOrphanRecoveryHandlers() {
  if (!handlers) throw new Error('CoS orphan recovery handlers are not registered (registerBootHooks() has not run)');
  return handlers;
}
