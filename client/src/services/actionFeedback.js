// Instant feedback for taps that wait on the server. A request started from a
// button's click (or a form's submit) marks that button `data-pending` until
// the request settles, so every action button shows it is working the moment
// it is tapped, with no per-component state. `request()` reports each call
// here; nothing else needs to opt in.

// Element whose click/submit is being dispatched right now. Cleared on the
// next macrotask, which runs after the handler's synchronous body and its
// microtasks, so only requests that handler started are attributed to it.
let currentTrigger = null;
let clearTimer = null;
const pendingByElement = new WeakMap();
let pendingCount = 0;
const listeners = new Set();

const notify = () => {
  for (const listener of listeners) listener();
};

const setTrigger = (element) => {
  if (!element) return;
  currentTrigger = element;
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => { currentTrigger = null; }, 0);
};

const triggerFromEvent = (event) => {
  if (event.type === 'submit') {
    // Some engines report the form itself as the submitter of requestSubmit().
    const { submitter } = event;
    if (submitter && submitter !== event.target) return submitter;
    return event.target?.querySelector?.('button[type="submit"], button:not([type])') ?? null;
  }
  return event.target?.closest?.('button, [role="button"]') ?? null;
};

let installed = false;
export function installActionFeedback(doc = globalThis.document) {
  if (installed || !doc) return;
  installed = true;
  const capture = (event) => setTrigger(triggerFromEvent(event));
  doc.addEventListener('click', capture, true);
  doc.addEventListener('submit', capture, true);
}

// Elements whose aria-busy this module set, so a component that manages its
// own aria-busy (RunTaskButton, RunActionButton) never has it removed here.
const ownsAriaBusy = new WeakSet();

const markPending = (element, delta) => {
  const count = (pendingByElement.get(element) ?? 0) + delta;
  if (count > 0) {
    pendingByElement.set(element, count);
    element.setAttribute('data-pending', 'true');
    if (!element.hasAttribute('aria-busy')) {
      element.setAttribute('aria-busy', 'true');
      ownsAriaBusy.add(element);
    }
  } else {
    pendingByElement.delete(element);
    element.removeAttribute('data-pending');
    if (ownsAriaBusy.delete(element)) element.removeAttribute('aria-busy');
  }
};

// Wraps one in-flight request. Returns the same promise.
export function trackRequest(promise) {
  const element = currentTrigger;
  if (!element) return promise;
  markPending(element, 1);
  pendingCount += 1;
  notify();
  const settle = () => {
    markPending(element, -1);
    pendingCount -= 1;
    notify();
  };
  promise.then(settle, settle);
  return promise;
}

// Count of tap-started requests still in flight, for the global activity bar.
export const getPendingActionCount = () => pendingCount;
export function subscribePendingActions(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
