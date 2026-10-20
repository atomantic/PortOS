/**
 * Postgres round-trip for the completed-task archive. The file backend's
 * contract is pinned without a database in cosTaskArchive.test.js; what needs a
 * real Postgres is the part only Postgres enforces: the (source, task_id) key,
 * the source CHECK, the JSONB round-trip, and `COLLATE "C"` ordering matching
 * JavaScript's code-unit comparison.
 *
 * Runs via `npm run test:db` (→ `portos_test`) ONLY. Skips cleanly when no
 * database is reachable.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { __makePgCosTaskArchiveBackend } from './cosTaskArchive.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('services/cosTaskArchive.db.test', health.connected, 'disposable PostgreSQL unavailable');
const backend = __makePgCosTaskArchiveBackend({ query });
const task = (id, extra = {}) => ({ id, description: `Example ${id}`, status: 'completed', metadata: { updatedAt: '2026-10-01T00:00:00.000Z', prompt: `Prompt ${id}` }, ...extra });

beforeEach(async () => { if (runDb) await query('DELETE FROM cos_task_archive'); });
afterAll(async () => { if (runDb) await query('DELETE FROM cos_task_archive'); if (health.connected) await close(); });

describe.skipIf(!runDb)('cos_task_archive (postgres backend)', () => {
  it('round-trips a full record, upserts by (source, id) and keeps sources apart', async () => {
    await backend.archive('user', [task('task-a')]);
    await backend.archive('internal', [task('task-a', { description: 'Internal twin' })]);
    await backend.archive('user', [task('task-a', { description: 'Edited' })]);
    expect(await backend.get('task-a', 'user')).toEqual({ source: 'user', task: expect.objectContaining({ description: 'Edited', metadata: expect.objectContaining({ prompt: 'Prompt task-a' }) }) });
    expect((await backend.get('task-a', 'internal')).task.description).toBe('Internal twin');
    expect(await backend.count('user')).toBe(1);
    const { rows } = await query("SELECT completed_at FROM cos_task_archive WHERE source = 'user' AND task_id = 'task-a'");
    expect(rows[0].completed_at.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('pages newest id first in code-unit order with a strict before cursor', async () => {
    await backend.archive('user', ['task-b', 'task-a', 'task-C', 'task-d'].map((id) => task(id)));
    expect((await backend.list('user', { offset: 0, limit: 10 })).map((t) => t.id)).toEqual(['task-d', 'task-b', 'task-a', 'task-C']);
    expect((await backend.list('user', { before: 'task-b', offset: 0, limit: 2 })).map((t) => t.id)).toEqual(['task-a', 'task-C']);
    expect((await backend.list('user', { offset: 1, limit: 2 })).map((t) => t.id)).toEqual(['task-b', 'task-a']);
  });

  it('reports archived ids, projects summaries without bodies, and deletes by source', async () => {
    await backend.archive('user', [task('task-a'), task('task-b')]);
    expect(await backend.existingIds('user', ['task-a', 'task-z'])).toEqual(new Set(['task-a']));
    expect(await backend.existingIds('user', [])).toEqual(new Set());
    expect(await backend.summaries()).toContainEqual({ source: 'user', id: 'task-a', description: 'Example task-a' });
    expect(await backend.remove('task-a', 'internal')).toBe(false);
    expect(await backend.remove('task-a', 'user')).toBe(true);
  });

  it('looks an id up user-first when both queues archived the same id', async () => {
    await backend.archive('internal', [task('task-shared', { description: 'Internal copy' })]);
    await backend.archive('user', [task('task-shared', { description: 'User copy' })]);
    expect(await backend.get('task-shared', null)).toMatchObject({ source: 'user', task: { description: 'User copy' } });
  });

  it('refuses an unknown source', async () => {
    await expect(backend.archive('elsewhere', [task('task-a')])).rejects.toThrow();
  });
});
