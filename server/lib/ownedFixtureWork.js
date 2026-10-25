/** Own async fixture callbacks beyond Vitest's timeout/cancellation wrapper. */
export function ownFixtureWork() {
  const pending = new Set();
  const failures = [];
  const phases = new Map();
  const run = (phase, work) => {
    // Phase labels are a closed caller-supplied vocabulary, never paths/argv.
    if (!/^[a-z-]{1,32}$/.test(phase) || (!phases.has(phase) && phases.size === 16)) {
      throw new Error('Invalid fixture phase');
    }
    const row = phases.get(phase) ?? { count: 0, ms: 0, maxMs: 0, active: new Set() };
    phases.set(phase, row);
    const started = performance.now();
    row.active.add(started);
    const workPromise = Promise.resolve().then(work);
    const settled = workPromise.then(() => {}, () => {}).then(() => {
      const elapsed = performance.now() - started;
      row.active.delete(started);
      row.count++;
      row.ms += elapsed;
      row.maxMs = Math.max(row.maxMs, elapsed);
      pending.delete(settled);
    });
    pending.add(settled);
    return workPromise;
  };
  const wrap = (phase, body) => (...args) => run(phase, async () => {
    try { return await body(...args); }
    catch (error) {
      if (args.at(-1)?.signal?.aborted) failures.push(error);
      throw error;
    }
  });
  const tests = register => {
    const owned = (name, body, ...options) => register(name, wrap('test', body), ...options);
    owned.each = cases => tests(register.each(cases));
    owned.skipIf = condition => tests(register.skipIf(condition));
    return owned;
  };
  return {
    run, wrap, tests,
    async drain() {
      while (pending.size) await Promise.all(pending);
      if (failures.length) throw new AggregateError(failures.splice(0), 'Fixture work failed after cancellation');
    },
    reset() {
      if (pending.size) throw new Error('Fixture reset before owned work settled');
      phases.clear();
    },
    summary() {
      const now = performance.now();
      return [...phases].map(([phase, row]) => `${phase}=${Math.round(row.ms)}ms/${row.count} max=${Math.round(row.maxMs)}ms active=${row.active.size} oldest=${Math.round(Math.max(0, ...[...row.active].map(start => now - start)))}ms`).join('; ');
    },
  };
}
