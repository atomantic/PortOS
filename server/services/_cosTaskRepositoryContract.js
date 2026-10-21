/**
 * The behavior every cos_tasks backend must have, run by the in-memory suite
 * (cosTaskRepository.test.js) and the PostgreSQL suite (cosTaskRepository.db.test.js)
 * so the two cannot drift. Not a test file itself: it only registers cases.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKING_SET_KEEP_COMPLETED, planListSave } from '../lib/cosTaskRows.js';

const DAY = 86_400_000;
const NOW = Date.now();
const id = (n) => `task-example-${String(n).padStart(4, '0')}`;
const task = (n, extra = {}) => ({
  id: id(n), status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: `Example task ${n}`,
  approvalRequired: false, autoApproved: true, metadata: {}, ...extra,
});
const done = (n, ageDays, extra = {}) => task(n, { status: 'completed', metadata: { updatedAt: new Date(NOW - ageDays * DAY).toISOString(), prompt: `Prompt ${n}` }, ...extra });

/** @param {{ name: string, makeBackend: () => Promise<object>|object }} options */
export function __runCosTaskRepositoryContract({ name, makeBackend }) {
  describe(`cos_tasks contract (${name})`, () => {
    let backend;
    // Saves a whole list the way the store does: plan against what is loaded, then apply.
    const save = async (source, next) => {
      const { rows } = await backend.loadWorkingSet(source);
      const plan = planListSave({ previous: rows, next, source });
      await backend.apply(source, { upserts: plan.upserts, deletes: plan.deletes });
      return plan;
    };
    const ids = async (source) => (await backend.loadWorkingSet(source)).rows.map((row) => row.task.id);

    beforeEach(async () => { backend = await makeBackend(); });

    it('starts empty at version 0', async () => {
      expect(await backend.loadWorkingSet('user')).toEqual({ version: 0, rows: [] });
      expect(await backend.readVersion('internal')).toBe(0);
    });

    it('stores a list in queue order and bumps the version per write, independently per queue', async () => {
      await save('user', [task(1, { priorityValue: 1, priority: 'LOW' }), task(2, { priorityValue: 3, priority: 'HIGH' }), task(3, { status: 'blocked' }), task(4)]);
      expect(await ids('user')).toEqual([id(2), id(4), id(1), id(3)]);
      expect(await backend.readVersion('user')).toBe(1);
      expect(await backend.readVersion('internal')).toBe(0);
      await save('user', [task(1)]);
      expect(await backend.readVersion('user')).toBe(2);
    });

    it('breaks priority ties by saved position and keeps a reorder', async () => {
      await save('user', [task(1), task(2), task(3)]);
      expect(await ids('user')).toEqual([id(1), id(2), id(3)]);
      const { rows } = await backend.loadWorkingSet('user');
      await save('user', [rows[2].task, rows[0].task, rows[1].task]);
      expect(await ids('user')).toEqual([id(3), id(1), id(2)]);
    });

    it('upserts a changed task in place and deletes ids that left the list', async () => {
      await save('user', [task(1), task(2)]);
      const plan = await save('user', [task(1, { description: 'Edited' })]);
      expect(plan.upserts).toHaveLength(1);
      expect(plan.deletes).toEqual([id(2)]);
      const { rows } = await backend.loadWorkingSet('user');
      expect(rows.map((row) => row.task.description)).toEqual(['Edited']);
    });

    it('returns copies, never references into the backend', async () => {
      await save('user', [task(1, { metadata: { note: 'kept' } })]);
      const first = await backend.loadWorkingSet('user');
      first.rows[0].task.metadata.note = 'mutated';
      expect((await backend.loadWorkingSet('user')).rows[0].task.metadata.note).toBe('kept');
      (await backend.getTask(id(1), 'user')).task.metadata.note = 'mutated';
      expect((await backend.getTask(id(1), 'user')).task.metadata.note).toBe('kept');
    });

    it('keeps old completed tasks out of the working set but reachable by id, page and count', async () => {
      const recent = done(1000, 1);
      const old = Array.from({ length: WORKING_SET_KEEP_COMPLETED + 2 }, (_, n) => done(n + 1, 20 + n / 100));
      await save('user', [task(2000), recent, ...old]);
      // Every row is stored; the working set returns only the recent and the newest completed ones.
      const listed = await ids('user');
      expect(listed).toContain(id(1000));
      const oldest = id(WORKING_SET_KEEP_COMPLETED + 2);
      expect(listed).not.toContain(oldest);
      expect((await backend.getTask(oldest, 'user')).task.status).toBe('completed');
      expect(await backend.countCompleted('user')).toBe(old.length + 1);
    });

    it('pages completed history newest id first with a strict cursor and an offset', async () => {
      await save('user', [done(1, 1), done(2, 1), done(3, 1), done(4, 1), task(5)]);
      const page = async (opts) => (await backend.pageCompleted('user', { before: null, offset: 0, limit: 10, ...opts })).map((t) => t.id);
      expect(await page({})).toEqual([id(4), id(3), id(2), id(1)]);
      expect(await page({ before: id(3), limit: 1 })).toEqual([id(2)]);
      expect(await page({ offset: 1, limit: 2 })).toEqual([id(3), id(2)]);
    });

    it('reports which ids are stored as completed, only those', async () => {
      await save('user', [done(1, 1), task(2)]);
      expect(await backend.completedIds('user', [id(1), id(2), id(3)])).toEqual(new Set([id(1)]));
      expect(await backend.completedIds('user', [])).toEqual(new Set());
      expect(await backend.completedIds('internal', [id(1)])).toEqual(new Set());
    });

    it('looks an id up user-first, or in the named queue', async () => {
      await save('internal', [task(1, { description: 'Internal copy' })]);
      await save('user', [task(1, { description: 'User copy' })]);
      expect((await backend.getTask(id(1), null)).task.description).toBe('User copy');
      expect((await backend.getTask(id(1), 'internal')).source).toBe('internal');
      expect(await backend.getTask(id(9), null)).toBeNull();
    });

    it('lists completed summaries without prompt bodies', async () => {
      await save('user', [done(1, 1), task(2)]);
      await save('internal', [done(3, 1)]);
      const summaries = await backend.completedSummaries();
      expect(summaries).toHaveLength(2);
      expect(summaries).toContainEqual({ source: 'user', id: id(1), description: 'Example task 1' });
      expect(JSON.stringify(summaries)).not.toContain('Prompt');
    });

    it('deletes by id from the named or either queue and bumps only the affected version', async () => {
      await save('user', [task(1)]);
      await save('internal', [task(1)]);
      const before = await backend.readVersion('internal');
      expect(await backend.deleteById(id(1), 'user')).toBe(1);
      expect(await backend.readVersion('internal')).toBe(before);
      expect(await backend.deleteById(id(1), 'user')).toBe(0);
      expect(await backend.deleteById(id(1), null)).toBe(1);
      expect(await ids('internal')).toEqual([]);
    });
  });
}
