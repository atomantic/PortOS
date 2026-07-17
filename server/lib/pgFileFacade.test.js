import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the leaf-I/O db module so resolvePgBackend's bring-up sequence is
// observable without a real Postgres. (pgFileFacade imports checkHealth /
// ensureSchema from here.)
const checkHealth = vi.fn();
const ensureSchema = vi.fn(async () => {});
vi.mock('./db.js', () => ({ checkHealth: (...a) => checkHealth(...a), ensureSchema: (...a) => ensureSchema(...a) }));

const { isFileBackend, resolvePgBackend, createPgFileFacade } = await import('./pgFileFacade.js');

const tick = () => new Promise((r) => setImmediate(r));

describe('isFileBackend', () => {
  const orig = { MEMORY_BACKEND: process.env.MEMORY_BACKEND, NODE_ENV: process.env.NODE_ENV };
  afterEach(() => {
    process.env.MEMORY_BACKEND = orig.MEMORY_BACKEND;
    process.env.NODE_ENV = orig.NODE_ENV;
  });

  it('is true under NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.MEMORY_BACKEND;
    expect(isFileBackend()).toBe(true);
  });

  it('is true under MEMORY_BACKEND=file even when not test', () => {
    process.env.NODE_ENV = 'production';
    process.env.MEMORY_BACKEND = 'file';
    expect(isFileBackend()).toBe(true);
  });

  it('is false when neither escape hatch is set', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    expect(isFileBackend()).toBe(false);
  });
});

describe('createPgFileFacade', () => {
  // Runs under NODE_ENV=test → file backend selected.
  it('selects the file backend under the test escape hatch', async () => {
    const makeFile = vi.fn(() => ({ name: 'file' }));
    const makePg = vi.fn(() => ({ name: 'postgres' }));
    const facade = createPgFileFacade({ makeFile, makePg });
    expect(facade.getBackendName()).toBe(null); // before first call
    const b = await facade.getBackend();
    expect(b.name).toBe('file');
    expect(facade.getBackendName()).toBe('file');
    expect(makeFile).toHaveBeenCalledTimes(1);
    expect(makePg).not.toHaveBeenCalled();
  });

  it('memoizes the selection so concurrent first calls build the backend once', async () => {
    let calls = 0;
    const makeFile = vi.fn(async () => { calls += 1; await tick(); return { name: 'file' }; });
    const facade = createPgFileFacade({ makeFile, makePg: vi.fn() });
    const [a, b] = await Promise.all([facade.getBackend(), facade.getBackend()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it('reset() forces a fresh selection', async () => {
    const makeFile = vi.fn(() => ({ name: 'file' }));
    const facade = createPgFileFacade({ makeFile, makePg: vi.fn() });
    await facade.getBackend();
    facade.reset();
    expect(facade.getBackendName()).toBe(null);
    await facade.getBackend();
    expect(makeFile).toHaveBeenCalledTimes(2);
  });

  it('selects the PG backend when the escape hatch is off', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    try {
      const makeFile = vi.fn();
      const makePg = vi.fn(async () => ({ name: 'postgres' }));
      const facade = createPgFileFacade({ makeFile, makePg });
      const b = await facade.getBackend();
      expect(b.name).toBe('postgres');
      expect(makeFile).not.toHaveBeenCalled();
      expect(makePg).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('resolvePgBackend', () => {
  beforeEach(() => { checkHealth.mockReset(); ensureSchema.mockClear(); });

  it('throws the requirement message when the DB is unreachable', async () => {
    checkHealth.mockResolvedValue({ connected: false });
    await expect(resolvePgBackend({
      requirement: 'need pg',
      loadDb: async () => ({}),
      makePg: () => ({ name: 'postgres' }),
    })).rejects.toThrow('need pg');
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it('brings the schema up, runs the migration, then builds from the db module', async () => {
    checkHealth.mockResolvedValue({ connected: true });
    const order = [];
    const migrate = vi.fn(async () => { order.push('migrate'); });
    const loadDb = vi.fn(async () => { order.push('loadDb'); return { readRaw: () => {} }; });
    const makePg = vi.fn((db) => { order.push('makePg'); return { name: 'postgres', db }; });
    ensureSchema.mockImplementation(async () => { order.push('ensureSchema'); });

    const backend = await resolvePgBackend({ requirement: 'x', migrate, loadDb, makePg });
    expect(backend.name).toBe('postgres');
    expect(order).toEqual(['ensureSchema', 'migrate', 'loadDb', 'makePg']);
  });

  it('skips the migration step when none is provided', async () => {
    checkHealth.mockResolvedValue({ connected: true });
    const backend = await resolvePgBackend({
      requirement: 'x',
      loadDb: async () => ({}),
      makePg: () => ({ name: 'postgres' }),
    });
    expect(backend.name).toBe('postgres');
  });
});
