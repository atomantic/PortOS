import { afterEach, expect, it, vi } from 'vitest';
import { createDbPhaseDiagnostics } from './dbPhaseDiagnostics.js';

afterEach(() => vi.useRealTimers());

// A slow observer must not spend a later phase's test budget. Teardown
// still owns its completion before closing the diagnostic connection.
it('settles the operation independently and drains bounded private observations before teardown', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const snapshot = Promise.withResolvers();
  const operation = Promise.withResolvers();
  const observer = { query: vi.fn(() => snapshot.promise) };
  const lines = [];
  const diagnostics = createDbPhaseDiagnostics({ onTestFailed: () => {}, observer, fixturePid: 42,
    enabled: true, write: line => lines.push(line) });
  const run = diagnostics.phase('seed-insert', () => operation.promise);
  await vi.advanceTimersByTimeAsync(5000);
  expect(observer.query).toHaveBeenCalledOnce();
  const [sql, params] = observer.query.mock.calls[0];
  expect(sql).toContain("current_database() = 'portos_test' AND a.datname = 'portos_test'");
  expect(sql).toContain('LIMIT 16');
  expect(params).toEqual([42, 5977002]);
  operation.resolve('original result');
  let settled = false;
  void run.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(5000);
  const settledEvidence = lines.map(line => JSON.parse(line.slice('DB phases: '.length))).find(event => event.state === 'settled');
  expect(settledEvidence.elapsedMs).toBe(5000);
  expect(settled).toBe(true);
  expect(await run).toBe('original result');
  expect(await diagnostics.phase('compact-public-query', () => 'next result')).toBe('next result');
  const failure = new Error('original operation failure');
  await expect(diagnostics.phase('compact-explain', () => { throw failure; })).rejects.toBe(failure);
  expect(observer.query).toHaveBeenCalledOnce();
  let drained = false;
  const drain = diagnostics.drain().then(() => { drained = true; });
  await vi.advanceTimersByTimeAsync(5000);
  expect(drained).toBe(false);
  snapshot.resolve({ rows: [{ fixture: true, state: 'active', wait_event: 'DataFileRead',
    query: 'private query', client_addr: 'private address' }] });
  await drain;
  expect(drained).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(observer.query).toHaveBeenCalledOnce();
  expect(lines.join('\n')).toContain('DataFileRead');
  expect(lines.join('\n')).not.toContain('private');
});

it('retains timeout phase and CPU evidence with at most three snapshots per phase', async () => {
  vi.useFakeTimers();
  const hooks = [];
  const observer = { query: vi.fn(async () => ({ rows: [] })) };
  const operation = Promise.withResolvers();
  const diagnostics = createDbPhaseDiagnostics({ onTestFailed: hook => hooks.push(hook), observer,
    fixturePid: 42, enabled: true, write: () => {} });
  const run = diagnostics.phase('compact-explain', () => operation.promise);
  await vi.advanceTimersByTimeAsync(10000);
  expect(observer.query).toHaveBeenCalledTimes(3);
  const error = { message: 'original timeout', stack: 'original stack' };
  for (const hook of hooks) hook({ task: { result: { errors: [error] } } });
  expect(error.message).toContain('original timeout');
  expect(error.message).toContain('active=compact-explain');
  expect(error.message).toContain('"cpuMs":');
  expect(error.message).toContain('"phase":"compact-explain"');
  operation.resolve();
  await run;
  await diagnostics.drain();
});

it('keeps observation opt-in and preserves operation failures', async () => {
  const observer = { query: vi.fn() };
  const diagnostics = createDbPhaseDiagnostics({ onTestFailed: () => {}, observer, enabled: false });
  const error = new Error('synthetic operation failure');
  await expect(diagnostics.phase('full-public-query', () => { throw error; })).rejects.toBe(error);
  await diagnostics.drain();
  expect(observer.query).not.toHaveBeenCalled();
});
