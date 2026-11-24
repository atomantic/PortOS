/**
 * Classifies a `ps` state as settled: a zombie, or (BSD) one flagged `E`, in kernel exit.
 *
 * macOS answers `kill(-pgid, …)` with EPERM once every member is settled, so group-liveness
 * readers must classify members instead of trusting the errno (#18472).
 */
export const isSettledProcessState = (state) => state.startsWith('Z') || state.includes('E');
