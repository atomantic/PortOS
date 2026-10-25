import { createTestPhaseDiagnostics } from './testPhaseDiagnostics.js';
import { DB_RUN_ADVISORY_LOCK_KEY } from './dbRunExclusivity.js';

// No SQL text, identities, addresses or record values leave the test database.
const SNAPSHOT_SQL = `SELECT a.pid = $1 AS fixture, count(*) OVER ()::int AS session_count,
  a.state, a.wait_event_type, a.wait_event,
  floor(extract(epoch FROM (clock_timestamp() - a.xact_start)) * 1000)::float8 AS transaction_ms,
  cardinality(pg_blocking_pids(a.pid)) AS blockers,
  (SELECT count(*)::int FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted) AS waiting_locks,
  EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'advisory'
    AND l.classid = 0 AND l.objid = $2 AND l.granted) AS run_lock
  FROM pg_stat_activity a
  WHERE current_database() = 'portos_test' AND a.datname = 'portos_test'
    AND a.backend_type = 'client backend' AND a.pid <> pg_backend_pid()
  ORDER BY fixture DESC, run_lock DESC, a.pid LIMIT 16`;
const fields = ['fixture', 'session_count', 'state', 'wait_event_type', 'wait_event', 'transaction_ms', 'blockers', 'waiting_locks', 'run_lock'];
// Cover the runner's longest (Windows) deadline without an unbounded observer loop.
const MAX_PHASE_SNAPSHOTS = 32;

/** Opt-in observation; after its test bodies settle, the caller drains before closing the observer. */
export function createDbPhaseDiagnostics({ onTestFailed, observer, fixturePid, enabled = false,
  write = line => process.stdout.write(`${line}\n`), intervalMs = 1000 } = {}) {
  const track = createTestPhaseDiagnostics(onTestFailed);
  if (!enabled) return { phase: track, drain: async () => {} };
  const evidence = [];
  let active;
  let pending = Promise.resolve();
  let sampling = false;
  let ended = false;
  const record = event => {
    if (evidence.length === 64) evidence.shift();
    evidence.push(event);
    write(`DB phases: ${JSON.stringify(event)}`);
  };
  const metrics = () => ({ elapsedMs: Math.round(performance.now() - active.started),
    cpuMs: Math.round(Object.values(process.cpuUsage(active.cpu)).reduce((sum, value) => sum + value, 0) / 1000),
    timerDelayMs: Math.round(Math.max(active.timerDelayMs, performance.now() - active.nextSampleAt, 0)) });
  onTestFailed(({ task }) => {
    ended = true;
    active?.stop();
    const summary = `DB phase evidence: ${JSON.stringify({ active: active && { phase: active.name, ...metrics() }, recent: evidence })}`;
    for (const error of task.result.errors) {
      error.message += `\n${summary}`;
      if (error.stack) error.stack += `\n${summary}`;
    }
  });
  const sample = (phase, count) => {
    if (sampling || count.value === MAX_PHASE_SNAPSHOTS) return;
    count.value++;
    sampling = true;
    const name = phase.name;
    const sampleStartedMs = Math.round(performance.now() - phase.started);
    pending = Promise.resolve().then(() => observer.query(SNAPSHOT_SQL, [fixturePid, DB_RUN_ADVISORY_LOCK_KEY])).then(({ rows }) => {
      record({ phase: name, sampleStartedMs, elapsedMs: Math.round(performance.now() - phase.started),
        sessions: rows.map(row => Object.fromEntries(fields.map(key => [key, row[key]]))) });
    }, () => record({ phase: name, sampleStartedMs, snapshot: 'unavailable' })).finally(() => { sampling = false; });
  };
  return {
    phase: (name, operation) => track(name, async () => {
      if (ended) return operation();
      const started = performance.now();
      active = { name, started, cpu: process.cpuUsage(), timerDelayMs: 0, nextSampleAt: started + intervalMs };
      record({ phase: name, state: 'start' });
      const count = { value: 0 };
      // Fast phases need no SQL observation. Keep sampling throughout slow
      // phases: the old three immediate snapshots missed waits after ~2 s.
      const timer = setInterval(() => {
        const now = performance.now();
        active.timerDelayMs = Math.max(active.timerDelayMs, now - active.nextSampleAt);
        active.nextSampleAt = now + intervalMs;
        sample(active, count);
      }, intervalMs);
      timer.unref?.();
      active.stop = () => {
        // Cancellation stops the timer deliberately; later body-drain time
        // must not be reported as an event-loop scheduling delay.
        active.timerDelayMs = metrics().timerDelayMs;
        active.nextSampleAt = Infinity;
        clearInterval(timer);
      };
      try { return await operation(); }
      finally {
        clearInterval(timer);
        record({ phase: name, state: 'settled', ...metrics() });
        active = undefined;
      }
    }),
    // Sampling must not extend the timed operation; teardown owns observer settlement.
    drain: () => pending,
  };
}
