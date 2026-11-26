/** The two ceilings bounding a streaming API run; a leaf so promptRunner can read them without the runner's closure. */

// No-progress ceiling when neither caller nor provider sets one.
export const DEFAULT_API_RUN_TIMEOUT_MS = 300000;

// Absolute runtime cap for a STREAMING API run: a slow-but-streaming reasoning
// model must not be killed by the no-progress bound, but a trickle still needs a cap.
export const DEFAULT_API_RUN_MAX_RUNTIME_MS = 1800000;

// Hosts wrapping executeApiRun need this same absolute cap and caller override.
// A host backstop based on the stall setting can stop a healthy stream and
// record a user cancellation, which suppresses fallback. The default cap
// cannot undercut a raised stall bound.
export const apiRunAbsoluteTimeoutMs = (stallTimeout, requestedCap) => {
  // Zero is an explicit caller opt-out; omission retains ordinary provider bounds.
  if (requestedCap === 0) return 0;
  const legacy = Math.max(DEFAULT_API_RUN_MAX_RUNTIME_MS, Number(stallTimeout) > 0 ? Number(stallTimeout) : 0);
  // A caller's explicit spending ceiling may only shorten the existing bound.
  return Number.isFinite(requestedCap) && requestedCap > 0 ? Math.min(requestedCap, legacy) : legacy;
};
