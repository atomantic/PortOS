import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the leaf-I/O db module so resolvePgBackend's bring-up sequence is
// observable without a real Postgres. (pgFileFacade imports checkHealth /
// ensureSchema from here.)
const checkHealth = vi.fn();
const ensureSchema = vi.fn(async () => {});
vi.mock('./db.js', () => ({ checkHealth: (...a) => checkHealth(...a), ensureSchema: (...a) => ensureSchema(...a) }));

const { isFileBackend, resolvePgBackend, createPgFileFacade, createRecordStoreBackendSelector } = await import('./pgFileFacade.js');

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

describe('createRecordStoreBackendSelector', () => {
  const orig = { MEMORY_BACKEND: process.env.MEMORY_BACKEND, NODE_ENV: process.env.NODE_ENV };
  beforeEach(() => { checkHealth.mockReset(); ensureSchema.mockClear(); });
  afterEach(() => {
    process.env.NODE_ENV = orig.NODE_ENV;
    if (orig.MEMORY_BACKEND === undefined) delete process.env.MEMORY_BACKEND;
    else process.env.MEMORY_BACKEND = orig.MEMORY_BACKEND;
  });

  const loaders = () => ({
    loadFileBackend: vi.fn(async () => ({ listRecords: async () => ['file'] })),
    loadDbBackend: vi.fn(async () => ({ listRecords: async () => ['db'] })),
  });

  it('selects the file backend under NODE_ENV=test without touching the DB', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.MEMORY_BACKEND;
    const { loadFileBackend, loadDbBackend } = loaders();
    const { selectBackend, getBackendName } = createRecordStoreBackendSelector({ label: 'Demo', loadFileBackend, loadDbBackend });
    expect(getBackendName()).toBe(null);
    expect(await (await selectBackend()).listRecords()).toEqual(['file']);
    expect(getBackendName()).toBe('file');
    expect(checkHealth).not.toHaveBeenCalled();
    expect(loadDbBackend).not.toHaveBeenCalled();
  });

  it('selects the file backend under MEMORY_BACKEND=file outside test mode', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MEMORY_BACKEND = 'file';
    const { loadFileBackend, loadDbBackend } = loaders();
    const { selectBackend, getBackendName } = createRecordStoreBackendSelector({ label: 'Demo', loadFileBackend, loadDbBackend });
    await selectBackend();
    expect(getBackendName()).toBe('file');
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('honors a custom isTestMode predicate (the isTestRunner posture) and keeps the file escape hatch', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    const { loadFileBackend, loadDbBackend } = loaders();
    const { selectBackend, getBackendName } = createRecordStoreBackendSelector({
      label: 'Demo', loadFileBackend, loadDbBackend, isTestMode: () => true,
    });
    await selectBackend();
    expect(getBackendName()).toBe('file');
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('still honors MEMORY_BACKEND=file when a custom isTestMode says "not a test"', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MEMORY_BACKEND = 'file';
    const { loadFileBackend, loadDbBackend } = loaders();
    const { selectBackend, getBackendName } = createRecordStoreBackendSelector({
      label: 'Demo', loadFileBackend, loadDbBackend, isTestMode: () => false,
    });
    await selectBackend();
    expect(getBackendName()).toBe('file');
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('brings Postgres up (ensureSchema → onDbReady → import) and memoizes the selection', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    checkHealth.mockResolvedValue({ connected: true });
    const order = [];
    ensureSchema.mockImplementation(async () => { order.push('ensureSchema'); });
    const onDbReady = vi.fn(async () => { order.push('onDbReady'); });
    const loadFileBackend = vi.fn();
    const loadDbBackend = vi.fn(async () => { order.push('loadDb'); return { listRecords: async () => ['db'] }; });

    const { selectBackend, getBackendName } = createRecordStoreBackendSelector({ label: 'Demo', loadFileBackend, loadDbBackend, onDbReady });
    expect(await (await selectBackend()).listRecords()).toEqual(['db']);
    await selectBackend();

    expect(order).toEqual(['ensureSchema', 'onDbReady', 'loadDb']);
    expect(getBackendName()).toBe('postgres');
    expect(loadFileBackend).not.toHaveBeenCalled();
    expect(checkHealth).toHaveBeenCalledTimes(1);
  });

  it('throws the store-specific requirement message when Postgres is unreachable', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    checkHealth.mockResolvedValue({ connected: false });
    const { loadFileBackend, loadDbBackend } = loaders();
    const { selectBackend, getBackendName } = createRecordStoreBackendSelector({
      label: 'Demo', loadFileBackend, loadDbBackend, requireDbMessage: 'Demo requires PostgreSQL — custom',
    });
    await expect(selectBackend()).rejects.toThrow('Demo requires PostgreSQL — custom');
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(getBackendName()).toBe(null);
  });

  it('falls back to a labeled default requirement message', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    checkHealth.mockResolvedValue({ connected: false });
    const { loadFileBackend, loadDbBackend } = loaders();
    const { selectBackend } = createRecordStoreBackendSelector({ label: 'Demo', loadFileBackend, loadDbBackend });
    await expect(selectBackend()).rejects.toThrow(/^Demo requires PostgreSQL/);
  });

  it('retries selection after a failed Postgres bring-up instead of caching the failure', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    checkHealth.mockResolvedValueOnce({ connected: false }).mockResolvedValueOnce({ connected: true });
    const { loadFileBackend, loadDbBackend } = loaders();
    const { selectBackend, getBackendName } = createRecordStoreBackendSelector({ label: 'Demo', loadFileBackend, loadDbBackend });
    await expect(selectBackend()).rejects.toThrow(/requires PostgreSQL/);
    expect(await (await selectBackend()).listRecords()).toEqual(['db']);
    expect(getBackendName()).toBe('postgres');
  });

  it('reset() drops the memoized selection and the reported name', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.MEMORY_BACKEND;
    const { loadFileBackend, loadDbBackend } = loaders();
    const { selectBackend, getBackendName, reset } = createRecordStoreBackendSelector({ label: 'Demo', loadFileBackend, loadDbBackend });
    await selectBackend();
    expect(getBackendName()).toBe('file');
    reset();
    expect(getBackendName()).toBe(null);
    await selectBackend();
    expect(loadFileBackend).toHaveBeenCalledTimes(2);
  });

  it('fails fast when the loaders are missing', () => {
    expect(() => createRecordStoreBackendSelector({ label: 'Demo' })).toThrow(/loadFileBackend/);
  });
});
