// Coalesce event bursts into one trailing call with the latest arguments, so
// refreshes converge without duplicate requests. Call .cancel() on teardown
// to prevent a pending flush after unmount.
//
// Trailing-edge coalescer: wraps a function so rapid calls collapse into one deferred invocation.
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
