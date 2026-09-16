/**
 * The client suite's two time budgets, defined in ONE place so they can never
 * drift into equality.
 *
 * `ASYNC_UTIL_TIMEOUT_MS` bounds every Testing Library async utility —
 * `waitFor`, `findBy*`, and the `settledInput.js` helpers built on them.
 * `TEST_TIMEOUT_MS` bounds the whole test. The ORDER matters more than either
 * value: an inner bound that meets or exceeds the per-test budget can never
 * report its own failure, because the test dies first with a bare "test timed
 * out" naming nothing. That trap has been hit twice here — `WordplayTrainer`'s
 * 5s drill bound against vitest's 5s default, and `BeeperTab`'s `{ timeout:
 * 15000 }` band-aid, which could never wait more than 5s and so never helped.
 *
 * Values, and why:
 *   - 5000ms async. Testing Library defaults to 1000ms; this suite ran at 3000
 *     (#3474) because several views debounce at 500ms and some wait on a
 *     debounce plus a retry. `client/vitest.config.js` already documented 3s as
 *     marginal on the 2-vCPU public runner — that comment is why the client
 *     worker cap is 2 — and shard 1 sat over the line: a different `await`-a-
 *     mock-call assertion went red on most CI runs while passing locally every
 *     time (#7448). A loaded runner should make a test SLOWER, not red.
 *   - 15000ms per test, derived as 3x. Large enough that the async bound above
 *     always gets to speak, small enough that a genuinely hung test still ends
 *     the job. A real hang still reports in ~5s, from the async utility, naming
 *     what it was waiting for; the extra 10s is headroom, not latency.
 *
 * Raising the async budget is NOT a substitute for fixing an ordering race. It
 * buys a slow runner room; it cannot rescue an assertion that is waiting on a
 * call which already happened with the wrong argument. See
 * `client/src/test/settledInput.js` for that half.
 */
export const ASYNC_UTIL_TIMEOUT_MS = 5000;

/** Derived, never written as a literal — equality is the failure mode. */
export const TEST_TIMEOUT_MS = ASYNC_UTIL_TIMEOUT_MS * 3;
