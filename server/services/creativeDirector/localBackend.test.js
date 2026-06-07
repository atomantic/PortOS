/**
 * Backend-selection tests for the Creative Director dispatcher (local.js).
 *
 * Mirrors memoryBackend's contract: file backend under MEMORY_BACKEND=file or
 * NODE_ENV=test; Postgres otherwise (gated on a healthy DB). We assert the
 * SELECTION, not the storage round-trip — the file/PG round-trips are covered
 * by local.test.js (file) and projectsDB.test.js (PG, skip-if-no-DB).
 *
 * vi.resetModules() + dynamic re-import isolates the module-level backend cache
 * between cases (same approach as memoryBackend.test.js).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fileBackend = { __name: 'file', listProjects: vi.fn(async () => ['file']) };
const dbBackend = { __name: 'db', listProjects: vi.fn(async () => ['db']) };
const checkHealth = vi.fn();
const ensureSchema = vi.fn(async () => {});
const migrateCreativeDirectorToDB = vi.fn(async () => ({ ok: true }));

vi.mock('./projectsFile.js', () => fileBackend);
vi.mock('./projectsDB.js', () => dbBackend);
vi.mock('../../lib/db.js', () => ({ checkHealth: (...a) => checkHealth(...a), ensureSchema: (...a) => ensureSchema(...a) }));
vi.mock('../../scripts/migrateCreativeDirectorToDB.js', () => ({ migrateCreativeDirectorToDB: (...a) => migrateCreativeDirectorToDB(...a) }));

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  checkHealth.mockReset();
  ensureSchema.mockClear();
  migrateCreativeDirectorToDB.mockClear();
  process.env = { ...ORIG_ENV };
});

afterEach(() => { process.env = { ...ORIG_ENV }; });

describe('local.js backend selection', () => {
  it('uses the file backend under NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.MEMORY_BACKEND;
    const local = await import('./local.js');
    expect(await local.listProjects()).toEqual(['file']);
    expect(local.getProjectsBackendName()).toBe('file');
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('uses the file backend under MEMORY_BACKEND=file even when not in test mode', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MEMORY_BACKEND = 'file';
    const local = await import('./local.js');
    expect(await local.listProjects()).toEqual(['file']);
    expect(local.getProjectsBackendName()).toBe('file');
  });

  it('uses Postgres (ensureSchema + import) when DB is healthy and not in test/file mode', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const local = await import('./local.js');
    expect(await local.listProjects()).toEqual(['db']);
    expect(local.getProjectsBackendName()).toBe('postgres');
    expect(ensureSchema).toHaveBeenCalledOnce();
    expect(migrateCreativeDirectorToDB).toHaveBeenCalledOnce();
  });

  it('throws when Postgres is required but unreachable', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    checkHealth.mockResolvedValue({ connected: false, error: 'ECONNREFUSED' });
    const local = await import('./local.js');
    await expect(local.listProjects()).rejects.toThrow(/requires PostgreSQL/);
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it('caches the backend after first selection (one health check)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMORY_BACKEND;
    checkHealth.mockResolvedValue({ connected: true, hasSchema: true });
    const local = await import('./local.js');
    await local.listProjects();
    await local.getProject('cd-1').catch(() => {});
    expect(checkHealth).toHaveBeenCalledOnce();
    expect(ensureSchema).toHaveBeenCalledOnce();
  });
});
