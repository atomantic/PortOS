// Promise-returning `setTimeout`. Every "wait a beat" in the client used to
// hand-roll its own `delay`/inline `new Promise(...)`; point at this instead so
// retry backoffs, race timeouts, and decoder-tick waits all read the same.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
