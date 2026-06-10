import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// memoryBackend caches the selected backend in module scope, so each scenario
// re-imports the module fresh via vi.resetModules() + dynamic import. The four
// dependencies are mocked at the top; the db health result is driven per-test
// through the mocked checkHealth().

const checkHealth = vi.fn();
const ensureSchema = vi.fn();

vi.mock('../lib/db.js', () => ({
  checkHealth: (...args) => checkHealth(...args),
  ensureSchema: (...args) => ensureSchema(...args),
}));

// Sentinel modules so we can assert which backend was selected without
// pulling in the real (DB/file) implementations.
vi.mock('./memory.js', () => ({ __backend: 'file', invalidateCaches: vi.fn() }));
vi.mock('./memoryDB.js', () => ({ __backend: 'postgres', invalidateCaches: vi.fn() }));
vi.mock('./memoryConfig.js', () => ({ DEFAULT_MEMORY_CONFIG: {} }));

const ORIGINAL_ENV = { ...process.env };

async function loadFresh() {
  vi.resetModules();
  return import('./memoryBackend.js');
}

describe('memoryBackend backend selection', () => {
  beforeEach(() => {
    checkHealth.mockReset();
    ensureSchema.mockReset();
    ensureSchema.mockResolvedValue(undefined);
    // Start each test from a clean env; individual tests opt in to flags.
    delete process.env.MEMORY_BACKEND;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('selects PostgreSQL when MEMORY_BACKEND=postgres', async () => {
    process.env.MEMORY_BACKEND = 'postgres';
    const mod = await loadFresh();
    const name = await mod.ensureBackend();
    expect(name).toBe('postgres');
    expect(ensureSchema).toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('honors the explicit MEMORY_BACKEND=file escape hatch even when Postgres is healthy', async () => {
    process.env.MEMORY_BACKEND = 'file';
    // Postgres is fully available — the explicit escape hatch must still win.
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const mod = await loadFresh();
    const name = await mod.ensureBackend();
    expect(name).toBe('file');
    // Escape hatch short-circuits before any health probe.
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('auto-detects PostgreSQL when unset and the DB is healthy', async () => {
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const mod = await loadFresh();
    const name = await mod.ensureBackend();
    expect(name).toBe('postgres');
    expect(ensureSchema).toHaveBeenCalled();
  });

  it('does NOT silently fall back to file when unset and Postgres is unavailable (non-test mode)', async () => {
    process.env.NODE_ENV = 'production';
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false, error: 'ECONNREFUSED' });
    const mod = await loadFresh();
    await expect(mod.ensureBackend()).rejects.toThrow(/PostgreSQL is required/);
    expect(mod.getBackendName()).toBeNull();
  });

  it('throws when unset and Postgres is connected but schema is missing (non-test mode)', async () => {
    process.env.NODE_ENV = 'production';
    checkHealth.mockResolvedValue({ connected: true, hasSchema: false });
    const mod = await loadFresh();
    await expect(mod.ensureBackend()).rejects.toThrow(/PostgreSQL is required/);
  });

  it('allows the file fallback in test mode when unset and Postgres is unavailable', async () => {
    process.env.NODE_ENV = 'test';
    checkHealth.mockResolvedValue({ connected: false, hasSchema: false, error: 'no db' });
    const mod = await loadFresh();
    const name = await mod.ensureBackend();
    expect(name).toBe('file');
  });

  it('uses the file backend in test mode even when Postgres is HEALTHY — never probes a live dev DB', async () => {
    // Regression guard: a developer's machine commonly has a live `portos` DB
    // running (federated to real peers). The test runner must never write to
    // it — fixture creation would pollute the DB and fan out to peers, and
    // cleanup tombstones would delete real records. Test mode must short-circuit
    // to the file backend BEFORE the health probe runs.
    process.env.NODE_ENV = 'test';
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const mod = await loadFresh();
    const name = await mod.ensureBackend();
    expect(name).toBe('file');
    expect(checkHealth).not.toHaveBeenCalled();
  });
});
