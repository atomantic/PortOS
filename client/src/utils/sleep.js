// `sleep(ms)` — promise-returning `setTimeout` for retry backoffs and race timeouts.
//
// Use instead of re-declaring a local `delay`.
//
// Promise-returning `setTimeout`. Every "wait a beat" in the client used to
// hand-roll its own `delay`/inline `new Promise(...)`; point at this instead so
// retry backoffs, race timeouts, and decoder-tick waits all read the same.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
