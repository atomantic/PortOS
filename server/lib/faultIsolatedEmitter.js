// Wraps a Node `EventEmitter` so a throwing listener cannot suppress the
// other listeners registered for the same emitted event.
//
// `EventEmitter.emit()` invokes listeners for one event synchronously, in
// registration order; if an earlier listener throws, `emit()` propagates
// that exception and every LATER listener for that call is skipped. Several
// PortOS media-gen event buses (`imageGenEvents`, `videoGenEvents`, …) have
// multiple independent listeners per event (socket relay, quota accounting,
// waiter resolution, asset indexing) — a throw in one must not suppress the
// others.
//
// `'error'` keeps Node's default semantics (including throwing when no
// listener is registered) — this helper never touches that event, since an
// unhandled `'error'` emit is a deliberate crash signal, not something to
// swallow.
export function makeEmitterFaultIsolating(emitter) {
  emitter.emit = function faultIsolatedEmit(eventName, ...args) {
    if (eventName === 'error') {
      return Object.getPrototypeOf(emitter).emit.call(emitter, eventName, ...args);
    }
    // `rawListeners` (not `listeners`) returns the internal `once` wrapper,
    // whose self-removal runs before it invokes the real listener — so
    // once-registration semantics survive calling listeners directly here
    // instead of going through the native dispatch loop.
    const listeners = emitter.rawListeners(eventName);
    for (const listener of listeners) {
      try {
        listener.apply(emitter, args);
      } catch (err) {
        // Formatting itself must not throw (a hostile `.message` getter, a
        // Symbol, a value whose `String()` throws) — that would defeat the
        // isolation this loop exists to provide.
        try {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`❌ Listener for '${String(eventName)}' threw: ${message}`);
        } catch {
          console.error(`❌ Listener for '${String(eventName)}' threw (unformattable error)`);
        }
      }
    }
    return listeners.length > 0;
  };
  return emitter;
}
