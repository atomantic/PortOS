/**
 * The client suite's time budgets, defined in ONE place so the async bound and
 * the budgets enclosing it can never be edited apart.
 *
 * `ASYNC_UTIL_TIMEOUT_MS` bounds every Testing Library async utility —
 * `waitFor`, `findBy*`, and the `settledInput.js` helpers built on them.
 * `TEST_TIMEOUT_MS` bounds the whole test, and the same value bounds a hook.
 * The ORDER matters more than any of the numbers: an inner bound that reaches
 * its enclosing budget can never report its own failure, because the test dies
 * first with a bare "test timed out" naming nothing. That trap has been hit
 * twice here — `WordplayTrainer`'s 5s drill bound against vitest's 5s default,
 * and `BeeperTab`'s `{ timeout: 15000 }`, which could never wait more than 5s
 * and so never helped anything.
 *
 * 5000ms async: Testing Library defaults to 1000ms; this suite ran at 3000
 * (#3474) because several views debounce at 500ms and some wait on a debounce
 * plus a retry. `vitest.config.js` already documented 3s as marginal on the
 * 2-vCPU public runner — that comment is why the client worker cap is 2 — and
 * the `await`-a-mock-call assertions that went red there passed locally every
 * time (#7448). A loaded runner should make a test SLOWER, not red.
 *
 * 15000ms enclosing, as 3x: headroom, not latency. It is not a guarantee that
 * the async bound always gets to speak — three sequential near-budget waits
 * still exhaust it — but it is comfortably clear of the one-wait case that
 * actually bites, and a real hang still reports in ~5s from the async utility,
 * naming what it was waiting on.
 *
 * Raising the async budget is NOT a substitute for fixing an ordering race: it
 * buys a slow runner room, and cannot rescue an assertion waiting on a call
 * that already happened with the wrong argument. See `settledInput.js` and
 * `pageLoadBarrier.js` for that half.
 */
export const ASYNC_UTIL_TIMEOUT_MS = 5000;

export const TEST_TIMEOUT_MS = ASYNC_UTIL_TIMEOUT_MS * 3;
