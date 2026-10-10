/**
 * Review Hub write serialization (#10911).
 *
 * Runs the real review.js against a real temp data root (no fs mocks): the
 * lost-update race only exists when two load -> mutate -> save turns actually
 * overlap on the filesystem, which a mocked store cannot reproduce.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-review-concurrency-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const { createItem, getItems, dismissItem, reopenItem, bulkUpdateStatus, updateItem, deleteItem, reviewEvents } =
  await import('./review.js');

const reviewDir = join(tempRoot, 'review');
const archiveFile = join(reviewDir, 'archive.json');

const archivedTodo = {
  id: 'archived-1',
  type: 'todo',
  title: 'Archived example',
  description: '',
  status: 'dismissed',
  metadata: {},
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-02T00:00:00.000Z',
};

const todo = (title) => ({ type: 'todo', title });

describe('review service write serialization', () => {
  beforeEach(async () => {
    await rm(reviewDir, { recursive: true, force: true });
  });

  afterEach(() => {
    reviewEvents.removeAllListeners('item:created');
  });

  afterAll(cleanup);

  it('persists every item from overlapping createItem calls and emits one event each', async () => {
    const created = [];
    reviewEvents.on('item:created', (item) => created.push(item.id));

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createItem(todo(`Item ${i}`))),
    );

    const stored = await getItems();
    expect(stored).toHaveLength(8);
    expect(new Set(stored.map((i) => i.id))).toEqual(new Set(results.map((i) => i.id)));
    expect(created).toHaveLength(8);
  });

  it('keeps both a new item and a dismissal of another item', async () => {
    const existing = await createItem(todo('Existing'));

    const [fresh] = await Promise.all([createItem(todo('Fresh')), dismissItem(existing.id)]);

    const stored = await getItems();
    expect(stored.find((i) => i.id === fresh.id)?.status).toBe('pending');
    expect(stored.find((i) => i.id === existing.id)?.status).toBe('dismissed');
  });

  it('keeps an item created while bulkUpdateStatus runs', async () => {
    const a = await createItem(todo('A'));
    const b = await createItem(todo('B'));

    const [fresh, updated] = await Promise.all([
      createItem(todo('Fresh')),
      bulkUpdateStatus({ ids: [a.id, b.id], status: 'dismissed' }),
    ]);

    expect(updated).toHaveLength(2);
    const stored = await getItems();
    expect(stored.find((i) => i.id === fresh.id)?.status).toBe('pending');
    expect(stored.filter((i) => i.status === 'dismissed')).toHaveLength(2);
  });

  it('loses neither a reopened archived item nor a concurrent create', async () => {
    await mkdir(reviewDir, { recursive: true });
    await writeFile(archiveFile, JSON.stringify([archivedTodo]));

    const [fresh, reopened] = await Promise.all([createItem(todo('Fresh')), reopenItem(archivedTodo.id)]);

    const stored = await getItems();
    expect(stored.find((i) => i.id === fresh.id)?.status).toBe('pending');
    expect(stored.find((i) => i.id === reopened.id)?.status).toBe('pending');
    // Gone from cold storage: the live copy is the only one.
    expect(stored.filter((i) => i.id === archivedTodo.id)).toHaveLength(1);
  });

  it('serializes edits and deletes against creates on the same file', async () => {
    const keep = await createItem(todo('Keep'));
    const drop = await createItem(todo('Drop'));

    const [fresh] = await Promise.all([
      createItem(todo('Fresh')),
      updateItem(keep.id, { title: 'Renamed' }),
      deleteItem(drop.id),
    ]);

    const stored = await getItems();
    expect(stored.map((i) => i.id).sort()).toEqual([keep.id, fresh.id].sort());
    expect(stored.find((i) => i.id === keep.id)?.title).toBe('Renamed');
  });

  it('does not deadlock when an event listener calls a mutator synchronously', async () => {
    let follow;
    reviewEvents.once('item:created', () => {
      follow = createItem(todo('Follow-up'));
    });

    const first = await createItem(todo('First'));
    await follow;

    const stored = await getItems();
    expect(stored.map((i) => i.title).sort()).toEqual(['First', 'Follow-up']);
    expect(stored.some((i) => i.id === first.id)).toBe(true);
  });
});
