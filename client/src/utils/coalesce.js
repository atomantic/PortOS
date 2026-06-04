// Collapse a burst of rapid calls into a single trailing invocation on a short tick.
// CyberCity subscribes to many socket events (CoS agent spawn/complete, AI status, task
// changes, …); when several fire at once — e.g. a wave of agents spawning — a handler that
// triggers a full refetch per event would fan out N identical refreshes. Wrapping that
// handler in `coalesce` runs it once on the trailing edge instead.
//
// Trailing-edge by design: the LAST call's effect always runs, so state still converges to
// the freshest value — only the redundant intermediate calls are dropped. Call `.cancel()`
// on teardown so a pending flush can't fire after unmount.
export function coalesce(fn, waitMs = 100) {
  let timer = null;
  let lastArgs = [];
  const wrapped = (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...lastArgs);
    }, waitMs);
  };
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  wrapped.pending = () => timer !== null;
  return wrapped;
}
