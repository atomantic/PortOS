// Observe awaited test operations without racing them or changing their deadlines.
// Failure hooks run before suite-owned teardown and survive quiet CI reporters.
export function createTestPhaseDiagnostics(onTestFailed) {
  const started = performance.now();
  const events = [];
  let active = 'not-started';
  let ended = false;
  const record = (name, state) => {
    if (ended) return;
    if (events.length === 24) events.shift();
    events.push(`${name}:${state}@${Math.round(performance.now() - started)}ms`);
  };
  onTestFailed(({ task }) => {
    ended = true;
    const evidence = `Test phases: active=${active}; elapsed=${Math.round(performance.now() - started)}ms; recent=${events.join(',')}`;
    for (const error of task.result.errors) {
      error.message += `\n${evidence}`;
      if (error.stack) error.stack += `\n${evidence}`;
    }
  });
  // Fixture-owned operations still running; a timed-out test abandons its await, not the work.
  const inFlight = new Set();
  const phase = async (name, operation) => {
    // Only developer-authored labels, never browser content, URLs or errors.
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid test phase label');
    active = name;
    record(name, 'start');
    const running = (async () => operation())(); // invoked synchronously, as before
    const tracked = running.then(() => {}, () => {}).finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    try {
      const value = await running;
      record(name, 'done');
      active = 'between-phases';
      return value;
    } catch (error) {
      record(name, 'failed');
      throw error;
    }
  };
  /** Join only the work started through this tracker, bounded so a hung operation cannot wedge teardown. */
  phase.settle = async (timeoutMs = 5000) => {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try { return await Promise.race([Promise.all(inFlight).then(() => true), timeout]); }
    finally { clearTimeout(timer); }
  };
  return phase;
}
