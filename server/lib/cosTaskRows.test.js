import { describe, expect, it } from 'vitest';
import {
  POSITION_STEP, WORKING_SET_COMPLETED_WINDOW_MS, WORKING_SET_KEEP_COMPLETED,
  assignPositions, completionStamp, planListSave, rowColumns, selectWorkingSet, storedForm,
} from './cosTaskRows.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const DAY = 86_400_000;
const task = (id, extra = {}) => ({ id, status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: `Example ${id}`, approvalRequired: false, autoApproved: true, metadata: {}, ...extra });
const done = (id, ageDays, extra = {}) => task(id, { status: 'completed', metadata: { updatedAt: new Date(NOW - ageDays * DAY).toISOString() }, ...extra });

describe('storedForm', () => {
  it('normalizes exactly as the old Markdown round-trip did', () => {
    const stored = storedForm(task('task-a', { description: 'Line one\nLine two', metadata: { openPR: true, count: 3, gone: null, note: undefined } }), 'user');
    // Scalars read back as strings, nullish metadata is dropped, the description is one line.
    expect(stored.metadata).toEqual({ openPR: 'true', count: '3' });
    expect(stored.description).not.toContain('\n');
    expect(stored.id).toBe('task-a');
  });

  it('reads an unregistered id prefix back as task-<id>, as the Markdown reader always did', () => {
    expect(storedForm(task('a'), 'user').id).toBe('task-a');
  });

  it('keeps the approval flags only for the internal queue', () => {
    const internal = storedForm(task('sys-a', { approvalRequired: true, autoApproved: false }), 'internal');
    expect(internal).toMatchObject({ approvalRequired: true, autoApproved: false });
  });
});

