// Generic AbortController + timeout lifecycle helper.
//
// `peerFetch` (and Node's `fetch` generally) has no built-in timeout, so callers
// repeatedly hand-rolled the `new AbortController()` + `setTimeout(abort)` +
// `finally{clearTimeout}` triple. `withAbortTimeout` encapsulates that lifecycle
// so the call sites only express what they actually care about: "run this, with
// this signal, bounded to this many ms."

/**
 * Run `fn(signal)` under an `AbortController` that fires after `timeoutMs`,
 * always clearing the timer once `fn` settles (resolve OR reject). `fn`'s return
 * value (or rejection) passes straight through. The timeout bounds the whole
 * callback, so a caller decides what it covers by what it awaits inside `fn` —
 * just the fetch, or the fetch plus its body read.
 */
export async function withAbortTimeout(timeoutMs, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Cancel waiting without cancelling work shared by other callers. The original
 * promise remains rejection-owned; its eventual completion cannot resume this caller.
 */
export function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException('Operation aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}
