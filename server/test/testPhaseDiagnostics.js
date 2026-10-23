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
  return async (name, operation) => {
    // Only developer-authored labels, never browser content, URLs or errors.
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid test phase label');
    active = name;
    record(name, 'start');
    try {
      const value = await operation();
      record(name, 'done');
      active = 'between-phases';
      return value;
    } catch (error) {
      record(name, 'failed');
      throw error;
    }
  };
}
