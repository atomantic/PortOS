import { EventEmitter } from 'node:events';
import { cp } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

const owned = vi.hoisted(() => ({ queries: [], removed: [], child: null, ended: false }));
vi.mock('node:fs/promises', () => ({
  access: vi.fn(), cp: vi.fn(), mkdir: vi.fn(), symlink: vi.fn(), writeFile: vi.fn(),
  lstat: async () => ({ isFile: () => true }),
  mkdtemp: async () => '/tmp/portos-collection-audit-synthetic-lifecycle', realpath: async path => path,
  rm: async path => { owned.removed.push(path); },
}));
vi.mock('node:module', () => ({ createRequire: () => () => ({ Client: function () {
  return { on: vi.fn(), connect: vi.fn(), end: async () => { owned.ended = true; },
    query: async sql => {
      owned.queries.push(sql);
      return { rows: [{ name: 'portos_test' }] };
    } };
} }) }));
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  execFile[Symbol.for('nodejs.util.promisify.custom')] = async () => ({ stdout: 'server/package.json\0lib/fixture.js\0' });
  return { execFile, fork: () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = { resume: vi.fn() };
    child.kill = vi.fn(signal => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
    });
    owned.child = child;
    return child;
  } };
});
import { startCollectionFixture } from './collectionFixture.js';

afterEach(() => vi.useRealTimers());

it('a stalled fixture rejects and removes only its owned schema, root, child and listeners', async () => {
  vi.useFakeTimers();
  const beforeSignals = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
  const ready = startCollectionFixture({ env: {}, clientDist: '/synthetic-client' });
  const failure = expect(ready).rejects.toMatchObject({ fixtureFailure: 'startup-stalled',
    fixtureStartup: { noProgressTimeoutMs: 10000, overallTimeoutMs: 30000 } });
  await vi.advanceTimersByTimeAsync(10000);
  await failure;
  const create = owned.queries.find(sql => sql.startsWith('CREATE SCHEMA'));
  expect(create).toMatch(/^CREATE SCHEMA "collection_audit_[a-f0-9]{32}"$/);
  expect(owned.queries).toContain(create.replace('CREATE SCHEMA', 'DROP SCHEMA') + ' CASCADE');
  expect(owned.queries).toHaveLength(3);
  expect(owned.removed).toEqual(['/tmp/portos-collection-audit-synthetic-lifecycle']);
  expect(owned.ended).toBe(true);
  expect(owned.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(owned.child.eventNames()).toEqual([]);
  expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(beforeSignals);
  expect(vi.getTimerCount()).toBe(0);
});

it('waits for sibling source copies before removing a failed fixture', async () => {
  const slowCopy = Promise.withResolvers();
  const slowCopyStarted = Promise.withResolvers();
  const previousRemovals = owned.removed.length;
  vi.mocked(cp)
    .mockRejectedValueOnce(new Error('source copy failed'))
    .mockImplementationOnce(async () => {
      slowCopyStarted.resolve();
      await slowCopy.promise;
    });

  const result = startCollectionFixture({ env: {}, clientDist: '/synthetic-client' });
  const failure = expect(result).rejects.toThrow('source copy failed');
  await slowCopyStarted.promise;
  try {
    // Let the rejected copy propagate before checking that cleanup still waits.
    await new Promise(resolve => setImmediate(resolve));
    expect(owned.removed).toHaveLength(previousRemovals);
  } finally {
    slowCopy.resolve();
    await failure;
  }
  expect(owned.removed).toHaveLength(previousRemovals + 1);
});