describe('rowColumns', () => {
  it('projects status, priority, description and a completed_at only for completed tasks', () => {
    expect(rowColumns(done('task-a', 2))).toEqual({ status: 'completed', priorityValue: 2, completedAt: new Date(NOW - 2 * DAY).toISOString(), description: 'Example task-a' });
    expect(rowColumns(task('task-b', { metadata: { updatedAt: '2026-10-01T00:00:00Z' } })).completedAt).toBeNull();
    expect(rowColumns(done('task-c', 0, { metadata: {} })).completedAt).toBeNull();
  });

  it('prefers completedAt over updatedAt', () => {
    expect(completionStamp({ metadata: { completedAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z' } })).toBe(Date.parse('2026-10-02T00:00:00Z'));
    expect(completionStamp({ metadata: {} })).toBe(0);
  });
});

describe('queue order', () => {
  it('sorts by status section, then priority high to low, then position, then id', () => {
    const rows = [
      { task: task('c', { status: 'blocked' }), position: 0 },
      { task: task('b', { priorityValue: 1 }), position: 0 },
      { task: task('a', { priorityValue: 3 }), position: 5 },
      { task: task('d', { priorityValue: 3 }), position: 1 },
      { task: task('e', { status: 'in_progress' }), position: 0 },
    ];
    expect(selectWorkingSet(rows).map((row) => row.task.id)).toEqual(['d', 'a', 'b', 'e', 'c']);
  });
});

describe('selectWorkingSet', () => {
  it('keeps every open task, completed tasks inside the window, and the newest completed beyond it', () => {
    const rows = [
      { task: task('open'), position: 0 },
      { task: done('recent', 1), position: 0 },
      ...Array.from({ length: WORKING_SET_KEEP_COMPLETED + 2 }, (_, n) => ({ task: done(`old-${String(n).padStart(3, '0')}`, 10 + n / 100), position: 0 })),
    ];
    const ids = selectWorkingSet(rows, { now: NOW }).map((row) => row.task.id);
    expect(ids).toContain('open');
    expect(ids).toContain('recent');
    // The newest 100 completed stay (recent is one of them); the 2 oldest drop out.
    expect(ids.filter((id) => id.startsWith('old-'))).toHaveLength(WORKING_SET_KEEP_COMPLETED - 1);
    expect(ids).not.toContain('old-101');
  });

  it('treats undated completed tasks as oldest', () => {
    const rows = [{ task: done('dated', 20), position: 0 }, ...Array.from({ length: WORKING_SET_KEEP_COMPLETED }, (_, n) => ({ task: done(`new-${n}`, 5), position: 0 })), { task: done('undated', 0, { metadata: {} }), position: 0 }];
    const ids = selectWorkingSet(rows, { now: NOW }).map((row) => row.task.id);
    expect(ids).not.toContain('undated');
    expect(ids).not.toContain('dated');
  });

  it('is inclusive at the window edge', () => {
    const edge = { task: done('edge', WORKING_SET_COMPLETED_WINDOW_MS / DAY), position: 0 };
    const filler = Array.from({ length: WORKING_SET_KEEP_COMPLETED }, (_, n) => ({ task: done(`new-${n}`, 0.5), position: 0 }));
    expect(selectWorkingSet([edge, ...filler], { now: NOW }).map((row) => row.task.id)).toContain('edge');
  });
});

describe('assignPositions', () => {
  const positions = (entries) => new Map(entries);

  it('numbers an empty list from zero', () => {
    expect([...assignPositions(new Map(), ['a', 'b', 'c'])]).toEqual([['a', 0], ['b', POSITION_STEP], ['c', 2 * POSITION_STEP]]);
  });

  it('writes nothing when order is unchanged, and only the new id when one is appended, prepended or inserted', () => {
    const previous = positions([['a', 0], ['b', 1024], ['c', 2048]]);
    expect(assignPositions(previous, ['a', 'b', 'c']).size).toBe(0);
    expect([...assignPositions(previous, ['a', 'b', 'c', 'n'])]).toEqual([['n', 3072]]);
    expect([...assignPositions(previous, ['n', 'a', 'b', 'c'])]).toEqual([['n', -1024]]);
    expect([...assignPositions(previous, ['a', 'n', 'b', 'c'])]).toEqual([['n', 512]]);
  });

  it('spaces several inserts evenly between their neighbours', () => {
    const out = assignPositions(positions([['a', 0], ['b', 900]]), ['a', 'x', 'y', 'z', 'b']);
    expect([...out.keys()]).toEqual(['x', 'y', 'z']);
    expect([...out.values()]).toEqual([225, 450, 675]);
  });

  it('moves only the displaced id on a reorder, wherever it goes', () => {
    const previous = positions([['a', 0], ['b', 1024], ['c', 2048], ['d', 3072]]);
    const toEnd = assignPositions(previous, ['b', 'c', 'd', 'a']);
    expect([...toEnd.keys()]).toEqual(['a']);
    expect(toEnd.get('a')).toBeGreaterThan(3072);
    const toFront = assignPositions(previous, ['d', 'a', 'b', 'c']);
    expect([...toFront.keys()]).toEqual(['d']);
    expect(toFront.get('d')).toBeLessThan(0);
    const swapped = assignPositions(previous, ['a', 'c', 'b', 'd']);
    expect(swapped.size).toBe(1);
  });

  it('renumbers the whole list when the gap between neighbours has collapsed', () => {
    const out = assignPositions(positions([['a', 0], ['b', 1e-9]]), ['a', 'n', 'b']);
    expect([...out]).toEqual([['a', 0], ['n', 1024], ['b', 2048]]);
  });
});

describe('planListSave', () => {
  const load = (tasks) => tasks.map((t, i) => ({ task: storedForm(t, 'user'), position: i * POSITION_STEP }));

  it('plans nothing for an unchanged list, even when the caller holds clones', () => {
    const previous = load([task('task-a'), task('task-b', { metadata: { openPR: true } })]);
    const plan = planListSave({ previous, next: structuredClone(previous.map((row) => row.task)), source: 'user' });
    expect(plan.upserts).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.saved).toEqual(previous.map((row) => row.task));
  });

  it('ignores a difference the stored form erases (undefined or null metadata)', () => {
    const previous = load([task('task-a')]);
    const next = [{ ...previous[0].task, metadata: { ...previous[0].task.metadata, gone: undefined, nothing: null } }];
    expect(planListSave({ previous, next, source: 'user' }).upserts).toEqual([]);
  });

  it('upserts only changed and new tasks in stored form, and deletes ids that left the list', () => {
    const previous = load([task('task-a'), task('task-b'), task('task-c')]);
    const next = [previous[0].task, { ...previous[1].task, status: 'completed', metadata: { openPR: true } }, task('task-d')];
    const plan = planListSave({ previous, next, source: 'user' });
    expect(plan.upserts.map((row) => row.task.id)).toEqual(['task-b', 'task-d']);
    expect(plan.upserts[0].task.metadata).toEqual({ openPR: 'true' });
    expect(plan.upserts[0].position).toBe(1024);
    expect(plan.deletes).toEqual(['task-c']);
    expect(plan.saved.map((t) => t.id)).toEqual(['task-a', 'task-b', 'task-d']);
  });

  it('writes only the moved task when a list is reordered', () => {
    const previous = load([task('task-a'), task('task-b'), task('task-c')]);
    const plan = planListSave({ previous, next: [previous[2].task, previous[0].task, previous[1].task], source: 'user' });
    expect(plan.upserts.map((row) => row.task.id)).toEqual(['task-c']);
    expect(plan.deletes).toEqual([]);
  });

  it('keys the row by the id the stored form reads back, and stays stable across saves', () => {
    const first = planListSave({ previous: [], next: [task('a')], source: 'user' });
    expect(first.upserts.map((row) => row.task.id)).toEqual(['task-a']);
    const previous = first.upserts.map((row) => ({ task: row.task, position: row.position }));
    // The cached list now holds the stored id, so the next save changes nothing and deletes nothing.
    const again = planListSave({ previous, next: previous.map((row) => row.task), source: 'user' });
    expect(again.upserts).toEqual([]);
    expect(again.deletes).toEqual([]);
  });

  it('collapses a duplicate id to its last occurrence', () => {
    const plan = planListSave({ previous: [], next: [task('task-a'), task('task-b'), task('task-a', { description: 'Later copy' })], source: 'user' });
    expect(plan.saved.map((t) => t.id)).toEqual(['task-a', 'task-b']);
    expect(plan.saved[0].description).toBe('Later copy');
  });
});
