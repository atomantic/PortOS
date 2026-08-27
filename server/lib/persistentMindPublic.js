/** Safe client projection for the machine-local persistent-mind state. */

const publicReason = (state) => {
  if (!state.pauseReason) return null;
  if (state.status === 'paused') return 'Paused by user';
  if (state.status === 'degraded' || state.status === 'interrupted') return 'Provider unavailable or wake failed';
  return 'Waiting for the next eligible wake';
};

export function publicPersistentMindState(state = {}) {
  return {
    enabled: state.enabled === true,
    started: state.started === true,
    status: typeof state.status === 'string' ? state.status : 'unknown',
    pauseReason: publicReason(state),
    queuedMessageCount: Array.isArray(state.queuedMessages) ? state.queuedMessages.length : 0,
    activeTurnId: typeof state.activeTurn?.id === 'string' ? state.activeTurn.id : null,
    lastCompletedTurnId: typeof state.lastCompletedTurnId === 'string' ? state.lastCompletedTurnId : null,
    lastCompletedAt: typeof state.lastCompletedAt === 'string' ? state.lastCompletedAt : null,
    nextEligibleWakeAt: typeof state.nextEligibleWakeAt === 'string' ? state.nextEligibleWakeAt : null,
    failureCount: Number.isInteger(state.failureCount) ? state.failureCount : 0,
    lastError: state.lastError ? 'The last wake did not complete; local diagnostics have details' : null,
  };
}
