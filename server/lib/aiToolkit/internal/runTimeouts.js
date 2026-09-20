/**
 * The two ceilings that bound a streaming API run.
 *
 * A leaf module with no imports, because BOTH the runner that arms these timers
 * and any host wrapping `executeApiRun` in its own backstop have to agree on
 * the numbers. Declaring them here rather than in `../runner.js` lets
 * `server/services/promptRunner.js` — reached by ~400 server suites — read the
 * absolute bound without dragging the runner's `fs`/`child_process` closure
 * into every one of them (see server/AGENTS.md → Import scoping).
 */

// No-progress ceiling for an API run when neither the caller nor the provider
// sets one. Mirrors aiProvider's DEFAULT_PROVIDER_TIMEOUT_MS / askService's
// `provider.timeout || 300000` so a hung upstream can't hold `activeRuns`
// (and thus the run slot) open forever.
export const DEFAULT_API_RUN_TIMEOUT_MS = 300000;

// Absolute runtime cap for a STREAMING API run, used when the configured
// no-progress bound is the shorter of the two.
//
// `executeApiRun` used to bound a run with ONE wall-clock timer, which could
// not tell a provider that opened the stream and STALLED (the leak the ceiling
// exists to prevent) from one that is actively streaming and simply needs
// longer. Both died at the same 300s. A reasoning model spends nearly its whole
// budget in the hidden channel before the first content token — NVIDIA NIM's
// `nvidia/nemotron-3.5-lightning-30b-a3b` sends 126 of 128 frames as
// `reasoning_content` on a TRIVIAL prompt — so a ~26K-token prompt was killed
// mid-generation while healthy and producing (#7560).
//
// The two bounds are now separate, and `provider.timeout` keeps the job the
// single timer was actually written for: catching a provider that went quiet.
// Read as a NO-PROGRESS bound it kills a hung upstream at exactly the moment it
// always did — zero regression in that protection — while a stream that keeps
// yielding bytes is no longer cut off for being slow. This cap is what still
// bounds total runtime, so a provider that trickles one byte per minute cannot
// hold a run slot forever.
export const DEFAULT_API_RUN_MAX_RUNTIME_MS = 1800000;

/**
 * The total-runtime ceiling an API run is ACTUALLY bounded by, given the
 * configured no-progress bound.
 *
 * A host wrapping `executeApiRun` in its own backstop timer has to arm that
 * timer against THIS number, not against `provider.timeout`. PortOS's
 * promptRunner did the latter and so shot every healthy streaming run at
 * `provider.timeout + 2s`, making the 30-minute cap unreachable and
 * reinstating the exact ceiling #7560 removed (#7665). Deriving it in one place
 * keeps the two from drifting apart again.
 *
 * The `Math.max` is load-bearing: an install that deliberately raised
 * `provider.timeout` past the default cap must keep running as long as it asked
 * to, never be clamped DOWN by a ceiling it never configured.
 */
export const apiRunAbsoluteTimeoutMs = (stallTimeout, requestedCap) => {
  const legacy = Math.max(DEFAULT_API_RUN_MAX_RUNTIME_MS, Number(stallTimeout) > 0 ? Number(stallTimeout) : 0);
  // A caller's explicit spending ceiling may only shorten the existing bound.
  return Number.isFinite(requestedCap) && requestedCap > 0 ? Math.min(requestedCap, legacy) : legacy;
};
