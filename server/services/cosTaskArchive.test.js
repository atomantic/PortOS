/**
 * File backend of the completed-task archive (the dev/test escape hatch). The
 * PostgreSQL backend is covered by cosTaskArchive.db.test.js against the same
 * contract: newest-id-first paging, a strict `before` cursor, upsert by
 * (source, id), and light summaries without prompt bodies.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup, tempRoot } = mockPathsDataRoot({ prefix: 'cos-task-archive-test-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));

const {
  archiveTasks, countArchivedTasks, deleteArchivedTask, getArchivedIds, getArchivedTask,
  listArchivedSummaries, listArchivedTasks, __resetCosTaskArchive,
} = await import('./cosTaskArchive.js');

const task = (id, extra = {}) => ({ id, description: `Example ${id}`, status: 'completed', priority: 'MEDIUM', metadata: { prompt: `Prompt for ${id}` }, ...extra });

beforeEach(() => {
  rmSync(`${tempRoot}/cos-task-archive.json`, { force: true });
  __resetCosTaskArchive();
});
afterAll(cleanup);

describe('cosTaskArchive (file backend)', () => {
  it('round-trips a full record per source and upserts by id', async () => {
    await archiveTasks('user', [task('task-a')]);
    await archiveTasks('internal', [task('sys-a')]);
    await archiveTasks('user', [task('task-a', { description: 'Edited' })]);
    expect(await getArchivedTask('task-a')).toEqual({ source: 'user', task: expect.objectContaining({ description: 'Edited', metadata: { prompt: 'Prompt for task-a' } }) });
    expect(await getArchivedTask('sys-a', 'internal')).toMatchObject({ source: 'internal' });
    expect(await getArchivedTask('sys-a', 'user')).toBeNull();
    expect(await countArchivedTasks('user')).toBe(1);
  });

  it('pages newest id first with a strict before cursor, in code-unit order', async () => {
    await archiveTasks('user', ['task-b', 'task-a', 'task-C', 'task-d'].map((id) => task(id)));
    expect((await listArchivedTasks('user', { limit: 10 })).map((t) => t.id)).toEqual(['task-d', 'task-b', 'task-a', 'task-C']);
    expect((await listArchivedTasks('user', { before: 'task-b', limit: 2 })).map((t) => t.id)).toEqual(['task-a', 'task-C']);
    expect(await listArchivedTasks('user', { before: 'task-C', limit: 5 })).toEqual([]);
    expect((await listArchivedTasks('user', { offset: 1, limit: 2 })).map((t) => t.id)).toEqual(['task-b', 'task-a']);
  });

  it('reports which ids are archived, summaries without prompt bodies, and deletes by source', async () => {
    await archiveTasks('user', [task('task-a'), task('task-b')]);
    await archiveTasks('internal', [task('sys-a')]);
    expect(await getArchivedIds('user', ['task-a', 'task-z', 'sys-a'])).toEqual(new Set(['task-a']));
    expect(await getArchivedIds('user', [])).toEqual(new Set());
    const summaries = await listArchivedSummaries();
    expect(summaries).toHaveLength(3);
    expect(summaries).toContainEqual({ source: 'internal', id: 'sys-a', description: 'Example sys-a' });
    expect(JSON.stringify(summaries)).not.toContain('Prompt for');
    expect(await deleteArchivedTask('sys-a', 'user')).toBe(false);
    expect(await deleteArchivedTask('sys-a')).toBe(true);
    expect(await countArchivedTasks('internal')).toBe(0);
  });

  it('looks an id up user-first when both queues archived the same id', async () => {
    await archiveTasks('internal', [task('task-shared', { description: 'Internal copy' })]);
    await archiveTasks('user', [task('task-shared', { description: 'User copy' })]);
    expect(await getArchivedTask('task-shared')).toMatchObject({ source: 'user', task: { description: 'User copy' } });
    expect(await getArchivedTask('task-shared', 'internal')).toMatchObject({ source: 'internal' });
  });

  it('ignores an unknown source and an empty batch', async () => {
    await archiveTasks('elsewhere', [task('task-a')]);
    await archiveTasks('user', []);
    expect(await countArchivedTasks('user')).toBe(0);
  });
});
